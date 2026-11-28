import { toCents, isWholeCents, shareOfCents, shareStep } from './money'

// ── The supplier-invoice settlement ledger (Phase 2 step 4, ADR-94) ──────────
//
// ONE server-only document per supplier invoice
// (`…/projects/{projectId}/supplierInvoiceLedgers/{invoiceId}`) holding the
// running totals of everything POSTED against that invoice: supplier credit
// notes, retention releases and supplier-payment allocations. It is the
// enforcement device for the cumulative caps (G2, Deferred Controls 18 / 24 /
// 25) and for dependency-safe voids (G3): every posting or void of a credit,
// release or payment passes through it inside one backend transaction, so two
// concurrent postings contend on this document and the second is re-evaluated
// against the first. No Security Rule matches the collection — no client can
// read or write it — and nothing here is a display figure: every figure the
// app shows is still derived at read time from the documents themselves.
//
// All money is WHOLE CENTS as integers.
//
// ── The invoice figures (stored, never recomputed) ───────────────────────────
//
//   S, G    the invoice's stored subtotal and GST (the full taxable supply)
//   R, RG   the stored retention withheld (ex-GST) and its stored GST
//   P       the stored payableTotal = S + G − R − RG (what was due at posting)
//
// ── Retention (supplier model) ───────────────────────────────────────────────
//
// A supplier invoice's retention GST is a flat share of its retention — the
// claim certified GST on the NET, so the retained slice carries GST in
// proportion to its own ex-GST amount, not in proportion to the invoice's tax
// mix. (The client ledger's proportional model — lib/clientLedger.js, I4 — does
// NOT hold for supplier invoices and is deliberately not reused.) So:
//
//   retention consumed (ex-GST) = released + credited-retention    ≤ R
//   its GST                     = the cumulative share of RG
//         gst(this step) = shareStep(RG, consumedAfter, R, gstConsumedBefore)
//
// Releases and the retention part of credits draw on ONE pool, and the step
// that consumes the last of R takes all of RG still unconsumed — the explicit
// final remainder — so any sequence reconciles exactly to the STORED retention
// GST, whatever rounding produced it (ADR-91 Decision 4: no rate is applied to
// a derived document).
//
// ── Credits (G1 — credits against retained invoices) ─────────────────────────
//
// A credit note credits GROUPS of the invoice — its lines grouped by
// (cost code, tax code), the identity a supplier credit line has always
// carried. Per group: the credited ex-GST amount never exceeds the group's
// stored amount, and its GST is the cumulative share of the group's STORED GST
// (shareStep), so a full credit of a group reverses exactly what the invoice
// stores. On a retained invoice the credit also takes the same fraction of the
// retention STILL HELD as it takes of the amount STILL BILLED (the final credit
// takes all that is held); that part reduces retention held, the rest reduces
// the payable. A credit never raises what is payable (rounding direction below).
//
// ── Payments (Deferred Control 18) ───────────────────────────────────────────
//
//   payable basis = P + released gross − (credited gross − credited retention gross)
//   remaining     = basis − paid
//
// A NEW allocation must fit within `remaining`. Cash paid beyond what is due is
// recorded as the payment's UNALLOCATED amount (an existing, supported state),
// never allocated to an invoice. A credit posted after payment may still make
// `remaining` negative — money recoverable FROM the supplier, the existing
// surfaced state; it is not refused, because a supplier credit for defective
// work after payment is a legitimate commercial fact.
//
// ── Voids (G3) ───────────────────────────────────────────────────────────────
//
// A void reverses exactly the figures its entry stored. A release void that
// would leave the invoice paid beyond its basis is REFUSED (void the payment,
// or the part of it that depends on the release, first). Credit and payment
// voids only raise the basis or lower what is paid.

export const SUPPLIER_LEDGER_VERSION = 1

export const SUPPLIER_LEDGER_KIND = {
  CREDIT:       'credit',
  CREDIT_VOID:  'credit_void',
  RELEASE:      'release',
  RELEASE_VOID: 'release_void',
  PAYMENT:      'payment',
  PAYMENT_VOID: 'payment_void',
}

