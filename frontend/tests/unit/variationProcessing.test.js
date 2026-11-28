import { describe, it, expect } from 'vitest'
import {
  createVariationRequest, createVariationRequestProblem, requestedCostCodeIds, buildVariationDraft, CREATE_PROBLEM,
  CREATE_VARIATION_KEYS, VARIATION_LIMITS, VARIATION_PROCESSING_ROLES, APPROVABLE_STATUSES,
  approvedAmountsProblem, submittedSideProblem, sameApproval, approvedHeaderSupported, approvalActorEvidence,
  approvedSideProblem, storedCostCodeIds, lineSources, withAuthoritativeNames, VARIATION_LINE_KEYS,
  UPDATE_VARIATION_KEYS, updateVariationRequest, updateVariationRequestProblem, buildVariationDraftUpdate, draftAlreadyHolds, DRAFT_PROBLEM,
} from '../../src/lib/variationProcessing'
import { transitionUpdate, VariationWriteError } from '../../src/lib/variationActions'
import { gstForLine, variationTotals, buildApprovedLineItems, buildVariationLineItem, variationCalcVersion, TAX_CODE } from '../../src/lib/variations'

// ── Trusted variation processing — the pure half (ADR-90 / ADR-91) ───────────
//
// EXPECTED FIGURES ARE WORKED INDEPENDENTLY, in whole cents, in the comments
// beside each case and by the BigInt oracle below — never by calling the code
// under test. The oracle shares nothing with src/lib: half-away-from-zero by
// quotient and remainder.

const halfAway = (num, den) => {
  const a = num < 0n ? -num : num
  const q = a / den
  const m = (a % den) * 2n >= den ? q + 1n : q
  return num < 0n ? -m : m
}
const gstCents = (c) => Number(halfAway(BigInt(c), 10n))
const c = (amount) => Math.round(amount * 100)

const NOW = 'server-time'
const PO = {
  id: 'po1', status: 'sent', poNumber: 'PO-0001', supplierName: 'Steel Co', supplierId: 'contactS1',
  lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete', lineTotal: 2500 }, { costCodeId: 'cc4', costCodeName: '04-200 — Masonry', lineTotal: 900 }],
}
const CODES = new Map([['cc2', { code: '05-100', name: 'Structural steel' }], ['cc3', { code: '01-000', name: 'Preliminaries' }]])
const RFI = { id: 'rfi1', status: 'answered', rfiNumber: 'RFI-0012', title: 'Revised connection' }

const request = (o = {}) => ({
  projectId: 'p1', variationId: 'var_0001', variationType: 'supplier',
  title: 'Additional steel', description: '', reason: 'design_change',
  clientId: null, clientName: null, clientRef: null,
  supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: 'Q-9', poId: null,
  originRfiId: null, identifiedDate: '2026-11-01', submittedDate: '', responseDueDate: '', effectiveDate: '', notes: '',
  lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Extra steel', submittedAmount: 1000, taxCode: 'gst' }],
  ...o,
})
const build = (input, o = {}) => buildVariationDraft({ input, number: 12, currency: 'NZD', po: null, costCodes: CODES, rfi: null, uid: 'u_qs', now: NOW, ...o })

