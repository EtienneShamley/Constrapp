// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/boqBudgetTransfer.js and the
// modules it imports. Regenerate with `npm run functions:transfer-calc` (from frontend/).
// ADR-81: the trusted transferBoqToBudget callable runs this exact proposal.
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
const toCents = (n) => Math.round(safeAmount(n) * 100);
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
//#region src/lib/currency.js
const DEFAULT_CURRENCY = "AUD";
const CURRENCY_DISPLAY_LOCALE = "en-AU";
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
//#region src/lib/boq.js
const BOQ_STATUS = {
	ACTIVE: "active",
	VOID: "void"
};
const BOQ_STATUS_LABELS = {
	[BOQ_STATUS.ACTIVE]: "Active",
	[BOQ_STATUS.VOID]: "Void"
};
const BOQ_BADGE_VARIANTS = {
	[BOQ_STATUS.ACTIVE]: "active",
	[BOQ_STATUS.VOID]: "danger"
};
const BOQ_TRANSITIONS = {
	[BOQ_STATUS.ACTIVE]: [BOQ_STATUS.VOID],
	[BOQ_STATUS.VOID]: []
};
const isPriced = (rate) => rate !== null && rate !== void 0;
function boqLineAmount(quantity, rate) {
	if (!isPriced(rate)) return null;
	const qty = Number(quantity);
	const r = Number(rate);
	if (!Number.isFinite(qty) || !Number.isFinite(r)) return null;
	return toCents(qty * r) / 100;
}
const quantityFormatter = new Intl.NumberFormat(CURRENCY_DISPLAY_LOCALE, { maximumFractionDigits: 3 });

//#endregion
//#region src/lib/costCodes.js
const costCodeDisplayName = (costCode) => costCode ? `${costCode.code} — ${costCode.name}` : "";
const isActiveCostCode = (costCode) => costCode?.isActive !== false;

