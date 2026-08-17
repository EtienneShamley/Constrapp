// ── Company Country & Project Currency (pure reference data + resolution) ────
//
// Constrapp reports each project in ONE currency. There is deliberately NO FX
// conversion, no exchange rates, and no mixed-currency transactions: a project
// currency is a LABEL for amounts that were entered in that currency, never a
// conversion instruction. Changing a currency never converts a stored number.
//
// The chain is: company country SUGGESTS a base currency (the user confirms or
// overrides it) → a new project INHERITS the company base currency (overridable
// at creation) → every financial screen displays the project's currency.
//
// This module is pure: reference data, suggestion, resolution, and the
// monetary-record predicate that drives currency locking. No Firestore, no
// React, no formatting (formatting lives in lib/formatters.js).

// ── Display defaults ─────────────────────────────────────────────────────────

// Fallback for companies/projects that predate this foundation. Rendering an
// unconfigured company in AUD reproduces the app's previous output exactly, so
// existing installations see no display change until an admin configures them.
export const DEFAULT_CURRENCY = 'AUD'

// ONE fixed display locale for money, deliberately unchanged from the app's
// previous `en-AU` formatter. Two consequences, both wanted:
//   · AUD keeps rendering as "$1,235" — byte-for-byte the previous output.
//   · Every OTHER currency renders with its ISO code ("NZD 1,235", "ZAR 1,235")
//     rather than a bare "$", so an AUD figure can never be mistaken for an NZD
//     or USD one in a company running projects in several currencies.
// Per-country display locales (and date localisation generally) are a separate,
// later improvement — see docs/PROJECT_DECISIONS.md ADR-21.
export const CURRENCY_DISPLAY_LOCALE = 'en-AU'

// ── Code shape ───────────────────────────────────────────────────────────────
// ISO 3166-1 alpha-2 (country) and ISO 4217 (currency). The SAME patterns are
// mirrored in frontend/firestore.rules, which validates shape rather than an
// enum: an enum duplicated into a manually-published rules file would drift out
// of sync with this module and start rejecting valid writes in production.
export const COUNTRY_CODE_PATTERN  = /^[A-Z]{2}$/
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/

export const isCountryCodeShape  = (code) => typeof code === 'string' && COUNTRY_CODE_PATTERN.test(code)
export const isCurrencyCodeShape = (code) => typeof code === 'string' && CURRENCY_CODE_PATTERN.test(code)

// ── Currencies ───────────────────────────────────────────────────────────────
// Selectable ISO 4217 codes. A user may always override the suggestion — an
// Australian builder delivering a PNG contract may legitimately report in USD.
export const CURRENCIES = [
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'USD', name: 'United States Dollar' },
  { code: 'GBP', name: 'Pound Sterling' },
  { code: 'EUR', name: 'Euro' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'PLN', name: 'Polish Złoty' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'SAR', name: 'Saudi Riyal' },
  { code: 'QAR', name: 'Qatari Riyal' },
  { code: 'KWD', name: 'Kuwaiti Dinar' },
  { code: 'OMR', name: 'Omani Rial' },
  { code: 'BHD', name: 'Bahraini Dinar' },
  { code: 'ILS', name: 'Israeli New Shekel' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'IDR', name: 'Indonesian Rupiah' },
  { code: 'PHP', name: 'Philippine Peso' },
  { code: 'THB', name: 'Thai Baht' },
  { code: 'VND', name: 'Vietnamese Đồng' },
  { code: 'KRW', name: 'South Korean Won' },
  { code: 'LKR', name: 'Sri Lankan Rupee' },
  { code: 'PKR', name: 'Pakistani Rupee' },
  { code: 'BDT', name: 'Bangladeshi Taka' },
  { code: 'PGK', name: 'Papua New Guinean Kina' },
  { code: 'FJD', name: 'Fijian Dollar' },
  { code: 'VUV', name: 'Vanuatu Vatu' },
  { code: 'SBD', name: 'Solomon Islands Dollar' },
  { code: 'WST', name: 'Samoan Tālā' },
  { code: 'TOP', name: 'Tongan Paʻanga' },
  { code: 'XPF', name: 'CFP Franc' },
  { code: 'KES', name: 'Kenyan Shilling' },
  { code: 'TZS', name: 'Tanzanian Shilling' },
  { code: 'UGX', name: 'Ugandan Shilling' },
  { code: 'NGN', name: 'Nigerian Naira' },
  { code: 'GHS', name: 'Ghanaian Cedi' },
  { code: 'ZMW', name: 'Zambian Kwacha' },
  { code: 'BWP', name: 'Botswana Pula' },
  { code: 'NAD', name: 'Namibian Dollar' },
  { code: 'MUR', name: 'Mauritian Rupee' },
  { code: 'EGP', name: 'Egyptian Pound' },
  { code: 'MAD', name: 'Moroccan Dirham' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'CLP', name: 'Chilean Peso' },
  { code: 'ARS', name: 'Argentine Peso' },
]

