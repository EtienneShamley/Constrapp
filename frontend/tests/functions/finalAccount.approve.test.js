import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import {
  admin, resetEmulators, seedCompany, seedUser, req, expectTeamError, clock, silentLog,
  callFunction, clientSignIn, clientSignOutAll, COMPANY_A, COMPANY_B,
} from './_harness.js'
import {
  computeFinalAccount, settledSourceStates, buildFinalAccountDraft, finalAccountDifferences,
} from '../../src/lib/finalAccount'
import { readyProject, sourcesOf, EXPECTED_FIGURES, FA_PROJECT_COLLECTIONS } from '../fixtures/finalAccountProject'
import { issuedInvoice, creditNoteFor, releaseFor } from '../fixtures/clientReceivableDocs'

// ── approveFinalAccount against the Auth + Firestore (+ Functions) emulators ──
// (ADR-77)
//
// The handler is called DIRECTLY with the real Admin SDK — real transactions,
// real queries inside them — and, at the end, through the deployed onCall
// wrapper over HTTP (App Check, ID token).
//
// What is proven here:
//   · WHO may approve (active company_admin / project_manager of the project's
//     own company) and that the company never comes from the request;
//   · that NO client amount becomes authoritative: the stored figures are the
//     server's own computation, and a draft that disagrees is refused;
//   · the readiness gate, on the server's own read of the records;
//   · CONSISTENCY under concurrent writes: an approval and a competing write
//     are always ordered — a write the approval did not account for commits
//     AFTER it, never before;
//   · approval races and retries: one approved revision, one audit event.

const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
const PROJECT = 'projectA'
let A, handlersMod, H, now, hooks

const base = (c = COMPANY_A, p = PROJECT) => A.db.collection('companies').doc(c).collection('projects').doc(p)
const faRef = (n, c = COMPANY_A, p = PROJECT) => base(c, p).collection('finalAccounts').doc(String(n))
const faDoc = (n) => faRef(n).get().then(s => (s.exists ? s.data() : null))
const audits = (c = COMPANY_A) => A.db.collection('companies').doc(c).collection('auditEvents').where('type', '==', 'final_account.approved').get().then(s => s.docs.map(d => d.data()))
const call = (uid, data) => H.approveFinalAccount(req(uid, data))
const ok = (n = 1, rev = 1) => ({ projectId: PROJECT, number: n, expectedRevision: rev, acknowledged: true })

async function fresh({ enabled = true, db = null, sourceLimit = undefined } = {}) {
  now = clock('2026-11-19T02:00:00Z')
  hooks = {}
  H = handlersMod.createFinalAccountHandlers({ db: db ?? A.db, now, log: silentLog, config: () => ({ enabled }), hooks, ...(sourceLimit ? { sourceLimit } : {}) })
}

// The real database, except that the Nth read inside each transaction fails —
// a partial source-read failure, with every other read and write untouched.
function dbFailingRead(failAt, error) {
  return new Proxy(A.db, {
    get(target, prop) {
      if (prop !== 'runTransaction') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v }
      return (fn, opts) => target.runTransaction((tx) => {
        let reads = 0
        const failing = new Proxy(tx, {
          get(t, p) {
            const v = t[p]
            if (p !== 'get') return typeof v === 'function' ? v.bind(t) : v
            return (...args) => { reads += 1; return reads === failAt ? Promise.reject(error) : t.get(...args) }
          },
        })
        return fn(failing)
      }, opts)
    },
  })
}

// Seed the READY project with the Admin SDK; every register gets a createdAt
// so the ordered queries return it.
async function seedProject(mutate = (p) => p, c = COMPANY_A, p = PROJECT) {
  const data = readyProject()
  mutate(data)
  const at = (i) => A.Timestamp.fromMillis(1_760_000_000_000 + i * 1000)
  const batch = A.db.batch()
  batch.set(A.db.collection('companies').doc(c), data.company, { merge: true })
  batch.set(base(c, p), { ...data.project, createdAt: at(0), createdBy: 'seed' })
  data.costCodes.forEach(({ id, ...rest }, i) => batch.set(A.db.collection('companies').doc(c).collection('costCodes').doc(id), { ...rest, createdAt: at(i) }))
  batch.set(base(c, p).collection('commercial').doc('baseline'), { ...data.baseline, createdAt: at(0), createdBy: 'seed', updatedAt: at(0), updatedBy: 'seed' })
  if (data.pointer) batch.set(base(c, p).collection('approvedBudget').doc('current'), data.pointer)
  for (const name of [...FA_PROJECT_COLLECTIONS, 'budgetAdjustments']) {
    (data[name] ?? []).forEach(({ id, ...rest }, i) => batch.set(base(c, p).collection(name).doc(id), { ...rest, createdAt: at(i), createdBy: 'seed' }))
  }
  await batch.commit()
  return data
}

// A draft exactly as the browser action writes it, from the SAME client module.
function draftFor(data, { number = 1, createdBy = 'u_qs', over = {} } = {}) {
  const computation = computeFinalAccount({ project: { id: PROJECT }, currencyCode: 'AUD', sources: sourcesOf(data), sourceStates: settledSourceStates() })
  const built = buildFinalAccountDraft({ computation, number, input: { reason: 'Works complete', reference: 'FA-1', acknowledged: true }, currencyCode: 'AUD', preparedByName: 'Quin QS' })
  if (!built.ok) throw new Error(`fixture not ready: ${built.error}`)
  const t = A.Timestamp.fromMillis(1_763_000_000_000)
  return {
    ...built.payload, status: 'draft', revision: 1,
    approvedAt: null, approvedBy: null, approvedByName: null, approvedByRole: null, selfApproved: null, sourcesReadAt: null,
    withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    createdAt: t, createdBy, updatedAt: t, updatedBy: createdBy, ...over,
  }
}
const seedDraft = async (data, opts) => { const d = draftFor(data, opts); await faRef(opts?.number ?? 1).set(d); return d }

