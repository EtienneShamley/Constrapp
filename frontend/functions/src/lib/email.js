import { Timestamp } from './firebaseAdmin.js'

// ── Email adapter ────────────────────────────────────────────────────────────
//
// One small injected interface: `send({ to, subject, text, html, idempotencyKey, meta })`
// resolving `{ providerId }` or throwing `EmailError`. Three implementations:
//
//   · createResendAdapter   — production. Resend's HTTPS API through `fetch`,
//                             no SDK; the key comes from Secret Manager.
//   · createDevOutboxAdapter — EMULATOR ONLY. Writes the rendered email (link
//                             included) to `companies/{c}/devOutbox/{inviteId}`
//                             so the emulator test suite and a developer can
//                             read the invitation link. Never selected unless
//                             FUNCTIONS_EMULATOR is "true" AND K_SERVICE (set
//                             by Cloud Run in production) is absent.
//   · a test fake           — injected by the handler tests.
//
// Sending always happens AFTER the invitation is committed. A failure is
// recorded on the invitation (`lastSendError`) and surfaced to the admin as
// "Not delivered — Resend"; it never creates a second invitation.

export class EmailError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message)
    this.name = 'EmailError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails'

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const ROLE_LABELS = {
  company_admin:   'Company Admin',
  project_manager: 'Project Manager',
  qs:              'Quantity Surveyor',
}

export function renderInviteEmail({ companyName, inviterName, role, link, expiresAt }) {
  const roleLabel = ROLE_LABELS[role] ?? role
  const expires = expiresAt instanceof Date ? expiresAt.toISOString().slice(0, 10) : String(expiresAt)
  const who = inviterName ? `${inviterName} has invited you` : 'You have been invited'
  const subject = `You're invited to ${companyName} on Constrap`
  const text = [
    `${who} to join ${companyName} on Constrap as ${roleLabel}.`,
    '',
    'Open this link to accept the invitation:',
    link,
    '',
    `The link is personal to you and expires on ${expires}.`,
    'If you were not expecting this invitation, you can ignore this email.',
  ].join('\n')
  const html = [
    `<p>${escapeHtml(who)} to join <strong>${escapeHtml(companyName)}</strong> on Constrap as <strong>${escapeHtml(roleLabel)}</strong>.</p>`,
    `<p><a href="${escapeHtml(link)}">Accept the invitation</a></p>`,
    `<p style="font-size:12px;color:#555">The link is personal to you and expires on ${escapeHtml(expires)}. ` +
    'If you were not expecting this invitation, you can ignore this email.</p>',
  ].join('\n')
  return { subject, text, html }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function createResendAdapter({ apiKey, from, fetchImpl = globalThis.fetch, retries = 1, retryDelayMs = 400, timeoutMs = 10000 }) {
  return {
    kind: 'resend',
    async send({ to, subject, text, html, idempotencyKey }) {
      if (!apiKey || !from) throw new EmailError('not-configured', 'EMAIL_API_KEY or EMAIL_FROM is not configured')
      let lastErr = null
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await sleep(retryDelayMs)
        try {
          const res = await fetchImpl(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
            body: JSON.stringify({ from, to: [to], subject, text, html }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (res.ok) {
            const body = await res.json().catch(() => ({}))
            return { providerId: body?.id ?? null }
          }
          const retryable = res.status === 429 || res.status >= 500
          lastErr = new EmailError('provider-error', `Resend responded ${res.status}`, { status: res.status, retryable })
          if (!retryable) throw lastErr
        } catch (err) {
          if (err instanceof EmailError && !err.retryable) throw err
          lastErr = err instanceof EmailError ? err : new EmailError('network-error', err?.message ?? 'network error', { retryable: true })
        }
      }
      throw lastErr ?? new EmailError('provider-error', 'send failed')
    },
  }
}

export function createDevOutboxAdapter(db) {
  return {
    kind: 'dev-outbox',
    async send({ to, subject, text, html, idempotencyKey, meta = {} }) {
      if (!meta.companyId || !meta.inviteId) throw new EmailError('not-configured', 'dev outbox needs meta.companyId and meta.inviteId')
      await db.collection('companies').doc(meta.companyId).collection('devOutbox').doc(meta.inviteId).set({
        to, subject, text, html, link: meta.link ?? null, idempotencyKey: idempotencyKey ?? null,
        sentAt: Timestamp.now(),
      })
      return { providerId: `dev-outbox:${meta.inviteId}` }
    },
  }
}

// Emulator detection: both signals must agree. FUNCTIONS_EMULATOR is set only
// by the Firebase Functions emulator, and FIRESTORE_EMULATOR_HOST only when a
// Firestore emulator is running — so the outbox can never be selected by a
// deployed function, and can never write to a production Firestore even if
// it were. (The emulator mimics Cloud Run's K_SERVICE, so that is NOT a
// usable signal.)
export const isEmulatorRuntime = (env = process.env) =>
  env.FUNCTIONS_EMULATOR === 'true' && typeof env.FIRESTORE_EMULATOR_HOST === 'string' && env.FIRESTORE_EMULATOR_HOST.length > 0

export function selectEmailAdapter({ db, apiKey, from, env = process.env, fetchImpl }) {
  if (isEmulatorRuntime(env) && !apiKey) return createDevOutboxAdapter(db)
  return createResendAdapter({ apiKey, from, fetchImpl })
}
