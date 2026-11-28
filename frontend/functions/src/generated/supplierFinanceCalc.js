// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/supplierFinanceCalc.js and the
// modules it imports. Regenerate with `npm run functions:supplier-finance-calc` (from frontend/).
// ADR-93 / ADR-94: the trusted supplier-finance callables run this exact domain logic.
/* eslint-disable */
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
const GST_RATE = .1;
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
//#region src/lib/sourceLine.js
const SOURCE_LINE_KIND = {
	PO_LINE: "po_line",
	VARIATION_LINE: "variation_line",
	INVALID: "invalid"
};
function indexOrNull(v) {
	return Number.isInteger(v) && v >= 0 ? v : null;
}
const isVariationOriginLine = (li) => typeof li?.variationId === "string" && li.variationId.length > 0;
function sourceLineKind(li) {
	if (!li || typeof li !== "object") return SOURCE_LINE_KIND.INVALID;
	if (isVariationOriginLine(li)) return indexOrNull(li.variationLineIndex) !== null && (li.poLineIndex === null || li.poLineIndex === void 0) ? SOURCE_LINE_KIND.VARIATION_LINE : SOURCE_LINE_KIND.INVALID;
	if (li.variationId !== void 0 && li.variationId !== null) return SOURCE_LINE_KIND.INVALID;
	return indexOrNull(li.poLineIndex) !== null ? SOURCE_LINE_KIND.PO_LINE : SOURCE_LINE_KIND.INVALID;
}
const poLineKey = (poId, idx) => `po:${poId}:${idx}`;
const variationLineKey = (variationId, idx) => `var:${variationId}:${idx}`;
function sourceLineKey(li, { poId } = {}) {
	switch (sourceLineKind(li)) {
		case SOURCE_LINE_KIND.PO_LINE: return poLineKey(poId ?? "", li.poLineIndex);
		case SOURCE_LINE_KIND.VARIATION_LINE: return variationLineKey(li.variationId, li.variationLineIndex);
		default: return null;
	}
}
function sourceLineLabel(li) {
	if (sourceLineKind(li) === SOURCE_LINE_KIND.VARIATION_LINE) return `${li.variationNumber || li.variationId} line ${li.variationLineIndex + 1}`;
	if (sourceLineKind(li) === SOURCE_LINE_KIND.PO_LINE) return `PO line ${li.poLineIndex + 1}`;
	return "line with no valid source";
}
function variationLineCountOf(lineItems) {
	return (Array.isArray(lineItems) ? lineItems : []).filter((li) => sourceLineKind(li) === SOURCE_LINE_KIND.VARIATION_LINE).length;
}
function sourceLineIdentityError(lineItems, { poId } = {}) {
	const lines = Array.isArray(lineItems) ? lineItems : [];
	const seen = /* @__PURE__ */ new Set();
	for (let i = 0; i < lines.length; i++) {
		const li = lines[i];
		if (sourceLineKind(li) === SOURCE_LINE_KIND.INVALID) return `Line ${i + 1}: the source line identity is missing or malformed (it names neither a PO line nor a variation line)`;
		const key = sourceLineKey(li, { poId });
		if (seen.has(key)) return `Line ${i + 1}: ${sourceLineLabel(li)} appears more than once — a source line may be claimed once per document`;
		seen.add(key);
	}
	return null;
}

