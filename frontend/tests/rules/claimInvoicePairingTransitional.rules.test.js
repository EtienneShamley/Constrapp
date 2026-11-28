import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore'
import { invoiceTotals, gstForLine } from '../../src/lib/supplierInvoices'
import { claimTotals, buildClaimLine } from '../../src/lib/progressClaims'

// ── SHIELD 2A (ADR-68) — the STAGE-1 TRANSITIONAL ruleset ────────────────────
//
// `firestore.transitional.rules` is deployed FIRST, while the pre-2A bundle is
// still served. It used to differ from FINAL in the two ADR-68 marked lines:
// the claim create's `hasAll` and the approve branch tolerated ABSENT link
// keys (the old bundle wrote none), while the invoice-side PAIRING was STRICT.
//
// ⚠️ ADR-93 (Phase 2 step 3, trusted supplier finance). Claims are CREATED,
// EDITED, APPROVED and REJECTED — and paired with their supplier invoice —
// ONLY by the trusted backend; supplier invoices admit NO client write. The
// two ADR-68 transitional lines are RETIRED: the transitional file is
// regenerated from firestore.rules and its claim / invoice blocks are now
// IDENTICAL to the FINAL file. Every Stage-1 TOLERANCE this suite used to
// prove (an old-bundle create or approve with no link keys being ACCEPTED,
// a paired create / reconcile / cancel+unlink being ACCEPTED) is therefore
// now a REFUSAL for every financial role with every document unchanged; the
// denials it proved are kept. The one client claim write left — the
// content-free SUBMIT — is proven here too. The supported replacements are
// proven in tests/functions (supplier finance).
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.transitional.rules')

const PROJECT_ID = 'demo-constrap-test'
const COMPANY_A = 'companyA'
const PROJECT_A = 'projectA'
const USERS = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
}
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const PO = { id: 'poSent', poNumber: 'PO-0001', status: 'sent', supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd' }
const PO_LINE = { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 1, unit: 'ls', unitPrice: 10000, lineTotal: 10000 }
const LINK_KEYS = ['supplierInvoiceId', 'supplierInvoiceLinkedAt', 'supplierInvoiceLinkedBy']

let testEnv
const base = `companies/${COMPANY_A}/projects/${PROJECT_A}`
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const claimRef = (db, id) => doc(db, `${base}/progressClaims`, id)
const invRef   = (db, id) => doc(db, `${base}/supplierInvoices`, id)
const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })

