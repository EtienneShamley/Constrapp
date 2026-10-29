import { describe, it, expect } from 'vitest'
import {
  AWARD_PO_LINE_QTY, AWARD_PO_LINE_UNIT, awardPoDescription,
  linkedPurchaseOrders, currentLinkedPurchaseOrder, RAISE_STATE, raiseState,
  SUPPLIER_STATE, resolveAwardSupplier, sameSupplierPurchaseOrders,
  mapBidLineToPoLine, buildAwardPurchaseOrderProposal, raisePurchaseOrderGate,
} from '../../src/lib/awardToPo'
import {
  buildPurchaseOrderDocument, poTotals, roundMoney, remainingCommittedByCostCode, committedByCostCode,
  PO_SOURCE_KEYS, isAwardRaisedPo, PO_STATUS,
} from '../../src/lib/purchaseOrders'
import { assessBid, awardedBidValue, TENDER_STATUS, BID_STATUS } from '../../src/lib/tenders'

// ── M3-A: Awarded Tender → Linked Draft PO — pure domain tests (ADR-61) ─────
//
// No React, no Firebase. These pin the bid → PO mapping, the shared document
// builder, every blocker and warning, the link state and the fail-closed
// gate — and prove that a raised DRAFT moves no commercial figure.

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

const COST_CODES = deepFreeze([
  { id: 'cc1', code: '01-100', name: 'Steel',     unit: 't',  isActive: true },
  { id: 'cc2', code: '02-100', name: 'Metalwork', unit: 'm',  isActive: true },
  { id: 'cc3', code: '03-100', name: 'Retired',   unit: 'ea', isActive: false },
])
const CONTACTS = deepFreeze([
  { id: 'supplier1', displayName: 'Apex Steel Pty Ltd', contactTypes: ['supplier'], isActive: true },
  { id: 'supplier2', displayName: 'Beta Fab',           contactTypes: ['subcontractor'], isActive: true },
  { id: 'archived1', displayName: 'Gone Pty Ltd',       contactTypes: ['supplier'], isActive: false },
  { id: 'client1',   displayName: 'Owner Co',           contactTypes: ['client'], isActive: true },
])

