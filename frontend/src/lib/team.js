// ── Team management — PURE helpers (ADR-72) ──────────────────────────────────
//
// No Firebase here. The callables (hooks/useTeam.jsx) are the only write path;
// this file owns the vocabulary, the invitation-link fragment, the pending-
// invite hand-off across sign-in, the membership gate decision and the
// error → copy mapping. Everything is unit-tested in tests/unit/team.test.js.

import { isKnownRole } from './formatters'

// The three roles a Company Admin may invite or assign. super_admin /
// subcontractor / client remain operator-provisioned (PRODUCT.md roles table;
// external roles stay off until project-level scoping, SECURITY.md DC20).
export const TEAM_ROLES = [
  { value: 'company_admin',   label: 'Company Admin',   hint: 'Full access, including team management and company settings.' },
  { value: 'project_manager', label: 'Project Manager', hint: 'Projects, budgets, procurement, claims and approvals.' },
  { value: 'qs',              label: 'QS / Office',     hint: 'Estimating, budgets, forecasting and assessment. Cannot edit projects.' },
]
export const TEAM_ROLE_VALUES = TEAM_ROLES.map(r => r.value)
export const isTeamRole = (role) => TEAM_ROLE_VALUES.includes(role)
export const canManageTeam = (role) => role === 'company_admin'

export const MEMBER_STATUS = { ACTIVE: 'active', DEACTIVATED: 'deactivated' }
export const INVITE_STATUS = { PENDING: 'pending', EXPIRED: 'expired', LOCKED: 'locked', ACCEPTED: 'accepted', REVOKED: 'revoked' }

// ── Invitation link ──────────────────────────────────────────────────────────
//
// `/accept-invite#c=<companyId>&i=<inviteId>&t=<token>`. The credential lives
// in the FRAGMENT: never sent to the server, never in access logs or Referer.
// The page moves it into sessionStorage and strips it from the address bar.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function parseInviteFragment(hash) {
  if (typeof hash !== 'string') return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const p = new URLSearchParams(raw)
  const cred = { companyId: p.get('c') ?? '', inviteId: p.get('i') ?? '', token: p.get('t') ?? '' }
  return isInviteCredential(cred) ? cred : null
}

export const isInviteCredential = (c) =>
  !!c && ID_RE.test(c.companyId ?? '') && ID_RE.test(c.inviteId ?? '') && TOKEN_RE.test(c.token ?? '')

export const PENDING_INVITE_KEY = 'constrapp.pendingInvite'

// sessionStorage is per-tab and cleared when the tab closes — the right
// lifetime for a credential that must survive the sign-in round trip only.
// Every access is guarded: private windows and blocked storage must degrade
// to "no pending invite", never to a crash.
export function readPendingInvite(storage) {
  try {
    const raw = storage?.getItem(PENDING_INVITE_KEY)
    if (!raw) return null
    const cred = JSON.parse(raw)
    return isInviteCredential(cred) ? cred : null
  } catch {
    return null
  }
}

export function storePendingInvite(storage, cred) {
  if (!isInviteCredential(cred)) return false
  try { storage.setItem(PENDING_INVITE_KEY, JSON.stringify(cred)); return true } catch { return false }
}

export function clearPendingInvite(storage) {
  try { storage?.removeItem(PENDING_INVITE_KEY) } catch { /* ignore */ }
}

// ── Accept flow ──────────────────────────────────────────────────────────────
//
// What the /accept-invite page shows, from the preview's accountState and the
// current sign-in. `signedInEmail` is the Firebase Auth user's email (lower-
// cased) or null.
export const ACCEPT_STEP = {
  ACCEPT:         'accept',          // signed in as the invited email → one button
  SWITCH_ACCOUNT: 'switch-account',  // signed in as someone else → sign out first
  REGISTER:       'register',        // no account yet → create one, then accept
  SIGN_IN:        'sign-in',         // account exists → sign in, then accept
  REACTIVATED:    'reactivated',     // account re-enabled → sign in (or reset), then accept
  ALREADY_MEMBER: 'already-member',  // nothing to accept → sign in to the app
  OTHER_COMPANY:  'other-company',   // cannot accept
  BLOCKED:        'blocked',         // cannot accept
}

