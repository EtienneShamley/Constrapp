import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore'
import { TAX_CODE, gstForLine, variationTotals, buildApprovedLineItems, isCommitmentApplied, isScopeCommitted } from '../../src/lib/variations'
import { buildClaimLine, buildVariationClaimLine, claimTotals } from '../../src/lib/progressClaims'
import { invoiceTotals } from '../../src/lib/supplierInvoices'

// ── The STAGE-1 TRANSITIONAL ruleset — emulator proof (ADR-63 · ADR-68 · ADR-90) ─
//
// `firestore.transitional.rules` is derived from `firestore.rules` by
// scripts/build-transitional-rules.mjs (three rule lines differ; pinned by
// tests/unit/rulesTransitional.test.js).
//
// ⚠️ ADR-90 RETIRED THE VARIATIONS HALF OF THIS FILE'S ORIGINAL PURPOSE. Stage 1
// used to relax ONE variations line — the ADR-63 scope pair was optional on a
// PO-linked approve while the M3-B1 bundle was served. Creating a variation,
// approving one and the legacy Apply / Commit are now trusted-backend
// operations; NEITHER ruleset has a client create, approve or apply path, so
// the two files no longer differ anywhere in `variations`. The variation
// describes below therefore prove, against THIS file, that it refuses those
// three writes exactly as the FINAL file does — the M3-B1 payload, the M3-B2
// payload and the plain one alike, for every financial role, with nothing
// written — while every forged or cross-tenant variant stays refused. The
// supported replacements are proven in tests/functions/variations.test.js
// (createVariation / approveVariation / applyVariationCommitment).
//
// What Stage 1 still relaxes, and this file still proves POSITIVELY:
//   · the M3-B1 bundle's claim create (no `variationLineCount`) is ACCEPTED,
//     the new bundle's (with it) is ACCEPTED, and the ADR-63 count pin, shape
//     pins and invoice-count guard are ACTIVE from Stage 1 on;
//   · the pre-2A claim create (no invoice link keys) is ACCEPTED while the
//     invoice-side pairing is strict.
//
// The FINAL ruleset's behaviour is proven by tests/rules/variations.rules.test.js
// and tests/rules/progressClaims.rules.test.js against firestore.rules.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.transitional.rules')

const PROJECT_ID = 'demo-constrap-test'
const COMPANY_A = 'companyA'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'
const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: 'companyB' },
}
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const PO = {
  sent:   { id: 'poSent',   poNumber: 'PO-0001', status: 'sent',   supplierName: 'Steel Co', supplierId: 'contactS1' },
  closed: { id: 'poClosed', poNumber: 'PO-0002', status: 'closed', supplierName: 'Steel Co', supplierId: 'contactS1' },
}
const PO_IN_PROJECT_B = { id: 'poProjB', poNumber: 'PO-0001', status: 'sent', supplierName: 'Steel Co', supplierId: 'contactS1' }
const PO_LINE = { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 10, unit: 'm3', unitPrice: 250, lineTotal: 2500 }

let testEnv
const varsPath   = (projectId = PROJECT_A) => `companies/${COMPANY_A}/projects/${projectId}/variations`
const posPath    = (projectId = PROJECT_A) => `companies/${COMPANY_A}/projects/${projectId}/purchaseOrders`
const claimsPath = () => `companies/${COMPANY_A}/projects/${PROJECT_A}/progressClaims`
const invPath    = () => `companies/${COMPANY_A}/projects/${PROJECT_A}/supplierInvoices`
const ctx    = (user) => testEnv.authenticatedContext(user.uid).firestore()
const varRef = (db, id) => doc(db, varsPath(), id)

const line = (amount, { costCodeId = 'cc1', costCodeName = '03-100 — Concrete', taxCode = TAX_CODE.GST, poLineIndex = 0 } = {}) => ({
  costCodeId, costCodeName, description: 'Extra steel',
  submittedAmount: amount, submittedGst: gstForLine(amount, taxCode),
  approvedAmount: null, approvedGst: null, poLineIndex, taxCode,
})
const LINES = [line(900)]
const stamps  = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })
const applied = (user) => ({ commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: user.uid })
const scoped  = (user) => ({ scopeCommittedAt: serverTimestamp(), scopeCommittedBy: user.uid })
const both    = (user) => ({ ...applied(user), ...scoped(user) })