const pkg = (o = {}) => ({
  id: 'pkg1', tenderNumber: 'TP-0007', status: TENDER_STATUS.AWARDED, name: 'Structural Steel',
  costCodes: [{ costCodeId: 'cc1', costCodeName: '01-100 — Steel' }, { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork' }, { costCodeId: 'cc3', costCodeName: '03-100 — Retired' }],
  awardedBidId: 'bid1', awardedBidderName: 'Apex Steel Pty Ltd', ...o,
})
const bid = (o = {}) => ({
  id: 'bid1', tenderPackageId: 'pkg1', tenderNumber: 'TP-0007', status: BID_STATUS.RECEIVED,
  bidderContactId: 'supplier1', bidderName: 'Apex Steel Pty Ltd', bidDate: '2026-08-10', bidderRef: 'Q-1',
  lineItems: [
    { costCodeId: 'cc1', costCodeName: '01-100 — Steel',     description: 'Supply',  amount: 1000 },
    { costCodeId: 'cc2', costCodeName: '02-100 — Metalwork', description: 'Install', amount: 250.15 },
    { costCodeId: 'cc1', costCodeName: '01-100 — Steel',     description: '',        amount: 0 },
  ],
  exclusions: 'Excludes cranage', notes: 'Subject to programme', currency: 'AUD', ...o,
})
const po = (o = {}) => ({
  id: 'poA', poNumber: 'PO-0003', status: PO_STATUS.DRAFT, supplierId: 'supplier1', supplierName: 'Apex Steel Pty Ltd',
  description: 'Manual', lineItems: [], subtotal: 100, createdAt: { seconds: 100 }, ...o,
})

const proposal = (o = {}) => buildAwardPurchaseOrderProposal({
  pkg: pkg(), bid: bid(), costCodes: COST_CODES, contacts: CONTACTS, projectCurrency: 'AUD', purchaseOrders: [], ...o,
})

// ── Mapping ──────────────────────────────────────────────────────────────────

describe('mapBidLineToPoLine — one bid line → one PO line', () => {
  it('qty 1, blank unit, rate = amount, lineTotal = amount, name re-snapshotted from the live library', () => {
    expect(AWARD_PO_LINE_QTY).toBe(1)
    expect(AWARD_PO_LINE_UNIT).toBe('')
    const line = mapBidLineToPoLine({ costCodeId: 'cc2', costCodeName: 'stale name', description: ' Install ', amount: 250.15 }, { costCodes: COST_CODES })
    expect(line).toEqual({ costCodeId: 'cc2', costCodeName: '02-100 — Metalwork', description: 'Install', qty: 1, unit: '', unitPrice: 250.15, lineTotal: 250.15 })
  })

  it('a zero amount is a legitimate zero line; an unknown cost code yields an empty name (validation then blocks)', () => {
    expect(mapBidLineToPoLine({ costCodeId: 'cc1', description: '', amount: 0 }, { costCodes: COST_CODES })).toMatchObject({ unitPrice: 0, lineTotal: 0, qty: 1 })
    expect(mapBidLineToPoLine({ costCodeId: 'ccX', description: '', amount: 5 }, { costCodes: COST_CODES }).costCodeName).toBe('')
  })

  it('does not mutate its inputs', () => {
    const li = deepFreeze({ costCodeId: 'cc1', description: 'x', amount: 1 })
    expect(() => mapBidLineToPoLine(li, { costCodes: COST_CODES })).not.toThrow()
  })
})

describe('buildAwardPurchaseOrderProposal — the happy path', () => {
  it('maps supplier, description, every line in bid order with repeated cost codes, and derives the header through poTotals', () => {
    const p = proposal()
    expect(p.ok).toBe(true)
    expect(p.blockers).toEqual([])
    expect(p.supplierId).toBe('supplier1')
    expect(p.supplierName).toBe('Apex Steel Pty Ltd')
    expect(p.description).toBe('TP-0007 — Structural Steel')
    expect(p.notes).toBe('')
    expect(p.lineItems.map(l => l.costCodeId)).toEqual(['cc1', 'cc2', 'cc1'])
    expect(p.lineItems.map(l => l.unitPrice)).toEqual([1000, 250.15, 0])
    expect(p.lineItems.every(l => l.qty === 1 && l.unit === '')).toBe(true)
    expect(p.totals).toEqual(poTotals(p.lineItems))
    expect(p.totals.subtotal).toBe(1250.15)
    expect(p.totals.gst).toBe(roundMoney(1250.15 * 0.1))
    expect(p.totals.total).toBe(roundMoney(p.totals.subtotal + p.totals.gst))
  })

  it('the PO subtotal equals the Awarded Bid Value exactly — a random sweep of cent amounts', () => {
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const lines = Array.from({ length: n }, (_, k) => ({
        costCodeId: k % 2 ? 'cc2' : 'cc1', costCodeName: '', description: '', amount: roundMoney(rnd() * 100000),
      }))
      const b = bid({ lineItems: lines })
      const p = proposal({ bid: b })
      expect(p.ok).toBe(true)
      expect(p.totals.subtotal).toBe(assessBid(b, pkg()).total)
      expect(p.totals.subtotal).toBe(awardedBidValue(pkg(), [b]).total)
    }
  })

  it('exposes the bid’s exclusions, notes and reference for display and never copies them into the PO notes', () => {
    const p = proposal()
    expect(p.exclusions).toBe('Excludes cranage')
    expect(p.bidNotes).toBe('Subject to programme')
    expect(p.bidderRef).toBe('Q-1')
    expect(p.notes).toBe('')
    expect(p.description).not.toContain('cranage')
  })

  it('carries up to 100 bid lines (the bid ceiling is below the PO ceiling)', () => {
    const lines = Array.from({ length: 100 }, (_, k) => ({ costCodeId: 'cc1', costCodeName: '', description: `L${k}`, amount: 1 }))
    const p = proposal({ bid: bid({ lineItems: lines }) })
    expect(p.ok).toBe(true)
    expect(p.lineItems).toHaveLength(100)
    expect(p.totals.subtotal).toBe(100)
  })

  it('does not mutate frozen inputs', () => {
    const frozenPkg = deepFreeze(pkg())
    const frozenBid = deepFreeze(bid())
    expect(() => buildAwardPurchaseOrderProposal({ pkg: frozenPkg, bid: frozenBid, costCodes: COST_CODES, contacts: CONTACTS, projectCurrency: 'AUD', purchaseOrders: deepFreeze([po()]) })).not.toThrow()
  })
})

// ── Blockers ─────────────────────────────────────────────────────────────────

describe('buildAwardPurchaseOrderProposal — blockers (fail closed, nothing clamped)', () => {
  it('package not awarded (draft / issued / cancelled)', () => {
    for (const status of ['draft', 'issued', 'cancelled']) {
      const p = proposal({ pkg: pkg({ status }) })
      expect(p.ok).toBe(false)
      expect(p.blockers.join(' ')).toMatch(/Only an awarded package/)
    }
  })

  it('bid missing, void, not the awarded bid, or of another package', () => {
    expect(proposal({ bid: null }).blockers.join(' ')).toMatch(/could not be found/)
    expect(proposal({ bid: bid({ status: 'void' }) }).blockers.join(' ')).toMatch(/void/)
    expect(proposal({ pkg: pkg({ awardedBidId: 'bid9' }) }).blockers.join(' ')).toMatch(/not the bid the package was awarded to/)
    expect(proposal({ bid: bid({ tenderPackageId: 'pkg9' }) }).blockers.join(' ')).toMatch(/different package/)
  })

  it('a bid that fails the validity gate — malformed, negative, non-finite, out-of-scope lines — is blocked and never partially mapped', () => {
    for (const bad of [
      [{ costCodeId: 'cc1', costCodeName: '', description: '', amount: -5 }],
      [{ costCodeId: 'cc1', costCodeName: '', description: '', amount: 'ten' }],
      [{ costCodeId: 'cc1', costCodeName: '', description: '', amount: Infinity }],
      [{ costCodeId: 'ccZ', costCodeName: '', description: '', amount: 5 }],   // outside the package scope
      ['not a line'],
      [],
    ]) {
      const p = proposal({ bid: bid({ lineItems: bad }) })
      expect(p.ok).toBe(false)
      expect(p.blockers.join(' ')).toMatch(/validity gate|no priced line/)
      expect(p.awardedTotal).toBeNull()
    }
  })

  it('a sub-cent amount (direct-write bid) is blocked rather than rounded', () => {
    const p = proposal({ bid: bid({ lineItems: [{ costCodeId: 'cc1', costCodeName: '', description: '', amount: 0.004 }] }) })
    expect(p.ok).toBe(false)
    expect(p.blockers.join(' ')).toMatch(/not a whole-cent value/)
  })

  it('a cost code missing from the library blocks and names the line; an inactive one only warns', () => {
    const missing = proposal({ bid: bid({ lineItems: [{ costCodeId: 'ccX', costCodeName: 'old', description: '', amount: 1 }] }), pkg: pkg({ costCodes: [{ costCodeId: 'ccX', costCodeName: 'old' }] }) })
    expect(missing.ok).toBe(false)
    expect(missing.blockers.join(' ')).toMatch(/line 1 \(old\) no longer exists/)
    const inactive = proposal({ bid: bid({ lineItems: [{ costCodeId: 'cc3', costCodeName: '', description: '', amount: 1 }] }) })
    expect(inactive.ok).toBe(true)
    expect(inactive.warnings.join(' ')).toMatch(/Inactive cost code.*03-100 — Retired/)
    expect(inactive.lineItems[0].costCodeName).toBe('03-100 — Retired')
  })

  it('supplier missing or archived blocks; a contact no longer typed supplier / subcontractor and a renamed contact only warn', () => {
    expect(proposal({ bid: bid({ bidderContactId: 'nobody' }) }).blockers.join(' ')).toMatch(/no longer exists in Contacts/)
    expect(proposal({ bid: bid({ bidderContactId: 'archived1', bidderName: 'Gone Pty Ltd' }) }).blockers.join(' ')).toMatch(/archived/)
    const typed = proposal({ bid: bid({ bidderContactId: 'client1', bidderName: 'Owner Co' }) })
    expect(typed.ok).toBe(true)
    expect(typed.warnings.join(' ')).toMatch(/no longer marked as a supplier/)
    const renamed = proposal({ contacts: [{ ...CONTACTS[0], displayName: 'Apex Steel (new name)' }] })
    expect(renamed.ok).toBe(true)
    expect(renamed.supplierName).toBe('Apex Steel Pty Ltd')
    expect(renamed.warnings.join(' ')).toMatch(/now named "Apex Steel \(new name\)"/)
  })

  it('a currency mismatch between the bid snapshot and the project blocks', () => {
    const p = proposal({ bid: bid({ currency: 'NZD' }) })
    expect(p.ok).toBe(false)
    expect(p.blockers.join(' ')).toMatch(/priced in NZD but the project reports in AUD/)
    expect(proposal({ bid: bid({ currency: undefined }) }).ok).toBe(true)  // legacy bid without the snapshot
  })

  it('an existing linked PO that is draft, sent or closed blocks; cancelled permits a re-raise; an unresolvable link blocks', () => {
    for (const status of ['draft', 'sent', 'closed']) {
      const p = proposal({ pkg: pkg({ raisedPoId: 'poA', raisedPoNumber: 'PO-0003' }), purchaseOrders: [po({ status, sourceTenderPackageId: 'pkg1' })] })
      expect(p.ok).toBe(false)
      expect(p.blockers.join(' ')).toMatch(new RegExp(`PO-0003 has already been raised.*is ${status}`))
      expect(p.linked.state).toBe(RAISE_STATE.ACTIVE)
    }
    const re = proposal({ pkg: pkg({ raisedPoId: 'poA' }), purchaseOrders: [po({ status: 'cancelled', sourceTenderPackageId: 'pkg1' })] })
    expect(re.ok).toBe(true)
    expect(re.linked.state).toBe(RAISE_STATE.CANCELLED)
    expect(re.linked.current.id).toBe('poA')
    const unknown = proposal({ pkg: pkg({ raisedPoId: 'poGone' }), purchaseOrders: [] })
    expect(unknown.ok).toBe(false)
    expect(unknown.blockers.join(' ')).toMatch(/could not be found in the register/)
  })
})

// ── Warnings: same-supplier manual POs ───────────────────────────────────────

describe('same-supplier purchase orders — a warning, never a block, never proof', () => {
  it('lists non-cancelled POs to the awarded supplier that were not raised from this package', () => {
    const register = [
      po({ id: 'm1', poNumber: 'PO-0001', status: 'sent' }),
      po({ id: 'm2', poNumber: 'PO-0002', status: 'cancelled' }),
      po({ id: 'o1', poNumber: 'PO-0004', supplierId: 'supplier2' }),
      po({ id: 'l1', poNumber: 'PO-0005', status: 'cancelled', sourceTenderPackageId: 'pkg1' }),
      po({ id: 'l2', poNumber: 'PO-0006', status: 'draft', sourceTenderPackageId: 'pkg2' }),
    ]
    expect(sameSupplierPurchaseOrders(pkg(), bid(), register).map(p => p.poNumber)).toEqual(['PO-0001', 'PO-0006'])
    const p = proposal({ purchaseOrders: register })
    expect(p.ok).toBe(true)
    expect(p.sameSupplier.map(x => x.poNumber)).toEqual(['PO-0001', 'PO-0006'])
    expect(p.warnings.join(' ')).toMatch(/2 purchase orders to this supplier already exist.*PO-0001, PO-0006.*cannot tell/)
  })

  it('is empty with no register, no supplier or only cancelled POs', () => {
    expect(sameSupplierPurchaseOrders(pkg(), bid(), [])).toEqual([])
    expect(sameSupplierPurchaseOrders(pkg(), null, [po()])).toEqual([])
    expect(sameSupplierPurchaseOrders(pkg(), bid(), [po({ status: 'cancelled' })])).toEqual([])
  })
})

// ── Link state ───────────────────────────────────────────────────────────────

describe('link state helpers', () => {
  it('linkedPurchaseOrders lists every PO citing the package, newest first, cancelled included', () => {
    const register = [
      po({ id: 'a', sourceTenderPackageId: 'pkg1', createdAt: { seconds: 10 }, status: 'cancelled' }),
      po({ id: 'b', sourceTenderPackageId: 'pkg1', createdAt: { seconds: 30 } }),
      po({ id: 'c', sourceTenderPackageId: 'pkg2', createdAt: { seconds: 20 } }),
      po({ id: 'd' }),
    ]
    expect(linkedPurchaseOrders(pkg(), register).map(p => p.id)).toEqual(['b', 'a'])
    expect(linkedPurchaseOrders(null, register)).toEqual([])
  })

  it('currentLinkedPurchaseOrder follows the back-link; raiseState is none / active / cancelled / unknown', () => {
    expect(currentLinkedPurchaseOrder(pkg(), [po()])).toBeNull()
    expect(raiseState(pkg(), [])).toBe(RAISE_STATE.NONE)
    expect(currentLinkedPurchaseOrder(pkg({ raisedPoId: 'poA' }), [po()]).id).toBe('poA')
    expect(raiseState(pkg({ raisedPoId: 'poA' }), [po({ status: 'sent' })])).toBe(RAISE_STATE.ACTIVE)
    expect(raiseState(pkg({ raisedPoId: 'poA' }), [po({ status: 'cancelled' })])).toBe(RAISE_STATE.CANCELLED)
    expect(raiseState(pkg({ raisedPoId: 'poA' }), [])).toBe(RAISE_STATE.UNKNOWN)
  })

  it('resolveAwardSupplier reports ok / missing / archived, the type check and a rename', () => {
    expect(resolveAwardSupplier(bid(), CONTACTS)).toMatchObject({ state: SUPPLIER_STATE.OK, typeOk: true, renamed: false })
    expect(resolveAwardSupplier(bid({ bidderContactId: 'zzz' }), CONTACTS)).toMatchObject({ state: SUPPLIER_STATE.MISSING, contact: null })
    expect(resolveAwardSupplier(bid({ bidderContactId: 'archived1' }), CONTACTS)).toMatchObject({ state: SUPPLIER_STATE.ARCHIVED })
    expect(resolveAwardSupplier(bid({ bidderContactId: 'client1' }), CONTACTS)).toMatchObject({ state: SUPPLIER_STATE.OK, typeOk: false, renamed: true })
  })

  it('awardPoDescription is "TP — name" and tolerates a missing name', () => {
    expect(awardPoDescription(pkg())).toBe('TP-0007 — Structural Steel')
    expect(awardPoDescription({ tenderNumber: 'TP-0001' })).toBe('TP-0001')
  })
})

// ── The gate ─────────────────────────────────────────────────────────────────

describe('raisePurchaseOrderGate — fail closed over subscription state', () => {
  const inputs = (o = {}) => ({ pkg: pkg(), bid: bid(), costCodes: COST_CODES, contacts: CONTACTS, projectCurrency: 'AUD', purchaseOrders: [], ...o })

  it('allows a clean proposal', () => {
    expect(raisePurchaseOrderGate(inputs())).toEqual({ allowed: true, pending: false, reason: null })
  })

  it('is pending (not allowed) while any source is loading', () => {
    for (const flag of ['purchaseOrdersLoading', 'bidsLoading', 'contactsLoading', 'costCodesLoading']) {
      const g = raisePurchaseOrderGate(inputs({ [flag]: true }))
      expect(g.allowed).toBe(false)
      expect(g.pending).toBe(true)
    }
  })

  it('refuses with a named reason when any source failed — unavailable is never "nothing linked"', () => {
    for (const [flag, re] of [
      ['purchaseOrdersError', /Purchase orders could not be loaded/],
      ['bidsError', /Bids could not be loaded/],
      ['contactsError', /Contacts could not be loaded/],
      ['costCodesError', /Cost codes could not be loaded/],
    ]) {
      const g = raisePurchaseOrderGate(inputs({ [flag]: true }))
      expect(g).toMatchObject({ allowed: false, pending: false })
      expect(g.reason).toMatch(re)
    }
  })

  it('refuses a non-awarded package before looking at anything else, and surfaces the proposal’s first blocker', () => {
    expect(raisePurchaseOrderGate(inputs({ pkg: pkg({ status: 'issued' }), purchaseOrdersLoading: true })).reason).toMatch(/Only an awarded package/)
    expect(raisePurchaseOrderGate(inputs({ bid: null })).reason).toMatch(/could not be found/)
    expect(raisePurchaseOrderGate(inputs({ pkg: pkg({ raisedPoId: 'poA' }), purchaseOrders: [po({ status: 'draft' })] })).reason).toMatch(/already been raised/)
  })
})

// ── The shared document builder and the financial regression ─────────────────

describe('buildPurchaseOrderDocument — one shape for manual and award-raised POs', () => {
  const NOW = Symbol('serverTimestamp()')
  const MANUAL_KEYS = [
    'poNumber', 'status', 'supplierName', 'supplierId', 'description', 'lineItems', 'subtotal', 'gst', 'total',
    'currency', 'revision', 'notes', 'sentAt', 'sentBy', 'closedAt', 'closedBy', 'cancelledAt', 'cancelledBy',
    'externalRefs', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
  ].sort()

  it('a manual document carries exactly the 23 rules-pinned keys and no source key', () => {
    const d = buildPurchaseOrderDocument({ poNumber: 'PO-0001', supplierName: ' Acme ', supplierId: 'c1', description: ' Slab ', notes: undefined, lineItems: [{ lineTotal: 10 }], currency: 'AUD', uid: 'u1', now: NOW })
    expect(Object.keys(d).sort()).toEqual(MANUAL_KEYS)
    expect(d).toMatchObject({ status: 'draft', supplierName: 'Acme', supplierId: 'c1', description: 'Slab', notes: '', subtotal: 10, gst: 1, total: 11, currency: 'AUD', revision: 1, externalRefs: {}, createdAt: NOW, createdBy: 'u1', updatedAt: NOW, updatedBy: 'u1' })
    for (const k of ['sentAt', 'sentBy', 'closedAt', 'closedBy', 'cancelledAt', 'cancelledBy']) expect(d[k]).toBeNull()
    expect(isAwardRaisedPo(d)).toBe(false)
  })

  it('an award-raised document adds exactly the three source keys, otherwise identical in shape and derivation', () => {
    const p = proposal()
    const d = buildPurchaseOrderDocument({ poNumber: 'PO-0002', supplierName: p.supplierName, supplierId: p.supplierId, description: p.description, notes: p.notes, lineItems: p.lineItems, currency: 'AUD', uid: 'u1', now: NOW, source: { tenderPackageId: 'pkg1', tenderBidId: 'bid1', tenderNumber: 'TP-0007' } })
    expect(Object.keys(d).sort()).toEqual([...MANUAL_KEYS, ...PO_SOURCE_KEYS].sort())
    expect(d).toMatchObject({ sourceTenderPackageId: 'pkg1', sourceTenderBidId: 'bid1', sourceTenderNumber: 'TP-0007', status: 'draft', supplierId: 'supplier1', supplierName: 'Apex Steel Pty Ltd' })
    expect(d.subtotal).toBe(p.totals.subtotal)
    expect(d.total).toBe(p.totals.total)
    expect(isAwardRaisedPo(d)).toBe(true)
    expect(isAwardRaisedPo({ ...d, sourceTenderPackageId: '' })).toBe(false)
  })

  it('a null supplierId is kept null (pre-Contacts shape) and a null source adds nothing', () => {
    const d = buildPurchaseOrderDocument({ poNumber: 'PO-0001', supplierName: 'Legacy', supplierId: null, description: '', notes: '', lineItems: [], currency: 'AUD', uid: 'u1', now: NOW, source: null })
    expect(d.supplierId).toBeNull()
    expect('sourceTenderPackageId' in d).toBe(false)
  })
})

describe('financial regression — a raised DRAFT moves nothing until it is sent', () => {
  it('contributes nothing to Committed or Remaining Committed as a draft; sending commits exactly the bid lines by cost code', () => {
    const p = proposal()
    const d = buildPurchaseOrderDocument({ poNumber: 'PO-0002', supplierName: p.supplierName, supplierId: p.supplierId, description: p.description, notes: '', lineItems: p.lineItems, currency: 'AUD', uid: 'u1', now: 't', source: { tenderPackageId: 'pkg1', tenderBidId: 'bid1', tenderNumber: 'TP-0007' } })
    const draft = { id: 'po2', ...d }
    expect(committedByCostCode([draft])).toEqual({})
    expect(remainingCommittedByCostCode([draft])).toEqual({})
    const sent = { ...draft, status: 'sent' }
    expect(committedByCostCode([sent])).toEqual({ cc1: 1000, cc2: 250.15 })
    expect(remainingCommittedByCostCode([sent])).toEqual({ cc1: 1000, cc2: 250.15 })
    // …and that is the awarded value, once — the award itself is never added.
    expect(roundMoney(1000 + 250.15)).toBe(awardedBidValue(pkg(), [bid()]).total)
  })
})