export function acceptStepFor(preview, signedInEmail) {
  if (!preview) return null
  const invited = (preview.email ?? '').toLowerCase()
  if (preview.accountState === 'other-company') return ACCEPT_STEP.OTHER_COMPANY
  if (preview.accountState === 'blocked') return ACCEPT_STEP.BLOCKED
  if (signedInEmail) return signedInEmail === invited ? (preview.accountState === 'already-member' ? ACCEPT_STEP.ALREADY_MEMBER : ACCEPT_STEP.ACCEPT) : ACCEPT_STEP.SWITCH_ACCOUNT
  switch (preview.accountState) {
    case 'new':            return ACCEPT_STEP.REGISTER
    case 'existing':       return ACCEPT_STEP.SIGN_IN
    case 'reactivated':    return ACCEPT_STEP.REACTIVATED
    case 'already-member': return ACCEPT_STEP.ALREADY_MEMBER
    default:               return ACCEPT_STEP.SIGN_IN
  }
}

// Client-side mirror of the backend's password rule for UX only — Firebase
// Auth and the project's password policy are the enforced boundary.
export const PASSWORD_MIN = 12
export const passwordProblem = (pw, confirm) => {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`
  if (pw.length > 128) return 'Use at most 128 characters.'
  if (confirm !== undefined && pw !== confirm) return 'The passwords do not match.'
  return null
}

// ── Membership resolution (tracker D3 #32) ───────────────────────────────────
//
// What the `users/{uid}` listener has established, folded one report at a
// time. ONE rule carries the whole correction:
//
//   ONLY A SERVER-CONFIRMED SNAPSHOT DECIDES MEMBERSHIP.
//
// A snapshot answered from the local cache (`fromCache`), or one that carries
// an unconfirmed local write (`hasPendingWrites`), decides NOTHING — in either
// direction:
//   · a cache-only MISSING document is not "no membership". With the backend
//     unreachable the SDK answers at once from its empty cache with a document
//     that "does not exist" (measured, TESTING.md §75) — the false *No active
//     membership* of D3 #32;
//   · a cache-only ACTIVE profile admits nobody. The cache can outlive a
//     sign-out in the same tab, so it may describe a membership the server has
//     since removed;
//   · once the server has confirmed a profile, a later cache-only snapshot
//     (the connection dropped) leaves that confirmed profile exactly as it is.
//     An established session keeps working through a disconnection, as it did
//     before — and the next server-confirmed snapshot replaces it, so a
//     deactivation or role change made meanwhile takes effect on reconnection.
//
// The snapshot is tagged with the `key` of the listener it came from (the uid
// and the attempt). A report under a new key starts from nothing, so no
// confirmation is ever carried from one identity to another.
//
// A listener error is terminal for that listener (the SDK retries connectivity
// by itself and never reports it as an error): the profile is dropped, and
// `readCode` says why. ⚠️ UX only — Firestore rules decide every read.
export const EMPTY_PROFILE_SNAPSHOT = { profile: null, confirmed: false, error: false, readCode: null, attempt: 0 }

const sameProfile = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function foldProfileReport(snap, key, report) {
  const base = snap.key === key
    ? snap
    : { ...EMPTY_PROFILE_SNAPSHOT, key, attempt: snap.attempt ?? 0 }
  if (report.code) {
    return { key, profile: null, confirmed: false, error: true, readCode: report.code, attempt: base.attempt }
  }
  // Not confirmed by the server: it only records that the listener has
  // reported. Anything already confirmed for THIS key stands.
  if (report.fromCache !== false || report.hasPendingWrites !== false) return base
  // The server repeating what it already said (a reconnection) changes nothing
  // — the same object is kept, so nothing downstream re-renders.
  if (base.confirmed && !base.error && sameProfile(base.profile, report.profile)) return base
  return { key, profile: report.profile ?? null, confirmed: true, error: false, readCode: null, attempt: base.attempt }
}

// ── Membership gate ──────────────────────────────────────────────────────────
//
// Decides whether a SIGNED-IN user may enter the protected shell. The profile
// is `users/{uid}` (client-read-only); a missing document, a null companyId
// or a deactivated status all mean "no membership". Legacy profiles carry no
// `status`, and are active — exactly as the rules treat them.
//
// `profile` here is always SERVER-CONFIRMED (ProfileProvider hands out nothing
// else), so NONE and DEACTIVATED are statements the server made. While the
// server has not answered the gate is LOADING, or WAITING once the SDK has
// reported that it is answering from its cache; a failed read is REFUSED
// (permission denied) or ERROR (anything else). None of those four admits.
//
// THE MEMBERSHIP CONTRACT (architect, 25 November 2026). A server-confirmed
// profile enters the shell only if ALL of these hold:
//   · `status` is not 'deactivated' (absent = active, as the backend's
//     isDeactivated and the rules treat it);
//   · `companyId` is a string meeting the id contract (ID_RE: 1–64 of
//     A–Z a–z 0–9 _ -), so it can only ever name ONE company document;
//   · `role` is one of the six documented roles (lib/formatters.js →
//     isKnownRole: super_admin, company_admin, project_manager, qs,
//     subcontractor, client).
// A profile that names a company but breaks the contract — a `companyId` that
// is not a string or does not meet the id contract, or a missing, null, empty, non-string or unknown `role` —
// is INVALID: a configuration fault somebody must correct, not "no
// membership" and not a connection problem. It does not admit, and it does
// not sign the user out (the listener stays open, so a corrected profile
// admits by itself). A deactivated profile carries `role: null` by design
// and is DEACTIVATED, never INVALID — the status is read first.
// ⚠️ UX only. Every backend path writes `companyId` and a valid `role`
// together (acceptInvitation, updateMemberRole), and the rules refuse an
// unknown role everything role-gated; this stops the shell opening on it.
export const GATE = {
  LOADING: 'loading', WAITING: 'waiting', ACTIVE: 'active', NONE: 'none', DEACTIVATED: 'deactivated',
  INVALID: 'invalid', REFUSED: 'refused', ERROR: 'error',
}

// The company a profile names, or null. Only a value that meets the id contract
// (ID_RE above — the same one the backend's `isValidId` applies to every
// company id it accepts) is a company at all, so nothing (CompanyProvider, and
// through it every data hook) ever builds a document path from a malformed
// `companyId`. Measured against the SDK: `doc(db, 'companies', 42)` and
// `'a/b'` THROW; `'c1/'` silently resolves to `companies/c1`; `'a/b/c'`
// resolves to a nested document. None of those reaches `doc()` now.
export const profileCompanyId = (profile) =>
  (typeof profile?.companyId === 'string' && ID_RE.test(profile.companyId) ? profile.companyId : null)

export function membershipGate({ profile, profileLoading, profileError, profileErrorCode, profileWaiting }) {
  if (profileWaiting) return GATE.WAITING
  if (profileLoading) return GATE.LOADING
  if (profileError) return profileErrorCode === 'permission-denied' ? GATE.REFUSED : GATE.ERROR
  if (!profile) return GATE.NONE
  if (profile.status === MEMBER_STATUS.DEACTIVATED) return GATE.DEACTIVATED
  const { companyId } = profile
  if (companyId === null || companyId === undefined || companyId === '') return GATE.NONE
  if (profileCompanyId(profile) === null) return GATE.INVALID
  if (!isKnownRole(profile.role)) return GATE.INVALID
  return GATE.ACTIVE
}

// ── Presentation ─────────────────────────────────────────────────────────────

export const inviteStatusBadge = (status) => ({
  [INVITE_STATUS.PENDING]:  { label: 'Pending',  variant: 'pending' },
  [INVITE_STATUS.EXPIRED]:  { label: 'Expired',  variant: 'danger' },
  [INVITE_STATUS.LOCKED]:   { label: 'Locked',   variant: 'danger' },
  [INVITE_STATUS.ACCEPTED]: { label: 'Accepted', variant: 'active' },
  [INVITE_STATUS.REVOKED]:  { label: 'Revoked',  variant: 'soon' },
}[status] ?? { label: status ?? '—', variant: 'soon' })

export const deliveryBadge = (delivery) => ({
  sent:     { label: 'Sent',           variant: 'info' },
  failed:   { label: 'Not delivered',  variant: 'danger' },
  operator: { label: 'Operator link',  variant: 'soon' },
  pending:  { label: 'Sending',        variant: 'pending' },
}[delivery] ?? { label: delivery ?? '—', variant: 'soon' })

export const memberStatusBadge = (member) =>
  member?.status === MEMBER_STATUS.DEACTIVATED
    ? { label: member.authSyncPending ? 'Deactivated · sync pending' : 'Deactivated', variant: 'soon' }
    : { label: 'Active', variant: 'active' }

// ── Old file links (ADR-74, DC46-B) ──────────────────────────────────────────
//
// Removing a member is immediate; revoking file links they may have copied
// earlier is a BACKGROUND clean-up reported by the backend (listTeam →
// member.fileLinks). The wording never says "immediately", and "revoked"
// appears only when the backend says a full clean-up finished after the
// member's access changed. `null` means there is nothing to show.
export const FILE_LINK_STATUS = { PENDING: 'pending', REVOKED: 'revoked', DELAYED: 'delayed', NOT_REQUESTED: 'not_requested' }

export const fileLinkNote = (member) => {
  const f = member?.fileLinks
  if (!f) return null
  switch (f.status) {
    case FILE_LINK_STATUS.REVOKED:
      return { text: 'Old file links: revoked', tone: 'muted' }
    case FILE_LINK_STATUS.PENDING:
      return { text: 'Old file links: revocation pending', tone: 'pending' }
    case FILE_LINK_STATUS.DELAYED:
      return {
        text: Number.isInteger(f.outstanding) && f.outstanding > 0
          ? `Revocation delayed: retrying (${f.outstanding} ${f.outstanding === 1 ? 'file' : 'files'} outstanding)`
          : 'Revocation delayed: retrying',
        tone: 'warning',
      }
    case FILE_LINK_STATUS.NOT_REQUESTED:
      return { text: 'Old file links: not yet revoked', tone: 'warning' }
    default:
      return null
  }
}

export const canEditMember = (member) =>
  !!member && member.status === MEMBER_STATUS.ACTIVE && member.managed === 'team' && !member.isSelf && isTeamRole(member.role)

// ADR-75 Stage 3. Deactivation reaches further than editing: a Company Admin
// may REMOVE a subcontractor or client, but never change their role (so this
// is a separate predicate, not a wider `canEditMember`). super_admin and any
// unknown role stay operator-only. UX only — the `deactivateMember` callable
// decides, and refuses with `unsupported-target`.
export const EXTERNAL_ROLE_VALUES = ['subcontractor', 'client']
export const isExternalRole = (role) => EXTERNAL_ROLE_VALUES.includes(role)
export const canDeactivateMember = (member) =>
  canEditMember(member)
  || (!!member && member.status === MEMBER_STATUS.ACTIVE && !member.isSelf && isExternalRole(member.role))

// ── Errors ───────────────────────────────────────────────────────────────────
//
// A callable rejection carries `details.code` (functions/src/lib/errors.js).
// Only the codes a user can act on get specific copy; the rest are generic.
const TEAM_MESSAGES = {
  'unauthenticated':          'Sign in to continue.',
  'no-membership':            'Your account is not a member of a company.',
  'membership-inactive':      'Your membership is no longer active.',
  'not-admin':                'Only a Company Admin can manage the team.',
  'invalid-argument':         'Check the details and try again.',
  'invalid-role':             'Choose one of the available roles.',
  'not-found':                'That member or invitation could not be found. Refresh and try again.',
  'unsupported-target':       'That member is managed by the operator and cannot be changed here.',
  'self-target':              'You cannot change your own membership. Ask another Company Admin.',
  'last-admin':               'A company must keep at least one active Company Admin.',
  'stale-expectation':        'This member changed since the page loaded. Refresh and try again.',
  'already-member':           'That person is already an active member of this company.',
  'member-of-other-company':  'This account already belongs to another company, so it cannot accept this invitation.',
  'invite-pending':           'An invitation for that email is already pending — resend it instead.',
  'invalid-invitation':       'This invitation link is not valid. Ask your admin for a new one.',
  'invitation-expired':       'This invitation has expired. Ask your admin to resend it.',
  'invitation-accepted':      'This invitation has already been used.',
  'invitation-locked':        'This invitation has been locked. Ask your admin to resend it.',
  'invitation-revoked':       'This invitation was revoked.',
  'invitation-busy':          'This invitation is being processed. Try again in a moment.',
  'email-mismatch':           'Sign in with the email address this invitation was sent to.',
  'account-blocked':          'This account cannot accept invitations. Contact your administrator.',
  'rate-limited':             'Too many attempts. Try again later.',
  'email-not-configured':     'Email delivery is not configured. The invitation was saved but not sent.',
  'app-url-not-configured':   'The application URL is not configured. Contact the operator.',
  'team-management-disabled': 'Team management is temporarily unavailable.',
}

export function teamErrorCode(err) {
  return err?.details?.code ?? err?.customData?.code ?? null
}

export function teamErrorMessage(err, fallback = 'Something went wrong. Please try again.') {
  const code = teamErrorCode(err)
  if (code && TEAM_MESSAGES[code]) return TEAM_MESSAGES[code]
  switch (err?.code) {
    case 'functions/unauthenticated': return TEAM_MESSAGES.unauthenticated
    case 'functions/unavailable':     return 'The service is unavailable right now. Try again shortly.'
    case 'functions/deadline-exceeded': return 'The request timed out. Try again.'
    default: return fallback
  }
}

// Firebase Auth error codes the accept page can act on. Anything that would
// reveal whether an account exists collapses into one message (the Login and
// ForgotPassword discipline).
export function authErrorMessage(code) {
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password.'
    case 'auth/email-already-in-use':
      return 'An account already exists for this email. Sign in instead.'
    case 'auth/weak-password':
      return `Use a stronger password (at least ${PASSWORD_MIN} characters).`
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.'
    case 'auth/user-disabled':
      return 'This account has been disabled.'
    default:
      return 'That did not work. Please try again.'
  }
}
