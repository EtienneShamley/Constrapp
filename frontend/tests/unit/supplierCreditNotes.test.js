import { describe, it, expect } from 'vitest'
import {
  SCN_STATUS, SCN_TRANSITIONS, SCN_COUNTING_STATUSES, canTransition,
  SUPPLIER_CREDIT_NOTE_COUNTER_ID, formatSupplierCreditNoteNumber, MAX_CREDIT_NOTE_LINES,
  creditNoteTotals, isCreditableInvoice, creditableSupplierInvoices,
  creditTargetException, isCountingCreditNote,
  creditedByInvoice, creditedByCostCode, creditNoteExceptions,
  postedCreditedGrossForInvoice, overCreditError,
  targetInvoiceCostCodes, creditNotesForInvoice, creditNoteSummary,
  duplicateCreditWarnings, validateCreditNoteDraft, postBlockedReason,
  buildCreditNoteLineItems,
} from '../../src/lib/supplierCreditNotes'
import {
  supplierInvoiceReconciliationRows, payablesSummary, apAgeing,
  allocatableSupplierInvoices, invoiceOverPaymentWarnings, remainingPayable,
} from '../../src/lib/supplierPayments'
import { buildForecastRows } from '../../src/lib/forecast'
import { roundMoney } from '../../src/lib/purchaseOrders'

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// A posted, retention-free supplier invoice with two cost-coded lines:
//   cc1: 600 ex-GST (gst)      cc2: 400 ex-GST (gst)
//   subtotal 1000 · gstTotal 100 · grossTotal 1100 · payableTotal 1100

const invoice = (over = {}) => ({
  id: 'inv1',
  invoiceNumber: 'SI-0001',
  supplierInvoiceNumber: 'INV-100',
  status: 'posted',
  supplierId: 'sup1',
  supplierName: 'Ace Concrete',
  currency: 'AUD',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 600, taxCode: 'gst', gstAmount: 60 },
    { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 400, taxCode: 'gst', gstAmount: 40 },
  ],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 1000, gstTotal: 100, grossTotal: 1100,
  net: 1000, payableGst: 100, payableTotal: 1100,
  dueDate: '2026-01-31',
  ...over,
})

const credit = (over = {}) => ({
  id: 'cn1',
  creditNumber: 'SCN-0001',
  status: 'posted',
  docType: 'credit_note',
  supplierInvoiceId: 'inv1',
  invoiceNumber: 'SI-0001',
  supplierInvoiceNumber: 'INV-100',
  supplierId: 'sup1',
  supplierName: 'Ace Concrete',
  supplierCreditReference: 'CN-9',
  creditDate: '2026-02-01',
  reason: 'Over-claimed quantities',
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit slab overclaim', amount: 100, taxCode: 'gst', gstAmount: 10 },
  ],
  subtotal: 100, gstTotal: 10, grossTotal: 110,
  currency: 'AUD',
  ...over,
})

const payment = (allocated, over = {}) => ({
  id: 'pay1',
  paymentNumber: 'SP-0001',
  status: 'posted',
  supplierId: 'sup1',
  supplierName: 'Ace Concrete',
  paymentDate: '2026-02-02',
  amount: allocated,
  allocatedTotal: allocated,
  unallocatedAmount: 0,
  allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100', allocatedAmount: allocated }],
  ...over,
})

const byId = (invoices) => new Map(invoices.map(i => [i.id, i]))

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('is forward-only: draft → posted → void, void from draft too', () => {
    expect(SCN_TRANSITIONS[SCN_STATUS.DRAFT]).toEqual([SCN_STATUS.POSTED, SCN_STATUS.VOID])
    expect(SCN_TRANSITIONS[SCN_STATUS.POSTED]).toEqual([SCN_STATUS.VOID])
    expect(SCN_TRANSITIONS[SCN_STATUS.VOID]).toEqual([])
  })
  it('canTransition mirrors the map and rejects everything else', () => {
    expect(canTransition('draft', 'posted')).toBe(true)
    expect(canTransition('draft', 'void')).toBe(true)
    expect(canTransition('posted', 'void')).toBe(true)
    expect(canTransition('posted', 'draft')).toBe(false)
    expect(canTransition('void', 'posted')).toBe(false)
    expect(canTransition('void', 'draft')).toBe(false)
  })
  it('only posted counts', () => {
    expect(SCN_COUNTING_STATUSES).toEqual(['posted'])
  })
  it('numbers as SCN-#### from the supplierCreditNotes counter', () => {
    expect(SUPPLIER_CREDIT_NOTE_COUNTER_ID).toBe('supplierCreditNotes')
    expect(formatSupplierCreditNoteNumber(1)).toBe('SCN-0001')
    expect(formatSupplierCreditNoteNumber(42)).toBe('SCN-0042')
    expect(formatSupplierCreditNoteNumber(10000)).toBe('SCN-10000')
  })
})

// ── Header totals (cent arithmetic) ──────────────────────────────────────────

describe('creditNoteTotals', () => {
  it('sums ex-GST lines and per-line GST into a gross total', () => {
    const t = creditNoteTotals([
      { amount: 100, gstAmount: 10 },
      { amount: 50, gstAmount: 0 },
    ])
    expect(t).toEqual({ subtotal: 150, gstTotal: 10, grossTotal: 160 })
  })
  it('survives IEEE-754 cent values (0.10 + 0.20)', () => {
    const t = creditNoteTotals([
      { amount: 0.1, gstAmount: 0.01 },
      { amount: 0.2, gstAmount: 0.02 },
    ])
    expect(t.subtotal).toBe(0.3)
    expect(t.gstTotal).toBe(0.03)
    expect(t.grossTotal).toBe(0.33)
  })
  it('treats empty/null lines as zero', () => {
    expect(creditNoteTotals([])).toEqual({ subtotal: 0, gstTotal: 0, grossTotal: 0 })
    expect(creditNoteTotals(null)).toEqual({ subtotal: 0, gstTotal: 0, grossTotal: 0 })
  })
})

