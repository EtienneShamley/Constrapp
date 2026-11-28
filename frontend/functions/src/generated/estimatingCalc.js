// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/estimatingCalc.js and the
// modules it imports. Regenerate with `npm run functions:estimating-calc` (from frontend/).
// ADR-97: the trusted estimateOperation callable runs this exact domain logic.
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
//#region src/lib/money.js
const MAX_SUPPORTED_AMOUNT_CENTS = 99999999999999;
const MAX_SUPPORTED_AMOUNT_TEXT = "999,999,999,999.99";
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
//#region src/lib/estimateSource.js
const ESTIMATE_SOURCE_VERSION = "est1";
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
const fnvDigest = (str) => fnv1a64(str, 14695981039346656037n) + fnv1a64(str, 9521211207457086692n);
const isNumber$1 = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => isNumber$1(v) ? String(v) : "x";
const cmp$1 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sourceItemKey = ({ id, quantity, rate, amountCents, unit, currency, costCodeId }) => [
	id,
	num(quantity),
	rate === null ? "null" : num(rate),
	amountCents === null ? "null" : String(amountCents),
	String(unit ?? ""),
	String(currency ?? ""),
	String(costCodeId ?? "")
].join(":");
const liveItemKey = (item) => sourceItemKey({
	id: item.id,
	quantity: item.quantity,
	rate: isPriced(item.rate) ? item.rate : null,
	amountCents: isPriced(item.rate) ? isNumber$1(item.amount) ? toCents(item.amount) : "x" : null,
	unit: item.unit,
	currency: item.currency,
	costCodeId: item.costCodeId
});
const sourceKeyOfRows = (rows) => `${ESTIMATE_SOURCE_VERSION}:${fnvDigest([String(rows.length), ...[...rows].sort(cmp$1)].join("|"))}`;
function estimateSourceKey(boqItems) {
	return sourceKeyOfRows((boqItems ?? []).filter((i) => i?.status === "active").map(liveItemKey));
}
const isEstimateSourceKeyShape = (v) => typeof v === "string" && /^est1:[0-9a-f]{32}$/.test(v);

