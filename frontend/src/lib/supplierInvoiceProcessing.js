import {
  SI_STATUS, SI_SOURCE, SI_DOC_TYPE, TAX_CODE, TAX_CODES, INVOICEABLE_PO_STATUSES,
  buildInvoiceLine, invoiceTotalsFor, gstForLineFor, gstForLine, allocateGstCents, validateInvoiceDraft,
  invoiceVariationLineCount,
} from './supplierInvoices'
import { CLAIM_STATUS, CLAIM_INVOICE_LINK, claimInvoiceLink, claimTotalsFor } from './progressClaims'
import { CALC_VERSION, CURRENT_CALC_VERSION, calcVersionOf, roundToCents } from './supplierCalc'
import { isVariationOriginLine, sourceLineIdentityError } from './sourceLine'
import { toCents, fromCents, isWholeCents } from './money'

// ── Supplier invoices on the trusted boundary (Phase 2 step 3, ADR-93) ───────
//
// PURE — shared by the browser and the trusted backend (generated bundle).
// A supplier invoice is CREATED, its DRAFT EDITED, APPROVED, POSTED and
// CANCELLED only by the backend, and an approved claim is LINKED to an existing
// invoice only there. Firestore Rules admit no client write to the collection.
//
// CALCULATION VERSIONS (ADR-91):
//   · a DIRECT purchase-order invoice is created, and re-derived on every draft
//     edit, under the current version (2, exact) — an edited legacy draft
//     becomes version 2, the policy approved for variations;
//   · a CLAIM-SOURCED invoice is DERIVED from its approved claim and takes the
//     claim's version as its own (`calcVersion` = `sourceCalcVersion` = the
//     claim's, `null` for a legacy source): its payable figures ARE the claim's
//     stored certified figures, never recalculated, and its retention GST is
//     computed by the same policy the claim's certified GST was;
//   · a stored invoice is verified, at approval and at posting, under its OWN
//     version.

export const INVOICE_PROCESSING_ROLES = ['company_admin', 'project_manager', 'qs']
export const INVOICE_COUNTER_ID = 'supplierInvoices'
export const INVOICE_TEXT_MAX = 200
export const INVOICE_NOTES_MAX = 5000
export const INVOICE_MAX_LINES = 200

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (data, keys) => isObject(data) && Object.keys(data).length === keys.length && keys.every(k => k in data)
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const isRevision = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v)
const isDateOrEmpty = (v) => typeof v === 'string' && (v === '' || DATE_RE.test(v))
const isText = (v, max) => typeof v === 'string' && v.length <= max
const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && roundToCents(v) !== null

// ── Requests ─────────────────────────────────────────────────────────────────

export const CREATE_INVOICE_KEYS = ['projectId', 'invoiceId', 'source', 'sourceId', 'expectedSourceRevision',
  'supplierInvoiceNumber', 'invoiceDate', 'receivedDate', 'dueDate', 'notes', 'retention', 'lines']
export const INVOICE_LINE_KEYS = ['lineIndex', 'amount', 'taxCode']
export const UPDATE_INVOICE_KEYS = ['projectId', 'invoiceId', 'expectedRevision',
  'supplierInvoiceNumber', 'invoiceDate', 'receivedDate', 'dueDate', 'notes', 'retention', 'lines']
export const INVOICE_TRANSITION_KEYS = ['projectId', 'invoiceId', 'expectedRevision']
export const LINK_INVOICE_KEYS = ['projectId', 'claimId', 'invoiceId', 'expectedClaimRevision']

function headerProblem(d) {
  if (!isText(d.supplierInvoiceNumber, INVOICE_TEXT_MAX) || d.supplierInvoiceNumber.trim() === '') return 'supplierInvoiceNumber'
  if (!isDate(d.invoiceDate)) return 'invoiceDate'
  if (!isDateOrEmpty(d.receivedDate) || !isDateOrEmpty(d.dueDate)) return 'dates'
  if (!isText(d.notes, INVOICE_NOTES_MAX)) return 'notes'
  return null
}