// ── Countries ────────────────────────────────────────────────────────────────
// A LOCAL, maintained mapping rather than an npm package: this is ~100 lines of
// data that changes on a decade timescale, and AGENT.md forbids new
// dependencies without explicit instruction.
//
// The mapping only ever SUGGESTS. Country → currency is not a function:
//   · Dollarised economies — Panama/Ecuador/El Salvador use USD with no
//     national currency; Zimbabwe operates multi-currency.
//   · EU membership ≠ euro — Denmark (DKK), Sweden (SEK), Poland (PLN) are in
//     the EU but not the eurozone; Kosovo and Montenegro use EUR without being
//     in either.
//   · Currency unions cross borders — ZAR circulates in Lesotho/Namibia/
//     Eswatini; AUD in Nauru/Kiribati/Tuvalu; NZD in the Cook Islands/Niue.
//   · Decisively: a company's country is not its contract's currency. An AU
//     builder on a PNG resources job bills USD.
// This is exactly why the user must CONFIRM the suggestion (see §3 of the
// Company Settings flow) and may always override it.

// The named target markets — listed first in the picker.
export const SUPPORTED_MARKETS = [
  { code: 'NZ', name: 'New Zealand',    currency: 'NZD' },
  { code: 'AU', name: 'Australia',      currency: 'AUD' },
  { code: 'ZA', name: 'South Africa',   currency: 'ZAR' },
  { code: 'US', name: 'United States',  currency: 'USD' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'IE', name: 'Ireland',        currency: 'EUR' },
]

