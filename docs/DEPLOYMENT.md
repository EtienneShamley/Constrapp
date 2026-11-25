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

**Quant™ 1C (ADR-53, stages 1C-A and 1C-B): LIVE IN PRODUCTION since
23 October 2026.** Released Hosting-only — merged to `main`, Azure CI passed,
`firebase deploy --only hosting` by hand, **no rules publish** (the 1C bundle
changed no collection, no document shape and no rule; `firestore.rules` and
`storage.rules` stayed byte-identical to the 1B release at 196,034 bytes) —
and the product owner verified the live production smoke checks on 23 October
2026. The repository records the day, not a time, and no further production
test result.

**Quant™ 1D (ADR-54, embedded deductions): LIVE IN PRODUCTION since
26 October 2026** — merged to `main`, Azure CI passed, the revised
`firestore.rules` published FIRST and confirmed live, Hosting deployed, and
the TESTING.md §30 checks verified in production by the product owner that
day (the repository records the day, not a time). The release order below is
kept as the record of the order used. The 1D bundle adds
ONE optional key to `takeoffMeasurements`, `deductions` (area only, a list
of ≤ 50 holes), in `hasOnly` but not `hasAll` — so the revised rules accept
every existing document and every write the live bundle sends. The reverse
is not true: the LIVE ruleset's `hasOnly` rejects the new key, so a Hosting
deploy ahead of the rules would refuse the **first deduction on any area**
with *You do not have permission to save measurements*. Ordinary saves would
keep working, because 1D never writes the key at create and only sends it
once a deduction exists — but the feature would be dead on arrival. Hence the
ADR-52 order again:

1. `cd frontend && npm run lint && npm run test:unit && npm run test:rules &&
   npm run build` — green, and the size test passes (`firestore.rules` is
   **196,622 bytes** against the 245,000-byte budget).
2. **Publish `frontend/firestore.rules`** (procedure below) and **confirm the
   live ruleset** is the published one before step 3. Nothing in the
   previous bundle writes `deductions`, so publishing first changes no live
   behaviour.
3. `firebase deploy --only hosting --project constrapp-69b5d`.
4. **Verify in production** per TESTING.md §30 (a deduction traced inside an
   area shows gross − deductions = net in the list, the page status and the
   project summary; a hole outside the outline or overlapping another is
   refused with its reason; an existing invalid set blocks the BOQ apply and
   is fixed by Remove; the apply writes the NET and the previous application
   reads *outdated* once a hole changes) and record the outcome here.

**Rollback.** Hosting: redeploy the previous build — check out the 1C commit,
`npm run build`, `firebase deploy --only hosting --project constrapp-69b5d` —
or use the Firebase Console's Hosting release history (*Rollback* on the
previous release). ⚠️ There is **no `firebase hosting:rollback` command** in
the installed firebase-tools (13.35.1; corrected by ADR-65 — the earlier text
here named one), and `hosting:clone` copies a channel to another channel, not
a historic release. Nothing in 1D is needed by earlier bundles. Rules: the revised ruleset can stay published after a Hosting
rollback (it is a strict superset; the 1C bundle never sends the key), and it
is the recommended state. If the rules themselves must be reverted, re-publish
the 1C ruleset (196,034 bytes); any measurement that already carries a
`deductions` key then becomes **read-only for active edits** (its next
`update` fails `exactKeys` until the key is accepted again) but stays
readable, derivable and voidable — no data is lost and nothing financial is
affected.

**Forecast and Actual Cost Integrity — M1 (ADR-55): LIVE IN PRODUCTION since
27 October 2026 (shipped in the combined M2-B3 Hosting deploy, verified against
matching local and production asset hashes). HOSTING-ONLY — no rules change,
no migration, no backfill.** The M1
bundle changes read-time derivation and page behaviour only: Remaining
Committed nets approved claims not yet invoiced (every Committed, FFC,
Variance, Margin, Dashboard, Cash Flow and PULSE figure that was overstated by
an approved-but-uninvoiced claim corrects itself on first render), the
supplier invoice and progress claim editors block mixed-mode combinations,
SHIELD check 4 gains condition E, the Budget page gates every figure on source
readiness, and the cost-code / contacts hooks expose their read errors.
`frontend/firestore.rules` and `frontend/storage.rules` are **byte-identical**
to the 1D publish (196,622 bytes) — do not republish them.

1. `cd frontend && npm run lint && npm run test:unit && npm run build` — green
   (the rules suite is unaffected but must still be green in Azure CI, which
   is blocking).
2. `firebase deploy --only hosting --project constrapp-69b5d`.
3. **Verify in production** per TESTING.md §31 (an approved uninvoiced claim
   reads once in FFC; a direct invoice on a claimed line is refused; the
   Supplier Invoices notice and SHIELD condition E list an existing overlap;
   the Budget page shows *Unavailable*, never $0, on a rejected read) and
   record the outcome here.

**Rollback.** Hosting only: redeploy the previous (1D) build — nothing in M1
writes a new field, so the earlier bundle reads every document unchanged. The
figures then revert to the pre-ADR-55 derivation (the known overstatement),
which is why the rollback should be brief.

**Financial Read-Access Containment — M2-A (ADR-56): LIVE IN PRODUCTION since
27 October 2026 — merged to `main`, Azure CI green, the revised ruleset
published through the console, confirmed live and production-verified per
TESTING.md §32 by the product owner that day (the repository records the day,
not a time). RULES-ONLY — no Hosting deploy, no migration, no schema change.
The release order below is kept as the record of the order used.**
The revised `frontend/firestore.rules` (**197,035 bytes**; 196,622 before)
restricts **reads** of `costCodes`, `budgetLines`, `purchaseOrders` and
`progressClaims` to the three financial roles. It changes **no write rule, no
other collection and not `storage.rules`**, and it needs **no ordering gate**:
it adds no field and tightens no `hasOnly`, so the live bundle keeps working
for every financial role, while a `subcontractor` / `client` session's four
subscriptions start receiving `PERMISSION_DENIED` and the pages show their
*unavailable* state (ADR-41/44) — the intended outcome. It was released
independently of the M1 Hosting hold, which still stands (M1 is merged; its
Hosting deploy awaits cofounder acceptance).

1. Feature review; commit and merge to `main`; Azure CI green (lint → unit →
   **rules** → build — the rules step is the gate for this release).
2. **Confirm the live ruleset first** (procedure below) and record its
   timestamp and byte count (expected: the 1D / M1 ruleset, 196,622 bytes).
3. **Publish `frontend/firestore.rules`** (procedure below). No Hosting step.
4. **Confirm the live version** is the published one (search for `ADR-56`;
   `diff <(pbpaste) frontend/firestore.rules` empty; 197,035 bytes).
5. **Verify in production** per TESTING.md §32 (published version confirmed;
   a controlled external-role read denied — in a non-production tenant or the
   emulator, never by provisioning an external user in production; financial
   roles unaffected) and record the outcome here.
6. Close the milestone: mark ADR-56 LIVE here, in SECURITY.md and ROADMAP.md
   — done, 27 October 2026.

**Rollback.** Re-publish the previous ruleset (196,622 bytes, the 1D / M1
version). No data, document or bundle is affected either way — rules read
nothing new and write nothing. Rolling back **restores the P0 exposure**, so it
should be a last resort and brief. ⚠️ Once M2-B1 / M2-B2 are live this
rollback target is superseded: see the M2-B2 note (rules roll back to the
M2-A ruleset, never further, while the M2-B bundle is deployed). **What rollback cannot do:** it cannot undo
any read an external user performed while the exposure was live, and it does
not change whether such users exist (NOT VERIFIED — check `users/{uid}.role`
in the console; disable or de-provision any `subcontractor` / `client` account
until the revised ruleset is live).

**Purchase Order Lifecycle Security — M2-B1 (ADR-57): LIVE IN PRODUCTION since
27 October 2026 — released in the combined M2-B3 order below (Hosting first,
then one rules publish — the ADR-40 ordering gate). The notes that follow are
kept as the record of the order used.** The
M2-B1 bundle changes the PO write paths (`hooks/usePurchaseOrders.jsx`,
`lib/purchaseOrderActions.js`, `lib/poCancellation.js`,
`pages/project/ProjectPurchaseOrders.jsx`): every PO write now carries
`updatedAt` / `updatedBy`, a create carries null `sentBy` / `closedBy` /
`cancelledBy`, each transition writes its `*By` actor through a guarded
transaction, and the Cancel button runs the strict linked-record guard. The
revised `frontend/firestore.rules` (**207,567 bytes**; 197,035 before) makes
the `purchaseOrders` block REQUIRE those keys (`updateStamped()` on every
write, the `*By` stamps on each transition, the exact key set at create). The
two halves are therefore **not independently deployable in either order
except the one below**:

- *Live bundle + new rules* (rules first) → **outage**: every PO create, draft
  edit, send, close and cancel in the live app fails with *Missing or
  insufficient permissions* — the live bundle sends none of the required keys.
  This is the ADR-40 gate; do not publish first.
- *New bundle + live rules* (Hosting first) → **safe**: the live (M2-A) PO
  write rule is tenant-and-role only, so it accepts the new payloads; the
  stricter cancel policy and the stale-copy guard already run in the client,
  the rules simply do not yet back them. This is the **compatibility phase**,
  and it is the only one needed.

**M1 (ADR-55) shipped in the same Hosting deploy on 27 October 2026; the
cofounder's M1 acceptance is one-off feedback, not a deployment gate.** `main` carries M1; a Hosting deploy of M2-B1 therefore ships the
M1 bundle at the same time. M2-B1 does not itself require M1 (it writes no M1
field and reads no M1 figure), but **there is no M2-B1-only Hosting artifact
without a cherry-pick**, so the M1 acceptance must land first — or the product
owner must explicitly accept shipping both in one deploy. The M2-A ruleset
already live is a strict subset of the M2-B1 ruleset (read predicates
unchanged, PO write rule tightened, nothing else touched); publishing M2-B1
supersedes it with no intermediate state.

Release, in order, each a separate approved action:

1. **M1 Hosting acceptance** by the cofounder (or an explicit decision to
   ship M1 + M2-B1 together).
2. Lead Architect review; commit and merge to `main`; Azure CI green (lint →
   unit → **rules** → build).
3. `cd frontend && npm run lint && npm run test:unit && npm run test:rules &&
   npm run build` — green; the size test passes (207,567 bytes against the
   245,000-byte budget).
4. **Confirm the live ruleset first** (procedure above) and record its
   timestamp and byte count (expected: the M2-A ruleset, 197,035 bytes).
5. **Deploy Hosting**: `firebase deploy --only hosting --project
   constrapp-69b5d`. Hard-refresh and verify, against the STILL-LIVE M2-A
   rules, that a PO can be created, edited, sent, closed and cancelled, that a
   PO with an approved claim (or supplier variation) shows the cancel reason, and that the sent
   document in the console carries `sentBy` and `updatedAt` / `updatedBy`.
   This is the compatibility phase; it may stay in place as long as needed.
6. **Publish `frontend/firestore.rules`** (procedure above). Confirm the live
   version is the published one (search `ADR-57`; `diff <(pbpaste)
   frontend/firestore.rules` empty; **207,567** bytes).
7. **Verify in production** per TESTING.md §33 (the three checks: this build
   and this ruleset; the cancel guard and a console-side forged edit refused;
   legacy documents and downstream figures unaffected) and record the outcome
   here.
8. Close the milestone: mark ADR-57 LIVE here, in SECURITY.md, DATA_MODEL.md,
   FINANCIAL_WORKFLOWS.md, ROADMAP.md and AGENT.md.

**Rollback.** *Rules only* (after step 6, keeping the new bundle): re-publish
the M2-A ruleset (197,035 bytes) — the new bundle keeps working unchanged
against it (it was proven to in step 5); the only loss is the rules-level
enforcement. *Hosting only* (after step 5, before step 6): redeploy the
previous build — the live rules accept its writes. *Both* (after step 6):
**rules back first, then Hosting** — never the reverse, because the old bundle
against the new rules is the outage above. Existing documents are unaffected
in every direction: the new rules compare the added keys through
`get(key, null)` and require the stamps only of the incoming document, so a
pre-M2-B1 PO stays writable, and a post-M2-B1 PO (which carries the extra
keys) is read and written by the old bundle without complaint (it uses partial
`updateDoc` and never asserts a key set). No migration, backfill or data
rewrite is involved in either direction.

**Progress Claim Lifecycle Security — M2-B2 (ADR-58): LIVE IN PRODUCTION since
27 October 2026 (released in the combined M2-B3 order below; the notes that
follow are kept as the record). HOSTING FIRST, THEN RULES — the ADR-40
ordering gate applied, and
this release SUPERSEDES the M2-B1 release order above: the two pending rules
changes ship in ONE publish and the three pending Hosting changes in ONE
deploy unless cherry-picked.** The M2-B2 bundle changes the claim write paths
(`hooks/useProgressClaims.jsx`, `lib/progressClaimActions.js`,
`lib/progressClaims.js`, `pages/project/ProjectProgressClaims.jsx`): every
claim write now carries `updatedAt` / `updatedBy` and `revision + 1`, a create
carries null `submittedBy` / `rejectedBy`, each transition writes its `*By`
actor through a revision-guarded transaction, and the draft edit runs through
one too. The revised `frontend/firestore.rules` (**224,528 bytes**; 207,567
after M2-B1, 197,035 live) makes the `progressClaims` block REQUIRE those keys
(`updateStamped()` and `revisionIncremented()` on every write, the `*By`
stamps on each transition, the exact key set and a `get()` on the source PO
at create). The compatibility analysis is the M2-B1 one, extended:

- *Live (pre-M2-B2) bundle + new rules* (rules first) → **outage**: every
  claim create, draft edit, submit, approve and reject in the live app fails
  with *Missing or insufficient permissions* — the live bundle sends no
  stamp and never increments `revision`. The same is true of every PO write
  (M2-B1). Do not publish first.
- *New bundle + live M2-A rules* (Hosting first) → **safe**: the live claim
  AND PO write rules are tenant-and-role only, so they accept every new
  payload; the stale guards and the stricter client checks run in the client,
  the rules simply do not yet back them. This is the **compatibility phase**.
- *New bundle + the M2-B1 ruleset alone* — **not a state this release
  creates** (M2-B1 was never published), but it would also be safe: the
  M2-B1 ruleset's claim block is the M2-A one. There is therefore **no
  intermediate compatibility risk between M2-B1 and M2-B2**: the M2-B2
  ruleset is a strict tightening of the M2-B1 ruleset (claim block only), and
  the M2-B1 ruleset a strict tightening of M2-A (PO block only). Publishing
  the M2-B2 ruleset directly over M2-A is the recommended path — one publish,
  one verification, no M2-B1-only interval.
- *New Hosting bundle against the M2-B2 ruleset* — the M2-B1 PO paths and the
  M2-B2 claim paths are both required by it and both present in the bundle
  (`main` carries M1 + M2-B1 + M2-B2). A bundle built WITHOUT M2-B1 (a
  cherry-pick of M2-B2 alone) against the M2-B2 ruleset would break every PO
  write — so if M2-B2 is ever cherry-picked ahead of M2-B1, the PO block must
  be cherry-picked with it, or the rules publish must wait for M2-B1's
  Hosting.

**(As written before the release: M1 merged and awaiting Hosting, M2-B1 merged
and not deployed — all shipped together on 27 October 2026.)** `main` carries both; a Hosting deploy of
M2-B2 ships M1 + M2-B1 + M2-B2 together unless cherry-picked. M2-B2 does not
itself require M1 (no M1 field or figure) and does not require M2-B1 at the
bundle level (separate paths), but its **ruleset** contains M2-B1's PO block,
so the ruleset requires BOTH bundles to be live. The M2-A ruleset live in
production is a strict subset of the M2-B2 ruleset (read predicates
unchanged; PO and claim write rules tightened; nothing else touched).

Release, in order, each a separate approved action:

1. **M1 Hosting acceptance** by the cofounder (or an explicit decision to
   ship M1 + M2-B1 + M2-B2 together). Cofounder acceptance gates stay
   mandatory for every step that touches production.
2. Lead Architect review of M2-B2; commit and merge to `main`; Azure CI green
   (lint → unit → **rules** → build).
3. `cd frontend && npm run lint && npm run test:unit && npm run test:rules &&
   npm run build` — green; the size test passes (224,528 bytes against the
   245,000-byte budget).
4. **Confirm the live ruleset first** (procedure above) and record its
   timestamp and byte count (expected: the M2-A ruleset, 197,035 bytes —
   neither M2-B1 nor M2-B2 has been published).
5. **Deploy Hosting** (M1 + M2-B1 + M2-B2): `firebase deploy --only hosting
   --project constrapp-69b5d`. Hard-refresh and verify, against the
   STILL-LIVE M2-A rules: the M2-B1 PO checks (create, edit, send, close,
   cancel; the cancel reason on a linked PO; `sentBy` / `updatedAt` in the
   console) AND the M2-B2 claim checks — raise a draft claim, edit it, submit,
   assess → approve, withdraw a second draft; the approved document in the
   console carries `submittedBy`, `approvedBy`, `updatedAt` / `updatedBy` and
   `revision: 3`. This is the compatibility phase; it may stay in place as
   long as needed.
6. **Publish `frontend/firestore.rules`** (procedure above) — the ONE publish
   covering M2-B1 and M2-B2. Confirm the live version is the published one
   (search `ADR-57` AND `ADR-58`; `diff <(pbpaste) frontend/firestore.rules`
   empty; **224,528** bytes).
7. **Verify in production** per TESTING.md §33 (M2-B1) and §34 (M2-B2) and
   record the outcome here.
8. Close the milestones: mark ADR-57 and ADR-58 LIVE here, in SECURITY.md,
   DATA_MODEL.md, FINANCIAL_WORKFLOWS.md, ROADMAP.md and AGENT.md.

**Rollback.** *Rules only* (after step 6, keeping the new bundle):
re-publish the M2-A ruleset (197,035 bytes) — the new bundle keeps working
unchanged against it (proven in step 5); the only loss is the rules-level
enforcement of BOTH M2-B1 and M2-B2 (there is no M2-B1-only ruleset to fall
back to unless one is built from the `d29e993` tree and tested). *Hosting
only* (after step 5, before step 6): redeploy the previous build — the live
M2-A rules accept its writes. *Both* (after step 6): **rules back first, then
Hosting** — never the reverse, because the old bundle against the new rules
is the outage above. Existing documents are unaffected in every direction:
the new rules compare the added keys through `get(key, null)`, read a missing
`revision` as 0 and require the stamps only of the incoming document, so a
pre-M2-B2 claim stays writable, and a post-M2-B2 claim (which carries the
extra keys and a higher `revision`) is read by the old bundle without
complaint and written by it with partial `updateDoc` — the old bundle writes
`revision` nowhere, so a rolled-back bundle against the rolled-back rules
leaves the higher revision in place harmlessly. **What rollback cannot do:**
it cannot undo a forged or out-of-lifecycle claim write performed while the
tenant-and-role rules were live, and it cannot make a document approved
through the new rules un-approved. No migration, backfill or data rewrite is
involved in either direction.

**Variation Lifecycle Security — M2-B3 (ADR-59): LIVE IN PRODUCTION since
27 October 2026 — one Hosting deploy (M1 + M2-B1 + M2-B2 + M2-B3, verified
against matching local and production asset hashes), then one rules publish
(inspected and confirmed to carry ADR-59); the repository records the day, not
a time. The order below is kept as the record used. HOSTING FIRST, THEN RULES
— the ADR-40 ordering gate applied, and
this release SUPERSEDES the M2-B2 release order above: the three pending rules
changes (M2-B1, M2-B2, M2-B3) ship in ONE publish and the four pending Hosting
changes (M1, M2-B1, M2-B2, M2-B3) in ONE deploy unless cherry-picked.** The
M2-B3 bundle changes the variation write paths (`hooks/useVariations.jsx`,
`lib/variationActions.js`, `lib/variations.js`,
`pages/project/ProjectVariations.jsx`): every variation write now carries
`updatedAt` / `updatedBy` and `revision + 1`, and the draft edit and each of
the four transitions run through a revision-guarded transaction. The revised
`frontend/firestore.rules` (**237,851 bytes**; 224,528 after M2-B2, 207,567
after M2-B1, 197,035 live) makes the `variations` block REQUIRE those keys
(`updateStamped()` and `revisionIncremented()` on every write, the exact key
set, the type-consistent counterparty and a `get()` on the source PO at
create). The compatibility analysis is the M2-B2 one, extended:

- *Live (pre-M2-B3) bundle + new rules* (rules first) → **outage**: every
  variation create, draft edit, submit, approve, reject and withdraw in the
  live app fails with *Missing or insufficient permissions* — the live bundle
  sends no stamp and never increments `revision`. The same is true of every
  PO write (M2-B1) and every claim write (M2-B2). Do not publish first.
- *New bundle + live M2-A rules* (Hosting first) → **safe**: the live
  variation write rule is tenant-and-role plus the ADR-34 link, which accepts
  every new payload (the link is unchanged in every transition write and
  validated the same way on a draft edit); the live PO and claim rules are
  tenant-and-role only. The stale guards and the stricter client checks run in
  the client, the rules simply do not yet back them. This is the
  **compatibility phase**.
- *New bundle + the M2-B1 or M2-B2 ruleset alone* — **not states this release
  creates** (neither was published), but both would be safe: their variation
  block is the M2-A one. The M2-B3 ruleset is a strict tightening of the
  M2-B2 ruleset (variations block only), which is a strict tightening of
  M2-B1 (claims block only), which is a strict tightening of M2-A (PO block
  only). Publishing the M2-B3 ruleset directly over M2-A is the recommended
  path — one publish, one verification, no intermediate interval.
- *New Hosting bundle against the M2-B3 ruleset* — the M2-B1 PO paths, the
  M2-B2 claim paths and the M2-B3 variation paths are all required by it and
  all present in the bundle (`main` will carry M1 + M2-B1 + M2-B2 + M2-B3). A
  bundle built WITHOUT any of the three against the M2-B3 ruleset would break
  that collection's writes — so if M2-B3 is ever cherry-picked ahead of the
  others, their blocks must be cherry-picked with it, or the rules publish
  must wait for their Hosting.

**(As written before the release: M1 merged and awaiting Hosting, M2-B1 and
M2-B2 merged and not deployed — all shipped together on 27 October 2026.)** `main` carries all
three; a Hosting deploy of M2-B3 ships M1 + M2-B1 + M2-B2 + M2-B3 together
unless cherry-picked. M2-B3 does not itself require M1, M2-B1 or M2-B2 at the
bundle level (separate paths), but its **ruleset** contains their blocks, so
the ruleset requires all four bundles to be live. The M2-A ruleset live in
production is a strict subset of the M2-B3 ruleset (read predicates unchanged;
PO, claim and variation write rules tightened; nothing else touched).

Release, in order, each a separate approved action:

1. **M1 Hosting acceptance** by the cofounder (or an explicit decision to
   ship M1 + M2-B1 + M2-B2 + M2-B3 together). Cofounder acceptance gates stay
   mandatory for every step that touches production.
2. Lead Architect review of M2-B3; commit and merge to `main`; Azure CI green
   (lint → unit → **rules** → build).
3. `cd frontend && npm run lint && npm run test:unit && npm run test:rules &&
   npm run build` — green; the size test passes (237,851 bytes against the
   245,000-byte budget).
4. **Confirm the live ruleset first** (procedure above) and record its
   timestamp and byte count (expected: the M2-A ruleset, 197,035 bytes —
   none of M2-B1, M2-B2 or M2-B3 has been published).
5. **Deploy Hosting** (M1 + M2-B1 + M2-B2 + M2-B3): `firebase deploy --only
   hosting --project constrapp-69b5d`. Hard-refresh and verify, against the
   STILL-LIVE M2-A rules: the M2-B1 PO checks, the M2-B2 claim checks AND the
   M2-B3 variation checks — raise a draft supplier variation against a sent
   PO, edit it, submit, assess → approve a different amount with a note,
   withdraw a second draft, raise and approve a client variation; the
   approved document in the console carries `submittedBy`, `approvedBy`,
   `updatedAt` / `updatedBy` and `revision: 4`. This is the compatibility
   phase; it may stay in place as long as needed.
6. **Publish `frontend/firestore.rules`** (procedure above) — the ONE publish
   covering M2-B1, M2-B2 and M2-B3. Confirm the live version is the published
   one (search `ADR-57`, `ADR-58` AND `ADR-59`; `diff <(pbpaste)
   frontend/firestore.rules` empty; **237,851** bytes).
7. **Verify in production** per TESTING.md §33 (M2-B1), §34 (M2-B2) and §35
   (M2-B3) and record the outcome here.
8. Close the milestones: mark ADR-57, ADR-58 and ADR-59 LIVE here, in
   SECURITY.md, DATA_MODEL.md, FINANCIAL_WORKFLOWS.md, ROADMAP.md and
   AGENT.md.

**Rollback.** *Rules only* (after step 6, keeping the new bundle):
re-publish the M2-A ruleset (197,035 bytes) — the new bundle keeps working
unchanged against it (proven in step 5); the only loss is the rules-level
enforcement of M2-B1, M2-B2 AND M2-B3 together (there is no M2-B1-only or
M2-B2-only ruleset to fall back to unless one is built from the `d29e993` /
`f9b84cf` trees and tested). *Hosting only* (after step 5, before step 6):
redeploy the previous build — the live M2-A rules accept its writes. *Both*
(after step 6): **rules back first, then Hosting** — never the reverse,
because the old bundle against the new rules is the outage above. Existing
documents are unaffected in every direction: the new rules require the
stamps only of the incoming document, read a missing `revision` as 0 and
compare the link keys through `get(key, null)`, so a pre-M2-B3 variation stays
writable, and a post-M2-B3 variation (which carries the extra keys and a
higher `revision`) is read by the old bundle without complaint and written by
it with partial `updateDoc` — the old bundle writes `revision` nowhere, so a
rolled-back bundle against the rolled-back rules leaves the higher revision in
place harmlessly. **What rollback cannot do:** it cannot undo a forged or
out-of-lifecycle variation write performed while the tenant-and-role rules
were live, and it cannot make a document approved through the new rules
un-approved. No migration, backfill or data rewrite is involved in either
direction. **Rules headroom after this release was 7,149 bytes**; ADR-60 (below)
recovers it — 201,523 bytes once published.

**Firestore Rules Capacity Optimisation — ADR-60: IMPLEMENTED — NOT YET
DEPLOYED. RULES-ONLY — no Hosting deploy, no migration, no schema change, and
the ADR-40 ordering gate does not apply because the bundle's writes are
unchanged.** The refactored `frontend/firestore.rules` (**201,523 bytes**;
237,851 live) allows and denies exactly what the M2-B3 ruleset does: the 32
match paths and every allow rule are unchanged, the shared helpers are the
byte-for-byte bodies of the local copies they replace, and the full emulator
suite passed unchanged (ADR-60 records the equivalence argument). Either
ruleset accepts the live bundle's writes, so the publish can happen at any
time and in isolation.

Release, in order, each a separate approved action:

1. Lead Architect review; commit and merge to `main`; Azure CI green (lint →
   unit → **rules** → build).
2. `cd frontend && npm run lint && npm run test:unit && npm run test:rules &&
   npm run build` — green; the size test passes (201,523 bytes against the
   245,000-byte budget).
3. **Confirm the live ruleset first** (procedure below) and record its
   timestamp and byte count (expected: the M2-B3 ruleset, 237,851 bytes,
   containing `ADR-59`).
4. **Publish `frontend/firestore.rules`** (procedure below). Read the console
   result: a *Rules are too large* or compile banner means nothing was
   published. Confirm the live version is the published one (search
   `Shared helpers (ADR-60)`; `diff <(pbpaste) frontend/firestore.rules`
   empty; **201,523** bytes).
5. **Verify in production, read-only,** per TESTING.md §36 (the published
   version; a financial-role read sweep across the registers, Documents,
   Quant and PULSE; an external-role read still denied — in a non-production
   tenant or the emulator) and record the outcome here.
6. Close the milestone: mark ADR-60 LIVE here, in SECURITY.md, ROADMAP.md and
   TESTING.md.

**Rollback.** Re-publish the M2-B3 ruleset (`frontend/firestore.rules` at
`06da35b`, 237,851 bytes). The two rulesets are semantically identical, so
rollback is safe at any moment, in either direction, with no Hosting change,
no data impact and no loss of any M2 control. ⚠️ Never roll back further
than M2-B3: an older ruleset would remove the M2-B1 / M2-B2 / M2-B3
enforcement the live bundle relies on.

**Awarded Tender → Linked Draft PO — M3-A (ADR-61): LIVE IN PRODUCTION since
29 October 2026 (rules published first, then Hosting; confirmed by the product
owner that day — the publish timestamps are not recorded here). The ADR-60
ruleset went live with it. The record below is kept as the order used. RULES
AND HOSTING; RULES FIRST (the Quant™ 1B order, the reverse of the ADR-40
gate).** The M3-A ruleset (`frontend/firestore.rules`,
**207,620 bytes**; it CONTAINS the ADR-60 refactor) admits three OPTIONAL
keys on a PO create and two new `tenderPackages` branches. The live bundle
never writes any of them, so the new ruleset accepts every write the live
bundle issues; the new bundle's *Raise purchase order…* writes the new keys,
which the live `hasOnly` would REFUSE — so the rules must be live before the
bundle. ⚠️ **ADR-60 is not independently confirmed live.** Publishing the
M3-A file also publishes ADR-60; the Lead Architect's order is to confirm
ADR-60's publication on its own first (step 1), so the ADR-60 equivalence
record stays clean.

Release, in order, each a separate approved action:

1. **Confirm ADR-60 is published** (the procedure above; expected live:
   201,523 bytes, `Shared helpers (ADR-60)` present). If it is not, publish
   and verify it per TESTING.md §36 before anything below.
2. Lead Architect review of M3-A; merge to `main`; Azure CI green (lint →
   unit → **rules** → build).
3. `cd frontend && npm run lint && npm run test:unit && npm run test:rules &&
   npm run build` — green; the size test passes (207,620 bytes against the
   245,000-byte budget).
4. **Publish `frontend/firestore.rules`** (procedure above). Confirm the live
   version is the published one (search `ADR-61`; `diff <(pbpaste)
   frontend/firestore.rules` empty; **207,620** bytes). The live bundle keeps
   working: manual PO create, edit, send, close and cancel, and every tender
   write, are unchanged against the new rules (proven by the unchanged
   suites plus `awardToPo.rules.test.js` → *roles, tenancy, legacy and manual
   compatibility*).
5. `firebase deploy --only hosting --project constrapp-69b5d`; confirm the
   deployed asset hashes match the local build.
6. **Verify in production** per TESTING.md §37 (raise once, highlight,
   refuse twice; nothing moves until Send; manual path and re-raise) and
   record the outcome here.
7. Close the milestone: mark M3-A LIVE here, in SECURITY.md, ROADMAP.md,
   TESTING.md, DATA_MODEL.md, FINANCIAL_WORKFLOWS.md, PRODUCT.md and AGENT.md.

