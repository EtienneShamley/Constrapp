// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/clientFinanceCalc.js and the
// modules it imports. Regenerate with `npm run functions:finance-calc` (from frontend/).
// ADR-89: the trusted client-finance callables run this exact domain logic.
/* eslint-disable */
//#region src/lib/money.js
const MAX_SUPPORTED_AMOUNT_CENTS = 99999999999999;
const MAX_SUPPORTED_RECEIPT_CENTS = 999999999999990;
function toCents(amount) {
	const n = typeof amount === "number" ? amount : Number(amount);
	return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const fromCents = (cents) => cents / 100;
const isWholeCents = (amount) => typeof amount === "number" && Number.isFinite(amount) && fromCents(toCents(amount)) === amount;
function shareOfCents(total, part, whole) {
	if (!Number.isInteger(total) || !Number.isInteger(part) || !Number.isInteger(whole)) throw new TypeError("shareOfCents takes whole cents");
	if (whole <= 0 || part <= 0 || total <= 0) return 0;
	const t = BigInt(total), p = BigInt(part), w = BigInt(whole);
	return Number((2n * t * p + w) / (2n * w));
}
function shareStep(total, partAfter, whole, alreadyShared) {
	const target = partAfter >= whole ? total : shareOfCents(total, partAfter, whole);
	return Math.min(Math.max(0, target - alreadyShared), Math.max(0, total - alreadyShared));
}

//#endregion
//#region src/lib/purchaseOrders.js
const PO_STATUS = {
	DRAFT: "draft",
	PENDING_APPROVAL: "pending_approval",
	SENT: "sent",
	CLOSED: "closed",
	CANCELLED: "cancelled"
};
const PO_STATUS_LABELS = {
	[PO_STATUS.DRAFT]: "Draft",
	[PO_STATUS.PENDING_APPROVAL]: "Pending Approval",
	[PO_STATUS.SENT]: "Sent",
	[PO_STATUS.CLOSED]: "Closed",
	[PO_STATUS.CANCELLED]: "Cancelled"
};
const PO_BADGE_VARIANTS = {
	[PO_STATUS.DRAFT]: "soon",
	[PO_STATUS.PENDING_APPROVAL]: "pending",
	[PO_STATUS.SENT]: "info",
	[PO_STATUS.CLOSED]: "completed",
	[PO_STATUS.CANCELLED]: "danger"
};
const PO_COMMITTED_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED];
const PO_TRANSITIONS = {
	[PO_STATUS.DRAFT]: [
		PO_STATUS.PENDING_APPROVAL,
		PO_STATUS.SENT,
		PO_STATUS.CANCELLED
	],
	[PO_STATUS.PENDING_APPROVAL]: [PO_STATUS.SENT, PO_STATUS.CANCELLED],
	[PO_STATUS.SENT]: [PO_STATUS.CLOSED, PO_STATUS.CANCELLED],
	[PO_STATUS.CLOSED]: [],
	[PO_STATUS.CANCELLED]: []
};
const PO_CANCELLABLE_STATUSES = Object.keys(PO_TRANSITIONS).filter((from) => PO_TRANSITIONS[from].includes(PO_STATUS.CANCELLED));
const PO_TRANSITION_STAMPS = {
	[PO_STATUS.SENT]: {
		at: "sentAt",
		by: "sentBy"
	},
	[PO_STATUS.CLOSED]: {
		at: "closedAt",
		by: "closedBy"
	},
	[PO_STATUS.CANCELLED]: {
		at: "cancelledAt",
		by: "cancelledBy"
	}
};
const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const PO_EDITABLE_STATUSES = [PO_STATUS.DRAFT];
const EMPTY_PO_FORM_LINE = Object.freeze({
	costCodeId: "",
	description: "",
	qty: "",
	unit: "",
	unitPrice: ""
});

//#endregion
//#region src/lib/payments.js
const PAYMENT_STATUS = {
	DRAFT: "draft",
	POSTED: "posted",
	VOID: "void"
};
const PAYMENT_STATUS_LABELS = {
	[PAYMENT_STATUS.DRAFT]: "Draft",
	[PAYMENT_STATUS.POSTED]: "Posted",
	[PAYMENT_STATUS.VOID]: "Void"
};
const PAYMENT_BADGE_VARIANTS = {
	[PAYMENT_STATUS.DRAFT]: "soon",
	[PAYMENT_STATUS.POSTED]: "active",
	[PAYMENT_STATUS.VOID]: "danger"
};
const PAYMENT_TRANSITIONS = {
	[PAYMENT_STATUS.DRAFT]: [PAYMENT_STATUS.POSTED, PAYMENT_STATUS.VOID],
	[PAYMENT_STATUS.POSTED]: [PAYMENT_STATUS.VOID],
	[PAYMENT_STATUS.VOID]: []
};
const PAYMENT_COUNTING_STATUSES = [PAYMENT_STATUS.POSTED];
const PAYMENT_EDITABLE_STATUSES = [PAYMENT_STATUS.DRAFT];
const PAYMENT_METHOD = {
	BANK_TRANSFER: "bank_transfer",
	CARD: "card",
	CASH: "cash",
	CHEQUE: "cheque",
	DIRECT_DEBIT: "direct_debit",
	OTHER: "other"
};
const PAYMENT_METHODS = Object.values(PAYMENT_METHOD);
const PAYMENT_METHOD_LABELS = {
	[PAYMENT_METHOD.BANK_TRANSFER]: "Bank transfer",
	[PAYMENT_METHOD.CARD]: "Card",
	[PAYMENT_METHOD.CASH]: "Cash",
	[PAYMENT_METHOD.CHEQUE]: "Cheque",
	[PAYMENT_METHOD.DIRECT_DEBIT]: "Direct debit",
	[PAYMENT_METHOD.OTHER]: "Other"
};
const isPaymentMethod = (m) => PAYMENT_METHODS.includes(m);
const RECONCILIATION_STATE = {
	UNRECONCILED: "unreconciled",
	PARTLY: "partly_reconciled",
	FULLY: "fully_reconciled",
	OVER: "over_reconciled"
};
const RECONCILIATION_LABELS = {
	[RECONCILIATION_STATE.UNRECONCILED]: "Unreconciled",
	[RECONCILIATION_STATE.PARTLY]: "Partly reconciled",
	[RECONCILIATION_STATE.FULLY]: "Fully reconciled",
	[RECONCILIATION_STATE.OVER]: "Over-reconciled"
};
const RECONCILIATION_BADGE_VARIANTS = {
	[RECONCILIATION_STATE.UNRECONCILED]: "soon",
	[RECONCILIATION_STATE.PARTLY]: "pending",
	[RECONCILIATION_STATE.FULLY]: "active",
	[RECONCILIATION_STATE.OVER]: "danger"
};
const pad2 = (n) => String(n).padStart(2, "0");
const toIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDateShape = (s) => typeof s === "string" && ISO_DATE_PATTERN.test(s);

