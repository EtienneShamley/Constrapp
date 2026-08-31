import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp } from 'firebase/firestore'

// ── companies/{companyId}/costCodes/{costCodeId} Security Rules ──────────────
//
// Cost codes are THE commercial spine: every budget line, PO line, claim line,
// supplier-invoice line, credit-note line, variation line, BOQ item, forecast
// line and cash-flow line joins through `costCodeId`. Until ADR-39 they were
// create-only in the UI and `create, update` was ONE unconstrained rule, so a
// correction could rewrite provenance or invent fields.
//
// The enforced contract, in full:
//   · READ    — any provisioned member of the owning company, every role.
//   · CREATE  — company_admin / project_manager / qs.
//   · UPDATE  — the same three roles, restricted to `code`, `name`, `category`,
//               `unit`, `isActive` and the audit stamps, with `createdAt` /
//               `createdBy` frozen and every field shape-validated.
//   · DELETE  — blocked for everyone; deactivation is the retirement path.
//
// ⚠️ WHAT THESE RULES DELIBERATELY DO NOT ENFORCE — and this suite proves the
// gap rather than hiding it (docs/SECURITY.md → Deferred Control 28):
//   · `code` UNIQUENESS. Rules have no list, query or count and cannot see
//     sibling documents. The check lives in lib/costCodes.js and is CLIENT-SIDE
//     ONLY. Group F proves a duplicate is accepted at the boundary.
//   · that deactivating a code in use is safe — it always is, and it is
//     deliberately never blocked.
//
// Renaming needs no rule guard because it is safe by construction: every
// derivation groups by the DOCUMENT ID, and historical `costCodeName` snapshots
// are never rewritten. That invariance is proved numerically in
// tests/unit/foundationEditInvariance.test.js.
//
// This suite constrains NO timestamp field (the cost-code stamps are not
// rules-verified — only budget lines carry that requirement), so the
// deliberately-skewed client clocks required elsewhere (docs/TESTING.md §0) do
// not apply here.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set, so it can never
// reach a production Firebase project.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const CODE_A = 'costCodeA'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  sadmin: { uid: 'u_sadmin', role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

const UNPROVISIONED_UID = 'u_unprovisioned'

// The three roles that own budgets and forecasting (PRODUCT.md).
const WRITERS = ['admin', 'pm', 'qs']
// Every role that must NOT be able to write a cost code.
const NON_WRITERS = ['sub', 'client', 'sadmin']

let testEnv

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const codeRef = (db, companyId = COMPANY_A, codeId = CODE_A) =>
  doc(db, 'companies', companyId, 'costCodes', codeId)
const profileFor = (user) => ({ role: user.role, companyId: user.companyId, name: user.uid })

const STORED_CODE = {
  code: '03-100',
  name: 'Concrete Slab',
  category: 'Structure',
  unit: 'm3',
  isActive: true,
  createdAt: new Date('2026-01-05T00:00:00Z'),
  createdBy: USERS.pm.uid,
}

async function seed(fields = {}, codeId = CODE_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(codeRef(c.firestore(), COMPANY_A, codeId), { ...STORED_CODE, ...fields })
  })
}

async function stored(codeId = CODE_A) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    data = (await getDoc(codeRef(c.firestore(), COMPANY_A, codeId))).data()
  })
  return data
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
      await setDoc(doc(db, 'users', u.uid), profileFor(u))
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Apex Builders' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(codeRef(db, COMPANY_B), STORED_CODE)
  })
})

// ── A. READ ─────────────────────────────────────────────────────────────────
//
// Role-agnostic on purpose: a cost code is a taxonomy label, not commercially
// sensitive, and every role's screens render cost-code names.

describe('costCodes — read', () => {
  it('every provisioned Company A role can read a cost code', async () => {
    await seed()
    for (const key of ['admin', 'pm', 'qs', 'sub', 'client', 'sadmin']) {
      const snap = await assertSucceeds(getDoc(codeRef(ctx(USERS[key]))))
      expect(snap.data().code).toBe('03-100')
    }
  })

  it('a Company B user cannot read a Company A cost code', async () => {
    await seed()
    await assertFails(getDoc(codeRef(ctx(USERS.other))))
  })

  it('a Company A admin cannot read a Company B cost code', async () => {
    await assertFails(getDoc(codeRef(ctx(USERS.admin), COMPANY_B)))
  })

  it('an unauthenticated caller cannot read any cost code', async () => {
    await seed()
    await assertFails(getDoc(codeRef(testEnv.unauthenticatedContext().firestore())))
  })

  it('an authenticated caller with NO membership document cannot read', async () => {
    await seed()
    await assertFails(getDoc(codeRef(testEnv.authenticatedContext(UNPROVISIONED_UID).firestore())))
  })
})

