import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { admin, resetEmulators, seedCompany, activateCommercial, seedUser, req, expectTeamError, clock, silentLog, COMPANY_A, COMPANY_B, PROJECT_ID } from './_harness.js'

// ── Phase 2 step 6 (ADR-96) — approval segregation and original contract value
//
// Handlers are called directly against the emulators. The operator tool is run
// as a child process, exactly as an operator would run it.

const HERE = dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = resolve(HERE, '../../functions')
const PROJECT = 'projectA'
let A, sf, cv, vh, H, C, V

const company = (c = COMPANY_A) => A.db.collection('companies').doc(c)
const project = (p = PROJECT) => company().collection('projects').doc(p)
const col = (name) => project().collection(name)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const policy = (segregationEnabled, c = COMPANY_A) => company(c).collection('approvalPolicy').doc('current').set({ segregationEnabled, version: 1, changedBy: 'operator', reason: 'test' })
const auditsOf = async (type) => (await company().collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === type)

function runScript(args, script = 'set-approval-policy.mjs') {
  const r = spawnSync(process.execPath, [resolve(FUNCTIONS, 'scripts', script), ...args], {
    cwd: FUNCTIONS, env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '' }, encoding: 'utf8',
  })
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
}

const PO_LINES = [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 1, unit: 'item', unitPrice: 1000, lineTotal: 1000 }]
const claimReq = (claimId, claimedToDate = 100) => ({
  projectId: PROJECT, claimId, poId: 'po1', periodEnding: '', claimRef: '', notes: '', retention: 0,
  lines: [{ poLineIndex: 0, variationId: null, variationLineIndex: null, claimedToDate }],
})
const claimOp = (uid, operation, request) => H.progressClaimOperation(req(uid, { operation, request }))
async function submittedClaim(id, creator = 'u_qs', submitter = 'u_qs', claimedToDate = 100) {
  await claimOp(creator, 'create', claimReq(id, claimedToDate))
  await col('progressClaims').doc(id).update({ status: 'submitted', submittedBy: submitter, revision: 2 })
}
const approveClaim = (uid, id) => claimOp(uid, 'approve', { projectId: PROJECT, claimId: id, expectedRevision: 2, approvedAmounts: [100], assessmentNotes: '' })
const cvOp = (uid, operation, request) => C.contractValueOperation(req(uid, { operation, request }))

beforeAll(async () => {
  A = await admin()
  sf = await import('../../functions/src/supplierFinance/handlers.js')
  cv = await import('../../functions/src/contractValue/handlers.js')
  vh = await import('../../functions/src/variations/handlers.js')
})

beforeEach(async () => {
  await resetEmulators()
  await seedCompany(COMPANY_A)
  await activateCommercial(COMPANY_A)
  await seedCompany(COMPANY_B)
  await activateCommercial(COMPANY_B)
  for (const [uid, role] of [['u_admin', 'company_admin'], ['u_pm', 'project_manager'], ['u_pm2', 'project_manager'], ['u_qs', 'qs']]) {
    await seedUser({ uid, email: `${uid}@a.test`, role, companyId: COMPANY_A })
  }
  await seedUser({ uid: 'u_other', email: 'o@b.test', role: 'company_admin', companyId: COMPANY_B })
  await project().set({ name: 'A', status: 'active', currency: 'AUD' })
  await col('purchaseOrders').doc('po1').set({ poNumber: 'PO-0001', status: 'sent', supplierName: 'S', supplierId: 's1', lineItems: PO_LINES, subtotal: 1000, gst: 100, total: 1100 })
  const now = clock('2026-11-28T02:00:00Z')
  H = sf.createSupplierFinanceHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled: true }) })
  C = cv.createContractValueHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled: true }) })
  V = vh.createVariationHandlers({ db: A.db, now, log: silentLog, config: () => ({ enabled: true }) })
})