async function seedPeople() {
  await seedCompany(COMPANY_A, 'Acme Builders')
  await seedUser({ uid: 'u_admin', email: 'admin@acme.test', role: 'company_admin', companyId: COMPANY_A, name: 'Ada Admin' })
  await seedUser({ uid: 'u_pm', email: 'pm@acme.test', role: 'project_manager', companyId: COMPANY_A, name: 'Pat PM' })
  await seedUser({ uid: 'u_qs', email: 'qs@acme.test', role: 'qs', companyId: COMPANY_A, name: 'Quin QS' })
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/finalAccount/handlers.js')
})
beforeEach(async () => {
  await clientSignOutAll()
  await resetEmulators()
  await fresh()
  await seedPeople()
})
afterAll(async () => { await clientSignOutAll() })

// ── Authorisation ────────────────────────────────────────────────────────────

describe('who may approve', () => {
  let data
  beforeEach(async () => { data = await seedProject(); await seedDraft(data) })

  it('an unauthenticated request is refused before validation and before any read', async () => {
    await expectTeamError(H.approveFinalAccount(req(null, { nonsense: true })), A.CODE.UNAUTHENTICATED)
  })
  it('a signed-in uid with no membership is refused', async () => {
    await A.auth.createUser({ uid: 'u_bare', email: 'bare@x.test', password: 'correct-horse-battery' })
    await expectTeamError(call('u_bare', ok()), A.CODE.NO_MEMBERSHIP)
  })
  it('qs prepares but cannot approve; subcontractor, client and super_admin cannot approve', async () => {
    await seedUser({ uid: 'u_sub', email: 'sub@x.test', role: 'subcontractor', companyId: COMPANY_A })
    await seedUser({ uid: 'u_client', email: 'client@x.test', role: 'client', companyId: COMPANY_A })
    await seedUser({ uid: 'u_super', email: 'super@x.test', role: 'super_admin', companyId: COMPANY_A })
    for (const uid of ['u_qs', 'u_sub', 'u_client', 'u_super']) await expectTeamError(call(uid, ok()), A.CODE.NOT_APPROVER)
    expect((await faDoc(1)).status).toBe('draft')
  })
  it('a deactivated approver is refused', async () => {
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null })
    await expectTeamError(call('u_pm', ok()), A.CODE.MEMBERSHIP_INACTIVE)
  })
  it("another company's admin gets NOT FOUND for this project id — the company is never taken from the request", async () => {
    await seedCompany(COMPANY_B, 'Other Co')
    await seedUser({ uid: 'u_adminB', email: 'admin@other.test', role: 'company_admin', companyId: COMPANY_B })
    await expectTeamError(call('u_adminB', ok()), A.CODE.NOT_FOUND)
    // Even with a project of the SAME id in their own company, they reach only their own (empty) records.
    await seedProject(p => p, COMPANY_B, PROJECT)
    await expectTeamError(call('u_adminB', ok()), A.CODE.NOT_FOUND)
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits(COMPANY_B)).toHaveLength(0)
  })
  it('the kill switch answers final-account-disabled before authentication or any read', async () => {
    await fresh({ enabled: false })
    await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_DISABLED)
    await expectTeamError(H.approveFinalAccount(req(null, {})), A.CODE.FINAL_ACCOUNT_DISABLED)
    expect((await faDoc(1)).status).toBe('draft')
  })
})

// ── The request carries no amount ────────────────────────────────────────────

describe('request validation', () => {
  beforeEach(async () => { await seedDraft(await seedProject()) })

  const bad = [
    ['an amount key', { ...ok(), figures: { finalProfit: 1 } }],
    ['a total', { ...ok(), finalContractSum: 12000 }],
    ['a companyId', { ...ok(), companyId: COMPANY_A }],
    ['no acknowledgement', { projectId: PROJECT, number: 1, expectedRevision: 1 }],
    ['acknowledged: false', { ...ok(), acknowledged: false }],
    ['a string number', { ...ok(), number: '1' }],
    ['number 0', { ...ok(), number: 0 }],
    ['a fractional revision', { ...ok(), expectedRevision: 1.5 }],
    ['a path-like project id', { ...ok(), projectId: 'a/b' }],
    ['null data', null],
    ['an array', []],
  ]
  it.each(bad)('refused as invalid-argument: %s', async (_label, data) => {
    await expectTeamError(call('u_pm', data), A.CODE.INVALID_ARGUMENT)
    expect((await faDoc(1)).status).toBe('draft')
  })
})

// ── Approval ─────────────────────────────────────────────────────────────────

