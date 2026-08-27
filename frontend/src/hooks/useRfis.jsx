import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useProfile } from './useProfile'
import { useCompany } from './useCompany'
import {
  RFI_STATUS, RFI_COUNTER_ID, LIMITS, formatRfiNumber,
  normaliseRfiDraft, validateRfiDraft, validateManagementDraft,
  validateRaise, validateAnswer, validateClose, validateCancel,
  canEditQuestion, canEditManagement,
} from '../lib/rfis'

// ── RFIs — Requests for Information (ADR-33) ─────────────────────────────────
//
// An RFI is an EVIDENCE record, not a financial document.
//
// ⚠️ THIS HOOK WRITES ONLY `rfis` DOCUMENTS AND THE PROJECT RFI COUNTER
// (projects/{projectId}/counters/rfis, inside the create transaction). It never
// touches Budget Lines, Forecast Lines, Cash Flow Lines, the Commercial
// Baseline, Progress Claims, Purchase Orders, Supplier/Client Invoices,
// Variations, or `projects/{projectId}.progress`. The optional `costCodeId` +
// frozen `costCodeName` are a JOIN KEY for future read-time analysis — never
// an authored commercial value.
//
// ⚠️ NO CURRENCY RATCHET. Every financial create wraps `stageProjectCurrencyLock`
// (ADR-21) because it writes monetary data. An RFI holds no amount and no
// currency, so engaging the ratchet here would lock a project's currency on a
// question, which would be wrong. The transaction below exists for the COUNTER
// only.
//
// ⚠️ PER-PROJECT NUMBERING. The counter lives under the project, so every
// project starts at RFI-0001. Normal app creates are transaction-safe (two
// concurrent creates serialise on the counter document); rules cannot enforce
// sibling uniqueness or +1 semantics — see docs/SECURITY.md → Deferred
// Control 27.
//
// ⚠️ LAST-WRITE-WINS on draft/management edits — no compare-and-set
// (Deferred Control 20 territory). `updatedAt`/`updatedBy` record WHO last
// wrote, not WHAT changed.
//
// The keyed-snapshot pattern below (state tagged with the target it belongs to,
// loading DERIVED from it) is the one used by useProjectActivities /
// useCashFlowLines — deliberately, because the older `setLoading(true)` inside
// an effect is what produces this repo's accepted lint errors.
export function useRfis(projectId) {
  const { user }    = useAuth()
  const { profile } = useProfile()
  const { company } = useCompany()

  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, rfis: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'rfis')
    // Ordered by a field EVERY document carries. Display order is decided by
    // sortRfis() in lib/rfis.js (number desc, deterministic tie-break).
    const q = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        rfis: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error — most often a rules rejection for a subcontractor/client
      // user. Degrade to "unavailable", never to a silent empty register.
      () => setSnap({ key, rfis: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const rfis = settled ? snap.rfis : []
  const rfisLoading = targetKey !== null && !settled
  const rfisError = settled ? snap.error : false

  const collectionRef = useCallback(
    () => collection(db, 'companies', companyId, 'projects', projectId, 'rfis'),
    [companyId, projectId],
  )

  // Creates a DRAFT with the next per-project number, in ONE transaction with
  // the counter increment. Random document id — stable, never reused.
  //
  // `raisedByName` is a snapshot of the creator's OWN profile name — the only
  // profile a client can read (ADR-27). It is client-authored and NOT
  // rules-verified against the profile (Deferred Control 27).
  const createRfi = useCallback(async (input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateRfiDraft(input)
    if (validationError) throw new Error(validationError)

    const raisedByName = String(profile?.name ?? '').trim().slice(0, LIMITS.raisedByName)
    if (!raisedByName) {
      throw new Error('Your profile has no name to record as the raiser — ask an administrator to set it')
    }

    const counterRef = doc(db, 'companies', companyId, 'projects', projectId, 'counters', RFI_COUNTER_ID)
    const rfiRef = doc(collectionRef())

    await runTransaction(db, async (tx) => {
      // Read phase first (Firestore requires all reads before any writes).
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(rfiRef, {
        rfiNumber: formatRfiNumber(next),
        status:    RFI_STATUS.DRAFT,

        ...normaliseRfiDraft(input),
        raisedByName,

        // Lifecycle stamps. Rules require these null/empty at create, so a
        // pre-raised, pre-answered or pre-cancelled RFI cannot be forged.
        raisedAt: null, raisedBy: null,
        answer: '', answerDate: null, answeredAt: null, answeredBy: null,
        closeOutNote: '', closedAt: null, closedBy: null,
        cancelReason: '', cancelledAt: null, cancelledBy: null,

        revision: 1,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
    })
    return rfiRef.id
  }, [companyId, projectId, user, profile, collectionRef])

  // DRAFT EDIT — the question block, the reference, the cost code, the
  // assignee and the due date. `raisedByName` is deliberately NOT rewritten
  // here: it is who created the record, and editing does not change that.
  const updateRfiDraft = useCallback(async (rfiDoc, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canEditQuestion(rfiDoc?.status)) throw new Error('Only a draft RFI can be edited')

    const validationError = validateRfiDraft(input)
    if (validationError) throw new Error(validationError)

    const ref = doc(collectionRef(), rfiDoc.id)
    await updateDoc(ref, {
      ...normaliseRfiDraft(input),
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  // OPEN MANAGEMENT EDIT — assignee and due date only. Rules restrict the
  // write to exactly those keys on an open RFI.
  const updateRfiManagement = useCallback(async (rfiDoc, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canEditManagement(rfiDoc?.status)) {
      throw new Error('The assignee and due date can no longer be changed')
    }

    const validationError = validateManagementDraft(input, rfiDoc)
    if (validationError) throw new Error(validationError)

    const d = normaliseRfiDraft({ ...input, raisedDate: rfiDoc.raisedDate })
    const ref = doc(collectionRef(), rfiDoc.id)
    await updateDoc(ref, {
      assignedToContactId: d.assignedToContactId,
      assignedToName:      d.assignedToName,
      dueDate:             d.dueDate,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  // RAISE — draft → open. The stored draft must already carry an assignee and
  // a due date; the write touches only the status and the raise stamps, which
  // is what freezes the question block for life.
  const raiseRfi = useCallback(async (rfiDoc) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const gateError = validateRaise(rfiDoc)
    if (gateError) throw new Error(gateError)

    const ref = doc(collectionRef(), rfiDoc.id)
    await updateDoc(ref, {
      status:    RFI_STATUS.OPEN,
      raisedAt:  serverTimestamp(),
      raisedBy:  user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  // ANSWER — open → answered. `answerDate` is the AUTHORED real-world date the
  // answer was received; `answeredAt` is the system stamp. Both are kept.
  const answerRfi = useCallback(async (rfiDoc, { answer, answerDate }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const gateError = validateAnswer({ answer, answerDate }, rfiDoc)
    if (gateError) throw new Error(gateError)

    const ref = doc(collectionRef(), rfiDoc.id)
    await updateDoc(ref, {
      status:     RFI_STATUS.ANSWERED,
      answer:     String(answer).trim(),
      answerDate,
      answeredAt: serverTimestamp(),
      answeredBy: user.uid,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  // CLOSE — answered → closed (terminal). There is NO REOPEN: an
  // unsatisfactory answer is closed with a note saying so, and a new RFI is
  // raised.
  const closeRfi = useCallback(async (rfiDoc, closeOutNote = '') => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const gateError = validateClose(closeOutNote, rfiDoc)
    if (gateError) throw new Error(gateError)

    const ref = doc(collectionRef(), rfiDoc.id)
    await updateDoc(ref, {
      status:       RFI_STATUS.CLOSED,
      closeOutNote: String(closeOutNote ?? '').trim(),
      closedAt:     serverTimestamp(),
      closedBy:     user.uid,
      updatedAt:    serverTimestamp(),
      updatedBy:    user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  // CANCEL — draft/open → cancelled (terminal). NOT from answered. Requires a
  // non-whitespace reason — enforced here AND by rules, which additionally
  // restrict the write to the cancellation keys.
  //
  // RFIs are NEVER deleted (the ADR-12 posture).
  const cancelRfi = useCallback(async (rfiDoc, cancelReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const gateError = validateCancel(cancelReason, rfiDoc)
    if (gateError) throw new Error(gateError)

    const ref = doc(collectionRef(), rfiDoc.id)
    await updateDoc(ref, {
      status:       RFI_STATUS.CANCELLED,
      cancelReason: String(cancelReason).trim(),
      cancelledAt:  serverTimestamp(),
      cancelledBy:  user.uid,
      updatedAt:    serverTimestamp(),
      updatedBy:    user.uid,
    })
  }, [companyId, projectId, user, collectionRef])

  return {
    rfis,
    rfisLoading,
    rfisError,
    createRfi,
    updateRfiDraft,
    updateRfiManagement,
    raiseRfi,
    answerRfi,
    closeRfi,
    cancelRfi,
  }
}
