#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT-ONLY emulator seed — local browser acceptance of trusted
// variations (ADR-90 / ADR-91; TESTING.md §84).
//
// Run AFTER `npm run test:team` has the Auth, Firestore and Functions emulators
// and Vite up, from frontend/:
//
//     node scripts/seed-variations-emulator.mjs
//
// It starts ITSELF in the isolated emulator environment
// (scripts/emulatorIsolation.mjs): no credential file, no CLI sign-in, the demo
// project, loopback emulator hosts — and refuses anything else. It writes a
// synthetic company with four users, one project, cost codes, contacts,
// purchase orders, RFIs and a set of LEGACY variations (as the application
// stored them before ADR-90, some legitimate and some forged) so every path of
// the acceptance can be exercised in the browser. Idempotent: deterministic
// ids. Nothing here is imported by application code.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { prepareIsolation, TEST_PROJECT_ID, ISOLATION_MARKER } from './emulatorIsolation.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const HOST = '127.0.0.1'

// Re-run inside the isolated environment, pointed at the local emulators.
if (process.env[ISOLATION_MARKER] !== '1' || !process.env.FIRESTORE_EMULATOR_HOST) {
  const emu = JSON.parse(readFileSync(resolve(FRONTEND, 'firebase.json'), 'utf8')).emulators
  const { env } = prepareIsolation()
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...env, GCLOUD_PROJECT: TEST_PROJECT_ID, FIRESTORE_EMULATOR_HOST: `${HOST}:${emu.firestore.port}`, FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${emu.auth.port}` },
  })
  process.exit(child.status ?? 1)
}

for (const name of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!String(process.env[name] ?? '').startsWith(`${HOST}:`)) { console.error(`✖ ${name} is not a loopback emulator address — refusing.`); process.exit(1) }
}
if (process.env.GCLOUD_PROJECT !== TEST_PROJECT_ID) { console.error('✖ Not the demo project — refusing.'); process.exit(1) }
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) { console.error('✖ GOOGLE_APPLICATION_CREDENTIALS is set — refusing.'); process.exit(1) }

const require = createRequire(resolve(FRONTEND, 'functions/package.json'))
const { initializeApp } = require('firebase-admin/app')
const { getFirestore, Timestamp } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')

initializeApp({ projectId: TEST_PROJECT_ID })
const db = getFirestore()
const auth = getAuth()

export const ACCEPTANCE = {
  companyId: 'acceptance-co',
  projectId: 'varProject',
  password: 'Acceptance-pass-1',
  users: [
    { uid: 'acc_admin', email: 'admin@acceptance.test', role: 'company_admin',   name: 'Ada Admin' },
    { uid: 'acc_pm',    email: 'pm@acceptance.test',    role: 'project_manager', name: 'Pat Manager' },
    { uid: 'acc_pm2',   email: 'pm2@acceptance.test',   role: 'project_manager', name: 'Pip Manager' },
    { uid: 'acc_qs',    email: 'qs@acceptance.test',    role: 'qs',              name: 'Quinn Surveyor' },
    { uid: 'acc_sub',   email: 'sub@acceptance.test',   role: 'subcontractor',   name: 'Sam Subcontractor' },
  ],
}

const now = Timestamp.now()
const at = (iso) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`))
const C = ACCEPTANCE.companyId
const P = ACCEPTANCE.projectId
const company = db.collection('companies').doc(C)
const project = company.collection('projects').doc(P)
const UID = 'acc_qs'

const costCode = (code, name, category, unit) => ({ code, name, category, unit, isActive: true, createdAt: now, createdBy: UID })
const contact = (displayName, contactTypes) => ({
  entityType: 'organisation', contactTypes, legalName: displayName, tradingName: displayName, firstName: '', lastName: '',
  displayName, nameLower: displayName.toLowerCase(), abn: '', country: 'AU', email: '', phone: '',
  address: { street: '', suburb: '', state: '', postcode: '' }, trades: [], paymentTerms: { days: 30, basis: 'invoice' },
  gstStatus: 'registered', notes: 'Seeded for emulator acceptance.', people: [], primaryPersonId: null,
  projectAssignments: [{ projectId: P, projectName: 'Variation Acceptance Project' }], projectIds: [P],
  isActive: true, externalRefs: {}, createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
})
const PO_LINES = [
  { costCodeId: 'ccConcrete', costCodeName: '03-100 — Concrete', description: 'Slab pour', qty: 10, unit: 'm3', unitPrice: 250, lineTotal: 2500 },
  { costCodeId: 'ccSteel', costCodeName: '05-100 — Structural steel', description: 'Reinforcement', qty: 1, unit: 'item', unitPrice: 900, lineTotal: 900 },
]
const po = (poNumber, status) => ({
  poNumber, status, supplierId: 'steelCo', supplierName: 'Steel Co Pty Ltd', description: 'Structure package',
  lineItems: PO_LINES, subtotal: 3400, gst: 340, total: 3740, currency: 'AUD', revision: 1, notes: '',
  sentAt: status === 'draft' ? null : now, closedAt: null, cancelledAt: status === 'cancelled' ? now : null,
  externalRefs: {}, createdAt: now, createdBy: UID,
})
const rfi = (rfiNumber, title, status) => ({
  rfiNumber, title, status, question: 'Seeded question.', raisedByName: 'Quinn Surveyor', assignedToContactId: 'steelCo', assignedToName: 'Steel Co Pty Ltd',
  dueDate: '2026-12-01', raisedDate: status === 'draft' ? '' : '2026-11-01', createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
})

