import { describe, it, expect } from 'vitest'
import * as money from '../../src/lib/money'
import {
  toCents, fromCents, isWholeCents,
  gstOfCents, gstExact, shareOfCents, shareStep,
} from '../../src/lib/money'
import { gstForLine as clientGstForLine, TAX_CODE } from '../../src/lib/clientInvoices'
import { gstForLine as supplierGstForLine } from '../../src/lib/supplierInvoices'

// ── Exact money arithmetic (ADR-86) — pure domain tests ──────────────────────
//
// Every expectation below comes from an INDEPENDENT ORACLE that uses neither
// src/lib/money.js nor floating point: decimal amounts are STRINGS, parsed to
// BigInt whole cents, and every rounding is decimal round-half-up done with
// BigInt quotient and remainder.
//
// The load-bearing properties:
//   1. GST IS EXACT. gstOfCents / gstExact equal decimal round-half-up for
//      every cent amount to 100,000.00 and a spread up to 10,000,000,000.00.
//   2. CENTS ROUND-TRIP. toCents(fromCents(c)) === c and fromCents(toCents(x))
//      is the double a decimal literal produces.
//   3. SHARES ARE EXACT AT ANY SIZE, including products far beyond 2^53. There
//      is NO upper limit: the former 20,000,000.00 cap no longer exists.
//   4. SHARES TELESCOPE. shareStep over any split sums EXACTLY to the total.
//   5. THE PAYABLE SIDE IS UNCHANGED — the supplier gstForLine is pinned.

// ── The oracle (strings + BigInt only) ───────────────────────────────────────

// "40.15" → 4015n, "-0.05" → -5n, "7" → 700n, "7.5" → 750n.
function parseCents(text) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!m) throw new Error(`not a two-decimal amount: ${text}`)
  const magnitude = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] === '-' ? -magnitude : magnitude
}