function payload(user, overrides = {}) {
  const t = variationTotals(LINES, 'submitted')
  return {
    variationNumber: 'SV-0001', variationType: 'supplier', status: 'draft',
    title: 'Additional steel', description: '', reason: '',
    clientId: null, clientName: null, clientRef: null,
    supplierId: PO.sent.supplierId, supplierName: PO.sent.supplierName, supplierRef: '',
    poId: PO.sent.id, poNumber: PO.sent.poNumber,
    originRfiId: null, originRfiNumber: null, originRfiTitle: null,
    lineItems: LINES,
    submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null, forecastAmount: null,
    identifiedDate: '2026-10-10', submittedDate: '', responseDueDate: '', approvedDate: '', effectiveDate: '',
    currency: 'AUD', revision: 1, notes: '', assessmentNotes: '',
    submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null,
    rejectedAt: null, rejectedBy: null, withdrawnAt: null, withdrawnBy: null,
    attachments: [], externalRefs: {}, supersededByVariationId: null,
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
const manual = (user) => payload(user, { poId: null, poNumber: null })
const clientPayload = (user) => payload(user, {
  variationNumber: 'CV-0001', variationType: 'client', clientId: 'contactC1', clientName: 'Owner Pty Ltd', clientRef: 'VO-7',
  supplierId: null, supplierName: null, supplierRef: null, poId: null, poNumber: null,
  lineItems: [line(900, { poLineIndex: null })],
})

// Approve over a SUBMITTED seed, in the three client shapes.
function approvePlain(user, extra = {}) {
  const lines = buildApprovedLineItems(LINES, [900])
  const t = variationTotals(lines, 'approved')
  return {
    status: 'approved', lineItems: lines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
    assessmentNotes: '', approvedDate: '2026-10-12', effectiveDate: '2026-10-12',
    approvedAt: serverTimestamp(), approvedBy: user.uid, revision: 2, ...stamps(user), ...extra,
  }
}
const approveB1   = (user, extra = {}) => approvePlain(user, { ...applied(user), ...extra })   // the M3-B1 bundle
const approveNew  = (user, extra = {}) => approvePlain(user, { ...both(user), ...extra })      // the M3-B2 bundle
const applyWrite  = (user, extra = {}) => ({ ...both(user), revision: 2, ...stamps(user), ...extra })
const scopeWrite  = (user, extra = {}) => ({ ...scoped(user), revision: 2, ...stamps(user), ...extra })
const submitWrite = (user) => ({ status: 'submitted', submittedDate: '2026-10-11', submittedAt: serverTimestamp(), submittedBy: user.uid, revision: 2, ...stamps(user) })
const withdrawWrite = (user) => ({ status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid, revision: 2, ...stamps(user) })

async function seed(id, status, base, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    const approvedLines = buildApprovedLineItems(base.lineItems, base.lineItems.map(l => l.submittedAmount))
    const t = variationTotals(approvedLines, 'approved')
    const lifecycle =
      status === 'submitted' ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: 'u_admin' } :
      status === 'approved'  ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: 'u_admin', approvedAt: now, approvedBy: 'u_admin',
                                 lineItems: approvedLines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total, approvedDate: '2026-10-12', effectiveDate: '2026-10-12' } :
      { status: 'draft' }
    await setDoc(doc(c.firestore(), varsPath(), id), { ...base, createdAt: now, updatedAt: now, ...lifecycle, ...extra })
  })
}
async function seedPo(po, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    await setDoc(doc(c.firestore(), posPath(projectId), po.id), {
      poNumber: po.poNumber, status: po.status, supplierName: po.supplierName, supplierId: po.supplierId, description: 'Level 1', notes: '',
      lineItems: [PO_LINE],
      subtotal: 2500, gst: 250, total: 2750, currency: 'AUD', revision: 1,
      sentAt: now, sentBy: null, closedAt: po.status === 'closed' ? now : null, closedBy: null, cancelledAt: null, cancelledBy: null,
      externalRefs: {}, createdAt: now, createdBy: 'u_admin',
    })
  })
}
async function setPoStatus(po, status) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), posPath(), po.id), { status }) })
}
// ADR-90 — what the trusted backend stores, written with rules disabled.
async function serverUpdate(id, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), varsPath(), id), data) })
}
// A client update is refused for EVERY financial role and the document does not move.
async function updateRefused(id, build) {
  const before = await readVar(id)
  for (const user of FINANCIAL) await assertFails(updateDoc(varRef(ctx(user), id), build(user)))
  expect(await readVar(id)).toEqual(before)
}
async function readVar(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), varsPath(), id))
    data = snap.exists() ? { id: snap.id, ...snap.data() } : undefined
  })
  return data
}

