import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildClientCreditNotePrint,
  CLIENT_CREDIT_NOTE_PRINT_TITLE, CLIENT_CREDIT_NOTE_PRINT_DISCLAIMER, CLIENT_CREDIT_NOTE_STATUS_NOTICE,
} from '../../src/pages/project/clientCredit/clientCreditNotePrintModel'
import {
  CLIENT_RECONCILIATION_LABELS, OWED_TO_CLIENT_LABEL, OWED_TO_CLIENT_REMEDY,
  clientReconciliationLabel, isOwedToClient, owedToClientDescription,
} from '../../src/pages/project/clientCredit/clientReconciliation'
import { CCN_STATUS } from '../../src/lib/clientCreditNotes'
import { TAX_CODE, TAX_CODE_LABELS } from '../../src/lib/clientInvoices'
import { RECONCILIATION_STATE, RECONCILIATION_LABELS } from '../../src/lib/payments'

// ── Printed Client Credit Note — the model, and the client-side wording ──────
//
// The unit runner is plain Node with no DOM and no print engine, so the model
// is tested as data and the component / stylesheet / page wiring as source
// contracts (the same approach as the programme report, ADR-79).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis: () => seconds * 1000, toDate: () => new Date(seconds * 1000) })

// Deliberately INCONSISTENT stored totals: 100 + 250 is not 999.99, and the
// GST is not 10%. A model that re-added or re-derived anything would not
// reproduce these figures.
const creditNote = (overrides = {}) => ({
  id: 'cn1',
  creditNumber: 'CCN-0001',
  status: CCN_STATUS.POSTED,
  clientInvoiceId: 'inv1',
  invoiceNumber: 'CI-0007',
  clientName: 'Harbour Developments Pty Ltd',
  creditDate: '2026-11-20',
  reason: 'Duplicate claim for level 2 slab',
  clientCreditReference: 'Xero CN-0012',
  currency: 'AUD',
  lineItems: [
    { invoiceLineIndex: 0, description: 'Level 2 slab', taxCode: TAX_CODE.GST, amount: 100, gstAmount: 7.77, variationNumber: 'VAR-0003' },
    { invoiceLineIndex: 2, description: 'Bank guarantee fee', taxCode: TAX_CODE.GST_FREE, amount: 250, gstAmount: 0, variationNumber: '' },
  ],
  subtotal: 999.99,
  gstTotal: 12.34,
  grossTotal: 5555.55,
  retentionAmount: 40,
  retentionGst: 1.11,
  retentionTotal: 41.5,
  receivableTotal: 77.7,
  postedAt: ts(1795000000), postedBy: 'uid-poster',
  voidedAt: null, voidedBy: null, voidReason: '',
  ...overrides,
})
const invoice = { id: 'inv1', invoiceNumber: 'CI-0007', invoiceDate: '2026-10-31' }

const build = (overrides, extra = {}) =>
  buildClientCreditNotePrint({ creditNote: creditNote(overrides), invoice, projectName: 'Riverside Stage 2', ...extra })

const allText = (doc) => JSON.stringify(doc)

describe('the document heading and its labels', () => {
  it('is headed "Credit Note" with its number, status, date, project, client and the invoice it corrects', () => {
    const doc = build()
    expect(CLIENT_CREDIT_NOTE_PRINT_TITLE).toBe('Credit Note')
    expect(doc.title).toBe('Credit Note')
    expect(doc.number).toBe('CCN-0001')
    expect(doc.projectName).toBe('Riverside Stage 2')
    expect(doc.statusLabel).toBe('Posted')
    expect(doc.creditDate).toBe('2026-11-20')
    expect(doc.clientName).toBe('Harbour Developments Pty Ltd')
    expect(doc.invoice).toEqual({ number: 'CI-0007', date: '2026-10-31' })
    expect(doc.reason).toBe('Duplicate claim for level 2 slab')
    expect(doc.externalReference).toBe('Xero CN-0012')
    expect(doc.currencyCode).toBe('AUD')
  })

  it('lists each line with its description, tax code LABEL, amount ex-GST and GST as stored', () => {
    const doc = build()
    expect(doc.lines).toEqual([
      { key: 0, description: 'Level 2 slab', variationNumber: 'VAR-0003', taxLabel: TAX_CODE_LABELS[TAX_CODE.GST], amount: 100, gstAmount: 7.77 },
      { key: 1, description: 'Bank guarantee fee', variationNumber: null, taxLabel: TAX_CODE_LABELS[TAX_CODE.GST_FREE], amount: 250, gstAmount: 0 },
    ])
  })

  it('an unknown tax code is shown as stored, never silently relabelled', () => {
    const doc = build({ lineItems: [{ description: 'x', taxCode: 'something_else', amount: 1, gstAmount: 0 }] })
    expect(doc.lines[0].taxLabel).toBe('something_else')
  })
})

