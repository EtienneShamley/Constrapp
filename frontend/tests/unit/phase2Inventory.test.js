import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as sf from '../../functions/src/generated/supplierFinanceCalc.js'
import { READ_PLAN, COUNTERS, parseArgs, decodeValue, scopeOf, messageCode, analyse } from '../../../ops/recovery/phase2-inventory.mjs'

// ── ops/recovery/phase2-inventory.mjs (Phase 2 cutover, Stage A) ─────────────
//
// The operator inventory run READ-ONLY against production before the Phase 2
// cutover (docs/DEPLOYMENT.md → Phase 2 — the complete cutover). It
// is run by hand, never by CI. This suite keeps four things true:
//   · it can only READ (one request kind, no write verb, no SDK)
//   · it can never point the emulator flag at a real project, or read a demo
//     project anywhere but the emulator
//   · its analysis finds what the backend would refuse or mark inconsistent,
//     using the backend's own generated verification functions
//   · it prints ids, counts and codes — never a name, a text or an amount
// It proves nothing about production data.

const here = path.dirname(fileURLToPath(import.meta.url))
const script = readFileSync(path.resolve(here, '../../../ops/recovery/phase2-inventory.mjs'), 'utf8')

// JS → Firestore REST value, as the API returns documents.
const enc = (v) => (v === null ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
    : Number.isInteger(v) ? { integerValue: String(v) }
      : typeof v === 'number' ? { doubleValue: v }
        : typeof v === 'string' ? { stringValue: v }
          : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
            : { mapValue: { fields: encFields(v) } })
const encFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]))
const doc = (p, data = {}) => ({ name: `projects/demo-constrap-test/databases/(default)/documents/${p}`, fields: encFields(data) })

const SECRET = 'Zebra Holdings secret text'
const vline = (o = {}) => ({ costCodeId: 'cc1', costCodeName: SECRET, description: SECRET, submittedAmount: 4321.17, submittedGst: 432.12, approvedAmount: null, approvedGst: null, poLineIndex: 0, taxCode: 'gst', ...o })
const P1 = 'companies/c1/projects/p1'
const P2 = 'companies/c1/projects/p2'
const P3 = 'companies/c1/projects/p3'
const okInvoice = (n) => ({ status: 'posted', invoiceNumber: `SI-000${n}`, subtotal: 100, gstTotal: 10, retention: 0, retentionGst: 0, payableTotal: 110, lineItems: [{ costCodeId: 'cc1', taxCode: 'gst', amount: 100, gstAmount: 10 }] })