// ── Claims and invoices (ADR-63), as the two bundles write them ──────────────
const VAR_ROW = { variationId: 'svScoped', variationNumber: 'SV-0007', lineIndex: 0, amount: 4000, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'New scope' }
const poClaimLine  = (toDate = 1000) => buildClaimLine(PO_LINE, { poLineIndex: 0, previouslyApproved: 0, claimedToDate: toDate })
const varClaimLine = (toDate = 2000) => buildVariationClaimLine(VAR_ROW, { previouslyApproved: 0, claimedToDate: toDate })
function claimPayload(user, { lines = [poClaimLine()], variationLineCount, ...overrides } = {}) {
  const t = claimTotals(lines.map(li => li.claimedThisPeriod), 0)
  return {
    claimNumber: 'PC-0001', status: 'draft', poId: PO.sent.id, poNumber: PO.sent.poNumber,
    supplierName: PO.sent.supplierName, supplierId: PO.sent.supplierId,
    claimRef: 'S-1', periodEnding: '2026-08-31', variationId: null,
    ...(variationLineCount === undefined ? {} : { variationLineCount }),
    lineItems: lines,
    retention: t.retention, claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
    notes: '', assessmentNotes: '', currency: 'AUD', revision: 1,
    submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
    externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
async function seedApprovedClaim(id, lines, variationLineCount) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    const approvedLines = lines.map(li => ({ ...li, approvedThisPeriod: li.claimedThisPeriod }))
    const t = claimTotals(approvedLines.map(li => li.approvedThisPeriod), 0)
    const base = claimPayload(USERS.admin, { lines: approvedLines, ...(variationLineCount === undefined ? {} : { variationLineCount }) })
    await setDoc(doc(c.firestore(), claimsPath(), id), {
      ...base, status: 'approved', createdAt: now, updatedAt: now, submittedAt: now, submittedBy: 'u_admin', approvedAt: now, approvedBy: 'u_admin',
      approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
      // ADR-68: new-format (unlinked) so the claim can be invoiced through the pairing.
      supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null,
    })
  })
}
const invLine = (amount, over = {}) => ({ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount, taxCode: 'gst', gstAmount: gstForLine(amount, 'gst'), ...over })
const varInvLine = (amount) => invLine(amount, { poLineIndex: null, variationId: VAR_ROW.variationId, variationNumber: VAR_ROW.variationNumber, variationLineIndex: 0, description: 'New scope' })
function invoicePayload(user, { claimId, lines, variationLineCount, ...overrides } = {}) {
  const totals = invoiceTotals(lines, 0)
  return {
    invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-1', status: 'draft', docType: 'invoice', source: 'progress_claim',
    supplierId: PO.sent.supplierId, supplierName: PO.sent.supplierName, poId: PO.sent.id, poNumber: PO.sent.poNumber,
    progressClaimId: claimId, claimNumber: 'PC-0001',
    ...(variationLineCount === undefined ? {} : { variationLineCount }),
    invoiceDate: '2026-08-05', receivedDate: '2026-08-06', dueDate: '2026-09-05', paymentTerms: null,
    lineItems: lines, ...totals, currency: 'AUD', revision: 1, notes: '',
    approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
    paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set — run `npm run test:rules`.')
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const rules = readFileSync(RULES_PATH, 'utf8')
  if (!rules.includes('TRANSITIONAL (STAGE 1)')) throw new Error('firestore.transitional.rules does not carry the transitional marker')
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules, host, port: Number(port) } })
})
afterAll(async () => { if (testEnv) await testEnv.cleanup() })
beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    // ADR-98: the claim submit / variation lifecycle Rules require an ACTIVATED company.
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'AU', baseCurrency: 'AUD', commercialCompletionEnabled: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD', currencyLocked: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'Project B', currency: 'AUD' })
  })
  await seedPo(PO.sent)
  await seedPo(PO.closed)
  await seedPo(PO_IN_PROJECT_B, PROJECT_B)
})

