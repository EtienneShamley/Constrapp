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
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction,
} from 'firebase/firestore'
import { runApplyBoqQuantity, runUpdateBoqItem, BoqWriteError, BOQ_WRITE_ERROR } from '../../src/lib/boqActions'

// ── BOQ item Security Rules — emulator tests ─────────────────────────────────
//
// Executes every case documented in docs/TESTING.md §15s against the Firestore
// emulator. These verify the RULES, not the UI: each write below is a direct
// SDK call, exactly what a client bypassing the app would issue.
//
// The lifecycle is the two-state cashFlowLines shape (active → active edit,
// active → void terminal — a BOQ item has no financial commit point), and the
// conventions are reused unchanged from cashFlowLines.rules.test.js, including
// the deterministic skewed clocks.
//
// The headline invariant proved here: a PRICED item may never carry an amount
// that disagrees with its own quantity × rate (whole-cent comparison), and
// rate/amount travel together — both null (unpriced) or both numbers. `null`
// means UNPRICED; 0 is a price.
//
// ⚠️ What these tests deliberately PROVE IS NOT ENFORCED (the documented
// client-only gaps — docs/SECURITY.md → Deferred Control 26): a costCodeId of
// valid shape that names NO real cost code is accepted, and duplicate items
// are accepted (rules have no list, query, or count).
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

const itemsPath = (companyId = COMPANY_A, projectId = PROJECT_A) =>
  `companies/${companyId}/projects/${projectId}/boqItems`

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const itemRef = (db, id, companyId = COMPANY_A) => doc(db, itemsPath(companyId), id)

// A valid PRICED payload, exactly as hooks/useBoqItems.jsx writes it.
function pricedPayload(user, overrides = {}) {
  return {
    itemNumber:  '2.1',
    section:     'Substructure',
    description: 'Concrete in slab on ground, N32',
    unit:        'm3',
    quantity:    12.5,
    rate:        310.4,
    // quantity × rate = 3880 exactly — the derived amount.
    amount:      3880,

    // Cost-code spine — mandatory (frozen name snapshot).
    costCodeId:   'cc1',
    costCodeName: '03-100 — Concrete Slab',

    notes: '',

    status: 'active',

    currency: 'AUD',
    revision: 1,

    // Reserved, unused.
    attachments:  [],
    externalRefs: {},

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

// A valid UNPRICED payload — rate null, amount null (never 0-as-unpriced).
const unpricedPayload = (user, overrides = {}) => pricedPayload(user, {
  rate: null,
  amount: null,
  description: 'Excavate to reduced level',
  unit: 'm3',
  quantity: 240,
  ...overrides,
})

// Seeds a document directly, bypassing rules — the arrange step for update tests.
async function seed(id, status, user = USERS.admin, extra = {}) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    const base = pricedPayload(user)
    const lifecycle =
      status === 'void'
        ? { status: 'void', voidedAt: Timestamp.now(), voidedBy: user.uid, voidReason: 'Measured in error' }
        : { status: 'active' }
    await setDoc(doc(db, itemsPath(), id), {
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
const voidWrite = (user, reason = 'Measured in error', extra = {}) => ({
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
  it('financial roles can create an active item', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(setDoc(itemRef(ctx(user), `create-${user.uid}`), pricedPayload(user)))
    }
  })

  it('financial roles can read an item', async () => {
    await seed('read1', 'active')
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await assertSucceeds(getDoc(itemRef(ctx(user), 'read1')))
    }
  })

  it('subcontractor and client can neither read nor write — the BOQ is the internal estimate', async () => {
    await seed('deny1', 'active')
    for (const user of [USERS.sub, USERS.client]) {
      await assertFails(getDoc(itemRef(ctx(user), 'deny1')))
      await assertFails(setDoc(itemRef(ctx(user), `deny-${user.uid}`), pricedPayload(user)))
    }
  })

  it('an unauthenticated caller can neither read nor write', async () => {
    await seed('deny2', 'active')
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(itemRef(db, 'deny2')))
    await assertFails(setDoc(itemRef(db, 'deny3'), pricedPayload(USERS.admin)))
  })

  it('a financial-role user in another company can neither read nor write', async () => {
    await seed('deny4', 'active')
    await assertFails(getDoc(itemRef(ctx(USERS.other), 'deny4')))
    await assertFails(setDoc(itemRef(ctx(USERS.other), 'deny5'), pricedPayload(USERS.other)))
  })
})

