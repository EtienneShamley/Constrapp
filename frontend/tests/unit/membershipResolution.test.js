import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Membership resolution (tracker D3 #32) ───────────────────────────────────
//
// THE DEFECT. With the Firestore backend unreachable while the page loads, the
// SDK answers the `users/{uid}` listener at once from its empty cache with a
// document that "does not exist". The provider took that as a settled null
// profile and the gate said *No active membership* to a real member.
//
// THE RULE UNDER TEST. Only a SERVER-CONFIRMED snapshot decides membership.
//
// Three layers, no DOM and no Firebase (the unit runner is plain Node):
//   1. the pure fold and the gate decision (lib/team.js);
//   2. the REAL `ProfileProvider` and `MembershipGate`, run by a small hook
//      runtime over a fake `users/{uid}` listener that reproduces the SDK
//      behaviour MEASURED against the emulator (TESTING.md §75): a cache
//      answer first when the server is unreachable, and a metadata-only
//      confirmation delivered ONLY to a listener opened with
//      `includeMetadataChanges`;
//   3. source structure — no polling, no persistence, no service worker.
//
// The first test of layer 2 is the D3 #32 regression: it fails against the
// provider as it stood before the correction.

// ── A minimal hook runtime ───────────────────────────────────────────────────
//
// Runs a function component outside React: state cells, effects with cleanup
// and dependency comparison, refs and callbacks. `strict` repeats the mount
// effect (run → clean up → run), as React Strict Mode does in development.
const R = vi.hoisted(() => {
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  let current = null
  const cell = (make) => {
    const i = current.at
    current.at += 1
    if (!(i in current.cells)) current.cells[i] = make()
    return current.cells[i]
  }
  const hooks = {
    useState(init) {
      const inst = current
      const c = cell(() => {
        const made = { state: typeof init === 'function' ? init() : init }
        made.set = (u) => {
          const next = typeof u === 'function' ? u(made.state) : u
          if (!Object.is(next, made.state)) { made.state = next; inst.dirty = true }
        }
        return made
      })
      return [c.state, c.set]
    },
    useRef(init) { return cell(() => ({ current: init })) },
    useCallback(fn, deps) {
      const c = cell(() => ({ fn, deps }))
      if (!same(c.deps, deps)) { c.fn = fn; c.deps = deps }
      return c.fn
    },
    useEffect(fn, deps) {
      const c = cell(() => ({ deps: null, cleanup: undefined, effect: true }))
      c.next = { fn, deps }
      current.effects.push(c)
    },
  }
  function mount(Component, { strict = false, context = () => null } = {}) {
    const inst = { cells: [], at: 0, dirty: false, effects: [], renders: 0, output: null, mounted: true, context }
    const once = () => {
      inst.at = 0; inst.effects = []; inst.dirty = false
      current = inst
      try { inst.output = Component({}) } finally { current = null }
      inst.renders += 1
      for (const c of inst.effects) {
        if (c.deps !== null && same(c.deps, c.next.deps)) continue
        const first = c.deps === null
        if (typeof c.cleanup === 'function') c.cleanup()
        c.cleanup = c.next.fn()
        if (strict && first) {
          if (typeof c.cleanup === 'function') c.cleanup()
          c.cleanup = c.next.fn()
        }
        c.deps = c.next.deps
      }
    }
    inst.render = () => { let n = 0; do { once(); n += 1 } while (inst.dirty && n < 25); return inst }
    inst.flush = () => (inst.dirty ? inst.render() : inst)
    inst.unmount = () => {
      for (const c of inst.cells) if (c?.effect && typeof c.cleanup === 'function') { c.cleanup(); c.cleanup = undefined }
      inst.mounted = false
    }
    return inst.render()
  }
  return { hooks, mount, context: () => current.context() }
})

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ...R.hooks, useContext: () => R.context() }
})

// ── A fake `users/{uid}` listener with the measured SDK behaviour ────────────
const F = vi.hoisted(() => ({ listeners: [] }))
vi.mock('firebase/firestore', () => ({
  doc: (_db, ...segments) => ({ path: segments.join('/') }),
  onSnapshot: (ref, ...rest) => {
    // Both call shapes: (ref, next, error) and (ref, options, next, error).
    const options = typeof rest[0] === 'function' ? {} : rest.shift()
    const listener = { path: ref.path, options, next: rest[0], error: rest[1], subscribed: true, last: undefined }
    F.listeners.push(listener)
    return () => { listener.subscribed = false }
  },
}))
vi.mock('../../src/lib/firebase', () => ({ db: {} }))

const S = vi.hoisted(() => ({ user: null, signOut: null, profileContext: null }))
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: S.user, signOut: S.signOut }) }))
vi.mock('react-router-dom', () => ({ Outlet: () => 'APP-SHELL' }))

const { ProfileProvider } = await import('../../src/hooks/useProfile')
const { default: MembershipGate } = await import('../../src/components/MembershipGate')
const {
  membershipGate, profileCompanyId, GATE, foldProfileReport, EMPTY_PROFILE_SNAPSHOT, TEAM_ROLE_VALUES, EXTERNAL_ROLE_VALUES,
} = await import('../../src/lib/team')
const { KNOWN_ROLES, isKnownRole, formatRole } = await import('../../src/lib/formatters')
const { PROJECT_INTERNAL_ROLES, PROJECT_ASSIGNED_ROLES } = await import('../../src/lib/projects')

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const ACTIVE = { companyId: 'c1', role: 'qs', status: 'active' }
const DEACTIVATED = { companyId: null, role: 'qs', status: 'deactivated' }
const CACHE = { fromCache: true, hasPendingWrites: false }
const SERVER = { fromCache: false, hasPendingWrites: false }

const listenerFor = (uid) => F.listeners.filter((l) => l.path === `users/${uid}`).at(-1)
const open = () => F.listeners.filter((l) => l.subscribed)

// Deliver a snapshot the way the SDK does. A change of METADATA only (same
// data, different `fromCache`) reaches the listener only if it asked for
// metadata changes — measured: without the option, the server's confirmation
// that a document is missing is never delivered. `force` bypasses the SDK's
// own muting of an unsubscribed listener, to prove the provider's guard.
function emit(listener, data, metadata, { force = false } = {}) {
  if (!listener.subscribed && !force) return false
  const dataKey = JSON.stringify(data)
  const metadataOnly = listener.last !== undefined && listener.last === dataKey
  if (metadataOnly && listener.options.includeMetadataChanges !== true) return false
  listener.last = dataKey
  const id = listener.path.split('/')[1]
  listener.next({ id, exists: () => data !== null, data: () => (data === null ? undefined : { ...data }), metadata })
  return true
}
const fail = (listener, code, { force = false } = {}) => {
  if (!listener.subscribed && !force) return false
  listener.subscribed = false
  listener.error({ code })
  return true
}

