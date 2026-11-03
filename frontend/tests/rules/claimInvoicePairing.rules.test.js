import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import {
  doc, getDoc, setDoc, updateDoc, writeBatch, runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { invoiceTotals, gstForLine, formatSupplierInvoiceNumber } from '../../src/lib/supplierInvoices'
import { claimTotals } from '../../src/lib/progressClaims'
import {
  runCreateSupplierInvoice, runCancelSupplierInvoice, runLinkExistingInvoice, SupplierInvoiceWriteError, SI_WRITE_ERROR,
} from '../../src/lib/supplierInvoiceActions'

// ── SHIELD 2A (ADR-68) — claim ↔ supplier-invoice SOURCE PAIRING, FINAL rules ─
//
// One approved progress claim reserves at most ONE active (draft / approved /
// posted) claim-sourced supplier invoice. The reservation is the claim's
// `supplierInvoiceId` backlink, written in the SAME commit as the invoice and
// cleared in the SAME commit as its cancellation; the rules pair the halves
// through getAfter() so a direct-SDK caller can create neither an unpaired
// claim-sourced invoice nor a dangling link. A LEGACY claim (no link KEY) is
// never invoiceable until branch (g) records its EXISTING active invoice —
// rules cannot prove that no invoice exists, so nothing sets an absent key to
// null. Every write below is a direct SDK call, exactly what a bypassing client
// would issue; the last block runs the app's own transactions.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'   // Company A's second project — wrong-project refs
const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]

const PO_SENT  = { id: 'poSent',  poNumber: 'PO-0001', status: 'sent', supplierId: 'contact1', supplierName: 'BuildCo Pty Ltd' }
const PO_OTHER = { id: 'poOther', poNumber: 'PO-0002', status: 'sent', supplierId: 'contact2', supplierName: 'Other Co' }
const PO_LINE  = { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', qty: 1, unit: 'ls', unitPrice: 10000, lineTotal: 10000 }

let testEnv
const base = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}`
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const claimRef   = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${base(c, p)}/progressClaims`, id)
const invRef     = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${base(c, p)}/supplierInvoices`, id)
const poRef      = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${base(c, p)}/purchaseOrders`, id)
const projectRef = (db, p = PROJECT_A, c = COMPANY_A) => doc(db, `companies/${c}/projects`, p)
const counterRef = (db, c = COMPANY_A) => doc(db, `companies/${c}/counters`, 'supplierInvoices')

// ── Fixtures ─────────────────────────────────────────────────────────────────

// An APPROVED claim as the 2A bundle leaves it: certified 9,000 with 1,000
// retention (claimTotals: net 8,000, GST 800, total 8,800), revision 2, link
// keys present and null. `legacy: true` strips the three link keys (the pre-2A
// shape); `over` is pasted on top.
const CLAIM_LINE = { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', poLineTotal: 10000, previouslyApproved: 0, claimedToDate: 9000, claimedThisPeriod: 9000, approvedThisPeriod: 9000 }
function claimDoc({ legacy = false, po = PO_SENT, ...over } = {}) {
  const now = Timestamp.now()
  const t = claimTotals([9000], 1000)
  const d = {
    claimNumber: 'PC-0001', status: 'approved', poId: po.id, poNumber: po.poNumber, supplierName: po.supplierName, supplierId: po.supplierId,
    claimRef: 'S-1', periodEnding: '2026-08-31', variationId: null, variationLineCount: 0,
    lineItems: [CLAIM_LINE], retention: 1000,
    claimedSubtotal: 9000, claimedGst: t.gst, claimedTotal: t.total,
    approvedSubtotal: t.subtotal, approvedGst: t.gst, approvedTotal: t.total,
    notes: '', assessmentNotes: 'Certified', currency: 'AUD', revision: 2,
    submittedAt: now, submittedBy: 'u_admin', approvedAt: now, approvedBy: 'u_admin', rejectedAt: null, rejectedBy: null, invoicedAt: null,
    supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null,
    externalRefs: {}, createdAt: now, createdBy: 'u_admin', updatedAt: now, updatedBy: 'u_admin',
    ...over,
  }
  if (legacy) for (const k of ['supplierInvoiceId', 'supplierInvoiceLinkedAt', 'supplierInvoiceLinkedBy']) delete d[k]
  return d
}
async function seedClaim(id, opts = {}, { companyId = COMPANY_A, projectId = PROJECT_A } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(claimRef(c.firestore(), id, companyId, projectId), claimDoc(opts))
  })
}

// The claim-sourced invoice exactly as the editor builds it from that claim:
// one line at the certified amount, GST per line, retention carried (payable
// GST 800 and payable total 8,800 reconcile to the claim).
const INV_LINES = [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 9000, taxCode: 'gst', gstAmount: gstForLine(9000, 'gst') }]
function invoicePayload(user, { claimId = 'cl', po = PO_SENT, lines = INV_LINES, retention = 1000, ...over } = {}) {
  const totals = invoiceTotals(lines, retention)
  return {
    invoiceNumber: 'SI-0005', supplierInvoiceNumber: 'INV-1', status: 'draft', docType: 'invoice', source: 'progress_claim',
    supplierId: po.supplierId, supplierName: po.supplierName, poId: po.id, poNumber: po.poNumber,
    progressClaimId: claimId, claimNumber: 'PC-0001', variationLineCount: 0,
    invoiceDate: '2026-11-03', receivedDate: '', dueDate: '', paymentTerms: null,
    lineItems: lines, ...totals, currency: 'AUD', revision: 1, notes: '',
    approvedAt: null, approvedBy: null, postedAt: null, postedBy: null, cancelledAt: null, cancelledBy: null,
    paidAt: null, adjustsInvoiceId: null, attachments: [], externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  }
}
const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })
// The claim LINK write (lib/supplierInvoiceActions.js → claimLinkUpdate) over the default seed (revision 2).
const linkWrite = (user, invoiceId, { revision = 3, ...extra } = {}) => ({
  supplierInvoiceId: invoiceId, supplierInvoiceLinkedAt: serverTimestamp(), supplierInvoiceLinkedBy: user.uid, revision, ...stamps(user), ...extra,
})
const unlinkWrite = (user, { revision = 4, ...extra } = {}) => ({
  supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, revision, ...stamps(user), ...extra,
})
const cancelWrite = (user, extra = {}) => ({ status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: user.uid, ...stamps(user), ...extra })
const approveWrite = (user) => ({ status: 'approved', approvedAt: serverTimestamp(), approvedBy: user.uid, ...stamps(user) })
const postWrite = (user) => ({ status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid, ...stamps(user) })

