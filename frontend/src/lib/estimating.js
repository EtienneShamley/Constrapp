import { BOQ_STATUS, isPriced, boqLineAmount } from './boq'
import { toCents } from './payments'
import { shareOfCents, shareStep, MAX_SUPPORTED_AMOUNT_CENTS, MAX_SUPPORTED_AMOUNT_TEXT } from './money'
import { ESTIMATE_SOURCE_VERSION, fnvDigest, sourceItemKey, sourceKeyOfRows, estimateSourceKey } from './estimateSource'

// ── Estimating — the commercial pricing layer over the BOQ (ADR-97, D1–D3) ───
//
// Pure: no React, no Firebase, no clock. This module is the ONE description of
// how a priced Bill of Quantities becomes an ESTIMATE REVISION — an immutable,
// self-contained snapshot of the BOQ's cost with a commercial selling price.
// It runs in two places from the same source: the browser (preview and
// display) and the trusted `estimateOperation` callable, through the generated
// bundle `functions/src/generated/estimatingCalc.js`, which builds every
// stored figure from records it reads itself.
//
// NOT A SECOND BOQ AND NOT A BUDGET. An estimate authors NO quantity and NO
// rate: every line is a BOQ item as measured and priced on the BOQ tab
// (lib/boq.js). What an estimate adds is (a) how each cost code is CLASSIFIED,
// (b) how overhead and contingency are treated, (c) the pricing policy, and
// (d) — optionally, per item — how the unit rate breaks down into labour,
// material, plant and subcontractor components.
//
// ── Cost structure (everything in WHOLE CENTS, ex-GST) ───────────────────────
//
//   direct          Σ line amounts on cost codes not classified otherwise
//   preliminaries   Σ line amounts on cost codes classified `preliminaries`
//   construction    direct + preliminaries
//   overhead        mode `cost_coded`: Σ line amounts on cost codes classified
//                   `overhead` · mode `percentage`: construction × bps · `none`: 0
//   contingency     the same three modes, on the same base (construction)
//   cost total      construction + overhead + contingency
//
// NOTHING IS COUNTED TWICE: a mode is EXPLICIT. `percentage` is refused while
// any cost code is classified to that allowance; `cost_coded` and `none`
// require a zero percentage; `none` refuses a classified cost code. Both
// percentages apply to the SAME base (construction cost) — neither compounds
// on the other.
//
// ── Selling price (D2) ───────────────────────────────────────────────────────
//
//   markup_on_cost   sell = cost + cost × bps ÷ 10,000
//   margin_on_sell   sell = cost × 10,000 ÷ (10,000 − bps)      bps < 10,000
//
//   cost 100,000.00 · 20% markup → 120,000.00 · 20% margin → 125,000.00
//
// A margin of 100% or more has no selling price (the denominator is zero or
// negative) and is refused, as is any negative percentage. ROUNDING: one rule
// everywhere — round half up to the cent, in BigInt (no binary product).
//
// ── Rate components (optional, per item) ─────────────────────────────────────
//
// A unit rate may be broken down into labour / material / plant /
// subcontractor unit rates. The breakdown must SUM EXACTLY to the BOQ item's
// authoritative unit rate, compared in ten-thousandths of a currency unit
// (four decimals) — components never change a cost, they analyse one. A rate
// with more than four decimals cannot carry components. An item's AMOUNT is
// split across its components cumulatively (the last non-zero component takes
// the remainder), so component totals always add up to the line amount.
//
// ── A revision is SELF-CONTAINED (D1) ────────────────────────────────────────
//
// Each stored line keeps the item's id, number, section, description, unit,
// quantity, rate, amount, cost code and its name, cost class and components —
// enough to reconstruct the revision after the live BOQ changes. Lines are
// stored in bounded CHUNK documents (never one document holding the BOQ); the
// header keeps the pricing inputs, the totals, the line and chunk counts, the
// source key of the BOQ that was read, and a SHA-256 of the canonical content.

export const ESTIMATING_VERSION = 1

export const ESTIMATE_ROLES = ['company_admin', 'project_manager', 'qs']
// Approval is the Budget's and the Final Account's approving set (ADR-96:
// the strictest segregated workflows are open to these two roles).
export const ESTIMATE_APPROVER_ROLES = ['company_admin', 'project_manager']
export const canPrepareEstimate = (role) => ESTIMATE_ROLES.includes(role)
export const canApproveEstimate = (role) => ESTIMATE_APPROVER_ROLES.includes(role)

export const ESTIMATE_STATE = {
  BUILDING:  'building',    // a revision under construction — never approvable
  DRAFT:     'draft',
  APPROVED:  'approved',    // immutable
  DISCARDED: 'discarded',
}
export const ESTIMATE_STATE_LABELS = {
  [ESTIMATE_STATE.BUILDING]: 'Building', [ESTIMATE_STATE.DRAFT]: 'Draft',
  [ESTIMATE_STATE.APPROVED]: 'Approved', [ESTIMATE_STATE.DISCARDED]: 'Discarded',
}
export const ESTIMATE_BADGE_VARIANTS = {
  [ESTIMATE_STATE.BUILDING]: 'pending', [ESTIMATE_STATE.DRAFT]: 'pending',
  [ESTIMATE_STATE.APPROVED]: 'active', [ESTIMATE_STATE.DISCARDED]: 'danger',
}

