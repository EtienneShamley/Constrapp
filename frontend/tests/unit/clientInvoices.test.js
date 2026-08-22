import { describe, it, expect } from 'vitest'
import {
  CI_STATUS, CI_TRANSITIONS, CI_COUNTING_STATUSES, CI_EDITABLE_STATUSES,
  CI_DOC_TYPE, canTransition,
  CLIENT_INVOICE_COUNTER_ID, formatClientInvoiceNumber,
  TAX_CODE, TAX_CODES, TAX_CODE_LABELS, gstForLine, invoiceTotals,
  suggestDueDate, paymentTermsLabel, daysPastDue, isPastDue,
  issuedClientInvoices, draftClientInvoices, sumInvoices,
  availableToInvoice, contractControl,
  approvedClientVariations, invoicedByVariation, resolveVariationCostCode,
  variationInvoicingRows, invoiceableClientVariations,
  AGEING_BUCKETS, ageingByDueDate,
  contractOverInvoiceWarning, variationOverInvoiceWarnings,
  validateInvoiceDraft,
} from '../../src/lib/clientInvoices'
import { approvedClientVariationsTotal, pendingClientVariationExposureTotal } from '../../src/lib/variations'
import { currentContractSum } from '../../src/lib/margin'
import { GST_RATE } from '../../src/lib/purchaseOrders'

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// The §15i acceptance project: Original Contract Value 1,000,000, one APPROVED
// client variation of +50,000, one SUBMITTED (pending) client variation of
// +30,000, and one APPROVED client variation of −40,000.

const line = (over = {}) => ({
  description: 'Contract works to date',
  amount: 1000,
  taxCode: TAX_CODE.GST,
  gstAmount: 100,
  variationId: null, variationNumber: null, variationDescription: null,
  costCodeId: null, costCodeName: null,
  sortOrder: 0,
  ...over,
})

// A stored invoice. Header totals are denormalised at write time from the lines
// (the PO/supplier-invoice idiom), so the header and the lines are set together.
const inv = (over = {}) => ({
  id: 'inv1',
  invoiceNumber: 'CI-0001',
  status: CI_STATUS.ISSUED,
  docType: CI_DOC_TYPE.INVOICE,
  clientId: 'client1',
  clientName: 'Acme Developments',
  invoiceDate: '2026-08-01',
  dueDate: '2026-08-31',
  lineItems: [line()],
  subtotal: 1000, gstTotal: 100, grossTotal: 1100,
  currency: 'AUD',
  ...over,
})

// A client variation, frozen at its approved figures.
const cv = (over = {}) => ({
  id: 'cv1',
  variationNumber: 'CV-0001',
  variationType: 'client',
  status: 'approved',
  title: 'Additional balustrade',
  approvedSubtotal: 50000,
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '05-100 — Metalwork', approvedAmount: 50000 },
  ],
  ...over,
})

const APPROVED_PLUS  = cv({ id: 'cvA', variationNumber: 'CV-0001', approvedSubtotal: 50000 })
const PENDING_PLUS   = cv({ id: 'cvP', variationNumber: 'CV-0002', status: 'submitted', approvedSubtotal: 0, submittedSubtotal: 30000 })
const APPROVED_MINUS = cv({ id: 'cvM', variationNumber: 'CV-0003', approvedSubtotal: -40000, title: 'Omit landscaping' })

const ACCEPTANCE_VARIATIONS = [APPROVED_PLUS, PENDING_PLUS, APPROVED_MINUS]

const OCV = 1_000_000

// Deep-freezes a fixture so any write attempt throws in strict-mode ESM.
const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze(v[k])
  }
  return v
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('is forward-only: draft → issued → void, and void directly from draft', () => {
    expect(CI_TRANSITIONS[CI_STATUS.DRAFT]).toEqual([CI_STATUS.ISSUED, CI_STATUS.VOID])
    expect(CI_TRANSITIONS[CI_STATUS.ISSUED]).toEqual([CI_STATUS.VOID])
    expect(CI_TRANSITIONS[CI_STATUS.VOID]).toEqual([])
  })

  it('has no route out of sent — it is reserved, not reachable', () => {
    expect(CI_TRANSITIONS[CI_STATUS.SENT]).toEqual([])
  })

  it('canTransition mirrors the map and refuses every reversal', () => {
    expect(canTransition('draft', 'issued')).toBe(true)
    expect(canTransition('draft', 'void')).toBe(true)
    expect(canTransition('issued', 'void')).toBe(true)
    expect(canTransition('issued', 'draft')).toBe(false)
    expect(canTransition('void', 'issued')).toBe(false)
    expect(canTransition('void', 'draft')).toBe(false)
    expect(canTransition('void', 'void')).toBe(false)
  })

  it('has NO paid / partially_paid status — a payment status without a receipt would be fabricated (ADR-22)', () => {
    expect(Object.values(CI_STATUS)).toEqual(['draft', 'sent', 'issued', 'void'])
    expect(Object.values(CI_STATUS)).not.toContain('paid')
    expect(Object.values(CI_STATUS)).not.toContain('partially_paid')
    expect(canTransition('issued', 'paid')).toBe(false)
  })

  it('counts only issued invoices, and edits only drafts', () => {
    expect(CI_COUNTING_STATUSES).toEqual(['issued'])
    expect(CI_EDITABLE_STATUSES).toEqual(['draft'])
  })

  it('numbers as CI-#### from the company-wide clientInvoices counter', () => {
    expect(CLIENT_INVOICE_COUNTER_ID).toBe('clientInvoices')
    expect(formatClientInvoiceNumber(1)).toBe('CI-0001')
    expect(formatClientInvoiceNumber(42)).toBe('CI-0042')
    expect(formatClientInvoiceNumber(10000)).toBe('CI-10000')
  })
})