// ── Create — valid shapes ────────────────────────────────────────────────────

describe('create — valid payloads', () => {
  it('accepts a priced item whose amount is exactly quantity × rate', async () => {
    await assertSucceeds(setDoc(itemRef(ctx(USERS.qs), 'v1'), pricedPayload(USERS.qs)))
  })

  it('accepts an UNPRICED item — rate null with amount null', async () => {
    await assertSucceeds(setDoc(itemRef(ctx(USERS.pm), 'v2'), unpricedPayload(USERS.pm)))
  })

  it('accepts a fractional quantity within the half-cent tolerance', async () => {
    // 3.333 m2 × $14.99 = 49.961... → 49.96 to the cent.
    await assertSucceeds(setDoc(itemRef(ctx(USERS.qs), 'v3'), pricedPayload(USERS.qs, {
      quantity: 3.333, rate: 14.99, amount: 49.96,
    })))
  })

  it('accepts a zero rate (priced at nothing) and a zero quantity', async () => {
    await assertSucceeds(setDoc(itemRef(ctx(USERS.qs), 'v4'), pricedPayload(USERS.qs, {
      rate: 0, amount: 0,
    })))
    await assertSucceeds(setDoc(itemRef(ctx(USERS.qs), 'v5'), pricedPayload(USERS.qs, {
      quantity: 0, amount: 0,
    })))
  })

  it('accepts an empty itemNumber and section — both are optional labels', async () => {
    await assertSucceeds(setDoc(itemRef(ctx(USERS.pm), 'v6'), pricedPayload(USERS.pm, {
      itemNumber: '', section: '',
    })))
  })

  it('accepts a costCodeId of valid shape that names NO real cost code — reference validity is CLIENT-enforced (DC26)', async () => {
    // Rules validate shape only; an enum or foreign-key check in a manually-
    // published file would drift. This documents the gap rather than
    // pretending it is closed.
    await assertSucceeds(setDoc(itemRef(ctx(USERS.pm), 'v7'), pricedPayload(USERS.pm, {
      costCodeId: 'no-such-code', costCodeName: 'Forged — Nonexistent',
    })))
  })

  it('accepts a duplicate of an existing item — uniqueness is CLIENT-enforced (DC26)', async () => {
    await seed('dup-src', 'active')
    await assertSucceeds(setDoc(itemRef(ctx(USERS.pm), 'dup-copy'), pricedPayload(USERS.pm)))
  })
})

// ── Create — the amount invariant ────────────────────────────────────────────

describe('create — amount == quantity × rate (whole cents)', () => {
  it('rejects a forged amount a cent or more away from quantity × rate', async () => {
    // 12.5 × 310.40 = 3880 — anything else fails.
    for (const forged of [3880.01, 3879.99, 3881, 0, 999999]) {
      await assertFails(setDoc(itemRef(ctx(USERS.qs), 'f1'), pricedPayload(USERS.qs, { amount: forged })))
    }
  })

  it('rejects rate null with a numeric amount, and a numeric rate with amount null', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f2'), pricedPayload(USERS.pm, { rate: null })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f3'), pricedPayload(USERS.pm, { amount: null })))
  })

  it('rejects 0 used to mean unpriced — rate null must pair with amount null, not 0', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f4'), pricedPayload(USERS.pm, { rate: null, amount: 0 })))
  })

  it('rejects a negative rate and a negative amount', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f5'), pricedPayload(USERS.pm, { rate: -1, amount: -12.5 })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f6'), pricedPayload(USERS.pm, { quantity: 1, rate: 5, amount: -5 })))
  })

  it('rejects string rate/amount of the right value', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f7'), pricedPayload(USERS.pm, { rate: '310.40' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'f8'), pricedPayload(USERS.pm, { amount: '3880' })))
  })
})

// ── Create — measurement, spine & identity shape ─────────────────────────────