// The app's atomic CREATE: invoice + claim link in ONE batch.
function pairedCreate(user, { invoiceId = 'si1', claimId = 'cl', payload = invoicePayload(user, { claimId }), link = linkWrite(user, invoiceId), db = ctx(user) } = {}) {
  const batch = writeBatch(db)
  batch.set(invRef(db, invoiceId), payload)
  batch.update(claimRef(db, claimId), link)
  return batch.commit()
}
// The app's atomic CANCEL: invoice cancel + claim unlink in ONE batch.
function pairedCancel(user, { invoiceId = 'si1', claimId = 'cl', cancel = cancelWrite(user), unlink = unlinkWrite(user), db = ctx(user) } = {}) {
  const batch = writeBatch(db)
  batch.update(invRef(db, invoiceId), cancel)
  batch.update(claimRef(db, claimId), unlink)
  return batch.commit()
}

// Seeds an invoice directly, bypassing rules.
async function seedInvoice(id, status = 'draft', over = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const now = Timestamp.now()
    const lifecycle =
      status === 'approved'  ? { status, approvedAt: now, approvedBy: 'u_admin' } :
      status === 'posted'    ? { status, approvedAt: now, approvedBy: 'u_admin', postedAt: now, postedBy: 'u_admin' } :
      status === 'cancelled' ? { status, cancelledAt: now, cancelledBy: 'u_admin' } :
      { status: 'draft' }
    await setDoc(invRef(c.firestore(), id), { ...invoicePayload(USERS.admin), createdAt: now, updatedAt: now, ...lifecycle, ...over })
  })
}
async function read(refFn, id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(refFn(c.firestore(), id))).data() })
  return data
}
async function expectKind(promise, kind) {
  let caught
  try { await promise } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(SupplierInvoiceWriteError)
  expect(caught.kind).toBe(kind)
  return caught
}

const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set — run `npm run test:rules`.')
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host, port: Number(port) } })
})
afterAll(async () => { if (testEnv) await testEnv.cleanup() })
beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'AU', baseCurrency: 'AUD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    // Project A is deliberately UNLOCKED so the app's create engages the ADR-21 ratchet.
    await setDoc(projectRef(db), { name: 'Project A', currency: 'AUD', currencyLocked: false })
    await setDoc(projectRef(db, PROJECT_B), { name: 'Project B', currency: 'AUD', currencyLocked: true })
    await setDoc(projectRef(db, PROJECT_A, COMPANY_B), { name: 'B Project', currency: 'AUD' })
    for (const po of [PO_SENT, PO_OTHER]) {
      await setDoc(poRef(db, po.id), { ...po, lineItems: [PO_LINE], subtotal: 10000, gst: 1000, total: 11000, currency: 'AUD', revision: 1 })
    }
    await setDoc(poRef(db, PO_SENT.id, COMPANY_B), { ...PO_SENT, lineItems: [PO_LINE], subtotal: 10000, gst: 1000, total: 11000 })
    await setDoc(counterRef(db), { next: 5 })
  })
  await seedClaim('cl')
})

// ═════════════════════════════════════════════════════════════════════════════

