import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { doc, onSnapshot, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useProfile } from './useProfile'
import { isCurrencyCodeShape, isKnownCountryCode, isKnownCurrencyCode } from '../lib/currency'

// Firestore batches cap at 500 writes. Real project counts sit far below this;
// chunking is defensive so a large company cannot silently lose writes.
const BACKFILL_CHUNK = 450

const CompanyContext = createContext(null)

export function CompanyProvider({ children }) {
  const { user }    = useAuth()
  const { profile } = useProfile()
  const [company, setCompany]             = useState(null)
  const [companyLoading, setCompanyLoading] = useState(true)

  useEffect(() => {
    const companyId = profile?.companyId
    if (!companyId) {
      setCompany(null)
      setCompanyLoading(false)
      return
    }

    setCompanyLoading(true)
    const ref = doc(db, 'companies', companyId)
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        setCompany(snap.exists() ? { id: snap.id, ...snap.data() } : null)
        setCompanyLoading(false)
      },
      () => {
        // Firestore read error — degrade gracefully
        setCompany(null)
        setCompanyLoading(false)
      }
    )
    return unsubscribe
  }, [profile?.companyId])

  const companyId = profile?.companyId ?? null

  // ── Company country & base currency ────────────────────────────────────────
  //
  // Writes the confirmed company configuration and, in the SAME admin-confirmed
  // action, pins an explicit currency onto the existing projects the admin
  // reviewed on the Company Settings page.
  //
  // Why the pinning matters: a project with no stored `currency` resolves
  // through the company. Without pinning, the moment an admin confirms a base
  // currency every historical project would silently RELABEL to it — the
  // amounts were entered in one currency and would render as another, with no
  // conversion. Pinning anchors them permanently.
  //
  // ORDER IS DELIBERATE: projects first, company second. If the project writes
  // fail, the company stays unconfigured, the setup banner stays up, and a
  // retry is safe. The reverse order would leave a configured company with
  // floating projects — precisely the state to avoid. (The two cannot be one
  // atomic transaction across an unbounded number of documents.)
  //
  // ADDITIVE AND IDEMPOTENT: the caller passes only the projects it means to
  // set, each write is a single-field `currency` update, no amount is touched,
  // no document is deleted, and re-running with the same input is a no-op.
  // `currencyLocked` is deliberately NOT set here — locking is a separate,
  // rules-ratcheted step (see useProjects.lockProjectCurrency), so one
  // confirmation never performs two irreversible operations at once.
  const saveCompanyCurrency = useCallback(async ({
    countryCode,
    baseCurrency,
    projectCurrencies = [],
  }) => {
    if (!companyId || !user) throw new Error('Not authenticated')

    if (!isKnownCountryCode(countryCode)) {
      throw new Error('Select a country from the list.')
    }
    if (!isKnownCurrencyCode(baseCurrency)) {
      throw new Error('Select a currency from the list.')
    }

    const updates = projectCurrencies
      .filter(p => p && p.projectId && isCurrencyCodeShape(p.currency))
      .map(p => ({ projectId: p.projectId, currency: p.currency }))

    if (updates.some(p => !isKnownCurrencyCode(p.currency))) {
      throw new Error('One of the project currencies is not a supported currency code.')
    }

    // 1) Projects — pinned first, in chunked batches.
    for (let i = 0; i < updates.length; i += BACKFILL_CHUNK) {
      const batch = writeBatch(db)
      for (const { projectId, currency } of updates.slice(i, i + BACKFILL_CHUNK)) {
        batch.update(doc(db, 'companies', companyId, 'projects', projectId), { currency })
      }
      await batch.commit()
    }

    // 2) Company — only the four currency fields; Firestore rules reject any
    //    other key on this document, so `name` and the rest stay immutable.
    await updateDoc(doc(db, 'companies', companyId), {
      countryCode,
      baseCurrency,
      currencyUpdatedAt: serverTimestamp(),
      currencyUpdatedBy: user.uid,
    })
  }, [companyId, user])

  return (
    <CompanyContext.Provider value={{ company, companyLoading, saveCompanyCurrency }}>
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  return useContext(CompanyContext)
}