// ── A. Mixed GST ─────────────────────────────────────────────────────────────

describe('gstForLine — only `gst` attracts GST', () => {
  it('applies the flat Australian 10% to a gst line', () => {
    expect(GST_RATE).toBe(0.1)
    expect(gstForLine(1000, TAX_CODE.GST)).toBe(100)
  })

  it('returns zero for a GST-free line', () => {
    expect(gstForLine(500, TAX_CODE.GST_FREE)).toBe(0)
  })

  it('returns zero for an input-taxed line', () => {
    expect(gstForLine(200, TAX_CODE.INPUT_TAXED)).toBe(0)
  })

  it('returns zero for an unknown or missing tax code — GST is opt-in, never assumed', () => {
    expect(gstForLine(100, undefined)).toBe(0)
    expect(gstForLine(100, null)).toBe(0)
    expect(gstForLine(100, 'vat')).toBe(0)
    expect(gstForLine(100, '')).toBe(0)
  })

  it('treats a zero or non-numeric amount as zero rather than producing NaN', () => {
    expect(gstForLine(0, TAX_CODE.GST)).toBe(0)
    expect(gstForLine('abc', TAX_CODE.GST)).toBe(0)
    expect(gstForLine(null, TAX_CODE.GST)).toBe(0)
    expect(gstForLine(undefined, TAX_CODE.GST)).toBe(0)
  })

  it('rounds half-up to the cent (ADR-10)', () => {
    expect(gstForLine(0.05, TAX_CODE.GST)).toBe(0.01)   // 0.005 → 0.01, not 0.00
    expect(gstForLine(0.15, TAX_CODE.GST)).toBe(0.02)   // 0.015 → 0.02
    expect(gstForLine(1234.56, TAX_CODE.GST)).toBe(123.46)
  })

  it('exposes exactly three tax codes with Australian labels', () => {
    expect(TAX_CODES).toEqual(['gst', 'gst_free', 'input_taxed'])
    expect(TAX_CODE_LABELS[TAX_CODE.GST]).toBe('GST 10%')
    expect(TAX_CODE_LABELS[TAX_CODE.GST_FREE]).toBe('GST-free')
    expect(TAX_CODE_LABELS[TAX_CODE.INPUT_TAXED]).toBe('Input-taxed')
  })
})

describe('invoiceTotals — the §15i-iv mixed acceptance case', () => {
  // The exact acceptance example: 1,000 GST 10% + 500 GST-free + 200 Input-taxed.
  const mixed = [
    { description: 'Contract works', amount: 1000, taxCode: TAX_CODE.GST },
    { description: 'Statutory fees', amount: 500,  taxCode: TAX_CODE.GST_FREE },
    { description: 'Residential',    amount: 200,  taxCode: TAX_CODE.INPUT_TAXED },
  ].map(l => ({ ...l, gstAmount: gstForLine(l.amount, l.taxCode) }))

  it('derives per-line GST of 100 / 0 / 0', () => {
    expect(mixed.map(l => l.gstAmount)).toEqual([100, 0, 0])
  })

  it('totals to subtotal 1700, GST 100, gross 1800', () => {
    expect(invoiceTotals(mixed)).toEqual({ subtotal: 1700, gstTotal: 100, grossTotal: 1800 })
  })

  it('gross is subtotal + GST — there is no retention and no payable/gross split (ADR-22)', () => {
    const t = invoiceTotals(mixed)
    expect(t.grossTotal).toBe(t.subtotal + t.gstTotal)
  })

  it('returns zeroes for an empty, null or undefined line set', () => {
    const zero = { subtotal: 0, gstTotal: 0, grossTotal: 0 }
    expect(invoiceTotals([])).toEqual(zero)
    expect(invoiceTotals(null)).toEqual(zero)
    expect(invoiceTotals(undefined)).toEqual(zero)
  })

  it('sums to whole cents rather than leaving an IEEE-754 crumb', () => {
    // 0.10 + 0.20 is 0.30000000000000004 in raw floating point.
    const t = invoiceTotals([
      { amount: 0.10, gstAmount: 0.01 },
      { amount: 0.20, gstAmount: 0.02 },
    ])
    expect(t.subtotal).toBe(0.3)
    expect(t.gstTotal).toBe(0.03)
    expect(t.grossTotal).toBe(0.33)
  })

  it('accumulates a hundred one-cent lines to exactly 1.00', () => {
    const cents = Array.from({ length: 100 }, () => ({ amount: 0.01, gstAmount: 0 }))
    expect(invoiceTotals(cents).subtotal).toBe(1)
  })

  it('treats missing or non-numeric line values as zero', () => {
    expect(invoiceTotals([{ amount: 'abc' }, { amount: null }, {}])).toEqual({
      subtotal: 0, gstTotal: 0, grossTotal: 0,
    })
  })

  it('does not mutate the lines it reads', () => {
    const lines = deepFreeze([
      { amount: 1000, gstAmount: 100 },
      { amount: 500, gstAmount: 0 },
    ])
    expect(() => invoiceTotals(lines)).not.toThrow()
    expect(lines[0]).toEqual({ amount: 1000, gstAmount: 100 })
  })
})