//#endregion
//#region src/lib/boqBudgetTransfer.js
const BOQ_TRANSFER_VERSION = "v1";
const BOQ_TRANSFER_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const canTransferBoqToBudget = (role) => BOQ_TRANSFER_ROLES.includes(role);
const BOQ_LINE_ID_PREFIX = "boq-";
const boqBudgetLineId = (costCodeId) => `${BOQ_LINE_ID_PREFIX}${costCodeId}`;
const TRANSFER_ROW_STATE = {
	CREATE: "create",
	REFRESH: "refresh",
	UNCHANGED: "unchanged",
	ZERO_AVAILABLE: "zero-available",
	BLOCKED: "blocked"
};
const TRANSFER_ROW_STATE_LABELS = {
	[TRANSFER_ROW_STATE.CREATE]: "Create",
	[TRANSFER_ROW_STATE.REFRESH]: "Refresh",
	[TRANSFER_ROW_STATE.UNCHANGED]: "Unchanged",
	[TRANSFER_ROW_STATE.ZERO_AVAILABLE]: "BOQ items void",
	[TRANSFER_ROW_STATE.BLOCKED]: "Blocked"
};
const TRANSFER_BLOCKER = {
	UNPRICED: "unpriced",
	INVALID_SOURCE: "invalid-source",
	CURRENCY_MISMATCH: "currency-mismatch",
	COST_CODE_MISSING: "cost-code-missing",
	COST_CODE_INACTIVE: "cost-code-inactive",
	MANUAL_LINE: "manual-line",
	MULTIPLE_LINES: "multiple-lines",
	INVALID_LINE: "invalid-line"
};
const TRANSFER_BLOCKER_LABELS = {
	[TRANSFER_BLOCKER.UNPRICED]: "One or more BOQ items on this cost code have no rate. Price every item (0 is a price) before transferring.",
	[TRANSFER_BLOCKER.INVALID_SOURCE]: "A BOQ item on this cost code has a quantity or amount that cannot be used. Open and re-save the item.",
	[TRANSFER_BLOCKER.CURRENCY_MISMATCH]: "A BOQ item on this cost code was priced in a different currency from the project.",
	[TRANSFER_BLOCKER.COST_CODE_MISSING]: "This cost code no longer exists in the cost-code library.",
	[TRANSFER_BLOCKER.COST_CODE_INACTIVE]: "This cost code is inactive.",
	[TRANSFER_BLOCKER.MANUAL_LINE]: "A manually entered budget line already holds this cost code. Correct it on the Budget tab — the transfer never adds a second line.",
	[TRANSFER_BLOCKER.MULTIPLE_LINES]: "More than one budget line shares this cost code. Resolve the manual line on the Budget tab before refreshing.",
	[TRANSFER_BLOCKER.INVALID_LINE]: "The existing BOQ-sourced budget line cannot be read as an amount."
};
const TRANSFER_OUTCOME = {
	APPLIED: "applied",
	ALREADY_APPLIED: "already-applied",
	UNCHANGED: "unchanged"
};
function fnv1a64(str, basis) {
	let hash = basis;
	const prime = 1099511628211n;
	const mask = 18446744073709551615n;
	for (let i = 0; i < str.length; i++) {
		hash ^= BigInt(str.charCodeAt(i));
		hash = hash * prime & mask;
	}
	return hash.toString(16).padStart(16, "0");
}
const digest = (str) => fnv1a64(str, 14695981039346656037n) + fnv1a64(str, 9521211207457086692n);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => isNumber(v) ? String(v) : "x";
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const centsToAmount = (cents) => cents / 100;
const itemKey = (item) => [
	item.id,
	num(item.quantity),
	isPriced(item.rate) ? num(item.rate) : "null",
	isPriced(item.rate) ? isNumber(item.amount) ? String(toCents(item.amount)) : "x" : "null",
	String(item.unit ?? ""),
	String(item.currency ?? "")
].join(":");
function sourceFingerprint(costCodeId, activeItems) {
	const rows = (activeItems ?? []).map(itemKey).sort(cmp);
	return `${"v1"}:${digest([
		costCodeId,
		String(rows.length),
		...rows
	].join("|"))}`;
}
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBoqSourcedLine = (line) => Boolean(line?.id) && Boolean(line?.costCodeId) && line.id === boqBudgetLineId(line.costCodeId) && isMap(line.boqSource);
function boqSourceInfo(line) {
	if (!isBoqSourcedLine(line)) return {
		isBoqSourced: false,
		first: null,
		latest: null,
		manuallyChanged: false
	};
	const first = isMap(line.boqSource.first) ? line.boqSource.first : null;
	const latest = isMap(line.boqSource.latest) ? line.boqSource.latest : null;
	return {
		isBoqSourced: true,
		first,
		latest,
		manuallyChanged: !latest || !isNumber(latest.amount) || !isNumber(line.budgeted) || toCents(latest.amount) !== toCents(line.budgeted)
	};
}
const validQuantity = (q) => isNumber(q) && q >= 0;
function pricedItemCents(item) {
	if (!validQuantity(item.quantity) || !isNumber(item.rate) || item.rate < 0) return null;
	if (!isNumber(item.amount) || item.amount < 0) return null;
	const derived = boqLineAmount(item.quantity, item.rate);
	if (derived === null || toCents(derived) !== toCents(item.amount)) return null;
	return toCents(item.amount);
}
function buildTransferProposal({ boqItems = [], budgetLines = [], costCodes = [], currencyCode = null } = {}) {
	const codeById = /* @__PURE__ */ new Map();
	for (const cc of costCodes ?? []) if (cc?.id) codeById.set(cc.id, cc);
	const itemsByCode = /* @__PURE__ */ new Map();
	for (const item of boqItems ?? []) {
		if (!item?.id || item.status !== BOQ_STATUS.ACTIVE || !item.costCodeId) continue;
		if (!itemsByCode.has(item.costCodeId)) itemsByCode.set(item.costCodeId, []);
		itemsByCode.get(item.costCodeId).push(item);
	}
	const linesByCode = /* @__PURE__ */ new Map();
	for (const line of budgetLines ?? []) {
		if (!line?.id || !line.costCodeId) continue;
		if (!linesByCode.has(line.costCodeId)) linesByCode.set(line.costCodeId, []);
		linesByCode.get(line.costCodeId).push(line);
	}
	const ids = new Set(itemsByCode.keys());
	for (const [costCodeId, lines] of linesByCode) if (lines.some(isBoqSourcedLine)) ids.add(costCodeId);
	const rows = [];
	for (const costCodeId of ids) {
		const items = itemsByCode.get(costCodeId) ?? [];
		const lines = linesByCode.get(costCodeId) ?? [];
		const sourced = lines.find(isBoqSourcedLine) ?? null;
		const manual = lines.filter((l) => l !== sourced);
		const cc = codeById.get(costCodeId) ?? null;
		const blockers = /* @__PURE__ */ new Set();
		let boqCents = 0;
		let unpricedCount = 0;
		let invalid = false;
		let mismatch = false;
		for (const item of items) {
			if (!isPriced(item.rate)) {
				unpricedCount += 1;
				continue;
			}
			const cents = pricedItemCents(item);
			if (cents === null) {
				invalid = true;
				continue;
			}
			if (typeof currencyCode !== "string" || item.currency !== currencyCode) mismatch = true;
			boqCents += cents;
		}
		if (unpricedCount > 0) blockers.add(TRANSFER_BLOCKER.UNPRICED);
		if (invalid) blockers.add(TRANSFER_BLOCKER.INVALID_SOURCE);
		if (mismatch) blockers.add(TRANSFER_BLOCKER.CURRENCY_MISMATCH);
		if (!cc) blockers.add(TRANSFER_BLOCKER.COST_CODE_MISSING);
		else if (!isActiveCostCode(cc)) blockers.add(TRANSFER_BLOCKER.COST_CODE_INACTIVE);
		if (manual.length > 0) blockers.add(sourced ? TRANSFER_BLOCKER.MULTIPLE_LINES : TRANSFER_BLOCKER.MANUAL_LINE);
		const sourcedValid = !sourced || isNumber(sourced.budgeted) && sourced.budgeted >= 0;
		if (!sourcedValid) blockers.add(TRANSFER_BLOCKER.INVALID_LINE);
		const sourcedCents = sourced && sourcedValid ? toCents(sourced.budgeted) : null;
		let workingCents = lines.length > 0 ? 0 : null;
		for (const l of lines) {
			if (workingCents === null) break;
			workingCents = isNumber(l.budgeted) ? workingCents + toCents(l.budgeted) : null;
		}
		const clean = blockers.size === 0;
		const sourceComplete = items.length > 0 && unpricedCount === 0 && !invalid;
		let state = TRANSFER_ROW_STATE.BLOCKED;
		if (clean) if (items.length === 0) state = sourcedCents === 0 ? TRANSFER_ROW_STATE.UNCHANGED : TRANSFER_ROW_STATE.ZERO_AVAILABLE;
		else if (!sourced) state = TRANSFER_ROW_STATE.CREATE;
		else state = sourcedCents === boqCents ? TRANSFER_ROW_STATE.UNCHANGED : TRANSFER_ROW_STATE.REFRESH;
		const info = boqSourceInfo(sourced);
		const itemName = items.find((i) => typeof i.costCodeName === "string" && i.costCodeName)?.costCodeName;
		const lineName = lines.find((l) => typeof l.costCodeName === "string" && l.costCodeName)?.costCodeName;
		rows.push({
			costCodeId,
			costCodeName: cc ? costCodeDisplayName(cc) : itemName || lineName || "Unknown cost code",
			lineId: boqBudgetLineId(costCodeId),
			state,
			blockers: [...blockers].sort(cmp),
			itemCount: items.length,
			unpricedCount,
			boqCents: sourceComplete ? boqCents : null,
			workingCents,
			hasSourcedLine: Boolean(sourced),
			sourcedCents,
			manualLineCount: manual.length,
			manuallyChanged: info.isBoqSourced && info.manuallyChanged,
			latestTransferCents: info.latest && isNumber(info.latest.amount) ? toCents(info.latest.amount) : null,
			fingerprint: sourceFingerprint(costCodeId, items)
		});
	}
	rows.sort((a, b) => a.costCodeName.localeCompare(b.costCodeName) || cmp(a.costCodeId, b.costCodeId));
	return {
		currencyCode,
		rows,
		reviewKey: reviewKeyOf(currencyCode, rows)
	};
}
const centsKey = (c) => c === null || c === void 0 ? "x" : String(c);
function reviewKeyOf(currencyCode, rows) {
	const parts = [...rows].sort((a, b) => cmp(a.costCodeId, b.costCodeId)).map((r) => [
		r.costCodeId,
		r.state,
		r.blockers.join(","),
		String(r.itemCount),
		centsKey(r.boqCents),
		centsKey(r.workingCents),
		centsKey(r.sourcedCents),
		r.fingerprint
	].join("~"));
	return `${"v1"}:${digest([
		"v1",
		String(currencyCode ?? ""),
		String(parts.length),
		...parts
	].join("|"))}`;
}
const isReviewKeyShape = (v) => typeof v === "string" && /^v1:[0-9a-f]{32}$/.test(v);
const normaliseZeroChoices = (ids) => [...new Set((ids ?? []).filter((id) => typeof id === "string" && id))].sort(cmp);
const transferRequestKey = (reviewKey, setToZero) => `r1:${digest([String(reviewKey ?? ""), ...normaliseZeroChoices(setToZero)].join("|"))}`;
const TRANSFER_OPERATION = {
	CREATE: "create",
	REFRESH: "refresh",
	ZERO: "zero"
};
function transferOperations(proposal, setToZero = []) {
	const zero = normaliseZeroChoices(setToZero);
	const byId = new Map((proposal?.rows ?? []).map((r) => [r.costCodeId, r]));
	const invalidZero = zero.filter((id) => byId.get(id)?.state !== TRANSFER_ROW_STATE.ZERO_AVAILABLE);
	if (invalidZero.length > 0) return {
		ok: false,
		invalidZero,
		operations: []
	};
	const operations = [];
	for (const row of proposal?.rows ?? []) {
		const base = {
			costCodeId: row.costCodeId,
			costCodeName: row.costCodeName,
			lineId: row.lineId,
			itemCount: row.itemCount,
			fingerprint: row.fingerprint,
			fromCents: row.sourcedCents
		};
		if (row.state === TRANSFER_ROW_STATE.CREATE) operations.push({
			...base,
			type: TRANSFER_OPERATION.CREATE,
			cents: row.boqCents,
			amount: centsToAmount(row.boqCents)
		});
		else if (row.state === TRANSFER_ROW_STATE.REFRESH) operations.push({
			...base,
			type: TRANSFER_OPERATION.REFRESH,
			cents: row.boqCents,
			amount: centsToAmount(row.boqCents)
		});
		else if (row.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE && zero.includes(row.costCodeId)) operations.push({
			...base,
			type: TRANSFER_OPERATION.ZERO,
			cents: 0,
			amount: 0
		});
	}
	operations.sort((a, b) => cmp(a.costCodeId, b.costCodeId));
	return {
		ok: true,
		invalidZero: [],
		operations
	};
}
function applyOperationsToLines(budgetLines, operations) {
	const next = (budgetLines ?? []).map((l) => ({ ...l }));
	for (const op of operations ?? []) {
		const existing = next.find((l) => l.id === op.lineId);
		if (existing) existing.budgeted = op.amount;
		else next.push({
			id: op.lineId,
			costCodeId: op.costCodeId,
			costCodeName: op.costCodeName,
			budgeted: op.amount,
			boqSource: {}
		});
	}
	return next;
}
function resultKeyAfter({ boqItems, budgetLines, costCodes, currencyCode }, operations) {
	return buildTransferProposal({
		boqItems,
		budgetLines: applyOperationsToLines(budgetLines, operations),
		costCodes,
		currencyCode
	}).reviewKey;
}
function findAppliedRequest(budgetLines, requestKey, currentReviewKey) {
	for (const line of budgetLines ?? []) {
		const latest = boqSourceInfo(line).latest;
		if (latest && latest.requestKey === requestKey && latest.resultKey === currentReviewKey) return {
			lineId: line.id,
			by: latest.by ?? null
		};
	}
	return null;
}
const sum = (list, pick) => list.reduce((s, x) => s + (pick(x) ?? 0), 0);
function transferSummary(proposal, setToZero = []) {
	const rows = proposal?.rows ?? [];
	const { ok, operations } = transferOperations(proposal, setToZero);
	const of = (type) => operations.filter((o) => o.type === type);
	const blocked = rows.filter((r) => r.state === TRANSFER_ROW_STATE.BLOCKED);
	return {
		valid: ok,
		rowCount: rows.length,
		createCount: of(TRANSFER_OPERATION.CREATE).length,
		refreshCount: of(TRANSFER_OPERATION.REFRESH).length,
		zeroCount: of(TRANSFER_OPERATION.ZERO).length,
		operationCount: operations.length,
		unchangedCount: rows.filter((r) => r.state === TRANSFER_ROW_STATE.UNCHANGED).length,
		zeroAvailableCount: rows.filter((r) => r.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE).length,
		blockedCount: blocked.length,
		beforeCents: sum(operations, (o) => o.fromCents),
		afterCents: sum(operations, (o) => o.cents),
		blockedBoqCents: sum(blocked, (r) => r.boqCents),
		blockedUnknownCount: blocked.filter((r) => r.itemCount > 0 && r.boqCents === null).length
	};
}
const BOQ_TRANSFER_REQUEST_KEYS = [
	"projectId",
	"reviewKey",
	"setToZero"
];
const BOQ_TRANSFER_MAX_ZERO_CHOICES = 2e3;

//#endregion
export { BOQ_LINE_ID_PREFIX, BOQ_TRANSFER_MAX_ZERO_CHOICES, BOQ_TRANSFER_REQUEST_KEYS, BOQ_TRANSFER_ROLES, BOQ_TRANSFER_VERSION, TRANSFER_BLOCKER, TRANSFER_BLOCKER_LABELS, TRANSFER_OPERATION, TRANSFER_OUTCOME, TRANSFER_ROW_STATE, TRANSFER_ROW_STATE_LABELS, applyOperationsToLines, boqBudgetLineId, boqSourceInfo, buildTransferProposal, canTransferBoqToBudget, centsToAmount, findAppliedRequest, isBoqSourcedLine, isReviewKeyShape, normaliseZeroChoices, resolveProjectCurrency, resultKeyAfter, sourceFingerprint, transferOperations, transferRequestKey, transferSummary };