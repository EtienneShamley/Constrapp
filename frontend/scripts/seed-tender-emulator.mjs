// ── Tender acceptance seed — EMULATOR ONLY ───────────────────────────────────
//
// Writes the deterministic fixture set for `npm run test:tender` into a LOCAL
// Firestore emulator. It is not a migration, not a backfill, and it must never
// be pointed at a real project.
//
// ⚠️ THIS FILE REFUSES TO RUN unless it can prove it is talking to a loopback
// emulator (see assertEmulatorOnly below). The checks are deliberately
// paranoid and run BEFORE any Firebase module is imported for use.
//
// It seeds through `@firebase/rules-unit-testing` (already a devDependency —
// no new packages) with security rules DISABLED, because:
//   · `users/{uid}` is client-read-only by rules (ADR-27), so no client-SDK
//     path can create a membership document, and
//   · Project 3's fixture is a MALFORMED bid, which the app itself refuses to
//     create — the whole point is to prove read-time fail-safe rendering.
//
// The rules stay LOADED AND ACTIVE for the browser session that follows: the
// emulator is started from firebase.json, so everything you click in the app is
// evaluated against the real frontend/firestore.rules. Only this seed bypasses
// them, exactly as the rules test suites do.

import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, Timestamp } from 'firebase/firestore'

// ── Production-safety gate ───────────────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

function assertEmulatorOnly() {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  if (!host) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set — refusing to seed. This script only ever writes to a ' +
      'local Firestore emulator. Run `npm run test:tender`.',
    )
  }
  // Accept host:port; reject anything whose host half is not loopback.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  if (!LOOPBACK.has(hostname)) {
    throw new Error(
      `FIRESTORE_EMULATOR_HOST points at "${hostname}", which is not loopback — refusing to seed. ` +
      'Only 127.0.0.1 / localhost / ::1 are permitted.',
    )
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is set — refusing to seed. Service-account credentials must ' +
      'never be in scope while seeding; unset it and re-run.',
    )
  }
  return host
}

// ── Fixture identity ─────────────────────────────────────────────────────────

export const DEFAULT_UID = 'igCEJR3XzdTd5JEIJSC5QyP5eBB3' // Etienne
export const COMPANY_ID  = '2Vf3CVuYE8wWzg8hLjR5'
export const COMPANY_NAME = 'Apex Builders'

export const PROJECT_IDS = {
  currency:   'tenderCurrencyTestProject',
  comparison: 'tenderComparisonTestProject',
  malformed:  'tenderMalformedBidTestProject',
}

// Cost codes — display strings follow the app's `${code} — ${name}` idiom.
const COST_CODES = [
  { id: 'cc0300', code: '0300', name: 'Concrete',   unit: 'm3',   category: 'Structure' },
  { id: 'cc0400', code: '0400', name: 'Formwork',   unit: 'm2',   category: 'Structure' },
  { id: 'cc0500', code: '0500', name: 'Electrical', unit: 'item', category: 'Services' },
]
const ccName = (id) => {
  const cc = COST_CODES.find(c => c.id === id)
  return `${cc.code} — ${cc.name}`
}

// Contacts. Example Client Ltd is seeded specifically to PROVE it never appears
// in the bidder picker (client-type contacts are not eligible bidders).
const CONTACTS = [
  {
    id: 'contactBuildCo', legalName: 'BuildCo Concreting Pty Ltd', tradingName: '',
    contactTypes: ['subcontractor'], trades: ['Concrete'],
  },
  {
    id: 'contactMetro', legalName: 'Metro Structures Ltd', tradingName: '',
    contactTypes: ['supplier', 'subcontractor'], trades: ['Structural'],
  },
  {
    id: 'contactPrime', legalName: 'Prime Civil Ltd', tradingName: '',
    contactTypes: ['subcontractor'], trades: ['Civil'],
  },
  {
    id: 'contactClient', legalName: 'Example Client Ltd', tradingName: '',
    contactTypes: ['client'], trades: [],
  },
]

const now = () => Timestamp.now()

// ── Document builders (mirroring docs/DATA_MODEL.md exactly) ─────────────────

const userDoc = (uid, name) => ({
  name,
  email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
  role: 'company_admin',
  companyId: COMPANY_ID,
  avatarInitials: name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase(),
})