// ── B. Contract control & available to invoice ───────────────────────────────

describe('invoice sets — only issued invoices count', () => {
  const all = [
    inv({ id: 'i1', status: CI_STATUS.ISSUED }),
    inv({ id: 'i2', status: CI_STATUS.DRAFT }),
    inv({ id: 'i3', status: CI_STATUS.VOID }),
  ]

  it('issuedClientInvoices selects only issued', () => {
    expect(issuedClientInvoices(all).map(i => i.id)).toEqual(['i1'])
  })

  it('draftClientInvoices selects only drafts', () => {
    expect(draftClientInvoices(all).map(i => i.id)).toEqual(['i2'])
  })

  it('a void invoice belongs to neither set — it is nothing, forever', () => {
    expect(issuedClientInvoices(all).some(i => i.id === 'i3')).toBe(false)
    expect(draftClientInvoices(all).some(i => i.id === 'i3')).toBe(false)
  })

  it('tolerates a null/undefined invoice list', () => {
    expect(issuedClientInvoices(null)).toEqual([])
    expect(draftClientInvoices(undefined)).toEqual([])
  })
})

describe('sumInvoices', () => {
  it('sums the STORED headers, not a recomputation of the lines', () => {
    // A header that disagrees with its lines must still be reported as stored —
    // header totals are denormalised at write time and are the counting point.
    const drifted = inv({ subtotal: 4000, gstTotal: 400, grossTotal: 4400, lineItems: [line({ amount: 1 })] })
    expect(sumInvoices([drifted])).toEqual({ count: 1, subtotal: 4000, gstTotal: 400, grossTotal: 4400 })
  })

  it('adds several invoices to the cent', () => {
    expect(sumInvoices([
      inv({ id: 'a', subtotal: 0.10, gstTotal: 0.01, grossTotal: 0.11 }),
      inv({ id: 'b', subtotal: 0.20, gstTotal: 0.02, grossTotal: 0.22 }),
    ])).toEqual({ count: 2, subtotal: 0.3, gstTotal: 0.03, grossTotal: 0.33 })
  })

  it('returns a zeroed summary for an empty set', () => {
    expect(sumInvoices([])).toEqual({ count: 0, subtotal: 0, gstTotal: 0, grossTotal: 0 })
  })
})

describe('availableToInvoice', () => {
  it('is Current Contract Sum − issued ex-GST', () => {
    expect(availableToInvoice(1_010_000, 400_000)).toBe(610_000)
  })

  it('goes NEGATIVE when over-invoiced and is never clamped', () => {
    expect(availableToInvoice(1000, 1500)).toBe(-500)
  })

  it('treats missing inputs as zero', () => {
    expect(availableToInvoice(undefined, undefined)).toBe(0)
    expect(availableToInvoice(1000, null)).toBe(1000)
  })
})

describe('contractControl — the §15i-v acceptance figures', () => {
  // Current Contract Sum = 1,000,000 + 50,000 − 40,000 = 1,010,000.
  const ccs = currentContractSum(OCV, approvedClientVariationsTotal(ACCEPTANCE_VARIATIONS))

  it('derives a Current Contract Sum of 1,010,000 from the baseline and APPROVED client variations', () => {
    expect(approvedClientVariationsTotal(ACCEPTANCE_VARIATIONS)).toBe(10_000)
    expect(ccs).toBe(1_010_000)
  })

  it('leaves 610,000 available after a 400,000 ex-GST invoice is issued', () => {
    const c = contractControl([inv({ subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })], ccs)
    expect(c.currentContractSum).toBe(1_010_000)
    expect(c.issued.subtotal).toBe(400_000)
    expect(c.availableToInvoice).toBe(610_000)
  })

  it('reports a 100,000 DRAFT separately and does not let it reduce Available to Invoice', () => {
    const c = contractControl([
      inv({ id: 'i1', status: CI_STATUS.ISSUED, subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 }),
      inv({ id: 'i2', status: CI_STATUS.DRAFT,  subtotal: 100_000, gstTotal: 10_000, grossTotal: 110_000 }),
    ], ccs)
    expect(c.drafts.count).toBe(1)
    expect(c.drafts.subtotal).toBe(100_000)
    expect(c.issued.subtotal).toBe(400_000)
    expect(c.availableToInvoice).toBe(610_000)
  })

  it('returns a voided invoice\'s value to Available to Invoice immediately', () => {
    const before = contractControl([inv({ subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })], ccs)
    const after  = contractControl([inv({ status: CI_STATUS.VOID, subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })], ccs)
    expect(before.availableToInvoice).toBe(610_000)
    expect(after.availableToInvoice).toBe(1_010_000)
  })

  it('keeps PENDING client variation exposure out of the contract sum entirely', () => {
    expect(pendingClientVariationExposureTotal(ACCEPTANCE_VARIATIONS)).toBe(30_000)
    // 30,000 of pending exposure is reported by the page, but the contract sum
    // is unchanged by it — approval is the counting point (ADR-18).
    expect(ccs).toBe(1_010_000)
  })

  it('is a pure read-time derivation that never writes to the invoices it reads', () => {
    const invoices = deepFreeze([inv({ subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })])
    expect(() => contractControl(invoices, ccs)).not.toThrow()
    expect(invoices[0].subtotal).toBe(400_000)
  })
})