// A DRAFT claim create, as the PRE-2A bundle writes it (no link key) — `newFormat`
// adds the three keys as the 2A bundle does.
function claimCreate(user, { newFormat = false, ...over } = {}) {
  const lines = [buildClaimLine(PO_LINE, { poLineIndex: 0, previouslyApproved: 0, claimedToDate: 9000 })]
  const t = claimTotals([9000], 1000)
  return {
    claimNumber: 'PC-0001', status: 'draft', poId: PO.id, poNumber: PO.poNumber, supplierName: PO.supplierName, supplierId: PO.supplierId,
    claimRef: 'S-1', periodEnding: '2026-08-31', variationId: null, variationLineCount: 0,
    lineItems: lines, retention: t.retention, claimedSubtotal: t.subtotal, claimedGst: t.gst, claimedTotal: t.total,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null, notes: '', assessmentNotes: '', currency: 'AUD', revision: 1,
    submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
    ...(newFormat ? { supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null } : {}),
    externalRefs: {}, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  }
}
async function seedClaim(id, status, { legacy = false, ...over } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    const d = { ...claimCreate(USERS.admin, { newFormat: true }), createdAt: now, updatedAt: now }
    const t = claimTotals([9000], 1000)
    if (status === 'submitted') Object.assign(d, { status, submittedAt: now, submittedBy: 'u_admin' })
    if (status === 'approved') Object.assign(d, {
      status, submittedAt: now, submittedBy: 'u_admin', approvedAt: now, approvedBy: 'u_admin', revision: 2,
      lineItems: d.lineItems.map(li => ({ ...li, approvedThisPeriod: 9000 })), approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
    })
    Object.assign(d, over)
    if (legacy) for (const k of LINK_KEYS) delete d[k]
    await setDoc(claimRef(c.firestore(), id), d)
  })
}
// The approve write, in the pre-2A shape (`newFormat: false`) and the 2A shape.
function approveWrite(user, { newFormat = false, revision = 2, ...extra } = {}) {
  const t = claimTotals([9000], 1000)
  const lines = [buildClaimLine(PO_LINE, { poLineIndex: 0, previouslyApproved: 0, claimedToDate: 9000 })].map(li => ({ ...li, approvedThisPeriod: 9000 }))
  return {
    status: 'approved', lineItems: lines, approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total, assessmentNotes: '',
    approvedAt: serverTimestamp(), approvedBy: user.uid, revision, ...stamps(user),
    ...(newFormat ? { supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null } : {}),
    ...extra,
  }
}
const INV_LINES = [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 9000, taxCode: 'gst', gstAmount: gstForLine(9000, 'gst') }]
function invoicePayload(user, claimId, over = {}) {
  const totals = invoiceTotals(INV_LINES, 1000)
  return {
    invoiceNumber: 'SI-0005', supplierInvoiceNumber: 'INV-1', status: 'draft', docType: 'invoice', source: 'progress_claim',
    supplierId: PO.supplierId, supplierName: PO.supplierName, poId: PO.id, poNumber: PO.poNumber, progressClaimId: claimId, claimNumber: 'PC-0001', variationLineCount: 0,
    invoiceDate: '2026-11-03', receivedDate: '', dueDate: '', paymentTerms: null, lineItems: INV_LINES, ...totals, currency: 'AUD', revision: 1, notes: '',
    approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
    paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid, ...over,
  }
}
const linkWrite = (user, invoiceId, revision = 3) => ({ supplierInvoiceId: invoiceId, supplierInvoiceLinkedAt: serverTimestamp(), supplierInvoiceLinkedBy: user.uid, revision, ...stamps(user) })
const unlinkWrite = (user, revision = 4) => ({ supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, revision, ...stamps(user) })
const cancelWrite = (user) => ({ status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: user.uid, ...stamps(user) })
function pairedCreate(user, invoiceId, claimId, revision = 3) {
  const db = ctx(user)
  const batch = writeBatch(db)
  batch.set(invRef(db, invoiceId), invoicePayload(user, claimId))
  batch.update(claimRef(db, claimId), linkWrite(user, invoiceId, revision))
  return batch.commit()
}
async function readClaim(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(claimRef(c.firestore(), id))).data() })
  return data
}
async function readInv(id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(invRef(c.firestore(), id))).data() })
  return data
}
// What the TRUSTED BACKEND stores, written with rules disabled.
async function serverWrite(fn) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await fn(c.firestore()) })
}
// ADR-93 — `attempt(user)` is REFUSED for EVERY financial role and none of the
// named claims / invoices moves (an absent one stays absent).
async function refusedForAll(attempt, { claims = [], invoices = [] } = {}) {
  const before = { c: await Promise.all(claims.map(readClaim)), i: await Promise.all(invoices.map(readInv)) }
  for (const user of FINANCIAL) await assertFails(attempt(user))
  expect(await Promise.all(claims.map(readClaim))).toEqual(before.c)
  expect(await Promise.all(invoices.map(readInv))).toEqual(before.i)
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set — run `npm run test:rules`.')
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const rules = readFileSync(RULES_PATH, 'utf8')
  if (!rules.includes('STAGE-1 TRANSITIONAL RULESET')) throw new Error('firestore.transitional.rules is not the Stage-1 transitional ruleset')
  // ADR-93: the two ADR-68 transitional lines are retired — none may remain.
  if (rules.includes('ADR-68 TRANSITIONAL')) throw new Error('firestore.transitional.rules still carries an ADR-68 transitional line')
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
    await setDoc(doc(db, `${base}/purchaseOrders`, PO.id), { ...PO, lineItems: [PO_LINE], subtotal: 10000, gst: 1000, total: 11000, currency: 'AUD', revision: 1 })
  })
})

describe('STAGE 1 — ADR-93: the claim block is the FINAL one (the ADR-68 tolerances are retired)', () => {
  it('ADR-93 — a claim create WITHOUT the link keys (old bundle) and WITH them null (new bundle) are both REFUSED for every financial role; a string or a stamp at create is still refused; nothing is stored', async () => {
    const db = ctx(USERS.qs)
    await refusedForAll((user) => setDoc(claimRef(ctx(user), 'old'), claimCreate(user)), { claims: ['old'] })
    await refusedForAll((user) => setDoc(claimRef(ctx(user), 'new'), claimCreate(user, { newFormat: true })), { claims: ['new'] })
    await assertFails(setDoc(claimRef(db, 'forged'), claimCreate(USERS.qs, { newFormat: true, supplierInvoiceId: 'si_x' })))
    await assertFails(setDoc(claimRef(db, 'forged2'), claimCreate(USERS.qs, { supplierInvoiceLinkedBy: USERS.qs.uid })))
    for (const id of ['old', 'new', 'forged', 'forged2']) expect(await readClaim(id)).toBeUndefined()
  })

  it('ADR-93 — approve on a legacy claim: the old payload (no keys) and the new payload (keys null) are REFUSED for every financial role and the claim stays LEGACY; a string link is refused', async () => {
    await seedClaim('la', 'submitted', { legacy: true })
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'la'), approveWrite(USERS.pm, { newFormat: true, supplierInvoiceId: 'si_x' })))
    await refusedForAll((user) => updateDoc(claimRef(ctx(user), 'la'), approveWrite(user)), { claims: ['la'] })
    expect('supplierInvoiceId' in (await readClaim('la'))).toBe(false)
    await seedClaim('lb', 'submitted', { legacy: true })
    await refusedForAll((user) => updateDoc(claimRef(ctx(user), 'lb'), approveWrite(user, { newFormat: true })), { claims: ['lb'] })
    expect('supplierInvoiceId' in (await readClaim('lb'))).toBe(false)
  })

  it('the one client claim write left — the content-free SUBMIT — passes in Stage 1 as in FINAL, for a legacy and a new-format draft and every financial role', async () => {
    for (const user of FINANCIAL) {
      for (const legacy of [true, false]) {
        const id = `sub-${user.uid}-${legacy}`
        await seedClaim(id, 'draft', { legacy })
        await assertSucceeds(updateDoc(claimRef(ctx(user), id), { status: 'submitted', submittedAt: serverTimestamp(), submittedBy: user.uid, revision: 2, ...stamps(user) }))
        expect(await readClaim(id)).toMatchObject({ status: 'submitted', submittedBy: user.uid, revision: 2, updatedBy: user.uid })
      }
    }
  })
})

