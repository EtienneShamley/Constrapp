import { describe, it, expect } from 'vitest'
import {
  CLAIM_STATUS, CLAIM_EDITABLE_STATUSES, CLAIM_TRANSITIONS, canTransition,
  CLAIM_OPEN_STATUSES, CLAIM_PENDING_STATUSES, CLAIM_APPROVED_STATUSES,
  CLAIMABLE_PO_STATUSES, formatClaimNumber, hasOpenClaim,
  claimTotals, approvedLineError, validateApprovedAmounts,
  previouslyApprovedByPoLine, approvedByCostCode, actualClaimsByCostCode,
  claimedPendingByCostCode,
  claimLineToForm, buildClaimLine, claimedToDateCountError, validateClaimDraft,
} from '../../src/lib/progressClaims'
import {
  PO_STATUS, GST_RATE, roundMoney, committedByCostCode, maturedCommittedByCostCode,
} from '../../src/lib/purchaseOrders'
import { buildForecastRows } from '../../src/lib/forecast'
import { computeMargin, projectForecastTotals } from '../../src/lib/margin'
import { invoicedClaimIds, claimHasActiveInvoice, postedInvoicedByPoLine } from '../../src/lib/supplierInvoices'
import { retentionInvoiceRows, retentionSummary, releasedByInvoiceId } from '../../src/lib/retention'

// ── Progress Claims — draft editing (pure domain, ADR-37) ────────────────────
//
// No emulator, no React. These tests pin the shared CREATE / EDIT DRAFT line
// helpers, the FIXED line set, the positional-pairing guard, the draft
// validation rules and the exact stored line shape — and prove that editing a
// DRAFT claim changes no commercial figure, because draft claims are counted
// nowhere until the existing counting points (submitted → Claimed, approved →
// Actual).
//
// Blocks E, F and G are CHARACTERISATION of behaviour that shipped untested:
// they record what the code does today, including semantics that look odd
// (negative retention, a NaN retention, an unclamped `claimedToDate`). Nothing
// there was changed to make a test pass.

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

// The stored claim-line shape, exactly as useProgressClaims writes it.
const storedLine = (o = {}) => ({
  poLineIndex: 0,
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
  poLineTotal: 10000,
  previouslyApproved: 2000,
  claimedToDate: 5000,
  claimedThisPeriod: 3000,
  approvedThisPeriod: null,
  ...o,
})

// A PO line, as buildPoLineItem writes it — the CREATE-mode identity source.
const poLine = (o = {}) => ({
  costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
  qty: 40, unit: 'm3', unitPrice: 250, lineTotal: 10000, ...o,
})

const STORED_LINE_KEYS = [
  'poLineIndex', 'costCodeId', 'costCodeName', 'description', 'poLineTotal',
  'previouslyApproved', 'claimedToDate', 'claimedThisPeriod', 'approvedThisPeriod',
].sort()

// ── A. claimLineToForm ───────────────────────────────────────────────────────

describe('claimLineToForm', () => {
  it('maps a stored cumulative amount to its string form value', () => {
    expect(claimLineToForm(storedLine({ claimedToDate: 5000 }))).toBe('5000')
  })

  it('maps 0 to "0" — never "", which would read as "nothing claimed yet"', () => {
    expect(claimLineToForm(storedLine({ claimedToDate: 0 }))).toBe('0')
  })

  it('preserves decimals', () => {
    expect(claimLineToForm(storedLine({ claimedToDate: 1234.56 }))).toBe('1234.56')
    expect(claimLineToForm(storedLine({ claimedToDate: 0.05 }))).toBe('0.05')
  })

  it('maps null / undefined / empty to the "0" default, matching the create seed', () => {
    expect(claimLineToForm(storedLine({ claimedToDate: null }))).toBe('0')
    expect(claimLineToForm(storedLine({ claimedToDate: undefined }))).toBe('0')
    expect(claimLineToForm(storedLine({ claimedToDate: '' }))).toBe('0')
  })

  it('maps legacy / partial / malformed input to "0" rather than "NaN"', () => {
    expect(claimLineToForm({})).toBe('0')
    expect(claimLineToForm(null)).toBe('0')
    expect(claimLineToForm(undefined)).toBe('0')
    expect(claimLineToForm('nonsense')).toBe('0')
    expect(claimLineToForm(storedLine({ claimedToDate: 'abc' }))).toBe('0')
    expect(claimLineToForm(storedLine({ claimedToDate: NaN }))).toBe('0')
  })

  it('accepts a numeric string as stored by a legacy write', () => {
    expect(claimLineToForm(storedLine({ claimedToDate: '750.5' }))).toBe('750.5')
  })

  it('does not mutate its input', () => {
    const line = deepFreeze(storedLine())
    expect(() => claimLineToForm(line)).not.toThrow()
    expect(line.claimedToDate).toBe(5000)
  })
})

// ── B. buildClaimLine ────────────────────────────────────────────────────────

