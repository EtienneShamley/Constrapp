import { describe, it, expect } from 'vitest'
import {
  CRR_STATUS, CRR_STATUS_LABELS, CRR_BADGE_VARIANTS, CRR_TRANSITIONS, canTransition,
  CRR_DOC_TYPE, CLIENT_RETENTION_RELEASE_COUNTER_ID, formatClientRetentionReleaseNumber,
  postedClientRetentionReleases, draftClientRetentionReleases, isReleasableClientInvoice,
  buildClientRetentionRelease, validateClientReleaseDraft, clientReleasePostBlockedReason,
  clientReleaseExceptions, countingClientRetentionReleases,
  CLIENT_RETENTION_HELD_NOTICE, CLIENT_RETENTION_RELEASED_NOTICE, CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE,
} from '../../src/lib/clientRetention'
import { gstForLine, invoiceTotals } from '../../src/lib/clientInvoices'
import { emptyLedger, readLedger, applyCredit, applyRelease, ledgerDocument, applyReceipt } from '../../src/lib/clientLedger'
import { buildClientCreditNote, CLIENT_ENTRY_STALE_TEXT } from '../../src/lib/clientCreditNotes'
import { receivablePositions, clientRetentionRows } from '../../src/lib/clientReceivables'

// ── Client Retention Release (ADR-88) — pure domain tests ────────────────────
//
// The load-bearing properties:
//   1. A RELEASE CARRIES THE INVOICE'S OWN RETENTION GST: what stays held is
//      the retained share of the GST still billed and the release takes the
//      rest, so any split of releases sums exactly to what the invoice withheld.
//   2. A RELEASE MOVES RETENTION FROM HELD TO RECEIVABLE and nothing else:
//      nothing billed changes, and retentionHeld + released + credited-retention
//      always equals the retention withheld.
//   3. A STALE DRAFT IS REFUSED, NOT RECALCULATED.
//   4. A POSTED RELEASE WHOSE INVOICE CANNOT CARRY IT counts zero and is listed.

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// An issued invoice that withheld retention:
//   line 333.33 gst (GST 33.33) · subtotal 333.33 · gross 366.66
//   retention 33.33 · retention GST 3.33 (33.33 × 33.33 ÷ 333.33 = 3.3327)
//   withheld 36.66 · receivable 330.00

const lines = () => [{
  description: 'Works', amount: 333.33, taxCode: 'gst', gstAmount: gstForLine(333.33, 'gst'),
  variationId: null, variationNumber: '', costCodeId: null, costCodeName: null,
}]

const invoice = (over = {}, retention = 33.33) => ({
  id: 'inv1', invoiceNumber: 'CI-0001', status: 'issued',
  clientId: 'client1', clientName: 'Acme Developments', currency: 'AUD',
  invoiceDate: '2026-10-01', dueDate: '2026-10-31',
  lineItems: lines(),
  ...invoiceTotals(lines(), retention),
  ...over,
})

// A release document as runClientReleaseCreate stores it.
function release(inv, amount, { ledger = null, ...over } = {}) {
  const built = buildClientRetentionRelease(inv, ledger, amount)
  if (built.error) throw new Error(built.error)
  return {
    id: 'rr1', releaseNumber: 'CRR-0001', status: 'posted', docType: 'client_retention_release',
    clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber,
    clientId: inv.clientId, clientName: inv.clientName, currency: inv.currency,
    releaseDate: '2026-11-15', reason: 'Practical completion',
    ...built,
    ...over,
  }
}

