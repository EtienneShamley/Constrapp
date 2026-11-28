import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as client from '../../src/lib/estimatingCalc'
import * as server from '../../functions/src/generated/estimatingCalc.js'
import { buildEstimatingBundle, ESTIMATING_BUNDLE_PATH, ESTIMATING_BUNDLE_HEADER } from '../../scripts/build-estimating-bundle.mjs'
import {
  PRICING_POLICY, ALLOWANCE_MODE, COST_CLASS, ESTIMATE_PROBLEM, ESTIMATE_STATE,
  sellingPriceCents, percentOfCents, achievedBps, estimateSettingsProblem, normaliseEstimateSettings, defaultEstimateSettings,
  rateUnits, componentsProblem, componentCents, buildEstimateLines, describeEstimateProblems, estimateTotals, sameTotals,
  canonicalLine, canonicalHeader, storedLineProblem, sourceKeyOfLines, chunkEstimateLines, chunkDocId, lineBytes,
  estimateDrift, buildRequestKey, currentApprovedEstimate, percentTextToBps, bpsToPercentText, estimateByCostCode,
  CHUNK_MAX_LINES, CHUNK_MAX_BYTES, ESTIMATE_MAX_ITEMS, MAX_MARKUP_BPS, MAX_MARGIN_BPS, ESTIMATE_DESCRIPTION_MAX,
  ESTIMATE_TEXT_MAX, ESTIMATE_PROBLEM_LABELS, ESTIMATE_ITEM_NUMBER_MAX, ESTIMATE_UNIT_MAX, ESTIMATE_ID_MAX, LINE_MAX_BYTES, CHUNK_ENVELOPE_BYTES,
  FIRESTORE_DOCUMENT_MAX_BYTES, FIRESTORE_REQUEST_MAX_BYTES, encodedBytesBound,
  budgetHandoverCents, formatEstimateNumber, canPrepareEstimate, canApproveEstimate,
} from '../../src/lib/estimating'
import { estimateSourceKey, isEstimateSourceKeyShape } from '../../src/lib/estimateSource'
import { describeEstimateFailure, runEstimateOperation, EstimateError, ESTIMATE_ERROR } from '../../src/lib/estimatingActions'
import { describeWriteError } from '../../src/lib/writeOutcome'
import { transferRequestKey } from '../../src/lib/boqBudgetTransfer'

// ── Estimating (ADR-97, D1–D3) ───────────────────────────────────────────────
//
// ORACLES are independent: figures worked by hand (stated beside each case) or
// computed with BigInt formulas written here — never by the module under test.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

// Oracle: round-half-up(n ÷ d) for non-negative BigInts.
const halfUp = (n, d) => Number((2n * n + d) / (2n * d))
const oracleMarkup = (cost, bps) => cost + halfUp(BigInt(cost) * BigInt(bps), 10000n)
const oracleMargin = (cost, bps) => halfUp(BigInt(cost) * 10000n, BigInt(10000 - bps))

const settings = (over = {}) => normaliseEstimateSettings({ ...defaultEstimateSettings(), ...over })
const item = (id, quantity, rate, costCodeId = 'cc1', over = {}) => ({
  id, status: 'active', itemNumber: id, section: 'A', description: `Item ${id}`, unit: 'm2', quantity, rate,
  amount: rate === null ? null : Math.round(quantity * rate * 100) / 100, costCodeId, costCodeName: `Code ${costCodeId}`, currency: 'AUD', ...over,
})