describe('approval', () => {
  it('a project manager approves a qs draft: server figures, attribution, server time, one audit event', async () => {
    const data = await seedProject()
    const draft = await seedDraft(data)
    const res = await call('u_pm', ok())
    expect(res).toMatchObject({ number: 1, revision: 2, status: 'approved', alreadyApproved: false })
    const d = await faDoc(1)
    expect(d).toMatchObject({
      status: 'approved', revision: 2, number: 1, currency: 'AUD', rowCount: 2,
      approvedBy: 'u_pm', approvedByName: 'Pat PM', approvedByRole: 'project_manager', selfApproved: false, updatedBy: 'u_pm',
      createdBy: 'u_qs', preparedByName: 'Quin QS', reason: 'Works complete', reference: 'FA-1',
      withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    })
    expect(d.figures).toEqual(EXPECTED_FIGURES)
    expect(d.rows).toEqual(draft.rows)
    expect(d.sources).toMatchObject({ budgetApprovalId: 'ba1', budgetVersion: 1, adjustmentCount: 0 })
    expect(d.approvedAt.toMillis()).toBeGreaterThan(Date.now() - 60000)       // SERVER time, not the injected clock
    expect(d.approvedAt.toMillis()).toBe(d.updatedAt.toMillis())
    expect(d.sourcesReadAt.toMillis()).toBeGreaterThan(Date.now() - 60000)
    expect(d.createdAt.toMillis()).toBe(draft.createdAt.toMillis())
    const events = await audits()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorUid: 'u_pm', after: { projectId: PROJECT, number: 1, status: 'approved', revision: 2, selfApproved: false, finalContractSum: 12000, finalCost: 6000 } })
  })

  it('self-approval is permitted and RECORDED on the revision and in the audit event', async () => {
    const data = await seedProject()
    await seedDraft(data, { createdBy: 'u_admin' })
    await call('u_admin', ok())
    expect(await faDoc(1)).toMatchObject({ status: 'approved', approvedBy: 'u_admin', approvedByName: 'Ada Admin', approvedByRole: 'company_admin', selfApproved: true })
    expect((await audits())[0].after.selfApproved).toBe(true)
  })

  it('the stored figures are the SERVER\'s: a draft equal to the cent but not to the float is normalised', async () => {
    const data = await seedProject()
    const d0 = draftFor(data)
    d0.figures = { ...d0.figures, actualCost: 6000.004, finalProfit: 5999.996 }
    d0.rows = d0.rows.map(r => ({ ...r, costCodeName: 'CLIENT-SUPPLIED NAME' }))
    await faRef(1).set(d0)
    await call('u_pm', ok())
    const d = await faDoc(1)
    expect(d.figures).toEqual(EXPECTED_FIGURES)
    expect(d.rows.map(r => r.costCodeName)).toEqual(['03-100 — Concrete', '03-200 — Formwork'])
  })

  const forged = [
    ['a profit figure', d => { d.figures = { ...d.figures, finalProfit: 99999 } }],
    ['one cent on the contract sum', d => { d.figures = { ...d.figures, finalContractSum: 12000.01 } }],
    ['a zeroed outstanding balance', d => { d.figures = { ...d.figures, payablesOutstanding: 0 } }],
    ['a missing figure', d => { d.figures = without(d.figures, 'retentionHeld') }],
    ['a row amount', d => { d.rows = [{ ...d.rows[0], actualCost: 1 }, d.rows[1]] }],
    ['a dropped row', d => { d.rows = [d.rows[0]]; d.rowCount = 1 }],
    ['reordered rows', d => { d.rows = [d.rows[1], d.rows[0]] }],
    ['another budget version', d => { d.sources = { ...d.sources, budgetApprovalId: 'ba0' } }],
    ['another currency', d => { d.currency = 'USD' }],
    ['no acknowledgement on the draft', d => { d.openItemsAcknowledged = false }],
  ]
  it.each(forged)('a draft forged in %s is refused and stays a draft', async (_label, fn) => {
    const data = await seedProject()
    const d0 = draftFor(data)
    fn(d0)
    await faRef(1).set(d0)
    await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_CHANGED)
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
  })

  it('approving writes ONLY the revision and its audit event — no register, budget or baseline document', async () => {
    const data = await seedProject()
    await seedDraft(data)
    const snapshot = async () => {
      const out = {}
      for (const name of [...FA_PROJECT_COLLECTIONS, 'commercial', 'approvedBudget']) {
        out[name] = (await base().collection(name).get()).docs.map(d => [d.id, d.updateTime.toMillis()])
      }
      out.project = (await base().get()).updateTime.toMillis()
      return out
    }
    const before = await snapshot()
    await call('u_pm', ok())
    expect(await snapshot()).toEqual(before)
  })
})

// ── Readiness on the server's own read ───────────────────────────────────────

