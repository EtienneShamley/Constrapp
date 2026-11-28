import { defineBoolean, defineInt, defineSecret, defineString } from 'firebase-functions/params'

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

// ADR-75 (DC46-C) — periodic reconciliation by the SAME worker.
//   0 (the default) = OFF: no planning, no cursor read or write, no periodic
//   request. Membership and operator revocation run exactly as in ADR-74.
//   1–168 = a company is swept again once its last SUCCESSFUL sweep started
//   that many hours ago.
//   Anything else is INVALID. The CLI does not range-check a dotenv value, so
//   two things stand guard: `functions/test/fileLinks.test.js` — run by the
//   deploy's predeploy step — fails on an invalid value in any
//   `.env.<projectId>`; and at run time the worker still does its revocation
//   work, keeps reconciliation off, and then FAILS the run naming this setting
//   (lib/fileLinkRevocation.js → runScheduledWorker). It is never silently off.
//   The run-time check reads the RAW text, because an int parameter would
//   read "24h" as 24.
// ⚠️ Setting this above 0 in production needs its own authorisation
//    (docs/DEPLOYMENT.md → DC46-C). It is a bound, never a guarantee.
export const RECONCILE_INTERVAL_ENV = 'FILE_LINK_RECONCILE_INTERVAL_HOURS'
export const FILE_LINK_RECONCILE_INTERVAL_HOURS = defineInt(RECONCILE_INTERVAL_ENV, { default: 0 })

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

// ADR-77 — feature flag for the ONE financial callable. `false` + a redeploy of
// that function makes it answer `final-account-disabled` before any read;
// drafts, withdrawal and every approved record are unaffected.
// The default is FALSE — fail closed: a project whose `.env.<projectId>` does
// not state the flag cannot approve. Every project file sets it EXPLICITLY
// (a non-interactive deploy refuses a parameter with no dotenv value anyway),
// and functions/test/finalAccount.test.js pins that.
export const FINAL_ACCOUNT_APPROVAL_ENABLED = defineBoolean('FINAL_ACCOUNT_APPROVAL_ENABLED', { default: false })

// ADR-81 (L4) — the transferBoqToBudget callable. `false` + a redeploy of
// that function makes it answer `boq-transfer-disabled` before any read; BOQ
// items, budget lines and every approved budget version are unaffected.
// The default is FALSE — fail closed, exactly as the flag above — and every
// project file states it explicitly (functions/test/boqBudget.test.js).
export const BOQ_BUDGET_TRANSFER_ENABLED = defineBoolean('BOQ_BUDGET_TRANSFER_ENABLED', { default: false })

// ADR-89 — the four client-finance callables (postClientCreditNote,
// voidClientCreditNote, postClientRetentionRelease, voidClientRetentionRelease)
// share ONE switch, which governs those four ONLY. `false` + a redeploy of
// those functions makes each answer `client-finance-disabled` before any read
// or write; drafts, posted entries and every ledger are unaffected (and, the
// Rules giving no client a path to post, nothing can be posted or un-posted
// while it is off). It is the global BRAKE. With it on, each COMPANY must
// still be activated (`companies/{id}.clientFinanceEnabled === true`, written
// only by scripts/set-client-finance.mjs) before these four do anything for it.
//
// CUTOVER ORDER (production starts with BOTH switches off):
//   1. the six callables deployed, both switches `false`;
//   2. the restrictive Rules published (no browser can post or void directly);
//   3. verified;
//   4. Hosting;
//   5. CLIENT_RECEIPT_POSTING_ENABLED=true with CLIENT_RECEIPT_ALL_COMPANIES
//      still false — receipts for the TEST company only (activated with the
//      operator script, --receipts); the first call on each of ITS projects
//      establishes that project's historical receipt baseline; verified;
//   6. after architect acceptance, CLIENT_RECEIPT_ALL_COMPANIES=true —
//      receipts for every company;
//   7. CLIENT_FINANCE_POSTING_ENABLED=true, then the TEST company activated
//      with the operator script;
//   8. acceptance; 9. general availability, company by company.
// The default is FALSE — fail closed, exactly as the two flags above — and every
// project file states it explicitly (functions/test/clientFinance.test.js).
export const CLIENT_FINANCE_POSTING_ENABLED = defineBoolean('CLIENT_FINANCE_POSTING_ENABLED', { default: false })

