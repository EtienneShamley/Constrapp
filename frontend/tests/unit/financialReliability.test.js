import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  availableFigure, displayFigure, figureState, projectSnapshot,
  FIGURE_STATE, FIGURE_DEPENDENCIES, FORECAST_ROW_SOURCES, SNAPSHOT_SOURCES,
} from '../../src/lib/projectSnapshot'
import { projectForecastTotals, computeMargin, resolveBaselineClient } from '../../src/lib/margin'
import { buildForecastRows, composeForecastRow } from '../../src/lib/forecast'
import { CURRENCY_LOCK_EVIDENCE_SOURCES, monetaryLockReasons } from '../../src/lib/currency'
import { CREDIT_READ_ERROR_NOTICE, CREDIT_READ_UNAVAILABLE_NOTICE } from '../../src/lib/supplierCreditNotes'
import { formatCurrency } from '../../src/lib/formatters'

// ── Financial Loading & Error Reliability (ADR-44) ───────────────────────────
//
// Forecast, Commercial and Project Overview must never present incomplete
// financial data as authoritative:
//
//   loading            → "—"
//   failed read        → "Unavailable" (naming the source)
//   settled zero       → a real $0
//   settled value      → the selector's figure, unchanged
//
// Three layers are pinned here:
//   1. the dependency map is VERIFIED against the real selectors by
//      perturbation — every declared source moves its figure, and no
//      undeclared source does (so a figure can neither wait on, nor ignore,
//      the wrong source);
//   2. the availability states, credit-note failures, the currency-lock
//      evidence set and the baseline client-name rule, as pure functions;
//   3. the page wiring, as SOURCE STRUCTURE (the unit runner is plain Node
//      with no jsdom — the ADR-26 convention, as in loadingNotZero.test.js).

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const between = (src, from, to) => {
  const a = src.indexOf(from)
  const b = to ? src.indexOf(to, a + from.length) : src.length
  expect(a, `missing: ${from}`).toBeGreaterThan(-1)
  expect(b, `missing: ${to}`).toBeGreaterThan(-1)
  return src.slice(a, b)
}

// ── Fixtures: every source moves at least one figure ─────────────────────────

const inv1 = {
  id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
  status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD', poId: 'po1',
  lineItems: [
    { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 600, taxCode: 'gst', gstAmount: 60 },
    { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 400, taxCode: 'gst', gstAmount: 40 },
  ],
  retention: 0, retentionGst: 0, retentionTotal: 0,
  subtotal: 1000, gstTotal: 100, grossTotal: 1100, net: 1000, payableGst: 100, payableTotal: 1100,
  dueDate: '2026-01-31',
}

const SOURCES = {
  budgetLines: [
    { id: 'bl1', costCodeId: 'cc1', budgeted: 1000 },
    { id: 'bl2', costCodeId: 'cc2', budgeted: 500 },
    { id: 'bl5', costCodeId: 'cc5', budgeted: 300 },
  ],
  purchaseOrders: [
    { id: 'po1', status: 'sent', lineItems: [
      { costCodeId: 'cc1', lineTotal: 800 },
      { costCodeId: 'cc2', lineTotal: 400 },
    ] },
    { id: 'po3', status: 'sent', lineItems: [{ costCodeId: 'cc6', lineTotal: 90 }] },
  ],
  progressClaims: [
    { id: 'cl1', status: 'approved', poId: 'po2', lineItems: [{ costCodeId: 'cc4', approvedThisPeriod: 250 }] },
  ],
  supplierInvoices: [inv1],
  supplierCreditNotes: [{
    id: 'cn1', creditNumber: 'SCN-0001', status: 'posted', docType: 'credit_note',
    supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100',
    supplierId: 'sup1', supplierName: 'Ace Concrete', supplierCreditReference: 'CN-9',
    creditDate: '2026-02-01', reason: 'Over-claimed quantities',
    lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Credit', amount: 100, taxCode: 'gst', gstAmount: 10 }],
    subtotal: 100, gstTotal: 10, grossTotal: 110, currency: 'AUD',
  }],
  variations: [
    { id: 'v1', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] },
    { id: 'v2', variationType: 'client', status: 'submitted', submittedSubtotal: 300, lineItems: [] },
    { id: 'v3', variationType: 'supplier', status: 'approved', approvedSubtotal: 50,
      lineItems: [{ costCodeId: 'cc7', approvedAmount: 50 }] },
    { id: 'v4', variationType: 'supplier', status: 'submitted', submittedSubtotal: 70,
      lineItems: [{ costCodeId: 'cc2', submittedAmount: 70 }] },
  ],
  forecastLines: [
    { id: 'cc1', costCodeId: 'cc1', uncommittedCostToComplete: 150 },
    { id: 'cc2', costCodeId: 'cc2', uncommittedCostToComplete: null },
    { id: 'cc8', costCodeId: 'cc8', uncommittedCostToComplete: 40 },
  ],
  baseline: { originalContractValue: 10000, originalApprovedBudget: 1500 },
}
const PAGE_SOURCES = Object.keys(SOURCES)

