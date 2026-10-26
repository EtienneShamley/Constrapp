import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Loading is not a zero (ADR-41) ──────────────────────────────────────────
//
// Every financial figure in this app is DERIVED AT READ TIME from source
// documents. A subscription that has not settled yet contributes an empty
// array, so each derivation is arithmetically 0 — while actually meaning "not
// known yet". Rendering that as currency states a financial fact the app does
// not have, and on a cost register a fabricated zero is the most dangerous
// wrong answer available.
//
// THREE STATES, THREE RENDERINGS — they must never collapse into each other:
//
//   loading          → neutral: an em dash, or the page's loading placeholder
//   read failed      → "unavailable": the existing error banners and notices
//   settled and nil  → a real 0
//
// The keyed-snapshot migration (ADR-41) made the first state VISIBLE where it
// had previously been masked by the previous project's stale rows: before, a
// project switch showed project A's totals under project B's header; now the
// array is empty until B settles. Hiding a stale figure is correct — but the
// four pages below then derived summaries from `[]` and printed them as money.
// This file pins the gates that fix that.
//
// These assert SOURCE STRUCTURE, not rendered DOM: the unit runner is plain
// Node with no jsdom and no testing-library (the ADR-26 convention), following
// betaSurfaces.test.js and documentsResponsive.test.js.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

// The condition of the `if (…)` guard that returns `marker`, as one flat
// string. Anchoring on the RETURN rather than on a flag name is what keeps this
// from matching the hook destructure that mentions the same identifier.
const gateReturning = (src, marker) => {
  const at = src.indexOf(marker)
  if (at === -1) return null
  const open = src.lastIndexOf('if (', at)
  if (open === -1) return null
  const close = src.indexOf('{', open)
  if (close === -1 || close > at) return null
  return src.slice(open, close).replace(/\s+/g, ' ')
}

describe('ProjectBudget: no figure prints a loading OR failed zero (ADR-44 model, aligned by ADR-55)', () => {
  const src = read('pages/project/ProjectBudget.jsx')

  // Before ADR-55 this page gated on LOADING flags only and never read an error
  // flag, so a rules rejection of POs, claims, invoices or variations rendered a
  // settled $0 register. It now carries every source's flags in the Dashboard
  // snapshot's shape and routes each figure through figureState, exactly as
  // Forecast and Commercial do.
  it('destructures the loading AND error flag of every source it derives from', () => {
    for (const [hook, name] of [
      ['useBudgetLines', 'budgetLines'], ['usePurchaseOrders', 'purchaseOrders'],
      ['useProgressClaims', 'progressClaims'], ['useSupplierInvoices', 'supplierInvoices'],
      ['useSupplierCreditNotes', 'supplierCreditNotes'], ['useVariations', 'variations'],
    ]) {
      expect(src).toMatch(new RegExp(`const \\{ ${name}, ${name}Loading, ${name}Error[^}]*\\}\\s*= ${hook}\\(projectId\\)`))
      expect(src).toMatch(new RegExp(`${name}:\\s*\\{ loading: ${name}Loading,\\s*error: ${name}Error \\}`))
    }
    expect(src).toMatch(/const \{ costCodes, costCodesLoading, costCodesError \} = useCostCodes\(\)/)
  })

  it('routes every summary figure through availableFigure with its dependency key', () => {
    expect(src).toContain("const cell = (key, value, format = money) => displayFigure(availableFigure(key, value, sourceStates), format)")
    for (const [key, figure] of [
      ['approvedBudget', 'totals.budgeted'], ['remainingCommitted', 'totals.committed'],
      ['claimedExposure', 'totals.claimed'], ['actual', 'totals.actual'], ['remainingBudget', 'remaining'],
      ['supplierVariationExposure', 'totals.supplierVariations'], ['commitmentExposure', 'commitmentExposure'],
    ]) {
      expect(src).toContain(`{cell('${key}', ${figure})}`)
      // The ungated spellings must not come back.
      expect(src).not.toContain(`{money(${figure})}`)
      expect(src).not.toContain(`{summaryMoney(${figure})}`)
    }
    expect(src).not.toMatch(/summaryLoading|summaryMoney/)
  })

  it('table cells wait on their own sources too, and a failed budget-lines read is never an empty register', () => {
    for (const key of ['remainingCommitted', 'actual', 'invoiced', 'remainingBudget', 'supplierVariationExposure']) {
      expect(src).toContain(`rowCell('${key}',`)
    }
    expect(src).toContain(') : budgetLinesError ? (')
    expect(src).toContain('Budget lines unavailable')
  })

  it('names the failed sources in one banner and keeps the Supplier Credit Notes notice', () => {
    expect(src).toContain('pageSources.state === FIGURE_STATE.UNAVAILABLE && (')
    expect(src).toContain('supplierCreditNotesError && (')
    expect(src).toContain('{CREDIT_READ_ERROR_NOTICE}')
  })

  it('a failed cost-code read is reported, not read as "no cost codes"', () => {
    expect(src).toContain('const noCostCodes = !costCodesLoading && !costCodesError && selectableCostCodes.length === 0')
    expect(src).toContain('Cost codes could not be loaded')
  })
})

