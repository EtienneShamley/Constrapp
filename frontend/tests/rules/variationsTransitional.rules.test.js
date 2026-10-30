import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { TAX_CODE, gstForLine, variationTotals, buildApprovedLineItems, isCommitmentApplied, isScopeCommitted } from '../../src/lib/variations'
import { buildClaimLine, buildVariationClaimLine, claimTotals } from '../../src/lib/progressClaims'
import { invoiceTotals } from '../../src/lib/supplierInvoices'

// ── ADR-63 STAGE-1 TRANSITIONAL ruleset — emulator proof ─────────────────────
//
// `firestore.transitional.rules` is derived from `firestore.rules` by
// scripts/build-transitional-rules.mjs (two rule lines differ; pinned by
// tests/unit/rulesTransitional.test.js). It is the ruleset deployed FIRST,
// while the M3-B1 bundle is still served. This file proves, against THAT file,
// exactly what the rollout relies on:
//
//   1. the M3-B1 bundle's PO-linked approve (applied pair, NO scope pair) is
//      ACCEPTED, and the new bundle's scope-only legacy write then completes
//      it once;
//   2. the NEW bundle's approve (both pairs) is ACCEPTED;
//   3. the pre-M3-B1 approve (no pair at all) is REFUSED — the ADR-62 applied
//      pair stays required in Stage 1;
//   4. a missing / cancelled / draft / other-project PO is REFUSED for every
//      payload (Correction A holds);
//   5. the M3-B1 bundle's claim create (no `variationLineCount`) is ACCEPTED,
//      the new bundle's (with it) is ACCEPTED, and the ADR-63 count pin, shape
//      pins and invoice-count guard are ACTIVE from Stage 1 on;
//   6. every other control is unchanged — forged stamps, stamps at create or
//      on other branches, manual / client semantics, roles and tenancy.
//
// The FINAL ruleset's behaviour (M3-B1 approve payload DENIED; claim create
// without the count DENIED) is proven by tests/rules/variations.rules.test.js
// and tests/rules/progressClaims.rules.test.js against firestore.rules.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.transitional.rules')

const PROJECT_ID = 'constrapp-rules-test'
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
  if (!rules.includes('ADR-63 TRANSITIONAL')) throw new Error('firestore.transitional.rules does not carry the transitional marker')
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules, host, port: Number(port) } })
})
afterAll(async () => { if (testEnv) await testEnv.cleanup() })
beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'AU', baseCurrency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD', currencyLocked: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'Project B', currency: 'AUD' })
  })
  await seedPo(PO.sent)
  await seedPo(PO.closed)
  await seedPo(PO_IN_PROJECT_B, PROJECT_B)
})

describe('STAGE 1 — the M3-B1 bundle (applied pair, no scope pair) keeps working', () => {
  it('a PO-linked supplier approve WITH the applied pair only is ACCEPTED for every financial role against a sent and a closed PO; the new bundle then commits the scope once', async () => {
    for (const user of FINANCIAL) {
      for (const po of [PO.sent, PO.closed]) {
        const id = `b1_${user.uid}_${po.id}`
        await seed(id, 'submitted', payload(USERS.admin, { poId: po.id, poNumber: po.poNumber }))
        await assertSucceeds(updateDoc(varRef(ctx(user), id), approveB1(user)))
        const v = await readVar(id)
        expect(v.status).toBe('approved')
        expect(isCommitmentApplied(v)).toBe(true)
        expect(isScopeCommitted(v)).toBe(false)
        // …the new bundle's scope-only write completes it, once; the full legacy Apply (both pairs) is refused.
        await assertFails(updateDoc(varRef(ctx(user), id), applyWrite(user, { revision: 3 })))
        await assertSucceeds(updateDoc(varRef(ctx(user), id), scopeWrite(user, { revision: 3 })))
        await assertFails(updateDoc(varRef(ctx(user), id), scopeWrite(user, { revision: 4 })))
        expect(isScopeCommitted(await readVar(id))).toBe(true)
      }
    }
  })

  it('the pre-M3-B1 approve payload (NO pair at all) is REFUSED — the applied pair stays required in Stage 1', async () => {
    await seed('v1', 'submitted', payload(USERS.admin))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approvePlain(USERS.admin)))
    expect((await readVar('v1')).status).toBe('submitted')
  })

  it('the M3-B1 bundle’s create, submit and withdraw are unchanged', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(varRef(db, 'c1'), payload(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(db, 'c1'), submitWrite(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(db, 'c1'), { ...withdrawWrite(USERS.qs), revision: 3 }))
  })
})

