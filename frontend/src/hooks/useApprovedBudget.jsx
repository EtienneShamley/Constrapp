import { useMemo } from 'react'
import { useApprovedBudgetPointer } from './useApprovedBudgetPointer'
import { useBudgetApprovalHeader } from './useBudgetApprovalHeader'
import { useBudgetApprovalSnapshot } from './useBudgetApprovalSnapshot'
import { useActiveVersionAdjustments } from './useBudgetAdjustments'

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
// SHIELD 2B2 (ADR-71): the APPROVED ADJUSTMENTS of the active version are a
// fourth subscription, opened ONLY when the pointer's ledger records any
// (adjustmentCount > 0) — every project without adjustments reads exactly as
// before. resolveBudgetSource reconciles them with the ledger.
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

  const ledgerCount = Number.isInteger(pointer?.adjustmentCount) ? pointer.adjustmentCount : 0
  const { adjustments, adjustmentsLoading, adjustmentsError } =
    useActiveVersionAdjustments(projectId, activeId, ledgerCount > 0)

  const approvedBudget = useMemo(() => ({
    pointer, pointerLoading, pointerError,
    header, headerLoading, headerError,
    snapshot, snapshotLoading, snapshotError,
    originalSnapshot, originalLoading, originalError,
    originalRequested: original,
    adjustments, adjustmentsLoading, adjustmentsError,
  }), [
    pointer, pointerLoading, pointerError, header, headerLoading, headerError,
    snapshot, snapshotLoading, snapshotError, originalSnapshot, originalLoading, originalError, original,
    adjustments, adjustmentsLoading, adjustmentsError,
  ])

  const approvedBudgetLoading = pointerLoading || headerLoading || snapshotLoading || originalLoading || adjustmentsLoading
  const approvedBudgetError = pointerError || headerError || snapshotError || originalError || adjustmentsError

  return { approvedBudget, approvedBudgetLoading, approvedBudgetError }
}