//#endregion
//#region src/lib/money.js
const MAX_SUPPORTED_AMOUNT_CENTS = 99999999999999;
function toCents(amount) {
	const n = typeof amount === "number" ? amount : Number(amount);
	return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const fromCents = (cents) => cents / 100;
const isWholeCents = (amount) => typeof amount === "number" && Number.isFinite(amount) && fromCents(toCents(amount)) === amount;
function gstOfCents(cents) {
	return cents < 0 ? 0 - Math.floor((-cents + 5) / 10) : Math.floor((cents + 5) / 10);
}
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
//#region src/lib/supplierCalc.js
const CALC_VERSION = Object.freeze({
	LEGACY: 1,
	EXACT: 2
});
const CURRENT_CALC_VERSION = CALC_VERSION.EXACT;
function calcVersionOf(doc) {
	const v = doc?.calcVersion;
	if (v === void 0 || v === null || v === CALC_VERSION.LEGACY) return CALC_VERSION.LEGACY;
	if (v === CALC_VERSION.EXACT) return CALC_VERSION.EXACT;
	return null;
}
const isKnownCalcVersion = (v) => v === CALC_VERSION.LEGACY || v === CALC_VERSION.EXACT;
function assertVersion(version) {
	if (!isKnownCalcVersion(version)) throw new RangeError(`Unknown calculation version: ${String(version)}`);
}
function decimalParts(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return null;
	const negative = n < 0;
	const text = String(Math.abs(n));
	if (text.includes("e")) {
		if (Math.abs(n) < 1e-6) return {
			negative,
			digits: 0n,
			scale: 0
		};
		return null;
	}
	const [whole, fraction = ""] = text.split(".");
	return {
		negative,
		digits: BigInt(whole + fraction),
		scale: fraction.length
	};
}
function partsToCents({ negative, digits, scale }) {
	let cents;
	if (scale <= 2) cents = digits * 10n ** BigInt(2 - scale);
	else {
		const divisor = 10n ** BigInt(scale - 2);
		cents = (digits * 2n + divisor) / (divisor * 2n);
	}
	const out = Number(cents);
	return negative && out !== 0 ? -out : out;
}
function roundToCents(amount) {
	const parts = decimalParts(amount);
	if (!parts) return null;
	const cents = partsToCents(parts);
	return Math.abs(cents) > 99999999999999 ? null : cents;
}
function gstOnAmount(amount, version = CALC_VERSION.LEGACY) {
	assertVersion(version);
	const n = Number(amount) || 0;
	if (version === CALC_VERSION.LEGACY) return roundMoney(n * GST_RATE);
	const cents = roundToCents(n);
	return cents === null ? null : fromCents(gstOfCents(cents));
}

//#endregion
//#region src/lib/progressClaims.js
const CLAIM_STATUS = {
	DRAFT: "draft",
	SUBMITTED: "submitted",
	UNDER_REVIEW: "under_review",
	APPROVED: "approved",
	REJECTED: "rejected",
	INVOICED: "invoiced"
};
const CLAIM_STATUS_LABELS = {
	[CLAIM_STATUS.DRAFT]: "Draft",
	[CLAIM_STATUS.SUBMITTED]: "Submitted",
	[CLAIM_STATUS.UNDER_REVIEW]: "Under Review",
	[CLAIM_STATUS.APPROVED]: "Approved",
	[CLAIM_STATUS.REJECTED]: "Rejected",
	[CLAIM_STATUS.INVOICED]: "Invoiced"
};
const CLAIM_BADGE_VARIANTS = {
	[CLAIM_STATUS.DRAFT]: "soon",
	[CLAIM_STATUS.SUBMITTED]: "info",
	[CLAIM_STATUS.UNDER_REVIEW]: "pending",
	[CLAIM_STATUS.APPROVED]: "active",
	[CLAIM_STATUS.REJECTED]: "danger",
	[CLAIM_STATUS.INVOICED]: "completed"
};
const CLAIM_TRANSITIONS = {
	[CLAIM_STATUS.DRAFT]: [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.REJECTED],
	[CLAIM_STATUS.SUBMITTED]: [
		CLAIM_STATUS.UNDER_REVIEW,
		CLAIM_STATUS.APPROVED,
		CLAIM_STATUS.REJECTED
	],
	[CLAIM_STATUS.UNDER_REVIEW]: [CLAIM_STATUS.APPROVED, CLAIM_STATUS.REJECTED],
	[CLAIM_STATUS.APPROVED]: [CLAIM_STATUS.INVOICED],
	[CLAIM_STATUS.REJECTED]: [],
	[CLAIM_STATUS.INVOICED]: []
};
const canTransition = (from, to) => (CLAIM_TRANSITIONS[from] ?? []).includes(to);
const CLAIM_TRANSITION_STAMPS = {
	[CLAIM_STATUS.SUBMITTED]: {
		at: "submittedAt",
		by: "submittedBy"
	},
	[CLAIM_STATUS.APPROVED]: {
		at: "approvedAt",
		by: "approvedBy"
	},
	[CLAIM_STATUS.REJECTED]: {
		at: "rejectedAt",
		by: "rejectedBy"
	}
};
const CLAIM_MAX_LINES = 200;
const CLAIM_OPEN_STATUSES = [
	CLAIM_STATUS.DRAFT,
	CLAIM_STATUS.SUBMITTED,
	CLAIM_STATUS.UNDER_REVIEW
];
const CLAIM_APPROVED_STATUSES = [CLAIM_STATUS.APPROVED, CLAIM_STATUS.INVOICED];
const CLAIM_PENDING_STATUSES = [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW];
const CLAIMABLE_PO_STATUSES = [PO_STATUS.SENT];
const CLAIM_INVOICE_LINK = {
	LEGACY: "legacy",
	UNLINKED: "unlinked",
	LINKED: "linked",
	MALFORMED: "malformed"
};
function claimInvoiceLink(claim) {
	if (!claim || typeof claim !== "object" || !Object.prototype.hasOwnProperty.call(claim, "supplierInvoiceId")) return {
		state: CLAIM_INVOICE_LINK.LEGACY,
		invoiceId: null
	};
	const id = claim.supplierInvoiceId;
	if (id === null) return {
		state: CLAIM_INVOICE_LINK.UNLINKED,
		invoiceId: null
	};
	if (typeof id === "string" && id.length > 0) return {
		state: CLAIM_INVOICE_LINK.LINKED,
		invoiceId: id
	};
	return {
		state: CLAIM_INVOICE_LINK.MALFORMED,
		invoiceId: null
	};
}
const CLAIM_LINK_INITIAL = Object.freeze({
	supplierInvoiceId: null,
	supplierInvoiceLinkedAt: null,
	supplierInvoiceLinkedBy: null
});
const formatClaimNumber = (n) => `PC-${String(n).padStart(4, "0")}`;
function claimTotals(lineAmounts, retention = 0) {
	const subtotal = roundMoney(lineAmounts.reduce((sum, a) => sum + (Number(a) || 0), 0));
	const retained = Math.min(roundMoney(Number(retention) || 0), subtotal);
	const net = roundMoney(subtotal - retained);
	const gst = roundMoney(net * GST_RATE);
	return {
		subtotal,
		retention: retained,
		net,
		gst,
		total: roundMoney(net + gst)
	};
}
function claimTotalsFor(lineAmounts, retention = 0, version = CALC_VERSION.LEGACY) {
	if (version === CALC_VERSION.LEGACY) return claimTotals(lineAmounts, retention);
	if (version !== CALC_VERSION.EXACT) return null;
	let subtotalCents = 0;
	for (const a of lineAmounts ?? []) {
		const c = roundToCents(Number(a) || 0);
		if (c === null) return null;
		subtotalCents += c;
	}
	const retentionInput = roundToCents(Number(retention) || 0);
	if (retentionInput === null) return null;
	const retainedCents = Math.min(retentionInput, subtotalCents);
	const netCents = subtotalCents - retainedCents;
	const gstCents = gstOfCents(netCents);
	return {
		subtotal: fromCents(subtotalCents),
		retention: fromCents(retainedCents),
		net: fromCents(netCents),
		gst: fromCents(gstCents),
		total: fromCents(netCents + gstCents)
	};
}
function claimedThisPeriodFor(claimedToDate, previouslyApproved, version = CALC_VERSION.LEGACY) {
	const toDate = Number(claimedToDate) || 0;
	const prev = Number(previouslyApproved) || 0;
	if (version === CALC_VERSION.LEGACY) return roundMoney(toDate - prev);
	if (version !== CALC_VERSION.EXACT) return null;
	const a = roundToCents(toDate);
	const b = roundToCents(prev);
	return a === null || b === null ? null : fromCents(a - b);
}
const CLAIM_VARIATION_LINE_ISSUE = {
	VARIATION_MISSING: "variation_missing",
	NOT_SUPPLIER: "variation_not_supplier",
	NOT_APPROVED: "variation_not_approved",
	PO_MISMATCH: "variation_po_mismatch",
	NOT_APPLIED: "variation_not_applied",
	NOT_SCOPE_COMMITTED: "variation_scope_not_committed",
	LINE_MISSING: "variation_line_missing",
	NOT_NEW_SCOPE: "variation_line_not_new_scope",
	NOT_POSITIVE: "variation_line_not_positive",
	COST_CODE_MISMATCH: "variation_line_cost_code_mismatch",
	AMOUNT_MISMATCH: "variation_line_total_mismatch"
};
const CLAIM_VARIATION_LINE_ISSUE_LABELS = {
	[CLAIM_VARIATION_LINE_ISSUE.VARIATION_MISSING]: "Variation not found in this project",
	[CLAIM_VARIATION_LINE_ISSUE.NOT_SUPPLIER]: "Variation is not a supplier variation",
	[CLAIM_VARIATION_LINE_ISSUE.NOT_APPROVED]: "Variation is not approved",
	[CLAIM_VARIATION_LINE_ISSUE.PO_MISMATCH]: "Variation does not name this purchase order",
	[CLAIM_VARIATION_LINE_ISSUE.NOT_APPLIED]: "Variation has not been applied to the PO commitment",
	[CLAIM_VARIATION_LINE_ISSUE.NOT_SCOPE_COMMITTED]: "Variation new scope has not been committed",
	[CLAIM_VARIATION_LINE_ISSUE.LINE_MISSING]: "Variation line index does not exist on the variation",
	[CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE]: "Variation line is not valid new scope on this purchase order",
	[CLAIM_VARIATION_LINE_ISSUE.NOT_POSITIVE]: "Variation line amount is not positive — not claimable",
	[CLAIM_VARIATION_LINE_ISSUE.COST_CODE_MISMATCH]: "Cost code differs from the variation line",
	[CLAIM_VARIATION_LINE_ISSUE.AMOUNT_MISMATCH]: "Claim line ceiling differs from the approved variation line amount"
};
function claimVariationLineIssue(line, { variation, po, classify } = {}) {
	if (!isVariationOriginLine(line)) return null;
	if (!variation) return CLAIM_VARIATION_LINE_ISSUE.VARIATION_MISSING;
	if (variation.variationType !== "supplier") return CLAIM_VARIATION_LINE_ISSUE.NOT_SUPPLIER;
	if (!CLAIM_VARIATION_APPROVED.includes(variation.status)) return CLAIM_VARIATION_LINE_ISSUE.NOT_APPROVED;
	if (!po?.id || variation.poId !== po.id) return CLAIM_VARIATION_LINE_ISSUE.PO_MISMATCH;
	if (!(variation.commitmentAppliedAt != null && typeof variation.commitmentAppliedBy === "string" && variation.commitmentAppliedBy.length > 0)) return CLAIM_VARIATION_LINE_ISSUE.NOT_APPLIED;
	if (!(variation.scopeCommittedAt != null && typeof variation.scopeCommittedBy === "string" && variation.scopeCommittedBy.length > 0)) return CLAIM_VARIATION_LINE_ISSUE.NOT_SCOPE_COMMITTED;
	const idx = indexOrNull(line.variationLineIndex);
	const vLine = idx === null ? null : (variation.lineItems ?? [])[idx];
	if (!vLine) return CLAIM_VARIATION_LINE_ISSUE.LINE_MISSING;
	const classified = typeof classify === "function" ? classify(variation, po)[idx] : null;
	if (classified && classified.kind !== "new_scope") return CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE;
	if (!classified && vLine.poLineIndex != null) return CLAIM_VARIATION_LINE_ISSUE.NOT_NEW_SCOPE;
	const amount = roundMoney(Number(vLine.approvedAmount) || 0);
	if (!(amount > 0)) return CLAIM_VARIATION_LINE_ISSUE.NOT_POSITIVE;
	if ((vLine.costCodeId || "") !== (line.costCodeId || "")) return CLAIM_VARIATION_LINE_ISSUE.COST_CODE_MISMATCH;
	if (roundMoney(Number(line.variationLineTotal) || 0) !== amount) return CLAIM_VARIATION_LINE_ISSUE.AMOUNT_MISMATCH;
	return null;
}
const CLAIM_VARIATION_APPROVED = ["approved"];
const CLAIM_EDITABLE_STATUSES = [CLAIM_STATUS.DRAFT];
function buildClaimLine(source, { claimedToDate, poLineIndex, previouslyApproved } = {}) {
	const src = source && typeof source === "object" ? source : {};
	const str = (v) => typeof v === "string" ? v : "";
	const num = (v) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const variationOrigin = isVariationOriginLine(src);
	const idx = variationOrigin ? null : indexOrNull(poLineIndex ?? src.poLineIndex);
	const prev = num(previouslyApproved ?? src.previouslyApproved);
	const total = num(src.poLineTotal ?? src.lineTotal);
	const toDate = num(claimedToDate);
	return {
		...variationOrigin ? {
			poLineIndex: null,
			variationId: src.variationId,
			variationNumber: str(src.variationNumber),
			variationLineIndex: indexOrNull(src.variationLineIndex),
			variationLineTotal: num(src.variationLineTotal),
			poLineTotal: null
		} : {
			poLineIndex: idx,
			poLineTotal: total
		},
		costCodeId: str(src.costCodeId),
		costCodeName: str(src.costCodeName),
		description: str(src.description),
		previouslyApproved: prev,
		claimedToDate: toDate,
		claimedThisPeriod: roundMoney(toDate - prev),
		approvedThisPeriod: null
	};
}
function buildVariationClaimLine(row, { previouslyApproved, claimedToDate } = {}) {
	const r = row && typeof row === "object" ? row : {};
	return buildClaimLine({
		variationId: typeof r.variationId === "string" ? r.variationId : "",
		variationNumber: r.variationNumber,
		variationLineIndex: r.lineIndex,
		variationLineTotal: r.amount,
		costCodeId: r.costCodeId,
		costCodeName: r.costCodeName,
		description: r.description
	}, {
		previouslyApproved,
		claimedToDate
	});
}
const claimVariationLineCount = (lineItems) => variationLineCountOf(lineItems);
function claimRetentionError(retention) {
	if (retention === "" || retention == null) return null;
	const n = Number(retention);
	if (!Number.isFinite(n)) return "Retention must be a number";
	if (n < 0) return "Retention cannot be negative";
	return null;
}
function validateClaimDraft({ lineItems, retention, poId } = {}) {
	const lines = Array.isArray(lineItems) ? lineItems : [];
	if (lines.length === 0) return "A progress claim needs at least one line";
	if (lines.length > CLAIM_MAX_LINES) return `A progress claim can carry at most ${CLAIM_MAX_LINES} lines`;
	const identityError = sourceLineIdentityError(lines, { poId });
	if (identityError) return identityError;
	const backwards = lines.findIndex((li) => (Number(li?.claimedThisPeriod) || 0) < 0);
	if (backwards !== -1) return `Line ${backwards + 1}: claimed to date cannot be below the previously approved amount`;
	if (!lines.some((li) => (Number(li?.claimedThisPeriod) || 0) > 0)) return "A progress claim must claim an amount on at least one line";
	return claimRetentionError(retention);
}

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
const isPoLinkedSupplierVariation = (v) => v?.variationType === VARIATION_TYPE.SUPPLIER && typeof v.poId === "string" && v.poId.length > 0;
const isCommitmentApplied = (v) => v?.commitmentAppliedAt != null && typeof v.commitmentAppliedBy === "string" && v.commitmentAppliedBy.length > 0;
const isScopeCommitted = (v) => v?.scopeCommittedAt != null && typeof v.scopeCommittedBy === "string" && v.scopeCommittedBy.length > 0;
const COMMITMENT_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED];
const COMMITMENT_LINE_KIND = {
	EXISTING_LINE: "existing_line",
	NEW_SCOPE: "new_scope",
	INVALID: "invalid"
};
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
const finiteOrNull = (v) => {
	if (v === null || v === void 0 || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? roundMoney(n) : null;
};
function classifyCommitmentLines(variation, po) {
	const poLines = Array.isArray(po?.lineItems) ? po.lineItems : [];
	const poProblem = !po ? COMMITMENT_LINE_ISSUE.PO_MISSING : !COMMITMENT_PO_STATUSES.includes(po.status) ? COMMITMENT_LINE_ISSUE.PO_NOT_COMMITTED : null;
	return (variation?.lineItems ?? []).map((li, lineIndex) => {
		const amount = finiteOrNull(li?.approvedAmount);
		const base = {
			lineIndex,
			poLineIndex: Number.isInteger(li?.poLineIndex) ? li.poLineIndex : null,
			amount,
			costCodeId: typeof li?.costCodeId === "string" ? li.costCodeId : "",
			costCodeName: typeof li?.costCodeName === "string" ? li.costCodeName : "",
			description: typeof li?.description === "string" ? li.description : "",
			poLineCostCodeId: null
		};
		if (amount === null) return {
			...base,
			kind: COMMITMENT_LINE_KIND.INVALID,
			issue: COMMITMENT_LINE_ISSUE.AMOUNT_INVALID
		};
		if (poProblem) return {
			...base,
			kind: COMMITMENT_LINE_KIND.INVALID,
			issue: poProblem
		};
		if (li?.poLineIndex === null || li?.poLineIndex === void 0) return {
			...base,
			kind: COMMITMENT_LINE_KIND.NEW_SCOPE,
			issue: null
		};
		if (!Number.isInteger(li.poLineIndex) || li.poLineIndex < 0 || li.poLineIndex >= poLines.length) return {
			...base,
			kind: COMMITMENT_LINE_KIND.INVALID,
			issue: COMMITMENT_LINE_ISSUE.LINE_OUT_OF_RANGE
		};
		const poLine = poLines[li.poLineIndex] ?? {};
		const poCode = typeof poLine.costCodeId === "string" ? poLine.costCodeId : "";
		if (!poCode || poCode !== base.costCodeId) return {
			...base,
			kind: COMMITMENT_LINE_KIND.INVALID,
			issue: COMMITMENT_LINE_ISSUE.COST_CODE_MISMATCH,
			poLineCostCodeId: poCode || null
		};
		return {
			...base,
			kind: COMMITMENT_LINE_KIND.EXISTING_LINE,
			issue: null,
			poLineCostCodeId: poCode,
			costCodeName: poLine.costCodeName || base.costCodeName
		};
	});
}
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
const isPositiveNewScope = (l) => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE && l.amount > 0;
function claimableNewScopeLines(variations, po) {
	if (!po?.id) return [];
	const rows = [];
	const seen = /* @__PURE__ */ new Set();
	for (const v of variations ?? []) {
		if (!v?.id || seen.has(v.id)) continue;
		if (!isPoLinkedSupplierVariation(v) || v.poId !== po.id) continue;
		if (!VARIATION_APPROVED_STATUSES.includes(v.status) || !isCommitmentApplied(v) || !isScopeCommitted(v)) continue;
		seen.add(v.id);
		for (const l of classifyCommitmentLines(v, po)) {
			if (!isPositiveNewScope(l)) continue;
			rows.push({
				variationId: v.id,
				variationNumber: v.variationNumber || "",
				lineIndex: l.lineIndex,
				amount: l.amount,
				costCodeId: l.costCodeId,
				costCodeName: l.costCodeName,
				description: l.description
			});
		}
	}
	rows.sort((a, b) => a.variationNumber.localeCompare(b.variationNumber) || a.variationId.localeCompare(b.variationId) || a.lineIndex - b.lineIndex);
	return rows;
}
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
//#region src/lib/claimProcessing.js
const CLAIM_PROCESSING_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const CLAIM_NOTES_MAX = 5e3;
const CLAIM_REF_MAX = 200;
const CLAIM_COUNTER_ID = "progressClaims";
const isObject$2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys$2 = (data, keys) => isObject$2(data) && Object.keys(data).length === keys.length && keys.every((k) => k in data);
const isId$2 = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const isRevision$2 = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const DATE_RE$2 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isDateOrEmpty$1 = (v) => typeof v === "string" && (v === "" || DATE_RE$2.test(v));
const isText$2 = (v, max) => typeof v === "string" && v.length <= max;
const isAmount$1 = (v) => typeof v === "number" && Number.isFinite(v) && roundToCents(v) !== null;
const CREATE_CLAIM_KEYS = [
	"projectId",
	"claimId",
	"poId",
	"periodEnding",
	"claimRef",
	"notes",
	"retention",
	"lines"
];
const CLAIM_LINE_KEYS = [
	"poLineIndex",
	"variationId",
	"variationLineIndex",
	"claimedToDate"
];
const UPDATE_CLAIM_KEYS = [
	"projectId",
	"claimId",
	"expectedRevision",
	"periodEnding",
	"claimRef",
	"notes",
	"retention",
	"claimedToDate"
];
const APPROVE_CLAIM_KEYS = [
	"projectId",
	"claimId",
	"expectedRevision",
	"approvedAmounts",
	"assessmentNotes"
];
const REJECT_CLAIM_KEYS = [
	"projectId",
	"claimId",
	"expectedRevision",
	"assessmentNotes"
];
function headerProblem$1(data) {
	if (!isId$2(data.projectId) || !isId$2(data.claimId)) return "ids";
	if (!isDateOrEmpty$1(data.periodEnding)) return "periodEnding";
	if (!isText$2(data.claimRef, 200)) return "claimRef";
	if (!isText$2(data.notes, 5e3)) return "notes";
	if (!isAmount$1(data.retention) || data.retention < 0 || !isWholeCents(data.retention)) return "retention";
	return null;
}
function createClaimRequestProblem(data) {
	if (!exactKeys$2(data, CREATE_CLAIM_KEYS)) return "keys";
	const header = headerProblem$1(data);
	if (header) return header;
	if (!isId$2(data.poId)) return "poId";
	if (!Array.isArray(data.lines) || data.lines.length === 0 || data.lines.length > CLAIM_MAX_LINES) return "lines";
	for (const line of data.lines) {
		if (!exactKeys$2(line, CLAIM_LINE_KEYS)) return "line-keys";
		if (!isAmount$1(line.claimedToDate)) return "line-amount";
		const po = line.poLineIndex;
		const v = line.variationId;
		if (v === null) {
			if (indexOrNull(po) === null || line.variationLineIndex !== null) return "line-source";
		} else if (!isId$2(v) || po !== null || indexOrNull(line.variationLineIndex) === null) return "line-source";
	}
	return null;
}
function updateClaimRequestProblem(data) {
	if (!exactKeys$2(data, UPDATE_CLAIM_KEYS)) return "keys";
	const header = headerProblem$1(data);
	if (header) return header;
	if (!isRevision$2(data.expectedRevision)) return "expectedRevision";
	if (!Array.isArray(data.claimedToDate) || data.claimedToDate.length === 0 || data.claimedToDate.length > CLAIM_MAX_LINES) return "claimedToDate";
	if (!data.claimedToDate.every(isAmount$1)) return "claimedToDate";
	return null;
}
function approveClaimRequestProblem(data) {
	if (!exactKeys$2(data, APPROVE_CLAIM_KEYS)) return "keys";
	if (!isId$2(data.projectId) || !isId$2(data.claimId)) return "ids";
	if (!isRevision$2(data.expectedRevision)) return "expectedRevision";
	if (!Array.isArray(data.approvedAmounts) || data.approvedAmounts.length === 0 || data.approvedAmounts.length > CLAIM_MAX_LINES) return "approvedAmounts";
	if (!data.approvedAmounts.every((a) => isAmount$1(a) && a >= 0 && isWholeCents(a))) return "approvedAmounts";
	if (!isText$2(data.assessmentNotes, 5e3)) return "assessmentNotes";
	return null;
}
function rejectClaimRequestProblem(data) {
	if (!exactKeys$2(data, REJECT_CLAIM_KEYS)) return "keys";
	if (!isId$2(data.projectId) || !isId$2(data.claimId)) return "ids";
	if (!isRevision$2(data.expectedRevision)) return "expectedRevision";
	if (!isText$2(data.assessmentNotes, 5e3)) return "assessmentNotes";
	return null;
}
const emptyPoClaimLedger = () => ({
	seq: 0,
	openClaimIds: [],
	approvedPoLineCents: {},
	approvedVariationLineCents: {}
});
const isCents = (v) => Number.isSafeInteger(v) && v >= 0;
function storedPoClaimLedgerProblem(doc) {
	if (!doc) return null;
	if (doc.seq !== void 0 && !isCents(doc.seq)) return "The claim ledger sequence is malformed.";
	if (doc.openClaimIds !== void 0 && (!Array.isArray(doc.openClaimIds) || !doc.openClaimIds.every(isId$2))) return "The claim ledger open-claim list is malformed.";
	for (const field of ["approvedPoLineCents", "approvedVariationLineCents"]) if (doc[field] !== void 0 && (!isObject$2(doc[field]) || !Object.values(doc[field]).every(isCents))) return `The claim ledger figure ${field} is malformed.`;
	return null;
}
function readPoClaimLedger(doc) {
	const out = emptyPoClaimLedger();
	if (!doc) return out;
	out.seq = Number.isSafeInteger(doc.seq) ? doc.seq : 0;
	out.openClaimIds = Array.isArray(doc.openClaimIds) ? [...doc.openClaimIds] : [];
	out.approvedPoLineCents = { ...doc.approvedPoLineCents ?? {} };
	out.approvedVariationLineCents = { ...doc.approvedVariationLineCents ?? {} };
	if (doc.state === "inconsistent") {
		out.state = "inconsistent";
		out.problem = doc.problem ?? "The purchase order’s claim history is inconsistent.";
		out.problemKind = doc.problemKind ?? "malformed";
	}
	return out;
}
const variationLedgerKey = (variationId, lineIndex) => `${variationId}:${lineIndex}`;
function previouslyApprovedCents(ledger, line) {
	if (isVariationOriginLine(line)) return ledger.approvedVariationLineCents[variationLedgerKey(line.variationId, line.variationLineIndex)] ?? 0;
	return ledger.approvedPoLineCents[String(line.poLineIndex)] ?? 0;
}
function poClaimLedgerDocument(L) {
	return {
		seq: L.seq,
		openClaimIds: L.openClaimIds,
		approvedPoLineCents: L.approvedPoLineCents,
		approvedVariationLineCents: L.approvedVariationLineCents
	};
}
function poClaimLedgersFromHistory(claims) {
	const byPo = /* @__PURE__ */ new Map();
	const entry = (poId) => {
		if (!byPo.has(poId)) byPo.set(poId, {
			ledger: emptyPoClaimLedger(),
			problems: [],
			sources: {
				open: 0,
				approved: 0
			}
		});
		return byPo.get(poId);
	};
	for (const c of claims ?? []) {
		if (!c) continue;
		if (typeof c.poId !== "string" || c.poId === "") return { problem: `${c.claimNumber || c.id} names no purchase order.` };
		const open = CLAIM_OPEN_STATUSES.includes(c.status);
		const approved = CLAIM_APPROVED_STATUSES.includes(c.status);
		if (!open && !approved) continue;
		const e = entry(c.poId);
		if (open) {
			e.ledger.openClaimIds.push(c.id);
			e.sources.open += 1;
			continue;
		}
		e.sources.approved += 1;
		for (const li of Array.isArray(c.lineItems) ? c.lineItems : []) {
			const a = li?.approvedThisPeriod;
			if (a == null) continue;
			if (typeof a !== "number" || !isWholeCents(a) || a < 0) {
				e.problems.push(`${c.claimNumber || c.id} stores a certified amount that is not whole, non-negative cents.`);
				continue;
			}
			if (isVariationOriginLine(li)) {
				const idx = indexOrNull(li.variationLineIndex);
				if (idx === null) {
					e.problems.push(`${c.claimNumber || c.id} stores a variation line with no line index.`);
					continue;
				}
				const key = variationLedgerKey(li.variationId, idx);
				e.ledger.approvedVariationLineCents[key] = (e.ledger.approvedVariationLineCents[key] ?? 0) + toCents(a);
			} else {
				const idx = indexOrNull(li.poLineIndex);
				if (idx === null) {
					e.problems.push(`${c.claimNumber || c.id} stores a line with no purchase-order line.`);
					continue;
				}
				e.ledger.approvedPoLineCents[String(idx)] = (e.ledger.approvedPoLineCents[String(idx)] ?? 0) + toCents(a);
			}
		}
	}
	const ledgers = /* @__PURE__ */ new Map();
	for (const [poId, e] of byPo) {
		e.ledger.openClaimIds.sort();
		let problem = e.problems[0] ?? null;
		if (!problem && e.ledger.openClaimIds.length > 1) problem = `Several claims are open on this purchase order (${e.ledger.openClaimIds.length}); reject the extra ones before raising another.`;
		const problemKind = !problem ? null : e.problems.length > 0 ? "malformed" : "open-claims";
		ledgers.set(poId, {
			state: problem ? "inconsistent" : "established",
			problem,
			problemKind,
			ledger: e.ledger,
			sources: e.sources
		});
	}
	return { ledgers };
}
const CLAIM_PROBLEM = {
	PO_INVALID: "po-invalid",
	OPEN_CLAIM: "open-claim",
	LINES_INVALID: "lines-invalid",
	VARIATION_LINE: "variation-line",
	DRAFT_INVALID: "draft-invalid",
	OUT_OF_RANGE: "out-of-range",
	FIGURES: "figures-inconsistent",
	LEDGER: "ledger-inconsistent"
};
const problem$2 = (code, message, extra = {}) => ({
	problem: code,
	message,
	...extra
});
function derivedLine(line, ledger, claimedToDate, version) {
	const prevCents = previouslyApprovedCents(ledger, line);
	const toDate = version === CALC_VERSION.EXACT ? fromCents(roundToCents(claimedToDate)) : claimedToDate;
	const period = claimedThisPeriodFor(toDate, fromCents(prevCents), version);
	if (period === null) return null;
	return {
		...line,
		previouslyApproved: fromCents(prevCents),
		claimedToDate: toDate,
		claimedThisPeriod: period,
		approvedThisPeriod: null
	};
}
function buildClaimSourceLines({ requestLines, po, variations }) {
	const poLines = Array.isArray(po?.lineItems) ? po.lineItems : [];
	if (requestLines.filter((l) => l.variationId === null).length !== poLines.length) return problem$2(CLAIM_PROBLEM.LINES_INVALID, "A claim carries exactly one line for every purchase-order line.");
	const claimable = claimableNewScopeLines(variations.filter(Boolean), po);
	const lines = [];
	for (const [i, r] of requestLines.entries()) {
		if (r.variationId === null) {
			if (r.poLineIndex !== i) return problem$2(CLAIM_PROBLEM.LINES_INVALID, "Purchase-order lines must come first, in order.");
			lines.push(buildClaimLine(poLines[i], {
				poLineIndex: i,
				claimedToDate: r.claimedToDate,
				previouslyApproved: 0
			}));
			continue;
		}
		if (i < poLines.length) return problem$2(CLAIM_PROBLEM.LINES_INVALID, "Variation lines come after the purchase-order lines.");
		const row = claimable.find((c) => c.variationId === r.variationId && c.lineIndex === r.variationLineIndex);
		if (!row) {
			const variation = variations.find((v) => v?.id === r.variationId) ?? null;
			const issue = claimVariationLineIssue({
				variationId: r.variationId,
				variationLineIndex: r.variationLineIndex
			}, {
				variation,
				po,
				classify: classifyCommitmentLines
			});
			return problem$2(CLAIM_PROBLEM.VARIATION_LINE, `Line ${i + 1}: ${CLAIM_VARIATION_LINE_ISSUE_LABELS[issue] ?? "the variation line is not claimable new scope on this purchase order"}.`, { line: i });
		}
		lines.push(buildVariationClaimLine(row, {
			claimedToDate: r.claimedToDate,
			previouslyApproved: 0
		}));
	}
	return { lines };
}
function buildClaimDraft({ input, po, variations, ledger, uid, now, claimNumber, currency }) {
	if (!po || !CLAIMABLE_PO_STATUSES.includes(po.status)) return problem$2(CLAIM_PROBLEM.PO_INVALID, "Claims can only be raised against a sent purchase order.");
	if (ledger.state === "inconsistent") return problem$2(CLAIM_PROBLEM.LEDGER, ledger.problem);
	if (ledger.openClaimIds.length > 0) return problem$2(CLAIM_PROBLEM.OPEN_CLAIM, "This purchase order already has an open claim.", { openClaimIds: ledger.openClaimIds });
	const built = buildClaimSourceLines({
		requestLines: input.lines,
		po,
		variations
	});
	if (built.problem) return built;
	const version = CURRENT_CALC_VERSION;
	const lines = [];
	for (const [i, line] of built.lines.entries()) {
		const d = derivedLine(line, ledger, input.lines[i].claimedToDate, version);
		if (!d) return problem$2(CLAIM_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`);
		lines.push(d);
	}
	const draftError = validateClaimDraft({
		lineItems: lines,
		retention: input.retention,
		poId: po.id
	});
	if (draftError) return problem$2(CLAIM_PROBLEM.DRAFT_INVALID, draftError);
	const totals = claimTotalsFor(lines.map((l) => l.claimedThisPeriod), input.retention, version);
	if (!totals) return problem$2(CLAIM_PROBLEM.OUT_OF_RANGE, "The claim total is outside the supported range.");
	return { document: {
		claimNumber,
		status: CLAIM_STATUS.DRAFT,
		poId: po.id,
		poNumber: po.poNumber ?? null,
		supplierName: po.supplierName ?? "",
		supplierId: po.supplierId ?? null,
		claimRef: input.claimRef.trim(),
		periodEnding: input.periodEnding,
		variationId: null,
		variationLineCount: claimVariationLineCount(lines),
		lineItems: lines,
		retention: totals.retention,
		claimedSubtotal: totals.subtotal,
		claimedGst: totals.gst,
		claimedTotal: totals.total,
		approvedSubtotal: null,
		approvedGst: null,
		approvedTotal: null,
		notes: input.notes.trim(),
		assessmentNotes: "",
		currency,
		revision: 1,
		calcVersion: version,
		submittedAt: null,
		submittedBy: null,
		approvedAt: null,
		approvedBy: null,
		rejectedAt: null,
		rejectedBy: null,
		invoicedAt: null,
		...CLAIM_LINK_INITIAL,
		externalRefs: {},
		createdAt: now,
		createdBy: uid,
		updatedAt: now,
		updatedBy: uid
	} };
}
function buildClaimDraftUpdate({ input, live, ledger, uid, now }) {
	const stored = Array.isArray(live?.lineItems) ? live.lineItems : [];
	if (input.claimedToDate.length !== stored.length) return problem$2(CLAIM_PROBLEM.LINES_INVALID, `A claimed-to-date value is required for every claim line (expected ${stored.length}).`);
	if (ledger.state === "inconsistent") return problem$2(CLAIM_PROBLEM.LEDGER, ledger.problem);
	const identity = sourceLineIdentityError(stored, { poId: live.poId });
	if (identity) return problem$2(CLAIM_PROBLEM.LINES_INVALID, `${identity}. Reject this claim and raise it again.`);
	const version = CURRENT_CALC_VERSION;
	const lines = [];
	for (const [i, line] of stored.entries()) {
		const d = derivedLine(buildClaimLine(line, { claimedToDate: input.claimedToDate[i] }), ledger, input.claimedToDate[i], version);
		if (!d) return problem$2(CLAIM_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`);
		lines.push(d);
	}
	const draftError = validateClaimDraft({
		lineItems: lines,
		retention: input.retention,
		poId: live.poId
	});
	if (draftError) return problem$2(CLAIM_PROBLEM.DRAFT_INVALID, draftError);
	const totals = claimTotalsFor(lines.map((l) => l.claimedThisPeriod), input.retention, version);
	if (!totals) return problem$2(CLAIM_PROBLEM.OUT_OF_RANGE, "The claim total is outside the supported range.");
	return { update: {
		claimRef: input.claimRef.trim(),
		periodEnding: input.periodEnding,
		notes: input.notes.trim(),
		lineItems: lines,
		retention: totals.retention,
		claimedSubtotal: totals.subtotal,
		claimedGst: totals.gst,
		claimedTotal: totals.total,
		calcVersion: version,
		revision: (Number(live.revision) || 0) + 1,
		updatedAt: now,
		updatedBy: uid
	} };
}
function claimDraftAlreadyHolds(live, update) {
	if (![
		"claimRef",
		"periodEnding",
		"notes",
		"retention",
		"claimedSubtotal",
		"claimedGst",
		"claimedTotal",
		"calcVersion"
	].every((k) => live?.[k] === update[k])) return false;
	return JSON.stringify(live.lineItems) === JSON.stringify(update.lineItems);
}
function claimSubmittedSideProblem({ claim, po, variations, ledger }) {
	const version = calcVersionOf(claim);
	if (version === null) return problem$2(CLAIM_PROBLEM.FIGURES, "The claim carries an unknown calculation version.", { reason: "version" });
	const lines = Array.isArray(claim?.lineItems) ? claim.lineItems : [];
	if (lines.length === 0) return problem$2(CLAIM_PROBLEM.FIGURES, "The claim has no lines.", { reason: "lines" });
	const identity = sourceLineIdentityError(lines, { poId: claim.poId });
	if (identity) return problem$2(CLAIM_PROBLEM.FIGURES, identity, { reason: "identity" });
	const poLines = Array.isArray(po?.lineItems) ? po.lineItems : [];
	const claimable = claimableNewScopeLines((variations ?? []).filter(Boolean), po);
	let poSeen = 0;
	for (const [i, li] of lines.entries()) {
		const fail = (reason, message) => problem$2(CLAIM_PROBLEM.FIGURES, `Line ${i + 1} (${sourceLineLabel(li)}): ${message}`, {
			reason,
			line: i
		});
		if (isVariationOriginLine(li)) {
			const row = claimable.find((c) => c.variationId === li.variationId && c.lineIndex === li.variationLineIndex);
			if (!row) return fail("variation-line", "the variation line is not claimable new scope on this purchase order.");
			if (li.costCodeId !== row.costCodeId) return fail("cost-code", "the cost code is not the variation line’s.");
			if (toCents(li.variationLineTotal) !== toCents(row.amount)) return fail("ceiling", "the ceiling is not the variation line’s approved amount.");
		} else {
			if (li.poLineIndex !== poSeen || i !== poSeen) return fail("po-line", "purchase-order lines are not complete and in order.");
			const pl = poLines[li.poLineIndex];
			if (!pl) return fail("po-line", "the purchase order has no such line.");
			if (li.costCodeId !== pl.costCodeId) return fail("cost-code", "the cost code is not the purchase-order line’s.");
			poSeen += 1;
		}
		if (li.approvedThisPeriod != null) return fail("certified", "a certified amount is already present.");
		if (toCents(li.previouslyApproved) !== previouslyApprovedCents(ledger, li)) return fail("previously-approved", "the previously approved amount is not the purchase order’s certified total.");
		const period = claimedThisPeriodFor(li.claimedToDate, li.previouslyApproved, version);
		if (period === null || typeof li.claimedThisPeriod !== "number" || toCents(li.claimedThisPeriod) !== toCents(period) || li.claimedThisPeriod !== period) return fail("period", "the amount claimed this period is not claimed-to-date less previously approved.");
	}
	if (poSeen !== poLines.length) return problem$2(CLAIM_PROBLEM.FIGURES, "The claim does not carry every purchase-order line.", { reason: "po-line" });
	const totals = claimTotalsFor(lines.map((l) => l.claimedThisPeriod), claim.retention, version);
	if (!totals) return problem$2(CLAIM_PROBLEM.FIGURES, "The claim total is outside the supported range.", { reason: "range" });
	const same = (a, b) => typeof a === "number" && toCents(a) === toCents(b);
	if (!same(claim.retention, totals.retention) || !same(claim.claimedSubtotal, totals.subtotal) || !same(claim.claimedGst, totals.gst) || !same(claim.claimedTotal, totals.total)) return problem$2(CLAIM_PROBLEM.FIGURES, "The claim header is not the sum of its lines.", { reason: "header" });
	return null;
}
function buildClaimApproval({ claim, approvedAmounts, assessmentNotes, uid, now }) {
	const version = calcVersionOf(claim);
	const lines = claim.lineItems;
	if (approvedAmounts.length !== lines.length) return problem$2(CLAIM_PROBLEM.LINES_INVALID, `A certified amount is required for every claim line (expected ${lines.length}).`);
	for (const [i, a] of approvedAmounts.entries()) if (toCents(a) > toCents(lines[i].claimedThisPeriod)) return problem$2(CLAIM_PROBLEM.LINES_INVALID, `Line ${i + 1}: the certified amount cannot exceed the amount claimed.`);
	const certified = lines.map((li, i) => ({
		...li,
		approvedThisPeriod: fromCents(toCents(approvedAmounts[i]))
	}));
	const totals = claimTotalsFor(certified.map((l) => l.approvedThisPeriod), claim.retention, version);
	if (!totals) return problem$2(CLAIM_PROBLEM.OUT_OF_RANGE, "The certified total is outside the supported range.");
	return { update: {
		status: CLAIM_STATUS.APPROVED,
		lineItems: certified,
		approvedSubtotal: totals.subtotal,
		approvedGst: totals.gst,
		approvedTotal: totals.total,
		assessmentNotes: assessmentNotes.trim(),
		approvedAt: now,
		approvedBy: uid,
		...CLAIM_LINK_INITIAL,
		revision: (Number(claim.revision) || 0) + 1,
		updatedAt: now,
		updatedBy: uid
	} };
}
function applyClaimApproval(ledger, claimId, certifiedLines) {
	const next = {
		...ledger,
		seq: ledger.seq + 1,
		openClaimIds: ledger.openClaimIds.filter((id) => id !== claimId),
		approvedPoLineCents: { ...ledger.approvedPoLineCents },
		approvedVariationLineCents: { ...ledger.approvedVariationLineCents }
	};
	for (const li of certifiedLines) {
		const cents = toCents(li.approvedThisPeriod);
		if (isVariationOriginLine(li)) {
			const key = variationLedgerKey(li.variationId, li.variationLineIndex);
			next.approvedVariationLineCents[key] = (next.approvedVariationLineCents[key] ?? 0) + cents;
		} else {
			const key = String(li.poLineIndex);
			next.approvedPoLineCents[key] = (next.approvedPoLineCents[key] ?? 0) + cents;
		}
	}
	return next;
}
const applyClaimOpened = (ledger, claimId) => ({
	...ledger,
	seq: ledger.seq + 1,
	openClaimIds: [...ledger.openClaimIds.filter((id) => id !== claimId), claimId].sort()
});
const applyClaimClosed = (ledger, claimId) => ({
	...ledger,
	seq: ledger.seq + 1,
	openClaimIds: ledger.openClaimIds.filter((id) => id !== claimId)
});
function sameClaimApproval(claim, uid, approvedAmounts) {
	if (claim?.status !== CLAIM_STATUS.APPROVED || claim.approvedBy !== uid) return false;
	const lines = claim.lineItems ?? [];
	return lines.length === approvedAmounts.length && lines.every((l, i) => toCents(l.approvedThisPeriod) === toCents(approvedAmounts[i]));
}
const CLAIM_REJECTABLE_STATUSES = [
	CLAIM_STATUS.DRAFT,
	CLAIM_STATUS.SUBMITTED,
	CLAIM_STATUS.UNDER_REVIEW
];
const CLAIM_APPROVABLE_STATUSES = [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW];

//#endregion
//#region src/lib/supplierInvoices.js
const SI_STATUS = {
	DRAFT: "draft",
	RECEIVED: "received",
	UNDER_REVIEW: "under_review",
	APPROVED: "approved",
	DISPUTED: "disputed",
	POSTED: "posted",
	PAID: "paid",
	CANCELLED: "cancelled"
};
const SI_STATUS_LABELS = {
	[SI_STATUS.DRAFT]: "Draft",
	[SI_STATUS.RECEIVED]: "Received",
	[SI_STATUS.UNDER_REVIEW]: "Under Review",
	[SI_STATUS.APPROVED]: "Approved",
	[SI_STATUS.DISPUTED]: "Disputed",
	[SI_STATUS.POSTED]: "Posted",
	[SI_STATUS.PAID]: "Paid",
	[SI_STATUS.CANCELLED]: "Cancelled"
};
const SI_BADGE_VARIANTS = {
	[SI_STATUS.DRAFT]: "soon",
	[SI_STATUS.RECEIVED]: "info",
	[SI_STATUS.UNDER_REVIEW]: "pending",
	[SI_STATUS.APPROVED]: "info",
	[SI_STATUS.DISPUTED]: "danger",
	[SI_STATUS.POSTED]: "active",
	[SI_STATUS.PAID]: "completed",
	[SI_STATUS.CANCELLED]: "danger"
};
const SI_TRANSITIONS = {
	[SI_STATUS.DRAFT]: [SI_STATUS.APPROVED, SI_STATUS.CANCELLED],
	[SI_STATUS.RECEIVED]: [],
	[SI_STATUS.UNDER_REVIEW]: [],
	[SI_STATUS.APPROVED]: [SI_STATUS.POSTED, SI_STATUS.CANCELLED],
	[SI_STATUS.DISPUTED]: [],
	[SI_STATUS.POSTED]: [],
	[SI_STATUS.PAID]: [],
	[SI_STATUS.CANCELLED]: []
};
const canTransition$1 = (from, to) => (SI_TRANSITIONS[from] ?? []).includes(to);
const SI_COUNTING_STATUSES = [SI_STATUS.POSTED, SI_STATUS.PAID];
const SI_EDITABLE_STATUSES = [SI_STATUS.DRAFT];
const SI_SOURCE = {
	PROGRESS_CLAIM: "progress_claim",
	DIRECT_PO: "direct_po"
};
const SI_DOC_TYPE = {
	INVOICE: "invoice",
	CREDIT_NOTE: "credit_note"
};
const INVOICEABLE_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED];
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
function gstForLine(amount, taxCode) {
	const amt = Number(amount) || 0;
	return taxCode === TAX_CODE.GST ? roundMoney(amt * GST_RATE) : 0;
}
function gstForLineFor(amount, taxCode, version = CALC_VERSION.LEGACY) {
	if (version === CALC_VERSION.LEGACY) return gstForLine(amount, taxCode);
	if (version !== CALC_VERSION.EXACT) return null;
	if (taxCode !== TAX_CODE.GST) return 0;
	return gstOnAmount(amount, CALC_VERSION.EXACT);
}
const formatSupplierInvoiceNumber = (n) => `SI-${String(n).padStart(4, "0")}`;
function invoiceTotals(lineItems, retention = 0) {
	const subtotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
	const gstTotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0));
	const grossTotal = roundMoney(subtotal + gstTotal);
	const retained = Math.min(roundMoney(Number(retention) || 0), subtotal);
	const retentionGst = roundMoney(retained * GST_RATE);
	const retentionTotal = roundMoney(retained + retentionGst);
	return {
		subtotal,
		gstTotal,
		grossTotal,
		retention: retained,
		retentionGst,
		retentionTotal,
		net: roundMoney(subtotal - retained),
		payableGst: roundMoney(gstTotal - retentionGst),
		payableTotal: roundMoney(grossTotal - retentionTotal)
	};
}
function invoiceTotalsFor(lineItems, retention = 0, version = CALC_VERSION.LEGACY) {
	if (version === CALC_VERSION.LEGACY) return invoiceTotals(lineItems, retention);
	if (version !== CALC_VERSION.EXACT) return null;
	let subtotalCents = 0;
	let gstCents = 0;
	for (const li of lineItems ?? []) {
		const a = roundToCents(Number(li?.amount) || 0);
		const g = roundToCents(Number(li?.gstAmount) || 0);
		if (a === null || g === null) return null;
		subtotalCents += a;
		gstCents += g;
	}
	const retentionInput = roundToCents(Number(retention) || 0);
	if (retentionInput === null) return null;
	const retainedCents = Math.min(retentionInput, subtotalCents);
	const retentionGstCents = gstOfCents(retainedCents);
	const grossCents = subtotalCents + gstCents;
	const c = fromCents;
	return {
		subtotal: c(subtotalCents),
		gstTotal: c(gstCents),
		grossTotal: c(grossCents),
		retention: c(retainedCents),
		retentionGst: c(retentionGstCents),
		retentionTotal: c(retainedCents + retentionGstCents),
		net: c(subtotalCents - retainedCents),
		payableGst: c(gstCents - retentionGstCents),
		payableTotal: c(grossCents - retainedCents - retentionGstCents)
	};
}
function allocateGstCents(amountCents, targetCents) {
	if (!Array.isArray(amountCents) || !Number.isInteger(targetCents) || targetCents < 0) return null;
	const n = amountCents.length;
	const out = new Array(n).fill(0);
	const taxable = [];
	let exactTenths = 0;
	for (let i = 0; i < n; i++) {
		const c = amountCents[i];
		if (c === null || c === void 0) continue;
		if (!Number.isInteger(c) || c < 0) return null;
		if (c === 0) continue;
		exactTenths += c;
		out[i] = Math.trunc(c / 10);
		taxable.push({
			i,
			r: c % 10
		});
	}
	if (taxable.length === 0) return targetCents === 0 ? out : null;
	if (Math.abs(targetCents * 10 - exactTenths) > 20) return null;
	let residual = targetCents - out.reduce((s, v) => s + v, 0);
	const give = [...taxable].sort((a, b) => b.r - a.r || a.i - b.i);
	const take = [...taxable].sort((a, b) => a.r - b.r || a.i - b.i);
	while (residual > 0) for (const { i } of give) {
		if (residual === 0) break;
		out[i] += 1;
		residual -= 1;
	}
	while (residual < 0) {
		let moved = false;
		for (const { i } of take) {
			if (residual === 0) break;
			if (out[i] > 0) {
				out[i] -= 1;
				residual += 1;
				moved = true;
			}
		}
		if (!moved) return null;
	}
	return out;
}
function buildInvoiceLine(source, { amount, taxCode, poLineIndex, gstFromUnroundedAmount = false } = {}) {
	const src = source && typeof source === "object" ? source : {};
	const str = (v) => typeof v === "string" ? v : "";
	const num = (v) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	};
	const variationOrigin = isVariationOriginLine(src);
	const idx = variationOrigin ? null : indexOrNull(poLineIndex ?? src.poLineIndex);
	const raw = num(amount);
	const amt = roundMoney(raw);
	const tc = typeof taxCode === "string" ? taxCode : "";
	return {
		...variationOrigin ? {
			poLineIndex: null,
			variationId: src.variationId,
			variationNumber: str(src.variationNumber),
			variationLineIndex: indexOrNull(src.variationLineIndex)
		} : { poLineIndex: idx },
		costCodeId: str(src.costCodeId),
		costCodeName: str(src.costCodeName),
		description: str(src.description),
		amount: amt,
		taxCode: tc,
		gstAmount: gstForLine(gstFromUnroundedAmount ? raw : amt, tc)
	};
}
const invoiceVariationLineCount = (lineItems) => variationLineCountOf(lineItems);
function retentionFloorError(retention) {
	const retained = Number(retention);
	if (!Number.isFinite(retained)) return "Retention must be a number";
	if (retained < 0) return "Retention cannot be negative";
	return null;
}
function validateInvoiceDraft({ lineItems, supplierInvoiceNumber, invoiceDate, retention = 0, authoredLines = true } = {}) {
	const lines = Array.isArray(lineItems) ? lineItems : [];
	if (lines.length === 0) return "A supplier invoice needs at least one line";
	if (!String(supplierInvoiceNumber ?? "").trim()) return "The supplier's invoice number is required";
	if (!String(invoiceDate ?? "").trim()) return "An invoice date is required";
	if (authoredLines) {
		const badTax = lines.findIndex((li) => !TAX_CODES.includes(li?.taxCode));
		if (badTax !== -1) return `Line ${badTax + 1}: choose a tax code (${TAX_CODE_LABELS[TAX_CODE.GST]}, ${TAX_CODE_LABELS[TAX_CODE.GST_FREE]} or ${TAX_CODE_LABELS[TAX_CODE.INPUT_TAXED]})`;
		const retentionError = retentionFloorError(retention);
		if (retentionError) return retentionError;
	}
	if (!lines.some((li) => (Number(li?.amount) || 0) > 0)) return "A supplier invoice must carry an amount on at least one line";
	return null;
}