describe('readiness is judged from the records the server reads', () => {
  const cases = [
    ['a client variation submitted after the draft', 'clientVariations', async () => base().collection('variations').doc('v9').set({ variationType: 'client', status: 'submitted', submittedSubtotal: 5, lineItems: [], createdAt: A.Timestamp.now() })],
    ['a draft progress claim', 'openClaims', async () => base().collection('progressClaims').doc('c9').set({ status: 'draft', poId: 'po1', lineItems: [], createdAt: A.Timestamp.now() })],
    ['an unposted supplier invoice', 'unpostedInvoices', async () => base().collection('supplierInvoices').doc('i9').set({ status: 'draft', poId: 'po1', lineItems: [], createdAt: A.Timestamp.now() })],
    ['a cost to complete entered on the forecast', 'costToComplete', async () => base().collection('forecastLines').doc('cc1').set({ costCodeId: 'cc1', uncommittedCostToComplete: 100 })],
    ['a saved forecast CLEARED after the draft (no figure changes)', 'forecastIncomplete', async () => base().collection('forecastLines').doc('cc1').update({ uncommittedCostToComplete: null })],
    ['a forecast line REMOVED after the draft', 'forecastIncomplete', async () => base().collection('forecastLines').doc('cc2').delete()],
    ['the approved budget pointer removed', 'budget', async () => base().collection('approvedBudget').doc('current').delete()],
    ['the contract value removed', 'contract', async () => base().collection('commercial').doc('baseline').delete()],
    ['a receipt over-allocating an issued client invoice by one cent', 'overAllocatedInvoices', async () => base().collection('clientReceipts').doc('r8').set({ status: 'posted', receiptDate: '2026-10-20', amount: 2200.01, allocatedTotal: 2200.01, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 2200.01 }], createdAt: A.Timestamp.now() })],
    ['a draft client receipt', 'draftReceipts', async () => base().collection('clientReceipts').doc('r9').set({ status: 'draft', amount: 5, allocations: [], createdAt: A.Timestamp.now() })],
    ['a draft client credit note', 'draftClientCreditNotes', async () => base().collection('clientCreditNotes').doc('n9').set({ status: 'draft', clientInvoiceId: 'ci1', lineItems: [], createdAt: A.Timestamp.now() })],
    ['a draft client retention release', 'draftClientRetentionReleases', async () => base().collection('clientRetentionReleases').doc('q9').set({ status: 'draft', clientInvoiceId: 'ci1', amount: 5, createdAt: A.Timestamp.now() })],
    ['a posted client credit note that fails the validity gate', 'clientCreditExceptions', async () => base().collection('clientCreditNotes').doc('n8').set({ status: 'posted', creditNumber: 'CCN-0008', clientInvoiceId: 'gone', lineItems: [], subtotal: 10, gstTotal: 1, grossTotal: 11, createdAt: A.Timestamp.now() })],
  ]
  it.each(cases)('%s → final-account-not-ready naming "%s"; nothing is approved', async (_label, blocker, change) => {
    await seedDraft(await seedProject())
    await change()
    const err = await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_NOT_READY)
    expect(err.details.blockers).toContain(blocker)
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
  })

  it('an invoice paid EXACTLY in full is not over-allocated: the server approves a draft prepared on those records', async () => {
    const paid = (p) => p.clientReceipts.push({ id: 'cr2', receiptNumber: 'CR-0002', status: 'posted', clientId: 'c1', clientName: 'Owner Pty Ltd', receiptDate: '2026-10-20', amount: 2200, allocatedTotal: 2200, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 2200 }] })
    const data = await seedProject(paid)
    await seedDraft(data)
    expect((await call('u_pm', ok())).status).toBe('approved')
    expect((await faDoc(1)).figures.receivablesOutstanding).toBe(0)
  })

  it('client credit notes and client retention are READ BY THE SERVER and recomputed (ADR-87 / ADR-88)', async () => {
    // 9,000.00 + 900.00 GST, 450.00 retained (45.00 GST). A 1,000.00 credit takes
    // 50.00 + 5.00 of the retention; a 100.00 release frees 100.00 + 10.00.
    const invoice = issuedInvoice({ subtotal: 9000, retention: 450 })
    const credit = creditNoteFor(invoice, 1000)
    const release = releaseFor(invoice, 100, { id: 'crr1' })
    const withReceivables = (p) => {
      p.clientInvoices = [invoice]
      p.clientCreditNotes = [credit]
      p.clientRetentionReleases = [release]
      // gross 9,900 − credit 1,100 − held (495 − 55 − 110 = 330) = 8,470 receivable.
      p.clientReceipts = [{ id: 'cr1', receiptNumber: 'CR-0001', status: 'posted', clientId: 'c1', clientName: 'Owner Pty Ltd', receiptDate: '2026-10-20', amount: 8470, allocatedTotal: 8470, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 8470 }] }]
    }
    const data = await seedProject(withReceivables)
    await seedDraft(data)
    expect((await call('u_pm', ok())).status).toBe('approved')
    const stored = await faDoc(1)
    expect(stored.figures).toMatchObject({
      creditedToClient: 1000, invoicedToClient: 8000, invoicedToClientGross: 8800,
      clientRetentionHeld: 330, receivablesOutstanding: 0, owedToClient: 0, receivedAgainstInvoices: 8470,
    })
    expect(stored.sources.counts).toMatchObject({ clientCreditNotes: 1, clientRetentionReleases: 1 })
  })

  it('a credit note posted AFTER the draft changes the figures the approver reviewed: refused as changed or not ready, never approved', async () => {
    const invoice = issuedInvoice({ subtotal: 9000 })
    const data = await seedProject((p) => { p.clientInvoices = [invoice]; p.clientReceipts = [] })
    await seedDraft(data)
    const { id, ...credit } = creditNoteFor(invoice, 1000)
    await base().collection('clientCreditNotes').doc(id).set({ ...credit, createdAt: A.Timestamp.now() })
    await expect(call('u_pm', ok())).rejects.toBeTruthy()
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
  })

  it('records that are still ready but DIFFERENT from the draft are refused as changed (the approver reviewed other figures)', async () => {
    await seedDraft(await seedProject())
    await base().collection('commercial').doc('baseline').update({ originalContractValue: 10500 })
    await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_CHANGED)
    await base().collection('commercial').doc('baseline').update({ originalContractValue: 10000 })
    await base().collection('clientReceipts').doc('cr2').set({ status: 'posted', amount: 100, allocatedTotal: 0, unallocatedAmount: 100, allocations: [], receiptDate: '2026-11-01', createdAt: A.Timestamp.now() })
    await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_CHANGED)
    expect((await faDoc(1)).status).toBe('draft')
  })

  it('a budget whose stored snapshot no longer reconciles is refused — never the working lines', async () => {
    await seedDraft(await seedProject())
    await base().collection('budgetApprovalSnapshots').doc('ba1').update({ total: 6999 })
    const err = await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_NOT_READY)
    expect(err.details.blockers).toContain('budget')
  })

  it('approved budget ADJUSTMENTS are read and folded exactly as the browser folds them', async () => {
    const adjusted = (p) => {
      p.pointer = { ...p.pointer, adjustmentCount: 1, adjustmentNet: 250, lastAdjustmentId: 'adj1' }
      p.budgetAdjustments = [{ id: 'adj1', type: 'increase', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', fromCostCodeId: null, fromCostCodeName: '',
        amount: 250, currency: 'AUD', baseApprovalId: 'ba1', baseVersion: 1, sequence: 1, status: 'approved' }]
    }
    const data = await seedProject(adjusted)
    await seedDraft(data)
    await call('u_pm', ok())
    const d = await faDoc(1)
    expect(d.figures.approvedBudget).toBe(7250)
    expect(d.figures.varianceToBudget).toBe(1250)
    expect(d.sources.adjustmentCount).toBe(1)
  })
})

// ── Lifecycle guards ─────────────────────────────────────────────────────────

// ── Forecast completeness (C1-A correction) ──────────────────────────────────
//
// The server judges completeness from the forecast lines IT reads in the
// approval transaction. A draft is client-written and untrusted: one that was
// prepared (or forged) while a budgeted cost code had no saved forecast must
// never be approved, although every figure in it agrees with the records.

