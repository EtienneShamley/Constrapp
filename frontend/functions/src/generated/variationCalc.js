// GENERATED FILE — DO NOT EDIT. Source: frontend/src/lib/variationCalc.js and the
// modules it imports. Regenerate with `npm run functions:variation-calc` (from frontend/).
// ADR-90: the trusted variation callables run this exact domain logic.
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
//#region src/lib/money.js
const MAX_SUPPORTED_AMOUNT_CENTS = 99999999999999;
function toCents(amount) {
	const n = typeof amount === "number" ? amount : Number(amount);
	return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const fromCents = (cents) => cents / 100;
function gstOfCents(cents) {
	return cents < 0 ? 0 - Math.floor((-cents + 5) / 10) : Math.floor((cents + 5) / 10);
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
function roundAmount(amount, version = CALC_VERSION.LEGACY) {
	assertVersion(version);
	const n = Number(amount) || 0;
	if (version === CALC_VERSION.LEGACY) return roundMoney(n);
	const cents = roundToCents(n);
	return cents === null ? null : fromCents(cents);
}
function gstOnAmount(amount, version = CALC_VERSION.LEGACY) {
	assertVersion(version);
	const n = Number(amount) || 0;
	if (version === CALC_VERSION.LEGACY) return roundMoney(n * GST_RATE);
	const cents = roundToCents(n);
	return cents === null ? null : fromCents(gstOfCents(cents));
}
function sumAmounts(amounts, version = CALC_VERSION.LEGACY) {
	assertVersion(version);
	if (version === CALC_VERSION.LEGACY) return roundMoney((amounts ?? []).reduce((sum, a) => sum + (Number(a) || 0), 0));
	return fromCents((amounts ?? []).reduce((sum, a) => sum + toCents(Number(a) || 0), 0));
}
const isSupportedAmount = (amount) => typeof amount === "number" && Number.isFinite(amount) && Math.abs(toCents(amount)) <= 99999999999999 && fromCents(toCents(amount)) === amount;

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
const formatClientVariationNumber = (n) => `CV-${String(n).padStart(4, "0")}`;
const formatSupplierVariationNumber = (n) => `SV-${String(n).padStart(4, "0")}`;
const VARIATION_COUNTER_ID = {
	[VARIATION_TYPE.CLIENT]: "variationsClient",
	[VARIATION_TYPE.SUPPLIER]: "variationsSupplier"
};
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
function gstForLine(amount, taxCode, version = CALC_VERSION.LEGACY) {
	const amt = Number(amount) || 0;
	return taxCode === TAX_CODE.GST ? gstOnAmount(amt, version) : 0;
}
const variationCalcVersion = (variation) => calcVersionOf(variation);
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
function variationTotals(lineItems, side = "submitted", version = CALC_VERSION.LEGACY) {
	const amountKey = side === "approved" ? "approvedAmount" : "submittedAmount";
	const gstKey = side === "approved" ? "approvedGst" : "submittedGst";
	if (version === CALC_VERSION.LEGACY) {
		const subtotal = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li[amountKey]) || 0), 0));
		const gst = roundMoney((lineItems ?? []).reduce((sum, li) => sum + (Number(li[gstKey]) || 0), 0));
		return {
			subtotal,
			gst,
			total: roundMoney(subtotal + gst)
		};
	}
	const subtotal = sumAmounts((lineItems ?? []).map((li) => li[amountKey]), version);
	const gst = sumAmounts((lineItems ?? []).map((li) => li[gstKey]), version);
	return {
		subtotal,
		gst,
		total: sumAmounts([subtotal, gst], version)
	};
}
function approvalNeedsNotes(lineItems, approvedAmounts, version = CALC_VERSION.LEGACY) {
	return (lineItems ?? []).some((li, idx) => {
		return roundAmount(Number(approvedAmounts?.[idx]) || 0, version) !== roundAmount(Number(li.submittedAmount) || 0, version);
	});
}
function validateApprovedAmounts(lineItems, approvedAmounts, assessmentNotes, version = CALC_VERSION.LEGACY) {
	const lines = lineItems ?? [];
	if (!Array.isArray(approvedAmounts) || approvedAmounts.length !== lines.length) return "Approval requires an amount for every variation line";
	for (let i = 0; i < lines.length; i++) {
		const raw = approvedAmounts[i] === "" || approvedAmounts[i] == null ? 0 : Number(approvedAmounts[i]);
		if (!Number.isFinite(raw)) return `Line ${i + 1}: amount must be a number`;
	}
	if (approvalNeedsNotes(lines, approvedAmounts, version) && !(assessmentNotes || "").trim()) return "Assessment notes are required when approved amounts differ from submitted amounts";
	return null;
}
function buildApprovedLineItems(lineItems, approvedAmounts, version = CALC_VERSION.LEGACY) {
	return (lineItems ?? []).map((li, idx) => {
		const amount = roundAmount(Number(approvedAmounts?.[idx]) || 0, version);
		return {
			...li,
			approvedAmount: amount,
			approvedGst: gstForLine(amount, li.taxCode, version)
		};
	});
}
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
const isEligibleOriginRfi = (rfi) => !!rfi && typeof rfi === "object" && ORIGIN_RFI_STATUSES.includes(rfi.status);
function normaliseOriginRfi(rfi) {
	if (!rfi || typeof rfi !== "object") return { ...UNLINKED_ORIGIN_RFI };
	const { id, rfiNumber, title } = rfi;
	const usable = (v) => typeof v === "string" && v.length > 0;
	if (!usable(id) || !usable(rfiNumber) || !usable(title)) return { ...UNLINKED_ORIGIN_RFI };
	return {
		originRfiId: id,
		originRfiNumber: rfiNumber,
		originRfiTitle: title
	};
}
const EMPTY_VARIATION_FORM_LINE = Object.freeze({
	poLineIndex: "",
	costCodeId: "",
	description: "",
	submittedAmount: "",
	taxCode: TAX_CODE.GST
});
function buildVariationLineItem(formLine, { po = null, costCodes = [], calcVersion = CALC_VERSION.LEGACY } = {}) {
	const l = formLine && typeof formLine === "object" ? formLine : {};
	const poLine = po && l.poLineIndex !== "" && l.poLineIndex != null ? (po.lineItems ?? [])[Number(l.poLineIndex)] ?? null : null;
	let costCodeId, costCodeName;
	if (poLine) {
		costCodeId = poLine.costCodeId || "";
		costCodeName = poLine.costCodeName || "";
	} else {
		costCodeId = typeof l.costCodeId === "string" ? l.costCodeId : "";
		const cc = (costCodes ?? []).find((c) => c.id === costCodeId);
		costCodeName = cc ? `${cc.code} — ${cc.name}` : "";
	}
	const amount = Number(l.submittedAmount) || 0;
	const taxCode = TAX_CODES.includes(l.taxCode) ? l.taxCode : TAX_CODE.GST;
	return {
		costCodeId,
		costCodeName,
		description: String(l.description ?? "").trim(),
		submittedAmount: roundAmount(amount, calcVersion),
		submittedGst: gstForLine(amount, taxCode, calcVersion),
		approvedAmount: null,
		approvedGst: null,
		poLineIndex: poLine ? Number(l.poLineIndex) : null,
		taxCode
	};
}
const isPoLinkedSupplierVariation = (v) => v?.variationType === VARIATION_TYPE.SUPPLIER && typeof v.poId === "string" && v.poId.length > 0;
const isCommitmentApplied = (v) => v?.commitmentAppliedAt != null && typeof v.commitmentAppliedBy === "string" && v.commitmentAppliedBy.length > 0;
const isScopeCommitted = (v) => v?.scopeCommittedAt != null && typeof v.scopeCommittedBy === "string" && v.scopeCommittedBy.length > 0;
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
function commitmentApplyEligibility(variation, purchaseOrders) {
	const po = (purchaseOrders ?? []).find((p) => p?.id === variation?.poId) ?? null;
	const none = {
		applied: false,
		scope: false
	};
	const refuse = (blocker) => ({
		eligible: false,
		blocker,
		message: COMMITMENT_APPLY_BLOCKER_MESSAGES[blocker],
		po,
		missing: none
	});
	if (variation?.variationType !== VARIATION_TYPE.SUPPLIER) return refuse(COMMITMENT_APPLY_BLOCKER.NOT_SUPPLIER);
	if (!isPoLinkedSupplierVariation(variation)) return refuse(COMMITMENT_APPLY_BLOCKER.MANUAL_MODE);
	if (!VARIATION_APPROVED_STATUSES.includes(variation.status)) return refuse(COMMITMENT_APPLY_BLOCKER.NOT_APPROVED);
	const applied = isCommitmentApplied(variation);
	const scope = isScopeCommitted(variation);
	if (applied && scope) return refuse(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED);
	if (applied && !scope) {
		if (!(variation.lineItems ?? []).some((li) => li?.poLineIndex == null && Number(li?.approvedAmount) > 0)) return refuse(COMMITMENT_APPLY_BLOCKER.ALREADY_APPLIED);
	}
	if (!po) return refuse(COMMITMENT_APPLY_BLOCKER.PO_MISSING);
	if (!COMMITMENT_PO_STATUSES.includes(po.status)) return refuse(COMMITMENT_APPLY_BLOCKER.PO_NOT_COMMITTED);
	return {
		eligible: true,
		blocker: null,
		message: null,
		po,
		missing: {
			applied: !applied,
			scope: !scope
		}
	};
}
const shouldApplyOnApproval = (variation, po) => isPoLinkedSupplierVariation(variation) && !!po && COMMITMENT_PO_STATUSES.includes(po.status);

