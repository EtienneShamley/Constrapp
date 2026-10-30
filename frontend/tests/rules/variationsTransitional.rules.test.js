import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore'
import { TAX_CODE, gstForLine, variationTotals, buildApprovedLineItems, isCommitmentApplied } from '../../src/lib/variations'

// ── ADR-62 STAGE-1 TRANSITIONAL ruleset — emulator proof ─────────────────────
//
// `firestore.transitional.rules` is derived from `firestore.rules` by
// scripts/build-transitional-rules.mjs (one rule line differs; pinned by
// tests/unit/rulesTransitional.test.js). It is the ruleset published FIRST,
// while the pre-M3-B1 bundle is still served. This file proves, against THAT
// file, exactly the four things the rollout relies on:
//
//   1. the OLD bundle's PO-linked approve (no commitment pair) is ACCEPTED
//      (and the resulting approved document is legacy-applicable);
//   2. the NEW bundle's stamped approve is ACCEPTED;
//   3. a missing / cancelled / draft / other-project PO is REFUSED for BOTH
//      payloads (Correction A holds from Stage 1 on);
//   4. every other control is unchanged — forged stamps, stamps at create or on
//      other branches, manual / client semantics, the legacy Apply and its
//      one-time nature, roles and tenancy.
//
// The FINAL ruleset's behaviour (unstamped PO-linked approve DENIED) is proven
// by tests/rules/variations.rules.test.js against firestore.rules.
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

let testEnv
const varsPath = (projectId = PROJECT_A) => `companies/${COMPANY_A}/projects/${projectId}/variations`
const posPath  = (projectId = PROJECT_A) => `companies/${COMPANY_A}/projects/${projectId}/purchaseOrders`
const ctx    = (user) => testEnv.authenticatedContext(user.uid).firestore()
const varRef = (db, id) => doc(db, varsPath(), id)

const line = (amount, { costCodeId = 'cc1', costCodeName = '03-100 — Concrete', taxCode = TAX_CODE.GST, poLineIndex = 0 } = {}) => ({
  costCodeId, costCodeName, description: 'Extra steel',
  submittedAmount: amount, submittedGst: gstForLine(amount, taxCode),
  approvedAmount: null, approvedGst: null, poLineIndex, taxCode,
})
const LINES = [line(900)]
const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })
const applied = (user) => ({ commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: user.uid })

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

// Approve over a SUBMITTED seed: the pre-M3-B1 payload (no pair) and the new one (pair).
function approvePlain(user, extra = {}) {
  const lines = buildApprovedLineItems(LINES, [900])
  const t = variationTotals(lines, 'approved')
  return {
    status: 'approved', lineItems: lines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
    assessmentNotes: '', approvedDate: '2026-10-12', effectiveDate: '2026-10-12',
    approvedAt: serverTimestamp(), approvedBy: user.uid, revision: 2, ...stamps(user), ...extra,
  }
}
const approveApplied = (user, extra = {}) => approvePlain(user, { ...applied(user), ...extra })
const applyWrite = (user, extra = {}) => ({ ...applied(user), revision: 2, ...stamps(user), ...extra })
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
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 10, unit: 'm3', unitPrice: 250, lineTotal: 2500 }],
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

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set — run `npm run test:rules`.')
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const rules = readFileSync(RULES_PATH, 'utf8')
  if (!rules.includes('ADR-62 TRANSITIONAL')) throw new Error('firestore.transitional.rules does not carry the transitional marker')
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

describe('STAGE 1 — the OLD bundle (no commitment pair) keeps working', () => {
  it('a PO-linked supplier approve WITHOUT the pair is ACCEPTED for every financial role against a sent and a closed PO, and the document is then unapplied (legacy-eligible)', async () => {
    for (const user of FINANCIAL) {
      for (const po of [PO.sent, PO.closed]) {
        const id = `old_${user.uid}_${po.id}`
        await seed(id, 'submitted', payload(USERS.admin, { poId: po.id, poNumber: po.poNumber }))
        await assertSucceeds(updateDoc(varRef(ctx(user), id), approvePlain(user)))
        const v = await readVar(id)
        expect(v.status).toBe('approved')
        expect(v).not.toHaveProperty('commitmentAppliedAt')
        expect(isCommitmentApplied(v)).toBe(false)
        // …and the new bundle's legacy Apply then works on it, once.
        await assertSucceeds(updateDoc(varRef(ctx(user), id), applyWrite(user, { revision: 3 })))
        await assertFails(updateDoc(varRef(ctx(user), id), applyWrite(user, { revision: 4 })))
        expect(isCommitmentApplied(await readVar(id))).toBe(true)
      }
    }
  })

  it('the old bundle’s create, submit and withdraw are unchanged', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(varRef(db, 'c1'), payload(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(db, 'c1'), submitWrite(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(db, 'c1'), { ...withdrawWrite(USERS.qs), revision: 3 }))
  })
})

