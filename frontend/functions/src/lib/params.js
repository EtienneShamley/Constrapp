import { defineBoolean, defineSecret, defineString } from 'firebase-functions/params'

// ── Deployment parameters ────────────────────────────────────────────────────
//
// SECRET — held in Google Secret Manager, bound to the functions that need it,
// set with `firebase functions:secrets:set EMAIL_API_KEY --project <id>`.
// Never in a .env file, never in the repository, never `VITE_`-prefixed.
export const EMAIL_API_KEY = defineSecret('EMAIL_API_KEY')

// PLAIN parameters — `functions/.env.<projectId>` (committed, non-secret).
// Empty defaults are deliberate: an unconfigured deployment refuses to send
// invitations (`app-url-not-configured` / `email-not-configured`) instead of
// sending a broken link from a placeholder sender.
export const APP_BASE_URL = defineString('APP_BASE_URL', { default: '' })
export const EMAIL_FROM = defineString('EMAIL_FROM', { default: '' })

// Kill switch: `TEAM_MANAGEMENT_ENABLED=false` + redeploy makes every callable
// answer `team-management-disabled` without touching data.
export const TEAM_MANAGEMENT_ENABLED = defineBoolean('TEAM_MANAGEMENT_ENABLED', { default: true })

// One region, matching the Firestore location (docs/DEPLOYMENT.md → Functions).
export const REGION = 'australia-southeast1'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// `.value()` is only legal at request time — never at module scope.
export const readConfig = () => ({
  appBaseUrl: APP_BASE_URL.value(),
  emailFrom: EMAIL_FROM.value(),
  enabled: TEAM_MANAGEMENT_ENABLED.value(),
  inviteTtlMs: INVITE_TTL_MS,
})
