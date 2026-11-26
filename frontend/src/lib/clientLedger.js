import { toCents, isWholeCents, shareOfCents, shareStep } from './money'
import { invoiceRetention } from './clientInvoices'

// ── The client-invoice receivable ledger (ADR-87 / ADR-88) ───────────────────
//
// ONE document per issued client invoice
// (`…/projects/{projectId}/clientInvoiceLedgers/{invoiceId}`) holding the
// running totals of everything posted AGAINST that invoice: client credit
// notes and client retention releases.
//
// ⚠️ THE LEDGER IS THE ENFORCEMENT DEVICE, NOT THE SOURCE OF FIGURES. A
// cumulative cap needs one document every posting must pass through. The ledger
// is WRITTEN ONLY BY THE TRUSTED BACKEND (ADR-89): posting or voiding a credit
// note or a release, the ledger movement and one audit event are one server
// transaction, in which the server re-derives the entry from the invoice and
// this ledger with THIS MODULE (its generated copy,
// functions/src/generated/clientFinanceCalc.js) and requires every invariant
// below to hold. Two concurrent postings contend on this document, so one is
// retried against the new totals and refused if it no longer fits. Firestore
// Rules give clients no write to it at all.
//
// Every figure the app shows is still derived at read time from the documents
// themselves (lib/clientReceivables.js). A ledger that disagrees with its
// documents is reported as an exception, never trusted over them.
//
// ⚠️ A MISSING LEDGER MEANS NOTHING IS POSTED AGAINST THE INVOICE — once the
// project's receipt baseline exists (below), and the backend refuses every
// operation until it does. The ledger is never deleted or reset. It also
// carries `receivedCents` (below): what posted receipts have allocated to the
// invoice, so that voiding a retention release — the one decision that depends
// on receipts — reads this document and never a project's receipt history.
//
// All ledger money is WHOLE CENTS as integers.

export const LEDGER_KIND = {
  CREDIT:       'credit',
  CREDIT_VOID:  'credit_void',
  RELEASE:      'release',
  RELEASE_VOID: 'release_void',
  RECEIPT:      'receipt',
  RECEIPT_VOID: 'receipt_void',
}

// ⚠️ RECEIVED (ADR-89, receipt dependency). `receivedCents` is what POSTED
// client receipts have allocated to this invoice, maintained by the trusted
// backend in the transaction that posts or voids a receipt. It exists so that
// a decision which depends on receipts — above all, voiding a retention release
// — reads ONE document instead of scanning a project's receipt history.
//
// IT IS EXACT. Receipts posted BEFORE posting became a backend operation are
// brought into it ONCE per project by the receipt baseline
// (functions/src/clientFinance/baseline.js): every posted receipt of the
// project is summed per invoice, each sum becomes that ledger's `receivedCents`
// with a permanent `receiptBaseline` record beside it, and a marker document
// records that it was done. The backend refuses every posting and void on a
// project whose marker is absent, so a missing baseline is never read as zero;
// once the marker exists, a missing ledger or an absent `receivedCents` means
// exactly zero. From then on the figure moves only with a receipt posted or
// voided by the backend.
//
// It is deliberately NOT one of LEDGER_TOTAL_KEYS: no invariant constrains it
// (over-allocating an invoice is the approved warn-and-acknowledge policy), and
// it is not cross-checked against credit notes and releases.

export const LEDGER_TOTAL_KEYS = [
  'creditedSubtotalCents', 'creditedGstCents',
  'creditedRetentionCents', 'creditedRetentionGstCents',
  'releasedRetentionCents', 'releasedRetentionGstCents',
]

export const emptyLedger = () => ({
  seq: 0,
  creditedSubtotalCents: 0, creditedGstCents: 0,
  creditedRetentionCents: 0, creditedRetentionGstCents: 0,
  releasedRetentionCents: 0, releasedRetentionGstCents: 0,
  receivedCents: 0,
  lines: {},
})

const int = (v) => (Number.isInteger(v) ? v : 0)

// Whole cents the ledger may carry: an integer, not negative, and exactly
// representable (a total past 2^53 would no longer add up).
const isLedgerCents = (v) => Number.isSafeInteger(v) && v >= 0

