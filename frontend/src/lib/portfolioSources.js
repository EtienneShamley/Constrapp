// ── L2-C Portfolio Reporting — the ONE-SHOT read plan (pure; ADR-78) ─────────
//
// The Portfolio page reads each project's financial records ONCE (server
// reads, no persistent listener) and hands them to the same selectors the
// project tabs use. This module is the PLAN for those reads and the assembly
// of their results. It never imports the Firebase SDK: every read arrives
// through an injected `reader`, so the whole plan — which paths, in what
// shape, with what failure handling, and how many at a time — is unit-tested
// in plain Node (hooks/usePortfolioReport.jsx supplies the Firestore reader).
//
// ⚠️ PARITY WITH THE LIVE HOOKS IS THE CONTRACT. Each entry below names the
// hook whose query it repeats, and tests/unit/portfolioSources.test.js reads
// that hook's SOURCE to prove the collection name and ordering still match.
// The ordering is not cosmetic: `orderBy('createdAt', 'desc')` also EXCLUDES
// any document without a `createdAt`, so dropping or changing it here would
// make the portfolio count records the project tabs do not.
//
// Every list read returns the WHOLE register — no limit, no pagination — and
// maps each document exactly as the hooks do: `{ id, ...data }`.

// Projects loaded at the same time. Bounded so a large company never opens
// dozens of concurrent reads; rows fill in as each project settles.
export const PORTFOLIO_PROJECT_CONCURRENCY = 3

const CREATED_DESC = ['createdAt', 'desc']

// The fifteen registers, each read once per project.
export const PORTFOLIO_LIST_SOURCES = [
  { source: 'budgetLines',         collection: 'budgetLines',         orderBy: CREATED_DESC, hook: 'useBudgetLines.jsx' },
  { source: 'purchaseOrders',      collection: 'purchaseOrders',      orderBy: CREATED_DESC, hook: 'usePurchaseOrders.jsx' },
  { source: 'progressClaims',      collection: 'progressClaims',      orderBy: CREATED_DESC, hook: 'useProgressClaims.jsx' },
  { source: 'supplierInvoices',    collection: 'supplierInvoices',    orderBy: CREATED_DESC, hook: 'useSupplierInvoices.jsx' },
  { source: 'supplierCreditNotes', collection: 'supplierCreditNotes', orderBy: CREATED_DESC, hook: 'useSupplierCreditNotes.jsx' },
  { source: 'variations',          collection: 'variations',          orderBy: CREATED_DESC, hook: 'useVariations.jsx' },
  // No ordering — the document id is the costCodeId (useForecastLines).
  { source: 'forecastLines',       collection: 'forecastLines',       orderBy: null,         hook: 'useForecastLines.jsx' },
  { source: 'supplierPayments',    collection: 'supplierPayments',    orderBy: CREATED_DESC, hook: 'useSupplierPayments.jsx' },
  { source: 'retentionReleases',   collection: 'retentionReleases',   orderBy: CREATED_DESC, hook: 'useRetentionReleases.jsx' },
  { source: 'clientInvoices',      collection: 'clientInvoices',      orderBy: CREATED_DESC, hook: 'useClientInvoices.jsx' },
  { source: 'clientReceipts',      collection: 'clientReceipts',      orderBy: CREATED_DESC, hook: 'useClientReceipts.jsx' },
  // The receivable contract (ADR-87 / ADR-88): what a client owes is derived
  // from the invoices AND these two registers, so a row that did not read them
  // would overstate receivables wherever a credit or held retention exists.
  { source: 'clientCreditNotes',       collection: 'clientCreditNotes',       orderBy: CREATED_DESC, hook: 'useClientCreditNotes.jsx' },
  { source: 'clientRetentionReleases', collection: 'clientRetentionReleases', orderBy: CREATED_DESC, hook: 'useClientRetentionReleases.jsx' },
  // Phase 2 step 5: net cash and what each invoice holds (refunds, applications).
  { source: 'clientRefunds',             collection: 'clientRefunds',             orderBy: CREATED_DESC, hook: 'useClientRefunds.jsx' },
  { source: 'clientReceiptApplications', collection: 'clientReceiptApplications', orderBy: CREATED_DESC, hook: 'useClientReceiptApplications.jsx' },
]

// The single documents, as path segments below the project document.
export const PORTFOLIO_DOC_SOURCES = {
  baseline:        { path: () => ['commercial', 'baseline'],                 hook: 'useProjectCommercial.jsx' },
  budgetPointer:   { path: () => ['approvedBudget', 'current'],              hook: 'useApprovedBudgetPointer.jsx' },
  budgetHeader:    { path: (approvalId) => ['budgetApprovals', approvalId],          hook: 'useBudgetApprovalHeader.jsx' },
  budgetSnapshot:  { path: (approvalId) => ['budgetApprovalSnapshots', approvalId],  hook: 'useBudgetApprovalSnapshot.jsx' },
}