describe('no-mutation — invoices never feed back into the contract sum', () => {
  // The Current Contract Sum is derived in lib/margin.js from the baseline plus
  // APPROVED client variations, and is PASSED IN here. contractControl must
  // report it untouched: if an invoice could move it, issuing an invoice would
  // silently create contract value.
  //
  // ⚠️ SCOPE. This proves the read-time derivation. It does NOT prove that the
  // hook writes nothing to Firestore — that remains a manual/integration check
  // (§15i-xv).
  const ccs = currentContractSum(OCV, approvedClientVariationsTotal(ACCEPTANCE_VARIATIONS))

  it('reports the supplied contract sum unchanged, whatever the invoices say', () => {
    const none    = contractControl([], ccs)
    const issued  = contractControl([inv({ subtotal: 900_000, gstTotal: 90_000, grossTotal: 990_000 })], ccs)
    const overrun = contractControl([inv({ subtotal: 9_000_000, gstTotal: 900_000, grossTotal: 9_900_000 })], ccs)
    expect(none.currentContractSum).toBe(1_010_000)
    expect(issued.currentContractSum).toBe(1_010_000)
    expect(overrun.currentContractSum).toBe(1_010_000)
  })

  it('lets Available to Invoice go negative rather than growing the contract sum', () => {
    const c = contractControl([inv({ subtotal: 2_000_000, gstTotal: 200_000, grossTotal: 2_200_000 })], ccs)
    expect(c.currentContractSum).toBe(1_010_000)
    expect(c.availableToInvoice).toBe(-990_000)
  })

  it('leaves the contract sum unchanged when an invoice is voided', () => {
    const issued = contractControl([inv({ subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })], ccs)
    const voided = contractControl([inv({ status: CI_STATUS.VOID, subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })], ccs)
    expect(issued.currentContractSum).toBe(voided.currentContractSum)
  })

  it('is idempotent — the same inputs derive the same figures on every render', () => {
    const invoices = [inv({ subtotal: 400_000, gstTotal: 40_000, grossTotal: 440_000 })]
    expect(contractControl(invoices, ccs)).toEqual(contractControl(invoices, ccs))
  })
})

// ── C. Client variations ─────────────────────────────────────────────────────

describe('approvedClientVariations', () => {
  it('selects APPROVED client variations only', () => {
    expect(approvedClientVariations(ACCEPTANCE_VARIATIONS).map(v => v.id)).toEqual(['cvA', 'cvM'])
  })

  it('excludes a DRAFT client variation', () => {
    expect(approvedClientVariations([cv({ id: 'd', status: 'draft' })])).toEqual([])
  })

  it('excludes a SUBMITTED client variation', () => {
    expect(approvedClientVariations([cv({ id: 's', status: 'submitted' })])).toEqual([])
  })

  it('excludes rejected and withdrawn client variations', () => {
    expect(approvedClientVariations([
      cv({ id: 'r', status: 'rejected' }),
      cv({ id: 'w', status: 'withdrawn' }),
    ])).toEqual([])
  })

  it('excludes an APPROVED SUPPLIER variation — revenue and cost never mix', () => {
    expect(approvedClientVariations([cv({ id: 'sv', variationType: 'supplier' })])).toEqual([])
  })
})

describe('invoiceableClientVariations — what the line picker may offer', () => {
  const rows = invoiceableClientVariations(ACCEPTANCE_VARIATIONS, [])

  it('offers an APPROVED POSITIVE client variation', () => {
    expect(rows.map(r => r.id)).toContain('cvA')
    expect(rows.find(r => r.id === 'cvA').approved).toBe(50_000)
  })

  it('does NOT offer a DRAFT client variation', () => {
    const r = invoiceableClientVariations([cv({ id: 'd', status: 'draft', approvedSubtotal: 50_000 })], [])
    expect(r).toEqual([])
  })

  it('does NOT offer a SUBMITTED (pending) client variation — approval is the counting point (ADR-18)', () => {
    expect(rows.map(r => r.id)).not.toContain('cvP')
    const r = invoiceableClientVariations([cv({ id: 's', status: 'submitted', approvedSubtotal: 30_000 })], [])
    expect(r).toEqual([])
  })

  it('does NOT offer an APPROVED NEGATIVE client variation — a credit cannot be positively invoiced', () => {
    expect(rows.map(r => r.id)).not.toContain('cvM')
  })

  it('does NOT offer an approved variation of exactly zero', () => {
    expect(invoiceableClientVariations([cv({ id: 'z', approvedSubtotal: 0 })], [])).toEqual([])
  })

  it('still lets the APPROVED NEGATIVE variation reduce the Current Contract Sum and Available to Invoice', () => {
    // Not invoiceable, yet fully counted: −40,000 is inside the 1,010,000 sum,
    // so it has already reduced what may be billed.
    const withMinus    = currentContractSum(OCV, approvedClientVariationsTotal(ACCEPTANCE_VARIATIONS))
    const withoutMinus = currentContractSum(OCV, approvedClientVariationsTotal([APPROVED_PLUS, PENDING_PLUS]))
    expect(withMinus).toBe(1_010_000)
    expect(withoutMinus).toBe(1_050_000)
    expect(availableToInvoice(withMinus, 0)).toBe(1_010_000)
    expect(availableToInvoice(withMinus, 0)).toBe(availableToInvoice(withoutMinus, 0) - 40_000)
  })
})