describe('approval segregation — the company policy (D4, D5)', () => {
  it('DISABLED (absent policy): the creator may approve — and the audit event records that the approver created, submitted and edited it', async () => {
    await submittedClaim('c1')
    await approveClaim('u_qs', 'c1')
    const [event] = await auditsOf('progress_claim.approved')
    expect(event.after.segregation).toMatchObject({ policyEnabled: false, isCreator: true, isSubmitter: true, independent: false })
  })

  it('ENABLED (D4): the creator, the submitter and the LAST MATERIAL editor are refused; a colleague’s cosmetic edit neither hides the material editor nor excludes the colleague; no administrator exception', async () => {
    await policy(true)
    await claimOp('u_qs', 'create', claimReq('c1'))
    // The PM makes a MATERIAL edit (the amount); the admin then makes a COSMETIC one (a note).
    await claimOp('u_pm', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, periodEnding: '', claimRef: '', notes: '', retention: 0, claimedToDate: [150] })
    await claimOp('u_admin', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: 2, periodEnding: '', claimRef: '', notes: 'tidy', retention: 0, claimedToDate: [150] })
    // The cosmetic edit did not take the stamp; the audit list has all three.
    expect(await data(col('progressClaims').doc('c1'))).toMatchObject({ lastMaterialEditBy: 'u_pm', updatedBy: 'u_admin', draftEditors: ['u_qs', 'u_pm', 'u_admin'] })
    await col('progressClaims').doc('c1').update({ status: 'submitted', submittedBy: 'u_qs', revision: 4 })
    const approve = (uid) => claimOp(uid, 'approve', { projectId: PROJECT, claimId: 'c1', expectedRevision: 4, approvedAmounts: [150], assessmentNotes: '' })
    for (const uid of ['u_qs', 'u_pm']) {
      const err = await expectTeamError(approve(uid), 'approval-segregation-required')
      expect(err.message).toMatch(/another authorised member/)
    }
    expect((await data(col('progressClaims').doc('c1'))).status).toBe('submitted')
    // The admin only tidied a note: an independent reviewer of the PM's figures.
    await approve('u_admin')
    const [event] = await auditsOf('progress_claim.approved')
    expect(event.after.segregation).toMatchObject({ policyEnabled: true, independent: true, wasEarlierEditor: true, isLastMaterialEditor: false })
  })

  it('ENABLED (D4): an EARLIER material editor whose figures a colleague has since re-prepared may approve; the colleague may not', async () => {
    await policy(true)
    await claimOp('u_qs', 'create', claimReq('c1'))
    await claimOp('u_pm', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: 1, periodEnding: '', claimRef: '', notes: '', retention: 0, claimedToDate: [150] })
    await claimOp('u_pm2', 'update', { projectId: PROJECT, claimId: 'c1', expectedRevision: 2, periodEnding: '', claimRef: '', notes: '', retention: 0, claimedToDate: [175] })
    expect((await data(col('progressClaims').doc('c1'))).lastMaterialEditBy).toBe('u_pm2')
    await col('progressClaims').doc('c1').update({ status: 'submitted', submittedBy: 'u_qs', revision: 4 })
    const approve = (uid) => claimOp(uid, 'approve', { projectId: PROJECT, claimId: 'c1', expectedRevision: 4, approvedAmounts: [175], assessmentNotes: '' })
    await expectTeamError(approve('u_pm2'), 'approval-segregation-required')
    await expectTeamError(approve('u_qs'), 'approval-segregation-required')
    await approve('u_pm')
  })

  it('ACTOR STAMPS cannot be supplied: a request carrying lastMaterialEditBy / draftEditors / createdBy is refused; a legacy draft without the stamp excludes its last editor', async () => {
    await policy(true)
    for (const key of ['lastMaterialEditBy', 'draftEditors', 'createdBy', 'updatedBy', 'submittedBy']) {
      await expectTeamError(claimOp('u_qs', 'create', { ...claimReq('cx'), [key]: 'u_pm2' }), 'invalid-argument')
    }
    expect(await data(col('progressClaims').doc('cx'))).toBeNull()
    // A legacy submitted claim (no backend stamp): createdBy u_qs, last edited by u_pm.
    await claimOp('u_qs', 'create', claimReq('c2'))
    const { FieldValue } = A
    await col('progressClaims').doc('c2').update({ status: 'submitted', submittedBy: 'u_qs', updatedBy: 'u_pm', revision: 2, lastMaterialEditBy: FieldValue.delete(), draftEditors: FieldValue.delete() })
    const approve = (uid) => claimOp(uid, 'approve', { projectId: PROJECT, claimId: 'c2', expectedRevision: 2, approvedAmounts: [100], assessmentNotes: '' })
    await expectTeamError(approve('u_pm'), 'approval-segregation-required')
    await approve('u_pm2')
  })

  it('ENABLED: the same rule for supplier invoice approval, credit-note posting and variation approval; a PAYMENT posting is recorded, not segregated', async () => {
    await policy(true)
    await submittedClaim('c1', 'u_qs', 'u_qs')
    await approveClaim('u_pm', 'c1')
    const rev = (await data(col('progressClaims').doc('c1'))).revision
    await H.supplierInvoiceOperation(req('u_qs', { operation: 'create', request: {
      projectId: PROJECT, invoiceId: 'i1', source: 'progress_claim', sourceId: 'c1', expectedSourceRevision: rev,
      supplierInvoiceNumber: 'X', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null, lines: [{ lineIndex: 0, amount: null, taxCode: 'gst' }],
    } }))
    await expectTeamError(H.supplierInvoiceOperation(req('u_qs', { operation: 'approve', request: { projectId: PROJECT, invoiceId: 'i1', expectedRevision: 1 } })), 'approval-segregation-required')
    await H.supplierInvoiceOperation(req('u_pm', { operation: 'approve', request: { projectId: PROJECT, invoiceId: 'i1', expectedRevision: 1 } }))
    // Posting after an independent approval: the preparer may post.
    await H.supplierInvoiceOperation(req('u_qs', { operation: 'post', request: { projectId: PROJECT, invoiceId: 'i1', expectedRevision: 2 } }))

    await H.supplierSettlementOperation(req('u_qs', { operation: 'saveCredit', request: {
      projectId: PROJECT, creditNoteId: 'cn1', expectedRevision: null, supplierInvoiceId: 'i1', supplierCreditReference: '', creditDate: '2026-11-28', reason: 'x', notes: '',
      lines: [{ costCodeId: 'cc1', taxCode: 'gst', description: 'x', amount: 10 }],
    } }))
    await expectTeamError(H.supplierSettlementOperation(req('u_qs', { operation: 'postCredit', request: { projectId: PROJECT, documentId: 'cn1', expectedRevision: 1 } })), 'approval-segregation-required')
    await H.supplierSettlementOperation(req('u_pm2', { operation: 'postCredit', request: { projectId: PROJECT, documentId: 'cn1', expectedRevision: 1 } }))
    // Ruling B: VOIDING the posted credit undoes an independently approved fact —
    // its preparer may not do it alone; its independent poster may.
    const voidCredit = (uid) => H.supplierSettlementOperation(req(uid, { operation: 'voidCredit', request: { projectId: PROJECT, documentId: 'cn1', expectedRevision: 2, voidReason: 'Raised in error' } }))
    await expectTeamError(voidCredit('u_qs'), 'approval-segregation-required')
    expect((await data(col('supplierCreditNotes').doc('cn1'))).status).toBe('posted')
    await voidCredit('u_pm2')
    const [voided] = await auditsOf('supplier_credit_note.voided')
    expect(voided.after.segregation).toMatchObject({ policyEnabled: true, independent: true })

    await company().collection('contacts').doc('s1').set({ displayName: 'S', isActive: true })
    await H.supplierSettlementOperation(req('u_qs', { operation: 'savePayment', request: {
      projectId: PROJECT, paymentId: 'p1', expectedRevision: null, supplierId: 's1', paymentDate: '2026-11-28', amount: 5, paymentMethod: 'bank_transfer',
      paymentMethodOther: '', bankReference: '', remittanceReference: '', externalReference: '', notes: '', allocations: [{ supplierInvoiceId: 'i1', allocatedAmount: 5 }],
    } }))
    expect((await H.supplierSettlementOperation(req('u_qs', { operation: 'postPayment', request: { projectId: PROJECT, documentId: 'p1', expectedRevision: 1 } }))).alreadyApplied).toBe(false)
    const [paid] = await auditsOf('supplier_payment.posted')
    expect(paid.after.segregation).toBeNull()
    expect(paid.after.actor).toMatchObject({ isCreator: true })

    // Variations (ADR-90): the creator cannot approve.
    await company().collection('costCodes').doc('cc2').set({ code: '05', name: 'Steel' })
    await V.createVariation(req('u_qs', {
      projectId: PROJECT, variationId: 'v1', variationType: 'supplier', title: 'T', description: '', reason: 'design_change',
      clientId: null, clientName: null, clientRef: null, supplierId: 's1', supplierName: 'S', supplierRef: '', poId: null,
      originRfiId: null, identifiedDate: '2026-11-01', submittedDate: '', responseDueDate: '', effectiveDate: '', notes: '',
      lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'x', submittedAmount: 10, taxCode: 'gst' }],
    }))
    await col('variations').doc('v1').update({ status: 'submitted', submittedBy: 'u_qs', revision: 2 })
    await expectTeamError(V.approveVariation(req('u_qs', { projectId: PROJECT, variationId: 'v1', expectedRevision: 2, approvedAmounts: [10], assessmentNotes: '', approvedDate: '2026-11-28' })), 'approval-segregation-required')
    await V.approveVariation(req('u_pm', { projectId: PROJECT, variationId: 'v1', expectedRevision: 2, approvedAmounts: [10], assessmentNotes: '', approvedDate: '2026-11-28' }))
  })

  it('POSTING AFTER A NON-INDEPENDENT APPROVAL: an invoice its creator approved while the policy was disabled cannot be posted by that creator once it is enabled; an independent member posts it', async () => {
    await submittedClaim('c1', 'u_qs', 'u_qs')
    await approveClaim('u_pm', 'c1')
    const rev = (await data(col('progressClaims').doc('c1'))).revision
    await H.supplierInvoiceOperation(req('u_qs', { operation: 'create', request: {
      projectId: PROJECT, invoiceId: 'i1', source: 'progress_claim', sourceId: 'c1', expectedSourceRevision: rev,
      supplierInvoiceNumber: 'X', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null, lines: [{ lineIndex: 0, amount: null, taxCode: 'gst' }],
    } }))
    // Policy disabled: the creator approves their own invoice (recorded).
    await H.supplierInvoiceOperation(req('u_qs', { operation: 'approve', request: { projectId: PROJECT, invoiceId: 'i1', expectedRevision: 1 } }))
    await policy(true)
    const post = (uid) => H.supplierInvoiceOperation(req(uid, { operation: 'post', request: { projectId: PROJECT, invoiceId: 'i1', expectedRevision: 2 } }))
    await expectTeamError(post('u_qs'), 'approval-segregation-required')
    expect((await data(col('supplierInvoices').doc('i1'))).status).toBe('approved')
    await post('u_pm')
    const [event] = await auditsOf('supplier_invoice.posted')
    expect(event.after.segregation).toMatchObject({ policyEnabled: true, approvalIndependent: false, independent: true })
    // And an approved invoice admits no edit, so posting cannot carry changed facts.
    await expectTeamError(H.supplierInvoiceOperation(req('u_pm', { operation: 'update', request: {
      projectId: PROJECT, invoiceId: 'i1', expectedRevision: 3, supplierInvoiceNumber: 'Y', invoiceDate: '2026-11-28', receivedDate: '', dueDate: '', notes: '', retention: null, lines: null,
    } })), 'supplier-finance-invalid')
  })

  it('a policy of ANOTHER company does not apply; a member deactivated before approving is refused; the only remaining approver being the preparer fails CLOSED with the reason', async () => {
    await policy(true, COMPANY_B)
    await submittedClaim('c1')
    await approveClaim('u_qs', 'c1')   // company A's policy is absent → disabled
    await policy(true)
    await submittedClaim('c2', 'u_pm', 'u_pm', 200)   // a second claim on the PO: 100 more this period
    await A.db.collection('users').doc('u_pm2').update({ status: 'deactivated', companyId: null, role: null })
    await expectTeamError(approveClaim('u_pm2', 'c2'), 'membership-inactive')
    await expectTeamError(approveClaim('u_pm', 'c2'), 'approval-segregation-required')
    expect((await data(col('progressClaims').doc('c2'))).status).toBe('submitted')
  })
})

