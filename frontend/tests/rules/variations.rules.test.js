import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import {
  VARIATION_STATUS, TAX_CODE, gstForLine, variationTotals, buildApprovedLineItems,
  approvedSupplierVariationsByCostCode, approvedSupplierVariationsTotal, pendingSupplierVariationExposureTotal,
  pendingSupplierVariationExposureByCostCode, approvedClientVariationsTotal, pendingClientVariationExposureTotal,
  openVariationCount, variationsForRfi,
} from '../../src/lib/variations'
import { computeMargin } from '../../src/lib/margin'
import { poCancellationBlockers } from '../../src/lib/poCancellation'
import {
  runUpdateVariationDraft, runTransitionVariation, runApplyVariationCommitment, VariationWriteError, VARIATION_WRITE_ERROR,
} from '../../src/lib/variationActions'
import { isCommitmentApplied, appliedSupplierVariationAdjustments, unappliedSupplierVariationsByCostCode } from '../../src/lib/variations'
import { remainingCommittedByCostCode } from '../../src/lib/purchaseOrders'

// ── Variations Security Rules — emulator tests (ADR-18 · ADR-34 · ADR-59, M2-B3) ─
//
// Executes every case documented in docs/TESTING.md §35 against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct
// SDK call, exactly what a client bypassing the app would issue.
//
// Until M2-B3 the `variations` block enforced tenant and role and — the one
// content control, ADR-34 — the originating-RFI link; nothing else. Approved
// variations feed Commitment Exposure, the Current Contract Sum, Margin, Cash
// Flow context, PULSE indicator 6 and SHIELD check 4 at read time, and the PO
// cancel guard reads their status and poId. A financial-role caller could
// therefore create a variation already `approved`, rewrite an approved
// variation's lines or header, move it to another PO, revive a rejected one,
// or forge `approvedBy`. The block now follows the ADR-40 / ADR-57 / ADR-58
// standard: born draft with the exact key set, the caller's stamps, the
// project's resolved currency and — for a supplier variation that names a PO —
// a get() on a SENT/CLOSED PO of the same project (number and supplier
// snapshot pinned); draft-only content edits; exactly draft → submitted,
// submitted|under_review → approved | rejected, draft|submitted|under_review →
// withdrawn, each stamps-only (approval also carrying the certified lines, the
// SIGNED approved header, the notes and the dates), actor == caller, time ==
// request.time; identity frozen by the hasOnly lists; SIGNED whole-cent headers
// (negative variations are valid and never clamped); revision exactly +1 on
// every update; the ADR-34 link validated when it changes and frozen outside
// draft — every ADR-34 case below is kept, in the new write shape; delete
// blocked.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (Deferred Control 37):
// rules can neither iterate an array nor read sibling documents, so
// `lineItems` CONTENTS, the header GST against the per-line tax codes,
// "assessment notes required when approved differs from submitted",
// counterparty + reference uniqueness, creator ≠ approver, and a stale write
// that reads first and writes `stored + 1` are all unverified. The final
// describe block proves each of those, so the suite documents the security
// CEILING as explicitly as the floor.
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A  = 'companyA'   // baseCurrency NZD
const COMPANY_B  = 'companyB'   // no baseCurrency
const PROJECT_A  = 'projectA'   // Company A, currency AUD (explicit)
const PROJECT_B  = 'projectB'   // Company A, no currency → NZD via the company
const PROJECT_C  = 'projectC'   // Company B, no currency, company has none → AUD

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  super:  { uid: 'u_super',  role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
const ORPHAN_UID  = 'u_orphan'
const FINANCIAL   = [USERS.admin, USERS.pm, USERS.qs]
const NON_MEMBERS = [USERS.sub, USERS.client, USERS.super]

// Seeded RFIs (ADR-34). Titles are what the snapshots must match EXACTLY.
const RFIS = {
  open:      { id: 'rfiOpen',      rfiNumber: 'RFI-0001', title: 'Revised structural steel connection', status: 'open' },
  answered:  { id: 'rfiAnswered',  rfiNumber: 'RFI-0002', title: 'Slab thickness at grid C',            status: 'answered' },
  closed:    { id: 'rfiClosed',    rfiNumber: 'RFI-0003', title: 'Lintel bearing length',                status: 'closed' },
  draft:     { id: 'rfiDraft',     rfiNumber: 'RFI-0004', title: 'Unraised question',                    status: 'draft' },
  cancelled: { id: 'rfiCancelled', rfiNumber: 'RFI-0005', title: 'Duplicate question',                   status: 'cancelled' },
}
const RFI_IN_PROJECT_B = { id: 'rfiProjB', rfiNumber: 'RFI-0001', title: 'Project B question', status: 'open' }
const RFI_IN_COMPANY_B = { id: 'rfiCompB', rfiNumber: 'RFI-0001', title: 'Company B question', status: 'open' }

// Seeded purchase orders — only the fields the variations block get()s matter.
const PO = {
  sent:      { id: 'poSent',      poNumber: 'PO-0001', status: 'sent',      supplierName: 'Steel Co',  supplierId: 'contactS1' },
  closed:    { id: 'poClosed',    poNumber: 'PO-0002', status: 'closed',    supplierName: 'Steel Co',  supplierId: 'contactS1' },
  draft:     { id: 'poDraft',     poNumber: 'PO-0003', status: 'draft',     supplierName: 'Steel Co',  supplierId: 'contactS1' },
  pending:   { id: 'poPending',   poNumber: 'PO-0004', status: 'pending_approval', supplierName: 'Steel Co', supplierId: 'contactS1' },
  cancelled: { id: 'poCancelled', poNumber: 'PO-0005', status: 'cancelled', supplierName: 'Steel Co',  supplierId: 'contactS1' },
  legacy:    { id: 'poLegacy',    poNumber: 'PO-0006', status: 'sent',      supplierName: 'Old Co',    supplierId: undefined },   // pre-Contacts PO: no supplierId key
}
const PO_IN_PROJECT_B = { id: 'poProjB', poNumber: 'PO-0001', status: 'sent', supplierName: 'Steel Co', supplierId: 'contactS1' }

let testEnv

const varsPath = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/variations`
const rfisPath = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/rfis`
const posPath  = (companyId = COMPANY_A, projectId = PROJECT_A) => `companies/${companyId}/projects/${projectId}/purchaseOrders`
const ctx    = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon   = () => testEnv.unauthenticatedContext().firestore()
const varRef = (db, id, companyId = COMPANY_A, projectId = PROJECT_A) => doc(db, varsPath(companyId, projectId), id)

// ── Fixtures ────────────────────────────────────────────────────────────────

// The link triple for a seeded RFI, exactly as normaliseOriginRfi() builds it.
const link = (r) => ({ originRfiId: r.id, originRfiNumber: r.rfiNumber, originRfiTitle: r.title })
const UNLINKED = { originRfiId: null, originRfiNumber: null, originRfiTitle: null }

// Lines exactly as lib/variations.js → buildVariationLineItem writes them:
// signed ex-GST amount, per-line GST from the tax code, approved side null.
const line = (amount, { costCodeId = 'cc1', costCodeName = '03-100 — Concrete', description = 'Extra steel', taxCode = TAX_CODE.GST, poLineIndex = null } = {}) => ({
  costCodeId, costCodeName, description,
  submittedAmount: amount, submittedGst: gstForLine(amount, taxCode),
  approvedAmount: null, approvedGst: null, poLineIndex, taxCode,
})
const LINES = [line(1000), line(-200, { costCodeId: 'cc2', costCodeName: '05-200 — Steel', taxCode: TAX_CODE.GST_FREE })]   // subtotal 800, gst 100, total 900

const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })

// A valid DRAFT payload built through the REAL variationTotals, exactly as
// hooks/useVariations.jsx → createVariation writes it. Supplier, manual mode
// (no PO) by default.
function payload(user, { lines = LINES, ...overrides } = {}) {
  const t = variationTotals(lines, 'submitted')
  return {
    variationNumber: 'SV-0001', variationType: 'supplier', status: 'draft',
    title: 'Additional steel', description: '', reason: '',
    clientId: null, clientName: null, clientRef: null,
    supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: '',
    poId: null, poNumber: null,
    ...UNLINKED,
    lineItems: lines,
    submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
    forecastAmount: null,
    identifiedDate: '2026-10-10', submittedDate: '', responseDueDate: '', approvedDate: '', effectiveDate: '',
    currency: 'AUD', revision: 1,
    notes: '', assessmentNotes: '',
    submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null,
    rejectedAt: null, rejectedBy: null, withdrawnAt: null, withdrawnBy: null,
    attachments: [], externalRefs: {}, supersededByVariationId: null,
    createdAt: serverTimestamp(), createdBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...overrides,
  }
}
// A supplier variation against a PO — the supplier snapshot is the PO's.
const poLinked = (user, po = PO.sent, overrides = {}) =>
  payload(user, { poId: po.id, poNumber: po.poNumber, supplierName: po.supplierName, supplierId: po.supplierId ?? null, ...overrides })
// A client variation.
const clientPayload = (user, overrides = {}) =>
  payload(user, {
    variationNumber: 'CV-0001', variationType: 'client',
    clientId: 'contactC1', clientName: 'Owner Pty Ltd', clientRef: 'VO-7',
    supplierId: null, supplierName: null, supplierRef: null, poId: null, poNumber: null,
    ...overrides,
  })

// Seeds a variation directly, bypassing rules. `status` selects the stamps a
// real document would carry; `legacy: true` strips every ADR-34 / ADR-59 key
// (the foundation shape — no originRfi*, no updatedAt / updatedBy); `extra`
// is pasted over the top.
async function seed(id, status = 'draft', user = USERS.admin, extra = {}, { legacy = false, base = payload(user), projectId = PROJECT_A, companyId = COMPANY_A } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    const approvedLines = buildApprovedLineItems(base.lineItems, base.lineItems.map(l => l.submittedAmount))
    const approvedTotals = variationTotals(approvedLines, 'approved')
    const lifecycle =
      status === 'submitted'    ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: user.uid } :
      status === 'under_review' ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: user.uid } :
      status === 'disputed'     ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: user.uid } :
      status === 'approved'     ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: user.uid, approvedAt: now, approvedBy: user.uid,
                                    lineItems: approvedLines, approvedSubtotal: approvedTotals.subtotal, approvedGst: approvedTotals.gst, approvedTotal: approvedTotals.total,
                                    approvedDate: '2026-10-12', effectiveDate: '2026-10-12', assessmentNotes: '' } :
      status === 'rejected'     ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: user.uid, rejectedAt: now, rejectedBy: user.uid } :
      status === 'withdrawn'    ? { status, withdrawnAt: now, withdrawnBy: user.uid } :
      status === 'superseded'   ? { status, submittedDate: '2026-10-11', submittedAt: now, submittedBy: user.uid, approvedAt: now, approvedBy: user.uid, supersededByVariationId: 'v-next' } :
      { status: 'draft' }
    const docData = { ...base, createdAt: now, updatedAt: now, ...lifecycle, ...extra }
    if (legacy) {
      for (const k of ['originRfiId', 'originRfiNumber', 'originRfiTitle', 'updatedAt', 'updatedBy']) delete docData[k]
    }
    await setDoc(doc(c.firestore(), varsPath(companyId, projectId), id), docData)
  })
}

async function seedRfi(r, companyId = COMPANY_A, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), rfisPath(companyId, projectId), r.id), {
      rfiNumber: r.rfiNumber, status: r.status, title: r.title,
      question: 'Which governs?', raisedDate: '2026-10-10', raisedByName: 'Sam Site',
      referenceType: 'none', referenceDrawingId: null, referenceRevisionId: null, referenceDocumentId: null,
      referenceLabel: '', referenceRevisionCode: '', costCodeId: null, costCodeName: '',
      assignedToContactId: 'contact1', assignedToName: 'Arch Co', dueDate: '2026-10-20',
      raisedAt: null, raisedBy: null, answer: '', answerDate: null, answeredAt: null, answeredBy: null,
      closeOutNote: '', closedAt: null, closedBy: null, cancelReason: '', cancelledAt: null, cancelledBy: null,
      revision: 1, createdAt: Timestamp.now(), createdBy: USERS.admin.uid,
      updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
    })
  })
}
async function setRfiStatus(r, status) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), rfisPath(), r.id), { status })
  })
}
async function seedPo(po, companyId = COMPANY_A, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    const data = {
      poNumber: po.poNumber, status: po.status, supplierName: po.supplierName, description: 'Level 1', notes: '',
      lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 10, unit: 'm3', unitPrice: 250, lineTotal: 2500 }],
      subtotal: 2500, gst: 250, total: 2750, currency: 'AUD', revision: 1,
      sentAt: po.status === 'draft' || po.status === 'pending_approval' ? null : now, sentBy: null,
      closedAt: po.status === 'closed' ? now : null, closedBy: null, cancelledAt: po.status === 'cancelled' ? now : null, cancelledBy: null,
      externalRefs: {}, createdAt: now, createdBy: 'u_admin',
    }
    if (po.supplierId !== undefined) data.supplierId = po.supplierId
    await setDoc(doc(c.firestore(), posPath(companyId, projectId), po.id), data)
  })
}

// The write shapes the app performs (lib/variationActions.js → draftUpdate /
// transitionUpdate), over the DEFAULT seed (revision 1).
function draftEdit(user, { lines = [line(1500), line(-300, { costCodeId: 'cc2', costCodeName: '05-200 — Steel', taxCode: TAX_CODE.INPUT_TAXED })], title = 'Additional steel (revised)', revision = 2, ...extra } = {}) {
  const t = variationTotals(lines, 'submitted')
  return {
    title, description: 'More steel', reason: 'site_condition', clientRef: null, supplierRef: 'Q-9',
    identifiedDate: '2026-10-01', responseDueDate: '2026-10-30', effectiveDate: '',
    lineItems: lines, submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total,
    revision, ...stamps(user), ...extra,
  }
}
const submitWrite = (user, extra = {}) =>
  ({ status: 'submitted', submittedDate: '2026-10-11', submittedAt: serverTimestamp(), submittedBy: user.uid, revision: 2, ...stamps(user), ...extra })