export const PRICING_POLICY = { MARKUP_ON_COST: 'markup_on_cost', MARGIN_ON_SELL: 'margin_on_sell' }
export const PRICING_POLICY_LABELS = {
  [PRICING_POLICY.MARKUP_ON_COST]: 'Markup on cost',
  [PRICING_POLICY.MARGIN_ON_SELL]: 'Margin on selling price',
}
export const ALLOWANCE_MODE = { NONE: 'none', COST_CODED: 'cost_coded', PERCENTAGE: 'percentage' }
export const ALLOWANCE_MODE_LABELS = {
  [ALLOWANCE_MODE.NONE]: 'None', [ALLOWANCE_MODE.COST_CODED]: 'Cost-coded BOQ items', [ALLOWANCE_MODE.PERCENTAGE]: 'Percentage of construction cost',
}
export const COST_CLASS = { DIRECT: 'direct', PRELIMINARIES: 'preliminaries', OVERHEAD: 'overhead', CONTINGENCY: 'contingency' }
export const COST_CLASS_LABELS = {
  [COST_CLASS.DIRECT]: 'Direct cost', [COST_CLASS.PRELIMINARIES]: 'Preliminaries',
  [COST_CLASS.OVERHEAD]: 'Overhead', [COST_CLASS.CONTINGENCY]: 'Contingency',
}
// The classes a cost code can be GIVEN (direct is the default — never listed).
export const ASSIGNABLE_COST_CLASSES = [COST_CLASS.PRELIMINARIES, COST_CLASS.OVERHEAD, COST_CLASS.CONTINGENCY]

export const COMPONENT_KEYS = ['labour', 'material', 'plant', 'subcontractor']
export const COMPONENT_LABELS = { labour: 'Labour', material: 'Material', plant: 'Plant', subcontractor: 'Subcontractor' }

// ── Supported bounds (each with its reason) ──────────────────────────────────
export const BPS = 10_000
// A markup above 1,000% is not a pricing assumption anybody reviews as a
// percentage; refused as a likely keying error (10% entered as 1000 would be
// 100,000 bps — still refused only above this).
export const MAX_MARKUP_BPS = 100_000
// 99.99% — the largest margin with a positive denominator in whole basis points.
export const MAX_MARGIN_BPS = BPS - 1
// An allowance percentage above 100% of construction cost is refused.
export const MAX_ALLOWANCE_BPS = BPS
// The most ACTIVE BOQ items one revision holds; a larger register is refused
// by name, never truncated. Its reason is the revision's OWN cost, not another
// module's query bound: approval re-verifies the WHOLE stored revision inside
// ONE transaction (every chunk read, every line re-derived), and the build
// reads the whole register in one read-only transaction — both linear in N.
// At this bound, with every stored text at its maximum length in three-byte
// characters, the revision is ≤ ESTIMATE_MAX_ITEMS × LINE_MAX_BYTES ≈ 30 MB
// (bound, ≈ 75 chunks); the measured worst case (emulator — TESTING.md §88.6)
// keeps build and approval at a small fraction of the callable's 120 s and of
// Firestore's 270 s transaction lifetime. (It is also the ADR-81 transfer's
// register bound — which counts void items too — so a larger revision could
// not be handed over; that is a consequence, not the reason.)
export const ESTIMATE_MAX_ITEMS = 5000
// ── Stored text bounds (characters, i.e. UTF-16 code units) ──────────────────
// Display text over its bound is REFUSED (TEXT_TOO_LONG, naming the items) —
// never clipped: historical BOQ text is not truncated or rewritten (architect
// decision on D3 #53); the BOQ itself has no Rules bound on these fields. Text that is part of the SOURCE KEY is never
// clipped — an item exceeding its bound is refused (INVALID_SOURCE, "open and
// re-save the item"): ids (a BOQ item id, a cost code id) ≤ 128, the unit ≤ 40
// and the item number ≤ 40 (the BOQ Rules' own bounds), the currency ≤ 3.
export const ESTIMATE_DESCRIPTION_MAX = 1000
export const ESTIMATE_TEXT_MAX = 200
export const ESTIMATE_ITEM_NUMBER_MAX = 40
export const ESTIMATE_UNIT_MAX = 40
export const ESTIMATE_ID_MAX = 128
export const ESTIMATE_CURRENCY_MAX = 3
export const ESTIMATE_TITLE_MAX = 120
export const ESTIMATE_NOTES_MAX = 2000
export const ESTIMATE_MAX_CLASSES = 1000
export const SET_COMPONENTS_MAX_ITEMS = 200
// How many offending items a refusal names.
export const PROBLEM_SAMPLE = 20

