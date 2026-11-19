// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/finalAccount.js and the
// modules it imports. Regenerate with `npm run functions:calc` (from frontend/).
// ADR-77: the trusted approveFinalAccount callable runs this exact calculation.
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
const adjustmentFor = (adjustmentsByPoLine, poId, idx) => roundMoney(Number(adjustmentsByPoLine?.[poId]?.[idx]) || 0);
const revisedLineTotal = (li, adjustment = 0) => roundMoney((Number(li?.lineTotal) || 0) + (Number(adjustment) || 0));
function remainingCommittedByPoLine(purchaseOrders, invoicedByPoLine = {}, recognisedByPoLine = {}, adjustmentsByPoLine = {}) {
	const map = {};
	for (const po of purchaseOrders) {
		if (!PO_COMMITTED_STATUSES.includes(po.status)) continue;
		const invForPo = invoicedByPoLine[po.id] ?? {};
		const recForPo = recognisedByPoLine[po.id] ?? {};
		const forPo = {};
		(po.lineItems ?? []).forEach((li, idx) => {
			const revised = revisedLineTotal(li, adjustmentFor(adjustmentsByPoLine, po.id, idx));
			forPo[idx] = Math.max(roundMoney(revised - (invForPo[idx] || 0) - (recForPo[idx] || 0)), 0);
		});
		map[po.id] = forPo;
	}
	return map;
}
function remainingCommittedByCostCode(purchaseOrders, invoicedByPoLine = {}, recognisedByPoLine = {}, adjustmentsByPoLine = {}) {
	const map = {};
	const byLine = remainingCommittedByPoLine(purchaseOrders, invoicedByPoLine, recognisedByPoLine, adjustmentsByPoLine);
	for (const po of purchaseOrders) {
		const forPo = byLine[po.id];
		if (!forPo) continue;
		(po.lineItems ?? []).forEach((li, idx) => {
			if (!li.costCodeId) return;
			const remaining = forPo[idx] || 0;
			if (remaining <= 0) return;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + remaining);
		});
	}
	return map;
}
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
const safeAmount = (n) => {
	const v = typeof n === "number" ? n : Number(n);
	return Number.isFinite(v) ? v : 0;
};
const toCents$1 = (n) => Math.round(safeAmount(n) * 100);
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
function remainingBalance(invoiceTotal, settled) {
	return roundMoney(safeAmount(invoiceTotal) - safeAmount(settled));
}
function reconciliationState(invoiceTotal, settled) {
	const total = toCents$1(invoiceTotal);
	const paid = toCents$1(settled);
	if (paid <= 0) return RECONCILIATION_STATE.UNRECONCILED;
	if (paid < total) return RECONCILIATION_STATE.PARTLY;
	if (paid === total) return RECONCILIATION_STATE.FULLY;
	return RECONCILIATION_STATE.OVER;
}