const rejectWrite = (user, extra = {}) =>
  ({ status: 'rejected', rejectedAt: serverTimestamp(), rejectedBy: user.uid, revision: 2, ...stamps(user), ...extra })
const withdrawWrite = (user, extra = {}) =>
  ({ status: 'withdrawn', withdrawnAt: serverTimestamp(), withdrawnBy: user.uid, revision: 2, ...stamps(user), ...extra })
// Approval over the DEFAULT seed (submitted [1000, −200]): certify `amounts`.
function approveWrite(user, { amounts = [900, -200], lines = LINES, assessmentNotes = 'Negotiated', revision = 2, ...extra } = {}) {
  const approved = buildApprovedLineItems(lines, amounts)
  const t = variationTotals(approved, 'approved')
  return {
    status: 'approved', lineItems: approved,
    approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
    assessmentNotes, approvedDate: '2026-10-12', effectiveDate: '2026-10-12',
    approvedAt: serverTimestamp(), approvedBy: user.uid,
    revision, ...stamps(user), ...extra,
  }
}

// Client-supplied clock values that must NEVER satisfy `== request.time`
// (docs/TESTING.md §0 — deliberately skewed, never Timestamp.now()).
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

async function readVar(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), varsPath(), id))
    data = snap.exists() ? { id: snap.id, ...snap.data() } : undefined
  })
  return data
}
const readStatus = async (id) => (await readVar(id))?.status

async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(VariationWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set — refusing to run Rules tests outside the emulator. ' +
      'Run `npm run test:rules`.',
    )
  }
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host, port: Number(port) },
  })
})

afterAll(async () => {
  if (testEnv) await testEnv.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'NZ', baseCurrency: 'NZD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD', currencyLocked: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'Project B' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_C), { name: 'Project C' })
  })
  for (const r of Object.values(RFIS)) await seedRfi(r)
  await seedRfi(RFI_IN_PROJECT_B, COMPANY_A, PROJECT_B)
  await seedRfi(RFI_IN_COMPANY_B, COMPANY_B, PROJECT_C)
  for (const po of Object.values(PO)) await seedPo(po)
  await seedPo(PO_IN_PROJECT_B, COMPANY_A, PROJECT_B)
})

// ── Roles, membership & tenant isolation ─────────────────────────────────────

describe('roles, membership and tenant isolation', () => {
  it('every financial role can create a draft supplier, PO-linked and client variation and read them', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(varRef(ctx(user), `s-${user.uid}`), payload(user)))
      await assertSucceeds(setDoc(varRef(ctx(user), `p-${user.uid}`), poLinked(user)))
      await assertSucceeds(setDoc(varRef(ctx(user), `c-${user.uid}`), clientPayload(user)))
      await assertSucceeds(getDoc(varRef(ctx(user), `s-${user.uid}`)))
    }
  })

  it('every financial role can edit a draft, submit, approve, reject and withdraw', async () => {
    for (const user of FINANCIAL) {
      await seed(`ed-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(varRef(ctx(user), `ed-${user.uid}`), draftEdit(user)))
      await seed(`su-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(varRef(ctx(user), `su-${user.uid}`), submitWrite(user)))
      await seed(`ap-${user.uid}`, 'submitted')
      await assertSucceeds(updateDoc(varRef(ctx(user), `ap-${user.uid}`), approveWrite(user)))
      await seed(`re-${user.uid}`, 'submitted')
      await assertSucceeds(updateDoc(varRef(ctx(user), `re-${user.uid}`), rejectWrite(user)))
      await seed(`wd-${user.uid}`, 'submitted')
      await assertSucceeds(updateDoc(varRef(ctx(user), `wd-${user.uid}`), withdrawWrite(user)))
    }
  })

  it.each(NON_MEMBERS.map(u => [u.role, u]))('%s can neither read nor write', async (_role, user) => {
    await seed('deny1', 'draft')
    await seed('deny1s', 'submitted')
    await assertFails(getDoc(varRef(ctx(user), 'deny1')))
    await assertFails(setDoc(varRef(ctx(user), `deny-${user.uid}`), payload(user)))
    await assertFails(updateDoc(varRef(ctx(user), 'deny1'), draftEdit(user)))
    await assertFails(updateDoc(varRef(ctx(user), 'deny1'), submitWrite(user)))
    await assertFails(updateDoc(varRef(ctx(user), 'deny1s'), approveWrite(user)))
    await assertFails(updateDoc(varRef(ctx(user), 'deny1s'), rejectWrite(user)))
    await assertFails(updateDoc(varRef(ctx(user), 'deny1s'), withdrawWrite(user)))
  })

  it('an unauthenticated caller and a caller with NO membership document are denied', async () => {
    await seed('deny2', 'draft')
    await assertFails(getDoc(varRef(anon(), 'deny2')))
    await assertFails(setDoc(varRef(anon(), 'deny3'), payload(USERS.admin)))
    await assertFails(updateDoc(varRef(anon(), 'deny2'), submitWrite(USERS.admin)))
    const orphan = testEnv.authenticatedContext(ORPHAN_UID).firestore()
    await assertFails(getDoc(varRef(orphan, 'deny2')))
    await assertFails(setDoc(varRef(orphan, 'deny4'), payload({ uid: ORPHAN_UID })))
    await assertFails(updateDoc(varRef(orphan, 'deny2'), submitWrite({ uid: ORPHAN_UID })))
  })

  it('tenant isolation — another company’s admin cannot read or write; a member cannot write into another company’s project path', async () => {
    await seed('t1', 'draft')
    await assertFails(getDoc(varRef(ctx(USERS.other), 't1')))
    await assertFails(setDoc(varRef(ctx(USERS.other), 't2'), payload(USERS.other)))
    await assertFails(updateDoc(varRef(ctx(USERS.other), 't1'), draftEdit(USERS.other)))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 't3', COMPANY_B, PROJECT_C), payload(USERS.admin)))
    // …and the other company's own project takes its own admin's variation (currency resolves to AUD there).
    await assertSucceeds(setDoc(varRef(ctx(USERS.other), 't4', COMPANY_B, PROJECT_C), payload(USERS.other)))
  })

  it('a variation cannot be created under a project that does not exist', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'np', COMPANY_A, 'ghostProject'), payload(USERS.admin)))
  })
})

describe('delete', () => {
  it.each(['draft', 'submitted', 'approved', 'rejected', 'withdrawn', 'under_review'])('blocked at %s for every role', async (status) => {
    await seed('d1', status)
    for (const user of [...FINANCIAL, ...NON_MEMBERS, USERS.other]) {
      await assertFails(deleteDoc(varRef(ctx(user), 'd1')))
    }
    await assertFails(deleteDoc(varRef(anon(), 'd1')))
  })
})

// ── Create ───────────────────────────────────────────────────────────────────

describe('create — valid shapes the app writes', () => {
  it('a manual-mode supplier variation, a PO-linked one against a SENT and a CLOSED PO, and a client variation', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c1'), payload(USERS.qs)))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c2'), poLinked(USERS.qs, PO.sent)))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c3'), poLinked(USERS.qs, PO.closed, { variationNumber: 'SV-0002' })))
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'c4'), clientPayload(USERS.pm)))
    const stored = await readVar('c2')
    expect(stored).toMatchObject({ status: 'draft', revision: 1, poId: 'poSent', poNumber: 'PO-0001', supplierName: 'Steel Co', createdBy: USERS.qs.uid, updatedBy: USERS.qs.uid })
    expect(stored.createdAt).toBeInstanceOf(Timestamp)
    expect(stored.updatedAt).toBeInstanceOf(Timestamp)
  })

  it('a PO-linked variation against a pre-Contacts PO (no supplierId key) with supplierId null', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c5'), poLinked(USERS.qs, PO.legacy)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c6'), poLinked(USERS.qs, PO.legacy, { supplierId: 'contactS1' })))
  })

  it('SIGNED money — an all-negative credit, a zero-value variation, mixed tax codes and 200 lines', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c7'), payload(USERS.qs, { lines: [line(-5000), line(-0.01, { taxCode: TAX_CODE.INPUT_TAXED })] })))
    expect(await readVar('c7')).toMatchObject({ submittedSubtotal: -5000.01, submittedGst: -500, submittedTotal: -5500.01 })
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c8'), payload(USERS.qs, { lines: [line(0)] })))
    // mixed signs and tax codes: subtotal 0 with a positive GST is a REAL header (gst on +1000, gst_free on −1000)
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c9'), payload(USERS.qs, { lines: [line(1000), line(-1000, { taxCode: TAX_CODE.GST_FREE })] })))
    expect(await readVar('c9')).toMatchObject({ submittedSubtotal: 0, submittedGst: 100, submittedTotal: 100 })
    const many = Array.from({ length: 200 }, (_, i) => line(i % 2 ? 12.34 : -0.55))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'c10'), payload(USERS.qs, { lines: many })))
  })

  it('with an originating RFI (open / answered / closed), on both types, for every financial role (ADR-34)', async () => {
    for (const [i, r] of [RFIS.open, RFIS.answered, RFIS.closed].entries()) {
      await assertSucceeds(setDoc(varRef(ctx(USERS.admin), `r${i}`), payload(USERS.admin, link(r))))
    }
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'rc'), clientPayload(USERS.pm, link(RFIS.answered))))
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(varRef(ctx(user), `r_${user.uid}`), payload(user, link(RFIS.open))))
    }
  })

  it('the link never writes anything onto the RFI', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.admin), 'rk'), payload(USERS.admin, link(RFIS.open))))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const data = (await getDoc(doc(c.firestore(), rfisPath(), RFIS.open.id))).data()
      expect(data.variationId).toBeUndefined()
      expect(data.variationIds).toBeUndefined()
      expect(data.linkedVariations).toBeUndefined()
      expect(Object.keys(data)).toHaveLength(34)
    })
  })
})

describe('create — exact keys, born draft, stamps and reserved fields', () => {
  it('refuses a missing key, an extra key, and a key renamed', async () => {
    for (const k of ['updatedAt', 'updatedBy', 'submittedBy', 'withdrawnBy', 'originRfiId', 'currency', 'revision', 'attachments', 'forecastAmount']) {
      const { [k]: _gone, ...missing } = payload(USERS.qs)   // eslint-disable-line no-unused-vars
      await assertFails(setDoc(varRef(ctx(USERS.qs), `mk-${k}`), missing))
    }
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'xk1'), payload(USERS.qs, { extra: true })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'xk2'), payload(USERS.qs, { approvedBy2: USERS.qs.uid })))
  })

  it('refuses every non-draft status, including the reserved ones', async () => {
    for (const status of ['submitted', 'approved', 'rejected', 'withdrawn', 'under_review', 'disputed', 'superseded', 'sent', '', null]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), `ns-${status}`), payload(USERS.qs, { status })))
    }
  })

  it('creator stamps — createdBy / updatedBy must be the caller and createdAt / updatedAt request.time (skewed clocks refused)', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'st1'), payload(USERS.qs, { createdBy: USERS.pm.uid })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'st2'), payload(USERS.qs, { updatedBy: USERS.pm.uid })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'st3'), payload(USERS.qs, { createdBy: null })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'st4'), payload(USERS.qs, { createdAt: clock() })))
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'st5'), payload(USERS.qs, { updatedAt: clock() })))
    }
  })

  it('every lifecycle stamp, every approved value, the approved date and the assessment notes must be empty at birth', async () => {
    const forged = [
      { submittedAt: serverTimestamp() }, { submittedBy: USERS.qs.uid }, { approvedAt: serverTimestamp() }, { approvedBy: USERS.qs.uid },
      { rejectedAt: serverTimestamp() }, { rejectedBy: USERS.qs.uid }, { withdrawnAt: serverTimestamp() }, { withdrawnBy: USERS.qs.uid },
      { approvedSubtotal: 0 }, { approvedGst: 0 }, { approvedTotal: 0 }, { approvedSubtotal: 900, approvedGst: 90, approvedTotal: 990 },
      { approvedDate: '2026-10-12' }, { assessmentNotes: 'pre-approved' },
    ]
    for (const [i, f] of forged.entries()) await assertFails(setDoc(varRef(ctx(USERS.qs), `fs${i}`), payload(USERS.qs, f)))
  })

  it('reserved fields at their reserved values — revision 1, attachments [], externalRefs a map, supersededByVariationId and forecastAmount null', async () => {
    for (const revision of [0, 2, '1', null]) await assertFails(setDoc(varRef(ctx(USERS.qs), 'rv'), payload(USERS.qs, { revision })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'rf1'), payload(USERS.qs, { attachments: [{ path: 'x' }] })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'rf2'), payload(USERS.qs, { attachments: null })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'rf3'), payload(USERS.qs, { externalRefs: [] })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'rf4'), payload(USERS.qs, { supersededByVariationId: 'other' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'rf5'), payload(USERS.qs, { forecastAmount: 500 })))
  })

  it('identity — the number pattern follows the type (CV for client, SV for supplier), the type is one of two', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'id1'), payload(USERS.qs, { variationNumber: 'CV-0001' })))            // supplier with a client number
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'id2'), clientPayload(USERS.qs, { variationNumber: 'SV-0001' })))      // client with a supplier number
    for (const n of ['SV-001', 'SV0001', 'sv-0001', 'PO-0001', '', null, 1]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'id3'), payload(USERS.qs, { variationNumber: n })))
    }
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'id4'), payload(USERS.qs, { variationNumber: 'SV-12345' })))
    for (const variationType of ['internal', 'budget_adjustment', '', null]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'id5'), payload(USERS.qs, { variationType })))
    }
  })
})