// ── Eligibility (creation targets) ───────────────────────────────────────────

describe('isCreditableInvoice — posted, zero retention, stored currency', () => {
  it('accepts a posted, retention-free invoice', () => {
    expect(isCreditableInvoice(invoice())).toBe(true)
  })
  it('rejects every non-posted status, including the deprecated paid', () => {
    for (const status of ['draft', 'approved', 'cancelled', 'paid', 'received', 'disputed']) {
      expect(isCreditableInvoice(invoice({ status }))).toBe(false)
    }
  })
  it('rejects any retention withheld — even one cent', () => {
    expect(isCreditableInvoice(invoice({ retentionTotal: 0.01 }))).toBe(false)
    expect(isCreditableInvoice(invoice({ retention: 50, retentionGst: 5, retentionTotal: 55 }))).toBe(false)
  })
  it('rejects an invoice with no stored currency (the rules match cannot pass)', () => {
    expect(isCreditableInvoice(invoice({ currency: undefined }))).toBe(false)
    expect(isCreditableInvoice(invoice({ currency: '' }))).toBe(false)
  })
  it('creditableSupplierInvoices filters a mixed register', () => {
    const list = [invoice(), invoice({ id: 'inv2', status: 'approved' }), invoice({ id: 'inv3', retentionTotal: 55 })]
    expect(creditableSupplierInvoices(list).map(i => i.id)).toEqual(['inv1'])
  })
})

// ── Valid-target counting (the safe failure mode) ────────────────────────────

describe('creditTargetException / isCountingCreditNote', () => {
  it('a valid target yields no exception and the credit counts', () => {
    const map = byId([invoice()])
    expect(creditTargetException(credit(), map)).toBeNull()
    expect(isCountingCreditNote(credit(), map)).toBe(true)
  })
  it('a missing target is an exception — the credit counts nothing', () => {
    const map = byId([])
    expect(creditTargetException(credit(), map)).toMatch(/no longer exists/)
    expect(isCountingCreditNote(credit(), map)).toBe(false)
  })
  it('a cancelled target is an exception', () => {
    const map = byId([invoice({ status: 'cancelled' })])
    expect(creditTargetException(credit(), map)).toMatch(/cancelled/)
  })
  it('a target forged to the deprecated paid status STILL counts — it still counts toward Invoiced/Actual', () => {
    const map = byId([invoice({ status: 'paid' })])
    expect(creditTargetException(credit(), map)).toBeNull()
  })
  it('a supplier mismatch is an exception', () => {
    const map = byId([invoice({ supplierId: 'other' })])
    expect(creditTargetException(credit(), map)).toMatch(/different supplier/)
  })
  it('legacy null supplierIds match on the frozen name', () => {
    const map = byId([invoice({ supplierId: null, supplierName: ' ACE  concrete ' })])
    expect(creditTargetException(credit({ supplierId: null, supplierName: 'Ace Concrete' }), map)).toBeNull()
    expect(creditTargetException(credit({ supplierId: null, supplierName: 'Other Co' }), map)).toMatch(/different supplier/)
  })
  it('a currency mismatch is an exception', () => {
    const map = byId([invoice({ currency: 'NZD' })])
    expect(creditTargetException(credit(), map)).toMatch(/denominated/)
  })
  it('a draft or void credit never counts, even with a valid target', () => {
    const map = byId([invoice()])
    expect(isCountingCreditNote(credit({ status: 'draft' }), map)).toBe(false)
    expect(isCountingCreditNote(credit({ status: 'void' }), map)).toBe(false)
  })
})

// ── Read-time document integrity (what Firestore rules cannot see) ───────────
//
// Rules validate this document's shape, its header cent invariant, and its
// target via a get() — but they CANNOT iterate lineItems. Every case below is a
// document rules would ACCEPT, and each must contribute ZERO to BOTH the
// payable derivation (which reads grossTotal) and the cost derivation (which
// reads the lines), and be surfaced as an exception. Nothing is ever clamped.