//#endregion
//#region src/lib/sourceLine.js
function indexOrNull(v) {
	return Number.isInteger(v) && v >= 0 ? v : null;
}
const isVariationOriginLine = (li) => typeof li?.variationId === "string" && li.variationId.length > 0;

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
const CLAIM_OPEN_STATUSES = [
	CLAIM_STATUS.DRAFT,
	CLAIM_STATUS.SUBMITTED,
	CLAIM_STATUS.UNDER_REVIEW
];
const CLAIM_APPROVED_STATUSES = [CLAIM_STATUS.APPROVED, CLAIM_STATUS.INVOICED];
const CLAIM_PENDING_STATUSES = [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW];
const CLAIMABLE_PO_STATUSES = [PO_STATUS.SENT];
const CLAIM_LINK_INITIAL = Object.freeze({
	supplierInvoiceId: null,
	supplierInvoiceLinkedAt: null,
	supplierInvoiceLinkedBy: null
});
function actualClaimsByCostCode(claims, excludeClaimIds = /* @__PURE__ */ new Set()) {
	const map = {};
	for (const claim of claims) {
		if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue;
		if (excludeClaimIds.has(claim.id)) continue;
		for (const li of claim.lineItems ?? []) {
			if (!li.costCodeId) continue;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (li.approvedThisPeriod || 0));
		}
	}
	return map;
}
function recognisedClaimsByPoLine(claims, excludeClaimIds = /* @__PURE__ */ new Set()) {
	const map = {};
	for (const claim of claims) {
		if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue;
		if (excludeClaimIds.has(claim.id)) continue;
		if (!claim.poId) continue;
		const forPo = map[claim.poId] ?? (map[claim.poId] = {});
		for (const li of claim.lineItems ?? []) {
			if (isVariationOriginLine(li) || li.poLineIndex == null) continue;
			forPo[li.poLineIndex] = roundMoney((forPo[li.poLineIndex] || 0) + (li.approvedThisPeriod || 0));
		}
	}
	return map;
}
function recognisedClaimsByVariationLine(claims, excludeClaimIds = /* @__PURE__ */ new Set()) {
	const map = {};
	for (const claim of claims ?? []) {
		if (!CLAIM_APPROVED_STATUSES.includes(claim.status)) continue;
		if (excludeClaimIds.has(claim.id)) continue;
		for (const li of claim.lineItems ?? []) {
			if (!isVariationOriginLine(li)) continue;
			const idx = indexOrNull(li.variationLineIndex);
			if (idx === null) continue;
			const forVar = map[li.variationId] ?? (map[li.variationId] = {});
			forVar[idx] = roundMoney((forVar[idx] || 0) + (li.approvedThisPeriod || 0));
		}
	}
	return map;
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
function claimedPendingByCostCode(claims) {
	const map = {};
	for (const claim of claims) {
		if (!CLAIM_PENDING_STATUSES.includes(claim.status)) continue;
		for (const li of claim.lineItems ?? []) {
			if (!li.costCodeId) continue;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (li.claimedThisPeriod || 0));
		}
	}
	return map;
}
const CLAIM_EDITABLE_STATUSES = [CLAIM_STATUS.DRAFT];

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
const SI_COUNTING_STATUSES = [SI_STATUS.POSTED, SI_STATUS.PAID];
const SI_EDITABLE_STATUSES = [SI_STATUS.DRAFT];
const INVOICEABLE_PO_STATUSES = [PO_STATUS.SENT, PO_STATUS.CLOSED];
const TAX_CODE$2 = {
	GST: "gst",
	GST_FREE: "gst_free",
	INPUT_TAXED: "input_taxed"
};
const TAX_CODES$2 = Object.values(TAX_CODE$2);
const TAX_CODE_LABELS$2 = {
	[TAX_CODE$2.GST]: "GST 10%",
	[TAX_CODE$2.GST_FREE]: "GST-free",
	[TAX_CODE$2.INPUT_TAXED]: "Input-taxed"
};
function gstForLine(amount, taxCode) {
	const amt = Number(amount) || 0;
	return taxCode === TAX_CODE$2.GST ? roundMoney(amt * GST_RATE) : 0;
}
function invoicedByCostCode(invoices) {
	const map = {};
	for (const inv of invoices) {
		if (!SI_COUNTING_STATUSES.includes(inv.status)) continue;
		for (const li of inv.lineItems ?? []) {
			if (!li.costCodeId) continue;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.amount) || 0));
		}
	}
	return map;
}
function postedInvoicedByPoLine(invoices) {
	const map = {};
	for (const inv of invoices) {
		if (!SI_COUNTING_STATUSES.includes(inv.status)) continue;
		if (!inv.poId) continue;
		const forPo = map[inv.poId] ?? (map[inv.poId] = {});
		for (const li of inv.lineItems ?? []) {
			if (isVariationOriginLine(li) || li.poLineIndex == null) continue;
			forPo[li.poLineIndex] = roundMoney((forPo[li.poLineIndex] || 0) + (Number(li.amount) || 0));
		}
	}
	return map;
}
function postedInvoicedByVariationLine(invoices) {
	const map = {};
	for (const inv of invoices ?? []) {
		if (!SI_COUNTING_STATUSES.includes(inv.status)) continue;
		for (const li of inv.lineItems ?? []) {
			if (!isVariationOriginLine(li)) continue;
			const idx = indexOrNull(li.variationLineIndex);
			if (idx === null) continue;
			const forVar = map[li.variationId] ?? (map[li.variationId] = {});
			forVar[idx] = roundMoney((forVar[idx] || 0) + (Number(li.amount) || 0));
		}
	}
	return map;
}
function invoicedClaimIds(invoices) {
	const set = /* @__PURE__ */ new Set();
	for (const inv of invoices) {
		if (!SI_COUNTING_STATUSES.includes(inv.status)) continue;
		if (inv.progressClaimId) set.add(inv.progressClaimId);
	}
	return set;
}

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
const postedSupplierCreditNotes = (creditNotes) => (creditNotes ?? []).filter((cn) => SCN_COUNTING_STATUSES.includes(cn.status));
const draftSupplierCreditNotes = (creditNotes) => (creditNotes ?? []).filter((cn) => cn.status === SCN_STATUS.DRAFT);
function creditNoteTotals(lineItems) {
	const subtotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.amount) || 0), 0));
	const gstTotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li.gstAmount) || 0), 0));
	return {
		subtotal,
		gstTotal,
		grossTotal: roundMoney(subtotal + gstTotal)
	};
}
const normaliseName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
function creditTargetException(creditNote, invoiceById) {
	const inv = invoiceById?.get?.(creditNote?.supplierInvoiceId) ?? null;
	if (!inv) return "The target supplier invoice no longer exists or is not readable.";
	if (!SI_COUNTING_STATUSES.includes(inv.status)) return `${inv.invoiceNumber} is ${inv.status} — a credit note only counts against a posted supplier invoice.`;
	if (!(inv.supplierId || creditNote.supplierId ? inv.supplierId === creditNote.supplierId : normaliseName(inv.supplierName) === normaliseName(creditNote.supplierName))) return `${inv.invoiceNumber} belongs to a different supplier (${inv.supplierName || "unknown"}) than this credit note.`;
	if (inv.currency !== creditNote.currency) return `${inv.invoiceNumber} is denominated in ${inv.currency || "an unknown currency"}, not ${creditNote.currency || "unknown"}.`;
	if (toCents$1(safeAmount(inv.retentionTotal)) !== 0) return `${inv.invoiceNumber} now withholds retention (${roundMoney(safeAmount(inv.retentionTotal)).toFixed(2)}) — a retained invoice cannot carry a credit note in this foundation.`;
	const lines = creditNote?.lineItems;
	if (!Array.isArray(lines) || lines.length === 0) return "The credit note carries no readable line items, so its stored totals cannot be verified.";
	const targetCostCodeIds = new Set(targetInvoiceCostCodes(inv).map((cc) => cc.costCodeId));
	for (let i = 0; i < lines.length; i++) {
		const li = lines[i];
		const amount = Number(li?.amount);
		if (!Number.isFinite(amount) || toCents$1(amount) <= 0) return `Line ${i + 1} does not carry a positive ex-GST amount, so this credit note's totals cannot be trusted.`;
		if (!TAX_CODES$2.includes(li?.taxCode)) return `Line ${i + 1} carries an unknown tax code, so its GST cannot be verified.`;
		if (toCents$1(safeAmount(li.gstAmount)) !== toCents$1(gstForLine(amount, li.taxCode))) return `Line ${i + 1}'s stored GST does not match its ex-GST amount and tax code.`;
		if (!li.costCodeId || !targetCostCodeIds.has(li.costCodeId)) return `Line ${i + 1} credits a cost code that is not on ${inv.invoiceNumber} — a credit may only reduce cost codes the invoice charged.`;
	}
	const totals = creditNoteTotals(lines);
	if (toCents$1(totals.subtotal) !== toCents$1(safeAmount(creditNote.subtotal)) || toCents$1(totals.gstTotal) !== toCents$1(safeAmount(creditNote.gstTotal)) || toCents$1(totals.grossTotal) !== toCents$1(safeAmount(creditNote.grossTotal))) return `The stored totals (${roundMoney(safeAmount(creditNote.grossTotal)).toFixed(2)} gross) do not reconcile to the credit note's line items (${totals.grossTotal.toFixed(2)} gross).`;
	if (toCents$1(safeAmount(creditNote.grossTotal)) > toCents$1(safeAmount(inv.payableTotal))) return `The credit note gross (${roundMoney(safeAmount(creditNote.grossTotal)).toFixed(2)}) exceeds ${inv.invoiceNumber}'s payable total (${roundMoney(safeAmount(inv.payableTotal)).toFixed(2)}).`;
	return null;
}
const invoicesById = (invoices) => new Map((invoices ?? []).map((inv) => [inv.id, inv]));
function creditedByInvoice(creditNotes, invoices) {
	const byId = invoicesById(invoices);
	const map = {};
	for (const cn of postedSupplierCreditNotes(creditNotes)) {
		if (creditTargetException(cn, byId) !== null) continue;
		map[cn.supplierInvoiceId] = roundMoney((map[cn.supplierInvoiceId] || 0) + safeAmount(cn.grossTotal));
	}
	return map;
}
function creditedByCostCode(creditNotes, invoices) {
	const byId = invoicesById(invoices);
	const map = {};
	for (const cn of postedSupplierCreditNotes(creditNotes)) {
		if (creditTargetException(cn, byId) !== null) continue;
		for (const li of cn.lineItems ?? []) {
			if (!li.costCodeId) continue;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.amount) || 0));
		}
	}
	return map;
}
function targetInvoiceCostCodes(invoice) {
	const seen = /* @__PURE__ */ new Map();
	for (const li of invoice?.lineItems ?? []) {
		if (!li.costCodeId) continue;
		if (!seen.has(li.costCodeId)) seen.set(li.costCodeId, li.costCodeName || "");
	}
	return [...seen.entries()].map(([costCodeId, costCodeName]) => ({
		costCodeId,
		costCodeName
	}));
}

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
function approvedSupplierVariationsByCostCode(variations) {
	const map = {};
	for (const v of variations) {
		if (v.variationType !== VARIATION_TYPE.SUPPLIER) continue;
		if (!VARIATION_APPROVED_STATUSES.includes(v.status)) continue;
		for (const li of v.lineItems ?? []) {
			if (!li.costCodeId) continue;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.approvedAmount) || 0));
		}
	}
	return map;
}
function sumSubtotals(variations, type, statuses, side) {
	const key = side === "approved" ? "approvedSubtotal" : "submittedSubtotal";
	let sum = 0;
	for (const v of variations) {
		if (v.variationType !== type) continue;
		if (!statuses.includes(v.status)) continue;
		sum += Number(v[key]) || 0;
	}
	return roundMoney(sum);
}
function pendingSupplierVariationExposureByCostCode(variations) {
	const map = {};
	for (const v of variations) {
		if (v.variationType !== VARIATION_TYPE.SUPPLIER) continue;
		if (!VARIATION_PENDING_STATUSES.includes(v.status)) continue;
		for (const li of v.lineItems ?? []) {
			if (!li.costCodeId) continue;
			map[li.costCodeId] = roundMoney((map[li.costCodeId] || 0) + (Number(li.submittedAmount) || 0));
		}
	}
	return map;
}
const approvedSupplierVariationsTotal = (variations) => sumSubtotals(variations, VARIATION_TYPE.SUPPLIER, VARIATION_APPROVED_STATUSES, "approved");
const pendingSupplierVariationExposureTotal = (variations) => sumSubtotals(variations, VARIATION_TYPE.SUPPLIER, VARIATION_PENDING_STATUSES, "submitted");
const approvedClientVariationsTotal = (variations) => sumSubtotals(variations, VARIATION_TYPE.CLIENT, VARIATION_APPROVED_STATUSES, "approved");
const pendingClientVariationExposureTotal = (variations) => sumSubtotals(variations, VARIATION_TYPE.CLIENT, VARIATION_PENDING_STATUSES, "submitted");
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
const sumAmounts = (rows) => roundMoney(rows.reduce((s, r) => s + (r.amount ?? 0), 0));
const grossApproved = (variation) => roundMoney((variation?.lineItems ?? []).reduce((s, li) => s + (Number(li?.approvedAmount) || 0), 0));
const isPositiveNewScope = (l) => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE && l.amount > 0;
const isNegativeNewScope = (l) => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE && l.amount < 0;
function variationIncorporation(variation, purchaseOrders) {
	const gross = grossApproved(variation);
	const empty = {
		applied: false,
		scopeCommitted: false,
		po: null,
		lines: [],
		gross,
		matured: 0,
		outstanding: gross,
		newScope: 0,
		committedNewScope: 0,
		uncommittedNewScope: 0,
		negativeNewScope: 0,
		invalid: 0,
		counts: {
			existing: 0,
			newScope: 0,
			newScopePositive: 0,
			newScopeNegative: 0,
			invalid: 0
		}
	};
	if (!isPoLinkedSupplierVariation(variation)) return {
		state: INCORPORATION_STATE.NOT_APPLICABLE,
		...empty
	};
	if (!VARIATION_APPROVED_STATUSES.includes(variation.status)) return {
		state: INCORPORATION_STATE.NOT_APPROVED,
		...empty,
		gross: 0,
		outstanding: 0
	};
	const po = (purchaseOrders ?? []).find((p) => p?.id === variation.poId) ?? null;
	if (!isCommitmentApplied(variation)) return {
		state: INCORPORATION_STATE.UNAPPLIED,
		...empty,
		po,
		scopeCommitted: isScopeCommitted(variation)
	};
	const scopeCommitted = isScopeCommitted(variation);
	const lines = classifyCommitmentLines(variation, po);
	const existing = lines.filter((l) => l.kind === COMMITMENT_LINE_KIND.EXISTING_LINE);
	const newScope = lines.filter((l) => l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE);
	const positive = newScope.filter(isPositiveNewScope);
	const negative = newScope.filter(isNegativeNewScope);
	const invalid = lines.filter((l) => l.kind === COMMITMENT_LINE_KIND.INVALID);
	const counts = {
		existing: existing.length,
		newScope: newScope.length,
		newScopePositive: positive.length,
		newScopeNegative: negative.length,
		invalid: invalid.length
	};
	const committedNewScope = scopeCommitted ? sumAmounts(positive) : 0;
	const matured = roundMoney(sumAmounts(existing) + committedNewScope);
	const totals = {
		matured,
		outstanding: roundMoney(gross - matured),
		newScope: sumAmounts(newScope),
		committedNewScope,
		uncommittedNewScope: scopeCommitted ? 0 : sumAmounts(positive),
		negativeNewScope: sumAmounts(negative),
		invalid: sumAmounts(invalid)
	};
	let state;
	if (invalid.length > 0) state = INCORPORATION_STATE.EXCEPTION;
	else if (positive.length > 0 && !scopeCommitted) state = existing.length > 0 ? INCORPORATION_STATE.PARTIAL : INCORPORATION_STATE.NOT_INCORPORATED;
	else if (negative.length > 0) state = INCORPORATION_STATE.NEGATIVE_NEW_SCOPE;
	else state = INCORPORATION_STATE.INCORPORATED;
	return {
		state,
		applied: true,
		scopeCommitted,
		po,
		lines,
		gross,
		...totals,
		counts
	};
}
function appliedSupplierVariationAdjustments(variations, purchaseOrders) {
	const byPoLine = {};
	const byCostCode = {};
	const newScopeByCostCode = {};
	const newScopeLines = {};
	const committedNewScopeByCostCode = {};
	const exceptions = [];
	const incorporations = {};
	const seen = /* @__PURE__ */ new Set();
	for (const v of variations ?? []) {
		if (!v || !isPoLinkedSupplierVariation(v) || !VARIATION_APPROVED_STATUSES.includes(v.status) || !isCommitmentApplied(v)) continue;
		if (v.id && seen.has(v.id)) continue;
		if (v.id) seen.add(v.id);
		const inc = variationIncorporation(v, purchaseOrders);
		if (v.id) incorporations[v.id] = inc;
		for (const l of inc.lines) if (l.kind === COMMITMENT_LINE_KIND.EXISTING_LINE) {
			const forPo = byPoLine[v.poId] ?? (byPoLine[v.poId] = {});
			forPo[l.poLineIndex] = roundMoney((forPo[l.poLineIndex] || 0) + l.amount);
			byCostCode[l.poLineCostCodeId] = roundMoney((byCostCode[l.poLineCostCodeId] || 0) + l.amount);
		} else if (l.kind === COMMITMENT_LINE_KIND.NEW_SCOPE) {
			if (l.costCodeId) newScopeByCostCode[l.costCodeId] = roundMoney((newScopeByCostCode[l.costCodeId] || 0) + l.amount);
			if (l.amount > 0 && inc.scopeCommitted && v.id) {
				const forVar = newScopeLines[v.id] ?? (newScopeLines[v.id] = {});
				forVar[l.lineIndex] = {
					amount: l.amount,
					costCodeId: l.costCodeId,
					costCodeName: l.costCodeName,
					description: l.description,
					variationId: v.id,
					variationNumber: v.variationNumber || "",
					lineIndex: l.lineIndex,
					poId: v.poId,
					poNumber: v.poNumber || inc.po?.poNumber || ""
				};
				if (l.costCodeId) committedNewScopeByCostCode[l.costCodeId] = roundMoney((committedNewScopeByCostCode[l.costCodeId] || 0) + l.amount);
			} else if (l.amount < 0) exceptions.push({
				kind: "negative_new_scope",
				issue: "negative_new_scope",
				issueLabel: "Negative new-scope line — not matured or claimable; review for a credit note or a corrected source variation",
				variationId: v.id ?? null,
				variationNumber: v.variationNumber || "",
				poId: v.poId,
				poNumber: v.poNumber || inc.po?.poNumber || "",
				poStatus: inc.po?.status ?? null,
				lineIndex: l.lineIndex,
				poLineIndex: null,
				amount: l.amount,
				costCodeId: l.costCodeId,
				costCodeName: l.costCodeName,
				poLineCostCodeId: null
			});
		} else exceptions.push({
			kind: "invalid_line",
			issue: l.issue,
			issueLabel: COMMITMENT_LINE_ISSUE_LABELS[l.issue] ?? l.issue,
			variationId: v.id ?? null,
			variationNumber: v.variationNumber || "",
			poId: v.poId,
			poNumber: v.poNumber || inc.po?.poNumber || "",
			poStatus: inc.po?.status ?? null,
			lineIndex: l.lineIndex,
			poLineIndex: l.poLineIndex,
			amount: l.amount,
			costCodeId: l.costCodeId,
			costCodeName: l.costCodeName,
			poLineCostCodeId: l.poLineCostCodeId
		});
	}
	for (const po of purchaseOrders ?? []) {
		const forPo = byPoLine[po?.id];
		if (!forPo) continue;
		(po.lineItems ?? []).forEach((li, idx) => {
			if (!(idx in forPo)) return;
			const revised = roundMoney((Number(li?.lineTotal) || 0) + forPo[idx]);
			if (revised < 0) exceptions.push({
				kind: "negative_revised_line",
				issue: "negative_revised_line",
				issueLabel: "Revised PO line value is negative",
				variationId: null,
				variationNumber: "",
				poId: po.id,
				poNumber: po.poNumber || "",
				poStatus: po.status ?? null,
				lineIndex: null,
				poLineIndex: idx,
				amount: revised,
				costCodeId: li?.costCodeId || "",
				costCodeName: li?.costCodeName || "",
				poLineCostCodeId: li?.costCodeId || null
			});
		});
	}
	return {
		byPoLine,
		byCostCode,
		newScopeByCostCode,
		newScopeLines,
		committedNewScopeByCostCode,
		exceptions,
		incorporations
	};
}
function unappliedSupplierVariationsByCostCode(variations, purchaseOrders) {
	const map = {};
	const add = (costCodeId, amount) => {
		if (!costCodeId) return;
		map[costCodeId] = roundMoney((map[costCodeId] || 0) + (amount ?? 0));
	};
	for (const v of variations ?? []) {
		if (!v || v.variationType !== VARIATION_TYPE.SUPPLIER || !VARIATION_APPROVED_STATUSES.includes(v.status)) continue;
		if (!(isPoLinkedSupplierVariation(v) && isCommitmentApplied(v))) {
			for (const li of v.lineItems ?? []) add(li?.costCodeId, Number(li?.approvedAmount) || 0);
			continue;
		}
		const inc = variationIncorporation(v, purchaseOrders);
		for (const l of inc.lines) {
			if (l.kind === COMMITMENT_LINE_KIND.EXISTING_LINE) continue;
			if (inc.scopeCommitted && isPositiveNewScope(l)) continue;
			add(l.costCodeId, l.amount ?? 0);
		}
	}
	return map;
}
const sumMap = (map) => roundMoney(Object.values(map).reduce((s, v) => s + (Number(v) || 0), 0));
const unappliedSupplierVariationsTotal = (variations, purchaseOrders) => sumMap(unappliedSupplierVariationsByCostCode(variations, purchaseOrders));
const appliedSupplierVariationsTotal = (variations, purchaseOrders) => sumMap(appliedSupplierVariationAdjustments(variations, purchaseOrders).byCostCode);
const committedNewScopeTotal = (variations, purchaseOrders) => sumMap(appliedSupplierVariationAdjustments(variations, purchaseOrders).committedNewScopeByCostCode);
function remainingCommittedByVariationLine(newScopeLines, invoicedByVariationLine = {}, recognisedByVariationLine = {}) {
	const map = {};
	for (const [variationId, lines] of Object.entries(newScopeLines ?? {})) {
		const forVar = {};
		for (const [idxKey, l] of Object.entries(lines ?? {})) {
			const inv = Number(invoicedByVariationLine?.[variationId]?.[idxKey]) || 0;
			const rec = Number(recognisedByVariationLine?.[variationId]?.[idxKey]) || 0;
			forVar[idxKey] = Math.max(0, roundMoney((Number(l?.amount) || 0) - inv - rec));
		}
		map[variationId] = forVar;
	}
	return map;
}
function remainingCommittedNewScopeByCostCode(newScopeLines, invoicedByVariationLine = {}, recognisedByVariationLine = {}) {
	const map = {};
	const remaining = remainingCommittedByVariationLine(newScopeLines, invoicedByVariationLine, recognisedByVariationLine);
	for (const [variationId, lines] of Object.entries(newScopeLines ?? {})) for (const [idxKey, l] of Object.entries(lines ?? {})) {
		const r = remaining[variationId]?.[idxKey] || 0;
		if (!(r > 0) || !l?.costCodeId) continue;
		map[l.costCodeId] = roundMoney((map[l.costCodeId] || 0) + r);
	}
	return map;
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
//#region src/lib/commitment.js
function remainingCommitment({ purchaseOrders = [], progressClaims = [], supplierInvoices = [], variations = [] } = {}) {
	const pos = purchaseOrders ?? [];
	const superseded = invoicedClaimIds(supplierInvoices ?? []);
	const invByPoLine = postedInvoicedByPoLine(supplierInvoices ?? []);
	const recByPoLine = recognisedClaimsByPoLine(progressClaims ?? [], superseded);
	const invByVarLine = postedInvoicedByVariationLine(supplierInvoices ?? []);
	const recByVarLine = recognisedClaimsByVariationLine(progressClaims ?? [], superseded);
	const adjustments = appliedSupplierVariationAdjustments(variations ?? [], pos);
	const byPoLine = remainingCommittedByPoLine(pos, invByPoLine, recByPoLine, adjustments.byPoLine);
	const poByCostCode = remainingCommittedByCostCode(pos, invByPoLine, recByPoLine, adjustments.byPoLine);
	const byVariationLine = remainingCommittedByVariationLine(adjustments.newScopeLines, invByVarLine, recByVarLine);
	const newScopeByCostCode = remainingCommittedNewScopeByCostCode(adjustments.newScopeLines, invByVarLine, recByVarLine);
	const byCostCode = {};
	for (const cc of new Set([...Object.keys(poByCostCode), ...Object.keys(newScopeByCostCode)])) {
		const total = roundMoney((poByCostCode[cc] || 0) + (newScopeByCostCode[cc] || 0));
		if (total > 0) byCostCode[cc] = total;
	}
	return {
		byCostCode,
		byPoLine,
		byVariationLine,
		poByCostCode,
		newScopeByCostCode,
		adjustments,
		superseded,
		invByPoLine,
		recByPoLine,
		invByVarLine,
		recByVarLine
	};
}
function closedResidualCommitment(sources = {}) {
	const closed = (sources.purchaseOrders ?? []).filter((po) => po?.status === PO_STATUS.CLOSED);
	return remainingCommitment({
		...sources,
		purchaseOrders: closed
	});
}

//#endregion
//#region src/lib/forecast.js
function safeNumber(value) {
	if (value === null || value === void 0 || value === "") return 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}
function forecastCostToComplete(remainingCommitted, uncommittedCostToComplete) {
	return roundMoney(safeNumber(remainingCommitted) + safeNumber(uncommittedCostToComplete));
}
function forecastFinalCost(actual, remainingCommitted, uncommittedCostToComplete) {
	return roundMoney(safeNumber(actual) + safeNumber(remainingCommitted) + safeNumber(uncommittedCostToComplete));
}
function varianceToBudget(budgeted, forecastFinalCostValue) {
	return roundMoney(safeNumber(budgeted) - safeNumber(forecastFinalCostValue));
}
function remainingBudgetReference(budgeted, actual, remainingCommitted) {
	return roundMoney(safeNumber(budgeted) - safeNumber(actual) - safeNumber(remainingCommitted));
}
function isUnforecasted(uncommittedCostToComplete) {
	return uncommittedCostToComplete === null || uncommittedCostToComplete === void 0;
}
function isOverBudget(varianceValue) {
	return roundMoney(safeNumber(varianceValue)) < 0;
}
function buildForecastRows({ costCodes = [], budgetLines = [], purchaseOrders = [], progressClaims = [], supplierInvoices = [], supplierCreditNotes = [], variations = [], forecastLines = [] }) {
	const sources = {
		purchaseOrders,
		progressClaims,
		supplierInvoices,
		variations
	};
	const commitment = remainingCommitment(sources);
	const { superseded, adjustments } = commitment;
	const committedMap = commitment.byCostCode;
	const closedResidualMap = closedResidualCommitment(sources).byCostCode;
	const invoicedMap = invoicedByCostCode(supplierInvoices);
	const creditedMap = creditedByCostCode(supplierCreditNotes, supplierInvoices);
	const claimActualMap = actualClaimsByCostCode(progressClaims, superseded);
	const actualMap = {};
	for (const cc of new Set([
		...Object.keys(claimActualMap),
		...Object.keys(invoicedMap),
		...Object.keys(creditedMap)
	])) actualMap[cc] = roundMoney((claimActualMap[cc] || 0) + (invoicedMap[cc] || 0) - (creditedMap[cc] || 0));
	const approvedSVMap = approvedSupplierVariationsByCostCode(variations);
	const appliedSVMap = adjustments.byCostCode;
	const committedNewScopeMap = adjustments.committedNewScopeByCostCode;
	const unappliedSVMap = unappliedSupplierVariationsByCostCode(variations, purchaseOrders);
	const pendingSVMap = pendingSupplierVariationExposureByCostCode(variations);
	const budgetedMap = {};
	const budgetNameMap = {};
	for (const l of budgetLines) {
		if (!l.costCodeId) continue;
		budgetedMap[l.costCodeId] = roundMoney((budgetedMap[l.costCodeId] || 0) + (Number(l.budgeted) || 0));
		if (l.costCodeName) budgetNameMap[l.costCodeId] = l.costCodeName;
	}
	const forecastMap = {};
	for (const f of forecastLines) {
		const key = f.costCodeId || f.id;
		if (key) forecastMap[key] = f;
	}
	const codeMap = {};
	for (const cc of costCodes) codeMap[cc.id] = cc;
	const ids = new Set([
		...Object.keys(budgetedMap),
		...Object.keys(committedMap),
		...Object.keys(actualMap),
		...Object.keys(approvedSVMap),
		...Object.keys(pendingSVMap),
		...Object.keys(forecastMap)
	]);
	const rows = [];
	for (const id of ids) {
		const cc = codeMap[id];
		const forecast = forecastMap[id] || null;
		const costCodeName = cc ? `${cc.code} — ${cc.name}` : forecast?.costCodeName || budgetNameMap[id] || "Unknown cost code";
		rows.push({
			costCodeId: id,
			costCodeName,
			isInactive: !!cc && cc.isActive === false,
			isMissing: !cc,
			hasBudgetLine: Object.prototype.hasOwnProperty.call(budgetedMap, id),
			budgeted: Object.prototype.hasOwnProperty.call(budgetedMap, id) ? budgetedMap[id] : null,
			actual: actualMap[id] || 0,
			remainingCommitted: committedMap[id] || 0,
			closedResidual: closedResidualMap[id] || 0,
			approvedClaimsAwaitingInvoice: claimActualMap[id] || 0,
			approvedSupplierVariations: approvedSVMap[id] || 0,
			appliedSupplierVariations: appliedSVMap[id] || 0,
			committedNewScopeVariations: committedNewScopeMap[id] || 0,
			unappliedSupplierVariations: unappliedSVMap[id] || 0,
			pendingSupplierVariationExposure: pendingSVMap[id] || 0,
			storedUncommittedCostToComplete: forecast ? forecast.uncommittedCostToComplete ?? null : null,
			notes: forecast?.notes || "",
			updatedAt: forecast?.updatedAt || null,
			updatedBy: forecast?.updatedBy || null,
			hasForecastLine: !!forecast
		});
	}
	rows.sort((a, b) => a.costCodeName.localeCompare(b.costCodeName));
	return rows;
}
function composeForecastRow(row, uncommittedCostToComplete) {
	const ffc = forecastFinalCost(row.actual, row.remainingCommitted, uncommittedCostToComplete);
	const variance = varianceToBudget(row.budgeted ?? 0, ffc);
	return {
		...row,
		uncommittedCostToComplete,
		costToComplete: forecastCostToComplete(row.remainingCommitted, uncommittedCostToComplete),
		forecastFinalCost: ffc,
		varianceToBudget: variance,
		remainingBudgetRef: remainingBudgetReference(row.budgeted ?? 0, row.actual, row.remainingCommitted),
		unforecasted: isUnforecasted(uncommittedCostToComplete),
		overBudget: row.hasBudgetLine ? isOverBudget(variance) : false
	};
}
function forecastRollups(rows) {
	const acc = {
		budgeted: 0,
		actual: 0,
		remainingCommitted: 0,
		uncommittedCostToComplete: 0,
		costToComplete: 0,
		forecastFinalCost: 0,
		approvedSupplierVariations: 0,
		appliedSupplierVariations: 0,
		committedNewScopeVariations: 0,
		unappliedSupplierVariations: 0,
		pendingSupplierVariationExposure: 0,
		closedResidual: 0,
		approvedClaimsAwaitingInvoice: 0,
		unforecastedCount: 0,
		overBudgetCount: 0
	};
	for (const r of rows) {
		acc.budgeted += safeNumber(r.budgeted);
		acc.actual += safeNumber(r.actual);
		acc.remainingCommitted += safeNumber(r.remainingCommitted);
		acc.uncommittedCostToComplete += safeNumber(r.uncommittedCostToComplete);
		acc.costToComplete += safeNumber(r.costToComplete);
		acc.forecastFinalCost += safeNumber(r.forecastFinalCost);
		acc.approvedSupplierVariations += safeNumber(r.approvedSupplierVariations);
		acc.appliedSupplierVariations += safeNumber(r.appliedSupplierVariations);
		acc.committedNewScopeVariations += safeNumber(r.committedNewScopeVariations);
		acc.unappliedSupplierVariations += safeNumber(r.unappliedSupplierVariations);
		acc.pendingSupplierVariationExposure += safeNumber(r.pendingSupplierVariationExposure);
		acc.closedResidual += safeNumber(r.closedResidual);
		acc.approvedClaimsAwaitingInvoice += safeNumber(r.approvedClaimsAwaitingInvoice);
		if (r.unforecasted) acc.unforecastedCount += 1;
		if (r.overBudget) acc.overBudgetCount += 1;
	}
	const budgeted = roundMoney(acc.budgeted);
	const forecastFinalCostValue = roundMoney(acc.forecastFinalCost);
	return {
		budgeted,
		actual: roundMoney(acc.actual),
		remainingCommitted: roundMoney(acc.remainingCommitted),
		uncommittedCostToComplete: roundMoney(acc.uncommittedCostToComplete),
		costToComplete: roundMoney(acc.costToComplete),
		forecastFinalCost: forecastFinalCostValue,
		varianceToBudget: roundMoney(budgeted - forecastFinalCostValue),
		approvedSupplierVariations: roundMoney(acc.approvedSupplierVariations),
		appliedSupplierVariations: roundMoney(acc.appliedSupplierVariations),
		committedNewScopeVariations: roundMoney(acc.committedNewScopeVariations),
		unappliedSupplierVariations: roundMoney(acc.unappliedSupplierVariations),
		pendingSupplierVariationExposure: roundMoney(acc.pendingSupplierVariationExposure),
		closedResidual: roundMoney(acc.closedResidual),
		approvedClaimsAwaitingInvoice: roundMoney(acc.approvedClaimsAwaitingInvoice),
		unforecastedCount: acc.unforecastedCount,
		overBudgetCount: acc.overBudgetCount,
		lineCount: rows.length
	};
}

//#endregion
//#region src/lib/margin.js
function projectForecastRows(sources) {
	return buildForecastRows(sources).map((r) => composeForecastRow(r, r.storedUncommittedCostToComplete));
}
function projectForecastTotals(sources) {
	return forecastRollups(projectForecastRows(sources));
}
function currentContractSum(originalContractValue, approvedClientVariations) {
	return roundMoney(safeNumber(originalContractValue) + safeNumber(approvedClientVariations));
}
function forecastGrossProfit(forecastRevenue, forecastFinalCostValue) {
	return roundMoney(safeNumber(forecastRevenue) - safeNumber(forecastFinalCostValue));
}
function marginPercent(profit, revenue) {
	const rev = safeNumber(revenue);
	if (rev <= 0) return null;
	return roundMoney(safeNumber(profit) / rev * 100);
}
function originalPlannedProfit(originalContractValue, originalApprovedBudget) {
	if (originalApprovedBudget === null || originalApprovedBudget === void 0) return null;
	return roundMoney(safeNumber(originalContractValue) - safeNumber(originalApprovedBudget));
}
function marginMovement(forecastGrossProfitValue, originalPlannedProfitValue) {
	if (originalPlannedProfitValue === null || originalPlannedProfitValue === void 0) return null;
	return roundMoney(safeNumber(forecastGrossProfitValue) - safeNumber(originalPlannedProfitValue));
}
function isBaselineEstablished(baseline) {
	return !!baseline && typeof baseline.originalContractValue === "number";
}
function computeMargin({ baseline, variations = [], forecastFinalCost = 0, purchaseOrders = [], originalApprovedBudget: originalOverride } = {}) {
	const originalContractValue = isBaselineEstablished(baseline) ? baseline.originalContractValue : null;
	const originalApprovedBudget = originalOverride !== void 0 ? originalOverride : baseline?.originalApprovedBudget ?? null;
	const approvedClientVariations = approvedClientVariationsTotal(variations);
	const pendingClientVariationExposure = pendingClientVariationExposureTotal(variations);
	const approvedSupplierVariations = approvedSupplierVariationsTotal(variations);
	const appliedSupplierVariations = appliedSupplierVariationsTotal(variations, purchaseOrders);
	const committedNewScopeVariations = committedNewScopeTotal(variations, purchaseOrders);
	const unappliedSupplierVariations = unappliedSupplierVariationsTotal(variations, purchaseOrders);
	const pendingSupplierVariationExposure = pendingSupplierVariationExposureTotal(variations);
	const ccs = currentContractSum(originalContractValue, approvedClientVariations);
	const revenue = ccs;
	const ffc = roundMoney(safeNumber(forecastFinalCost));
	const profit = forecastGrossProfit(revenue, ffc);
	const plannedProfit = originalContractValue === null ? null : originalPlannedProfit(originalContractValue, originalApprovedBudget);
	return {
		originalContractValue,
		originalApprovedBudget,
		approvedClientVariations,
		pendingClientVariationExposure,
		approvedSupplierVariations,
		appliedSupplierVariations,
		committedNewScopeVariations,
		unappliedSupplierVariations,
		pendingSupplierVariationExposure,
		currentContractSum: ccs,
		forecastRevenue: revenue,
		forecastFinalCost: ffc,
		forecastGrossProfit: profit,
		forecastMarginPct: marginPercent(profit, revenue),
		originalPlannedProfit: plannedProfit,
		originalPlannedMarginPct: plannedProfit === null ? null : marginPercent(plannedProfit, originalContractValue),
		marginMovement: marginMovement(profit, plannedProfit)
	};
}

//#endregion
//#region src/lib/ganttBaseline.js
const BASELINE_STATUS = {
	DRAFT: "draft",
	APPROVED: "approved",
	WITHDRAWN: "withdrawn"
};
const BASELINE_STATUS_ORDER = [
	BASELINE_STATUS.DRAFT,
	BASELINE_STATUS.APPROVED,
	BASELINE_STATUS.WITHDRAWN
];
const BASELINE_STATUS_LABELS = {
	[BASELINE_STATUS.DRAFT]: "Draft",
	[BASELINE_STATUS.APPROVED]: "Approved",
	[BASELINE_STATUS.WITHDRAWN]: "Withdrawn"
};
const BASELINE_STATUS_BADGE = {
	[BASELINE_STATUS.DRAFT]: "pending",
	[BASELINE_STATUS.APPROVED]: "active",
	[BASELINE_STATUS.WITHDRAWN]: "soon"
};
const BASELINE_DESIGNATION = {
	ACTIVE: "active",
	ORIGINAL: "original",
	ACTIVE_ORIGINAL: "active_original",
	HISTORICAL: "historical"
};
const BASELINE_DESIGNATION_LABELS = {
	[BASELINE_DESIGNATION.ACTIVE]: "Active",
	[BASELINE_DESIGNATION.ORIGINAL]: "Original",
	[BASELINE_DESIGNATION.ACTIVE_ORIGINAL]: "Active · Original",
	[BASELINE_DESIGNATION.HISTORICAL]: "Historical"
};
const VARIANCE_KIND = {
	NO_BASELINE: "no_baseline",
	IN_BASELINE: "in_baseline",
	ADDED_AFTER: "added_after",
	CANCELLED_AT_CAPTURE: "cancelled_at_capture",
	CANCELLED_AFTER: "cancelled_after",
	MISSING_SOURCE: "missing_source",
	INVALID: "invalid"
};
const EMPTY_VARIANCE = Object.freeze({
	kind: VARIANCE_KIND.NO_BASELINE,
	entry: null,
	startVariance: null,
	finishVariance: null,
	completionVariance: null,
	startMoved: false,
	finishMoved: false,
	moved: false,
	state: null,
	completedLate: null
});

//#endregion
//#region src/lib/budgetAdjustment.js
const BUDGET_ADJUSTMENT_TYPE = {
	INCREASE: "increase",
	DECREASE: "decrease",
	TRANSFER: "transfer"
};
const BUDGET_ADJUSTMENT_TYPES = [
	BUDGET_ADJUSTMENT_TYPE.INCREASE,
	BUDGET_ADJUSTMENT_TYPE.DECREASE,
	BUDGET_ADJUSTMENT_TYPE.TRANSFER
];
const BUDGET_ADJUSTMENT_TYPE_LABELS = {
	[BUDGET_ADJUSTMENT_TYPE.INCREASE]: "Increase",
	[BUDGET_ADJUSTMENT_TYPE.DECREASE]: "Decrease",
	[BUDGET_ADJUSTMENT_TYPE.TRANSFER]: "Transfer"
};
const BUDGET_ADJUSTMENT_TYPE_HINTS = {
	[BUDGET_ADJUSTMENT_TYPE.INCREASE]: "Adds authorised budget to one cost code. The project total rises.",
	[BUDGET_ADJUSTMENT_TYPE.DECREASE]: "Removes authorised budget from one cost code. The project total falls.",
	[BUDGET_ADJUSTMENT_TYPE.TRANSFER]: "Moves budget from one cost code to another — including a contingency reallocation. The project total is unchanged."
};
const BUDGET_ADJUSTMENT_STATUS = {
	DRAFT: "draft",
	APPROVED: "approved",
	WITHDRAWN: "withdrawn"
};
const BUDGET_ADJUSTMENT_STATUS_LABELS = {
	[BUDGET_ADJUSTMENT_STATUS.DRAFT]: "Draft",
	[BUDGET_ADJUSTMENT_STATUS.APPROVED]: "Approved",
	[BUDGET_ADJUSTMENT_STATUS.WITHDRAWN]: "Withdrawn"
};
const BUDGET_ADJUSTMENT_STATUS_BADGE = {
	[BUDGET_ADJUSTMENT_STATUS.DRAFT]: "soon",
	[BUDGET_ADJUSTMENT_STATUS.APPROVED]: "active",
	[BUDGET_ADJUSTMENT_STATUS.WITHDRAWN]: "danger"
};
const BUDGET_ADJUSTMENT_LIMITS = {
	reason: 500,
	reference: 200,
	withdrawReason: 500,
	costCodeName: 170,
	amountCeiling: 0xe8d4a51000
};
const isMoney$2 = (v) => typeof v === "number" && Number.isFinite(v);
const isAdjustmentAmount = (v) => isMoney$2(v) && v > 0 && v < BUDGET_ADJUSTMENT_LIMITS.amountCeiling && Math.round(v * 100) / 100 === v;
function adjustmentNet(adj) {
	if (!adj || !isAdjustmentAmount(adj.amount)) return null;
	if (adj.type === BUDGET_ADJUSTMENT_TYPE.INCREASE) return adj.amount;
	if (adj.type === BUDGET_ADJUSTMENT_TYPE.DECREASE) return -adj.amount;
	if (adj.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER) return 0;
	return null;
}
function adjustmentMovements(adj) {
	if (validateBudgetAdjustmentRecord(adj) !== null) return [];
	if (adj.type === BUDGET_ADJUSTMENT_TYPE.INCREASE) return [{
		costCodeId: adj.costCodeId,
		costCodeName: adj.costCodeName,
		amount: adj.amount
	}];
	if (adj.type === BUDGET_ADJUSTMENT_TYPE.DECREASE) return [{
		costCodeId: adj.costCodeId,
		costCodeName: adj.costCodeName,
		amount: -adj.amount
	}];
	return [{
		costCodeId: adj.fromCostCodeId,
		costCodeName: adj.fromCostCodeName,
		amount: -adj.amount
	}, {
		costCodeId: adj.costCodeId,
		costCodeName: adj.costCodeName,
		amount: adj.amount
	}];
}
function movementsByCostCode(adjustments) {
	const map = {};
	for (const adj of adjustments ?? []) for (const m of adjustmentMovements(adj)) map[m.costCodeId] = roundMoney((map[m.costCodeId] || 0) + m.amount);
	return map;
}
function applyMovements(perCode, adjustments) {
	const out = { ...perCode ?? {} };
	const moves = movementsByCostCode(adjustments);
	for (const [id, amount] of Object.entries(moves)) out[id] = roundMoney((out[id] || 0) + amount);
	return out;
}
function validateBudgetAdjustmentRecord(adj) {
	const a = adj ?? {};
	if (!BUDGET_ADJUSTMENT_TYPES.includes(a.type)) return "has an unknown adjustment type";
	if (typeof a.costCodeId !== "string" || !a.costCodeId) return "has no cost code";
	if (typeof a.costCodeName !== "string" || a.costCodeName.length > BUDGET_ADJUSTMENT_LIMITS.costCodeName) return "has a malformed cost-code name";
	if (a.type === BUDGET_ADJUSTMENT_TYPE.TRANSFER) {
		if (typeof a.fromCostCodeId !== "string" || !a.fromCostCodeId) return "is a transfer with no source cost code";
		if (a.fromCostCodeId === a.costCodeId) return "is a transfer to the same cost code";
		if (typeof a.fromCostCodeName !== "string" || a.fromCostCodeName.length > BUDGET_ADJUSTMENT_LIMITS.costCodeName) return "has a malformed source cost-code name";
	} else if (a.fromCostCodeId !== null && a.fromCostCodeId !== void 0) return "names a source cost code but is not a transfer";
	if (!isAdjustmentAmount(a.amount)) return "has an amount that is not a positive whole-cent number";
	if (typeof a.currency !== "string" || !/^[A-Z]{3}$/.test(a.currency)) return "has no valid currency";
	if (typeof a.baseApprovalId !== "string" || !a.baseApprovalId) return "is not bound to an approved version";
	return null;
}

//#endregion
//#region src/lib/budgetApproval.js
const BUDGET_APPROVAL_STATUS = {
	DRAFT: "draft",
	APPROVED: "approved",
	WITHDRAWN: "withdrawn"
};
const BUDGET_APPROVAL_STATUS_ORDER = [
	BUDGET_APPROVAL_STATUS.DRAFT,
	BUDGET_APPROVAL_STATUS.APPROVED,
	BUDGET_APPROVAL_STATUS.WITHDRAWN
];
const BUDGET_APPROVAL_STATUS_LABELS = {
	[BUDGET_APPROVAL_STATUS.DRAFT]: "Draft",
	[BUDGET_APPROVAL_STATUS.APPROVED]: "Approved",
	[BUDGET_APPROVAL_STATUS.WITHDRAWN]: "Withdrawn"
};
const BUDGET_APPROVAL_STATUS_BADGE = {
	[BUDGET_APPROVAL_STATUS.DRAFT]: "soon",
	[BUDGET_APPROVAL_STATUS.APPROVED]: "active",
	[BUDGET_APPROVAL_STATUS.WITHDRAWN]: "danger"
};
const BUDGET_APPROVAL_LIMITS = {
	reason: 500,
	withdrawReason: 500,
	entries: 2e3,
	costCodeName: 170
};
const isMoney$1 = (v) => typeof v === "number" && Number.isFinite(v);
function validateBudgetEntry(entry, costCodeById = null) {
	const e = entry ?? {};
	if (!e.lineId) return "has no usable line identity";
	if (!e.costCodeId) return "has no cost code";
	if (typeof e.costCodeName !== "string") return "has a malformed cost-code name";
	if (e.costCodeName.length > BUDGET_APPROVAL_LIMITS.costCodeName) return "has a cost-code name that is too long";
	if (!isMoney$1(e.budgeted)) return "has a budgeted amount that is not a number";
	if (e.budgeted < 0) return "has a negative budgeted amount";
	if (roundMoney(e.budgeted) !== e.budgeted) return "has a budgeted amount with more than two decimal places";
	if (costCodeById) {
		if (!(costCodeById instanceof Map ? costCodeById.get(e.costCodeId) : costCodeById[e.costCodeId])) return "names a cost code that does not exist";
	}
	return null;
}
const sumEntries = (entries) => roundMoney((entries ?? []).reduce((s, e) => s + (Number(e?.budgeted) || 0), 0));
const isBudgetSnapshotUsable = (snapshot) => Boolean(snapshot) && Array.isArray(snapshot.entries) && Number.isInteger(snapshot.entryCount);
function snapshotAsBudgetLines(snapshot) {
	return (snapshot?.entries ?? []).map((e) => ({
		id: e.lineId,
		costCodeId: e.costCodeId,
		costCodeName: e.costCodeName,
		budgeted: e.budgeted,
		fromApprovedSnapshot: true
	}));
}
const approvedTotalOf = (snapshot) => sumEntries(snapshot?.entries);
function approvedByCostCode(snapshot) {
	const map = {};
	for (const e of snapshot?.entries ?? []) {
		if (!e?.costCodeId) continue;
		map[e.costCodeId] = roundMoney((map[e.costCodeId] || 0) + (Number(e.budgeted) || 0));
	}
	return map;
}
const BUDGET_INTEGRITY_PROBLEM = {
	POINTER_MALFORMED: "pointer_malformed",
	HEADER_MISSING: "header_missing",
	HEADER_NOT_APPROVED: "header_not_approved",
	HEADER_IDENTITY: "header_identity",
	HEADER_VERSION: "header_version",
	SNAPSHOT_MISSING: "snapshot_missing",
	SNAPSHOT_SHAPE: "snapshot_shape",
	SNAPSHOT_COUNT: "snapshot_count",
	ENTRY_MALFORMED: "entry_malformed",
	ENTRY_DUPLICATE: "entry_duplicate",
	TOTAL_MISMATCH: "total_mismatch",
	CURRENCY_MISMATCH: "currency_mismatch",
	ORIGINAL_MISSING: "original_missing",
	ORIGINAL_SHAPE: "original_shape",
	ADJUSTMENTS_UNAVAILABLE: "adjustments_unavailable",
	ADJUSTMENT_MALFORMED: "adjustment_malformed",
	ADJUSTMENT_COUNT: "adjustment_count",
	ADJUSTMENT_SEQUENCE: "adjustment_sequence",
	ADJUSTMENT_FOREIGN_BASE: "adjustment_foreign_base",
	ADJUSTMENT_NET: "adjustment_net",
	ADJUSTMENT_CURRENCY: "adjustment_currency",
	ADJUSTED_NEGATIVE: "adjusted_negative",
	ADJUSTMENT_POINTER: "adjustment_pointer"
};
const BUDGET_INTEGRITY_PROBLEM_TEXT = {
	[BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED]: "The approved-budget pointer is malformed.",
	[BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING]: "The active approval header is missing.",
	[BUDGET_INTEGRITY_PROBLEM.HEADER_NOT_APPROVED]: "The active approval header is not in the approved state.",
	[BUDGET_INTEGRITY_PROBLEM.HEADER_IDENTITY]: "The active approval header is not the one the pointer names.",
	[BUDGET_INTEGRITY_PROBLEM.HEADER_VERSION]: "The active approval version does not match the pointer's version count.",
	[BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING]: "The approved budget snapshot is missing.",
	[BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_SHAPE]: "The approved budget snapshot is malformed.",
	[BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT]: "The snapshot entry count does not match its entries or its header.",
	[BUDGET_INTEGRITY_PROBLEM.ENTRY_MALFORMED]: "A snapshot entry is malformed.",
	[BUDGET_INTEGRITY_PROBLEM.ENTRY_DUPLICATE]: "A snapshot entry repeats a budget line.",
	[BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH]: "The snapshot entries do not sum to the recorded total.",
	[BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH]: "The approved budget currency is not the project currency.",
	[BUDGET_INTEGRITY_PROBLEM.ORIGINAL_MISSING]: "The original (version 1) snapshot is missing.",
	[BUDGET_INTEGRITY_PROBLEM.ORIGINAL_SHAPE]: "The original (version 1) snapshot is malformed.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENTS_UNAVAILABLE]: "The approved budget adjustments could not be read.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_MALFORMED]: "An approved budget adjustment is malformed (type, cost code or amount).",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_COUNT]: "The number of approved adjustments does not match the pointer's adjustment count.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_SEQUENCE]: "The approved adjustment sequence has a gap or a duplicate.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_FOREIGN_BASE]: "An approved adjustment of another version was supplied for the active version.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_NET]: "The approved adjustments do not sum to the pointer's recorded net.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_CURRENCY]: "An approved adjustment is not in the approved budget's currency.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTED_NEGATIVE]: "A cost code's adjusted approved budget is below zero.",
	[BUDGET_INTEGRITY_PROBLEM.ADJUSTMENT_POINTER]: "The pointer's last-adjustment reference does not name the latest approved adjustment of the active version."
};
const toCents = (n) => Math.round((Number(n) || 0) * 100);
function validateBudgetSnapshot(snapshot, header = null, { currencyCode = null } = {}) {
	const problems = [];
	if (!snapshot) return [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING];
	if (!isBudgetSnapshotUsable(snapshot)) return [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_SHAPE];
	const entries = snapshot.entries;
	if (entries.length === 0 || entries.length !== snapshot.entryCount) problems.push(BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT);
	if (header && header.entryCount !== snapshot.entryCount) problems.push(BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_COUNT);
	const seen = /* @__PURE__ */ new Set();
	let malformed = false;
	let duplicate = false;
	for (const e of entries) {
		if (validateBudgetEntry(e) !== null) {
			malformed = true;
			continue;
		}
		if (seen.has(e.lineId)) duplicate = true;
		seen.add(e.lineId);
	}
	if (malformed) problems.push(BUDGET_INTEGRITY_PROBLEM.ENTRY_MALFORMED);
	if (duplicate) problems.push(BUDGET_INTEGRITY_PROBLEM.ENTRY_DUPLICATE);
	if (!malformed) {
		const sum = toCents(approvedTotalOf(snapshot));
		if (!isMoney$1(snapshot.total) || toCents(snapshot.total) !== sum) problems.push(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH);
		else if (header && (!isMoney$1(header.total) || toCents(header.total) !== sum)) problems.push(BUDGET_INTEGRITY_PROBLEM.TOTAL_MISMATCH);
	}
	const currencies = [
		snapshot.currency,
		header?.currency,
		currencyCode
	].filter((c) => c !== null && c !== void 0);
	if (currencies.some((c) => typeof c !== "string" || c !== currencies[0])) problems.push(BUDGET_INTEGRITY_PROBLEM.CURRENCY_MISMATCH);
	return [...new Set(problems)];
}
const BUDGET_SOURCE = {
	LOADING: "loading",
	UNAVAILABLE: "unavailable",
	APPROVED: "approved",
	WORKING: "working"
};
const BUDGET_SOURCE_LABELS = {
	[BUDGET_SOURCE.LOADING]: "Loading",
	[BUDGET_SOURCE.UNAVAILABLE]: "Unavailable",
	[BUDGET_SOURCE.APPROVED]: "Approved Budget",
	[BUDGET_SOURCE.WORKING]: "Working budget (not approved)"
};
const flag = (v) => v === true;
function resolveBudgetSource({ approvedBudget = null, budgetLines = [], budgetLinesLoading = false, budgetLinesError = false, currencyCode = null } = {}) {
	const ab = approvedBudget && typeof approvedBudget === "object" && !Array.isArray(approvedBudget) ? approvedBudget : {};
	const base = {
		pointer: ab.pointer ?? null,
		header: ab.header ?? null,
		snapshot: ab.snapshot ?? null,
		originalSnapshot: ab.originalSnapshot ?? null,
		version: null,
		versionCount: 0,
		approvedAt: null,
		approvedBy: null,
		reason: "",
		total: null,
		originalTotal: null,
		lines: [],
		problems: [],
		baseTotal: null,
		adjustmentCount: 0,
		adjustmentNet: null,
		adjustments: [],
		byCostCode: {},
		baseByCostCode: {},
		costCodeNames: {}
	};
	if (flag(ab.pointerLoading)) return {
		...base,
		kind: BUDGET_SOURCE.LOADING
	};
	if (flag(ab.pointerError)) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE
	};
	const pointer = ab.pointer ?? null;
	if (!pointer) {
		if (budgetLinesLoading) return {
			...base,
			kind: BUDGET_SOURCE.LOADING
		};
		if (budgetLinesError) return {
			...base,
			kind: BUDGET_SOURCE.UNAVAILABLE
		};
		const lines = Array.isArray(budgetLines) ? budgetLines : [];
		return {
			...base,
			kind: BUDGET_SOURCE.WORKING,
			lines,
			total: sumEntries(lines),
			byCostCode: foldByCostCode(lines),
			costCodeNames: namesOf(lines)
		};
	}
	const problems = [];
	if (typeof pointer.activeApprovalId !== "string" || !pointer.activeApprovalId || !Number.isInteger(pointer.versionCount) || pointer.versionCount < 1 || typeof pointer.originalApprovalId !== "string" || !pointer.originalApprovalId) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE,
		problems: [BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED]
	};
	const ledgerCount = pointer.adjustmentCount ?? 0;
	const ledgerNet = pointer.adjustmentNet ?? 0;
	if (!Number.isInteger(ledgerCount) || ledgerCount < 0 || !isMoney$1(ledgerNet)) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE,
		problems: [BUDGET_INTEGRITY_PROBLEM.POINTER_MALFORMED]
	};
	if (flag(ab.headerLoading) || flag(ab.snapshotLoading)) return {
		...base,
		kind: BUDGET_SOURCE.LOADING
	};
	if (ledgerCount > 0 && flag(ab.adjustmentsLoading)) return {
		...base,
		kind: BUDGET_SOURCE.LOADING
	};
	if (flag(ab.headerError)) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE,
		problems: [BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING]
	};
	if (flag(ab.snapshotError)) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE,
		problems: [BUDGET_INTEGRITY_PROBLEM.SNAPSHOT_MISSING]
	};
	if (ledgerCount > 0 && (flag(ab.adjustmentsError) || !Array.isArray(ab.adjustments))) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE,
		problems: [BUDGET_INTEGRITY_PROBLEM.ADJUSTMENTS_UNAVAILABLE]
	};
	const header = ab.header ?? null;
	const snapshot = ab.snapshot ?? null;
	if (!header) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_MISSING);
	else {
		if (header.id && header.id !== pointer.activeApprovalId) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_IDENTITY);
		if (header.status !== BUDGET_APPROVAL_STATUS.APPROVED) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_NOT_APPROVED);
		if (header.version !== pointer.versionCount) problems.push(BUDGET_INTEGRITY_PROBLEM.HEADER_VERSION);
	}
	problems.push(...validateBudgetSnapshot(snapshot, header, { currencyCode }));
	const adjustmentCheck = reconcileAdjustments(ab.adjustments, pointer, snapshot, ledgerCount, ledgerNet);
	problems.push(...adjustmentCheck.problems);
	let originalTotal = null;
	if (ab.originalRequested) if (pointer.originalApprovalId === pointer.activeApprovalId) originalTotal = problems.length === 0 ? approvedTotalOf(snapshot) : null;
	else if (flag(ab.originalLoading)) return {
		...base,
		kind: BUDGET_SOURCE.LOADING
	};
	else if (flag(ab.originalError) || !ab.originalSnapshot) problems.push(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_MISSING);
	else if (validateBudgetSnapshot(ab.originalSnapshot, null, { currencyCode }).length > 0) problems.push(BUDGET_INTEGRITY_PROBLEM.ORIGINAL_SHAPE);
	else originalTotal = approvedTotalOf(ab.originalSnapshot);
	const unique = [...new Set(problems)];
	if (unique.length > 0) return {
		...base,
		kind: BUDGET_SOURCE.UNAVAILABLE,
		problems: unique
	};
	const baseTotal = approvedTotalOf(snapshot);
	const net = adjustmentCheck.net;
	const names = { ...namesOf(snapshotAsBudgetLines(snapshot)) };
	for (const a of adjustmentCheck.approved) {
		if (a.costCodeName) names[a.costCodeId] = names[a.costCodeId] ?? a.costCodeName;
		if (a.fromCostCodeId && a.fromCostCodeName) names[a.fromCostCodeId] = names[a.fromCostCodeId] ?? a.fromCostCodeName;
	}
	return {
		...base,
		kind: BUDGET_SOURCE.APPROVED,
		version: header.version,
		versionCount: pointer.versionCount,
		approvedAt: header.approvedAt ?? null,
		approvedBy: header.approvedBy ?? null,
		reason: header.reason ?? "",
		baseTotal,
		adjustmentCount: adjustmentCheck.approved.length,
		adjustmentNet: net,
		adjustments: adjustmentCheck.approved,
		total: roundMoney(baseTotal + net),
		originalTotal,
		baseByCostCode: approvedByCostCode(snapshot),
		byCostCode: adjustmentCheck.byCostCode,
		costCodeNames: names,
		lines: [...snapshotAsBudgetLines(snapshot), ...adjustmentRows(adjustmentCheck.approved, names)]
	};
}
const foldByCostCode = (lines) => {
	const map = {};
	for (const l of lines ?? []) {
		if (!l?.costCodeId) continue;
		map[l.costCodeId] = roundMoney((map[l.costCodeId] || 0) + (Number(l.budgeted) || 0));
	}
	return map;
};
const namesOf = (lines) => {
	const names = {};
	for (const l of lines ?? []) if (l?.costCodeId && l.costCodeName && !names[l.costCodeId]) names[l.costCodeId] = l.costCodeName;
	return names;
};
function adjustmentRows(approved, names) {
	const moves = movementsByCostCode(approved);
	return Object.keys(moves).filter((id) => toCents(moves[id]) !== 0).sort().map((id) => ({
		id: `adjustment:${id}`,
		costCodeId: id,
		costCodeName: names[id] ?? "",
		budgeted: moves[id],
		fromApprovedAdjustment: true
	}));
}
function reconcileAdjustments(list, pointer, snapshot, ledgerCount, ledgerNet) {
	const P = BUDGET_INTEGRITY_PROBLEM;
	const problems = [];
	const items = Array.isArray(list) ? list : [];
	const activeId = pointer.activeApprovalId;
	const approvedAll = items.filter((a) => a?.status === BUDGET_ADJUSTMENT_STATUS.APPROVED);
	if (approvedAll.some((a) => a.baseApprovalId !== activeId)) problems.push(P.ADJUSTMENT_FOREIGN_BASE);
	const approved = approvedAll.filter((a) => a.baseApprovalId === activeId).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
	const malformed = approved.some((a) => validateBudgetAdjustmentRecord(a) !== null);
	if (malformed) problems.push(P.ADJUSTMENT_MALFORMED);
	if (approved.some((a) => typeof snapshot?.currency === "string" && a.currency !== snapshot.currency)) problems.push(P.ADJUSTMENT_CURRENCY);
	if (approved.length !== ledgerCount) problems.push(P.ADJUSTMENT_COUNT);
	if (approved.some((a, i) => a.sequence !== i + 1)) problems.push(P.ADJUSTMENT_SEQUENCE);
	if ((pointer.lastAdjustmentId ?? null) !== (approved.length > 0 ? approved[approved.length - 1].id ?? null : null)) problems.push(P.ADJUSTMENT_POINTER);
	let net = 0;
	let byCostCode = {};
	if (!malformed) {
		net = roundMoney(approved.reduce((s, a) => s + adjustmentNet(a), 0));
		if (toCents(net) !== toCents(ledgerNet)) problems.push(P.ADJUSTMENT_NET);
		if (isBudgetSnapshotUsable(snapshot)) {
			byCostCode = applyMovements(approvedByCostCode(snapshot), approved);
			if (Object.values(byCostCode).some((v) => toCents(v) < 0)) problems.push(P.ADJUSTED_NEGATIVE);
		}
	}
	return {
		problems,
		approved,
		net,
		byCostCode
	};
}
function budgetLinesFor(resolved) {
	if (!resolved) return [];
	if (resolved.kind === BUDGET_SOURCE.APPROVED || resolved.kind === BUDGET_SOURCE.WORKING) return resolved.lines ?? [];
	return [];
}
function approvedVersionCaption(source) {
	if (!source || !Number.isInteger(source.version)) return "";
	const n = Number.isInteger(source.adjustmentCount) ? source.adjustmentCount : 0;
	return n > 0 ? `${source.version} + ${n} adjustment${n === 1 ? "" : "s"}` : String(source.version);
}
function originalApprovedBudgetFor(resolved) {
	if (resolved?.kind === BUDGET_SOURCE.APPROVED && isMoney$1(resolved.originalTotal)) return resolved.originalTotal;
}

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
const issuedClientInvoices = (invoices) => (invoices ?? []).filter((inv) => CI_COUNTING_STATUSES.includes(inv.status));
const draftClientInvoices = (invoices) => (invoices ?? []).filter((inv) => inv.status === CI_STATUS.DRAFT);
function sumInvoices(invoices) {
	let subtotal = 0;
	let gstTotal = 0;
	for (const inv of invoices ?? []) {
		subtotal += Number(inv.subtotal) || 0;
		gstTotal += Number(inv.gstTotal) || 0;
	}
	subtotal = roundMoney(subtotal);
	gstTotal = roundMoney(gstTotal);
	return {
		count: (invoices ?? []).length,
		subtotal,
		gstTotal,
		grossTotal: roundMoney(subtotal + gstTotal)
	};
}
function availableToInvoice(currentContractSumValue, issuedExGst) {
	return roundMoney((Number(currentContractSumValue) || 0) - (Number(issuedExGst) || 0));
}
function contractControl(invoices, currentContractSumValue) {
	const issued = sumInvoices(issuedClientInvoices(invoices));
	const drafts = sumInvoices(draftClientInvoices(invoices));
	return {
		currentContractSum: roundMoney(Number(currentContractSumValue) || 0),
		issued,
		drafts,
		availableToInvoice: availableToInvoice(currentContractSumValue, issued.subtotal)
	};
}