describe('buildClaimLine', () => {
  it('EDIT: preserves every identity field from the STORED line', () => {
    const stored = storedLine({
      poLineIndex: 3, costCodeId: 'cc9', costCodeName: '05-200 — Steel',
      description: 'Beams', poLineTotal: 7777, previouslyApproved: 1500,
    })
    const built = buildClaimLine(stored, { claimedToDate: '2500' })
    expect(built).toMatchObject({
      poLineIndex: 3, costCodeId: 'cc9', costCodeName: '05-200 — Steel',
      description: 'Beams', poLineTotal: 7777, previouslyApproved: 1500,
    })
  })

  it('EDIT: a caller cannot repoint a line — identity comes only from the source', () => {
    const stored = deepFreeze(storedLine({ poLineIndex: 2, costCodeId: 'cc1' }))
    // The edit contract passes ONLY the amount; there is no channel for identity.
    const built = buildClaimLine(stored, { claimedToDate: '9999' })
    expect(built.poLineIndex).toBe(2)
    expect(built.costCodeId).toBe('cc1')
    expect(built.costCodeName).toBe('03-100 — Concrete')
    expect(built.description).toBe('Slab')
    expect(built.poLineTotal).toBe(10000)
    expect(built.previouslyApproved).toBe(2000)
  })

  it('CREATE: reads a PO line, taking poLineTotal from lineTotal, with the caller-supplied index and seed', () => {
    const built = buildClaimLine(poLine(), {
      poLineIndex: 1, previouslyApproved: 4000, claimedToDate: '6000',
    })
    expect(built).toEqual({
      poLineIndex: 1,
      costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
      poLineTotal: 10000,
      previouslyApproved: 4000,
      claimedToDate: 6000,
      claimedThisPeriod: 2000,
      approvedThisPeriod: null,
    })
  })

  it('normalises the authored claimedToDate: numeric strings, blanks and rubbish', () => {
    const at = (v) => buildClaimLine(storedLine({ previouslyApproved: 0 }), { claimedToDate: v }).claimedToDate
    expect(at('5000')).toBe(5000)
    expect(at(5000)).toBe(5000)
    expect(at('1234.56')).toBe(1234.56)
    expect(at('')).toBe(0)
    expect(at(null)).toBe(0)
    expect(at(undefined)).toBe(0)
    expect(at('abc')).toBe(0)
    expect(at(NaN)).toBe(0)
  })

  it('always re-derives claimedThisPeriod as claimedToDate − previouslyApproved', () => {
    const built = buildClaimLine(storedLine({ previouslyApproved: 2000 }), { claimedToDate: '7500' })
    expect(built.claimedThisPeriod).toBe(5500)
  })

  it('rounds the derived delta to cents', () => {
    const built = buildClaimLine(storedLine({ previouslyApproved: 0.1 }), { claimedToDate: '0.3' })
    expect(built.claimedThisPeriod).toBe(0.2)          // not 0.19999999999999998
    expect(buildClaimLine(storedLine({ previouslyApproved: 0 }), { claimedToDate: '1234.567' })
      .claimedThisPeriod).toBe(1234.57)
    // roundMoney is half-UP: 2000 − 1000.005 = 999.995 → 1000
    expect(buildClaimLine(storedLine({ previouslyApproved: 1000.005 }), { claimedToDate: '2000' })
      .claimedThisPeriod).toBe(1000)
  })

  it('represents a below-previously-approved entry as a NEGATIVE delta for validation to catch', () => {
    const built = buildClaimLine(storedLine({ previouslyApproved: 5000 }), { claimedToDate: '3000' })
    expect(built.claimedThisPeriod).toBe(-2000)
    expect(validateClaimDraft({ lineItems: [built] })).toMatch(/below the previously approved/)
  })

  it('IGNORES a caller-supplied stale claimedThisPeriod on the source line', () => {
    const stored = storedLine({ previouslyApproved: 2000, claimedThisPeriod: 999999 })
    expect(buildClaimLine(stored, { claimedToDate: '2500' }).claimedThisPeriod).toBe(500)
  })

  it('FORCES approvedThisPeriod to null, even when the source carries a certified amount', () => {
    const stored = storedLine({ approvedThisPeriod: 4321 })
    expect(buildClaimLine(stored, { claimedToDate: '5000' }).approvedThisPeriod).toBeNull()
  })

  it('outputs exactly the nine stored claim-line keys — no taxCode, no per-line GST', () => {
    expect(Object.keys(buildClaimLine(storedLine(), { claimedToDate: '1' })).sort())
      .toEqual(STORED_LINE_KEYS)
    expect(Object.keys(buildClaimLine(poLine(), { poLineIndex: 0, previouslyApproved: 0, claimedToDate: '1' })).sort())
      .toEqual(STORED_LINE_KEYS)
  })

  it('drops any extra key riding along on the source line', () => {
    const built = buildClaimLine(storedLine({ taxCode: 'gst', gstAmount: 100, id: 'x' }), { claimedToDate: '1' })
    expect(Object.keys(built).sort()).toEqual(STORED_LINE_KEYS)
  })

  it('handles legacy / partial / malformed sources safely — never undefined or NaN', () => {
    for (const src of [null, undefined, 'nonsense', 42, {}]) {
      const built = buildClaimLine(src, { claimedToDate: '100' })
      expect(Object.keys(built).sort()).toEqual(STORED_LINE_KEYS)
      expect(built).toMatchObject({
        poLineIndex: 0, costCodeId: '', costCodeName: '', description: '',
        poLineTotal: 0, previouslyApproved: 0, claimedToDate: 100,
        claimedThisPeriod: 100, approvedThisPeriod: null,
      })
      for (const v of Object.values(built)) expect(Number.isNaN(v)).toBe(false)
    }
  })

  it('coerces a legacy line missing previouslyApproved / poLineTotal to 0 rather than NaN', () => {
    const built = buildClaimLine({ poLineIndex: 1, costCodeId: 'cc1' }, { claimedToDate: '500' })
    expect(built.previouslyApproved).toBe(0)
    expect(built.poLineTotal).toBe(0)
    expect(built.claimedThisPeriod).toBe(500)
  })

  it('does not mutate its inputs', () => {
    const stored = deepFreeze(storedLine())
    const po     = deepFreeze(poLine())
    expect(() => buildClaimLine(stored, { claimedToDate: '9' })).not.toThrow()
    expect(() => buildClaimLine(po, { poLineIndex: 0, previouslyApproved: 0, claimedToDate: '9' })).not.toThrow()
    expect(stored.claimedToDate).toBe(5000)
    expect(po.lineTotal).toBe(10000)
  })
})

// ── C. validateClaimDraft ────────────────────────────────────────────────────

