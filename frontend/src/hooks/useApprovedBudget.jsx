import { useMemo } from 'react'
import { useApprovedBudgetPointer } from './useApprovedBudgetPointer'
import { useBudgetApprovalHeader } from './useBudgetApprovalHeader'
import { useBudgetApprovalSnapshot } from './useBudgetApprovalSnapshot'

// ── The ACTIVE approved budget — Constrapp SHIELD™ 2B1 (ADR-70) ──────────────
//
// Composes the three single-document subscriptions the authoritative budget
// needs — the pointer (`approvedBudget/current`), the ACTIVE version's header
// and its immutable snapshot — and, only when a consumer asks for it
// (`original: true` — margin's Original Planned Profit and Margin Movement),
// the ORIGINAL (version 1) snapshot. Each inner hook is idle until its id is
// known, so a project with no approved budget opens exactly ONE listener (the
// pointer) and a page that does not need the original never reads it.
//
// This hook opens no listener of its own and performs no arithmetic: it hands
// the raw documents and their read states to lib/budgetApproval.js →
// resolveBudgetSource, which validates the pointer / header / snapshot
// agreement and decides APPROVED / WORKING / LOADING / UNAVAILABLE. Pages
// call that selector with their working budget lines; the Dashboard snapshot,
// PULSE and SHIELD receive this object as `sources.approvedBudget`.
//
// `approvedBudgetLoading` / `approvedBudgetError` are the RAW read states of
// the subscriptions opened (SHIELD gates on these); the folded financial state
// that also covers the working register comes from budgetSourceState().
export function useApprovedBudget(projectId, { original = false } = {}) {
  const { pointer, pointerLoading, pointerError } = useApprovedBudgetPointer(projectId)

  const activeId = typeof pointer?.activeApprovalId === 'string' && pointer.activeApprovalId ? pointer.activeApprovalId : null
  const originalId = typeof pointer?.originalApprovalId === 'string' && pointer.originalApprovalId ? pointer.originalApprovalId : null
  // The original is a separate read only when it is a different document.
  const originalReadId = original && originalId && originalId !== activeId ? originalId : null

  const { header, headerLoading, headerError } = useBudgetApprovalHeader(projectId, activeId)
  const { snapshot, snapshotLoading, snapshotError } = useBudgetApprovalSnapshot(projectId, activeId)
  const {
    snapshot: originalSnapshot, snapshotLoading: originalLoading, snapshotError: originalError,
  } = useBudgetApprovalSnapshot(projectId, originalReadId)

  const approvedBudget = useMemo(() => ({
    pointer, pointerLoading, pointerError,
    header, headerLoading, headerError,
    snapshot, snapshotLoading, snapshotError,
    originalSnapshot, originalLoading, originalError,
    originalRequested: original,
  }), [
    pointer, pointerLoading, pointerError, header, headerLoading, headerError,
    snapshot, snapshotLoading, snapshotError, originalSnapshot, originalLoading, originalError, original,
  ])

  const approvedBudgetLoading = pointerLoading || headerLoading || snapshotLoading || originalLoading
  const approvedBudgetError = pointerError || headerError || snapshotError || originalError

  return { approvedBudget, approvedBudgetLoading, approvedBudgetError }
}
