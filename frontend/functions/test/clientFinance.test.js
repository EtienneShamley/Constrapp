import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClientFinanceHandlers, CLIENT_FINANCE_HANDLER_NAMES } from '../src/clientFinance/handlers.js'
import {
  CLIENT_FINANCE_ROLES, VOID_REASON_MAX, parsePostClientCreditNote, parseVoidClientCreditNote,
  parsePostClientRetentionRelease, parseVoidClientRetentionRelease, parsePostClientReceipt, parseVoidClientReceipt,
} from '../src/clientFinance/contracts.js'
import { invoiceInconsistency, invoiceProblem, invoiceRangeProblem, deriveCreditNote, deriveRetentionRelease } from '../src/clientFinance/agreement.js'
import { attachBlockers } from '../src/clientFinance/blocking.js'
import { CLIENT_FINANCE_MAX_ATTEMPTS } from '../src/clientFinance/transactions.js'
import { assertActiveRole } from '../src/lib/authz.js'
import { CODE, TeamError, isTeamError } from '../src/lib/errors.js'
import { AUDIT, auditPayload } from '../src/lib/audit.js'
import * as calc from '../src/generated/clientFinanceCalc.js'

// ── The client-finance callables — pins that need no Firestore (ADR-89) ──────
//
// The emulator-backed behaviour (transactions, races, idempotence, the exact
// ledger after every operation) lives in
// frontend/tests/functions/clientFinance.test.js; the freshness and
// client/server equality of the generated domain in
// frontend/tests/unit/clientFinanceBundle.test.js. This file runs in the
// Functions PREDEPLOY chain, so a deploy cannot ship a broken gate, a loose
// request contract or a generated file that is missing or not self-contained.

const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')
const deps = (over = {}) => ({ db: null, now: () => new Date('2026-11-26T00:00:00Z'), log: { info() {}, warn() {}, error() {} }, config: () => ({ finance: true, receipts: true }), ...over })
const refused = async (promise, code) => {
  try { await promise } catch (e) { expect(isTeamError(e, code), `${e?.details?.code ?? e?.message}`).toBe(true); return }
  throw new Error('no throw')
}
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)))
const FINANCE_NAMES = ['postClientCreditNote', 'voidClientCreditNote', 'postClientRetentionRelease', 'voidClientRetentionRelease']
const RECEIPT_NAMES = ['postClientReceipt', 'voidClientReceipt']
const NAMES = [...FINANCE_NAMES, ...RECEIPT_NAMES]
const ANY = { projectId: 'p', creditNoteId: 'c', releaseId: 'r', receiptId: 'x', reason: 'x', acknowledgeOverAllocation: false }

describe('handler gates before any data access', () => {
  it('exactly six handlers', () => {
    expect(CLIENT_FINANCE_HANDLER_NAMES).toEqual(NAMES)
    const h = createClientFinanceHandlers(deps())
    for (const n of NAMES) expect(typeof h[n], n).toBe('function')
  })
  it.each(NAMES)('%s: its kill switch answers first; then authentication; then validation — db is never touched (it is null)', async (name) => {
    const disabled = RECEIPT_NAMES.includes(name) ? CODE.CLIENT_RECEIPT_DISABLED : CODE.CLIENT_FINANCE_DISABLED
    const off = createClientFinanceHandlers(deps({ config: () => ({ finance: false, receipts: false }) }))
    await refused(off[name]({ auth: { uid: 'u' }, data: {} }), disabled)
    await refused(off[name]({ auth: null, data: {} }), disabled)
    const h = createClientFinanceHandlers(deps())
    await refused(h[name]({ auth: null, data: { nonsense: true } }), CODE.UNAUTHENTICATED)
    await refused(h[name]({ auth: { uid: 'u' }, data: { ...ANY, amount: 5 } }), CODE.INVALID_ARGUMENT)
  })
  it('the two switches are independent, and anything but an explicit true is OFF', async () => {
    const financeOff = createClientFinanceHandlers(deps({ config: () => ({ finance: false, receipts: true }) }))
    for (const n of FINANCE_NAMES) await refused(financeOff[n]({ auth: null, data: {} }), CODE.CLIENT_FINANCE_DISABLED)
    for (const n of RECEIPT_NAMES) await refused(financeOff[n]({ auth: null, data: {} }), CODE.UNAUTHENTICATED)   // past the gate
    const receiptsOff = createClientFinanceHandlers(deps({ config: () => ({ finance: true, receipts: false }) }))
    for (const n of RECEIPT_NAMES) await refused(receiptsOff[n]({ auth: null, data: {} }), CODE.CLIENT_RECEIPT_DISABLED)
    for (const n of FINANCE_NAMES) await refused(receiptsOff[n]({ auth: null, data: {} }), CODE.UNAUTHENTICATED)
    const unset = createClientFinanceHandlers(deps({ config: () => ({}) }))
    for (const n of FINANCE_NAMES) await refused(unset[n]({ auth: { uid: 'u' }, data: {} }), CODE.CLIENT_FINANCE_DISABLED)
    for (const n of RECEIPT_NAMES) await refused(unset[n]({ auth: { uid: 'u' }, data: {} }), CODE.CLIENT_RECEIPT_DISABLED)
  })
})