export const ESTIMATE_PROBLEM = {
  EMPTY:                 'empty',
  TOO_LARGE:             'too-large',
  UNPRICED:              'unpriced',
  INVALID_SOURCE:        'invalid-source',
  CURRENCY_MISMATCH:     'currency-mismatch',
  COMPONENTS_UNRECONCILED: 'components-unreconciled',
  CLASS_UNUSED:          'class-unused',
  OUT_OF_RANGE:          'out-of-range',
  TEXT_TOO_LONG:         'text-too-long',
}
export const ESTIMATE_PROBLEM_LABELS = {
  [ESTIMATE_PROBLEM.EMPTY]:             'The BOQ has no active items to estimate.',
  [ESTIMATE_PROBLEM.TOO_LARGE]:         `The BOQ holds more than ${ESTIMATE_MAX_ITEMS.toLocaleString('en-AU')} items — more than one estimate revision supports.`,
  [ESTIMATE_PROBLEM.UNPRICED]:          'Some BOQ items have no rate. Price every item (0 is a price) before estimating.',
  [ESTIMATE_PROBLEM.INVALID_SOURCE]:    'A BOQ item has a quantity, rate or amount that cannot be used. Open and re-save the item.',
  [ESTIMATE_PROBLEM.CURRENCY_MISMATCH]: 'A BOQ item was priced in a different currency from the project.',
  [ESTIMATE_PROBLEM.COMPONENTS_UNRECONCILED]: 'A rate breakdown no longer adds up to its item’s unit rate. Correct or clear the breakdown.',
  [ESTIMATE_PROBLEM.CLASS_UNUSED]:      'A cost code is classified but has no active BOQ item.',
  [ESTIMATE_PROBLEM.OUT_OF_RANGE]:      `The estimate is larger than the supported maximum of ${MAX_SUPPORTED_AMOUNT_TEXT}.`,
  [ESTIMATE_PROBLEM.TEXT_TOO_LONG]:     `A BOQ item's text is longer than an estimate revision can store (description ${ESTIMATE_DESCRIPTION_MAX.toLocaleString('en-AU')}, section and cost-code name ${ESTIMATE_TEXT_MAX}, item number ${ESTIMATE_ITEM_NUMBER_MAX} characters). Constrap never shortens it for you — shorten it on the BOQ tab, then build again.`,
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isBps = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
export const centsToAmount = (cents) => cents / 100

// ── Percentages (exact; round half up to the cent) ───────────────────────────

// round-half-up(cents × bps ÷ 10,000), cents ≥ 0, bps ≥ 0.
export const percentOfCents = (cents, bps) => shareOfCents(cents, bps, BPS)

// The selling price of `costCents` under a policy, or { problem }.
export function sellingPriceCents(costCents, pricingPolicy, pricingBps) {
  if (!Number.isSafeInteger(costCents) || costCents < 0) return { problem: 'The cost total is not a whole, non-negative number of cents.' }
  if (pricingPolicy === PRICING_POLICY.MARKUP_ON_COST) {
    if (!isBps(pricingBps, MAX_MARKUP_BPS)) return { problem: `A markup must be between 0% and ${MAX_MARKUP_BPS / 100}%.` }
    return { sellCents: costCents + percentOfCents(costCents, pricingBps) }
  }
  if (pricingPolicy === PRICING_POLICY.MARGIN_ON_SELL) {
    if (!Number.isSafeInteger(pricingBps) || pricingBps < 0) return { problem: 'A margin cannot be negative.' }
    if (pricingBps >= BPS) return { problem: 'A margin of 100% or more of the selling price has no selling price. Enter a margin below 100%.' }
    // round-half-up(cost × 10,000 ÷ (10,000 − bps)) — BigInt, exact at any size.
    const d = BigInt(BPS - pricingBps)
    const sell = (2n * BigInt(costCents) * BigInt(BPS) + d) / (2n * d)
    if (sell > BigInt(Number.MAX_SAFE_INTEGER)) return { problem: ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.OUT_OF_RANGE] }
    return { sellCents: Number(sell) }
  }
  return { problem: 'Choose a pricing policy: markup on cost, or margin on selling price.' }
}

// The ACHIEVED markup and margin of a cost and a selling price, in basis
// points rounded half up, or null where the denominator is zero. Display only.
export function achievedBps(costCents, sellCents) {
  const profit = sellCents - costCents
  const ratio = (whole) => (whole > 0 && profit >= 0 ? shareOfCents(BPS, profit, whole) : null)
  return { markupBps: ratio(costCents), marginBps: ratio(sellCents) }
}

// ── Settings (the AUTHORED content of an estimate) ───────────────────────────

export const ESTIMATE_SETTINGS_KEYS = [
  'title', 'notes', 'pricingPolicy', 'pricingBps', 'overheadMode', 'overheadBps', 'contingencyMode', 'contingencyBps', 'costCodeClasses',
]

export const defaultEstimateSettings = () => ({
  title: '', notes: '', pricingPolicy: PRICING_POLICY.MARKUP_ON_COST, pricingBps: 0,
  overheadMode: ALLOWANCE_MODE.NONE, overheadBps: 0, contingencyMode: ALLOWANCE_MODE.NONE, contingencyBps: 0,
  costCodeClasses: [],
})

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

