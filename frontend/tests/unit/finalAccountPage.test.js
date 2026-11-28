import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readyProject, sourcesOf } from '../fixtures/finalAccountProject'
import { issuedInvoice, creditNoteFor } from '../fixtures/clientReceivableDocs'
import { computeFinalAccount, settledSourceStates, finalAccountContent, FINAL_ACCOUNT_DISCLAIMER } from '../../src/lib/finalAccount'

// ── The Final Account PAGE — static render smoke (ADR-77) ────────────────────
//
// No DOM and no Firebase: every hook the page calls is replaced by a stub that
// returns fixture data, and the whole page is rendered with react-dom/server.
// A broken prop contract, an undefined variable or a crash in one of the
// page's states (restricted, loading, nothing prepared, not ready, draft,
// approved, approved-with-drift, superseded, unavailable) fails here rather
// than in the browser. Interaction (dialogs opening, focus, print) is NOT
// covered — see TESTING.md §62 manual acceptance.

const S = vi.hoisted(() => ({ role: 'project_manager', uid: 'u_pm', data: null, accounts: [], accountsError: false, loading: false, failInvoices: false, failCredits: false }))

vi.mock('react-router-dom', () => ({ useOutletContext: () => ({ project: { id: 'p1', name: 'Harbour Road Units' }, projectId: 'p1', currencyCode: 'AUD' }) }))
vi.mock('../../src/lib/fileBlob', () => ({ saveBlob: () => {} }))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: S.uid } }) }))
vi.mock('../../src/hooks/useProfile', () => ({ useProfile: () => ({ profile: { role: S.role, name: 'Pat PM' }, profileLoading: false }) }))
const list = (name, key = name) => ({ [name]: S.loading ? [] : S.data[key], [`${name}Loading`]: S.loading, [`${name}Error`]: false })
vi.mock('../../src/hooks/useBudgetLines', () => ({ useBudgetLines: () => list('budgetLines') }))
vi.mock('../../src/hooks/useApprovedBudget', () => ({ useApprovedBudget: () => ({ approvedBudget: S.loading ? { pointerLoading: true } : S.data.approvedBudget }) }))
vi.mock('../../src/hooks/useCostCodes', () => ({ useCostCodes: () => list('costCodes') }))
vi.mock('../../src/hooks/usePurchaseOrders', () => ({ usePurchaseOrders: () => list('purchaseOrders') }))
vi.mock('../../src/hooks/useProgressClaims', () => ({ useProgressClaims: () => list('progressClaims') }))
vi.mock('../../src/hooks/useSupplierInvoices', () => ({ useSupplierInvoices: () => (S.failInvoices ? { supplierInvoices: [], supplierInvoicesLoading: false, supplierInvoicesError: true } : list('supplierInvoices')) }))
vi.mock('../../src/hooks/useSupplierCreditNotes', () => ({ useSupplierCreditNotes: () => list('supplierCreditNotes') }))
vi.mock('../../src/hooks/useVariations', () => ({ useVariations: () => list('variations') }))
vi.mock('../../src/hooks/useForecastLines', () => ({ useForecastLines: () => list('forecastLines') }))
vi.mock('../../src/hooks/useProjectCommercial', () => ({ useProjectCommercial: () => ({ baseline: S.loading ? null : S.data.baseline, baselineLoading: S.loading, baselineError: false }) }))
vi.mock('../../src/hooks/useSupplierPayments', () => ({ useSupplierPayments: () => list('supplierPayments') }))
vi.mock('../../src/hooks/useRetentionReleases', () => ({ useRetentionReleases: () => list('retentionReleases') }))
vi.mock('../../src/hooks/useClientInvoices', () => ({ useClientInvoices: () => list('clientInvoices') }))
vi.mock('../../src/hooks/useClientReceipts', () => ({ useClientReceipts: () => list('clientReceipts') }))
vi.mock('../../src/hooks/useClientCreditNotes', () => ({ useClientCreditNotes: () => (S.failCredits ? { clientCreditNotes: [], clientCreditNotesLoading: false, clientCreditNotesError: true } : list('clientCreditNotes')) }))
vi.mock('../../src/hooks/useClientRetentionReleases', () => ({ useClientRetentionReleases: () => list('clientRetentionReleases') }))
// Phase 2 step 5: the two settlement registers (refunds, receipt applications).
vi.mock('../../src/hooks/useClientRefunds', () => ({ useClientRefunds: () => list('clientRefunds') }))
vi.mock('../../src/hooks/useClientReceiptApplications', () => ({ useClientReceiptApplications: () => list('clientReceiptApplications') }))
vi.mock('../../src/hooks/useFinalAccounts', () => ({
  useFinalAccounts: () => ({
    finalAccounts: S.accountsError ? [] : S.accounts, finalAccountsLoading: false, finalAccountsError: S.accountsError,
    prepareFinalAccount: async () => ({ number: 1 }), withdrawFinalAccount: async () => 2, approveFinalAccount: async () => ({}),
  }),
}))

