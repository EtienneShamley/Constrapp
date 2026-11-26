import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as client from '../../src/lib/clientFinanceCalc'
import * as server from '../../functions/src/generated/clientFinanceCalc.js'
import { buildFinanceBundle, FINANCE_BUNDLE_PATH, FINANCE_BUNDLE_HEADER } from '../../scripts/build-client-finance-bundle.mjs'
import { issuedInvoice } from '../fixtures/clientReceivableDocs'

// ── The server's copy of the client-finance domain (ADR-89) ──────────────────
//
// `functions/src/generated/clientFinanceCalc.js` is what the six trusted
// callables (postClientCreditNote, voidClientCreditNote,
// postClientRetentionRelease, voidClientRetentionRelease, postClientReceipt,
// voidClientReceipt) run. These tests are
// the guarantee that it is the SAME domain logic the browser previews with:
//   1. FRESH — regenerating it from src/lib/clientFinanceCalc.js yields the
//      committed bytes (a source change without `npm run functions:finance-calc`
//      fails);
//   2. SELF-CONTAINED — no import of any kind, no browser or Firebase reference;
//   3. EQUAL — the same derivations, ledger movements and invariant verdicts
//      from both modules;
//   4. THE ONLY SOURCE OF FIGURES — functions/src/clientFinance/ contains no
//      arithmetic of its own.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const BUNDLE = readFileSync(FINANCE_BUNDLE_PATH, 'utf8')
const stripComments = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('the generated bundle is fresh', () => {
  it('regenerating from src/lib/clientFinanceCalc.js yields the committed file, byte for byte', async () => {
    expect(await buildFinanceBundle()).toBe(BUNDLE)
  })
  it('the build is deterministic, carries the generated-file header, and has a build + check script', async () => {
    expect(await buildFinanceBundle()).toBe(await buildFinanceBundle())
    expect(BUNDLE.startsWith(FINANCE_BUNDLE_HEADER)).toBe(true)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['functions:finance-calc']).toBe('node scripts/build-client-finance-bundle.mjs')
    expect(pkg.scripts['functions:finance-calc:check']).toBe('node scripts/build-client-finance-bundle.mjs --check')
    expect(read('../azure-pipelines.yml')).toContain('- script: npm run functions:finance-calc:check')
  })
})

describe('the generated bundle is self-contained', () => {
  const code = stripComments(BUNDLE)

  it('has no import, require or dynamic import', () => {
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    expect((code.match(/^export \{/gm) || []).length).toBe(1)
  })
  it('references no browser, React, Firebase or build-time global', () => {
    expect(code).not.toMatch(/import\.meta|\bwindow\.|\bdocument\.|localStorage|sessionStorage|navigator\./)
    expect(code).not.toMatch(/from ['"]firebase|firebase\/(app|firestore|auth|functions|storage)|from ['"]react/)
    expect(BUNDLE).not.toMatch(/\/Users\/|[A-Z]:\\\\/)   // no absolute path of the build machine
  })
  it('the entry module defines nothing: it only re-exports sibling lib modules', () => {
    const entry = stripComments(read('src/lib/clientFinanceCalc.js')).trim()
    const statements = entry.split(/\n(?=export )/)
    expect(statements.length).toBeGreaterThanOrEqual(6)
    for (const s of statements) expect(s).toMatch(/^export \{[^}]+\} from '\.\/[A-Za-z]+'$/)
  })
  it('exports the same names as the entry module', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort())
  })
})