describe('STAGE 1 — the M3-B1 bundle’s variation writes (ADR-90: REFUSED from every client, exactly as in the FINAL file)', () => {
  // Positive behaviour: tests/functions/variations.test.js → approveVariation / applyVariationCommitment.
  it('ADR-90 — a PO-linked supplier approve WITH the applied pair only is REFUSED from every client against a sent and a closed PO; the scope-only write and the full legacy Apply are refused too, before and after the backend has approved', async () => {
    for (const po of [PO.sent, PO.closed]) {
      const id = `b1_${po.id}`
      await seed(id, 'submitted', payload(USERS.admin, { poId: po.id, poNumber: po.poNumber }))
      await updateRefused(id, (user) => approveB1(user))
      const v = await readVar(id)
      expect(v.status).toBe('submitted')
      expect(isCommitmentApplied(v)).toBe(false)
      expect(isScopeCommitted(v)).toBe(false)
      // The document an M3-B1 approval left behind (applied pair, no scope pair): the scope-only write and the full Apply are both refused.
      await serverUpdate(id, approveB1(USERS.pm))
      expect(isCommitmentApplied(await readVar(id))).toBe(true)
      await updateRefused(id, (user) => applyWrite(user, { revision: 3 }))
      await updateRefused(id, (user) => scopeWrite(user, { revision: 3 }))
      expect(isScopeCommitted(await readVar(id))).toBe(false)
    }
  })

  it('the pre-M3-B1 approve payload (NO pair at all) is REFUSED', async () => {
    await seed('v1', 'submitted', payload(USERS.admin))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approvePlain(USERS.admin)))
    expect((await readVar('v1')).status).toBe('submitted')
  })

  it('ADR-90 — the M3-B1 bundle’s create is REFUSED from every client; its submit and withdraw are unchanged', async () => {
    for (const user of FINANCIAL) await assertFails(setDoc(varRef(ctx(user), 'c1'), payload(user)))
    expect(await readVar('c1')).toBeUndefined()
    await seed('c1', 'draft', payload(USERS.qs))
    const db = ctx(USERS.qs)
    await assertSucceeds(updateDoc(varRef(db, 'c1'), submitWrite(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(db, 'c1'), { ...withdrawWrite(USERS.qs), revision: 3 }))
  })
})

// ADR-90, checkpoint-1 correction — the transitional file equals the FINAL one
// in `variations` and in the counters block here too. Positive behaviour:
// tests/functions/variations.test.js → updateVariationDraft / createVariation.
describe('STAGE 1 — ADR-90: a draft admits no client content write and the variation counters are backend-only, exactly as in the FINAL file', () => {
  it('ADR-90 — a client draft edit (content and re-derived header; one field; the originating-RFI triple; stamps only) is REFUSED from every client; submit and withdraw still pass', async () => {
    await seed('de1', 'draft', manual(USERS.admin))
    const t = variationTotals([line(1200, { poLineIndex: null })], 'submitted')
    const edits = (user) => [
      { title: 'Revised', lineItems: [line(1200, { poLineIndex: null })], submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total, revision: 2, ...stamps(user) },
      { title: 'Retitled', revision: 2, ...stamps(user) },
      { notes: 'A note', revision: 2, ...stamps(user) },
      { originRfiId: 'rfiX', originRfiNumber: 'RFI-0001', originRfiTitle: 'Forged', revision: 2, ...stamps(user) },
      { status: 'draft', revision: 2, ...stamps(user) },
    ]
    for (let i = 0; i < edits(USERS.admin).length; i += 1) await updateRefused('de1', (user) => edits(user)[i])
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'de1'), submitWrite(USERS.qs)))
    await seed('de2', 'draft', manual(USERS.admin))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'de2'), withdrawWrite(USERS.pm)))
  })

  it('ADR-90 — the two variation counters refuse every client read and write; another register’s counter is untouched', async () => {
    const counter = (db, id) => doc(db, `companies/${COMPANY_A}/counters`, id)
    await testEnv.withSecurityRulesDisabled(async (c) => {
      for (const id of ['variationsClient', 'variationsSupplier', 'purchaseOrders']) await setDoc(counter(c.firestore(), id), { next: 7 })
    })
    for (const user of FINANCIAL) {
      for (const id of ['variationsClient', 'variationsSupplier']) {
        await assertFails(getDoc(counter(ctx(user), id)))
        for (const next of [8, 1, 999999, 'x']) await assertFails(setDoc(counter(ctx(user), id), { next }, { merge: true }))
      }
      await assertSucceeds(getDoc(counter(ctx(user), 'purchaseOrders')))
    }
    await assertSucceeds(setDoc(counter(ctx(USERS.qs), 'purchaseOrders'), { next: 8 }, { merge: true }))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      for (const id of ['variationsClient', 'variationsSupplier']) expect((await getDoc(counter(c.firestore(), id))).data()).toEqual({ next: 7 })
    })
  })
})

