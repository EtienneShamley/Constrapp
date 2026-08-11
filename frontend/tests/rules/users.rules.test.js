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
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore'

// ── users/{uid} membership document Security Rules — emulator tests ──────────
//
// `users/{uid}` is the MOST security-critical document in the database and was
// the only collection with no rules suite. Every other block in
// firestore.rules authorises by `get()`-ing this document and reading its
// `companyId` (the multi-tenancy anchor) and `role` (every write gate). A
// client-writable profile therefore means:
//   · SELF-PROMOTION      — set role: 'company_admin' and gain every write
//   · TENANT ESCAPE       — set companyId and read/write another company's data
//   · SELF-ISSUED MEMBERSHIP — mint your own profile with any company/role
//   · SELF-DELETION       — `write` includes `delete`
//   · ARBITRARY FIELDS    — pre-seed any future privilege-bearing key
//
// The enforced contract is READ-YOUR-OWN-DOCUMENT AND NOTHING ELSE. No client
// write of any kind is permitted: profiles are provisioned OUT OF BAND
// (Firebase console / admin tooling using admin credentials, which bypass
// rules entirely). That is not a compromise — it is exactly what the app does:
// the only `users/` reference in frontend/src is the READ in
// hooks/useProfile.jsx, and no page, hook, or component writes this document.
//
// ⚠️ NO FIELD ALLOW-LIST. There is deliberately no `hasOnly(['name', ...])`
// escape hatch, because no profile-editing feature exists to need one. The
// `name`/`avatarInitials`/`email`-only cases below assert DENIAL for exactly
// that reason — they prove the closure is structural, not enumerated.
//
// ⚠️ NO ADMIN USER MANAGEMENT. `company_admin` has no special power here; the
// read tests prove it. Managing other users needs invites plus a trusted
// backend (docs/SECURITY.md → Trusted-Backend Activation Requirements 3).
//
// This suite constrains NO timestamp field, so the deliberately-skewed client
// clocks required elsewhere (docs/TESTING.md §0) do not apply here.
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
// for tenant-isolation checks. Mirrors the other four suites exactly.
const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

// An authenticated identity with NO users/{uid} membership document — the
// orphan case. Deliberately absent from USERS so beforeEach never seeds it.
const UNPROVISIONED_UID = 'u_unprovisioned'

let testEnv

const ctx = (user) => testEnv.authenticatedContext(user.uid).firestore()
const userRef = (db, uid) => doc(db, 'users', uid)

// The stored profile shape, exactly as beforeEach seeds it and as
// docs/DATA_MODEL.md documents it.
const profileFor = (user) => ({ role: user.role, companyId: user.companyId, name: user.uid })

// ── Non-regression fixtures ─────────────────────────────────────────────────
//
// A real, rules-valid cashFlowLines payload (copied from
// useCashFlowLines.jsx via cashFlowLines.rules.test.js). Used ONLY to prove
// that role-based authorisation still works after this block is tightened —
// i.e. that the rules-internal get() on users/ is unaffected by the client's
// read grant.
const linesPath = `companies/${COMPANY_A}/projects/${PROJECT_A}/cashFlowLines`

function cashFlowLinePayload(user) {
  return {
    monthKey:  '2026-10',
    direction: 'in',
    basis:     'gross',
    amount: 1100,
    sourceAmountExGst: 1000,
    sourceType:       'contract_revenue',
    sourceRef:        '',
    counterpartyName: 'Harbour Homes Pty Ltd',
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
  }
}

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
  // Seeded with rules DISABLED — exactly how real provisioning works (admin
  // credentials bypass rules), which is why blocking client writes below
  // breaks no legitimate flow.
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(userRef(db, u.uid), profileFor(u))
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Company A' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    await setDoc(doc(db, `companies/${COMPANY_A}/projects`, PROJECT_A), { name: 'Project A', currency: 'AUD' })
    await setDoc(doc(db, `companies/${COMPANY_B}/projects`, PROJECT_A), { name: 'B Project', currency: 'AUD' })
  })
})