describe('invoicedByVariation — only ISSUED invoices bill a variation', () => {
  const issued = inv({
    id: 'i1', status: CI_STATUS.ISSUED,
    lineItems: [line({ amount: 30_000, variationId: 'cvA', variationNumber: 'CV-0001' })],
  })
  const draft = inv({
    id: 'i2', status: CI_STATUS.DRAFT,
    lineItems: [line({ amount: 20_000, variationId: 'cvA', variationNumber: 'CV-0001' })],
  })
  const voided = inv({
    id: 'i3', status: CI_STATUS.VOID,
    lineItems: [line({ amount: 15_000, variationId: 'cvA', variationNumber: 'CV-0001' })],
  })

  it('counts an issued variation line', () => {
    expect(invoicedByVariation([issued])).toEqual({ cvA: 30_000 })
  })

  it('ignores a DRAFT invoice — a draft has billed nothing', () => {
    expect(invoicedByVariation([draft])).toEqual({})
  })

  it('ignores a VOID invoice', () => {
    expect(invoicedByVariation([voided])).toEqual({})
  })

  it('ignores contract lines, which carry no variationId', () => {
    expect(invoicedByVariation([inv({ lineItems: [line({ amount: 5000, variationId: null })] })])).toEqual({})
  })

  it('accumulates several lines and several invoices against one variation', () => {
    const two = inv({
      id: 'i4',
      lineItems: [
        line({ amount: 100, variationId: 'cvA' }),
        line({ amount: 200, variationId: 'cvA' }),
        line({ amount: 50,  variationId: 'cvB' }),
      ],
    })
    expect(invoicedByVariation([issued, two])).toEqual({ cvA: 30_300, cvB: 50 })
  })
})

describe('resolveVariationCostCode — revenue sits above the cost-code spine (ADR-20)', () => {
  it('snapshots the cost code when the whole variation resolves to exactly one', () => {
    expect(resolveVariationCostCode(cv())).toEqual({ costCodeId: 'cc1', costCodeName: '05-100 — Metalwork' })
  })

  it('snapshots NULL when the variation spans several cost codes — a single one would be a false attribution', () => {
    const spanning = cv({ lineItems: [
      { costCodeId: 'cc1', costCodeName: 'A', approvedAmount: 10 },
      { costCodeId: 'cc2', costCodeName: 'B', approvedAmount: 10 },
    ] })
    expect(resolveVariationCostCode(spanning)).toEqual({ costCodeId: null, costCodeName: null })
  })

  it('snapshots NULL when the variation carries no cost-coded line at all', () => {
    expect(resolveVariationCostCode(cv({ lineItems: [] }))).toEqual({ costCodeId: null, costCodeName: null })
    expect(resolveVariationCostCode(undefined)).toEqual({ costCodeId: null, costCodeName: null })
  })

  it('collapses repeated lines on the SAME cost code to that one cost code', () => {
    const repeated = cv({ lineItems: [
      { costCodeId: 'cc1', costCodeName: 'A', approvedAmount: 10 },
      { costCodeId: 'cc1', costCodeName: 'A', approvedAmount: 20 },
    ] })
    expect(resolveVariationCostCode(repeated)).toEqual({ costCodeId: 'cc1', costCodeName: 'A' })
  })
})

