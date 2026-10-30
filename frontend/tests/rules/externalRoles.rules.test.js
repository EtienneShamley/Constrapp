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
  collection, collectionGroup, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── External-role financial read containment — emulator tests (ADR-56, M2-A) ──
//
// THE RISK THIS SUITE CLOSES. Until ADR-56 the `costCodes`, `budgetLines`,
// `purchaseOrders` and `progressClaims` blocks allowed READ to any provisioned
// member of the company — `users/{uid}.companyId == companyId` and nothing
// else. A user provisioned as `subcontractor` or `client` could therefore read
// every project's approved budget by cost code, every supplier's PO pricing and
// every progress claim's certified amounts and assessment notes, company-wide.
// Membership is company-wide (Deferred Control 20), so no project boundary
// limited it either. M2-A moves those four read sets to the SAME
// `financialMember()` predicate twenty other collections already use.
//
// WHAT THIS SUITE PROVES, collection by collection, for `get` AND `list`:
//   · company_admin / project_manager / qs — ALLOWED (unchanged)
//   · subcontractor / client — DENIED (the change)
//   · super_admin — DENIED (no special power; it was a plain member before and
//     is now outside the financial set, exactly like the other 20 collections)
//   · an UNKNOWN role string, a membership document with NO role, a signed-in
//     user with NO membership document, an anonymous caller, and a financial
//     role in ANOTHER company — all DENIED
//   · the WRITE rules are unchanged: the three financial roles still create and
//     update; the external roles still cannot; delete stays blocked for all
//   · NO OVERLAPPING MATCH grants a path these blocks deny: a collection-group
//     query over any of the four names and a document nested one level too deep
//     are denied for every caller, financial roles included
//   · the NEIGHBOURING SURFACES ARE UNTOUCHED — neither restricted nor newly
//     opened: `projects`, `drawings`, project-visibility `documents` and the
//     Storage objects behind them still read for subcontractor / client, and
//     the write sets, the `internal` document gate and the cross-company
//     denials are what they were.
//
// It runs against BOTH emulators, because the Storage checks perform a
// `firestore.get()`. `npm run test:rules` starts firestore and storage together.
//
// ⚠️ What this suite does NOT prove: that any external user exists in
// production, or that the published ruleset is this file. Both are console
// facts (docs/DEPLOYMENT.md → Verifying which rules version is published).
//
// SAFETY: refuses to run unless both emulator host variables are set.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIRESTORE_RULES_PATH = resolve(HERE, '../../firestore.rules')
const STORAGE_RULES_PATH   = resolve(HERE, '../../storage.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const PROJECT_B = 'projectB'   // Company B's project

const USERS = {
  admin:   { uid: 'u_admin',   role: 'company_admin',   companyId: COMPANY_A },
  pm:      { uid: 'u_pm',      role: 'project_manager', companyId: COMPANY_A },
  qs:      { uid: 'u_qs',      role: 'qs',              companyId: COMPANY_A },
  sub:     { uid: 'u_sub',     role: 'subcontractor',   companyId: COMPANY_A },
  client:  { uid: 'u_client',  role: 'client',          companyId: COMPANY_A },
  sadmin:  { uid: 'u_sadmin',  role: 'super_admin',     companyId: COMPANY_A },
  unknown: { uid: 'u_unknown', role: 'auditor',         companyId: COMPANY_A }, // not a recognised role
  norole:  { uid: 'u_norole',                           companyId: COMPANY_A }, // membership doc without `role`
  other:   { uid: 'u_other',   role: 'company_admin',   companyId: COMPANY_B }, // financial role, other tenant
}
const UNPROVISIONED_UID = 'u_unprovisioned' // signed in, no users/{uid} document

const FINANCIAL = ['admin', 'pm', 'qs']
const EXTERNAL  = ['sub', 'client']
const OTHER_MEMBERS = ['sadmin', 'unknown', 'norole']   // provisioned in Company A, outside the financial set
const DENIED_READERS = [...EXTERNAL, ...OTHER_MEMBERS, 'other']

let testEnv

const ctx  = (user) => testEnv.authenticatedContext(user.uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()
const orphan = () => testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()

const profileFor = (user) => {
  const p = { companyId: user.companyId, name: user.uid }
  if (user.role) p.role = user.role
  return p
}

// ── The four contained collections ───────────────────────────────────────────
//
// `path(companyId, projectId)` → the collection path; `seed` → a stored
// document shaped like the hook writes it; `create` → a payload the CREATE
// rule accepts from a financial role; `update` → a payload the UPDATE rule
// accepts (costCodes and budgetLines have shape rules; POs and claims do not).

const COLLECTIONS = {
  costCodes: {
    path: (c = COMPANY_A) => `companies/${c}/costCodes`,
    seed: {
      code: '03-100', name: 'Concrete Slab', category: 'Structure', unit: 'm3', isActive: true,
      createdAt: new Date('2026-01-05T00:00:00Z'), createdBy: 'u_pm',
    },
    create: (user) => ({
      code: '05-200', name: 'Structural Steel', category: 'Structure', unit: 't', isActive: true,
      createdAt: serverTimestamp(), createdBy: user.uid,
    }),
    update: (user) => ({ name: 'Concrete Slab (revised)', updatedAt: serverTimestamp(), updatedBy: user.uid }),
  },
  budgetLines: {
    path: (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/budgetLines`,
    seed: {
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', budgeted: 100_000,
      committed: 0, actual: 0, invoiced: 0, notes: 'Slab package',
      createdAt: new Date('2026-01-05T00:00:00Z'), createdBy: 'u_pm',
    },
    create: (user) => ({
      costCodeId: 'cc2', costCodeName: '05-200 — Structural Steel', budgeted: 60_000,
      committed: 0, actual: 0, invoiced: 0, notes: '',
      createdAt: serverTimestamp(), createdBy: user.uid,
    }),
    update: (user) => ({ budgeted: 120_000, updatedAt: serverTimestamp(), updatedBy: user.uid }),
  },
  // ADR-57 (M2-B1) REVISED THESE FIXTURES, NOT THE ASSERTIONS. When this suite
  // was written (ADR-56) the PO write rule was tenant-and-role only, so the
  // update was a bare `{ notes }`. The PO block now enforces the lifecycle:
  // every write carries `updatedAt`/`updatedBy`, a create carries the exact
  // key set with ≥ 1 line, and a transition is stamps-only. ADR-58 (M2-B2)
  // revised them once more: a claim create now get()s its PO, which must be
  // SENT in the same project, so the ONE seeded PO (the list tests pin exactly
  // one document per collection) is `sent` with the full ADR-57 shape and its
  // update payload is the `sent → closed` transition
  // (lib/purchaseOrderActions.js → transitionUpdate) — the read matrix this
  // suite exists for does not depend on status. The lifecycles themselves are
  // proven in purchaseOrders.rules.test.js and progressClaims.rules.test.js.
  purchaseOrders: {
    path: (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/purchaseOrders`,
    seed: {
      poNumber: 'PO-0001', status: 'sent', supplierName: 'Acme Concrete', supplierId: 'contact1',
      description: 'Slab pour', lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', description: 'Pour', qty: 1, unit: 'ea', unitPrice: 800, lineTotal: 800 },
      ],
      subtotal: 800, gst: 80, total: 880, currency: 'AUD', revision: 1, notes: '',
      sentAt: new Date('2026-01-21T00:00:00Z'), sentBy: 'u_admin', closedAt: null, closedBy: null, cancelledAt: null, cancelledBy: null, externalRefs: {},
      createdAt: new Date('2026-01-20T00:00:00Z'), createdBy: 'u_qs',
      updatedAt: new Date('2026-01-21T00:00:00Z'), updatedBy: 'u_admin',
    },
    create: (user) => ({
      poNumber: 'PO-0002', status: 'draft', supplierName: 'Beta Steel', supplierId: null,
      description: '', lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', description: '', qty: 0, unit: '', unitPrice: 0, lineTotal: 0 },
      ],
      subtotal: 0, gst: 0, total: 0, currency: 'AUD', revision: 1, notes: '',
      sentAt: null, sentBy: null, closedAt: null, closedBy: null, cancelledAt: null, cancelledBy: null, externalRefs: {},
      createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    }),
    update: (user) => ({ status: 'closed', closedAt: serverTimestamp(), closedBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid }),
  },
  // ADR-58 (M2-B2) REVISED THESE FIXTURES, NOT THE ASSERTIONS — the same
  // revision ADR-57 made to the PO fixtures above. The claim block now
  // enforces the lifecycle: content edits are draft-only, every write carries
  // `updatedAt`/`updatedBy` and `revision + 1`, a create carries the exact key
  // set with ≥ 1 line and a balanced header against a SENT same-project PO
  // (the seeded PO above) whose number, supplier and line count it must match.
  // The seed is therefore a DRAFT with the full ADR-58 shape and the create /
  // update payloads are what hooks/useProgressClaims.jsx writes — the read
  // matrix this suite exists for does not depend on status. The lifecycle
  // itself is proven in progressClaims.rules.test.js.
  progressClaims: {
    path: (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/progressClaims`,
    seed: {
      claimNumber: 'PC-0001', status: 'draft', poId: 'seeded' /* SEED_ID — the one seeded PO */, poNumber: 'PO-0001',
      supplierName: 'Acme Concrete', supplierId: 'contact1', claimRef: 'INV-77', periodEnding: '2026-02-28',
      variationId: null, variationLineCount: 0,
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', description: 'Pour',
        poLineTotal: 800, previouslyApproved: 0, claimedToDate: 300, claimedThisPeriod: 300, approvedThisPeriod: null }],
      retention: 0, claimedSubtotal: 300, claimedGst: 30, claimedTotal: 330,
      approvedSubtotal: null, approvedGst: null, approvedTotal: null,
      notes: '', assessmentNotes: '', currency: 'AUD', revision: 1,
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
      externalRefs: {},
      createdAt: new Date('2026-03-01T00:00:00Z'), createdBy: 'u_qs',
      updatedAt: new Date('2026-03-01T00:00:00Z'), updatedBy: 'u_qs',
    },
    create: (user) => ({
      claimNumber: 'PC-0002', status: 'draft', poId: 'seeded' /* SEED_ID — the one seeded PO */, poNumber: 'PO-0001',
      supplierName: 'Acme Concrete', supplierId: 'contact1', claimRef: '', periodEnding: '', variationId: null, variationLineCount: 0,
      lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', description: 'Pour',
        poLineTotal: 800, previouslyApproved: 0, claimedToDate: 100, claimedThisPeriod: 100, approvedThisPeriod: null }],
      retention: 0, claimedSubtotal: 100, claimedGst: 10, claimedTotal: 110,
      approvedSubtotal: null, approvedGst: null, approvedTotal: null, notes: '', assessmentNotes: '',
      currency: 'AUD', revision: 1,
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, invoicedAt: null,
      externalRefs: {}, createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    }),
    update: (user) => ({ notes: 'Updated by a financial role', revision: 2, updatedAt: serverTimestamp(), updatedBy: user.uid }),
  },
}
const NAMES = Object.keys(COLLECTIONS)
const SEED_ID = 'seeded'

const docRef = (db, name, id = SEED_ID, companyId = COMPANY_A, projectId = PROJECT_A) =>
  doc(db, COLLECTIONS[name].path(companyId, projectId), id)
const colRef = (db, name, companyId = COMPANY_A, projectId = PROJECT_A) =>
  collection(db, COLLECTIONS[name].path(companyId, projectId))

// ── Neighbouring surfaces that must NOT move ─────────────────────────────────

const projectRef  = (db, c = COMPANY_A, p = PROJECT_A) => doc(db, 'companies', c, 'projects', p)
const drawingRef  = (db, c = COMPANY_A, p = PROJECT_A) => doc(db, 'companies', c, 'projects', p, 'drawings', 'dwg1')
const documentRef = (db, id, c = COMPANY_A, p = PROJECT_A) => doc(db, 'companies', c, 'projects', p, 'documents', id)

const PDF = 'application/pdf'
const drawingObject  = (c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/drawings/dwg1/rev1/original.pdf`
const documentObject = (id, c = COMPANY_A, p = PROJECT_A) => `companies/${c}/projects/${p}/documents/${id}/original.pdf`
const storageOf = (user) => testEnv.authenticatedContext(user.uid).storage()
const readObject = (user, path) => storageOf(user).ref(path).getDownloadURL()

function drawingPayload() {
  return {
    drawingNumber: 'A-101', title: 'Ground Floor Plan', discipline: 'architectural', description: '',
    status: 'active', currentRevisionId: null, currentRevisionCode: '', currentRevisionIssuedDate: null,
    revisionCount: 0, revisionSchemaVersion: 1, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
  }
}

function documentPayload(id, visibility) {
  return {
    name: 'Seeded', category: 'specification', visibility,
    versionLabel: '', documentDate: null, status: 'active', supersededByDocumentId: null, notes: '',
    fileName: 'seed.pdf', fileExt: 'pdf', fileSize: 1024, contentType: PDF,
    storagePath: documentObject(id),
    withdrawnAt: null, withdrawnBy: null, withdrawReason: '', revision: 1,
    createdAt: Timestamp.now(), createdBy: USERS.admin.uid, updatedAt: Timestamp.now(), updatedBy: USERS.admin.uid,
  }
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST are not both set — refusing to run ' +
      'Rules tests outside the emulators. Run `npm run test:rules`.',
    )
  }
  const [fsHost, fsPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  const [stHost, stPort] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(FIRESTORE_RULES_PATH, 'utf8'), host: fsHost, port: Number(fsPort) },
    storage:   { rules: readFileSync(STORAGE_RULES_PATH, 'utf8'),   host: stHost, port: Number(stPort) },
  })
})