describe('create — quantity, unit and labels', () => {
  for (const bad of [-1, '12.5', null]) {
    it(`rejects quantity ${JSON.stringify(bad)}`, async () => {
      await assertFails(setDoc(itemRef(ctx(USERS.pm), 'q1'), unpricedPayload(USERS.pm, { quantity: bad })))
    })
  }

  it('rejects an empty or oversized unit', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'u1'), unpricedPayload(USERS.pm, { unit: '' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'u2'), unpricedPayload(USERS.pm, { unit: 'x'.repeat(41) })))
  })

  it('rejects an oversized itemNumber and a non-string section', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'i1'), unpricedPayload(USERS.pm, { itemNumber: 'x'.repeat(41) })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'i2'), unpricedPayload(USERS.pm, { section: null })))
  })

  it('rejects an empty or whitespace-only description', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'de1'), unpricedPayload(USERS.pm, { description: '' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'de2'), unpricedPayload(USERS.pm, { description: '   ' })))
  })
})

describe('create — cost-code spine is mandatory', () => {
  it('rejects a missing, null or empty costCodeId', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'c1'), unpricedPayload(USERS.pm, { costCodeId: '' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'c2'), unpricedPayload(USERS.pm, { costCodeId: null })))
  })

  it('rejects an id without a name snapshot', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'c3'), unpricedPayload(USERS.pm, { costCodeName: '' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'c4'), unpricedPayload(USERS.pm, { costCodeName: null })))
  })
})

describe('create — currency, revision and notes', () => {
  it('rejects a malformed currency and a wrong revision', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'cu1'), unpricedPayload(USERS.pm, { currency: 'AU' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'cu2'), unpricedPayload(USERS.pm, { currency: 'aud' })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'r1'), unpricedPayload(USERS.pm, { revision: 2 })))
  })

  it('rejects non-string notes', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'n1'), unpricedPayload(USERS.pm, { notes: null })))
  })
})

describe('create — lifecycle and audit stamps', () => {
  it('rejects creation as void, and forged void stamps', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'l1'), pricedPayload(USERS.pm, {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.pm.uid, voidReason: 'x',
    })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'l2'), pricedPayload(USERS.pm, { voidedAt: Timestamp.now() })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'l3'), pricedPayload(USERS.pm, { voidedBy: USERS.pm.uid })))
  })

  it('rejects createdBy/updatedBy belonging to another user', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'au1'), pricedPayload(USERS.pm, { createdBy: USERS.admin.uid })))
    await assertFails(setDoc(itemRef(ctx(USERS.pm), 'au2'), pricedPayload(USERS.pm, { updatedBy: USERS.admin.uid })))
  })

  for (const [i, clock] of CLIENT_CLOCKS.entries()) {
    it(`rejects a client-authored createdAt (skewed clock ${i + 1})`, async () => {
      await assertFails(setDoc(itemRef(ctx(USERS.pm), `t1-${i}`), pricedPayload(USERS.pm, { createdAt: clock() })))
    })

    it(`rejects a client-authored updatedAt (skewed clock ${i + 1})`, async () => {
      await assertFails(setDoc(itemRef(ctx(USERS.pm), `t2-${i}`), pricedPayload(USERS.pm, { updatedAt: clock() })))
    })
  }
})

// ── Active edits ─────────────────────────────────────────────────────────────

