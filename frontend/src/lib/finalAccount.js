import { roundMoney } from './purchaseOrders'
import { toCents } from './payments'
import { buildCommercialReport, REPORT_SOURCES, REPORT_SOURCE_LABELS } from './commercialReport'
import { FIGURE_STATE } from './projectSnapshot'
import { projectForecastTotals } from './margin'
import { resolveBudgetSource, budgetLinesFor, approvedVersionCaption, BUDGET_SOURCE } from './budgetApproval'
import { contractControl, draftClientInvoices } from './clientInvoices'
import { receivablesSummary, receiptSummary } from './clientReceipts'
import { paymentSummary } from './supplierPayments'
import { retentionSummary, draftRetentionReleases } from './retention'
import { draftSupplierCreditNotes } from './supplierCreditNotes'
import { SI_STATUS } from './supplierInvoices'
import { CLAIM_OPEN_STATUSES } from './progressClaims'
import { VARIATION_TYPE, VARIATION_PENDING_STATUSES } from './variations'

export { resolveProjectCurrency } from './currency'

// ── L2-B Final Account (ADR-77) — PURE domain, COMPOSITION ONLY ──────────────
//
// The Final Account of ONE project in ONE currency: the figures an approved
// revision freezes, the readiness gate that decides whether they MAY be
// frozen, and the comparison of a frozen revision with a later computation.
//
// Like lib/commercialReport.js this module is NOT a financial engine. Every
// money figure is the output of an existing selector, carried through
// unchanged; the only arithmetic here is whole-cent EQUALITY (toCents) and the
// zero tests of the readiness gate.
//
// ⚠️ THIS FILE IS ALSO THE SERVER'S CALCULATION. It is the single entry of the
// bundle `functions/src/generated/finalAccountCalc.js`
// (scripts/build-final-account-bundle.mjs), which the trusted
// `approveFinalAccount` callable runs over records it reads itself. There is
// therefore ONE formula on both sides. It must stay free of React, the
// Firebase SDKs, the DOM and `import.meta` — `tests/unit/finalAccountBundle.test.js`
// fails if the bundle gains an import, goes stale, or disagrees with this file.
//
// Bases are never mixed: contract, budget, cost and profit figures are ex-GST;
// invoice balances and cash are gross. No figure adds one basis to the other.

export const FINAL_ACCOUNT_STATUS = { DRAFT: 'draft', APPROVED: 'approved', WITHDRAWN: 'withdrawn' }

export const FINAL_ACCOUNT_STATUS_LABELS = {
  [FINAL_ACCOUNT_STATUS.DRAFT]:     'Draft',
  [FINAL_ACCOUNT_STATUS.APPROVED]:  'Approved',
  [FINAL_ACCOUNT_STATUS.WITHDRAWN]: 'Withdrawn',
}

export const FINAL_ACCOUNT_STATUS_BADGE = {
  [FINAL_ACCOUNT_STATUS.DRAFT]:     'pending',
  [FINAL_ACCOUNT_STATUS.APPROVED]:  'approved',
  [FINAL_ACCOUNT_STATUS.WITHDRAWN]: 'draft',
}

export const FINAL_ACCOUNT_LIMITS = { REASON: 500, REFERENCE: 200, ROWS: 1000, NAME: 200 }

// 1 MiB is Firestore's document limit; the capture refuses well under it.
export const FINAL_ACCOUNT_MAX_BYTES = 900000

// UX mirrors of the enforced boundary (Rules for drafts and withdrawal, the
// callable for approval) — never a control.
export const FINAL_ACCOUNT_PREPARE_ROLES = ['company_admin', 'project_manager', 'qs']
export const FINAL_ACCOUNT_APPROVE_ROLES = ['company_admin', 'project_manager']
export const canPrepareFinalAccount = (role) => FINAL_ACCOUNT_PREPARE_ROLES.includes(role)
export const canApproveFinalAccount = (role) => FINAL_ACCOUNT_APPROVE_ROLES.includes(role)
export const canWithdrawFinalAccount = (role, account, uid) =>
  account?.status === FINAL_ACCOUNT_STATUS.DRAFT
  && (canApproveFinalAccount(role) || (canPrepareFinalAccount(role) && !!uid && account.createdBy === uid))

