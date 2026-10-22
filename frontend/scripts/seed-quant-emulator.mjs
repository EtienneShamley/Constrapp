// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT-ONLY seed for manual Quant™ 1A acceptance (ADR-51, TESTING.md §27).
//
// Seeds the LOCAL Firestore emulator AND the LOCAL Cloud Storage emulator with
// one tenant, one project, three cost codes, two drawings with real file bytes
// (the committed two-page PDF fixture with KNOWN dimensions, plus generated PNG
// sheets), a little takeoff history on a superseded and a withdrawn revision,
// and — since Quant 1B (ADR-52) — three BOQ items (matching m², incompatible
// m³, unpriced count) so linking and apply can be exercised by hand with the
// UNPUBLISHED rules loaded from disk, plus ONE ready-made 1B case: A-201 Rev A
// calibrated, with an active 12 m² area measurement already LINKED to BOQ item
// 2.1 (qty 10 m², $85.00), so the apply dialog proposes 12 m² / $1,020.00 the
// moment the environment is up.
//
// EVERY RESTART RESETS EVERYTHING. `firebase emulators:exec` runs both
// emulators in memory with no --import / --export-on-exit: Ctrl+C discards all
// Firestore documents and all Storage objects — the fixture AND whatever the
// tester calibrated, measured, linked, applied or voided — and the next start
// re-seeds exactly this fixture (deterministic ids, setDoc overwrites). That is
// deliberate: acceptance runs start from a known state. See TESTING.md §27 for
// the (unimplemented, opt-in) state-directory assessment.
//
// Run via `npm run test:quant` (scripts/quant-dev.mjs). It can also be run
// alone against already-running emulators:
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
//     node scripts/seed-quant-emulator.mjs
//
// ⚠️ IT WRITES NOTHING TO PRODUCTION AND STRUCTURALLY CANNOT:
//   · it refuses to run unless BOTH emulator host variables are set, loopback,
//     and actually answering (a connection probe precedes every write);
//   · it refuses if GOOGLE_APPLICATION_CREDENTIALS is set;
//   · it uses `@firebase/rules-unit-testing` (already a devDependency and the
//     rules suites' own seeding mechanism); rules are bypassed for the write
//     (`withSecurityRulesDisabled`) — unavoidable, because `users/{uid}` is
//     client-read-only (ADR-27) and drawing revisions are immutable.
//
// Idempotent: every id is deterministic, so re-running overwrites rather than
// duplicates. Nothing here is imported by application code.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, Timestamp } from 'firebase/firestore'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const FIXTURE_PDF = resolve(FRONTEND, 'tests/unit/fixtures/quant-two-page.pdf')

const die = (lines) => { console.error(`\n✖ REFUSING TO RUN: ${lines.join('\n  ')}\n`); process.exit(1) }

// ── Identity ─────────────────────────────────────────────────────────────────
// Firestore and Storage are emulated but AUTH IS NOT: testers sign in against
// the REAL Firebase Auth project, so membership is keyed by real Auth UIDs
// (Etienne's always; TEST_USER_UID for anyone else). The seeded role defaults
// to company_admin like the other launchers; TEST_USER_ROLE=qs exercises the
// QS-as-author path.
const DEFAULT_UID = 'igCEJR3XzdTd5JEIJSC5QyP5eBB3'   // Etienne
const COMPANY_ID  = '2Vf3CVuYE8wWzg8hLjR5'            // the Apex Builders test tenant
const QUANT_ROLES = ['company_admin', 'project_manager', 'qs']

const isUsableUid = (uid) =>
  typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !uid.includes('/') && uid !== '.' && uid !== '..'

const TESTER_UID = (process.env.TEST_USER_UID ?? '').trim()
if (TESTER_UID && !isUsableUid(TESTER_UID)) die([`TEST_USER_UID ("${TESTER_UID}") is not a usable Firebase Auth UID.`])
const ROLE = (process.env.TEST_USER_ROLE ?? 'company_admin').trim()
if (!QUANT_ROLES.includes(ROLE)) die([`TEST_USER_ROLE must be one of ${QUANT_ROLES.join(', ')} (got "${ROLE}").`])
const SEEDED_UIDS = [...new Set([DEFAULT_UID, ...(TESTER_UID ? [TESTER_UID] : [])])]
const UID = DEFAULT_UID