// A mixed-tax invoice with retention; a legacy one whose line GST is a cent low.
const mixed = () => {
  const lineItems = [
    { description: 'Works', amount: 1000, taxCode: 'gst', gstAmount: 100, variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
    { description: 'Variation', amount: 40.15, taxCode: 'gst', gstAmount: 4.02, variationId: 'v1', variationNumber: 'CV-0001', costCodeId: 'cc1', costCodeName: 'Concrete' },
    { description: 'GST-free', amount: 300, taxCode: 'gst_free', gstAmount: 0, variationId: null, variationNumber: '', costCodeId: null, costCodeName: null },
  ]
  return { id: 'ci1', invoiceNumber: 'CI-0001', status: 'issued', clientId: 'c1', clientName: 'Owner', currency: 'AUD', lineItems, ...client.invoiceTotals(lineItems, 134.02) }
}
const legacy = () => ({
  id: 'ci2', invoiceNumber: 'CI-0002', status: 'issued', clientId: 'c1', currency: 'AUD',
  lineItems: [{ description: 'Old', amount: 40.15, taxCode: 'gst', gstAmount: 4.01, variationId: null }],
  subtotal: 40.15, gstTotal: 4.01, grossTotal: 44.16,
})

describe('server and client domain logic are equal', () => {
  const INVOICES = { mixed: mixed(), legacy: legacy(), single: issuedInvoice({ subtotal: 9000, retention: 450 }), none: issuedInvoice({ subtotal: 123.45 }) }

  it.each(Object.keys(INVOICES))('%s — invoice totals, retention position and ledger position', (name) => {
    const inv = INVOICES[name]
    expect(server.invoiceTotals(inv.lineItems, inv.retention)).toEqual(client.invoiceTotals(inv.lineItems, inv.retention))
    expect(server.invoiceRetention(inv)).toEqual(client.invoiceRetention(inv))
    expect(server.ledgerPosition(inv, server.readLedger(null))).toEqual(client.ledgerPosition(inv, client.readLedger(null)))
  })

  it('a sequence of credits, releases and voids yields identical drafts, ledgers and invariant verdicts at every step', () => {
    const inv = mixed()
    let ledgerC = null
    let ledgerS = null
    const steps = [
      ['credit', [{ invoiceLineIndex: 0, amount: 200 }, { invoiceLineIndex: 1, amount: 20.07 }]],
      ['release', 50],
      ['credit', [{ invoiceLineIndex: 2, amount: 300 }]],
      ['release', 20.5],
      ['credit', [{ invoiceLineIndex: 1, amount: 20.08 }]],
    ]
    const posted = []
    for (const [i, [kind, arg]] of steps.entries()) {
      const c = kind === 'credit' ? client.buildClientCreditNote(inv, ledgerC, arg) : client.buildClientRetentionRelease(inv, ledgerC, arg)
      const s = kind === 'credit' ? server.buildClientCreditNote(inv, ledgerS, arg) : server.buildClientRetentionRelease(inv, ledgerS, arg)
      expect(s, `step ${i}`).toEqual(c)
      expect(c.error).toBeUndefined()
      const entry = kind === 'credit' ? { id: `e${i}`, lineItems: c.lineItems, ...c.totals } : { id: `e${i}`, ...c }
      const apply = kind === 'credit' ? 'applyCredit' : 'applyRelease'
      const nextC = client[apply](client.readLedger(ledgerC), entry)
      const nextS = server[apply](server.readLedger(ledgerS), entry)
      expect(nextS).toEqual(nextC)
      expect(server.ledgerInvariantError(inv, nextS)).toBe(client.ledgerInvariantError(inv, nextC))
      expect(client.ledgerInvariantError(inv, nextC)).toBeNull()
      ledgerC = client.ledgerDocument(nextC)
      ledgerS = server.ledgerDocument(nextS)
      expect(ledgerS).toEqual(ledgerC)
      posted.push([kind, entry])
    }
    expect(ledgerS.seq).toBe(5)
    // Taking the first release back out breaks an invariant, identically.
    const [, release] = posted[1]
    const voidedC = client.applyReleaseVoid(client.readLedger(ledgerC), release)
    const voidedS = server.applyReleaseVoid(server.readLedger(ledgerS), release)
    expect(voidedS).toEqual(voidedC)
    expect(server.ledgerInvariantError(inv, voidedS)).toBe(client.ledgerInvariantError(inv, voidedC))
    const [, credit] = posted[0]
    expect(server.applyCreditVoid(server.readLedger(ledgerS), credit)).toEqual(client.applyCreditVoid(client.readLedger(ledgerC), credit))
  })

  it('refusals are identical: over-credit, a line that does not exist, a release above what is held, a full credit of a legacy line', () => {
    const inv = mixed()
    for (const rows of [[{ invoiceLineIndex: 0, amount: 1000.01 }], [{ invoiceLineIndex: 9, amount: 1 }], [], [{ invoiceLineIndex: 0, amount: 1 }, { invoiceLineIndex: 0, amount: 1 }], [{ invoiceLineIndex: 0, amount: 1.005 }]]) {
      const c = client.buildClientCreditNote(inv, null, rows)
      expect(typeof c.error).toBe('string')
      expect(server.buildClientCreditNote(inv, null, rows)).toEqual(c)
    }
    for (const amount of [134.03, 0, -1, 1.005]) {
      const c = client.buildClientRetentionRelease(inv, null, amount)
      expect(typeof c.error).toBe('string')
      expect(server.buildClientRetentionRelease(inv, null, amount)).toEqual(c)
    }
    // The stored GST (4.01, one cent low) is reversed exactly — never re-derived at 10%.
    const full = server.buildClientCreditNote(legacy(), null, [{ invoiceLineIndex: 0, amount: 40.15 }])
    expect(full).toEqual(client.buildClientCreditNote(legacy(), null, [{ invoiceLineIndex: 0, amount: 40.15 }]))
    expect(full.totals).toMatchObject({ subtotal: 40.15, gstTotal: 4.01, grossTotal: 44.16 })
  })

  it('receipts, money helpers, constants and the draft shape agree', () => {
    const receipts = [
      { id: 'r1', status: 'posted', allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 100.1 }, { clientInvoiceId: 'ci2', allocatedAmount: 5 }] },
      { id: 'r2', status: 'posted', allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 0.2 }] },
      { id: 'r3', status: 'draft', allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 999 }] },
      { id: 'r4', status: 'void', allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 999 }] },
    ]
    for (const r of receipts) expect(server.storedReceiptAllocations(r)).toEqual(client.storedReceiptAllocations(r))
    expect(server.storedReceiptAllocations(receipts[0])).toEqual([{ clientInvoiceId: 'ci1', invoiceNumber: '', cents: 10010 }, { clientInvoiceId: 'ci2', invoiceNumber: '', cents: 500 }])
    expect(server.allocatedInvoiceIds([{ clientInvoiceId: 'b' }, { clientInvoiceId: 'a' }, { clientInvoiceId: 'b' }])).toEqual(['a', 'b'])
    for (const v of [0, 0.1, 40.15, 1.005, 1e9 + 0.01, '12.34', null, undefined, NaN]) {
      expect(server.toCents(v)).toBe(client.toCents(v))
      expect(server.isWholeCents(v)).toBe(client.isWholeCents(v))
    }
    for (const name of ['CI_STATUS', 'CCN_STATUS', 'CRR_STATUS', 'PAYMENT_STATUS', 'CCN_DOC_TYPE', 'CRR_DOC_TYPE', 'LEDGER_KIND', 'LEDGER_TOTAL_KEYS', 'CLIENT_CREDIT_LINE_KEYS', 'CLIENT_RECEIPT_KEYS', 'CLIENT_RECEIPT_ALLOCATION_KEYS']) {
      expect(server[name], name).toEqual(client[name])
    }
    expect(JSON.stringify(server.CLIENT_ENTRY_SHAPES, (_k, v) => (v instanceof RegExp ? String(v) : v)))
      .toBe(JSON.stringify(client.CLIENT_ENTRY_SHAPES, (_k, v) => (v instanceof RegExp ? String(v) : v)))
    const draft = { id: 'x', status: 'draft', extra: 1 }
    expect(server.clientEntryDraftProblem(server.CLIENT_ENTRY_SHAPES.creditNote, draft, mixed())).toBe('extra')
    expect(client.clientEntryDraftProblem(client.CLIENT_ENTRY_SHAPES.creditNote, draft, mixed())).toBe('extra')
  })
})