//#endregion
//#region src/lib/supplierInvoiceProcessing.js
const INVOICE_PROCESSING_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const INVOICE_COUNTER_ID = "supplierInvoices";
const INVOICE_TEXT_MAX = 200;
const INVOICE_NOTES_MAX = 5e3;
const INVOICE_MAX_LINES = 200;
const isObject$1 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys$1 = (data, keys) => isObject$1(data) && Object.keys(data).length === keys.length && keys.every((k) => k in data);
const isId$1 = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const isRevision$1 = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const DATE_RE$1 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isDate$1 = (v) => typeof v === "string" && DATE_RE$1.test(v);
const isDateOrEmpty = (v) => typeof v === "string" && (v === "" || DATE_RE$1.test(v));
const isText$1 = (v, max) => typeof v === "string" && v.length <= max;
const isAmount = (v) => typeof v === "number" && Number.isFinite(v) && roundToCents(v) !== null;
const CREATE_INVOICE_KEYS = [
	"projectId",
	"invoiceId",
	"source",
	"sourceId",
	"expectedSourceRevision",
	"supplierInvoiceNumber",
	"invoiceDate",
	"receivedDate",
	"dueDate",
	"notes",
	"retention",
	"lines"
];
const INVOICE_LINE_KEYS = [
	"lineIndex",
	"amount",
	"taxCode"
];
const UPDATE_INVOICE_KEYS = [
	"projectId",
	"invoiceId",
	"expectedRevision",
	"supplierInvoiceNumber",
	"invoiceDate",
	"receivedDate",
	"dueDate",
	"notes",
	"retention",
	"lines"
];
const INVOICE_TRANSITION_KEYS = [
	"projectId",
	"invoiceId",
	"expectedRevision"
];
const LINK_INVOICE_KEYS = [
	"projectId",
	"claimId",
	"invoiceId",
	"expectedClaimRevision"
];
function headerProblem(d) {
	if (!isText$1(d.supplierInvoiceNumber, 200) || d.supplierInvoiceNumber.trim() === "") return "supplierInvoiceNumber";
	if (!isDate$1(d.invoiceDate)) return "invoiceDate";
	if (!isDateOrEmpty(d.receivedDate) || !isDateOrEmpty(d.dueDate)) return "dates";
	if (!isText$1(d.notes, 5e3)) return "notes";
	return null;
}
function linesProblem(lines, claimSourced) {
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > 200) return "lines";
	const seen = /* @__PURE__ */ new Set();
	for (const l of lines) {
		if (!exactKeys$1(l, INVOICE_LINE_KEYS) || !TAX_CODES.includes(l.taxCode)) return "line";
		if (!Number.isInteger(l.lineIndex) || l.lineIndex < 0 || l.lineIndex >= 200 || seen.has(l.lineIndex)) return "line-index";
		seen.add(l.lineIndex);
		if (claimSourced ? l.amount !== null : !isAmount(l.amount) || !isWholeCents(l.amount) || l.amount < 0) return "line-amount";
	}
	return null;
}
function createInvoiceRequestProblem(d) {
	if (!exactKeys$1(d, CREATE_INVOICE_KEYS)) return "keys";
	if (!isId$1(d.projectId) || !isId$1(d.invoiceId) || !isId$1(d.sourceId)) return "ids";
	const claimSourced = d.source === SI_SOURCE.PROGRESS_CLAIM;
	if (!claimSourced && d.source !== SI_SOURCE.DIRECT_PO) return "source";
	if (claimSourced ? !isRevision$1(d.expectedSourceRevision) : d.expectedSourceRevision !== null) return "expectedSourceRevision";
	if (claimSourced ? d.retention !== null : !isAmount(d.retention) || d.retention < 0 || !isWholeCents(d.retention)) return "retention";
	return headerProblem(d) ?? linesProblem(d.lines, claimSourced);
}
function updateInvoiceRequestProblem(d) {
	if (!exactKeys$1(d, UPDATE_INVOICE_KEYS)) return "keys";
	if (!isId$1(d.projectId) || !isId$1(d.invoiceId)) return "ids";
	if (!isRevision$1(d.expectedRevision)) return "expectedRevision";
	const header = headerProblem(d);
	if (header) return header;
	if (d.lines === null) return d.retention === null ? null : "retention";
	if (!isAmount(d.retention) || d.retention < 0 || !isWholeCents(d.retention)) return "retention";
	return linesProblem(d.lines, false);
}
function invoiceTransitionRequestProblem(d) {
	if (!exactKeys$1(d, INVOICE_TRANSITION_KEYS)) return "keys";
	if (!isId$1(d.projectId) || !isId$1(d.invoiceId)) return "ids";
	return isRevision$1(d.expectedRevision) ? null : "expectedRevision";
}
function linkInvoiceRequestProblem(d) {
	if (!exactKeys$1(d, LINK_INVOICE_KEYS)) return "keys";
	if (!isId$1(d.projectId) || !isId$1(d.claimId) || !isId$1(d.invoiceId)) return "ids";
	return isRevision$1(d.expectedClaimRevision) ? null : "expectedClaimRevision";
}
const INVOICE_PROBLEM = {
	PO_INVALID: "po-invalid",
	CLAIM_INVALID: "claim-invalid",
	CLAIM_STALE: "claim-stale",
	ALREADY_INVOICED: "already-invoiced",
	LEGACY_CLAIM: "legacy-claim",
	LINES_INVALID: "lines-invalid",
	DRAFT_INVALID: "draft-invalid",
	NOT_RECONCILED: "not-reconciled",
	OUT_OF_RANGE: "out-of-range",
	FIGURES: "figures-inconsistent",
	NOT_LINKED: "not-linked"
};
const problem$1 = (code, message, extra = {}) => ({
	problem: code,
	message,
	...extra
});
function apportionClaimSourcedGst(lines, { certifiedGst, retention, version }) {
	const totals = invoiceTotalsFor(lines.map((l) => ({
		...l,
		gstAmount: 0
	})), retention, version);
	if (!totals) return null;
	const target = toCents(certifiedGst) + toCents(totals.retentionGst);
	const allocated = allocateGstCents(lines.map((li) => li.taxCode === TAX_CODE.GST && toCents(li.amount) > 0 ? toCents(li.amount) : null), target);
	if (!allocated) return null;
	return lines.map((li, i) => ({
		...li,
		gstAmount: fromCents(allocated[i])
	}));
}
function directLines(po, requestLines, version) {
	const poLines = Array.isArray(po?.lineItems) ? po.lineItems : [];
	const lines = [];
	for (const r of [...requestLines].sort((a, b) => a.lineIndex - b.lineIndex)) {
		const i = r.lineIndex;
		if (!poLines[i]) return problem$1(INVOICE_PROBLEM.LINES_INVALID, `Purchase-order line ${i + 1} does not exist.`);
		const amount = fromCents(roundToCents(r.amount));
		if (amount === 0) continue;
		const line = buildInvoiceLine(poLines[i], {
			poLineIndex: i,
			amount,
			taxCode: r.taxCode
		});
		const gst = gstForLineFor(amount, r.taxCode, version);
		if (gst === null) return problem$1(INVOICE_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`);
		lines.push({
			...line,
			gstAmount: gst
		});
	}
	return { lines };
}
function documentBase({ invoiceNumber, source, po, claim, header, lines, totals, version, sourceVersion, currency, paymentTerms, uid, now }) {
	return {
		invoiceNumber,
		supplierInvoiceNumber: header.supplierInvoiceNumber.trim(),
		status: SI_STATUS.DRAFT,
		docType: SI_DOC_TYPE.INVOICE,
		source,
		supplierId: (claim ?? po)?.supplierId ?? null,
		supplierName: String((claim ?? po)?.supplierName ?? "").trim(),
		poId: claim ? claim.poId : po.id,
		poNumber: claim ? claim.poNumber ?? null : po.poNumber ?? null,
		progressClaimId: claim ? claim.id : null,
		claimNumber: claim ? claim.claimNumber ?? null : null,
		variationLineCount: invoiceVariationLineCount(lines),
		invoiceDate: header.invoiceDate,
		receivedDate: header.receivedDate,
		dueDate: header.dueDate,
		paymentTerms: paymentTerms ?? null,
		lineItems: lines,
		retention: totals.retention,
		retentionGst: totals.retentionGst,
		retentionTotal: totals.retentionTotal,
		subtotal: totals.subtotal,
		gstTotal: totals.gstTotal,
		grossTotal: totals.grossTotal,
		net: totals.net,
		payableGst: totals.payableGst,
		payableTotal: totals.payableTotal,
		currency,
		revision: 1,
		calcVersion: version,
		sourceCalcVersion: sourceVersion,
		notes: header.notes.trim(),
		approvedAt: null,
		approvedBy: null,
		postedAt: null,
		postedBy: null,
		cancelledAt: null,
		cancelledBy: null,
		paidAt: null,
		adjustsInvoiceId: null,
		attachments: [],
		externalRefs: {},
		createdAt: now,
		createdBy: uid,
		updatedAt: now,
		updatedBy: uid
	};
}
function buildDirectInvoice({ input, po, invoiceNumber, currency, paymentTerms, uid, now }) {
	if (!po || !INVOICEABLE_PO_STATUSES.includes(po.status)) return problem$1(INVOICE_PROBLEM.PO_INVALID, "Invoices can only be raised against a sent or closed purchase order.");
	const version = CURRENT_CALC_VERSION;
	const built = directLines(po, input.lines, version);
	if (built.problem) return built;
	const draftError = validateInvoiceDraft({
		lineItems: built.lines,
		supplierInvoiceNumber: input.supplierInvoiceNumber,
		invoiceDate: input.invoiceDate,
		retention: input.retention
	});
	if (draftError) return problem$1(INVOICE_PROBLEM.DRAFT_INVALID, draftError);
	const totals = invoiceTotalsFor(built.lines, input.retention, version);
	if (!totals) return problem$1(INVOICE_PROBLEM.OUT_OF_RANGE, "The invoice total is outside the supported range.");
	return { document: documentBase({
		invoiceNumber,
		source: SI_SOURCE.DIRECT_PO,
		po,
		claim: null,
		header: input,
		lines: built.lines,
		totals,
		version,
		sourceVersion: null,
		currency,
		paymentTerms,
		uid,
		now
	}) };
}
function claimInvoicePairingProblem(claim, expectedRevision) {
	if (!claim) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, "This progress claim no longer exists.");
	const name = claim.claimNumber || "This progress claim";
	if (claim.status !== CLAIM_STATUS.APPROVED) return problem$1(INVOICE_PROBLEM.CLAIM_STALE, `${name} is not approved.`);
	const link = claimInvoiceLink(claim);
	if (link.state === CLAIM_INVOICE_LINK.LINKED) return problem$1(INVOICE_PROBLEM.ALREADY_INVOICED, `${name} already has a supplier invoice.`, { linkedInvoiceId: link.invoiceId });
	if (link.state === CLAIM_INVOICE_LINK.LEGACY) return problem$1(INVOICE_PROBLEM.LEGACY_CLAIM, `${name} was approved before invoice pairing and must be reconciled first.`);
	if (link.state !== CLAIM_INVOICE_LINK.UNLINKED) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${name} carries a malformed invoice link.`);
	if ((Number(claim.revision) || 0) !== expectedRevision) return problem$1(INVOICE_PROBLEM.CLAIM_STALE, `${name} changed since you loaded it. Review the latest version and retry.`);
	if (calcVersionOf(claim) === null) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${name} carries an unknown calculation version.`);
	return null;
}
function claimLines(claim, requestLines, version) {
	const source = Array.isArray(claim?.lineItems) ? claim.lineItems : [];
	const taxByIndex = new Map(requestLines.map((r) => [r.lineIndex, r.taxCode]));
	const lines = [];
	for (const [i, li] of source.entries()) {
		const amount = Number(li?.approvedThisPeriod);
		if (!Number.isFinite(amount) || !isWholeCents(amount) || amount < 0) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `Claim line ${i + 1} stores a certified amount that is not whole cents.`);
		if (amount === 0) {
			if (taxByIndex.has(i)) return problem$1(INVOICE_PROBLEM.LINES_INVALID, `Claim line ${i + 1} was certified at zero and is not invoiced.`);
			continue;
		}
		if (!taxByIndex.has(i)) return problem$1(INVOICE_PROBLEM.LINES_INVALID, `A tax code is required for every certified claim line (line ${i + 1}).`);
		const taxCode = taxByIndex.get(i);
		taxByIndex.delete(i);
		const line = buildInvoiceLine(li, {
			amount,
			taxCode
		});
		lines.push({
			...line,
			gstAmount: gstForLineFor(amount, taxCode, version) ?? 0
		});
	}
	if (taxByIndex.size > 0) return problem$1(INVOICE_PROBLEM.LINES_INVALID, "A line names no claim line.");
	return { lines };
}
function buildClaimSourcedInvoice({ input, claim, invoiceNumber, currency, paymentTerms, uid, now }) {
	const pairing = claimInvoicePairingProblem(claim, input.expectedSourceRevision);
	if (pairing) return pairing;
	const version = calcVersionOf(claim);
	const built = claimLines(claim, input.lines, version);
	if (built.problem) return built;
	const identity = sourceLineIdentityError(built.lines, { poId: claim.poId });
	if (identity) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, identity);
	const retention = Number(claim.retention) || 0;
	const lines = apportionClaimSourcedGst(built.lines, {
		certifiedGst: claim.approvedGst,
		retention,
		version
	});
	if (!lines) return problem$1(INVOICE_PROBLEM.NOT_RECONCILED, "The certified claim GST cannot be apportioned across these lines — check the tax codes (at least the GST-bearing lines must carry GST).");
	const draftError = validateInvoiceDraft({
		lineItems: lines,
		supplierInvoiceNumber: input.supplierInvoiceNumber,
		invoiceDate: input.invoiceDate,
		retention,
		authoredLines: false
	});
	if (draftError) return problem$1(INVOICE_PROBLEM.DRAFT_INVALID, draftError);
	const totals = invoiceTotalsFor(lines, retention, version);
	if (!totals) return problem$1(INVOICE_PROBLEM.OUT_OF_RANGE, "The invoice total is outside the supported range.");
	if (toCents(totals.payableGst) !== toCents(claim.approvedGst) || toCents(totals.payableTotal) !== toCents(claim.approvedTotal)) return problem$1(INVOICE_PROBLEM.NOT_RECONCILED, `The invoice does not reconcile to ${claim.claimNumber || "the claim"}’s certified GST and total.`);
	const sourceVersion = claim.calcVersion == null ? null : version;
	return { document: documentBase({
		invoiceNumber,
		source: SI_SOURCE.PROGRESS_CLAIM,
		po: null,
		claim,
		header: input,
		lines,
		totals,
		version,
		sourceVersion,
		currency,
		paymentTerms,
		uid,
		now
	}) };
}
function buildInvoiceDraftUpdate({ input, live, po, uid, now }) {
	const header = {
		supplierInvoiceNumber: input.supplierInvoiceNumber.trim(),
		invoiceDate: input.invoiceDate,
		receivedDate: input.receivedDate,
		dueDate: input.dueDate,
		notes: input.notes.trim()
	};
	const stamp = {
		revision: (Number(live.revision) || 0) + 1,
		updatedAt: now,
		updatedBy: uid
	};
	if (live.source === SI_SOURCE.PROGRESS_CLAIM) {
		if (input.lines !== null) return problem$1(INVOICE_PROBLEM.LINES_INVALID, "A claim-sourced invoice’s lines and retention are the claim’s certified figures and cannot be edited.");
		return { update: {
			...header,
			...stamp
		} };
	}
	if (input.lines === null) return problem$1(INVOICE_PROBLEM.LINES_INVALID, "A direct invoice draft edit carries one amount and tax code per stored line.");
	const stored = Array.isArray(live.lineItems) ? live.lineItems : [];
	if (input.lines.length !== stored.length) return problem$1(INVOICE_PROBLEM.LINES_INVALID, `One amount and tax code per stored line is required (expected ${stored.length}).`);
	if (stored.some(isVariationOriginLine)) return problem$1(INVOICE_PROBLEM.LINES_INVALID, "A direct invoice cannot carry variation lines.");
	const poLines = Array.isArray(po?.lineItems) ? po.lineItems : [];
	const version = CURRENT_CALC_VERSION;
	const lines = [];
	for (const [i, li] of stored.entries()) {
		if (input.lines[i].lineIndex !== i) return problem$1(INVOICE_PROBLEM.LINES_INVALID, "One amount and tax code per stored line, in stored order.");
		const pl = poLines[li?.poLineIndex];
		if (!pl || pl.costCodeId !== li.costCodeId) return problem$1(INVOICE_PROBLEM.LINES_INVALID, `Line ${i + 1} no longer matches its purchase-order line.`);
		const amount = fromCents(roundToCents(input.lines[i].amount));
		const gst = gstForLineFor(amount, input.lines[i].taxCode, version);
		if (gst === null) return problem$1(INVOICE_PROBLEM.OUT_OF_RANGE, `Line ${i + 1}: the amount is outside the supported range.`);
		lines.push({
			...buildInvoiceLine(li, {
				amount,
				taxCode: input.lines[i].taxCode
			}),
			gstAmount: gst
		});
	}
	const draftError = validateInvoiceDraft({
		lineItems: lines,
		supplierInvoiceNumber: input.supplierInvoiceNumber,
		invoiceDate: input.invoiceDate,
		retention: input.retention
	});
	if (draftError) return problem$1(INVOICE_PROBLEM.DRAFT_INVALID, draftError);
	const totals = invoiceTotalsFor(lines, input.retention, version);
	if (!totals) return problem$1(INVOICE_PROBLEM.OUT_OF_RANGE, "The invoice total is outside the supported range.");
	return { update: {
		...header,
		lineItems: lines,
		retention: totals.retention,
		retentionGst: totals.retentionGst,
		retentionTotal: totals.retentionTotal,
		subtotal: totals.subtotal,
		gstTotal: totals.gstTotal,
		grossTotal: totals.grossTotal,
		net: totals.net,
		payableGst: totals.payableGst,
		payableTotal: totals.payableTotal,
		calcVersion: version,
		sourceCalcVersion: null,
		...stamp
	} };
}
function invoiceDraftAlreadyHolds(live, update) {
	for (const [k, v] of Object.entries(update)) {
		if (k === "revision" || k === "updatedAt" || k === "updatedBy") continue;
		if (JSON.stringify(live?.[k] ?? null) !== JSON.stringify(v)) return false;
	}
	return true;
}
const legacyGstSet = (amount, taxCode) => {
	const out = new Set([toCents(gstForLine(amount, taxCode))]);
	for (const d of [-.0049, .0049]) out.add(toCents(gstForLine(amount + d, taxCode)));
	return out;
};
const HEADER_KEYS = [
	"subtotal",
	"gstTotal",
	"grossTotal",
	"retention",
	"retentionGst",
	"retentionTotal",
	"net",
	"payableGst",
	"payableTotal"
];
function invoiceStoredProblem({ invoice, po, claim }) {
	const version = calcVersionOf(invoice);
	const fail = (reason, message, extra = {}) => problem$1(INVOICE_PROBLEM.FIGURES, message, {
		reason,
		...extra
	});
	if (version === null) return fail("version", "The invoice carries an unknown calculation version.");
	const lines = Array.isArray(invoice?.lineItems) ? invoice.lineItems : [];
	if (lines.length === 0) return fail("lines", "The invoice has no lines.");
	const identity = sourceLineIdentityError(lines, { poId: invoice.poId });
	if (identity) return fail("identity", identity);
	for (const [i, li] of lines.entries()) {
		if (!TAX_CODES.includes(li?.taxCode)) return fail("tax-code", `Line ${i + 1} carries no valid tax code.`, { line: i });
		if (typeof li.amount !== "number" || !isWholeCents(li.amount) || typeof li.gstAmount !== "number" || !isWholeCents(li.gstAmount)) return fail("line-amount", `Line ${i + 1} stores an amount or GST that is not whole cents.`, { line: i });
	}
	if (invoice.source === SI_SOURCE.PROGRESS_CLAIM) {
		if (!claim || claim.id !== invoice.progressClaimId || claim.status !== CLAIM_STATUS.APPROVED) return fail("claim", "The invoice’s progress claim is not an approved claim of this project.");
		if (claim.poId !== invoice.poId || (claim.supplierId ?? null) !== (invoice.supplierId ?? null)) return fail("claim", "The invoice names another purchase order or supplier than its claim.");
		const certified = (claim.lineItems ?? []).filter((l) => toCents(l?.approvedThisPeriod) > 0);
		if (certified.length !== lines.length) return fail("claim-lines", "The invoice lines are not the claim’s certified lines.");
		for (const [i, li] of lines.entries()) {
			const cl = certified[i];
			if (!(isVariationOriginLine(cl) ? li.variationId === cl.variationId && li.variationLineIndex === cl.variationLineIndex : li.poLineIndex === cl.poLineIndex) || li.costCodeId !== cl.costCodeId || toCents(li.amount) !== toCents(cl.approvedThisPeriod)) return fail("claim-lines", `Line ${i + 1} is not the claim’s certified line.`, { line: i });
			if (li.taxCode !== TAX_CODE.GST && toCents(li.gstAmount) !== 0) return fail("line-gst", `Line ${i + 1} carries GST on a ${li.taxCode} line.`, { line: i });
			if (toCents(li.gstAmount) < 0) return fail("line-gst", `Line ${i + 1} carries negative GST.`, { line: i });
		}
		if (toCents(invoice.payableGst) !== toCents(claim.approvedGst) || toCents(invoice.payableTotal) !== toCents(claim.approvedTotal)) return fail("claim-totals", "The invoice’s payable GST and total are not the claim’s certified figures.");
		if (toCents(invoice.retention) !== Math.min(toCents(claim.retention), toCents(invoice.subtotal))) return fail("retention", "The invoice retention is not the claim’s.");
	} else {
		if (invoice.source !== SI_SOURCE.DIRECT_PO) return fail("source", "The invoice has no supported source.");
		const poLines = Array.isArray(po?.lineItems) ? po.lineItems : [];
		if (!po || po.id !== invoice.poId) return fail("po", "The invoice’s purchase order is not in this project.");
		for (const [i, li] of lines.entries()) {
			if (isVariationOriginLine(li)) return fail("identity", "A direct invoice cannot carry a variation line.", { line: i });
			const pl = poLines[li.poLineIndex];
			if (!pl || pl.costCodeId !== li.costCodeId) return fail("po-line", `Line ${i + 1} does not match its purchase-order line.`, { line: i });
			if (!(version === CALC_VERSION.LEGACY ? legacyGstSet(li.amount, li.taxCode).has(toCents(li.gstAmount)) : toCents(li.gstAmount) === toCents(gstForLineFor(li.amount, li.taxCode, version)))) return fail("line-gst", `Line ${i + 1} carries GST that is not its tax code’s.`, { line: i });
		}
	}
	const totals = invoiceTotalsFor(lines, invoice.retention, version);
	if (!totals) return fail("range", "The invoice total is outside the supported range.");
	for (const key of HEADER_KEYS) if (typeof invoice[key] !== "number" || toCents(invoice[key]) !== toCents(totals[key])) return fail("header", `The invoice ${key} is not the total of its lines.`);
	return null;
}
const INVOICE_TRANSITION = {
	approve: {
		from: [SI_STATUS.DRAFT],
		to: SI_STATUS.APPROVED,
		at: "approvedAt",
		by: "approvedBy"
	},
	post: {
		from: [SI_STATUS.APPROVED],
		to: SI_STATUS.POSTED,
		at: "postedAt",
		by: "postedBy"
	},
	cancel: {
		from: [SI_STATUS.DRAFT, SI_STATUS.APPROVED],
		to: SI_STATUS.CANCELLED,
		at: "cancelledAt",
		by: "cancelledBy"
	}
};
function postPairingProblem(invoice, claim) {
	if (invoice.source !== SI_SOURCE.PROGRESS_CLAIM) return null;
	const link = claimInvoiceLink(claim);
	if (link.state !== CLAIM_INVOICE_LINK.LINKED || link.invoiceId !== invoice.id) return problem$1(INVOICE_PROBLEM.NOT_LINKED, `${claim?.claimNumber || "The claim"} does not link this invoice — link it on the Progress Claims tab before posting.`);
	return null;
}
function existingLinkProblem(claim, invoice) {
	if (!claim) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, "This progress claim no longer exists.");
	if (!invoice) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, "The supplier invoice no longer exists.");
	const name = claim.claimNumber || "This progress claim";
	if (claim.status !== CLAIM_STATUS.APPROVED) return problem$1(INVOICE_PROBLEM.CLAIM_STALE, `${name} is not approved.`);
	const link = claimInvoiceLink(claim);
	if (link.state === CLAIM_INVOICE_LINK.LINKED) return problem$1(INVOICE_PROBLEM.ALREADY_INVOICED, `${name} is already linked to a supplier invoice.`, { linkedInvoiceId: link.invoiceId });
	if (link.state !== CLAIM_INVOICE_LINK.LEGACY && link.state !== CLAIM_INVOICE_LINK.UNLINKED) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${name} carries a malformed invoice link.`);
	const n = invoice.invoiceNumber || "The invoice";
	if (invoice.source !== SI_SOURCE.PROGRESS_CLAIM) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${n} is not a claim-sourced invoice.`);
	if (invoice.progressClaimId !== claim.id) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${n} does not reference ${name}.`);
	if (invoice.poId !== claim.poId || (invoice.supplierId ?? null) !== (claim.supplierId ?? null)) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${n} names another purchase order or supplier than ${name}.`);
	if (![
		SI_STATUS.DRAFT,
		SI_STATUS.APPROVED,
		SI_STATUS.POSTED
	].includes(invoice.status)) return problem$1(INVOICE_PROBLEM.CLAIM_INVALID, `${n} is ${invoice.status} and reserves nothing.`);
	return null;
}
const certifiedClaimGst = (amounts, retention, version) => claimTotalsFor(amounts, retention, version)?.gst ?? null;

//#endregion
//#region src/lib/supplierCreditNotes.js
const SCN_STATUS = {
	DRAFT: "draft",
	POSTED: "posted",
	VOID: "void"
};
const SCN_STATUS_LABELS = {
	[SCN_STATUS.DRAFT]: "Draft",
	[SCN_STATUS.POSTED]: "Posted",
	[SCN_STATUS.VOID]: "Void"
};
const SCN_BADGE_VARIANTS = {
	[SCN_STATUS.DRAFT]: "soon",
	[SCN_STATUS.POSTED]: "active",
	[SCN_STATUS.VOID]: "danger"
};
const SCN_TRANSITIONS = {
	[SCN_STATUS.DRAFT]: [SCN_STATUS.POSTED, SCN_STATUS.VOID],
	[SCN_STATUS.POSTED]: [SCN_STATUS.VOID],
	[SCN_STATUS.VOID]: []
};
const SCN_COUNTING_STATUSES = [SCN_STATUS.POSTED];
const SCN_EDITABLE_STATUSES = [SCN_STATUS.DRAFT];
const SCN_DOC_TYPE = { CREDIT_NOTE: "credit_note" };
const SUPPLIER_CREDIT_NOTE_COUNTER_ID = "supplierCreditNotes";
const formatSupplierCreditNoteNumber = (n) => `SCN-${String(n).padStart(4, "0")}`;

//#endregion
//#region src/lib/supplierPayments.js
const SUPPLIER_PAYMENT_COUNTER_ID = "supplierPayments";
const SP_DOC_TYPE = {
	PAYMENT: "payment",
	REFUND: "refund"
};
const formatSupplierPaymentNumber = (n) => `SP-${String(n).padStart(4, "0")}`;
const normaliseSupplierName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
function supplierMatchesInvoice(invoice, supplierId, supplierName) {
	if (!invoice) return false;
	if (invoice.supplierId) return !!supplierId && invoice.supplierId === supplierId;
	return normaliseSupplierName(invoice.supplierName) === normaliseSupplierName(supplierName);
}

//#endregion
//#region src/lib/retention.js
const RETENTION_RELEASE_COUNTER_ID = "retentionReleases";
const RR_DOC_TYPE = "retention_release";
const RR_STATUS = {
	DRAFT: "draft",
	POSTED: "posted",
	VOID: "void"
};
const RR_STATUS_LABELS = {
	[RR_STATUS.DRAFT]: "Draft",
	[RR_STATUS.POSTED]: "Posted",
	[RR_STATUS.VOID]: "Void"
};
const RR_BADGE_VARIANTS = {
	[RR_STATUS.DRAFT]: "soon",
	[RR_STATUS.POSTED]: "active",
	[RR_STATUS.VOID]: "danger"
};
const RR_TRANSITIONS = {
	[RR_STATUS.DRAFT]: [RR_STATUS.POSTED, RR_STATUS.VOID],
	[RR_STATUS.POSTED]: [RR_STATUS.VOID],
	[RR_STATUS.VOID]: []
};
const RR_COUNTING_STATUSES = [RR_STATUS.POSTED];
const RR_EDITABLE_STATUSES = [RR_STATUS.DRAFT];
const formatRetentionReleaseNumber = (n) => `RR-${String(n).padStart(4, "0")}`;

//#endregion
//#region src/lib/supplierLedger.js
const SUPPLIER_LEDGER_VERSION = 1;
const SUPPLIER_LEDGER_KIND = {
	CREDIT: "credit",
	CREDIT_VOID: "credit_void",
	RELEASE: "release",
	RELEASE_VOID: "release_void",
	PAYMENT: "payment",
	PAYMENT_VOID: "payment_void"
};
const SUPPLIER_LEDGER_TOTAL_KEYS = [
	"creditedSubtotalCents",
	"creditedGstCents",
	"creditedRetentionCents",
	"creditedRetentionGstCents",
	"releasedRetentionCents",
	"releasedRetentionGstCents",
	"paidCents"
];
const emptySupplierLedger = () => ({
	seq: 0,
	creditedSubtotalCents: 0,
	creditedGstCents: 0,
	creditedRetentionCents: 0,
	creditedRetentionGstCents: 0,
	releasedRetentionCents: 0,
	releasedRetentionGstCents: 0,
	paidCents: 0,
	groups: {}
});
const isLedgerCents = (v) => Number.isSafeInteger(v) && v >= 0;
const int = (v) => Number.isInteger(v) ? v : 0;
const money = (cents) => (cents / 100).toFixed(2);
function storedSupplierLedgerProblem(doc) {
	if (!doc) return null;
	for (const key of ["seq", ...SUPPLIER_LEDGER_TOTAL_KEYS]) if (doc[key] !== void 0 && !isLedgerCents(doc[key])) return `The ledger figure ${key} is not a whole, non-negative number of cents.`;
	for (const [key, g] of Object.entries(doc.groups ?? {})) if (!isLedgerCents(g?.amountCents) || !isLedgerCents(g?.gstCents)) return `The ledger figure groups.${key} is not a whole, non-negative number of cents.`;
	return null;
}
function readSupplierLedger(doc) {
	const out = emptySupplierLedger();
	if (!doc) return out;
	out.seq = int(doc.seq);
	for (const key of SUPPLIER_LEDGER_TOTAL_KEYS) out[key] = int(doc[key]);
	for (const [key, g] of Object.entries(doc.groups ?? {})) out.groups[key] = {
		amountCents: int(g?.amountCents),
		gstCents: int(g?.gstCents)
	};
	return out;
}
const creditGroupKey = (costCodeId, taxCode) => `${costCodeId}|${taxCode}`;
function supplierInvoiceFigures(invoice) {
	const S = toCents(invoice?.subtotal);
	const G = toCents(invoice?.gstTotal);
	const R = toCents(invoice?.retention);
	const RG = toCents(invoice?.retentionGst);
	const P = toCents(invoice?.payableTotal);
	const name = invoice?.invoiceNumber || "This invoice";
	const groups = {};
	const order = [];
	let lineSum = 0;
	let lineGst = 0;
	for (const li of Array.isArray(invoice?.lineItems) ? invoice.lineItems : []) {
		if (typeof li?.costCodeId !== "string" || li.costCodeId === "" || typeof li?.taxCode !== "string") return { problem: `${name} carries a line with no cost code or tax code.` };
		const key = creditGroupKey(li.costCodeId, li.taxCode);
		if (!groups[key]) {
			groups[key] = {
				costCodeId: li.costCodeId,
				costCodeName: typeof li.costCodeName === "string" ? li.costCodeName : "",
				taxCode: li.taxCode,
				amountCents: 0,
				gstCents: 0
			};
			order.push(key);
		}
		const a = toCents(li.amount);
		const g = toCents(li.gstAmount);
		groups[key].amountCents += a;
		groups[key].gstCents += g;
		lineSum += a;
		lineGst += g;
	}
	if (lineSum !== S || lineGst !== G) return { problem: `${name} stores totals that do not reconcile to its own lines.` };
	if (R < 0 || RG < 0 || R > S) return { problem: `${name} stores a retention outside its subtotal.` };
	if (P !== S + G - R - RG) return { problem: `${name} stores a payable total that does not reconcile to its gross and retention.` };
	for (const key of order) if (groups[key].amountCents < 0 || groups[key].gstCents < 0) return { problem: `${name} carries a negative line group, which cannot be credited.` };
	return {
		S,
		G,
		R,
		RG,
		P,
		groups,
		order
	};
}
function supplierLedgerPosition(figures, L) {
	const creditedGross = L.creditedSubtotalCents + L.creditedGstCents;
	const creditedRetentionGross = L.creditedRetentionCents + L.creditedRetentionGstCents;
	const releasedGross = L.releasedRetentionCents + L.releasedRetentionGstCents;
	const basis = figures.P + releasedGross - (creditedGross - creditedRetentionGross);
	return {
		creditedGrossCents: creditedGross,
		creditedPayableGrossCents: creditedGross - creditedRetentionGross,
		releasedGrossCents: releasedGross,
		retentionHeldExCents: figures.R - L.releasedRetentionCents - L.creditedRetentionCents,
		retentionHeldGstCents: figures.RG - L.releasedRetentionGstCents - L.creditedRetentionGstCents,
		payableBasisCents: basis,
		remainingPayableCents: basis - L.paidCents
	};
}
function supplierLedgerProblem(figures, L) {
	for (const key of ["seq", ...SUPPLIER_LEDGER_TOTAL_KEYS]) if (!isLedgerCents(L?.[key])) return `The ledger figure ${key} would not be a whole, non-negative number of cents.`;
	let sumA = 0;
	let sumG = 0;
	for (const [key, g] of Object.entries(L.groups ?? {})) {
		const source = figures.groups[key];
		if (!source) return `A credit names a cost code and tax code (${key.replace("|", " · ")}) the invoice does not carry.`;
		if (!isLedgerCents(g.amountCents) || !isLedgerCents(g.gstCents)) return `The credited figures of ${key} would not be whole, non-negative cents.`;
		if (g.amountCents > source.amountCents) return `Credits on ${source.costCodeName || source.costCodeId} exceed the invoiced amount on it.`;
		if (g.gstCents > source.gstCents) return `Credited GST on ${source.costCodeName || source.costCodeId} exceeds the GST invoiced on it.`;
		sumA += g.amountCents;
		sumG += g.gstCents;
	}
	if (sumA !== L.creditedSubtotalCents || sumG !== L.creditedGstCents) return "The credited totals do not equal the credited groups.";
	if (L.releasedRetentionCents + L.creditedRetentionCents > figures.R) return "Retention released and credited together exceed the retention withheld.";
	if (L.releasedRetentionGstCents + L.creditedRetentionGstCents > figures.RG) return "Retention GST released and credited together exceed the retention GST withheld.";
	if (L.creditedRetentionCents + L.creditedRetentionGstCents > L.creditedSubtotalCents + L.creditedGstCents) return "The retention part of the credits exceeds the credits.";
	return null;
}
function supplierLedgerExcess(figures, L) {
	const over = (v) => v > 0 ? v : 0;
	let groupAmount = 0;
	let groupGst = 0;
	let unknownGroups = 0;
	let sumA = 0;
	let sumG = 0;
	for (const [key, g] of Object.entries(L.groups ?? {})) {
		const source = figures.groups[key];
		sumA += g.amountCents;
		sumG += g.gstCents;
		if (!source) {
			unknownGroups += Math.abs(g.amountCents) + Math.abs(g.gstCents);
			continue;
		}
		groupAmount += over(g.amountCents - source.amountCents);
		groupGst += over(g.gstCents - source.gstCents);
	}
	return {
		groupAmount,
		groupGst,
		unknownGroups,
		totalsMismatch: Math.abs(sumA - L.creditedSubtotalCents) + Math.abs(sumG - L.creditedGstCents),
		retention: over(L.releasedRetentionCents + L.creditedRetentionCents - figures.R),
		retentionGst: over(L.releasedRetentionGstCents + L.creditedRetentionGstCents - figures.RG),
		retentionOverCredits: over(L.creditedRetentionCents + L.creditedRetentionGstCents - L.creditedSubtotalCents - L.creditedGstCents),
		overpaid: over(-supplierLedgerPosition(figures, L).remainingPayableCents)
	};
}
const hasNegativeFigure = (L) => SUPPLIER_LEDGER_TOTAL_KEYS.some((k) => !(L[k] >= 0)) || Object.values(L.groups ?? {}).some((g) => !(g.amountCents >= 0) || !(g.gstCents >= 0));
function correctiveVoidProblem(figures, before, after) {
	if (hasNegativeFigure(after)) return "the void would leave a negative figure on the ledger";
	const b = supplierLedgerExcess(figures, before);
	const a = supplierLedgerExcess(figures, after);
	const worse = Object.keys(a).find((k) => a[k] > b[k]);
	return worse ? `the void would widen an existing inconsistency (${worse})` : null;
}
function allocateSupplierCredit(figures, L, rows) {
	const perGroup = /* @__PURE__ */ new Map();
	for (const [i, row] of (rows ?? []).entries()) {
		const key = creditGroupKey(row?.costCodeId, row?.taxCode);
		if (!figures.groups[key]) return { error: `Line ${i + 1}: the invoice carries no ${row?.taxCode ?? ""} amount on that cost code.` };
		if (typeof row?.amount !== "number" || !isWholeCents(row.amount)) return { error: `Line ${i + 1}: the credit amount must be a whole number of cents.` };
		const amountCents = toCents(row.amount);
		if (amountCents <= 0) return { error: `Line ${i + 1}: the credit amount must be greater than zero.` };
		if (perGroup.has(key)) return { error: `Line ${i + 1}: that cost code and tax code is credited twice — combine those lines.` };
		perGroup.set(key, amountCents);
	}
	if (perGroup.size === 0) return { error: "Add at least one line with an amount." };
	const lines = [];
	let subtotalCents = 0;
	let gstCents = 0;
	for (const key of figures.order) {
		if (!perGroup.has(key)) continue;
		const amountCents = perGroup.get(key);
		const source = figures.groups[key];
		const before = L.groups[key] ?? {
			amountCents: 0,
			gstCents: 0
		};
		const after = before.amountCents + amountCents;
		if (after > source.amountCents) return { error: `${source.costCodeName || source.costCodeId}: only ${money(source.amountCents - before.amountCents)} of ${money(source.amountCents)} remains to credit.` };
		const lineGst = shareStep(source.gstCents, after, source.amountCents, before.gstCents);
		lines.push({
			costCodeId: source.costCodeId,
			costCodeName: source.costCodeName,
			taxCode: source.taxCode,
			amountCents,
			gstCents: lineGst
		});
		subtotalCents += amountCents;
		gstCents += lineGst;
	}
	const stillBilled = figures.S - L.creditedSubtotalCents;
	const heldEx = figures.R - L.releasedRetentionCents - L.creditedRetentionCents;
	const consumedEx = L.releasedRetentionCents + L.creditedRetentionCents;
	const consumedGst = L.releasedRetentionGstCents + L.creditedRetentionGstCents;
	const final = subtotalCents >= stillBilled;
	const gstFor = (ex) => ex <= 0 ? 0 : shareStep(figures.RG, consumedEx + ex, figures.R, consumedGst);
	let retentionCents = heldEx <= 0 ? 0 : final ? heldEx : Math.min(shareOfCents(heldEx, subtotalCents, stillBilled), heldEx);
	let retentionGstCents = gstFor(retentionCents);
	while (!final && retentionCents > 0 && retentionCents + retentionGstCents > subtotalCents + gstCents) {
		retentionCents -= 1;
		retentionGstCents = gstFor(retentionCents);
	}
	if (final && retentionCents + retentionGstCents > subtotalCents + gstCents) return { error: "This credit would release more retention than it credits — release the retention first." };
	return {
		lines,
		subtotalCents,
		gstCents,
		retentionCents,
		retentionGstCents
	};
}
function allocateSupplierRelease(figures, L, amount) {
	if (typeof amount !== "number" || !isWholeCents(amount)) return { error: "The release amount must be a whole number of cents." };
	const amountCents = toCents(amount);
	if (amountCents <= 0) return { error: "The release amount must be greater than zero." };
	const heldEx = figures.R - L.releasedRetentionCents - L.creditedRetentionCents;
	if (amountCents > heldEx) return { error: `Only ${money(Math.max(0, heldEx))} of retention (ex-GST) is still held on this invoice.` };
	const consumedEx = L.releasedRetentionCents + L.creditedRetentionCents;
	const consumedGst = L.releasedRetentionGstCents + L.creditedRetentionGstCents;
	return {
		amountCents,
		gstCents: shareStep(figures.RG, consumedEx + amountCents, figures.R, consumedGst)
	};
}
const step = (L, kind, entryId) => ({
	...L,
	groups: Object.fromEntries(Object.entries(L.groups).map(([k, v]) => [k, { ...v }])),
	seq: L.seq + 1,
	lastEntryId: entryId,
	lastEntryKind: kind
});
function supplierCreditCents(creditNote) {
	return {
		subtotalCents: toCents(creditNote?.subtotal),
		gstCents: toCents(creditNote?.gstTotal),
		retentionCents: toCents(creditNote?.retentionAmount),
		retentionGstCents: toCents(creditNote?.retentionGst),
		lines: (Array.isArray(creditNote?.lineItems) ? creditNote.lineItems : []).map((li) => ({
			key: creditGroupKey(li?.costCodeId, li?.taxCode),
			amountCents: toCents(li?.amount),
			gstCents: toCents(li?.gstAmount)
		}))
	};
}
function moveCredit(L, creditNote, sign, kind) {
	const c = supplierCreditCents(creditNote);
	const next = step(L, kind, creditNote.id);
	next.creditedSubtotalCents += sign * c.subtotalCents;
	next.creditedGstCents += sign * c.gstCents;
	next.creditedRetentionCents += sign * c.retentionCents;
	next.creditedRetentionGstCents += sign * c.retentionGstCents;
	for (const li of c.lines) {
		const before = next.groups[li.key] ?? {
			amountCents: 0,
			gstCents: 0
		};
		next.groups[li.key] = {
			amountCents: before.amountCents + sign * li.amountCents,
			gstCents: before.gstCents + sign * li.gstCents
		};
	}
	return next;
}
const applySupplierCredit = (L, creditNote) => moveCredit(L, creditNote, 1, SUPPLIER_LEDGER_KIND.CREDIT);
const applySupplierCreditVoid = (L, creditNote) => moveCredit(L, creditNote, -1, SUPPLIER_LEDGER_KIND.CREDIT_VOID);
function moveRelease(L, release, sign, kind) {
	const next = step(L, kind, release.id);
	next.releasedRetentionCents += sign * toCents(release?.amount);
	next.releasedRetentionGstCents += sign * toCents(release?.gstAmount);
	return next;
}
const applySupplierRelease = (L, release) => moveRelease(L, release, 1, SUPPLIER_LEDGER_KIND.RELEASE);
const applySupplierReleaseVoid = (L, release) => moveRelease(L, release, -1, SUPPLIER_LEDGER_KIND.RELEASE_VOID);
function applySupplierPayment(L, cents, paymentId) {
	const next = step(L, SUPPLIER_LEDGER_KIND.PAYMENT, paymentId);
	next.paidCents = L.paidCents + cents;
	return next;
}
function applySupplierPaymentVoid(L, cents, paymentId) {
	const next = step(L, SUPPLIER_LEDGER_KIND.PAYMENT_VOID, paymentId);
	next.paidCents = L.paidCents - cents;
	return next;
}
function paymentAllocationProblem(figures, L, cents, invoiceNumber = "this invoice") {
	if (!Number.isSafeInteger(cents) || cents <= 0) return `An allocation to ${invoiceNumber} must be greater than zero.`;
	const { remainingPayableCents } = supplierLedgerPosition(figures, L);
	if (cents > remainingPayableCents) return `Only ${money(Math.max(0, remainingPayableCents))} remains payable on ${invoiceNumber}. Record the rest of the payment as unallocated.`;
	return null;
}
function releaseVoidDependency(figures, L, release, invoiceNumber = "this invoice") {
	const { remainingPayableCents } = supplierLedgerPosition(figures, applySupplierReleaseVoid(L, release));
	if (remainingPayableCents < 0 && remainingPayableCents < supplierLedgerPosition(figures, L).remainingPayableCents) return `Payments on ${invoiceNumber} depend on this release: voiding it would leave the invoice paid ${money(-remainingPayableCents)} beyond what is due. Void or reduce those payments first.`;
	return null;
}
function releaseVoidProblem(figures, L, release, invoiceNumber = "this invoice") {
	return supplierLedgerProblem(figures, applySupplierReleaseVoid(L, release)) ?? releaseVoidDependency(figures, L, release, invoiceNumber);
}
function supplierLedgerDocument(L) {
	const doc = {
		seq: L.seq,
		groups: L.groups,
		lastEntryId: L.lastEntryId ?? null,
		lastEntryKind: L.lastEntryKind ?? null
	};
	for (const key of SUPPLIER_LEDGER_TOTAL_KEYS) doc[key] = L[key];
	return doc;
}
const MALFORMED_ENTRY_IDS_MAX = 50;
function supplierLedgersFromHistory({ invoices, creditNotes = [], releases = [], payments = [] }) {
	const byInvoice = /* @__PURE__ */ new Map();
	const entry = (id) => {
		if (!byInvoice.has(id)) byInvoice.set(id, {
			ledger: emptySupplierLedger(),
			sources: {
				credits: 0,
				releases: 0,
				payments: 0
			},
			problems: [],
			malformed: []
		});
		return byInvoice.get(id);
	};
	for (const p of payments) {
		if (p?.status !== "posted") continue;
		const allocations = p.allocations;
		if (allocations != null && !Array.isArray(allocations)) return { problem: `${p.paymentNumber || p.id} stores allocations that are not a list.` };
		for (const a of allocations ?? []) {
			if (typeof a?.supplierInvoiceId !== "string" || a.supplierInvoiceId === "") return { problem: `${p.paymentNumber || p.id} has an allocation naming no invoice.` };
			if (typeof a.allocatedAmount !== "number" || !isWholeCents(a.allocatedAmount) || a.allocatedAmount <= 0) return { problem: `${p.paymentNumber || p.id} has an allocation that is not a positive whole number of cents.` };
			const e = entry(a.supplierInvoiceId);
			e.ledger.paidCents += toCents(a.allocatedAmount);
			e.sources.payments += 1;
		}
	}
	for (const c of creditNotes) {
		if (c?.status !== "posted") continue;
		if (typeof c.supplierInvoiceId !== "string" || c.supplierInvoiceId === "") return { problem: `${c.creditNoteNumber || c.id} is a posted credit note naming no invoice.` };
		const e = entry(c.supplierInvoiceId);
		const cents = supplierCreditCents(c);
		if ([
			cents.subtotalCents,
			cents.gstCents,
			cents.retentionCents,
			cents.retentionGstCents
		].some((v) => v < 0) || cents.lines.some((l) => l.amountCents < 0 || l.gstCents < 0)) {
			e.problems.push(`${c.creditNoteNumber || c.id} stores a negative figure.`);
			e.malformed.push(c.id);
		}
		e.ledger = applySupplierCredit(e.ledger, c);
		e.sources.credits += 1;
	}
	for (const r of releases) {
		if (r?.status !== "posted") continue;
		if (typeof r.supplierInvoiceId !== "string" || r.supplierInvoiceId === "") return { problem: `${r.releaseNumber || r.id} is a posted release naming no invoice.` };
		const e = entry(r.supplierInvoiceId);
		if (toCents(r.amount) <= 0 || toCents(r.gstAmount) < 0) {
			e.problems.push(`${r.releaseNumber || r.id} stores a release amount that is not positive.`);
			e.malformed.push(r.id);
		}
		e.ledger = applySupplierRelease(e.ledger, r);
		e.sources.releases += 1;
	}
	const ledgers = /* @__PURE__ */ new Map();
	for (const [invoiceId, e] of byInvoice) {
		const invoice = invoices instanceof Map ? invoices.get(invoiceId) : invoices?.[invoiceId];
		const ledger = {
			...e.ledger,
			seq: 0,
			lastEntryId: null,
			lastEntryKind: null
		};
		let problem = e.problems[0] ?? null;
		if (!problem && !invoice) problem = "Posted entries name an invoice that does not exist.";
		let figures = null;
		if (!problem) {
			figures = supplierInvoiceFigures(invoice);
			if (figures.problem) problem = figures.problem;
		}
		if (!problem) problem = supplierLedgerProblem(figures, ledger);
		ledgers.set(invoiceId, {
			state: problem ? "inconsistent" : "established",
			problem,
			ledger,
			sources: e.sources,
			malformedEntryIds: e.malformed.slice(0, 50),
			malformedOverflow: e.malformed.length > 50
		});
	}
	return { ledgers };
}
function supplierLedgerFromRegisters(invoice, { creditNotes = [], releases = [], payments = [] } = {}) {
	if (!invoice?.id) return {
		state: "established",
		ledger: emptySupplierLedger(),
		problem: null
	};
	const only = (list) => (list ?? []).filter((d) => d?.supplierInvoiceId === invoice.id);
	const pays = (payments ?? []).filter((p) => (p?.allocations ?? []).some((a) => a?.supplierInvoiceId === invoice.id)).map((p) => ({
		...p,
		allocations: (p.allocations ?? []).filter((a) => a?.supplierInvoiceId === invoice.id)
	}));
	const { problem, ledgers } = supplierLedgersFromHistory({
		invoices: { [invoice.id]: invoice },
		creditNotes: only(creditNotes),
		releases: only(releases),
		payments: pays
	});
	if (problem) return {
		state: "inconsistent",
		ledger: emptySupplierLedger(),
		problem
	};
	return ledgers.get(invoice.id) ?? {
		state: "established",
		ledger: emptySupplierLedger(),
		problem: null
	};
}

//#endregion
//#region src/lib/supplierSettlementProcessing.js
const SETTLEMENT_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const SETTLEMENT_TEXT_MAX = 200;
const SETTLEMENT_NOTES_MAX = 5e3;
const SETTLEMENT_COUNTER_ID = {
	credit: SUPPLIER_CREDIT_NOTE_COUNTER_ID,
	release: RETENTION_RELEASE_COUNTER_ID,
	payment: SUPPLIER_PAYMENT_COUNTER_ID
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (data, keys) => isObject(data) && Object.keys(data).length === keys.length && keys.every((k) => k in data);
const isId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const isRevision = (v) => Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isDate = (v) => typeof v === "string" && DATE_RE.test(v);
const isText = (v, max) => typeof v === "string" && v.length <= max;
const isMoney = (v) => typeof v === "number" && Number.isFinite(v) && isWholeCents(v) && roundToCents(v) !== null;
const SETTLEMENT_PROBLEM = {
	INVOICE_INVALID: "invoice-invalid",
	LEDGER: "ledger-inconsistent",
	CAP: "cap-exceeded",
	DRAFT_INVALID: "draft-invalid",
	FIGURES_MOVED: "figures-moved",
	DEPENDENCY: "dependency",
	FUTURE_DATED: "future-dated",
	SUPPLIER: "supplier-invalid"
};
const problem = (code, message, extra = {}) => ({
	problem: code,
	message,
	...extra
});
const CREDIT_DRAFT_KEYS = [
	"projectId",
	"creditNoteId",
	"expectedRevision",
	"supplierInvoiceId",
	"supplierCreditReference",
	"creditDate",
	"reason",
	"notes",
	"lines"
];
const CREDIT_LINE_KEYS = [
	"costCodeId",
	"taxCode",
	"description",
	"amount"
];
const RELEASE_DRAFT_KEYS = [
	"projectId",
	"releaseId",
	"expectedRevision",
	"supplierInvoiceId",
	"amount",
	"releaseDate",
	"reason",
	"notes"
];
const PAYMENT_DRAFT_KEYS = [
	"projectId",
	"paymentId",
	"expectedRevision",
	"supplierId",
	"paymentDate",
	"amount",
	"paymentMethod",
	"paymentMethodOther",
	"bankReference",
	"remittanceReference",
	"externalReference",
	"notes",
	"allocations"
];
const ALLOCATION_KEYS = ["supplierInvoiceId", "allocatedAmount"];
const SETTLEMENT_POST_KEYS = [
	"projectId",
	"documentId",
	"expectedRevision"
];
const SETTLEMENT_VOID_KEYS = [
	"projectId",
	"documentId",
	"expectedRevision",
	"voidReason"
];
const revisionOrNull = (v) => v === null || isRevision(v);
function creditDraftRequestProblem(d) {
	if (!exactKeys(d, CREDIT_DRAFT_KEYS)) return "keys";
	if (!isId(d.projectId) || !isId(d.creditNoteId) || !isId(d.supplierInvoiceId)) return "ids";
	if (!revisionOrNull(d.expectedRevision)) return "expectedRevision";
	if (!isText(d.supplierCreditReference, 200)) return "supplierCreditReference";
	if (!isDate(d.creditDate)) return "creditDate";
	if (!isText(d.reason, 5e3) || d.reason.trim() === "") return "reason";
	if (!isText(d.notes, 5e3)) return "notes";
	if (!Array.isArray(d.lines) || d.lines.length === 0 || d.lines.length > 100) return "lines";
	for (const l of d.lines) {
		if (!exactKeys(l, CREDIT_LINE_KEYS) || !isId(l.costCodeId) || !TAX_CODES.includes(l.taxCode)) return "line";
		if (!isText(l.description, 200) || l.description.trim() === "") return "line-description";
		if (!isMoney(l.amount) || l.amount <= 0) return "line-amount";
	}
	return null;
}
function releaseDraftRequestProblem(d) {
	if (!exactKeys(d, RELEASE_DRAFT_KEYS)) return "keys";
	if (!isId(d.projectId) || !isId(d.releaseId) || !isId(d.supplierInvoiceId)) return "ids";
	if (!revisionOrNull(d.expectedRevision)) return "expectedRevision";
	if (!isMoney(d.amount) || d.amount <= 0) return "amount";
	if (!isDate(d.releaseDate)) return "releaseDate";
	if (!isText(d.reason, 5e3) || d.reason.trim() === "") return "reason";
	if (!isText(d.notes, 5e3)) return "notes";
	return null;
}
function paymentDraftRequestProblem(d) {
	if (!exactKeys(d, PAYMENT_DRAFT_KEYS)) return "keys";
	if (!isId(d.projectId) || !isId(d.paymentId) || !isId(d.supplierId)) return "ids";
	if (!revisionOrNull(d.expectedRevision)) return "expectedRevision";
	if (!isDate(d.paymentDate)) return "paymentDate";
	if (!isMoney(d.amount) || d.amount <= 0) return "amount";
	if (!PAYMENT_METHODS.includes(d.paymentMethod)) return "paymentMethod";
	if (!isText(d.paymentMethodOther, 200) || d.paymentMethod === PAYMENT_METHOD.OTHER && d.paymentMethodOther.trim() === "") return "paymentMethodOther";
	for (const k of [
		"bankReference",
		"remittanceReference",
		"externalReference"
	]) if (!isText(d[k], 200)) return k;
	if (!isText(d.notes, 5e3)) return "notes";
	if (!Array.isArray(d.allocations) || d.allocations.length > 100) return "allocations";
	const seen = /* @__PURE__ */ new Set();
	let total = 0;
	for (const a of d.allocations) {
		if (!exactKeys(a, ALLOCATION_KEYS) || !isId(a.supplierInvoiceId) || !isMoney(a.allocatedAmount) || a.allocatedAmount <= 0) return "allocation";
		if (seen.has(a.supplierInvoiceId)) return "allocation-duplicate";
		seen.add(a.supplierInvoiceId);
		total += toCents(a.allocatedAmount);
	}
	if (total > toCents(d.amount)) return "allocations-exceed-amount";
	return null;
}
function settlementPostRequestProblem(d) {
	if (!exactKeys(d, SETTLEMENT_POST_KEYS)) return "keys";
	if (!isId(d.projectId) || !isId(d.documentId)) return "ids";
	return isRevision(d.expectedRevision) ? null : "expectedRevision";
}
function settlementVoidRequestProblem(d) {
	if (!exactKeys(d, SETTLEMENT_VOID_KEYS)) return "keys";
	if (!isId(d.projectId) || !isId(d.documentId)) return "ids";
	if (!isRevision(d.expectedRevision)) return "expectedRevision";
	if (!isText(d.voidReason, 5e3) || d.voidReason.trim() === "") return "voidReason";
	return null;
}
function settleableInvoice(invoice) {
	if (!invoice) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, "The supplier invoice could not be found on this project.");
	if (invoice.status !== SI_STATUS.POSTED) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${invoice.invoiceNumber || "The invoice"} is ${invoice.status} — only posted supplier invoices can be settled.`);
	const figures = supplierInvoiceFigures(invoice);
	if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem);
	return { figures };
}
function usableLedger(ledgerEntry) {
	if (ledgerEntry?.state === "inconsistent") return problem(SETTLEMENT_PROBLEM.LEDGER, `This invoice’s settlement history is inconsistent: ${ledgerEntry.problem}`);
	return null;
}
function creditFigures(invoice, ledger, lines) {
	const target = settleableInvoice(invoice);
	if (target.problem) return target;
	const alloc = allocateSupplierCredit(target.figures, ledger, lines.map((l) => ({
		costCodeId: l.costCodeId,
		taxCode: l.taxCode,
		amount: l.amount
	})));
	if (alloc.error) return problem(SETTLEMENT_PROBLEM.CAP, alloc.error);
	const descriptions = new Map(lines.map((l) => [`${l.costCodeId}|${l.taxCode}`, l.description.trim()]));
	return {
		figures: target.figures,
		derived: {
			lineItems: alloc.lines.map((l) => ({
				costCodeId: l.costCodeId,
				costCodeName: l.costCodeName,
				description: descriptions.get(`${l.costCodeId}|${l.taxCode}`) ?? "",
				amount: fromCents(l.amountCents),
				taxCode: l.taxCode,
				gstAmount: fromCents(l.gstCents)
			})),
			subtotal: fromCents(alloc.subtotalCents),
			gstTotal: fromCents(alloc.gstCents),
			grossTotal: fromCents(alloc.subtotalCents + alloc.gstCents),
			retentionAmount: fromCents(alloc.retentionCents),
			retentionGst: fromCents(alloc.retentionGstCents),
			calcVersion: CURRENT_CALC_VERSION,
			sourceCalcVersion: invoice.calcVersion == null ? null : calcVersionOf(invoice)
		}
	};
}
function buildCreditDraft({ input, invoice, ledgerEntry, creditNumber, uid, now }) {
	const bad = usableLedger(ledgerEntry);
	if (bad) return bad;
	const built = creditFigures(invoice, ledgerEntry.ledger, input.lines);
	if (built.problem) return built;
	return { document: {
		creditNumber,
		status: SCN_STATUS.DRAFT,
		docType: SCN_DOC_TYPE.CREDIT_NOTE,
		supplierInvoiceId: invoice.id,
		invoiceNumber: invoice.invoiceNumber || "",
		supplierInvoiceNumber: invoice.supplierInvoiceNumber || "",
		supplierId: invoice.supplierId ?? null,
		supplierName: String(invoice.supplierName || "").trim(),
		supplierCreditReference: input.supplierCreditReference.trim(),
		creditDate: input.creditDate,
		reason: input.reason.trim(),
		...built.derived,
		currency: invoice.currency,
		revision: 1,
		notes: input.notes.trim(),
		postedAt: null,
		postedBy: null,
		voidedAt: null,
		voidedBy: null,
		voidReason: "",
		attachments: [],
		externalRefs: {},
		createdAt: now,
		createdBy: uid,
		updatedAt: now,
		updatedBy: uid
	} };
}
function buildCreditDraftUpdate({ input, live, invoice, ledgerEntry, uid, now }) {
	if (live.supplierInvoiceId !== input.supplierInvoiceId) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, "A credit note’s invoice cannot be changed — void or discard the draft and raise a new one.");
	const bad = usableLedger(ledgerEntry);
	if (bad) return bad;
	const built = creditFigures(invoice, ledgerEntry.ledger, input.lines);
	if (built.problem) return built;
	return { update: {
		supplierCreditReference: input.supplierCreditReference.trim(),
		creditDate: input.creditDate,
		reason: input.reason.trim(),
		notes: input.notes.trim(),
		...built.derived,
		revision: (Number(live.revision) || 0) + 1,
		updatedAt: now,
		updatedBy: uid
	} };
}
const sameFigures = (live, derived, keys) => keys.every((k) => JSON.stringify(live?.[k] ?? null) === JSON.stringify(derived[k] ?? null));
const CREDIT_FIGURE_KEYS = [
	"lineItems",
	"subtotal",
	"gstTotal",
	"grossTotal",
	"retentionAmount",
	"retentionGst"
];
function creditPosting({ live, invoice, ledgerEntry }) {
	const bad = usableLedger(ledgerEntry);
	if (bad) return bad;
	const rows = (live.lineItems ?? []).map((l) => ({
		costCodeId: l.costCodeId,
		taxCode: l.taxCode,
		description: l.description ?? "",
		amount: l.amount
	}));
	const built = creditFigures(invoice, ledgerEntry.ledger, rows);
	if (built.problem) return built;
	if (!sameFigures(live, built.derived, CREDIT_FIGURE_KEYS)) return problem(SETTLEMENT_PROBLEM.FIGURES_MOVED, "The invoice’s credits or releases changed since this draft was saved, so its GST or retention split would differ. Open and save the draft again, review it, then post.");
	const next = applySupplierCredit(ledgerEntry.ledger, {
		...live,
		id: live.id
	});
	const invariant = supplierLedgerProblem(built.figures, next);
	if (invariant) return problem(SETTLEMENT_PROBLEM.CAP, invariant);
	return { ledger: next };
}
function creditVoiding({ live, invoice, ledgerEntry }) {
	const figures = supplierInvoiceFigures(invoice);
	if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem);
	const next = applySupplierCreditVoid(ledgerEntry.ledger, {
		...live,
		id: live.id
	});
	const refused = voidRefusal(figures, ledgerEntry, next);
	if (refused) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `Voiding this credit note is refused: ${refused}`);
	return { ledger: next };
}
function voidRefusal(figures, ledgerEntry, next) {
	const invariant = supplierLedgerProblem(figures, next);
	if (!invariant) return null;
	if (ledgerEntry.state !== "inconsistent") return invariant;
	return correctiveVoidProblem(figures, ledgerEntry.ledger, next);
}
function releaseFigures(invoice, ledger, amount) {
	const target = settleableInvoice(invoice);
	if (target.problem) return target;
	if (target.figures.R <= 0) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${invoice.invoiceNumber || "The invoice"} holds no retention.`);
	const alloc = allocateSupplierRelease(target.figures, ledger, amount);
	if (alloc.error) return problem(SETTLEMENT_PROBLEM.CAP, alloc.error);
	return {
		figures: target.figures,
		derived: {
			previouslyReleasedAmount: fromCents(ledger.releasedRetentionCents),
			amount: fromCents(alloc.amountCents),
			gstAmount: fromCents(alloc.gstCents),
			releaseTotal: fromCents(alloc.amountCents + alloc.gstCents),
			calcVersion: CURRENT_CALC_VERSION,
			sourceCalcVersion: invoice.calcVersion == null ? null : calcVersionOf(invoice)
		}
	};
}
function buildReleaseDraft({ input, invoice, ledgerEntry, releaseNumber, currency, uid, now }) {
	const bad = usableLedger(ledgerEntry);
	if (bad) return bad;
	const built = releaseFigures(invoice, ledgerEntry.ledger, input.amount);
	if (built.problem) return built;
	return { document: {
		releaseNumber,
		status: RR_STATUS.DRAFT,
		docType: RR_DOC_TYPE,
		supplierInvoiceId: invoice.id,
		invoiceNumber: invoice.invoiceNumber || "",
		supplierInvoiceNumber: invoice.supplierInvoiceNumber || "",
		supplierId: invoice.supplierId ?? null,
		supplierName: String(invoice.supplierName || "").trim(),
		...built.derived,
		releaseDate: input.releaseDate,
		reason: input.reason.trim(),
		notes: input.notes.trim(),
		currency,
		revision: 1,
		postedAt: null,
		postedBy: null,
		voidedAt: null,
		voidedBy: null,
		voidReason: "",
		externalRefs: {},
		createdAt: now,
		createdBy: uid,
		updatedAt: now,
		updatedBy: uid
	} };
}
function buildReleaseDraftUpdate({ input, live, invoice, ledgerEntry, uid, now }) {
	if (live.supplierInvoiceId !== input.supplierInvoiceId) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, "A release’s invoice cannot be changed — raise a new release.");
	const bad = usableLedger(ledgerEntry);
	if (bad) return bad;
	const built = releaseFigures(invoice, ledgerEntry.ledger, input.amount);
	if (built.problem) return built;
	return { update: {
		...built.derived,
		releaseDate: input.releaseDate,
		reason: input.reason.trim(),
		notes: input.notes.trim(),
		revision: (Number(live.revision) || 0) + 1,
		updatedAt: now,
		updatedBy: uid
	} };
}
const RELEASE_FIGURE_KEYS = [
	"previouslyReleasedAmount",
	"amount",
	"gstAmount",
	"releaseTotal"
];
function releasePosting({ live, invoice, ledgerEntry }) {
	const bad = usableLedger(ledgerEntry);
	if (bad) return bad;
	const built = releaseFigures(invoice, ledgerEntry.ledger, live.amount);
	if (built.problem) return built;
	if (!sameFigures(live, built.derived, RELEASE_FIGURE_KEYS)) return problem(SETTLEMENT_PROBLEM.FIGURES_MOVED, "Retention on this invoice changed since the draft was saved. Open and save the draft again, review it, then post.");
	const next = applySupplierRelease(ledgerEntry.ledger, {
		...live,
		id: live.id
	});
	const invariant = supplierLedgerProblem(built.figures, next);
	if (invariant) return problem(SETTLEMENT_PROBLEM.CAP, invariant);
	return { ledger: next };
}
function releaseVoiding({ live, invoice, ledgerEntry }) {
	const figures = supplierInvoiceFigures(invoice);
	if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem);
	const next = applySupplierReleaseVoid(ledgerEntry.ledger, {
		...live,
		id: live.id
	});
	const dependency = releaseVoidDependency(figures, ledgerEntry.ledger, {
		...live,
		id: live.id
	}, invoice.invoiceNumber);
	if (dependency) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, dependency);
	const refused = voidRefusal(figures, ledgerEntry, next);
	if (refused) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `Voiding this release is refused: ${refused}`);
	return { ledger: next };
}
function buildPaymentFields({ input, supplier, invoices, ledgers }) {
	if (!supplier || supplier.isActive === false) return problem(SETTLEMENT_PROBLEM.SUPPLIER, "The selected supplier could not be found or is inactive.");
	const supplierName = String(supplier.displayName || supplier.legalName || "").trim();
	if (supplierName === "") return problem(SETTLEMENT_PROBLEM.SUPPLIER, "The selected supplier has no display name.");
	const allocations = [];
	for (const [i, a] of input.allocations.entries()) {
		const inv = invoices.get(a.supplierInvoiceId) ?? null;
		if (!inv) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `Allocation ${i + 1}: the supplier invoice could not be found on this project.`);
		if (inv.status !== SI_STATUS.POSTED) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${inv.invoiceNumber} is ${inv.status} — only posted supplier invoices can be paid.`);
		if (!supplierMatchesInvoice(inv, input.supplierId, supplierName)) return problem(SETTLEMENT_PROBLEM.SUPPLIER, `${inv.invoiceNumber} belongs to a different supplier.`);
		const entry = ledgers.get(a.supplierInvoiceId);
		const bad = usableLedger(entry);
		if (bad) return bad;
		const figures = supplierInvoiceFigures(inv);
		if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem);
		const cap = paymentAllocationProblem(figures, entry.ledger, toCents(a.allocatedAmount), inv.invoiceNumber);
		if (cap) return problem(SETTLEMENT_PROBLEM.CAP, cap);
		allocations.push({
			supplierInvoiceId: inv.id,
			invoiceNumber: inv.invoiceNumber || "",
			supplierInvoiceNumber: inv.supplierInvoiceNumber || "",
			allocatedAmount: fromCents(toCents(a.allocatedAmount))
		});
	}
	const allocatedCents = allocations.reduce((s, a) => s + toCents(a.allocatedAmount), 0);
	return { fields: {
		supplierId: input.supplierId,
		supplierName,
		paymentDate: input.paymentDate,
		amount: fromCents(toCents(input.amount)),
		paymentMethod: input.paymentMethod,
		paymentMethodOther: input.paymentMethod === PAYMENT_METHOD.OTHER ? input.paymentMethodOther.trim() : "",
		bankReference: input.bankReference.trim(),
		remittanceReference: input.remittanceReference.trim(),
		externalReference: input.externalReference.trim(),
		allocations,
		allocatedTotal: fromCents(allocatedCents),
		unallocatedAmount: fromCents(toCents(input.amount) - allocatedCents),
		notes: input.notes.trim()
	} };
}
function buildPaymentDraft({ fields, paymentNumber, currency, uid, now }) {
	return {
		paymentNumber,
		status: PAYMENT_STATUS.DRAFT,
		docType: SP_DOC_TYPE.PAYMENT,
		...fields,
		currency,
		revision: 1,
		postedAt: null,
		postedBy: null,
		voidedAt: null,
		voidedBy: null,
		voidReason: "",
		attachments: [],
		externalRefs: {},
		createdAt: now,
		createdBy: uid,
		updatedAt: now,
		updatedBy: uid
	};
}
function latestPostableDate(nowMillis) {
	return new Date(nowMillis + 1440 * 60 * 1e3).toISOString().slice(0, 10);
}
function paymentPosting({ live, invoices, ledgers, nowMillis }) {
	if (typeof live.paymentDate !== "string" || live.paymentDate > latestPostableDate(nowMillis)) return problem(SETTLEMENT_PROBLEM.FUTURE_DATED, `The payment date (${live.paymentDate}) is in the future. A payment records money already paid; post it on or after that date.`);
	const allocations = Array.isArray(live.allocations) ? live.allocations : [];
	const allocatedCents = allocations.reduce((s, a) => s + toCents(a?.allocatedAmount), 0);
	if (allocatedCents + toCents(live.unallocatedAmount) !== toCents(live.amount) || toCents(live.allocatedTotal) !== allocatedCents) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, "The payment’s allocated and unallocated amounts do not add up to its amount. Open and save it again.");
	const next = /* @__PURE__ */ new Map();
	for (const a of allocations) {
		const inv = invoices.get(a?.supplierInvoiceId) ?? null;
		if (!inv || inv.status !== SI_STATUS.POSTED) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, `${a?.invoiceNumber || "An allocated invoice"} is no longer a posted supplier invoice.`);
		if (!supplierMatchesInvoice(inv, live.supplierId, live.supplierName)) return problem(SETTLEMENT_PROBLEM.SUPPLIER, `${inv.invoiceNumber} belongs to a different supplier.`);
		const entry = ledgers.get(inv.id);
		const bad = usableLedger(entry);
		if (bad) return bad;
		const figures = supplierInvoiceFigures(inv);
		if (figures.problem) return problem(SETTLEMENT_PROBLEM.INVOICE_INVALID, figures.problem);
		const cents = toCents(a.allocatedAmount);
		if (!isWholeCents(a.allocatedAmount) || cents <= 0) return problem(SETTLEMENT_PROBLEM.DRAFT_INVALID, `The allocation to ${inv.invoiceNumber} is not a positive whole number of cents.`);
		const current = next.get(inv.id) ?? entry.ledger;
		const cap = paymentAllocationProblem(figures, current, cents, inv.invoiceNumber);
		if (cap) return problem(SETTLEMENT_PROBLEM.CAP, cap);
		next.set(inv.id, applySupplierPayment(current, cents, live.id));
	}
	return { ledgers: next };
}
function paymentVoiding({ live, ledgers }) {
	const next = /* @__PURE__ */ new Map();
	for (const a of Array.isArray(live.allocations) ? live.allocations : []) {
		const entry = ledgers.get(a?.supplierInvoiceId);
		const cents = toCents(a?.allocatedAmount);
		if (!(cents > 0)) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `The allocation to ${a?.invoiceNumber || "an invoice"} is not a positive amount — this payment cannot be voided until the history is reviewed.`);
		const after = applySupplierPaymentVoid(next.get(a.supplierInvoiceId) ?? entry?.ledger ?? {
			paidCents: 0,
			seq: 0,
			groups: {}
		}, cents, live.id);
		if (after.paidCents < 0) return problem(SETTLEMENT_PROBLEM.DEPENDENCY, `The ledger of ${a?.invoiceNumber || "an allocated invoice"} records less paid than this payment allocated — it cannot be voided until the history is reviewed.`);
		next.set(a.supplierInvoiceId, after);
	}
	return { ledgers: next };
}