// (a function, so a bundle that needs no ledger check carries none of this)
const ledgerFigureKeys = () => ['seq', ...LEDGER_TOTAL_KEYS, 'receivedCents']
const figureProblem = (key) => `The ledger figure ${key} is not a whole, non-negative number of cents.`

// Why a STORED ledger document cannot be trusted, or null. `readLedger` reads
// leniently (the browser must render whatever is stored); the trusted backend
// calls this first and REFUSES a ledger carrying a figure that is not whole,
// non-negative and safe, rather than reading it as zero. An absent figure is
// zero; a figure that is present must be valid.
export function storedLedgerProblem(doc) {
  if (!doc) return null
  for (const key of ledgerFigureKeys()) {
    if (doc[key] !== undefined && !isLedgerCents(doc[key])) return figureProblem(key)
  }
  for (const [index, line] of Object.entries(doc.lines ?? {})) {
    if (!isLedgerCents(line?.amountCents) || !isLedgerCents(line?.gstCents)) return figureProblem(`lines.${index}`)
  }
  if (doc.receiptBaseline !== undefined && !isLedgerCents(doc.receiptBaseline?.legacyCents)) return figureProblem('receiptBaseline.legacyCents')
  return null
}

// Why a ledger STATE may not be written, or null: every running figure whole,
// non-negative and safe. Needs no invoice, so it guards every ledger write —
// a receipt's as well as a credit note's.
export function ledgerStateProblem(ledger) {
  for (const key of ledgerFigureKeys()) {
    if (!isLedgerCents(ledger?.[key])) return figureProblem(key)
  }
  return null
}

// A stored ledger document (or null / undefined when none exists) as a plain,
// fully-populated state.
export function readLedger(doc) {
  const out = emptyLedger()
  if (!doc) return out
  out.seq = int(doc.seq)
  for (const key of LEDGER_TOTAL_KEYS) out[key] = int(doc[key])
  out.receivedCents = int(doc.receivedCents)
  for (const [index, line] of Object.entries(doc.lines ?? {})) {
    out.lines[index] = { amountCents: int(line?.amountCents), gstCents: int(line?.gstCents) }
  }
  return out
}

// ── Invariants (checked by the trusted backend on every ledger movement) ─────
//
//   S, G   — the invoice's stored subtotal and GST
//   R, RG  — the invoice's stored retention and retention GST
//
//   I1  0 ≤ credited ≤ S and 0 ≤ creditedGst ≤ G; a FULL credit (credited = S)
//       reverses the stored GST exactly (creditedGst = G).
//   I2  creditedRetention + released ≤ R, and the same for their GST: retention
//       still held never goes negative, and is never both credited and released.
//   I3  retention still held never exceeds what is still BILLED, ex-GST
//       (R − released − creditedRetention ≤ S − credited): the part of the
//       credits that fell on the receivable never exceeds what is receivable.
//       With I1 this forces a full credit to clear the retention held.
//   I4  THE RETAINED SLICE CARRIES NO MORE THAN ITS SHARE OF THE GST STILL
//       BILLED: retention GST held ≤ share(GST still billed, retention held,
//       amount still billed), exactly. It follows that retention GST held
//       never exceeds the GST still billed, that none is held once no ex-GST
//       retention is held, and that the receivable basis is never negative.
//       Every credit and release preserves it by construction. A VOID may
//       not: voiding an entry after later entries were computed on top of it
//       can leave the slice carrying GST at a stale proportion — such a void
//       is REFUSED, and the later entries are voided first. Without this, the
//       next credit would "true up" and move the surplus into the receivable.
//
// The most retention GST that `heldEx` of retention may carry in this state:
// the retained fraction of the GST still billed (whole cents, round-half-up).
function retainedGstShare(inv, L, heldEx) {
  return shareOfCents(
    Math.max(0, inv.gstCents - L.creditedGstCents),
    Math.max(0, heldEx),
    inv.subtotalCents - L.creditedSubtotalCents,
  )
}