//#endregion
//#region src/lib/projectTimeline.js
const ACTIVITY_STATUS = {
	NOT_STARTED: "not_started",
	IN_PROGRESS: "in_progress",
	COMPLETED: "completed",
	ON_HOLD: "on_hold",
	CANCELLED: "cancelled"
};
const ACTIVITY_STATUS_ORDER = [
	ACTIVITY_STATUS.NOT_STARTED,
	ACTIVITY_STATUS.IN_PROGRESS,
	ACTIVITY_STATUS.ON_HOLD,
	ACTIVITY_STATUS.COMPLETED,
	ACTIVITY_STATUS.CANCELLED
];
const ACTIVITY_STATUS_LABELS = {
	[ACTIVITY_STATUS.NOT_STARTED]: "Not started",
	[ACTIVITY_STATUS.IN_PROGRESS]: "In progress",
	[ACTIVITY_STATUS.ON_HOLD]: "On hold",
	[ACTIVITY_STATUS.COMPLETED]: "Completed",
	[ACTIVITY_STATUS.CANCELLED]: "Cancelled"
};
const ACTIVITY_STATUS_BADGE = {
	[ACTIVITY_STATUS.NOT_STARTED]: "soon",
	[ACTIVITY_STATUS.IN_PROGRESS]: "info",
	[ACTIVITY_STATUS.ON_HOLD]: "pending",
	[ACTIVITY_STATUS.COMPLETED]: "active",
	[ACTIVITY_STATUS.CANCELLED]: "danger"
};
const CLOSED_STATUSES = [ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.CANCELLED];
const CREATABLE_STATUSES = [
	ACTIVITY_STATUS.NOT_STARTED,
	ACTIVITY_STATUS.IN_PROGRESS,
	ACTIVITY_STATUS.ON_HOLD,
	ACTIVITY_STATUS.COMPLETED
];
const ACTIVITY_GROUP = {
	OVERDUE: "overdue",
	THIS_WEEK: "this_week",
	UPCOMING: "upcoming",
	LATER: "later",
	CLOSED: "closed"
};
const ACTIVITY_GROUP_ORDER = [
	ACTIVITY_GROUP.OVERDUE,
	ACTIVITY_GROUP.THIS_WEEK,
	ACTIVITY_GROUP.UPCOMING,
	ACTIVITY_GROUP.LATER,
	ACTIVITY_GROUP.CLOSED
];
const ACTIVITY_GROUP_LABELS = {
	[ACTIVITY_GROUP.OVERDUE]: "Overdue",
	[ACTIVITY_GROUP.THIS_WEEK]: "This week",
	[ACTIVITY_GROUP.UPCOMING]: "Upcoming",
	[ACTIVITY_GROUP.LATER]: "Later",
	[ACTIVITY_GROUP.CLOSED]: "Completed / Cancelled"
};
const ACTIVITY_GROUP_HINTS = {
	[ACTIVITY_GROUP.OVERDUE]: "Planned finish has passed and the activity is not complete",
	[ACTIVITY_GROUP.THIS_WEEK]: "Due within the next 7 days",
	[ACTIVITY_GROUP.UPCOMING]: "Due in 7 to 28 days",
	[ACTIVITY_GROUP.LATER]: "Due beyond 28 days",
	[ACTIVITY_GROUP.CLOSED]: "No longer outstanding"
};
const DUE_SOON_DAYS = 14;
const DUE_FILTER = {
	ANY: "",
	OVERDUE: "overdue",
	DUE_SOON: "due_soon"
};
const DUE_FILTER_OPTIONS = [
	{
		value: DUE_FILTER.ANY,
		label: "Any date"
	},
	{
		value: DUE_FILTER.OVERDUE,
		label: "Overdue only"
	},
	{
		value: DUE_FILTER.DUE_SOON,
		label: `Due within ${14} days`
	}
];
const QUICK_ACTION = {
	START: "start",
	HOLD: "hold",
	COMPLETE: "complete"
};
const QUICK_ACTION_ORDER = [
	QUICK_ACTION.START,
	QUICK_ACTION.HOLD,
	QUICK_ACTION.COMPLETE
];
const QUICK_ACTION_ERROR = {
	PENDING: "pending",
	MISSING: "missing",
	STALE: "stale",
	INVALID: "invalid",
	PERMISSION: "permission",
	OFFLINE: "offline",
	UNKNOWN: "unknown"
};
const QUICK_ACTION_ERROR_MESSAGES = {
	[QUICK_ACTION_ERROR.PENDING]: "This activity is still saving. Wait a moment and try again.",
	[QUICK_ACTION_ERROR.MISSING]: "This activity no longer exists. Nothing was changed.",
	[QUICK_ACTION_ERROR.STALE]: "Someone else changed this activity after it was loaded. Nothing was changed — review the latest version and try again.",
	[QUICK_ACTION_ERROR.INVALID]: "This change is no longer valid for the activity. Nothing was changed.",
	[QUICK_ACTION_ERROR.PERMISSION]: "You do not have permission to update the programme. Nothing was changed.",
	[QUICK_ACTION_ERROR.OFFLINE]: "You appear to be offline. Nothing was changed — reconnect and try again.",
	[QUICK_ACTION_ERROR.UNKNOWN]: "The activity could not be updated. Nothing was changed."
};

//#endregion
//#region src/lib/rfis.js
const RFI_STATUS = {
	DRAFT: "draft",
	OPEN: "open",
	ANSWERED: "answered",
	CLOSED: "closed",
	CANCELLED: "cancelled"
};
const RFI_STATUS_ORDER = [
	RFI_STATUS.DRAFT,
	RFI_STATUS.OPEN,
	RFI_STATUS.ANSWERED,
	RFI_STATUS.CLOSED,
	RFI_STATUS.CANCELLED
];
const RFI_STATUS_LABELS = {
	[RFI_STATUS.DRAFT]: "Draft",
	[RFI_STATUS.OPEN]: "Open",
	[RFI_STATUS.ANSWERED]: "Answered",
	[RFI_STATUS.CLOSED]: "Closed",
	[RFI_STATUS.CANCELLED]: "Cancelled"
};
const RFI_STATUS_BADGE = {
	[RFI_STATUS.DRAFT]: "soon",
	[RFI_STATUS.OPEN]: "info",
	[RFI_STATUS.ANSWERED]: "pending",
	[RFI_STATUS.CLOSED]: "active",
	[RFI_STATUS.CANCELLED]: "danger"
};
const RFI_TRANSITIONS = {
	[RFI_STATUS.DRAFT]: [RFI_STATUS.OPEN, RFI_STATUS.CANCELLED],
	[RFI_STATUS.OPEN]: [RFI_STATUS.ANSWERED, RFI_STATUS.CANCELLED],
	[RFI_STATUS.ANSWERED]: [RFI_STATUS.CLOSED],
	[RFI_STATUS.CLOSED]: [],
	[RFI_STATUS.CANCELLED]: []
};
const TERMINAL_STATUSES = [RFI_STATUS.CLOSED, RFI_STATUS.CANCELLED];
const REFERENCE_TYPE = {
	NONE: "none",
	DRAWING: "drawing",
	DOCUMENT: "document"
};
const REFERENCE_TYPES = Object.values(REFERENCE_TYPE);
const REFERENCE_TYPE_LABELS = {
	[REFERENCE_TYPE.NONE]: "No reference",
	[REFERENCE_TYPE.DRAWING]: "Drawing revision",
	[REFERENCE_TYPE.DOCUMENT]: "General document"
};
const RFI_GROUP = {
	OVERDUE: "overdue",
	DUE_SOON: "due_soon",
	OPEN: "open",
	AWAITING_CLOSE: "awaiting_close",
	DRAFT: "draft",
	CLOSED: "closed"
};
const RFI_GROUP_ORDER = [
	RFI_GROUP.OVERDUE,
	RFI_GROUP.DUE_SOON,
	RFI_GROUP.OPEN,
	RFI_GROUP.AWAITING_CLOSE,
	RFI_GROUP.DRAFT,
	RFI_GROUP.CLOSED
];
const RFI_GROUP_LABELS = {
	[RFI_GROUP.OVERDUE]: "Overdue",
	[RFI_GROUP.DUE_SOON]: "Due this week",
	[RFI_GROUP.OPEN]: "Open",
	[RFI_GROUP.AWAITING_CLOSE]: "Awaiting close",
	[RFI_GROUP.DRAFT]: "Draft",
	[RFI_GROUP.CLOSED]: "Closed / Cancelled"
};
const RFI_GROUP_HINTS = {
	[RFI_GROUP.OVERDUE]: "Due date has passed and no answer is recorded",
	[RFI_GROUP.DUE_SOON]: "Answer due within the next 7 days",
	[RFI_GROUP.OPEN]: "Raised and awaiting an answer",
	[RFI_GROUP.AWAITING_CLOSE]: "Answered — review the answer and close",
	[RFI_GROUP.DRAFT]: "Not yet raised",
	[RFI_GROUP.CLOSED]: "No longer outstanding"
};