// Everything else, alphabetical. Eurozone members all map to EUR.
export const OTHER_COUNTRIES = [
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED' },
  { code: 'AR', name: 'Argentina',            currency: 'ARS' },
  { code: 'AT', name: 'Austria',              currency: 'EUR' },
  { code: 'BD', name: 'Bangladesh',           currency: 'BDT' },
  { code: 'BE', name: 'Belgium',              currency: 'EUR' },
  { code: 'BH', name: 'Bahrain',              currency: 'BHD' },
  { code: 'BR', name: 'Brazil',               currency: 'BRL' },
  { code: 'BW', name: 'Botswana',             currency: 'BWP' },
  { code: 'CA', name: 'Canada',               currency: 'CAD' },
  { code: 'CH', name: 'Switzerland',          currency: 'CHF' },
  { code: 'CK', name: 'Cook Islands',         currency: 'NZD' },
  { code: 'CL', name: 'Chile',                currency: 'CLP' },
  { code: 'CN', name: 'China',                currency: 'CNY' },
  { code: 'CY', name: 'Cyprus',               currency: 'EUR' },
  { code: 'DE', name: 'Germany',              currency: 'EUR' },
  { code: 'DK', name: 'Denmark',              currency: 'DKK' },
  { code: 'EE', name: 'Estonia',              currency: 'EUR' },
  { code: 'EG', name: 'Egypt',                currency: 'EGP' },
  { code: 'ES', name: 'Spain',                currency: 'EUR' },
  { code: 'FI', name: 'Finland',              currency: 'EUR' },
  { code: 'FJ', name: 'Fiji',                 currency: 'FJD' },
  { code: 'FR', name: 'France',               currency: 'EUR' },
  { code: 'GH', name: 'Ghana',                currency: 'GHS' },
  { code: 'GR', name: 'Greece',               currency: 'EUR' },
  { code: 'HK', name: 'Hong Kong SAR',        currency: 'HKD' },
  { code: 'HR', name: 'Croatia',              currency: 'EUR' },
  { code: 'ID', name: 'Indonesia',            currency: 'IDR' },
  { code: 'IL', name: 'Israel',               currency: 'ILS' },
  { code: 'IN', name: 'India',                currency: 'INR' },
  { code: 'IT', name: 'Italy',                currency: 'EUR' },
  { code: 'JP', name: 'Japan',                currency: 'JPY' },
  { code: 'KE', name: 'Kenya',                currency: 'KES' },
  { code: 'KI', name: 'Kiribati',             currency: 'AUD' },
  { code: 'KR', name: 'South Korea',          currency: 'KRW' },
  { code: 'KW', name: 'Kuwait',               currency: 'KWD' },
  { code: 'LK', name: 'Sri Lanka',            currency: 'LKR' },
  { code: 'LT', name: 'Lithuania',            currency: 'EUR' },
  { code: 'LU', name: 'Luxembourg',           currency: 'EUR' },
  { code: 'LV', name: 'Latvia',               currency: 'EUR' },
  { code: 'MA', name: 'Morocco',              currency: 'MAD' },
  { code: 'MT', name: 'Malta',                currency: 'EUR' },
  { code: 'MU', name: 'Mauritius',            currency: 'MUR' },
  { code: 'MX', name: 'Mexico',               currency: 'MXN' },
  { code: 'MY', name: 'Malaysia',             currency: 'MYR' },
  { code: 'NA', name: 'Namibia',              currency: 'NAD' },
  { code: 'NC', name: 'New Caledonia',        currency: 'XPF' },
  { code: 'NG', name: 'Nigeria',              currency: 'NGN' },
  { code: 'NL', name: 'Netherlands',          currency: 'EUR' },
  { code: 'NO', name: 'Norway',               currency: 'NOK' },
  { code: 'NR', name: 'Nauru',                currency: 'AUD' },
  { code: 'NU', name: 'Niue',                 currency: 'NZD' },
  { code: 'OM', name: 'Oman',                 currency: 'OMR' },
  { code: 'PF', name: 'French Polynesia',     currency: 'XPF' },
  { code: 'PG', name: 'Papua New Guinea',     currency: 'PGK' },
  { code: 'PH', name: 'Philippines',          currency: 'PHP' },
  { code: 'PK', name: 'Pakistan',             currency: 'PKR' },
  { code: 'PL', name: 'Poland',               currency: 'PLN' },
  { code: 'PT', name: 'Portugal',             currency: 'EUR' },
  { code: 'QA', name: 'Qatar',                currency: 'QAR' },
  { code: 'SA', name: 'Saudi Arabia',         currency: 'SAR' },
  { code: 'SB', name: 'Solomon Islands',      currency: 'SBD' },
  { code: 'SE', name: 'Sweden',               currency: 'SEK' },
  { code: 'SG', name: 'Singapore',            currency: 'SGD' },
  { code: 'SI', name: 'Slovenia',             currency: 'EUR' },
  { code: 'SK', name: 'Slovakia',             currency: 'EUR' },
  { code: 'TH', name: 'Thailand',             currency: 'THB' },
  { code: 'TO', name: 'Tonga',                currency: 'TOP' },
  { code: 'TR', name: 'Türkiye',              currency: 'TRY' },
  { code: 'TV', name: 'Tuvalu',               currency: 'AUD' },
  { code: 'TZ', name: 'Tanzania',             currency: 'TZS' },
  { code: 'UG', name: 'Uganda',               currency: 'UGX' },
  { code: 'VN', name: 'Vietnam',              currency: 'VND' },
  { code: 'VU', name: 'Vanuatu',              currency: 'VUV' },
  { code: 'WS', name: 'Samoa',                currency: 'WST' },
  { code: 'ZM', name: 'Zambia',               currency: 'ZMW' },
  { code: 'ZW', name: 'Zimbabwe',             currency: 'USD' },
]

export const COUNTRIES = [...SUPPORTED_MARKETS, ...OTHER_COUNTRIES]

const COUNTRY_BY_CODE  = new Map(COUNTRIES.map(c => [c.code, c]))
const CURRENCY_BY_CODE = new Map(CURRENCIES.map(c => [c.code, c]))