// Returns a reason, or null when the state is valid.
export function ledgerInvariantError(invoice, ledger) {
  const inv = invoiceRetention(invoice)
  const L = ledger
  const figure = ledgerStateProblem(L)
  if (figure) return figure
  if (L.creditedSubtotalCents > inv.subtotalCents) return 'Credits exceed the invoice subtotal.'
  if (L.creditedGstCents > inv.gstCents) return 'Credited GST exceeds the invoice GST.'
  if (L.creditedSubtotalCents === inv.subtotalCents && L.creditedGstCents !== inv.gstCents) {
    return 'A full credit must reverse the invoice GST exactly.'
  }
  if (L.creditedRetentionCents + L.releasedRetentionCents > inv.retentionCents) {
    return 'Retention credited and released together exceed the retention withheld.'
  }
  if (L.creditedRetentionGstCents + L.releasedRetentionGstCents > inv.retentionGstCents) {
    return 'Retention GST credited and released together exceed the retention GST withheld.'
  }
  const receivableEx = inv.subtotalCents - inv.retentionCents + L.releasedRetentionCents
  if (L.creditedSubtotalCents - L.creditedRetentionCents > receivableEx) {
    return 'Credits against the receivable part exceed what is receivable.'
  }
  const heldEx = inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents
  const heldGst = inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents
  if (heldGst > retainedGstShare(inv, L, heldEx)) {
    return 'Retention GST held would exceed the retained share of the GST still billed.'
  }
  return null
}

// ── Derived position of one invoice (all whole cents, gross unless named) ────
//
//   retentionHeld   = retentionTotal − released − credited-retention
//   receivableBasis = receivableTotal + released − (credited − credited-retention)
//
// `receivableBasis` is what the client owes NOW before receipts. It can exceed
// nothing and can be driven negative only by receipts, never by the ledger (I3).
export function ledgerPosition(invoice, ledger) {
  const inv = invoiceRetention(invoice)
  const L = ledger ?? emptyLedger()
  const creditedGross = L.creditedSubtotalCents + L.creditedGstCents
  const creditedRetentionGross = L.creditedRetentionCents + L.creditedRetentionGstCents
  const releasedGross = L.releasedRetentionCents + L.releasedRetentionGstCents
  return {
    ...inv,
    creditedSubtotalCents: L.creditedSubtotalCents,
    creditedGstCents: L.creditedGstCents,
    creditedGrossCents: creditedGross,
    creditedRetentionGrossCents: creditedRetentionGross,
    releasedGrossCents: releasedGross,
    netIssuedSubtotalCents: inv.subtotalCents - L.creditedSubtotalCents,
    netIssuedGrossCents: inv.grossCents - creditedGross,
    retentionHeldExCents: inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents,
    retentionHeldGstCents: inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents,
    retentionHeldCents: inv.retentionTotalCents - releasedGross - creditedRetentionGross,
    receivableBasisCents: inv.receivableCents + releasedGross - (creditedGross - creditedRetentionGross),
  }
}