describe('validateClaimDraft', () => {
  const line = (claimedThisPeriod, o = {}) => storedLine({ claimedThisPeriod, ...o })

  it('rejects a claim with no lines', () => {
    expect(validateClaimDraft({ lineItems: [] })).toBe('A progress claim needs at least one line')
    expect(validateClaimDraft({ lineItems: null })).toBe('A progress claim needs at least one line')
    expect(validateClaimDraft({})).toBe('A progress claim needs at least one line')
    expect(validateClaimDraft()).toBe('A progress claim needs at least one line')
  })

  it('rejects a line claimed below its previously approved amount', () => {
    expect(validateClaimDraft({ lineItems: [line(-1)] }))
      .toBe('Line 1: claimed to date cannot be below the previously approved amount')
  })

  it('identifies the correct 1-based line', () => {
    expect(validateClaimDraft({ lineItems: [line(100), line(200), line(-0.01)] }))
      .toBe('Line 3: claimed to date cannot be below the previously approved amount')
  })

  it('rejects a claim where every line is zero this period', () => {
    expect(validateClaimDraft({ lineItems: [line(0), line(0)] }))
      .toBe('A progress claim must claim an amount on at least one line')
  })

  it('accepts a claim with at least one positive line, even when others are zero', () => {
    expect(validateClaimDraft({ lineItems: [line(0), line(0.01), line(0)] })).toBeNull()
  })

  it('ACCEPTS claiming above the PO line value — warn-only, never blocked', () => {
    const over = line(50000, { poLineTotal: 1000, claimedToDate: 52000 })
    expect(validateClaimDraft({ lineItems: [over] })).toBeNull()
  })

  it('adds no aggregate over-PO control', () => {
    const lines = [line(9_000_000, { poLineTotal: 10, claimedToDate: 9_000_000 })]
    expect(validateClaimDraft({ lineItems: lines })).toBeNull()
  })

  it('reports the below-approved error before the nothing-claimed error', () => {
    expect(validateClaimDraft({ lineItems: [line(-5), line(0)] })).toMatch(/^Line 1:/)
  })

  it('treats a missing / malformed claimedThisPeriod as 0', () => {
    expect(validateClaimDraft({ lineItems: [{}, { claimedThisPeriod: 'abc' }] }))
      .toBe('A progress claim must claim an amount on at least one line')
    expect(validateClaimDraft({ lineItems: [null, line(10)] })).toBeNull()
  })

  it('says nothing about claimRef, periodEnding, notes or retention — none are required', () => {
    // Those fields are not part of the contract at all; a valid line set is enough.
    expect(validateClaimDraft({ lineItems: [line(1)] })).toBeNull()
  })

  it('does not mutate its input', () => {
    const lines = deepFreeze([line(100), line(-1)])
    expect(() => validateClaimDraft({ lineItems: lines })).not.toThrow()
    expect(lines[0].claimedThisPeriod).toBe(100)
  })
})

// ── D. claimed-value array safety (positional pairing) ───────────────────────

describe('claimedToDateCountError', () => {
  const lines = [storedLine({ poLineIndex: 0 }), storedLine({ poLineIndex: 1 }), storedLine({ poLineIndex: 2 })]

  it('accepts an exactly matching list', () => {
    expect(claimedToDateCountError(lines, ['1', '2', '3'])).toBeNull()
  })

  it('REJECTS a shorter list — values would pair with the wrong lines', () => {
    expect(claimedToDateCountError(lines, ['1', '2']))
      .toBe('A claimed-to-date value is required for every claim line (expected 3, got 2)')
  })

  it('REJECTS a longer list', () => {
    expect(claimedToDateCountError(lines, ['1', '2', '3', '4']))
      .toBe('A claimed-to-date value is required for every claim line (expected 3, got 4)')
  })

  it('rejects a missing or non-array claimed list', () => {
    expect(claimedToDateCountError(lines, undefined)).toMatch(/expected 3, got 0/)
    expect(claimedToDateCountError(lines, null)).toMatch(/expected 3, got 0/)
    expect(claimedToDateCountError(lines, 'abc')).toMatch(/expected 3, got 0/)
    expect(claimedToDateCountError(lines, {})).toMatch(/expected 3, got 0/)
  })

  it('rejects a claim with no stored lines at all', () => {
    for (const bad of [undefined, null, [], 'x', {}]) {
      expect(claimedToDateCountError(bad, ['1'])).toBe('This progress claim has no line items to edit')
    }
  })

  it('accepts an empty-string entry — a blank input is a legitimate 0', () => {
    expect(claimedToDateCountError([storedLine()], [''])).toBeNull()
  })

  it('does not mutate its inputs', () => {
    const l = deepFreeze([storedLine()])
    const v = deepFreeze(['1'])
    expect(() => claimedToDateCountError(l, v)).not.toThrow()
  })
})

// ── E. claimTotals — CHARACTERISATION of shipped behaviour ───────────────────

