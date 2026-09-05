# Deployment

What exists today: a Vite static build, **two manually published rules files**
— `frontend/firestore.rules` and `frontend/storage.rules` — and a
`frontend/firebase.json` carrying the Firestore/Storage emulator configuration,
both rules paths, and (since the Beta Launch Readiness increment) a **Firebase
Hosting block**. **Not implemented:** `.firebaserc`, Cloud Functions, and CI
deployment — all future work.

**Nothing has been deployed.** The hosting configuration is written but has
never been run: no `.firebaserc` exists, so no Firebase project is targeted by
default, and every deploy below must name its project explicitly with
`--project`. Rules publishing is still **manual** (below) and is *not* wired to
the CLI — do not add `firestore:rules` or `storage` to a deploy command.

## Prerequisites

- Node.js 20+
- A Firebase project with **Authentication** (Email/Password), **Firestore**, and
  — since the Documents & Drawings foundation — **Cloud Storage** enabled.
  (Hosting is configured in `frontend/firebase.json` but has never been
  deployed.) See *Enabling Cloud Storage* below: enabling it in the
  console installs a permissive starter ruleset that **must** be replaced with
  `frontend/storage.rules` in the same sitting.
- Users provisioned manually: an Auth user plus a matching `users/{uid}`
  document — see [SECURITY.md](SECURITY.md).

## Environment Variables

Copy `frontend/.env.example` to `frontend/.env.local` and fill in the Firebase
web app config (Console → Project settings → Your apps → SDK setup):