//#endregion
//#region src/lib/currency.js
const DEFAULT_CURRENCY = "AUD";
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const isCurrencyCodeShape = (code) => typeof code === "string" && CURRENCY_CODE_PATTERN.test(code);
const CURRENCIES = [
	{
		code: "AUD",
		name: "Australian Dollar"
	},
	{
		code: "NZD",
		name: "New Zealand Dollar"
	},
	{
		code: "ZAR",
		name: "South African Rand"
	},
	{
		code: "USD",
		name: "United States Dollar"
	},
	{
		code: "GBP",
		name: "Pound Sterling"
	},
	{
		code: "EUR",
		name: "Euro"
	},
	{
		code: "CAD",
		name: "Canadian Dollar"
	},
	{
		code: "SGD",
		name: "Singapore Dollar"
	},
	{
		code: "HKD",
		name: "Hong Kong Dollar"
	},
	{
		code: "JPY",
		name: "Japanese Yen"
	},
	{
		code: "CNY",
		name: "Chinese Yuan"
	},
	{
		code: "INR",
		name: "Indian Rupee"
	},
	{
		code: "CHF",
		name: "Swiss Franc"
	},
	{
		code: "DKK",
		name: "Danish Krone"
	},
	{
		code: "SEK",
		name: "Swedish Krona"
	},
	{
		code: "NOK",
		name: "Norwegian Krone"
	},
	{
		code: "PLN",
		name: "Polish Złoty"
	},
	{
		code: "AED",
		name: "UAE Dirham"
	},
	{
		code: "SAR",
		name: "Saudi Riyal"
	},
	{
		code: "QAR",
		name: "Qatari Riyal"
	},
	{
		code: "KWD",
		name: "Kuwaiti Dinar"
	},
	{
		code: "OMR",
		name: "Omani Rial"
	},
	{
		code: "BHD",
		name: "Bahraini Dinar"
	},
	{
		code: "ILS",
		name: "Israeli New Shekel"
	},
	{
		code: "TRY",
		name: "Turkish Lira"
	},
	{
		code: "MYR",
		name: "Malaysian Ringgit"
	},
	{
		code: "IDR",
		name: "Indonesian Rupiah"
	},
	{
		code: "PHP",
		name: "Philippine Peso"
	},
	{
		code: "THB",
		name: "Thai Baht"
	},
	{
		code: "VND",
		name: "Vietnamese Đồng"
	},
	{
		code: "KRW",
		name: "South Korean Won"
	},
	{
		code: "LKR",
		name: "Sri Lankan Rupee"
	},
	{
		code: "PKR",
		name: "Pakistani Rupee"
	},
	{
		code: "BDT",
		name: "Bangladeshi Taka"
	},
	{
		code: "PGK",
		name: "Papua New Guinean Kina"
	},
	{
		code: "FJD",
		name: "Fijian Dollar"
	},
	{
		code: "VUV",
		name: "Vanuatu Vatu"
	},
	{
		code: "SBD",
		name: "Solomon Islands Dollar"
	},
	{
		code: "WST",
		name: "Samoan Tālā"
	},
	{
		code: "TOP",
		name: "Tongan Paʻanga"
	},
	{
		code: "XPF",
		name: "CFP Franc"
	},
	{
		code: "KES",
		name: "Kenyan Shilling"
	},
	{
		code: "TZS",
		name: "Tanzanian Shilling"
	},
	{
		code: "UGX",
		name: "Ugandan Shilling"
	},
	{
		code: "NGN",
		name: "Nigerian Naira"
	},
	{
		code: "GHS",
		name: "Ghanaian Cedi"
	},
	{
		code: "ZMW",
		name: "Zambian Kwacha"
	},
	{
		code: "BWP",
		name: "Botswana Pula"
	},
	{
		code: "NAD",
		name: "Namibian Dollar"
	},
	{
		code: "MUR",
		name: "Mauritian Rupee"
	},
	{
		code: "EGP",
		name: "Egyptian Pound"
	},
	{
		code: "MAD",
		name: "Moroccan Dirham"
	},
	{
		code: "BRL",
		name: "Brazilian Real"
	},
	{
		code: "MXN",
		name: "Mexican Peso"
	},
	{
		code: "CLP",
		name: "Chilean Peso"
	},
	{
		code: "ARS",
		name: "Argentine Peso"
	}
];
const SUPPORTED_MARKETS = [
	{
		code: "NZ",
		name: "New Zealand",
		currency: "NZD"
	},
	{
		code: "AU",
		name: "Australia",
		currency: "AUD"
	},
	{
		code: "ZA",
		name: "South Africa",
		currency: "ZAR"
	},
	{
		code: "US",
		name: "United States",
		currency: "USD"
	},
	{
		code: "GB",
		name: "United Kingdom",
		currency: "GBP"
	},
	{
		code: "IE",
		name: "Ireland",
		currency: "EUR"
	}
];
const OTHER_COUNTRIES = [
	{
		code: "AE",
		name: "United Arab Emirates",
		currency: "AED"
	},
	{
		code: "AR",
		name: "Argentina",
		currency: "ARS"
	},
	{
		code: "AT",
		name: "Austria",
		currency: "EUR"
	},
	{
		code: "BD",
		name: "Bangladesh",
		currency: "BDT"
	},
	{
		code: "BE",
		name: "Belgium",
		currency: "EUR"
	},
	{
		code: "BH",
		name: "Bahrain",
		currency: "BHD"
	},
	{
		code: "BR",
		name: "Brazil",
		currency: "BRL"
	},
	{
		code: "BW",
		name: "Botswana",
		currency: "BWP"
	},
	{
		code: "CA",
		name: "Canada",
		currency: "CAD"
	},
	{
		code: "CH",
		name: "Switzerland",
		currency: "CHF"
	},
	{
		code: "CK",
		name: "Cook Islands",
		currency: "NZD"
	},
	{
		code: "CL",
		name: "Chile",
		currency: "CLP"
	},
	{
		code: "CN",
		name: "China",
		currency: "CNY"
	},
	{
		code: "CY",
		name: "Cyprus",
		currency: "EUR"
	},
	{
		code: "DE",
		name: "Germany",
		currency: "EUR"
	},
	{
		code: "DK",
		name: "Denmark",
		currency: "DKK"
	},
	{
		code: "EE",
		name: "Estonia",
		currency: "EUR"
	},
	{
		code: "EG",
		name: "Egypt",
		currency: "EGP"
	},
	{
		code: "ES",
		name: "Spain",
		currency: "EUR"
	},
	{
		code: "FI",
		name: "Finland",
		currency: "EUR"
	},
	{
		code: "FJ",
		name: "Fiji",
		currency: "FJD"
	},
	{
		code: "FR",
		name: "France",
		currency: "EUR"
	},
	{
		code: "GH",
		name: "Ghana",
		currency: "GHS"
	},
	{
		code: "GR",
		name: "Greece",
		currency: "EUR"
	},
	{
		code: "HK",
		name: "Hong Kong SAR",
		currency: "HKD"
	},
	{
		code: "HR",
		name: "Croatia",
		currency: "EUR"
	},
	{
		code: "ID",
		name: "Indonesia",
		currency: "IDR"
	},
	{
		code: "IL",
		name: "Israel",
		currency: "ILS"
	},
	{
		code: "IN",
		name: "India",
		currency: "INR"
	},
	{
		code: "IT",
		name: "Italy",
		currency: "EUR"
	},
	{
		code: "JP",
		name: "Japan",
		currency: "JPY"
	},
	{
		code: "KE",
		name: "Kenya",
		currency: "KES"
	},
	{
		code: "KI",
		name: "Kiribati",
		currency: "AUD"
	},
	{
		code: "KR",
		name: "South Korea",
		currency: "KRW"
	},
	{
		code: "KW",
		name: "Kuwait",
		currency: "KWD"
	},
	{
		code: "LK",
		name: "Sri Lanka",
		currency: "LKR"
	},
	{
		code: "LT",
		name: "Lithuania",
		currency: "EUR"
	},
	{
		code: "LU",
		name: "Luxembourg",
		currency: "EUR"
	},
	{
		code: "LV",
		name: "Latvia",
		currency: "EUR"
	},
	{
		code: "MA",
		name: "Morocco",
		currency: "MAD"
	},
	{
		code: "MT",
		name: "Malta",
		currency: "EUR"
	},
	{
		code: "MU",
		name: "Mauritius",
		currency: "MUR"
	},
	{
		code: "MX",
		name: "Mexico",
		currency: "MXN"
	},
	{
		code: "MY",
		name: "Malaysia",
		currency: "MYR"
	},
	{
		code: "NA",
		name: "Namibia",
		currency: "NAD"
	},
	{
		code: "NC",
		name: "New Caledonia",
		currency: "XPF"
	},
	{
		code: "NG",
		name: "Nigeria",
		currency: "NGN"
	},
	{
		code: "NL",
		name: "Netherlands",
		currency: "EUR"
	},
	{
		code: "NO",
		name: "Norway",
		currency: "NOK"
	},
	{
		code: "NR",
		name: "Nauru",
		currency: "AUD"
	},
	{
		code: "NU",
		name: "Niue",
		currency: "NZD"
	},
	{
		code: "OM",
		name: "Oman",
		currency: "OMR"
	},
	{
		code: "PF",
		name: "French Polynesia",
		currency: "XPF"
	},
	{
		code: "PG",
		name: "Papua New Guinea",
		currency: "PGK"
	},
	{
		code: "PH",
		name: "Philippines",
		currency: "PHP"
	},
	{
		code: "PK",
		name: "Pakistan",
		currency: "PKR"
	},
	{
		code: "PL",
		name: "Poland",
		currency: "PLN"
	},
	{
		code: "PT",
		name: "Portugal",
		currency: "EUR"
	},
	{
		code: "QA",
		name: "Qatar",
		currency: "QAR"
	},
	{
		code: "SA",
		name: "Saudi Arabia",
		currency: "SAR"
	},
	{
		code: "SB",
		name: "Solomon Islands",
		currency: "SBD"
	},
	{
		code: "SE",
		name: "Sweden",
		currency: "SEK"
	},
	{
		code: "SG",
		name: "Singapore",
		currency: "SGD"
	},
	{
		code: "SI",
		name: "Slovenia",
		currency: "EUR"
	},
	{
		code: "SK",
		name: "Slovakia",
		currency: "EUR"
	},
	{
		code: "TH",
		name: "Thailand",
		currency: "THB"
	},
	{
		code: "TO",
		name: "Tonga",
		currency: "TOP"
	},
	{
		code: "TR",
		name: "Türkiye",
		currency: "TRY"
	},
	{
		code: "TV",
		name: "Tuvalu",
		currency: "AUD"
	},
	{
		code: "TZ",
		name: "Tanzania",
		currency: "TZS"
	},
	{
		code: "UG",
		name: "Uganda",
		currency: "UGX"
	},
	{
		code: "VN",
		name: "Vietnam",
		currency: "VND"
	},
	{
		code: "VU",
		name: "Vanuatu",
		currency: "VUV"
	},
	{
		code: "WS",
		name: "Samoa",
		currency: "WST"
	},
	{
		code: "ZM",
		name: "Zambia",
		currency: "ZMW"
	},
	{
		code: "ZW",
		name: "Zimbabwe",
		currency: "USD"
	}
];
const COUNTRIES = [...SUPPORTED_MARKETS, ...OTHER_COUNTRIES];
const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));
const CURRENCY_BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));
const resolveCompanyCurrency = (company) => isCurrencyCodeShape(company?.baseCurrency) ? company.baseCurrency : "AUD";
function resolveProjectCurrency(project, company) {
	if (isCurrencyCodeShape(project?.currency)) return project.currency;
	return resolveCompanyCurrency(company);
}