describe('claimTotals (characterisation)', () => {
  it('charges GST on the POST-retention net, not the gross claim', () => {
    const t = claimTotals([10000], 1000)
    expect(t).toEqual({ subtotal: 10000, retention: 1000, net: 9000, gst: 900, total: 9900 })
    expect(t.gst).toBe(roundMoney(t.net * GST_RATE))
  })

  it('is deliberately NOT the PO formula (gst = subtotal × 10%)', () => {
    const t = claimTotals([10000], 1000)
    expect(t.gst).not.toBe(roundMoney(10000 * GST_RATE))
  })

  it('sums the line amounts into the subtotal', () => {
    expect(claimTotals([1000, 2000, 3000]).subtotal).toBe(6000)
  })

  it('clamps retention to the subtotal', () => {
    const t = claimTotals([500], 900)
    expect(t).toEqual({ subtotal: 500, retention: 500, net: 0, gst: 0, total: 0 })
  })

  it('treats a retention exactly equal to the subtotal as a zero payable', () => {
    expect(claimTotals([1000], 1000)).toEqual({ subtotal: 1000, retention: 1000, net: 0, gst: 0, total: 0 })
  })

  it('defaults retention to 0 when omitted', () => {
    expect(claimTotals([1000])).toEqual({ subtotal: 1000, retention: 0, net: 1000, gst: 100, total: 1100 })
  })

  it('CHARACTERISATION: a NEGATIVE retention is currently permitted and INCREASES the payable', () => {
    // Math.min(-100, subtotal) === -100 — there is no lower clamp today. The
    // editor's input has min="0", so this is not reachable through the UI.
    // Recorded, deliberately NOT changed by ADR-37.
    const t = claimTotals([1000], -100)
    expect(t).toEqual({ subtotal: 1000, retention: -100, net: 1100, gst: 110, total: 1210 })
  })

  it('CHARACTERISATION: a blank / null retention is 0; a NaN retention is 0', () => {
    expect(claimTotals([1000], '').retention).toBe(0)
    expect(claimTotals([1000], null).retention).toBe(0)
    expect(claimTotals([1000], undefined).retention).toBe(0)
    expect(claimTotals([1000], 'abc').retention).toBe(0)
    expect(claimTotals([1000], NaN).retention).toBe(0)
  })

  it('CHARACTERISATION: accepts a retention as a numeric STRING, as the editor input supplies it', () => {
    expect(claimTotals([1000], '250')).toEqual({ subtotal: 1000, retention: 250, net: 750, gst: 75, total: 825 })
  })

  it('treats blank / null / non-numeric LINE amounts as 0', () => {
    expect(claimTotals(['', null, undefined, 'abc', 100]).subtotal).toBe(100)
  })

  it('returns zeros for no lines', () => {
    expect(claimTotals([])).toEqual({ subtotal: 0, retention: 0, net: 0, gst: 0, total: 0 })
  })

  it('CHARACTERISATION: a net negative claim is not clamped', () => {
    expect(claimTotals([-500])).toEqual({ subtotal: -500, retention: -500, net: 0, gst: 0, total: 0 })
  })

  it('rounds every figure to cents', () => {
    const t = claimTotals([0.1, 0.2], 0)
    expect(t.subtotal).toBe(0.3)
    const u = claimTotals([1234.567], 0)
    expect(u.subtotal).toBe(1234.57)
    expect(u.gst).toBe(123.46)
  })

  it('total always equals net + gst', () => {
    for (const [lines, ret] of [[[10000], 0], [[3333.33], 111.11], [[1, 2, 3], 2.5], [[999.99], 0.01]]) {
      const t = claimTotals(lines, ret)
      expect(t.total).toBe(roundMoney(t.net + t.gst))
    }
  })
})

// ── F. previouslyApprovedByPoLine — CHARACTERISATION ─────────────────────────

describe('previouslyApprovedByPoLine (characterisation)', () => {
  const claim = (status, lines, o = {}) => ({ id: 'c', poId: 'po1', status, lineItems: lines, ...o })
  const line  = (poLineIndex, approvedThisPeriod) => ({ poLineIndex, approvedThisPeriod })

  it('counts APPROVED claims', () => {
    expect(previouslyApprovedByPoLine([claim(CLAIM_STATUS.APPROVED, [line(0, 1000)])], 'po1')).toEqual({ 0: 1000 })
  })

  it('counts INVOICED claims', () => {
    expect(previouslyApprovedByPoLine([claim(CLAIM_STATUS.INVOICED, [line(0, 1000)])], 'po1')).toEqual({ 0: 1000 })
  })

  it('IGNORES draft, submitted, under_review and rejected claims', () => {
    for (const s of [CLAIM_STATUS.DRAFT, CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW, CLAIM_STATUS.REJECTED]) {
      expect(previouslyApprovedByPoLine([claim(s, [line(0, 5000)])], 'po1')).toEqual({})
    }
  })

  it('ignores claims on another PO', () => {
    const other = claim(CLAIM_STATUS.APPROVED, [line(0, 9999)], { poId: 'po2' })
    expect(previouslyApprovedByPoLine([other], 'po1')).toEqual({})
  })

  it('accumulates across several certified claims, per poLineIndex', () => {
    const claims = [
      claim(CLAIM_STATUS.APPROVED, [line(0, 1000), line(1, 500)]),
      claim(CLAIM_STATUS.INVOICED, [line(0, 250.5), line(1, 0)]),
      claim(CLAIM_STATUS.APPROVED, [line(0, 0.25)]),
    ]
    expect(previouslyApprovedByPoLine(claims, 'po1')).toEqual({ 0: 1250.75, 1: 500 })
  })

  it('is safe with missing / empty lineItems', () => {
    expect(previouslyApprovedByPoLine([claim(CLAIM_STATUS.APPROVED, undefined)], 'po1')).toEqual({})
    expect(previouslyApprovedByPoLine([], 'po1')).toEqual({})
  })

  it('treats a null approvedThisPeriod as 0', () => {
    expect(previouslyApprovedByPoLine([claim(CLAIM_STATUS.APPROVED, [line(0, null)])], 'po1')).toEqual({ 0: 0 })
  })
})

// ── G. approval bounds — unchanged, and bounded by the EDITED claim ──────────

