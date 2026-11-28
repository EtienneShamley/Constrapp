import { describe, it, expect } from 'vitest'
import {
  CALC_VERSION, CURRENT_CALC_VERSION, calcVersionOf, isKnownCalcVersion,
  roundToCents, productToCents, roundAmount, gstOnAmount, sumAmounts, isSupportedAmount,
} from '../../src/lib/supplierCalc'
import { roundMoney, GST_RATE, poTotals } from '../../src/lib/purchaseOrders'
import { gstForLine as supplierInvoiceGstForLine } from '../../src/lib/supplierInvoices'
import { gstForLine as variationGstForLine, TAX_CODE } from '../../src/lib/variations'
import { MAX_SUPPORTED_AMOUNT_CENTS } from '../../src/lib/money'

// ── Version-aware supplier arithmetic (ADR-91, D3 #35) — pure domain tests ───
//
// THE ORACLE IS INDEPENDENT OF THE MODULE. Every input below is GENERATED FROM
// AN INTEGER (whole cents, thousandths, ten-thousandths) and the expected
// result is computed from that integer with BigInt quotient-and-remainder
// arithmetic. The oracle never parses a double, never calls `String(number)`,
// never imports src/lib/supplierCalc.js or src/lib/money.js, and uses no
// floating point — so it shares neither code nor method with what it checks.
//
// What is proven:
//   1. LEGACY (version 1) is the application's existing expression, to the
//      byte: equal to `roundMoney(x × GST_RATE)` and to the two existing
//      supplier `gstForLine` functions on every cent amount swept, both signs.
//   2. EXACT (version 2) equals decimal half-away-from-zero on every cent
//      amount swept, both signs, and on a spread up to the supported maximum.
//   3. Rounding an entered amount to cents is DECIMAL and SIGN-SYMMETRIC
//      (4.015 → 4.02, -4.015 → -4.02), for every thousandth swept.
//   4. A quantity × rate product is exact before it is rounded: neither factor
//      is rounded to two decimals first.
//   5. Where the two policies differ, and by how much — counted, not assumed.

// ── The oracle (BigInt only) ─────────────────────────────────────────────────

const abs = (n) => (n < 0n ? -n : n)
const sign = (n) => (n < 0n ? -1n : 1n)

// round-half-away-from-zero of num ÷ den, den > 0.
function halfAway(num, den) {
  const q = abs(num) / den
  const r = abs(num) % den
  const magnitude = r * 2n >= den ? q + 1n : q
  return sign(num) * magnitude
}

// 10% of whole cents.
const oracleGstCents = (cents) => halfAway(BigInt(cents), 10n)
// thousandths → whole cents.
const oracleCentsFromMills = (mills) => halfAway(BigInt(mills), 10n)

// A tiny deterministic generator — no Math.random, no dependency.
function lcg(seed) {
  let state = BigInt(seed)
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n)
    return state >> 11n
  }
}

const cents = (n) => Math.round(n * 100)

describe('the calculation version of a document', () => {
  it('absent, null and 1 are LEGACY; 2 is EXACT; the backend stamps EXACT', () => {
    expect(calcVersionOf({})).toBe(CALC_VERSION.LEGACY)
    expect(calcVersionOf({ calcVersion: null })).toBe(CALC_VERSION.LEGACY)
    expect(calcVersionOf({ calcVersion: 1 })).toBe(CALC_VERSION.LEGACY)
    expect(calcVersionOf({ calcVersion: 2 })).toBe(CALC_VERSION.EXACT)
    expect(calcVersionOf(null)).toBe(CALC_VERSION.LEGACY)
    expect(CURRENT_CALC_VERSION).toBe(2)
  })

  it('anything else is UNKNOWN — null, never a guess', () => {
    for (const v of [0, 3, 1.5, '2', '1', true, {}, [], NaN, -1]) {
      expect(calcVersionOf({ calcVersion: v }), String(v)).toBeNull()
      expect(isKnownCalcVersion(v), String(v)).toBe(false)
    }
  })

  it('every calculator refuses an unknown version', () => {
    for (const fn of [roundAmount, gstOnAmount, sumAmounts]) {
      expect(() => fn(fn === sumAmounts ? [1] : 1, 3)).toThrow(RangeError)
      expect(() => fn(fn === sumAmounts ? [1] : 1, null)).toThrow(RangeError)
    }
  })
})

