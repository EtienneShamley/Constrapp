#!/usr/bin/env node
// ── BOQ manual-acceptance seed (LOCAL FIRESTORE EMULATOR ONLY) ───────────────
//
// Seeds the two projects docs/TESTING.md §15s needs, into the local Firestore
// emulator, so the UNPUBLISHED BOQ rules in frontend/firestore.rules can be
// manually accepted before they are ever published to production.
//
// Run via `npm run test:boq` (scripts/boq-dev.mjs). It can also be run alone
// against an already-running emulator:
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-boq-emulator.mjs
//
// ⚠️ THIS SCRIPT REFUSES TO RUN ANYWHERE BUT A LOOPBACK EMULATOR. See
// assertEmulatorOnly() below — there is deliberately no code path that can
// reach production Firestore.
//
// Writes bypass Security Rules (withSecurityRulesDisabled), exactly as the
// automated rules suite's seed helpers do — that is what lets us create
// `users/{uid}` membership documents, which ADR-27 blocks every client from
// writing.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, Timestamp } from 'firebase/firestore'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const RULES_PATH = resolve(FRONTEND, 'firestore.rules')

// ── The existing Apex Builders test tenant ───────────────────────────────────
const COMPANY_ID = '2Vf3CVuYE8wWzg8hLjR5'
const COMPANY_NAME = 'Apex Builders'

// Etienne's real Firebase Auth uid — seeded by default so he can sign in with
// his normal Constrapp account against the emulated Firestore.
const ETIENNE_UID = 'igCEJR3XzdTd5JEIJSC5QyP5eBB3'

// Deterministic ids keep re-seeding idempotent and make the emulator UI legible.
const PROJECT_CURRENCY_ID = 'boq-currency-test'
const PROJECT_COMPARISON_ID = 'boq-comparison-test'
const COST_CODE_CONCRETE_ID = 'cc-0300-concrete'
const COST_CODE_FORMWORK_ID = 'cc-0400-formwork'

// ── Production safety ────────────────────────────────────────────────────────
//
// Three independent barriers. Any one of them failing aborts before a single
// Firebase object is constructed.
function assertEmulatorOnly() {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  if (!host) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set — refusing to seed. This script only ever writes to a local emulator. Run `npm run test:boq`.',
    )
  }

  // Strip an optional scheme, then take the host portion (IPv6 aware).
  const bare = host.replace(/^https?:\/\//, '')
  const hostname = bare.startsWith('[')
    ? bare.slice(1, bare.indexOf(']'))
    : bare.split(':')[0]

  const LOOPBACK = ['127.0.0.1', 'localhost', '::1']
  if (!LOOPBACK.includes(hostname)) {
    throw new Error(
      `FIRESTORE_EMULATOR_HOST points at "${hostname}", which is not loopback (${LOOPBACK.join(', ')}) — refusing to seed.`,
    )
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS is set — refusing to seed. Service-account credentials must never be in scope for local test seeding.',
    )
  }

  return { hostname, port: Number(bare.split(':').pop()) || 8080 }
}