describe('atomic pairing (getAfter) — the two halves land together or not at all', () => {
  it('invoice create + claim link succeed as ONE batch for every financial role; the link is stored with the actor and server time', async () => {
    for (const user of FINANCIAL) {
      await seedClaim('cl')
      await assertSucceeds(pairedCreate(user, { invoiceId: `si_${user.uid}` }))
      const cl = await read(claimRef, 'cl')
      expect(cl.supplierInvoiceId).toBe(`si_${user.uid}`)
      expect(cl.supplierInvoiceLinkedBy).toBe(user.uid)
      expect(cl.supplierInvoiceLinkedAt).toBeTruthy()
      expect(cl.revision).toBe(3)
      expect(cl.status).toBe('approved')
      expect(cl.approvedTotal).toBe(8800)   // certified money untouched
      expect((await read(invRef, `si_${user.uid}`)).progressClaimId).toBe('cl')
    }
  })

  it('an UNPAIRED claim-sourced invoice (no claim link in the write) is DENIED — the direct-SDK bypass is closed', async () => {
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'si1'), invoicePayload(USERS.qs)))
    expect(await read(invRef, 'si1')).toBeUndefined()
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
  })

  it('HOW the unpaired create is denied: PERMISSION_DENIED with the SAME diagnostic shape every denied create in this block has carried since ADR-40 (an evaluation error plus the engine’s ceiling notice for the update rule it then measures) — never a grant; a money-broken create prints the identical text, and the pre-2A ruleset printed it for every denied create too (probed on main)', async () => {
    let unpaired
    try { await setDoc(invRef(ctx(USERS.qs), 'si_u'), invoicePayload(USERS.qs)) } catch (e) { unpaired = e }
    expect(unpaired?.code).toBe('permission-denied')
    expect(String(unpaired?.message)).toMatch(/PERMISSION_DENIED/)
    expect(String(unpaired?.message)).toMatch(/false for 'create'/)
    let early
    try { await setDoc(invRef(ctx(USERS.qs), 'si_e'), invoicePayload(USERS.qs, { payableTotal: 1 })) } catch (e) { early = e }
    expect(early?.code).toBe('permission-denied')
    expect(String(early?.message)).toMatch(/false for 'create'/)
    // The two denials are reported identically — the pairing adds no new failure mode.
    expect(String(unpaired?.message).replace(/L\d+(:\d+)?/g, 'L')).toBe(String(early?.message).replace(/L\d+(:\d+)?/g, 'L'))
    expect(await read(invRef, 'si_u')).toBeUndefined()
    expect(await read(invRef, 'si_e')).toBeUndefined()
  })

  it('a claim link WITHOUT the invoice in the same write is DENIED; a link to an invoice created in the batch that cites ANOTHER claim is DENIED', async () => {
    await assertFails(updateDoc(claimRef(ctx(USERS.qs), 'cl'), linkWrite(USERS.qs, 'si_nowhere')))
    await seedClaim('cl2')
    // The batch creates si1 citing cl2 but links cl → both halves fail.
    await assertFails(pairedCreate(USERS.qs, { claimId: 'cl', payload: invoicePayload(USERS.qs, { claimId: 'cl2' }), link: linkWrite(USERS.qs, 'si1') }))
    expect(await read(invRef, 'si1')).toBeUndefined()
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
  })

  it('the link id and the invoice id must agree; a direct_po invoice can never be the pair; a forged link actor or clock is refused', async () => {
    await assertFails(pairedCreate(USERS.qs, { invoiceId: 'si1', link: linkWrite(USERS.qs, 'si_other') }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { source: 'direct_po', progressClaimId: null, claimNumber: null }) }))
    await assertFails(pairedCreate(USERS.qs, { link: linkWrite(USERS.qs, 'si1', { supplierInvoiceLinkedBy: USERS.pm.uid }) }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(pairedCreate(USERS.qs, { link: linkWrite(USERS.qs, 'si1', { supplierInvoiceLinkedAt: clock() }) }))
    }
    expect(await read(invRef, 'si1')).toBeUndefined()
  })

  it('both halves roll back when either is invalid, and the counter does not advance', async () => {
    const db = ctx(USERS.qs)
    await assertFails(runTransaction(db, async (tx) => {
      const counter = await tx.get(counterRef(db))
      tx.set(counterRef(db), { next: counter.data().next + 1 }, { merge: true })
      tx.set(invRef(db, 'si1'), invoicePayload(USERS.qs, { subtotal: 1 }))   // breaks the arithmetic
      tx.update(claimRef(db, 'cl'), linkWrite(USERS.qs, 'si1'))
    }))
    let counter
    await testEnv.withSecurityRulesDisabled(async (c) => { counter = (await getDoc(counterRef(c.firestore()))).data() })
    expect(counter).toEqual({ next: 5 })
    expect(await read(invRef, 'si1')).toBeUndefined()
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
  })
})

describe('the invoice side — what the paired claim must be', () => {
  it('a LEGACY claim (no link key) FAILS CLOSED — neither the paired nor the unpaired create is accepted', async () => {
    await seedClaim('legacy', { legacy: true })
    await assertFails(pairedCreate(USERS.qs, { claimId: 'legacy', payload: invoicePayload(USERS.qs, { claimId: 'legacy' }) }))
    await assertFails(setDoc(invRef(ctx(USERS.qs), 'si2'), invoicePayload(USERS.qs, { claimId: 'legacy' })))
    const cl = await read(claimRef, 'legacy')
    expect('supplierInvoiceId' in cl).toBe(false)
  })

  it('a claim that is submitted, draft or rejected is refused; a claim already LINKED is refused (the duplicate)', async () => {
    for (const status of ['submitted', 'draft', 'rejected']) {
      await seedClaim(`c_${status}`, { status })
      await assertFails(pairedCreate(USERS.qs, { claimId: `c_${status}`, payload: invoicePayload(USERS.qs, { claimId: `c_${status}` }) }))
    }
    await seedClaim('linked', { supplierInvoiceId: 'si_existing', supplierInvoiceLinkedAt: Timestamp.now(), supplierInvoiceLinkedBy: 'u_admin' })
    await assertFails(pairedCreate(USERS.qs, { claimId: 'linked', payload: invoicePayload(USERS.qs, { claimId: 'linked' }) }))
    expect((await read(claimRef, 'linked')).supplierInvoiceId).toBe('si_existing')
  })

  it('the invoice must carry the claim’s PO, supplier id, supplier name and claim number — each disagreement is refused', async () => {
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { poId: PO_OTHER.id, poNumber: PO_OTHER.poNumber }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { supplierId: 'contact9' }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { supplierId: null }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { supplierName: 'Someone Else' }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { claimNumber: 'PC-0002' }) }))
    // …and a trimmed name agrees with an untrimmed stored one (the hook trims).
    await seedClaim('padded', { supplierName: '  BuildCo Pty Ltd ' })
    await assertSucceeds(pairedCreate(USERS.qs, { claimId: 'padded', payload: invoicePayload(USERS.qs, { claimId: 'padded' }) }))
    // A pre-Contacts claim (supplierId null) pairs with an invoice carrying null too.
    await seedClaim('precontacts', { supplierId: null })
    await assertSucceeds(pairedCreate(USERS.qs, { invoiceId: 'si_pc', claimId: 'precontacts', payload: invoicePayload(USERS.qs, { claimId: 'precontacts', supplierId: null }) }))
  })

  it('the claim is resolved in THIS project and tenant: a claim of the same id in another project or company does not pair', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(claimRef(c.firestore(), 'elsewhere', COMPANY_A, PROJECT_B), claimDoc())
      await setDoc(claimRef(c.firestore(), 'elsewhere', COMPANY_B, PROJECT_A), claimDoc())
    })
    await assertFails(pairedCreate(USERS.qs, { claimId: 'elsewhere', payload: invoicePayload(USERS.qs, { claimId: 'elsewhere' }) }))
    // Linking the OTHER project's claim from a batch in project A: the claim write is a cross-project write
    // of a claim with no invoice created beside it → denied; nothing lands anywhere.
    const db = ctx(USERS.qs)
    const batch = writeBatch(db)
    batch.set(invRef(db, 'si_x'), invoicePayload(USERS.qs, { claimId: 'elsewhere' }))
    batch.update(claimRef(db, 'elsewhere', COMPANY_A, PROJECT_B), linkWrite(USERS.qs, 'si_x'))
    await assertFails(batch.commit())
    expect(await read(invRef, 'si_x')).toBeUndefined()
  })

  it('every other create invariant still applies to a paired invoice — the ADR-63 count guard, the money identities, the stamps', async () => {
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { variationLineCount: 1 }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { payableTotal: 8800.01 }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { status: 'approved' }) }))
    await assertFails(pairedCreate(USERS.qs, { payload: invoicePayload(USERS.qs, { createdBy: USERS.pm.uid }) }))
    expect(await read(invRef, 'si1')).toBeUndefined()
  })
})