// Why these settings cannot be used, or null. The backend parser and the
// editor both call it.
export function estimateSettingsProblem(s) {
  if (!isObject(s) || Object.keys(s).length !== ESTIMATE_SETTINGS_KEYS.length || ESTIMATE_SETTINGS_KEYS.some(k => !(k in s))) return 'The estimate settings are incomplete.'
  if (typeof s.title !== 'string' || s.title.length > ESTIMATE_TITLE_MAX) return `The title must be at most ${ESTIMATE_TITLE_MAX} characters.`
  if (typeof s.notes !== 'string' || s.notes.length > ESTIMATE_NOTES_MAX) return `The notes must be at most ${ESTIMATE_NOTES_MAX} characters.`
  const price = sellingPriceCents(0, s.pricingPolicy, s.pricingBps)
  if (price.problem) return price.problem
  if (!Array.isArray(s.costCodeClasses) || s.costCodeClasses.length > ESTIMATE_MAX_CLASSES) return 'The cost code classification is not valid.'
  const seen = new Set()
  const used = new Set()
  for (const c of s.costCodeClasses) {
    if (!isObject(c) || Object.keys(c).length !== 2 || typeof c.costCodeId !== 'string' || !ID_RE.test(c.costCodeId) || !ASSIGNABLE_COST_CLASSES.includes(c.costClass)) return 'The cost code classification is not valid.'
    if (seen.has(c.costCodeId)) return 'A cost code is classified twice.'
    seen.add(c.costCodeId)
    used.add(c.costClass)
  }
  for (const [name, mode, bps, cls] of [
    ['Overhead', s.overheadMode, s.overheadBps, COST_CLASS.OVERHEAD],
    ['Contingency', s.contingencyMode, s.contingencyBps, COST_CLASS.CONTINGENCY],
  ]) {
    if (!Object.values(ALLOWANCE_MODE).includes(mode)) return `Choose how ${name.toLowerCase()} is treated.`
    if (!isBps(bps, MAX_ALLOWANCE_BPS)) return `${name} must be between 0% and ${MAX_ALLOWANCE_BPS / 100}%.`
    if (mode !== ALLOWANCE_MODE.PERCENTAGE && bps !== 0) return `${name} has a percentage but is not set to a percentage of construction cost.`
    if (mode !== ALLOWANCE_MODE.COST_CODED && used.has(cls)) {
      return mode === ALLOWANCE_MODE.PERCENTAGE
        ? `${name} is a percentage, but a cost code is also classified as ${name.toLowerCase()} — it would be counted twice. Choose one.`
        : `A cost code is classified as ${name.toLowerCase()}, but ${name.toLowerCase()} is set to none.`
    }
  }
  return null
}

// The settings as stored and digested: trimmed text, classes sorted by cost code.
export function normaliseEstimateSettings(s) {
  return {
    title: s.title.trim(), notes: s.notes.trim(), pricingPolicy: s.pricingPolicy, pricingBps: s.pricingBps,
    overheadMode: s.overheadMode, overheadBps: s.overheadBps, contingencyMode: s.contingencyMode, contingencyBps: s.contingencyBps,
    costCodeClasses: [...s.costCodeClasses].map(c => ({ costCodeId: c.costCodeId, costClass: c.costClass })).sort((a, b) => cmp(a.costCodeId, b.costCodeId)),
  }
}

// ── Rate components ──────────────────────────────────────────────────────────

const UNITS = 10_000   // ten-thousandths of a currency unit
// A non-negative number with at most four decimals, as whole ten-thousandths; else null.
export function rateUnits(v) {
  if (!isNumber(v) || v < 0) return null
  const scaled = v * UNITS
  const whole = Math.round(scaled)
  // Tolerance for the binary product only (never a fifth decimal: 0.00001 × 10,000 = 0.1).
  if (!Number.isSafeInteger(whole) || Math.abs(scaled - whole) > Math.max(1e-6, Math.abs(scaled) * 1e-12)) return null
  return whole
}

// Why a breakdown cannot be attached to an item whose unit rate is `rate`, or null.
export function componentsProblem(components, rate) {
  if (!isObject(components) || Object.keys(components).length !== COMPONENT_KEYS.length || COMPONENT_KEYS.some(k => !(k in components))) {
    return 'A rate breakdown names labour, material, plant and subcontractor (0 where there is none).'
  }
  let sum = 0
  for (const k of COMPONENT_KEYS) {
    const u = rateUnits(components[k])
    if (u === null) return `${COMPONENT_LABELS[k]} must be a non-negative rate with at most four decimals.`
    sum += u
  }
  const target = rateUnits(rate)
  if (target === null) return 'This item’s unit rate has more than four decimals (or is not priced), so it cannot carry a breakdown.'
  if (sum !== target) return `The breakdown adds up to ${(sum / UNITS).toFixed(4)}, not the unit rate of ${(target / UNITS).toFixed(4)}.`
  return null
}

// The line amount split across its components, in whole cents summing exactly
// to `amountCents` (cumulative shares; the last takes the remainder).
export function componentCents(amountCents, components) {
  const units = COMPONENT_KEYS.map(k => rateUnits(components[k]) ?? 0)
  const whole = units.reduce((s, u) => s + u, 0)
  const out = {}
  let part = 0
  let shared = 0
  COMPONENT_KEYS.forEach((k, i) => {
    part += units[i]
    const c = whole <= 0 ? 0 : shareStep(amountCents, part, whole, shared)
    out[k] = c
    shared += c
  })
  return out
}

// ── Lines ────────────────────────────────────────────────────────────────────

