#!/usr/bin/env node
// ── Phase 2 (Commercial Completion) cutover inventory — READ-ONLY ─────────────
//
// READ-ONLY. This script sends exactly ONE kind of request to the Firestore
// REST API and nothing else:
//   · POST …/documents:runQuery   — a collection-group read, paged by name
// It never writes, deletes, creates, restores or activates anything. It loads
// no SDK and no credential file: in production it authenticates as the
// operator through `gcloud auth print-access-token` (IAM, not Security Rules,
// exactly as ops/recovery/firestore-count-evidence.mjs); against the local
// emulator it sends the emulator's administrative bearer `owner`.
//
// It prints IDS, COUNTS, COUNTER VALUES and PROBLEM CODES only — never a name,
// a description, a reference, a note, an amount or a document number from
// any document. Problem messages produced by the domain bundles (which can
// name a cost code) are reduced to stable codes before anything is printed.
//
// What it answers, per company and project, before the Phase 2 cutover
// (docs/DEPLOYMENT.md → Phase 2 — the complete cutover → Stage A):
//   · company activation state — clientFinanceEnabled, clientReceiptsEnabled,
//     commercialCompletionEnabled, and the approval policy (absent / disabled
//     / enabled / malformed)
//   · historical VARIATIONS — calculation versions (legacy = calcVersion
//     absent), and every draft / submitted / approved-unapplied variation the
//     backend would REFUSE, re-checked with the backend's own verification
//     functions (generated/variationCalc.js: submittedSideProblem,
//     approvedSideProblem, lineSources, commitmentApplyEligibility)
//   · historical PROGRESS CLAIMS — open claims per PO above one, malformed
//     certified amounts, legacy and malformed invoice-link keys, submitted
//     claims the approval would refuse (claimSubmittedSideProblem)
//   · SUPPLIER INVOICES whose stored obligation does not reconcile
//     (supplierInvoiceFigures, invoiceStoredProblem, postPairingProblem), and
//     invoices in a status the backend has no transition from
//   · the SUPPLIER BASELINE PREVIEW — supplierLedgersFromHistory and
//     poClaimLedgersFromHistory run here, read-only, exactly as the first
//     supplier-finance operation will run them: would it establish or refuse,
//     and which invoice / PO ledgers would it mark inconsistent, and why
//   · baseline SOURCE integrity — every posted payment allocation, credit
//     note and retention release that cannot be attributed to an invoice
//   · CLIENT SETTLEMENT state — refunds, receipt applications and receipt
//     ledgers (empty before the cutover), receipt-baseline markers (Phase 1)
//   · COUNTERS — each Phase 2 counter's `next` against the highest number of
//     its type, and DUPLICATE document numbers per company and type
//   · INDEPENDENT RECONCILIATION (after activation) — for a project whose
//     supplier baseline is `complete`, every stored invoice ledger and PO claim
//     ledger is compared, to the cent, with the same ledgers recomputed here
//     from the registers; any difference is listed by ledger id and figure name
//   · server state already present — supplier baseline markers (and any left
//     `building` past their lease), ledgers, estimates (and any left
//     `building` past their lease), contract-value revisions, project
//     baselines without a numeric original contract value
//
// Usage (from the repository root):
//
//   node ops/recovery/phase2-inventory.mjs --project constrapp-69b5d [--company <id>] [--summary] > phase2-inventory.json
//   node ops/recovery/phase2-inventory.mjs --project demo-constrap-test --emulator 127.0.0.1:8080
//
// --project has NO default. --emulator is accepted ONLY with a `demo-`
// project, and a `demo-` project is accepted ONLY with --emulator, so a real
// project is never read through the emulator flag and the emulator is never
// mistaken for production. --company restricts the REPORT (not the read) to
// one company. --summary prints the totals and the finding codes only.
//
// Exit code: 0 read complete, no finding · 1 read complete, findings listed
// · 2 usage error · 3 read failure (nothing is partially reported).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import * as sf from '../../frontend/functions/src/generated/supplierFinanceCalc.js'
import * as vc from '../../frontend/functions/src/generated/variationCalc.js'
import * as ec from '../../frontend/functions/src/generated/estimatingCalc.js'

// ── What is read ─────────────────────────────────────────────────────────────
// Collection groups, each with its field projection (null = whole document:
// the domain functions need the stored lines). Only ids, counts and codes
// derived from these are ever printed.
export const READ_PLAN = {
  companies: ['clientFinanceEnabled', 'clientReceiptsEnabled', 'commercialCompletionEnabled'],
  projects: ['__name__'],
  approvalPolicy: ['segregationEnabled'],
  counters: ['next'],
  costCodes: ['__name__'],
  purchaseOrders: ['status', 'lineItems', 'lastMaterialEditBy'],
  // Stage A additions (architect decisions D3 #53 / #54): BOQ size and text
  // against the estimate bounds, estimate provenance on budget lines, and open
  // POs / tender packages with no recorded preparer. Text is READ to measure its
  // length only — never printed.
  tenderPackages: ['status', 'lastMaterialEditBy'],
  boqItems: ['status', 'itemNumber', 'section', 'description', 'costCodeName', 'unit', 'costCodeId'],
  budgetLines: ['boqSource'],
  variations: null,
  progressClaims: null,
  supplierInvoices: null,
  supplierCreditNotes: null,
  retentionReleases: null,
  supplierPayments: null,
  supplierFinanceState: ['state', 'leaseUntilMillis', 'attempt'],
  supplierInvoiceLedgers: null,
  poClaimLedgers: null,
  clientFinanceState: ['version'],
  clientRefunds: ['status'],
  clientReceiptApplications: ['status'],
  clientReceiptLedgers: ['__name__'],
  estimates: ['state', 'runStartedAt'],
  estimateState: ['__name__'],
  contractValueRevisions: ['status'],
  commercial: ['originalContractValue'],
}

