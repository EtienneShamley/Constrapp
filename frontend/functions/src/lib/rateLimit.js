import { CODE, fail } from './errors.js'

// ── Fixed-window rate limits ─────────────────────────────────────────────────
//
// One counter document per (company, key) under
// `companies/{c}/rateLimits/{key}` — no rules block, so browsers cannot read
// or reset it; only the Admin SDK writes it, inside a transaction.
//
// Tokens carry 256 bits of entropy, so these limits do not exist to stop
// guessing. They bound abuse, cost and email volume.

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const LIMITS = {
  INVITE_CREATE_ADMIN:   { limit: 20,  windowMs: HOUR },
  INVITE_CREATE_COMPANY: { limit: 100, windowMs: DAY },
  INVITE_RESEND:         { limit: 3,   windowMs: DAY },
  INVITE_LOOKUP:         { limit: 30,  windowMs: HOUR },
}

export const rateKey = (...parts) =>
  parts.map(p => String(p).replace(/[^A-Za-z0-9_-]/g, '_')).join('__').slice(0, 200)

export const rateLimitRef = (db, companyId, key) =>
  db.collection('companies').doc(companyId).collection('rateLimits').doc(key)

// Consumes one unit or throws `rate-limited`. Pure fixed window: the first hit
// after `windowMs` starts a fresh window.
export async function consumeRateLimit(db, { companyId, key, limit, windowMs, now }) {
  const ref = rateLimitRef(db, companyId, key)
  const nowMs = now.getTime()
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const data = snap.exists ? snap.data() : null
    const inWindow = data && typeof data.windowStart === 'number' && nowMs - data.windowStart < windowMs
    const count = inWindow ? (data.count ?? 0) : 0
    if (count >= limit) fail(CODE.RATE_LIMITED, { key, retryAfterMs: inWindow ? data.windowStart + windowMs - nowMs : 0 })
    tx.set(ref, { windowStart: inWindow ? data.windowStart : nowMs, count: count + 1, updatedAt: nowMs })
  })
}