describe('approval bounds after a draft edit', () => {
  it('approvedLineError still bounds a certified amount to [0, claimedThisPeriod]', () => {
    const line = { claimedThisPeriod: 1000 }
    expect(approvedLineError(line, 1000)).toBeNull()
    expect(approvedLineError(line, 0)).toBeNull()
    expect(approvedLineError(line, '')).toBeNull()
    expect(approvedLineError(line, -1)).toBe('Certified amount cannot be negative')
    expect(approvedLineError(line, 1000.01)).toBe('Certified amount cannot exceed the claimed amount')
    expect(approvedLineError(line, 'abc')).toBe('Certified amount must be a number')
  })

  it('the bound follows the EDITED claimed amount — a raised edit widens it', () => {
    const edited = buildClaimLine(storedLine({ previouslyApproved: 0 }), { claimedToDate: '4000' })
    expect(edited.claimedThisPeriod).toBe(4000)
    expect(approvedLineError(edited, 4000)).toBeNull()
    expect(approvedLineError(edited, 4000.01)).toBe('Certified amount cannot exceed the claimed amount')
  })

  it('the bound follows the EDITED claimed amount — a lowered edit narrows it', () => {
    const edited = buildClaimLine(storedLine({ previouslyApproved: 0, claimedThisPeriod: 9999 }), { claimedToDate: '500' })
    expect(approvedLineError(edited, 600)).toBe('Certified amount cannot exceed the claimed amount')
    expect(approvedLineError(edited, 500)).toBeNull()
  })

  it('validateApprovedAmounts still requires one amount per line and is unchanged', () => {
    const lines = [{ claimedThisPeriod: 100 }, { claimedThisPeriod: 200 }]
    expect(validateApprovedAmounts(lines, [100, 200])).toBeNull()
    expect(validateApprovedAmounts(lines, [100])).toBe('Approval requires a certified amount for every claim line')
    expect(validateApprovedAmounts(lines, [100, 300])).toBe('Line 2: Certified amount cannot exceed the claimed amount')
    expect(validateApprovedAmounts(lines, null)).toBe('Approval requires a certified amount for every claim line')
  })
})

// ── the lifecycle is untouched ───────────────────────────────────────────────

describe('CLAIM_EDITABLE_STATUSES', () => {
  it('is exactly draft — the freeze point stays at submitted', () => {
    expect(CLAIM_EDITABLE_STATUSES).toEqual([CLAIM_STATUS.DRAFT])
    for (const s of [CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.UNDER_REVIEW, CLAIM_STATUS.APPROVED,
                     CLAIM_STATUS.REJECTED, CLAIM_STATUS.INVOICED]) {
      expect(CLAIM_EDITABLE_STATUSES.includes(s)).toBe(false)
    }
  })

  it('leaves the existing lifecycle untouched — no reopen, no new status', () => {
    expect(CLAIM_TRANSITIONS).toEqual({
      draft:        ['submitted', 'rejected'],
      submitted:    ['under_review', 'approved', 'rejected'],
      under_review: ['approved', 'rejected'],
      approved:     ['invoiced'],
      rejected:     [],
      invoiced:     [],
    })
    expect(canTransition(CLAIM_STATUS.SUBMITTED, CLAIM_STATUS.DRAFT)).toBe(false)
    expect(canTransition(CLAIM_STATUS.APPROVED, CLAIM_STATUS.DRAFT)).toBe(false)
    expect(canTransition(CLAIM_STATUS.REJECTED, CLAIM_STATUS.DRAFT)).toBe(false)
  })

  it('leaves the counting-point status sets untouched', () => {
    expect(CLAIM_OPEN_STATUSES).toEqual(['draft', 'submitted', 'under_review'])
    expect(CLAIM_PENDING_STATUSES).toEqual(['submitted', 'under_review'])
    expect(CLAIM_APPROVED_STATUSES).toEqual(['approved', 'invoiced'])
    expect(CLAIMABLE_PO_STATUSES).toEqual([PO_STATUS.SENT])
    expect(formatClaimNumber(7)).toBe('PC-0007')
  })

  it('a draft under edit keeps its PO closed to a second claim', () => {
    const draft = { id: 'c1', poId: 'po1', status: CLAIM_STATUS.DRAFT }
    expect(hasOpenClaim([draft], 'po1')).toBe(true)
    expect(hasOpenClaim([{ ...draft, status: CLAIM_STATUS.REJECTED }], 'po1')).toBe(false)
    expect(hasOpenClaim([{ ...draft, status: CLAIM_STATUS.APPROVED }], 'po1')).toBe(false)
  })
})

// ── H. update payload / immutable contract ───────────────────────────────────

// Mirrors useProgressClaims.updateProgressClaim exactly: the caller supplies
// only authored values; every line is rebuilt over the STORED lines.
function draftUpdatePayload(claim, { periodEnding, claimRef, notes, retention, claimedToDate }) {
  const countError = claimedToDateCountError(claim.lineItems, claimedToDate)
  if (countError) throw new Error(countError)
  const lineItems = claim.lineItems.map((stored, idx) =>
    buildClaimLine(stored, { claimedToDate: claimedToDate[idx] }))
  const draftError = validateClaimDraft({ lineItems })
  if (draftError) throw new Error(draftError)
  const totals = claimTotals(lineItems.map(li => li.claimedThisPeriod), retention)
  return {
    claimRef:        claimRef?.trim() || '',
    periodEnding:    periodEnding || '',
    lineItems,
    retention:       totals.retention,
    claimedSubtotal: totals.subtotal,
    claimedGst:      totals.gst,
    claimedTotal:    totals.total,
    notes:           notes?.trim() || '',
  }
}

const storedClaim = (o = {}) => deepFreeze({
  id: 'c1', claimNumber: 'PC-0007', status: CLAIM_STATUS.DRAFT,
  poId: 'po1', poNumber: 'PO-0001', supplierName: 'Legacy Supplies', supplierId: null,
  claimRef: 'S-1', periodEnding: '2026-01-31', variationId: null,
  lineItems: [
    storedLine({ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',
      poLineTotal: 10000, previouslyApproved: 2000, claimedToDate: 5000, claimedThisPeriod: 3000 }),
    storedLine({ poLineIndex: 1, costCodeId: 'cc2', costCodeName: '05-200 — Steel', description: 'Beams',
      poLineTotal: 20000, previouslyApproved: 0, claimedToDate: 0, claimedThisPeriod: 0 }),
  ],
  retention: 300, claimedSubtotal: 3000, claimedGst: 270, claimedTotal: 2970,
  approvedSubtotal: null, approvedGst: null, approvedTotal: null,
  notes: 'old note', assessmentNotes: '',
  currency: 'AUD', revision: 1,
  submittedAt: null, approvedAt: null, rejectedAt: null, invoicedAt: null, approvedBy: null,
  externalRefs: {}, createdAt: 't0', createdBy: 'u1',
  ...o,
})

