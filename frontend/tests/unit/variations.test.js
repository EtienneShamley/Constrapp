import { describe, it, expect } from 'vitest'
import {
  VARIATION_TYPE, VARIATION_STATUS, VARIATION_EDITABLE_STATUSES,
  ORIGIN_RFI_STATUSES, UNLINKED_ORIGIN_RFI,
  isEligibleOriginRfi, normaliseOriginRfi, hasOriginRfi, eligibleOriginRfis,
  originRfiLabel, canEditOriginRfi, variationsForRfi,
  variationTotals,
  approvedSupplierVariationsByCostCode, pendingSupplierVariationExposureByCostCode,
  approvedSupplierVariationsTotal, pendingSupplierVariationExposureTotal,
  approvedClientVariationsTotal, pendingClientVariationExposureTotal,
  openVariationCount, duplicateVariationWarnings,
  TAX_CODE, EMPTY_VARIATION_FORM_LINE,
  variationLineToForm, buildVariationLineItem, validateVariationDraft, stripApprovedFromLines,
} from '../../src/lib/variations'
import { RFI_STATUS, RFI_STATUS_ORDER } from '../../src/lib/rfis'
import { computeMargin, projectForecastTotals } from '../../src/lib/margin'
import { buildForecastRows } from '../../src/lib/forecast'
import { invoiceableClientVariations, variationInvoicingRows, contractControl } from '../../src/lib/clientInvoices'

// ── Variations — originating RFI link (pure domain, ADR-34) ─────────────────
//
// No emulator, no React. The relationship is Variation → RFI only, in three
// scalar fields (originRfiId + frozen originRfiNumber / originRfiTitle). These
// tests pin the helpers that decide what is stored, which RFIs are offered,
// when the link may change, how it renders, and how the reverse view is
// derived — and prove the link is financially inert.

const rfi = (overrides = {}) => ({
  id: 'r1',
  rfiNumber: 'RFI-0012',
  status: RFI_STATUS.OPEN,
  title: 'Revised structural steel connection',
  question: 'Confirm the revised connection detail at grid C.',
  ...overrides,
})

const LINKED = {
  originRfiId:     'r1',
  originRfiNumber: 'RFI-0012',
  originRfiTitle:  'Revised structural steel connection',
}

const line = (overrides = {}) => ({
  costCodeId: 'cc1', costCodeName: '03-100 Concrete',
  description: 'Extra steel',
  submittedAmount: 1000, submittedGst: 100,
  approvedAmount: 900, approvedGst: 90,
  poLineIndex: null, taxCode: 'gst',
  ...overrides,
})

const variation = (overrides = {}) => ({
  id: 'v1',
  variationNumber: 'SV-0001',
  variationType: VARIATION_TYPE.SUPPLIER,
  status: VARIATION_STATUS.APPROVED,
  title: 'Additional steel',
  lineItems: [line()],
  submittedSubtotal: 1000, submittedGst: 100, submittedTotal: 1100,
  approvedSubtotal: 900, approvedGst: 90, approvedTotal: 990,
  ...overrides,
})

// ── Eligible statuses ────────────────────────────────────────────────────────

describe('ORIGIN_RFI_STATUSES', () => {
  it('is exactly open, answered and closed', () => {
    expect(ORIGIN_RFI_STATUSES).toEqual([RFI_STATUS.OPEN, RFI_STATUS.ANSWERED, RFI_STATUS.CLOSED])
  })

  it('excludes draft and cancelled', () => {
    expect(ORIGIN_RFI_STATUSES).not.toContain(RFI_STATUS.DRAFT)
    expect(ORIGIN_RFI_STATUSES).not.toContain(RFI_STATUS.CANCELLED)
  })

  it('every RFI status is classified one way or the other', () => {
    for (const s of RFI_STATUS_ORDER) {
      const expected = [RFI_STATUS.OPEN, RFI_STATUS.ANSWERED, RFI_STATUS.CLOSED].includes(s)
      expect(isEligibleOriginRfi(rfi({ status: s }))).toBe(expected)
    }
  })

  it('isEligibleOriginRfi rejects non-objects and unknown statuses', () => {
    expect(isEligibleOriginRfi(null)).toBe(false)
    expect(isEligibleOriginRfi(undefined)).toBe(false)
    expect(isEligibleOriginRfi('open')).toBe(false)
    expect(isEligibleOriginRfi(rfi({ status: 'reopened' }))).toBe(false)
  })
})

// ── normaliseOriginRfi ───────────────────────────────────────────────────────