afterAll(async () => {
  if (testEnv) await testEnv.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.clearStorage()
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), profileFor(u))
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Apex Builders' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    for (const [c, p] of [[COMPANY_A, PROJECT_A], [COMPANY_B, PROJECT_B]]) {
      await setDoc(projectRef(db, c, p), {
        name: 'Lakeside', status: 'In Progress', budget: 0, currency: 'AUD', currencyLocked: true,
        createdAt: Timestamp.now(), createdBy: USERS.admin.uid,
      })
      for (const name of NAMES) {
        await setDoc(docRef(db, name, SEED_ID, c, p), COLLECTIONS[name].seed)
      }
    }
    await setDoc(drawingRef(db), drawingPayload())
    await setDoc(documentRef(db, 'docProject'),  documentPayload('docProject', 'project'))
    await setDoc(documentRef(db, 'docInternal'), documentPayload('docInternal', 'internal'))
    const st = c.storage()
    await st.ref(drawingObject()).put(new Uint8Array(1024), { contentType: PDF })
    await st.ref(documentObject('docProject')).put(new Uint8Array(1024), { contentType: PDF })
    await st.ref(documentObject('docInternal')).put(new Uint8Array(1024), { contentType: PDF })
  })
})

// ── A. GET — one document ────────────────────────────────────────────────────