// 4015n → "40.15".
function centsText(cents) {
  const sign = cents < 0n ? '-' : ''
  const magnitude = cents < 0n ? -cents : cents
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`
}

// Decimal round-half-up of num ÷ den for non-negative num, positive den.
function halfUp(num, den) {
  const q = num / den
  const r = num % den
  return r * 2n >= den ? q + 1n : q
}

// 10% GST on whole cents: half away from zero.
const oracleGst = (cents) => (cents < 0n ? -halfUp(-cents, 10n) : halfUp(cents, 10n))

// round-half-up(total × part ÷ whole).
const oracleShare = (total, part, whole) =>
  (whole <= 0n || part <= 0n || total <= 0n ? 0n : halfUp(total * part, whole))

// A tiny deterministic generator — no Math.random, no dependency.
function lcg(seed) {
  let state = BigInt(seed)
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn
    return Number(state >> 33n) // 31 bits
  }
}
const below = (next, n) => next() % n

describe('the oracle itself', () => {
  it('parses and prints two-decimal strings', () => {
    expect(parseCents('40.15')).toBe(4015n)
    expect(parseCents('7')).toBe(700n)
    expect(parseCents('7.5')).toBe(750n)
    expect(parseCents('-0.05')).toBe(-5n)
    expect(centsText(4015n)).toBe('40.15')
    expect(centsText(-5n)).toBe('-0.05')
    expect(centsText(200000000000n)).toBe('2000000000.00')
  })

  it('rounds half up', () => {
    expect(halfUp(4015n, 10n)).toBe(402n) // 401.5 → 402
    expect(halfUp(4014n, 10n)).toBe(401n)
    expect(halfUp(1n, 2n)).toBe(1n)
    expect(halfUp(0n, 7n)).toBe(0n)
  })
})

// ── GST ──────────────────────────────────────────────────────────────────────

describe('gstOfCents / gstExact — known boundaries', () => {
  const cases = [
    ['40.15', '4.02'], ['41.05', '4.11'], ['80.85', '8.09'],
    ['0.05', '0.01'], ['0.04', '0.00'], ['0.00', '0.00'],
    ['0.15', '0.02'], ['1.25', '0.13'], ['1.24', '0.12'],
    ['100.00', '10.00'], ['99999.95', '10000.00'], ['20000000.00', '2000000.00'],
    ['250000000.00', '25000000.00'], ['9999999999.99', '1000000000.00'], ['9999999999.94', '999999999.99'],
  ]
  it.each(cases)('GST on %s is %s', (amount, gst) => {
    // The oracle agrees with the hand-written expectation first.
    expect(centsText(oracleGst(parseCents(amount)))).toBe(gst)
    expect(gstOfCents(Number(parseCents(amount)))).toBe(Number(parseCents(gst)))
    expect(gstExact(Number(amount))).toBe(Number(gst))
  })

  it.each(cases)('the negative of %s mirrors it (-%s)', (amount, gst) => {
    const cents = Number(parseCents(amount))
    expect(gstOfCents(-cents)).toBe(0 - Number(parseCents(gst)))
    expect(gstOfCents(-cents) + gstOfCents(cents)).toBe(0)
    expect(gstExact(-Number(amount)) + gstExact(Number(amount))).toBe(0)
  })

  it('a negative amount whose GST rounds to nothing yields plain zero, never negative zero', () => {
    for (const cents of [-1, -2, -3, -4]) {
      expect(gstOfCents(cents)).toBe(0) // Object.is: +0, not -0
      expect(Object.is(gstOfCents(cents), -0)).toBe(false)
      expect(gstOfCents(cents) + gstOfCents(-cents)).toBe(0)
    }
    expect(gstOfCents(0)).toBe(0)
    expect(gstOfCents(-5)).toBe(-1)
    expect(gstExact(-0.04)).toBe(0)
  })

  it('differs from the legacy float product exactly where that product is wrong', () => {
    const legacy = (x) => Math.round((x * 0.1 + Number.EPSILON) * 100) / 100
    expect(legacy(40.15)).toBe(4.01)
    expect(gstExact(40.15)).toBe(4.02)
  })
})

describe('gstOfCents / gstExact / toCents / fromCents — exhaustive sweep', () => {
  it('every cent amount from 0.00 to 100,000.00 equals the oracle and round-trips', () => {
    const failures = []
    let cents = 0n
    for (let i = 0; i <= 10_000_000; i += 1, cents += 1n) {
      const whole = (i - (i % 100)) / 100
      const frac = i % 100
      const text = `${whole}.${frac < 10 ? '0' : ''}${frac}`
      const amount = Number(text) // the double a decimal literal produces
      const expectedGst = oracleGst(cents)

      if (toCents(amount) !== i) failures.push(`toCents(${text}) = ${toCents(amount)}`)
      else if (fromCents(i) !== amount) failures.push(`fromCents(${i}) = ${fromCents(i)}`)
      else if (BigInt(gstOfCents(i)) !== expectedGst) failures.push(`gstOfCents(${i}) = ${gstOfCents(i)}, oracle ${expectedGst}`)
      else if (gstExact(amount) !== Number(centsText(expectedGst))) failures.push(`gstExact(${text}) = ${gstExact(amount)}`)
      else if (gstOfCents(-i) + gstOfCents(i) !== 0) failures.push(`gstOfCents(-${i}) does not mirror`)
      if (failures.length > 10) break
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('the oracle string for a sampled set parses back to the same cents (the sweep reads real decimals)', () => {
    for (const i of [0, 1, 5, 99, 100, 4015, 4105, 8085, 9_999_999, 10_000_000]) {
      expect(parseCents(centsText(BigInt(i)))).toBe(BigInt(i))
      expect(toCents(Number(centsText(BigInt(i))))).toBe(i)
    }
  })

  it('a spread of large values up to 10,000,000,000.00 equals the oracle and round-trips', () => {
    const next = lcg(20261126)
    const samples = []
    // Every last-digit pattern just under 20,000,000.00 (the former cap),
    // 250,000,000.00 and 10,000,000,000.00.
    for (const top of [2_000_000_000n, 25_000_000_000n, 1_000_000_000_000n]) {
      for (let d = 0n; d < 200n; d += 1n) samples.push(top - d)
    }
    // Strides across the range to 20,000,000.00, landing on every last digit…
    for (let c = 10_000_000n; c <= 2_000_000_000n; c += 999_983n) samples.push(c)
    // …and across the range to 10,000,000,000.00.
    for (let c = 2_000_000_000n; c <= 1_000_000_000_000n; c += 499_999_993n) samples.push(c)
    for (let n = 0; n < 25_000; n += 1) samples.push(BigInt(below(next, 2_000_000_001)))
    for (let n = 0; n < 25_000; n += 1) samples.push(BigInt(below(next, 1_000_000_000)) * 1000n + BigInt(below(next, 1000)))

    const failures = []
    for (const cents of samples) {
      const text = centsText(cents)
      const amount = Number(text)
      const i = Number(cents)
      const expectedGst = oracleGst(cents)
      if (toCents(amount) !== i) failures.push(`toCents(${text}) = ${toCents(amount)}`)
      if (fromCents(i) !== amount) failures.push(`fromCents(${i}) = ${fromCents(i)}`)
      if (BigInt(gstOfCents(i)) !== expectedGst) failures.push(`gstOfCents(${i})`)
      if (gstExact(amount) !== Number(centsText(expectedGst))) failures.push(`gstExact(${text})`)
      if (gstOfCents(-i) !== -Number(expectedGst)) failures.push(`gstOfCents(-${i})`)
    }
    expect(failures).toEqual([])
  })

  it('named large amounts round-trip (to 10,000,000,000.00)', () => {
    const failures = []
    for (const text of ['20000000.01', '99999999.99', '123456789.05', '250000000.00', '1000000000.15', '9999999999.95', '9999999999.99', '10000000000.00']) {
      const cents = parseCents(text)
      if (BigInt(toCents(Number(text))) !== cents) failures.push(text)
      if (fromCents(Number(cents)) !== Number(text)) failures.push(text)
      if (BigInt(gstOfCents(Number(cents))) !== oracleGst(cents)) failures.push(text)
    }
    expect(failures).toEqual([])
  })
})

describe('toCents', () => {
  it('accepts numeric strings and negative amounts', () => {
    expect(toCents('40.15')).toBe(4015)
    expect(toCents(-40.15)).toBe(-4015)
    expect(toCents('-0.05')).toBe(-5)
    expect(toCents(0)).toBe(0)
  })

  it('reads anything that is not a finite number as zero', () => {
    for (const junk of [undefined, NaN, Infinity, -Infinity, 'abc', {}, [1, 2]]) {
      expect(toCents(junk)).toBe(0)
    }
    // Number(null) and Number('') are 0 — finite, so zero cents either way.
    expect(toCents(null)).toBe(0)
    expect(toCents('')).toBe(0)
  })

  it('removes the classic float sum crumb', () => {
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(fromCents(toCents(0.1 + 0.2))).toBe(0.3)
  })
})

describe('isWholeCents', () => {
  it('is true for finite two-decimal numbers', () => {
    for (const ok of [0, 1, 40.15, 41.05, 0.01, -0.05, 20000000, 99999.99, 1e9]) {
      expect(isWholeCents(ok)).toBe(true)
    }
  })

  it('is false for a fraction of a cent', () => {
    for (const bad of [40.155, 0.001, 0.005, 1.999, 0.1 + 0.2, 1 / 3, -0.015]) {
      expect(isWholeCents(bad)).toBe(false)
    }
  })

  it('is false for anything that is not a finite number', () => {
    for (const bad of ['40.15', '1', null, undefined, NaN, Infinity, -Infinity, {}, [], true]) {
      expect(isWholeCents(bad)).toBe(false)
    }
  })
})

// ── Shares ───────────────────────────────────────────────────────────────────

describe('shareOfCents', () => {
  it('equals the oracle over a small exhaustive grid (every half-way case included)', () => {
    const failures = []
    for (let whole = 1; whole <= 24; whole += 1) {
      for (let part = 0; part <= whole; part += 1) {
        for (let total = 0; total <= 30; total += 1) {
          const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
          if (BigInt(shareOfCents(total, part, whole)) !== expected) {
            failures.push(`share(${total}, ${part}, ${whole}) = ${shareOfCents(total, part, whole)}, oracle ${expected}`)
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('rounds exact halves UP', () => {
    expect(shareOfCents(1, 1, 2)).toBe(1)     // 0.5 → 1
    expect(shareOfCents(5, 1, 2)).toBe(3)     // 2.5 → 3
    expect(shareOfCents(5, 5, 10)).toBe(3)    // 2.5 → 3
    expect(shareOfCents(3, 1, 6)).toBe(1)     // 0.5 → 1
    expect(shareOfCents(1, 1, 3)).toBe(0)     // 0.33 → 0
    expect(shareOfCents(2, 1, 3)).toBe(1)     // 0.67 → 1
    expect(shareOfCents(402, 2007, 4015)).toBe(201) // 200.95 → 201
  })

  it('returns the whole total when part is the whole, and zero for nothing', () => {
    expect(shareOfCents(402, 4015, 4015)).toBe(402)
    expect(shareOfCents(402, 0, 4015)).toBe(0)
    expect(shareOfCents(0, 10, 4015)).toBe(0)
    expect(shareOfCents(402, 10, 0)).toBe(0)
    expect(shareOfCents(-402, 10, 100)).toBe(0)
    expect(shareOfCents(402, -10, 100)).toBe(0)
    expect(shareOfCents(402, 10, -100)).toBe(0)
  })

  it('refuses anything that is not whole cents', () => {
    expect(() => shareOfCents(1.5, 1, 2)).toThrow(TypeError)
    expect(() => shareOfCents(1, 0.5, 2)).toThrow(TypeError)
    expect(() => shareOfCents(1, 1, 2.5)).toThrow(TypeError)
    expect(() => shareOfCents('10', 1, 2)).toThrow(TypeError)
    expect(() => shareOfCents(NaN, 1, 2)).toThrow(TypeError)
    expect(() => shareOfCents(10, 1, undefined)).toThrow('shareOfCents takes whole cents')
  })

  it('the Rules-driven retention cap is gone: MAX_SHARE_BASIS_CENTS is not exported; the only limit is the documented supported range', () => {
    expect(money).not.toHaveProperty('MAX_SHARE_BASIS_CENTS')
    expect(Object.keys(money).sort()).toEqual(
      ['MAX_SUPPORTED_AMOUNT_CENTS', 'MAX_SUPPORTED_AMOUNT_TEXT', 'MAX_SUPPORTED_RECEIPT_CENTS', 'fromCents', 'gstExact', 'gstOfCents', 'isWholeCents', 'shareOfCents', 'shareStep', 'toCents'])
  })

  it('is exact around 20,000,000.00 (the former cap), where the product already exceeds 2^53', () => {
    const M = 2_000_000_000
    // A float product would already be inexact here.
    expect(BigInt(M) * BigInt(M - 1) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)

    const grid = [1, 2, 3, 5, 7, 999_999_999, 1_000_000_000, 1_000_000_001, M - 3, M - 2, M - 1, M]
    const failures = []
    for (const total of grid) {
      for (const whole of grid) {
        for (const part of grid) {
          if (part > whole) continue
          const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
          if (BigInt(shareOfCents(total, part, whole)) !== expected) {
            failures.push(`share(${total}, ${part}, ${whole})`)
          }
        }
      }
    }
    expect(failures).toEqual([])

    // Hand-checked: (M−1)² ÷ M = M − 2 + 1/M → M − 2.
    expect(shareOfCents(M - 1, M - 1, M)).toBe(M - 2)
    // An exact half at full size: M × 1 ÷ 2 with an odd total.
    expect(shareOfCents(M - 1, 1, 2)).toBe(M / 2)
    expect(shareOfCents(M - 1, M / 2, M)).toBe(M / 2) // (M−1)/2 = 999,999,999.5 → up
  })

  // The three invoice sizes of the large-invoice ledger tests: 250,000,000.00,
  // 9,999,999,999.99 and their GST, with awkward parts.
  it('is exact on a grid around 250,000,000.00 and 9,999,999,999.99', () => {
    const A = 25_000_000_000          // 250,000,000.00
    const B = 999_999_999_999         // 9,999,999,999.99
    const grid = [1, 2, 3, 7, 4015, A / 10, A - 1, A, A + 1, 100_000_000_000, B - 2, B - 1, B]
    expect(BigInt(B) * BigInt(B - 1) > 10n ** 23n).toBe(true)
    const failures = []
    for (const total of grid) {
      for (const whole of grid) {
        for (const part of grid) {
          if (part > whole) continue
          const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
          if (BigInt(shareOfCents(total, part, whole)) !== expected) failures.push(`share(${total}, ${part}, ${whole})`)
        }
      }
    }
    expect(failures).toEqual([])

    // Hand-checked. 5% of 9,999,999,999.99 = 499,999,999.9995 → 500,000,000.00.
    expect(shareOfCents(B, 500, 10000)).toBe(50_000_000_000)
    // GST 1,000,000,000.00 on 9,999,999,999.99, retained 500,000,000.00:
    // 1e11 × 5e10 ÷ 999,999,999,999 = 5,000,000,000.000005 → 5,000,000,000 cents.
    expect(shareOfCents(100_000_000_000, 50_000_000_000, B)).toBe(5_000_000_000)
    // (B−1)² ÷ B = B − 2 + 1/B → B − 2.
    expect(shareOfCents(B - 1, B - 1, B)).toBe(B - 2)
    // An exact half at full size: B is odd, so B ÷ 2 = …999.5 → up.
    expect(shareOfCents(B, 1, 2)).toBe(500_000_000_000)
  })

  it('stays exact up to 2^53 − 1 (exact at any size the arguments can state)', () => {
    const big = 9_007_199_254_740_991 // 2^53 − 1
    for (const [total, part, whole] of [
      [big, big - 1, big],
      [big, 1, 2],
      [4_000_000_000_000, 3_999_999_999_999, 4_000_000_000_000],
      [123_456_789_012_345, 987_654_321, 1_000_000_007],
    ]) {
      const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
      // Only comparable when the answer is itself a safe integer.
      expect(expected <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
      expect(BigInt(shareOfCents(total, part, whole))).toBe(expected)
    }
  })

  it('equals the oracle for 20,000 random triples up to 20,000,000.00', () => {
    const next = lcg(87)
    const failures = []
    for (let n = 0; n < 20_000; n += 1) {
      const whole = 1 + below(next, 2_000_000_000)
      const part = below(next, whole + 1)
      const total = below(next, 2_000_000_001)
      const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
      if (BigInt(shareOfCents(total, part, whole)) !== expected) failures.push(`share(${total}, ${part}, ${whole})`)
    }
    expect(failures).toEqual([])
  })

  it('equals the oracle for 20,000 random triples up to 20,000,000,000.00', () => {
    const next = lcg(88)
    // 31 random bits × 1000 + 3 more digits: any whole-cent figure to 2.1 × 10^12.
    const wide = () => below(next, 2_000_000_000) * 1000 + below(next, 1000)
    const failures = []
    for (let n = 0; n < 20_000; n += 1) {
      const whole = 1 + wide()
      const part = Number(BigInt(wide()) % BigInt(whole + 1))
      const total = wide()
      const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
      if (BigInt(shareOfCents(total, part, whole)) !== expected) failures.push(`share(${total}, ${part}, ${whole})`)
    }
    expect(failures).toEqual([])
  })

  it('is monotonic in the part, and never exceeds the total', () => {
    const next = lcg(5)
    for (let n = 0; n < 300; n += 1) {
      const whole = 1 + below(next, 5000)
      const total = below(next, 5000)
      let previous = 0
      for (let part = 0; part <= whole; part += 1 + below(next, 40)) {
        const share = shareOfCents(total, part, whole)
        expect(share).toBeGreaterThanOrEqual(previous)
        expect(share).toBeLessThanOrEqual(total)
        previous = share
      }
    }
  })
})

describe('shareStep — telescoping', () => {
  // A uniform-enough draw below n for n beyond 31 bits (two draws, 62 bits).
  const wideBelow = (next, n) => Number((BigInt(next()) * 2147483648n + BigInt(next())) % BigInt(n))

  // Splits `whole` into n non-negative parts that sum to it exactly.
  function randomSplit(next, whole, n) {
    const cuts = []
    for (let i = 0; i < n - 1; i += 1) cuts.push(wideBelow(next, whole + 1))
    cuts.sort((a, b) => a - b)
    const parts = []
    let previous = 0
    for (const cut of cuts) { parts.push(cut - previous); previous = cut }
    parts.push(whole - previous)
    return parts
  }

  it.each([1, 2, 3, 7, 50])('a split into %i parts sums EXACTLY to the total and never goes negative', (n) => {
    const next = lcg(1000 + n)
    for (let round = 0; round < 400; round += 1) {
      // Small wholes, wholes to 20,000,000.00, and wholes to 20,000,000,000.00.
      const whole = round % 4 === 0 ? 1 + below(next, 2_000_000_000)
        : round % 4 === 1 ? 1 + below(next, 2_000_000_000) * 1000 + below(next, 1000)
          : 1 + below(next, 500_000)
      // Totals below, equal to and above the whole.
      const total = round % 3 === 0 ? wideBelow(next, whole + 1) : wideBelow(next, 2 * whole + 1)
      const parts = randomSplit(next, whole, n)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(whole)

      let cumulativePart = 0
      let shared = 0
      for (const part of parts) {
        cumulativePart += part
        const step = shareStep(total, cumulativePart, whole, shared)
        expect(step).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(step)).toBe(true)
        shared += step
        expect(shared).toBeLessThanOrEqual(total)
        // Each cumulative figure is the oracle's cumulative share.
        const oracleShared = cumulativePart >= whole
          ? BigInt(total)
          : oracleShare(BigInt(total), BigInt(cumulativePart), BigInt(whole))
        expect(BigInt(shared)).toBe(oracleShared)
      }
      expect(shared).toBe(total)
    }
  })

  it('the final step is the explicit remainder, whatever was shared before', () => {
    // 4.01 of GST over 40.15, where earlier steps were (wrongly) under-shared.
    expect(shareStep(401, 4015, 4015, 0)).toBe(401)
    expect(shareStep(401, 4015, 4015, 400)).toBe(1)
    expect(shareStep(401, 4015, 4015, 401)).toBe(0)
    // A part beyond the whole is still "all of it".
    expect(shareStep(401, 9999, 4015, 100)).toBe(301)
  })

  it('never steps backwards and never adds more than is left', () => {
    // Already ahead of the cumulative target (e.g. after an out-of-order void).
    expect(shareStep(402, 2007, 4015, 300)).toBe(0)
    expect(shareStep(402, 4015, 4015, 500)).toBe(0)
    // A zero whole is "all of it" (partAfter ≥ whole).
    expect(shareStep(10, 0, 0, 0)).toBe(10)
  })

  it('pieces of one cent each over a boundary line still sum exactly', () => {
    let shared = 0
    for (let part = 1; part <= 4015; part += 1) shared += shareStep(402, part, 4015, shared)
    expect(shared).toBe(402)
  })
})

// ── The supported monetary range ─────────────────────────────────────────────
//
// SUPPORTED MAXIMUM PER INVOICE: 999,999,999,999.99 (ex-GST subtotal) — below
// 10^12, the bound Firestore Rules already use for budget adjustments.
//
// What limits the range is NOT the cent arithmetic (integers, exact to
// 2^53 − 1 cents = 90,071,992,547,409.91) but the DOLLAR amounts documents
// store, which are IEEE doubles: `toCents(x) = Math.round(x × 100)` is exact
// only while the double nearest a two-decimal amount, times 100, still rounds
// to the right integer. Measured below: every tested amount round-trips up to
// 10^13 (and up to 2^45 = 35,184,372,088,832.00); the first failure is
// 35,184,372,088,832.02. The supported maximum sits 35 times below that, so an
// invoice's gross (1.1 ×) and the sum of dozens of maximum invoices stay exact.
//
// Storage (documented Firestore behaviour, stated, not testable here): an
// integer field is a 64-bit signed integer, so whole cents up to 2^53 − 1
// written from JavaScript are stored exactly; a non-integer number is a 64-bit
// IEEE double — the same double JavaScript holds.

describe('the supported monetary range', () => {
  const MAX_TEXT = '999999999999.99'
  const MAX_CENTS = 99_999_999_999_999

  // Every one of the 100 cent values of a dollar figure, through every
  // conversion the receivables chain uses. Returns the cents that FAIL.
  function failingCents(dollars) {
    const failures = []
    for (let k = 0n; k < 100n; k += 1n) {
      const exact = dollars * 100n + k
      const text = centsText(exact)
      const amount = Number(text)
      const ok = BigInt(toCents(amount)) === exact       // dollars → cents
        && fromCents(Number(exact)) === amount           // cents → the same double
        && amount.toFixed(2) === text                    // prints back
        && isWholeCents(amount)
        && BigInt(gstOfCents(Number(exact))) === oracleGst(exact)
      if (!ok) failures.push(String(k).padStart(2, '0'))
    }
    return failures
  }

  it('the maximum itself: 999,999,999,999.99 is 99,999,999,999,999 cents, exactly, both ways', () => {
    expect(toCents(Number(MAX_TEXT))).toBe(MAX_CENTS)
    expect(toCents(MAX_TEXT)).toBe(MAX_CENTS)
    expect(fromCents(MAX_CENTS)).toBe(999999999999.99)
    expect(fromCents(MAX_CENTS).toFixed(2)).toBe(MAX_TEXT)
    expect(isWholeCents(999999999999.99)).toBe(true)
    expect(isWholeCents(999999999999.995)).toBe(false)
    expect(gstOfCents(MAX_CENTS)).toBe(10_000_000_000_000)        // 9,999,999,999,999.9 → up
    expect(gstExact(999999999999.99)).toBe(100000000000)
    expect(gstOfCents(MAX_CENTS - 5)).toBe(9_999_999_999_999)     // …999.4 → down
    expect(BigInt(gstOfCents(MAX_CENTS))).toBe(oracleGst(BigInt(MAX_CENTS)))
  })

  it.each([
    ['10^11', 100_000_000_000n], ['10^12', 1_000_000_000_000n], ['10^13', 10_000_000_000_000n],
  ])('every cent value round-trips just below, at and just above %s dollars', (_label, power) => {
    for (const dollars of [power - 2n, power - 1n, power, power + 1n, power + 123_456_789n]) {
      expect(failingCents(dollars)).toEqual([])
    }
  })

  it('the adversarial cents .01 .29 .57 .99 round-trip at every power of ten to 10^13', () => {
    const failures = []
    for (let exponent = 0n; exponent <= 13n; exponent += 1n) {
      for (const dollars of [10n ** exponent - 1n, 10n ** exponent, 3n * 10n ** exponent + 7n]) {
        for (const k of [1n, 29n, 57n, 99n]) {
          const exact = dollars * 100n + k
          const text = centsText(exact)
          if (BigInt(toCents(Number(text))) !== exact || fromCents(Number(exact)) !== Number(text)) failures.push(text)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('200,000 random amounts up to 10^13 dollars all round-trip, with exact GST', () => {
    const next = lcg(1013)
    const failures = []
    for (let n = 0; n < 200_000; n += 1) {
      // 62 random bits reduced below 10^15 cents.
      const exact = (BigInt(next()) * 2147483648n + BigInt(next())) % 1_000_000_000_000_000n
      const text = centsText(exact)
      const amount = Number(text)
      if (BigInt(toCents(amount)) !== exact || fromCents(Number(exact)) !== amount
        || BigInt(gstOfCents(Number(exact))) !== oracleGst(exact)) failures.push(text)
      if (failures.length > 5) break
    }
    expect(failures).toEqual([])
  })

  it('WHERE IT FIRST FAILS: 35,184,372,088,832.02 (2^45 dollars) — far above the supported maximum', () => {
    const edge = 2n ** 45n // 35,184,372,088,832
    // Everything just below 2^45 dollars is still exact…
    for (const dollars of [edge - 1n, edge - 2n, edge - 1000n, 20_000_000_000_000n, 30_000_000_000_000n]) {
      expect(failingCents(dollars)).toEqual([])
    }
    // …and at 2^45 the doubles are 1/128 apart: 16 of the 100 cent values no
    // longer convert, the first being .02.
    const failing = failingCents(edge)
    expect(failing).toHaveLength(16)
    expect(failing[0]).toBe('02')
    expect(toCents(Number('35184372088832.02'))).not.toBe(3518437208883202)
    expect(toCents(Number('35184372088832.01'))).toBe(3518437208883201)
    // The failure is in the DOLLAR double, not in the cents: as integers the
    // same figures are exact.
    expect(Number.isSafeInteger(3518437208883202)).toBe(true)
    expect(fromCents(3518437208883202).toFixed(2)).toBe('35184372088832.02')
    // The supported maximum is 35 times below the edge.
    expect(edge / 1_000_000_000_000n).toBe(35n)
  })

  it('shareOfCents is exact at 10^13, 10^14 and 10^15 cents (BigInt products to 10^30)', () => {
    const grid = [
      1, 7, 4015, 10 ** 13 - 1, 10 ** 13, 10 ** 13 + 1,
      MAX_CENTS - 1, MAX_CENTS, 10 ** 14, 10 ** 14 + 1, 10 ** 15 - 1, 10 ** 15,
    ]
    const failures = []
    for (const total of grid) {
      for (const whole of grid) {
        for (const part of grid) {
          if (part > whole) continue
          const expected = oracleShare(BigInt(total), BigInt(part), BigInt(whole))
          if (BigInt(shareOfCents(total, part, whole)) !== expected) failures.push(`share(${total}, ${part}, ${whole})`)
        }
      }
    }
    expect(failures).toEqual([])
    // Retention GST of the maximum invoice with everything but a cent retained:
    // 10^13 × (MAX − 1) ÷ MAX = 10^13 − 0.1000…  → 9,999,999,999,999.9 → 10^13.
    expect(shareOfCents(10_000_000_000_000, MAX_CENTS - 1, MAX_CENTS)).toBe(10_000_000_000_000)
    expect(shareOfCents(MAX_CENTS, 500, 10000)).toBe(5_000_000_000_000) // 5%: …999.95 → up
  })

  it('shareStep still telescopes exactly at the maximum', () => {
    const next = lcg(77)
    for (let round = 0; round < 200; round += 1) {
      const total = Number((BigInt(next()) * 2147483648n + BigInt(next())) % BigInt(MAX_CENTS + 1))
      let shared = 0
      let part = 0
      while (part < MAX_CENTS) {
        part = Math.min(MAX_CENTS, part + 1 + Number((BigInt(next()) * 2147483648n + BigInt(next())) % 30_000_000_000_000n))
        const step = shareStep(total, part, MAX_CENTS, shared)
        expect(step).toBeGreaterThanOrEqual(0)
        shared += step
        const expected = part >= MAX_CENTS ? BigInt(total) : oracleShare(BigInt(total), BigInt(part), BigInt(MAX_CENTS))
        expect(BigInt(shared)).toBe(expected)
      }
      expect(shared).toBe(total)
    }
  })

  it('ledger totals stay safe integers: one maximum invoice, and eighty of them summed', () => {
    const gross = MAX_CENTS + gstOfCents(MAX_CENTS) // 1,099,999,999,999.99
    expect(gross).toBe(109_999_999_999_999)
    expect(Number.isSafeInteger(gross)).toBe(true)
    // Every ledger total of one invoice is at most its gross.
    expect(gross < Number.MAX_SAFE_INTEGER / 80).toBe(true)
    let sum = 0
    for (let n = 0; n < 80; n += 1) sum += gross
    expect(Number.isSafeInteger(sum)).toBe(true)
    expect(BigInt(sum)).toBe(80n * BigInt(gross))
    // In DOLLARS a running total is exact only below 2^45: 31 maximum invoices
    // gross (34.1 × 10^12) still convert exactly; this is a property of the
    // dollar-denominated project totals, not of the per-invoice ledger.
    expect(toCents(fromCents(31 * gross))).toBe(31 * gross)
  })

  it('JSON keeps whole cents to 2^53 − 1 and dollar amounts as the same double', () => {
    const doc = {
      cents: Number.MAX_SAFE_INTEGER, max: MAX_CENTS, gross: 109_999_999_999_999,
      dollars: 999999999999.99, grossDollars: 1099999999999.99,
    }
    const back = JSON.parse(JSON.stringify(doc))
    expect(back).toEqual(doc)
    expect(JSON.stringify(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
    expect(JSON.stringify(999999999999.99)).toBe('999999999999.99')
    expect(toCents(back.grossDollars)).toBe(109_999_999_999_999)
    // One past the safe range is where integers stop being trustworthy.
    expect(Number.MAX_SAFE_INTEGER + 2).toBe(Number.MAX_SAFE_INTEGER + 1)
  })
})

// ── The call sites that must and must not have moved ─────────────────────────

describe('gstForLine — receivable side exact, payable side deliberately unchanged', () => {
  it('client invoices: exact round-half-up', () => {
    expect(clientGstForLine(40.15, TAX_CODE.GST)).toBe(4.02)
    expect(clientGstForLine(40.15, 'gst')).toBe(4.02)
    expect(clientGstForLine(41.05, 'gst')).toBe(4.11)
    expect(clientGstForLine(80.85, 'gst')).toBe(8.09)
    expect(clientGstForLine(0.05, 'gst')).toBe(0.01)
    expect(clientGstForLine(0.04, 'gst')).toBe(0)
    expect(clientGstForLine(1000, 'gst')).toBe(100)
    expect(clientGstForLine('40.15', 'gst')).toBe(4.02)
  })

  it('client invoices: GST-free and input-taxed lines carry no GST', () => {
    expect(clientGstForLine(40.15, TAX_CODE.GST_FREE)).toBe(0)
    expect(clientGstForLine(40.15, TAX_CODE.INPUT_TAXED)).toBe(0)
    expect(clientGstForLine(40.15, 'gst_free')).toBe(0)
    expect(clientGstForLine(40.15, 'input_taxed')).toBe(0)
    expect(clientGstForLine(40.15, undefined)).toBe(0)
    expect(clientGstForLine(40.15, 'nonsense')).toBe(0)
  })

  it('client invoices: equals the oracle for every cent to 1,000.00', () => {
    const failures = []
    for (let i = 0n; i <= 100_000n; i += 1n) {
      const text = centsText(i)
      if (clientGstForLine(Number(text), 'gst') !== Number(centsText(oracleGst(i)))) failures.push(text)
    }
    expect(failures).toEqual([])
  })

  it('PIN: the supplier-side gstForLine still returns the legacy 4.01 for 40.15', () => {
    // ADR-86: the payable side is NOT moved in Phase 1. If this changes, four
    // read-time comparisons on the payable side change with it.
    expect(supplierGstForLine(40.15, 'gst')).toBe(4.01)
    expect(supplierGstForLine(1000, 'gst')).toBe(100)
    expect(supplierGstForLine(40.15, 'gst_free')).toBe(0)
  })
})
