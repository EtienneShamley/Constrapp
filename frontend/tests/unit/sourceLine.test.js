import { describe, it, expect } from 'vitest'
import {
  SOURCE_LINE_KIND, indexOrNull, isVariationOriginLine, sourceLineKind, sourceLineKey, poLineKey, variationLineKey,
  sourceLineLabel, variationLineCountOf, sourceLineIdentityError,
} from '../../src/lib/sourceLine'

// ── lib/sourceLine.js — the one notion of "which source line is this" (ADR-63) ─

const poLine  = (idx = 0, o = {}) => ({ poLineIndex: idx, costCodeId: 'cc1', claimedThisPeriod: 1, ...o })
const varLine = (variationId = 'sv1', idx = 0, o = {}) => ({ poLineIndex: null, variationId, variationNumber: 'SV-0001', variationLineIndex: idx, costCodeId: 'cc1', ...o })

describe('indexOrNull — a null index is NEVER coerced to 0', () => {
  it('accepts non-negative integers only', () => {
    expect(indexOrNull(0)).toBe(0)
    expect(indexOrNull(7)).toBe(7)
    for (const v of [null, undefined, '', '0', '3', 1.5, -1, NaN, Infinity, {}, [], true]) expect(indexOrNull(v), String(v)).toBeNull()
  })
})

describe('sourceLineKind', () => {
  it('a PO-origin line is an integer index with NO variation key (every pre-M3-B2 document)', () => {
    expect(sourceLineKind(poLine(0))).toBe(SOURCE_LINE_KIND.PO_LINE)
    expect(sourceLineKind(poLine(199))).toBe(SOURCE_LINE_KIND.PO_LINE)
    expect(sourceLineKind({ poLineIndex: 2, variationId: null })).toBe(SOURCE_LINE_KIND.PO_LINE)
    expect(sourceLineKind({ poLineIndex: 2, variationId: undefined })).toBe(SOURCE_LINE_KIND.PO_LINE)
  })

  it('a variation-origin line is a non-empty variationId with an integer variationLineIndex and a null / absent poLineIndex', () => {
    expect(sourceLineKind(varLine())).toBe(SOURCE_LINE_KIND.VARIATION_LINE)
    expect(sourceLineKind({ variationId: 'sv1', variationLineIndex: 3 })).toBe(SOURCE_LINE_KIND.VARIATION_LINE)
    expect(isVariationOriginLine(varLine())).toBe(true)
    expect(isVariationOriginLine(poLine())).toBe(false)
    expect(isVariationOriginLine({ variationId: '' })).toBe(false)
  })

  it('everything else is INVALID — never reinterpreted as PO line 0', () => {
    for (const li of [
      null, undefined, 'x', 42, {},
      { poLineIndex: null }, { poLineIndex: '0' }, { poLineIndex: -1 }, { poLineIndex: 1.5 },
      { variationId: 'sv1' },                                   // no line index
      { variationId: 'sv1', variationLineIndex: '0' },
      { variationId: 'sv1', variationLineIndex: 0, poLineIndex: 0 }, // BOTH identities
      { variationId: 7, poLineIndex: 0 },                      // non-string, non-null id
    ]) {
      expect(sourceLineKind(li), JSON.stringify(li)).toBe(SOURCE_LINE_KIND.INVALID)
    }
  })
})

describe('keys and labels', () => {
  it('keys are collision-safe between the two identities and stable', () => {
    expect(sourceLineKey(poLine(0), { poId: 'po1' })).toBe('po:po1:0')
    expect(sourceLineKey(varLine('sv1', 0))).toBe('var:sv1:0')
    expect(sourceLineKey(poLine(0), { poId: 'po1' })).not.toBe(sourceLineKey(varLine('po1', 0)))
    expect(poLineKey('po1', 3)).toBe('po:po1:3')
    expect(variationLineKey('sv1', 3)).toBe('var:sv1:3')
    expect(sourceLineKey({ poLineIndex: null })).toBeNull()
  })

  it('labels name the source for messages', () => {
    expect(sourceLineLabel(poLine(2))).toBe('PO line 3')
    expect(sourceLineLabel(varLine('sv1', 1))).toBe('SV-0001 line 2')
    expect(sourceLineLabel({ variationId: 'svX', variationLineIndex: 0 })).toBe('svX line 1')
    expect(sourceLineLabel({})).toBe('line with no valid source')
  })
})

describe('variationLineCountOf and sourceLineIdentityError', () => {
  it('counts only well-formed variation-origin lines', () => {
    expect(variationLineCountOf([poLine(0), poLine(1), varLine('sv1', 0), varLine('sv2', 1)])).toBe(2)
    expect(variationLineCountOf([poLine(0), { variationId: 'sv1' }])).toBe(0)
    expect(variationLineCountOf(null)).toBe(0)
  })

  it('a valid set: every line well-formed and no key twice', () => {
    expect(sourceLineIdentityError([poLine(0), poLine(1), varLine('sv1', 0), varLine('sv1', 1), varLine('sv2', 0)], { poId: 'po1' })).toBeNull()
    expect(sourceLineIdentityError([], { poId: 'po1' })).toBeNull()
  })

  it('refuses a malformed line, naming it, and a duplicated source line (PO or variation)', () => {
    expect(sourceLineIdentityError([poLine(0), { poLineIndex: null }], { poId: 'po1' })).toBe('Line 2: the source line identity is missing or malformed (it names neither a PO line nor a variation line)')
    expect(sourceLineIdentityError([poLine(0), poLine(0)], { poId: 'po1' })).toBe('Line 2: PO line 1 appears more than once — a source line may be claimed once per document')
    expect(sourceLineIdentityError([varLine('sv1', 0), poLine(3), varLine('sv1', 0)], { poId: 'po1' })).toMatch(/^Line 3: SV-0001 line 1 appears more than once/)
    // The same index on a PO line and a variation line is NOT a duplicate — different identities.
    expect(sourceLineIdentityError([poLine(0), varLine('sv1', 0)], { poId: 'po1' })).toBeNull()
  })
})
