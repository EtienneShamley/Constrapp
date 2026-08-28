import { describe, it, expect } from 'vitest'
import {
  PO_STATUS, PO_EDITABLE_STATUSES, PO_COMMITTED_STATUSES, canTransition,
  GST_RATE, roundMoney, lineTotal, poTotals,
  committedByCostCode, maturedCommittedByCostCode,
  EMPTY_PO_FORM_LINE, poLineToForm, buildPoLineItem, validatePoDraft,
} from '../../src/lib/purchaseOrders'
import { buildForecastRows } from '../../src/lib/forecast'
import { computeMargin, projectForecastTotals } from '../../src/lib/margin'

// ── Purchase Orders — draft editing (pure domain, ADR-36) ────────────────────
//
// No emulator, no React. These tests pin the shared CREATE / EDIT DRAFT line
// helpers, the header totals, the draft validation rules, the exact stored
// line shape and the update contract — and prove that editing a DRAFT PO
// changes no commercial figure, because draft POs are not counted anywhere
// until the existing counting point (sent / closed).

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

const COST_CODES = deepFreeze([
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '05-200', name: 'Steel',    isActive: true },
])

const storedLine = (o = {}) => ({
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
  qty: 10, unit: 'm3', unitPrice: 250, lineTotal: 2500, ...o,
})

const STORED_KEYS = ['costCodeId', 'costCodeName', 'description', 'qty', 'unit', 'unitPrice', 'lineTotal'].sort()
const FORM_KEYS   = ['costCodeId', 'description', 'qty', 'unit', 'unitPrice'].sort()

// ── poLineToForm ─────────────────────────────────────────────────────────────

describe('poLineToForm', () => {
  it('maps a full stored line to string form values with exactly the form keys', () => {
    const f = poLineToForm(storedLine())
    expect(f).toEqual({ costCodeId: 'cc1', description: 'Slab', qty: '10', unit: 'm3', unitPrice: '250' })
    expect(Object.keys(f).sort()).toEqual(FORM_KEYS)
    expect('lineTotal' in f).toBe(false)
    expect('costCodeName' in f).toBe(false)
  })

  it('turns numbers into strings, including decimals and 0 → "0"', () => {
    const f = poLineToForm(storedLine({ qty: 0, unitPrice: 12.5 }))
    expect(f.qty).toBe('0')
    expect(f.unitPrice).toBe('12.5')
  })

  it('turns null / undefined / empty numerics into ""', () => {
    expect(poLineToForm(storedLine({ qty: null, unitPrice: undefined })).qty).toBe('')
    expect(poLineToForm(storedLine({ qty: null, unitPrice: undefined })).unitPrice).toBe('')
    expect(poLineToForm(storedLine({ qty: '' })).qty).toBe('')
  })

  it('maps legacy / partial / malformed input to a safe blank line', () => {
    expect(poLineToForm({})).toEqual({ ...EMPTY_PO_FORM_LINE })
    expect(poLineToForm(null)).toEqual({ ...EMPTY_PO_FORM_LINE })
    expect(poLineToForm(undefined)).toEqual({ ...EMPTY_PO_FORM_LINE })
    expect(poLineToForm('nope')).toEqual({ ...EMPTY_PO_FORM_LINE })
    expect(poLineToForm(42)).toEqual({ ...EMPTY_PO_FORM_LINE })
    // Wrong-typed string fields fall back to '' rather than leaking objects.
    expect(poLineToForm({ costCodeId: 7, description: {}, unit: null })).toEqual({ ...EMPTY_PO_FORM_LINE })
  })

  it('does not mutate its input', () => {
    const src = deepFreeze(storedLine())
    expect(() => poLineToForm(src)).not.toThrow()
    expect(src).toEqual(storedLine())
  })

  it('EMPTY_PO_FORM_LINE is frozen and has exactly the form keys', () => {
    expect(Object.isFrozen(EMPTY_PO_FORM_LINE)).toBe(true)
    expect(Object.keys(EMPTY_PO_FORM_LINE).sort()).toEqual(FORM_KEYS)
    expect(Object.values(EMPTY_PO_FORM_LINE).every(v => v === '')).toBe(true)
  })
})

// ── buildPoLineItem ──────────────────────────────────────────────────────────