// The provider and the gate, wired as App.jsx wires them: the gate reads the
// provider's context value.
function app({ strict = false } = {}) {
  const provider = R.mount(ProfileProvider, { strict })
  const value = () => provider.output.props.value
  const gateInstance = R.mount(MembershipGate, { strict, context: value })
  const sync = () => { provider.flush(); gateInstance.render(); return api }
  const api = {
    provider, value, sync,
    gate: () => membershipGate(value()),
    // What the gate component renders: the shell, the spinner, or a notice.
    screen: () => {
      const out = gateInstance.output
      if (typeof out?.type === 'string') return out.props['data-membership-gate']
      return out?.type?.name === 'Outlet' ? 'SHELL' : 'SPINNER'
    },
    signIn: (uid) => { S.user = { uid, email: `${uid}@example.test` }; provider.render(); return sync() },
    signOutOfAuth: () => { S.user = null; provider.render(); return sync() },
    unmount: () => { gateInstance.unmount(); provider.unmount() },
  }
  return api
}

beforeEach(() => {
  F.listeners.length = 0
  S.user = null
  // The gate's own sign-out (on a server-confirmed loss) — recorded, and it
  // does NOT change the auth state here; tests drive that explicitly.
  S.signOut = vi.fn(() => Promise.resolve())
})

// ── 1. The pure fold ─────────────────────────────────────────────────────────

describe('foldProfileReport — only a server-confirmed snapshot decides', () => {
  const start = { key: null, ...EMPTY_PROFILE_SNAPSHOT }
  const fold = (snap, report, key = 'u1|0') => foldProfileReport(snap, key, report)

  it('a cache-only missing document confirms nothing', () => {
    const s = fold(start, { profile: null, ...CACHE })
    expect(s).toMatchObject({ key: 'u1|0', profile: null, confirmed: false, error: false })
  })

  it('a cache-only active profile confirms nothing and hands out no profile', () => {
    const s = fold(start, { profile: { id: 'u1', ...ACTIVE }, ...CACHE })
    expect(s).toMatchObject({ profile: null, confirmed: false })
  })

  it('a snapshot with a pending local write confirms nothing, whatever it says', () => {
    for (const metadata of [{ fromCache: false, hasPendingWrites: true }, { fromCache: true, hasPendingWrites: true }]) {
      expect(fold(start, { profile: { id: 'u1', ...ACTIVE, role: 'company_admin' }, ...metadata }))
        .toMatchObject({ profile: null, confirmed: false })
    }
  })

  it('missing or malformed metadata is treated as unconfirmed (fails closed)', () => {
    for (const metadata of [{}, { fromCache: undefined, hasPendingWrites: false }, { fromCache: false }, { fromCache: null, hasPendingWrites: null }, { fromCache: 0, hasPendingWrites: 0 }]) {
      expect(fold(start, { profile: { id: 'u1', ...ACTIVE }, ...metadata }), JSON.stringify(metadata))
        .toMatchObject({ profile: null, confirmed: false })
    }
  })

  it('a server-confirmed profile, and a server-confirmed absence, are both confirmed', () => {
    expect(fold(start, { profile: { id: 'u1', ...ACTIVE }, ...SERVER }))
      .toMatchObject({ profile: { id: 'u1', ...ACTIVE }, confirmed: true, error: false })
    expect(fold(start, { profile: null, ...SERVER })).toMatchObject({ profile: null, confirmed: true, error: false })
  })

  it('after confirmation, a cache-only snapshot changes nothing — not even the object', () => {
    const confirmed = fold(start, { profile: { id: 'u1', ...ACTIVE }, ...SERVER })
    expect(fold(confirmed, { profile: { id: 'u1', ...ACTIVE }, ...CACHE })).toBe(confirmed)
    expect(fold(confirmed, { profile: null, ...CACHE })).toBe(confirmed)
    // A cached snapshot cannot promote either: the confirmed role stands.
    expect(fold(confirmed, { profile: { id: 'u1', ...ACTIVE, role: 'company_admin' }, ...CACHE })).toBe(confirmed)
  })

  it('a cached profile never overrides a server-confirmed deactivation or absence', () => {
    const deactivated = fold(start, { profile: { id: 'u1', ...DEACTIVATED }, ...SERVER })
    expect(fold(deactivated, { profile: { id: 'u1', ...ACTIVE }, ...CACHE })).toBe(deactivated)
    const absent = fold(start, { profile: null, ...SERVER })
    expect(fold(absent, { profile: { id: 'u1', ...ACTIVE }, ...CACHE })).toBe(absent)
  })

  it('the server repeating itself keeps the same object; a real change replaces it', () => {
    const confirmed = fold(start, { profile: { id: 'u1', ...ACTIVE }, ...SERVER })
    expect(fold(confirmed, { profile: { id: 'u1', ...ACTIVE }, ...SERVER })).toBe(confirmed)
    const changed = fold(confirmed, { profile: { id: 'u1', ...ACTIVE, role: 'project_manager' }, ...SERVER })
    expect(changed).not.toBe(confirmed)
    expect(changed.profile.role).toBe('project_manager')
    expect(fold(changed, { profile: { id: 'u1', ...ACTIVE, projectIds: ['p1'] }, ...SERVER }).profile.projectIds).toEqual(['p1'])
  })

  it('a report under a new key starts from nothing — no confirmation crosses identities', () => {
    const a = fold(start, { profile: { id: 'uA', ...ACTIVE, companyId: 'companyA' }, ...SERVER }, 'uA|0')
    const b = foldProfileReport(a, 'uB|0', { profile: null, ...CACHE })
    expect(b).toMatchObject({ key: 'uB|0', profile: null, confirmed: false, error: false })
    const b2 = foldProfileReport(a, 'uB|0', { profile: { id: 'uB', ...ACTIVE }, ...CACHE })
    expect(b2).toMatchObject({ key: 'uB|0', profile: null, confirmed: false })
    // The same uid under a new attempt is a new key too.
    expect(foldProfileReport(a, 'uA|1', { profile: null, ...CACHE })).toMatchObject({ profile: null, confirmed: false })
  })

  it('a listener error drops the profile and records the code; the attempt is kept', () => {
    const confirmed = { ...fold(start, { profile: { id: 'u1', ...ACTIVE }, ...SERVER }), attempt: 3 }
    const failed = foldProfileReport(confirmed, 'u1|0', { code: 'permission-denied' })
    expect(failed).toEqual({ key: 'u1|0', profile: null, confirmed: false, error: true, readCode: 'permission-denied', attempt: 3 })
  })

  it('never mutates its input', () => {
    const frozen = Object.freeze({ key: null, ...EMPTY_PROFILE_SNAPSHOT })
    const confirmed = Object.freeze(fold(frozen, { profile: Object.freeze({ id: 'u1', ...ACTIVE }), ...SERVER }))
    expect(() => fold(confirmed, { profile: null, ...CACHE })).not.toThrow()
    expect(() => fold(confirmed, { code: 'unavailable' })).not.toThrow()
  })
})