//#endregion
//#region src/lib/variations.js
const VARIATION_TYPE = {
	CLIENT: "client",
	SUPPLIER: "supplier"
};
const VARIATION_TYPE_LABELS = {
	[VARIATION_TYPE.CLIENT]: "Client Variation",
	[VARIATION_TYPE.SUPPLIER]: "Supplier Variation"
};
const VARIATION_TYPE_HELP = {
	[VARIATION_TYPE.CLIENT]: "Head Contract Variation",
	[VARIATION_TYPE.SUPPLIER]: "Subcontract Variation"
};
const VARIATION_STATUS = {
	DRAFT: "draft",
	SUBMITTED: "submitted",
	APPROVED: "approved",
	REJECTED: "rejected",
	WITHDRAWN: "withdrawn",
	UNDER_REVIEW: "under_review",
	DISPUTED: "disputed",
	SUPERSEDED: "superseded"
};
const VARIATION_STATUS_LABELS = {
	[VARIATION_STATUS.DRAFT]: "Draft",
	[VARIATION_STATUS.SUBMITTED]: "Submitted",
	[VARIATION_STATUS.APPROVED]: "Approved",
	[VARIATION_STATUS.REJECTED]: "Rejected",
	[VARIATION_STATUS.WITHDRAWN]: "Withdrawn",
	[VARIATION_STATUS.UNDER_REVIEW]: "Under Review",
	[VARIATION_STATUS.DISPUTED]: "Disputed",
	[VARIATION_STATUS.SUPERSEDED]: "Superseded"
};
const VARIATION_BADGE_VARIANTS = {
	[VARIATION_STATUS.DRAFT]: "soon",
	[VARIATION_STATUS.SUBMITTED]: "info",
	[VARIATION_STATUS.APPROVED]: "active",
	[VARIATION_STATUS.REJECTED]: "danger",
	[VARIATION_STATUS.WITHDRAWN]: "completed",
	[VARIATION_STATUS.UNDER_REVIEW]: "pending",
	[VARIATION_STATUS.DISPUTED]: "danger",
	[VARIATION_STATUS.SUPERSEDED]: "completed"
};
const VARIATION_TRANSITIONS = {
	[VARIATION_STATUS.DRAFT]: [VARIATION_STATUS.SUBMITTED, VARIATION_STATUS.WITHDRAWN],
	[VARIATION_STATUS.SUBMITTED]: [
		VARIATION_STATUS.APPROVED,
		VARIATION_STATUS.REJECTED,
		VARIATION_STATUS.WITHDRAWN
	],
	[VARIATION_STATUS.APPROVED]: [],
	[VARIATION_STATUS.REJECTED]: [],
	[VARIATION_STATUS.WITHDRAWN]: [],
	[VARIATION_STATUS.UNDER_REVIEW]: [],
	[VARIATION_STATUS.DISPUTED]: [],
	[VARIATION_STATUS.SUPERSEDED]: []
};
const VARIATION_TRANSITION_STAMPS = {
	[VARIATION_STATUS.SUBMITTED]: {
		at: "submittedAt",
		by: "submittedBy"
	},
	[VARIATION_STATUS.APPROVED]: {
		at: "approvedAt",
		by: "approvedBy"
	},
	[VARIATION_STATUS.REJECTED]: {
		at: "rejectedAt",
		by: "rejectedBy"
	},
	[VARIATION_STATUS.WITHDRAWN]: {
		at: "withdrawnAt",
		by: "withdrawnBy"
	}
};
const VARIATION_APPROVED_STATUSES = [VARIATION_STATUS.APPROVED];
const VARIATION_PENDING_STATUSES = [VARIATION_STATUS.DRAFT, VARIATION_STATUS.SUBMITTED];
const VARIATION_EDITABLE_STATUSES = [VARIATION_STATUS.DRAFT];
const VARIATION_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED];
const VARIATION_COUNTER_ID = {
	[VARIATION_TYPE.CLIENT]: "variationsClient",
	[VARIATION_TYPE.SUPPLIER]: "variationsSupplier"
};
const TAX_CODE$1 = {
	GST: "gst",
	GST_FREE: "gst_free",
	INPUT_TAXED: "input_taxed"
};
const TAX_CODES$1 = Object.values(TAX_CODE$1);
const TAX_CODE_LABELS$1 = {
	[TAX_CODE$1.GST]: "GST 10%",
	[TAX_CODE$1.GST_FREE]: "GST-free",
	[TAX_CODE$1.INPUT_TAXED]: "Input-taxed"
};
const VARIATION_REASON = {
	DESIGN_CHANGE: "design_change",
	SITE_CONDITION: "site_condition",
	CLIENT_INSTRUCTION: "client_instruction",
	ERROR_OMISSION: "error_omission",
	OTHER: "other"
};
const VARIATION_REASON_LABELS = {
	[VARIATION_REASON.DESIGN_CHANGE]: "Design change",
	[VARIATION_REASON.SITE_CONDITION]: "Site condition",
	[VARIATION_REASON.CLIENT_INSTRUCTION]: "Client instruction",
	[VARIATION_REASON.ERROR_OMISSION]: "Error / omission",
	[VARIATION_REASON.OTHER]: "Other"
};
const ORIGIN_RFI_STATUSES = [
	RFI_STATUS.OPEN,
	RFI_STATUS.ANSWERED,
	RFI_STATUS.CLOSED
];
const UNLINKED_ORIGIN_RFI = Object.freeze({
	originRfiId: null,
	originRfiNumber: null,
	originRfiTitle: null
});
const EMPTY_VARIATION_FORM_LINE = Object.freeze({
	poLineIndex: "",
	costCodeId: "",
	description: "",
	submittedAmount: "",
	taxCode: TAX_CODE$1.GST
});
const COMMITMENT_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED];
const COMMITMENT_LINE_ISSUE = {
	PO_MISSING: "po_missing",
	PO_NOT_COMMITTED: "po_not_committed",
	LINE_OUT_OF_RANGE: "line_out_of_range",
	COST_CODE_MISMATCH: "cost_code_mismatch",
	AMOUNT_INVALID: "amount_invalid"
};
const COMMITMENT_LINE_ISSUE_LABELS = {
	[COMMITMENT_LINE_ISSUE.PO_MISSING]: "Purchase order not found in this project",
	[COMMITMENT_LINE_ISSUE.PO_NOT_COMMITTED]: "Purchase order is not sent or closed",
	[COMMITMENT_LINE_ISSUE.LINE_OUT_OF_RANGE]: "PO line index does not exist on the purchase order",
	[COMMITMENT_LINE_ISSUE.COST_CODE_MISMATCH]: "Cost code differs from the referenced PO line",
	[COMMITMENT_LINE_ISSUE.AMOUNT_INVALID]: "Approved amount is not a valid number"
};
const INCORPORATION_STATE = {
	NOT_APPLICABLE: "not_applicable",
	NOT_APPROVED: "not_approved",
	UNAPPLIED: "unapplied",
	INCORPORATED: "incorporated",
	PARTIAL: "partially_incorporated",
	NOT_INCORPORATED: "not_incorporated",
	NEGATIVE_NEW_SCOPE: "negative_new_scope",
	EXCEPTION: "exception"
};
const INCORPORATION_STATE_LABELS = {
	[INCORPORATION_STATE.NOT_APPLICABLE]: "No PO commitment",
	[INCORPORATION_STATE.NOT_APPROVED]: "Not approved",
	[INCORPORATION_STATE.UNAPPLIED]: "Not yet applied",
	[INCORPORATION_STATE.INCORPORATED]: "Fully incorporated",
	[INCORPORATION_STATE.PARTIAL]: "Partially incorporated",
	[INCORPORATION_STATE.NOT_INCORPORATED]: "New scope awaiting commit",
	[INCORPORATION_STATE.NEGATIVE_NEW_SCOPE]: "Negative new scope — review",
	[INCORPORATION_STATE.EXCEPTION]: "Invalid — needs review"
};
const INCORPORATION_STATE_HELP = {
	[INCORPORATION_STATE.NOT_APPLICABLE]: "A client or no-PO supplier variation adjusts no purchase order commitment.",
	[INCORPORATION_STATE.NOT_APPROVED]: "Only an approved variation can adjust a commitment.",
	[INCORPORATION_STATE.UNAPPLIED]: "Approved before M3-B1 — its full approved amount is separate exposure until it is explicitly applied to the PO commitment.",
	[INCORPORATION_STATE.INCORPORATED]: "Every approved amount is inside revised commitment: existing-line amounts on their PO lines, positive new-scope lines as committed, claimable scope.",
	[INCORPORATION_STATE.PARTIAL]: "Existing-line amounts are inside the revised PO commitment; positive new-scope amounts remain separate exposure until \"Commit new scope\" is recorded.",
	[INCORPORATION_STATE.NOT_INCORPORATED]: "Applied, but every line is new scope and the scope commit has not been recorded: nothing is in commitment or claimable yet, so the whole approved amount remains separate exposure.",
	[INCORPORATION_STATE.NEGATIVE_NEW_SCOPE]: "A negative new-scope line is never matured or claimed: it stays as signed exposure for accounting review — raise it as an existing-line reduction, or a supplier credit note once the related invoice is posted.",
	[INCORPORATION_STATE.EXCEPTION]: "At least one line cannot be incorporated (missing or non-committed PO, PO line not found, cost-code mismatch, invalid amount). Those amounts remain separate exposure and are listed on SHIELD."
};
const COMMITMENT_APPLY_BLOCKER = {
	NOT_SUPPLIER: "not_supplier",
	MANUAL_MODE: "manual_mode",
	NOT_APPROVED: "not_approved",
	ALREADY_APPLIED: "already_applied",
	PO_MISSING: "po_missing",
	PO_NOT_COMMITTED: "po_not_committed"
};
const COMMITMENT_APPLY_BLOCKER_MESSAGES = {
	[COMMITMENT_APPLY_BLOCKER.NOT_SUPPLIER]: "Only supplier variations adjust a purchase order commitment.",
	[COMMITMENT_APPLY_BLOCKER.MANUAL_MODE]: "This variation names no purchase order, so there is no commitment to adjust.",
	[COMMITMENT_APPLY_BLOCKER.NOT_APPROVED]: "Only an approved variation can be applied to a commitment.",
	[COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED]: "This variation has already been applied to its purchase order commitment, and it carries no uncommitted positive new-scope line.",
	[COMMITMENT_APPLY_BLOCKER.PO_MISSING]: "The linked purchase order could not be found in this project.",
	[COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED]: "The linked purchase order is not sent or closed, so the variation cannot be applied to its commitment."
};