const emptied = (source) => ({ ...SOURCES, [source]: source === 'baseline' ? null : [] })

// Every figure key the three tabs display, evaluated through the REAL
// selectors (projectForecastTotals / buildForecastRows / computeMargin).
function evaluate(sources) {
  const { baseline, ...rest } = sources
  const totals = projectForecastTotals(rest)
  const m = computeMargin({ baseline, variations: sources.variations, forecastFinalCost: totals.forecastFinalCost })
  const rows = buildForecastRows(rest).map(r => composeForecastRow(r, r.storedUncommittedCostToComplete))
  return {
    approvedBudget:            totals.budgeted,
    actual:                    totals.actual,
    remainingCommitted:        totals.remainingCommitted,
    forecastFinalCost:         [totals.forecastFinalCost, m.forecastFinalCost],
    varianceToBudget:          totals.varianceToBudget,
    margin:                    [m.forecastGrossProfit, m.forecastMarginPct],
    supplierVariationExposure: [
      totals.approvedSupplierVariations, totals.pendingSupplierVariationExposure,
      m.approvedSupplierVariations, m.pendingSupplierVariationExposure,
    ],
    forecastRows:              [rows, totals.lineCount, totals.unforecastedCount, totals.overBudgetCount],
    contractBaseline:          [m.originalContractValue, m.originalApprovedBudget, m.originalPlannedProfit, m.originalPlannedMarginPct],
    clientVariations:          [m.approvedClientVariations, m.pendingClientVariationExposure],
    currentContractSum:        [m.currentContractSum, m.forecastRevenue],
    marginMovement:            m.marginMovement,
  }
}
const PAGE_FIGURES = Object.keys(evaluate(SOURCES))
const FULL = evaluate(SOURCES)

describe('dependency map: verified against the real selectors (perturbation)', () => {
  it('every page figure has a declared dependency list', () => {
    for (const key of PAGE_FIGURES) expect(FIGURE_DEPENDENCIES[key], key).toBeInstanceOf(Array)
  })

  for (const key of PAGE_FIGURES) {
    it(`${key}: no UNDECLARED source moves it (it never ignores a source it reads)`, () => {
      for (const source of PAGE_SOURCES) {
        if (FIGURE_DEPENDENCIES[key].includes(source)) continue
        expect(evaluate(emptied(source))[key], `${source} moved ${key} but is not declared`).toEqual(FULL[key])
      }
    })

    it(`${key}: every DECLARED source moves it (it never waits on a source it does not read)`, () => {
      for (const source of FIGURE_DEPENDENCIES[key]) {
        expect(evaluate(emptied(source))[key], `${source} is declared for ${key} but never moves it`).not.toEqual(FULL[key])
      }
    })
  }

  it('the forecast row union is exactly the seven row sources (cost codes add no row)', () => {
    expect(FIGURE_DEPENDENCIES.forecastRows).toEqual(FORECAST_ROW_SOURCES)
    const withCodes = buildForecastRows({ ...SOURCES, costCodes: [{ id: 'cc99', code: '99', name: 'Unused', isActive: true }] })
    expect(withCodes.map(r => r.costCodeId)).toEqual(buildForecastRows(SOURCES).map(r => r.costCodeId))
  })
})