//#endregion
//#region src/lib/clientReceipts.js
const postedClientReceipts = (receipts) => (receipts ?? []).filter((r) => PAYMENT_COUNTING_STATUSES.includes(r.status));
const draftClientReceipts = (receipts) => (receipts ?? []).filter((r) => r.status === PAYMENT_STATUS.DRAFT);
function receivedByInvoice(receipts) {
	const map = {};
	for (const r of postedClientReceipts(receipts)) for (const a of r.allocations ?? []) {
		if (!a?.clientInvoiceId) continue;
		map[a.clientInvoiceId] = roundMoney((map[a.clientInvoiceId] || 0) + safeAmount(a.allocatedAmount));
	}
	return map;
}
function remainingToReconcile(invoice, received) {
	return remainingBalance(invoice?.grossTotal, received);
}
function clientInvoiceReconciliationRows(invoices, receipts) {
	const received = receivedByInvoice(receipts);
	return (invoices ?? []).filter((inv) => inv.status === CI_STATUS.ISSUED).map((inv) => ({
		id: inv.id,
		invoiceNumber: inv.invoiceNumber,
		clientId: inv.clientId ?? null,
		clientName: inv.clientName || "",
		invoiceDate: inv.invoiceDate || "",
		dueDate: inv.dueDate || "",
		grossTotal: roundMoney(safeAmount(inv.grossTotal)),
		received: roundMoney(received[inv.id] || 0),
		remaining: remainingToReconcile(inv, received[inv.id] || 0),
		state: reconciliationState(inv.grossTotal, received[inv.id] || 0)
	}));
}
function receivablesSummary(invoices, receipts) {
	const rows = clientInvoiceReconciliationRows(invoices, receipts);
	let issuedGross = 0;
	let received = 0;
	let remaining = 0;
	let overReconciled = 0;
	for (const r of rows) {
		issuedGross = roundMoney(issuedGross + r.grossTotal);
		received = roundMoney(received + r.received);
		if (toCents$1(r.remaining) > 0) remaining = roundMoney(remaining + r.remaining);
		if (toCents$1(r.remaining) < 0) overReconciled = roundMoney(overReconciled + r.remaining);
	}
	return {
		rows,
		issuedGross,
		received,
		remaining,
		overReconciled
	};
}
function receiptSummary(receipts) {
	const posted = postedClientReceipts(receipts);
	const drafts = draftClientReceipts(receipts);
	let postedAmount = 0;
	let allocated = 0;
	let unallocated = 0;
	for (const r of posted) {
		postedAmount = roundMoney(postedAmount + safeAmount(r.amount));
		allocated = roundMoney(allocated + safeAmount(r.allocatedTotal));
		unallocated = roundMoney(unallocated + safeAmount(r.unallocatedAmount));
	}
	let draftAmount = 0;
	for (const r of drafts) draftAmount = roundMoney(draftAmount + safeAmount(r.amount));
	return {
		postedCount: posted.length,
		postedAmount,
		allocated,
		unallocated,
		draftCount: drafts.length,
		draftAmount
	};
}
function cashInRows(receipts, { projectId } = {}) {
	return postedClientReceipts(receipts).map((r) => ({
		receiptId: r.id,
		receiptNumber: r.receiptNumber,
		amount: roundMoney(safeAmount(r.amount)),
		receiptDate: r.receiptDate || "",
		projectId: projectId ?? null,
		clientId: r.clientId ?? null,
		clientName: r.clientName || "",
		currency: r.currency || "",
		allocatedTotal: roundMoney(safeAmount(r.allocatedTotal)),
		unallocatedAmount: roundMoney(safeAmount(r.unallocatedAmount))
	}));
}