// The approved adjustments of the ACTIVE version (useActiveVersionAdjustments):
// an equality filter only, served by the automatic single-field index.
export const PORTFOLIO_ADJUSTMENTS_SOURCE = {
  collection: 'budgetAdjustments',
  where: (activeApprovalId) => ['baseApprovalId', '==', activeApprovalId],
  hook: 'useBudgetAdjustments.jsx',
}

// A read that never throws: { value, error }.
const settle = (promise, emptyValue) =>
  Promise.resolve()
    .then(() => promise())
    .then(value => ({ value, error: false }), () => ({ value: emptyValue, error: true }))

const idle = (value) => Promise.resolve({ value, error: false, idle: true })

// ── The approved budget (SHIELD 2B1 / 2B2 — ADR-70, ADR-71) ──────────────────
//
// Rebuilds, from one-shot reads, EXACTLY the object hooks/useApprovedBudget.jsx
// hands to lib/budgetApproval.js → resolveBudgetSource with `original: true`
// (the L2-A Commercial Report's own request, so a project row and its Reports
// tab resolve the same budget source in every case, including the integrity
// failures):
//
//   1. the pointer — always;
//   2. the ACTIVE version's header and snapshot — only when the pointer names
//      one (a project with no approved budget reads the pointer and nothing
//      else, and falls back to the working register);
//   3. the ORIGINAL (version 1) snapshot — only when it is a DIFFERENT
//      document from the active one;
//   4. the active version's adjustments — only when the pointer's ledger
//      records any (adjustmentCount > 0).
//
// Nothing is validated or repaired here: resolveBudgetSource decides APPROVED /
// WORKING / UNAVAILABLE from these documents and their read states. Every
// `…Loading` flag is false because every read has settled by the time this
// resolves. Returns the object and the number of reads issued.
export async function loadApprovedBudget(reader, { companyId, projectId }) {
  const at = (path) => ({ companyId, projectId, path })
  const pointerRead = await settle(() => reader.get(at(PORTFOLIO_DOC_SOURCES.budgetPointer.path())), null)
  const pointer = pointerRead.value ?? null

  const activeId = typeof pointer?.activeApprovalId === 'string' && pointer.activeApprovalId ? pointer.activeApprovalId : null
  const originalId = typeof pointer?.originalApprovalId === 'string' && pointer.originalApprovalId ? pointer.originalApprovalId : null
  const originalReadId = originalId && originalId !== activeId ? originalId : null
  const ledgerCount = Number.isInteger(pointer?.adjustmentCount) ? pointer.adjustmentCount : 0
  const readAdjustments = ledgerCount > 0 && activeId !== null

  const [header, snapshot, original, adjustments] = await Promise.all([
    activeId ? settle(() => reader.get(at(PORTFOLIO_DOC_SOURCES.budgetHeader.path(activeId))), null) : idle(null),
    activeId ? settle(() => reader.get(at(PORTFOLIO_DOC_SOURCES.budgetSnapshot.path(activeId))), null) : idle(null),
    originalReadId ? settle(() => reader.get(at(PORTFOLIO_DOC_SOURCES.budgetSnapshot.path(originalReadId))), null) : idle(null),
    readAdjustments
      ? settle(() => reader.list({
        companyId, projectId,
        collection: PORTFOLIO_ADJUSTMENTS_SOURCE.collection,
        orderBy: null,
        where: PORTFOLIO_ADJUSTMENTS_SOURCE.where(activeId),
      }), [])
      // The idle hook exposes `null` (never an empty list) when it reads nothing.
      : idle(null),
  ])

  const reads = 1 + [header, snapshot, original, adjustments].filter(r => !r.idle).length

  return {
    approvedBudget: {
      pointer, pointerLoading: false, pointerError: pointerRead.error,
      header: header.value ?? null, headerLoading: false, headerError: header.error,
      snapshot: snapshot.value ?? null, snapshotLoading: false, snapshotError: snapshot.error,
      originalSnapshot: original.value ?? null, originalLoading: false, originalError: original.error,
      originalRequested: true,
      adjustments: adjustments.value, adjustmentsLoading: false, adjustmentsError: adjustments.error,
    },
    reads,
  }
}

