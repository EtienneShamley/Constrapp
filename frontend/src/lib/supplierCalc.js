import { GST_RATE, roundMoney } from './purchaseOrders'
import { toCents, fromCents, gstOfCents, MAX_SUPPORTED_AMOUNT_CENTS } from './money'

// ── Version-aware supplier-side money arithmetic (ADR-91, tracker D3 #35) ─────
//
// The payable side — purchase orders, progress claims, supplier invoices,
// variations and supplier retention releases — was written on
// `roundMoney(x × GST_RATE)`, which is one cent below decimal half-up on some
// half-cent boundaries (40.15 → 4.01, not 4.02; ADR-86 Finding 1). Documents
// already stored carry those figures and are NEVER recalculated.
//
// A document therefore records the calculation policy that produced its
// figures, and is always recalculated — previewed, edited, certified, checked —
// under THAT policy:
//
//   calcVersion absent / null / 1   LEGACY: the expressions the application has
//                                   always used, unchanged to the byte.
//   calcVersion 2                   EXACT: whole cents as integers; amounts are
//                                   rounded to cents HALF AWAY FROM ZERO from
//                                   their decimal value (4.015 → 4.02,
//                                   -4.015 → -4.02); GST is 10% of the whole-cent
//                                   amount, half away from zero.
//
// The version is written ONCE, when the document is created, by the trusted
// backend (never taken from a request) and is immutable afterwards: the Rules
// admit no client write that changes it. Anything else — a string, 3, 1.5 — is
// an UNKNOWN policy: `calcVersionOf` returns null and every caller refuses
// rather than guess.
//
// DERIVED DOCUMENTS (a release against an invoice, an invoice from a claim, a
// credit against an invoice) do not apply a rate at all: they take their GST as
// an integer SHARE of the source document's STORED figure (lib/money.js →
// shareOfCents / shareStep), so they reconcile exactly to the source whatever
// policy produced it. Such a document records its own `calcVersion` and the
// source's (`sourceCalcVersion`, null for a legacy source). Those call sites
// move with their own trusted operations (Phase 2 steps 3 and 4); this module
// is their shared foundation.
//
// This is how Constrap rounds money. It is not a statement of the tax law of
// any jurisdiction (GST is still the flat Australian 10%).

export const CALC_VERSION = Object.freeze({ LEGACY: 1, EXACT: 2 })

// What the trusted backend stamps on a document it creates.
export const CURRENT_CALC_VERSION = CALC_VERSION.EXACT

// The policy a stored document was calculated under, or NULL when the stored
// value is not one this code knows — the caller must then refuse.
export function calcVersionOf(doc) {
  const v = doc?.calcVersion
  if (v === undefined || v === null || v === CALC_VERSION.LEGACY) return CALC_VERSION.LEGACY
  if (v === CALC_VERSION.EXACT) return CALC_VERSION.EXACT
  return null
}

export const isKnownCalcVersion = (v) => v === CALC_VERSION.LEGACY || v === CALC_VERSION.EXACT

function assertVersion(version) {
  if (!isKnownCalcVersion(version)) throw new RangeError(`Unknown calculation version: ${String(version)}`)
}

// ── Exact decimal rounding ───────────────────────────────────────────────────
//
// A JavaScript number is a binary double: 4.015 is stored as
// 4.01499999999999968…, so rounding the BINARY value gives 4.01. The amount a
// person entered is the DECIMAL 4.015, which is exactly what the shortest
// round-trip rendering of the double (`String(n)`) gives back for any value of
// up to 15 significant digits — every amount inside the supported range. The
// helpers below therefore read the decimal digits, and do the arithmetic on
// them as integers (BigInt), so no product and no rounding step ever sees a
// binary fraction.

// { negative, digits (BigInt, no sign), scale } with value = ±digits / 10^scale,
// or null when `n` is not a finite number in plain decimal range.
function decimalParts(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const negative = n < 0
  const text = String(Math.abs(n))
  if (text.includes('e')) {
    // Below 1e-6 the rendering is exponential: such a value is far under half a
    // cent on its own and, as a factor, far outside any quantity or rate.
    if (Math.abs(n) < 1e-6) return { negative, digits: 0n, scale: 0 }
    return null   // ≥ 1e21 — outside every supported amount
  }
  const [whole, fraction = ''] = text.split('.')
  return { negative, digits: BigInt(whole + fraction), scale: fraction.length }
}

