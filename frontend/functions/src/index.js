import { onCall } from 'firebase-functions/https'
import { onSchedule } from 'firebase-functions/scheduler'
import * as logger from 'firebase-functions/logger'
import { getDb, getAdminAuth, getBucket } from './lib/firebaseAdmin.js'
import { EMAIL_API_KEY, REGION, FILE_LINK_WORKER_SERVICE_ACCOUNT, readConfig, readFileLinkConfig } from './lib/params.js'
import { runRevocationWorker } from './lib/fileLinkRevocation.js'
import { selectEmailAdapter } from './lib/email.js'
import { createTeamHandlers, HANDLER_NAMES } from './team/handlers.js'

// ── Constrapp trusted backend — team management (ADR-72) ─────────────────────
//
// Eight 2nd-gen CALLABLE functions, plus ONE scheduled worker (ADR-74, at the
// foot of this file) that finishes what deactivation starts. No HTTP router,
// no Express, no event triggers, no financial logic. Every callable:
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

// ── Scheduled worker: legacy file-link revocation (ADR-74, DC46-B) ───────────
//
// Membership is revoked by the callables above, at once. This worker does the
// slower follow-up: it removes Firebase download tokens from the objects of
// every company with an outstanding request, so links copied earlier stop
// working. Resumable, leased per company, and it never reports a sweep
// complete while any object failed (lib/fileLinkRevocation.js).
//
//   · no caller: Cloud Scheduler invokes it, so there is no App Check and no
//     request data — it acts only on requests the membership transactions wrote
//   · ONE instance, no Scheduler retry: an overlapping run is skipped and the
//     next minute picks the work up from its checkpoint
//   · binds no secret
//   · runs as its OWN service account (FILE_LINK_WORKER_SERVICE_ACCOUNT), never
//     the shared default compute account; Cloud Scheduler calls it with an
//     OIDC token for that account, which may invoke this service only
//   · FILE_LINK_REVOCATION_ENABLED=false pauses it without losing requests
export const FILE_LINK_WORKER_OPTIONS = {
  schedule: 'every 1 minutes',
  region: REGION,
  serviceAccount: FILE_LINK_WORKER_SERVICE_ACCOUNT,
  timeoutSeconds: 300,
  maxInstances: 1,
  retryCount: 0,
}

export const processFileLinkRevocations = onSchedule(FILE_LINK_WORKER_OPTIONS, async () => {
  const cfg = readFileLinkConfig()
  if (!cfg.enabled) { logger.info('file-links: worker paused by FILE_LINK_REVOCATION_ENABLED'); return }
  try {
    await runRevocationWorker(
      { db: getDb(), bucket: getBucket(cfg.bucket), now: () => new Date(), log: logger },
      { owner: `worker:${process.env.K_REVISION ?? 'local'}:${Date.now()}` },
    )
  } catch (err) {
    logger.error('file-links: worker run failed', { message: err?.message, stack: err?.stack })
    throw err
  }
})
