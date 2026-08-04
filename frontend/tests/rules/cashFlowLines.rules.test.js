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
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── Cash Flow timing line Security Rules — emulator tests ────────────────────
//
// Executes every case documented in docs/TESTING.md §15m-x against the
// Firestore emulator. These verify the RULES, not the UI: each write below is a
// direct SDK call, exactly what a client bypassing the app would issue.
//
// The lifecycle here is deliberately SIMPLER than the cash collections — two
// states (active → active edit, active → void terminal), no posted status, no
// counter — but the conventions are reused unchanged from
// supplierPayments.rules.test.js, including the deterministic skewed clocks.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (the documented
// client-only gaps): a PAST monthKey is accepted (rules have no calendar), and
// an unknown sourceType of valid shape is accepted (no enum in a
// manually-published file — ADR-21).
//
// SAFETY: this suite refuses to run unless FIRESTORE_EMULATOR_HOST is set, so
// it can never reach a production Firebase project. The npm script starts the
// emulator via `firebase emulators:exec`, which sets that variable.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'constrapp-rules-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

// One user per role, all in Company A, plus one financial-role user in Company B
// for tenant-isolation checks.
const USERS = {
  admin: { uid: 'u_admin', role: 'company_admin',   companyId: COMPANY_A },
  pm:    { uid: 'u_pm',    role: 'project_manager', companyId: COMPANY_A },
  qs:    { uid: 'u_qs',    role: 'qs',              companyId: COMPANY_A },
  sub:   { uid: 'u_sub',   role: 'subcontractor',   companyId: COMPANY_A },
  client:{ uid: 'u_client',role: 'client',          companyId: COMPANY_A },
  other: { uid: 'u_other', role: 'company_admin',   companyId: COMPANY_B },
}

let testEnv

const linesPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/cashFlowLines`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const lineRef = (db, id, companyId = COMPANY_A) => doc(db, linesPath(companyId), id)

// A valid ACTIVE payload, exactly as hooks/useCashFlowLines.jsx writes it.
function activePayload(user, overrides = {}) {
  return {
    monthKey:  '2026-10',
    direction: 'in',
    basis:     'gross',

    // Expected GROSS cash — the only cash figure. Positive; direction carries
    // the sign.
    amount: 1100,
    // Ex-GST source coverage — completeness only, never a cash column.
    sourceAmountExGst: 1000,

    sourceType:       'contract_revenue',
    sourceRef:        '',
    counterpartyName: 'Harbour Homes Pty Ltd',

    // Contract revenue sits above the cost-code spine — both null/'' together.
    costCodeId:   null,
    costCodeName: '',

    description: 'Final claim on remaining contract value',
    notes:       '',

    status: 'active',

    currency: 'AUD',
    revision: 1,

    voidReason: '',
    voidedAt:   null,
    voidedBy:   null,

    createdAt: serverTimestamp(),
    createdBy: user.uid,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...overrides,
  }
}

// A valid cost-side payload (cost-code spine engaged).
const costPayload = (user, overrides = {}) => activePayload(user, {
  direction: 'out',
  sourceType: 'remaining_committed',
  costCodeId: 'cc1',
  costCodeName: '03-100 — Concrete Slab',
  amount: 990,
  sourceAmountExGst: 900,
  description: 'Timed remaining commitment — concrete',
  ...overrides,
})

// Seeds a document directly, bypassing rules — the arrange step for update tests.
async function seed(id, status, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = activePayload(user)
    const lifecycle =
      status === 'void'
        ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'No longer expected' }
        : { status: 'active' }
    await setDoc(doc(db, linesPath(), id), {
      ...base,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...lifecycle,
      ...extra,
    })
  })
}

// The write shapes the app performs, so tests exercise the real payloads.
const activeEdit = (user, extra = {}) => ({
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})
const voidWrite = (user, reason = 'No longer expected', extra = {}) => ({
  status: 'void',
  voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: reason,
  updatedAt: serverTimestamp(), updatedBy: user.uid,
  ...extra,
})

// Client-supplied clock values that must NEVER satisfy `== request.time`.
//
// ⚠️ DELIBERATELY SKEWED, NOT `Timestamp.now()`. A bare `Timestamp.now()` is
// the client clock read microseconds before the write reaches the emulator, so
// it can legitimately coincide with `request.time` — which makes the rule
// ACCEPT it and turns the assertion into a coin flip (a real, recorded
// intermittent failure — see docs/TESTING.md §0). These offsets are far enough
// from server time to be deterministic while proving the same rule: a forged
// stamp is rejected.
const CLIENT_CLOCKS = [
  () => Timestamp.fromDate(new Date(Date.now() + 60_000)), // clock ahead
  () => Timestamp.fromDate(new Date(Date.now() - 60_000)), // clock behind
  () => Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')), // plainly forged
]

beforeAll(async () => {
  // Hard gate: never let this suite touch a real project.
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
  // Membership documents are what the rules `get()` to authorise every request.
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
})

// ── Roles & tenant isolation ─────────────────────────────────────────────────

describe('roles and tenant isolation', () => {
  it('financial roles can create an active line', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(lineRef(ctx(user), `create-${user.uid}`), activePayload(user)))
    }
  })

  it('financial roles can read a line', async () => {
    await seed('read1', 'active')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(lineRef(ctx(user), 'read1')))
    }
  })

  it('subcontractor and client can neither read nor write', async () => {
    await seed('deny1', 'active')
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(lineRef(ctx(user), 'deny1')))
      await assertFails(setDoc(lineRef(ctx(user), `deny-${user.uid}`), activePayload(user)))
    }
  })

  it('an unauthenticated caller can neither read nor write', async () => {
    await seed('deny2', 'active')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(lineRef(db, 'deny2')))
    await assertFails(setDoc(lineRef(db, 'deny3'), activePayload(USERS.admin)))
  })

  it('a financial-role user in another company can neither read nor write', async () => {
    await seed('deny4', 'active')
    await assertFails(getDoc(lineRef(ctx(USERS.other), 'deny4')))
    await assertFails(setDoc(lineRef(ctx(USERS.other), 'deny5'), activePayload(USERS.other)))
  })
})

// ── Create — valid shapes ────────────────────────────────────────────────────

describe('create — valid payloads', () => {
  it('accepts a revenue line (no cost code)', async () => {
    await assertSucceeds(setDoc(lineRef(ctx(USERS.pm), 'v1'), activePayload(USERS.pm)))
  })

  it('accepts a cost-side line with the cost-code spine engaged', async () => {
    await assertSucceeds(setDoc(lineRef(ctx(USERS.qs), 'v2'), costPayload(USERS.qs)))
  })

  it('accepts a manual line with null coverage', async () => {
    await assertSucceeds(setDoc(lineRef(ctx(USERS.admin), 'v3'), activePayload(USERS.admin, {
      sourceType: 'manual', sourceAmountExGst: null, description: 'Expected retention release — manual',
    })))
  })

  it('accepts a PAST monthKey — the no-past-month rule is CLIENT-enforced only', async () => {
    // Rules validate the YYYY-MM shape but have no calendar. This documents the
    // gap rather than pretending it is closed.
    await assertSucceeds(setDoc(lineRef(ctx(USERS.pm), 'v4'), activePayload(USERS.pm, { monthKey: '2020-01' })))
  })

  it('accepts an unknown sourceType of valid shape — membership is CLIENT-enforced (ADR-21)', async () => {
    await assertSucceeds(setDoc(lineRef(ctx(USERS.pm), 'v5'), activePayload(USERS.pm, { sourceType: 'client_invoice' })))
  })
})

// ── Create — rejected shapes ─────────────────────────────────────────────────

describe('create — month key', () => {
  for (const bad of ['2026-13', '2026-00', '2026-1', '202608', '2026-08-01', '', 202608, null]) {
    it(`rejects monthKey ${JSON.stringify(bad)}`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS.pm), 'm1'), activePayload(USERS.pm, { monthKey: bad })))
    })
  }
})

describe('create — direction and basis', () => {
  for (const bad of ['x', '', 'IN', 'inout', null]) {
    it(`rejects direction ${JSON.stringify(bad)}`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS.pm), 'd1'), activePayload(USERS.pm, { direction: bad })))
    })
  }

  for (const bad of ['ex_gst', '', 'net', null]) {
    it(`rejects basis ${JSON.stringify(bad)}`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS.pm), 'b1'), activePayload(USERS.pm, { basis: bad })))
    })
  }
})

describe('create — amounts', () => {
  for (const bad of [0, -100, '100', null]) {
    it(`rejects amount ${JSON.stringify(bad)}`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS.pm), 'a1'), activePayload(USERS.pm, { amount: bad })))
    })
  }

  it('rejects a negative or string sourceAmountExGst (null and ≥ 0 allowed)', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'a2'), activePayload(USERS.pm, { sourceAmountExGst: -1 })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'a3'), activePayload(USERS.pm, { sourceAmountExGst: '1000' })))
    await assertSucceeds(setDoc(lineRef(ctx(USERS.pm), 'a4'), activePayload(USERS.pm, { sourceAmountExGst: 0 })))
  })
})

describe('create — source identity, cost code & description', () => {
  it('rejects an empty or oversized sourceType', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 's1'), activePayload(USERS.pm, { sourceType: '' })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 's2'), activePayload(USERS.pm, { sourceType: 'x'.repeat(41) })))
  })

  it('rejects a cost-code name without an id, and an id without a name', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'c1'), activePayload(USERS.pm, { costCodeName: '03-100' })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'c2'), costPayload(USERS.pm, { costCodeName: '' })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'c3'), costPayload(USERS.pm, { costCodeId: '' })))
  })

  it('rejects an empty or whitespace-only description', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'de1'), activePayload(USERS.pm, { description: '' })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'de2'), activePayload(USERS.pm, { description: '   ' })))
  })

  it('rejects a malformed currency and a wrong revision', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'cu1'), activePayload(USERS.pm, { currency: 'AU' })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'cu2'), activePayload(USERS.pm, { currency: 'aud' })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'r1'), activePayload(USERS.pm, { revision: 2 })))
  })
})

describe('create — lifecycle and audit stamps', () => {
  it('rejects creation as void, and forged void stamps', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'l1'), activePayload(USERS.pm, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.pm.uid, voidReason: 'x',
    })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'l2'), activePayload(USERS.pm, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'l3'), activePayload(USERS.pm, { voidedBy: USERS.pm.uid })))
  })

  it('rejects createdBy/updatedBy belonging to another user', async () => {
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'au1'), activePayload(USERS.pm, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(lineRef(ctx(USERS.pm), 'au2'), activePayload(USERS.pm, { updatedBy: USERS.admin.uid })))
  })

  for (const [i, clock] of CLIENT_CLOCKS.entries()) {
    it(`rejects a client-authored createdAt (skewed clock ${i + 1})`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS.pm), `t1-${i}`), activePayload(USERS.pm, { createdAt: clock() })))
    })

    it(`rejects a client-authored updatedAt (skewed clock ${i + 1})`, async () => {
      await assertFails(setDoc(lineRef(ctx(USERS.pm), `t2-${i}`), activePayload(USERS.pm, { updatedAt: clock() })))
    })
  }
})

// ── Active edits ─────────────────────────────────────────────────────────────

describe('active edit', () => {
  it('permits a full content edit while active', async () => {
    await seed('e1', 'active')
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.pm), 'e1'), activeEdit(USERS.pm, {
      monthKey: '2026-12', amount: 2200, sourceAmountExGst: 2000,
      description: 'Retimed to December',
    })))
  })

  it('permits retiming and direction/source changes with the shape intact', async () => {
    await seed('e2', 'active')
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.qs), 'e2'), activeEdit(USERS.qs, {
      direction: 'out', sourceType: 'uncommitted_ctc',
      costCodeId: 'cc9', costCodeName: '05-200 — Roofing',
      amount: 500, sourceAmountExGst: 450,
    })))
  })

  it('re-validates the full shape on edit', async () => {
    await seed('e3', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e3'), activeEdit(USERS.pm, { monthKey: '2026-13' })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e3'), activeEdit(USERS.pm, { amount: 0 })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e3'), activeEdit(USERS.pm, { direction: 'sideways' })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e3'), activeEdit(USERS.pm, { description: '  ' })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e3'), activeEdit(USERS.pm, { sourceAmountExGst: -5 })))
  })

  it('rejects rewriting the immutable core identity', async () => {
    // Seeded by admin, so createdBy is u_admin — every value below is a REAL
    // change (an update writing the same value back is a no-op, not a rewrite).
    await seed('e4', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { currency: 'NZD' })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { basis: 'ex_gst' })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { revision: 2 })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { createdBy: USERS.pm.uid })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { createdAt: Timestamp.now() })))
  })

  it('rejects forging a void stamp during an active edit', async () => {
    await seed('e5', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e5'), activeEdit(USERS.pm, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e5'), activeEdit(USERS.pm, { voidedBy: USERS.pm.uid })))
  })

  it('rejects an edit that fails to stamp the caller and server time', async () => {
    await seed('e6', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e6'), { amount: 500 }))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e6'), activeEdit(USERS.pm, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'e6'), {
        amount: 500, updatedAt: clock(), updatedBy: USERS.pm.uid,
      }))
    }
  })
})

// ── Void ─────────────────────────────────────────────────────────────────────

describe('active → void', () => {
  it('permits voiding with exactly the void key set', async () => {
    await seed('vd1', 'active')
    await assertSucceeds(updateDoc(lineRef(ctx(USERS.pm), 'vd1'), voidWrite(USERS.pm)))
  })

  it('rejects a void that touches anything else', async () => {
    await seed('vd2', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'vd2'), voidWrite(USERS.pm, 'x', { amount: 1 })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'vd2'), voidWrite(USERS.pm, 'x', { monthKey: '2027-01' })))
  })

  it('rejects an empty or whitespace-only void reason', async () => {
    await seed('vd3', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'vd3'), voidWrite(USERS.pm, '')))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'vd3'), voidWrite(USERS.pm, '   ')))
  })

  it('rejects voidedBy belonging to another user and client-authored voidedAt', async () => {
    await seed('vd4', 'active')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'vd4'), voidWrite(USERS.pm, 'x', { voidedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(lineRef(ctx(USERS.pm), 'vd4'), voidWrite(USERS.pm, 'x', { voidedAt: clock() })))
    }
  })
})

describe('void is terminal', () => {
  it('rejects void → active and any edit of a void line', async () => {
    await seed('t1', 'void')
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 't1'), activeEdit(USERS.pm, { status: 'active' })))
    await assertFails(updateDoc(lineRef(ctx(USERS.pm), 't1'), activeEdit(USERS.pm, { amount: 999 })))
    await assertFails(updateDoc(lineRef(ctx(USERS.admin), 't1'), voidWrite(USERS.admin, 'again')))
  })
})

// ── Delete blocking ──────────────────────────────────────────────────────────

describe('delete is blocked', () => {
  it('blocks deleting an active line for every role', async () => {
    await seed('del1', 'active')
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client]) {
      await assertFails(deleteDoc(lineRef(ctx(user), 'del1')))
    }
  })

  it('blocks deleting a void line', async () => {
    await seed('del2', 'void')
    await assertFails(deleteDoc(lineRef(ctx(USERS.admin), 'del2')))
  })
})

// ── Full lifecycle sequence ──────────────────────────────────────────────────

describe('create → edit → void sequence', () => {
  it('walks the whole lifecycle and proves the terminal state', async () => {
    const db = ctx(USERS.pm)
    await assertSucceeds(setDoc(lineRef(db, 'seq1'), activePayload(USERS.pm)))
    await assertSucceeds(updateDoc(lineRef(db, 'seq1'), activeEdit(USERS.pm, {
      monthKey: '2026-11', amount: 550, sourceAmountExGst: 500,
    })))
    await assertSucceeds(updateDoc(lineRef(db, 'seq1'), activeEdit(USERS.pm, {
      description: 'Split — first half',
    })))
    await assertSucceeds(updateDoc(lineRef(db, 'seq1'), voidWrite(USERS.pm, 'Superseded by a new split')))
    // Terminal: no further update, no delete.
    await assertFails(updateDoc(lineRef(db, 'seq1'), activeEdit(USERS.pm, { amount: 1 })))
    await assertFails(deleteDoc(lineRef(db, 'seq1')))
    // The record survives, readable by financial roles.
    const snap = await getDoc(lineRef(ctx(USERS.admin), 'seq1'))
    expect(snap.data().status).toBe('void')
    expect(snap.data().voidReason).toBe('Superseded by a new split')
  })
})