function fixture() {
  return {
    companies: [doc('companies/c1', { clientFinanceEnabled: true, clientReceiptsEnabled: true })],
    projects: [doc(P1), doc(P2), doc(P3)],
    approvalPolicy: [],
    counters: [
      doc('companies/c1/counters/variationsSupplier', { next: 2 }), doc('companies/c1/counters/variationsClient', { next: 2 }),
      doc('companies/c1/counters/supplierInvoices', { next: 5 }), doc('companies/c1/counters/supplierPayments', { next: 4 }),
      doc(`${P1}/counters/rfis`, { next: 9 }),
    ],
    costCodes: [doc('companies/c1/costCodes/cc1', { code: '100', name: SECRET })],
    purchaseOrders: [doc(`${P1}/purchaseOrders/po1`, { status: 'sent', lineItems: [{ costCodeId: 'cc1', costCodeName: SECRET, description: SECRET }] })],
    variations: [
      // A legitimate legacy submission: no finding.
      doc(`${P1}/variations/v1`, { status: 'submitted', variationType: 'supplier', poId: 'po1', variationNumber: 'SV-0003', effectiveDate: '', lineItems: [vline()], submittedSubtotal: 4321.17, submittedGst: 432.12, submittedTotal: 4753.29, title: SECRET }),
      // A forged header: refused at approval.
      doc(`${P1}/variations/v2`, { status: 'submitted', variationType: 'supplier', poId: 'po1', variationNumber: 'SV-0001', effectiveDate: '', lineItems: [vline()], submittedSubtotal: 4321.17, submittedGst: 432.12, submittedTotal: 9999.99 }),
      // An unknown calculation version on a draft.
      doc(`${P1}/variations/v3`, { status: 'draft', variationType: 'client', poId: null, calcVersion: 7, variationNumber: 'CV-0001', lineItems: [vline({ poLineIndex: null })] }),
    ],
    progressClaims: [
      doc(`${P1}/progressClaims/k1`, { status: 'draft', poId: 'po1', claimNumber: 'PC-0001', lineItems: [] }),
      doc(`${P1}/progressClaims/k2`, { status: 'submitted', poId: 'po1', claimNumber: 'PC-0001', lineItems: [] }),
      doc(`${P1}/progressClaims/k3`, { status: 'approved', poId: 'po2', claimNumber: 'PC-0002', lineItems: [{ poLineIndex: 0, approvedThisPeriod: 50 }] }),
    ],
    supplierInvoices: [doc(`${P3}/supplierInvoices/i3`, okInvoice(3)), doc(`${P3}/supplierInvoices/i4`, okInvoice(4)), doc(`${P1}/supplierInvoices/i1`, { status: 'posted', invoiceNumber: 'SI-0001', subtotal: 100, gstTotal: 10, retention: 0, retentionGst: 0, payableTotal: 110, lineItems: [{ costCodeId: 'cc1', taxCode: 'gst', amount: 90, gstAmount: 9 }] })],
    supplierCreditNotes: [doc(`${P1}/supplierCreditNotes/n1`, { status: 'posted', supplierInvoiceId: 'i1', subtotal: 10, gstTotal: 1, lineItems: [] })],
    retentionReleases: [],
    supplierPayments: [
      doc(`${P3}/supplierPayments/s3`, { status: 'posted', paymentNumber: 'SP-0003', allocations: [{ supplierInvoiceId: 'i3', allocatedAmount: 50 }, { supplierInvoiceId: 'i4', allocatedAmount: 20 }] }),
      doc(`${P2}/supplierPayments/s1`, { status: 'posted', paymentNumber: 'SP-0001', allocations: [{ supplierInvoiceId: 'missing', allocatedAmount: 10.005 }] }),
    ],
    supplierFinanceState: [doc(`${P2}/supplierFinanceState/baseline`, { state: 'building', leaseUntilMillis: 1000, attempt: 1 }), doc(`${P3}/supplierFinanceState/baseline`, { state: 'complete' })],
    // After activation: one ledger agrees with the registers, one does not; a PO claim ledger names a claim that is not open.
    supplierInvoiceLedgers: [doc(`${P3}/supplierInvoiceLedgers/i3`, { state: 'established', seq: 4, paidCents: 4000, groups: {} }), doc(`${P3}/supplierInvoiceLedgers/i4`, { state: 'established', seq: 1, paidCents: 2000, groups: { 'cc1|gst': { amountCents: 0, gstCents: 0 } } })],
    poClaimLedgers: [doc(`${P3}/poClaimLedgers/po7`, { state: 'established', seq: 1, openClaimIds: ['gone'], approvedPoLineCents: {}, approvedVariationLineCents: {} })],
    clientFinanceState: [doc(`${P1}/clientFinanceState/receiptBaseline`, { version: 1 })],
    clientRefunds: [doc(`${P1}/clientRefunds/r1`, { status: 'posted' })],
    clientReceiptApplications: [], clientReceiptLedgers: [],
    estimates: [], estimateState: [], contractValueRevisions: [],
    commercial: [doc(`${P1}/commercial/baseline`, { originalContractValue: 'abc' })],
  }
}

