import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// ── Invitation tokens — PURE ─────────────────────────────────────────────────
//
// 256 bits of entropy, base64url (43 chars, URL-safe, no padding). Firestore
// stores ONLY the SHA-256 hash; the raw token exists in the email link and in
// the invitee's browser. Comparison is constant-time on the hash.
//
// The link carries the credential in the URL FRAGMENT, which browsers never
// send to a server, never log in access logs and never include in Referer.

export const TOKEN_BYTES = 32

export const generateToken = () => randomBytes(TOKEN_BYTES).toString('base64url')

export const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex')

export function tokenMatchesHash(token, storedHash) {
  if (typeof token !== 'string' || typeof storedHash !== 'string') return false
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export function buildInviteLink(appBaseUrl, { companyId, inviteId, token }) {
  const base = String(appBaseUrl || '').replace(/\/+$/, '')
  const params = new URLSearchParams({ c: companyId, i: inviteId, t: token })
  return `${base}/accept-invite#${params.toString()}`
}
