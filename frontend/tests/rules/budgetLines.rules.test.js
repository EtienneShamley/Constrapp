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
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── …/projects/{projectId}/budgetLines/{lineId} Security Rules ──────────────
//
// A budget line carries `budgeted` — THE only authoritative stored financial
// value on the cost side of a project. Everything else on the Budget tab
// (Committed, Claimed, Actual, Invoiced) is derived at read time from POs,
// claims, invoices and credit notes. Until ADR-39 budget lines were create-only
// in the UI and `create, update` was ONE unconstrained rule.
//
// The enforced contract, in full:
//   · READ    — any provisioned member of the owning company, every role.
//   · CREATE  — company_admin / project_manager / qs, with a non-empty
//               `costCodeId` and a numeric `budgeted` >= 0.
//   · UPDATE  — the same three roles, restricted to EXACTLY `budgeted`,
//               `notes` and the audit stamps.
//   · DELETE  — blocked for everyone.
//
// ⚠️ THE FOUR IMMUTABILITIES THIS SUITE EXISTS FOR:
//   1. `costCodeId` — THE COMMERCIAL SPINE. Re-pointing a line would relocate
//      an approved budget to another cost code underneath existing commitments
//      and actuals, with no record that it moved.
//   2. `costCodeName` — the frozen display snapshot. Deliberately NOT
//      re-snapshotted on edit (diverging from the ADR-36 PO editor, whose line
//      cost code CAN change in the same write): rewriting it during an edit
//      made only to a number would rewrite the line's recorded history. The
//      CURRENT name is resolved at read time instead.
//   3. `committed` / `actual` / `invoiced` — VESTIGIAL ZEROS written once at
//      creation and read by no consumer in the app. The allow-list freezes them
//      so an edit can never revive them as a second, stale source of truth.
//   4. `createdAt` / `createdBy` — provenance.
//
// ⚠️ THIS SUITE CONSTRAINS TIMESTAMPS. The update rule requires
// `updatedAt == request.time`, so the forged-stamp tests use DELIBERATELY
// SKEWED client clocks rather than `Timestamp.now()` (docs/TESTING.md §0): a
// bare `Timestamp.now()` can legitimately coincide with `request.time` and turn
// the assertion into a coin flip.
//
// ⚠️ WHAT THESE RULES DELIBERATELY DO NOT ENFORCE (docs/SECURITY.md → Deferred
// Control 28), proved in Group G rather than assumed closed:
//   · that `costCodeId` names a REAL, ACTIVE cost code — shape only, matching
//     the boqItems posture (Deferred Control 26).
//   · one-line-per-cost-code, or agreement with the BOQ — no sibling queries.
//   · concurrent-edit safety — last-write-wins, no version guard.
//
// The complementary half (what a budgeted edit does and does not move on the
// Budget, Forecast, Commercial, BOQ and Cash Flow tabs) is proved numerically
// in tests/unit/foundationEditInvariance.test.js.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'
const LINE_A = 'lineA'

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
const WRITERS = ['admin', 'pm', 'qs']
const NON_WRITERS = ['sub', 'client', 'sadmin']

// Client-supplied clock values that must NEVER satisfy `== request.time`.
// Deliberately skewed — see the header note and docs/TESTING.md §0.
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)),
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)),
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
]

let testEnv

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const lineRef = (db, companyId = COMPANY_A, lineId = LINE_A) =>
  doc(db, 'companies', companyId, 'projects', PROJECT_A, 'budgetLines', lineId)
const profileFor = (user) => ({ role: user.role, companyId: user.companyId, name: user.uid })

const STORED_LINE = {
  costCodeId: 'cc1',
  costCodeName: '03-100 — Concrete Slab',
  budgeted: 100_000,
  committed: 0,
  actual: 0,
  invoiced: 0,
  notes: 'Slab package',
  createdAt: new Date('2026-01-05T00:00:00Z'),
  createdBy: USERS.pm.uid,
}

// The audit stamps every legitimate edit carries.
const stamps = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })

async function seed(fields = {}, lineId = LINE_A) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(lineRef(c.firestore(), COMPANY_A, lineId), { ...STORED_LINE, ...fields })
  })
}

async function stored(lineId = LINE_A) {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    data = (await getDoc(lineRef(c.firestore(), COMPANY_A, lineId))).data()
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
    await setDoc(doc(db, 'companies', COMPANY_A, 'projects', PROJECT_A), {
      name: 'Lakeside', status: 'In Progress', budget: 0, currency: 'AUD', currencyLocked: true,
    })
    await setDoc(lineRef(db, COMPANY_B), STORED_LINE)
  })
})

