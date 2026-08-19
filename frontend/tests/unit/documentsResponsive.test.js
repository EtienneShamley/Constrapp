import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Documents & Drawings — responsive structure of the three registers ───────
//
// These assert the SOURCE STRUCTURE of the register views, not rendered DOM.
// The unit runner is deliberately plain Node with no jsdom and no
// testing-library (the ADR-26 convention), so a render test is not available
// without changing the runner — but the defect this guards against is purely
// structural, and a structural test catches it exactly.
//
// ⚠️ THE DEFECT BEING GUARDED. Every register table lives inside `Card`, which
// carries `overflow-hidden` for its rounded corners. A table wider than the
// Card therefore gets CLIPPED, not scrolled: the row actions (Open / Replace /
// Withdraw) sit off the right-hand edge and are unreachable at a narrow
// desktop or tablet width — the user has to physically widen the browser.
// Found in live acceptance on General Documents; all three registers had it.
//
// The fix is the pattern every other table in the app already uses: the table
// sits in its OWN `overflow-x-auto` container, so the overflow scrolls.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

const REGISTERS = [
  { label: 'General Documents', src: read('pages/project/ProjectGeneralDocuments.jsx') },
  { label: 'Drawings register', src: read('pages/project/ProjectDrawings.jsx') },
  { label: 'Revision History',  src: read('pages/project/documents/RevisionHistoryTable.jsx') },
]

// The class string of the innermost <div> opened before a given offset.
function enclosingDivClasses(src, offset) {
  const before = src.slice(0, offset)
  const open = before.lastIndexOf('<div className="')
  if (open === -1) return null
  const start = open + '<div className="'.length
  return src.slice(start, src.indexOf('"', start))
}

describe('every register table scrolls inside its own container', () => {
  for (const { label, src } of REGISTERS) {
    it(`${label}: each table is wrapped in an overflow-x-auto container`, () => {
      const offsets = []
      for (let i = src.indexOf('<table'); i !== -1; i = src.indexOf('<table', i + 1)) offsets.push(i)

      expect(offsets.length).toBeGreaterThan(0)
      for (const offset of offsets) {
        expect(enclosingDivClasses(src, offset)).toContain('overflow-x-auto')
      }
    })

    it(`${label}: the wrapper — not the table — carries the md breakpoint`, () => {
      // `hidden md:table` on the table itself was the broken shape: it left the
      // table as a direct child of the clipping Card with nothing to scroll in.
      expect(src).not.toContain('hidden md:table')
      expect(src).toContain('hidden md:block overflow-x-auto')
    })

    it(`${label}: the table has a min width, so actions are never crushed`, () => {
      expect(src).toMatch(/<table className="[^"]*min-w-\[\d+px\]/)
    })
  }
})

describe('below md the table is replaced by cards, not squeezed', () => {
  for (const { label, src } of REGISTERS) {
    it(`${label}: renders a md:hidden card list`, () => {
      expect(src).toContain('md:hidden')
    })
  }
})

// The mobile region is everything from the card list onward — the actions a
// phone user can reach without a table.
const mobileRegion = (src) => src.slice(src.indexOf('md:hidden'))

describe('every row action is reachable in the mobile card layout', () => {
  it('General Documents: Open, Replace and Withdraw all appear on the card', () => {
    const mobile = mobileRegion(REGISTERS[0].src)
    expect(mobile).toContain('>Open<')
    expect(mobile).toContain('>Replace<')
    expect(mobile).toContain('>Withdraw<')
  })

  it('Drawings register: the whole card links through to the drawing', () => {
    const mobile = mobileRegion(REGISTERS[1].src)
    expect(mobile).toContain('drawings/${d.id}')
  })

  it('Revision History: View and Withdraw both appear on the card', () => {
    const mobile = mobileRegion(REGISTERS[2].src)
    expect(mobile).toContain('>View<')
    expect(mobile).toContain('>Withdraw<')
  })
})

describe('the desktop action cluster stays on one line', () => {
  // A crushed column that wraps "With / draw" onto two lines is how the actions
  // became hard to hit in the first place.
  it('General Documents and Revision History pin their action row', () => {
    expect(REGISTERS[0].src).toContain('flex justify-end gap-2 whitespace-nowrap')
    expect(REGISTERS[2].src).toContain('flex justify-end gap-2 whitespace-nowrap')
  })
})