// `lineIndex` names the SOURCE line: a purchase-order line (direct create), a
// claim line (claim-sourced create) or the stored line's position (draft edit).
// Each source line at most once.
function linesProblem(lines, claimSourced) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > INVOICE_MAX_LINES) return 'lines'
  const seen = new Set()
  for (const l of lines) {
    if (!exactKeys(l, INVOICE_LINE_KEYS) || !TAX_CODES.includes(l.taxCode)) return 'line'
    if (!Number.isInteger(l.lineIndex) || l.lineIndex < 0 || l.lineIndex >= INVOICE_MAX_LINES || seen.has(l.lineIndex)) return 'line-index'
    seen.add(l.lineIndex)
    if (claimSourced ? l.amount !== null : (!isAmount(l.amount) || !isWholeCents(l.amount) || l.amount < 0)) return 'line-amount'
  }
  return null
}

export function createInvoiceRequestProblem(d) {
  if (!exactKeys(d, CREATE_INVOICE_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.invoiceId) || !isId(d.sourceId)) return 'ids'
  const claimSourced = d.source === SI_SOURCE.PROGRESS_CLAIM
  if (!claimSourced && d.source !== SI_SOURCE.DIRECT_PO) return 'source'
  if (claimSourced ? !isRevision(d.expectedSourceRevision) : d.expectedSourceRevision !== null) return 'expectedSourceRevision'
  if (claimSourced ? d.retention !== null : (!isAmount(d.retention) || d.retention < 0 || !isWholeCents(d.retention))) return 'retention'
  return headerProblem(d) ?? linesProblem(d.lines, claimSourced)
}

export function updateInvoiceRequestProblem(d) {
  if (!exactKeys(d, UPDATE_INVOICE_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.invoiceId)) return 'ids'
  if (!isRevision(d.expectedRevision)) return 'expectedRevision'
  const header = headerProblem(d)
  if (header) return header
  // A claim-sourced draft is corrected on its header only: no line, no retention.
  if (d.lines === null) return d.retention === null ? null : 'retention'
  if (!isAmount(d.retention) || d.retention < 0 || !isWholeCents(d.retention)) return 'retention'
  return linesProblem(d.lines, false)
}

export function invoiceTransitionRequestProblem(d) {
  if (!exactKeys(d, INVOICE_TRANSITION_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.invoiceId)) return 'ids'
  return isRevision(d.expectedRevision) ? null : 'expectedRevision'
}

export function linkInvoiceRequestProblem(d) {
  if (!exactKeys(d, LINK_INVOICE_KEYS)) return 'keys'
  if (!isId(d.projectId) || !isId(d.claimId) || !isId(d.invoiceId)) return 'ids'
  return isRevision(d.expectedClaimRevision) ? null : 'expectedClaimRevision'
}

// ── Problems ─────────────────────────────────────────────────────────────────

export const INVOICE_PROBLEM = {
  PO_INVALID:       'po-invalid',
  CLAIM_INVALID:    'claim-invalid',
  CLAIM_STALE:      'claim-stale',
  ALREADY_INVOICED: 'already-invoiced',
  LEGACY_CLAIM:     'legacy-claim',
  LINES_INVALID:    'lines-invalid',
  DRAFT_INVALID:    'draft-invalid',
  NOT_RECONCILED:   'not-reconciled',
  OUT_OF_RANGE:     'out-of-range',
  FIGURES:          'figures-inconsistent',
  NOT_LINKED:       'not-linked',
}
const problem = (code, message, extra = {}) => ({ problem: code, message, ...extra })

// ── Claim-sourced GST apportionment under a version ──────────────────────────
//
// The certified claim GST is AUTHORITATIVE; the invoice's line GST is an
// apportionment of (certified + this invoice's retention GST) across its
// taxable lines, computed by the existing integer allocator. The retention GST
// is the claim version's (legacy `roundMoney(r × 0.1)`, exact half-up). Returns
// the lines with GST, or null when no apportionment reaches the target.
export function apportionClaimSourcedGst(lines, { certifiedGst, retention, version }) {
  const totals = invoiceTotalsFor(lines.map(l => ({ ...l, gstAmount: 0 })), retention, version)
  if (!totals) return null
  const target = toCents(certifiedGst) + toCents(totals.retentionGst)
  const cents = lines.map(li => (li.taxCode === TAX_CODE.GST && toCents(li.amount) > 0 ? toCents(li.amount) : null))
  const allocated = allocateGstCents(cents, target)
  if (!allocated) return null
  return lines.map((li, i) => ({ ...li, gstAmount: fromCents(allocated[i]) }))
}