for (const name of NAMES) {
  describe(`${name} — get (ADR-56)`, () => {
    for (const key of FINANCIAL) {
      it(`${USERS[key].role} reads a ${name} document (unchanged)`, async () => {
        const snap = await assertSucceeds(getDoc(docRef(ctx(USERS[key]), name)))
        expect(snap.exists()).toBe(true)
      })
    }
    for (const key of EXTERNAL) {
      it(`${USERS[key].role} CANNOT read a ${name} document (the M2-A change)`, async () => {
        await assertFails(getDoc(docRef(ctx(USERS[key]), name)))
      })
    }
    it(`super_admin CANNOT read a ${name} document (no special power)`, async () => {
      await assertFails(getDoc(docRef(ctx(USERS.sadmin), name)))
    })
    it(`an UNKNOWN role ('auditor') CANNOT read a ${name} document`, async () => {
      await assertFails(getDoc(docRef(ctx(USERS.unknown), name)))
    })
    it(`a membership document with NO role CANNOT read a ${name} document`, async () => {
      await assertFails(getDoc(docRef(ctx(USERS.norole), name)))
    })
    it(`a signed-in user with NO membership document CANNOT read a ${name} document`, async () => {
      await assertFails(getDoc(docRef(orphan(), name)))
    })
    it(`an anonymous caller CANNOT read a ${name} document`, async () => {
      await assertFails(getDoc(docRef(anon(), name)))
    })
    it(`a company_admin of ANOTHER company CANNOT read a Company A ${name} document`, async () => {
      await assertFails(getDoc(docRef(ctx(USERS.other), name)))
    })
    it(`a Company A company_admin CANNOT read a Company B ${name} document`, async () => {
      await assertFails(getDoc(docRef(ctx(USERS.admin), name, SEED_ID, COMPANY_B, PROJECT_B)))
    })
  })
}