| Variable | Source |
|---|---|
| `VITE_FIREBASE_API_KEY` | `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | `appId` |

These are read by `frontend/src/lib/firebase.js`. `.env.local` is git-ignored —
never commit it. (A root-level `.env.example` also exists with a few extra placeholders the
app never reads; the frontend one is canonical.)

### ⚠️ The shipping build needs these at BUILD TIME

Vite inlines `import.meta.env.VITE_*` into the bundle when `npm run build` runs.
They are **not** read at runtime, so a built `dist/` cannot be reconfigured
afterwards — the values are baked in.

**The Azure pipeline sets none of them.** `npm run build` in CI therefore
succeeds (Vite does not fail on missing env) and produces a bundle whose
Firebase config is entirely `undefined`. That artifact is harmless today because
the pipeline has no deploy stage, but it is **not deployable** — the CI build
proves the code compiles, nothing more.

Whatever produces the shipping build must supply the production `VITE_FIREBASE_*`
values in its environment before `npm run build`. Solving that for Azure
(variable groups / a secret store) is deliberately **not** done here.

Every `VITE_`-prefixed value ships in the public bundle. That is correct for
Firebase web config, which is public by design and enforced by Security Rules —
and it is exactly why no real secret may ever be `VITE_`-prefixed (see
[SECURITY.md](SECURITY.md) → Secrets & the Vite bundle).

## Build

All commands run from `frontend/` — the repository root has no `package.json`.

```bash
cd frontend
npm install
npm run build     # outputs static site to frontend/dist/
npm run preview   # serve the build locally
```

`frontend/dist/` can be served by any static host.

## Firebase Hosting — configured, never deployed

`frontend/firebase.json` now carries a `hosting` block:

```json
"hosting": {
  "public": "dist",
  "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
  "rewrites": [{ "source": "**", "destination": "/index.html" }]
}
```

Two things about it matter:

- **`"public": "dist"` is relative to `firebase.json`,** which lives in
  `frontend/`. `vite build` writes `frontend/dist`, so the path is correct as
  written — it is *not* `frontend/dist`.
- **The `**` → `/index.html` rewrite is load-bearing, not boilerplate.**
  Constrapp uses `BrowserRouter` with deep paths such as
  `/projects/{projectId}/commercial/cash-flow`. No file exists at those paths,
  so without the rewrite a hard refresh or a shared link returns 404 and the app
  looks broken. Verify this explicitly after the first deploy.

**The deploy command (for the release runbook — DO NOT run it from a task that
was not asked to deploy):**

```bash
cd frontend
npm run build            # with production VITE_FIREBASE_* in the environment
firebase deploy --only hosting --project constrapp-69b5d
```

`--project` is **required**: there is no `.firebaserc`, so nothing is targeted by
default. Naming it explicitly is also the safer habit — it makes the target
visible in the command rather than in a file nobody reads.

⚠️ **`--only hosting` is required too.** A bare `firebase deploy` would also
attempt Firestore and Storage rules, and **rules publishing is manual and
reviewed** (below). Never widen this command.

Not configured, and out of scope here: a CI deploy stage, Azure secret
management, custom domains, and cache-control headers.

## Publishing Firestore Rules — Manual Process

The rules source of truth is `frontend/firestore.rules`, but **there is no CLI
wiring to deploy it** (no `.firebaserc`, so no project is targeted). Publishing is
manual:

1. Edit `frontend/firestore.rules` in the repo (review against
   [SECURITY.md](SECURITY.md)).
2. **Run `npm run test:rules`** and confirm it passes — the emulator suite loads
   this exact file (see [TESTING.md](TESTING.md) §0).
3. Open Firebase console → Firestore Database → **Rules**.
4. Paste the full file contents over the editor content.
5. **Publish.**

Keep the console and the repo file identical — the repo copy is the reviewed
artifact; the console copy is what actually enforces.

### ⚠️ ORDERING GATE — application code first, rules second (ADR-40)

Rules and application code are versioned together in this repo but **published
separately**, so a rules change that requires a NEW FIELD must not reach the
console before the code that writes it. Publishing out of order is an outage,
not a rollback-able mistake: every write the old bundle issues is rejected with
"Missing or insufficient permissions" until the new bundle is live.

**One such gate is outstanding.** The ADR-40 `supplierInvoices` block requires
`updatedAt` / `updatedBy` on every write and `cancelledBy` on a cancellation.
Supplier-invoice writes issued before ADR-40 send **none of those three**, so:

1. Deploy the application build containing `hooks/useSupplierInvoices.jsx` first.
2. Confirm the deployed bundle is live and a supplier invoice can be created,
   edited, approved, posted and cancelled against the CURRENT (pre-ADR-40) rules
   — the new fields are additive, so the old rules accept them.
3. Only then publish `frontend/firestore.rules`.

Reversing those steps breaks **create, draft edit, approve, post and cancel** on
the Supplier Invoices register for every user until the build catches up.

The general rule: **if a rules change adds a required field, the code that writes
it ships first.** Existing documents are unaffected either way — the ADR-40
block reads `cancelledBy` through `get(key, null)` on both sides and requires the
audit stamps only of the INCOMING document, so a pre-ADR-40 invoice stays
editable and acquires the new fields on its next valid write.

## Enabling Cloud Storage — Manual Process (one time)

Documents & Drawings stores file bytes in Cloud Storage. Until Storage is
enabled **and** `frontend/storage.rules` is published, every upload fails and the
app reports *"File storage is not set up for this Firebase project yet."*

⚠️ **The order matters.** Enabling Storage installs Google's starter ruleset,
which is far more permissive than this app's. Do not upload anything — not even
a test file — between enabling Storage and publishing `storage.rules`.

1. Firebase console → **Build → Storage → Get started**.
2. When prompted for a rules mode, choose **production mode** (deny-all) rather
   than test mode. Test mode grants open read/write for 30 days.
3. Accept the **default bucket** (`<projectId>.appspot.com` or
   `<projectId>.firebasestorage.app`, depending on project vintage) and pick a
   location **in the same region as Firestore**. ⚠️ The bucket location is
   **permanent** and cannot be changed afterwards.
4. Confirm the bucket name matches `VITE_FIREBASE_STORAGE_BUCKET` in
   `frontend/.env.local` (Console → Project settings → Your apps → SDK setup →
   `storageBucket`). If they differ, update `.env.local` and rebuild — the app
   resolves its bucket from that variable.
5. Storage → **Rules** → replace the entire editor contents with
   `frontend/storage.rules` → **Publish**.
6. Confirm the published rules contain `service firebase.storage` and the
   `match /{allPaths=**} { allow read, write: if false; }` catch-all, and contain
   **no** `allow read, write: if true` and no `request.time <` date clause.

Run `npm run test:rules` before publishing: the emulator suite loads this exact
file and covers tenant isolation, writer roles, content types, size ceilings and
create-only immutability.

## Publishing Storage Rules — Manual Process (every change)

Identical discipline to Firestore rules:

1. Edit `frontend/storage.rules` (review against [SECURITY.md](SECURITY.md) →
   *Cloud Storage — the SECOND trust boundary*).
2. **Run `npm run test:rules`** — one command runs both the Firestore and the
   Storage suites against both emulators.
3. Firebase console → **Storage → Rules**.
4. Paste the full file contents over the editor content.
5. **Publish.**

## Private-Beta Release Checklist

Run once, in this order, before the first beta user is invited. **Every step is
a MANUAL release action** — none of it is automated, and none of it was
performed by the increment that wrote this checklist.

Steps 5, 6 and 7 are ordered for a reason; the notes say why.

| # | Step | Where |
|---|---|---|
| 1 | **Firebase Auth → Email/Password provider enabled.** Sign-in and password reset both depend on it | Console → Authentication → Sign-in method |
| 2 | **Password-reset email template reviewed** — sender name, subject and reply-to. The default template reads as spam, and the reset link is the beta user's only account-recovery path | Console → Authentication → Templates |
| 3 | **Production domain added to Authorized domains.** Sign-in and the hosted reset-confirmation page both refuse to run on an unlisted origin | Console → Authentication → Settings |
| 4 | **Production `VITE_FIREBASE_*` supplied at build time** — see *The shipping build needs these at BUILD TIME* above. A build without them produces a bundle that cannot reach Firebase | Build environment |
| 5 | **Deploy the application build FIRST**, before publishing rules — see the ordering gate below and in *Publishing Firestore Rules* | `firebase deploy --only hosting --project constrapp-69b5d` |
| 6 | **Publish `frontend/firestore.rules` SECOND**, then smoke-test supplier invoices | Console → Firestore → Rules |
| 7 | **Enable Cloud Storage in PRODUCTION mode** (deny-all), default bucket, same region as Firestore. ⚠️ The location is permanent | Console → Build → Storage |
| 8 | **Publish `frontend/storage.rules` IMMEDIATELY** — same sitting, no upload in between, not even a test file. Enabling Storage installs Google's permissive starter ruleset | Console → Storage → Rules |
| 9 | **Confirm the bucket name matches `VITE_FIREBASE_STORAGE_BUCKET`.** If it differs, update the build environment and rebuild — the app resolves its bucket from that variable | Console → Project settings |
| 10 | **Provision the beta tenant out of band**: the `companies/{companyId}` document (`name`, `countryCode`, `baseCurrency`), one Auth user per tester, and a matching `users/{uid}` document (`name`, `email`, `role`, `companyId`, `avatarInitials`) | Console / Admin SDK |
| 11 | **Deploy Hosting** (if not already done at step 5) | `firebase deploy --only hosting --project constrapp-69b5d` |
| 12 | **Verify deep links** — hard-refresh directly on `/projects/{id}/commercial/cash-flow`. A 404 means the SPA rewrite did not take | Browser |
| 13 | **One-off Firestore export** before the first external user | `gcloud firestore export` |
| 14 | **End-to-end smoke test** as a real beta user (below) | Browser |

### ⚠️ Step 10 — a user without a `users/{uid}` document is not an error state

`users/{uid}` is client-read-only (ADR-27): membership is provisioned out of
band and **no browser client can create it**. A tester with an Auth account but
no membership document **signs in successfully and then sees an empty app** —
no company, no projects, no error message, nothing to act on. Verify the
membership document for every invited user individually; there is no in-app
signal that it is missing.

### ⚠️ Steps 5 and 6 — the Supplier Invoice rules gate is NOT closed

**Merged code is not a published control.** The ADR-40 supplier-invoice
hardening is in the codebase, but the hardened rules have not been published,
so those invariants are **not enforced in production today**. Closing the gate
is a three-part release action, in order:

1. **Updated supplier-invoice application code deployed first.** The ADR-40
   rules require `updatedAt` / `updatedBy` on every write and `cancelledBy` on a
   cancellation. A bundle predating ADR-40 sends none of them.
2. **Hardened `frontend/firestore.rules` published second.**
3. **Post-rules supplier-invoice smoke test third** — create, draft edit,
   approve, post and cancel one invoice against the published rules.

Reversing 1 and 2 breaks create, draft edit, approve, post and cancel on the
Supplier Invoices register **for every user** until the build catches up. That
is an outage, not a rollback-able mistake. Full detail in the ordering gate
under *Publishing Firestore Rules*.

### Step 14 — beta smoke test

Sign in → request a password reset and complete it from the email → create a
project → cost code → budget line → purchase order → progress claim → supplier
invoice → supplier payment → upload a drawing. The upload is the step that
proves Storage (steps 7-9) actually landed.

## Future Work (not current functionality)

- `.firebaserc` so a project need not be named on every command (deploys still
  pass `--project` explicitly today)
- Rules deploy via the CLI (`firebase deploy --only firestore:rules,storage`) —
  publishing is manual and reviewed today, deliberately
- Cloud Functions (server-side enforcement — see
  [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) ADR-14)
- CI: a deploy stage, and Azure secret management for the production
  `VITE_FIREBASE_*` values
- Cache-control headers and a custom domain for Hosting