describe('LEGACY (version 1) is the existing expression, unchanged', () => {
  it('equals roundMoney(x × GST_RATE) and both existing supplier gstForLine functions for every cent from -2,000.00 to 2,000.00', () => {
    let checked = 0
    for (let c = -200000; c <= 200000; c += 1) {
      const amount = c / 100
      const expected = roundMoney(amount * GST_RATE)
      const got = gstOnAmount(amount, CALC_VERSION.LEGACY)
      if (!Object.is(got, expected)) throw new Error(`legacy GST differs at ${amount}: ${got} vs ${expected}`)
      if (!Object.is(supplierInvoiceGstForLine(amount, 'gst'), expected)) throw new Error(`supplier invoice gstForLine moved at ${amount}`)
      if (!Object.is(variationGstForLine(amount, TAX_CODE.GST), expected)) throw new Error(`variation gstForLine moved at ${amount}`)
      checked += 1
    }
    expect(checked).toBe(400001)
  })

  it('is the default: omitting the version is the legacy policy', () => {
    for (const a of [40.15, -40.15, 803, 0.05, 1234.565]) {
      expect(Object.is(gstOnAmount(a), roundMoney(a * GST_RATE)), String(a)).toBe(true)
      expect(Object.is(roundAmount(a), roundMoney(a)), String(a)).toBe(true)
    }
    expect(sumAmounts([0.1, 0.2, 0.3])).toBe(roundMoney(0.1 + 0.2 + 0.3))
  })

  it('the recorded production values: 40.15 → 4.01, and the purchase-order header is untouched', () => {
    expect(gstOnAmount(40.15, 1)).toBe(4.01)
    expect(poTotals([{ lineTotal: 40.15 }])).toEqual({ subtotal: 40.15, gst: 4.01, total: 44.16 })
  })
})

describe('EXACT (version 2) — decimal half away from zero', () => {
  it('GST equals the integer oracle for every cent from -2,000.00 to 2,000.00', () => {
    for (let c = -200000; c <= 200000; c += 1) {
      const got = gstOnAmount(c / 100, CALC_VERSION.EXACT)
      const want = Number(oracleGstCents(c))
      if (cents(got) !== want || Object.is(got, -0)) throw new Error(`exact GST wrong at ${c} cents: ${got} vs ${want} cents`)
    }
  })

  it('GST equals the oracle on a spread up to the supported maximum, both signs', () => {
    const next = lcg(20261127)
    for (let i = 0; i < 20000; i += 1) {
      const magnitude = Number(next() % BigInt(MAX_SUPPORTED_AMOUNT_CENTS))
      for (const c of [magnitude, -magnitude]) {
        const got = gstOnAmount(c / 100, 2)
        if (cents(got) !== Number(oracleGstCents(c))) throw new Error(`exact GST wrong at ${c} cents`)
      }
    }
  })

  it('the named boundaries', () => {
    expect(gstOnAmount(40.15, 2)).toBe(4.02)
    expect(gstOnAmount(-40.15, 2)).toBe(-4.02)
    expect(gstOnAmount(803, 2)).toBe(80.3)
    expect(gstOnAmount(0.05, 2)).toBe(0.01)
    expect(gstOnAmount(-0.05, 2)).toBe(-0.01)
    expect(gstOnAmount(0.04, 2)).toBe(0)
    expect(Object.is(gstOnAmount(-0.04, 2), 0)).toBe(true)   // never -0
  })

  it('a figure and its reversal always cancel', () => {
    const next = lcg(7)
    for (let i = 0; i < 5000; i += 1) {
      const a = Number(next() % 10_000_000n) / 100
      expect(cents(gstOnAmount(a, 2)) + cents(gstOnAmount(-a, 2))).toBe(0)
      expect(cents(roundAmount(a, 2)) + cents(roundAmount(-a, 2))).toBe(0)
    }
  })
})

