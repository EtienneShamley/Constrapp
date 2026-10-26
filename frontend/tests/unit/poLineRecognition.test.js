import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  directInvoiceLineConflicts, directInvoiceConflictError,
  claimLineConflicts, claimLineConflictError,
  mixedModePoLineConflicts, mixedModeOverlapTotal,
} from '../../src/lib/poLineRecognition'
import { remainingCommittedByCostCode, remainingCommittedByPoLine, committedByCostCode, PO_STATUS } from '../../src/lib/purchaseOrders'
import { recognisedClaimsByPoLine, claimedPoLines, CLAIM_STATUS } from '../../src/lib/progressClaims'
import {
  directInvoicedPoLines, postedDirectInvoicedByPoLine, postedInvoicedByPoLine, invoicedClaimIds, SI_STATUS, SI_SOURCE,
} from '../../src/lib/supplierInvoices'

// ── ADR-55 — one recognition path per PO line ────────────────────────────────
//
// A PO line's cost reaches Actual through a progress claim OR a direct invoice.
// The claim→invoice hand-over keys on `progressClaimId`, so a direct invoice
// can never supersede a claim: if both paths touch one line, Actual counts the
// line twice. These helpers (a) net approved claims out of Remaining Committed
// per line, (b) block a NEW conflicting combination in the editors, and (c)
// list the overlaps that already exist. All client-enforced — Deferred
// Control 34.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