// ── B. LIST — the collection query every hook issues ─────────────────────────

for (const name of NAMES) {
  describe(`${name} — list (ADR-56)`, () => {
    for (const key of FINANCIAL) {
      it(`${USERS[key].role} lists ${name} (unchanged)`, async () => {
        const snap = await assertSucceeds(getDocs(colRef(ctx(USERS[key]), name)))
        expect(snap.size).toBe(1)
      })
    }
    for (const key of DENIED_READERS) {
      it(`${USERS[key].role ?? 'a role-less member'} (${key}) CANNOT list ${name}`, async () => {
        await assertFails(getDocs(colRef(ctx(USERS[key]), name)))
      })
    }
    it(`a signed-in user with NO membership document CANNOT list ${name}`, async () => {
      await assertFails(getDocs(colRef(orphan(), name)))
    })
    it(`an anonymous caller CANNOT list ${name}`, async () => {
      await assertFails(getDocs(colRef(anon(), name)))
    })
  })
}

// ── C. WRITES — unchanged by M2-A ────────────────────────────────────────────

for (const name of NAMES) {
  describe(`${name} — writes unchanged`, () => {
    for (const key of FINANCIAL) {
      it(`${USERS[key].role} can still create a ${name} document`, async () => {
        await assertSucceeds(setDoc(docRef(ctx(USERS[key]), name, `new-${key}`), COLLECTIONS[name].create(USERS[key])))
      })
      it(`${USERS[key].role} can still update a ${name} document`, async () => {
        await assertSucceeds(updateDoc(docRef(ctx(USERS[key]), name), COLLECTIONS[name].update(USERS[key])))
      })
    }
    for (const key of [...EXTERNAL, 'sadmin', 'unknown', 'norole', 'other']) {
      it(`${USERS[key].role ?? 'a role-less member'} (${key}) still CANNOT create a ${name} document`, async () => {
        await assertFails(setDoc(docRef(ctx(USERS[key]), name, `new-${key}`), COLLECTIONS[name].create(USERS[key])))
      })
    }
    it(`company_admin still CANNOT delete a ${name} document`, async () => {
      await assertFails(deleteDoc(docRef(ctx(USERS.admin), name)))
    })
  })
}

