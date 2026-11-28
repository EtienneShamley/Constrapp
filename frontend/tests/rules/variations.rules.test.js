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
  doc, getDoc, deleteField, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp, Timestamp,
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
  runUpdateVariationDraft, runTransitionVariation, VariationWriteError, VARIATION_WRITE_ERROR,
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
// ⚠️ ADR-90 (Phase 2, trusted variation processing). CREATING a variation,
// APPROVING one and the one-time legacy APPLY / COMMIT NEW SCOPE are no longer
// client writes: the block has `allow create: if false`, no approve branch and
// no branch that admits a commitment stamp. Every test below whose subject was
// one of those three now proves the OBSOLETE DIRECT PATH IS REFUSED — with the
// payload the app used to write, for every financial role, and for every
// forged variant the test already refused — and names where the supported
// replacement is proven: tests/functions/variations.test.js (createVariation /
// approveVariation / applyVariationCommitment). Where a test needs a document a
// client used to create or approve, it is written with rules disabled in the
// shape the old client write produced (`serverCreate` / `serverUpdate`).
//
// ⚠️ ADR-90, checkpoint-1 correction. The DRAFT EDIT is no longer a client write
// either: the block has no draft-edit branch, so a draft admits NO client
// content write — not a line, a header figure, a title, a reference, a date,
// the notes or the ADR-34 originating-RFI link — and the two variation number
// counters are backend-only. Every test whose subject was a client draft edit
// now proves the raw write the app (or a direct-SDK caller) used to make is
// REFUSED for every financial role with the stored draft unchanged; the
// supported replacement is proven in tests/functions/variations.test.js
// (updateVariationDraft). What stays with the Rules — read, delete, and the
// three CONTENT-FREE transitions submit, reject and withdraw, each revision + 1
// — is tested exactly as before; where a scenario needs an edited draft, the
// edit is written with rules disabled (`editRefused(…, { thenStoreAs })`).
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'demo-constrap-test'
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
async function readVarAt(id, companyId, projectId) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const snap = await getDoc(doc(c.firestore(), varsPath(companyId, projectId), id))
    data = snap.exists() ? { id: snap.id, ...snap.data() } : undefined
  })
  return data
}

// ADR-90 — what the TRUSTED BACKEND stores, written with rules disabled: the
// document a client create used to produce, and the update a client approve or
// legacy apply used to make (serverTimestamp sentinels resolve as they did).
async function serverCreate(id, data, companyId = COMPANY_A, projectId = PROJECT_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), varsPath(companyId, projectId), id), data)
  })
}
async function serverUpdate(id, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), varsPath(), id), data)
  })
}
// A client create is refused for EVERY financial role, and nothing is stored.
async function createRefused(id, build, companyId = COMPANY_A, projectId = PROJECT_A) {
  for (const user of FINANCIAL) await assertFails(setDoc(varRef(ctx(user), id, companyId, projectId), build(user)))
  expect(await readVarAt(id, companyId, projectId)).toBeUndefined()
}
// A client update (approve / legacy apply) is refused for EVERY financial role,
// and the stored document does not move.
async function updateRefused(id, build) {
  const before = await readVar(id)
  for (const user of FINANCIAL) await assertFails(updateDoc(varRef(ctx(user), id), build(user)))
  expect(await readVar(id)).toEqual(before)
}

// ADR-90 — a client DRAFT EDIT is refused for EVERY financial role and the
// stored draft does not move. With `thenStoreAs`, the same write is then made
// with rules disabled — standing for what the backend's updateVariationDraft
// stores — so the rest of a scenario runs over the edited draft.
async function editRefused(id, build, { thenStoreAs = null } = {}) {
  await updateRefused(id, build)
  if (thenStoreAs) await serverUpdate(id, build(thenStoreAs))
}

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
    // ADR-98: the claim submit / variation lifecycle Rules require an ACTIVATED company.
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'NZ', baseCurrency: 'NZD', commercialCompletionEnabled: true })
    // ADR-98: the claim submit / variation lifecycle Rules require an ACTIVATED company.
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B', commercialCompletionEnabled: true })
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

describe('ADR-98 — variation submit / reject / withdraw: the Phase 2 lifecycle writes need an ACTIVATED company (Rules-enforced)', () => {
  const setActivation = (value) => testEnv.withSecurityRulesDisabled(async (c) => {
    const ref = doc(c.firestore(), 'companies', COMPANY_A)
    if (value === undefined) await updateDoc(ref, { commercialCompletionEnabled: deleteField() })
    else await updateDoc(ref, { commercialCompletionEnabled: value })
  })
  it('marker MISSING, false, or a non-boolean truthy value: submit, reject and withdraw are refused; the variation is unchanged', async () => {
    for (const value of [undefined, false, 'true', 1]) {
      await setActivation(value)
      await seed('av-d', 'draft')
      await seed('av-s', 'submitted')
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'av-d'), submitWrite(USERS.qs)))
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'av-s'), rejectWrite(USERS.pm)))
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'av-s'), withdrawWrite(USERS.pm)))
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'av-d'), withdrawWrite(USERS.pm)))
      expect(await readStatus('av-d')).toBe('draft')
      expect(await readStatus('av-s')).toBe('submitted')
    }
  })
  it('marker TRUE: submit, reject and withdraw succeed', async () => {
    await setActivation(true)
    await seed('av-1', 'draft'); await seed('av-2', 'submitted'); await seed('av-3', 'draft')
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'av-1'), submitWrite(USERS.qs)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'av-2'), rejectWrite(USERS.pm)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'av-3'), withdrawWrite(USERS.pm)))
  })
  it('DEACTIVATED during use: refused after deactivation; reads still work', async () => {
    await setActivation(true)
    await seed('av-mid', 'draft')
    const db = ctx(USERS.qs)
    await assertSucceeds(getDoc(varRef(db, 'av-mid')))
    await setActivation(false)
    await assertFails(updateDoc(varRef(db, 'av-mid'), submitWrite(USERS.qs)))
    await assertSucceeds(getDoc(varRef(db, 'av-mid')))
  })
})

describe('roles, membership and tenant isolation', () => {
  // The supported create: tests/functions/variations.test.js → createVariation.
  it('ADR-90 — a client create of a draft supplier, PO-linked or client variation is REFUSED from every client (every financial role); every financial role reads a backend-created one', async () => {
    for (const user of FINANCIAL) {
      await assertFails(setDoc(varRef(ctx(user), `s-${user.uid}`), payload(user)))
      await assertFails(setDoc(varRef(ctx(user), `p-${user.uid}`), poLinked(user)))
      await assertFails(setDoc(varRef(ctx(user), `c-${user.uid}`), clientPayload(user)))
      for (const id of [`s-${user.uid}`, `p-${user.uid}`, `c-${user.uid}`]) expect(await readVar(id)).toBeUndefined()
      await serverCreate(`s-${user.uid}`, payload(user))
      await assertSucceeds(getDoc(varRef(ctx(user), `s-${user.uid}`)))
    }
  })

  // The supported approve: tests/functions/variations.test.js → approveVariation.
  // The supported draft edit: tests/functions/variations.test.js → updateVariationDraft.
  it('every financial role can submit, reject and withdraw; ADR-90 — a draft edit and approve are REFUSED from every client', async () => {
    for (const user of FINANCIAL) {
      await seed(`ed-${user.uid}`, 'draft')
      await assertFails(updateDoc(varRef(ctx(user), `ed-${user.uid}`), draftEdit(user)))
      expect(await readVar(`ed-${user.uid}`)).toMatchObject({ status: 'draft', revision: 1, title: 'Additional steel' })
      await seed(`su-${user.uid}`, 'draft')
      await assertSucceeds(updateDoc(varRef(ctx(user), `su-${user.uid}`), submitWrite(user)))
      await seed(`ap-${user.uid}`, 'submitted')
      await assertFails(updateDoc(varRef(ctx(user), `ap-${user.uid}`), approveWrite(user)))
      expect(await readVar(`ap-${user.uid}`)).toMatchObject({ status: 'submitted', revision: 1, approvedBy: null })
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
    // ADR-90: …and the other company's own admin cannot create one directly in its own project either
    // (its backend-created variations are its own to read: tests/functions/variations.test.js).
    await assertFails(setDoc(varRef(ctx(USERS.other), 't4', COMPANY_B, PROJECT_C), payload(USERS.other)))
    await serverCreate('t4', payload(USERS.other), COMPANY_B, PROJECT_C)
    await assertSucceeds(getDoc(varRef(ctx(USERS.other), 't4', COMPANY_B, PROJECT_C)))
    await assertFails(getDoc(varRef(ctx(USERS.admin), 't4', COMPANY_B, PROJECT_C)))
  })

  it('tenant isolation of the three REMAINING client transitions — a well-formed submit, reject and withdraw from another company’s admin are refused (the same requests succeed for a member, above), and nothing moves', async () => {
    // Added after the independent review of the ADR-90 conversion: the draft-edit and apply
    // denials that used to prove the tenant gate are now refused whatever the tenancy, so the
    // gate is proven here with request shapes that ONLY the gate stops.
    await seed('tx-d', 'draft')
    await seed('tx-s', 'submitted')
    await seed('tx-s2', 'submitted')
    await assertFails(updateDoc(varRef(ctx(USERS.other), 'tx-d'), submitWrite(USERS.other)))
    await assertFails(updateDoc(varRef(ctx(USERS.other), 'tx-s'), rejectWrite(USERS.other)))
    await assertFails(updateDoc(varRef(ctx(USERS.other), 'tx-s2'), withdrawWrite(USERS.other)))
    await assertFails(updateDoc(varRef(ctx(USERS.other), 'tx-d'), withdrawWrite(USERS.other)))
    expect(await readVar('tx-d')).toMatchObject({ status: 'draft', revision: 1 })
    expect(await readVar('tx-s')).toMatchObject({ status: 'submitted', revision: 1 })
    expect(await readVar('tx-s2')).toMatchObject({ status: 'submitted', revision: 1 })
    // Control: the identical shapes from a Company A member land.
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'tx-d'), submitWrite(USERS.admin)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'tx-s'), rejectWrite(USERS.admin)))
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
//
// ADR-90: NO client may create a variation — `allow create: if false`. Every
// describe in this section used to separate the creates the Rules accepted from
// the ones they refused; ALL of them are now refused, the app's own payload
// included. What a valid create stores — number, stamps, currency, purchase-order
// and RFI snapshots, signed whole-cent money — is derived and proven by the
// trusted backend: tests/functions/variations.test.js → createVariation.

describe('create — the shapes the app used to write (ADR-90: REFUSED from every client)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
  it('ADR-90 — a manual-mode supplier variation, a PO-linked one against a SENT and a CLOSED PO, and a client variation are REFUSED from every client', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c1'), payload(USERS.qs)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c2'), poLinked(USERS.qs, PO.sent)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c3'), poLinked(USERS.qs, PO.closed, { variationNumber: 'SV-0002' })))
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'c4'), clientPayload(USERS.pm)))
    for (const id of ['c1', 'c2', 'c3', 'c4']) expect(await readVar(id)).toBeUndefined()
    await createRefused('c1', (user) => payload(user))
    await createRefused('c2', (user) => poLinked(user, PO.sent))
    await createRefused('c3', (user) => poLinked(user, PO.closed, { variationNumber: 'SV-0002' }))
    await createRefused('c4', (user) => clientPayload(user))
  })

  it('ADR-90 — a PO-linked variation against a pre-Contacts PO (no supplierId key), with supplierId null or forged, is REFUSED from every client', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c5'), poLinked(USERS.qs, PO.legacy)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c6'), poLinked(USERS.qs, PO.legacy, { supplierId: 'contactS1' })))
    await createRefused('c5', (user) => poLinked(user, PO.legacy))
  })

  it('ADR-90 — SIGNED money (an all-negative credit, a zero-value variation, mixed tax codes, 200 lines) is REFUSED from every client; nothing is stored', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c7'), payload(USERS.qs, { lines: [line(-5000), line(-0.01, { taxCode: TAX_CODE.INPUT_TAXED })] })))
    expect(await readVar('c7')).toBeUndefined()
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c8'), payload(USERS.qs, { lines: [line(0)] })))
    // mixed signs and tax codes: subtotal 0 with a positive GST is a REAL header (gst on +1000, gst_free on −1000)
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c9'), payload(USERS.qs, { lines: [line(1000), line(-1000, { taxCode: TAX_CODE.GST_FREE })] })))
    expect(await readVar('c9')).toBeUndefined()
    const many = Array.from({ length: 200 }, (_, i) => line(i % 2 ? 12.34 : -0.55))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'c10'), payload(USERS.qs, { lines: many })))
    for (const id of ['c8', 'c10']) expect(await readVar(id)).toBeUndefined()
  })

  it('ADR-90 — a create with an originating RFI (open / answered / closed), on both types, is REFUSED from every client (ADR-34 create validation is the backend’s)', async () => {
    for (const [i, r] of [RFIS.open, RFIS.answered, RFIS.closed].entries()) {
      await assertFails(setDoc(varRef(ctx(USERS.admin), `r${i}`), payload(USERS.admin, link(r))))
    }
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'rc'), clientPayload(USERS.pm, link(RFIS.answered))))
    for (const user of FINANCIAL) {
      await assertFails(setDoc(varRef(ctx(user), `r_${user.uid}`), payload(user, link(RFIS.open))))
    }
  })

  it('ADR-90 — the link never writes anything onto the RFI (a refused create, a refused client link on a draft, and the link the backend stores)', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.admin), 'rk'), payload(USERS.admin, link(RFIS.open))))
    await seed('rk', 'draft')
    await editRefused('rk', (user) => ({ ...link(RFIS.open), revision: 2, ...stamps(user) }), { thenStoreAs: USERS.admin })
    expect(await readVar('rk')).toMatchObject(link(RFIS.open))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const data = (await getDoc(doc(c.firestore(), rfisPath(), RFIS.open.id))).data()
      expect(data.variationId).toBeUndefined()
      expect(data.variationIds).toBeUndefined()
      expect(data.linkedVariations).toBeUndefined()
      expect(Object.keys(data)).toHaveLength(34)
    })
  })
})