// ── Deterministic ids ────────────────────────────────────────────────────────
export const SEED = {
  projectId:   'quant-takeoff-test',
  projectName: 'Quant Takeoff Test Project',
  costCodes: {
    concrete: 'cc-0300-concrete',
    formwork: 'cc-0400-formwork',
    doors:    'cc-0800-doors',
  },
  drawings: {
    a101: { id: 'quant-drawing-a101', number: 'A-101', title: 'Ground Floor Plan', discipline: 'architectural' },
    a201: { id: 'quant-drawing-a201', number: 'A-201', title: 'Site Plan',         discipline: 'civil' },
  },
  revisions: {
    a101P1: 'quant-rev-a101-p1',   // withdrawn  (PNG)  — history only, void-only
    a101A:  'quant-rev-a101-a',    // superseded (PNG)  — measurable, warned
    a101B:  'quant-rev-a101-b',    // current    (PDF, 2 pages, known dimensions)
    a201A:  'quant-rev-a201-a',    // current    (PNG)
  },
  // Quant 1B (ADR-52) — three BOQ items so linking and apply can be exercised:
  // a MATCHING priced m² item on Formwork, an INCOMPATIBLE m³ item on Concrete
  // (never offered to an area measurement), and an UNPRICED count item on
  // Doors (the no-amount path). No budget line, no other financial record.
  boqItems: {
    formworkM2: 'quant-boq-formwork-m2',
    concreteM3: 'quant-boq-concrete-m3',
    doorsCount: 'quant-boq-doors-no',
  },
  // The ready-made Quant 1B case (TESTING.md §28): the seeded area on A-201.
  measurements: {
    a201Area:   'quant-seed-m-a201-area',
    superseded: 'quant-seed-m-superseded',
    withdrawn:  'quant-seed-m-withdrawn',
  },
}

// ── SAFETY GATES ─────────────────────────────────────────────────────────────
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]']
function parseHost(name) {
  const raw = process.env[name]
  if (!raw) die([`${name} is not set.`, 'This script seeds throwaway data and must never reach a real project.', 'Run `npm run test:quant`.'])
  const bare = raw.replace(/^https?:\/\//, '')
  const idx = bare.lastIndexOf(':')
  const host = idx === -1 ? bare : bare.slice(0, idx)
  const port = Number(idx === -1 ? NaN : bare.slice(idx + 1))
  if (!LOOPBACK.includes(host)) die([`${name} points at "${host}", which is not loopback.`, `Expected one of: ${LOOPBACK.join(', ')}`])
  if (!Number.isInteger(port) || port <= 0) die([`could not read a port from ${name}="${raw}".`])
  return { host: host === '[::1]' ? '::1' : host, port }
}
const FS = parseHost('FIRESTORE_EMULATOR_HOST')
const ST = parseHost('FIREBASE_STORAGE_EMULATOR_HOST')
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) die(['GOOGLE_APPLICATION_CREDENTIALS is set. This script never needs real credentials. Unset it and re-run.'])

// Both emulators must actually answer before a single document is built. Any
// HTTP response counts (the Storage emulator answers its root with 501); only a
// refused or unreachable connection means the emulator is not there.
async function probe(label, { host, port }) {
  try {
    await fetch(`http://${host === '::1' ? '[::1]' : host}:${port}/`)
  } catch (err) {
    die([`the ${label} emulator at ${host}:${port} is not answering (${err?.cause?.code ?? err?.message ?? err}).`, 'Start both emulators (npm run test:quant does) and re-run.'])
  }
}
await probe('Firestore', FS)
await probe('Storage', ST)