const clip = (v, max) => String(v ?? '').slice(0, max)
const validQuantity = (q) => isNumber(q) && q >= 0

function pricedItemCents(item) {
  if (!validQuantity(item.quantity) || !isNumber(item.rate) || item.rate < 0) return null
  if (!isNumber(item.amount) || item.amount < 0) return null
  const derived = boqLineAmount(item.quantity, item.rate)
  if (derived === null || toCents(derived) !== toCents(item.amount)) return null
  return toCents(item.amount)
}

// `boqItems` — the whole register; `itemInputs` — Map (or object) of item id →
// { components }; `settings` — normalised; `currencyCode` — the project's
// resolved currency. Returns
//   { problems: [{ kind, itemId, itemNumber, detail }], problemCounts, lines }
// `lines` (sorted by item id — the canonical order) is complete only when
// `problems` is empty.
export function buildEstimateLines({ boqItems = [], itemInputs = null, settings, currencyCode = null }) {
  const inputOf = (id) => (itemInputs instanceof Map ? itemInputs.get(id) : itemInputs?.[id]) ?? null
  const classOf = new Map(settings.costCodeClasses.map(c => [c.costCodeId, c.costClass]))
  const active = (boqItems ?? []).filter(i => i?.id && i.status === BOQ_STATUS.ACTIVE).sort((a, b) => cmp(a.id, b.id))
  const problems = []
  const note = (kind, item, detail = null) => problems.push({ kind, itemId: item?.id ?? null, itemNumber: clip(item?.itemNumber, 40), detail })
  if (active.length === 0) note(ESTIMATE_PROBLEM.EMPTY, null)
  if (active.length > ESTIMATE_MAX_ITEMS) note(ESTIMATE_PROBLEM.TOO_LARGE, null, String(active.length))
  const lines = []
  const usedCodes = new Set()
  for (const item of active) {
    if (typeof item.costCodeId !== 'string' || item.costCodeId === '' || item.costCodeId.length > ESTIMATE_ID_MAX) { note(ESTIMATE_PROBLEM.INVALID_SOURCE, item); continue }
    // Key text is stored unclipped, so it must be within its bound (see above).
    if (String(item.id).length > ESTIMATE_ID_MAX || String(item.unit ?? '').length > ESTIMATE_UNIT_MAX
      || (item.currency != null && (typeof item.currency !== 'string' || item.currency.length > ESTIMATE_CURRENCY_MAX))) { note(ESTIMATE_PROBLEM.INVALID_SOURCE, item); continue }
    if (!isPriced(item.rate)) { note(ESTIMATE_PROBLEM.UNPRICED, item); continue }
    const amountCents = pricedItemCents(item)
    if (amountCents === null) { note(ESTIMATE_PROBLEM.INVALID_SOURCE, item); continue }
    if (currencyCode && item.currency !== currencyCode) { note(ESTIMATE_PROBLEM.CURRENCY_MISMATCH, item); continue }
    // D3 #53: an item whose text an estimate cannot store is refused, not clipped.
    const tooLong = [['itemNumber', ESTIMATE_ITEM_NUMBER_MAX], ['section', ESTIMATE_TEXT_MAX], ['description', ESTIMATE_DESCRIPTION_MAX], ['costCodeName', ESTIMATE_TEXT_MAX]]
      .find(([k, max]) => String(item[k] ?? '').length > max)
    if (tooLong) { note(ESTIMATE_PROBLEM.TEXT_TOO_LONG, item, tooLong[0]); continue }
    const components = inputOf(item.id)?.components ?? null
    if (components !== null) {
      const bad = componentsProblem(components, item.rate)
      if (bad) { note(ESTIMATE_PROBLEM.COMPONENTS_UNRECONCILED, item, bad); continue }
    }
    const line = {
      itemId: item.id,
      itemNumber: String(item.itemNumber ?? ''),
      section: String(item.section ?? ''),
      description: String(item.description ?? ''),
      unit: String(item.unit ?? ''),   // never clipped: it is part of the source key (bounded above)
      quantity: item.quantity,
      rate: item.rate,
      amountCents,
      currency: item.currency ?? null,
      costCodeId: item.costCodeId,
      costCodeName: String(item.costCodeName ?? ''),
      costClass: classOf.get(item.costCodeId) ?? COST_CLASS.DIRECT,
      components: components === null ? null : Object.fromEntries(COMPONENT_KEYS.map(k => [k, components[k]])),
    }
    // Unreachable for a line within the bounds above; kept so the chunk byte
    // proof never depends on this function's field list staying in step.
    if (lineBytes(line) > LINE_MAX_BYTES) { note(ESTIMATE_PROBLEM.INVALID_SOURCE, item); continue }
    usedCodes.add(item.costCodeId)
    lines.push(line)
  }
  for (const c of settings.costCodeClasses) {
    if (!usedCodes.has(c.costCodeId) && problems.length === 0) problems.push({ kind: ESTIMATE_PROBLEM.CLASS_UNUSED, itemId: null, itemNumber: '', detail: c.costCodeId })
  }
  const problemCounts = {}
  for (const p of problems) problemCounts[p.kind] = (problemCounts[p.kind] ?? 0) + 1
  return { problems, problemCounts, lines }
}