//#endregion
export { ALLOCATION_KEYS, APPROVE_CLAIM_KEYS, CALC_VERSION, CLAIM_APPROVABLE_STATUSES, CLAIM_COUNTER_ID, CLAIM_LINE_KEYS, CLAIM_NOTES_MAX, CLAIM_PROBLEM, CLAIM_PROCESSING_ROLES, CLAIM_REF_MAX, CLAIM_REJECTABLE_STATUSES, CLAIM_STATUS, CLAIM_TRANSITIONS, CREATE_CLAIM_KEYS, CREATE_INVOICE_KEYS, CREDIT_DRAFT_KEYS, CREDIT_LINE_KEYS, CURRENT_CALC_VERSION, INVOICE_COUNTER_ID, INVOICE_LINE_KEYS, INVOICE_MAX_LINES, INVOICE_NOTES_MAX, INVOICE_PROBLEM, INVOICE_PROCESSING_ROLES, INVOICE_TEXT_MAX, INVOICE_TRANSITION, INVOICE_TRANSITION_KEYS, LINK_INVOICE_KEYS, MALFORMED_ENTRY_IDS_MAX, PAYMENT_DRAFT_KEYS, PAYMENT_STATUS, REJECT_CLAIM_KEYS, RELEASE_DRAFT_KEYS, RR_STATUS, SCN_STATUS, SETTLEMENT_COUNTER_ID, SETTLEMENT_NOTES_MAX, SETTLEMENT_POST_KEYS, SETTLEMENT_PROBLEM, SETTLEMENT_ROLES, SETTLEMENT_TEXT_MAX, SETTLEMENT_VOID_KEYS, SI_SOURCE, SI_STATUS, SUPPLIER_LEDGER_KIND, SUPPLIER_LEDGER_TOTAL_KEYS, SUPPLIER_LEDGER_VERSION, UPDATE_CLAIM_KEYS, UPDATE_INVOICE_KEYS, allocateSupplierCredit, allocateSupplierRelease, applyClaimApproval, applyClaimClosed, applyClaimOpened, applySupplierCredit, applySupplierCreditVoid, applySupplierPayment, applySupplierPaymentVoid, applySupplierRelease, applySupplierReleaseVoid, apportionClaimSourcedGst, approveClaimRequestProblem, buildClaimApproval, buildClaimDraft, buildClaimDraftUpdate, buildClaimSourceLines, buildClaimSourcedInvoice, buildCreditDraft, buildCreditDraftUpdate, buildDirectInvoice, buildInvoiceDraftUpdate, buildPaymentDraft, buildPaymentFields, buildReleaseDraft, buildReleaseDraftUpdate, calcVersionOf, canTransition as canTransitionClaim, canTransition$1 as canTransitionInvoice, certifiedClaimGst, claimDraftAlreadyHolds, claimInvoiceLink as claimInvoiceLinkOf, claimInvoicePairingProblem, claimSubmittedSideProblem, correctiveVoidProblem, createClaimRequestProblem, createInvoiceRequestProblem, creditDraftRequestProblem, creditGroupKey, creditPosting, creditVoiding, emptyPoClaimLedger, emptySupplierLedger, existingLinkProblem, formatClaimNumber, formatRetentionReleaseNumber, formatSupplierCreditNoteNumber, formatSupplierInvoiceNumber, formatSupplierPaymentNumber, invoiceDraftAlreadyHolds, invoiceStoredProblem, invoiceTransitionRequestProblem, latestPostableDate, linkInvoiceRequestProblem, paymentAllocationProblem, paymentDraftRequestProblem, paymentPosting, paymentVoiding, poClaimLedgerDocument, poClaimLedgersFromHistory, postPairingProblem, previouslyApprovedCents, readPoClaimLedger, readSupplierLedger, rejectClaimRequestProblem, releaseDraftRequestProblem, releasePosting, releaseVoidDependency, releaseVoidProblem, releaseVoiding, resolveProjectCurrency, sameClaimApproval, settlementPostRequestProblem, settlementVoidRequestProblem, storedPoClaimLedgerProblem, storedSupplierLedgerProblem, supplierCreditCents, supplierInvoiceFigures, supplierLedgerDocument, supplierLedgerExcess, supplierLedgerFromRegisters, supplierLedgerPosition, supplierLedgerProblem, supplierLedgersFromHistory, updateClaimRequestProblem, updateInvoiceRequestProblem, variationLedgerKey };