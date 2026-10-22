# Deployment

What exists today: a Vite static build, **two manually published rules files**
— `frontend/firestore.rules` and `frontend/storage.rules` — and a
`frontend/firebase.json` carrying the Firestore/Storage emulator configuration,
both rules paths, and (since the Beta Launch Readiness increment) a **Firebase
Hosting block**. **Not implemented:** `.firebaserc`, Cloud Functions, and CI
deployment — all future work.

**First production deployment: 19 October 2026** (the PULSE™ 1B release). The
product owner merged to `main`, Azure CI passed, the full rules suite passed,
`frontend/firestore.rules` was published through the console, Hosting was
deployed by hand, and live behaviour was verified. Every deploy is still a
manual action: no `.firebaserc` exists, so no Firebase project is targeted by
default, and every deploy below must name its project explicitly with
`--project`. Rules publishing is still **manual** (below) and is *not* wired to
the CLI — do not add `firestore:rules` or `storage` to a deploy command.

**SHIELD™ foundation (ADR-50): released 19 October 2026** as a Hosting-only
deploy (no rules change, no migration, no backfill) — merged to `main`, Azure
CI passed, Hosting deployed by hand, the five commercial checks verified in
production.

**Quant™ 1A (ADR-51): LIVE IN PRODUCTION (October 2026).** The first Hosting
deploy of the Quant merge could not be verified: the Quant tab reported
*Takeoff records are unavailable*, PDF sheets did not load, and a *Revision
not found* banner appeared with no drawing selected. The hotfix below was then
released in the order listed (trimmed rules published and confirmed live,
bucket CORS corrected, Hosting deployed) and the core functionality — rules,
Storage CORS, calibration and measurement — was **verified in production**.
The repository records the month, not the day, of that verification. The
diagnosis (ADR-51 hotfix amendment) found three separate causes, two of them
confirmed in code and one inferred from the symptoms:

- **Rules source size (inferred, highly likely).** `frontend/firestore.rules`
  had grown to **264,907 UTF-8 bytes**, above Firestore's **256 KB (262,144
  byte) limit on published source text**. The console refuses a ruleset over
  that limit and the *previous* ruleset stays active — which, having no
  `takeoffPages` / `takeoffMeasurements` blocks, denies every read of them by
  default. The hotfix branch trims comment text to **192,616 bytes** with the
  non-comment rules byte-identical, and adds `tests/unit/rulesSize.test.js` so
  CI fails before a publish can. **Verify which ruleset is actually live
  before republishing** — see *Verifying which rules version is published*
  below. Neither the emulator suite nor the size test proves what is deployed.
- **Storage CORS (confirmed in code).** The installed SDK's `getBytes` sends
  `Authorization`, `Range`, `X-Firebase-Storage-Version` and
  `X-Firebase-GMPID` request headers and expects a **206** response; the saved
  bucket rule allowed only `Content-Type`. See the corrected configuration and
  the two-part verification in *Cloud Storage CORS for the Quant™ viewer*.
- **Revision banner (confirmed in code, fixed).** The workspace showed the
  missing-revision warning when no drawing was selected and while revisions
  were still loading. Fixed in `pages/project/quant/TakeoffWorkspace.jsx`.

Release of the hotfix (completed — kept as the record of the order used), each
a separate approved action:

1. **Confirm the live ruleset** (procedure below) and record what it is.
2. **Publish the trimmed `frontend/firestore.rules`** after `npm run test:rules`
   and `npm run test:unit` pass (the unit suite now enforces the size budget).
   The ADR-40 ordering gate does not apply: nothing in the previous bundle
   writes these paths.
3. **Apply the corrected bucket CORS rule** and verify the OPTIONS preflight
   and the GET separately (below).
4. **Deploy Hosting** with the hotfix build: `npm run build` + `firebase deploy
   --only hosting --project constrapp-69b5d`.
5. **Verify in production** per TESTING.md §27 — done (October 2026; see above).

`frontend/storage.rules` is **unchanged**; no Storage read permission widens.

**Quant™ 1B (ADR-52): IMPLEMENTED — NOT YET DEPLOYED. ⚠️ RULES FIRST, HOSTING
SECOND — the reverse of the ADR-40 gate.** The 1B bundle writes a new key,
`boqItemId`, on **every** measurement save (null or an id), and the LIVE
`takeoffMeasurements` block's `hasOnly` **rejects any unknown key** — so a
Hosting deploy ahead of the rules would break every measurement save on the
Quant tab with *You do not have permission to save measurements*. The reverse
order is safe: the revised rules accept measurement documents **with or
without** the key (it is in `hasOnly`, not `hasAll`), and the live bundle never
sends it; the `boqItems` change is likewise additive (`quantApplied` optional,
refused at create, preserved or fresh on edit). Release, in order, each a
separate approved action:

1. `cd frontend && npm run test:unit && npm run test:rules` — green, and the
   size test passes (`firestore.rules` is **196,034 bytes** against the
   245,000-byte budget; `wc -c frontend/firestore.rules`).
2. **Publish `frontend/firestore.rules`** (procedure below) and **confirm the
   live version** (*Verifying which rules version is published*). From this
   moment the live 1A bundle keeps working unchanged.
3. `npm run build` + `firebase deploy --only hosting --project constrapp-69b5d`.
4. **Verify in production** per TESTING.md §28 (link, review, apply; stale
   refusal; roles) and record the outcome here.

`frontend/storage.rules` is **unchanged**; no bucket CORS change is needed (the
dialog reads no file bytes). **Rollback:** redeploying the previous Hosting
build is sufficient and needs no rules change — the revised rules accept every
write the 1A bundle makes. Rolling the *rules* back to the pre-1B version
while the 1B bundle is live would re-break measurement saves; do not.

## Prerequisites

- Node.js 20+
- A Firebase project with **Authentication** (Email/Password), **Firestore**, and
  — since the Documents & Drawings foundation — **Cloud Storage** enabled.
  (Hosting is configured in `frontend/firebase.json` and was first deployed by
  hand on 19 October 2026.) See *Enabling Cloud Storage* below: enabling it in the
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

## Firebase Hosting — deployed by hand (no CI deploy)

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
3. **Run `npm run test:unit`** — `tests/unit/rulesSize.test.js` fails if the
   file exceeds the approved budget of **245,000 UTF-8 bytes** (Firestore's
   hard limit is **262,144 bytes**; a larger file is REFUSED by the console and
   the previous ruleset silently stays active — the Quant™ 1A incident). To
   check by hand: `wc -c frontend/firestore.rules` (bytes, not characters).
4. Open Firebase console → Firestore Database → **Rules**.
5. Paste the full file contents over the editor content.
6. **Publish** — and read the result. A red error banner (for example *Rules
   are too large* or a compile error) means **nothing was published**: the
   previous ruleset remains in force.
7. **Confirm the live version** (next section) before telling anyone the rules
   are out.

Keep the console and the repo file identical — the repo copy is the reviewed
artifact; the console copy is what actually enforces.

### Verifying which rules version is published

The emulator suite proves the repo file; the size test proves it can be
published; **only the console shows what is live.** To confirm:

1. Firebase console → Firestore Database → **Rules**. The editor shows the
   **active** ruleset. Use the version/history selector beside it (labelled by
   publish timestamp) — the newest entry is the live one, and its timestamp
   must be after the publish you performed.
2. In the editor search (Ctrl/Cmd-F) for `takeoffPages`. If absent, the
   Quant™ blocks are not live, whatever the repo contains.
3. For an exact comparison, copy the editor contents to the clipboard and run
   `diff <(pbpaste) frontend/firestore.rules` (macOS) — an empty diff means
   the live ruleset is the repo file. Any difference (or a different byte count
   from `wc -c`) means the repo and production have diverged.
4. Cross-check from the app: in DevTools → Network, open the long-running
   `Listen/channel` request and read its response stream; a target rejected by
   rules carries `"status": "PERMISSION_DENIED"` with the collection path.
   A channel that fails at the network level shows no such body and affects
   every tab of the app, not one collection — do not read it as a denial.
5. Record the live timestamp, the byte count and the outcome in this file
   with the release note.

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
it ships first. If a code change adds a key that the LIVE rules' `hasOnly`
would reject, the rules ship first** (Quant™ 1B, ADR-52 — above). Existing documents are unaffected either way — the ADR-40
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

## Cloud Storage CORS for the Quant™ viewer — Manual Process (one time)

**Why.** Quant™ 1A (ADR-51) measures on a PDF by drawing the page itself, so
it must read the file's **bytes** into the browser (`getBytes` in
`hooks/useStorageUpload.jsx`, an XHR to `firebasestorage.googleapis.com`).
Everything the app did before — `Open`, `Download`, the `<iframe>` preview,
`<img>` — navigates to the file or embeds it, which browsers allow cross-origin.
Reading bytes with script does not: the browser enforces **CORS**, and a Cloud
Storage bucket serves no CORS headers until a rule is set on it. The Firebase
documentation (*Download files on Web → CORS configuration*) requires this
step for browser downloads.

**Status: not verified from the repository.** No CORS configuration is
recorded anywhere in this repo, and an implementation task **must not** change
bucket configuration. Whether the production bucket already carries a rule can
only be seen with the command in step 1.