describe('duplicate prevention — one active invoice per claim, by the rules', () => {
  it('after a paired create, a second paired create and a second unpaired create are both DENIED; the first invoice stands', async () => {
    await assertSucceeds(pairedCreate(USERS.qs, { invoiceId: 'si1' }))
    await assertFails(pairedCreate(USERS.pm, { invoiceId: 'si2', link: linkWrite(USERS.pm, 'si2', { revision: 4 }) }))
    await assertFails(setDoc(invRef(ctx(USERS.pm), 'si3'), invoicePayload(USERS.pm)))
    expect(await read(invRef, 'si2')).toBeUndefined()
    expect(await read(invRef, 'si3')).toBeUndefined()
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si1')
  })

  it('the reservation holds through approve and post — a posted invoice reserves the claim permanently', async () => {
    await assertSucceeds(pairedCreate(USERS.qs, { invoiceId: 'si1' }))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'si1'), approveWrite(USERS.qs)))
    await assertFails(pairedCreate(USERS.pm, { invoiceId: 'si2', link: linkWrite(USERS.pm, 'si2', { revision: 4 }) }))
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'si1'), postWrite(USERS.qs)))
    await assertFails(pairedCreate(USERS.pm, { invoiceId: 'si3', link: linkWrite(USERS.pm, 'si3', { revision: 4 }) }))
    // Nothing can release a posted invoice's link: no unlink alone, no cancel+unlink.
    await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'cl'), unlinkWrite(USERS.admin)))
    await assertFails(pairedCancel(USERS.admin))
    expect((await read(invRef, 'si1')).status).toBe('posted')
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si1')
  })
})

describe('the link keys move only through the three branches', () => {
  it('on an approved claim: link REPLACEMENT is refused, revision must be exactly +1, no other key may ride along, and an identical rewrite is refused', async () => {
    await seedClaim('linked', { supplierInvoiceId: 'si_a', supplierInvoiceLinkedAt: Timestamp.now(), supplierInvoiceLinkedBy: 'u_admin' })
    await seedInvoice('si_b', 'draft', { progressClaimId: 'linked' })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(claimRef(db, 'linked'), linkWrite(USERS.admin, 'si_b')))
    await assertFails(pairedCreate(USERS.admin, { invoiceId: 'si_c', claimId: 'linked', payload: invoicePayload(USERS.admin, { claimId: 'linked' }) }))
    await assertFails(pairedCreate(USERS.admin, { link: linkWrite(USERS.admin, 'si1', { revision: 2 }) }))
    await assertFails(pairedCreate(USERS.admin, { link: linkWrite(USERS.admin, 'si1', { revision: 4 }) }))
    await assertFails(pairedCreate(USERS.admin, { link: linkWrite(USERS.admin, 'si1', { notes: 'x' }) }))
    await assertFails(pairedCreate(USERS.admin, { link: linkWrite(USERS.admin, 'si1', { approvedTotal: 1 }) }))
    await assertFails(pairedCreate(USERS.admin, { link: linkWrite(USERS.admin, 'si1', { status: 'invoiced' }) }))
    await assertFails(updateDoc(claimRef(db, 'linked'), { supplierInvoiceId: 'si_a', revision: 3, ...stamps(USERS.admin) }))
    expect((await read(claimRef, 'linked')).supplierInvoiceId).toBe('si_a')
  })

  it('a draft, submitted or rejected claim cannot be linked even with a paired invoice; an absent key can never be set to null by any write', async () => {
    for (const status of ['draft', 'submitted', 'rejected']) {
      await seedClaim(`c_${status}`, { status })
      await assertFails(pairedCreate(USERS.qs, { claimId: `c_${status}`, payload: invoicePayload(USERS.qs, { claimId: `c_${status}` }) }))
    }
    await seedClaim('legacy', { legacy: true })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(claimRef(db, 'legacy'), unlinkWrite(USERS.admin, { revision: 3 })))
    await assertFails(updateDoc(claimRef(db, 'legacy'), { supplierInvoiceId: null, revision: 3, ...stamps(USERS.admin) }))
    await assertFails(updateDoc(claimRef(db, 'legacy'), { supplierInvoiceId: null, supplierInvoiceLinkedAt: null, supplierInvoiceLinkedBy: null, ...stamps(USERS.admin) }))
    expect('supplierInvoiceId' in (await read(claimRef, 'legacy'))).toBe(false)
  })
})