// ── Project id and bucket must match the app's own configuration ─────────────
// The emulators namespace data BY PROJECT ID and BY BUCKET; the app resolves
// both from .env.local, so seeding under anything else writes data the app
// cannot see.
function readEnvValue(key) {
  if (process.env[key]) return process.env[key]
  for (const file of ['.env.local', '.env']) {
    try {
      const m = readFileSync(resolve(FRONTEND, file), 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, 'm'))
      if (m) return m[1].trim().replace(/^["']|["']$/g, '')
    } catch { /* try the next file */ }
  }
  return ''
}
const GCP_PROJECT_ID = process.env.SEED_PROJECT_ID || readEnvValue('VITE_FIREBASE_PROJECT_ID')
if (!GCP_PROJECT_ID) die(['VITE_FIREBASE_PROJECT_ID not found in frontend/.env.local (or SEED_PROJECT_ID).'])
const BUCKET = readEnvValue('VITE_FIREBASE_STORAGE_BUCKET')
if (!BUCKET) die(['VITE_FIREBASE_STORAGE_BUCKET not found in frontend/.env.local — the app and the seed must agree on the bucket name.'])
if (!existsSync(FIXTURE_PDF)) die([`the PDF fixture is missing: ${FIXTURE_PDF}`, 'Regenerate it with tests/unit/fixtures/make-quant-fixture.mjs.'])

// ── A generated PNG sheet with a KNOWN rectangle ────────────────────────────
// 800 × 600 white, a 3 px black rectangle whose OUTER edges run from
// (200, 150) to (600, 450) — 400 × 300 image pixels — with tick marks. The
// bottom edge is labelled in the seed summary as 4000 mm, so a calibration of
// the 400 px edge makes the rectangle 4 m × 3 m: perimeter 14 m, area 12 m².
// Pure Node (zlib): no image library.
function makePng() {
  const W = 800, H = 600
  const rows = Buffer.alloc((W * 3 + 1) * H, 0xff)
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const o = y * (W * 3 + 1) + 1 + x * 3
    rows[o] = v; rows[o + 1] = v; rows[o + 2] = v
  }
  for (let y = 0; y < H; y++) rows[y * (W * 3 + 1)] = 0 // filter byte: None
  const rect = (x0, y0, x1, y1, t) => {
    for (let x = x0; x <= x1; x++) for (let k = 0; k < t; k++) { put(x, y0 + k, 0); put(x, y1 - k, 0) }
    for (let y = y0; y <= y1; y++) for (let k = 0; k < t; k++) { put(x0 + k, y, 0); put(x1 - k, y, 0) }
  }
  rect(200, 150, 600, 450, 3)
  // dimension line under the bottom edge with end ticks
  for (let x = 200; x <= 600; x++) put(x, 480, 0)
  for (let y = 470; y <= 490; y++) { put(200, y, 0); put(600, y, 0) }
  // a light grid every 100 px so zoom alignment is visible
  for (let x = 0; x < W; x += 100) for (let y = 0; y < H; y++) put(x, y, 0xdd)
  for (let y = 0; y < H; y += 100) for (let x = 0; x < W; x++) put(x, y, 0xdd)

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Documents ────────────────────────────────────────────────────────────────
const now = Timestamp.now()
const P = SEED.projectId
const base = `companies/${COMPANY_ID}`
const proj = `${base}/projects/${P}`
const drawingStoragePath = (drawingId, revisionId, ext) => `${proj}/drawings/${drawingId}/${revisionId}/original.${ext}`

const PDF_BYTES = readFileSync(FIXTURE_PDF)
const PNG_BYTES = makePng()

function revision({ id, drawingId, code, seq, status, ext, bytes, notes = '', extra = {} }) {
  const contentType = ext === 'pdf' ? 'application/pdf' : 'image/png'
  return [`${proj}/drawings/${drawingId}/revisions/${id}`, {
    revisionCode: code, revisionSequence: seq, revisionDate: `2026-0${seq + 5}-01`,
    status, notes,
    fileName: `${code}.${ext}`, fileExt: ext, fileSize: bytes.length, contentType,
    storagePath: drawingStoragePath(drawingId, id, ext),
    pageCount: null, sheetSize: '',
    supersededAt: null, supersededBy: null, supersededByRevisionId: null,
    withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    revision: 1, createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
    ...extra,
  }]
}

const { a101, a201 } = SEED.drawings
const R = SEED.revisions
const CC = SEED.costCodes
const costCodeName = (code, name) => `${code} — ${name}`

// Takeoff records, exactly as lib/quantActions.js writes them (every key the
// rules' exactKeys list names; `boqItemId` null for an unlinked measurement).
// The PNG sheets share one calibration: the 400 px bottom edge of the
// rectangle is 4000 mm, so the rectangle is 4 m × 3 m — area 12 m².
const pageId = (d, r, p) => `${d}_${r}_${p}`
const CAL_PNG = { pointA: { x: 200, y: 450 }, pointB: { x: 600, y: 450 }, pageDistance: 400, realDistance: 4000, unit: 'mm' }
const SNAP_PNG = { revision: 1, pageDistance: 400, realDistance: 4000, unit: 'mm' }
// The rectangle's OUTER edges on every PNG sheet — as an AREA, 4 m × 3 m = 12 m².
export const A201_RECT = [{ x: 200, y: 150 }, { x: 600, y: 150 }, { x: 600, y: 450 }, { x: 200, y: 450 }]
const seedPage = (drawingId, revisionId) => [`${proj}/takeoffPages/${pageId(drawingId, revisionId, 1)}`, {
  drawingId, revisionId, page: 1,
  source: 'image', pageWidth: 800, pageHeight: 600, pageRotation: 0,
  calibration: CAL_PNG, calibrationRevision: 1, calibratedAt: now, calibratedBy: UID,
  revision: 1, createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
}]
const seedMeasurement = (id, { drawingId, revisionId, kind, points, label, boqItemId = null }) => [`${proj}/takeoffMeasurements/${id}`, {
  takeoffPageId: pageId(drawingId, revisionId, 1), drawingId, revisionId, page: 1,
  kind, points, label,
  costCodeId: CC.formwork, costCodeName: costCodeName('04-100', 'Formwork'),
  calibration: SNAP_PNG, status: 'active', voidReason: '', voidedAt: null, voidedBy: null,
  boqItemId,
  revision: 1, createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
}]
// A tiny takeoff history on the two non-current revisions of A-101, so the
// "inspectable but not editable" behaviour is visible without first creating it.
const historyPage = (revisionId) => seedPage(a101.id, revisionId)
const historyMeasurement = (id, revisionId, label) =>
  seedMeasurement(id, { drawingId: a101.id, revisionId, kind: 'length', points: [{ x: 200, y: 150 }, { x: 600, y: 150 }], label })

// The three BOQ items (ADR-52), exactly as hooks/useBoqItems.jsx writes them.
// The priced m² item carries a known quantity and rate so the apply preview
// can be checked by hand: 10 m² × $85.00 = $850.00; the seeded, LINKED 12 m²
// rectangle on A-201 gives 12 × 85 = $1,020.00. Note the project is seeded
// UNLOCKED although a priced item exists — the first priced BOQ write (a Quant
// apply or an edit) engages the currency ratchet, which is itself a check.
const boqItem = (id, fields) => [`${proj}/boqItems/${id}`, {
  itemNumber: '', section: '', description: '', unit: '', quantity: 0, rate: null, amount: null,
  costCodeId: '', costCodeName: '', notes: '',
  status: 'active', currency: 'AUD', revision: 1, attachments: [], externalRefs: {},
  voidReason: '', voidedAt: null, voidedBy: null,
  createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
  ...fields,
}]
const B = SEED.boqItems

const DOCS = [
  ...SEEDED_UIDS.map(uid => [`users/${uid}`, {
    name: uid === DEFAULT_UID ? 'Etienne Shamley' : 'Quant Tester',
    email: '', role: ROLE, companyId: COMPANY_ID, avatarInitials: uid === DEFAULT_UID ? 'ES' : 'QT',
  }]),
  [base, { name: 'Apex Builders', countryCode: 'AU', baseCurrency: 'AUD', currencyUpdatedAt: now, currencyUpdatedBy: UID }],
  [proj, {
    name: SEED.projectName, status: 'Planning', budget: 0, startDate: Timestamp.fromDate(new Date('2026-11-02T00:00:00Z')),
    location: 'Brisbane, QLD', progress: 0, currency: 'AUD', currencyLocked: false, createdAt: now, createdBy: UID,
  }],
  [`${base}/costCodes/${CC.concrete}`, { code: '03-100', name: 'Concrete',  category: 'Structure',     unit: 'm3', isActive: true, createdAt: now, createdBy: UID }],
  [`${base}/costCodes/${CC.formwork}`, { code: '04-100', name: 'Formwork',  category: 'Structure',     unit: 'm2', isActive: true, createdAt: now, createdBy: UID }],
  [`${base}/costCodes/${CC.doors}`,    { code: '08-100', name: 'Doors',     category: 'Architectural', unit: 'no', isActive: true, createdAt: now, createdBy: UID }],

  // A-101 — three revisions: P1 withdrawn, A superseded, B current (the PDF).
  [`${proj}/drawings/${a101.id}`, {
    drawingNumber: a101.number, title: a101.title, discipline: a101.discipline, description: 'Quant acceptance sheet — see TESTING.md §27.',
    status: 'active', currentRevisionId: R.a101B, currentRevisionCode: 'B', currentRevisionIssuedDate: '2026-08-01', revisionCount: 3,
    revisionSchemaVersion: 1, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
  }],
  revision({ id: R.a101P1, drawingId: a101.id, code: 'P1', seq: 1, status: 'withdrawn', ext: 'png', bytes: PNG_BYTES,
    notes: 'Preliminary — issued in error', extra: { withdrawnAt: now, withdrawnBy: UID, withdrawReason: 'Issued in error' } }),
  revision({ id: R.a101A, drawingId: a101.id, code: 'A', seq: 2, status: 'superseded', ext: 'png', bytes: PNG_BYTES,
    notes: 'For construction', extra: { supersededAt: now, supersededBy: UID, supersededByRevisionId: R.a101B } }),
  revision({ id: R.a101B, drawingId: a101.id, code: 'B', seq: 3, status: 'current', ext: 'pdf', bytes: PDF_BYTES,
    notes: 'Two pages: sheet 1 portrait, sheet 2 rotated and cropped — rectangles with known dimensions' }),

  // A-201 — one current PNG revision.
  [`${proj}/drawings/${a201.id}`, {
    drawingNumber: a201.number, title: a201.title, discipline: a201.discipline, description: '',
    status: 'active', currentRevisionId: R.a201A, currentRevisionCode: 'A', currentRevisionIssuedDate: '2026-07-01', revisionCount: 1,
    revisionSchemaVersion: 1, withdrawnAt: null, withdrawnBy: null, withdrawReason: '',
    createdAt: now, createdBy: UID, updatedAt: now, updatedBy: UID,
  }],
  revision({ id: R.a201A, drawingId: a201.id, code: 'A', seq: 1, status: 'current', ext: 'png', bytes: PNG_BYTES }),

  // Takeoff history on the superseded and the withdrawn revision.
  historyPage(R.a101A),
  historyMeasurement(SEED.measurements.superseded, R.a101A, 'Top edge (superseded rev A)'),
  historyPage(R.a101P1),
  historyMeasurement(SEED.measurements.withdrawn, R.a101P1, 'Top edge (withdrawn rev P1)'),

  // The ready-made Quant 1B case: A-201 Rev A (current) calibrated, one ACTIVE
  // area — the 12 m² rectangle — on 04-100 Formwork, LINKED to BOQ item 2.1.
  seedPage(a201.id, R.a201A),
  seedMeasurement(SEED.measurements.a201Area, {
    drawingId: a201.id, revisionId: R.a201A, kind: 'area', points: A201_RECT,
    label: 'Slab edge formwork (seeded, linked to 2.1)', boqItemId: B.formworkM2,
  }),

  // Quant 1B BOQ items (ADR-52). 2.1 has the seeded link above; the others are unlinked.
  boqItem(B.formworkM2, {
    itemNumber: '2.1', section: 'Substructure', description: 'Formwork to slab edge', unit: 'm2',
    quantity: 10, rate: 85, amount: 850,
    costCodeId: CC.formwork, costCodeName: costCodeName('04-100', 'Formwork'),
  }),
  boqItem(B.concreteM3, {
    itemNumber: '2.2', section: 'Substructure', description: 'Concrete in slab on ground, N32', unit: 'm3',
    quantity: 24, rate: 310.4, amount: 7449.6,
    costCodeId: CC.concrete, costCodeName: costCodeName('03-100', 'Concrete'),
  }),
  boqItem(B.doorsCount, {
    itemNumber: '8.1', section: 'Architectural', description: 'Internal doors, flush panel', unit: 'no',
    quantity: 0, rate: null, amount: null,
    costCodeId: CC.doors, costCodeName: costCodeName('08-100', 'Doors'),
  }),
]

const FILES = [
  [drawingStoragePath(a101.id, R.a101P1, 'png'), PNG_BYTES, 'image/png'],
  [drawingStoragePath(a101.id, R.a101A,  'png'), PNG_BYTES, 'image/png'],
  [drawingStoragePath(a101.id, R.a101B,  'pdf'), PDF_BYTES, 'application/pdf'],
  [drawingStoragePath(a201.id, R.a201A,  'png'), PNG_BYTES, 'image/png'],
]

// ── Write ────────────────────────────────────────────────────────────────────
const testEnv = await initializeTestEnvironment({
  projectId: GCP_PROJECT_ID,
  firestore: { host: FS.host, port: FS.port },
  storage:   { host: ST.host, port: ST.port },
})

await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore()
  for (const [path, data] of DOCS) await setDoc(doc(db, path), data)
  // Storage FIRST would be the app's order; here both bypass rules and the
  // bucket is the one the app will read from (gs://<VITE_FIREBASE_STORAGE_BUCKET>).
  const storage = context.storage(`gs://${BUCKET}`)
  for (const [path, bytes, contentType] of FILES) {
    await storage.ref(path).put(new Uint8Array(bytes), { contentType })
  }
})
await testEnv.cleanup()