// ── Credit allocation ────────────────────────────────────────────────────────
//
// A credit note credits SOURCE LINES of its invoice. Everything else follows
// deterministically from the invoice's stored figures and the ledger:
//
//  · LINE GST — the cumulative share of the source line's STORED gstAmount:
//      gst(this credit) = share(lineGst, creditedAfter, lineAmount) − gst already credited
//    and when the line is fully credited the cumulative GST IS the stored
//    gstAmount (the explicit final remainder). A full credit therefore
//    reverses exactly what the invoice stores, whatever rounding produced it,
//    and partial credits never each round their own share.
//
//  · RETENTION — the credit takes the same fraction of the retention STILL
//    HELD as it takes of the amount STILL BILLED:
//      retention part = share(retention held, this credit, billed and not yet credited)
//    Before any release that is the proportion the invoice withheld (R ÷ S).
//    Released retention is never clawed back and never "caught up": after a
//    release the held retention is smaller, and each credit takes its fraction
//    of what is left. The credit that takes the remaining billed amount takes
//    ALL the retention still held (the explicit final remainder).
//    Its GST: after the credit, the retention GST still HELD is the retained
//    fraction of the GST STILL BILLED —
//      held GST (after) = share(GST still billed, retention held, amount still billed)
//    never more than was held before, and nil once no ex-GST retention is held.
//    The retention GST part of the credit is whatever that removes. So the
//    retained slice always carries the GST of what it is a slice OF: crediting a
//    GST-free line of a mixed-tax invoice frees no retention GST, crediting a
//    taxable line frees its retained share, and a credit never RAISES what is
//    receivable. (Two earlier formulas — a share of the credit's own GST, then
//    a share of the GST held — were each wrong on mixed-tax invoices: the first
//    could strand retention GST, the second could move GST from the retained
//    slice into the receivable. ADR-88, *Corrections*.)
//
// `rows` — [{ invoiceLineIndex, amount }]. Returns { error } or the allocation
// in whole cents.
export function allocateCredit(invoice, ledgerState, rows) {
  const inv = invoiceRetention(invoice)
  const L = ledgerState ?? emptyLedger()
  const sourceLines = Array.isArray(invoice?.lineItems) ? invoice.lineItems : []

  const sourceSubtotal = sourceLines.reduce((sum, li) => sum + toCents(li?.amount), 0)
  const sourceGst = sourceLines.reduce((sum, li) => sum + toCents(li?.gstAmount), 0)
  if (sourceSubtotal !== inv.subtotalCents || sourceGst !== inv.gstCents) {
    return { error: `${invoice?.invoiceNumber || 'This invoice'} stores totals that do not reconcile to its own lines, so it cannot be credited.` }
  }

  const perLine = new Map()
  for (const row of rows ?? []) {
    // The index must BE an integer: `null`, '' or '1' are refused, never coerced
    // into a line the caller did not name.
    const index = row?.invoiceLineIndex
    const amountCents = toCents(row?.amount)
    if (!Number.isInteger(index) || index < 0 || index >= sourceLines.length) {
      return { error: 'A credit line does not name a line of the invoice.' }
    }
    if (amountCents <= 0) return { error: `Line ${index + 1}: the credit amount must be greater than zero.` }
    // Never rounded silently: 10.005 is refused, not stored as 10.01.
    if (!isWholeCents(Number(row?.amount))) {
      return { error: `Line ${index + 1}: the credit amount cannot carry a fraction of a cent.` }
    }
    if (perLine.has(index)) return { error: `Line ${index + 1} is credited twice — combine those rows.` }
    perLine.set(index, amountCents)
  }
  if (perLine.size === 0) return { error: 'Add at least one line with an amount.' }

  const lines = []
  let subtotalCents = 0
  let gstCents = 0
  for (const [index, amountCents] of [...perLine.entries()].sort((a, b) => a[0] - b[0])) {
    const lineAmount = toCents(sourceLines[index]?.amount)
    const lineGst = toCents(sourceLines[index]?.gstAmount)
    const before = L.lines[index] ?? { amountCents: 0, gstCents: 0 }
    const after = before.amountCents + amountCents
    if (after > lineAmount) {
      return { error: `Line ${index + 1}: only ${((lineAmount - before.amountCents) / 100).toFixed(2)} of ${(lineAmount / 100).toFixed(2)} remains to credit.` }
    }
    const lineGstStep = shareStep(lineGst, after, lineAmount, before.gstCents)
    lines.push({ invoiceLineIndex: index, amountCents, gstCents: lineGstStep })
    subtotalCents += amountCents
    gstCents += lineGstStep
  }

  const creditedAfter = L.creditedSubtotalCents + subtotalCents
  const stillBilled = inv.subtotalCents - L.creditedSubtotalCents
  const heldEx = inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents
  const heldGst = inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents

  // Never less than I3 requires (reachable only after a void rearranged the
  // totals); never more than what is held or than the credit itself.
  const retentionFloor = Math.max(0, creditedAfter - L.creditedRetentionCents
    - (inv.subtotalCents - inv.retentionCents + L.releasedRetentionCents))
  // The retention GST the credit takes for a given ex-GST retention part.
  const retentionGstFor = (retention) => {
    const heldExAfter = heldEx - retention
    const heldGstAfter = heldExAfter <= 0
      ? 0
      : Math.min(
        Math.max(0, heldGst),
        shareOfCents(
          Math.max(0, inv.gstCents - (L.creditedGstCents + gstCents)),
          heldExAfter,
          inv.subtotalCents - creditedAfter,
        ),
      )
    return Math.max(0, heldGst - heldGstAfter)
  }

  const final = subtotalCents >= stillBilled
  let retentionCents = final
    ? Math.max(0, heldEx)
    : Math.max(Math.min(shareOfCents(Math.max(0, heldEx), subtotalCents, stillBilled), heldEx, subtotalCents), retentionFloor)
  let retentionGstCents = retentionGstFor(retentionCents)

  // ROUNDING DIRECTION, chosen so that a credit never RAISES what is receivable.
  // The share above is rounded half-up, and so is the retained share of the GST;
  // on very small amounts the two roundings can together exceed the credit
  // itself (1.00 taxable, 0.55 retained, a 0.01 credit: retention 0.01 + GST
  // 0.01 against a 0.01 credit), which would leave the receivable part of the
  // credit NEGATIVE. When that happens the ex-GST retention part is rounded
  // DOWN instead — one cent at a time, never below what invariant I3 requires —
  // until the retained part fits inside the credit. The remainder stays held and
  // is taken by a later credit or by the final one, so every total still
  // reconciles exactly. Never applied to the final credit (it takes all that is
  // held, and leaves the basis at nil).
  while (!final
    && retentionCents + retentionGstCents > subtotalCents + gstCents
    && retentionCents > retentionFloor) {
    retentionCents -= 1
    retentionGstCents = retentionGstFor(retentionCents)
  }

  return { lines, subtotalCents, gstCents, retentionCents, retentionGstCents }
}