// One sentence for a refused build.
export function describeEstimateProblems({ problems, problemCounts }) {
  if (!problems || problems.length === 0) return null
  const first = problems[0]
  const label = ESTIMATE_PROBLEM_LABELS[first.kind] ?? 'The BOQ cannot be estimated as it stands.'
  const named = problems.filter(p => p.kind === first.kind && p.itemNumber).slice(0, 5).map(p => p.itemNumber)
  const count = problemCounts?.[first.kind] ?? 1
  return `${label}${named.length > 0 ? ` (${count} item${count === 1 ? '' : 's'}: ${named.join(', ')}${count > named.length ? ', …' : ''})` : ''}`
}

// ── Totals ───────────────────────────────────────────────────────────────────

export const ESTIMATE_TOTAL_KEYS = [
  'directCents', 'preliminariesCents', 'constructionCents', 'overheadCents', 'contingencyCents', 'costTotalCents',
  'sellCents', 'grossProfitCents',
  'labourCents', 'materialCents', 'plantCents', 'subcontractorCents', 'unanalysedCents', 'boqTotalCents',
]

// The totals of complete `lines` under `settings`, or { problem }.
export function estimateTotals(lines, settings) {
  const byClass = { [COST_CLASS.DIRECT]: 0, [COST_CLASS.PRELIMINARIES]: 0, [COST_CLASS.OVERHEAD]: 0, [COST_CLASS.CONTINGENCY]: 0 }
  const comp = { labour: 0, material: 0, plant: 0, subcontractor: 0 }
  let unanalysed = 0
  let boqTotal = 0
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountCents) || l.amountCents < 0 || !(l.costClass in byClass)) return { problem: 'A line cannot be read as an amount.' }
    byClass[l.costClass] += l.amountCents
    boqTotal += l.amountCents
    if (l.components) {
      const split = componentCents(l.amountCents, l.components)
      for (const k of COMPONENT_KEYS) comp[k] += split[k]
    } else unanalysed += l.amountCents
  }
  const constructionCents = byClass.direct + byClass.preliminaries
  const allowance = (mode, bps, coded) => (mode === ALLOWANCE_MODE.COST_CODED ? coded : mode === ALLOWANCE_MODE.PERCENTAGE ? percentOfCents(constructionCents, bps) : 0)
  if (settings.overheadMode !== ALLOWANCE_MODE.COST_CODED && byClass.overhead !== 0) return { problem: 'Lines are classified as overhead, but overhead is not cost-coded.' }
  if (settings.contingencyMode !== ALLOWANCE_MODE.COST_CODED && byClass.contingency !== 0) return { problem: 'Lines are classified as contingency, but contingency is not cost-coded.' }
  const overheadCents = allowance(settings.overheadMode, settings.overheadBps, byClass.overhead)
  const contingencyCents = allowance(settings.contingencyMode, settings.contingencyBps, byClass.contingency)
  const costTotalCents = constructionCents + overheadCents + contingencyCents
  if (costTotalCents > MAX_SUPPORTED_AMOUNT_CENTS) return { problem: ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.OUT_OF_RANGE], kind: ESTIMATE_PROBLEM.OUT_OF_RANGE }
  const price = sellingPriceCents(costTotalCents, settings.pricingPolicy, settings.pricingBps)
  if (price.problem) return { problem: price.problem }
  if (price.sellCents > MAX_SUPPORTED_AMOUNT_CENTS) return { problem: ESTIMATE_PROBLEM_LABELS[ESTIMATE_PROBLEM.OUT_OF_RANGE], kind: ESTIMATE_PROBLEM.OUT_OF_RANGE }
  return {
    totals: {
      directCents: byClass.direct, preliminariesCents: byClass.preliminaries, constructionCents,
      overheadCents, contingencyCents, costTotalCents,
      sellCents: price.sellCents, grossProfitCents: price.sellCents - costTotalCents,
      labourCents: comp.labour, materialCents: comp.material, plantCents: comp.plant, subcontractorCents: comp.subcontractor,
      unanalysedCents: unanalysed, boqTotalCents: boqTotal,
    },
  }
}

export const sameTotals = (a, b) => ESTIMATE_TOTAL_KEYS.every(k => Number.isSafeInteger(a?.[k]) && a[k] === b?.[k])

// The cost-coded amount an ADR-81 transfer of the SAME BOQ carries into the
// working budget: every line (percentage allowances are not BOQ items and are
// not budget lines). Selling price is never a budget cost.
export const budgetHandoverCents = (totals) => totals.boqTotalCents

// Per cost code, for display: [{ costCodeId, costCodeName, costClass, itemCount, amountCents }].
export function estimateByCostCode(lines) {
  const map = new Map()
  for (const l of lines ?? []) {
    const e = map.get(l.costCodeId) ?? { costCodeId: l.costCodeId, costCodeName: l.costCodeName, costClass: l.costClass, itemCount: 0, amountCents: 0 }
    e.itemCount += 1
    e.amountCents += l.amountCents
    map.set(l.costCodeId, e)
  }
  return [...map.values()].sort((a, b) => cmp(a.costCodeName, b.costCodeName))
}