//#endregion
//#region src/lib/clientInvoices.js
const CI_STATUS = {
	DRAFT: "draft",
	SENT: "sent",
	ISSUED: "issued",
	VOID: "void"
};
const CI_STATUS_LABELS = {
	[CI_STATUS.DRAFT]: "Draft",
	[CI_STATUS.SENT]: "Sent",
	[CI_STATUS.ISSUED]: "Issued",
	[CI_STATUS.VOID]: "Void"
};
const CI_BADGE_VARIANTS = {
	[CI_STATUS.DRAFT]: "soon",
	[CI_STATUS.SENT]: "info",
	[CI_STATUS.ISSUED]: "active",
	[CI_STATUS.VOID]: "danger"
};
const CI_TRANSITIONS = {
	[CI_STATUS.DRAFT]: [CI_STATUS.ISSUED, CI_STATUS.VOID],
	[CI_STATUS.SENT]: [],
	[CI_STATUS.ISSUED]: [CI_STATUS.VOID],
	[CI_STATUS.VOID]: []
};
const CI_COUNTING_STATUSES = [CI_STATUS.ISSUED];
const CI_EDITABLE_STATUSES = [CI_STATUS.DRAFT];
const TAX_CODE = {
	GST: "gst",
	GST_FREE: "gst_free",
	INPUT_TAXED: "input_taxed"
};
const TAX_CODES = Object.values(TAX_CODE);
const TAX_CODE_LABELS = {
	[TAX_CODE.GST]: "GST 10%",
	[TAX_CODE.GST_FREE]: "GST-free",
	[TAX_CODE.INPUT_TAXED]: "Input-taxed"
};
function invoiceTotals(lineItems, retention = 0) {
	const subtotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
	const gstTotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0));
	const grossTotal = roundMoney(subtotal + gstTotal);
	const retainedCents = Math.max(0, toCents(retention));
	const retentionGstCents = shareOfCents(Math.max(0, toCents(gstTotal)), retainedCents, toCents(subtotal));
	const retentionTotalCents = retainedCents + retentionGstCents;
	return {
		subtotal,
		gstTotal,
		grossTotal,
		retention: fromCents(retainedCents),
		retentionGst: fromCents(retentionGstCents),
		retentionTotal: fromCents(retentionTotalCents),
		receivableTotal: fromCents(toCents(grossTotal) - retentionTotalCents)
	};
}
function invoiceRetention(invoice) {
	const subtotalCents = toCents(invoice?.subtotal);
	const gstCents = toCents(invoice?.gstTotal);
	const retentionCents = toCents(invoice?.retention);
	const retentionGstCents = toCents(invoice?.retentionGst);
	const grossCents = toCents(invoice?.grossTotal);
	return {
		subtotalCents,
		gstCents,
		grossCents,
		retentionCents,
		retentionGstCents,
		retentionTotalCents: retentionCents + retentionGstCents,
		receivableCents: grossCents - retentionCents - retentionGstCents
	};
}