describe('D2 — markup on cost and margin on selling price', () => {
  it('the approved example: cost 100,000.00 → 20% markup 120,000.00 · 20% margin 125,000.00', () => {
    expect(sellingPriceCents(10_000_000, PRICING_POLICY.MARKUP_ON_COST, 2000)).toEqual({ sellCents: 12_000_000 })
    expect(sellingPriceCents(10_000_000, PRICING_POLICY.MARGIN_ON_SELL, 2000)).toEqual({ sellCents: 12_500_000 })
  })
  it('hand-worked rounding: 333.33 at 12.5% markup = 374.996… → 375.00; at 12.5% margin = 380.948… → 380.95; 0.01 at 50% markup = 0.015 → 0.02', () => {
    expect(sellingPriceCents(33_333, PRICING_POLICY.MARKUP_ON_COST, 1250).sellCents).toBe(37_500)   // 33,333 + 4,166.625 → 4,167
    expect(sellingPriceCents(33_333, PRICING_POLICY.MARGIN_ON_SELL, 1250).sellCents).toBe(38_095)   // 33,333 ÷ 0.875 = 38,094.857
    expect(sellingPriceCents(1, PRICING_POLICY.MARKUP_ON_COST, 5000).sellCents).toBe(2)             // half rounds UP
    expect(sellingPriceCents(1, PRICING_POLICY.MARGIN_ON_SELL, 3334).sellCents).toBe(2)             // 1 ÷ 0.6666 = 1.50015
    expect(sellingPriceCents(1, PRICING_POLICY.MARGIN_ON_SELL, 3333).sellCents).toBe(1)             // 1 ÷ 0.6667 = 1.49992
  })
  it('agrees with the BigInt oracle across costs and percentages, including the supported maximum', () => {
    const costs = [0, 1, 99, 100, 33_333, 10_000_000, 123_456_789, 99_999_999_999_999]
    for (const cost of costs) {
      for (const bps of [0, 1, 250, 1999, 2000, 3333, 5000, 9999]) {
        expect(sellingPriceCents(cost, PRICING_POLICY.MARKUP_ON_COST, bps).sellCents, `markup ${cost} ${bps}`).toBe(oracleMarkup(cost, bps))
        const margin = sellingPriceCents(cost, PRICING_POLICY.MARGIN_ON_SELL, bps)
        if (margin.problem) expect(BigInt(cost) * 10000n / BigInt(10000 - bps) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
        else expect(margin.sellCents, `margin ${cost} ${bps}`).toBe(oracleMargin(cost, bps))
      }
    }
  })
  it('zero: 0% of either policy sells at cost; a zero cost sells at zero', () => {
    expect(sellingPriceCents(4_200, PRICING_POLICY.MARKUP_ON_COST, 0).sellCents).toBe(4_200)
    expect(sellingPriceCents(4_200, PRICING_POLICY.MARGIN_ON_SELL, 0).sellCents).toBe(4_200)
    expect(sellingPriceCents(0, PRICING_POLICY.MARGIN_ON_SELL, 9999).sellCents).toBe(0)
  })
  it('REFUSED: a margin of 100% or more, any negative percentage, a fractional percentage, a markup over the bound, an unknown policy, a negative or fractional cost', () => {
    for (const bps of [10000, 10001, 25000]) expect(sellingPriceCents(100, PRICING_POLICY.MARGIN_ON_SELL, bps).problem).toMatch(/100% or more/)
    expect(sellingPriceCents(100, PRICING_POLICY.MARGIN_ON_SELL, -1).problem).toMatch(/negative/)
    expect(sellingPriceCents(100, PRICING_POLICY.MARKUP_ON_COST, -1).problem).toBeTruthy()
    expect(sellingPriceCents(100, PRICING_POLICY.MARKUP_ON_COST, 12.5).problem).toBeTruthy()
    expect(sellingPriceCents(100, PRICING_POLICY.MARGIN_ON_SELL, 12.5).problem).toBeTruthy()
    expect(sellingPriceCents(100, PRICING_POLICY.MARKUP_ON_COST, MAX_MARKUP_BPS).sellCents).toBe(1100)
    expect(sellingPriceCents(100, PRICING_POLICY.MARKUP_ON_COST, MAX_MARKUP_BPS + 1).problem).toBeTruthy()
    expect(sellingPriceCents(100, PRICING_POLICY.MARGIN_ON_SELL, MAX_MARGIN_BPS).sellCents).toBe(1_000_000)   // 1.00 ÷ 0.0001
    expect(sellingPriceCents(100, 'cost_plus', 1000).problem).toBeTruthy()
    expect(sellingPriceCents(-1, PRICING_POLICY.MARKUP_ON_COST, 1000).problem).toBeTruthy()
    expect(sellingPriceCents(10.5, PRICING_POLICY.MARKUP_ON_COST, 1000).problem).toBeTruthy()
  })
  it('the SAME percentage means different prices under the two policies — and the achieved figures say which', () => {
    const markup = sellingPriceCents(10_000_000, PRICING_POLICY.MARKUP_ON_COST, 2000).sellCents
    const margin = sellingPriceCents(10_000_000, PRICING_POLICY.MARGIN_ON_SELL, 2000).sellCents
    expect(margin - markup).toBe(500_000)
    expect(achievedBps(10_000_000, markup)).toEqual({ markupBps: 2000, marginBps: 1667 })   // 20,000 ÷ 120,000 = 16.67%
    expect(achievedBps(10_000_000, margin)).toEqual({ markupBps: 2500, marginBps: 2000 })   // 25,000 ÷ 100,000 = 25%
    expect(achievedBps(0, 0)).toEqual({ markupBps: null, marginBps: null })
  })
  it('percentOfCents is round-half-up of cents × bps ÷ 10,000', () => {
    expect(percentOfCents(10_000, 1000)).toBe(1_000)
    expect(percentOfCents(5, 1000)).toBe(1)        // 0.5 → 1
    expect(percentOfCents(4, 1000)).toBe(0)        // 0.4 → 0
    expect(percentOfCents(99_999_999_999_999, 10000)).toBe(99_999_999_999_999)
  })
  it('percentages are typed with at most two decimals and held as whole basis points', () => {
    expect(percentTextToBps('20')).toBe(2000)
    expect(percentTextToBps('12.5')).toBe(1250)
    expect(percentTextToBps('0.01')).toBe(1)
    for (const bad of ['', '-5', '12.345', 'abc', '1e2', ' ']) expect(percentTextToBps(bad)).toBeNull()
    expect(bpsToPercentText(1250)).toBe('12.5')
    expect(bpsToPercentText(2000)).toBe('20')
  })
})

describe('settings — explicit overhead and contingency treatment; nothing counted twice', () => {
  const classes = (...pairs) => pairs.map(([costCodeId, costClass]) => ({ costCodeId, costClass }))
  it('the defaults are valid; missing or extra keys are not', () => {
    expect(estimateSettingsProblem(defaultEstimateSettings())).toBeNull()
    const missing = { ...defaultEstimateSettings() }
    delete missing.notes
    expect(estimateSettingsProblem(missing)).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), sellCents: 1 })).toBeTruthy()
    expect(estimateSettingsProblem(null)).toBeTruthy()
  })
  it('a percentage allowance AND a cost code classified to it is refused (double counting)', () => {
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadMode: ALLOWANCE_MODE.PERCENTAGE, overheadBps: 500, costCodeClasses: classes(['oh', COST_CLASS.OVERHEAD]) })).toMatch(/counted twice/)
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), contingencyMode: ALLOWANCE_MODE.PERCENTAGE, contingencyBps: 500, costCodeClasses: classes(['ct', COST_CLASS.CONTINGENCY]) })).toMatch(/counted twice/)
  })
  it('a percentage without the percentage mode, and a classified code under mode none, are refused', () => {
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadBps: 500 })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadMode: ALLOWANCE_MODE.COST_CODED, overheadBps: 500 })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), costCodeClasses: classes(['oh', COST_CLASS.OVERHEAD]) })).toMatch(/set to none/)
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadMode: ALLOWANCE_MODE.COST_CODED, costCodeClasses: classes(['oh', COST_CLASS.OVERHEAD]) })).toBeNull()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), costCodeClasses: classes(['p', COST_CLASS.PRELIMINARIES]) })).toBeNull()
  })
  it('bounds and shapes: a negative or >100% allowance, a duplicate or malformed class, `direct` as a class, over-long text', () => {
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadMode: ALLOWANCE_MODE.PERCENTAGE, overheadBps: -1 })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadMode: ALLOWANCE_MODE.PERCENTAGE, overheadBps: 10001 })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), overheadMode: ALLOWANCE_MODE.PERCENTAGE, overheadBps: 10000 })).toBeNull()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), costCodeClasses: classes(['p', COST_CLASS.PRELIMINARIES], ['p', COST_CLASS.PRELIMINARIES]) })).toMatch(/twice/)
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), costCodeClasses: classes(['p', COST_CLASS.DIRECT]) })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), costCodeClasses: [{ costCodeId: 'a/b', costClass: COST_CLASS.PRELIMINARIES }] })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), costCodeClasses: [{ costCodeId: 'a', costClass: COST_CLASS.PRELIMINARIES, amount: 5 }] })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), title: 'x'.repeat(121) })).toBeTruthy()
    expect(estimateSettingsProblem({ ...defaultEstimateSettings(), pricingPolicy: PRICING_POLICY.MARGIN_ON_SELL, pricingBps: 10000 })).toMatch(/100% or more/)
  })
  it('normalised settings sort the classes and trim the text, so a request key does not depend on order', () => {
    const a = { ...defaultEstimateSettings(), title: ' T ', costCodeClasses: classes(['b', COST_CLASS.PRELIMINARIES], ['a', COST_CLASS.PRELIMINARIES]) }
    const b = { ...defaultEstimateSettings(), title: 'T', costCodeClasses: classes(['a', COST_CLASS.PRELIMINARIES], ['b', COST_CLASS.PRELIMINARIES]) }
    expect(normaliseEstimateSettings(a)).toEqual(normaliseEstimateSettings(b))
    expect(buildRequestKey('e1', null, a)).toBe(buildRequestKey('e1', null, b))
    expect(buildRequestKey('e1', null, a)).not.toBe(buildRequestKey('e1', 1, a))
    expect(buildRequestKey('e1', null, a)).not.toBe(buildRequestKey('e2', null, a))
    expect(buildRequestKey('e1', null, a)).not.toBe(buildRequestKey('e1', null, { ...a, pricingBps: 1 }))
  })
})

