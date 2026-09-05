import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Private-beta surface guards ──────────────────────────────────────────────
//
// Two regressions this file pins, both found in the beta-readiness assessment:
//
//   1. A register table that is a direct child of `Card` gets CLIPPED, not
//      scrolled — `Card` carries `overflow-hidden` for its rounded corners, so
//      the rightmost column (Actions, everywhere) becomes unreachable at a
//      narrow width. Four tables had this; the rest of the app already wraps.
//      Same defect and same guard shape as documentsResponsive.test.js.
//
//   2. Navigation that offers an unbuilt placeholder. Photos, Reports, PULSE™
//      and SHIELD™ are real routes with real placeholder pages, deliberately
//      kept — but a beta user must not be handed a tab or sidebar item that
//      leads to "Coming Soon".
//
// These assert SOURCE STRUCTURE, not rendered DOM: the unit runner is plain
// Node with no jsdom and no testing-library (the ADR-26 convention), and both
// defects are purely structural, so a structural test catches them exactly.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

// ── 1. Responsive tables ─────────────────────────────────────────────────────

// The class string of the innermost <div> opened before a given offset.
// (Same helper as documentsResponsive.test.js.)
function enclosingDivClasses(src, offset) {
  const before = src.slice(0, offset)
  const open = before.lastIndexOf('<div className="')
  if (open === -1) return null
  const start = open + '<div className="'.length
  return src.slice(start, src.indexOf('"', start))
}

const tableOffsets = (src) => {
  const offsets = []
  for (let i = src.indexOf('<table'); i !== -1; i = src.indexOf('<table', i + 1)) offsets.push(i)
  return offsets
}

// The four tables the assessment found sitting bare inside a Card, with the
// minimum width each needs so its Actions column is never crushed.
const REGISTERS = [
  { label: 'Dashboard projects',  src: read('pages/Dashboard.jsx'),                  minWidth: 820 },
  { label: 'Projects register',   src: read('pages/Projects.jsx'),                   minWidth: 860 },
  { label: 'Project Budget',      src: read('pages/project/ProjectBudget.jsx'),      minWidth: 980 },
  { label: 'Project Cost Codes',  src: read('pages/project/ProjectCostCodes.jsx'),   minWidth: 820 },
]

describe('every beta register table scrolls inside its own container', () => {
  for (const { label, src } of REGISTERS) {
    it(`${label}: each table is wrapped in an overflow-x-auto container`, () => {
      const offsets = tableOffsets(src)
      expect(offsets.length).toBeGreaterThan(0)
      for (const offset of offsets) {
        expect(enclosingDivClasses(src, offset)).toContain('overflow-x-auto')
      }
    })

    it(`${label}: the table has a min width, so the last column is never crushed`, () => {
      expect(src).toMatch(/<table className="[^"]*min-w-\[\d+px\]/)
    })
  }

  for (const { label, src, minWidth } of REGISTERS) {
    it(`${label}: keeps its assessed minimum width of ${minWidth}px`, () => {
      expect(src).toContain(`min-w-[${minWidth}px]`)
    })
  }
})

// The whole point of the wrapper is that the table is NOT a direct child of the
// clipping Card. `hidden md:table` on the table itself was the broken shape in
// the Documents registers; it must not reappear here.
describe('the wrapper — not the table — carries any breakpoint', () => {
  for (const { label, src } of REGISTERS) {
    it(`${label}: no 'hidden md:table' on the table element`, () => {
      expect(src).not.toContain('hidden md:table')
    })
  }
})

// ── 2. Beta navigation exposes nothing unbuilt ───────────────────────────────

const projectTabs = read('lib/projectTabs.js')
const nav         = read('lib/nav.js')

describe('project tabs offer no placeholder module', () => {
  it('Photos is not a tab', () => {
    expect(projectTabs).not.toMatch(/to:\s*'photos'/)
  })

  it('Reports is not a tab', () => {
    expect(projectTabs).not.toMatch(/to:\s*'reports'/)
  })

  // The tabs that must survive — so hiding two never quietly becomes hiding six.
  it('every shipped project module is still a tab', () => {
    for (const to of [
      'overview', 'boq', 'tenders', 'budget', 'cost-codes', 'purchase-orders',
      'progress-claims', 'invoices', 'forecasting', 'variations', 'commercial',
      'documents', 'timeline', 'rfis',
    ]) {
      expect(projectTabs).toMatch(new RegExp(`to:\\s*'${to}'`))
    }
  })
})

describe('the sidebar offers no placeholder module', () => {
  it('Constrapp PULSE™ is not in the sidebar', () => {
    expect(nav).not.toMatch(/to:\s*'\/pulse'/)
  })

  it('Constrapp SHIELD™ is not in the sidebar', () => {
    expect(nav).not.toMatch(/to:\s*'\/shield'/)
  })

  it('every shipped top-level page is still in the sidebar', () => {
    for (const to of ['/', '/projects', '/contacts', '/subcontractors']) {
      expect(nav).toMatch(new RegExp(`to:\\s*'${to.replace('/', '\\/')}'`))
    }
  })
})

// Hiding is not deleting: the routes and their placeholder pages stay, so a
// typed URL still resolves and the modules keep their place in the router.
describe('hidden surfaces keep their routes and pages', () => {
  const app = read('App.jsx')

  it('the photos and reports routes still exist', () => {
    expect(app).toContain('path="photos"')
    expect(app).toContain('path="reports"')
  })

  it('the pulse and shield routes still exist', () => {
    expect(app).toContain('path="pulse"')
    expect(app).toContain('path="shield"')
  })
})

// ── 3. No fabricated financial data on the Dashboard ─────────────────────────

// The figures below must be absent from the CODE, not from the file: the
// header comment in Dashboard.jsx names the numbers that were removed, and
// that record is worth keeping. Comments are stripped before asserting.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the Dashboard presents no fabricated data', () => {
  const dashboard = read('pages/Dashboard.jsx')
  const code = stripComments(dashboard)

  it('renders no chart, so no invented financial series can return', () => {
    expect(dashboard).not.toContain('recharts')
    expect(code).not.toContain('chartData')
    expect(code).not.toContain('donutData')
  })

  it('carries none of the removed hardcoded figures', () => {
    for (const literal of ["'68%'", "'29'", "'5'", '72%', 'placeholder data']) {
      expect(code).not.toContain(literal)
    }
  })

  it('offers exactly the two KPIs that are really derived', () => {
    expect(code).toContain("label: 'Active Projects', value: String(activeCount)")
    expect(code).toContain("label: 'Total Projects',  value: String(totalCount)")
  })

  it('still derives its counts from the live projects subscription', () => {
    expect(code).toContain("projects.filter(p => p.status === 'In Progress').length")
    expect(code).toContain('projects.length')
  })
})