//#endregion
//#region src/lib/clientLedger.js
const LEDGER_KIND = {
	CREDIT: "credit",
	CREDIT_VOID: "credit_void",
	RELEASE: "release",
	RELEASE_VOID: "release_void",
	RECEIPT: "receipt",
	RECEIPT_VOID: "receipt_void"
};
const LEDGER_TOTAL_KEYS = [
	"creditedSubtotalCents",
	"creditedGstCents",
	"creditedRetentionCents",
	"creditedRetentionGstCents",
	"releasedRetentionCents",
	"releasedRetentionGstCents"
];
const emptyLedger = () => ({
	seq: 0,
	creditedSubtotalCents: 0,
	creditedGstCents: 0,
	creditedRetentionCents: 0,
	creditedRetentionGstCents: 0,
	releasedRetentionCents: 0,
	releasedRetentionGstCents: 0,
	receivedCents: 0,
	lines: {}
});
const int = (v) => Number.isInteger(v) ? v : 0;
const isLedgerCents = (v) => Number.isSafeInteger(v) && v >= 0;
const ledgerFigureKeys = () => [
	"seq",
	...LEDGER_TOTAL_KEYS,
	"receivedCents"
];
const figureProblem = (key) => `The ledger figure ${key} is not a whole, non-negative number of cents.`;
function storedLedgerProblem(doc) {
	if (!doc) return null;
	for (const key of ledgerFigureKeys()) if (doc[key] !== void 0 && !isLedgerCents(doc[key])) return figureProblem(key);
	for (const [index, line] of Object.entries(doc.lines ?? {})) if (!isLedgerCents(line?.amountCents) || !isLedgerCents(line?.gstCents)) return figureProblem(`lines.${index}`);
	if (doc.receiptBaseline !== void 0 && !isLedgerCents(doc.receiptBaseline?.legacyCents)) return figureProblem("receiptBaseline.legacyCents");
	return null;
}
function ledgerStateProblem(ledger) {
	for (const key of ledgerFigureKeys()) if (!isLedgerCents(ledger?.[key])) return figureProblem(key);
	return null;
}
function readLedger(doc) {
	const out = emptyLedger();
	if (!doc) return out;
	out.seq = int(doc.seq);
	for (const key of LEDGER_TOTAL_KEYS) out[key] = int(doc[key]);
	out.receivedCents = int(doc.receivedCents);
	for (const [index, line] of Object.entries(doc.lines ?? {})) out.lines[index] = {
		amountCents: int(line?.amountCents),
		gstCents: int(line?.gstCents)
	};
	return out;
}
function retainedGstShare(inv, L, heldEx) {
	return shareOfCents(Math.max(0, inv.gstCents - L.creditedGstCents), Math.max(0, heldEx), inv.subtotalCents - L.creditedSubtotalCents);
}
function ledgerInvariantError(invoice, ledger) {
	const inv = invoiceRetention(invoice);
	const L = ledger;
	const figure = ledgerStateProblem(L);
	if (figure) return figure;
	if (L.creditedSubtotalCents > inv.subtotalCents) return "Credits exceed the invoice subtotal.";
	if (L.creditedGstCents > inv.gstCents) return "Credited GST exceeds the invoice GST.";
	if (L.creditedSubtotalCents === inv.subtotalCents && L.creditedGstCents !== inv.gstCents) return "A full credit must reverse the invoice GST exactly.";
	if (L.creditedRetentionCents + L.releasedRetentionCents > inv.retentionCents) return "Retention credited and released together exceed the retention withheld.";
	if (L.creditedRetentionGstCents + L.releasedRetentionGstCents > inv.retentionGstCents) return "Retention GST credited and released together exceed the retention GST withheld.";
	const receivableEx = inv.subtotalCents - inv.retentionCents + L.releasedRetentionCents;
	if (L.creditedSubtotalCents - L.creditedRetentionCents > receivableEx) return "Credits against the receivable part exceed what is receivable.";
	const heldEx = inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents;
	if (inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents > retainedGstShare(inv, L, heldEx)) return "Retention GST held would exceed the retained share of the GST still billed.";
	return null;
}
function ledgerPosition(invoice, ledger) {
	const inv = invoiceRetention(invoice);
	const L = ledger ?? emptyLedger();
	const creditedGross = L.creditedSubtotalCents + L.creditedGstCents;
	const creditedRetentionGross = L.creditedRetentionCents + L.creditedRetentionGstCents;
	const releasedGross = L.releasedRetentionCents + L.releasedRetentionGstCents;
	return {
		...inv,
		creditedSubtotalCents: L.creditedSubtotalCents,
		creditedGstCents: L.creditedGstCents,
		creditedGrossCents: creditedGross,
		creditedRetentionGrossCents: creditedRetentionGross,
		releasedGrossCents: releasedGross,
		netIssuedSubtotalCents: inv.subtotalCents - L.creditedSubtotalCents,
		netIssuedGrossCents: inv.grossCents - creditedGross,
		retentionHeldExCents: inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents,
		retentionHeldGstCents: inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents,
		retentionHeldCents: inv.retentionTotalCents - releasedGross - creditedRetentionGross,
		receivableBasisCents: inv.receivableCents + releasedGross - (creditedGross - creditedRetentionGross)
	};
}
function allocateCredit(invoice, ledgerState, rows) {
	const inv = invoiceRetention(invoice);
	const L = ledgerState ?? emptyLedger();
	const sourceLines = Array.isArray(invoice?.lineItems) ? invoice.lineItems : [];
	const sourceSubtotal = sourceLines.reduce((sum, li) => sum + toCents(li?.amount), 0);
	const sourceGst = sourceLines.reduce((sum, li) => sum + toCents(li?.gstAmount), 0);
	if (sourceSubtotal !== inv.subtotalCents || sourceGst !== inv.gstCents) return { error: `${invoice?.invoiceNumber || "This invoice"} stores totals that do not reconcile to its own lines, so it cannot be credited.` };
	const perLine = /* @__PURE__ */ new Map();
	for (const row of rows ?? []) {
		const index = row?.invoiceLineIndex;
		const amountCents = toCents(row?.amount);
		if (!Number.isInteger(index) || index < 0 || index >= sourceLines.length) return { error: "A credit line does not name a line of the invoice." };
		if (amountCents <= 0) return { error: `Line ${index + 1}: the credit amount must be greater than zero.` };
		if (!isWholeCents(Number(row?.amount))) return { error: `Line ${index + 1}: the credit amount cannot carry a fraction of a cent.` };
		if (perLine.has(index)) return { error: `Line ${index + 1} is credited twice — combine those rows.` };
		perLine.set(index, amountCents);
	}
	if (perLine.size === 0) return { error: "Add at least one line with an amount." };
	const lines = [];
	let subtotalCents = 0;
	let gstCents = 0;
	for (const [index, amountCents] of [...perLine.entries()].sort((a, b) => a[0] - b[0])) {
		const lineAmount = toCents(sourceLines[index]?.amount);
		const lineGst = toCents(sourceLines[index]?.gstAmount);
		const before = L.lines[index] ?? {
			amountCents: 0,
			gstCents: 0
		};
		const after = before.amountCents + amountCents;
		if (after > lineAmount) return { error: `Line ${index + 1}: only ${((lineAmount - before.amountCents) / 100).toFixed(2)} of ${(lineAmount / 100).toFixed(2)} remains to credit.` };
		const lineGstStep = shareStep(lineGst, after, lineAmount, before.gstCents);
		lines.push({
			invoiceLineIndex: index,
			amountCents,
			gstCents: lineGstStep
		});
		subtotalCents += amountCents;
		gstCents += lineGstStep;
	}
	const creditedAfter = L.creditedSubtotalCents + subtotalCents;
	const stillBilled = inv.subtotalCents - L.creditedSubtotalCents;
	const heldEx = inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents;
	const heldGst = inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents;
	const retentionFloor = Math.max(0, creditedAfter - L.creditedRetentionCents - (inv.subtotalCents - inv.retentionCents + L.releasedRetentionCents));
	const retentionGstFor = (retention) => {
		const heldExAfter = heldEx - retention;
		const heldGstAfter = heldExAfter <= 0 ? 0 : Math.min(Math.max(0, heldGst), shareOfCents(Math.max(0, inv.gstCents - (L.creditedGstCents + gstCents)), heldExAfter, inv.subtotalCents - creditedAfter));
		return Math.max(0, heldGst - heldGstAfter);
	};
	const final = subtotalCents >= stillBilled;
	let retentionCents = final ? Math.max(0, heldEx) : Math.max(Math.min(shareOfCents(Math.max(0, heldEx), subtotalCents, stillBilled), heldEx, subtotalCents), retentionFloor);
	let retentionGstCents = retentionGstFor(retentionCents);
	while (!final && retentionCents + retentionGstCents > subtotalCents + gstCents && retentionCents > retentionFloor) {
		retentionCents -= 1;
		retentionGstCents = retentionGstFor(retentionCents);
	}
	return {
		lines,
		subtotalCents,
		gstCents,
		retentionCents,
		retentionGstCents
	};
}
function allocateRelease(invoice, ledgerState, amount) {
	const inv = invoiceRetention(invoice);
	const L = ledgerState ?? emptyLedger();
	const amountCents = toCents(amount);
	if (amountCents <= 0) return { error: "The release amount must be greater than zero." };
	if (!isWholeCents(Number(amount))) return { error: "The release amount cannot carry a fraction of a cent." };
	const heldEx = inv.retentionCents - L.releasedRetentionCents - L.creditedRetentionCents;
	const heldGst = inv.retentionGstCents - L.releasedRetentionGstCents - L.creditedRetentionGstCents;
	if (amountCents > heldEx) return { error: `Only ${(Math.max(0, heldEx) / 100).toFixed(2)} of retention (ex-GST) is still held on ${invoice?.invoiceNumber || "this invoice"}.` };
	const heldGstAfter = amountCents === heldEx ? 0 : Math.min(Math.max(0, heldGst), retainedGstShare(inv, L, heldEx - amountCents));
	return {
		amountCents,
		gstCents: Math.max(0, heldGst - heldGstAfter)
	};
}
const step = (ledgerState, kind, entryId) => ({
	...ledgerState,
	lines: Object.fromEntries(Object.entries(ledgerState.lines).map(([k, v]) => [k, { ...v }])),
	seq: ledgerState.seq + 1,
	lastEntryId: entryId,
	lastEntryKind: kind
});
function creditNoteCents(creditNote) {
	return {
		subtotalCents: toCents(creditNote?.subtotal),
		gstCents: toCents(creditNote?.gstTotal),
		retentionCents: toCents(creditNote?.retentionAmount),
		retentionGstCents: toCents(creditNote?.retentionGst),
		lines: (creditNote?.lineItems ?? []).map((li) => ({
			invoiceLineIndex: li?.invoiceLineIndex,
			amountCents: toCents(li?.amount),
			gstCents: toCents(li?.gstAmount)
		}))
	};
}
function moveCredit(ledgerState, creditNote, sign, kind) {
	const c = creditNoteCents(creditNote);
	const next = step(ledgerState, kind, creditNote.id);
	next.creditedSubtotalCents += sign * c.subtotalCents;
	next.creditedGstCents += sign * c.gstCents;
	next.creditedRetentionCents += sign * c.retentionCents;
	next.creditedRetentionGstCents += sign * c.retentionGstCents;
	for (const li of c.lines) {
		const key = String(li.invoiceLineIndex);
		const before = next.lines[key] ?? {
			amountCents: 0,
			gstCents: 0
		};
		next.lines[key] = {
			amountCents: before.amountCents + sign * li.amountCents,
			gstCents: before.gstCents + sign * li.gstCents
		};
	}
	return next;
}
const applyCredit = (ledgerState, creditNote) => moveCredit(ledgerState, creditNote, 1, LEDGER_KIND.CREDIT);
const applyCreditVoid = (ledgerState, creditNote) => moveCredit(ledgerState, creditNote, -1, LEDGER_KIND.CREDIT_VOID);
function moveRelease(ledgerState, release, sign, kind) {
	const next = step(ledgerState, kind, release.id);
	next.releasedRetentionCents += sign * toCents(release?.amount);
	next.releasedRetentionGstCents += sign * toCents(release?.gstAmount);
	return next;
}
function applyReceipt(ledgerState, allocatedCents, receiptId) {
	const next = step(ledgerState, LEDGER_KIND.RECEIPT, receiptId);
	next.receivedCents = (ledgerState.receivedCents ?? 0) + allocatedCents;
	return next;
}
function applyReceiptVoid(ledgerState, allocatedCents, receiptId) {
	const next = step(ledgerState, LEDGER_KIND.RECEIPT_VOID, receiptId);
	next.receivedCents = (ledgerState.receivedCents ?? 0) - allocatedCents;
	return next;
}
function ledgerRemainingCents(invoice, ledgerState) {
	return ledgerPosition(invoice, ledgerState).receivableBasisCents - (ledgerState?.receivedCents ?? 0);
}
const applyRelease = (ledgerState, release) => moveRelease(ledgerState, release, 1, LEDGER_KIND.RELEASE);
const applyReleaseVoid = (ledgerState, release) => moveRelease(ledgerState, release, -1, LEDGER_KIND.RELEASE_VOID);
function ledgerDocument(ledgerState) {
	const doc = {
		seq: ledgerState.seq,
		lines: ledgerState.lines,
		lastEntryId: ledgerState.lastEntryId,
		lastEntryKind: ledgerState.lastEntryKind
	};
	for (const key of LEDGER_TOTAL_KEYS) doc[key] = ledgerState[key];
	doc.receivedCents = ledgerState.receivedCents ?? 0;
	return doc;
}