describe('rate components reconcile to the authoritative unit rate', () => {
  it('rates are compared in ten-thousandths; a fifth decimal, a negative or a non-number has no units', () => {
    expect(rateUnits(12.3456)).toBe(123_456)
    expect(rateUnits(0)).toBe(0)
    expect(rateUnits(0.1 + 0.2)).toBe(3000)      // binary noise is not a fifth decimal
    expect(rateUnits(12.34567)).toBeNull()
    expect(rateUnits(-1)).toBeNull()
    expect(rateUnits('5')).toBeNull()
    expect(rateUnits(NaN)).toBeNull()
  })
  it('a breakdown must sum EXACTLY to the unit rate: 45.50 + 60.25 + 12.00 + 0 = 117.75', () => {
    const c = { labour: 45.5, material: 60.25, plant: 12, subcontractor: 0 }
    expect(componentsProblem(c, 117.75)).toBeNull()
    expect(componentsProblem(c, 117.76)).toMatch(/117\.7500, not the unit rate of 117\.7600/)
    expect(componentsProblem({ ...c, plant: 12.0001 }, 117.75)).toBeTruthy()
    expect(componentsProblem({ labour: 0.1, material: 0.2, plant: 0, subcontractor: 0 }, 0.3)).toBeNull()
  })
  it('refused: a missing or extra component, a negative, more than four decimals, an unpriced or over-precise unit rate', () => {
    expect(componentsProblem({ labour: 1, material: 1, plant: 1 }, 3)).toBeTruthy()
    expect(componentsProblem({ labour: 1, material: 1, plant: 1, subcontractor: 0, other: 0 }, 3)).toBeTruthy()
    expect(componentsProblem({ labour: -1, material: 4, plant: 0, subcontractor: 0 }, 3)).toBeTruthy()
    expect(componentsProblem({ labour: 1.00001, material: 0, plant: 0, subcontractor: 0 }, 1.00001)).toBeTruthy()
    expect(componentsProblem({ labour: 1, material: 0, plant: 0, subcontractor: 0 }, null)).toMatch(/cannot carry a breakdown/)
    expect(componentsProblem({ labour: 1, material: 0, plant: 0, subcontractor: 0 }, 1.000001)).toMatch(/cannot carry a breakdown/)
  })
  it('a line amount splits across its components to the cent, the last taking the remainder: 100.00 over thirds = 33.33 / 33.33 / 33.34', () => {
    expect(componentCents(10_000, { labour: 1, material: 1, plant: 1, subcontractor: 0 })).toEqual({ labour: 3333, material: 3334, plant: 3333, subcontractor: 0 })
    // cumulative shares: 1/3 → 3,333; 2/3 → 6,667 (so material 3,334); 3/3 → 10,000 (plant 3,333)
    for (const [amount, c] of [[1, { labour: 1, material: 1, plant: 1, subcontractor: 1 }], [99_999, { labour: 0.0001, material: 7, plant: 0, subcontractor: 3.3333 }], [0, { labour: 1, material: 2, plant: 3, subcontractor: 4 }]]) {
      const split = componentCents(amount, c)
      expect(Object.values(split).reduce((s, v) => s + v, 0)).toBe(amount)
      expect(Object.values(split).every(v => Number.isSafeInteger(v) && v >= 0)).toBe(true)
    }
    expect(componentCents(500, { labour: 0, material: 0, plant: 0, subcontractor: 0 })).toEqual({ labour: 0, material: 0, plant: 0, subcontractor: 0 })
  })
})

// A worked estimate, every figure by hand:
//   a1  10 m2 × 117.75 = 1,177.50   cc1 direct   (labour 45.50 / material 60.25 / plant 12.00)
//   a2   3 × 333.33   =   999.99   cc1 direct
//   p1   1 × 5,000.00 = 5,000.00   ccP preliminaries
//   construction = 2,177.49 + 5,000.00 = 7,177.49
const WORKED = [item('a1', 10, 117.75), item('a2', 3, 333.33), item('p1', 1, 5000, 'ccP')]
const WORKED_INPUTS = new Map([['a1', { components: { labour: 45.5, material: 60.25, plant: 12, subcontractor: 0 } }]])
const WORKED_SETTINGS = settings({
  pricingPolicy: PRICING_POLICY.MARGIN_ON_SELL, pricingBps: 2000,
  overheadMode: ALLOWANCE_MODE.PERCENTAGE, overheadBps: 750, contingencyMode: ALLOWANCE_MODE.PERCENTAGE, contingencyBps: 500,
  costCodeClasses: [{ costCodeId: 'ccP', costClass: COST_CLASS.PRELIMINARIES }],
})