describe('STAGE 1 — the NEW bundle’s old variation writes (both pairs on approve) are REFUSED from every client too (ADR-90)', () => {
  // Positive behaviour: tests/functions/variations.test.js → approveVariation / applyVariationCommitment.
  it('ADR-90 — an approve carrying both pairs is REFUSED from every client (every financial role); nothing is stored', async () => {
    await seed('new', 'submitted', payload(USERS.admin))
    await updateRefused('new', (user) => approveNew(user))
    const v = await readVar('new')
    expect(v.status).toBe('submitted')
    expect(v).not.toHaveProperty('commitmentAppliedBy')
    expect(v).not.toHaveProperty('scopeCommittedBy')
  })

  it('ADR-90 — a both-pairs approve against a closed PO and the legacy Apply (both pairs) on an unstamped approved document are REFUSED from every client; once the backend has applied, neither pair can be written again', async () => {
    await seed('closed', 'submitted', payload(USERS.admin, { poId: PO.closed.id, poNumber: PO.closed.poNumber }))
    await updateRefused('closed', (user) => approveNew(user))
    await seed('legacy', 'approved', payload(USERS.admin))
    await updateRefused('legacy', (user) => applyWrite(user))
    await serverUpdate('legacy', applyWrite(USERS.pm))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'legacy'), applyWrite(USERS.admin, { revision: 3 })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'legacy'), scopeWrite(USERS.admin, { revision: 3 })))
  })
})

describe('STAGE 1 — Correction A holds for EVERY payload: an invalid PO refuses the approval', () => {
  it('cancelled, draft and pending POs refuse the M3-B1, the new and the plain approve; the variation stays submitted', async () => {
    for (const status of ['cancelled', 'draft', 'pending_approval']) {
      await seed('v1', 'submitted', payload(USERS.admin))
      await setPoStatus(PO.sent, status)
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveB1(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveNew(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approvePlain(USERS.admin)))
      expect((await readVar('v1')).status).toBe('submitted')
      await setPoStatus(PO.sent, 'sent')
    }
  })

  it('a missing PO and a PO from another project refuse every payload', async () => {
    await seed('gone', 'submitted', payload(USERS.admin, { poId: 'poGone', poNumber: 'PO-0099' }))
    await seed('otherProj', 'submitted', payload(USERS.admin, { poId: PO_IN_PROJECT_B.id, poNumber: PO_IN_PROJECT_B.poNumber }))
    for (const id of ['gone', 'otherProj']) {
      await assertFails(updateDoc(varRef(ctx(USERS.admin), id), approveB1(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), id), approveNew(USERS.admin)))
      expect((await readVar(id)).status).toBe('submitted')
    }
  })
})