export const SUPPLIER_LEDGER_TOTAL_KEYS = [
  'creditedSubtotalCents', 'creditedGstCents',
  'creditedRetentionCents', 'creditedRetentionGstCents',
  'releasedRetentionCents', 'releasedRetentionGstCents',
  'paidCents',
]

export const emptySupplierLedger = () => ({
  seq: 0,
  creditedSubtotalCents: 0, creditedGstCents: 0,
  creditedRetentionCents: 0, creditedRetentionGstCents: 0,
  releasedRetentionCents: 0, releasedRetentionGstCents: 0,
  paidCents: 0,
  groups: {},
})

const isLedgerCents = (v) => Number.isSafeInteger(v) && v >= 0
const int = (v) => (Number.isInteger(v) ? v : 0)
const money = (cents) => (cents / 100).toFixed(2)

// Why a STORED ledger cannot be trusted (a figure that is not whole,
// non-negative and safe), or null. The backend refuses such a ledger rather
// than reading it as zero.
export function storedSupplierLedgerProblem(doc) {
  if (!doc) return null
  for (const key of ['seq', ...SUPPLIER_LEDGER_TOTAL_KEYS]) {
    if (doc[key] !== undefined && !isLedgerCents(doc[key])) return `The ledger figure ${key} is not a whole, non-negative number of cents.`
  }
  for (const [key, g] of Object.entries(doc.groups ?? {})) {
    if (!isLedgerCents(g?.amountCents) || !isLedgerCents(g?.gstCents)) return `The ledger figure groups.${key} is not a whole, non-negative number of cents.`
  }
  return null
}

export function readSupplierLedger(doc) {
  const out = emptySupplierLedger()
  if (!doc) return out
  out.seq = int(doc.seq)
  for (const key of SUPPLIER_LEDGER_TOTAL_KEYS) out[key] = int(doc[key])
  for (const [key, g] of Object.entries(doc.groups ?? {})) out.groups[key] = { amountCents: int(g?.amountCents), gstCents: int(g?.gstCents) }
  return out
}

// ── The invoice side ─────────────────────────────────────────────────────────

export const creditGroupKey = (costCodeId, taxCode) => `${costCodeId}|${taxCode}`

// The invoice's stored figures in cents and its credit groups, or { problem }
// when the stored invoice does not reconcile with itself (its lines with its
// header, or its payable with its gross and retention) — such an invoice can
// be neither credited nor released nor paid through the ledger.
export function supplierInvoiceFigures(invoice) {
  const S = toCents(invoice?.subtotal)
  const G = toCents(invoice?.gstTotal)
  const R = toCents(invoice?.retention)
  const RG = toCents(invoice?.retentionGst)
  const P = toCents(invoice?.payableTotal)
  const name = invoice?.invoiceNumber || 'This invoice'
  const groups = {}
  const order = []
  let lineSum = 0
  let lineGst = 0
  for (const li of Array.isArray(invoice?.lineItems) ? invoice.lineItems : []) {
    if (typeof li?.costCodeId !== 'string' || li.costCodeId === '' || typeof li?.taxCode !== 'string') {
      return { problem: `${name} carries a line with no cost code or tax code.` }
    }
    const key = creditGroupKey(li.costCodeId, li.taxCode)
    if (!groups[key]) { groups[key] = { costCodeId: li.costCodeId, costCodeName: typeof li.costCodeName === 'string' ? li.costCodeName : '', taxCode: li.taxCode, amountCents: 0, gstCents: 0 }; order.push(key) }
    const a = toCents(li.amount)
    const g = toCents(li.gstAmount)
    groups[key].amountCents += a
    groups[key].gstCents += g
    lineSum += a
    lineGst += g
  }
  if (lineSum !== S || lineGst !== G) return { problem: `${name} stores totals that do not reconcile to its own lines.` }
  if (R < 0 || RG < 0 || R > S) return { problem: `${name} stores a retention outside its subtotal.` }
  if (P !== S + G - R - RG) return { problem: `${name} stores a payable total that does not reconcile to its gross and retention.` }
  for (const key of order) {
    if (groups[key].amountCents < 0 || groups[key].gstCents < 0) return { problem: `${name} carries a negative line group, which cannot be credited.` }
  }
  return { S, G, R, RG, P, groups, order }
}

// ── Position and invariants ──────────────────────────────────────────────────