describe('request contracts — identifiers and a reason only', () => {
  const PARSERS = [
    [parsePostClientCreditNote, 'creditNoteId', false],
    [parseVoidClientCreditNote, 'creditNoteId', true],
    [parsePostClientRetentionRelease, 'releaseId', false],
    [parseVoidClientRetentionRelease, 'releaseId', true],
    [parseVoidClientReceipt, 'receiptId', true],
  ]
  const invalid = (fn, data) => { try { fn(data); return false } catch (e) { return isTeamError(e, CODE.INVALID_ARGUMENT) } }

  it.each(PARSERS)('accepts the exact shape and hands on nothing else (%#)', (parse, idKey, withReason) => {
    const ok = { projectId: 'projectA', [idKey]: 'entry1', ...(withReason ? { reason: '  Raised in error  ' } : {}) }
    expect(parse(ok)).toEqual({ projectId: 'projectA', entryId: 'entry1', ...(withReason ? { reason: 'Raised in error' } : {}) })
  })
  it.each(PARSERS)('refuses every other key and every malformed value (%#)', (parse, idKey, withReason) => {
    const ok = { projectId: 'projectA', [idKey]: 'entry1', ...(withReason ? { reason: 'Raised in error' } : {}) }
    for (const extra of ['amount', 'subtotal', 'gstAmount', 'companyId', 'lineItems', 'allocations', 'clientInvoiceId', 'seq', 'acknowledgeOverAllocation', idKey === 'releaseId' ? 'creditNoteId' : 'releaseId']) {
      expect(invalid(parse, { ...ok, [extra]: 1 }), extra).toBe(true)
    }
    if (!withReason) expect(invalid(parse, { ...ok, reason: 'x' })).toBe(true)
    for (const bad of ['', 'a/b', 'x'.repeat(65), 7, null, undefined, ['p']]) {
      expect(invalid(parse, { ...ok, projectId: bad }), `projectId ${String(bad)}`).toBe(true)
      expect(invalid(parse, { ...ok, [idKey]: bad }), `${idKey} ${String(bad)}`).toBe(true)
    }
    expect(invalid(parse, { projectId: 'projectA' })).toBe(true)
    for (const data of [null, undefined, 'x', 5, [ok]]) expect(invalid(parse, data)).toBe(true)
  })
  it('posting a receipt: ids and a REQUIRED boolean acknowledgement — nothing else', () => {
    const ok = { projectId: 'projectA', receiptId: 'r1', acknowledgeOverAllocation: false }
    expect(parsePostClientReceipt(ok)).toEqual({ projectId: 'projectA', entryId: 'r1', acknowledgeOverAllocation: false })
    expect(parsePostClientReceipt({ ...ok, acknowledgeOverAllocation: true }).acknowledgeOverAllocation).toBe(true)
    for (const flag of [undefined, null, 'true', 1, 0, 'yes']) expect(invalid(parsePostClientReceipt, { ...ok, acknowledgeOverAllocation: flag }), String(flag)).toBe(true)
    expect(invalid(parsePostClientReceipt, { projectId: 'projectA', receiptId: 'r1' })).toBe(true)
    for (const extra of ['amount', 'allocatedTotal', 'allocations', 'companyId', 'reason', 'clientId']) expect(invalid(parsePostClientReceipt, { ...ok, [extra]: 1 }), extra).toBe(true)
    for (const bad of ['', 'a/b', 7, null]) expect(invalid(parsePostClientReceipt, { ...ok, receiptId: bad })).toBe(true)
    for (const data of [null, 'x', [ok]]) expect(invalid(parsePostClientReceipt, data)).toBe(true)
  })
  it('a void reason is a string, non-blank after trimming, at most 500 characters', () => {
    expect(VOID_REASON_MAX).toBe(500)
    const ok = { projectId: 'p', creditNoteId: 'c' }
    for (const reason of ['', '   ', '\n\t', 5, null, ['x'], 'x'.repeat(501)]) {
      expect(invalid(parseVoidClientCreditNote, { ...ok, reason }), String(reason).slice(0, 12)).toBe(true)
    }
    expect(invalid(parseVoidClientCreditNote, ok)).toBe(true)   // a missing reason
    expect(parseVoidClientCreditNote({ ...ok, reason: 'x'.repeat(500) }).reason).toHaveLength(500)
    expect(parseVoidClientCreditNote({ ...ok, reason: ` ${'x'.repeat(500)} ` }).reason).toHaveLength(500)
  })
})