describe('phase2-inventory — read-only by construction', () => {
  it('sends only collection-group queries (POST :runQuery) and loads no SDK', () => {
    expect(script.match(/fetch\(/g)).toHaveLength(1)
    expect(script).toContain("fetch(`${base}:runQuery`, { method: 'POST', headers, body: JSON.stringify({ structuredQuery }) })")
    expect(script).not.toMatch(/method: '(?!POST')/)
    for (const verb of ["'PATCH'", "'DELETE'", "'PUT'", ':commit', ':batchWrite', ':write', ':beginTransaction', ':restore', 'firebase-admin', 'firebase/firestore', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(script).not.toContain(verb)
    }
    // The only output is the analysis (or its summary), as JSON.
    expect(script.match(/console\.log\(/g)).toHaveLength(1)
    expect(script).toContain('console.log(JSON.stringify(args.summary ? { ...header, summary: result.summary } : { ...header, ...result }, null, 1))')
  })

  it('reads every Phase 2 register it reports on, and projects company documents to their flags', () => {
    for (const g of ['variations', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'retentionReleases', 'supplierPayments', 'clientRefunds', 'clientReceiptApplications', 'clientReceiptLedgers', 'supplierFinanceState', 'estimates', 'counters']) {
      expect(READ_PLAN).toHaveProperty(g)
    }
    expect(READ_PLAN.companies).toEqual(['clientFinanceEnabled', 'clientReceiptsEnabled', 'commercialCompletionEnabled'])
    expect(READ_PLAN.costCodes).toEqual(['__name__'])
    expect(COUNTERS.map(c => c.counter)).toEqual(['variationsClient', 'variationsSupplier', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'retentionReleases', 'supplierPayments', 'clientRefunds', 'clientReceiptApplications'])
  })
})

describe('phase2-inventory — arguments', () => {
  it('requires the project, and never reads a real project through the emulator flag', () => {
    expect(() => parseArgs([])).toThrow('--project is required')
    expect(() => parseArgs(['--project', 'constrapp-69b5d', '--emulator', '127.0.0.1:8080'])).toThrow('only with a demo- project')
    expect(() => parseArgs(['--project', 'demo-constrap-test'])).toThrow('only in the emulator')
    expect(() => parseArgs(['--project', 'demo-constrap-test', '--emulator', 'firestore.googleapis.com:443'])).toThrow('local host:port')
    expect(() => parseArgs(['--project', 'constrapp-69b5d', '--apply'])).toThrow('Unknown argument')
    expect(() => parseArgs(['--project', '--summary'])).toThrow('needs a value')
    expect(parseArgs(['--project', 'constrapp-69b5d', '--company', 'abc', '--summary'])).toEqual({ project: 'constrapp-69b5d', company: 'abc', summary: true })
    expect(parseArgs(['--project', 'demo-constrap-test', '--emulator', '127.0.0.1:8080'])).toEqual({ project: 'demo-constrap-test', emulator: '127.0.0.1:8080' })
  })
})

describe('phase2-inventory — decoding and scope', () => {
  it('decodes REST values as the Admin SDK would', () => {
    expect(decodeValue({ integerValue: '12' })).toBe(12)
    expect(decodeValue({ nullValue: null })).toBeNull()
    expect(decodeValue({ arrayValue: {} })).toEqual([])
    expect(decodeValue({ mapValue: { fields: { a: { doubleValue: 1.5 } } } })).toEqual({ a: 1.5 })
    expect(decodeValue({ timestampValue: '2026-11-28T00:00:00Z' }).toMillis()).toBe(Date.parse('2026-11-28T00:00:00Z'))
  })

  it('places documents by path', () => {
    const at = (p) => scopeOf(`projects/x/databases/(default)/documents/${p}`)
    expect(at('companies/c')).toEqual({ companyId: 'c', projectId: null, collection: 'companies', id: 'c' })
    expect(at('companies/c/counters/progressClaims')).toEqual({ companyId: 'c', projectId: null, collection: 'counters', id: 'progressClaims' })
    expect(at('companies/c/projects/p')).toEqual({ companyId: 'c', projectId: 'p', collection: 'projects', id: 'p' })
    expect(at('companies/c/projects/p/variations/v')).toEqual({ companyId: 'c', projectId: 'p', collection: 'variations', id: 'v' })
    expect(at('users/u')).toBeNull()
  })

  it('reduces every baseline and ledger message of the bundle to a code (no document text survives)', () => {
    const inv = { id: 'i', invoiceNumber: 'SI-1', subtotal: 100, gstTotal: 10, retention: 0, retentionGst: 0, payableTotal: 110, lineItems: [{ costCodeId: 'cc', costCodeName: SECRET, taxCode: 'gst', amount: 100, gstAmount: 10 }] }
    const fromHistory = (h) => sf.supplierLedgersFromHistory({ invoices: new Map([['i', inv]]), ...h })
    const problems = [
      fromHistory({ payments: [{ id: 'p', status: 'posted', allocations: 'x' }] }).problem,
      fromHistory({ payments: [{ id: 'p', status: 'posted', allocations: [{ allocatedAmount: 1 }] }] }).problem,
      fromHistory({ payments: [{ id: 'p', status: 'posted', allocations: [{ supplierInvoiceId: 'i', allocatedAmount: 0.001 }] }] }).problem,
      fromHistory({ creditNotes: [{ id: 'c', status: 'posted' }] }).problem,
      fromHistory({ releases: [{ id: 'r', status: 'posted' }] }).problem,
      fromHistory({ creditNotes: [{ id: 'c', status: 'posted', supplierInvoiceId: 'gone', subtotal: 1 }] }).ledgers.get('gone').problem,
      fromHistory({ creditNotes: [{ id: 'c', status: 'posted', supplierInvoiceId: 'i', subtotal: 200, gstTotal: 20, lineItems: [{ costCodeId: 'cc', taxCode: 'gst', amount: 200, gstAmount: 20 }] }] }).ledgers.get('i').problem,
      fromHistory({ creditNotes: [{ id: 'c', status: 'posted', supplierInvoiceId: 'i', subtotal: 1, gstTotal: 0, lineItems: [{ costCodeId: 'other', taxCode: 'gst', amount: 1, gstAmount: 0 }] }] }).ledgers.get('i').problem,
      fromHistory({ creditNotes: [{ id: 'c', status: 'posted', supplierInvoiceId: 'i', subtotal: -1, lineItems: [] }] }).ledgers.get('i').problem,
      fromHistory({ releases: [{ id: 'r', status: 'posted', supplierInvoiceId: 'i', amount: 5, gstAmount: 0 }] }).ledgers.get('i').problem,
      sf.supplierInvoiceFigures({ ...inv, subtotal: 99 }).problem,
      sf.supplierInvoiceFigures({ ...inv, retention: 200 }).problem,
      sf.supplierInvoiceFigures({ ...inv, payableTotal: 1 }).problem,
      sf.supplierInvoiceFigures({ ...inv, lineItems: [{ amount: 100, gstAmount: 10 }] }).problem,
      sf.poClaimLedgersFromHistory([{ id: 'k', status: 'approved' }]).problem,
      sf.poClaimLedgersFromHistory([{ id: 'k1', poId: 'po', status: 'draft' }, { id: 'k2', poId: 'po', status: 'submitted' }]).ledgers.get('po').problem,
      sf.poClaimLedgersFromHistory([{ id: 'k', poId: 'po', status: 'approved', lineItems: [{ poLineIndex: 0, approvedThisPeriod: 0.001 }] }]).ledgers.get('po').problem,
      sf.poClaimLedgersFromHistory([{ id: 'k', poId: 'po', status: 'approved', lineItems: [{ approvedThisPeriod: 1 }] }]).ledgers.get('po').problem,
    ]
    for (const p of problems) {
      expect(typeof p).toBe('string')
      expect(messageCode(p), p).not.toMatch(/^unclassified-|^unknown$/)
    }
    expect(messageCode('something new')).toMatch(/^unclassified-[0-9a-f]{8}$/)
  })
})

describe('phase2-inventory — analysis', () => {
  const result = analyse(fixture(), { now: 10_000_000 })
  const codes = result.findings.map(f => `${f.severity} ${f.register}/${f.id} ${f.code}${f.reason ? ` ${f.reason}` : ''}`).sort()

  it('finds exactly what the backend would refuse, mark inconsistent or leave for review', () => {
    expect(codes).toEqual([
      'inconsistent poClaimLedgers/po1 supplier-finance-ledger-inconsistent several-open-claims',
      'inconsistent poClaimLedgers/po7 ledger-differs-from-registers openClaimIds',
      'inconsistent supplierInvoiceLedgers/i1 supplier-finance-ledger-inconsistent invoice-totals-not-reconciled',
      'inconsistent supplierInvoiceLedgers/i3 ledger-differs-from-registers paidCents',
      'inconsistent supplierInvoices/i1 supplier-finance-ledger-inconsistent obligation:invoice-totals-not-reconciled',
      'refuse counters/progressClaims counter-absent-while-numbers-exist',
      'refuse counters/variationsSupplier counter-not-above-highest-number',
      'refuse supplierFinanceBaseline/p2 supplier-finance-baseline-invalid payment-allocation-not-positive-whole-cents',
      'refuse supplierPayments/s1 supplier-finance-baseline-invalid payment-allocation-not-positive-whole-cents',
      'refuse variations/v2 variation-figures-inconsistent approve:header',
      'refuse variations/v3 variation-unsupported-record edit:calc-version',
      'review commercial/p1 contract-value-invalid original-contract-value-not-a-number',
      'review progressClaims/k1,k2 duplicate-document-number progressClaims:1',
      'review progressClaims/k3 supplier-finance-legacy-claim invoice-link-key-absent',
      'review supplierFinanceState/p2 supplier-finance-busy baseline-marker-building-expired',
    ])
  })

  it('reports activation, counters, the baseline preview and the settlement registers', () => {
    const c = result.companies[0]
    expect(c.activation).toEqual({ clientFinanceEnabled: true, clientReceiptsEnabled: true, commercialCompletionEnabled: 'absent', approvalPolicy: 'absent' })
    expect(c.counters.find(x => x.counter === 'variationsSupplier')).toEqual({ counter: 'variationsSupplier', next: 2, highest: 3, numbered: 2, unparseable: 0 })
    const [p1, p2, p3] = c.projects
    expect(p3.ledgerReconciliation).toEqual({ compared: true, invoiceLedgers: 2, poClaimLedgers: 1, differing: 2 })
    expect(p1.ledgerReconciliation.compared).toBe(false)
    expect(p1.variations.calcVersion).toEqual({ 'legacy-absent': 2, unknown: 1 })
    expect(p1.supplierBaselinePreview.outcome).toBe('would-establish')
    expect(p2.supplierBaselinePreview).toMatchObject({ outcome: 'would-refuse', refusal: 'supplier-finance-baseline-invalid' })
    expect(p1.clientSettlement).toEqual({ clientRefunds: 1, clientReceiptApplications: 0, clientReceiptLedgers: 0, receiptBaselineMarker: true })
    expect(result.summary).toMatchObject({ companies: 1, projects: 3, ledgersDifferingFromRegisters: 2, clientRefunds: 1, supplierBaselinesWouldRefuse: 1, documentsOutsideScope: 1 })
  })

  it('prints no name, text, amount or document number from any document', () => {
    const out = JSON.stringify(result)
    for (const leaked of [SECRET, 'Zebra', '4321', '4753', '9999', '432.12', 'SV-0003', 'PC-0001', 'SI-0001']) expect(out).not.toContain(leaked)
  })

  it('restricts the report to one company when asked, and to nothing for an unknown one', () => {
    expect(analyse(fixture(), { now: 0, company: 'c1' }).companies).toHaveLength(1)
    expect(analyse(fixture(), { now: 0, company: 'other' }).companies).toHaveLength(0)
  })
})

describe('phase2-inventory — Stage A additions (architect decisions D3 #53 / #54)', () => {
  const Q = 'companies/c9/projects/q1'
  const long = (n) => 'L'.repeat(n)
  const docs = {
    companies: [doc('companies/c9', {})],
    projects: [doc(Q)],
    boqItems: [
      doc(`${Q}/boqItems/b1`, { status: 'active', description: long(1001), section: 'S', costCodeName: SECRET, itemNumber: '1', unit: 'm', costCodeId: 'cc1' }),
      doc(`${Q}/boqItems/b2`, { status: 'active', description: SECRET, section: 'S', costCodeName: 'C', itemNumber: '2', unit: long(41), costCodeId: 'cc1' }),
      doc(`${Q}/boqItems/b3`, { status: 'void', description: long(5000), section: 'S', costCodeName: 'C', itemNumber: '3', unit: 'm', costCodeId: 'cc1' }),
      doc(`${Q}/boqItems/b4`, { status: 'active', description: long(1000), section: long(200), costCodeName: long(200), itemNumber: long(40), unit: 'm', costCodeId: 'cc1' }),
    ],
    budgetLines: [doc(`${Q}/budgetLines/l1`, { boqSource: { latest: { estimate: { estimateId: 'e1' } } } }), doc(`${Q}/budgetLines/l2`, { boqSource: { latest: { amount: 5 } } })],
    purchaseOrders: [
      doc(`${Q}/purchaseOrders/po1`, { status: 'draft' }),
      doc(`${Q}/purchaseOrders/po2`, { status: 'pending_approval' }),
      doc(`${Q}/purchaseOrders/po3`, { status: 'draft', lastMaterialEditBy: 'u1' }),
      doc(`${Q}/purchaseOrders/po4`, { status: 'sent' }),
    ],
    tenderPackages: [doc(`${Q}/tenderPackages/t1`, { status: 'issued' }), doc(`${Q}/tenderPackages/t2`, { status: 'awarded' })],
  }
  const result = analyse(docs, { now: 1 })
  const codes = result.findings.map(f => `${f.register}/${f.id} ${f.code}${f.reason ? ` ${f.reason}` : ''}`).sort()

  it('names over-long BOQ text (never prints it), key text over its bound, estimate provenance on a budget line, and open documents with no recorded preparer', () => {
    expect(codes).toEqual([
      'boqItems/b1 boq-text-over-estimate-bound description',
      'boqItems/b2 boq-key-over-estimate-bound',
      'budgetLines/l1 budget-line-estimate-provenance-unexpected',
      'purchaseOrders/po1 po-preparer-unrecorded draft',
      'purchaseOrders/po2 po-preparer-unrecorded pending_approval',
      'tenderPackages/t1 tender-preparer-unrecorded issued',
    ])
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(long(1001))
    expect(result.companies[0].projects[0]).toMatchObject({ boq: { active: 3, overItemLimit: false, textOverBound: 1, keyOverBound: 1 }, budgetLinesWithEstimateProvenance: 1, openDocumentsWithUnrecordedPreparer: 3 })
  })

  it('reads the new registers with field projections only', () => {
    expect(READ_PLAN.boqItems).toEqual(['status', 'itemNumber', 'section', 'description', 'costCodeName', 'unit', 'costCodeId'])
    expect(READ_PLAN.tenderPackages).toEqual(['status', 'lastMaterialEditBy'])
    expect(READ_PLAN.budgetLines).toEqual(['boqSource'])
    expect(READ_PLAN.purchaseOrders).toContain('lastMaterialEditBy')
  })
})