// ── The historical receipt baseline, company activation, the supported range ──

describe('what a POSTED receipt allocated is read strictly — identically in both modules', () => {
  const a = (clientInvoiceId, allocatedAmount, invoiceNumber = 'CI-0001') => ({ clientInvoiceId, invoiceNumber, allocatedAmount })
  const both = (fn, ...args) => { const c = client[fn](...args); expect(server[fn](...args)).toEqual(c); return c }

  it('one row per invoice in whole cents; two allocations to one invoice are added; `count` is the stored rows', () => {
    expect(both('postedReceiptAllocations', { allocations: [a('ci1', 100.1), a('ci2', 5, 'CI-0002'), a('ci1', 0.2)] })).toEqual({
      allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', cents: 10030 }, { clientInvoiceId: 'ci2', invoiceNumber: 'CI-0002', cents: 500 }], count: 3,
    })
    expect(both('postedReceiptAllocations', { allocations: [] })).toEqual({ allocations: [], count: 0 })
    expect(both('postedReceiptAllocations', { allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 1 }] }).allocations[0].invoiceNumber).toBe('')
  })

  it.each([
    ['no allocations array', { }, 'allocations'],
    ['allocations that are not an array', { allocations: { 0: a('ci1', 1) } }, 'allocations'],
    ['a null allocation', { allocations: [a('ci1', 1), null] }, 'allocations[1]'],
    ['an array as an allocation', { allocations: [[]] }, 'allocations[0]'],
    ['no invoice id', { allocations: [{ allocatedAmount: 5 }] }, 'allocations[0].clientInvoiceId'],
    ['an empty invoice id', { allocations: [a('', 5)] }, 'allocations[0].clientInvoiceId'],
    ['a numeric invoice id', { allocations: [a(7, 5)] }, 'allocations[0].clientInvoiceId'],
    ['an amount of zero', { allocations: [a('ci1', 0)] }, 'allocations[0].allocatedAmount'],
    ['a negative amount', { allocations: [a('ci1', -5)] }, 'allocations[0].allocatedAmount'],
    ['a fraction of a cent', { allocations: [a('ci1', 1), a('ci2', 10.005)] }, 'allocations[1].allocatedAmount'],
    ['an amount stored as a string', { allocations: [a('ci1', '5.00')] }, 'allocations[0].allocatedAmount'],
    ['a missing amount', { allocations: [{ clientInvoiceId: 'ci1' }] }, 'allocations[0].allocatedAmount'],
    ['NaN', { allocations: [a('ci1', NaN)] }, 'allocations[0].allocatedAmount'],
  ])('refused, naming the field — never skipped: %s', (_label, receipt, field) => {
    expect(both('postedReceiptAllocations', receipt)).toEqual({ field })
  })

  it('the baseline sums every posted receipt per invoice, exactly', () => {
    const receipts = [
      { id: 'r1', receiptNumber: 'CR-0001', allocations: [a('ci1', 100.1), a('ci2', 5)] },
      { id: 'r2', receiptNumber: 'CR-0002', allocations: [a('ci1', 0.2)] },
      { id: 'r3', receiptNumber: 'CR-0003', allocations: [] },
    ]
    expect(both('receiptBaselineSums', receipts)).toEqual({
      invoices: [{ invoiceId: 'ci1', cents: 10030, receipts: 2 }, { invoiceId: 'ci2', cents: 500, receipts: 1 }],
      legacyPostedReceipts: 3, legacyAllocations: 3, legacyCents: 10530,
    })
    expect(both('receiptBaselineSums', [])).toEqual({ invoices: [], legacyPostedReceipts: 0, legacyAllocations: 0, legacyCents: 0 })
    // 0.1 + 0.2, three thousand times: floats would drift, cents do not.
    const many = Array.from({ length: 3000 }, (_x, i) => ({ id: `m${i}`, allocations: [a('ci1', 0.1), a('ci2', 0.2)] }))
    expect(client.receiptBaselineSums(many)).toMatchObject({ invoices: [{ invoiceId: 'ci1', cents: 30000, receipts: 3000 }, { invoiceId: 'ci2', cents: 60000, receipts: 3000 }], legacyCents: 90000, legacyAllocations: 6000 })
  })

  it('the baseline is refused whole — naming the receipt — for a tracked receipt, a malformed allocation, a rejected invoice id or an unsafe sum', () => {
    const good = { id: 'r1', receiptNumber: 'CR-0001', allocations: [a('ci1', 10)] }
    expect(both('receiptBaselineSums', [good, { id: 'r2', receiptNumber: 'CR-0002', allocations: [a('ci1', 1)], allocatedInvoiceIds: ['ci1'] }]))
      .toEqual({ problem: { kind: 'inconsistent', receiptId: 'r2', number: 'CR-0002' } })
    expect(both('receiptBaselineSums', [good, { id: 'r2', allocations: [], allocatedInvoiceIds: [] }]).problem.kind).toBe('inconsistent')
    expect(both('receiptBaselineSums', [good, { id: 'r3', receiptNumber: 'CR-0003', allocations: [a('ci1', 1), a('ci9', 1.001)] }]))
      .toEqual({ problem: { kind: 'invalid', receiptId: 'r3', number: 'CR-0003', field: 'allocations[1].allocatedAmount' } })
    expect(client.receiptBaselineSums([good, { id: 'r4', receiptNumber: 'CR-0004', allocations: [a('a/b', 1)] }], (id) => !id.includes('/')))
      .toEqual({ problem: { kind: 'invalid', receiptId: 'r4', number: 'CR-0004', field: 'allocations' } })
    const huge = Array.from({ length: 12 }, (_x, i) => ({ id: `h${i}`, allocations: [a('ci1', 9_999_999_999_999.9)] }))
    expect(both('receiptBaselineSums', huge.slice(0, 9))).toMatchObject({ invoices: [{ cents: 8_999_999_999_999_910 }], legacyCents: 8_999_999_999_999_910 })
    expect(both('receiptBaselineSums', huge)).toEqual({ problem: { kind: 'range', receiptId: 'h9', number: null } })
  })

  it('what the listed receipts do not explain of a received figure: never negative', () => {
    expect(both('unlistedReceivedCents', 990000, [{ allocatedCents: 500000 }, { allocatedCents: 490000 }])).toBe(0)
    expect(both('unlistedReceivedCents', 990000, [{ allocatedCents: 500000 }])).toBe(490000)
    expect(both('unlistedReceivedCents', 990000, [])).toBe(990000)
    expect(both('unlistedReceivedCents', 5, [{ allocatedCents: 5298 }])).toBe(0)
    expect(both('unlistedReceivedCents', 7, undefined)).toBe(7)
  })
})

