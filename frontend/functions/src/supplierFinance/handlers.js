import { CODE, fail } from '../lib/errors.js'
import { assertCommercialActivated } from '../lib/commercialActivation.js'
import { requireAuth, loadProfile, assertActiveRole } from '../lib/authz.js'
import { SUPPLIER_FINANCE_ROLES } from './context.js'
import { parseClaimOperation, parseInvoiceOperation, parseSettlementOperation } from './contracts.js'
import { ensureSupplierBaseline } from './baseline.js'
import { createProgressClaim, updateProgressClaimDraft, approveProgressClaim, rejectProgressClaim } from './claims.js'
import { createSupplierInvoice, updateSupplierInvoiceDraft, transitionSupplierInvoice, linkExistingInvoice } from './invoices.js'
import { saveSettlementDraft, settleDocument } from './settlement.js'
import { segregationGuard } from '../lib/approvalPolicy.js'

// ── The three supplier-finance callables, as plain async functions ───────────
//
// ADR-93 / ADR-94. `deps` — { db, now, log, config, clock?, segregation? } —
// is injected (the Final Account / variation handler pattern): the emulator
// suite calls a handler directly; src/index.js wires each into `onCall`.
// Order: enabled-gate → authenticate → validate → authorise → baseline →
// operate. Nothing reads project data before the caller is established, and
// nothing is written while the switch is off. The baseline is established
// lazily, once per project, by the first operation (baseline.js); every
// operation re-reads its marker inside its own transaction.

const CLAIM = {
  create: createProgressClaim,
  update: updateProgressClaimDraft,
  approve: (deps, args) => approveProgressClaim(deps, { ...args, segregation: segregationGuard(deps.db, args.uid, { label: 'progress claim' }) }),
  reject: rejectProgressClaim,
}

const INVOICE = {
  create: createSupplierInvoice,
  update: updateSupplierInvoiceDraft,
  // Approval is the segregated step (the authoring freeze). Posting cannot
  // change the approved invoice, so after an INDEPENDENT approval it needs no
  // second checker; after an approval that was not independent, the poster
  // must be (invoices.js).
  approve: (deps, args) => transitionSupplierInvoice(deps, { ...args, transition: 'approve', segregation: segregationGuard(deps.db, args.uid, { label: 'supplier invoice' }) }),
  post: (deps, args) => transitionSupplierInvoice(deps, { ...args, transition: 'post', segregation: segregationGuard(deps.db, args.uid, { label: 'supplier invoice posting (the invoice was approved by one of its own preparers)' }) }),
  cancel: (deps, args) => transitionSupplierInvoice(deps, { ...args, transition: 'cancel' }),
  link: linkExistingInvoice,
}

const SETTLEMENT_LABEL = { credit: 'supplier credit note', release: 'retention release' }
// ADR-96 approval matrix: posting a credit note or a retention release CHANGES
// what is owed — it is segregated; and so is its VOID, which undoes a fact an
// independent approver posted (the voider may not be the document's creator or
// last material editor; its poster may). Posting a payment RECORDS money that
// has already left the account and can never exceed what the ledger shows is
// payable; voiding one corrects that record — actor recorded, not segregated.
const settle = (kind, action) => (deps, args) => settleDocument(deps, {
  ...args, kind, action,
  segregation: SETTLEMENT_LABEL[kind] ? segregationGuard(deps.db, args.uid, { label: action === 'post' ? SETTLEMENT_LABEL[kind] : `void of a posted ${SETTLEMENT_LABEL[kind]}` }) : null,
})
const SETTLEMENT = {
  saveCredit: (deps, args) => saveSettlementDraft(deps, { ...args, kind: 'credit' }),
  postCredit: settle('credit', 'post'),
  voidCredit: settle('credit', 'void'),
  saveRelease: (deps, args) => saveSettlementDraft(deps, { ...args, kind: 'release' }),
  postRelease: settle('release', 'post'),
  voidRelease: settle('release', 'void'),
  savePayment: (deps, args) => saveSettlementDraft(deps, { ...args, kind: 'payment' }),
  postPayment: settle('payment', 'post'),
  voidPayment: settle('payment', 'void'),
}

export const SUPPLIER_FINANCE_HANDLER_NAMES = ['progressClaimOperation', 'supplierInvoiceOperation', 'supplierSettlementOperation']

const requestId = (request) =>
  request?.rawRequest?.headers?.['x-cloud-trace-context']?.split('/')[0]
  ?? request?.rawRequest?.headers?.['function-execution-id']
  ?? null

export function createSupplierFinanceHandlers(deps) {
  const handler = (parse, table) => async (request) => {
    if (deps.config().enabled !== true) fail(CODE.SUPPLIER_FINANCE_DISABLED)
    const { uid } = requireAuth(request)
    const { operation, input } = parse(request.data)
    const profile = assertActiveRole(await loadProfile(deps.db, uid), SUPPLIER_FINANCE_ROLES, CODE.SUPPLIER_FINANCE_FORBIDDEN)
    const rid = requestId(request)
    // Phase 2 company activation — BEFORE the baseline, so an inactive company
    // never gets one; every operation's transaction re-checks it (context.js).
    await assertCommercialActivated(deps.db, profile.companyId)
    await ensureSupplierBaseline(deps, { uid, companyId: profile.companyId, projectId: input.projectId, requestId: rid })
    const out = await table[operation](deps, { uid, input, requestId: rid })
    return { operation, ...out }
  }
  return {
    progressClaimOperation: handler(parseClaimOperation, CLAIM),
    supplierInvoiceOperation: handler(parseInvoiceOperation, INVOICE),
    supplierSettlementOperation: handler(parseSettlementOperation, SETTLEMENT),
  }
}