const companyDoc = () => ({
  name: COMPANY_NAME,
  countryCode: 'AU',
  baseCurrency: 'AUD',
  currencyUpdatedAt: now(),
  currencyUpdatedBy: DEFAULT_UID,
})

const costCodeDoc = (cc, uid) => ({
  code: cc.code,
  name: cc.name,
  category: cc.category,
  unit: cc.unit,
  isActive: true,
  createdAt: now(),
  createdBy: uid,
})

const contactDoc = (c, uid) => ({
  entityType: 'organisation',
  contactTypes: c.contactTypes,
  legalName: c.legalName,
  tradingName: c.tradingName,
  firstName: '',
  lastName: '',
  displayName: c.tradingName || c.legalName,
  nameLower: (c.tradingName || c.legalName).toLowerCase(),
  abn: '',
  country: 'AU',
  email: '',
  phone: '',
  address: { street: '', suburb: '', state: '', postcode: '' },
  trades: c.trades,
  paymentTerms: null,
  gstStatus: 'unknown',
  notes: '',
  people: [],
  primaryPersonId: null,
  projectAssignments: [],
  projectIds: [],
  isActive: true,
  externalRefs: {},
  createdAt: now(),
  createdBy: uid,
  updatedAt: now(),
  updatedBy: uid,
})

const projectDoc = ({ name, budget, currencyLocked, location }, uid) => ({
  name,
  status: 'In Progress',
  budget,
  startDate: now(),
  location,
  progress: 10,
  currency: 'AUD',
  currencyLocked,
  createdAt: now(),
  createdBy: uid,
})

const budgetLineDoc = (costCodeId, budgeted, uid) => ({
  costCodeId,
  costCodeName: ccName(costCodeId),
  budgeted,
  committed: 0,
  actual: 0,
  invoiced: 0,
  notes: '',
  createdAt: now(),
  createdBy: uid,
})

const tenderPackageDoc = (o, uid) => ({
  tenderNumber: o.tenderNumber,
  status: o.status,
  name: o.name,
  description: o.description ?? '',
  scope: o.scope ?? '',
  costCodes: o.costCodeIds.map(id => ({ costCodeId: id, costCodeName: ccName(id) })),
  closingDate: o.closingDate ?? '',
  notes: o.notes ?? '',
  awardedBidId: o.awardedBidId ?? null,
  awardedBidderName: o.awardedBidderName ?? null,
  awardNotes: o.awardNotes ?? '',
  cancelReason: '',
  revision: 1,
  issuedAt: o.status === 'draft' ? null : now(),
  issuedBy: o.status === 'draft' ? null : uid,
  awardedAt: o.status === 'awarded' ? now() : null,
  awardedBy: o.status === 'awarded' ? uid : null,
  cancelledAt: null,
  cancelledBy: null,
  createdAt: now(),
  createdBy: uid,
  updatedAt: now(),
  updatedBy: uid,
})

const tenderBidDoc = (o, uid) => ({
  tenderPackageId: o.tenderPackageId,
  tenderNumber: o.tenderNumber,
  status: 'received',
  bidderContactId: o.bidderContactId,
  bidderName: o.bidderName,
  bidDate: o.bidDate,
  bidderRef: o.bidderRef ?? '',
  lineItems: o.lineItems,
  exclusions: o.exclusions ?? '',
  notes: o.notes ?? '',
  currency: 'AUD',
  revision: 1,
  voidedAt: null,
  voidedBy: null,
  voidReason: '',
  createdAt: now(),
  createdBy: uid,
  updatedAt: now(),
  updatedBy: uid,
})

// ── Seed ─────────────────────────────────────────────────────────────────────