// ── Build: direct purchase-order invoice ─────────────────────────────────────

function directLines(po, requestLines, version) {
  const poLines = Array.isArray(po?.lineItems) ? po.lineItems : []
  const lines = []
  for (const r of [...requestLines].sort((a, b) => a.lineIndex - b.lineIndex)) {
    const i = r.lineIndex
    if (!poLines[i]) return problem(INVOICE_PROBLEM.LINES_INVALID, `Purchase-order line ${i + 1} does not exist.`)
    const amount = fromCents(roundToCents(r.amount))
    if (amount === 0) continue  // CREATE stores only the priced lines (existing behaviour)
    const line = buildInvoiceLine(poLines[i], { poLineIndex: i, amount, taxCode: r.taxCode })
    const gst = gstForLineFor(amount, r.taxCode, version)
    if (gst === null) return problem(INVOICE_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`)
    lines.push({ ...line, gstAmount: gst })
  }
  return { lines }
}

function documentBase({ invoiceNumber, source, po, claim, header, lines, totals, version, sourceVersion, currency, paymentTerms, uid, now }) {
  return {
    invoiceNumber, supplierInvoiceNumber: header.supplierInvoiceNumber.trim(), status: SI_STATUS.DRAFT, docType: SI_DOC_TYPE.INVOICE, source,
    supplierId: (claim ?? po)?.supplierId ?? null, supplierName: String((claim ?? po)?.supplierName ?? '').trim(),
    poId: claim ? claim.poId : po.id, poNumber: claim ? (claim.poNumber ?? null) : (po.poNumber ?? null),
    progressClaimId: claim ? claim.id : null, claimNumber: claim ? (claim.claimNumber ?? null) : null,
    variationLineCount: invoiceVariationLineCount(lines),
    invoiceDate: header.invoiceDate, receivedDate: header.receivedDate, dueDate: header.dueDate, paymentTerms: paymentTerms ?? null,
    lineItems: lines,
    retention: totals.retention, retentionGst: totals.retentionGst, retentionTotal: totals.retentionTotal,
    subtotal: totals.subtotal, gstTotal: totals.gstTotal, grossTotal: totals.grossTotal,
    net: totals.net, payableGst: totals.payableGst, payableTotal: totals.payableTotal,
    currency, revision: 1, calcVersion: version, sourceCalcVersion: sourceVersion,
    notes: header.notes.trim(),
    approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
    paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
    createdAt: now, createdBy: uid, updatedAt: now, updatedBy: uid,
  }
}

export function buildDirectInvoice({ input, po, invoiceNumber, currency, paymentTerms, uid, now }) {
  if (!po || !INVOICEABLE_PO_STATUSES.includes(po.status)) return problem(INVOICE_PROBLEM.PO_INVALID, 'Invoices can only be raised against a sent or closed purchase order.')
  const version = CURRENT_CALC_VERSION
  const built = directLines(po, input.lines, version)
  if (built.problem) return built
  const draftError = validateInvoiceDraft({ lineItems: built.lines, supplierInvoiceNumber: input.supplierInvoiceNumber, invoiceDate: input.invoiceDate, retention: input.retention })
  if (draftError) return problem(INVOICE_PROBLEM.DRAFT_INVALID, draftError)
  const totals = invoiceTotalsFor(built.lines, input.retention, version)
  if (!totals) return problem(INVOICE_PROBLEM.OUT_OF_RANGE, 'The invoice total is outside the supported range.')
  return { document: documentBase({ invoiceNumber, source: SI_SOURCE.DIRECT_PO, po, claim: null, header: input, lines: built.lines, totals, version, sourceVersion: null, currency, paymentTerms, uid, now }) }
}

// ── Build: claim-sourced invoice ─────────────────────────────────────────────

// Why `claim` cannot be invoiced right now, or null (the server copy).
export function claimInvoicePairingProblem(claim, expectedRevision) {
  if (!claim) return problem(INVOICE_PROBLEM.CLAIM_INVALID, 'This progress claim no longer exists.')
  const name = claim.claimNumber || 'This progress claim'
  if (claim.status !== CLAIM_STATUS.APPROVED) return problem(INVOICE_PROBLEM.CLAIM_STALE, `${name} is not approved.`)
  const link = claimInvoiceLink(claim)
  if (link.state === CLAIM_INVOICE_LINK.LINKED) return problem(INVOICE_PROBLEM.ALREADY_INVOICED, `${name} already has a supplier invoice.`, { linkedInvoiceId: link.invoiceId })
  if (link.state === CLAIM_INVOICE_LINK.LEGACY) return problem(INVOICE_PROBLEM.LEGACY_CLAIM, `${name} was approved before invoice pairing and must be reconciled first.`)
  if (link.state !== CLAIM_INVOICE_LINK.UNLINKED) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${name} carries a malformed invoice link.`)
  if ((Number(claim.revision) || 0) !== expectedRevision) return problem(INVOICE_PROBLEM.CLAIM_STALE, `${name} changed since you loaded it. Review the latest version and retry.`)
  if (calcVersionOf(claim) === null) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${name} carries an unknown calculation version.`)
  return null
}

// The certified lines of a claim as invoice lines (amount = the certified
// amount; zero-certified lines are not stored), tax codes from the request.
// One tax code per CERTIFIED claim line (certified above zero), each named by
// its claim line index; a zero-certified line is not invoiced.
function claimLines(claim, requestLines, version) {
  const source = Array.isArray(claim?.lineItems) ? claim.lineItems : []
  const taxByIndex = new Map(requestLines.map(r => [r.lineIndex, r.taxCode]))
  const lines = []
  for (const [i, li] of source.entries()) {
    const amount = Number(li?.approvedThisPeriod)
    if (!Number.isFinite(amount) || !isWholeCents(amount) || amount < 0) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `Claim line ${i + 1} stores a certified amount that is not whole cents.`)
    if (amount === 0) {
      if (taxByIndex.has(i)) return problem(INVOICE_PROBLEM.LINES_INVALID, `Claim line ${i + 1} was certified at zero and is not invoiced.`)
      continue
    }
    if (!taxByIndex.has(i)) return problem(INVOICE_PROBLEM.LINES_INVALID, `A tax code is required for every certified claim line (line ${i + 1}).`)
    const taxCode = taxByIndex.get(i)
    taxByIndex.delete(i)
    const line = buildInvoiceLine(li, { amount, taxCode })
    lines.push({ ...line, gstAmount: gstForLineFor(amount, taxCode, version) ?? 0 })
  }
  if (taxByIndex.size > 0) return problem(INVOICE_PROBLEM.LINES_INVALID, 'A line names no claim line.')
  return { lines }
}

export function buildClaimSourcedInvoice({ input, claim, invoiceNumber, currency, paymentTerms, uid, now }) {
  const pairing = claimInvoicePairingProblem(claim, input.expectedSourceRevision)
  if (pairing) return pairing
  const version = calcVersionOf(claim)
  const built = claimLines(claim, input.lines, version)
  if (built.problem) return built
  const identity = sourceLineIdentityError(built.lines, { poId: claim.poId })
  if (identity) return problem(INVOICE_PROBLEM.CLAIM_INVALID, identity)
  const retention = Number(claim.retention) || 0
  const lines = apportionClaimSourcedGst(built.lines, { certifiedGst: claim.approvedGst, retention, version })
  if (!lines) return problem(INVOICE_PROBLEM.NOT_RECONCILED, 'The certified claim GST cannot be apportioned across these lines — check the tax codes (at least the GST-bearing lines must carry GST).')
  const draftError = validateInvoiceDraft({ lineItems: lines, supplierInvoiceNumber: input.supplierInvoiceNumber, invoiceDate: input.invoiceDate, retention, authoredLines: false })
  if (draftError) return problem(INVOICE_PROBLEM.DRAFT_INVALID, draftError)
  const totals = invoiceTotalsFor(lines, retention, version)
  if (!totals) return problem(INVOICE_PROBLEM.OUT_OF_RANGE, 'The invoice total is outside the supported range.')
  if (toCents(totals.payableGst) !== toCents(claim.approvedGst) || toCents(totals.payableTotal) !== toCents(claim.approvedTotal)) {
    return problem(INVOICE_PROBLEM.NOT_RECONCILED, `The invoice does not reconcile to ${claim.claimNumber || 'the claim'}’s certified GST and total.`)
  }
  const sourceVersion = claim.calcVersion == null ? null : version
  return { document: documentBase({ invoiceNumber, source: SI_SOURCE.PROGRESS_CLAIM, po: null, claim, header: input, lines, totals, version, sourceVersion, currency, paymentTerms, uid, now }) }
}

// ── Draft edit ───────────────────────────────────────────────────────────────

export function buildInvoiceDraftUpdate({ input, live, po, uid, now }) {
  const header = {
    supplierInvoiceNumber: input.supplierInvoiceNumber.trim(), invoiceDate: input.invoiceDate,
    receivedDate: input.receivedDate, dueDate: input.dueDate, notes: input.notes.trim(),
  }
  const stamp = { revision: (Number(live.revision) || 0) + 1, updatedAt: now, updatedBy: uid }
  if (live.source === SI_SOURCE.PROGRESS_CLAIM) {
    if (input.lines !== null) return problem(INVOICE_PROBLEM.LINES_INVALID, 'A claim-sourced invoice’s lines and retention are the claim’s certified figures and cannot be edited.')
    return { update: { ...header, ...stamp } }
  }
  if (input.lines === null) return problem(INVOICE_PROBLEM.LINES_INVALID, 'A direct invoice draft edit carries one amount and tax code per stored line.')
  const stored = Array.isArray(live.lineItems) ? live.lineItems : []
  if (input.lines.length !== stored.length) return problem(INVOICE_PROBLEM.LINES_INVALID, `One amount and tax code per stored line is required (expected ${stored.length}).`)
  if (stored.some(isVariationOriginLine)) return problem(INVOICE_PROBLEM.LINES_INVALID, 'A direct invoice cannot carry variation lines.')
  const poLines = Array.isArray(po?.lineItems) ? po.lineItems : []
  const version = CURRENT_CALC_VERSION
  const lines = []
  for (const [i, li] of stored.entries()) {
    if (input.lines[i].lineIndex !== i) return problem(INVOICE_PROBLEM.LINES_INVALID, 'One amount and tax code per stored line, in stored order.')
    const pl = poLines[li?.poLineIndex]
    if (!pl || pl.costCodeId !== li.costCodeId) return problem(INVOICE_PROBLEM.LINES_INVALID, `Line ${i + 1} no longer matches its purchase-order line.`)
    const amount = fromCents(roundToCents(input.lines[i].amount))
    const gst = gstForLineFor(amount, input.lines[i].taxCode, version)
    if (gst === null) return problem(INVOICE_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`)
    lines.push({ ...buildInvoiceLine(li, { amount, taxCode: input.lines[i].taxCode }), gstAmount: gst })
  }
  const draftError = validateInvoiceDraft({ lineItems: lines, supplierInvoiceNumber: input.supplierInvoiceNumber, invoiceDate: input.invoiceDate, retention: input.retention })
  if (draftError) return problem(INVOICE_PROBLEM.DRAFT_INVALID, draftError)
  const totals = invoiceTotalsFor(lines, input.retention, version)
  if (!totals) return problem(INVOICE_PROBLEM.OUT_OF_RANGE, 'The invoice total is outside the supported range.')
  return {
    update: {
      ...header, lineItems: lines,
      retention: totals.retention, retentionGst: totals.retentionGst, retentionTotal: totals.retentionTotal,
      subtotal: totals.subtotal, gstTotal: totals.gstTotal, grossTotal: totals.grossTotal,
      net: totals.net, payableGst: totals.payableGst, payableTotal: totals.payableTotal,
      calcVersion: version, sourceCalcVersion: null, ...stamp,
    },
  }
}