describe('buildPoLineItem', () => {
  it('parses numeric strings and derives lineTotal with the existing lineTotal()', () => {
    const li = buildPoLineItem({ costCodeId: 'cc1', description: 'Slab', qty: '10', unit: 'm3', unitPrice: '250' }, { costCodes: COST_CODES })
    expect(li).toEqual(storedLine())
    expect(li.lineTotal).toBe(lineTotal('10', '250'))
  })

  it('treats blank / non-numeric numerics as 0 — the existing create behaviour', () => {
    const li = buildPoLineItem({ costCodeId: 'cc1', description: '', qty: '', unit: '', unitPrice: 'abc' }, { costCodes: COST_CODES })
    expect(li.qty).toBe(0)
    expect(li.unitPrice).toBe(0)
    expect(li.lineTotal).toBe(0)
  })

  it('rounds lineTotal to cents', () => {
    const li = buildPoLineItem({ costCodeId: 'cc1', description: '', qty: '3', unit: '', unitPrice: '0.1' }, { costCodes: COST_CODES })
    expect(li.lineTotal).toBe(0.3)
    const li2 = buildPoLineItem({ costCodeId: 'cc1', description: '', qty: '1.005', unit: '', unitPrice: '100' }, { costCodes: COST_CODES })
    expect(li2.lineTotal).toBe(100.5)
  })

  it('re-snapshots costCodeName from the LIVE cost-code list, not from any stored value', () => {
    const li = buildPoLineItem({ costCodeId: 'cc2', description: '', qty: '1', unit: '', unitPrice: '1' }, { costCodes: COST_CODES })
    expect(li.costCodeName).toBe('05-200 — Steel')
    const renamed = [{ id: 'cc2', code: '05-200', name: 'Structural Steel' }]
    expect(buildPoLineItem({ costCodeId: 'cc2', qty: '1', unitPrice: '1' }, { costCodes: renamed }).costCodeName).toBe('05-200 — Structural Steel')
  })

  it('yields an empty costCodeName for an unknown cost code (validation then rejects it)', () => {
    const li = buildPoLineItem({ costCodeId: 'gone', description: '', qty: '1', unit: '', unitPrice: '1' }, { costCodes: COST_CODES })
    expect(li.costCodeId).toBe('gone')
    expect(li.costCodeName).toBe('')
    expect(buildPoLineItem({ costCodeId: 'cc1', qty: '1', unitPrice: '1' }).costCodeName).toBe('') // no list supplied
  })

  it('trims description and unit', () => {
    const li = buildPoLineItem({ costCodeId: 'cc1', description: '  Slab  ', qty: '1', unit: ' m3 ', unitPrice: '1' }, { costCodes: COST_CODES })
    expect(li.description).toBe('Slab')
    expect(li.unit).toBe('m3')
  })

  it('outputs exactly the stored PO line keys — no taxCode, no per-line GST', () => {
    const li = buildPoLineItem({ costCodeId: 'cc1', description: '', qty: '1', unit: '', unitPrice: '1', taxCode: 'gst', extra: 1 }, { costCodes: COST_CODES })
    expect(Object.keys(li).sort()).toEqual(STORED_KEYS)
  })

  it('handles malformed input safely', () => {
    expect(buildPoLineItem(null, { costCodes: COST_CODES })).toEqual({
      costCodeId: '', costCodeName: '', description: '', qty: 0, unit: '', unitPrice: 0, lineTotal: 0,
    })
    expect(buildPoLineItem({ costCodeId: 9, description: null, unit: undefined })).toEqual({
      costCodeId: '', costCodeName: '', description: '', qty: 0, unit: '', unitPrice: 0, lineTotal: 0,
    })
  })

  it('does not mutate its inputs', () => {
    const form = deepFreeze({ costCodeId: 'cc1', description: 'x', qty: '1', unit: 'ea', unitPrice: '2' })
    expect(() => buildPoLineItem(form, { costCodes: COST_CODES })).not.toThrow()
    expect(form).toEqual({ costCodeId: 'cc1', description: 'x', qty: '1', unit: 'ea', unitPrice: '2' })
  })
})

// ── poTotals ─────────────────────────────────────────────────────────────────