describe('create — exact keys, born draft, stamps and reserved fields (ADR-90: every variant REFUSED, the well-formed one included)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
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

  it('ADR-90 — identity: every number / type combination is REFUSED from every client, a well-formed SV-12345 included (the number is the backend counter’s)', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'id1'), payload(USERS.qs, { variationNumber: 'CV-0001' })))            // supplier with a client number
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'id2'), clientPayload(USERS.qs, { variationNumber: 'SV-0001' })))      // client with a supplier number
    for (const n of ['SV-001', 'SV0001', 'sv-0001', 'PO-0001', '', null, 1]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'id3'), payload(USERS.qs, { variationNumber: n })))
    }
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'id4'), payload(USERS.qs, { variationNumber: 'SV-12345' })))
    await createRefused('id4', (user) => payload(user, { variationNumber: 'SV-12345' }))
    for (const variationType of ['internal', 'budget_adjustment', '', null]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'id5'), payload(USERS.qs, { variationType })))
    }
  })
})

describe('create — counterparty consistency between the two types (ADR-90: REFUSED from every client)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
  it('a client variation carries no supplier block and no PO; a supplier variation carries no client block', async () => {
    for (const f of [{ supplierId: 'contactS1' }, { supplierName: 'Steel Co' }, { supplierRef: '' }, { poId: 'poSent', poNumber: 'PO-0001' }, { poNumber: 'PO-0001' }]) {
      await assertFails(setDoc(varRef(ctx(USERS.pm), 'cc1'), clientPayload(USERS.pm, f)))
    }
    for (const f of [{ clientId: 'contactC1' }, { clientName: 'Owner Pty Ltd' }, { clientRef: 'VO-1' }, { clientRef: '' }]) {
      await assertFails(setDoc(varRef(ctx(USERS.pm), 'cc2'), payload(USERS.pm, f)))
    }
  })

  it('ADR-90 — counterparty ids, names and references: every shape is REFUSED from every client, a null client or supplier id included', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp0'), clientPayload(USERS.pm, { clientId: null })))    // a client without a contact id
    await assertFails(setDoc(varRef(ctx(USERS.pm), 'cp0b'), payload(USERS.pm, { supplierId: null })))
    await createRefused('cp0', (user) => clientPayload(user, { clientId: null }))
    await createRefused('cp0b', (user) => payload(user, { supplierId: null }))
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

describe('create — source PO (ADR-90: REFUSED from every client; the backend reads the PO in its transaction)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
  it('a draft, pending-approval or cancelled PO is refused; a missing PO is refused', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po1'), poLinked(USERS.qs, PO.draft)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po2'), poLinked(USERS.qs, PO.pending)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po3'), poLinked(USERS.qs, PO.cancelled)))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po4'), poLinked(USERS.qs, { ...PO.sent, id: 'ghost' })))
  })

  it('ADR-90 — a PO from another project is refused, and so is the same document in the project that OWNS the PO: REFUSED from every client', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'po5'), poLinked(USERS.qs, PO_IN_PROJECT_B)))
    // …and the same document was accepted in the project that owns the PO (currency NZD there) until ADR-90.
    await createRefused('po6', (user) => poLinked(user, PO_IN_PROJECT_B, { currency: 'NZD' }), COMPANY_A, PROJECT_B)
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

describe('create — currency (ADR-90: REFUSED from every client; the backend resolves project → company → AUD)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
  it('ADR-90 — the right and the wrong currency alike are REFUSED from every client, in every project', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu1'), payload(USERS.qs, { currency: 'AUD' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu2'), payload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu3', COMPANY_A, PROJECT_B), payload(USERS.qs, { currency: 'NZD' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu4', COMPANY_A, PROJECT_B), payload(USERS.qs, { currency: 'AUD' })))
    await assertFails(setDoc(varRef(ctx(USERS.other), 'cu5', COMPANY_B, PROJECT_C), payload(USERS.other, { currency: 'AUD' })))
    await assertFails(setDoc(varRef(ctx(USERS.other), 'cu6', COMPANY_B, PROJECT_C), payload(USERS.other, { currency: 'NZD' })))
    await createRefused('cu1', (user) => payload(user, { currency: 'AUD' }))
    await createRefused('cu3', (user) => payload(user, { currency: 'NZD' }), COMPANY_A, PROJECT_B)
    expect(await readVarAt('cu5', COMPANY_B, PROJECT_C)).toBeUndefined()
    for (const currency of ['aud', 'AU', 'AUDX', '', null, 36]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'cu7'), payload(USERS.qs, { currency })))
    }
  })
})

describe('create — content shape (ADR-90: REFUSED from every client; the same bounds are the backend’s contract)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
  it('ADR-90 — valid and invalid content alike (title, description, reason, dates, notes, 1–200 lines) is REFUSED from every client', async () => {
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs1'), payload(USERS.qs, { title: '' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs2'), payload(USERS.qs, { title: 'x'.repeat(501) })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs3'), payload(USERS.qs, { title: null })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs4'), payload(USERS.qs, { description: 'x'.repeat(5001) })))
    for (const reason of ['weather', 'DESIGN_CHANGE', null, 3]) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs5'), payload(USERS.qs, { reason })))
    }
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs6'), payload(USERS.qs, { reason: 'error_omission' })))
    for (const k of ['identifiedDate', 'submittedDate', 'responseDueDate', 'effectiveDate']) {
      await assertFails(setDoc(varRef(ctx(USERS.qs), `cs7-${k}`), payload(USERS.qs, { [k]: '10/10/2026' })))
      await assertFails(setDoc(varRef(ctx(USERS.qs), `cs8-${k}`), payload(USERS.qs, { [k]: null })))
      await assertFails(setDoc(varRef(ctx(USERS.qs), `cs9-${k}`), payload(USERS.qs, { [k]: '2026-12-31' })))
    }
    await createRefused('cs6', (user) => payload(user, { reason: 'error_omission' }))
    await createRefused('cs9-effectiveDate', (user) => payload(user, { effectiveDate: '2026-12-31' }))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs10'), payload(USERS.qs, { notes: 'x'.repeat(5001) })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs11'), payload(USERS.qs, { lineItems: [] })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs12'), payload(USERS.qs, { lineItems: 'none' })))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'cs13'), payload(USERS.qs, { lines: Array.from({ length: 201 }, () => line(1)) })))
  })
})

describe('create — SIGNED whole-cent header money (ADR-90: REFUSED from every client; the backend DERIVES the header)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
  it('ADR-90 — a wrong header and a correct one alike are REFUSED from every client', async () => {
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
    // large signed values with floating-point noise were fine (roundMoney output) — refused like the rest
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'm3'), payload(USERS.qs, { lines: [line(1234567.89), line(-0.03, { taxCode: TAX_CODE.GST_FREE })] })))
    await createRefused('m3', (user) => payload(user, { lines: [line(1234567.89), line(-0.03, { taxCode: TAX_CODE.GST_FREE })] }))
  })

  it('ADR-90 — a signed credit header is REFUSED from every client, at create and on a draft edit; a negative variation is still never clamped once stored (a submit under the Rules keeps it signed)', async () => {
    await createRefused('m4', (user) => payload(user, { lines: [line(-1234.5)] }))
    await seed('m4', 'draft')
    await editRefused('m4', (user) => draftEdit(user, { lines: [line(-1234.5)] }), { thenStoreAs: USERS.qs })
    expect(await readVar('m4')).toMatchObject({ submittedSubtotal: -1234.5, submittedGst: -123.45, submittedTotal: -1357.95 })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'm4'), submitWrite(USERS.qs, { revision: 3 })))
    expect(await readVar('m4')).toMatchObject({ status: 'submitted', submittedSubtotal: -1234.5, submittedGst: -123.45, submittedTotal: -1357.95 })
  })
})