// ── Release allocation ───────────────────────────────────────────────────────
//
// GST on a release follows the same rule as a credit's retention GST: after the
// release, the retention GST still HELD is the retained fraction of the GST
// still billed (never more than was held), and the release takes the rest. The
// release that takes the retention held to zero releases ALL the retention GST
// still held (the explicit final remainder), so any split reconciles exactly to
// the invoice's STORED retention GST, whatever rounding produced it — no rate
// is applied, and no rounding drift can build up across releases.
export function allocateRelease(invoice, ledgerState, amount) {
  const inv = invoiceRetention(invoice)
  const L = ledgerState ?? emptyLedger()
  const amountCents = toCents(amount)
  if (amountCents <= 0) return { error: 'The release amount must be greater than zero.' }
  if (!isWholeCents(Number(amount))) return { error: 'The release amount cannot carry a fraction of a cent.' }
  const heldEx = inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents
  const heldGst = inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents
  if (amountCents > heldEx) {
    return { error: `Only ${(Math.max(0, heldEx) / 100).toFixed(2)} of retention (ex-GST) is still held on ${invoice?.invoiceNumber || 'this invoice'}.` }
  }
  const heldGstAfter = amountCents === heldEx
    ? 0
    : Math.min(Math.max(0, heldGst), retainedGstShare(inv, L, heldEx - amountCents))
  const gstCents = Math.max(0, heldGst - heldGstAfter)
  return { amountCents, gstCents }
}

// ── Applying an entry (the next ledger state) ────────────────────────────────

const step = (ledgerState, kind, entryId) => ({
  ...ledgerState,
  lines: Object.fromEntries(Object.entries(ledgerState.lines).map(([k, v]) => [k, { ...v }])),
  seq: ledgerState.seq + 1,
  lastEntryId: entryId,
  lastEntryKind: kind,
})

// The whole-cent figures a stored credit note carries.
export function creditNoteCents(creditNote) {
  return {
    subtotalCents: toCents(creditNote?.subtotal),
    gstCents: toCents(creditNote?.gstTotal),
    retentionCents: toCents(creditNote?.retentionAmount),
    retentionGstCents: toCents(creditNote?.retentionGst),
    lines: (creditNote?.lineItems ?? []).map(li => ({
      invoiceLineIndex: li?.invoiceLineIndex,
      amountCents: toCents(li?.amount),
      gstCents: toCents(li?.gstAmount),
    })),
  }
}

function moveCredit(ledgerState, creditNote, sign, kind) {
  const c = creditNoteCents(creditNote)
  const next = step(ledgerState, kind, creditNote.id)
  next.creditedSubtotalCents += sign * c.subtotalCents
  next.creditedGstCents += sign * c.gstCents
  next.creditedRetentionCents += sign * c.retentionCents
  next.creditedRetentionGstCents += sign * c.retentionGstCents
  for (const li of c.lines) {
    const key = String(li.invoiceLineIndex)
    const before = next.lines[key] ?? { amountCents: 0, gstCents: 0 }
    next.lines[key] = {
      amountCents: before.amountCents + sign * li.amountCents,
      gstCents: before.gstCents + sign * li.gstCents,
    }
  }
  return next
}