describe('lines and totals — a worked estimate, by hand', () => {
  it('the cost build-up, the price and the component split', () => {
    const built = buildEstimateLines({ boqItems: WORKED, itemInputs: WORKED_INPUTS, settings: WORKED_SETTINGS, currencyCode: 'AUD' })
    expect(built.problems).toEqual([])
    expect(built.lines.map(l => [l.itemId, l.amountCents, l.costClass])).toEqual([['a1', 117_750, 'direct'], ['a2', 99_999, 'direct'], ['p1', 500_000, 'preliminaries']])
    const { totals } = estimateTotals(built.lines, WORKED_SETTINGS)
    expect(totals).toEqual({
      directCents: 217_749, preliminariesCents: 500_000, constructionCents: 717_749,
      overheadCents: 53_831,        // 7,177.49 × 7.5% = 538.31175 → 538.31
      contingencyCents: 35_887,     // 7,177.49 × 5%   = 358.8745  → 358.87  (same base — not compounded)
      costTotalCents: 807_467,      // 8,074.67
      sellCents: 1_009_334,         // 8,074.67 ÷ 0.8 = 10,093.3375 → 10,093.34
      grossProfitCents: 201_867,
      labourCents: 45_500, materialCents: 60_250, plantCents: 12_000, subcontractorCents: 0,   // 10 × each component rate
      unanalysedCents: 599_999, boqTotalCents: 717_749,
    })
    expect(totals.labourCents + totals.materialCents + totals.plantCents + totals.subcontractorCents + totals.unanalysedCents).toBe(totals.boqTotalCents)
    expect(budgetHandoverCents(totals)).toBe(717_749)   // cost-coded cost only — never the selling price, never a percentage allowance
    expect(sameTotals(totals, { ...totals })).toBe(true)
    expect(sameTotals(totals, { ...totals, sellCents: totals.sellCents + 1 })).toBe(false)
    expect(sameTotals(totals, { ...totals, sellCents: undefined })).toBe(false)
  })
  it('cost-coded overhead and contingency are BOQ items, counted once, in their own class', () => {
    const items = [item('d', 1, 1000), item('o', 1, 80, 'ccO'), item('c', 1, 50, 'ccC')]
    const s = settings({
      pricingPolicy: PRICING_POLICY.MARKUP_ON_COST, pricingBps: 1000, overheadMode: ALLOWANCE_MODE.COST_CODED, contingencyMode: ALLOWANCE_MODE.COST_CODED,
      costCodeClasses: [{ costCodeId: 'ccO', costClass: COST_CLASS.OVERHEAD }, { costCodeId: 'ccC', costClass: COST_CLASS.CONTINGENCY }],
    })
    const { totals } = estimateTotals(buildEstimateLines({ boqItems: items, settings: s, currencyCode: 'AUD' }).lines, s)
    expect([totals.directCents, totals.overheadCents, totals.contingencyCents, totals.costTotalCents, totals.sellCents]).toEqual([100_000, 8_000, 5_000, 113_000, 124_300])
    expect(totals.boqTotalCents).toBe(113_000)
    // Lines classified to an allowance whose mode is not cost-coded cannot be totalled (the settings check refuses it first).
    expect(estimateTotals([{ amountCents: 1, costClass: COST_CLASS.OVERHEAD, components: null }], settings()).problem).toBeTruthy()
  })
  it('an EMPTY BOQ, an unpriced item, a malformed amount, a foreign currency, an unreconciled breakdown and an unused class are each refused, named', () => {
    const kinds = (boqItems, over = {}) => buildEstimateLines({ boqItems, settings: settings(), currencyCode: 'AUD', ...over }).problems.map(p => p.kind)
    expect(kinds([])).toEqual([ESTIMATE_PROBLEM.EMPTY])
    expect(kinds([item('v', 1, 1, 'cc1', { status: 'void' })])).toEqual([ESTIMATE_PROBLEM.EMPTY])
    expect(kinds([item('a', 1, 10), item('u', 2, null)])).toEqual([ESTIMATE_PROBLEM.UNPRICED])
    expect(kinds([item('a', 2, 10, 'cc1', { amount: 20.01 })])).toEqual([ESTIMATE_PROBLEM.INVALID_SOURCE])
    expect(kinds([item('a', -1, 10)])).toEqual([ESTIMATE_PROBLEM.INVALID_SOURCE])
    expect(kinds([item('a', 1, 10, '')])).toEqual([ESTIMATE_PROBLEM.INVALID_SOURCE])
    expect(kinds([item('a', 1, 10, 'cc1', { currency: 'NZD' })])).toEqual([ESTIMATE_PROBLEM.CURRENCY_MISMATCH])
    expect(kinds([item('a', 1, 10)], { itemInputs: new Map([['a', { components: { labour: 4, material: 5, plant: 0, subcontractor: 0 } }]]) })).toEqual([ESTIMATE_PROBLEM.COMPONENTS_UNRECONCILED])
    const unused = buildEstimateLines({ boqItems: [item('a', 1, 10)], settings: settings({ costCodeClasses: [{ costCodeId: 'gone', costClass: COST_CLASS.PRELIMINARIES }] }), currencyCode: 'AUD' })
    expect(unused.problems.map(p => [p.kind, p.detail])).toEqual([[ESTIMATE_PROBLEM.CLASS_UNUSED, 'gone']])
    const many = buildEstimateLines({ boqItems: [item('u1', 1, null), item('u2', 1, null), item('ok', 1, 5)], settings: settings(), currencyCode: 'AUD' })
    expect(many.problemCounts).toEqual({ [ESTIMATE_PROBLEM.UNPRICED]: 2 })
    expect(describeEstimateProblems(many)).toMatch(/no rate.*2 items: u1, u2/)
    expect(describeEstimateProblems({ problems: [], problemCounts: {} })).toBeNull()
  })
  it('zero is a price; void items are ignored; more items than the supported bound is refused by name', () => {
    const built = buildEstimateLines({ boqItems: [item('z', 5, 0), item('v', 1, 9, 'cc1', { status: 'void' })], settings: settings(), currencyCode: 'AUD' })
    expect(built.problems).toEqual([])
    expect(built.lines.map(l => [l.itemId, l.amountCents])).toEqual([['z', 0]])
    const big = Array.from({ length: ESTIMATE_MAX_ITEMS + 1 }, (_, i) => item(`i${String(i).padStart(5, '0')}`, 1, 1))
    expect(buildEstimateLines({ boqItems: big, settings: settings(), currencyCode: 'AUD' }).problems.map(p => p.kind)).toContain(ESTIMATE_PROBLEM.TOO_LARGE)
  })
  it('a cost total or selling price beyond the supported maximum is refused, not clamped', () => {
    const lines = [{ amountCents: 99_999_999_999_999, costClass: COST_CLASS.DIRECT, components: null }]
    expect(estimateTotals(lines, settings()).totals.costTotalCents).toBe(99_999_999_999_999)
    expect(estimateTotals(lines, settings({ pricingBps: 1 })).kind).toBe(ESTIMATE_PROBLEM.OUT_OF_RANGE)
    expect(estimateTotals([...lines, { amountCents: 1, costClass: COST_CLASS.DIRECT, components: null }], settings()).kind).toBe(ESTIMATE_PROBLEM.OUT_OF_RANGE)
  })
  it('lines are in item-id order whatever order the register arrives in; by-cost-code totals add up', () => {
    const a = buildEstimateLines({ boqItems: WORKED, itemInputs: WORKED_INPUTS, settings: WORKED_SETTINGS, currencyCode: 'AUD' }).lines
    const b = buildEstimateLines({ boqItems: [...WORKED].reverse(), itemInputs: WORKED_INPUTS, settings: WORKED_SETTINGS, currencyCode: 'AUD' }).lines
    expect(b).toEqual(a)
    expect(estimateByCostCode(a).map(c => [c.costCodeId, c.itemCount, c.amountCents, c.costClass])).toEqual([['cc1', 2, 217_749, 'direct'], ['ccP', 1, 500_000, 'preliminaries']])
  })
})