describe('create — originating RFI (ADR-34; ADR-90: REFUSED from every client — the link at create and on a draft edit is the backend’s)', () => {
  // Positive behaviour: tests/functions/variations.test.js → createVariation.
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

// ADR-90: NO client may edit a draft — the block has no draft-edit branch. Every
// test in this describe used to separate the edits the Rules accepted from the
// ones they refused; ALL of them are now refused, the app's own payload
// included, and the forged variants stay refused.
describe('ADR-90 — draft edit: the authored content, the header and the ADR-34 link are REFUSED from every client', () => {
  // Positive behaviour: tests/functions/variations.test.js → updateVariationDraft.
  it('ADR-90 — the hook payload (content, SIGNED header, revision 2, the audit stamps; a changed line count) is REFUSED from every client', async () => {
    await seed('e1', 'draft')
    await editRefused('e1', (user) => draftEdit(user))
    await editRefused('e1', (user) => draftEdit(user, { lines: [line(-50)] }))
    await editRefused('e1', (user) => draftEdit(user, { lines: Array.from({ length: 200 }, () => line(1)) }))
    expect(await readVar('e1')).toMatchObject({ title: 'Additional steel', submittedSubtotal: 800, submittedGst: 100, submittedTotal: 900, revision: 1, status: 'draft' })
  })

  it('what the backend stores for that edit is then submitted under the Rules unchanged — the signed header and the changed line count stand', async () => {
    await seed('e1', 'draft')
    await serverUpdate('e1', draftEdit(USERS.qs))
    const after = await readVar('e1')
    expect(after).toMatchObject({ title: 'Additional steel (revised)', reason: 'site_condition', supplierRef: 'Q-9', clientRef: null, submittedSubtotal: 1200, submittedGst: 150, submittedTotal: 1350, revision: 2, updatedBy: USERS.qs.uid, status: 'draft' })
    await serverUpdate('e1', draftEdit(USERS.qs, { lines: [line(-50)], revision: 3 }))
    expect(await readVar('e1')).toMatchObject({ submittedSubtotal: -50, submittedGst: -5, submittedTotal: -55, revision: 3 })
    await serverUpdate('e1', draftEdit(USERS.qs, { lines: Array.from({ length: 200 }, () => line(1)), revision: 4 }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'e1'), submitWrite(USERS.qs, { revision: 5 })))
    expect((await readVar('e1')).lineItems).toHaveLength(200)
  })

  it('ADR-90 — a client draft’s clientRef, its notes, and a partial edit (one field + revision + stamps) are REFUSED from every client', async () => {
    await seed('e2', 'draft', USERS.admin, {}, { base: clientPayload(USERS.admin) })
    await editRefused('e2', (user) => ({ clientRef: 'VO-8', supplierRef: null, notes: 'Agreed on site', revision: 2, ...stamps(user) }))
    await editRefused('e2', (user) => ({ title: 'Retitled', revision: 2, ...stamps(user) }))
    await editRefused('e2', (user) => ({ notes: 'Agreed on site', revision: 2, ...stamps(user) }))
    expect(await readVar('e2')).toMatchObject({ clientRef: 'VO-7', notes: '', title: 'Additional steel', revision: 1 })
  })

  it('ADR-90 — a LEGACY draft (no originRfi*, no audit stamps) cannot be edited by a client either: REFUSED from every client, and it acquires no key', async () => {
    await seed('e3', 'draft', USERS.admin, {}, { legacy: true })
    expect((await readVar('e3')).updatedAt).toBeUndefined()
    await editRefused('e3', (user) => draftEdit(user))
    const after = await readVar('e3')
    expect(after.revision).toBe(1)
    expect(after.updatedBy).toBeUndefined()
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

  it('ADR-90 / ADR-34 — adding, changing and removing the link on a draft (and a legacy draft), and re-sending an identical triple with an edit, are REFUSED from every client', async () => {
    await seed('l1', 'draft')
    await editRefused('l1', (user) => ({ ...link(RFIS.open), revision: 2, ...stamps(user) }), { thenStoreAs: USERS.qs })                 // add
    await editRefused('l1', (user) => ({ ...link(RFIS.answered), revision: 3, ...stamps(user) }), { thenStoreAs: USERS.pm })             // change
    await editRefused('l1', (user) => ({ ...draftEdit(user, { revision: 4 }), ...link(RFIS.answered) }))                                // identical triple riding on an edit
    await editRefused('l1', (user) => ({ ...UNLINKED, revision: 4, ...stamps(user) }))                                                   // remove
    expect(await readVar('l1')).toMatchObject({ ...link(RFIS.answered), revision: 3 })
    await seed('l2', 'draft', USERS.admin, {}, { legacy: true })
    await editRefused('l2', (user) => ({ ...link(RFIS.closed), revision: 2, ...stamps(user) }))
    await seed('l3', 'draft', USERS.admin, {}, { legacy: true })
    await editRefused('l3', (user) => ({ ...draftEdit(user), ...UNLINKED }))   // absent == null
    expect((await readVar('l2')).originRfiId).toBeUndefined()
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

  it('ADR-34 CRITICAL HISTORICAL CASE — a link survives its RFI’s later cancellation: submit, reject and withdraw still pass under the Rules (ADR-90: unrelated edits, the removal of the link and approve are REFUSED from every client; the backend’s edit and approval leave the link intact); only CHANGING to it is refused', async () => {
    await seed('h1', 'draft', USERS.admin, link(RFIS.open))
    await setRfiStatus(RFIS.open, 'cancelled')
    // ADR-90: the unrelated edits are the backend's (tests/functions/variations.test.js → updateVariationDraft
    // proves the link survives them); the client writes are refused and the stored link does not move.
    await editRefused('h1', (user) => draftEdit(user), { thenStoreAs: USERS.admin })
    await editRefused('h1', (user) => ({ ...draftEdit(user, { revision: 3 }), ...link(RFIS.open) }), { thenStoreAs: USERS.admin })
    expect(await readVar('h1')).toMatchObject({ ...link(RFIS.open), status: 'draft', revision: 3 })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.admin), 'h1'), submitWrite(USERS.admin, { revision: 4 })))
    // ADR-90: the client approve is refused; the approval is the backend's (tests/functions/variations.test.js → approveVariation).
    await updateRefused('h1', (user) => approveWrite(user, { revision: 5, lines: draftEdit(USERS.admin).lineItems, amounts: [1500, -300] }))
    expect(await readVar('h1')).toMatchObject({ ...link(RFIS.open), status: 'submitted', revision: 4 })
    await serverUpdate('h1', approveWrite(USERS.pm, { revision: 5, lines: draftEdit(USERS.admin).lineItems, amounts: [1500, -300] }))
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
    // ADR-90: removing a historical link is a draft edit — the backend's; from a client it is refused like every other.
    await editRefused('h4', (user) => ({ ...UNLINKED, revision: 2, ...stamps(user) }))
    expect(await readVar('h4')).toMatchObject({ ...link(RFIS.answered), revision: 1 })
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

  it('A → B → C: a legitimately created PO-linked variation cannot be re-pointed as a draft — every re-link, snapshot forgery and type flip is refused; it then submits (Rules) and is approved (ADR-90: by the backend only — REFUSED from every client) against its ORIGINAL PO', async () => {
    // A. ADR-90: the create is the backend's (tests/functions/variations.test.js → createVariation); a client create is refused
    await createRefused('fz1', (user) => poLinked(user, PO.sent))
    await serverCreate('fz1', poLinked(USERS.qs, PO.sent))
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
    // C. the legitimate path still works: a content edit (ADR-90: the backend's — REFUSED from every client), submit and approve, identity intact throughout
    await editRefused('fz1', (user) => edit(user), { thenStoreAs: USERS.qs })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'fz1'), submitWrite(USERS.qs, { revision: 3 })))
    for (const f of relinks) await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), { ...f, revision: 4, ...stamps(USERS.pm) }))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), approveWrite(USERS.pm, { revision: 4, lines: edit(USERS.qs).lineItems, amounts: [1500, -300], poId: PO.closed.id, poNumber: PO.closed.poNumber })))
    // Since ADR-62 / ADR-63 a PO-linked approve carries BOTH stamp pairs (the PO is sent); the plain form is a pre-M3-B1 bundle's and is denied by the FINAL rules.
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz1'), approveWrite(USERS.pm, { revision: 4, lines: edit(USERS.qs).lineItems, amounts: [1500, -300] })))
    // ADR-90: the both-pairs approve the FINAL rules used to accept is refused from every client too; the backend writes it.
    const approval = (user) => approveWrite(user, { revision: 4, lines: edit(USERS.qs).lineItems, amounts: [1500, -300], commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: user.uid, scopeCommittedAt: serverTimestamp(), scopeCommittedBy: user.uid })
    await updateRefused('fz1', approval)
    expect(await readVar('fz1')).toMatchObject({ status: 'submitted', revision: 3 })
    await serverUpdate('fz1', approval(USERS.pm))
    const approved = await readVar('fz1')
    expect(approved).toMatchObject({ status: 'approved', poId: PO.sent.id, poNumber: PO.sent.poNumber, supplierName: PO.sent.supplierName, supplierId: PO.sent.supplierId, variationType: 'supplier', variationNumber: 'SV-0001', revision: 4 })
    for (const f of relinks) await assertFails(updateDoc(varRef(ctx(USERS.admin), 'fz1'), { ...f, revision: 5, ...stamps(USERS.admin) }))
    // the exposure the figures read is against the ORIGINAL PO only
    expect(poCancellationBlockers(PO.sent.id, { variations: [approved] })).toHaveLength(1)
    expect(poCancellationBlockers(PO.closed.id, { variations: [approved] })).toEqual([])
  })

  it('manual-mode and PO-linked are fixed at creation in both directions; a client variation can never gain a PO; ADR-90 — content edits on each are REFUSED from every client (the backend’s edit leaves identity intact); a legacy link survives its PO’s cancellation', async () => {
    // ADR-90: both are created by the backend; the client creates are refused.
    await createRefused('fz2', (user) => payload(user))
    await createRefused('fz3', (user) => clientPayload(user))
    await serverCreate('fz2', payload(USERS.qs))            // manual mode
    await serverCreate('fz3', clientPayload(USERS.pm))       // client
    for (const f of [{ poId: PO.sent.id, poNumber: PO.sent.poNumber }, { poId: PO.sent.id }, { poNumber: PO.sent.poNumber }, { supplierId: PO.sent.supplierId, supplierName: PO.sent.supplierName, poId: PO.sent.id, poNumber: PO.sent.poNumber }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.qs), 'fz2'), edit(USERS.qs, f)))          // manual → linked, even to a valid sent PO
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz3'), edit(USERS.pm, { ...f, clientRef: 'VO-7', supplierRef: null })))   // client → PO
    }
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'fz3'), edit(USERS.pm, { variationType: 'supplier', variationNumber: 'SV-0005', supplierId: PO.sent.supplierId, supplierName: PO.sent.supplierName, clientId: null, clientName: null, clientRef: null, supplierRef: '' })))
    // ADR-90: the legitimate content edits are the backend's; the client writes are refused and identity is intact after the stored edit
    await editRefused('fz2', (user) => edit(user), { thenStoreAs: USERS.qs })
    await editRefused('fz3', (user) => edit(user, { clientRef: 'VO-8', supplierRef: null }), { thenStoreAs: USERS.pm })
    expect(await readVar('fz2')).toMatchObject({ poId: null, poNumber: null, revision: 2 })
    expect(await readVar('fz3')).toMatchObject({ variationType: 'client', poId: null, clientId: 'contactC1', revision: 2 })
    // a legacy PO-linked draft keeps its link through the PO's later cancellation and still edits (the PO is read at create only)
    await seed('fz4', 'draft', USERS.admin, {}, { legacy: true, base: poLinked(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), PO.sent.id), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await editRefused('fz4', (user) => edit(user), { thenStoreAs: USERS.qs })
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

  it('ADR-90 — two assessors who both reviewed revision 1: the approve is REFUSED from every client; once the backend has approved for the first, the second’s plain update is refused (it carries 2 over a stored 2)', async () => {
    await seed('rv4', 'submitted')
    await updateRefused('rv4', (user) => approveWrite(user, { amounts: [1000, -200], assessmentNotes: '' }))
    await serverUpdate('rv4', approveWrite(USERS.pm, { amounts: [1000, -200], assessmentNotes: '' }))
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

  // The supported approve: tests/functions/variations.test.js → approveVariation.
  it('ADR-90 — submitted → approved is REFUSED from every client; the document the backend approves (certified lines, SIGNED approved header, notes, dates, stamps) is then terminal under the Rules', async () => {
    await seed('t2', 'submitted')
    await updateRefused('t2', (user) => approveWrite(user))
    await serverUpdate('t2', approveWrite(USERS.pm))
    const after = await readVar('t2')
    expect(after).toMatchObject({ status: 'approved', approvedBy: USERS.pm.uid, approvedSubtotal: 700, approvedGst: 90, approvedTotal: 790, assessmentNotes: 'Negotiated', approvedDate: '2026-10-12', effectiveDate: '2026-10-12', revision: 2 })
    expect(after.lineItems.map(l => l.approvedAmount)).toEqual([900, -200])
    expect(after.submittedSubtotal).toBe(800)
    for (const w of [rejectWrite, withdrawWrite, submitWrite, draftEdit]) await assertFails(updateDoc(varRef(ctx(USERS.pm), 't2'), w(USERS.pm, { revision: 3 })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't2'), approveWrite(USERS.pm, { revision: 3, amounts: [1, -1] })))
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 't2'), { status: 'draft', revision: 3, ...stamps(USERS.pm) }))
  })

  it('ADR-90 — an approval above, equal to, at zero or below the submitted value is REFUSED from every client whatever it certifies (the backend keeps approval UNBOUNDED and never clamps)', async () => {
    for (const [i, amounts] of [[5000, 2000], [1000, -200], [0, 0], [-1000, -5000]].entries()) {
      await seed(`t3-${i}`, 'submitted')
      await updateRefused(`t3-${i}`, (user) => approveWrite(user, { amounts }))
      // The stored shape the backend produces is unchanged: signed, never clamped.
      await serverUpdate(`t3-${i}`, approveWrite(USERS.pm, { amounts }))
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

  it('a document already holding the reserved under_review can be rejected or withdrawn through the Rules (none is stranded; ADR-90: its approval is the backend’s and is REFUSED from every client), but nothing can ENTER it', async () => {
    await seed('t8', 'under_review')
    await updateRefused('t8', (user) => approveWrite(user))
    expect(await readStatus('t8')).toBe('under_review')
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
    // ADR-90: a no-op "draft → draft" with only stamps and revision used to be a (content-free) draft edit; with no
    // draft-edit branch it is refused too — a draft's revision moves only by submit, withdraw or the backend.
    await editRefused('t14', (user) => ({ status: 'draft', revision: 2, ...stamps(user) }))
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

  it('ADR-90 — approve: a wrong line count, a missing or malformed date, over-long or null notes AND the well-formed approval are all REFUSED from every client (the count, date and notes bounds are the backend’s contract)', async () => {
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
    // an approval that leaves the effective date empty used to be fine — refused from every client like the rest
    await updateRefused('p5', (user) => approveWrite(user, { effectiveDate: '' }))
    expect(await readStatus('p5')).toBe('submitted')
  })

  it('submit — the stored draft must hold at least one line; the submitted date must be a date', async () => {
    await seed('p6', 'draft', USERS.admin, { lineItems: [] })
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p6'), submitWrite(USERS.qs)))
    await seed('p7', 'draft')
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p7'), submitWrite(USERS.qs, { submittedDate: 'today' })))
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'p7'), submitWrite(USERS.qs, { submittedDate: null })))
  })
})