// ── A. READ ─────────────────────────────────────────────────────────────────

describe('budgetLines — read', () => {
  it('every provisioned Company A role can read a budget line', async () => {
    await seed()
    for (const key of ['admin', 'pm', 'qs', 'sub', 'client', 'sadmin']) {
      const snap = await assertSucceeds(getDoc(lineRef(ctx(USERS[key]))))
      expect(snap.data().budgeted).toBe(100_000)
    }
  })

  it('a Company B user cannot read a Company A budget line', async () => {
    await seed()
    await assertFails(getDoc(lineRef(ctx(USERS.other))))
  })

  it('a Company A admin cannot read a Company B budget line', async () => {
    await assertFails(getDoc(lineRef(ctx(USERS.admin), COMPANY_B)))
  })

  it('an unauthenticated caller cannot read any budget line', async () => {
    await seed()
    await assertFails(getDoc(lineRef(testEnv.unauthenticatedContext().firestore())))
  })

  it('an authenticated caller with NO membership document cannot read', async () => {
    await seed()
    await assertFails(getDoc(lineRef(testEnv.authenticatedContext(UNPROVISIONED_UID).firestore())))
  })
})

// ── B. CREATE ───────────────────────────────────────────────────────────────

describe('budgetLines — create', () => {
  const payload = (extra = {}) => ({
    costCodeId: 'cc2', costCodeName: '05-200 — Structural Steel',
    budgeted: 60_000, committed: 0, actual: 0, invoiced: 0, notes: '',
    createdAt: serverTimestamp(), createdBy: USERS.pm.uid, ...extra,
  })

  for (const key of WRITERS) {
    it(`${USERS[key].role} can create a budget line`, async () => {
      await assertSucceeds(setDoc(lineRef(ctx(USERS[key]), COMPANY_A, `new-${key}`), payload()))
    })
  }

  for (const key of NON_WRITERS) {
    it(`${USERS[key].role} CANNOT create a budget line`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS[key]), COMPANY_A, `new-${key}`), payload()))
    })
  }

  it('a Company B admin cannot create in Company A', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.other), COMPANY_A, 'cross'), payload()))
  })

  it('a budget of ZERO is accepted — a reviewed allocation of nothing', async () => {
    await assertSucceeds(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'zero'), payload({ budgeted: 0 })))
  })

  it('a NEGATIVE budget is REJECTED at creation', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'neg'), payload({ budgeted: -1 })))
  })

  it('a non-numeric budget is REJECTED at creation', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 's'), payload({ budgeted: '60000' })))
    await assertFails(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'n'), payload({ budgeted: null })))
  })

  it('a blank or missing costCodeId is REJECTED — the spine is mandatory', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'b'), payload({ costCodeId: '' })))
    const { costCodeId, ...noCode } = payload()
    expect(costCodeId).toBeTruthy()
    await assertFails(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'm'), noCode))
  })
})

// ── C. UPDATE — the ADR-39 correction path ──────────────────────────────────

describe('budgetLines — update: who may correct a budget', () => {
  for (const key of WRITERS) {
    it(`${USERS[key].role} can correct budgeted and notes`, async () => {
      await seed()
      await assertSucceeds(updateDoc(lineRef(ctx(USERS[key])), {
        budgeted: 112_500, notes: 'Corrected', ...stamps(USERS[key]),
      }))
      const after = await stored()
      expect(after.budgeted).toBe(112_500)
      expect(after.notes).toBe('Corrected')
    })
  }

  for (const key of NON_WRITERS) {
    it(`${USERS[key].role} CANNOT correct a budget`, async () => {
      await seed()
      await assertFails(updateDoc(lineRef(ctx(USERS[key])), {
        budgeted: 1, ...stamps(USERS[key]),
      }))
    })
  }

  it('a Company B admin cannot update a Company A budget line', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.other)), { budgeted: 1, ...stamps(USERS.other) }))
  })
})