describe('read-time integrity — malformed documents contribute ZERO to BOTH derivations', () => {
  const invoices = [invoice()]
  const map = byId(invoices)

  // Asserts the whole safe-failure contract in one place.
  const expectExcluded = (cn, reasonPattern) => {
    expect(creditTargetException(cn, map)).toMatch(reasonPattern)
    expect(isCountingCreditNote(cn, map)).toBe(false)
    expect(creditedByInvoice([cn], invoices)).toEqual({})   // payable side: zero
    expect(creditedByCostCode([cn], invoices)).toEqual({})  // cost side: zero
    const ex = creditNoteExceptions([cn], invoices)         // and surfaced
    expect(ex).toHaveLength(1)
    expect(ex[0].reason).toMatch(reasonPattern)
  }

  it('THE PROVEN EXPLOIT: grossTotal 100 while lineItems total 50,000', () => {
    // Rules accept this: cents(90.91 + 9.09) === cents(100), and 100 <= 1100.
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 50000, taxCode: 'gst', gstAmount: 5000 }],
      subtotal: 90.91, gstTotal: 9.09, grossTotal: 100,
    }), /do not reconcile/)
  })

  it('the exploit leaves AP and Actual completely intact', () => {
    const forged = credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 50000, taxCode: 'gst', gstAmount: 5000 }],
      subtotal: 90.91, gstTotal: 9.09, grossTotal: 100,
    })
    const rows = supplierInvoiceReconciliationRows(invoices, [], [forged])
    expect(rows[0].credited).toBe(0)
    expect(rows[0].remaining).toBe(1100)

    const fr = buildForecastRows({
      costCodes: [{ id: 'cc1', code: '03-100', name: 'Concrete', isActive: true }],
      budgetLines: [],
      purchaseOrders: [{ id: 'po1', status: 'sent', lineItems: [{ costCodeId: 'cc1', lineTotal: 1000 }] }],
      progressClaims: [], supplierInvoices: [invoice({ poId: 'po1' })],
      supplierCreditNotes: [forged], variations: [], forecastLines: [],
    })
    expect(fr.find(r => r.costCodeId === 'cc1').actual).toBe(600) // unreduced
  })

  it('header/line mismatch in the understating direction is excluded too', () => {
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 10, taxCode: 'gst', gstAmount: 1 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110,
    }), /do not reconcile/)
  })

  it('a one-cent header discrepancy is excluded (no tolerance beyond the cent)', () => {
    expectExcluded(credit({ grossTotal: 110.01 }), /do not reconcile/)
  })

  it('forged per-line GST', () => {
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 100, taxCode: 'gst', gstAmount: 90 }],
      subtotal: 100, gstTotal: 90, grossTotal: 190,
    }), /stored GST/)
  })

  it('GST claimed on a GST-free line', () => {
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 100, taxCode: 'gst_free', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110,
    }), /stored GST/)
  })

  it('an unknown tax code', () => {
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 100, taxCode: 'zero_rated', gstAmount: 10 }],
      subtotal: 100, gstTotal: 10, grossTotal: 110,
    }), /unknown tax code/)
  })

  it('a cost code that is not on the target invoice', () => {
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc9', costCodeName: '09-900 — Other', description: 'x', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    }), /not on SI-0001/)
  })

  it('offsetting +/− lines that reconcile to an innocuous header (the header-check bypass)', () => {
    // subtotal 100 / gst 10 / gross 110 all reconcile, but cc1 would be credited
    // 50,000 and cc2 credited −49,900. Positive-amount enforcement closes this.
    expectExcluded(credit({
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 50000, taxCode: 'gst', gstAmount: 5000 },
        { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'y', amount: -49900, taxCode: 'gst', gstAmount: -4990 },
      ],
      subtotal: 100, gstTotal: 10, grossTotal: 110,
    }), /positive ex-GST amount/)
  })

  it('a zero-amount or non-numeric line', () => {
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 0, taxCode: 'gst', gstAmount: 0 }],
      subtotal: 0, gstTotal: 0, grossTotal: 0,
    }), /positive ex-GST amount/)
    expectExcluded(credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 'lots', taxCode: 'gst', gstAmount: 0 }],
      subtotal: 0, gstTotal: 0, grossTotal: 0,
    }), /positive ex-GST amount/)
  })

  it('missing or non-array lineItems — and the derivations never throw', () => {
    expectExcluded(credit({ lineItems: [] }), /no readable line items/)
    expectExcluded(credit({ lineItems: undefined }), /no readable line items/)
    const notAList = credit({ lineItems: { cc1: 100 } })
    expect(() => creditedByCostCode([notAList], invoices)).not.toThrow()
    expectExcluded(notAList, /no readable line items/)
  })

  it('retention appearing on the target AFTER the credit posted', () => {
    const retained = [invoice({ retention: 500, retentionGst: 50, retentionTotal: 550, payableTotal: 550 })]
    const cn = credit()
    expect(creditTargetException(cn, byId(retained))).toMatch(/withholds retention/)
    expect(creditedByInvoice([cn], retained)).toEqual({})
    expect(creditedByCostCode([cn], retained)).toEqual({})
    expect(creditNoteExceptions([cn], retained)).toHaveLength(1)
  })

  it('payableTotal reduced below the credit AFTER it posted', () => {
    const shrunk = [invoice({ payableTotal: 10 })]
    const cn = credit()
    expect(creditTargetException(cn, byId(shrunk))).toMatch(/exceeds/)
    expect(creditedByInvoice([cn], shrunk)).toEqual({})
    expect(creditedByCostCode([cn], shrunk)).toEqual({})
  })

  it('a credit gross above the target payable is excluded', () => {
    const small = [invoice({ subtotal: 50, gstTotal: 5, grossTotal: 55, payableTotal: 55 })]
    const cn = credit() // 110 gross against a 55 payable
    expect(creditTargetException(cn, byId(small))).toMatch(/exceeds/)
    expect(creditedByInvoice([cn], small)).toEqual({})
  })

  it('an invalid posted credit still consumes cumulative headroom (conservative cap)', () => {
    // The cap is measured on stored gross regardless of validity, so a forgery
    // can never WIDEN the room available to a later legitimate credit.
    const forged = credit({ grossTotal: 1000, subtotal: 999, gstTotal: 1 })
    expect(postedCreditedGrossForInvoice([forged], 'inv1')).toBe(1000)
  })

  it('VALID credit notes are unaffected and still contribute normally', () => {
    const cn = credit()
    expect(creditTargetException(cn, map)).toBeNull()
    expect(isCountingCreditNote(cn, map)).toBe(true)
    expect(creditedByInvoice([cn], invoices)).toEqual({ inv1: 110 })
    expect(creditedByCostCode([cn], invoices)).toEqual({ cc1: 100 })
    expect(creditNoteExceptions([cn], invoices)).toEqual([])
    expect(creditNoteSummary([cn], invoices)).toMatchObject({ postedCount: 1, postedGross: 110, exceptionCount: 0 })
  })

  it('a mixed set counts only the valid credit and reports the rest', () => {
    const valid = credit({ id: 'ok' })
    const forged = credit({ id: 'bad', creditNumber: 'SCN-0002', grossTotal: 100, subtotal: 90.91, gstTotal: 9.09 })
    expect(creditedByInvoice([valid, forged], invoices)).toEqual({ inv1: 110 })
    expect(creditedByCostCode([valid, forged], invoices)).toEqual({ cc1: 100 })
    expect(creditNoteExceptions([valid, forged], invoices)).toHaveLength(1)
    expect(creditNoteSummary([valid, forged], invoices)).toMatchObject({
      postedCount: 1, postedGross: 110, exceptionCount: 1, exceptionGross: 100,
    })
  })

  it('a malformed DRAFT is not reported as an exception (drafts count nothing anyway)', () => {
    const draftForged = credit({ status: 'draft', grossTotal: 100, subtotal: 90.91, gstTotal: 9.09 })
    expect(creditNoteExceptions([draftForged], invoices)).toEqual([])
    expect(creditedByInvoice([draftForged], invoices)).toEqual({})
  })

  it('voiding an invalid credit removes it from the exceptions panel', () => {
    const voidForged = credit({ status: 'void', grossTotal: 100, subtotal: 90.91, gstTotal: 9.09 })
    expect(creditNoteExceptions([voidForged], invoices)).toEqual([])
  })
})