describe('variationInvoicingRows — the §15i-vii approved/invoiced/remaining table', () => {
  it('shows 30,000 invoiced and 20,000 remaining after billing 30,000 of a 50,000 variation', () => {
    const invoices = [inv({ lineItems: [line({ amount: 30_000, variationId: 'cvA' })] })]
    const row = variationInvoicingRows(ACCEPTANCE_VARIATIONS, invoices).find(r => r.id === 'cvA')
    expect(row.approved).toBe(50_000)
    expect(row.invoiced).toBe(30_000)
    expect(row.remaining).toBe(20_000)
  })

  it('renders remaining as −5,000 (signed, never clamped) after a second 25,000 invoice', () => {
    const invoices = [
      inv({ id: 'i1', lineItems: [line({ amount: 30_000, variationId: 'cvA' })] }),
      inv({ id: 'i2', lineItems: [line({ amount: 25_000, variationId: 'cvA' })] }),
    ]
    const row = variationInvoicingRows(ACCEPTANCE_VARIATIONS, invoices).find(r => r.id === 'cvA')
    expect(row.invoiced).toBe(55_000)
    expect(row.remaining).toBe(-5_000)
  })

  it('carries the frozen cost-code snapshot, or null when the variation spans several', () => {
    const spanning = cv({ id: 'cvS', lineItems: [
      { costCodeId: 'cc1', costCodeName: 'A', approvedAmount: 10 },
      { costCodeId: 'cc2', costCodeName: 'B', approvedAmount: 10 },
    ] })
    const [single, multi] = variationInvoicingRows([APPROVED_PLUS, spanning], [])
    expect(single.costCodeId).toBe('cc1')
    expect(multi.costCodeId).toBeNull()
    expect(multi.costCodeName).toBeNull()
  })

  it('includes the negative approved variation in the table even though it is not invoiceable', () => {
    const rows = variationInvoicingRows(ACCEPTANCE_VARIATIONS, [])
    expect(rows.map(r => r.id)).toEqual(['cvA', 'cvM'])
    expect(rows.find(r => r.id === 'cvM').approved).toBe(-40_000)
  })

  it('NEVER writes back to a variation document — the variation is byte-identical afterwards (§15i-vii)', () => {
    const variations = deepFreeze([cv({ id: 'cvA' })])
    const invoices = deepFreeze([inv({ lineItems: [line({ amount: 30_000, variationId: 'cvA' })] })])
    expect(() => variationInvoicingRows(variations, invoices)).not.toThrow()
    expect(() => invoicedByVariation(invoices)).not.toThrow()
    expect(() => invoiceableClientVariations(variations, invoices)).not.toThrow()
    // Nothing was stamped onto the variation: no invoiced total, no back-reference.
    expect(Object.keys(variations[0]).sort()).toEqual(
      ['approvedSubtotal', 'id', 'lineItems', 'status', 'title', 'variationNumber', 'variationType'],
    )
  })
})

// ── D. Warnings ──────────────────────────────────────────────────────────────

describe('contractOverInvoiceWarning — warned, never blocked', () => {
  it('returns null while the invoice stays inside the Current Contract Sum', () => {
    expect(contractOverInvoiceWarning({
      currentContractSum: 1_010_000, issuedExGst: 400_000, thisInvoiceExGst: 610_000,
    })).toBeNull()
  })

  it('returns null at exactly the contract sum — the boundary is inclusive', () => {
    expect(contractOverInvoiceWarning({
      currentContractSum: 1000, issuedExGst: 900, thisInvoiceExGst: 100,
    })).toBeNull()
  })

  it('names the excess when the invoice would push issued value past the contract sum', () => {
    const w = contractOverInvoiceWarning({
      currentContractSum: 1_010_000, issuedExGst: 400_000, thisInvoiceExGst: 700_000,
    })
    expect(w.field).toBe('contract')
    expect(w.excess).toBe(90_000)
    expect(w.message).toMatch(/allowed/i)
  })

  it('never claims the limit is prevented or blocked', () => {
    const w = contractOverInvoiceWarning({ currentContractSum: 0, issuedExGst: 0, thisInvoiceExGst: 1 })
    expect(w.message).not.toMatch(/prevent|blocked/i)
  })
})

describe('variationOverInvoiceWarnings', () => {
  const invoices = [inv({ lineItems: [line({ amount: 30_000, variationId: 'cvA' })] })]

  it('is silent while the new lines stay inside the variation\'s remaining amount', () => {
    const lines = [line({ amount: 20_000, variationId: 'cvA' })]
    expect(variationOverInvoiceWarnings(lines, ACCEPTANCE_VARIATIONS, invoices)).toEqual([])
  })

  it('warns with the excess when the new lines would exceed it (the §15i-vii 25,000 case)', () => {
    const lines = [line({ amount: 25_000, variationId: 'cvA' })]
    const [w] = variationOverInvoiceWarnings(lines, ACCEPTANCE_VARIATIONS, invoices)
    expect(w.field).toBe('variation')
    expect(w.variationId).toBe('cvA')
    expect(w.variationNumber).toBe('CV-0001')
    expect(w.excess).toBe(5_000)
    expect(w.message).toMatch(/double-invoicing/i)
  })

  it('aggregates several lines against the same variation before comparing', () => {
    const lines = [
      line({ amount: 15_000, variationId: 'cvA' }),
      line({ amount: 15_000, variationId: 'cvA' }),
    ]
    const [w] = variationOverInvoiceWarnings(lines, ACCEPTANCE_VARIATIONS, invoices)
    expect(w.excess).toBe(10_000)
  })

  it('ignores contract lines and unknown variation ids', () => {
    expect(variationOverInvoiceWarnings(
      [line({ amount: 999_999, variationId: null }), line({ amount: 999_999, variationId: 'nope' })],
      ACCEPTANCE_VARIATIONS, invoices,
    )).toEqual([])
  })
})

// ── E. Due dates and payment terms ───────────────────────────────────────────