// The Phase 2 counters (companies/{c}/counters/{id}) and the register, the
// number field and the number prefix each one issues.
export const COUNTERS = [
  { counter: 'variationsClient', register: 'variations', field: 'variationNumber', prefix: 'CV', where: (d) => d.variationType === 'client' },
  { counter: 'variationsSupplier', register: 'variations', field: 'variationNumber', prefix: 'SV', where: (d) => d.variationType === 'supplier' },
  { counter: 'progressClaims', register: 'progressClaims', field: 'claimNumber', prefix: 'PC' },
  { counter: 'supplierInvoices', register: 'supplierInvoices', field: 'invoiceNumber', prefix: 'SI' },
  { counter: 'supplierCreditNotes', register: 'supplierCreditNotes', field: 'creditNumber', prefix: 'SCN' },
  { counter: 'retentionReleases', register: 'retentionReleases', field: 'releaseNumber', prefix: 'RR' },
  { counter: 'supplierPayments', register: 'supplierPayments', field: 'paymentNumber', prefix: 'SP' },
  { counter: 'clientRefunds', register: 'clientRefunds', field: 'refundNumber', prefix: 'CRF' },
  { counter: 'clientReceiptApplications', register: 'clientReceiptApplications', field: 'applicationNumber', prefix: 'CRA' },
]
export const COUNTER_MAX = 999_999_999
// Lease lengths of the backend's own runs (supplierFinance/baseline.js,
// estimating/operations.js): a marker older than this is abandoned work.
export const SUPPLIER_BASELINE_LEASE_MS = 150_000
export const ESTIMATE_BUILD_LEASE_MS = 180_000

// ── Arguments ────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--summary') { out.summary = true; continue }
    if (!['--project', '--emulator', '--company'].includes(key)) throw new Error(`Unknown argument: ${key}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`)
    out[key.slice(2)] = value
    i += 1
  }
  if (!out.project) throw new Error('--project is required (it has no default)')
  if (!/^[a-z][a-z0-9-]{4,40}$/.test(out.project)) throw new Error('--project must be a Firebase project id')
  const demo = out.project.startsWith('demo-')
  if (out.emulator && !demo) throw new Error('--emulator is accepted only with a demo- project; a real project is never read through it')
  if (demo && !out.emulator) throw new Error('a demo- project exists only in the emulator: give --emulator <host:port>')
  if (out.emulator && !/^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(out.emulator)) throw new Error('--emulator must be a local host:port, e.g. 127.0.0.1:8080')
  if (out.company && !/^[A-Za-z0-9_-]{1,64}$/.test(out.company)) throw new Error('--company must be a company document id')
  return out
}

// ── Firestore REST values → plain values (what the Admin SDK would return) ──
export class StoredTimestamp {
  constructor(iso) { this.iso = iso; Object.freeze(this) }
  toMillis() { return Date.parse(this.iso) }
}

export function decodeValue(v) {
  if (v === undefined || v === null) return undefined
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('stringValue' in v) return v.stringValue
  if ('timestampValue' in v) return new StoredTimestamp(v.timestampValue)
  if ('referenceValue' in v) return v.referenceValue
  if ('bytesValue' in v) return v.bytesValue
  if ('geoPointValue' in v) return { ...v.geoPointValue }
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue)
  if ('mapValue' in v) return decodeFields(v.mapValue.fields)
  return undefined
}

export const decodeFields = (fields) => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decodeValue(v)]))

// `…/documents/companies/c/projects/p/variations/v` → its segments.
export function scopeOf(name) {
  const rel = String(name).split('/documents/')[1] ?? ''
  const s = rel.split('/')
  if (s[0] !== 'companies' || !s[1]) return null
  if (s.length === 2) return { companyId: s[1], projectId: null, collection: 'companies', id: s[1] }
  if (s.length === 4) return { companyId: s[1], projectId: s[2] === 'projects' ? s[3] : null, collection: s[2], id: s[3] }
  if (s.length === 6 && s[2] === 'projects') return { companyId: s[1], projectId: s[3], collection: s[4], id: s[5] }
  return null
}

// ── Problem messages → stable codes (no text from a document survives) ───────
const MESSAGE_CODES = [
  [/stores allocations that are not a list/, 'payment-allocations-not-a-list'],
  [/has an allocation naming no invoice/, 'payment-allocation-names-no-invoice'],
  [/allocation that is not a positive whole number of cents/, 'payment-allocation-not-positive-whole-cents'],
  [/is a posted credit note naming no invoice/, 'credit-names-no-invoice'],
  [/is a posted release naming no invoice/, 'release-names-no-invoice'],
  [/stores a negative figure/, 'credit-negative-figure'],
  [/release amount that is not positive/, 'release-not-positive'],
  [/name an invoice that does not exist/, 'invoice-missing'],
  [/line with no cost code or tax code/, 'invoice-line-without-cost-or-tax-code'],
  [/totals that do not reconcile to its own lines/, 'invoice-totals-not-reconciled'],
  [/retention outside its subtotal/, 'invoice-retention-outside-subtotal'],
  [/payable total that does not reconcile/, 'invoice-payable-not-reconciled'],
  [/negative line group/, 'invoice-negative-line-group'],
  [/would not be a whole, non-negative number of cents/, 'ledger-figure-not-whole-cents'],
  [/the invoice does not carry/, 'credit-on-unknown-group'],
  [/credited figures of .* would not be whole/, 'credit-group-not-whole-cents'],
  [/^Credits on .* exceed the invoiced amount/, 'over-credit'],
  [/^Credited GST on .* exceeds/, 'over-credit-gst'],
  [/credited totals do not equal the credited groups/, 'credit-totals-not-groups'],
  [/^Retention released and credited together exceed/, 'over-release'],
  [/^Retention GST released and credited together exceed/, 'over-release-gst'],
  [/retention part of the credits exceeds the credits/, 'retention-credit-exceeds-credit'],
  [/names no purchase order/, 'claim-names-no-po'],
  [/certified amount that is not whole/, 'certified-not-whole-cents'],
  [/variation line with no line index/, 'claim-variation-line-without-index'],
  [/line with no purchase-order line/, 'claim-line-without-po-line'],
  [/Several claims are open on this purchase order/, 'several-open-claims'],
]
export function messageCode(message) {
  if (typeof message !== 'string' || message === '') return 'unknown'
  for (const [re, code] of MESSAGE_CODES) if (re.test(message)) return code
  return `unclassified-${createHash('sha256').update(message).digest('hex').slice(0, 8)}`
}

