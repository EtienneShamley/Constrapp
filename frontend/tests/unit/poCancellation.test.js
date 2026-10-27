import { describe, it, expect } from 'vitest'
import {
  PO_CANCEL_BLOCKER_KIND, poCancellationBlockers, poCancellationReason, poCancellationGuard,
} from '../../src/lib/poCancellation'
import { PO_STATUS } from '../../src/lib/purchaseOrders'
import { CLAIM_STATUS } from '../../src/lib/progressClaims'
import { SI_STATUS } from '../../src/lib/supplierInvoices'
import { VARIATION_STATUS, VARIATION_TYPE } from '../../src/lib/variations'

// ── PO cancellation safety — pure domain (ADR-57, M2-B1) ─────────────────────
//
// No emulator, no React. Pins the STRICT policy: a claim blocks unless
// rejected, an invoice blocks unless cancelled, drafts included; the guard
// fails CLOSED while either dependency is loading or failed; and nothing here
// mutates its inputs. The same functions run inside the guarded transaction
// against server copies (purchaseOrders.rules.test.js).

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

const po = (o = {}) => deepFreeze({ id: 'po1', poNumber: 'PO-0001', status: PO_STATUS.SENT, ...o })
const claim = (status, o = {}) => ({ id: `c-${status}`, claimNumber: `PC-${status}`, poId: 'po1', status, ...o })
const invoice = (status, o = {}) => ({ id: `i-${status}`, invoiceNumber: `SI-${status}`, poId: 'po1', status, ...o })
const variation = (status, o = {}) => ({ id: `v-${status}`, variationNumber: `SV-${status}`, variationType: VARIATION_TYPE.SUPPLIER, poId: 'po1', status, ...o })

const settled = (progressClaims = [], supplierInvoices = [], variations = []) => ({
  progressClaims, progressClaimsLoading: false, progressClaimsError: false,
  supplierInvoices, supplierInvoicesLoading: false, supplierInvoicesError: false,
  variations, variationsLoading: false, variationsError: false,
})

describe('poCancellationBlockers — the strict policy', () => {
  it('the three blocker kinds are the ones the hook builds linked refs for', () => {
    expect(PO_CANCEL_BLOCKER_KIND).toEqual({ CLAIM: 'claim', INVOICE: 'invoice', VARIATION: 'variation' })
  })

  it('every SUPPLIER variation status except rejected and withdrawn blocks (approved exposure, drafts and the reserved statuses alike)', () => {
    for (const s of Object.values(VARIATION_STATUS)) {
      const out = poCancellationBlockers('po1', { variations: [variation(s)] })
      if (s === VARIATION_STATUS.REJECTED || s === VARIATION_STATUS.WITHDRAWN) expect(out).toEqual([])
      else expect(out).toEqual([{ kind: 'variation', id: `v-${s}`, number: `SV-${s}`, status: s, statusLabel: expect.any(String) }])
    }
  })

  it('a client variation, a manual-mode supplier variation (poId null) and another PO’s variation never block', () => {
    expect(poCancellationBlockers('po1', { variations: [
      variation('approved', { variationType: VARIATION_TYPE.CLIENT }),
      variation('approved', { poId: null }),
      variation('approved', { poId: 'po2' }),
      variation('approved', { variationType: undefined }),
    ] })).toEqual([])
  })

  it('every claim status except rejected blocks', () => {
    for (const s of Object.values(CLAIM_STATUS)) {
      const out = poCancellationBlockers('po1', { progressClaims: [claim(s)] })
      if (s === CLAIM_STATUS.REJECTED) expect(out).toEqual([])
      else expect(out).toEqual([{ kind: 'claim', id: `c-${s}`, number: `PC-${s}`, status: s, statusLabel: expect.any(String) }])
    }
  })

  it('every invoice status except cancelled blocks — including the deprecated paid and the reserved statuses', () => {
    for (const s of Object.values(SI_STATUS)) {
      const out = poCancellationBlockers('po1', { supplierInvoices: [invoice(s)] })
      if (s === SI_STATUS.CANCELLED) expect(out).toEqual([])
      else expect(out).toEqual([{ kind: 'invoice', id: `i-${s}`, number: `SI-${s}`, status: s, statusLabel: expect.any(String) }])
    }
  })

  it('ignores records against another PO, with no poId, or malformed, and preserves order (claims first)', () => {
    const out = poCancellationBlockers('po1', {
      progressClaims: [claim('approved', { poId: 'po2' }), claim('draft'), { status: 'approved' }, null],
      supplierInvoices: [invoice('posted', { poId: 'other' }), invoice('draft'), undefined],
    })
    expect(out.map(b => `${b.kind}:${b.id}`)).toEqual(['claim:c-draft', 'invoice:i-draft'])
    const ordered = poCancellationBlockers('po1', { progressClaims: [claim('approved')], supplierInvoices: [invoice('posted')], variations: [variation('approved')] })
    expect(ordered.map(b => b.kind)).toEqual(['claim', 'invoice', 'variation'])
  })

  it('an unknown status label falls back to the raw status; missing numbers become empty strings', () => {
    const out = poCancellationBlockers('po1', { progressClaims: [{ id: 'x', poId: 'po1', status: 'weird' }] })
    expect(out).toEqual([{ kind: 'claim', id: 'x', number: '', status: 'weird', statusLabel: 'weird' }])
  })

  it('no poId → nothing blocks; empty inputs → nothing blocks; inputs are never mutated', () => {
    expect(poCancellationBlockers(null, { progressClaims: [claim('approved')] })).toEqual([])
    expect(poCancellationBlockers('po1')).toEqual([])
    const claims = deepFreeze([claim('approved')]), invoices = deepFreeze([invoice('posted')])
    expect(() => poCancellationBlockers('po1', { progressClaims: claims, supplierInvoices: invoices })).not.toThrow()
  })
})