describe('approval money — SIGNED whole cents, total exact (ADR-90: the approved header is DERIVED by the backend; REFUSED from every client)', () => {
  // Positive behaviour: tests/functions/variations.test.js → approveVariation.
  it('ADR-90 — a non-number, a third-decimal value, a total off by one cent AND the real buildApprovedLineItems header are all REFUSED from every client', async () => {
    await seed('am1', 'submitted')
    for (const f of [{ approvedSubtotal: '700' }, { approvedGst: null }, { approvedSubtotal: 700.001 }, { approvedGst: 90.005 }, { approvedTotal: 790.01 }, { approvedTotal: 789.99 }, { approvedGst: 91 }]) {
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'am1'), approveWrite(USERS.pm, f)))
    }
    const { approvedTotal: _t, ...noTotal } = approveWrite(USERS.pm)   // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(varRef(ctx(USERS.pm), 'am1'), noTotal))
    expect(await readStatus('am1')).toBe('submitted')
    await updateRefused('am1', (user) => approveWrite(user, { amounts: [-333.33, 0.01] }))
    expect(await readVar('am1')).toMatchObject({ status: 'submitted', approvedSubtotal: null, approvedGst: null, approvedTotal: null })
    // The header that payload carried is still the real derivation (the backend runs the same module).
    const real = approveWrite(USERS.pm, { amounts: [-333.33, 0.01] })
    expect(real).toMatchObject({ approvedSubtotal: -333.32, approvedGst: -33.33, approvedTotal: -366.65 })
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
  it('a legacy draft edits, submits and withdraws; a legacy submitted rejects and withdraws; each acquires updatedAt / updatedBy and revision 2 (ADR-90: a legacy submitted is approved by the backend only — REFUSED from every client)', async () => {
    await seed('lg1', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'lg1'), submitWrite(USERS.qs)))
    expect(await readVar('lg1')).toMatchObject({ status: 'submitted', revision: 2, submittedBy: USERS.qs.uid, updatedBy: USERS.qs.uid })
    await seed('lg2', 'draft', USERS.admin, {}, { legacy: true })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'lg2'), withdrawWrite(USERS.qs)))
    await seed('lg3', 'submitted', USERS.admin, {}, { legacy: true })
    await updateRefused('lg3', (user) => approveWrite(user))
    expect(await readVar('lg3')).toMatchObject({ status: 'submitted', revision: 1 })
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

  it('a legacy PO-linked supplier variation whose PO has since been cancelled still submits, rejects and withdraws (ADR-90: its edit is the backend’s — REFUSED from every client) — but since ADR-62 (Correction A) it can NOT be approved: approval is refused, with or without the commitment pair', async () => {
    await seed('lg7', 'draft', USERS.admin, {}, { legacy: true, base: poLinked(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), PO.sent.id), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await editRefused('lg7', (user) => draftEdit(user), { thenStoreAs: USERS.qs })   // ADR-90: the edit is the backend's
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
  it('a supplier variation raised (backend), submitted (Rules) and approved (backend) feeds Commitment Exposure exactly once, by cost code, signed; pending is exposure only — ADR-90: its create and approve are REFUSED from every client', async () => {
    await createRefused('f1', (user) => poLinked(user))
    await serverCreate('f1', poLinked(USERS.qs))
    let v = await readVar('f1')
    expect(approvedSupplierVariationsByCostCode([v])).toEqual({})
    expect(pendingSupplierVariationExposureByCostCode([v])).toEqual({ cc1: 1000, cc2: -200 })
    expect(pendingSupplierVariationExposureTotal([v])).toBe(800)
    expect(openVariationCount([v])).toBe(1)
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'f1'), submitWrite(USERS.qs)))
    // ADR-62 / ADR-63: the PO-linked approve carries both stamp pairs (the PO is sent). The GROSS approved
    // figure below is unchanged by it; the lines carry no poLineIndex, so nothing matures (new scope).
    const f1Approval = (user) => approveWrite(user, { revision: 3, amounts: [900, -500], commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: user.uid, scopeCommittedAt: serverTimestamp(), scopeCommittedBy: user.uid })
    await updateRefused('f1', f1Approval)
    await serverUpdate('f1', f1Approval(USERS.pm))
    v = await readVar('f1')
    expect(approvedSupplierVariationsByCostCode([v])).toEqual({ cc1: 900, cc2: -500 })
    expect(approvedSupplierVariationsTotal([v])).toBe(400)
    expect(pendingSupplierVariationExposureTotal([v])).toBe(0)
    expect(openVariationCount([v])).toBe(0)
    // the added keys change no figure
    const { updatedAt: _u, updatedBy: _b, ...legacyShape } = v   // eslint-disable-line no-unused-vars
    expect(approvedSupplierVariationsByCostCode([legacyShape])).toEqual(approvedSupplierVariationsByCostCode([v]))
  })

  it('an approved client variation raises the Current Contract Sum (signed); a negative one lowers it; pending client exposure is separate — ADR-90: its create and approve are the backend’s, REFUSED from every client', async () => {
    await createRefused('f2', (user) => clientPayload(user))
    await serverCreate('f2', clientPayload(USERS.pm))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f2'), submitWrite(USERS.pm)))
    const baseline = { originalContractValue: 100000 }
    let v = await readVar('f2')
    expect(pendingClientVariationExposureTotal([v])).toBe(800)
    expect(computeMargin({ baseline, variations: [v], forecastFinalCost: 80000 }).currentContractSum).toBe(100000)
    await updateRefused('f2', (user) => approveWrite(user, { revision: 3, amounts: [1000, -200], assessmentNotes: '' }))
    await serverUpdate('f2', approveWrite(USERS.pm, { revision: 3, amounts: [1000, -200], assessmentNotes: '' }))
    v = await readVar('f2')
    expect(approvedClientVariationsTotal([v])).toBe(800)
    expect(computeMargin({ baseline, variations: [v], forecastFinalCost: 80000 }).currentContractSum).toBe(100800)
    await createRefused('f3', (user) => clientPayload(user, { variationNumber: 'CV-0002', lines: [line(-3000)] }))
    await serverCreate('f3', clientPayload(USERS.pm, { variationNumber: 'CV-0002', lines: [line(-3000)] }))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'f3'), submitWrite(USERS.pm)))
    await updateRefused('f3', (user) => approveWrite(user, { revision: 3, lines: [line(-3000)], amounts: [-3000], assessmentNotes: '' }))
    await serverUpdate('f3', approveWrite(USERS.pm, { revision: 3, lines: [line(-3000)], amounts: [-3000], assessmentNotes: '' }))
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
    await createRefused('f6', (user) => payload(user, link(RFIS.open)))   // ADR-90
    await serverCreate('f6', payload(USERS.qs, link(RFIS.open)))
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'f6'), submitWrite(USERS.qs)))
    const v = await readVar('f6')
    expect(variationsForRfi([v], RFIS.open.id).map(x => x.id)).toEqual(['f6'])
    expect(variationsForRfi([v], RFIS.answered.id)).toEqual([])
  })
})

// ── The REAL guarded transactions (lib/variationActions.js) ──────────────────

// ADR-90: the app's own transactions are now the DRAFT EDIT and SUBMIT / REJECT /
// WITHDRAW only. Approval is a call to the trusted backend (lib/variationActions.js
// → runApproveVariation; proven in tests/functions/variations.test.js →
// approveVariation): runTransitionVariation refuses to approve before any read,
// and the payload it used to write is refused by the Rules.
// ADR-90, checkpoint-1 correction: runUpdateVariationDraft is no longer a
// transaction either — it is a call to the trusted backend (proven in
// tests/functions/variations.test.js → updateVariationDraft; its request and
// error mapping in tests/unit/variationActions.test.js). The tests below that
// drove it against the Rules now prove the raw write it used to make is refused.
describe('runTransitionVariation — the app’s own transaction against the real rules (ADR-90: the draft edit and approve are server calls; their old writes are REFUSED)', () => {
  const qs = { db: null, uid: USERS.qs.uid }
  const pm = { db: null, uid: USERS.pm.uid }
  beforeEach(() => { qs.db = ctx(USERS.qs); pm.db = ctx(USERS.pm) })

  const edit = {
    title: ' Additional steel (revised) ', description: 'More', reason: 'site_condition', clientRef: null, supplierRef: ' Q-9 ',
    identifiedDate: '2026-10-01', responseDueDate: '2026-10-30', effectiveDate: '',
    lineItems: [line(1500, { description: 'x' }), line(-300, { costCodeId: 'cc2', taxCode: TAX_CODE.INPUT_TAXED })],
  }
  const run = (who, fn, args) => fn({ db: who.db, variationRef: varRef(who.db, args.id), uid: who.uid, runTransaction, serverTimestamp, ...args })

  // The write the old transaction made for `edit` (lib/variationActions.js → draftUpdate, since removed).
  const oldEditWrite = (user, extra = {}) => draftEdit(user, { lines: edit.lineItems, description: 'More', ...extra })
  // The app's draft edit is a server call now: it makes NO Firestore write, whatever the server answers.
  const noCall = () => { const calls = []; return { calls, call: async (name, data) => { calls.push({ name, data }); return { variationId: data.variationId, alreadyApplied: false, calcVersion: 2 } } } }

  it('ADR-90 — the write a draft edit from the reviewed copy used to make (content, signed header, revision 2, stamps) is REFUSED from every client; the app now sends a request instead and writes nothing', async () => {
    await seed('x1', 'draft')
    const seen = await readVar('x1')
    await editRefused('x1', (user) => oldEditWrite(user))
    const stub = noCall()
    await runUpdateVariationDraft({ call: stub.call, projectId: PROJECT_A, seen, data: edit, uid: USERS.qs.uid })
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]).toMatchObject({ name: 'updateVariationDraft', data: { projectId: PROJECT_A, variationId: 'x1', expectedRevision: 1, title: 'Additional steel (revised)', supplierRef: 'Q-9', clientRef: null } })
    expect(JSON.stringify(stub.calls[0].data)).not.toMatch(/submittedGst|submittedSubtotal|submittedTotal|approvedAmount|costCodeName/)
    expect(await readVar('x1')).toMatchObject({ title: 'Additional steel', submittedSubtotal: 800, revision: 1 })
  })

  it('ADR-90 — a STALE edit (edited underneath by the backend — revision moved) is REFUSED from every client at the stale AND at the fresh revision; the first edit stands (the stale check is the server’s: variation-stale)', async () => {
    await seed('x2', 'draft')
    await serverUpdate('x2', oldEditWrite(USERS.pm, { lines: [line(1200)] }))   // the other editor's save, revision 2
    await editRefused('x2', (user) => oldEditWrite(user))                        // built over the stale copy: revision 2 again
    await editRefused('x2', (user) => oldEditWrite(user, { revision: 3 }))       // built over the fresh copy
    expect(await readVar('x2')).toMatchObject({ submittedSubtotal: 1200, revision: 2 })
  })

  it('ADR-90 — an edit of a draft that was SUBMITTED underneath is REFUSED from every client (the status check is the server’s: variation-not-draft)', async () => {
    await seed('x3', 'draft')
    const seen = await readVar('x3')
    await run(qs, runTransitionVariation, { id: 'x3', seen, nextStatus: VARIATION_STATUS.SUBMITTED })
    await editRefused('x3', (user) => oldEditWrite(user))
    await editRefused('x3', (user) => oldEditWrite(user, { revision: 3 }))
    expect(await readVar('x3')).toMatchObject({ status: 'submitted', revision: 2, title: 'Additional steel' })
    // …and the app refuses to send an edit of a copy it can see is no longer a draft.
    const stub = noCall()
    await expectKind(runUpdateVariationDraft({ call: stub.call, projectId: PROJECT_A, seen: await readVar('x3'), data: edit, uid: USERS.pm.uid }), VARIATION_WRITE_ERROR.INVALID)
    expect(stub.calls).toEqual([])
  })

  it('an invalid edit (no title, no lines, a line without a cost code, an ineligible RFI) is refused before any call', async () => {
    await seed('x4', 'draft')
    const seen = await readVar('x4')
    const stub = noCall()
    for (const data of [{ ...edit, title: '' }, { ...edit, lineItems: [] }, { ...edit, lineItems: [line(1, { costCodeId: '' })] }, { ...edit, originRfi: { ...RFIS.draft } }]) {
      await expectKind(runUpdateVariationDraft({ call: stub.call, projectId: PROJECT_A, seen, data, uid: USERS.qs.uid }), VARIATION_WRITE_ERROR.INVALID)
    }
    expect(stub.calls).toEqual([])   // ADR-90: refused before any CALL — nothing is sent, nothing is written
    expect((await readVar('x4')).revision).toBe(1)
  })

  it('ADR-90 — the writes that linked, kept and unlinked the originating RFI through the old transaction are REFUSED from every client; the app sends the link as a request (set, keep, remove)', async () => {
    await seed('x5', 'draft')
    await editRefused('x5', (user) => ({ ...oldEditWrite(user), ...link(RFIS.open) }), { thenStoreAs: USERS.qs })   // link
    expect(await readVar('x5')).toMatchObject(link(RFIS.open))
    await editRefused('x5', (user) => oldEditWrite(user, { revision: 3 }))                                           // undefined → preserved
    await editRefused('x5', (user) => ({ ...oldEditWrite(user, { revision: 3 }), ...UNLINKED }))                     // unlink
    expect(await readVar('x5')).toMatchObject({ ...link(RFIS.open), revision: 2 })
    const seen = await readVar('x5')
    const stub = noCall()
    await runUpdateVariationDraft({ call: stub.call, projectId: PROJECT_A, seen, data: { ...edit, originRfi: RFIS.answered }, uid: USERS.qs.uid })
    await runUpdateVariationDraft({ call: stub.call, projectId: PROJECT_A, seen, data: { ...edit }, uid: USERS.qs.uid })
    await runUpdateVariationDraft({ call: stub.call, projectId: PROJECT_A, seen, data: { ...edit, originRfi: null }, uid: USERS.qs.uid })
    expect(stub.calls.map(c => [c.data.changeOriginRfi, c.data.originRfiId])).toEqual([[true, RFIS.answered.id], [false, null], [true, null]])
    expect((await readVar('x5')).revision).toBe(2)
  })

  it('submit and reject / withdraw from the reviewed copies, each +1; ADR-90 — approve is no longer a transaction: runTransitionVariation refuses it before any read and its old payload is REFUSED from every client', async () => {
    await seed('x6', 'draft')
    await run(qs, runTransitionVariation, { id: 'x6', seen: await readVar('x6'), nextStatus: VARIATION_STATUS.SUBMITTED, today: '2026-10-27' })
    let live = await readVar('x6')
    expect(live).toMatchObject({ status: 'submitted', submittedBy: USERS.qs.uid, submittedDate: '2026-10-27', revision: 2 })
    const refused = await expectKind(run(pm, runTransitionVariation, { id: 'x6', seen: live, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: ['899.999', -200], assessmentNotes: ' Negotiated ' }, today: '2026-10-27' }), VARIATION_WRITE_ERROR.INVALID)
    expect(refused.message).toMatch(/approved by the Constrap server/)
    // …and the write that transaction used to make (amounts normalised to cents, trimmed notes) is refused by the Rules.
    await updateRefused('x6', (user) => approveWrite(user, { amounts: [900, -200], assessmentNotes: 'Negotiated', approvedDate: '2026-10-27', effectiveDate: '2026-10-27', revision: 3 }))
    expect(await readVar('x6')).toMatchObject({ status: 'submitted', revision: 2, approvedBy: null })
    await seed('x7', 'submitted')
    await run(pm, runTransitionVariation, { id: 'x7', seen: await readVar('x7'), nextStatus: VARIATION_STATUS.REJECTED, extras: { assessmentNotes: 'Not agreed' } })
    expect(await readVar('x7')).toMatchObject({ status: 'rejected', rejectedBy: USERS.pm.uid, revision: 2, assessmentNotes: 'Not agreed' })
    await seed('x8', 'submitted')
    await run(qs, runTransitionVariation, { id: 'x8', seen: await readVar('x8'), nextStatus: VARIATION_STATUS.WITHDRAWN })
    expect(await readVar('x8')).toMatchObject({ status: 'withdrawn', withdrawnBy: USERS.qs.uid, revision: 2 })
  })

  it('a STALE assessment (approved underneath — by the backend, ADR-90) is refused with nothing written — the second assessor never overwrites the first', async () => {
    await seed('x9', 'submitted')
    const seen = await readVar('x9')
    await serverUpdate('x9', approveWrite(USERS.pm, { amounts: [1000, -200], assessmentNotes: '' }))
    // The second assessor's approve: no transaction any more (INVALID before any read), and the raw payload is refused by the Rules.
    await expectKind(run(qs, runTransitionVariation, { id: 'x9', seen, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [500, -200], assessmentNotes: 'less' } }), VARIATION_WRITE_ERROR.INVALID)
    await updateRefused('x9', (user) => approveWrite(user, { amounts: [500, -200], assessmentNotes: 'less' }))
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
    // ADR-90: an approve never reaches a read, so the MISSING document is proven with a transition the browser still writes.
    await expectKind(run(pm, runTransitionVariation, { id: 'gone', seen: { ...seen, id: 'gone' }, nextStatus: VARIATION_STATUS.APPROVED, extras: { approvedAmounts: [1000, -200] } }), VARIATION_WRITE_ERROR.INVALID)
    await expectKind(run(pm, runTransitionVariation, { id: 'gone', seen: { ...seen, id: 'gone' }, nextStatus: VARIATION_STATUS.REJECTED }), VARIATION_WRITE_ERROR.MISSING)
    expect((await readVar('x10')).revision).toBe(1)
  })

  it('a denied role is refused by the RULES as PERMISSION with nothing written', async () => {
    await seed('x12', 'draft')
    const sub = { db: ctx(USERS.sub), uid: USERS.sub.uid }
    const seen = await readVar('x12')
    await expectKind(run(sub, runTransitionVariation, { id: 'x12', seen, nextStatus: VARIATION_STATUS.SUBMITTED }), VARIATION_WRITE_ERROR.PERMISSION)
    await assertFails(updateDoc(varRef(sub.db, 'x12'), oldEditWrite(USERS.sub)))   // ADR-90: the old edit write — refused for the denied role as for every other
    expect(await readVar('x12')).toMatchObject({ status: 'draft', revision: 1 })
  })

  it('a legacy draft (no stamps, no link keys) submits through the transaction, acquiring the keys; ADR-90 — its edit write is REFUSED from every client', async () => {
    await seed('x13', 'draft', USERS.admin, {}, { legacy: true })
    await editRefused('x13', (user) => oldEditWrite(user))
    await run(qs, runTransitionVariation, { id: 'x13', seen: await readVar('x13'), nextStatus: VARIATION_STATUS.SUBMITTED })
    expect(await readVar('x13')).toMatchObject({ status: 'submitted', revision: 2, submittedBy: USERS.qs.uid, updatedBy: USERS.qs.uid })
  })
})