describe('active edit', () => {
  it('permits a full content edit while active', async () => {
    await seed('e1', 'active')
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 'e1'), activeEdit(USERS.pm, {
      description: 'Concrete in slab on ground, N40',
      quantity: 14, rate: 320, amount: 4480,
    })))
  })

  it('permits PRICING an unpriced item (null → number, amount follows)', async () => {
    await seed('e2', 'active', USERS.admin, { rate: null, amount: null })
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.qs), 'e2'), activeEdit(USERS.qs, {
      rate: 310.4, amount: 3880,
    })))
  })

  it('permits UN-PRICING a priced item (number → null, amount follows)', async () => {
    await seed('e3', 'active')
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.qs), 'e3'), activeEdit(USERS.qs, {
      rate: null, amount: null,
    })))
  })

  it('re-validates the full shape on edit, including the amount invariant', async () => {
    await seed('e4', 'active')
    // Changing quantity WITHOUT recomputing amount breaks quantity × rate.
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { quantity: 99 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { rate: 999 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { amount: 1 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { rate: null })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { description: '  ' })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { unit: '' })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { quantity: -1, amount: -3880 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e4'), activeEdit(USERS.pm, { costCodeId: '' })))
  })

  it('rejects rewriting the immutable core identity', async () => {
    // Seeded by admin, so createdBy is u_admin — every value below is a REAL
    // change (an update writing the same value back is a no-op, not a rewrite).
    await seed('e5', 'active')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e5'), activeEdit(USERS.pm, { currency: 'NZD' })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e5'), activeEdit(USERS.pm, { revision: 2 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e5'), activeEdit(USERS.pm, { createdBy: USERS.pm.uid })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e5'), activeEdit(USERS.pm, { createdAt: Timestamp.now() })))
  })

  it('rejects forging a void stamp during an active edit', async () => {
    await seed('e6', 'active')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e6'), activeEdit(USERS.pm, { voidedAt: Timestamp.now() })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e6'), activeEdit(USERS.pm, { voidedBy: USERS.pm.uid })))
  })

  it('rejects an edit that fails to stamp the caller and server time', async () => {
    await seed('e7', 'active')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e7'), { notes: 'unstamped' }))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e7'), activeEdit(USERS.pm, { updatedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'e7'), {
        notes: 'forged clock', updatedAt: clock(), updatedBy: USERS.pm.uid,
      }))
    }
  })
})

// ── Void ─────────────────────────────────────────────────────────────────────

describe('active → void', () => {
  it('permits voiding with exactly the void key set', async () => {
    await seed('vd1', 'active')
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 'vd1'), voidWrite(USERS.pm)))
  })

  it('rejects a void that touches anything else', async () => {
    await seed('vd2', 'active')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'vd2'), voidWrite(USERS.pm, 'x', { rate: 1, amount: 12.5 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'vd2'), voidWrite(USERS.pm, 'x', { description: 'rewritten' })))
  })

  it('rejects an empty or whitespace-only void reason', async () => {
    await seed('vd3', 'active')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'vd3'), voidWrite(USERS.pm, '')))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'vd3'), voidWrite(USERS.pm, '   ')))
  })

  it('rejects voidedBy belonging to another user and client-authored voidedAt', async () => {
    await seed('vd4', 'active')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'vd4'), voidWrite(USERS.pm, 'x', { voidedBy: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(itemRef(ctx(USERS.pm), 'vd4'), voidWrite(USERS.pm, 'x', { voidedAt: clock() })))
    }
  })
})

describe('void is terminal', () => {
  it('rejects void → active and any edit of a void item', async () => {
    await seed('t1', 'void')
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 't1'), activeEdit(USERS.pm, { status: 'active' })))
    await assertFails(updateDoc(itemRef(ctx(USERS.pm), 't1'), activeEdit(USERS.pm, { rate: 999, amount: 12487.5 })))
    await assertFails(updateDoc(itemRef(ctx(USERS.admin), 't1'), voidWrite(USERS.admin, 'again')))
  })
})

// ── Delete blocking ──────────────────────────────────────────────────────────

describe('delete is blocked', () => {
  it('blocks deleting an active item for every role', async () => {
    await seed('del1', 'active')
    for (const user of [USERS.admin, USERS.pm, USERS.qs, USERS.sub, USERS.client]) {
      await assertFails(deleteDoc(itemRef(ctx(user), 'del1')))
    }
  })

  it('blocks deleting a void item', async () => {
    await seed('del2', 'void')
    await assertFails(deleteDoc(itemRef(ctx(USERS.admin), 'del2')))
  })
})

// ── Full lifecycle sequence ──────────────────────────────────────────────────