describe('membershipGate — the state contract', () => {
  const gate = (over) => membershipGate({ profile: null, profileLoading: false, profileError: false, profileErrorCode: null, profileWaiting: false, ...over })

  it('distinguishes every state', () => {
    expect(gate({ profileLoading: true })).toBe(GATE.LOADING)
    expect(gate({ profileLoading: true, profileWaiting: true })).toBe(GATE.WAITING)
    expect(gate({ profile: ACTIVE })).toBe(GATE.ACTIVE)
    expect(gate({})).toBe(GATE.NONE)
    expect(gate({ profile: DEACTIVATED })).toBe(GATE.DEACTIVATED)
    expect(gate({ profileError: true, profileErrorCode: 'permission-denied' })).toBe(GATE.REFUSED)
    expect(gate({ profileError: true, profileErrorCode: 'unavailable' })).toBe(GATE.ERROR)
    expect(gate({ profile: { companyId: 'c1' } })).toBe(GATE.INVALID)
    expect(new Set(Object.values(GATE)).size).toBe(8)
  })

  it('an unresolved or failed read admits nobody, whatever profile is passed with it', () => {
    for (const over of [
      { profileLoading: true }, { profileLoading: true, profileWaiting: true }, { profileWaiting: true },
      { profileError: true, profileErrorCode: 'permission-denied' }, { profileError: true, profileErrorCode: 'internal' },
      { profileError: true, profileErrorCode: null }, { profileError: true },
    ]) {
      expect(gate({ profile: ACTIVE, ...over }), JSON.stringify(over)).not.toBe(GATE.ACTIVE)
    }
  })

  it('a failed read is never "no membership", whatever the code', () => {
    for (const profileErrorCode of ['unavailable', 'internal', 'resource-exhausted', 'unauthenticated', 'unknown', null, undefined]) {
      expect(gate({ profileError: true, profileErrorCode }), String(profileErrorCode)).toBe(GATE.ERROR)
    }
  })

  it('invalid membership data does not admit', () => {
    for (const profile of [
      {}, { role: 'company_admin' }, { companyId: null, role: 'qs' }, { companyId: '', role: 'qs' },
      { companyId: 42, role: 'qs' }, { companyId: ['c1'], role: 'qs' }, { companyId: { id: 'c1' }, role: 'qs' },
      { companyId: true, role: 'qs' }, { companyId: 'c1', status: 'deactivated', role: 'company_admin' },
    ]) {
      expect(gate({ profile }), JSON.stringify(profile)).not.toBe(GATE.ACTIVE)
    }
  })

  it('a legacy profile without a status is active, as the rules treat it', () => {
    expect(gate({ profile: { companyId: 'c1', role: 'qs' } })).toBe(GATE.ACTIVE)
  })
})

// ── 2. The real provider and gate ────────────────────────────────────────────

describe('A. initial resolution', () => {
  it('D3 #32 REGRESSION — a cache-only missing profile is not "No active membership"', () => {
    const a = app().signIn('u1')
    // Backend unreachable: the SDK answers from its empty cache.
    emit(listenerFor('u1'), null, CACHE); a.sync()

    expect(a.gate()).not.toBe(GATE.NONE)
    expect(a.gate()).toBe(GATE.WAITING)
    expect(a.screen()).toBe(GATE.WAITING)
    expect(a.value()).toMatchObject({ profile: null, profileLoading: true, profileError: false, profileWaiting: true })
    expect(S.signOut).not.toHaveBeenCalled()

    // The server answers: the member is admitted, with no reload.
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.gate()).toBe(GATE.ACTIVE)
    expect(a.screen()).toBe('SHELL')
    expect(a.value()).toMatchObject({ profile: { id: 'u1', ...ACTIVE }, profileLoading: false, profileWaiting: false })
    expect(F.listeners).toHaveLength(1)
  })

  it('before any answer: loading, the spinner, no protected content', () => {
    const a = app().signIn('u1')
    expect(a.gate()).toBe(GATE.LOADING)
    expect(a.screen()).toBe('SPINNER')
    expect(a.value()).toMatchObject({ profile: null, profileLoading: true, profileWaiting: false })
  })

  it('a cache-only ACTIVE profile does not grant initial access', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    expect(a.gate()).toBe(GATE.WAITING)
    expect(a.screen()).not.toBe('SHELL')
    // Nothing from the cached document is handed to any consumer.
    expect(a.value().profile).toBeNull()
    expect(a.value().profileLoading).toBe(true)
  })

  it('an unconfirmed local write does not grant initial access', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), { ...ACTIVE, role: 'company_admin' }, { fromCache: false, hasPendingWrites: true }); a.sync()
    expect(a.screen()).not.toBe('SHELL')
    expect(a.value().profile).toBeNull()
  })

  it('a server-confirmed active profile resolves at once', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(a.value().profile).toEqual({ id: 'u1', ...ACTIVE })
  })

  it('a server-confirmed MISSING profile shows the denial', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), null, SERVER); a.sync()
    expect(a.gate()).toBe(GATE.NONE)
    expect(a.screen()).toBe(GATE.NONE)
    expect(a.value()).toMatchObject({ profile: null, profileLoading: false, profileWaiting: false, profileError: false })
  })

  it('a server-confirmed INACTIVE profile is denied', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(a.gate()).toBe(GATE.DEACTIVATED)
    expect(a.screen()).toBe(GATE.DEACTIVATED)
  })

  it('signed out: idle — no listener, no profile, not loading', () => {
    const a = app()
    expect(F.listeners).toHaveLength(0)
    expect(a.value()).toMatchObject({ profile: null, profileLoading: false, profileWaiting: false, profileError: false })
  })
})