const { default: ProjectFinalAccount } = await import('../../src/pages/project/ProjectFinalAccount')

const ts = (s) => ({ seconds: s, nanoseconds: 0, toDate: () => new Date(s * 1000), toMillis: () => s * 1000 })
const content = () => finalAccountContent(computeFinalAccount({ project: { id: 'p1' }, currencyCode: 'AUD', sources: sourcesOf(readyProject()), sourceStates: settledSourceStates() }))
const revision = (number, status, over = {}) => ({
  id: String(number), number, status, revision: status === 'draft' ? 1 : 2, reason: 'Works complete', reference: 'FA-1', currency: 'AUD',
  ...content(), openItemsAcknowledged: true, preparedByName: 'Quin QS',
  approvedAt: status === 'approved' ? ts(1_763_000_000) : null, approvedBy: status === 'approved' ? 'u_pm' : null,
  approvedByName: status === 'approved' ? 'Pat PM' : null, approvedByRole: status === 'approved' ? 'project_manager' : null,
  selfApproved: status === 'approved' ? false : null, sourcesReadAt: status === 'approved' ? ts(1_763_000_000) : null,
  withdrawnAt: status === 'withdrawn' ? ts(1_763_000_500) : null, withdrawnBy: status === 'withdrawn' ? 'u_qs' : null, withdrawReason: status === 'withdrawn' ? 'Late invoice' : '',
  createdAt: ts(1_762_000_000), createdBy: 'u_qs', updatedAt: ts(1_763_000_000), updatedBy: 'u_qs', ...over,
})
const render = () => renderToStaticMarkup(h(ProjectFinalAccount))
const use = (mutate = (p) => p) => { const p = readyProject(); mutate(p); S.data = sourcesOf(p) }

beforeEach(() => { Object.assign(S, { role: 'project_manager', uid: 'u_pm', accounts: [], accountsError: false, loading: false, failInvoices: false, failCredits: false }); use() })

