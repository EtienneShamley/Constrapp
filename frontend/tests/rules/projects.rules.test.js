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
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, writeBatch,
} from 'firebase/firestore'

// ── companies/{companyId}/projects/{projectId} Security Rules — emulator tests ─
//
// The project document is where the CURRENCY RATCHET lives, and it was the last
// financially-significant collection with no rules suite. `currency` is the
// display authority for every money figure on the project, and Constrapp
// performs NO FX conversion — so changing a stored currency RELABELS existing
// amounts without converting them. That is the harm the ratchet exists to
// prevent, and these tests are the only automated proof that it does.
//
// The enforced contract, in full:
//   · READ    — any provisioned member of the owning company, every role.
//   · CREATE  — company_admin / project_manager, currency shape-validated.
//   · UPDATE  — company_admin / project_manager generally, PLUS one narrowly
//               scoped `qs` permission: `currencyLocked` false/absent → true,
//               affecting that single key and nothing else.
//   · DELETE  — blocked for everyone.
//
// ⚠️ THE REGRESSION THIS SUITE EXISTS FOR (the LEGACY INITIALISATION carve-out).
// `currencyLocked` and `currency` are SEPARATE fields, and the lock write is a
// lone `currencyLocked: true` (it has to be — the narrow `qs` rule rejects any
// wider diff). A project predating the Company Country & Currency foundation
// can therefore be LOCKED while storing NO currency at all, rendering through
// the company base currency instead. Company Settings exists to repair exactly
// that by pinning the label the project is ALREADY displaying.
//
// A strict `request.currency == resource.currency` comparison rejected that
// repair as though it were a relabel: '' → 'AUD' failed with "Missing or
// insufficient permissions", which is a defect that was reproduced against live
// data. The rule now frees `currency` ONLY while the stored value is not a
// well-formed ISO 4217 code. That is one-way and self-closing: the carve-out's
// precondition is a property of the STORED document, and the only write it
// permits is the one that destroys it. Group B proves the door opens once;
// Group C proves it is shut afterwards.
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

// One user per role, all in Company A, plus one company_admin in Company B for
// tenant-isolation checks. Mirrors the other rules suites exactly.
const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  sadmin: { uid: 'u_sadmin', role: 'super_admin',     companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}

// An authenticated identity with NO users/{uid} membership document.
const UNPROVISIONED_UID = 'u_unprovisioned'

// Every role that must NOT be able to write the project document at all.
const NON_WRITERS = ['qs', 'sub', 'client', 'sadmin']

let testEnv

const ctx      = (user) => testEnv.authenticatedContext(user.uid).firestore()
const projRef  = (db, companyId = COMPANY_A, projectId = PROJECT_A) =>
  doc(db, 'companies', companyId, 'projects', projectId)
const profileFor = (user) => ({ role: user.role, companyId: user.companyId, name: user.uid })

// A project as it exists BEFORE the currency foundation: real fields, real
// amounts, and no `currency` key whatsoever. `budget` is deliberately non-zero —
// a headline budget is itself monetary data and is why the project is locked.
const LEGACY_PROJECT = {
  name:     'Gold Coast apartments',
  status:   'in_progress',
  budget:   1250000,
  location: 'Southport QLD',
  progress: 40,
}

// Seeds the project document with rules DISABLED — stored state, asserted by
// nothing. Every currency-ratchet test starts from a state the app can really
// reach, then attempts ONE write through the rules.
async function seed(fields) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(projRef(c.firestore()), { ...LEGACY_PROJECT, ...fields })
  })
}

// Reads the stored document back with rules disabled, so an ALLOW assertion can
// prove what actually landed rather than only that the write was permitted.
async function stored() {
  let data
  await testEnv.withSecurityRulesDisabled(async (c) => {
    data = (await getDoc(projRef(c.firestore()))).data()
  })
  return data
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
  await testEnv.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore()
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), profileFor(u))
    }
    await setDoc(doc(db, 'companies', COMPANY_A), { name: 'Apex Builders' })
    await setDoc(doc(db, 'companies', COMPANY_B), { name: 'Company B' })
    // Company B's own project, for the cross-tenant checks.
    await setDoc(projRef(db, COMPANY_B), { ...LEGACY_PROJECT, currency: 'ZAR', currencyLocked: true })
  })
})