describe('poTotals', () => {
  it('derives subtotal, flat 10% GST and total from line totals', () => {
    const t = poTotals([storedLine({ lineTotal: 2500 }), storedLine({ lineTotal: 1000 })])
    expect(GST_RATE).toBe(0.1)
    expect(t).toEqual({ subtotal: 3500, gst: 350, total: 3850 })
  })

  it('rounds every figure to cents', () => {
    const t = poTotals([{ lineTotal: 0.1 }, { lineTotal: 0.2 }])
    expect(t.subtotal).toBe(0.3)
    expect(t.gst).toBe(0.03)
    expect(t.total).toBe(0.33)
    expect(poTotals([{ lineTotal: 33.33 }]).gst).toBe(3.33)
  })

  it('returns zeros for no lines', () => {
    expect(poTotals([])).toEqual({ subtotal: 0, gst: 0, total: 0 })
  })

  it('treats a missing / null lineTotal as 0', () => {
    expect(poTotals([{ lineTotal: 100 }, {}, { lineTotal: null }])).toEqual({ subtotal: 100, gst: 10, total: 110 })
  })

  it('ignores any caller-supplied header figures — totals come only from lines', () => {
    const lines = [storedLine({ lineTotal: 100 })]
    expect(poTotals(lines)).toEqual({ subtotal: 100, gst: 10, total: 110 })
  })
})

// ── validatePoDraft ──────────────────────────────────────────────────────────

describe('validatePoDraft', () => {
  it('rejects a draft with no lines', () => {
    expect(validatePoDraft({ lineItems: [] })).toBe('At least one line item is required')
    expect(validatePoDraft({})).toBe('At least one line item is required')
    expect(validatePoDraft({ lineItems: null })).toBe('At least one line item is required')
  })

  it('rejects a line without a cost code and identifies the correct (1-based) line', () => {
    const lines = [storedLine(), storedLine({ costCodeId: '' }), storedLine({ costCodeId: null })]
    expect(validatePoDraft({ lineItems: lines })).toBe('Line 2: a cost code is required')
    expect(validatePoDraft({ lineItems: [null, storedLine()] })).toBe('Line 1: a cost code is required')
  })

  it('accepts a valid draft — description, qty, unit and rate are NOT required', () => {
    expect(validatePoDraft({ lineItems: [storedLine({ description: '', qty: 0, unit: '', unitPrice: 0, lineTotal: 0 })] })).toBeNull()
  })

  it('when the live cost-code list is supplied, a stored line whose cost code no longer resolves blocks the save', () => {
    const lines = [storedLine(), storedLine({ costCodeId: 'removed', costCodeName: '99-999 — Old' })]
    expect(validatePoDraft({ lineItems: lines })).toBeNull()                          // hook path: id present
    expect(validatePoDraft({ lineItems: lines, costCodes: COST_CODES })).toBe('Line 2: choose a current cost code')
    expect(validatePoDraft({ lineItems: [storedLine()], costCodes: COST_CODES })).toBeNull()
  })

  it('does not mutate its input', () => {
    const lines = deepFreeze([storedLine()])
    expect(() => validatePoDraft({ lineItems: lines, costCodes: COST_CODES })).not.toThrow()
  })
})

// ── round-trip ───────────────────────────────────────────────────────────────

describe('round-trip stored → form → stored', () => {
  it('is the identity for a well-formed stored line', () => {
    const src = storedLine({ qty: 2.5, unitPrice: 19.99, lineTotal: 49.97, unit: 'ea' })
    expect(buildPoLineItem(poLineToForm(src), { costCodes: COST_CODES })).toEqual(src)
  })

  it('normalises a legacy line with a stale lineTotal and untrimmed text', () => {
    const src = storedLine({ description: ' Slab ', unit: ' m3 ', lineTotal: 999 })
    const out = buildPoLineItem(poLineToForm(src), { costCodes: COST_CODES })
    expect(out.lineTotal).toBe(2500)
    expect(out.description).toBe('Slab')
    expect(out.unit).toBe('m3')
  })
})

// ── editable statuses ────────────────────────────────────────────────────────

describe('PO_EDITABLE_STATUSES', () => {
  it('is exactly draft', () => {
    expect(PO_EDITABLE_STATUSES).toEqual([PO_STATUS.DRAFT])
    for (const s of [PO_STATUS.PENDING_APPROVAL, PO_STATUS.SENT, PO_STATUS.CLOSED, PO_STATUS.CANCELLED]) {
      expect(PO_EDITABLE_STATUSES.includes(s)).toBe(false)
    }
  })

  it('leaves the existing lifecycle untouched — no reopen, no new transition', () => {
    expect(canTransition(PO_STATUS.SENT, PO_STATUS.DRAFT)).toBe(false)
    expect(canTransition(PO_STATUS.CANCELLED, PO_STATUS.DRAFT)).toBe(false)
    expect(canTransition(PO_STATUS.CLOSED, PO_STATUS.DRAFT)).toBe(false)
    expect(canTransition(PO_STATUS.DRAFT, PO_STATUS.SENT)).toBe(true)
    expect(canTransition(PO_STATUS.DRAFT, PO_STATUS.CANCELLED)).toBe(true)
    expect(PO_COMMITTED_STATUSES).toEqual([PO_STATUS.SENT, PO_STATUS.CLOSED])
  })
})