describe('budgetLines — update: the COST-CODE SPINE is immutable', () => {
  it('RE-POINTING costCodeId is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      costCodeId: 'cc2', ...stamps(USERS.admin),
    }))
    expect((await stored()).costCodeId).toBe('cc1')
  })

  it('re-pointing smuggled alongside a legitimate budget correction is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      budgeted: 112_500, costCodeId: 'cc2', ...stamps(USERS.admin),
    }))
    const after = await stored()
    expect(after.costCodeId).toBe('cc1')
    expect(after.budgeted).toBe(100_000)
  })

  it('DELETING costCodeId is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      costCodeId: deleteField(), ...stamps(USERS.admin),
    }))
  })

  it('RE-SNAPSHOTTING costCodeName is REJECTED — history is not rewritten', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      costCodeName: '03-110 — Concrete Slab — Suspended', ...stamps(USERS.admin),
    }))
    expect((await stored()).costCodeName).toBe('03-100 — Concrete Slab')
  })

  it('a costCodeName rewrite smuggled alongside a budget correction is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      budgeted: 112_500, costCodeName: 'renamed', ...stamps(USERS.admin),
    }))
  })
})

describe('budgetLines — update: the VESTIGIAL figures are frozen', () => {
  for (const field of ['committed', 'actual', 'invoiced']) {
    it(`writing ${field} is REJECTED — it is derived at read time, never stored`, async () => {
      await seed()
      await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
        [field]: 50_000, ...stamps(USERS.admin),
      }))
      expect((await stored())[field]).toBe(0)
    })
  }

  it('a vestigial figure smuggled alongside a legitimate correction is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      budgeted: 112_500, actual: 90_000, ...stamps(USERS.admin),
    }))
    const after = await stored()
    expect(after.budgeted).toBe(100_000)
    expect(after.actual).toBe(0)
  })
})

describe('budgetLines — update: provenance is immutable', () => {
  it('rewriting createdBy is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      createdBy: USERS.admin.uid, ...stamps(USERS.admin),
    }))
    expect((await stored()).createdBy).toBe(USERS.pm.uid)
  })

  it('rewriting or deleting createdAt is REJECTED', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      createdAt: serverTimestamp(), ...stamps(USERS.admin),
    }))
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      createdAt: deleteField(), ...stamps(USERS.admin),
    }))
  })
})

describe('budgetLines — update: numeric safety on budgeted', () => {
  it('ACCEPTS zero', async () => {
    await seed()
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs)), { budgeted: 0, ...stamps(USERS.qs) }))
    expect((await stored()).budgeted).toBe(0)
  })

  it('ACCEPTS a decimal', async () => {
    await seed()
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs)), { budgeted: 1234.56, ...stamps(USERS.qs) }))
  })

  it('REJECTS a negative budget', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.qs)), { budgeted: -1, ...stamps(USERS.qs) }))
    expect((await stored()).budgeted).toBe(100_000)
  })

  it('REJECTS a numeric STRING — a string would break every sum silently', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.qs)), { budgeted: '112500', ...stamps(USERS.qs) }))
  })

  it('REJECTS null, a bool, and a map', async () => {
    await seed()
    for (const bad of [null, true, { v: 1 }]) {
      await assertFails(updateDoc(lineRef(ctx(USERS.qs)), { budgeted: bad, ...stamps(USERS.qs) }))
    }
  })

  it('REJECTS deleting budgeted', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.qs)), {
      budgeted: deleteField(), ...stamps(USERS.qs),
    }))
  })

  it('REJECTS over-long notes', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.qs)), {
      notes: 'x'.repeat(2001), ...stamps(USERS.qs),
    }))
  })

  it('ACCEPTS notes at exactly the limit, and blank notes', async () => {
    await seed()
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs)), {
      notes: 'x'.repeat(2000), ...stamps(USERS.qs),
    }))
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs)), { notes: '', ...stamps(USERS.qs) }))
  })
})

describe('budgetLines — update: the key allow-list', () => {
  it('REJECTS an arbitrary new field', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      approved: true, ...stamps(USERS.admin),
    }))
  })

  it('REJECTS an arbitrary field smuggled alongside a legitimate correction', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      budgeted: 112_500, forecastFinalCost: 1, ...stamps(USERS.admin),
    }))
  })
})

// ── D. THE AUDIT STAMPS ARE VERIFIED ────────────────────────────────────────