describe('cancellation releases the claim in the same commit; posted never', () => {
  it('a DRAFT and an APPROVED linked invoice: cancel + unlink in ONE batch, every financial role; the cancelled invoice keeps its identity', async () => {
    for (const user of FINANCIAL) {
      for (const status of ['draft', 'approved']) {
        await seedClaim('cl', { supplierInvoiceId: 'si1', supplierInvoiceLinkedAt: Timestamp.now(), supplierInvoiceLinkedBy: 'u_admin', revision: 3 })
        await seedInvoice('si1', status)
        await assertSucceeds(pairedCancel(user))
        const inv = await read(invRef, 'si1')
        expect(inv.status).toBe('cancelled')
        expect(inv.cancelledBy).toBe(user.uid)
        expect(inv.progressClaimId).toBe('cl')
        expect(inv.claimNumber).toBe('PC-0001')
        const cl = await read(claimRef, 'cl')
        expect(cl.supplierInvoiceId).toBeNull()
        expect(cl.supplierInvoiceLinkedBy).toBeNull()
        expect(cl.revision).toBe(4)
      }
    }
  })

  it('cancel WITHOUT the unlink is DENIED; unlink WITHOUT the cancel is DENIED; an unlink paired with the cancellation of a DIFFERENT invoice is DENIED', async () => {
    await seedClaim('cl', { supplierInvoiceId: 'si1', revision: 3 })
    await seedInvoice('si1', 'draft')
    await seedInvoice('si_other', 'draft', { progressClaimId: 'cl' })
    const db = ctx(USERS.qs)
    await assertFails(updateDoc(invRef(db, 'si1'), cancelWrite(USERS.qs)))
    await assertFails(updateDoc(claimRef(db, 'cl'), unlinkWrite(USERS.qs)))
    await assertFails(pairedCancel(USERS.qs, { invoiceId: 'si_other' }))
    expect((await read(invRef, 'si1')).status).toBe('draft')
    expect((await read(invRef, 'si_other')).status).toBe('draft')
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si1')
  })

  it('a POSTED linked invoice cannot be cancelled with or without the unlink, and cannot be unlinked', async () => {
    await seedClaim('cl', { supplierInvoiceId: 'si1', revision: 3 })
    await seedInvoice('si1', 'posted')
    await assertFails(pairedCancel(USERS.admin))
    await assertFails(updateDoc(invRef(ctx(USERS.admin), 'si1'), cancelWrite(USERS.admin)))
    await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'cl'), unlinkWrite(USERS.admin)))
    expect((await read(invRef, 'si1')).status).toBe('posted')
  })

  it('re-invoicing after a valid cancellation: a NEW paired create succeeds, the cancelled invoice is untouched, and the chain holds (cancel again, invoice again)', async () => {
    await assertSucceeds(pairedCreate(USERS.qs, { invoiceId: 'si1' }))
    await assertSucceeds(pairedCancel(USERS.qs))
    await assertSucceeds(pairedCreate(USERS.pm, { invoiceId: 'si2', link: linkWrite(USERS.pm, 'si2', { revision: 5 }) }))
    expect((await read(invRef, 'si1')).status).toBe('cancelled')
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si2')
    // The cancelled document cannot be reused or overwritten by a re-create.
    await assertFails(pairedCreate(USERS.pm, { invoiceId: 'si1', link: linkWrite(USERS.pm, 'si1', { revision: 6 }) }))
    await assertSucceeds(pairedCancel(USERS.pm, { invoiceId: 'si2', unlink: unlinkWrite(USERS.pm, { revision: 6 }) }))
    await assertSucceeds(pairedCreate(USERS.admin, { invoiceId: 'si3', link: linkWrite(USERS.admin, 'si3', { revision: 7 }) }))
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si3')
  })

  it('an invoice its claim does NOT link cancels ALONE, exactly as before — legacy claim, claim linked elsewhere, claim missing, legacy null claim reference', async () => {
    await seedClaim('legacy', { legacy: true })
    await seedInvoice('si_legacy', 'draft', { progressClaimId: 'legacy' })
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'si_legacy'), cancelWrite(USERS.qs)))
    expect('supplierInvoiceId' in (await read(claimRef, 'legacy'))).toBe(false)

    await seedClaim('cl', { supplierInvoiceId: 'si_other', revision: 3 })
    await seedInvoice('si_stray', 'approved')
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'si_stray'), cancelWrite(USERS.qs)))
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si_other')

    await seedInvoice('si_orphan', 'draft', { progressClaimId: 'claim_gone' })
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'si_orphan'), cancelWrite(USERS.qs)))

    await seedInvoice('si_null', 'draft', { progressClaimId: null, claimNumber: null })
    await assertSucceeds(updateDoc(invRef(ctx(USERS.qs), 'si_null'), cancelWrite(USERS.qs)))

    // …but such an invoice may NOT be paired with an unlink it has no right to.
    await seedInvoice('si_stray2', 'draft')
    await assertFails(pairedCancel(USERS.qs, { invoiceId: 'si_stray2' }))
  })

  it('a cancellation may still not smuggle a content change or a forged stamp, paired or not', async () => {
    await seedClaim('cl', { supplierInvoiceId: 'si1', revision: 3 })
    await seedInvoice('si1', 'draft')
    await assertFails(pairedCancel(USERS.qs, { cancel: cancelWrite(USERS.qs, { notes: 'x' }) }))
    await assertFails(pairedCancel(USERS.qs, { cancel: cancelWrite(USERS.qs, { cancelledBy: USERS.pm.uid }) }))
    await assertFails(pairedCancel(USERS.qs, { unlink: unlinkWrite(USERS.qs, { revision: 3 }) }))
    await assertFails(pairedCancel(USERS.qs, { unlink: unlinkWrite(USERS.qs, { assessmentNotes: 'x' }) }))
    expect((await read(invRef, 'si1')).status).toBe('draft')
  })
})

