import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProject } from './useProject'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { resolveProjectCurrency } from '../lib/currency'
import {
  BOQ_STATUS, normalizeRate, boqLineAmount, validateBoqItemDraft,
} from '../lib/boq'

// ── BOQ items (measured schedule; provenance for the Approved Budget) ────────
//
// A boqItem is a MEASURED, cost-coded, optionally-priced line: description,
// quantity, unit, and — once priced — a rate with a derived amount
// (quantity × rate; null while the rate is null). It is a preconstruction
// record, not a transaction: NO counter, NO sequential number, NO posted
// status (`itemNumber` is a user-authored label like "2.1", never a sequence —
// a BOQ item is never quoted to a supplier or client, so ADR-5 does not apply).
// Lifecycle: active → active (edit) or active → void (terminal, reasoned),
// both rules-enforced; delete is blocked.
//
// This hook writes ONLY boqItem documents (plus the project currency ratchet,
// inside the create transaction). It NEVER mutates budget lines, POs, claims,
// invoices, variations, forecast lines, cash-flow lines, or the commercial
// baseline — the BOQ feeds no financial figure, and the BOQ-vs-budget
// comparison is derived at read time in lib/boq.js (ADR-32).
export function useBoqItems(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD.
  const projectCurrency = resolveProjectCurrency(project, company)

  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the same derived-loading pattern as useCashFlowLines.
  const [snap, setSnap] = useState({ key: null, items: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'boqItems')
    const q   = query(ref, orderBy('createdAt', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        items: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page. Consumers must treat
      // a failed read as UNAVAILABLE, never as an empty BOQ.
      () => setSnap({ key, items: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const boqItems = settled ? snap.items : []
  const boqItemsLoading = targetKey !== null && !settled
  const boqItemsError = settled ? snap.error : false

  // Normalises the authored fields into the stored shape. An empty rate field
  // means UNPRICED and is stored as null — with amount null alongside it —
  // never as 0 (rules enforce the pairing, and 0 means "priced at nothing").
  const buildFields = (input) => {
    const quantity = Number(input.quantity)
    const rate = normalizeRate(input.rate)
    return {
      itemNumber:  (input.itemNumber || '').trim(),
      section:     (input.section || '').trim(),
      description: (input.description || '').trim(),
      unit:        (input.unit || '').trim(),
      quantity,
      rate,
      // Derived, never authored — rules enforce cents(quantity × rate) ==
      // cents(amount), and lib/boq.js rounds the same way the rules do.
      amount: boqLineAmount(quantity, rate),
      // The cost-code spine (frozen name snapshot) — mandatory on every item.
      costCodeId:   input.costCodeId,
      costCodeName: (input.costCodeName || '').trim(),
      notes: (input.notes || '').trim(),
    }
  }

  // Creates an ACTIVE item. There is no counter, so the transaction exists
  // purely to stage the project currency ratchet atomically (ADR-21): a priced
  // BOQ item is monetary data in the project currency, so the item and the
  // lock succeed or fail together. Already-locked projects stage a no-op,
  // which keeps the narrow `qs` rule (currencyLocked false→true only)
  // satisfied for QS users.
  const createBoqItem = useCallback(async (input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateBoqItemDraft(input)
    if (validationError) throw new Error(validationError)

    const itemRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'boqItems'))
    const fields = buildFields(input)

    await runTransaction(db, async (tx) => {
      // A PRICED item (including rate 0) is monetary data in the project
      // currency and engages the ratchet IN THIS TRANSACTION, so the item and
      // the lock succeed or fail together. An UNPRICED item (rate null) is a
      // measurement carrying no money and deliberately does NOT lock —
      // mirroring useForecastLines' null handling exactly (ADR-21/ADR-32).
      // Firestore requires all transaction reads before any writes, hence the
      // staged read here.
      const commitLock = fields.rate === null
        ? () => {}
        : await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(itemRef, {
        ...fields,
        status: BOQ_STATUS.ACTIVE,

        // Audit snapshot of the project currency at write time — never read
        // for display (the project currency is the display authority).
        currency: projectCurrency,
        revision: 1,

        // Reserved for future modules (Storage attachments, accounting sync).
        attachments:  [],
        externalRefs: {},

        // Lifecycle audit stamps. Rules require these null at create.
        voidReason: '',
        voidedAt:   null,
        voidedBy:   null,

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return itemRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Active-only edits — including PRICING an unpriced item (rate null → a
  // number) and un-pricing one (a number → null; the amount follows). The
  // currency, creation stamps, and revision are never written here — and
  // rules reject an update that changes any of them.
  //
  // A transaction rather than a bare updateDoc because PRICING an item puts
  // money on the project for the first time and must engage the currency
  // ratchet ATOMICALLY with the edit (ADR-21): otherwise a project could hold
  // a priced BOQ item while its currency stayed changeable, and changing it
  // then relabels that amount without converting it. Un-pricing stages a
  // no-op, as does an already-locked project — which keeps the narrow `qs`
  // rule (currencyLocked false→true only) satisfied for QS users.
  const updateBoqItem = useCallback(async (itemDoc, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (itemDoc.status !== BOQ_STATUS.ACTIVE) throw new Error('Only active BOQ items can be edited')

    const validationError = validateBoqItemDraft(input)
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'boqItems', itemDoc.id)
    const fields = buildFields(input)

    await runTransaction(db, async (tx) => {
      const commitLock = fields.rate === null
        ? () => {}
        : await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.update(ref, {
        ...fields,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
  }, [companyId, projectId, user])

  // Voiding is terminal and requires a non-whitespace reason — by this hook
  // AND by Firestore rules. Items are never deleted (ADR-12): a voided item is
  // retained BOQ history (and remains currency-lock evidence when priced), it
  // simply contributes nothing to any total or comparison.
  const voidBoqItem = useCallback(async (itemDoc, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (itemDoc.status !== BOQ_STATUS.ACTIVE) throw new Error('Only active BOQ items can be voided')
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this BOQ item')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'boqItems', itemDoc.id)
    await updateDoc(ref, {
      status:     BOQ_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reason,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  return {
    boqItems,
    boqItemsLoading,
    boqItemsError,
    createBoqItem,
    updateBoqItem,
    voidBoqItem,
  }
}