describe('a revision is self-contained: canonical content, the source key, chunks, drift', () => {
  const built = buildEstimateLines({ boqItems: WORKED, itemInputs: WORKED_INPUTS, settings: WORKED_SETTINGS, currencyCode: 'AUD' })
  it('a stored line keeps everything needed to reconstruct it, and is re-verifiable on its own', () => {
    const [a1] = built.lines
    expect(a1).toEqual({
      itemId: 'a1', itemNumber: 'a1', section: 'A', description: 'Item a1', unit: 'm2', quantity: 10, rate: 117.75, amountCents: 117_750,
      currency: 'AUD', costCodeId: 'cc1', costCodeName: 'Code cc1', costClass: 'direct', components: { labour: 45.5, material: 60.25, plant: 12, subcontractor: 0 },
    })
    for (const l of built.lines) expect(storedLineProblem(l)).toBeNull()
    expect(storedLineProblem({ ...a1, amountCents: 117_751 })).toMatch(/not its quantity × rate/)
    expect(storedLineProblem({ ...a1, components: { ...a1.components, labour: 46 } })).toMatch(/does not add up/)
    expect(storedLineProblem({ ...a1, costClass: 'profit' })).toBeTruthy()
    expect(storedLineProblem(null)).toBeTruthy()
  })
  it('the canonical line changes with every stored field and with nothing else', () => {
    const [a1] = built.lines
    const base = canonicalLine(a1)
    expect(canonicalLine({ ...a1 })).toBe(base)
    expect(canonicalLine({ ...a1, extra: 1 })).toBe(base)
    for (const key of ['itemId', 'itemNumber', 'section', 'description', 'unit', 'quantity', 'rate', 'amountCents', 'currency', 'costCodeId', 'costCodeName', 'costClass']) {
      expect(canonicalLine({ ...a1, [key]: 'changed' }), key).not.toBe(base)
    }
    expect(canonicalLine({ ...a1, components: null })).not.toBe(base)
    const { totals } = estimateTotals(built.lines, WORKED_SETTINGS)
    const header = canonicalHeader({ currency: 'AUD', settings: WORKED_SETTINGS, totals, lineCount: 3, sourceKey: 'k' })
    expect(canonicalHeader({ currency: 'AUD', settings: { ...WORKED_SETTINGS, title: 'x', notes: 'y' }, totals, lineCount: 3, sourceKey: 'k' })).toBe(header)   // text is not content
    expect(canonicalHeader({ currency: 'AUD', settings: { ...WORKED_SETTINGS, pricingBps: 2001 }, totals, lineCount: 3, sourceKey: 'k' })).not.toBe(header)
    expect(canonicalHeader({ currency: 'NZD', settings: WORKED_SETTINGS, totals, lineCount: 3, sourceKey: 'k' })).not.toBe(header)
    expect(canonicalHeader({ currency: 'AUD', settings: WORKED_SETTINGS, totals: { ...totals, sellCents: 1 }, lineCount: 3, sourceKey: 'k' })).not.toBe(header)
  })
  it('the source key of the stored lines IS the key of the live register they were built from', () => {
    expect(isEstimateSourceKeyShape(estimateSourceKey(WORKED))).toBe(true)
    expect(sourceKeyOfLines(built.lines)).toBe(estimateSourceKey(WORKED))
    expect(estimateSourceKey([...WORKED].reverse())).toBe(estimateSourceKey(WORKED))
    // A description, a note or a void item does not change it; a quantity, rate, unit, cost code, currency, a new item or a void does.
    expect(estimateSourceKey(WORKED.map(i => ({ ...i, description: 'reworded', notes: 'n' })))).toBe(estimateSourceKey(WORKED))
    expect(estimateSourceKey([...WORKED, item('v', 1, 1, 'cc1', { status: 'void' })])).toBe(estimateSourceKey(WORKED))
    const changed = (patch) => estimateSourceKey(WORKED.map(i => (i.id === 'a2' ? { ...i, ...patch } : i)))
    for (const patch of [{ quantity: 4, amount: 1333.32 }, { rate: 333.34, amount: 1000.02 }, { unit: 'm3' }, { costCodeId: 'cc9' }, { currency: 'NZD' }, { status: 'void' }, { rate: null, amount: null }]) {
      expect(changed(patch), JSON.stringify(patch)).not.toBe(estimateSourceKey(WORKED))
    }
    expect(estimateSourceKey([...WORKED, item('new', 1, 1)])).not.toBe(estimateSourceKey(WORKED))
  })
  it('drift names what was added, removed and changed since the revision', () => {
    expect(estimateDrift(built.lines, WORKED)).toMatchObject({ matches: true, added: [], removed: [], changed: [] })
    const live = [
      { ...WORKED[0], quantity: 12, amount: 1413 },                 // changed: 1,177.50 → 1,413.00
      { ...WORKED[1], status: 'void' },                             // removed
      WORKED[2],
      item('n1', 1, 25),                                            // added
    ]
    const d = estimateDrift(built.lines, live)
    expect(d.matches).toBe(false)
    expect(d.changed).toEqual([{ itemId: 'a1', itemNumber: 'a1', description: 'Item a1', fromCents: 117_750, toCents: 141_300 }])
    expect(d.removed.map(r => r.itemId)).toEqual(['a2'])
    expect(d.added.map(r => r.itemId)).toEqual(['n1'])
    // With only the header (no lines loaded), the key comparison still decides.
    expect(estimateDrift([], WORKED, estimateSourceKey(WORKED)).matches).toBe(true)
    expect(estimateDrift([], live, estimateSourceKey(WORKED)).matches).toBe(false)
  })
  it('chunks are bounded by LINE COUNT and by BYTES, keep the order and lose nothing', () => {
    const lines = Array.from({ length: 1001 }, (_, i) => ({ ...built.lines[0], itemId: `i${i}` }))
    const chunks = chunkEstimateLines(lines)
    expect(chunks.map(c => c.length)).toEqual([250, 250, 250, 250, 1])
    expect(chunks.flat()).toEqual(lines)
    expect(CHUNK_MAX_LINES).toBe(250)
    // The longest description the snapshot keeps, in three-byte characters: the byte bound becomes the binding one.
    const long = Array.from({ length: 300 }, (_, i) => ({ ...built.lines[0], itemId: `i${i}`, description: '測'.repeat(ESTIMATE_DESCRIPTION_MAX) }))
    const byBytes = chunkEstimateLines(long)
    expect(byBytes.length).toBeGreaterThan(2)
    for (const c of byBytes) {
      expect(c.reduce((s, l) => s + lineBytes(l), 0)).toBeLessThanOrEqual(CHUNK_MAX_BYTES)
      expect(c.reduce((s, l) => s + Buffer.byteLength(JSON.stringify(l), 'utf8'), 0)).toBeLessThanOrEqual(CHUNK_MAX_BYTES)   // the estimate never under-counts
      expect(c.length).toBeLessThanOrEqual(CHUNK_MAX_LINES)
    }
    expect(byBytes.flat()).toEqual(long)
    expect(CHUNK_MAX_BYTES).toBeLessThan(1_048_576 * 0.4)
    expect(chunkEstimateLines([])).toEqual([])
    expect(chunkDocId(7)).toBe('00007')
  })
  it('D3 #53 — BOQ text is NEVER clipped: at its bound it is kept whole; one character over, the item is refused (text-too-long, naming the field) and nothing is built; key text over its bound is refused as before', () => {
    const atBound = { description: 'd'.repeat(ESTIMATE_DESCRIPTION_MAX), section: 's'.repeat(ESTIMATE_TEXT_MAX), costCodeName: 'n'.repeat(ESTIMATE_TEXT_MAX), itemNumber: 'i'.repeat(ESTIMATE_ITEM_NUMBER_MAX) }
    const [line] = buildEstimateLines({ boqItems: [item('a', 1, 1, 'cc1', atBound)], settings: settings(), currencyCode: 'AUD' }).lines
    expect([line.description, line.section, line.costCodeName, line.itemNumber]).toEqual([atBound.description, atBound.section, atBound.costCodeName, atBound.itemNumber])
    for (const [field, max] of [['description', ESTIMATE_DESCRIPTION_MAX], ['section', ESTIMATE_TEXT_MAX], ['costCodeName', ESTIMATE_TEXT_MAX], ['itemNumber', ESTIMATE_ITEM_NUMBER_MAX]]) {
      const over = buildEstimateLines({ boqItems: [item('a', 1, 1, 'cc1', { ...atBound, [field]: 'x'.repeat(max + 1) })], settings: settings(), currencyCode: 'AUD' })
      expect(over.lines, field).toEqual([])
      expect(over.problems.map(p => [p.kind, p.detail]), field).toEqual([[ESTIMATE_PROBLEM.TEXT_TOO_LONG, field]])
    }
    expect(ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.TEXT_TOO_LONG]).toMatch(/never shortens it/)
    const wide = item('w'.repeat(ESTIMATE_ID_MAX), 1, 1, 'c'.repeat(ESTIMATE_ID_MAX), { unit: 'u'.repeat(ESTIMATE_UNIT_MAX), itemNumber: '9.9' })
    const lines = buildEstimateLines({ boqItems: [wide], settings: settings(), currencyCode: 'AUD' }).lines
    expect(lines[0]).toMatchObject({ unit: wide.unit, itemId: wide.id, costCodeId: wide.costCodeId })
    expect(sourceKeyOfLines(lines)).toBe(estimateSourceKey([wide]))
    for (const over of [
      { unit: 'u'.repeat(ESTIMATE_UNIT_MAX + 1) }, { id: 'w'.repeat(ESTIMATE_ID_MAX + 1) }, { costCodeId: 'c'.repeat(ESTIMATE_ID_MAX + 1) },
    ]) {
      const built = buildEstimateLines({ boqItems: [{ ...wide, ...over }], settings: settings(), currencyCode: 'AUD' })
      expect(built.problems.map(p => p.kind), JSON.stringify(Object.keys(over))).toEqual([ESTIMATE_PROBLEM.INVALID_SOURCE])
      expect(built.lines).toEqual([])
    }
    // Without a resolved project currency (a browser preview), the item's own currency is still bounded.
    expect(buildEstimateLines({ boqItems: [{ ...wide, currency: 'AUDX' }], settings: settings() }).problems.map(p => p.kind)).toEqual([ESTIMATE_PROBLEM.INVALID_SOURCE])
  })
  it('BYTES: the encoded-size bound is ≥ Firestore’s documented storage size of any line; every buildable line is ≤ LINE_MAX_BYTES; a chunk and a chunk transaction are provably far below the limits', () => {
    // Oracle — the documented storage size: string UTF-8 + 1, number 8, null 1, map Σ(key UTF-8 + 1 + value), array Σ values.
    const storage = (v) => (typeof v === 'string' ? Buffer.byteLength(v, 'utf8') + 1
      : v === null || typeof v === 'boolean' ? 1 : typeof v === 'number' ? 8
        : Array.isArray(v) ? v.reduce((t, x) => t + storage(x), 0)
          : Object.entries(v).reduce((t, [k, x]) => t + Buffer.byteLength(k, 'utf8') + 1 + storage(x), 0))
    const texts = ['', 'plain', '€'.repeat(50), '😀'.repeat(30), 'é\u0000\n"\\', '\ud800']   // ASCII, 3-byte, 4-byte pairs, escapes, a lone surrogate
    const widest = (n) => '\u0800'.repeat(n)
    const maximal = item(widest(ESTIMATE_ID_MAX), 89, 123.4567, widest(ESTIMATE_ID_MAX), {
      // At every bound (D3 #53: text over its bound is refused, never clipped).
      itemNumber: widest(ESTIMATE_ITEM_NUMBER_MAX), section: widest(ESTIMATE_TEXT_MAX), description: widest(ESTIMATE_DESCRIPTION_MAX), unit: widest(ESTIMATE_UNIT_MAX), costCodeName: widest(ESTIMATE_TEXT_MAX), currency: 'AUD',
    })
    const comps = { labour: 100.1234, material: 20.3333, plant: 3, subcontractor: 0 }
    const built = buildEstimateLines({ boqItems: [maximal], itemInputs: new Map([[maximal.id, { components: comps }]]), settings: settings(), currencyCode: 'AUD' })
    expect(built.problems).toEqual([])
    const [big] = built.lines
    expect(lineBytes(big)).toBeLessThanOrEqual(LINE_MAX_BYTES)
    expect(LINE_MAX_BYTES - lineBytes(big)).toBeLessThan(64)            // the bound is tight to the real maximum (class / currency text only)
    for (const t of texts) {
      const l = { ...big, description: t, section: t, unit: t, costCodeName: t, components: null }
      expect(encodedBytesBound(l), t).toBeGreaterThanOrEqual(storage(l))
      expect(lineBytes(l)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(l), 'utf8'))
    }
    expect(encodedBytesBound(big)).toBeGreaterThanOrEqual(storage(big))
    // The proof, as arithmetic: ≥ 67 maximal lines per chunk; a chunk < 40% of 1 MiB; a transaction of 4 chunks < 17% of 10 MiB.
    expect(Math.floor(CHUNK_MAX_BYTES / LINE_MAX_BYTES)).toBeGreaterThanOrEqual(67)
    expect(CHUNK_MAX_BYTES + CHUNK_ENVELOPE_BYTES).toBeLessThan(FIRESTORE_DOCUMENT_MAX_BYTES * 0.4)
    expect(read('functions/src/estimating/operations.js')).toContain('export const CHUNKS_PER_TX = 4')
    expect(4 * (CHUNK_MAX_BYTES + CHUNK_ENVELOPE_BYTES)).toBeLessThan(FIRESTORE_REQUEST_MAX_BYTES * 0.17)
    // At the item bound, every text maximal: ≈ 30 MB and 75 chunks — the figures the limit is justified with.
    expect(ESTIMATE_MAX_ITEMS * LINE_MAX_BYTES).toBeLessThan(30_000_000)
    expect(Math.ceil(ESTIMATE_MAX_ITEMS / Math.floor(CHUNK_MAX_BYTES / LINE_MAX_BYTES))).toBe(75)
    const chunks = chunkEstimateLines(Array.from({ length: 200 }, (_, i) => ({ ...big, itemId: `${i}`.padEnd(ESTIMATE_ID_MAX, '\u0800') })))
    expect(chunks.map(c => c.length)).toEqual([67, 67, 66])
    for (const c of chunks) expect(c.reduce((t, l) => t + lineBytes(l), 0)).toBeLessThanOrEqual(CHUNK_MAX_BYTES)
  })
})