async function main() {
  const { hostname, port } = assertEmulatorOnly()

  // Must match the app's VITE_FIREBASE_PROJECT_ID, or the browser would connect
  // to a different emulator namespace than the one seeded here.
  const projectId = process.env.SEED_PROJECT_ID
  if (!projectId) throw new Error('SEED_PROJECT_ID is required (the app\'s Firebase project id).')

  const extraUid = (process.env.TEST_USER_UID || '').trim()

  const testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: hostname === '::1' ? '127.0.0.1' : hostname,
      port,
      // Load the UNPUBLISHED rules from disk — the whole point of testing
      // locally is to exercise the BOQ block before it is published.
      rules: readFileSync(RULES_PATH, 'utf8'),
    },
  })

  // Disposable data: start from a clean slate every launch.
  await testEnv.clearFirestore()

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    const now = Timestamp.now()

    // ── Membership (ADR-27: client-writable nowhere; provisioned out of band) ─
    const members = [
      { uid: ETIENNE_UID, name: 'Etienne Shamley', avatarInitials: 'ES' },
      ...(extraUid && extraUid !== ETIENNE_UID
        ? [{ uid: extraUid, name: 'BOQ Test User', avatarInitials: 'BT' }]
        : []),
    ]
    for (const m of members) {
      await setDoc(doc(db, 'users', m.uid), {
        name: m.name,
        avatarInitials: m.avatarInitials,
        role: 'company_admin',
        companyId: COMPANY_ID,
      })
    }

    // ── Company ──────────────────────────────────────────────────────────────
    await setDoc(doc(db, 'companies', COMPANY_ID), {
      name: COMPANY_NAME,
      countryCode: 'AU',
      baseCurrency: 'AUD',
      currencyUpdatedAt: now,
      currencyUpdatedBy: ETIENNE_UID,
    })

    // ── PROJECT 1 — currency-ratchet test ────────────────────────────────────
    //
    // MUST hold ZERO monetary evidence: no headline budget, no budget lines,
    // no BOQ items, no POs/claims/invoices/receipts/payments/forecast/cash-flow
    // lines, and currencyLocked FALSE. That is what makes it possible to prove
    // an UNPRICED BOQ item does not lock the currency, and that pricing it
    // later does.
    await setDoc(doc(db, `companies/${COMPANY_ID}/projects`, PROJECT_CURRENCY_ID), {
      name: 'BOQ Currency Test Project',
      status: 'Planning',
      budget: 0,
      startDate: null,
      location: 'Sydney NSW',
      progress: 0,
      currency: 'AUD',
      currencyLocked: false,
      createdAt: now,
      createdBy: ETIENNE_UID,
    })

    // ── PROJECT 2 — BOQ vs Approved Budget test ──────────────────────────────
    //
    // Carries budget lines, which ARE monetary evidence, so its currency is
    // already locked — exactly as the app would have left it.
    await setDoc(doc(db, `companies/${COMPANY_ID}/projects`, PROJECT_COMPARISON_ID), {
      name: 'BOQ Comparison Test Project',
      status: 'In Progress',
      budget: 20000,
      startDate: now,
      location: 'Parramatta NSW',
      progress: 0,
      currency: 'AUD',
      currencyLocked: true,
      createdAt: now,
      createdBy: ETIENNE_UID,
    })

    // ── Company-wide cost codes (never lock a currency) ──────────────────────
    // `unit` is what the BOQ item editor prefills from.
    const costCodes = [
      { id: COST_CODE_CONCRETE_ID, code: '0300', name: 'Concrete', unit: 'm3' },
      { id: COST_CODE_FORMWORK_ID, code: '0400', name: 'Formwork', unit: 'm2' },
    ]
    for (const cc of costCodes) {
      await setDoc(doc(db, `companies/${COMPANY_ID}/costCodes`, cc.id), {
        code: cc.code,
        name: cc.name,
        category: '',
        unit: cc.unit,
        isActive: true,
        createdAt: now,
        createdBy: ETIENNE_UID,
      })
    }

    // ── Budget lines on PROJECT 2 only → Approved Budget $20,000 ─────────────
    // `costCodeName` uses the app's exact snapshot format: `${code} — ${name}`.
    // committed/actual/invoiced are the vestigial zeros the app writes at
    // creation and never updates (ADR-3/ADR-4).
    const budgetLines = [
      { id: 'bl-concrete', costCodeId: COST_CODE_CONCRETE_ID, costCodeName: '0300 — Concrete', budgeted: 12000 },
      { id: 'bl-formwork', costCodeId: COST_CODE_FORMWORK_ID, costCodeName: '0400 — Formwork', budgeted: 8000 },
    ]
    for (const bl of budgetLines) {
      await setDoc(doc(db, `companies/${COMPANY_ID}/projects/${PROJECT_COMPARISON_ID}/budgetLines`, bl.id), {
        costCodeId: bl.costCodeId,
        costCodeName: bl.costCodeName,
        budgeted: bl.budgeted,
        committed: 0,
        actual: 0,
        invoiced: 0,
        notes: '',
        createdAt: now,
        createdBy: ETIENNE_UID,
      })
    }

    // NO boqItems are seeded — entering them by hand IS the acceptance test.
  })

  await testEnv.cleanup()

  const seededUids = [ETIENNE_UID, ...(extraUid && extraUid !== ETIENNE_UID ? [extraUid] : [])]
  console.log(JSON.stringify({ ok: true, projectId, seededUids }))
}

main().catch((err) => {
  console.error(`\n  SEED FAILED: ${err.message}\n`)
  process.exit(1)
})