// ── Canonical content (what the SHA-256 on the header covers) ────────────────

const LINE_KEYS = ['itemId', 'itemNumber', 'section', 'description', 'unit', 'quantity', 'rate', 'amountCents', 'currency', 'costCodeId', 'costCodeName', 'costClass', 'components']

export const canonicalLine = (l) => JSON.stringify(LINE_KEYS.map(k => (k === 'components'
  ? (l.components ? COMPONENT_KEYS.map(c => l.components[c]) : null)
  : (l[k] ?? null))))

export const canonicalHeader = ({ currency, settings, totals, lineCount, sourceKey }) => JSON.stringify([
  ESTIMATING_VERSION, currency ?? null,
  [settings.pricingPolicy, settings.pricingBps, settings.overheadMode, settings.overheadBps, settings.contingencyMode, settings.contingencyBps,
    settings.costCodeClasses.map(c => [c.costCodeId, c.costClass])],
  ESTIMATE_TOTAL_KEYS.map(k => totals[k]), lineCount, sourceKey,
])

// The stored shape of a line is the built shape; this re-reads one defensively.
export function storedLineProblem(l) {
  if (!isObject(l) || typeof l.itemId !== 'string' || !Number.isSafeInteger(l.amountCents) || l.amountCents < 0) return 'A stored line cannot be read.'
  if (!isNumber(l.quantity) || !isNumber(l.rate) || typeof l.costCodeId !== 'string' || !Object.values(COST_CLASS).includes(l.costClass)) return 'A stored line cannot be read.'
  const derived = boqLineAmount(l.quantity, l.rate)
  if (derived === null || toCents(derived) !== l.amountCents) return `Line ${l.itemNumber || l.itemId} stores an amount that is not its quantity × rate.`
  if (l.components !== null && l.components !== undefined && componentsProblem(l.components, l.rate)) return `Line ${l.itemNumber || l.itemId} stores a rate breakdown that does not add up to its unit rate.`
  return null
}

// The source key of STORED lines — equal to estimateSourceKey(live register)
// exactly when the live active items are the ones stored.
export const sourceKeyOfLines = (lines) => sourceKeyOfRows((lines ?? []).map(l => sourceItemKey({
  id: l.itemId, quantity: l.quantity, rate: l.rate, amountCents: l.amountCents, unit: l.unit, currency: l.currency, costCodeId: l.costCodeId,
})))

// ── Chunks ───────────────────────────────────────────────────────────────────

//
// BYTES, PROVABLY. A chunk is bounded by an UPPER BOUND on its encoded size,
// never by a line count alone (a fixed number of lines has no fixed size).
// `encodedBytesBound(v)` is ≥ BOTH sizes Firestore applies:
//   · the documented STORAGE size (the 1 MiB document limit): a string is its
//     UTF-8 bytes + 1, a number 8, null / boolean 1, a map Σ (key bytes + 1 +
//     value), an array Σ values;
//   · the PROTOBUF size of the value in a commit request (the 10 MiB request
//     limit): every Value, map entry and array element carries a field tag
//     (≤ 2 bytes) and a length prefix (≤ 3 bytes below 2 MiB); a number is
//     ≤ 1 + 10 bytes. Worst cases: a string map entry 17 + key + text bytes,
//     a number map entry 23 + key, a string array element 9 + text bytes.
// It charges NODE (16) bytes for every value, map entry and array element on
// top of the UTF-8 bytes of its text (so ≥ 32 + key + text per string entry),
// and counts every UTF-16 code unit ≥ 0x800 as 3 bytes (a surrogate pair: 6 ≥
// its 4 bytes). Each line is at most LINE_MAX_BYTES (the bound of a line with
// every text at its maximum in three-byte characters — enforced when the line
// is built); a chunk's lines are at most CHUNK_MAX_BYTES; the rest of a chunk
// document (its name with the company id at Firestore's 1,500-byte id
// maximum, `index`, `count`, `runId`, the `lines` key, the 32-byte document
// overhead) is at most CHUNK_ENVELOPE_BYTES. So a chunk is ≤ 402,048 bytes:
// < 39% of 1 MiB; a transaction of CHUNKS_PER_TX (4) chunks plus its header
// read is < 1.7 MB: < 17% of 10 MiB, and 4 of the 500 writes allowed.
const NODE = 16
const utf8Bound = (str) => {
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}
export function encodedBytesBound(v) {
  if (typeof v === 'string') return NODE + utf8Bound(v)
  if (Array.isArray(v)) return v.reduce((s, x) => s + NODE + encodedBytesBound(x), NODE)
  if (isObject(v)) return Object.entries(v).reduce((s, [k, x]) => s + NODE + utf8Bound(k) + encodedBytesBound(x), NODE)
  return NODE   // number (8 stored, ≤ 11 encoded), boolean, null
}
// A line as an element of a chunk's `lines` array.
export const lineBytes = (line) => NODE + encodedBytesBound(line)