describe('company activation and the supported range', () => {
  it('clientFinanceActivated is strictly `=== true` on the company document', () => {
    for (const fn of [client.clientFinanceActivated, server.clientFinanceActivated]) {
      expect(fn({ clientFinanceEnabled: true })).toBe(true)
      for (const doc of [null, undefined, {}, { clientFinanceEnabled: false }, { clientFinanceEnabled: 'true' }, { clientFinanceEnabled: 1 }, { clientFinanceEnabled: null }, { clientFinanceEnabled: {} }, { clientfinanceenabled: true }]) {
        expect(fn(doc), JSON.stringify(doc)).toBe(false)
      }
    }
  })

  it('a receipt AT the maximum derives; one cent above is out of range — in both modules', () => {
    const MAX = 9_999_999_999_999.9
    expect(client.MAX_SUPPORTED_RECEIPT_CENTS).toBe(999_999_999_999_990)
    expect(server.MAX_SUPPORTED_RECEIPT_CENTS).toBe(client.MAX_SUPPORTED_RECEIPT_CENTS)
    expect(server.MAX_SUPPORTED_AMOUNT_CENTS).toBe(99_999_999_999_999)
    const at = { amount: MAX, allocations: [], allocatedTotal: 0, unallocatedAmount: MAX }
    for (const m of [client, server]) {
      expect(m.deriveReceiptTotals(at)).toEqual({ amountCents: 999_999_999_999_990, allocatedCents: 0, unallocatedCents: 999_999_999_999_990, allocations: [] })
      expect(m.deriveReceiptTotals({ ...at, amount: 9_999_999_999_999.91, unallocatedAmount: 9_999_999_999_999.91 }))
        .toEqual({ field: 'amount', outOfRange: true, maxCents: 999_999_999_999_990 })
      expect(m.deriveReceiptTotals({ ...at, amount: 1e17, unallocatedAmount: 1e17 })).toMatchObject({ field: 'amount', outOfRange: true })
    }
  })
})