describe('the create request — authored content only', () => {
  it('exact keys: a missing key, an extra key, a derived figure or a companyId refuses the request', () => {
    expect(createVariationRequestProblem(request())).toBeNull()
    const missing = request()
    delete missing.notes
    expect(createVariationRequestProblem(missing)).toBe('keys')
    for (const extra of ['submittedGst', 'submittedTotal', 'variationNumber', 'currency', 'status', 'calcVersion', 'companyId', 'createdBy', 'poNumber', 'originRfiTitle']) {
      expect(createVariationRequestProblem({ ...request(), [extra]: 1 }), extra).toBe('keys')
    }
    expect(createVariationRequestProblem(null)).toBe('keys')
    expect(createVariationRequestProblem([])).toBe('keys')
    expect(createVariationRequestProblem({ ...request(), lines: [{ ...request().lines[0], submittedGst: 100 }] })).toBe('line-keys')
    expect(createVariationRequestProblem({ ...request(), lines: [{ ...request().lines[0], costCodeName: 'x' }] })).toBe('line-keys')
  })

  it('the bounds the Rules have always applied to a stored variation', () => {
    const bad = (over, why) => expect(createVariationRequestProblem(request(over)), why).not.toBeNull()
    bad({ title: '' }, 'empty title')
    bad({ title: ' padded ' }, 'untrimmed title')
    bad({ title: 'x'.repeat(VARIATION_LIMITS.title + 1) }, 'long title')
    expect(createVariationRequestProblem(request({ title: 'x'.repeat(500) }))).toBeNull()
    bad({ description: 'x'.repeat(5001) }, 'long description')
    bad({ notes: 'x'.repeat(5001) }, 'long notes')
    bad({ reason: 'because' }, 'reason')
    bad({ identifiedDate: '1/11/2026' }, 'date')
    bad({ effectiveDate: 20261101 }, 'date type')
    bad({ variationType: 'internal' }, 'type')
    bad({ projectId: 'a/b' }, 'project id')
    bad({ variationId: '' }, 'variation id')
    bad({ supplierName: 'x'.repeat(201) }, 'supplier name')
    bad({ supplierRef: 'x'.repeat(201) }, 'supplier ref')
    bad({ lines: [] }, 'no lines')
    bad({ lines: Array.from({ length: 201 }, () => request().lines[0]) }, '201 lines')
    expect(createVariationRequestProblem(request({ lines: Array.from({ length: 200 }, () => ({ ...request().lines[0] })) }))).toBeNull()
  })

  it('counterparty consistency: each type carries its own block and nulls the other; a PO-linked request carries NO supplier', () => {
    const client = request({ variationType: 'client', clientId: 'c1', clientName: 'Client Pty', clientRef: 'CR-1', supplierId: null, supplierName: null, supplierRef: null })
    expect(createVariationRequestProblem(client)).toBeNull()
    expect(createVariationRequestProblem({ ...client, poId: 'po1' })).toBe('client-only')
    expect(createVariationRequestProblem({ ...client, supplierRef: '' })).toBe('client-only')
    expect(createVariationRequestProblem({ ...client, clientId: '' })).toBe('client')
    expect(createVariationRequestProblem(request({ clientName: 'x' }))).toBe('supplier-only')
    const linked = request({ poId: 'po1', supplierId: null, supplierName: null })
    expect(createVariationRequestProblem(linked)).toBeNull()
    expect(createVariationRequestProblem({ ...linked, supplierName: 'Forged Pty' })).toBe('po-link')
    expect(createVariationRequestProblem({ ...linked, supplierId: 'forged' })).toBe('po-link')
    expect(createVariationRequestProblem(request({ supplierId: null }))).toBeNull()   // a supplier with no contact id
  })

  it('lines: an amount is a finite number in range (negatives and zero are valid); a cost code XOR a PO line index', () => {
    const one = (line) => createVariationRequestProblem(request({ poId: 'po1', supplierId: null, supplierName: null, lines: [line] }))
    const base = { poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: 0, taxCode: 'gst' }
    expect(one(base)).toBeNull()
    expect(one({ ...base, submittedAmount: -5000.5 })).toBeNull()
    for (const amount of ['100', null, NaN, Infinity, 1e15]) expect(one({ ...base, submittedAmount: amount }), String(amount)).toBe('line-amount')
    expect(one({ ...base, taxCode: 'vat' })).toBe('line-tax-code')
    expect(one({ ...base, costCodeId: null })).toBe('line-cost-code')
    expect(one({ ...base, costCodeId: '' })).toBe('line-cost-code')
    expect(one({ ...base, poLineIndex: 0, costCodeId: null })).toBeNull()
    expect(one({ ...base, poLineIndex: 0 })).toBe('line-po-index')               // an index AND a cost code
    expect(one({ ...base, poLineIndex: -1, costCodeId: null })).toBe('line-po-index')
    expect(one({ ...base, poLineIndex: 1.5, costCodeId: null })).toBe('line-po-index')
    expect(one({ ...base, description: 'x'.repeat(2001) })).toBe('line-description')
    // A PO line index without a purchase order.
    expect(createVariationRequestProblem(request({ lines: [{ ...base, poLineIndex: 0, costCodeId: null }] }))).toBe('line-po-index')
  })

  it('createVariationRequest drops everything derived from the editor’s built lines', () => {
    const built = buildVariationLineItem({ poLineIndex: '', costCodeId: 'cc2', description: ' Extra ', submittedAmount: '40.15', taxCode: 'gst' }, { costCodes: [{ id: 'cc2', code: '05-100', name: 'Steel' }], calcVersion: 2 })
    const out = createVariationRequest({ projectId: 'p1', variationId: 'v', variationType: 'supplier', title: ' T ', supplierId: 's1', supplierName: ' S ', supplierRef: '', lineItems: [built], originRfi: RFI })
    expect(Object.keys(out).sort()).toEqual([...CREATE_VARIATION_KEYS].sort())
    expect(out.lines).toEqual([{ poLineIndex: null, costCodeId: 'cc2', description: 'Extra', submittedAmount: 40.15, taxCode: 'gst' }])
    expect(out).toMatchObject({ title: 'T', supplierName: 'S', originRfiId: 'rfi1', poId: null })
    expect(createVariationRequestProblem(out)).toBeNull()
    expect(requestedCostCodeIds(out)).toEqual(['cc2'])
  })

  it('the roles and the approvable statuses', () => {
    expect(VARIATION_PROCESSING_ROLES).toEqual(['company_admin', 'project_manager', 'qs'])
    expect(APPROVABLE_STATUSES).toEqual(['submitted', 'under_review'])
  })
})

