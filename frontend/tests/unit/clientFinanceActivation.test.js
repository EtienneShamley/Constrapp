import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  clientFinanceActivated, retentionToSave, clientFinanceTabs, showClientFinanceRecords,
  CLIENT_FINANCE_NOT_ACTIVATED_TEXT,
} from '../../src/lib/clientFinanceActivation'

// ── Client finance activation — the browser's reflection of a company flag ───
//
// UX only: Firestore Rules and the backend enforce the activation (their own
// suites prove that). What is proved here is that the browser reads the flag
// strictly, never offers retention or credit-note / release creation to a
// company without it, and never treats a loading or unreadable company as
// activated. The unit runner has no DOM, so the page wiring is pinned as
// source contracts (the same approach as the printed credit note).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('clientFinanceActivated — strict', () => {
  it('is true only for the boolean true', () => {
    expect(clientFinanceActivated({ id: 'c1', clientFinanceEnabled: true })).toBe(true)
  })

  it('is false for a company that is loading, unreadable or missing', () => {
    expect(clientFinanceActivated(undefined)).toBe(false)
    expect(clientFinanceActivated(null)).toBe(false)
  })

  it('is false for every other value, and for a missing field', () => {
    for (const v of ['true', 1, false, 0, '', null, undefined, {}, [], 'yes']) {
      expect(clientFinanceActivated({ clientFinanceEnabled: v }), String(v)).toBe(false)
    }
    expect(clientFinanceActivated({})).toBe(false)
    expect(clientFinanceActivated({ id: 'c1', name: 'Acme' })).toBe(false)
  })

  it('states the unavailability in one fixed sentence', () => {
    expect(CLIENT_FINANCE_NOT_ACTIVATED_TEXT)
      .toBe('Client credit notes and client retention are not yet available for this company.')
  })
})

describe('retentionToSave', () => {
  it('saves the authored amount for an activated company', () => {
    expect(retentionToSave(true, 500)).toBe(500)
    expect(retentionToSave(true, 0)).toBe(0)
    expect(retentionToSave(true, 12.34)).toBe(12.34)
  })

  it('always saves zero for a company that is not activated', () => {
    for (const activated of [false, undefined, null, 'true', 1]) {
      expect(retentionToSave(activated, 500), String(activated)).toBe(0)
    }
  })
})

describe('clientFinanceTabs', () => {
  const tabs = [
    { to: '.', label: 'Margin' },
    { to: 'client-retention', label: 'Client Retention', clientFinance: true },
    { to: 'final-account', label: 'Final Account' },
  ]

  it('returns every tab, untouched, for an activated company', () => {
    expect(clientFinanceTabs(tabs, true)).toEqual(tabs)
  })

  it('drops only the flagged tabs otherwise, keeping the order', () => {
    for (const activated of [false, undefined, null, 'true', 1]) {
      expect(clientFinanceTabs(tabs, activated).map(t => t.to), String(activated)).toEqual(['.', 'final-account'])
    }
  })
})

describe('showClientFinanceRecords', () => {
  it('always shows the section to an activated company', () => {
    expect(showClientFinanceRecords(true, 0)).toBe(true)
    expect(showClientFinanceRecords(true, 3)).toBe(true)
  })

  it('shows it to any other company only when records exist — never hides them', () => {
    expect(showClientFinanceRecords(false, 0)).toBe(false)
    expect(showClientFinanceRecords(false, 1)).toBe(true)
    expect(showClientFinanceRecords(undefined, 0)).toBe(false)
  })
})

describe('the Commercial sub-navigation (source contract)', () => {
  const layout = stripComments(read('layouts/ProjectCommercialLayout.jsx'))

  it('flags Client Retention — and only Client Retention — as a client-finance tab', () => {
    expect(layout).toContain("{ to: 'client-retention',  label: 'Client Retention',  end: false, clientFinance: true }")
    expect(layout.match(/clientFinance: true/g)).toHaveLength(1)
  })

  it('renders the filtered list, derived from the company document', () => {
    expect(layout).toContain('const { company } = useCompany()')
    expect(layout).toContain('const tabs = clientFinanceTabs(SUB_TABS, clientFinanceActivated(company))')
    expect(layout).toContain('{tabs.map(({ to, label, end }) => (')
    expect(layout).not.toContain('SUB_TABS.map(')
  })
})