describe('budgetLines — update: stamps are verified against caller and server clock', () => {
  it('REJECTS an update with NO stamps at all', async () => {
    // There is no other record that a budget was corrected — no field-level
    // history exists anywhere in the app (Deferred Control 7).
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), { budgeted: 112_500 }))
  })

  it('REJECTS a stamp naming ANOTHER user', async () => {
    await seed()
    await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
      budgeted: 112_500, updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid,
    }))
  })

  CLIENT_CLOCKS.forEach((clock, i) => {
    it(`REJECTS a client-authored updatedAt (skewed clock ${i + 1})`, async () => {
      await seed()
      await assertFails(updateDoc(lineRef(ctx(USERS.admin)), {
        budgeted: 112_500, updatedAt: clock(), updatedBy: USERS.admin.uid,
      }))
    })
  })

  it('ACCEPTS a correctly stamped correction and records who and when', async () => {
    await seed()
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs)), {
      budgeted: 112_500, notes: 'Re-measured', ...stamps(USERS.qs),
    }))
    const after = await stored()
    expect(after.updatedBy).toBe(USERS.qs.uid)
    expect(after.updatedAt).toBeTruthy()
  })

  it('a SECOND correction re-stamps and is still accepted', async () => {
    await seed()
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs)), { budgeted: 110_000, ...stamps(USERS.qs) }))
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.admin)), { budgeted: 112_500, ...stamps(USERS.admin) }))
    expect((await stored()).updatedBy).toBe(USERS.admin.uid)
  })
})

// ── E. LEGACY DOCUMENTS REMAIN CORRECTABLE ──────────────────────────────────

describe('budgetLines — legacy documents remain writable', () => {
  it('a line with NO notes key can still be corrected', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(lineRef(c.firestore(), COMPANY_A, 'legacy'), {
        costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', budgeted: 50_000,
        createdAt: new Date('2025-06-01T00:00:00Z'), createdBy: USERS.pm.uid,
      })
    })
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'legacy'), {
      budgeted: 55_000, ...stamps(USERS.qs),
    }))
    expect((await stored('legacy')).budgeted).toBe(55_000)
  })

  it('a line with NO costCodeName key can still be corrected', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(lineRef(c.firestore(), COMPANY_A, 'nosnap'), {
        costCodeId: 'cc1', budgeted: 50_000, notes: '',
        createdAt: new Date('2025-06-01T00:00:00Z'), createdBy: USERS.pm.uid,
      })
    })
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'nosnap'), {
      budgeted: 55_000, ...stamps(USERS.qs),
    }))
  })

  it('but such a line still cannot GAIN a costCodeName', async () => {
    // The snapshot is frozen whether or not it is present: adding one would
    // invent history that was never recorded.
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(lineRef(c.firestore(), COMPANY_A, 'nosnap2'), {
        costCodeId: 'cc1', budgeted: 50_000, notes: '',
        createdAt: new Date('2025-06-01T00:00:00Z'), createdBy: USERS.pm.uid,
      })
    })
    await assertFails(updateDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'nosnap2'), {
      costCodeName: '03-100 — Concrete Slab', ...stamps(USERS.qs),
    }))
  })
})

// ── F. DELETE — blocked for everyone ────────────────────────────────────────

describe('budgetLines — delete is blocked', () => {
  for (const key of Object.keys(USERS)) {
    it(`${USERS[key].role} (${key}) cannot delete a budget line`, async () => {
      await seed()
      await assertFails(deleteDoc(lineRef(ctx(USERS[key]))))
    })
  }

  it('an unauthenticated caller cannot delete', async () => {
    await seed()
    await assertFails(deleteDoc(lineRef(testEnv.unauthenticatedContext().firestore())))
  })

  it('the document survives every delete attempt', async () => {
    await seed()
    for (const key of WRITERS) await assertFails(deleteDoc(lineRef(ctx(USERS[key]))))
    expect((await stored()).budgeted).toBe(100_000)
  })
})

// ── G. THE DOCUMENTED GAPS — client-enforced only ───────────────────────────

describe('budgetLines — cost-code existence is NOT verified (Deferred Control 28)', () => {
  it('a costCodeId naming NO existing cost code is accepted at the boundary', async () => {
    // Shape only, matching the boqItems posture (Deferred Control 26). A forged
    // id surfaces as an "Unknown cost code" row on the Budget and Forecast
    // pages, never as a corrupted total. Proven, not assumed closed.
    await assertSucceeds(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'ghost'), {
      costCodeId: 'does-not-exist', costCodeName: '', budgeted: 1_000,
      committed: 0, actual: 0, invoiced: 0, notes: '',
      createdAt: serverTimestamp(), createdBy: USERS.qs.uid,
    }))
    expect((await stored('ghost')).costCodeId).toBe('does-not-exist')
  })

  it('a SECOND line on the same cost code is accepted — no sibling queries exist', async () => {
    await seed({ costCodeId: 'cc1' }, 'first')
    await assertSucceeds(setDoc(lineRef(ctx(USERS.qs), COMPANY_A, 'second'), {
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', budgeted: 5_000,
      committed: 0, actual: 0, invoiced: 0, notes: '',
      createdAt: serverTimestamp(), createdBy: USERS.qs.uid,
    }))
  })
})