describe('B. metadata and connectivity', () => {
  it('the listener asks for metadata changes', () => {
    app().signIn('u1')
    expect(listenerFor('u1').options).toEqual({ includeMetadataChanges: true })
  })

  it('a genuine non-member is confirmed by a METADATA-ONLY server snapshot', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), null, CACHE); a.sync()
    expect(a.gate()).toBe(GATE.WAITING)
    // Same data (still missing); only `fromCache` changes.
    expect(emit(listenerFor('u1'), null, SERVER)).toBe(true); a.sync()
    expect(a.gate()).toBe(GATE.NONE)
  })

  it('a member whose cached profile is confirmed by a metadata-only snapshot is admitted', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    expect(a.screen()).not.toBe('SHELL')
    expect(emit(listenerFor('u1'), ACTIVE, SERVER)).toBe(true); a.sync()
    expect(a.screen()).toBe('SHELL')
  })

  it('the fake listener is faithful: without the option the confirmation is never delivered', () => {
    const delivered = []
    const plain = { path: 'users/u1', options: {}, next: (s) => delivered.push(s), subscribed: true, last: undefined }
    expect(emit(plain, null, CACHE)).toBe(true)
    expect(emit(plain, null, SERVER)).toBe(false)
    expect(delivered).toHaveLength(1)
  })

  it('temporary unavailability: waiting for as long as it lasts, then recovery without a reload', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), null, CACHE); a.sync()
    for (let i = 0; i < 5; i++) { a.sync(); expect(a.gate()).toBe(GATE.WAITING) }
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(F.listeners).toHaveLength(1)
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('an established session keeps its confirmed profile through repeated disconnections', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    const profile = a.value().profile
    const renders = a.provider.renders
    for (let i = 0; i < 4; i++) {
      emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()   // connection lost
      expect(a.screen()).toBe('SHELL')
      expect(a.value()).toMatchObject({ profileLoading: false, profileWaiting: false, profileError: false })
      emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()  // and back
      expect(a.screen()).toBe('SHELL')
    }
    // The very same object, and the provider never re-rendered: nothing below
    // it (an open financial dialog, an uncertain write) was disturbed.
    expect(a.value().profile).toBe(profile)
    expect(a.provider.renders).toBe(renders)
    expect(F.listeners).toHaveLength(1)
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('a refused read is REFUSED — not a membership statement, and not an authorised state', () => {
    const a = app().signIn('u1')
    fail(listenerFor('u1'), 'permission-denied'); a.sync()
    expect(a.gate()).toBe(GATE.REFUSED)
    expect(a.screen()).toBe(GATE.REFUSED)
    expect(a.value()).toMatchObject({ profile: null, profileLoading: false, profileError: true, profileErrorCode: 'permission-denied' })
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('a refused read after confirmation removes the shell — the confirmed profile is not kept', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    fail(listenerFor('u1'), 'permission-denied'); a.sync()
    expect(a.screen()).toBe(GATE.REFUSED)
    expect(a.value().profile).toBeNull()
  })

  it('any other terminal failure is ERROR', () => {
    for (const code of ['unavailable', 'internal', 'resource-exhausted', 'unauthenticated', undefined]) {
      F.listeners.length = 0
      const a = app().signIn('u1')
      fail(listenerFor('u1'), code); a.sync()
      expect(a.gate(), String(code)).toBe(GATE.ERROR)
      expect(a.value().profileErrorCode).toBe(code ?? 'unknown')
      a.unmount(); S.user = null
    }
  })

  it('Try again re-opens ONE listener, returns to loading, and can then succeed', () => {
    const a = app().signIn('u1')
    fail(listenerFor('u1'), 'permission-denied'); a.sync()
    a.value().retryProfile(); a.sync()
    expect(F.listeners).toHaveLength(2)
    expect(open()).toHaveLength(1)
    expect(a.gate()).toBe(GATE.LOADING)
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
  })

  it('Try again while still refused shows the refusal again; a retried cache answer is still unconfirmed', () => {
    const a = app().signIn('u1')
    fail(listenerFor('u1'), 'permission-denied'); a.sync()
    a.value().retryProfile(); a.sync()
    fail(listenerFor('u1'), 'permission-denied'); a.sync()
    expect(a.gate()).toBe(GATE.REFUSED)
    a.value().retryProfile(); a.sync()
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    expect(a.gate()).toBe(GATE.WAITING)
    expect(a.value().profile).toBeNull()
    expect(open()).toHaveLength(1)
  })

  it('retry does nothing unless the read has failed', () => {
    const a = app().signIn('u1')
    a.value().retryProfile(); a.sync()
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    a.value().retryProfile(); a.sync()
    expect(F.listeners).toHaveLength(1)
    expect(a.screen()).toBe('SHELL')
  })
})