//#endregion
//#region src/lib/supplierPayments.js
const postedSupplierPayments = (payments) => (payments ?? []).filter((p) => PAYMENT_COUNTING_STATUSES.includes(p.status));
const draftSupplierPayments = (payments) => (payments ?? []).filter((p) => p.status === PAYMENT_STATUS.DRAFT);
const isPayableInvoice = (inv) => inv?.status === SI_STATUS.POSTED;
const postedSupplierInvoices = (invoices) => (invoices ?? []).filter(isPayableInvoice);
const payableBasis = (invoice, released = 0) => roundMoney(safeAmount(invoice?.payableTotal) + safeAmount(released));
const normaliseSupplierName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const isLegacyNameMatch = (invoice) => !!invoice && !invoice.supplierId;
function paidByInvoice(payments) {
	const map = {};
	for (const p of postedSupplierPayments(payments)) for (const a of p.allocations ?? []) {
		if (!a?.supplierInvoiceId) continue;
		map[a.supplierInvoiceId] = roundMoney((map[a.supplierInvoiceId] || 0) + safeAmount(a.allocatedAmount));
	}
	return map;
}
function supplierInvoiceReconciliationRows(invoices, payments, creditNotes = [], releasedByInvoiceId = {}) {
	const paid = paidByInvoice(payments);
	const credited = creditedByInvoice(creditNotes, invoices);
	return postedSupplierInvoices(invoices).map((inv) => {
		const released = roundMoney(safeAmount(releasedByInvoiceId[inv.id]));
		const basis = payableBasis(inv, released);
		const retentionTotal = roundMoney(safeAmount(inv.retentionTotal));
		const paidAmount = roundMoney(paid[inv.id] || 0);
		const creditedAmount = roundMoney(credited[inv.id] || 0);
		const settled = roundMoney(paidAmount + creditedAmount);
		return {
			id: inv.id,
			invoiceNumber: inv.invoiceNumber,
			supplierInvoiceNumber: inv.supplierInvoiceNumber || "",
			supplierId: inv.supplierId ?? null,
			supplierName: inv.supplierName || "",
			invoiceDate: inv.invoiceDate || "",
			dueDate: inv.dueDate || "",
			grossTotal: roundMoney(safeAmount(inv.grossTotal)),
			retentionTotal,
			retentionHeld: Math.max(0, roundMoney(retentionTotal - released)),
			releasedTotal: released,
			invoicePayableTotal: roundMoney(safeAmount(inv.payableTotal)),
			payableTotal: basis,
			paid: paidAmount,
			credited: creditedAmount,
			remaining: remainingBalance(basis, settled),
			state: reconciliationState(basis, settled)
		};
	});
}
function payablesSummary(invoices, payments, creditNotes = [], releasedByInvoiceId = {}) {
	const rows = supplierInvoiceReconciliationRows(invoices, payments, creditNotes, releasedByInvoiceId);
	let postedPayable = 0;
	let paid = 0;
	let credited = 0;
	let remaining = 0;
	let overReconciled = 0;
	for (const r of rows) {
		postedPayable = roundMoney(postedPayable + r.payableTotal);
		paid = roundMoney(paid + r.paid);
		credited = roundMoney(credited + r.credited);
		if (toCents$1(r.remaining) > 0) remaining = roundMoney(remaining + r.remaining);
		if (toCents$1(r.remaining) < 0) overReconciled = roundMoney(overReconciled + r.remaining);
	}
	return {
		rows,
		postedPayable,
		paid,
		credited,
		remaining,
		overReconciled,
		count: rows.length
	};
}
function paymentSummary(payments) {
	const posted = postedSupplierPayments(payments);
	const drafts = draftSupplierPayments(payments);
	let postedAmount = 0;
	let allocated = 0;
	let unallocated = 0;
	for (const p of posted) {
		postedAmount = roundMoney(postedAmount + safeAmount(p.amount));
		allocated = roundMoney(allocated + safeAmount(p.allocatedTotal));
		unallocated = roundMoney(unallocated + safeAmount(p.unallocatedAmount));
	}
	let draftAmount = 0;
	for (const p of drafts) draftAmount = roundMoney(draftAmount + safeAmount(p.amount));
	return {
		postedCount: posted.length,
		postedAmount,
		allocated,
		unallocated,
		draftCount: drafts.length,
		draftAmount
	};
}
function cashOutRows(payments, { projectId } = {}) {
	return postedSupplierPayments(payments).map((p) => ({
		paymentId: p.id,
		paymentNumber: p.paymentNumber,
		amount: roundMoney(safeAmount(p.amount)),
		paymentDate: p.paymentDate || "",
		projectId: projectId ?? null,
		supplierId: p.supplierId ?? null,
		supplierName: p.supplierName || "",
		currency: p.currency || "",
		allocatedTotal: roundMoney(safeAmount(p.allocatedTotal)),
		unallocatedAmount: roundMoney(safeAmount(p.unallocatedAmount))
	}));
}