export function supplierLedgerPosition(figures, L) {
  const creditedGross = L.creditedSubtotalCents + L.creditedGstCents
  const creditedRetentionGross = L.creditedRetentionCents + L.creditedRetentionGstCents
  const releasedGross = L.releasedRetentionCents + L.releasedRetentionGstCents
  const basis = figures.P + releasedGross - (creditedGross - creditedRetentionGross)
  return {
    creditedGrossCents: creditedGross,
    creditedPayableGrossCents: creditedGross - creditedRetentionGross,
    releasedGrossCents: releasedGross,
    retentionHeldExCents: figures.R - L.releasedRetentionCents - L.creditedRetentionCents,
    retentionHeldGstCents: figures.RG - L.releasedRetentionGstCents - L.creditedRetentionGstCents,
    payableBasisCents: basis,
    remainingPayableCents: basis - L.paidCents,
  }
}

// The state invariants every ledger write must satisfy (payments excluded —
// see the header: an over-settled invoice is a representable state). Returns
// a reason, or null.
export function supplierLedgerProblem(figures, L) {
  for (const key of ['seq', ...SUPPLIER_LEDGER_TOTAL_KEYS]) {
    if (!isLedgerCents(L?.[key])) return `The ledger figure ${key} would not be a whole, non-negative number of cents.`
  }
  let sumA = 0
  let sumG = 0
  for (const [key, g] of Object.entries(L.groups ?? {})) {
    const source = figures.groups[key]
    if (!source) return `A credit names a cost code and tax code (${key.replace('|', ' · ')}) the invoice does not carry.`
    if (!isLedgerCents(g.amountCents) || !isLedgerCents(g.gstCents)) return `The credited figures of ${key} would not be whole, non-negative cents.`
    if (g.amountCents > source.amountCents) return `Credits on ${source.costCodeName || source.costCodeId} exceed the invoiced amount on it.`
    if (g.gstCents > source.gstCents) return `Credited GST on ${source.costCodeName || source.costCodeId} exceeds the GST invoiced on it.`
    sumA += g.amountCents
    sumG += g.gstCents
  }
  if (sumA !== L.creditedSubtotalCents || sumG !== L.creditedGstCents) return 'The credited totals do not equal the credited groups.'
  if (L.releasedRetentionCents + L.creditedRetentionCents > figures.R) return 'Retention released and credited together exceed the retention withheld.'
  if (L.releasedRetentionGstCents + L.creditedRetentionGstCents > figures.RG) return 'Retention GST released and credited together exceed the retention GST withheld.'
  if (L.creditedRetentionCents + L.creditedRetentionGstCents > L.creditedSubtotalCents + L.creditedGstCents) return 'The retention part of the credits exceeds the credits.'
  return null
}

// ── Corrective voids on an INCONSISTENT ledger (ADR-94) ─────────────────────
//
// How far a ledger state is outside each invariant, in whole cents (0 = held).
// A void on a ledger that history left inconsistent is CORRECTIVE only when no
// figure becomes negative and NO measure grows: it may shrink a breach or
// leave it, never widen one or open another.
export function supplierLedgerExcess(figures, L) {
  const over = (v) => (v > 0 ? v : 0)
  let groupAmount = 0
  let groupGst = 0
  let unknownGroups = 0
  let sumA = 0
  let sumG = 0
  for (const [key, g] of Object.entries(L.groups ?? {})) {
    const source = figures.groups[key]
    sumA += g.amountCents
    sumG += g.gstCents
    if (!source) { unknownGroups += Math.abs(g.amountCents) + Math.abs(g.gstCents); continue }
    groupAmount += over(g.amountCents - source.amountCents)
    groupGst += over(g.gstCents - source.gstCents)
  }
  return {
    groupAmount, groupGst, unknownGroups,
    totalsMismatch: Math.abs(sumA - L.creditedSubtotalCents) + Math.abs(sumG - L.creditedGstCents),
    retention: over(L.releasedRetentionCents + L.creditedRetentionCents - figures.R),
    retentionGst: over(L.releasedRetentionGstCents + L.creditedRetentionGstCents - figures.RG),
    retentionOverCredits: over(L.creditedRetentionCents + L.creditedRetentionGstCents - L.creditedSubtotalCents - L.creditedGstCents),
    overpaid: over(-supplierLedgerPosition(figures, L).remainingPayableCents),
  }
}