// The refusal a domain problem becomes (supplierFinance/context.js PROBLEM_CODE).
const PROBLEM_REFUSAL = {
  'figures-inconsistent': 'supplier-finance-figures-inconsistent',
  'not-reconciled': 'supplier-finance-figures-inconsistent',
  'ledger-inconsistent': 'supplier-finance-ledger-inconsistent',
  'out-of-range': 'supplier-finance-out-of-range',
  'open-claim': 'supplier-finance-open-claim',
  'not-linked': 'supplier-finance-not-linked',
  'legacy-claim': 'supplier-finance-legacy-claim',
  'already-invoiced': 'supplier-finance-already-invoiced',
  'claim-stale': 'supplier-finance-stale',
}
const refusalOf = (problem) => PROBLEM_REFUSAL[problem] ?? 'supplier-finance-invalid'

// ── Analysis (pure: no I/O) ──────────────────────────────────────────────────
const tally = (o, k) => { o[k] = (o[k] ?? 0) + 1; return o }
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
const withId = (d) => ({ ...d.data, id: d.id })
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const isDateOrEmpty = (v) => typeof v === 'string' && (v === '' || DATE_RE.test(v))
const millisOf = (v) => (v instanceof StoredTimestamp ? v.toMillis() : typeof v === 'number' ? v : null)
const sequenceOf = (number, prefix) => {
  const m = typeof number === 'string' ? number.match(new RegExp(`^${prefix}-(\\d{1,12})$`)) : null
  return m ? Number(m[1]) : null
}

// What approveVariation / applyVariationCommitment / an unedited submit would
// refuse, in the backend's own order (variations/operations.js).
export function variationCheck(v, { po, costCodes }) {
  const version = vc.variationCalcVersion(v)
  const status = v.status
  if (status === vc.VARIATION_STATUS.DRAFT) {
    if (version === null) return { check: 'edit', refusal: 'variation-unsupported-record', reason: 'calc-version' }
    const p = vc.submittedSideProblem(v)
    return p ? { check: 'submit-unedited', refusal: 'variation-figures-inconsistent', reason: p } : null
  }
  if (vc.APPROVABLE_STATUSES.includes(status)) {
    if (version === null) return { check: 'approve', refusal: 'variation-unsupported-record', reason: 'calc-version' }
    if (!Array.isArray(v.lineItems) || v.lineItems.length < 1) return { check: 'approve', refusal: 'variation-unsupported-record', reason: 'lines' }
    if (!isDateOrEmpty(v.effectiveDate ?? '') || !isDateOrEmpty(v.approvedDate ?? '')) return { check: 'approve', refusal: 'variation-unsupported-record', reason: 'dates' }
    const p = vc.submittedSideProblem(v)
    if (p) return { check: 'approve', refusal: 'variation-figures-inconsistent', reason: p }
    if (!('poId' in v)) return { check: 'approve', refusal: 'variation-unsupported-record', reason: 'po-link' }
    let linkedPo = null
    if (v.poId !== null) {
      if (!vc.isPoLinkedSupplierVariation(v)) return { check: 'approve', refusal: 'variation-unsupported-record', reason: 'po-link' }
      linkedPo = po ?? null
      if (!vc.shouldApplyOnApproval(v, linkedPo)) return { check: 'approve', refusal: 'variation-po-invalid', reason: linkedPo ? `po-${linkedPo.status ?? 'no-status'}` : 'po-missing' }
    }
    const sources = vc.lineSources(v, { po: linkedPo, costCodes })
    return sources.ok ? null : { check: 'approve', refusal: 'variation-figures-inconsistent', reason: sources.reason }
  }
  if (status === vc.VARIATION_STATUS.APPROVED && vc.isPoLinkedSupplierVariation(v)) {
    const eligibility = vc.commitmentApplyEligibility(v, po ? [po] : [])
    if (!eligibility.eligible) {
      if (eligibility.blocker === vc.COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED) return null
      return { check: 'apply', refusal: 'variation-not-applicable', reason: eligibility.blocker }
    }
    if (version === null) return { check: 'apply', refusal: 'variation-unsupported-record', reason: 'calc-version' }
    const p = vc.approvedSideProblem(v)
    if (p) return { check: 'apply', refusal: 'variation-figures-inconsistent', reason: p }
    const sources = vc.lineSources(v, { po, costCodes })
    return sources.ok ? null : { check: 'apply', refusal: 'variation-figures-inconsistent', reason: sources.reason }
  }
  return null
}