console.log(`
✔ Seeded the LOCAL emulators — Firestore ${FS.host}:${FS.port}, Storage ${ST.host}:${ST.port}
  (project "${GCP_PROJECT_ID}", bucket "${BUCKET}"). Both are in-memory and DISPOSABLE.

  Membership   ${SEEDED_UIDS.map(u => `users/${u}${u === DEFAULT_UID ? '  (Etienne)' : '  (TEST_USER_UID)'}`).join('\n               ')}
               seeded as ${ROLE} in company ${COMPANY_ID} (Apex Builders)
  Project      "${SEED.projectName}"  (${P})  — AUD, no money, currency unlocked
  Cost codes   03-100 Concrete (m3) · 04-100 Formwork (m2) · 08-100 Doors (no)

  Drawing A-101 Ground Floor Plan  (${a101.id})
    Rev B   CURRENT     PDF, 2 pages  (${R.a101B})
            page 1: 400 × 300 pt rectangle labelled 4000 × 3000 mm
                    → calibrate the bottom edge as 4000 mm; perimeter 14 m, area 12 m², diagonal 5 m
            page 2: ROTATED 90° + CropBox; 600 × 400 pt rectangle labelled 6000 × 4000 mm
                    → shown 400 wide × 600 tall; calibrate the short edge as 4000 mm; perimeter 20 m, area 24 m²
    Rev A   SUPERSEDED  PNG 800 × 600  (${R.a101A}) — calibrated, one length seeded; measurable with the warning
    Rev P1  WITHDRAWN   PNG 800 × 600  (${R.a101P1}) — calibrated, one length seeded; inspect or void ONLY
  Drawing A-201 Site Plan  (${a201.id})
    Rev A   CURRENT     PNG 800 × 600  (${R.a201A}) — CALIBRATED (400 px = 4000 mm)
            400 × 300 px rectangle (outer edges x 200–600, y 150–450); bottom edge = 4000 mm
            one ACTIVE AREA seeded on it (${SEED.measurements.a201Area}) = 12 m², LINKED to BOQ 2.1

  BOQ items (Quant 1B, ADR-52):
    2.1  Formwork to slab edge         m2   qty 10   rate $85.00   → amount $850.00   (${B.formworkM2})
         LINKED to the seeded 12 m² area → BOQ tab shows Quant (1); apply proposes 12 m² / $1,020.00
         (link a further AREA on 04-100 Formwork to see Quant (2) and the summed total)
    2.2  Concrete in slab on ground    m3   qty 24   rate $310.40                      (${B.concreteM3})
         INCOMPATIBLE with every Quant kind — never offered in the picker
    8.1  Internal doors, flush panel   no   qty 0    UNPRICED                           (${B.doorsCount})
         link a COUNT on 08-100 Doors → apply changes the quantity only, no amount
  The project is seeded with currencyLocked false: the first priced BOQ write engages the ratchet.

  ⟳ Ctrl+C discards EVERYTHING (fixture and your work); the next start re-seeds exactly this.
${TESTER_UID ? '' : `
  ℹ Only Etienne's UID was seeded. Another tester signs in with their OWN Firebase Auth
    account, so they must seed their own UID:   TEST_USER_UID=<uid> npm run test:quant
`}`)