describe('create — counterparty consistency between the two types', () => {
  it('a client variation carries no supplier block and no PO; a supplier variation carries no client block', async () => {
    for (const f of [{ supplierId: 'contactS1' }, { supplierName: 'Steel Co' }, { supplierRef: '' }, { poId: 'poSent', poNumber: 'PO-0001' }, { poNumber: 'PO-0001' }]) {
      await assertFails(setDoc(varRef(ctx(USERS.pm), 'cc1'), clientPayload(USERS.pm, f)))
    }
    for (const f of [{ clientId: 'contactC1' }, { clientName: 'Owner Pty Ltd' }, { clientRef: 'VO-1' }, { clientRef: '' }]) {
      await assertFails(setDoc(varRef(ctx(USERS.pm), 'cc2'), payload(USERS.pm, f)))
    }
  })

  it('counterparty ids are null or non-empty strings; names and references are strings ≤ 200', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'cp0'), clientPayload(USERS.pm, { clientId: null })))    // a client without a contact id
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'cp0b'), payload(USERS.pm, { supplierId: null })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp1'), clientPayload(USERS.pm, { clientId: '' })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp2'), clientPayload(USERS.pm, { clientName: null })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp3'), clientPayload(USERS.pm, { clientName: 'x'.repeat(201) })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp4'), clientPayload(USERS.pm, { clientRef: null })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp5'), clientPayload(USERS.pm, { clientRef: 'x'.repeat(201) })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp6'), payload(USERS.pm, { supplierId: 7 })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp7'), payload(USERS.pm, { supplierName: null })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp8'), payload(USERS.pm, { supplierRef: null })))
  })
})

describe('create — source PO (a get() on the scalar poId; supplier variations only)', () => {
  it('a draft, pending-approval or cancelled PO is refused; a missing PO is refused', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po1'), poLinked(USERS.qs, PO.draft)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po2'), poLinked(USERS.qs, PO.pending)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po3'), poLinked(USERS.qs, PO.cancelled)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po4'), poLinked(USERS.qs, { ...PO.sent, id: 'ghost' })))
  })

  it('a PO from another project of the same company is refused — the path is this project’s', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po5'), poLinked(USERS.qs, PO_IN_PROJECT_B)))
    // …and the same document is accepted in the project that owns the PO (currency NZD there).
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'po6', COMPANY_A, PROJECT_B), poLinked(USERS.qs, PO_IN_PROJECT_B, { currency: 'NZD' })))
  })

  it('the PO number and the supplier snapshot (name AND id) must be the PO’s', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po7'), poLinked(USERS.qs, PO.sent, { poNumber: 'PO-0002' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po8'), poLinked(USERS.qs, PO.sent, { poNumber: null })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po9'), poLinked(USERS.qs, PO.sent, { supplierName: 'Rival Co' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po10'), poLinked(USERS.qs, PO.sent, { supplierId: 'contactS9' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po11'), poLinked(USERS.qs, PO.sent, { supplierId: null })))
  })

  it('manual mode is a null PAIR — a poNumber without a poId, an empty-string or non-string poId are refused', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po12'), payload(USERS.qs, { poNumber: 'PO-0001' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po13'), payload(USERS.qs, { poId: '', poNumber: null })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po14'), payload(USERS.qs, { poId: 42, poNumber: 'PO-0001' })))
  })
})

describe('create — currency resolves exactly as lib/currency.js (project → company → AUD)', () => {
  it('the project’s explicit currency, the company’s baseCurrency when the project has none, AUD when neither', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'cu1'), payload(USERS.qs, { currency: 'AUD' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu2'), payload(USERS.qs, { currency: 'NZD' })))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'cu3', COMPANY_A, PROJECT_B), payload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu4', COMPANY_A, PROJECT_B), payload(USERS.qs, { currency: 'AUD' })))
    await assertSucceeds(setDoc(varRef(ctx(USERS.other), 'cu5', COMPANY_B, PROJECT_C), payload(USERS.other, { currency: 'AUD' })))
    await assertFails(setDoc(varRef(ctx(USERS.other), 'cu6', COMPANY_B, PROJECT_C), payload(USERS.other, { currency: 'NZD' })))
    for (const currency of ['aud', 'AU', 'AUDX', '', null, 36]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu7'), payload(USERS.qs, { currency })))
    }
  })
})

describe('create — content shape', () => {
  it('title required (1–500), description ≤ 5000, reason from the enum, dates empty or YYYY-MM-DD, notes ≤ 5000, 1–200 lines', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs1'), payload(USERS.qs, { title: '' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs2'), payload(USERS.qs, { title: 'x'.repeat(501) })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs3'), payload(USERS.qs, { title: null })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs4'), payload(USERS.qs, { description: 'x'.repeat(5001) })))
    for (const reason of ['weather', 'DESIGN_CHANGE', null, 3]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs5'), payload(USERS.qs, { reason })))
    }
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'cs6'), payload(USERS.qs, { reason: 'error_omission' })))
    for (const k of ['identifiedDate', 'submittedDate', 'responseDueDate', 'effectiveDate']) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), `cs7-${k}`), payload(USERS.qs, { [k]: '10/10/2026' })))
      await assertFails(setDoc(varRef(ctx(USERS.qs), `cs8-${k}`), payload(USERS.qs, { [k]: null })))
      await assertSucceeds(setDoc(varRef(ctx(USERS.qs), `cs9-${k}`), payload(USERS.qs, { [k]: '2026-12-31' })))
    }
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs10'), payload(USERS.qs, { notes: 'x'.repeat(5001) })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs11'), payload(USERS.qs, { lineItems: [] })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs12'), payload(USERS.qs, { lineItems: 'none' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs13'), payload(USERS.qs, { lines: Array.from({ length: 201 }, () => line(1)) })))
  })
})

describe('create — SIGNED whole-cent header money', () => {
  it('each header figure must be a number, whole cents, and subtotal + gst == total exactly', async () => {
    const t = variationTotals(LINES, 'submitted')   // 800 / 100 / 900
    for (const f of [
      { submittedSubtotal: '800' }, { submittedGst: null }, { submittedTotal: undefined },
      { submittedSubtotal: 800.001 }, { submittedGst: 100.005 }, { submittedTotal: 900.0049 },
      { submittedTotal: 900.01 }, { submittedTotal: 899.99 }, { submittedGst: 101 }, { submittedSubtotal: 801 },
    ]) {
      const p = payload(USERS.qs)
      Object.assign(p, { submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total, ...f })
      if (f.submittedTotal === undefined && 'submittedTotal' in f) delete p.submittedTotal
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'm1'), p))
    }
    // a one-cent total mismatch on a NEGATIVE header is refused too
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'm2'), payload(USERS.qs, { lines: [line(-1000)], submittedTotal: -1099.99 })))
    // large signed values with floating-point noise are fine (roundMoney output)
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'm3'), payload(USERS.qs, { lines: [line(1234567.89), line(-0.03, { taxCode: TAX_CODE.GST_FREE })] })))
  })

  it('negative variations are NOT clamped — a credit header is stored signed', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'm4'), payload(USERS.qs, { lines: [line(-1234.5)] })))
    expect(await readVar('m4')).toMatchObject({ submittedSubtotal: -1234.5, submittedGst: -123.45, submittedTotal: -1357.95 })
  })
})

describe('create — originating RFI (ADR-34, unchanged semantics)', () => {
  it('a draft, cancelled or nonexistent RFI, or one from another project / company, is refused', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o1'), payload(USERS.admin, link(RFIS.draft))))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o2'), payload(USERS.admin, link(RFIS.cancelled))))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o3'), payload(USERS.admin, { originRfiId: 'nope', originRfiNumber: 'RFI-0099', originRfiTitle: 'Ghost' })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o4'), payload(USERS.admin, link(RFI_IN_PROJECT_B))))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o5'), payload(USERS.admin, link(RFI_IN_COMPANY_B))))
  })

  it.each([
    ['id only',               { originRfiId: RFIS.open.id, originRfiNumber: null, originRfiTitle: null }],
    ['id + number only',      { originRfiId: RFIS.open.id, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: null }],
    ['number only',           { originRfiId: null, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: null }],
    ['title only',            { originRfiId: null, originRfiNumber: null, originRfiTitle: RFIS.open.title }],
    ['number + title, no id', { originRfiId: null, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: RFIS.open.title }],
    ['empty-string id',       { originRfiId: '', originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: RFIS.open.title }],
    ['numeric id',            { originRfiId: 42, originRfiNumber: RFIS.open.rfiNumber, originRfiTitle: RFIS.open.title }],
  ])('a partial or malformed triple is refused — %s', async (_label, triple) => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o6'), payload(USERS.admin, triple)))
  })

  it('a wrong number or title snapshot (including a trimmed, re-cased or non-string copy) is refused', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o7'), payload(USERS.admin, { ...link(RFIS.open), originRfiNumber: 'RFI-0002' })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o8'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: 'Something else' })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o9'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: RFIS.open.title + ' ' })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o10'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: RFIS.open.title.toUpperCase() })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o11'), payload(USERS.admin, { ...link(RFIS.open), originRfiTitle: 7 })))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o12'), payload(USERS.admin, { ...link(RFIS.open), originRfiNumber: ['RFI-0001'] })))
  })

  it('the three keys are now part of the EXACT key set — a create without them is refused (the hook has written them since ADR-34)', async () => {
    const p = payload(USERS.admin)
    delete p.originRfiId; delete p.originRfiNumber; delete p.originRfiTitle
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'o13'), p))
  })
})

// ── Draft edit ───────────────────────────────────────────────────────────────

describe('draft edit — the authored content, the re-derived header and the ADR-34 link', () => {
  it('accepts the hook payload — content, SIGNED header, revision 2 and the audit stamps; the line count may change', async () => {
    await seed('e1', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'e1'), draftEdit(USERS.qs)))
    const after = await readVar('e1')
    expect(after).toMatchObject({ title: 'Additional steel (revised)', reason: 'site_condition', supplierRef: 'Q-9', clientRef: null, submittedSubtotal: 1200, submittedGst: 150, submittedTotal: 1350, revision: 2, updatedBy: USERS.qs.uid, status: 'draft' })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'e1'), draftEdit(USERS.qs, { lines: [line(-50)], revision: 3 })))
    expect(await readVar('e1')).toMatchObject({ submittedSubtotal: -50, submittedGst: -5, submittedTotal: -55, revision: 3 })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'e1'), draftEdit(USERS.qs, { lines: Array.from({ length: 200 }, () => line(1)), revision: 4 })))
  })

  it('a client draft edits its clientRef; notes may be written; a partial edit (one field + revision + stamps) is fine', async () => {
    await seed('e2', 'draft', USERS.admin, {}, { base: clientPayload(USERS.admin) })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'e2'), { clientRef: 'VO-8', supplierRef: null, notes: 'Agreed on site', revision: 2, ...stamps(USERS.pm) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'e2'), { title: 'Retitled', revision: 3, ...stamps(USERS.pm) }))
    expect(await readVar('e2')).toMatchObject({ clientRef: 'VO-8', notes: 'Agreed on site', title: 'Retitled', revision: 3 })
  })

  it('a LEGACY draft (no originRfi*, no audit stamps) edits and acquires the keys', async () => {
    await seed('e3', 'draft', USERS.admin, {}, { legacy: true })
    expect((await readVar('e3')).updatedAt).toBeUndefined()
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'e3'), draftEdit(USERS.qs)))
    const after = await readVar('e3')
    expect(after.revision).toBe(2)
    expect(after.updatedBy).toBe(USERS.qs.uid)
    expect(after.originRfiId).toBeUndefined()   // untouched — absent still reads as unlinked
  })

  it('refuses the stamps missing or forged, the wrong revision, and a skewed updatedAt', async () => {
    await seed('e4', 'draft')
    const { updatedAt: _a, ...noAt } = draftEdit(USERS.qs)   // eslint-disable-line no-unused-vars
    const { updatedBy: _b, ...noBy } = draftEdit(USERS.qs)   // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e4'), noAt))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e4'), noBy))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { updatedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { updatedAt: clock() })))
    for (const revision of [1, 3, '2', null]) await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e4'), draftEdit(USERS.qs, { revision })))
  })

  it('refuses a status change, any lifecycle stamp, any approved value, the assessment notes or the dates a transition owns', async () => {
    await seed('e5', 'draft')
    for (const f of [
      { status: 'submitted' }, { status: 'approved' }, { submittedAt: serverTimestamp() }, { submittedBy: USERS.qs.uid }, { approvedBy: USERS.qs.uid },
      { withdrawnAt: serverTimestamp() }, { approvedSubtotal: 1 }, { approvedGst: 0 }, { approvedTotal: 1 }, { assessmentNotes: 'x' },
      { submittedDate: '2026-10-11' }, { approvedDate: '2026-10-12' },
    ]) {
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e5'), draftEdit(USERS.qs, f)))
    }
  })

  it('refuses every identity, counterparty, PO-link, reserved and provenance field', async () => {
    await seed('e6', 'draft', USERS.admin, {}, { base: poLinked(USERS.admin) })
    for (const f of [
      { variationNumber: 'SV-0009' }, { variationType: 'client' }, { supplierId: 'contactS9' }, { supplierName: 'Rival Co' },
      { clientId: 'contactC1' }, { clientName: 'Owner' }, { poId: 'poClosed' }, { poNumber: 'PO-0002' }, { poId: null, poNumber: null },
      { currency: 'NZD' }, { forecastAmount: 1 }, { attachments: ['x'] }, { externalRefs: { xero: '1' } }, { supersededByVariationId: 'v2' },
      { createdBy: USERS.qs.uid }, { createdAt: serverTimestamp() },
    ]) {
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e6'), draftEdit(USERS.qs, f)))
    }
    expect((await readVar('e6')).poId).toBe('poSent')
  })

  it('re-validates the content shape and the money — an empty title, a bad date, no lines, a third-decimal subtotal, a total off by a cent are refused', async () => {
    await seed('e7', 'draft')
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { title: '' })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { responseDueDate: 'soon' })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { lineItems: [] })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { lineItems: Array.from({ length: 201 }, () => line(1)) })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { submittedSubtotal: 1200.001 })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { submittedTotal: 1350.01 })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { reason: 'because' })))
    // the external reference stays on the document's own side
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { clientRef: 'VO-1' })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'e7'), draftEdit(USERS.qs, { supplierRef: null })))
  })

  it('ADR-34 — add, change and remove the link on a draft (and a legacy draft); an unchanged or re-sent identical triple is never re-validated', async () => {
    await seed('l1', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'l1'), { ...link(RFIS.open), revision: 2, ...stamps(USERS.qs) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'l1'), { ...link(RFIS.answered), revision: 3, ...stamps(USERS.pm) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'l1'), { ...draftEdit(USERS.admin, { revision: 4 }), ...link(RFIS.answered) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'l1'), { ...UNLINKED, revision: 5, ...stamps(USERS.admin) }))
    await seed('l2', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'l2'), { ...link(RFIS.closed), revision: 2, ...stamps(USERS.qs) }))
    await seed('l3', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'l3'), { ...draftEdit(USERS.qs), ...UNLINKED }))   // absent == null
  })

  it('ADR-34 — a draft, cancelled, nonexistent, other-project or other-company RFI, a mismatched snapshot and a partial change are refused', async () => {
    await seed('l4', 'draft', USERS.admin, link(RFIS.open))
    const w = (triple) => ({ ...triple, revision: 2, ...stamps(USERS.admin) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w(link(RFIS.draft))))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w(link(RFIS.cancelled))))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w({ originRfiId: 'nope', originRfiNumber: 'RFI-0099', originRfiTitle: 'Ghost' })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w(link(RFI_IN_PROJECT_B))))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w(link(RFI_IN_COMPANY_B))))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w({ originRfiNumber: 'RFI-0009' })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w({ originRfiTitle: 'Rewritten' })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w({ originRfiId: RFIS.answered.id })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'l4'), w({ originRfiId: null })))
  })

  it('ADR-34 CRITICAL HISTORICAL CASE — a link survives its RFI’s later cancellation: unrelated edits and every transition still pass; only CHANGING to it is refused', async () => {
    await seed('h1', 'draft', USERS.admin, link(RFIS.open))
    await setRfiStatus(RFIS.open, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'h1'), draftEdit(USERS.admin)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'h1'), { ...draftEdit(USERS.admin, { revision: 3 }), ...link(RFIS.open) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'h1'), submitWrite(USERS.admin, { revision: 4 })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'h1'), approveWrite(USERS.pm, { revision: 5, lines: draftEdit(USERS.admin).lineItems, amounts: [1500, -300] })))
    const after = await readVar('h1')
    expect(after).toMatchObject({ ...link(RFIS.open), status: 'approved' })
    await seed('h2', 'draft', USERS.admin, link(RFIS.answered))
    await setRfiStatus(RFIS.answered, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'h2'), withdrawWrite(USERS.qs)))
    await seed('h3', 'submitted', USERS.admin, link(RFIS.closed))
    await setRfiStatus(RFIS.closed, 'cancelled')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'h3'), rejectWrite(USERS.admin)))
    await seed('h4', 'draft', USERS.admin, link(RFIS.answered))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'h4'), { ...link(RFIS.open), revision: 2, ...stamps(USERS.admin) }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'h4'), { ...UNLINKED, revision: 2, ...stamps(USERS.admin) }))   // removing a historical link stays allowed
  })

  it('a non-draft document admits NO content edit — submitted, approved, rejected, withdrawn and under_review are frozen (the link included, for every role, legacy documents too)', async () => {
    for (const status of ['submitted', 'approved', 'rejected', 'withdrawn', 'under_review']) {
      await seed(`fr-${status}`, status, USERS.admin, link(RFIS.open))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fr-${status}`), draftEdit(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fr-${status}`), { title: 'late', revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fr-${status}`), { notes: 'late note', revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fr-${status}`), { lineItems: [line(9999)], submittedSubtotal: 9999, submittedGst: 999.9, submittedTotal: 10998.9, revision: 2, ...stamps(USERS.admin) }))
      // the ADR-34 freeze, case by case and for every financial role: remove,
      // partial removal, change the id (with and without its snapshots), change
      // only the number, only the title, or change to a perfectly valid RFI
      for (const user of FINANCIAL) {
        for (const w of [UNLINKED, { originRfiId: null }, link(RFIS.closed), { originRfiId: RFIS.answered.id }, { originRfiNumber: 'RFI-0002' }, { originRfiTitle: 'Forged' }]) {
          await assertFails(updateDoc(varRef(ctx(user), `fr-${status}`), { ...w, revision: 2, ...stamps(user) }))
        }
      }
      // re-sending the identical triple is not a change — but there is no branch for it outside draft either
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fr-${status}`), { ...link(RFIS.open), notes: 'x', revision: 2, ...stamps(USERS.admin) }))
      // an unlinked and a LEGACY (keys absent) non-draft document cannot gain a link either
      await seed(`fu-${status}`, status)
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fu-${status}`), { ...link(RFIS.open), revision: 2, ...stamps(USERS.admin) }))
      await seed(`fl-${status}`, status, USERS.admin, {}, { legacy: true })
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `fl-${status}`), { ...link(RFIS.open), revision: 2, ...stamps(USERS.admin) }))
      expect((await readVar(`fr-${status}`))).toMatchObject({ ...link(RFIS.open), status, revision: 1 })
    }
  })
})