describe('totals are the STORED fields — the model does no arithmetic', () => {
  it('passes subtotal, GST and credit total through unchanged, even when they do not add up', () => {
    const doc = build()
    expect(doc.totals).toEqual([
      { key: 'subtotal',   label: 'Subtotal (ex-GST)',       amount: 999.99 },
      { key: 'gstTotal',   label: 'GST reversed',            amount: 12.34 },
      { key: 'grossTotal', label: 'Credit total (inc. GST)', amount: 5555.55, strong: true },
    ])
  })

  it('passes the retention split through unchanged', () => {
    expect(build().retentionSplit).toEqual([
      { key: 'retentionTotal',  label: 'Reduces retention held',    amount: 41.5 },
      { key: 'receivableTotal', label: 'Reduces amount receivable', amount: 77.7 },
    ])
  })

  it('a missing stored amount is absent (null), never a computed or zero figure', () => {
    const doc = build({ subtotal: undefined, grossTotal: 'abc', lineItems: [{ description: 'x', taxCode: TAX_CODE.GST }] })
    expect(doc.totals.find(t => t.key === 'subtotal').amount).toBeNull()
    expect(doc.totals.find(t => t.key === 'grossTotal').amount).toBeNull()
    expect(doc.lines[0].amount).toBeNull()
    expect(doc.lines[0].gstAmount).toBeNull()
  })

  it('the module source contains no arithmetic on amounts and imports no money maths', () => {
    const src = stripComments(read('pages/project/clientCredit/clientCreditNotePrintModel.js'))
    expect(src).not.toMatch(/roundMoney|toCents|fromCents|reduce\(|Math\./)
    expect(src).not.toMatch(/amount\([^)]*\)\s*[-+*/]/)
    // The only "+" in the module is `i + 1` (a line's ordinal) and string joins.
    expect(src).not.toMatch(/(subtotal|gstTotal|grossTotal|retentionTotal|receivableTotal|gstAmount)\s*[-+*/]\s*\w/)
    expect(src).not.toMatch(/^import .*(react|firebase|hooks\/)/m)
  })
})

describe('the retention split is shown only when non-zero', () => {
  it.each([[0], [undefined], [null]])('retentionTotal %s → no split', (retentionTotal) => {
    expect(build({ retentionTotal, retentionAmount: 0, retentionGst: 0 }).retentionSplit).toBeNull()
  })
  it('a non-zero retention part → both rows', () => {
    expect(build({ retentionTotal: 0.01 }).retentionSplit).toHaveLength(2)
  })
})

describe('a draft or a void credit note is marked in words', () => {
  it('posted: no warning notice, and a posted stamp', () => {
    const doc = build()
    expect(doc.statusNotice).toBeNull()
    expect(doc.posted.at.seconds).toBe(1795000000)
    expect(doc.voided).toBeNull()
  })

  it('draft: says DRAFT and NOT POSTED, and carries no posted stamp', () => {
    const doc = build({ status: CCN_STATUS.DRAFT, postedAt: null, postedBy: null })
    expect(doc.statusLabel).toBe('Draft')
    expect(doc.statusNotice).toBe(CLIENT_CREDIT_NOTE_STATUS_NOTICE[CCN_STATUS.DRAFT])
    expect(doc.statusNotice).toMatch(/DRAFT/)
    expect(doc.statusNotice).toMatch(/NOT POSTED/)
    expect(doc.posted).toBeNull()
    expect(doc.voided).toBeNull()
  })

  it('void after posting: says VOID, with the void reason and date and the earlier posted stamp', () => {
    const doc = build({ status: CCN_STATUS.VOID, voidReason: ' Raised against the wrong invoice ', voidedAt: ts(1795100000), voidedBy: 'uid-voider' })
    expect(doc.statusLabel).toBe('Void')
    expect(doc.statusNotice).toMatch(/^VOID\b/)
    expect(doc.voided.reason).toBe('Raised against the wrong invoice')
    expect(doc.voided.at.seconds).toBe(1795100000)
    expect(doc.posted.at.seconds).toBe(1795000000)
  })

  it('a draft that was voided was never posted', () => {
    const doc = build({ status: CCN_STATUS.VOID, postedAt: null, postedBy: null, voidReason: 'Not needed', voidedAt: ts(5) })
    expect(doc.posted).toBeNull()
    expect(doc.voided.reason).toBe('Not needed')
  })
})