//#endregion
//#region src/lib/variationProcessing.js
const VARIATION_PROCESSING_ROLES = [
	"company_admin",
	"project_manager",
	"qs"
];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isId = (v) => typeof v === "string" && ID_RE.test(v);
const isIdOrNull = (v) => v === null || isId(v);
const isDate = (v) => typeof v === "string" && (v === "" || DATE_RE.test(v));
const isText = (v, max) => typeof v === "string" && v.length <= max;
const REASONS = ["", ...Object.values(VARIATION_REASON)];
const VARIATION_LIMITS = Object.freeze({
	title: 500,
	description: 5e3,
	notes: 5e3,
	name: 200,
	reference: 200,
	lineDescription: 2e3,
	lines: 200
});
const CREATE_VARIATION_KEYS = [
	"projectId",
	"variationId",
	"variationType",
	"title",
	"description",
	"reason",
	"clientId",
	"clientName",
	"clientRef",
	"supplierId",
	"supplierName",
	"supplierRef",
	"poId",
	"originRfiId",
	"identifiedDate",
	"submittedDate",
	"responseDueDate",
	"effectiveDate",
	"notes",
	"lines"
];
const CREATE_VARIATION_LINE_KEYS = [
	"poLineIndex",
	"costCodeId",
	"description",
	"submittedAmount",
	"taxCode"
];
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((k) => k in value);
function createVariationRequestProblem(data) {
	if (!exactKeys(data, CREATE_VARIATION_KEYS)) return "keys";
	if (!isId(data.projectId) || !isId(data.variationId)) return "ids";
	if (data.variationType !== VARIATION_TYPE.CLIENT && data.variationType !== VARIATION_TYPE.SUPPLIER) return "type";
	if (!isText(data.title, VARIATION_LIMITS.title) || data.title.trim().length === 0 || data.title !== data.title.trim()) return "title";
	if (!isText(data.description, VARIATION_LIMITS.description)) return "description";
	if (!REASONS.includes(data.reason)) return "reason";
	for (const key of [
		"identifiedDate",
		"submittedDate",
		"responseDueDate",
		"effectiveDate"
	]) if (!isDate(data[key])) return key;
	if (!isText(data.notes, VARIATION_LIMITS.notes)) return "notes";
	if (!isIdOrNull(data.originRfiId)) return "originRfiId";
	if (data.variationType === VARIATION_TYPE.CLIENT) {
		if (!isIdOrNull(data.clientId) || !isText(data.clientName, VARIATION_LIMITS.name) || !isText(data.clientRef, VARIATION_LIMITS.reference)) return "client";
		if (data.supplierId !== null || data.supplierName !== null || data.supplierRef !== null || data.poId !== null) return "client-only";
	} else {
		if (data.clientId !== null || data.clientName !== null || data.clientRef !== null) return "supplier-only";
		if (!isText(data.supplierRef, VARIATION_LIMITS.reference)) return "supplierRef";
		if (data.poId === null) {
			if (!isIdOrNull(data.supplierId) || !isText(data.supplierName, VARIATION_LIMITS.name)) return "supplier";
		} else if (!isId(data.poId) || data.supplierId !== null || data.supplierName !== null) return "po-link";
	}
	if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > VARIATION_LIMITS.lines) return "lines";
	for (const line of data.lines) {
		if (!exactKeys(line, CREATE_VARIATION_LINE_KEYS)) return "line-keys";
		if (!isText(line.description, VARIATION_LIMITS.lineDescription)) return "line-description";
		if (!TAX_CODES.includes(line.taxCode)) return "line-tax-code";
		if (typeof line.submittedAmount !== "number" || roundToCents(line.submittedAmount) === null) return "line-amount";
		if (line.poLineIndex === null) {
			if (!isId(line.costCodeId)) return "line-cost-code";
		} else if (!Number.isInteger(line.poLineIndex) || line.poLineIndex < 0 || line.costCodeId !== null || data.poId === null) return "line-po-index";
	}
	return null;
}
const requestedCostCodeIds = (input) => [...new Set((input?.lines ?? []).filter((l) => l.poLineIndex === null).map((l) => l.costCodeId))];
const CREATE_PROBLEM = Object.freeze({
	PO_INVALID: "po_invalid",
	PO_LINE_INVALID: "po_line_invalid",
	COST_CODE_INVALID: "cost_code_invalid",
	RFI_INVALID: "rfi_invalid",
	OUT_OF_RANGE: "out_of_range"
});
function buildVariationDraft({ input, number, currency, po = null, costCodes = /* @__PURE__ */ new Map(), rfi = null, uid, now }) {
	const refuse = (problem, detail = {}) => ({
		ok: false,
		problem,
		detail
	});
	const isClient = input.variationType === VARIATION_TYPE.CLIENT;
	const linked = input.poId !== null;
	if (linked) {
		if (!po || po.id !== input.poId || !VARIATION_PO_STATUSES.includes(po.status)) return refuse(CREATE_PROBLEM.PO_INVALID, {
			poId: input.poId,
			status: po?.status ?? null
		});
		if (typeof po.poNumber !== "string" || !isText(po.supplierName, VARIATION_LIMITS.name)) return refuse(CREATE_PROBLEM.PO_INVALID, { poId: input.poId });
	}
	const library = [...costCodes.entries()].map(([id, cc]) => ({
		id,
		code: cc?.code,
		name: cc?.name
	}));
	const lineItems = [];
	for (let index = 0; index < input.lines.length; index += 1) {
		const line = input.lines[index];
		if (line.poLineIndex !== null) {
			const poLine = (po?.lineItems ?? [])[line.poLineIndex];
			if (!poLine || typeof poLine.costCodeId !== "string" || poLine.costCodeId.length === 0) return refuse(CREATE_PROBLEM.PO_LINE_INVALID, {
				line: index,
				poLineIndex: line.poLineIndex
			});
		} else if (!costCodes.has(line.costCodeId)) return refuse(CREATE_PROBLEM.COST_CODE_INVALID, {
			line: index,
			costCodeId: line.costCodeId
		});
		const built = buildVariationLineItem({
			...line,
			poLineIndex: line.poLineIndex === null ? "" : line.poLineIndex
		}, {
			po: linked ? po : null,
			costCodes: library,
			calcVersion: CURRENT_CALC_VERSION
		});
		if (built.submittedAmount === null || built.submittedGst === null) return refuse(CREATE_PROBLEM.OUT_OF_RANGE, { line: index });
		lineItems.push(built);
	}
	let origin = normaliseOriginRfi(null);
	if (input.originRfiId !== null) {
		if (!rfi || rfi.id !== input.originRfiId || !isEligibleOriginRfi(rfi)) return refuse(CREATE_PROBLEM.RFI_INVALID, {
			rfiId: input.originRfiId,
			status: rfi?.status ?? null
		});
		origin = normaliseOriginRfi(rfi);
		if (origin.originRfiId === null) return refuse(CREATE_PROBLEM.RFI_INVALID, { rfiId: input.originRfiId });
	}
	const submitted = variationTotals(lineItems, "submitted", CURRENT_CALC_VERSION);
	if (!isSupportedAmount(submitted.subtotal) || !isSupportedAmount(submitted.gst) || !isSupportedAmount(submitted.total)) return refuse(CREATE_PROBLEM.OUT_OF_RANGE);
	return {
		ok: true,
		document: {
			variationNumber: isClient ? formatClientVariationNumber(number) : formatSupplierVariationNumber(number),
			variationType: input.variationType,
			status: VARIATION_STATUS.DRAFT,
			title: input.title,
			description: input.description,
			reason: input.reason,
			clientId: isClient ? input.clientId : null,
			clientName: isClient ? input.clientName : null,
			clientRef: isClient ? input.clientRef : null,
			supplierId: isClient ? null : linked ? po.supplierId ?? null : input.supplierId,
			supplierName: isClient ? null : linked ? po.supplierName : input.supplierName,
			supplierRef: isClient ? null : input.supplierRef,
			poId: linked ? po.id : null,
			poNumber: linked ? po.poNumber : null,
			...origin,
			lineItems,
			submittedSubtotal: submitted.subtotal,
			submittedGst: submitted.gst,
			submittedTotal: submitted.total,
			approvedSubtotal: null,
			approvedGst: null,
			approvedTotal: null,
			forecastAmount: null,
			identifiedDate: input.identifiedDate,
			submittedDate: input.submittedDate,
			responseDueDate: input.responseDueDate,
			approvedDate: "",
			effectiveDate: input.effectiveDate,
			currency,
			calcVersion: CURRENT_CALC_VERSION,
			revision: 1,
			notes: input.notes,
			assessmentNotes: "",
			submittedAt: null,
			submittedBy: null,
			approvedAt: null,
			approvedBy: null,
			rejectedAt: null,
			rejectedBy: null,
			withdrawnAt: null,
			withdrawnBy: null,
			attachments: [],
			externalRefs: {},
			supersededByVariationId: null,
			createdAt: now,
			createdBy: uid,
			updatedAt: now,
			updatedBy: uid
		}
	};
}
const UPDATE_VARIATION_KEYS = [
	"projectId",
	"variationId",
	"expectedRevision",
	"title",
	"description",
	"reason",
	"clientRef",
	"supplierRef",
	"identifiedDate",
	"responseDueDate",
	"effectiveDate",
	"notes",
	"changeOriginRfi",
	"originRfiId",
	"lines"
];
function updateVariationRequestProblem(data) {
	if (!exactKeys(data, UPDATE_VARIATION_KEYS)) return "keys";
	if (!isId(data.projectId) || !isId(data.variationId)) return "ids";
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0) return "expectedRevision";
	if (!isText(data.title, VARIATION_LIMITS.title) || data.title.trim().length === 0 || data.title !== data.title.trim()) return "title";
	if (!isText(data.description, VARIATION_LIMITS.description)) return "description";
	if (!REASONS.includes(data.reason)) return "reason";
	for (const key of [
		"identifiedDate",
		"responseDueDate",
		"effectiveDate"
	]) if (!isDate(data[key])) return key;
	if (!(data.notes === null || isText(data.notes, VARIATION_LIMITS.notes))) return "notes";
	if (!(data.clientRef === null || isText(data.clientRef, VARIATION_LIMITS.reference))) return "clientRef";
	if (!(data.supplierRef === null || isText(data.supplierRef, VARIATION_LIMITS.reference))) return "supplierRef";
	if (data.clientRef === null === (data.supplierRef === null)) return "refs";
	if (typeof data.changeOriginRfi !== "boolean") return "changeOriginRfi";
	if (!isIdOrNull(data.originRfiId) || !data.changeOriginRfi && data.originRfiId !== null) return "originRfiId";
	if (!Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > VARIATION_LIMITS.lines) return "lines";
	for (const line of data.lines) {
		if (!exactKeys(line, CREATE_VARIATION_LINE_KEYS)) return "line-keys";
		if (!isText(line.description, VARIATION_LIMITS.lineDescription)) return "line-description";
		if (!TAX_CODES.includes(line.taxCode)) return "line-tax-code";
		if (typeof line.submittedAmount !== "number" || roundToCents(line.submittedAmount) === null) return "line-amount";
		if (line.poLineIndex === null) {
			if (!isId(line.costCodeId)) return "line-cost-code";
		} else if (!Number.isInteger(line.poLineIndex) || line.poLineIndex < 0 || line.costCodeId !== null) return "line-po-index";
	}
	return null;
}
const DRAFT_PROBLEM = Object.freeze({
	...CREATE_PROBLEM,
	REFS_INVALID: "refs_invalid"
});
function buildVariationDraftUpdate({ input, live, po = null, costCodes = /* @__PURE__ */ new Map(), rfi = null, uid, now }) {
	const refuse = (problem, detail = {}) => ({
		ok: false,
		problem,
		detail
	});
	const isClient = live?.variationType === VARIATION_TYPE.CLIENT;
	if (isClient ? input.clientRef === null || input.supplierRef !== null : input.supplierRef === null || input.clientRef !== null) return refuse(DRAFT_PROBLEM.REFS_INVALID);
	const linked = isPoLinkedSupplierVariation(live);
	const library = [...costCodes.entries()].map(([id, cc]) => ({
		id,
		code: cc?.code,
		name: cc?.name
	}));
	const lineItems = [];
	for (let index = 0; index < input.lines.length; index += 1) {
		const line = input.lines[index];
		if (line.poLineIndex !== null) {
			if (!linked || !po || po.id !== live.poId) return refuse(DRAFT_PROBLEM.PO_LINE_INVALID, {
				line: index,
				poLineIndex: line.poLineIndex
			});
			const poLine = (po.lineItems ?? [])[line.poLineIndex];
			if (!poLine || typeof poLine.costCodeId !== "string" || poLine.costCodeId.length === 0) return refuse(DRAFT_PROBLEM.PO_LINE_INVALID, {
				line: index,
				poLineIndex: line.poLineIndex
			});
		} else if (!costCodes.has(line.costCodeId)) return refuse(DRAFT_PROBLEM.COST_CODE_INVALID, {
			line: index,
			costCodeId: line.costCodeId
		});
		const built = buildVariationLineItem({
			...line,
			poLineIndex: line.poLineIndex === null ? "" : line.poLineIndex
		}, {
			po: linked ? po : null,
			costCodes: library,
			calcVersion: CURRENT_CALC_VERSION
		});
		if (built.submittedAmount === null || built.submittedGst === null) return refuse(DRAFT_PROBLEM.OUT_OF_RANGE, { line: index });
		lineItems.push(built);
	}
	let origin = {};
	if (input.changeOriginRfi) if (input.originRfiId === null) origin = normaliseOriginRfi(null);
	else {
		if (!rfi || rfi.id !== input.originRfiId || !isEligibleOriginRfi(rfi)) return refuse(DRAFT_PROBLEM.RFI_INVALID, {
			rfiId: input.originRfiId,
			status: rfi?.status ?? null
		});
		origin = normaliseOriginRfi(rfi);
		if (origin.originRfiId === null) return refuse(DRAFT_PROBLEM.RFI_INVALID, { rfiId: input.originRfiId });
	}
	const submitted = variationTotals(lineItems, "submitted", CURRENT_CALC_VERSION);
	if (!isSupportedAmount(submitted.subtotal) || !isSupportedAmount(submitted.gst) || !isSupportedAmount(submitted.total)) return refuse(DRAFT_PROBLEM.OUT_OF_RANGE);
	const revision = Number.isFinite(Number(live?.revision)) ? Number(live.revision) : 0;
	return {
		ok: true,
		update: {
			...origin,
			title: input.title,
			description: input.description,
			reason: input.reason,
			clientRef: isClient ? input.clientRef : null,
			supplierRef: isClient ? null : input.supplierRef,
			identifiedDate: input.identifiedDate,
			responseDueDate: input.responseDueDate,
			effectiveDate: input.effectiveDate,
			lineItems,
			submittedSubtotal: submitted.subtotal,
			submittedGst: submitted.gst,
			submittedTotal: submitted.total,
			...input.notes === null ? {} : { notes: input.notes },
			calcVersion: CURRENT_CALC_VERSION,
			revision: revision + 1,
			updatedAt: now,
			updatedBy: uid
		}
	};
}
function draftAlreadyHolds(live, update) {
	const skip = new Set([
		"revision",
		"updatedAt",
		"updatedBy"
	]);
	return Object.keys(update).filter((k) => !skip.has(k)).every((k) => JSON.stringify(live?.[k] ?? null) === JSON.stringify(update[k] ?? null));
}
const APPROVABLE_STATUSES = [VARIATION_STATUS.SUBMITTED, VARIATION_STATUS.UNDER_REVIEW];
const ASSESSMENT_NOTES_MAX = 5e3;
function approvedAmountsProblem(approvedAmounts) {
	if (!Array.isArray(approvedAmounts) || approvedAmounts.length < 1 || approvedAmounts.length > VARIATION_LIMITS.lines) return "count";
	for (const a of approvedAmounts) if (typeof a !== "number" || roundToCents(a) === null) return "amount";
	return null;
}
const VARIATION_LINE_KEYS = [
	"costCodeId",
	"costCodeName",
	"description",
	"submittedAmount",
	"submittedGst",
	"approvedAmount",
	"approvedGst",
	"poLineIndex",
	"taxCode"
];
function legacyLineGstCents(amount) {
	const out = /* @__PURE__ */ new Set();
	for (const entered of [
		amount,
		amount - .0049,
		amount + .0049
	]) out.add(toCents(gstOnAmount(entered, CALC_VERSION.LEGACY)));
	return out;
}
function lineGstReconciles(amount, taxCode, gst, version, { exact = false } = {}) {
	if (typeof gst !== "number" || !Number.isFinite(gst)) return false;
	const derived = gstForLine(amount, taxCode, version);
	if (derived === null) return false;
	if (toCents(gst) === toCents(derived)) return true;
	if (exact || version !== CALC_VERSION.LEGACY || taxCode !== "gst") return false;
	return legacyLineGstCents(amount).has(toCents(gst));
}
function lineShapeProblem(li) {
	if (li === null || typeof li !== "object" || Array.isArray(li)) return "line";
	if (Object.keys(li).length !== VARIATION_LINE_KEYS.length || !VARIATION_LINE_KEYS.every((k) => k in li)) return "line-keys";
	if (!TAX_CODES.includes(li.taxCode)) return "line-tax-code";
	if (typeof li.costCodeId !== "string" || li.costCodeId.length === 0) return "line-cost-code";
	if (typeof li.costCodeName !== "string" || typeof li.description !== "string") return "line-text";
	if (!(li.poLineIndex === null || Number.isInteger(li.poLineIndex) && li.poLineIndex >= 0)) return "line-po-index";
	return null;
}
function submittedSideProblem(variation) {
	const version = variationCalcVersion(variation);
	if (version === null) return "version";
	const lines = variation?.lineItems;
	if (!Array.isArray(lines) || lines.length < 1 || lines.length > VARIATION_LIMITS.lines) return "lines";
	for (const li of lines) {
		const shape = lineShapeProblem(li);
		if (shape) return shape;
		if (!isSupportedAmount(li.submittedAmount)) return "line-amount";
		if (!lineGstReconciles(li.submittedAmount, li.taxCode, li.submittedGst, version)) return "line-gst";
		if (li.approvedAmount != null || li.approvedGst != null) return "line-approved";
	}
	const totals = variationTotals(lines, "submitted", version);
	if (typeof variation.submittedSubtotal !== "number" || typeof variation.submittedGst !== "number" || typeof variation.submittedTotal !== "number" || toCents(variation.submittedSubtotal) !== toCents(totals.subtotal) || toCents(variation.submittedGst) !== toCents(totals.gst) || toCents(variation.submittedTotal) !== toCents(totals.total)) return "header";
	return null;
}
function approvedSideProblem(variation) {
	const version = variationCalcVersion(variation);
	if (version === null) return "version";
	const lines = variation?.lineItems;
	if (!Array.isArray(lines) || lines.length < 1 || lines.length > VARIATION_LIMITS.lines) return "lines";
	for (const li of lines) {
		const shape = lineShapeProblem(li);
		if (shape) return shape;
		if (!isSupportedAmount(li.approvedAmount)) return "line-amount";
		if (!lineGstReconciles(li.approvedAmount, li.taxCode, li.approvedGst, version, { exact: true })) return "line-gst";
	}
	const totals = variationTotals(lines, "approved", version);
	if (typeof variation.approvedSubtotal !== "number" || typeof variation.approvedGst !== "number" || typeof variation.approvedTotal !== "number" || toCents(variation.approvedSubtotal) !== toCents(totals.subtotal) || toCents(variation.approvedGst) !== toCents(totals.gst) || toCents(variation.approvedTotal) !== toCents(totals.total)) return "header";
	return null;
}
const storedCostCodeIds = (variation) => [...new Set((variation?.lineItems ?? []).filter((li) => li && li.poLineIndex == null && typeof li.costCodeId === "string" && li.costCodeId.length > 0).map((li) => li.costCodeId))];
function lineSources(variation, { po = null, costCodes = /* @__PURE__ */ new Map() } = {}) {
	const linked = isPoLinkedSupplierVariation(variation);
	const names = [];
	const lines = variation?.lineItems ?? [];
	for (let index = 0; index < lines.length; index += 1) {
		const li = lines[index];
		if (li?.poLineIndex != null) {
			if (!linked || !po || po.id !== variation.poId) return {
				ok: false,
				line: index,
				reason: "po-line-without-order"
			};
			const poLine = (po.lineItems ?? [])[li.poLineIndex];
			if (!poLine || typeof poLine.costCodeId !== "string" || poLine.costCodeId.length === 0) return {
				ok: false,
				line: index,
				reason: "po-line-missing"
			};
			if (poLine.costCodeId !== li.costCodeId) return {
				ok: false,
				line: index,
				reason: "po-line-cost-code"
			};
			names.push(typeof poLine.costCodeName === "string" ? poLine.costCodeName : "");
		} else {
			const cc = costCodes.get(li?.costCodeId);
			if (!cc) return {
				ok: false,
				line: index,
				reason: "cost-code-missing"
			};
			names.push(`${cc.code} — ${cc.name}`);
		}
	}
	return {
		ok: true,
		names
	};
}
const withAuthoritativeNames = (lineItems, names) => (lineItems ?? []).map((li, i) => ({
	...li,
	costCodeName: names[i]
}));
function sameApproval(variation, approvedAmounts) {
	const version = variationCalcVersion(variation);
	const lines = variation?.lineItems;
	if (version === null || !Array.isArray(lines) || !Array.isArray(approvedAmounts) || lines.length !== approvedAmounts.length) return false;
	return lines.every((li, i) => {
		const wanted = roundAmount(approvedAmounts[i], version);
		return wanted !== null && typeof li?.approvedAmount === "number" && toCents(li.approvedAmount) === toCents(wanted);
	});
}
const approvedHeaderSupported = (update) => isSupportedAmount(update?.approvedSubtotal) && isSupportedAmount(update?.approvedGst) && isSupportedAmount(update?.approvedTotal);
function approvalActorEvidence(variation, uid) {
	return {
		approverIsCreator: variation?.createdBy === uid,
		approverIsSubmitter: variation?.submittedBy === uid,
		approverIsLastEditor: variation?.updatedBy === uid
	};
}

