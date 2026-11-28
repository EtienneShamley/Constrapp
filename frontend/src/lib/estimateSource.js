import { isPriced } from './boq'
import { toCents } from './payments'

// ── The BOQ source key of an estimate (ADR-97) ───────────────────────────────
//
// ONE question: "are the ACTIVE BOQ items of this project the ones an estimate
// revision priced?" The key is computed from the live register by the browser
// (to show drift) and by the trusted backend (when an estimate revision is
// built, and when a BOQ-to-budget transfer claims an approved estimate as its
// source). It cannot reconstruct anything — the revision's own stored lines do
// that — and it is not a secret.
//
// CANONICAL INPUTS, for every ACTIVE item, sorted by item id:
//   id · quantity · rate ("null" when unpriced) · amount in whole cents
//   ("null" when unpriced) · unit · currency · cost code id
// A description, a note, an item number or a section does not change it; a
// quantity, rate, unit, currency or cost code, a new item or a void does.
//
// Imports only lib/boq and lib/payments, so lib/boqBudgetTransfer.js and
// lib/estimating.js can both use it without importing each other.

export const ESTIMATE_SOURCE_VERSION = 'est1'

function fnv1a64(str, basis) {
  let hash = basis
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
// Two 64-bit FNV-1a passes (the lib/boqBudgetTransfer.js idiom) — 32 hex chars.
export const fnvDigest = (str) => fnv1a64(str, 0xcbf29ce484222325n) + fnv1a64(str, 0x84222325cbf29ce4n)

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const num = (v) => (isNumber(v) ? String(v) : 'x')
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// The canonical string of ONE item (live BOQ item or stored estimate line —
// both carry these fields under these names once normalised by the caller).
export const sourceItemKey = ({ id, quantity, rate, amountCents, unit, currency, costCodeId }) => [
  id, num(quantity), rate === null ? 'null' : num(rate), amountCents === null ? 'null' : String(amountCents),
  String(unit ?? ''), String(currency ?? ''), String(costCodeId ?? ''),
].join(':')

const liveItemKey = (item) => sourceItemKey({
  id: item.id, quantity: item.quantity,
  rate: isPriced(item.rate) ? item.rate : null,
  amountCents: isPriced(item.rate) ? (isNumber(item.amount) ? toCents(item.amount) : 'x') : null,
  unit: item.unit, currency: item.currency, costCodeId: item.costCodeId,
})

export const sourceKeyOfRows = (rows) => `${ESTIMATE_SOURCE_VERSION}:${fnvDigest([String(rows.length), ...[...rows].sort(cmp)].join('|'))}`

// The key of the LIVE register (every document of `boqItems`; void ones are ignored).
export function estimateSourceKey(boqItems) {
  return sourceKeyOfRows((boqItems ?? []).filter(i => i?.status === 'active').map(liveItemKey))
}

export const isEstimateSourceKeyShape = (v) => typeof v === 'string' && /^est1:[0-9a-f]{32}$/.test(v)
