import { useEffect, useState, useCallback } from 'react'
import { collection, doc, onSnapshot, query, orderBy } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'

// ── Original contract value corrections (ADR-96, G5) ─────────────────────────
//
// The register of proposed / approved / withdrawn corrections of a project's
// original contract value, read live, and the three operations — written ONLY
// by the trusted `contractValueOperation` callable. A correction fixes the
// baseline itself (a value entered wrongly, or an amendment to the executed
// contract sum); a change of scope or price after award is a client variation.

const call = async (operation, request) =>
  (await httpsCallable(functions, 'contractValueOperation', { timeout: 70000 })({ operation, request })).data

export function useContractValueRevisions(projectId) {
  const { user } = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const [snap, setSnap] = useState({ key: null, revisions: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'contractValueRevisions')
    return onSnapshot(
      query(ref, orderBy('proposedAt', 'desc')),
      (qs) => setSnap({ key, revisions: qs.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, revisions: [], error: true }),
    )
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const revisions = settled ? snap.revisions : []

  const propose = useCallback(async ({ fromValue, toValue, reason }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    const revisionId = doc(collection(db, 'companies', companyId, 'projects', projectId, 'contractValueRevisions')).id
    return call('propose', {
      projectId, revisionId, fromValue: Math.round(Number(fromValue) * 100) / 100, toValue: Math.round(Number(toValue) * 100) / 100,
      reason: String(reason ?? '').trim(), confirmsNotAVariation: true,
    })
  }, [companyId, projectId, user])
  const approve = useCallback(async (revisionId) => call('approve', { projectId, revisionId }), [projectId])
  const withdraw = useCallback(async (revisionId, reason) => call('withdraw', { projectId, revisionId, reason: String(reason ?? '').trim() }), [projectId])

  return { revisions, revisionsLoading: targetKey !== null && !settled, revisionsError: settled ? snap.error : false, propose, approve, withdraw }
}