describe('suggestDueDate', () => {
  it('adds the term to the invoice date on the `invoice` basis (§15i-viii)', () => {
    expect(suggestDueDate('2026-08-01', { days: 30, basis: 'invoice' })).toBe('2026-08-31')
  })

  it('adds the term to the END OF THE INVOICE MONTH on the `eom` basis', () => {
    expect(suggestDueDate('2026-08-01', { days: 14, basis: 'eom' })).toBe('2026-09-14')
  })

  it('crosses a month and a year boundary correctly', () => {
    expect(suggestDueDate('2026-12-20', { days: 30, basis: 'invoice' })).toBe('2027-01-19')
    expect(suggestDueDate('2026-02-01', { days: 0, basis: 'eom' })).toBe('2026-02-28')
  })

  it('returns BLANK rather than assuming a default term when terms are missing', () => {
    expect(suggestDueDate('2026-08-01', null)).toBe('')
    expect(suggestDueDate('2026-08-01', {})).toBe('')
    expect(suggestDueDate('2026-08-01', { basis: 'invoice' })).toBe('')
    expect(suggestDueDate('', { days: 30, basis: 'invoice' })).toBe('')
  })

  it('returns blank for an unparseable invoice date', () => {
    expect(suggestDueDate('not-a-date', { days: 30, basis: 'invoice' })).toBe('')
  })
})

describe('paymentTermsLabel — the UI must NAME the source of a suggested due date', () => {
  it('describes an invoice-basis term', () => {
    expect(paymentTermsLabel({ days: 30, basis: 'invoice' })).toBe('30 days from invoice')
  })

  it('describes an end-of-month term', () => {
    expect(paymentTermsLabel({ days: 14, basis: 'eom' })).toBe('14 days after end of month')
  })

  it('is empty when there is nothing to name', () => {
    expect(paymentTermsLabel(null)).toBe('')
    expect(paymentTermsLabel({})).toBe('')
  })
})

// ── F. Past due (date only) ──────────────────────────────────────────────────

describe('isPastDue — deliberately DATE-ONLY', () => {
  const NOW = new Date(2026, 7, 20) // 2026-08-20, local

  it('is true for an issued invoice whose due date has passed', () => {
    expect(isPastDue(inv({ status: CI_STATUS.ISSUED, dueDate: '2026-07-06' }), NOW)).toBe(true)
  })

  it('is false for an issued invoice that is not yet due', () => {
    expect(isPastDue(inv({ status: CI_STATUS.ISSUED, dueDate: '2026-09-30' }), NOW)).toBe(false)
  })

  it('is false on the due date itself', () => {
    expect(isPastDue(inv({ status: CI_STATUS.ISSUED, dueDate: '2026-08-20' }), NOW)).toBe(false)
  })

  it('is false for a DRAFT invoice — a draft is not a receivable', () => {
    expect(isPastDue(inv({ status: CI_STATUS.DRAFT, dueDate: '2020-01-01' }), NOW)).toBe(false)
  })

  it('is false for a VOID invoice', () => {
    expect(isPastDue(inv({ status: CI_STATUS.VOID, dueDate: '2020-01-01' }), NOW)).toBe(false)
  })

  it('is false when there is no due date', () => {
    expect(isPastDue(inv({ status: CI_STATUS.ISSUED, dueDate: '' }), NOW)).toBe(false)
  })

  it('says nothing about money — a fully reconciled invoice is still "past due" by date alone', () => {
    // The guard against presenting this as a money figure lives in
    // lib/clientReceipts.js → isPastDueUnreconciled.
    expect(isPastDue(inv({ status: CI_STATUS.ISSUED, dueDate: '2026-07-06', grossTotal: 1100 }), NOW)).toBe(true)
  })

  it('re-exports daysPastDue from lib/payments so AR and AP cannot drift', () => {
    expect(daysPastDue('2026-07-06', NOW)).toBe(45)
    expect(daysPastDue('', NOW)).toBeNull()
  })
})

// ── G. Ageing ────────────────────────────────────────────────────────────────