export function invoiceDraftAlreadyHolds(live, update) {
  for (const [k, v] of Object.entries(update)) {
    if (k === 'revision' || k === 'updatedAt' || k === 'updatedBy') continue
    if (JSON.stringify(live?.[k] ?? null) !== JSON.stringify(v)) return false
  }
  return true
}

// ── Verification at the point an invoice becomes authoritative ───────────────
//
// Approval freezes the authored content and POSTING is the financial counting
// point; both re-verify everything stored, under the invoice's OWN version,
// against its purchase order (direct) or its approved claim (claim-sourced):
//   · line identity and cost codes; no variation line on a direct invoice;
//   · direct: each line's GST is its tax code's GST under the version (a
//     legacy direct invoice may carry the GST of the unrounded figure it was
//     entered as — the legacy editor's own behaviour — and nothing else);
//   · claim-sourced: every stored line is a certified claim line at its
//     certified amount, GST only on GST lines, and the payable GST and total
//     ARE the claim's certified figures;
//   · the header is the invoice's own totals of its lines and retention.

const legacyGstSet = (amount, taxCode) => {
  const out = new Set([toCents(gstForLine(amount, taxCode))])
  for (const d of [-0.0049, 0.0049]) out.add(toCents(gstForLine(amount + d, taxCode)))
  return out
}

