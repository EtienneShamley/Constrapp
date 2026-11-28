import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing'
import {
  doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, writeBatch,
  runTransaction, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { invoiceTotals } from '../../src/lib/clientInvoices'
import { buildClientCreditNote } from '../../src/lib/clientCreditNotes'
import { buildClientRetentionRelease } from '../../src/lib/clientRetention'
import {
  readLedger, ledgerDocument, applyCredit, applyCreditVoid, applyRelease, applyReleaseVoid,
} from '../../src/lib/clientLedger'
import {
  runClientCreditCreate, runClientCreditUpdate, runClientReleaseCreate, runClientReleaseUpdate,
} from '../../src/lib/clientLedgerActions'

// ── Client credit notes, client retention releases and the invoice ledger ────
// ── Security Rules — emulator tests (ADR-87 / ADR-88 / ADR-89) ───────────────
//
// These verify the RULES, and only the Rules. Since ADR-89 the split is:
//
//   · a CLIENT (financial roles) may create a DRAFT entry, edit a DRAFT and
//     void a DRAFT — nothing else;
//   · POSTING an entry, voiding a POSTED entry and EVERY ledger write belong to
//     the trusted backend (Admin SDK, which bypasses Rules). No client request
//     of any shape may do them.
//
// So the property under test is a NEGATIVE one: there is no client path to a
// posted entry or to a ledger document — not a lone write, not a batch that
// pairs a perfectly correct ledger with a perfectly correct posting (the pair
// the pre-ADR-89 Rules accepted).
//
// ⚠️ WHAT THESE TESTS DO NOT PROVE. The Rules no longer validate a draft's
// FIGURES, the cumulative cap, the ledger arithmetic or the exact retention
// GST at a half-cent tie. Those are the backend's, and are proven (or not) by
// the backend's own tests. The last describe pins that gap explicitly so it
// cannot be mistaken for coverage.
//
// Posted entries and ledger documents are SEEDED with rules disabled, built
// with the app's own builders, standing in for what the backend writes.
//
// SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set.

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = resolve(HERE, '../../firestore.rules')

const PROJECT_ID = 'demo-constrap-test'
const COMPANY_A = 'companyA'
const COMPANY_B = 'companyB'
const PROJECT_A = 'projectA'

const USERS = {
  admin:  { uid: 'u_admin',  role: 'company_admin',   companyId: COMPANY_A },
  pm:     { uid: 'u_pm',     role: 'project_manager', companyId: COMPANY_A },
  qs:     { uid: 'u_qs',     role: 'qs',              companyId: COMPANY_A },
  sub:    { uid: 'u_sub',    role: 'subcontractor',   companyId: COMPANY_A },
  client: { uid: 'u_client', role: 'client',          companyId: COMPANY_A },
  other:  { uid: 'u_other',  role: 'company_admin',   companyId: COMPANY_B },
}
// An unauthenticated caller: no document under users/, no auth on the request.
const ANON = { uid: 'u_anon', role: null, companyId: null, anonymous: true }

const FINANCIAL = [USERS.admin, USERS.pm, USERS.qs]
const OUTSIDERS = [USERS.sub, USERS.client, USERS.other, ANON]
const who = (user) => (user.anonymous ? 'unauthenticated' : `${user.role}${user.companyId === COMPANY_B ? ' of another company' : ''}`)

let testEnv
const ctx = (user) => (user.anonymous
  ? testEnv.unauthenticatedContext().firestore()
  : testEnv.authenticatedContext(user.uid).firestore())
const base = (companyId = COMPANY_A) => ['companies', companyId, 'projects', PROJECT_A]
const invRef = (db, id, c) => doc(db, ...base(c), 'clientInvoices', id)
const ledRef = (db, id, c) => doc(db, ...base(c), 'clientInvoiceLedgers', id)
const cnRef = (db, id, c) => doc(db, ...base(c), 'clientCreditNotes', id)
const rrRef = (db, id, c) => doc(db, ...base(c), 'clientRetentionReleases', id)

// Assertions that say WHICH request surprised us.
async function denied(what, promise) {
  try { await assertFails(promise) } catch (e) {
    throw new Error(`EXPECTED DENIED, but it was not: ${what} — ${e?.message ?? e}`, { cause: e })
  }
}
async function allowed(what, promise) {
  try { return await assertSucceeds(promise) } catch (e) {
    throw new Error(`EXPECTED ALLOWED, but it was refused: ${what} — ${e?.message ?? e}`, { cause: e })
  }
}

// ── Seeded invoices ──────────────────────────────────────────────────────────
// inv1 — mixed tax, 5% retention: S 1500.00, G 100.00, R 75.00, RG 5.00.
const INV1_LINES = [
  { description: 'Stage 1', amount: 1000, taxCode: 'gst', gstAmount: 100, variationId: null, costCodeId: null, costCodeName: null },
  { description: 'Exempt item', amount: 500, taxCode: 'gst_free', gstAmount: 0, variationId: 'cv1', variationNumber: 'CV-0001', costCodeId: null, costCodeName: null },
]
// inv2 — a LEGACY invoice: no retention fields, line GST one cent LOW (40.15 → 4.01).
const INV2_LINES = [
  { description: 'Legacy boundary', amount: 40.15, taxCode: 'gst', gstAmount: 4.01, variationId: null, costCodeId: null, costCodeName: null },
]
// inv3 — small, fully taxable, 10% retention: S 100.00, G 10.00, R 10.00, RG 1.00.
const INV3_LINES = [
  { description: 'Small', amount: 100, taxCode: 'gst', gstAmount: 10, variationId: null, costCodeId: null, costCodeName: null },
]

function invoiceDoc(number, lineItems, { retention = null, status = 'issued', clientId = 'c1', currency = 'AUD' } = {}) {
  const t = invoiceTotals(lineItems, retention ?? 0)
  const money = retention === null
    ? { subtotal: t.subtotal, gstTotal: t.gstTotal, grossTotal: t.grossTotal }
    : t
  return {
    invoiceNumber: number, status, docType: 'invoice',
    clientId, clientName: 'Client One', currency, revision: 1,
    invoiceDate: '2026-11-01', dueDate: '2026-12-01',
    lineItems, ...money,
    issuedAt: status === 'draft' ? null : Timestamp.now(), issuedBy: status === 'draft' ? null : 'u_admin',
    voidedAt: status === 'void' ? Timestamp.now() : null, voidedBy: status === 'void' ? 'u_admin' : null,
    voidReason: status === 'void' ? 'Issued in error' : '',
    createdAt: Timestamp.now(), createdBy: 'u_admin', updatedAt: Timestamp.now(), updatedBy: 'u_admin',
  }
}

const withoutKeys = (body, ...keys) => Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)))

const INVOICES = {
  inv1: invoiceDoc('CI-0001', INV1_LINES, { retention: 75 }),
  inv2: invoiceDoc('CI-0002', INV2_LINES),
  inv3: invoiceDoc('CI-0003', INV3_LINES, { retention: 10 }),
  invDraft: invoiceDoc('CI-0004', INV3_LINES, { retention: 10, status: 'draft' }),
  invOtherClient: invoiceDoc('CI-0005', INV3_LINES, { clientId: 'c2' }),
  invVoid: invoiceDoc('CI-0006', INV3_LINES, { retention: 10, status: 'void' }),
  invNzd: invoiceDoc('CI-0007', INV3_LINES, { retention: 10, currency: 'NZD' }),
  // Stored with rules disabled: a currency no Rules-valid invoice could carry.
  invBadCurrency: invoiceDoc('CI-0008', INV3_LINES, { retention: 10, currency: 'aud' }),
  // An invoice with no clientId field at all (the app stores `clientId ?? null` on the entry).
  invNoClient: withoutKeys(invoiceDoc('CI-0009', INV3_LINES, { retention: 10 }), 'clientId'),
}
const invoice = (id) => ({ id, ...INVOICES[id] })

// ── The application's own DRAFT write paths (they remain client-side) ────────
function deps(user, invoiceId, { creditId = null, releaseId = null } = {}) {
  const db = ctx(user)
  return {
    db, runTransaction, serverTimestamp, uid: user.uid, currency: 'AUD',
    invoiceRef: invRef(db, invoiceId),
    ledgerRef: ledRef(db, invoiceId),
    creditRef: creditId ? cnRef(db, creditId) : doc(collection(db, ...base(), 'clientCreditNotes')),
    releaseRef: releaseId ? rrRef(db, releaseId) : doc(collection(db, ...base(), 'clientRetentionReleases')),
    stageCurrencyLock: async () => () => {},
  }
}

const creditInput = (rows, over = {}) => ({
  creditDate: '2026-11-10', reason: 'Over-billed', clientCreditReference: '', notes: '', rows, ...over,
})
const releaseInput = (amount, over = {}) => ({
  amount, releaseDate: '2026-11-20', reason: 'Practical completion', notes: '', ...over,
})

async function draftCredit(user, invoiceId, rows) {
  const d = deps(user, invoiceId)
  return runClientCreditCreate({
    ...d, counterRef: doc(d.db, 'companies', COMPANY_A, 'counters', 'clientCreditNotes'), input: creditInput(rows),
  })
}
async function draftRelease(user, invoiceId, amount) {
  const d = deps(user, invoiceId)
  return runClientReleaseCreate({
    ...d, counterRef: doc(d.db, 'companies', COMPANY_A, 'counters', 'clientRetentionReleases'), input: releaseInput(amount),
  })
}

// ── Raw documents ────────────────────────────────────────────────────────────
async function admin(fn) {
  let out
  await testEnv.withSecurityRulesDisabled(async (c) => { out = await fn(c.firestore()) })
  return out
}
const read = (ref) => admin(async (db) => {
  const snap = await getDoc(doc(db, ref.path))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
})
const ledgerOf = (invoiceId) => read({ path: ['companies', COMPANY_A, 'projects', PROJECT_A, 'clientInvoiceLedgers', invoiceId].join('/') })

// A draft credit-note document as the app writes it, built against `ledgerDoc`.
function creditDoc(user, invoiceId, rows, ledgerDoc = null, over = {}) {
  const inv = invoice(invoiceId)
  const built = buildClientCreditNote(inv, ledgerDoc, rows)
  if (built.error) throw new Error(built.error)
  return {
    creditNumber: 'CCN-0099', status: 'draft', docType: 'credit_note',
    clientInvoiceId: invoiceId, invoiceNumber: inv.invoiceNumber, clientId: inv.clientId, clientName: inv.clientName,
    creditDate: '2026-11-10', reason: 'Over-billed', clientCreditReference: '', notes: '',
    lineItems: built.lineItems, ...built.totals, ledgerSeq: built.ledgerSeq,
    currency: 'AUD', revision: 1,
    postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  }
}
function releaseDoc(user, invoiceId, amount, ledgerDoc = null, over = {}) {
  const inv = invoice(invoiceId)
  const built = buildClientRetentionRelease(inv, ledgerDoc, amount)
  if (built.error) throw new Error(built.error)
  return {
    releaseNumber: 'CRR-0099', status: 'draft', docType: 'client_retention_release',
    clientInvoiceId: invoiceId, invoiceNumber: inv.invoiceNumber, clientId: inv.clientId, clientName: inv.clientName,
    releaseDate: '2026-11-20', reason: 'Practical completion', notes: '',
    amount: built.amount, gstAmount: built.gstAmount, releaseTotal: built.releaseTotal, ledgerSeq: built.ledgerSeq,
    currency: 'AUD', revision: 1,
    postedAt: null, postedBy: null, voidedAt: null, voidedBy: null, voidReason: '',
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  }
}
// Seeds an entry document with rules disabled (stored stamps are real timestamps).
async function seedEntry(kind, id, body) {
  const stored = { ...body, createdAt: Timestamp.now(), updatedAt: Timestamp.now() }
  await admin((db) => setDoc(doc(db, ...base(), kind, id), stored))
  return { id, ...stored }
}

// ── The two entry kinds — every lifecycle rule is shared, so every test is too.
const KINDS = [
  {
    label: 'client credit note', coll: 'clientCreditNotes', numberKey: 'creditNumber',
    docType: 'credit_note', foreignDocType: 'client_retention_release', ref: cnRef,
    make: (user, invoiceId = 'inv3', over = {}, ledgerDoc = null) =>
      creditDoc(user, invoiceId, [{ invoiceLineIndex: 0, amount: 10 }], ledgerDoc, over),
    apply: applyCredit, applyVoid: applyCreditVoid,
    contentEdit: {
      reason: 'Revised reason', notes: 'A note', creditDate: '2026-11-12', clientCreditReference: 'REF-1',
      subtotal: 20, gstTotal: 2, grossTotal: 22, retentionAmount: 2, retentionGst: 0.2, retentionTotal: 2.2, receivableTotal: 19.8,
    },
  },
  {
    label: 'client retention release', coll: 'clientRetentionReleases', numberKey: 'releaseNumber',
    docType: 'client_retention_release', foreignDocType: 'credit_note', ref: rrRef,
    make: (user, invoiceId = 'inv3', over = {}, ledgerDoc = null) => releaseDoc(user, invoiceId, 5, ledgerDoc, over),
    apply: applyRelease, applyVoid: applyReleaseVoid,
    contentEdit: {
      reason: 'Revised reason', notes: 'A note', releaseDate: '2026-11-22',
      amount: 6, gstAmount: 0.6, releaseTotal: 6.6,
    },
  },
]
const [CREDIT, RELEASE] = KINDS

