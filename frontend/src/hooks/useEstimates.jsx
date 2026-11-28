import { useEffect, useMemo, useState, useCallback } from 'react'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { ESTIMATE_CALLABLE, ESTIMATE_CALL_TIMEOUT_MS, runEstimateOperation } from '../lib/estimatingActions'
import { normaliseEstimateSettings } from '../lib/estimating'

// ── Estimate revisions (ADR-97) ──────────────────────────────────────────────
//
// The project's estimate revisions (headers) and the optional rate breakdowns,
// read live — and the four operations, written ONLY by the trusted
// `estimateOperation` callable. This hook writes nothing to Firestore itself;
// Rules refuse every client write to these collections.
//
// ⚠️ THE BROWSER SENDS NO FIGURE. A build names the project, an estimate id
// and the authored settings; the server reads the BOQ itself and derives every
// line, total and the selling price.

const call = async (data) => (await httpsCallable(functions, ESTIMATE_CALLABLE, { timeout: ESTIMATE_CALL_TIMEOUT_MS })(data)).data

// ONE live collection at a path (an array of segments, or null while there is
// no target). The house subscription pattern: the snapshot is tagged with the
// key it was taken for; data, loading and error are derived from whether the
// CURRENT target has settled, so a target switch never shows the previous
// target's rows or error.
function useCollection(segments) {
  const path = segments ? segments.join('/') : null
  const [snap, setSnap] = useState({ key: null, docs: [], error: false })

  useEffect(() => {
    if (!path) return undefined
    const key = path
    return onSnapshot(
      collection(db, path),
      (qs) => setSnap({ key, docs: qs.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, docs: [], error: true }),
    )
  }, [path])

  const targetKey = path
  const settled = targetKey !== null && snap.key === targetKey
  return { docs: settled ? snap.docs : [], loading: targetKey !== null && !settled, error: settled ? snap.error : false }
}

export function useEstimates(projectId, { enabled = true } = {}) {
  const { user } = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const on = Boolean(enabled && companyId && projectId)

  const estimates = useCollection(on ? ['companies', companyId, 'projects', projectId, 'estimates'] : null)
  const inputs = useCollection(on ? ['companies', companyId, 'projects', projectId, 'estimateItemInputs'] : null)

  const ready = Boolean(companyId && projectId && user)
  const guard = () => { if (!ready) throw new Error('Not authenticated') }

  // A NEW revision: a fresh id per request, so a repeat after an uncertain
  // outcome must reuse the id the caller kept (`estimateId`).
  const newEstimateId = useCallback(
    () => doc(collection(db, 'companies', companyId ?? '-', 'projects', projectId ?? '-', 'estimates')).id,
    [companyId, projectId],
  )
  const buildEstimate = useCallback(async ({ estimateId, expectedRevision = null, settings }) => {
    guard()
    return runEstimateOperation(call, 'build', { projectId, estimateId, expectedRevision, settings: normaliseEstimateSettings(settings) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ready])
  const approveEstimate = useCallback(async ({ estimateId, expectedRevision, contentSha256 }) => {
    guard()
    return runEstimateOperation(call, 'approve', { projectId, estimateId, expectedRevision, contentSha256 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ready])
  const discardEstimate = useCallback(async ({ estimateId, expectedRevision, reason = '' }) => {
    guard()
    return runEstimateOperation(call, 'discard', { projectId, estimateId, expectedRevision, reason: String(reason ?? '').trim() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ready])
  const setComponents = useCallback(async (items) => {
    guard()
    return runEstimateOperation(call, 'setComponents', { projectId, items })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ready])

  return {
    estimates: estimates.docs, estimatesLoading: estimates.loading, estimatesError: estimates.error,
    itemInputs: inputs.docs, itemInputsLoading: inputs.loading, itemInputsError: inputs.error,
    newEstimateId, buildEstimate, approveEstimate, discardEstimate, setComponents,
  }
}

// The stored lines of ONE revision (its chunk documents, in order). Read only
// while a revision is open on the page.
export function useEstimateLines(projectId, estimateId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const on = Boolean(companyId && projectId && estimateId)
  const chunks = useCollection(on ? ['companies', companyId, 'projects', projectId, 'estimates', estimateId, 'lines'] : null)
  const docs = chunks.docs
  const ordered = useMemo(() => [...docs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)), [docs])
  const lines = useMemo(() => ordered.flatMap(c => (Array.isArray(c.lines) ? c.lines : [])), [ordered])
  return { chunks: ordered, lines, linesLoading: chunks.loading, linesError: chunks.error }
}
