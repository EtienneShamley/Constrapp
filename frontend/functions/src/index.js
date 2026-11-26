import { onCall } from 'firebase-functions/https'
import { onSchedule } from 'firebase-functions/scheduler'
import * as logger from 'firebase-functions/logger'
import { getDb, getAdminAuth, getBucket } from './lib/firebaseAdmin.js'
import { EMAIL_API_KEY, REGION, FILE_LINK_WORKER_SERVICE_ACCOUNT, FINAL_ACCOUNT_APPROVAL_ENABLED, BOQ_BUDGET_TRANSFER_ENABLED, CLIENT_FINANCE_POSTING_ENABLED, CLIENT_RECEIPT_POSTING_ENABLED, CLIENT_RECEIPT_ALL_COMPANIES, readConfig, readFileLinkConfig } from './lib/params.js'
import { runScheduledWorker } from './lib/fileLinkRevocation.js'
import { selectEmailAdapter } from './lib/email.js'
import { createTeamHandlers, HANDLER_NAMES } from './team/handlers.js'
import { createFinalAccountHandlers } from './finalAccount/handlers.js'
import { createBoqBudgetHandlers } from './boqBudget/handlers.js'
import { createClientFinanceHandlers } from './clientFinance/handlers.js'

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

// ── Final Account approval (ADR-77) — ONE financial callable ─────────────────
//
// The narrowly scoped exception to "no financial logic in Functions": the
// approval of a Final Account revision recomputes every figure from records it
// reads itself (finalAccount/approve.js). Same region and App Check
// enforcement as the team callables; NO secret is bound (it sends no email);
// more memory and time, because it reads a whole project's registers in one
// transaction. Authorisation is in the handler: an active company_admin or
// project_manager of the project's company.
export const FINAL_ACCOUNT_CALL_OPTIONS = {
  region: REGION,
  enforceAppCheck: true,
  maxInstances: 5,
  memory: '512MiB',
  timeoutSeconds: 120,
}

let finalAccountHandlers = null

export const approveFinalAccount = onCall(FINAL_ACCOUNT_CALL_OPTIONS, async (request) => {
  finalAccountHandlers ??= createFinalAccountHandlers({
    db: getDb(),
    now: () => new Date(),
    log: logger,
    config: () => ({ enabled: FINAL_ACCOUNT_APPROVAL_ENABLED.value() }),
  })
  try {
    return await finalAccountHandlers.approveFinalAccount(request)
  } catch (err) {
    if (err?.details?.code) {
      logger.info('final account call refused', { code: err.details.code, uid: request.auth?.uid ?? null })
    } else {
      logger.error('final account call failed', { uid: request.auth?.uid ?? null, message: err?.message, stack: err?.stack })
    }
    throw err
  }
})

// ── BOQ → working budget transfer (ADR-81) — the SECOND financial callable ───
//
// The second narrowly scoped exception to "no financial logic in Functions":
// a priced BOQ becomes WORKING budget lines through a transaction that reads
// the complete BOQ, budget-line and cost-code registers itself
// (boqBudget/transfer.js). It never writes an approved budget version. Same
// region and App Check enforcement; NO secret is bound; the Final Account's
// memory and time, because it too reads whole registers in one transaction.
// Authorisation is in the handler: an active company_admin, project_manager
// or qs of the project's company.
export const BOQ_TRANSFER_CALL_OPTIONS = {
  region: REGION,
  enforceAppCheck: true,
  maxInstances: 5,
  memory: '512MiB',
  timeoutSeconds: 120,
}

let boqBudgetHandlers = null

export const transferBoqToBudget = onCall(BOQ_TRANSFER_CALL_OPTIONS, async (request) => {
  boqBudgetHandlers ??= createBoqBudgetHandlers({
    db: getDb(),
    now: () => new Date(),
    log: logger,
    config: () => ({ enabled: BOQ_BUDGET_TRANSFER_ENABLED.value() }),
  })
  try {
    return await boqBudgetHandlers.transferBoqToBudget(request)
  } catch (err) {
    if (err?.details?.code) {
      logger.info('boq transfer call refused', { code: err.details.code, uid: request.auth?.uid ?? null })
    } else {
      logger.error('boq transfer call failed', { uid: request.auth?.uid ?? null, message: err?.message, stack: err?.stack })
    }
    throw err
  }
})