describe('normaliseOriginRfi', () => {
  it('null / undefined / non-object → the unlinked all-null triple', () => {
    for (const input of [null, undefined, '', 0, 'r1', 42]) {
      expect(normaliseOriginRfi(input)).toEqual({ originRfiId: null, originRfiNumber: null, originRfiTitle: null })
    }
  })

  it('returns a fresh object each time, never the frozen constant', () => {
    const a = normaliseOriginRfi(null)
    const b = normaliseOriginRfi(null)
    expect(a).toEqual(UNLINKED_ORIGIN_RFI)
    expect(a).not.toBe(UNLINKED_ORIGIN_RFI)
    expect(a).not.toBe(b)
    expect(Object.isFrozen(a)).toBe(false)
  })

  it('a valid RFI → exact id / number / title snapshot and nothing else', () => {
    expect(normaliseOriginRfi(rfi())).toEqual(LINKED)
    expect(Object.keys(normaliseOriginRfi(rfi())).sort()).toEqual(['originRfiId', 'originRfiNumber', 'originRfiTitle'])
  })

  it('preserves the snapshots EXACTLY — no trim, truncation or reformatting', () => {
    const title  = '  A title with  odd   spacing and a very long tail '.padEnd(400, 'x') + '  '
    const number = 'RFI-000123'
    const out = normaliseOriginRfi(rfi({ title, rfiNumber: number }))
    expect(out.originRfiTitle).toBe(title)
    expect(out.originRfiNumber).toBe(number)
  })

  it('a partial or malformed RFI is never stored as a partial triple', () => {
    const cases = [
      rfi({ id: '' }),
      rfi({ id: null }),
      rfi({ id: undefined }),
      rfi({ rfiNumber: '' }),
      rfi({ rfiNumber: null }),
      rfi({ title: '' }),
      rfi({ title: null }),
      rfi({ id: 12 }),
      rfi({ title: ['x'] }),
      {},
    ]
    for (const c of cases) {
      expect(normaliseOriginRfi(c)).toEqual({ originRfiId: null, originRfiNumber: null, originRfiTitle: null })
    }
  })

  it('does not decide eligibility — that is isEligibleOriginRfi (a draft still normalises)', () => {
    expect(normaliseOriginRfi(rfi({ status: RFI_STATUS.DRAFT }))).toEqual(LINKED)
  })

  it('ignores every non-link RFI field', () => {
    const out = normaliseOriginRfi(rfi({ question: 'q', answer: 'a', costCodeId: 'cc', dueDate: '2026-01-01' }))
    expect(out).toEqual(LINKED)
  })

  it('does not mutate its input', () => {
    const input = rfi()
    const before = JSON.stringify(input)
    normaliseOriginRfi(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

// ── hasOriginRfi ─────────────────────────────────────────────────────────────

describe('hasOriginRfi', () => {
  it('true only for a non-empty string id', () => {
    expect(hasOriginRfi(variation(LINKED))).toBe(true)
    expect(hasOriginRfi(variation({ ...UNLINKED_ORIGIN_RFI }))).toBe(false)
    expect(hasOriginRfi(variation({ originRfiId: '' }))).toBe(false)
    expect(hasOriginRfi(variation({ originRfiId: 7 }))).toBe(false)
  })

  it('a legacy variation with the keys ABSENT is unlinked', () => {
    const legacy = variation()
    expect('originRfiId' in legacy).toBe(false)
    expect(hasOriginRfi(legacy)).toBe(false)
    expect(hasOriginRfi(null)).toBe(false)
    expect(hasOriginRfi(undefined)).toBe(false)
  })
})

// ── eligibleOriginRfis ───────────────────────────────────────────────────────

describe('eligibleOriginRfis', () => {
  const all = [
    rfi({ id: 'c', rfiNumber: 'RFI-0003', status: RFI_STATUS.CLOSED }),
    rfi({ id: 'x', rfiNumber: 'RFI-0005', status: RFI_STATUS.CANCELLED }),
    rfi({ id: 'a', rfiNumber: 'RFI-0001', status: RFI_STATUS.OPEN }),
    rfi({ id: 'd', rfiNumber: 'RFI-0004', status: RFI_STATUS.DRAFT }),
    rfi({ id: 'b', rfiNumber: 'RFI-0002', status: RFI_STATUS.ANSWERED }),
  ]

  it('keeps open, answered and closed; drops draft and cancelled', () => {
    expect(eligibleOriginRfis(all).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('orders by RFI number regardless of input order (deterministic)', () => {
    const reversed = all.slice().reverse()
    expect(eligibleOriginRfis(reversed).map(r => r.rfiNumber)).toEqual(['RFI-0001', 'RFI-0002', 'RFI-0003'])
    expect(eligibleOriginRfis(all)).toEqual(eligibleOriginRfis(reversed))
  })

  it('breaks a number tie by id so the order is total', () => {
    const tie = [
      rfi({ id: 'z', rfiNumber: 'RFI-0001' }),
      rfi({ id: 'y', rfiNumber: 'RFI-0001' }),
    ]
    expect(eligibleOriginRfis(tie).map(r => r.id)).toEqual(['y', 'z'])
  })

  it('handles empty, null and undefined input', () => {
    expect(eligibleOriginRfis([])).toEqual([])
    expect(eligibleOriginRfis(null)).toEqual([])
    expect(eligibleOriginRfis(undefined)).toEqual([])
  })

  it('tolerates junk entries', () => {
    expect(eligibleOriginRfis([null, undefined, 'open', rfi()]).map(r => r.id)).toEqual(['r1'])
  })

  it('returns a new array and never reorders or mutates the input', () => {
    const input = all.slice()
    const before = JSON.stringify(input)
    const out = eligibleOriginRfis(input)
    expect(out).not.toBe(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(out[0]).toBe(all[2]) // same object references, no cloning needed
  })
})

// ── originRfiLabel ───────────────────────────────────────────────────────────

describe('originRfiLabel', () => {
  it('renders "NUMBER — TITLE" for a linked variation', () => {
    expect(originRfiLabel(variation(LINKED))).toBe('RFI-0012 — Revised structural steel connection')
  })

  it('composes with normaliseOriginRfi for an RFI option label', () => {
    expect(originRfiLabel(normaliseOriginRfi(rfi()))).toBe('RFI-0012 — Revised structural steel connection')
  })

  it('null for an unlinked or legacy variation', () => {
    expect(originRfiLabel(variation({ ...UNLINKED_ORIGIN_RFI }))).toBeNull()
    expect(originRfiLabel(variation())).toBeNull()
    expect(originRfiLabel(null)).toBeNull()
  })

  it('degrades to the number alone if the title snapshot is empty, and to the id if both are', () => {
    expect(originRfiLabel(variation({ ...LINKED, originRfiTitle: '' }))).toBe('RFI-0012')
    expect(originRfiLabel(variation({ ...LINKED, originRfiTitle: null }))).toBe('RFI-0012')
    expect(originRfiLabel(variation({ originRfiId: 'r9', originRfiNumber: null, originRfiTitle: null }))).toBe('r9')
  })
})

// ── canEditOriginRfi ─────────────────────────────────────────────────────────

describe('canEditOriginRfi', () => {
  it('draft only', () => {
    expect(canEditOriginRfi(VARIATION_STATUS.DRAFT)).toBe(true)
    for (const s of Object.values(VARIATION_STATUS)) {
      if (s === VARIATION_STATUS.DRAFT) continue
      expect(canEditOriginRfi(s)).toBe(false)
    }
  })

  it('is the existing variation freeze point, not a new one', () => {
    expect(VARIATION_EDITABLE_STATUSES).toEqual([VARIATION_STATUS.DRAFT])
    for (const s of Object.values(VARIATION_STATUS)) {
      expect(canEditOriginRfi(s)).toBe(VARIATION_EDITABLE_STATUSES.includes(s))
    }
  })

  it('unknown / missing status is not editable', () => {
    expect(canEditOriginRfi(undefined)).toBe(false)
    expect(canEditOriginRfi('editing')).toBe(false)
  })
})

// ── variationsForRfi ─────────────────────────────────────────────────────────

describe('variationsForRfi', () => {
  const vs = [
    variation({ id: 'v1', ...LINKED }),
    variation({ id: 'v2', originRfiId: 'r2', originRfiNumber: 'RFI-0002', originRfiTitle: 'Other' }),
    variation({ id: 'v3' }),                                  // legacy, keys absent
    variation({ id: 'v4', ...UNLINKED_ORIGIN_RFI }),          // explicitly unlinked
    variation({ id: 'v5', ...LINKED, status: VARIATION_STATUS.WITHDRAWN }),
  ]

  it('exact id match only, in the given order, every status included', () => {
    expect(variationsForRfi(vs, 'r1').map(v => v.id)).toEqual(['v1', 'v5'])
    expect(variationsForRfi(vs, 'r2').map(v => v.id)).toEqual(['v2'])
  })

  it('no partial, prefix or case matching', () => {
    expect(variationsForRfi(vs, 'r')).toEqual([])
    expect(variationsForRfi(vs, 'R1')).toEqual([])
    expect(variationsForRfi(vs, 'r10')).toEqual([])
  })

  it('an RFI nobody cites → empty', () => {
    expect(variationsForRfi(vs, 'r99')).toEqual([])
  })

  it('a missing / empty / non-string rfiId never matches anything (legacy null ids must not match null)', () => {
    expect(variationsForRfi(vs, null)).toEqual([])
    expect(variationsForRfi(vs, undefined)).toEqual([])
    expect(variationsForRfi(vs, '')).toEqual([])
    expect(variationsForRfi(vs, 1)).toEqual([])
  })

  it('handles empty, null and junk collections', () => {
    expect(variationsForRfi([], 'r1')).toEqual([])
    expect(variationsForRfi(null, 'r1')).toEqual([])
    expect(variationsForRfi([null, undefined, variation(LINKED)], 'r1')).toHaveLength(1)
  })

  it('is deterministic and does not mutate the input', () => {
    const before = JSON.stringify(vs)
    const a = variationsForRfi(vs, 'r1')
    const b = variationsForRfi(vs, 'r1')
    expect(a).toEqual(b)
    expect(a).not.toBe(vs)
    expect(JSON.stringify(vs)).toBe(before)
  })
})

// ── Financial isolation — regression guards ──────────────────────────────────
//
// Every derivation must return EXACTLY the same value for a variation with a
// link, with the explicit unlinked triple, and with the keys absent (legacy).

describe('financial isolation — originRfi* metadata changes no derived figure', () => {
  const shapes = (overrides = {}) => [
    variation(overrides),                                   // legacy, keys absent
    variation({ ...overrides, ...UNLINKED_ORIGIN_RFI }),    // explicitly unlinked
    variation({ ...overrides, ...LINKED }),                 // linked
  ]

  const register = (link) => [
    variation({ id: 'a', variationType: VARIATION_TYPE.SUPPLIER, status: VARIATION_STATUS.APPROVED, ...link }),
    variation({ id: 'b', variationType: VARIATION_TYPE.SUPPLIER, status: VARIATION_STATUS.SUBMITTED, ...link,
      lineItems: [line({ costCodeId: 'cc2', submittedAmount: -250, submittedGst: -25, approvedAmount: null, approvedGst: null })],
      submittedSubtotal: -250, submittedGst: -25, submittedTotal: -275, approvedSubtotal: null, approvedGst: null, approvedTotal: null }),
    variation({ id: 'c', variationType: VARIATION_TYPE.CLIENT, status: VARIATION_STATUS.APPROVED, ...link,
      variationNumber: 'CV-0001', approvedSubtotal: 5000, approvedGst: 500, approvedTotal: 5500 }),
    variation({ id: 'd', variationType: VARIATION_TYPE.CLIENT, status: VARIATION_STATUS.DRAFT, ...link,
      variationNumber: 'CV-0002', submittedSubtotal: 1234.56, approvedSubtotal: null }),
    variation({ id: 'e', variationType: VARIATION_TYPE.SUPPLIER, status: VARIATION_STATUS.REJECTED, ...link }),
  ]

  const REGISTERS = [register({}), register(UNLINKED_ORIGIN_RFI), register(LINKED)]

  it('variationTotals is identical across all three shapes', () => {
    for (const side of ['submitted', 'approved']) {
      const results = shapes().map(v => variationTotals(v.lineItems, side))
      expect(results[1]).toEqual(results[0])
      expect(results[2]).toEqual(results[0])
    }
  })

  it('approved / pending supplier maps and totals are identical', () => {
    const maps  = REGISTERS.map(approvedSupplierVariationsByCostCode)
    const pend  = REGISTERS.map(pendingSupplierVariationExposureByCostCode)
    const tot   = REGISTERS.map(approvedSupplierVariationsTotal)
    const ptot  = REGISTERS.map(pendingSupplierVariationExposureTotal)
    expect(maps[0]).toEqual({ cc1: 900 })
    expect(pend[0]).toEqual({ cc2: -250 })
    expect(tot[0]).toBe(900)
    expect(ptot[0]).toBe(-250)
    for (const i of [1, 2]) {
      expect(maps[i]).toEqual(maps[0])
      expect(pend[i]).toEqual(pend[0])
      expect(tot[i]).toBe(tot[0])
      expect(ptot[i]).toBe(ptot[0])
    }
  })

  it('approved / pending client totals and the open count are identical', () => {
    const ct  = REGISTERS.map(approvedClientVariationsTotal)
    const cpt = REGISTERS.map(pendingClientVariationExposureTotal)
    const oc  = REGISTERS.map(openVariationCount)
    expect(ct[0]).toBe(5000)
    expect(cpt[0]).toBe(1234.56)
    expect(oc[0]).toBe(2)
    for (const i of [1, 2]) {
      expect(ct[i]).toBe(ct[0])
      expect(cpt[i]).toBe(cpt[0])
      expect(oc[i]).toBe(oc[0])
    }
  })

  it('duplicate detection ignores the link entirely', () => {
    const candidate = { variationType: VARIATION_TYPE.SUPPLIER, supplierId: 's1', supplierRef: 'Q-77' }
    const existing = (link) => [variation({ id: 'z', supplierId: 's1', supplierRef: 'Q-77', ...link })]
    const results = [{}, UNLINKED_ORIGIN_RFI, LINKED].map(link => duplicateVariationWarnings(existing(link), candidate))
    expect(results[0]).toHaveLength(1)
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  })

  it('the link holds no amount, currency or GST of its own', () => {
    const out = normaliseOriginRfi(rfi({ amount: 999, currency: 'AUD', gst: 99, costImpact: 1 }))
    expect(out).toEqual(LINKED)
    for (const k of Object.keys(out)) expect(typeof out[k]).toBe('string')
  })
})

// ── Draft editing (ADR-35) — pure editor helpers + financial regression ──────
//
// One editor serves CREATE and EDIT DRAFT through three pure helpers:
// variationLineToForm (stored → form), buildVariationLineItem (form → stored)
// and validateVariationDraft. The hook additionally strips the approved side
// from every draft line (stripApprovedFromLines). These tests pin the mapping,
// the PO-line inheritance rule, the unchanged validation policy, purity, and —
// most importantly — that editing a draft moves ONLY the pending exposure
// figures that already derive from drafts.

const deepFreeze = (o) => {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

const COST_CODES = deepFreeze([
  { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
  { id: 'cc2', code: '05-200', name: 'Steel',    isActive: true },
])

const PO = deepFreeze({
  id: 'po1', poNumber: 'PO-0007', status: 'cancelled', supplierId: 's1', supplierName: 'Acme Steel',
  lineItems: [
    { costCodeId: 'cc2', costCodeName: '05-200 — Steel', description: 'Supply steel', amount: 5000 },
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Pour', amount: 2000 },
  ],
})

const storedLine = (overrides = {}) => ({
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete',
  description: 'Extra pour',
  submittedAmount: 1234.5, submittedGst: 123.45,
  approvedAmount: null, approvedGst: null,
  poLineIndex: null, taxCode: TAX_CODE.GST,
  ...overrides,
})

describe('variationLineToForm', () => {
  it('maps a stored new-scope line to form strings, keeping the cost code identity', () => {
    expect(variationLineToForm(storedLine())).toEqual({
      poLineIndex: '', costCodeId: 'cc1', description: 'Extra pour', submittedAmount: '1234.5', taxCode: TAX_CODE.GST,
    })
  })

  it('a PO-inherited line keeps its poLineIndex (as a string) and carries no chosen cost code', () => {
    expect(variationLineToForm(storedLine({ poLineIndex: 1, costCodeId: 'cc1' }))).toEqual({
      poLineIndex: '1', costCodeId: '', description: 'Extra pour', submittedAmount: '1234.5', taxCode: TAX_CODE.GST,
    })
    expect(variationLineToForm(storedLine({ poLineIndex: 0 })).poLineIndex).toBe('0')
  })

  it('preserves a negative amount and a zero amount', () => {
    expect(variationLineToForm(storedLine({ submittedAmount: -250 })).submittedAmount).toBe('-250')
    expect(variationLineToForm(storedLine({ submittedAmount: 0 })).submittedAmount).toBe('0')
  })

  it('legacy / partial / junk lines map to safe defaults', () => {
    expect(variationLineToForm({})).toEqual({ ...EMPTY_VARIATION_FORM_LINE })
    expect(variationLineToForm(null)).toEqual({ ...EMPTY_VARIATION_FORM_LINE })
    expect(variationLineToForm(undefined)).toEqual({ ...EMPTY_VARIATION_FORM_LINE })
    expect(variationLineToForm({ submittedAmount: null, taxCode: 'bogus', poLineIndex: 'x', costCodeId: 7 }))
      .toEqual({ ...EMPTY_VARIATION_FORM_LINE })
  })
})

describe('buildVariationLineItem', () => {
  it('a new-scope line uses the chosen cost code with a fresh "CODE — NAME" snapshot', () => {
    const built = buildVariationLineItem(
      { poLineIndex: '', costCodeId: 'cc2', description: '  Extra steel ', submittedAmount: '100', taxCode: TAX_CODE.GST },
      { po: PO, costCodes: COST_CODES },
    )
    expect(built).toEqual({
      costCodeId: 'cc2', costCodeName: '05-200 — Steel', description: 'Extra steel',
      submittedAmount: 100, submittedGst: 10, approvedAmount: null, approvedGst: null,
      poLineIndex: null, taxCode: TAX_CODE.GST,
    })
  })

  it('a PO-inherited line takes costCodeId / costCodeName from the referenced PO line', () => {
    const built = buildVariationLineItem(
      { poLineIndex: '1', costCodeId: '', description: 'More pour', submittedAmount: '50', taxCode: TAX_CODE.GST },
      { po: PO, costCodes: COST_CODES },
    )
    expect(built.costCodeId).toBe('cc1')
    expect(built.costCodeName).toBe('03-100 — Concrete')
    expect(built.poLineIndex).toBe(1)
  })

  it('a stale chosen cost code cannot override PO-line inheritance', () => {
    const built = buildVariationLineItem(
      { poLineIndex: '0', costCodeId: 'cc1', description: '', submittedAmount: '1', taxCode: TAX_CODE.GST },
      { po: PO, costCodes: COST_CODES },
    )
    expect(built.costCodeId).toBe('cc2')
    expect(built.costCodeName).toBe('05-200 — Steel')
  })

  it('without a PO (client / manual supplier) poLineIndex is ignored and null', () => {
    const built = buildVariationLineItem(
      { poLineIndex: '0', costCodeId: 'cc1', description: '', submittedAmount: '1', taxCode: TAX_CODE.GST },
      { po: null, costCodes: COST_CODES },
    )
    expect(built.poLineIndex).toBeNull()
    expect(built.costCodeId).toBe('cc1')
  })

  it('an unknown cost code yields an empty snapshot (validation then rejects it)', () => {
    const built = buildVariationLineItem({ costCodeId: 'nope', submittedAmount: '1' }, { costCodes: COST_CODES })
    expect(built.costCodeId).toBe('nope')
    expect(built.costCodeName).toBe('')
    expect(buildVariationLineItem({ costCodeId: '', submittedAmount: '1' }, { costCodes: COST_CODES }).costCodeId).toBe('')
  })

  it('rounds the amount to cents and treats blank / junk as 0 (existing behaviour)', () => {
    expect(buildVariationLineItem({ costCodeId: 'cc1', submittedAmount: '10.005' }, { costCodes: COST_CODES }).submittedAmount).toBe(10.01)
    expect(buildVariationLineItem({ costCodeId: 'cc1', submittedAmount: '' }, { costCodes: COST_CODES }).submittedAmount).toBe(0)
    expect(buildVariationLineItem({ costCodeId: 'cc1', submittedAmount: 'abc' }, { costCodes: COST_CODES }).submittedAmount).toBe(0)
  })

  it('derives GST from the tax code exactly as gstForLine does', () => {
    const at = (taxCode) => buildVariationLineItem({ costCodeId: 'cc1', submittedAmount: '200', taxCode }, { costCodes: COST_CODES })
    expect(at(TAX_CODE.GST).submittedGst).toBe(20)
    expect(at(TAX_CODE.GST_FREE).submittedGst).toBe(0)
    expect(at(TAX_CODE.INPUT_TAXED).submittedGst).toBe(0)
    expect(at('bogus').taxCode).toBe(TAX_CODE.GST)
    expect(at(undefined).submittedGst).toBe(20)
  })

  it('negative amounts (credits / omissions) remain accepted, with signed GST', () => {
    const built = buildVariationLineItem({ costCodeId: 'cc1', submittedAmount: '-300', taxCode: TAX_CODE.GST }, { costCodes: COST_CODES })
    expect(built.submittedAmount).toBe(-300)
    expect(built.submittedGst).toBe(-30)
  })

  it('approvedAmount and approvedGst are ALWAYS null on a rebuilt draft line', () => {
    const built = buildVariationLineItem(
      { costCodeId: 'cc1', submittedAmount: '1', approvedAmount: 999, approvedGst: 99 },
      { costCodes: COST_CODES },
    )
    expect(built.approvedAmount).toBeNull()
    expect(built.approvedGst).toBeNull()
    expect(Object.keys(built).sort()).toEqual([
      'approvedAmount', 'approvedGst', 'costCodeId', 'costCodeName', 'description',
      'poLineIndex', 'submittedAmount', 'submittedGst', 'taxCode',
    ])
  })

  it('round-trips: stored → form → built equals the stored line (new-scope and PO-inherited)', () => {
    const newScope  = storedLine({ submittedAmount: -42.1, submittedGst: -4.21, taxCode: TAX_CODE.GST })
    const inherited = storedLine({ poLineIndex: 0, costCodeId: 'cc2', costCodeName: '05-200 — Steel', submittedAmount: 80, submittedGst: 0, taxCode: TAX_CODE.GST_FREE })
    expect(buildVariationLineItem(variationLineToForm(newScope),  { po: PO, costCodes: COST_CODES })).toEqual(newScope)
    expect(buildVariationLineItem(variationLineToForm(inherited), { po: PO, costCodes: COST_CODES })).toEqual(inherited)
  })
})

describe('validateVariationDraft', () => {
  const ok = [storedLine()]
  it('blank / whitespace / missing title is rejected', () => {
    expect(validateVariationDraft({ title: '', lineItems: ok })).toMatch(/title/i)
    expect(validateVariationDraft({ title: '   ', lineItems: ok })).toMatch(/title/i)
    expect(validateVariationDraft({ lineItems: ok })).toMatch(/title/i)
  })
  it('zero lines is rejected', () => {
    expect(validateVariationDraft({ title: 'T', lineItems: [] })).toMatch(/line/i)
    expect(validateVariationDraft({ title: 'T' })).toMatch(/line/i)
  })
  it('a line without a cost code is rejected, naming the line', () => {
    expect(validateVariationDraft({ title: 'T', lineItems: [storedLine(), storedLine({ costCodeId: '' })] })).toBe('Line 2: a cost code is required')
    expect(validateVariationDraft({ title: 'T', lineItems: [storedLine({ costCodeId: null })] })).toMatch(/Line 1/)
  })
  it('a valid draft is accepted — including negative and zero amounts (no stricter policy)', () => {
    expect(validateVariationDraft({ title: 'T', lineItems: ok })).toBeNull()
    expect(validateVariationDraft({ title: 'T', lineItems: [storedLine({ submittedAmount: -1 }), storedLine({ submittedAmount: 0 })] })).toBeNull()
  })
})

describe('stripApprovedFromLines', () => {
  it('forces the approved side null on every line and returns new objects', () => {
    const input = deepFreeze([storedLine({ approvedAmount: 5, approvedGst: 0.5 }), storedLine()])
    const out = stripApprovedFromLines(input)
    expect(out.every(l => l.approvedAmount === null && l.approvedGst === null)).toBe(true)
    expect(out[0]).not.toBe(input[0])
    expect(out[0].submittedAmount).toBe(input[0].submittedAmount)
    expect(stripApprovedFromLines(null)).toEqual([])
  })
})

describe('draft edit — origin RFI + notes contract', () => {
  // The editor's payload rule: undefined = unchanged, RFI = set/change, null =
  // remove. The hook spreads normaliseOriginRfi only when defined and writes
  // notes only when defined — modelled here exactly as the hook composes it.
  const compose = (stored, { originRfi, notes }) => ({
    ...stored,
    ...(originRfi === undefined ? {} : normaliseOriginRfi(originRfi)),
    ...(notes === undefined ? {} : { notes: notes?.trim() || '' }),
  })
  const draft = deepFreeze({ ...variation({ status: VARIATION_STATUS.DRAFT, notes: 'Site note', ...LINKED }) })

  it('unchanged (undefined) preserves the stored triple', () => {
    const out = compose(draft, { originRfi: undefined })
    expect([out.originRfiId, out.originRfiNumber, out.originRfiTitle]).toEqual(['r1', 'RFI-0012', 'Revised structural steel connection'])
  })
  it('a valid new RFI replaces the triple', () => {
    const out = compose(draft, { originRfi: rfi({ id: 'r2', rfiNumber: 'RFI-0020', title: 'Other' }) })
    expect([out.originRfiId, out.originRfiNumber, out.originRfiTitle]).toEqual(['r2', 'RFI-0020', 'Other'])
  })
  it('null removes it (all-null triple, never partial)', () => {
    const out = compose(draft, { originRfi: null })
    expect([out.originRfiId, out.originRfiNumber, out.originRfiTitle]).toEqual([null, null, null])
  })
  it('a historical link to a since-cancelled RFI survives an unrelated edit untouched', () => {
    const cancelled = rfi({ status: RFI_STATUS.CANCELLED })
    expect(isEligibleOriginRfi(cancelled)).toBe(false)
    expect(eligibleOriginRfis([cancelled])).toEqual([])            // not offered as a NEW choice
    const out = compose(draft, { originRfi: undefined, notes: undefined })
    expect(out.originRfiId).toBe(cancelled.id)                     // still linked
    expect(hasOriginRfi(out)).toBe(true)
  })
  it('notes pass through unchanged when omitted, and only change when explicitly given', () => {
    expect(compose(draft, { originRfi: undefined }).notes).toBe('Site note')
    expect(compose(draft, { originRfi: undefined, notes: '  new ' }).notes).toBe('new')
    expect(compose(draft, { originRfi: undefined, notes: '' }).notes).toBe('')
  })
})

describe('draft edit — purity', () => {
  it('no helper mutates the stored variation, lines, PO, cost codes or RFIs', () => {
    const stored = deepFreeze(variation({ status: VARIATION_STATUS.DRAFT, lineItems: [storedLine({ poLineIndex: 1 }), storedLine()] }))
    const rfis   = deepFreeze([rfi(), rfi({ id: 'r2', rfiNumber: 'RFI-0002', status: RFI_STATUS.CANCELLED })])
    const forms  = stored.lineItems.map(variationLineToForm)
    deepFreeze(forms)
    const built  = forms.map(f => buildVariationLineItem(f, { po: PO, costCodes: COST_CODES }))
    expect(() => validateVariationDraft({ title: stored.title, lineItems: deepFreeze(built) })).not.toThrow()
    expect(() => stripApprovedFromLines(built)).not.toThrow()
    expect(() => eligibleOriginRfis(rfis)).not.toThrow()
    expect(() => normaliseOriginRfi(rfis[0])).not.toThrow()
    // Determinism
    expect(forms.map(f => buildVariationLineItem(f, { po: PO, costCodes: COST_CODES }))).toEqual(built)
    // Identity of inputs untouched (frozen objects would have thrown in strict mode; assert content too)
    expect(stored.lineItems[0].poLineIndex).toBe(1)
    expect(PO.lineItems[1].costCodeId).toBe('cc1')
  })
})

describe('draft edit — financial regression (only pending exposure may move)', () => {
  const baseline = deepFreeze({ originalContractValue: 1_000_000, originalApprovedBudget: 800_000 })
  const budgetLines = deepFreeze([
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 100_000 },
    { costCodeId: 'cc2', costCodeName: '05-200 — Steel',    budgeted: 200_000 },
  ])
  const approvedSupplier = variation({
    id: 'sv-appr', variationNumber: 'SV-0001', variationType: VARIATION_TYPE.SUPPLIER, status: VARIATION_STATUS.APPROVED,
    lineItems: [line({ costCodeId: 'cc1', submittedAmount: 1000, approvedAmount: 900 })],
    submittedSubtotal: 1000, approvedSubtotal: 900,
  })
  const approvedClient = variation({
    id: 'cv-appr', variationNumber: 'CV-0001', variationType: VARIATION_TYPE.CLIENT, status: VARIATION_STATUS.APPROVED,
    lineItems: [line({ submittedAmount: 5000, approvedAmount: 4500 })],
    submittedSubtotal: 5000, approvedSubtotal: 4500, approvedTotal: 4950,
  })
  const draftSupplierBefore = variation({
    id: 'sv-draft', variationNumber: 'SV-0002', variationType: VARIATION_TYPE.SUPPLIER, status: VARIATION_STATUS.DRAFT,
    lineItems: [storedLine({ costCodeId: 'cc1', submittedAmount: 300, submittedGst: 30 })],
    submittedSubtotal: 300, submittedGst: 30, submittedTotal: 330,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
  })
  const draftClientBefore = variation({
    id: 'cv-draft', variationNumber: 'CV-0002', variationType: VARIATION_TYPE.CLIENT, status: VARIATION_STATUS.DRAFT,
    lineItems: [storedLine({ submittedAmount: 700, submittedGst: 70 })],
    submittedSubtotal: 700, submittedGst: 70, submittedTotal: 770,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
  })

  // Simulates the edit exactly as the hook writes it: rebuilt lines (approved
  // side stripped) and re-derived submitted totals; nothing else.
  const edited = (draft, formLines, po = null) => {
    const lineItems = stripApprovedFromLines(formLines.map(f => buildVariationLineItem(f, { po, costCodes: COST_CODES })))
    const t = variationTotals(lineItems, 'submitted')
    return { ...draft, title: 'Corrected title', lineItems, submittedSubtotal: t.subtotal, submittedGst: t.gst, submittedTotal: t.total }
  }

  const outputs = (variations) => {
    const forecastTotals = projectForecastTotals({ costCodes: COST_CODES, budgetLines, variations })
    const rows = buildForecastRows({ costCodes: COST_CODES, budgetLines, variations })
    const m = computeMargin({ baseline, variations, forecastFinalCost: forecastTotals.forecastFinalCost })
    return {
      // MUST NOT move on a draft edit
      frozen: {
        approvedSupplierByCostCode: approvedSupplierVariationsByCostCode(variations),
        approvedSupplierTotal: approvedSupplierVariationsTotal(variations),
        approvedClientTotal: approvedClientVariationsTotal(variations),
        forecastFinalCost: forecastTotals.forecastFinalCost,
        forecastApprovedSV: forecastTotals.approvedSupplierVariations,
        currentContractSum: m.currentContractSum,
        forecastRevenue: m.forecastRevenue,
        forecastGrossProfit: m.forecastGrossProfit,
        forecastMarginPct: m.forecastMarginPct,
        approvedSupplierVariations: m.approvedSupplierVariations,
        approvedClientVariations: m.approvedClientVariations,
        availableToInvoice: contractControl([], m.currentContractSum).availableToInvoice,
        invoiceable: invoiceableClientVariations(variations, []).map(r => r.id),
        invoicingRows: variationInvoicingRows(variations, []).map(r => [r.id, r.approved]),
        openCount: openVariationCount(variations),
        rowActual: rows.map(r => [r.costCodeId, r.actual, r.remainingCommitted, r.approvedSupplierVariations]),
      },
      // MAY move
      pending: {
        pendingSupplierByCostCode: pendingSupplierVariationExposureByCostCode(variations),
        pendingSupplierTotal: pendingSupplierVariationExposureTotal(variations),
        pendingClientTotal: pendingClientVariationExposureTotal(variations),
        marginPendingSupplier: m.pendingSupplierVariationExposure,
        marginPendingClient: m.pendingClientVariationExposure,
        forecastPendingSV: forecastTotals.pendingSupplierVariationExposure,
        rowPending: rows.map(r => [r.costCodeId, r.pendingSupplierVariationExposure]),
      },
    }
  }

  it('editing a draft SUPPLIER variation moves only pending supplier exposure — by the exact delta, between cost codes', () => {
    const before = outputs([approvedSupplier, approvedClient, draftSupplierBefore, draftClientBefore])
    // Change the amount (300 → -150) and move the line to cc2, and add a line on cc1.
    const draftAfter = edited(draftSupplierBefore, [
      { poLineIndex: '', costCodeId: 'cc2', description: 'moved', submittedAmount: '-150', taxCode: TAX_CODE.GST },
      { poLineIndex: '', costCodeId: 'cc1', description: 'added', submittedAmount: '20',   taxCode: TAX_CODE.GST_FREE },
    ])
    const after = outputs([approvedSupplier, approvedClient, draftAfter, draftClientBefore])

    expect(after.frozen).toEqual(before.frozen)
    expect(before.pending.pendingSupplierByCostCode).toEqual({ cc1: 300 })
    expect(after.pending.pendingSupplierByCostCode).toEqual({ cc2: -150, cc1: 20 })
    expect(after.pending.pendingSupplierTotal).toBe(-130)
    expect(after.pending.marginPendingSupplier).toBe(-130)
    expect(after.pending.forecastPendingSV).toBe(-130)
    expect(after.pending.pendingClientTotal).toBe(before.pending.pendingClientTotal)
    expect(after.pending.marginPendingClient).toBe(before.pending.marginPendingClient)
    // The edited draft still carries no certified value.
    expect(draftAfter.lineItems.every(l => l.approvedAmount === null && l.approvedGst === null)).toBe(true)
    expect(draftAfter.approvedSubtotal).toBeNull()
  })

  it('editing a draft CLIENT variation moves only pending client exposure', () => {
    const before = outputs([approvedSupplier, approvedClient, draftSupplierBefore, draftClientBefore])
    const draftAfter = edited(draftClientBefore, [
      { poLineIndex: '', costCodeId: 'cc1', description: '', submittedAmount: '1200', taxCode: TAX_CODE.GST },
    ])
    const after = outputs([approvedSupplier, approvedClient, draftSupplierBefore, draftAfter])

    expect(after.frozen).toEqual(before.frozen)
    expect(before.pending.pendingClientTotal).toBe(700)
    expect(after.pending.pendingClientTotal).toBe(1200)
    expect(after.pending.marginPendingClient).toBe(1200)
    expect(after.pending.pendingSupplierByCostCode).toEqual(before.pending.pendingSupplierByCostCode)
    expect(after.pending.pendingSupplierTotal).toBe(before.pending.pendingSupplierTotal)
    // Pending client variations are never invoiceable, before or after.
    expect(after.frozen.invoiceable).toEqual(['cv-appr'])
  })

  it('a PO-inherited edit resolves cost codes from the stored PO even though that PO is now cancelled', () => {
    const draftAfter = edited(draftSupplierBefore, [
      { poLineIndex: '0', costCodeId: 'stale', description: '', submittedAmount: '10', taxCode: TAX_CODE.GST },
    ], PO)
    expect(PO.status).toBe('cancelled')
    expect(draftAfter.lineItems[0]).toMatchObject({ costCodeId: 'cc2', costCodeName: '05-200 — Steel', poLineIndex: 0 })
    expect(pendingSupplierVariationExposureByCostCode([draftAfter])).toEqual({ cc2: 10 })
  })

  it('the approved variations themselves are untouched by any draft helper', () => {
    const before = JSON.stringify([approvedSupplier, approvedClient])
    edited(draftSupplierBefore, [{ poLineIndex: '', costCodeId: 'cc1', submittedAmount: '1' }])
    expect(JSON.stringify([approvedSupplier, approvedClient])).toBe(before)
  })
})