// A LEGACY variation, exactly as the application stored one before ADR-90 /
// ADR-91: no `calcVersion`; GST from the legacy expression (40.15 → 4.01).
const legacyLine = (o = {}) => ({
  costCodeId: 'ccSteel', costCodeName: '05-100 — Structural steel', description: 'Bolts',
  submittedAmount: 40.15, submittedGst: 4.01, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst', ...o,
})
const legacy = (o = {}) => ({
  variationType: 'supplier', status: 'draft', title: 'Legacy variation', description: '', reason: '',
  clientId: null, clientName: null, clientRef: null,
  supplierId: 'steelCo', supplierName: 'Steel Co Pty Ltd', supplierRef: '', poId: null, poNumber: null,
  originRfiId: null, originRfiNumber: null, originRfiTitle: null,
  lineItems: [legacyLine()], submittedSubtotal: 40.15, submittedGst: 4.01, submittedTotal: 44.16,
  approvedSubtotal: null, approvedGst: null, approvedTotal: null, forecastAmount: null,
  identifiedDate: '2026-09-01', submittedDate: '', responseDueDate: '', approvedDate: '', effectiveDate: '',
  currency: 'AUD', revision: 1, notes: '', assessmentNotes: '',
  submittedAt: null, submittedBy: null, approvedAt: null, approvedBy: null, rejectedAt: null, rejectedBy: null, withdrawnAt: null, withdrawnBy: null,
  attachments: [], externalRefs: {}, supersededByVariationId: null,
  createdAt: at('2026-09-01'), createdBy: UID, updatedAt: at('2026-09-01'), updatedBy: UID,
  ...o,
})
const submittedStamps = { status: 'submitted', revision: 2, submittedDate: '2026-09-02', submittedAt: at('2026-09-02'), submittedBy: UID, updatedAt: at('2026-09-02') }

const boqItem = (costCodeId, costCodeName, itemNumber, description, unit, quantity, rate) => ({
  status: 'active', costCodeId, costCodeName, description, itemNumber, section: '', unit,
  quantity, rate, amount: Math.round(quantity * rate * 100) / 100, currency: 'AUD', revision: 1, notes: '',
  createdAt: at('2026-09-01'), createdBy: UID, updatedAt: at('2026-09-01'), updatedBy: UID,
})
const clientInvoice = (invoiceNumber, subtotal) => {
  const gst = Math.round(subtotal * 10) / 100
  return {
    invoiceNumber, status: 'issued', clientId: 'clientPty', clientName: 'Client Pty Ltd', currency: 'AUD',
    invoiceDate: '2026-11-01', dueDate: '2026-12-01', raisedDate: '2026-11-01', notes: '',
    lineItems: [{ description: 'Progress to date', amount: subtotal, taxCode: 'gst', gstAmount: gst, variationId: null }],
    subtotal, gstTotal: gst, grossTotal: subtotal + gst, retention: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: subtotal + gst,
    revision: 2, createdAt: at('2026-11-01'), createdBy: UID, updatedAt: at('2026-11-01'), updatedBy: UID,
  }
}