describe('ProjectFinalAccount renders every state', () => {
  it('a non-financial role sees the restricted notice and no figure', () => {
    for (const role of ['subcontractor', 'client', undefined]) {
      S.role = role
      const html = render()
      expect(html).toContain('Final Account is restricted')
      expect(html).not.toContain('$')
    }
  })

  it('nothing prepared, records ready: the checklist is all Met and Prepare is enabled', () => {
    const html = render()
    expect(html).toContain('No Final Account has been prepared for this project.')
    expect(html).toContain(FINAL_ACCOUNT_DISCLAIMER)
    expect(html).toContain('Readiness — current records')
    expect(html).not.toContain('Not met')
    expect(html).toMatch(/<button class="[^"]*">Prepare Final Account<\/button>/)
    expect(html).toContain('Current position — not a Final Account')
    expect(html).toContain('$12,000.00')
    // The live position is a forecast: none of its figures is labelled "final".
    for (const label of ['Adjusted contract sum', 'Forecast final cost', 'Forecast gross profit', 'Forecast margin']) expect(html).toContain(label)
    for (const label of ['Final adjusted contract sum', 'Final cost<', 'Final gross profit', 'Final margin']) expect(html).not.toContain(label)
    expect(html).toContain('nothing in this section is final')
    expect(html).not.toContain('commercial-report')          // nothing printable
    expect(html).not.toContain('Export CSV')
  })

  it('records not ready: the failing requirement is named with its fix and Prepare is disabled', () => {
    use(p => p.forecastLines.push({ id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 100 }))
    const html = render()
    expect(html).toContain('Cost to complete is zero')
    expect(html).toContain('Not met')
    expect(html).toContain('Close out remaining commitment')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Final Account<\/button>/)
    expect(html).toContain('A draft can be prepared once every requirement below is met.')
  })

  it('a budgeted cost code with NO saved forecast: the requirement is Not met, the code is named with its fix, Prepare is disabled', () => {
    use(p => { p.forecastLines = [] })
    const html = render()
    expect(html).toContain('Every cost code has a saved forecast')
    expect(html).toContain('2 of 2 not forecast: 03-100 — Concrete, 03-200 — Formwork')
    expect(html).toContain('Enter 0 where no further cost is expected')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Final Account<\/button>/)
    // Cost to complete itself is a genuine zero and still reads Met.
    expect(html).toMatch(/Cost to complete is zero<span[^>]*>Met<\/span>/)
  })

  it('a forecast that goes missing after the draft: Approve is disabled although no figure differs', () => {
    S.accounts = [revision(1, 'draft')]
    use(p => { p.forecastLines[0].uncommittedCostToComplete = null })
    const html = render()
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/)
    expect(html).toContain('The current records do not meet the readiness requirements.')
    expect(html).not.toContain('Current records:')
  })

  it('an over-allocated client invoice: the requirement is Not met, the invoice is named, Prepare is disabled; an existing draft cannot be approved', () => {
    const over = (p) => p.clientReceipts.push({ id: 'cr2', receiptNumber: 'CR-0002', status: 'posted', clientId: 'c1', receiptDate: '2026-10-20', amount: 2700, allocatedTotal: 2700, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', allocatedAmount: 2700 }] })
    use(over)
    let html = render()
    expect(html).toContain('No over-allocated issued client invoices')
    expect(html).toContain('1 over-allocated: CI-0001')
    expect(html).toContain('Nothing is reallocated automatically.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Final Account<\/button>/)
    S.accounts = [revision(1, 'draft')]
    html = render()
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/)
    expect(html).toContain('The current records do not meet the readiness requirements.')
  })

  it('a WITHDRAWN draft is never presented as a Final Account: it is not auto-selected, not printable, and stays in the history', () => {
    // (Its own view opens from the history's View button and uses the DRAFT
    // labels — revisionView, unit-tested; clicking is not exercised here.)
    S.accounts = [revision(1, 'withdrawn')]
    const html = render()
    expect(html).not.toContain('<article')
    expect(html).toContain('No Final Account has been prepared for this project.')
    expect(html).toContain('Withdrawn')
    expect(html).toContain('Prepare revision 2')
    expect(html).not.toContain('commercial-report')
    expect(html).not.toContain('Export CSV')
    expect(html).not.toMatch(/>Final (adjusted contract sum|cost|gross profit|margin)</)
  })

  it('an approved-but-unapplied supplier variation: the requirement is worded in forecast-cost terms, never "Final cost"', () => {
    use(p => p.variations.push({ id: 'va', variationType: 'supplier', status: 'approved', approvedSubtotal: 5000, lineItems: [{ costCodeId: 'cc1', approvedAmount: 5000 }] }))
    const html = render()
    expect(html).toContain('Every approved supplier variation is inside forecast final cost')
    expect(html).toContain('Not met')
    expect(html).toContain('its value is outside forecast final cost')
    expect(html).toContain('$5,000.00')                         // the total approved value is still shown
    expect(html).toContain('Any approved value not yet applied is outside it and blocks approval')
    expect(html).not.toContain('inside Final cost')
    expect(html).not.toContain('already inside')
  })

  it('loading: figures are —, never zero, and nothing can be prepared', () => {
    S.loading = true
    const html = render()
    expect(html).toContain('Loading the project records…')
    expect(html).toContain('Checking')
    expect(html).not.toMatch(/\$0\.00/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Final Account<\/button>/)
  })

  it('a failed register: the figure is Unavailable, the source is named, nothing is zero', () => {
    S.failInvoices = true
    const html = render()
    expect(html).toContain('Could not load: Supplier Invoices')
    expect(html).toContain('Unavailable')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Final Account<\/button>/)
  })

  it('a draft: marked DRAFT, no export or print, Approve for an approver, the checklist hidden', () => {
    S.accounts = [revision(1, 'draft')]
    const html = render()
    expect(html).toContain('Draft revision 1 is awaiting approval. No revision is approved yet.')
    expect(html).toContain('DRAFT — not approved. Every figure below is proposed.')
    for (const label of ['Proposed final contract sum', 'Proposed final cost', 'Proposed final gross profit', 'Proposed final margin']) expect(html).toContain(label)
    expect(html).not.toMatch(/>Final (adjusted contract sum|cost|gross profit|margin)</)
    expect(html).toMatch(/<button class="[^"]*">Approve<\/button>/)
    expect(html).toContain('Withdraw draft')
    expect(html).not.toContain('Export CSV')
    expect(html).not.toContain('Print / Save as PDF')
    expect(html).not.toContain('commercial-report')
    expect(html).not.toContain('Readiness — current records')
    expect(html).not.toContain('Prepare Final Account')
  })

  it('a draft seen by qs: no Approve; its preparer may withdraw, another qs may not', () => {
    S.accounts = [revision(1, 'draft')]
    Object.assign(S, { role: 'qs', uid: 'u_qs' })
    let html = render()
    expect(html).not.toMatch(/>Approve<\/button>/)
    expect(html).toContain('Approval is by a Company Admin or Project Manager.')
    expect(html).toContain('Withdraw draft')
    S.uid = 'u_qs2'
    html = render()
    expect(html).not.toContain('Withdraw draft')
  })

  it('a draft that no longer matches the records: Approve is disabled and says why', () => {
    S.accounts = [revision(1, 'draft')]
    use(p => { p.baseline.originalContractValue = 10500 })
    const html = render()
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/)
    expect(html).toContain('The current records differ from this draft. Withdraw it and prepare a new draft.')
    expect(html).toContain('Current records: $10,500.00')
  })

  it('an approved revision: printable, exportable, attributed, and in agreement with the records', () => {
    S.accounts = [revision(1, 'approved')]
    const html = render()
    expect(html).toContain('Revision 1 is the current approved Final Account.')
    expect(html).toContain('class="commercial-report flex flex-col gap-4"')
    expect(html).toContain('Export CSV')
    expect(html).toContain('Print / Save as PDF')
    expect(html).toContain('Pat PM')
    expect(html).toContain('Records read')
    expect(html).toContain('The current project records agree with this approved revision.')
    // The approved revision (the printable article) keeps the finalised labels;
    // the live section below it, outside the article, is labelled as a forecast.
    const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'))
    for (const label of ['Final adjusted contract sum', 'Final cost', 'Final gross profit', 'Final margin']) expect(article).toContain(label)
    expect(article).not.toContain('Forecast')
    const below = html.slice(html.indexOf('</article>'))
    expect(below).toContain('Forecast final cost')
    expect(below).not.toContain('Final gross profit')
    expect(html).toContain('Prepare revision 2')
    expect(html).not.toMatch(/>Approve<\/button>/)
    expect(html).not.toContain('Withdraw draft')
    expect((html.match(/Internal approval within Constrap/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('an approved revision after the records moved: an alert names the differences; the stored figures are still shown', () => {
    S.accounts = [revision(1, 'approved')]
    use(p => { p.baseline.originalContractValue = 10500 })
    const html = render()
    expect(html).toMatch(/role="alert">The current project records differ from this approved revision in \d+ figures?/)
    expect(html).toContain('The approved figures are unchanged')
    expect(html).toContain('$10,000.00')                       // stored
    expect(html).toContain('Current records: $10,500.00')      // live, beside it
  })

  it('an approved revision when the live records cannot be read: not comparable — never "agree"', () => {
    S.accounts = [revision(1, 'approved')]
    S.failInvoices = true
    const html = render()
    expect(html).toContain('this revision cannot be compared with them')
    expect(html).not.toContain('agree with this approved revision')
    expect(html).toContain('$6,000.00')                        // the approved figures are unaffected
  })

  it('history: current, superseded, withdrawn and an open draft are all listed and labelled', () => {
    S.accounts = [revision(1, 'approved'), revision(2, 'withdrawn'), revision(3, 'approved', { selfApproved: true, createdBy: 'u_pm' }), revision(4, 'draft')]
    const html = render()
    expect(html).toContain('Revision 3 is approved. Draft revision 4 is awaiting approval.')
    expect(html).toContain('Revision history')
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`Revision ${n}`)
    expect(html).toContain('Superseded')
    expect(html).toContain('Current')
    expect(html).toContain('Withdrawn')
    expect(html).toContain('aria-pressed="true"')
  })

  it('a self-approved revision says so', () => {
    S.accounts = [revision(1, 'approved', { selfApproved: true, approvedBy: 'u_pm', createdBy: 'u_pm' })]
    expect(render()).toContain('self-approval (also prepared this revision)')
  })

  // ── Commercial Finance Phase 1 (ADR-87 / ADR-88) ───────────────────────────
  const NEW_FIGURES = ['creditedToClient', 'clientRetentionHeld', 'owedToClient']
  const legacy = (number, status) => {
    const r = revision(number, status)
    return {
      ...r,
      figures: Object.fromEntries(Object.entries(r.figures).filter(([k]) => !NEW_FIGURES.includes(k))),
      sources: { ...r.sources, counts: Object.fromEntries(Object.entries(r.sources.counts).filter(([k]) => !k.startsWith('clientCreditNotes') && !k.startsWith('clientRetentionReleases'))) },
    }
  }

  it('a failed client credit-note read: the invoiced and receivable figures are Unavailable, the register is named, nothing can be prepared', () => {
    S.failCredits = true
    const html = render()
    expect(html).toContain('Could not load: Client Credit Notes')
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('$9,000.00')                    // Invoiced to client is NOT shown as though no credits exist
    expect(html).toContain('$12,000.00')                       // the contract sum does not read credit notes
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare Final Account<\/button>/)
  })

  it('a revision approved BEFORE the new figures existed: no drift alert, "agree", and the three figures are Not recorded', () => {
    S.accounts = [legacy(1, 'approved')]
    const html = render()
    expect(html).not.toContain('The current project records differ from this approved revision')
    expect(html).toContain('The current project records agree with this approved revision on every figure it records.')
    expect(html).toContain('3 figures were not recorded when this revision was approved (Credited to client, Client retention held, Owed to client).')
    const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'))
    expect(article.match(/Not recorded</g)).toHaveLength(3)
    expect(article).not.toContain('Unavailable')
  })

  it('…and a credit note posted since IS drift on the figures that revision carries', () => {
    S.accounts = [legacy(1, 'approved')]
    use(p => { p.clientInvoices[0] = issuedInvoice(); p.clientCreditNotes.push(creditNoteFor(p.clientInvoices[0], 1000)) })
    const html = render()
    expect(html).toMatch(/role="alert">The current project records differ from this approved revision in 4 figures/)
    expect(html).toContain('$9,000.00')                        // stored: invoiced to client
    expect(html).toContain('Current records: $8,000.00')       // live, net of the credit
    expect(html).toContain('3 figures were not recorded when this revision was approved')
  })

  it('a current-schema approved revision says nothing about unrecorded figures', () => {
    S.accounts = [revision(1, 'approved')]
    const html = render()
    expect(html).not.toContain('not recorded when this revision was approved')
    expect(html).not.toContain('Not recorded<')
  })

  it('a DRAFT written before the new figures existed cannot be approved, and the page says why before any call', () => {
    S.accounts = [legacy(1, 'draft')]
    const html = render()
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/)
    expect(html).toContain('This draft was prepared before figures that a Final Account now records were introduced. Withdraw it and prepare a new draft.')
    expect(html).toContain('Withdraw draft')
  })

  it('a failed revision read is Unavailable — never "no Final Account", and nothing can be prepared', () => {
    S.accountsError = true
    const html = render()
    expect(html).toContain('Revision history unavailable')
    expect(html).not.toContain('No Final Account has been prepared')
    expect(html).not.toContain('Prepare Final Account')
  })
})