// ── Derivations ──────────────────────────────────────────────────────────────

describe('creditedByInvoice — gross reduction per invoice', () => {
  it('sums posted valid-target credits by gross total', () => {
    const invoices = [invoice()]
    const credits = [credit(), credit({
      id: 'cn2', creditNumber: 'SCN-0002',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'More', amount: 50, taxCode: 'gst', gstAmount: 5 }],
      subtotal: 50, gstTotal: 5, grossTotal: 55,
    })]
    expect(creditedByInvoice(credits, invoices)).toEqual({ inv1: 165 })
  })
  it('drafts and voids contribute nothing — voiding restores the balance', () => {
    const invoices = [invoice()]
    expect(creditedByInvoice([credit({ status: 'draft' })], invoices)).toEqual({})
    expect(creditedByInvoice([credit({ status: 'void' })], invoices)).toEqual({})
  })
  it('a broken target contributes ZERO — cost stays visible (safe failure)', () => {
    expect(creditedByInvoice([credit()], [invoice({ status: 'cancelled' })])).toEqual({})
    expect(creditedByInvoice([credit()], [])).toEqual({})
  })
})

describe('creditedByCostCode — ex-GST reduction per cost code', () => {
  it('groups posted valid-target credit lines by cost code, ex-GST', () => {
    // Headers must reconcile to the lines — an internally inconsistent document
    // is now excluded entirely (see the integrity describe below).
    const credits = [credit({
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'a', amount: 60, taxCode: 'gst', gstAmount: 6 },
        { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'b', amount: 40, taxCode: 'gst', gstAmount: 4 },
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'c', amount: 10, taxCode: 'gst', gstAmount: 1 },
      ],
      subtotal: 110, gstTotal: 11, grossTotal: 121,
    })]
    expect(creditedByCostCode(credits, [invoice()])).toEqual({ cc1: 70, cc2: 40 })
  })
  it('a line with no cost code invalidates the document, and broken targets are ignored', () => {
    expect(creditedByCostCode([credit({
      lineItems: [{ costCodeId: null, costCodeName: '', description: 'x', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    })], [invoice()])).toEqual({})
    expect(creditedByCostCode([credit()], [invoice({ status: 'draft' })])).toEqual({})
  })
})

describe('creditNoteExceptions', () => {
  it('lists posted credits with broken targets, with reasons', () => {
    const out = creditNoteExceptions([credit()], [invoice({ status: 'cancelled' })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ creditNoteId: 'cn1', creditNumber: 'SCN-0001', grossTotal: 110 })
    expect(out[0].reason).toMatch(/cancelled/)
  })
  it('valid targets and non-posted credits produce no exceptions', () => {
    expect(creditNoteExceptions([credit()], [invoice()])).toEqual([])
    expect(creditNoteExceptions([credit({ status: 'draft' })], [])).toEqual([])
  })
})

// ── Over-credit (HARD BLOCK, cumulative) ─────────────────────────────────────

describe('overCreditError — cumulative cap against payableTotal', () => {
  it('allows a credit up to the exact payable total, to the cent', () => {
    expect(overCreditError({ invoice: invoice(), proposedGross: 1100, creditNotes: [] })).toBeNull()
  })
  it('blocks one cent beyond the payable total', () => {
    expect(overCreditError({ invoice: invoice(), proposedGross: 1100.01, creditNotes: [] })).toMatch(/exceeding its payable total/)
  })
  it('counts existing POSTED credits toward the cap', () => {
    const existing = [credit({ grossTotal: 1000 })]
    expect(overCreditError({ invoice: invoice(), proposedGross: 100, creditNotes: existing })).toBeNull()
    expect(overCreditError({ invoice: invoice(), proposedGross: 100.01, creditNotes: existing })).toMatch(/exceeding/)
  })
  it('ignores drafts and voids, and excludes the credit being edited', () => {
    const existing = [
      credit({ id: 'cnA', grossTotal: 1000 }),
      credit({ id: 'cnB', status: 'draft', grossTotal: 500 }),
      credit({ id: 'cnC', status: 'void', grossTotal: 500 }),
    ]
    expect(overCreditError({ invoice: invoice(), proposedGross: 1100, creditNotes: existing, excludeCreditNoteId: 'cnA' })).toBeNull()
    expect(overCreditError({ invoice: invoice(), proposedGross: 200, creditNotes: existing })).toMatch(/exceeding/)
  })
  it('the cap is conservative: a posted credit with a broken link still consumes headroom', () => {
    // postedCreditedGrossForInvoice deliberately ignores target validity.
    expect(postedCreditedGrossForInvoice([credit({ grossTotal: 400 })], 'inv1')).toBe(400)
  })
  it('survives IEEE-754 cent values', () => {
    const inv = invoice({ payableTotal: 0.3 })
    expect(overCreditError({ invoice: inv, proposedGross: 0.1, creditNotes: [credit({ grossTotal: 0.2 })] })).toBeNull()
    expect(overCreditError({ invoice: inv, proposedGross: 0.11, creditNotes: [credit({ grossTotal: 0.2 })] })).toMatch(/exceeding/)
  })
})