const seedDraft = (kind, id, invoiceId = 'inv3', by = USERS.admin) => seedEntry(kind.coll, id, kind.make(by, invoiceId))
const seedVoidedDraft = (kind, id, invoiceId = 'inv3', by = USERS.admin) => seedEntry(kind.coll, id, {
  ...kind.make(by, invoiceId), status: 'void', voidedAt: Timestamp.now(), voidedBy: by.uid, voidReason: 'Raised in error',
})

// A ledger document as the BACKEND stores it (rules disabled).
async function seedLedger(invoiceId, state, by = USERS.admin) {
  const before = await ledgerOf(invoiceId)
  const body = {
    ...ledgerDocument(state),
    createdAt: before?.createdAt ?? Timestamp.now(), createdBy: before?.createdBy ?? by.uid,
    updatedAt: Timestamp.now(), updatedBy: by.uid,
  }
  await admin((db) => setDoc(ledRef(db, invoiceId), body))
  return body
}
// What the backend's posting leaves behind: the entry POSTED and the ledger moved by it.
async function seedPosted(kind, id, invoiceId = 'inv3', by = USERS.admin) {
  const before = await ledgerOf(invoiceId)
  const entry = await seedEntry(kind.coll, id, {
    ...kind.make(by, invoiceId, {}, before), status: 'posted', postedAt: Timestamp.now(), postedBy: by.uid,
  })
  await seedLedger(invoiceId, kind.apply(readLedger(before), entry), by)
  return entry
}
// What the backend's void of a POSTED entry leaves behind.
async function seedPostedThenVoided(kind, id, invoiceId = 'inv3', by = USERS.admin) {
  const entry = await seedPosted(kind, id, invoiceId, by)
  const before = await ledgerOf(invoiceId)
  await seedLedger(invoiceId, kind.applyVoid(readLedger(before), entry), by)
  const patch = { status: 'void', voidedAt: Timestamp.now(), voidedBy: by.uid, voidReason: 'Posted in error', updatedAt: Timestamp.now() }
  await admin((db) => updateDoc(doc(db, ...base(), kind.coll, id), patch))
  return { ...entry, ...patch }
}

const STAMP = (user) => ({ updatedAt: serverTimestamp(), updatedBy: user.uid })
const POST = (user) => ({ status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid, ...STAMP(user) })
const VOID = (user, voidReason = 'Raised in error') => ({ status: 'void', voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason, ...STAMP(user) })
const skewed = (ms) => Timestamp.fromMillis(Date.now() + ms)

// The ledger body a CLIENT would send for `next` — exactly the backend's shape.
function ledgerBody(user, next, { create }) {
  const body = { ...ledgerDocument(next), updatedAt: serverTimestamp(), updatedBy: user.uid }
  return create ? { ...body, createdAt: serverTimestamp(), createdBy: user.uid } : body
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — refusing to run Rules tests outside the emulator. Run `npm run test:rules`.')
  }
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_PATH, 'utf8'), host, port: Number(port) },
  })
})

afterAll(async () => { if (testEnv) await testEnv.cleanup() })

