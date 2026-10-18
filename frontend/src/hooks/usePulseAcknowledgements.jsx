import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  validateAcknowledgementInput, normaliseAcknowledgementInput,
  evidenceKeysFor, acknowledgementAvailability, ACK_ERROR,
} from '../lib/pulseAttention'
import { runAcknowledge, runWithdraw, AcknowledgementError } from '../lib/pulseAcknowledgementActions'

// ── PULSE™ acknowledgements (ADR-49) ─────────────────────────────────────────
//
// One document per indicator, keyed by the DETERMINISTIC indicator id, under
// …/projects/{projectId}/pulseAcknowledgements — at most six per project. The
// subscription is the whole (tiny) collection for ONE project.
//
// ⚠️ THIS HOOK IS NOT A PULSE SOURCE. lib/pulse.js never reads it and it is
// NOT in INDICATOR_DEPENDENCIES: a failed acknowledgement read makes the
// management status UNKNOWN (lib/pulseAttention.js) and leaves all six
// indicators exactly as they were. It writes only acknowledgement documents —
// never a financial record, never a figure, and it stages NO currency lock
// (an acknowledgement holds no money).
//
// Mounted only inside the PULSE workspace, i.e. after the page's role gate,
// so subcontractor and client users never open it (rules deny them anyway).
//
// Keyed-snapshot / derived-loading pattern (ADR-41), as useForecastLines.
export function usePulseAcknowledgements(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [snap, setSnap] = useState({ key: null, pulseAcknowledgements: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'pulseAcknowledgements')
    // No orderBy — the document id is the indicator id and the page looks
    // documents up by it; nothing is listed in collection order.
    const unsubscribe = onSnapshot(
      ref,
      (querySnap) => setSnap({
        key,
        pulseAcknowledgements: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // A failed read is UNKNOWN management status — never "nothing acknowledged".
      () => setSnap({ key, pulseAcknowledgements: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const pulseAcknowledgements = settled ? snap.pulseAcknowledgements : []
  const pulseAcknowledgementsLoading = targetKey !== null && !settled
  const pulseAcknowledgementsError = settled ? snap.error : false

  const ackRef = useCallback(
    (indicatorId) => doc(db, 'companies', companyId, 'projects', projectId, 'pulseAcknowledgements', indicatorId),
    [companyId, projectId],
  )

  // Acknowledge the CURRENT finding of one indicator. `indicator` is the
  // lib/pulse.js evaluation as rendered (its evidence keys are what gets
  // recorded); `seen` is the acknowledgement document as rendered, or null.
  // Throws an AcknowledgementError (`kind` + user message); on any refusal
  // nothing is written.
  const acknowledgeFinding = useCallback(async (indicator, seen, input) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const availability = acknowledgementAvailability(indicator)
    if (!availability.ok) throw new AcknowledgementError(ACK_ERROR.INVALID)
    const validationError = validateAcknowledgementInput(input)
    if (validationError) throw new AcknowledgementError(ACK_ERROR.INVALID, validationError)

    const { note, reviewBy } = normaliseAcknowledgementInput(input)
    return runAcknowledge({
      db,
      ref: ackRef(indicator.id),
      indicatorId: indicator.id,
      seen,
      evidenceKeys: evidenceKeysFor(indicator),
      note,
      reviewBy,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, ackRef])

  // Withdraw an ACTIVE acknowledgement. The document is kept (delete is
  // blocked); its status becomes `withdrawn` and the finding — if it still
  // stands — returns to Needs attention.
  const withdrawAcknowledgement = useCallback(async (seen) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!seen?.id) throw new AcknowledgementError(ACK_ERROR.MISSING)
    return runWithdraw({
      db,
      ref: ackRef(seen.id),
      seen,
      uid: user.uid,
      runTransaction,
      serverTimestamp,
    })
  }, [companyId, projectId, user, ackRef])

  return {
    pulseAcknowledgements,
    pulseAcknowledgementsLoading,
    pulseAcknowledgementsError,
    acknowledgeFinding,
    withdrawAcknowledgement,
  }
}