// ── The contract the editor's over-credit MESSAGE relies on ──────────────────
//
// The modal cannot be rendered here (no jsdom — the documented ADR-26
// constraint), so these pin the domain behaviour the message is built on:
// detection must depend on AMOUNTS ALONE, so the explanation can appear the
// moment the figures are wrong rather than waiting for unrelated fields; and
// whenever it fires, the draft must still be hard-blocked.

describe('over-credit messaging contract (editor)', () => {
  const inv = invoice()   // payableTotal 1100
  const lines = (amount, gst) => [{
    costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
    description: 'x', amount, taxCode: 'gst', gstAmount: gst,
  }]

  it('detects over-credit from the amounts alone — no reason or date needed', () => {
    // This is the bug the message fixes: the editor disabled Create while the
    // reason was still blank, and said nothing.
    expect(overCreditError({ invoice: inv, proposedGross: 1100.01, creditNotes: [] })).not.toBeNull()
  })

  it('the remaining creditable amount the message quotes = payableTotal − posted credits', () => {
    const posted = [credit({ grossTotal: 200 })]
    const alreadyCredited = postedCreditedGrossForInvoice(posted, inv.id)
    expect(alreadyCredited).toBe(200)
    const remainingCreditable = roundMoney((inv.payableTotal || 0) - alreadyCredited)
    expect(remainingCreditable).toBe(900)
    // Exactly the remaining amount is accepted; one cent more is not.
    expect(overCreditError({ invoice: inv, proposedGross: remainingCreditable, creditNotes: posted })).toBeNull()
    expect(overCreditError({ invoice: inv, proposedGross: 900.01, creditNotes: posted })).not.toBeNull()
  })

  it('whenever the message shows, the draft is still HARD-BLOCKED (Save stays disabled)', () => {
    const draft = { supplierInvoiceId: 'inv1', creditDate: '2026-02-01', reason: 'Over-claimed', lineItems: lines(1500, 150) }
    const ctx = { invoice: inv, creditNotes: [] }
    expect(overCreditError({ invoice: inv, proposedGross: 1650, creditNotes: [] })).not.toBeNull()
    expect(validateCreditNoteDraft(draft, ctx)).not.toBeNull()   // → valid === false → button disabled
  })

  it('covers the single-document case too, so one message serves both caps', () => {
    // No siblings at all: the credit alone exceeds the payable.
    expect(overCreditError({ invoice: inv, proposedGross: 2200, creditNotes: [] })).not.toBeNull()
  })

  it('is silent for a credit that fits, so the message never nags', () => {
    expect(overCreditError({ invoice: inv, proposedGross: 1100, creditNotes: [] })).toBeNull()
    expect(validateCreditNoteDraft(
      { supplierInvoiceId: 'inv1', creditDate: '2026-02-01', reason: 'r', lineItems: lines(1000, 100) },
      { invoice: inv, creditNotes: [] },
    )).toBeNull()
  })

  it('a fully-credited invoice quotes zero remaining, never a negative', () => {
    const posted = [credit({ grossTotal: 1100 })]
    const remaining = roundMoney((inv.payableTotal || 0) - postedCreditedGrossForInvoice(posted, inv.id))
    expect(remaining).toBe(0)
    expect(Math.max(remaining, 0)).toBe(0)          // what the message renders
    expect(overCreditError({ invoice: inv, proposedGross: 0.01, creditNotes: posted })).not.toBeNull()
  })
})

// ── Target cost codes ────────────────────────────────────────────────────────

describe('targetInvoiceCostCodes', () => {
  it('returns the unique cost codes on the target invoice, with frozen names', () => {
    expect(targetInvoiceCostCodes(invoice())).toEqual([
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete' },
      { costCodeId: 'cc2', costCodeName: '03-200 — Formwork' },
    ])
  })
  it('deduplicates repeated codes and skips null ids', () => {
    const inv = invoice({
      lineItems: [
        { costCodeId: 'cc1', costCodeName: 'A', amount: 1 },
        { costCodeId: 'cc1', costCodeName: 'A2', amount: 2 },
        { costCodeId: null, costCodeName: 'X', amount: 3 },
      ],
    })
    expect(targetInvoiceCostCodes(inv)).toEqual([{ costCodeId: 'cc1', costCodeName: 'A' }])
  })
})

// ── Validation ───────────────────────────────────────────────────────────────