// ── Source PO link and counterparty — frozen from creation ───────────────────
//
// Lead Architect review question (M2-B3 final review): can a direct-SDK caller
// create a legitimate PO-linked supplier variation, then re-point the DRAFT at
// an invalid, cancelled, foreign-project or unrelated PO (or forge the supplier
// snapshot or the type) and carry that through submit and approve? No: the
// draft-edit branch's hasOnly list names none of poId / poNumber / supplierId /
// supplierName / clientId / clientName / variationType / variationNumber, so
// the link, the counterparty and the type are frozen at creation — where the
// PO was get()-verified — and every other branch is stamps-only. The app's
// editor never changes them either (ADR-35: type, counterparty and PO are
// read-only context on edit), so freezing costs no workflow.

describe('source PO link, counterparty and type — frozen from creation (every path, every status)', () => {
  const edit = (user, extra) => draftEdit(user, extra)

  it('A → B → C: a legitimately created PO-linked variation cannot be re-pointed as a draft — every re-link, snapshot forgery and type flip is refused; it then submits and approves against its ORIGINAL PO', async () => {
    // A. legitimate create against the sent PO, through the rules
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'fz1'), poLinked(USERS.qs, PO.sent)))
    // B. every invalid (and every merely different) source change on the draft
    const relinks = [
      { poId: PO.cancelled.id, poNumber: PO.cancelled.poNumber },                                       // cancelled PO
      { poId: PO.draft.id, poNumber: PO.draft.poNumber },                                               // draft PO
      { poId: PO_IN_PROJECT_B.id, poNumber: PO_IN_PROJECT_B.poNumber },                                 // foreign-project PO
      { poId: PO.closed.id, poNumber: PO.closed.poNumber },                                             // a VALID but different PO
      { poId: 'ghost', poNumber: 'PO-9999' },                                                           // nonexistent PO
      { poId: PO.closed.id },                                                                           // id without its number
      { poNumber: 'PO-0002' },                                                                          // number without its id
      { poId: null, poNumber: null },                                                                   // demote to manual mode
      { supplierId: 'contactS9' }, { supplierName: 'Rival Co' }, { supplierId: null }, { supplierName: PO.legacy.supplierName },
      { variationType: 'client', variationNumber: 'CV-0001', clientId: 'contactC1', clientName: 'Owner Pty Ltd', clientRef: '', supplierId: null, supplierName: null, supplierRef: null, poId: null, poNumber: null },
      { variationNumber: 'SV-0099' },
      { clientId: 'contactC1' }, { clientName: 'Owner Pty Ltd' },
    ]
    for (const [i, f] of relinks.entries()) {
      // alone, bundled with an otherwise-legitimate content edit, and as a whole-document replacement
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'fz1'), { ...f, revision: 2, ...stamps(USERS.qs) }))
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), edit(USERS.pm, f)))
      const { id: _id, ...stored } = await readVar('fz1')   // eslint-disable-line no-unused-vars
      await assertFails(setDoc(varRef(ctx(USERS.admin), 'fz1'), { ...stored, ...f, revision: 2, ...stamps(USERS.admin) }))
      expect((await readVar('fz1')).revision, `relink ${i} must not land`).toBe(1)
    }
    // a bundled re-link plus submit, and a re-link disguised as a transition, fail as a whole
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'fz1'), submitWrite(USERS.qs, { poId: PO.closed.id, poNumber: PO.closed.poNumber })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'fz1'), submitWrite(USERS.qs, { supplierName: 'Rival Co' })))
    expect(await readVar('fz1')).toMatchObject({ status: 'draft', poId: PO.sent.id, poNumber: PO.sent.poNumber, supplierName: PO.sent.supplierName, supplierId: PO.sent.supplierId, variationType: 'supplier', revision: 1 })
    // C. the legitimate path still works: a content edit, submit and approve, identity intact throughout
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'fz1'), edit(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'fz1'), submitWrite(USERS.qs, { revision: 3 })))
    for (const f of relinks) await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), { ...f, revision: 4, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), approveWrite(USERS.pm, { revision: 4, lines: edit(USERS.qs).lineItems, amounts: [1500, -300], poId: PO.closed.id, poNumber: PO.closed.poNumber })))
    // Since ADR-62 a PO-linked approve carries the commitment pair (the PO is sent); the plain form is the old bundle's and is denied by the FINAL rules.
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), approveWrite(USERS.pm, { revision: 4, lines: edit(USERS.qs).lineItems, amounts: [1500, -300] })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'fz1'), approveWrite(USERS.pm, { revision: 4, lines: edit(USERS.qs).lineItems, amounts: [1500, -300], commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: USERS.pm.uid })))
    const approved = await readVar('fz1')
    expect(approved).toMatchObject({ status: 'approved', poId: PO.sent.id, poNumber: PO.sent.poNumber, supplierName: PO.sent.supplierName, supplierId: PO.sent.supplierId, variationType: 'supplier', variationNumber: 'SV-0001', revision: 4 })
    for (const f of relinks) await assertFails(updateDoc(varRef(ctx(USERS.admin), 'fz1'), { ...f, revision: 5, ...stamps(USERS.admin) }))
    // the exposure the figures read is against the ORIGINAL PO only
    expect(poCancellationBlockers(PO.sent.id, { variations: [approved] })).toHaveLength(1)
    expect(poCancellationBlockers(PO.closed.id, { variations: [approved] })).toEqual([])
  })

  it('manual-mode and PO-linked are fixed at creation in both directions; a client variation can never gain a PO; legitimate content edits on each still pass; a legacy link survives its PO’s cancellation', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'fz2'), payload(USERS.qs)))            // manual mode
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'fz3'), clientPayload(USERS.pm)))       // client
    for (const f of [{ poId: PO.sent.id, poNumber: PO.sent.poNumber }, { poId: PO.sent.id }, { poNumber: PO.sent.poNumber }, { supplierId: PO.sent.supplierId, supplierName: PO.sent.supplierName, poId: PO.sent.id, poNumber: PO.sent.poNumber }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'fz2'), edit(USERS.qs, f)))          // manual → linked, even to a valid sent PO
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz3'), edit(USERS.pm, { ...f, clientRef: 'VO-7', supplierRef: null })))   // client → PO
    }
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz3'), edit(USERS.pm, { variationType: 'supplier', variationNumber: 'SV-0005', supplierId: PO.sent.supplierId, supplierName: PO.sent.supplierName, clientId: null, clientName: null, clientRef: null, supplierRef: '' })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'fz2'), edit(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'fz3'), edit(USERS.pm, { clientRef: 'VO-8', supplierRef: null })))
    expect(await readVar('fz2')).toMatchObject({ poId: null, poNumber: null, revision: 2 })
    expect(await readVar('fz3')).toMatchObject({ variationType: 'client', poId: null, clientId: 'contactC1', revision: 2 })
    // a legacy PO-linked draft keeps its link through the PO's later cancellation and still edits (the PO is read at create only)
    await seed('fz4', 'draft', USERS.admin, {}, { legacy: true, base: poLinked(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), PO.sent.id), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'fz4'), edit(USERS.qs)))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'fz4'), edit(USERS.qs, { poId: PO.closed.id, poNumber: PO.closed.poNumber, revision: 3 })))   // nor may the stale link be "repaired" to another PO
    expect(await readVar('fz4')).toMatchObject({ poId: PO.sent.id, poNumber: PO.sent.poNumber, revision: 2 })
  })
})

// ── Revision ─────────────────────────────────────────────────────────────────

describe('revision — exactly +1 on every update', () => {
  it('the same revision, +2, a string, null or a missing revision is refused on every branch', async () => {
    for (const [status, write] of [['draft', draftEdit], ['draft', submitWrite], ['submitted', approveWrite], ['submitted', rejectWrite], ['submitted', withdrawWrite]]) {
      await seed('rv1', status)
      for (const revision of [1, 3, '2', null, 0]) {
        await assertFails(updateDoc(varRef(ctx(USERS.qs), 'rv1'), write(USERS.qs, { revision })))
      }
      const { revision: _r, ...missing } = write(USERS.qs)   // eslint-disable-line no-unused-vars
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'rv1'), missing))
    }
  })

  it('a stored revision of 7 takes 8 only; a document with NO revision key takes 1', async () => {
    await seed('rv2', 'draft', USERS.admin, { revision: 7 })
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'rv2'), submitWrite(USERS.qs, { revision: 2 })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'rv2'), submitWrite(USERS.qs, { revision: 8 })))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const { revision: _r, ...noRev } = { ...payload(USERS.admin), createdAt: Timestamp.now(), updatedAt: Timestamp.now() }   // eslint-disable-line no-unused-vars
      await setDoc(doc(c.firestore(), varsPath(), 'rv3'), noRev)
    })
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'rv3'), submitWrite(USERS.qs, { revision: 2 })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'rv3'), submitWrite(USERS.qs, { revision: 1 })))
  })

  it('two assessors who both reviewed revision 1: the second plain update is refused (it carries 2 over a stored 2)', async () => {
    await seed('rv4', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'rv4'), approveWrite(USERS.pm, { amounts: [1000, -200], assessmentNotes: '' })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'rv4'), approveWrite(USERS.qs, { amounts: [500, -200] })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'rv4'), rejectWrite(USERS.qs)))
    expect(await readVar('rv4')).toMatchObject({ approvedSubtotal: 800, revision: 2, approvedBy: USERS.pm.uid })
  })
})

