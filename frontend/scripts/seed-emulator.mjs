// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT-ONLY Firestore emulator seed — manual Credit Notes testing.
//
// Seeds a minimal, VALID dataset so Constrapp opens against the LOCAL emulator
// and the Supplier Credit Notes flow (docs/TESTING.md §15r) can be exercised by
// hand. It writes NOTHING to production and structurally cannot: see the safety
// gates below.
//
// It uses `@firebase/rules-unit-testing`, already a devDependency and already
// the seeding mechanism used by frontend/tests/rules/*.test.js. No new package
// is required. Rules are bypassed for the write (`withSecurityRulesDisabled`),
// which is NOT optional: `users/{uid}` is client-read-only (ADR-27,
// `allow create: if false`), so no client-SDK path can create a membership doc.
//
// Idempotent: every document has a deterministic id, so re-running overwrites
// rather than duplicating. Nothing here is imported by application code.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, Timestamp } from 'firebase/firestore'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')

// ── The identity this seed is built for ──────────────────────────────────────
const UID        = 'igCEJR3XzdTd5JEIJSC5QyP5eBB3'
const COMPANY_ID = '2Vf3CVuYE8wWzg8hLjR5'
const ROLE       = 'company_admin'

// Deterministic ids so re-running is an upsert, never a duplicate.
const PROJECT_ID   = 'seedProjectCreditNotes'
const SUPPLIER_ID  = 'seedSupplierBuildCo'
const CC_CONCRETE  = 'seedCostCodeConcrete'
const CC_FORMWORK  = 'seedCostCodeFormwork'
const PO_ID        = 'seedPo0001'
const INV_OPEN_ID  = 'seedInvoiceSI0001'   // creditable  — zero retention
const INV_RETAIN_ID = 'seedInvoiceSI0002'  // NOT creditable — retention withheld

// ── SAFETY GATE 1: emulator host must be set ─────────────────────────────────
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST
if (!EMULATOR_HOST) {
  console.error(
    '\n✖ REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set.\n\n' +
    '  This script seeds throwaway data and must never reach a real project.\n' +
    '  Start the emulator, then run with the host set — see the header of this file.\n',
  )
  process.exit(1)
}

// ── SAFETY GATE 2: that host must be loopback ────────────────────────────────
// FIRESTORE_EMULATOR_HOST could in principle name any host. Only loopback is
// accepted, so even a mis-set variable cannot point this at a remote database.
const [HOST, PORT_RAW] = EMULATOR_HOST.split(':')
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]']
if (!LOOPBACK.includes(HOST)) {
  console.error(
    `\n✖ REFUSING TO RUN: FIRESTORE_EMULATOR_HOST points at "${HOST}", which is not loopback.\n` +
    `  Expected one of: ${LOOPBACK.join(', ')}\n`,
  )
  process.exit(1)
}
const PORT = Number(PORT_RAW)
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`\n✖ REFUSING TO RUN: could not read a port from "${EMULATOR_HOST}".\n`)
  process.exit(1)
}

// ── SAFETY GATE 3: refuse if production service-account credentials are present ──
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    '\n✖ REFUSING TO RUN: GOOGLE_APPLICATION_CREDENTIALS is set.\n' +
    '  This script never needs real credentials. Unset it and re-run.\n',
  )
  process.exit(1)
}