describe('revisions, roles and requests', () => {
  it('the current approved estimate is the approved revision with the highest number', () => {
    const list = [
      { id: 'a', state: ESTIMATE_STATE.APPROVED, revisionNumber: 1 }, { id: 'b', state: ESTIMATE_STATE.DRAFT, revisionNumber: 4 },
      { id: 'c', state: ESTIMATE_STATE.APPROVED, revisionNumber: 3 }, { id: 'd', state: ESTIMATE_STATE.DISCARDED, revisionNumber: 5 },
    ]
    expect(currentApprovedEstimate(list).id).toBe('c')
    expect(currentApprovedEstimate([list[1]])).toBeNull()
    expect(formatEstimateNumber(7)).toBe('EST-0007')
  })
  it('QS may prepare but not approve; external roles neither', () => {
    expect(['company_admin', 'project_manager', 'qs'].map(canPrepareEstimate)).toEqual([true, true, true])
    expect(['company_admin', 'project_manager', 'qs', 'subcontractor', 'client'].map(canApproveEstimate)).toEqual([true, true, false, false, false])
    expect(['subcontractor', 'client', undefined].map(canPrepareEstimate)).toEqual([false, false, false])
  })
  it('a transfer request that names an estimate has a different key; one that does not keeps its pre-ADR-97 key', () => {
    expect(transferRequestKey('v1:abc', ['z'])).toBe(transferRequestKey('v1:abc', ['z'], null))
    expect(transferRequestKey('v1:abc', ['z'], 'est1')).not.toBe(transferRequestKey('v1:abc', ['z']))
    expect(transferRequestKey('v1:abc', ['z'], 'est1')).not.toBe(transferRequestKey('v1:abc', ['z'], 'est2'))
  })
})