describe('create → price → void sequence', () => {
  it('walks the whole lifecycle and proves the terminal state', async () => {
    const db = ctx(USERS.qs)
    // Measured first (unpriced)…
    await assertSucceeds(setDoc(itemRef(db, 'seq1'), unpricedPayload(USERS.qs)))
    // …priced later…
    await assertSucceeds(updateDoc(itemRef(db, 'seq1'), activeEdit(USERS.qs, {
      rate: 18.5, amount: 4440, // 240 × 18.50
    })))
    // …remeasured with the amount kept true…
    await assertSucceeds(updateDoc(itemRef(db, 'seq1'), activeEdit(USERS.qs, {
      quantity: 200, amount: 3700,
    })))
    // …then voided.
    await assertSucceeds(updateDoc(itemRef(db, 'seq1'), voidWrite(USERS.qs, 'Superseded by revised takeoff')))
    // Terminal: no further update, no delete.
    await assertFails(updateDoc(itemRef(db, 'seq1'), activeEdit(USERS.qs, { quantity: 1, amount: 18.5 })))
    await assertFails(deleteDoc(itemRef(db, 'seq1')))
    // The record survives, readable by financial roles.
    const snap = await getDoc(itemRef(ctx(USERS.admin), 'seq1'))
    expect(snap.data().status).toBe('void')
    expect(snap.data().voidReason).toBe('Superseded by revised takeoff')
  })
})

// ── Quant 1B — provenance map and the guarded transactions (ADR-52) ──────────
//
// `quantApplied` is OPTIONAL. Rules enforce: absent at create; on an active
// edit either PRESERVED exactly as stored (a manual edit carries it along) or
// FRESH — exact keys, `by == request.auth.uid`, `at == request.time`,
// `quantity == the quantity being written`, `measurementCount` a positive
// integer. The void branch's `hasOnly` keeps it untouched. The last tests run
// the REAL lib/boqActions.js transactions against the rules: stale refusals,
// the ratchet, and a denied role.

// A fingerprint exactly as lib/quantBoq.js → evidenceFingerprint shapes it.
const EV = 'v1:0123456789abcdef'