const hasNegativeFigure = (L) => SUPPLIER_LEDGER_TOTAL_KEYS.some(k => !(L[k] >= 0)) || Object.values(L.groups ?? {}).some(g => !(g.amountCents >= 0) || !(g.gstCents >= 0))

// Why moving an inconsistent ledger from `before` to `after` by a void is NOT
// a correction, or null.
export function correctiveVoidProblem(figures, before, after) {
  if (hasNegativeFigure(after)) return 'the void would leave a negative figure on the ledger'
  const b = supplierLedgerExcess(figures, before)
  const a = supplierLedgerExcess(figures, after)
  const worse = Object.keys(a).find(k => a[k] > b[k])
  return worse ? `the void would widen an existing inconsistency (${worse})` : null
}

// ── Allocation: credits ──────────────────────────────────────────────────────

// `rows` — [{ costCodeId, taxCode, amount }]. Returns { error } or, in whole
// cents: { lines: [{ costCodeId, costCodeName, taxCode, amountCents, gstCents }],
// subtotalCents, gstCents, retentionCents, retentionGstCents }.
export function allocateSupplierCredit(figures, L, rows) {
  const perGroup = new Map()
  for (const [i, row] of (rows ?? []).entries()) {
    const key = creditGroupKey(row?.costCodeId, row?.taxCode)
    const source = figures.groups[key]
    if (!source) return { error: `Line ${i + 1}: the invoice carries no ${row?.taxCode ?? ''} amount on that cost code.` }
    if (typeof row?.amount !== 'number' || !isWholeCents(row.amount)) return { error: `Line ${i + 1}: the credit amount must be a whole number of cents.` }
    const amountCents = toCents(row.amount)
    if (amountCents <= 0) return { error: `Line ${i + 1}: the credit amount must be greater than zero.` }
    if (perGroup.has(key)) return { error: `Line ${i + 1}: that cost code and tax code is credited twice — combine those lines.` }
    perGroup.set(key, amountCents)
  }
  if (perGroup.size === 0) return { error: 'Add at least one line with an amount.' }

  const lines = []
  let subtotalCents = 0
  let gstCents = 0
  for (const key of figures.order) {
    if (!perGroup.has(key)) continue
    const amountCents = perGroup.get(key)
    const source = figures.groups[key]
    const before = L.groups[key] ?? { amountCents: 0, gstCents: 0 }
    const after = before.amountCents + amountCents
    if (after > source.amountCents) {
      return { error: `${source.costCodeName || source.costCodeId}: only ${money(source.amountCents - before.amountCents)} of ${money(source.amountCents)} remains to credit.` }
    }
    const lineGst = shareStep(source.gstCents, after, source.amountCents, before.gstCents)
    lines.push({ costCodeId: source.costCodeId, costCodeName: source.costCodeName, taxCode: source.taxCode, amountCents, gstCents: lineGst })
    subtotalCents += amountCents
    gstCents += lineGst
  }

  // The retention part — the same fraction of retention HELD as of amount
  // STILL BILLED; the credit taking all that is still billed takes all held.
  const stillBilled = figures.S - L.creditedSubtotalCents
  const heldEx = figures.R - L.releasedRetentionCents - L.creditedRetentionCents
  const consumedEx = L.releasedRetentionCents + L.creditedRetentionCents
  const consumedGst = L.releasedRetentionGstCents + L.creditedRetentionGstCents
  const final = subtotalCents >= stillBilled
  const gstFor = (ex) => (ex <= 0 ? 0 : shareStep(figures.RG, consumedEx + ex, figures.R, consumedGst))
  let retentionCents = heldEx <= 0 ? 0 : (final ? heldEx : Math.min(shareOfCents(heldEx, subtotalCents, stillBilled), heldEx))
  let retentionGstCents = gstFor(retentionCents)
  // ROUNDING DIRECTION: the retained part never exceeds the credit itself, so
  // a credit never RAISES what is payable. Rounded down a cent at a time; the
  // remainder stays held and is taken by a later credit or release.
  while (!final && retentionCents > 0 && retentionCents + retentionGstCents > subtotalCents + gstCents) {
    retentionCents -= 1
    retentionGstCents = gstFor(retentionCents)
  }
  if (final && retentionCents + retentionGstCents > subtotalCents + gstCents) {
    return { error: 'This credit would release more retention than it credits — release the retention first.' }
  }
  return { lines, subtotalCents, gstCents, retentionCents, retentionGstCents }
}