describe('the operator tool — scripts/set-approval-policy.mjs (D5)', () => {
  const base = ['--project', PROJECT_ID, '--company', COMPANY_A, '--reason', 'Finance controller request #12']
  it('dry run by default; --enable --apply writes the policy with version, reason and previous, and one audit event', async () => {
    const dry = runScript([...base, '--enable'])
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toContain('Dry run — nothing written')
    expect(await data(company().collection('approvalPolicy').doc('current'))).toBeNull()
    const applied = runScript([...base, '--enable', '--apply'])
    expect(applied.code, applied.out).toBe(0)
    expect(await data(company().collection('approvalPolicy').doc('current'))).toMatchObject({ segregationEnabled: true, version: 1, changedBy: 'operator', reason: 'Finance controller request #12', previous: null })
    const [event] = await auditsOf('approval_policy.changed')
    expect(event).toMatchObject({ actorUid: 'operator', before: { segregationEnabled: false }, after: { segregationEnabled: true, version: 1 } })
    const off = runScript([...base, '--disable', '--apply'])
    expect(off.code, off.out).toBe(0)
    expect(await data(company().collection('approvalPolicy').doc('current'))).toMatchObject({ segregationEnabled: false, version: 2, previous: { segregationEnabled: true, version: 1 } })
  })
  it('D3 #46: the dry run lists open POs / tender packages with no recorded preparer (ids only) before enabling', async () => {
    await col('purchaseOrders').doc('poLegacy').set({ poNumber: 'PO-0099', status: 'pending_approval', createdBy: 'u_qs' })
    await col('tenderPackages').doc('tpLegacy').set({ tenderNumber: 'TP-0099', status: 'issued', createdBy: 'u_qs' })
    await col('tenderPackages').doc('tpStamped').set({ tenderNumber: 'TP-0098', status: 'issued', createdBy: 'u_qs', lastMaterialEditBy: 'u_qs' })
    const dry = runScript([...base, '--enable'])
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toContain('open POs / tender packages with no recorded preparer: 2')
    expect(dry.out).toContain(`${PROJECT}/purchaseOrders/poLegacy (pending_approval)`)
    expect(dry.out).toContain(`${PROJECT}/tenderPackages/tpLegacy (issued)`)
    expect(dry.out).not.toContain('tpStamped')
    expect(dry.out).not.toContain('PO-0099')
  })
  it('enabling is REFUSED with fewer than two active company_admin / project_manager members; a reason is required', async () => {
    await A.db.collection('users').doc('u_pm').update({ status: 'deactivated', companyId: null, role: null })
    await A.db.collection('users').doc('u_pm2').update({ status: 'deactivated', companyId: null, role: null })
    const r = runScript([...base, '--enable', '--apply'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/needs at least 2 active company_admin or project_manager members; this company has 1/)
    expect(await data(company().collection('approvalPolicy').doc('current'))).toBeNull()
    expect(runScript(['--project', PROJECT_ID, '--company', COMPANY_A, '--enable']).code).toBe(2)
  })
})

describe('the operator tool — scripts/set-commercial-completion.mjs (Phase 2 company activation)', () => {
  const run = (args) => runScript(['--project', PROJECT_ID, '--reason', 'TEST company acceptance window', ...args], 'set-commercial-completion.mjs')
  it('dry run by default; --apply writes the field and ONE audit event; a repeat changes nothing; --disable is recorded; segregation is NOT touched', async () => {
    await activateCommercial(COMPANY_B, false)
    const dry = run(['--company', COMPANY_B, '--enable'])
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toContain('Dry run — nothing written')
    expect((await data(A.db.collection('companies').doc(COMPANY_B))).commercialCompletionEnabled).toBe(false)
    expect(run(['--company', COMPANY_B, '--enable', '--apply']).code).toBe(0)
    expect((await data(A.db.collection('companies').doc(COMPANY_B))).commercialCompletionEnabled).toBe(true)
    const again = run(['--company', COMPANY_B, '--enable', '--apply'])
    expect(again.out).toContain('No change')
    const events = (await A.db.collection('companies').doc(COMPANY_B).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === 'company.commercial_completion_set')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorUid: 'operator', before: { commercialCompletionEnabled: false }, after: { commercialCompletionEnabled: true, reason: 'TEST company acceptance window' } })
    expect(run(['--company', COMPANY_B, '--disable', '--apply']).code).toBe(0)
    expect((await data(A.db.collection('companies').doc(COMPANY_B))).commercialCompletionEnabled).toBe(false)
    // Activation never creates a segregation policy.
    expect((await A.db.collection('companies').doc(COMPANY_B).collection('approvalPolicy').doc('current').get()).exists).toBe(false)
  })
  it('an unknown company is refused; a reason is required; exactly one of --enable / --disable', async () => {
    expect(run(['--company', 'nope', '--enable', '--apply']).code).toBe(1)
    expect(runScript(['--project', PROJECT_ID, '--company', COMPANY_A, '--enable'], 'set-commercial-completion.mjs').code).toBe(2)
    expect(run(['--company', COMPANY_A, '--enable', '--disable']).code).toBe(2)
  })
  it('two operators enabling at once: one change and one audit event', async () => {
    await activateCommercial(COMPANY_B, false)
    const { spawn } = await import('node:child_process')
    const go = () => new Promise(res => {
      const c = spawn(process.execPath, [resolve(FUNCTIONS, 'scripts', 'set-commercial-completion.mjs'), '--project', PROJECT_ID, '--company', COMPANY_B, '--enable', '--reason', 'Concurrent activation test', '--apply'], { cwd: FUNCTIONS, env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '' } })
      c.on('exit', code => res(code))
    })
    expect(await Promise.all([go(), go()])).toEqual([0, 0])
    const events = (await A.db.collection('companies').doc(COMPANY_B).collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === 'company.commercial_completion_set')
    expect(events).toHaveLength(1)
  })
})