// ── B. CREATE ───────────────────────────────────────────────────────────────

describe('costCodes — create', () => {
  const payload = (extra = {}) => ({
    code: '05-200', name: 'Structural Steel', category: 'Structure', unit: 't',
    isActive: true, createdAt: serverTimestamp(), createdBy: USERS.pm.uid, ...extra,
  })

  for (const key of WRITERS) {
    it(`${USERS[key].role} can create a cost code`, async () => {
      await assertSucceeds(setDoc(codeRef(ctx(USERS[key]), COMPANY_A, `new-${key}`), payload()))
    })
  }

  for (const key of NON_WRITERS) {
    it(`${USERS[key].role} CANNOT create a cost code`, async () => {
      await assertFails(setDoc(codeRef(ctx(USERS[key]), COMPANY_A, `new-${key}`), payload()))
    })
  }

  it('a Company B admin cannot create in Company A', async () => {
    await assertFails(setDoc(codeRef(ctx(USERS.other), COMPANY_A, 'cross'), payload()))
  })

  it('an unprovisioned caller cannot create', async () => {
    const db = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    await assertFails(setDoc(codeRef(db, COMPANY_A, 'orphan'), payload()))
  })
})

// ── C. UPDATE — the ADR-39 correction path ──────────────────────────────────

describe('costCodes — update: who may correct a cost code', () => {
  for (const key of WRITERS) {
    it(`${USERS[key].role} can rename a cost code`, async () => {
      await seed()
      await assertSucceeds(updateDoc(codeRef(ctx(USERS[key])), { code: '03-110', name: 'Suspended Slab' }))
      const after = await stored()
      expect(after.code).toBe('03-110')
      expect(after.name).toBe('Suspended Slab')
    })
  }

  for (const key of NON_WRITERS) {
    it(`${USERS[key].role} CANNOT update a cost code`, async () => {
      await seed()
      await assertFails(updateDoc(codeRef(ctx(USERS[key])), { name: 'Hacked' }))
    })
  }

  it('a Company B admin cannot update a Company A cost code', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.other)), { name: 'Cross-tenant' }))
  })
})

describe('costCodes — update: provenance is immutable', () => {
  it('rewriting createdBy is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { createdBy: USERS.admin.uid }))
    expect((await stored()).createdBy).toBe(USERS.pm.uid)
  })

  it('rewriting createdAt is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { createdAt: serverTimestamp() }))
  })

  it('DELETING createdAt is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { createdAt: deleteField() }))
  })

  it('provenance rewritten alongside a legitimate rename is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), {
      name: 'Legitimate rename', createdBy: USERS.admin.uid,
    }))
    expect((await stored()).name).toBe('Concrete Slab')
  })
})

describe('costCodes — update: the key allow-list', () => {
  it('accepts every allowed key in one write', async () => {
    await seed()
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.qs)), {
      code: '03-110', name: 'Suspended Slab', category: 'Superstructure', unit: 'm2',
      isActive: false, updatedAt: serverTimestamp(), updatedBy: USERS.qs.uid,
    }))
  })

  it('REJECTS an arbitrary new field', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { rate: 1234 }))
  })

  it('REJECTS a smuggled financial-looking field', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { budgeted: 999999 }))
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { committed: 50_000 }))
  })

  it('REJECTS an arbitrary field smuggled alongside a legitimate rename', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { name: 'Fine', isSuperCode: true }))
  })
})

