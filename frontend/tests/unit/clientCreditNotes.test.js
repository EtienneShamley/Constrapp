import { describe, it, expect } from 'vitest'
import {
  CCN_STATUS, CCN_STATUS_LABELS, CCN_BADGE_VARIANTS, CCN_TRANSITIONS, canTransition,
  CCN_DOC_TYPE, CLIENT_CREDIT_NOTE_COUNTER_ID, formatClientCreditNoteNumber, MAX_CLIENT_CREDIT_LINES,
  postedClientCreditNotes, draftClientCreditNotes, isCreditableClientInvoice,
  buildClientCreditNote, clientCreditException, invoicesById,
  countingClientCreditNotes, clientCreditExceptions, CLIENT_CREDIT_EXCEPTION_REMEDY,
  creditedByVariation, creditNotesForInvoice, clientCreditSummary,
  validateClientCreditDraft, clientCreditPostBlockedReason, CLIENT_ENTRY_STALE_TEXT,
  CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE, CLIENT_CREDIT_NOTE_NOTICE,
} from '../../src/lib/clientCreditNotes'
import { gstForLine, invoiceTotals } from '../../src/lib/clientInvoices'
import { emptyLedger, readLedger, applyCredit, applyRelease, ledgerDocument, applyReceipt } from '../../src/lib/clientLedger'
import { buildClientRetentionRelease } from '../../src/lib/clientRetention'
import { receivablePositions, receivableContext } from '../../src/lib/clientReceivables'

// ── Client Credit Notes (ADR-87) — pure domain tests ─────────────────────────
//
// The load-bearing properties:
//   1. A CREDIT COPIES ITS SOURCE LINE. Tax code, variation and cost-code
//      snapshots come from the invoice line, never from the editor row.
//   2. THE READ-TIME GATE FAILS SAFE. A posted credit that fails any check
//      counts ZERO — the debt stays visible — and is listed as an exception.
//   3. A STALE DRAFT IS REFUSED, NOT RECALCULATED. A draft built before another
//      entry moved the ledger cannot be posted until it is re-saved.

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// An issued invoice with three lines, one linked to a client variation:
//   0: 600.00 gst        (GST 60.00)   contract works
//   1:  40.15 gst        (GST  4.02)   variation CV-0001, cost code cc1
//   2: 300.00 gst_free   (GST  0.00)
//   subtotal 940.15 · GST 64.02 · gross 1004.17

const lines = () => [
  { description: '  Contract works  ', amount: 600, taxCode: 'gst', gstAmount: gstForLine(600, 'gst'),
    variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
  { description: 'Variation works', amount: 40.15, taxCode: 'gst', gstAmount: gstForLine(40.15, 'gst'),
    variationId: 'v1', variationNumber: 'CV-0001', costCodeId: 'cc1', costCodeName: '03-100 — Concrete' },
  { description: 'GST-free supply', amount: 300, taxCode: 'gst_free', gstAmount: 0,
    variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
]

const invoice = (over = {}, retention = 0) => ({
  id: 'inv1', invoiceNumber: 'CI-0001', status: 'issued',
  clientId: 'client1', clientName: 'Acme Developments', currency: 'AUD',
  invoiceDate: '2026-10-01', dueDate: '2026-10-31',
  lineItems: lines(),
  ...invoiceTotals(lines(), retention),
  ...over,
})

// A credit note document as runClientCreditCreate stores it, built through the
// REAL builder against `ledger`.
function credit(inv, rows, { ledger = null, ...over } = {}) {
  const built = buildClientCreditNote(inv, ledger, rows)
  if (built.error) throw new Error(built.error)
  return {
    id: 'cn1', creditNumber: 'CCN-0001', status: 'posted', docType: 'credit_note',
    clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
    clientId: inv.clientId, clientName: inv.clientName, currency: inv.currency,
    creditDate: '2026-11-01', reason: 'Over-billed',
    lineItems: built.lineItems, ...built.totals, ledgerSeq: built.ledgerSeq,
    ...over,
  }
}

const ROWS = [{ invoiceLineIndex: 0, amount: 100 }, { invoiceLineIndex: 1, amount: 20.07 }]

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('has three statuses with labels and existing badge variants', () => {
    expect(CCN_STATUS).toEqual({ DRAFT: 'draft', POSTED: 'posted', VOID: 'void' })
    expect(CCN_STATUS_LABELS).toEqual({ draft: 'Draft', posted: 'Posted', void: 'Void' })
    expect(CCN_BADGE_VARIANTS).toEqual({ draft: 'soon', posted: 'active', void: 'danger' })
  })

  it('is forward-only and void is terminal', () => {
    expect(CCN_TRANSITIONS).toEqual({ draft: ['posted', 'void'], posted: ['void'], void: [] })
    expect(canTransition('draft', 'posted')).toBe(true)
    expect(canTransition('draft', 'void')).toBe(true)
    expect(canTransition('posted', 'void')).toBe(true)
    expect(canTransition('posted', 'draft')).toBe(false)
    expect(canTransition('void', 'posted')).toBe(false)
    expect(canTransition('void', 'draft')).toBe(false)
    expect(canTransition('draft', 'draft')).toBe(false)
    expect(canTransition('nonsense', 'posted')).toBe(false)
  })

  it('numbers, counter id and limits', () => {
    expect(CCN_DOC_TYPE).toBe('credit_note')
    expect(CLIENT_CREDIT_NOTE_COUNTER_ID).toBe('clientCreditNotes')
    expect(formatClientCreditNoteNumber(1)).toBe('CCN-0001')
    expect(formatClientCreditNoteNumber(42)).toBe('CCN-0042')
    expect(formatClientCreditNoteNumber(12345)).toBe('CCN-12345')
    expect(MAX_CLIENT_CREDIT_LINES).toBe(100)
  })

  it('filters posted and draft sets', () => {
    const set = [{ id: 'a', status: 'draft' }, { id: 'b', status: 'posted' }, { id: 'c', status: 'void' }, null]
    expect(postedClientCreditNotes(set).map(c => c.id)).toEqual(['b'])
    expect(draftClientCreditNotes(set).map(c => c.id)).toEqual(['a'])
    expect(postedClientCreditNotes(null)).toEqual([])
    expect(draftClientCreditNotes(undefined)).toEqual([])
  })

  it('only an issued invoice with a currency can be credited', () => {
    expect(isCreditableClientInvoice(invoice())).toBe(true)
    expect(isCreditableClientInvoice(invoice({ status: 'draft' }))).toBe(false)
    expect(isCreditableClientInvoice(invoice({ status: 'void' }))).toBe(false)
    expect(isCreditableClientInvoice(invoice({ currency: '' }))).toBe(false)
    expect(isCreditableClientInvoice(invoice({ currency: undefined }))).toBe(false)
    expect(isCreditableClientInvoice(null)).toBe(false)
  })
})