const PO = {
  id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.SENT,
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', lineTotal: 800 },
    { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', lineTotal: 400 },
    { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Pump', lineTotal: 100 },
  ],
}
const claim = (id, status, lines, over = {}) => ({ id, claimNumber: id.toUpperCase(), status, poId: 'po1', lineItems: lines, ...over })
const cl = (idx, { toDate = 0, thisPeriod = 0, approved = null, costCodeId = 'cc1' } = {}) =>
  ({ poLineIndex: idx, costCodeId, claimedToDate: toDate, claimedThisPeriod: thisPeriod, approvedThisPeriod: approved })
const inv = (id, status, lines, over = {}) => ({
  id, invoiceNumber: id.toUpperCase(), status, poId: 'po1', source: SI_SOURCE.DIRECT_PO, progressClaimId: null, lineItems: lines, ...over,
})
const il = (idx, amount, costCodeId = 'cc1') => ({ poLineIndex: idx, costCodeId, amount })

// ── (a) the per-line netting ─────────────────────────────────────────────────

describe('recognisedClaimsByPoLine — approved claim value Actual recognises, per PO line', () => {
  it('sums approved claims by poId then poLineIndex, skipping other statuses', () => {
    const claims = [
      claim('c1', CLAIM_STATUS.APPROVED, [cl(0, { approved: 300 }), cl(1, { approved: 50, costCodeId: 'cc2' })]),
      claim('c2', CLAIM_STATUS.APPROVED, [cl(0, { approved: 100 })]),
      claim('c3', CLAIM_STATUS.SUBMITTED, [cl(0, { thisPeriod: 999 })]),
      claim('c4', CLAIM_STATUS.REJECTED, [cl(0, { approved: 999 })]),
      claim('c5', CLAIM_STATUS.DRAFT, [cl(0, { toDate: 999 })]),
    ]
    expect(recognisedClaimsByPoLine(claims)).toEqual({ po1: { 0: 400, 1: 50 } })
  })

  it('excludes a claim superseded by its posted invoice — the invoice takes its place in the other map', () => {
    const claims = [claim('c1', CLAIM_STATUS.APPROVED, [cl(0, { approved: 300 })])]
    const posted = [inv('si1', SI_STATUS.POSTED, [il(0, 300)], { source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'c1' })]
    expect(recognisedClaimsByPoLine(claims, invoicedClaimIds(posted))).toEqual({})   // the superseded claim creates no entry at all
    expect(postedInvoicedByPoLine(posted)).toEqual({ po1: { 0: 300 } })
    // A DRAFT invoice supersedes nothing.
    const drafted = [{ ...posted[0], status: SI_STATUS.DRAFT }]
    expect(recognisedClaimsByPoLine(claims, invoicedClaimIds(drafted))).toEqual({ po1: { 0: 300 } })
  })

  it('skips a line with no poLineIndex and a claim with no poId, and rounds to cents', () => {
    const claims = [
      claim('c1', CLAIM_STATUS.APPROVED, [{ costCodeId: 'cc1', approvedThisPeriod: 300 }, cl(0, { approved: 0.1 }), cl(0, { approved: 0.2 })]),
      claim('c2', CLAIM_STATUS.APPROVED, [cl(0, { approved: 5 })], { poId: null }),
    ]
    expect(recognisedClaimsByPoLine(claims)).toEqual({ po1: { 0: 0.3 } })
  })
})

describe('remainingCommittedByPoLine / remainingCommittedByCostCode — THE Remaining Committed formula', () => {
  const invoicedByLine = { po1: { 0: 200 } }
  const recognisedByLine = { po1: { 0: 300, 2: 100 } }

  it('nets posted invoicing AND recognised claims per line, floors at zero', () => {
    expect(remainingCommittedByPoLine([PO], invoicedByLine, recognisedByLine)).toEqual({ po1: { 0: 300, 1: 400, 2: 0 } })
    expect(remainingCommittedByCostCode([PO], invoicedByLine, recognisedByLine)).toEqual({ cc1: 300, cc2: 400 })
  })

  it('with no claims it is the former invoice-only maturing; with no invoices it nets the claims alone', () => {
    expect(remainingCommittedByCostCode([PO], invoicedByLine, {})).toEqual({ cc1: 700, cc2: 400 })
    expect(remainingCommittedByCostCode([PO], {}, recognisedByLine)).toEqual({ cc1: 500, cc2: 400 })
    expect(remainingCommittedByCostCode([PO])).toEqual({ cc1: 900, cc2: 400 })
  })

  it('never double-subtracts: a claim and the posted invoice that supersedes it are never both in the inputs', () => {
    const claims = [claim('c1', CLAIM_STATUS.APPROVED, [cl(0, { approved: 300 })])]
    const before = remainingCommittedByCostCode([PO], {}, recognisedClaimsByPoLine(claims, new Set()))
    const posted = [inv('si1', SI_STATUS.POSTED, [il(0, 300)], { source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'c1' })]
    const after = remainingCommittedByCostCode([PO], postedInvoicedByPoLine(posted), recognisedClaimsByPoLine(claims, invoicedClaimIds(posted)))
    expect(before).toEqual({ cc1: 600, cc2: 400 })
    expect(after).toEqual(before)
  })

  it('counts only sent/closed POs; total contractual commitment stays a separate figure', () => {
    for (const status of [PO_STATUS.DRAFT, PO_STATUS.PENDING_APPROVAL, PO_STATUS.CANCELLED]) {
      expect(remainingCommittedByCostCode([{ ...PO, status }], invoicedByLine, recognisedByLine)).toEqual({})
    }
    expect(remainingCommittedByCostCode([{ ...PO, status: PO_STATUS.CLOSED }], invoicedByLine, recognisedByLine)).toEqual({ cc1: 300, cc2: 400 })
    expect(committedByCostCode([PO])).toEqual({ cc1: 900, cc2: 400 })  // never matures
  })

  it('skips lines without a cost code and omits exhausted codes rather than writing a zero or a negative', () => {
    const po = { ...PO, lineItems: [{ lineTotal: 50 }, { costCodeId: 'cc9', lineTotal: 10 }] }
    expect(remainingCommittedByCostCode([po], { po1: { 1: 40 } }, {})).toEqual({})
  })
})

// ── (b) authoring guards ─────────────────────────────────────────────────────

describe('claimedPoLines / directInvoicedPoLines — which records occupy a line', () => {
  it('a claim occupies a line it has claimed or been certified on; rejected claims and zero lines do not', () => {
    const claims = [
      claim('c1', CLAIM_STATUS.APPROVED, [cl(0, { approved: 300 }), cl(1, { costCodeId: 'cc2' })]),
      claim('c2', CLAIM_STATUS.DRAFT, [cl(2, { toDate: 10 })]),
      claim('c3', CLAIM_STATUS.SUBMITTED, [cl(1, { thisPeriod: 5, costCodeId: 'cc2' })]),
      claim('c4', CLAIM_STATUS.REJECTED, [cl(1, { toDate: 999, costCodeId: 'cc2' })]),
      claim('c5', CLAIM_STATUS.APPROVED, [cl(0, { approved: 1 })], { poId: 'other' }),
    ]
    expect(claimedPoLines(claims, 'po1')).toEqual({ 0: ['C1'], 1: ['C3'], 2: ['C2'] })
    expect(claimedPoLines(claims, 'po1', { excludeClaimId: 'c2' })).toEqual({ 0: ['C1'], 1: ['C3'] })
  })

  it('a direct invoice occupies a line it prices; cancelled, claim-sourced and zero lines do not', () => {
    const invoices = [
      inv('si1', SI_STATUS.DRAFT, [il(0, 100), il(1, 0, 'cc2')]),
      inv('si2', SI_STATUS.POSTED, [il(2, 50)]),
      inv('si3', SI_STATUS.CANCELLED, [il(1, 999, 'cc2')]),
      inv('si4', SI_STATUS.POSTED, [il(1, 999, 'cc2')], { source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'c1' }),
    ]
    expect(directInvoicedPoLines(invoices, 'po1')).toEqual({ 0: ['SI1'], 2: ['SI2'] })
    expect(directInvoicedPoLines(invoices, 'po1', { excludeInvoiceId: 'si1' })).toEqual({ 2: ['SI2'] })
  })
})

describe('directInvoiceLineConflicts — a direct invoice may not price a claimed line', () => {
  const claims = [claim('c1', CLAIM_STATUS.APPROVED, [cl(0, { approved: 300 })]), claim('c2', CLAIM_STATUS.DRAFT, [cl(2, { toDate: 10 })])]

  it('flags only positive amounts on claimed lines, naming the claim', () => {
    const conflicts = directInvoiceLineConflicts({ po: PO, lineItems: [il(0, 100), il(1, 50, 'cc2'), il(2, 0)], progressClaims: claims })
    expect(conflicts).toEqual([{ poLineIndex: 0, lineLabel: 'Line 1 (03-100 — Concrete)', claimNumbers: ['C1'] }])
    expect(directInvoiceConflictError({ po: PO, lineItems: [il(0, 100)], progressClaims: claims }))
      .toMatch(/^Line 1 \(03-100 — Concrete\) is already being claimed through C1\./)
  })

  it('is silent for independent lines, zero amounts, a missing PO and no claims', () => {
    expect(directInvoiceConflictError({ po: PO, lineItems: [il(1, 50, 'cc2')], progressClaims: claims })).toBe(null)
    expect(directInvoiceConflictError({ po: PO, lineItems: [il(0, 0)], progressClaims: claims })).toBe(null)
    expect(directInvoiceConflictError({ po: null, lineItems: [il(0, 100)], progressClaims: claims })).toBe(null)
    expect(directInvoiceConflictError({ po: PO, lineItems: [il(0, 100)], progressClaims: [] })).toBe(null)
  })
})

describe('claimLineConflicts — a claim may not claim a directly invoiced line', () => {
  const invoices = [inv('si1', SI_STATUS.POSTED, [il(0, 100)]), inv('si2', SI_STATUS.DRAFT, [il(2, 5)])]

  it('flags lines claimed above zero on an invoiced line, naming the invoice', () => {
    const lines = [cl(0, { toDate: 300, thisPeriod: 300 }), cl(1, { toDate: 50, thisPeriod: 50, costCodeId: 'cc2' }), cl(2, { toDate: 0 })]
    expect(claimLineConflicts({ po: PO, lineItems: lines, supplierInvoices: invoices }))
      .toEqual([{ poLineIndex: 0, lineLabel: 'Line 1 (03-100 — Concrete)', invoiceNumbers: ['SI1'] }])
    expect(claimLineConflictError({ po: PO, lineItems: lines, supplierInvoices: invoices }))
      .toMatch(/^Line 1 \(03-100 — Concrete\) has already been invoiced directly \(SI1\)\./)
  })

  it('a line left at zero never conflicts; a claim-sourced invoice never occupies a line', () => {
    expect(claimLineConflictError({ po: PO, lineItems: [cl(0, { toDate: 0 }), cl(2, { toDate: 0 })], supplierInvoices: invoices })).toBe(null)
    const claimSourced = [inv('si9', SI_STATUS.POSTED, [il(0, 100)], { source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'c0' })]
    expect(claimLineConflictError({ po: PO, lineItems: [cl(0, { toDate: 300, thisPeriod: 300 })], supplierInvoices: claimSourced })).toBe(null)
  })
})

// ── (c) existing overlaps ────────────────────────────────────────────────────

describe('mixedModePoLineConflicts — lines Actual counts through both paths right now', () => {
  const claims = [claim('c1', CLAIM_STATUS.APPROVED, [cl(0, { approved: 300 }), cl(2, { approved: 20 })])]
  const direct = inv('si1', SI_STATUS.POSTED, [il(0, 200), il(1, 50, 'cc2')])

  it('lists one row per overlapping line with both figures, the overlap bound and the record numbers', () => {
    const rows = mixedModePoLineConflicts({ purchaseOrders: [PO], progressClaims: claims, supplierInvoices: [direct] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'po1:0', poId: 'po1', poNumber: 'PO-0001', poLineIndex: 0, lineLabel: 'Line 1 (03-100 — Concrete)',
      costCodeId: 'cc1', lineTotal: 800, directInvoiced: 200, recognisedClaims: 300, overlap: 200,
      invoiceNumbers: ['SI1'], claimNumbers: ['C1'], committed: true,
    })
    expect(mixedModeOverlapTotal(rows)).toBe(200)
    expect(mixedModeOverlapTotal([])).toBe(0)
  })

  it('is empty when the claim is superseded, when the direct invoice is not posted, or when lines differ', () => {
    const superseding = inv('si2', SI_STATUS.POSTED, [il(0, 300)], { source: SI_SOURCE.PROGRESS_CLAIM, progressClaimId: 'c1' })
    expect(mixedModePoLineConflicts({ purchaseOrders: [PO], progressClaims: claims, supplierInvoices: [direct, superseding] })).toEqual([])
    expect(mixedModePoLineConflicts({ purchaseOrders: [PO], progressClaims: claims, supplierInvoices: [{ ...direct, status: SI_STATUS.APPROVED }] })).toEqual([])
    expect(mixedModePoLineConflicts({ purchaseOrders: [PO], progressClaims: claims, supplierInvoices: [inv('si3', SI_STATUS.POSTED, [il(1, 50, 'cc2')])] })).toEqual([])
    expect(mixedModePoLineConflicts({})).toEqual([])
  })

  it('reads the exact maps Remaining Committed nets, so the overlap it reports is the one the figures carry', () => {
    const invoices = [direct]
    const byLine = remainingCommittedByPoLine([PO], postedInvoicedByPoLine(invoices), recognisedClaimsByPoLine(claims, invoicedClaimIds(invoices)))
    expect(byLine.po1[0]).toBe(800 - 200 - 300)
    expect(postedDirectInvoicedByPoLine(invoices)).toEqual({ po1: { 0: 200, 1: 50 } })
  })

  it('never mutates its inputs', () => {
    const frozen = (v) => JSON.parse(JSON.stringify(v))
    const args = { purchaseOrders: [PO], progressClaims: claims, supplierInvoices: [direct] }
    const snapshot = frozen(args)
    mixedModePoLineConflicts(args)
    expect(frozen(args)).toEqual(snapshot)
  })
})

// ── structure: the guards are wired where new records are authored ───────────

describe('structure — editors block new conflicts, the register and SHIELD list existing ones', () => {
  it('the supplier invoice editor blocks a conflicting direct invoice and the page lists overlaps', () => {
    const src = read('pages/project/ProjectInvoices.jsx')
    expect(src).toContain("directInvoiceConflictError({ po: conflictPo, lineItems: savedLines, progressClaims })")
    expect(src).toMatch(/const valid\s*= isEdit\s*\?\s*\(!stale && !draftError && !driftError && !conflictError\)/)
    expect(src).toContain('mixedModePoLineConflicts({ purchaseOrders, progressClaims, supplierInvoices })')
    expect(src).toContain('progressClaims={progressClaims}')
  })

  it('the progress claim editor blocks a claim on a directly invoiced line', () => {
    const src = read('pages/project/ProjectProgressClaims.jsx')
    expect(src).toContain("claimLineConflictError({ po: conflictPo, lineItems: builtLines, supplierInvoices })")
    expect(src).toContain('const valid      = !draftError && !conflictError && (isEdit || !!po) && !stale')
    expect(src).toContain('supplierInvoices={supplierInvoices}')
  })

  it('SHIELD check 4 composes the same selector and keeps its dependency list', () => {
    const src = read('lib/shield.js')
    expect(src).toContain("import { mixedModePoLineConflicts } from './poLineRecognition'")
    expect(src).toContain("MIXED_MODE_PO_LINE:        'mixed_mode_po_line'")
  })

  it('the module writes nothing and reads no Firebase', () => {
    const src = read('lib/poLineRecognition.js')
    expect(src).not.toMatch(/firebase|onSnapshot|setDoc|updateDoc|runTransaction/)
  })
})
