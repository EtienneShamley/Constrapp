import { beforeAll, beforeEach, describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { admin, resetEmulators, seedCompany, activateCommercial, seedUser, req, expectTeamError, clock, silentLog, COMPANY_A } from './_harness.js'

// ── ADR-94 — the historical baseline's consistency protocol, and corrective
// voids on an inconsistent ledger ────────────────────────────────────────────
//
// Handlers and ensureSupplierBaseline are called directly against the
// emulators. Expected figures are integers computed here.

const PROJECT = 'projectA'
const T0 = Date.parse('2026-11-28T02:00:00Z')
let A, handlersMod, baselineMod, nowMs

const company = () => A.db.collection('companies').doc(COMPANY_A)
const project = () => company().collection('projects').doc(PROJECT)
const col = (name) => project().collection(name)
const data = (ref) => ref.get().then(s => (s.exists ? s.data() : null))
const marker = () => data(col('supplierFinanceState').doc('baseline'))
const ledger = (id) => data(col('supplierInvoiceLedgers').doc(id))
const ledgerIds = async () => (await col('supplierInvoiceLedgers').get()).docs.map(d => d.id).sort()
const baselineAudits = async () => (await company().collection('auditEvents').get()).docs.map(d => d.data()).filter(e => e.type === 'supplier_finance.baseline_established')

const deps = (extra = {}) => ({ db: A.db, now: clock('2026-11-28T02:00:00Z'), log: silentLog, config: () => ({ enabled: true }), clock: () => nowMs, ...extra })
const ensure = (extra = {}, uid = 'u_qs') => baselineMod.ensureSupplierBaseline(deps(extra), { uid, companyId: COMPANY_A, projectId: PROJECT })
const settleOp = (uid, operation, request, d = deps()) => handlersMod.createSupplierFinanceHandlers(d).supplierSettlementOperation(req(uid, { operation, request }))

// A posted invoice: S 1,000.00, G 100.00, retention 100.00 + 10.00, payable 990.00.
const invoiceDoc = (n) => ({
  invoiceNumber: `SI-${String(n).padStart(4, '0')}`, status: 'posted', source: 'direct_po', supplierId: 's1', supplierName: 'S',
  lineItems: [{ poLineIndex: 0, costCodeId: 'cc1', costCodeName: 'Concrete', description: '', amount: 1000, taxCode: 'gst', gstAmount: 100 }],
  subtotal: 1000, gstTotal: 100, grossTotal: 1100, retention: 100, retentionGst: 10, retentionTotal: 110, net: 900, payableGst: 90, payableTotal: 990, currency: 'AUD', revision: 3,
})
const paymentDoc = (id, allocations) => ({ paymentNumber: id, status: 'posted', supplierId: 's1', supplierName: 'S', allocations, amount: allocations.reduce((s, a) => s + a.allocatedAmount, 0) })
const releaseDoc = (id, invoiceId, amount, gstAmount) => ({ releaseNumber: id, status: 'posted', supplierInvoiceId: invoiceId, amount, gstAmount, releaseTotal: amount + gstAmount, revision: 2 })

async function seedHistory(invoices) {
  let batch = A.db.batch()
  let n = 0
  const flush = async () => { await batch.commit(); batch = A.db.batch(); n = 0 }
  for (let i = 1; i <= invoices; i += 1) {
    batch.set(col('supplierInvoices').doc(`inv${i}`), invoiceDoc(i))
    batch.set(col('supplierPayments').doc(`pay${i}`), paymentDoc(`SP-${i}`, [{ supplierInvoiceId: `inv${i}`, allocatedAmount: (10000 + i) / 100 }]))
    n += 2
    if (n >= 400) await flush()
  }
  await flush()
}

beforeAll(async () => {
  A = await admin()
  handlersMod = await import('../../functions/src/supplierFinance/handlers.js')
  baselineMod = await import('../../functions/src/supplierFinance/baseline.js')
})

beforeEach(async () => {
  await resetEmulators()
  nowMs = T0
  await seedCompany(COMPANY_A)
  await activateCommercial(COMPANY_A)
  await seedUser({ uid: 'u_qs', email: 'qs@a.test', role: 'qs', companyId: COMPANY_A })
  await seedUser({ uid: 'u_pm', email: 'pm@a.test', role: 'project_manager', companyId: COMPANY_A })
  await project().set({ name: 'A', status: 'active', currency: 'AUD' })
  await company().collection('contacts').doc('s1').set({ displayName: 'S', isActive: true })
})

describe('the baseline protocol', () => {
  it('COMPLETE marker: state, counts, both digests (recomputable from the registers), one audit event; a second call does nothing', async () => {
    await seedHistory(3)
    const out = await ensure()
    expect(out.established).toBe(true)
    const m = await marker()
    expect(m).toMatchObject({ state: 'complete', establishedBy: 'u_qs', attempt: 1, counts: { invoiceLedgers: 3, invoices: 3, payments: 3, staleLedgersRemoved: 0 } })
    // The source digest, recomputed independently from the registers as they stand.
    const lines = []
    for (const name of ['supplierInvoices', 'supplierCreditNotes', 'retentionReleases', 'supplierPayments', 'progressClaims']) {
      for (const d of (await col(name).get()).docs) lines.push(`${d.ref.path}@${d.updateTime.seconds}.${d.updateTime.nanoseconds}`)
    }
    expect(m.sourceDigest).toBe(createHash('sha256').update(lines.sort().join('\n')).digest('hex'))
    expect(m.ledgerDigest).toMatch(/^[0-9a-f]{64}$/)
    // ORACLE: 100.01, 100.02, 100.03.
    expect((await ledger('inv2')).paidCents).toBe(10002)
    expect((await ensure()).established).toBe(false)
    expect(await baselineAudits()).toHaveLength(1)
  })

  it('TWO REQUESTS AT ONCE: one establishes; the other is refused busy (nothing written by it) or finds it complete; exactly one marker and one audit event', async () => {
    await seedHistory(5)
    const results = await Promise.allSettled([ensure({}, 'u_qs'), ensure({}, 'u_pm')])
    expect(results.filter(r => r.status === 'fulfilled' && r.value.established)).toHaveLength(1)
    for (const r of results.filter(x => x.status === 'rejected')) expect(r.reason?.details?.code).toBe('supplier-finance-busy')
    expect((await marker()).state).toBe('complete')
    expect(await baselineAudits()).toHaveLength(1)
    expect(await ledgerIds()).toHaveLength(5)
  })

  it('INTERRUPTED BETWEEN CHUNKS: the marker stays `building`, every operation refuses, nothing is authoritative; after the lease a retry takes over and completes exactly', async () => {
    await seedHistory(450) // three chunks of 200
    await expect(ensure({ afterBaselineChunk: ({ index }) => { if (index === 0) throw new Error('crash') } })).rejects.toThrow('crash')
    expect(await marker()).toMatchObject({ state: 'building', attempt: 1 })
    expect((await ledgerIds()).length).toBe(200) // partial, visible to no operation:
    const save = { projectId: PROJECT, releaseId: 'r1', expectedRevision: null, supplierInvoiceId: 'inv1', amount: 1, releaseDate: '2026-11-28', reason: 'PC', notes: '' }
    // Inside the lease another request is refused busy and writes nothing.
    await expectTeamError(settleOp('u_qs', 'saveRelease', save), 'supplier-finance-busy')
    expect(await data(col('retentionReleases').doc('r1'))).toBeNull()
    // After the lease: takeover.
    nowMs = T0 + baselineMod.BASELINE_LEASE_MS + 1
    const out = await ensure()
    expect(out.established).toBe(true)
    expect(await marker()).toMatchObject({ state: 'complete', attempt: 2, counts: { invoiceLedgers: 450 } })
    expect(await ledgerIds()).toHaveLength(450)
    expect((await ledger('inv450')).paidCents).toBe(10450)
    expect(await baselineAudits()).toHaveLength(1)
  }, 120000)

  it('TAKEOVER FENCE: a superseded run can write nothing more and cannot complete', async () => {
    await seedHistory(250)
    let takeover = null
    const slow = ensure({ afterBaselineChunk: async ({ index }) => {
      if (index !== 0) return
      nowMs = T0 + baselineMod.BASELINE_LEASE_MS + 1 // the first run has outlived its lease
      takeover = await ensure({}, 'u_pm')
    } })
    const err = await slow.then(() => null, e => e)
    expect(err?.details?.code).toBe('supplier-finance-busy')
    expect(err?.details?.reason).toBe('baseline-superseded')
    expect(takeover.established).toBe(true)
    expect(await marker()).toMatchObject({ state: 'complete', establishedBy: 'u_pm', attempt: 2 })
    expect(await baselineAudits()).toHaveLength(1)
  }, 120000)

  it('SOURCE CHANGED DURING THE RUN: a register document written between the snapshot and the fence abandons the run — no marker, nothing authoritative; the retry reads the new history', async () => {
    await seedHistory(2)
    const err = await ensure({ afterBaselineChunk: async () => {
      await col('supplierPayments').doc('late').set(paymentDoc('SP-LATE', [{ supplierInvoiceId: 'inv1', allocatedAmount: 50 }]))
    } }).then(() => null, e => e)
    expect(err?.details).toMatchObject({ code: 'supplier-finance-busy', reason: 'baseline-source-changed' })
    expect(await marker()).toBeNull()
    expect(await baselineAudits()).toHaveLength(0)
    await ensure()
    // ORACLE: 100.01 + 50.00.
    expect((await ledger('inv1')).paidCents).toBe(15001)
  })

  it('ADVERSARIAL — a source record written IMMEDIATELY AFTER the final digest, inside the completion window: it is detected (abandoned) or ordered after completion — never completed over unseen', async () => {
    await seedHistory(3)
    let pending = null
    let fired = false
    const out = await ensure({ afterFinalDigest: async () => {
      if (fired) return
      fired = true
      // Not awaited: the write races the completing transaction that has just read the registers.
      pending = col('supplierPayments').doc('late').set(paymentDoc('SP-LATE', [{ supplierInvoiceId: 'inv1', allocatedAmount: 50 }]))
        .then(r => ({ ok: true, time: r.writeTime }), e => ({ ok: false, e }))
      await new Promise(r => setTimeout(r, 400))
    } }).then(v => ({ ok: true, v }), e => ({ ok: false, e }))
    const write = await pending
    expect(write.ok).toBe(true)
    const m = await marker()
    if (out.ok) {
      // Completed: the late write must be ordered AFTER the completion, and the
      // stored source digest must be the digest WITHOUT it.
      expect(m.state).toBe('complete')
      const markerSnap = await col('supplierFinanceState').doc('baseline').get()
      expect(write.time.valueOf() > markerSnap.updateTime.valueOf()).toBe(true)
      expect((await ledger('inv1')).paidCents).toBe(10001)
    } else {
      expect(out.e?.details).toMatchObject({ code: 'supplier-finance-busy', reason: 'baseline-source-changed' })
      expect(m).toBeNull()
      expect(await baselineAudits()).toHaveLength(0)
      // The retry reads the late payment: 100.01 + 50.00.
      await ensure()
      expect((await ledger('inv1')).paidCents).toBe(15001)
    }
  })

  it('ADVERSARIAL — a claim SUBMIT (the one remaining client write) racing completion abandons the run; the retry completes', async () => {
    await seedHistory(1)
    await col('progressClaims').doc('cl1').set({ claimNumber: 'PC-0001', status: 'draft', poId: 'po1', lineItems: [], revision: 1 })
    let fired = false
    let pending = null
    const out = await ensure({ afterFinalDigest: async () => {
      if (fired) return
      fired = true
      pending = col('progressClaims').doc('cl1').update({ status: 'submitted', revision: 2 })
      await Promise.race([pending, new Promise(r => setTimeout(r, 400))])
    } }).then(v => ({ ok: true, v }), e => ({ ok: false, e }))
    await pending
    // Either the write waited for the transaction (completion first) or it
    // committed first and the transaction re-ran, saw the change and abandoned.
    if (!out.ok) {
      expect(out.e?.details?.reason).toBe('baseline-source-changed')
      await ensure()
    }
    expect((await marker()).state).toBe('complete')
    expect((await col('poClaimLedgers').doc('po1').get()).data()).toMatchObject({ openClaimIds: ['cl1'], state: 'established' })
  })

  it('STALE LEDGERS from an abandoned run are replaced or removed: the completed set is exactly what the history implies', async () => {
    await seedHistory(2)
    // What an interrupted earlier run could have left: a wrong figure and a ledger for nothing.
    await col('supplierInvoiceLedgers').doc('inv1').set({ paidCents: 999999, seq: 0, groups: {}, state: 'established' })
    await col('supplierInvoiceLedgers').doc('ghost').set({ paidCents: 5, seq: 0, groups: {}, state: 'established' })
    await col('poClaimLedgers').doc('ghostPo').set({ openClaimIds: ['x'], seq: 0 })
    await ensure()
    expect((await ledger('inv1')).paidCents).toBe(10001)
    expect(await ledgerIds()).toEqual(['inv1', 'inv2'])
    expect((await col('poClaimLedgers').get()).size).toBe(0)
    expect((await marker()).counts.staleLedgersRemoved).toBe(2)
  })

  it('MEMBERSHIP REVOKED DURING THE RUN: nothing completes; the run is released; an active member then establishes it', async () => {
    await seedHistory(2)
    await expectTeamError(ensure({ afterBaselineChunk: async () => { await A.db.collection('users').doc('u_qs').update({ status: 'deactivated' }) } }), 'membership-inactive')
    expect(await marker()).toBeNull()
    expect(await baselineAudits()).toHaveLength(0)
    expect((await ensure({}, 'u_pm')).established).toBe(true)
  })

  it('MISSING SOURCE: a posted payment that cannot be attributed refuses the whole baseline, naming it; nothing written, the run released', async () => {
    await seedHistory(1)
    await col('supplierPayments').doc('bad').set({ paymentNumber: 'SP-BAD', status: 'posted', allocations: [{ supplierInvoiceId: '', allocatedAmount: 5 }] })
    const err = await expectTeamError(ensure(), 'supplier-finance-baseline-invalid')
    expect(err.message).toMatch(/SP-BAD/)
    expect(await marker()).toBeNull()
    expect(await ledgerIds()).toEqual([])
  })

  it('A MARKER THAT IS NOT `complete` is never authoritative: an operation reading it inside its transaction refuses', async () => {
    await seedHistory(1)
    await col('supplierFinanceState').doc('baseline').set({ state: 'building', runId: 'x', leaseUntilMillis: T0 + 10_000 })
    const { settleDocument } = await import('../../functions/src/supplierFinance/settlement.js')
    const err = await settleDocument(deps(), { uid: 'u_pm', input: { projectId: PROJECT, documentId: 'pay1', expectedRevision: 0, voidReason: 'x' }, kind: 'payment', action: 'void' }).then(() => null, e => e)
    expect(err?.details).toMatchObject({ code: 'supplier-finance-baseline-invalid', reason: 'incomplete' })
  })

  it('MEASURED COST — 1,000 invoices, 1,000 posted payments: chunks, documents and time', async () => {
    await seedHistory(1000)
    let chunks = 0
    const t = Date.now()
    await ensure({ afterBaselineChunk: () => { chunks += 1 } })
    const ms = Date.now() - t
    const m = await marker()
    expect(m.counts).toMatchObject({ invoiceLedgers: 1000, invoices: 1000, payments: 1000 })
    expect(chunks).toBe(5)
    const one = await ledger('inv1000')
    const bytes = JSON.stringify(one).length
    process.stdout.write(`\n[baseline cost] registers 2,000 docs → snapshot reads 2 × 2,000 = 4,000; ledger writes 1,000 in ${chunks} transactions; ${ms} ms on the emulator; one ledger ≈ ${bytes} bytes JSON\n`)
    expect(bytes).toBeLessThan(1000)
  }, 180000)
})

describe('corrective voids on an inconsistent ledger', () => {
  const voidOp = (uid, op, documentId, expectedRevision = 2) => settleOp(uid, op, { projectId: PROJECT, documentId, expectedRevision, voidReason: 'Recorded in error' })
  const saveRelease = (id, amount) => settleOp('u_qs', 'saveRelease', { projectId: PROJECT, releaseId: id, expectedRevision: null, supplierInvoiceId: 'inv1', amount, releaseDate: '2026-11-28', reason: 'PC', notes: '' })

  it('OVER-RELEASED (70 + 70 of 100): postings refuse; voiding one release corrects it and the ledger is established; original documents and audit are kept', async () => {
    await col('supplierInvoices').doc('inv1').set(invoiceDoc(1))
    await col('retentionReleases').doc('h1').set(releaseDoc('RR-1', 'inv1', 70, 7))
    await col('retentionReleases').doc('h2').set(releaseDoc('RR-2', 'inv1', 70, 7))
    await expectTeamError(saveRelease('r9', 1), 'supplier-finance-ledger-inconsistent')
    expect(await ledger('inv1')).toMatchObject({ state: 'inconsistent', releasedRetentionCents: 14000 })
    await voidOp('u_pm', 'voidRelease', 'h2')
    expect(await ledger('inv1')).toMatchObject({ state: 'established', problem: null, releasedRetentionCents: 7000, releasedRetentionGstCents: 700 })
    expect(await data(col('retentionReleases').doc('h2'))).toMatchObject({ status: 'void', amount: 70, gstAmount: 7, voidedBy: 'u_pm' })
    expect((await company().collection('auditEvents').get()).docs.map(d => d.data().type)).toContain('retention_release.voided')
    await saveRelease('r9', 30) // usable again, exactly: 100 − 70 = 30 held
    await expectTeamError(saveRelease('r10', 30.01), 'supplier-finance-cap-exceeded')
  })

  it('STILL INCONSISTENT after one void (three releases of 70): the state stays inconsistent — it is never marked valid early', async () => {
    await col('supplierInvoices').doc('inv1').set(invoiceDoc(1))
    for (const id of ['h1', 'h2', 'h3']) await col('retentionReleases').doc(id).set(releaseDoc(id, 'inv1', 70, 7))
    await ensure()
    await voidOp('u_pm', 'voidRelease', 'h3')
    expect(await ledger('inv1')).toMatchObject({ state: 'inconsistent', releasedRetentionCents: 14000 })
    await voidOp('u_pm', 'voidRelease', 'h2')
    expect(await ledger('inv1')).toMatchObject({ state: 'established', releasedRetentionCents: 7000 })
  })

  it('A PAYMENT DEPENDS ON THE RELEASE: the void is refused even on an inconsistent ledger (it would create an unavailable balance)', async () => {
    await col('supplierInvoices').doc('inv1').set(invoiceDoc(1))
    await col('retentionReleases').doc('h1').set(releaseDoc('RR-1', 'inv1', 70, 7))
    await col('retentionReleases').doc('h2').set(releaseDoc('RR-2', 'inv1', 70, 7))
    // Paid 990 + 154 = 1,144.00: every cent of both releases has been paid out.
    await col('supplierPayments').doc('hp').set(paymentDoc('SP-1', [{ supplierInvoiceId: 'inv1', allocatedAmount: 1144 }]))
    await ensure()
    await expectTeamError(voidOp('u_pm', 'voidRelease', 'h2'), 'supplier-finance-dependency')
    expect(await ledger('inv1')).toMatchObject({ state: 'inconsistent', releasedRetentionCents: 14000, paidCents: 114400 })
    expect((await data(col('retentionReleases').doc('h2'))).status).toBe('posted')
  })

  it('A MALFORMED HISTORICAL ENTRY keeps the ledger inconsistent until THAT entry is voided — an unrelated void does not restore it', async () => {
    await col('supplierInvoices').doc('inv1').set(invoiceDoc(1))
    await col('retentionReleases').doc('ok').set(releaseDoc('RR-OK', 'inv1', 10, 1))
    await col('retentionReleases').doc('bad').set(releaseDoc('RR-BAD', 'inv1', 0, 0)) // a release of nothing
    await ensure()
    expect(await ledger('inv1')).toMatchObject({ state: 'inconsistent', malformedEntryIds: ['bad'] })
    await voidOp('u_pm', 'voidRelease', 'ok')
    expect(await ledger('inv1')).toMatchObject({ state: 'inconsistent', malformedEntryIds: ['bad'], releasedRetentionCents: 0 })
    await voidOp('u_pm', 'voidRelease', 'bad')
    expect(await ledger('inv1')).toMatchObject({ state: 'established', problem: null, malformedEntryIds: [], releasedRetentionCents: 0, releasedRetentionGstCents: 0 })
  })

  it('A NEGATIVE HISTORICAL FIGURE: a void that would leave the ledger negative is refused; voiding the malformed entry itself is the correction', async () => {
    await col('supplierInvoices').doc('inv1').set(invoiceDoc(1))
    await col('retentionReleases').doc('ok').set(releaseDoc('RR-OK', 'inv1', 10, 1))
    await col('retentionReleases').doc('bad').set(releaseDoc('RR-BAD', 'inv1', 20, -2))
    await ensure()
    // ORACLE: GST 1 + (−2) = −1 cent... in cents: 100 − 200 = −100.
    expect(await ledger('inv1')).toMatchObject({ state: 'inconsistent', releasedRetentionCents: 3000, releasedRetentionGstCents: -100, malformedEntryIds: ['bad'] })
    await expectTeamError(voidOp('u_pm', 'voidRelease', 'ok'), 'supplier-finance-dependency') // would leave −200
    await voidOp('u_pm', 'voidRelease', 'bad')
    expect(await ledger('inv1')).toMatchObject({ state: 'established', releasedRetentionCents: 1000, releasedRetentionGstCents: 100, malformedEntryIds: [] })
  })

  it('NO SUPPORTED CORRECTION → FAILS CLOSED: an invoice that does not reconcile with itself stays inconsistent; its entries cannot be voided through the ledger; tenant and role restrictions hold', async () => {
    await col('supplierInvoices').doc('inv1').set({ ...invoiceDoc(1), payableTotal: 1000 })
    await col('retentionReleases').doc('h1').set(releaseDoc('RR-1', 'inv1', 10, 1))
    await ensure()
    expect((await ledger('inv1')).state).toBe('inconsistent')
    await expectTeamError(voidOp('u_pm', 'voidRelease', 'h1'), 'supplier-finance-invalid')
    expect((await ledger('inv1')).state).toBe('inconsistent')
    await seedUser({ uid: 'u_sub', email: 'sub@a.test', role: 'subcontractor', companyId: COMPANY_A })
    await expectTeamError(voidOp('u_sub', 'voidRelease', 'h1'), 'supplier-finance-forbidden')
  })

  it('A LEGACY PAYMENT NAMING ONE INVOICE TWICE is voided cumulatively (300 + 200 → paid falls by 500, not 200)', async () => {
    await col('supplierInvoices').doc('inv1').set(invoiceDoc(1))
    await col('supplierPayments').doc('hp').set({ ...paymentDoc('SP-1', [{ supplierInvoiceId: 'inv1', allocatedAmount: 300 }, { supplierInvoiceId: 'inv1', allocatedAmount: 200 }]), revision: 2 })
    await ensure()
    expect((await ledger('inv1')).paidCents).toBe(50000)
    await voidOp('u_pm', 'voidPayment', 'hp')
    expect((await ledger('inv1')).paidCents).toBe(0)
  })
})