export const applyCredit = (ledgerState, creditNote) => moveCredit(ledgerState, creditNote, 1, LEDGER_KIND.CREDIT)
export const applyCreditVoid = (ledgerState, creditNote) => moveCredit(ledgerState, creditNote, -1, LEDGER_KIND.CREDIT_VOID)

function moveRelease(ledgerState, release, sign, kind) {
  const next = step(ledgerState, kind, release.id)
  next.releasedRetentionCents += sign * toCents(release?.amount)
  next.releasedRetentionGstCents += sign * toCents(release?.gstAmount)
  return next
}

// A posted receipt's allocation to THIS invoice (whole cents), and its reversal.
// NOTHING IS CLAMPED: the figure is exact, so a void that would take back more
// than is recorded leaves a NEGATIVE figure here — which `ledgerStateProblem`
// names and the backend refuses, writing nothing. It is never read as zero.
export function applyReceipt(ledgerState, allocatedCents, receiptId) {
  const next = step(ledgerState, LEDGER_KIND.RECEIPT, receiptId)
  next.receivedCents = (ledgerState.receivedCents ?? 0) + allocatedCents
  return next
}
export function applyReceiptVoid(ledgerState, allocatedCents, receiptId) {
  const next = step(ledgerState, LEDGER_KIND.RECEIPT_VOID, receiptId)
  next.receivedCents = (ledgerState.receivedCents ?? 0) - allocatedCents
  return next
}

// What the invoice is owed NOW less what posted receipts have allocated to it
// (whole cents, signed). Negative = owed to the client.
export function ledgerRemainingCents(invoice, ledgerState) {
  return ledgerPosition(invoice, ledgerState).receivableBasisCents - (ledgerState?.receivedCents ?? 0)
}

export const applyRelease = (ledgerState, release) => moveRelease(ledgerState, release, 1, LEDGER_KIND.RELEASE)
export const applyReleaseVoid = (ledgerState, release) => moveRelease(ledgerState, release, -1, LEDGER_KIND.RELEASE_VOID)

// The stored shape of a ledger state (the stamps are added by the backend).
// `receiptBaseline` is deliberately NOT part of it: the backend writes it once,
// when the baseline is established, and every later write is an UPDATE of
// exactly these fields — so it is never rewritten and never dropped.
export function ledgerDocument(ledgerState) {
  const doc = { seq: ledgerState.seq, lines: ledgerState.lines,
    lastEntryId: ledgerState.lastEntryId, lastEntryKind: ledgerState.lastEntryKind }
  for (const key of LEDGER_TOTAL_KEYS) doc[key] = ledgerState[key]
  doc.receivedCents = ledgerState.receivedCents ?? 0
  return doc
}

// ── Cross-check: the ledger against the documents it summarises ──────────────
//
// What the ledger of one invoice SHOULD read, summed from the posted credit
// notes and posted releases themselves.
export function expectedLedgerTotals(invoiceId, postedCreditNotes, postedReleases) {
  const out = emptyLedger()
  for (const cn of postedCreditNotes ?? []) {
    if (cn?.clientInvoiceId !== invoiceId) continue
    const c = creditNoteCents(cn)
    out.creditedSubtotalCents += c.subtotalCents
    out.creditedGstCents += c.gstCents
    out.creditedRetentionCents += c.retentionCents
    out.creditedRetentionGstCents += c.retentionGstCents
  }
  for (const r of postedReleases ?? []) {
    if (r?.clientInvoiceId !== invoiceId) continue
    out.releasedRetentionCents += toCents(r.amount)
    out.releasedRetentionGstCents += toCents(r.gstAmount)
  }
  return out
}

// The total keys on which a stored ledger disagrees with its documents.
export function ledgerDisagreement(ledgerDoc, invoiceId, postedCreditNotes, postedReleases) {
  const stored = readLedger(ledgerDoc)
  const expected = expectedLedgerTotals(invoiceId, postedCreditNotes, postedReleases)
  return LEDGER_TOTAL_KEYS.filter(key => stored[key] !== expected[key])
}