beforeEach(async () => {
  await testEnv.clearFirestore()
  await admin(async (db) => {
    for (const u of Object.values(USERS)) {
      await setDoc(doc(db, 'users', u.uid), { role: u.role, companyId: u.companyId, name: u.uid })
    }
    for (const c of [COMPANY_A, COMPANY_B]) {
      // Activated for client finance (server-written flag) — the default for this
      // suite; the activation describe turns it off.
      await setDoc(doc(db, 'companies', c), { name: c, baseCurrency: 'AUD', clientFinanceEnabled: true })
      await setDoc(doc(db, 'companies', c, 'projects', PROJECT_A), { name: 'P', currency: 'AUD', currencyLocked: true })
    }
    for (const [id, body] of Object.entries(INVOICES)) await setDoc(invRef(db, id), body)
    await setDoc(invRef(db, 'inv1', COMPANY_B), INVOICES.inv1)
    await setDoc(invRef(db, 'inv3', COMPANY_B), INVOICES.inv3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. WHO — roles and tenancy
// ─────────────────────────────────────────────────────────────────────────────

describe('who may read and write — role and tenancy matrix', () => {
  const COLLECTIONS = ['clientCreditNotes', 'clientRetentionReleases', 'clientInvoiceLedgers']

  async function seedOneOfEach() {
    await seedDraft(CREDIT, 'cDraft')
    await seedPosted(CREDIT, 'cPosted')
    await seedDraft(RELEASE, 'rDraft')
    await seedPosted(RELEASE, 'rPosted')
  }

  it('READ: every financial role gets and lists credit notes, releases and ledgers', async () => {
    await seedOneOfEach()
    for (const user of FINANCIAL) {
      const db = ctx(user)
      for (const ref of [cnRef(db, 'cDraft'), cnRef(db, 'cPosted'), rrRef(db, 'rDraft'), rrRef(db, 'rPosted'), ledRef(db, 'inv3')]) {
        const snap = await allowed(`${who(user)} get ${ref.path}`, getDoc(ref))
        expect(snap.exists()).toBe(true)
      }
      // A get of a ledger that does not exist is still a permitted read (the app's draft transactions rely on it).
      await allowed(`${who(user)} get a missing ledger`, getDoc(ledRef(db, 'inv1')))
      for (const name of COLLECTIONS) {
        const list = await allowed(`${who(user)} list ${name}`, getDocs(collection(db, ...base(), name)))
        expect(list.size).toBeGreaterThan(0)
      }
    }
  })

  it('READ: subcontractor, client, another company and an unauthenticated caller get and list nothing', async () => {
    await seedOneOfEach()
    for (const user of OUTSIDERS) {
      const db = ctx(user)
      for (const ref of [cnRef(db, 'cDraft'), cnRef(db, 'cPosted'), rrRef(db, 'rDraft'), rrRef(db, 'rPosted'), ledRef(db, 'inv3'), ledRef(db, 'inv1')]) {
        await denied(`${who(user)} get ${ref.path}`, getDoc(ref))
      }
      for (const name of COLLECTIONS) {
        await denied(`${who(user)} list ${name}`, getDocs(collection(db, ...base(), name)))
      }
    }
    // Control: the same documents are readable by a financial role.
    await allowed('admin get', getDoc(cnRef(ctx(USERS.admin), 'cPosted')))
  })

  it('READ: another company\'s admin reads their own company, never this one — and vice versa', async () => {
    await seedOneOfEach()
    await admin((db) => setDoc(cnRef(db, 'theirs', COMPANY_B), CREDIT.make(USERS.other, 'inv3')))
    await allowed('other admin reads own company', getDoc(cnRef(ctx(USERS.other), 'theirs', COMPANY_B)))
    await allowed('other admin lists own company', getDocs(collection(ctx(USERS.other), ...base(COMPANY_B), 'clientCreditNotes')))
    for (const user of FINANCIAL) {
      await denied(`${who(user)} get company B credit`, getDoc(cnRef(ctx(user), 'theirs', COMPANY_B)))
      await denied(`${who(user)} get company B ledger`, getDoc(ledRef(ctx(user), 'inv3', COMPANY_B)))
      for (const name of COLLECTIONS) {
        await denied(`${who(user)} list company B ${name}`, getDocs(collection(ctx(user), ...base(COMPANY_B), name)))
      }
    }
  })

  it('DRAFT CREATE: every financial role may; subcontractor, client, another company and unauthenticated may not', async () => {
    for (const kind of KINDS) {
      for (const user of FINANCIAL) {
        await allowed(`${who(user)} creates a draft ${kind.label}`, setDoc(kind.ref(ctx(user), `by_${user.uid}`), kind.make(user)))
      }
      for (const user of OUTSIDERS) {
        // The body is stamped with the CALLER's own uid, so the only thing wrong with it is who is asking.
        await denied(`${who(user)} creates a draft ${kind.label}`, setDoc(kind.ref(ctx(user), `by_${user.uid}`), kind.make(user)))
      }
    }
  })

  it('DRAFT EDIT: every financial role may edit any draft of the company; the others may not', async () => {
    for (const kind of KINDS) {
      await seedDraft(kind, 'd1')
      for (const user of FINANCIAL) {
        await allowed(`${who(user)} edits a draft ${kind.label}`,
          updateDoc(kind.ref(ctx(user), 'd1'), { reason: `Edited by ${user.uid}`, ...STAMP(user) }))
      }
      for (const user of OUTSIDERS) {
        await denied(`${who(user)} edits a draft ${kind.label}`,
          updateDoc(kind.ref(ctx(user), 'd1'), { reason: `Edited by ${user.uid}`, ...STAMP(user) }))
      }
      expect((await read(kind.ref(ctx(USERS.admin), 'd1'))).reason).toBe('Edited by u_qs')
    }
  })

  it('DRAFT VOID: every financial role may void a draft; the others may not', async () => {
    for (const kind of KINDS) {
      for (const user of FINANCIAL) await seedDraft(kind, `v_${user.uid}`)
      await seedDraft(kind, 'target')
      for (const user of OUTSIDERS) {
        await denied(`${who(user)} voids a draft ${kind.label}`, updateDoc(kind.ref(ctx(user), 'target'), VOID(user)))
      }
      for (const user of FINANCIAL) {
        await allowed(`${who(user)} voids a draft ${kind.label}`, updateDoc(kind.ref(ctx(user), `v_${user.uid}`), VOID(user)))
      }
      expect((await read(kind.ref(ctx(USERS.admin), 'target'))).status).toBe('draft')
    }
  })

  it('DELETE: nobody deletes a draft, posted or void entry, or a ledger — not even a company admin', async () => {
    await seedOneOfEach()
    await seedVoidedDraft(CREDIT, 'cVoid')
    await seedVoidedDraft(RELEASE, 'rVoid')
    for (const user of [...FINANCIAL, ...OUTSIDERS]) {
      const db = ctx(user)
      const refs = [
        cnRef(db, 'cDraft'), cnRef(db, 'cPosted'), cnRef(db, 'cVoid'),
        rrRef(db, 'rDraft'), rrRef(db, 'rPosted'), rrRef(db, 'rVoid'), ledRef(db, 'inv3'),
      ]
      for (const ref of refs) await denied(`${who(user)} delete ${ref.path}`, deleteDoc(ref))
    }
    // Control: the path and the membership are good — the same admin may EDIT that draft.
    await allowed('admin edits the draft it could not delete',
      updateDoc(cnRef(ctx(USERS.admin), 'cDraft'), { notes: 'still here', ...STAMP(USERS.admin) }))
    for (const path of ['clientCreditNotes/cDraft', 'clientCreditNotes/cPosted', 'clientRetentionReleases/rPosted', 'clientInvoiceLedgers/inv3']) {
      expect(await read({ path: [...base(), path].join('/') })).not.toBeNull()
    }
  })

  it('CROSS-COMPANY WRITES: membership is of the company in the PATH, in both directions', async () => {
    for (const kind of KINDS) {
      // Company B's admin into company A.
      await denied('other admin creates in A', setDoc(kind.ref(ctx(USERS.other), 'x'), kind.make(USERS.other)))
      // Company A's roles into company B.
      for (const user of FINANCIAL) {
        await denied(`${who(user)} creates in B`, setDoc(kind.ref(ctx(user), 'x', COMPANY_B), kind.make(user)))
      }
      // Control: company B's admin in company B, under the same rules.
      await allowed('other admin creates in B', setDoc(kind.ref(ctx(USERS.other), 'x', COMPANY_B), kind.make(USERS.other)))
      // …and that draft is not company A's to edit, void or delete.
      await denied('admin of A edits B draft', updateDoc(kind.ref(ctx(USERS.admin), 'x', COMPANY_B), { reason: 'hijack', ...STAMP(USERS.admin) }))
      await denied('admin of A voids B draft', updateDoc(kind.ref(ctx(USERS.admin), 'x', COMPANY_B), VOID(USERS.admin)))
      await allowed('other admin edits own draft', updateDoc(kind.ref(ctx(USERS.other), 'x', COMPANY_B), { reason: 'ours', ...STAMP(USERS.other) }))
    }
    // The target invoice is resolved inside the PATH's company: an invoice id that exists only in A is "missing" in B.
    await denied('B draft naming an invoice that exists only in A',
      setDoc(cnRef(ctx(USERS.other), 'y', COMPANY_B), CREDIT.make(USERS.other, 'inv3', { clientInvoiceId: 'inv2' })))
  })

  it('the app\'s own draft transactions are accepted for every financial role (create, then re-save)', async () => {
    for (const user of FINANCIAL) {
      const creditId = await allowed(`${who(user)} runClientCreditCreate`, draftCredit(user, 'inv1', [{ invoiceLineIndex: 0, amount: 100 }]))
      await allowed(`${who(user)} runClientCreditUpdate`, runClientCreditUpdate({
        ...deps(user, 'inv1', { creditId }), input: creditInput([{ invoiceLineIndex: 0, amount: 200 }, { invoiceLineIndex: 1, amount: 50 }]),
      }))
      const credit = await read(cnRef(ctx(USERS.admin), creditId))
      expect(credit).toMatchObject({ status: 'draft', subtotal: 250, createdBy: user.uid, postedAt: null })

      const releaseId = await allowed(`${who(user)} runClientReleaseCreate`, draftRelease(user, 'inv1', 10))
      await allowed(`${who(user)} runClientReleaseUpdate`, runClientReleaseUpdate({
        ...deps(user, 'inv1', { releaseId }), input: releaseInput(25),
      }))
      const release = await read(rrRef(ctx(USERS.admin), releaseId))
      expect(release).toMatchObject({ status: 'draft', amount: 25, createdBy: user.uid, postedAt: null })
    }
    // Drafting never touches a ledger.
    expect(await ledgerOf('inv1')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. DRAFT CREATE — every clause of ciDraft
// ─────────────────────────────────────────────────────────────────────────────

describe.each(KINDS)('$label — draft create shape (ciDraft)', (kind) => {
  let n = 0
  const tryCreate = (over = {}, { omit = [], user = USERS.admin } = {}) => {
    n += 1
    return setDoc(kind.ref(ctx(user), `shape${n}`), withoutKeys(kind.make(user, 'inv3', over), ...omit))
  }
  const control = () => allowed(`the unmodified draft ${kind.label}`, tryCreate())

  it('the draft the app builds is accepted', async () => {
    await control()
  })

  it('docType, number and revision: wrong document type, non-string number, non-numeric revision refused', async () => {
    await denied('the other kind\'s docType', tryCreate({ docType: kind.foreignDocType }))
    await denied('docType invoice', tryCreate({ docType: 'invoice' }))
    await denied('docType missing', tryCreate({}, { omit: ['docType'] }))
    await denied('number not a string', tryCreate({ [kind.numberKey]: 99 }))
    await denied('number missing', tryCreate({}, { omit: [kind.numberKey] }))
    await denied('revision not a number', tryCreate({ revision: 'one' }))
    await denied('revision missing', tryCreate({}, { omit: ['revision'] }))
    await control()
  })

  it('target: missing, blank, non-string, or naming a draft, void or non-existent invoice refused', async () => {
    await denied('clientInvoiceId missing', tryCreate({}, { omit: ['clientInvoiceId'] }))
    await denied('clientInvoiceId blank', tryCreate({ clientInvoiceId: '' }))
    await denied('clientInvoiceId not a string', tryCreate({ clientInvoiceId: 3 }))
    await denied('clientInvoiceId null', tryCreate({ clientInvoiceId: null }))
    await denied('target is a DRAFT invoice', tryCreate({ clientInvoiceId: 'invDraft', invoiceNumber: 'CI-0004' }))
    await denied('target is a VOID invoice', tryCreate({ clientInvoiceId: 'invVoid', invoiceNumber: 'CI-0006' }))
    await denied('target does not exist', tryCreate({ clientInvoiceId: 'missing' }))
    // Control: a different ISSUED invoice of the same client and currency is a valid target.
    await allowed('target inv1', tryCreate({ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001' }))
  })

  it('client and currency must be the invoice\'s own', async () => {
    await denied('another client id against this invoice', tryCreate({ clientId: 'c2' }))
    await denied('this client id against another client\'s invoice', tryCreate({ clientInvoiceId: 'invOtherClient', invoiceNumber: 'CI-0005' }))
    await denied('clientId null against an invoice that has one', tryCreate({ clientId: null }))
    await denied('another currency against this invoice', tryCreate({ currency: 'NZD' }))
    await denied('this currency against an NZD invoice', tryCreate({ clientInvoiceId: 'invNzd', invoiceNumber: 'CI-0007' }))
    await denied('currency missing', tryCreate({}, { omit: ['currency'] }))
    // Controls: the matching client / currency IS accepted on those same invoices.
    await allowed('other client\'s invoice with that client', tryCreate({ clientInvoiceId: 'invOtherClient', invoiceNumber: 'CI-0005', clientId: 'c2' }))
    await allowed('NZD invoice with NZD', tryCreate({ clientInvoiceId: 'invNzd', invoiceNumber: 'CI-0007', currency: 'NZD' }))
    // An invoice storing no clientId pairs with the `null` the app stores.
    await allowed('invoice without clientId, entry clientId null', tryCreate({ clientInvoiceId: 'invNoClient', invoiceNumber: 'CI-0009', clientId: null }))
    await denied('invoice without clientId, entry names a client', tryCreate({ clientInvoiceId: 'invNoClient', invoiceNumber: 'CI-0009', clientId: 'c1' }))
  })

  it('currency shape: a currency that is not three capitals is refused even when it equals the invoice\'s', async () => {
    // invBadCurrency stores 'aud' (seeded with rules disabled), so ONLY the shape clause can refuse this.
    await denied('lower-case currency matching the invoice', tryCreate({ clientInvoiceId: 'invBadCurrency', invoiceNumber: 'CI-0008', currency: 'aud' }))
    await control()
  })

  it('snapshots and text: invoiceNumber / clientName must be strings; reason non-blank and at most 1000; notes a string', async () => {
    await denied('invoiceNumber not a string', tryCreate({ invoiceNumber: 3 }))
    await denied('invoiceNumber missing', tryCreate({}, { omit: ['invoiceNumber'] }))
    await denied('clientName not a string', tryCreate({ clientName: null }))
    await denied('clientName missing', tryCreate({}, { omit: ['clientName'] }))
    await denied('reason empty', tryCreate({ reason: '' }))
    await denied('reason blank', tryCreate({ reason: '   \n\t ' }))
    await denied('reason not a string', tryCreate({ reason: 7 }))
    await denied('reason missing', tryCreate({}, { omit: ['reason'] }))
    await denied('reason 1001 characters', tryCreate({ reason: 'x'.repeat(1001) }))
    await denied('notes a number', tryCreate({ notes: 7 }))
    await denied('notes null', tryCreate({ notes: null }))
    await denied('notes a list', tryCreate({ notes: ['a'] }))
    await denied('notes missing', tryCreate({}, { omit: ['notes'] }))
    // Controls: the boundary values.
    await allowed('reason exactly 1000 characters', tryCreate({ reason: 'x'.repeat(1000) }))
    await allowed('empty notes', tryCreate({ notes: '' }))
  })

  it('lineItems: a list of at most 100 when present', async () => {
    const line = { invoiceLineIndex: 0, amount: 0.01, gstAmount: 0 }
    await denied('101 lines', tryCreate({ lineItems: Array.from({ length: 101 }, () => line) }))
    await denied('lineItems a string', tryCreate({ lineItems: 'none' }))
    await denied('lineItems a map', tryCreate({ lineItems: { 0: line } }))
    await allowed('exactly 100 lines', tryCreate({ lineItems: Array.from({ length: 100 }, () => line) }))
    await allowed('lineItems absent', tryCreate({}, { omit: ['lineItems'] }))
  })

  it('stamps cannot be forged: createdBy / updatedBy are the caller, createdAt / updatedAt the server time', async () => {
    await denied('createdBy another user', tryCreate({ createdBy: USERS.pm.uid }))
    await denied('updatedBy another user', tryCreate({ updatedBy: USERS.pm.uid }))
    await denied('createdBy missing', tryCreate({}, { omit: ['createdBy'] }))
    await denied('updatedBy missing', tryCreate({}, { omit: ['updatedBy'] }))
    await denied('createdAt missing', tryCreate({}, { omit: ['createdAt'] }))
    await denied('updatedAt missing', tryCreate({}, { omit: ['updatedAt'] }))
    await denied('createdAt null', tryCreate({ createdAt: null }))
    // Client clocks, skewed both ways and by a little and a lot.
    for (const ms of [-86_400_000, -300_000, -60_000, -1_000, 1_000, 60_000, 300_000, 86_400_000]) {
      await denied(`createdAt client clock ${ms} ms`, tryCreate({ createdAt: skewed(ms) }))
      await denied(`updatedAt client clock ${ms} ms`, tryCreate({ updatedAt: skewed(ms) }))
    }
    await denied('createdAt a fixed past date', tryCreate({ createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) }))
    await denied('createdAt an ISO string', tryCreate({ createdAt: new Date().toISOString() }))
    // A pm stamping itself is fine — the stamp is the caller's, whoever the caller is.
    await allowed('pm stamps itself', tryCreate({}, { user: USERS.pm }))
  })

  it('lifecycle cannot be pre-set: no posted / void status and no lifecycle stamp at create', async () => {
    const me = USERS.admin
    await denied('created POSTED with posting stamps', tryCreate({ status: 'posted', postedAt: serverTimestamp(), postedBy: me.uid }))
    await denied('created POSTED without stamps', tryCreate({ status: 'posted' }))
    await denied('created VOID with void stamps', tryCreate({ status: 'void', voidedAt: serverTimestamp(), voidedBy: me.uid, voidReason: 'x' }))
    await denied('created VOID without stamps', tryCreate({ status: 'void' }))
    await denied('created with an unknown status', tryCreate({ status: 'issued' }))
    await denied('status missing', tryCreate({}, { omit: ['status'] }))
    await denied('draft with postedAt', tryCreate({ postedAt: serverTimestamp() }))
    await denied('draft with postedBy', tryCreate({ postedBy: me.uid }))
    await denied('draft with voidedAt', tryCreate({ voidedAt: serverTimestamp() }))
    await denied('draft with voidedBy', tryCreate({ voidedBy: me.uid }))
    await denied('draft with every lifecycle stamp', tryCreate({ postedAt: serverTimestamp(), postedBy: me.uid, voidedAt: serverTimestamp(), voidedBy: me.uid }))
    for (const key of ['postedAt', 'postedBy', 'voidedAt', 'voidedBy']) {
      await denied(`${key} missing`, tryCreate({}, { omit: [key] }))
    }
    await control()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. DRAFT EDIT
// ─────────────────────────────────────────────────────────────────────────────

describe.each(KINDS)('$label — draft edit (ciDraftUpdate)', (kind) => {
  const edit = (patch, user = USERS.admin, id = 'd1') => updateDoc(kind.ref(ctx(user), id), patch)
  const me = USERS.admin

  beforeEach(async () => { await seedDraft(kind, 'd1') })

  it('content edits are accepted, by a role other than the author', async () => {
    await allowed('pm edits content', edit({ ...kind.contentEdit, ...STAMP(USERS.pm) }, USERS.pm))
    const stored = await read(kind.ref(ctx(me), 'd1'))
    expect(stored).toMatchObject({ ...kind.contentEdit, status: 'draft', createdBy: me.uid, updatedBy: USERS.pm.uid, postedAt: null, postedBy: null })
  })

  it('the target, the number, the snapshots and the document core are each frozen', async () => {
    // inv1 is a perfectly valid target for a NEW draft — only the freeze refuses the move.
    await denied('retarget to another issued invoice', edit({ clientInvoiceId: 'inv1', ...STAMP(me) }))
    await denied('retarget with its snapshot', edit({ clientInvoiceId: 'inv1', invoiceNumber: 'CI-0001', ...STAMP(me) }))
    await denied('renumber', edit({ [kind.numberKey]: 'XX-9999', ...STAMP(me) }))
    await denied('invoiceNumber', edit({ invoiceNumber: 'CI-9999', ...STAMP(me) }))
    await denied('clientName', edit({ clientName: 'Someone else', ...STAMP(me) }))
    await denied('clientId', edit({ clientId: 'c2', ...STAMP(me) }))
    await denied('currency', edit({ currency: 'NZD', ...STAMP(me) }))
    await denied('docType', edit({ docType: kind.foreignDocType, ...STAMP(me) }))
    await denied('revision', edit({ revision: 2, ...STAMP(me) }))
    await denied('createdBy', edit({ createdBy: USERS.pm.uid, ...STAMP(me) }))
    await denied('createdAt to now', edit({ createdAt: serverTimestamp(), ...STAMP(me) }))
    await denied('createdAt to the past', edit({ createdAt: skewed(-86_400_000), ...STAMP(me) }))
    // Control: the same request without the frozen key.
    await allowed('content only', edit({ notes: 'fine', ...STAMP(me) }))
  })

  it('an edit must carry the caller and the server time', async () => {
    await denied('no stamps at all', edit({ notes: 'unstamped' }))
    await denied('updatedBy only', edit({ notes: 'x', updatedBy: me.uid }))
    await denied('updatedBy another user', edit({ notes: 'x', updatedAt: serverTimestamp(), updatedBy: USERS.pm.uid }))
    await denied('updatedAt client clock behind', edit({ notes: 'x', updatedAt: skewed(-60_000), updatedBy: me.uid }))
    await denied('updatedAt client clock ahead', edit({ notes: 'x', updatedAt: skewed(60_000), updatedBy: me.uid }))
    await allowed('stamped', edit({ notes: 'x', ...STAMP(me) }))
  })

  it('an edit is re-validated as a draft: blank reason, long reason, bad notes, oversized lines refused', async () => {
    await denied('blank reason', edit({ reason: '  ', ...STAMP(me) }))
    await denied('reason over 1000', edit({ reason: 'x'.repeat(1001), ...STAMP(me) }))
    await denied('notes a number', edit({ notes: 5, ...STAMP(me) }))
    await denied('101 lines', edit({ lineItems: Array.from({ length: 101 }, () => ({ amount: 1 })), ...STAMP(me) }))
    await denied('unknown status', edit({ status: 'issued', ...STAMP(me) }))
    await allowed('reason of 1000', edit({ reason: 'x'.repeat(1000), ...STAMP(me) }))
  })

  it('an edit cannot smuggle postedAt / postedBy or the void stamps onto a draft', async () => {
    await denied('postedAt', edit({ notes: 'x', postedAt: serverTimestamp(), ...STAMP(me) }))
    await denied('postedBy', edit({ notes: 'x', postedBy: me.uid, ...STAMP(me) }))
    await denied('postedAt and postedBy', edit({ notes: 'x', postedAt: serverTimestamp(), postedBy: me.uid, ...STAMP(me) }))
    await denied('postedAt a past time', edit({ postedAt: skewed(-60_000), postedBy: me.uid, ...STAMP(me) }))
    await denied('voidedAt', edit({ notes: 'x', voidedAt: serverTimestamp(), ...STAMP(me) }))
    await denied('voidedBy', edit({ notes: 'x', voidedBy: me.uid, ...STAMP(me) }))
    await allowed('the same edit without them', edit({ notes: 'x', ...STAMP(me) }))
    expect(await read(kind.ref(ctx(me), 'd1'))).toMatchObject({ status: 'draft', postedAt: null, postedBy: null, voidedAt: null, voidedBy: null })
  })

  it('once its invoice is void a draft can no longer be edited — only voided', async () => {
    await admin((db) => updateDoc(invRef(db, 'inv3'), { status: 'void' }))
    await denied('edit against a void invoice', edit({ notes: 'too late', ...STAMP(me) }))
    await allowed('void the draft', edit(VOID(me)))
  })

  it('an update of a document that does not exist is refused, and a set over a draft is judged as an edit', async () => {
    await denied('update of a missing entry', edit({ notes: 'x', ...STAMP(me) }, me, 'nope'))
    // setDoc over an existing draft is an UPDATE: createdAt would move, so it is refused…
    await denied('overwrite with a fresh body', setDoc(kind.ref(ctx(me), 'd1'), kind.make(me)))
    // …while a merge that leaves the frozen fields alone is an ordinary edit.
    await allowed('merge edit', setDoc(kind.ref(ctx(me), 'd1'), { notes: 'merged', ...STAMP(me) }, { merge: true }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. DIRECT BYPASS ATTEMPTS — posting and the ledger are the backend's alone
// ─────────────────────────────────────────────────────────────────────────────

describe.each(KINDS)('$label — direct bypass attempts are denied for every financial role', (kind) => {
  const entryPath = (id) => ({ path: [...base(), kind.coll, id].join('/') })

  it('CONTROL: a batch of two legitimate draft writes commits (batches themselves are not what is refused)', async () => {
    await seedDraft(kind, 'd1')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(kind.ref(db, 'd1'), { notes: `batched by ${user.uid}`, ...STAMP(user) })
      batch.set(kind.ref(db, `new_${user.uid}`), kind.make(user))
      await allowed(`${who(user)} batch of draft writes`, batch.commit())
    }
  })

  it('DRAFT → POSTED alone is denied', async () => {
    await seedDraft(kind, 'd1')
    for (const user of FINANCIAL) {
      await denied(`${who(user)} posts by update`, updateDoc(kind.ref(ctx(user), 'd1'), POST(user)))
      await denied(`${who(user)} posts with status only`, updateDoc(kind.ref(ctx(user), 'd1'), { status: 'posted', ...STAMP(user) }))
      await denied(`${who(user)} posts by overwrite`, setDoc(kind.ref(ctx(user), 'd1'),
        { ...kind.make(user), status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid }))
      await denied(`${who(user)} posts by merge`, setDoc(kind.ref(ctx(user), 'd1'), POST(user), { merge: true }))
      // Control: the same caller may still edit that same draft.
      await allowed(`${who(user)} edits the draft`, updateDoc(kind.ref(ctx(user), 'd1'), { notes: 'ok', ...STAMP(user) }))
    }
    expect(await read(entryPath('d1'))).toMatchObject({ status: 'draft', postedAt: null, postedBy: null })
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('DRAFT → POSTED with a CORRECT ledger in the same batch is denied (the pair the old Rules accepted)', async () => {
    const draft = await seedDraft(kind, 'd1')
    // Exactly what the backend would write for this posting: the first ledger, moved by this entry.
    const next = kind.apply(readLedger(null), draft)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(kind.ref(db, 'd1'), POST(user))
      batch.set(ledRef(db, 'inv3'), ledgerBody(user, next, { create: true }))
      await denied(`${who(user)} posting + ledger create batch`, batch.commit())
      // The same pair through a transaction.
      await denied(`${who(user)} posting + ledger create transaction`, runTransaction(db, async (tx) => {
        await tx.get(kind.ref(db, 'd1'))
        await tx.get(ledRef(db, 'inv3'))
        tx.set(ledRef(db, 'inv3'), ledgerBody(user, next, { create: true }))
        tx.update(kind.ref(db, 'd1'), POST(user))
      }))
    }
    expect(await read(entryPath('d1'))).toMatchObject({ status: 'draft', postedAt: null })
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('DRAFT → POSTED with a correct ledger UPDATE (a ledger already exists) is denied', async () => {
    await seedPosted(kind, 'earlier')
    const before = await ledgerOf('inv3')
    const draft = await seedEntry(kind.coll, 'd2', kind.make(USERS.admin, 'inv3', {}, before))
    const next = kind.apply(readLedger(before), draft)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(kind.ref(db, 'd2'), POST(user))
      batch.update(ledRef(db, 'inv3'), ledgerBody(user, next, { create: false }))
      await denied(`${who(user)} posting + ledger update batch`, batch.commit())
    }
    expect((await read(entryPath('d2'))).status).toBe('draft')
    expect(await ledgerOf('inv3')).toEqual(before)
  })

  it('an entry cannot be CREATED already posted, with or without its ledger', async () => {
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const body = { ...kind.make(user), status: 'posted', postedAt: serverTimestamp(), postedBy: user.uid }
      await denied(`${who(user)} creates posted`, setDoc(kind.ref(db, `p_${user.uid}`), body))
      const next = kind.apply(readLedger(null), { id: `p_${user.uid}`, ...kind.make(user) })
      const batch = writeBatch(db)
      batch.set(kind.ref(db, `p_${user.uid}`), body)
      batch.set(ledRef(db, 'inv3'), ledgerBody(user, next, { create: true }))
      await denied(`${who(user)} creates posted + ledger`, batch.commit())
      // Control: the same body as a DRAFT is accepted.
      await allowed(`${who(user)} creates the draft`, setDoc(kind.ref(db, `p_${user.uid}`), kind.make(user)))
    }
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('POSTED → VOID is denied, alone and with the correct ledger reversal in the same batch', async () => {
    const posted = await seedPosted(kind, 'p1')
    const before = await ledgerOf('inv3')
    const back = kind.applyVoid(readLedger(before), posted)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await denied(`${who(user)} voids a posted entry`, updateDoc(kind.ref(db, 'p1'), VOID(user)))
      const batch = writeBatch(db)
      batch.update(kind.ref(db, 'p1'), VOID(user))
      batch.update(ledRef(db, 'inv3'), ledgerBody(user, back, { create: false }))
      await denied(`${who(user)} void + ledger reversal batch`, batch.commit())
    }
    // Control: the SAME void request is accepted on a draft — it is the POSTED state that refuses it.
    await seedDraft(kind, 'd1')
    await allowed('void a draft', updateDoc(kind.ref(ctx(USERS.admin), 'd1'), VOID(USERS.admin)))
    expect(await read(entryPath('p1'))).toMatchObject({ status: 'posted', voidedAt: null, voidedBy: null })
    expect(await ledgerOf('inv3')).toEqual(before)
  })

  it('POSTED → DRAFT and any content edit of a posted entry are denied', async () => {
    await seedPosted(kind, 'p1')
    await seedDraft(kind, 'd1')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await denied(`${who(user)} posted → draft`, updateDoc(kind.ref(db, 'p1'), { status: 'draft', postedAt: null, postedBy: null, ...STAMP(user) }))
      await denied(`${who(user)} posted → draft (status only)`, updateDoc(kind.ref(db, 'p1'), { status: 'draft', ...STAMP(user) }))
      await denied(`${who(user)} edits a posted reason`, updateDoc(kind.ref(db, 'p1'), { reason: 'rewritten', ...STAMP(user) }))
      await denied(`${who(user)} edits posted figures`, updateDoc(kind.ref(db, 'p1'), { ...kind.contentEdit, ...STAMP(user) }))
      await denied(`${who(user)} re-stamps a posting`, updateDoc(kind.ref(db, 'p1'), { postedAt: serverTimestamp(), postedBy: user.uid, ...STAMP(user) }))
      await denied(`${who(user)} touches only the stamps`, updateDoc(kind.ref(db, 'p1'), STAMP(user)))
      await denied(`${who(user)} retargets a posted entry`, updateDoc(kind.ref(db, 'p1'), { clientInvoiceId: 'inv1', ...STAMP(user) }))
      // Control: the identical content edit is accepted on a draft.
      await allowed(`${who(user)} same edit on a draft`, updateDoc(kind.ref(db, 'd1'), { ...kind.contentEdit, ...STAMP(user) }))
    }
    expect(await read(entryPath('p1'))).toMatchObject({ status: 'posted', reason: kind.make(USERS.admin).reason })
  })

  it('VOID → anything is denied, whether the entry was voided as a draft or after posting', async () => {
    await seedVoidedDraft(kind, 'vDraft')
    await seedPostedThenVoided(kind, 'vPosted')
    await seedDraft(kind, 'd1')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      for (const id of ['vDraft', 'vPosted']) {
        await denied(`${who(user)} ${id} → draft`, updateDoc(kind.ref(db, id), { status: 'draft', voidedAt: null, voidedBy: null, voidReason: '', ...STAMP(user) }))
        await denied(`${who(user)} ${id} → posted`, updateDoc(kind.ref(db, id), POST(user)))
        await denied(`${who(user)} ${id} voided again`, updateDoc(kind.ref(db, id), VOID(user, 'Voided twice')))
        await denied(`${who(user)} ${id} void reason rewritten`, updateDoc(kind.ref(db, id), { voidReason: 'rewritten', ...STAMP(user) }))
        await denied(`${who(user)} ${id} content edit`, updateDoc(kind.ref(db, id), { notes: 'edited', ...STAMP(user) }))
        await denied(`${who(user)} ${id} stamps only`, updateDoc(kind.ref(db, id), STAMP(user)))
      }
      await allowed(`${who(user)} same content edit on a draft`, updateDoc(kind.ref(db, 'd1'), { notes: 'edited', ...STAMP(user) }))
    }
    expect((await read(entryPath('vDraft'))).voidReason).toBe('Raised in error')
    expect((await read(entryPath('vPosted'))).voidReason).toBe('Posted in error')
  })

  it('LEDGER CREATE is denied — including the exact body the backend would write', async () => {
    const posted = await seedEntry(kind.coll, 'p1', { ...kind.make(USERS.admin), status: 'posted', postedAt: Timestamp.now(), postedBy: USERS.admin.uid })
    // The entry IS posted (seeded) and this is precisely its ledger: nothing about the body is wrong.
    const next = kind.apply(readLedger(null), posted)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      await denied(`${who(user)} creates the correct ledger`, setDoc(ledRef(db, 'inv3'), ledgerBody(user, next, { create: true })))
      await denied(`${who(user)} creates an empty ledger`, setDoc(ledRef(db, 'inv3'), ledgerBody(user, { ...readLedger(null), lastEntryId: null, lastEntryKind: null }, { create: true })))
      await denied(`${who(user)} creates a ledger for an invoice with no entries`, setDoc(ledRef(db, 'inv1'), ledgerBody(user, next, { create: true })))
      await denied(`${who(user)} creates a ledger for no invoice at all`, setDoc(ledRef(db, 'no-such-invoice'), ledgerBody(user, next, { create: true })))
      await denied(`${who(user)} creates a ledger by merge`, setDoc(ledRef(db, 'inv3'), { seq: 1 }, { merge: true }))
      // Control: the same caller may READ that path.
      await allowed(`${who(user)} reads the ledger path`, getDoc(ledRef(db, 'inv3')))
    }
    expect(await ledgerOf('inv3')).toBeNull()
    expect(await ledgerOf('inv1')).toBeNull()
  })

  it('LEDGER UPDATE and DELETE are denied — reset, rewind, advance, re-stamp, overwrite', async () => {
    const posted = await seedPosted(kind, 'p1')
    const before = await ledgerOf('inv3')
    const state = readLedger(before)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const ref = ledRef(db, 'inv3')
      await denied(`${who(user)} resets the totals`, updateDoc(ref, { ...ledgerDocument({ ...readLedger(null), lastEntryId: before.lastEntryId, lastEntryKind: before.lastEntryKind }), ...STAMP(user) }))
      await denied(`${who(user)} zeroes one total`, updateDoc(ref, { creditedSubtotalCents: 0, releasedRetentionCents: 0, ...STAMP(user) }))
      await denied(`${who(user)} rewinds seq`, updateDoc(ref, { seq: 0, ...STAMP(user) }))
      await denied(`${who(user)} advances seq`, updateDoc(ref, { seq: before.seq + 1, ...STAMP(user) }))
      await denied(`${who(user)} rewrites lines`, updateDoc(ref, { lines: {}, ...STAMP(user) }))
      await denied(`${who(user)} re-stamps only`, updateDoc(ref, STAMP(user)))
      await denied(`${who(user)} applies the correct reversal`, updateDoc(ref, ledgerBody(user, kind.applyVoid(state, posted), { create: false })))
      await denied(`${who(user)} applies a correct second movement`, updateDoc(ref, ledgerBody(user, kind.apply(state, { ...posted, id: 'p2' }), { create: false })))
      await denied(`${who(user)} overwrites with an identical body`, setDoc(ref,
        ledgerBody(user, { ...state, lastEntryId: before.lastEntryId, lastEntryKind: before.lastEntryKind }, { create: true })))
      await denied(`${who(user)} deletes the ledger`, deleteDoc(ref))
      const batch = writeBatch(db)
      batch.delete(ref)
      await denied(`${who(user)} deletes the ledger in a batch`, batch.commit())
      await allowed(`${who(user)} reads the ledger`, getDoc(ref))
    }
    expect(await ledgerOf('inv3')).toEqual(before)
  })

  it('a ledger write poisons any batch it rides in — even beside an otherwise legitimate draft write', async () => {
    await seedPosted(kind, 'p1')
    await seedDraft(kind, 'd1')
    const before = await ledgerOf('inv3')
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(kind.ref(db, 'd1'), { notes: 'legit', ...STAMP(user) })
      batch.update(ledRef(db, 'inv3'), STAMP(user))
      await denied(`${who(user)} draft edit + ledger touch`, batch.commit())
      const alone = writeBatch(db)
      alone.update(kind.ref(db, 'd1'), { notes: 'legit', ...STAMP(user) })
      await allowed(`${who(user)} the draft edit alone`, alone.commit())
    }
    expect(await ledgerOf('inv3')).toEqual(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. DRAFT VOID
// ─────────────────────────────────────────────────────────────────────────────

describe.each(KINDS)('$label — voiding a DRAFT', (kind) => {
  const me = USERS.admin
  const act = (patch, id = 'd1', user = me) => updateDoc(kind.ref(ctx(user), id), patch)

  beforeEach(async () => { await seedDraft(kind, 'd1') })

  it('a draft is voided with a reason, and no ledger comes into being', async () => {
    await allowed('void', act(VOID(me, 'Raised against the wrong invoice')))
    expect(await read(kind.ref(ctx(me), 'd1'))).toMatchObject({
      status: 'void', voidedBy: me.uid, voidReason: 'Raised against the wrong invoice', postedAt: null, postedBy: null,
    })
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('a reason is required: missing, empty, blank or non-string refused', async () => {
    await denied('voidReason left as stored (empty)', act(withoutKeys(VOID(me), 'voidReason')))
    await denied('empty', act(VOID(me, '')))
    await denied('blank', act(VOID(me, '  \n ')))
    await denied('a number', act(VOID(me, 7)))
    await denied('null', act(VOID(me, null)))
    await allowed('one character', act(VOID(me, 'x')))
  })

  it('only the void keys may change', async () => {
    await denied('reason changed while voiding', act({ ...VOID(me), reason: 'rewritten' }))
    await denied('figures changed while voiding', act({ ...VOID(me), ...kind.contentEdit }))
    await denied('retargeted while voiding', act({ ...VOID(me), clientInvoiceId: 'inv1' }))
    await denied('posting stamps set while voiding', act({ ...VOID(me), postedAt: serverTimestamp(), postedBy: me.uid }))
    await denied('an extra field while voiding', act({ ...VOID(me), extra: true }))
    await denied('createdBy changed while voiding', act({ ...VOID(me), createdBy: USERS.pm.uid }))
    await allowed('the void alone', act(VOID(me)))
  })

  it('the void is stamped with the caller and the server time', async () => {
    await denied('voidedBy another user', act({ ...VOID(me), voidedBy: USERS.pm.uid }))
    await denied('voidedBy missing', act(withoutKeys(VOID(me), 'voidedBy')))
    await denied('voidedAt missing', act(withoutKeys(VOID(me), 'voidedAt')))
    await denied('voidedAt client clock behind', act({ ...VOID(me), voidedAt: skewed(-60_000) }))
    await denied('voidedAt client clock ahead', act({ ...VOID(me), voidedAt: skewed(60_000) }))
    await denied('updatedBy another user', act({ ...VOID(me), updatedBy: USERS.pm.uid }))
    await denied('updatedAt client clock', act({ ...VOID(me), updatedAt: skewed(-60_000) }))
    await denied('no update stamps', act(withoutKeys(VOID(me), 'updatedAt', 'updatedBy')))
    await denied('void stamps without the status', act(withoutKeys(VOID(me), 'status')))
    await allowed('properly stamped', act(VOID(me)))
  })

  it('a draft void cannot carry a ledger write, and a draft whose invoice is void can still be voided', async () => {
    const draft = await read(kind.ref(ctx(me), 'd1'))
    const db = ctx(me)
    const batch = writeBatch(db)
    batch.update(kind.ref(db, 'd1'), VOID(me))
    batch.set(ledRef(db, 'inv3'), ledgerBody(me, kind.applyVoid(readLedger(null), draft), { create: true }))
    await denied('draft void + ledger', batch.commit())
    await admin((adminDb) => updateDoc(invRef(adminDb, 'inv3'), { status: 'void' }))
    await allowed('void after the invoice was voided', act(VOID(me)))
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('a voided draft is final', async () => {
    await allowed('void', act(VOID(me)))
    await denied('edit', act({ notes: 'x', ...STAMP(me) }))
    await denied('back to draft', act({ status: 'draft', voidedAt: null, voidedBy: null, voidReason: '', ...STAMP(me) }))
    await denied('post', act(POST(me)))
    await denied('void again', act(VOID(me, 'again')))
    await denied('delete', deleteDoc(kind.ref(ctx(me), 'd1')))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. INVOICE VOID vs the ledger
// ─────────────────────────────────────────────────────────────────────────────

// Phase 2 step 5 (D8) — CHANGED EXPECTATIONS. Before it, an ISSUED invoice was
// voided by the browser under `ledgerClear()` (no posted credit or release);
// receipts were NOT checked — Rules cannot read a receipt. Since step 5 an
// issued invoice is voided ONLY by the trusted callable `voidClientInvoice`,
// which refuses while its ledger records ANY money (receipts — including those
// posted before the backend took over, through the receipt baseline —
// applications, refunds, credits, releases): tests/functions/clientSettlement.test.js.
// So every issued-invoice void below is now REFUSED by the Rules, for every
// role, whatever the ledger says — each former "allowed" became "denied"
// (stronger), each former "denied" is still denied. A DRAFT invoice (it
// billed nothing, so it can carry no ledger money) is still voided here.
describe('voiding an invoice against its ledger (Rules: drafts only since Phase 2 step 5)', () => {
  const voidInvoice = (id, user = USERS.admin) => updateDoc(invRef(ctx(user), id), {
    status: 'void', voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: 'Issued in error',
    updatedAt: serverTimestamp(), updatedBy: user.uid,
  })
  const statusOf = async (id) => (await read(invRef(ctx(USERS.admin), id))).status

  it('an ISSUED invoice with NO ledger is refused for every financial role (was allowed; the backend decides now)', async () => {
    await denied('admin voids inv2', voidInvoice('inv2', USERS.admin))
    await denied('pm voids inv1', voidInvoice('inv1', USERS.pm))
    await denied('qs voids inv3', voidInvoice('inv3', USERS.qs))
    for (const id of ['inv1', 'inv2', 'inv3']) expect(await statusOf(id)).toBe('issued')
  })

  it('a DRAFT invoice is still voided by every financial role', async () => {
    for (const [i, user] of FINANCIAL.entries()) {
      await admin((db) => setDoc(invRef(db, `draft${i}`), { ...INVOICES.invDraft, invoiceNumber: `CI-01${i}` }))
      await allowed(`${who(user)} voids a draft`, voidInvoice(`draft${i}`, user))
      expect(await statusOf(`draft${i}`)).toBe('void')
    }
  })

  it('outstanding DRAFT credit notes and releases change nothing: the issued invoice is still refused', async () => {
    await seedDraft(CREDIT, 'c1')
    await seedDraft(RELEASE, 'r1')
    await seedVoidedDraft(CREDIT, 'c2')
    expect(await ledgerOf('inv3')).toBeNull()
    await denied('void with drafts outstanding', voidInvoice('inv3'))
  })

  it('a ledger whose totals are ZERO, or an empty ledger, does not open the Rules path either', async () => {
    await seedPostedThenVoided(CREDIT, 'c1', 'inv3')
    expect(await ledgerOf('inv3')).toMatchObject({ seq: 2, creditedSubtotalCents: 0, releasedRetentionCents: 0 })
    await denied('void with a zeroed ledger', voidInvoice('inv3', USERS.pm))
    await seedLedger('inv1', { ...readLedger(null), lastEntryId: null, lastEntryKind: null })
    await denied('void with an empty ledger', voidInvoice('inv1', USERS.qs))
  })

  it('DENIED for admin, pm and qs while the ledger shows a CREDITED amount, and still denied once it returns to zero', async () => {
    const posted = await seedPosted(CREDIT, 'c1', 'inv3')
    expect((await ledgerOf('inv3')).creditedSubtotalCents).toBe(1000)
    for (const user of FINANCIAL) await denied(`${who(user)} voids a credited invoice`, voidInvoice('inv3', user))
    expect(await statusOf('inv3')).toBe('issued')
    await seedLedger('inv3', applyCreditVoid(readLedger(await ledgerOf('inv3')), posted))
    expect((await ledgerOf('inv3')).creditedSubtotalCents).toBe(0)
    await denied('void once the ledger is back to zero', voidInvoice('inv3', USERS.qs))
  })

  it('DENIED for admin, pm and qs while the ledger shows a RELEASED amount, and still denied once it returns to zero', async () => {
    const posted = await seedPosted(RELEASE, 'r1', 'inv3')
    expect(await ledgerOf('inv3')).toMatchObject({ creditedSubtotalCents: 0, releasedRetentionCents: 500 })
    for (const user of FINANCIAL) await denied(`${who(user)} voids a released invoice`, voidInvoice('inv3', user))
    expect(await statusOf('inv3')).toBe('issued')
    await seedLedger('inv3', applyReleaseVoid(readLedger(await ledgerOf('inv3')), posted))
    await denied('void once the ledger is back to zero', voidInvoice('inv3', USERS.pm))
  })

  it('DENIED while BOTH a credit and a release are posted, and after either is reversed', async () => {
    const credit = await seedPosted(CREDIT, 'c1', 'inv3')
    await seedPosted(RELEASE, 'r1', 'inv3')
    await denied('both posted', voidInvoice('inv3'))
    await seedLedger('inv3', applyCreditVoid(readLedger(await ledgerOf('inv3')), credit))
    for (const user of FINANCIAL) await denied(`${who(user)} voids with the release still posted`, voidInvoice('inv3', user))
  })

  it('a ledger with RECEIVED money (the D8 case Rules could never see) is refused, as is every other issued invoice', async () => {
    await seedLedger('inv2', { ...readLedger(null), receivedCents: 10000, lastEntryId: 'r1', lastEntryKind: 'receipt' })
    for (const user of FINANCIAL) await denied(`${who(user)} voids an invoice that holds receipts`, voidInvoice('inv2', user))
  })

  it('a ledger with a total of the WRONG TYPE, or no totals, changes nothing: issued is refused', async () => {
    await admin((db) => setDoc(ledRef(db, 'inv3'), { seq: 1, creditedSubtotalCents: 'none', releasedRetentionCents: 0 }))
    for (const user of FINANCIAL) await denied(`${who(user)} voids against a ledger with a non-numeric total`, voidInvoice('inv3', user))
    await admin((db) => setDoc(ledRef(db, 'inv3'), { seq: 1 }))
    await denied('a ledger with no totals at all', voidInvoice('inv3'))
  })

  it('a client cannot clear the way by writing the ledger itself', async () => {
    const posted = await seedPosted(CREDIT, 'c1', 'inv3')
    const back = applyCreditVoid(readLedger(await ledgerOf('inv3')), posted)
    for (const user of FINANCIAL) {
      const db = ctx(user)
      const batch = writeBatch(db)
      batch.update(ledRef(db, 'inv3'), ledgerBody(user, back, { create: false }))
      batch.update(invRef(db, 'inv3'), {
        status: 'void', voidedAt: serverTimestamp(), voidedBy: user.uid, voidReason: 'Issued in error', ...STAMP(user),
      })
      await denied(`${who(user)} zeroes the ledger and voids in one batch`, batch.commit())
      await denied(`${who(user)} deletes the ledger`, deleteDoc(ledRef(db, 'inv3')))
    }
    expect(await statusOf('inv3')).toBe('issued')
    expect((await ledgerOf('inv3')).creditedSubtotalCents).toBe(1000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. RETENTION PINS on the invoice
// ─────────────────────────────────────────────────────────────────────────────

describe('client retention on the invoice', () => {
  const draftInvoice = (user, lineItems, retention, over = {}) => ({
    ...invoiceDoc('CI-0100', lineItems, { retention, status: 'draft' }),
    issuedAt: null, issuedBy: null,
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  })
  const create = (body, id = 'n1') => setDoc(invRef(ctx(USERS.admin), id), body)
  const line = (amount, gstAmount, taxCode = 'gst') =>
    ({ description: 'Line', amount, taxCode, gstAmount, variationId: null, costCodeId: null, costCodeName: null })

  it('accepts what the app computes: taxable, GST-free, mixed, zero and no retention', async () => {
    await assertSucceeds(create(draftInvoice(USERS.admin, INV3_LINES, 10), 'a'))
    await assertSucceeds(create(draftInvoice(USERS.admin, [INV1_LINES[1]], 25), 'b'))
    await assertSucceeds(create(draftInvoice(USERS.admin, INV1_LINES, 75), 'c'))
    await assertSucceeds(create(draftInvoice(USERS.admin, INV1_LINES, 0), 'd'))
    await assertSucceeds(create(draftInvoice(USERS.admin, INV1_LINES, null), 'e'))
    await assertSucceeds(create(draftInvoice(USERS.admin, INV1_LINES, 1500), 'f'))
    await assertSucceeds(create(draftInvoice(USERS.admin, [{ ...INV3_LINES[0], amount: 40.15, gstAmount: 4.02 }], 13.37), 'g'))
  })

  it('every financial role may create a retained draft invoice', async () => {
    for (const user of FINANCIAL) {
      await allowed(`${who(user)} creates`, setDoc(invRef(ctx(user), `r_${user.uid}`), draftInvoice(user, INV1_LINES, 75)))
    }
  })

  it('retention GST is the invoice\'s own GST in proportion — never a flat 10%', async () => {
    const mixed = draftInvoice(USERS.admin, INV1_LINES, 75)
    expect(mixed.retentionGst).toBe(5)
    await assertFails(create({ ...mixed, retentionGst: 7.5, retentionTotal: 82.5, receivableTotal: 1517.5 }))
    const free = draftInvoice(USERS.admin, [INV1_LINES[1]], 25)
    expect(free.retentionGst).toBe(0)
    await assertFails(create({ ...free, retentionGst: 2.5, retentionTotal: 27.5, receivableTotal: 472.5 }))
    // Controls: the proportional figures on the same two invoices.
    await assertSucceeds(create(mixed, 'mixed'))
    await assertSucceeds(create(free, 'free'))
  })

  it('a retention GST one cent either side of the proportional figure is refused, even with totals that reconcile to it', async () => {
    // inv3 figures: S 100.00, G 10.00, R 10.00 → RG exactly 1.00 (no rounding involved).
    const good = draftInvoice(USERS.admin, INV3_LINES, 10)
    expect(good.retentionGst).toBe(1)
    await assertFails(create({ ...good, retentionGst: 1.01, retentionTotal: 11.01, receivableTotal: 98.99 }))
    await assertFails(create({ ...good, retentionGst: 0.99, retentionTotal: 10.99, receivableTotal: 99.01 }))
    await assertFails(create({ ...good, retentionGst: 0, retentionTotal: 10, receivableTotal: 100 }))
    await assertSucceeds(create(good))
  })

  it('zero retention carries zero retention GST', async () => {
    const zero = draftInvoice(USERS.admin, INV3_LINES, 0)
    expect(zero).toMatchObject({ retention: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: 110 })
    await assertFails(create({ ...zero, retentionGst: 0.01, retentionTotal: 0.01, receivableTotal: 109.99 }))
    await assertSucceeds(create(zero))
    // A zero-value invoice with zero retention is not a division by zero.
    await assertSucceeds(create(draftInvoice(USERS.admin, [line(0, 0)], 0), 'nil'))
  })

  it('refuses retention outside the invoice, fractional cents, and unreconciled totals', async () => {
    const good = draftInvoice(USERS.admin, INV3_LINES, 10)
    await assertFails(create({ ...good, retention: 101 }))
    await assertFails(create({ ...good, retention: 100.01, retentionGst: 10, retentionTotal: 110.01, receivableTotal: -0.01 }))
    await assertFails(create({ ...good, retention: -1 }))
    await assertFails(create({ ...good, retention: -10, retentionGst: -1, retentionTotal: -11, receivableTotal: 121 }))
    await assertFails(create({ ...good, retention: 10.005 }))
    await assertFails(create({ ...good, retentionGst: 1.004 }))
    await assertFails(create({ ...good, retentionTotal: 11.004 }))
    await assertFails(create({ ...good, receivableTotal: 99.004 }))
    await assertFails(create({ ...good, subtotal: 100.004 }))
    await assertFails(create({ ...good, gstTotal: 10.004 }))
    await assertFails(create({ ...good, grossTotal: 110.004 }))
    await assertFails(create({ ...good, retentionTotal: 12 }))
    await assertFails(create({ ...good, receivableTotal: 110 }))
    await assertFails(create({ ...good, grossTotal: 111 }))
    await assertFails(create({ ...good, retention: '10' }))
    await assertFails(create({ ...good, retentionGst: null }))
    await assertSucceeds(create(good))
  })

  it('the four retention fields are all present or all absent — every partial set is refused', async () => {
    const good = draftInvoice(USERS.admin, INV3_LINES, 10)
    const FOUR = ['retention', 'retentionGst', 'retentionTotal', 'receivableTotal']
    for (const key of FOUR) {
      await denied(`without ${key}`, create(withoutKeys(good, key)))
      await denied(`with only ${key}`, create(withoutKeys(good, ...FOUR.filter(k => k !== key))))
    }
    await denied('retention pair only', create(withoutKeys(good, 'retentionTotal', 'receivableTotal')))
    await allowed('all four', create(good, 'all'))
    await allowed('none of the four', create(withoutKeys(good, ...FOUR), 'none'))
  })

  it('the Rules admit either neighbour at an exact half-cent tie; the backend requires the exact figure', async () => {
    // S 100.00, G 10.00, R 0.05 → proportional retention GST is EXACTLY 0.5 of a cent.
    const tie = draftInvoice(USERS.admin, INV3_LINES, 0.05)
    // What the app stores (round half up):
    expect(tie).toMatchObject({ retention: 0.05, retentionGst: 0.01, retentionTotal: 0.06, receivableTotal: 109.94 })
    await allowed('half-up neighbour (0.01) — the app\'s figure', create(tie, 'up'))
    // ⚠️ HONEST GAP: the half-DOWN neighbour is equally within the Rules' half-cent bound and is ACCEPTED.
    // Nothing in the Rules distinguishes the two; the exact figure is the backend's check before it posts
    // anything against the invoice.
    await allowed('half-down neighbour (0.00) — NOT what the app computes, still Rules-valid',
      create({ ...tie, retentionGst: 0, retentionTotal: 0.05, receivableTotal: 109.95 }, 'down'))
    // The bound is half a cent and no more: the next cent out is refused.
    await denied('0.02', create({ ...tie, retentionGst: 0.02, retentionTotal: 0.07, receivableTotal: 109.93 }, 'far'))
  })

  it('a second tie at a larger scale behaves the same way (S 2,000.00, G 200.00, R 0.15 → 1.5 cents)', async () => {
    const lines = [line(2000, 200)]
    const tie = draftInvoice(USERS.admin, lines, 0.15)
    expect(tie.retentionGst).toBe(0.02)
    await allowed('half-up (0.02)', create(tie, 'up'))
    await allowed('half-down (0.01) — admitted by the Rules, refused by the backend',
      create({ ...tie, retentionGst: 0.01, retentionTotal: 0.16, receivableTotal: 2199.84 }, 'down'))
    await denied('0.03', create({ ...tie, retentionGst: 0.03, retentionTotal: 0.18, receivableTotal: 2199.82 }, 'hi'))
    await denied('0.00', create({ ...tie, retentionGst: 0, retentionTotal: 0.15, receivableTotal: 2199.85 }, 'lo'))
  })

  it('a very large invoice is accepted: 250,000,000.00 subtotal with 10% retention (no upper size limit)', async () => {
    const lines = [line(250_000_000, 25_000_000)]
    const big = draftInvoice(USERS.admin, lines, 25_000_000)
    expect(big).toMatchObject({
      subtotal: 250_000_000, gstTotal: 25_000_000, grossTotal: 275_000_000,
      retention: 25_000_000, retentionGst: 2_500_000, retentionTotal: 27_500_000, receivableTotal: 247_500_000,
    })
    await allowed('250,000,000.00 with 10% retention', create(big, 'big'))
    // The pin is still exact to the cent at that size.
    await denied('retention GST one cent high', create({ ...big, retentionGst: 2_500_000.01, retentionTotal: 27_500_000.01, receivableTotal: 247_499_999.99 }, 'bigHi'))
    await denied('retention GST one cent low', create({ ...big, retentionGst: 2_499_999.99, retentionTotal: 27_499_999.99, receivableTotal: 247_500_000.01 }, 'bigLo'))
    await denied('flat-rate GST on the gross retention', create({ ...big, retentionGst: 2_750_000, retentionTotal: 27_750_000, receivableTotal: 247_250_000 }, 'bigFlat'))
  })

  it('a very large invoice with awkward figures is accepted as the app computes it, and pinned to the cent', async () => {
    const lines = [line(249_999_999.99, 24_999_999.97), line(1_234_567.89, 0, 'gst_free')]
    const big = draftInvoice(USERS.admin, lines, 12_345_678.91)
    await allowed('awkward large invoice', create(big, 'big'))
    const up = Math.round(big.retentionGst * 100) + 1
    const total = Math.round(big.retention * 100) + up
    await denied('one cent high', create({
      ...big, retentionGst: up / 100, retentionTotal: total / 100,
      receivableTotal: (Math.round(big.grossTotal * 100) - total) / 100,
    }, 'bigHi'))
  })

  it('a draft edit is re-pinned; an issued invoice\'s retention is frozen', async () => {
    await create(draftInvoice(USERS.admin, INV3_LINES, 10))
    const db = ctx(USERS.admin)
    const stamp = { updatedAt: serverTimestamp(), updatedBy: USERS.admin.uid }
    await assertFails(updateDoc(invRef(db, 'n1'), { retention: 20, ...stamp }))
    const t = invoiceTotals(INV3_LINES, 20)
    await assertSucceeds(updateDoc(invRef(db, 'n1'), { ...t, ...stamp }))
    await assertSucceeds(updateDoc(invRef(db, 'n1'), { status: 'issued', issuedAt: serverTimestamp(), issuedBy: USERS.admin.uid, ...stamp }))
    await assertFails(updateDoc(invRef(db, 'n1'), { ...invoiceTotals(INV3_LINES, 0), ...stamp }))
    await assertFails(updateDoc(invRef(db, 'n1'), { retention: 0, ...stamp }))
  })

  it('retention cannot be changed in the request that issues the invoice, nor on a seeded issued invoice', async () => {
    await create(draftInvoice(USERS.admin, INV3_LINES, 10))
    const db = ctx(USERS.admin)
    const issue = { status: 'issued', issuedAt: serverTimestamp(), issuedBy: USERS.admin.uid, ...STAMP(USERS.admin) }
    await denied('issue while changing retention', updateDoc(invRef(db, 'n1'), { ...issue, ...invoiceTotals(INV3_LINES, 0) }))
    await allowed('issue alone', updateDoc(invRef(db, 'n1'), issue))
    for (const user of FINANCIAL) {
      const mine = ctx(user)
      await denied(`${who(user)} lowers retention on inv3`, updateDoc(invRef(mine, 'inv3'), { ...invoiceTotals(INV3_LINES, 0), ...STAMP(user) }))
      await denied(`${who(user)} raises retention on inv3`, updateDoc(invRef(mine, 'inv3'), { ...invoiceTotals(INV3_LINES, 50), ...STAMP(user) }))
      await denied(`${who(user)} adds retention to legacy inv2`, updateDoc(invRef(mine, 'inv2'), { ...invoiceTotals(INV2_LINES, 1), ...STAMP(user) }))
      await denied(`${who(user)} changes retention GST only`, updateDoc(invRef(mine, 'inv3'), { retentionGst: 0, ...STAMP(user) }))
    }
    expect(await read(invRef(db, 'inv3'))).toMatchObject({ retention: 10, retentionGst: 1, status: 'issued' })
    // Phase 2 step 5 (CHANGED): an issued invoice now admits NO client update at
    // all — even its void is the trusted backend's (voidClientInvoice, D8).
    await denied('void inv3', updateDoc(invRef(db, 'inv3'), {
      status: 'void', voidedAt: serverTimestamp(), voidedBy: USERS.admin.uid, voidReason: 'Issued in error', ...STAMP(USERS.admin),
    }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE HONEST GAP — a draft's FIGURES are not validated by the Rules
// ─────────────────────────────────────────────────────────────────────────────
//
// Every test here asserts that the Rules ACCEPT something financially
// meaningless — deliberately. A draft has no financial effect: it is not in
// the ledger and no figure reads it. The trusted backend re-derives every
// figure from the invoice and the ledger when it posts, and refuses these.
// If the Rules are ever asked to validate draft figures again, these tests
// are the ones that must change.

// ─────────────────────────────────────────────────────────────────────────────
// Company-scoped activation and the supported range (final integration safeguards)
// ─────────────────────────────────────────────────────────────────────────────

describe('company activation — credit notes and retention exist only for a company the backend activated', () => {
  const draftInvoice = (user, lineItems, retention, over = {}) => ({
    ...invoiceDoc('CI-0200', lineItems, { retention, status: 'draft' }),
    issuedAt: null, issuedBy: null,
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  })
  const setFlag = (value) => admin(async (db) => {
    const body = { name: COMPANY_A, baseCurrency: 'AUD', countryCode: 'AU' }
    if (value !== undefined) body.clientFinanceEnabled = value
    await setDoc(doc(db, 'companies', COMPANY_A), body)
  })

  for (const [label, value] of [['absent', undefined], ['false', false], ['a truthy non-boolean', 'true'], ['null', null]]) {
    it(`flag ${label}: no financial role can create a RETAINED invoice, a draft credit note or a draft release`, async () => {
      await setFlag(value)
      for (const user of FINANCIAL) {
        await denied(`${who(user)} creates a retained invoice`, setDoc(invRef(ctx(user), `r_${user.uid}`), draftInvoice(user, INV1_LINES, 75)))
        await denied(`${who(user)} drafts a credit note`, setDoc(cnRef(ctx(user), `c_${user.uid}`), creditDoc(user, 'inv3', [{ invoiceLineIndex: 0, amount: 10 }])))
        await denied(`${who(user)} drafts a release`, setDoc(rrRef(ctx(user), `x_${user.uid}`), releaseDoc(user, 'inv3', 1)))
        // Control: everything that existed before the phase still works.
        await allowed(`${who(user)} creates an unretained invoice`, setDoc(invRef(ctx(user), `u_${user.uid}`), draftInvoice(user, INV1_LINES, 0)))
      }
    })
  }

  it('not activated: a draft invoice cannot be EDITED to carry retention, and an existing draft entry cannot be edited', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.admin), 'n1'), draftInvoice(USERS.admin, INV1_LINES, 0)))
    await seedDraft(CREDIT, 'cDraft')
    await setFlag(false)
    const retained = draftInvoice(USERS.admin, INV1_LINES, 75)
    await assertFails(updateDoc(invRef(ctx(USERS.admin), 'n1'), {
      retention: retained.retention, retentionGst: retained.retentionGst,
      retentionTotal: retained.retentionTotal, receivableTotal: retained.receivableTotal, ...STAMP(USERS.admin),
    }))
    await assertFails(updateDoc(cnRef(ctx(USERS.admin), 'cDraft'), { notes: 'edited', ...STAMP(USERS.admin) }))
    // Reads are unaffected, and a draft can still be voided (cleanup stays possible).
    await assertSucceeds(getDoc(cnRef(ctx(USERS.admin), 'cDraft')))
  })

  it('NO client can activate its own company — not a company admin, by any shape of write', async () => {
    await setFlag(undefined)
    const ref = (user) => doc(ctx(user), 'companies', COMPANY_A)
    for (const user of [...FINANCIAL, USERS.sub, USERS.client]) {
      await denied(`${who(user)} sets the flag`, updateDoc(ref(user), { clientFinanceEnabled: true }))
      await denied(`${who(user)} sets the flag with a permitted key`, updateDoc(ref(user), {
        clientFinanceEnabled: true, countryCode: 'AU', baseCurrency: 'AUD',
        currencyUpdatedAt: serverTimestamp(), currencyUpdatedBy: user.uid,
      }))
      await denied(`${who(user)} replaces the document`, setDoc(ref(user), { name: COMPANY_A, baseCurrency: 'AUD', clientFinanceEnabled: true }))
    }
    expect((await read({ path: `companies/${COMPANY_A}` })).clientFinanceEnabled).toBeUndefined()
    // The receipt-processing flag of the cutover (ADR-89 S6) is equally out of every client's reach.
    for (const user of [...FINANCIAL, USERS.sub, USERS.client]) {
      await denied(`${who(user)} sets the receipt flag`, updateDoc(ref(user), { clientReceiptsEnabled: true }))
      await denied(`${who(user)} sets the receipt flag with a permitted key`, updateDoc(ref(user), {
        clientReceiptsEnabled: true, countryCode: 'AU', baseCurrency: 'AUD',
        currencyUpdatedAt: serverTimestamp(), currencyUpdatedBy: user.uid,
      }))
      await denied(`${who(user)} replaces the document with the receipt flag`, setDoc(ref(user), { name: COMPANY_A, baseCurrency: 'AUD', clientReceiptsEnabled: true }))
    }
    expect((await read({ path: `companies/${COMPANY_A}` })).clientReceiptsEnabled).toBeUndefined()
    // …and an activated company's admin cannot be used to activate ANOTHER company.
    await admin(async (db) => { await setDoc(doc(db, 'companies', COMPANY_B), { name: COMPANY_B, baseCurrency: 'AUD' }) })
    await assertFails(updateDoc(doc(ctx(USERS.admin), 'companies', COMPANY_B), { clientFinanceEnabled: true }))
  })

  it('Phase 2 company activation (commercialCompletionEnabled) is out of every client\'s reach — set, smuggled with permitted keys, replaced, cleared, or on another company', async () => {
    await setFlag(undefined)
    const ref = (user) => doc(ctx(user), 'companies', COMPANY_A)
    for (const user of [...FINANCIAL, USERS.sub, USERS.client]) {
      await denied(`${who(user)} sets the Phase 2 flag`, updateDoc(ref(user), { commercialCompletionEnabled: true }))
      await denied(`${who(user)} sets the Phase 2 flag with a permitted key`, updateDoc(ref(user), {
        commercialCompletionEnabled: true, countryCode: 'AU', baseCurrency: 'AUD',
        currencyUpdatedAt: serverTimestamp(), currencyUpdatedBy: user.uid,
      }))
      await denied(`${who(user)} replaces the document with the Phase 2 flag`, setDoc(ref(user), { name: COMPANY_A, baseCurrency: 'AUD', commercialCompletionEnabled: true }))
    }
    expect((await read({ path: `companies/${COMPANY_A}` })).commercialCompletionEnabled).toBeUndefined()
    // An ACTIVE company's admin can neither deactivate it nor activate another company.
    await admin(async (db) => {
      await setDoc(doc(db, 'companies', COMPANY_A), { commercialCompletionEnabled: true }, { merge: true })
      await setDoc(doc(db, 'companies', COMPANY_B), { name: COMPANY_B, baseCurrency: 'AUD' })
    })
    await assertFails(updateDoc(ref(USERS.admin), { commercialCompletionEnabled: false }))
    await assertFails(updateDoc(doc(ctx(USERS.admin), 'companies', COMPANY_B), { commercialCompletionEnabled: true }))
    expect((await read({ path: `companies/${COMPANY_A}` })).commercialCompletionEnabled).toBe(true)
  })

  it('activation is per company: A activated does not open B, and B\'s flag does not open A', async () => {
    await admin(async (db) => {
      await setDoc(doc(db, 'companies', COMPANY_B), { name: COMPANY_B, baseCurrency: 'AUD' })
      await setDoc(doc(db, 'users', 'u_b_admin'), { role: 'company_admin', companyId: COMPANY_B, name: 'b' })
    })
    const bAdmin = { uid: 'u_b_admin', role: 'company_admin', companyId: COMPANY_B }
    await assertFails(setDoc(invRef(ctx(bAdmin), 'rb', COMPANY_B), draftInvoice(bAdmin, INV1_LINES, 75)))
    await assertSucceeds(setDoc(invRef(ctx(USERS.admin), 'ra'), draftInvoice(USERS.admin, INV1_LINES, 75)))
    await setFlag(false)
    await admin(async (db) => { await setDoc(doc(db, 'companies', COMPANY_B), { name: COMPANY_B, baseCurrency: 'AUD', clientFinanceEnabled: true }) })
    await assertFails(setDoc(invRef(ctx(USERS.admin), 'ra2'), draftInvoice(USERS.admin, INV1_LINES, 75)))
    await assertSucceeds(setDoc(invRef(ctx(bAdmin), 'rb2', COMPANY_B), draftInvoice(bAdmin, INV1_LINES, 75)))
  })
})

describe('the receipt-baseline marker (clientFinanceState) is server-only — no Rules block, so every client is denied', () => {
  it('no role can read, create, change or delete it', async () => {
    const path = [...base(), 'clientFinanceState', 'receiptBaseline']
    await admin(async (db) => { await setDoc(doc(db, ...path), { version: 1, invoices: 0 }) })
    for (const user of [...FINANCIAL, USERS.sub, USERS.client]) {
      const ref = doc(ctx(user), ...path)
      await denied(`${who(user)} reads`, getDoc(ref))
      await denied(`${who(user)} overwrites`, setDoc(ref, { version: 1, invoices: 0 }))
      await denied(`${who(user)} updates`, updateDoc(ref, { invoices: 5 }))
      await denied(`${who(user)} deletes`, deleteDoc(ref))
      await denied(`${who(user)} creates another`, setDoc(doc(ctx(user), ...base(), 'clientFinanceState', 'x'), { a: 1 }))
    }
  })
})

// Phase 2 step 5 (D6–D8) — refunds and receipt applications are written ONLY by
// the trusted backend; financial roles may read them; the per-receipt ledger
// and the two numbering counters are server-only.
describe('client refunds, receipt applications and their ledger/counters (Phase 2 step 5)', () => {
  const refundDoc = { docType: 'client_refund', refundNumber: 'CRF-0001', status: 'posted', source: 'receipt', receiptId: 'r1', clientInvoiceId: null, clientId: 'c1', currency: 'AUD', amount: 10 }
  const appDoc = { docType: 'client_receipt_application', applicationNumber: 'CRA-0001', status: 'posted', receiptId: 'r1', clientInvoiceId: 'inv1', clientId: 'c1', currency: 'AUD', amount: 10 }

  it('financial roles of the company read both registers; nobody else does', async () => {
    await admin(async (db) => {
      await setDoc(doc(db, ...base(), 'clientRefunds', 'f1'), refundDoc)
      await setDoc(doc(db, ...base(), 'clientReceiptApplications', 'a1'), appDoc)
    })
    for (const user of FINANCIAL) {
      await allowed(`${who(user)} reads a refund`, getDoc(doc(ctx(user), ...base(), 'clientRefunds', 'f1')))
      await allowed(`${who(user)} reads an application`, getDoc(doc(ctx(user), ...base(), 'clientReceiptApplications', 'a1')))
    }
    for (const user of OUTSIDERS) {
      await denied(`${who(user)} reads a refund`, getDoc(doc(ctx(user), ...base(), 'clientRefunds', 'f1')))
      await denied(`${who(user)} reads an application`, getDoc(doc(ctx(user), ...base(), 'clientReceiptApplications', 'a1')))
    }
  })

  it('NO client creates, changes, voids or deletes either — every financial role is refused', async () => {
    await admin(async (db) => {
      await setDoc(doc(db, ...base(), 'clientRefunds', 'f1'), refundDoc)
      await setDoc(doc(db, ...base(), 'clientReceiptApplications', 'a1'), appDoc)
    })
    for (const user of [...FINANCIAL, ...OUTSIDERS]) {
      const db = ctx(user)
      await denied(`${who(user)} creates a refund`, setDoc(doc(db, ...base(), 'clientRefunds', 'x'), refundDoc))
      await denied(`${who(user)} creates an application`, setDoc(doc(db, ...base(), 'clientReceiptApplications', 'x'), appDoc))
      await denied(`${who(user)} voids a refund`, updateDoc(doc(db, ...base(), 'clientRefunds', 'f1'), { status: 'void', voidReason: 'x' }))
      await denied(`${who(user)} raises an application`, updateDoc(doc(db, ...base(), 'clientReceiptApplications', 'a1'), { amount: 9999 }))
      await denied(`${who(user)} deletes a refund`, deleteDoc(doc(db, ...base(), 'clientRefunds', 'f1')))
      await denied(`${who(user)} deletes an application`, deleteDoc(doc(db, ...base(), 'clientReceiptApplications', 'a1')))
    }
  })

  it('the per-receipt settlement ledger (clientReceiptLedgers) has no Rules block: no role reads or writes it', async () => {
    await admin((db) => setDoc(doc(db, ...base(), 'clientReceiptLedgers', 'r1'), { seq: 1, appliedCents: 1000, refundedCents: 0 }))
    for (const user of [...FINANCIAL, ...OUTSIDERS]) {
      const ref = doc(ctx(user), ...base(), 'clientReceiptLedgers', 'r1')
      await denied(`${who(user)} reads`, getDoc(ref))
      await denied(`${who(user)} zeroes it`, setDoc(ref, { seq: 2, appliedCents: 0, refundedCents: 0 }))
      await denied(`${who(user)} deletes it`, deleteDoc(ref))
    }
  })

  it('the refund and application counters are server-only; the receipt counter is still the client’s (DC6 unchanged)', async () => {
    for (const id of ['clientRefunds', 'clientReceiptApplications']) {
      await admin((db) => setDoc(doc(db, 'companies', COMPANY_A, 'counters', id), { next: 5 }))
      for (const user of FINANCIAL) {
        const ref = doc(ctx(user), 'companies', COMPANY_A, 'counters', id)
        await denied(`${who(user)} reads ${id}`, getDoc(ref))
        await denied(`${who(user)} rolls back ${id}`, setDoc(ref, { next: 1 }))
        await denied(`${who(user)} advances ${id}`, updateDoc(ref, { next: 999 }))
      }
    }
    await allowed('control: the receipt counter', setDoc(doc(ctx(USERS.qs), 'companies', COMPANY_A, 'counters', 'clientReceipts'), { next: 3 }, { merge: true }))
  })
})

describe('supported monetary range — the Rules bound a client invoice at 999,999,999,999.99 ex-GST', () => {
  const big = (amount, gstAmount) => [{ description: 'Line', amount, taxCode: 'gst', gstAmount, variationId: null, costCodeId: null, costCodeName: null }]
  const draftInvoice = (user, lineItems, over = {}) => ({
    ...invoiceDoc('CI-0300', lineItems, { retention: 0, status: 'draft' }),
    issuedAt: null, issuedBy: null,
    createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid,
    ...over,
  })

  it('AT the maximum is accepted; one cent above is refused — with and without the retention fields', async () => {
    const atMax = draftInvoice(USERS.admin, big(999999999999.99, 100000000000))
    expect(atMax.subtotal).toBe(999999999999.99)
    await assertSucceeds(setDoc(invRef(ctx(USERS.admin), 'max'), atMax))
    const above = draftInvoice(USERS.admin, big(1000000000000, 100000000000))
    await assertFails(setDoc(invRef(ctx(USERS.admin), 'over'), above))
    // The shape an older build writes (no retention fields) is bounded too.
    const legacyShape = withoutKeys(above, 'retention', 'retentionGst', 'retentionTotal', 'receivableTotal')
    await assertFails(setDoc(invRef(ctx(USERS.admin), 'overLegacy'), legacyShape))
    await assertSucceeds(setDoc(invRef(ctx(USERS.admin), 'maxLegacy'),
      withoutKeys(atMax, 'retention', 'retentionGst', 'retentionTotal', 'receivableTotal')))
  })

  it('a draft cannot be edited past the maximum', async () => {
    await assertSucceeds(setDoc(invRef(ctx(USERS.admin), 'e1'), draftInvoice(USERS.admin, INV1_LINES)))
    const above = draftInvoice(USERS.admin, big(1000000000000, 100000000000))
    await assertFails(updateDoc(invRef(ctx(USERS.admin), 'e1'), {
      lineItems: above.lineItems, subtotal: above.subtotal, gstTotal: above.gstTotal, grossTotal: above.grossTotal,
      retention: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: above.grossTotal, ...STAMP(USERS.admin),
    }))
  })
})

describe('draft FIGURES are not validated by the Rules — the backend, not the Rules, refuses them at posting', () => {
  const me = USERS.admin

  it('CREDIT NOTE: a draft with nonsensical totals is accepted AS A DRAFT (the backend, not the Rules, refuses it at posting)', async () => {
    const cases = {
      'totals far above the invoice (S 100.00)': { subtotal: 1_000_000_000, gstTotal: 100_000_000, grossTotal: 1_100_000_000 },
      'gross that is not subtotal + GST': { grossTotal: 12 },
      'negative subtotal': { subtotal: -50, grossTotal: -49 },
      'negative GST': { gstTotal: -1 },
      'fractional cents': { subtotal: 10.005, grossTotal: 11.005 },
      'non-numeric totals': { subtotal: 'lots', gstTotal: null, grossTotal: [] },
      'retention part above the invoice retention': { retentionAmount: 500, retentionGst: 50, retentionTotal: 550, receivableTotal: -539 },
      'negative retention part': { retentionAmount: -1, retentionGst: -0.01 },
      'a stale / impossible ledgerSeq': { ledgerSeq: -1 },
      'a fractional ledgerSeq': { ledgerSeq: 1.5 },
      'no lines at all': { lineItems: [] },
      'a line of an invoice line that does not exist': { lineItems: [{ invoiceLineIndex: 99, amount: 5, gstAmount: 0.5 }] },
      'lines that disagree with the headers': { lineItems: [{ invoiceLineIndex: 0, amount: 99_999, gstAmount: 0 }] },
      'an unparseable credit date': { creditDate: '10/11/2026' },
    }
    let n = 0
    for (const [what, over] of Object.entries(cases)) {
      n += 1
      await allowed(`draft credit note with ${what}`, setDoc(cnRef(ctx(me), `bad${n}`), CREDIT.make(me, 'inv3', over)))
    }
    // …and with the money fields missing altogether.
    await allowed('draft credit note with no totals', setDoc(cnRef(ctx(me), 'bare'),
      withoutKeys(CREDIT.make(me), 'subtotal', 'gstTotal', 'grossTotal', 'retentionAmount', 'retentionGst', 'retentionTotal', 'receivableTotal', 'ledgerSeq', 'creditDate')))
    // None of it reaches a ledger.
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('CREDIT NOTE: a draft may be drafted against an invoice it could never be posted against (already fully credited)', async () => {
    // The backend has posted a credit of the whole of inv3's only line.
    const full = await seedEntry('clientCreditNotes', 'full', {
      ...creditDoc(me, 'inv3', [{ invoiceLineIndex: 0, amount: 100 }]), status: 'posted', postedAt: Timestamp.now(), postedBy: me.uid,
    })
    await seedLedger('inv3', applyCredit(readLedger(null), full))
    expect((await ledgerOf('inv3')).creditedSubtotalCents).toBe(10000)
    // The Rules do not read the ledger for a draft: a second full credit is accepted as a DRAFT.
    // (creditDoc is built against a null ledger here precisely because the app's builder would refuse.)
    await allowed('an over-cap DRAFT', setDoc(cnRef(ctx(me), 'over'), creditDoc(me, 'inv3', [{ invoiceLineIndex: 0, amount: 100 }])))
    // What the Rules DO guarantee: that draft cannot be posted, and the ledger cannot be moved, by any client.
    for (const user of FINANCIAL) {
      await denied(`${who(user)} posts the over-cap draft`, updateDoc(cnRef(ctx(user), 'over'), POST(user)))
    }
    expect((await ledgerOf('inv3')).creditedSubtotalCents).toBe(10000)
  })

  it('RETENTION RELEASE: a draft with nonsensical figures is accepted AS A DRAFT (the backend, not the Rules, refuses it at posting)', async () => {
    const cases = {
      'an amount far above the retention withheld (R 10.00)': { amount: 1_000_000, gstAmount: 100_000, releaseTotal: 1_100_000 },
      'a total that is not amount + GST': { releaseTotal: 5 },
      'a GST that is not the proportional share': { gstAmount: 4.99, releaseTotal: 9.99 },
      'a negative amount': { amount: -5, gstAmount: -0.5, releaseTotal: -5.5 },
      'a zero amount': { amount: 0, gstAmount: 0, releaseTotal: 0 },
      'fractional cents': { amount: 5.005 },
      'non-numeric figures': { amount: 'all of it', gstAmount: null },
      'an impossible ledgerSeq': { ledgerSeq: -1 },
      'an unparseable release date': { releaseDate: 'soon' },
    }
    let n = 0
    for (const [what, over] of Object.entries(cases)) {
      n += 1
      await allowed(`draft release with ${what}`, setDoc(rrRef(ctx(me), `bad${n}`), RELEASE.make(me, 'inv3', over)))
    }
    await allowed('draft release with no figures', setDoc(rrRef(ctx(me), 'bare'),
      withoutKeys(RELEASE.make(me), 'amount', 'gstAmount', 'releaseTotal', 'ledgerSeq', 'releaseDate')))
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it('RETENTION RELEASE: a draft may name an invoice that withheld NO retention (the backend refuses it at posting)', async () => {
    // inv2 is a legacy invoice with no retention fields at all.
    await allowed('a release drafted against an invoice with no retention',
      setDoc(rrRef(ctx(me), 'none'), RELEASE.make(me, 'inv3', { clientInvoiceId: 'inv2', invoiceNumber: 'CI-0002' })))
    for (const user of FINANCIAL) {
      await denied(`${who(user)} posts it`, updateDoc(rrRef(ctx(user), 'none'), POST(user)))
    }
    expect(await ledgerOf('inv2')).toBeNull()
  })

  it.each(KINDS)('$label: a draft EDIT may set nonsensical figures too — and that draft still cannot be posted by a client', async (kind) => {
    await seedDraft(kind, 'd1')
    const nonsense = kind === CREDIT
      ? { subtotal: -1, gstTotal: 'x', grossTotal: 9e15, lineItems: [], ledgerSeq: -7 }
      : { amount: 9e15, gstAmount: -3, releaseTotal: 'x', ledgerSeq: -7 }
    for (const user of FINANCIAL) {
      await allowed(`${who(user)} edits figures to nonsense`, updateDoc(kind.ref(ctx(user), 'd1'), { ...nonsense, ...STAMP(user) }))
      await denied(`${who(user)} posts the nonsense`, updateDoc(kind.ref(ctx(user), 'd1'), POST(user)))
    }
    expect(await read(kind.ref(ctx(me), 'd1'))).toMatchObject({ status: 'draft', postedAt: null })
    expect(await ledgerOf('inv3')).toBeNull()
  })

  it.each(KINDS)('$label: a draft\'s KEYS are not restricted — unknown fields, any number string and a pre-set voidReason are accepted', async (kind) => {
    // Recorded so nobody assumes otherwise. None of these can become a posted document through a client.
    await allowed('unknown extra fields', setDoc(kind.ref(ctx(me), 'x1'), kind.make(me, 'inv3', { anything: { goes: true }, approved: true })))
    await allowed('a number the counter never issued', setDoc(kind.ref(ctx(me), 'x2'), kind.make(me, 'inv3', { [kind.numberKey]: '' })))
    await allowed('a number that duplicates another draft', setDoc(kind.ref(ctx(me), 'x3'), kind.make(me, 'inv3', { [kind.numberKey]: '' })))
    await allowed('a voidReason on a live draft at create', setDoc(kind.ref(ctx(me), 'x4'), kind.make(me, 'inv3', { voidReason: 'pre-set' })))
    await allowed('a voidReason on a live draft by edit', updateDoc(kind.ref(ctx(me), 'x1'), { voidReason: 'pre-set', ...STAMP(me) }))
    await allowed('snapshots that do not match the invoice (invoiceNumber / clientName)',
      setDoc(kind.ref(ctx(me), 'x5'), kind.make(me, 'inv3', { invoiceNumber: 'CI-9999', clientName: 'Not the client' })))
    expect((await read(kind.ref(ctx(me), 'x1'))).status).toBe('draft')
  })
})
