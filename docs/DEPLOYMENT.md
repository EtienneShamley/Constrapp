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

**Rollback.** Hosting: redeploy the previous build (`firebase hosting:rollback`
or re-run the deploy from the 1C commit) — nothing in 1D is needed by earlier
bundles. Rules: the revised ruleset can stay published after a Hosting
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

**New-Scope Variation Claim & Invoice Integration — M3-B2 (ADR-63): IMPLEMENTED
— NOT YET DEPLOYED. THREE STAGES, FIREBASE-CLI DRIVEN: TRANSITIONAL RULES →
HOSTING → FINAL RULES.**

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

### Constrapp GANTT™ — Programme 1A1 (ADR-64) — Hosting-only release

**Status: IMPLEMENTED — NOT YET DEPLOYED.** The release is the plain Hosting
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

**Rollback:** `firebase hosting:rollback` to the previous release. Because no
document, field or rule changed, the previous bundle's Timeline tab works
unchanged on the same data, and old and new bundles can coexist across open
tabs with no data effect. There is no financial-correctness constraint on
rolling this release back.

**Not sequenced behind anything by data, but by release hygiene:** confirm
the M3-B2 (ADR-63) three-stage release has reached its FINAL stage before
building a GANTT 1A1 bundle from `main`, so that one Hosting deploy never
carries an unreleased rules-dependent change by accident.

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