// ── Transitions ──────────────────────────────────────────────────────────────

describe('transitions — the legal matrix', () => {
  it('draft → submitted writes the stamps and the submitted date; the submitted header is then frozen', async () => {
    await seed('t1', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't1'), submitWrite(USERS.qs)))
    expect(await readVar('t1')).toMatchObject({ status: 'submitted', submittedBy: USERS.qs.uid, submittedDate: '2026-10-11', revision: 2, submittedSubtotal: 800 })
    // a submit that keeps an already-set date, and one that sets none ('' stays valid) also pass
    await seed('t1b', 'draft', USERS.admin, { submittedDate: '2026-10-01' })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't1b'), { status: 'submitted', submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid, revision: 2, ...stamps(USERS.qs) }))
    await seed('t1c', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't1c'), submitWrite(USERS.qs, { submittedDate: '' })))
  })

  it('submitted → approved writes the certified lines, the SIGNED approved header, the notes, the dates and the stamps — and the document is then terminal', async () => {
    await seed('t2', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 't2'), approveWrite(USERS.pm)))
    const after = await readVar('t2')
    expect(after).toMatchObject({ status: 'approved', approvedBy: USERS.pm.uid, approvedSubtotal: 700, approvedGst: 90, approvedTotal: 790, assessmentNotes: 'Negotiated', approvedDate: '2026-10-12', effectiveDate: '2026-10-12', revision: 2 })
    expect(after.lineItems.map(l => l.approvedAmount)).toEqual([900, -200])
    expect(after.submittedSubtotal).toBe(800)
    for (const w of [rejectWrite, withdrawWrite, submitWrite, draftEdit]) await assertFails(updateDoc(varRef(ctx(USERS.pm), 't2'), w(USERS.pm, { revision: 3 })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't2'), approveWrite(USERS.pm, { revision: 3, amounts: [1, -1] })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't2'), { status: 'draft', revision: 3, ...stamps(USERS.pm) }))
  })

  it('approval is UNBOUNDED against submitted — above, equal, zero and negative certified values are all accepted (never clamped)', async () => {
    for (const [i, amounts] of [[5000, 2000], [1000, -200], [0, 0], [-1000, -5000]].entries()) {
      await seed(`t3-${i}`, 'submitted')
      await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), `t3-${i}`), approveWrite(USERS.pm, { amounts })))
      const t = variationTotals(buildApprovedLineItems(LINES, amounts), 'approved')
      expect(await readVar(`t3-${i}`)).toMatchObject({ approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total })
    }
  })

  it('submitted → rejected (with or without notes) and submitted → withdrawn are stamps-only and terminal; draft → withdrawn too', async () => {
    await seed('t4', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't4'), rejectWrite(USERS.qs, { assessmentNotes: 'Not agreed' })))
    expect(await readVar('t4')).toMatchObject({ status: 'rejected', rejectedBy: USERS.qs.uid, assessmentNotes: 'Not agreed', revision: 2 })
    await seed('t5', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't5'), rejectWrite(USERS.qs)))
    await seed('t6', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't6'), withdrawWrite(USERS.qs)))
    await seed('t7', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 't7'), withdrawWrite(USERS.qs)))
    for (const id of ['t4', 't5', 't6', 't7']) {
      for (const w of [submitWrite, approveWrite, rejectWrite, withdrawWrite, draftEdit]) {
        await assertFails(updateDoc(varRef(ctx(USERS.admin), id), w(USERS.admin, { revision: 3 })))
      }
      await assertFails(updateDoc(varRef(ctx(USERS.admin), id), { status: 'draft', revision: 3, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), id), { status: 'submitted', revision: 3, ...stamps(USERS.admin) }))
    }
  })

  it('a document already holding the reserved under_review can be approved, rejected or withdrawn (none is stranded), but nothing can ENTER it', async () => {
    await seed('t8', 'under_review')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 't8'), approveWrite(USERS.pm)))
    await seed('t9', 'under_review')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 't9'), rejectWrite(USERS.pm)))
    await seed('t10', 'under_review')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 't10'), withdrawWrite(USERS.pm)))
    for (const status of ['draft', 'submitted']) {
      await seed(`t11-${status}`, status)
      await assertFails(updateDoc(varRef(ctx(USERS.pm), `t11-${status}`), { status: 'under_review', revision: 2, ...stamps(USERS.pm) }))
    }
  })

  it('the reserved disputed and superseded are unreachable as targets and terminal as sources; unknown statuses are refused from every state', async () => {
    for (const status of ['draft', 'submitted', 'under_review']) {
      await seed(`t12-${status}`, status)
      for (const target of ['disputed', 'superseded', 'certified', 'cancelled', 'sent', '', null]) {
        await assertFails(updateDoc(varRef(ctx(USERS.admin), `t12-${status}`), { status: target, revision: 2, ...stamps(USERS.admin) }))
      }
    }
    for (const status of ['disputed', 'superseded']) {
      await seed(`t13-${status}`, status)
      for (const w of [submitWrite, approveWrite, rejectWrite, withdrawWrite, draftEdit]) {
        await assertFails(updateDoc(varRef(ctx(USERS.admin), `t13-${status}`), w(USERS.admin)))
      }
    }
  })

  it('illegal moves — draft → approved / rejected, submitted → draft / submitted, and any move from a terminal state', async () => {
    await seed('t14', 'draft')
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't14'), approveWrite(USERS.pm)))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't14'), rejectWrite(USERS.pm)))
    // the ADR-57 PO precedent: a no-op "draft → draft" with only stamps and revision IS a (content-free) draft edit
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 't14'), { status: 'draft', revision: 2, ...stamps(USERS.pm) }))
    await seed('t15', 'submitted')
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't15'), { status: 'draft', submittedAt: null, submittedBy: null, revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't15'), { status: 'submitted', revision: 2, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't15'), submitWrite(USERS.pm)))
  })
})

describe('transition purity — stamps-only, actor == caller, time == request.time', () => {
  it('submit, reject and withdraw may carry NO content change — a bundled title, line, header, counterparty or link change fails the whole write', async () => {
    await seed('p1', 'draft', USERS.admin, link(RFIS.open))
    for (const extra of [{ title: 'x' }, { lineItems: [line(1)] }, { submittedSubtotal: 1 }, { notes: 'n' }, { supplierRef: 'z' }, { poId: 'poClosed', poNumber: 'PO-0002' }, { ...link(RFIS.closed) }, { ...UNLINKED }, { approvedSubtotal: 1 }, { approvedBy: USERS.admin.uid }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'p1'), submitWrite(USERS.admin, extra)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'p1'), withdrawWrite(USERS.admin, extra)))
    }
    await seed('p2', 'submitted')
    for (const extra of [{ title: 'x' }, { lineItems: [line(1)] }, { approvedSubtotal: 1 }, { submittedSubtotal: 1 }, { notes: 'n' }, { approvedBy: USERS.admin.uid }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'p2'), rejectWrite(USERS.admin, extra)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'p2'), withdrawWrite(USERS.admin, extra)))
    }
    expect(await readStatus('p1')).toBe('draft')
    expect(await readStatus('p2')).toBe('submitted')
  })

  it('approve may touch nothing but the certified lines, the approved header, the notes, the dates and its stamps', async () => {
    await seed('p3', 'submitted')
    for (const extra of [{ title: 'x' }, { submittedSubtotal: 1 }, { submittedGst: 0 }, { notes: 'n' }, { supplierName: 'Rival' }, { poId: 'poClosed', poNumber: 'PO-0002' }, { identifiedDate: '2026-01-01' }, { submittedDate: '2026-01-01' }, { rejectedBy: USERS.pm.uid }, { ...link(RFIS.open) }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p3'), approveWrite(USERS.pm, extra)))
    }
    expect(await readStatus('p3')).toBe('submitted')
  })

  it('the actor must be the caller and the timestamp request.time on every transition (another uid, null, skewed clocks refused)', async () => {
    const cases = [
      ['draft', submitWrite, 'submittedAt', 'submittedBy'],
      ['submitted', approveWrite, 'approvedAt', 'approvedBy'],
      ['submitted', rejectWrite, 'rejectedAt', 'rejectedBy'],
      ['submitted', withdrawWrite, 'withdrawnAt', 'withdrawnBy'],
    ]
    for (const [status, write, at, by] of cases) {
      await seed('p4', status)
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), write(USERS.qs, { [by]: USERS.pm.uid })))
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), write(USERS.qs, { [by]: null })))
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), write(USERS.qs, { updatedBy: USERS.pm.uid })))
      for (const clock of CLIENT_CLOCKS) {
        await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), write(USERS.qs, { [at]: clock() })))
        await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), write(USERS.qs, { updatedAt: clock() })))
      }
      const { [at]: _a, ...noAt } = write(USERS.qs)   // eslint-disable-line no-unused-vars
      const { [by]: _b, ...noBy } = write(USERS.qs)   // eslint-disable-line no-unused-vars
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), noAt))
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p4'), noBy))
      expect(await readStatus('p4')).toBe(status)
    }
  })

  it('approve — the certified line COUNT is pinned to the stored count; the approved date is required; the dates and notes are bounded', async () => {
    await seed('p5', 'submitted')
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { lineItems: [buildApprovedLineItems(LINES, [900, -200])[0]] })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { lineItems: [...buildApprovedLineItems(LINES, [900, -200]), line(1)] })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { lineItems: 'none' })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { approvedDate: '' })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { approvedDate: '12/10/2026' })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { effectiveDate: 'asap' })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { assessmentNotes: 'x'.repeat(5001) })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { assessmentNotes: null })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'p5'), rejectWrite(USERS.pm, { assessmentNotes: 'x'.repeat(5001) })))
    // an approval that leaves the effective date empty is fine (the hook always fills it; '' is a valid date value)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'p5'), approveWrite(USERS.pm, { effectiveDate: '' })))
  })

  it('submit — the stored draft must hold at least one line; the submitted date must be a date', async () => {
    await seed('p6', 'draft', USERS.admin, { lineItems: [] })
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p6'), submitWrite(USERS.qs)))
    await seed('p7', 'draft')
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p7'), submitWrite(USERS.qs, { submittedDate: 'today' })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p7'), submitWrite(USERS.qs, { submittedDate: null })))
  })
})

describe('approval money — SIGNED whole cents, total exact', () => {
  it('refuses a non-number, a third-decimal value, and a total off by one cent in either direction; accepts the real buildApprovedLineItems header on every sign', async () => {
    await seed('am1', 'submitted')
    for (const f of [{ approvedSubtotal: '700' }, { approvedGst: null }, { approvedSubtotal: 700.001 }, { approvedGst: 90.005 }, { approvedTotal: 790.01 }, { approvedTotal: 789.99 }, { approvedGst: 91 }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'am1'), approveWrite(USERS.pm, f)))
    }
    const { approvedTotal: _t, ...noTotal } = approveWrite(USERS.pm)   // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'am1'), noTotal))
    expect(await readStatus('am1')).toBe('submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'am1'), approveWrite(USERS.pm, { amounts: [-333.33, 0.01] })))
    expect(await readVar('am1')).toMatchObject({ approvedSubtotal: -333.32, approvedGst: -33.33, approvedTotal: -366.65 })
  })
})

// ── Direct-SDK bypass attempts ───────────────────────────────────────────────

describe('direct-SDK bypasses that are now refused', () => {
  it('cannot create a variation already approved, submitted or withdrawn — with or without stamps', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'b1'), payload(USERS.qs, { status: 'approved', ...approveWrite(USERS.qs, { revision: 1 }), submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'b2'), payload(USERS.qs, { status: 'approved', approvedSubtotal: 800, approvedGst: 100, approvedTotal: 900 })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'b3'), payload(USERS.qs, { status: 'submitted', submittedAt: serverTimestamp(), submittedBy: USERS.qs.uid })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'b4'), payload(USERS.qs, { status: 'withdrawn' })))
  })

  it('cannot rewrite a submitted variation’s lines, header, counterparty or PO by replacing the whole document', async () => {
    await seed('b5', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin) })
    const { id: _id, ...stored } = await readVar('b5')   // eslint-disable-line no-unused-vars
    const t = variationTotals([line(9000)], 'submitted')
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b5'), { ...stored, lineItems: [line(9000)], submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total, revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b5'), { ...stored, supplierName: 'Rival Co', revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b5'), { ...stored, poId: 'poClosed', poNumber: 'PO-0002', revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b5'), { ...stored, variationType: 'client', revision: 2, ...stamps(USERS.admin) }))
    expect((await readVar('b5')).submittedSubtotal).toBe(800)
  })

  it('cannot move an approved variation’s exposure to another PO, supplier, cost code set, type, project or value', async () => {
    await seed('b6', 'approved', USERS.admin, {}, { base: poLinked(USERS.admin) })
    const { id: _id, ...stored } = await readVar('b6')   // eslint-disable-line no-unused-vars
    for (const forged of [{ poId: 'poClosed' }, { poNumber: 'PO-0002' }, { poId: null, poNumber: null }, { supplierId: 'contactS9' }, { supplierName: 'Rival Co' }, { variationType: 'client', variationNumber: 'CV-0001' }, { approvedSubtotal: 5000, approvedGst: 500, approvedTotal: 5500 }, { lineItems: buildApprovedLineItems(LINES, [9000, 0]) }, { approvedBy: USERS.pm.uid }, { approvedDate: '2020-01-01' }]) {
      await assertFails(setDoc(varRef(ctx(USERS.admin), 'b6'), { ...stored, ...forged, revision: 2, ...stamps(USERS.admin) }))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b6'), { ...forged, revision: 2, ...stamps(USERS.admin) }))
    }
    // a copy of the approved document cannot be created under another project either
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b6copy', COMPANY_A, PROJECT_B), { ...stored, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), currency: 'NZD' }))
    expect((await readVar('b6')).approvedSubtotal).toBe(800)
  })

  it('cannot attach a foreign-project RFI or forge a snapshot on a draft, nor touch the link on anything else', async () => {
    await seed('b7', 'draft')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b7'), { ...link(RFI_IN_PROJECT_B), revision: 2, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b7'), { ...link(RFIS.open), originRfiTitle: 'Forged', revision: 2, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b7'), { ...submitWrite(USERS.admin), ...link(RFIS.open) }))   // no longer smuggled with submit (ADR-59)
    await seed('b8', 'approved', USERS.admin, link(RFIS.open))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b8'), { status: 'draft', ...link(RFIS.closed), revision: 2, ...stamps(USERS.admin) }))
  })

  it('cannot revive a rejected or withdrawn variation, re-open an approved one, or strip stamps and provenance', async () => {
    await seed('b9', 'rejected')
    const { id: _i, ...rejected } = await readVar('b9')   // eslint-disable-line no-unused-vars
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b9'), { ...rejected, status: 'approved', rejectedAt: null, rejectedBy: null, approvedAt: serverTimestamp(), approvedBy: USERS.admin.uid, approvedSubtotal: 800, approvedGst: 100, approvedTotal: 900, approvedDate: '2026-10-12', revision: 2, ...stamps(USERS.admin) }))
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b9'), { ...rejected, status: 'draft', rejectedAt: null, rejectedBy: null, revision: 2, ...stamps(USERS.admin) }))
    await seed('b10', 'withdrawn')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b10'), { status: 'draft', withdrawnAt: null, withdrawnBy: null, revision: 2, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b10'), submitWrite(USERS.admin)))
    await seed('b11', 'approved')
    const { id: _j, ...approved } = await readVar('b11')   // eslint-disable-line no-unused-vars
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'b11'), { ...approved, status: 'submitted', approvedAt: null, approvedBy: null, approvedSubtotal: null, approvedGst: null, approvedTotal: null, approvedDate: '', revision: 2, ...stamps(USERS.admin) }))
    for (const strip of [{ approvedBy: null }, { approvedAt: null }, { submittedBy: null }, { createdBy: null }, { createdAt: null }, { updatedBy: null }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'b11'), { ...strip, revision: 2, ...stamps(USERS.admin) }))
    }
  })
})

