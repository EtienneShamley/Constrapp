import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readyProject, sourcesOf } from '../fixtures/finalAccountProject'
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

const S = vi.hoisted(() => ({ role: 'project_manager', uid: 'u_pm', data: null, accounts: [], accountsError: false, loading: false, failInvoices: false }))

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

beforeEach(() => { Object.assign(S, { role: 'project_manager', uid: 'u_pm', accounts: [], accountsError: false, loading: false, failInvoices: false }); use() })

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
    expect(html).toContain('DRAFT — not approved.')
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

  it('a failed revision read is Unavailable — never "no Final Account", and nothing can be prepared', () => {
    S.accountsError = true
    const html = render()
    expect(html).toContain('Revision history unavailable')
    expect(html).not.toContain('No Final Account has been prepared')
    expect(html).not.toContain('Prepare Final Account')
  })
})