// ── Builder ──────────────────────────────────────────────────────────────────

describe('buildClientCreditNote', () => {
  it('copies each source line\'s description, tax code, variation and cost code', () => {
    const built = buildClientCreditNote(invoice(), null, [
      { invoiceLineIndex: 1, amount: 20.07, taxCode: 'gst_free', variationId: 'forged', description: 'forged' },
      { invoiceLineIndex: 0, amount: 100 },
    ])
    expect(built.error).toBeUndefined()
    expect(built.lineItems).toEqual([
      { invoiceLineIndex: 0, description: 'Contract works', amount: 100, taxCode: 'gst', gstAmount: 10,
        variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
      { invoiceLineIndex: 1, description: 'Variation works', amount: 20.07, taxCode: 'gst', gstAmount: 2.01,
        variationId: 'v1', variationNumber: 'CV-0001', costCodeId: 'cc1', costCodeName: '03-100 — Concrete' },
    ])
  })

  it('derives the stored totals, with no retention part on an invoice that withheld none', () => {
    const built = buildClientCreditNote(invoice(), null, ROWS)
    expect(built.totals).toEqual({
      subtotal: 120.07, gstTotal: 12.01, grossTotal: 132.08,
      retentionAmount: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: 132.08,
    })
    expect(built.ledgerSeq).toBe(0)
  })

  it('splits the credit between retention still held and the receivable', () => {
    // 10% withheld: retention 94.02, retention GST 64.02 × 94.02 ÷ 940.15 = 6.4023 → 6.40
    const inv = invoice({}, 94.02)
    expect(inv.retentionGst).toBe(6.4)
    const built = buildClientCreditNote(inv, null, [{ invoiceLineIndex: 0, amount: 100 }])
    // retention held 94.02 × 100 ÷ 940.15 still billed = 10.0005 → 10.00, leaving 84.02 held.
    // its GST: what stays HELD is the retained fraction of the GST still billed —
    //   (64.02 − 10.00) × 84.02 ÷ 840.15 = 5.4023 → 5.40 — so the credit takes
    //   6.40 − 5.40 = 1.00: the retained share of the taxable line it credits.
    expect(built.totals).toEqual({
      subtotal: 100, gstTotal: 10, grossTotal: 110,
      retentionAmount: 10, retentionGst: 1, retentionTotal: 11, receivableTotal: 99,
    })
  })

  it('a credit of a GST-free line frees NO retention GST', () => {
    const inv = invoice({}, 94.02)
    const built = buildClientCreditNote(inv, null, [{ invoiceLineIndex: 2, amount: 300 }])
    // 94.02 × 300 ÷ 940.15 = 30.0016 → 30.00, leaving 64.02 held.
    // GST left held: 64.02 still billed × 64.02 ÷ 640.15 = 6.4025 → 6.40 — all of
    // it. (An earlier rule took 2.04 here, on a credit that carries no GST.)
    expect(built.totals).toEqual({
      subtotal: 300, gstTotal: 0, grossTotal: 300,
      retentionAmount: 30, retentionGst: 0, retentionTotal: 30, receivableTotal: 270,
    })
    const cn = credit(inv, [{ invoiceLineIndex: 2, amount: 300 }])
    expect(clientCreditException(cn, invoicesById([inv]))).toBeNull()
  })

  it('crediting ALL the taxable value frees ALL the retention GST, more than a tenth of the retention part', () => {
    const inv = invoice({}, 94.02)
    // Lines 0 and 1 in full: 640.15 + 64.02 GST. Retention 94.02 × 640.15 ÷ 940.15
    // = 64.0184 → 64.02, leaving 30.00 held against the 300.00 GST-free line.
    // No GST is still billed, so none stays held: the credit takes all 6.40.
    const built = buildClientCreditNote(inv, null, [{ invoiceLineIndex: 0, amount: 600 }, { invoiceLineIndex: 1, amount: 40.15 }])
    expect(built.totals).toEqual({
      subtotal: 640.15, gstTotal: 64.02, grossTotal: 704.17,
      retentionAmount: 64.02, retentionGst: 6.4, retentionTotal: 70.42, receivableTotal: 633.75,
    })
  })

  it('is exact on a very large invoice — there is no 20,000,000.00 limit', () => {
    // 9,999,999,999.99 + GST 1,000,000,000.00; retention 1,000,000,000.00 + 100,000,000.00.
    const big = [{ description: 'Stage 1', amount: 9999999999.99, taxCode: 'gst', gstAmount: gstForLine(9999999999.99, 'gst'),
      variationId: null, variationNumber: '', costCodeId: null, costCodeName: null }]
    const inv = invoice({ lineItems: big, ...invoiceTotals(big, 1000000000) })
    expect(inv).toMatchObject({
      subtotal: 9999999999.99, gstTotal: 1000000000, grossTotal: 10999999999.99,
      retention: 1000000000, retentionGst: 100000000, retentionTotal: 1100000000, receivableTotal: 9899999999.99,
    })
    // Credit 2,500,000,000.00:
    //   GST        10^9 × 2.5×10^9 ÷ 9,999,999,999.99 = 250,000,000.00000025 → 250,000,000.00
    //   retention  the same fraction of 1,000,000,000.00                      → 250,000,000.00
    //   GST left held: 750,000,000.00 still billed GST × 750,000,000.00 ÷ 7,499,999,999.99
    //                  = 75,000,000.0000001 → 75,000,000.00, so it takes 25,000,000.00.
    const built = buildClientCreditNote(inv, null, [{ invoiceLineIndex: 0, amount: 2500000000 }])
    expect(built.totals).toEqual({
      subtotal: 2500000000, gstTotal: 250000000, grossTotal: 2750000000,
      retentionAmount: 250000000, retentionGst: 25000000, retentionTotal: 275000000, receivableTotal: 2475000000,
    })
    const cn = credit(inv, [{ invoiceLineIndex: 0, amount: 2500000000 }])
    expect(clientCreditException(cn, invoicesById([inv]))).toBeNull()
    // The rest, in one credit: everything still held and the stored GST exactly.
    const ledger = ledgerDocument(applyCredit(emptyLedger(), cn))
    const rest = buildClientCreditNote(inv, ledger, [{ invoiceLineIndex: 0, amount: 7499999999.99 }])
    expect(rest.totals).toEqual({
      subtotal: 7499999999.99, gstTotal: 750000000, grossTotal: 8249999999.99,
      retentionAmount: 750000000, retentionGst: 75000000, retentionTotal: 825000000, receivableTotal: 7424999999.99,
    })
  })

  it('remembers the ledger seq it was computed against', () => {
    const inv = invoice()
    const first = credit(inv, [{ invoiceLineIndex: 0, amount: 100 }])
    const ledger = ledgerDocument(applyCredit(emptyLedger(), first))
    const second = buildClientCreditNote(inv, ledger, [{ invoiceLineIndex: 0, amount: 100 }])
    expect(second.ledgerSeq).toBe(1)
    expect(buildClientCreditNote(inv, undefined, ROWS).ledgerSeq).toBe(0)
  })

  it('returns only an error when the allocation is refused', () => {
    expect(buildClientCreditNote(invoice(), null, [{ invoiceLineIndex: 0, amount: 600.01 }]))
      .toEqual({ error: 'Line 1: only 600.00 of 600.00 remains to credit.' })
    expect(buildClientCreditNote(invoice(), null, [])).toEqual({ error: 'Add at least one line with an amount.' })
    expect(buildClientCreditNote(invoice({ subtotal: 1 }), null, ROWS).error)
      .toMatch(/do not reconcile to its own lines/)
  })

  it('counts earlier credits on the same line through the ledger', () => {
    const inv = invoice()
    const first = credit(inv, [{ invoiceLineIndex: 1, amount: 20.07 }])
    const ledger = ledgerDocument(applyCredit(emptyLedger(), first))
    const rest = buildClientCreditNote(inv, ledger, [{ invoiceLineIndex: 1, amount: 20.08 }])
    // 2.01 + 2.01 = the line's 4.02 exactly.
    expect(rest.lineItems[0].gstAmount).toBe(2.01)
    expect(buildClientCreditNote(inv, ledger, [{ invoiceLineIndex: 1, amount: 20.09 }]).error)
      .toBe('Line 2: only 20.08 of 40.15 remains to credit.')
  })
})

// ── The read-time validity gate ──────────────────────────────────────────────

describe('clientCreditException — every failure branch', () => {
  const inv = invoice()
  const byId = invoicesById([inv])
  const good = () => credit(inv, ROWS)
  const withLine = (index, over) => {
    const cn = good()
    cn.lineItems = cn.lineItems.map((li, i) => (i === index ? { ...li, ...over } : li))
    return cn
  }

  it('a credit note built by the app passes', () => {
    expect(clientCreditException(good(), byId)).toBeNull()
    expect(clientCreditException(credit(invoice({}, 94.02), ROWS), invoicesById([invoice({}, 94.02)]))).toBeNull()
  })

  it('the target invoice is missing or unreadable', () => {
    expect(clientCreditException(good(), invoicesById([])))
      .toBe('The credited client invoice no longer exists or is not readable.')
    expect(clientCreditException(good(), null)).toBe('The credited client invoice no longer exists or is not readable.')
    expect(clientCreditException({ ...good(), clientInvoiceId: 'other' }, byId))
      .toBe('The credited client invoice no longer exists or is not readable.')
  })

  it('the target invoice is not issued', () => {
    expect(clientCreditException(good(), invoicesById([invoice({ status: 'void' })])))
      .toBe('CI-0001 is void — a credit note only counts against an issued client invoice.')
    expect(clientCreditException(good(), invoicesById([invoice({ status: 'draft' })])))
      .toBe('CI-0001 is draft — a credit note only counts against an issued client invoice.')
  })

  it('the client differs', () => {
    expect(clientCreditException({ ...good(), clientId: 'client2' }, byId))
      .toBe('CI-0001 belongs to a different client than this credit note.')
    expect(clientCreditException({ ...good(), clientId: undefined }, byId))
      .toBe('CI-0001 belongs to a different client than this credit note.')
  })

  it('the currency differs', () => {
    expect(clientCreditException({ ...good(), currency: 'NZD' }, byId))
      .toBe('CI-0001 is denominated in AUD, not NZD.')
    expect(clientCreditException({ ...good(), currency: undefined }, byId))
      .toBe('CI-0001 is denominated in AUD, not unknown.')
    expect(clientCreditException({ ...good(), currency: 'AUD' }, invoicesById([invoice({ currency: '' })])))
      .toBe('CI-0001 is denominated in an unknown currency, not AUD.')
  })

  it('there are no readable line items', () => {
    const message = 'The credit note carries no readable line items, so its stored totals cannot be verified.'
    expect(clientCreditException({ ...good(), lineItems: [] }, byId)).toBe(message)
    expect(clientCreditException({ ...good(), lineItems: undefined }, byId)).toBe(message)
    expect(clientCreditException({ ...good(), lineItems: 'nope' }, byId)).toBe(message)
  })

  it('a line names no line of the invoice', () => {
    for (const bad of [3, -1, 0.5, '0', null, undefined]) {
      expect(clientCreditException(withLine(1, { invoiceLineIndex: bad }), byId))
        .toBe('Line 2 does not name a line of CI-0001.')
    }
  })

  it('a line credits the same invoice line twice', () => {
    expect(clientCreditException(withLine(1, { invoiceLineIndex: 0 }), byId))
      .toBe('Line 2 credits an invoice line twice.')
  })

  it('a line carries no positive amount', () => {
    for (const bad of [0, -5, 'abc', undefined, 0.004]) {
      expect(clientCreditException(withLine(0, { amount: bad }), byId))
        .toBe('Line 1 does not carry a positive ex-GST amount.')
    }
  })

  it('a line credits more than its invoice line', () => {
    expect(clientCreditException(withLine(1, { amount: 40.16 }), byId))
      .toBe('Line 2 credits more than the invoice line it names.')
  })

  it('a line\'s tax code is unknown or differs from the invoice line', () => {
    expect(clientCreditException(withLine(0, { taxCode: 'gst_free' }), byId))
      .toBe('Line 1\'s tax code does not match the invoice line it credits.')
    expect(clientCreditException(withLine(0, { taxCode: 'vat' }), byId))
      .toBe('Line 1\'s tax code does not match the invoice line it credits.')
    expect(clientCreditException(withLine(0, { taxCode: undefined }), byId))
      .toBe('Line 1\'s tax code does not match the invoice line it credits.')
  })

  it('a line\'s GST is negative or above the invoice line\'s GST', () => {
    expect(clientCreditException(withLine(1, { gstAmount: 4.03 }), byId))
      .toBe('Line 2\'s GST is not within the GST of the invoice line it credits.')
    expect(clientCreditException(withLine(1, { gstAmount: -0.01 }), byId))
      .toBe('Line 2\'s GST is not within the GST of the invoice line it credits.')
  })

  it('a line names a different variation', () => {
    expect(clientCreditException(withLine(1, { variationId: 'v2' }), byId))
      .toBe('Line 2 names a different variation than the invoice line it credits.')
    expect(clientCreditException(withLine(1, { variationId: null }), byId))
      .toBe('Line 2 names a different variation than the invoice line it credits.')
    expect(clientCreditException(withLine(0, { variationId: 'v1' }), byId))
      .toBe('Line 1 names a different variation than the invoice line it credits.')
  })

  it('the stored totals do not reconcile to the lines', () => {
    const message = 'The stored totals do not reconcile to the credit note\'s own line items.'
    expect(clientCreditException({ ...good(), subtotal: 120.08 }, byId)).toBe(message)
    expect(clientCreditException({ ...good(), gstTotal: 12 }, byId)).toBe(message)
    expect(clientCreditException({ ...good(), grossTotal: 132.09 }, byId)).toBe(message)
    // A line GST that is in range but not what the header says.
    expect(clientCreditException(withLine(1, { gstAmount: 2 }), byId)).toBe(message)
  })

  it('the credit note exceeds the invoice headers', () => {
    // Reachable only when the invoice's headers are below its own lines.
    const shrunk = invoice({ subtotal: 100, gstTotal: 10, grossTotal: 110 })
    expect(clientCreditException(good(), invoicesById([shrunk]))).toBe('The credit note exceeds CI-0001.')
    const shrunkGst = invoice({ gstTotal: 12, grossTotal: 952.15 })
    expect(clientCreditException(good(), invoicesById([shrunkGst]))).toBe('The credit note exceeds CI-0001.')
  })

  it('the retention part is outside the credit or the retention withheld', () => {
    const message = 'The retention part of this credit note is not within the credit or the retention withheld.'
    // No retention was withheld on this invoice at all.
    expect(clientCreditException({ ...good(), retentionAmount: 0.01 }, byId)).toBe(message)
    expect(clientCreditException({ ...good(), retentionGst: 0.01 }, byId)).toBe(message)

    const retainedInv = invoice({}, 94.02)
    const retainedById = invoicesById([retainedInv])
    const ok = credit(retainedInv, ROWS)
    expect(clientCreditException(ok, retainedById)).toBeNull()
    expect(clientCreditException({ ...ok, retentionAmount: -0.01 }, retainedById)).toBe(message)
    expect(clientCreditException({ ...ok, retentionGst: -0.01 }, retainedById)).toBe(message)
    // More than the retention withheld (94.02), though within the credit (120.07).
    expect(clientCreditException({ ...ok, retentionAmount: 94.03 }, retainedById)).toBe(message)
    // More than the credit itself.
    const small = credit(retainedInv, [{ invoiceLineIndex: 0, amount: 10 }])
    expect(clientCreditException({ ...small, retentionAmount: 10.01 }, retainedById)).toBe(message)
    // The gate does NOT bound retention GST by the credit's own GST (1.00 here):
    // a credit takes whatever leaves the retained fraction of the GST still
    // billed held, which can be all of it. It is bounded by the retention GST
    // withheld (6.40).
    expect(clientCreditException({ ...small, retentionGst: 1.01 }, retainedById)).toBeNull()
    expect(clientCreditException({ ...small, retentionGst: 6.4 }, retainedById)).toBeNull()
    expect(clientCreditException({ ...small, retentionGst: 6.41 }, retainedById)).toBe(message)
    expect(clientCreditException({ ...ok, retentionGst: 6.41 }, retainedById)).toBe(message)
  })
})

describe('a failing POSTED credit counts ZERO and is listed', () => {
  const inv = invoice()
  const goodCn = credit(inv, [{ invoiceLineIndex: 0, amount: 100 }], { id: 'good', creditNumber: 'CCN-0001' })
  const badCn = credit(inv, [{ invoiceLineIndex: 1, amount: 20.07 }], { id: 'bad', creditNumber: 'CCN-0002', currency: 'NZD' })
  const draft = credit(inv, [{ invoiceLineIndex: 2, amount: 50 }], { id: 'draft', creditNumber: 'CCN-0003', status: 'draft' })
  const voided = credit(inv, [{ invoiceLineIndex: 2, amount: 60 }], { id: 'void', creditNumber: 'CCN-0004', status: 'void' })
  const all = [goodCn, badCn, draft, voided]

  it('countingClientCreditNotes keeps only posted credits that pass the gate', () => {
    expect(countingClientCreditNotes(all, [inv]).map(c => c.id)).toEqual(['good'])
    expect(countingClientCreditNotes(null, [inv])).toEqual([])
    expect(countingClientCreditNotes(all, [])).toEqual([])
  })

  it('receivablePositions counts the failing credit as zero', () => {
    const p = receivablePositions([inv], all)[inv.id]
    expect(p.creditedSubtotal).toBe(100)
    expect(p.creditedGst).toBe(10)
    expect(p.credited).toBe(110)
    expect(p.netIssuedSubtotal).toBe(840.15)
    expect(p.receivableBasis).toBe(894.17) // 1004.17 − 110.00

    // With ONLY the failing credit, every figure is exactly the invoice's own.
    expect(receivablePositions([inv], [badCn])).toEqual(receivablePositions([inv], []))
    expect(receivablePositions([inv], [badCn])[inv.id].credited).toBe(0)
    expect(receivablePositions([inv], [badCn])[inv.id].receivableBasis).toBe(1004.17)
  })

  it('clientCreditExceptions lists it with its reason, and nothing else', () => {
    expect(clientCreditExceptions(all, [inv])).toEqual([{
      creditNoteId: 'bad', creditNumber: 'CCN-0002', invoiceNumber: 'CI-0001',
      grossTotal: 22.08, reason: 'CI-0001 is denominated in AUD, not NZD.',
    }])
    expect(clientCreditExceptions([goodCn, draft, voided], [inv])).toEqual([])
    expect(clientCreditExceptions(null, null)).toEqual([])
  })

  it('an exception row survives a missing invoice number snapshot', () => {
    const orphan = { ...badCn, invoiceNumber: '', clientInvoiceId: 'gone' }
    expect(clientCreditExceptions([orphan], [inv])[0]).toMatchObject({
      invoiceNumber: '—', reason: 'The credited client invoice no longer exists or is not readable.',
    })
  })

  it('the variation credit of a failing note is not counted either', () => {
    expect(creditedByVariation([badCn], [inv])).toEqual({})
    expect(receivableContext([inv], all).creditedByVariation).toEqual({})
    expect(creditedByVariation([{ ...badCn, currency: 'AUD' }], [inv])).toEqual({ v1: 20.07 })
  })

  it('clientCreditSummary separates posted, exception and draft totals', () => {
    expect(clientCreditSummary(all, [inv])).toEqual({
      postedCount: 1, postedGross: 110,
      exceptionCount: 1, exceptionGross: 22.08,
      draftCount: 1, draftGross: 50,
    })
    expect(clientCreditSummary([], [])).toEqual({
      postedCount: 0, postedGross: 0, exceptionCount: 0, exceptionGross: 0, draftCount: 0, draftGross: 0,
    })
  })

  it('a credit on a voided invoice stops counting', () => {
    const voidedInvoice = invoice({ status: 'void' })
    expect(countingClientCreditNotes([goodCn], [voidedInvoice])).toEqual([])
    expect(clientCreditExceptions([goodCn], [voidedInvoice])[0].reason)
      .toBe('CI-0001 is void — a credit note only counts against an issued client invoice.')
    // A void invoice has no position at all.
    expect(receivablePositions([voidedInvoice], [goodCn])).toEqual({})
  })

  it('the remedy and notices say what the gate does', () => {
    expect(CLIENT_CREDIT_EXCEPTION_REMEDY).toMatch(/It reduces no figure/)
    expect(CLIENT_CREDIT_EXCEPTION_REMEDY).toMatch(/Nothing is clamped or reversed/)
    expect(CLIENT_CREDIT_READ_UNAVAILABLE_NOTICE).toMatch(/shown as Unavailable/)
    expect(CLIENT_CREDIT_NOTE_NOTICE).toMatch(/does not change the contract sum/)
    expect(CLIENT_CREDIT_NOTE_NOTICE).toMatch(/moves no cash/)
  })
})

describe('creditedByVariation / creditNotesForInvoice', () => {
  const inv = invoice()

  it('sums ex-GST credits per variation across counting credit notes only', () => {
    const a = credit(inv, [{ invoiceLineIndex: 1, amount: 20.07 }, { invoiceLineIndex: 0, amount: 50 }], { id: 'a' })
    const ledger = ledgerDocument(applyCredit(emptyLedger(), a))
    const b = credit(inv, [{ invoiceLineIndex: 1, amount: 0.1 }], { id: 'b', ledger })
    const draft = credit(inv, [{ invoiceLineIndex: 1, amount: 5 }], { id: 'c', status: 'draft' })
    // 20.07 + 0.10 summed in whole cents: 20.17, no float crumb.
    expect(creditedByVariation([a, b, draft], [inv])).toEqual({ v1: 20.17 })
    expect(creditedByVariation([], [inv])).toEqual({})
    expect(creditedByVariation(null, null)).toEqual({})
  })

  it('lists the credit notes of one invoice, newest number first', () => {
    const set = [
      { id: 'a', clientInvoiceId: 'inv1', creditNumber: 'CCN-0001' },
      { id: 'b', clientInvoiceId: 'inv2', creditNumber: 'CCN-0002' },
      { id: 'c', clientInvoiceId: 'inv1', creditNumber: 'CCN-0003' },
      { id: 'd', clientInvoiceId: 'inv1' },
    ]
    expect(creditNotesForInvoice(set, 'inv1').map(c => c.id)).toEqual(['c', 'a', 'd'])
    expect(creditNotesForInvoice(null, 'inv1')).toEqual([])
  })
})

// ── Draft validation ─────────────────────────────────────────────────────────

describe('validateClientCreditDraft', () => {
  const inv = invoice()
  const draft = (over = {}) => ({
    clientInvoiceId: 'inv1', creditDate: '2026-11-01', reason: 'Over-billed', rows: ROWS, ...over,
  })

  it('accepts a complete draft, with or without the invoice in hand', () => {
    expect(validateClientCreditDraft(draft())).toBeNull()
    expect(validateClientCreditDraft(draft(), { invoice: inv })).toBeNull()
    expect(validateClientCreditDraft(draft(), { invoice: inv, ledgerDoc: null })).toBeNull()
  })

  it('reports each missing field in order', () => {
    expect(validateClientCreditDraft(draft({ clientInvoiceId: '' })))
      .toBe('Select the issued client invoice this credit note adjusts.')
    expect(validateClientCreditDraft(draft(), { invoice: { ...inv, id: 'other' } }))
      .toBe('The supplied invoice does not match the selected target.')
    expect(validateClientCreditDraft(draft(), { invoice: invoice({ status: 'draft' }) }))
      .toBe('CI-0001 is draft — only an issued client invoice can be credited.')
    expect(validateClientCreditDraft(draft(), { invoice: invoice({ status: 'void' }) }))
      .toBe('CI-0001 is void — only an issued client invoice can be credited.')
    for (const bad of ['', null, '01/11/2026', '2026-11-1', 20261101]) {
      expect(validateClientCreditDraft(draft({ creditDate: bad }), { invoice: inv })).toBe('Enter the credit note date.')
    }
    for (const bad of ['', '   ', null, undefined]) {
      expect(validateClientCreditDraft(draft({ reason: bad }), { invoice: inv }))
        .toBe('Enter the reason this credit is being issued.')
    }
  })

  it('an ISSUED invoice that stores no currency is refused in its own words', () => {
    expect(validateClientCreditDraft(draft(), { invoice: invoice({ currency: '' }) }))
      .toBe('CI-0001 stores no currency, so it cannot be credited.')
    expect(validateClientCreditDraft(draft(), { invoice: invoice({ currency: undefined }) }))
      .toBe('CI-0001 stores no currency, so it cannot be credited.')
    // A non-issued invoice is still reported by its status, currency or not.
    expect(validateClientCreditDraft(draft(), { invoice: invoice({ currency: '', status: 'void' }) }))
      .toBe('CI-0001 is void — only an issued client invoice can be credited.')
  })

  it('refuses a row carrying a fraction of a cent', () => {
    expect(validateClientCreditDraft(draft({ rows: [{ invoiceLineIndex: 0, amount: 10.005 }] }), { invoice: inv }))
      .toBe('Line 1: the credit amount cannot carry a fraction of a cent.')
  })

  it('bounds the number of lines', () => {
    const rows = Array.from({ length: 101 }, () => ({ invoiceLineIndex: 0, amount: 1 }))
    expect(validateClientCreditDraft(draft({ rows }))).toBe('A credit note cannot carry more than 100 lines.')
    expect(validateClientCreditDraft(draft({ rows: rows.slice(0, 100) }))).toBeNull()
  })

  it('passes through the allocation error when the invoice is supplied', () => {
    expect(validateClientCreditDraft(draft({ rows: [] }), { invoice: inv })).toBe('Add at least one line with an amount.')
    expect(validateClientCreditDraft(draft({ rows: [{ invoiceLineIndex: 0, amount: 700 }] }), { invoice: inv }))
      .toBe('Line 1: only 600.00 of 600.00 remains to credit.')
    expect(validateClientCreditDraft(draft({ rows: [{ invoiceLineIndex: 0, amount: 1 }, { invoiceLineIndex: 0, amount: 2 }] }), { invoice: inv }))
      .toBe('Line 1 is credited twice — combine those rows.')
    // Without the invoice the rows cannot be checked.
    expect(validateClientCreditDraft(draft({ rows: [] }))).toBeNull()
  })

  it('checks the rows against the CURRENT ledger', () => {
    const first = credit(inv, [{ invoiceLineIndex: 0, amount: 550 }])
    const ledgerDoc = ledgerDocument(applyCredit(emptyLedger(), first))
    expect(validateClientCreditDraft(draft({ rows: [{ invoiceLineIndex: 0, amount: 100 }] }), { invoice: inv, ledgerDoc }))
      .toBe('Line 1: only 50.00 of 600.00 remains to credit.')
    expect(validateClientCreditDraft(draft({ rows: [{ invoiceLineIndex: 0, amount: 50 }] }), { invoice: inv, ledgerDoc }))
      .toBeNull()
  })
})

// ── Posting ──────────────────────────────────────────────────────────────────

describe('clientCreditPostBlockedReason', () => {
  const inv = invoice({}, 94.02)
  const draftOf = (rows, opts = {}) => credit(inv, rows, { status: 'draft', ...opts })

  it('a fresh draft against an untouched invoice can be posted', () => {
    expect(clientCreditPostBlockedReason(draftOf(ROWS), inv, null)).toBeNull()
  })

  it('refuses a missing or non-draft credit note and a missing or uncreditable invoice', () => {
    expect(clientCreditPostBlockedReason(null, inv, null)).toBe('Credit note not found.')
    expect(clientCreditPostBlockedReason(draftOf(ROWS, { status: 'posted' }), inv, null))
      .toBe('Only a draft credit note can be posted — this one is posted.')
    expect(clientCreditPostBlockedReason(draftOf(ROWS, { status: 'void' }), inv, null))
      .toBe('Only a draft credit note can be posted — this one is void.')
    expect(clientCreditPostBlockedReason(draftOf(ROWS), null, null))
      .toBe('The credited client invoice could not be found on this project.')
    expect(clientCreditPostBlockedReason(draftOf(ROWS), { ...inv, status: 'void' }, null))
      .toBe('CI-0001 is void — only an issued client invoice can be credited.')
  })

  it('an issued invoice with no currency is refused at post in the same words as at save', () => {
    expect(clientCreditPostBlockedReason(draftOf(ROWS), { ...inv, currency: '' }, null))
      .toBe('CI-0001 stores no currency, so it cannot be credited.')
    expect(clientCreditPostBlockedReason(draftOf(ROWS), { ...inv, currency: undefined }, null))
      .toBe('CI-0001 stores no currency, so it cannot be credited.')
  })

  it('the ledger SEQUENCE alone is not staleness: a receipt steps it and the draft still posts', () => {
    // Staleness means the figures would differ — exactly what the server checks.
    const draft = draftOf(ROWS)
    expect(draft.ledgerSeq).toBe(0)
    const afterReceipt = ledgerDocument(applyReceipt(emptyLedger(), 5000, 'cr1'))
    expect(readLedger(afterReceipt).seq).toBe(1)
    expect(clientCreditPostBlockedReason(draft, inv, afterReceipt)).toBeNull()
    // Whatever `ledgerSeq` a draft carries, matching figures post.
    expect(clientCreditPostBlockedReason(draftOf(ROWS, { ledgerSeq: 3 }), inv, null)).toBeNull()
    expect(clientCreditPostBlockedReason(draftOf(ROWS, { ledgerSeq: undefined }), inv, null)).toBeNull()
  })

  it('STALE: another entry posted first changes what this draft would be', () => {
    const draft = draftOf(ROWS)
    // A release posted first leaves less retention held: the stored split differs.
    const release = { id: 'rr1', ...buildClientRetentionRelease(inv, null, 10) }
    const afterRelease = ledgerDocument(applyRelease(emptyLedger(), release))
    const rebuilt = buildClientCreditNote(inv, afterRelease, draft.lineItems.map(li => ({ invoiceLineIndex: li.invoiceLineIndex, amount: li.amount })))
    const moved = rebuilt.error !== undefined
      || rebuilt.totals.retentionAmount !== draft.retentionAmount || rebuilt.totals.retentionGst !== draft.retentionGst
      || rebuilt.totals.gstTotal !== draft.gstTotal
    expect(clientCreditPostBlockedReason(draft, inv, afterRelease) === null).toBe(!moved)
    expect(moved).toBe(true)
  })

  it('STALE: the seq matches but the stored allocation is not what the ledger now gives', () => {
    const draft = draftOf(ROWS)
    for (const tampered of [
      { subtotal: draft.subtotal + 0.01 },
      { gstTotal: draft.gstTotal - 0.01 },
      { retentionAmount: draft.retentionAmount + 0.01 },
      { retentionGst: draft.retentionGst + 0.01 },
    ]) {
      expect(clientCreditPostBlockedReason({ ...draft, ...tampered }, inv, null)).toBe(CLIENT_ENTRY_STALE_TEXT)
    }
  })

  it('reports the allocation error when the stored lines no longer fit', () => {
    const tooMuch = draftOf(ROWS)
    tooMuch.lineItems = [{ ...tooMuch.lineItems[0], amount: 600.01 }]
    expect(clientCreditPostBlockedReason(tooMuch, inv, null)).toBe('Line 1: only 600.00 of 600.00 remains to credit.')
    expect(clientCreditPostBlockedReason({ ...draftOf(ROWS), lineItems: [] }, inv, null))
      .toBe('Add at least one line with an amount.')
  })

  it('the stale text tells the user what to do', () => {
    expect(CLIENT_ENTRY_STALE_TEXT).toMatch(/since this draft was\s+prepared/)
    expect(CLIENT_ENTRY_STALE_TEXT).toMatch(/Re-open and save the draft/)
  })
})
