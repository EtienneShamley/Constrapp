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

describe('ProjectBudget: the summary card never prints a loading zero', () => {
  const src = read('pages/project/ProjectBudget.jsx')

  it('gates on every source its summary figures read', () => {
    const gate = src.match(/const summaryLoading = ([\s\S]*?)\n {2}const /)
    expect(gate).not.toBeNull()
    for (const flag of [
      'budgetLinesLoading', 'purchaseOrdersLoading', 'progressClaimsLoading',
      'supplierInvoicesLoading', 'supplierCreditNotesLoading', 'variationsLoading',
    ]) {
      expect(gate[1]).toContain(flag)
    }
  })

  it('renders the neutral em dash while loading', () => {
    expect(src).toMatch(/const summaryMoney = \(value\) => \(summaryLoading \? '—' : money\(value\)\)/)
  })

  it('routes all seven canonical/exposure figures through the gate', () => {
    for (const figure of [
      'totals.budgeted', 'totals.committed', 'totals.claimed', 'totals.actual',
      'remaining', 'totals.supplierVariations', 'commitmentExposure',
    ]) {
      expect(src).toContain(`{summaryMoney(${figure})}`)
      // The ungated spelling must not come back.
      expect(src).not.toContain(`{money(${figure})}`)
    }
  })

  it('still shows the Supplier Credit Notes unavailable notice on a read error', () => {
    expect(src).toContain('supplierCreditNotesError && (')
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
    ]) {
      expect(gate).toContain(flag)
    }
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