const HEADER_KEYS = ['subtotal', 'gstTotal', 'grossTotal', 'retention', 'retentionGst', 'retentionTotal', 'net', 'payableGst', 'payableTotal']

export function invoiceStoredProblem({ invoice, po, claim }) {
  const version = calcVersionOf(invoice)
  const fail = (reason, message, extra = {}) => problem(INVOICE_PROBLEM.FIGURES, message, { reason, ...extra })
  if (version === null) return fail('version', 'The invoice carries an unknown calculation version.')
  const lines = Array.isArray(invoice?.lineItems) ? invoice.lineItems : []
  if (lines.length === 0) return fail('lines', 'The invoice has no lines.')
  const identity = sourceLineIdentityError(lines, { poId: invoice.poId })
  if (identity) return fail('identity', identity)
  for (const [i, li] of lines.entries()) {
    if (!TAX_CODES.includes(li?.taxCode)) return fail('tax-code', `Line ${i + 1} carries no valid tax code.`, { line: i })
    if (typeof li.amount !== 'number' || !isWholeCents(li.amount) || typeof li.gstAmount !== 'number' || !isWholeCents(li.gstAmount)) {
      return fail('line-amount', `Line ${i + 1} stores an amount or GST that is not whole cents.`, { line: i })
    }
  }
  if (invoice.source === SI_SOURCE.PROGRESS_CLAIM) {
    if (!claim || claim.id !== invoice.progressClaimId || claim.status !== CLAIM_STATUS.APPROVED) return fail('claim', 'The invoice’s progress claim is not an approved claim of this project.')
    if (claim.poId !== invoice.poId || (claim.supplierId ?? null) !== (invoice.supplierId ?? null)) return fail('claim', 'The invoice names another purchase order or supplier than its claim.')
    const certified = (claim.lineItems ?? []).filter(l => toCents(l?.approvedThisPeriod) > 0)
    if (certified.length !== lines.length) return fail('claim-lines', 'The invoice lines are not the claim’s certified lines.')
    for (const [i, li] of lines.entries()) {
      const cl = certified[i]
      const sameSource = isVariationOriginLine(cl)
        ? li.variationId === cl.variationId && li.variationLineIndex === cl.variationLineIndex
        : li.poLineIndex === cl.poLineIndex
      if (!sameSource || li.costCodeId !== cl.costCodeId || toCents(li.amount) !== toCents(cl.approvedThisPeriod)) {
        return fail('claim-lines', `Line ${i + 1} is not the claim’s certified line.`, { line: i })
      }
      if (li.taxCode !== TAX_CODE.GST && toCents(li.gstAmount) !== 0) return fail('line-gst', `Line ${i + 1} carries GST on a ${li.taxCode} line.`, { line: i })
      if (toCents(li.gstAmount) < 0) return fail('line-gst', `Line ${i + 1} carries negative GST.`, { line: i })
    }
    if (toCents(invoice.payableGst) !== toCents(claim.approvedGst) || toCents(invoice.payableTotal) !== toCents(claim.approvedTotal)) {
      return fail('claim-totals', 'The invoice’s payable GST and total are not the claim’s certified figures.')
    }
    if (toCents(invoice.retention) !== Math.min(toCents(claim.retention), toCents(invoice.subtotal))) return fail('retention', 'The invoice retention is not the claim’s.')
  } else {
    if (invoice.source !== SI_SOURCE.DIRECT_PO) return fail('source', 'The invoice has no supported source.')
    const poLines = Array.isArray(po?.lineItems) ? po.lineItems : []
    if (!po || po.id !== invoice.poId) return fail('po', 'The invoice’s purchase order is not in this project.')
    for (const [i, li] of lines.entries()) {
      if (isVariationOriginLine(li)) return fail('identity', 'A direct invoice cannot carry a variation line.', { line: i })
      const pl = poLines[li.poLineIndex]
      if (!pl || pl.costCodeId !== li.costCodeId) return fail('po-line', `Line ${i + 1} does not match its purchase-order line.`, { line: i })
      const ok = version === CALC_VERSION.LEGACY
        ? legacyGstSet(li.amount, li.taxCode).has(toCents(li.gstAmount))
        : toCents(li.gstAmount) === toCents(gstForLineFor(li.amount, li.taxCode, version))
      if (!ok) return fail('line-gst', `Line ${i + 1} carries GST that is not its tax code’s.`, { line: i })
    }
  }
  const totals = invoiceTotalsFor(lines, invoice.retention, version)
  if (!totals) return fail('range', 'The invoice total is outside the supported range.')
  for (const key of HEADER_KEYS) {
    if (typeof invoice[key] !== 'number' || toCents(invoice[key]) !== toCents(totals[key])) return fail('header', `The invoice ${key} is not the total of its lines.`)
  }
  return null
}