describe('STAGE 1 — the NEW bundle (pair on approve) works too', () => {
  it('a stamped PO-linked approve is ACCEPTED for every financial role and the pair is stored', async () => {
    for (const user of FINANCIAL) {
      await seed(`new_${user.uid}`, 'submitted', payload(USERS.admin))
      await assertSucceeds(updateDoc(varRef(ctx(user), `new_${user.uid}`), approveApplied(user)))
      const v = await readVar(`new_${user.uid}`)
      expect(v.status).toBe('approved')
      expect(v.commitmentAppliedBy).toBe(user.uid)
    }
  })

  it('a stamped approve against a closed PO passes; the legacy Apply passes once on a seeded approved document', async () => {
    await seed('closed', 'submitted', payload(USERS.admin, { poId: PO.closed.id, poNumber: PO.closed.poNumber }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'closed'), approveApplied(USERS.pm)))
    await seed('legacy', 'approved', payload(USERS.admin))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'legacy'), applyWrite(USERS.pm)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'legacy'), applyWrite(USERS.admin, { revision: 3 })))
  })
})

describe('STAGE 1 — Correction A holds for BOTH payloads: an invalid PO refuses the approval', () => {
  it('cancelled, draft and pending POs refuse the stamped AND the plain approve; the variation stays submitted', async () => {
    for (const status of ['cancelled', 'draft', 'pending_approval']) {
      await seed('v1', 'submitted', payload(USERS.admin))
      await setPoStatus(PO.sent, status)
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveApplied(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approvePlain(USERS.admin)))
      expect((await readVar('v1')).status).toBe('submitted')
      await setPoStatus(PO.sent, 'sent')
    }
  })

  it('a missing PO and a PO from another project refuse both payloads', async () => {
    await seed('gone', 'submitted', payload(USERS.admin, { poId: 'poGone', poNumber: 'PO-0099' }))
    await seed('otherProj', 'submitted', payload(USERS.admin, { poId: PO_IN_PROJECT_B.id, poNumber: PO_IN_PROJECT_B.poNumber }))
    for (const id of ['gone', 'otherProj']) {
      await assertFails(updateDoc(varRef(ctx(USERS.admin), id), approveApplied(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), id), approvePlain(USERS.admin)))
      expect((await readVar(id)).status).toBe('submitted')
    }
  })
})

describe('STAGE 1 — every other control is unchanged', () => {
  it('manual-mode supplier and client variations approve WITHOUT the pair and refuse it', async () => {
    await seed('manual', 'submitted', manual(USERS.admin))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin, applied(USERS.admin))))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'manual'), approvePlain(USERS.admin)))
    const client = clientPayload(USERS.admin)
    await seed('client', 'submitted', client)
    const clientLines = buildApprovedLineItems(client.lineItems, [900])
    const t = variationTotals(clientLines, 'approved')
    const clientApprove = { ...approvePlain(USERS.admin), lineItems: clientLines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total }
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), { ...clientApprove, ...applied(USERS.admin) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'client'), clientApprove))
  })

  it('forged stamps (another actor, a client clock, half a pair) are refused; the pair cannot be born at create', async () => {
    await seed('v1', 'submitted', payload(USERS.admin))
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { commitmentAppliedBy: USERS.pm.uid })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { commitmentAppliedAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) })))
    await assertFails(updateDoc(varRef(db, 'v1'), approvePlain(USERS.admin, { commitmentAppliedAt: serverTimestamp() })))
    await assertFails(setDoc(varRef(db, 'c2'), payload(USERS.admin, applied(USERS.admin))))
    expect((await readVar('v1')).status).toBe('submitted')
  })

  it('non-financial roles and another tenant can neither approve nor apply', async () => {
    await seed('v1', 'submitted', payload(USERS.admin))
    await seed('a1', 'approved', payload(USERS.admin))
    for (const user of [USERS.sub, USERS.client, USERS.other]) {
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), approveApplied(user)))
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), approvePlain(user)))
      await assertFails(updateDoc(varRef(ctx(user), 'a1'), applyWrite(user)))
    }
  })
})