export const isKnownCountryCode  = (code) => COUNTRY_BY_CODE.has(code)
export const isKnownCurrencyCode = (code) => CURRENCY_BY_CODE.has(code)

export const countryName  = (code) => COUNTRY_BY_CODE.get(code)?.name  ?? code ?? ''
export const currencyName = (code) => CURRENCY_BY_CODE.get(code)?.name ?? code ?? ''

// The suggested currency for a country, or null when the country is unknown.
// A SUGGESTION only — the user confirms or overrides it.
export function suggestCurrencyForCountry(countryCode) {
  return COUNTRY_BY_CODE.get(countryCode)?.currency ?? null
}

// True when the chosen currency is not the one normally used in the chosen
// country. Drives an informational note; never blocks a save.
export function isCurrencyUnusualForCountry(countryCode, currencyCode) {
  const suggested = suggestCurrencyForCountry(countryCode)
  return !!suggested && !!currencyCode && suggested !== currencyCode
}

// ── Tax limitation ───────────────────────────────────────────────────────────
// This foundation makes currency DISPLAY configurable. It does NOT make tax
// calculation configurable: GST_RATE (lib/purchaseOrders.js) is a flat 10% and
// the "GST 10%" labels on POs, claims, invoices, and variations are Australian.
// Selecting NZ/ZA/US/GB does NOT make Constrapp tax-compliant there.
export const TAX_JURISDICTION = 'AU'

export const TAX_LIMITATION_NOTICE =
  'Currency display is configurable, but tax calculations currently use the existing ' +
  'Australian GST rules. Country-specific tax configuration is a separate future foundation.'

export const needsTaxLimitationNotice = (countryCode) =>
  !!countryCode && countryCode !== TAX_JURISDICTION

// ── Resolution ───────────────────────────────────────────────────────────────

// A company is configured once it carries a well-formed base currency. Until
// then nothing is written to Firestore — the setup banner prompts an admin and
// display falls back to DEFAULT_CURRENCY, preserving the previous output.
export const isCompanyCurrencyConfigured = (company) =>
  isCurrencyCodeShape(company?.baseCurrency)

export const resolveCompanyCurrency = (company) =>
  (isCurrencyCodeShape(company?.baseCurrency) ? company.baseCurrency : DEFAULT_CURRENCY)

// A project carries an EXPLICIT currency once it has been created under (or
// pinned by) this foundation. Projects predating it have none and resolve
// through the company — which is precisely why company setup pins every
// existing project, so a later company-currency change can never relabel them.
export const projectHasExplicitCurrency = (project) =>
  isCurrencyCodeShape(project?.currency)

// THE display authority for every money figure on a project.
// project.currency → company.baseCurrency → AUD.
export function resolveProjectCurrency(project, company) {
  if (isCurrencyCodeShape(project?.currency)) return project.currency
  return resolveCompanyCurrency(company)
}

// ── Currency locking ─────────────────────────────────────────────────────────
//
// Currency locks as soon as the project holds ANY monetary value, because
// changing it afterwards would RELABEL existing amounts without converting
// them. Cost Codes and Contacts are company-wide and hold no money, so they
// never lock.
//
// IMPORTANT (trust boundary): this predicate is CLIENT-side. Firestore Security
// Rules cannot enumerate random-ID subcollections (they offer get()/exists() on
// a known document path only — no list, query, or count), so no rule can decide
// whether a project has budget lines, POs, claims, invoices, or variations.
// What the rules DO enforce is the ratchet: once `project.currencyLocked` is
// true they reject any change to `currency` and any attempt to set the flag back
// to false. A client can therefore decline to SET the lock, but no client can
// unset it or change a locked currency. See docs/SECURITY.md → Deferred Controls.