**Rollback.** *Hosting alone:* redeploy the previous bundle — linked POs
stay readable and editable (the old bundle ignores the three source keys and
the package's back-link; it merely stops showing them and offers no raise);
nothing is orphaned, because the source keys live on the PO and the link on
the package, both frozen. *Rules alone (to the ADR-60 file, 201,523 bytes):*
safe at any time — the ADR-60 `corePreserved` reads no source key, unchanged
keys never appear in `changedKeys()`, and an awarded package takes no write
under the old branches, so every existing linked PO still edits, sends,
closes and cancels; only the raise action is refused until the rules return.
*Both:* the same, in either order. ⚠️ Never roll rules back further than
M2-B3. No migration, backfill or data rewrite is involved in either
direction, and no rollback removes an M2 control.

**New-Scope Variation Claim & Invoice Integration — M3-B2 (ADR-63): LIVE IN
PRODUCTION (confirmed by the Product Owner). Released in THREE STAGES,
FIREBASE-CLI DRIVEN: TRANSITIONAL RULES → HOSTING → FINAL RULES.**

*What the two rulesets are.* The FINAL ruleset (`frontend/firestore.rules`,
**217,864 bytes**) requires, on every approve of a PO-linked supplier
variation, BOTH stamp pairs (the ADR-62 applied pair and the ADR-63 scope
pair), and requires the `variationLineCount` header on every claim create. The
M3-B1 bundle now in production writes only the applied pair and no count, so
the FINAL file cannot be deployed while it is served. The STAGE-1 ruleset
(`frontend/firestore.transitional.rules`, **218,373 bytes**, derived by
`node scripts/build-transitional-rules.mjs` — `npm run rules:transitional`,
checked by `npm run rules:transitional:check` and
`tests/unit/rulesTransitional.test.js`) differs from FINAL in exactly TWO
marked rule lines (search `ADR-63 TRANSITIONAL`): the scope pair is OPTIONAL on
the approve branch (the applied pair stays required; a present scope pair must
still be the caller's at server time; the PO must still be sent/closed), and
`variationLineCount` is OPTIONAL at claim create (absent reads 0). Everything
else — the claim count pin (`PO lines + count == lines`), the first/last
variation-line shape pins, the per-pair branch (f), the claim-sourced invoice
count guard — is identical in both files and ACTIVE from Stage 1. Proven by
`tests/rules/variationsTransitional.rules.test.js` (M3-B1 payload × Stage 1
accepted; new payload × Stage 1 accepted; pre-M3-B1 payload refused; invalid PO
refused for every payload; claim and invoice guards active) and by the ADR-63
blocks of `tests/rules/variations.rules.test.js`,
`tests/rules/progressClaims.rules.test.js` and
`tests/rules/supplierInvoices.rules.test.js` against the FINAL file.

*Deployment config.* `frontend/firebase.json` is unchanged (it names
`firestore.rules` for the emulators and the FINAL stage). Stage 1 uses the
committed alternate config `frontend/firebase.transitional.json`, which names
`firestore.transitional.rules` as the Firestore rules source and nothing else —
the normal config is never rewritten for a temporary deployment. There is no
`.firebaserc`, so `--project` is mandatory on every command. Every command below
is run from `frontend/`, each a separate approved action; **none of them is run
by an implementation task.**

1. **Confirm the live ruleset is ADR-62 FINAL** (procedure under *Verifying
   which rules version is published*): search `ADR-62 FINAL`, **210,926**
   bytes.
2. Lead Architect review of M3-B2; merge to `main`; Azure CI green (lint →
   unit → **rules** → build). `cd frontend && npm run lint && npm run test:unit
   && npm run test:rules && npm run build && npm run rules:transitional:check`
   — green locally too.
3. **STAGE 1 — deploy the transitional ruleset:**
   `firebase deploy --only firestore:rules --config firebase.transitional.json --project constrapp-69b5d`.
   Confirm the live version carries `ADR-63 TRANSITIONAL` and **218,373**
   bytes. The M3-B1 bundle keeps working in full. From this moment: an invoice
   raised from a claim that carries variation lines must declare its count (no
   such claim exists yet, so nothing changes for users), and a claim's variation
   lines (none exist yet) are shape-pinned.
4. **STAGE 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   (`--only hosting` and `--project` are both required); confirm the deployed
   asset hashes match the local build. The new bundle approves PO-linked
   supplier variations with both pairs, offers *Commit new scope* on variations
   applied under M3-B1 that carry positive new scope, appends claimable
   new-scope lines to new claims, carries the identity into claim-sourced
   invoices, and reads the combined Remaining Committed (Budget, Forecast,
   Commercial, Overview, Dashboard, Cash Flow, PULSE, SHIELD).
5. **Verify Stage 2 in production** per TESTING.md §39 checks 1–3 (approve
   commits new scope and Committed / FFC rise by exactly the sum; claim →
   approve → invoice → post moves the amount once; legacy *Commit new scope*
   once, refused on repeat, negative new scope offers no commit).
6. **STAGE 3 — deploy the FINAL ruleset:**
   `firebase deploy --only firestore:rules --project constrapp-69b5d`.
   Confirm the live version carries `ADR-63 FINAL` and **217,864** bytes. From
   this moment an un-reloaded M3-B1 tab (no service worker exists, so only an
   un-reloaded tab) is refused — with nothing written — on exactly TWO actions:
   the approve of a PO-linked supplier variation (no scope pair) and the create
   of a progress claim (no `variationLineCount`); it sees the ADR-59 / ADR-58
   permission message and a reload loads the new bundle. Every other action
   still passes. Do not deploy Stage 3 until Stage 2 is verified (step 5); a
   reasonable delay (the next working day) lets open tabs reload naturally.
7. Close the milestone: mark M3-B2 LIVE here, in SECURITY.md, ROADMAP.md,
   TESTING.md, DATA_MODEL.md, FINANCIAL_WORKFLOWS.md, PRODUCT.md and AGENT.md;
   record the Stage-1 and Stage-3 byte counts seen in the console. Tell the QS
   team: review Uncommitted Cost to Complete on every cost code where a
   new-scope variation was folded in, and review any PO line whose recognition
   already exceeds its revised value before committing that variation's new
   scope (the dialog warns and requires an acknowledgement; nothing is
   reassigned automatically).

**Rollback — three different questions** (security compatibility, database
integrity, financial reporting correctness):

- **Before the first scope commit and the first variation-origin claim line**
  (check with console queries: `variations` for `scopeCommittedAt`,
  `progressClaims` for `variationLineCount > 0`): every step reverses in all
  three senses. Stage 3 → Stage 1: redeploy the transitional file at any time
  (a superset). Stage 2 → the M3-B1 bundle: redeploy the previous build (the
  transitional rules accept everything it writes). Stage 1 → ADR-62 FINAL:
  redeploy the previous `firestore.rules` only while the M3-B1 bundle is served.
- **After the first scope commit or variation-origin claim line:**
  - *Security and integrity:* rules back to the STAGE-1 file are safe at any
    time; never below the ADR-62 FINAL file once both-pair documents exist.
    A Hosting rollback to the M3-B1 bundle is security- and integrity-SAFE —
    the invoice count guard refuses that bundle's invoice-from-claim on any
    claim carrying variation lines, and the shape pins refuse its draft edit of
    such a claim (nothing is corrupted or written) — PROVIDED the Stage-1 or
    FINAL ruleset is live.
  - *Financial correctness:* a Hosting rollback to the M3-B1 bundle is NOT
    safe. That bundle does not read the scope pair or the variation-origin
    lines: committed new scope drops back to "exposure", variation-origin claim
    lines raise Actual without netting any commitment line (FFC overstated),
    and the recognition those claims represent is invisible to Committed.
    **Do not roll Hosting back to the M3-B1 frontend once such records exist.**
    The recovery path is FORWARD: fix on the M3-B2 code line and redeploy, or
    deploy a RECOVERY BUNDLE built from this branch with the *Commit new scope*
    action and the claim editor's variation lines disabled but every selector
    intact, so the figures keep reading the stamps and the lines.

No migration, backfill or data rewrite is involved in any direction; a stamp or
a line already written is an audit fact, never deleted. No rollback removes an
M2 or M3-B1 control.

**Supplier Variation Commitment Integration — M3-B1 (ADR-62): LIVE IN
PRODUCTION — released in the three stages below (transitional rules → Hosting →
FINAL rules) and confirmed by the product owner; the record of the order is
kept. Both rulesets were committed, derived and emulator-tested; Rules-first
was claimed safe only on the strength of those tests.**

*The compatibility question, answered from the rules text and the suites.*
The FINAL ruleset (`frontend/firestore.rules`, **210,926 bytes**) requires, on
every approve of a PO-linked supplier variation, the commitment pair
(`commitmentAppliedAt == request.time`, `commitmentAppliedBy == caller`) AND a
PO that exists in this project and is sent/closed. The pre-M3-B1 production
bundle approves such a variation WITHOUT the pair, so publishing the FINAL
ruleset while that bundle is served would refuse every such approval — an
outage. Publishing the new bundle while the M3-A ruleset is live would refuse
every stamped approve (the live `hasOnly` on branch (c) at `a0c44e9` has no
`commitmentApplied*` key) and *Apply to commitment* would match no branch —
also an outage. Neither can go first against the other, so a STAGE-1
TRANSITIONAL ruleset bridges the window:

- `frontend/firestore.transitional.rules` (**211,378 bytes**) is DERIVED from
  the FINAL file by `node scripts/build-transitional-rules.mjs` (also
  `npm run rules:transitional`; `npm run rules:transitional:check` exits 1 if
  the committed copy is stale, and `tests/unit/rulesTransitional.test.js` fails
  the unit suite on the same condition). It differs from the FINAL file in
  exactly ONE rule line — the pair is OPTIONAL on branch (c) — plus a five-line
  header; grep the live ruleset for `ADR-62 TRANSITIONAL` / `ADR-62 FINAL` to
  see which stage is published. Everything else is identical: the PO must be
  sent/closed for ANY PO-linked approve (Correction A holds from Stage 1), a
  present pair must be the caller's at server time, the legacy Apply (branch f)
  is one-time, every M2 / M3 control is unchanged.
- Proof, old client × Stage 1: `tests/rules/variationsTransitional.rules.test.js`
  — the plain PO-linked approve is ACCEPTED (and the document is then
  legacy-applicable), create / submit / withdraw unchanged.
- Proof, new client × Stage 1: the same file — the stamped approve is ACCEPTED;
  the legacy Apply passes once and is refused on repeat.
- Proof, both clients × Stage 1: a cancelled / draft / pending / missing /
  other-project PO refuses BOTH payloads; forged stamps, stamps at create,
  manual / client semantics, roles and tenancy unchanged.
- Proof, new client × FINAL: `tests/rules/variations.rules.test.js` — stamped
  approve accepted for every role; the unstamped PO-linked approve (an
  old-bundle tab) DENIED for every role with nothing written; manual-mode and
  client approvals unchanged; the legacy Apply once.
- `firebase.json` is unchanged (`firestore.rules` for the emulators; Hosting
  `public: dist` with the SPA rewrite); publishing is manual through the
  console as for every ruleset (procedure above), pasting the text of whichever
  file the stage names. No Firebase CLI argument is involved in a rules publish.

Release, in order, each a separate approved action:

1. **Confirm the live ruleset is M3-A** (procedure above): search `ADR-61`,
   `diff <(pbpaste) frontend/firestore.rules` against `a0c44e9` empty,
   **207,620** bytes.
2. Lead Architect review of M3-B1; merge to `main`; Azure CI green (lint →
   unit → **rules** → build). `cd frontend && npm run lint && npm run test:unit
   && npm run test:rules && npm run build && npm run rules:transitional:check`
   — green locally too.
3. **STAGE 1 — publish `frontend/firestore.transitional.rules`** (procedure
   above). Confirm the live version: search `ADR-62 TRANSITIONAL`;
   `diff <(pbpaste) frontend/firestore.transitional.rules` empty; **211,378**
   bytes. The live (pre-M3-B1) bundle keeps working in full; from this moment a
   PO-linked supplier variation whose PO is cancelled can no longer be approved
   by anyone (withdraw or reject it instead).
4. **STAGE 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   (the existing command; `--only hosting` and `--project` are both required);
   confirm the deployed asset hashes match the local build. The new bundle
   approves PO-linked supplier variations WITH the pair (approve + apply in one
   write), offers *Apply to commitment* on legacy approved variations, and
   reads the new selectors (revised Committed, Applied / Unapplied figures,
   SHIELD conditions F and G).
5. **Verify Stage 2 in production** per TESTING.md §38 checks 1–3 (approve
   applies and the revised Committed / FFC figures move by exactly the
   variation; recognition and a negative variation; legacy Apply once).
6. **STAGE 3 — publish `frontend/firestore.rules` (FINAL)**. Confirm the live
   version: search `ADR-62 FINAL`; `diff <(pbpaste) frontend/firestore.rules`
   empty; **210,926** bytes. From this moment an unstamped PO-linked approve is
   denied. **Old-bundle tabs:** a browser tab that still runs the pre-M3-B1
   bundle (no service worker exists, so only an un-reloaded tab) is refused —
   with nothing written — on exactly one action, the approve of a PO-linked
   supplier variation; it sees the ADR-59 permission message ("You do not have
   permission to change variations on this project") and a reload loads the
   new bundle. Its create, draft edit, submit, reject, withdraw and every
   manual-mode / client action still pass. Do not publish Stage 3 until Stage
   2 is verified (step 5); a reasonable delay (the next working day) lets open
   tabs reload naturally.
7. Close the milestone: mark M3-B1 LIVE here, in SECURITY.md, ROADMAP.md,
   TESTING.md, DATA_MODEL.md, FINANCIAL_WORKFLOWS.md, PRODUCT.md and AGENT.md
   (done under ADR-63 on the product owner's confirmation; the console byte
   counts were not recorded in the repository). Tell the QS
   team to review Uncommitted Cost to Complete on every cost code where an
   approved supplier variation was folded in (the dialogs warn and require
   acknowledgement, but the review is theirs — nothing is subtracted
   automatically).

**Rollback — three different questions.** *Security compatibility* (does every
bundle × ruleset pair refuse what it must and accept what the served bundle
writes), *database integrity* (is any document orphaned, rewritten or made
unreadable), and *financial reporting correctness* (do the figures on screen
mean what the records now say) have different answers.

- **Before the first application** (no variation carries the pair — check with
  a console query on `variations` for `commitmentAppliedAt`): every step is
  reversible in all three senses. Stage 3 → Stage 1: republish the transitional
  file at any time (a superset). Stage 2 → previous bundle: redeploy `a0c44e9`
  (the transitional rules accept everything it writes). Stage 1 → M3-A rules:
  republish the M3-A file only while the pre-M3-B1 bundle is served.
- **After the first application** — stamped variations exist and the QS may
  have released Uncommitted CTC on the strength of the revised Committed:
  - *Security and integrity:* a Hosting rollback to `a0c44e9` is still safe
    (the old bundle writes nothing new and reads the stamped documents without
    error; nothing is orphaned or rewritten) PROVIDED the transitional ruleset
    is live (Stage 3 → Stage 1 first, otherwise the old bundle's approvals
    fail). Rules alone back to the transitional file is safe at any time.
    ⚠️ Never roll rules back to M3-A once stamped documents exist with the new
    bundle served, and never below M2-B3.
  - *Financial correctness:* a Hosting rollback to `a0c44e9` is NOT safe. The
    old bundle does not read the pair, so every applied variation drops back
    out of Remaining Committed into "exposure", and Committed, Forecast Final
    Cost, Variance, Margin, Cash Flow's cost basis and PULSE revert to the
    pre-M3-B1 reading while the records — and any CTC the QS released — say
    otherwise: the project understates its forecast by the applied amounts.
    **There is no financially safe rollback to the pre-M3-B1 bundle once
    applied data exists.** The recovery path is FORWARD: fix on the M3-B1
    code line and redeploy, or, if a feature must be withdrawn, deploy a
    RECOVERY BUNDLE built from this branch with the Approve-and-apply and
    *Apply to commitment* actions disabled but every selector intact, so the
    figures keep reading the stamps. If the pre-M3-B1 bundle must be served
    regardless, record the limitation and instruct the QS to treat every
    *Approved Supplier Variations* figure as commitment already recognised
    elsewhere until the forward fix lands.

No migration, backfill or data rewrite is involved in any direction; a stamp
already written is an audit fact, never deleted. No rollback removes an M2
control.

**Quant™ 1B (ADR-52): LIVE IN PRODUCTION (October 2026).** Released in the
order below — rules published and confirmed live first, then Hosting — and
verified per TESTING.md §28; the repository records the month. The original
ordering note is kept because it still governs any future change that adds a
key the live `hasOnly` would reject: **RULES FIRST, HOSTING SECOND — the
reverse of the ADR-40 gate.** The 1B bundle writes a new key,
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
   refusal; roles) — done (October 2026): link, review and apply verified
   against production; the repository records the month, not the day.

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
  document — see [SECURITY.md](SECURITY.md). **Since ADR-72 (L1) went live
  (11 November 2026)**, companies are bootstrapped by the operator script and every further member
  joins by invitation (see *L1 — Trusted Backend & Team Management* below).
- **Emulator suites need Java 21+** (firebase-tools 15). Node.js 24.19.0 for
  the frontend (`engines`); the Functions run on **Node.js 22** in production
  (`firebase.json` → `runtime: nodejs22`).

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
| `VITE_FIREBASE_APPCHECK_SITE_KEY` | **ADR-72.** reCAPTCHA Enterprise site key registered for App Check (public). Without it the team-management callables refuse every request |
| `VITE_FIREBASE_APPCHECK_DEBUG_TOKEN` | **ADR-72, dev builds only.** An App Check debug token registered in the console, for `npm run dev` against the real project. Never set for a production build |

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
management and cache-control headers. The custom domain is documented in
*Custom domain — app.constrap.com* below; it is connected (confirmed live on
11 November 2026).

### Constrapp GANTT™ — Programme 1A1 (ADR-64) — Hosting-only release

**Status: LIVE in production (confirmed by the Product Owner; DEPLOYED — VERIFIED 20 November 2026).**
**Production evidence (read-only, 20 November 2026):** the live Firestore ruleset `10c7596c…` (released 19 November 2026 04:23 UTC) is byte-identical to `frontend/firestore.rules` on `main` (232,460 bytes) and the live Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves the bundle a clean build of `main` `93db6cc` produces — PROJECT_DECISIONS.md → *ADR-79 → Production evidence*.
The release is the plain Hosting
procedure above and nothing else: **no Firestore Rules publish, no Storage
Rules publish, no index, no migration** — `firestore.rules` is byte-identical
(217,864 bytes) and the `activities` documents are untouched. Order: Azure CI
green on the merge (lint → unit → rules → build), then `npm run build` with the
production `VITE_FIREBASE_*` values, then `firebase deploy --only hosting
--project constrapp-69b5d`. Verify after deploy: the project tab bar reads
**GANTT** (static mark, no animation); `/projects/{id}/timeline` opens the
branded programme with the beating dot and *Pause*; a Dashboard *Open GANTT →*
link and a PULSE *Open GANTT* link both land on it; Day / Week / Month keep a
one-day activity on the same date; a bar opens the editor (admin / PM) or the
read-only detail (QS).

**Rollback:** redeploy the previous release — check out the pre-1A1 commit,
`npm run build`, `firebase deploy --only hosting --project constrapp-69b5d` —
or use the Firebase Console's Hosting release history (*Rollback* on the
previous release). ⚠️ There is **no `firebase hosting:rollback` CLI command**
(firebase-tools 13.35.1 — corrected by ADR-65; `hosting:clone` copies between
channels or sites, not from history). Because no document, field or rule
changed in 1A1, the previous bundle's Timeline tab works unchanged on the same
data, and old and new bundles can coexist across open tabs with no data effect.
There is no financial-correctness constraint on rolling this release back —
**but see the GANTT 1A2 order below: once the 1A2 FINAL ruleset is published,
a pre-1A2 bundle can no longer edit activities.**

**Not sequenced behind anything by data, but by release hygiene:** confirm
the M3-B2 (ADR-63) three-stage release has reached its FINAL stage before
building a GANTT 1A1 bundle from `main`, so that one Hosting deploy never
carries an unreleased rules-dependent change by accident.

### GANTT 1A2 release order — dependencies and the revision contract (ADR-65) — THREE STAGES, Firebase-CLI driven

**Status: LIVE in production — all three stages released (confirmed by the Product Owner; DEPLOYED — VERIFIED 20 November 2026).**
**Production evidence (read-only, 20 November 2026):** the live Firestore ruleset `10c7596c…` (released 19 November 2026 04:23 UTC) is byte-identical to `frontend/firestore.rules` on `main` (232,460 bytes) and the live Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves the bundle a clean build of `main` `93db6cc` produces — PROJECT_DECISIONS.md → *ADR-79 → Production evidence*. The published ruleset is the FINAL one (`revisionIncremented()`); `predecessorsValid` is in every ruleset created since 31 October 2026 10:40 UTC.
The 1A2
bundle writes two things the live ruleset refuses — the optional
`predecessors` key (the live `hasOnly` rejects it) and `revision` + 1 on every
activity update (the live `corePreserved` pins it) — while the FINAL 1A2
ruleset refuses what the live (1A1) bundle writes (an unchanged revision). So
neither "rules first" nor "Hosting first" works alone: the release is the
M3-B1 / M3-B2 three-stage pattern, with the Stage-1 ruleset derived from the
FINAL one by `scripts/build-transitional-rules.mjs` (three marked lines: the
two ADR-63 pairs, preserved, and the ADR-65 activities revision line).

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; the GANTT 1A1 bundle (and M3-B2's
FINAL stage) confirmed live, so that the bundle built from `main` carries
nothing unreleased by accident. Every command below runs from `frontend/`,
each a separate approved action; **none is run by an implementation task.**

1. **STAGE 1 — publish the TRANSITIONAL ruleset** (accepts the 1A1 bundle's
   unchanged-revision edit AND the 1A2 bundle's +1; the optional
   `predecessors` key and its first/last pins are ACTIVE from here):
   ```bash
   npm run test:rules                       # both suites green, incl. activitiesTransitional
   firebase deploy --only firestore:rules --config firebase.transitional.json --project constrapp-69b5d
   ```
   `firebase.transitional.json` names `firestore.transitional.rules`; the
   normal `firebase.json` is never rewritten. Verify in the Console that the
   published source starts with the `ADR-63 / ADR-65 STAGE-1 TRANSITIONAL
   RULESET` header (220,564 bytes). The live 1A1 bundle keeps working.
2. **STAGE 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   (`--only hosting` and `--project` both required) after `npm run build` with
   the production `VITE_FIREBASE_*` values. Verify: a bar's editor shows the
   *Predecessors* fieldset; adding one and saving advances the document's
   `revision` to 2; the chart draws the arrow.
3. **STAGE 3 — publish the FINAL ruleset** (`revision` + 1 REQUIRED on every
   activity edit and cancel), once no 1A1 tab is expected to be open — keep
   Stage 1 short, because during it an un-reloaded 1A1 browser can still write
   without incrementing (Deferred Control 41):
   ```bash
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify the published source carries `ADR-65 FINAL` (219,930 bytes). An
   un-reloaded 1A1 tab's edit or cancel is now refused with a permission error;
   **the refresh path is a page reload** — nothing else is needed.

**Recovery — compatible rules and existing data, always.**
- *Rules:* at any moment the Stage-1 ruleset may be republished over the FINAL
  one (it is a strict superset); **never republish the 1A1 ruleset once any
  activity carries `predecessors`** — its `hasOnly` would make every such
  document un-editable, and its `corePreserved` would refuse the 1A2 bundle's
  every save.
- *Hosting:* a pre-1A2 bundle may be redeployed (check out the 1A1 commit,
  build, `firebase deploy --only hosting …`, or the Console's release history)
  **only while the Stage-1 ruleset is published**, because that bundle writes
  an unchanged revision; under the FINAL ruleset it cannot edit activities.
  A document already at revision ≥ 2 and carrying `predecessors` is read by
  the 1A1 bundle without harm (the key is ignored and preserved by its
  `updateDoc`).
- *Data:* nothing is migrated and nothing needs undoing — a dependency is a
  list on the successor; removing it is an ordinary edit.
- **Prefer a forward fix** for any incompatible state over a rollback.
- ⚠️ `firebase hosting:rollback` does not exist in firebase-tools 13.35.1;
  do not plan on it.

### GANTT 1B release order — programme baselines (ADR-66) — RULES FIRST, then Hosting, Firebase-CLI driven

**Status: LIVE IN PRODUCTION (confirmed by the Product Owner; DEPLOYED — VERIFIED 20 November 2026) (Rules AND Hosting; TWO steps, no
transitional stage).**
**Production evidence (read-only, 20 November 2026):** the live Firestore ruleset `10c7596c…` (released 19 November 2026 04:23 UTC) is byte-identical to `frontend/firestore.rules` on `main` (232,460 bytes) and the live Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves the bundle a clean build of `main` `93db6cc` produces — PROJECT_DECISIONS.md → *ADR-79 → Production evidence*. The `programmeBaselines` blocks are in every ruleset created since 31 October 2026 15:22 UTC.
The 1B bundle writes two NEW collections
(`programmeBaselines`, `programmeBaselineSnapshots`) that the live ruleset
denies by default, and changes nothing the live bundle writes: the
`activities` block is byte-for-byte unchanged, no existing key moves, no
document is migrated and no index is added. So the order is the Quant™ 1B
one — **rules first** (the new blocks are additive; the live bundle never
reads or writes them), **Hosting second**. The transitional generator still
carries its three ADR-63 / ADR-65 marked lines and regenerates
`firestore.transitional.rules` (229,601 bytes) from the new FINAL file, but
no transitional publish is needed for 1B.

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **228,967** (budget 245,000). Every command runs from `frontend/`, each
a separate approved action; **none is run by an implementation task.**

1. **STEP 1 — publish the FINAL ruleset** (the two new blocks; everything
   else unchanged):
   ```bash
   npm run test:rules                       # both suites green, incl. programmeBaselines
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify in the Console that the published source contains
   `programmeBaselineSnapshots` and reads 228,967 bytes. The live 1A2 bundle
   keeps working unchanged (proven: `tests/rules/programmeBaselines.rules.test.js`
   → *legacy programme operations are unaffected*).
2. **STEP 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   after `npm run build` with the production `VITE_FIREBASE_*` values.
   Verify: the GANTT tab shows the *Programme baseline* panel reading *No
   approved baseline*; *Capture baseline* (admin / PM) previews the programme
   and creates a draft; *Review draft* lists no changes, Approve makes it the
   active baseline; moving one planned finish shows the dashed outline and
   `+n d` in the List; a QS sees the panel and the comparison with no
   Capture button.

**Index impact — verified, none required.** The snapshot's `activities`
array is indexed automatically (one array-contains entry per element; up to
2,000 per document, far inside Firestore's 40,000 entries-per-document and
8 MiB entries-size limits), and no query ever targets the payload — the
page reads the ONE selected snapshot by id and lists headers by `createdAt`
(single-field, automatic). A `fieldOverrides` exemption on `activities` would
only trim write cost; it would need a `firestore.indexes.json` and a
`firebase.json` `indexes` entry, which this release deliberately does not add.
Revisit if a real programme shows baseline writes to be slow.

**Recovery — forward fixes, never a ruleset that hides approved history.**
- *Hosting:* a pre-1B bundle may be redeployed at any time (check out the
  1A2 commit, build, `firebase deploy --only hosting …`, or the Console's
  release history): it never reads the baseline collections, so existing
  baselines are simply invisible until 1B returns, and nothing is corrupted.
- *Rules:* once ANY approved baseline exists, **do not republish the 1A2
  ruleset** — it would deny every read of the baseline collections and the
  tab would report them as unavailable (nothing is lost; the documents
  remain). The 1B ruleset may be republished over itself at any time.
- *Data:* nothing is migrated and nothing needs undoing. A draft can be
  withdrawn; an approved baseline is immutable by design and is superseded by
  approving a new one.
- ⚠️ `firebase hosting:rollback` does not exist in firebase-tools 13.35.1;
  do not plan on it.

### PULSE 1C release order — schedule intelligence (ADR-67) — RULES FIRST, then Hosting, after GANTT 1B is live

**Status: LIVE IN PRODUCTION (confirmed by the Product Owner; DEPLOYED — VERIFIED 20 November 2026) (Rules AND Hosting; TWO steps, no
transitional stage; ONE prerequisite).**
**Production evidence (read-only, 20 November 2026):** the live Firestore ruleset `10c7596c…` (released 19 November 2026 04:23 UTC) is byte-identical to `frontend/firestore.rules` on `main` (232,460 bytes) and the live Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves the bundle a clean build of `main` `93db6cc` produces — PROJECT_DECISIONS.md → *ADR-79 → Production evidence*.
The 1C bundle writes acknowledgement
documents for three NEW indicator ids (`blockedActivities`,
`dependencyReview`, `baselineSlippage`) that the live `pulseAcknowledgements`
allowlist refuses, and reads the two GANTT 1B collections
(`programmeBaselines`, `programmeBaselineSnapshots`). Nothing the live
bundle writes changes: the six existing ids, the acknowledgement schema, the
stamps and the revision guard are byte-identical, no document is migrated
and no index is added. So the order is the GANTT 1B one — **rules first**
(the allowlist is a superset; the live bundle keeps writing its six ids),
**Hosting second**. The transitional generator still carries its three
ADR-63 / ADR-65 marked lines and regenerates `firestore.transitional.rules`
(229,760 bytes) from the new FINAL file; no transitional publish is needed.

**⚠️ Prerequisite — GANTT 1B rules live.** The baseline indicator reads the
two 1B collections, which the pre-1B ruleset denies. If the 1B ruleset
(`programmeBaselineSnapshots` present, 228,967 bytes) has NOT been published,
the 1C bundle's *Programme later than approved baseline* card reads
**Unavailable** on every project (honest, never healthy) until it is. The
repository does not record a 1B production deployment; **confirm it in the
Console before STEP 1 and do not infer it from the merge of 1B into `main`.**

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **229,126** (budget 245,000). Every command runs from `frontend/`, each
a separate approved action; **none is run by an implementation task.**

1. **STEP 1 — publish the FINAL ruleset** (three ids in one allowlist;
   everything else unchanged):
   ```bash
   npm run test:rules                       # both suites green, incl. pulseAcknowledgements (nine ids)
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify in the Console that the published source contains
   `'blockedActivities', 'dependencyReview', 'baselineSlippage'` and reads
   229,126 bytes. The live PULSE 1B bundle keeps working unchanged (it writes
   only the six ids, all still allowed).
2. **STEP 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   after `npm run build` with the production `VITE_FIREBASE_*` values.
   Verify: a project's PULSE tab reads *Nine conditions*; the three schedule
   cards appear after *Programme activities overdue*; a project with no
   approved baseline shows *Needs data — No approved baseline to compare
   against*; acknowledging a schedule finding as PM succeeds; a QS sees it
   read-only.

**Old-client compatibility.** A pre-1C bundle under the 1C rules writes the
six ids only — accepted. A 1C bundle under the pre-1C rules has its three new
acknowledgements refused as permission-denied: the card reports *You do not
have permission…* and nothing is written; the indicators themselves evaluate
regardless. Existing acknowledgement documents need no migration.

**Recovery — forward fixes.**
- *Hosting:* a pre-1C bundle (the GANTT 1B commit) may be redeployed at any
  time; existing acknowledgements for the three new ids are simply not read
  until 1C returns, and nothing is corrupted.
- *Rules:* the 1C ruleset may be republished over itself at any time. The
  pre-1C ruleset may be republished only while no acknowledgement for a new
  id exists (a re-acknowledgement or withdrawal of one would then be refused;
  nothing is lost). **Never republish the pre-1B ruleset while approved
  baseline records exist** (DEPLOYMENT → GANTT 1B release order).
- *Data:* nothing is migrated and nothing needs undoing; PULSE writes only
  acknowledgement documents and never an activity, a baseline or a financial
  record.

### GST boundary hotfix release order — `fix/gst-boundary-pins` — RULES FIRST, then Hosting; no transitional stage

**Status: DEPLOYED — both steps VERIFIED read-only, 25 November 2026.** The
live Firestore ruleset (`67b6425a…`, 236,737 bytes) is byte-identical to
`frontend/firestore.rules` and carries the shared `gstPinned()` on both pins;
the live Hosting bundle is SHA-256-identical to a clean build of `main`
`875910e`, which contains the hotfix (`ea2eea8`). No release record was ever
written, so the dates of the two steps are unknown. Manual acceptance 1–3 of
TESTING.md §44 has not been run in production (TESTING.md §74.4).
**Lead Architect, 25 November 2026 (REPORTED):** deployment verified and
calculation compatibility accepted; steps 1–3 remain outstanding and are
retained for the relevant financial implementation milestone. The half-cent
rounding itself is tracked as a financial precision concern (tracker D3
#35); no calculation changes now.

*As written before 25 November 2026:* **Status: IMPLEMENTED — NOT YET DEPLOYED (Rules AND Hosting; TWO steps).**
**⚠️ Status to be verified (documentation review, 16 November 2026).** The
hotfix is merged to `main` (`ea2eea8`), and no release record for it exists
in this file. Later sections record releases of rulesets that contain it
(SHIELD 2A, ADR-69, SHIELD 2B1, SHIELD 2B2) as live, which suggests the line
above is stale — but that is an inference, not a record, and it says nothing
about the Hosting step. Left unchanged until the Product Owner confirms both
steps (published ruleset contains the shared `gstPinned()` on both pins;
TESTING.md §44).
Two findings from the SHIELD commercial-integrity inspection of 3 November
2026 (PROJECT_DECISIONS.md → *ADR-40 / ADR-57 Correction: GST Boundary
Hotfix*):

- **F2 — Rules.** Two exact 10% pins refused the app's own writes:
  `supplierInvoices.retentionGst == gstCents(retention)` and the
  `retentionReleases` cumulative-delta pin. `roundMoney(x × 0.1)` rounds some
  half-cents DOWN (40.15 → 4.01 where half-up gives 4.02 — e.g. 5% retention on
  $803.00), so a direct-PO invoice with such a retention, a claim-sourced
  invoice whose claim carried one, and a first release of such an amount all
  failed with permission-denied. Both pins now use the shared `gstPinned()`
  (exact, or one cent below on a boundary; the release delta additionally one
  above when the previous cumulative is on a boundary). **Widening only**: every
  document the live ruleset accepts is still accepted, so the live bundle keeps
  working under the new rules and the new bundle's writes are accepted by the
  new rules — **rules first**.
- **F3 — Hosting.** A claim-sourced invoice's line GST is now the certified
  claim GST apportioned across its taxable lines in whole cents
  (`lib/supplierInvoices.js → allocateClaimSourcedLineGst`), so a multi-line
  claim with cent-level lines can be invoiced (3 × 10.05 → 3.02, previously
  refused by the reconciliation guard). The stored header identities rules
  check are unchanged; the new bundle's claim-sourced invoice also passes the
  OLD ruleset except where it carries a boundary retention — which is exactly
  the F2 case, hence rules first.

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **230,340** (budget 245,000). *(Correction, 20 November 2026: the next
sentence is the wording of 3 November 2026 and is no longer true — GANTT 1B
and PULSE 1C are DEPLOYED and VERIFIED; see their sections above. The GST
hotfix's own status note above is unchanged.)* The repository records GANTT 1B and
PULSE 1C as NOT YET DEPLOYED: this ruleset contains both, so **confirm in the
Console which ruleset is live before STEP 1** (publishing this file also
publishes 1B / 1C rules if they are not yet live — rules-first is the correct
order for those too, but the release records must be straightened first).
Every command runs from `frontend/`, each a separate approved action; **none
is run by an implementation task.**

1. **STEP 1 — publish the FINAL ruleset:**
   ```bash
   npm run test:rules                       # all suites green, incl. the boundary cases
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify in the Console that the published source contains
   `function gstPinned(netC, gstC)` at the shared-helper scope and reads
   230,340 bytes. The live bundle keeps working unchanged.
2. **STEP 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   after `npm run build` with the production `VITE_FIREBASE_*` values.
   Verify with the three manual checks in TESTING.md §44.

*Recovery.* No document is migrated and no stored value changes shape, but
the two steps are **not** equally reversible once production has used the
hotfix:

- **Hosting rollback is safe only while the hotfix rules stay published.**
  The previous bundle's writes are all accepted by the new (wider) ruleset,
  so redeploying the previous Hosting build is a clean rollback for F3 — and
  it **must preserve the compatible GST rules**: do not pair a Hosting
  rollback with a rules rollback.
- **Reverting the Firestore Rules to the pre-hotfix FINAL ruleset (229,126
  bytes) is NOT a clean rollback.** The old exact pins reject the GST values
  the hotfix accepts: a direct-PO or claim-sourced invoice with a boundary
  retention (e.g. 40.15 → 4.01) could no longer be created or draft-edited,
  and a retention release against an invoice whose cumulative released
  amount is already on a boundary — or whose `previouslyReleasedAmount`
  snapshot is — could be refused, because the release delta the client
  computes from that stored history is one the old rule does not admit.
  Existing documents are untouched (rules are evaluated on writes only), but
  **subsequent legitimate writes that depend on them can fail with
  permission-denied** until the compatible rules are republished.
- **Prefer a compatible forward fix.** Where production records already rely
  on the accepted rounding boundaries (any boundary-retention invoice or
  release posted under the hotfix), do not revert the rules; correct forward
  with a ruleset that keeps `gstPinned()` on both pins. The pre-hotfix
  ruleset is a last resort for a defect in the rules themselves, accepted
  with the write failures above, and only together with the previous Hosting
  build so the F3 apportionment is not paired with the old pins.

### SHIELD 2A release order — claim-to-invoice source pairing (ADR-68) — THREE STAGES, the pairing strict from Stage 1, Firebase-CLI driven

**Status: LIVE IN PRODUCTION (confirmed by the Product Owner) (transitional Rules → Hosting →
FINAL Rules; THREE steps).** The 2A bundle writes three NEW claim keys
(`supplierInvoiceId`, `supplierInvoiceLinkedAt`, `supplierInvoiceLinkedBy`)
at claim create and approve that the live `hasOnly` lists REJECT, and it
writes the claim's link inside the invoice create and cancel transactions,
which the live ruleset refuses (an approved claim matches no update branch
today). So the rules must go first — but the FINAL file also REQUIRES the
keys at create and approve, which the live bundle never writes. Hence the
ADR-63 / ADR-65 pattern: a Stage-1 transitional ruleset that accepts BOTH
bundles' claim writes, then Hosting, then FINAL.

**What Stage 1 does NOT relax — read before publishing.** The invoice-side
pairing is strict in both files: from the moment Stage 1 publishes, an
UNPAIRED claim-sourced invoice create (the live bundle's write) is refused
with *Missing or insufficient permissions*, a claim with no link key fails
closed, and cancelling a linked invoice needs the unlink. In practice: a tab
still running the old bundle cannot raise an invoice *from an approved claim*
until it refreshes — that ONE action only; direct-PO invoices, claim create /
submit / approve / reject, PO, variation, payment, credit-note and every other
write are unchanged. This is deliberate (ADR-68 Decision 9): relaxing the
pairing would admit a duplicate as a compatibility shortcut. Keep the window
between Stage 1 and Stage 2 short and tell users to refresh.

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **238,325** and `frontend/firestore.transitional.rules` **239,005**
(budget 245,000). **The GST boundary hotfix, GANTT 1B and PULSE 1C rules must
be live** (this ruleset contains all three; the records for each must be
straightened first — confirm in the Console which ruleset is live before
STEP 1). Every command runs from `frontend/`, each a separate approved action;
**none is run by an implementation task.**

1. **STAGE 1 — publish the TRANSITIONAL ruleset:**
   ```bash
   npm run test:rules                                                        # all suites green, incl. the two pairing suites
   firebase deploy --only firestore:rules --project constrapp-69b5d --config firebase.transitional.json
   ```
   Verify in the Console that the published source starts with the
   `ADR-63 / ADR-65 / ADR-68 STAGE-1 TRANSITIONAL RULESET` header, contains
   four `TRANSITIONAL (STAGE 1)` markers and reads 239,005 bytes. The live
   bundle keeps working except for the one action above.
2. **STAGE 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   after `npm run build` with the production `VITE_FIREBASE_*` values. New
   claims and approvals now carry the keys; claim-sourced invoices are paired.
3. **STAGE 3 — publish the FINAL ruleset** once the new bundle is confirmed
   live (a claim-sourced invoice created and cancelled through the app):
   ```bash
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify the Console source has NO `TRANSITIONAL (STAGE 1)` marker, contains
   `function linkedInvoiceCreatedHere()` and reads 238,325 bytes. Record the
   three timestamps here. Then verify with the three manual checks in
   TESTING.md §45.

*After Stage 3 — the reconciliation backlog.* Every claim approved before
Stage 2, and any claim an old tab approved during Stage 1, has no link key and
cannot be invoiced until reconciled. Open each project's SHIELD tab → check 4
→ *Claim-to-invoice link needs reconciliation*: a claim with ONE active
invoice is linked on the Progress Claims tab (*Link SI-####*); a claim with
NO active invoice stays listed until the Product Owner runs the trusted
inventory / backfill procedure recorded in PROJECT_DECISIONS.md → ADR-68 —
a separate authorisation, outside this repository, never performed by an
implementation task. Record the inventory and the counts here when done.

*Recovery.* No document is migrated and no stored value changes shape, but the
stages are **not equally reversible** once production has paired an invoice:

- **Hosting rollback (to the pre-2A bundle) is safe only under the
  TRANSITIONAL rules**, and even then the old bundle cannot raise an invoice
  from a claim (the pairing is strict) — acceptable for a short window. Under
  FINAL rules the old bundle's claim create and approve are refused too, so
  **a Hosting rollback after Stage 3 must be paired with republishing the
  transitional ruleset** (not the pre-2A one).
- **Reverting the Firestore Rules to the pre-2A FINAL ruleset (230,340
  bytes) is NOT a clean rollback.** The pre-2A `hasOnly` lists reject the
  link keys the 2A bundle writes at claim create and approve, and its
  approved claims admit no update — so every claim create, every approval
  and every claim-sourced invoice create and cancel from the 2A bundle fail
  with permission-denied until a compatible ruleset is republished. Claims
  already linked are untouched (rules evaluate writes only), and the link
  itself is harmless under any ruleset's reads.
- **Prefer a compatible forward fix.** Where production records already carry
  links, do not revert the rules; correct forward with a ruleset that keeps the
  three branches. The transitional ruleset is the widest compatible fallback
  (it still enforces the pairing).

### Rules capacity recovery 2 release order — ADR-69 — RULES ONLY, one FINAL publish, no Hosting, no transitional stage

**Status: LIVE — published before SHIELD 2B1, which required it (Rules only; ONE step).** A
comment-only trim of `frontend/firestore.rules` to clear headroom for SHIELD
2B1: **238,325 → 218,840 bytes** (−19,485), the regenerated transitional file
**239,005 → 219,520**. Every executable line is byte-identical to the
previously reviewed file (`frontend/scripts/verify-rules-comment-only.mjs`,
TESTING.md §46), so the published controls are exactly those of the ruleset
it replaces. **No Hosting deploy** — application behaviour is unchanged.
**Do not publish the transitional ruleset for this milestone**; it is
regenerated only so it stays derivable from the FINAL file for a future
three-stage release.

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **218,840** (budget 245,000); `node scripts/verify-rules-comment-only.mjs
--base 634e69c` (TESTING.md §46) prints `EQUIVALENT` for both files and exits 0. **The ruleset this file replaces must already be the
live one** — SHIELD 2A FINAL (238,325 bytes), which carries the GST hotfix,
GANTT 1B, PULSE 1C and the 2A pairing. Confirm in the Console before STEP 1:
if an older ruleset is live, publishing this file ALSO publishes every control
added since, and those releases' own orders (above) apply first. The command
runs from `frontend/`, a separate approved action; **never run by an
implementation task.**

1. **STEP 1 — publish the FINAL ruleset:**
   ```bash
   npm run test:rules                       # all 31 suites green against the cleaned file
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify in the Console that the published source reads **218,840 bytes**,
   still contains `function gstPinned(netC, gstC)` and
   `function linkedInvoiceCreatedHere()`, and carries NO
   `TRANSITIONAL (STAGE 1)` marker. Record the timestamp here. Then run the
   three manual checks in TESTING.md §46.

*Recovery.* Trivially reversible: republishing the previous FINAL ruleset
(SHIELD 2A FINAL, 238,325 bytes) restores a byte-identical set of controls
— the two files enforce exactly the same rules, so no write that one accepts
is refused by the other and no document is affected. The only reason to
revert would be a publish defect in the file itself (a compile error, which
the Console reports and the emulator suite would already have caught).
Nothing else in this milestone can be rolled forward or back: no Hosting
build, no index, no data.

### SHIELD 2B1 release order — Approved Budget Versions (ADR-70) — RULES FIRST, then Hosting; no transitional stage; ADR-69 must be live first

**Status: LIVE — both steps completed (deployment confirmed by the Product
Owner, 3 November 2026).** Kept as the record of the order used.
2B1 adds three NEW collections (`budgetApprovals`, `budgetApprovalSnapshots`,
`approvedBudget/current`) and hardens the `commercial/baseline` block. The new
blocks are purely additive — the live bundle never reads or writes them — and
the baseline hardening accepts every document the live hook writes (the full
field set with caller + server stamps), so **rules first**: the new bundle's
approval writes are refused until the rules are live, and the old bundle keeps
working under the new rules. No transitional ruleset, no index (the one query
is single-field `orderBy('createdAt')`), no migration, no backend.

**What the hardening changes for the OLD bundle.** Only one write can newly
fail under the new rules before Hosting ships: an old tab editing the legacy
*Original Approved Budget* field on the Commercial tab AFTER a budget version
has been approved on this project (the scalar is frozen while a pointer
exists). A version can only be approved through the NEW bundle, so this cannot
happen before STEP 2 — and after it the field is read-only in the UI.

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **234,479** (budget 245,000); `node scripts/verify-rules-comment-only.mjs
--base 62cea77` is NOT expected to pass (2B1 changes executable rules — it is
not a comment-only release). **ADR-69 (218,840) must be the live ruleset**;
confirm in the Console before STEP 1 (publishing this file also publishes any
controls not yet live — their own orders above apply first). Every command
runs from `frontend/`, each a separate approved action; **none is run by an
implementation task.**

1. **STEP 1 — publish the FINAL ruleset:**
   ```bash
   npm run test:rules                       # all suites green, incl. budgetApprovals + commercialBaseline
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify in the Console that the published source reads **234,479 bytes**,
   contains `match /companies/{companyId}/projects/{projectId}/approvedBudget/current`
   and `function legacyOriginalFrozen(previous)`, and carries NO
   `TRANSITIONAL (STAGE 1)` marker. The live bundle keeps working unchanged
   (every budget figure still reads the working lines — no pointer exists).
2. **STEP 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   after `npm run build` with the production `VITE_FIREBASE_*` values. Every
   surface now labels the legacy figure *Working budget (not approved)* until a
   version is approved. Verify with the three manual checks in TESTING.md §47.
   Users with an old tab open see the old labels until they refresh; nothing
   they write is refused.

*Recovery.* No document is migrated and no stored value changes shape:

- **Hosting rollback (to the ADR-69 bundle) is safe under the 2B1 rules.**
  The old bundle reads the working lines and never touches the new
  collections; an approved version already written stays in place, invisible
  to the old bundle until Hosting is redeployed (it is never a figure the old
  bundle shows as approved — it shows the working lines as before).
- **Reverting the Firestore Rules to the ADR-69 ruleset (218,840 bytes) after
  versions have been approved is NOT a clean rollback for the 2B1 bundle:**
  the new bundle's reads of the three collections are denied by default, so
  every budget figure reads **Unavailable** (fail closed — never the working
  lines, never zero) until a compatible ruleset is republished. Pair a rules
  revert with a Hosting rollback, or prefer a compatible forward fix.
- **Approved versions are never deleted** by any ruleset; a defective version
  is superseded by approving a corrected one.

### SHIELD 2B2 release order — Controlled Budget Adjustments (ADR-71) — RULES FIRST, then Hosting; no transitional stage; 2B1 must be live first

**Status: LIVE IN PRODUCTION (confirmed by the Product Owner) (Rules AND Hosting; TWO steps).**
2B2 adds ONE new collection (`budgetAdjustments`) and extends the
`approvedBudget/current` block with an OPTIONAL ledger (`adjustmentCount`,
`adjustmentNet`, `lastAdjustmentId` — absent reads 0). **Rules first:** the
live 2B1 bundle never writes an adjustment, and its re-approval payload is
accepted unchanged on every pointer with an empty ledger (absent keys read 0
— proven by the *legacy pointer* emulator case); the new bundle's adjustment
writes are refused until the rules are live. No transitional ruleset, no
index (the active-version read is an equality query on the automatic
single-field index; the panel listener is single-field `orderBy('createdAt')`),
no migration, no backend.

**What the new rules change for the OLD (2B1) bundle.** Exactly one write
can newly fail, and only once adjustments exist: an old tab RE-APPROVING a
budget version on a project whose active version already has APPROVED
adjustments — the 2B1 bundle does not reset the ledger, and the rules refuse
a version approval that does not (fail closed: nothing is written, no
adjustment is carried into the new version or counted twice). Adjustments
can only be approved through the NEW bundle, so this cannot happen before
STEP 2. The old bundle shows its generic permission message; **the release
notice must tell users to reload open Budget tabs after STEP 2** (the new
bundle's permission message also says so).

*Preconditions.* Azure CI green on the merge (lint → unit → rules → build);
`npm run rules:transitional:check` clean; `wc -c frontend/firestore.rules`
reads **241,924** (budget 245,000 — 3,076 bytes of headroom remain; the next
rules milestone must start with a capacity recovery). **The 2B1 ruleset
(234,479) must be the live ruleset**; confirm in the Console before STEP 1.
Every command runs from `frontend/`, each a separate approved action; **none
is run by an implementation task.**

1. **STEP 1 — publish the FINAL ruleset:**
   ```bash
   npm run test:rules                       # all suites green, incl. budgetAdjustments + budgetApprovals
   firebase deploy --only firestore:rules --project constrapp-69b5d
   ```
   Verify in the Console that the published source reads **241,924 bytes**,
   contains `match /companies/{companyId}/projects/{projectId}/budgetAdjustments/{adjId}`
   and `function pairedWithAdjustment()`, and carries NO `TRANSITIONAL
   (STAGE 1)` marker. The live bundle keeps working unchanged.
2. **STEP 2 — `firebase deploy --only hosting --project constrapp-69b5d`**
   after `npm run build` with the production `VITE_FIREBASE_*` values. The
   Budget tab gains the six-figure summary and the *Budget adjustments*
   panel; every budget figure reads the CURRENT ADJUSTED approved budget
   (identical to the version total until an adjustment is approved). Verify
   with the three manual checks in TESTING.md §48.

*Recovery.* No document is migrated and no stored value changes shape:

- **Hosting rollback (to the 2B1 bundle) BEFORE any adjustment is approved**
  is clean.
- **Hosting rollback AFTER adjustments are approved is NOT figure-neutral:**
  the 2B1 bundle does not read adjustments, so it shows the BASE version's
  total as the Approved Budget (the adjusted figure is understated or
  overstated by the approved net) and its re-approval of such a project is
  refused by the rules (fail closed). Prefer a forward fix; if a rollback is
  unavoidable, tell users the budget figures exclude approved adjustments
  until Hosting is restored. No record is lost — redeploying the 2B2 bundle
  restores the adjusted figure exactly.
- **Reverting the Firestore Rules to the 2B1 ruleset (234,479) after
  adjustments are approved is NOT a clean rollback:** the 2B1 pointer rules
  reject the ledger keys (`pointerKeys().hasOnly`), so EVERY later version
  approval on those projects is refused, and the new bundle's adjustment
  reads are denied by default (every budget figure reads **Unavailable**).
  Treat a rules revert as a forward fix only.
- **Approved adjustments are never deleted** by any ruleset; a defective
  adjustment is corrected by a separately approved compensating adjustment,
  or superseded by a re-approval.

## L1 — Trusted Backend & Team Management (ADR-72) — LIVE IN PRODUCTION (deployment and live acceptance confirmed by the Product Owner, 11 November 2026)

**What ships:** eight Callable Cloud Functions (ADR-74 later adds one scheduled worker — see *DC46-B*) (`frontend/functions/`, codebase
`team`, Node.js 22, region `australia-southeast1`) and a Hosting bundle with
Company Settings → Team, `/accept-invite` and the membership gate.
**No Firestore or Storage rules change** — `firestore.rules` stays 241,924
bytes; nothing is published to Rules for this release.

### Production release record (11 November 2026)

Confirmed by the Product Owner unless marked *(observed)*. No secret value is
recorded here or anywhere in the repository.

| Item | Production state |
|---|---|
| Project / origin | `constrapp-69b5d`, served at `https://app.constrap.com` (the `web.app` and `firebaseapp.com` origins keep working) |
| Functions | All eight `team` callables deployed in `australia-southeast1` on Node.js 22, each with `enforceAppCheck: true` in code |
| Functions parameters | `frontend/functions/.env.constrapp-69b5d` (committed, non-secret): `APP_BASE_URL=https://app.constrap.com`, `EMAIL_FROM="Constrap <invites@constrap.com>"` (quoted; firebase-tools' dotenv parser yields `Constrap <invites@constrap.com>`), `TEAM_MANAGEMENT_ENABLED=true` |
| Email secret | `EMAIL_API_KEY` created **manually in Google Cloud Secret Manager** (not through `functions:secrets:set`); version 1 ENABLED *(observed)*. `firebase deploy` grants the runtime service account `roles/secretmanager.secretAccessor` on each bound secret, so no manual IAM step was needed. |
| Resend | Sending domain `constrap.com` verified; invitations from `invites@constrap.com` |
| App Check (web) | Registered with reCAPTCHA Enterprise (console name *Fraud Defense*). Site key supplied at build time through `frontend/.env.production.local` (git-ignored by `*.local`) as `VITE_FIREBASE_APPCHECK_SITE_KEY`; no debug token in the production build *(observed in the build)* |
| App Check enforcement | **Callables only** (in code). **Console enforcement for Firestore, Storage and Authentication remains OFF** — see *Deferred: general App Check enforcement* below |
| Storage CORS | Bucket rule updated with `https://app.constrap.com` in `origin` and `X-Firebase-AppCheck` in `responseHeader` (see *Cloud Storage CORS for the Quant™ viewer*) |
| Rules | Not published (no change) |

**Live acceptance passed:** the App Check refusal probe (a production `POST`
to `listTeam` with no App Check token returned `HTTP/2 401`
`UNAUTHENTICATED`; the subsequent authenticated `listTeam` returned
`HTTP 200`); invitation email delivered through Resend;
invitation acceptance; Project Manager permissions; member deactivation and
access revocation; Quant™ PDF and Storage regression; Authentication
regression. Azure CI green on `main`. See TESTING.md §49 for exactly which
manual checks this covers and which are not recorded.

**Release-order note *(observed 11 November 2026, before the Functions
deploy)*:** the Hosting bundle then live at `app.constrap.com` already
contained the L1 Team surface but no App Check site key, while the Cloud
Functions API had never been enabled — Hosting had gone out ahead of
Functions. Existing members were unaffected (membership is read from
Firestore). The release was completed in protocol order — Functions, verify
401, then a fresh Hosting build with the site key. Future releases must keep
**Functions first**.

### Deferred: general App Check enforcement — NOT ENABLED

App Check tokens are now attached to Firestore, Storage and Authentication
requests, but **those services do not reject unverified requests**: until
console enforcement is turned on, App Check gives them **metrics only, no
protection**. Security Rules remain the only trust boundary for client-SDK
data. No monitoring period has been completed. Before enabling enforcement
(a separate, approved change): review Console → App Check request metrics
over a monitoring window and confirm verified requests are close to 100 %;
then enforce one service at a time (Storage, then Firestore, then
Authentication), re-running the Quant™ PDF, upload, sign-in and
password-reset checks after each. Rollback is the same console toggle.

### Product Owner setup (once, before the first Functions deploy — completed for `constrapp-69b5d`)

1. **Blaze plan** on `constrapp-69b5d` (required to deploy Functions and use
   Secret Manager). Add a **GCP budget alert** (Billing → Budgets & alerts),
   e.g. A$20/month at 50 / 90 / 100 %.
2. **Confirm the Firestore location.** `gcloud firestore databases describe
   --project=constrapp-69b5d --database='(default)'` → `locationId`. The
   functions are pinned to `australia-southeast1` (`functions/src/lib/params.js`
   → `REGION` and `src/lib/firebase.js` → `FUNCTIONS_REGION`). If Firestore is
   elsewhere, change BOTH constants to the matching Functions region before
   deploying.
3. **Resend.** Create an account, **verify the sending domain** (Resend shows
   the SPF / DKIM records to add at your DNS host; add a DMARC record if you
   have none), create an API key with *Sending access* only, then:
   `cd frontend && npx firebase functions:secrets:set EMAIL_API_KEY --project constrapp-69b5d`
   (paste the key; it goes to Google Secret Manager, never the repository).
   Creating the secret directly in Google Cloud Secret Manager under the same
   name is equivalent (this is how production was set up). Either way, store
   the key **without a trailing newline** — the Resend adapter sends it
   verbatim in the `Authorization` header — and check it without printing it:
   `gcloud secrets versions access latest --secret=EMAIL_API_KEY --project=constrapp-69b5d | tail -c1 | xxd`
   must not show `0a`.
4. **Parameters.** `frontend/functions/.env.constrapp-69b5d` (committed,
   non-secret) — **set for production:** `APP_BASE_URL=https://app.constrap.com`
   and `EMAIL_FROM="Constrap <invites@constrap.com>"` (quote the value: it
   contains a space and angle brackets). Left empty, invitations are refused
   (`app-url-not-configured`) rather than sent with a broken link. The file is
   deployed with the `team` codebase (it does not match the default `*.local`
   ignore).
5. **App Check.** Console → App Check → register the web app with
   **reCAPTCHA Enterprise** (a score-based website key whose domain list holds
   `app.constrap.com`, `constrapp-69b5d.web.app` and
   `constrapp-69b5d.firebaseapp.com`). Put the site key in
   `frontend/.env.production.local` (git-ignored) as
   `VITE_FIREBASE_APPCHECK_SITE_KEY` — not in `.env.local`, which would also
   switch App Check on for `npm run dev` and the local launchers on
   `localhost`. Leave the *Cloud Functions* enforcement toggle as is: the
   functions enforce App Check in code (`enforceAppCheck: true`). **Do not
   release the Hosting bundle until a production preview has shown an App
   Check token being issued** — without one, every team call is refused (fail
   closed).
6. **Auth settings.** Console → Authentication → Settings: turn on **Email
   enumeration protection**; confirm the production domain is in *Authorized
   domains*. Email/Password sign-in stays enabled (invitees register with it).
7. **Operator credentials** for the scripts: `gcloud auth
   application-default login` as a project Owner/Editor. Never download a
   service-account key file.

### Release order — Functions FIRST, verify, then Hosting

1. **Functions:** `cd frontend && npx firebase deploy --only functions --project constrapp-69b5d`.
   The predeploy hook runs the Functions lint and pure tests. The eight
   callables are inert until the new Hosting bundle calls them; the live
   bundle never does.
2. **Verify Functions security** (no UI needed): a POST to
   `https://australia-southeast1-constrapp-69b5d.cloudfunctions.net/listTeam`
   with body `{"data":{}}` and **no** App Check header must answer **401**.
   Logs: `npx firebase functions:log --project constrapp-69b5d`.
3. **Bootstrap a verification company** (or the first real customer):
   `cd frontend/functions && node scripts/bootstrap-company.mjs --project constrapp-69b5d --company-id <slug> --company-name "<Name>" --admin-email <email>`
   (a dry run — the default), then the same with
   `--apply --link-file <new file outside the repository> --app-url https://<origin>`.
   The link goes to that file (mode 0600) and is never printed; hand it over a
   trusted channel and delete the file. *Updated 24 November 2026 (operator
   tooling safety, PENDING INTEGRATION):* before that change the script wrote
   by default and printed the link — see *Operator tooling safety* below.
4. **Hosting:** build fresh (`rm -rf dist && npm run build`) with the
   production `VITE_FIREBASE_*` values **plus `VITE_FIREBASE_APPCHECK_SITE_KEY`**
   — never redeploy a `dist/` built without the key — confirm the bundle
   contains the site key (e.g. `grep -c -F "<key>" dist/assets/index-*.js`
   without echoing it), then
   `npx firebase deploy --only hosting --project constrapp-69b5d`.
5. **Verify onboarding end-to-end** — TESTING.md §49 (the three manual checks).

**Existing users** keep working with no action: their console-provisioned
`users/{uid}` documents carry no `status` and are treated as active; they
appear in Team on first load.

### Recovery

- **Kill switch:** set `TEAM_MANAGEMENT_ENABLED=false` in
  `functions/.env.constrapp-69b5d` and redeploy Functions — every callable
  answers `team-management-disabled`; no data changes. Existing members are
  unaffected (rules do not depend on the functions).
- **Functions rollback:** check out the previous commit and `firebase deploy
  --only functions` (there is no one-click Functions rollback). Deleting the
  functions (`firebase functions:delete <name> --region australia-southeast1`)
  is also safe: membership documents stay valid.
- **Hosting rollback:** Console → Hosting → release history → *Rollback*
  (there is no `firebase hosting:rollback` command). The previous bundle has no
  Team page and no gate; members keep working.
- **Accidental role change:** change it back in Team. **Accidental
  deactivation:** re-invite the person (same uid and history; their account is
  re-enabled when they open the link). **No admin left** (should be
  impossible — the last-admin guard is transactional): run the bootstrap script
  for the same company and email to issue a fresh `company_admin` invitation.
- **Auth sync left pending / drift:** `node scripts/reconcile-membership.mjs
  --project constrapp-69b5d` reports; `--fix` completes pending Auth disables
  only. Everything else is reported for a human decision.
- **Secret rotation:** `firebase functions:secrets:set EMAIL_API_KEY`, then
  redeploy Functions (a new secret value is only picked up on deploy), then
  revoke the old key in Resend.

### Monitoring (minimum)

Cloud Logging for the `team` functions: `severity>=ERROR` is an unexpected
failure (expected refusals log at INFO as `team call refused` with their
code). Create a log-based alert on `resource.type="cloud_run_revision" AND
severity>=ERROR AND labels."goog-managed-by"="cloudfunctions"` (Console →
Logging → Create alert). Invitation delivery failures show in Team as "Not
delivered" and in the logs as `invitation email failed`. Membership history is
in `companies/{c}/auditEvents` (console read only).

## DC46-A — Authenticated Storage downloads (ADR-73) — LIVE IN PRODUCTION (Hosting deployed and production-tested; confirmed by the Product Owner, 11 November 2026)

**Release record.** Merged to `main` as `1ef6689`. Passed in production: the
drawing viewer, General Documents, Quant PDF and image viewing, iPhone
Safari, and a deactivated member refused new Open / Download requests.
**Android Chrome has not been tested yet** (TESTING.md §51 step 12).

**No Rules publish, no
Functions deploy, no bucket or data change.** Deferred Control 46 stayed OPEN
after this release (it was closed on 18 November 2026 — *DC46 — production
closure record* below): it stops the app minting download URLs; it does not
revoke any URL already copied.

**Before deploying**

1. Confirm the bucket CORS rule lists `https://app.constrap.com` (and
   `X-Firebase-AppCheck`) — *Cloud Storage CORS for the Quant™ viewer*, step 1.
   Every file view now depends on it, not only Quant.
2. `npm run lint`, `npm run test:unit`, `npm run test:rules`,
   `npm run test:functions`, `npm run build` all pass.

**Release.** `firebase deploy --only hosting --project constrapp-69b5d`, then
run TESTING.md §51 on `https://app.constrap.com`.

**Rollback.** Redeploy the previous Hosting release. Safe at any time while
part B has not run: the objects still carry their download tokens, so the
previous build's `getDownloadURL` calls keep working. **Once any download
tokens have been removed (part B), this release becomes the floor** — whether
an older build could still open files would then depend on undocumented
Firebase behaviour.

**What to watch.** Reports of drawings that never finish loading on site
connections (the whole file downloads before anything shows — 50 MB needs
about 40 s at 10 Mbit/s), a blank tab after Open on iOS or in an in-app
browser, and downloads with a wrong filename on Android.

## DC46-B — Legacy download-token revocation (ADR-74) — LIVE IN PRODUCTION (deployed and accepted, 12 November 2026)

Merged to `main` (`0a2b3b8`). **No Rules publish.** One new scheduled
function, changes to two callables and `listTeam`, a Team-page status line,
and an operator script. **Deferred Control 46 stayed OPEN after this release**
(SECURITY.md) — this section closes the DC46-B release, not the control,
which was closed on 18 November 2026 (*DC46 — production closure record*
below).

### Production release record — 12 November 2026

**State.** Deployed to `constrapp-69b5d` and accepted by the Product Owner in
the browser. Constrap had not launched: the only company was the Product
Owner's development tenant, so every production step below ran against that
one tenant. Times are UTC.

**Sequence actually used.** It differs from the staged plan further down: the
worker was deployed ALONE first, so that nothing in production could queue a
request while it was being verified. Each step was separately authorised.

1. **Infrastructure** (Product Owner, `gcloud`). Cloud Scheduler API enabled;
   `file-link-worker@` and `file-link-operator@` created; custom role
   `fileLinkCleaner` (`storage.objects.get`, `.list`, `.update`); for both
   accounts `roles/datastore.user` on the project and the custom role on the
   bucket **`constrapp-69b5d.firebasestorage.app`**. Verified afterwards: no
   user-managed keys, no other grant, no project-wide invoker, the default
   compute account unchanged.
2. **Worker only** —
   `firebase deploy --only functions:team:processFileLinkRevocations --project constrapp-69b5d`.
   The eight callables stayed on their L1 revisions. Verified: one Scheduler
   job, enabled, every minute, OIDC identity = the worker account;
   `run.invoker` for that account on that one service only; every run HTTP 200
   and silent; queue count 0.
3. **Operator set-up and inventory.** `roles/iam.serviceAccountTokenCreator`
   for the operator on `file-link-operator@` only; impersonated ADC (no key
   file). Dry run: 1 company, 4 objects, 4 with a download token.
4. **Historical clean-up (operator script)** —
   `--company-id <the tenant> --execute --confirm-project constrapp-69b5d`:
   exit 0, *4 scanned, 4 token(s) removed, 0 failed*. Every object kept its
   generation, size and MD5; only `metageneration` moved (1 → 2). Audit:
   `file_links.revocation_requested` + `file_links.revoked`, source `operator`.
5. **All Functions** — `firebase deploy --only functions`. The callables moved
   to new revisions built from source byte-identical to `main`; the worker was
   skipped as unchanged. Each callable still answered 401 without an App Check
   token.
6. **Hosting** — `firebase deploy --only hosting` (release 05:46). The live
   files were byte-identical to a fresh build of `main`, with the App Check
   site key present.
7. **Browser acceptance (Product Owner)** — TESTING.md §52 → *Production
   acceptance record*. Re-invited test member, test upload, deactivation,
   *pending* → *revoked*, old URL **403**, in-app access kept.

**What production showed for the end-to-end run.** The deactivation and its
revocation request carry the same timestamp (06:12:39, one transaction). The
scheduled worker completed the sweep at 06:13:03 — 24 seconds later — with
*5 scanned, 3 removed, 0 failed*; audit source `worker`. Afterwards: request
and completed sequence both 2, no lease, no open sweep, queue 0, five objects
and none with a token, all nine functions ACTIVE, no warning or error in the
logs, no token-shaped string in any function log.

**Identity and IAM decisions, as deployed.** Exactly the table below
(*Identities — three, kept apart*): a dedicated worker account that is also
the Scheduler OIDC identity, with the invoker right on its own service only;
keyless operator access by impersonation; the shared default compute account
untouched (it remains the build account).

**Evidence that is NOT from production.** Forced failure, retry/backoff,
exit code 3, the *delayed* status and repeat-`--execute` idempotency were
exercised only in `constrap-dc46-validation` and in the automated suites.
Storage data-access audit logging is off in production, so per-object changes
are evidenced by object version counters and the Firestore audit trail, not
by an audit log of each request.

**Found during the release — tracked, not fixed here** (SECURITY.md →
Deferred Control 46):
- **Tokens were re-created outside the app.** The acceptance sweep removed
  three tokens although only one file was new: two already-cleaned objects had
  gained a token again (`metageneration` 2 → 4). The cause is unproven; the
  Firebase console's file panel is the likely source. The sweep removed them.
- **No periodic sweep** — such tokens, and those on new uploads, live until
  the next membership change or operator run.
- **Role reduction cannot fire through the app** — `changeMemberRole` accepts
  internal roles only, so removing an external role stays an operator
  procedure followed by a manual script run.
- **A re-invited member keeps the old revocation sequence**, so their ACTIVE
  row can read *Old file links: revoked*.
- **Scale is unmeasured** — the largest production sweep was five objects.

**Functions source archive (corrected after this release).** The two Functions
deploys above packaged local files into the uploaded source archive
(`.env.local`, `.env.constrap-dc46-validation`): `firebase.json` had no
`ignore` list, and the CLI's default excludes only `node_modules` and `.git` —
`.gitignore` does not apply to packaging. No secret was in those files (key
names checked). `firebase.json` → `functions[].ignore` now lists the standard
Firebase entries plus `*.local` and `.env.*-validation`; the archive is exactly
the 33 tracked files under `functions/`, including the required
`.env.constrapp-69b5d`. The next Functions deploy will therefore see a changed
source hash and roll all nine functions to new revisions with no code change.

**Validation project — retirement plan.** `constrap-dc46-validation` is no
longer needed for the release. Retire it once this record is merged (it is the
only place the failure and retry behaviour was demonstrated, and the docs cite
it): Product Owner runs `gcloud projects delete constrap-dc46-validation`
(recoverable for 30 days), then deletes the local, never-committed
`functions/.env.constrap-dc46-validation`.

**Housekeeping still to do.** Revoke the operator's impersonated ADC
(`gcloud auth application-default revoke`) and decide whether to keep the
operator's token-creator binding for future manual runs.

### Continuity checkpoint — 12 November 2026 (pre-release; superseded by the record above)

*Historical. Kept as written before the production release; where it says
"not authorised" or lists next steps, the record above is the current state.*

**State.** Implemented and validated on `security/dc46-b-token-revocation`;
architect GO for Git integration and Azure CI. **Production deployment is NOT
authorised.** Deferred Control 46 stays **OPEN**.

**What was built (ADR-74).** Membership transactions (`deactivateMember`;
`changeMemberRole` when file access drops) record a revocation request in the
same transaction. The scheduled worker `processFileLinkRevocations` (every
minute, one instance) removes Firebase download tokens under
`companies/{companyId}/` with leases, per-page checkpoints and
generation/metageneration preconditions. A member reads *revoked* only after a
zero-failure sweep that started after their change. The Team page shows
*pending / revoked / delayed*, never "immediate". Operator script
`functions/scripts/revoke-file-links.mjs`: dry run by default; `--execute`
needs `--confirm-project`; exit 3 when incomplete.

**Evidence (real Firebase, `constrap-dc46-validation`).** Token removal makes
old URLs 403 at once; authenticated reads keep working without re-creating a
token; metadata preserved. The worker's IAM-forced failure stays *delayed*
and recovers on the next sweep; repeats are idempotent. The operator script
passed dry run, confirmation guard, execute, repeat, and partial failure
(exit 3) with recovery. TESTING.md §52; ADR-74.

**Security decisions.**
- Token REMOVAL, not rotation.
- Fail closed on any listing without version counters. This fixes the false
  *revoked* that Stage 0 found.
- Dedicated `file-link-worker@<projectId>` runtime account, named per project
  by `FILE_LINK_WORKER_SERVICE_ACCOUNT`. Its Scheduler/OIDC identity is the
  same account — an accepted trade-off of Firebase `onSchedule`, with invoker
  granted on this service only. The shared default compute account is
  untouched.
- Keyless operator access by impersonating `file-link-operator@<projectId>`.
- No Rules change.

**Outstanding risks.**
- Not immediate.
- Active members can still mint a URL.
- New uploads carry a token until the next sweep (no periodic sweep).
- **Document visibility reduction (`project` → `internal`) is not covered.**
- Operator-managed external roles need a manual run.
- IAM cannot narrow `datastore.user` or the bucket role to `companies/`.
- Firebase token behaviour is undocumented.
- Scale is unmeasured.

**Next production steps (each needs separate authorisation).**
1. Create the worker and operator accounts, the custom role and the bindings
   (below).
2. Deploy Functions.
3. Deploy Hosting.
4. Read-only inventory.
5. Pilot on a test company.
6. All-company `--execute` (Product Owner approval).
7. Confirm 0 tokens remain, run TESTING §52, revoke operator ADC.

**Validation project.** Keep it until production completes. The Scheduler is
paused. It holds two service accounts, a custom role, a placeholder
`EMAIL_API_KEY`, test users and about 23 small objects.
`functions/.env.constrap-dc46-validation` is local-only and never committed.

**Identities — three, kept apart (verified in `constrap-dc46-validation`, 12 November 2026)**

| Identity | Who | Holds | Never holds |
|---|---|---|---|
| **Worker runtime** | `file-link-worker@<projectId>.iam.gserviceaccount.com` (dedicated; must exist before the deploy) | `roles/datastore.user` (project); the custom role *file-link cleaner* (`storage.objects.list`, `storage.objects.get`, `storage.objects.update`) on the **one bucket**; `roles/run.invoker` on **this one Cloud Run service** — granted by the CLI, see below | project-wide `run.invoker`, `storage.objects.create` / `.delete`, any secret, any other bucket |
| **Scheduler invocation** | the SAME account, as an OIDC token | — | — |
| **Build** | the shared default compute account (`<number>-compute@developer.gserviceaccount.com`) | unchanged — it builds every function | **do not remove its roles**: in Stage 0 that broke the next deploy (*missing permission on the build service account*) |
| **Operator** | `file-link-operator@<projectId>.iam.gserviceaccount.com`, impersonated through keyless ADC | `roles/datastore.user` (project); the same custom role on the one bucket; each human operator gets `roles/iam.serviceAccountTokenCreator` on THIS account only | anything else — an impersonated credential cannot reach another project |

**Why the runtime and the Scheduler identity are the same account.** For
`onSchedule`, the Firebase CLI always sets the Scheduler job's OIDC identity to
the function's `serviceAccount` (`firebase-tools` `gcp/cloudscheduler.js`), and
on every create AND update grants `run.invoker` for that account on the
function's own Cloud Run service, replacing the previous invoker list
(`deploy/functions/release/fabricator.js`). So the invoker right is
**service-scoped and CLI-managed**: no project-level `run.invoker` is needed,
and none was granted. A separate invoker account would mean an HTTP function
plus a Scheduler job managed outside the CLI; not done — it adds a public-shaped
endpoint and configuration drift for no security gain here.
*Correction:* an earlier Stage 0 note said a deploy wipes the service's invoker
binding and recommended project-level `run.invoker`. That was a misread (the
probe used POST for Run `getIamPolicy`, which returns nothing). It is withdrawn.

**What it needs in the project (check before deploying)**

1. **APIs.** Cloud Scheduler, Cloud Run, Cloud Build, Artifact Registry,
   Eventarc and Pub/Sub — the CLI enables any that are missing. Production
   already runs 2nd-gen Functions, so only Cloud Scheduler is likely new.
2. **The worker account** (once, Product Owner, console or `gcloud`):
   ```
   gcloud iam service-accounts create file-link-worker --project constrapp-69b5d \
     --display-name "Constrap file-link revocation worker (ADR-74)"
   gcloud iam roles create fileLinkCleaner --project constrapp-69b5d \
     --title "File-link cleaner (ADR-74)" \
     --permissions storage.objects.list,storage.objects.get,storage.objects.update
   gcloud projects add-iam-policy-binding constrapp-69b5d \
     --member serviceAccount:file-link-worker@constrapp-69b5d.iam.gserviceaccount.com \
     --role roles/datastore.user
   gcloud storage buckets add-iam-policy-binding gs://constrapp-69b5d.firebasestorage.app \
     --member serviceAccount:file-link-worker@constrapp-69b5d.iam.gserviceaccount.com \
     --role projects/constrapp-69b5d/roles/fileLinkCleaner
   ```
   The person deploying needs `iam.serviceAccounts.actAs` on it (a project
   owner has it). Do NOT grant it `run.invoker` yourself; the deploy does that
   on the one service.
3. **`functions/.env.constrapp-69b5d`** carries
   `FILE_LINK_WORKER_SERVICE_ACCOUNT=file-link-worker@constrapp-69b5d.iam.gserviceaccount.com`
   (committed with this branch). A deploy-time regex refuses anything that is
   not `file-link-worker@<projectId>.iam.gserviceaccount.com`, and a unit test
   fails if any `.env.<projectId>` names an account in a different project.
   ⚠️ Do not use the CLI's short form `file-link-worker@`: firebase-tools 15
   expands it for the function but sends it unexpanded to Cloud Scheduler,
   which rejects the job (HTTP 400 — found in Stage 0).
4. **Every parameter needs a dotenv value** for a non-interactive deploy,
   defaults included: `STORAGE_BUCKET=` (empty = the default bucket) and
   `FILE_LINK_REVOCATION_ENABLED=true` are in the production file.
5. **`EMAIL_API_KEY` must exist** (it does): even
   `--only functions:team:processFileLinkRevocations` checks every secret
   parameter in the codebase. The worker does not bind it.
6. **Artifact cleanup policy** — production already has one. A new project's
   first non-interactive deploy ends with an error about it AFTER deploying;
   set it with `firebase functions:artifacts:setpolicy --location
   australia-southeast1 --days 1`.
7. **Kill switch.** `FILE_LINK_REVOCATION_ENABLED=false` in
   `functions/.env.<projectId>` + redeploy pauses the worker; requests still
   queue. Pausing the Scheduler job also works: a later deploy updates a
   paused job and leaves it paused (verified).
8. **Operator credentials** (Stages 3 and 5) — keyless, scoped:
   create `file-link-operator@` as in step 2 (same two role bindings), grant
   the operator `roles/iam.serviceAccountTokenCreator` on that account only,
   then
   ```
   gcloud auth application-default login \
     --impersonate-service-account file-link-operator@constrapp-69b5d.iam.gserviceaccount.com
   ```
   and afterwards `gcloud auth application-default revoke`. No key file is
   created; `GOOGLE_APPLICATION_CREDENTIALS` is refused by the script.

**Stage 0 — evidence from `constrap-dc46-validation` (12 November 2026).**
Only `processFileLinkRevocations` deployed, Scheduler paused when finished.
- The first live run exposed a false *revoked* (the real client's listing
  shape — ADR-74). Fixed, with a fail-closed check; re-verified live.
- With the dedicated worker account (runtime = Scheduler OIDC identity,
  `run.invoker` on the service only, no project-level invoker, the default
  compute account untouched at `roles/editor`): tokens removed, old URLs
  **403**, another company's URL **200**, authenticated reads **200** without
  re-creating a token, metadata preserved, status *revoked*, no token value in
  Cloud Logging.
- With `storage.objects.update` withheld from the worker on the bucket: 1
  object failed, the sweep stayed incomplete (*delayed*; the old URL still
  200), and the first scheduled sweep after the role was restored completed it
  (URL 403).
- A repeat request removed 0 and touched no object; idle runs changed nothing.
- Operator script results: TESTING.md §52 → *Operator evidence*.

**Stage 1 — Functions.** *(As released on 12 November 2026 the worker was
deployed alone first with `--only functions:team:processFileLinkRevocations`,
then everything — see the release record above.)* `firebase deploy --only functions --project
constrapp-69b5d`. The callables' new fields are additive, so the current
Hosting build keeps working. Confirm in Cloud Logging that the worker runs
each minute and is silent when nothing is queued.

**Stage 2 — Hosting.** `firebase deploy --only hosting --project
constrapp-69b5d`. The Team page now shows the status line.

**Stage 3 — inventory (read only).** With the operator credential from
step 8, from `frontend/functions`:

```
node scripts/revoke-file-links.mjs --project constrapp-69b5d \
     --bucket constrapp-69b5d.firebasestorage.app --all-companies
```

Prints, per company, how many objects exist and how many carry a download
token. Changes nothing. Record the totals.

**Stage 4 — pilot on a production TEST company.** Upload a test file, capture
its download URL (browser console, test company only), deactivate a test
member, wait for *Old file links: revoked*, confirm the URL is refused and
the app still opens the file. TESTING.md §52.

**Stage 5 — first all-company clean-up** (Product Owner approval; a
production data change that cannot be undone):

```
node scripts/revoke-file-links.mjs --project constrapp-69b5d \
     --bucket constrapp-69b5d.firebasestorage.app --all-companies --execute --confirm-project constrapp-69b5d
```

Then repeat Stage 3 and confirm every company reports **0** objects with a
token and `completed` equal to `requests`. Exit code 3 means at least one
company did not complete — it stays queued and is retried by the worker;
investigate before treating the release as done.

**Rollback.**
- *Pause (first move, seconds):* pause the Scheduler job
  (`firebase-schedule-processFileLinkRevocations-australia-southeast1`) in the
  console, or set `FILE_LINK_REVOCATION_ENABLED=false` and redeploy Functions.
  Requests keep queuing; nothing is lost. A deploy leaves a paused job paused.
- *Functions:* redeploy the previous Functions release. ⚠️ A non-interactive
  deploy does not delete a function that has left the source, so the worker
  keeps running — pause it first, then remove it deliberately with
  `firebase functions:delete processFileLinkRevocations --project <id>`
  (which also removes its Scheduler job). The state documents are inert
  without it.
- *Identities:* the worker and operator accounts can be disabled in IAM at any
  time; nothing else depends on them. The default compute account was never
  changed, so there is nothing to restore.
- *Hosting:* redeploy the previous Hosting release — **not earlier than the
  DC46-A build (`1ef6689`)**. An older build calls `getDownloadURL`; it would
  still open files (Firebase re-creates a token on that call) but would put
  bearer links back into the page.
- *Removed tokens cannot be restored and do not need to be:* the app does not
  use them.

**What to watch.** Error-level `file-links: sweep incomplete` log lines (a
company has failed three sweeps in a row); `file-links: sweep interrupted`;
Team-page reports of *Revocation delayed*; the worker's execution time.

**Cross-service rules — a deployment trap found during validation.**
`storage.rules` calls `firestore.get()`, which needs the role
`roles/firebaserules.firestoreServiceAgent` on the Firebase Storage service
agent. The CLI offers the grant during an interactive Storage rules deploy —
**and silently skips it with `--non-interactive`**, while still reporting
success. Without it every Storage request is refused. Production already has
the grant; any NEW project or a CI rules deploy must add it explicitly and
allow tens of minutes for it to take effect.

## DC46-C — Periodic token reconciliation, Stage 1 (ADR-75) — WORKER DEPLOYED 13 November 2026; revocation PRODUCTION-ACCEPTED 16 November 2026; EIGHT CALLABLES REDEPLOYED AND ACCEPTED 16 November 2026; deactivation regression PASSED 16 November 2026; periodic reconciliation ACTIVATED 17 November 2026 19:16 UTC at a 2-hour interval

Merged to `main` (`38ab578`). **Current state (18 November 2026): the worker
runs revision `processfilelinkrevocations-00003-ceg` with periodic
reconciliation ON at `FILE_LINK_RECONCILE_INTERVAL_HOURS=2` (activated
17 November 2026 19:16 UTC from `main` `2b3ba9a`); the eight callables run
revisions `-00004-*` (ADR-75 Stage 3, 17 November 2026 20:49 UTC); policies
A, B and C are enabled.** Stage 1 itself was Functions only: no Rules
publish, no Hosting deploy, no IAM change, no new function, Scheduler job or
service account. Deferred Control 46 was CLOSED on 18 November 2026 with documented accepted risks (SECURITY.md item 46; *DC46 — production closure record* below). The records below
are kept as written on their dates; revision names in them (`-00002-had`,
`-00003-*`) are the revisions of that day.

| Status | What it covers |
|---|---|
| **IMPLEMENTED** | The Stage 1 periodic reconciliation framework |
| **DEPLOYED** | The updated scheduled worker (step 2 below, 13 November 2026) and the eight callables (step 3 below, 16 November 2026 — callables only; the worker was not redeployed) |
| **PRODUCTION-ACCEPTED** | The existing membership-triggered revocation through the updated worker (16 November, with the previous callable build). The eight-callable deploy itself (16 November, architect decision) — on configuration, source, refusal probes and one read-only `listTeam` call. **The deactivation regression through the new revisions — PASSED 16 November 2026, 23:12–23:13 UTC** (*Deactivation regression record* below) |
| **ACTIVATED 17 November 2026 19:16 UTC** | Periodic reconciliation (step 4) at an initial interval of **2 hours** — architect decision 17 November 2026; 1 hour rejected. Runbook below (*Activation runbook*); production is `2` |
| **COMPLETED SINCE** | Stages 2 and 3 (17 November 2026); the external document access correction (17 November 2026); Stage 4 volume measurement deferred to a threshold-triggered follow-up; Deferred Control 46 CLOSED 18 November 2026 |

### Production release record — 13–16 November 2026

Project `constrapp-69b5d`, region `australia-southeast1`. Times are UTC. The
release followed a billing interruption (next section); production was
checked read-only before the deploy.

**Before the deploy (read-only, 13 November).** Worker revision
`processfilelinkrevocations-00001-cep`: concurrency **80**, max instances 1,
timeout 300 s, runtime account `file-link-worker@constrapp-69b5d`. Scheduler
job `firebase-schedule-processFileLinkRevocations-australia-southeast1`:
enabled, every minute, attempt deadline 300 s, no retry, OIDC identity the
worker account. Billing enabled; the required APIs enabled; queue empty.

**Deploy (Product Owner, about 06:43).**
`firebase deploy --only functions:team:processFileLinkRevocations --project constrapp-69b5d`
— step 2 below, worker only.

| Check after the deploy | Result |
|---|---|
| Revision | `processfilelinkrevocations-00002-had`, Ready, 100% traffic. `-00001-cep` is retained |
| Concurrency · max instances · timeout | **1** · 1 · 300 s |
| Runtime account | unchanged (`file-link-worker@constrapp-69b5d`) |
| `FILE_LINK_REVOCATION_ENABLED` · `FILE_LINK_RECONCILE_INTERVAL_HOURS` | `true` · `0` |
| The eight callables | unchanged, on the revisions they had before; all Ready |
| Rules · IAM | no change. The worker account still holds `roles/datastore.user` (project), the `fileLinkCleaner` role on the one bucket and `run.invoker` on its own service, where it is the only member |
| Scheduler job | still one job, enabled, every minute, 300 s deadline, same OIDC account |
| Scheduled runs | 13 consecutive attempts inspected (06:44–06:56), all HTTP 200 on the new revision; no minute missed across the deploy. From the deploy to 16 November 02:41 every recorded attempt returned 200 |
| Idle behaviour | no worker log line, no log line about reconciliation, no `system/fileLinkReconciliation` document (direct lookup: not found), queue count 0 |
| Warnings or errors | none in the project's logs |

**Scheduler target — changed form.** The deploy rewrote the job's target from
`https://australia-southeast1-constrapp-69b5d.cloudfunctions.net/processFileLinkRevocations`
to the same service's Cloud Run address (`https://processfilelinkrevocations-….a.run.app/`),
and the OIDC audience to match. Both addresses are listed on the one service;
the job, the service and the identity are the same, and every authenticated
call since has succeeded. Why the CLI chose the other form on an update was
not traced. Recorded so that a later comparison does not read it as drift;
there is no evidence of any security effect.

**Acceptance — 16 November (development tenant; TESTING.md §53).** One
controlled deactivation through the deployed `deactivateMember`:

| Time | Event (backend evidence: request logs, worker log, audit trail) |
|---|---|
| 03:01:44 | Invitation created (`createInvitation` 200) |
| 03:02:03 | Auth account re-enabled by the invitation |
| 03:02:31 | Invitation accepted (`acceptInvitation` 200) |
| 03:06:44 | `deactivateMember` HTTP 200 |
| 03:06:45 | `member.deactivated` and `file_links.revocation_requested` (one transaction, sequence 3) |
| 03:07:02 | Worker sweep complete on `processfilelinkrevocations-00002-had`; `file_links.revoked`, source `worker` |

Counters: 1 company, 1 urgent request, 0 periodic; **5 objects scanned, 1
page, 1 token removed, 0 failed**; complete; queue markers afterwards 0.
Scheduler enabled, every minute, recent attempts all 200. Configuration as in
the table above.

The Product Owner reported that the manual test passed (a working legacy URL
before the deactivation; the deactivation; the revocation). **Not separately
recorded for this run:** the old URL's HTTP status after the sweep, and that
an authorised user could still open the file in the app. Both were verified
in the DC46-B acceptance of 12 November; for 16 November the removal is
evidenced by the worker's counters only. An earlier reported pass could not
be found in the logs and is not part of this record (TESTING.md §53).

**Outstanding after this release — as it stood on 16 November, before the
callable deploy.** Step 3 (the callables) — until it was done the callables
ran the ADR-74 build beside the Stage 1 worker, a pairing that the acceptance
above exercised **and that was correct only while the interval is `0`**
(*DC46-C monitoring readiness* → *Dependency on the all-Functions deploy*).
**Step 3 was completed later on 16 November 2026 — next section.** Step 4
(activation) — not authorised. Monitoring — alert policies A and B and two
notification channels were created on 16 November 2026, after this release
(*DC46-C monitoring readiness* → *Monitoring release record*).

### Callable release record — 16 November 2026 (eight callables only; ACCEPTED)

Project `constrapp-69b5d`, region `australia-southeast1`. Times are UTC,
16 November 2026. Source: `main` at `44446a0`. **Cloud** means read by a
read-only inspection of the Cloud Functions, Cloud Run, IAM, Secret Manager,
Scheduler, Monitoring and Logging APIs; **Reported** means stated by the
Product Owner and not independently observed.

**Why.** Step 3 of the order below: the callables ran the ADR-74 build, which
does not write the request priority (*Dependency on the all-Functions
deploy*). This deploy brings them to the same library source as the worker.
It changes no behaviour while the interval is `0` and activates nothing.

**Scope — a recorded departure from step 3 as first written.** Step 3 named
`firebase deploy --only functions`. On the architect's approval the Product
Owner instead targeted **exactly the eight callables** —
`--only functions:team:listTeam,functions:team:createInvitation,functions:team:resendInvitation,functions:team:revokeInvitation,functions:team:previewInvitation,functions:team:acceptInvitation,functions:team:changeMemberRole,functions:team:deactivateMember --project constrapp-69b5d`
— so that the accepted worker could not be redeployed: the CLI never skips a
function named in `--only` and never touches one that is not. **The worker
was not redeployed.** No Hosting deploy, no Rules publish. The Firebase CLI
version used was **not recorded**.

**Before the deploy (Cloud, about 19:30).** All eight callables ACTIVE on
their 12 November revisions (`-00002-*`), build hash `53bb71de…`; secret
`EMAIL_API_KEY` with one version, `1`; worker `-00002-had`; queue count 0;
policies A and B enabled; no open incident. Automated gates on `44446a0`:
TESTING.md §55.

**Deploy (Product Owner; revisions created 20:20:45–20:20:50, functions
updated 20:20:58).** Firebase reported *Deploy complete!* (Reported).

| Callable | Previous revision | New revision |
|---|---|---|
| `listTeam` | `listteam-00002-muq` | `listteam-00003-qon` |
| `createInvitation` | `createinvitation-00002-vej` | `createinvitation-00003-pup` |
| `resendInvitation` | `resendinvitation-00002-rum` | `resendinvitation-00003-nem` |
| `revokeInvitation` | `revokeinvitation-00002-sof` | `revokeinvitation-00003-wag` |
| `previewInvitation` | `previewinvitation-00002-sil` | `previewinvitation-00003-juq` |
| `acceptInvitation` | `acceptinvitation-00002-haq` | `acceptinvitation-00003-giw` |
| `changeMemberRole` | `changememberrole-00002-noj` | `changememberrole-00003-meb` |
| `deactivateMember` | `deactivatemember-00002-pam` | `deactivatemember-00003-qey` |

| Check after the deploy (Cloud, 20:22–20:25) | Result |
|---|---|
| State and traffic | All eight ACTIVE and Ready; 100 % of traffic on the new revision. The `-00002-*` revisions are retained |
| Build | All eight carry build hash `afc3ba3a…` (before: `53bb71de…`). The uploaded source archive of `deactivateMember` was downloaded and compared with `main` `44446a0`: `src/`, `package.json` and `package-lock.json` identical. The other seven were not downloaded; they share the hash |
| Request priority | The deployed `lib/fileLinkRevocation.js` writes `requestPriority: urgent` (ADR-75 decision 7) |
| Runtime · region · timeout · memory · max instances · concurrency | `nodejs22` · `australia-southeast1` · 30 s · 256 Mi · 5 · 80 — all unchanged |
| Runtime account | unchanged — the project's default compute account |
| Secret | `EMAIL_API_KEY` bound at version `1` on all eight; the secret still has exactly one version and one accessor (the default compute account) |
| Environment | `APP_BASE_URL`, `EMAIL_FROM`, `TEAM_MANAGEMENT_ENABLED=true`, `FILE_LINK_REVOCATION_ENABLED=true`, the worker-account parameter and the empty `STORAGE_BUCKET` preserved. **One addition:** `FILE_LINK_RECONCILE_INTERVAL_HOURS=0` now appears on each callable (the parameter is declared for the codebase; the callables do not read it) |
| Invoker IAM | unchanged: `allUsers` on each callable (normal for a callable — the gate is App Check in code); the worker account alone on the worker. No `SetIamPolicy` in the audit log |
| App Check refusal | A `POST` with no App Check token and no sign-in to each of the eight returned **HTTP 401** `UNAUTHENTICATED`, logged against each `-00003-*` revision at 20:24:14–20:24:17. The handler does not run on such a request |
| Worker | still `processfilelinkrevocations-00002-had`, build hash `8df8d08d…`, last updated 13 November; concurrency 1, max instances 1, own account; `FILE_LINK_REVOCATION_ENABLED=true`, `FILE_LINK_RECONCILE_INTERVAL_HOURS=0` |
| Scheduler | one job, `ENABLED`, every minute, last changed 13 November 06:43:20 |
| Worker runs | 60 of 60 attempts in the preceding hour returned HTTP 200, through and after the deploy; no error-level worker line in 24 hours |
| Reconciliation | not started: no reconciliation log line, queue count 0, no `system/fileLinkReconciliation` document (direct lookup: not found) |
| Monitoring | policies A and B enabled, unedited since creation, each with both channels; both channels enabled; exactly two policies; no open incident |
| Audit log | `UpdateFunction` for exactly the eight callables and the Cloud Run and Cloud Build calls that go with them. Nothing for the worker, Scheduler, IAM, Secret Manager or Monitoring |
| Hosting · Rules | unchanged: last Hosting release 12 November 05:46; Firestore ruleset release 3 November; Storage ruleset release 20 September |
| Billing | reads as enabled. Nothing else about billing is known (*Billing continuity* below) |

**Live application (Product Owner evidence).** The Product Owner opened
Settings → Team at `https://app.constrap.com` and supplied a screenshot: the
page rendered with two active administrators, the previously deactivated
test member still shown as deactivated, no pending invitation, and no visual
or loading error — **Reported**. **Cloud:** the request log holds one
`listTeam` call on `listteam-00003-qon` at 20:22:51 — `OPTIONS` 204, then
`POST` **200** — which means that call passed App Check, sign-in and the
company-administrator check. The screenshot and the log entry are two
separate pieces of evidence: the screenshot does not prove that it shows the
response to that exact request, and the log does not identify the caller.

**Accepted** by architect decision on the evidence above.

**Not tested — do not round up.**

- *(At the deploy.)* No membership-changing call had run on the new
  revisions in production. **Closed later the same day:** the controlled
  deactivation regression PASSED (next section). `changeMemberRole`,
  `resendInvitation` and `revokeInvitation` remain unexercised on the new
  revisions in production.
- Sign-in and company authorisation were verified in the deployed **source**
  and by one successful administrator call, not by probing each refusal path
  in production; production callables cannot be scripted past App Check.
- The request-priority behaviour itself (override of a periodic priority,
  pre-emption) cannot occur while the interval is `0` and has never run in
  production.

**Observations, unchanged by this deploy.** The uploaded source archive
includes `test/`, `scripts/` and the two committed, non-secret
`.env.<projectId>` files (`firebase.json` does not ignore them). No secret is
among them. `acceptInvitation` lacks the platform-set
`FUNCTION_SIGNATURE_TYPE` variable the other seven carry, as it did before.
Neither was changed here.

**Rollback (not exercised).** There is no one-click Functions rollback.
Redeploy the eight callables from the ADR-74 source (`main` `a70bd45`) with
the same eight-function command — correct only while the interval is `0`,
which is the state today. The `-00002-*` revisions are still retained in
Cloud Run, but moving traffic to them by hand has not been rehearsed and
leaves the Firebase CLI's view out of step — redeploy instead. No data needs
reverting: the new fields are additive and the ADR-74 code ignores them.
`TEAM_MANAGEMENT_ENABLED=false` plus a redeploy remains the kill switch.

### Deactivation regression record — 16 November 2026 (PASSED)

The acceptance gate that had to pass before any non-zero interval. Product
Owner, development tenant, test member and disposable test PDF only, on
explicit authorisation; verified read-only in the backend (request logs,
worker log, audit trail, company state, object version counters — never a
token value). Times UTC. Step-by-step record: TESTING.md §55. **Do not
repeat it for activation.**

| Time | Evidence | Source |
|---|---|---|
| 22:58:30 – 22:59:15 | Test member re-invited and accepted: `createInvitation`, `previewInvitation`, `acceptInvitation`, each HTTP 200 on a `-00003-*` revision | Cloud |
| 23:09 | A legacy URL to the test PDF opened | Reported |
| 23:12:48 | `deactivateMember` HTTP 200 on `deactivatemember-00003-qey` | Cloud |
| 23:12:49 | `member.deactivated` + `file_links.revocation_requested` (one transaction), then `member.auth_synced`; state: sequence 3 → **4**, `requestPriority: urgent`, `queuedAt` | Cloud |
| 23:13:02 | `processfilelinkrevocations-00002-had`: sequence 4 **complete — 5 scanned, 1 page, 1 token removed, 0 failed**; `file_links.revoked` (source `worker`); queue **0** | Cloud |
| afterwards | Old URL **HTTP 403**; the PDF still opens in the app for an authorised user | Reported |
| afterwards | Both administrators active; test member deactivated; no cursor document; no periodic reconciliation; interval `0` | Cloud |

Read again at 23:51: state 4 / 4, queue 0, the test PDF's metageneration
unchanged since the sweep (no token re-created by the 403 check or the
in-app open). **Not shown:** pre-emption of a periodic sweep (impossible at
interval `0`; emulator evidence only).

### Billing interruption — 12–13 November 2026

**Reported by the Product Owner, not visible in the logs:** the project was
moved from the Blaze plan to Spark after a linked Google Cloud free trial
ended, and a cofounder restored Blaze.

**Observed in production (read-only, 13 November):**

- The last scheduled attempt before the gap started at 12 November 10:10:03.
  At 10:13:41 Cloud Run logged *Billing disabled. Shutting down instance.*
  for the worker.
- **No attempt was recorded from 12 November 10:10 to 13 November 03:15 —
  about 17 hours, roughly 1,020 one-minute runs.** They were missed, not
  failed: Cloud Scheduler made none, so there is no failed run in any log.
- The worker and its Scheduler job both show an update at 13 November
  03:14:48, with the revision unchanged; the first attempt followed at
  03:15:04. The cause of that update was not confirmed.
- From then on every run returned HTTP 200. No worker sweep was logged
  during recovery, and a count-only query found no queue marker.
- Billing reads as enabled; Functions, Run, Scheduler, Build, Artifact
  Registry, Secret Manager, Firestore and Storage APIs are enabled; the
  worker account, its roles and the bucket binding were intact.

**Not established — do not round up.** Whether the callables, Hosting,
Firestore or Storage were available to users during the gap. No callable
request at all was logged between 12 November 07:00 and 16 November 02:27,
so the logs show neither a failure nor a success. A deactivation needs the
callable; had one succeeded during the gap its request would have waited
until 13 November 03:15. None is evidenced.

**No recovery action was needed** beyond restoring billing. Nothing was
redeployed for it.

**Open operational risks — states corrected on 17 November 2026 after the
monitoring release; each item still open is a cloud or administrator action
needing its own approval:**

| Risk | State |
|---|---|
| Billing-account continuity | The project must sit on a paid account that cannot lapse with a trial. Confirmation by the account owner is not recorded here |
| Billing alerts | A budget alert is called for in *Product Owner setup* above; whether one exists was not checked (billing settings were deliberately not read) |
| Missing-run monitoring | None existed during this outage. **Created 16 November 2026:** policy A (*DC46-C monitoring readiness* → *Monitoring release record*). A stopped worker still produces no error; policy A watches for the missing successes and has never fired on a real absence. Replayed over this outage its query shows the 17-hour gap in the data; **whether it would have sent a notification while billing was disabled is unknown** |
| Incident detection and response | This interruption was noticed by people, not by a signal. A runbook now exists (*DC46-C monitoring readiness* → *Alert response runbook* and *Billing-incident response*); it has not been exercised on a real incident |

**What changes on deploy.** The existing worker `processFileLinkRevocations`
gains: periodic planning (off while the interval is `0`), urgent-before-routine
ordering with time slices, recovery rules for interrupted sweeps, and
`concurrency: 1`. The eight callables' behaviour is unchanged, though the
shared library file they import is, so a full Functions deploy rolls them
(they were rolled on their own on 16 November 2026 — *Callable release
record* above).

**Required configuration** — `frontend/functions/.env.constrapp-69b5d`:

| Parameter | Value | Meaning |
|---|---|---|
| `FILE_LINK_RECONCILE_INTERVAL_HOURS` | `0` (committed) | Off. No planning, no cursor read or write, no periodic request |
| | `1`–`168` | A company is swept again once its last successful sweep started that many hours ago. **Selected for activation: `2`** (architect, 17 November 2026; first proposed `24`). **`1` is valid but rejected** — see *Activation runbook* → *Why 2 hours, not 1* |
| | anything else | **Invalid.** The predeploy tests fail (`functions/test/fileLinks.test.js` → *DEPLOY GUARD*). If it reached production anyway, the worker would still do its revocation work, keep reconciliation off, and fail every run with an error naming the setting |

The line must be present: a non-interactive deploy refuses a parameter with no
dotenv value, defaults included. All other parameters are unchanged.

**Order — each step separately authorised.**

1. **Read-only pre-check — DONE 13 November 2026.** Record the worker's
   concurrency and the Scheduler job's attempt deadline
   (`gcloud run services describe processfilelinkrevocations` and
   `gcloud scheduler jobs describe firebase-schedule-processFileLinkRevocations-australia-southeast1`,
   both in `australia-southeast1`). Read: concurrency 80, deadline 300 s.
2. **Worker only, interval `0` — DONE 13 November 2026; accepted 16 November
   (release record above)** —
   `firebase deploy --only functions:team:processFileLinkRevocations --project constrapp-69b5d`.
   Verify: one Scheduler job, still every minute; the service now shows
   concurrency 1 and max instances 1; same runtime account; runs succeed and
   are silent; no `system/fileLinkReconciliation` document; queue empty.
   TESTING.md §53 steps 2–3.
3. **The eight callables — DONE and accepted 16 November 2026 (*Callable
   release record* above).** First written as
   `firebase deploy --only functions --project constrapp-69b5d`; carried out
   as a deploy of the eight callables by name, so that the worker was not
   redeployed. The callables now run the same library source as `main`.
   **It was not needed while the interval is `0`; it was required before
   step 4** — the ADR-74 callable build did not write the request priority,
   which matters once a periodic request has existed (*DC46-C monitoring
   readiness* → *Dependency on the all-Functions deploy*). Verified: each
   callable answers 401 without an App Check token; the worker's revision is
   unchanged. The deactivation regression on the new revisions **PASSED**
   later the same day (*Deactivation regression record* above).
4. **Activation — PERFORMED at `2` on 17 November 2026 19:16 UTC, on explicit
   authorisation (the remainder of this item is the plan as written before
   it).** Done: step 3; the deactivation regression
   (above); policies A and B. Still open: billing administration (*Billing
   continuity* below); policy C creation; the reviewed activation commit;
   the activation authorisation itself. **One deploy at the selected value**
   replaces the "short interval, then the approved value" sequence first
   written here — the first planning pass sweeps every due company within
   about two minutes whatever the interval, so nothing is gained by a short
   one. Procedure: *Activation runbook* below; acceptance: TESTING.md §56.

**Rollback — none of these loses a queued request.**

| Situation | Action |
|---|---|
| Stop periodic reconciliation | Set the interval to `0`, redeploy the worker. Requests already queued are still swept once; no new ones are written. The cursor document is left in place and ignored |
| Stop the worker entirely | `FILE_LINK_REVOCATION_ENABLED=false`, redeploy. Membership changes keep queuing |
| Revert the code | Redeploy the ADR-74 worker from source (`main` `a70bd45`, the same worker-only command). It ignores the new fields, serves markers in path order and sweeps a queued periodic request as an ordinary one (audited `file_links.revoked`). Concurrency returns to 80; remove `concurrency` only this way. The earlier revision `processfilelinkrevocations-00001-cep` is still retained in Cloud Run, but moving traffic to it by hand has not been rehearsed and leaves the Firebase CLI's view out of step — redeploy instead |

The Hosting rollback floor is unchanged (the ADR-73 build).

**Measured versus unmeasured.** Measured in production: one
membership-triggered sweep of five objects on the Stage 1 revision, and idle
runs. Nothing about periodic reconciliation. Automated
evidence is emulator-only (TESTING.md §53). The time budgets — 240 s run,
195 s urgent phase when routine work waits, 45 s routine share, 60 s and 30 s
slices, no page after 255 s — are design values inside the 300 s timeout, not
observed latencies. Do not quote a revocation or reconciliation time.

**Operational signals (Cloud Logging).**

| Log message | Level | Meaning |
|---|---|---|
| `file-links: worker run` | info | Counts by action, urgent and periodic totals, at most 25 results |
| `file-links: reconciliation plan complete` | info | The planning heartbeat, about hourly while switched on. **Its absence means planning has stopped** |
| `file-links: reconciliation overdue…` | error | Companies two intervals without a successful sweep |
| `file-links: sweep incomplete…` | warn, then error from the third | As in ADR-74 |
| `file-links: urgent work used the whole run…` | warn | Routine work was skipped for one run |
| `file-links: reconciliation cursor unreadable…` | error | The cursor was corrupted and reset |
| `file-links: FILE_LINK_RECONCILE_INTERVAL_HOURS is set but…` | error, and the run fails | The interval is invalid; reconciliation is not running |
| `file-links: reconciliation planning paused; periodic queue is full` | info | 200 periodic requests are queued; planning resumes when they drain |

Alert policies A and B were created on 16 November 2026 (next section).
Policy B notifies on the error-level lines above; nothing notifies on the
info or warn lines. **None of these signals fires when the worker is not
running at all** — policy A watches for that, within the limits stated in the
next section; see also *Billing interruption* above.

### Activation runbook — 2-hour interval (PREPARED 17 November 2026; EXECUTED 17 November 2026 19:16 UTC)

**Executed once, on 17 November 2026:** policy C created (last changed 18:42 UTC), the
activation commit `c1a45ee` merged as `main` `2b3ba9a`, the worker deployed
alone at 19:16 UTC → revision `processfilelinkrevocations-00003-ceg`; first
planning pass 19:17:02 (the one predicted overdue line), first periodic
sweep 19:18:02, second 22:19:02, third 18 November 00:21:02 — all complete,
zero failures. The runbook is kept as the procedure for a future interval
change or rollback; revision names inside it are those expected on the day
it was written. Each step that changes production needs
explicit authorisation. Commands assume the repository root unless a step
says `frontend/`. Times UTC. Acceptance checklist: TESTING.md §56.

#### Why 2 hours, not 1

Planning runs **once an hour** (`PLAN_EVERY_MS`), and a company planned in
one invocation is swept on the **next** (each invocation reads its queue
before it plans). So a sweep starts about a minute after the pass that
requested it, and the company becomes due again a little after a later
pass. With **2 hours** each company is swept about every 2 or 3 hours
(simulated on the real code: 121–183 minutes, never near the 4-hour overdue
bound; with an injected failure, 213 minutes). With **1 hour** — equal to
the planning period — sub-second Scheduler jitter decides between a ~1-hour
and a ~2-hour gap, and a gap just over 2 hours is a **false overdue**: an
audit event, an error line and a policy B email with nothing wrong
(reproduced by the same suite, TESTING.md §56). A token's life without a
membership change at `2` is therefore about **3 hours plus queue and sweep
time** — a bound, never a guarantee, longer whenever a sweep is incomplete
or the worker is stopped.

#### What changes, and what does not

- **Changes:** one environment value on the worker service
  `processfilelinkrevocations`, through a worker-only deploy. The Functions
  source is unchanged since Stage 1 (`1702216`), so the new revision differs
  from `-00002-had` only in `FILE_LINK_RECONCILE_INTERVAL_HOURS`.
- **Unchanged:** the eight callables (not deployed — they do not read the
  value), the Scheduler job, IAM, Rules, Hosting, data.
- **Cost:** about 1,440 more Firestore reads a day (one cursor read per
  invocation while the interval is above `0`), about 24 planning passes, a
  sweep of the one company every 2–3 hours (1 Storage list call each, one
  update per token found). ADR-75 → cost table.

#### A. Preconditions (record each)

1. Billing administration confirmed by the billing-account administrator:
   owner, a backup administrator, a budget and its notification recipients
   (*Billing continuity* below). A paid account alone is not this.
2. Policy C metric and policy created and verified (*DC46-C monitoring
   readiness* → *Policy C*).
3. Both alert recipients told: **one** policy B email ("reconciliation
   overdue") is expected within minutes of activation — *First-pass overdue*
   below.
4. The rollback checkpoint captured and verified (C2 below) and written
   into the release record.
5. Explicit activation authorisation.

#### B. The reviewed activation commit (branch → PR → review → merge)

Exactly two files, nothing else:

| File | Change |
|---|---|
| `frontend/functions/.env.constrapp-69b5d` | `FILE_LINK_RECONCILE_INTERVAL_HOURS=0` → `FILE_LINK_RECONCILE_INTERVAL_HOURS=2`; the comment above it records the authorisation |
| `frontend/functions/test/fileLinks.test.js` | *DEPLOY GUARD*: `toContain('FILE_LINK_RECONCILE_INTERVAL_HOURS=0')` → `toContain('FILE_LINK_RECONCILE_INTERVAL_HOURS=2')`, with its comment |

`frontend/functions/.env.constrapp-rules-test` stays `0`. Without the second
change the deploy's own predeploy test refuses the first.

```
git switch main && git pull --ff-only
git switch -c release/dc46-c-activate-2h
# edit the two files
git diff --stat            # exactly the two files above
git diff --check
npm --prefix frontend/functions run lint && npm --prefix frontend/functions test
```

#### C. CI validation

Azure Pipelines green on the pull request and again on `main` after the
merge. Record the merged activation commit:

```
git switch main && git pull --ff-only
export ACTIVATION_SHA=$(git rev-parse HEAD)        # the commit to be deployed
git log -1 --format='%H %s' "$ACTIVATION_SHA"
```

#### C2. Capture and verify the rollback checkpoint (before any deploy)

The rollback source is chosen **explicitly**, by its full SHA, and written
into the release record **before** the activation deploy. Never derive it at
rollback time from `HEAD^1`, a branch name or "the previous commit": a
squash, a fast-forward or later commits on `main` all change what those
point at.

**The rollback checkpoint** is the last known-good production source with
interval `0`: a commit on `main` whose `frontend/functions` tree is identical
to the activation commit's in every file except the two the activation
changes — so a rollback deploy changes only the interval. Normally that is
the `main` commit the activation branch was cut from (at the time of
writing, `c64c3e932404dcd9f39cebd9bc1be1b3d20a75d5`, which also carries this
runbook once merged — re-confirm, never assume).

```
export ROLLBACK_SHA=<full 40-character SHA>        # recorded in the release record
git cat-file -e "$ROLLBACK_SHA^{commit}" && echo exists
git merge-base --is-ancestor "$ROLLBACK_SHA" "$ACTIVATION_SHA" && echo ancestor-of-activation
# 1. Production configuration in that commit reads 0, and its deploy guard expects 0
git show "$ROLLBACK_SHA":frontend/functions/.env.constrapp-69b5d | grep -x 'FILE_LINK_RECONCILE_INTERVAL_HOURS=0'
git show "$ROLLBACK_SHA":frontend/functions/test/fileLinks.test.js | grep -F "toContain('FILE_LINK_RECONCILE_INTERVAL_HOURS=0')"
# 2. Against the activation commit, ONLY the two activation files differ under frontend/functions …
git diff --name-only "$ROLLBACK_SHA" "$ACTIVATION_SHA" -- frontend/functions
#    expected exactly: frontend/functions/.env.constrapp-69b5d
#                      frontend/functions/test/fileLinks.test.js
# 3. … and in the env file only the interval line
git diff -U0 "$ROLLBACK_SHA" "$ACTIVATION_SHA" -- frontend/functions/.env.constrapp-69b5d | grep '^[-+][A-Z]'
#    expected exactly: -FILE_LINK_RECONCILE_INTERVAL_HOURS=0
#                      +FILE_LINK_RECONCILE_INTERVAL_HOURS=2
# 4. The checkpoint's environment matches what production runs NOW (interval 0)
git show "$ROLLBACK_SHA":frontend/functions/.env.constrapp-69b5d | grep -E '^[A-Z_]+=' | sort
gcloud run services describe processfilelinkrevocations --region australia-southeast1 --project constrapp-69b5d \
  --format='value(spec.template.spec.containers[0].env)'
#    every key in the file has the same value on the serving revision
#    (dotenv quotes are not part of a value: EMAIL_FROM="Constrap <…>" is served unquoted)
#    (STORAGE_BUCKET empty; the platform adds FIREBASE_CONFIG, GCLOUD_PROJECT, FUNCTION_*, …)
```

Any unexpected output: **stop** — do not activate until a valid checkpoint is
recorded. Record in the release record: `ROLLBACK_SHA`, `ACTIVATION_SHA`, the
serving worker revision before the deploy (`-00002-had` at the time of
writing), and the outputs of checks 1–4.

#### D. Final checks, then the worker-only deploy

Read-only, immediately before:

```
git status --short --branch                         # clean, equal to origin/main
grep '^FILE_LINK_RECONCILE_INTERVAL_HOURS=' frontend/functions/.env.constrapp-69b5d   # =2
firebase --version                                  # record it
gcloud billing projects describe constrapp-69b5d --format='value(billingEnabled)'     # True
gcloud run services describe processfilelinkrevocations --region australia-southeast1 --project constrapp-69b5d \
  --format='value(status.latestReadyRevisionName,spec.template.spec.containerConcurrency)'   # -00002-had  1
gcloud scheduler jobs describe firebase-schedule-processFileLinkRevocations-australia-southeast1 \
  --location australia-southeast1 --project constrapp-69b5d --format='value(state,schedule)'  # ENABLED  every 1 minutes
gcloud monitoring policies list --project constrapp-69b5d --format='value(displayName,enabled)'  # A, B and C, all True
gcloud logging metrics describe dc46_reconciliation_plan_complete --project constrapp-69b5d
```

and the queue count is `0` (the count-only aggregation used in the
deactivation preflight). Note the last successful sweep's start
(`completedPassStartedAt` on `companies/{id}/system/fileLinkRevocation`) —
it decides whether the first-pass overdue email comes.

The deploy, from `frontend/`, interactively (not `--non-interactive`):

```
firebase deploy --only functions:team:processFileLinkRevocations --project constrapp-69b5d
```

The predeploy hook runs the Functions lint and pure tests, including the
DEPLOY GUARD. **Never `--only functions`**: that would also roll the eight
callables.

Immediately after (read-only): a new revision `processfilelinkrevocations-00003-*`
Ready with 100 % of traffic; `FILE_LINK_RECONCILE_INTERVAL_HOURS=2`,
`FILE_LINK_REVOCATION_ENABLED=true`; concurrency 1, max instances 1, 300 s,
runtime account `file-link-worker@`; the eight callables still on their
`-00003-*` revisions; Scheduler unchanged; request log 200 each minute.

#### E. First periodic sweep (expected within about three minutes)

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="processfilelinkrevocations" AND jsonPayload.message:"file-links:"' \
  --project constrapp-69b5d --freshness=30m --format='value(timestamp,severity,jsonPayload.message)'
```

| Invocation | Expected |
|---|---|
| First after the deploy | `file-links: reconciliation plan complete` — `passSeq: 1`, `examined: 1`, `requested: 1`; the cursor document `system/fileLinkReconciliation` now exists |
| The same minute | **Expected once:** `file-links: reconciliation overdue…` (ERROR, `companies: 1`) if the last successful sweep started more than 4 hours earlier — see *First-pass overdue* |
| The next | `file-links: worker run` with `periodic: 1`, action `complete` |
| State document after it | `completedSeq` one higher; `requestReason: periodic`; `lastPass.priority: periodic`, `complete: true`, `failed: 0`; no `overdueSince`; queue count 0 |
| Audit | `file_links.reconciliation_overdue` (the expected one, if it fired); `file_links.reconciled` only if a token was found; no `file_links.revoked` |

With the optional planted token (TESTING.md §56 step 3): `removed: 1`, the
object's metageneration one higher, the old URL **403**, the PDF still opens
in the app. Read version counters only — never the token.

#### First-pass overdue — expected once, and how to tell it from a failure

The first planning pass measures each company from its last successful
sweep. Production's last one (the deactivation regression) started
**16 November 2026 23:13:02 UTC**. Activating more than **4 hours** (two
intervals) after the last successful sweep — certain after 17 November
03:13 UTC unless another membership change sweeps the tenant — makes pass 1
count the company overdue: one ERROR line, one
`file_links.reconciliation_overdue` audit event, `overdueSince` set, and
**one policy B email** (rate-limited to one an hour). It is cleared by the
periodic sweep one minute later. Simulated: TESTING.md §56, *First pass at
activation*.

| Expected (initial) | A real failure |
|---|---|
| Only in the invocation that logs `passSeq: 1` | In any pass with `passSeq` 2 or more |
| The audit's `lastSuccessfulSweepStartedAt` is BEFORE the deploy | It is AFTER the deploy |
| `consecutiveIncomplete: 0` in the audit | Above 0; `sweep incomplete` or `sweep interrupted` lines nearby |
| `overdueSince` gone after the next invocation; pass 2 reports `overdue: 0` | `overdueSince` stays; error lines repeat each hour |

If the initial one appears, note its time in the release record and
acknowledge the policy B incident; nothing else is needed.

#### F. Planning heartbeat and the second sweep

Over the first 3 hours (read-only):

- `reconciliation plan complete` about every 60–61 minutes, `passSeq`
  rising by one, `overdue: 0` from pass 2.
- The policy C metric has points:
  ```
  curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    "https://monitoring.googleapis.com/v3/projects/constrapp-69b5d/timeSeries?filter=metric.type%3D%22logging.googleapis.com%2Fuser%2Fdc46_reconciliation_plan_complete%22&interval.startTime=<start>&interval.endTime=<end>"
  ```
- No open policy C incident (`projects/constrapp-69b5d/alerts`, as used for
  the delivery test).
- A **second** periodic sweep 2–3 hours after the first: `completedSeq` up
  by one, `completedPassStartedAt` advanced by 121–183 minutes, no overdue.

Record the result as the activation release record, then update
TESTING.md §56, ADR-75, SECURITY.md item 46, ROADMAP.md and the handover.

#### G. Rollback to interval 0 (the callables are not touched)

Rollback uses **only** the `ROLLBACK_SHA` recorded and verified in C2 — never
`HEAD^1` or whatever `main` holds at the time. It deploys from an isolated
worktree so the normal working copy and `main` are untouched.

1. **Re-verify the checkpoint** (read-only) — C2 checks 1–3 again, with the
   recorded `ROLLBACK_SHA` and `ACTIVATION_SHA`. If `main` has gained any
   change under `frontend/functions` since the activation, check 2 must
   still list only the two activation files **between the checkpoint and the
   source now in production**; if it does not, do not roll back from the
   checkpoint — prepare a reviewed commit that sets the interval and its pin
   back to `0` on top of current `main` and deploy that instead.
2. **Isolated worktree at exactly that commit:**
   ```
   git worktree add --detach ../constrapp-rollback "$ROLLBACK_SHA"
   git -C ../constrapp-rollback rev-parse HEAD                 # must equal $ROLLBACK_SHA
   git -C ../constrapp-rollback status --short                 # must be empty
   grep -x 'FILE_LINK_RECONCILE_INTERVAL_HOURS=0' ../constrapp-rollback/frontend/functions/.env.constrapp-69b5d
   npm --prefix ../constrapp-rollback/frontend/functions ci
   ```
3. **Redeploy the worker only**, from the worktree's `frontend/`,
   interactively:
   ```
   cd ../constrapp-rollback/frontend
   firebase deploy --only functions:team:processFileLinkRevocations --project constrapp-69b5d
   ```
   The predeploy DEPLOY GUARD in that tree expects `0`, so a wrong
   checkpoint is refused. Never `--only functions`.
4. **Verify** (read-only): a new worker revision, Ready, 100 % of traffic,
   `FILE_LINK_RECONCILE_INTERVAL_HOURS=0`, every other environment value as
   in C2 check 4, concurrency 1; the eight callables still on their
   `-00003-*` revisions; runs return 200; no `reconciliation plan complete`
   after the new revision; the queue drains to 0.
5. **Disable policy C** — without heartbeats it would fire about 3 hours
   later:
   ```
   gcloud monitoring policies list --project constrapp-69b5d \
     --filter='displayName="DC46 file-link worker: reconciliation planning stopped for 3 hours"' --format='value(name)'
   gcloud monitoring policies update <that name> --no-enabled --project constrapp-69b5d
   ```
6. **Clean up:** `cd -` back to the repository, then
   `git worktree remove ../constrapp-rollback`.
7. **Reconcile `main` with production** through the normal reviewed change
   process: a branch reverting the activation commit (the two files back to
   `0`), pull request, architect review, Azure CI green, merge. Until it is
   merged, `main` says `2` while production runs `0` — record that gap and
   its end in the release record, and do not deploy the worker from `main`
   in between.

- The eight callables keep their `-00003-*` revisions throughout. **Never
  roll them back to the ADR-74 build once a periodic request has existed**
  (*Dependency on the all-Functions deploy*).
- Nothing is lost: a periodic request already queued is swept once; the
  cursor document stays and is ignored at `0`; membership revocation is
  unaffected.
- Faster, unrehearsed alternatives — changing the variable with
  `gcloud run services update`, or moving traffic to the previous revision —
  put the service out of step with the Firebase CLI. Emergency use only,
  then redeploy as above.

#### H. Incident response after activation

| Signal | Meaning | Action |
|---|---|---|
| Policy A | Worker not running | As before (*Alert response runbook*); periodic and urgent work both wait |
| Policy B — `reconciliation overdue` on pass 2+ | A company two intervals without a successful sweep | Read its state (`lastPass`, `consecutiveIncomplete`, `nextAttemptAt`); treat as an incomplete sweep |
| Policy B — `sweep incomplete` / `interrupted` | Storage or Firestore failures | As before; five consecutive failures close the sweep and back off |
| Policy C | Planning stopped while the worker may still run | Its runbook: interval, planning errors, cursor |
| Tokens keep reappearing on the same objects | Something mints them between sweeps | Record object names and times only (never values); compare with console use; the cause is unproven |
| Any doubt about the periodic path | — | Roll back (G). Membership revocation continues |

## DC46-C Stages 2 and 3 — release runbook (PREPARED 18 November 2026 NZ; EXECUTED 17 November 2026 UTC — LIVE)

> **Release record.** Merged as `main` `5fb96da`. Step 1, Firestore Rules:
> 17 November 2026 20:47:22 UTC (ruleset `e7e70179…`, 242,127 bytes,
> byte-identical to `main`). Step 2, the eight callables only: 20:49 UTC,
> revisions `-00004-*`; worker not redeployed. Step 3, Hosting: 20:49:46 UTC
> (version `b06f4fd51469cf97`). Production acceptance on a disposable
> subcontractor: 18 November 2026, PASSED (TESTING.md §59). The runbook
> below is kept as written before the release.

Source: branch `feature/dc46-visibility-external-removal` (ADR-75 → *Stages 2
and 3 — as implemented*). As written before the release: each step needed its
own authorisation, after architect review, Git integration and a green CI
run on `main`. **The worker is never redeployed and
`FILE_LINK_RECONCILE_INTERVAL_HOURS` stays `2`** — no step touches
`.env.constrapp-69b5d`, IAM, Scheduler or monitoring.

Record before step 1 (read-only): the commit being released (`RELEASE_SHA`),
the commit currently live for Functions and Hosting (`2b3ba9a` unless
something has been released since), and the published Firestore ruleset
(identical to `main` `2b3ba9a`'s `firestore.rules`, 241,924 bytes, last
published 3 November 2026 — verified read-only 17 November 2026).

**Step 1 — Firestore Rules only.**

```
cd frontend
npm run rules:transitional:check
firebase deploy --only firestore:rules --project constrapp-69b5d
```

The FINAL file through the normal `firebase.json` — the transitional copy is
regenerated for consistency only and is not published. Verify the published
source reads **242,127 bytes**. *Compatibility:* the live Hosting bundle
never writes `visibility` on an update (`updateDocument` has no caller), so
no screen changes; the live callables do not touch project documents.
*Rollback:* from a worktree at `2b3ba9a`, the same command republishes the
previous ruleset. Safe at any time — it only re-opens the client reduction.

**Step 2 — the eight team callables only.**

```
firebase deploy --only functions:team:listTeam,functions:team:createInvitation,functions:team:resendInvitation,functions:team:revokeInvitation,functions:team:previewInvitation,functions:team:acceptInvitation,functions:team:changeMemberRole,functions:team:deactivateMember --project constrapp-69b5d
```

Never `--only functions` (that would redeploy the worker). The predeploy
hook runs lint and the pure suite, including the DEPLOY GUARD that requires
the production interval to read `2`. *Compatibility:* with the previous
Hosting bundle still live, no external row offers *Deactivate*, so the
widened guard is simply unused; acceptance clearing two presentation fields
needs no client change; the Rules of step 1 are unrelated to the callables.
Verify read-only: eight new revisions ACTIVE at 100 %, the worker revision
unchanged (`processfilelinkrevocations-00003-ceg`), HTTP 401 without App
Check, configuration and secret binding unchanged. *Rollback:* the same
command from a worktree at `2b3ba9a`. A removal already completed stays
completed; it is reversed by operator re-provisioning.

**Step 3 — Hosting only.**

```
npm run build
firebase deploy --only hosting --project constrapp-69b5d
```

*Compatibility:* requires step 2 — deployed first, the button would appear
and the old callable would answer `unsupported-target` (a friendly refusal,
nothing written). *Rollback:* redeploy the previous build from a worktree at
`2b3ba9a`; roll Hosting back **before** the callables if both are reverted.
The Hosting rollback floor (the ADR-73 build) is unchanged.

**Minimal production acceptance** — TESTING.md §57, production checks.
Stage 3 needs a disposable external test member, which only an operator can
provision; that provisioning is a production data change and needs its own
approval.

**Operator procedure — correcting a document's visibility.** No app path can
reduce visibility after step 1. An authorised operator sets `visibility` to
`internal` on the document (console or Admin SDK), then runs
`functions/scripts/revoke-file-links.mjs` for that company so links copied
while the document was `project` do not wait for the next periodic sweep.
Record who asked, who acted and when. Withdrawing the document is not a
substitute for a visibility change: since the external document access
correction (live 17 November 2026) withdrawal removes external rules-checked
access, but it also ends the document's active life for everyone and still
leaves any copied link working until the next sweep.

## DC46 — external document access correction (PREPARED 18 November 2026 NZ; EXECUTED 17 November 2026 UTC — LIVE)

> **Release record.** Merged as `main` `0225b03`. Step 1: Storage ruleset
> `8b8edc14-be46-4922-9b13-ca4af79d9f29` released 17 November 2026 22:14:53
> UTC (9,271 bytes) and Firestore ruleset
> `12278725-ba8d-4982-9e57-e971ba5fa32d` released 22:14:56 UTC (242,163
> bytes), both byte-identical to `main`. Step 2: Hosting version
> `b70a1504ff327671` released 22:15:30 UTC, all eight build files
> byte-identical to a build of `main` on both origins. No Functions
> deployment. Production acceptance: 18 November 2026, PASSED (TESTING.md
> §59). The runbook below is kept as written before the release.

Source: branch `fix/dc46-external-document-access` (ADR-75 → *External
document access follows status*). As written before the release: each step
needed its own authorisation, after architect review, Git integration and a green CI
run on `main`. **No Functions deployment.** The worker, the eight callables,
`.env.constrapp-69b5d` (`FILE_LINK_RECONCILE_INTERVAL_HOURS=2`), IAM,
Scheduler and monitoring are not touched. All commands run from `frontend/`.

**Before step 1.** Confirm the published Firestore ruleset is still
byte-identical to `main` before this change (242,127 bytes) and the Storage
ruleset to 8,674 bytes (*Verifying which rules are published*); run
`npm run test:unit`, `npm run test:rules`, `npm run lint`, `npm run build`
and `npm run rules:transitional:check` on the commit being released.

**Step 1 — Firestore Rules and Storage Rules, together.**

```
firebase deploy --only firestore:rules,storage --project constrapp-69b5d
```

This publishes the FINAL `firestore.rules` (242,163 bytes) — not the
transitional file — and `storage.rules` (9,271 bytes). Verify both published
rulesets byte-for-byte afterwards.

*Compatibility with the bundle then live:* internal roles are unaffected in
every workflow (their read branch and their unfiltered query are unchanged;
no write rule changed). A non-internal user on the previous bundle gets
"Documents are unavailable" on the Documents tab, because that bundle's query
filters on visibility only and the new rule refuses it — **fail-closed**, and
it ends with step 2. Production had no non-internal user when this was
prepared (count-only read, 17 November 2026 21:20 UTC); re-check before
publishing. *Rollback (independent):* from a worktree at the pre-change
commit (`5fb96da`), run the same command. The new bundle keeps working
against the old rules (its narrower query satisfies them).

**Step 2 — Hosting only.**

```
npm run build
firebase deploy --only hosting --project constrapp-69b5d
```

*Compatibility:* the new bundle works against either ruleset. *Rollback
(independent):* redeploy the previous build from a worktree at `5fb96da`
(`firebase hosting:rollback` is not a CLI command; the console's release
history can also restore the previous release). Rolling Hosting back while
the new rules stay published returns non-internal users to the fail-closed
"unavailable" state — roll the rules back first if both are being reverted.
The Hosting rollback floor (the ADR-73 build) is unchanged.

**What this release does not do.** It revokes no link: a download-token URL
copied while a document was active works until the periodic sweep removes
the token. It does not bind the Admin SDK or the console. It does not change
drawings.

**Minimal production acceptance** — TESTING.md §58, production checks. They
need a disposable external test member, whose provisioning is a production
data change with its own approval; until then the rule is emulator-proven
only.

## DC46 — production closure record (18 November 2026) — Deferred Control 46 CLOSED with accepted risks

The one place to read what is deployed for DC46. Detail and evidence: ADR-75
→ *DC46 closure record*; TESTING.md §59; SECURITY.md item 46. All times UTC.

| Component | Production state | Released |
|---|---|---|
| Approved release | `main` `0225b0376ec6a0b3bc132f9858c31fb1d4368bc5` | — |
| Firestore Rules | ruleset `12278725-ba8d-4982-9e57-e971ba5fa32d`, 242,163 bytes, byte-identical to `main` | 17 November 2026 22:14:56 |
| Storage Rules | ruleset `8b8edc14-be46-4922-9b13-ca4af79d9f29`, 9,271 bytes, byte-identical to `main` | 17 November 2026 22:14:53 |
| Hosting | version `b70a1504ff327671`; build files byte-identical to `main` on `app.constrap.com` and `constrapp-69b5d.web.app` | 17 November 2026 22:15:30 |
| Team callables (eight) | revisions `-00004-*` (`deactivatemember-00004-kom`, `listteam-00004-wax`, …) | 17 November 2026 20:49 |
| Worker | `processfilelinkrevocations-00003-ceg`; one instance, one request at a time, 300 s; own service account; `FILE_LINK_REVOCATION_ENABLED=true`, `FILE_LINK_RECONCILE_INTERVAL_HOURS=2` | 17 November 2026 19:16 |
| Scheduler | `firebase-schedule-processFileLinkRevocations-australia-southeast1`, enabled, every minute; every run since activation HTTP 200 | unchanged |
| Monitoring | policies A (no successful run, 15 min), B (error logged), C (planning stopped, 3 h) enabled; two email channels each; log metric `dc46_reconciliation_plan_complete` | A, B 16 November; C 17 November 2026 |
| Billing | enabled (read 18 November 2026 02:13). Ownership, a second administrator and budget alerts are NOT confirmed — a follow-up outside DC46 | — |

**Rollback checkpoints.** Worker with reconciliation off: `a2544a1`
(*Activation runbook* → rollback; disable policy C). Stage 2/3 callables and
Hosting: `2b3ba9a`. External document access correction (Rules and Hosting):
`5fb96da`. The Hosting rollback floor (the ADR-73 build) is unchanged.

**Operating it.** Alerts go to the Product Owner and the billing
administrator. An alert means: A — the worker is not running (check billing
first — *Billing interruption*); B — read the worker's ERROR line; C —
planning stopped (interval set to `0`, or the worker failing before it
plans). A visibility correction is an operator task (*Operator procedure —
correcting a document's visibility*). External members are provisioned by an
operator (an Auth account plus `users/{uid}`) and removed by a Company Admin
on the Team page.

**Not solved — accepted risks.** The application does not deliberately
expose token-based download URLs, but a Firebase Storage upload can still
create download-token metadata on the object; the reconciliation worker
removes it. Copied download links live until a sweep removes the token. The
two-hour reconciliation interval is not a strict revocation deadline: when
a sweep actually completes depends on scheduling, worker health and backlog
(typically about three hours for a change that is not a deactivation, never
immediate). Console and Admin SDK writes bypass
Rules; the November token re-creations are unattributed; every member reads
every drawing revision; monitoring shares the worker's project; Rules
headroom is 2,837 bytes. Follow-ups: ROADMAP.md → *DC46 follow-ups*.

## DC46-C monitoring readiness — POLICIES A AND B CREATED IN PRODUCTION 16 November 2026 (verified read-only; test delivery reported by both recipients; neither failure condition has fired; billing continuity NOT CONFIRMED; the callable deploy it depended on is DONE)

Prepared on `ops/dc46-c-monitoring-readiness` (merged, `5615239`) and created
in production by the Product Owner on 16 November 2026. **Two alert policies
and two email notification channels exist. No log-based metric, uptime check
or budget was created; no Function was deployed; no Rule, IAM binding or
Scheduler job was changed; periodic reconciliation stays OFF.** (That
sentence describes the monitoring release. The eight callables were
redeployed later the same day as a separate, separately approved step —
*DC46-C* → *Callable release record*.) The policies
are detection, not a control: they revoke nothing and do not replace the
worker. Any further cloud step below needs its own authorisation. Policy C
was created on 17 November 2026 (*Policy C* below). Deferred Control 46 was CLOSED on 18 November 2026 with documented accepted risks (SECURITY.md item 46);
the policies remain detection only.

| Status | Item |
|---|---|
| **CREATED — verified read-only** | Alert policies A and B (`ops/monitoring/*.policy.json`): enabled, identical to the committed files, both channels attached |
| **CREATED — verified read-only** | Two email notification channels, `DC46 - Product Owner` and `DC46 - Billing Administrator` (recipients are not in Git) |
| **RUN AND REMOVED** | The temporary delivery-test policy (`ops/monitoring/dc46-delivery-test.temporary-policy.json`): created, fired once, deleted; its incident is closed. No temporary production resource remains |
| **REPORTED by the Product Owner** | Both recipients received the test notification. Not observed: Google exposes no per-recipient delivery record that was found |
| **NOT TESTED in production** | Policy A on a real absence; anything during a billing suspension. *Corrected 25 November 2026 (C1-D):* **policy B has matched a real error line once** — the predicted first-pass `reconciliation overdue` line at activation (17 November 2026 19:17:02 UTC) opened an incident at 19:18:06 that auto-closed on 18 November 19:22:24 (*Monitoring release record* → *Policy B incident*). It was not deliberately triggered. *As written:* Policy A on a real absence; policy B on a real error line; anything during a billing suspension |
| **NOT VERIFIED — administrator action** | Billing continuity (below) |
| **CREATED 17 November 2026 (last changed 18:42 UTC), enabled** | Policy C, the planning heartbeat, and its log-based metric — `ops/monitoring/dc46-planning-heartbeat.metric.json` and `dc46-planning-heartbeat-absent.policy.json` (*Policy C* below). Created before activation; verified read-only on 17 and 18 November 2026 (enabled, two channels, metric filter identical to the file, one point per hourly pass) |
| **DONE 16 November 2026** | The callable deploy (the eight callables only; *DC46-C* → *Callable release record*) |
| **NOT AUTHORISED** | Activation of a non-zero interval |

### Monitoring release record — 16 November 2026

Project `constrapp-69b5d`; watched service `processfilelinkrevocations`,
`australia-southeast1`. All times UTC, 16 November 2026. **Cloud** means read
from the Cloud Monitoring API, the Admin Activity audit log or Cloud Logging
during read-only inspections; **Reported** means stated by the Product Owner
and not independently observed.

| Time (UTC) | Event | Evidence |
|---|---|---|
| about 09:30 | Preflight inventory: 0 alert policies, 0 notification channels, 0 log-based metrics, 0 uptime checks | Cloud |
| 17:20:55 | Channel `DC46 - Product Owner` created (email, enabled) | Cloud |
| 17:23:06 | Channel `DC46 - Billing Administrator` created (email, enabled) | Cloud |
| 18:23:12 | Policy A created — `DC46 file-link worker: no successful run for 15 minutes` (`alertPolicies/15284677036198995887`) | Cloud |
| 18:24:26 | Policy B created — `DC46 file-link worker: error logged` (`alertPolicies/11943159347055161843`) | Cloud |
| 18:26:30 | Temporary policy `TEST - DC46 delivery check - delete after use` created, with both channels attached | Cloud (audit log) |
| 18:29:30 | The test condition was met and the test incident opened | Cloud |
| not recorded | The Product Owner received the test email | Reported |
| not recorded | The billing administrator received the test email | Reported, through the Product Owner (recorded in the architect's closeout brief of 17 November 2026) |
| 18:37:51 | Temporary policy deleted | Cloud (audit log) |
| 18:38:51 | Test incident closed | Cloud |
| 18:42 | Read-back (below) | Cloud |

**Read-back at 18:42 UTC (read-only).**

- **Inventory:** exactly two alert policies and two notification channels;
  still no log-based metric or uptime check. No policy with `TEST` in its
  name. One incident in total — the test incident, state `CLOSED`.
- **Policies A and B:** both enabled and not edited since creation. For each,
  the conditions, alert strategy, severity, labels and documentation text
  read from the API are identical to the committed file. Each references
  both channels.
- **Policy A:** filter on `run.googleapis.com/request_count`, 2xx only, the
  one service and region; 60 s `ALIGN_DELTA`, `REDUCE_SUM` grouped by service
  name; absence `900s`, trigger count 1; auto-close 7 days. The series showed
  one point a minute since creation, so the initial-data-point requirement
  was met; no incident open.
- **Policy B:** the scoped log filter as in the file, no label extractors,
  `notificationRateLimit.period: 3600s`, auto-close 1 day. **The API accepted
  the one-hour rate limit**, which the documentation had left unconfirmed.
- **Channels:** both of type email, both enabled, holding two distinct
  addresses. The addresses were not printed and are not recorded anywhere in
  this repository. An email channel shows no verification status.
- **Worker unchanged:** revision `processfilelinkrevocations-00002-had`,
  Ready, 100 % of traffic, concurrency 1, max instances 1, the same worker
  account, `FILE_LINK_REVOCATION_ENABLED=true`,
  `FILE_LINK_RECONCILE_INTERVAL_HOURS=0`. Scheduler job `ENABLED`, every
  minute, last updated 13 November; 60 attempts in the preceding hour, all
  200. No error-level worker line in the preceding 26 hours. Billing reads
  as enabled.
- **Nothing else changed:** the Admin Activity audit log for the preceding
  30 hours holds only Cloud Monitoring calls — two channel creations, three
  policy creations, one policy deletion, and two
  `ProvisionPublisherServiceAccount` calls made by Monitoring during channel
  set-up. No `SetIamPolicy`, no deploy, no Scheduler change, no Rules
  release. The eight callables are on their 12 November revisions (as read
  at 18:42; they were redeployed at about 20:20 the same day); the
  Firestore ruleset release is dated 3 November.

**Delivery evidence — what is and is not shown.** The cloud shows that one
incident opened on a policy that carried both channels; it does not show
that an email arrived. Receipt by both recipients is **Reported** by the
Product Owner. Not recorded for either recipient: the arrival time and the
incident id shown in the email, which the delivery-test procedure asks for.

**Departures from the prepared procedure.**

- The channel display names use a hyphen and a capital *Administrator*
  (`DC46 - Billing Administrator`), not the em-dash form proposed below.
- The procedure deletes the test policy after both recipients confirm. The
  policy was deleted at 18:37:51; the billing administrator's receipt was
  recorded afterwards, in the closeout brief of 17 November 2026. The
  read-only verification at 18:42 had it as unverified.

**Policy B incident — 17–18 November 2026 (recorded 25 November 2026, C1-D; Cloud, read-only).**
The only incident a permanent policy has opened. At activation (*DC46-C* →
*Activation runbook* → *First-pass overdue*), worker revision
`processfilelinkrevocations-00003-ceg` wrote, at 17 November 2026
19:17:02.390 UTC, the predicted ERROR line `file-links: reconciliation
overdue; tokens in these companies are older than the bound` (stderr).
Policy B (`11943159347055161843`) opened incident `0.of4o1z1d3uvz` at
19:18:06 (Cloud Logging `monitoring.googleapis.com/ViolationOpenEventv1`,
written twice with the same violation id). It closed on 18 November 2026 at
19:22:24, by policy B's 24-hour auto-close: a log-match incident has no
recovery condition. No other error-level line from the worker exists in the
40 days read on 24 November 2026. Policy B carries both channels and,
according to the Monitoring API reference, log-based policies notify on
OPENED only, so one email per channel was due and none on closure.
**Receipt was not recorded at the time and is not established.** This shows
that policy B's filter matches a real worker error line in production and
opens an incident. It was the expected line, not a failure.

**What the deployed monitoring does not do — do not round up.**

| Limitation | Statement |
|---|---|
| Terminated or deleted resources | Policy A does not guarantee detection. Google documents that metrics of terminated or deleted resources are not considered for metric-absence policies. If the function or its Cloud Run service is deleted, assume silence |
| Billing suspension | Unverified. Whether Cloud Monitoring evaluates policies or sends email for a project without billing is not documented and was not tested. Policy A must not be described as detecting a billing interruption |
| Policy B depends on matching log lines | It notifies only when the worker's container writes a line at error level that matches the filter. A run that dies without writing one is not seen by B |
| Neither failure condition was deliberately triggered | No absence and no error line was deliberately produced in production. Policy A has never opened an incident. *Corrected 25 November 2026 (C1-D):* policy B **has** matched once, on the expected first-pass overdue line at activation (17 November 2026; *Policy B incident* below); whether its email arrived was not recorded. *As written 16 November:* "Policy A has never opened an incident; policy B has never matched. Only the email path was exercised, by a policy that fires on healthy traffic" |
| Same project | Both policies, their data and their notifications depend on `constrapp-69b5d` and on Google Cloud |
| No external monitor | An independent availability monitor hosted outside this project and its billing account does not exist. It remains future reliability work; none is designed or scoped |

The sections below are the specification, the procedure as prepared, the
runbook and the open billing actions. Where a step has now been done, its
heading says so.

### Policy A — the worker has stopped

`ops/monitoring/dc46-worker-no-successful-run.policy.json`. A metric-absence
condition: **no 2xx request to the Cloud Run service
`processfilelinkrevocations` for 15 minutes.**

| Setting | Value | How it was verified (read-only, 16 November 2026) |
|---|---|---|
| Metric | `run.googleapis.com/request_count` | Descriptor read from the project: DELTA, INT64, GA, sample period 60 s, ingest delay 120 s; labels `response_code`, `response_code_class`, `route` |
| Resource type | `cloud_run_revision` | Listed on the descriptor; the worker's live series carries it |
| Service | `resource.labels.service_name="processfilelinkrevocations"`, `location="australia-southeast1"` | The live series' own labels. A 2nd-gen function's Cloud Run service name is the function name in lower case |
| Success only | `metric.labels.response_code_class="2xx"` | The live series reads `response_code: 200`, `response_code_class: 2xx`. Unauthenticated probes of the service were answered 403 on 12 November and are not counted |
| Aggregation | 60 s `ALIGN_DELTA`, then `REDUCE_SUM` grouped by `service_name` only | The same query through `projects.timeSeries.list` returns ONE series with one point a minute. Grouping removes `revision_name`: across the 13 November deploy (`-00001-cep` → `-00002-had`) the summed series has no missing minute, so a deploy does not look like an absence |
| Absence | `duration: 900s`, trigger count 1 | API rule: minimum 120 s, whole minutes. Replayed over 12–13 November the query shows **one gap, 10:18 → 03:16, 16.97 hours** — the billing interruption |
| Auto-close | 7 days | The default |

**Limitations — policy A is a detection aid inside the project, not a
guaranteed external availability monitor.** Each point below is from Google's
documentation unless marked otherwise.

| Limitation | What it means here |
|---|---|
| **An initial data point is required** | "The monitored subsystem must write at least one data point after you create or modify the alerting policy." Until the worker has reported once after creation — and again after every later edit of the policy — the condition cannot be met. The worker reports each minute, so the blind period is minutes; it is not zero |
| **Metric reporting delay** | `request_count` is sampled every 60 s and is not visible for up to 120 s. Delayed data is treated as missing, so a Google-side delay longer than the window can open a false incident, and a long delay can put the condition in an unknown state. Detection is therefore about 17 to 20 minutes after the last success (15 minutes of absence, the alignment minute, the delay) — **an estimate, not measured** |
| **A terminated or deleted service is NOT reliably detected** | Google: metrics of TERMINATED or DELETED resources "are not considered for metric-absence policies", and no alert is generated "if the monitored resource is deleted or shut down". If the function or its Cloud Run service is deleted, **assume policy A stays silent**. A paused or deleted Scheduler job leaves the service in place, so the absence should be seen — expected from the documentation, not tested |
| **Project-level billing suspension — UNKNOWN** | On 12 November Cloud Run logged *Billing disabled. Shutting down instance.* Whether Cloud Monitoring then treats the service as shut down (no alert, per the row above), and whether it evaluates policies or sends email at all for a project without billing, is **not documented and not tested**. Replaying the query shows only that the data stopped. **Do not rely on policy A to report a billing interruption** |
| **An ignored incident goes quiet** | An open absence incident closes once no data has arrived for the auto-close period plus 24 hours — about eight days here. Nothing re-notifies after that until data returns and stops again |
| **It measures answers, not work** | A run that returns 200 counts as healthy. `FILE_LINK_REVOCATION_ENABLED=false` returns 200 with an info line and is not detected. Requests that never reach the container (unauthenticated, or refused at the instance limit) are not counted by this metric at all |
| **Same project, same provider** | The policy, its data and its email all depend on Google Cloud and on this project. A check hosted elsewhere would be needed for independence; none is proposed. It remains future reliability work |

**Why 15 minutes, and why successes.** With `concurrency: 1` a sweep longer
than a minute is expected to make the overlapping ticks fail (unmeasured,
TESTING.md §53), so failures are not a clean signal. A run ends inside 300 s,
so 15 minutes without one success is three worst-case runs. Nothing in the
documentation requires a different threshold: the API minimum is 120 s and
the maximum 23.5 hours. **The 15-minute threshold stands.**

### Policy B — the worker logged an error

`ops/monitoring/dc46-worker-error-log.policy.json`. A log-match condition on
one service's container output:

```
resource.type="cloud_run_revision"
AND resource.labels.service_name="processfilelinkrevocations"
AND resource.labels.location="australia-southeast1"
AND severity>=ERROR
AND (log_id("run.googleapis.com/stderr") OR log_id("run.googleapis.com/stdout"))
```

| Setting | Value | Why |
|---|---|---|
| Scope | The one service, container output only | The eight callables and every other resource are excluded. The platform request log is excluded on purpose: refused overlapping ticks and unauthenticated probes are recorded there |
| Label extractors | None | Nothing from a log entry is copied into a notification. The notification carries the policy's own text and a link |
| Rate limit | One notification an hour (`notificationRateLimit.period: 3600s`) | The field is required by the API for a log-match policy. Documented minimum 5 minutes; a maximum was not found in the documentation; the API accepted `3600s` when the policy was created on 16 November 2026. A stuck company retries at most hourly, so a persistent fault notifies about hourly. Google also caps a log-match policy at 20 a day |
| Auto-close | 1 day | Documented minimum 30 minutes, default 7 days |
| Conditions | One | A log-match policy can hold only one condition |

Verified read-only: the filter is accepted by Cloud Logging; over the 30 days
retained it matches **no entry**; at `severity>=INFO` the same filter returns
the three `file-links: worker run` lines of 12 and 16 November, so the
service and log names are right. The lines it will match are every
`file-links:` message logged at error level (table in *Operational signals*
above, and the policy's own runbook text) plus an uncaught exception.

**Not caught by B:** a run that dies without writing a line (timeout, out of
memory, instance killed). If that persists, policy A fires. Warn-level lines
(the first two incomplete sweeps of a company; routine work skipped for one
run) are deliberately below the threshold.

### Notification channels — recipients stay outside Git

Two **email** channels: the Product Owner, and an authorised billing
administrator. The addresses are entered at creation time and live only in
Cloud Monitoring. No policy file names a channel;
`tests/unit/monitoringPolicies.test.js` fails if one ever does.

**Created 16 November 2026** as `DC46 - Product Owner` and
`DC46 - Billing Administrator`. The display names in step 1 were the
proposal. The steps are kept for re-creation.

1. Console → Monitoring → Alerting → *Edit notification channels* → Email →
   *Add new*, once per recipient. Use the display names
   `DC46 — Product Owner` and `DC46 — Billing administrator`. (The
   `gcloud … monitoring channels` commands are beta-only; the console needs
   no extra component.) An email channel needs no verification code.
2. Read the two channel resource names — they are identifiers, not addresses:
   `curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" "https://monitoring.googleapis.com/v3/projects/constrapp-69b5d/notificationChannels?fields=notificationChannels(name,displayName,type,enabled)"`
3. Keep them in the shell only:
   `export DC46_CHANNELS="projects/constrapp-69b5d/notificationChannels/<id1>,projects/constrapp-69b5d/notificationChannels/<id2>"`

### Creation procedure — DONE 16 November 2026 (kept for re-creation; a re-run needs its own authorisation)

Both policies exist; running these commands again would create duplicates.
From the repository root, after step 3 above:

```
gcloud monitoring policies create --project constrapp-69b5d \
  --policy-from-file=ops/monitoring/dc46-worker-no-successful-run.policy.json \
  --notification-channels="$DC46_CHANNELS"
gcloud monitoring policies create --project constrapp-69b5d \
  --policy-from-file=ops/monitoring/dc46-worker-error-log.policy.json \
  --notification-channels="$DC46_CHANNELS"
```

No IAM, Rules, Functions, Hosting or Scheduler change. The worker is not
touched and cannot tell that it is being watched.

### Verification checklist — none of it stops, pauses or breaks the worker

**State on 16 November 2026 (*Monitoring release record* above).** Item 1:
passed before creation (11 tests); the files have not changed since. Items 2
and 5: verified read-only at 18:42 UTC, item 5 for the preceding hour. Item
3: read through the API about 19 minutes after creation — one point a
minute, no open incident — not on the console chart. Item 4: run and cleaned
up; receipt is reported, and the arrival times and incident id were not
recorded. The boxes are left unticked for a future re-creation.

1. - [ ] `npm run test:unit` passes (`monitoringPolicies.test.js`).
2. - [ ] `gcloud monitoring policies list --project constrapp-69b5d` shows
      policies A and B enabled, each with the two channels, and the filters
      exactly as in the files.
3. - [ ] Policy A's condition chart shows one point a minute and no open
      incident after ten minutes.
4. - [ ] The delivery test below, including its clean-up.
5. - [ ] Scheduler attempts for the whole period are still one a minute, all
      200, and the worker revision is unchanged.

### Delivery test — a temporary positive-traffic policy (RUN 16 November 2026 and removed; a repeat needs its own approval)

**Result.** Created 18:26:30 UTC with both channels; incident opened
18:29:30; policy deleted 18:37:51; incident closed 18:38:51. Both recipients'
receipt is reported by the Product Owner. Detail and evidence classes:
*Monitoring release record* above. The procedure is kept for a repeat.

**Google provides no test for an email channel.** Its documentation: Cloud
Monitoring "doesn't support a test option" for these channels; a channel is
verified "by creating an alerting policy and configuring the condition to be
met." (A *Send test notification* button exists for Slack and Pub/Sub
channels and *Test connection* for webhooks — not for email. An email
channel also has no verification code.) So one deliberate, harmless incident
is the supported way, and the only way that touches nothing in production.

| | |
|---|---|
| **File** | `ops/monitoring/dc46-delivery-test.temporary-policy.json` |
| **Scope** | One threshold condition on policy A's exact filter and aggregation: *2xx requests to `processfilelinkrevocations` above 0 for 1 minute*. It is true because the worker is healthy. It reads a metric; it calls nothing, changes nothing and cannot affect the worker, Scheduler, Firestore or Storage |
| **What it creates** | One alert policy and ONE incident, titled `TEST - DC46 delivery check - delete after use`, severity warning, whose email says it is a test and asks only for a reply |
| **Approval** | A production cloud change. Run only with explicit authorisation, at a time both recipients are expecting it |
| **Lifetime** | Minutes. Delete it in the same sitting; never leave it overnight |

1. Create — after the two channels exist and `DC46_CHANNELS` is set:
   `gcloud monitoring policies create --project constrapp-69b5d --policy-from-file=ops/monitoring/dc46-delivery-test.temporary-policy.json --notification-channels="$DC46_CHANNELS"`
   Note the policy name it prints (`projects/constrapp-69b5d/alertPolicies/<id>`).
2. Wait for the email — expect a few minutes (one minute of data, the
   reporting delay, delivery).
3. **Delivery evidence — record for each recipient:** who, the time the
   email arrived, and the incident id shown in it. A recipient who has
   received nothing after 30 minutes is a failed test: check the address on
   that channel and the spam folder, then Logs Explorer for notification
   delivery errors, before repeating.
4. Delete: `gcloud monitoring policies delete projects/constrapp-69b5d/alertPolicies/<id> --project constrapp-69b5d`
5. **Clean-up verification:** `gcloud monitoring policies list --project constrapp-69b5d --format='value(displayName)'`
   lists exactly the two DC46 policies and no `TEST` entry; the console's
   Alerting page shows no open incident for the deleted policy (close it by
   hand if it is still listed); Scheduler attempts were one a minute and all
   200 throughout.

*Proves:* both channels deliver, the recipients can read and act on the
email, and the filter and aggregation select the live series. *Does not
prove:* that an absence opens an incident, or that policy B matches.

**Limits of this validation — stated, not rounded up.**

| Not tested in production | Why | Alternative |
|---|---|---|
| Policy A firing on a real absence | It needs the worker to stop for 15 minutes | Evidence: the replay over the 12–13 November outage shows the data gap. End-to-end: in a non-production Firebase project, deploy the worker, create policy A from the same file, wait for data, pause THAT project's Scheduler job, expect the email in about 20 minutes, resume it |
| Policy B firing | It needs an error-level line from the worker | The delivery path was exercised by the delivery test (receipt reported, not observed) and the filter by the read-only replay. End-to-end in the same non-production project, with an invalid interval value there |
| Monitoring during a billing interruption | Cannot be simulated safely | See *Billing continuity* |

### Alert response runbook

**Policy A — no successful run.** Deactivated members' old links keep working
while the worker is stopped; requests queue and are not lost.

1. `gcloud billing projects describe constrapp-69b5d` — if `billingEnabled`
   is false, go to *Billing-incident response* below.
2. `gcloud scheduler jobs describe firebase-schedule-processFileLinkRevocations-australia-southeast1 --location australia-southeast1 --project constrapp-69b5d`
   — `state` must be `ENABLED` with a recent `lastAttemptTime`.
3. Logs Explorer, `resource.type="cloud_scheduler_job"`: no entries means
   Scheduler is not calling; error entries mean the worker refuses or fails.
4. `gcloud run services describe processfilelinkrevocations --region australia-southeast1 --project constrapp-69b5d`
   — latest revision Ready, 100 % of traffic, the worker account unchanged.
5. Look for a deploy, an IAM change or a paused job in the last hour.
6. After recovery: runs return 200 each minute; the queue count returns to 0;
   every `member.deactivated` audit event in the gap is followed by a
   `file_links.revoked`. Record the gap and its cause in this file.

**Policy B — error logged.** The notification does not contain the line. Open
the logs with the filter above and use the table in the policy text
(`ops/monitoring/dc46-worker-error-log.policy.json`) — one row per message,
with the action. For a company that stays incomplete, read
`companies/{id}/system/fileLinkRevocation` (`lastPass`,
`consecutiveIncomplete`, `nextAttemptAt`). Never paste a download URL or a
token anywhere.

**False alarms to expect.** A: a regional Cloud Run or Cloud Scheduler
incident. B: a single transient Storage or Firestore failure that used up its
retries. Neither needs a code change; both need the recovery check.

### Billing continuity — administrator actions, none done here

The operator account used for these inspections cannot read the billing
account, its budgets or its administrators (permission denied), and the
Budgets API is not enabled on the project. So the following are **unknown**,
not confirmed:

| Action (billing account owner) | State |
|---|---|
| Confirm the project is on a permanent, paid billing account — not a free-trial account | **REPORTED by the Product Owner (17 November 2026):** paid billing confirmed. Read-only: `billingEnabled: True` (16 November 23:51 UTC); the account itself is not readable by the operator account. Google's documentation: a free-trial account that is not upgraded is closed, its projects' resources are stopped, and after a 30-day grace period they are permanently deleted |
| Confirm who owns the billing account and its payment profile | Not recorded |
| Add a second authorised billing administrator | Not confirmed |
| Verify a budget with alert thresholds exists for this project (the L1 set-up suggests A$20 a month at 50 / 90 / 100 %) | Not confirmed |
| Add the two DC46 email channels to that budget's notifications (a budget accepts up to five Monitoring email channels) | Not done. The channels now exist (16 November 2026); attaching them to a budget is a billing-account action |
| Confirm who receives Google's billing notices and any budget alerts | Not confirmed |
| Decide the alert path for a complete billing interruption (below) | Open decision |

**State on 17 November 2026: paid billing is Product Owner-reported (row 1);
every other row is still open, and owner, backup administrator and budget
notifications remain preconditions of activation (*DC46-C* → *Activation
runbook* → A).** The read-only
preflight of 16 November found billing enabled and the project linked to a
billing account that the operator account cannot read; nothing more is
known. **Receipt of the DC46 test email by the billing administrator shows
only that one Cloud Monitoring email channel delivers. It is not evidence
that a budget exists, that billing alerts are configured, or of who
administers the billing account.**

**Cloud Monitoring is not independent of billing.** Policies A and B live in
the same project the interruption stops. Replaying policy A's query shows the
data did stop on 12 November, but whether Cloud Monitoring still evaluates
policies and sends email for a project whose billing is disabled is **not
stated in Google's documentation and was not tested**. Worse, Google states
that a metric-absence condition raises no alert when the monitored resource
is "deleted or shut down", and Cloud Run logged a shutdown on 12 November.
**Policy A must not be described as detecting billing interruptions.** It
may; nothing shows that it does.

**A budget alert is not an interruption alert either.** It reports spend
against a threshold; it does not stop spend, and it says nothing when an
account lapses for another reason, as on 12 November.

What is independent of the project: Google's own notices to the billing
account's administrators and payment contacts. That is why a second
administrator matters more than any policy here. If the owners want a
signal that needs nobody to read billing mail, the remaining option is a
check hosted outside this project and its billing account; none is designed
or proposed. An independent external availability monitor remains future
reliability work.

### Billing-incident response

1. Confirm: `gcloud billing projects describe constrapp-69b5d` shows
   `billingEnabled: false`, or the console shows the project on Spark.
2. The billing administrator restores a paid account for the project. Google
   states services may take up to 24 hours to restart and some may need a
   manual restart; on 13 November the Scheduler job resumed within minutes.
3. Verify, read-only: the Scheduler job is `ENABLED` and attempts have
   resumed; the worker answers 200 each minute on the expected revision; the
   eight callables are Ready; the worker account still holds its three
   grants; the queue count returns to 0.
4. Find what waited: every `member.deactivated` or role reduction audited
   during the gap must be followed by a `file_links.revoked` after it. For
   the gap itself, old links of those members worked.
5. Do not redeploy unless a check in step 3 fails. Record the times, the
   cause and the checks under *Billing interruption* above.

### Dependency on the all-Functions deploy — proven by test; MET 16 November 2026 (callables redeployed)

**Status, 16 November 2026: the dependency is met.** The eight callables were
redeployed from `main` and now run the Stage 1 library, the same source as
the worker (*DC46-C* → *Callable release record*). The deploy targeted the
callables by name rather than all Functions. The rest of this section is
kept as the reason the deploy was required, and as the reason a rollback of
the callables to the ADR-74 build is safe only at interval `0`.

From 13 to 16 November 2026 the eight callables ran the ADR-74 build
(deployed 12 November) while the worker ran Stage 1.
`tests/functions/team.callableCompat.test.js` pins both sides:

| Callable build | Company state | Result |
|---|---|---|
| ADR-74 (deployed 12–16 November) | No periodic request has ever existed — interval `0` | Correct: served as urgent, audited `file_links.revoked`. This was production until 16 November |
| ADR-74 (deployed 12–16 November) | A periodic request has existed | Tokens are removed and the request completes, **but** the sweep is recorded as periodic: no `file_links.revoked`; `file_links.reconciled` only if a token was found, otherwise no audit event; an open periodic sweep is not superseded. **Never occurred in production: the interval has always been `0`** |
| Stage 1 (`main`; deployed since 16 November) | Any | Correct: the request is urgent, an open periodic sweep is superseded, the completion is audited `file_links.revoked`. Proven on the emulator only — it cannot occur at interval `0` |

So: **no deploy was needed while the interval is `0`; the callable deploy
(step 3 of the DC46-C order above) had to be done and verified before any
non-zero interval — and it has been.** It was not a defect in `main`; it was
two builds of one library running side by side. Nothing was lost and no link
survived because of it — the damage would have been to the audit evidence of
a revocation. What remains before activation is listed in step 4 of that
order.

### Policy C — the planning heartbeat (PREPARED and CREATED 17 November 2026; enabled)

**Files:** `ops/monitoring/dc46-planning-heartbeat.metric.json` (a
log-based counter) and `ops/monitoring/dc46-planning-heartbeat-absent.policy.json`
(the alert). Pinned by `frontend/tests/unit/monitoringPolicies.test.js`. No
recipient is committed. **Both exist in production since 17 November 2026
(last changed 18:42 UTC), with the two existing email channels.** Any change to them is a
production change needing its own authorisation; disable policy C if the
interval is ever rolled back to `0`.

**What it detects.** Planning has stopped while reconciliation is on: no
`file-links: reconciliation plan complete` line for **3 hours** (three
planning periods). Policy A cannot see this (the worker still returns 200)
and policy B cannot (no error is written when planning is simply skipped or
paused). Severity ERROR, not CRITICAL: membership-triggered revocation may
still be running.

| Part | Setting |
|---|---|
| Metric | `logging.googleapis.com/user/dc46_reconciliation_plan_complete`, DELTA INT64 counter, nothing extracted |
| Metric filter | `resource.type="cloud_run_revision"`, service `processfilelinkrevocations`, location `australia-southeast1`, `log_id("run.googleapis.com/stdout")`, `jsonPayload.message="file-links: reconciliation plan complete"` (exact match) |
| Condition | Metric absence, 60 s `ALIGN_DELTA`, `REDUCE_SUM` grouped by `service_name` only (as policy A, so a deploy's new revision series is not a gap), duration 10,800 s |
| Channels | The same two: `DC46 - Product Owner`, `DC46 - Billing Administrator` |
| Auto-close | 7 days |

**Does the filter match what the worker writes?** Yes, by evidence:
`planReconciliation` writes `log?.info?.('file-links: reconciliation plan complete', {…})`
exactly once per finished pass (pinned against the source). Production
worker info lines are written by the same logger to
`run.googleapis.com/stdout`, with the text in `jsonPayload.message` and the
fields alongside — read on a real `file-links: worker run` entry on
16 November 2026. An info line carries no stack, so an exact match is safe
(policy B uses `:` only because error lines do). The project's `_Default`
sink has no exclusion filter (read 17 November 2026).

**Will it work reliably with the existing telemetry?**

- The heartbeat already exists; no code change is needed. In the 2-hour
  simulation passes were 60–61 minutes apart (TESTING.md §56) — about a
  third of the window.
- A log-based metric counts only entries written **after** it is created:
  create the metric first, then the policy.
- By Google's documentation an absence condition needs a data point after
  it is created or edited, and treats late data as missing. Created at
  interval `0` it is therefore **dormant, not firing**, and arms itself on
  the first heartbeat after activation — this is why it can and should be
  created **before** activation (correcting the earlier "create with
  activation" note: the metric can exist before any line matches it).
- **Expected firing:** after a rollback to `0` (so rollback disables it);
  while planning is paused by 200 queued periodic requests (far beyond
  today's scale); if a pass cannot finish within 3 hours (planning has
  15 s per invocation — a scale limit, not reachable with one company).
- **Not covered:** a deleted service (Google: no alert); a billing
  suspension (unknown — same project); a pass that finishes but plans
  wrongly (the overdue line and policy B cover that).

**Create — on authorisation, before activation:**

```
gcloud logging metrics create dc46_reconciliation_plan_complete --project constrapp-69b5d \
  --config-from-file=ops/monitoring/dc46-planning-heartbeat.metric.json
gcloud monitoring policies create --project constrapp-69b5d \
  --policy-from-file=ops/monitoring/dc46-planning-heartbeat-absent.policy.json \
  --notification-channels="$DC46_CHANNELS"
```

`$DC46_CHANNELS` is set exactly as for policies A and B (*Monitoring release
record* → creation procedure).

**Verify safely (read-only):** `gcloud logging metrics describe
dc46_reconciliation_plan_complete --project constrapp-69b5d` matches the
file; `gcloud monitoring policies list --project constrapp-69b5d
--format=json` shows policy C enabled, identical to the file, with both
channels; no incident opens while the interval is `0`. After activation:
points about hourly (*Activation runbook* → F). Firing on its real condition
is not tested in production — as for policy A, that would mean stopping
planning; a rollback rehearsal would show it, and is not proposed.

**Disable during rollback:** `gcloud monitoring policies update <policy C
name> --no-enabled --project constrapp-69b5d` (*Activation runbook* → G).
Delete only on a separate decision; the metric can stay (it costs nothing
without matching lines).

### Cost — published prices and estimates, kept apart

**Published by Google** (Google Cloud Observability pricing page, read 16
November 2026):

| Item | Published price |
|---|---|
| Alerting, before 1 September 2027 | Not charged. Charging starts "no sooner than September 1, 2027" |
| Alerting, from that date | US$0.35 a month for each metric reference in an alerting policy, plus US$0.50 per million points returned by a metric alerting condition. No free allotment is listed |
| Log-match policies | Return no points. Google's pricing example prices 100 log-based policies at about US$3.50 a month — the same US$0.35 each |
| Google system metrics such as `run.googleapis.com/request_count` | Not charged for ingestion |

**Estimates — ours, not Google's, and not a commitment:**

| Item | Estimate | Assumption |
|---|---|---|
| Policy A, from September 2027 | About US$0.35 plus a few cents a month | One metric reference; one aggregated series evaluated about every 30 seconds is roughly 86,400 points a month |
| Policy B, from September 2027 | About US$0.35 a month | One policy, no points |
| The delivery test | Effectively nothing | It exists for minutes |
| Policy C and its log-based counter | Not priced; expected to be small | One policy (the same US$0.35 a month per metric reference from September 2027); the counter is a user-defined log-based metric, billed as a custom metric, at about 24 points a day. Re-read the pricing page before creation |
| Email channels, the logs the worker already writes | No added charge expected | — |

Prices, dates and exemptions can change before 2027, and an existing
commitment contract can alter them. **Re-read the pricing page before
creation and again before September 2027; no monthly figure here is a
promise.**

### Rollback of the monitoring itself

Disable a policy (`gcloud monitoring policies update <policy name> --no-enabled --project constrapp-69b5d`)
or delete it (`gcloud monitoring policies delete <policy name> --project constrapp-69b5d`);
delete the channels in the console. The policy names are in the *Monitoring
release record* above. Each is a production cloud change needing its own
authorisation. No effect on the worker, the callables,
Rules or data. A policy that is too noisy is edited from the file and
re-created, never tuned by hand in the console alone.

All three policy files were checked field by field against the Cloud
Monitoring API's published schema (discovery revision 20261109): every field
and enumerated value exists. That is a schema check, not a creation — the
API has no dry run, so value ranges are finally confirmed only on create.
On 16 November 2026 the API accepted all three files as written.

Sources (Google Cloud documentation, read through search results and the
API's published schema on 16 November 2026 — re-read before creation): [metric-absence policies](https://docs.cloud.google.com/monitoring/alerts/metric-absence),
[behaviour of metric-based policies](https://docs.cloud.google.com/monitoring/alerts/concepts-indepth),
[`projects.alertPolicies`](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies),
[log-based alerting policies](https://docs.cloud.google.com/logging/docs/alerting/log-based-alerts),
[Monitoring quotas and limits](https://docs.cloud.google.com/monitoring/quotas),
[notification channels, including *Test a notification channel*](https://docs.cloud.google.com/monitoring/support/notification-options),
[Cloud Run metrics](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z),
[pricing examples](https://cloud.google.com/stackdriver/observability-pricing-examples),
[Observability pricing](https://cloud.google.com/products/observability/pricing),
[budget alert recipients](https://docs.cloud.google.com/billing/docs/how-to/budgets-notification-recipients),
[billing for a project](https://docs.cloud.google.com/billing/docs/how-to/modify-project),
[free trial](https://docs.cloud.google.com/free/docs/free-cloud-features).

## Custom domain — app.constrap.com — CONNECTED (production; confirmed live on 11 November 2026)

The customer-facing brand is **Constrap** (AGENT.md → Brand Name). The
application's public origin is **`https://app.constrap.com`**; the
existing `https://constrapp-69b5d.web.app` and `.firebaseapp.com` origins keep
working throughout and after the transition (Firebase Hosting serves every
connected domain from the same site). Nothing in the client hard-codes an
origin: `/accept-invite` links are built server-side from `APP_BASE_URL`, and
password-reset links use Firebase's hosted action page on `authDomain`.

**Nothing below is done by an implementation task.** It is Product Owner
console / DNS work, in this order:

1. **Hosting → Add custom domain** `app.constrap.com` on the existing
   `constrapp-69b5d` site. Add the DNS records Firebase shows at the
   `constrap.com` registrar; wait for the certificate to be issued
   (*Connected*). Verify a deep link (e.g. `/projects`) hard-refreshes to the
   app, not a 404.
2. **Authentication → Settings → Authorized domains**: add
   `app.constrap.com`. Without it, Auth operations from the new origin are
   refused. Keep `VITE_FIREBASE_AUTH_DOMAIN=constrapp-69b5d.firebaseapp.com`;
   email/password sign-in does not need it changed.
3. **Storage CORS**: apply the rule in *Cloud Storage CORS for the Quant™
   viewer* with `https://app.constrap.com` in `origin` (already listed in the
   documented rule). Without it the Quant™ PDF viewer fails on the new origin
   only.
4. **Project settings → Public-facing name**: set to `Constrap`. Firebase
   Auth's own emails (password reset) show this name; it is not in the
   repository. Optionally edit the Authentication → Templates sender name.
5. **Resend**: verify `constrap.com` as a sending domain (SPF / DKIM, plus
   DMARC if absent). Then fill `frontend/functions/.env.constrapp-69b5d`:
   `APP_BASE_URL=https://app.constrap.com`,
   `EMAIL_FROM=Constrap <invites@constrap.com>`, and redeploy the `team`
   Functions (L1 release order above).
6. **App Check (only when L1 is released, not before)**: add `app.constrap.com`
   to the reCAPTCHA Enterprise key's domain list alongside the existing
   origins. This step does not enable App Check.

**Verification:** sign in at `https://app.constrap.com`; the tab title reads
*Constrap*; open a Quant™ PDF sheet; send a test invitation and confirm the
link opens `https://app.constrap.com/accept-invite#…` and the email reads
*on Constrap* from `invites@constrap.com`. **Done — 11 November 2026**
(confirmed by the Product Owner as part of the L1 live acceptance: production
URL, Resend invitation email, acceptance, Quant™ PDF and Authentication
regressions; the tab title *Constrap* was also observed on the live origin).
Steps 1–6 above are complete for production.

## L2-B Stage B — Final Account release order — ADR-77 — RULES, then ONE callable, then HOSTING (DEPLOYED — PRODUCTION ACCEPTANCE PENDING)

**Current status (20 November 2026): DEPLOYED — PRODUCTION ACCEPTANCE PENDING.** All three steps are
REPORTED by the Product Owner and the Lead Architect, 20 November 2026: Firestore Rules, the `approveFinalAccount` callable and Hosting deployed; Azure CI green on `main` `c4b93e5`. They were not re-read from production when this line was written, and
the TESTING.md §62 acceptance (F1–F17) is NOT complete: the Product Owner has
confirmed navigation, rendering, the readiness checklist and the disabled
*Prepare* on a not-ready project; no revision has been prepared or approved in
production. The rest of this section is the release order as written BEFORE
the deployment and is kept unchanged.

**Status when written (19 November 2026):** implemented on `feature/l2b-final-account` (uncommitted), awaiting
architect review. **Nothing is deployed. No deployment is authorised.** Three
steps, each a separate approved action, in this order. No index, no migration,
no transitional Rules publish, no new secret, no IAM change, no new service
account (the callable runs as the default runtime identity, like the eight
team callables).

**Why this order.** Each step is compatible with the production state before
it. (1) The Rules add one collection no deployed client reads or writes —
publishing them changes nothing a user can see. (2) The callable is unreachable
from the deployed bundle and refuses everything until a draft exists, which
needs the new Hosting bundle. (3) Hosting last: the page appears only when
both of its dependencies are live. The reverse order would show a Final
Account tab whose reads are denied (*Unavailable*) or whose approval fails.

*Preconditions.* Azure CI green on the merge. From `frontend/`:
`npm run rules:transitional:check` and `npm run functions:calc:check` clean;
`wc -c firestore.rules` reads **232,460**. The live ruleset is the 229,115-byte
file of `main` `28e5c9f` (confirm in the Console). Record the current
Hosting version id and Rules ruleset id for rollback.

**STEP 1 — Firestore Rules.** From `frontend/`:
`firebase deploy --only firestore:rules --project constrapp-69b5d`
*Verify:* the Console shows a 232,460-byte ruleset; an existing financial tab
still loads and saves (every other block is byte-identical to the live
file). *Compatibility:* additive; the deployed app is unaffected.
*Rollback:* republish the 229,115-byte ruleset. Safe at any time before step
3; after step 3 it makes the Final Account tab read *Unavailable* and nothing
else.

**STEP 2 — the ONE new callable.** From `frontend/`:
`firebase deploy --only functions:team:approveFinalAccount --project constrapp-69b5d`
**The `team:` codebase prefix is REQUIRED.** This repository's Functions
codebase is named `team`; firebase-tools 15.34.2 reads the unqualified
`functions:approveFinalAccount` as *codebase `default`*, which matches NO
function (checked against the CLI's own `getEndpointFilters` /
`endpointMatchesFilter` with the ten exported names: the qualified form
matches exactly `approveFinalAccount`, the unqualified form matches nothing).
Confirm the CLI's plan lists exactly ONE function — a create of
`approveFinalAccount` — before accepting it.
`functions/.env.constrapp-69b5d` already carries
`FINAL_ACCOUNT_APPROVAL_ENABLED=true`; a non-interactive deploy refuses a
parameter with no dotenv value, and the code default is `false` (fail closed).
**Never `--only functions`** — that would redeploy the eight team callables
and the DC46 reconciliation worker. The predeploy chain runs the Functions
lint and pure tests (which include the generated-calculation checks).
*Verify (read-only):* `gcloud run services list` shows a NEW service
`approvefinalaccount` at revision `-00001-*`, the eight team services still on
`-00004-*` and `processfilelinkrevocations` still on `-00003-ceg`; the new
service requires App Check (an unauthenticated curl is refused 401).
*Compatibility:* nothing calls it yet; the eight team callables and the
worker are not in the deploy plan and keep their revisions and environment.
*Rollback:* set
`FINAL_ACCOUNT_APPROVAL_ENABLED=false` in `functions/.env.constrapp-69b5d` and
redeploy that one function (same `--only functions:team:approveFinalAccount`) (it then answers `final-account-disabled` before
any read), or delete the function
(`firebase functions:delete approveFinalAccount --region australia-southeast1 --project constrapp-69b5d`).
Drafts, withdrawal and every approved revision are unaffected either way.

**STEP 3 — Hosting.** From `frontend/`: `npm run build`, then
`firebase deploy --only hosting --project constrapp-69b5d`
*Verify:* TESTING.md §62 production acceptance (NOT RUN). *Rollback:* in the
Firebase console, Hosting → release history → roll back to the recorded
previous version (there is no `firebase hosting:rollback` CLI command). The
tab disappears; the Rules, the callable and any Final Account documents
already written stay in place and are harmless — nothing else reads them.

**What a rollback does NOT undo.** An approved revision is permanent data. No
step removes it and nothing in the application depends on it; if one must be
disregarded, approve a correcting revision (or leave it — it moves no figure).

**Not part of this release.** The team callables, the reconciliation worker,
Storage Rules, App Check enforcement settings, IAM, billing, indexes.

## L2-B reconciliation correction — ONE callable, then HOSTING (DEPLOYED — REPORTED by the Lead Architect, 20 November 2026; positive approval acceptance PENDING)

**Status:** merged to `main` as `891043a` (VERIFIED in Git, 20 November 2026)
and REPORTED deployed by the Lead Architect the same day — negative-readiness
and reconciliation acceptance passed, browser screenshots verified. Positive
approval, revision and export acceptance (TESTING.md §62) is still PENDING.
The steps below are kept as the record of that release. No Rules change, no
index, no migration, no new parameter.

**A Functions redeploy IS required** — of `approveFinalAccount` only. The new
readiness requirement (*No over-allocated issued client invoices*) is in the
shared calculation, so the generated server bundle changed; until the
callable is redeployed the server does not enforce it.

1. **Callable first:**
   `firebase deploy --only functions:team:approveFinalAccount --project constrapp-69b5d`
   (confirm the plan lists exactly ONE function, an update). With the old
   Hosting bundle still live, a draft prepared on over-allocated records is
   refused at approval (`final-account-not-ready`, blocker
   `overAllocatedInvoices`).
2. **Hosting second:** `npm run build`, then
   `firebase deploy --only hosting --project constrapp-69b5d`. The checklist
   then shows the requirement, the forecast labels on the live position, the
   proposed labels on a draft, and the corrected variation wording.

The reverse order would leave a window in which the page blocks preparation
but the server would still approve an existing draft. *Rollback:* Hosting to
the previous release in the console; the callable by redeploying the previous
`main` — each independently; no data is written by either step.

*Acceptance (NOT RUN):* on *Gold Coast apartments* the checklist shows *No
over-allocated issued client invoices — Not met — 1 over-allocated: CI-0012*;
the live figures read *Adjusted contract sum*, *Forecast final cost*,
*Forecast gross profit*, *Forecast margin*; the supplier-variation note no
longer says "already inside". After the receipt against CI-0012 is corrected
by the user, the requirement reads Met and outstanding equals invoiced −
received.

## L2-B Stage A — Rules capacity recovery 3 — ADR-76 — RULES ONLY (LIVE since 18 November 2026 21:57 UTC)

**Status: LIVE.** Merged to `main` as `28e5c9f`; Azure CI green and the Rules
publish REPORTED by the Product Owner. **VERIFIED read-only on 19 November
2026:** the live `cloud.firestore` release (ruleset `05c78d00…`, created
18 November 2026 21:57:07 UTC) is 229,115 bytes and byte-identical to
`frontend/firestore.rules` on `main`; the Storage ruleset is still
`8b8edc14…` (9,271 bytes, identical to `main`); the eight callables are still
on `-00004-*` and the worker on `-00003-ceg`; the latest Hosting release
(`e38715de08e664b5`, 18 November 05:29 UTC) predates the publish. The
TESTING.md §61 browser smoke checks are not recorded. One FINAL Rules publish;
no Hosting, no Functions, no transitional stage, no index, no migration. The
procedure below is kept as the record of what was run.

A leading-whitespace-only re-indent of `frontend/firestore.rules`: **242,163 →
229,115 bytes** (−13,048), the regenerated transitional file **242,843 →
229,795**. Every line is byte-identical after its leading spaces, so the
published controls are exactly those of the ruleset it replaces. **Do not
publish the transitional ruleset**; it is regenerated only so it stays
derivable from the FINAL file.

*Preconditions.* Azure CI green on the merge; from `frontend/`:
`npm run rules:transitional:check` clean; `wc -c firestore.rules` reads
**229,115**; `node scripts/verify-rules-whitespace-only.mjs --base 2d5787c`
prints `EQUIVALENT` for both files and exits 0. **The live ruleset must be the
242,163-byte file of `main` `2d5787c`** (confirm in the Console first: if an
older ruleset is live, this publish also publishes every control added since).

*Step 1 (the only step; a separate approved action, never run by an
implementation task).* From `frontend/`:
`firebase deploy --only firestore:rules --project constrapp-69b5d`.

*Verify.* The Console shows a new ruleset of 229,115 bytes; then the TESTING.md
§61 production smoke checks (a financial-role read and one ordinary write on an
existing register; a non-financial read still refused).

*Rollback.* Republish the previous ruleset from the Console's Rules history (or
`firestore.rules` at `2d5787c`). The two files enforce the same controls, so a
rollback changes nothing a user can observe and no data needs repair.

## L2-A Commercial Report — release (LIVE and Product Owner accepted; implemented 18 November 2026)

**Current status (19 November 2026): LIVE and accepted.** Merged to `main` as
`2d5787c`; Hosting deployed (release `e38715de08e664b5`, 18 November 2026
05:29 UTC) and accepted in the browser by the Product Owner — REPORTED by the
Product Owner and the Lead Architect; the Hosting release time was read from
production on 19 November 2026, its files were not compared with `main`. The
rest of this section is the release record as written BEFORE that deployment
and is kept unchanged.

**Status when written (18 November 2026):** implemented on `feature/l2a-commercial-report` (uncommitted), awaiting
architect review. **Not deployed. Not production-verified.**

**What ships:** Hosting only. The project **Reports** tab becomes a read-only
Commercial Report (`frontend/src/pages/project/ProjectReports.jsx`, composed by
`src/lib/commercialReport.js`), with CSV export (`src/lib/csv.js`,
`src/lib/commercialReportCsv.js`) and a print / Save-as-PDF layout (print rules
in `src/index.css`, scoped to `body:has(.commercial-report)`).

**What does NOT change:** Firestore Rules, Storage Rules, Functions, indexes,
collections, data. No migration. The report reads only collections the
financial roles can already read under the live rules (budget lines, approved
budget pointer / header / snapshot / adjustments, purchase orders, progress
claims, supplier invoices and credit notes, variations, forecast lines,
commercial baseline, supplier payments, retention releases, client invoices and
receipts, cost codes) and writes nothing.

**Release order (after Git integration and Azure CI on `main`, each step
separately authorised):**

1. `cd frontend && npm ci && npm run lint && npm run test:unit && npm run build`
2. `firebase deploy --only hosting --project constrapp-69b5d`
3. Acceptance: TESTING.md §60.

**Rollback:** redeploy the previous build, or use the Firebase Console's Hosting
release history (*Rollback* on the previous release). There is no
`firebase hosting:rollback` command. Nothing else needs reverting.

## Firestore recovery protection — ENABLED 18 November 2026; two READY backups VERIFIED 21 November 2026; restoration verification SUCCESSFUL (L3 Stage 1; counts and one sample hash — not every document's contents)

**Status update — restoration verified (recorded 21 November 2026, NZ).** REPORTED by the Lead Architect as verified operational evidence: the 20 November 2026 backup was restored into the temporary database `restore-verify-20261120-2329`; the restore operation reported SUCCESSFUL; an unauthenticated request to the temporary database returned 403; all 44 collection-group counts matched (211 documents); the sample document hash matched; the temporary database was removed. VERIFIED read-only on 21 November 2026 for this record: the database listing shows only `(default)`, with delete protection ENABLED and point-in-time recovery ENABLED; both backups are still READY. **Not established:** the exact time and the mechanism of the temporary database's deletion were not independently established and are not recorded. **Scope of the proof:** the validation compared counts per collection group and one document hash; it did NOT compare every document's contents, and Storage files are outside Firestore backups. The paragraph below, including *No restore has been performed*, is kept as written before the verification.

**Current status (21 November 2026, NZ) — VERIFIED read-only.** Point-in-time recovery ENABLED (7 days; earliest version 18 November 2026 19:28 UTC), one daily backup schedule `86b478d6-9a91-49f8-9c55-ff4d183fed3f` with 14-day retention, delete protection ENABLED, database uid `c296a8a4-ff1a-4576-a13a-9ab628a3d430`. **Two scheduled backups exist and are READY:**

| Backup id | Snapshot time (UTC) | Expires (UTC) | State |
|---|---|---|---|
| `d05840df-e4ff-489f-ace8-c123630775ef` | 19 November 2026 16:51:15 | 3 December 2026 16:51:15 | READY |
| `f6e32570-aea9-480c-b5c0-d7aa9d33d9f4` | 20 November 2026 17:01:09 | 4 December 2026 17:01:09 | READY |

The empty list on 19 November was timing: the first scheduled run came about 20 hours after the schedule was created. No TTL policy and no composite index exist on `(default)`. **No restore has been performed.** The restoration verification procedure is [ops/recovery/README.md](../ops/recovery/README.md) — it **replaces step 4 below**, which is kept as written. Routine backup checks: [ops/RUNBOOK.md](../ops/RUNBOOK.md) §1–§2. The verification is still required before commercial customer onboarding and needs its own Product Owner authorisation.

### Restoration verification record

**SUCCESSFUL — REPORTED by the Lead Architect; recorded 21 November 2026 (NZ).**

| Item | Record | Status |
|---|---|---|
| Project | `constrapp-69b5d` | — |
| Backup restored | The 20 November 2026 backup (the scheduled backup with that date is `f6e32570-aea9-480c-b5c0-d7aa9d33d9f4`, snapshot 20 November 2026 17:01:09 UTC) | REPORTED |
| Temporary database | `restore-verify-20261120-2329` | REPORTED |
| Restore operation | SUCCESSFUL | REPORTED |
| Security Rules check | Unauthenticated request returned 403 | REPORTED |
| Counts | All 44 collection groups matched; 211 documents | REPORTED |
| Sample document | Field hash matched (no path, id or value recorded) | REPORTED |
| Cleanup | Temporary database removed; final database listing shows only `(default)` | REPORTED; the listing re-read and VERIFIED 21 November 2026 |
| Production database | Delete protection ENABLED, point-in-time recovery ENABLED | VERIFIED read-only, 21 November 2026 |
| Deletion time and mechanism | Not independently established; not recorded | — |
| Operator, restore start and end times, database uid | Not supplied to this record | — |

The validation was successful but compared counts per collection group and one document hash only. It did not compare every document's contents.

*Instruction as written before the run:* NOT RUN. When the verification is authorised and run, record here: date and operator; backup id and snapshot time; temporary database id and uid; restore start and end; the configuration read in step 4 of the procedure; the HTTP status of the Security Rules check; counts, total and sample hash from both readings; MATCH or the mismatches; deletion time; final checks. Never a sample path, a document id or a field value.

*Status as recorded on 19 November 2026, kept for the record:*

**Current status (19 November 2026).** **ENABLED 18 November 2026 20:27 UTC; VERIFIED read-only 19 November 2026:** point-in-time recovery enabled (7-day window), a daily backup schedule with 14-day retention (`86b478d6…`), database delete protection enabled. **No backup existed yet at that check, so the first READY backup is UNVERIFIED, and the non-production restore test is PENDING** — both are still required before commercial customer onboarding. Read with `gcloud firestore databases describe`, `gcloud firestore backups schedules list` and `gcloud firestore backups list` (read-only). The rest of this section is the procedure as prepared BEFORE it was run and is kept unchanged.

**Status when written (18 November 2026):** PREPARED ONLY. Nothing below has been run. It is a separate
operational change and needs explicit Product Owner authorisation. Required
before commercial customer onboarding (international infrastructure assessment,
architect-approved 18 November 2026).

**Current state (read-only check, 18 November 2026):** database `(default)`,
Native mode, `australia-southeast1`; `pointInTimeRecoveryEnablement:
POINT_IN_TIME_RECOVERY_DISABLED`; `deleteProtectionState:
DELETE_PROTECTION_DISABLED`; **no backup schedule**; no Firestore backups; the
only copy is a manual export in `gs://constrapp-69b5d-firestore-backups/`
dated 20 September 2026. Storage bucket `constrapp-69b5d.firebasestorage.app`:
soft delete ENABLED, 7 days (`retentionDurationSeconds: 604800`, effective
18 August 2026); object versioning not enabled.

Sources (official, read 18 November 2026; the `cloud.google.com` docs now
redirect to `docs.cloud.google.com`): Firestore PITR
<https://cloud.google.com/firestore/native/docs/pitr> and
<https://cloud.google.com/firestore/native/docs/use-pitr>; backups
<https://cloud.google.com/firestore/native/docs/backups>; manage databases /
delete protection <https://cloud.google.com/firestore/native/docs/manage-databases>;
gcloud references `firestore databases update|restore|clone`; pricing
<https://firebase.google.com/docs/firestore/pricing>; Cloud Storage soft delete
<https://cloud.google.com/storage/docs/soft-delete> and
<https://cloud.google.com/storage/docs/use-soft-deleted-objects>.

### Permissions

The operator needs `roles/datastore.owner` on the project (covers
`datastore.databases.update`, `.export`, `.clone`, backups and backup
schedules). Narrower alternatives: `roles/datastore.backupSchedulesAdmin`,
`roles/datastore.backupsAdmin`, `roles/datastore.restoreAdmin`. Billing must be
enabled. **No IAM change is proposed** — use an existing owner account.

### 1. Seven-day point-in-time recovery

```
gcloud firestore databases update --database='(default)' --enable-pitr --project=constrapp-69b5d
```

- Retention becomes 7 days (one version per minute; microsecond reads only in
  the last hour). Without PITR the window is 1 hour.
- **The 7-day window builds up from the moment of enabling**: `earliestVersionTime`
  starts about 1 hour before enablement and reaches now − 7 days after a week.
- Recovery paths: export at a past whole minute
  (`gcloud firestore export gs://constrapp-69b5d-firestore-backups/pitr-<stamp> --snapshot-time=<RFC3339 whole minute> --project=constrapp-69b5d`),
  or clone into a NEW database
  (`gcloud firestore databases clone --source-database='projects/constrapp-69b5d/databases/(default)' --snapshot-time=<…> --destination-database=<new-id>`;
  launch stage not confirmed from the docs), or server-side reads at a past
  `readTime` (Admin SDK / REST — not the web SDK).
- Disable (rollback): `--no-enable-pitr`.

### 2. Daily backups retained 14 days

```
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14d --project=constrapp-69b5d
```

- One daily and one weekly schedule per database; the time of day cannot be
  chosen; retention can be updated later, recurrence cannot (maximum 14 weeks).
  The `14d` value follows the documented duration format (the docs' example is
  `14w`) — confirm the command is accepted.
- Backups live in the database's location (`australia-southeast1`) and survive
  deletion of the database or the schedule. A deleted backup cannot be recovered.
- Verify: `gcloud firestore backups schedules list --database='(default)' --project=constrapp-69b5d`;
  after the first run, `gcloud firestore backups list --location=australia-southeast1 --project=constrapp-69b5d`.
- Backups include data and index configuration; **they do not include Security
  Rules or TTL policies.**

### 3. Database deletion protection

```
gcloud firestore databases update --database='(default)' --delete-protection --project=constrapp-69b5d
```

Disable only deliberately with `--no-delete-protection`.

### Verification of 1–3

```
gcloud firestore databases describe --database='(default)' --project=constrapp-69b5d \
  --format='yaml(pointInTimeRecoveryEnablement,earliestVersionTime,versionRetentionPeriod,deleteProtectionState)'
```

Expect `POINT_IN_TIME_RECOVERY_ENABLED`, `versionRetentionPeriod: 604800s`,
`DELETE_PROTECTION_ENABLED`, and one daily schedule with 14-day retention.

### 4. Non-production restoration verification (after the first backup exists)

A restore always creates a **new** database id in the same location; it never
overwrites `(default)`. The app only addresses `(default)`, so the restored
database is not used by the app.

1. `gcloud firestore databases restore --source-backup=projects/constrapp-69b5d/locations/australia-southeast1/backups/<BACKUP_ID> --destination-database=restore-verify-<yyyymmdd> --project=constrapp-69b5d`
2. Immediately set deny-all Security Rules on the restored database in the
   Firebase Console (rules are per database and are **not** restored; the
   default a gcloud restore receives is not confirmed from the docs).
3. Compare counts with production using owner-credentialed count aggregations
   (REST `runAggregationQuery`, the accepted read-only method), e.g. `companies`,
   `users`, and a project's `purchaseOrders` and `supplierInvoices`. Do not
   open the app against it.
4. Delete it the same session: `gcloud firestore databases delete --database=restore-verify-<yyyymmdd> --project=constrapp-69b5d`
   (never pass `(default)`; the verification database must not have delete
   protection).
5. Record the backup id, times, counts and outcome here.

### Cloud Storage recovery protection — no change proposed

Soft delete is already on (7 days): deleted **or overwritten** objects can be
listed with `gcloud storage ls gs://constrapp-69b5d.firebasestorage.app/** --soft-deleted`
and restored with `gcloud storage restore gs://constrapp-69b5d.firebasestorage.app/<object>#<generation>`
(needs `storage.objects.restore` / `roles/storage.admin`). Object versioning is
not proposed: the app writes each document or drawing revision to a new path
keyed by its new record id (`useProjectDocuments`, `useDrawingRevisions`), and
versioning would bill every noncurrent copy. Storage objects are not part of a
Firestore backup — a full point-in-time recovery of documents needs both.

### Cost

- PITR: billed per GiB-month of database size (daily measurement, monthly
  average × PITR unit price); no free tier; up to one day billed if disabled
  within a day; PITR reads/exports are billed as document reads.
- Backups: storage per GiB-month for the retained period; a restore is billed
  per GiB of backup size.
- Soft delete: soft-deleted objects bill as storage until the 7 days end.
- **Sydney unit prices were not confirmed** (the pricing page's region
  selector or the Cloud Billing SKU catalogue gives them). At the current size
  (one company, about 9,400 reads a week) the cost is expected to be small, but
  the database size has not been measured — read it in the console *Usage* page
  before enabling.

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

**Since ADR-73 (DC46-A) this rule is load-bearing for EVERY file view, not
only Quant.** `Open`, `Download`, the drawing preview and Quant image sheets
all read bytes through the SDK (`getBlob`), so a bucket without the CORS rule
for the Hosting origin shows no files at all. Confirm step 1 before that
Hosting release.

**Status: production rule updated by the Product Owner (11 November 2026)**
to include `https://app.constrap.com` in `origin` and `X-Firebase-AppCheck` in
`responseHeader`; the Quant™ PDF and Storage regression passed afterwards on
`app.constrap.com`. The bucket rule itself is not stored in this repository,
and an implementation task **must not** change bucket configuration — confirm
the live rule with the command in step 1. (A preflight probe of
`firebasestorage.googleapis.com` on 11 November 2026 already allowed
`X-Firebase-AppCheck`; the GET's `206` with `Access-Control-Allow-Origin`
in step 3 remains the check that matters.)

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
   configured with `VITE_FIREBASE_APP_ID`), **`X-Firebase-AppCheck`** (sent
   since the L1 release initialised App Check, even though Storage enforcement
   is off), and a **206 Partial
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
         "https://constrapp-69b5d.firebaseapp.com",
         "https://app.constrap.com"
       ],
       "method": ["GET"],
       "responseHeader": [
         "Authorization",
         "Range",
         "X-Firebase-Storage-Version",
         "X-Firebase-GMPID",
         "X-Firebase-AppCheck",
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
- Cache-control headers for Hosting (the custom domain is planned — see
  *Custom domain — app.constrap.com*)

---

## L2-C Portfolio Report — HOSTING ONLY (ADR-78; DEPLOYED, 20 November 2026 — visual, CSV and PDF acceptance confirmed; access, parity and performance checks OPEN)

**Status update (21 November 2026, NZ).** Visual, CSV and PDF acceptance is confirmed (REPORTED by the Lead Architect). The remaining access (external-role), parity and performance checks of TESTING.md §63 are still OPEN; they are a product acceptance item, not part of L3.

**Status: DEPLOYED.** Merged to `main` as `93db6cc` (VERIFIED in Git). The
live Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves
the bundle a clean build of that commit produces (VERIFIED read-only, 20
November 2026). Visual and export acceptance PASSED (REPORTED by the Lead
Architect, 20 November 2026); the remaining security, parity and performance
checks of TESTING.md §63 are OPEN. The release date and the Hosting release
it replaced are not recorded in this file. *As first written:* implemented on
`feature/l2c-portfolio-reporting`; release needs its own authorisation.

**What ships.** Frontend only: one new route (`/portfolio`), one sidebar
entry, new modules under `src/lib`, `src/hooks` and `src/pages`.

**What does NOT ship — do not deploy any of these for L2-C:**
Firestore Rules (unchanged, 232,460 bytes) · Storage Rules · any Cloud
Function (the eight team callables, `approveFinalAccount` and the
reconciliation worker must NOT be redeployed) · indexes · data migration.

**Order.**

1. Git integration by the Product Owner; Azure CI green on `main` (lint, unit
   tests, build).
2. From `frontend/`: `npm ci`, `npm run lint`, `npm run test:unit`,
   `npm run build`.
3. Note the current Hosting release id (Firebase Console → Hosting → release
   history) — the rollback target.
4. `firebase deploy --only hosting --project constrapp-69b5d`.
5. Run TESTING.md §63 (P1–P22) and record the measurements M1–M5.

**Rollback.** Firebase Console → Hosting → release history → roll back to the
release noted in step 3 (there is no `firebase hosting:rollback` CLI
command), or redeploy Hosting from the previous `main` commit. Nothing else
needs reverting: the page writes nothing and no rule, Function or document
changed.

**Stop and report if:** a portfolio row disagrees with its project's Reports
tab; any figure combines two currencies; a subtotal appears while a project
in its group is Unavailable, Not set or Not approved; an external role's
session issues a financial read from the page; or the Dashboard changes.

---

## GANTT™ core completion — HOSTING ONLY (ADR-79; LIVE since 20 November 2026 08:52 UTC — Product Owner accepted)

**Status update (21 November 2026, NZ) — LIVE and Product Owner accepted.** Merged to `main` as `9ce433d` (*Merge GANTT core completion*; feature commit `8e60eb7`) — VERIFIED in Git. Released Hosting-only on 20 November 2026 08:52 UTC: the live bundle `index-Cz4wMhcy.js` is SHA-256-identical to a clean build of `main` `9ce433d` (VERIFIED read-only, 21 November 2026). The three additions — the Lead Architect's G1, G2 and G3 — are Product Owner accepted (REPORTED by the Lead Architect, 21 November 2026; no per-step acceptance record is held here). Certain baseline scenarios were not exercised in the browser and remain a separate product acceptance check. The rest of this section is the release procedure as written before the release and is kept unchanged.

**Status when written (20 November 2026):** implemented on `feature/gantt-core-completion` (uncommitted).
Not integrated, not released. Release needs its own authorisation.

**What ships.** Frontend only: the schedule attention filter, *Export CSV*
and *Print / Save as PDF* on the GANTT tab, and the *Last changed* row in
the activity detail and editor. New modules under `src/lib` and
`src/pages/project/timeline`; a print block in `src/index.css`.

**What does NOT ship — do not deploy any of these for this release:**
Firestore Rules (unchanged, 232,460 bytes) · Storage Rules · any Cloud
Function (the eight team callables, `approveFinalAccount` and the
reconciliation worker must NOT be redeployed) · indexes · data migration ·
dependencies (`package.json` and the lockfile are unchanged).

**Preconditions.** GANTT 1A1, 1A2, 1B and PULSE 1C are live (VERIFIED, 20
November 2026 — their sections above), so this bundle depends on nothing
unreleased. The live Hosting release at the time of writing is
`765058ff63073a4b` (the build of `main` `93db6cc`); confirm that is still the
latest release before deploying — it is the expected rollback target.

**Order.**

1. Git integration by the Product Owner; Azure CI green on `main` (lint, unit
   tests, build).
2. From `frontend/`: `npm ci`, `npm run lint`, `npm run test:unit`
   (93 files / 4,964), `npm run build`.
3. Note the current Hosting release id (Firebase Console → Hosting → release
   history) — the rollback target.
4. `firebase deploy --only hosting --project constrapp-69b5d`.
5. Hard-reload `https://app.constrap.com`, open a project's GANTT tab and
   run TESTING.md §64: attention filter G1–G11 and G8a, CSV C1–C9, print R1–R13 and R9a–R9b,
   last change L1–L7, access A1–A3. Record the browser used for each print
   check.

**What to look at first in production.**

- *Attention filter:* each count equals the matching PULSE schedule
  indicator for the same project (active baseline selected); a blocked
  successor stays listed when a search hides its predecessor.
- *CSV:* opens in a spreadsheet with dates as `YYYY-MM-DD` and numeric
  durations and variances; the scope line names the filters; no baseline
  variance exists on a project with no approved baseline.
- *Print:* the actual print preview from the running page — light, A4
  landscape, table header repeated on every page, no clipped column, no app
  chrome; the browser's own Print command gives the same report.
- *Baseline:* changing the selected approved version changes the *Later than
  baseline* count, the CSV and the printed header together; exporting or
  printing leaves the baseline panel unchanged.
- *Last change:* "by you" after your own save, "by another user" otherwise,
  and never a name.

**Rollback.** Firebase Console → Hosting → release history → roll back to the
release noted in step 3 (there is no `firebase hosting:rollback` CLI
command), or redeploy Hosting from the previous `main` commit. Nothing else
needs reverting: this release writes nothing, and no rule, Function,
document or stored shape changed, so the previous bundle works against the
same data and Rules exactly as it does today.

**Stop and report if:** an attention count disagrees with PULSE; the chart
and the list show different activities under a filter; exporting or printing
writes any document or creates a baseline; another tab's print output
changes (the Reports tab and the Portfolio share the print rules); or an
external role reaches the programme.

## L3 Stage 1 — recovery verification, availability check and Final Account failure alert — CLOSED: monitoring CREATED and restoration verification SUCCESSFUL (recorded 21 November 2026); alert delivery TESTED 24 November 2026 UTC through a temporary policy on the Product Owner channel (C1-D); neither L3 alert has fired on its real condition

**Status update — Stage 1 closed (recorded 21 November 2026, NZ).** Merged to `main` as `4bd358a`. Monitoring, VERIFIED read-only on 21 November 2026: uptime check `l3-app-constrap-com-https-availability-10ehOIKFFlc` on `app.constrap.com` (every 300 s); alert policy `15559930914799323534` (*L3 app.constrap.com: HTTPS check failing from two or more locations for 10 minutes*, enabled, two channels); alert policy `9683374685335961795` (*L3 approveFinalAccount: server failure (5xx)*, enabled, one channel); DC46 policies A, B and C still present and enabled, two channels each — five policies in all. Notification channels verified (REPORTED by the Lead Architect; channel counts re-read). Restoration, REPORTED by the Lead Architect: the 20 November 2026 backup was restored into the temporary database `restore-verify-20261120-2329`; the restore operation reported SUCCESSFUL; an unauthenticated request to the temporary database returned 403; all 44 collection-group counts matched (211 documents); the sample document hash matched; the temporary database was removed (record: *Firestore recovery protection* → *Restoration verification record*). **Not established:** the exact time and the mechanism of the temporary database's deletion were not independently established and are not recorded. **Scope of the proof:** the validation compared counts per collection group and one document hash; it did NOT compare every document's contents, and Storage files are outside Firestore backups. **Not tested:** actual delivery of an alert notification — neither L3 alert has fired or been test-fired. The text below, including the table's *NOT CREATED* / *NOT RUN* cells and *Creating the monitoring — NOT AUTHORISED YET*, is kept as written before these actions.

**Status.** Prepared on `chore/l3-recovery-monitoring` (uncommitted). This
stage adds files and documentation only: no Hosting, Functions, Firestore
Rules or Storage Rules change, no application code, no dependency. **No
alert policy, uptime check or database was created, changed or deleted, and
no restore was run.** Each production action below needs its own Product
Owner authorisation.

| Part | Where | Production state |
|---|---|---|
| Restoration verification procedure and its read-only count script | [ops/recovery/README.md](../ops/recovery/README.md), `ops/recovery/firestore-count-evidence.mjs` | NOT RUN. The script was run read-only against `(default)` on 21 November 2026 to capture the expected counts for backup `f6e32570…` (211 documents, 44 collection groups) |
| Uptime check on `app.constrap.com` and its alert policy | `ops/monitoring/l3-app-availability.uptime-check.json`, `ops/monitoring/l3-app-availability.policy.json` | NOT CREATED |
| Alert on `approveFinalAccount` server failures | `ops/monitoring/l3-final-account-callable-failure.policy.json` | NOT CREATED |
| Operations runbook | [ops/RUNBOOK.md](../ops/RUNBOOK.md) | In force once merged |

Specification, limits and cost of the three monitoring files:
[ops/monitoring/README.md](../ops/monitoring/README.md) → *L3 files*.

### Public response confirmed (read-only, 21 November 2026)

`GET https://app.constrap.com/` → HTTP 200, `text/html`, about 0.2 s from
the operator's machine; the body contains `<div id="root"></div>`; the
certificate (Google Trust Services) is valid to 8 February 2027 and is
renewed by Firebase Hosting; `http://` answers 301 to `https://`.

### Creating the monitoring — NOT AUTHORISED YET

Run from the repository root, signed in as a project owner. Order matters:
the check first, then the policy that reads it.

1. Read the existing channels (names and state only) and set the two
   variables. The two channels are the project's only ones and are reused;
   their display names keep the historical "DC46" prefix (renaming a
   channel is a separate production change and is not proposed).

   ```
   export P=constrapp-69b5d
   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "https://monitoring.googleapis.com/v3/projects/$P/notificationChannels?fields=notificationChannels(name,displayName,type,enabled)"
   export L3_CHANNEL_PO="projects/constrapp-69b5d/notificationChannels/<id of DC46 - Product Owner>"
   export L3_CHANNELS_BOTH="$L3_CHANNEL_PO,projects/constrapp-69b5d/notificationChannels/<id of DC46 - Billing Administrator>"
   ```

   Recommended: availability to **both** channels (a billing lapse is one
   of its causes); the Final Account failure to the **Product Owner**
   channel only. The architect may choose both for each.

2. Create the uptime check from its file (the Monitoring REST API;
   `gcloud monitoring uptime create` takes flags, not a file):

   ```
   curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
     "https://monitoring.googleapis.com/v3/projects/$P/uptimeCheckConfigs" \
     -d @ops/monitoring/l3-app-availability.uptime-check.json
   gcloud monitoring uptime list-configs --project "$P"
   ```

   Record the returned `name`. Wait about 15 minutes, then confirm in
   Cloud Monitoring → Uptime checks that every location passes. **If any
   location fails on a healthy site, stop and report: do not create the
   policy.**

3. Create the two policies:

   ```
   gcloud monitoring policies create --project "$P" \
     --policy-from-file=ops/monitoring/l3-app-availability.policy.json \
     --notification-channels="$L3_CHANNELS_BOTH"
   gcloud monitoring policies create --project "$P" \
     --policy-from-file=ops/monitoring/l3-final-account-callable-failure.policy.json \
     --notification-channels="$L3_CHANNEL_PO"
   ```

4. Verify read-only: `gcloud monitoring policies list --project "$P" --format='table(displayName,enabled,notificationChannels.len())'`
   shows five enabled policies (A, B, C and the two new ones); compare each
   new policy with its file. No incident should be open.

5. Record the names, times and what was verified under *Monitoring release
   record* below, and correct the status lines in this section,
   `ops/monitoring/README.md`, `ops/RUNBOOK.md` and the handover.

Neither new condition can be exercised without causing a real failure, so
neither will have fired on its real condition. Email delivery through these
channels was exercised on 16 November 2026 (*DC46-C monitoring readiness* →
*Delivery test*); it is not repeated here.

**Rollback.** `gcloud monitoring policies delete <policy name> --project "$P"`
for either policy; `gcloud monitoring uptime delete <check id> --project "$P"`
for the check (delete its policy first). Nothing else depends on them.

### Monitoring release record

**CREATED — VERIFIED read-only, 21 November 2026 (NZ).** Project `constrapp-69b5d`.

| Object | Identifier | State |
|---|---|---|
| Uptime check — `app.constrap.com` HTTPS | `l3-app-constrap-com-https-availability-10ehOIKFFlc` | Exists; period 300 s |
| Alert policy — uptime | `15559930914799323534` | Enabled; two notification channels |
| Alert policy — Final Account failure | `9683374685335961795` | Enabled; one notification channel |
| DC46 policies A, B, C | `15284677036198995887`, `11943159347055161843`, `5090947661132483012` | Preserved; enabled; two channels each |

**Updated 25 November 2026 (C1-D; Cloud, read-only).** The availability
policy as created differs from the file as then committed. The Admin
Activity audit log shows it created with gcloud on 20 November 2026 at
21:50:41 UTC with two changes: the filter adds
`metric.label.check_id="l3-app-constrap-com-https-availability-10ehOIKFFlc"`,
and the condition groups by `resource.label.*` instead of
`resource.labels.host`. Both were verified to have the intended meaning:
- `uptime_url` carries only `project_id` and `host`, so the grouping is still one group.
- The check id is the only one on the host.
- Both forms return the same series over the check's whole history: 1,157
  five-minute rounds and the same single one-location failure on
  24 November 2026 at 11:11:41 UTC (below the threshold).

The id restriction only removes the earlier caveat that a second check on
the same host would be counted. The repository file and its test were
aligned with production; the live policy was not changed. Every other
policy, the uptime check and the log metric matched their files field by
field. (The Final Account policy reads without `thresholdValue`, which is
the API omitting the default 0.) Delivery: *C1-D alert delivery acceptance
record* below.

*As written 21 November 2026:* Notification channels verified (REPORTED by the Lead Architect). **Actual alert-notification delivery was NOT tested**: neither policy has fired and no test notification was sent. Creation time and operator were not supplied to this record. Checklist O1 (every location passing for 15 minutes) and O3 were not re-read for this record.

*As written before creation:* NOT CREATED.

### C1-D alert delivery acceptance record (24 November 2026 UTC; 25 November 2026 NZDT)

**C1-D CLOSED (Lead Architect decision, 25 November 2026 — REPORTED).** D1–D7 accepted (TESTING.md §73). **Evidence limitations (stand after closure):** the billing-administrator channel was not tested in this run; exact email arrival times are unknown; not every permanent policy has fired on its intended condition (only policy B, once); the permanent policies' recovery-notification behaviour is unverified; receipt of policy B's 17 November email is unverified; observed timings are not service levels.

**Approved by the Lead Architect (25 November 2026).** The approval covered
exactly one production mutation pair: create one temporary alert policy and
delete it. No existing policy, channel, Function, Scheduler job, Rule,
Hosting setting or data was changed. The billing administrator was not
available, so **only the `DC46 - Product Owner` channel** was attached, as
the approval required. Operator: the Product Owner's gcloud account (gcloud
593.0.0).

**Method.** The temporary policy opens an incident because the worker is
healthy, and closes it by itself. It is a threshold condition on the
existing planning-heartbeat metric `dc46_reconciliation_plan_complete`
(policy C's filter). The heartbeat is counted about once an hour; a
5-minute `ALIGN_DELTA` window holds it for about 5 minutes and then
empties, so the condition clears without deletion. The policy sends OPENED
and CLOSED notifications, never renotifies, and auto-closes after 30
minutes of missing data.

The request body (held outside the repository, so that the committed
monitoring file set is unchanged; no recipient is in it):

```json
{
  "displayName": "TEST - C1-D alert delivery check - delete after use",
  "combiner": "OR", "enabled": true, "severity": "WARNING",
  "userLabels": { "milestone": "c1d", "policy": "temporary-delivery-test" },
  "conditions": [{
    "displayName": "A reconciliation planning heartbeat was counted in the last 5 minutes (expected TRUE once an hour - this is a test)",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/dc46_reconciliation_plan_complete\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"processfilelinkrevocations\" AND resource.labels.location=\"australia-southeast1\"",
      "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_DELTA", "crossSeriesReducer": "REDUCE_SUM", "groupByFields": ["resource.labels.service_name"] }],
      "comparison": "COMPARISON_GT", "thresholdValue": 0, "duration": "60s",
      "evaluationMissingData": "EVALUATION_MISSING_DATA_INACTIVE",
      "trigger": { "count": 1 }
    }
  }],
  "alertStrategy": { "autoClose": "1800s", "notificationPrompts": ["OPENED", "CLOSED"] },
  "documentation": { "mimeType": "text/markdown", "subject": "TEST ONLY - Constrap alert delivery check (C1-D) - no action needed", "content": "(says it is a test, that a resolved email follows, and asks only for the arrival time)" }
}
```

Before creation, these were verified:
- Every field name and enum value, against the Monitoring v3 discovery document.
- That gcloud 593's bundled client supports
  `MetricThreshold.evaluationMissingData` and
  `AlertStrategy.notificationPrompts`.
- That no policy named TEST existed, and that five policies existed.
- That the Product Owner channel was resolved by name and was enabled.
- The last heartbeat time, read again just before creation (21:23:02 UTC).

Created with `gcloud monitoring policies create --project constrapp-69b5d
--policy-from-file=<body> --notification-channels=<Product Owner channel>`.
Deleted with `gcloud monitoring policies delete
projects/constrapp-69b5d/alertPolicies/10264183102153085239 --quiet`.

**Timeline — 24 November 2026, UTC.** *Cloud* means read from the
Monitoring API, Cloud Logging or the Admin Activity audit log; *Reported*
means stated by the Product Owner from the emails.

| Time (UTC) | Event | Evidence |
|---|---|---|
| 22:08:41 | `CreateAlertPolicy` audited; policy `10264183102153085239` created (record time 22:08:42.52), Product Owner channel only; read-back identical to the body (except the omitted default `thresholdValue` 0) | Cloud |
| 22:24:03.05 | The worker wrote `file-links: reconciliation plan complete` | Cloud (log) |
| 22:23:51–22:24:51 | Metric point with value 1; the minutes before and after read 0 | Cloud (time series). The ingestion time itself is not exposed; the point was present by 22:29:20 |
| 22:29:20 | Incident `0.ofehms6qj26w` OPENED: "is above the threshold of 0.000 with a value of 1.000" (`ViolationOpenEventv1`) | Cloud |
| by 22:32 (11:32 NZDT) | The opening email was received. It showed the correct test policy, the incident start 22:29 UTC, threshold 0 and observed value 1 | **Reported** by the Product Owner. The exact arrival time and the incident id were not visible in the screenshot |
| 22:33:35 | The condition "returned to normal with a value of 0.000" and the incident CLOSED (`ViolationAutoResolveEventv1`) — **natural recovery**, not deletion or auto-close | Cloud |
| by 22:34 (11:34 NZDT) | The recovery email was received, stating that the value returned to 0 | **Reported** by the Product Owner. Exact arrival time not visible |
| 22:34:58 | `DeleteAlertPolicy` audited; temporary policy deleted, 26 minutes after creation | Cloud |

Observed intervals, which are **not** service levels:

| Interval | Duration |
|---|---|
| Heartbeat line to incident open | 5 min 17 s |
| Incident open (closed at 22:33:35) | 4 min 15 s; the Product Owner's email shows 4 min 14 s |
| Incident open to opening email received | no more than about 4 min (bounded by the reported minute) |
| Recovery to recovery email received | no more than about 1.5 min (bounded by the reported minute) |

**Clean-up verified (Cloud, 22:35 UTC):**
- Exactly the five original policies remain, each byte-identical to its
  pre-test read and with unchanged mutation times, and each matches its
  repository file.
- No policy named TEST remains.
- Both channels are unchanged (no mutation since 16 November).
- Three incidents in all, none open; the test incident is kept as history.
- The Admin Activity audit log since 22:00 holds only the one create and the
  one delete.
- No error-level line from any service since 21:50.
- Worker `-00003-ceg` serves 100 % of traffic with 59 of 59 requests
  successful that hour, and the Scheduler job is `ENABLED`.
- The only Firestore writes, at 22:25–22:26, coincide with the worker's
  periodic sweep after the 22:24 planning pass, the same pattern as the
  20:22 / 20:23 pass. The test made no Firestore call. No business data was
  touched and no account was changed.

**What it proves:**
- The `DC46 - Product Owner` email channel delivers both an opened and a
  resolved notification from a metric-threshold policy, and the recipient
  received them within minutes.
- A threshold condition on a live series opens an incident and recovers by
  itself.

**What it does not prove:**
- That any of the five production policies fires on its real condition
  (only policy B ever has).
- Delivery through the `DC46 - Billing Administrator` channel. It was
  exercised on 16 November, with receipt reported and no times recorded.
- Whether the permanent policies send a resolved email. Their
  `notificationPrompts` is unset, so Google's default applies; log-based
  policy B notifies on opening only.
- Anything during a billing suspension.
- Exact email arrival times, which were not visible.

### Operational incident log

One dated entry per alert that opens and per manual finding, in the form
set out in [ops/RUNBOOK.md](../ops/RUNBOOK.md) §7. Earlier incidents are
recorded where they were written: *Billing interruption* (12–13 November
2026) under DC46-C.

- **17 November 2026 19:18:06 – 18 November 19:22:24 UTC — DC46 policy B,
  `DC46 file-link worker: error logged` (recorded 25 November 2026).**
  - *What happened:* an expected line at the activation of periodic
    reconciliation, not a failure.
  - *Noticed:* in the incident list during C1-D. It was not logged here at
    the time.
  - *Affected:* nothing.
  - *Evidence:* the first planning pass of revision `-00003-ceg` reported
    one overdue company (`reconciliation overdue`, 19:17:02). The sweep a
    minute later completed with zero failures.
  - *Cause:* the predicted first-pass overdue (*DC46-C* → *Activation
    runbook*).
  - *Done:* nothing; the incident auto-closed after 24 hours. Email receipt
    was not recorded.
  - *Follow-up:* none.
- **24 November 2026 22:29:20 – 22:33:35 UTC — temporary policy `TEST -
  C1-D alert delivery check - delete after use`.**
  - *What happened:* a deliberate, approved delivery test, not an incident.
  - *Affected:* nothing.
  - *Evidence:* *C1-D alert delivery acceptance record* above.
  - *Done:* the policy was deleted at 22:34:58 under the Lead Architect's
    approval.
  - *Follow-up:* none.

*As written 21 November 2026:* No entries yet.

## L3 Stage 2 — application error recovery — HOSTING ONLY (ADR-80; LIVE — released with the L4 Hosting deploy)

**Status update (25 November 2026):** the live Hosting bundle is
SHA-256-identical to a clean build of `main` `875910e` — VERIFIED read-only.
TESTING.md §66 E1–E10 was run on 25 November 2026 (TESTING.md §74.3): E1
passed in production, E3–E10 on local emulators only, and E2 did not pass as
written (tracker D3 #32). **Lead Architect, 25 November 2026 (REPORTED):**
E1 and E3–E10 accepted with their evidence limitations; **E2 open — L3
Stage 2 is not closed.** The next release in this area is the D3 #32
membership reliability fix (not yet briefed or implemented); it adds no
service worker and no PWA. *As written at the run:* Awaiting the Lead
Architect's decision.

**Status (22 November 2026):** LIVE. Merged to `main` as `b7f825f`. It
reached production in the L4 Hosting release, built from `main` `a30699e`,
which contains `b7f825f`. The ancestry is VERIFIED in Git; the deployment
is REPORTED passed by the Lead Architect (*L4* below). No separate Stage 2
deploy was made. TESTING.md §66 E1–E10 browser acceptance is not recorded.
The text below is kept as written on 21 November 2026.

*As written (IMPLEMENTED 21 November 2026 — NOT DEPLOYED):* Branch `fix/l3-application-error-recovery` (uncommitted). Client code only: no Firestore or Storage Rules, no Functions, no index, no environment value, no dependency.

**Release, when authorised:** architect review → merge to `main` → CI green → one Hosting deploy from a clean `main` build (`firebase deploy --only hosting`). Nothing else is deployed. No ordering constraint with any other component.

**Acceptance:** TESTING.md §66 E1–E10, on a test project.

**Rollback:** Firebase Console → Hosting → release history → roll back to the previous release. No data is migrated or reshaped by this change, so a rollback needs no data step.

**Release record:** released with the L4 Hosting deploy (`main` `a30699e`; REPORTED, 22 November 2026 — see the status above). *As written:* NOT DEPLOYED.

## L4 — BOQ → working budget transfer release order — ADR-81 — MERGE, AZURE GREEN, RULES, ONE callable, HOSTING (LIVE — production-accepted 22 November 2026)

**Status (22 November 2026, REPORTED by the Lead Architect):** L4 is LIVE
and CLOSED. Azure CI on `main` and every release step below passed; the
production financial acceptance and the acceptance UX correction (merged as
`d90e21f`, `main` `74c2a6f`) passed. Remaining browser gaps and the retained
sandbox: TESTING.md §67 → *L4 closure record*. The procedure below is kept
as written for the release.

*As written for the release (21 November 2026, IMPLEMENTED — NOT DEPLOYED):*
Branch `feature/l4-boq-budget-transfer` (uncommitted). Three components
change: Firestore Rules (the `budgetLines` create rule), ONE new callable
(`transferBoqToBudget`) and the Hosting bundle. No Storage Rules, index,
migration, secret, IAM or scheduler change. **No existing Function is
redeployed.**

**The sequence. Nothing is deployed to production before step 2 is green.**

1. Commit and merge the feature to `main`.
2. **Azure `main` pipeline GREEN** on that commit — the gate for everything below.
3. Deploy Firestore Rules.
4. Deploy ONLY the new `transferBoqToBudget` callable.
5. Verify the callable deployment.
6. Build and deploy Hosting.
7. Complete TESTING.md §67 acceptance (T1–T16) on a test project.

**Why this order.** Each step is compatible with the production state before
it. The Rules only refuse client creates of `boq-…` budget-line ids and of a
`boqSource` field; no deployed client writes either, and manual lines keep
random ids without a hyphen. The callable is unreachable from the deployed
bundle. Hosting last: the *Transfer to budget* button appears only when both
of its dependencies are live. Hosting first would show a button whose call
answers *not available on the server yet* (nothing is written); the callable
before the Rules would leave BOQ-sourced ids and provenance forgeable by a
client.

*Preconditions for step 3.* Steps 1 and 2 complete. From a clean `main`
checkout in `frontend/`: `npm run rules:transitional:check`,
`npm run functions:calc:check` and `npm run functions:transfer-calc:check`
clean; `wc -c firestore.rules` reads **232,776**. Confirm the live ruleset is
the 232,460-byte file of `main` `b7f825f`. Record the current Hosting version
id and Rules ruleset id. The local toolchain as for ADR-77 (firebase-tools
15.34.2, Java 21 or later for the emulators).

**STEP 3 — Firestore Rules.** From `frontend/`:
`firebase deploy --only firestore:rules --project constrapp-69b5d`
*Verify:* the Console shows a 232,776-byte ruleset; on the Budget tab a manual
line can still be added and corrected. *Compatibility:* the deployed app is
unaffected. *Rollback:* see **Rollback** below — these Rules are RETAINED in
an emergency, not reverted.

**STEP 4 — the ONE new callable.** From `frontend/`:
`firebase deploy --only functions:team:transferBoqToBudget --project constrapp-69b5d`
**The `team:` codebase prefix is REQUIRED** (*L2-B Stage B*, step 2 — the
unqualified form matches no function). Confirm the CLI's plan lists exactly
ONE function — a create of `transferBoqToBudget` — before accepting it; if it
lists any other function, stop. **Never `--only functions`** — that would
redeploy the eight team callables, `approveFinalAccount` and the DC46
reconciliation worker. `functions/.env.constrapp-69b5d` carries
`BOQ_BUDGET_TRANSFER_ENABLED=true` (architect decision, 21 November 2026); the
code default is `false` (fail closed), and the flag is read by this function
only. `FINAL_ACCOUNT_APPROVAL_ENABLED` and every other parameter are
unchanged. The predeploy chain runs the Functions lint and pure tests, which
include the generated-proposal checks and the flag pins.

**STEP 5 — verify the callable (read-only).** `gcloud run services list`
shows a NEW service `transferboqtobudget` at revision `-00001-*`; **every
other service — the eight team callables, `approvefinalaccount` and
`processfilelinkrevocations` — keeps the revision it had before step 4**
(record them before and compare). An unauthenticated request without App
Check to the new service is refused 401. Do not proceed to step 6 otherwise.

**STEP 6 — Hosting.** From the same clean `main` checkout in `frontend/`:
`npm run build`, then
`firebase deploy --only hosting --project constrapp-69b5d`

**STEP 7 — acceptance.** TESTING.md §67 T1–T16, on a test project.

### Rollback

**Emergency rollback — in this order, and normally no further:**

1. **Restore the previous Hosting release.** Firebase console → Hosting →
   release history → roll back to the recorded previous version (there is no
   `firebase hosting:rollback` CLI command). The *Transfer to budget* button
   disappears.
2. **Disable the new callable with its flag.** Set
   `BOQ_BUDGET_TRANSFER_ENABLED=false` in `functions/.env.constrapp-69b5d` and
   redeploy that ONE function
   (`firebase deploy --only functions:team:transferBoqToBudget --project constrapp-69b5d`).
   It then answers `boq-transfer-disabled` before any read. No other function
   is redeployed. Do not delete the function as a first resort.
3. **RETAIN the L4 Rules (232,776 bytes).**
4. **Preserve every working budget line**, BOQ-sourced ones included. Nothing
   is deleted, zeroed or migrated automatically.

**Why the Rules are not reverted.** The earlier ruleset (232,460 bytes) does
not reserve `boq-…` ids or the `boqSource` field. Once the callable has been
live, `budgetLines/boq-{costCodeId}` documents with server-written provenance
may exist. Under the earlier Rules a browser client could CREATE a line at an
unused `boq-` id carrying a forged `boqSource`, which the application would
then read as a trusted BOQ-sourced line. The L4 Rules are strictly more
restrictive than the earlier ones for clients and are compatible with both the
previous and the new Hosting bundle, so keeping them costs nothing.
**Any future Rules rollback or replacement must be separately reviewed for
compatibility with the BOQ-sourced lines already stored, and must keep the
reservation unless that review decides otherwise.** Before the callable has
ever been live (after step 3 only) the earlier ruleset is still compatible,
but reverting it then gains nothing either.

**State after an emergency rollback.** BOQ-sourced working lines remain on the
Budget tab as ordinary working lines; the previous bundle shows them without
the *From BOQ* label and lets a financial role correct `budgeted` and `notes`
as for any line (Rules still freeze `boqSource`). Any budget version already
approved from them is an ordinary SHIELD version and is unaffected.

### Failure recovery

- *A transfer that should not have been made.* Budget lines cannot be deleted.
  BOQ-sourced lines are unapproved WORKING data: correct the amount on the
  Budget tab (it is then shown as changed by hand), or void the BOQ items and
  use *Set this line to zero*. If no version was approved from them, no
  report, forecast, commitment or approved figure was affected.
- *A wrong approved version.* Not a transfer fault: approve a corrected version
  through SHIELD (ADR-70); approved versions are never edited.
- *The callable errors or times out.* The user sees an uncertain outcome and
  may send the same request again; an applied request is answered *already
  applied*. Check Cloud Logging for `boq transfer call failed`. Disable with
  the flag (Rollback step 2) if needed.
- *The audit record.* One `boq_budget.transferred` event per transfer that
  changed a line, in `companies/{c}/auditEvents` (Admin SDK / console only).

**Not created by this release:** no alert policy for `transferBoqToBudget`
failures (the L3 Final Account alert does not cover it). Adding one is a
separate operational authorisation.

**Release record:** NOT DEPLOYED.

---

## M2-A2 Stage A — External Project Isolation release order — ADR-83 — MERGE, AZURE GREEN, STAGE-1 RULES + STORAGE RULES, HOSTING, BACKFILL, FINAL RULES (STAGE A LIVE — released and production-accepted 23 November 2026)

**Status (23 November 2026, closeout):** Stage A is LIVE and CLOSED (Lead
Architect decision). Record: *Release record* at the end of this section.
The procedure below is kept as written for the release.

*As written for the release (23 November 2026, IMPLEMENTED — NOT DEPLOYED):* implemented on
`feature/m2-a2-external-project-isolation` (uncommitted). **Nothing in this
section has been run.** No commit, merge, deploy or production write. DC20
is open in production; external onboarding is blocked.

Four components change: Firestore Rules, Storage Rules, the Hosting bundle,
and production data (one new document per existing project, by an operator
script). No Function, index, secret, IAM or scheduler change. Every command
runs from `frontend/` unless stated.

**Sizes (`wc -c`):** `firestore.rules` **236,737** (budget 245,000; 8,263
headroom); `firestore.m2a2-transitional.rules` **237,176**; `storage.rules`
**10,323**.

### The Stage-1 ruleset — which file, and which file NOT

- **Publish `firestore.m2a2-transitional.rules`** (through
  `firebase.m2a2-transitional.json`). It is derived by
  `npm run rules:transitional` and differs from `firestore.rules` in a
  six-line header comment and exactly two rule lines: the project-create and
  project-update directory pairing. Every read rule, the directory block and
  every other write rule are the FINAL ones.
- **Do NOT publish `firestore.transitional.rules`** (`firebase.transitional.json`).
  That file belongs to the ADR-63 / ADR-65 / ADR-68 releases and relaxes four
  lines whose FINAL forms are live: the variation scope pair, the progress
  claim `variationLineCount` and invoice-link keys at create, the activity
  revision contract, and the invoice-link keys on claim approval. Publishing
  it would weaken production. It is kept only because existing tests derive
  from it; retiring it is a separate task.

### Preconditions

1. Architect approval; commit; merge to `main`.
2. **Azure `main` GREEN on the merge commit. No production step before it.**
3. Read-only check that production still matches the previous `main`
   (Firestore ruleset 232,776 bytes, Storage ruleset 9,271 bytes).
4. `npm run rules:transitional:check` clean on the release checkout.
5. Read-only count of active `client` / `subcontractor` / `super_admin`
   users. Zero were active on 23 November 2026. Any that exist lose all
   project access at step 1 below until Stage B assigns them — tell the
   Product Owner first.

### Release order

Each step needs its own authorisation.

1. **Stage-1 Firestore Rules and Storage Rules.**
   `firebase deploy --only firestore:rules --config firebase.m2a2-transitional.json --project constrapp-69b5d`
   then `firebase deploy --only storage --project constrapp-69b5d`.
   From here the read boundary is final: the project document is
   internal-only and external reads need an assignment. The bundle still
   being served keeps creating and editing projects.
   Verify read-only: the published Firestore ruleset is byte-identical to
   `firestore.m2a2-transitional.rules`, the Storage ruleset to
   `storage.rules`; an internal user opens Projects, a drawing and a document.
2. **Hosting.** `firebase deploy --only hosting --project constrapp-69b5d`
   from a clean build of `main`. Verify the served bundle against the build;
   as an internal user create a test project and edit a project — each
   writes its directory entry.
3. **Directory backfill** (from `frontend/functions`, operator's own ADC):
   - Dry run — reads only, writes nothing:
     `node scripts/backfill-project-directory.mjs --project constrapp-69b5d`
     **This is the production check of the source data types.** Review every
     line. `INVALID` (a source value of the wrong type), `MISMATCH` (an entry
     that differs from its project) and `ORPHAN` are refused and make the
     script exit 1; fix each by saving the project in the app, never by hand.
   - **Apply — only with a separate, explicit Product Owner authorisation
     given after the dry-run output has been reviewed:**
     `node scripts/backfill-project-directory.mjs --project constrapp-69b5d --apply`
     It creates missing entries only, each in a transaction that re-reads the
     project; it never overwrites, never deletes and never touches a project
     document. It writes no audit event — keep the terminal output as the
     record.
   - Run the dry run again. **Gate for step 4: `missing 0 · invalid 0 ·
     mismatch 0 · orphan 0 · failed 0`, and `in sync` equal to the number of
     projects.**
4. **FINAL Firestore Rules.** Only when the gate in step 3 is met:
   `firebase deploy --only firestore:rules --project constrapp-69b5d`.
   Verify byte-identical to `firestore.rules`. From here a project cannot be
   created, or have a display field changed, without its entry.
   A browser tab still running the pre-M2-A2 bundle can no longer create or
   edit a project until it is reloaded.

Then TESTING.md §68 (internal regression). The external checks there need
Stage B (*M2-A2 Stage B*, below — LIVE since 23 November 2026; the external
checks X1–X7 PASSED in production on 23–24 November 2026). *As written for
the release:* Stage B (*M2-A2 Stage B*, below — IMPLEMENTED, NOT DEPLOYED).

### Rollback

Roll back in the reverse order. **No step below reopens Deferred Control 20
except the last one, which is never routine.**

| Undo | Action | Effect on the boundary |
|---|---|---|
| Step 4 | Republish the Stage-1 ruleset (step 1's first command) | None — the read boundary is identical |
| Step 3 | Nothing. Entries are inert; leave them | None |
| Step 2 | Restore the previous Hosting release in the Firebase console (there is no CLI rollback). **Only while the Stage-1 ruleset is published** — under the FINAL ruleset the old bundle cannot create or edit projects, so undo step 4 first | None |
| Step 1 | Republish the pre-M2-A2 Firestore ruleset and Storage ruleset | **REOPENS DC20:** every member again reads every project document (headline budget included), drawing, revision and project document of the company |

Rules for the last row:

- It requires a separate Product Owner authorisation that names the
  exposure. It is not part of an emergency Hosting rollback.
- It is acceptable only while no `client` or `subcontractor` holds an
  assignment and none is active. Check first, read-only.
- After Stage B onboards an external user, do not use it: deactivate the
  external members instead, then investigate.
- Undo step 2 before it — the M2-A2 bundle writes directory entries, which
  the old ruleset has no block for, so project create and edit would fail.
- Firestore and Storage are rolled back together or not at all; rolling back
  one alone leaves files or records readable without the other.

### Failure recovery

- **Step 1 publishes, an internal page fails:** undo step 1's Firestore
  publish only if the failure is a read the internal roles need; otherwise
  fix forward. Record what failed first.
- **Project create or edit denied after step 2:** the Stage-1 ruleset is not
  the published one — check which ruleset is live before anything else.
- **Backfill reports a refusal:** do not proceed to step 4. The Stage-1
  ruleset is safe to leave published for as long as it takes.

### Release record

**23 November 2026 — released; CLOSED and production-accepted (Lead
Architect).** Merged as `0c941f1`, `main` `22cf7db` (VERIFIED in Git). Azure
CI on that commit was not read in this record.

| Step | State | Evidence |
|---|---|---|
| 1a. Stage-1 Firestore Rules | Done | REPORTED by the Product Owner; superseded by step 4, so not readable afterwards |
| 1b. Storage Rules | **Done late** — ruleset `2f3a4788…`, 10,323 bytes, released 03:04 UTC | VERIFIED read-only, byte-identical to `main`. Published after step 4: the first acceptance pass found the pre-M2-A2 ruleset `8b8edc14…` (9,271 bytes) still live |
| 2. Hosting | Done — `index-BOg2hoYg.js` | VERIFIED: SHA-256-identical to a clean build of `main` `22cf7db` |
| 3. Backfill | Done — 9 of 9 | REPORTED by the Product Owner. VERIFIED before the acceptance test: 9 projects, 9 matching entries |
| 4. FINAL Firestore Rules | Done — ruleset `67b6425a…`, 236,737 bytes, released 02:50 UTC | VERIFIED read-only, byte-identical to `main` |
| Acceptance | **PASSED** | TESTING.md §68 → *Production acceptance record* |

**Deviation, recorded.** Between the Stage-1 publish and 03:04 UTC the
Firestore read boundary was in force while Storage still allowed any company
member to fetch a drawing or project-document file by path. No active
external user existed (read-only, 23 November 2026). For a later release
that changes both rulesets, verify the Storage release before moving past
step 1.

**No rollback was used.** The rollback table above still applies:
republishing the pre-M2-A2 Firestore or Storage ruleset reopens Deferred
Control 20 and needs its own authorisation.

## M2-A2 Stage B — External provisioning release order — ADR-84 — MERGE, AZURE GREEN, THREE CALLABLES; no Rules, no Hosting (STAGE B LIVE — released 23 November 2026; production-accepted and CLOSED 24 November 2026)

**Status (24 November 2026, closeout):** Stage B is LIVE and CLOSED (Lead
Architect decision). The three callables were deployed on 23 November 2026
and the production acceptance (TESTING.md §69, S1–S3, R1–R3, P1–P14) PASSED
in the isolated test company by 24 November 2026 00:50 UTC. Record: *Release
record* at the end of this section. **Real customer external onboarding
remains BLOCKED pending a separate readiness decision** (SECURITY.md →
*External Project Isolation — M2-A2 Stage B*). The procedure below is kept as
written for the release.

*As written for the release (23 November 2026, IMPLEMENTED — NOT DEPLOYED):* implemented on
`feature/m2-a2-external-provisioning` (uncommitted, from `main` `10807b8`).
**Nothing in this section has been run.** No commit, merge, deploy, script
run against production, account creation or production write. External
onboarding is BLOCKED until step 5 passes.

**What changes in production:** three existing callables are redeployed.
Nothing else — no Firestore Rules (still 236,737 bytes), no Storage Rules,
no Hosting bundle (the build is still `index-BOg2hoYg.js`), no new function,
index, parameter, secret, IAM binding or scheduler job. Every command runs
from `frontend/` unless stated.

| Callable | Why it is redeployed |
|---|---|
| `acceptInvitation` | Writes or removes `users/{uid}.projectIds` with the membership; re-validates the stored role and every project |
| `deactivateMember` | Removes `projectIds` in the commit that ends the membership |
| `resendInvitation` | Email wording only: names the *Client* and *Subcontractor* roles |

The other five team callables, `approveFinalAccount`, `transferBoqToBudget`
and the `processFileLinkRevocations` worker are **not** redeployed. Their
source changed only in ways they do not execute (a new revocation reason
written by the operator script; a guard in the shared invitation library
that the callable's own schema already enforces).

### Release order

**STEP 1 — merge and CI.** Commit, merge to `main`, Azure `main` GREEN. No
production step before it.

**STEP 2 — pre-flight (read-only).** Clean `main` checkout. Confirm the live
Firestore ruleset is the 236,737-byte file and the Storage ruleset the
10,323-byte file of `main` (Stage A). Record the current revision of every
service: `gcloud run services list --region australia-southeast1 --project constrapp-69b5d`.

**STEP 3 — the three callables.**
`firebase deploy --only functions:team:acceptInvitation,functions:team:deactivateMember,functions:team:resendInvitation --project constrapp-69b5d`
The `team:` codebase prefix is REQUIRED on each name. Confirm the CLI's plan
lists exactly THREE updates before accepting it; if it lists any other
function, stop. **Never `--only functions`.** The predeploy chain runs the
Functions lint and pure tests.

**STEP 4 — verify (read-only).** The three services show a new revision;
**the other eight keep the revision recorded in step 2.** A request without
App Check to each of the three is refused 401. In the application, as a
Company Admin: Settings → Team loads; an internal invitation can be created
and revoked (TESTING.md §69 → R1–R3).

**STEP 5 — production acceptance (TESTING.md §69 P1–P14),** in an isolated
test company, each `--apply` on its own Product Owner authorisation. Only
when it passes is external onboarding unblocked — and that is a separate
decision, recorded in ROADMAP.md and SECURITY.md.

**The operator scripts must not be applied before step 3.** The callables in
production today would accept an external invitation and write the role
without the assignment (the member would read nothing), and would not clear
an assignment on deactivation.

### Operator provisioning workflow

Credentials: the operator's own login, as for the bootstrap script (*L1*):
`gcloud auth application-default login`. A key file is refused
(`GOOGLE_APPLICATION_CREDENTIALS` must be unset). The identity needs
Firestore read / write and Firebase Authentication **read**; the scripts
never write to Authentication. Run from `frontend/functions/` on a clean
`main` checkout.

1. **Dry run** — reads only:
   `node scripts/provision-external-member.mjs --project <firebase-project-id> --company-id <companyId> --email <address> --role client|subcontractor --project-ids <id>,<id>`
   It confirms the company, the email's account state, the role and every
   project, and warns when a project has no directory entry.
2. **Apply** — one of:
   - `… --apply --no-link` — PREFERRED. The link is discarded. A Company
     Admin opens Settings → Team → Pending invitations and presses *Resend*:
     a fresh link is emailed to the invited address, and acceptance then
     marks the account email-verified.
   - `… --apply --link-file <path outside the repository> --app-url https://app.constrap.com`
     — the link is written to a NEW file, mode 0600. Hand it over on a
     trusted channel and delete the file. *(Since operator tooling safety:
     the folder's real path is checked, and exit 3 means the invitation exists
     but the file was not written — recover with Resend, never a re-run; see
     *Operator tooling safety*.)* It proves nothing about the
     mailbox.

   Neither form prints the link, a token or a password. No account is
   created.
3. **The invitee accepts** in the application: registers (or signs in) with
   the invited email and accepts. The membership and the assignment are
   written together. Until then they have no access.
4. **Change the projects later** — dry run first, then `--apply`:
   `node scripts/set-member-projects.mjs --project <firebase-project-id> --company-id <companyId> (--uid <uid> | --email <address>) (--set <ids> | --clear | --add <ids> --remove <ids>)`
5. **End the membership** — a Company Admin deactivates the member in
   Settings → Team (existing). The assignment is removed with it.
6. **Check** — `node scripts/reconcile-membership.mjs --project <firebase-project-id>`
   reports R7 / R8 / R9 (assignments that should not exist or are broken).

**Removal is not instant for copied links.** After step 4 with a removal, or
step 5, the Rules deny at the next request. A download URL the member copied
earlier may keep working until the background sweep completes; the Team page
shows *Old file links: revocation pending* until then.

**Do not paste a link file's contents into a terminal, a ticket or a chat.**
*As written for Stage B:* the older `bootstrap-company.mjs` still printed its
link; when a test company was bootstrapped for step 5, the Product Owner ran
it themself. *Since operator tooling safety (24 November 2026, PENDING
INTEGRATION):* it is dry-run by default and never prints the link — see
*Operator tooling safety* below.

### Rollback

No data migration and no Rules change, so the rollback is the three
callables only.

| Situation | Action | Effect |
|---|---|---|
| A redeployed callable misbehaves | From a checkout of `main` at the pre-Stage-B commit (`10807b8`): the step 3 command | Acceptance again writes no assignment (an external member accepted afterwards reads nothing — fail closed); deactivation again leaves the field (inert: a deactivated profile has no company, and the Rules deny) |
| Stop all team operations at once | `TEAM_MANAGEMENT_ENABLED=false` in `functions/.env.constrapp-69b5d` and redeploy the affected callables | They answer `team-management-disabled`; no data is touched |
| An external member must lose access now | Deactivate them in Settings → Team (works on both versions), or `set-member-projects.mjs --clear --apply` | Denied at the next request; old links follow the sweep |
| A pending external invitation must not be used | Revoke it in Settings → Team | The link is refused |
| A stray assignment after a rollback | `reconcile-membership.mjs --fix` (F2) | Removed, with an audit event |

**Assignments already written stay in force after a Functions rollback** —
the Rules (Stage A) honour them. Rolling the code back does not remove
anyone's access; deactivation does.

**Never** republish the pre-M2-A2 Firestore or Storage ruleset while any
`client` or `subcontractor` is active (*M2-A2 Stage A → Rollback*).

### Release record

**23 November 2026 — released; 24 November 2026 — production-accepted and
CLOSED (Lead Architect).** Merged as `cddfca8`, `main` `bd9021c` (VERIFIED in
Git). Azure CI on that commit was not read in this record.

| Step | State | Evidence |
|---|---|---|
| 1. Merge and CI | Done — `main` `bd9021c` | VERIFIED in Git; Azure result not read here |
| 2. Pre-flight | Done | Firestore ruleset `67b6425a…` (236,737 bytes) and Storage ruleset `2f3a4788…` (10,323 bytes) live and unchanged by Stage B — VERIFIED read-only 23 and 24 November 2026 |
| 3. Three callables | Done — `acceptinvitation-00005-mol` (created 23 November 2026 09:11:18 UTC), `deactivatemember-00005-suy` (09:11:28), `resendinvitation-00005-mer` (09:11:28) | VERIFIED read-only: the uploaded source archive of each is identical to `frontend/functions` on `main` (method: the `gcf-v2-sources` object generation of each service) |
| 4. Verify | Done | VERIFIED read-only, 23 and 24 November 2026: the other eight services kept their revisions (`createinvitation-00004-xuj`, `previewinvitation-00004-nuy`, `listteam-00004-wax`, `changememberrole-00004-dul`, `revokeinvitation-00004-giw`, `processfilelinkrevocations-00003-ceg`, `approvefinalaccount-00003-jad`, `transferboqtobudget-00001-zol`); Hosting still `index-BOg2hoYg.js`. The 401-without-App-Check probe of the three callables is **not recorded**. R1–R3 PASSED (TESTING.md §69) |
| 5. Production acceptance | **PASSED** — S1–S3, R1–R3, P1–P14, §68 X1–X7, §63 P19–P20 (both external roles) | TESTING.md §69 → *Production acceptance record*; [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → B2 |

**Isolated test company retained** — `constrap-acceptance-test`
(*Constrap Acceptance — TEST (not a customer)*), bootstrapped 23 November
2026 20:10 UTC with `bootstrap-company.mjs` (a deliberate production write,
Product-Owner-authorised). End state, VERIFIED read-only 24 November 2026
00:50 UTC: the TEST Company Admin active (kept for regression testing); the
QS, the subcontractor and the client test accounts **deactivated, Auth
disabled, no `projectIds`**; three projects and five synthetic file fixtures
retained, no download token on any; directory 13 / 13 in sync;
`reconcile-membership.mjs` (report only) 0 findings across the project.
Apex Builders unchanged from the pre-test baseline. Do not delete the test
company or its records.

**Deviations, recorded.** None in the release. During acceptance: the
first P5 *registered* report had no production trace (the registration was
repeated and then verified); one positive control for P9 minted a download
token on one fixture by an architect-approved member request, removed by the
urgent sweep that P8 queued. Neither changed the release.

**No rollback was used.**

## Operator tooling safety — scripts only (D3 #1–#3; IMPLEMENTED — PENDING INTEGRATION, 24 November 2026)

Branch `feature/operator-tooling-safety` (uncommitted, awaiting architect
review). **No deployment is required and none is planned.** Nothing deployed
changes: no Firestore or Storage Rules, no Hosting, no callable, no
`frontend/functions/src/**` file. The changed files are operator scripts under
`frontend/functions/scripts/`, the local emulator launcher
`frontend/scripts/team-dev.mjs`, tests and documentation. The scripts are part
of the Functions source upload but are never imported by `src/index.js`; a
future Functions deploy would carry them inert.

### Safe bootstrap procedure (`bootstrap-company.mjs`)

Credentials and checkout as for every operator script: the operator's own
`gcloud auth application-default login` (a key file is refused), a clean
`main` checkout, run from `frontend/functions/`.

1. **Dry run** — the default; reads only:
   `node scripts/bootstrap-company.mjs --project <firebase-project-id> --company-id <slug> --company-name "<Name>" --admin-email <email> [--country AU --currency AUD]`
   It reports whether the company would be created or reused, whether the
   email is already an admin (nothing to do), and whether an invitation would
   be created or a pending one exists. `--dry-run` is still accepted.
2. **Apply** — exactly one delivery option:
   - `… --apply --link-file <path> --app-url https://<origin>` — the link is
     written to a NEW file, mode 0600. The file must not exist (a symbolic
     link counts as existing), must lie outside the repository (checked on the
     folder's real path), and its folder must belong to the operator and not
     be writable by others unless sticky. The file is created exclusively
     **before** any production write; a bad destination writes nothing. Hand
     the link over on a trusted channel, then delete the file. It proves
     nothing about the mailbox (the admin's account is not marked
     email-verified).
   - `… --apply --no-link` — the link is discarded. Deliver it later with
     step 3, or — only when the company already has an active Company Admin —
     that admin presses *Resend* in Settings → Team, which emails a fresh link.
3. **A pending invitation is never replaced silently.** If one exists for the
   email, `--apply` is refused (exit 1). `--apply --rotate (--no-link |
   --link-file <path>)` gives that same invitation a new token: the link
   handed out before stops working; no second invitation is created; one
   `invite.resent` audit event. `--rotate` refuses when there is nothing
   pending, and refuses a pending invitation for any role other than
   `company_admin` (revoke that one in the Team page).

Exit codes: 0 done, dry run or nothing to do · 1 refused or failed · 2 usage ·
**3 the invitation committed but the link file could not be written.**

### Migration from the previous command line

| Before (wrote by default, printed the link) | Now |
|---|---|
| `… --dry-run` | Unchanged (a dry run is the default; `--dry-run` still accepted) |
| `… --app-url <origin>` (the old *write* command) | **Now a dry run**; nothing is written. Add `--apply` and a delivery option |
| `… --app-url <origin>` redirected to a 0600 file to capture the link | `… --apply --link-file <path> --app-url <origin>` |
| Re-running before acceptance rotated the token | `… --apply --rotate (--no-link \| --link-file <path>)` — explicit |
| `--app-url` accepted any URL | An origin only (`https://host[:port]`); https outside the emulators; only with `--link-file` (rejected with `--no-link`) |
| `--apply` with `--dry-run`, both delivery options, or neither | Refused (exit 2) |

`npm run test:team` (emulators only) now runs the bootstrap with
`--apply --link-file` in a private temporary folder, reads the emulator link
back, shows it and deletes the folder. *Launcher corrections (architect
review, 24 November 2026):* it now waits — one bounded 120 s deadline, a real
request every 300 ms, no fixed sleep — for the Auth emulator (its project
config endpoint), Firestore (`/` answers *Ok*), Functions and the CLI's *All
emulators ready* signal before the bootstrap runs; Vite is started with
`--host 127.0.0.1`, the address the launcher probes and the links use
(links are now `http://127.0.0.1:<port>/…`, not `localhost`, which can
resolve to `::1` only); shutdown waits (bounded, 10 s) for the children to
exit before forcing them.

### Failure and recovery

| Situation | What happened | Recovery |
|---|---|---|
| Refused in the dry-run pass (rename, active member, pending invitation without `--rotate`, nothing to rotate, role mismatch) | Nothing written; no link file created | Fix the cause; re-run |
| Refused inside a transaction (a race: an invitation created, accepted or revoked meanwhile) | That transaction rolled back; exit 1; the reserved link file removed. A company created in the same run stays (with its `company.bootstrapped` event) — a re-run reuses it | Re-run the dry run, then apply |
| Link file not written after the commit (disk full, I/O error) — exit 3 | The invitation **exists and is pending**; the output names it; the partial file was removed; the link was **not** shown and nothing was retried | `… --apply --rotate --link-file <a new path>` — same invitation, new link; the lost one is dead. **Do not** re-run without `--rotate` (it is refused) |
| The operator lost the link file before handing it over | The invitation is pending | `--apply --rotate --link-file <new path>` |
| The link may have leaked | The invitation is pending | `--apply --rotate --no-link` kills it at once; or a Company Admin revokes it in the Team page |

### Process lifecycle — all four older scripts

`bootstrap-company.mjs`, `backfill-project-directory.mjs`,
`reconcile-membership.mjs` and `revoke-file-links.mjs` no longer call
`process.exit()`. They return an exit code to the shared
`runOperatorScript` (`scripts/_cli.mjs`), which sets `process.exitCode` and
then awaits `Firestore.terminate()` — which waits for every in-flight request,
including the rollback the SDK sends without awaiting after a failed
transaction. Only if shutdown takes longer than 30 s does it force the exit. That clock
starts only after the operation has settled, and a cleanup that times out or
throws is printed as an explicit **failure** (`✖ Cleanup did NOT complete …` /
`✖ Cleanup is INCOMPLETE …`, with what may be left locked) — never as a clean
shutdown. The exit code stays the operation's own, because it describes the
data; nothing is retried. **Measured on the emulator (24 November 2026):** with the
old `process.exit(1)`, the document a refused transaction had read stayed
locked for about a minute (`ABORTED: Transaction lock timeout`); with the
change it was free at once. No script retries a refused or failed mutation.
Exit codes are unchanged (revoke-file-links keeps 3 for an unfinished
company).

### External provisioning link file (D3 #16 — corrected)

*As first written:* `provision-external-member.mjs --link-file` checked the
repository boundary on the path as typed, so a folder that is a symbolic link
into the working tree was not caught. **Demonstrated on `main`'s script
(emulator, 24 November 2026): exit 0 and the link file was created inside the
repository as an untracked file** (removed at once). It now uses
`scripts/_linkFile.mjs`, exactly as the bootstrap: real-path repository check
before and after creation, an existing file or any symbolic link refused,
exclusive 0600 creation before the invitation is written, the partial file
removed on a failed write. A link file that cannot be written **after** the
invitation committed now exits **3**, names the invitation and says how to
recover: a Company Admin's *Resend* (emailed fresh link; the lost one dies),
or *Revoke* in the Team page and run the script again. A plain re-run is
refused (`invite-pending`); the script never rotates and never creates a
second invitation. `set-member-projects.mjs` is unchanged.

### Local emulators and credentials (limitation, unchanged)

Observed in the launcher end-to-end run (24 November 2026, `--debug`): the
Firebase CLI makes one authenticated metadata request for the emulator project
id (`GET firebase.googleapis.com/v1beta1/projects/constrapp-rules-test/adminSdkConfig`
→ **403**, the operator has no access to that id; no production project is
read), and firebase-tools hands the operator's **CLI login** to the Functions
emulator as Application Default Credentials (it writes
`~/.config/firebase/<user>_application_default_credentials.json`). Storage
and Pub/Sub are not emulated, so a non-emulated call from function code would
reach Google with those credentials; nothing in the launcher's flows makes
one (the file-link worker is scheduled and never fires there). The same holds
for `npm run test:functions`. A `demo-` emulator project id would remove both;
that is a separate change (the `.env` file, the harness and the suites).

### Acceptance still required

- Architect review and Git integration; Azure `main` green.
- No production dry run is needed for this review (architect, 24 November
  2026). No production `--apply` is needed to accept this change.

## D3 #32 membership resolution correction — Hosting only — NOT YET DEPLOYED (prepared 26 November 2026; `fix/membership-resolution-state`, pending integration)

**Hosting only.** No Firestore Rules, Storage Rules, Functions, index,
monitoring or Auth-configuration change; no data migration. Preflight
complete: a read-only production membership inventory found no profile that
the corrected gate would newly restrict (TESTING.md §75.11).

From the released commit on `main`, working directory **`frontend/`**:

```
cd frontend
npm ci
npm run lint && npm run test:unit && npm run build
firebase deploy --only hosting --project constrapp-69b5d
```

Then: TESTING.md §75.9 and §75.10 (release identity; normal sign-in as the
TEST Company Admin; E2-A; E2-B). Rollback: the previous release in the
Firebase Hosting console. D3 #32, D3 #34 and L3 E2 stay open until those
checks are recorded.
