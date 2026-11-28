import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'

// The company's approval-segregation policy — ONE document,
// companies/{companyId}/approvalPolicy/current, readable by any member of the
// company and written only by the operator tool (never by a client). See
// lib/approvalSegregation.js for what it means; the Rules enforce it.
//
// The keyed-snapshot pattern (ADR-41): state is written only from the
// onSnapshot callbacks; policy/loading/error are derived at render time.
//
// `approvalPolicyKnown` is true only once the CURRENT company's read has
// settled WITHOUT an error. A settled missing document is known (segregation
// off). Loading or unreadable is NOT known: surfaces then neither block nor
// claim that self-approval is permitted.
export const APPROVAL_POLICY_DOC_ID = 'current'

export function useApprovalPolicy() {
  // Tolerates a missing CompanyProvider (a page rendered on its own in a test):
  // no company ⇒ the policy is simply not known.
  const companyContext = useCompany()
  const companyId = companyContext?.company?.id ?? null

  const [snap, setSnap] = useState({ key: null, policy: null, error: false })

  useEffect(() => {
    if (!companyId) return undefined

    const key = companyId
    const ref = doc(db, 'companies', companyId, 'approvalPolicy', APPROVAL_POLICY_DOC_ID)
    const unsubscribe = onSnapshot(
      ref,
      (docSnap) => setSnap({ key, policy: docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null, error: false }),
      // Unreadable — the policy is NOT KNOWN (never read as "off").
      () => setSnap({ key, policy: null, error: true }),
    )
    return unsubscribe
  }, [companyId])

  const targetKey = companyId || null
  const settled = targetKey !== null && snap.key === targetKey
  const approvalPolicy = settled ? snap.policy : null
  const approvalPolicyLoading = targetKey !== null && !settled
  const approvalPolicyError = settled ? snap.error : false
  const approvalPolicyKnown = settled && !approvalPolicyError

  return { approvalPolicy, approvalPolicyLoading, approvalPolicyError, approvalPolicyKnown }
}