// ── Project id must match the one the app connects with ──────────────────────
// The Firestore emulator namespaces data BY PROJECT ID. The app resolves its id
// from VITE_FIREBASE_PROJECT_ID, so seeding under any other id would write data
// the app cannot see. Read it from .env.local rather than hardcoding it.
function resolveProjectId() {
  if (process.env.SEED_PROJECT_ID) return process.env.SEED_PROJECT_ID
  for (const file of ['.env.local', '.env']) {
    try {
      const match = readFileSync(resolve(FRONTEND, file), 'utf8')
        .match(/^\s*VITE_FIREBASE_PROJECT_ID\s*=\s*(.+)\s*$/m)
      if (match) return match[1].trim().replace(/^["']|["']$/g, '')
    } catch { /* file absent — try the next one */ }
  }
  return null
}
const GCP_PROJECT_ID = resolveProjectId()
if (!GCP_PROJECT_ID) {
  console.error(
    '\n✖ REFUSING TO RUN: could not determine the Firebase project id.\n' +
    '  Set VITE_FIREBASE_PROJECT_ID in frontend/.env.local (the app reads the same value),\n' +
    '  or pass SEED_PROJECT_ID=<id> to this script.\n',
  )
  process.exit(1)
}

// ── Money ────────────────────────────────────────────────────────────────────
// Mirrors lib/supplierInvoices.js → invoiceTotals(). Australian GST, flat 10%.
//
// SI-0001 — CREDITABLE: posted, ZERO retention, two cost-coded GST lines.
//   6,000 + 4,000 ex-GST → GST 1,000 → gross 11,000 → payable 11,000
// SI-0002 — BLOCKED:     posted WITH retention, so credit notes must refuse it.
//   5,000 ex-GST → GST 500 → gross 5,500
//   retention 250 (+25 GST) = 275 withheld → payable 5,225

const now = Timestamp.now()
const stamp = (isoDate) => Timestamp.fromDate(new Date(`${isoDate}T00:00:00Z`))

const invoiceOpenLines = [
  { poLineIndex: 0, costCodeId: CC_CONCRETE, costCodeName: '03-100 — Concrete',
    description: 'Slab pour — level 1', amount: 6000, taxCode: 'gst', gstAmount: 600 },
  { poLineIndex: 1, costCodeId: CC_FORMWORK, costCodeName: '03-200 — Formwork',
    description: 'Formwork — level 1',  amount: 4000, taxCode: 'gst', gstAmount: 400 },
]
const invoiceRetainedLines = [
  { poLineIndex: 0, costCodeId: CC_CONCRETE, costCodeName: '03-100 — Concrete',
    description: 'Slab pour — level 2', amount: 5000, taxCode: 'gst', gstAmount: 500 },
]

const supplierSnapshot = { supplierId: SUPPLIER_ID, supplierName: 'BuildCo Concreting Pty Ltd' }

const invoiceBase = {
  docType: 'invoice',
  source: 'direct_po',
  ...supplierSnapshot,
  poId: PO_ID,
  poNumber: 'PO-0001',
  progressClaimId: null,
  claimNumber: null,
  receivedDate: '2026-08-02',
  paymentTerms: { days: 30, basis: 'invoice' },
  currency: 'AUD',
  revision: 1,
  approvedAt: now,
  approvedBy: UID,
  postedAt: now,
  postedBy: UID,
  cancelledAt: null,
  // DEPRECATED IN PLACE (ADR-24) — written once as null, never updated.
  paidAt: null,
  // SUPERSEDED by the supplierCreditNotes collection (ADR-31); stays null.
  adjustsInvoiceId: null,
  attachments: [],
  externalRefs: {},
  createdAt: now,
  createdBy: UID,
}

// ── Documents ────────────────────────────────────────────────────────────────
const DOCS = [
  // Membership — the document every rules block get()s to authorise a request.
  [`users/${UID}`, {
    name: 'Etienne Shamley (emulator seed)',
    email: 'etienneshamley@gmail.com',
    role: ROLE,
    companyId: COMPANY_ID,
    avatarInitials: 'ES',
  }],

  [`companies/${COMPANY_ID}`, {
    name: 'Constrapp Demo Construction',
    countryCode: 'AU',
    baseCurrency: 'AUD',
    currencyUpdatedAt: now,
    currencyUpdatedBy: UID,
  }],

  [`companies/${COMPANY_ID}/projects/${PROJECT_ID}`, {
    name: 'Credit Notes Test Project',
    status: 'In Progress',
    budget: 250000,
    startDate: stamp('2026-07-01'),
    location: 'Brisbane, QLD',
    progress: 35,
    currency: 'AUD',
    // Already holds monetary data, so the ratchet is engaged from the start.
    currencyLocked: true,
    createdAt: now,
    createdBy: UID,
  }],

  [`companies/${COMPANY_ID}/costCodes/${CC_CONCRETE}`, {
    code: '03-100', name: 'Concrete', category: 'Structure', unit: 'm3',
    isActive: true, createdAt: now, createdBy: UID,
  }],
  [`companies/${COMPANY_ID}/costCodes/${CC_FORMWORK}`, {
    code: '03-200', name: 'Formwork', category: 'Structure', unit: 'm2',
    isActive: true, createdAt: now, createdBy: UID,
  }],

  // Supplier contact — the shape hooks/useContacts.jsx writes. `displayName`
  // and `contactTypes` are what the PO/payment supplier pickers filter on.
  [`companies/${COMPANY_ID}/contacts/${SUPPLIER_ID}`, {
    entityType: 'organisation',
    contactTypes: ['subcontractor'],
    legalName: 'BuildCo Concreting Pty Ltd',
    tradingName: 'BuildCo Concreting',
    firstName: '', lastName: '',
    displayName: 'BuildCo Concreting Pty Ltd',
    nameLower: 'buildco concreting pty ltd',
    abn: '51824753556',
    country: 'AU',
    email: 'accounts@buildco.example',
    phone: '0730000000',
    address: { street: '12 Trade Way', suburb: 'Rocklea', state: 'QLD', postcode: '4106' },
    trades: ['Concreting'],
    paymentTerms: { days: 30, basis: 'invoice' },
    gstStatus: 'registered',
    notes: 'Seeded for emulator testing.',
    people: [],
    primaryPersonId: null,
    projectAssignments: [{ projectId: PROJECT_ID, projectName: 'Credit Notes Test Project' }],
    projectIds: [PROJECT_ID],
    isActive: true,
    externalRefs: {},
    createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
  }],

  // Budget lines so the Budget tab has a denominator to show Invoiced/Actual against.
  [`companies/${COMPANY_ID}/projects/${PROJECT_ID}/budgetLines/seedBudgetConcrete`, {
    costCodeId: CC_CONCRETE, costCodeName: '03-100 — Concrete',
    budgeted: 12000, notes: '', createdAt: now, createdBy: UID,
  }],
  [`companies/${COMPANY_ID}/projects/${PROJECT_ID}/budgetLines/seedBudgetFormwork`, {
    costCodeId: CC_FORMWORK, costCodeName: '03-200 — Formwork',
    budgeted: 8000, notes: '', createdAt: now, createdBy: UID,
  }],

  // A SENT purchase order — gives Committed something to mature against, so
  // Budget/Forecast look realistic and Remaining Committed is observably
  // untouched by a credit note (ADR-31).
  [`companies/${COMPANY_ID}/projects/${PROJECT_ID}/purchaseOrders/${PO_ID}`, {
    poNumber: 'PO-0001',
    status: 'sent',
    ...supplierSnapshot,
    description: 'Level 1 concrete and formwork',
    lineItems: [
      { costCodeId: CC_CONCRETE, costCodeName: '03-100 — Concrete',
        description: 'Slab pour', qty: 80, unit: 'm3', unitPrice: 100, lineTotal: 8000 },
      { costCodeId: CC_FORMWORK, costCodeName: '03-200 — Formwork',
        description: 'Formwork', qty: 250, unit: 'm2', unitPrice: 20, lineTotal: 5000 },
    ],
    subtotal: 13000, gst: 1300, total: 14300,
    currency: 'AUD', revision: 1, notes: '',
    sentAt: now, closedAt: null, cancelledAt: null,
    externalRefs: {},
    createdAt: now, createdBy: UID,
  }],

  // ── SI-0001 — the CREDITABLE target (posted, zero retention) ───────────────
  [`companies/${COMPANY_ID}/projects/${PROJECT_ID}/supplierInvoices/${INV_OPEN_ID}`, {
    ...invoiceBase,
    invoiceNumber: 'SI-0001',
    supplierInvoiceNumber: 'BC-4471',
    status: 'posted',
    invoiceDate: '2026-08-01',
    dueDate: '2026-08-31',
    lineItems: invoiceOpenLines,
    retention: 0, retentionGst: 0, retentionTotal: 0,
    subtotal: 10000, gstTotal: 1000, grossTotal: 11000,
    net: 10000, payableGst: 1000, payableTotal: 11000,
    notes: 'Seeded: creditable — zero retention.',
  }],

  // ── SI-0002 — RETAINED, so credit notes must be blocked against it ────────
  [`companies/${COMPANY_ID}/projects/${PROJECT_ID}/supplierInvoices/${INV_RETAIN_ID}`, {
    ...invoiceBase,
    invoiceNumber: 'SI-0002',
    supplierInvoiceNumber: 'BC-4488',
    status: 'posted',
    invoiceDate: '2026-08-05',
    dueDate: '2026-09-04',
    lineItems: invoiceRetainedLines,
    retention: 250, retentionGst: 25, retentionTotal: 275,
    subtotal: 5000, gstTotal: 500, grossTotal: 5500,
    net: 4750, payableGst: 475, payableTotal: 5225,
    notes: 'Seeded: RETAINED — Credit Notes must refuse this invoice.',
  }],

  // Counters, so app-created documents continue the sequence instead of
  // colliding with the seeded numbers. The first credit note becomes SCN-0001.
  [`companies/${COMPANY_ID}/counters/purchaseOrders`,      { next: 2 }],
  [`companies/${COMPANY_ID}/counters/supplierInvoices`,    { next: 3 }],
  [`companies/${COMPANY_ID}/counters/supplierCreditNotes`, { next: 1 }],
]

// ── Write ────────────────────────────────────────────────────────────────────
const testEnv = await initializeTestEnvironment({
  projectId: GCP_PROJECT_ID,
  firestore: { host: HOST === '[::1]' ? '::1' : HOST, port: PORT },
})

await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore()
  for (const [path, data] of DOCS) {
    await setDoc(doc(db, path), data)
  }
})

await testEnv.cleanup()

console.log(`
✔ Seeded the LOCAL Firestore emulator (${EMULATOR_HOST}, project "${GCP_PROJECT_ID}").

  Membership   users/${UID}  (${ROLE})
  Company      ${COMPANY_ID}
  Project      "Credit Notes Test Project"  (${PROJECT_ID})
  Supplier     BuildCo Concreting Pty Ltd
  Cost codes   03-100 Concrete · 03-200 Formwork
  Budget       Concrete 12,000 · Formwork 8,000 (ex-GST)
  PO-0001      sent · 13,000 ex-GST

  SI-0001      POSTED · zero retention · payable 11,000  →  CREDITABLE
  SI-0002      POSTED · retention 275 withheld · payable 5,225  →  credit notes BLOCKED

  Next credit note will be numbered SCN-0001.

  Now run:  npm run dev     (with VITE_USE_FIREBASE_EMULATOR=true in .env.local)
  Then open the project → Supplier Invoices tab.

  Emulator data is in-memory and is discarded when the emulator stops.
`)