// ── update-payload / immutable contract ──────────────────────────────────────
//
// Mirrors what usePurchaseOrders.updatePurchaseOrder writes: description, notes,
// rebuilt lines and re-derived header totals — nothing else. A pure replica so
// the contract is pinned without Firestore.

const draftUpdatePayload = ({ description, notes, lineItems }) => {
  const lines = lineItems.map(li => ({ ...li, lineTotal: lineTotal(li.qty, li.unitPrice) }))
  const { subtotal, gst, total } = poTotals(lines)
  return { description: description?.trim() || '', notes: notes?.trim() || '', lineItems: lines, subtotal, gst, total }
}

const IMMUTABLE = ['poNumber', 'status', 'supplierId', 'supplierName', 'currency', 'revision',
  'sentAt', 'closedAt', 'cancelledAt', 'externalRefs', 'createdAt', 'createdBy', 'id']

describe('draft edit — update payload contract', () => {
  it('contains only description, notes, lineItems and the three derived header totals', () => {
    const payload = draftUpdatePayload({
      description: ' Fixed ', notes: undefined,
      lineItems: [storedLine({ lineTotal: 1 }), storedLine({ costCodeId: 'cc2', qty: 2, unitPrice: 5, lineTotal: 999 })],
    })
    expect(Object.keys(payload).sort()).toEqual(['description', 'gst', 'lineItems', 'notes', 'subtotal', 'total'])
    for (const k of IMMUTABLE) expect(k in payload).toBe(false)
    expect(payload.description).toBe('Fixed')
    expect(payload.notes).toBe('')
  })

  it('rebuilds every lineTotal and re-derives the header — caller figures are never trusted', () => {
    const payload = draftUpdatePayload({
      description: '', notes: '',
      lineItems: [storedLine({ qty: 10, unitPrice: 250, lineTotal: 1 }), storedLine({ costCodeId: 'cc2', qty: 2, unitPrice: 5, lineTotal: 999 })],
    })
    expect(payload.lineItems.map(l => l.lineTotal)).toEqual([2500, 10])
    expect(payload).toMatchObject({ subtotal: 2510, gst: 251, total: 2761 })
  })

  it('merging the payload over a stored draft changes nothing immutable', () => {
    const stored = deepFreeze({
      id: 'po1', poNumber: 'PO-0007', status: 'draft', supplierId: null, supplierName: 'Legacy Supplies',
      description: 'Old', notes: 'n', lineItems: [storedLine()], subtotal: 2500, gst: 250, total: 2750,
      currency: 'AUD', revision: 1, sentAt: null, closedAt: null, cancelledAt: null, externalRefs: {},
      createdAt: 't0', createdBy: 'u1',
    })
    const after = { ...stored, ...draftUpdatePayload({ description: 'New', notes: 'm', lineItems: [storedLine({ qty: 1 })] }) }
    for (const k of IMMUTABLE) expect(after[k]).toEqual(stored[k])
    expect(after.supplierId).toBeNull()               // legacy supplierId: null survives an edit
    expect(after.supplierName).toBe('Legacy Supplies')
    expect(after.description).toBe('New')
    expect(after.total).toBe(275)
  })
})

// ── purity ───────────────────────────────────────────────────────────────────

describe('draft edit — purity', () => {
  it('none of the helpers mutate frozen inputs', () => {
    const stored = deepFreeze([storedLine(), storedLine({ costCodeId: 'cc2' })])
    const forms  = deepFreeze(stored.map(poLineToForm))
    expect(() => forms.map(f => buildPoLineItem(f, { costCodes: COST_CODES }))).not.toThrow()
    expect(() => validatePoDraft({ lineItems: stored, costCodes: COST_CODES })).not.toThrow()
    expect(() => poTotals(stored)).not.toThrow()
    expect(() => committedByCostCode([deepFreeze({ status: 'draft', lineItems: stored })])).not.toThrow()
  })
})

// ── financial regression — draft POs are not counted; sent POs are ───────────

