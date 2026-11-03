import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Team management surface guards (ADR-72) ─────────────────────────────────
//
// Source-structure pins (the ADR-26 convention — no jsdom): the routes, the
// membership gate, the hooks-only Firebase discipline on the new pages, the
// App Check wiring, and the Rules file being byte-for-byte untouched by this
// feature (the backend added NO rules; the new paths are denied by default).

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const src = (rel) => read(`src/${rel}`)

const APP      = src('App.jsx')
const FIREBASE = src('lib/firebase.js')
const GATE     = src('components/MembershipGate.jsx')
const ACCEPT   = src('pages/AcceptInvite.jsx')
const TEAM     = src('pages/settings/TeamSettings.jsx')
const DIALOG   = src('pages/settings/TeamDialog.jsx')
const USE_TEAM = src('hooks/useTeam.jsx')
const USE_AUTH = src('hooks/useAuth.jsx')
const LAYOUT   = src('layouts/AuthLayout.jsx')
const CREATE   = src('pages/CreateAccount.jsx')
const FN_INDEX = read('functions/src/index.js')

describe('routing', () => {
  it('/accept-invite renders inside InviteLayout (no signed-in redirect), outside AuthLayout', () => {
    expect(APP).toContain('<Route element={<InviteLayout />}>')
    expect(APP).toContain('path="accept-invite" element={<AcceptInvite />}')
    const authBlock = APP.slice(APP.indexOf('<Route element={<AuthLayout />}>'), APP.indexOf('</Route>', APP.indexOf('<Route element={<AuthLayout />}>')))
    expect(authBlock).not.toContain('accept-invite')
    expect(LAYOUT).toContain('export function InviteLayout()')
    expect(LAYOUT).toContain('if (user) return <Navigate to="/" replace />')
  })

  it('the membership gate wraps the app shell, after ProtectedRoute', () => {
    const guard = APP.indexOf('<Route element={<ProtectedRoute />}>')
    const gate = APP.indexOf('<Route element={<MembershipGate />}>')
    const shell = APP.indexOf('<Route element={<AppShell />}>')
    expect(guard).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(guard)
    expect(shell).toBeGreaterThan(gate)
  })

  it('/settings/team is routed and the public registration stub stays a stub', () => {
    expect(APP).toContain('path="settings/team" element={<TeamSettings />}')
    expect(CREATE).not.toMatch(/<form|<input|createUser/)
    expect(CREATE).toContain('/accept-invite')
  })
})

describe('membership gate', () => {
  it('renders the shell only for an active membership and signs out on loss', () => {
    expect(GATE).toContain('membershipGate({ profile, profileLoading, profileError })')
    expect(GATE).toContain('if (gate === GATE.ACTIVE) return <Outlet />')
    expect(GATE).toMatch(/wasActive\.current && \(gate === GATE\.NONE \|\| gate === GATE\.DEACTIVATED\)[\s\S]*signOut\(\)/)
    expect(GATE).not.toMatch(/from\s*'firebase\//)
  })
})

describe('hooks-only Firebase access on the new surfaces', () => {
  it('no new page or component imports firebase/*', () => {
    for (const s of [ACCEPT, TEAM, DIALOG, GATE]) expect(s).not.toMatch(/from\s*'firebase\//)
  })
  it('callables go through useTeam only; Auth through useAuth', () => {
    expect(USE_TEAM).toMatch(/import\s*\{\s*httpsCallable\s*\}\s*from\s*'firebase\/functions'/)
    expect(USE_TEAM).not.toContain('onSnapshot(')
    expect(USE_AUTH).toContain('createUserWithEmailAndPassword(auth, email, password)')
    expect(USE_AUTH).toContain('signInWithEmailAndPassword(auth, email, password)')
    expect(USE_AUTH).toContain('sendPasswordResetEmail(auth, email)')
    expect(ACCEPT).toContain('const { user, signIn, register, sendPasswordReset, signOut } = useAuth()')
    // The accept page never sends a password to the backend.
    expect(ACCEPT).not.toMatch(/acceptInvitation\(\{[^}]*password/)
  })
  it('the invitation credential leaves the address bar and lives in sessionStorage', () => {
    expect(ACCEPT).toContain("window.history.replaceState(null, '', window.location.pathname)")
    expect(ACCEPT).toContain('storePendingInvite(window.sessionStorage, fromHash)')
    expect(ACCEPT).toContain('clearPendingInvite(window.sessionStorage)')
    expect(ACCEPT).not.toMatch(/console\.log\(|gtag\(|analytics\(/)
  })
})

describe('App Check and the trusted backend', () => {
  it('the client initialises App Check from a public site key and addresses one region', () => {
    expect(FIREBASE).toMatch(/initializeAppCheck\(app,\s*\{\s*provider:\s*new ReCaptchaEnterpriseProvider\(appCheckSiteKey\)/)
    expect(FIREBASE).toContain("export const FUNCTIONS_REGION = 'australia-southeast1'")
    expect(FIREBASE).toContain('getFunctions(app, FUNCTIONS_REGION)')
    expect(FIREBASE).toMatch(/import\.meta\.env\.DEV && import\.meta\.env\.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN/)
  })
  it('every callable enforces App Check in the same region, and no secret is VITE_-prefixed', () => {
    expect(FN_INDEX).toMatch(/enforceAppCheck:\s*true/)
    expect(read('functions/src/lib/params.js')).toContain("export const REGION = 'australia-southeast1'")
    expect(FIREBASE).not.toMatch(/VITE_[A-Z_]*(SECRET|API_KEY_RESEND|RESEND|EMAIL_API)/)
    expect(existsSync(fileURLToPath(new URL('../../functions/.secret.local', import.meta.url)))).toBe(false)
  })
})

describe('dialogs', () => {
  it('the team dialog follows the accessible modal contract', () => {
    expect(DIALOG).toContain('role="dialog" aria-modal="true" aria-labelledby={titleId}')
    expect(DIALOG).toContain("if (e.key === 'Escape')")
    expect(DIALOG).toContain('tabTarget({')
    expect(TEAM).toMatch(/<TeamDialog title="Invite a team member"/)
    expect(TEAM).toMatch(/<TeamDialog title="Deactivate member"/)
    expect(TEAM).toMatch(/<TeamDialog title="Revoke invitation"/)
    expect(TEAM).toMatch(/<TeamDialog title="Change role"/)
    expect(TEAM).toContain('overflow-x-auto')
    expect(TEAM).not.toMatch(/style=\{\{/)
  })
})