// ── Transitions ──────────────────────────────────────────────────────────────

export const INVOICE_TRANSITION = {
  approve: { from: [SI_STATUS.DRAFT], to: SI_STATUS.APPROVED, at: 'approvedAt', by: 'approvedBy' },
  post:    { from: [SI_STATUS.APPROVED], to: SI_STATUS.POSTED, at: 'postedAt', by: 'postedBy' },
  cancel:  { from: [SI_STATUS.DRAFT, SI_STATUS.APPROVED], to: SI_STATUS.CANCELLED, at: 'cancelledAt', by: 'cancelledBy' },
}

// Posting a claim-sourced invoice requires its claim to LINK it (ADR-68): the
// claim document is the pairing's authority, and an invoice its claim does not
// name (legacy, or orphaned) is reconciled first.
export function postPairingProblem(invoice, claim) {
  if (invoice.source !== SI_SOURCE.PROGRESS_CLAIM) return null
  const link = claimInvoiceLink(claim)
  if (link.state !== CLAIM_INVOICE_LINK.LINKED || link.invoiceId !== invoice.id) {
    return problem(INVOICE_PROBLEM.NOT_LINKED, `${claim?.claimNumber || 'The claim'} does not link this invoice — link it on the Progress Claims tab before posting.`)
  }
  return null
}