describe('validateCreditNoteDraft', () => {
  const goodLines = [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Overclaim', amount: 100, taxCode: 'gst', gstAmount: 10 }]
  const good = { supplierInvoiceId: 'inv1', creditDate: '2026-02-01', reason: 'Over-claimed', lineItems: goodLines }

  it('accepts a valid draft', () => {
    expect(validateCreditNoteDraft(good, { invoice: invoice(), creditNotes: [] })).toBeNull()
  })
  it('requires a target', () => {
    expect(validateCreditNoteDraft({ ...good, supplierInvoiceId: '' }, {})).toMatch(/Select the posted supplier invoice/)
  })
  it('rejects a non-posted target with its status named', () => {
    expect(validateCreditNoteDraft(good, { invoice: invoice({ status: 'approved' }) })).toMatch(/approved/)
  })
  it('rejects a retained target, naming the block', () => {
    expect(validateCreditNoteDraft(good, { invoice: invoice({ retentionTotal: 55 }) })).toMatch(/retention/i)
  })
  it('requires date, reason, and at least one line', () => {
    expect(validateCreditNoteDraft({ ...good, creditDate: '' }, { invoice: invoice() })).toMatch(/date/)
    expect(validateCreditNoteDraft({ ...good, reason: '  ' }, { invoice: invoice() })).toMatch(/reason/)
    expect(validateCreditNoteDraft({ ...good, lineItems: [] }, { invoice: invoice() })).toMatch(/at least one line/)
  })
  it('caps the line count', () => {
    const lines = Array.from({ length: MAX_CREDIT_NOTE_LINES + 1 }, () => goodLines[0])
    expect(validateCreditNoteDraft({ ...good, lineItems: lines }, { invoice: invoice() })).toMatch(/more than/)
  })
  it('requires description, positive amount, tax code, and cost code per line', () => {
    const base = goodLines[0]
    expect(validateCreditNoteDraft({ ...good, lineItems: [{ ...base, description: ' ' }] }, { invoice: invoice() })).toMatch(/description/)
    expect(validateCreditNoteDraft({ ...good, lineItems: [{ ...base, amount: 0 }] }, { invoice: invoice() })).toMatch(/greater than zero/)
    expect(validateCreditNoteDraft({ ...good, lineItems: [{ ...base, amount: -5 }] }, { invoice: invoice() })).toMatch(/greater than zero/)
    expect(validateCreditNoteDraft({ ...good, lineItems: [{ ...base, taxCode: 'nope' }] }, { invoice: invoice() })).toMatch(/tax code/)
    expect(validateCreditNoteDraft({ ...good, lineItems: [{ ...base, costCodeId: '' }] }, { invoice: invoice() })).toMatch(/cost code/)
  })
  it('rejects a cost code the target invoice never charged', () => {
    const lines = [{ ...goodLines[0], costCodeId: 'cc9', costCodeName: '09-900 — Other' }]
    expect(validateCreditNoteDraft({ ...good, lineItems: lines }, { invoice: invoice() })).toMatch(/not on SI-0001/)
  })
  it('hard-blocks a single credit above the payable total', () => {
    const lines = [{ ...goodLines[0], amount: 1001, gstAmount: 100.1 }]
    expect(validateCreditNoteDraft({ ...good, lineItems: lines }, { invoice: invoice() })).toMatch(/exceeds SI-0001/)
  })
  it('hard-blocks the CUMULATIVE cap across posted siblings', () => {
    const existing = [credit({ grossTotal: 1050 })]
    expect(validateCreditNoteDraft(good, { invoice: invoice(), creditNotes: existing })).toMatch(/exceeding its payable total/)
    expect(validateCreditNoteDraft(good, { invoice: invoice(), creditNotes: [] })).toBeNull()
  })
})

describe('postBlockedReason — re-checked against CURRENT data at post time', () => {
  it('allows posting a valid draft', () => {
    expect(postBlockedReason(credit({ status: 'draft' }), [invoice()], [])).toBeNull()
  })
  it('blocks a non-draft credit', () => {
    expect(postBlockedReason(credit(), [invoice()], [])).toMatch(/Only a draft/)
    expect(postBlockedReason(credit({ status: 'void' }), [invoice()], [])).toMatch(/Only a draft/)
  })
  it('blocks when the target has since been cancelled or is missing', () => {
    expect(postBlockedReason(credit({ status: 'draft' }), [invoice({ status: 'cancelled' })], [])).toMatch(/cancelled/)
    expect(postBlockedReason(credit({ status: 'draft' }), [], [])).toMatch(/could not be found/)
  })
  it('blocks when retention has since appeared on the target', () => {
    expect(postBlockedReason(credit({ status: 'draft' }), [invoice({ retentionTotal: 55 })], [])).toMatch(/retention/i)
  })
  it('blocks when a sibling credit posted since the draft was saved consumed the cap', () => {
    const sibling = credit({ id: 'cn2', grossTotal: 1050 })
    expect(postBlockedReason(credit({ status: 'draft' }), [invoice()], [sibling])).toMatch(/exceeding its payable total/)
  })
})

// ── Line building & duplicates ───────────────────────────────────────────────

describe('buildCreditNoteLineItems', () => {
  it('drops empty rows and freezes the cost-code display name', () => {
    const rows = [
      { costCodeId: 'cc1', description: ' Overclaim ', amount: 100, taxCode: 'gst', gstAmount: 10 },
      { costCodeId: '', description: 'ignored', amount: 50, taxCode: 'gst', gstAmount: 5 },
      { costCodeId: 'cc2', description: 'zero', amount: 0, taxCode: 'gst', gstAmount: 0 },
    ]
    const out = buildCreditNoteLineItems(rows, targetInvoiceCostCodes(invoice()))
    expect(out).toEqual([{
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
      description: 'Overclaim', amount: 100, taxCode: 'gst', gstAmount: 10,
    }])
  })
})

describe('duplicateCreditWarnings', () => {
  it('warns when the supplier credit reference repeats for the same supplier', () => {
    const existing = [credit()]
    const w = duplicateCreditWarnings(existing, { supplierId: 'sup1', supplierName: 'Ace Concrete', supplierCreditReference: ' cn-9 ' })
    expect(w).toHaveLength(1)
    expect(w[0].message).toMatch(/SCN-0001/)
  })
  it('ignores void credits, other suppliers, blank refs, and the credit being edited', () => {
    const existing = [credit()]
    expect(duplicateCreditWarnings([credit({ status: 'void' })], { supplierId: 'sup1', supplierCreditReference: 'CN-9' })).toEqual([])
    expect(duplicateCreditWarnings(existing, { supplierId: 'other', supplierCreditReference: 'CN-9' })).toEqual([])
    expect(duplicateCreditWarnings(existing, { supplierId: 'sup1', supplierCreditReference: '' })).toEqual([])
    expect(duplicateCreditWarnings(existing, { id: 'cn1', supplierId: 'sup1', supplierCreditReference: 'CN-9' })).toEqual([])
  })
})

// ── Display helpers ──────────────────────────────────────────────────────────

describe('creditNotesForInvoice / creditNoteSummary', () => {
  it('filters by target and sorts newest number first', () => {
    const credits = [credit(), credit({ id: 'cn2', creditNumber: 'SCN-0002' }), credit({ id: 'cn3', supplierInvoiceId: 'other' })]
    expect(creditNotesForInvoice(credits, 'inv1').map(c => c.creditNumber)).toEqual(['SCN-0002', 'SCN-0001'])
  })
  it('summary separates counting gross, exception gross, and drafts', () => {
    const invoices = [invoice()]
    const credits = [
      credit(),                                                       // counts: 110
      credit({ id: 'cn2', supplierInvoiceId: 'missing', grossTotal: 40 }), // exception
      credit({ id: 'cn3', status: 'draft', grossTotal: 20 }),          // draft
    ]
    expect(creditNoteSummary(credits, invoices)).toEqual({
      postedCount: 1, postedGross: 110,
      exceptionCount: 1, exceptionGross: 40,
      draftCount: 1, draftGross: 20,
    })
  })
})

// ── AP integration (lib/supplierPayments.js) ─────────────────────────────────

describe('AP reconciliation — payments and credits settle the payable together', () => {
  it('remaining payable = payableTotal − paid − credited, with separate columns', () => {
    const rows = supplierInvoiceReconciliationRows([invoice()], [payment(500)], [credit()])
    expect(rows).toHaveLength(1)
    expect(rows[0].paid).toBe(500)
    expect(rows[0].credited).toBe(110)
    expect(rows[0].remaining).toBe(490)
    expect(rows[0].state).toBe('partly_reconciled')
  })
  it('a fully-credited unpaid invoice reads fully reconciled and leaves ageing', () => {
    const cn = credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Full', amount: 1000, taxCode: 'gst', gstAmount: 100 }],
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
    })
    const rows = supplierInvoiceReconciliationRows([invoice()], [], [cn])
    expect(rows[0].remaining).toBe(0)
    expect(rows[0].state).toBe('fully_reconciled')
    const ageing = apAgeing([invoice()], [], [cn], new Date('2026-03-15T00:00:00'))
    expect(ageing.total).toBe(0)
    expect(ageing.overSettled).toEqual([])
  })
  it('credit after FULL payment goes over-reconciled — money recoverable, never netted into arrears', () => {
    const ageing = apAgeing([invoice()], [payment(1100)], [credit()], new Date('2026-03-15T00:00:00'))
    expect(ageing.total).toBe(0)
    expect(ageing.overSettled).toHaveLength(1)
    const summary = payablesSummary([invoice()], [payment(1100)], [credit()])
    expect(summary.credited).toBe(110)
    expect(summary.overReconciled).toBe(-110)
    expect(summary.remaining).toBe(0)
  })
  it('a broken-target credit changes NO balance (safe failure)', () => {
    const rows = supplierInvoiceReconciliationRows([invoice()], [], [credit({ supplierInvoiceId: 'missing' })])
    expect(rows[0].credited).toBe(0)
    expect(rows[0].remaining).toBe(1100)
  })
  it('remainingPayable helper accepts the credited component', () => {
    expect(remainingPayable(invoice(), 500, 110)).toBe(490)
    expect(remainingPayable(invoice(), 0, 0)).toBe(1100)
  })
  it('the payment picker offers the NET remaining and carries the credited figure', () => {
    const targets = allocatableSupplierInvoices([invoice()], 'sup1', 'Ace Concrete', [], { creditNotes: [credit()] })
    expect(targets).toHaveLength(1)
    expect(targets[0].credited).toBe(110)
    expect(targets[0].remaining).toBe(990)
  })
  it('over-payment warnings fire against the credit-reduced remaining', () => {
    const allocations = [{ supplierInvoiceId: 'inv1', allocatedAmount: 1000 }]
    const w = invoiceOverPaymentWarnings(allocations, [invoice()], [], { creditNotes: [credit()] })
    expect(w).toHaveLength(1)
    expect(w[0].excess).toBe(10)
  })
})