//#endregion
//#region src/lib/clientCreditNotes.js
const CCN_STATUS = {
	DRAFT: "draft",
	POSTED: "posted",
	VOID: "void"
};
const CCN_STATUS_LABELS = {
	[CCN_STATUS.DRAFT]: "Draft",
	[CCN_STATUS.POSTED]: "Posted",
	[CCN_STATUS.VOID]: "Void"
};
const CCN_BADGE_VARIANTS = {
	[CCN_STATUS.DRAFT]: "soon",
	[CCN_STATUS.POSTED]: "active",
	[CCN_STATUS.VOID]: "danger"
};
const CCN_TRANSITIONS = {
	[CCN_STATUS.DRAFT]: [CCN_STATUS.POSTED, CCN_STATUS.VOID],
	[CCN_STATUS.POSTED]: [CCN_STATUS.VOID],
	[CCN_STATUS.VOID]: []
};
const CCN_DOC_TYPE = "credit_note";
function buildClientCreditNote(invoice, ledgerDoc, rows) {
	const ledgerState = readLedger(ledgerDoc);
	const allocation = allocateCredit(invoice, ledgerState, rows);
	if (allocation.error) return { error: allocation.error };
	const lineItems = allocation.lines.map((line) => {
		const source = invoice.lineItems[line.invoiceLineIndex];
		return {
			invoiceLineIndex: line.invoiceLineIndex,
			description: String(source?.description || "").trim(),
			amount: fromCents(line.amountCents),
			taxCode: source?.taxCode ?? null,
			gstAmount: fromCents(line.gstCents),
			variationId: source?.variationId ?? null,
			variationNumber: source?.variationNumber ?? "",
			costCodeId: source?.costCodeId ?? null,
			costCodeName: source?.costCodeName ?? null
		};
	});
	const grossCents = allocation.subtotalCents + allocation.gstCents;
	const retentionTotalCents = allocation.retentionCents + allocation.retentionGstCents;
	return {
		lineItems,
		ledgerSeq: ledgerState.seq,
		totals: {
			subtotal: fromCents(allocation.subtotalCents),
			gstTotal: fromCents(allocation.gstCents),
			grossTotal: fromCents(grossCents),
			retentionAmount: fromCents(allocation.retentionCents),
			retentionGst: fromCents(allocation.retentionGstCents),
			retentionTotal: fromCents(retentionTotalCents),
			receivableTotal: fromCents(grossCents - retentionTotalCents)
		}
	};
}

//#endregion
//#region src/lib/clientRetention.js
const CRR_STATUS = {
	DRAFT: "draft",
	POSTED: "posted",
	VOID: "void"
};
const CRR_STATUS_LABELS = {
	[CRR_STATUS.DRAFT]: "Draft",
	[CRR_STATUS.POSTED]: "Posted",
	[CRR_STATUS.VOID]: "Void"
};
const CRR_BADGE_VARIANTS = {
	[CRR_STATUS.DRAFT]: "soon",
	[CRR_STATUS.POSTED]: "active",
	[CRR_STATUS.VOID]: "danger"
};
const CRR_TRANSITIONS = {
	[CRR_STATUS.DRAFT]: [CRR_STATUS.POSTED, CRR_STATUS.VOID],
	[CRR_STATUS.POSTED]: [CRR_STATUS.VOID],
	[CRR_STATUS.VOID]: []
};
const CRR_DOC_TYPE = "client_retention_release";
function buildClientRetentionRelease(invoice, ledgerDoc, amount) {
	const ledgerState = readLedger(ledgerDoc);
	const allocation = allocateRelease(invoice, ledgerState, amount);
	if (allocation.error) return { error: allocation.error };
	return {
		amount: fromCents(allocation.amountCents),
		gstAmount: fromCents(allocation.gstCents),
		releaseTotal: fromCents(allocation.amountCents + allocation.gstCents),
		ledgerSeq: ledgerState.seq
	};
}

//#endregion
//#region src/lib/clientReceipts.js
const CR_DOC_TYPE = {
	RECEIPT: "receipt",
	REFUND: "refund"
};