describe('forecast completeness is enforced by the server', () => {
  // A draft whose figures match the records exactly, written for a project
  // that has NO forecast line — what an old client or a forged write produces.
  const seedUnforecast = async (clear) => {
    const data = await seedProject()                 // seeded complete, so the draft builds …
    await seedDraft(data)
    await clear()                                    // … then the forecasts are removed
  }

  it('NO forecast line on any budgeted code: refused by name, the draft stays a draft, no audit event', async () => {
    await seedUnforecast(async () => { for (const id of ['cc1', 'cc2']) await base().collection('forecastLines').doc(id).delete() })
    const err = await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_NOT_READY)
    expect(err.details.blockers).toEqual(['forecastIncomplete'])
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
  })

  it('MIXED coverage — one code a saved 0, one never forecast: refused', async () => {
    await seedUnforecast(async () => base().collection('forecastLines').doc('cc2').delete())
    const err = await expectTeamError(call('u_admin', ok()), A.CODE.FINAL_ACCOUNT_NOT_READY)
    expect(err.details.blockers).toEqual(['forecastIncomplete'])
    expect((await faDoc(1)).status).toBe('draft')
  })

  it('a POSITIVE forecast is refused as cost to complete, not as a missing forecast', async () => {
    await seedUnforecast(async () => base().collection('forecastLines').doc('cc1').update({ uncommittedCostToComplete: 75 }))
    const err = await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_NOT_READY)
    expect(err.details.blockers).toEqual(['costToComplete'])
  })

  it('an EXPLICIT 0 on every code is complete: approved, and restoring a cleared forecast makes the same draft approvable', async () => {
    await seedUnforecast(async () => base().collection('forecastLines').doc('cc1').update({ uncommittedCostToComplete: null }))
    await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_NOT_READY)
    await base().collection('forecastLines').doc('cc1').update({ uncommittedCostToComplete: 0 })
    expect((await call('u_pm', ok())).status).toBe('approved')
    expect((await faDoc(1)).figures).toEqual(EXPECTED_FIGURES)
    expect(await audits()).toHaveLength(1)
  })

  it('a forecast cleared WHILE the approval is in flight is ordered against it: never an approval over an unseen clear', async () => {
    const { outcome, write, account } = await raceApprovalAgainst(() => base().collection('forecastLines').doc('cc1').update({ uncommittedCostToComplete: null }))
    if (outcome.approved) {
      // Serialised: approved on complete forecasts; the clear committed strictly after.
      expect(account.data().status).toBe('approved')
      expect(write.time.valueOf() > account.updateTime.valueOf()).toBe(true)
    } else {
      // Or the retry saw the clear and refused.
      expect(outcome.e.details).toMatchObject({ code: A.CODE.FINAL_ACCOUNT_NOT_READY, blockers: ['forecastIncomplete'] })
      expect(account.data().status).toBe('draft')
      expect(await audits()).toHaveLength(0)
    }
  })

  it('an APPROVED revision is immutable: forecasts cleared afterwards change nothing, and a replayed request writes nothing', async () => {
    await seedDraft(await seedProject())
    await call('u_pm', ok())
    const before = await faRef(1).get()
    for (const id of ['cc1', 'cc2']) await base().collection('forecastLines').doc(id).delete()
    const replay = await call('u_pm', ok())
    expect(replay).toMatchObject({ status: 'approved', alreadyApproved: true })
    const after = await faRef(1).get()
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true)
    expect(after.data()).toEqual(before.data())
    expect(await audits()).toHaveLength(1)
    // A different approver gets "not a draft" — never a re-evaluation.
    await expectTeamError(call('u_admin', ok()), A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
  })
})

