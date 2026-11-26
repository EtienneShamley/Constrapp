#!/usr/bin/env node
// -- Client receipt cutover inventory (ADR-89, final integration safeguards) --
//
// READ-ONLY. Sends only POST .../documents:runQuery (collection-group reads) to
// the Firestore REST API, authenticated as the operator through
// `gcloud auth print-access-token`. It never writes. It prints AGGREGATES only:
// counts, statuses, and the NAMES of fields; never a value, a name, a number
// or an amount from any document.
//
// Purpose: before trusted receipt processing is enabled (DEPLOYMENT.md,
// Commercial Finance Phase 1 cutover), record what the historical-receipt
// baseline must account for; afterwards, compare the per-project baseline
// markers with it.
//
// Usage:  node ops/cutover/client-receipt-inventory.mjs --project <projectId>
//
// --project has NO default on purpose.
import { execFileSync } from 'node:child_process'
const at = process.argv.indexOf('--project')
const PROJECT = at > -1 ? process.argv[at + 1] : null
if (!PROJECT || PROJECT.startsWith('--') || process.argv.length !== 4) {
  console.error('usage: client-receipt-inventory.mjs --project <projectId>')
  process.exit(2)
}
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`
async function group(id, fields) {
  const out = []; let cursor = null
  for (;;) {
    const sq = { from: [{ collectionId: id, allDescendants: true }], orderBy: [{ field: { fieldPath: '__name__' } }], limit: 500 }
    if (fields) sq.select = { fields: fields.map(f => ({ fieldPath: f })) }
    if (cursor) sq.startAt = { values: [{ referenceValue: cursor }], before: false }
    const r = await fetch(`${base}:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: sq }) })
    if (!r.ok) throw new Error(`${id}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
    const rows = (await r.json()).filter(x => x.document)
    for (const x of rows) out.push(x.document)
    if (rows.length < 500) break
    cursor = rows[rows.length - 1].document.name
  }
  return out
}
const num = v => v == null ? null : ('integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : null)
const str = v => v?.stringValue ?? null
const company = name => name.split('/documents/')[1].split('/')[1]
const tally = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
const show = m => Object.fromEntries([...m.entries()].sort())

const companies = await group('companies', ['clientFinanceEnabled', 'clientReceiptsEnabled'])
const tag = new Map(companies.filter(d => d.name.split('/documents/')[1].split('/').length === 2)
  .map(d => [d.name.split('/').pop(), [d.fields?.clientReceiptsEnabled?.booleanValue === true ? 'receipts-activated' : null, d.fields?.clientFinanceEnabled?.booleanValue === true ? 'finance-activated' : null].filter(Boolean).join('+') || 'not-activated']))
const label = id => `${id.slice(0, 4)}...(${tag.get(id) ?? 'unknown'})`

// full docs for receipts (need key shapes); values never printed
const receipts = await group('clientReceipts', null)
const invoices = await group('clientInvoices', ['status', 'retention', 'retentionGst', 'docType', 'currency'])
const ledgers = await group('clientInvoiceLedgers', ['seq'])
const ccn = await group('clientCreditNotes', ['status'])
const crr = await group('clientRetentionReleases', ['status'])
const markers = (await group('clientFinanceState', ['version', 'legacyPostedReceipts', 'legacyAllocations', 'invoices', 'legacyCents']))
  .filter(d => d.name.endsWith('/receiptBaseline'))
const sum = key => markers.reduce((n, d) => n + (num(d.fields?.[key]) ?? 0), 0)

const R = { total: receipts.length, byStatus: new Map(), byCompanyStatus: new Map(), shapes: new Map(), allocShapes: new Map(), docTypes: new Map(),
  postedAllocations: 0, allAllocations: 0, postedWithAllocatedInvoiceIds: 0, postedNoAllocations: 0, maxAllocationsOnOne: 0, amountTypes: new Map(), nonCentAmounts: 0 }
const histInvoices = new Set(); const histByCompany = new Map(); const overCheck = new Map()
for (const d of receipts) {
  const f = d.fields ?? {}; const st = str(f.status) ?? '(none)'
  tally(R.byStatus, st); tally(R.byCompanyStatus, `${label(company(d.name))} ${st}`)
  tally(R.shapes, `${st}: ${Object.keys(f).sort().join(',')}`); tally(R.docTypes, str(f.docType) ?? '(none)')
  const allocs = f.allocations?.arrayValue?.values ?? []
  R.allAllocations += allocs.length; R.maxAllocationsOnOne = Math.max(R.maxAllocationsOnOne, allocs.length)
  tally(R.amountTypes, Object.keys(f.amount ?? { none: 1 })[0])
  for (const a of allocs) {
    const af = a.mapValue?.fields ?? {}
    tally(R.allocShapes, `${Object.keys(af).sort().join(',')} [amount:${Object.keys(af.allocatedAmount ?? { none: 1 })[0]}]`)
    const amt = num(af.allocatedAmount); if (amt == null || Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) R.nonCentAmounts += 1
    if (st === 'posted') { R.postedAllocations += 1; const id = str(af.clientInvoiceId); const key = d.name.split('/clientReceipts/')[0] + '|' + id; histInvoices.add(key); tally(histByCompany, label(company(d.name))); overCheck.set(key, (overCheck.get(key) ?? 0) + Math.round((amt ?? 0) * 100)) }
  }
  if (st === 'posted') { if (f.allocatedInvoiceIds) R.postedWithAllocatedInvoiceIds += 1; if (allocs.length === 0) R.postedNoAllocations += 1 }
}
const I = { total: invoices.length, byStatus: new Map(), byCompanyStatus: new Map(), retained: 0, retainedByStatus: new Map(), withRetentionField: 0, docTypes: new Map(), currencies: new Map() }
const invIndex = new Map()
for (const d of invoices) {
  const f = d.fields ?? {}; const st = str(f.status) ?? '(none)'
  tally(I.byStatus, st); tally(I.byCompanyStatus, `${label(company(d.name))} ${st}`); tally(I.docTypes, str(f.docType) ?? '(none)'); tally(I.currencies, str(f.currency) ?? '(none)')
  if ('retention' in f) I.withRetentionField += 1
  if ((num(f.retention) ?? 0) > 0) { I.retained += 1; tally(I.retainedByStatus, st) }
  invIndex.set(d.name.split('/clientInvoices/')[0] + '|' + d.name.split('/').pop(), st)
}
const histStatus = new Map(); let dangling = 0
for (const k of histInvoices) { const st = invIndex.get(k); if (!st) dangling += 1; tally(histStatus, st ?? '(invoice missing)') }
console.log(JSON.stringify({
  readAt: new Date().toISOString(), project: PROJECT,
  companies: tag.size, companiesByActivation: show([...tag.values()].reduce((m, v) => (tally(m, v), m), new Map())),
  clientInvoices: { total: I.total, byStatus: show(I.byStatus), byCompanyStatus: show(I.byCompanyStatus), withRetentionField: I.withRetentionField, retainedGreaterThanZero: I.retained, retainedByStatus: show(I.retainedByStatus), docTypes: show(I.docTypes), currencies: show(I.currencies) },
  clientReceipts: { total: R.total, byStatus: show(R.byStatus), byCompanyStatus: show(R.byCompanyStatus), docTypes: show(R.docTypes), allocationsAllStatuses: R.allAllocations, allocationsOnPosted: R.postedAllocations, postedAllocationsByCompany: show(histByCompany), postedWithNoAllocations: R.postedNoAllocations, postedCarryingAllocatedInvoiceIds: R.postedWithAllocatedInvoiceIds, maxAllocationsOnOneReceipt: R.maxAllocationsOnOne, amountValueTypes: show(R.amountTypes), allocationAmountsNotWholeCents: R.nonCentAmounts },
  invoicesWithPostedAllocations: { distinct: histInvoices.size, byInvoiceStatus: show(histStatus), referencingMissingInvoice: dangling },
  receiptFieldShapes: show(R.shapes), allocationFieldShapes: show(R.allocShapes),
  clientInvoiceLedgers: ledgers.length, clientCreditNotes: ccn.length, clientRetentionReleases: crr.length,
  receiptBaselineMarkers: { total: markers.length, legacyPostedReceipts: sum('legacyPostedReceipts'), legacyAllocations: sum('legacyAllocations'), invoices: sum('invoices') },
}, null, 1))