describe('who posted it', () => {
  it('uses a name stored on the credit note first, then the page-supplied map, else none', () => {
    expect(build({ postedByName: 'Priya Nair' }, { people: { 'uid-poster': 'Someone Else' } }).posted.byName).toBe('Priya Nair')
    expect(build({}, { people: { 'uid-poster': 'Sam Okafor' } }).posted.byName).toBe('Sam Okafor')
    expect(build({}, { people: { 'another-uid': 'Sam Okafor' } }).posted.byName).toBeNull()
    expect(build().posted.byName).toBeNull()
  })
  it('never prints a uid as a name', () => {
    expect(allText(build())).not.toContain('uid-poster')
  })
})

describe('absent optional fields', () => {
  it('no external reference, no invoice record, no project name, no lines', () => {
    const doc = buildClientCreditNotePrint({
      creditNote: creditNote({ clientCreditReference: '', lineItems: undefined, reason: '   ', clientName: '' }),
    })
    expect(doc.externalReference).toBeNull()
    expect(doc.invoice).toEqual({ number: 'CI-0007', date: null })
    expect(doc.projectName).toBe('')
    expect(doc.lines).toEqual([])
    expect(doc.reason).toBeNull()
    expect(doc.clientName).toBeNull()
  })
  it('a line with no description is named by its position', () => {
    expect(build({ lineItems: [{ taxCode: TAX_CODE.GST, amount: 1, gstAmount: 0.1 }] }).lines[0].description).toBe('Line 1')
  })
  it('no credit note → no document', () => {
    expect(buildClientCreditNotePrint({ creditNote: null })).toBeNull()
    expect(buildClientCreditNotePrint()).toBeNull()
  })
})

describe('what the document is, and is not', () => {
  const FORBIDDEN = [/tax invoice/i, /adjustment note/i, /recipient[- ]created/i]

  it('carries one plain line that it is a Constrap record and not a tax document', () => {
    for (const status of Object.values(CCN_STATUS)) {
      const doc = build({ status })
      expect(doc.disclaimer).toBe(CLIENT_CREDIT_NOTE_PRINT_DISCLAIMER)
      expect(doc.disclaimer).toMatch(/record produced from Constrap/)
      expect(doc.disclaimer).toMatch(/not a tax document/)
    }
  })

  it('the model never says "Tax Invoice", "Adjustment Note" or "Recipient Created"', () => {
    for (const status of Object.values(CCN_STATUS)) {
      const text = allText(build({ status, voidReason: 'x' }))
      for (const re of FORBIDDEN) expect(text).not.toMatch(re)
    }
  })

  it('nor does the model, the print component or the detail dialog source — comments included', () => {
    for (const f of ['clientCreditNotePrintModel.js', 'ClientCreditNotePrint.jsx', 'ClientCreditDetailModal.jsx']) {
      const src = read(`pages/project/clientCredit/${f}`)
      for (const re of FORBIDDEN) expect(src, f).not.toMatch(re)
    }
  })
})