//#endregion
//#region src/lib/cashFlow.js
function totalActualCashIn(inRows) {
	return roundMoney((inRows ?? []).reduce((sum, r) => sum + safeAmount(r.amount), 0));
}
function totalActualCashOut(outRows) {
	return roundMoney((outRows ?? []).reduce((sum, r) => sum + safeAmount(r.amount), 0));
}
function actualNetCash(cashIn, cashOut) {
	return roundMoney(safeAmount(cashIn) - safeAmount(cashOut));
}
const CFL_SOURCE_TYPE = {
	CONTRACT_REVENUE: "contract_revenue",
	UNINVOICED_CLAIM: "uninvoiced_claim",
	REMAINING_COMMITTED: "remaining_committed",
	UNCOMMITTED_CTC: "uncommitted_ctc",
	MANUAL: "manual"
};
const CFL_IN_SOURCE_TYPES = [CFL_SOURCE_TYPE.CONTRACT_REVENUE, CFL_SOURCE_TYPE.MANUAL];
const CFL_OUT_SOURCE_TYPES = [
	CFL_SOURCE_TYPE.UNINVOICED_CLAIM,
	CFL_SOURCE_TYPE.REMAINING_COMMITTED,
	CFL_SOURCE_TYPE.UNCOMMITTED_CTC,
	CFL_SOURCE_TYPE.MANUAL
];
const CFL_SOURCE_TYPE_LABELS = {
	[CFL_SOURCE_TYPE.CONTRACT_REVENUE]: "Remaining uninvoiced contract value",
	[CFL_SOURCE_TYPE.UNINVOICED_CLAIM]: "Approved claim awaiting invoice",
	[CFL_SOURCE_TYPE.REMAINING_COMMITTED]: "Remaining committed (PO)",
	[CFL_SOURCE_TYPE.UNCOMMITTED_CTC]: "Uncommitted cost to complete",
	[CFL_SOURCE_TYPE.MANUAL]: "Manual adjustment"
};
const CFL_COVERAGE_SOURCE_TYPES = [
	CFL_SOURCE_TYPE.CONTRACT_REVENUE,
	CFL_SOURCE_TYPE.UNINVOICED_CLAIM,
	CFL_SOURCE_TYPE.REMAINING_COMMITTED,
	CFL_SOURCE_TYPE.UNCOMMITTED_CTC
];
const CFL_COST_CODED_SOURCE_TYPES = [
	CFL_SOURCE_TYPE.UNINVOICED_CLAIM,
	CFL_SOURCE_TYPE.REMAINING_COMMITTED,
	CFL_SOURCE_TYPE.UNCOMMITTED_CTC
];

//#endregion
//#region src/lib/retention.js
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
const postedRetentionReleases = (releases) => (releases ?? []).filter((r) => RR_COUNTING_STATUSES.includes(r?.status));
const draftRetentionReleases = (releases) => (releases ?? []).filter((r) => r?.status === RR_STATUS.DRAFT);
function releasedByInvoiceId(releases) {
	const map = {};
	for (const r of postedRetentionReleases(releases)) {
		if (!r?.supplierInvoiceId) continue;
		map[r.supplierInvoiceId] = roundMoney((map[r.supplierInvoiceId] || 0) + safeAmount(r.releaseTotal));
	}
	return map;
}
function releasedExGstByInvoiceId(releases) {
	const map = {};
	for (const r of postedRetentionReleases(releases)) {
		if (!r?.supplierInvoiceId) continue;
		map[r.supplierInvoiceId] = roundMoney((map[r.supplierInvoiceId] || 0) + safeAmount(r.amount));
	}
	return map;
}
function remainingRetentionExGst(invoice, releasedExGst) {
	return Math.max(0, roundMoney(safeAmount(invoice?.retention) - safeAmount(releasedExGst)));
}
const retentionInvoices = (invoices) => (invoices ?? []).filter((inv) => isPayableInvoice(inv) && toCents$1(safeAmount(inv.retentionTotal)) > 0);
function retentionInvoiceRows(invoices, releases) {
	const releasedGross = releasedByInvoiceId(releases);
	const releasedExGst = releasedExGstByInvoiceId(releases);
	return retentionInvoices(invoices).map((inv) => {
		const relTotal = roundMoney(safeAmount(releasedGross[inv.id]));
		const relExGst = roundMoney(safeAmount(releasedExGst[inv.id]));
		const retentionTotal = roundMoney(safeAmount(inv.retentionTotal));
		return {
			id: inv.id,
			invoiceNumber: inv.invoiceNumber,
			supplierInvoiceNumber: inv.supplierInvoiceNumber || "",
			supplierId: inv.supplierId ?? null,
			supplierName: inv.supplierName || "",
			invoiceDate: inv.invoiceDate || "",
			retention: roundMoney(safeAmount(inv.retention)),
			retentionGst: roundMoney(safeAmount(inv.retentionGst)),
			retentionTotal,
			releasedExGst: relExGst,
			releasedGst: roundMoney(relTotal - relExGst),
			releasedTotal: relTotal,
			retentionHeld: Math.max(0, roundMoney(retentionTotal - relTotal)),
			remainingRetentionExGst: remainingRetentionExGst(inv, relExGst),
			fullyReleased: toCents$1(retentionTotal - relTotal) <= 0,
			legacyNameMatch: isLegacyNameMatch(inv)
		};
	});
}
function retentionSummary(invoices, releases) {
	const rows = retentionInvoiceRows(invoices, releases);
	let totalWithheld = 0;
	let releasedToDate = 0;
	let retentionHeld = 0;
	for (const row of rows) {
		totalWithheld = roundMoney(totalWithheld + row.retentionTotal);
		releasedToDate = roundMoney(releasedToDate + row.releasedTotal);
		retentionHeld = roundMoney(retentionHeld + row.retentionHeld);
	}
	const suppliers = new Set(rows.map((r) => r.supplierId ? `id:${r.supplierId}` : `name:${normaliseSupplierName(r.supplierName)}`));
	return {
		totalWithheld,
		releasedToDate,
		retentionHeld,
		invoiceCount: rows.length,
		supplierCount: suppliers.size
	};
}