describe('who may post and void', () => {
  const check = (profile) => { try { assertActiveRole(profile, CLIENT_FINANCE_ROLES, CODE.CLIENT_FINANCE_FORBIDDEN); return 'ok' } catch (e) { return e.details.code } }
  it('only an ACTIVE company_admin, project_manager or qs of a company passes', () => {
    expect(CLIENT_FINANCE_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    for (const role of CLIENT_FINANCE_ROLES) expect(check({ role, companyId: 'c', status: 'active' })).toBe('ok')
    for (const role of ['subcontractor', 'client', 'super_admin', undefined]) expect(check({ role, companyId: 'c' })).toBe(CODE.CLIENT_FINANCE_FORBIDDEN)
    expect(check(null)).toBe(CODE.NO_MEMBERSHIP)
    expect(check({ role: 'qs', companyId: null })).toBe(CODE.NO_MEMBERSHIP)
    expect(check({ role: 'qs', companyId: 'c', status: 'deactivated' })).toBe(CODE.MEMBERSHIP_INACTIVE)
  })
})

// A 1,000.00 + 40.15 invoice, both lines taxable, 104.02 withheld (ex-GST).
const invoice = (over = {}) => {
  const lineItems = [
    { description: 'Works', amount: 1000, taxCode: 'gst', gstAmount: 100, variationId: null },
    { description: 'Variation', amount: 40.15, taxCode: 'gst', gstAmount: 4.02, variationId: 'v1' },
  ]
  return { id: 'ci1', invoiceNumber: 'CI-0001', status: 'issued', clientId: 'c1', currency: 'AUD', lineItems, ...calc.invoiceTotals(lineItems, 104.02), ...over }
}
const creditDraft = (inv, rows, ledgerDoc = null) => {
  const built = calc.buildClientCreditNote(inv, ledgerDoc, rows)
  return { status: 'draft', docType: 'credit_note', clientInvoiceId: inv.id, clientId: inv.clientId, currency: inv.currency, lineItems: built.lineItems, ...built.totals }
}

describe('the invoice is checked before it is trusted', () => {
  it('a consistent invoice, with and without retention fields, passes', () => {
    expect(invoiceInconsistency(invoice())).toBeNull()
    const legacy = without(invoice(), 'retention', 'retentionGst', 'retentionTotal', 'receivableTotal')
    expect(invoiceInconsistency(legacy)).toBeNull()
    // A legacy line whose stored GST is one cent low is consistent with its own header.
    const low = [{ amount: 40.15, taxCode: 'gst', gstAmount: 4.01, variationId: null }]
    expect(invoiceInconsistency({ lineItems: low, subtotal: 40.15, gstTotal: 4.01, grossTotal: 44.16 })).toBeNull()
  })
  it.each([
    ['subtotal', { subtotal: 1040.16 }],
    ['gstTotal', { gstTotal: 104.01 }],
    ['grossTotal', { grossTotal: 1144.18 }],
    ['retention', { retention: -1 }],
    ['retention', { retention: 104.021 }],
    ['retentionGst', { retentionGst: 10.39 }],
    ['retentionTotal', { retentionTotal: 114.41 }],
    ['receivableTotal', { receivableTotal: 1029.76 }],
    ['subtotal', { subtotal: '1040.15' }],
    ['lineItems', { lineItems: [] }],
    ['lineItems', { lineItems: null }],
  ])('names the stored field that disagrees: %s', (field, over) => {
    expect(invoiceInconsistency(invoice(over))).toBe(field)
  })
  it('one retention field present means all four are pinned', () => {
    expect(invoiceInconsistency(without(invoice(), 'retentionGst'))).toBe('retentionGst')
  })
  it('status, currency and client are checked before consistency', () => {
    const inv = invoice()
    const entry = creditDraft(inv, [{ invoiceLineIndex: 0, amount: 10 }])
    expect(invoiceProblem(inv, entry)).toBeNull()
    expect(invoiceProblem(null, entry)).toEqual({ code: CODE.CLIENT_INVOICE_NOT_ISSUED, details: { invoiceStatus: null } })
    for (const status of ['draft', 'void', 'sent']) expect(invoiceProblem({ ...inv, status }, entry).code).toBe(CODE.CLIENT_INVOICE_NOT_ISSUED)
    expect(invoiceProblem(inv, { ...entry, currency: 'NZD' })).toEqual({ code: CODE.CLIENT_INVOICE_MISMATCH, details: { field: 'currency' } })
    expect(invoiceProblem(inv, { ...entry, clientId: 'c2' })).toEqual({ code: CODE.CLIENT_INVOICE_MISMATCH, details: { field: 'clientId' } })
    expect(invoiceProblem({ ...inv, gstTotal: 1 }, entry)).toEqual({ code: CODE.CLIENT_INVOICE_INCONSISTENT, details: { field: 'gstTotal' } })
  })
})

describe('a stored draft must equal the server derivation', () => {
  const inv = invoice()
  const rows = [{ invoiceLineIndex: 0, amount: 200 }, { invoiceLineIndex: 1, amount: 20.07 }]
  const draft = creditDraft(inv, rows)
  const line = (i, over) => draft.lineItems.map((li, n) => (n === i ? { ...li, ...over } : li))

  it('the builder\'s own draft agrees, and the figures returned are the derivation', () => {
    const out = deriveCreditNote(inv, null, draft)
    expect(out.mismatch).toBeUndefined()
    expect(out.figures).toEqual({ lineItems: draft.lineItems, ...calc.buildClientCreditNote(inv, null, rows).totals })
  })
  it.each([
    ['a line GST that is not the derived share', { lineItems: line(0, { gstAmount: 19.99 }) }, 'lineItems[0].gstAmount'],
    ['a tax code that is not the invoice line\'s', { lineItems: line(0, { taxCode: 'gst_free' }) }, 'lineItems[0].taxCode'],
    ['a variation that is not the invoice line\'s', { lineItems: line(1, { variationId: 'v9' }) }, 'lineItems[1].variationId'],
    ['a line amount stored as a string', { lineItems: line(0, { amount: '200' }) }, 'lineItems[0].amount'],
    ['lines out of order', { lineItems: [...draft.lineItems].reverse() }, 'lineItems[0].invoiceLineIndex'],
    ['a subtotal that is not the sum of the lines', { subtotal: 220.08 }, 'subtotal'],
    ['a GST total that is not the sum of the lines', { gstTotal: 22 }, 'gstTotal'],
    ['a gross that is not subtotal + GST', { grossTotal: 1 }, 'grossTotal'],
    ['a retention part that is not the derived one', { retentionAmount: 0 }, 'retentionAmount'],
    ['a retention GST that is not the derived one', { retentionGst: 0 }, 'retentionGst'],
    ['a missing header', { receivableTotal: undefined }, 'receivableTotal'],
  ])('refuses %s', (_label, over, field) => {
    expect(deriveCreditNote(inv, null, { ...draft, ...over })).toEqual({ mismatch: { field } })
  })

  // The domain builder itself refuses an index that is not an integer (it is
  // never coerced into a line the caller did not name), so this draft is
  // refused before any comparison — still a mismatch, with the builder's reason.
  it('refuses a line index stored as a string', () => {
    const result = deriveCreditNote(inv, null, { ...draft, lineItems: line(0, { invoiceLineIndex: '0' }) })
    expect(result).toHaveProperty('mismatch')
    expect(result.derived).toBeUndefined()
  })
  it.each([
    ['a line above the invoice line', { lineItems: line(0, { amount: 1000.01 }) }],
    ['a duplicated line index', { lineItems: [draft.lineItems[0], draft.lineItems[0]] }],
    ['a line index that does not exist', { lineItems: line(0, { invoiceLineIndex: 7 }) }],
    ['a fraction of a cent', { lineItems: line(0, { amount: 10.005 }) }],
    ['no lines', { lineItems: [] }],
    ['lines that are not a list', { lineItems: 'x' }],
    ['a null line', { lineItems: [null] }],
  ])('refuses %s with the reason no credit can be derived', (_label, over) => {
    const out = deriveCreditNote(inv, null, { ...draft, ...over })
    expect(out.figures).toBeUndefined()
    expect(typeof out.mismatch.reason).toBe('string')
  })
  it('a draft built before another posting no longer agrees', () => {
    const first = creditDraft(inv, [{ invoiceLineIndex: 0, amount: 1000 }])
    const ledgerDoc = calc.ledgerDocument(calc.applyCredit(calc.readLedger(null), { id: 'a', ...first }))
    expect(deriveCreditNote(inv, ledgerDoc, draft).mismatch.reason).toMatch(/remains to credit/)
    // A release in between leaves less retention held, so the retention part of a credit moves.
    const released = calc.ledgerDocument(calc.applyRelease(calc.readLedger(null), { id: 'r', ...calc.buildClientRetentionRelease(inv, null, 50) }))
    expect(deriveCreditNote(inv, released, draft)).toEqual({ mismatch: { field: 'retentionAmount' } })
    expect(deriveCreditNote(inv, released, creditDraft(inv, rows, released)).mismatch).toBeUndefined()
  })
  it('a release: only its amount is used; GST and total must be the derivation', () => {
    const built = calc.buildClientRetentionRelease(inv, null, 50)
    const release = { amount: built.amount, gstAmount: built.gstAmount, releaseTotal: built.releaseTotal }
    expect(deriveRetentionRelease(inv, null, release)).toEqual({ figures: release })
    expect(deriveRetentionRelease(inv, null, { ...release, gstAmount: 0 })).toEqual({ mismatch: { field: 'gstAmount' } })
    expect(deriveRetentionRelease(inv, null, { ...release, releaseTotal: 50 })).toEqual({ mismatch: { field: 'releaseTotal' } })
    expect(deriveRetentionRelease(inv, null, { ...release, amount: '50' })).toEqual({ mismatch: { field: 'amount' } })
    expect(deriveRetentionRelease(inv, null, { ...release, amount: 104.03 }).mismatch.reason).toMatch(/still held/)
    expect(deriveRetentionRelease(inv, null, { ...release, amount: 0 }).mismatch.reason).toMatch(/greater than zero/)
  })
})

describe('the generated domain shipped with the functions', () => {
  const bundle = src('generated/clientFinanceCalc.js')
  it('is present, marked generated, and imports nothing', () => {
    expect(bundle.startsWith('// GENERATED FILE — DO NOT EDIT.')).toBe(true)
    const code = bundle.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(|import\.meta|\bwindow\.|\bdocument\./)
  })
  it('exports what the operations call', () => {
    for (const name of ['toCents', 'fromCents', 'isWholeCents', 'invoiceTotals', 'invoiceRetention', 'readLedger', 'ledgerDocument',
      'ledgerInvariantError', 'ledgerPosition', 'applyCredit', 'applyCreditVoid', 'applyRelease', 'applyReleaseVoid',
      'buildClientCreditNote', 'buildClientRetentionRelease', 'clientEntryDraftProblem', 'applyReceipt', 'applyReceiptVoid',
      'clientReceiptDraftProblem', 'deriveReceiptTotals', 'storedReceiptAllocations', 'allocatedInvoiceIds', 'receiptOverAllocations', 'latestPostableReceiptDate',
      'postedReceiptAllocations', 'receiptBaselineSums', 'unlistedReceivedCents', 'storedLedgerProblem', 'ledgerStateProblem', 'clientFinanceActivated']) {
      expect(typeof calc[name], name).toBe('function')
    }
    expect(calc.CCN_STATUS).toEqual({ DRAFT: 'draft', POSTED: 'posted', VOID: 'void' })
    expect(calc.CRR_STATUS).toEqual({ DRAFT: 'draft', POSTED: 'posted', VOID: 'void' })
    expect([calc.CCN_DOC_TYPE, calc.CRR_DOC_TYPE]).toEqual(['credit_note', 'client_retention_release'])
    expect(calc.LEDGER_KIND).toEqual({ CREDIT: 'credit', CREDIT_VOID: 'credit_void', RELEASE: 'release', RELEASE_VOID: 'release_void', RECEIPT: 'receipt', RECEIPT_VOID: 'receipt_void' })
    expect(calc.CLIENT_RECEIPT_KEYS).toHaveLength(28)
    expect(calc.CLIENT_RECEIPT_ALLOCATION_KEYS).toEqual(['clientInvoiceId', 'invoiceNumber', 'allocatedAmount'])
    expect(calc.LEDGER_TOTAL_KEYS).toHaveLength(6)
    // The description of a draft the posting requires, key for key.
    expect(calc.CLIENT_ENTRY_SHAPES.creditNote.keys).toHaveLength(31)
    expect(calc.CLIENT_ENTRY_SHAPES.retentionRelease.keys).toHaveLength(25)
    expect(calc.CLIENT_CREDIT_LINE_KEYS).toHaveLength(9)
    expect(calc.clientEntryDraftProblem(calc.CLIENT_ENTRY_SHAPES.retentionRelease, { status: 'draft', approved: true }, {})).toBe('approved')
  })
})

describe('surface', () => {
  const index = src('index.js')
  const FILES = ['contracts.js', 'agreement.js', 'persistence.js', 'transactions.js', 'receipts.js', 'blocking.js', 'handlers.js', 'baseline.js']
  const code = (rel) => src(rel).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('six more callables: App Check enforced, the one region, no secret, no service account, two kill switches', () => {
    for (const n of NAMES) expect(index).toMatch(new RegExp(`^export const ${n}\\s+= clientFinanceCall\\('${n}'\\)$`, 'm'))
    const opts = index.slice(index.indexOf('export const CLIENT_FINANCE_CALL_OPTIONS'), index.indexOf('let clientFinanceHandlers'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    // The same options as the Final Account approval.
    const fa = index.slice(index.indexOf('export const FINAL_ACCOUNT_CALL_OPTIONS'), index.indexOf('let finalAccountHandlers'))
    expect(opts.slice(opts.indexOf('{'))).toBe(fa.slice(fa.indexOf('{')))
    expect(index).toContain('const clientFinanceCall = (name) => onCall(CLIENT_FINANCE_CALL_OPTIONS,')
    expect((index.match(/CLIENT_FINANCE_POSTING_ENABLED/g) || []).length).toBe(2)   // the import and the one config()
    expect((index.match(/CLIENT_RECEIPT_POSTING_ENABLED/g) || []).length).toBe(2)
    expect((index.match(/CLIENT_RECEIPT_ALL_COMPANIES/g) || []).length).toBe(2)
    expect(index).toContain('config: () => ({ finance: CLIENT_FINANCE_POSTING_ENABLED.value(), receipts: CLIENT_RECEIPT_POSTING_ENABLED.value(), receiptsAllCompanies: CLIENT_RECEIPT_ALL_COMPANIES.value() })')
    expect((index.match(/onCall\(/g) || []).length).toBe(4)   // the team wrapper, approveFinalAccount, transferBoqToBudget, the client-finance wrapper
    // The existing surface is untouched.
    expect((index.match(/wrap\('/g) || []).length).toBe(8)
    expect((index.match(/onSchedule\(/g) || []).length).toBe(1)
    expect(index).not.toMatch(/onRequest\(/)
    // No export shares a prefix the CLI deploy filter matches on.
    const names = [...index.matchAll(/^export const (\w+)\s+=\s+(wrap|onCall|onSchedule|clientFinanceCall)\(/gm)].map(m => m[1])
    for (const n of NAMES) expect(names.filter(x => x === n || x.startsWith(`${n}-`))).toEqual([n])
  })

  it('no formula of its own: every figure comes from the generated bundle', () => {
    for (const f of FILES) {
      expect(code(`clientFinance/${f}`), f).not.toMatch(/roundMoney|toFixed|\breduce\(|Math\.|\* ?100|\/ ?100|0\.1\b/)
    }
    for (const f of ['agreement.js', 'persistence.js', 'transactions.js', 'receipts.js', 'blocking.js', 'baseline.js', 'handlers.js']) {
      expect(src(`clientFinance/${f}`), f).toContain("import * as calc from '../generated/clientFinanceCalc.js'")
    }
  })

  it('the company comes from the membership and every read is transactional', () => {
    const tx = code('clientFinance/transactions.js')
    expect(tx).toContain('const companyId = profile.companyId')
    for (const f of FILES) expect(code(`clientFinance/${f}`), f).not.toMatch(/companyId\s*[:=]\s*(request|data|input)\b/)
    // Every .get( in the operation is tx.get / tx.getAll.
    for (const f of ['transactions.js', 'receipts.js', 'persistence.js', 'agreement.js']) expect(code(`clientFinance/${f}`).match(/[^x.]\.get\(/g), f).toBeNull()
    expect((tx.match(/db\.runTransaction\(/g) || []).length).toBe(1)
    expect(code('clientFinance/receipts.js')).not.toMatch(/runTransaction\(/)   // the same guarded runner
    // NO operation queries a collection: every transactional read is a document.
    for (const f of ['transactions.js', 'receipts.js', 'persistence.js']) expect(code(`clientFinance/${f}`), f).not.toMatch(/\.where\(|\.limit\(|\.orderBy\(/)
    // The only queries are the blocking lookups — outside any transaction, equality filters, capped.
    const blocking = code('clientFinance/blocking.js')
    expect(blocking).not.toMatch(/tx\.|runTransaction/)
    expect((blocking.match(/\.where\(/g) || []).length).toBe(2)
    expect((blocking.match(/\.limit\(BLOCKING_LOOKUP_LIMIT\)/g) || []).length).toBe(2)
    expect(blocking).toContain("where('clientInvoiceId', '==', invoiceId)")
    expect(blocking).toContain("where('allocatedInvoiceIds', 'array-contains', invoiceId)")
    expect(tx).toContain('{ maxAttempts: CLIENT_FINANCE_MAX_ATTEMPTS }')
    expect(CLIENT_FINANCE_MAX_ATTEMPTS).toBe(5)
    expect(tx).toContain('if (!err?.details?.code && err?.code === GRPC_ABORTED)')
    // The function may run for 120 s — under the 270 s transaction limit.
    expect(index).toMatch(/CLIENT_FINANCE_CALL_OPTIONS = \{[^}]*timeoutSeconds: 120,/)
  })

  it('writes are the ledger, the entry and one audit event — each guarded, each stamped with server time', () => {
    const p = code('clientFinance/persistence.js')
    expect((p.match(/tx\.(update|set|create|delete)\(/g) || []).length).toBe(5)   // ledger update / create, posted stamp, void stamp, receipt posted stamp
    expect(p).not.toMatch(/tx\.(set|delete)\(/)
    expect((p.match(/lastUpdateTime: (ledgerSnap|entrySnap|receiptSnap)\.updateTime/g) || []).length).toBe(4)
    expect(p).toContain("collection('clientInvoiceLedgers')")
    const tx = code('clientFinance/transactions.js')
    expect(tx).not.toMatch(/tx\.(update|set|create|delete)\(/)
    expect((tx.match(/auditInTx\(/g) || []).length).toBe(2)   // one in post, one in void
    expect(tx).not.toMatch(/clientInvoices'\)|budgetLines|clientReceipts/)
    const receipts = code('clientFinance/receipts.js')
    expect(receipts).not.toMatch(/tx\.(update|set|create|delete)\(/)
    expect((receipts.match(/auditInTx\(/g) || []).length).toBe(2)
  })

  it('a release void reads NO receipt: the received figure is in the invoice ledger, and no read limit exists', () => {
    const tx = code('clientFinance/transactions.js')
    expect(tx).toContain('if (receivableBasisAfterCents < next.receivedCents) {')
    expect(tx).toContain('calc.ledgerPosition(invoice, next).receivableBasisCents')
    for (const f of FILES) expect(src(`clientFinance/${f}`), f).not.toMatch(/POSTED_RECEIPT_READ_LIMIT|receivedByInvoice|readPostedReceipts|REGISTER_TOO_LARGE/)
    expect(Object.keys(CODE)).not.toContain('CLIENT_REGISTER_TOO_LARGE')
    expect(src('lib/errors.js')).not.toContain('register-too-large')
  })

  it('blockers are attached to the two void refusals only, never change the code, and a failed lookup leaves the refusal as it was', async () => {
    const log = { warn() {} }
    const thrown = async (err, refusedInfo) => { try { await attachBlockers(null, log, err, refusedInfo) } catch (e) { return e } return null }
    const other = new TeamError(CODE.CLIENT_ENTRY_NOT_POSTED)
    expect(await thrown(other, { projectRef: null })).toBe(other)
    const plain = new Error('boom')
    expect(await thrown(plain, { projectRef: null })).toBe(plain)
    const invariant = new TeamError(CODE.CLIENT_LEDGER_INVARIANT, { invariant: 'x', number: 'CCN-0001' })
    expect(await thrown(invariant, null)).toBe(invariant)
    // projectRef null → the lookup throws → the SAME refusal goes out.
    expect(await thrown(invariant, { projectRef: null, invoiceId: 'i', entryId: 'e', postedAt: { toMillis: () => 1 } })).toBe(invariant)
    const depend = new TeamError(CODE.CLIENT_RECEIPTS_DEPEND, { receivedCents: 5, receivableBasisAfterCents: 1 })
    expect(await thrown(depend, { projectRef: null, invoiceId: 'i' })).toBe(depend)
    // A fake project: one later posted release, one earlier credit, one void.
    const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) })
    const docs = {
      clientCreditNotes: [{ id: 'self', d: { status: 'posted', creditNumber: 'CCN-0001', postedAt: ts(1000) } }, { id: 'early', d: { status: 'posted', creditNumber: 'CCN-0000', postedAt: ts(500) } }, { id: 'late2', d: { status: 'posted', creditNumber: 'CCN-0003', postedAt: ts(3000) } }],
      clientRetentionReleases: [{ id: 'late', d: { status: 'posted', releaseNumber: 'CRR-0002', postedAt: ts(2000) } }, { id: 'gone', d: { status: 'void', releaseNumber: 'CRR-0001', postedAt: ts(2500) } }],
      clientReceipts: [{ id: 'r1', d: { status: 'posted', receiptNumber: 'CR-0007', postedAt: ts(10), allocations: [{ clientInvoiceId: 'i', allocatedAmount: 52.98 }, { clientInvoiceId: 'j', allocatedAmount: 1 }] } }, { id: 'r2', d: { status: 'void', receiptNumber: 'CR-0008', allocations: [{ clientInvoiceId: 'i', allocatedAmount: 9 }] } }],
    }
    const projectRef = { collection: (name) => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: docs[name].map(x => ({ id: x.id, data: () => x.d })) }) }) }) }) }
    const named = await thrown(invariant, { projectRef, invoiceId: 'i', entryId: 'self', postedAt: ts(1000) })
    expect(isTeamError(named, CODE.CLIENT_LEDGER_INVARIANT)).toBe(true)
    expect(named.details).toEqual({
      code: CODE.CLIENT_LEDGER_INVARIANT, invariant: 'x', number: 'CCN-0001',
      blockingEntries: [
        { kind: 'credit_note', number: 'CCN-0003', id: 'late2', postedAt: new Date(3000).toISOString() },
        { kind: 'retention_release', number: 'CRR-0002', id: 'late', postedAt: new Date(2000).toISOString() },
      ],
    })
    const receipts = await thrown(depend, { projectRef, invoiceId: 'i' })
    expect(receipts.details).toEqual({
      code: CODE.CLIENT_RECEIPTS_DEPEND, receivedCents: 5, receivableBasisAfterCents: 1,
      blockingReceipts: [{ number: 'CR-0007', id: 'r1', allocatedCents: 5298, postedAt: new Date(10).toISOString() }],
    })
  })

  // ── The historical receipt baseline (ADR-89, final pass) ───────────────────
  it('the baseline: one guarded transaction, the ONLY query inside any transaction, a create-only marker, one audit event — and no bound on a project\'s receipts', () => {
    const b = code('clientFinance/baseline.js')
    expect((b.match(/runGuarded\(/g) || []).length).toBe(1)
    expect(b).not.toMatch(/db\.runTransaction\(|[^x.]\.get\(/)   // every read is tx.get / tx.getAll
    // ONE query: the project's posted receipts, by equality, inside the transaction. No limit: nothing is ever left out.
    expect((b.match(/\.where\(/g) || []).length).toBe(1)
    expect(b).toContain("tx.get(refs.project.collection('clientReceipts').where('status', '==', calc.PAYMENT_STATUS.POSTED))")
    expect(b).not.toMatch(/\.limit\(|\.orderBy\(|5000|5_000/)
    // The marker is read FIRST and written with create; a present marker returns before anything else is read.
    expect(b.indexOf('if ((await tx.get(marker)).exists) return { established: false }')).toBeGreaterThan(0)
    expect(b.indexOf('if ((await tx.get(marker)).exists) return { established: false }')).toBeLessThan(b.indexOf('tx.getAll(refs.company, refs.project)'))
    expect(b).toContain('tx.create(marker, {')
    expect((b.match(/auditInTx\(/g) || []).length).toBe(1)
    expect((b.match(/tx\.(update|set|create|delete)\(/g) || []).length).toBe(3)   // ledger create, ledger update, the marker
    expect(b).not.toMatch(/tx\.(set|delete)\(/)
    expect(b).toContain('{ lastUpdateTime: snap.updateTime }')
    // It writes ledgers and the marker — never a receipt, never an invoice.
    expect(b).not.toMatch(/receiptRef|invoiceRef|clientInvoices'\)/)
    expect(b).toContain('RECEIPT_BASELINE_MAX_WRITES = 450')
    expect(b).toContain('RECEIPT_BASELINE_MAX_INVOICES = 448')
    expect(src('clientFinance/baseline.js')).toContain('can never grow')
    expect(code('clientFinance/persistence.js')).toContain("projectRef.collection('clientFinanceState').doc('receiptBaseline')")
  })

  it('every operation: the switch first, then the caller, then (credit notes and releases) the company, then the baseline — and its own transaction requires the marker', () => {
    const h = code('clientFinance/handlers.js')
    const order = ['if (deps.config()[gate] !== true) fail(disabled)', 'requireAuth(request)', 'parse(request.data)', 'assertActiveRole(', 'if (!everyCompany) await assertCompanyActivated(', 'await ensureReceiptBaseline(', 'return run(deps,']
    const at = order.map(s => h.indexOf(s, h.indexOf('const handler =')))
    expect(at.every(i => i > 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // Credit notes and releases: ALWAYS company-gated (no `openToAll`). Receipts: gated by their own flag unless open to all.
    expect(h).toContain("const FINANCE = { gate: 'finance', disabled: CODE.CLIENT_FINANCE_DISABLED, activated: financeActivated, notActivated: CODE.CLIENT_FINANCE_NOT_ACTIVATED }")
    expect(h).toContain("const RECEIPTS = { gate: 'receipts', disabled: CODE.CLIENT_RECEIPT_DISABLED, activated: receiptsActivated, notActivated: CODE.CLIENT_RECEIPT_DISABLED, openToAll: 'receiptsAllCompanies' }")
    expect(h).toContain('const financeActivated = (company) => calc.clientFinanceActivated(company)')
    expect(h).toContain('const receiptsActivated = (company) => company?.clientReceiptsEnabled === true')
    expect(h).toContain('const everyCompany = openToAll !== undefined && deps.config()[openToAll] === true')
    expect(h).toContain('if (!activated(companySnap.data())) fail(notActivated)')
    // Inside the transaction: the marker is one of the documents read, and its absence is a refusal.
    const tx = code('clientFinance/transactions.js')
    expect(tx).toContain('tx.getAll(refs.company, refs.project, receiptBaselineRef(refs.project), ref)')
    expect(tx).toContain('if (!baselineSnap.exists) fail(CODE.CLIENT_RECEIPT_BASELINE_MISSING)')
    expect(tx).toContain('if (requireActivation && !calc.clientFinanceActivated(companySnap.data())) fail(CODE.CLIENT_FINANCE_NOT_ACTIVATED)')
    expect(tx.indexOf('fail(CODE.NOT_FOUND)')).toBeLessThan(tx.indexOf('fail(CODE.CLIENT_FINANCE_NOT_ACTIVATED)'))
    // Credit notes and releases require activation; receipts do not.
    expect((tx.match(/requireActivation: true/g) || []).length).toBe(1)
    expect(code('clientFinance/receipts.js')).not.toContain('requireActivation')
  })

  it('nothing is clamped or coerced: a receipt void is refused when the ledger records less, and every ledger is read and written through the range gates', () => {
    const receipts = code('clientFinance/receipts.js')
    expect(receipts).toContain('if (before.receivedCents < t.cents) {')
    expect(receipts).not.toContain('ledgerTracked')
    expect(receipts).not.toContain('calc.readLedger(')
    expect((receipts.match(/readStoredLedger\(/g) || []).length).toBe(2)
    const p = code('clientFinance/persistence.js')
    expect(p).toContain('const problem = calc.storedLedgerProblem(doc)')
    expect(p).toContain('const problem = calc.ledgerStateProblem(next)')
    const lib = readFileSync(fileURLToPath(new URL('../../src/lib/clientLedger.js', import.meta.url)), 'utf8')
    expect(lib.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).not.toMatch(/receivedCents = Math\.max/)
    // No statement anywhere that the received figure is a lower bound.
    for (const f of FILES) expect(src(`clientFinance/${f}`), f).not.toMatch(/lower bound/i)
    for (const f of ['clientLedger.js', 'clientReceiptPosting.js']) {
      expect(readFileSync(fileURLToPath(new URL(`../../src/lib/${f}`, import.meta.url)), 'utf8'), f).not.toMatch(/lower bound/i)
    }
  })

  it('the supported range is the server\'s: an invoice subtotal and a receipt amount above it are typed refusals', () => {
    expect(calc.MAX_SUPPORTED_AMOUNT_CENTS).toBe(99_999_999_999_999)
    expect(calc.MAX_SUPPORTED_RECEIPT_CENTS).toBe(999_999_999_999_990)
    const lines = (amount) => [{ description: 'x', amount, taxCode: 'gst_free', gstAmount: 0 }]
    const inv = (amount) => ({ status: 'issued', currency: 'AUD', clientId: 'c1', lineItems: lines(amount), ...calc.invoiceTotals(lines(amount), 0) })
    const entry = { currency: 'AUD', clientId: 'c1' }
    expect(invoiceRangeProblem(inv(999999999999.99))).toBeNull()
    expect(invoiceProblem(inv(999999999999.99), entry)).toBeNull()
    expect(invoiceProblem(inv(1000000000000), entry)).toEqual({ code: CODE.CLIENT_AMOUNT_OUT_OF_RANGE, details: { field: 'subtotal', maxCents: 99_999_999_999_999 } })
    expect(new TeamError(CODE.CLIENT_AMOUNT_OUT_OF_RANGE).code).toBe('failed-precondition')
    expect(code('clientFinance/receipts.js')).toContain('if (money.outOfRange) fail(CODE.CLIENT_AMOUNT_OUT_OF_RANGE,')
    expect(code('clientFinance/receipts.js')).toContain('const range = invoiceRangeProblem(invoice)')
  })

  it('the new refusals: stable codes, failed-precondition, and the exact activation message', () => {
    const expected = {
      CLIENT_FINANCE_NOT_ACTIVATED: 'client-finance-not-activated',
      CLIENT_RECEIPT_BASELINE_MISSING: 'client-receipt-baseline-missing',
      CLIENT_RECEIPT_BASELINE_INCONSISTENT: 'client-receipt-baseline-inconsistent',
      CLIENT_RECEIPT_BASELINE_INVALID: 'client-receipt-baseline-invalid',
      CLIENT_RECEIPT_BASELINE_TOO_LARGE: 'client-receipt-baseline-too-large',
      CLIENT_AMOUNT_OUT_OF_RANGE: 'client-amount-out-of-range',
    }
    for (const [key, value] of Object.entries(expected)) {
      expect(CODE[key], key).toBe(value)
      const err = new TeamError(CODE[key])
      expect(err.code, key).toBe('failed-precondition')
      expect(err.message, key).toMatch(/Nothing was changed\./)
    }
    expect(new TeamError(CODE.CLIENT_FINANCE_NOT_ACTIVATED).message).toBe('Client credit notes and retention releases are not yet available for this company. Nothing was changed.')
    expect(new TeamError(CODE.CLIENT_RECEIPT_BASELINE_TOO_LARGE).message).toContain('needs an operator baseline')
    expect([AUDIT.CLIENT_RECEIPT_BASELINE_ESTABLISHED, AUDIT.COMPANY_CLIENT_FINANCE_SET]).toEqual(['client_receipt.baseline_established', 'company.client_finance_set'])
    expect(auditPayload({ type: AUDIT.COMPANY_CLIENT_FINANCE_SET, actorUid: 'operator', source: 'operator' }, new Date()).source).toBe('operator')
  })

  it('a release-void refusal reports what the listed receipts do not explain, and when the invoice has pre-backend history', async () => {
    const log = { warn() {} }
    const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) })
    const found = [{ id: 'r1', d: { status: 'posted', receiptNumber: 'CR-0007', postedAt: ts(10), allocations: [{ clientInvoiceId: 'i', allocatedAmount: 10 }] } }]
    const projectRef = { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: found.map(x => ({ id: x.id, data: () => x.d })) }) }) }) }) }
    const thrown = async (details, refusedInfo) => { try { await attachBlockers(null, log, new TeamError(CODE.CLIENT_RECEIPTS_DEPEND, details), { projectRef, invoiceId: 'i', ...refusedInfo }) } catch (e) { return e.details } return null }
    // Fully explained by what was found: no extra keys.
    expect(await thrown({ receivedCents: 1000, receivableBasisAfterCents: 1 }, {})).toEqual({
      code: CODE.CLIENT_RECEIPTS_DEPEND, receivedCents: 1000, receivableBasisAfterCents: 1,
      blockingReceipts: [{ number: 'CR-0007', id: 'r1', allocatedCents: 1000, postedAt: new Date(10).toISOString() }],
    })
    // 4,000 of the 5,000 received is historical: said so, with the baseline's date.
    expect(await thrown({ receivedCents: 5000, receivableBasisAfterCents: 1 }, { receiptBaseline: { legacyCents: 4000, legacyReceipts: 2, establishedAt: ts(86_400_000) } })).toMatchObject({
      blockingReceipts: [{ id: 'r1' }], unlistedReceivedCents: 4000, receiptBaselineAt: '1970-01-02T00:00:00.000Z',
    })
    // Unexplained with no historical baseline on the invoice: reported, with no date invented.
    expect(await thrown({ receivedCents: 5000, receivableBasisAfterCents: 1 }, { receiptBaseline: null })).toMatchObject({ unlistedReceivedCents: 4000, receiptBaselineAt: null })
    expect(await thrown({ receivedCents: 5000, receivableBasisAfterCents: 1 }, { receiptBaseline: { legacyCents: 0, establishedAt: ts(5) } })).toMatchObject({ unlistedReceivedCents: 4000, receiptBaselineAt: null })
  })

  it('six audit types, each accepted by the audit writer', () => {
    expect([AUDIT.CLIENT_CREDIT_NOTE_POSTED, AUDIT.CLIENT_CREDIT_NOTE_VOIDED, AUDIT.CLIENT_RETENTION_RELEASE_POSTED, AUDIT.CLIENT_RETENTION_RELEASE_VOIDED])
      .toEqual(['client_credit_note.posted', 'client_credit_note.voided', 'client_retention_release.posted', 'client_retention_release.voided'])
    expect([AUDIT.CLIENT_RECEIPT_POSTED, AUDIT.CLIENT_RECEIPT_VOIDED]).toEqual(['client_receipt.posted', 'client_receipt.voided'])
    expect(auditPayload({ type: AUDIT.CLIENT_CREDIT_NOTE_POSTED, actorUid: 'u' }, new Date()).source).toBe('callable')
  })
})

describe('release safety', () => {
  const DIR = fileURLToPath(new URL('../', import.meta.url))
  const envFiles = readdirSync(DIR).filter(f => /^\.env\.[a-z0-9-]+$/.test(f) && f !== '.env.local')
  const valueOf = (file, key) => readFileSync(join(DIR, file), 'utf8').split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1)

  it('the switch DEFAULTS TO OFF in code (fail closed) and every project env file states it explicitly', () => {
    expect(src('lib/params.js')).toContain("export const CLIENT_FINANCE_POSTING_ENABLED = defineBoolean('CLIENT_FINANCE_POSTING_ENABLED', { default: false })")
    expect(envFiles).toEqual(expect.arrayContaining(['.env.constrapp-69b5d', '.env.constrapp-rules-test']))
    // A non-interactive deploy refuses a parameter with no dotenv value.
    for (const f of envFiles) expect(['true', 'false'], f).toContain(valueOf(f, 'CLIENT_FINANCE_POSTING_ENABLED'))
    expect(src('lib/params.js')).toContain("export const CLIENT_RECEIPT_POSTING_ENABLED = defineBoolean('CLIENT_RECEIPT_POSTING_ENABLED', { default: false })")
    for (const f of envFiles) expect(['true', 'false'], f).toContain(valueOf(f, 'CLIENT_RECEIPT_POSTING_ENABLED'))
    expect(src('lib/params.js')).toContain("export const CLIENT_RECEIPT_ALL_COMPANIES = defineBoolean('CLIENT_RECEIPT_ALL_COMPANIES', { default: false })")
    for (const f of envFiles) expect(['true', 'false'], f).toContain(valueOf(f, 'CLIENT_RECEIPT_ALL_COMPANIES'))
  })
  it('THE PRODUCTION CUTOVER STARTS WITH BOTH SWITCHES OFF; both ON for the emulator', () => {
    expect(valueOf('.env.constrapp-69b5d', 'CLIENT_RECEIPT_POSTING_ENABLED')).toBe('false')
    expect(valueOf('.env.constrapp-69b5d', 'CLIENT_FINANCE_POSTING_ENABLED')).toBe('false')
    // … and receipts, once switched on, are scoped to operator-activated companies until told otherwise.
    expect(valueOf('.env.constrapp-69b5d', 'CLIENT_RECEIPT_ALL_COMPANIES')).toBe('false')
    expect(valueOf('.env.constrapp-rules-test', 'CLIENT_RECEIPT_ALL_COMPANIES')).toBe('true')
    expect(valueOf('.env.constrapp-rules-test', 'CLIENT_RECEIPT_POSTING_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-rules-test', 'CLIENT_FINANCE_POSTING_ENABLED')).toBe('true')
    // The order is written where the switches are defined.
    const params = src('lib/params.js')
    expect(params).toContain('CUTOVER ORDER (production starts with BOTH switches off)')
    const scoped = params.indexOf('CLIENT_RECEIPT_POSTING_ENABLED=true with CLIENT_RECEIPT_ALL_COMPANIES')
    const all = params.indexOf('CLIENT_RECEIPT_ALL_COMPANIES=true —')
    expect(params.indexOf('the restrictive Rules published')).toBeLessThan(scoped)
    expect(scoped).toBeGreaterThan(0)
    expect(scoped).toBeLessThan(all)
    expect(all).toBeLessThan(params.indexOf('the TEST company activated'))
  })
  it('adding the switch changed no existing production parameter', () => {
    expect(valueOf('.env.constrapp-69b5d', 'TEAM_MANAGEMENT_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_REVOCATION_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'FILE_LINK_RECONCILE_INTERVAL_HOURS')).toBe('2')
    expect(valueOf('.env.constrapp-69b5d', 'FINAL_ACCOUNT_APPROVAL_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'BOQ_BUDGET_TRANSFER_ENABLED')).toBe('true')
    expect(valueOf('.env.constrapp-69b5d', 'STORAGE_BUCKET')).toBe('')
  })
  it('every typed refusal has a status and a message', () => {
    const keys = Object.keys(CODE).filter(k => k.startsWith('CLIENT_'))
    expect(keys).toHaveLength(22)
    for (const key of keys) {
      const err = new TeamError(CODE[key])
      expect(isTeamError(err, CODE[key]), key).toBe(true)
      expect(err.message.length, key).toBeGreaterThan(10)
    }
  })
})