describe('STAGE 1 — the NEW bundle (both pairs on approve) works too', () => {
  it('an approve carrying both pairs is ACCEPTED for every financial role and both pairs are stored', async () => {
    for (const user of FINANCIAL) {
      await seed(`new_${user.uid}`, 'submitted', payload(USERS.admin))
      await assertSucceeds(updateDoc(varRef(ctx(user), `new_${user.uid}`), approveNew(user)))
      const v = await readVar(`new_${user.uid}`)
      expect(v.status).toBe('approved')
      expect(v.commitmentAppliedBy).toBe(user.uid)
      expect(v.scopeCommittedBy).toBe(user.uid)
    }
  })

  it('both-pairs approve against a closed PO passes; the legacy Apply (both pairs) passes once on an unstamped approved document and never again', async () => {
    await seed('closed', 'submitted', payload(USERS.admin, { poId: PO.closed.id, poNumber: PO.closed.poNumber }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'closed'), approveNew(USERS.pm)))
    await seed('legacy', 'approved', payload(USERS.admin))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'legacy'), applyWrite(USERS.pm)))
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

describe('STAGE 1 — claims and invoices: the ADR-63 pins are active for both bundles', () => {
  it('the M3-B1 bundle’s claim create (no variationLineCount, PO lines only) is ACCEPTED; the new bundle’s (count 0 or a declared variation line) is ACCEPTED', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(doc(db, claimsPath(), 'old'), claimPayload(USERS.qs)))
    await assertSucceeds(setDoc(doc(db, claimsPath(), 'new0'), claimPayload(USERS.qs, { variationLineCount: 0 })))
    await assertSucceeds(setDoc(doc(db, claimsPath(), 'new1'), claimPayload(USERS.qs, { lines: [poClaimLine(), varClaimLine()], variationLineCount: 1 })))
  })

  it('the count pin and the shape pins refuse a variation line without its count, a count without its line, and an old-bundle-shaped variation line', async () => {
    const db = ctx(USERS.qs)
    // Two lines, no count → PO has one line → refused.
    await assertFails(setDoc(doc(db, claimsPath(), 'x1'), claimPayload(USERS.qs, { lines: [poClaimLine(), varClaimLine()] })))
    // Count 1 but a single PO line → refused.
    await assertFails(setDoc(doc(db, claimsPath(), 'x2'), claimPayload(USERS.qs, { variationLineCount: 1 })))
    // Count 1 but the last line is PO-shaped (index 0, no variation id) → refused.
    const oldShape = { ...varClaimLine(), poLineIndex: 0 }
    delete oldShape.variationId
    await assertFails(setDoc(doc(db, claimsPath(), 'x3'), claimPayload(USERS.qs, { lines: [poClaimLine(), oldShape], variationLineCount: 1 })))
    await assertFails(setDoc(doc(db, claimsPath(), 'x4'), claimPayload(USERS.qs, { lines: [poClaimLine(), { ...varClaimLine(), poLineIndex: 0 }], variationLineCount: 1 })))
  })

  it('the invoice-count guard is ACTIVE: a claim carrying a variation line can be invoiced only by a payload that declares the count', async () => {
    await seedApprovedClaim('cVar', [poClaimLine(0), varClaimLine(2000)], 1)
    await seedApprovedClaim('cPlain', [poClaimLine(1000)], undefined)
    const db = ctx(USERS.qs)
    // The M3-B1 bundle's shape against the variation claim: no count, the line attributed to PO line 0 → REFUSED.
    await assertFails(setDoc(doc(db, invPath(), 'oldVar'), invoicePayload(USERS.qs, { claimId: 'cVar', lines: [invLine(2000)] })))
    // The new bundle: count 1 and the variation-origin line → ACCEPTED.
    await assertSucceeds(setDoc(doc(db, invPath(), 'newVar'), invoicePayload(USERS.qs, { claimId: 'cVar', lines: [varInvLine(2000)], variationLineCount: 1 })))
    // A plain claim: the M3-B1 payload (no count) and the new payload (0) both pass.
    await assertSucceeds(setDoc(doc(db, invPath(), 'oldPlain'), invoicePayload(USERS.qs, { claimId: 'cPlain', lines: [invLine(1000)] })))
    await assertSucceeds(setDoc(doc(db, invPath(), 'newPlain'), invoicePayload(USERS.qs, { claimId: 'cPlain', lines: [invLine(1000)], variationLineCount: 0 })))
  })
})

describe('STAGE 1 — every other control is unchanged', () => {
  it('manual-mode supplier and client variations approve WITHOUT any pair and refuse both pairs', async () => {
    await seed('manual', 'submitted', manual(USERS.admin))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin, applied(USERS.admin))))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin, both(USERS.admin))))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin)))
    const client = clientPayload(USERS.admin)
    await seed('client', 'submitted', client)
    const clientLines = buildApprovedLineItems(client.lineItems, [900])
    const t = variationTotals(clientLines, 'approved')
    const clientApprove = { ...approvePlain(USERS.admin), lineItems: clientLines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total }
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), { ...clientApprove, ...scoped(USERS.admin) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'client'), clientApprove))
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