describe('the fixture', () => {
  it('withholds 33.33 + 3.33', () => {
    expect(invoice()).toMatchObject({
      subtotal: 333.33, gstTotal: 33.33, grossTotal: 366.66,
      retention: 33.33, retentionGst: 3.33, retentionTotal: 36.66, receivableTotal: 330,
    })
  })
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('has three statuses with labels and existing badge variants', () => {
    expect(CRR_STATUS).toEqual({ DRAFT: 'draft', POSTED: 'posted', VOID: 'void' })
    expect(CRR_STATUS_LABELS).toEqual({ draft: 'Draft', posted: 'Posted', void: 'Void' })
    expect(CRR_BADGE_VARIANTS).toEqual({ draft: 'soon', posted: 'active', void: 'danger' })
  })

  it('is forward-only and void is terminal', () => {
    expect(CRR_TRANSITIONS).toEqual({ draft: ['posted', 'void'], posted: ['void'], void: [] })
    expect(canTransition('draft', 'posted')).toBe(true)
    expect(canTransition('draft', 'void')).toBe(true)
    expect(canTransition('posted', 'void')).toBe(true)
    expect(canTransition('posted', 'draft')).toBe(false)
    expect(canTransition('void', 'posted')).toBe(false)
    expect(canTransition('void', 'draft')).toBe(false)
    expect(canTransition('nonsense', 'posted')).toBe(false)
  })

  it('numbers and counter id', () => {
    expect(CRR_DOC_TYPE).toBe('client_retention_release')
    expect(CLIENT_RETENTION_RELEASE_COUNTER_ID).toBe('clientRetentionReleases')
    expect(formatClientRetentionReleaseNumber(1)).toBe('CRR-0001')
    expect(formatClientRetentionReleaseNumber(987)).toBe('CRR-0987')
    expect(formatClientRetentionReleaseNumber(12345)).toBe('CRR-12345')
  })

  it('filters posted and draft sets', () => {
    const set = [{ id: 'a', status: 'draft' }, { id: 'b', status: 'posted' }, { id: 'c', status: 'void' }, null]
    expect(postedClientRetentionReleases(set).map(r => r.id)).toEqual(['b'])
    expect(draftClientRetentionReleases(set).map(r => r.id)).toEqual(['a'])
    expect(postedClientRetentionReleases(null)).toEqual([])
    expect(draftClientRetentionReleases(undefined)).toEqual([])
  })

  it('only an issued invoice that withheld retention is releasable', () => {
    expect(isReleasableClientInvoice(invoice())).toBe(true)
    expect(isReleasableClientInvoice(invoice({ status: 'draft' }))).toBe(false)
    expect(isReleasableClientInvoice(invoice({ status: 'void' }))).toBe(false)
    expect(isReleasableClientInvoice(invoice({}, 0))).toBe(false)
    // A pre-ADR-88 invoice has no retention fields at all.
    expect(isReleasableClientInvoice({ id: 'old', status: 'issued', subtotal: 100, gstTotal: 10, grossTotal: 110 })).toBe(false)
    expect(isReleasableClientInvoice(null)).toBe(false)
  })
})

// ── Builder ──────────────────────────────────────────────────────────────────