describe('draft edit — financial regression (draft is never counted)', () => {
  const baseline = deepFreeze({ originalContractValue: 1_000_000, originalApprovedBudget: 800_000 })
  const budgetLines = deepFreeze([
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 100_000 },
    { costCodeId: 'cc2', costCodeName: '05-200 — Steel',    budgeted: 200_000 },
  ])
  const po = (o = {}) => ({
    id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.DRAFT, supplierId: 's1', supplierName: 'Acme',
    description: 'Slab', notes: '', currency: 'AUD', revision: 1,
    lineItems: [storedLine({ qty: 10, unitPrice: 250, lineTotal: 2500 })],
    subtotal: 2500, gst: 250, total: 2750, ...o,
  })
  const sentPo = po({ id: 'po-sent', poNumber: 'PO-0002', status: PO_STATUS.SENT,
    lineItems: [storedLine({ costCodeId: 'cc2', costCodeName: '05-200 — Steel', qty: 1, unitPrice: 4000, lineTotal: 4000 })],
    subtotal: 4000, gst: 400, total: 4400 })

  // Simulates the edit exactly as the hook writes it.
  const edited = (draft, formLines) => {
    const built = formLines.map(f => buildPoLineItem(f, { costCodes: COST_CODES }))
    return { ...draft, ...draftUpdatePayload({ description: 'Corrected', notes: 'x', lineItems: built }) }
  }

  const outputs = (purchaseOrders) => {
    const forecastTotals = projectForecastTotals({ costCodes: COST_CODES, budgetLines, purchaseOrders })
    const rows = buildForecastRows({ costCodes: COST_CODES, budgetLines, purchaseOrders })
    const m = computeMargin({ baseline, forecastFinalCost: forecastTotals.forecastFinalCost })
    return {
      committed: committedByCostCode(purchaseOrders),
      matured: maturedCommittedByCostCode(purchaseOrders, {}),
      rows: rows.map(r => [r.costCodeId, r.remainingCommitted, r.actual, r.closedResidualCommitted ?? null]).sort(),
      forecastRemainingCommitted: forecastTotals.remainingCommitted,
      forecastFinalCost: forecastTotals.forecastFinalCost,
      forecastGrossProfit: m.forecastGrossProfit,
      forecastMarginPct: m.forecastMarginPct,
    }
  }

  const bigEdit = [
    { costCodeId: 'cc2', description: 'moved to steel', qty: '4', unit: 't', unitPrice: '9999' },
    { costCodeId: 'cc1', description: 'added',          qty: '1', unit: 'ea', unitPrice: '123.45' },
  ]

  it('a draft PO contributes nothing to Committed, Forecast or Margin, before or after any edit', () => {
    const before = outputs([po(), sentPo])
    const draftAfter = edited(po(), bigEdit)
    const after = outputs([draftAfter, sentPo])

    expect(draftAfter.subtotal).toBe(40119.45)          // the edit really changed the draft
    expect(draftAfter.lineItems[0].costCodeId).toBe('cc2')
    expect(after).toEqual(before)                       // …and nothing derived moved
    expect(before.committed).toEqual({ cc2: 4000 })     // only the sent PO counts
    expect(before.matured).toEqual({ cc2: 4000 })
  })

  it('removing every draft line but one, or the draft PO altogether, is equally invisible', () => {
    const base = outputs([sentPo])
    expect(outputs([po(), sentPo])).toEqual(base)
    expect(outputs([edited(po(), [{ costCodeId: 'cc1', qty: '0', unitPrice: '0' }]), sentPo])).toEqual(base)
  })

  it('the SAME edit on a SENT PO does move Committed — pinning the counting point', () => {
    const sentBefore = po({ status: PO_STATUS.SENT })
    const before = outputs([sentBefore])
    const after  = outputs([edited(sentBefore, bigEdit)])
    expect(before.committed).toEqual({ cc1: 2500 })
    expect(after.committed).toEqual({ cc2: 39996, cc1: 123.45 })
    expect(after.forecastRemainingCommitted).toBe(roundMoney(39996 + 123.45))
    expect(after.forecastFinalCost).not.toBe(before.forecastFinalCost)
  })

  it('sending the edited draft commits exactly the edited ex-GST lines', () => {
    const draftAfter = edited(po(), bigEdit)
    expect(committedByCostCode([draftAfter])).toEqual({})
    const sent = { ...draftAfter, status: PO_STATUS.SENT }
    expect(committedByCostCode([sent])).toEqual({ cc2: 39996, cc1: 123.45 })
    expect(maturedCommittedByCostCode([sent], {})).toEqual({ cc2: 39996, cc1: 123.45 })
  })
})