//#endregion
//#region src/lib/projectSnapshot.js
const FIGURE_STATE = {
	LOADING: "loading",
	UNAVAILABLE: "unavailable",
	READY: "ready"
};
function figureState(dependencies, sourceStates) {
	const failed = [];
	let loading = false;
	for (const dep of dependencies ?? []) {
		const s = sourceStates?.[dep];
		if (!s || typeof s.loading !== "boolean" || typeof s.error !== "boolean" || s.error) {
			failed.push(dep);
			continue;
		}
		if (s.loading) loading = true;
	}
	if (failed.length > 0) return {
		state: FIGURE_STATE.UNAVAILABLE,
		failedSources: failed
	};
	if (loading) return {
		state: FIGURE_STATE.LOADING,
		failedSources: []
	};
	return {
		state: FIGURE_STATE.READY,
		failedSources: []
	};
}
const SNAPSHOT_SOURCES = [
	"budgetLines",
	"approvedBudget",
	"purchaseOrders",
	"progressClaims",
	"supplierInvoices",
	"supplierCreditNotes",
	"variations",
	"forecastLines",
	"baseline",
	"supplierPayments",
	"retentionReleases"
];
const SNAPSHOT_SOURCE_LABELS = {
	budgetLines: "Budget Lines",
	approvedBudget: "Approved Budget",
	purchaseOrders: "Purchase Orders",
	progressClaims: "Progress Claims",
	supplierInvoices: "Supplier Invoices",
	supplierCreditNotes: "Supplier Credit Notes",
	variations: "Variations",
	forecastLines: "Forecast Lines",
	baseline: "Commercial Baseline",
	supplierPayments: "Supplier Payments",
	retentionReleases: "Retention Releases"
};
const FFC_SOURCES = [
	"purchaseOrders",
	"progressClaims",
	"supplierInvoices",
	"supplierCreditNotes",
	"variations",
	"forecastLines"
];
const FORECAST_ROW_SOURCES = [
	"approvedBudget",
	"purchaseOrders",
	"progressClaims",
	"supplierInvoices",
	"supplierCreditNotes",
	"variations",
	"forecastLines"
];
const FIGURE_DEPENDENCIES = {
	approvedBudget: ["approvedBudget"],
	actual: [
		"progressClaims",
		"supplierInvoices",
		"supplierCreditNotes"
	],
	remainingCommitted: [
		"purchaseOrders",
		"progressClaims",
		"supplierInvoices",
		"variations"
	],
	forecastFinalCost: FFC_SOURCES,
	varianceToBudget: ["approvedBudget", ...FFC_SOURCES],
	margin: [
		"baseline",
		"variations",
		...FFC_SOURCES
	],
	remainingPayable: [
		"supplierInvoices",
		"supplierPayments",
		"supplierCreditNotes",
		"retentionReleases"
	],
	costComposition: ["approvedBudget", ...FFC_SOURCES],
	supplierVariationExposure: ["variations", "purchaseOrders"],
	appliedSupplierVariations: ["variations", "purchaseOrders"],
	committedNewScopeVariations: ["variations", "purchaseOrders"],
	forecastRows: FORECAST_ROW_SOURCES,
	contractBaseline: ["baseline", "approvedBudget"],
	clientVariations: ["variations"],
	currentContractSum: ["baseline", "variations"],
	marginMovement: [
		"baseline",
		"approvedBudget",
		"variations",
		...FFC_SOURCES
	],
	uncommittedCostToComplete: ["forecastLines"],
	claimedExposure: ["progressClaims"],
	invoiced: ["supplierInvoices", "supplierCreditNotes"],
	remainingBudget: [
		"approvedBudget",
		"progressClaims",
		"supplierInvoices",
		"supplierCreditNotes"
	],
	workingBudget: ["budgetLines", "approvedBudget"],
	commitmentExposure: [
		"purchaseOrders",
		"progressClaims",
		"supplierInvoices",
		"variations"
	],
	closedResidual: [
		"purchaseOrders",
		"progressClaims",
		"supplierInvoices",
		"variations"
	]
};
const MARGIN_NOT_ESTABLISHED = "not_established";
const availableFigure = (key, value, sourceStates) => {
	const s = figureState(FIGURE_DEPENDENCIES[key], sourceStates);
	return {
		...s,
		value: s.state === FIGURE_STATE.READY ? value : null
	};
};
const figure = availableFigure;
function projectSnapshot({ sources = {}, sourceStates = {}, currencyCode }) {
	const { budgetLines = [], purchaseOrders = [], progressClaims = [], supplierInvoices = [], supplierCreditNotes = [], variations = [], forecastLines = [], baseline = null, supplierPayments = [], retentionReleases = [], approvedBudget = null } = sources;
	const budgetSource = resolveBudgetSource({
		approvedBudget,
		budgetLines,
		budgetLinesLoading: sourceStates?.budgetLines?.loading === true,
		budgetLinesError: sourceStates?.budgetLines?.error === true,
		currencyCode
	});
	const totals = projectForecastTotals({
		budgetLines: budgetLinesFor(budgetSource),
		purchaseOrders,
		progressClaims,
		supplierInvoices,
		supplierCreditNotes,
		variations,
		forecastLines
	});
	const m = computeMargin({
		baseline,
		variations,
		forecastFinalCost: totals.forecastFinalCost,
		purchaseOrders,
		originalApprovedBudget: originalApprovedBudgetFor(budgetSource)
	});
	const payables = payablesSummary(supplierInvoices, supplierPayments, supplierCreditNotes, releasedByInvoiceId(retentionReleases));
	const marginState = figureState(FIGURE_DEPENDENCIES.margin, sourceStates);
	const notEstablished = sourceStates?.baseline?.loading === false && sourceStates?.baseline?.error === false && !isBaselineEstablished(baseline);
	const marginReady = !notEstablished && marginState.state === FIGURE_STATE.READY;
	const composition = figureState(FIGURE_DEPENDENCIES.costComposition, sourceStates);
	const compositionReady = composition.state === FIGURE_STATE.READY;
	const contract = figureState(FIGURE_DEPENDENCIES.currentContractSum, sourceStates);
	const contractReady = !notEstablished && contract.state === FIGURE_STATE.READY;
	const movement = figureState(FIGURE_DEPENDENCIES.marginMovement, sourceStates);
	const movementReady = !notEstablished && movement.state === FIGURE_STATE.READY;
	return {
		currencyCode,
		budgetSource: {
			kind: budgetSource.kind,
			approved: budgetSource.kind === BUDGET_SOURCE.APPROVED,
			version: budgetSource.version,
			adjustmentCount: budgetSource.adjustmentCount,
			approvedAt: budgetSource.approvedAt,
			approvedBy: budgetSource.approvedBy,
			problems: budgetSource.problems
		},
		approvedBudget: figure("approvedBudget", totals.budgeted, sourceStates),
		actual: figure("actual", totals.actual, sourceStates),
		remainingCommitted: figure("remainingCommitted", totals.remainingCommitted, sourceStates),
		forecastFinalCost: figure("forecastFinalCost", totals.forecastFinalCost, sourceStates),
		varianceToBudget: figure("varianceToBudget", totals.varianceToBudget, sourceStates),
		margin: {
			...marginState,
			state: notEstablished ? MARGIN_NOT_ESTABLISHED : marginState.state,
			failedSources: notEstablished ? [] : marginState.failedSources,
			grossProfit: marginReady ? m.forecastGrossProfit : null,
			marginPct: marginReady ? m.forecastMarginPct : null
		},
		remainingPayable: figure("remainingPayable", payables.remaining, sourceStates),
		uncommittedCostToComplete: figure("uncommittedCostToComplete", totals.uncommittedCostToComplete, sourceStates),
		currentContractSum: {
			...contract,
			state: notEstablished ? MARGIN_NOT_ESTABLISHED : contract.state,
			failedSources: notEstablished ? [] : contract.failedSources,
			value: contractReady ? m.currentContractSum : null
		},
		marginMovement: {
			...movement,
			state: notEstablished ? MARGIN_NOT_ESTABLISHED : movement.state,
			failedSources: notEstablished ? [] : movement.failedSources,
			planned: movementReady && m.marginMovement !== null,
			value: movementReady ? m.marginMovement : null
		},
		costComposition: {
			...composition,
			actual: compositionReady ? totals.actual : null,
			remainingCommitted: compositionReady ? totals.remainingCommitted : null,
			uncommittedCostToComplete: compositionReady ? totals.uncommittedCostToComplete : null,
			forecastFinalCost: compositionReady ? totals.forecastFinalCost : null,
			approvedBudget: compositionReady ? totals.budgeted : null
		}
	};
}
const CONTRACT_ROW_STATE = {
	READY: "ready",
	LOADING: FIGURE_STATE.LOADING,
	UNAVAILABLE: FIGURE_STATE.UNAVAILABLE,
	NOT_ESTABLISHED: MARGIN_NOT_ESTABLISHED,
	NOT_DRAWABLE: "not_drawable"
};