// ── D. NO OVERLAPPING MATCH GRANTS WHAT THESE BLOCKS DENY ────────────────────
//
// Firestore grants when ANY matching rule allows. These prove no wider or
// recursive match exists for the four names: a collection-group query (which
// needs a `match /{path=**}/<name>/{id}` rule) and a document nested one level
// below a contained document are denied for EVERY caller, financial roles
// included.

describe('no alternate match grants access', () => {
  for (const name of NAMES) {
    it(`a collection-group query over '${name}' is denied for company_admin and subcontractor alike`, async () => {
      await assertFails(getDocs(collectionGroup(ctx(USERS.admin), name)))
      await assertFails(getDocs(collectionGroup(ctx(USERS.sub), name)))
    })
    it(`a document nested under a ${name} document matches no rule`, async () => {
      const nested = (db) => doc(db, COLLECTIONS[name].path(), SEED_ID, 'nested', 'x')
      await testEnv.withSecurityRulesDisabled(async (c) => {
        await setDoc(nested(c.firestore()), { leaked: true })
      })
      await assertFails(getDoc(nested(ctx(USERS.admin))))
      await assertFails(getDoc(nested(ctx(USERS.sub))))
    })
  }
})

// ── E. NEIGHBOURING SURFACES UNCHANGED ───────────────────────────────────────
//
// Each case pins BOTH directions: still readable where it was, still denied
// where it was. A regression in either direction fails here.