// ── Availability states ──────────────────────────────────────────────────────

const settled = (over = {}) => ({
  ...Object.fromEntries(PAGE_SOURCES.map(s => [s, { loading: false, error: false }])),
  ...over,
})
const money = (n) => formatCurrency(n, 'AUD')

describe('availability: loading → "—", failed → Unavailable, settled zero → $0', () => {
  for (const key of PAGE_FIGURES) {
    for (const dep of FIGURE_DEPENDENCIES[key]) {
      it(`${key}: ${dep} loading → "—" with no value`, () => {
        const f = availableFigure(key, 123, settled({ [dep]: { loading: true, error: false } }))
        expect(f.state).toBe(FIGURE_STATE.LOADING)
        expect(f.value).toBeNull()
        expect(displayFigure(f, money)).toBe('—')
      })
      it(`${key}: ${dep} failed → Unavailable, naming the source`, () => {
        const f = availableFigure(key, 123, settled({ [dep]: { loading: false, error: true } }))
        expect(f.state).toBe(FIGURE_STATE.UNAVAILABLE)
        expect(f.value).toBeNull()
        expect(f.failedSources).toContain(dep)
        expect(displayFigure(f, money)).toBe('Unavailable')
      })
    }
  }

  it('a settled genuine zero renders as a real $0, not a dash', () => {
    const empty = evaluate({ ...Object.fromEntries(PAGE_SOURCES.map(s => [s, []])), baseline: null })
    for (const key of ['approvedBudget', 'actual', 'remainingCommitted', 'varianceToBudget', 'marginMovement']) {
      const value = Array.isArray(empty[key]) ? empty[key][0] : empty[key]
      if (value === null) continue // marginMovement is null without a baseline OAB — rendered "—" by pct/money
      const f = availableFigure(key, value, settled())
      expect(f.state).toBe(FIGURE_STATE.READY)
      expect(displayFigure(f, money)).toBe(formatCurrency(0, 'AUD'))
    }
    const ffc = availableFigure('forecastFinalCost', empty.forecastFinalCost[0], settled())
    expect(displayFigure(ffc, money)).toBe(formatCurrency(0, 'AUD'))
  })

  it('a settled real value is the selector output, unchanged', () => {
    const f = availableFigure('forecastFinalCost', FULL.forecastFinalCost[0], settled())
    expect(f.value).toBe(FULL.forecastFinalCost[0])
    expect(displayFigure(f, money)).toBe(money(FULL.forecastFinalCost[0]))
  })

  it('one failed source never hides a figure that does not read it', () => {
    for (const source of PAGE_SOURCES) {
      const states = settled({ [source]: { loading: false, error: true } })
      for (const key of PAGE_FIGURES) {
        if (FIGURE_DEPENDENCIES[key].includes(source)) continue
        expect(availableFigure(key, 1, states).state, `${source} failing hid ${key}`).toBe(FIGURE_STATE.READY)
      }
    }
  })
})

