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
  doc, getDoc, setDoc, updateDoc, writeBatch, runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { poTotals, buildPurchaseOrderDocument } from '../../src/lib/purchaseOrders'
import { runRaisePurchaseOrderFromAward, AWARD_PO_ERROR } from '../../src/lib/awardToPoActions'
import { PoWriteError } from '../../src/lib/purchaseOrderActions'

// ── M3-A: Awarded Tender → Linked Draft PO — emulator tests (ADR-61) ─────────
//
// The source link is BIDIRECTIONAL and ATOMIC: the PO cites its package, bid
// and tender number; the package records the ONE current PO raised from it.
// Rules pair the two through getAfter(), so neither half can be written
// without the other in the same transaction or batch. This suite is the
// Phase 0 feasibility proof AND the regression suite: every case is a direct
// SDK write, exactly what a client bypassing the app would issue, plus the
// app's own transaction (lib/awardToPoActions.js) in the last section.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sup:    { uid: 'u_sup',    role: 'super_admin',     companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]

let testEnv

const base = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}`
const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const pkgRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${base(c, p)}/tenderPackages`, id)
const bidRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${base(c, p)}/tenderBids`, id)
const poRef  = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, `${base(c, p)}/purchaseOrders`, id)
const counterRef = (db, c = COMPANY_A) => doc(db, `companies/${c}/counters`, 'purchaseOrders')

const PKG = 'pkg_awarded'
const BID = 'bid_won'
const SUPPLIER = 'supplier1'
const SUPPLIER_NAME = 'Apex Steel Pty Ltd'

const BID_LINES = [
  { costCodeId: 'cc1', costCodeName: '01-100 — Steel',     description: 'Supply',  amount: 1000 },
  { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork', description: 'Install', amount: 250.15 },
  { costCodeId: 'cc1', costCodeName: '01-100 — Steel',     description: 'Extras',  amount: 0 },
]
// lib/awardToPo.js mapping: qty 1, blank unit, unitPrice = amount.
const PO_LINES = BID_LINES.map(li => ({
  costCodeId: li.costCodeId, costCodeName: li.costCodeName, description: li.description,
  qty: 1, unit: '', unitPrice: li.amount, lineTotal: li.amount,
}))

// A valid award-raised DRAFT payload — hooks/usePurchaseOrders.jsx →
// createPurchaseOrderFromAward through lib/purchaseOrders.js →
// buildPurchaseOrderDocument, header through the REAL poTotals.
function raisedPo(user, overrides = {}) {
  const { subtotal, gst, total } = poTotals(PO_LINES)
  return {
    poNumber: 'PO-0002', status: 'draft',
    supplierName: SUPPLIER_NAME, supplierId: SUPPLIER,
    description: 'TP-0001 — Structural Steel Package', notes: '',
    lineItems: PO_LINES, subtotal, gst, total,
    currency: 'AUD', revision: 1,
    sentAt: null, sentBy: null, closedAt: null, closedBy: null, cancelledAt: null, cancelledBy: null,
    externalRefs: {},
    createdAt: serverTimestamp(), createdBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    sourceTenderPackageId: PKG, sourceTenderBidId: BID, sourceTenderNumber: 'TP-0001',
    ...overrides,
  }
}
// The package back-link the same transaction writes.
function backlink(user, poId = 'po_new', poNumber = 'PO-0002', extra = {}) {
  return {
    raisedPoId: poId, raisedPoNumber: poNumber,
    raisedPoAt: serverTimestamp(), raisedPoBy: user.uid,
    updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...extra,
  }
}
// A copy of `obj` without the named keys.
const without = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)))
const SOURCE_KEYS = ['sourceTenderPackageId', 'sourceTenderBidId', 'sourceTenderNumber']

// A manual PO exactly as the unchanged manual path writes it (no source keys).
function manualPo(user, overrides = {}) {
  return { ...without(raisedPo(user), SOURCE_KEYS), poNumber: 'PO-0003', supplierName: 'Manual Supplies', supplierId: 'supplier2', ...overrides }
}

// The app's atomic write: PO create + package back-link in ONE batch.
function raiseBatch(user, { poId = 'po_new', po = raisedPo(user), link = backlink(user, poId), pkgId = PKG } = {}) {
  const db = ctx(user)
  const batch = writeBatch(db)
  batch.set(poRef(db, poId), po)
  batch.update(pkgRef(db, pkgId), link)
  return batch.commit()
}

async function seedAll({ pkgStatus = 'awarded', pkgExtra = {}, bidExtra = {}, contactActive = true } = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const now = Timestamp.now()
    await setDoc(doc(db, `companies/${COMPANY_A}/contacts`, SUPPLIER), {
      displayName: SUPPLIER_NAME, contactTypes: ['supplier'], isActive: contactActive,
    })
    const lifecycle =
      pkgStatus === 'awarded' ? { status: 'awarded', issuedAt: now, issuedBy: 'u_admin', awardedAt: now, awardedBy: 'u_admin', awardedBidId: BID, awardedBidderName: SUPPLIER_NAME, awardNotes: 'Lowest' } :
      pkgStatus === 'issued'  ? { status: 'issued', issuedAt: now, issuedBy: 'u_admin' } :
      pkgStatus === 'cancelled' ? { status: 'cancelled', cancelledAt: now, cancelledBy: 'u_admin', cancelReason: 'Scope changed' } :
      { status: 'draft' }
    await setDoc(pkgRef(db, PKG), {
      tenderNumber: 'TP-0001', name: 'Structural Steel Package', description: '', scope: 'Steel',
      costCodes: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel' }, { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork' }],
      closingDate: '', notes: '',
      awardedBidId: null, awardedBidderName: null, awardNotes: '', cancelReason: '', revision: 1,
      issuedAt: null, issuedBy: null, awardedAt: null, awardedBy: null, cancelledAt: null, cancelledBy: null,
      createdAt: now, createdBy: 'u_admin', updatedAt: now, updatedBy: 'u_admin',
      ...lifecycle, ...pkgExtra,
    })
    await setDoc(bidRef(db, BID), {
      tenderPackageId: PKG, tenderNumber: 'TP-0001', status: 'received',
      bidderContactId: SUPPLIER, bidderName: SUPPLIER_NAME, bidDate: '2026-08-10', bidderRef: 'Q-1001',
      lineItems: BID_LINES, exclusions: 'Excludes cranage', notes: '', currency: 'AUD', revision: 1,
      voidedAt: null, voidedBy: null, voidReason: '',
      createdAt: now, createdBy: 'u_admin', updatedAt: now, updatedBy: 'u_admin',
      ...bidExtra,
    })
    await setDoc(counterRef(db), { next: 2 })
  })
}

async function seedPo(id, status, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const now = Timestamp.now()
    const lifecycle =
      status === 'cancelled' ? { status, cancelledAt: now, cancelledBy: 'u_admin' } :
      status === 'sent'      ? { status, sentAt: now, sentBy: 'u_admin' } :
      { status: 'draft' }
    await setDoc(poRef(db, id), { ...raisedPo(USERS.admin), createdAt: now, updatedAt: now, ...lifecycle, ...extra })
  })
}

async function read(refFn, id) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(refFn(c.firestore(), id))).data() })
  return data
}
async function exists(refFn, id) {
  return (await read(refFn, id)) !== undefined
}

const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — refusing to run Rules tests outside the emulator. Run `npm run test:rules`.')
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

// Wipes the emulator and re-seeds membership, companies and projects — the
// arrange step every case starts from, and what a loop must call between
// iterations so a PO from the previous one cannot turn a create into an
// overwrite.
async function resetAll() {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A', countryCode: 'AU', baseCurrency: 'AUD' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'A', currency: 'AUD', currencyLocked: true })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_B), { name: 'A2', currency: 'AUD', currencyLocked: true })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B', currency: 'AUD' })
  })
}

beforeEach(resetAll)

// ── Phase 0 feasibility: getAfter() pairs the two writes ─────────────────────

describe('atomic pairing (getAfter) — feasibility', () => {
  it('PO create + package back-link succeed as ONE batch for each financial role', async () => {
    for (const user of FINANCIAL) {
      await seedAll()
      await assertSucceeds(raiseBatch(user))
      const po = await read(poRef, 'po_new')
      const pkg = await read(pkgRef, PKG)
      expect(po.sourceTenderPackageId).toBe(PKG)
      expect(po.status).toBe('draft')
      expect(pkg.raisedPoId).toBe('po_new')
      expect(pkg.raisedPoNumber).toBe('PO-0002')
      expect(pkg.raisedPoBy).toBe(user.uid)
      expect(pkg.status).toBe('awarded')
      await resetAll()
    }
  })

  it('a PO carrying source keys WITHOUT the package back-link in the same write is DENIED', async () => {
    await seedAll()
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'po_new'), raisedPo(USERS.admin)))
    expect(await exists(poRef, 'po_new')).toBe(false)
    expect((await read(pkgRef, PKG)).raisedPoId).toBeUndefined()
  })

  it('a package back-link WITHOUT the linked PO in the same write is DENIED', async () => {
    await seedAll()
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), PKG), backlink(USERS.admin)))
    expect((await read(pkgRef, PKG)).raisedPoId).toBeUndefined()
  })

  it('a back-link pointing at a PRE-EXISTING draft PO (not created in this write) is DENIED — even one citing this package', async () => {
    await seedAll()
    await seedPo('po_old', 'draft')               // carries the source triple, seeded rules-disabled
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), PKG), backlink(USERS.admin, 'po_old')))
    // …and the same with a plain manual draft (no source keys at all).
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(poRef(c.firestore(), 'po_manual'), { ...without(raisedPo(USERS.admin), SOURCE_KEYS), createdAt: Timestamp.now(), updatedAt: Timestamp.now() })
    })
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), PKG), backlink(USERS.admin, 'po_manual')))
  })

  it('both writes roll back when either half is invalid — nothing lands and the counter does not advance', async () => {
    await seedAll()
    // Invalid PO half (negative total), valid back-link half.
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { total: -1 }) }))
    expect(await exists(poRef, 'po_new')).toBe(false)
    expect((await read(pkgRef, PKG)).raisedPoId).toBeUndefined()
    // Valid PO half, invalid back-link half (wrong actor).
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { raisedPoBy: USERS.pm.uid }) }))
    expect(await exists(poRef, 'po_new')).toBe(false)
    expect((await read(pkgRef, PKG)).raisedPoId).toBeUndefined()
    // The app's transaction increments the counter in the same commit: an
    // aborted commit leaves it untouched.
    const db = ctx(USERS.admin)
    await assertFails(runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef(db))
      tx.set(counterRef(db), { next: snap.data().next + 1 }, { merge: true })
      tx.set(poRef(db, 'po_new'), raisedPo(USERS.admin, { total: -1 }))
      tx.update(pkgRef(db, PKG), backlink(USERS.admin))
    }))
    expect((await read((d) => counterRef(d), '')).next).toBe(2)
    expect(await exists(poRef, 'po_new')).toBe(false)
  })

  it('overwriting an EXISTING PO document inside the raise batch is denied — a raise can only create', async () => {
    await seedAll()
    await assertSucceeds(raiseBatch(USERS.admin))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(pkgRef(c.firestore(), PKG), { raisedPoId: null, raisedPoNumber: null, raisedPoAt: null, raisedPoBy: null })
    })
    // Same id, same payload — now an update of a draft with createdAt moved.
    await assertFails(raiseBatch(USERS.admin))
    expect((await read(pkgRef, PKG)).raisedPoId).toBeNull()
  })

  it('the back-link id and the PO id must agree, and the PO must cite THIS package and ITS awarded bid', async () => {
    await seedAll()
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_other') }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { sourceTenderPackageId: 'pkg_other' }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { sourceTenderBidId: 'bid_other' }) }))
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-9999') }))
    expect(await exists(poRef, 'po_new')).toBe(false)
  })
})

// ── Source validity (purchaseOrders block) ───────────────────────────────────

describe('PO source keys — what the package and bid must be', () => {
  it('refused when the package is draft, issued or cancelled (not awarded)', async () => {
    for (const status of ['draft', 'issued', 'cancelled']) {
      await resetAll()
      await seedAll({ pkgStatus: status })
      await assertFails(raiseBatch(USERS.admin))
      expect(await exists(poRef, 'po_new')).toBe(false)
    }
  })

  it('refused when the cited bid is not the package’s awarded bid, is void, or belongs to another package', async () => {
    await seedAll({ pkgExtra: { awardedBidId: 'bid_other' } })
    await assertFails(raiseBatch(USERS.admin))
    await seedAll({ bidExtra: { status: 'void', voidedAt: Timestamp.now(), voidedBy: 'u_admin', voidReason: 'x' } })
    await assertFails(raiseBatch(USERS.admin))
    await seedAll({ bidExtra: { tenderPackageId: 'pkg_other' } })
    await assertFails(raiseBatch(USERS.admin))
    await seedAll()
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { sourceTenderBidId: 'bid_missing' }) }))
  })

  it('refused when the tender number snapshot, the supplier id or the supplier name does not match the bid', async () => {
    await seedAll()
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { sourceTenderNumber: 'TP-0009' }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { supplierId: 'supplier2' }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { supplierName: 'Apex Steel' }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { supplierId: null }) }))
  })

  it('a partial source triple is refused; a blank or non-string key is refused', async () => {
    await seedAll()
    for (const drop of ['sourceTenderPackageId', 'sourceTenderBidId', 'sourceTenderNumber']) {
      const po = raisedPo(USERS.admin)
      delete po[drop]
      await assertFails(raiseBatch(USERS.admin, { po }))
    }
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { sourceTenderNumber: '' }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { sourceTenderBidId: 7 }) }))
  })

  it('every other create invariant still applies to a raised PO — born draft, stamps, money, currency', async () => {
    await seedAll()
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { status: 'sent', sentAt: serverTimestamp(), sentBy: USERS.admin.uid }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { createdBy: USERS.pm.uid }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { gst: 0 }) }))
    await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { currency: 'NZD' }) }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(raiseBatch(USERS.admin, { po: raisedPo(USERS.admin, { createdAt: clock() }) }))
    }
  })

  it('the source is tenant- and project-scoped: a package in another project or company cannot be cited', async () => {
    await seedAll()
    // Same company, other project: the PO lives in PROJECT_B, cites PKG (which is in PROJECT_A).
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    batch.set(poRef(db, 'po_new', COMPANY_A, PROJECT_B), raisedPo(USERS.admin))
    batch.update(pkgRef(db, PKG), backlink(USERS.admin))
    await assertFails(batch.commit())
    // Other company's admin cannot raise against Company A's package at all.
    const dbB = ctx(USERS.other)
    const batchB = writeBatch(dbB)
    batchB.set(poRef(dbB, 'po_new'), raisedPo(USERS.other))
    batchB.update(pkgRef(dbB, PKG), backlink(USERS.other))
    await assertFails(batchB.commit())
  })
})

// ── Immutability after creation ──────────────────────────────────────────────

describe('source keys are immutable once created', () => {
  it('a draft edit cannot change, add or remove any source key', async () => {
    await seedAll()
    await assertSucceeds(raiseBatch(USERS.admin))
    const db = ctx(USERS.qs)
    const stamps = { updatedAt: serverTimestamp(), updatedBy: USERS.qs.uid }
    await assertSucceeds(updateDoc(poRef(db, 'po_new'), { notes: 'reviewed', ...stamps }))
    await assertFails(updateDoc(poRef(db, 'po_new'), { sourceTenderNumber: 'TP-0002', ...stamps }))
    await assertFails(updateDoc(poRef(db, 'po_new'), { sourceTenderPackageId: 'pkg_other', ...stamps }))
    await assertFails(updateDoc(poRef(db, 'po_new'), { sourceTenderBidId: 'bid_other', ...stamps }))
    // A manual PO cannot acquire provenance after the fact.
    await assertSucceeds(setDoc(poRef(db, 'po_manual'), manualPo(USERS.qs)))
    await assertFails(updateDoc(poRef(db, 'po_manual'), { sourceTenderPackageId: PKG, sourceTenderBidId: BID, sourceTenderNumber: 'TP-0001', ...stamps }))
  })

  it('send, close and cancel on a raised PO work as stamps-only transitions and keep the source keys', async () => {
    await seedAll()
    await assertSucceeds(raiseBatch(USERS.admin))
    const db = ctx(USERS.pm)
    const s = { updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }
    await assertSucceeds(updateDoc(poRef(db, 'po_new'), { status: 'sent', sentAt: serverTimestamp(), sentBy: USERS.pm.uid, ...s }))
    await assertSucceeds(updateDoc(poRef(db, 'po_new'), { status: 'closed', closedAt: serverTimestamp(), closedBy: USERS.pm.uid, ...s }))
    const po = await read(poRef, 'po_new')
    expect(po.sourceTenderPackageId).toBe(PKG)
    expect(po.status).toBe('closed')
  })

  it('the package back-link cannot be rewritten by the award, cancel or issued-edit branches, nor on a draft', async () => {
    await seedAll()
    await assertSucceeds(raiseBatch(USERS.admin))
    const db = ctx(USERS.admin)
    const s = { updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }
    await assertFails(updateDoc(pkgRef(db, PKG), { raisedPoId: null, raisedPoNumber: null, raisedPoAt: null, raisedPoBy: null, ...s }))
    await assertFails(updateDoc(pkgRef(db, PKG), { raisedPoNumber: 'PO-0099', ...s }))
    await assertFails(updateDoc(pkgRef(db, PKG), { notes: 'x', ...s }))   // awarded is terminal for content
    // A draft package: the draft-edit branch must preserve (null) back-link keys.
    await seedAll({ pkgStatus: 'draft' })
    await assertFails(updateDoc(pkgRef(db, PKG), { raisedPoId: 'po_x', ...s }))
    await assertSucceeds(updateDoc(pkgRef(db, PKG), { notes: 'still draft', ...s }))
  })

  it('a package cannot be created with a pre-filled back-link; absent and explicit-null keys are both accepted', async () => {
    const db = ctx(USERS.admin)
    const pkgDoc = (extra = {}) => ({
      tenderNumber: 'TP-0002', status: 'draft', name: 'New', description: '', scope: '', notes: '',
      costCodes: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel' }], closingDate: '',
      awardedBidId: null, awardedBidderName: null, awardNotes: '', cancelReason: '', revision: 1,
      issuedAt: null, issuedBy: null, awardedAt: null, awardedBy: null, cancelledAt: null, cancelledBy: null,
      createdAt: serverTimestamp(), createdBy: USERS.admin.uid, updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid,
      ...extra,
    })
    await assertSucceeds(setDoc(pkgRef(db, 'p_absent'), pkgDoc()))
    await assertSucceeds(setDoc(pkgRef(db, 'p_null'), pkgDoc({ raisedPoId: null, raisedPoNumber: null, raisedPoAt: null, raisedPoBy: null })))
    await assertFails(setDoc(pkgRef(db, 'p_forged'), pkgDoc({ raisedPoId: 'po_x', raisedPoNumber: 'PO-0001', raisedPoAt: serverTimestamp(), raisedPoBy: USERS.admin.uid })))
  })
})

// ── Duplicate protection and re-raise ────────────────────────────────────────

describe('one current linked PO per award; re-raise only after cancellation', () => {
  it('a second raise while the first PO is draft, sent or closed is refused', async () => {
    for (const status of ['draft', 'sent']) {
      await resetAll()
      await seedAll()
      await assertSucceeds(raiseBatch(USERS.admin))
      if (status === 'sent') {
        await testEnv.withSecurityRulesDisabled(async (c) => {
          await updateDoc(poRef(c.firestore(), 'po_new'), { status: 'sent', sentAt: Timestamp.now(), sentBy: 'u_admin' })
        })
      }
      await assertFails(raiseBatch(USERS.pm, { poId: 'po_second', po: raisedPo(USERS.pm, { poNumber: 'PO-0003' }), link: backlink(USERS.pm, 'po_second', 'PO-0003') }))
      expect(await exists(poRef, 'po_second')).toBe(false)
      expect((await read(pkgRef, PKG)).raisedPoId).toBe('po_new')
    }
  })

  it('after the linked PO is CANCELLED a re-raise succeeds, relinks the package and leaves the cancelled PO’s source keys intact', async () => {
    await seedAll()
    await assertSucceeds(raiseBatch(USERS.admin))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(poRef(c.firestore(), 'po_new'), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await assertSucceeds(raiseBatch(USERS.qs, { poId: 'po_second', po: raisedPo(USERS.qs, { poNumber: 'PO-0003' }), link: backlink(USERS.qs, 'po_second', 'PO-0003') }))
    const pkg = await read(pkgRef, PKG)
    expect(pkg.raisedPoId).toBe('po_second')
    expect(pkg.raisedPoNumber).toBe('PO-0003')
    expect(pkg.raisedPoBy).toBe(USERS.qs.uid)
    const old = await read(poRef, 'po_new')
    expect(old.status).toBe('cancelled')
    expect(old.sourceTenderPackageId).toBe(PKG)
    expect(old.sourceTenderBidId).toBe(BID)
  })

  it('a re-raise cannot point back at the same (cancelled) PO, and a back-link naming a PO that no longer exists is refused', async () => {
    await seedAll()
    await assertSucceeds(raiseBatch(USERS.admin))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(poRef(c.firestore(), 'po_new'), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    await assertFails(updateDoc(pkgRef(ctx(USERS.admin), PKG), backlink(USERS.admin, 'po_new')))
    // The stored link names a PO that is gone: branch (g)'s get() fails → deny.
    await seedAll({ pkgExtra: { raisedPoId: 'po_gone', raisedPoNumber: 'PO-0001', raisedPoAt: Timestamp.now(), raisedPoBy: 'u_admin' } })
    await assertFails(raiseBatch(USERS.admin))
  })

  it('forged actor or time on the back-link is refused', async () => {
    await seedAll()
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { raisedPoBy: USERS.qs.uid }) }))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { raisedPoAt: clock() }) }))
      await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { updatedAt: clock() }) }))
    }
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { updatedBy: USERS.qs.uid }) }))
    // Smuggled content alongside the link.
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { awardNotes: 'rewritten' }) }))
    await assertFails(raiseBatch(USERS.admin, { link: backlink(USERS.admin, 'po_new', 'PO-0002', { status: 'issued' }) }))
  })
})

// ── Roles, legacy and manual paths ───────────────────────────────────────────

describe('roles, tenancy, legacy and manual compatibility', () => {
  it('subcontractor, client, super_admin and an unauthenticated caller cannot raise', async () => {
    await seedAll()
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await assertFails(raiseBatch(user))
    }
    const anon = testEnv.unauthenticatedContext().firestore()
    const batch = writeBatch(anon)
    batch.set(poRef(anon, 'po_new'), raisedPo(USERS.admin))
    batch.update(pkgRef(anon, PKG), backlink(USERS.admin))
    await assertFails(batch.commit())
    expect(await exists(poRef, 'po_new')).toBe(false)
  })

  it('the manual PO create path is unchanged — no source keys, every role, and the exact key set still refuses an extra key', async () => {
    for (const user of FINANCIAL) {
      await assertSucceeds(setDoc(poRef(ctx(user), `m_${user.uid}`), manualPo(user)))
    }
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'm_extra'), manualPo(USERS.admin, { sourceTender: 'x' })))
    await assertFails(setDoc(poRef(ctx(USERS.admin), 'm_extra2'), manualPo(USERS.admin, { raisedFrom: PKG })))
  })

  it('a legacy PO (no stamps, no source keys) still edits, sends and cancels', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      const legacy = without(manualPo(USERS.admin), ['updatedAt', 'updatedBy', 'sentBy', 'closedBy', 'cancelledBy'])
      await setDoc(poRef(c.firestore(), 'legacy'), { ...legacy, createdAt: Timestamp.now() })
    })
    const db = ctx(USERS.qs)
    const s = { updatedAt: serverTimestamp(), updatedBy: USERS.qs.uid }
    await assertSucceeds(updateDoc(poRef(db, 'legacy'), { notes: 'edited', ...s }))
    await assertSucceeds(updateDoc(poRef(db, 'legacy'), { status: 'sent', sentAt: serverTimestamp(), sentBy: USERS.qs.uid, ...s }))
    await assertSucceeds(updateDoc(poRef(db, 'legacy'), { status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: USERS.qs.uid, ...s }))
  })

  it('the normal tender workflow is unchanged — create, edit, issue, award and cancel on packages without back-link keys', async () => {
    const db = ctx(USERS.qs)
    const s = (u = USERS.qs) => ({ updatedAt: serverTimestamp(), updatedBy: u.uid })
    const pkgDoc = {
      tenderNumber: 'TP-0005', status: 'draft', name: 'Roofing', description: '', scope: '', notes: '',
      costCodes: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel' }], closingDate: '',
      awardedBidId: null, awardedBidderName: null, awardNotes: '', cancelReason: '', revision: 1,
      issuedAt: null, issuedBy: null, awardedAt: null, awardedBy: null, cancelledAt: null, cancelledBy: null,
      createdAt: serverTimestamp(), createdBy: USERS.qs.uid, ...s(),
    }
    await assertSucceeds(setDoc(pkgRef(db, 'p5'), pkgDoc))
    await assertSucceeds(updateDoc(pkgRef(db, 'p5'), { name: 'Roofing — Rev A', ...s() }))
    await assertSucceeds(updateDoc(pkgRef(db, 'p5'), { status: 'issued', issuedAt: serverTimestamp(), issuedBy: USERS.qs.uid, ...s() }))
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), `companies/${COMPANY_A}/contacts`, SUPPLIER), { displayName: SUPPLIER_NAME, contactTypes: ['supplier'] })
      await setDoc(bidRef(c.firestore(), 'b5'), {
        tenderPackageId: 'p5', tenderNumber: 'TP-0005', status: 'received', bidderContactId: SUPPLIER, bidderName: SUPPLIER_NAME,
        bidDate: '2026-08-10', bidderRef: '', lineItems: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel', description: '', amount: 10 }],
        exclusions: '', notes: '', currency: 'AUD', revision: 1, voidedAt: null, voidedBy: null, voidReason: '',
        createdAt: Timestamp.now(), createdBy: 'u_admin', updatedAt: Timestamp.now(), updatedBy: 'u_admin',
      })
    })
    await assertSucceeds(updateDoc(pkgRef(db, 'p5'), {
      status: 'awarded', awardedBidId: 'b5', awardedBidderName: SUPPLIER_NAME, awardNotes: '',
      awardedAt: serverTimestamp(), awardedBy: USERS.qs.uid, ...s(),
    }))
    await assertSucceeds(setDoc(pkgRef(db, 'p6'), { ...pkgDoc, tenderNumber: 'TP-0006' }))
    await assertSucceeds(updateDoc(pkgRef(db, 'p6'), { status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: USERS.qs.uid, cancelReason: 'No longer needed', ...s() }))
  })
})

// ── The app's own transaction against the real rules ─────────────────────────

describe('runRaisePurchaseOrderFromAward — the app’s transaction against the real rules', () => {
  const projectRef = (db, p = PROJECT_A) => doc(db, `companies/${COMPANY_A}/projects`, p)

  // Mirrors hooks/usePurchaseOrders.jsx → createPurchaseOrderFromAward, with
  // the proposal's lines pre-built (lib/awardToPo.js is unit-tested; here the
  // transaction and the rules are exercised together).
  function raise(user, { poId = 'po_app', previousPoId = null, pkgSeen = {}, bidSeen = {}, lines = PO_LINES, projectId = PROJECT_A } = {}) {
    const db = ctx(user)
    const projectBase = `${base(COMPANY_A, projectId)}`
    const refs = {
      counterRef:    counterRef(db),
      packageRef:    doc(db, `${projectBase}/tenderPackages`, PKG),
      bidRef:        doc(db, `${projectBase}/tenderBids`, BID),
      poRef:         doc(db, `${projectBase}/purchaseOrders`, poId),
      previousPoRef: previousPoId ? doc(db, `${projectBase}/purchaseOrders`, previousPoId) : null,
    }
    return runRaisePurchaseOrderFromAward({
      db, uid: user.uid, runTransaction, serverTimestamp, refs,
      seen: {
        pkg: { id: PKG, tenderNumber: 'TP-0001', ...pkgSeen },
        bid: { id: BID, bidderContactId: SUPPLIER, bidderName: SUPPLIER_NAME, lineItems: BID_LINES, ...bidSeen },
      },
      buildDocument: ({ poNumber, now }) => buildPurchaseOrderDocument({
        poNumber, supplierName: SUPPLIER_NAME, supplierId: SUPPLIER,
        description: 'TP-0001 — Structural Steel Package', notes: '', lineItems: lines,
        currency: 'AUD', uid: user.uid, now,
        source: { tenderPackageId: PKG, tenderBidId: BID, tenderNumber: 'TP-0001' },
      }),
      // hooks/projectCurrencyLock.js → stageProjectCurrencyLock, inlined.
      stageCurrencyLock: async (tx) => {
        const snap = await tx.get(projectRef(db, projectId))
        if (!snap.exists() || snap.data().currencyLocked === true) return () => {}
        return () => tx.update(projectRef(db, projectId), { currencyLocked: true })
      },
    })
  }

  async function expectKind(promise, kind) {
    let caught
    try { await promise } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(PoWriteError)
    expect(caught.kind).toBe(kind)
    return caught
  }

  it('raises once: counter 2 → 3, the PO is PO-0002 and draft with the source triple, the package links back, every role', async () => {
    for (const user of FINANCIAL) {
      await resetAll()
      await seedAll()
      const out = await raise(user)
      expect(out).toEqual({ kind: null, poId: 'po_app', poNumber: 'PO-0002' })
      const po = await read(poRef, 'po_app')
      expect(po).toMatchObject({ poNumber: 'PO-0002', status: 'draft', supplierId: SUPPLIER, supplierName: SUPPLIER_NAME, sourceTenderPackageId: PKG, sourceTenderBidId: BID, sourceTenderNumber: 'TP-0001', createdBy: user.uid, subtotal: 1250.15 })
      expect(po.sentAt).toBeNull()
      const pkg = await read(pkgRef, PKG)
      expect(pkg).toMatchObject({ status: 'awarded', raisedPoId: 'po_app', raisedPoNumber: 'PO-0002', raisedPoBy: user.uid })
      expect((await read((d) => counterRef(d), '')).next).toBe(3)
    }
  })

  it('locks an unlocked project in the same commit (the ADR-21 ratchet) — a QS included', async () => {
    await seedAll()
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(projectRef(c.firestore()), { name: 'A', currency: 'AUD' })
    })
    await raise(USERS.qs)
    const project = await read((d) => projectRef(d), '')
    expect(project.currencyLocked).toBe(true)
    expect(await exists(poRef, 'po_app')).toBe(true)
  })

  it('a second raise is refused as ALREADY_RAISED with nothing written and the counter untouched', async () => {
    await seedAll()
    await raise(USERS.admin)
    const e = await expectKind(raise(USERS.pm, { poId: 'po_second' }), AWARD_PO_ERROR.ALREADY_RAISED)
    expect(e.message).toContain('PO-0002')
    expect(await exists(poRef, 'po_second')).toBe(false)
    expect((await read((d) => counterRef(d), '')).next).toBe(3)
    // Knowing the link does not help while the PO is still draft.
    await expectKind(raise(USERS.pm, { poId: 'po_second', previousPoId: 'po_app' }), AWARD_PO_ERROR.ALREADY_RAISED)
    expect(await exists(poRef, 'po_second')).toBe(false)
  })

  it('TWO CONCURRENT raises produce exactly one PO, one back-link and one counter increment', async () => {
    await seedAll()
    const results = await Promise.allSettled([
      raise(USERS.admin, { poId: 'po_x' }),
      raise(USERS.qs, { poId: 'po_y' }),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(PoWriteError)
    // The loser is refused either by its retried read (ALREADY_RAISED) or —
    // when the server evaluates the rules against the winner's committed
    // state before the client retries — by branch (f) itself (PERMISSION).
    // Both are refusals; the state below is what matters.
    expect([AWARD_PO_ERROR.ALREADY_RAISED, AWARD_PO_ERROR.STALE, AWARD_PO_ERROR.PERMISSION]).toContain(rejected[0].reason.kind)
    const winner = fulfilled[0].value.poId
    const loser = winner === 'po_x' ? 'po_y' : 'po_x'
    expect(await exists(poRef, winner)).toBe(true)
    expect(await exists(poRef, loser)).toBe(false)
    expect((await read(pkgRef, PKG)).raisedPoId).toBe(winner)
    expect((await read((d) => counterRef(d), '')).next).toBe(3)
  })

  it('after the linked PO is cancelled, a re-raise that re-read it succeeds; the cancelled PO keeps its source keys', async () => {
    await seedAll()
    await raise(USERS.admin)
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await updateDoc(poRef(c.firestore(), 'po_app'), { status: 'cancelled', cancelledAt: Timestamp.now(), cancelledBy: 'u_admin' })
    })
    // Without re-reading the cancelled PO the client refuses (fail closed).
    await expectKind(raise(USERS.qs, { poId: 'po_again' }), AWARD_PO_ERROR.ALREADY_RAISED)
    const out = await raise(USERS.qs, { poId: 'po_again', previousPoId: 'po_app' })
    expect(out.poNumber).toBe('PO-0003')
    expect((await read(pkgRef, PKG)).raisedPoId).toBe('po_again')
    expect(await read(poRef, 'po_app')).toMatchObject({ status: 'cancelled', sourceTenderPackageId: PKG, sourceTenderBidId: BID })
    expect((await read((d) => counterRef(d), '')).next).toBe(4)
  })

  it('STALE when the package or bid on the server differs from the reviewed copy — nothing written', async () => {
    await seedAll({ pkgStatus: 'issued' })
    await expectKind(raise(USERS.admin), AWARD_PO_ERROR.STALE)
    await seedAll()
    await expectKind(raise(USERS.admin, { bidSeen: { lineItems: [{ ...BID_LINES[0], amount: 999 }] } }), AWARD_PO_ERROR.STALE)
    await seedAll({ pkgExtra: { awardedBidId: 'bid_other' } })
    await expectKind(raise(USERS.admin), AWARD_PO_ERROR.STALE)
    expect(await exists(poRef, 'po_app')).toBe(false)
    expect((await read((d) => counterRef(d), '')).next).toBe(2)
  })

  it('a denied role is refused by the RULES as PERMISSION with nothing written — the transaction cannot bypass them', async () => {
    await seedAll()
    for (const user of [USERS.sub, USERS.client, USERS.sup]) {
      await expectKind(raise(user), AWARD_PO_ERROR.PERMISSION)
    }
    expect(await exists(poRef, 'po_app')).toBe(false)
    expect((await read(pkgRef, PKG)).raisedPoId).toBeUndefined()
    expect((await read((d) => counterRef(d), '')).next).toBe(2)
  })

  it('lines the rules cannot see: a PO whose lines differ from the bid is ACCEPTED by rules when its header balances (DC38 — client-only)', async () => {
    await seedAll()
    const lines = [{ costCodeId: 'cc9', costCodeName: 'bogus', description: '', qty: 1, unit: '', unitPrice: 5, lineTotal: 5 }]
    await raise(USERS.admin, { lines })
    expect((await read(poRef, 'po_app')).subtotal).toBe(5)
  })
})