describe('C. security and identity lifecycle', () => {
  it('a cached active profile followed by a server-confirmed deactivation never admits', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    expect(a.screen()).not.toBe('SHELL')
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(a.gate()).toBe(GATE.DEACTIVATED)
    expect(a.screen()).toBe(GATE.DEACTIVATED)
    // Never admitted, so there is no session to end.
    expect(S.signOut).not.toHaveBeenCalled()
    // A later cached "active" cannot undo what the server said.
    emit(listenerFor('u1'), ACTIVE, CACHE, { force: true }); a.sync()
    expect(a.gate()).toBe(GATE.DEACTIVATED)
  })

  it('deactivation of an established session removes the shell and signs out, once', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(a.screen()).toBe(GATE.DEACTIVATED)
    expect(S.signOut).toHaveBeenCalledTimes(1)
    a.sync(); a.sync()
    expect(S.signOut).toHaveBeenCalledTimes(1)
  })

  it('deactivation while disconnected takes effect on the first server snapshot after reconnection', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    expect(a.screen()).toBe('SHELL')
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(a.screen()).toBe(GATE.DEACTIVATED)
    expect(S.signOut).toHaveBeenCalledTimes(1)
  })

  it('a server-confirmed deletion of the profile of an established session denies and signs out', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    emit(listenerFor('u1'), null, SERVER); a.sync()
    expect(a.screen()).toBe(GATE.NONE)
    expect(S.signOut).toHaveBeenCalledTimes(1)
  })

  it('nobody is signed out for being offline, or for a failed read', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    emit(listenerFor('u1'), null, CACHE, { force: true }); a.sync()
    expect(a.screen()).toBe('SHELL')
    fail(listenerFor('u1'), 'unavailable'); a.sync()
    expect(a.screen()).toBe(GATE.ERROR)
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('role and project-assignment changes reach the app from the server, and only from the server', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), { ...ACTIVE, role: 'subcontractor', projectIds: ['p1', 'p2'] }, SERVER); a.sync()
    expect(a.value().profile).toMatchObject({ role: 'subcontractor', projectIds: ['p1', 'p2'] })

    // A cached snapshot claiming more cannot widen anything.
    emit(listenerFor('u1'), { ...ACTIVE, role: 'company_admin', projectIds: ['p1', 'p2', 'p3'] }, CACHE); a.sync()
    expect(a.value().profile).toMatchObject({ role: 'subcontractor', projectIds: ['p1', 'p2'] })

    // Assignment revoked, then role changed — each server snapshot applies.
    emit(listenerFor('u1'), { ...ACTIVE, role: 'subcontractor', projectIds: ['p1'] }, SERVER); a.sync()
    expect(a.value().profile.projectIds).toEqual(['p1'])
    emit(listenerFor('u1'), { ...ACTIVE, role: 'qs' }, SERVER); a.sync()
    expect(a.value().profile.role).toBe('qs')
    expect(a.value().profile.projectIds).toBeUndefined()
    expect(a.screen()).toBe('SHELL')
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('an identity switch never shows the previous profile, and waits for the new uid\'s server answer', () => {
    const a = app().signIn('uA')
    emit(listenerFor('uA'), { ...ACTIVE, companyId: 'companyA', role: 'company_admin' }, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    const listenerA = listenerFor('uA')

    a.signIn('uB')   // the auth identity changes directly from A to B
    expect(listenerA.subscribed).toBe(false)
    expect(open()).toHaveLength(1)
    expect(a.value()).toMatchObject({ profile: null, profileLoading: true })
    expect(a.screen()).toBe('SPINNER')

    emit(listenerFor('uB'), null, CACHE); a.sync()
    expect(a.gate()).toBe(GATE.WAITING)
    expect(a.value().profile).toBeNull()

    emit(listenerFor('uB'), { ...ACTIVE, companyId: 'companyB' }, SERVER); a.sync()
    expect(a.value().profile).toEqual({ id: 'uB', ...ACTIVE, companyId: 'companyB' })
  })

  it('a late callback from the previous user changes nothing', () => {
    const a = app().signIn('uA')
    const listenerA = listenerFor('uA')
    emit(listenerA, { ...ACTIVE, companyId: 'companyA', role: 'company_admin' }, SERVER); a.sync()
    a.signIn('uB')
    const before = a.value()

    // Delivered although unsubscribed — the provider's own guard must hold.
    emit(listenerA, { ...ACTIVE, companyId: 'companyA', role: 'super_admin' }, SERVER, { force: true }); a.sync()
    fail(listenerA, 'permission-denied', { force: true }); a.sync()
    expect(a.value()).toMatchObject({ profile: null, profileLoading: true, profileError: false })
    expect(a.value().profile).toBe(before.profile)
    expect(a.screen()).toBe('SPINNER')

    // And after B has resolved, A's late callback cannot replace B's profile.
    emit(listenerFor('uB'), { ...ACTIVE, companyId: 'companyB' }, SERVER); a.sync()
    emit(listenerA, { ...ACTIVE, companyId: 'companyA', role: 'company_admin' }, SERVER, { force: true }); a.sync()
    expect(a.value().profile).toEqual({ id: 'uB', ...ACTIVE, companyId: 'companyB' })
  })

  it('rapid authentication changes leave exactly one listener, for the last identity', () => {
    const a = app()
    for (const uid of ['uA', 'uB', 'uA', 'uC']) a.signIn(uid)
    a.signOutOfAuth(); a.signIn('uD')
    expect(open().map((l) => l.path)).toEqual(['users/uD'])
    // Every abandoned listener answers late; none of it lands.
    for (const l of F.listeners.filter((x) => !x.subscribed)) emit(l, { ...ACTIVE, role: 'company_admin' }, SERVER, { force: true })
    a.sync()
    expect(a.value()).toMatchObject({ profile: null, profileLoading: true })
    emit(listenerFor('uD'), ACTIVE, SERVER); a.sync()
    expect(a.value().profile.id).toBe('uD')
  })

  it('signing back in as the same uid does not reuse the earlier confirmation', () => {
    const a = app().signIn('uA')
    emit(listenerFor('uA'), ACTIVE, SERVER); a.sync()
    a.signOutOfAuth()
    a.signIn('uA')
    // The SDK may still hold the document: it answers from the cache first.
    emit(listenerFor('uA'), ACTIVE, CACHE); a.sync()
    expect(a.screen()).not.toBe('SHELL')
    expect(a.value().profile).toBeNull()
    emit(listenerFor('uA'), DEACTIVATED, SERVER); a.sync()
    expect(a.gate()).toBe(GATE.DEACTIVATED)
  })

  it('sign-out during pending resolution: the listener closes, the state is idle, late answers are ignored', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), null, CACHE); a.sync()
    const l = listenerFor('u1')
    a.signOutOfAuth()
    expect(l.subscribed).toBe(false)
    expect(open()).toHaveLength(0)
    expect(a.value()).toMatchObject({ profile: null, profileLoading: false, profileWaiting: false, profileError: false })
    emit(l, ACTIVE, SERVER, { force: true }); a.sync()
    expect(a.value()).toMatchObject({ profile: null, profileLoading: false })
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('unmount closes the listener, and a late callback after unmount is ignored', () => {
    const a = app().signIn('u1')
    const l = listenerFor('u1')
    emit(l, ACTIVE, SERVER); a.sync()
    a.unmount()
    expect(open()).toHaveLength(0)
    // The provider's state cell after its clean-up: nothing confirmed is kept.
    const state = a.provider.cells[0].state
    expect(state).toMatchObject({ key: null, profile: null, confirmed: false })
    emit(l, DEACTIVATED, SERVER, { force: true })
    fail(l, 'permission-denied', { force: true })
    expect(a.provider.cells[0].state).toBe(state)
  })

  it('React Strict Mode: the doubled mount leaves one live listener and the first one inert', () => {
    S.user = { uid: 'u1', email: 'u1@example.test' }
    const a = app({ strict: true }); a.sync()
    expect(F.listeners).toHaveLength(2)
    expect(open()).toHaveLength(1)
    const [first, second] = F.listeners
    emit(first, { ...ACTIVE, role: 'company_admin' }, SERVER, { force: true }); a.sync()
    expect(a.value()).toMatchObject({ profile: null, profileLoading: true })
    emit(second, ACTIVE, SERVER); a.sync()
    expect(a.value().profile.role).toBe('qs')
    expect(a.screen()).toBe('SHELL')
  })

  it('invalid membership data from the server does not admit', () => {
    for (const [data, expected] of [
      [{}, GATE.NONE], [{ role: 'company_admin' }, GATE.NONE], [{ companyId: '', role: 'qs' }, GATE.NONE],
      [{ companyId: null, role: 'qs', status: 'active' }, GATE.NONE],
      [{ companyId: 7, role: 'qs' }, GATE.INVALID], [{ companyId: 'c1' }, GATE.INVALID],
    ]) {
      F.listeners.length = 0; S.user = null
      const a = app().signIn('u1')
      emit(listenerFor('u1'), data, SERVER); a.sync()
      expect(a.screen(), JSON.stringify(data)).toBe(expected)
      a.unmount()
    }
  })

  it('one listener per identity, on that identity\'s own document, and no other read', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), null, CACHE); a.sync()
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(F.listeners.map((l) => l.path)).toEqual(['users/u1'])
  })
})