describe('the browser side: a typed refusal is certain, an untyped failure is uncertain', () => {
  const typed = (code, message) => Object.assign(new Error(message ?? 'server sentence'), { code: 'functions/failed-precondition', details: { code } })
  it('typed refusals keep the server’s reason; transport failures never claim nothing happened', () => {
    expect(describeEstimateFailure(typed('estimate-source-invalid', 'Some BOQ items have no rate. (2 items: 1.1, 1.2)'))).toMatchObject({ kind: ESTIMATE_ERROR.INVALID, message: 'Some BOQ items have no rate. (2 items: 1.1, 1.2)', code: 'estimate-source-invalid' })
    expect(describeEstimateFailure(typed('approval-segregation-required', 'Approval segregation is enabled…'))).toMatchObject({ kind: ESTIMATE_ERROR.PERMISSION, message: 'Approval segregation is enabled…' })
    expect(describeEstimateFailure(typed('estimate-stale')).kind).toBe(ESTIMATE_ERROR.STALE)
    expect(describeEstimateFailure(typed('estimate-disabled')).kind).toBe(ESTIMATE_ERROR.UNAVAILABLE)
    expect(describeEstimateFailure(Object.assign(new Error('deadline'), { code: 'functions/deadline-exceeded' })).kind).toBe(ESTIMATE_ERROR.UNCERTAIN)
    expect(describeEstimateFailure(Object.assign(new Error('internal'), { code: 'functions/internal' })).kind).toBe(ESTIMATE_ERROR.UNCERTAIN)
    expect(describeEstimateFailure(Object.assign(new Error('x'), { code: 'functions/not-found' })).kind).toBe(ESTIMATE_ERROR.UNAVAILABLE)
  })
  it('the shared write-outcome helper classifies them the same way', () => {
    expect(describeWriteError(describeEstimateFailure(typed('estimate-invalid', 'Reason.')))).toMatchObject({ certain: true, message: 'Reason.' })
    expect(describeWriteError(describeEstimateFailure(new Error('socket hang up'))).certain).toBe(false)
  })
  it('a call sends { operation, request } only, and an answer without alreadyApplied is uncertain', async () => {
    const sent = []
    const out = await runEstimateOperation(async (d) => { sent.push(d); return { alreadyApplied: false, id: 'e' } }, 'approve', { projectId: 'p' })
    expect(out).toEqual({ alreadyApplied: false, id: 'e' })
    expect(sent).toEqual([{ operation: 'approve', request: { projectId: 'p' } }])
    await expect(runEstimateOperation(async () => ({}), 'approve', {})).rejects.toMatchObject({ kind: ESTIMATE_ERROR.UNCERTAIN })
    await expect(runEstimateOperation(async () => { throw typed('estimate-busy') }, 'build', {})).rejects.toBeInstanceOf(EstimateError)
  })
})