// Human-readable reasons, in the order they are shown. Each entry is the
// evidence that the project already holds money.
export function monetaryLockReasons({
  project = null,
  budgetLines = [],
  purchaseOrders = [],
  progressClaims = [],
  supplierInvoices = [],
  clientInvoices = [],
  clientReceipts = [],
  supplierPayments = [],
  variations = [],
  tenderBids = [],
  forecastLines = [],
  cashFlowLines = [],
  boqItems = [],
  baseline = null,
} = {}) {
  const reasons = []
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

  // The headline project budget is itself a monetary amount — changing currency
  // while it is non-zero would relabel it without converting it.
  if (Number(project?.budget) > 0) reasons.push('a headline project budget')
  if (budgetLines.length)      reasons.push(plural(budgetLines.length, 'budget line', 'budget lines'))
  // Every PO counts, including draft and cancelled: a cancelled PO is a retained
  // audit record carrying amounts (ADR-12).
  if (purchaseOrders.length)   reasons.push(plural(purchaseOrders.length, 'purchase order', 'purchase orders'))
  if (progressClaims.length)   reasons.push(plural(progressClaims.length, 'progress claim', 'progress claims'))
  if (supplierInvoices.length) reasons.push(plural(supplierInvoices.length, 'supplier invoice', 'supplier invoices'))
  // Every client invoice counts, including drafts and voids: a voided invoice
  // is a retained audit record carrying amounts, exactly like a cancelled PO.
  if (clientInvoices.length)   reasons.push(plural(clientInvoices.length, 'client invoice', 'client invoices'))
  // Every client receipt counts, including drafts and voids: a receipt records
  // an amount of money in this project's currency, and a voided receipt is a
  // retained audit record carrying that amount — exactly like a cancelled PO.
  if (clientReceipts.length)   reasons.push(plural(clientReceipts.length, 'client receipt', 'client receipts'))
  // Every supplier payment counts, including drafts and voids: a payment records
  // an amount of money in this project's currency, and a voided payment is a
  // retained audit record carrying that amount — exactly like a cancelled PO.
  if (supplierPayments.length) reasons.push(plural(supplierPayments.length, 'supplier payment', 'supplier payments'))
  if (variations.length)       reasons.push(plural(variations.length, 'variation', 'variations'))
  // Every tender bid counts, including voided ones: a bid records ex-GST
  // amounts in this project's currency, and a voided bid is a retained audit
  // record carrying those amounts — exactly like a cancelled PO. Tender
  // PACKAGES never count: they hold scope and dates, no amounts.
  if (tenderBids.length)       reasons.push(plural(tenderBids.length, 'tender bid', 'tender bids'))
  // Every cash-flow timing line counts, including voided ones: a line records
  // an expected gross cash amount in this project's currency, and a voided line
  // is retained forecast history carrying that amount — exactly like a
  // cancelled PO or a voided receipt.
  if (cashFlowLines.length)    reasons.push(plural(cashFlowLines.length, 'cash-flow timing line', 'cash-flow timing lines'))

  // A forecast row that exists with `null` is "not forecast" and carries no
  // money — only an authored number (including 0) counts.
  const forecastInputs = forecastLines.filter(
    (l) => l?.uncommittedCostToComplete !== null && l?.uncommittedCostToComplete !== undefined,
  ).length
  if (forecastInputs) reasons.push(plural(forecastInputs, 'forecast input', 'forecast inputs'))

  // A BOQ item with `rate: null` is measured but UNPRICED and carries no money
  // (a quantity is a measurement, not an amount) — only an authored rate
  // (including 0) counts, exactly the forecast-input reasoning above. Voided
  // priced items still count: a voided item is a retained record carrying an
  // amount, exactly like a cancelled PO.
  const pricedBoqItems = boqItems.filter(
    (i) => i?.rate !== null && i?.rate !== undefined,
  ).length
  if (pricedBoqItems) reasons.push(plural(pricedBoqItems, 'priced BOQ item', 'priced BOQ items'))

  // An absent or empty baseline carries no money; an established one does.
  if (typeof baseline?.originalContractValue === 'number') reasons.push('a commercial baseline')

  return reasons
}

export const hasMonetaryRecords = (sources) => monetaryLockReasons(sources).length > 0

// The lock state the UI must honour: the rules-enforced ratchet flag OR live
// client-side evidence. The flag alone is not enough — a project that predates
// this foundation has no flag yet but may hold years of financial records.
export const isProjectCurrencyLocked = (project, sources) =>
  project?.currencyLocked === true || hasMonetaryRecords({ ...sources, project })
