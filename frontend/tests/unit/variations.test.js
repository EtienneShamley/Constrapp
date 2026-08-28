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
} from '../../src/lib/variations'
import { RFI_STATUS, RFI_STATUS_ORDER } from '../../src/lib/rfis'

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
