import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Forecast table — "Use remaining budget" layout ───────────────────────────
//
// Like documentsResponsive.test.js, these assert the SOURCE STRUCTURE of the
// page, not rendered DOM: the unit runner is plain Node with no jsdom (the
// ADR-26 convention), and the defect is purely structural.
//
// ⚠️ THE DEFECT BEING GUARDED. Every Forecast cell inherits `whitespace-nowrap`
// from `tdCls`. In the Uncommitted Cost to Complete cell that forbade the line
// break between the full-width input and the inline "Use remaining budget"
// button, so the button sat BESIDE the input — past the cell's right edge —
// and was drawn over the Cost to Complete amounts. Measured in headless Chrome
// at 375 / 768 / 1280px: the button began exactly at the input's right edge.
//
// The fix: the cell wraps (`whitespace-normal`) and the button is block-level
// with a 44px touch target, so it always sits on its own line inside the cell.

const src = readFileSync(
  fileURLToPath(new URL('../../src/pages/project/ProjectForecast.jsx', import.meta.url)),
  'utf8',
)

const at = src.indexOf('Use remaining budget\n')

// The className of the innermost element of `tag` opened before `offset`.
function enclosingClasses(tag, offset) {
  const open = src.lastIndexOf(`<${tag}`, offset)
  const cls = src.indexOf('className=', open)
  const start = cls + 'className='.length
  // className="…" or className={`…`} (the template literal holds `${…}`)
  const [skip, close] = src[start] === '{' ? [2, '`}'] : [1, '"']
  return src.slice(start + skip, src.indexOf(close, start + skip))
}

describe('Forecast table — Use remaining budget action', () => {
  it('locates the action in the page source', () => {
    expect(at).toBeGreaterThan(-1)
  })

  it('sits in a cell that wraps, so the action cannot share the input line', () => {
    const td = enclosingClasses('td', at)
    expect(td).toContain('whitespace-normal')
    expect(td).toMatch(/min-w-\[\d+px\]/)
  })

  it('is a block-level button on its own line, never inline after the input', () => {
    const btn = enclosingClasses('button', at)
    expect(btn).toMatch(/(^|\s)(flex|block)(\s|$)/)
    expect(btn).toContain('w-full')
  })

  it('has a touch target of at least 44px', () => {
    expect(enclosingClasses('button', at)).toContain('min-h-[44px]')
  })

  it('keeps its behaviour: still the explicit copy action, disabled until editable', () => {
    const button = src.slice(src.lastIndexOf('<button', at), at)
    expect(button).toContain('onClick={() => applyRemainingBudget(row)}')
    expect(button).toContain('disabled={!editable}')
    expect(button).toContain('type="button"')
  })

  it('keeps horizontal overflow inside the table, not the page', () => {
    const table = src.indexOf('<table className="w-full border-collapse">')
    expect(table).toBeGreaterThan(-1)
    expect(src.slice(src.lastIndexOf('<div', table), table)).toContain('overflow-x-auto')
  })
})