describe('STAGE 1 — ADR-93: the invoice-side pairing is backend-only (no client write)', () => {
  it('an UNPAIRED claim-sourced create (the old bundle’s write) is REFUSED; ADR-93 — the PAIRED create is REFUSED for every financial role, both documents unchanged; a second one is refused too', async () => {
    await seedClaim('cl', 'approved')
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'si_unpaired'), invoicePayload(USERS.qs, 'cl')))
    await refusedForAll((user) => pairedCreate(user, 'si_paired', 'cl'), { claims: ['cl'], invoices: ['si_paired'] })
    expect((await readClaim('cl')).supplierInvoiceId).toBeNull()
    // the backend pairs it; a second client create is refused (it always was).
    await serverWrite(async (db) => {
      await setDoc(invRef(db, 'si_paired'), { ...invoicePayload(USERS.qs, 'cl'), createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
      await updateDoc(claimRef(db, 'cl'), { supplierInvoiceId: 'si_paired', supplierInvoiceLinkedAt: Timestamp.now(), supplierInvoiceLinkedBy: USERS.qs.uid, revision: 3, updatedAt: Timestamp.now(), updatedBy: USERS.qs.uid })
    })
    await assertFails(pairedCreate(USERS.pm, 'si_dup', 'cl', 4))
    await assertFails(setDoc(invRef(ctx(USERS.pm), 'si_dup2'), invoicePayload(USERS.pm, 'cl')))
    expect((await readClaim('cl')).supplierInvoiceId).toBe('si_paired')
  })

  it('a LEGACY approved claim fails closed; ADR-93 — reconciling its existing active invoice is REFUSED for every financial role too; an absent key is never set', async () => {
    await seedClaim('legacy', 'approved', { legacy: true })
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'si_x'), invoicePayload(USERS.qs, 'legacy')))
    await assertFails(pairedCreate(USERS.qs, 'si_y', 'legacy'))
    await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'legacy'), unlinkWrite(USERS.admin, 3)))
    await serverWrite(async (db) => {
      await setDoc(invRef(db, 'si_old'), { ...invoicePayload(USERS.admin, 'legacy'), status: 'posted', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), approvedAt: Timestamp.now(), approvedBy: 'u_admin', postedAt: Timestamp.now(), postedBy: 'u_admin' })
    })
    await refusedForAll((user) => updateDoc(claimRef(ctx(user), 'legacy'), linkWrite(user, 'si_old')), { claims: ['legacy'], invoices: ['si_old'] })
    expect('supplierInvoiceId' in (await readClaim('legacy'))).toBe(false)
  })

  it('cancel: the unpaired cancel of a linked draft is refused; ADR-93 — the paired cancel + unlink is REFUSED for every financial role, both documents unchanged', async () => {
    await seedClaim('cl', 'approved', { supplierInvoiceId: 'si1', supplierInvoiceLinkedAt: Timestamp.now(), supplierInvoiceLinkedBy: USERS.qs.uid, revision: 3 })
    await serverWrite(async (db) => {
      await setDoc(invRef(db, 'si1'), { ...invoicePayload(USERS.qs, 'cl'), createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    })
    await assertFails(updateDoc(invRef(ctx(USERS.qs), 'si1'), cancelWrite(USERS.qs)))
    await refusedForAll((user) => {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(invRef(db, 'si1'), cancelWrite(user))
      batch.update(claimRef(db, 'cl'), unlinkWrite(user))
      return batch.commit()
    }, { claims: ['cl'], invoices: ['si1'] })
    expect((await readClaim('cl')).supplierInvoiceId).toBe('si1')
    expect((await readInv('si1')).status).toBe('draft')
  })
})