// ADR-89 — the two client-RECEIPT callables (postClientReceipt,
// voidClientReceipt), under their OWN switch. Receipts are an existing, live
// workflow: once the Rules refuse a browser's direct posting, this switch is
// what lets a receipt be posted at all. The cutover starts with it OFF (step 1
// above) and turns it on at step 5 — between steps 2 and 5 no receipt can be
// posted or voided. `false` + a redeploy of those two functions makes each
// answer `client-receipt-disabled` before any read or write (no receipt
// baseline is established while it is off). The default is FALSE — fail closed — and every project file
// states it explicitly (functions/test/clientFinance.test.js).
export const CLIENT_RECEIPT_POSTING_ENABLED = defineBoolean('CLIENT_RECEIPT_POSTING_ENABLED', { default: false })

// ADR-89 (S6) — the SCOPE of the receipt switch above. While this is `false`
// the two receipt callables act only for a company whose document carries
// `clientReceiptsEnabled === true` (written only by
// scripts/set-client-finance.mjs --receipts); every other company gets the
// same `client-receipt-disabled` answer as with the switch off, before any
// read of project data and before any baseline is written. `true` + a redeploy
// of those two functions opens receipts to every company — the normal state
// after the cutover. It never widens anything on its own: with
// CLIENT_RECEIPT_POSTING_ENABLED off, nobody posts. Independent of
// `clientFinanceEnabled` in both directions. The default is FALSE — fail
// closed — and every project file states it explicitly.
export const CLIENT_RECEIPT_ALL_COMPANIES = defineBoolean('CLIENT_RECEIPT_ALL_COMPANIES', { default: false })

// Phase 2 step 5 (ADR-95) — client refunds and receipt applications
// (postClientRefund, voidClientRefund, postClientReceiptApplication,
// voidClientReceiptApplication). OFF by default and OFF in production until
// their release is authorised; with it off each answers
// `client-settlement-disabled` before reading any project data. A company must
// ALSO carry `clientFinanceEnabled === true` (the operator flag credit notes
// and releases use). The trusted void of an issued client invoice is NOT under
// this switch: it is part of the receipt workflow (CLIENT_RECEIPT_POSTING_ENABLED).
export const CLIENT_SETTLEMENT_ENABLED = defineBoolean('CLIENT_SETTLEMENT_ENABLED', { default: false })

// ADR-90 — the three variation callables (createVariation, approveVariation,
// applyVariationCommitment) share ONE switch. `false` + a redeploy of those
// functions makes each answer `variation-processing-disabled` before any read
// or write; every stored variation is unaffected. Once the FINAL Security
// Rules are published no browser can create or approve a variation directly,
// so this switch is then the BRAKE on those three actions (draft edits,
// submit, reject and withdraw stay with the Rules and keep working).
//
// CUTOVER ORDER (production starts with the switch off):
//   1. the three callables deployed, switch `false` (plus every callable whose
//      generated bundle changed — DEPLOYMENT.md lists them);
//   2. the switch set `true` and the three redeployed; verified by a refused
//      unauthenticated call — the Rules published at this point are still the
//      previous ones, so the served bundle keeps writing directly and nothing
//      is interrupted;
//   3. Hosting — the new bundle creates and approves through the callables;
//   4. the FINAL Rules — a direct create, approve or apply is refused from
//      then on (a tab still on the old bundle must reload for those actions).
// The default is FALSE — fail closed, exactly as the flags above — and every
// project file states it explicitly (functions/test/variations.test.js).
export const VARIATION_PROCESSING_ENABLED = defineBoolean('VARIATION_PROCESSING_ENABLED', { default: false })

// ADR-93 / ADR-94 — Phase 2 steps 3–4: the three supplier-finance callables
// (progress claims, supplier invoices, supplier settlement). Default FALSE —
// fail closed. Turned on only AFTER the final Rules that remove every client
// write path to those registers are published (docs/DEPLOYMENT.md → Phase 2
// steps 3–4): the historical baseline is established lazily by the first
// operation, and must never be computed while an old bundle can still write.
export const SUPPLIER_FINANCE_PROCESSING_ENABLED = defineBoolean('SUPPLIER_FINANCE_PROCESSING_ENABLED', { default: false })

// ADR-96 — Phase 2 step 6: the original-contract-value correction callable.
// Default FALSE — fail closed; on only after the final Rules that freeze the
// value on the baseline are published.
export const CONTRACT_VALUE_REVISION_ENABLED = defineBoolean('CONTRACT_VALUE_REVISION_ENABLED', { default: false })

// ADR-97 — Phase 2 step 7: the estimating callable (`estimateOperation`).
// Default FALSE — fail closed; on only after the Rules that make the estimate
// collections read-only to clients are published.
export const ESTIMATING_ENABLED = defineBoolean('ESTIMATING_ENABLED', { default: false })

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
  reconcileIntervalRaw: process.env[RECONCILE_INTERVAL_ENV],
})