// ── NOT enforced — the honest ceiling ────────────────────────────────────────

// ADR-90 CLOSES this ceiling for client writes. At create, on a draft edit and at
// approval the lines, the header, the notes rule and the numbering are the
// trusted backend's (tests/functions/variations.test.js), and every client write
// that used to slip through here is refused outright. What Rules still cannot
// do — look inside a stored array — no longer matters for a client write,
// because no client writes one; stored content is verified by the backend when
// it is approved or applied.
describe('DC37 — the former "NOT ENFORCED by rules" ceiling is CLOSED for client writes (ADR-90)', () => {
  // Positive behaviour and the server's verification: tests/functions/variations.test.js.
  it('ADR-90 — the lineItems ceiling is closed for client writes: junk elements, a bogus cost code, a wrong tax code and an approved amount on a DRAFT line are REFUSED from every client, at create and on a draft edit', async () => {
    const junk = [{ foo: 'bar' }, { costCodeId: 'ccX', submittedAmount: 'lots', taxCode: 'vat', approvedAmount: 99999, approvedGst: 9999 }]
    await createRefused('n1', (user) => payload(user, { lines: junk, submittedSubtotal: 800, submittedGst: 100, submittedTotal: 900 }))
    await seed('n1', 'draft')
    await editRefused('n1', (user) => ({ lineItems: junk, submittedSubtotal: 800, submittedGst: 100, submittedTotal: 900, revision: 2, ...stamps(user) }))
  })

  it('ADR-90 — the header ceiling is closed for client writes: a header unrelated to its lines (subtotal + gst == total) is REFUSED from every client, at create, on a draft edit and at approval', async () => {
    await createRefused('n2', (user) => payload(user, { submittedSubtotal: 800, submittedGst: 800, submittedTotal: 1600 }))
    await createRefused('n3', (user) => payload(user, { submittedSubtotal: 12345, submittedGst: -5, submittedTotal: 12340 }))
    await seed('n2', 'draft')
    await editRefused('n2', (user) => ({ submittedSubtotal: 800, submittedGst: 800, submittedTotal: 1600, revision: 2, ...stamps(user) }))
    await seed('n3', 'draft')
    await editRefused('n3', (user) => ({ submittedSubtotal: 12345, submittedGst: -5, submittedTotal: 12340, revision: 2, ...stamps(user) }))
    await seed('n4', 'submitted')
    await updateRefused('n4', (user) => approveWrite(user, { approvedSubtotal: 700, approvedGst: 700, approvedTotal: 1400 }))
  })

  it('ADR-90 — "assessment notes required when approved differs from submitted" is no longer the client’s: an approval that differs with EMPTY notes is REFUSED from every client (the backend enforces the rule)', async () => {
    await seed('n5', 'submitted')
    await updateRefused('n5', (user) => approveWrite(user, { amounts: [1, -1], assessmentNotes: '' }))
  })

  it('ADR-90 — creator == approver through a direct write is REFUSED from every client (self-approval remains permitted by decision — through the backend); duplicate numbers and duplicate counterparty references can no longer be created by a client (DC6 / DC9: numbering is the backend counter’s)', async () => {
    await seed('n6', 'submitted', USERS.qs)
    await assertFails(updateDoc(varRef(ctx(USERS.qs), 'n6'), approveWrite(USERS.qs)))
    expect(await readStatus('n6')).toBe('submitted')
    await createRefused('n7', (user) => payload(user, { supplierRef: 'Q-1' }))
    await createRefused('n8', (user) => payload(user, { supplierRef: 'Q-1' }))
  })

  it('ADR-90 — a direct-SDK caller who reads first and writes stored + 1 can no longer overwrite another editor’s CONTENT: the edit is REFUSED from every client at any revision; the rules-ASSISTED stale guard now covers only the content-free transitions', async () => {
    await seed('n9', 'draft')
    await editRefused('n9', (user) => draftEdit(user), { thenStoreAs: USERS.qs })   // the first editor's save (the backend's), revision 2
    const live = await readVar('n9')
    await editRefused('n9', (user) => draftEdit(user, { lines: [line(1200)], revision: live.revision + 1 }))
    expect(await readVar('n9')).toMatchObject({ submittedSubtotal: live.submittedSubtotal, revision: 2 })
    // What remains rules-assisted: a transition written as stored + 1 by someone who did not review the latest copy is accepted.
    await assertSucceeds(updateDoc(varRef(ctx(USERS.pm), 'n9'), submitWrite(USERS.pm, { revision: live.revision + 1 })))
    expect(await readVar('n9')).toMatchObject({ status: 'submitted', revision: 3, submittedSubtotal: live.submittedSubtotal })
  })

  it('the supplier of a stored PO-linked variation is never re-compared to the PO by the Rules afterwards; ADR-90 — a create whose lines name a cost code or PO line the order does not have is REFUSED from every client (the backend checks them)', async () => {
    await seed('n10', 'draft', USERS.admin, {}, { base: poLinked(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(doc(c.firestore(), posPath(), PO.sent.id), { supplierName: 'Renamed Co' })
    })
    await assertSucceeds(updateDoc(varRef(ctx(USERS.qs), 'n10'), submitWrite(USERS.qs)))
    await createRefused('n11', (user) => poLinked(user, { ...PO.sent, supplierName: 'Renamed Co' }, { lines: [line(10, { costCodeId: 'ccNotOnPo', poLineIndex: 7 })] }))
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
// ADR-63 (M3-B2): the second, independent pair — the new-scope commitment. The
// FINAL ruleset requires BOTH pairs on a PO-linked approve; the legacy write
// (branch f) may carry either pair while its stored value is null.
const scoped    = (user) => ({ scopeCommittedAt: serverTimestamp(), scopeCommittedBy: user.uid })
const bothPairs = (user) => ({ ...applied(user), ...scoped(user) })
const approveApplied = (user, extra = {}) => approveWrite(user, { amounts: [900], lines: PO_LINES, assessmentNotes: '', ...bothPairs(user), ...extra })
const approvePlain   = (user, extra = {}) => approveWrite(user, { amounts: [900], lines: PO_LINES, assessmentNotes: '', ...extra })
// The M3-B1 bundle's approve: the applied pair only — DENIED by the FINAL file.
const approveB1      = (user, extra = {}) => approveWrite(user, { amounts: [900], lines: PO_LINES, assessmentNotes: '', ...applied(user), ...extra })
const applyWrite     = (user, extra = {}) => ({ ...bothPairs(user), revision: 2, ...stamps(user), ...extra })
const scopeWrite     = (user, extra = {}) => ({ ...scoped(user), revision: 2, ...stamps(user), ...extra })

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
// ADR-90: every write in the rest of this file — an approve carrying the stamp
// pair(s), and the legacy Apply / Commit new scope — is a TRUSTED-BACKEND
// operation now (tests/functions/variations.test.js → approveVariation /
// applyVariationCommitment). The Rules admit a commitment stamp from NO client
// on ANY branch, so each test below proves the payload the Rules used to accept
// is refused for every financial role with nothing written, keeps every forged
// variant it already refused, and — where it went on to read derived figures —
// reads them over the document the backend stores.

describe('ADR-62 — approve WITH the commitment stamps (ADR-90: REFUSED from every client; the backend approves and applies)', () => {
  it('ADR-90 — a PO-linked supplier approve against a SENT PO with the stamps is REFUSED from every client (every financial role); the variation the backend approves then adjusts that PO line', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await updateRefused('v1', (user) => approveApplied(user))
    expect(await readVar('v1')).toMatchObject({ status: 'submitted', revision: 1 })
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
    for (const user of FINANCIAL) {
      const id = `v1_${user.uid}`
      await seed(id, 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await serverUpdate(id, approveApplied(user))
      const v = await readVar(id)
      expect(v.status).toBe('approved')
      expect(v.commitmentAppliedBy).toBe(user.uid)
      expect(v.commitmentAppliedAt).toBeTruthy()
      expect(isCommitmentApplied(v)).toBe(true)
      const po = await readPo(PO.sent)
      const adj = appliedSupplierVariationAdjustments([v], [po])
      expect(adj.byPoLine).toEqual({ [PO.sent.id]: { 0: 900 } })
      expect(remainingCommittedByCostCode([po], {}, {}, adj.byPoLine)).toEqual({ cc1: 3400 })   // 2500 + 900
      expect(unappliedSupplierVariationsByCostCode([v], [po])).toEqual({})
    }
  })

  it('ADR-90 — against a CLOSED PO too: REFUSED from every client', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin, PO.closed) })
    await updateRefused('v1', (user) => approveApplied(user))
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
  })

  it('the pre-M3-B1 approve payload (no stamps; an old-bundle tab) is DENIED on a PO-linked supplier variation for every role, with nothing written; ADR-90 — so is the both-pairs payload, and the same payload on a manual-mode variation: REFUSED from every client', async () => {
    for (const user of FINANCIAL) {
      await seed(`v_${user.uid}`, 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await assertFails(updateDoc(varRef(ctx(user), `v_${user.uid}`), approvePlain(user)))
      const v = await readVar(`v_${user.uid}`)
      expect(v.status).toBe('submitted')
      expect(v.revision).toBe(1)
      // The old tab can still withdraw or reject; approval — with or without the pair — is the backend's.
      await assertFails(updateDoc(varRef(ctx(user), `v_${user.uid}`), approveApplied(user)))
      expect(await readVar(`v_${user.uid}`)).toMatchObject({ status: 'submitted', revision: 1 })
    }
    await seed('manual', 'submitted')
    await updateRefused('manual', (user) => approveWrite(user))
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

  it('Correction A — a MISSING PO and a PO from ANOTHER PROJECT refuse the approval (the PO path is this project’s; wrong tenant / project never resolves); ADR-90 — a legacy approved unstamped document is applied by the backend only', async () => {
    await seed('gone', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, { ...PO.sent, id: 'poGone', poNumber: 'PO-0099' }, { lineItems: PO_LINES }) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'gone'), approveApplied(USERS.admin)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'gone'), approvePlain(USERS.admin)))
    await seed('otherProj', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, PO_IN_PROJECT_B, { lineItems: PO_LINES }) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'otherProj'), approveApplied(USERS.admin)))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'otherProj'), approvePlain(USERS.admin)))
    expect(await readStatus('gone')).toBe('submitted')
    expect(await readStatus('otherProj')).toBe('submitted')
    // Legacy APPROVED unstamped documents stay readable; applying one is the backend's.
    await seed('legacyOk', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin), legacy: true })
    expect((await readVar('legacyOk')).status).toBe('approved')
    await assertSucceeds(getDoc(varRef(ctx(USERS.qs), 'legacyOk')))
    await updateRefused('legacyOk', (user) => applyWrite(user))
  })

  it('the stamps are REFUSED on a manual-mode supplier variation and on a client variation; ADR-90 — and so is the plain approve of either: REFUSED from every client', async () => {
    await seed('manual', 'submitted')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approveWrite(USERS.admin, { ...applied(USERS.admin) })))
    await updateRefused('manual', (user) => approveWrite(user))
    await seed('client', 'submitted', USERS.admin, {}, { base: clientPayload(USERS.admin) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), approveWrite(USERS.admin, { ...applied(USERS.admin) })))
    await updateRefused('client', (user) => approveWrite(user, { assessmentNotes: 'Negotiated' }))
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

  it('the stamps cannot be born at CREATE — present, or present as null; ADR-90 — nor can the same payload WITHOUT the pair: REFUSED from every client', async () => {
    const db = ctx(USERS.admin)
    await assertFails(setDoc(varRef(db, 'c1'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES, ...applied(USERS.admin) })))
    await assertFails(setDoc(varRef(db, 'c2'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES, commitmentAppliedAt: null, commitmentAppliedBy: null })))
    // The same payload WITHOUT the pair was the ordinary create — refused since ADR-90.
    await createRefused('c3', (user) => poLinked(user, PO.sent, { lineItems: PO_LINES }))
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