// ADR-93 / ADR-94 replaced "STAGE 1 — claims and invoices: the ADR-63 pins are
// active for both bundles": claim create and approve, and every supplier-invoice
// write, are trusted-backend operations, so NEITHER ruleset admits the old or the
// new bundle's client payload any more — the ADR-63 count pins, the shape pins,
// the invoice-count guard and the ADR-68 pairing now live in the backend
// (tests/functions/supplierFinance.test.js) and the client writes are refused
// in BOTH files (tests/rules/claimInvoicePairingTransitional.rules.test.js).
describe('STAGE 1 — claims and invoices: every client write the old and new bundles made is REFUSED (ADR-93 / ADR-94)', () => {
  it('the M3-B1 and the new bundle’s claim creates are REFUSED for every financial role, and nothing is stored', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      const db = ctx(user)
      await assertFails(setDoc(doc(db, claimsPath(), `old-${user.uid}`), claimPayload(user)))
      await assertFails(setDoc(doc(db, claimsPath(), `new0-${user.uid}`), claimPayload(user, { variationLineCount: 0 })))
      await assertFails(setDoc(doc(db, claimsPath(), `new1-${user.uid}`), claimPayload(user, { lines: [poClaimLine(), varClaimLine()], variationLineCount: 1 })))
      await assertFails(setDoc(doc(db, claimsPath(), `link-${user.uid}`), claimPayload(user, { variationLineCount: 0, supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null })))
    }
  })

  it('the shapes the ADR-63 pins used to refuse are still refused (a variation line without its count, a count without its line, an old-bundle-shaped variation line)', async () => {
    const db = ctx(USERS.qs)
    await assertFails(setDoc(doc(db, claimsPath(), 'x1'), claimPayload(USERS.qs, { lines: [poClaimLine(), varClaimLine()] })))
    await assertFails(setDoc(doc(db, claimsPath(), 'x2'), claimPayload(USERS.qs, { variationLineCount: 1 })))
    const oldShape = { ...varClaimLine(), poLineIndex: 0 }
    delete oldShape.variationId
    await assertFails(setDoc(doc(db, claimsPath(), 'x3'), claimPayload(USERS.qs, { lines: [poClaimLine(), oldShape], variationLineCount: 1 })))
    await assertFails(setDoc(doc(db, claimsPath(), 'x4'), claimPayload(USERS.qs, { lines: [poClaimLine(), { ...varClaimLine(), poLineIndex: 0 }], variationLineCount: 1 })))
  })

  // The batch the 2A bundle issued: invoice create + the claim's link write.
  function pairedCreate(user, id, payload, claimId) {
    const db = ctx(user)
    const batch = writeBatch(db)
    batch.set(doc(db, invPath(), id), payload)
    batch.update(doc(db, claimsPath(), claimId), {
      supplierInvoiceId: id, supplierInvoiceLinkedAt: serverTimestamp(), supplierInvoiceLinkedBy: user.uid,
      revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid,
    })
    return batch.commit()
  }

  it('claim-sourced invoice creates — paired or unpaired, with or without the variation-line count — are REFUSED for every financial role', async () => {
    await seedApprovedClaim('cVar', [poClaimLine(0), varClaimLine(2000)], 1)
    await seedApprovedClaim('cPlain', [poClaimLine(1000)], undefined)
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertFails(pairedCreate(user, `oldVar-${user.uid}`, invoicePayload(user, { claimId: 'cVar', lines: [invLine(2000)] }), 'cVar'))
      await assertFails(pairedCreate(user, `newVar-${user.uid}`, invoicePayload(user, { claimId: 'cVar', lines: [varInvLine(2000)], variationLineCount: 1 }), 'cVar'))
      await assertFails(pairedCreate(user, `plain-${user.uid}`, invoicePayload(user, { claimId: 'cPlain', lines: [invLine(1000)], variationLineCount: 0 }), 'cPlain'))
      await assertFails(setDoc(doc(ctx(user), invPath(), `unpaired-${user.uid}`), invoicePayload(user, { claimId: 'cPlain', lines: [invLine(1000)], variationLineCount: 0 })))
    }
  })
})

describe('STAGE 1 — every other control is unchanged', () => {
  it('manual-mode supplier and client variations refuse both pairs; ADR-90 — and their plain approve WITHOUT any pair is REFUSED from every client', async () => {
    await seed('manual', 'submitted', manual(USERS.admin))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin, applied(USERS.admin))))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin, both(USERS.admin))))
    await updateRefused('manual', (user) => approvePlain(user))
    const client = clientPayload(USERS.admin)
    await seed('client', 'submitted', client)
    const clientLines = buildApprovedLineItems(client.lineItems, [900])
    const t = variationTotals(clientLines, 'approved')
    const clientApprove = (user) => ({ ...approvePlain(user), lineItems: clientLines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), { ...clientApprove(USERS.admin), ...scoped(USERS.admin) }))
    await updateRefused('client', clientApprove)
  })

  it('forged stamps (another actor, a client clock, half a pair) are refused; neither pair can be born at create', async () => {
    await seed('v1', 'submitted', payload(USERS.admin))
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), approveNew(USERS.admin, { commitmentAppliedBy: USERS.pm.uid })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveNew(USERS.admin, { scopeCommittedBy: USERS.pm.uid })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveNew(USERS.admin, { scopeCommittedAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveB1(USERS.admin, { scopeCommittedAt: serverTimestamp() })))
    await assertFails(updateDoc(varRef(db, 'v1'), approvePlain(USERS.admin, scoped(USERS.admin))))
    await assertFails(setDoc(varRef(db, 'c2'), payload(USERS.admin, both(USERS.admin))))
    await assertFails(setDoc(varRef(db, 'c3'), payload(USERS.admin, scoped(USERS.admin))))
    expect((await readVar('v1')).status).toBe('submitted')
  })

  it('non-financial roles and another tenant can neither approve nor apply nor commit scope', async () => {
    await seed('v1', 'submitted', payload(USERS.admin))
    await seed('a1', 'approved', payload(USERS.admin))
    for (const user of [USERS.sub, USERS.client, USERS.other]) {
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), approveB1(user)))
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), approveNew(user)))
      await assertFails(updateDoc(varRef(ctx(user), 'a1'), applyWrite(user)))
      await assertFails(updateDoc(varRef(ctx(user), 'a1'), scopeWrite(user)))
    }
  })
})