describe('QUANT 1B — quantApplied provenance (ADR-52)', () => {
  // The exact apply payload lib/boqActions.js writes: 12 m² × $310.40.
  const applyWrite = (user, quantity = 12, extra = {}) => activeEdit(user, {
    quantity, amount: Math.round(quantity * 310.4 * 100) / 100,
    quantApplied: { at: serverTimestamp(), by: user.uid, quantity, measurementCount: 1, evidence: EV },
    ...extra,
  })

  it('accepts a fresh, caller-stamped application whose quantity equals the written quantity, for each financial role', async () => {
    for (const user of [USERS.admin, USERS.pm, USERS.qs]) {
      await seed(`qa-${user.uid}`, 'active')
      await assertSucceeds(updateDoc(itemRef(ctx(user), `qa-${user.uid}`), applyWrite(user)))
      const stored = (await getDoc(itemRef(ctx(user), `qa-${user.uid}`))).data()
      expect(stored.quantApplied).toMatchObject({ by: user.uid, quantity: 12, measurementCount: 1 })
      expect(stored.quantity).toBe(12)
    }
  })

  it('refuses a forged or malformed map: another actor, a client clock, a quantity that disagrees with the write, bad shape', async () => {
    await seed('qb', 'active')
    const pm = ctx(USERS.pm)
    const bad = (q) => activeEdit(USERS.pm, { quantity: 12, amount: 3724.8, quantApplied: q })
    const ok = { at: serverTimestamp(), by: USERS.pm.uid, quantity: 12, measurementCount: 1, evidence: EV }
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, by: USERS.admin.uid })))
    for (const clock of CLIENT_CLOCKS) {
      await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, at: clock() })))
    }
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, quantity: 11 })))
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, measurementCount: 0 })))
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, measurementCount: 1.5 })))
    const { measurementCount: _omitCount, ...noCount } = ok // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad(noCount)))
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, certified: true })))
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, by: '' })))
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad('applied')))
    // The evidence fingerprint is REQUIRED on a fresh application and bounded: no key, null, blank, oversized or non-string is refused.
    const { evidence: _omitEvidence, ...noEvidence } = ok // eslint-disable-line no-unused-vars
    await assertFails(updateDoc(itemRef(pm, 'qb'), bad(noEvidence)))
    for (const evidence of [null, '', 'x'.repeat(129), 7, { v: 1 }]) {
      await assertFails(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, evidence })))
    }
    await assertSucceeds(updateDoc(itemRef(pm, 'qb'), bad({ ...ok, evidence: 'x'.repeat(128) })))
    // The amount invariant still binds the apply write.
    await assertFails(updateDoc(itemRef(pm, 'qb'), activeEdit(USERS.pm, { quantity: 13, amount: 3880, quantApplied: { ...ok, quantity: 13 } })))
  })

  it('a LEGACY record whose quantApplied has NO evidence key is still preserved verbatim through a manual edit and a void — rules cannot recompute a fingerprint', async () => {
    const legacy = { at: Timestamp.now(), by: USERS.qs.uid, quantity: 12.5, measurementCount: 1 }
    await seed('ql', 'active', USERS.admin, { quantApplied: legacy })
    const qs = ctx(USERS.qs)
    await assertSucceeds(updateDoc(itemRef(qs, 'ql'), activeEdit(USERS.qs, { notes: 'edited around a legacy record' })))
    expect((await getDoc(itemRef(qs, 'ql'))).data().quantApplied).toEqual(legacy)
    // Re-stamping it without evidence is neither preserved nor fresh.
    await assertFails(updateDoc(itemRef(qs, 'ql'), activeEdit(USERS.qs, { quantApplied: { ...legacy, at: serverTimestamp(), by: USERS.qs.uid } })))
    // A fresh application with evidence replaces it.
    await assertSucceeds(updateDoc(itemRef(qs, 'ql'), applyWrite(USERS.qs, 20)))
    expect((await getDoc(itemRef(qs, 'ql'))).data().quantApplied.evidence).toBe(EV)
    await seed('ql2', 'active', USERS.admin, { quantApplied: legacy })
    await assertSucceeds(updateDoc(itemRef(qs, 'ql2'), voidWrite(USERS.qs)))
    expect((await getDoc(itemRef(qs, 'ql2'))).data().quantApplied).toEqual(legacy)
  })

  it('is never written at CREATE', async () => {
    await assertFails(setDoc(itemRef(ctx(USERS.qs), 'qc'), pricedPayload(USERS.qs, {
      quantApplied: { at: serverTimestamp(), by: USERS.qs.uid, quantity: 12.5, measurementCount: 1 },
    })))
    await assertFails(setDoc(itemRef(ctx(USERS.qs), 'qc2'), pricedPayload(USERS.qs, { quantApplied: null })))
  })

  it('a later MANUAL edit preserves the stored map verbatim; altering it without a fresh stamp is refused; void leaves it in place', async () => {
    await seed('qd', 'active')
    const qs = ctx(USERS.qs)
    await assertSucceeds(updateDoc(itemRef(qs, 'qd'), applyWrite(USERS.qs)))
    const applied = (await getDoc(itemRef(qs, 'qd'))).data().quantApplied
    // The editor's full-content save does not name quantApplied — the merged document carries it unchanged.
    await assertSucceeds(updateDoc(itemRef(qs, 'qd'), activeEdit(USERS.qs, { quantity: 15, amount: 4656 })))
    expect((await getDoc(itemRef(qs, 'qd'))).data().quantApplied).toEqual(applied)
    // Rewriting the stored map with a different quantity but the OLD stamp is neither preserved nor fresh.
    await assertFails(updateDoc(itemRef(qs, 'qd'), activeEdit(USERS.qs, { quantApplied: { ...applied, quantity: 15 } })))
    await assertFails(updateDoc(itemRef(qs, 'qd'), activeEdit(USERS.qs, { quantApplied: { ...applied, by: USERS.pm.uid } })))
    // A fresh re-application replaces it.
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 'qd'), applyWrite(USERS.pm, 20)))
    expect((await getDoc(itemRef(qs, 'qd'))).data().quantApplied).toMatchObject({ by: USERS.pm.uid, quantity: 20 })
    // Void may not touch it, and keeps it.
    await assertFails(updateDoc(itemRef(qs, 'qd'), voidWrite(USERS.qs, 'done', { quantApplied: null })))
    await assertSucceeds(updateDoc(itemRef(qs, 'qd'), voidWrite(USERS.qs, 'done')))
    expect((await getDoc(itemRef(qs, 'qd'))).data().quantApplied).toMatchObject({ by: USERS.pm.uid, quantity: 20 })
  })

  it('a legacy item without the key still takes every write it always did', async () => {
    await seed('qe', 'active')
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 'qe'), activeEdit(USERS.pm, { notes: 'still editable' })))
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 'qe'), voidWrite(USERS.pm)))
  })
})