// ── READ ────────────────────────────────────────────────────────────────────
//
// Own-document-only, unchanged by this hardening. The app never reads another
// user's profile: ProjectForecast.jsx and ProjectCommercial.jsx deliberately
// render the literal string 'Another user' for any uid that is not the caller.

describe('users/{uid} — read', () => {
  it('a user can read their own profile', async () => {
    for (const user of Object.values(USERS)) {
      const snap = await assertSucceeds(getDoc(userRef(ctx(user), user.uid)))
      expect(snap.data().role).toBe(user.role)
      expect(snap.data().companyId).toBe(user.companyId)
    }
  })

  it('a user cannot read another profile in the SAME company', async () => {
    await assertFails(getDoc(userRef(ctx(USERS.pm), USERS.qs.uid)))
    await assertFails(getDoc(userRef(ctx(USERS.sub), USERS.admin.uid)))
  })

  it('a user cannot read a profile in ANOTHER company', async () => {
    await assertFails(getDoc(userRef(ctx(USERS.admin), USERS.other.uid)))
    await assertFails(getDoc(userRef(ctx(USERS.other), USERS.admin.uid)))
  })

  it('an unauthenticated caller cannot read any profile', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(userRef(db, USERS.admin.uid)))
    await assertFails(getDoc(userRef(db, USERS.sub.uid)))
  })

  it('company_admin cannot read another user profile — no admin user management', async () => {
    await assertFails(getDoc(userRef(ctx(USERS.admin), USERS.pm.uid)))
    await assertFails(getDoc(userRef(ctx(USERS.admin), USERS.sub.uid)))
  })
})

// ── UPDATE ──────────────────────────────────────────────────────────────────
//
// The core of this hardening. Every case below is DENIED — there is no field
// a client may change, harmless or otherwise.

describe('users/{uid} — update', () => {
  it('a user cannot promote their own role', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), { role: 'company_admin' }))
    await assertFails(updateDoc(userRef(ctx(USERS.client), USERS.client.uid), { role: 'company_admin' }))
  })

  it('a user cannot change their role to ANY other role', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.qs), USERS.qs.uid), { role: 'project_manager' }))
    await assertFails(updateDoc(userRef(ctx(USERS.pm), USERS.pm.uid), { role: 'qs' }))
    // Even a DOWNGRADE is denied — the field is not client-writable at all.
    await assertFails(updateDoc(userRef(ctx(USERS.admin), USERS.admin.uid), { role: 'client' }))
  })

  it('a user cannot change their companyId — tenant escape', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.admin), USERS.admin.uid), { companyId: COMPANY_B }))
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), { companyId: COMPANY_B }))
  })

  it('a user cannot change role AND companyId together', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), {
      role: 'company_admin',
      companyId: COMPANY_B,
    }))
  })

  it('a user cannot smuggle a role change alongside a harmless field', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), {
      name: 'Site Foreman',
      role: 'company_admin',
    }))
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), {
      avatarInitials: 'SF',
      companyId: COMPANY_B,
    }))
  })

  it('a user cannot update name alone — there is NO harmless-field allow-list', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.admin), USERS.admin.uid), { name: 'Renamed' }))
  })

  it('a user cannot update avatarInitials alone', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.admin), USERS.admin.uid), { avatarInitials: 'ZZ' }))
  })

  it('a user cannot update email alone', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.admin), USERS.admin.uid), { email: 'new@example.com' }))
  })

  it('a user cannot add an arbitrary privilege-bearing field', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), { isSuperAdmin: true }))
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), { superAdmin: true }))
  })

  it('a user cannot add a plausible-looking multi-company membership field', async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.sub.uid), {
      companyIds: [COMPANY_A, COMPANY_B],
    }))
  })

  it('a user cannot rewrite their profile with IDENTICAL data', async () => {
    // Proves `update` is closed outright, not merely diff-constrained.
    await assertFails(setDoc(userRef(ctx(USERS.admin), USERS.admin.uid), profileFor(USERS.admin)))
  })

  it("a user cannot update another user's profile", async () => {
    await assertFails(updateDoc(userRef(ctx(USERS.admin), USERS.sub.uid), { role: 'client' }))
    await assertFails(updateDoc(userRef(ctx(USERS.sub), USERS.admin.uid), { role: 'client' }))
    await assertFails(updateDoc(userRef(ctx(USERS.other), USERS.admin.uid), { companyId: COMPANY_B }))
  })
})

