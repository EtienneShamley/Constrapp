import { describe, it, expect } from 'vitest'
import { TABBABLE_SELECTOR, isTabbable, tabbableWithin, tabTarget } from '../../src/lib/dialogFocus.js'

// ── lib/dialogFocus.js — keyboard containment decisions for a dialog ─────────
//
// Pure: elements are stand-in objects. The one DOM method the helpers call,
// `querySelectorAll`, is faked where needed.

const el = (name, over = {}) => ({ name, tabIndex: 0, disabled: false, hidden: false, getAttribute: () => null, ...over })

describe('isTabbable — which controls the Tab key would visit', () => {
  it('accepts an ordinary enabled control', () => {
    expect(isTabbable(el('button'))).toBe(true)
  })
  it('refuses a disabled control, a hidden one, tabindex="-1", a hidden input and aria-hidden', () => {
    expect(isTabbable(el('b', { disabled: true }))).toBe(false)
    expect(isTabbable(el('b', { hidden: true }))).toBe(false)
    expect(isTabbable(el('panel', { tabIndex: -1 }))).toBe(false)
    expect(isTabbable(el('i', { type: 'hidden' }))).toBe(false)
    expect(isTabbable(el('b', { getAttribute: (a) => (a === 'aria-hidden' ? 'true' : null) }))).toBe(false)
    expect(isTabbable(null)).toBe(false)
  })
  it('the selector names links with an href, the four form controls and anything with a tabindex', () => {
    expect(TABBABLE_SELECTOR).toBe('a[href], button, input, select, textarea, [tabindex]')
  })
})

describe('tabbableWithin — document order, filtered', () => {
  it('returns the tabbable descendants in the order the DOM gives them', () => {
    const a = el('a'), b = el('b', { disabled: true }), c = el('c')
    const root = { querySelectorAll: (sel) => { expect(sel).toBe(TABBABLE_SELECTOR); return [a, b, c] } }
    expect(tabbableWithin(root)).toEqual([a, c])
  })
  it('is empty for no root or a root without querySelectorAll', () => {
    expect(tabbableWithin(null)).toEqual([])
    expect(tabbableWithin({})).toEqual([])
  })
})

describe('tabTarget — wrap at the edges, pull stray focus back in, otherwise do not intercept', () => {
  const close = el('close'), check = el('check'), cancel = el('cancel'), apply = el('apply')
  const panel = el('panel', { tabIndex: -1 })
  const tabbable = [close, check, cancel, apply]

  it('Tab from the last control wraps to the first', () => {
    expect(tabTarget({ shiftKey: false, active: apply, tabbable })).toBe(close)
  })
  it('Shift+Tab from the first control wraps to the last', () => {
    expect(tabTarget({ shiftKey: true, active: close, tabbable })).toBe(apply)
  })
  it('between the edges the browser moves focus itself (null)', () => {
    expect(tabTarget({ shiftKey: false, active: check, tabbable })).toBeNull()
    expect(tabTarget({ shiftKey: true, active: cancel, tabbable })).toBeNull()
    expect(tabTarget({ shiftKey: false, active: close, tabbable })).toBeNull()
    expect(tabTarget({ shiftKey: true, active: apply, tabbable })).toBeNull()
  })
  it('focus on the panel itself (just opened) or behind the overlay is pulled to the first / last control', () => {
    const behind = el('behind')
    expect(tabTarget({ shiftKey: false, active: panel, tabbable })).toBe(close)
    expect(tabTarget({ shiftKey: true, active: panel, tabbable })).toBe(apply)
    expect(tabTarget({ shiftKey: false, active: behind, tabbable })).toBe(close)
    expect(tabTarget({ shiftKey: true, active: behind, tabbable })).toBe(apply)
    expect(tabTarget({ shiftKey: false, active: null, tabbable })).toBe(close)
  })
  it('a single control always receives focus on either direction', () => {
    expect(tabTarget({ shiftKey: false, active: close, tabbable: [close] })).toBe(close)
    expect(tabTarget({ shiftKey: true, active: close, tabbable: [close] })).toBe(close)
  })
  it('with nothing tabbable the fallback (the panel) keeps focus; without a fallback, null', () => {
    expect(tabTarget({ shiftKey: false, active: panel, tabbable: [], fallback: panel })).toBe(panel)
    expect(tabTarget({ shiftKey: true, active: panel, tabbable: [], fallback: panel })).toBe(panel)
    expect(tabTarget({ shiftKey: false, active: panel, tabbable: [] })).toBeNull()
    expect(tabTarget({ shiftKey: false, active: panel, tabbable: undefined, fallback: panel })).toBe(panel)
  })
})