// ── Allocation: releases ─────────────────────────────────────────────────────

export function allocateSupplierRelease(figures, L, amount) {
  if (typeof amount !== 'number' || !isWholeCents(amount)) return { error: 'The release amount must be a whole number of cents.' }
  const amountCents = toCents(amount)
  if (amountCents <= 0) return { error: 'The release amount must be greater than zero.' }
  const heldEx = figures.R - L.releasedRetentionCents - L.creditedRetentionCents
  if (amountCents > heldEx) return { error: `Only ${money(Math.max(0, heldEx))} of retention (ex-GST) is still held on this invoice.` }
  const consumedEx = L.releasedRetentionCents + L.creditedRetentionCents
  const consumedGst = L.releasedRetentionGstCents + L.creditedRetentionGstCents
  const gstCents = shareStep(figures.RG, consumedEx + amountCents, figures.R, consumedGst)
  return { amountCents, gstCents }
}

// ── Applying entries ─────────────────────────────────────────────────────────

const step = (L, kind, entryId) => ({
  ...L,
  groups: Object.fromEntries(Object.entries(L.groups).map(([k, v]) => [k, { ...v }])),
  seq: L.seq + 1,
  lastEntryId: entryId,
  lastEntryKind: kind,
})

// The whole-cent figures a stored supplier credit note carries.
export function supplierCreditCents(creditNote) {
  return {
    subtotalCents: toCents(creditNote?.subtotal),
    gstCents: toCents(creditNote?.gstTotal),
    retentionCents: toCents(creditNote?.retentionAmount),
    retentionGstCents: toCents(creditNote?.retentionGst),
    lines: (Array.isArray(creditNote?.lineItems) ? creditNote.lineItems : []).map(li => ({
      key: creditGroupKey(li?.costCodeId, li?.taxCode),
      amountCents: toCents(li?.amount),
      gstCents: toCents(li?.gstAmount),
    })),
  }
}

function moveCredit(L, creditNote, sign, kind) {
  const c = supplierCreditCents(creditNote)
  const next = step(L, kind, creditNote.id)
  next.creditedSubtotalCents += sign * c.subtotalCents
  next.creditedGstCents += sign * c.gstCents
  next.creditedRetentionCents += sign * c.retentionCents
  next.creditedRetentionGstCents += sign * c.retentionGstCents
  for (const li of c.lines) {
    const before = next.groups[li.key] ?? { amountCents: 0, gstCents: 0 }
    next.groups[li.key] = { amountCents: before.amountCents + sign * li.amountCents, gstCents: before.gstCents + sign * li.gstCents }
  }
  return next
}

export const applySupplierCredit = (L, creditNote) => moveCredit(L, creditNote, 1, SUPPLIER_LEDGER_KIND.CREDIT)
export const applySupplierCreditVoid = (L, creditNote) => moveCredit(L, creditNote, -1, SUPPLIER_LEDGER_KIND.CREDIT_VOID)

function moveRelease(L, release, sign, kind) {
  const next = step(L, kind, release.id)
  next.releasedRetentionCents += sign * toCents(release?.amount)
  next.releasedRetentionGstCents += sign * toCents(release?.gstAmount)
  return next
}
export const applySupplierRelease = (L, release) => moveRelease(L, release, 1, SUPPLIER_LEDGER_KIND.RELEASE)
export const applySupplierReleaseVoid = (L, release) => moveRelease(L, release, -1, SUPPLIER_LEDGER_KIND.RELEASE_VOID)

export function applySupplierPayment(L, cents, paymentId) {
  const next = step(L, SUPPLIER_LEDGER_KIND.PAYMENT, paymentId)
  next.paidCents = L.paidCents + cents
  return next
}
export function applySupplierPaymentVoid(L, cents, paymentId) {
  const next = step(L, SUPPLIER_LEDGER_KIND.PAYMENT_VOID, paymentId)
  next.paidCents = L.paidCents - cents
  return next
}