describe('RECONCILE (g) — a claim with no current link records an EXISTING active invoice of its own', () => {
  it('a LEGACY claim links its existing draft, approved or posted invoice (any financial role); the paired create is then refused — the reservation is enforced', async () => {
    for (const status of ['draft', 'approved', 'posted']) {
      for (const user of FINANCIAL) {
        await seedClaim('legacy', { legacy: true })
        await seedInvoice('si_old', status, { progressClaimId: 'legacy' })
        await assertSucceeds(updateDoc(claimRef(ctx(user), 'legacy'), linkWrite(user, 'si_old')))
        const cl = await read(claimRef, 'legacy')
        expect(cl.supplierInvoiceId).toBe('si_old')
        expect(cl.supplierInvoiceLinkedBy).toBe(user.uid)
        expect(cl.approvedTotal).toBe(8800)
        await assertFails(pairedCreate(user, { invoiceId: 'si_new', claimId: 'legacy', payload: invoicePayload(user, { claimId: 'legacy' }), link: linkWrite(user, 'si_new', { revision: 4 }) }))
      }
    }
  })

  it('a NEW-FORMAT null claim (an old tab’s Stage-1 invoice left it unlinked) reconciles the same way', async () => {
    await seedInvoice('si_old', 'draft')
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.qs), 'cl'), linkWrite(USERS.qs, 'si_old')))
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe('si_old')
  })

  it('refuses: a CANCELLED invoice (reserves nothing), a missing invoice, another claim’s invoice, another PO, another supplier, a direct_po invoice, and an invoice in another project', async () => {
    await seedClaim('legacy', { legacy: true })
    const db = ctx(USERS.admin)
    await seedInvoice('si_cancelled', 'cancelled', { progressClaimId: 'legacy' })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_cancelled')))
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_missing')))
    await seedInvoice('si_otherclaim', 'posted', { progressClaimId: 'cl' })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_otherclaim')))
    await seedInvoice('si_otherpo', 'posted', { progressClaimId: 'legacy', poId: PO_OTHER.id, poNumber: PO_OTHER.poNumber })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_otherpo')))
    await seedInvoice('si_othersupplier', 'posted', { progressClaimId: 'legacy', supplierId: 'contact9' })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_othersupplier')))
    await seedInvoice('si_direct', 'posted', { progressClaimId: 'legacy', source: 'direct_po' })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_direct')))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(invRef(c.firestore(), 'si_projB', COMPANY_A, PROJECT_B), { ...invoicePayload(USERS.admin, { claimId: 'legacy' }), createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_projB')))
    expect('supplierInvoiceId' in (await read(claimRef, 'legacy'))).toBe(false)
  })

  it('refuses a non-approved claim, a claim already linked, a forged actor or clock, a wrong revision, and any extra key', async () => {
    await seedInvoice('si_old', 'draft', { progressClaimId: 'legacy' })
    for (const status of ['submitted', 'rejected']) {
      await seedClaim('legacy', { legacy: true, status })
      await assertFails(updateDoc(claimRef(ctx(USERS.admin), 'legacy'), linkWrite(USERS.admin, 'si_old')))
    }
    await seedClaim('legacy', { legacy: true })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_old', { supplierInvoiceLinkedBy: USERS.qs.uid })))
    for (const clock of CLIENT_CLOCKS) await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_old', { supplierInvoiceLinkedAt: clock() })))
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_old', { revision: 2 })))
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_old', { notes: 'x' })))
    await assertSucceeds(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_old')))
    await seedInvoice('si_old2', 'draft', { progressClaimId: 'legacy' })
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_old2', { revision: 4 })))
  })

  it('EXISTING DUPLICATES: rules verify the ONE invoice named and cannot see its siblings — reconciling one of two active invoices is accepted; the other stays, listed by SHIELD, never repaired here', async () => {
    await seedClaim('legacy', { legacy: true })
    await seedInvoice('si_dup1', 'posted', { progressClaimId: 'legacy' })
    await seedInvoice('si_dup2', 'approved', { progressClaimId: 'legacy' })
    await assertSucceeds(updateDoc(claimRef(ctx(USERS.admin), 'legacy'), linkWrite(USERS.admin, 'si_dup1')))
    expect((await read(invRef, 'si_dup2')).status).toBe('approved')
    // From here the invariant is enforced through the link: no third invoice.
    await assertFails(pairedCreate(USERS.admin, { invoiceId: 'si_dup3', claimId: 'legacy', payload: invoicePayload(USERS.admin, { claimId: 'legacy' }), link: linkWrite(USERS.admin, 'si_dup3', { revision: 4 }) }))
  })

  it('a legacy claim with NO active invoice stays fail-closed: nothing a client can write makes it invoiceable', async () => {
    await seedClaim('legacy', { legacy: true })
    await seedInvoice('si_cancelled', 'cancelled', { progressClaimId: 'legacy' })
    const db = ctx(USERS.admin)
    await assertFails(updateDoc(claimRef(db, 'legacy'), linkWrite(USERS.admin, 'si_cancelled')))
    await assertFails(updateDoc(claimRef(db, 'legacy'), unlinkWrite(USERS.admin, { revision: 3 })))
    await assertFails(pairedCreate(USERS.admin, { claimId: 'legacy', payload: invoicePayload(USERS.admin, { claimId: 'legacy' }) }))
    expect('supplierInvoiceId' in (await read(claimRef, 'legacy'))).toBe(false)
  })
})

