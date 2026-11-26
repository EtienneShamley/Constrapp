// ── Exact money arithmetic in integer cents (ADR-86) ─────────────────────────
//
// `roundMoney` (lib/purchaseOrders.js) is exact for SUMS and DIFFERENCES of
// two-decimal amounts. It is not exact for a PRODUCT with a factor binary
// floating point cannot represent: `roundMoney(40.15 × 0.1)` is 4.01, where
// decimal round-half-up gives 4.02 (tracker D3 #35).
//
// Everything here works on WHOLE CENTS as integers, so there is no such
// product. The receivables chain uses it: client-invoice line GST, client
// retention, client credit notes and client retention releases.
//
// ⚠️ THE PAYABLE SIDE IS DELIBERATELY NOT MOVED. Purchase orders, progress
// claims, supplier invoices, variations and supplier retention releases keep
// `roundMoney(x × GST_RATE)` in Phase 1: four read-time comparisons there
// recompute a GST figure and compare it with a stored one, and would report a
// one-cent difference on a legacy boundary document (ADR-86, Finding 3).
//
// The SAME module runs in the trusted backend (bundled into
// functions/src/generated/clientFinanceCalc.js), which is where every posted
// figure is re-derived and required to match — the browser's copy only
// previews. `shareOfCents` uses BigInt, so it is exact at any size.

// ── Supported range ──────────────────────────────────────────────────────────
// 999,999,999,999.99 per invoice (ex-GST subtotal): the largest amount at which
// EVERYTHING here is established exact, with margin. Evidence
// (tests/unit/money.test.js, clientLedger.test.js): amounts convert to cents
// and back exactly for every tested value up to 10^13; the first conversion
// failure is at 2^45 ≈ 35,184,372,088,832.02 — a limit of the DOUBLE that
// stores the amount, 35 times above this maximum; `shareOfCents` is exact at
// any size; one maximum invoice's gross is about 1.1 × 10^14 cents, far inside
// the safe-integer range (2^53 ≈ 9.0 × 10^15), and eighty of them summed still
// are. Ledger totals are integers (Firestore 64-bit integers); amounts on
// documents are doubles. Dollar-denominated PROJECT totals are exact below
// 2^45, i.e. about 31 maximum invoices — a limit of display sums, not of any
// stored record.
export const MAX_SUPPORTED_AMOUNT_CENTS = 99_999_999_999_999
export const MAX_SUPPORTED_AMOUNT_TEXT = '999,999,999,999.99'
// One client RECEIPT may settle several invoices: ten maximum invoices
// (9,999,999,999,999.90 ≈ 10^15 cents) — inside the tested exact-conversion
// range of 10^13 dollars, and nine times below the safe-integer limit (2^53).
export const MAX_SUPPORTED_RECEIPT_CENTS = 999_999_999_999_990   // 10 × MAX_SUPPORTED_AMOUNT_CENTS

// A two-decimal amount as whole cents. `Math.round(x × 100)` is exact for any
// two-decimal `x` below about 4.5 × 10^13: the double nearest to `x`, times
// 100, lies within a tiny fraction of the integer it represents.
export function toCents(amount) {
  const n = typeof amount === 'number' ? amount : Number(amount)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

// Whole cents back to an amount. Division by 100 is correctly rounded, so this
// is the double nearest to the decimal value — the same double `Number('4.02')`
// produces.
export const fromCents = (cents) => cents / 100

// True when `amount` is a finite number carrying no fraction of a cent.
export const isWholeCents = (amount) =>
  typeof amount === 'number' && Number.isFinite(amount) && fromCents(toCents(amount)) === amount

// GST at the flat Australian 10% on a whole-cent amount, round-half-up, as
// whole cents. Rules: `gstCents(c)` = `math.floor((c + 5) / 10)`.
// A negative amount mirrors its positive (half away from zero), so a figure
// and its reversal always cancel.
export function gstOfCents(cents) {
  // `0 -` rather than unary minus, so a negative amount below half a cent of
  // GST gives 0 and never -0.
  return cents < 0 ? 0 - Math.floor((-cents + 5) / 10) : Math.floor((cents + 5) / 10)
}

// GST on a two-decimal ex-GST amount: 40.15 → 4.02.
export const gstExact = (amount) => fromCents(gstOfCents(toCents(amount)))

// round-half-up(total × part ÷ whole), all whole cents, 0 ≤ part ≤ whole.
// The share of `total` that `part` is of `whole`. BigInt, so the product never
// loses precision. Rules: `(2 * total * part + whole) / (2 * whole)`.
// `whole` of zero has no share: 0.
export function shareOfCents(total, part, whole) {
  if (!Number.isInteger(total) || !Number.isInteger(part) || !Number.isInteger(whole)) {
    throw new TypeError('shareOfCents takes whole cents')
  }
  if (whole <= 0 || part <= 0 || total <= 0) return 0
  const t = BigInt(total), p = BigInt(part), w = BigInt(whole)
  return Number((2n * t * p + w) / (2n * w))
}

// The step from one cumulative share to the next, with the final remainder
// made explicit: when the cumulative part reaches the whole, the cumulative
// share IS the total, whatever rounding the earlier steps took. Returns the
// cents this step adds, never negative and never more than what is left.
//
//   alreadyShared — cents of `total` attributed by the steps before this one
//   partAfter     — the cumulative part once this step is applied
export function shareStep(total, partAfter, whole, alreadyShared) {
  const target = partAfter >= whole ? total : shareOfCents(total, partAfter, whole)
  return Math.min(Math.max(0, target - alreadyShared), Math.max(0, total - alreadyShared))
}