// ── Why a failed credit-note read must NOT be treated as an empty list ───────
//
// The pages cannot be unit-tested here (no jsdom — the documented ADR-26
// constraint), so these assert the LIB FACT that makes the page guard
// necessary: an empty credit list is not a neutral default, it is an
// OVERSTATEMENT of what is still payable. ProjectSupplierPayments and
// ProjectInvoices therefore render those figures unavailable and disable the
// actions that consume them whenever the read failed (manual test §15r-xv).

describe('an empty credit list OVERSTATES the payable — why unavailable ≠ zero', () => {
  it('remaining payable is higher when credits are missing than when they are read', () => {
    const withCredits = supplierInvoiceReconciliationRows([invoice()], [payment(500)], [credit()])
    const asIfNone    = supplierInvoiceReconciliationRows([invoice()], [payment(500)], [])
    expect(withCredits[0].remaining).toBe(490)
    expect(asIfNone[0].remaining).toBe(600)   // 110 too high — money already credited
    expect(asIfNone[0].remaining).toBeGreaterThan(withCredits[0].remaining)
  })

  it('the allocation picker would offer the overstated figure, permitting an over-payment', () => {
    const truthful = allocatableSupplierInvoices([invoice()], 'sup1', 'Ace Concrete', [], { creditNotes: [credit()] })
    const blind    = allocatableSupplierInvoices([invoice()], 'sup1', 'Ace Concrete', [], { creditNotes: [] })
    expect(truthful[0].remaining).toBe(990)
    expect(blind[0].remaining).toBe(1100)     // would invite paying 110 already credited
  })

  it('AP ageing would age money that is no longer owed', () => {
    const now = new Date('2026-03-15T00:00:00')
    const truthful = apAgeing([invoice()], [], [credit()], now)
    const blind    = apAgeing([invoice()], [], [], now)
    expect(truthful.total).toBe(990)
    expect(blind.total).toBe(1100)
  })
})