//#endregion
//#region src/lib/clientEntryShape.js
const CLIENT_ENTRY_LIMITS = {
	REASON: 1e3,
	NOTES: 5e3,
	REFERENCE: 500,
	LINES: 100
};
const clientFinanceActivated = (companyDoc) => companyDoc?.clientFinanceEnabled === true;
const pristineLifecycle = () => ({
	postedAt: null,
	postedBy: null,
	voidedAt: null,
	voidedBy: null,
	voidReason: ""
});
const invoiceSnapshot = (invoice) => ({
	clientInvoiceId: invoice.id,
	invoiceNumber: invoice.invoiceNumber || "",
	clientId: invoice.clientId ?? null,
	clientName: invoice.clientName || ""
});
const COMMON_KEYS = [
	"status",
	"docType",
	"clientInvoiceId",
	"invoiceNumber",
	"clientId",
	"clientName",
	"reason",
	"notes",
	"ledgerSeq",
	"currency",
	"revision",
	"postedAt",
	"postedBy",
	"voidedAt",
	"voidedBy",
	"voidReason",
	"createdAt",
	"createdBy",
	"updatedAt",
	"updatedBy"
];
const CLIENT_CREDIT_LINE_KEYS = [
	"invoiceLineIndex",
	"description",
	"amount",
	"taxCode",
	"gstAmount",
	"variationId",
	"variationNumber",
	"costCodeId",
	"costCodeName"
];
const CLIENT_ENTRY_SHAPES = {
	creditNote: {
		docType: CCN_DOC_TYPE,
		numberKey: "creditNumber",
		numberPattern: /^CCN-\d{4,}$/,
		dateKey: "creditDate",
		text: {
			notes: CLIENT_ENTRY_LIMITS.NOTES,
			clientCreditReference: CLIENT_ENTRY_LIMITS.REFERENCE
		},
		keys: [
			...COMMON_KEYS,
			"creditNumber",
			"creditDate",
			"clientCreditReference",
			"lineItems",
			"subtotal",
			"gstTotal",
			"grossTotal",
			"retentionAmount",
			"retentionGst",
			"retentionTotal",
			"receivableTotal"
		]
	},
	retentionRelease: {
		docType: CRR_DOC_TYPE,
		numberKey: "releaseNumber",
		numberPattern: /^CRR-\d{4,}$/,
		dateKey: "releaseDate",
		text: { notes: CLIENT_ENTRY_LIMITS.NOTES },
		keys: [
			...COMMON_KEYS,
			"releaseNumber",
			"releaseDate",
			"amount",
			"gstAmount",
			"releaseTotal"
		]
	}
};
const sameKeys = (object, keys) => {
	const own = Object.keys(object);
	return own.length === keys.length && keys.every((key) => own.includes(key));
};
const boundedText = (value, max) => typeof value === "string" && value.length <= max;
function clientEntryDraftProblem(shape, entry, invoice) {
	if (entry === null || typeof entry !== "object") return "entry";
	const extra = Object.keys(entry).find((key) => key !== "id" && !shape.keys.includes(key));
	if (extra) return extra;
	const missing = shape.keys.find((key) => !(key in entry));
	if (missing) return missing;
	if (entry.status !== CCN_STATUS.DRAFT) return "status";
	if (entry.docType !== shape.docType) return "docType";
	if (typeof entry[shape.numberKey] !== "string" || !shape.numberPattern.test(entry[shape.numberKey])) return shape.numberKey;
	if (!isIsoDateShape(entry[shape.dateKey])) return shape.dateKey;
	if (typeof entry.reason !== "string" || entry.reason.trim().length === 0 || entry.reason.length > CLIENT_ENTRY_LIMITS.REASON) return "reason";
	for (const [key, max] of Object.entries(shape.text)) if (!boundedText(entry[key], max)) return key;
	if (typeof entry.revision !== "number" || !Number.isFinite(entry.revision)) return "revision";
	if (!Number.isInteger(entry.ledgerSeq) || entry.ledgerSeq < 0) return "ledgerSeq";
	const pristine = pristineLifecycle();
	const touched = Object.keys(pristine).find((key) => entry[key] !== pristine[key]);
	if (touched) return touched;
	const snapshot = invoiceSnapshot(invoice);
	const drifted = Object.keys(snapshot).find((key) => entry[key] !== snapshot[key]);
	if (drifted) return drifted;
	if (typeof entry.currency !== "string" || entry.currency !== invoice.currency) return "currency";
	if ("lineItems" in entry) {
		const lines = entry.lineItems;
		if (!Array.isArray(lines) || lines.length === 0 || lines.length > CLIENT_ENTRY_LIMITS.LINES) return "lineItems";
		const bad = lines.findIndex((li) => li === null || typeof li !== "object" || Array.isArray(li) || !sameKeys(li, CLIENT_CREDIT_LINE_KEYS));
		if (bad >= 0) return `lineItems[${bad}]`;
	}
	return null;
}
const CLIENT_RECEIPT_LIMITS = {
	REFERENCE: 200,
	METHOD: 40,
	NOTES: CLIENT_ENTRY_LIMITS.NOTES,
	NAME: 300,
	ALLOCATIONS: 100
};
const CLIENT_RECEIPT_NUMBER_PATTERN = /^CR-\d{4,}$/;
const CLIENT_RECEIPT_KEYS = [
	"receiptNumber",
	"status",
	"docType",
	"clientId",
	"clientName",
	"receiptDate",
	"amount",
	"paymentMethod",
	"paymentMethodOther",
	"bankReference",
	"externalReference",
	"allocations",
	"allocatedTotal",
	"unallocatedAmount",
	"currency",
	"revision",
	"notes",
	"postedAt",
	"postedBy",
	"voidedAt",
	"voidedBy",
	"voidReason",
	"attachments",
	"externalRefs",
	"createdAt",
	"createdBy",
	"updatedAt",
	"updatedBy"
];
const CLIENT_RECEIPT_ALLOCATION_KEYS = [
	"clientInvoiceId",
	"invoiceNumber",
	"allocatedAmount"
];
const RECEIPT_TEXT = {
	paymentMethodOther: CLIENT_RECEIPT_LIMITS.REFERENCE,
	bankReference: CLIENT_RECEIPT_LIMITS.REFERENCE,
	externalReference: CLIENT_RECEIPT_LIMITS.REFERENCE,
	notes: CLIENT_RECEIPT_LIMITS.NOTES
};
const isEmptyObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
function clientReceiptDraftProblem(receipt) {
	if (receipt === null || typeof receipt !== "object") return "receipt";
	const extra = Object.keys(receipt).find((key) => key !== "id" && !CLIENT_RECEIPT_KEYS.includes(key));
	if (extra) return extra;
	const missing = CLIENT_RECEIPT_KEYS.find((key) => !(key in receipt));
	if (missing) return missing;
	if (receipt.status !== PAYMENT_STATUS.DRAFT) return "status";
	if (receipt.docType !== CR_DOC_TYPE.RECEIPT) return "docType";
	if (typeof receipt.receiptNumber !== "string" || !CLIENT_RECEIPT_NUMBER_PATTERN.test(receipt.receiptNumber)) return "receiptNumber";
	if (typeof receipt.clientId !== "string" || receipt.clientId.length === 0) return "clientId";
	if (typeof receipt.clientName !== "string" || receipt.clientName.trim().length === 0 || receipt.clientName.length > CLIENT_RECEIPT_LIMITS.NAME) return "clientName";
	if (!isIsoDateShape(receipt.receiptDate)) return "receiptDate";
	if (!isPaymentMethod(receipt.paymentMethod)) return "paymentMethod";
	for (const [key, max] of Object.entries(RECEIPT_TEXT)) if (!boundedText(receipt[key], max)) return key;
	if (typeof receipt.currency !== "string" || !/^[A-Z]{3}$/.test(receipt.currency)) return "currency";
	if (typeof receipt.revision !== "number" || !Number.isFinite(receipt.revision)) return "revision";
	const pristine = pristineLifecycle();
	const touched = Object.keys(pristine).find((key) => receipt[key] !== pristine[key]);
	if (touched) return touched;
	if (!Array.isArray(receipt.attachments) || receipt.attachments.length !== 0) return "attachments";
	if (!isEmptyObject(receipt.externalRefs)) return "externalRefs";
	const allocations = receipt.allocations;
	if (!Array.isArray(allocations) || allocations.length > CLIENT_RECEIPT_LIMITS.ALLOCATIONS) return "allocations";
	const seen = /* @__PURE__ */ new Set();
	for (const [i, a] of allocations.entries()) {
		if (a === null || typeof a !== "object" || Array.isArray(a) || !sameKeys(a, CLIENT_RECEIPT_ALLOCATION_KEYS)) return `allocations[${i}]`;
		if (typeof a.clientInvoiceId !== "string" || a.clientInvoiceId.length === 0) return `allocations[${i}].clientInvoiceId`;
		if (seen.has(a.clientInvoiceId)) return `allocations[${i}].clientInvoiceId`;
		seen.add(a.clientInvoiceId);
		if (typeof a.invoiceNumber !== "string") return `allocations[${i}].invoiceNumber`;
		if (typeof a.allocatedAmount !== "number") return `allocations[${i}].allocatedAmount`;
	}
	return null;
}