// ── A. READ ─────────────────────────────────────────────────────────────────
//
// Reads are role-agnostic on purpose: every role must be able to read
// `currency` to render amounts with the correct label.

describe('projects — read', () => {
  it('every provisioned Company A role can read the project', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    for (const key of ['admin', 'pm', 'qs', 'sub', 'client', 'sadmin']) {
      const snap = await assertSucceeds(getDoc(projRef(ctx(USERS[key]))))
      expect(snap.data().currency).toBe('AUD')
    }
  })

  it('a Company B user cannot read a Company A project', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(getDoc(projRef(ctx(USERS.other))))
  })

  it('a Company A admin cannot read a Company B project', async () => {
    await assertFails(getDoc(projRef(ctx(USERS.admin), COMPANY_B)))
  })

  it('an unauthenticated caller cannot read any project', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(projRef(db)))
    await assertFails(getDoc(projRef(db, COMPANY_B)))
  })

  it('an authenticated caller with NO membership document cannot read', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    const db = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    await assertFails(getDoc(projRef(db)))
  })
})

// ── B. LEGACY INITIALISATION — locked, no stored currency ───────────────────
//
// THE FIX. A locked project holding no well-formed currency may receive its
// FIRST explicit code. Nothing here relabels anything: the pinned code is the
// one the project is already being displayed in.

describe('projects — locked with NO stored currency may be pinned ONCE', () => {
  it('company_admin can pin the first currency on a locked, unpinned project', async () => {
    await seed({ currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD' }))
    const after = await stored()
    expect(after.currency).toBe('AUD')
    // The lock is untouched and NO amount moved — currency is a label only.
    expect(after.currencyLocked).toBe(true)
    expect(after.budget).toBe(LEGACY_PROJECT.budget)
  })

  it('project_manager can pin the first currency on a locked, unpinned project', async () => {
    await seed({ currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.pm)), { currency: 'AUD' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('the live defect: the exact Company Settings BATCH write is accepted', async () => {
    // useCompany.saveCompanyCurrency pins projects in a chunked writeBatch of
    // single-field `{ currency }` updates. This is the write that failed with
    // "Missing or insufficient permissions" against live data.
    await seed({ currencyLocked: true })
    const db = ctx(USERS.admin)
    const batch = writeBatch(db)
    batch.update(projRef(db), { currency: 'AUD' })
    await assertSucceeds(batch.commit())
    expect((await stored()).currency).toBe('AUD')
  })

  it('an EMPTY-STRING stored currency counts as unpinned and may be pinned', async () => {
    await seed({ currency: '', currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'NZD' }))
    expect((await stored()).currency).toBe('NZD')
  })

  it('a MALFORMED stored currency counts as unpinned and may be pinned', async () => {
    // 'aud' fails ^[A-Z]{3}$, so lib/currency.js → projectHasExplicitCurrency
    // reports the project as unpinned. The rule uses the SAME pattern, so the
    // client and the boundary agree and the repair is not locked out.
    await seed({ currency: 'aud', currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('a NON-STRING stored currency counts as unpinned and may be pinned', async () => {
    await seed({ currency: 123, currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('the first pin may accompany other project edits in the same write', async () => {
    await seed({ currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD', progress: 55 }))
    const after = await stored()
    expect(after.currency).toBe('AUD')
    expect(after.progress).toBe(55)
  })

  it('a locked, unpinned project can still be edited WITHOUT touching currency', async () => {
    await seed({ currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { progress: 60 }))
    const after = await stored()
    expect(after.progress).toBe(60)
    expect('currency' in after).toBe(false)
  })
})

// ── C. THE DOOR SHUTS — the carve-out cannot become a relabel ───────────────

describe('projects — a pinned currency can never be relabelled', () => {
  it('pin then relabel: AUD lands, then AUD → NZD is REJECTED', async () => {
    await seed({ currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD' }))
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: 'NZD' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('locked + AUD → NZD is REJECTED for company_admin and project_manager', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: 'NZD' }))
    await assertFails(updateDoc(projRef(ctx(USERS.pm)),    { currency: 'NZD' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('locked + AUD → AUD (identical value) is accepted — idempotent, not a relabel', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('locked + AUD: DELETING currency is REJECTED', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: deleteField() }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('locked + AUD: BLANKING currency is REJECTED', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: '' }))
    expect((await stored()).currency).toBe('AUD')
  })

  it('locked + AUD: a relabel smuggled alongside a legitimate edit is REJECTED', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { progress: 70, currency: 'NZD' }))
    const after = await stored()
    expect(after.currency).toBe('AUD')
    expect(after.progress).toBe(LEGACY_PROJECT.progress)
  })

  it('locked + AUD: non-currency edits are still allowed', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { progress: 70, name: 'Renamed' }))
    expect((await stored()).currency).toBe('AUD')
  })
})

// ── D. THE LOCK NEVER RELEASES ──────────────────────────────────────────────

describe('projects — currencyLocked is monotonic', () => {
  it('true → false is REJECTED for every role that can write the document', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: false }))
    await assertFails(updateDoc(projRef(ctx(USERS.pm)),    { currencyLocked: false }))
    expect((await stored()).currencyLocked).toBe(true)
  })

  it('true → false is REJECTED for qs', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: false }))
    expect((await stored()).currencyLocked).toBe(true)
  })

  it('DELETING currencyLocked is REJECTED', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: deleteField() }))
    expect((await stored()).currencyLocked).toBe(true)
  })

  it('unlocking smuggled alongside a relabel is REJECTED', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: false, currency: 'NZD' }))
    const after = await stored()
    expect(after.currencyLocked).toBe(true)
    expect(after.currency).toBe('AUD')
  })

  it('a non-boolean currencyLocked is REJECTED', async () => {
    await seed({ currency: 'AUD', currencyLocked: false })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: 'true' }))
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: 1 }))
  })

  it('false → true is accepted, and may pin the currency in the SAME write', async () => {
    // The two-key write useProjects.lockProjectCurrency attempts first.
    await seed({ currencyLocked: false })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currencyLocked: true, currency: 'AUD' }))
    const after = await stored()
    expect(after.currencyLocked).toBe(true)
    expect(after.currency).toBe('AUD')
  })
})