describe('the generated bundle and the trusted surface', () => {
  const BUNDLE = readFileSync(ESTIMATING_BUNDLE_PATH, 'utf8')
  const strip = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  it('regenerating yields the committed file; the check script exists and CI runs it', async () => {
    expect(await buildEstimatingBundle()).toBe(BUNDLE)
    expect(BUNDLE.startsWith(ESTIMATING_BUNDLE_HEADER)).toBe(true)
    expect(JSON.parse(read('package.json')).scripts['functions:estimating-calc:check']).toBe('node scripts/build-estimating-bundle.mjs --check')
    expect(read('../azure-pipelines.yml')).toContain('- script: npm run functions:estimating-calc:check')
  })
  it('is self-contained, exports what the source exports, and computes the same results', () => {
    const code = strip(BUNDLE)
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(|import\.meta|\bwindow\.|\bdocument\.|localStorage|navigator\./)
    expect(BUNDLE).not.toMatch(/\/Users\/|[A-Z]:\\\\/)
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort())
    const a = server.buildEstimateLines({ boqItems: WORKED, itemInputs: WORKED_INPUTS, settings: WORKED_SETTINGS, currencyCode: 'AUD' })
    expect(a).toEqual(buildEstimateLines({ boqItems: WORKED, itemInputs: WORKED_INPUTS, settings: WORKED_SETTINGS, currencyCode: 'AUD' }))
    expect(server.estimateTotals(a.lines, WORKED_SETTINGS)).toEqual(estimateTotals(a.lines, WORKED_SETTINGS))
    expect(server.estimateSourceKey(WORKED)).toBe(estimateSourceKey(WORKED))
  })
  it('the backend has no arithmetic of its own, takes the company from the membership and rejects an unknown operation', () => {
    const ops = strip(read('functions/src/estimating/operations.js'))
    const contracts = strip(read('functions/src/estimating/contracts.js'))
    const handlers = strip(read('functions/src/estimating/handlers.js'))
    for (const src of [ops, contracts, handlers]) expect(src).not.toMatch(/roundMoney|toFixed|Math\.round|\* 100\b|\/ 100\b|\b0\.1\b/)
    expect(ops).toContain("import * as calc from '../generated/estimatingCalc.js'")
    expect(ops).toContain('scopeOf(db, profile.companyId, projectId)')
    expect(ops).not.toMatch(/companyId\s*[:=]\s*(request|data|input)\b/)
    expect(contracts).toContain('!Object.prototype.hasOwnProperty.call(PARSERS, data.operation)')
    expect(contracts).not.toMatch(/amount|rate\b|sellCents|quantity/)   // no request key carries a figure (components are validated through calc)
    expect(handlers).toContain('if (deps.config().enabled !== true) fail(CODE.ESTIMATE_DISABLED)')
    expect(handlers.indexOf('requireAuth(request)')).toBeLessThan(handlers.indexOf('parseEstimateOperation(request.data)'))
    expect(handlers).toContain('approve:       { run: approveEstimate,       roles: calc.ESTIMATE_APPROVER_ROLES }')
  })
  it('ONE callable, App Check enforced, the switch off by default and off in production', () => {
    const index = read('functions/src/index.js')
    expect(index).toContain('export const estimateOperation = onCall(ESTIMATE_CALL_OPTIONS,')
    const opts = index.slice(index.indexOf('export const ESTIMATE_CALL_OPTIONS'), index.indexOf('export const estimateOperation'))
    expect(opts).toMatch(/enforceAppCheck:\s*true/)
    expect(opts).toMatch(/region:\s*REGION/)
    expect(opts).not.toMatch(/secrets|serviceAccount/)
    expect(index).toContain('config: () => ({ enabled: ESTIMATING_ENABLED.value() })')
    expect(read('functions/src/lib/params.js')).toContain("export const ESTIMATING_ENABLED = defineBoolean('ESTIMATING_ENABLED', { default: false })")
    expect(read('functions/.env.constrapp-69b5d')).toMatch(/^ESTIMATING_ENABLED=false$/m)
    expect(read('functions/.env.demo-constrap-test')).toMatch(/^ESTIMATING_ENABLED=true$/m)
  })
  it('D3 — the approved selling price is a contract-value PREFILL carried in router state: nothing is written until the user saves or proposes', () => {
    const page = strip(read('src/pages/project/ProjectEstimate.jsx'))
    expect(page).toContain("navigate('../commercial', { state: { estimatePrefill:")
    const commercial = strip(read('src/pages/project/ProjectCommercial.jsx'))
    expect(commercial).toContain('state?.estimatePrefill')
    // The prefill only seeds form state (and a notice); no line that touches it saves, proposes or writes.
    const touching = commercial.split('\n').filter(l => l.includes('estimatePrefill'))
    expect(touching.length).toBeGreaterThan(0)
    for (const l of touching) expect(l).not.toMatch(/\b(save|propose)\w*\s*\(|setDoc|updateDoc|addDoc|httpsCallable|runTransaction/)
    expect(commercial).toMatch(/useState\(\(\) => \(estimatePrefill \? String\(estimatePrefill\.value\)/)
  })
  it('Rules: the estimate collections are read-only to clients; the page writes only through the callable', () => {
    const rules = read('firestore.rules')
    const block = rules.slice(rules.indexOf('estimates/{document=**}'), rules.indexOf('match /companies/{companyId}/projects/{projectId}/commercial/baseline'))
    expect(block.match(/allow read: if financialMember\(companyId\);/g)).toHaveLength(2)
    expect(block.match(/allow write: if false;/g)).toHaveLength(2)
    expect(rules).not.toMatch(/match [^\n]*estimateState/)
    const hook = strip(read('src/hooks/useEstimates.jsx'))
    expect(hook).not.toMatch(/setDoc|updateDoc|addDoc|deleteDoc|runTransaction|writeBatch/)
    const page = strip(read('src/pages/project/ProjectEstimate.jsx'))
    expect(page).not.toMatch(/firebase\/firestore|Math\.round|toFixed|\* 100\b|\/ 100\b/)   // hooks-only access; no arithmetic in the page
  })
})