// ── Forecast / Actual integration (lib/forecast.js) ──────────────────────────

describe('buildForecastRows — credits reduce Actual, never Remaining Committed', () => {
  const sources = () => ({
    costCodes: [
      { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
      { id: 'cc2', code: '03-200', name: 'Formwork', isActive: true },
    ],
    budgetLines: [],
    purchaseOrders: [{
      id: 'po1', status: 'sent',
      lineItems: [
        { costCodeId: 'cc1', lineTotal: 1000 },
        { costCodeId: 'cc2', lineTotal: 400 },
      ],
    }],
    progressClaims: [],
    supplierInvoices: [invoice({ poId: 'po1' })],
    supplierCreditNotes: [credit()],
    variations: [],
    forecastLines: [],
  })

  it('Actual is net of posted valid-target credits, by cost code', () => {
    const rows = buildForecastRows(sources())
    const cc1 = rows.find(r => r.costCodeId === 'cc1')
    const cc2 = rows.find(r => r.costCodeId === 'cc2')
    expect(cc1.actual).toBe(500)  // 600 invoiced − 100 credited
    expect(cc2.actual).toBe(400)  // untouched
  })
  it('Remaining Committed is NOT restored by a credit (ADR-31 limitation)', () => {
    const rows = buildForecastRows(sources())
    const cc1 = rows.find(r => r.costCodeId === 'cc1')
    expect(cc1.remainingCommitted).toBe(400) // 1000 − 600 invoiced; the credit changes nothing
  })
  it('an over-credited cost code goes NEGATIVE and stays visible — never clamped', () => {
    const src = sources()
    src.supplierCreditNotes = [credit({
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'x', amount: 700, taxCode: 'gst', gstAmount: 70 }],
      subtotal: 700, gstTotal: 70, grossTotal: 770,
    })]
    const rows = buildForecastRows(src)
    expect(rows.find(r => r.costCodeId === 'cc1').actual).toBe(-100)
  })
  it('a credit against a broken target changes nothing', () => {
    const src = sources()
    src.supplierCreditNotes = [credit({ supplierInvoiceId: 'missing' })]
    const rows = buildForecastRows(src)
    expect(rows.find(r => r.costCodeId === 'cc1').actual).toBe(600)
  })
  it('a cost code that appears ONLY through a credit still gets a row', () => {
    const src = sources()
    src.purchaseOrders = []
    src.supplierInvoices = [invoice({
      poId: null,
      lineItems: [{ costCodeId: 'cc9', costCodeName: 'Legacy', description: 'x', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    })]
    src.supplierCreditNotes = [credit({
      lineItems: [{ costCodeId: 'cc9', costCodeName: 'Legacy', description: 'x', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    })]
    const row = buildForecastRows(src).find(r => r.costCodeId === 'cc9')
    expect(row).toBeDefined()
    expect(row.actual).toBe(0)
  })
  it('omitting supplierCreditNotes leaves every figure exactly as before (backwards compatible)', () => {
    const src = sources()
    delete src.supplierCreditNotes
    const rows = buildForecastRows(src)
    expect(rows.find(r => r.costCodeId === 'cc1').actual).toBe(600)
  })
})

// ── Purity ───────────────────────────────────────────────────────────────────

describe('purity — inputs are never mutated', () => {
  it('derivations leave credits and invoices untouched', () => {
    const invoices = [invoice()]
    const credits = [credit()]
    const invoicesSnapshot = JSON.parse(JSON.stringify(invoices))
    const creditsSnapshot = JSON.parse(JSON.stringify(credits))

    creditedByInvoice(credits, invoices)
    creditedByCostCode(credits, invoices)
    creditNoteExceptions(credits, invoices)
    creditNoteSummary(credits, invoices)
    supplierInvoiceReconciliationRows(invoices, [payment(200)], credits)
    payablesSummary(invoices, [payment(200)], credits)
    apAgeing(invoices, [payment(200)], credits)
    overCreditError({ invoice: invoices[0], proposedGross: 10, creditNotes: credits })
    validateCreditNoteDraft(
      { supplierInvoiceId: 'inv1', creditDate: '2026-02-01', reason: 'r', lineItems: credits[0].lineItems },
      { invoice: invoices[0], creditNotes: credits },
    )

    expect(invoices).toEqual(invoicesSnapshot)
    expect(credits).toEqual(creditsSnapshot)
  })
})