describe('receipt posting is derived identically', () => {
  const draft = (over = {}) => ({
    amount: 500, allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 300.1 }, { clientInvoiceId: 'ci2', invoiceNumber: 'CI-0002', allocatedAmount: 99.9 }],
    allocatedTotal: 400, unallocatedAmount: 100, ...over,
  })

  it('totals: allocated = Σ allocations, unallocated = amount − allocated, in whole cents', () => {
    const c = client.deriveReceiptTotals(draft())
    expect(server.deriveReceiptTotals(draft())).toEqual(c)
    expect(c).toEqual({
      amountCents: 50000, allocatedCents: 40000, unallocatedCents: 10000,
      allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', cents: 30010 }, { clientInvoiceId: 'ci2', invoiceNumber: 'CI-0002', cents: 9990 }],
    })
    expect(client.deriveReceiptTotals(draft({ allocations: [], allocatedTotal: 0, unallocatedAmount: 500 }))).toMatchObject({ allocatedCents: 0, unallocatedCents: 50000 })
  })
  it.each([
    ['amount', { amount: 0 }], ['amount', { amount: -5 }], ['amount', { amount: 500.001 }], ['amount', { amount: '500' }],
    ['allocations[1].allocatedAmount', { allocations: [{ clientInvoiceId: 'a', allocatedAmount: 1 }, { clientInvoiceId: 'b', allocatedAmount: 0 }] }],
    ['allocations[0].allocatedAmount', { allocations: [{ clientInvoiceId: 'a', allocatedAmount: 1.005 }] }],
    ['allocations', { amount: 400 - 0.01 }],
    ['allocatedTotal', { allocatedTotal: 399.99, unallocatedAmount: 100.01 }],
    ['unallocatedAmount', { unallocatedAmount: 0 }],
    ['unallocatedAmount', { unallocatedAmount: undefined }],
  ])('names the stored figure that is wrong: %s', (field, over) => {
    expect(client.deriveReceiptTotals(draft(over))).toEqual({ field })
    expect(server.deriveReceiptTotals(draft(over))).toEqual({ field })
  })

  it('over-allocation: what remains is the receivable basis less what was received, never below zero', () => {
    const inv = issuedInvoice({ subtotal: 1000 })   // gross 1,100.00, no retention
    const ledger = (receivedCents, creditedSubtotalCents = 0, creditedGstCents = 0) => ({ ...client.readLedger(null), receivedCents, creditedSubtotalCents, creditedGstCents })
    const run = (cents, ledgerState) => {
      const args = [[{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', cents }], { ci1: { invoice: inv, ledgerState } }]
      const c = client.receiptOverAllocations(...args)
      expect(server.receiptOverAllocations(...args)).toEqual(c)
      return c
    }
    expect(run(110000, ledger(0))).toEqual([])                                    // exactly what is owed
    expect(run(110001, ledger(0))).toEqual([{ invoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedCents: 110001, remainingCents: 110000, excessCents: 1 }])
    expect(run(60000, ledger(60000))).toMatchObject([{ remainingCents: 50000, excessCents: 10000 }])
    // Credited after it was received: the invoice owes the CLIENT — nothing is available.
    expect(run(100, ledger(110000, 50000, 5000))).toMatchObject([{ remainingCents: 0, excessCents: 100 }])
    // An allocation to an invoice with no position is not judged here.
    expect(client.receiptOverAllocations([{ clientInvoiceId: 'zz', cents: 5 }], {})).toEqual([])
  })

  it('the latest postable date is the day after the server\'s UTC date', () => {
    for (const [nowIso, latest] of [['2026-11-26T02:00:00Z', '2026-11-27'], ['2026-11-26T23:59:59Z', '2026-11-27'], ['2026-12-31T12:00:00Z', '2027-01-01'], ['2028-02-28T00:00:00Z', '2028-02-29']]) {
      expect(client.latestPostableReceiptDate(new Date(nowIso))).toBe(latest)
      expect(server.latestPostableReceiptDate(new Date(nowIso))).toBe(latest)
    }
  })

  it('the receipt shape: exact keys, and the first field that is not as the app writes it', () => {
    const good = {
      receiptNumber: 'CR-0001', status: 'draft', docType: 'receipt', clientId: 'c1', clientName: 'Owner', receiptDate: '2026-11-20', amount: 500,
      paymentMethod: 'bank_transfer', paymentMethodOther: '', bankReference: '', externalReference: '',
      allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 500 }], allocatedTotal: 500, unallocatedAmount: 0,
      currency: 'AUD', revision: 1, notes: '', postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
      attachments: [], externalRefs: {}, createdAt: 1, createdBy: 'u', updatedAt: 1, updatedBy: 'u',
    }
    expect(Object.keys(good).sort()).toEqual([...client.CLIENT_RECEIPT_KEYS].sort())
    const problem = (over, drop = []) => {
      const doc = Object.fromEntries(Object.entries({ ...good, ...over }).filter(([k]) => !drop.includes(k)))
      const c = client.clientReceiptDraftProblem(doc)
      expect(server.clientReceiptDraftProblem(doc)).toBe(c)
      return c
    }
    expect(problem({})).toBeNull()
    expect(problem({ id: 'x' })).toBeNull()
    expect(problem({ allocations: [] })).toBeNull()
    for (const [over, field] of [
      [{ approved: true }, 'approved'], [{ allocatedInvoiceIds: [] }, 'allocatedInvoiceIds'], [{ status: 'posted' }, 'status'], [{ docType: 'refund' }, 'docType'],
      [{ receiptNumber: 'CR-1' }, 'receiptNumber'], [{ clientId: '' }, 'clientId'], [{ clientName: '  ' }, 'clientName'], [{ receiptDate: 'today' }, 'receiptDate'],
      [{ paymentMethod: 'barter' }, 'paymentMethod'], [{ bankReference: 'x'.repeat(201) }, 'bankReference'], [{ notes: 7 }, 'notes'], [{ currency: 'aud' }, 'currency'],
      [{ revision: '1' }, 'revision'], [{ postedBy: 'u' }, 'postedBy'], [{ voidReason: 'x' }, 'voidReason'], [{ attachments: ['a'] }, 'attachments'], [{ externalRefs: { xero: 1 } }, 'externalRefs'],
      [{ allocations: 'x' }, 'allocations'], [{ allocations: Array.from({ length: 101 }, (_x, i) => ({ clientInvoiceId: `i${i}`, invoiceNumber: '', allocatedAmount: 1 })) }, 'allocations'],
      [{ allocations: [{ ...good.allocations[0], note: 'x' }] }, 'allocations[0]'], [{ allocations: [null] }, 'allocations[0]'],
      [{ allocations: [good.allocations[0], good.allocations[0]] }, 'allocations[1].clientInvoiceId'],
      [{ allocations: [{ ...good.allocations[0], allocatedAmount: '500' }] }, 'allocations[0].allocatedAmount'],
      [{ allocations: [{ ...good.allocations[0], invoiceNumber: 5 }] }, 'allocations[0].invoiceNumber'],
    ]) expect(problem(over), field).toBe(field)
    expect(problem({}, ['externalRefs'])).toBe('externalRefs')
  })
})

