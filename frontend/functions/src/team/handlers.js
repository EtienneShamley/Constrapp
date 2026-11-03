import { requireAuth, requireCompanyAdmin, requireEnabled } from '../lib/authz.js'
import {
  parseEmpty, parseCreateInvitation, parseInviteId, parseInviteCredential, parseAcceptInvitation,
  parseChangeMemberRole, parseMemberUid,
} from '../lib/validation.js'
import {
  createInvitation, resendInvitation, revokeInvitation, previewInvitation, acceptInvitation,
  listPendingInvitations,
} from '../lib/invitations.js'
import { listMembers, changeMemberRole, deactivateMember } from '../lib/members.js'

// ── The eight callables, as plain async functions of `(request)` ─────────────
//
// `deps` is injected — { db, auth, email, now, config, log } — so the emulator
// test suite calls these handlers directly with a fake mailer and a fixed
// clock, while `src/index.js` wires the real ones into `onCall`.
//
// Each handler: enabled-gate → authorise → validate → operate → shape result.
// Nothing here reads Firestore before the caller is established.

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

const actorOf = ({ uid, profile }) => ({ uid, name: profile?.name ?? null })

export function createTeamHandlers(deps) {
  const gate = () => requireEnabled(deps.config())

  return {
    async listTeam(request) {
      gate()
      const caller = await requireCompanyAdmin(deps.db, request)
      parseEmpty(request.data)
      const [members, invitations] = await Promise.all([
        listMembers(deps, { companyId: caller.companyId, callerUid: caller.uid }),
        listPendingInvitations(deps.db, caller.companyId, deps.now()),
      ])
      return { companyId: caller.companyId, members, invitations }
    },

    async createInvitation(request) {
      gate()
      const caller = await requireCompanyAdmin(deps.db, request)
      const { email, role } = parseCreateInvitation(request.data)
      return createInvitation(deps, { companyId: caller.companyId, actor: actorOf(caller), email, role, requestId: requestId(request) })
    },

    async resendInvitation(request) {
      gate()
      const caller = await requireCompanyAdmin(deps.db, request)
      const { inviteId } = parseInviteId(request.data)
      return resendInvitation(deps, { companyId: caller.companyId, actor: actorOf(caller), inviteId, requestId: requestId(request) })
    },

    async revokeInvitation(request) {
      gate()
      const caller = await requireCompanyAdmin(deps.db, request)
      const { inviteId } = parseInviteId(request.data)
      return revokeInvitation(deps, { companyId: caller.companyId, actor: actorOf(caller), inviteId, requestId: requestId(request) })
    },

    // Public (App Check enforced in index.js): no sign-in required.
    async previewInvitation(request) {
      gate()
      const cred = parseInviteCredential(request.data)
      return previewInvitation(deps, cred, { requestId: requestId(request) })
    },

    async acceptInvitation(request) {
      gate()
      const { uid } = requireAuth(request)
      const { name, ...cred } = parseAcceptInvitation(request.data)
      return acceptInvitation(deps, { cred, callerUid: uid, name, requestId: requestId(request) })
    },

    async changeMemberRole(request) {
      gate()
      const caller = await requireCompanyAdmin(deps.db, request)
      const { uid, role, expectedRole } = parseChangeMemberRole(request.data)
      return changeMemberRole(deps, { companyId: caller.companyId, actor: actorOf(caller), uid, role, expectedRole, requestId: requestId(request) })
    },

    async deactivateMember(request) {
      gate()
      const caller = await requireCompanyAdmin(deps.db, request)
      const { uid } = parseMemberUid(request.data)
      return deactivateMember(deps, { companyId: caller.companyId, actor: actorOf(caller), uid, requestId: requestId(request) })
    },
  }
}

export const HANDLER_NAMES = [
  'listTeam', 'createInvitation', 'resendInvitation', 'revokeInvitation',
  'previewInvitation', 'acceptInvitation', 'changeMemberRole', 'deactivateMember',
]