describe('D. existing workflows', () => {
  it('invitation acceptance: a confirmed non-member becomes a member when the backend creates the profile', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), null, SERVER); a.sync()
    expect(a.gate()).toBe(GATE.NONE)
    // acceptInvitation (trusted backend) writes users/{uid}; the listener hears it.
    emit(listenerFor('u1'), { companyId: 'c1', role: 'project_manager', status: 'active' }, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(S.signOut).not.toHaveBeenCalled()
    expect(F.listeners).toHaveLength(1)
  })

  it('reactivation: a confirmed deactivated profile becomes active again without a reload', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(a.screen()).toBe(GATE.DEACTIVATED)
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('a member removed and invited again is signed out once, then admitted on the new session', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(S.signOut).toHaveBeenCalledTimes(1)
    a.signOutOfAuth(); a.signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(S.signOut).toHaveBeenCalledTimes(1)
  })

  it('established session reconnection: the shell never unmounts, so an uncertain write is not lost or repeated', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    const screens = []
    for (const metadata of [CACHE, CACHE, SERVER, CACHE, SERVER]) {
      emit(listenerFor('u1'), ACTIVE, metadata); a.sync()
      screens.push(a.screen())
    }
    // The write-outcome controller (lib/writeOutcome.js) lives in the pages
    // below the shell; it survives only if the shell is never replaced.
    expect(screens).toEqual(['SHELL', 'SHELL', 'SHELL', 'SHELL', 'SHELL'])
    expect(a.value()).toMatchObject({ profileLoading: false, profileWaiting: false })
  })

  it('the L3 write-outcome helper and the money registers are untouched by this correction', () => {
    const page = (name) => stripComments(read(`src/pages/project/${name}.jsx`))
    for (const name of ['ProjectClientInvoices', 'ProjectClientReceipts', 'ProjectSupplierPayments']) {
      expect(page(name)).toContain('useWriteAction')
      expect(page(name)).not.toMatch(/profileWaiting|retryProfile|profileErrorCode/)
    }
    expect(stripComments(read('src/lib/writeOutcome.js'))).not.toMatch(/profile/i)
  })
})

// ── Membership role validation (architect correction, 25 November 2026) ──────
//
// A server-confirmed profile that names a company enters the shell only with
// one of the six documented roles. Anything else is INVALID: not admitted,
// not "no membership", not a connection problem, and not a sign-out.