// Why an existing invoice cannot be linked to `claim`, or null.
export function existingLinkProblem(claim, invoice) {
  if (!claim) return problem(INVOICE_PROBLEM.CLAIM_INVALID, 'This progress claim no longer exists.')
  if (!invoice) return problem(INVOICE_PROBLEM.CLAIM_INVALID, 'The supplier invoice no longer exists.')
  const name = claim.claimNumber || 'This progress claim'
  if (claim.status !== CLAIM_STATUS.APPROVED) return problem(INVOICE_PROBLEM.CLAIM_STALE, `${name} is not approved.`)
  const link = claimInvoiceLink(claim)
  if (link.state === CLAIM_INVOICE_LINK.LINKED) return problem(INVOICE_PROBLEM.ALREADY_INVOICED, `${name} is already linked to a supplier invoice.`, { linkedInvoiceId: link.invoiceId })
  if (link.state !== CLAIM_INVOICE_LINK.LEGACY && link.state !== CLAIM_INVOICE_LINK.UNLINKED) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${name} carries a malformed invoice link.`)
  const n = invoice.invoiceNumber || 'The invoice'
  if (invoice.source !== SI_SOURCE.PROGRESS_CLAIM) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${n} is not a claim-sourced invoice.`)
  if (invoice.progressClaimId !== claim.id) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${n} does not reference ${name}.`)
  if (invoice.poId !== claim.poId || (invoice.supplierId ?? null) !== (claim.supplierId ?? null)) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${n} names another purchase order or supplier than ${name}.`)
  if (![SI_STATUS.DRAFT, SI_STATUS.APPROVED, SI_STATUS.POSTED].includes(invoice.status)) return problem(INVOICE_PROBLEM.CLAIM_INVALID, `${n} is ${invoice.status} and reserves nothing.`)
  return null
}

// For tests and previews: the certified claim GST a set of claim amounts
// implies under a version (claimTotalsFor), exported once.
export const certifiedClaimGst = (amounts, retention, version) => claimTotalsFor(amounts, retention, version)?.gst ?? null