// Why allocating `cents` of a new payment to this invoice is refused, or null.
export function paymentAllocationProblem(figures, L, cents, invoiceNumber = 'this invoice') {
  if (!Number.isSafeInteger(cents) || cents <= 0) return `An allocation to ${invoiceNumber} must be greater than zero.`
  const { remainingPayableCents } = supplierLedgerPosition(figures, L)
  if (cents > remainingPayableCents) {
    return `Only ${money(Math.max(0, remainingPayableCents))} remains payable on ${invoiceNumber}. Record the rest of the payment as unallocated.`
  }
  return null
}

// Why voiding this posted release is refused, or null: after the void the
// invoice must not be paid beyond its basis (G3).
export function releaseVoidDependency(figures, L, release, invoiceNumber = 'this invoice') {
  const after = applySupplierReleaseVoid(L, release)
  const { remainingPayableCents } = supplierLedgerPosition(figures, after)
  if (remainingPayableCents < 0 && remainingPayableCents < supplierLedgerPosition(figures, L).remainingPayableCents) {
    return `Payments on ${invoiceNumber} depend on this release: voiding it would leave the invoice paid ${money(-remainingPayableCents)} beyond what is due. Void or reduce those payments first.`
  }
  return null
}
export function releaseVoidProblem(figures, L, release, invoiceNumber = 'this invoice') {
  return supplierLedgerProblem(figures, applySupplierReleaseVoid(L, release)) ?? releaseVoidDependency(figures, L, release, invoiceNumber)
}

// The stored shape of a ledger state (the stamps are added by the backend).
export function supplierLedgerDocument(L) {
  const doc = { seq: L.seq, groups: L.groups, lastEntryId: L.lastEntryId ?? null, lastEntryKind: L.lastEntryKind ?? null }
  for (const key of SUPPLIER_LEDGER_TOTAL_KEYS) doc[key] = L[key]
  return doc
}

// ── The historical baseline (computed from the registers) ────────────────────
//
// `invoices` — every supplier invoice of the project (id → document);
// `creditNotes`, `releases`, `payments` — every document of those registers.
// Only POSTED credit notes, releases and payments are history; drafts and
// voids moved nothing. Returns:
//
//   { problem }  — a POSTED payment whose allocations cannot be attributed
//                  (malformed array, non-positive or fraction-of-a-cent
//                  amount, no invoice id): the project baseline is refused
//                  naming it — never skipped, so a sum can never be short;
//   { ledgers }  — Map invoiceId → { state, problem, ledger, sources }, for
//                  every invoice any posted entry names. `state` is
//                  'established', or 'inconsistent' with the reason (an
//                  over-credit, an over-release, a credit on a cost code the
//                  invoice does not carry, an invoice that does not reconcile
//                  with itself, an entry naming an invoice that does not
//                  exist). An inconsistent ledger refuses every posting on its
//                  invoice until it is corrected by voids; it is never clamped.
//
// Historical credit notes and releases are taken at their STORED figures,
// whatever arithmetic produced them.
// A posted historical entry whose OWN stored figures are malformed (a negative
// credit figure, a release that is not positive) keeps its invoice's ledger
// inconsistent until THAT entry is voided — whatever the totals then say. The
// ids are stored on the ledger (bounded); beyond the bound the ledger can only
// be reviewed, never auto-restored.
export const MALFORMED_ENTRY_IDS_MAX = 50