describe('buildVariationDraft — everything derived, under calculation version 2', () => {
  it('a manual-mode supplier variation: number from the counter, currency from the project, names from the library, exact figures', () => {
    // 1,000.00 GST → 100.00;  40.15 GST → 4.02 (half up);  500.00 GST-free → 0
    // subtotal 1,540.15 · GST 104.02 · total 1,644.17
    const out = build(request({
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: 'Extra steel', submittedAmount: 1000, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc3', description: 'Permit', submittedAmount: 500, taxCode: 'gst_free' },
      ],
    }))
    expect(out.ok).toBe(true)
    const d = out.document
    expect(d).toMatchObject({
      variationNumber: 'SV-0012', variationType: 'supplier', status: 'draft', currency: 'NZD', calcVersion: 2, revision: 1,
      supplierId: 'contactS1', supplierName: 'Steel Co', supplierRef: 'Q-9', clientId: null, clientName: null, clientRef: null, poId: null, poNumber: null,
      originRfiId: null, originRfiNumber: null, originRfiTitle: null,
      submittedSubtotal: 1540.15, submittedGst: 104.02, submittedTotal: 1644.17,
      approvedSubtotal: null, approvedGst: null, approvedTotal: null, forecastAmount: null,
      approvedDate: '', assessmentNotes: '', attachments: [], externalRefs: {}, supersededByVariationId: null,
      createdBy: 'u_qs', updatedBy: 'u_qs', createdAt: NOW, updatedAt: NOW,
      submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, withdrawnAt: null, withdrawnBy: null,
    })
    expect(d.lineItems).toEqual([
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Extra steel', submittedAmount: 1000, submittedGst: 100, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
      { costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Bolts', submittedAmount: 40.15, submittedGst: 4.02, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
      { costCodeId: 'cc3', costCodeName: '01-000 — Preliminaries', description: 'Permit', submittedAmount: 500, submittedGst: 0, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst_free' },
    ])
    // No commitment key is born on a draft.
    for (const k of ['commitmentAppliedAt', 'commitmentAppliedBy', 'scopeCommittedAt', 'scopeCommittedBy']) expect(k in d).toBe(false)
    expect(submittedSideProblem(d)).toBeNull()
  })

  it('a client variation is numbered CV and carries no supplier block', () => {
    const out = build(request({ variationType: 'client', clientId: 'c1', clientName: 'Client Pty', clientRef: 'CR-1', supplierId: null, supplierName: null, supplierRef: null }), { number: 3 })
    expect(out.document).toMatchObject({ variationNumber: 'CV-0003', clientId: 'c1', clientName: 'Client Pty', clientRef: 'CR-1', supplierId: null, supplierName: null, supplierRef: null, poId: null })
  })

  it('PO-linked: the supplier and the number come FROM the purchase order; a PO line inherits that line’s cost code', () => {
    const input = request({
      poId: 'po1', supplierId: null, supplierName: null,
      lines: [
        { poLineIndex: 1, costCodeId: null, description: 'Blockwork', submittedAmount: 250, taxCode: 'gst' },
        { poLineIndex: null, costCodeId: 'cc3', description: 'New scope', submittedAmount: 75, taxCode: 'gst' },
      ],
    })
    const out = build(input, { po: PO })
    expect(out.document).toMatchObject({ poId: 'po1', poNumber: 'PO-0001', supplierName: 'Steel Co', supplierId: 'contactS1' })
    expect(out.document.lineItems.map(l => [l.poLineIndex, l.costCodeId, l.costCodeName])).toEqual([[1, 'cc4', '04-200 — Masonry'], [null, 'cc3', '01-000 — Preliminaries']])
    // A pre-Contacts purchase order with no supplierId key stores null.
    const legacyPo = { ...PO }
    delete legacyPo.supplierId
    expect(build(input, { po: legacyPo }).document.supplierId).toBeNull()
  })

  it('a purchase order that is missing, another id, or not sent / closed refuses; a closed one is accepted', () => {
    const input = request({ poId: 'po1', supplierId: null, supplierName: null })
    expect(build(input, { po: null })).toMatchObject({ ok: false, problem: CREATE_PROBLEM.PO_INVALID })
    for (const status of ['draft', 'pending_approval', 'cancelled']) expect(build(input, { po: { ...PO, status } }).problem, status).toBe(CREATE_PROBLEM.PO_INVALID)
    expect(build(input, { po: { ...PO, id: 'other' } }).problem).toBe(CREATE_PROBLEM.PO_INVALID)
    expect(build(input, { po: { ...PO, status: 'closed' } }).ok).toBe(true)
  })

  it('a PO line index that names no line, a PO line without a cost code, and an unknown cost code refuse', () => {
    const linked = (lines) => request({ poId: 'po1', supplierId: null, supplierName: null, lines })
    expect(build(linked([{ poLineIndex: 2, costCodeId: null, description: '', submittedAmount: 1, taxCode: 'gst' }]), { po: PO }).problem).toBe(CREATE_PROBLEM.PO_LINE_INVALID)
    expect(build(linked([{ poLineIndex: 0, costCodeId: null, description: '', submittedAmount: 1, taxCode: 'gst' }]), { po: { ...PO, lineItems: [{ costCodeId: '' }] } }).problem).toBe(CREATE_PROBLEM.PO_LINE_INVALID)
    expect(build(request({ lines: [{ poLineIndex: null, costCodeId: 'ghost', description: '', submittedAmount: 1, taxCode: 'gst' }] })).problem).toBe(CREATE_PROBLEM.COST_CODE_INVALID)
  })

  it('the originating RFI: the number and title are the RFI’s own; a draft, cancelled, missing or different RFI refuses', () => {
    const input = request({ originRfiId: 'rfi1' })
    expect(build(input, { rfi: RFI }).document).toMatchObject({ originRfiId: 'rfi1', originRfiNumber: 'RFI-0012', originRfiTitle: 'Revised connection' })
    for (const rfi of [null, { ...RFI, status: 'draft' }, { ...RFI, status: 'cancelled' }, { ...RFI, id: 'other' }, { ...RFI, title: '' }]) {
      expect(build(input, { rfi }).problem).toBe(CREATE_PROBLEM.RFI_INVALID)
    }
    for (const status of ['open', 'answered', 'closed']) expect(build(input, { rfi: { ...RFI, status } }).ok, status).toBe(true)
  })

  it('SIGNED and mixed-tax lines against the independent oracle — every half-cent boundary from 0.05 to 50.05, both signs', () => {
    for (let k = 0; k <= 5000; k += 1) {
      const cents = k * 10 + 5
      for (const signed of [cents, -cents]) {
        const out = build(request({
          lines: [
            { poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: signed / 100, taxCode: 'gst' },
            { poLineIndex: null, costCodeId: 'cc3', description: '', submittedAmount: -signed / 100, taxCode: 'gst_free' },
            { poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: 12.34, taxCode: 'input_taxed' },
          ],
        }))
        const d = out.document
        const wantGst = gstCents(signed)
        if (c(d.lineItems[0].submittedGst) !== wantGst || d.lineItems[1].submittedGst !== 0 || d.lineItems[2].submittedGst !== 0
          || c(d.submittedSubtotal) !== 1234 || c(d.submittedGst) !== wantGst || c(d.submittedTotal) !== 1234 + wantGst) {
          throw new Error(`wrong figures at ${signed} cents`)
        }
      }
    }
  })

  it('an entered amount with more than two decimals is rounded half AWAY from zero before anything is derived', () => {
    const out = build(request({
      lines: [
        { poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: 4.015, taxCode: 'gst' },    // → 4.02, GST 0.40
        { poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: -4.015, taxCode: 'gst' },   // → -4.02, GST -0.40
      ],
    }))
    expect(out.document.lineItems.map(l => [l.submittedAmount, l.submittedGst])).toEqual([[4.02, 0.4], [-4.02, -0.4]])
    expect([out.document.submittedSubtotal, out.document.submittedGst, out.document.submittedTotal]).toEqual([0, 0, 0])
  })
})

describe('a variation is recalculated under ITS OWN version', () => {
  const lines = (gstA, gstB) => [
    { costCodeId: 'cc2', costCodeName: 'x', description: '', submittedAmount: 40.15, submittedGst: gstA, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
    { costCodeId: 'cc2', costCodeName: 'x', description: '', submittedAmount: -40.15, submittedGst: gstB, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
  ]
  const legacy = { id: 'v', variationType: 'supplier', status: 'submitted', revision: 2, poId: null, approvedDate: '', effectiveDate: '', lineItems: lines(4.01, -4.01) }
  const exact = { ...legacy, calcVersion: 2, lineItems: lines(4.02, -4.02) }

  it('LEGACY approval keeps the legacy figures (40.15 → 4.01, -40.15 → -4.01); version 2 certifies exactly (4.02 / -4.02)', () => {
    const run = (live) => transitionUpdate(live, 'approved', { approvedAmounts: [40.15, -40.15], assessmentNotes: '' }, 'u', NOW, '2026-11-27')
    expect(run(legacy).lineItems.map(l => l.approvedGst)).toEqual([4.01, -4.01])
    expect(run(exact).lineItems.map(l => l.approvedGst)).toEqual([4.02, -4.02])
    // Certifying one line only shows the difference in the header.
    const one = (live) => transitionUpdate(live, 'approved', { approvedAmounts: [40.15, 0], assessmentNotes: 'second line not agreed' }, 'u', NOW, '2026-11-27')
    expect([one(legacy).approvedSubtotal, one(legacy).approvedGst, one(legacy).approvedTotal]).toEqual([40.15, 4.01, 44.16])
    expect([one(exact).approvedSubtotal, one(exact).approvedGst, one(exact).approvedTotal]).toEqual([40.15, 4.02, 44.17])
  })

  it('an UNKNOWN version is refused by the approval and by both verifications — never calculated under a guess', () => {
    const unknown = { ...exact, calcVersion: 3 }
    expect(variationCalcVersion(unknown)).toBeNull()
    expect(() => transitionUpdate(unknown, 'approved', { approvedAmounts: [1, 1], assessmentNotes: 'x' }, 'u', NOW, '2026-11-27')).toThrow(VariationWriteError)
    expect(submittedSideProblem(unknown)).toBe('version')
    expect(approvedSideProblem(unknown)).toBe('version')
  })

  it('the preview helpers take the version and default to legacy', () => {
    expect(gstForLine(40.15, TAX_CODE.GST)).toBe(4.01)
    expect(gstForLine(40.15, TAX_CODE.GST, 1)).toBe(4.01)
    expect(gstForLine(40.15, TAX_CODE.GST, 2)).toBe(4.02)
    expect(gstForLine(-40.15, TAX_CODE.GST, 2)).toBe(-4.02)
    expect(gstForLine(40.15, TAX_CODE.GST_FREE, 2)).toBe(0)
    expect(buildApprovedLineItems(legacy.lineItems, [40.15, 0])[0].approvedGst).toBe(4.01)
    expect(buildApprovedLineItems(exact.lineItems, [40.15, 0], 2)[0].approvedGst).toBe(4.02)
    expect(variationTotals(exact.lineItems, 'submitted', 2)).toEqual({ subtotal: 0, gst: 0, total: 0 })
  })
})

describe('verification — the submitted side of a version-2 variation must be its own derivation', () => {
  const good = () => build(request({
    lines: [
      { poLineIndex: null, costCodeId: 'cc2', description: '', submittedAmount: 40.15, taxCode: 'gst' },
      { poLineIndex: null, costCodeId: 'cc3', description: '', submittedAmount: -10, taxCode: 'gst_free' },
    ],
  })).document
  const withLine = (index, over) => { const d = good(); d.lineItems[index] = { ...d.lineItems[index], ...over }; return d }

  it('the backend’s own document reconciles', () => {
    expect(submittedSideProblem(good())).toBeNull()
  })
  it('a forged line GST, a third-decimal amount, a bad tax code, a missing cost code, a bad index and a certified value on a draft line are each found', () => {
    expect(submittedSideProblem(withLine(0, { submittedGst: 4.01 }))).toBe('line-gst')        // the legacy figure on a version-2 line
    expect(submittedSideProblem(withLine(0, { submittedGst: 0 }))).toBe('line-gst')
    expect(submittedSideProblem(withLine(1, { submittedGst: -1 }))).toBe('line-gst')          // GST on a GST-free line
    expect(submittedSideProblem(withLine(0, { submittedAmount: 40.155 }))).toBe('line-amount')
    expect(submittedSideProblem(withLine(0, { submittedAmount: '40.15' }))).toBe('line-amount')
    expect(submittedSideProblem(withLine(0, { taxCode: 'vat' }))).toBe('line-tax-code')
    expect(submittedSideProblem(withLine(0, { costCodeId: '' }))).toBe('line-cost-code')
    expect(submittedSideProblem(withLine(0, { poLineIndex: -1 }))).toBe('line-po-index')
    expect(submittedSideProblem(withLine(0, { approvedAmount: 5 }))).toBe('line-approved')
  })
  it('a header that is not the sum of the lines is found — on each of the three figures', () => {
    expect(submittedSideProblem({ ...good(), submittedSubtotal: 30.16 })).toBe('header')
    expect(submittedSideProblem({ ...good(), submittedGst: 4.01 })).toBe('header')
    expect(submittedSideProblem({ ...good(), submittedTotal: 34.18 })).toBe('header')
  })
  it('no lines, junk lines and more than 200 lines are found', () => {
    expect(submittedSideProblem({ ...good(), lineItems: [] })).toBe('lines')
    expect(submittedSideProblem({ ...good(), lineItems: 'x' })).toBe('lines')
    expect(submittedSideProblem({ ...good(), lineItems: [null] })).toBe('line')
  })
})

describe('approval requests and evidence', () => {
  it('approved amounts: one finite, in-range number per line (1–200)', () => {
    expect(approvedAmountsProblem([0])).toBeNull()
    expect(approvedAmountsProblem([-5.5, 1000000])).toBeNull()
    expect(approvedAmountsProblem([])).toBe('count')
    expect(approvedAmountsProblem('1')).toBe('count')
    expect(approvedAmountsProblem(Array(201).fill(1))).toBe('count')
    for (const bad of ['1', null, NaN, Infinity, 1e15]) expect(approvedAmountsProblem([bad]), String(bad)).toBe('amount')
  })

  it('sameApproval recognises a repeat of the same certified amounts, under the document’s version, and nothing else', () => {
    const approved = { calcVersion: 2, lineItems: [{ approvedAmount: 40.15 }, { approvedAmount: -4.02 }] }
    expect(sameApproval(approved, [40.15, -4.02])).toBe(true)
    expect(sameApproval(approved, [40.15, -4.015])).toBe(true)     // rounds to the stored -4.02 under version 2
    expect(sameApproval(approved, [40.15, -4.01])).toBe(false)
    expect(sameApproval(approved, [40.15])).toBe(false)
    expect(sameApproval({ ...approved, calcVersion: 9 }, [40.15, -4.02])).toBe(false)
    expect(sameApproval({ lineItems: [{ approvedAmount: null }] }, [0])).toBe(false)   // never approved
  })

  it('the approved header must be inside the supported range', () => {
    expect(approvedHeaderSupported({ approvedSubtotal: 1, approvedGst: 0.1, approvedTotal: 1.1 })).toBe(true)
    expect(approvedHeaderSupported({ approvedSubtotal: 1e15, approvedGst: 0, approvedTotal: 1e15 })).toBe(false)
    expect(approvedHeaderSupported({ approvedSubtotal: null, approvedGst: 0, approvedTotal: 0 })).toBe(false)
  })

  it('actor evidence names the approver’s relation to the document without refusing anything', () => {
    const v = { createdBy: 'a', submittedBy: 'b', updatedBy: 'b' }
    expect(approvalActorEvidence(v, 'a')).toEqual({ approverIsCreator: true, approverIsSubmitter: false, approverIsLastEditor: false })
    expect(approvalActorEvidence(v, 'b')).toEqual({ approverIsCreator: false, approverIsSubmitter: true, approverIsLastEditor: true })
    expect(approvalActorEvidence(v, 'c')).toEqual({ approverIsCreator: false, approverIsSubmitter: false, approverIsLastEditor: false })
  })
})

// ── Stored content is never trusted when it is about to become authoritative ─

const storedLine = (o = {}) => ({
  costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Bolts',
  submittedAmount: 40.15, submittedGst: 4.01, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst', ...o,
})
// A LEGACY variation exactly as the application stored one before ADR-90/91.
const legacyStored = (o = {}) => ({
  id: 'v', variationType: 'supplier', status: 'submitted', revision: 2, poId: null, poNumber: null,
  lineItems: [storedLine(), storedLine({ description: 'Permit', costCodeId: 'cc3', costCodeName: '01-000 — Preliminaries', submittedAmount: 500, submittedGst: 0, taxCode: 'gst_free' })],
  submittedSubtotal: 540.15, submittedGst: 4.01, submittedTotal: 544.16,
  approvedSubtotal: null, approvedGst: null, approvedTotal: null,
  ...o,
})
const legacyWith = (index, over, header = {}) => { const v = legacyStored(); v.lineItems[index] = { ...v.lineItems[index], ...over }; return { ...v, ...header } }

describe('verification — a LEGACY variation is verified under the LEGACY policy; legitimacy is not assumed', () => {
  it('a legitimate legacy variation reconciles: 40.15 carries GST 4.01 and the header is the legacy sum', () => {
    expect(variationCalcVersion(legacyStored())).toBe(1)
    expect(submittedSideProblem(legacyStored())).toBeNull()
    // Signed and zero lines reconcile too.
    expect(submittedSideProblem(legacyStored({
      lineItems: [storedLine({ submittedAmount: -40.15, submittedGst: -4.01 }), storedLine({ submittedAmount: 0, submittedGst: 0 })],
      submittedSubtotal: -40.15, submittedGst: -4.01, submittedTotal: -44.16,
    }))).toBeNull()
  })

  it('the legacy editor derived GST from the amount AS ENTERED: both values it could have stored are accepted, and nothing else', () => {
    // Stored amount 10.05. Entered 10.05 → GST 1.00 (legacy: 1.005 → 1.00) or
    // 1.01; entered 10.054 → 1.01. One cent beyond either is not producible.
    const gstOf = (g) => submittedSideProblem(legacyStored({
      lineItems: [storedLine({ submittedAmount: 10.05, submittedGst: g })], submittedSubtotal: 10.05, submittedGst: g, submittedTotal: Math.round((10.05 + g) * 100) / 100,
    }))
    const accepted = [0.99, 1.0, 1.01, 1.02].filter(g => gstOf(g) === null)
    expect(accepted.length).toBeGreaterThanOrEqual(1)
    expect(accepted.length).toBeLessThanOrEqual(2)
    expect(accepted).toContain(gstForLine(10.05, TAX_CODE.GST))
    expect(gstOf(0.5)).toBe('line-gst')
    expect(gstOf(2)).toBe('line-gst')
    expect(gstOf(0)).toBe('line-gst')
    // Off a boundary there is exactly one value.
    const plain = (g) => submittedSideProblem(legacyStored({ lineItems: [storedLine({ submittedAmount: 100, submittedGst: g })], submittedSubtotal: 100, submittedGst: g, submittedTotal: 100 + g }))
    expect(plain(10)).toBeNull()
    expect(plain(9.99)).toBe('line-gst')
    expect(plain(10.01)).toBe('line-gst')
  })

  it('FORGED LEGACY LINE AMOUNTS: a third decimal, a string, a non-number, an amount beyond the range', () => {
    for (const amount of [40.155, '40.15', null, NaN, 1e15]) expect(submittedSideProblem(legacyWith(0, { submittedAmount: amount })), String(amount)).toBe('line-amount')
  })

  it('FORGED LEGACY GST: a GST unrelated to the amount, GST on a GST-free line, no GST on a taxable line', () => {
    expect(submittedSideProblem(legacyWith(0, { submittedGst: 0.4 }, { submittedGst: 0.4, submittedTotal: 540.55 }))).toBe('line-gst')
    expect(submittedSideProblem(legacyWith(0, { submittedGst: 40.15 }, { submittedGst: 40.15, submittedTotal: 580.3 }))).toBe('line-gst')
    expect(submittedSideProblem(legacyWith(1, { submittedGst: 50 }, { submittedGst: 54.01, submittedTotal: 594.16 }))).toBe('line-gst')
    expect(submittedSideProblem(legacyWith(0, { submittedGst: 0 }, { submittedGst: 0, submittedTotal: 540.15 }))).toBe('line-gst')
    expect(submittedSideProblem(legacyWith(0, { submittedGst: '4.01' }))).toBe('line-gst')
  })

  it('FORGED TOTALS: a header that is internally consistent (subtotal + gst == total — all the Rules ever checked) but is not the sum of the lines', () => {
    expect(submittedSideProblem(legacyStored({ submittedSubtotal: 5000, submittedGst: 500, submittedTotal: 5500 }))).toBe('header')
    expect(submittedSideProblem(legacyStored({ submittedSubtotal: 540.15, submittedGst: 4.02, submittedTotal: 544.17 }))).toBe('header')
    expect(submittedSideProblem(legacyStored({ submittedTotal: 544.17 }))).toBe('header')
    expect(submittedSideProblem(legacyStored({ submittedSubtotal: '540.15' }))).toBe('header')
  })

  it('FORGED LINE SHAPE: a junk element, an extra key, a missing key, a bad tax code, no cost code, a bad PO index, a certified value on an unapproved line', () => {
    expect(submittedSideProblem(legacyStored({ lineItems: ['junk'] }))).toBe('line')
    expect(submittedSideProblem(legacyWith(0, { hidden: 'payload' }))).toBe('line-keys')
    const missing = legacyStored(); delete missing.lineItems[0].taxCode
    expect(submittedSideProblem(missing)).toBe('line-keys')
    expect(submittedSideProblem(legacyWith(0, { taxCode: 'vat' }))).toBe('line-tax-code')
    expect(submittedSideProblem(legacyWith(0, { costCodeId: '' }))).toBe('line-cost-code')
    expect(submittedSideProblem(legacyWith(0, { costCodeName: 7 }))).toBe('line-text')
    expect(submittedSideProblem(legacyWith(0, { poLineIndex: '0' }))).toBe('line-po-index')
    expect(submittedSideProblem(legacyWith(0, { approvedAmount: 40.15, approvedGst: 4.01 }))).toBe('line-approved')
    expect(VARIATION_LINE_KEYS).toHaveLength(9)
  })

  it('MIXED LEGACY AND EXACT INPUTS: an exact-only GST figure on a legacy line off the producible set, and a legacy figure on a version-2 line, are both refused', () => {
    // 100.05: legacy and exact both give 10.01 → fine either way.
    // 0.05 on a version-2 document must be 0.01; the legacy 0.00 or 0.01 set applies only to legacy documents.
    const v2 = (g) => submittedSideProblem({ ...legacyStored({ lineItems: [storedLine({ submittedAmount: 40.15, submittedGst: g })], submittedSubtotal: 40.15, submittedGst: g, submittedTotal: Math.round((40.15 + g) * 100) / 100 }), calcVersion: 2 })
    expect(v2(4.02)).toBeNull()
    expect(v2(4.01)).toBe('line-gst')
    const v1 = (g) => submittedSideProblem(legacyStored({ lineItems: [storedLine({ submittedAmount: 40.15, submittedGst: g })], submittedSubtotal: 40.15, submittedGst: g, submittedTotal: Math.round((40.15 + g) * 100) / 100 }))
    expect(v1(4.01)).toBeNull()
    expect(v1(4.03)).toBe('line-gst')
    expect(v1(4.0)).toBe('line-gst')
  })
})

describe('verification — every line’s cost code is the purchase-order line’s own, or exists in the company library', () => {
  const linkedVariation = (lines) => ({ id: 'v', variationType: 'supplier', poId: 'po1', lineItems: lines })

  it('new-scope lines: a real cost code passes and yields the authoritative name; an unknown one is refused, naming the line', () => {
    const v = legacyStored()
    expect(storedCostCodeIds(v)).toEqual(['cc2', 'cc3'])
    expect(lineSources(v, { costCodes: CODES })).toEqual({ ok: true, names: ['05-100 — Structural steel', '01-000 — Preliminaries'] })
    expect(lineSources(legacyWith(1, { costCodeId: 'ghost' }), { costCodes: CODES })).toEqual({ ok: false, line: 1, reason: 'cost-code-missing' })
    expect(lineSources(v, { costCodes: new Map() })).toMatchObject({ ok: false, line: 0 })
  })

  it('FORGED COST-CODE RELATIONSHIPS on a PO line: a cost code that is not the order line’s, an index naming no line, an order line with no cost code', () => {
    const good = linkedVariation([storedLine({ poLineIndex: 0, costCodeId: 'cc1' }), storedLine({ poLineIndex: 1, costCodeId: 'cc4' })])
    expect(lineSources(good, { po: PO, costCodes: CODES })).toEqual({ ok: true, names: ['03-100 — Concrete', '04-200 — Masonry'] })
    expect(lineSources(linkedVariation([storedLine({ poLineIndex: 0, costCodeId: 'cc2' })]), { po: PO, costCodes: CODES })).toEqual({ ok: false, line: 0, reason: 'po-line-cost-code' })
    expect(lineSources(linkedVariation([storedLine({ poLineIndex: 9, costCodeId: 'cc1' })]), { po: PO, costCodes: CODES })).toEqual({ ok: false, line: 0, reason: 'po-line-missing' })
    expect(lineSources(linkedVariation([storedLine({ poLineIndex: 0, costCodeId: 'cc1' })]), { po: { ...PO, lineItems: [{ costCodeId: '' }] }, costCodes: CODES }).reason).toBe('po-line-missing')
    // storedCostCodeIds names new-scope lines only — a PO line's code is read from the order.
    expect(storedCostCodeIds(good)).toEqual([])
  })

  it('a PO-line index on a variation with NO order, on a client variation, or against a different order is refused', () => {
    const line = storedLine({ poLineIndex: 0, costCodeId: 'cc1' })
    expect(lineSources({ id: 'v', variationType: 'supplier', poId: null, lineItems: [line] }, { po: PO, costCodes: CODES }).reason).toBe('po-line-without-order')
    expect(lineSources({ id: 'v', variationType: 'client', poId: 'po1', lineItems: [line] }, { po: PO, costCodes: CODES }).reason).toBe('po-line-without-order')
    expect(lineSources(linkedVariation([line]), { po: { ...PO, id: 'other' }, costCodes: CODES }).reason).toBe('po-line-without-order')
    expect(lineSources(linkedVariation([line]), { po: null, costCodes: CODES }).reason).toBe('po-line-without-order')
  })

  it('a forged cost-code NAME is replaced by the authoritative one at certification; nothing else on the line moves', () => {
    const lines = [storedLine({ costCodeName: 'Totally different name' }), storedLine({ costCodeId: 'cc3', costCodeName: '' })]
    const out = withAuthoritativeNames(lines, ['05-100 — Structural steel', '01-000 — Preliminaries'])
    expect(out.map(l => l.costCodeName)).toEqual(['05-100 — Structural steel', '01-000 — Preliminaries'])
    expect(out.map(l => ({ ...l, costCodeName: null }))).toEqual(lines.map(l => ({ ...l, costCodeName: null })))
    expect(lines[0].costCodeName).toBe('Totally different name')   // input not mutated
  })
})

describe('verification — the approved side, before it becomes commitment', () => {
  const approvedLegacy = (o = {}) => legacyStored({
    status: 'approved',
    lineItems: [storedLine({ approvedAmount: 40.15, approvedGst: 4.01 }), storedLine({ costCodeId: 'cc3', submittedAmount: 500, submittedGst: 0, taxCode: 'gst_free', approvedAmount: 450, approvedGst: 0 })],
    approvedSubtotal: 490.15, approvedGst: 4.01, approvedTotal: 494.16,
    ...o,
  })

  it('an EXISTING APPROVED LEGACY variation — a historical fact — reconciles under the legacy policy and is not changed by being checked', () => {
    const v = approvedLegacy()
    const before = JSON.stringify(v)
    expect(approvedSideProblem(v)).toBeNull()
    expect(JSON.stringify(v)).toBe(before)
  })

  it('the approved GST is EXACT under the document’s own version — legacy 4.01 on a legacy document, 4.02 on a version-2 document — never either', () => {
    expect(approvedSideProblem(approvedLegacy({ calcVersion: 2 }))).toBe('line-gst')
    const exact = approvedLegacy({ calcVersion: 2, approvedGst: 4.02, approvedTotal: 494.17 })
    exact.lineItems[0] = { ...exact.lineItems[0], approvedGst: 4.02 }
    expect(approvedSideProblem(exact)).toBeNull()
    const legacyWithExact = approvedLegacy({ approvedGst: 4.02, approvedTotal: 494.17 })
    legacyWithExact.lineItems[0] = { ...legacyWithExact.lineItems[0], approvedGst: 4.02 }
    expect(approvedSideProblem(legacyWithExact)).toBe('line-gst')
  })

  it('a forged approved amount, GST or header, and a line that was never certified, are found', () => {
    const withApproved = (index, over, header = {}) => { const v = approvedLegacy(); v.lineItems[index] = { ...v.lineItems[index], ...over }; return { ...v, ...header } }
    expect(approvedSideProblem(withApproved(0, { approvedAmount: null }))).toBe('line-amount')
    expect(approvedSideProblem(withApproved(0, { approvedAmount: 40.155 }))).toBe('line-amount')
    expect(approvedSideProblem(withApproved(0, { approvedGst: 0 }))).toBe('line-gst')
    expect(approvedSideProblem(withApproved(1, { approvedGst: 45 }))).toBe('line-gst')
    expect(approvedSideProblem(approvedLegacy({ approvedSubtotal: 49015 }))).toBe('header')
    expect(approvedSideProblem(approvedLegacy({ approvedTotal: 494.17 }))).toBe('header')
    expect(approvedSideProblem(withApproved(0, { smuggled: true }))).toBe('line-keys')
  })
})

describe('editing a draft — replaced in full, derived by the server, stored under the current version', () => {
  const liveDraft = (o = {}) => legacyStored({ status: 'draft', revision: 1, title: 'Old', description: '', reason: '', supplierRef: 'Q-1', clientRef: null, identifiedDate: '', responseDueDate: '', effectiveDate: '', notes: 'kept', originRfiId: 'rfiOld', originRfiNumber: 'RFI-0001', originRfiTitle: 'Old question', ...o })
  const editRequest = (o = {}) => ({
    projectId: 'p1', variationId: 'v', expectedRevision: 1,
    title: 'New title', description: 'd', reason: 'site_condition', clientRef: null, supplierRef: 'Q-2',
    identifiedDate: '2026-11-01', responseDueDate: '', effectiveDate: '', notes: null, changeOriginRfi: false, originRfiId: null,
    lines: [{ poLineIndex: null, costCodeId: 'cc2', description: 'Bolts', submittedAmount: 40.15, taxCode: 'gst' }],
    ...o,
  })
  const run = (input, o = {}) => buildVariationDraftUpdate({ input, live: liveDraft(), costCodes: CODES, uid: 'u_qs', now: NOW, ...o })

  it('the request: exact keys, one reference side, an explicit RFI change, authored lines only', () => {
    expect(updateVariationRequestProblem(editRequest())).toBeNull()
    for (const extra of ['submittedGst', 'submittedTotal', 'status', 'calcVersion', 'variationNumber', 'poId', 'supplierName', 'companyId', 'revision']) {
      expect(updateVariationRequestProblem({ ...editRequest(), [extra]: 1 }), extra).toBe('keys')
    }
    expect(updateVariationRequestProblem(editRequest({ clientRef: 'x' }))).toBe('refs')            // both sides
    expect(updateVariationRequestProblem(editRequest({ supplierRef: null }))).toBe('refs')        // neither side
    expect(updateVariationRequestProblem(editRequest({ expectedRevision: -1 }))).toBe('expectedRevision')
    expect(updateVariationRequestProblem(editRequest({ changeOriginRfi: 'yes' }))).toBe('changeOriginRfi')
    expect(updateVariationRequestProblem(editRequest({ originRfiId: 'rfi1' }))).toBe('originRfiId')   // an id without the change flag
    expect(updateVariationRequestProblem(editRequest({ changeOriginRfi: true, originRfiId: 'rfi1' }))).toBeNull()
    expect(updateVariationRequestProblem(editRequest({ notes: 'x'.repeat(5001) }))).toBe('notes')
    expect(updateVariationRequestProblem(editRequest({ lines: [{ ...editRequest().lines[0], submittedGst: 1 }] }))).toBe('line-keys')
    expect(updateVariationRequestProblem(editRequest({ lines: [] }))).toBe('lines')
    expect(UPDATE_VARIATION_KEYS).not.toContain('variationType')
    const built = updateVariationRequest({ projectId: 'p1', seen: { id: 'v', revision: 4, variationType: 'supplier' }, data: { title: ' T ', supplierRef: ' S ', lineItems: [storedLine()] } })
    expect(updateVariationRequestProblem(built)).toBeNull()
    expect(built).toMatchObject({ expectedRevision: 4, title: 'T', supplierRef: 'S', clientRef: null, notes: null, changeOriginRfi: false })
  })

  it('A LEGACY DRAFT, ONCE EDITED, IS VERSION 2: every line re-derived exactly (40.15 → 4.02), the header the integer sum, revision + 1', () => {
    const out = run(editRequest())
    expect(out.ok).toBe(true)
    expect(out.update).toEqual({
      title: 'New title', description: 'd', reason: 'site_condition', clientRef: null, supplierRef: 'Q-2',
      identifiedDate: '2026-11-01', responseDueDate: '', effectiveDate: '',
      lineItems: [{ costCodeId: 'cc2', costCodeName: '05-100 — Structural steel', description: 'Bolts', submittedAmount: 40.15, submittedGst: 4.02, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' }],
      submittedSubtotal: 40.15, submittedGst: 4.02, submittedTotal: 44.17,
      calcVersion: 2, revision: 2, updatedAt: NOW, updatedBy: 'u_qs',
    })
    // What the edit wrote is exactly what approval will verify.
    expect(submittedSideProblem({ ...liveDraft(), ...out.update })).toBeNull()
  })

  it('never writes the type, the counterparty, the PO link, the number, the currency, the status or a lifecycle stamp; notes and the RFI link only when asked', () => {
    const keys = Object.keys(run(editRequest()).update)
    for (const never of ['variationType', 'variationNumber', 'supplierId', 'supplierName', 'clientId', 'clientName', 'poId', 'poNumber', 'currency', 'status', 'createdBy', 'createdAt', 'submittedAt', 'approvedAt', 'commitmentAppliedAt', 'scopeCommittedAt', 'notes', 'originRfiId']) {
      expect(keys, never).not.toContain(never)
    }
    expect(run(editRequest({ notes: 'new note' })).update.notes).toBe('new note')
    expect(run(editRequest({ changeOriginRfi: true, originRfiId: null })).update).toMatchObject({ originRfiId: null, originRfiNumber: null, originRfiTitle: null })
    expect(run(editRequest({ changeOriginRfi: true, originRfiId: 'rfi1' }), { rfi: RFI }).update).toMatchObject({ originRfiId: 'rfi1', originRfiNumber: 'RFI-0012', originRfiTitle: 'Revised connection' })
    for (const rfi of [null, { ...RFI, status: 'draft' }, { ...RFI, status: 'cancelled' }, { ...RFI, id: 'other' }]) {
      expect(run(editRequest({ changeOriginRfi: true, originRfiId: 'rfi1' }), { rfi }).problem).toBe(DRAFT_PROBLEM.RFI_INVALID)
    }
  })

  it('the external reference must be on the variation’s OWN side', () => {
    expect(run(editRequest({ clientRef: 'CR', supplierRef: null })).problem).toBe(DRAFT_PROBLEM.REFS_INVALID)
    const client = liveDraft({ variationType: 'client' })
    expect(buildVariationDraftUpdate({ input: editRequest({ clientRef: 'CR', supplierRef: null }), live: client, costCodes: CODES, uid: 'u', now: NOW }).update).toMatchObject({ clientRef: 'CR', supplierRef: null })
    expect(buildVariationDraftUpdate({ input: editRequest(), live: client, costCodes: CODES, uid: 'u', now: NOW }).problem).toBe(DRAFT_PROBLEM.REFS_INVALID)
  })

  it('lines: a PO line only on a PO-linked variation and only a line of ITS order (whose cost code it inherits); an unknown cost code is refused; the order’s status is not re-checked', () => {
    const poLine = { poLineIndex: 1, costCodeId: null, description: 'Blockwork', submittedAmount: -250, taxCode: 'gst' }
    expect(run(editRequest({ lines: [poLine] }), { po: PO }).problem).toBe(DRAFT_PROBLEM.PO_LINE_INVALID)     // the draft names no order
    const linked = liveDraft({ poId: 'po1', poNumber: 'PO-0001' })
    const ok = buildVariationDraftUpdate({ input: editRequest({ lines: [poLine] }), live: linked, po: { ...PO, status: 'cancelled' }, costCodes: CODES, uid: 'u', now: NOW })
    expect(ok.update.lineItems[0]).toMatchObject({ poLineIndex: 1, costCodeId: 'cc4', costCodeName: '04-200 — Masonry', submittedAmount: -250, submittedGst: -25 })
    expect(buildVariationDraftUpdate({ input: editRequest({ lines: [{ ...poLine, poLineIndex: 5 }] }), live: linked, po: PO, costCodes: CODES, uid: 'u', now: NOW }).problem).toBe(DRAFT_PROBLEM.PO_LINE_INVALID)
    expect(buildVariationDraftUpdate({ input: editRequest({ lines: [poLine] }), live: linked, po: null, costCodes: CODES, uid: 'u', now: NOW }).problem).toBe(DRAFT_PROBLEM.PO_LINE_INVALID)
    expect(buildVariationDraftUpdate({ input: editRequest({ lines: [poLine] }), live: linked, po: { ...PO, id: 'other' }, costCodes: CODES, uid: 'u', now: NOW }).problem).toBe(DRAFT_PROBLEM.PO_LINE_INVALID)
    expect(run(editRequest({ lines: [{ poLineIndex: null, costCodeId: 'ghost', description: '', submittedAmount: 1, taxCode: 'gst' }] })).problem).toBe(DRAFT_PROBLEM.COST_CODE_INVALID)
  })

  it('a legacy draft with no revision is edited to revision 1; a repeat of the same edit is recognised, a different one is not', () => {
    const noRevision = liveDraft(); delete noRevision.revision
    const first = buildVariationDraftUpdate({ input: editRequest({ expectedRevision: 0 }), live: noRevision, costCodes: CODES, uid: 'u', now: NOW })
    expect(first.update.revision).toBe(1)
    const stored = { ...liveDraft(), ...run(editRequest()).update }
    expect(draftAlreadyHolds(stored, run(editRequest()).update)).toBe(true)
    expect(draftAlreadyHolds(stored, run(editRequest({ title: 'Another' })).update)).toBe(false)
    expect(draftAlreadyHolds(liveDraft(), run(editRequest()).update)).toBe(false)
  })
})