describe('costCodes — update: field shapes', () => {
  it('REJECTS a blank or whitespace-only code', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { code: '' }))
  })

  it('REJECTS a deleted code or name', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { code: deleteField() }))
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { name: deleteField() }))
  })

  it('REJECTS a blank name', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { name: '' }))
  })

  it('REJECTS a non-string code or name', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { code: 3100 }))
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { name: { v: 'x' } }))
  })

  it('REJECTS an over-long code, name, category or unit', async () => {
    await seed()
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { code: 'x'.repeat(41) }))
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { name: 'x'.repeat(121) }))
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { category: 'x'.repeat(81) }))
    await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { unit: 'x'.repeat(25) }))
  })

  it('ACCEPTS the maximum permitted lengths', async () => {
    await seed()
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.admin)), {
      code: 'x'.repeat(40), name: 'y'.repeat(120), category: 'z'.repeat(80), unit: 'u'.repeat(24),
    }))
  })

  it('ACCEPTS a blank category and unit — both are optional', async () => {
    await seed()
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.admin)), { category: '', unit: '' }))
  })

  it('REJECTS a non-bool isActive', async () => {
    await seed()
    for (const bad of ['false', 0, 1, null]) {
      await assertFails(updateDoc(codeRef(ctx(USERS.admin)), { isActive: bad }))
    }
  })
})

// ── D. DEACTIVATE / REACTIVATE — administrative and reversible ──────────────

describe('costCodes — deactivation is reversible in both directions', () => {
  it('active -> inactive is accepted', async () => {
    await seed({ isActive: true })
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.qs)), { isActive: false }))
    expect((await stored()).isActive).toBe(false)
  })

  it('inactive -> active is accepted — there is no terminal state', async () => {
    // Deactivation is administrative, not a financial lifecycle: it removes a
    // code from NEW authoring only, so it must never be one-way.
    await seed({ isActive: false })
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.qs)), { isActive: true }))
    expect((await stored()).isActive).toBe(true)
  })

  it('an inactive cost code may still be RENAMED', async () => {
    await seed({ isActive: false })
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.admin)), { name: 'Retired — corrected' }))
  })

  it('a LEGACY document with no isActive key remains writable and stays active', async () => {
    // Absent means ACTIVE. Requiring the key would make every pre-flag cost
    // code permanently unwritable.
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(codeRef(c.firestore(), COMPANY_A, 'legacy'), {
        code: '01-000', name: 'Preliminaries',
        createdAt: new Date('2025-01-01T00:00:00Z'), createdBy: USERS.pm.uid,
      })
    })
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.admin), COMPANY_A, 'legacy'), { name: 'Prelims' }))
    const after = await stored('legacy')
    expect(after.name).toBe('Prelims')
    expect('isActive' in after).toBe(false)
  })
})

// ── E. DELETE — blocked for everyone ────────────────────────────────────────

describe('costCodes — delete is blocked', () => {
  for (const key of Object.keys(USERS)) {
    it(`${USERS[key].role} (${key}) cannot delete a cost code`, async () => {
      await seed()
      await assertFails(deleteDoc(codeRef(ctx(USERS[key]))))
    })
  }

  it('an unauthenticated caller cannot delete', async () => {
    await seed()
    await assertFails(deleteDoc(codeRef(testEnv.unauthenticatedContext().firestore())))
  })

  it('the document survives every delete attempt', async () => {
    await seed()
    for (const key of WRITERS) await assertFails(deleteDoc(codeRef(ctx(USERS[key]))))
    expect((await stored()).code).toBe('03-100')
  })
})

// ── F. THE DOCUMENTED GAP — uniqueness is CLIENT-ENFORCED ONLY ──────────────

describe('costCodes — duplicate codes are NOT rejected by rules (Deferred Control 28)', () => {
  it('a DUPLICATE code is accepted at the trust boundary', async () => {
    // Firestore rules have no list, query or count, so they cannot see sibling
    // documents. lib/costCodes.js blocks this in the app; a direct SDK call and
    // two concurrent writers both bypass it. Nothing breaks — the document id
    // remains the financial key — but list ordering becomes ambiguous. This
    // test exists so the gap is proven and documented, never assumed closed.
    await seed({ code: '03-100' }, 'first')
    await assertSucceeds(setDoc(codeRef(ctx(USERS.admin), COMPANY_A, 'second'), {
      code: '03-100', name: 'Duplicate of the first', category: '', unit: '',
      isActive: true, createdAt: serverTimestamp(), createdBy: USERS.admin.uid,
    }))
    expect((await stored('second')).code).toBe('03-100')
  })

  it('RENAMING onto an existing code is also accepted at the boundary', async () => {
    await seed({ code: '03-100' }, 'first')
    await seed({ code: '05-200' }, 'second')
    await assertSucceeds(updateDoc(codeRef(ctx(USERS.admin), COMPANY_A, 'second'), { code: '03-100' }))
  })
})