describe('projects — read audience unchanged (every company member)', () => {
  for (const key of [...FINANCIAL, ...EXTERNAL, 'sadmin']) {
    it(`${USERS[key].role} still reads the project document and lists projects`, async () => {
      await assertSucceeds(getDoc(projectRef(ctx(USERS[key]))))
      const snap = await assertSucceeds(getDocs(collection(ctx(USERS[key]), 'companies', COMPANY_A, 'projects')))
      expect(snap.size).toBe(1)
    })
  }
  it('another company, an orphan and an anonymous caller are still denied', async () => {
    await assertFails(getDoc(projectRef(ctx(USERS.other))))
    await assertFails(getDoc(projectRef(orphan())))
    await assertFails(getDoc(projectRef(anon())))
  })
  it('subcontractor and client still CANNOT create or update a project', async () => {
    for (const key of EXTERNAL) {
      await assertFails(setDoc(projectRef(ctx(USERS[key]), COMPANY_A, 'newProject'), {
        name: 'New', status: 'Planning', budget: 0, startDate: null, location: '', progress: 0,
        currency: 'AUD', currencyLocked: false, createdAt: serverTimestamp(), createdBy: USERS[key].uid,
      }))
      await assertFails(updateDoc(projectRef(ctx(USERS[key])), { name: 'Renamed' }))
    }
  })
})

describe('drawings — read audience unchanged (every company member)', () => {
  for (const key of [...FINANCIAL, ...EXTERNAL, 'sadmin']) {
    it(`${USERS[key].role} still reads the drawing master`, async () => {
      await assertSucceeds(getDoc(drawingRef(ctx(USERS[key]))))
    })
  }
  it('another company and an anonymous caller are still denied', async () => {
    await assertFails(getDoc(drawingRef(ctx(USERS.other))))
    await assertFails(getDoc(drawingRef(anon())))
  })
  it('subcontractor, client and qs still CANNOT create a drawing', async () => {
    for (const key of ['sub', 'client', 'qs']) {
      await assertFails(setDoc(doc(ctx(USERS[key]), 'companies', COMPANY_A, 'projects', PROJECT_A, 'drawings', 'dwgNew'), {
        ...drawingPayload(), createdAt: serverTimestamp(), createdBy: USERS[key].uid,
        updatedAt: serverTimestamp(), updatedBy: USERS[key].uid,
      }))
    }
  })
})

describe('documents — visibility gate unchanged', () => {
  for (const key of EXTERNAL) {
    it(`${USERS[key].role} still reads a project-visibility document and is still denied an internal one`, async () => {
      await assertSucceeds(getDoc(documentRef(ctx(USERS[key]), 'docProject')))
      await assertFails(getDoc(documentRef(ctx(USERS[key]), 'docInternal')))
    })
  }
  it('qs still reads both visibilities; another company reads neither', async () => {
    await assertSucceeds(getDoc(documentRef(ctx(USERS.qs), 'docProject')))
    await assertSucceeds(getDoc(documentRef(ctx(USERS.qs), 'docInternal')))
    await assertFails(getDoc(documentRef(ctx(USERS.other), 'docProject')))
  })
})

describe('Storage — unchanged (storage.rules is not part of M2-A)', () => {
  for (const key of EXTERNAL) {
    it(`${USERS[key].role} still reads a drawing file and a project-visibility document file`, async () => {
      await assertSucceeds(readObject(USERS[key], drawingObject()))
      await assertSucceeds(readObject(USERS[key], documentObject('docProject')))
    })
    it(`${USERS[key].role} is still denied an internal document file`, async () => {
      await assertFails(readObject(USERS[key], documentObject('docInternal')))
    })
  }
  it('another company is still denied every object', async () => {
    await assertFails(readObject(USERS.other, drawingObject()))
    await assertFails(readObject(USERS.other, documentObject('docProject')))
  })
})