const widest = (n) => 'ࠀ'.repeat(n)   // the first three-byte UTF-8 character
// The largest line the build can produce (every text at its bound, three bytes
// per code unit, the longest cost class, a breakdown present).
export const LINE_MAX_BYTES = lineBytes({
  itemId: widest(ESTIMATE_ID_MAX), itemNumber: widest(ESTIMATE_ITEM_NUMBER_MAX), section: widest(ESTIMATE_TEXT_MAX),
  description: widest(ESTIMATE_DESCRIPTION_MAX), unit: widest(ESTIMATE_UNIT_MAX), quantity: 0, rate: 0, amountCents: 0,
  currency: widest(ESTIMATE_CURRENCY_MAX), costCodeId: widest(ESTIMATE_ID_MAX), costCodeName: widest(ESTIMATE_TEXT_MAX),
  costClass: COST_CLASS.PRELIMINARIES, components: Object.fromEntries(COMPONENT_KEYS.map(k => [k, 0])),
})
// The lines of one chunk: ≤ 250 AND ≤ 400,000 bound bytes (≥ 67 maximal lines).
export const CHUNK_MAX_LINES = 250
export const CHUNK_MAX_BYTES = 400_000
export const CHUNK_ENVELOPE_BYTES = 2_048
export const FIRESTORE_DOCUMENT_MAX_BYTES = 1_048_576
export const FIRESTORE_REQUEST_MAX_BYTES = 10_485_760

// Lines, in order, into chunks bounded by count AND by the encoded-size bound.
export function chunkEstimateLines(lines, { maxLines = CHUNK_MAX_LINES, maxBytes = CHUNK_MAX_BYTES } = {}) {
  const chunks = []
  let current = []
  let bytes = 0
  for (const line of lines) {
    const b = lineBytes(line)
    if (current.length > 0 && (current.length >= maxLines || bytes + b > maxBytes)) { chunks.push(current); current = []; bytes = 0 }
    current.push(line)
    bytes += b
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
export const chunkDocId = (index) => String(index).padStart(5, '0')

// ── Drift (live BOQ against a stored revision) ───────────────────────────────
//
// `matches` is the key comparison the backend also makes. The lists explain a
// difference to a person: items added since, removed (or voided) since, and
// changed in a figure that matters.
export function estimateDrift(lines, boqItems, storedSourceKey = null) {
  const liveKey = estimateSourceKey(boqItems)
  const stored = storedSourceKey ?? sourceKeyOfLines(lines)
  const live = new Map((boqItems ?? []).filter(i => i?.id && i.status === BOQ_STATUS.ACTIVE).map(i => [i.id, i]))
  const kept = new Map((lines ?? []).map(l => [l.itemId, l]))
  const added = []
  const removed = []
  const changed = []
  for (const [id, item] of live) {
    const line = kept.get(id)
    if (!line) { added.push({ itemId: id, itemNumber: item.itemNumber ?? '', description: item.description ?? '' }); continue }
    const liveCents = isPriced(item.rate) && isNumber(item.amount) ? toCents(item.amount) : null
    if (item.quantity !== line.quantity || (isPriced(item.rate) ? item.rate : null) !== line.rate || liveCents !== line.amountCents
      || String(item.unit ?? '') !== String(line.unit ?? '') || item.costCodeId !== line.costCodeId || (item.currency ?? null) !== (line.currency ?? null)) {
      changed.push({ itemId: id, itemNumber: item.itemNumber ?? line.itemNumber, description: line.description, fromCents: line.amountCents, toCents: liveCents })
    }
  }
  for (const [id, line] of kept) if (!live.has(id)) removed.push({ itemId: id, itemNumber: line.itemNumber, description: line.description, fromCents: line.amountCents })
  return { matches: liveKey === stored, liveKey, storedKey: stored, added, removed, changed }
}

// ── Request identity (idempotence) ───────────────────────────────────────────

// The key of ONE build request: the estimate, the revision it was made
// against and the settings. A repeat of a request already completed is
// answered already-applied whatever the BOQ has done since.
export const buildRequestKey = (estimateId, expectedRevision, settings) =>
  `${ESTIMATE_SOURCE_VERSION}r:${fnvDigest(JSON.stringify([estimateId, expectedRevision, normaliseEstimateSettings(settings)]))}`

export const formatEstimateNumber = (revisionNumber) => `EST-${String(revisionNumber).padStart(4, '0')}`

// The current approved revision of a project: the approved estimate with the
// highest revision number, or null.
export function currentApprovedEstimate(estimates) {
  let best = null
  for (const e of estimates ?? []) {
    if (e?.state === ESTIMATE_STATE.APPROVED && Number.isSafeInteger(e.revisionNumber) && (!best || e.revisionNumber > best.revisionNumber)) best = e
  }
  return best
}

// Basis points ⇄ the percentage a person types ("12.5" ⇄ 1250). Null when the
// text is not a percentage with at most two decimals.
export function percentTextToBps(text) {
  const t = String(text ?? '').trim()
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}
export const bpsToPercentText = (bps) => (Number.isSafeInteger(bps) ? (bps / 100).toFixed(2).replace(/\.?0+$/, '') : '')
export const formatBps = (bps) => (bps === null || bps === undefined ? '—' : `${(bps / 100).toFixed(2)}%`)

export { estimateSourceKey, isEstimateSourceKeyShape } from './estimateSource'
export { resolveProjectCurrency } from './currency'
export { MAX_SUPPORTED_AMOUNT_CENTS } from './money'