const PENDING_INVOICE = [sf.SI_STATUS.DRAFT, sf.SI_STATUS.APPROVED]
const OBLIGATION_INVOICE = [sf.SI_STATUS.APPROVED, sf.SI_STATUS.POSTED, sf.SI_STATUS.PAID]
// Statuses no backend transition starts from (approve: draft; post: approved;
// cancel: draft, approved): such an invoice can be read but never progressed
// or cancelled through the backend.
const STRANDED_INVOICE = [sf.SI_STATUS.RECEIVED, sf.SI_STATUS.UNDER_REVIEW, sf.SI_STATUS.DISPUTED]

export function analyseProject(r, { companyId, projectId, costCodes, now }) {
  const findings = []
  const add = (severity, register, id, code, reason = null) => findings.push({ severity, companyId, projectId, register, id, code, ...(reason ? { reason } : {}) })
  const pos = new Map(r.purchaseOrders.map(d => [d.id, withId(d)]))
  const variations = r.variations.map(withId)
  const claims = r.progressClaims.map(withId)
  const claimsById = new Map(claims.map(c => [c.id, c]))
  const invoices = r.supplierInvoices.map(withId)
  const credits = r.supplierCreditNotes.map(withId)
  const releases = r.retentionReleases.map(withId)
  const payments = r.supplierPayments.map(withId)

  // Variations.
  const V = { total: variations.length, byStatus: {}, calcVersion: {} }
  for (const v of variations) {
    tally(V.byStatus, v.status ?? '(none)')
    const ver = vc.variationCalcVersion(v)
    tally(V.calcVersion, ver === null ? 'unknown' : v.calcVersion === undefined || v.calcVersion === null ? 'legacy-absent' : `v${ver}`)
    const po = typeof v.poId === 'string' ? pos.get(v.poId) ?? null : null
    const found = variationCheck(v, { po, costCodes })
    if (found) add(found.check === 'submit-unedited' ? 'review' : 'refuse', 'variations', v.id, found.refusal, `${found.check}:${found.reason}`)
  }

  // The supplier baseline, exactly as the first operation will compute it.
  const settlement = sf.supplierLedgersFromHistory({ invoices: new Map(invoices.map(i => [i.id, i])), creditNotes: credits, releases, payments })
  const claimLedgers = settlement.problem ? null : sf.poClaimLedgersFromHistory(claims)
  const missingSource = settlement.problem ?? claimLedgers?.problem ?? null
  const baseline = {
    outcome: missingSource ? 'would-refuse' : 'would-establish',
    ...(missingSource ? { refusal: 'supplier-finance-baseline-invalid', reason: messageCode(missingSource) } : {}),
    invoiceLedgers: settlement.ledgers?.size ?? 0,
    poClaimLedgers: claimLedgers?.ledgers?.size ?? 0,
    inconsistentInvoiceLedgers: [],
    inconsistentPoClaimLedgers: [],
  }
  if (missingSource) add('refuse', 'supplierFinanceBaseline', projectId, 'supplier-finance-baseline-invalid', messageCode(missingSource))
  for (const [invoiceId, e] of settlement.ledgers ?? []) {
    if (e.state !== 'inconsistent') continue
    const row = { invoiceId, reason: messageCode(e.problem), malformedEntries: e.malformedEntryIds.length + (e.malformedOverflow ? 1 : 0) }
    baseline.inconsistentInvoiceLedgers.push(row)
    add('inconsistent', 'supplierInvoiceLedgers', invoiceId, 'supplier-finance-ledger-inconsistent', row.reason)
  }
  for (const [poId, e] of claimLedgers?.ledgers ?? []) {
    if (e.state !== 'inconsistent') continue
    const row = { poId, reason: messageCode(e.problem), kind: e.problemKind }
    baseline.inconsistentPoClaimLedgers.push(row)
    add('inconsistent', 'poClaimLedgers', poId, 'supplier-finance-ledger-inconsistent', row.reason)
  }

  // Baseline source integrity: EVERY unattributable posted entry (the bundle
  // stops at the first one; this lists them all).
  const source = { postedPayments: 0, postedAllocations: 0, postedCredits: 0, postedReleases: 0, unattributable: 0 }
  for (const p of payments) {
    if (p.status !== sf.PAYMENT_STATUS.POSTED) continue
    source.postedPayments += 1
    if (p.allocations != null && !Array.isArray(p.allocations)) { source.unattributable += 1; add('refuse', 'supplierPayments', p.id, 'supplier-finance-baseline-invalid', 'payment-allocations-not-a-list'); continue }
    for (const a of p.allocations ?? []) {
      source.postedAllocations += 1
      if (typeof a?.supplierInvoiceId !== 'string' || a.supplierInvoiceId === '') { source.unattributable += 1; add('refuse', 'supplierPayments', p.id, 'supplier-finance-baseline-invalid', 'payment-allocation-names-no-invoice') } else if (typeof a.allocatedAmount !== 'number' || Math.abs(Math.round(a.allocatedAmount * 100) - a.allocatedAmount * 100) > 1e-6 || a.allocatedAmount <= 0) { source.unattributable += 1; add('refuse', 'supplierPayments', p.id, 'supplier-finance-baseline-invalid', 'payment-allocation-not-positive-whole-cents') }
    }
  }
  for (const [list, kind, key] of [[credits, 'supplierCreditNotes', 'postedCredits'], [releases, 'retentionReleases', 'postedReleases']]) {
    for (const d of list) {
      if (d.status !== 'posted') continue
      source[key] += 1
      if (typeof d.supplierInvoiceId !== 'string' || d.supplierInvoiceId === '') { source.unattributable += 1; add('refuse', kind, d.id, 'supplier-finance-baseline-invalid', kind === 'retentionReleases' ? 'release-names-no-invoice' : 'credit-names-no-invoice') }
    }
  }

  // Progress claims.
  const C = { total: claims.length, byStatus: {}, calcVersion: {}, invoiceLink: {} }
  for (const c of claims) {
    tally(C.byStatus, c.status ?? '(none)')
    const ver = sf.calcVersionOf(c)
    tally(C.calcVersion, ver === null ? 'unknown' : c.calcVersion === undefined || c.calcVersion === null ? 'legacy-absent' : `v${ver}`)
    if (ver === null) add('refuse', 'progressClaims', c.id, 'supplier-finance-unsupported-record', 'calc-version')
    if ([sf.CLAIM_STATUS.APPROVED, sf.CLAIM_STATUS.INVOICED].includes(c.status)) {
      const link = sf.claimInvoiceLinkOf(c).state
      tally(C.invoiceLink, link)
      if (link === 'malformed') add('refuse', 'progressClaims', c.id, 'supplier-finance-invalid', 'invoice-link-malformed')
      if (link === 'legacy' && c.status === sf.CLAIM_STATUS.APPROVED) add('review', 'progressClaims', c.id, 'supplier-finance-legacy-claim', 'invoice-link-key-absent')
    }
    if (sf.CLAIM_APPROVABLE_STATUSES.includes(c.status) && ver !== null && typeof c.poId === 'string') {
      const e = claimLedgers?.ledgers?.get(c.poId)
      if (e?.state === 'inconsistent') continue // reported once, on the PO ledger
      const variationsOfClaim = variations.filter(v => (c.lineItems ?? []).some(l => l?.variationId === v.id))
      const p = sf.claimSubmittedSideProblem({ claim: c, po: pos.get(c.poId) ?? null, variations: variationsOfClaim, ledger: e?.ledger ?? sf.emptyPoClaimLedger() })
      if (p) add('refuse', 'progressClaims', c.id, refusalOf(p.problem), `approve:${p.reason ?? p.problem}`)
    }
  }

  // Supplier invoices.
  const I = { total: invoices.length, byStatus: {}, calcVersion: {} }
  for (const inv of invoices) {
    tally(I.byStatus, inv.status ?? '(none)')
    const ver = sf.calcVersionOf(inv)
    tally(I.calcVersion, ver === null ? 'unknown' : inv.calcVersion === undefined || inv.calcVersion === null ? 'legacy-absent' : `v${ver}`)
    if (STRANDED_INVOICE.includes(inv.status)) add('review', 'supplierInvoices', inv.id, 'supplier-finance-invalid', `status-without-backend-transition:${inv.status}`)
    if (OBLIGATION_INVOICE.includes(inv.status)) {
      const figures = sf.supplierInvoiceFigures(inv)
      if (figures.problem) add('inconsistent', 'supplierInvoices', inv.id, 'supplier-finance-ledger-inconsistent', `obligation:${messageCode(figures.problem)}`)
    }
    if (PENDING_INVOICE.includes(inv.status)) {
      const claim = typeof inv.progressClaimId === 'string' ? claimsById.get(inv.progressClaimId) ?? null : null
      const p = sf.invoiceStoredProblem({ invoice: inv, po: typeof inv.poId === 'string' ? pos.get(inv.poId) ?? null : null, claim })
      if (p) add('refuse', 'supplierInvoices', inv.id, refusalOf(p.problem), `${inv.status === sf.SI_STATUS.DRAFT ? 'approve' : 'post'}:${p.reason ?? p.problem}`)
      else if (inv.status === sf.SI_STATUS.APPROVED) {
        const pairing = sf.postPairingProblem(inv, claim)
        if (pairing) add('refuse', 'supplierInvoices', inv.id, refusalOf(pairing.problem), 'post:claim-does-not-link-invoice')
      }
    }
  }

  // Server state already present, and the client settlement registers.
  const markers = r.supplierFinanceState.filter(d => d.id === 'baseline').map(d => d.data)
  const supplierBaselineMarker = markers.length === 0 ? 'absent'
    : markers[0].state === 'complete' ? 'complete'
      : markers[0].state === 'building' ? (Number(markers[0].leaseUntilMillis) > now ? 'building-in-lease' : 'building-expired') : 'malformed'
  if (supplierBaselineMarker === 'building-expired' || supplierBaselineMarker === 'malformed') add('review', 'supplierFinanceState', projectId, 'supplier-finance-busy', `baseline-marker-${supplierBaselineMarker}`)

  // Independent reconciliation: with the baseline complete, every stored
  // ledger must equal the ledger the registers imply (every posting and void
  // is a register document), to the cent. Figures are compared, never printed.
  const reconciliation = { compared: false, invoiceLedgers: 0, poClaimLedgers: 0, differing: 0 }
  if (supplierBaselineMarker === 'complete') {
    reconciliation.compared = true
    if (missingSource) add('inconsistent', 'supplierFinanceBaseline', projectId, 'supplier-finance-baseline-invalid', `complete-marker-but-registers-${messageCode(missingSource)}`)
    const nonZero = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => (typeof v === 'object' && v !== null ? (v.amountCents ?? 0) !== 0 || (v.gstCents ?? 0) !== 0 : v !== 0)).sort(([a], [b]) => a.localeCompare(b)))
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const storedInv = new Map(r.supplierInvoiceLedgers.map(d => [d.id, d.data]))
    for (const id of new Set([...storedInv.keys(), ...(settlement.ledgers?.keys() ?? [])])) {
      reconciliation.invoiceLedgers += 1
      const want = settlement.ledgers?.get(id)?.ledger ?? sf.emptySupplierLedger()
      const have = sf.readSupplierLedger(storedInv.get(id) ?? null)
      const keys = sf.SUPPLIER_LEDGER_TOTAL_KEYS.filter(k => have[k] !== want[k])
      if (!same(nonZero(have.groups), nonZero(want.groups))) keys.push('groups')
      if (storedInv.has(id) && sf.storedSupplierLedgerProblem(storedInv.get(id))) keys.push('malformed')
      if (keys.length > 0) { reconciliation.differing += 1; add('inconsistent', 'supplierInvoiceLedgers', id, 'ledger-differs-from-registers', keys.join(',')) }
    }
    const storedPo = new Map(r.poClaimLedgers.map(d => [d.id, d.data]))
    for (const id of new Set([...storedPo.keys(), ...(claimLedgers?.ledgers?.keys() ?? [])])) {
      reconciliation.poClaimLedgers += 1
      const want = claimLedgers?.ledgers?.get(id)?.ledger ?? sf.emptyPoClaimLedger()
      const have = sf.readPoClaimLedger(storedPo.get(id) ?? null)
      const keys = []
      if (!same([...have.openClaimIds].sort(), [...want.openClaimIds].sort())) keys.push('openClaimIds')
      if (!same(nonZero(have.approvedPoLineCents), nonZero(want.approvedPoLineCents))) keys.push('approvedPoLineCents')
      if (!same(nonZero(have.approvedVariationLineCents), nonZero(want.approvedVariationLineCents))) keys.push('approvedVariationLineCents')
      if (keys.length > 0) { reconciliation.differing += 1; add('inconsistent', 'poClaimLedgers', id, 'ledger-differs-from-registers', keys.join(',')) }
    }
  }
  // D3 #53 — the BOQ against the estimate's supported bounds (counts and ids only).
  const B = { active: 0, overItemLimit: false, textOverBound: 0, keyOverBound: 0 }
  const TEXT_BOUNDS = [['itemNumber', ec.ESTIMATE_ITEM_NUMBER_MAX], ['section', ec.ESTIMATE_TEXT_MAX], ['description', ec.ESTIMATE_DESCRIPTION_MAX], ['costCodeName', ec.ESTIMATE_TEXT_MAX]]
  for (const d of r.boqItems) {
    if (d.data.status !== 'active') continue
    B.active += 1
    const long = TEXT_BOUNDS.find(([k, max]) => String(d.data[k] ?? '').length > max)
    if (long) { B.textOverBound += 1; add('review', 'boqItems', d.id, 'boq-text-over-estimate-bound', long[0]) }
    if (String(d.id).length > ec.ESTIMATE_ID_MAX || String(d.data.costCodeId ?? '').length > ec.ESTIMATE_ID_MAX || String(d.data.unit ?? '').length > ec.ESTIMATE_UNIT_MAX) {
      B.keyOverBound += 1; add('review', 'boqItems', d.id, 'boq-key-over-estimate-bound')
    }
  }
  if (B.active > ec.ESTIMATE_MAX_ITEMS) { B.overItemLimit = true; add('review', 'boqItems', projectId, 'boq-over-estimate-item-limit', String(B.active)) }
  // BOQ → budget provenance: before the cutover no budget line can carry an estimate's handover.
  let estimateProvenance = 0
  for (const d of r.budgetLines) {
    if (d.data.boqSource?.latest?.estimate != null || d.data.boqSource?.first?.estimate != null) { estimateProvenance += 1; add('review', 'budgetLines', d.id, 'budget-line-estimate-provenance-unexpected') }
  }
  // D3 #54 — open POs / tender packages whose preparer was never recorded: under
  // strict segregation they cannot be sent / awarded until a material save (a
  // draft) or a cancel and re-raise (issued / pending_approval). Never fabricated.
  let unrecorded = 0
  for (const d of r.purchaseOrders) {
    if (['draft', 'pending_approval'].includes(d.data.status) && typeof d.data.lastMaterialEditBy !== 'string') { unrecorded += 1; add('review', 'purchaseOrders', d.id, 'po-preparer-unrecorded', d.data.status) }
  }
  for (const d of r.tenderPackages) {
    if (['draft', 'issued'].includes(d.data.status) && typeof d.data.lastMaterialEditBy !== 'string') { unrecorded += 1; add('review', 'tenderPackages', d.id, 'tender-preparer-unrecorded', d.data.status) }
  }

  const E = { total: 0, byState: {}, buildingExpired: 0 }
  for (const d of r.estimates) {
    E.total += 1
    tally(E.byState, d.data.state ?? '(none)')
    const started = millisOf(d.data.runStartedAt)
    if (d.data.state === 'building' && (started === null || now - started > ESTIMATE_BUILD_LEASE_MS)) { E.buildingExpired += 1; add('review', 'estimates', d.id, 'estimate-building', 'build-left-building-past-lease') }
  }
  const commercialBaseline = r.commercial.find(d => d.id === 'baseline')
  const contractValue = !commercialBaseline ? 'no-baseline' : typeof commercialBaseline.data.originalContractValue === 'number' ? 'number' : 'not-a-number'
  if (contractValue === 'not-a-number') add('review', 'commercial', projectId, 'contract-value-invalid', 'original-contract-value-not-a-number')
  const clientSettlement = {
    clientRefunds: r.clientRefunds.length, clientReceiptApplications: r.clientReceiptApplications.length, clientReceiptLedgers: r.clientReceiptLedgers.length,
    receiptBaselineMarker: r.clientFinanceState.some(d => d.id === 'receiptBaseline'),
  }

  return {
    report: {
      projectId,
      variations: { ...V, byStatus: sorted(V.byStatus), calcVersion: sorted(V.calcVersion) },
      progressClaims: { ...C, byStatus: sorted(C.byStatus), calcVersion: sorted(C.calcVersion), invoiceLink: sorted(C.invoiceLink) },
      supplierInvoices: { ...I, byStatus: sorted(I.byStatus), calcVersion: sorted(I.calcVersion) },
      supplierBaselinePreview: baseline,
      baselineSource: source,
      ledgerReconciliation: reconciliation,
      serverState: {
        supplierBaselineMarker, supplierInvoiceLedgers: r.supplierInvoiceLedgers.length, poClaimLedgers: r.poClaimLedgers.length,
        estimates: { ...E, byState: sorted(E.byState) }, estimateState: r.estimateState.length > 0,
        contractValueRevisions: r.contractValueRevisions.length, originalContractValue: contractValue,
      },
      clientSettlement,
      boq: B,
      budgetLinesWithEstimateProvenance: estimateProvenance,
      openDocumentsWithUnrecordedPreparer: unrecorded,
    },
    findings,
  }
}