const IMMUTABLE = [
  'id', 'claimNumber', 'status', 'poId', 'poNumber', 'supplierName', 'supplierId',
  'variationId', 'currency', 'revision',
  'approvedSubtotal', 'approvedGst', 'approvedTotal', 'assessmentNotes',
  'submittedAt', 'approvedAt', 'rejectedAt', 'invoicedAt', 'approvedBy',
  'externalRefs', 'createdAt', 'createdBy',
]

describe('draft edit — update payload contract', () => {
  const edit = { periodEnding: '2026-02-28', claimRef: ' S-2 ', notes: undefined, retention: '500', claimedToDate: ['8000', '1000'] }

  it('contains ONLY the draft-editable fields and the derived totals', () => {
    const payload = draftUpdatePayload(storedClaim(), edit)
    expect(Object.keys(payload).sort()).toEqual(
      ['claimRef', 'claimedGst', 'claimedSubtotal', 'claimedTotal', 'lineItems', 'notes', 'periodEnding', 'retention'].sort()
    )
    for (const k of IMMUTABLE) expect(k in payload).toBe(false)
    expect(payload.claimRef).toBe('S-2')
    expect(payload.notes).toBe('')
  })

  it('re-derives every claimedThisPeriod and the header totals — caller figures are never trusted', () => {
    const payload = draftUpdatePayload(storedClaim(), edit)
    expect(payload.lineItems.map(l => l.claimedThisPeriod)).toEqual([6000, 1000])
    expect(payload).toMatchObject({ claimedSubtotal: 7000, retention: 500, claimedGst: 650, claimedTotal: 7150 })
  })

  it('preserves every per-line identity field from the stored document', () => {
    const stored  = storedClaim()
    const payload = draftUpdatePayload(stored, edit)
    payload.lineItems.forEach((l, i) => {
      const s = stored.lineItems[i]
      expect(l.poLineIndex).toBe(s.poLineIndex)
      expect(l.costCodeId).toBe(s.costCodeId)
      expect(l.costCodeName).toBe(s.costCodeName)
      expect(l.description).toBe(s.description)
      expect(l.poLineTotal).toBe(s.poLineTotal)
      expect(l.previouslyApproved).toBe(s.previouslyApproved)   // stored value preserved, never re-derived
      expect(l.approvedThisPeriod).toBeNull()
    })
  })

  it('keeps the line set FIXED — same length, same order, same poLineIndexes', () => {
    const payload = draftUpdatePayload(storedClaim(), edit)
    expect(payload.lineItems).toHaveLength(2)
    expect(payload.lineItems.map(l => l.poLineIndex)).toEqual([0, 1])
  })

  it('refuses a mismatched claimed-value list rather than writing a mispaired claim', () => {
    expect(() => draftUpdatePayload(storedClaim(), { ...edit, claimedToDate: ['8000'] })).toThrow(/expected 2, got 1/)
    expect(() => draftUpdatePayload(storedClaim(), { ...edit, claimedToDate: ['1', '2', '3'] })).toThrow(/expected 2, got 3/)
  })

  it('refuses an invalid draft rather than writing it', () => {
    expect(() => draftUpdatePayload(storedClaim(), { ...edit, claimedToDate: ['1000', '0'] }))
      .toThrow(/Line 1: claimed to date cannot be below the previously approved amount/)
    expect(() => draftUpdatePayload(storedClaim(), { ...edit, claimedToDate: ['2000', '0'] }))
      .toThrow(/must claim an amount on at least one line/)
  })

  it('merging the payload over a stored claim changes NOTHING immutable', () => {
    const stored = storedClaim()
    const after  = { ...stored, ...draftUpdatePayload(stored, edit) }
    for (const k of IMMUTABLE) expect(after[k]).toEqual(stored[k])
    expect(after.supplierId).toBeNull()                 // legacy supplierId: null survives an edit
    expect(after.supplierName).toBe('Legacy Supplies')
    expect(after.poNumber).toBe('PO-0001')
    expect(after.claimNumber).toBe('PC-0007')
    expect(after.status).toBe(CLAIM_STATUS.DRAFT)
    // …and the authored fields did change
    expect(after.periodEnding).toBe('2026-02-28')
    expect(after.claimedTotal).toBe(7150)
  })

  it('never resurrects a certified amount onto a draft line', () => {
    const stored = storedClaim({
      lineItems: [storedLine({ poLineIndex: 0, previouslyApproved: 0, approvedThisPeriod: 12345 })],
    })
    const payload = draftUpdatePayload(stored, { ...edit, claimedToDate: ['100'] })
    expect(payload.lineItems[0].approvedThisPeriod).toBeNull()
  })

  it('an untouched edit is a no-op on every stored value', () => {
    const stored  = storedClaim()
    const payload = draftUpdatePayload(stored, {
      periodEnding: stored.periodEnding, claimRef: stored.claimRef, notes: stored.notes,
      retention: stored.retention, claimedToDate: stored.lineItems.map(claimLineToForm),
    })
    const after = { ...stored, ...payload }
    expect(after.lineItems).toEqual(stored.lineItems)
    expect(after.claimedSubtotal).toBe(stored.claimedSubtotal)
    expect(after.claimedGst).toBe(stored.claimedGst)
    expect(after.claimedTotal).toBe(stored.claimedTotal)
    expect(after.retention).toBe(stored.retention)
  })
})