//#endregion
//#region src/lib/commercialReport.js
const REPORT_SOURCES = [
	...SNAPSHOT_SOURCES,
	"clientInvoices",
	"clientReceipts"
];
const REPORT_SOURCE_LABELS = {
	...SNAPSHOT_SOURCE_LABELS,
	clientInvoices: "Client Invoices",
	clientReceipts: "Client Receipts"
};
const REPORT_DEPENDENCIES = {
	costToComplete: FIGURE_DEPENDENCIES.forecastFinalCost,
	costCodeRows: [...new Set([...FIGURE_DEPENDENCIES.forecastRows, ...FIGURE_DEPENDENCIES.claimedExposure])],
	claimed: FIGURE_DEPENDENCIES.claimedExposure,
	originalContract: ["baseline"],
	clientVariations: FIGURE_DEPENDENCIES.clientVariations,
	supplierVariations: FIGURE_DEPENDENCIES.supplierVariationExposure,
	cashIn: ["clientReceipts"],
	cashOut: ["supplierPayments"],
	netCash: ["clientReceipts", "supplierPayments"],
	receivables: ["clientInvoices", "clientReceipts"]
};
const FIGURE_KIND = {
	MONEY: "money",
	PERCENT: "percent"
};
function gated(dependencies, value, sourceStates) {
	const s = figureState(dependencies, sourceStates);
	return {
		...s,
		value: s.state === FIGURE_STATE.READY ? value : null
	};
}
const fromSnapshot = (f, valueKey = "value") => ({
	state: f.state,
	failedSources: f.failedSources ?? [],
	value: f.state === FIGURE_STATE.READY ? f[valueKey] ?? null : null
});
function contractGated(dependencies, value, sourceStates, notEstablished) {
	if (notEstablished) return {
		state: MARGIN_NOT_ESTABLISHED,
		failedSources: [],
		value: null
	};
	return gated(dependencies, value, sourceStates);
}
function compareReportRows(a, b) {
	const byName = String(a.costCodeName ?? "").localeCompare(String(b.costCodeName ?? ""), "en");
	if (byName !== 0) return byName;
	const ia = String(a.costCodeId ?? "");
	const ib = String(b.costCodeId ?? "");
	return ia < ib ? -1 : ia > ib ? 1 : 0;
}
function budgetSourceCaption(budgetSource) {
	if (!budgetSource) return "";
	if (budgetSource.kind === BUDGET_SOURCE.APPROVED) return `Approved version ${approvedVersionCaption(budgetSource)}`;
	if (budgetSource.kind === BUDGET_SOURCE.WORKING) return "Working budget (not approved)";
	if (budgetSource.kind === BUDGET_SOURCE.LOADING) return "Loading";
	return "Unavailable";
}
function buildCommercialReport({ project = null, currencyCode, sources = {}, sourceStates = {} } = {}) {
	const { budgetLines = [], approvedBudget = null, purchaseOrders = [], progressClaims = [], supplierInvoices = [], supplierCreditNotes = [], variations = [], forecastLines = [], baseline = null, supplierPayments = [], retentionReleases = [], clientInvoices = [], clientReceipts = [], costCodes = [] } = sources;
	const snapshot = projectSnapshot({
		currencyCode,
		sources: {
			budgetLines,
			approvedBudget,
			purchaseOrders,
			progressClaims,
			supplierInvoices,
			supplierCreditNotes,
			variations,
			forecastLines,
			baseline,
			supplierPayments,
			retentionReleases
		},
		sourceStates
	});
	const budgetSource = resolveBudgetSource({
		approvedBudget,
		budgetLines,
		budgetLinesLoading: sourceStates?.budgetLines?.loading === true,
		budgetLinesError: sourceStates?.budgetLines?.error === true,
		currencyCode
	});
	const forecastRows = projectForecastRows({
		costCodes,
		budgetLines: budgetLinesFor(budgetSource),
		purchaseOrders,
		progressClaims,
		supplierInvoices,
		supplierCreditNotes,
		variations,
		forecastLines
	});
	const totals = forecastRollups(forecastRows);
	const claimedMap = claimedPendingByCostCode(progressClaims);
	const m = computeMargin({
		baseline,
		variations,
		forecastFinalCost: totals.forecastFinalCost,
		purchaseOrders,
		originalApprovedBudget: originalApprovedBudgetFor(budgetSource)
	});
	const rows = forecastRows.map((r) => ({
		costCodeId: r.costCodeId,
		costCodeName: r.costCodeName,
		hasBudgetLine: r.hasBudgetLine,
		approvedBudget: r.hasBudgetLine ? r.budgeted : null,
		committed: r.remainingCommitted,
		claimed: claimedMap[r.costCodeId] || 0,
		actual: r.actual,
		forecastFinalCost: r.forecastFinalCost,
		costToComplete: r.costToComplete,
		varianceToBudget: r.hasBudgetLine ? r.varianceToBudget : null,
		unforecasted: r.unforecasted,
		overBudget: r.overBudget
	}));
	const known = new Set(rows.map((r) => r.costCodeId));
	const nameOf = (id) => {
		const cc = costCodes.find((c) => c.id === id);
		if (cc) return `${cc.code} — ${cc.name}`;
		for (const claim of progressClaims) for (const li of claim.lineItems ?? []) if (li.costCodeId === id && li.costCodeName) return li.costCodeName;
		return "Unknown cost code";
	};
	for (const id of Object.keys(claimedMap)) {
		if (known.has(id)) continue;
		rows.push({
			costCodeId: id,
			costCodeName: nameOf(id),
			hasBudgetLine: false,
			approvedBudget: null,
			committed: 0,
			claimed: claimedMap[id],
			actual: 0,
			forecastFinalCost: 0,
			costToComplete: 0,
			varianceToBudget: null,
			unforecasted: true,
			overBudget: false
		});
	}
	rows.sort(compareReportRows);
	const claimedTotal = roundMoney(rows.reduce((s, r) => s + (Number(r.claimed) || 0), 0));
	const rowsState = figureState(REPORT_DEPENDENCIES.costCodeRows, sourceStates);
	const rowsReady = rowsState.state === FIGURE_STATE.READY;
	const costCodeTable = {
		...rowsState,
		rows: rowsReady ? rows : [],
		totals: rowsReady ? {
			approvedBudget: totals.budgeted,
			committed: totals.remainingCommitted,
			claimed: claimedTotal,
			actual: totals.actual,
			forecastFinalCost: totals.forecastFinalCost,
			costToComplete: totals.costToComplete,
			varianceToBudget: totals.varianceToBudget
		} : null,
		unforecastedCount: rowsReady ? rows.filter((r) => r.unforecasted).length : null,
		unbudgetedCount: rowsReady ? rows.filter((r) => !r.hasBudgetLine).length : null
	};
	const notEstablished = snapshot.margin.state === MARGIN_NOT_ESTABLISHED;
	const margin = snapshot.margin;
	const marginFigure = (valueKey) => margin.state === "not_established" ? {
		state: MARGIN_NOT_ESTABLISHED,
		failedSources: [],
		value: null
	} : fromSnapshot(margin, valueKey);
	const summary = [
		{
			key: "originalContractValue",
			label: "Original Contract Value",
			kind: FIGURE_KIND.MONEY,
			figure: contractGated(REPORT_DEPENDENCIES.originalContract, m.originalContractValue, sourceStates, notEstablished),
			note: "From the Commercial baseline"
		},
		{
			key: "currentContractSum",
			label: "Current Contract Sum",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.currentContractSum),
			note: "Original Contract Value + approved client variations"
		},
		{
			key: "forecastRevenue",
			label: "Forecast Revenue",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.currentContractSum),
			note: "Equals the Current Contract Sum (no separate revenue forecast exists)"
		},
		{
			key: "approvedBudget",
			label: "Approved Budget",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.approvedBudget),
			note: budgetSourceCaption(budgetSource)
		},
		{
			key: "committed",
			label: "Committed (remaining open)",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.remainingCommitted),
			note: "Open commitment on sent/closed POs, net of invoiced and approved-claim amounts — not cost incurred"
		},
		{
			key: "claimed",
			label: "Claimed (awaiting certification)",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.claimed, claimedTotal, sourceStates),
			note: "Submitted and under-review claims — not in Actual Cost, not a payment"
		},
		{
			key: "actual",
			label: "Actual Cost",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.actual),
			note: "Approved claims + posted supplier invoices − posted credit notes"
		},
		{
			key: "costToComplete",
			label: "Cost to Complete",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.costToComplete, totals.costToComplete, sourceStates),
			note: "Remaining committed + uncommitted cost to complete"
		},
		{
			key: "forecastFinalCost",
			label: "Forecast Final Cost",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.forecastFinalCost),
			note: "Actual + cost to complete"
		},
		{
			key: "varianceToBudget",
			label: "Variance to Budget",
			kind: FIGURE_KIND.MONEY,
			figure: fromSnapshot(snapshot.varianceToBudget),
			note: "Approved Budget − Forecast Final Cost (negative = over budget)"
		},
		{
			key: "forecastGrossProfit",
			label: "Forecast Gross Profit",
			kind: FIGURE_KIND.MONEY,
			figure: marginFigure("grossProfit"),
			note: "Forecast Revenue − Forecast Final Cost"
		},
		{
			key: "forecastMarginPct",
			label: "Forecast Margin",
			kind: FIGURE_KIND.PERCENT,
			figure: marginFigure("marginPct"),
			note: "Forecast Gross Profit ÷ Forecast Revenue"
		}
	];
	const variationFigures = [
		{
			key: "approvedClientVariations",
			label: "Approved client variations",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.clientVariations, m.approvedClientVariations, sourceStates),
			note: "Included in the Current Contract Sum"
		},
		{
			key: "pendingClientVariations",
			label: "Pending client variations",
			kind: FIGURE_KIND.MONEY,
			pending: true,
			figure: gated(REPORT_DEPENDENCIES.clientVariations, m.pendingClientVariationExposure, sourceStates),
			note: "Submitted, not approved — NOT included in any revenue figure"
		},
		{
			key: "approvedSupplierVariations",
			label: "Approved supplier variations",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.approvedSupplierVariations, sourceStates),
			note: "Gross approved supplier variation value"
		},
		{
			key: "appliedSupplierVariations",
			label: "… of which applied to POs",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.appliedSupplierVariations, sourceStates),
			note: "Already inside Committed"
		},
		{
			key: "unappliedSupplierVariations",
			label: "… of which not yet applied",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.unappliedSupplierVariations, sourceStates),
			note: "Approved exposure not yet in Committed or Forecast Final Cost"
		},
		{
			key: "pendingSupplierVariations",
			label: "Pending supplier variations",
			kind: FIGURE_KIND.MONEY,
			pending: true,
			figure: gated(REPORT_DEPENDENCIES.supplierVariations, m.pendingSupplierVariationExposure, sourceStates),
			note: "Submitted, not approved — NOT included in any cost figure"
		}
	];
	const inRows = cashInRows(clientReceipts, { projectId: project?.id ?? null });
	const outRows = cashOutRows(supplierPayments, { projectId: project?.id ?? null });
	const cashIn = totalActualCashIn(inRows);
	const cashOut = totalActualCashOut(outRows);
	const receivables = receivablesSummary(clientInvoices, clientReceipts);
	const cashFigures = [
		{
			key: "cashIn",
			label: "Cash received (client receipts)",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.cashIn, cashIn, sourceStates),
			note: "Posted client receipts, gross"
		},
		{
			key: "cashOut",
			label: "Cash paid (supplier payments)",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.cashOut, cashOut, sourceStates),
			note: "Posted supplier payments, gross"
		},
		{
			key: "netCash",
			label: "Net recorded cash",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.netCash, actualNetCash(cashIn, cashOut), sourceStates),
			note: "Cash received − cash paid on this project; not a bank balance"
		},
		{
			key: "receivablesOutstanding",
			label: "Client invoices outstanding",
			kind: FIGURE_KIND.MONEY,
			figure: gated(REPORT_DEPENDENCIES.receivables, receivables.remaining, sourceStates),
			note: "Issued client invoices not yet matched to a receipt, gross — not cash"
		},
		{
			key: "remainingPayable",
			label: "Supplier invoices unpaid",
			kind: FIGURE_KIND.MONEY,
			figure: availableFigure("remainingPayable", snapshot.remainingPayable.value, sourceStates),
			note: "Posted supplier invoices still payable, gross — not cash"
		}
	];
	const overall = figureState(REPORT_SOURCES, sourceStates);
	const failedSources = REPORT_SOURCES.filter((src) => {
		const s = sourceStates?.[src];
		return !s || typeof s.loading !== "boolean" || typeof s.error !== "boolean" || s.error;
	});
	const loading = REPORT_SOURCES.some((src) => sourceStates?.[src]?.loading === true);
	return {
		projectId: project?.id ?? null,
		projectName: project?.name ?? "",
		currencyCode,
		budgetSource: snapshot.budgetSource,
		budgetSourceCaption: budgetSourceCaption(budgetSource),
		contractNotEstablished: notEstablished,
		state: overall.state,
		loading,
		failedSources,
		summary,
		costCodes: costCodeTable,
		variations: variationFigures,
		cash: cashFigures
	};
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
//#region src/lib/finalAccount.js
const FINAL_ACCOUNT_STATUS = {
	DRAFT: "draft",
	APPROVED: "approved",
	WITHDRAWN: "withdrawn"
};
const FINAL_ACCOUNT_STATUS_LABELS = {
	[FINAL_ACCOUNT_STATUS.DRAFT]: "Draft",
	[FINAL_ACCOUNT_STATUS.APPROVED]: "Approved",
	[FINAL_ACCOUNT_STATUS.WITHDRAWN]: "Withdrawn"
};
const FINAL_ACCOUNT_STATUS_BADGE = {
	[FINAL_ACCOUNT_STATUS.DRAFT]: "pending",
	[FINAL_ACCOUNT_STATUS.APPROVED]: "approved",
	[FINAL_ACCOUNT_STATUS.WITHDRAWN]: "draft"
};
const FINAL_ACCOUNT_LIMITS = {
	REASON: 500,
	REFERENCE: 200,
	ROWS: 1e3,
	NAME: 200
};
const FINAL_ACCOUNT_MAX_BYTES = 9e5;
const FINAL_ACCOUNT_PREPARE_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const FINAL_ACCOUNT_APPROVE_ROLES = ["company_admin", "project_manager"];
const canPrepareFinalAccount = (role) => FINAL_ACCOUNT_PREPARE_ROLES.includes(role);
const canApproveFinalAccount = (role) => FINAL_ACCOUNT_APPROVE_ROLES.includes(role);
const canWithdrawFinalAccount = (role, account, uid) => account?.status === FINAL_ACCOUNT_STATUS.DRAFT && (canApproveFinalAccount(role) || canPrepareFinalAccount(role) && !!uid && account.createdBy === uid);
const FINAL_ACCOUNT_DISCLAIMER = "Internal approval within Constrap. It is not a client agreement, a contractual certificate, a tax document or proof of payment.";
const FIGURE_BASIS = {
	EX_GST: "exGst",
	GROSS: "gross",
	PERCENT: "percent"
};
const FIGURE_GROUP = {
	CONTRACT: "contract",
	COST: "cost",
	RESULT: "result",
	BALANCES: "balances"
};
const FIGURE_GROUP_LABELS = {
	[FIGURE_GROUP.CONTRACT]: "Contract and revenue (ex-GST)",
	[FIGURE_GROUP.COST]: "Cost (ex-GST)",
	[FIGURE_GROUP.RESULT]: "Result (ex-GST)",
	[FIGURE_GROUP.BALANCES]: "Invoice balances and cash (gross, incl. GST)"
};
const FINAL_ACCOUNT_FIGURES = [
	{
		key: "originalContractValue",
		group: FIGURE_GROUP.CONTRACT,
		basis: FIGURE_BASIS.EX_GST,
		label: "Original contract sum",
		note: "From the Commercial baseline"
	},
	{
		key: "approvedClientVariations",
		group: FIGURE_GROUP.CONTRACT,
		basis: FIGURE_BASIS.EX_GST,
		label: "Approved client variations",
		note: "Approved only — pending variations block approval"
	},
	{
		key: "finalContractSum",
		group: FIGURE_GROUP.CONTRACT,
		basis: FIGURE_BASIS.EX_GST,
		label: "Final adjusted contract sum",
		note: "Original contract sum + approved client variations"
	},
	{
		key: "invoicedToClient",
		group: FIGURE_GROUP.CONTRACT,
		basis: FIGURE_BASIS.EX_GST,
		label: "Invoiced to client",
		note: "Issued client invoices — an invoice is not a certificate and not cash"
	},
	{
		key: "remainingToInvoice",
		group: FIGURE_GROUP.CONTRACT,
		basis: FIGURE_BASIS.EX_GST,
		label: "Remaining to invoice",
		note: "Final adjusted contract sum − invoiced to client (negative = over-invoiced)",
		open: true
	},
	{
		key: "approvedBudget",
		group: FIGURE_GROUP.COST,
		basis: FIGURE_BASIS.EX_GST,
		label: "Approved budget",
		note: "The approved version and its approved adjustments"
	},
	{
		key: "approvedSupplierVariations",
		group: FIGURE_GROUP.COST,
		basis: FIGURE_BASIS.EX_GST,
		label: "Approved supplier variations",
		note: "Gross approved value — already inside the cost below"
	},
	{
		key: "actualCost",
		group: FIGURE_GROUP.COST,
		basis: FIGURE_BASIS.EX_GST,
		label: "Actual cost",
		note: "Approved claims + posted supplier invoices − posted credit notes"
	},
	{
		key: "costToComplete",
		group: FIGURE_GROUP.COST,
		basis: FIGURE_BASIS.EX_GST,
		label: "Cost to complete",
		note: "Must be zero for approval"
	},
	{
		key: "finalCost",
		group: FIGURE_GROUP.COST,
		basis: FIGURE_BASIS.EX_GST,
		label: "Final cost",
		note: "Actual cost + cost to complete"
	},
	{
		key: "varianceToBudget",
		group: FIGURE_GROUP.COST,
		basis: FIGURE_BASIS.EX_GST,
		label: "Variance to budget",
		note: "Approved budget − final cost (negative = over budget)"
	},
	{
		key: "finalProfit",
		group: FIGURE_GROUP.RESULT,
		basis: FIGURE_BASIS.EX_GST,
		label: "Final gross profit",
		note: "Final adjusted contract sum − final cost"
	},
	{
		key: "finalMarginPct",
		group: FIGURE_GROUP.RESULT,
		basis: FIGURE_BASIS.PERCENT,
		label: "Final margin",
		note: "Final gross profit ÷ final adjusted contract sum",
		nullable: true
	},
	{
		key: "invoicedToClientGross",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Invoiced to client (gross)",
		note: "Issued client invoices incl. GST"
	},
	{
		key: "receivedAgainstInvoices",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Received against invoices",
		note: "Posted client receipts allocated to issued invoices"
	},
	{
		key: "receivablesOutstanding",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Client invoices outstanding",
		note: "Issued and not yet matched to a receipt — not cash",
		open: true
	},
	{
		key: "cashReceived",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Cash received",
		note: "All posted client receipts"
	},
	{
		key: "unallocatedReceipts",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Unallocated client receipts",
		note: "Received but not matched to an invoice",
		open: true
	},
	{
		key: "cashPaid",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Cash paid",
		note: "All posted supplier payments"
	},
	{
		key: "payablesOutstanding",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Supplier invoices unpaid",
		note: "Posted and still payable — not cash",
		open: true
	},
	{
		key: "unallocatedPayments",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Unallocated supplier payments",
		note: "Paid but not matched to an invoice",
		open: true
	},
	{
		key: "retentionHeld",
		group: FIGURE_GROUP.BALANCES,
		basis: FIGURE_BASIS.GROSS,
		label: "Supplier retention still held",
		note: "Withheld and not yet released — not payable until released",
		open: true
	}
];
const FINAL_ACCOUNT_FIGURE_KEYS = FINAL_ACCOUNT_FIGURES.map((f) => f.key);
const FINAL_ACCOUNT_ROW_KEYS = [
	"costCodeId",
	"costCodeName",
	"approvedBudget",
	"actualCost",
	"variance"
];
const FINAL_ACCOUNT_OPEN_KEYS = FINAL_ACCOUNT_FIGURES.filter((f) => f.open).map((f) => f.key);
const FINAL_ACCOUNT_COUNTED_SOURCES = [
	"purchaseOrders",
	"progressClaims",
	"supplierInvoices",
	"supplierCreditNotes",
	"variations",
	"forecastLines",
	"supplierPayments",
	"retentionReleases",
	"clientInvoices",
	"clientReceipts"
];
const BLOCKER = {
	SOURCES: "sources",
	CONTRACT: "contract",
	BUDGET: "budget",
	CLIENT_VARIATIONS: "clientVariations",
	SUPPLIER_VARIATIONS: "supplierVariations",
	UNAPPLIED_VARIATIONS: "unappliedVariations",
	OPEN_CLAIMS: "openClaims",
	CLAIMS_AWAITING: "claimsAwaitingInvoice",
	UNPOSTED_INVOICES: "unpostedInvoices",
	DRAFT_CLIENT_INVOICES: "draftClientInvoices",
	DRAFT_RECEIPTS: "draftReceipts",
	DRAFT_PAYMENTS: "draftPayments",
	DRAFT_CREDIT_NOTES: "draftCreditNotes",
	DRAFT_RELEASES: "draftReleases",
	OVER_ALLOCATED: "overAllocatedInvoices",
	COST_TO_COMPLETE: "costToComplete",
	FIGURES: "figures",
	SIZE: "size"
};
const READINESS_CHECKS = [
	{
		code: BLOCKER.SOURCES,
		label: "Every financial record loaded",
		fix: "Reload the page. A figure that cannot be read is never treated as zero."
	},
	{
		code: BLOCKER.CONTRACT,
		label: "Original contract sum set",
		fix: "Set the contract value on the Commercial tab."
	},
	{
		code: BLOCKER.BUDGET,
		label: "Budget approved",
		fix: "Approve a budget version on the Budget tab. A working or unavailable budget cannot be finalised."
	},
	{
		code: BLOCKER.CLIENT_VARIATIONS,
		label: "No draft or submitted client variations",
		fix: "Approve, reject or withdraw each one on the Variations tab."
	},
	{
		code: BLOCKER.SUPPLIER_VARIATIONS,
		label: "No draft or submitted supplier variations",
		fix: "Approve, reject or withdraw each one on the Variations tab."
	},
	{
		code: BLOCKER.UNAPPLIED_VARIATIONS,
		label: "No approved supplier variation left out of cost",
		fix: "Apply or commit each approved supplier variation so its value is inside Final cost."
	},
	{
		code: BLOCKER.OPEN_CLAIMS,
		label: "No draft, submitted or under-review progress claims",
		fix: "Approve or reject each open claim."
	},
	{
		code: BLOCKER.CLAIMS_AWAITING,
		label: "No approved claim awaiting its supplier invoice",
		fix: "Post the supplier invoice for each approved claim."
	},
	{
		code: BLOCKER.UNPOSTED_INVOICES,
		label: "No unposted supplier invoices",
		fix: "Post or cancel each draft or approved supplier invoice."
	},
	{
		code: BLOCKER.DRAFT_CLIENT_INVOICES,
		label: "No draft client invoices",
		fix: "Issue or void each draft client invoice."
	},
	{
		code: BLOCKER.DRAFT_RECEIPTS,
		label: "No draft client receipts",
		fix: "Post or void each draft receipt."
	},
	{
		code: BLOCKER.DRAFT_PAYMENTS,
		label: "No draft supplier payments",
		fix: "Post or void each draft payment."
	},
	{
		code: BLOCKER.DRAFT_CREDIT_NOTES,
		label: "No draft supplier credit notes",
		fix: "Post or void each draft credit note."
	},
	{
		code: BLOCKER.DRAFT_RELEASES,
		label: "No draft retention releases",
		fix: "Post or void each draft retention release."
	},
	{
		code: BLOCKER.OVER_ALLOCATED,
		label: "No over-allocated issued client invoices",
		fix: "An issued client invoice has more receipt allocated to it than its gross value. Correct the receipt allocation on the Client Receipts tab (void the receipt and re-enter it) so no invoice is over-allocated. Nothing is reallocated automatically."
	},
	{
		code: BLOCKER.COST_TO_COMPLETE,
		label: "Cost to complete is zero",
		fix: "Close out remaining commitment (a closing supplier variation on each under-run purchase order line) and set every uncommitted cost to complete to zero on the Forecast tab."
	},
	{
		code: BLOCKER.FIGURES,
		label: "Every figure is a valid amount",
		fix: "A figure could not be calculated from the records. Check SHIELD for integrity findings."
	},
	{
		code: BLOCKER.SIZE,
		label: "Within the size of one record",
		fix: "This project has more cost codes than one Final Account record can hold."
	}
];
const isMoney = (v) => typeof v === "number" && Number.isFinite(v);
const SETTLED = {
	loading: false,
	error: false
};
const settledSourceStates = () => Object.fromEntries(REPORT_SOURCES.map((s) => [s, SETTLED]));
const pick = (items, key) => {
	const f = items.find((i) => i.key === key)?.figure;
	return f && f.state === FIGURE_STATE.READY && f.value !== void 0 ? f.value : null;
};
const countWhere = (list, test) => (list ?? []).filter(test).length;
function computeFinalAccount({ project = null, currencyCode, sources = {}, sourceStates = {} } = {}) {
	const { budgetLines = [], approvedBudget = null, purchaseOrders = [], progressClaims = [], supplierInvoices = [], supplierCreditNotes = [], variations = [], forecastLines = [], supplierPayments = [], retentionReleases = [], clientInvoices = [], clientReceipts = [], costCodes = [] } = sources;
	const report = buildCommercialReport({
		project,
		currencyCode,
		sources,
		sourceStates
	});
	const cc = sourceStates?.costCodes;
	const namesLoading = cc?.loading === true;
	const namesFailed = cc?.error === true;
	const loading = report.loading === true || namesLoading;
	const failedSources = namesFailed ? [...report.failedSources, "costCodes"] : report.failedSources;
	const sourcesReady = !loading && failedSources.length === 0;
	const budgetSource = resolveBudgetSource({
		approvedBudget,
		budgetLines,
		budgetLinesLoading: sourceStates?.budgetLines?.loading === true,
		budgetLinesError: sourceStates?.budgetLines?.error === true,
		currencyCode
	});
	const budgetApproved = budgetSource.kind === BUDGET_SOURCE.APPROVED;
	const totals = projectForecastTotals({
		costCodes,
		budgetLines: budgetLinesFor(budgetSource),
		purchaseOrders,
		progressClaims,
		supplierInvoices,
		supplierCreditNotes,
		variations,
		forecastLines
	});
	const finalContractSum = pick(report.summary, "currentContractSum");
	const control = contractControl(clientInvoices, finalContractSum);
	const receivables = receivablesSummary(clientInvoices, clientReceipts);
	const receipts = receiptSummary(clientReceipts);
	const payments = paymentSummary(supplierPayments);
	const retention = retentionSummary(supplierInvoices, retentionReleases);
	const raw = {
		originalContractValue: pick(report.summary, "originalContractValue"),
		approvedClientVariations: pick(report.variations, "approvedClientVariations"),
		finalContractSum,
		invoicedToClient: control.issued.subtotal,
		remainingToInvoice: finalContractSum === null ? null : control.availableToInvoice,
		approvedBudget: budgetApproved ? pick(report.summary, "approvedBudget") : null,
		approvedSupplierVariations: pick(report.variations, "approvedSupplierVariations"),
		actualCost: pick(report.summary, "actual"),
		costToComplete: pick(report.summary, "costToComplete"),
		finalCost: pick(report.summary, "forecastFinalCost"),
		varianceToBudget: budgetApproved ? pick(report.summary, "varianceToBudget") : null,
		finalProfit: pick(report.summary, "forecastGrossProfit"),
		finalMarginPct: pick(report.summary, "forecastMarginPct"),
		invoicedToClientGross: control.issued.grossTotal,
		receivedAgainstInvoices: receivables.received,
		receivablesOutstanding: pick(report.cash, "receivablesOutstanding"),
		cashReceived: pick(report.cash, "cashIn"),
		unallocatedReceipts: receipts.unallocated,
		cashPaid: pick(report.cash, "cashOut"),
		payablesOutstanding: pick(report.cash, "remainingPayable"),
		unallocatedPayments: payments.unallocated,
		retentionHeld: retention.retentionHeld
	};
	const figuresValid = sourcesReady && FINAL_ACCOUNT_FIGURES.every((f) => isMoney(raw[f.key]) || f.nullable && raw[f.key] === null);
	const figures = figuresValid ? raw : null;
	const table = report.costCodes;
	const rows = table.state === FIGURE_STATE.READY ? table.rows.map((r) => ({
		costCodeId: String(r.costCodeId),
		costCodeName: String(r.costCodeName ?? "").slice(0, FINAL_ACCOUNT_LIMITS.NAME),
		approvedBudget: r.approvedBudget ?? null,
		actualCost: r.actual,
		variance: r.varianceToBudget ?? null
	})) : [];
	const rowsOpen = table.state === FIGURE_STATE.READY ? table.rows.filter((r) => toCents$1(r.costToComplete) !== 0).length : 0;
	const counts = {
		clientVariations: countWhere(variations, (v) => v.variationType === VARIATION_TYPE.CLIENT && VARIATION_PENDING_STATUSES.includes(v.status)),
		supplierVariations: countWhere(variations, (v) => v.variationType === VARIATION_TYPE.SUPPLIER && VARIATION_PENDING_STATUSES.includes(v.status)),
		openClaims: countWhere(progressClaims, (c) => CLAIM_OPEN_STATUSES.includes(c.status)),
		unpostedInvoices: countWhere(supplierInvoices, (i) => [
			SI_STATUS.DRAFT,
			SI_STATUS.RECEIVED,
			SI_STATUS.UNDER_REVIEW,
			SI_STATUS.APPROVED,
			SI_STATUS.DISPUTED
		].includes(i.status)),
		draftClientInvoices: draftClientInvoices(clientInvoices).length,
		draftReceipts: receipts.draftCount,
		draftPayments: payments.draftCount,
		draftCreditNotes: draftSupplierCreditNotes(supplierCreditNotes).length,
		draftReleases: draftRetentionReleases(retentionReleases).length
	};
	const overAllocated = receivables.rows.filter((r) => toCents$1(r.received) > toCents$1(r.grossTotal));
	const unapplied = pick(report.variations, "unappliedSupplierVariations");
	const awaiting = roundMoney(totals.approvedClaimsAwaitingInvoice);
	const blockers = [];
	const block = (code, detail = "") => blockers.push({
		code,
		detail
	});
	if (!sourcesReady) block(BLOCKER.SOURCES, loading ? "Still loading" : `Could not load: ${failedSources.map((s) => REPORT_SOURCE_LABELS[s] ?? (s === "costCodes" ? "Cost Codes" : s)).join(", ")}`);
	if (sourcesReady) {
		if (report.contractNotEstablished || !isMoney(raw.originalContractValue)) block(BLOCKER.CONTRACT);
		if (!budgetApproved) block(BLOCKER.BUDGET, budgetSource.kind === BUDGET_SOURCE.WORKING ? "Working budget (not approved)" : "Approved budget unavailable");
		if (counts.clientVariations > 0) block(BLOCKER.CLIENT_VARIATIONS, `${counts.clientVariations} open`);
		if (counts.supplierVariations > 0) block(BLOCKER.SUPPLIER_VARIATIONS, `${counts.supplierVariations} open`);
		if (unapplied === null || toCents$1(unapplied) !== 0) block(BLOCKER.UNAPPLIED_VARIATIONS);
		if (counts.openClaims > 0) block(BLOCKER.OPEN_CLAIMS, `${counts.openClaims} open`);
		if (toCents$1(awaiting) !== 0) block(BLOCKER.CLAIMS_AWAITING);
		if (counts.unpostedInvoices > 0) block(BLOCKER.UNPOSTED_INVOICES, `${counts.unpostedInvoices} unposted`);
		if (counts.draftClientInvoices > 0) block(BLOCKER.DRAFT_CLIENT_INVOICES, `${counts.draftClientInvoices} draft`);
		if (counts.draftReceipts > 0) block(BLOCKER.DRAFT_RECEIPTS, `${counts.draftReceipts} draft`);
		if (counts.draftPayments > 0) block(BLOCKER.DRAFT_PAYMENTS, `${counts.draftPayments} draft`);
		if (counts.draftCreditNotes > 0) block(BLOCKER.DRAFT_CREDIT_NOTES, `${counts.draftCreditNotes} draft`);
		if (counts.draftReleases > 0) block(BLOCKER.DRAFT_RELEASES, `${counts.draftReleases} draft`);
		if (overAllocated.length > 0) {
			const names = overAllocated.slice(0, 5).map((r) => r.invoiceNumber || r.id).join(", ");
			block(BLOCKER.OVER_ALLOCATED, `${overAllocated.length} over-allocated: ${names}${overAllocated.length > 5 ? ", …" : ""}`);
		}
		if (raw.costToComplete === null || toCents$1(raw.costToComplete) !== 0 || rowsOpen > 0 || raw.finalCost === null || raw.actualCost === null || toCents$1(raw.finalCost) !== toCents$1(raw.actualCost)) block(BLOCKER.COST_TO_COMPLETE);
		if (!figuresValid) block(BLOCKER.FIGURES);
		if (rows.length > FINAL_ACCOUNT_LIMITS.ROWS) block(BLOCKER.SIZE, `${rows.length} cost codes`);
	}
	return {
		currencyCode,
		loading,
		sourcesReady,
		failedSources,
		figures,
		partialFigures: raw,
		rows,
		provenance: {
			budgetApprovalId: budgetApproved ? budgetSource.pointer?.activeApprovalId ?? null : null,
			budgetVersion: budgetApproved ? budgetSource.version ?? null : null,
			adjustmentCount: budgetApproved ? budgetSource.adjustmentCount ?? 0 : 0,
			budgetCaption: budgetApproved ? `Approved version ${approvedVersionCaption(budgetSource)}` : "",
			counts: Object.fromEntries(FINAL_ACCOUNT_COUNTED_SOURCES.map((s) => [s, (sources[s] ?? []).length]))
		},
		blockers,
		ready: blockers.length === 0,
		openItems: figures ? openItemsOf(figures) : []
	};
}
function openItemsOf(figures) {
	return FINAL_ACCOUNT_FIGURES.filter((f) => f.open).map((f) => ({
		key: f.key,
		label: f.label,
		basis: f.basis,
		value: figures?.[f.key] ?? null
	}));
}
const blockerCodes = (computation) => (computation?.blockers ?? []).map((b) => b.code);
function readinessChecklist(computation) {
	const failed = new Map((computation?.blockers ?? []).map((b) => [b.code, b.detail]));
	const pending = !computation || computation.loading;
	return READINESS_CHECKS.map((c) => ({
		...c,
		state: pending ? "pending" : failed.has(c.code) ? "blocked" : failed.has(BLOCKER.SOURCES) ? "unknown" : "ok",
		detail: failed.get(c.code) ?? ""
	}));
}
function normaliseFinalAccountInput(input = {}) {
	return {
		reason: String(input.reason ?? "").trim(),
		reference: String(input.reference ?? "").trim()
	};
}
function validateFinalAccountInput(input = {}) {
	const { reason, reference } = normaliseFinalAccountInput(input);
	if (!reason) return "Enter the basis for this Final Account.";
	if (reason.length > FINAL_ACCOUNT_LIMITS.REASON) return `The basis must be ${FINAL_ACCOUNT_LIMITS.REASON} characters or fewer.`;
	if (reference.length > FINAL_ACCOUNT_LIMITS.REFERENCE) return `The reference must be ${FINAL_ACCOUNT_LIMITS.REFERENCE} characters or fewer.`;
	if (input.acknowledged !== true) return "Acknowledge the outstanding balances before preparing the draft.";
	return null;
}
function validateFinalAccountWithdrawReason(reason) {
	const r = String(reason ?? "").trim();
	if (!r) return "Enter a reason for withdrawing this draft.";
	if (r.length > FINAL_ACCOUNT_LIMITS.REASON) return `The reason must be ${FINAL_ACCOUNT_LIMITS.REASON} characters or fewer.`;
	return null;
}
const utf8 = (s) => {
	let n = 0;
	for (const ch of String(s)) {
		const c = ch.codePointAt(0);
		n += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4;
	}
	return n;
};
function sizeOf(v) {
	if (v === null || v === void 0 || typeof v === "boolean") return 1;
	if (typeof v === "number") return 8;
	if (typeof v === "string") return utf8(v) + 1;
	if (Array.isArray(v)) return v.reduce((s, e) => s + sizeOf(e), 0);
	if (typeof v === "object") return 32 + Object.entries(v).reduce((s, [k, e]) => s + utf8(k) + 1 + sizeOf(e), 0);
	return 8;
}
const estimateFinalAccountBytes = (payload) => 512 + sizeOf(payload);
function finalAccountContent(computation) {
	return {
		figures: { ...computation.figures },
		rows: computation.rows.map((r) => ({ ...r })),
		rowCount: computation.rows.length,
		sources: {
			...computation.provenance,
			counts: { ...computation.provenance.counts }
		}
	};
}
function buildFinalAccountDraft({ computation, number, input, currencyCode, preparedByName = "" }) {
	if (!Number.isInteger(number) || number < 1) return {
		ok: false,
		error: "The revision number is not valid."
	};
	const invalid = validateFinalAccountInput(input);
	if (invalid) return {
		ok: false,
		error: invalid
	};
	if (!computation?.ready || !computation.figures) return {
		ok: false,
		error: "The Final Account is not ready. Resolve every item on the readiness checklist first.",
		blockers: blockerCodes(computation)
	};
	const { reason, reference } = normaliseFinalAccountInput(input);
	const payload = {
		number,
		reason,
		reference,
		currency: currencyCode,
		...finalAccountContent(computation),
		openItemsAcknowledged: true,
		preparedByName: String(preparedByName ?? "").slice(0, FINAL_ACCOUNT_LIMITS.NAME)
	};
	const bytes = estimateFinalAccountBytes(payload);
	if (bytes > 9e5) return {
		ok: false,
		error: "This Final Account is too large for one record. Nothing was written and nothing was truncated.",
		bytes
	};
	return {
		ok: true,
		payload,
		bytes
	};
}
const sameAmount = (a, b) => a === null || a === void 0 || b === null || b === void 0 ? (a ?? null) === (b ?? null) : toCents$1(a) === toCents$1(b);
function finalAccountDifferences(stored, computation) {
	if (!stored || !computation) return {
		comparable: false,
		figures: [],
		rows: [],
		provenance: [],
		changed: false
	};
	if (!computation.sourcesReady) return {
		comparable: false,
		figures: [],
		rows: [],
		provenance: [],
		changed: false
	};
	const live = computation.partialFigures ?? {};
	const figures = [];
	for (const f of FINAL_ACCOUNT_FIGURES) {
		const a = stored.figures?.[f.key];
		const b = live[f.key];
		if (!sameAmount(a, b)) figures.push({
			key: f.key,
			label: f.label,
			basis: f.basis,
			stored: a ?? null,
			live: b ?? null
		});
	}
	const rows = [];
	const storedById = new Map((stored.rows ?? []).map((r) => [r.costCodeId, r]));
	const liveById = new Map((computation.rows ?? []).map((r) => [r.costCodeId, r]));
	for (const id of new Set([...storedById.keys(), ...liveById.keys()])) {
		const a = storedById.get(id);
		const b = liveById.get(id);
		if (!a || !b || !sameAmount(a.approvedBudget, b.approvedBudget) || !sameAmount(a.actualCost, b.actualCost) || !sameAmount(a.variance, b.variance)) rows.push({
			costCodeId: id,
			costCodeName: (b ?? a).costCodeName,
			stored: a ?? null,
			live: b ?? null
		});
	}
	const provenance = [];
	const sp = stored.sources ?? {};
	const lp = computation.provenance ?? {};
	if ((sp.budgetApprovalId ?? null) !== (lp.budgetApprovalId ?? null) || (sp.budgetVersion ?? null) !== (lp.budgetVersion ?? null) || (sp.adjustmentCount ?? 0) !== (lp.adjustmentCount ?? 0)) provenance.push("budget");
	for (const s of FINAL_ACCOUNT_COUNTED_SOURCES) if ((sp.counts?.[s] ?? null) !== (lp.counts?.[s] ?? null)) provenance.push(s);
	return {
		comparable: true,
		figures,
		rows,
		provenance,
		changed: figures.length > 0 || rows.length > 0
	};
}
function draftAgreesWith(stored, computation) {
	if (!stored || !computation?.figures) return false;
	const d = finalAccountDifferences(stored, computation);
	if (!d.comparable || d.changed) return false;
	if ((stored.rows ?? []).length !== computation.rows.length) return false;
	if (!computation.rows.every((r, i) => stored.rows[i]?.costCodeId === r.costCodeId)) return false;
	return !d.provenance.includes("budget");
}
const byNumber = (a, b) => (a.number ?? 0) - (b.number ?? 0);
const isFinalAccountRecord = (a) => !!a && Number.isInteger(a.number) && a.number >= 1 && Object.values(FINAL_ACCOUNT_STATUS).includes(a.status);
function finalAccountHistory(accounts) {
	const list = (accounts ?? []).filter(isFinalAccountRecord).slice().sort(byNumber);
	const approved = list.filter((a) => a.status === FINAL_ACCOUNT_STATUS.APPROVED);
	const current = approved.length ? approved[approved.length - 1] : null;
	const draft = list.find((a) => a.status === FINAL_ACCOUNT_STATUS.DRAFT) ?? null;
	const latest = list.length ? list[list.length - 1] : null;
	return {
		list: list.slice().reverse().map((a) => ({
			...a,
			superseded: a.status === FINAL_ACCOUNT_STATUS.APPROVED && current !== null && a.number < current.number,
			current: current !== null && a.number === current.number
		})),
		current,
		draft,
		nextNumber: (latest?.number ?? 0) + 1,
		canPrepare: draft === null
	};
}
const finalAccountRevisionLabel = (a) => `Revision ${a?.number ?? "—"}`;