describe('E. membership role validation', () => {
  const gate = (profile) => membershipGate({ profile, profileLoading: false, profileError: false, profileErrorCode: null, profileWaiting: false })
  const SUPPORTED = ['company_admin', 'project_manager', 'qs', 'subcontractor', 'client', 'super_admin']
  const BAD_ROLES = [
    ['missing', undefined], ['null', null], ['empty', ''], ['blank', ' '], ['unknown', 'owner'], ['unknown — admin', 'admin'],
    ['wrong case', 'Company_Admin'], ['padded', ' qs'], ['label, not value', 'Company Admin'], ['number', 1], ['zero', 0],
    ['boolean', true], ['array of a valid role', ['company_admin']], ['object', { value: 'company_admin' }],
    ['inherited key', 'toString'], ['inherited key', 'constructor'], ['inherited key', '__proto__'],
  ]
  const BAD_COMPANY_IDS = [['number', 42], ['zero', 0], ['boolean', true], ['array', ['c1']], ['object', { id: 'c1' }]]

  it('the one role registry: the label table, the backend vocabulary and the data model agree', async () => {
    expect([...KNOWN_ROLES].sort()).toEqual([...SUPPORTED].sort())
    // Every role the app's own predicates name is a known role — no second list.
    for (const role of [...TEAM_ROLE_VALUES, ...EXTERNAL_ROLE_VALUES, ...PROJECT_INTERNAL_ROLES, ...PROJECT_ASSIGNED_ROLES]) {
      expect(isKnownRole(role), role).toBe(true)
    }
    // The trusted backend's vocabulary (functions/src/lib/validation.js), read
    // as source so this test needs none of its dependencies.
    const backend = read('functions/src/lib/validation.js')
    const list = (name) => JSON.parse(backend.match(new RegExp(`export const ${name} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'))
    expect([...list('INTERNAL_ROLES'), ...list('OPERATOR_ROLES')].sort()).toEqual([...KNOWN_ROLES].sort())
    // And the documented enum (DATA_MODEL.md → users/{uid}.role).
    const documented = read('../docs/DATA_MODEL.md').match(/\| `role` \| string \| ([^\n]*) \|/)[1].match(/`(\w+)`/g).map((x) => x.replace(/`/g, ''))
    expect(documented.sort()).toEqual([...KNOWN_ROLES].sort())
    // A label exists for every known role (the table is the registry).
    for (const role of KNOWN_ROLES) expect(formatRole(role)).not.toBe(role)
  })

  it('every supported role is admitted — with and without a status (legacy profiles)', () => {
    for (const role of SUPPORTED) {
      expect(gate({ companyId: 'c1', role, status: 'active' }), role).toBe(GATE.ACTIVE)
      expect(gate({ companyId: 'c1', role }), `${role} (legacy, no status)`).toBe(GATE.ACTIVE)
    }
    expect(gate({ companyId: 'c1', role: 'client', status: 'active', projectIds: ['p1'] })).toBe(GATE.ACTIVE)
    // An external member whose assignments were all removed is still a member.
    expect(gate({ companyId: 'c1', role: 'subcontractor', status: 'active', projectIds: [] })).toBe(GATE.ACTIVE)
  })

  it('a missing, null, empty, unknown or non-string role is INVALID', () => {
    for (const [name, role] of BAD_ROLES) {
      const profile = role === undefined ? { companyId: 'c1', status: 'active' } : { companyId: 'c1', status: 'active', role }
      expect(gate(profile), name).toBe(GATE.INVALID)
    }
  })

  it('a malformed companyId is INVALID; an absent one is still "no membership"', () => {
    for (const [name, companyId] of BAD_COMPANY_IDS) {
      expect(gate({ companyId, role: 'company_admin', status: 'active' }), name).toBe(GATE.INVALID)
    }
    for (const companyId of [null, undefined, '']) {
      expect(gate({ companyId, role: 'company_admin' }), String(companyId)).toBe(GATE.NONE)
      expect(gate({ companyId, role: null }), String(companyId)).toBe(GATE.NONE)
    }
  })

  it('a malformed companyId never reaches a document path (CompanyProvider sits ABOVE the gate)', () => {
    for (const [, companyId] of BAD_COMPANY_IDS) expect(profileCompanyId({ companyId, role: 'company_admin' })).toBeNull()
    for (const profile of [null, undefined, {}, { companyId: null }, { companyId: '' }]) expect(profileCompanyId(profile)).toBeNull()
    expect(profileCompanyId({ companyId: 'c1' })).toBe('c1')
    // Measured in a browser: `doc(db, 'companies', 42)` throws inside the SDK
    // and the error boundary replaces the whole app. The provider must take
    // its target from the helper, and from nowhere else.
    const company = stripComments(read('src/hooks/useCompany.jsx'))
    expect(company).toContain('const companyId = profileCompanyId(profile)')
    expect(company).not.toMatch(/profile\??\.companyId/)
    expect(company).toContain("doc(db, 'companies', companyId)")
    expect(company).toContain('}, [companyId])')
  })

  // Strings that are not company ids. What the SDK does with each was measured
  // (TESTING.md §75.11): two throw, two resolve to a DIFFERENT document.
  const BAD_COMPANY_STRINGS = [
    'a/b', 'a//b', 'c1/', '/c1', 'a/b/c', 'c1/projects/p1', ' ', ' c1', 'c1 ', 'a b', 'a\tb', 'a\nb', '.', '..',
    'é', 'c1.x', 'c1#', 'A'.repeat(65),
  ]

  it('a companyId STRING outside the id contract names no company: no path is built, and the gate says invalid', () => {
    for (const companyId of BAD_COMPANY_STRINGS) {
      expect(profileCompanyId({ companyId, role: 'company_admin' }), JSON.stringify(companyId)).toBeNull()
      expect(gate({ companyId, role: 'company_admin', status: 'active' }), JSON.stringify(companyId)).toBe(GATE.INVALID)
    }
    // The shapes real ids have: a 20-character auto-id, a hyphenated slug, the 64-character limit.
    for (const companyId of ['3OyBieoY4QHAfQsxBH8T', 'constrap-acceptance-test', 'a', 'A_b-9', 'A'.repeat(64)]) {
      expect(profileCompanyId({ companyId })).toBe(companyId)
      expect(gate({ companyId, role: 'qs' })).toBe(GATE.ACTIVE)
    }
  })

  it('the id contract is the backend\'s own (functions/src/lib/validation.js → ID_RE), not a new one', () => {
    const backend = read('functions/src/lib/validation.js').match(/export const ID_RE = (\/.*\/)/)[1]
    const client = read('src/lib/team.js').match(/const ID_RE = (\/.*\/)/)[1]
    expect(client).toBe(backend)
    expect(stripComments(read('src/lib/team.js')).match(/_RE = \//g)).toHaveLength(2)   // ID_RE and TOKEN_RE only
  })

  it('real provider and gate: a malformed companyId string shows the notice, never the shell', () => {
    for (const companyId of BAD_COMPANY_STRINGS) {
      F.listeners.length = 0; S.user = null
      const a = app().signIn('u1')
      emit(listenerFor('u1'), { companyId, role: 'company_admin', status: 'active' }, SERVER); a.sync()
      expect(a.screen(), JSON.stringify(companyId)).toBe(GATE.INVALID)
      a.unmount()
    }
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('a deactivated profile is DEACTIVATED, never INVALID — deactivation leaves role null by design', () => {
    expect(gate({ companyId: null, role: null, status: 'deactivated', formerRole: 'qs', formerCompanyId: 'c1' })).toBe(GATE.DEACTIVATED)
    expect(gate({ companyId: 'c1', role: 'owner', status: 'deactivated' })).toBe(GATE.DEACTIVATED)
    expect(gate({ companyId: 42, role: 7, status: 'deactivated' })).toBe(GATE.DEACTIVATED)
  })

  it('an unresolved or failed read is never INVALID, whatever profile is passed with it', () => {
    const bad = { companyId: 'c1', role: 'owner' }
    expect(membershipGate({ profile: bad, profileLoading: true, profileWaiting: true })).toBe(GATE.WAITING)
    expect(membershipGate({ profile: bad, profileLoading: true })).toBe(GATE.LOADING)
    expect(membershipGate({ profile: bad, profileError: true, profileErrorCode: 'permission-denied' })).toBe(GATE.REFUSED)
    expect(membershipGate({ profile: bad, profileError: true, profileErrorCode: 'unavailable' })).toBe(GATE.ERROR)
  })

  it('real provider and gate: every supported role reaches the shell', () => {
    for (const role of SUPPORTED) {
      F.listeners.length = 0; S.user = null
      const a = app().signIn('u1')
      emit(listenerFor('u1'), { companyId: 'c1', role, status: 'active' }, SERVER); a.sync()
      expect(a.screen(), role).toBe('SHELL')
      expect(a.value().profile.role).toBe(role)
      a.unmount()
    }
  })

  it('real provider and gate: malformed membership never renders the shell, and never signs out', () => {
    const malformed = [
      ...BAD_ROLES.map(([, role]) => (role === undefined ? { companyId: 'c1', status: 'active' } : { companyId: 'c1', status: 'active', role })),
      ...BAD_COMPANY_IDS.map(([, companyId]) => ({ companyId, role: 'company_admin', status: 'active' })),
    ]
    for (const data of malformed) {
      F.listeners.length = 0; S.user = null
      const a = app().signIn('u1')
      emit(listenerFor('u1'), data, SERVER); a.sync()
      expect(a.screen(), JSON.stringify(data)).toBe(GATE.INVALID)
      expect(a.screen()).not.toBe('SHELL')
      a.unmount()
    }
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('a cached valid role cannot repair a server-confirmed invalid one', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), { companyId: 'c1', role: 'owner', status: 'active' }, SERVER); a.sync()
    emit(listenerFor('u1'), ACTIVE, CACHE); a.sync()
    expect(a.screen()).toBe(GATE.INVALID)
  })

  it('valid role changes keep the shell: each of the five member roles in turn', () => {
    const a = app().signIn('u1')
    for (const role of ['qs', 'project_manager', 'company_admin', 'subcontractor', 'client', 'qs']) {
      emit(listenerFor('u1'), { companyId: 'c1', role, status: 'active' }, SERVER); a.sync()
      expect(a.screen(), role).toBe('SHELL')
      expect(a.value().profile.role).toBe(role)
    }
    expect(S.signOut).not.toHaveBeenCalled()
    expect(F.listeners).toHaveLength(1)
  })

  it('server-confirmed role invalidation removes the shell — without signing out — and recovers when corrected', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), ACTIVE, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')

    for (const role of [null, '', 'owner', 3]) {
      emit(listenerFor('u1'), { companyId: 'c1', status: 'active', role }, SERVER); a.sync()
      expect(a.screen(), String(role)).toBe(GATE.INVALID)
      expect(a.value().profileLoading).toBe(false)
    }
    emit(listenerFor('u1'), { companyId: 'c1', status: 'active' }, SERVER); a.sync()   // the field removed
    expect(a.screen()).toBe(GATE.INVALID)
    // Not a loss of membership: the session is kept, the listener stays open.
    expect(S.signOut).not.toHaveBeenCalled()
    expect(open()).toHaveLength(1)

    // Corrected on the server: admitted again, no reload, no new listener.
    emit(listenerFor('u1'), { companyId: 'c1', status: 'active', role: 'project_manager' }, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(a.value().profile.role).toBe('project_manager')
    expect(F.listeners).toHaveLength(1)
  })

  it('an invalid profile that is then deactivated is a real loss — but only an ADMITTED session is signed out', () => {
    // Never admitted: invalid → deactivated shows the notice, no sign-out.
    const a = app().signIn('u1')
    emit(listenerFor('u1'), { companyId: 'c1', role: 'owner' }, SERVER); a.sync()
    emit(listenerFor('u1'), DEACTIVATED, SERVER); a.sync()
    expect(a.screen()).toBe(GATE.DEACTIVATED)
    expect(S.signOut).not.toHaveBeenCalled()
    a.unmount(); F.listeners.length = 0; S.user = null

    // Admitted, invalidated, then deactivated: the existing sign-out applies.
    const b = app().signIn('u2')
    emit(listenerFor('u2'), ACTIVE, SERVER); b.sync()
    emit(listenerFor('u2'), { companyId: 'c1', role: null, status: 'active' }, SERVER); b.sync()
    expect(S.signOut).not.toHaveBeenCalled()
    emit(listenerFor('u2'), DEACTIVATED, SERVER); b.sync()
    expect(b.screen()).toBe(GATE.DEACTIVATED)
    expect(S.signOut).toHaveBeenCalledTimes(1)
  })

  it('invitation acceptance: what the backend writes admits, for every role it can write', () => {
    // acceptInvitation writes companyId, role and status in ONE commit, for an
    // internal role or (operator invitations, ADR-84) an external one.
    for (const [role, extra] of [['company_admin', {}], ['project_manager', {}], ['qs', {}], ['client', { projectIds: ['p1'] }], ['subcontractor', { projectIds: ['p1', 'p2'] }]]) {
      F.listeners.length = 0; S.user = null
      const a = app().signIn('u1')
      emit(listenerFor('u1'), null, SERVER); a.sync()
      expect(a.screen()).toBe(GATE.NONE)
      emit(listenerFor('u1'), { companyId: 'c1', role, status: 'active', email: 'u1@example.test', name: 'U One', inviteId: 'i1', ...extra }, SERVER); a.sync()
      expect(a.screen(), role).toBe('SHELL')
      a.unmount()
    }
    expect(S.signOut).not.toHaveBeenCalled()
    // The backend source: one write carries the three fields together.
    const accept = read('functions/src/lib/invitations.js')
    expect(accept).toMatch(/role: current\.role, status: MEMBER_STATUS\.ACTIVE/)
  })

  it('account reactivation: deactivated (role null) → re-accepted with a role → admitted', () => {
    const a = app().signIn('u1')
    emit(listenerFor('u1'), { companyId: null, role: null, status: 'deactivated', formerRole: 'qs', formerCompanyId: 'c1' }, SERVER); a.sync()
    expect(a.screen()).toBe(GATE.DEACTIVATED)
    emit(listenerFor('u1'), { companyId: 'c1', role: 'qs', status: 'active', formerRole: null, formerCompanyId: null }, SERVER); a.sync()
    expect(a.screen()).toBe('SHELL')
    expect(S.signOut).not.toHaveBeenCalled()
  })

  it('the gate source: INVALID never triggers the sign-out, and shows no retry control', () => {
    const gateSrc = stripComments(read('src/components/MembershipGate.jsx'))
    expect(gateSrc).toMatch(/wasActive\.current && \(gate === GATE\.NONE \|\| gate === GATE\.DEACTIVATED\)/)
    expect(gateSrc).toContain('const canRetry = gate === GATE.ERROR || gate === GATE.REFUSED')
    expect(gateSrc).toContain('[GATE.INVALID]')
  })
})

// ── 3. Source structure ──────────────────────────────────────────────────────

describe('no new mechanism', () => {
  const provider = stripComments(read('src/hooks/useProfile.jsx'))
  const gate = stripComments(read('src/components/MembershipGate.jsx'))
  const firebase = stripComments(read('src/lib/firebase.js'))

  it('no polling, timer or one-shot read in the provider or the gate', () => {
    for (const src of [provider, gate]) {
      expect(src).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|getDoc\b|getDocFromServer|getDocFromCache/)
    }
    expect(provider.match(/onSnapshot\(/g)).toHaveLength(1)
  })

  it('the gate never reloads the page and signs out only on a server-confirmed loss', () => {
    expect(gate).not.toMatch(/location\.reload/)
    expect(gate).toMatch(/wasActive\.current && \(gate === GATE\.NONE \|\| gate === GATE\.DEACTIVATED\)[\s\S]*signOut\(\)/)
    expect(gate).not.toMatch(/GATE\.(WAITING|ERROR|REFUSED)[^\n]*signOut/)
    expect(gate).toContain('if (gate === GATE.ACTIVE) return <Outlet />')
    expect(gate.match(/<Outlet \/>/g)).toHaveLength(1)
    expect(gate).not.toMatch(/from\s*'firebase\//)
  })

  it('offline persistence is not enabled, and there is no service worker', () => {
    expect(firebase).toContain('getFirestore(app)')
    expect(firebase).not.toMatch(/persistentLocalCache|enableIndexedDbPersistence|enableMultiTabIndexedDbPersistence|initializeFirestore|localCache/)
    const main = read('src/main.jsx') + read('index.html') + read('vite.config.js')
    expect(main).not.toMatch(/serviceWorker|workbox|vite-plugin-pwa|manifest\.webmanifest/i)
    for (const f of ['public/sw.js', 'public/service-worker.js', 'public/manifest.webmanifest']) {
      expect(existsSync(fileURLToPath(new URL(`../../${f}`, import.meta.url))), f).toBe(false)
    }
  })

  it('the membership gate still wraps the app shell, after ProtectedRoute', () => {
    const app = read('src/App.jsx')
    const guard = app.indexOf('<Route element={<ProtectedRoute />}>')
    const gateAt = app.indexOf('<Route element={<MembershipGate />}>')
    const shell = app.indexOf('<Route element={<AppShell />}>')
    expect(guard).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(guard)
    expect(shell).toBeGreaterThan(gateAt)
  })

  it('every consumer of `profileLoading` still sees it true while membership is unresolved', () => {
    // The provider derives it; consumers were not edited. This pins the
    // derivation: unsettled OR waiting — never false before the server answers.
    expect(provider.replace(/\s+/g, '')).toContain('constprofileLoading=(targetKey!==null&&!settled)||profileWaiting')
    expect(provider.replace(/\s+/g, '')).toContain('constprofile=confirmed?settledProfile:null')
  })
})