export async function seed({ uids = [DEFAULT_UID], log = console.log } = {}) {
  const host = assertEmulatorOnly()
  const projectId = process.env.TENDER_EMULATOR_PROJECT_ID || 'demo-tender-acceptance'
  const [hostname, port] = host.startsWith('[')
    ? [host.slice(0, host.indexOf(']') + 1), host.slice(host.lastIndexOf(':') + 1)]
    : host.split(':')

  const testEnv = await initializeTestEnvironment({
    projectId,
    // No `rules` key: the emulator keeps the rules it was started with
    // (frontend/firestore.rules via firebase.json), so the BROWSER session is
    // evaluated against the real rules. Only this seed bypasses them.
    firestore: { host: hostname, port: Number(port) },
  })

  // Deterministic every run — the fixture set is the same on the tenth launch
  // as on the first.
  await testEnv.clearFirestore()

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    const set = (path, data) => setDoc(doc(db, path), data)
    const primary = uids[0]

    // Membership — one company_admin per requested uid.
    for (const [i, uid] of uids.entries()) {
      await set(`users/${uid}`, userDoc(uid, i === 0 ? 'Etienne Shamley' : `Test User ${i}`))
    }
    await set(`companies/${COMPANY_ID}`, companyDoc())

    // Company-wide taxonomy and directory.
    for (const cc of COST_CODES) await set(`companies/${COMPANY_ID}/costCodes/${cc.id}`, costCodeDoc(cc, primary))
    for (const c of CONTACTS)    await set(`companies/${COMPANY_ID}/contacts/${c.id}`, contactDoc(c, primary))

    const P = (id, rest = '') => `companies/${COMPANY_ID}/projects/${id}${rest}`

    // ── PROJECT 1 — CURRENCY TEST ────────────────────────────────────────────
    // Deliberately EMPTY of every monetary record, and `budget: 0` so the
    // headline figure is not itself lock evidence. Nothing here may lock the
    // currency until the tester records the first bid.
    await set(P(PROJECT_IDS.currency), projectDoc({
      name: 'Tender Currency Test Project',
      budget: 0,
      currencyLocked: false,
      location: 'Brisbane QLD',
    }, primary))

    // ── PROJECT 2 — NORMAL TENDER TEST ───────────────────────────────────────
    // Approved Budget $20,000 across the two package cost codes, so the
    // comparison's Budget − Bid arithmetic has something real to work against.
    // No packages and no bids: the tester enters those by hand.
    await set(P(PROJECT_IDS.comparison), projectDoc({
      name: 'Tender Comparison Test Project',
      budget: 20000,
      currencyLocked: true, // budget lines are monetary evidence
      location: 'Sydney NSW',
    }, primary))
    await set(P(PROJECT_IDS.comparison, '/budgetLines/bl0300'), budgetLineDoc('cc0300', 12000, primary))
    await set(P(PROJECT_IDS.comparison, '/budgetLines/bl0400'), budgetLineDoc('cc0400', 8000, primary))

    // ── PROJECT 3 — MALFORMED BID SAFE-FAILURE ───────────────────────────────
    // Two fixture packages. Their numbers are TP-9001/TP-9002 so the company
    // counter can still start at 1 and the tester's manual package in Project 2
    // is TP-0001 (counters are company-wide, not per project).
    await set(P(PROJECT_IDS.malformed), projectDoc({
      name: 'Tender Malformed Bid Test Project',
      budget: 30000,
      currencyLocked: true, // tender bids are monetary evidence
      location: 'Melbourne VIC',
    }, primary))
    await set(P(PROJECT_IDS.malformed, '/budgetLines/bl0300'), budgetLineDoc('cc0300', 20000, primary))
    await set(P(PROJECT_IDS.malformed, '/budgetLines/bl0400'), budgetLineDoc('cc0400', 10000, primary))

    // (a) ISSUED package holding one malformed and one valid bid, so the
    //     comparison shows the malformed bid excluded while a real bid ranks.
    await set(P(PROJECT_IDS.malformed, '/tenderPackages/pkgMalformedIssued'), tenderPackageDoc({
      tenderNumber: 'TP-9001',
      status: 'issued',
      name: 'Malformed Bid Fixture Package',
      description: 'Fixture — proves malformed bids fail safely',
      scope: 'Concrete and formwork works (fixture data).',
      costCodeIds: ['cc0300', 'cc0400'],
      closingDate: '2026-08-29',
    }, primary))

    // ⚠️ THE MALFORMED FIXTURE. Every TOP-LEVEL field is rules-valid — this is
    // exactly the document a direct-SDK caller could write past Firestore
    // rules, because rules cannot iterate or index into `lineItems`. The
    // corruption is inside the embedded line: `amount` is the STRING
    // "ninety grand". The app must render it Invalid/Malformed, exclude it
    // from every total and from the lowest-bid ranking, and refuse to award it.
    await set(P(PROJECT_IDS.malformed, '/tenderBids/bidMalformed'), tenderBidDoc({
      tenderPackageId: 'pkgMalformedIssued',
      tenderNumber: 'TP-9001',
      bidderContactId: 'contactBuildCo',
      bidderName: 'BuildCo Concreting Pty Ltd',
      bidDate: '2026-08-20',
      bidderRef: 'MALFORMED-01',
      lineItems: [
        { costCodeId: 'cc0300', costCodeName: ccName('cc0300'), description: 'Concrete works', amount: 'ninety grand' },
        { costCodeId: 'cc0400', costCodeName: ccName('cc0400'), description: 'Formwork', amount: 7000 },
      ],
      exclusions: 'Fixture bid — amount is a string, not a number',
      notes: 'Seeded malformed on purpose. Must never contribute a total.',
    }, primary))

    // A genuinely valid bid beside it: the lowest-bid figure must come from
    // THIS bid, never from the malformed one.
    await set(P(PROJECT_IDS.malformed, '/tenderBids/bidValidBeside'), tenderBidDoc({
      tenderPackageId: 'pkgMalformedIssued',
      tenderNumber: 'TP-9001',
      bidderContactId: 'contactMetro',
      bidderName: 'Metro Structures Ltd',
      bidDate: '2026-08-21',
      bidderRef: 'MS-VALID-01',
      lineItems: [
        { costCodeId: 'cc0300', costCodeName: ccName('cc0300'), description: 'Concrete works', amount: 18000 },
        { costCodeId: 'cc0400', costCodeName: ccName('cc0400'), description: 'Formwork', amount: 9000 },
      ],
      exclusions: '',
      notes: 'Valid fixture bid — total $27,000 ex-GST.',
    }, primary))

    // (b) AWARDED package whose awarded bid is malformed. The Awarded Bid Value
    //     must read "unavailable", never $0 / NaN / Infinity / a partial sum.
    await set(P(PROJECT_IDS.malformed, '/tenderPackages/pkgMalformedAwarded'), tenderPackageDoc({
      tenderNumber: 'TP-9002',
      status: 'awarded',
      name: 'Awarded-To-Malformed Fixture Package',
      description: 'Fixture — proves the awarded value fails safe',
      scope: 'Electrical works (fixture data).',
      costCodeIds: ['cc0500'],
      closingDate: '2026-08-15',
      awardedBidId: 'bidMalformedAwarded',
      awardedBidderName: 'Prime Civil Ltd',
      awardNotes: 'Fixture award to a malformed bid — value must render unavailable.',
    }, primary))

    await set(P(PROJECT_IDS.malformed, '/tenderBids/bidMalformedAwarded'), tenderBidDoc({
      tenderPackageId: 'pkgMalformedAwarded',
      tenderNumber: 'TP-9002',
      bidderContactId: 'contactPrime',
      bidderName: 'Prime Civil Ltd',
      bidDate: '2026-08-12',
      bidderRef: 'MALFORMED-02',
      lineItems: [
        // Non-finite and out-of-scope corruption in one line.
        { costCodeId: 'cc0500', costCodeName: ccName('cc0500'), description: 'Electrical', amount: 'not a number' },
      ],
      exclusions: '',
      notes: 'Seeded malformed on purpose, then awarded out of band.',
    }, primary))

    // ── Counter ──────────────────────────────────────────────────────────────
    // Fixture packages used the TP-9xxx range on purpose, so the tester's first
    // manually created package is TP-0001 exactly as the acceptance script says.
    await set(`companies/${COMPANY_ID}/counters/tenderPackages`, { next: 1 })
  })

  await testEnv.cleanup()

  log(`   seeded project "${projectId}" on ${host}`)
  return { projectId, uids }
}

// ── Standalone entry point ───────────────────────────────────────────────────
// `node scripts/seed-tender-emulator.mjs` re-seeds a running emulator without
// restarting it. The safety gate above applies identically.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed-tender-emulator.mjs')
if (invokedDirectly) {
  const uids = [DEFAULT_UID]
  if (process.env.TEST_USER_UID && process.env.TEST_USER_UID !== DEFAULT_UID) {
    uids.push(process.env.TEST_USER_UID)
  }
  seed({ uids })
    .then(() => { console.log('Seed complete.'); process.exit(0) })
    .catch((err) => { console.error(`\nSeed failed: ${err.message}\n`); process.exit(1) })
}
