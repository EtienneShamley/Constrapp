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

// ADR-74 (DC46-B) — the file-link revocation worker.
//   FILE_LINK_REVOCATION_ENABLED=false + redeploy pauses the WORKER only:
//   membership changes still record their revocation requests, which wait.
//   STORAGE_BUCKET names the bucket to sweep; empty means the project's
//   default bucket from the runtime configuration.
export const FILE_LINK_REVOCATION_ENABLED = defineBoolean('FILE_LINK_REVOCATION_ENABLED', { default: true })
export const STORAGE_BUCKET = defineString('STORAGE_BUCKET', { default: '' })

// The worker's DEDICATED runtime identity (ADR-74) — a FULL email, set per
// project in `functions/.env.<projectId>`, so production and the validation
// project each resolve their OWN account and no project id is in source.
//
// Why not the CLI's short form `file-link-worker@`: firebase-tools 15 expands
// it for the function but passes it UNEXPANDED to the Cloud Scheduler job
// (gcp/cloudscheduler.js), which rejects it with HTTP 400 — found in Stage 0.
// The regex below makes a deploy with a malformed value refuse to start.
//
// The account must exist BEFORE the deploy, holding only roles/datastore.user
// (project) and the file-link custom role (storage.objects.list/get/update)
// on the ONE bucket. Cloud Scheduler invokes the worker with an OIDC token for
// this same account (the CLI ties the two together for onSchedule) and the CLI
// grants run.invoker for it on THIS service only. The shared default compute
// account (Cloud Build, every other function) is not touched.
// docs/DEPLOYMENT.md → DC46-B.
export const WORKER_SA_PATTERN = '^file-link-worker@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$'
export const FILE_LINK_WORKER_SERVICE_ACCOUNT = defineString('FILE_LINK_WORKER_SERVICE_ACCOUNT', {
  description: 'Runtime service account of processFileLinkRevocations: file-link-worker@<projectId>.iam.gserviceaccount.com',
  input: { text: { validationRegex: WORKER_SA_PATTERN, validationErrorMessage: 'Must be file-link-worker@<this projectId>.iam.gserviceaccount.com' } },
})

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

export const readFileLinkConfig = () => ({
  enabled: FILE_LINK_REVOCATION_ENABLED.value(),
  bucket: STORAGE_BUCKET.value(),
})