describe('ADR-62 — the one-time legacy Apply (ADR-90: no client branch — REFUSED from every client; the backend applies)', () => {
  // Positive behaviour: tests/functions/variations.test.js → applyVariationCommitment.
  it('ADR-90 — the legacy Apply of an approved, unstamped PO-linked variation is REFUSED from every client (every financial role): no stamp, no revision, nothing moves', async () => {
    for (const user of FINANCIAL) {
      await seed(`a_${user.uid}`, 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      const before = await readVar(`a_${user.uid}`)
      await assertFails(updateDoc(varRef(ctx(user), `a_${user.uid}`), applyWrite(user)))
      const after = await readVar(`a_${user.uid}`)
      expect(isCommitmentApplied(after)).toBe(false)
      expect(after.revision).toBe(1)
      // Approved money, lines, PO link and every lifecycle stamp are untouched.
      for (const k of ['status', 'lineItems', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'approvedBy', 'poId', 'poNumber', 'supplierId', 'assessmentNotes', 'approvedDate', 'updatedBy']) {
        expect(after[k], k).toEqual(before[k])
      }
    }
  })

  it('a REPEAT is refused by the RULES — with the next revision, the same revision, or any revision — and the first (backend-written) stamps stand', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await updateRefused('v1', (user) => applyWrite(user))
    await serverUpdate('v1', applyWrite(USERS.admin))
    const first = await readVar('v1')
    for (const revision of [3, 2, 1, 4]) {
      await assertFails(updateDoc(varRef(ctx(USERS.pm), 'v1'), applyWrite(USERS.pm, { revision })))
    }
    const after = await readVar('v1')
    expect(after.commitmentAppliedBy).toBe(USERS.admin.uid)
    expect(after.revision).toBe(2)
    expect(after.commitmentAppliedAt.isEqual(first.commitmentAppliedAt)).toBe(true)
  })

  it('a document seeded with the stamps already set (approved by the backend) cannot be re-applied', async () => {
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

  it('a cancelled, draft or pending PO refuses the apply; ADR-90 — and so does a sent or closed one: REFUSED from every client (the backend reads the PO in its transaction)', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    for (const status of ['cancelled', 'draft', 'pending_approval']) {
      await setPoStatus(PO.sent, status)
      await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), applyWrite(USERS.admin)))
    }
    await setPoStatus(PO.sent, 'sent')
    await updateRefused('v1', (user) => applyWrite(user))
    await seed('v2', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin, PO.closed) })
    await updateRefused('v2', (user) => applyWrite(user))
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

  it('ADR-90 — a LEGACY approved document (no audit stamps, no link keys) is applied by the backend only: the legacy Apply is REFUSED from every client and the document acquires nothing', async () => {
    await seed('legacy', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin), legacy: true })
    const before = await readVar('legacy')
    expect(before).not.toHaveProperty('updatedAt')
    await updateRefused('legacy', (user) => applyWrite(user))
    const after = await readVar('legacy')
    expect(isCommitmentApplied(after)).toBe(false)
    expect(after).not.toHaveProperty('updatedAt')
    expect(after.revision).toBe(1)
  })
})

// ADR-90: approval and the legacy Apply are CALLS to the trusted backend now
// (lib/variationActions.js → runApproveVariation / runApplyVariationCommitment
// take an injected `call`, not a Firestore transaction), proven in
// tests/functions/variations.test.js. What is left to prove against the Rules
// is that the writes those two transactions used to make are refused.
describe('ADR-62 — the writes the app’s approve / apply transactions used to make (ADR-90: REFUSED from every client)', () => {
  const sdk = { runTransaction, serverTimestamp }

  it('ADR-90 — approve-and-apply in one write (PO sent on the server): runTransitionVariation refuses to approve before any read, and its old write is REFUSED from every client', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.qs)
    await expectKind(runTransitionVariation({
      db, variationRef: varRef(db, 'v1'), seen: await readVar('v1'), nextStatus: VARIATION_STATUS.APPROVED,
      extras: { approvedAmounts: [900], assessmentNotes: '' }, uid: USERS.qs.uid, ...sdk,
    }), VARIATION_WRITE_ERROR.INVALID)
    await updateRefused('v1', (user) => approveApplied(user))
    const v = await readVar('v1')
    expect(v.status).toBe('submitted')
    expect(isCommitmentApplied(v)).toBe(false)
    expect(v.revision).toBe(1)
  })

  it('ADR-90 — Correction A: with the server PO cancelled or missing the old approve write is REFUSED from every client, with and without the pair; nothing written', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await setPoStatus(PO.sent, 'cancelled')
    await updateRefused('v1', (user) => approveApplied(user))
    await updateRefused('v1', (user) => approvePlain(user))
    const v = await readVar('v1')
    expect(v.status).toBe('submitted')
    expect(v.revision).toBe(1)
    await setPoStatus(PO.sent, 'sent')
    await seed('gone', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, { ...PO.sent, id: 'poGone', poNumber: 'PO-0099' }, { lineItems: PO_LINES }) })
    await updateRefused('gone', (user) => approveApplied(user))
    expect(await readStatus('gone')).toBe('submitted')
  })

  it('ADR-90 — the legacy Apply write: REFUSED from every client the first time and every time; nothing written', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await updateRefused('v1', (user) => applyWrite(user))
    await updateRefused('v1', (user) => applyWrite(user))
    const v = await readVar('v1')
    expect(v.revision).toBe(1)
    expect(isCommitmentApplied(v)).toBe(false)
  })

  it('ADR-90 — TWO CONCURRENT applies by two users: BOTH are refused by the Rules and no stamp lands (the backend serialises the supported operation)', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const attempt = (user) => updateDoc(varRef(ctx(user), 'v1'), applyWrite(user))
    const results = await Promise.allSettled([attempt(USERS.admin), attempt(USERS.pm)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(0)
    for (const r of results) expect(r.reason?.code).toBe('permission-denied')
    const v = await readVar('v1')
    expect(v.revision).toBe(1)
    expect(isCommitmentApplied(v)).toBe(false)
  })

  it('ADR-90 — a STALE and a FRESH reviewed copy alike: the legacy Apply write is REFUSED from every client at either revision', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await testEnv.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), varsPath(), 'v1'), { revision: 2 }) })
    await updateRefused('v1', (user) => applyWrite(user))                    // built over the stale revision 1
    await updateRefused('v1', (user) => applyWrite(user, { revision: 3 }))   // built over the fresh revision 2
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
    expect((await readVar('v1')).revision).toBe(2)
  })

  it('a cancelled PO on the server refuses the apply write; a denied role is refused by the RULES; ADR-90 — and with the PO sent again it is still REFUSED from every client', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await setPoStatus(PO.sent, 'cancelled')
    await updateRefused('v1', (user) => applyWrite(user))
    await setPoStatus(PO.sent, 'sent')
    await assertFails(updateDoc(varRef(ctx(USERS.sub), 'v1'), applyWrite(USERS.sub)))
    await updateRefused('v1', (user) => applyWrite(user))
    expect(isCommitmentApplied(await readVar('v1'))).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// M3-B2 (ADR-63) — the new-scope commitment pair. Since ADR-90 it is written by
// the trusted backend only: with the applied pair on a PO-linked approve, or
// once by the legacy apply; never on a client / manual-mode variation, never
// at create — and never by a client.
// ═════════════════════════════════════════════════════════════════════════════

describe('ADR-63 — the scope pair on approve (ADR-90: REFUSED from every client)', () => {
  // Positive behaviour: tests/functions/variations.test.js → approveVariation.
  it('ADR-90 — a PO-linked approve carrying BOTH pairs is REFUSED from every client (every financial role), exactly as the M3-B1 payload (applied pair only — an un-reloaded old tab) is; nothing written', async () => {
    for (const user of FINANCIAL) {
      await seed(`v_${user.uid}`, 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
      await assertFails(updateDoc(varRef(ctx(user), `v_${user.uid}`), approveB1(user)))
      expect(await readStatus(`v_${user.uid}`)).toBe('submitted')
      await assertFails(updateDoc(varRef(ctx(user), `v_${user.uid}`), approveApplied(user)))
      const v = await readVar(`v_${user.uid}`)
      expect(v.status).toBe('submitted')
      expect(v).not.toHaveProperty('commitmentAppliedBy')
      expect(v).not.toHaveProperty('scopeCommittedBy')
      // What the backend stores for the same approval: both pairs, one instant.
      await serverUpdate(`v_${user.uid}`, approveApplied(user))
      const stored = await readVar(`v_${user.uid}`)
      expect(stored.commitmentAppliedBy).toBe(user.uid)
      expect(stored.scopeCommittedBy).toBe(user.uid)
      expect(stored.scopeCommittedAt.isEqual(stored.commitmentAppliedAt)).toBe(true)
    }
  })

  it('a scope pair ALONE on approve (no applied pair), a forged scope actor, a client clock, or half the scope pair are refused', async () => {
    await seed('v1', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), approvePlain(USERS.admin, scoped(USERS.admin))))
    await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { scopeCommittedBy: USERS.pm.uid })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { scopeCommittedBy: null })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(varRef(db, 'v1'), approveApplied(USERS.admin, { scopeCommittedAt: clock() })))
    }
    await assertFails(updateDoc(varRef(db, 'v1'), approveB1(USERS.admin, { scopeCommittedAt: serverTimestamp() })))
    await assertFails(updateDoc(varRef(db, 'v1'), approveB1(USERS.admin, { scopeCommittedBy: USERS.admin.uid })))
    expect(await readStatus('v1')).toBe('submitted')
  })

  it('the scope pair is refused on a manual-mode supplier and on a client variation (ADR-90: as is the plain approve of either), at create (present or null), and on a draft edit, submit, reject or withdraw', async () => {
    await seed('manual', 'submitted')
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approveWrite(USERS.admin, { ...scoped(USERS.admin) })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'manual'), approveWrite(USERS.admin, { ...bothPairs(USERS.admin) })))
    await updateRefused('manual', (user) => approveWrite(user))
    await seed('client', 'submitted', USERS.admin, {}, { base: clientPayload(USERS.admin) })
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'client'), approveWrite(USERS.admin, { ...scoped(USERS.admin) })))
    const db = ctx(USERS.admin)
    await assertFails(setDoc(varRef(db, 'c1'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES, ...scoped(USERS.admin) })))
    await assertFails(setDoc(varRef(db, 'c2'), poLinked(USERS.admin, PO.sent, { lineItems: PO_LINES, scopeCommittedAt: null, scopeCommittedBy: null })))
    await seed('d', 'draft', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertFails(updateDoc(varRef(db, 'd'), draftEdit(USERS.admin, { lines: PO_LINES, ...scoped(USERS.admin) })))
    await assertFails(updateDoc(varRef(db, 'd'), submitWrite(USERS.admin, scoped(USERS.admin))))
    await seed('s', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertFails(updateDoc(varRef(db, 's'), rejectWrite(USERS.admin, scoped(USERS.admin))))
    await assertFails(updateDoc(varRef(db, 's'), withdrawWrite(USERS.admin, scoped(USERS.admin))))
  })
})

