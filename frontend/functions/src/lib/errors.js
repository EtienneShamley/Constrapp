import { HttpsError } from 'firebase-functions/https'

// ── Callable errors ──────────────────────────────────────────────────────────
//
// Every EXPECTED failure is an HttpsError whose `details.code` is a stable,
// documented string the client maps to copy (frontend/src/lib/team.js). The
// gRPC-style `code` is chosen for the HTTP status it produces. Anything that
// is NOT thrown through here reaches the client as `internal` with no detail —
// the firebase-functions default — so an unexpected exception can never leak
// an internal message.
//
// Enumeration discipline: a caller who holds no valid invitation token
// receives `invalid-invitation` for EVERY not-found / wrong-token / revoked /
// cross-company case. Only once the token hash has matched does a precise
// reason (expired, already accepted, locked) come back.

export const CODE = {
  UNAUTHENTICATED:          'unauthenticated',
  NO_MEMBERSHIP:            'no-membership',
  MEMBERSHIP_INACTIVE:      'membership-inactive',
  NOT_ADMIN:                'not-admin',
  INVALID_ARGUMENT:         'invalid-argument',
  INVALID_ROLE:             'invalid-role',
  NOT_FOUND:                'not-found',
  UNSUPPORTED_TARGET:       'unsupported-target',
  SELF_TARGET:              'self-target',
  LAST_ADMIN:               'last-admin',
  STALE_EXPECTATION:        'stale-expectation',
  ALREADY_MEMBER:           'already-member',
  MEMBER_OF_OTHER_COMPANY:  'member-of-other-company',
  INVITE_PENDING:           'invite-pending',
  INVALID_INVITATION:       'invalid-invitation',
  INVITATION_EXPIRED:       'invitation-expired',
  INVITATION_ACCEPTED:      'invitation-accepted',
  INVITATION_LOCKED:        'invitation-locked',
  INVITATION_REVOKED:       'invitation-revoked',
  INVITATION_BUSY:          'invitation-busy',
  EMAIL_MISMATCH:           'email-mismatch',
  ACCOUNT_BLOCKED:          'account-blocked',
  RATE_LIMITED:             'rate-limited',
  EMAIL_NOT_CONFIGURED:     'email-not-configured',
  APP_URL_NOT_CONFIGURED:   'app-url-not-configured',
  DISABLED:                 'team-management-disabled',
}

const GRPC = {
  [CODE.UNAUTHENTICATED]:         'unauthenticated',
  [CODE.NO_MEMBERSHIP]:           'permission-denied',
  [CODE.MEMBERSHIP_INACTIVE]:     'permission-denied',
  [CODE.NOT_ADMIN]:               'permission-denied',
  [CODE.INVALID_ARGUMENT]:        'invalid-argument',
  [CODE.INVALID_ROLE]:            'invalid-argument',
  [CODE.NOT_FOUND]:               'not-found',
  [CODE.UNSUPPORTED_TARGET]:      'failed-precondition',
  [CODE.SELF_TARGET]:             'failed-precondition',
  [CODE.LAST_ADMIN]:              'failed-precondition',
  [CODE.STALE_EXPECTATION]:       'aborted',
  [CODE.ALREADY_MEMBER]:          'already-exists',
  [CODE.MEMBER_OF_OTHER_COMPANY]: 'failed-precondition',
  [CODE.INVITE_PENDING]:          'already-exists',
  [CODE.INVALID_INVITATION]:      'not-found',
  [CODE.INVITATION_EXPIRED]:      'failed-precondition',
  [CODE.INVITATION_ACCEPTED]:     'failed-precondition',
  [CODE.INVITATION_LOCKED]:       'failed-precondition',
  [CODE.INVITATION_REVOKED]:      'failed-precondition',
  [CODE.INVITATION_BUSY]:         'aborted',
  [CODE.EMAIL_MISMATCH]:          'permission-denied',
  [CODE.ACCOUNT_BLOCKED]:         'permission-denied',
  [CODE.RATE_LIMITED]:            'resource-exhausted',
  [CODE.EMAIL_NOT_CONFIGURED]:    'failed-precondition',
  [CODE.APP_URL_NOT_CONFIGURED]:  'failed-precondition',
  [CODE.DISABLED]:                'unavailable',
}

const MESSAGE = {
  [CODE.UNAUTHENTICATED]:         'Sign in to continue.',
  [CODE.NO_MEMBERSHIP]:           'Your account is not a member of a company.',
  [CODE.MEMBERSHIP_INACTIVE]:     'Your membership is no longer active.',
  [CODE.NOT_ADMIN]:               'Only a Company Admin can manage the team.',
  [CODE.INVALID_ARGUMENT]:        'The request was not valid.',
  [CODE.INVALID_ROLE]:            'That role cannot be assigned.',
  [CODE.NOT_FOUND]:               'Not found.',
  [CODE.UNSUPPORTED_TARGET]:      'That member is managed by the operator.',
  [CODE.SELF_TARGET]:             'You cannot change your own membership here.',
  [CODE.LAST_ADMIN]:              'A company must keep at least one active Company Admin.',
  [CODE.STALE_EXPECTATION]:       'The member changed since you loaded the page. Refresh and try again.',
  [CODE.ALREADY_MEMBER]:          'That person is already an active member of this company.',
  [CODE.MEMBER_OF_OTHER_COMPANY]: 'This account already belongs to another company.',
  [CODE.INVITE_PENDING]:          'An invitation for that email is already pending. Resend it instead.',
  [CODE.INVALID_INVITATION]:      'This invitation link is not valid.',
  [CODE.INVITATION_EXPIRED]:      'This invitation has expired. Ask your admin to resend it.',
  [CODE.INVITATION_ACCEPTED]:     'This invitation has already been used.',
  [CODE.INVITATION_LOCKED]:       'This invitation has been locked. Ask your admin to resend it.',
  [CODE.INVITATION_REVOKED]:      'This invitation was revoked.',
  [CODE.INVITATION_BUSY]:         'This invitation is being processed. Try again in a moment.',
  [CODE.EMAIL_MISMATCH]:          'Sign in with the email address this invitation was sent to.',
  [CODE.ACCOUNT_BLOCKED]:         'This account cannot accept invitations. Contact your administrator.',
  [CODE.RATE_LIMITED]:            'Too many attempts. Try again later.',
  [CODE.EMAIL_NOT_CONFIGURED]:    'Email delivery is not configured.',
  [CODE.APP_URL_NOT_CONFIGURED]:  'The application URL is not configured.',
  [CODE.DISABLED]:                'Team management is temporarily unavailable.',
}

export class TeamError extends HttpsError {
  constructor(code, extra = {}) {
    if (!GRPC[code]) throw new Error(`Unknown team error code: ${code}`)
    super(GRPC[code], MESSAGE[code], { code, ...extra })
    this.teamCode = code
  }
}

export const fail = (code, extra) => { throw new TeamError(code, extra) }

export const isTeamError = (err, code) =>
  err instanceof HttpsError && err.details?.code === code