const DOCS = [
  // clientFinanceEnabled / clientReceiptsEnabled: the per-company activation flags the client-finance
  // callables read (ADR-89), so client credit notes, receipts, refunds and applications can be exercised.
  [company, { name: 'Acceptance Builders (emulator)', countryCode: 'AU', baseCurrency: 'AUD', currencyUpdatedAt: now, currencyUpdatedBy: 'acc_admin', clientFinanceEnabled: true, clientReceiptsEnabled: true }],
  [project, { name: 'Variation Acceptance Project', status: 'In Progress', budget: 250000, startDate: at('2026-07-01'), location: 'Brisbane, QLD', progress: 20, currency: 'AUD', currencyLocked: true, createdAt: now, createdBy: 'acc_admin' }],
  [company.collection('projectDirectory').doc(P), { name: 'Variation Acceptance Project', status: 'In Progress', location: 'Brisbane, QLD', startDate: at('2026-07-01'), progress: 20 }],
  [company.collection('costCodes').doc('ccConcrete'), costCode('03-100', 'Concrete', 'Structure', 'm3')],
  [company.collection('costCodes').doc('ccSteel'), costCode('05-100', 'Structural steel', 'Structure', 't')],
  [company.collection('costCodes').doc('ccPrelims'), costCode('01-000', 'Preliminaries', 'Preliminaries', 'item')],
  [company.collection('contacts').doc('steelCo'), contact('Steel Co Pty Ltd', ['subcontractor'])],
  [company.collection('contacts').doc('clientPty'), contact('Client Pty Ltd', ['client'])],
  [project.collection('budgetLines').doc('blConcrete'), { costCodeId: 'ccConcrete', costCodeName: '03-100 — Concrete', budgeted: 12000, notes: '', createdAt: now, createdBy: UID }],
  [project.collection('budgetLines').doc('blSteel'), { costCodeId: 'ccSteel', costCodeName: '05-100 — Structural steel', budgeted: 8000, notes: '', createdAt: now, createdBy: UID }],
  [project.collection('purchaseOrders').doc('poSent'), po('PO-0001', 'sent')],
  // Phase 2 final batch — estimating (ADR-97) and client settlement (ADR-95) acceptance.
  // BOQ: 03-100 10 m3 × 117.75 = 1,177.50 · 3 m3 × 333.33 = 999.99 · 05-100 2 t × 4,250.00 = 8,500.00 · 01-000 1 × 5,000.00.
  [project.collection('boqItems').doc('boqA1'), boqItem('ccConcrete', '03-100 — Concrete', '1.1', 'Slab on ground', 'm3', 10, 117.75)],
  [project.collection('boqItems').doc('boqA2'), boqItem('ccConcrete', '03-100 — Concrete', '1.2', 'Footings', 'm3', 3, 333.33)],
  [project.collection('boqItems').doc('boqS1'), boqItem('ccSteel', '05-100 — Structural steel', '2.1', 'Portal frames', 't', 2, 4250)],
  [project.collection('boqItems').doc('boqP1'), boqItem('ccPrelims', '01-000 — Preliminaries', 'P.1', 'Site establishment', 'item', 1, 5000)],
  // Two issued client invoices (literal totals): 1,000.00 + 100.00 = 1,100.00 and 500.00 + 50.00 = 550.00.
  [project.collection('clientInvoices').doc('ciOne'), clientInvoice('CI-0001', 1000)],
  [project.collection('clientInvoices').doc('ciTwo'), clientInvoice('CI-0002', 500)],
  [project.collection('purchaseOrders').doc('poCancelled'), po('PO-0002', 'cancelled')],
  [project.collection('rfis').doc('rfiOpen'), rfi('RFI-0001', 'Revised steel connection', 'open')],
  [project.collection('rfis').doc('rfiDraft'), rfi('RFI-0002', 'Not yet asked', 'draft')],

  // A · legitimate legacy DRAFT (40.15 → 4.01): editing it shows the upgrade notice.
  [project.collection('variations').doc('legacyDraft'), legacy({ variationNumber: 'SV-0901', title: 'Legacy draft — bolts' })],
  // B · legitimate legacy SUBMITTED: approved under the legacy calculation.
  [project.collection('variations').doc('legacySubmitted'), legacy({ variationNumber: 'SV-0902', title: 'Legacy submitted — bolts', ...submittedStamps })],
  // C · FORGED legacy submitted: a header that satisfied the old Rules but is not the sum of its lines.
  [project.collection('variations').doc('legacyForgedHeader'), legacy({ variationNumber: 'SV-0903', title: 'Legacy submitted — FORGED header', ...submittedStamps, submittedSubtotal: 5000, submittedGst: 500, submittedTotal: 5500 })],
  // D · FORGED legacy submitted: a line on a cost code that does not exist.
  [project.collection('variations').doc('legacyForgedCostCode'), legacy({ variationNumber: 'SV-0904', title: 'Legacy submitted — FORGED cost code', ...submittedStamps, lineItems: [legacyLine({ costCodeId: 'ghostCode', costCodeName: '99-999 — Ghost' })] })],
  // E · legitimate legacy APPROVED, PO-linked, never applied: the legacy Apply.
  [project.collection('variations').doc('legacyApproved'), legacy({
    variationNumber: 'SV-0905', title: 'Legacy approved — awaiting Apply', ...submittedStamps, status: 'approved', revision: 3,
    poId: 'poSent', poNumber: 'PO-0001',
    lineItems: [
      { costCodeId: 'ccConcrete', costCodeName: '03-100 — Concrete', description: 'Thicker slab', submittedAmount: 40.15, submittedGst: 4.01, approvedAmount: 40.15, approvedGst: 4.01, poLineIndex: 0, taxCode: 'gst' },
      { costCodeId: 'ccPrelims', costCodeName: '01-000 — Preliminaries', description: 'Extra supervision', submittedAmount: 250, submittedGst: 25, approvedAmount: 250, approvedGst: 25, poLineIndex: null, taxCode: 'gst' },
    ],
    submittedSubtotal: 290.15, submittedGst: 29.01, submittedTotal: 319.16, approvedSubtotal: 290.15, approvedGst: 29.01, approvedTotal: 319.16,
    approvedAt: at('2026-09-05'), approvedBy: 'acc_pm', approvedDate: '2026-09-05', effectiveDate: '2026-09-05', updatedAt: at('2026-09-05'), updatedBy: 'acc_pm',
  })],
]