// ── purity ───────────────────────────────────────────────────────────────────

describe('draft edit — purity', () => {
  it('none of the helpers mutate frozen inputs', () => {
    const claim = storedClaim()
    const forms = deepFreeze(claim.lineItems.map(claimLineToForm))
    expect(() => claim.lineItems.map((l, i) => buildClaimLine(l, { claimedToDate: forms[i] }))).not.toThrow()
    expect(() => validateClaimDraft({ lineItems: claim.lineItems })).not.toThrow()
    expect(() => claimedToDateCountError(claim.lineItems, forms)).not.toThrow()
    expect(() => claimTotals(claim.lineItems.map(l => l.claimedThisPeriod), claim.retention)).not.toThrow()
    expect(() => previouslyApprovedByPoLine([claim], 'po1')).not.toThrow()
    expect(() => actualClaimsByCostCode([claim])).not.toThrow()
  })
})

// ── I. financial regression — draft claims are not counted; later ones are ───

describe('draft edit — financial regression (draft is never counted)', () => {
  const baseline = deepFreeze({ originalContractValue: 1_000_000, originalApprovedBudget: 800_000 })
  const COST_CODES = deepFreeze([
    { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
    { id: 'cc2', code: '05-200', name: 'Steel',    isActive: true },
  ])
  const budgetLines = deepFreeze([
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 100_000 },
    { costCodeId: 'cc2', costCodeName: '05-200 — Steel',    budgeted: 200_000 },
  ])
  const purchaseOrders = deepFreeze([{
    id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.SENT, supplierId: 's1', supplierName: 'Acme',
    lineItems: [
      { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab',  qty: 40, unit: 'm3', unitPrice: 250, lineTotal: 10000 },
      { costCodeId: 'cc2', costCodeName: '05-200 — Steel',    description: 'Beams', qty: 10, unit: 't',  unitPrice: 2000, lineTotal: 20000 },
    ],
    subtotal: 30000, gst: 3000, total: 33000,
  }])

  // An earlier CERTIFIED claim on the same PO — the previouslyApproved source.
  const approvedClaim = deepFreeze({
    id: 'c-approved', claimNumber: 'PC-0001', status: CLAIM_STATUS.APPROVED, poId: 'po1', poNumber: 'PO-0001',
    supplierId: 's1', supplierName: 'Acme', retention: 0,
    lineItems: [
      storedLine({ poLineIndex: 0, costCodeId: 'cc1', previouslyApproved: 0, claimedToDate: 2000, claimedThisPeriod: 2000, approvedThisPeriod: 2000 }),
      storedLine({ poLineIndex: 1, costCodeId: 'cc2', costCodeName: '05-200 — Steel', poLineTotal: 20000, previouslyApproved: 0, claimedToDate: 0, claimedThisPeriod: 0, approvedThisPeriod: 0 }),
    ],
    claimedSubtotal: 2000, claimedGst: 200, claimedTotal: 2200,
    approvedSubtotal: 2000, approvedGst: 200, approvedTotal: 2200,
  })

  // A posted supplier invoice holding retention — pins the Retention module.
  const supplierInvoices = deepFreeze([{
    id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'A-1', status: 'posted',
    supplierId: 's1', supplierName: 'Acme', poId: 'po1', poNumber: 'PO-0001',
    progressClaimId: 'c-approved', claimNumber: 'PC-0001',
    lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 2000, taxCode: 'gst', gstAmount: 200 }],
    subtotal: 2000, gstTotal: 200, grossTotal: 2200,
    retention: 100, retentionGst: 10, retentionTotal: 110,
    net: 1900, payableGst: 190, payableTotal: 2090,
  }])

  const draftClaim = deepFreeze({
    id: 'c-draft', claimNumber: 'PC-0002', status: CLAIM_STATUS.DRAFT, poId: 'po1', poNumber: 'PO-0001',
    supplierId: 's1', supplierName: 'Acme', claimRef: '', periodEnding: '', notes: '', variationId: null,
    lineItems: [
      storedLine({ poLineIndex: 0, costCodeId: 'cc1', previouslyApproved: 2000, claimedToDate: 3000, claimedThisPeriod: 1000 }),
      storedLine({ poLineIndex: 1, costCodeId: 'cc2', costCodeName: '05-200 — Steel', poLineTotal: 20000, previouslyApproved: 0, claimedToDate: 0, claimedThisPeriod: 0 }),
    ],
    retention: 0, claimedSubtotal: 1000, claimedGst: 100, claimedTotal: 1100,
    approvedSubtotal: null, approvedGst: null, approvedTotal: null,
    assessmentNotes: '', currency: 'AUD', revision: 1,
    submittedAt: null, approvedAt: null, rejectedAt: null, invoicedAt: null, approvedBy: null,
    externalRefs: {}, createdAt: 't1', createdBy: 'u1',
  })

  // A LARGE arbitrary edit: both lines raised well past their PO line values,
  // a big retention, and every metadata field rewritten.
  const bigEdit = {
    periodEnding: '2026-06-30', claimRef: 'CORRECTED', notes: 'reissued',
    retention: '1234.56', claimedToDate: ['19500.25', '48000'],
  }
  const editedDraft = { ...draftClaim, ...draftUpdatePayload(draftClaim, bigEdit) }

  const outputs = (progressClaims) => {
    const sources = { costCodes: COST_CODES, budgetLines, purchaseOrders, progressClaims, supplierInvoices }
    const forecastTotals = projectForecastTotals(sources)
    const rows = buildForecastRows(sources)
    const m = computeMargin({ baseline, forecastFinalCost: forecastTotals.forecastFinalCost })
    const invByPoLine = postedInvoicedByPoLine(supplierInvoices)
    return {
      // claim-side maps
      actualClaims:   actualClaimsByCostCode(progressClaims, invoicedClaimIds(supplierInvoices)),
      approvedClaims: approvedByCostCode(progressClaims),
      claimedPending: claimedPendingByCostCode(progressClaims),
      prevApproved:   previouslyApprovedByPoLine(progressClaims, 'po1'),
      // PO / commitment
      committed:      committedByCostCode(purchaseOrders),
      matured:        maturedCommittedByCostCode(purchaseOrders, invByPoLine),
      // forecast / margin
      rows: rows.map(r => [r.costCodeId, r.remainingCommitted, r.actual, r.forecastFinalCost ?? null]),
      forecastRemainingCommitted: forecastTotals.remainingCommitted,
      forecastActual:             forecastTotals.actual,
      forecastFinalCost:          forecastTotals.forecastFinalCost,
      forecastGrossProfit:        m.forecastGrossProfit,
      forecastMarginPct:          m.forecastMarginPct,
      // supplier invoicing / retention / cash-flow inputs
      invoiceable: progressClaims
        .filter(c => c.status === CLAIM_STATUS.APPROVED && !claimHasActiveInvoice(supplierInvoices, c.id))
        .map(c => c.id),
      retentionRows:    retentionInvoiceRows(supplierInvoices, []).map(r => [r.id, r.retentionTotal, r.retentionHeld]),
      retentionSummary: retentionSummary(supplierInvoices, []),
      released:         releasedByInvoiceId([]),
    }
  }

  it('the edit really did change the draft claim', () => {
    expect(editedDraft.lineItems.map(l => l.claimedThisPeriod)).toEqual([17500.25, 48000])
    expect(editedDraft.claimedSubtotal).toBe(65500.25)
    expect(editedDraft.retention).toBe(1234.56)
    expect(editedDraft.claimedTotal).toBe(70692.26)
    expect(editedDraft.claimRef).toBe('CORRECTED')
    // …and left every immutable value alone
    for (const k of IMMUTABLE) expect(editedDraft[k]).toEqual(draftClaim[k])
  })

  it('a draft claim contributes nothing — every derived figure is byte-identical before and after', () => {
    const before = outputs([approvedClaim, draftClaim])
    const after  = outputs([approvedClaim, editedDraft])
    expect(after).toEqual(before)
  })

  it('removing the draft claim entirely is equally invisible', () => {
    expect(outputs([approvedClaim])).toEqual(outputs([approvedClaim, draftClaim]))
    expect(outputs([approvedClaim])).toEqual(outputs([approvedClaim, editedDraft]))
  })

  it('the draft is absent from Actual, Claimed, previously-approved and the invoiceable list', () => {
    const o = outputs([approvedClaim, editedDraft])
    expect(o.claimedPending).toEqual({})                       // draft is not pending exposure
    expect(o.actualClaims).toEqual({})                         // the approved claim is superseded by its posted invoice
    expect(o.approvedClaims).toEqual({ cc1: 2000, cc2: 0 })    // certified only, edit-invariant
    expect(o.prevApproved).toEqual({ 0: 2000, 1: 0 })          // the edit did not move the seed
    expect(o.invoiceable).toEqual([])                          // c-approved already has an active invoice
  })

  it('Committed and PO remaining value never move — a claim of any status is not read there', () => {
    const o = outputs([approvedClaim, editedDraft])
    expect(o.committed).toEqual({ cc1: 10000, cc2: 20000 })
    expect(o.matured).toEqual({ cc1: 8000, cc2: 20000 })       // reduced by the POSTED INVOICE, not by any claim
  })

  it('Retention Held / Released derive from posted invoices only, never from a claim', () => {
    const o = outputs([approvedClaim, editedDraft])
    expect(o.retentionRows).toEqual([['inv1', 110, 110]])
    expect(o.retentionSummary.retentionHeld).toBe(110)
    expect(o.released).toEqual({})
  })

  // ── counting points ────────────────────────────────────────────────────────

  it('SUBMITTING the edited draft moves Budget Claimed by exactly the edited amounts', () => {
    const before = outputs([approvedClaim, editedDraft])
    const submitted = { ...editedDraft, status: CLAIM_STATUS.SUBMITTED }
    const after = outputs([approvedClaim, submitted])
    expect(before.claimedPending).toEqual({})
    expect(after.claimedPending).toEqual({ cc1: 17500.25, cc2: 48000 })
    expect(after.actualClaims).toEqual(before.actualClaims)     // Actual still unmoved
    expect(after.forecastFinalCost).toBe(before.forecastFinalCost)
  })

  it('APPROVING moves Actual by the CERTIFIED amounts, bounded by the edited claim', () => {
    const certified = [17500.25, 20000]                         // partial approval on line 2
    expect(validateApprovedAmounts(editedDraft.lineItems, certified)).toBeNull()
    expect(validateApprovedAmounts(editedDraft.lineItems, [17500.25, 48000.01]))
      .toBe('Line 2: Certified amount cannot exceed the claimed amount')

    const approved = {
      ...editedDraft, status: CLAIM_STATUS.APPROVED,
      lineItems: editedDraft.lineItems.map((li, i) => ({ ...li, approvedThisPeriod: certified[i] })),
    }
    const after = outputs([approvedClaim, approved])
    expect(after.actualClaims).toEqual({ cc1: 17500.25, cc2: 20000 })
    expect(after.claimedPending).toEqual({})
    expect(after.prevApproved).toEqual({ 0: 19500.25, 1: 20000 })
    expect(after.forecastActual).toBeGreaterThan(outputs([approvedClaim, editedDraft]).forecastActual)
  })

  it('a WITHDRAWN (rejected) draft contributes nothing either', () => {
    const withdrawn = { ...editedDraft, status: CLAIM_STATUS.REJECTED }
    expect(outputs([approvedClaim, withdrawn])).toEqual(outputs([approvedClaim, draftClaim]))
    expect(hasOpenClaim([withdrawn], 'po1')).toBe(false)         // …and frees the PO
  })
})