describe('ageingByDueDate — ages the REMAINING balance, gross (inc. GST)', () => {
  const NOW = new Date(2026, 7, 20) // 2026-08-20
  const issued = (id, dueDate, grossTotal) =>
    inv({ id, invoiceNumber: id, status: CI_STATUS.ISSUED, dueDate, grossTotal })

  it('exposes the six documented buckets in order', () => {
    expect(AGEING_BUCKETS.map(b => b.key)).toEqual([
      'noDueDate', 'notYetDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus',
    ])
  })

  it('buckets by days past the due date (a 45-day-old invoice lands in 31–60)', () => {
    const a = ageingByDueDate([
      issued('none', '', 100),
      issued('future', '2026-09-30', 200),
      issued('d15', '2026-08-05', 400),
      issued('d45', '2026-07-06', 800),
      issued('d71', '2026-06-10', 1600),
      issued('old', '2026-01-01', 3200),
    ], {}, NOW)
    expect(a.buckets.noDueDate.amount).toBe(100)
    expect(a.buckets.notYetDue.amount).toBe(200)
    expect(a.buckets.d1_30.amount).toBe(400)
    expect(a.buckets.d31_60.amount).toBe(800)
    expect(a.buckets.d61_90.amount).toBe(1600)
    expect(a.buckets.d90plus.amount).toBe(3200)
    expect(a.total).toBe(6300)
    expect(a.pastDue).toBe(6000)
  })

  it('ages GROSS, because gross is what the client was billed', () => {
    const a = ageingByDueDate([issued('i1', '2026-07-06', 1100)], {}, NOW)
    expect(a.buckets.d31_60.amount).toBe(1100)
  })

  it('ages only the REMAINDER of a partly reconciled invoice', () => {
    const a = ageingByDueDate([issued('i1', '2026-07-06', 1100)], { i1: 400 }, NOW)
    expect(a.buckets.d31_60.amount).toBe(700)
    expect(a.buckets.d31_60.count).toBe(1)
  })

  it('drops a fully reconciled invoice out of ageing entirely', () => {
    const a = ageingByDueDate([issued('i1', '2026-07-06', 1100)], { i1: 1100 }, NOW)
    expect(a.total).toBe(0)
    expect(a.buckets.d31_60.count).toBe(0)
    expect(a.overSettled).toEqual([])
  })

  it('EXCLUDES an over-reconciled invoice from the buckets and returns it in overSettled', () => {
    const a = ageingByDueDate([
      issued('over', '2026-07-06', 1000),
      issued('real', '2026-07-06', 500),
    ], { over: 1500 }, NOW)
    // The −500 must never offset the 500 of genuine arrears.
    expect(a.buckets.d31_60.amount).toBe(500)
    expect(a.total).toBe(500)
    expect(a.overSettled.map(i => i.id)).toEqual(['over'])
  })

  it('never ages a draft or a void invoice', () => {
    const a = ageingByDueDate([
      inv({ id: 'd', status: CI_STATUS.DRAFT, dueDate: '2026-07-06', grossTotal: 999 }),
      inv({ id: 'v', status: CI_STATUS.VOID,  dueDate: '2026-07-06', grossTotal: 999 }),
    ], {}, NOW)
    expect(a.total).toBe(0)
  })

  it('treats an absent receipt map as nothing received', () => {
    const a = ageingByDueDate([issued('i1', '2026-07-06', 1100)], undefined, NOW)
    expect(a.buckets.d31_60.amount).toBe(1100)
  })

  it('does not mutate the invoices it ages', () => {
    const invoices = deepFreeze([issued('i1', '2026-07-06', 1100)])
    expect(() => ageingByDueDate(invoices, { i1: 400 }, NOW)).not.toThrow()
    expect(invoices[0].grossTotal).toBe(1100)
  })
})

// ── H. Draft validation ──────────────────────────────────────────────────────

describe('validateInvoiceDraft', () => {
  const ok = {
    clientId: 'client1',
    clientName: 'Acme Developments',
    invoiceDate: '2026-08-01',
    lineItems: [{ description: 'Contract works', amount: 1000, taxCode: TAX_CODE.GST }],
  }

  it('accepts a complete draft', () => {
    expect(validateInvoiceDraft(ok)).toBeNull()
  })

  it('requires a client', () => {
    expect(validateInvoiceDraft({ ...ok, clientId: '' })).toBe('Select the client this invoice is issued to.')
  })

  it('requires the client to have a display name', () => {
    expect(validateInvoiceDraft({ ...ok, clientName: '   ' })).toBe('The selected client has no display name.')
  })

  it('requires an invoice date', () => {
    expect(validateInvoiceDraft({ ...ok, invoiceDate: '' })).toBe('Enter an invoice date.')
  })

  it('requires at least one line with a non-zero amount', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [] })).toBe('Add at least one line with an amount.')
    expect(validateInvoiceDraft({ ...ok, lineItems: [{ description: 'x', amount: 0, taxCode: TAX_CODE.GST }] }))
      .toBe('Add at least one line with an amount.')
  })

  it('requires every line to be described', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [{ description: '', amount: 10, taxCode: TAX_CODE.GST }] }))
      .toBe('Line 1: enter a description.')
  })

  it('rejects a non-numeric amount on a line alongside a real one, naming the line', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [
      { description: 'good', amount: 10, taxCode: TAX_CODE.GST },
      { description: 'bad',  amount: 'abc', taxCode: TAX_CODE.GST },
    ] })).toBe('Line 2: amount must be a number.')
  })

  it('rejects a NEGATIVE amount and names Credit Notes as the correct instrument', () => {
    const msg = validateInvoiceDraft({ ...ok, lineItems: [{ description: 'x', amount: -5, taxCode: TAX_CODE.GST }] })
    expect(msg).toBe('Line 1: amount cannot be negative (credits are a future Credit Note).')
  })

  it('requires a valid tax code on every line', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [{ description: 'x', amount: 10, taxCode: 'vat' }] }))
      .toBe('Line 1: choose a tax code.')
    expect(validateInvoiceDraft({ ...ok, lineItems: [{ description: 'x', amount: 10 }] }))
      .toBe('Line 1: choose a tax code.')
  })

  it('accepts all three tax codes on one invoice', () => {
    expect(validateInvoiceDraft({ ...ok, lineItems: [
      { description: 'a', amount: 1000, taxCode: TAX_CODE.GST },
      { description: 'b', amount: 500,  taxCode: TAX_CODE.GST_FREE },
      { description: 'c', amount: 200,  taxCode: TAX_CODE.INPUT_TAXED },
    ] })).toBeNull()
  })
})