describe('ADR-63 — the per-pair, one-time legacy writes (ADR-90: no client branch — REFUSED from every client)', () => {
  // Positive behaviour: tests/functions/variations.test.js → applyVariationCommitment.
  it('ADR-90 — a variation applied under M3-B1 (applied pair stored, no scope pair): the SCOPE pair alone and the full Apply payload are both REFUSED from every client; once the backend has written it, a repeat and a rewrite are refused and nothing else moves', async () => {
    for (const user of FINANCIAL) {
      const id = `b1_${user.uid}`
      await seed(id, 'approved', USERS.admin, { commitmentAppliedAt: Timestamp.now(), commitmentAppliedBy: USERS.qs.uid }, { base: linkedBase(USERS.admin) })
      const before = await readVar(id)
      // The full legacy Apply payload rewrites the applied pair → refused.
      await assertFails(updateDoc(varRef(ctx(user), id), applyWrite(user)))
      await assertFails(updateDoc(varRef(ctx(user), id), scopeWrite(user)))
      expect(await readVar(id)).toEqual(before)
      await serverUpdate(id, scopeWrite(user))
      const after = await readVar(id)
      expect(after.scopeCommittedBy).toBe(user.uid)
      expect(after.commitmentAppliedBy).toBe(USERS.qs.uid)
      expect(after.commitmentAppliedAt.isEqual(before.commitmentAppliedAt)).toBe(true)
      expect(after.revision).toBe(2)
      for (const k of ['status', 'lineItems', 'approvedSubtotal', 'approvedGst', 'approvedTotal', 'approvedBy', 'poId', 'poNumber']) {
        expect(after[k], k).toEqual(before[k])
      }
      for (const revision of [3, 2, 1]) {
        await assertFails(updateDoc(varRef(ctx(USERS.admin), id), scopeWrite(USERS.admin, { revision })))
      }
    }
  })

  it('ADR-90 — a never-applied approved variation: BOTH pairs in one write (the legacy Apply) is REFUSED from every client; once the backend has written them neither pair can be written again', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await updateRefused('v1', (user) => applyWrite(user))
    await serverUpdate('v1', applyWrite(USERS.pm))
    const v = await readVar('v1')
    expect(v.commitmentAppliedBy).toBe(USERS.pm.uid)
    expect(v.scopeCommittedBy).toBe(USERS.pm.uid)
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), applyWrite(USERS.admin, { revision: 3 })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), scopeWrite(USERS.admin, { revision: 3 })))
    await assertFails(updateDoc(varRef(ctx(USERS.admin), 'v1'), { ...applied(USERS.admin), revision: 3, ...stamps(USERS.admin) }))
  })

  it('an EMPTY stamp write (revision + audit only), a forged scope actor or clock, a cancelled PO, a non-approved status and a non-financial role are all refused', async () => {
    await seed('v1', 'approved', USERS.admin, { commitmentAppliedAt: Timestamp.now(), commitmentAppliedBy: USERS.qs.uid }, { base: linkedBase(USERS.admin) })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(varRef(db, 'v1'), { revision: 2, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(varRef(db, 'v1'), scopeWrite(USERS.admin, { scopeCommittedBy: USERS.pm.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(varRef(db, 'v1'), scopeWrite(USERS.admin, { scopeCommittedAt: clock() })))
    }
    await assertFails(updateDoc(varRef(db, 'v1'), scopeWrite(USERS.admin, { approvedSubtotal: 1 })))
    await setPoStatus(PO.sent, 'cancelled')
    await assertFails(updateDoc(varRef(db, 'v1'), scopeWrite(USERS.admin)))
    await setPoStatus(PO.sent, 'sent')
    for (const user of [...NON_MEMBERS, USERS.other]) {
      await assertFails(updateDoc(varRef(ctx(user), 'v1'), scopeWrite(user)))
    }
    await seed('s', 'submitted', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await assertFails(updateDoc(varRef(db, 's'), scopeWrite(USERS.admin)))
    expect((await readVar('v1'))).not.toHaveProperty('scopeCommittedAt')
  })

  it('ADR-90 — the write the app’s apply used to make for a MISSING scope pair (positive new scope present) is REFUSED from every client, and a fully stamped copy cannot be touched either', async () => {
    const newScopeLines = [line(900, { poLineIndex: 0 }), line(400, { poLineIndex: null, costCodeId: 'cc2', costCodeName: '05-200 — Steel' })]
    await seed('b1', 'approved', USERS.admin, { commitmentAppliedAt: Timestamp.now(), commitmentAppliedBy: USERS.qs.uid }, { base: poLinked(USERS.admin, PO.sent, { lineItems: newScopeLines }) })
    await updateRefused('b1', (user) => scopeWrite(user))
    expect(await readVar('b1')).not.toHaveProperty('scopeCommittedBy')
    await serverUpdate('b1', scopeWrite(USERS.pm))
    const v = await readVar('b1')
    expect(v.scopeCommittedBy).toBe(USERS.pm.uid)
    expect(v.commitmentAppliedBy).toBe(USERS.qs.uid)
    expect(v.revision).toBe(2)
    await updateRefused('b1', (user) => scopeWrite(user, { revision: 3 }))
    await updateRefused('b1', (user) => applyWrite(user, { revision: 3 }))
  })
})

describe('ADR-62 — NOT enforced by rules (documented ceiling)', () => {
  it('the stamps say nothing about the LINES: a stored applied variation whose poLineIndex is out of range or whose cost code mismatches is classified by the client as an exception — ADR-90: a client can no longer write such an approval (REFUSED from every client)', async () => {
    const badLines = [line(900, { poLineIndex: 7 }), line(100, { poLineIndex: 0, costCodeId: 'cc9', costCodeName: 'Wrong' })]
    await seed('v1', 'submitted', USERS.admin, {}, { base: poLinked(USERS.admin, PO.sent, { lineItems: badLines }) })
    const approval = (user) => approveWrite(user, { amounts: [900, 100], lines: badLines, assessmentNotes: '', ...bothPairs(user) })
    await updateRefused('v1', approval)
    await serverUpdate('v1', approval(USERS.admin))
    const v = await readVar('v1')
    const adj = appliedSupplierVariationAdjustments([v], [await readPo(PO.sent)])
    expect(adj.byPoLine).toEqual({})
    expect(adj.exceptions.map(e => e.issue).sort()).toEqual(['cost_code_mismatch', 'line_out_of_range'])
    expect(unappliedSupplierVariationsByCostCode([v], [await readPo(PO.sent)])).toEqual({ cc1: 900, cc9: 100 })
  })

  it('the PO is read at apply time only — cancelling it afterwards leaves the (backend-written) stamps in place (the client reports the exception)', async () => {
    await seed('v1', 'approved', USERS.admin, {}, { base: linkedBase(USERS.admin) })
    await serverUpdate('v1', applyWrite(USERS.admin))
    await setPoStatus(PO.sent, 'cancelled')
    const v = await readVar('v1')
    expect(isCommitmentApplied(v)).toBe(true)
    const adj = appliedSupplierVariationAdjustments([v], [await readPo(PO.sent)])
    expect(adj.byPoLine).toEqual({})
    expect(adj.exceptions[0].issue).toBe('po_not_committed')
    await setPoStatus(PO.sent, 'sent')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ADR-90 / ADR-91 — a BACKEND-CREATED variation carries `calcVersion: 2`. It is
// drafted, submitted, rejected and withdrawn under the same Rules as any other;
// and neither that key nor a commitment key can be added, changed or removed
// by any client write on any branch.
// ═════════════════════════════════════════════════════════════════════════════

describe('ADR-90/ADR-91 — calcVersion and the commitment keys are unwritable by any client', () => {
  const V2 = { calcVersion: 2 }
  const COMMITMENT_FORGERIES = (user) => [
    { calcVersion: 1 }, { calcVersion: 2 }, { calcVersion: 3 }, { calcVersion: null }, { calcVersion: '2' },
    { commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: user.uid },
    { commitmentAppliedAt: serverTimestamp() }, { commitmentAppliedBy: user.uid },
    { commitmentAppliedAt: null, commitmentAppliedBy: null },
    { scopeCommittedAt: serverTimestamp(), scopeCommittedBy: user.uid },
    { scopeCommittedAt: serverTimestamp() }, { scopeCommittedBy: user.uid },
    { scopeCommittedAt: null, scopeCommittedBy: null },
  ]

  it('a version-2 draft submits, rejects and withdraws under the Rules for every financial role and keeps calcVersion 2 throughout; ADR-90 — its edit and its RFI link are REFUSED from every client (the backend’s edit is stored and then submitted)', async () => {
    for (const user of FINANCIAL) {
      const u = user.uid
      await seed(`e-${u}`, 'draft', USERS.admin, V2)
      await editRefused(`e-${u}`, (who) => draftEdit(who), { thenStoreAs: user })
      await editRefused(`e-${u}`, (who) => ({ ...link(RFIS.open), revision: 3, ...stamps(who) }), { thenStoreAs: user })
      await assertSucceeds(updateDoc(varRef(ctx(user), `e-${u}`), submitWrite(user, { revision: 4 })))
      expect(await readVar(`e-${u}`)).toMatchObject({ status: 'submitted', calcVersion: 2, revision: 4, submittedSubtotal: 1200, ...link(RFIS.open) })
      await assertSucceeds(updateDoc(varRef(ctx(user), `e-${u}`), rejectWrite(user, { revision: 5 })))
      expect(await readVar(`e-${u}`)).toMatchObject({ status: 'rejected', calcVersion: 2 })
      await seed(`w-${u}`, 'submitted', USERS.admin, V2)
      await assertSucceeds(updateDoc(varRef(ctx(user), `w-${u}`), withdrawWrite(user)))
      expect(await readVar(`w-${u}`)).toMatchObject({ status: 'withdrawn', calcVersion: 2 })
      await seed(`d-${u}`, 'draft', USERS.admin, V2, { base: poLinked(USERS.admin) })
      await assertSucceeds(updateDoc(varRef(ctx(user), `d-${u}`), withdrawWrite(user)))
      await assertSucceeds(getDoc(varRef(ctx(user), `d-${u}`)))
    }
  })

  it.each([['a legacy-shaped draft', {}], ['a version-2 draft', V2]])(
    'ADR-90 — a draft admits NO client content write: lineItems, each submitted header figure, title, description, reason, references, dates, notes and the originRfi triple are each REFUSED for every financial role — on %s',
    async (_name, extra) => {
      await seed('nc', 'draft', USERS.admin, extra)
      await seed('ncc', 'draft', USERS.admin, extra, { base: clientPayload(USERS.admin) })
      const before = await readVar('nc')
      const beforeClient = await readVar('ncc')
      const dbs = new Map(FINANCIAL.map(u => [u.uid, ctx(u)]))
      const CONTENT = [
        { lineItems: [line(1)] }, { lineItems: [...LINES, line(1)] }, { lineItems: [] },
        { submittedSubtotal: 801 }, { submittedGst: 101 }, { submittedTotal: 901 },
        { lineItems: [line(500)], submittedSubtotal: 500, submittedGst: 50, submittedTotal: 550 },
        { title: 'Retitled' }, { description: 'More' }, { reason: 'site_condition' },
        { supplierRef: 'Q-1' }, { clientRef: 'VO-1' },
        { identifiedDate: '2026-10-02' }, { responseDueDate: '2026-10-30' }, { effectiveDate: '2026-11-01' }, { submittedDate: '2026-10-11' },
        { notes: 'A note' }, { assessmentNotes: 'x' },
        link(RFIS.open), { originRfiId: RFIS.open.id }, { originRfiNumber: 'RFI-0001' }, { originRfiTitle: 'Forged' },
      ]
      for (const user of FINANCIAL) {
        for (const change of CONTENT) {
          // alone, and riding on a submit or a withdraw (a transition may carry no content)
          await assertFails(updateDoc(varRef(dbs.get(user.uid), 'nc'), { ...change, revision: 2, ...stamps(user) }))
          await assertFails(updateDoc(varRef(dbs.get(user.uid), 'ncc'), { ...change, revision: 2, ...stamps(user) }))
          if (!('submittedDate' in change)) await assertFails(updateDoc(varRef(dbs.get(user.uid), 'nc'), submitWrite(user, change)))
          await assertFails(updateDoc(varRef(dbs.get(user.uid), 'nc'), withdrawWrite(user, change)))
        }
        // a stamps-only write, and a whole-document replacement with one field changed
        await assertFails(updateDoc(varRef(dbs.get(user.uid), 'nc'), { revision: 2, ...stamps(user) }))
        const replacement = { ...before, title: 'Replaced', revision: 2, ...stamps(user) }
        delete replacement.id
        await assertFails(setDoc(varRef(dbs.get(user.uid), 'nc'), replacement))
      }
      expect(await readVar('nc')).toEqual(before)
      expect(await readVar('ncc')).toEqual(beforeClient)
      // …while the content-free submit still passes on the untouched draft.
      await assertSucceeds(updateDoc(varRef(dbs.get(USERS.qs.uid), 'nc'), submitWrite(USERS.qs)))
    }, 120000)

  it('a version-2 variation cannot be created, approved or applied by a client either — REFUSED from every client', async () => {
    await createRefused('c2', (user) => payload(user, V2))
    await createRefused('c2p', (user) => poLinked(user, PO.sent, V2))
    await seed('a2', 'submitted', USERS.admin, V2)
    await updateRefused('a2', (user) => approveWrite(user))
    await seed('a2p', 'submitted', USERS.admin, V2, { base: linkedBase(USERS.admin) })
    await updateRefused('a2p', (user) => approveApplied(user))
    await seed('ap2', 'approved', USERS.admin, V2, { base: linkedBase(USERS.admin) })
    await updateRefused('ap2', (user) => applyWrite(user))
  })

  // One test per stored shape. QS (the widest-reaching non-approver role) tries
  // every forgery on every branch the status has; admin and PM try each forgery
  // alone. One Firestore handle per user per test.
  it.each([['a legacy-shaped document (no calcVersion key)', {}], ['a version-1 document', { calcVersion: 1 }], ['a version-2 document', V2]])(
    'calcVersion and the commitment keys cannot be ADDED, CHANGED or REMOVED on any branch — alone, or riding on a draft edit, submit, reject or withdraw — on %s',
    async (_name, extra) => {
      const alone = (user, x) => ({ revision: 2, ...stamps(user), ...x })
      const dbs = new Map(FINANCIAL.map(u => [u.uid, ctx(u)]))
      for (const [status, rides] of [
        ['draft', [draftEdit, submitWrite, withdrawWrite]],
        ['submitted', [rejectWrite, withdrawWrite]],
        ['approved', []], ['rejected', []], ['withdrawn', []],
      ]) {
        const id = `k-${status}`
        await seed(id, status, USERS.admin, extra, { base: linkedBase(USERS.admin) })
        const before = await readVar(id)
        for (const user of FINANCIAL) {
          const writes = user === USERS.qs ? [alone, ...rides] : [alone]
          for (const forged of COMMITMENT_FORGERIES(user)) {
            // re-sending the stored calcVersion unchanged is not a change — skip that single no-op
            if ('calcVersion' in forged && forged.calcVersion === before.calcVersion) continue
            for (const write of writes) {
              await assertFails(updateDoc(varRef(dbs.get(user.uid), id), write(user, forged)))
            }
          }
        }
        expect(await readVar(id), id).toEqual(before)
      }
    }, 120000)

  it('a stored commitment pair cannot be changed or stripped, and a whole-document replacement cannot smuggle calcVersion or a pair in', async () => {
    await seed('st', 'approved', USERS.admin, { ...V2, commitmentAppliedAt: Timestamp.now(), commitmentAppliedBy: USERS.qs.uid, scopeCommittedAt: Timestamp.now(), scopeCommittedBy: USERS.qs.uid }, { base: linkedBase(USERS.admin) })
    const { id: _id, ...stored } = await readVar('st')   // eslint-disable-line no-unused-vars
    for (const user of FINANCIAL) {
      for (const forged of [
        { commitmentAppliedBy: user.uid }, { commitmentAppliedAt: serverTimestamp() }, { commitmentAppliedAt: null, commitmentAppliedBy: null },
        { scopeCommittedBy: user.uid }, { scopeCommittedAt: serverTimestamp() }, { scopeCommittedAt: null, scopeCommittedBy: null },
        { calcVersion: 1 }, { calcVersion: null },
      ]) {
        await assertFails(updateDoc(varRef(ctx(user), 'st'), { ...forged, revision: 2, ...stamps(user) }))
        await assertFails(setDoc(varRef(ctx(user), 'st'), { ...stored, ...forged, revision: 2, ...stamps(user) }))
      }
      // …nor by dropping the keys in a replacement
      const { calcVersion: _c, commitmentAppliedAt: _a, commitmentAppliedBy: _b, ...stripped } = stored   // eslint-disable-line no-unused-vars
      await assertFails(setDoc(varRef(ctx(user), 'st'), { ...stripped, revision: 2, ...stamps(user) }))
    }
    expect((await readVar('st'))).toMatchObject({ calcVersion: 2, commitmentAppliedBy: USERS.qs.uid, scopeCommittedBy: USERS.qs.uid, revision: 1 })
    // a draft replaced whole, with the key added
    await seed('dr', 'draft')
    const { id: _i2, ...draft } = await readVar('dr')   // eslint-disable-line no-unused-vars
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'dr'), { ...draft, calcVersion: 2, revision: 2, ...stamps(USERS.qs) }))
    await assertFails(setDoc(varRef(ctx(USERS.qs), 'dr'), { ...draft, commitmentAppliedAt: serverTimestamp(), commitmentAppliedBy: USERS.qs.uid, revision: 2, ...stamps(USERS.qs) }))
    expect(await readVar('dr')).not.toHaveProperty('calcVersion')
  })
})

// ── ADR-90 — the variation number counters ───────────────────────────────────
//
// `companies/{c}/counters/variationsClient` and `…/variationsSupplier` are read
// and advanced ONLY by the trusted backend (createVariation). A client could
// previously set either to any value (Deferred Control 6): roll it back to
// reuse numbers, push it out of range, or store a non-number that refuses the
// next create. No client reads or writes them now. Every OTHER counter id keeps
// exactly the behaviour it had — the client transactions that number purchase
// orders, claims, invoices, receipts and the rest still depend on it (DC6 stays
// open for them). Numbering itself: tests/functions/variations.test.js.
describe('ADR-90 — the variation counters are backend-only', () => {
  const counter = (db, id, companyId = COMPANY_A) => doc(db, `companies/${companyId}/counters`, id)
  const seedCounter = async (id, data, companyId = COMPANY_A) => {
    await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(counter(c.firestore(), id, companyId), data) })
  }
  const readCounter = async (id, companyId = COMPANY_A) => {
    let data
    await testEnv.withSecurityRulesDisabled(async (c) => { const s = await getDoc(counter(c.firestore(), id, companyId)); data = s.exists() ? s.data() : undefined })
    return data
  }
  const VARIATION_COUNTERS = ['variationsClient', 'variationsSupplier']

  it.each(VARIATION_COUNTERS)('%s — a create is REFUSED from every client: no financial role can start the sequence, at 1 or anywhere else', async (id) => {
    for (const user of FINANCIAL) {
      for (const data of [{ next: 1 }, { next: 2 }, { next: 500 }, { next: 'x' }, {}]) {
        await assertFails(setDoc(counter(ctx(user), id), data))
        await assertFails(setDoc(counter(ctx(user), id), data, { merge: true }))
      }
    }
    expect(await readCounter(id)).toBeUndefined()
  })

  it.each(VARIATION_COUNTERS)('%s — a read, an advance, a rollback, a jump, an invalid value and a removal of the field are REFUSED from every client; the stored value does not move', async (id) => {
    await seedCounter(id, { next: 7 })
    for (const user of FINANCIAL) {
      await assertFails(getDoc(counter(ctx(user), id)))
      for (const next of [8, 1, 6, 7, 999999, 0, -1, 1.5, 'x', null]) {
        await assertFails(updateDoc(counter(ctx(user), id), { next }))
        await assertFails(setDoc(counter(ctx(user), id), { next }, { merge: true }))
        await assertFails(setDoc(counter(ctx(user), id), { next }))
      }
      await assertFails(setDoc(counter(ctx(user), id), {}))
      await assertFails(deleteDoc(counter(ctx(user), id)))
      // the old client transaction — read, then write next + 1 — fails as a whole
      const db = ctx(user)
      await assertFails(runTransaction(db, async (tx) => {
        const snap = await tx.get(counter(db, id))
        tx.set(counter(db, id), { next: (snap.exists() ? snap.data().next : 1) + 1 }, { merge: true })
      }))
    }
    expect(await readCounter(id)).toEqual({ next: 7 })
  })

  it('non-financial roles, another tenant, an orphan account and an anonymous caller are refused on the variation counters as on every other', async () => {
    for (const id of [...VARIATION_COUNTERS, 'purchaseOrders']) {
      await seedCounter(id, { next: 3 })
      for (const db of [...NON_MEMBERS.map(ctx), ctx(USERS.other), testEnv.authenticatedContext(ORPHAN_UID).firestore(), anon()]) {
        await assertFails(getDoc(counter(db, id)))
        await assertFails(setDoc(counter(db, id), { next: 4 }, { merge: true }))
      }
      expect(await readCounter(id)).toEqual({ next: 3 })
    }
  })

  it('EVERY OTHER counter is untouched: a financial role still reads, creates and advances it (and can still set it to anything — DC6 stays open there); delete stays blocked', async () => {
    // ADR-93 / ADR-94 closed the progressClaims, supplierInvoices and supplierPayments counters too
    // (tests/rules/{progressClaims,supplierInvoices,supplierPayments}.rules.test.js prove the refusals).
    for (const id of ['purchaseOrders', 'clientInvoices', 'clientReceipts', 'tenderPackages']) {
      for (const user of FINANCIAL) {
        const fresh = `${id}`
        await testEnv.withSecurityRulesDisabled(async (c) => { await deleteDoc(counter(c.firestore(), fresh)) })
        await assertSucceeds(setDoc(counter(ctx(user), fresh), { next: 2 }, { merge: true }))   // first number taken
        await assertSucceeds(getDoc(counter(ctx(user), fresh)))
        await assertSucceeds(updateDoc(counter(ctx(user), fresh), { next: 3 }))
        // the app's own numbering transaction, exactly as the hooks run it
        const db = ctx(user)
        await assertSucceeds(runTransaction(db, async (tx) => {
          const snap = await tx.get(counter(db, fresh))
          tx.set(counter(db, fresh), { next: snap.data().next + 1 }, { merge: true })
        }))
        expect(await readCounter(fresh)).toEqual({ next: 4 })
        // DC6, unchanged and still open for these registers: any value is accepted
        await assertSucceeds(updateDoc(counter(ctx(user), fresh), { next: 1 }))
        await assertFails(deleteDoc(counter(ctx(user), fresh)))
      }
    }
  })

  it('a name that merely resembles a variation counter is an ordinary counter — the restriction is the two exact ids, in the caller’s own company only', async () => {
    for (const id of ['variations', 'variationsclient', 'variationsClient2', 'VariationsSupplier', 'supplierVariations']) {
      await assertSucceeds(setDoc(counter(ctx(USERS.qs), id), { next: 2 }, { merge: true }))
    }
    // another company's admin on Company A's variation counter, and Company A's member on Company B's
    await seedCounter('variationsClient', { next: 5 })
    await seedCounter('variationsClient', { next: 9 }, COMPANY_B)
    await assertFails(getDoc(counter(ctx(USERS.other), 'variationsClient')))
    await assertFails(getDoc(counter(ctx(USERS.other), 'variationsClient', COMPANY_B)))      // its own company's is backend-only too
    await assertFails(setDoc(counter(ctx(USERS.admin), 'variationsClient', COMPANY_B), { next: 1 }))
    expect(await readCounter('variationsClient', COMPANY_B)).toEqual({ next: 9 })
  })
})