describe('roles and tenancy', () => {
  it('subcontractor, client, a Company B admin and an unauthenticated caller can neither pair, link, reconcile nor cancel', async () => {
    await seedInvoice('si_old', 'draft')
    for (const user of [USERS.sub, USERS.client, USERS.other]) {
      await assertFails(pairedCreate(user))
      await assertFails(updateDoc(claimRef(ctx(user), 'cl'), linkWrite(user, 'si_old')))
      await assertFails(pairedCancel(user, { invoiceId: 'si_old' }))
    }
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(pairedCreate(USERS.qs, { db: anon }))
    await assertFails(updateDoc(claimRef(anon, 'cl'), linkWrite(USERS.qs, 'si_old')))
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
  })

  it('a Company A admin cannot pair into Company B', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(claimRef(c.firestore(), 'clB', COMPANY_B, PROJECT_A), claimDoc()) })
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    batch.set(invRef(db, 'siB', COMPANY_B, PROJECT_A), invoicePayload(USERS.admin, { claimId: 'clB' }))
    batch.update(claimRef(db, 'clB', COMPANY_B, PROJECT_A), linkWrite(USERS.admin, 'siB'))
    await assertFails(batch.commit())
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// The app's own transactions (lib/supplierInvoiceActions.js) against the real
// rules — the full multi-document commit (counter + invoice + claim + project
// lock) inside the 20-call transaction budget and the 1000-expression ceiling.
// ═════════════════════════════════════════════════════════════════════════════

describe('runCreateSupplierInvoice — the app’s transaction against the real rules', () => {
  function create(user, { invoiceId = 'si_app', claimId = 'cl', seenClaim = claimDoc({ revision: 2 }), docOver = {} } = {}) {
    const db = ctx(user)
    const refs = { counterRef: counterRef(db), invoiceRef: invRef(db, invoiceId), claimRef: claimRef(db, claimId) }
    return runCreateSupplierInvoice({
      db, refs, uid: user.uid, runTransaction, serverTimestamp, formatNumber: formatSupplierInvoiceNumber,
      seenClaim: { id: claimId, ...seenClaim },
      document: {
        source: 'progress_claim', supplierId: PO_SENT.supplierId, supplierName: PO_SENT.supplierName, poId: PO_SENT.id, poNumber: PO_SENT.poNumber,
        progressClaimId: claimId, claimNumber: 'PC-0001', variationLineCount: 0,
        supplierInvoiceNumber: 'INV-APP', invoiceDate: '2026-11-03', receivedDate: '', dueDate: '', paymentTerms: null,
        lineItems: INV_LINES, retention: 1000, currency: 'AUD', notes: '', ...docOver,
      },
      // hooks/projectCurrencyLock.js → stageProjectCurrencyLock, inlined.
      stageLock: async (tx) => {
        const snap = await tx.get(projectRef(db))
        if (!snap.exists() || snap.data().currencyLocked === true) return () => {}
        return () => tx.update(projectRef(db), { currencyLocked: true })
      },
    })
  }

  it('creates once: counter 5 → 6, SI-0005 born draft citing the claim, the claim linked (revision 3), the project locked — every role, a QS included (the full 4-document commit evaluates inside the rules budgets)', async () => {
    for (const user of FINANCIAL) {
      await testEnv.withSecurityRulesDisabled(async (c) => {
        await setDoc(counterRef(c.firestore()), { next: 5 })
        await setDoc(projectRef(c.firestore()), { name: 'Project A', currency: 'AUD', currencyLocked: false })
      })
      await seedClaim('cl')
      const out = await create(user, { invoiceId: `si_${user.uid}` })
      expect(out).toEqual({ kind: null, invoiceId: `si_${user.uid}`, invoiceNumber: 'SI-0005' })
      const inv = await read(invRef, `si_${user.uid}`)
      expect(inv).toMatchObject({ status: 'draft', invoiceNumber: 'SI-0005', progressClaimId: 'cl', claimNumber: 'PC-0001', payableTotal: 8800, createdBy: user.uid })
      const cl = await read(claimRef, 'cl')
      expect(cl.supplierInvoiceId).toBe(`si_${user.uid}`)
      expect(cl.revision).toBe(3)
      let counter, project
      await testEnv.withSecurityRulesDisabled(async (c) => {
        counter = (await getDoc(counterRef(c.firestore()))).data()
        project = (await getDoc(projectRef(c.firestore()))).data()
      })
      expect(counter).toEqual({ next: 6 })
      expect(project.currencyLocked).toBe(true)
    }
  })

  it('a RETRY after success is ALREADY_INVOICED naming the linked invoice — nothing written, no number consumed', async () => {
    await create(USERS.qs)
    const err = await expectKind(create(USERS.qs, { invoiceId: 'si_retry' }), SI_WRITE_ERROR.ALREADY_INVOICED)
    expect(err.linkedInvoiceId).toBe('si_app')
    expect(await read(invRef, 'si_retry')).toBeUndefined()
    let counter
    await testEnv.withSecurityRulesDisabled(async (c) => { counter = (await getDoc(counterRef(c.firestore()))).data() })
    expect(counter).toEqual({ next: 6 })
  })

  it('TWO CONCURRENT creates produce exactly one invoice, one link and one counter step; the loser reports ALREADY_INVOICED or is refused by the rules', async () => {
    const results = await Promise.allSettled([
      create(USERS.qs, { invoiceId: 'si_race_a' }),
      create(USERS.pm, { invoiceId: 'si_race_b' }),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(SupplierInvoiceWriteError)
    expect([SI_WRITE_ERROR.ALREADY_INVOICED, SI_WRITE_ERROR.PERMISSION, SI_WRITE_ERROR.UNKNOWN]).toContain(rejected[0].reason.kind)
    const winner = fulfilled[0].value.invoiceId
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBe(winner)
    const loser = winner === 'si_race_a' ? 'si_race_b' : 'si_race_a'
    expect(await read(invRef, loser)).toBeUndefined()
    let counter
    await testEnv.withSecurityRulesDisabled(async (c) => { counter = (await getDoc(counterRef(c.firestore()))).data() })
    expect(counter).toEqual({ next: 6 })
  })

  it('a LEGACY claim is LEGACY_UNRECONCILED, a stale revision is STALE, a claim certifying other figures is STALE — nothing written in any case', async () => {
    await seedClaim('legacy', { legacy: true })
    await expectKind(create(USERS.qs, { claimId: 'legacy', invoiceId: 'si_l' }), SI_WRITE_ERROR.LEGACY_UNRECONCILED)
    await expectKind(create(USERS.qs, { invoiceId: 'si_s', seenClaim: claimDoc({ revision: 1 }) }), SI_WRITE_ERROR.STALE)
    await expectKind(create(USERS.qs, { invoiceId: 'si_t', seenClaim: claimDoc({ approvedGst: 1 }) }), SI_WRITE_ERROR.STALE)
    for (const id of ['si_l', 'si_s', 'si_t']) expect(await read(invRef, id)).toBeUndefined()
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
  })

  it('a denied role is refused by the RULES as PERMISSION with nothing written — the transaction cannot bypass them', async () => {
    await expectKind(create(USERS.sub), SI_WRITE_ERROR.PERMISSION)
    expect(await read(invRef, 'si_app')).toBeUndefined()
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
  })
})

describe('runCancelSupplierInvoice and runLinkExistingInvoice — against the real rules', () => {
  const cancel = (user, invoiceId, seen, claimId = 'cl') => {
    const db = ctx(user)
    return runCancelSupplierInvoice({ db, invoiceRef: invRef(db, invoiceId), claimRef: claimId ? claimRef(db, claimId) : null, seen: { id: invoiceId, ...seen }, uid: user.uid, runTransaction, serverTimestamp })
  }
  const link = (user, claimId, invoiceId, seenClaim, seenInvoice) => {
    const db = ctx(user)
    return runLinkExistingInvoice({ db, claimRef: claimRef(db, claimId), invoiceRef: invRef(db, invoiceId), seenClaim: { id: claimId, ...seenClaim }, seenInvoice: { id: invoiceId, ...seenInvoice }, uid: user.uid, runTransaction, serverTimestamp })
  }

  it('cancels a linked draft and unlinks the claim; a second cancel is STALE; the claim then takes a new paired create', async () => {
    await assertSucceeds(pairedCreate(USERS.qs, { invoiceId: 'si1' }))
    expect(await cancel(USERS.pm, 'si1', { status: 'draft' })).toEqual({ kind: null, unlinked: true })
    expect((await read(invRef, 'si1')).status).toBe('cancelled')
    expect((await read(claimRef, 'cl')).supplierInvoiceId).toBeNull()
    await expectKind(cancel(USERS.pm, 'si1', { status: 'draft' }), SI_WRITE_ERROR.STALE)
    await assertSucceeds(pairedCreate(USERS.admin, { invoiceId: 'si2', link: linkWrite(USERS.admin, 'si2', { revision: 5 }) }))
  })

  it('cancels an invoice its claim does not link ALONE (legacy claim) and refuses a posted one as INVALID', async () => {
    await seedClaim('legacy', { legacy: true })
    await seedInvoice('si_legacy', 'approved', { progressClaimId: 'legacy' })
    expect(await cancel(USERS.qs, 'si_legacy', { status: 'approved' }, 'legacy')).toEqual({ kind: null, unlinked: false })
    expect((await read(invRef, 'si_legacy')).status).toBe('cancelled')
    await seedClaim('cl', { supplierInvoiceId: 'si_posted', revision: 3 })
    await seedInvoice('si_posted', 'posted')
    await expectKind(cancel(USERS.admin, 'si_posted', { status: 'posted' }), SI_WRITE_ERROR.INVALID)
    expect((await read(invRef, 'si_posted')).status).toBe('posted')
  })

  it('reconciles a legacy claim to its existing posted invoice; a second reconcile is ALREADY_INVOICED; a cancelled or foreign invoice is INVALID before any write', async () => {
    await seedClaim('legacy', { legacy: true })
    await seedInvoice('si_old', 'posted', { progressClaimId: 'legacy' })
    const seenClaim = claimDoc({ legacy: true })
    const seenInvoice = { status: 'posted', source: 'progress_claim', progressClaimId: 'legacy', poId: PO_SENT.id, supplierId: PO_SENT.supplierId, invoiceNumber: 'SI-0005' }
    expect(await link(USERS.admin, 'legacy', 'si_old', seenClaim, seenInvoice)).toEqual({ kind: null, invoiceId: 'si_old' })
    expect((await read(claimRef, 'legacy')).supplierInvoiceId).toBe('si_old')
    await expectKind(link(USERS.admin, 'legacy', 'si_old', seenClaim, seenInvoice), SI_WRITE_ERROR.ALREADY_INVOICED)
    await seedClaim('legacy2', { legacy: true })
    await seedInvoice('si_cx', 'cancelled', { progressClaimId: 'legacy2' })
    await expectKind(link(USERS.admin, 'legacy2', 'si_cx', seenClaim, { ...seenInvoice, status: 'cancelled', progressClaimId: 'legacy2' }), SI_WRITE_ERROR.INVALID)
    await expectKind(link(USERS.admin, 'legacy2', 'si_old', seenClaim, seenInvoice), SI_WRITE_ERROR.INVALID)
    expect('supplierInvoiceId' in (await read(claimRef, 'legacy2'))).toBe(false)
  })
})
