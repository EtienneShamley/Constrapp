import { CODE, fail } from '../lib/errors.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import {
  CLIENT_FINANCE_ROLES, parsePostClientCreditNote, parseVoidClientCreditNote,
  parsePostClientRetentionRelease, parseVoidClientRetentionRelease, parsePostClientReceipt, parseVoidClientReceipt,
} from './contracts.js'
import {
  postClientCreditNote, voidClientCreditNote, postClientRetentionRelease, voidClientRetentionRelease,
} from './transactions.js'
import { postClientReceipt, voidClientReceipt } from './receipts.js'
import { ensureReceiptBaseline } from './baseline.js'
import { projectRefs } from './persistence.js'
import * as calc from '../generated/clientFinanceCalc.js'

// ── The client-finance callables, as plain async functions of `(request)` ────
//
// `deps` — { db, now, log, config, hooks? } — is injected, the
// Final Account handler pattern: the emulator suite calls a handler directly;
// src/index.js wires each into `onCall`. Order: enabled-gate → authenticate →
// validate → authorise (the caller; for a credit note or release, the caller's
// company is ACTIVATED and the project is its own; for a receipt, the same
// with the receipt flag unless receipts are open to every company) → the
// project's receipt baseline → operate. Nothing reads project data before the caller is
// established, and NOTHING IS WRITTEN — not even the baseline — while the
// operation's switch is off or its company is not activated.

// TWO switches (`deps.config()` → { finance, receipts }): the four credit-note /
// retention-release operations, and the two receipt operations. Each is refused
// by ITS OWN switch only, so receipts — an existing live workflow — can run
// while credit-note and release posting is still off, and the reverse.
//
// COMPANY ACTIVATION (`companyGated`): the four credit-note / release
// operations also require `clientFinanceEnabled === true` on the caller's
// company document — written only by an operator script, never by a client.
// The global switch is the brake and is checked first.
//
// RECEIPTS have their OWN company flag, `clientReceiptsEnabled === true`,
// written by the same operator script and by no client. It is required unless
// `deps.config().receiptsAllCompanies === true` (the normal state after the
// cutover: receipts are an existing workflow of every company). While it is
// required, a company without it gets the SAME answer as with the receipt
// switch off — for that company the maintenance restriction simply continues —
// and no baseline is written for its projects. The two flags are independent:
// neither opens the other's operations.
const financeActivated = (company) => calc.clientFinanceActivated(company)
const receiptsActivated = (company) => company?.clientReceiptsEnabled === true
const FINANCE = { gate: 'finance', disabled: CODE.CLIENT_FINANCE_DISABLED, activated: financeActivated, notActivated: CODE.CLIENT_FINANCE_NOT_ACTIVATED }
const RECEIPTS = { gate: 'receipts', disabled: CODE.CLIENT_RECEIPT_DISABLED, activated: receiptsActivated, notActivated: CODE.CLIENT_RECEIPT_DISABLED, openToAll: 'receiptsAllCompanies' }

const OPERATIONS = {
  postClientCreditNote:       { ...FINANCE,  parse: parsePostClientCreditNote,       run: postClientCreditNote },
  voidClientCreditNote:       { ...FINANCE,  parse: parseVoidClientCreditNote,       run: voidClientCreditNote },
  postClientRetentionRelease: { ...FINANCE,  parse: parsePostClientRetentionRelease, run: postClientRetentionRelease },
  voidClientRetentionRelease: { ...FINANCE,  parse: parseVoidClientRetentionRelease, run: voidClientRetentionRelease },
  postClientReceipt:          { ...RECEIPTS, parse: parsePostClientReceipt,          run: postClientReceipt },
  voidClientReceipt:          { ...RECEIPTS, parse: parseVoidClientReceipt,          run: voidClientReceipt },
}

export const CLIENT_FINANCE_HANDLER_NAMES = Object.keys(OPERATIONS)

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

// Fail fast, BEFORE the baseline may be written: the project is the caller's
// company's (another tenant's id is not found) and that company is activated.
// The operation's transaction repeats both on the documents it reads itself.
async function assertCompanyActivated(db, { companyId, projectId }, { activated, notActivated }) {
  const refs = projectRefs(db, companyId, projectId)
  const [companySnap, projectSnap] = await db.getAll(refs.company, refs.project)
  if (!companySnap.exists || !projectSnap.exists) fail(CODE.NOT_FOUND)
  if (!activated(companySnap.data())) fail(notActivated)
}

export function createClientFinanceHandlers(deps) {
  const handler = ({ gate, disabled, activated, notActivated, openToAll, parse, run }) => async (request) => {
    // Fail closed: anything but an explicit `true` is off.
    if (deps.config()[gate] !== true) fail(disabled)
    const { uid } = requireAuth(request)
    const input = parse(request.data)
    // Fail fast for a caller who may not post; the transaction re-checks the
    // membership it reads itself.
    const profile = assertActiveRole(await loadProfile(deps.db, uid), CLIENT_FINANCE_ROLES, CODE.CLIENT_FINANCE_FORBIDDEN)
    const scope = { companyId: profile.companyId, projectId: input.projectId, uid }
    // Fail closed: only an explicit `true` opens an operation to every company.
    const everyCompany = openToAll !== undefined && deps.config()[openToAll] === true
    if (!everyCompany) await assertCompanyActivated(deps.db, scope, { activated, notActivated })
    // Once per project, ever: bring the receipts posted before the backend
    // took over into the invoice ledgers. Afterwards this is one document read.
    // The operation's own transaction then REQUIRES the marker it leaves.
    await ensureReceiptBaseline(deps.db, scope, { now: deps.now, log: deps.log, requestId: requestId(request) })
    return run(deps, { uid, ...input, requestId: requestId(request) })
  }
  return Object.fromEntries(Object.entries(OPERATIONS).map(([name, operation]) => [name, handler(operation)]))
}
