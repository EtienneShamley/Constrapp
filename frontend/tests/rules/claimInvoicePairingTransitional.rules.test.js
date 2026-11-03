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
// still served. It differs from FINAL in the two ADR-68 marked lines only:
// the claim create's `hasAll` and the approve branch tolerate ABSENT link
// keys (the old bundle writes none). Everything else — above all the
// invoice-side PAIRING — is STRICT in Stage 1: an unpaired claim-sourced
// create is refused from the moment Stage 1 publishes (an old tab must refresh
// for that one action), a legacy claim fails closed, and cancel is paired.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.transitional.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const PROJECT_A = 'projectA'
const USERS = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
}
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

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set — run `npm run test:rules`.')
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const rules = readFileSync(RULES_PATH, 'utf8')
  if (!rules.includes('ADR-68 TRANSITIONAL')) throw new Error('firestore.transitional.rules does not carry the ADR-68 transitional marker')
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
    await setDoc(doc(db, `${base}/purchaseOrders`, PO.id), { ...PO, lineItems: [PO_LINE], subtotal: 10000, gst: 1000, total: 11000, currency: 'AUD', revision: 1 })
  })
})

describe('STAGE 1 — the pre-2A bundle’s claim writes keep working; the 2A bundle’s work too', () => {
  it('claim create WITHOUT the link keys (old bundle) and WITH them null (new bundle) are both ACCEPTED; a string or a stamp at create is still refused', async () => {
    const db = ctx(USERS.qs)
    await assertSucceeds(setDoc(claimRef(db, 'old'), claimCreate(USERS.qs)))
    await assertSucceeds(setDoc(claimRef(db, 'new'), claimCreate(USERS.qs, { newFormat: true })))
    await assertFails(setDoc(claimRef(db, 'forged'), claimCreate(USERS.qs, { newFormat: true, supplierInvoiceId: 'si_x' })))
    await assertFails(setDoc(claimRef(db, 'forged2'), claimCreate(USERS.qs, { supplierInvoiceLinkedBy: USERS.qs.uid })))
    expect('supplierInvoiceId' in (await readClaim('old'))).toBe(false)
    expect((await readClaim('new')).supplierInvoiceId).toBeNull()
  })

  it('approve on a legacy claim: the old payload (no keys) is ACCEPTED and leaves the claim LEGACY; the new payload initialises the keys; a string link is refused', async () => {
    await seedClaim('la', 'submitted', { legacy: true })
    await assertFails(updateDoc(claimRef(ctx(USERS.pm), 'la'), approveWrite(USERS.pm, { newFormat: true, supplierInvoiceId: 'si_x' })))
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'la'), approveWrite(USERS.pm)))
    expect('supplierInvoiceId' in (await readClaim('la'))).toBe(false)
    await seedClaim('lb', 'submitted', { legacy: true })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.pm), 'lb'), approveWrite(USERS.pm, { newFormat: true })))
    expect((await readClaim('lb')).supplierInvoiceId).toBeNull()
  })
})

describe('STAGE 1 — the invoice-side pairing is STRICT', () => {
  it('an UNPAIRED claim-sourced create (the old bundle’s write) is REFUSED against a new-format claim; the paired create is accepted', async () => {
    await seedClaim('cl', 'approved')
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'si_unpaired'), invoicePayload(USERS.qs, 'cl')))
    await assertSucceeds(pairedCreate(USERS.qs, 'si_paired', 'cl'))
    expect((await readClaim('cl')).supplierInvoiceId).toBe('si_paired')
    // …and a second one is refused: the invariant holds in Stage 1 too.
    await assertFails(pairedCreate(USERS.pm, 'si_dup', 'cl', 4))
    await assertFails(setDoc(invRef(ctx(USERS.pm), 'si_dup2'), invoicePayload(USERS.pm, 'cl')))
  })

  it('a LEGACY approved claim fails closed in Stage 1 as in FINAL; reconciling its existing active invoice works; an absent key is never set to null', async () => {
    await seedClaim('legacy', 'approved', { legacy: true })
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'si_x'), invoicePayload(USERS.qs, 'legacy')))
    await assertFails(pairedCreate(USERS.qs, 'si_y', 'legacy'))
    await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'legacy'), unlinkWrite(USERS.admin, 3)))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(invRef(c.firestore(), 'si_old'), { ...invoicePayload(USERS.admin, 'legacy'), status: 'posted', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), approvedAt: Timestamp.now(), approvedBy: 'u_admin', postedAt: Timestamp.now(), postedBy: 'u_admin' })
    })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.admin), 'legacy'), linkWrite(USERS.admin, 'si_old')))
    expect((await readClaim('legacy')).supplierInvoiceId).toBe('si_old')
  })

  it('cancel is paired in Stage 1: a linked draft cancels only together with its unlink', async () => {
    await seedClaim('cl', 'approved')
    await assertSucceeds(pairedCreate(USERS.qs, 'si1', 'cl'))
    const db = ctx(USERS.qs)
    await assertFails(updateDoc(invRef(db, 'si1'), cancelWrite(USERS.qs)))
    const batch = writeBatch(db)
    batch.update(invRef(db, 'si1'), cancelWrite(USERS.qs))
    batch.update(claimRef(db, 'cl'), unlinkWrite(USERS.qs))
    await assertSucceeds(batch.commit())
    expect((await readClaim('cl')).supplierInvoiceId).toBeNull()
  })
})