describe('the trusted backend surface', () => {
  const DIR = 'functions/src/clientFinance'
  const files = readdirSync(fileURLToPath(new URL(`../../${DIR}`, import.meta.url))).sort()
  const index = read('functions/src/index.js')

  it('the callable source is split by responsibility', () => {
    expect(files).toEqual(['agreement.js', 'baseline.js', 'blocking.js', 'contracts.js', 'handlers.js', 'persistence.js', 'receipts.js', 'transactions.js'])
  })

  it('NO arithmetic of its own: every figure comes from the generated bundle', () => {
    for (const f of files) {
      const code = stripComments(read(`${DIR}/${f}`))
      expect(code, f).not.toMatch(/roundMoney|toFixed|\breduce\(/)
      expect(code, f).not.toMatch(/Math\.|parseFloat|Number\(|\* ?100|\/ ?100|0\.1\b|GST_RATE/)
      // No binary arithmetic anywhere; the attempt counter is `+= 1`.
      const sums = code.split('\n').filter(l => !l.startsWith('import ')).join('\n').match(/[\w)\]] [-+*/] [\w(]/g) || []
      expect(sums, f).toEqual([])
    }
    expect(stripComments(read(`${DIR}/transactions.js`))).toContain('attempts += 1')
    for (const f of ['agreement.js', 'baseline.js', 'blocking.js', 'handlers.js', 'persistence.js', 'receipts.js', 'transactions.js']) {
      expect(read(`${DIR}/${f}`), f).toContain("import * as calc from '../generated/clientFinanceCalc.js'")
    }
    // The domain modules themselves are never imported from the frontend tree.
    for (const f of files) expect(read(`${DIR}/${f}`), f).not.toMatch(/from '\.\.\/\.\.\/\.\.\/src|from '.*\/src\/lib\//)
  })

  it('every derivation, movement and invariant the operations use is a call into the bundle', () => {
    const tx = stripComments(read(`${DIR}/transactions.js`))
    const agreement = stripComments(read(`${DIR}/agreement.js`))
    for (const call of ['calc.applyCredit', 'calc.applyCreditVoid', 'calc.applyRelease', 'calc.applyReleaseVoid', 'calc.ledgerInvariantError(', 'calc.ledgerPosition(', 'calc.clientFinanceActivated(']) {
      expect(tx, call).toContain(call)
    }
    for (const call of ['calc.buildClientCreditNote(', 'calc.buildClientRetentionRelease(', 'calc.invoiceTotals(', 'calc.clientEntryDraftProblem(']) {
      expect(agreement, call).toContain(call)
    }
    // Every ledger is READ through one strict gate and WRITTEN through one range gate.
    const persistence = stripComments(read(`${DIR}/persistence.js`))
    for (const call of ['calc.ledgerDocument(next)', 'calc.readLedger(doc)', 'calc.storedLedgerProblem(doc)', 'calc.ledgerStateProblem(next)']) expect(persistence, call).toContain(call)
    expect(tx).not.toContain('calc.readLedger(')
    expect(tx).toContain('readStoredLedger(ledgerSnap)')
    // The baseline's sums and the unexplained remainder of a refusal are the bundle's too.
    expect(stripComments(read(`${DIR}/baseline.js`))).toContain('calc.receiptBaselineSums(')
    expect(stripComments(read(`${DIR}/blocking.js`))).toContain('calc.unlistedReceivedCents(')
    expect(agreement).toContain('calc.MAX_SUPPORTED_AMOUNT_CENTS')
    const receipts = stripComments(read(`${DIR}/receipts.js`))
    for (const call of ['calc.clientReceiptDraftProblem(', 'calc.deriveReceiptTotals(', 'calc.latestPostableReceiptDate(', 'calc.receiptOverAllocations(', 'calc.applyReceipt(', 'calc.applyReceiptVoid(', 'calc.allocatedInvoiceIds(', 'calc.postedReceiptAllocations(']) {
      expect(receipts, call).toContain(call)
    }
  })

  it('six callables: App Check enforced, the one region, no secret, no HTTP surface; the request is identifiers, a flag and a reason', () => {
    for (const n of ['postClientCreditNote', 'voidClientCreditNote', 'postClientRetentionRelease', 'voidClientRetentionRelease', 'postClientReceipt', 'voidClientReceipt']) {
      expect(index).toMatch(new RegExp(`^export const ${n}\\s+= clientFinanceCall\\('${n}'\\)$`, 'm'))
    }
    const opts = index.slice(index.indexOf('export const CLIENT_FINANCE_CALL_OPTIONS'), index.indexOf('let clientFinanceHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect(index).not.toMatch(/onRequest\(/)
    const contracts = read(`${DIR}/contracts.js`)
    expect(contracts).toContain("const keys = withReason ? ['projectId', idKey, 'reason'] : ['projectId', idKey]")
    expect(contracts).toMatch(/Object\.keys\(data\)\.some\(k => !keys\.includes\(k\)\)/)
    expect(read(`${DIR}/transactions.js`)).toContain('const companyId = profile.companyId')
  })
})

describe('the Rules blocks (source)', () => {
  const rules = read('firestore.rules')
  it('no client update takes a receipt out of draft except to void it', () => {
    const block = rules.slice(rules.indexOf('/clientReceipts/{receiptId} {'), rules.indexOf('// Supplier Payments'))
    const update = block.slice(block.indexOf('allow update:'), block.indexOf('allow delete:'))
    expect(update).toContain("resource.data.status == 'draft'")
    expect(update).not.toMatch(/'posted'/)
  })
  it('no client can write a ledger, and no client update reaches `posted`', () => {
    const ledger = rules.slice(rules.indexOf('/clientInvoiceLedgers/{invoiceId} {'), rules.indexOf('// Client Credit Notes (ADR-87)'))
    expect(ledger).toContain('allow write: if false;')
    const helper = rules.slice(rules.indexOf('function ciDraftUpdate('), rules.indexOf('// Membership documents'))
    expect(helper).toContain("resource.data.status == 'draft'")
    expect(helper).not.toMatch(/'posted'/)
  })
})
