import { onCall } from 'firebase-functions/https'
import * as logger from 'firebase-functions/logger'
import { getDb, getAdminAuth } from './lib/firebaseAdmin.js'
import { EMAIL_API_KEY, REGION, readConfig } from './lib/params.js'
import { selectEmailAdapter } from './lib/email.js'
import { createTeamHandlers, HANDLER_NAMES } from './team/handlers.js'

// ── Constrapp trusted backend — team management (ADR-72) ─────────────────────
//
// Eight 2nd-gen CALLABLE functions and nothing else: no HTTP router, no
// Express, no triggers, no scheduled jobs. Every function:
//   · runs in ONE region (REGION), matching the Firestore location
//   · enforces App Check (a request without a valid App Check token is
//     rejected before the handler runs — `enforceAppCheck: true`)
//   · is capped at a few instances, as a cost ceiling
//   · binds the EMAIL_API_KEY secret (Secret Manager), read at request time
//
// Authorisation lives in the handlers (lib/authz.js), never in App Check:
// App Check proves the request came from the Constrapp web app; the caller's
// membership is proven from `users/{uid}` on every call.

const CALL_OPTIONS = {
  region: REGION,
  enforceAppCheck: true,
  maxInstances: 5,
  secrets: [EMAIL_API_KEY],
  timeoutSeconds: 30,
}

let handlers = null

function resolveHandlers() {
  if (handlers) return handlers
  const db = getDb()
  const email = selectEmailAdapter({ db, apiKey: EMAIL_API_KEY.value(), from: readConfig().emailFrom })
  handlers = createTeamHandlers({
    db,
    auth: getAdminAuth(),
    email,
    now: () => new Date(),
    config: readConfig,
    log: logger,
  })
  return handlers
}

const wrap = (name) => onCall(CALL_OPTIONS, async (request) => {
  const h = resolveHandlers()
  try {
    return await h[name](request)
  } catch (err) {
    // Expected failures carry details.code (lib/errors.js). Anything else is
    // logged in full here and reaches the client as a bare `internal`.
    if (err?.details?.code) {
      logger.info('team call refused', { fn: name, code: err.details.code, uid: request.auth?.uid ?? null })
    } else {
      logger.error('team call failed', { fn: name, uid: request.auth?.uid ?? null, message: err?.message, stack: err?.stack })
    }
    throw err
  }
})

export const listTeam         = wrap('listTeam')
export const createInvitation = wrap('createInvitation')
export const resendInvitation = wrap('resendInvitation')
export const revokeInvitation = wrap('revokeInvitation')
export const previewInvitation = wrap('previewInvitation')
export const acceptInvitation = wrap('acceptInvitation')
export const changeMemberRole = wrap('changeMemberRole')
export const deactivateMember = wrap('deactivateMember')

// The exported names ARE the handler names; functions/test/handlers.test.js
// pins both lists against each other so a rename cannot silently drop one.
export const EXPORTED_CALLABLES = HANDLER_NAMES