describe('original contract value — protected after setup, corrected through an audited process (G5)', () => {
  const baseline = (o = {}) => col('commercial').doc('baseline').set({ originalContractValue: 1000000, originalApprovedBudget: null, notes: '', createdBy: 'u_pm', updatedBy: 'u_pm', ...o })
  const propose = (uid, revisionId, fromValue, toValue) => cvOp(uid, 'propose', { projectId: PROJECT, revisionId, fromValue, toValue, reason: 'Executed contract amendment No. 1', confirmsNotAVariation: true })

  it('Phase 2 company activation: an INACTIVE company cannot propose (nothing written); deactivating between propose and approve refuses the approval', async () => {
    await baseline()
    await activateCommercial(COMPANY_A, false)
    await expectTeamError(propose('u_qs', 'r0', 1000000, 1100000), 'commercial-completion-not-activated')
    expect(await data(col('contractValueRevisions').doc('r0'))).toBeNull()
    await activateCommercial(COMPANY_A, true)
    await propose('u_qs', 'r1', 1000000, 1100000)
    await activateCommercial(COMPANY_A, false)
    await expectTeamError(cvOp('u_pm', 'approve', { projectId: PROJECT, revisionId: 'r1' }), 'commercial-completion-not-activated')
    expect((await data(col('commercial').doc('baseline'))).originalContractValue).toBe(1000000)
  })

  it('propose → approve replaces the value with provenance and one audit event each; the history is kept', async () => {
    await baseline()
    await propose('u_qs', 'r1', 1000000, 1012500.5)
    expect(await data(col('contractValueRevisions').doc('r1'))).toMatchObject({ status: 'proposed', fromValue: 1000000, toValue: 1012500.5, proposedBy: 'u_qs', confirmsNotAVariation: true })
    await cvOp('u_pm', 'approve', { projectId: PROJECT, revisionId: 'r1' })
    expect(await data(col('commercial').doc('baseline'))).toMatchObject({ originalContractValue: 1012500.5, originalContractValueVersion: 1, originalContractValueRevisedBy: 'u_pm', originalContractValueRevisionId: 'r1' })
    expect(await data(col('contractValueRevisions').doc('r1'))).toMatchObject({ status: 'approved', approvedBy: 'u_pm', toVersion: 1 })
    expect((await auditsOf('contract_value.proposed')).length + (await auditsOf('contract_value.approved')).length).toBe(2)
  })

  it('refusals: no baseline, a stale "from" value, no change, a second open proposal, a missing confirmation, a short reason', async () => {
    await expectTeamError(propose('u_qs', 'r0', 1, 2), 'contract-value-invalid')
    await baseline()
    await expectTeamError(propose('u_qs', 'r1', 999999, 2), 'contract-value-stale')
    await expectTeamError(propose('u_qs', 'r1', 1000000, 1000000), 'contract-value-invalid')
    await propose('u_qs', 'r1', 1000000, 2)
    await expectTeamError(propose('u_pm', 'r2', 1000000, 3), 'contract-value-invalid')
    await expectTeamError(cvOp('u_qs', 'propose', { projectId: PROJECT, revisionId: 'r3', fromValue: 1000000, toValue: 4, reason: 'Executed contract amendment', confirmsNotAVariation: false }), 'invalid-argument')
    await expectTeamError(cvOp('u_qs', 'propose', { projectId: PROJECT, revisionId: 'r3', fromValue: 1000000, toValue: 4, reason: 'short', confirmsNotAVariation: true }), 'invalid-argument')
  })

  it('two proposals at once: exactly one is open', async () => {
    await baseline()
    const results = await Promise.allSettled([propose('u_qs', 'a', 1000000, 5), propose('u_pm', 'b', 1000000, 6)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await col('contractValueRevisions').where('status', '==', 'proposed').get()).size).toBe(1)
  })

  it('segregation: with the policy enabled the proposer cannot approve; an approval after the value moved is stale; withdraw frees the project for a new proposal', async () => {
    await baseline()
    await policy(true)
    await propose('u_qs', 'r1', 1000000, 2)
    await expectTeamError(cvOp('u_qs', 'approve', { projectId: PROJECT, revisionId: 'r1' }), 'approval-segregation-required')
    await cvOp('u_qs', 'withdraw', { projectId: PROJECT, revisionId: 'r1', reason: 'Raised in error, wrong figure' })
    await propose('u_qs', 'r2', 1000000, 3)
    await col('commercial').doc('baseline').update({ originalContractValue: 7 })   // moved behind the backend's back
    await expectTeamError(cvOp('u_pm', 'approve', { projectId: PROJECT, revisionId: 'r2' }), 'contract-value-stale')
    expect((await data(col('commercial').doc('baseline'))).originalContractValue).toBe(7)
  })
})