// ── E. UNLOCKED PROJECTS — the pre-existing behaviour, unchanged ────────────

describe('projects — unlocked currency remains freely settable', () => {
  it('unlocked + no currency → a valid code is accepted for admin and pm', async () => {
    await seed({ currencyLocked: false })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'AUD' }))
    await assertSucceeds(updateDoc(projRef(ctx(USERS.pm)),    { currency: 'NZD' }))
    expect((await stored()).currency).toBe('NZD')
  })

  it('no currencyLocked FIELD AT ALL behaves as unlocked', async () => {
    await seed({})
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'ZAR' }))
    expect((await stored()).currency).toBe('ZAR')
  })

  it('unlocked + an existing currency may still be changed', async () => {
    await seed({ currency: 'AUD', currencyLocked: false })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'NZD' }))
    expect((await stored()).currency).toBe('NZD')
  })
})

// ── F. CURRENCY-CODE SHAPE VALIDATION ───────────────────────────────────────
//
// Rules validate SHAPE (^[A-Z]{3}$), never an enum — an enum duplicated into
// this manually-published file would drift out of sync with lib/currency.js.
// The known-code check is client-side (docs/SECURITY.md → Deferred Controls).

describe('projects — currency must be a well-formed ISO 4217 code', () => {
  const MALFORMED = ['AU', 'AUDD', 'aud', 'Aud', 'A U', '123', ' AUD', 'AUD ', '']

  it('every malformed code is REJECTED on a locked, unpinned project', async () => {
    for (const bad of MALFORMED) {
      await seed({ currencyLocked: true })
      await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: bad }))
    }
  })

  it('every malformed code is REJECTED on an unlocked project', async () => {
    for (const bad of MALFORMED) {
      await seed({ currencyLocked: false })
      await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: bad }))
    }
  })

  it('a non-string currency is REJECTED', async () => {
    await seed({ currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: 123 }))
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: null }))
    await assertFails(updateDoc(projRef(ctx(USERS.admin)), { currency: ['AUD'] }))
  })

  it('an UNKNOWN but well-formed code is ACCEPTED — the documented client-only gap', async () => {
    // 'XYZ' is in no CURRENCIES entry. Rules cannot hold an enum, so the app's
    // isKnownCurrencyCode check is the only thing rejecting it. Reported here
    // honestly rather than claimed as enforced.
    await seed({ currencyLocked: true })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.admin)), { currency: 'XYZ' }))
    expect((await stored()).currency).toBe('XYZ')
  })

  it('create validates the same shape', async () => {
    const db = ctx(USERS.admin)
    await assertSucceeds(setDoc(projRef(db, COMPANY_A, 'newOk'),   { ...LEGACY_PROJECT, currency: 'AUD' }))
    await assertFails(setDoc(projRef(db, COMPANY_A, 'newBad'),     { ...LEGACY_PROJECT, currency: 'aud' }))
    await assertFails(setDoc(projRef(db, COMPANY_A, 'newBad2'),    { ...LEGACY_PROJECT, currency: 12 }))
    await assertFails(setDoc(projRef(db, COMPANY_A, 'newBad3'),    { ...LEGACY_PROJECT, currencyLocked: 'yes' }))
    // No currency at all is permitted at create — that is how the legacy state
    // this suite is about arises in the first place.
    await assertSucceeds(setDoc(projRef(db, COMPANY_A, 'newNone'), { ...LEGACY_PROJECT }))
  })
})