// ── Client finance posting (ADR-89) — SIX financial callables ────────────────
//
// The trusted transaction boundary for client finance: a client credit note,
// client retention release or client receipt is posted, and a posted one
// voided, only by these six, and the per-invoice ledger is written only by
// them (clientFinance/transactions.js, clientFinance/receipts.js). Security
// Rules leave a browser drafts and nothing else. TWO switches: one for the
// four credit-note / release callables, one for the two receipt callables. Each request carries identifiers and a reason — never an
// amount — and every figure is re-derived by the generated copy of the
// browser's own modules. Same region, App Check enforcement, memory and time
// as the Final Account approval; NO secret is bound; the default runtime
// service account, as every other callable. Authorisation is in the handler:
// an active company_admin, project_manager or qs of the project's company.
export const CLIENT_FINANCE_CALL_OPTIONS = {
  region: REGION,
  enforceAppCheck: true,
  maxInstances: 5,
  memory: '512MiB',
  timeoutSeconds: 120,
}

let clientFinanceHandlers = null

const clientFinanceCall = (name) => onCall(CLIENT_FINANCE_CALL_OPTIONS, async (request) => {
  clientFinanceHandlers ??= createClientFinanceHandlers({
    db: getDb(),
    now: () => new Date(),
    log: logger,
    config: () => ({ finance: CLIENT_FINANCE_POSTING_ENABLED.value(), receipts: CLIENT_RECEIPT_POSTING_ENABLED.value(), receiptsAllCompanies: CLIENT_RECEIPT_ALL_COMPANIES.value() }),
  })
  try {
    return await clientFinanceHandlers[name](request)
  } catch (err) {
    if (err?.details?.code) {
      logger.info('client finance call refused', { fn: name, code: err.details.code, uid: request.auth?.uid ?? null })
    } else {
      logger.error('client finance call failed', { fn: name, uid: request.auth?.uid ?? null, message: err?.message, stack: err?.stack })
    }
    throw err
  }
})

export const postClientCreditNote       = clientFinanceCall('postClientCreditNote')
export const voidClientCreditNote       = clientFinanceCall('voidClientCreditNote')
export const postClientRetentionRelease = clientFinanceCall('postClientRetentionRelease')
export const voidClientRetentionRelease = clientFinanceCall('voidClientRetentionRelease')
export const postClientReceipt          = clientFinanceCall('postClientReceipt')
export const voidClientReceipt          = clientFinanceCall('voidClientReceipt')

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
//   · ONE instance AND one request at a time (`concurrency: 1`, ADR-75), no
//     Scheduler retry. `maxInstances: 1` alone does not stop two ticks running
//     side by side: a 2nd-gen function defaults to 80 concurrent requests per
//     instance. With both, an overlapping tick is refused and the next free
//     minute picks the work up from its checkpoint. The per-company lease
//     keeps even an overlap safe; this setting keeps the time budgets honest.
//   · FILE_LINK_RECONCILE_INTERVAL_HOURS (ADR-75) switches periodic
//     reconciliation on; 0, the default, leaves it off
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
  concurrency: 1,
  retryCount: 0,
}

export const processFileLinkRevocations = onSchedule(FILE_LINK_WORKER_OPTIONS, async () => {
  const cfg = readFileLinkConfig()
  if (!cfg.enabled) { logger.info('file-links: worker paused by FILE_LINK_REVOCATION_ENABLED'); return }
  try {
    await runScheduledWorker(
      { db: getDb(), bucket: getBucket(cfg.bucket), now: () => new Date(), log: logger },
      { owner: `worker:${process.env.K_REVISION ?? 'local'}:${Date.now()}`, reconcileIntervalRaw: cfg.reconcileIntervalRaw },
    )
  } catch (err) {
    logger.error('file-links: worker run failed', { message: err?.message, stack: err?.stack })
    throw err
  }
})