describe('credit-note failure: dependent figures are Unavailable (D1), the rest stay ready', () => {
  const states = settled({ supplierCreditNotes: { loading: false, error: true } })
  const unavailable = ['actual', 'forecastFinalCost', 'varianceToBudget', 'margin', 'marginMovement', 'forecastRows']
  const ready = ['approvedBudget', 'remainingCommitted', 'supplierVariationExposure', 'contractBaseline', 'clientVariations', 'currentContractSum']

  it('every figure built on Actual is Unavailable — never a credit-less total', () => {
    for (const key of unavailable) expect(availableFigure(key, 1, states).state, key).toBe(FIGURE_STATE.UNAVAILABLE)
  })
  it('figures that do not read credit notes are unaffected', () => {
    for (const key of ready) expect(availableFigure(key, 1, states).state, key).toBe(FIGURE_STATE.READY)
  })
  it('the credits genuinely move those figures (the gate is not decorative)', () => {
    const noCredits = evaluate(emptied('supplierCreditNotes'))
    expect(noCredits.actual).not.toBe(FULL.actual)
    expect(noCredits.margin).not.toEqual(FULL.margin)
  })
  it('the tabs use the Unavailable notice; the Budget page notice no longer claims otherwise', () => {
    expect(CREDIT_READ_UNAVAILABLE_NOTICE).toContain('shown as Unavailable rather than as though no credits exist')
    expect(CREDIT_READ_ERROR_NOTICE).not.toContain('not shown as though')
    expect(CREDIT_READ_ERROR_NOTICE).toContain('calculated WITHOUT them')
    for (const page of ['ProjectForecast', 'ProjectCommercial', 'ProjectOverview']) {
      const src = read(`pages/project/${page}.jsx`)
      expect(src, page).toContain('CREDIT_READ_UNAVAILABLE_NOTICE')
      expect(src, page).not.toMatch(/\bCREDIT_READ_ERROR_NOTICE\b/)
    }
    expect(read('pages/project/ProjectBudget.jsx')).toContain('{CREDIT_READ_ERROR_NOTICE}')
  })
})

// ── Dashboard invariance ─────────────────────────────────────────────────────

