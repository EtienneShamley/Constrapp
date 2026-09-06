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
  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern; the single-document reference is
  // useProjectCommercial. The effect is subscription-only: state is written
  // ONLY from the async onSnapshot callbacks, never synchronously in the effect
  // body, so company/loading are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // The target is the profile's companyId. ⚠️ `companyLoading` deliberately
  // does NOT absorb `profileLoading`: while the profile is still resolving
  // there is no target, so this provider is IDLE (no company, not loading) —
  // exactly as before this migration. CompanySettings compensates by gating on
  // both flags; do not "fix" that here.
  //
  // A settled `company === null` means the company document does not exist (or
  // the read was rejected), which is distinct from still loading.
  //
  // `error` is tracked here for pattern uniformity but deliberately NOT
  // exposed: adding a `companyError` would change this provider's public
  // context value.
  const [snap, setSnap] = useState({ key: null, company: null, error: false })

  useEffect(() => {
    const companyId = profile?.companyId
    if (!companyId) return undefined

    const key = companyId
    const ref = doc(db, 'companies', companyId)
    const unsubscribe = onSnapshot(
      ref,
      (docSnap) => setSnap({
        key,
        company: docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null,
        error: false,
      }),
      // Firestore read error — degrade gracefully.
      () => setSnap({ key, company: null, error: true }),
    )
    return unsubscribe
  }, [profile?.companyId])

  const companyId = profile?.companyId ?? null

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no company, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides a previous company immediately on an account switch.
  const targetKey = companyId
  const settled = targetKey !== null && snap.key === targetKey
  const company = settled ? snap.company : null
  const companyLoading = targetKey !== null && !settled

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