// ── One project ──────────────────────────────────────────────────────────────
//
// Every register, the commercial baseline and the approved budget, read in
// parallel. A failed read NEVER rejects the project: it becomes an empty value
// with `error: true` in `readStates` — exactly what the live hooks expose — so
// the selectors report the figures that depend on it as Unavailable and every
// other figure still renders. `readStates` deliberately has no `approvedBudget`
// entry: that state is DERIVED from the budget source (lib/portfolioReport.js),
// the same way the Reports tab derives it.
export async function loadProjectSources(reader, { companyId, projectId }) {
  const lists = PORTFOLIO_LIST_SOURCES.map(spec =>
    settle(() => reader.list({
      companyId, projectId, collection: spec.collection, orderBy: spec.orderBy, where: null,
    }), []),
  )
  const baselineRead = settle(() => reader.get({ companyId, projectId, path: PORTFOLIO_DOC_SOURCES.baseline.path() }), null)
  const budgetRead = loadApprovedBudget(reader, { companyId, projectId })

  const [listResults, baseline, budget] = await Promise.all([Promise.all(lists), baselineRead, budgetRead])

  const sources = { baseline: baseline.value ?? null, approvedBudget: budget.approvedBudget }
  const readStates = { baseline: { loading: false, error: baseline.error } }
  PORTFOLIO_LIST_SOURCES.forEach((spec, i) => {
    const r = listResults[i]
    sources[spec.source] = Array.isArray(r.value) ? r.value : []
    readStates[spec.source] = { loading: false, error: r.error || !Array.isArray(r.value) }
  })

  return { sources, readStates, reads: PORTFOLIO_LIST_SOURCES.length + 1 + budget.reads }
}

// A project whose load failed OUTSIDE the per-read handling above (it should
// not happen — every read is settled — but an unexpected throw must surface
// as Unavailable, never as an empty, zero-value project).
export function failedProjectResult() {
  const sources = {
    baseline: null,
    approvedBudget: {
      pointer: null, pointerLoading: false, pointerError: true,
      header: null, headerLoading: false, headerError: false,
      snapshot: null, snapshotLoading: false, snapshotError: false,
      originalSnapshot: null, originalLoading: false, originalError: false,
      originalRequested: true,
      adjustments: null, adjustmentsLoading: false, adjustmentsError: false,
    },
  }
  const readStates = { baseline: { loading: false, error: true } }
  for (const spec of PORTFOLIO_LIST_SOURCES) {
    sources[spec.source] = []
    readStates[spec.source] = { loading: false, error: true }
  }
  return { sources, readStates, reads: 0 }
}

// The reads ONE project costs: the fixed part, and the conditional part of the
// approved budget. Documented from this plan, not estimated.
export const PORTFOLIO_READS_PER_PROJECT = {
  // 15 registers + the commercial baseline + the approved-budget pointer.
  min: PORTFOLIO_LIST_SOURCES.length + 2,
  // + active header + active snapshot + original snapshot + adjustments.
  max: PORTFOLIO_LIST_SOURCES.length + 2 + 4,
}

// ── The bounded loader ───────────────────────────────────────────────────────
//
// Loads projects through `loadProject(projectId)` at most `limit` at a time, in
// the order they were enqueued, reporting each through `onResult`. One loader
// is ONE run (one company, one Refresh): `cancel()` ends it, after which no
// queued project starts and NO result is reported — which is how an obsolete
// run (navigation away, or a Refresh) is discarded.
//
//   · `enqueue(ids)` — adds the ids not already requested in this run, so a
//     project is never read twice in one run (toggling "include completed" off
//     and on again reads nothing new).
//   · `retain(ids)`  — drops QUEUED (not yet started) projects that are no
//     longer in scope; they can be enqueued again later.
//
// Starting is deferred through `schedule` (a microtask by default), so a
// loader cancelled in the same tick it was created — React StrictMode's
// development-only mount / unmount / mount — issues no read at all.
export function createPortfolioLoader({
  loadProject,
  onResult,
  limit = PORTFOLIO_PROJECT_CONCURRENCY,
  schedule = (fn) => { Promise.resolve().then(fn) },
}) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : PORTFOLIO_PROJECT_CONCURRENCY
  const requested = new Set()
  let queue = []
  let active = 0
  let cancelled = false
  let scheduled = false

  const finish = (projectId, result) => {
    active -= 1
    if (cancelled) return
    onResult(projectId, result)
    pump()
  }

  function pump() {
    scheduled = false
    if (cancelled) return
    while (active < max && queue.length > 0) {
      const projectId = queue.shift()
      active += 1
      Promise.resolve()
        .then(() => loadProject(projectId))
        .then(result => finish(projectId, result), () => finish(projectId, failedProjectResult()))
    }
  }

  const schedulePump = () => {
    if (scheduled || cancelled) return
    scheduled = true
    schedule(pump)
  }

  return {
    enqueue(projectIds) {
      if (cancelled) return
      for (const id of projectIds ?? []) {
        if (typeof id !== 'string' || !id || requested.has(id)) continue
        requested.add(id)
        queue.push(id)
      }
      if (queue.length > 0) schedulePump()
    },
    retain(projectIds) {
      if (cancelled) return
      const keep = new Set(projectIds ?? [])
      queue = queue.filter(id => {
        if (keep.has(id)) return true
        requested.delete(id)
        return false
      })
    },
    cancel() {
      cancelled = true
      queue = []
    },
    get cancelled() { return cancelled },
    get activeCount() { return active },
    get queuedCount() { return queue.length },
  }
}