describe('QUANT 1B — the guarded BOQ transactions (lib/boqActions.js) against the emulator', () => {
  const projectRef = (db) => doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A)
  // The app's ratchet (hooks/projectCurrencyLock.js), re-stated on the test SDK.
  const stageLock = (db) => async (tx) => {
    const snap = await tx.get(projectRef(db))
    if (!snap.exists() || snap.data().currencyLocked === true) return () => {}
    return () => tx.update(projectRef(db), { currencyLocked: true })
  }
  const sdk = (user) => {
    const db = ctx(user)
    return { db, uid: user.uid, runTransaction, serverTimestamp, stageLock: stageLock(db) }
  }
  const expectKind = async (promise, kind) => {
    let caught = null
    try { await promise } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(BoqWriteError)
    expect(caught.kind).toBe(kind)
  }
  const readItem = async (id) => {
    let data = null
    await testEnv.withSecurityRulesDisabled(async (c) => { data = (await getDoc(doc(c.firestore(), itemsPath(), id))).data() })
    return data
  }
  const seenCopy = async (user, id) => ({ id, ...(await getDoc(itemRef(ctx(user), id))).data() })

  it('apply: from the reviewed copy succeeds, writes the derived amount and provenance, and ENGAGES the ratchet for a qs user', async () => {
    await seed('t1', 'active') // priced 12.5 × 310.40 on an UNLOCKED project
    const qs = sdk(USERS.qs)
    const seen = await seenCopy(USERS.qs, 't1')
    const out = await runApplyBoqQuantity({ ...qs, itemRef: itemRef(qs.db, 't1'), seen, quantity: 12, measurementCount: 2, evidence: EV })
    expect(out).toEqual({ kind: null, quantity: 12, amount: 3724.8 })
    const stored = await readItem('t1')
    expect(stored).toMatchObject({ quantity: 12, amount: 3724.8, updatedBy: USERS.qs.uid, revision: 1 })
    expect(stored.quantApplied).toMatchObject({ by: USERS.qs.uid, quantity: 12, measurementCount: 2, evidence: EV })
    expect(stored.quantApplied.at).toBeInstanceOf(Timestamp)
    let project = null
    await testEnv.withSecurityRulesDisabled(async (c) => { project = (await getDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects`, PROJECT_A))).data() })
    expect(project.currencyLocked).toBe(true)
  })

  it('apply: a STALE copy (someone saved underneath) is refused end to end and nothing changes', async () => {
    await seed('t2', 'active')
    const qs = sdk(USERS.qs)
    const stale = await seenCopy(USERS.qs, 't2')
    // Another user re-prices the item.
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 't2'), activeEdit(USERS.pm, { rate: 400, amount: 5000 })))
    await expectKind(runApplyBoqQuantity({ ...qs, itemRef: itemRef(qs.db, 't2'), seen: stale, quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.STALE)
    const stored = await readItem('t2')
    expect(stored).toMatchObject({ quantity: 12.5, rate: 400, amount: 5000 })
    expect(stored.quantApplied).toBeUndefined()
    // The fresh copy applies at the NEW rate.
    const fresh = await seenCopy(USERS.qs, 't2')
    const out = await runApplyBoqQuantity({ ...qs, itemRef: itemRef(qs.db, 't2'), seen: fresh, quantity: 12, measurementCount: 1, evidence: EV })
    expect(out.amount).toBe(4800)
  })

  it('apply: an unpriced item changes quantity only — amount stays null and the project stays UNLOCKED', async () => {
    await seed('t3', 'active', USERS.admin, { rate: null, amount: null })
    const pm = sdk(USERS.pm)
    const seen = await seenCopy(USERS.pm, 't3')
    const out = await runApplyBoqQuantity({ ...pm, itemRef: itemRef(pm.db, 't3'), seen, quantity: 7, measurementCount: 3, evidence: EV })
    expect(out).toEqual({ kind: null, quantity: 7, amount: null })
    expect(await readItem('t3')).toMatchObject({ quantity: 7, rate: null, amount: null, quantApplied: { quantity: 7, measurementCount: 3 } })
    let project = null
    await testEnv.withSecurityRulesDisabled(async (c) => { project = (await getDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects`, PROJECT_A))).data() })
    expect(project.currencyLocked).toBeUndefined()
  })

  it('apply: a void item and a denied role are refused with nothing written', async () => {
    await seed('t4', 'void')
    const qs = sdk(USERS.qs)
    await expectKind(runApplyBoqQuantity({ ...qs, itemRef: itemRef(qs.db, 't4'), seen: { id: 't4', ...pricedPayload(USERS.admin), status: 'void' }, quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.INVALID)
    await seed('t5', 'active')
    const sub = sdk(USERS.sub)
    // A denied role cannot even READ the item: the transaction's own read is refused → PERMISSION.
    await expectKind(runApplyBoqQuantity({ ...sub, itemRef: itemRef(sub.db, 't5'), seen: { id: 't5', ...pricedPayload(USERS.admin), updatedAt: null }, quantity: 12, measurementCount: 1, evidence: EV }), BOQ_WRITE_ERROR.PERMISSION)
    expect((await readItem('t5')).quantity).toBe(12.5)
  })

  it('manual edit (runUpdateBoqItem): the editor’s save succeeds from the reviewed copy, is refused as STALE after a concurrent save, and still prices with the ratchet', async () => {
    await seed('t6', 'active', USERS.admin, { rate: null, amount: null })
    const qs = sdk(USERS.qs)
    const fields = (q, rate) => ({
      itemNumber: '2.1', section: 'Substructure', description: 'Concrete in slab on ground, N32', unit: 'm3',
      quantity: q, rate, amount: rate === null ? null : Math.round(q * rate * 100) / 100,
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete Slab', notes: '',
    })
    const seen = await seenCopy(USERS.qs, 't6')
    // Someone else edits first.
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 't6'), activeEdit(USERS.pm, { quantity: 13, notes: 'pm' })))
    await expectKind(runUpdateBoqItem({ ...qs, itemRef: itemRef(qs.db, 't6'), seen, fields: fields(14, null) }), BOQ_WRITE_ERROR.STALE)
    expect(await readItem('t6')).toMatchObject({ quantity: 13, notes: 'pm' })
    // The fresh copy saves, and PRICING engages the ratchet in the same transaction.
    const fresh = await seenCopy(USERS.qs, 't6')
    await runUpdateBoqItem({ ...qs, itemRef: itemRef(qs.db, 't6'), seen: fresh, fields: fields(14, 20) })
    expect(await readItem('t6')).toMatchObject({ quantity: 14, rate: 20, amount: 280, updatedBy: USERS.qs.uid })
    let project = null
    await testEnv.withSecurityRulesDisabled(async (c) => { project = (await getDoc(doc(c.firestore(), `companies/${COMPANY_A}/projects`, PROJECT_A))).data() })
    expect(project.currencyLocked).toBe(true)
    // An apply after a manual edit preserves nothing stale: the manual edit left no quantApplied, the apply writes one.
    const again = await seenCopy(USERS.qs, 't6')
    await runApplyBoqQuantity({ ...qs, itemRef: itemRef(qs.db, 't6'), seen: again, quantity: 9, measurementCount: 1, evidence: EV })
    expect(await readItem('t6')).toMatchObject({ quantity: 9, amount: 180, quantApplied: { quantity: 9 } })
  })

  it('NOT ENFORCED (DC33) — a direct-SDK client that writes a valid payload without reading first still passes: the version guard is the app’s, not the rules’', async () => {
    await seed('t7', 'active')
    await assertSucceeds(updateDoc(itemRef(ctx(USERS.pm), 't7'), activeEdit(USERS.pm, { quantity: 1, amount: 310.4 })))
  })
})