//#endregion
//#region src/lib/clientReceiptPosting.js
const DAY_MS = 1440 * 60 * 1e3;
function latestPostableReceiptDate(now = /* @__PURE__ */ new Date()) {
	const next = new Date(now.getTime() + DAY_MS);
	return toIsoDate(new Date(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()));
}
function deriveReceiptTotals(receipt) {
	if (!isWholeCents(receipt?.amount) || toCents(receipt.amount) <= 0) return { field: "amount" };
	const amountCents = toCents(receipt.amount);
	if (amountCents > 999999999999990) return {
		field: "amount",
		outOfRange: true,
		maxCents: MAX_SUPPORTED_RECEIPT_CENTS
	};
	const allocations = [];
	let allocatedCents = 0;
	for (const [i, a] of (receipt.allocations ?? []).entries()) {
		if (!isWholeCents(a?.allocatedAmount) || toCents(a.allocatedAmount) <= 0) return { field: `allocations[${i}].allocatedAmount` };
		const cents = toCents(a.allocatedAmount);
		allocations.push({
			clientInvoiceId: a.clientInvoiceId,
			invoiceNumber: a.invoiceNumber,
			cents
		});
		allocatedCents += cents;
	}
	if (allocatedCents > amountCents) return { field: "allocations" };
	if (!isWholeCents(receipt.allocatedTotal) || toCents(receipt.allocatedTotal) !== allocatedCents) return { field: "allocatedTotal" };
	if (!isWholeCents(receipt.unallocatedAmount) || toCents(receipt.unallocatedAmount) !== amountCents - allocatedCents) return { field: "unallocatedAmount" };
	return {
		amountCents,
		allocatedCents,
		unallocatedCents: amountCents - allocatedCents,
		allocations
	};
}
function postedReceiptAllocations(receipt) {
	if (!Array.isArray(receipt?.allocations)) return { field: "allocations" };
	const byInvoice = /* @__PURE__ */ new Map();
	for (const [i, a] of receipt.allocations.entries()) {
		if (a === null || typeof a !== "object" || Array.isArray(a)) return { field: `allocations[${i}]` };
		if (typeof a.clientInvoiceId !== "string" || a.clientInvoiceId.length === 0) return { field: `allocations[${i}].clientInvoiceId` };
		const cents = toCents(a.allocatedAmount);
		if (!isWholeCents(a.allocatedAmount) || cents <= 0 || !Number.isSafeInteger(cents)) return { field: `allocations[${i}].allocatedAmount` };
		const row = byInvoice.get(a.clientInvoiceId);
		if (row) row.cents += cents;
		else byInvoice.set(a.clientInvoiceId, {
			clientInvoiceId: a.clientInvoiceId,
			invoiceNumber: typeof a.invoiceNumber === "string" ? a.invoiceNumber : "",
			cents
		});
	}
	const allocations = [...byInvoice.values()];
	if (allocations.some((row) => !Number.isSafeInteger(row.cents))) return { field: "allocations" };
	return {
		allocations,
		count: receipt.allocations.length
	};
}
function receiptBaselineSums(postedReceipts, isInvoiceId = () => true) {
	const byInvoice = /* @__PURE__ */ new Map();
	let legacyAllocations = 0;
	let legacyCents = 0;
	for (const receipt of postedReceipts ?? []) {
		const named = {
			receiptId: receipt?.id ?? null,
			number: typeof receipt?.receiptNumber === "string" ? receipt.receiptNumber : null
		};
		if (receipt?.allocatedInvoiceIds !== void 0) return { problem: {
			kind: "inconsistent",
			...named
		} };
		const parsed = postedReceiptAllocations(receipt);
		if (parsed.field) return { problem: {
			kind: "invalid",
			...named,
			field: parsed.field
		} };
		for (const a of parsed.allocations) {
			if (!isInvoiceId(a.clientInvoiceId)) return { problem: {
				kind: "invalid",
				...named,
				field: "allocations"
			} };
			const row = byInvoice.get(a.clientInvoiceId) ?? {
				invoiceId: a.clientInvoiceId,
				cents: 0,
				receipts: 0
			};
			row.cents += a.cents;
			row.receipts += 1;
			byInvoice.set(a.clientInvoiceId, row);
			legacyCents += a.cents;
			if (!Number.isSafeInteger(row.cents) || !Number.isSafeInteger(legacyCents)) return { problem: {
				kind: "range",
				...named
			} };
		}
		legacyAllocations += parsed.count;
	}
	return {
		invoices: [...byInvoice.values()],
		legacyPostedReceipts: (postedReceipts ?? []).length,
		legacyAllocations,
		legacyCents
	};
}
function unlistedReceivedCents(receivedCents, listed) {
	let explained = 0;
	for (const r of listed ?? []) explained += r.allocatedCents;
	return Math.max(0, receivedCents - explained);
}
function storedReceiptAllocations(receipt) {
	return (Array.isArray(receipt?.allocations) ? receipt.allocations : []).filter((a) => typeof a?.clientInvoiceId === "string" && a.clientInvoiceId.length > 0 && toCents(a.allocatedAmount) > 0).map((a) => ({
		clientInvoiceId: a.clientInvoiceId,
		invoiceNumber: a.invoiceNumber ?? "",
		cents: toCents(a.allocatedAmount)
	}));
}
const allocatedInvoiceIds = (allocations) => [...new Set((allocations ?? []).map((a) => a.clientInvoiceId))].sort();
function receiptOverAllocations(allocations, positions) {
	const out = [];
	for (const a of allocations ?? []) {
		const position = positions?.[a.clientInvoiceId];
		if (!position) continue;
		const remainingCents = Math.max(0, ledgerRemainingCents(position.invoice, position.ledgerState));
		if (a.cents > remainingCents) out.push({
			invoiceId: a.clientInvoiceId,
			invoiceNumber: position.invoice?.invoiceNumber || a.invoiceNumber || "",
			allocatedCents: a.cents,
			remainingCents,
			excessCents: a.cents - remainingCents
		});
	}
	return out;
}

//#endregion
export { CCN_DOC_TYPE, CCN_STATUS, CI_STATUS, CLIENT_CREDIT_LINE_KEYS, CLIENT_ENTRY_SHAPES, CLIENT_RECEIPT_ALLOCATION_KEYS, CLIENT_RECEIPT_KEYS, CRR_DOC_TYPE, CRR_STATUS, LEDGER_KIND, LEDGER_TOTAL_KEYS, MAX_SUPPORTED_AMOUNT_CENTS, MAX_SUPPORTED_RECEIPT_CENTS, PAYMENT_STATUS, allocatedInvoiceIds, applyCredit, applyCreditVoid, applyReceipt, applyReceiptVoid, applyRelease, applyReleaseVoid, buildClientCreditNote, buildClientRetentionRelease, clientEntryDraftProblem, clientFinanceActivated, clientReceiptDraftProblem, deriveReceiptTotals, fromCents, invoiceRetention, invoiceTotals, isWholeCents, latestPostableReceiptDate, ledgerDocument, ledgerInvariantError, ledgerPosition, ledgerStateProblem, postedReceiptAllocations, readLedger, receiptBaselineSums, receiptOverAllocations, storedLedgerProblem, storedReceiptAllocations, toCents, unlistedReceivedCents };