describe('Dashboard: ADR-42 snapshot figures and dependencies are unchanged', () => {
  it('the eight original dependency lists are byte-identical', () => {
    const FFC = ['purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'forecastLines']
    expect(FIGURE_DEPENDENCIES.approvedBudget).toEqual(['budgetLines'])
    expect(FIGURE_DEPENDENCIES.actual).toEqual(['progressClaims', 'supplierInvoices', 'supplierCreditNotes'])
    expect(FIGURE_DEPENDENCIES.remainingCommitted).toEqual(['purchaseOrders', 'supplierInvoices'])
    expect(FIGURE_DEPENDENCIES.forecastFinalCost).toEqual(FFC)
    expect(FIGURE_DEPENDENCIES.varianceToBudget).toEqual(['budgetLines', ...FFC])
    expect(FIGURE_DEPENDENCIES.margin).toEqual(['baseline', 'variations', ...FFC])
    expect(FIGURE_DEPENDENCIES.remainingPayable).toEqual(['supplierInvoices', 'supplierPayments', 'supplierCreditNotes', 'retentionReleases'])
    expect(FIGURE_DEPENDENCIES.costComposition).toEqual(['budgetLines', ...FFC])
  })

  it('the snapshot returns the same figures, carrying the same selector values', () => {
    const states = Object.fromEntries(SNAPSHOT_SOURCES.map(s => [s, { loading: false, error: false }]))
    const s = projectSnapshot({ sources: { ...SOURCES, supplierPayments: [], retentionReleases: [] }, sourceStates: states, currencyCode: 'AUD' })
    expect(Object.keys(s).sort()).toEqual([
      'actual', 'approvedBudget', 'costComposition', 'currencyCode', 'forecastFinalCost',
      'margin', 'remainingCommitted', 'remainingPayable', 'varianceToBudget',
    ])
    expect(s.forecastFinalCost.value).toBe(FULL.forecastFinalCost[0])
    expect(s.margin.grossProfit).toBe(FULL.margin[0])
  })

  it('the Dashboard snapshot page is untouched by this change (no new import)', () => {
    const page = read('pages/dashboard/ProjectSnapshot.jsx')
    expect(page).not.toContain('availableFigure')
    expect(page).not.toContain('CREDIT_READ')
  })
})

// ── Currency-lock evidence ───────────────────────────────────────────────────

describe('currency lock: the selector waits for ALL evidence (D5)', () => {
  it('the evidence list is exactly monetaryLockReasons\' sources (all parameters but the project)', () => {
    const src = read('lib/currency.js')
    const params = src.match(/export function monetaryLockReasons\(\{([\s\S]*?)\} = \{\}\)/)[1]
    const names = [...params.matchAll(/^\s*(\w+)\s*=/gm)].map(m => m[1]).filter(n => n !== 'project')
    expect([...CURRENCY_LOCK_EVIDENCE_SOURCES].sort()).toEqual([...names].sort())
  })

  it('every listed source is genuine lock evidence on its own', () => {
    const one = {
      budgetLines: [{}], purchaseOrders: [{}], progressClaims: [{}], supplierInvoices: [{}],
      clientInvoices: [{}], clientReceipts: [{}], supplierPayments: [{}], variations: [{}],
      tenderBids: [{}], forecastLines: [{ uncommittedCostToComplete: 0 }], cashFlowLines: [{}],
      boqItems: [{ rate: 0 }], baseline: { originalContractValue: 0 },
    }
    for (const source of CURRENCY_LOCK_EVIDENCE_SOURCES) {
      expect(monetaryLockReasons({ [source]: one[source] }).length, source).toBe(1)
    }
  })

  it('a loading or failed evidence source keeps the selector closed — legacy project or not', () => {
    const ok = Object.fromEntries(CURRENCY_LOCK_EVIDENCE_SOURCES.map(s => [s, { loading: false, error: false }]))
    expect(figureState(CURRENCY_LOCK_EVIDENCE_SOURCES, ok).state).toBe(FIGURE_STATE.READY)
    for (const source of CURRENCY_LOCK_EVIDENCE_SOURCES) {
      expect(figureState(CURRENCY_LOCK_EVIDENCE_SOURCES, { ...ok, [source]: { loading: true, error: false } }).state).toBe(FIGURE_STATE.LOADING)
      expect(figureState(CURRENCY_LOCK_EVIDENCE_SOURCES, { ...ok, [source]: { loading: false, error: true } }).state).toBe(FIGURE_STATE.UNAVAILABLE)
    }
    // Missing state information is never success.
    expect(figureState(CURRENCY_LOCK_EVIDENCE_SOURCES, {}).state).toBe(FIGURE_STATE.UNAVAILABLE)
  })

  it('Overview wires every evidence source\'s flags into the currency card and gates both controls', () => {
    const src = stripComments(read('pages/project/ProjectOverview.jsx'))
    const shared = between(src, 'function ProjectFinancialCards(', 'return (')
    for (const source of CURRENCY_LOCK_EVIDENCE_SOURCES) {
      if (source === 'cashFlowLines') continue
      const flag = source === 'baseline' ? 'baseline' : source
      expect(shared, source).toMatch(new RegExp(`${source}:\\s*\\{ loading: ${flag}Loading,\\s*error: ${flag}Error \\}`))
    }
    const card = between(src, 'function ProjectCurrencyCard(', 'function ProjectFinancialCards(')
    expect(card).toContain('useCashFlowLines(projectId)')
    expect(card).toContain('figureState(CURRENCY_LOCK_EVIDENCE_SOURCES')
    expect(card).toContain('const evidenceReady = evidence.state === FIGURE_STATE.READY')
    expect(card).toContain('disabled={!evidenceReady}')
    expect(card).toContain('disabled={!evidenceReady || saving || choice === currencyCode}')
    expect(card).toMatch(/async function onSave\(\) \{\s*if \(!evidenceReady\) return/)
  })
})

// ── Baseline client name ─────────────────────────────────────────────────────

describe('baseline save never erases a client name its contact did not resolve', () => {
  const baseline = { clientId: 'c1', clientName: 'Acme Developments' }
  const contacts = [{ id: 'c1', displayName: 'Acme Developments Pty Ltd' }, { id: 'c2', displayName: 'Bravo' }]

  it('contacts loading / failed (empty list): the stored client keeps its stored name', () => {
    expect(resolveBaselineClient({ clientId: 'c1', baseline, clientContacts: [] }))
      .toEqual({ ok: true, clientId: 'c1', clientName: 'Acme Developments' })
  })
  it('a since-archived contact (filtered out) keeps the stored name too', () => {
    expect(resolveBaselineClient({ clientId: 'c1', baseline, clientContacts: [contacts[1]] }).clientName).toBe('Acme Developments')
  })
  it('a resolved contact snapshots its live name, exactly as before', () => {
    expect(resolveBaselineClient({ clientId: 'c1', baseline, clientContacts: contacts }).clientName).toBe('Acme Developments Pty Ltd')
    expect(resolveBaselineClient({ clientId: 'c2', baseline, clientContacts: contacts }))
      .toEqual({ ok: true, clientId: 'c2', clientName: 'Bravo' })
  })
  it('no selection clears the client, exactly as before', () => {
    expect(resolveBaselineClient({ clientId: '', baseline, clientContacts: contacts }))
      .toEqual({ ok: true, clientId: null, clientName: null })
  })
  it('an unresolved id that is NOT the stored client is refused, never written nameless', () => {
    expect(resolveBaselineClient({ clientId: 'c9', baseline, clientContacts: contacts }).ok).toBe(false)
    expect(resolveBaselineClient({ clientId: 'c9', baseline: null, clientContacts: [] }).ok).toBe(false)
  })
})

// ── Page structure ───────────────────────────────────────────────────────────

const FINANCIAL_HOOKS = [
  'useBudgetLines', 'usePurchaseOrders', 'useProgressClaims', 'useSupplierInvoices',
  'useSupplierCreditNotes', 'useVariations', 'useForecastLines', 'useProjectCommercial', 'useContacts',
  'useCostCodes',
]

describe('Forecast: role gate mounts no financial subscription for other roles (D2)', () => {
  const src = stripComments(read('pages/project/ProjectForecast.jsx'))
  const wrapper = between(src, 'export default function ProjectForecast()', 'function ForecastWorkspace(')
  const workspace = between(src, 'function ForecastWorkspace(')

  it('the exported page calls no financial hook and gates on the financial role', () => {
    for (const h of FINANCIAL_HOOKS) expect(wrapper, h).not.toMatch(new RegExp(`\\b${h}\\(`))
    expect(wrapper).toContain('if (profileLoading)')
    expect(wrapper).toContain('if (!isFinancialRole(profile?.role))')
    expect(wrapper.indexOf('isFinancialRole')).toBeLessThan(wrapper.indexOf('<ForecastWorkspace'))
    expect(wrapper).toContain('Forecast data is restricted')
  })

  it('the workspace mounts each project subscription with the project id, with its flags', () => {
    for (const [hook, name] of [
      ['useBudgetLines', 'budgetLines'], ['usePurchaseOrders', 'purchaseOrders'],
      ['useProgressClaims', 'progressClaims'], ['useSupplierInvoices', 'supplierInvoices'],
      ['useSupplierCreditNotes', 'supplierCreditNotes'], ['useVariations', 'variations'],
      ['useForecastLines', 'forecastLines'],
    ]) {
      expect(workspace).toMatch(new RegExp(`const \\{ ${name}, ${name}Loading, ${name}Error[^}]*\\}\\s*= ${hook}\\(projectId\\)`))
      expect(workspace).toMatch(new RegExp(`${name}:\\s*\\{ loading: ${name}Loading,\\s*error: ${name}Error \\}`))
    }
    expect(workspace).toMatch(/const \{ costCodes, costCodesLoading \}\s*= useCostCodes\(\)/)
  })
})

describe('Forecast: no money from unsettled or failed reads; editing waits for every input', () => {
  const src = stripComments(read('pages/project/ProjectForecast.jsx'))

  it('every summary card goes through availableFigure with its verified dependency key', () => {
    for (const [field, key] of [
      ['budgeted', 'approvedBudget'], ['actual', 'actual'], ['remainingCommitted', 'remainingCommitted'],
      ['forecastFinalCost', 'forecastFinalCost'], ['varianceToBudget', 'varianceToBudget'],
      ['approvedSupplierVariations', 'supplierVariationExposure'],
      ['pendingSupplierVariationExposure', 'supplierVariationExposure'],
    ]) {
      expect(src).toMatch(new RegExp(`${field}:\\s*fig\\('${key}', rollups\\.${field}\\)`))
    }
    expect(src).not.toMatch(/money\(rollups\./)
    expect(src).toContain('{displayFigure(figure, money)}')
  })

  it('the table and counts wait on the full row union and the cost-code names', () => {
    expect(src).toContain('const rows = figureState(FIGURE_DEPENDENCIES.forecastRows, sourceStates)')
    expect(src).toContain('const editable = rowsReady && !costCodesLoading')
    const table = between(src, '<Card padding={false}>', 'baseRows.length === 0 ?')
    expect(table.indexOf('rows.state === FIGURE_STATE.UNAVAILABLE')).toBeLessThan(table.indexOf('!editable ?'))
    expect(src).toContain("rows.state === FIGURE_STATE.LOADING\n            ? 'Loading forecast…'")
    expect(src).not.toContain('forecastLinesLoading ? (')
  })

  it('Save, Save all and Use remaining budget are disabled until every input is ready', () => {
    expect(src).toContain('disabled={!editable || dirtyRows.length === 0 || savingId !== null}')
    expect(src).toContain('disabled={!editable || rowSaving(row.costCodeId)}')
    expect(src).toMatch(/onClick=\{\(\) => applyRemainingBudget\(row\)\}\s*disabled=\{!editable\}/)
    expect(src).toMatch(/async function persist\(row\) \{\s*if \(!editable\) throw/)
    expect(src).toMatch(/async function saveAll\(\) \{\s*if \(!editable\) return/)
    expect(src).toContain('const applyRemainingBudget = (row) => editable &&')
  })

  it('once ready, the input overlay and composer are unchanged (ADR-43)', () => {
    expect(src).toContain('composeForecastRow(row, ctcForCalc)')
    expect(src).toContain("unforecasted: composed.unforecasted && trimmed === ''")
  })
})

describe('Commercial: role gate, per-figure availability, safe baseline form', () => {
  const src = stripComments(read('pages/project/ProjectCommercial.jsx'))
  const wrapper = between(src, 'export default function ProjectCommercial()', 'function CommercialWorkspace(')
  const workspace = between(src, 'function CommercialWorkspace(')
  const form = between(src, 'function BaselineForm(', 'export default function ProjectCommercial()')

  it('the exported page mounts no financial or contacts subscription', () => {
    for (const h of FINANCIAL_HOOKS) expect(wrapper, h).not.toMatch(new RegExp(`\\b${h}\\(`))
    expect(wrapper).toContain('if (!isFinancialRole(profile?.role))')
    expect(wrapper.indexOf('isFinancialRole')).toBeLessThan(wrapper.indexOf('<CommercialWorkspace'))
    expect(src).not.toMatch(/\bmid\b/)
  })

  it('the workspace subscribes with flags for every source its figures read', () => {
    for (const name of ['budgetLines', 'purchaseOrders', 'progressClaims', 'supplierInvoices', 'supplierCreditNotes', 'variations', 'forecastLines']) {
      expect(workspace).toMatch(new RegExp(`${name}:\\s*\\{ loading: ${name}Loading,\\s*error: ${name}Error \\}`))
    }
    expect(workspace).toMatch(/baseline:\s*\{ loading: baselineLoading,\s*error: baselineError \}/)
    expect(workspace).toContain('const { contacts, contactsLoading }')
  })

  it('no figure is printed with money() directly — every one goes through show()', () => {
    expect(workspace).not.toMatch(/money\(m\./)
    for (const [cell, key] of [
      ['ocvCell', 'contractBaseline'], ['ccsCell', 'currentContractSum'], ['revenueCell', 'currentContractSum'],
      ['ffcCell', 'forecastFinalCost'], ['profitCell', 'margin'], ['marginCell', 'margin'],
      ['oabCell', 'contractBaseline'], ['oppCell', 'contractBaseline'], ['opmCell', 'contractBaseline'],
      ['movementCell', 'marginMovement'], ['acvCell', 'clientVariations'], ['pcvCell', 'clientVariations'],
      ['asvCell', 'supplierVariationExposure'], ['psvCell', 'supplierVariationExposure'],
    ]) {
      expect(workspace).toMatch(new RegExp(`const ${cell}\\s*= show\\('${key}'`))
    }
    expect(workspace).toContain('if (needsBaseline && !established)')
    expect(workspace.indexOf('if (f.state !== FIGURE_STATE.READY)')).toBeLessThan(workspace.indexOf('if (needsBaseline && !established)'))
  })

  it('a failed baseline read is Unavailable — never "set a contract value"', () => {
    expect(workspace).toContain('{!baselineError && !established && (')
    expect(workspace).toContain('This does not mean the contract value has not been set.')
  })

  it('baseline Save is disabled on a baseline read failure and while contacts load (D3)', () => {
    expect(form).toContain('const saveBlocked = baselineError || contactsLoading')
    expect(form).toContain('disabled={saving || !ocvValid || saveBlocked}')
    expect(form).toMatch(/async function onSave\(\) \{\s*if \(saveBlocked\) return/)
    expect(form).not.toContain('you can still enter one below')
  })

  it('"Use current approved budget" waits for budget lines to settle cleanly', () => {
    expect(workspace).toContain("const budgetState = figureState(['budgetLines'], sourceStates)")
    expect(workspace).toContain('budgetReady={budgetState.state === FIGURE_STATE.READY}')
    expect(form).toMatch(/onClick=\{useCurrentBudget\}\s*disabled=\{!budgetReady\}/)
    expect(form).toMatch(/const useCurrentBudget = \(\) => \{\s*if \(!budgetReady\) return/)
    expect(form).toContain("{budgetReady ? money(currentApprovedBudget) : budgetUnavailable ? 'Unavailable' : '—'}")
  })

  it('the client name is resolved by resolveBaselineClient, never erased by a missing lookup', () => {
    expect(form).toContain('resolveBaselineClient({ clientId: form.clientId, baseline, clientContacts })')
    expect(form).toContain('clientName:             client.clientName,')
    expect(form).not.toMatch(/client \? client\.displayName : null/)
    expect(form).toContain('{storedClientUnresolved && (')
  })
})

describe('Overview: margin cards follow their dependencies; a baseline error is shown, not hidden', () => {
  const src = stripComments(read('pages/project/ProjectOverview.jsx'))
  const cards = between(src, 'function MarginCards(', 'function ProjectCurrencyCard(')

  it('hides the card only while loading or when cleanly not established', () => {
    expect(cards).toContain('if (baselineLoading) return null')
    expect(cards).toContain('if (!baselineError && !isBaselineEstablished(baseline)) return null')
    expect(cards).not.toContain('if (baselineLoading || !isBaselineEstablished(baseline)) return null')
  })

  it('every card goes through availableFigure with its verified key', () => {
    expect(cards).toContain("card('Current Contract Sum',  'currentContractSum', m.currentContractSum)")
    expect(cards).toContain("card('Forecast Final Cost',   'forecastFinalCost',  m.forecastFinalCost)")
    expect(cards).toContain("card('Forecast Gross Profit', 'margin',             m.forecastGrossProfit)")
    expect(cards).toContain("card('Forecast Margin %',     'margin',             m.forecastMarginPct, pct)")
    expect(cards).not.toMatch(/money\(m\./)
  })

  it('financial subscriptions stay behind the financial-role gate', () => {
    expect(src).toContain('{isFinancialRole(profile?.role) && (')
    const page = between(src, 'export default function ProjectOverview()')
    for (const h of FINANCIAL_HOOKS) expect(page, h).not.toMatch(new RegExp(`\\b${h}\\(`))
  })
})

describe('Project switching: local state cannot cross projects (D4)', () => {
  it('the project tab outlet is keyed by the project id', () => {
    expect(stripComments(read('layouts/ProjectDetailLayout.jsx')))
      .toContain('<Outlet key={projectId} context={{ project, projectId, currencyCode }} />')
  })

  it('the key is the route project id only, so tab and record navigation never remount', () => {
    const src = stripComments(read('layouts/ProjectDetailLayout.jsx'))
    expect(src).toContain('const { projectId } = useParams()')
    expect(src.match(/<Outlet\b/g)).toHaveLength(1)
  })

  it('unsaved Forecast edits live in the workspace, under that keyed outlet', () => {
    const src = stripComments(read('pages/project/ProjectForecast.jsx'))
    const workspace = between(src, 'function ForecastWorkspace(')
    expect(workspace).toContain('const [edits, setEdits]')
  })
})
