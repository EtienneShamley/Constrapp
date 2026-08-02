import { CURRENCY_DISPLAY_LOCALE, DEFAULT_CURRENCY } from './currency'

export const formatDate = (ts) => {
  if (!ts) return '—'
  return ts.toDate().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const pct = new Intl.NumberFormat('en-AU', { style: 'percent', maximumFractionDigits: 1 })

export const percent = (n) => pct.format(n / 100)

// ── Money ────────────────────────────────────────────────────────────────────
//
// THE single money formatter. Every figure on every financial screen goes
// through here with the resolved PROJECT currency (lib/currency.js →
// resolveProjectCurrency); nothing formats money any other way and there is no
// hard-coded currency or symbol left in the UI.
//
// Deliberate behaviour:
//   · Whole units by default (`maximumFractionDigits: 0`) — the app's existing
//     display convention, preserved so migrating to this helper changes no
//     existing AUD output. Pass `{ precise: true }` to let Intl apply each
//     currency's own ISO 4217 minor-unit convention (JPY 0, most 2, KWD 3).
//   · 0 formats as a real zero ("$0"), never "—". Zero is a meaningful
//     financial value — ADR-19 relies on `0` meaning "reviewed, no further
//     cost" as distinct from "not set".
//   · null / undefined / NaN / Infinity render "—", never "NaN" or "$∞".
//   · An unusable currency code falls back to "<CODE> 1,235" rather than
//     throwing: Intl raises a RangeError on a malformed code, and one bad
//     document must never blank an entire financial page.
//
// Formatters are cached — the Budget and Forecast tables call this hundreds of
// times per render and constructing Intl.NumberFormat is comparatively costly.
const formatterCache = new Map()

function getFormatter(currencyCode, precise) {
  const key = `${currencyCode}|${precise ? 'p' : 'w'}`
  const cached = formatterCache.get(key)
  if (cached !== undefined) return cached

  let formatter
  try {
    formatter = new Intl.NumberFormat(CURRENCY_DISPLAY_LOCALE, {
      style: 'currency',
      currency: currencyCode,
      // Omitting maximumFractionDigits lets Intl apply the currency's own
      // minor-unit convention; 0 gives the app's established whole-unit display.
      ...(precise ? {} : { maximumFractionDigits: 0 }),
    })
  } catch {
    // Unknown / malformed currency code — fall back below.
    formatter = null
  }

  formatterCache.set(key, formatter)
  return formatter
}

const plainNumber = new Intl.NumberFormat(CURRENCY_DISPLAY_LOCALE, { maximumFractionDigits: 0 })

export function formatCurrency(amount, currencyCode = DEFAULT_CURRENCY, { precise = false } = {}) {
  if (amount === null || amount === undefined) return '—'
  const n = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(n)) return '—'

  const code = typeof currencyCode === 'string' && currencyCode ? currencyCode : DEFAULT_CURRENCY
  const formatter = getFormatter(code, precise)
  if (!formatter) return `${code} ${plainNumber.format(n)}`
  return formatter.format(n)
}

const ROLE_LABELS = {
  super_admin:     'Super Admin',
  company_admin:   'Company Admin',
  project_manager: 'Project Manager',
  qs:              'QS / Office',
  subcontractor:   'Subcontractor',
  client:          'Client',
}

export const formatRole = (role) => ROLE_LABELS[role] ?? role ?? '—'