//#endregion
//#region src/lib/variationActions.js
const VARIATION_WRITE_ERROR = {
	STALE: "stale",
	MISSING: "missing",
	INVALID: "invalid",
	ALREADY_APPLIED: "already_applied",
	PO_INVALID: "po_invalid",
	PERMISSION: "permission",
	OFFLINE: "offline",
	UNAVAILABLE: "unavailable",
	UNCERTAIN: "uncertain",
	UNKNOWN: "unknown"
};
const VARIATION_WRITE_ERROR_MESSAGES = {
	[VARIATION_WRITE_ERROR.STALE]: "This variation changed since you loaded it. Review the latest version and retry — your entries are kept.",
	[VARIATION_WRITE_ERROR.MISSING]: "This variation no longer exists.",
	[VARIATION_WRITE_ERROR.INVALID]: "This change is not valid for the variation as it stands.",
	[VARIATION_WRITE_ERROR.ALREADY_APPLIED]: "This variation has already been applied to its purchase order commitment. Nothing was changed.",
	[VARIATION_WRITE_ERROR.PO_INVALID]: "The linked purchase order is missing or is not sent or closed, so this variation cannot be approved. Withdraw or reject it, or raise it again against a current purchase order.",
	[VARIATION_WRITE_ERROR.PERMISSION]: "You do not have permission to change variations on this project.",
	[VARIATION_WRITE_ERROR.OFFLINE]: "Could not reach the server. Check your connection and try again — nothing was saved.",
	[VARIATION_WRITE_ERROR.UNAVAILABLE]: "This action is temporarily unavailable on the server. Nothing was saved.",
	[VARIATION_WRITE_ERROR.UNCERTAIN]: "The server did not confirm this change, so it may or may not have been saved. Check the variation register before trying again — repeating the same action is safe.",
	[VARIATION_WRITE_ERROR.UNKNOWN]: "The change did not complete. Nothing was saved — try again."
};
var VariationWriteError = class extends Error {
	constructor(kind, message, cause) {
		super(message ?? VARIATION_WRITE_ERROR_MESSAGES[kind] ?? VARIATION_WRITE_ERROR_MESSAGES[VARIATION_WRITE_ERROR.UNKNOWN]);
		this.name = "VariationWriteError";
		this.kind = kind;
		if (cause) this.cause = cause;
	}
};
const label = (status) => VARIATION_STATUS_LABELS[status] ?? String(status ?? "unknown");
const pad2 = (n) => String(n).padStart(2, "0");
function todayIso(d = /* @__PURE__ */ new Date()) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const storedRevision = (variation) => {
	const n = Number(variation?.revision);
	return Number.isFinite(n) ? n : 0;
};
const nextRevision = (variation) => storedRevision(variation) + 1;
const commitmentStamps = (uid, now) => ({
	commitmentAppliedAt: now,
	commitmentAppliedBy: uid
});
const scopeStamps = (uid, now) => ({
	scopeCommittedAt: now,
	scopeCommittedBy: uid
});
function transitionUpdate(live, nextStatus, { approvedAmounts, assessmentNotes, applyCommitment = false } = {}, uid, now, today = todayIso()) {
	const stamps = VARIATION_TRANSITION_STAMPS[nextStatus];
	if (!stamps) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, `A move to ${label(nextStatus)} is reserved and has no application path yet.`);
	const base = {
		status: nextStatus,
		[stamps.at]: now,
		[stamps.by]: uid,
		revision: nextRevision(live),
		updatedAt: now,
		updatedBy: uid
	};
	if (nextStatus === VARIATION_STATUS.SUBMITTED) return {
		...base,
		submittedDate: live?.submittedDate || today
	};
	if (nextStatus === VARIATION_STATUS.APPROVED) {
		const version = variationCalcVersion(live);
		if (version === null) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, "This variation records a calculation version this version of Constrap does not know.");
		const validationError = validateApprovedAmounts(live?.lineItems, approvedAmounts, assessmentNotes, version);
		if (validationError) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, validationError);
		if (applyCommitment && !isPoLinkedSupplierVariation(live)) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, "Only a supplier variation that names a purchase order can be applied to a commitment.");
		const lineItems = buildApprovedLineItems(live.lineItems, approvedAmounts, version);
		if (lineItems.some((li) => li.approvedAmount === null || li.approvedGst === null)) throw new VariationWriteError(VARIATION_WRITE_ERROR.INVALID, "An approved amount is above the largest Constrap supports.");
		const approved = variationTotals(lineItems, "approved", version);
		return {
			...base,
			lineItems,
			approvedSubtotal: approved.subtotal,
			approvedGst: approved.gst,
			approvedTotal: approved.total,
			assessmentNotes: assessmentNotes?.trim() || "",
			approvedDate: live.approvedDate || today,
			effectiveDate: live.effectiveDate || live.approvedDate || today,
			...applyCommitment ? {
				...commitmentStamps(uid, now),
				...scopeStamps(uid, now)
			} : {}
		};
	}
	if (nextStatus === VARIATION_STATUS.REJECTED && assessmentNotes?.trim()) return {
		...base,
		assessmentNotes: assessmentNotes.trim()
	};
	return base;
}
function applyCommitmentUpdate(live, uid, now) {
	return {
		...isCommitmentApplied(live) ? {} : commitmentStamps(uid, now),
		...isScopeCommitted(live) ? {} : scopeStamps(uid, now),
		revision: nextRevision(live),
		updatedAt: now,
		updatedBy: uid
	};
}
const TYPED = {
	"variation-processing-disabled": [VARIATION_WRITE_ERROR.UNAVAILABLE, false],
	"variation-forbidden": [VARIATION_WRITE_ERROR.PERMISSION, false],
	"no-membership": [VARIATION_WRITE_ERROR.PERMISSION, false],
	"membership-inactive": [VARIATION_WRITE_ERROR.PERMISSION, false],
	"unauthenticated": [VARIATION_WRITE_ERROR.PERMISSION, true],
	"not-found": [VARIATION_WRITE_ERROR.MISSING, false],
	"invalid-argument": [VARIATION_WRITE_ERROR.INVALID, false],
	"variation-invalid": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-id-conflict": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-po-invalid": [VARIATION_WRITE_ERROR.PO_INVALID, true],
	"variation-rfi-invalid": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-cost-code-invalid": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-not-submitted": [VARIATION_WRITE_ERROR.STALE, true],
	"variation-not-draft": [VARIATION_WRITE_ERROR.STALE, true],
	"variation-stale": [VARIATION_WRITE_ERROR.STALE, false],
	"variation-figures-inconsistent": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-unsupported-record": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-not-applicable": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-amount-out-of-range": [VARIATION_WRITE_ERROR.INVALID, true],
	"variation-busy": [VARIATION_WRITE_ERROR.OFFLINE, true],
	"approval-segregation-required": [VARIATION_WRITE_ERROR.PERMISSION, true]
};
const CERTAIN_TRANSPORT = {
	"unauthenticated": [VARIATION_WRITE_ERROR.PERMISSION, "Your session has ended or this browser could not be verified. Nothing was saved — reload the page, sign in and try again."],
	"permission-denied": [VARIATION_WRITE_ERROR.PERMISSION, void 0],
	"not-found": [VARIATION_WRITE_ERROR.UNAVAILABLE, "This action is not available on the server yet. Nothing was saved."],
	"invalid-argument": [VARIATION_WRITE_ERROR.INVALID, void 0]
};

//#endregion
export { APPROVABLE_STATUSES, ASSESSMENT_NOTES_MAX, CALC_VERSION, COMMITMENT_APPLY_BLOCKER, CREATE_PROBLEM, CURRENT_CALC_VERSION, DRAFT_PROBLEM, VARIATION_COUNTER_ID, VARIATION_PROCESSING_ROLES, VARIATION_STATUS, VARIATION_TYPE, VariationWriteError, applyCommitmentUpdate, approvalActorEvidence, approvedAmountsProblem, approvedHeaderSupported, approvedSideProblem, buildVariationDraft, buildVariationDraftUpdate, calcVersionOf, commitmentApplyEligibility, createVariationRequestProblem, draftAlreadyHolds, isCommitmentApplied, isPoLinkedSupplierVariation, isScopeCommitted, lineSources, requestedCostCodeIds, resolveProjectCurrency, sameApproval, shouldApplyOnApproval, storedCostCodeIds, storedRevision, submittedSideProblem, transitionUpdate, updateVariationRequestProblem, variationCalcVersion, withAuthoritativeNames };