for (const u of ACCEPTANCE.users) {
  try { await auth.deleteUser(u.uid) } catch { /* not there yet */ }
  await auth.createUser({ uid: u.uid, email: u.email, password: ACCEPTANCE.password, displayName: u.name, emailVerified: true })
  await db.collection('users').doc(u.uid).set({
    name: u.name, email: u.email, role: u.role, companyId: C, status: 'active', joinedAt: at('2026-01-01'),
    ...(u.role === 'subcontractor' ? { projectIds: [P] } : {}),
  })
}
for (const [ref, data] of DOCS) await ref.set(data)

// Final release batch — controlled company activation (ADR-98). The acceptance
// company is ACTIVE unless `--inactive` is given; a SECOND synthetic company
// ("Dormant Builders", one project, one PM) is always INACTIVE, to show the
// maintenance restriction beside an active company.
const ACTIVE = !process.argv.includes('--inactive')
await company.set({ commercialCompletionEnabled: ACTIVE }, { merge: true })
const DORMANT = { companyId: 'dormant-co', projectId: 'dormantProject', uid: 'dor_pm', email: 'pm@dormant.test', name: 'Dee Dormant' }
const dormant = db.collection('companies').doc(DORMANT.companyId)
await dormant.set({ name: 'Dormant Builders (emulator)', countryCode: 'AU', baseCurrency: 'AUD', clientFinanceEnabled: true, clientReceiptsEnabled: true, commercialCompletionEnabled: false })
await dormant.collection('projects').doc(DORMANT.projectId).set({ name: 'Dormant Project', status: 'In Progress', budget: 100000, location: 'Perth, WA', currency: 'AUD', createdAt: now, createdBy: DORMANT.uid })
await dormant.collection('projectDirectory').doc(DORMANT.projectId).set({ name: 'Dormant Project', status: 'In Progress', location: 'Perth, WA' })
await dormant.collection('contacts').doc('steelCo').set({ displayName: 'Steel Co Pty Ltd', legalName: 'Steel Co Pty Ltd', types: ['subcontractor'], isActive: true, paymentTerms: { days: 30, basis: 'invoice' }, createdAt: now, createdBy: DORMANT.uid })
await dormant.collection('projects').doc(DORMANT.projectId).collection('purchaseOrders').doc('poDormant').set(po('PO-0001', 'sent'))
try { await auth.deleteUser(DORMANT.uid) } catch { /* not there yet */ }
await auth.createUser({ uid: DORMANT.uid, email: DORMANT.email, password: ACCEPTANCE.password, displayName: DORMANT.name, emailVerified: true })
await db.collection('users').doc(DORMANT.uid).set({ name: DORMANT.name, email: DORMANT.email, role: 'project_manager', companyId: DORMANT.companyId, status: 'active', joinedAt: at('2026-01-01') })

console.log(`\n✔ Seeded ${DOCS.length} documents and ${ACCEPTANCE.users.length} users into the emulators (project ${TEST_PROJECT_ID}).`)
console.log(`  Company ${C} · project ${P} · Phase 2 ${ACTIVE ? 'ACTIVE' : 'INACTIVE'} · second company dormant-co (INACTIVE): pm@dormant.test`)
for (const u of ACCEPTANCE.users) console.log(`  ${u.role.padEnd(16)} ${u.email}   password: ${ACCEPTANCE.password}`)
console.log('  (Synthetic accounts in the Auth EMULATOR only. They exist nowhere else.)\n')