//#endregion
//#region src/lib/estimating.js
const ESTIMATING_VERSION = 1;
const ESTIMATE_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const ESTIMATE_APPROVER_ROLES = ["company_admin", "project_manager"];
const canPrepareEstimate = (role) => ESTIMATE_ROLES.includes(role);
const canApproveEstimate = (role) => ESTIMATE_APPROVER_ROLES.includes(role);
const ESTIMATE_STATE = {
	BUILDING: "building",
	DRAFT: "draft",
	APPROVED: "approved",
	DISCARDED: "discarded"
};
const ESTIMATE_STATE_LABELS = {
	[ESTIMATE_STATE.BUILDING]: "Building",
	[ESTIMATE_STATE.DRAFT]: "Draft",
	[ESTIMATE_STATE.APPROVED]: "Approved",
	[ESTIMATE_STATE.DISCARDED]: "Discarded"
};
const ESTIMATE_BADGE_VARIANTS = {
	[ESTIMATE_STATE.BUILDING]: "pending",
	[ESTIMATE_STATE.DRAFT]: "pending",
	[ESTIMATE_STATE.APPROVED]: "active",
	[ESTIMATE_STATE.DISCARDED]: "danger"
};
const PRICING_POLICY = {
	MARKUP_ON_COST: "markup_on_cost",
	MARGIN_ON_SELL: "margin_on_sell"
};
const PRICING_POLICY_LABELS = {
	[PRICING_POLICY.MARKUP_ON_COST]: "Markup on cost",
	[PRICING_POLICY.MARGIN_ON_SELL]: "Margin on selling price"
};
const ALLOWANCE_MODE = {
	NONE: "none",
	COST_CODED: "cost_coded",
	PERCENTAGE: "percentage"
};
const ALLOWANCE_MODE_LABELS = {
	[ALLOWANCE_MODE.NONE]: "None",
	[ALLOWANCE_MODE.COST_CODED]: "Cost-coded BOQ items",
	[ALLOWANCE_MODE.PERCENTAGE]: "Percentage of construction cost"
};
const COST_CLASS = {
	DIRECT: "direct",
	PRELIMINARIES: "preliminaries",
	OVERHEAD: "overhead",
	CONTINGENCY: "contingency"
};
const COST_CLASS_LABELS = {
	[COST_CLASS.DIRECT]: "Direct cost",
	[COST_CLASS.PRELIMINARIES]: "Preliminaries",
	[COST_CLASS.OVERHEAD]: "Overhead",
	[COST_CLASS.CONTINGENCY]: "Contingency"
};
const ASSIGNABLE_COST_CLASSES = [
	COST_CLASS.PRELIMINARIES,
	COST_CLASS.OVERHEAD,
	COST_CLASS.CONTINGENCY
];
const COMPONENT_KEYS = [
	"labour",
	"material",
	"plant",
	"subcontractor"
];
const COMPONENT_LABELS = {
	labour: "Labour",
	material: "Material",
	plant: "Plant",
	subcontractor: "Subcontractor"
};
const BPS = 1e4;
const MAX_MARKUP_BPS = 1e5;
const MAX_MARGIN_BPS = BPS - 1;
const MAX_ALLOWANCE_BPS = BPS;
const ESTIMATE_MAX_ITEMS = 5e3;
const ESTIMATE_DESCRIPTION_MAX = 1e3;
const ESTIMATE_TEXT_MAX = 200;
const ESTIMATE_ITEM_NUMBER_MAX = 40;
const ESTIMATE_UNIT_MAX = 40;
const ESTIMATE_ID_MAX = 128;
const ESTIMATE_CURRENCY_MAX = 3;
const ESTIMATE_TITLE_MAX = 120;
const ESTIMATE_NOTES_MAX = 2e3;
const ESTIMATE_MAX_CLASSES = 1e3;
const SET_COMPONENTS_MAX_ITEMS = 200;
const PROBLEM_SAMPLE = 20;
const ESTIMATE_PROBLEM = {
	EMPTY: "empty",
	TOO_LARGE: "too-large",
	UNPRICED: "unpriced",
	INVALID_SOURCE: "invalid-source",
	CURRENCY_MISMATCH: "currency-mismatch",
	COMPONENTS_UNRECONCILED: "components-unreconciled",
	CLASS_UNUSED: "class-unused",
	OUT_OF_RANGE: "out-of-range",
	TEXT_TOO_LONG: "text-too-long"
};
const ESTIMATE_PROBLEM_LABELS = {
	[ESTIMATE_PROBLEM.EMPTY]: "The BOQ has no active items to estimate.",
	[ESTIMATE_PROBLEM.TOO_LARGE]: `The BOQ holds more than ${ESTIMATE_MAX_ITEMS.toLocaleString("en-AU")} items — more than one estimate revision supports.`,
	[ESTIMATE_PROBLEM.UNPRICED]: "Some BOQ items have no rate. Price every item (0 is a price) before estimating.",
	[ESTIMATE_PROBLEM.INVALID_SOURCE]: "A BOQ item has a quantity, rate or amount that cannot be used. Open and re-save the item.",
	[ESTIMATE_PROBLEM.CURRENCY_MISMATCH]: "A BOQ item was priced in a different currency from the project.",
	[ESTIMATE_PROBLEM.COMPONENTS_UNRECONCILED]: "A rate breakdown no longer adds up to its item’s unit rate. Correct or clear the breakdown.",
	[ESTIMATE_PROBLEM.CLASS_UNUSED]: "A cost code is classified but has no active BOQ item.",
	[ESTIMATE_PROBLEM.OUT_OF_RANGE]: `The estimate is larger than the supported maximum of ${MAX_SUPPORTED_AMOUNT_TEXT}.`,
	[ESTIMATE_PROBLEM.TEXT_TOO_LONG]: `A BOQ item's text is longer than an estimate revision can store (description ${ESTIMATE_DESCRIPTION_MAX.toLocaleString("en-AU")}, section and cost-code name ${200}, item number ${40} characters). Constrap never shortens it for you — shorten it on the BOQ tab, then build again.`
};
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBps = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const centsToAmount = (cents) => cents / 100;
const percentOfCents = (cents, bps) => shareOfCents(cents, bps, BPS);
function sellingPriceCents(costCents, pricingPolicy, pricingBps) {
	if (!Number.isSafeInteger(costCents) || costCents < 0) return { problem: "The cost total is not a whole, non-negative number of cents." };
	if (pricingPolicy === PRICING_POLICY.MARKUP_ON_COST) {
		if (!isBps(pricingBps, 1e5)) return { problem: `A markup must be between 0% and ${MAX_MARKUP_BPS / 100}%.` };
		return { sellCents: costCents + percentOfCents(costCents, pricingBps) };
	}
	if (pricingPolicy === PRICING_POLICY.MARGIN_ON_SELL) {
		if (!Number.isSafeInteger(pricingBps) || pricingBps < 0) return { problem: "A margin cannot be negative." };
		if (pricingBps >= 1e4) return { problem: "A margin of 100% or more of the selling price has no selling price. Enter a margin below 100%." };
		const d = BigInt(BPS - pricingBps);
		const sell = (2n * BigInt(costCents) * BigInt(BPS) + d) / (2n * d);
		if (sell > BigInt(Number.MAX_SAFE_INTEGER)) return { problem: ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.OUT_OF_RANGE] };
		return { sellCents: Number(sell) };
	}
	return { problem: "Choose a pricing policy: markup on cost, or margin on selling price." };
}
function achievedBps(costCents, sellCents) {
	const profit = sellCents - costCents;
	const ratio = (whole) => whole > 0 && profit >= 0 ? shareOfCents(BPS, profit, whole) : null;
	return {
		markupBps: ratio(costCents),
		marginBps: ratio(sellCents)
	};
}
const ESTIMATE_SETTINGS_KEYS = [
	"title",
	"notes",
	"pricingPolicy",
	"pricingBps",
	"overheadMode",
	"overheadBps",
	"contingencyMode",
	"contingencyBps",
	"costCodeClasses"
];
const defaultEstimateSettings = () => ({
	title: "",
	notes: "",
	pricingPolicy: PRICING_POLICY.MARKUP_ON_COST,
	pricingBps: 0,
	overheadMode: ALLOWANCE_MODE.NONE,
	overheadBps: 0,
	contingencyMode: ALLOWANCE_MODE.NONE,
	contingencyBps: 0,
	costCodeClasses: []
});
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function estimateSettingsProblem(s) {
	if (!isObject(s) || Object.keys(s).length !== ESTIMATE_SETTINGS_KEYS.length || ESTIMATE_SETTINGS_KEYS.some((k) => !(k in s))) return "The estimate settings are incomplete.";
	if (typeof s.title !== "string" || s.title.length > 120) return `The title must be at most ${120} characters.`;
	if (typeof s.notes !== "string" || s.notes.length > 2e3) return `The notes must be at most ${ESTIMATE_NOTES_MAX} characters.`;
	const price = sellingPriceCents(0, s.pricingPolicy, s.pricingBps);
	if (price.problem) return price.problem;
	if (!Array.isArray(s.costCodeClasses) || s.costCodeClasses.length > 1e3) return "The cost code classification is not valid.";
	const seen = /* @__PURE__ */ new Set();
	const used = /* @__PURE__ */ new Set();
	for (const c of s.costCodeClasses) {
		if (!isObject(c) || Object.keys(c).length !== 2 || typeof c.costCodeId !== "string" || !ID_RE.test(c.costCodeId) || !ASSIGNABLE_COST_CLASSES.includes(c.costClass)) return "The cost code classification is not valid.";
		if (seen.has(c.costCodeId)) return "A cost code is classified twice.";
		seen.add(c.costCodeId);
		used.add(c.costClass);
	}
	for (const [name, mode, bps, cls] of [[
		"Overhead",
		s.overheadMode,
		s.overheadBps,
		COST_CLASS.OVERHEAD
	], [
		"Contingency",
		s.contingencyMode,
		s.contingencyBps,
		COST_CLASS.CONTINGENCY
	]]) {
		if (!Object.values(ALLOWANCE_MODE).includes(mode)) return `Choose how ${name.toLowerCase()} is treated.`;
		if (!isBps(bps, 1e4)) return `${name} must be between 0% and ${MAX_ALLOWANCE_BPS / 100}%.`;
		if (mode !== ALLOWANCE_MODE.PERCENTAGE && bps !== 0) return `${name} has a percentage but is not set to a percentage of construction cost.`;
		if (mode !== ALLOWANCE_MODE.COST_CODED && used.has(cls)) return mode === ALLOWANCE_MODE.PERCENTAGE ? `${name} is a percentage, but a cost code is also classified as ${name.toLowerCase()} — it would be counted twice. Choose one.` : `A cost code is classified as ${name.toLowerCase()}, but ${name.toLowerCase()} is set to none.`;
	}
	return null;
}
function normaliseEstimateSettings(s) {
	return {
		title: s.title.trim(),
		notes: s.notes.trim(),
		pricingPolicy: s.pricingPolicy,
		pricingBps: s.pricingBps,
		overheadMode: s.overheadMode,
		overheadBps: s.overheadBps,
		contingencyMode: s.contingencyMode,
		contingencyBps: s.contingencyBps,
		costCodeClasses: [...s.costCodeClasses].map((c) => ({
			costCodeId: c.costCodeId,
			costClass: c.costClass
		})).sort((a, b) => cmp(a.costCodeId, b.costCodeId))
	};
}
const UNITS = 1e4;
function rateUnits(v) {
	if (!isNumber(v) || v < 0) return null;
	const scaled = v * UNITS;
	const whole = Math.round(scaled);
	if (!Number.isSafeInteger(whole) || Math.abs(scaled - whole) > Math.max(1e-6, Math.abs(scaled) * 1e-12)) return null;
	return whole;
}
function componentsProblem(components, rate) {
	if (!isObject(components) || Object.keys(components).length !== COMPONENT_KEYS.length || COMPONENT_KEYS.some((k) => !(k in components))) return "A rate breakdown names labour, material, plant and subcontractor (0 where there is none).";
	let sum = 0;
	for (const k of COMPONENT_KEYS) {
		const u = rateUnits(components[k]);
		if (u === null) return `${COMPONENT_LABELS[k]} must be a non-negative rate with at most four decimals.`;
		sum += u;
	}
	const target = rateUnits(rate);
	if (target === null) return "This item’s unit rate has more than four decimals (or is not priced), so it cannot carry a breakdown.";
	if (sum !== target) return `The breakdown adds up to ${(sum / UNITS).toFixed(4)}, not the unit rate of ${(target / UNITS).toFixed(4)}.`;
	return null;
}
function componentCents(amountCents, components) {
	const units = COMPONENT_KEYS.map((k) => rateUnits(components[k]) ?? 0);
	const whole = units.reduce((s, u) => s + u, 0);
	const out = {};
	let part = 0;
	let shared = 0;
	COMPONENT_KEYS.forEach((k, i) => {
		part += units[i];
		const c = whole <= 0 ? 0 : shareStep(amountCents, part, whole, shared);
		out[k] = c;
		shared += c;
	});
	return out;
}
const clip = (v, max) => String(v ?? "").slice(0, max);
const validQuantity = (q) => isNumber(q) && q >= 0;
function pricedItemCents(item) {
	if (!validQuantity(item.quantity) || !isNumber(item.rate) || item.rate < 0) return null;
	if (!isNumber(item.amount) || item.amount < 0) return null;
	const derived = boqLineAmount(item.quantity, item.rate);
	if (derived === null || toCents(derived) !== toCents(item.amount)) return null;
	return toCents(item.amount);
}
function buildEstimateLines({ boqItems = [], itemInputs = null, settings, currencyCode = null }) {
	const inputOf = (id) => (itemInputs instanceof Map ? itemInputs.get(id) : itemInputs?.[id]) ?? null;
	const classOf = new Map(settings.costCodeClasses.map((c) => [c.costCodeId, c.costClass]));
	const active = (boqItems ?? []).filter((i) => i?.id && i.status === BOQ_STATUS.ACTIVE).sort((a, b) => cmp(a.id, b.id));
	const problems = [];
	const note = (kind, item, detail = null) => problems.push({
		kind,
		itemId: item?.id ?? null,
		itemNumber: clip(item?.itemNumber, 40),
		detail
	});
	if (active.length === 0) note(ESTIMATE_PROBLEM.EMPTY, null);
	if (active.length > 5e3) note(ESTIMATE_PROBLEM.TOO_LARGE, null, String(active.length));
	const lines = [];
	const usedCodes = /* @__PURE__ */ new Set();
	for (const item of active) {
		if (typeof item.costCodeId !== "string" || item.costCodeId === "" || item.costCodeId.length > 128) {
			note(ESTIMATE_PROBLEM.INVALID_SOURCE, item);
			continue;
		}
		if (String(item.id).length > 128 || String(item.unit ?? "").length > 40 || item.currency != null && (typeof item.currency !== "string" || item.currency.length > 3)) {
			note(ESTIMATE_PROBLEM.INVALID_SOURCE, item);
			continue;
		}
		if (!isPriced(item.rate)) {
			note(ESTIMATE_PROBLEM.UNPRICED, item);
			continue;
		}
		const amountCents = pricedItemCents(item);
		if (amountCents === null) {
			note(ESTIMATE_PROBLEM.INVALID_SOURCE, item);
			continue;
		}
		if (currencyCode && item.currency !== currencyCode) {
			note(ESTIMATE_PROBLEM.CURRENCY_MISMATCH, item);
			continue;
		}
		const tooLong = [
			["itemNumber", 40],
			["section", 200],
			["description", ESTIMATE_DESCRIPTION_MAX],
			["costCodeName", 200]
		].find(([k, max]) => String(item[k] ?? "").length > max);
		if (tooLong) {
			note(ESTIMATE_PROBLEM.TEXT_TOO_LONG, item, tooLong[0]);
			continue;
		}
		const components = inputOf(item.id)?.components ?? null;
		if (components !== null) {
			const bad = componentsProblem(components, item.rate);
			if (bad) {
				note(ESTIMATE_PROBLEM.COMPONENTS_UNRECONCILED, item, bad);
				continue;
			}
		}
		const line = {
			itemId: item.id,
			itemNumber: String(item.itemNumber ?? ""),
			section: String(item.section ?? ""),
			description: String(item.description ?? ""),
			unit: String(item.unit ?? ""),
			quantity: item.quantity,
			rate: item.rate,
			amountCents,
			currency: item.currency ?? null,
			costCodeId: item.costCodeId,
			costCodeName: String(item.costCodeName ?? ""),
			costClass: classOf.get(item.costCodeId) ?? COST_CLASS.DIRECT,
			components: components === null ? null : Object.fromEntries(COMPONENT_KEYS.map((k) => [k, components[k]]))
		};
		if (lineBytes(line) > LINE_MAX_BYTES) {
			note(ESTIMATE_PROBLEM.INVALID_SOURCE, item);
			continue;
		}
		usedCodes.add(item.costCodeId);
		lines.push(line);
	}
	for (const c of settings.costCodeClasses) if (!usedCodes.has(c.costCodeId) && problems.length === 0) problems.push({
		kind: ESTIMATE_PROBLEM.CLASS_UNUSED,
		itemId: null,
		itemNumber: "",
		detail: c.costCodeId
	});
	const problemCounts = {};
	for (const p of problems) problemCounts[p.kind] = (problemCounts[p.kind] ?? 0) + 1;
	return {
		problems,
		problemCounts,
		lines
	};
}
function describeEstimateProblems({ problems, problemCounts }) {
	if (!problems || problems.length === 0) return null;
	const first = problems[0];
	const label = ESTIMATE_PROBLEM_LABELS[first.kind] ?? "The BOQ cannot be estimated as it stands.";
	const named = problems.filter((p) => p.kind === first.kind && p.itemNumber).slice(0, 5).map((p) => p.itemNumber);
	const count = problemCounts?.[first.kind] ?? 1;
	return `${label}${named.length > 0 ? ` (${count} item${count === 1 ? "" : "s"}: ${named.join(", ")}${count > named.length ? ", …" : ""})` : ""}`;
}
const ESTIMATE_TOTAL_KEYS = [
	"directCents",
	"preliminariesCents",
	"constructionCents",
	"overheadCents",
	"contingencyCents",
	"costTotalCents",
	"sellCents",
	"grossProfitCents",
	"labourCents",
	"materialCents",
	"plantCents",
	"subcontractorCents",
	"unanalysedCents",
	"boqTotalCents"
];
function estimateTotals(lines, settings) {
	const byClass = {
		[COST_CLASS.DIRECT]: 0,
		[COST_CLASS.PRELIMINARIES]: 0,
		[COST_CLASS.OVERHEAD]: 0,
		[COST_CLASS.CONTINGENCY]: 0
	};
	const comp = {
		labour: 0,
		material: 0,
		plant: 0,
		subcontractor: 0
	};
	let unanalysed = 0;
	let boqTotal = 0;
	for (const l of lines) {
		if (!Number.isSafeInteger(l.amountCents) || l.amountCents < 0 || !(l.costClass in byClass)) return { problem: "A line cannot be read as an amount." };
		byClass[l.costClass] += l.amountCents;
		boqTotal += l.amountCents;
		if (l.components) {
			const split = componentCents(l.amountCents, l.components);
			for (const k of COMPONENT_KEYS) comp[k] += split[k];
		} else unanalysed += l.amountCents;
	}
	const constructionCents = byClass.direct + byClass.preliminaries;
	const allowance = (mode, bps, coded) => mode === ALLOWANCE_MODE.COST_CODED ? coded : mode === ALLOWANCE_MODE.PERCENTAGE ? percentOfCents(constructionCents, bps) : 0;
	if (settings.overheadMode !== ALLOWANCE_MODE.COST_CODED && byClass.overhead !== 0) return { problem: "Lines are classified as overhead, but overhead is not cost-coded." };
	if (settings.contingencyMode !== ALLOWANCE_MODE.COST_CODED && byClass.contingency !== 0) return { problem: "Lines are classified as contingency, but contingency is not cost-coded." };
	const overheadCents = allowance(settings.overheadMode, settings.overheadBps, byClass.overhead);
	const contingencyCents = allowance(settings.contingencyMode, settings.contingencyBps, byClass.contingency);
	const costTotalCents = constructionCents + overheadCents + contingencyCents;
	if (costTotalCents > 99999999999999) return {
		problem: ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.OUT_OF_RANGE],
		kind: ESTIMATE_PROBLEM.OUT_OF_RANGE
	};
	const price = sellingPriceCents(costTotalCents, settings.pricingPolicy, settings.pricingBps);
	if (price.problem) return { problem: price.problem };
	if (price.sellCents > 99999999999999) return {
		problem: ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.OUT_OF_RANGE],
		kind: ESTIMATE_PROBLEM.OUT_OF_RANGE
	};
	return { totals: {
		directCents: byClass.direct,
		preliminariesCents: byClass.preliminaries,
		constructionCents,
		overheadCents,
		contingencyCents,
		costTotalCents,
		sellCents: price.sellCents,
		grossProfitCents: price.sellCents - costTotalCents,
		labourCents: comp.labour,
		materialCents: comp.material,
		plantCents: comp.plant,
		subcontractorCents: comp.subcontractor,
		unanalysedCents: unanalysed,
		boqTotalCents: boqTotal
	} };
}
const sameTotals = (a, b) => ESTIMATE_TOTAL_KEYS.every((k) => Number.isSafeInteger(a?.[k]) && a[k] === b?.[k]);
const budgetHandoverCents = (totals) => totals.boqTotalCents;
function estimateByCostCode(lines) {
	const map = /* @__PURE__ */ new Map();
	for (const l of lines ?? []) {
		const e = map.get(l.costCodeId) ?? {
			costCodeId: l.costCodeId,
			costCodeName: l.costCodeName,
			costClass: l.costClass,
			itemCount: 0,
			amountCents: 0
		};
		e.itemCount += 1;
		e.amountCents += l.amountCents;
		map.set(l.costCodeId, e);
	}
	return [...map.values()].sort((a, b) => cmp(a.costCodeName, b.costCodeName));
}
const LINE_KEYS = [
	"itemId",
	"itemNumber",
	"section",
	"description",
	"unit",
	"quantity",
	"rate",
	"amountCents",
	"currency",
	"costCodeId",
	"costCodeName",
	"costClass",
	"components"
];
const canonicalLine = (l) => JSON.stringify(LINE_KEYS.map((k) => k === "components" ? l.components ? COMPONENT_KEYS.map((c) => l.components[c]) : null : l[k] ?? null));
const canonicalHeader = ({ currency, settings, totals, lineCount, sourceKey }) => JSON.stringify([
	1,
	currency ?? null,
	[
		settings.pricingPolicy,
		settings.pricingBps,
		settings.overheadMode,
		settings.overheadBps,
		settings.contingencyMode,
		settings.contingencyBps,
		settings.costCodeClasses.map((c) => [c.costCodeId, c.costClass])
	],
	ESTIMATE_TOTAL_KEYS.map((k) => totals[k]),
	lineCount,
	sourceKey
]);
function storedLineProblem(l) {
	if (!isObject(l) || typeof l.itemId !== "string" || !Number.isSafeInteger(l.amountCents) || l.amountCents < 0) return "A stored line cannot be read.";
	if (!isNumber(l.quantity) || !isNumber(l.rate) || typeof l.costCodeId !== "string" || !Object.values(COST_CLASS).includes(l.costClass)) return "A stored line cannot be read.";
	const derived = boqLineAmount(l.quantity, l.rate);
	if (derived === null || toCents(derived) !== l.amountCents) return `Line ${l.itemNumber || l.itemId} stores an amount that is not its quantity × rate.`;
	if (l.components !== null && l.components !== void 0 && componentsProblem(l.components, l.rate)) return `Line ${l.itemNumber || l.itemId} stores a rate breakdown that does not add up to its unit rate.`;
	return null;
}
const sourceKeyOfLines = (lines) => sourceKeyOfRows((lines ?? []).map((l) => sourceItemKey({
	id: l.itemId,
	quantity: l.quantity,
	rate: l.rate,
	amountCents: l.amountCents,
	unit: l.unit,
	currency: l.currency,
	costCodeId: l.costCodeId
})));
const NODE = 16;
const utf8Bound = (str) => {
	let n = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		n += c < 128 ? 1 : c < 2048 ? 2 : 3;
	}
	return n;
};
function encodedBytesBound(v) {
	if (typeof v === "string") return NODE + utf8Bound(v);
	if (Array.isArray(v)) return v.reduce((s, x) => s + NODE + encodedBytesBound(x), NODE);
	if (isObject(v)) return Object.entries(v).reduce((s, [k, x]) => s + NODE + utf8Bound(k) + encodedBytesBound(x), NODE);
	return NODE;
}
const lineBytes = (line) => NODE + encodedBytesBound(line);
const widest = (n) => "ࠀ".repeat(n);
const LINE_MAX_BYTES = lineBytes({
	itemId: widest(128),
	itemNumber: widest(40),
	section: widest(200),
	description: widest(ESTIMATE_DESCRIPTION_MAX),
	unit: widest(40),
	quantity: 0,
	rate: 0,
	amountCents: 0,
	currency: widest(3),
	costCodeId: widest(128),
	costCodeName: widest(200),
	costClass: COST_CLASS.PRELIMINARIES,
	components: Object.fromEntries(COMPONENT_KEYS.map((k) => [k, 0]))
});
const CHUNK_MAX_LINES = 250;
const CHUNK_MAX_BYTES = 4e5;
const CHUNK_ENVELOPE_BYTES = 2048;
const FIRESTORE_DOCUMENT_MAX_BYTES = 1048576;
const FIRESTORE_REQUEST_MAX_BYTES = 10485760;
function chunkEstimateLines(lines, { maxLines = 250, maxBytes = CHUNK_MAX_BYTES } = {}) {
	const chunks = [];
	let current = [];
	let bytes = 0;
	for (const line of lines) {
		const b = lineBytes(line);
		if (current.length > 0 && (current.length >= maxLines || bytes + b > maxBytes)) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(line);
		bytes += b;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}
const chunkDocId = (index) => String(index).padStart(5, "0");
function estimateDrift(lines, boqItems, storedSourceKey = null) {
	const liveKey = estimateSourceKey(boqItems);
	const stored = storedSourceKey ?? sourceKeyOfLines(lines);
	const live = new Map((boqItems ?? []).filter((i) => i?.id && i.status === BOQ_STATUS.ACTIVE).map((i) => [i.id, i]));
	const kept = new Map((lines ?? []).map((l) => [l.itemId, l]));
	const added = [];
	const removed = [];
	const changed = [];
	for (const [id, item] of live) {
		const line = kept.get(id);
		if (!line) {
			added.push({
				itemId: id,
				itemNumber: item.itemNumber ?? "",
				description: item.description ?? ""
			});
			continue;
		}
		const liveCents = isPriced(item.rate) && isNumber(item.amount) ? toCents(item.amount) : null;
		if (item.quantity !== line.quantity || (isPriced(item.rate) ? item.rate : null) !== line.rate || liveCents !== line.amountCents || String(item.unit ?? "") !== String(line.unit ?? "") || item.costCodeId !== line.costCodeId || (item.currency ?? null) !== (line.currency ?? null)) changed.push({
			itemId: id,
			itemNumber: item.itemNumber ?? line.itemNumber,
			description: line.description,
			fromCents: line.amountCents,
			toCents: liveCents
		});
	}
	for (const [id, line] of kept) if (!live.has(id)) removed.push({
		itemId: id,
		itemNumber: line.itemNumber,
		description: line.description,
		fromCents: line.amountCents
	});
	return {
		matches: liveKey === stored,
		liveKey,
		storedKey: stored,
		added,
		removed,
		changed
	};
}
const buildRequestKey = (estimateId, expectedRevision, settings) => `${ESTIMATE_SOURCE_VERSION}r:${fnvDigest(JSON.stringify([
	estimateId,
	expectedRevision,
	normaliseEstimateSettings(settings)
]))}`;
const formatEstimateNumber = (revisionNumber) => `EST-${String(revisionNumber).padStart(4, "0")}`;
function currentApprovedEstimate(estimates) {
	let best = null;
	for (const e of estimates ?? []) if (e?.state === ESTIMATE_STATE.APPROVED && Number.isSafeInteger(e.revisionNumber) && (!best || e.revisionNumber > best.revisionNumber)) best = e;
	return best;
}
function percentTextToBps(text) {
	const t = String(text ?? "").trim();
	if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
	const [whole, frac = ""] = t.split(".");
	return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
const bpsToPercentText = (bps) => Number.isSafeInteger(bps) ? (bps / 100).toFixed(2).replace(/\.?0+$/, "") : "";
const formatBps = (bps) => bps === null || bps === void 0 ? "—" : `${(bps / 100).toFixed(2)}%`;

//#endregion
export { ALLOWANCE_MODE, ALLOWANCE_MODE_LABELS, ASSIGNABLE_COST_CLASSES, BPS, CHUNK_ENVELOPE_BYTES, CHUNK_MAX_BYTES, CHUNK_MAX_LINES, COMPONENT_KEYS, COMPONENT_LABELS, COST_CLASS, COST_CLASS_LABELS, ESTIMATE_APPROVER_ROLES, ESTIMATE_BADGE_VARIANTS, ESTIMATE_CURRENCY_MAX, ESTIMATE_DESCRIPTION_MAX, ESTIMATE_ID_MAX, ESTIMATE_ITEM_NUMBER_MAX, ESTIMATE_MAX_CLASSES, ESTIMATE_MAX_ITEMS, ESTIMATE_NOTES_MAX, ESTIMATE_PROBLEM, ESTIMATE_PROBLEM_LABELS, ESTIMATE_ROLES, ESTIMATE_SETTINGS_KEYS, ESTIMATE_STATE, ESTIMATE_STATE_LABELS, ESTIMATE_TEXT_MAX, ESTIMATE_TITLE_MAX, ESTIMATE_TOTAL_KEYS, ESTIMATE_UNIT_MAX, ESTIMATING_VERSION, FIRESTORE_DOCUMENT_MAX_BYTES, FIRESTORE_REQUEST_MAX_BYTES, LINE_MAX_BYTES, MAX_ALLOWANCE_BPS, MAX_MARGIN_BPS, MAX_MARKUP_BPS, MAX_SUPPORTED_AMOUNT_CENTS, PRICING_POLICY, PRICING_POLICY_LABELS, PROBLEM_SAMPLE, SET_COMPONENTS_MAX_ITEMS, achievedBps, bpsToPercentText, budgetHandoverCents, buildEstimateLines, buildRequestKey, canApproveEstimate, canPrepareEstimate, canonicalHeader, canonicalLine, centsToAmount, chunkDocId, chunkEstimateLines, componentCents, componentsProblem, currentApprovedEstimate, defaultEstimateSettings, describeEstimateProblems, encodedBytesBound, estimateByCostCode, estimateDrift, estimateSettingsProblem, estimateSourceKey, estimateTotals, formatBps, formatEstimateNumber, isEstimateSourceKeyShape, lineBytes, normaliseEstimateSettings, percentOfCents, percentTextToBps, rateUnits, resolveProjectCurrency, sameTotals, sellingPriceCents, sourceKeyOfLines, storedLineProblem };