describe('rounding an entered amount to cents — decimal, sign-symmetric', () => {
  it('the architect’s examples', () => {
    expect(roundToCents(4.015)).toBe(402)
    expect(roundToCents(-4.015)).toBe(-402)
    expect(roundAmount(4.015, 2)).toBe(4.02)
    expect(roundAmount(-4.015, 2)).toBe(-4.02)
    expect(roundToCents(4.0149)).toBe(401)
    expect(roundToCents(-4.0149)).toBe(-401)
    expect(roundToCents(1.005)).toBe(101)     // the binary value is 1.00499999999999989…
    expect(roundToCents(0.004)).toBe(0)
    expect(Object.is(roundToCents(-0.004), 0)).toBe(true)
  })

  it('equals the integer oracle for every thousandth from -3,000.000 to 3,000.000', () => {
    for (let m = -3000000; m <= 3000000; m += 1) {
      const got = roundToCents(m / 1000)
      if (got !== Number(oracleCentsFromMills(m))) throw new Error(`rounding wrong at ${m} thousandths: ${got}`)
    }
  })

  it('equals the oracle for ten-thousandths on a spread, and a whole-cent amount is returned unchanged', () => {
    const next = lcg(99)
    for (let i = 0; i < 20000; i += 1) {
      const tenThousandths = next() % 100_000_000_000n
      for (const t of [tenThousandths, -tenThousandths]) {
        const got = roundToCents(Number(t) / 10000)
        if (got !== Number(halfAway(t, 100n))) throw new Error(`rounding wrong at ${t} ten-thousandths: ${got}`)
      }
      const c = Number(next() % BigInt(MAX_SUPPORTED_AMOUNT_CENTS))
      if (roundToCents(c / 100) !== c) throw new Error(`whole cents moved at ${c}`)
    }
  })

  it('LEGACY rounds the BINARY value of the double (4.015 → 4.01) — recorded, and left exactly as it is', () => {
    // 4.015 is stored as 4.01499999999999968…; `roundMoney` rounds that.
    expect(roundAmount(4.015, 1)).toBe(roundMoney(4.015))
    expect(roundAmount(-4.015, 1)).toBe(roundMoney(-4.015))
    expect({
      legacyPositive: roundAmount(4.015, 1), legacyNegative: roundAmount(-4.015, 1),
      exactPositive: roundAmount(4.015, 2), exactNegative: roundAmount(-4.015, 2),
    }).toMatchInlineSnapshot(`
      {
        "exactNegative": -4.02,
        "exactPositive": 4.02,
        "legacyNegative": -4.01,
        "legacyPositive": 4.01,
      }
    `)
  })

  it('refuses what it cannot represent: not a number, not finite, beyond the supported range', () => {
    for (const bad of [NaN, Infinity, -Infinity, '4.01', null, undefined, 1e15, -1e15, 1e21, (MAX_SUPPORTED_AMOUNT_CENTS + 1) / 100]) {
      expect(roundToCents(bad), String(bad)).toBeNull()
    }
    expect(roundToCents(MAX_SUPPORTED_AMOUNT_CENTS / 100)).toBe(MAX_SUPPORTED_AMOUNT_CENTS)
    expect(roundToCents(-MAX_SUPPORTED_AMOUNT_CENTS / 100)).toBe(-MAX_SUPPORTED_AMOUNT_CENTS)
    expect(roundToCents(1e-9)).toBe(0)
    expect(roundAmount(1e15, 2)).toBeNull()
    expect(gstOnAmount(1e15, 2)).toBeNull()
  })

  it('isSupportedAmount: a finite two-decimal number inside the range', () => {
    expect(isSupportedAmount(40.15)).toBe(true)
    expect(isSupportedAmount(-40.15)).toBe(true)
    expect(isSupportedAmount(0)).toBe(true)
    expect(isSupportedAmount(40.155)).toBe(false)
    expect(isSupportedAmount('40.15')).toBe(false)
    expect(isSupportedAmount(NaN)).toBe(false)
    expect(isSupportedAmount(1e15)).toBe(false)
  })
})