// ── Legacy documents ─────────────────────────────────────────────────────────

describe('legacy documents (foundation shape — no originRfi*, no audit stamps) stay fully writable and acquire the keys', () => {
  it('a legacy draft edits, submits and withdraws; a legacy submitted approves and rejects; each acquires updatedAt / updatedBy and revision 2', async () => {
    await seed('lg1', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'lg1'), submitWrite(USERS.qs)))
    expect(await readVar('lg1')).toMatchObject({ status: 'submitted', revision: 2, submittedBy: USERS.qs.uid, updatedBy: USERS.qs.uid })
    await seed('lg2', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'lg2'), withdrawWrite(USERS.qs)))
    await seed('lg3', 'submitted', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'lg3'), approveWrite(USERS.pm)))
    expect(await readVar('lg3')).toMatchObject({ status: 'approved', approvedSubtotal: 700, revision: 2 })
    await seed('lg4', 'submitted', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'lg4'), rejectWrite(USERS.pm)))
    await seed('lg5', 'submitted', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'lg5'), withdrawWrite(USERS.pm)))
  })

  it('a legacy approved, rejected or withdrawn document is terminal exactly as a new one is', async () => {
    for (const status of ['approved', 'rejected', 'withdrawn']) {
      await seed(`lg6-${status}`, status, USERS.admin, {}, { legacy: true })
      for (const w of [submitWrite, approveWrite, rejectWrite, withdrawWrite, draftEdit]) {
        await assertFails(updateDoc(varRef(ctx(USERS.admin), `lg6-${status}`), w(USERS.admin)))
      }
    }
  })

  it('a legacy PO-linked supplier variation whose PO has since been cancelled still edits, submits, rejects and withdraws — but since ADR-62 (Correction A) it can NOT be approved: approval is refused, with or without the commitment pair', async () => {
    await seed('lg7', 'draft', USERS.admin, {}, { legacy: true, base: poLinked(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), PO.sent.id), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'lg7'), draftEdit(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'lg7'), submitWrite(USERS.qs, { revision: 3 })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'lg7'), approveWrite(USERS.pm, { revision: 4, lines: draftEdit(USERS.qs).lineItems, amounts: [1500, -300] })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'lg7'), approveWrite(USERS.pm, { revision: 4, lines: draftEdit(USERS.qs).lineItems, amounts: [1500, -300], commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: USERS.pm.uid })))
    expect(await readStatus('lg7')).toBe('submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'lg7'), rejectWrite(USERS.pm, { revision: 4 })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'lg8'), poLinked(USERS.qs, PO.sent)))   // and no NEW variation against the cancelled PO
  })
})

// ── Dependent figures ────────────────────────────────────────────────────────

describe('downstream figures are unchanged — approval is still the only counting point, signed, never clamped', () => {
  it('a supplier variation raised, submitted and approved through the new rules feeds Commitment Exposure exactly once, by cost code, signed; pending is exposure only', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'f1'), poLinked(USERS.qs)))
    let v = await readVar('f1')
    expect(approvedSupplierVariationsByCostCode([v])).toEqual({})
    expect(pendingSupplierVariationExposureByCostCode([v])).toEqual({ cc1: 1000, cc2: -200 })
    expect(pendingSupplierVariationExposureTotal([v])).toBe(800)
    expect(openVariationCount([v])).toBe(1)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'f1'), submitWrite(USERS.qs)))
    // ADR-62: the PO-linked approve carries the commitment pair (the PO is sent). The GROSS approved
    // figure below is unchanged by it; the lines carry no poLineIndex, so nothing matures (new scope).
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f1'), approveWrite(USERS.pm, { revision: 3, amounts: [900, -500], commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: USERS.pm.uid })))
    v = await readVar('f1')
    expect(approvedSupplierVariationsByCostCode([v])).toEqual({ cc1: 900, cc2: -500 })
    expect(approvedSupplierVariationsTotal([v])).toBe(400)
    expect(pendingSupplierVariationExposureTotal([v])).toBe(0)
    expect(openVariationCount([v])).toBe(0)
    // the added keys change no figure
    const { updatedAt: _u, updatedBy: _b, ...legacyShape } = v   // eslint-disable-line no-unused-vars
    expect(approvedSupplierVariationsByCostCode([legacyShape])).toEqual(approvedSupplierVariationsByCostCode([v]))
  })

  it('a client variation approved through the new rules raises the Current Contract Sum (signed); a negative one lowers it; pending client exposure is separate', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'f2'), clientPayload(USERS.pm)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f2'), submitWrite(USERS.pm)))
    const baseline = { originalContractValue: 100000 }
    let v = await readVar('f2')
    expect(pendingClientVariationExposureTotal([v])).toBe(800)
    expect(computeMargin({ baseline, variations: [v], forecastFinalCost: 80000 }).currentContractSum).toBe(100000)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f2'), approveWrite(USERS.pm, { revision: 3, amounts: [1000, -200], assessmentNotes: '' })))
    v = await readVar('f2')
    expect(approvedClientVariationsTotal([v])).toBe(800)
    expect(computeMargin({ baseline, variations: [v], forecastFinalCost: 80000 }).currentContractSum).toBe(100800)
    await assertSucceeds(setDoc(varRef(ctx(USERS.pm), 'f3'), clientPayload(USERS.pm, { variationNumber: 'CV-0002', lines: [line(-3000)] })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f3'), submitWrite(USERS.pm)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f3'), approveWrite(USERS.pm, { revision: 3, lines: [line(-3000)], amounts: [-3000], assessmentNotes: '' })))
    const credit = await readVar('f3')
    expect(approvedClientVariationsTotal([v, credit])).toBe(-2200)
    expect(computeMargin({ baseline, variations: [v, credit], forecastFinalCost: 80000 }).currentContractSum).toBe(97800)
  })

  it('a rejected or withdrawn variation contributes nothing; the M2-B1 PO cancel guard reads the same status and poId', async () => {
    await seed('f4', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin) })
    await seed('f5', 'draft', USERS.admin, {}, { base: poLinked(USERS.admin, PO.sent, { variationNumber: 'SV-0002' }) })
    let rows = [await readVar('f4'), await readVar('f5')]
    expect(poCancellationBlockers(PO.sent.id, { variations: rows }).map(b => b.number)).toEqual(['SV-0001', 'SV-0002'])
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f4'), rejectWrite(USERS.pm)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f5'), withdrawWrite(USERS.pm)))
    rows = [await readVar('f4'), await readVar('f5')]
    expect(poCancellationBlockers(PO.sent.id, { variations: rows })).toEqual([])
    expect(approvedSupplierVariationsTotal(rows)).toBe(0)
    expect(pendingSupplierVariationExposureTotal(rows)).toBe(0)
    expect(openVariationCount(rows)).toBe(0)
  })

  it('the originating-RFI reverse view derives from the stored link and nothing on the RFI', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'f6'), payload(USERS.qs, link(RFIS.open))))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'f6'), submitWrite(USERS.qs)))
    const v = await readVar('f6')
    expect(variationsForRfi([v], RFIS.open.id).map(x => x.id)).toEqual(['f6'])
    expect(variationsForRfi([v], RFIS.answered.id)).toEqual([])
  })
})

// ── The REAL guarded transactions (lib/variationActions.js) ──────────────────