describe('lifecycle guards', () => {
  let data
  beforeEach(async () => { data = await seedProject() })

  it('a missing revision is not found; a stale expectedRevision is refused', async () => {
    await expectTeamError(call('u_pm', ok(1)), A.CODE.NOT_FOUND)
    await seedDraft(data)
    await expectTeamError(call('u_pm', ok(1, 2)), A.CODE.FINAL_ACCOUNT_STALE)
    await expectTeamError(call('u_pm', ok(2, 1)), A.CODE.NOT_FOUND)
  })
  it('a withdrawn revision can never be approved', async () => {
    await seedDraft(data, { over: { status: 'withdrawn', revision: 2, withdrawnBy: 'u_qs', withdrawReason: 'x' } })
    await expectTeamError(call('u_pm', ok(1, 2)), A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
    await expectTeamError(call('u_pm', ok(1, 1)), A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
  })
  it('a correction is revision 2: approving it leaves approved revision 1 byte-for-byte unchanged', async () => {
    await seedDraft(data)
    await call('u_pm', ok(1))
    const first = await faRef(1).get()
    await base().collection('commercial').doc('baseline').update({ originalContractValue: 10500 })
    const corrected = { ...data, baseline: { ...data.baseline, originalContractValue: 10500 } }
    await seedDraft(corrected, { number: 2 })
    await call('u_admin', ok(2))
    const again = await faRef(1).get()
    expect(again.updateTime.toMillis()).toBe(first.updateTime.toMillis())
    expect(again.data()).toEqual(first.data())
    expect((await faDoc(2)).figures.finalContractSum).toBe(12500)
    expect((await faDoc(1)).figures.finalContractSum).toBe(12000)
    // …and revision 1 now differs from the live records, which is what the page reports.
    const live = computeFinalAccount({ project: { id: PROJECT }, currencyCode: 'AUD', sources: sourcesOf(corrected), sourceStates: settledSourceStates() })
    expect(finalAccountDifferences(again.data(), live).figures.map(f => f.key)).toContain('originalContractValue')
    expect(await audits()).toHaveLength(2)
  })
})

// ── Idempotence, races and consistency ───────────────────────────────────────

describe('idempotent retry of an uncertain outcome', () => {
  it('the same caller repeating the same request gets the same answer and NO second write or audit event', async () => {
    await seedDraft(await seedProject())
    await call('u_pm', ok())
    const first = await faRef(1).get()
    const again = await call('u_pm', ok())
    expect(again).toMatchObject({ number: 1, revision: 2, status: 'approved', alreadyApproved: true })
    expect((await faRef(1).get()).updateTime.toMillis()).toBe(first.updateTime.toMillis())
    expect(await audits()).toHaveLength(1)
  })
  it('a DIFFERENT caller, or a different expectedRevision, is told the revision is no longer a draft', async () => {
    await seedDraft(await seedProject())
    await call('u_pm', ok())
    await expectTeamError(call('u_admin', ok()), A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
    await expectTeamError(call('u_pm', ok(1, 2)), A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
    expect(await audits()).toHaveLength(1)
  })
})

describe('approval races', () => {
  it('TWO approvers at once: exactly one approval is written, one audit event, one approver recorded', async () => {
    await seedDraft(await seedProject())
    const results = await Promise.allSettled([call('u_pm', ok()), call('u_admin', ok())])
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter(r => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason.details.code).toBe(A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
    const d = await faDoc(1)
    expect(d.status).toBe('approved')
    expect(d.revision).toBe(2)
    expect(['u_pm', 'u_admin']).toContain(d.approvedBy)
    const events = await audits()
    expect(events).toHaveLength(1)
    expect(events[0].actorUid).toBe(d.approvedBy)
  })

  it('the SAME approver double-submitting: one write, one audit event, both calls answered as approved', async () => {
    await seedDraft(await seedProject())
    const results = await Promise.allSettled([call('u_pm', ok()), call('u_pm', ok())])
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    expect(results.map(r => r.value.alreadyApproved).sort()).toEqual([false, true])
    expect(await audits()).toHaveLength(1)
    expect((await faDoc(1)).revision).toBe(2)
  })

  it('a transaction aborted by contention is retried and still writes exactly once', async () => {
    await seedDraft(await seedProject())
    hooks.afterRead = async ({ attempt }) => {
      if (attempt === 1) throw Object.assign(new Error('forced contention'), { code: 10 })   // ABORTED
    }
    const res = await call('u_pm', ok())
    expect(res.attempts).toBe(2)
    expect(res.alreadyApproved).toBe(false)
    expect((await faDoc(1)).status).toBe('approved')
    expect(await audits()).toHaveLength(1)
  })

  it('a non-retryable failure inside the transaction writes nothing', async () => {
    await seedDraft(await seedProject())
    hooks.afterRead = async () => { throw new Error('boom') }
    await expect(call('u_pm', ok())).rejects.toThrow('boom')
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
  })
})

describe('failure handling', () => {
  it('contention on EVERY attempt: a typed final-account-busy after five attempts; certainly nothing approved', async () => {
    await seedDraft(await seedProject())
    let seenAttempts = 0
    hooks.afterRead = async ({ attempt }) => { seenAttempts = attempt; throw Object.assign(new Error('contention'), { code: 10 }) }
    const err = await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_BUSY)
    expect(seenAttempts).toBe(5)
    expect(err.details.attempts).toBe(5)
    expect(err.code).toBe('aborted')
    expect((await faDoc(1)).status).toBe('draft')
    expect((await faDoc(1)).revision).toBe(1)
    expect(await audits()).toHaveLength(0)
    // …and the same request succeeds once the contention is gone.
    hooks.afterRead = undefined
    expect((await call('u_pm', ok())).alreadyApproved).toBe(false)
  })

  it('a timeout (DEADLINE_EXCEEDED) is NOT turned into a typed refusal: its outcome is uncertain and it is rethrown as-is', async () => {
    await seedDraft(await seedProject())
    hooks.afterRead = async () => { throw Object.assign(new Error('deadline exceeded'), { code: 4 }) }
    const err = await call('u_pm', ok()).then(() => null, e => e)
    expect(err).not.toBeNull()
    expect(err.details?.code).toBeUndefined()        // the onCall wrapper reports it as a bare `internal`
    expect((await faDoc(1)).status).toBe('draft')    // here it failed before the write: nothing committed
    expect(await audits()).toHaveLength(0)
    // A retry after an uncertain outcome is safe either way.
    hooks.afterRead = undefined
    expect((await call('u_pm', ok())).status).toBe('approved')
    expect((await call('u_pm', ok())).alreadyApproved).toBe(true)
    expect(await audits()).toHaveLength(1)
  })

  it.each([[2, 'the project / draft read'], [5, 'one register query'], [14, 'a late register query']])(
    'a PARTIAL source-read failure (read %i — %s) approves nothing and builds no figure from the reads that succeeded', async (failAt) => {
      await seedDraft(await seedProject())
      await fresh({ db: dbFailingRead(failAt, new Error('read failed')) })
      await expect(call('u_pm', ok())).rejects.toThrow('read failed')
      const d = await faDoc(1)
      expect(d.status).toBe('draft')
      expect(d.revision).toBe(1)
      expect(d.approvedAt).toBeNull()
      expect(await audits()).toHaveLength(0)
    })

  it('a register over the document bound is REFUSED by name — never truncated into a smaller total', async () => {
    const data = await seedProject()
    await seedDraft(data)
    const batch = A.db.batch()
    for (let i = 0; i < 4; i += 1) {
      batch.set(base().collection('supplierPayments').doc(`extra${i}`), { status: 'void', amount: 1, allocations: [], createdAt: A.Timestamp.fromMillis(1_761_000_000_000 + i) })
    }
    await batch.commit()
    await fresh({ sourceLimit: 4 })
    const err = await expectTeamError(call('u_pm', ok()), A.CODE.FINAL_ACCOUNT_TOO_LARGE)
    expect(err.details).toMatchObject({ registers: ['supplierPayments'], limit: 4 })
    expect((await faDoc(1)).status).toBe('draft')
    expect(await audits()).toHaveLength(0)
    // Exactly AT the bound is accepted (five payments, bound five; void payments move no figure).
    await fresh({ sourceLimit: 5 })
    expect((await call('u_pm', ok())).status).toBe('approved')
    expect((await faDoc(1)).sources.counts.supplierPayments).toBe(5)
  })
})

// A competing write is started WHILE the approval transaction is between its
// reads and its write. Serializability allows exactly two histories:
//   (A) the write is ordered BEFORE the approval — the approval is retried,
//       sees it, and (because the draft no longer agrees) refuses; or
//   (B) the approval is ordered FIRST — it succeeds on the figures it read,
//       and the write commits AFTER it (visible later as drift).
// What must never happen: an approval that succeeded although a write it did
// not account for had ALREADY committed.
async function raceApprovalAgainst(startWrite) {
  await seedDraft(await seedProject())
  let pending = null
  hooks.afterRead = async ({ attempt }) => {
    if (attempt !== 1) return
    pending = startWrite().then(r => ({ ok: true, at: r.writeTime.toMillis(), time: r.writeTime }), e => ({ ok: false, e }))
    await new Promise(r => setTimeout(r, 400))    // let the competing write reach the backend
  }
  const outcome = await call('u_pm', ok()).then(v => ({ approved: true, v }), e => ({ approved: false, e }))
  const write = await pending
  expect(write.ok).toBe(true)                      // the competing write is never lost
  const account = await faRef(1).get()
  return { outcome, write, account }
}

describe('consistency with concurrent source writes', () => {
  it('an UPDATE to a document the approval read (the contract value) is ordered against the approval', async () => {
    const { outcome, write, account } = await raceApprovalAgainst(() => base().collection('commercial').doc('baseline').update({ originalContractValue: 10500 }))
    if (outcome.approved) {
      // History (B): approved on 10,000; the edit committed strictly after.
      expect(account.data().figures.originalContractValue).toBe(10000)
      expect(write.time.valueOf() > account.updateTime.valueOf()).toBe(true)
    } else {
      // History (A): the retry saw 10,500 and refused.
      expect(outcome.e.details.code).toBe(A.CODE.FINAL_ACCOUNT_CHANGED)
      expect(account.data().status).toBe('draft')
      expect(await audits()).toHaveLength(0)
    }
  })

  it('an INSERT into a register the approval queried (a new submitted variation) is ordered against the approval', async () => {
    const { outcome, write, account } = await raceApprovalAgainst(() =>
      base().collection('variations').doc('v-late').set({ variationType: 'client', status: 'submitted', submittedSubtotal: 500, lineItems: [], createdAt: A.Timestamp.now() }))
    if (outcome.approved) {
      expect(account.data().sources.counts.variations).toBe(1)
      expect(write.time.valueOf() > account.updateTime.valueOf()).toBe(true)
    } else {
      expect(outcome.e.details.code).toBe(A.CODE.FINAL_ACCOUNT_NOT_READY)
      expect(outcome.e.details.blockers).toContain('clientVariations')
      expect(account.data().status).toBe('draft')
    }
  })

  it('an INSERT of a posted cost (a new supplier invoice) is ordered against the approval', async () => {
    const inv = without(readyProject().supplierInvoices[0], 'id')
    const { outcome, write, account } = await raceApprovalAgainst(() =>
      base().collection('supplierInvoices').doc('inv-late').set({
        ...inv, poId: 'po-none',
        lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', amount: 250, taxCode: 'gst', gstAmount: 25 }],
        retention: 0, retentionGst: 0, retentionTotal: 0, subtotal: 250, gstTotal: 25, grossTotal: 275, net: 250, payableGst: 25, payableTotal: 275,
        createdAt: A.Timestamp.now(),
      }))
    if (outcome.approved) {
      expect(account.data().figures.actualCost).toBe(6000)
      expect(account.data().sources.counts.supplierInvoices).toBe(1)
      expect(write.time.valueOf() > account.updateTime.valueOf()).toBe(true)
    } else {
      expect([A.CODE.FINAL_ACCOUNT_CHANGED, A.CODE.FINAL_ACCOUNT_NOT_READY]).toContain(outcome.e.details.code)
      expect(account.data().status).toBe('draft')
    }
  })

  it('the draft being WITHDRAWN while its approval is in flight ends in exactly one terminal state', async () => {
    const { outcome, account } = await raceApprovalAgainst(() =>
      faRef(1).update({ status: 'withdrawn', revision: 2, withdrawnBy: 'u_qs', withdrawReason: 'Changed my mind' }))
    const d = account.data()
    if (outcome.approved) {
      // The withdrawal (an unconditional Admin write in this test) landed after
      // and would be refused by Rules for any real client: approved is terminal.
      expect(['approved', 'withdrawn']).toContain(d.status)
    } else {
      expect(outcome.e.details.code).toBe(A.CODE.FINAL_ACCOUNT_NOT_DRAFT)
      expect(d.status).toBe('withdrawn')
      expect(await audits()).toHaveLength(0)
    }
  })
})

// ── Volume: one transaction, one document ────────────────────────────────────

describe('limits, measured', () => {
  it('1,000 cost codes and 1,200 extra payments: read in ONE transaction and stored as ONE document', async () => {
    const extraCodes = 998
    const big = (p) => {
      for (let i = 0; i < extraCodes; i += 1) {
        const id = `x${String(i).padStart(4, '0')}`
        p.costCodes.push({ id, code: `90-${String(i).padStart(4, '0')}`, name: `Extra code ${i} ${'n'.repeat(120)}`, isActive: true })
        p.budgetApprovalSnapshots[0].entries.push({ lineId: `l${id}`, costCodeId: id, costCodeName: `90-${String(i).padStart(4, '0')} — Extra code ${i} ${'n'.repeat(120)}`, budgeted: 1.25 })
        p.forecastLines.push({ id, costCodeId: id, uncommittedCostToComplete: 0 })   // every budgeted code is forecast
      }
      const total = 7000 + extraCodes * 1.25
      p.budgetApprovalSnapshots[0].entryCount = 2 + extraCodes
      p.budgetApprovalSnapshots[0].total = total
      p.budgetApprovals[0] = { ...p.budgetApprovals[0], entryCount: 2 + extraCodes, total }
    }
    const data = readyProject()
    big(data)
    // Seed in chunks (a batch is limited in size, not the transaction under test).
    const at = (i) => A.Timestamp.fromMillis(1_760_000_000_000 + i * 1000)
    await seedProject(p => { p.costCodes = p.costCodes.slice(0, 2) })
    await base().collection('budgetApprovalSnapshots').doc('ba1').set({ ...without(data.budgetApprovalSnapshots[0], 'id'), createdAt: at(0) })
    await base().collection('budgetApprovals').doc('ba1').set({ ...without(data.budgetApprovals[0], 'id'), createdAt: at(0) })
    for (let start = 2; start < data.costCodes.length; start += 400) {
      const batch = A.db.batch()
      data.costCodes.slice(start, start + 400).forEach(({ id, ...rest }, i) => batch.set(A.db.collection('companies').doc(COMPANY_A).collection('costCodes').doc(id), { ...rest, createdAt: at(start + i) }))
      await batch.commit()
    }
    const payments = Array.from({ length: 1200 }, (_, i) => ({
      id: `p${String(i).padStart(4, '0')}`, paymentNumber: `SP-${1000 + i}`, status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete',
      paymentDate: '2026-10-03', amount: 1, allocatedTotal: 0, unallocatedAmount: 1, allocations: [],
    }))
    for (let start = 2; start < data.forecastLines.length; start += 400) {
      const batch = A.db.batch()
      data.forecastLines.slice(start, start + 400).forEach(({ id, ...rest }, i) => batch.set(base().collection('forecastLines').doc(id), { ...rest, createdAt: at(start + i) }))
      await batch.commit()
    }
    for (let start = 0; start < payments.length; start += 400) {
      const batch = A.db.batch()
      payments.slice(start, start + 400).forEach(({ id, ...rest }, i) => batch.set(base().collection('supplierPayments').doc(id), { ...rest, createdAt: at(10 + start + i) }))
      await batch.commit()
    }
    data.supplierPayments.push(...payments)
    await seedDraft(data)

    const started = Date.now()
    const res = await call('u_pm', ok())
    const elapsed = Date.now() - started
    expect(res.status).toBe('approved')
    const snap = await faRef(1).get()
    const d = snap.data()
    expect(d.rows).toHaveLength(1000)
    expect(d.rowCount).toBe(1000)
    expect(d.figures.approvedBudget).toBe(7000 + extraCodes * 1.25)
    expect(d.figures.cashPaid).toBe(5200 + 1200)
    expect(d.figures.unallocatedPayments).toBe(200 + 1200)
    expect(d.sources.counts.supplierPayments).toBe(1201)
    // The stored document, measured: comfortably under Firestore's 1 MiB.
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8')
    expect(bytes).toBeGreaterThan(150000)
    expect(bytes).toBeLessThan(900000)
    expect(elapsed).toBeLessThan(60000)             // far inside the 270-second transaction limit
  }, 120000)
})

// ── Through the deployed wrapper ─────────────────────────────────────────────

describe('the callable as deployed (Functions emulator)', () => {
  beforeEach(async () => { await seedDraft(await seedProject()) })

  it('a request without an App Check token is refused before the handler runs', async () => {
    const user = await clientSignIn('pm@acme.test')
    const r = await callFunction('approveFinalAccount', ok(), { idToken: await user.getIdToken(), appCheck: null })
    expect(r.status).toBe(401)
    expect(r.error).toMatchObject({ status: 'UNAUTHENTICATED' })
    expect((await faDoc(1)).status).toBe('draft')
  })
  it('an unauthenticated request with App Check gets the typed refusal', async () => {
    const r = await callFunction('approveFinalAccount', ok())
    expect(r.status).toBe(401)
    expect(r.error).toMatchObject({ details: { code: 'unauthenticated' } })
  })
  it('a qs is refused with not-approver; an amount in the request is invalid-argument', async () => {
    const qs = await clientSignIn('qs@acme.test')
    const r = await callFunction('approveFinalAccount', ok(), { idToken: await qs.getIdToken() })
    expect(r.status).toBe(403)
    expect(r.error).toMatchObject({ status: 'PERMISSION_DENIED', details: { code: 'not-approver' } })
    await clientSignOutAll()
    const pm = await clientSignIn('pm@acme.test')
    const bad = await callFunction('approveFinalAccount', { ...ok(), figures: { finalProfit: 1 } }, { idToken: await pm.getIdToken() })
    expect(bad.status).toBe(400)
    expect(bad.error).toMatchObject({ details: { code: 'invalid-argument' } })
    expect((await faDoc(1)).status).toBe('draft')
  })
  it('a project manager approves end to end, and a not-ready refusal carries its blockers', async () => {
    const pm = await clientSignIn('pm@acme.test')
    const idToken = await pm.getIdToken()
    await base().collection('forecastLines').doc('cc1').set({ costCodeId: 'cc1', uncommittedCostToComplete: 100 })
    const refused = await callFunction('approveFinalAccount', ok(), { idToken })
    expect(refused.status).toBe(400)
    expect(refused.error).toMatchObject({ status: 'FAILED_PRECONDITION', details: { code: 'final-account-not-ready', blockers: ['costToComplete'] } })
    await base().collection('forecastLines').doc('cc1').set({ costCodeId: 'cc1', uncommittedCostToComplete: 0 })
    const done = await callFunction('approveFinalAccount', ok(), { idToken })
    expect(done.status).toBe(200)
    expect(done.result).toMatchObject({ number: 1, revision: 2, status: 'approved', alreadyApproved: false })
    expect(await faDoc(1)).toMatchObject({ status: 'approved', approvedBy: 'u_pm', approvedByName: 'Pat PM' })
  })
})