describe('ProjectRetention: the summary stats never print a loading zero', () => {
  const src = read('pages/project/ProjectRetention.jsx')

  it('suppresses figures while either source is loading', () => {
    expect(src).toMatch(/const figuresLoading = [^\n]*supplierInvoicesLoading/)
    expect(src).toMatch(/const figuresLoading = [^\n]*retentionReleasesLoading/)
    expect(src).toContain("const dash = (value) => (figuresUnavailable || figuresLoading ? '—' : value)")
  })

  it('leaves the unavailable meaning untouched — errors only', () => {
    // `figuresUnavailable` still drives the notice and the action disabling, and
    // is still built from the ERROR flags alone; loading must not leak into it.
    expect(src).toContain('const figuresUnavailable  = releasesUnavailable || invoicesUnavailable')
    expect(src).toContain('const releasesUnavailable = retentionReleasesError')
    expect(src).toContain('const invoicesUnavailable = supplierInvoicesError')
  })

  it('every summary figure goes through dash()', () => {
    for (const figure of [
      'summary?.retentionHeld', 'summary?.releasedToDate', 'summary?.totalWithheld',
    ]) {
      expect(src).toContain(`dash(money(${figure}))`)
    }
  })
})

describe('ProjectBoq: the Approved Budget never prints a loading zero', () => {
  const src = read('pages/project/ProjectBoq.jsx')

  it('passes the budget loading flag into SummaryCards', () => {
    expect(src).toContain('const { budgetLines, budgetLinesLoading, budgetLinesError } = useBudgetLines(mid)')
    expect(src).toContain('budgetLoading={budgetLinesLoading}')
    expect(src).toMatch(/function SummaryCards\(\{[^}]*budgetLoading[^}]*\}\)/)
  })

  it('dashes the budget total and the variance while loading', () => {
    expect(src).toContain("{budgetUnavailable || budgetLoading ? '—' : money(budgetTotal)}")
    expect(src).toContain("{variance === null || budgetUnavailable || budgetLoading ? '—' : money(variance)}")
  })

  it('keeps the failed-read sub-line on the ERROR state only', () => {
    // Loading and unavailable share the em dash but are not the same fact: only
    // a failed read says the budget failed to load.
    expect(src).toContain('{budgetUnavailable && <p className="m-0 mt-0.5 text-[10.5px] text-brand-red">Unavailable — budget failed to load</p>}')
  })
})

describe('ProjectCashFlow: no figure is derived before its sources settle', () => {
  const src = read('pages/project/ProjectCashFlow.jsx')
  const gate = gateReturning(src, 'Loading cash and forecast records…')

  it('the loading gate covers the cash side and the cost basis', () => {
    expect(gate).not.toBeNull()
    for (const flag of [
      // cash side — always gated
      'clientReceiptsLoading', 'supplierPaymentsLoading', 'clientInvoicesLoading',
      'cashFlowLinesLoading',
      // cost basis — added by ADR-41; these six fed margin and cost figures
      // from empty arrays while unsettled
      'budgetLinesLoading', 'forecastLinesLoading', 'purchaseOrdersLoading',
      'progressClaimsLoading', 'variationsLoading', 'supplierInvoicesLoading',
      // the three ADR-41 missed, added by ADR-43: unsettled, each one fed a
      // wrong figure (released retention absent from AP → trough understated;
      // credits absent → Actual/FFC/AP overstated; baseline absent → a false
      // "no baseline" and a false revenue-unavailable suppression reason)
      'supplierCreditNotesLoading', 'retentionReleasesLoading', 'baselineLoading',
    ]) {
      expect(gate).toContain(flag)
    }
  })

  it('destructures the three late-gated loading flags from their hooks (not just names them)', () => {
    expect(src).toMatch(/const \{ supplierCreditNotes, supplierCreditNotesLoading, supplierCreditNotesError \} = useSupplierCreditNotes\(mid\)/)
    expect(src).toMatch(/const \{ retentionReleases, retentionReleasesLoading, retentionReleasesError \} = useRetentionReleases\(mid\)/)
    expect(src).toMatch(/const \{ baseline, baselineLoading, baselineError \} = useProjectCommercial\(mid\)/)
  })

  it('never says "nothing left to time" over an incomplete cost basis', () => {
    // A zero basis made of unforecast codes is INCOMPLETE, not empty — the two
    // notices must be mutually exclusive in the source.
    expect(src).toContain("cstCov.state === 'no_cost_basis' && !cstCov.incompleteBasis && (")
    expect(src).not.toContain("cstCov.state === 'no_cost_basis' && (")
  })

  it('leaves the unavailable banners and their error flags untouched', () => {
    for (const flag of [
      'budgetLinesError', 'purchaseOrdersError', 'progressClaimsError',
      'supplierInvoicesError', 'variationsError', 'forecastLinesError',
    ]) {
      expect(src).toContain(flag)
    }
    expect(src).toContain('const costBasisSourceError = budgetLinesError || purchaseOrdersError || progressClaimsError')
  })
})