describe('poCancellationReason', () => {
  it('names each blocker with its status and the remedy, never a deletion', () => {
    const blockers = poCancellationBlockers('po1', {
      progressClaims: [claim('approved'), claim('draft')],
      supplierInvoices: [invoice('posted')],
    })
    const reason = poCancellationReason('PO-0001', blockers)
    expect(reason).toContain('PO-0001 cannot be cancelled')
    expect(reason).toContain('2 progress claims — PC-approved (Approved), PC-draft (Draft)')
    expect(reason).toContain('1 supplier invoice — SI-posted (Posted)')
    expect(reason).toContain('Reject the claims and cancel the invoices first')
    expect(reason).toContain('cancelling the PO never changes them')
    expect(reason).not.toMatch(/delete/i)
  })

  it('names supplier variations and lists all three remedies when all three kinds block', () => {
    const blockers = poCancellationBlockers('po1', { progressClaims: [claim('approved')], supplierInvoices: [invoice('posted')], variations: [variation('approved')] })
    const reason = poCancellationReason('PO-0003', blockers)
    expect(reason).toContain('1 supplier variation — SV-approved (Approved)')
    expect(reason).toContain('Reject the claims, cancel the invoices and reject or withdraw the supplier variations first')
    const only = poCancellationReason('PO-0003', poCancellationBlockers('po1', { variations: [variation('draft')] }))
    expect(only).toContain('Reject or withdraw the supplier variations first')
  })

  it('claims-only and invoices-only phrasing', () => {
    expect(poCancellationReason('PO-0002', poCancellationBlockers('po1', { progressClaims: [claim('submitted')] })))
      .toContain('Reject the claims first')
    expect(poCancellationReason('PO-0002', poCancellationBlockers('po1', { supplierInvoices: [invoice('draft')] })))
      .toContain('Cancel the invoices first')
  })
})

describe('poCancellationGuard — fails closed', () => {
  it('allows a sent PO with no linked records, a draft PO, and a pending_approval PO', () => {
    for (const status of [PO_STATUS.SENT, PO_STATUS.DRAFT, PO_STATUS.PENDING_APPROVAL]) {
      expect(poCancellationGuard(po({ status }), settled())).toEqual({ allowed: true, pending: false, blockers: [], reason: null })
    }
  })

  it('allows when every linked claim is rejected, every linked invoice is cancelled and every linked supplier variation is rejected or withdrawn', () => {
    const g = poCancellationGuard(po(), settled([claim('rejected')], [invoice('cancelled')], [variation('rejected'), variation('withdrawn')]))
    expect(g.allowed).toBe(true)
  })

  it('blocks on an approved supplier variation alone', () => {
    const g = poCancellationGuard(po(), settled([], [], [variation('approved')]))
    expect(g.allowed).toBe(false)
    expect(g.blockers).toHaveLength(1)
    expect(g.reason).toContain('supplier variation')
  })

  it('blocks a closed or cancelled PO regardless of links — the status is not cancellable', () => {
    expect(poCancellationGuard(po({ status: PO_STATUS.CLOSED }), settled()))
      .toMatchObject({ allowed: false, pending: false, reason: 'A Closed purchase order cannot be cancelled.' })
    expect(poCancellationGuard(po({ status: PO_STATUS.CANCELLED }), settled()))
      .toMatchObject({ allowed: false, reason: 'A Cancelled purchase order cannot be cancelled.' })
  })

  it('blocks with the blockers and reason when any linked record still counts', () => {
    const g = poCancellationGuard(po(), settled([claim('approved')], [invoice('draft')]))
    expect(g.allowed).toBe(false)
    expect(g.pending).toBe(false)
    expect(g.blockers).toHaveLength(2)
    expect(g.reason).toContain('PO-0001 cannot be cancelled')
  })

  it('is PENDING (not allowed) while either register is still loading — unknown is never "nothing linked"', () => {
    const base = settled()
    expect(poCancellationGuard(po(), { ...base, progressClaimsLoading: true })).toMatchObject({ allowed: false, pending: true })
    expect(poCancellationGuard(po(), { ...base, supplierInvoicesLoading: true })).toMatchObject({ allowed: false, pending: true })
    expect(poCancellationGuard(po(), { ...base, variationsLoading: true })).toMatchObject({ allowed: false, pending: true })
  })

  it('is refused (not pending) when either register failed to load, with a reason that says so', () => {
    const base = settled()
    for (const flags of [{ progressClaimsError: true }, { supplierInvoicesError: true }, { variationsError: true }]) {
      const g = poCancellationGuard(po(), { ...base, ...flags })
      expect(g.allowed).toBe(false)
      expect(g.pending).toBe(false)
      expect(g.reason).toMatch(/could not be loaded/)
    }
  })

  it('a missing PO, or NO dependencies object at all, is refused — the guard never assumes an empty register', () => {
    expect(poCancellationGuard(null, settled())).toMatchObject({ allowed: false, pending: false })
    expect(poCancellationGuard(po())).toMatchObject({ allowed: false, pending: false, reason: expect.stringMatching(/must be loaded/) })
    expect(poCancellationGuard(po(), null)).toMatchObject({ allowed: false })
  })
})