// The disclaimer shown on screen, in print and in the CSV — verbatim.
export const FINAL_ACCOUNT_DISCLAIMER =
  'Internal approval within Constrap. It is not a client agreement, a contractual certificate, a tax document or proof of payment.'

// ── The figures ──────────────────────────────────────────────────────────────

export const FIGURE_BASIS = { EX_GST: 'exGst', GROSS: 'gross', PERCENT: 'percent' }
export const FIGURE_GROUP = { CONTRACT: 'contract', COST: 'cost', RESULT: 'result', BALANCES: 'balances' }

export const FIGURE_GROUP_LABELS = {
  [FIGURE_GROUP.CONTRACT]: 'Contract and revenue (ex-GST)',
  [FIGURE_GROUP.COST]:     'Cost (ex-GST)',
  [FIGURE_GROUP.RESULT]:   'Result (ex-GST)',
  [FIGURE_GROUP.BALANCES]: 'Invoice balances and cash (gross, incl. GST)',
}

// Reading order. `open: true` marks a recognised outstanding balance: shown and
// acknowledged, never a blocker and never treated as zero.
export const FINAL_ACCOUNT_FIGURES = [
  { key: 'originalContractValue',     group: FIGURE_GROUP.CONTRACT, basis: FIGURE_BASIS.EX_GST, label: 'Original contract sum', note: 'From the Commercial baseline' },
  { key: 'approvedClientVariations',  group: FIGURE_GROUP.CONTRACT, basis: FIGURE_BASIS.EX_GST, label: 'Approved client variations', note: 'Approved only — pending variations block approval' },
  { key: 'finalContractSum',          group: FIGURE_GROUP.CONTRACT, basis: FIGURE_BASIS.EX_GST, label: 'Final adjusted contract sum', note: 'Original contract sum + approved client variations' },
  { key: 'invoicedToClient',          group: FIGURE_GROUP.CONTRACT, basis: FIGURE_BASIS.EX_GST, label: 'Invoiced to client', note: 'Issued client invoices — an invoice is not a certificate and not cash' },
  { key: 'remainingToInvoice',        group: FIGURE_GROUP.CONTRACT, basis: FIGURE_BASIS.EX_GST, label: 'Remaining to invoice', note: 'Final adjusted contract sum − invoiced to client (negative = over-invoiced)', open: true },
  { key: 'approvedBudget',            group: FIGURE_GROUP.COST,     basis: FIGURE_BASIS.EX_GST, label: 'Approved budget', note: 'The approved version and its approved adjustments' },
  { key: 'approvedSupplierVariations', group: FIGURE_GROUP.COST,    basis: FIGURE_BASIS.EX_GST, label: 'Approved supplier variations', note: 'Gross approved value — already inside the cost below' },
  { key: 'actualCost',                group: FIGURE_GROUP.COST,     basis: FIGURE_BASIS.EX_GST, label: 'Actual cost', note: 'Approved claims + posted supplier invoices − posted credit notes' },
  { key: 'costToComplete',            group: FIGURE_GROUP.COST,     basis: FIGURE_BASIS.EX_GST, label: 'Cost to complete', note: 'Must be zero for approval' },
  { key: 'finalCost',                 group: FIGURE_GROUP.COST,     basis: FIGURE_BASIS.EX_GST, label: 'Final cost', note: 'Actual cost + cost to complete' },
  { key: 'varianceToBudget',          group: FIGURE_GROUP.COST,     basis: FIGURE_BASIS.EX_GST, label: 'Variance to budget', note: 'Approved budget − final cost (negative = over budget)' },
  { key: 'finalProfit',               group: FIGURE_GROUP.RESULT,   basis: FIGURE_BASIS.EX_GST, label: 'Final gross profit', note: 'Final adjusted contract sum − final cost' },
  { key: 'finalMarginPct',            group: FIGURE_GROUP.RESULT,   basis: FIGURE_BASIS.PERCENT, label: 'Final margin', note: 'Final gross profit ÷ final adjusted contract sum', nullable: true },
  { key: 'invoicedToClientGross',     group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Invoiced to client (gross)', note: 'Issued client invoices incl. GST' },
  { key: 'receivedAgainstInvoices',   group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Received against invoices', note: 'Posted client receipts allocated to issued invoices' },
  { key: 'receivablesOutstanding',    group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Client invoices outstanding', note: 'Issued and not yet matched to a receipt — not cash', open: true },
  { key: 'cashReceived',              group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Cash received', note: 'All posted client receipts' },
  { key: 'unallocatedReceipts',       group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Unallocated client receipts', note: 'Received but not matched to an invoice', open: true },
  { key: 'cashPaid',                  group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Cash paid', note: 'All posted supplier payments' },
  { key: 'payablesOutstanding',       group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Supplier invoices unpaid', note: 'Posted and still payable — not cash', open: true },
  { key: 'unallocatedPayments',       group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Unallocated supplier payments', note: 'Paid but not matched to an invoice', open: true },
  { key: 'retentionHeld',             group: FIGURE_GROUP.BALANCES, basis: FIGURE_BASIS.GROSS,  label: 'Supplier retention still held', note: 'Withheld and not yet released — not payable until released', open: true },
]

export const FINAL_ACCOUNT_FIGURE_KEYS = FINAL_ACCOUNT_FIGURES.map(f => f.key)
export const FINAL_ACCOUNT_ROW_KEYS = ['costCodeId', 'costCodeName', 'approvedBudget', 'actualCost', 'variance']
export const FINAL_ACCOUNT_OPEN_KEYS = FINAL_ACCOUNT_FIGURES.filter(f => f.open).map(f => f.key)

// The registers whose record counts are stored as provenance.
export const FINAL_ACCOUNT_COUNTED_SOURCES = [
  'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'variations',
  'forecastLines', 'supplierPayments', 'retentionReleases', 'clientInvoices', 'clientReceipts',
]

// ── Readiness ────────────────────────────────────────────────────────────────

export const BLOCKER = {
  SOURCES:              'sources',
  CONTRACT:             'contract',
  BUDGET:               'budget',
  CLIENT_VARIATIONS:    'clientVariations',
  SUPPLIER_VARIATIONS:  'supplierVariations',
  UNAPPLIED_VARIATIONS: 'unappliedVariations',
  OPEN_CLAIMS:          'openClaims',
  CLAIMS_AWAITING:      'claimsAwaitingInvoice',
  UNPOSTED_INVOICES:    'unpostedInvoices',
  DRAFT_CLIENT_INVOICES: 'draftClientInvoices',
  DRAFT_RECEIPTS:       'draftReceipts',
  DRAFT_PAYMENTS:       'draftPayments',
  DRAFT_CREDIT_NOTES:   'draftCreditNotes',
  DRAFT_RELEASES:       'draftReleases',
  OVER_ALLOCATED:       'overAllocatedInvoices',
  COST_TO_COMPLETE:     'costToComplete',
  FIGURES:              'figures',
  SIZE:                 'size',
}

// One line per requirement, in the order the checklist shows them.
export const READINESS_CHECKS = [
  { code: BLOCKER.SOURCES,              label: 'Every financial record loaded',            fix: 'Reload the page. A figure that cannot be read is never treated as zero.' },
  { code: BLOCKER.CONTRACT,             label: 'Original contract sum set',                fix: 'Set the contract value on the Commercial tab.' },
  { code: BLOCKER.BUDGET,               label: 'Budget approved',                          fix: 'Approve a budget version on the Budget tab. A working or unavailable budget cannot be finalised.' },
  { code: BLOCKER.CLIENT_VARIATIONS,    label: 'No draft or submitted client variations',  fix: 'Approve, reject or withdraw each one on the Variations tab.' },
  { code: BLOCKER.SUPPLIER_VARIATIONS,  label: 'No draft or submitted supplier variations', fix: 'Approve, reject or withdraw each one on the Variations tab.' },
  { code: BLOCKER.UNAPPLIED_VARIATIONS, label: 'No approved supplier variation left out of cost', fix: 'Apply or commit each approved supplier variation so its value is inside Final cost.' },
  { code: BLOCKER.OPEN_CLAIMS,          label: 'No draft, submitted or under-review progress claims', fix: 'Approve or reject each open claim.' },
  { code: BLOCKER.CLAIMS_AWAITING,      label: 'No approved claim awaiting its supplier invoice', fix: 'Post the supplier invoice for each approved claim.' },
  { code: BLOCKER.UNPOSTED_INVOICES,    label: 'No unposted supplier invoices',            fix: 'Post or cancel each draft or approved supplier invoice.' },
  { code: BLOCKER.DRAFT_CLIENT_INVOICES, label: 'No draft client invoices',                fix: 'Issue or void each draft client invoice.' },
  { code: BLOCKER.DRAFT_RECEIPTS,       label: 'No draft client receipts',                 fix: 'Post or void each draft receipt.' },
  { code: BLOCKER.DRAFT_PAYMENTS,       label: 'No draft supplier payments',               fix: 'Post or void each draft payment.' },
  { code: BLOCKER.DRAFT_CREDIT_NOTES,   label: 'No draft supplier credit notes',           fix: 'Post or void each draft credit note.' },
  { code: BLOCKER.DRAFT_RELEASES,       label: 'No draft retention releases',              fix: 'Post or void each draft retention release.' },
  { code: BLOCKER.OVER_ALLOCATED,       label: 'No over-allocated issued client invoices', fix: 'An issued client invoice has more receipt allocated to it than its gross value. Correct the receipt allocation on the Client Receipts tab (void the receipt and re-enter it) so no invoice is over-allocated. Nothing is reallocated automatically.' },
  { code: BLOCKER.COST_TO_COMPLETE,     label: 'Cost to complete is zero',                 fix: 'Close out remaining commitment (a closing supplier variation on each under-run purchase order line) and set every uncommitted cost to complete to zero on the Forecast tab.' },
  { code: BLOCKER.FIGURES,              label: 'Every figure is a valid amount',           fix: 'A figure could not be calculated from the records. Check SHIELD for integrity findings.' },
  { code: BLOCKER.SIZE,                 label: 'Within the size of one record',            fix: 'This project has more cost codes than one Final Account record can hold.' },
]

const isMoney = (v) => typeof v === 'number' && Number.isFinite(v)
const SETTLED = { loading: false, error: false }

// Every report source settled without error — the state the SERVER passes,
// because it only reaches the calculation after each read has succeeded.
export const settledSourceStates = () => Object.fromEntries(REPORT_SOURCES.map(s => [s, SETTLED]))

const pick = (items, key) => {
  const f = items.find(i => i.key === key)?.figure
  return f && f.state === FIGURE_STATE.READY && f.value !== undefined ? f.value : null
}

const countWhere = (list, test) => (list ?? []).filter(test).length

// ── THE computation ──────────────────────────────────────────────────────────
//
// `sources` / `sourceStates` exactly as buildCommercialReport takes them (the
// approved-budget composite MUST be read with `original: true` semantics or
// not — the Final Account does not read the original). Returns the figures,
// the cost-code rows, the provenance, the readiness blockers and the open
// items. `figures` is null whenever a figure is not a valid amount: a Final
// Account is never built from a partial set.
export function computeFinalAccount({ project = null, currencyCode, sources = {}, sourceStates = {} } = {}) {
  const {
    budgetLines = [], approvedBudget = null, purchaseOrders = [], progressClaims = [],
    supplierInvoices = [], supplierCreditNotes = [], variations = [], forecastLines = [],
    supplierPayments = [], retentionReleases = [], clientInvoices = [], clientReceipts = [], costCodes = [],
  } = sources

  const report = buildCommercialReport({ project, currencyCode, sources, sourceStates })
  // Cost codes carry names only, so the report does not gate on them; a Final
  // Account stores those names, so a CLIENT that passes their read state is
  // held until they have loaded. (The server reads them itself.)
  const cc = sourceStates?.costCodes
  const namesLoading = cc?.loading === true
  const namesFailed = cc?.error === true
  const loading = report.loading === true || namesLoading
  const failedSources = namesFailed ? [...report.failedSources, 'costCodes'] : report.failedSources
  const sourcesReady = !loading && failedSources.length === 0

  const budgetSource = resolveBudgetSource({
    approvedBudget, budgetLines,
    budgetLinesLoading: sourceStates?.budgetLines?.loading === true,
    budgetLinesError: sourceStates?.budgetLines?.error === true,
    currencyCode,
  })
  const budgetApproved = budgetSource.kind === BUDGET_SOURCE.APPROVED
  const totals = projectForecastTotals({
    costCodes, budgetLines: budgetLinesFor(budgetSource), purchaseOrders, progressClaims,
    supplierInvoices, supplierCreditNotes, variations, forecastLines,
  })

  const finalContractSum = pick(report.summary, 'currentContractSum')
  const control = contractControl(clientInvoices, finalContractSum)
  const receivables = receivablesSummary(clientInvoices, clientReceipts)
  const receipts = receiptSummary(clientReceipts)
  const payments = paymentSummary(supplierPayments)
  const retention = retentionSummary(supplierInvoices, retentionReleases)

  const raw = {
    originalContractValue:     pick(report.summary, 'originalContractValue'),
    approvedClientVariations:  pick(report.variations, 'approvedClientVariations'),
    finalContractSum,
    invoicedToClient:          control.issued.subtotal,
    remainingToInvoice:        finalContractSum === null ? null : control.availableToInvoice,
    approvedBudget:            budgetApproved ? pick(report.summary, 'approvedBudget') : null,
    approvedSupplierVariations: pick(report.variations, 'approvedSupplierVariations'),
    actualCost:                pick(report.summary, 'actual'),
    costToComplete:            pick(report.summary, 'costToComplete'),
    finalCost:                 pick(report.summary, 'forecastFinalCost'),
    varianceToBudget:          budgetApproved ? pick(report.summary, 'varianceToBudget') : null,
    finalProfit:               pick(report.summary, 'forecastGrossProfit'),
    finalMarginPct:            pick(report.summary, 'forecastMarginPct'),
    invoicedToClientGross:     control.issued.grossTotal,
    receivedAgainstInvoices:   receivables.received,
    receivablesOutstanding:    pick(report.cash, 'receivablesOutstanding'),
    cashReceived:              pick(report.cash, 'cashIn'),
    unallocatedReceipts:       receipts.unallocated,
    cashPaid:                  pick(report.cash, 'cashOut'),
    payablesOutstanding:       pick(report.cash, 'remainingPayable'),
    unallocatedPayments:       payments.unallocated,
    retentionHeld:             retention.retentionHeld,
  }
  const figuresValid = sourcesReady && FINAL_ACCOUNT_FIGURES.every(f => isMoney(raw[f.key]) || (f.nullable && raw[f.key] === null))
  const figures = figuresValid ? raw : null

  const table = report.costCodes
  const rows = table.state === FIGURE_STATE.READY
    ? table.rows.map(r => ({
        costCodeId:     String(r.costCodeId),
        costCodeName:   String(r.costCodeName ?? '').slice(0, FINAL_ACCOUNT_LIMITS.NAME),
        approvedBudget: r.approvedBudget ?? null,
        actualCost:     r.actual,
        variance:       r.varianceToBudget ?? null,
      }))
    : []
  const rowsOpen = table.state === FIGURE_STATE.READY
    ? table.rows.filter(r => toCents(r.costToComplete) !== 0).length
    : 0

  const counts = {
    clientVariations:    countWhere(variations, v => v.variationType === VARIATION_TYPE.CLIENT && VARIATION_PENDING_STATUSES.includes(v.status)),
    supplierVariations:  countWhere(variations, v => v.variationType === VARIATION_TYPE.SUPPLIER && VARIATION_PENDING_STATUSES.includes(v.status)),
    openClaims:          countWhere(progressClaims, c => CLAIM_OPEN_STATUSES.includes(c.status)),
    unpostedInvoices:    countWhere(supplierInvoices, i => [SI_STATUS.DRAFT, SI_STATUS.RECEIVED, SI_STATUS.UNDER_REVIEW, SI_STATUS.APPROVED, SI_STATUS.DISPUTED].includes(i.status)),
    draftClientInvoices: draftClientInvoices(clientInvoices).length,
    draftReceipts:       receipts.draftCount,
    draftPayments:       payments.draftCount,
    draftCreditNotes:    draftSupplierCreditNotes(supplierCreditNotes).length,
    draftReleases:       draftRetentionReleases(retentionReleases).length,
  }
  // Issued client invoices whose posted receipt allocations EXCEED the invoice's
  // gross value — the rows of the existing receivables selector, compared in
  // whole cents. Such an invoice's negative balance is never netted into
  // Client invoices outstanding (lib/clientReceipts.js), so the receivables
  // position does not reconcile until the allocation is corrected.
  const overAllocated = receivables.rows.filter(r => toCents(r.received) > toCents(r.grossTotal))
  const unapplied = pick(report.variations, 'unappliedSupplierVariations')
  const awaiting = roundMoney(totals.approvedClaimsAwaitingInvoice)

  const blockers = []
  const block = (code, detail = '') => blockers.push({ code, detail })
  if (!sourcesReady) block(BLOCKER.SOURCES, loading ? 'Still loading' : `Could not load: ${failedSources.map(s => REPORT_SOURCE_LABELS[s] ?? (s === 'costCodes' ? 'Cost Codes' : s)).join(', ')}`)
  if (sourcesReady) {
    if (report.contractNotEstablished || !isMoney(raw.originalContractValue)) block(BLOCKER.CONTRACT)
    if (!budgetApproved) block(BLOCKER.BUDGET, budgetSource.kind === BUDGET_SOURCE.WORKING ? 'Working budget (not approved)' : 'Approved budget unavailable')
    if (counts.clientVariations > 0) block(BLOCKER.CLIENT_VARIATIONS, `${counts.clientVariations} open`)
    if (counts.supplierVariations > 0) block(BLOCKER.SUPPLIER_VARIATIONS, `${counts.supplierVariations} open`)
    if (unapplied === null || toCents(unapplied) !== 0) block(BLOCKER.UNAPPLIED_VARIATIONS)
    if (counts.openClaims > 0) block(BLOCKER.OPEN_CLAIMS, `${counts.openClaims} open`)
    if (toCents(awaiting) !== 0) block(BLOCKER.CLAIMS_AWAITING)
    if (counts.unpostedInvoices > 0) block(BLOCKER.UNPOSTED_INVOICES, `${counts.unpostedInvoices} unposted`)
    if (counts.draftClientInvoices > 0) block(BLOCKER.DRAFT_CLIENT_INVOICES, `${counts.draftClientInvoices} draft`)
    if (counts.draftReceipts > 0) block(BLOCKER.DRAFT_RECEIPTS, `${counts.draftReceipts} draft`)
    if (counts.draftPayments > 0) block(BLOCKER.DRAFT_PAYMENTS, `${counts.draftPayments} draft`)
    if (counts.draftCreditNotes > 0) block(BLOCKER.DRAFT_CREDIT_NOTES, `${counts.draftCreditNotes} draft`)
    if (counts.draftReleases > 0) block(BLOCKER.DRAFT_RELEASES, `${counts.draftReleases} draft`)
    if (overAllocated.length > 0) {
      const names = overAllocated.slice(0, 5).map(r => r.invoiceNumber || r.id).join(', ')
      block(BLOCKER.OVER_ALLOCATED, `${overAllocated.length} over-allocated: ${names}${overAllocated.length > 5 ? ', …' : ''}`)
    }
    if (raw.costToComplete === null || toCents(raw.costToComplete) !== 0 || rowsOpen > 0
      || raw.finalCost === null || raw.actualCost === null || toCents(raw.finalCost) !== toCents(raw.actualCost)) block(BLOCKER.COST_TO_COMPLETE)
    if (!figuresValid) block(BLOCKER.FIGURES)
    if (rows.length > FINAL_ACCOUNT_LIMITS.ROWS) block(BLOCKER.SIZE, `${rows.length} cost codes`)
  }

  const provenance = {
    budgetApprovalId: budgetApproved ? (budgetSource.pointer?.activeApprovalId ?? null) : null,
    budgetVersion:    budgetApproved ? (budgetSource.version ?? null) : null,
    adjustmentCount:  budgetApproved ? (budgetSource.adjustmentCount ?? 0) : 0,
    budgetCaption:    budgetApproved ? `Approved version ${approvedVersionCaption(budgetSource)}` : '',
    counts: Object.fromEntries(FINAL_ACCOUNT_COUNTED_SOURCES.map(s => [s, (sources[s] ?? []).length])),
  }

  return {
    currencyCode,
    loading,
    sourcesReady,
    failedSources,
    figures,
    partialFigures: raw,
    rows,
    provenance,
    blockers,
    ready: blockers.length === 0,
    openItems: figures ? openItemsOf(figures) : [],
  }
}

// The recognised outstanding balances of a figure set — every one listed with
// its amount (a genuine zero included), so the acknowledgement names them all.
export function openItemsOf(figures) {
  return FINAL_ACCOUNT_FIGURES.filter(f => f.open).map(f => ({ key: f.key, label: f.label, basis: f.basis, value: figures?.[f.key] ?? null }))
}

export const blockerCodes = (computation) => (computation?.blockers ?? []).map(b => b.code)

// The checklist: one row per requirement with its state.
export function readinessChecklist(computation) {
  const failed = new Map((computation?.blockers ?? []).map(b => [b.code, b.detail]))
  const pending = !computation || computation.loading
  return READINESS_CHECKS.map(c => ({
    ...c,
    state: pending ? 'pending' : failed.has(c.code) ? 'blocked' : (failed.has(BLOCKER.SOURCES) ? 'unknown' : 'ok'),
    detail: failed.get(c.code) ?? '',
  }))
}

// ── Draft input ──────────────────────────────────────────────────────────────

export function normaliseFinalAccountInput(input = {}) {
  return { reason: String(input.reason ?? '').trim(), reference: String(input.reference ?? '').trim() }
}

export function validateFinalAccountInput(input = {}) {
  const { reason, reference } = normaliseFinalAccountInput(input)
  if (!reason) return 'Enter the basis for this Final Account.'
  if (reason.length > FINAL_ACCOUNT_LIMITS.REASON) return `The basis must be ${FINAL_ACCOUNT_LIMITS.REASON} characters or fewer.`
  if (reference.length > FINAL_ACCOUNT_LIMITS.REFERENCE) return `The reference must be ${FINAL_ACCOUNT_LIMITS.REFERENCE} characters or fewer.`
  if (input.acknowledged !== true) return 'Acknowledge the outstanding balances before preparing the draft.'
  return null
}

export function validateFinalAccountWithdrawReason(reason) {
  const r = String(reason ?? '').trim()
  if (!r) return 'Enter a reason for withdrawing this draft.'
  if (r.length > FINAL_ACCOUNT_LIMITS.REASON) return `The reason must be ${FINAL_ACCOUNT_LIMITS.REASON} characters or fewer.`
  return null
}

// A conservative Firestore size estimate (field names + values + per-entry
// overhead), the lib/budgetApproval.js method.
const utf8 = (s) => {
  let n = 0
  for (const ch of String(s)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4 }
  return n
}
function sizeOf(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return 1
  if (typeof v === 'number') return 8
  if (typeof v === 'string') return utf8(v) + 1
  if (Array.isArray(v)) return v.reduce((s, e) => s + sizeOf(e), 0)
  if (typeof v === 'object') return 32 + Object.entries(v).reduce((s, [k, e]) => s + utf8(k) + 1 + sizeOf(e), 0)
  return 8
}
export const estimateFinalAccountBytes = (payload) => 512 + sizeOf(payload)

// The financial content of a record — what the callable overwrites with its
// own computation and what a draft is compared on.
export function finalAccountContent(computation) {
  return {
    figures:  { ...computation.figures },
    rows:     computation.rows.map(r => ({ ...r })),
    rowCount: computation.rows.length,
    sources:  { ...computation.provenance, counts: { ...computation.provenance.counts } },
  }
}

// The draft document body (stamps and lifecycle keys are added by the action).
// Refuses — never truncates — when the computation is not ready or too large.
export function buildFinalAccountDraft({ computation, number, input, currencyCode, preparedByName = '' }) {
  if (!Number.isInteger(number) || number < 1) return { ok: false, error: 'The revision number is not valid.' }
  const invalid = validateFinalAccountInput(input)
  if (invalid) return { ok: false, error: invalid }
  if (!computation?.ready || !computation.figures) {
    return { ok: false, error: 'The Final Account is not ready. Resolve every item on the readiness checklist first.', blockers: blockerCodes(computation) }
  }
  const { reason, reference } = normaliseFinalAccountInput(input)
  const payload = {
    number, reason, reference, currency: currencyCode,
    ...finalAccountContent(computation),
    openItemsAcknowledged: true,
    preparedByName: String(preparedByName ?? '').slice(0, FINAL_ACCOUNT_LIMITS.NAME),
  }
  const bytes = estimateFinalAccountBytes(payload)
  if (bytes > FINAL_ACCOUNT_MAX_BYTES) return { ok: false, error: 'This Final Account is too large for one record. Nothing was written and nothing was truncated.', bytes }
  return { ok: true, payload, bytes }
}

// ── Comparison: a stored record against a fresh computation ──────────────────
//
// Whole-cent equality on every figure and every row, in order. Used three
// ways: the callable refuses a draft that disagrees with its own figures; the
// page marks a draft STALE; and an approved revision shows what has moved in
// the live records since — the frozen figures themselves are never changed.

const sameAmount = (a, b) => (a === null || a === undefined || b === null || b === undefined)
  ? (a ?? null) === (b ?? null)
  : toCents(a) === toCents(b)

export function finalAccountDifferences(stored, computation) {
  if (!stored || !computation) return { comparable: false, figures: [], rows: [], provenance: [], changed: false }
  if (!computation.sourcesReady) return { comparable: false, figures: [], rows: [], provenance: [], changed: false }
  const live = computation.partialFigures ?? {}
  const figures = []
  for (const f of FINAL_ACCOUNT_FIGURES) {
    const a = stored.figures?.[f.key]
    const b = live[f.key]
    if (!sameAmount(a, b)) figures.push({ key: f.key, label: f.label, basis: f.basis, stored: a ?? null, live: b ?? null })
  }
  const rows = []
  const storedById = new Map((stored.rows ?? []).map(r => [r.costCodeId, r]))
  const liveById = new Map((computation.rows ?? []).map(r => [r.costCodeId, r]))
  for (const id of new Set([...storedById.keys(), ...liveById.keys()])) {
    const a = storedById.get(id)
    const b = liveById.get(id)
    if (!a || !b || !sameAmount(a.approvedBudget, b.approvedBudget) || !sameAmount(a.actualCost, b.actualCost) || !sameAmount(a.variance, b.variance)) {
      rows.push({ costCodeId: id, costCodeName: (b ?? a).costCodeName, stored: a ?? null, live: b ?? null })
    }
  }
  const provenance = []
  const sp = stored.sources ?? {}
  const lp = computation.provenance ?? {}
  if ((sp.budgetApprovalId ?? null) !== (lp.budgetApprovalId ?? null) || (sp.budgetVersion ?? null) !== (lp.budgetVersion ?? null)
    || (sp.adjustmentCount ?? 0) !== (lp.adjustmentCount ?? 0)) provenance.push('budget')
  for (const s of FINAL_ACCOUNT_COUNTED_SOURCES) {
    if ((sp.counts?.[s] ?? null) !== (lp.counts?.[s] ?? null)) provenance.push(s)
  }
  return { comparable: true, figures, rows, provenance, changed: figures.length > 0 || rows.length > 0 }
}

// The strict agreement the callable requires before it finalises a draft: the
// same figures, the same rows in the same order, the same budget version.
export function draftAgreesWith(stored, computation) {
  if (!stored || !computation?.figures) return false
  const d = finalAccountDifferences(stored, computation)
  if (!d.comparable || d.changed) return false
  if ((stored.rows ?? []).length !== computation.rows.length) return false
  if (!computation.rows.every((r, i) => stored.rows[i]?.costCodeId === r.costCodeId)) return false
  return !d.provenance.includes('budget')
}

// ── History ──────────────────────────────────────────────────────────────────

const byNumber = (a, b) => (a.number ?? 0) - (b.number ?? 0)

export const isFinalAccountRecord = (a) =>
  !!a && Number.isInteger(a.number) && a.number >= 1 && Object.values(FINAL_ACCOUNT_STATUS).includes(a.status)

// The CURRENT Final Account is the highest-numbered APPROVED revision. Earlier
// approved revisions are SUPERSEDED — a derived label; their documents are
// never written again.
export function finalAccountHistory(accounts) {
  const list = (accounts ?? []).filter(isFinalAccountRecord).slice().sort(byNumber)
  const approved = list.filter(a => a.status === FINAL_ACCOUNT_STATUS.APPROVED)
  const current = approved.length ? approved[approved.length - 1] : null
  const draft = list.find(a => a.status === FINAL_ACCOUNT_STATUS.DRAFT) ?? null
  const latest = list.length ? list[list.length - 1] : null
  return {
    list: list.slice().reverse().map(a => ({
      ...a,
      superseded: a.status === FINAL_ACCOUNT_STATUS.APPROVED && current !== null && a.number < current.number,
      current: current !== null && a.number === current.number,
    })),
    current,
    draft,
    nextNumber: (latest?.number ?? 0) + 1,
    canPrepare: draft === null,
  }
}

export const finalAccountRevisionLabel = (a) => `Revision ${a?.number ?? '—'}`