// ±digits / 10^scale → whole cents, half away from zero.
function partsToCents({ negative, digits, scale }) {
  let cents
  if (scale <= 2) {
    cents = digits * 10n ** BigInt(2 - scale)
  } else {
    const divisor = 10n ** BigInt(scale - 2)
    cents = (digits * 2n + divisor) / (divisor * 2n)   // half up on the magnitude
  }
  const out = Number(cents)
  return negative && out !== 0 ? -out : out
}

// A decimal amount as whole cents, HALF AWAY FROM ZERO: 4.015 → 402,
// -4.015 → -402, 4.0149 → 401. Returns null for a value that is not a finite
// number or is outside the supported range — never a guess.
export function roundToCents(amount) {
  const parts = decimalParts(amount)
  if (!parts) return null
  const cents = partsToCents(parts)
  return Math.abs(cents) > MAX_SUPPORTED_AMOUNT_CENTS ? null : cents
}

// The exact decimal product a × b as whole cents, half away from zero — for a
// quantity × a unit rate. Neither factor is rounded first: 3 × 33.335 is
// 100.005 → 100.01, and 0.333 × 100.10 is 33.3333 → 33.33. Null when either
// factor is not a finite number or the product is outside the supported range.
export function productToCents(a, b) {
  const x = decimalParts(a)
  const y = decimalParts(b)
  if (!x || !y) return null
  const cents = partsToCents({
    negative: x.negative !== y.negative,
    digits: x.digits * y.digits,
    scale: x.scale + y.scale,
  })
  return Math.abs(cents) > MAX_SUPPORTED_AMOUNT_CENTS ? null : cents
}

// ── The two policies ─────────────────────────────────────────────────────────

// An entered amount as the two-decimal figure a document stores.
//   LEGACY — `roundMoney(n)`, exactly as every existing call site.
//   EXACT  — the decimal value, half away from zero; null when out of range.
export function roundAmount(amount, version = CALC_VERSION.LEGACY) {
  assertVersion(version)
  const n = Number(amount) || 0
  if (version === CALC_VERSION.LEGACY) return roundMoney(n)
  const cents = roundToCents(n)
  return cents === null ? null : fromCents(cents)
}

// GST at the flat 10% on an ex-GST amount.
//   LEGACY — `roundMoney(n × GST_RATE)`: the stored figure of every existing
//            document, one cent low on some half-cent boundaries. Unchanged.
//   EXACT  — the amount is first the whole-cent figure the document stores
//            (roundAmount), and the GST is 10% of those cents, half away from
//            zero: 40.15 → 4.02, -40.15 → -4.02. Null when out of range.
export function gstOnAmount(amount, version = CALC_VERSION.LEGACY) {
  assertVersion(version)
  const n = Number(amount) || 0
  if (version === CALC_VERSION.LEGACY) return roundMoney(n * GST_RATE)
  const cents = roundToCents(n)
  return cents === null ? null : fromCents(gstOfCents(cents))
}

// The sum of two-decimal amounts.
//   LEGACY — `roundMoney(Σ)`, as every existing header.
//   EXACT  — Σ of whole cents, as integers.
export function sumAmounts(amounts, version = CALC_VERSION.LEGACY) {
  assertVersion(version)
  if (version === CALC_VERSION.LEGACY) {
    return roundMoney((amounts ?? []).reduce((sum, a) => sum + (Number(a) || 0), 0))
  }
  return fromCents((amounts ?? []).reduce((sum, a) => sum + toCents(Number(a) || 0), 0))
}

// True when `amount` is a finite two-decimal number inside the supported range.
export const isSupportedAmount = (amount) =>
  typeof amount === 'number' && Number.isFinite(amount)
  && Math.abs(toCents(amount)) <= MAX_SUPPORTED_AMOUNT_CENTS
  && fromCents(toCents(amount)) === amount