describe('a quantity × rate product is exact before it is rounded', () => {
  it('neither factor is rounded to two decimals first', () => {
    expect(productToCents(3, 33.335)).toBe(10001)       // 100.005 → 100.01
    expect(productToCents(-3, 33.335)).toBe(-10001)
    expect(productToCents(0.333, 100.1)).toBe(3333)     // 33.3333
    expect(productToCents(1.005, 1000)).toBe(100500)    // float gives 1004.9999999999999
    expect(productToCents(2.5, 0.01)).toBe(3)           // 0.025 → 0.03
    expect(productToCents(-2.5, 0.01)).toBe(-3)
    expect(productToCents(0, 123.45)).toBe(0)
    expect(Object.is(productToCents(-0.001, 0.001), 0)).toBe(true)
  })

  it('equals the integer oracle: thousandths of a quantity × ten-thousandths of a rate, both signs', () => {
    const next = lcg(424242)
    for (let i = 0; i < 40000; i += 1) {
      const q = next() % 10_000_000n          // up to 9,999.999
      const r = next() % 1_000_000_000n       // up to 99,999.9999
      const flip = (next() % 2n) === 0n ? 1n : -1n
      // (q / 10^3) × (r / 10^4) in cents = q × r / 10^5
      const want = Number(halfAway(flip * q * r, 100000n))
      const got = productToCents(Number(flip * q) / 1000, Number(r) / 10000)
      if (got !== want) throw new Error(`product wrong: ${flip * q}/1000 × ${r}/10000 → ${got}, want ${want}`)
    }
  })

  it('refuses a non-finite factor and a product beyond the supported range', () => {
    expect(productToCents(NaN, 1)).toBeNull()
    expect(productToCents(1, Infinity)).toBeNull()
    expect(productToCents(1e9, 1e9)).toBeNull()
  })
})

describe('where the two policies differ — counted', () => {
  it('positive amounts: only on a half-cent boundary, LEGACY exactly one cent lower, never higher', () => {
    let boundaries = 0
    let differing = 0
    for (let c = 0; c <= 2_000_000; c += 1) {
      const legacy = cents(gstOnAmount(c / 100, 1))
      const exact = cents(gstOnAmount(c / 100, 2))
      if (c % 10 === 5) boundaries += 1
      if (legacy === exact) continue
      differing += 1
      if (c % 10 !== 5) throw new Error(`policies differ OFF a boundary at ${c} cents`)
      if (exact - legacy !== 1) throw new Error(`difference is not exactly one cent at ${c} cents`)
    }
    expect(boundaries).toBe(200000)
    expect(differing).toBeGreaterThan(0)
    expect(differing).toBeLessThan(boundaries)
    // Recorded so a change in either policy is visible.
    expect({ boundaries, differing }).toMatchInlineSnapshot(`
      {
        "boundaries": 200000,
        "differing": 3271,
      }
    `)
  })

  it('negative amounts: only on a half-cent boundary; the legacy figure is one cent toward zero', () => {
    let differing = 0
    for (let c = -2_000_000; c < 0; c += 1) {
      const legacy = cents(gstOnAmount(c / 100, 1))
      const exact = cents(gstOnAmount(c / 100, 2))
      if (legacy === exact) continue
      differing += 1
      if (-c % 10 !== 5) throw new Error(`policies differ OFF a boundary at ${c} cents`)
      if (legacy - exact !== 1) throw new Error(`difference is not exactly one cent toward zero at ${c} cents`)
    }
    expect({ differing }).toMatchInlineSnapshot(`
      {
        "differing": 135768,
      }
    `)
  })

  it('the recorded signed examples', () => {
    expect({
      legacyPositive: gstOnAmount(40.15, 1), exactPositive: gstOnAmount(40.15, 2),
      legacyNegative: gstOnAmount(-40.15, 1), exactNegative: gstOnAmount(-40.15, 2),
    }).toMatchInlineSnapshot(`
      {
        "exactNegative": -4.02,
        "exactPositive": 4.02,
        "legacyNegative": -4.01,
        "legacyPositive": 4.01,
      }
    `)
  })
})

describe('sums', () => {
  it('EXACT sums whole cents as integers; both policies agree on two-decimal inputs', () => {
    const next = lcg(5)
    for (let i = 0; i < 300; i += 1) {
      const values = Array.from({ length: 200 }, () => (Number(next() % 2_000_000_000n) - 1_000_000_000) / 100)
      const want = values.reduce((s, v) => s + BigInt(cents(v)), 0n)
      expect(BigInt(cents(sumAmounts(values, 2)))).toBe(want)
      expect(BigInt(cents(sumAmounts(values, 1)))).toBe(want)
    }
    expect(sumAmounts([], 2)).toBe(0)
    expect(sumAmounts(null, 2)).toBe(0)
  })
})