describe('runUpdateVariationDraft / runTransitionVariation — the app’s own transactions against the real rules', () => {
  const qs = { db: null, uid: USERS.qs.uid }
  const pm = { db: null, uid: USERS.pm.uid }
  beforeEach(() => { qs.db = ctx(USERS.qs); pm.db = ctx(USERS.pm) })

  const edit = {
    title: ' Additional steel (revised) ', description: 'More', reason: 'site_condition', clientRef: null, supplierRef: ' Q-9 ',
    identifiedDate: '2026-10-01', responseDueDate: '2026-10-30', effectiveDate: '',
    lineItems: [line(1500, { description: 'x' }), line(-300, { costCodeId: 'cc2', taxCode: TAX_CODE.INPUT_TAXED })],
  }
  const run = (who, fn, args) => fn({ db: who.db, variationRef: varRef(who.db, args.id), uid: who.uid, runTransaction, serverTimestamp, ...args })

  it('a draft edit from the reviewed copy writes the content, the signed header, revision 2 and the stamps', async () => {
    await seed('x1', 'draft')
    const seen = await readVar('x1')
    await run(qs, runUpdateVariationDraft, { id: 'x1', seen, data: edit })
    const after = await readVar('x1')
    expect(after).toMatchObject({ title: 'Additional steel (revised)', supplierRef: 'Q-9', clientRef: null, submittedSubtotal: 1200, submittedGst: 150, submittedTotal: 1350, revision: 2, updatedBy: USERS.qs.uid, notes: '' })
    expect(after.lineItems.map(l => l.approvedAmount)).toEqual([null, null])
  })

  it('a STALE copy (edited underneath — revision moved) is refused with nothing written; the fresh copy then saves', async () => {
    await seed('x2', 'draft')
    const seen = await readVar('x2')
    await run(pm, runUpdateVariationDraft, { id: 'x2', seen, data: { ...edit, lineItems: [line(1200)] } })
    const err = await expectKind(run(qs, runUpdateVariationDraft, { id: 'x2', seen, data: edit }), VARIATION_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/changed by another user/)
    expect((await readVar('x2')).submittedSubtotal).toBe(1200)
    await run(qs, runUpdateVariationDraft, { id: 'x2', seen: await readVar('x2'), data: edit })
    expect((await readVar('x2')).revision).toBe(3)
  })

  it('a STALE copy (submitted underneath — status moved) is refused for an edit and names the new status', async () => {
    await seed('x3', 'draft')
    const seen = await readVar('x3')
    await run(qs, runTransitionVariation, { id: 'x3', seen, nextStatus: VARIATION_STATUS.SUBMITTED })
    const err = await expectKind(run(pm, runUpdateVariationDraft, { id: 'x3', seen, data: edit }), VARIATION_WRITE_ERROR.STALE)
    expect(err.message).toMatch(/now Submitted, not Draft/)
  })

  it('an invalid edit (no title, no lines, a line without a cost code, an ineligible RFI) is refused before any read', async () => {
    await seed('x4', 'draft')
    const seen = await readVar('x4')
    for (const data of [{ ...edit, title: '' }, { ...edit, lineItems: [] }, { ...edit, lineItems: [line(1, { costCodeId: '' })] }, { ...edit, originRfi: { ...RFIS.draft } }]) {
      await expectKind(run(qs, runUpdateVariationDraft, { id: 'x4', seen, data }), VARIATION_WRITE_ERROR.INVALID)
    }
    expect((await readVar('x4')).revision).toBe(1)
  })

  it('the draft edit links, re-links and unlinks the originating RFI through the transaction (the ADR-34 rule verifies each change)', async () => {
    await seed('x5', 'draft')
    await run(qs, runUpdateVariationDraft, { id: 'x5', seen: await readVar('x5'), data: { ...edit, originRfi: RFIS.open } })
    expect(await readVar('x5')).toMatchObject(link(RFIS.open))
    await run(qs, runUpdateVariationDraft, { id: 'x5', seen: await readVar('x5'), data: { ...edit } })   // undefined → preserved
    expect(await readVar('x5')).toMatchObject(link(RFIS.open))
    await run(qs, runUpdateVariationDraft, { id: 'x5', seen: await readVar('x5'), data: { ...edit, originRfi: null } })
    expect(await readVar('x5')).toMatchObject(UNLINKED)
    expect((await readVar('x5')).revision).toBe(4)
  })

  it('submit, approve (certified amounts normalised to cents, notes required when differing) and reject / withdraw from the reviewed copies, each +1', async () => {
    await seed('x6', 'draft')
    await run(qs, runTransitionVariation, { id: 'x6', seen: await readVar('x6'), nextStatus: VARIATION_STATUS.SUBMITTED, today: '2026-10-27' })
    let live = await readVar('x6')
    expect(live).toMatchObject({ status: 'submitted', submittedBy: USERS.qs.uid, submittedDate: '2026-10-27', revision: 2 })
    await run(pm, runTransitionVariation, { id: 'x6', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: ['899.999', -200], assessmentNotes: ' Negotiated ' }, today: '2026-10-27' })
    live = await readVar('x6')
    expect(live).toMatchObject({ status: 'approved', approvedBy: USERS.pm.uid, revision: 3, approvedSubtotal: 700, approvedGst: 90, approvedTotal: 790, assessmentNotes: 'Negotiated', approvedDate: '2026-10-27', effectiveDate: '2026-10-27' })
    expect(live.lineItems[0].approvedAmount).toBe(900)
    await seed('x7', 'submitted')
    await run(pm, runTransitionVariation, { id: 'x7', seen: await readVar('x7'), nextStatus: VARIATION_STATUS.REJECTED, extras: { assessmentNotes: 'Not agreed' } })
    expect(await readVar('x7')).toMatchObject({ status: 'rejected', rejectedBy: USERS.pm.uid, revision: 2, assessmentNotes: 'Not agreed' })
    await seed('x8', 'submitted')
    await run(qs, runTransitionVariation, { id: 'x8', seen: await readVar('x8'), nextStatus: VARIATION_STATUS.WITHDRAWN })
    expect(await readVar('x8')).toMatchObject({ status: 'withdrawn', withdrawnBy: USERS.qs.uid, revision: 2 })
  })

  it('a STALE assessment (approved underneath) is refused with nothing written — the second assessor never overwrites the first', async () => {
    await seed('x9', 'submitted')
    const seen = await readVar('x9')
    await run(pm, runTransitionVariation, { id: 'x9', seen, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [1000, -200] } })
    await expectKind(run(qs, runTransitionVariation, { id: 'x9', seen, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [500, -200], assessmentNotes: 'less' } }), VARIATION_WRITE_ERROR.STALE)
    await expectKind(run(qs, runTransitionVariation, { id: 'x9', seen, nextStatus: VARIATION_STATUS.REJECTED }), VARIATION_WRITE_ERROR.STALE)
    await expectKind(run(qs, runTransitionVariation, { id: 'x9', seen, nextStatus: VARIATION_STATUS.WITHDRAWN }), VARIATION_WRITE_ERROR.STALE)
    expect((await readVar('x9')).approvedSubtotal).toBe(800)
  })

  it('an illegal move, a reserved target, differing amounts without notes, a count mismatch and a missing document are refused before any write', async () => {
    await seed('x10', 'submitted')
    const seen = await readVar('x10')
    await expectKind(run(pm, runTransitionVariation, { id: 'x10', seen, nextStatus: VARIATION_STATUS.DRAFT }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionVariation, { id: 'x10', seen, nextStatus: VARIATION_STATUS.UNDER_REVIEW }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionVariation, { id: 'x10', seen, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [900, -200], assessmentNotes: '' } }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionVariation, { id: 'x10', seen, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [900] } }), VARIATION_WRITE_ERROR.INVALID)
    await seed('x11', 'approved')
    await expectKind(run(pm, runTransitionVariation, { id: 'x11', seen: await readVar('x11'), nextStatus: VARIATION_STATUS.WITHDRAWN }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionVariation, { id: 'gone', seen: { ...seen, id: 'gone' }, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [1000, -200] } }), VARIATION_WRITE_ERROR.MISSING)
    expect((await readVar('x10')).revision).toBe(1)
  })

  it('a denied role is refused by the RULES as PERMISSION with nothing written', async () => {
    await seed('x12', 'draft')
    const sub = { db: ctx(USERS.sub), uid: USERS.sub.uid }
    const seen = await readVar('x12')
    await expectKind(run(sub, runTransitionVariation, { id: 'x12', seen, nextStatus: VARIATION_STATUS.SUBMITTED }), VARIATION_WRITE_ERROR.PERMISSION)
    await expectKind(run(sub, runUpdateVariationDraft, { id: 'x12', seen, data: edit }), VARIATION_WRITE_ERROR.PERMISSION)
    expect(await readStatus('x12')).toBe('draft')
  })

  it('a legacy draft (no stamps, no link keys) edits and submits through the transactions, acquiring the keys', async () => {
    await seed('x13', 'draft', USERS.admin, {}, { legacy: true })
    const seen = await readVar('x13')
    await run(qs, runUpdateVariationDraft, { id: 'x13', seen, data: edit })
    await run(qs, runTransitionVariation, { id: 'x13', seen: await readVar('x13'), nextStatus: VARIATION_STATUS.SUBMITTED })
    expect(await readVar('x13')).toMatchObject({ status: 'submitted', revision: 3, submittedBy: USERS.qs.uid, updatedBy: USERS.qs.uid })
  })
})

// ── NOT enforced — the honest ceiling ────────────────────────────────────────

describe('NOT ENFORCED by rules — proven, so the ceiling is documented (DC37)', () => {
  it('lineItems CONTENTS are unverified — junk elements, a bogus cost code, a wrong tax code and an approved amount on a DRAFT line are ACCEPTED', async () => {
    const junk = [{ foo: 'bar' }, { costCodeId: 'ccX', submittedAmount: 'lots', taxCode: 'vat', approvedAmount: 99999, approvedGst: 9999 }]
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'n1'), payload(USERS.qs, { lines: junk, submittedSubtotal: 800, submittedGst: 100, submittedTotal: 900 })))
  })

  it('the header GST is NOT pinned to the lines or the subtotal — a header unrelated to its lines is ACCEPTED when subtotal + gst == total', async () => {
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'n2'), payload(USERS.qs, { submittedSubtotal: 800, submittedGst: 800, submittedTotal: 1600 })))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'n3'), payload(USERS.qs, { submittedSubtotal: 12345, submittedGst: -5, submittedTotal: 12340 })))
    await seed('n4', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'n4'), approveWrite(USERS.pm, { approvedSubtotal: 700, approvedGst: 700, approvedTotal: 1400 })))
  })

  it('"assessment notes required when approved differs from submitted" is the client’s — an approval that differs with EMPTY notes is ACCEPTED', async () => {
    await seed('n5', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'n5'), approveWrite(USERS.pm, { amounts: [1, -1], assessmentNotes: '' })))
  })

  it('creator == approver is ACCEPTED (self-approval permitted by decision); duplicate numbers and duplicate counterparty references are ACCEPTED (DC6 / DC9)', async () => {
    await seed('n6', 'submitted', USERS.qs)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'n6'), approveWrite(USERS.qs)))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'n7'), payload(USERS.qs, { supplierRef: 'Q-1' })))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'n8'), payload(USERS.qs, { supplierRef: 'Q-1' })))
  })

  it('a direct-SDK caller who reads first and writes stored + 1 passes the revision rule — the stale guard is rules-ASSISTED, not rules-proven', async () => {
    await seed('n9', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'n9'), draftEdit(USERS.qs)))   // revision 2
    const live = await readVar('n9')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'n9'), draftEdit(USERS.pm, { lines: [line(1200)], revision: live.revision + 1 })))
    expect((await readVar('n9')).submittedSubtotal).toBe(1200)
  })

  it('the PO link is read at CREATE only — the supplier of a stored PO-linked variation is never re-compared to the PO afterwards, and a supplier variation’s cost codes are not checked against the PO’s lines', async () => {
    await seed('n10', 'draft', USERS.admin, {}, { base: poLinked(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), PO.sent.id), { supplierName: 'Renamed Co' })
    })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'n10'), submitWrite(USERS.qs)))
    await assertSucceeds(setDoc(varRef(ctx(USERS.qs), 'n11'), poLinked(USERS.qs, { ...PO.sent, supplierName: 'Renamed Co' }, { lines: [line(10, { costCodeId: 'ccNotOnPo', poLineIndex: 7 })] })))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// M3-B1 (ADR-62) — commitment application: the stamp pair on approve, the
// one-time legacy Apply branch (f), and what rules enforce around them.
// ═════════════════════════════════════════════════════════════════════════════

// A supplier variation whose ONE line extends the seeded PO's line 0 (cc1).
const PO_LINES = [line(900, { poLineIndex: 0 })]
const linkedBase = (user, po = PO.sent) => poLinked(user, po, { lineItems: PO_LINES })
const applied = (user) => ({ commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: user.uid })
const approveApplied = (user, extra = {}) => approveWrite(user, { amounts: [900], lines: PO_LINES, assessmentNotes: '', ...applied(user), ...extra })
const approvePlain   = (user, extra = {}) => approveWrite(user, { amounts: [900], lines: PO_LINES, assessmentNotes: '', ...extra })
const applyWrite     = (user, extra = {}) => ({ ...applied(user), revision: 2, ...stamps(user), ...extra })

async function setPoStatus(po, status) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), posPath(), po.id), { status })
  })
}
async function readPo(po) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), posPath(), po.id))
    data = { id: snap.id, ...snap.data() }
  })
  return data
}
const poRefFor = (db, po = PO.sent) => doc(db, posPath(), po.id)

describe('ADR-62 — approve WITH the commitment stamps (approval is the trigger)', () => {
  it('every financial role approves a PO-linked supplier variation against a SENT PO with the stamps; the variation then adjusts that PO line', async () => {
    for (const user of FINANCIAL) {
      await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await assertSucceeds(updateDoc(varRef(ctx(user), 'v1'), approveApplied(user)))
      const v = await readVar('v1')
      expect(v.status).toBe('approved')
      expect(v.commitmentAppliedBy).toBe(user.uid)
      expect(v.commitmentAppliedAt).toBeTruthy()
      expect(isCommitmentApplied(v)).toBe(true)
      const po = await readPo(PO.sent)
      const adj = appliedSupplierVariationAdjustments([v], [po])
      expect(adj.byPoLine).toEqual({ [PO.sent.id]: { 0: 900 } })
      expect(remainingCommittedByCostCode([po], {}, {}, adj.byPoLine)).toEqual({ cc1: 3400 })   // 2500 + 900
      expect(unappliedSupplierVariationsByCostCode([v], [po])).toEqual({})
      await testEnv.clearFirestore()
      await testEnv.withSecurityRulesDisabled(async (c) => {
        const db = c.firestore()
        for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
        await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'NZ', baseCurrency: 'NZD' })
        await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD', currencyLocked: true })
      })
      for (const po of Object.values(PO)) await seedPo(po)
    }
  })

  it('a CLOSED PO applies too', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin, PO.closed) })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'v1'), approveApplied(USERS.qs)))
    expect(isCommitmentApplied(await readVar('v1'))).toBe(true)
  })

  it('FINAL RULES — the pre-M3-B1 approve payload (no stamps; an old-bundle tab) is DENIED on a PO-linked supplier variation for every role, with nothing written; the same payload on a manual-mode variation still passes', async () => {
    for (const user of FINANCIAL) {
      await seed(`v_${user.uid}`, 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await assertFails(updateDoc(varRef(ctx(user), `v_${user.uid}`), approvePlain(user)))
      const v = await readVar(`v_${user.uid}`)
      expect(v.status).toBe('submitted')
      expect(v.revision).toBe(1)
      // The old tab can still withdraw or reject; the new bundle approves with the pair.
      await assertSucceeds(updateDoc(varRef(ctx(user), `v_${user.uid}`), approveApplied(user)))
    }
    await seed('manual', 'submitted')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'manual'), approveWrite(USERS.qs)))
    expect(isCommitmentApplied(await readVar('manual'))).toBe(false)
  })

  it('Correction A — a cancelled, draft or pending PO REFUSES the approval outright (with AND without the pair); the variation stays submitted and can still be withdrawn or rejected', async () => {
    for (const status of ['cancelled', 'draft', 'pending_approval']) {
      await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await setPoStatus(PO.sent, status)
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveApplied(USERS.admin)))
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), approvePlain(USERS.admin)))
      const v = await readVar('v1')
      expect(v.status).toBe('submitted')
      expect(v.revision).toBe(1)
      await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), withdrawWrite(USERS.admin)))
      await setPoStatus(PO.sent, 'sent')
    }
  })

  it('Correction A — a MISSING PO and a PO from ANOTHER PROJECT refuse the approval (the PO path is this project\u2019s; wrong tenant / project never resolves)', async () => {
    await seed('gone', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, { ...PO.sent, id: 'poGone', poNumber: 'PO-0099' }, { lineItems: PO_LINES }) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'gone'), approveApplied(USERS.admin)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'gone'), approvePlain(USERS.admin)))
    await seed('otherProj', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, PO_IN_PROJECT_B, { lineItems: PO_LINES }) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'otherProj'), approveApplied(USERS.admin)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'otherProj'), approvePlain(USERS.admin)))
    expect(await readStatus('gone')).toBe('submitted')
    expect(await readStatus('otherProj')).toBe('submitted')
    // Legacy APPROVED unstamped documents stay readable and applicable when their PO is valid.
    await seed('legacyOk', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin), legacy: true })
    expect((await readVar('legacyOk')).status).toBe('approved')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'legacyOk'), applyWrite(USERS.qs)))
  })

  it('the stamps are REFUSED on a manual-mode supplier variation and on a client variation', async () => {
    await seed('manual', 'submitted')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approveWrite(USERS.admin, { ...applied(USERS.admin) })))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'manual'), approveWrite(USERS.admin)))
    await seed('client', 'submitted', USERS.admin, {}, { base: clientPayload(USERS.admin) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), approveWrite(USERS.admin, { ...applied(USERS.admin) })))
  })

  it('forged stamps are refused — another actor, a client clock, or only one half of the pair', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { commitmentAppliedBy: USERS.pm.uid })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { commitmentAppliedBy: null })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { commitmentAppliedAt: clock() })))
    }
    const onlyAt = approvePlain(USERS.admin, { commitmentAppliedAt: serverTimestamp() })
    const onlyBy = approvePlain(USERS.admin, { commitmentAppliedBy: USERS.admin.uid })
    await assertFails(updateDoc(varRef(db, 'v1'), onlyAt))
    await assertFails(updateDoc(varRef(db, 'v1'), onlyBy))
    expect(await readStatus('v1')).toBe('submitted')
  })

  it('the stamps cannot be born at CREATE — present, or present as null', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(varRef(db, 'c1'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES, ...applied(USERS.admin) })))
    await assertFails(setDoc(varRef(db, 'c2'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES, commitmentAppliedAt: null, commitmentAppliedBy: null })))
    // The same payload WITHOUT the pair is the ordinary create — accepted.
    await assertSucceeds(setDoc(varRef(db, 'c3'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES })))
    expect(await readVar('c1')).toBeUndefined()
    expect(await readVar('c2')).toBeUndefined()
  })

  it('the stamps cannot ride on a draft edit or a submit', async () => {
    const db = ctx(USERS.admin)
    await seed('d', 'draft', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertFails(updateDoc(varRef(db, 'd'), draftEdit(USERS.admin, { lines: PO_LINES, ...applied(USERS.admin) })))
    await assertFails(updateDoc(varRef(db, 'd'), submitWrite(USERS.admin, applied(USERS.admin))))
    expect(await readStatus('d')).toBe('draft')
    expect(isCommitmentApplied(await readVar('d'))).toBe(false)
  })

  it('the stamps cannot ride on a reject or a withdraw', async () => {
    const db = ctx(USERS.admin)
    await seed('s', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertFails(updateDoc(varRef(db, 's'), rejectWrite(USERS.admin, applied(USERS.admin))))
    await assertFails(updateDoc(varRef(db, 's'), withdrawWrite(USERS.admin, applied(USERS.admin))))
    expect(await readStatus('s')).toBe('submitted')
  })
})