describe('the Client Retention route (source contract)', () => {
  const page = stripComments(read('pages/project/ProjectClientRetention.jsx'))
  const gate = page.slice(
    page.indexOf('export default function ProjectClientRetention()'),
    page.indexOf('function ClientRetentionRegister()'),
  )

  it('waits for the profile and the company before deciding — loading is never activated', () => {
    expect(gate).toContain('const { company, companyLoading } = useCompany()')
    expect(gate).toContain('if (profileLoading || companyLoading) {')
    expect(gate.indexOf('companyLoading) {')).toBeLessThan(gate.indexOf('clientFinanceActivated(company)'))
  })

  it('shows the fixed sentence and no action to a company that is not activated', () => {
    expect(gate).toContain('if (!clientFinanceActivated(company)) {')
    expect(gate).toContain('{CLIENT_FINANCE_NOT_ACTIVATED_TEXT}')
    expect(gate).not.toMatch(/<Btn|onClick|navigate\(/)
  })

  it('mounts the register — and its reads and writes — only past the gate', () => {
    expect(gate).toContain('return <ClientRetentionRegister />')
    expect(gate).not.toMatch(/useClient(Invoices|Receipts|CreditNotes|RetentionReleases|InvoiceLedgers)\(/)
    expect(page.match(/<ClientRetentionRegister \/>/g)).toHaveLength(1)
  })
})

describe('the Client Invoices page (source contract)', () => {
  const page = stripComments(read('pages/project/ProjectClientInvoices.jsx'))
  const editor = page.slice(page.indexOf('function InvoiceEditorModal('), page.indexOf('function VoidModal('))

  it('derives the activation once, strictly, from the company document', () => {
    expect(page).toContain('const financeActive = clientFinanceActivated(company)')
    expect(page.match(/clientFinanceActivated\(/g)).toHaveLength(1)
    expect(page).not.toMatch(/clientFinanceEnabled/)
  })

  it('the editor offers no retention input and saves zero retention when not activated', () => {
    expect(page).toMatch(/<InvoiceEditorModal[\s\S]*?financeActive=\{financeActive\}/)
    expect(editor).toContain('const retentionInput = !financeActive')
    expect(editor).toContain("retentionToSave(financeActive, retentionInput === '' ? 0 : Number(retentionInput))")
    expect(editor).toContain('retention: retentionAmount,')
    // Both inputs sit inside the one activated-only block.
    const block = editor.slice(editor.indexOf('{financeActive && (\n        <div className="rounded-lg border'))
    expect(block).toContain('id="ci-retention"')
    expect(block).toContain('id="ci-retention-pct"')
    expect(editor.slice(0, editor.indexOf('{financeActive && (\n        <div className="rounded-lg border')))
      .not.toMatch(/id="ci-retention/)
  })

  it('a stored retention amount is stated, never silently dropped', () => {
    expect(editor).toContain('const storedRetentionDropped = !financeActive && hasRetention(invoice)')
    expect(editor).toContain('{storedRetentionDropped && (')
  })

  it('offers credit-note creation, editing and posting to an activated company only', () => {
    const record = page.slice(page.lastIndexOf('{isIssued', page.indexOf('Record credit note')), page.indexOf('Record credit note'))
    expect(record.startsWith('{isIssued && financeActive && (')).toBe(true)
    expect(page).toContain('{isDraft && financeActive && (')
    expect(page).not.toContain('{isDraft && (')
  })

  it('never hides existing credit notes, and shows no empty register when not activated', () => {
    expect(page).toContain('{(clientCreditNotesError || showClientFinanceRecords(financeActive, sortedCreditNotes.length)) && (')
    expect(page).toContain('{isIssued && (creditsUnknown || showClientFinanceRecords(financeActive, creditNotes.length)) && (')
  })

  it('links to the Client Retention register only for an activated company', () => {
    expect(page).toContain('{isIssued && financeActive && hasRetention(inv) && (')
    expect(page).toMatch(/\{financeActive && \(\s*<Btn sm variant="ghost" type="button" onClick=\{onOpenRetention\}>/)
  })
})