// ── G. THE NARROW qs RATCHET — it must not widen ────────────────────────────
//
// `qs` has NO general project write access. Its ONE permission is flipping
// `currencyLocked` false/absent → true and changing NOTHING else, so that a QS
// financial write (which engages the ratchet in the same transaction) is not
// blocked. The LEGACY INITIALISATION carve-out lives inside the
// company_admin/project_manager branch and grants `qs` nothing.

describe('projects — the qs ratchet stays exactly as narrow as it was', () => {
  it('qs CAN flip currencyLocked false → true, alone', async () => {
    await seed({ currency: 'AUD', currencyLocked: false })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: true }))
    expect((await stored()).currencyLocked).toBe(true)
  })

  it('qs CAN flip an ABSENT currencyLocked to true, alone', async () => {
    await seed({ currency: 'AUD' })
    await assertSucceeds(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: true }))
    expect((await stored()).currencyLocked).toBe(true)
  })

  it('qs CANNOT re-write true on an already-locked project', async () => {
    // Why stageProjectCurrencyLock stages a NO-OP for already-locked projects:
    // an unconditional re-write would fail the whole financial transaction.
    await seed({ currency: 'AUD', currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: true }))
  })

  it('qs CANNOT pin the first currency on a locked, unpinned project', async () => {
    await seed({ currencyLocked: true })
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currency: 'AUD' }))
    expect('currency' in (await stored())).toBe(false)
  })

  it('qs CANNOT pin a currency on an UNLOCKED project either', async () => {
    await seed({ currencyLocked: false })
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currency: 'AUD' }))
    expect('currency' in (await stored())).toBe(false)
  })

  it('qs CANNOT combine the lock with a currency pin', async () => {
    // The two-key diff fails hasOnly(['currencyLocked']) — which is exactly why
    // useProjects.lockProjectCurrency falls back to the lock-only write.
    await seed({ currencyLocked: false })
    await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: true, currency: 'AUD' }))
    const after = await stored()
    expect(after.currencyLocked).toBe(false)
    expect('currency' in after).toBe(false)
  })

  it('qs CANNOT smuggle any other field alongside the lock', async () => {
    await seed({ currency: 'AUD', currencyLocked: false })
    for (const extra of [{ budget: 999 }, { name: 'Renamed' }, { status: 'complete' }, { progress: 99 }]) {
      await assertFails(updateDoc(projRef(ctx(USERS.qs)), { currencyLocked: true, ...extra }))
    }
    expect((await stored()).currencyLocked).toBe(false)
  })

  it('qs CANNOT edit any project field on its own', async () => {
    await seed({ currency: 'AUD', currencyLocked: false })
    for (const edit of [{ name: 'Renamed' }, { budget: 1 }, { status: 'complete' }, { progress: 1 }]) {
      await assertFails(updateDoc(projRef(ctx(USERS.qs)), edit))
    }
  })

  it('qs CANNOT create a project', async () => {
    await assertFails(setDoc(projRef(ctx(USERS.qs), COMPANY_A, 'qsNew'), { ...LEGACY_PROJECT, currency: 'AUD' }))
  })
})