export function analyseCompany(companyId, company, projects, companyDocs, now) {
  const findings = []
  const costCodes = new Map(companyDocs.costCodes.map(d => [d.id, { code: '', name: '' }]))
  const policyDoc = companyDocs.approvalPolicy.find(d => d.id === 'current')
  const approvalPolicy = !policyDoc ? 'absent' : policyDoc.data.segregationEnabled === true ? 'enabled' : policyDoc.data.segregationEnabled === false ? 'disabled' : 'malformed'
  if (approvalPolicy === 'malformed') findings.push({ severity: 'review', companyId, projectId: null, register: 'approvalPolicy', id: 'current', code: 'approval-policy-malformed' })
  const flag = (v) => (v === true ? true : v === undefined ? 'absent' : v === false ? false : 'not-a-boolean')
  const activation = {
    clientFinanceEnabled: flag(company?.clientFinanceEnabled),
    clientReceiptsEnabled: flag(company?.clientReceiptsEnabled),
    commercialCompletionEnabled: flag(company?.commercialCompletionEnabled),
    approvalPolicy,
  }

  const projectReports = []
  for (const [projectId, r] of [...projects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const out = analyseProject(r, { companyId, projectId, costCodes, now })
    projectReports.push(out.report)
    findings.push(...out.findings)
  }

  // Counters and duplicate numbers, company-wide per type.
  const counters = []
  const duplicates = []
  for (const spec of COUNTERS) {
    const docs = [...projects.values()].flatMap(r => r[spec.register].map(d => ({ id: d.id, data: d.data })))
      .filter(d => (spec.where ? spec.where(d.data) : true))
    const numbered = docs.filter(d => d.data[spec.field] != null && d.data[spec.field] !== '')
    const seqs = new Map()
    let unparseable = 0
    for (const d of numbered) {
      const n = sequenceOf(d.data[spec.field], spec.prefix)
      if (n === null) { unparseable += 1; continue }
      if (!seqs.has(n)) seqs.set(n, [])
      seqs.get(n).push(d.id)
    }
    const highest = seqs.size === 0 ? 0 : Math.max(...seqs.keys())
    const counterDoc = companyDocs.counters.find(d => d.id === spec.counter)
    const next = counterDoc ? counterDoc.data.next : undefined
    let problem = null
    if (counterDoc && (!Number.isSafeInteger(next) || next < 1 || next > COUNTER_MAX)) problem = 'counter-not-a-whole-number-in-range'
    else if (!counterDoc && highest > 0) problem = 'counter-absent-while-numbers-exist'
    else if (counterDoc && next <= highest) problem = 'counter-not-above-highest-number'
    counters.push({ counter: spec.counter, next: counterDoc ? (Number.isSafeInteger(next) ? next : 'not-a-whole-number') : 'absent', highest, numbered: numbered.length, unparseable })
    if (problem) findings.push({ severity: 'refuse', companyId, projectId: null, register: 'counters', id: spec.counter, code: problem })
    if (unparseable > 0) findings.push({ severity: 'review', companyId, projectId: null, register: spec.register, id: spec.counter, code: 'document-number-unparseable', reason: String(unparseable) })
    for (const [n, ids] of seqs) {
      if (ids.length < 2) continue
      duplicates.push({ counter: spec.counter, sequence: n, documentIds: ids.sort() })
      findings.push({ severity: 'review', companyId, projectId: null, register: spec.register, id: ids.sort().join(','), code: 'duplicate-document-number', reason: `${spec.counter}:${n}` })
    }
  }
  return { report: { companyId, activation, counters, duplicateNumbers: duplicates, projects: projectReports }, findings }
}

// docs: { [collectionId]: [{ name, fields }] } as the REST API returns them.
export function analyse(docs, { now = Date.now(), company = null } = {}) {
  const companies = new Map()
  const companyDocs = new Map()
  const projects = new Map()
  let outsideScope = 0
  const emptyProject = () => Object.fromEntries(Object.keys(READ_PLAN).filter(k => !['companies', 'projects', 'approvalPolicy', 'counters', 'costCodes'].includes(k)).map(k => [k, []]))
  const ensureCompany = (c) => {
    if (!companyDocs.has(c)) companyDocs.set(c, { approvalPolicy: [], counters: [], costCodes: [] })
    if (!projects.has(c)) projects.set(c, new Map())
  }
  for (const [group, list] of Object.entries(docs)) {
    for (const doc of list ?? []) {
      const s = scopeOf(doc.name)
      if (!s) { outsideScope += 1; continue }
      const entry = { id: s.id, data: decodeFields(doc.fields) }
      ensureCompany(s.companyId)
      if (group === 'companies' && s.collection === 'companies') { companies.set(s.companyId, entry.data); continue }
      if (group === 'projects' && s.collection === 'projects' && s.projectId) {
        if (!projects.get(s.companyId).has(s.projectId)) projects.get(s.companyId).set(s.projectId, emptyProject())
        continue
      }
      if (['approvalPolicy', 'counters', 'costCodes'].includes(group) && s.collection === group && s.projectId === null) { companyDocs.get(s.companyId)[group].push(entry); continue }
      if (s.projectId && s.collection === group && group in emptyProject()) {
        const p = projects.get(s.companyId)
        if (!p.has(s.projectId)) p.set(s.projectId, emptyProject())
        p.get(s.projectId)[group].push(entry)
        continue
      }
      // A project-level counter (RFIs) or another nesting: not part of this inventory.
      outsideScope += 1
    }
  }
  const ids = [...new Set([...companies.keys(), ...projects.keys()])].sort()
  const reports = []
  const findings = []
  for (const c of ids) {
    if (company && c !== company) continue
    const out = analyseCompany(c, companies.get(c), projects.get(c) ?? new Map(), companyDocs.get(c), now)
    reports.push(out.report)
    findings.push(...out.findings)
  }
  const bySeverity = {}
  const byCode = {}
  for (const f of findings) { tally(bySeverity, f.severity); tally(byCode, `${f.severity} ${f.code}${f.reason ? ` (${f.reason.replace(/:\d+$/, '')})` : ''}`) }
  const activation = {}
  for (const r of reports) tally(activation, `commercialCompletion=${r.activation.commercialCompletionEnabled} clientFinance=${r.activation.clientFinanceEnabled} receipts=${r.activation.clientReceiptsEnabled} approvalPolicy=${r.activation.approvalPolicy}`)
  const sum = (f) => reports.reduce((n, r) => n + r.projects.reduce((m, p) => m + f(p), 0), 0)
  return {
    summary: {
      companies: reports.length,
      projects: reports.reduce((n, r) => n + r.projects.length, 0),
      companiesByActivation: sorted(activation),
      variations: sum(p => p.variations.total),
      progressClaims: sum(p => p.progressClaims.total),
      supplierInvoices: sum(p => p.supplierInvoices.total),
      postedPaymentAllocations: sum(p => p.baselineSource.postedAllocations),
      supplierBaselinesWouldRefuse: sum(p => (p.supplierBaselinePreview.outcome === 'would-refuse' ? 1 : 0)),
      inconsistentLedgersPreviewed: sum(p => p.supplierBaselinePreview.inconsistentInvoiceLedgers.length + p.supplierBaselinePreview.inconsistentPoClaimLedgers.length),
      supplierBaselineMarkers: sum(p => (p.serverState.supplierBaselineMarker === 'absent' ? 0 : 1)),
      supplierLedgers: sum(p => p.serverState.supplierInvoiceLedgers + p.serverState.poClaimLedgers),
      ledgersDifferingFromRegisters: sum(p => p.ledgerReconciliation.differing),
      clientRefunds: sum(p => p.clientSettlement.clientRefunds),
      clientReceiptApplications: sum(p => p.clientSettlement.clientReceiptApplications),
      clientReceiptLedgers: sum(p => p.clientSettlement.clientReceiptLedgers),
      receiptBaselineMarkers: sum(p => (p.clientSettlement.receiptBaselineMarker ? 1 : 0)),
      estimates: sum(p => p.serverState.estimates.total),
      contractValueRevisions: sum(p => p.serverState.contractValueRevisions),
      documentsOutsideScope: outsideScope,
      findings: findings.length,
      findingsBySeverity: sorted(bySeverity),
      findingsByCode: sorted(byCode),
    },
    companies: reports,
    findings,
  }
}

// ── I/O: the one request kind ────────────────────────────────────────────────
async function readGroup(base, headers, collectionId, fields) {
  const out = []
  let cursor = null
  for (;;) {
    const structuredQuery = { from: [{ collectionId, allDescendants: true }], orderBy: [{ field: { fieldPath: '__name__' } }], limit: 500 }
    if (fields) structuredQuery.select = { fields: fields.map(f => ({ fieldPath: f })) }
    if (cursor) structuredQuery.startAt = { values: [{ referenceValue: cursor }], before: false }
    const res = await fetch(`${base}:runQuery`, { method: 'POST', headers, body: JSON.stringify({ structuredQuery }) })
    if (!res.ok) throw new Error(`read of ${collectionId} failed: HTTP ${res.status}`)
    const rows = (await res.json()).filter(x => x.document).map(x => ({ name: x.document.name, fields: x.document.fields }))
    out.push(...rows)
    if (rows.length < 500) break
    cursor = rows[rows.length - 1].name
  }
  return out
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (err) {
    console.error(`${err.message}\nusage: node ops/recovery/phase2-inventory.mjs --project <id> [--emulator 127.0.0.1:8080] [--company <id>] [--summary]`)
    process.exit(2)
  }
  const token = args.emulator ? 'owner' : execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()
  const origin = args.emulator ? `http://${args.emulator}` : 'https://firestore.googleapis.com'
  const documentsRoot = `projects/${args.project}/databases/(default)/documents`
  const base = `${origin}/v1/${documentsRoot}`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const docs = {}
  for (const [collectionId, fields] of Object.entries(READ_PLAN)) docs[collectionId] = await readGroup(base, headers, collectionId, fields)
  const result = analyse(docs, { now: Date.now(), company: args.company ?? null })
  const header = { project: args.project, source: args.emulator ? 'emulator' : 'production', readAt: new Date().toISOString(), ...(args.company ? { company: args.company } : {}) }
  console.log(JSON.stringify(args.summary ? { ...header, summary: result.summary } : { ...header, ...result }, null, 1))
  process.exitCode = result.findings.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(3) })
}