describe('the print component and its page wiring (source contracts)', () => {
  const component = stripComments(read('pages/project/clientCredit/ClientCreditNotePrint.jsx'))
  const page = stripComments(read('pages/project/ProjectClientInvoices.jsx'))
  const css = read('index.css')

  it('is a print-only report document that formats money and dates through the existing formatters', () => {
    expect(component).toContain('<article className="commercial-report credit-note-print flex-col gap-4"')
    expect(component).toContain('formatCurrency(n, doc.currencyCode || currencyCode, { precise: true })')
    expect(component).toMatch(/import \{ formatCurrency, formatDate \} from '..\/..\/..\/lib\/formatters'/)
    expect(component).toMatch(/import \{ formatIsoDate \} from '..\/..\/..\/lib\/projectTimeline'/)
    expect(component).not.toMatch(/toFixed|Intl\.NumberFormat|#[0-9a-fA-F]{3,6}\b/)
    expect(component).not.toMatch(/use[A-Z]\w*\(|firebase/)
    expect(component).toContain('{doc.statusNotice}')
    expect(component).toContain('{doc.disclaimer}')
  })

  it('is hidden on screen and printed on its own A4 portrait page, with no colour of its own', () => {
    expect(css).toMatch(/^\.commercial-report\.credit-note-print \{ display: none; \}$/m)
    expect(css).toContain('@page credit-note { size: A4 portrait; margin: 14mm; }')
    expect(css).toMatch(/\.commercial-report\.credit-note-print \{ display: flex !important; page: credit-note; \}/)
    const block = css.slice(css.indexOf('.commercial-report.credit-note-print { display: none; }'))
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })

  it('the page mounts it only while printing a chosen credit note and hides everything else', () => {
    expect(page).toContain('const { printAt, print } = usePrintMoment()')
    expect(page).toMatch(/const printCredit = printAt && printTargetId \?/)
    expect(page).toContain('{printCredit && (')
    expect(page).toContain('<div data-print-hide>')
    expect(page).toContain("window.addEventListener('afterprint', forget)")
    expect(page).toContain('onClick={() => printCreditNote(cn)}')
    expect(page).toContain('onPrint={() => printCreditNote(creditDetail)}')
  })
})

describe('client-side reconciliation wording', () => {
  it('a negative client balance is "Owed to client"; the other states keep their labels', () => {
    expect(OWED_TO_CLIENT_LABEL).toBe('Owed to client')
    expect(clientReconciliationLabel(RECONCILIATION_STATE.OVER)).toBe('Owed to client')
    for (const s of [RECONCILIATION_STATE.UNRECONCILED, RECONCILIATION_STATE.PARTLY, RECONCILIATION_STATE.FULLY]) {
      expect(clientReconciliationLabel(s)).toBe(RECONCILIATION_LABELS[s])
    }
    expect(Object.values(CLIENT_RECONCILIATION_LABELS).join(' ')).not.toMatch(/over-?reconcil/i)
    expect(isOwedToClient(RECONCILIATION_STATE.OVER)).toBe(true)
    expect(isOwedToClient(RECONCILIATION_STATE.FULLY)).toBe(false)
  })

  it('the shared supplier-side label is untouched', () => {
    expect(RECONCILIATION_LABELS[RECONCILIATION_STATE.OVER]).toBe('Over-reconciled')
  })

  it('the description names the amount, says it is not settled and states the remedy', () => {
    const text = owedToClientDescription('$110.00')
    expect(text).toContain('Owed to client $110.00')
    expect(text).toContain('It is not settled.')
    expect(text).toContain(OWED_TO_CLIENT_REMEDY)
    expect(OWED_TO_CLIENT_REMEDY).toMatch(/void the receipt and re-record it with the surplus unallocated/)
    expect(OWED_TO_CLIENT_REMEDY).toMatch(/no refund/)
  })

  it('no client page shows the supplier-side wording or the shared label map', () => {
    const files = [
      'pages/project/ProjectClientInvoices.jsx', 'pages/project/ProjectClientReceipts.jsx',
      'pages/project/ProjectClientRetention.jsx',
      'pages/project/clientCredit/ClientCreditNoteModal.jsx', 'pages/project/clientCredit/ClientCreditPostModal.jsx',
      'pages/project/clientCredit/ClientCreditVoidModal.jsx', 'pages/project/clientCredit/ClientCreditDetailModal.jsx',
      'pages/project/clientCredit/ClientCreditNotePrint.jsx',
      'pages/project/clientRetention/ClientReleaseModal.jsx', 'pages/project/clientRetention/ClientReleasePostModal.jsx',
      'pages/project/clientRetention/ClientReleaseVoidModal.jsx',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, f).not.toMatch(/over-?reconcil/i)
      expect(src, f).not.toMatch(/\bRECONCILIATION_LABELS\b/)
    }
  })
})

describe('the Post dialogs react to a stale-draft refusal coming back from the write', () => {
  for (const f of ['pages/project/clientCredit/ClientCreditPostModal.jsx', 'pages/project/clientRetention/ClientReleasePostModal.jsx']) {
    it(`${f}: offers Refresh figures for the pre-check AND for the write's own message`, () => {
      const src = stripComments(read(f))
      expect(src).toContain('write.message === CLIENT_ENTRY_STALE_TEXT')
      expect(src).toContain('const stale = blocked === CLIENT_ENTRY_STALE_TEXT || refusedStale')
      expect(src).toContain('disabled={write.locked || !!blocked || refusedStale}')
      expect(src).toContain('<WriteFeedback write={write} />')
    })
  }
})