describe('buildClientRetentionRelease', () => {
  it('a full release carries the whole stored retention GST', () => {
    expect(buildClientRetentionRelease(invoice(), null, 33.33)).toEqual({
      amount: 33.33, gstAmount: 3.33, releaseTotal: 36.66, ledgerSeq: 0,
    })
  })

  it('a partial release leaves the retained share of the GST held and takes the rest', () => {
    // 23.33 stays held: 33.33 × 23.33 ÷ 333.33 = 2.3328 → 2.33, so the release takes 3.33 − 2.33 = 1.00
    expect(buildClientRetentionRelease(invoice(), null, 10)).toEqual({
      amount: 10, gstAmount: 1, releaseTotal: 11, ledgerSeq: 0,
    })
    expect(buildClientRetentionRelease(invoice(), undefined, '10')).toEqual({
      amount: 10, gstAmount: 1, releaseTotal: 11, ledgerSeq: 0,
    })
  })

  it('three releases built one after another sum exactly to what was withheld', () => {
    const inv = invoice()
    let ledger = emptyLedger()
    const built = []
    for (const amount of [11.11, 11.11, 11.11]) {
      const r = release(inv, amount, { ledger, id: `rr${built.length + 1}` })
      built.push(r)
      ledger = applyRelease(ledger, r)
    }
    expect(built.map(r => r.ledgerSeq)).toEqual([0, 1, 2])
    // Left held 2.22 (33.33 × 22.22 ÷ 333.33 = 2.2218), then 1.11, then nothing.
    expect(built.map(r => r.gstAmount)).toEqual([1.11, 1.11, 1.11])
    expect(built.map(r => r.releaseTotal)).toEqual([12.22, 12.22, 12.22])
    expect(ledger.releasedRetentionCents).toBe(3333)
    expect(ledger.releasedRetentionGstCents).toBe(333)
  })

  it('the last release takes the remainder whatever rounding came before', () => {
    const inv = invoice()
    let ledger = emptyLedger()
    const amounts = [0.01, 0.01, 16.65, 16.66]
    const built = amounts.map((amount, i) => {
      const r = release(inv, amount, { ledger, id: `rr${i}` })
      ledger = applyRelease(ledger, r)
      return r
    })
    // 33.33 × 33.32 ÷ 333.33 = 3.3317 → 3.33 stays held: the cent carries 0.00; twice.
    expect(built[0].gstAmount).toBe(0)
    expect(built[1].gstAmount).toBe(0)
    expect(ledger.releasedRetentionGstCents).toBe(333)
    expect(built[2].gstAmount + built[3].gstAmount).toBe(3.33)
  })

  it('GST-free retention releases no GST', () => {
    const free = [{ description: 'Free', amount: 1000, taxCode: 'gst_free', gstAmount: 0 }]
    const inv = { ...invoice(), lineItems: free, ...invoiceTotals(free, 50) }
    expect(buildClientRetentionRelease(inv, null, 50)).toEqual({ amount: 50, gstAmount: 0, releaseTotal: 50, ledgerSeq: 0 })
    expect(buildClientRetentionRelease(inv, null, 20)).toEqual({ amount: 20, gstAmount: 0, releaseTotal: 20, ledgerSeq: 0 })
  })

  it('returns only an error when the release is refused', () => {
    expect(buildClientRetentionRelease(invoice(), null, 33.34))
      .toEqual({ error: 'Only 33.33 of retention (ex-GST) is still held on CI-0001.' })
    expect(buildClientRetentionRelease(invoice(), null, 0)).toEqual({ error: 'The release amount must be greater than zero.' })
    expect(buildClientRetentionRelease(invoice({}, 0), null, 1))
      .toEqual({ error: 'Only 0.00 of retention (ex-GST) is still held on CI-0001.' })
  })

  it('refuses an amount carrying a fraction of a cent', () => {
    expect(buildClientRetentionRelease(invoice(), null, 10.005))
      .toEqual({ error: 'The release amount cannot carry a fraction of a cent.' })
    expect(validateClientReleaseDraft(
      { clientInvoiceId: 'inv1', amount: 10.005, releaseDate: '2026-11-15', reason: 'PC' }, { invoice: invoice() },
    )).toBe('The release amount cannot carry a fraction of a cent.')
  })

  it('retention a credit note has taken is no longer releasable', () => {
    const inv = invoice()
    const built = buildClientCreditNote(inv, null, [{ invoiceLineIndex: 0, amount: 100 }])
    // 33.33 × 100 ÷ 333.33 = 9.999 → 10.00 of the retention goes with the credit.
    expect(built.totals.retentionAmount).toBe(10)
    const ledger = applyCredit(emptyLedger(), { id: 'cn1', lineItems: built.lineItems, ...built.totals })
    expect(buildClientRetentionRelease(inv, ledger, 23.34))
      .toEqual({ error: 'Only 23.33 of retention (ex-GST) is still held on CI-0001.' })
    const rest = buildClientRetentionRelease(inv, ledger, 23.33)
    // The emptying release takes all the GST still held: 3.33 − 1.00 credited.
    expect(rest).toEqual({ amount: 23.33, gstAmount: 2.33, releaseTotal: 25.66, ledgerSeq: 1 })
  })

  describe('after a credit on a mixed-tax invoice, a release carries the retention GST the credit left held', () => {
    // 0: 1000.00 gst_free · 1: 1000.00 gst (GST 100.00) · retention 200.00 + 10.00.
    const mixedLines = () => [
      { description: 'Free', amount: 1000, taxCode: 'gst_free', gstAmount: 0,
        variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
      { description: 'Taxable', amount: 1000, taxCode: 'gst', gstAmount: gstForLine(1000, 'gst'),
        variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
    ]
    const mixed = () => ({ ...invoice(), lineItems: mixedLines(), ...invoiceTotals(mixedLines(), 200) })
    const afterCreditOf = (inv, lineIndex) => {
      const built = buildClientCreditNote(inv, null, [{ invoiceLineIndex: lineIndex, amount: 1000 }])
      return { built, ledger: applyCredit(emptyLedger(), { id: 'cn1', lineItems: built.lineItems, ...built.totals }) }
    }

    it('the GST-free line credited: 100.00 + ALL 10.00 of retention GST stays held and is released pro rata', () => {
      const inv = mixed()
      expect(inv).toMatchObject({ retention: 200, retentionGst: 10 })
      const { built, ledger } = afterCreditOf(inv, 0)
      // The credit takes half the retention and none of its GST.
      expect(built.totals).toMatchObject({ retentionAmount: 100, retentionGst: 0 })
      // 60.00 stays held: 100.00 × 60 ÷ 1000 = 6.00, so the release takes 4.00
      // (an earlier credit rule left only 5.00 held: 2.00 here).
      const first = buildClientRetentionRelease(inv, ledger, 40)
      expect(first).toEqual({ amount: 40, gstAmount: 4, releaseTotal: 44, ledgerSeq: 1 })
      const next = applyRelease(ledger, { id: 'rr1', ...first })
      expect(buildClientRetentionRelease(inv, next, 60)).toEqual({ amount: 60, gstAmount: 6, releaseTotal: 66, ledgerSeq: 2 })
      expect(buildClientRetentionRelease(inv, next, 60.01).error).toBe('Only 60.00 of retention (ex-GST) is still held on CI-0001.')
    })

    it('the taxable line credited: 100.00 stays held with NO retention GST, so the release carries none', () => {
      const inv = mixed()
      const { built, ledger } = afterCreditOf(inv, 1)
      // No GST is still billed, so the credit takes all 10.00 of retention GST.
      expect(built.totals).toMatchObject({ retentionAmount: 100, retentionGst: 10 })
      expect(buildClientRetentionRelease(inv, ledger, 40)).toEqual({ amount: 40, gstAmount: 0, releaseTotal: 40, ledgerSeq: 1 })
      expect(buildClientRetentionRelease(inv, ledger, 100)).toEqual({ amount: 100, gstAmount: 0, releaseTotal: 100, ledgerSeq: 1 })
    })
  })

  describe('very large invoices — there is no 20,000,000.00 limit', () => {
    const bigInvoice = (amount, retention) => {
      const big = [{ description: 'Stage', amount, taxCode: 'gst', gstAmount: gstForLine(amount, 'gst'),
        variationId: null, variationNumber: '', costCodeId: null, costCodeName: null }]
      return { ...invoice(), lineItems: big, ...invoiceTotals(big, retention) }
    }
    const releaseAll = (inv, amounts) => {
      let ledger = emptyLedger()
      const built = amounts.map((amount, i) => {
        const r = release(inv, amount, { ledger, id: `rr${i}` })
        ledger = applyRelease(ledger, r)
        return [r.amount, r.gstAmount, r.releaseTotal]
      })
      return { built, ledger }
    }

    it('250,000,000.00 with 12,500,000.00 retained: three releases sum exactly to 1,250,000.00 of GST', () => {
      const inv = bigInvoice(250000000, 12500000)
      expect(inv).toMatchObject({ gstTotal: 25000000, retention: 12500000, retentionGst: 1250000, receivableTotal: 261250000 })
      expect(validateClientReleaseDraft(
        { clientInvoiceId: 'inv1', amount: 12500000, releaseDate: '2026-11-15', reason: 'PC' }, { invoice: inv },
      )).toBeNull()
      // Left held after each release — the retained share of the 25,000,000.00 of GST billed:
      //   8,333,333.33 → 833,333.333 → 833,333.33, so the first takes 416,666.67
      //   4,166,666.66 → 416,666.666 → 416,666.67, so the second takes 416,666.66
      //   nothing                                 , so the third takes 416,666.67
      const { built, ledger } = releaseAll(inv, [4166666.67, 4166666.67, 4166666.66])
      expect(built).toEqual([
        [4166666.67, 416666.67, 4583333.34],
        [4166666.67, 416666.66, 4583333.33],
        [4166666.66, 416666.67, 4583333.33],
      ])
      expect([ledger.releasedRetentionCents, ledger.releasedRetentionGstCents]).toEqual([1250000000, 125000000])
      expect(receivablePositions([inv], [], [{ ...release(inv, 12500000) }]).inv1)
        .toMatchObject({ releasedTotal: 13750000, retentionHeld: 0, receivableBasis: 275000000 })
    })

    it('9,999,999,999.99 with 1,000,000,000.00 retained: a third, one cent, and the rest', () => {
      const inv = bigInvoice(9999999999.99, 1000000000)
      expect(inv).toMatchObject({ gstTotal: 1000000000, retentionGst: 100000000, retentionTotal: 1100000000, receivableTotal: 9899999999.99 })
      // 666,666,666.67 stays held: 10^9 × 666,666,666.67 ÷ 9,999,999,999.99 = 66,666,666.667
      // → …666.67, so the first takes 33,333,333.33; one cent carries 0.00; the
      // last release takes the 66,666,666.67 still held.
      const { built, ledger } = releaseAll(inv, [333333333.33, 0.01, 666666666.66])
      expect(built).toEqual([
        [333333333.33, 33333333.33, 366666666.66],
        [0.01, 0, 0.01],
        [666666666.66, 66666666.67, 733333333.33],
      ])
      expect([ledger.releasedRetentionCents, ledger.releasedRetentionGstCents]).toEqual([100000000000, 10000000000])
      expect(buildClientRetentionRelease(inv, null, 1000000000.01).error)
        .toBe('Only 1000000000.00 of retention (ex-GST) is still held on CI-0001.')
    })
  })
})

// ── Draft validation ─────────────────────────────────────────────────────────

describe('validateClientReleaseDraft', () => {
  const inv = invoice()
  const draft = (over = {}) => ({
    clientInvoiceId: 'inv1', amount: 10, releaseDate: '2026-11-15', reason: 'Practical completion', ...over,
  })

  it('accepts a complete draft, with or without the invoice in hand', () => {
    expect(validateClientReleaseDraft(draft())).toBeNull()
    expect(validateClientReleaseDraft(draft(), { invoice: inv })).toBeNull()
    expect(validateClientReleaseDraft(draft({ amount: '33.33' }), { invoice: inv, ledgerDoc: null })).toBeNull()
  })

  it('reports each missing field in order', () => {
    expect(validateClientReleaseDraft(draft({ clientInvoiceId: '' })))
      .toBe('Choose the client invoice whose retention is being released.')
    for (const bad of ['abc', NaN, undefined, Infinity]) {
      expect(validateClientReleaseDraft(draft({ amount: bad }))).toBe('Enter the release amount (ex-GST) as a number.')
    }
    for (const bad of [0, -1, 0.004, '', null]) {
      expect(validateClientReleaseDraft(draft({ amount: bad }))).toBe('The release amount must be greater than zero.')
    }
    for (const bad of ['', null, '15/11/2026', '2026-11-5']) {
      expect(validateClientReleaseDraft(draft({ releaseDate: bad }))).toBe('Enter the date this release was agreed.')
    }
    for (const bad of ['', '   ', null, undefined]) {
      expect(validateClientReleaseDraft(draft({ reason: bad }))).toBe('Enter a reason for releasing this retention.')
    }
  })

  it('checks the target invoice when it is supplied', () => {
    expect(validateClientReleaseDraft(draft(), { invoice: { ...inv, id: 'other' } }))
      .toBe('The supplied invoice does not match the selected target.')
    expect(validateClientReleaseDraft(draft(), { invoice: invoice({ status: 'void' }) }))
      .toBe('CI-0001 is void — retention can only be released on an issued client invoice.')
    expect(validateClientReleaseDraft(draft(), { invoice: invoice({ status: 'draft' }) }))
      .toBe('CI-0001 is draft — retention can only be released on an issued client invoice.')
    expect(validateClientReleaseDraft(draft(), { invoice: invoice({}, 0) })).toBe('CI-0001 withheld no retention.')
  })

  it('refuses more than is still held, against the CURRENT ledger', () => {
    expect(validateClientReleaseDraft(draft({ amount: 33.34 }), { invoice: inv }))
      .toBe('Only 33.33 of retention (ex-GST) is still held on CI-0001.')
    const ledgerDoc = ledgerDocument(applyRelease(emptyLedger(), release(inv, 30)))
    expect(validateClientReleaseDraft(draft({ amount: 10 }), { invoice: inv, ledgerDoc }))
      .toBe('Only 3.33 of retention (ex-GST) is still held on CI-0001.')
    expect(validateClientReleaseDraft(draft({ amount: 3.33 }), { invoice: inv, ledgerDoc })).toBeNull()
    // Without the invoice the cap cannot be checked.
    expect(validateClientReleaseDraft(draft({ amount: 999 }))).toBeNull()
  })
})

// ── Posting ──────────────────────────────────────────────────────────────────

describe('clientReleasePostBlockedReason', () => {
  const inv = invoice()
  const draftOf = (amount, opts = {}) => release(inv, amount, { status: 'draft', ...opts })

  it('a fresh draft against an untouched invoice can be posted', () => {
    expect(clientReleasePostBlockedReason(draftOf(10), inv, null)).toBeNull()
    expect(clientReleasePostBlockedReason(draftOf(33.33), inv, null)).toBeNull()
  })

  it('refuses a missing or non-draft release and a missing or unreleasable invoice', () => {
    expect(clientReleasePostBlockedReason(null, inv, null)).toBe('Retention release not found.')
    expect(clientReleasePostBlockedReason(draftOf(10, { status: 'posted' }), inv, null))
      .toBe('Only a draft retention release can be posted — this one is posted.')
    expect(clientReleasePostBlockedReason(draftOf(10, { status: 'void' }), inv, null))
      .toBe('Only a draft retention release can be posted — this one is void.')
    expect(clientReleasePostBlockedReason(draftOf(10), null, null))
      .toBe('The client invoice could not be found on this project.')
    expect(clientReleasePostBlockedReason(draftOf(10), invoice({ status: 'void' }), null))
      .toBe('CI-0001 is void — retention can only be released on an issued client invoice that withheld some.')
    expect(clientReleasePostBlockedReason(draftOf(10), invoice({}, 0), null))
      .toBe('CI-0001 is issued — retention can only be released on an issued client invoice that withheld some.')
  })

  it('the ledger SEQUENCE alone is not staleness: a receipt steps it and the draft still posts', () => {
    const draft = draftOf(10)
    expect(draft.ledgerSeq).toBe(0)
    const afterReceipt = ledgerDocument(applyReceipt(emptyLedger(), 5000, 'cr1'))
    expect(readLedger(afterReceipt).seq).toBe(1)
    expect(clientReleasePostBlockedReason(draft, inv, afterReceipt)).toBeNull()
    expect(clientReleasePostBlockedReason(draftOf(10, { ledgerSeq: 2 }), inv, null)).toBeNull()
    expect(clientReleasePostBlockedReason(draftOf(10, { ledgerSeq: undefined }), inv, null)).toBeNull()
  })

  it('STALE: the seq matches but the stored GST is not what the ledger now gives', () => {
    expect(clientReleasePostBlockedReason(draftOf(10, { gstAmount: 0.99 }), inv, null)).toBe(CLIENT_ENTRY_STALE_TEXT)
    expect(clientReleasePostBlockedReason(draftOf(10, { gstAmount: 1.01 }), inv, null)).toBe(CLIENT_ENTRY_STALE_TEXT)
  })

  it('reports the allocation error when the amount no longer fits', () => {
    expect(clientReleasePostBlockedReason(draftOf(10, { amount: 40 }), inv, null))
      .toBe('Only 33.33 of retention (ex-GST) is still held on CI-0001.')
    expect(clientReleasePostBlockedReason(draftOf(10, { amount: 0 }), inv, null))
      .toBe('The release amount must be greater than zero.')
  })
})

// ── Read-time exceptions ─────────────────────────────────────────────────────

describe('clientReleaseExceptions / countingClientRetentionReleases', () => {
  const inv = invoice()
  const good = release(inv, 10, { id: 'good', releaseNumber: 'CRR-0001' })
  const orphan = release(inv, 5, { id: 'orphan', releaseNumber: 'CRR-0002', clientInvoiceId: 'gone', invoiceNumber: '' })
  const draft = release(inv, 5, { id: 'draft', status: 'draft' })
  const voided = release(inv, 5, { id: 'void', status: 'void' })

  it('a posted release on an issued, retained invoice counts and is not listed', () => {
    expect(clientReleaseExceptions([good, draft, voided], [inv])).toEqual([])
    expect(countingClientRetentionReleases([good, draft, voided], [inv]).map(r => r.id)).toEqual(['good'])
  })

  it('lists a release whose invoice is missing', () => {
    expect(clientReleaseExceptions([good, orphan], [inv])).toEqual([{
      releaseId: 'orphan', releaseNumber: 'CRR-0002', invoiceNumber: '—', releaseTotal: 5.5,
      reason: 'The client invoice this release belongs to no longer exists or is not readable.',
    }])
    expect(countingClientRetentionReleases([good, orphan], [inv]).map(r => r.id)).toEqual(['good'])
  })

  it('lists a release whose invoice is no longer issued', () => {
    const voidedInvoice = invoice({ status: 'void' })
    expect(clientReleaseExceptions([good], [voidedInvoice])).toEqual([{
      releaseId: 'good', releaseNumber: 'CRR-0001', invoiceNumber: 'CI-0001', releaseTotal: 11,
      reason: 'CI-0001 is void — retention can only be released on an issued client invoice.',
    }])
    expect(countingClientRetentionReleases([good], [voidedInvoice])).toEqual([])
  })

  it('lists a release against an invoice that withheld nothing', () => {
    const none = invoice({}, 0)
    expect(clientReleaseExceptions([good], [none])[0].reason)
      .toBe('CI-0001 withheld no retention, so this release has nothing to release.')
    expect(countingClientRetentionReleases([good], [none])).toEqual([])
  })

  it('falls back to the invoice\'s own number when the release carries no snapshot', () => {
    const noSnapshot = { ...good, invoiceNumber: '' }
    expect(clientReleaseExceptions([noSnapshot], [invoice({ status: 'void' })])[0].invoiceNumber).toBe('CI-0001')
  })

  it('tolerates empty inputs', () => {
    expect(clientReleaseExceptions(null, null)).toEqual([])
    expect(countingClientRetentionReleases(undefined, undefined)).toEqual([])
  })

  it('a failing posted release counts ZERO in receivablePositions', () => {
    // Against an invoice that withheld nothing, the release moves nothing.
    const none = invoice({}, 0)
    expect(receivablePositions([none], [], [good])).toEqual(receivablePositions([none], [], []))
    expect(receivablePositions([none], [], [good])[none.id].releasedTotal).toBe(0)
    // An orphan release touches no other invoice.
    expect(receivablePositions([inv], [], [orphan])).toEqual(receivablePositions([inv], [], []))
  })
})

// ── What a release does to the receivable ────────────────────────────────────

describe('a posted release moves retention from held to receivable, and nothing else', () => {
  const inv = invoice()

  it('before any release the retention is held and not receivable', () => {
    expect(receivablePositions([inv])[inv.id]).toMatchObject({
      grossTotal: 366.66, credited: 0, netIssuedSubtotal: 333.33,
      retentionTotal: 36.66, releasedTotal: 0, retentionHeld: 36.66, receivableBasis: 330,
    })
  })

  it('a partial release', () => {
    const p = receivablePositions([inv], [], [release(inv, 10)])[inv.id]
    expect(p).toMatchObject({
      grossTotal: 366.66, credited: 0, netIssuedSubtotal: 333.33, netIssuedGross: 366.66,
      retentionTotal: 36.66, releasedTotal: 11, retentionHeld: 25.66, retentionHeldExGst: 23.33,
      receivableBasis: 341,
    })
  })

  it('a full release makes the whole gross receivable', () => {
    const p = receivablePositions([inv], [], [release(inv, 33.33)])[inv.id]
    expect(p).toMatchObject({
      retentionTotal: 36.66, releasedTotal: 36.66, retentionHeld: 0, retentionHeldExGst: 0, receivableBasis: 366.66,
    })
  })

  it('draft and void releases move nothing', () => {
    const none = receivablePositions([inv], [], [])
    expect(receivablePositions([inv], [], [release(inv, 10, { status: 'draft' })])).toEqual(none)
    expect(receivablePositions([inv], [], [release(inv, 10, { status: 'void' })])).toEqual(none)
  })

  it('the retention register row follows the position', () => {
    const positions = receivablePositions([inv], [], [release(inv, 10)])
    expect(clientRetentionRows([inv], positions)).toEqual([{
      id: 'inv1', invoiceNumber: 'CI-0001', clientId: 'client1', clientName: 'Acme Developments',
      invoiceDate: '2026-10-01',
      retentionTotal: 36.66, releasedTotal: 11, creditedRetention: 0,
      retentionHeld: 25.66, retentionHeldExGst: 23.33, fullyResolved: false,
    }])
    const full = receivablePositions([inv], [], [release(inv, 33.33)])
    expect(clientRetentionRows([inv], full)[0].fullyResolved).toBe(true)
  })

  it('the notices say what held and released mean', () => {
    expect(CLIENT_RETENTION_HELD_NOTICE).toMatch(/not receivable yet/)
    expect(CLIENT_RETENTION_RELEASED_NOTICE).toMatch(/moves\s+no cash by itself/)
    expect(CLIENT_RETENTION_READ_UNAVAILABLE_NOTICE).toMatch(/shown as Unavailable/)
  })
})