// ── CREATE ──────────────────────────────────────────────────────────────────
//
// Blocked outright. Permitting create would make a Firebase Auth account alone
// sufficient to mint a membership with any company and any role — the Firestore
// document would be self-service rather than a second gate.

describe('users/{uid} — create', () => {
  it('an authenticated user cannot create their own missing profile', async () => {
    const db = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    await assertFails(setDoc(userRef(db, UNPROVISIONED_UID), {
      role: 'client',
      companyId: COMPANY_A,
      name: 'New Starter',
    }))
  })

  it('an authenticated user cannot self-create with an elevated role', async () => {
    const db = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    await assertFails(setDoc(userRef(db, UNPROVISIONED_UID), {
      role: 'company_admin',
      companyId: COMPANY_A,
      name: 'New Starter',
    }))
  })

  it('an authenticated user cannot self-create into another company', async () => {
    const db = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    await assertFails(setDoc(userRef(db, UNPROVISIONED_UID), {
      role: 'company_admin',
      companyId: COMPANY_B,
      name: 'New Starter',
    }))
  })

  it("a user cannot create another user's document", async () => {
    await assertFails(setDoc(userRef(ctx(USERS.admin), 'u_fabricated'), {
      role: 'company_admin',
      companyId: COMPANY_A,
      name: 'Fabricated',
    }))
  })
})

// ── DELETE ──────────────────────────────────────────────────────────────────
//
// Previously permitted, because `write` expands to create + update + delete.
// Deleting a membership orphans the user against every rule in the file.

describe('users/{uid} — delete', () => {
  it('a user cannot delete their own profile', async () => {
    await assertFails(deleteDoc(userRef(ctx(USERS.admin), USERS.admin.uid)))
    await assertFails(deleteDoc(userRef(ctx(USERS.sub), USERS.sub.uid)))
  })

  it("a user cannot delete another user's profile", async () => {
    await assertFails(deleteDoc(userRef(ctx(USERS.admin), USERS.sub.uid)))
    await assertFails(deleteDoc(userRef(ctx(USERS.other), USERS.admin.uid)))
  })
})

// ── NON-REGRESSION ──────────────────────────────────────────────────────────
//
// The tests that answer the one legitimate fear about this change: if clients
// can no longer write users/{uid}, does role-based authorisation still work?
//
// It does, and these prove WHY rather than assuming it: rules-internal
// get()/exists() calls BYPASS Security Rules. The ~40 lookups of
// users/$(request.auth.uid) across firestore.rules are not subject to the
// users/{uid} match block, so tightening that block cannot break them.

describe('membership authorisation still works (non-regression)', () => {
  it('a seeded company_admin can still perform a role-authorised financial write', async () => {
    await assertSucceeds(setDoc(
      doc(ctx(USERS.admin), linesPath, 'nonreg-admin'),
      cashFlowLinePayload(USERS.admin),
    ))
  })

  it('a seeded subcontractor is still denied that same write', async () => {
    await assertFails(setDoc(
      doc(ctx(USERS.sub), linesPath, 'nonreg-sub'),
      cashFlowLinePayload(USERS.sub),
    ))
  })

  it('an authenticated user with NO membership document is denied company-scoped access', async () => {
    const db = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    // No users/{uid} document exists, so the rules' get() finds no companyId.
    await assertFails(getDoc(doc(db, 'companies', COMPANY_A)))
    await assertFails(getDoc(doc(db, linesPath, 'nonreg-admin')))
    await assertFails(setDoc(
      doc(db, linesPath, 'nonreg-orphan'),
      cashFlowLinePayload({ uid: UNPROVISIONED_UID }),
    ))
  })
})