//#endregion
export { BLOCKER, FIGURE_BASIS, FIGURE_GROUP, FIGURE_GROUP_LABELS, FINAL_ACCOUNT_APPROVE_ROLES, FINAL_ACCOUNT_COUNTED_SOURCES, FINAL_ACCOUNT_DISCLAIMER, FINAL_ACCOUNT_FIGURES, FINAL_ACCOUNT_FIGURE_KEYS, FINAL_ACCOUNT_LIMITS, FINAL_ACCOUNT_MAX_BYTES, FINAL_ACCOUNT_OPEN_KEYS, FINAL_ACCOUNT_PREPARE_ROLES, FINAL_ACCOUNT_ROW_KEYS, FINAL_ACCOUNT_STATUS, FINAL_ACCOUNT_STATUS_BADGE, FINAL_ACCOUNT_STATUS_LABELS, READINESS_CHECKS, blockerCodes, buildFinalAccountDraft, canApproveFinalAccount, canPrepareFinalAccount, canWithdrawFinalAccount, computeFinalAccount, draftAgreesWith, estimateFinalAccountBytes, finalAccountContent, finalAccountDifferences, finalAccountHistory, finalAccountRevisionLabel, isFinalAccountRecord, normaliseFinalAccountInput, openItemsOf, readinessChecklist, resolveProjectCurrency, settledSourceStates, validateFinalAccountInput, validateFinalAccountWithdrawReason };