1. **Inspect the current rule** (replace `<bucket>` with the value of
   `VITE_FIREBASE_STORAGE_BUCKET`, e.g. `constrapp-69b5d.appspot.com` or
   `constrapp-69b5d.firebasestorage.app`):

   ```bash
   gsutil cors get gs://<bucket>
   ```

   `[]` or "has no CORS configuration" means step 2 is required.

2. **Required configuration** — `cors.json` (keep it outside the repo; it is
   bucket configuration, not source). It is derived from what the **installed
   SDK (`firebase` 12 / `@firebase/storage`) actually sends** for
   `getBytes(ref, maxDownloadSizeBytes)`: a `GET …?alt=media` with the request
   headers `Authorization: Firebase <token>`, `Range: bytes=0-<max>`,
   `X-Firebase-Storage-Version` and `X-Firebase-GMPID` (sent because the app is
   configured with `VITE_FIREBASE_APP_ID`; `X-Firebase-AppCheck` would be added
   only if App Check were enabled, which it is not), and a **206 Partial
   Content** response that the SDK accepts as success. Those request headers
   are not CORS-safelisted, so the browser **preflights** with OPTIONS, and
   Cloud Storage answers the preflight's `Access-Control-Allow-Headers` from
   the bucket rule's `responseHeader` list. The rule saved during the incident
   listed only `Content-Type`, which is why the preflight could not authorise
   the request headers and the 206 arrived without `Access-Control-Allow-Origin`.

   ```json
   [
     {
       "origin": [
         "https://constrapp-69b5d.web.app",
         "https://constrapp-69b5d.firebaseapp.com"
       ],
       "method": ["GET"],
       "responseHeader": [
         "Authorization",
         "Range",
         "X-Firebase-Storage-Version",
         "X-Firebase-GMPID",
         "Content-Type",
         "Content-Length",
         "Content-Range"
       ],
       "maxAgeSeconds": 3600
     }
   ]
   ```

   Nothing else is required: `GET` is the only method (OPTIONS preflights are
   answered by Cloud Storage itself and need no entry), uploads go through the
   SDK's resumable protocol and are unaffected, and `maxAgeSeconds` only caches
   a *successful* preflight. Add `http://localhost:5173` to `origin` **only**
   on a development bucket, never on production. Nothing here widens *who* may
   read an object — Storage Rules still decide that; CORS only lets the browser
   hand the bytes to the page once the rules allowed the request. The
   authenticated SDK download, its 50 MB bound and the Storage Rules boundary
   are all kept; no token-bearing download URL is used for bytes.

   ```bash
   gsutil cors set cors.json gs://<bucket>
   gsutil cors get gs://<bucket>     # confirm it echoes the rule
   ```

3. **Verify in production — the preflight and the GET are two separate
   checks.** First **hard-reload with DevTools open and "Disable cache"
   ticked**: a failed preflight is cached by the browser for up to
   `maxAgeSeconds`, so a stale failure can outlive the fix. Then, as a QS, open
   a project's **Quant** tab and choose a drawing with a **PDF** revision. In
   DevTools → Network filter on `alt=media`:
   - **OPTIONS (preflight)** — status 200; response headers must include
     `Access-Control-Allow-Origin: https://constrapp-69b5d.web.app` (or the
     `.firebaseapp.com` origin you used) and `Access-Control-Allow-Headers`
     listing `authorization`, `range`, `x-firebase-storage-version` and
     `x-firebase-gmpid`. A missing header here means the bucket rule is wrong
     or not yet propagated (allow a few minutes after `gsutil cors set`).
   - **GET (actual)** — status **206** (expected: the SDK sends `Range`), and
     the response headers must include `Access-Control-Allow-Origin` for the
     same origin. A 206 **without** that header is the incident signature.
   *Pass:* both requests carry the origin header and the sheet renders with
   the Calibrate tool enabled. *Fail:* within 20 seconds the viewer reads
   *"The PDF could not be downloaded for measuring… (CORS)"*; the SDK will
   keep retrying in the background for up to two minutes, which is expected
   and harmless. A PNG/JPEG revision rendering while a PDF does not is the
   signature of a CORS problem, not of a rules or permission problem.

4. **Record the outcome** in this file (date, bucket, rule applied or already
   present) so the prerequisite is never re-diagnosed.

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

### Steps 5 and 6 — the Supplier Invoice rules gate (closed 19 October 2026)

**Merged code is not a published control.** When this section was written the
ADR-40 supplier-invoice hardening was in the codebase but the hardened rules had
not been published, so those invariants were **not enforced in production**.
The gate was closed on 19 October 2026 when the whole rules file was published
with the PULSE™ 1B release. The ordering below is kept because it applies to
every future rules change that tightens a write path:

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
