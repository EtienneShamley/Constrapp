import { CODE, TeamError } from '../lib/errors.js'
import * as calc from '../generated/clientFinanceCalc.js'

// ── What blocks a refused void (ADR-89) ──────────────────────────────────────
//
// A void that is refused names the documents that stand in its way, so the
// user is told what to void first instead of being left to work it out:
//
//   · refused by a LEDGER INVARIANT → the entries on the SAME invoice that were
//     posted AFTER the entry being voided and still stand
//     (`details.blockingEntries`, newest first);
//   · refused because RECEIPTS depend on a release → the posted receipts
//     allocated to that invoice (`details.blockingReceipts`). ⚠️ THAT LIST MAY
//     BE INCOMPLETE, and says so: a receipt posted before the backend took
//     over carries no `allocatedInvoiceIds` and cannot be found by an indexed
//     lookup, though the ledger's received figure includes it (the receipt
//     baseline). Whatever the listed receipts do not explain is reported as
//     `details.unlistedReceivedCents`, with `details.receiptBaselineAt` when
//     the invoice has such history, so the message never implies the list is
//     the whole reason.
//
// ⚠️ DIAGNOSTICS, NEVER THE DECISION. These lookups run only AFTER a void has
// been refused, outside its transaction, and read nothing the decision used.
// They cannot turn a refusal into a success or the reverse; if one fails, the
// refusal goes out without a list and the browser falls back to its generic
// wording. They are per-INVOICE lookups on indexed equality filters — never a
// scan of a project's register — and each is capped.

export const BLOCKING_LOOKUP_LIMIT = 100

const millis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null)
const iso = (t) => (millis(t) === null ? null : t.toDate().toISOString())
const newestFirst = (a, b) => (millis(b.at) > millis(a.at) ? 1 : -1)

const KINDS = [
  { collection: 'clientCreditNotes', kind: 'credit_note', numberKey: 'creditNumber', status: calc.CCN_STATUS },
  { collection: 'clientRetentionReleases', kind: 'retention_release', numberKey: 'releaseNumber', status: calc.CRR_STATUS },
]

// Posted credit notes and releases of one invoice, posted after `postedAt`.
export async function findBlockingEntries({ projectRef, invoiceId, entryId, postedAt }) {
  const since = millis(postedAt)
  if (since === null) return []
  const found = []
  for (const k of KINDS) {
    const snap = await projectRef.collection(k.collection).where('clientInvoiceId', '==', invoiceId).limit(BLOCKING_LOOKUP_LIMIT).get()
    for (const doc of snap.docs) {
      const d = doc.data()
      if (doc.id === entryId || d.status !== k.status.POSTED) continue
      const at = millis(d.postedAt)
      if (at === null || at <= since) continue
      found.push({ kind: k.kind, number: d[k.numberKey] ?? null, id: doc.id, at: d.postedAt })
    }
  }
  return found.sort(newestFirst).map(({ at, ...entry }) => ({ ...entry, postedAt: iso(at) }))
}

// Posted receipts that allocate to one invoice, with what each allocated to it.
// Found through `allocatedInvoiceIds`, which the backend writes when it posts a
// receipt. BEST EFFORT: a receipt posted before that existed is NOT listed,
// although it counts in the ledger's received figure — `attachBlockers` reports
// the difference.
export async function findBlockingReceipts({ projectRef, invoiceId }) {
  const snap = await projectRef.collection('clientReceipts').where('allocatedInvoiceIds', 'array-contains', invoiceId).limit(BLOCKING_LOOKUP_LIMIT).get()
  const found = []
  for (const doc of snap.docs) {
    const d = doc.data()
    if (d.status !== calc.PAYMENT_STATUS.POSTED) continue
    const allocation = calc.storedReceiptAllocations(d).find(a => a.clientInvoiceId === invoiceId)
    if (!allocation) continue
    found.push({ number: d.receiptNumber ?? null, id: doc.id, allocatedCents: allocation.cents, at: d.postedAt })
  }
  return found.sort(newestFirst).map(({ at, ...receipt }) => ({ ...receipt, postedAt: iso(at) }))
}

// Rethrows `err` — the SAME refusal, with its blockers attached when it is one
// of the two a void can be given and they can be found. `refused` is what the
// transaction noted about the entry (null when it never got that far).
export async function attachBlockers(db, log, err, refused) {
  const code = err?.details?.code
  if (!refused || (code !== CODE.CLIENT_LEDGER_INVARIANT && code !== CODE.CLIENT_RECEIPTS_DEPEND)) throw err
  let extra
  try {
    if (code === CODE.CLIENT_LEDGER_INVARIANT) {
      extra = { blockingEntries: await findBlockingEntries(refused) }
    } else {
      const blockingReceipts = await findBlockingReceipts(refused)
      extra = { blockingReceipts }
      // What the receipts found do NOT explain of the received figure.
      const unlistedReceivedCents = calc.unlistedReceivedCents(err.details.receivedCents, blockingReceipts)
      if (unlistedReceivedCents > 0) {
        const baseline = refused.receiptBaseline
        extra.unlistedReceivedCents = unlistedReceivedCents
        extra.receiptBaselineAt = baseline?.legacyCents > 0 ? iso(baseline.establishedAt) : null
      }
    }
  } catch (lookupError) {
    log.warn('client finance: blocking lookup failed', { code, message: lookupError?.message })
    throw err
  }
  const { code: _code, ...details } = err.details
  void _code
  throw new TeamError(code, { ...details, ...extra })
}