describe('ADR-62 — the one-time legacy Apply (branch f)', () => {
  it('every financial role applies an approved, unstamped PO-linked variation once: stamps + revision + audit, nothing else moves', async () => {
    for (const user of FINANCIAL) {
      await seed(`a_${user.uid}`, 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      const before = await readVar(`a_${user.uid}`)
      await assertSucceeds(updateDoc(varRef(ctx(user), `a_${user.uid}`), applyWrite(user)))
      const after = await readVar(`a_${user.uid}`)
      expect(after.commitmentAppliedBy).toBe(user.uid)
      expect(after.revision).toBe(2)
      expect(after.updatedBy).toBe(user.uid)
      // Approved money, lines, PO link and every lifecycle stamp are untouched.
      for (const k of ['status', 'lineItems', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'approvedBy', 'poId', 'poNumber', 'supplierId', 'assessmentNotes', 'approvedDate']) {
        expect(after[k], k).toEqual(before[k])
      }
    }
  })

  it('a REPEAT is refused by the RULES — with the next revision, the same revision, or any revision — and the first stamps stand', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), applyWrite(USERS.admin)))
    const first = await readVar('v1')
    for (const revision of [3, 2, 1, 4]) {
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'v1'), applyWrite(USERS.pm, { revision })))
    }
    const after = await readVar('v1')
    expect(after.commitmentAppliedBy).toBe(USERS.admin.uid)
    expect(after.revision).toBe(2)
    expect(after.commitmentAppliedAt.isEqual(first.commitmentAppliedAt)).toBe(true)
  })

  it('a document seeded with the stamps already set (approved through the new branch c) cannot be re-applied', async () => {
    await seed('v1', 'approved', USERS.admin, { commitmentAppliedAt: Timestamp.now(), commitmentAppliedBy: USERS.qs.uid }, { base: linkedBase(USERS.admin) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), applyWrite(USERS.admin)))
  })

  it('only an APPROVED document can be applied — draft, submitted, under_review, rejected and withdrawn are refused', async () => {
    for (const status of ['draft', 'submitted', 'under_review', 'rejected', 'withdrawn']) {
      await seed(`s_${status}`, status, USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await assertFails(updateDoc(varRef(ctx(USERS.admin), `s_${status}`), applyWrite(USERS.admin)))
      expect(await readStatus(`s_${status}`)).toBe(status)
    }
  })

  it('a manual-mode supplier variation and a client variation can never be applied', async () => {
    await seed('manual', 'approved')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), applyWrite(USERS.admin)))
    await seed('client', 'approved', USERS.admin, {}, { base: clientPayload(USERS.admin) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), applyWrite(USERS.admin)))
  })

  it('the PO must be sent or closed on the server: cancelled / draft refuse; closed passes', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    for (const status of ['cancelled', 'draft', 'pending_approval']) {
      await setPoStatus(PO.sent, status)
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), applyWrite(USERS.admin)))
    }
    await setPoStatus(PO.sent, 'sent')
    await seed('v2', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin, PO.closed) })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v2'), applyWrite(USERS.admin)))
  })

  it('the apply may touch NOTHING but the pair, the revision and the audit stamps — bundled money, line, link or status changes fail the whole write', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { approvedSubtotal: 1 })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { lineItems: [line(1, { poLineIndex: 0 })] })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { poId: PO.closed.id, poNumber: PO.closed.poNumber })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { status: 'superseded' })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { assessmentNotes: 'x' })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { approvedBy: USERS.pm.uid })))
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
  })

  it('actor == caller, time == request.time, revision exactly +1 and the audit stamps are all required', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { commitmentAppliedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { commitmentAppliedAt: clock() })))
      await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { updatedAt: clock() })))
    }
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { revision: 1 })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { revision: 3 })))
    await assertFails(updateDoc(varRef(db, 'v1'), applyWrite(USERS.admin, { updatedBy: USERS.pm.uid })))
    const noRevision = applyWrite(USERS.admin)
    delete noRevision.revision
    await assertFails(updateDoc(varRef(db, 'v1'), noRevision))
    const noAudit = applyWrite(USERS.admin)
    delete noAudit.updatedAt
    delete noAudit.updatedBy
    await assertFails(updateDoc(varRef(db, 'v1'), noAudit))
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
  })

  it('non-financial roles, another tenant, an orphan uid and an anonymous caller are all refused', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    for (const user of [...NON_MEMBERS, USERS.other]) {
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), applyWrite(user)))
    }
    await assertFails(updateDoc(varRef(testEnv.authenticatedContext(ORPHAN_UID).firestore(), 'v1'), applyWrite({ uid: ORPHAN_UID })))
    await assertFails(updateDoc(varRef(anon(), 'v1'), { ...applyWrite(USERS.admin), commitmentAppliedBy: 'nobody', updatedBy: 'nobody' }))
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
  })

  it('a LEGACY approved document (no audit stamps, no link keys) applies and acquires them', async () => {
    await seed('legacy', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin), legacy: true })
    const before = await readVar('legacy')
    expect(before).not.toHaveProperty('updatedAt')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'legacy'), applyWrite(USERS.qs)))
    const after = await readVar('legacy')
    expect(after.commitmentAppliedBy).toBe(USERS.qs.uid)
    expect(after.updatedBy).toBe(USERS.qs.uid)
    expect(after.revision).toBe(2)
  })
})

describe('ADR-62 — the app’s transactions against the real rules', () => {
  const sdk = { runTransaction, serverTimestamp }

  it('runTransitionVariation approves AND applies in one write when the PO is sent on the server', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.qs)
    const out = await runTransitionVariation({
      db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen: await readVar('v1'), nextStatus: VARIATION_STATUS.APPROVED,
      extras: { approvedAmounts: [900], assessmentNotes: '' }, uid: USERS.qs.uid, ...sdk,
    })
    expect(out.commitmentApplied).toBe(true)
    const v = await readVar('v1')
    expect(v.status).toBe('approved')
    expect(v.commitmentAppliedBy).toBe(USERS.qs.uid)
    expect(v.revision).toBe(2)
  })

  it('runTransitionVariation REFUSES the approval (PO_INVALID, nothing written, actionable message) when the server PO is cancelled or missing — Correction A', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await setPoStatus(PO.sent, 'cancelled')
    const db = ctx(USERS.qs)
    const err = await expectKind(runTransitionVariation({
      db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen: await readVar('v1'), nextStatus: VARIATION_STATUS.APPROVED,
      extras: { approvedAmounts: [900], assessmentNotes: '' }, uid: USERS.qs.uid, ...sdk,
    }), VARIATION_WRITE_ERROR.PO_INVALID)
    expect(err.message).toMatch(/PO-0001 is Cancelled; a supplier variation can only be approved while its purchase order is sent or closed/)
    const v = await readVar('v1')
    expect(v.status).toBe('submitted')
    expect(v.revision).toBe(1)
    await setPoStatus(PO.sent, 'sent')
    await seed('gone', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, { ...PO.sent, id: 'poGone', poNumber: 'PO-0099' }, { lineItems: PO_LINES }) })
    const missing = await expectKind(runTransitionVariation({
      db, variationRef: varRef(db, 'gone'), poRef: doc(db, posPath(), 'poGone'), seen: await readVar('gone'), nextStatus: VARIATION_STATUS.APPROVED,
      extras: { approvedAmounts: [900], assessmentNotes: '' }, uid: USERS.qs.uid, ...sdk,
    }), VARIATION_WRITE_ERROR.PO_INVALID)
    expect(missing.message).toMatch(/could not be found in this project/)
    expect(await readStatus('gone')).toBe('submitted')
  })

  it('runApplyVariationCommitment applies once; a second attempt from the same reviewed copy is ALREADY_APPLIED with nothing written', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.pm)
    const seen = await readVar('v1')
    await runApplyVariationCommitment({ db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen, uid: USERS.pm.uid, ...sdk })
    const once = await readVar('v1')
    expect(once.commitmentAppliedBy).toBe(USERS.pm.uid)
    await expectKind(runApplyVariationCommitment({ db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen, uid: USERS.pm.uid, ...sdk }), VARIATION_WRITE_ERROR.ALREADY_APPLIED)
    const twice = await readVar('v1')
    expect(twice.revision).toBe(2)
    expect(twice.commitmentAppliedAt.isEqual(once.commitmentAppliedAt)).toBe(true)
  })

  it('TWO CONCURRENT applies by two users: exactly one lands; the loser is refused (already applied / stale / permission) and the winner’s stamps stand', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const seen = await readVar('v1')
    const attempt = (user) => {
      const db = ctx(user)
      return runApplyVariationCommitment({ db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen, uid: user.uid, ...sdk })
    }
    const results = await Promise.allSettled([attempt(USERS.admin), attempt(USERS.pm)])
    const ok = results.filter(r => r.status === 'fulfilled')
    const failed = results.filter(r => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0].reason).toBeInstanceOf(VariationWriteError)
    expect([VARIATION_WRITE_ERROR.ALREADY_APPLIED, VARIATION_WRITE_ERROR.STALE, VARIATION_WRITE_ERROR.PERMISSION]).toContain(failed[0].reason.kind)
    const v = await readVar('v1')
    expect(v.revision).toBe(2)
    expect([USERS.admin.uid, USERS.pm.uid]).toContain(v.commitmentAppliedBy)
  })

  it('a STALE reviewed copy (revision moved underneath) is refused with nothing written; the fresh copy then applies', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const stale = await readVar('v1')
    await testEnv.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), varsPath(), 'v1'), { revision: 2 }) })
    const db = ctx(USERS.admin)
    await expectKind(runApplyVariationCommitment({ db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen: stale, uid: USERS.admin.uid, ...sdk }), VARIATION_WRITE_ERROR.STALE)
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
    await runApplyVariationCommitment({ db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen: await readVar('v1'), uid: USERS.admin.uid, ...sdk })
    expect((await readVar('v1')).revision).toBe(3)
  })

  it('a cancelled PO on the server refuses the apply as INVALID; a denied role is refused by the RULES as PERMISSION', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await setPoStatus(PO.sent, 'cancelled')
    const db = ctx(USERS.admin)
    const err = await expectKind(runApplyVariationCommitment({ db, variationRef: varRef(db, 'v1'), poRef: poRefFor(db), seen: await readVar('v1'), uid: USERS.admin.uid, ...sdk }), VARIATION_WRITE_ERROR.INVALID)
    expect(err.message).toMatch(/not sent or closed/)
    await setPoStatus(PO.sent, 'sent')
    const subDb = ctx(USERS.sub)
    await expectKind(runApplyVariationCommitment({ db: subDb, variationRef: varRef(subDb, 'v1'), poRef: poRefFor(subDb), seen: await readVar('v1'), uid: USERS.sub.uid, ...sdk }), VARIATION_WRITE_ERROR.PERMISSION)
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
  })
})

describe('ADR-62 — NOT enforced by rules (documented ceiling)', () => {
  it('the stamps say nothing about the LINES: an applied variation whose poLineIndex is out of range or whose cost code mismatches is ACCEPTED by rules — the client classifies it as an exception', async () => {
    const badLines = [line(900, { poLineIndex: 7 }), line(100, { poLineIndex: 0, costCodeId: 'cc9', costCodeName: 'Wrong' })]
    await seed('v1', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, PO.sent, { lineItems: badLines }) })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), approveWrite(USERS.admin, { amounts: [900, 100], lines: badLines, assessmentNotes: '', ...applied(USERS.admin) })))
    const v = await readVar('v1')
    const adj = appliedSupplierVariationAdjustments([v], [await readPo(PO.sent)])
    expect(adj.byPoLine).toEqual({})
    expect(adj.exceptions.map(e => e.issue).sort()).toEqual(['cost_code_mismatch', 'line_out_of_range'])
    expect(unappliedSupplierVariationsByCostCode([v], [await readPo(PO.sent)])).toEqual({ cc1: 900, cc9: 100 })
  })

  it('the PO is read at apply time only — cancelling it afterwards leaves the stamps in place (the client reports the exception)', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'v1'), applyWrite(USERS.admin)))
    await setPoStatus(PO.sent, 'cancelled')
    const v = await readVar('v1')
    expect(isCommitmentApplied(v)).toBe(true)
    const adj = appliedSupplierVariationAdjustments([v], [await readPo(PO.sent)])
    expect(adj.byPoLine).toEqual({})
    expect(adj.exceptions[0].issue).toBe('po_not_committed')
    await setPoStatus(PO.sent, 'sent')
  })
})