export function supplierLedgersFromHistory({ invoices, creditNotes = [], releases = [], payments = [] }) {
  const byInvoice = new Map()
  const entry = (id) => {
    if (!byInvoice.has(id)) byInvoice.set(id, { ledger: emptySupplierLedger(), sources: { credits: 0, releases: 0, payments: 0 }, problems: [], malformed: [] })
    return byInvoice.get(id)
  }
  for (const p of payments) {
    if (p?.status !== 'posted') continue
    const allocations = p.allocations
    if (allocations != null && !Array.isArray(allocations)) return { problem: `${p.paymentNumber || p.id} stores allocations that are not a list.` }
    for (const a of allocations ?? []) {
      if (typeof a?.supplierInvoiceId !== 'string' || a.supplierInvoiceId === '') return { problem: `${p.paymentNumber || p.id} has an allocation naming no invoice.` }
      if (typeof a.allocatedAmount !== 'number' || !isWholeCents(a.allocatedAmount) || a.allocatedAmount <= 0) {
        return { problem: `${p.paymentNumber || p.id} has an allocation that is not a positive whole number of cents.` }
      }
      const e = entry(a.supplierInvoiceId)
      e.ledger.paidCents += toCents(a.allocatedAmount)
      e.sources.payments += 1
    }
  }
  for (const c of creditNotes) {
    if (c?.status !== 'posted') continue
    if (typeof c.supplierInvoiceId !== 'string' || c.supplierInvoiceId === '') return { problem: `${c.creditNoteNumber || c.id} is a posted credit note naming no invoice.` }
    const e = entry(c.supplierInvoiceId)
    const cents = supplierCreditCents(c)
    const malformed = [cents.subtotalCents, cents.gstCents, cents.retentionCents, cents.retentionGstCents].some(v => v < 0)
      || cents.lines.some(l => l.amountCents < 0 || l.gstCents < 0)
    if (malformed) { e.problems.push(`${c.creditNoteNumber || c.id} stores a negative figure.`); e.malformed.push(c.id) }
    e.ledger = applySupplierCredit(e.ledger, c)
    e.sources.credits += 1
  }
  for (const r of releases) {
    if (r?.status !== 'posted') continue
    if (typeof r.supplierInvoiceId !== 'string' || r.supplierInvoiceId === '') return { problem: `${r.releaseNumber || r.id} is a posted release naming no invoice.` }
    const e = entry(r.supplierInvoiceId)
    if (toCents(r.amount) <= 0 || toCents(r.gstAmount) < 0) { e.problems.push(`${r.releaseNumber || r.id} stores a release amount that is not positive.`); e.malformed.push(r.id) }
    e.ledger = applySupplierRelease(e.ledger, r)
    e.sources.releases += 1
  }
  const ledgers = new Map()
  for (const [invoiceId, e] of byInvoice) {
    const invoice = invoices instanceof Map ? invoices.get(invoiceId) : invoices?.[invoiceId]
    // A baseline records history, not the last entry.
    const ledger = { ...e.ledger, seq: 0, lastEntryId: null, lastEntryKind: null }
    let problem = e.problems[0] ?? null
    if (!problem && !invoice) problem = 'Posted entries name an invoice that does not exist.'
    let figures = null
    if (!problem) {
      figures = supplierInvoiceFigures(invoice)
      if (figures.problem) problem = figures.problem
    }
    if (!problem) problem = supplierLedgerProblem(figures, ledger)
    ledgers.set(invoiceId, { state: problem ? 'inconsistent' : 'established', problem, ledger, sources: e.sources, malformedEntryIds: e.malformed.slice(0, MALFORMED_ENTRY_IDS_MAX), malformedOverflow: e.malformed.length > MALFORMED_ENTRY_IDS_MAX })
  }
  return { ledgers }
}

// The ledger of ONE invoice derived from the registers the browser holds — the
// same history arithmetic, for previews and read-time cross-checks.
export function supplierLedgerFromRegisters(invoice, { creditNotes = [], releases = [], payments = [] } = {}) {
  if (!invoice?.id) return { state: 'established', ledger: emptySupplierLedger(), problem: null }
  const only = (list) => (list ?? []).filter(d => d?.supplierInvoiceId === invoice.id)
  const pays = (payments ?? []).filter(p => (p?.allocations ?? []).some(a => a?.supplierInvoiceId === invoice.id))
    .map(p => ({ ...p, allocations: (p.allocations ?? []).filter(a => a?.supplierInvoiceId === invoice.id) }))
  const { problem, ledgers } = supplierLedgersFromHistory({ invoices: { [invoice.id]: invoice }, creditNotes: only(creditNotes), releases: only(releases), payments: pays })
  if (problem) return { state: 'inconsistent', ledger: emptySupplierLedger(), problem }
  return ledgers.get(invoice.id) ?? { state: 'established', ledger: emptySupplierLedger(), problem: null }
}