// ── H. EVERY OTHER ROLE ─────────────────────────────────────────────────────

describe('projects — subcontractor, client and super_admin cannot write', () => {
  it('none of them can pin the first currency on a locked, unpinned project', async () => {
    await seed({ currencyLocked: true })
    for (const key of ['sub', 'client', 'sadmin']) {
      await assertFails(updateDoc(projRef(ctx(USERS[key])), { currency: 'AUD' }))
    }
    expect('currency' in (await stored())).toBe(false)
  })

  it('none of them can set the lock, change a currency, or edit the project', async () => {
    await seed({ currency: 'AUD', currencyLocked: false })
    for (const key of ['sub', 'client', 'sadmin']) {
      await assertFails(updateDoc(projRef(ctx(USERS[key])), { currencyLocked: true }))
      await assertFails(updateDoc(projRef(ctx(USERS[key])), { currency: 'NZD' }))
      await assertFails(updateDoc(projRef(ctx(USERS[key])), { name: 'Renamed' }))
    }
  })

  it('none of them can create a project', async () => {
    for (const key of ['sub', 'client', 'sadmin']) {
      await assertFails(setDoc(projRef(ctx(USERS[key]), COMPANY_A, `new_${key}`), { ...LEGACY_PROJECT, currency: 'AUD' }))
    }
  })

  it('an unprovisioned caller and an unauthenticated caller cannot write', async () => {
    await seed({ currencyLocked: true })
    const orphan = testEnv.authenticatedContext(UNPROVISIONED_UID).firestore()
    const anon   = testEnv.unauthenticatedContext().firestore()
    await assertFails(updateDoc(projRef(orphan), { currency: 'AUD' }))
    await assertFails(updateDoc(projRef(anon),   { currency: 'AUD' }))
    await assertFails(setDoc(projRef(anon, COMPANY_A, 'anonNew'), { ...LEGACY_PROJECT, currency: 'AUD' }))
  })
})

// ── I. TENANT ISOLATION ─────────────────────────────────────────────────────

describe('projects — tenant isolation', () => {
  it('a Company B admin cannot pin, relabel, lock or edit a Company A project', async () => {
    await seed({ currencyLocked: true })
    const db = ctx(USERS.other)
    await assertFails(updateDoc(projRef(db), { currency: 'AUD' }))
    await assertFails(updateDoc(projRef(db), { currencyLocked: false }))
    await assertFails(updateDoc(projRef(db), { name: 'Taken over' }))
    expect('currency' in (await stored())).toBe(false)
  })

  it('a Company B admin cannot create a project under Company A', async () => {
    await assertFails(setDoc(projRef(ctx(USERS.other), COMPANY_A, 'crossNew'), { ...LEGACY_PROJECT, currency: 'AUD' }))
  })

  it('a Company A admin cannot relabel a Company B project', async () => {
    await assertFails(updateDoc(projRef(ctx(USERS.admin), COMPANY_B), { currency: 'AUD' }))
  })

  it('the carve-out does not cross tenants: an unpinned Company A project stays out of reach', async () => {
    await testEnv.withSecurityRulesDisabled(async (c) => {
      await setDoc(projRef(c.firestore(), COMPANY_B, 'bLegacy'), { ...LEGACY_PROJECT, currencyLocked: true })
    })
    await assertFails(updateDoc(projRef(ctx(USERS.admin), COMPANY_B, 'bLegacy'), { currency: 'AUD' }))
  })
})

// ── J. DELETE ───────────────────────────────────────────────────────────────

describe('projects — delete is blocked for everyone', () => {
  it('no role can delete a project', async () => {
    await seed({ currency: 'AUD', currencyLocked: true })
    for (const key of ['admin', 'pm', ...NON_WRITERS, 'other']) {
      await assertFails(deleteDoc(projRef(ctx(USERS[key]))))
    }
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(deleteDoc(projRef(anon)))
    expect((await stored()).currency).toBe('AUD')
  })
})
