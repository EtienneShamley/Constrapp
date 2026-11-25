# Constrap — ChatGPT Development Handover

Operational handover for a **new ChatGPT (architect) conversation**. It lets a
fresh session resume Constrap development without the previous conversation
history. It is an index and a checkpoint, **not** a second copy of the
documentation: where this file and a source document disagree, the source
document wins and this file must be corrected.

**Last updated:** 26 November 2026 (NZDT), **D3 #32 production verification and L3 closeout** revision. On `docs/l3-membership-closeout` (uncommitted, documentation only; awaiting the Lead Architect's review).

**L3 Stage 2 — CLOSED within its accepted scope. D3 #32 CLOSED. D3 #34
CLOSED.** (TESTING.md §76; tracker B12.)

- **Release.** `main` `0bdca38` (commit `893bed3`), Hosting release
  `edc2bf6f34568d78`, 25 November 2026 20:32:18 UTC, deployed by the Product
  Owner. The live bundle on all three origins is identical to a build of
  that commit. Firestore and Storage Rules are byte-identical to the
  repository and unchanged since 23 November; no Function or monitoring
  change.
- **Membership.** 9 profiles: 3 admitted (all `company_admin`), 6
  deactivated, none malformed, **none newly restricted**. Every enabled Auth
  account has a profile.
- **Production acceptance (TEST Company Admin, `constrapp-69b5d.web.app`
  only).** Normal start-up, project access and reload PASS with no notice
  and no console error. **E2-A PASS:** *Waiting for the server*, never a
  denial, no protected content, recovery in 1.8 s without a reload.
  **E2-B PASS:** an established session through a 30 s disconnection with
  no screen change and no sign-out; and the project route's own *Waiting
  for the server* with recovery in 1.7 s.
- **How, and its limit.** DevTools request blocking is not available to the
  browser extension. The application was loaded in a same-origin frame
  whose `fetch` / `XMLHttpRequest` were made to fail for the Firestore host.
  It is the released bundle on production data; the failure is injected at
  the request API, not on the wire, and not in a top-level tab.
- **E2-C** was not run in production and stays a limitation: no service
  worker, no offline start-up. A future offline-first PWA requirement.
- **Integrity.** No production write. Between the before and after
  snapshots only the reconciliation worker's own document changed. Test
  identities still disabled. 111 financial register documents unchanged.
- **New production observation, recorded against D3 #36:** every cold load
  of a project URL shows *Project not found.* for 55–100 ms before the
  company read answers. Not introduced by this release.
- **Open, preserved:** E2-C; D3 #33 (P3); D3 #35 (GST rounding assessment);
  D3 #36 (P2, before customer onboarding); GST §44 steps 1–3; Dashboard §22
  checks 2–3; D3 #11 (58 older write sites).
- **Next milestone: client credit-note architecture assessment and ADR**
  (with the D3 #35 rounding-semantics assessment; then the Rules capacity
  assessment). Needs its own brief.

*As written for the correction revision:* 25 November 2026 (NZDT), **D3 #32 membership resolution correction** revision.

**D3 #32 — IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**
(TESTING.md §75; tracker B11). On `fix/membership-resolution-state`,
uncommitted, awaiting the Lead Architect's review. Not deployed.

- **Root cause.** With the Firestore backend unreachable the SDK answers the
  `users/{uid}` listener at once from its empty cache with a document that
  "does not exist". The profile provider took that as a settled answer and
  the membership gate said *No active membership* to a real member.
- **Correction.** Only a server-confirmed snapshot decides membership. A
  cache-only answer shows *Waiting for the server*; it neither denies nor
  admits. The listener asks for metadata changes, which is what delivers the
  server's confirmation that a document really is missing. A session that
  was already confirmed is unchanged by a dropped connection. Three source
  files: `hooks/useProfile.jsx`, `lib/team.js`, `components/MembershipGate.jsx`.
- **Authorisation is not weakened.** The gate is client-side presentation.
  Firestore and Storage Rules were not changed and still decide every read
  and write. A cached active profile no longer enters the shell.
- **Evidence.** Unit 103 files / 5,333 tests after the architect corrections
  (89 new; 5,315 at the first report; the regression test
  fails against `main`'s source). Local browser acceptance on emulators:
  E2-A and E2-B PASS; deactivation, role change, refused read, identity
  switch and an L3 uncertain write PASS. **Nothing was run against
  production.**
- **D3 #34.** E2 is rewritten as E2-A (application loaded, Firestore
  unreachable before membership is resolved), E2-B (membership confirmed,
  then data unavailable) and E2-C (full offline hard reload). E2-C is a
  recorded limitation: Constrap has no service worker and does not start
  offline. Kept as a requirement for a future PWA / offline-first increment.
- **Deployment.** Hosting only. No Rules, Functions, index, monitoring, Auth
  configuration or data change.
- **L3 is not closed; E2 stays OPEN** until the correction is deployed and
  E2-A / E2-B are run in production (TESTING.md §75.9).
- **Architect corrections (25 November 2026 — REPORTED; implemented
  26 November; TESTING.md §75.10).** Accepted in principle. The 22–25 ms
  waiting notice is **accepted** — no delay, timer or debounce. Local E2-A
  and E2-B accepted. **The gate now refuses a server-confirmed profile with
  a missing, malformed or unsupported role, or a non-string `companyId`:**
  a *needs attention* notice, no shell, no automatic sign-out, and it admits
  by itself once the record is corrected. The six documented roles are
  admitted, read from the one existing role table (`lib/formatters.js`).
  Every backend path (acceptance, bootstrap, reactivation, role change)
  writes a valid role, so no supported lifecycle changes and no migration is
  needed. A numeric `companyId` used to crash the company provider above the
  gate; corrected with a one-line guard.
- **Release preflight (Lead Architect, 26 November 2026 — REPORTED: GO for
  integration, subject to the preflight; TESTING.md §75.11).** `super_admin`
  retained with no added permission; legacy profiles preserved; the
  `CompanyProvider` guard approved; **D3 #36 is P2, before customer
  onboarding, not blocking.** **Production membership inventory (read-only,
  aggregates): 9 profiles — 3 valid active, all `company_admin`, 2 of them
  legacy; 6 deactivated; none malformed; none newly restricted.** One more
  gap closed: a `companyId` string containing `/` could throw or resolve to
  another path; the existing id contract now applies. Unit 5,336.
  **Deploy (Hosting only), from `frontend/`:** `npm ci`, `npm run lint &&
  npm run test:unit && npm run build`, `firebase deploy --only hosting
  --project constrapp-69b5d`. D3 #32, D3 #34 and L3 E2 stay pending
  production verification.
- *As asked at the corrections report — now decided above:* `super_admin` is admitted because it is a
  documented role that may exist on a production profile — confirm or
  reverse. A hand-provisioned production profile with a missing or misspelt
  role would now see the notice; not checked (no production read).
- **New tracked finding D3 #36** — cache-only answers are still taken as
  final in `CompanyProvider` and on Dashboard, Projects and Portfolio.
  Recorded, not corrected; reliability hardening and offline design.
- *As asked at the first report — now decided above:* (1) a 22–25 ms *Waiting for the
  server* notice on a same-tab sign-out and sign-in — accept, or add a
  presentation delay; (2) the gate still admits a server-confirmed profile
  that has a `companyId` but no usable role (unchanged behaviour; the Rules
  refuse it everything) — tighten or leave; (3) the company read and three
  list pages still ignore `fromCache` (unchanged; out of scope).
- **Preserved:** D3 #33 (P3, deferred); D3 #35 and the rounding-semantics
  assessment; no financial calculation changed; the decided order of work.

*As written for the decision revision:* 25 November 2026 (NZDT), L3 regression acceptance **decision** revision (run 25 November 2026 00:32–01:08 UTC; Lead Architect decision the same day — REPORTED).

**Decision: GO for documentation integration; NO-GO for full L3 closure**
(TESTING.md §74.10; tracker B10).

- **L3 Stage 2 — not closed.** E1 (production) and E3–E10 (local emulators
  only) are accepted with their evidence classes and limitations. **E2 is
  OPEN** against tracker D3 #32.
- **GST boundary hotfix:** deployment verified; calculation compatibility
  accepted. TESTING.md §44 manual steps 1–3 remain outstanding.
- **Premium Dashboard v2:** deployment verified; tested financial
  calculations accepted. §22 checks 2 and 3 remain open.
- **Triage:** D3 #32 is **P2 and the next implementation task** — correct
  the membership-state handling without weakening authorisation; no service
  worker or PWA. D3 #33 is P3, deferred. D3 #34 (the E2 procedure) is
  corrected with #32.
- **Financial precision (tracker D3 #35):** the application's GST is one
  cent below exact half-up on some half-cent boundaries. The Rules admit it;
  that is compatibility, not independent mathematical correctness.
  Governing decision: PROJECT_DECISIONS.md → *ADR-40 / ADR-57 Correction:
  GST Boundary Hotfix* (*Limitations*). An assessment of rounding semantics
  is tracked before client credit notes and client retention. No calculation
  or historical record changes now.
- **Order decided:** 1 D3 #32 membership reliability fix → 2 L3 E2 corrected acceptance → 3 client credit-note architecture assessment and ADR → 4 Firestore Rules capacity assessment and any necessary capacity recovery → 5 client credit-note implementation → 6 client retention.
  Estimating, approval segregation and the remaining approved commercial
  roadmap are preserved.
- Unchanged: regression fixtures; PM, QS and external test identities
  deactivated; real customer external onboarding separately gated.

*As written at the run (before the decision):* **Last updated:** 25 November 2026 (NZDT), L3 / GST / Dashboard regression acceptance revision (run 25 November 2026 00:32–01:08 UTC).

**Git checkpoint:** `main` at `875910e` (*Merge C1-D monitoring acceptance
closeout*; commit `6e00f98`), equal to `origin/main` (fetched 25 November
2026 NZDT — VERIFIED). The C1-D closeout is **integrated**. Azure `main` CI is
GREEN (REPORTED by the Product Owner). This revision was prepared on the
uncommitted branch `docs/l3-regression-acceptance`: documentation only.
Nothing was deployed and no production business data was written.

**L3 Stage 2 E1–E10, GST boundary hotfix and Premium Dashboard v2 —
consolidated regression acceptance: RUN, awaiting the Lead Architect's
decision** (tracker B10; TESTING.md §74).

- **Deployed state (PROD-VERIFIED, read-only):** the live bundle on all
  three origins is SHA-256-identical to a clean build of `main` `875910e`;
  the live Firestore (236,737 bytes) and Storage rulesets are byte-identical
  to the repository. `main` contains the GST hotfix (`ea2eea8`), Dashboard v2
  (`ba52821`) and L3 Stage 2 (`b7f825f`). **The "production state
  unconfirmed" items in section F are resolved as to deployment.** Their
  original release dates remain unrecorded.
- **L3 E1–E10:**
  - E1 PASSED in production (TEST Company Admin, `web.app`).
  - E3–E10 PASSED on **local emulators only**, with failure injection in a
    throwaway headless browser. Production writes and disconnections were
    out of scope.
  - **E2 did NOT pass as written.** An offline reload never loads the page.
    With the database unreachable at load, the app shows a false *No active
    membership* notice (tracker D3 #32). The designed *Waiting for the
    server* state works when the connection drops after the membership read.
- **GST hotfix:** the application's rounding, the shared Rules pin, the
  retention-release delta and the claim-sourced apportionment all agree with
  an independent exact-decimal check (10 million amounts, 2 million release
  pairs, 20,000 apportionments). Fixture Z's stored GST agrees. TESTING.md
  §44 manual steps 1–3 were **not run** in production: they need new
  financial records. This verifies the software against its specification
  (flat 10% Australian GST on any project, whatever its currency); it is not
  a statement of tax compliance.
- **Dashboard v2:** portfolio counts, six project snapshots in five
  currencies, the chart labels and the CAD programme panel equal independent
  expectations from raw records, to the displayed whole unit. No stale
  figure appeared while switching. TESTING.md §22 checks 2 (external roles)
  and 3 (layout) were not run.
- **Integrity:** the test company and Apex Builders are unchanged by update
  time; the four deactivated test accounts are still disabled; the five
  alert policies are unchanged; no invitation was created.
- **Browser event:** the testing tab on `web.app` opened in the Product
  Owner's personal Apex session. One read-only Dashboard load; nothing
  clicked or written. The Product Owner replaced the session with the TEST
  Company Admin. **Check the session uid on any origin before the first
  action.**
- **New findings:** D3 #32 (P2 proposed), #33 (P3 proposed), #34 (test
  procedure). No release blocker found.
- **Recommended at the run (since decided — top of this file):** close L3 E1 and E3–E10 on this evidence and
  keep E2 open against a Hosting-only correction of D3 #32; accept the GST
  hotfix and Dashboard v2 with their unexecuted checks recorded; then resume
  commercial implementation with **client credit notes**, after a Rules
  capacity recovery (tracker D4a).

*As written for the C1-D monitoring acceptance revision:* **Last updated:** 25 November 2026 (NZDT), C1-D monitoring acceptance revision (run 24 November 2026 21:56–22:36 UTC).

**Git checkpoint:** `main` at `caf6ecf` (*Merge C1-C GANTT acceptance
closeout*; documentation commit `b72a83e`), equal to `origin/main` (fetched
25 November 2026 NZDT — VERIFIED). The C1-C closeout is **integrated**. Azure
`main` CI is GREEN (REPORTED by the Product Owner). This revision was prepared
on the uncommitted branch `docs/c1d-monitoring-acceptance`: documentation,
plus the L3 availability policy file and its pinned test aligned with
production. Nothing was deployed.

**C1-D — Monitoring and alert delivery: CLOSED (Lead Architect decision, 25 November 2026 — REPORTED); integration of `docs/c1d-monitoring-acceptance` authorised.** **Evidence limitations (stand after closure):** the billing-administrator channel was not tested in this run; exact email arrival times are unknown; not every permanent policy has fired on its intended condition (only policy B, once); the permanent policies' recovery-notification behaviour is unverified; receipt of policy B's 17 November email is unverified; observed timings are not service levels. **Next milestone: L3 Stage 2 E1–E10 remaining acceptance.** *As written at the run:* **C1-D — Monitoring and alert delivery: RUN, awaiting architect review**
(tracker B9; TESTING.md §73; DEPLOYMENT.md → *L3 Stage 1* → *C1-D alert
delivery acceptance record*). D1–D7 PASS:
- **Inventory (PROD-VERIFIED):**
  - 5 alert policies, all enabled and none edited since creation;
  - 2 email channels, unmodified since 16 November;
  - 1 uptime check, with all 6 locations passing;
  - 1 log metric;
  - 0 open incidents;
  - zero 5xx on all 11 services in 30 days.
- **Parity:** DC46 A, B and C, the metric and the uptime check are identical
  to their files. The L3 availability policy was created with a check-id
  filter and `resource.label.*` grouping, verified to have the intended
  meaning. Its file and test are now aligned; the live policy is unchanged.
- **Approved synthetic test:** one temporary heartbeat policy, on the Product
  Owner channel only (the billing administrator was unavailable).
  - Created 22:08:41; heartbeat 22:24:03; incident opened 22:29:20.
  - **Natural recovery** and closure 22:33:35; deleted 22:34:58.
  - Opening email received by 11:32 NZDT, recovery email by 11:34 NZDT
    (REPORTED; exact arrival times not visible).
- **Clean-up PROD-VERIFIED:**
  - the five policies are byte-identical to before; channels unchanged;
  - no open incident; the audit log shows only the create and the delete;
  - worker and Scheduler healthy;
  - no business-data mutation and no account change.
- **Historical correction:** policy B opened a real incident on 17 November
  at 19:18:06, closed on 18 November at 19:22:24 (the predicted activation
  overdue line). Its receipt was not recorded. The statements that "policy B
  never matched" are corrected.
- **Gaps retained for hardening and customer readiness:**
  - a `transferBoqToBudget` failure alert;
  - callable errors without a 5xx;
  - membership-reconciliation monitoring;
  - backup monitoring;
  - billing-outage monitoring;
  - independent notification paths.

*As written at the run:* **Recommended:** GO for C1-D closure. Next: L3 Stage 2 E1–E10.
*As written for the C1-C closeout revision:* **Last updated:** 25 November 2026 (NZDT), C1-C closeout revision.
**C1-C — GANTT functional acceptance: CLOSED (Lead Architect decision, 25
November 2026 — REPORTED); Git integration of `docs/c1c-gantt-acceptance`
authorised.** Scheduling, dependencies, baseline management, revision
protection, variance calculations and downstream consistency accepted; the
existing role evidence accepted — no test account to be reactivated.
**Carried forward, tracked and NOT passed:** native print / PDF R1–R13; Safari and Firefox; Day / Month chart visuals; the dashed baseline outlines; the individual attention-filter checks; overnight G11; offline capture; the unexecuted stale quick-action and stale cancellation scenarios. D3 #30, #31 → P3 deferred
UX corrections. **Deferred Control 23 retained as a data-integrity hardening
requirement before customer readiness** (tracker D1 R-7). The unintended
invalid-date write and its correction stay in the record; the final fixture
state was re-read and holds only valid calendar dates. Future negative
production probes must first verify the expected enforcement mechanism.
**Browser isolation (deviation recorded):** `app.constrap.com` is the Product
Owner's personal session only and is never replaced for a test;
`constrapp-69b5d.web.app` the TEST Company Admin;
`constrapp-69b5d.firebaseapp.com` every other test identity; close only
Claude-controlled testing tabs and windows. The CAD fixture is retained; all
temporary accounts stay disabled. **Next milestone: C1-D — monitoring and
alert delivery** (needs its own brief).
*As written for the run revision:* **Last updated:** 25 November 2026 (NZDT), C1-C GANTT production acceptance revision (run 24 November 2026 20:30–21:16 UTC).
**Git checkpoint:** `main` at `8b8c3e5` (*Merge L4 and Stage A acceptance
closeout*; documentation commit `0062cb7`), equal to `origin/main` (fetched 25
November 2026 NZDT — VERIFIED). Azure `main` CI GREEN — REPORTED by the Product
Owner. This revision was prepared on the uncommitted branch
`docs/c1c-gantt-acceptance` (documentation only; nothing deployed).
**C1-C — GANTT production acceptance: RUN** (closed — see above).
Release state PROD-VERIFIED: Firestore `67b6425a…` and Storage `2f3a4788…`
byte-identical to `main`; the live bundle `index-BOg2hoYg.js` SHA-256-identical
to a clean build of `main`; no GANTT source change since `9ce433d` — so GANTT
1A1 / 1A2 / 1B, PULSE 1C and ADR-79 are live as merged. On one new retained
fixture in the isolated company (`V2Vj8jds7RUkBAmZ1jzm`, *TEST CAD-1 — C1-C
GANTT programme acceptance*, CAD — its own Portfolio group), with expectations
from a separate Python date model fed with the stored records:
- **Scheduling (§40–§41) PASS:** inclusive calendar-day durations (incl. a
  month end), finish-to-start earliest starts with lag and the milestone
  same-day rule, boundary starts, conflict refused until acknowledged, cycle
  candidates exactly the transitive successors, overdue / blocked / due-soon.
  Nothing is rescheduled automatically; no critical path; FS only.
- **Revision guard PASS:** a stale save refused with nothing written and the
  edits kept; *Reload latest* then save kept both users' edits (revision 3).
- **Baselines (§42) PASS:** capture, self-approval shown, immutability (hashes
  constant), variance and envelope (+7, +11) against the active and a
  historical baseline, drift and the refused approval after a further change,
  re-baselining, withdrawal, an invalid programme refused at capture.
- **PULSE parity, CSV (in memory — nothing saved), Dashboard panel PASS.**
  Overview and Portfolio carry no programme figure (not built). Progress
  variance not built.
- **Server side:** 22 direct SDK writes refused by the deployed Rules.
- **Not run (proposed as limits):** print / PDF R1–R13; a QS or external
  session on the programme (emulator 5 files / 445 tests + §71 M8); Safari /
  Firefox; Day / Month chart visuals and baseline outlines.
- **Engineer error recorded:** one probe wrote an impossible date
  (`2026-02-30`) to a fixture activity — accepted by design (Deferred
  Control 23); corrected through the editor.
- **New findings (P3):** D3 #30 (baseline review dialog closes silently when
  the draft is withdrawn elsewhere), #31 (cancelled successor's predecessor
  text says *Starts before its predecessor allows*).
- **Integrity:** Apex 258 documents identical; only the 19 fixture documents
  added; no audit event; NZD 26%, GBP 12,565.34, Z revision 2 unchanged; PM,
  QS and external accounts still disabled.
Record: SECURITY_DATA_TEST_TRACKER.md → B8; TESTING.md §72. *As written at
the run:* next action the architect's C1-C closure decision; recommended next
milestone C1-D.
*As written for the previous revision (L4 / Stage A):* **Last updated:** 25 November 2026 (NZDT), L4 / Stage A consolidated acceptance revision (run 24 November 2026 19:00–19:42 UTC).
**Git checkpoint:** `main` at `0cf17e6` (*Merge C1-A Final Account acceptance
closeout*; documentation commit `c05e16a`), equal to `origin/main` (fetched 25
November 2026 NZDT — VERIFIED). Azure `main` CI GREEN — REPORTED by the Product
Owner. This revision was prepared on the uncommitted branch
`docs/l4-stage-a-acceptance` (documentation only; nothing deployed).
**L4 acceptance: CLOSED with recorded evidence limitations. M2-A2 Stage A
internal-role regression: CLOSED within its applicable scope (Lead Architect
decision, 25 November 2026 — REPORTED).** Accepted as decided: T14 as `client`
on the existing production and emulator evidence; M1, M2 and the stale-bundle
part of M7 superseded; the M4 BOQ-item lock variant (budget-line variant not
run); the M5 currency pin emulator-only; T15 not executed; the F16 notice
observed in production; W2–W4 with display findings. **Next milestone: C1-C
GANTT production acceptance.** The evidence is the consolidated production
run of 24 November 19:00–19:42 UTC, in the isolated company `constrap-acceptance-test` on one new
retained synthetic project (L4 `gdaYQYRD7cc0yUTkK0cD`, *TEST GBP-1 — L4
BOQ-to-budget acceptance*, GBP — its own Portfolio currency group):
- **L4 (§67):** **T9 PASS** — a transfer request made stale by a second user's
  BOQ edit was refused by the server (`boq-transfer-stale-review`), the dialog
  said nothing was written, and nothing was. **Quant step of T16 PASS** — a
  measured 96.006 m² was applied to a BOQ item; the chain drawing → quantity →
  BOQ → working budget → **approved version 1 (GBP 12,565.34)** equals
  independent `Decimal` expectations to the cent on every surface. **T14 PASS
  as `subcontractor`** at three layers (no BOQ tab or button; Rules denials;
  the callable's `boq-transfer-forbidden`). **T14 as `client` was not re-run**
  (Product Owner decision: one reactivation; earlier production evidence §68
  X1–X3 and §63 P20). A real network disconnection is still not tested.
- **Stage A (§68):** **M3** (Project Manager edit of all five fields), **M4**
  (QS lists everything, cannot create or edit — UI and Rules; currency lock
  engaged by the QS's first priced BOQ item) and **M8** (Portfolio, Commercial
  Report, Final Account, GANTT for all three internal roles) **PASS**; M5 page
  load PASS, its currency pin not run (nothing to pin); **M1, M2 and the
  stale-bundle part of M7 are superseded** — that release stage is over and
  they were never verified.
- **§61:** W2, W3, W4 PASS. **§62 F16: the *Final Account is restricted* notice
  is now OBSERVED in production** (a signed-in `subcontractor` on fixture Z; no
  figure, no control).
- **Budget approval authority:** a QS can prepare but not approve — no control,
  and the Rules refused the application's own approve transaction sent from the
  QS session; the Company Admin approved.
- **Accounts:** the TEST Project Manager, QS and the one re-activated external
  identity were **deactivated** through the Team page at the end; Auth
  disabled, tokens revoked, assignments removed, revocation sweep complete;
  reconciliation report: no inconsistencies. The TEST Company Admin stays
  active. A further role session needs a new invitation.
- **Integrity:** Apex Builders identical (258 documents); projects A–C and
  fixtures X, Y, Z untouched; NZD weighted margin still 26%; Z's approved
  revision 2 still agrees with the records.
- **Integrity limits that stand:** token replay after deactivation not
  tested; Apex Storage objects not compared; the Apex comparison is by
  document path and update time, not content; the Hosting bundle not
  re-compared with a build.
- **New findings (no data exposed) — P2 external-role UI correction bundle
  (architect, 25 November):** tracker D3 #27 (Budget tab
  by URL as an external role shows a loading fault, not a restricted notice),
  #28 (Purchase Orders tab shows an empty register and a create button), #29
  (Commercial sub-navigation shown to external roles). **D3 #28 was inspected
  for an authorisation defect and none was found:** the `purchaseOrders` Rules
  allow read, create and update only to the three internal roles
  (`financialMember`), and existing emulator tests refuse a create by an
  assigned subcontractor and client (TESTING.md §71). A production create by
  an external role was not attempted.
Record: SECURITY_DATA_TEST_TRACKER.md → B7; TESTING.md §71. The Project
Manager, QS and external test accounts stay deactivated; the TEST Company
Admin, the GBP fixture and every earlier fixture are retained. Real customer external onboarding stays
separately gated. Statements further down that the Project Manager and QS are
active, or that T9, T14, W2–W4 or the F16 notice are open, pre-date this
revision.
*As written for the previous revision (C1-A closeout):* **Last updated:** 25 November 2026, C1-A closeout revision (acceptance run recorded 24 November 2026 UTC).
**Git checkpoint:** `main` at `2561344` (*Merge C1-B Portfolio acceptance
closeout*; documentation commit `c236bd9`), equal to `origin/main` (fetched 24
November 2026 — VERIFIED). This revision was prepared on the uncommitted
branch `docs/c1a-final-account-acceptance` (documentation only).
**C1-B — L2-C Portfolio: CLOSED** and Azure `main` CI GREEN (both REPORTED by
the Lead Architect, 24 November 2026).
**C1-A — L2-B Final Account: CLOSED (Lead Architect decision, 25 November
2026 — REPORTED).** The remaining production acceptance was run on 24
November 2026 (10:21–10:53 UTC). In the isolated company `constrap-acceptance-test`, on one
dedicated synthetic project that is retained (Z `5hmVvUCoOIEPrzdeowYK`, *TEST
USD-1 — Final Account acceptance*, USD): **F5, F6, F15, Project Manager
approval, the native print / PDF part of F14 and retest R5 PASSED**;
independent `Decimal` expectations equal the stored approved revision, the
screen, the Reports tab, the Portfolio, the CSV and the PDF to the cent.
Approval is reachable only through the `approveFinalAccount` callable for all
three internal roles (24 direct-write shapes denied by the deployed Rules; a
QS call refused `not-approver`); a repeated approval is answered without a
second write. **F16 is PARTLY evidenced:** no figure reaches a signed-out,
deactivated or non-financial account (production), but the *Final Account is
restricted* notice for a signed-in non-financial account was not observed in
production (unit test only — both external test accounts stay disabled).
**The architect accepted F16 on that combined evidence; the notice is NOT
recorded as observed in production, and its browser check is carried forward
to the external-role session that L4 T14 and §61 W4 need.** R5 rests on
stored-state evidence, and client-side and cash figures were exercised at
zero only — both limitations stand.
Revision 1 withdrawn, revision 2 approved by the Project Manager on a draft
the QS prepared. Apex Builders, Projects A–C and fixtures X / Y unchanged; the
TEST Project Manager and QS remain **active** for the remaining internal-role
tests. Fixture Z, its supplier contact, the two counters and the approved
revision are retained. New cosmetic findings, tracker D3 #22–#26, are in the
deferred UX and reporting correction bundle. Self-approval remains a
documented policy gap for a future approval-segregation implementation.
**Next milestone: L4 remaining acceptance and M2-A2 Stage A internal-role
regression.** Record:
SECURITY_DATA_TEST_TRACKER.md → B6; TESTING.md §62c. Rows further down that
call Final Account acceptance PENDING pre-date this revision.
*As written for the previous revision (C1-B):* **Last updated:** 24 November 2026 (UTC), C1-B Portfolio acceptance revision.
**Git checkpoint:** `main` at `62e824a` (*Merge operator tooling security
hardening*; feature commit `bc64487`), equal to `origin/main` (fetched 24
November 2026 — VERIFIED). This revision was prepared on the uncommitted
branch `docs/c1b-portfolio-acceptance` (documentation only).
**Operator tooling safety — INTEGRATED** (D3 #1–#3, #16, #18 complete; unit
5,244, Functions pure 179, Functions emulator 367, `npm run test:team` PASS ×4;
Azure `main` green — REPORTED by the Lead Architect; no deployment; production
transaction cleanup never exercised; D3 #17 open).
**C1-B — L2-C Portfolio acceptance — all checks run, awaiting the architect's
closure decision.** Read-only run in Apex Builders (05:14–05:27 UTC): P1–P6,
P8, P12, P13, P21, P22 PASS, parity on five rows to the cent (ACCEPTED by the
architect), M1 = 10, M4 = 136 reads per Portfolio read. Final targeted run in
the isolated test company (07:15–07:37 UTC): **P7, P9, P18 PASS in
production** on two retained synthetic **NZD** commercial fixtures (weighted
margin 26.00% against independent expectations); **P15 PASS on local
emulators only**. Two internal test identities now exist and are **active** in
`constrap-acceptance-test` — a new Project Manager (`KSC9zf…`) and the
re-activated QS (`PvzTgu…`); their final state awaits architect review. Apex
Builders unchanged. Record: SECURITY_DATA_TEST_TRACKER.md → B4, B5; TESTING.md §63.
*As written for the previous revision (M2-A2 final closeout):*
**Git checkpoint:** `main` at `bd9021c` (*Merge M2-A2 external member
provisioning*; feature commit `cddfca8`), equal to `origin/main` (fetched 24
November 2026 — VERIFIED). This revision was prepared on the uncommitted
branch `docs/m2-a2-stage-b-closeout` (documentation only).
**M2-A2 — External Project Isolation: Stage A (ADR-83) and Stage B (ADR-84)
LIVE and CLOSED; Deferred Control 20 CLOSED (Lead Architect, 24 November
2026).** The three Stage B callables (`acceptinvitation-00005-mol`,
`deactivatemember-00005-suy`, `resendinvitation-00005-mer`) have been live
since 23 November 2026 ~09:11 UTC with source identical to `main` (VERIFIED);
Rules and Hosting unchanged. Production acceptance in the isolated test
company `constrap-acceptance-test` PASSED: TESTING.md §69 S1–S3, R1–R3,
P1–P14; §68 X1–X7; §63 P19–P20 for both external roles (the Portfolio page's
request payloads were not decoded — recorded limitation). Reconcile clean;
directory 13 / 13; both external test accounts and the QS deactivated; TEST
admin, three projects and five fixtures retained; Apex Builders unchanged.
**Real customer external onboarding remains BLOCKED** pending a readiness
decision; residual risks are tracked. The central acceptance and progress
index is now [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md).
*As written for the previous revision (Stage B):* **Last updated:** 23 November 2026 (NZ), Stage B revision. **Git
checkpoint:** `main` at `10807b8` (*Merge M2-A2 Stage A closeout*), equal to
`origin/main` (fetched 23 November 2026 — VERIFIED). This revision was
prepared on the uncommitted branch `feature/m2-a2-external-provisioning`.
**M2-A2 Stage B — External member assignments and provisioning (ADR-84):
IMPLEMENTED — NOT DEPLOYED, awaiting architect review.** Functions and
operator scripts only — no Rules, Storage Rules, Hosting or new callable.
An operator-created invitation carries the projects of a `client` /
`subcontractor`; `acceptInvitation` re-validates them and writes
`users/{uid}.projectIds` in the membership transaction (and removes the
field for an internal role); `deactivateMember` removes it; operator-only
assignment changes are audited and queue a file-link revocation on removal.
Scripts: `provision-external-member.mjs`, `set-member-projects.mjs` — dry-run
by default, never print a link. Unit 101 files / 5,244, Rules emulator 39 files / 2,492,
Functions pure 7 files / 155, Functions emulator 11 files / 354 — all PASS. **Nothing
deployed; no script run against production; no external account exists;
external onboarding remains BLOCKED** until the three callables are deployed
and TESTING.md §69 passes in an isolated test company.
*As written for the previous revision (closeout):* `main` at `22cf7db`
(*Merge M2-A2 external project isolation*), prepared on
`docs/m2a2-stage-a-closeout` (documentation only).
**M2-A2 — External Project Isolation (ADR-83): STAGE A LIVE — CLOSED and
production-accepted, 23 November 2026 (Lead Architect decision).** FINAL
Firestore Rules, restricted Storage Rules and Hosting are deployed and
identical to `main` (VERIFIED read-only); the directory backfill is verified
10 of 10; a paired project create and edit passed in production; the
directory fields are verified; project documents and internal budgets are
protected by the deployed Rules. No known Stage A implementation defect.
**Limitations:** no real external-role production browser test yet; external
onboarding remains BLOCKED; TESTING.md §63 P19–P20 (C1-B) remain pending;
Stage B (provisioning and assignment management) is NOT implemented;
Deferred Control 20's live external-role acceptance is outstanding.
*As written for the previous revision (before deployment):* `main` at
`6a1a1ac`, prepared on `feature/m2-a2-external-project-isolation` — M2-A2
STAGE A IMPLEMENTED, NOT DEPLOYED; DC20 not closed in production; Stage B
NOT STARTED.
**C1-A — DEPLOYED to production and browser-retested (REPORTED by the Lead
Architect, 23 November 2026; not re-read from production in this revision).**
Final Account positive-path acceptance PASSED in production on 22 November
2026 (TESTING.md §62b). The forecast-readiness correction (`5b67a3f`, merged
as `6a1a1ac` — VERIFIED in Git) was deployed and retested in the browser:
**R1, R2 and R4 PASSED; R3's approval blocking PASSED.** **Accepted,
non-blocking UX limitation:** in R3 the wording does not name the missing
cost code. R5 is not recorded. **Coverage gaps that remain** (emulator
coverage only): the role-specific checks — F5, F6, F15, F16 and Project
Manager approval — and the native print dialog / PDF file (F14). Statements
further down that no Final Account revision has been approved in production,
and TESTING.md §62b's own "NOT DEPLOYED, production retest PENDING" heading,
pre-date this.
*As written for the previous revision:* **Last updated:** 22 November 2026 (NZ). **Git checkpoint:** `main` at
`74c2a6f` (*Merge L4 transfer acceptance corrections*), equal to
`origin/main` (fetched 22 November 2026 — VERIFIED). This revision was
prepared on the uncommitted branch `docs/post-l4-roadmap-alignment`
(documentation only). **L4 is CLOSED — LIVE and production-accepted**
(REPORTED by the Lead Architect, 22 November 2026). **L5 (Xero) is ASSESSED —
IMPLEMENTATION DEFERRED** (ADR-82, PROPOSED, not approved). **Constrap IQ and
Quant AI are DEFERRED.** The post-L4 priorities are in section H.
*As written for the previous revision:* **Last updated:** 21 November 2026 (NZ). **Git checkpoint:** `main` at
`b7f825f` (*Merge L3 application error recovery*), equal to `origin/main`
(fetched 21 November 2026 — VERIFIED). This revision was prepared on the
uncommitted branch `feature/l4-boq-budget-transfer` (**L4 — BOQ → working
budget transfer, ADR-81 — IMPLEMENTED, NOT DEPLOYED; awaiting architect
review**). **L3 is CLOSED** (REPORTED by the Lead Architect, 21 November
2026; the Stage 2 Hosting deploy is not independently verified here).
*As written for the previous revision:* `main` at
`4bd358a` (*Merge L3 recovery and monitoring preparation*), prepared on
`fix/l3-application-error-recovery` (L3 Stage 2 —
IMPLEMENTED, NOT DEPLOYED). **L3 Stage 1 is CLOSED** (monitoring created — VERIFIED read-only 21
November 2026; restoration verification successful — REPORTED by the Lead
Architect; alert delivery not tested at that point — *tested 24 November 2026 UTC through a temporary policy on the Product Owner channel, C1-D*). Records: DEPLOYMENT.md → *L3 Stage 1*.

**DC46 is closed.** Deferred Control 46 was CLOSED on 18 November 2026 with
documented accepted risks, after final external-member acceptance in
production. The consolidated documentation closeout was merged as `84c9fb3`. Historical release records in the source documents keep the wording
of their own dates (older revision names, "not activated" in a dated
record); each DC46 section now opens with its current status.

**This file is a point-in-time snapshot.** It does not replace checking the
current Git state or verifying production. Maintenance is mandatory —
[AGENT.md](../AGENT.md) → *Development Continuity — ChatGPT Handover*.

**Status words used throughout — never blur them:**

| Word | Meaning |
|---|---|
| **VERIFIED** | Read directly from the repository (files, Git history) when this file was last updated |
| **REPORTED** | Stated by the Product Owner or the architect and recorded in the repository documents; not independently re-checked here. A production "LIVE" claim is REPORTED in this file unless the line says what was read from production and when |
| **PROPOSED** | Designed or prepared; does not exist in production |
| **BLOCKED** | Cannot proceed until a named precondition or authorisation is met |
| **NOT STARTED** | No design, code or scope in the repository |

---

## A. Current checkpoint

| Item | State |
|---|---|
| **Current milestone** | **Client credit-note architecture assessment and ADR — NEXT, not started (needs its own brief).** L3 Stage 2 is **CLOSED within its accepted scope**; D3 #32 and D3 #34 are **CLOSED** (26 November 2026; TESTING.md §76). *As written before the release:* **D3 #32 membership reliability fix — IMPLEMENTED on `fix/membership-resolution-state` (25 November 2026; uncommitted) — PENDING INTEGRATION AND PRODUCTION VERIFICATION; awaiting the Lead Architect's review** (TESTING.md §75; tracker B11). Hosting-only; not deployed. L3 E2 stays OPEN until E2-A and E2-B are run in production. *As written before the fix:* **D3 #32 membership reliability fix — NEXT, not started** (Lead Architect, 25 November 2026 — REPORTED; needs its own brief). L3 Stage 2 is **not closed**: E1 and E3–E10 accepted with their evidence limitations, **E2 open** against tracker D3 #32 (TESTING.md §74.10). *As written at the run:* **L3 Stage 2 E1–E10, GST boundary hotfix and Premium Dashboard v2 — consolidated regression acceptance: RUN 25 November 2026, awaiting the Lead Architect's decision** (top of this file; tracker B10; TESTING.md §74). E2 is open against tracker D3 #32. *As written for the C1-D revision:* **None in progress. C1-D — monitoring and alert delivery CLOSED (Lead Architect, 25 November 2026 — REPORTED)**, with evidence limitations recorded (top of this file; tracker B9; TESTING.md §73). **Next: L3 Stage 2 E1–E10 remaining acceptance.** *As written at the run:* C1-D — RUN 24 November 2026 UTC, awaiting architect review. *As written for the C1-C closeout revision:* **None in progress. C1-C GANTT functional acceptance CLOSED (Lead Architect, 25 November 2026 — REPORTED)**, presentation, browser and resilience checks carried forward (top of this file; tracker B8; TESTING.md §72). **Next: C1-D — monitoring and alert delivery.** *As written at the run:* C1-C GANTT production acceptance — RUN 25 November 2026 NZDT, awaiting architect review. L4 acceptance and the Stage A regression CLOSED (25 November). *As written for earlier revisions:* **None in progress. M2-A2 Stage A (ADR-83) and Stage B (ADR-84) — LIVE and CLOSED; Deferred Control 20 CLOSED (Lead Architect, 24 November 2026).** Stage B callables live since 23 November 2026 (`-00005-*`); production acceptance PASSED 23–24 November 2026 (TESTING.md §69, §68 X1–X7, §63 P19–P20) — record: ADR-84 → *Stage B closure record*; DEPLOYMENT.md → *M2-A2 Stage B → Release record*. Test company `constrap-acceptance-test` RETAINED (TEST admin active; external and QS test accounts disabled; three projects and five fixtures). **Real customer external onboarding BLOCKED pending a readiness decision.** *As written for the previous revision:* **M2-A2 Stage B — External member assignments and provisioning (ADR-84) — IMPLEMENTED on `feature/m2-a2-external-provisioning` (uncommitted), NOT DEPLOYED, awaiting architect review (23 November 2026).** Functions and operator scripts only; `firestore.rules` unchanged at 236,737 bytes; Hosting bundle unchanged (`index-BOg2hoYg.js`). Release: DEPLOYMENT.md → *M2-A2 Stage B* — redeploy `acceptInvitation`, `deactivateMember`, `resendInvitation` only. Unit 101 files / 5,244, Rules emulator 39 files / 2,492, Functions pure 7 files / 155, Functions emulator 11 files / 354 — all PASS. **External onboarding BLOCKED; DC20's live acceptance outstanding; §68 X1–X6, §63 P19–P20 and §69 P1–P14 NOT RUN.** *As written for the previous revision:* **None in progress. M2-A2 Stage A (ADR-83) — LIVE, CLOSED and production-accepted 23 November 2026.** Firestore ruleset `67b6425a…` (236,737 bytes), Storage ruleset `2f3a4788…` (10,323 bytes) and Hosting bundle `index-BOg2hoYg.js` identical to `main` `22cf7db` (VERIFIED read-only). Test project `Iusni6U8enVn47fKBGDB` (*M2-A2 Security Acceptance — VERIFIED*) created and edited through the application, each as one commit with its directory entry; 10 projects, 10 matching entries; the nine existing projects unchanged. The test project is RETAINED and contributes to the Portfolio totals — do not delete or modify it. The Storage Rules were published after the FINAL Firestore Rules (DEPLOYMENT.md → *M2-A2 Stage A → Release record*). **Not done:** any external-role session in production; §68 M1, M2, M4, M5, M7, M8 and X1–X6. **Proposed next: M2-A2 Stage B — operator provisioning and assignment management (PROPOSED, assessed 23 November 2026, not approved).** *As written before deployment:* **M2-A2 — External Project Isolation, Stage A (ADR-83) — IMPLEMENTED on `feature/m2-a2-external-project-isolation` (uncommitted), NOT DEPLOYED, awaiting architect review (23 November 2026).** Server-managed `users/{uid}.projectIds`; the project document internal-only; an external-safe `projectDirectory` entry pinned to its project in the same commit; Firestore and Storage reads scoped to assigned projects for `client` / `subcontractor` only; no assignment, no access. Unit 101 files / 5,244, Rules emulator 39 / 2,492, Functions pure 6 / 136, Functions emulator 10 / 310 — all PASS; Rules 236,737 bytes (8,263 headroom). NOT browser-verified. **DC20 is OPEN in production; external onboarding BLOCKED; §63 P19–P20 pending; Stage B NOT STARTED.** Release: DEPLOYMENT.md → *M2-A2 Stage A* — a dedicated Stage-1 ruleset (`firestore.m2a2-transitional.rules`); **never publish `firestore.transitional.rules`**. *As written for the previous revision:* **None in progress. L4 CLOSED — LIVE and production-accepted, 22 November 2026 (REPORTED by the Lead Architect):** Azure CI and the production deployment passed; production financial acceptance passed; the final confirmation-UX correction (`d90e21f`, `main` `74c2a6f`) passed; SHIELD versions 1 and 2 verified. Remaining browser gaps: T9, T14, the Quant step of T16 and a real disconnection — emulator coverage retained. The *L4 Acceptance Sandbox* (`3OyBieoY4QHAfQsxBH8T`) stays in production and contributes to the company Portfolio totals; do not delete or modify it (TESTING.md §67 → *L4 closure record*). **Proposed next milestone: C1 — Core acceptance closeout (PROPOSED, not approved — section J).** *As written for the previous revision:* **L4 — BOQ → working budget transfer (ADR-81) — DEPLOYED (`main` `a30699e`, REPORTED). Production acceptance 22 November 2026 in the retained sandbox *L4 Acceptance Sandbox* (`3OyBieoY4QHAfQsxBH8T`, Apex Builders): 13 of 16 PASS, T16 partly exercised, T9 and T14 NOT TESTED in production (emulator coverage only); lost response simulated, real disconnection NOT tested; SHIELD versions 1 and 2 PASS; the sandbox's amounts appear in the company Portfolio. Acceptance UX correction (confirmation bound to the reviewed request; uncertain-outcome wording; copy) IMPLEMENTED on `fix/l4-transfer-acceptance` (uncommitted), Hosting-only, NOT DEPLOYED, NOT browser-verified** (TESTING.md §67). *As implemented 21 November:* Rules + ONE new callable (`transferBoqToBudget`) + Hosting; unit 99 files / 5,152, Rules emulator 36 / 2,336, Functions emulator 10 / 295, Functions pure 5 / 130 — all PASS; Rules 232,776 bytes (12,224 headroom) (DEPLOYMENT.md → *L4*). *Previous milestone:* **L3 Stage 2 — application error recovery (ADR-80) — IMPLEMENTED on `fix/l3-application-error-recovery` (uncommitted); NOT DEPLOYED; Hosting-only; unit suite 96 files / 5,041 tests PASS; browser behaviour NOT VERIFIED** (TESTING.md §66). The project route no longer shows *Project not found* for a failed, refused or unconfirmed read; a write-outcome helper (confirmed / failed / uncertain) is applied to Client Invoices, Client Receipts and Supplier Payments; 58 older write sites remain. **L3 Stage 1 — CLOSED:** uptime check on `app.constrap.com` and alert policies `15559930914799323534` (uptime) and `9683374685335961795` (Final Account failure) exist and are enabled, DC46 policies A, B, C preserved (VERIFIED read-only, 21 November 2026); **alert delivery NOT tested**. Restoration verification SUCCESSFUL (REPORTED): 20 November backup into `restore-verify-20261120-2329`, unauthenticated 403, 44 collection groups / 211 documents and the sample hash matched, temporary database removed, only `(default)` remains with delete protection enabled (VERIFIED); deletion time and mechanism not established; not every document's contents compared. *The remainder of this cell was written before Stage 1's production actions:* **L3 — Production Reliability — IN PROGRESS.** The read-only assessment was delivered and approved (Lead Architect: GO for Stage 1, 21 November 2026). **Stage 1 — PREPARED on `chore/l3-recovery-monitoring` (uncommitted): files and documentation only.** A Firestore restoration verification procedure with a read-only count script (`ops/recovery/`); an uptime check on `app.constrap.com` with its alert policy, and an alert on `approveFinalAccount` server failures (`ops/monitoring/`, files only); an operations runbook (`ops/RUNBOOK.md`). **Nothing was created, changed or deleted in production; no restore was run; no alert exists beyond DC46 policies A, B and C** (DEPLOYMENT.md → *L3 Stage 1*; TESTING.md §65). Stage 2 (application error recovery, Hosting-only) is NOT started and NOT approved. **Status of everything else:** GANTT 1A1, 1A2, 1B and PULSE 1C — LIVE (VERIFIED read-only 20 November 2026). **GANTT core completion (ADR-79; the Lead Architect's G1, G2, G3) — LIVE since 20 November 2026 08:52 UTC and Product Owner accepted** (merged as `9ce433d`, VERIFIED; live bundle SHA-256-identical to a clean build of `main`, VERIFIED 21 November 2026; acceptance REPORTED by the Lead Architect; certain baseline scenarios not exercised in the browser). **L2-A Commercial Report — LIVE and accepted** (REPORTED). **L2-B Final Account (ADR-77) — DEPLOYED; positive approval, revision and export acceptance OUTSTANDING** (TESTING.md §62 F3–F17) — `approveFinalAccount` deployed source is identical to `main` (VERIFIED 21 November 2026) and it received no request in the preceding 14 days; L2-B is NOT accepted. **L2-C Portfolio Report (ADR-78) — DEPLOYED; visual, CSV and PDF acceptance confirmed (REPORTED); access, parity and performance checks OPEN** (TESTING.md §63). **DC46 — CLOSED 18 November 2026** with accepted risks. **Firestore recovery — protection ENABLED; two READY backups VERIFIED 21 November 2026; restoration verification PREPARED, NOT RUN** |
| **Latest Git checkpoint** | **VERIFIED:** branch `main`, HEAD `9ce433d` (*Merge GANTT core completion*; preceded by `8e60eb7`, the feature commit), equal to `origin/main` (`git ls-remote`, 21 November 2026); working tree clean before `chore/l3-recovery-monitoring` was branched from it. Azure CI on `9ce433d` was not read in this revision. Before that: `93db6cc` (*Merge L2-C Portfolio Reporting*; preceded by `4ebdd4e`), `891043a` (*Merge L2-B Final Account reconciliation fixes*; preceded by `24e65c1`, the correction itself), `c4b93e5` (*Merge L2-B Final Account*). Azure CI on `main`: REPORTED green. Preceding commits: `2047a0d` (Final Account), `28e5c9f` (Rules capacity merge), `02e973a`, `2d5787c` (L2-A merge), `84c9fb3` (DC46 closeout), `a2544a1` (worker rollback checkpoint) |
| **Production** | **REPORTED:** live at `https://app.constrap.com` on Firebase project `constrapp-69b5d`. **VERIFIED read-only, 21 November 2026 NZ (latest reading):** Firestore ruleset `10c7596c…` (232,460 bytes) and Storage ruleset `8b8edc14…` (9,271 bytes) byte-identical to `main` `9ce433d`; the Hosting release of 20 November 2026 08:52 UTC serves `index-Cz4wMhcy.js`, SHA-256-identical to a clean build of `main` — so the live application is `main`, including GANTT core completion; `approveFinalAccount` (revision `-00002-jib`, deployed 19 November 2026 20:48 UTC) runs source identical to `main`; **the eight team callables (`-00004-*`) and the worker (`-00003-ceg`) still run their 17 November 2026 source — the selective deploy was deliberate, and the only difference from `main` is the additive Final Account code**; three alert policies (A, B, C), two channels, no uptime check; 7-day figures: one ERROR log entry (the worker's activation line of 17 November), no callable 5xx, about 13,000 Firestore reads. *Earlier reading, 20 November 2026:* Firestore ruleset `10c7596c…` (released 19 November 2026 04:23 UTC; **232,460 bytes**) byte-identical to `frontend/firestore.rules` on `main`; Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves `index-Co3P5JIm.js`, the bundle a clean build of `main` `93db6cc` produces — so the live application is `main`, including GANTT 1A1 / 1A2 / 1B, PULSE 1C, L2-B and L2-C. Functions and Storage Rules were not re-read on 20 November. *Earlier reading, kept for the record —* **VERIFIED** read-only, 19 November 2026: Firestore ruleset `05c78d00…` (**229,115 bytes**, created 18 November 2026 21:57 UTC) byte-identical to `main` `28e5c9f`; Storage ruleset `8b8edc14…` (9,271 bytes) byte-identical to `main`; eight callables on `-00004-*`; worker `processfilelinkrevocations-00003-ceg`; latest Hosting release `e38715de08e664b5` (18 November 05:29 UTC — REPORTED as the L2-A release; its files were not compared with `main` in this revision). **L2-B (20 November 2026): the Final Account Rules, the `approveFinalAccount` callable and Hosting are REPORTED deployed; they were not re-read from production in this revision.** The figures before this sentence are the 19 November reading, taken before that release. Earlier verification (17–18 November): concurrency 1, `FILE_LINK_RECONCILE_INTERVAL_HOURS=2`, Scheduler enabled, Policies A, B and C enabled, 1 company, 2 active Company Admins, 2 deactivated test members, 0 active external users |
| **Deferred Control 46** | **CLOSED — 18 November 2026, with accepted risks; production acceptance approved by the architect** (SECURITY.md item 46; ADR-75 → *DC46 closure record*; TESTING.md §59) |

**Accepted risks (not eliminated — detail in section I):** copied download
links live until a sweep removes the token (the two-hour reconciliation
interval is not a strict revocation deadline — completion depends on
scheduling, worker health and backlog) · console and
Admin SDK writes bypass Rules · the November token re-creations are
unattributed · every member reads every drawing revision · monitoring
shares the worker's cloud project · the Firestore Rules have 12,540 bytes of headroom
with the Final Account block (REPORTED published).

**Exact next development action:** architect review and Git integration of
`docs/m2-a2-stage-b-closeout` (documentation only; no deploy). Then, on its
own brief: the next smallest milestone proposed in section J
(*Next, from 24 November 2026*). Real customer external onboarding stays
BLOCKED until a readiness decision is recorded.
*As written for the previous revision:* architect review of
`feature/m2-a2-external-provisioning` (M2-A2 Stage B, ADR-84). Then, each on
its own authorisation and in this order: commit and merge; **Azure `main`
GREEN (no production step before it)**; redeploy the three callables
(DEPLOYMENT.md → *M2-A2 Stage B*, step 3) and verify the other eight
services kept their revisions; TESTING.md §69 R1–R3; then the production
acceptance §69 P1–P14 in an isolated test company with two
Product-Owner-controlled mailboxes — which also completes §68 X1–X6 and §63
P19–P20. External onboarding is unblocked only by a decision recorded after
that acceptance.
*As written for the previous revision:* architect review of
`docs/m2a2-stage-a-closeout` (documentation only; no deploy). Then, on its
own brief and approval, **M2-A2 Stage B** — operator provisioning and
assignment management, the reset of `projectIds` on acceptance and
deactivation, file-link revocation on unassignment, and the live
external-role test that completes DC20's acceptance.
*As written before deployment:* architect review of
`feature/m2-a2-external-project-isolation` (M2-A2 Stage A, ADR-83). Then,
each on its own authorisation and in this order: commit and merge; **Azure
`main` GREEN (no production step before it)**; Stage-1 Firestore Rules and
Storage Rules; Hosting; the directory backfill (dry run, then `--apply` on a
separate Product Owner authorisation); FINAL Rules only when every project's
entry matches; TESTING.md §68 M1–M8. Stage B needs its own brief.
*As written for the previous revision:* architect review of
`docs/post-l4-roadmap-alignment` (documentation only). Then, on its own
brief and approval, the proposed **C1 — Core acceptance closeout**
(section J). Standing rules unchanged: the trusted backend has TWO approved
financial callables and no Xero or AI work is authorised.
*As written for L4:* architect review of
`feature/l4-boq-budget-transfer` (L4, ADR-81). Then, each on its own
authorisation and in this order: commit and merge; **Azure `main` GREEN (no
production deployment before it)**; Rules publish (232,776 bytes); deploy of
ONLY the new callable (`--only functions:team:transferBoqToBudget`); verify
it and that no other service changed revision; Hosting; TESTING.md §67
T1–T16 on a test project. **Emergency rollback:** previous Hosting release +
`BOQ_BUDGET_TRANSFER_ENABLED=false` on that one function; the L4 Rules and all
working budget lines are RETAINED (DEPLOYMENT.md → *L4* → *Rollback*).
**Standing rule changed by L4:** the trusted backend now has TWO approved
financial callables (ADR-77 `approveFinalAccount`, ADR-81
`transferBoqToBudget`); CLAUDE.md and AGENT.md say so. No other financial
logic belongs in Functions.
*As written for L3 Stage 2:* architect review of
`fix/l3-application-error-recovery` (L3 Stage 2), then Git integration, one
Hosting deploy and TESTING.md §66 E1–E10 (each on its own authorisation).
*As written for Stage 1:* architect review of
`chore/l3-recovery-monitoring` (L3 Stage 1), then Git integration (Product
Owner). Then, each on its own authorisation: create the uptime check and the
two alert policies (DEPLOYMENT.md → *L3 Stage 1*), and run the Firestore
restoration verification (`ops/recovery/README.md`). Then L3 Stage 2
(application error recovery, Hosting-only) on its own brief. Open in
parallel, as product acceptance items outside L3: the remaining L2-C checks
(TESTING.md §63 — access, parity, performance), the L2-B positive
acceptance (TESTING.md §62 — approval, revisions, export) and the GANTT
baseline scenarios not exercised in the browser. After L3: L4, L5 and
commercial readiness; Constrap IQ / Quant AI, mobile / field and the final
audit later (Lead Architect's sequencing, 20 November 2026 — unchanged).
**Next release gate:** none for Stage 1 (no deploy belongs to it).
**Pre-customer gate:** the Firestore restoration verification — DONE,
SUCCESSFUL (REPORTED; DEPLOYMENT.md → *Restoration verification record*).

**Awaiting authorisation — none of these is approved yet:**

| Action | State |
|---|---|
| Git integration of `chore/l3-recovery-monitoring` (L3 Stage 1) | DONE — merged to `main` as `4bd358a` |
| Creating the uptime check and the two L3 alert policies in production (DEPLOYMENT.md → *L3 Stage 1* → *Creating the monitoring*) | DONE — created; five policies enabled and one uptime check (VERIFIED read-only, 21 November 2026). Alert delivery TESTED 24 November 2026 UTC (C1-D; temporary policy, Product Owner channel; receipt REPORTED) — *as written:* Alert delivery NOT tested |
| Running the Firestore restoration verification (`ops/recovery/README.md`) — creates and deletes a temporary database | DONE — SUCCESSFUL (REPORTED by the Lead Architect); temporary database removed, only `(default)` listed (VERIFIED) |
| L3 Stage 2 — application error recovery (ADR-80, Hosting-only) | DONE — merged as `b7f825f`; LIVE through the L4 Hosting release (`main` `a30699e`; REPORTED, 22 November 2026; bundle VERIFIED 25 November 2026). **E1–E10 run 25 November 2026 — not closed:** E1 and E3–E10 accepted with their evidence limitations, E2 open against tracker D3 #32 (TESTING.md §74.10). *As written before the run:* E1–E10 browser acceptance not recorded. *As written:* IMPLEMENTED on `fix/l3-application-error-recovery` (uncommitted). Awaiting architect review; Git integration and the Hosting deploy NOT AUTHORISED |
| GANTT core completion (ADR-79) | DONE — merged as `9ce433d`, released 20 November 2026 08:52 UTC (VERIFIED), Product Owner accepted (REPORTED). Certain baseline scenarios not exercised in the browser — a product acceptance check |
| L2-C Portfolio Report (ADR-78) | DONE — merged as `93db6cc` (VERIFIED) and deployed (live bundle VERIFIED 20 November 2026). Visual, CSV and PDF acceptance confirmed (REPORTED). **OPEN:** the access, parity and performance checks of TESTING.md §63 |
| `fix/l2b-final-account-reconciliation` (over-allocation readiness requirement; live / draft wording) | DONE — merged as `891043a` (VERIFIED); REPORTED deployed 20 November 2026 |
| L2-B positive production acceptance — approval, revisions, export (TESTING.md §62 F3–F17) | PENDING. The reconciliation correction's release is REPORTED done (20 November 2026). Written before that release: The team callables and the reconciliation worker must NOT be redeployed. On the test project the user must first correct the receipt over-allocating CI-0012 before a Final Account can be prepared |
| **Firestore recovery** — the restoration verification (`ops/recovery/README.md`; record in DEPLOYMENT.md → *Firestore recovery protection*) | Protection ENABLED; **two READY backups VERIFIED read-only, 21 November 2026** (`d05840df…` 19 November 16:51 UTC, `f6e32570…` 20 November 17:01 UTC). **Restoration verification SUCCESSFUL (REPORTED; recorded 21 November 2026): 44 collection groups / 211 documents and one sample hash matched; not every document's contents compared.** |
| Billing administration by the billing account owner (ownership, a second administrator, a budget and its notifications) | NOT DONE — administrator action; a follow-up outside DC46. **Paid billing is REPORTED by the Product Owner (17 November 2026);** that does not complete this item |
| Other DC46 follow-ups (Storage Data Access audit logs; Rules size reduction; load testing at agreed triggers; drawing-revision visibility policy; faster token revocation) | NOT STARTED, none approved — ROADMAP.md → *DC46 follow-ups* |
| Minor documentation debt — three source comments still read "Deferred Control 46 — still OPEN" | Not blocking (architect, 18 November 2026); fix with the next code change in those files |
| International tax compliance | Deferred to a dedicated future milestone (architect decision, 18 November 2026); GST stays the flat Australian 10% |

---

## B. Project identity

**Product.** Constrap is the connected commercial operating system for
construction projects, for small and mid-sized contractors: one commercial
dataset from preconstruction to final account, joined by the cost-code spine.
It is opinionated commercial workflow, not a form-first toolkit. Objectives,
roles and module status: [PRODUCT.md](../PRODUCT.md). Strategic boundaries:
[AGENT.md](../AGENT.md) → *Strategic Invariants*, [ROADMAP.md](../ROADMAP.md)
→ *Anti-Goals*.

**Brand.** Customer-facing name **Constrap** (renamed from "Constrapp" on
10 November 2026). The old spelling is deliberately kept in internal
identifiers (Firebase project id, repository directory, storage keys,
historical records). Never search-and-replace it — [AGENT.md](../AGENT.md) →
*Brand Name*.

**Stack (VERIFIED from the repository).**

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, JavaScript (no TypeScript), Tailwind CSS v4, React Router 7, React Context + hooks, Recharts 3 |
| Data | Firebase client SDK 12 — Auth, Firestore, Cloud Storage — behind `frontend/firestore.rules` and `frontend/storage.rules` |
| Trusted backend | `frontend/functions/` (codebase `team`, Node.js 22, Admin SDK): eight Callable Functions for team membership only (ADR-72), plus one scheduled worker `processFileLinkRevocations` (ADR-74/75). No financial logic |
| CI | Azure Pipelines (`azure-pipelines.yml`), on `main` and on PRs to `main`. No deploy stage |
| Tests | Vitest: unit (`test:unit`), Rules on emulators (`test:rules`), Functions pure (`functions:test`) and on emulators (`test:functions`) |

Architecture detail: [ARCHITECTURE.md](ARCHITECTURE.md). Data model:
[DATA_MODEL.md](DATA_MODEL.md).

**Repository structure (VERIFIED).**

```
frontend/            the whole application (Vite root)
  src/               pages, components, hooks (all Firestore access), lib (pure domain logic)
  functions/         the trusted backend package (own lockfile, tests, operator scripts)
  tests/             unit · rules · functions suites
  firestore.rules    storage.rules    firestore.transitional.rules (generated)
  firebase.json      Hosting, both rules files, the Functions codebase, emulators
ops/monitoring/      alert policy files — DC46 A, B, C created in production; L3 uptime check and two L3 policies created 21 November 2026
ops/recovery/        Firestore restoration verification procedure + read-only count script (verification run once, successful — REPORTED)
ops/RUNBOOK.md       production operations runbook
docs/                detailed documentation (this file lives here)
AGENT.md  CLAUDE.md  PRODUCT.md  ROADMAP.md  README.md  azure-pipelines.yml
```

**Infrastructure (identifiers only — no secrets belong in this file).**

| Component | Value | Status |
|---|---|---|
| Firebase / Google Cloud project | `constrapp-69b5d` | VERIFIED in repository documents |
| Region (Functions, Scheduler) | `australia-southeast1` | VERIFIED in repository documents |
| Production origin | `https://app.constrap.com` (the `web.app` / `firebaseapp.com` origins also serve) | REPORTED live 11 November 2026 |
| Hosting | Firebase Hosting, deployed by hand | REPORTED |
| Callables | `listTeam`, `createInvitation`, `resendInvitation`, `revokeInvitation`, `previewInvitation`, `acceptInvitation`, `changeMemberRole`, `deactivateMember` — App Check enforced | **VERIFIED** by read-only production check, 17–18 November 2026: revisions `-00004-*` (deployed 17 November 2026 20:49 UTC, source of `main` `5fb96da`; functions source unchanged in `0225b03`) |
| Worker | Cloud Run service `processfilelinkrevocations`, revision `-00003-ceg`, concurrency 1, own service account, `FILE_LINK_RECONCILE_INTERVAL_HOURS=2` | VERIFIED by read-only production check, 18 November 2026 |
| Scheduler | `firebase-schedule-processFileLinkRevocations-australia-southeast1`, every minute, enabled | VERIFIED by read-only production check, 18 November 2026 |
| Monitoring | Alert Policies A, B and C; log-based metric `dc46_reconciliation_plan_complete`; email channels `DC46 - Product Owner` and `DC46 - Billing Administrator` (addresses held only in Cloud Monitoring) | VERIFIED by read-only production check, 18 and 21 November 2026 (three policies, all enabled, two channels each). **L3 uptime check and L3 policies `15559930914799323534` and `9683374685335961795` CREATED and enabled — VERIFIED read-only, 21 November 2026; notification delivery NOT tested** (as written). **C1-D, 24 November 2026 UTC:** inventory re-VERIFIED (five policies, two channels unchanged); delivery of opened and resolved emails through the Product Owner channel tested with a temporary policy (receipt REPORTED); the availability policy file aligned with its check-id filter |
| Invitation email | Resend, from the Functions only; key in Secret Manager | REPORTED |
| Emulator project | `constrapp-rules-test` (tests only, never a real project) | VERIFIED |
| `.firebaserc` | None. Every deploy names `--project` explicitly | VERIFIED |
| General App Check enforcement (Firestore, Storage, Auth) | NOT ENABLED — metrics only | REPORTED |

Build, environment variables and every release procedure:
[DEPLOYMENT.md](DEPLOYMENT.md).

---

## C. Development responsibilities

**Product Owner**
- Owns product decisions.
- Authorises changes and releases.
- Executes Git integration and deployment.
- Confirms production acceptance.

**ChatGPT**
- Lead Software Architect.
- Senior Software Engineer.
- Technical Product Architect.
- Development Supervisor.
- Reviews Claude reports and approves gates.

**Claude Code**
- Implementation engineer.
- Performs repository inspections.
- Implements approved changes.
- Runs tests.
- Reports results.
- Does not deploy or commit without approval.

These roles are a **working convention**, recorded in
[AGENT.md](../AGENT.md) → *Collaboration Protocol* — not a technical fact
verified in Git. In practice: Claude Code does not commit, push, merge, deploy, publish rules,
or change Firebase, Google Cloud, IAM or billing unless a brief explicitly
authorises that step. It may be given **read-only** production inspection.

---

## D. Implementation protocol

This section describes how work flows. It does **not** replace
[AGENT.md](../AGENT.md), [CLAUDE.md](../CLAUDE.md) or
[ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), which stay binding and
unchanged.

1. **Architectural assessment before coding.** The architect issues a
   read-only inspection brief. Claude Code reads code and documents, changes
   nothing, and returns a numbered report. The brief ends *stop for architect
   review*.
2. **Explicit stage authorisation.** Implementation starts only on an explicit
   approval message. Each stage of a multi-stage item (and each production
   step) is authorised separately; approval of one never extends to the next.
3. **Briefs.** The architect writes a detailed, copyable plain-text brief: objective,
   numbered tasks, strict constraints, a *MANDATORY REPORT* list, and a stop
   instruction. The Product Owner pastes it into Claude Code.
4. **Claude model and session (convention).** Choose the Claude model for the
   task's complexity from the models available at the time — no specific
   model is a requirement. Where practical, keep one Claude session through
   assessment, implementation, corrections and release verification; start a
   fresh session at a completed milestone boundary. Give model and session
   instructions to the Product Owner **outside** the implementation prompt.
   A fresh Claude session starts from [CLAUDE.md](../CLAUDE.md) and has no
   earlier conversation, so the first brief of a session must carry full
   context.
5. **Branches.** Branch from `main`: `feature/`, `fix/`, `chore/`, `docs/`,
   and in practice also `ops/` and `refactor/`, lowercase kebab-case ([AGENT.md](../AGENT.md) → *Git Workflow*). Conventional
   Commit messages. One logical change per commit.
6. **Implementation report.** Every task ends with the report the brief asks
   for: branch and HEAD, files changed, tests run with counts, rules size
   where relevant, security statement in the honesty protocol
   ([ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §7), unverified
   facts, **whether this handover needs updating**, and GO / NO-GO.
7. **Test and review gates.** Lint (0 errors / 0 warnings), unit, Rules
   emulator, Functions pure and emulator suites, transitional-rules check and
   build, as applicable ([ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md)
   §4, §5, §8). The architect reviews the report and the diff before anything
   is committed.
8. **Commit, merge, Azure CI.** After architect approval the Product Owner
   commits, merges to `main` (history shows merge commits, *Merge …*) and
   confirms Azure CI is green on the merge. **CI green is not a deployment.**
9. **Production deployment approval.** A separate, explicit authorisation.
   The Product Owner runs the documented release order for that item from
   [DEPLOYMENT.md](DEPLOYMENT.md) — Rules-first, Hosting-first, Functions-first
   or multi-stage, as that item's section states. Firestore and Storage rules
   are published deliberately, never as a side effect.
10. **Production acceptance.** The Product Owner runs the acceptance steps in
    [TESTING.md](TESTING.md). Where the backend leaves evidence (request logs,
    worker logs, audit events), acceptance is confirmed against it — a
    reported pass with no backend trace is not recorded as accepted.
11. **Documentation closeout.** A docs-only branch corrects every status line
    to what actually happened (DEPLOYMENT, SECURITY, ROADMAP, the ADR, TESTING),
    and this handover is updated. Only then is the milestone closed.

---

## E. Architectural invariants

Summaries only. The linked source is authoritative.

| Invariant | Rule | Source |
|---|---|---|
| **Multi-tenant isolation** | Every document except `users/{uid}` lives under `companies/{companyId}/…`. Rules read `users/{uid}` and compare `companyId` to the path. The membership document is client-read-only | [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §1; [SECURITY.md](SECURITY.md) → *Authentication & Membership* |
| **Where security is enforced** | Firestore and Storage Security Rules are the trust boundary for all client-SDK data. The team-management Functions bypass rules and authorise every call themselves. Client-side role and lifecycle checks are UX only. Never call a client-only control "enforced" | [SECURITY.md](SECURITY.md); [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §6–§7 |
| **Trusted backend is narrow** | `frontend/functions/` does team membership and download-token clean-up, plus ONE financial operation: the ADR-77 `approveFinalAccount` callable (deployed; production acceptance pending), which recomputes and finalises a Final Account revision. No other financial write, general API or new trigger without a new ADR | [ARCHITECTURE.md](ARCHITECTURE.md) → *Client-SDK Data Access + One Narrow Trusted Backend*; ADR-72, ADR-74, ADR-77 |
| **Rules capacity** | The Firestore ruleset must stay under the approved 245,000-byte budget (hard limit 262,144). `main`: 232,460 bytes (12,540 of headroom), REPORTED published. The reconciliation correction changes no Rules | [SECURITY.md](SECURITY.md) → *Ruleset source-size limit*; ADR-60, ADR-69, ADR-76 |
| **Financial correctness** | Committed, Claimed, Actual, Invoiced, forecast, margin and cash figures are derived at read time. Nothing writes a financial rollup onto a Budget Line. All money through `roundMoney`; canonical amounts ex-GST. A failed or loading source shows *Unavailable*, never zero | [AGENT.md](../AGENT.md) → *Financial Invariants*; [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md); ADR-41, ADR-44, ADR-55 |
| **Approved Budget** | An immutable approved version plus approved adjustments; never a silent fallback to working lines | ADR-70, ADR-71 |
| **Per-project currency** | One currency per project; a label, never a conversion. No FX. Format only through `formatCurrency`. GST stays a flat Australian 10% — currency is not tax | [AGENT.md](../AGENT.md) → *Financial Invariants*; ADR-21 |
| **Commercial lifecycle integration** | New commercial modules join the lifecycle through the cost-code spine (`costCodeId` + `costCodeName` snapshot). Field features must state their commercial input or output | [AGENT.md](../AGENT.md) → *Strategic Invariants* |
| **Data integrity** | Forward-only lifecycles; financial records are never deleted; transactional document numbering; names snapshotted at write time and never backfilled; paired writes verified in rules with `getAfter()` where a cross-document invariant matters | [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §1, §3; ADR-57 to ADR-59, ADR-61, ADR-68 |
| **Code structure** | Hooks-only Firestore access; pure domain logic in `frontend/src/lib/`; no new dependency without instruction | [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §1, §3 |
| **Error handling** | Hooks expose their error state; pages gate every figure on its verified sources; messages are friendly and leak nothing | ADR-41, ADR-44 |
| **Production safety** | Nothing reaches production without a named authorisation. Release order per item is documented and followed. No secret in the frontend bundle or in Git. Proposed work is never described as live | [DEPLOYMENT.md](DEPLOYMENT.md); [SECURITY.md](SECURITY.md) → *Secrets & the Vite bundle* |

All decision records: [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) (ADR-0a to
ADR-80).

---

## F. Completed milestones

Production status below is **REPORTED** — taken from the repository's release
records, most of them "confirmed by the Product Owner". Dates are as recorded.

| Module | What is live | ADRs | Status |
|---|---|---|---|
| **Commercial workflow** | Cost Codes, Budgets, Purchase Orders, Progress Claims, Supplier Invoices, Variations, Forecast, Margin, Client Invoices, Client Receipts, Supplier Payments, Credit Notes, Retention Release, Cash Flow, BOQ, Tenders, Contacts, Documents & Drawings, RFIs, Company Country & Currency | See ROADMAP.md → *Completed Foundations* | LIVE (foundations) |
| Commercial integrity releases | M1 forecast integrity; M2-A read containment; M2-B1/B2/B3 PO, claim and variation lifecycle rules; M3-A award → draft PO; M3-B1 variation commitment; M3-B2 new-scope claims | ADR-55 to ADR-63 | LIVE (from 27 October 2026) |
| **Premium Dashboard** | Dashboard v2 on derived figures only | ADR-42, ADR-45 | **DEPLOYED — VERIFIED read-only, 25 November 2026** (live bundle SHA-256-identical to `main`); figures and switching PASSED in production against independent expectations (TESTING.md §74.5) — tested financial calculations accepted by the Lead Architect (§74.10); roles and layout checks (§22 checks 2 and 3) not run — open; release date not recorded. *As written:* Merged and recorded as implemented; **production release not recorded** — see the verification list below |
| **PULSE** | 1A six commercial indicators; 1B acknowledgement; 1C three schedule indicators | ADR-47, ADR-49, ADR-67 | LIVE |
| **SHIELD** | Foundation (five assurance checks); 2A claim-to-invoice pairing; 2B1 Approved Budget Versions; 2B2 Budget Adjustments | ADR-50, ADR-68, ADR-70, ADR-71 | LIVE |
| **Quant** | 1A manual measurement; 1B BOQ link and explicit apply; 1C editing and summary; 1D deductions | ADR-51 to ADR-54 | LIVE (October 2026) |
| **GANTT** | 1A1 programme tab; 1A2 dependencies; 1B approved baselines and variance | ADR-64 to ADR-66 | LIVE — DEPLOYED, VERIFIED read-only 20 November 2026 (ADR-79 → *Production evidence*) |
| **GANTT core completion** (G1, G2, G3) | Schedule attention filter; programme CSV and print; last-change visibility | ADR-79 | **LIVE since 20 November 2026 08:52 UTC — Product Owner accepted** (live bundle VERIFIED 21 November 2026; acceptance REPORTED) |
| **L1 Team Management** | Invitations, acceptance, role changes, deactivation through the trusted backend; Constrap brand and custom domain | ADR-72 | LIVE and accepted, 11 November 2026 |
| **DC46-A** | Authenticated Storage reads; the app mints no download URL | ADR-73 | LIVE, 11 November 2026 |
| **DC46-B** | Scheduled worker removes legacy download tokens after a membership change | ADR-74 | LIVE and accepted, 12 November 2026 |
| **DC46-C Stage 1** | Updated worker (fair scheduling, recovery rules, concurrency 1) and periodic reconciliation | ADR-75 | Worker DEPLOYED 13 November; ACCEPTED 16 November 2026. **Periodic reconciliation ACTIVE at a 2-hour interval since 17 November 2026 19:16 UTC**; three periodic sweeps observed, all complete |
| **DC46-C callable deployment** | The eight team callables redeployed from `main` `44446a0`, callables only (revisions `-00003-*`, since replaced by `-00004-*` on 17 November 2026), so they write the ADR-75 request priority. The worker was not redeployed | ADR-75 (implementation status) | DEPLOYED and ACCEPTED 16 November 2026; verified read-only. **Deactivation regression through the new revisions PASSED 16 November 2026** (TESTING.md §55) |
| **DC46-C monitoring** | Alert Policies A, B and C and two email notification channels on the worker. Detection only — not a control and not an external monitor | ADR-75 (implementation status) | A and B CREATED 16 November, C 17 November 2026; verified read-only; test delivery REPORTED by both recipients; no failure condition has fired on a real failure |
| **DC46-C Stages 2 and 3** | No client can change a document from `project` to `internal`; a Company Admin can remove a subcontractor or client | ADR-75 | LIVE 17 November 2026 (`main` `5fb96da`; callables `-00004-*`); production-accepted 18 November 2026 |
| **DC46 external document access** | Non-internal roles read only `project` + `active` documents (Firestore and Storage Rules, hook, page) | ADR-75 | LIVE 17 November 2026 22:15 UTC (`main` `0225b03`); production-accepted 18 November 2026 |
| **DC46 closure** | Final external-member acceptance on a disposable subcontractor; documentation closeout | ADR-75 → *DC46 closure record*; TESTING.md §59 | **Deferred Control 46 CLOSED 18 November 2026 with accepted risks** |
| **L2-A Commercial Report** | Read-only project report on the Reports tab; CSV and print | No ADR | LIVE and production-accepted — REPORTED by the Lead Architect, 19 November 2026 |
| **L2-B Stage A** | Firestore Rules capacity recovery 3: leading-whitespace re-indent, 242,163 → 229,115 bytes | ADR-76 | LIVE 18 November 2026 21:57 UTC; live ruleset VERIFIED byte-identical to `main`, 19 November 2026 |
| **M2-A2 External Project Isolation** | Stage A: external-safe project directory; reads of drawings, revisions, project documents and files scoped to assigned projects; project document internal-only. Stage B: operator-provisioned `client` / `subcontractor` invitations carrying `projectIds`; audited assignment changes with urgent file-link revocation on removal; assignment reset on acceptance and deactivation | ADR-83, ADR-84 | **LIVE and CLOSED** — Stage A 23 November 2026; Stage B live 23 November, production-accepted 24 November 2026 (TESTING.md §68, §69); **DC20 CLOSED**. Customer onboarding separately gated |
| **L4 BOQ → working budget transfer** | *Transfer to budget* on the BOQ tab through the trusted `transferBoqToBudget` callable; WORKING lines only; acceptance UX correction | ADR-81 | **LIVE and production-accepted, 22 November 2026** (REPORTED by the Lead Architect); browser gaps T9, T14, the Quant step of T16 and a real disconnection — emulator coverage retained (TESTING.md §67) |

**Planned, partial or not built — do not present as complete:**

| Item | State |
|---|---|
| DC46 follow-ups (billing administration, Storage audit logs, Rules size, load testing at triggers, drawing visibility, faster revocation) | NOT STARTED, none approved — ROADMAP.md → *DC46 follow-ups* |
| DC46-C Stage 4 measurement at volume | DEFERRED to a threshold-triggered follow-up (about 500 companies, about 50,000 objects in one company, or routine deferral/overdue lines) |
| Availability monitoring | An uptime check on `app.constrap.com` and its alert policy EXIST (L3 Stage 1; VERIFIED read-only, 21 November 2026; the email path TESTED with a temporary policy on 24 November 2026 UTC, C1-D; the policy itself has never fired). It lives inside the production project; a monitor independent of the project is not built and not in L3 |
| GST boundary hotfix (`fix/gst-boundary-pins`) | **DEPLOYED, Rules and Hosting — VERIFIED read-only, 25 November 2026** (TESTING.md §74.1); calculations verified independently (§74.4) — calculation compatibility accepted by the Lead Architect (§74.10); manual acceptance steps 1–3 of §44 not run in production — outstanding, retained for the relevant financial implementation milestone; precision concern tracker D3 #35; release dates not recorded. *As written:* Merged; production state unconfirmed — see the verification list below |
| Estimating | Not built (the BOQ → working budget transfer is LIVE — ADR-81; approval stays with SHIELD) |
| Commercial reports | L2-A project Commercial Report LIVE and production-accepted (REPORTED, 19 November 2026). **L2-C Portfolio Report DEPLOYED** (ADR-78) — visual and export acceptance PASSED (REPORTED, 20 November 2026); security, parity and performance checks OPEN. Programme CSV / print: LIVE (ADR-79). Not built: charts, trends, portfolio cash-flow forecast, programme indicators on the portfolio, saved report history |
| Final Account | **L2-B DEPLOYED — PRODUCTION ACCEPTANCE PENDING** (ADR-77): revisions, trusted approval, immutable snapshot, drift comparison, CSV / print. The reconciliation correction is REPORTED deployed (20 November 2026); positive approval acceptance pending. Not built: client signature or certificate, client retention, subcontract final accounts, creator ≠ approver segregation |
| Constrap IQ; Quant AI; any AI capability | Not built; DEFERRED (Product Owner, 22 November 2026); placeholder rule applies |
| Accounting integrations | Not built. Xero ASSESSED — IMPLEMENTATION DEFERRED (ADR-82, PROPOSED, not approved; the product-market-fit gate is not lifted) |
| Billing and subscriptions; self-serve company signup; client portal | Not built (company creation and external-member provisioning are operator tasks) |
| International tax and currency | Australian GST only; no BSD currency; international tax compliance deferred (18 November 2026) |
| Photos; mobile / PWA packaging | Placeholder / not built |
| General App Check enforcement | Not enabled |

**Resolved as to deployment, 25 November 2026 (TESTING.md §74.1):** both items
below are in production — the live rulesets and bundle are identical to
`main`, which contains them. No release record exists for either, so their
release dates stay unknown. The unexecuted manual checks are listed in the
tracker (C4 → *Evidence*).

*As written before 25 November 2026:* **Left for verification — production state not established by any release
record:**

- **GST boundary hotfix.** VERIFIED merged (`ea2eea8`).
  [DEPLOYMENT.md](DEPLOYMENT.md) still reads *NOT YET DEPLOYED* and now carries
  a verification note. Later releases of rulesets that contain it are
  recorded live, but that is an inference, not a record, and says nothing
  about its Hosting step. Needs Product Owner confirmation of both steps.
- **Premium Dashboard v2 (ADR-45).** VERIFIED merged (`ba52821`) and recorded
  as implemented in [PRODUCT.md](../PRODUCT.md) and [TESTING.md](TESTING.md)
  §22. No production release or acceptance record exists for it. Needs
  Product Owner confirmation.

Five stale status lines found on 16 November 2026 were corrected from
repository evidence on the `docs/constrap-context-continuity` branch (M3-B2 in
ROADMAP.md; the worker status, test tooling and CI summary in
ARCHITECTURE.md; the `backend/` statement in AGENT.md; the ADR-75 title).

---

## G. DC46 final state — CLOSED 18 November 2026

Sources: [SECURITY.md](SECURITY.md) → *Deferred Controls* item 46;
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) → ADR-73, ADR-74, ADR-75
(*DC46 closure record*); [DEPLOYMENT.md](DEPLOYMENT.md) → *DC46 — production
closure record*; [TESTING.md](TESTING.md) §52–§59;
[ops/monitoring/README.md](../ops/monitoring/README.md). Times UTC.

| Item | State |
|---|---|
| ADR-73 (DC46-A) | The app does not deliberately expose token-based download URLs (it never requests one); every read is rules-checked. Firebase Storage uploads can still create download-token metadata, which the reconciliation worker removes. LIVE 11 November 2026 |
| ADR-74 (DC46-B) | Scheduled worker removes download tokens after a deactivation or an internal-to-external role change; request queued in the membership transaction. LIVE 12 November 2026 |
| ADR-75 Stage 1 — periodic reconciliation | **ACTIVE at 2 hours since 17 November 2026 19:16** (worker `-00003-ceg`, `main` `2b3ba9a`). VERIFIED: hourly heartbeats; periodic sweeps 17 November 19:18:02 (5 scanned, 0 removed), 22:19:02 (5, 0) and 18 November 00:21:02 (9, 4 removed), all complete, zero failures. Rollback checkpoint for the worker: `a2544a1` (disable policy C) |
| ADR-75 Stage 2 — visibility lock | LIVE 17 November 2026 20:47 (Rules). VERIFIED in production 18 November: a notes-only edit accepted, `project → internal` refused (403) |
| ADR-75 Stage 3 — external-member removal | LIVE 17 November 2026 20:49 (callables `-00004-*`, Hosting). VERIFIED in production 18 November: `deactivateMember` 200 on `deactivatemember-00004-kom`; three audit events under one request id; Auth disabled, refresh tokens revoked; urgent sweep complete 20 seconds later (9 scanned, 0 removed, 0 failed); queue 0 |
| External document access follows status | LIVE 17 November 2026 22:15 (`main` `0225b03`; both rules files and Hosting). VERIFIED in production 18 November with the test subcontractor's own session: active documents 200; superseded, withdrawn and internal 403 for metadata, bytes and queries |
| ADR-75 Stage 4 | Volume measurement DEFERRED to a threshold-triggered follow-up. Orphan-prefix check done once (one prefix, one company). Closure wording agreed in the closure record |
| Monitoring | Policies A, B and C enabled, two email channels each. Detection only. No failure condition has fired on a real failure; incident state is not readable through the available API |
| Test identity | Disposable subcontractor `q1IctaF2YhdRTdaY0GdpdetKc3U2`, operator-provisioned 17 November 22:48, deactivated 18 November 02:11; Auth disabled; membership and audit records kept; its four test documents withdrawn |
| Not covered by the acceptance | A `client` or `super_admin` identity; a second production tenant; Android Chrome |
| **Deferred Control 46** | **CLOSED with accepted risks** |

**Wording rules.** "Closed" means the scoped control is live and accepted —
never that copied links die instantly. Never say the app "creates no
tokens": it does not deliberately expose token-based download URLs, but
uploads can create download-token metadata that the worker later removes.
Never describe the 2-hour interval as immediate revocation, a guarantee or
a strict revocation deadline — completion depends on scheduling, worker
health and backlog: a token lives until the next
successful sweep of its company (about 3 hours plus queue and sweep time
without a membership change; longer if a sweep is incomplete or the worker
is stopped). Membership removal is immediate; link revocation is a
background clean-up. Monitoring is detection only — never a control, an
external monitor, or proven against a real failure; Policy A must not be
described as detecting a billing interruption. Never describe the accepted
risks as eliminated.

---

## H. Roadmap

**Source of truth:** [ROADMAP.md](../ROADMAP.md) → *Strategic Development
Sequence*. Read it there; the list below is only the order.

1. Complete DC46 security — **DONE** (Deferred Control 46 closed 18 November 2026; section G).
2. International infrastructure assessment — **DONE** (18 November 2026). Firestore recovery protection ENABLED 18 November 2026; two READY backups VERIFIED 21 November 2026; restoration verification SUCCESSFUL (REPORTED, recorded 21 November 2026).
3. L2 — Commercial Reports and Final Account — **L2-A LIVE and accepted**; L2-B: Stage A LIVE; **Stage B DEPLOYED — PRODUCTION ACCEPTANCE PENDING** (reconciliation correction REPORTED deployed 20 November 2026; positive approval acceptance pending); **L2-C Portfolio Reporting DEPLOYED** (ADR-78; visual and export acceptance PASSED — REPORTED; security, parity and performance checks OPEN). **GANTT core completion (ADR-79) LIVE and Product Owner accepted** (20 November 2026).
4. L3 — Production Reliability — **CLOSED** (REPORTED by the Lead Architect, 21 November 2026; Stage 2 merged as `b7f825f` — VERIFIED in Git; its Hosting deploy not independently verified here).
5. L4 — BOQ-to-Approved-Budget integration — **CLOSED — LIVE and production-accepted, 22 November 2026** (ADR-81; REPORTED by the Lead Architect; browser gaps T9, T14, the Quant step of T16 and a real disconnection, emulator coverage retained). *As written before:* IMPLEMENTED, NOT DEPLOYED.
6. L5 — Accounting integrations, Xero first — **ASSESSED — IMPLEMENTATION DEFERRED** (22 November 2026; ADR-82 PROPOSED, not approved).
7. Constrap IQ and AI capabilities — **DEFERRED** (Constrap IQ and Quant AI; 22 November 2026).
8. Advanced construction modules — NOT STARTED; unscoped future backlog item, no features or priority assigned.
9. SaaS commercialisation — NOT STARTED.
10. Mobile and field experience — NOT STARTED.
11. Final production audit — NOT STARTED.

**This sequence is strategic intent, not an implementation commitment.** It
authorises nothing and overrides no ADR. Each stage needs its own assessment,
its own ADR where it introduces a pattern, and a separate implementation
approval. Stages 2, 4, 8 and 11 have no scope recorded in the repository.

**Approved development order (post-L4) — Product Owner, 22 November 2026.**
The stage numbers above stay as identifiers. The work still to do runs in
this order (ROADMAP.md → *Approved development order (post-L4)*):

1. Remaining core functionality and outstanding product acceptance.
2. Commercial SaaS readiness and international foundations.
3. Mobile / field experience.
4. Xero / accounting integration.
5. Constrap IQ AI.
6. Quant AI.
7. Final comprehensive production audit.

Stage 8 (advanced construction modules) stays an unscoped future backlog
item: no features or priority are assigned to it.

- **L5:** Xero is the preferred first accounting integration, subject to
  product-market-fit validation and a separately approved integration
  strategy. Until then accounting integrations remain an anti-goal.
  **Assessed 22 November 2026, implementation deferred.**
  - The proposed design is preserved in ADR-82, which is NOT approved.
  - The gate is not lifted.
  - No Xero registration, credential or additional Cloud Function is
    authorised.
- **Stage 7:** the AI Feature Placeholder Rule in [AGENT.md](../AGENT.md)
  stays in force until an approved strategy lifts it.
  - Both modules are kept: **Constrap IQ** (project intelligence,
    forecasts, risk detection, decision support) and **Quant AI** (drawing
    interpretation, automated quantity takeoff).
  - Both are deferred until the core, international and integration
    foundations are sufficiently mature.
- The *Anti-Goals* in ROADMAP.md apply to every stage.

---

## I. Open risks

| Risk | State | Source |
|---|---|---|
| **Billing continuity** | The project lost billing for about 17 hours on 12–13 November 2026 and the worker did not run. A permanent paid account is **REPORTED** by the Product Owner (17 November 2026); who owns it, a second administrator, a budget and who receives billing notices are all **unconfirmed** — a follow-up outside DC46 | DEPLOYMENT.md → *Billing interruption*, *Billing continuity*; ROADMAP.md → *DC46 follow-ups* |
| **Monitoring is unproven against a real failure** | *Corrected 25 November 2026 (C1-D):* policy B fired once, on the expected activation overdue line (17 November); A, C and the L3 policies never have. The email path was tested end to end on 24 November with an opened and a resolved notification (Product Owner channel; receipt REPORTED). Gaps retained: `transferBoqToBudget` alert, callable errors without a 5xx, membership-reconciliation and backup monitoring, billing-outage monitoring, independent notification paths (tracker B9). *As written:* Policies A, B and C exist, but none has fired on its real condition; only the email path was exercised, and receipt is reported, not observed. Policy B depends on the worker writing a matching error line. Monitoring and the worker share one project (accepted risk) | DEPLOYMENT.md → *DC46-C monitoring readiness* → *Monitoring release record* |
| **Reconciliation** | Active at 2 hours since 17 November 2026; three periodic sweeps observed, all complete. The two-hour interval is not a strict revocation deadline: completion depends on scheduling, worker health and backlog, and an incomplete sweep or a stopped worker lengthens it | ADR-75 → *DC46 closure record*; TESTING.md §56, §59 |
| **Rollback of reconciliation** | Rolling the callables back to the ADR-74 build is unsafe once any periodic request has existed. Policy C must be disabled if the interval is rolled back to `0` | DEPLOYMENT.md → *DC46-C* → *Activation runbook* |
| **Interval choice** | 1 hour is valid in code but rejected: it collides with the hourly planning period and raises false overdue alerts. A later change of interval must stay at 2 or more | ADR-75 → *Activation readiness*; TESTING.md §56 |
| **Visibility and status changes** | No client can reduce visibility; a correction needs an operator. A console or Admin SDK edit bypasses Rules and queues no revocation. After a withdrawal, supersession or console change a copied link lives until the next periodic sweep (accepted risk) | SECURITY.md item 46; DEPLOYMENT.md → *Operator procedure — correcting a document's visibility* |
| **External members** | **Updated 24 November 2026:** provisioning is operator-only through `provision-external-member.mjs` (an invitation the invitee accepts) and assignment changes through `set-member-projects.mjs` (ADR-84, LIVE); external reads are scoped to assigned projects (DC20 CLOSED). Still open: an assigned member reads every revision of an assigned project's drawings, withdrawn ones included; any active member can mint a copied download link (removed by the next sweep); Admin SDK / console writes bypass the scripts' audit and revocation; App Check not enforced; operator-tooling hazards. **Real customer external onboarding BLOCKED** pending a readiness decision. *As written before:* Removal by a Company Admin is live and production-accepted. Provisioning is still an operator task (an Auth account plus `users/{uid}`); there is no script for it. Membership is company-wide — an external member reads every drawing revision in the company, withdrawn ones included (accepted risk) | SECURITY.md → *External Project Isolation — M2-A2 Stage B*; item 46; SECURITY_DATA_TEST_TRACKER.md → *Security risk register* |
| **Storage-token limitations** | Revocation is not immediate; an active member can still obtain a link by a direct SDK call; token behaviour relied on is undocumented by Firebase; tokens reappeared twice in November from an unattributed cause (none since); scale is unmeasured (largest sweep: nine objects) — load testing is a triggered follow-up | SECURITY.md item 46; ADR-74; ADR-75 |
| **Monitoring's own limits** | Policy A cannot be relied on for a billing suspension or a deleted service; both policies live in the project they watch. An independent external availability monitor remains future reliability work | DEPLOYMENT.md → *Policy A* limitations |
| **International region / latency** | All backend resources are in `australia-southeast1`. Assessed 18 November 2026: retained (architect decision). Measured from New Zealand only (Firestore request about 100–115 ms after TLS); no Caribbean, North American or European measurement exists — validate with a pilot customer session. Tax remains Australian GST only; international tax deferred | ROADMAP.md → *Strategic Development Sequence* stage 2; AGENT.md |
| **Firestore recovery** | PITR (7 days), daily backups (14-day retention) and delete protection ENABLED 18 November 2026. Two READY backups VERIFIED 21 November 2026. **No restore has been tested, so recovery is unproven**; the verification compares counts and one sample hash, not every document. Storage files are outside Firestore backups (7-day soft delete only). No alert watches backup freshness — a weekly manual check | DEPLOYMENT.md → *Firestore recovery protection*; `ops/recovery/README.md`; `ops/RUNBOOK.md` |
| **Operational visibility** | An availability check and a Final Account failure alert exist since L3 Stage 1, but neither has fired. Notification delivery through the Product Owner channel was TESTED on 24 November 2026 UTC (C1-D; *as written:* notification delivery is NOT tested). Client-side errors reach only the user's browser console — no reporting service, by decision deferred to commercial readiness. All alerting lives inside the project it watches | `ops/monitoring/README.md`; ROADMAP.md stage 4 |
| **Application error recovery (L3 Stage 2 — LIVE through the L4 Hosting release, ADR-80; TESTING.md §66)** | The project route now distinguishes a failed, refused or cached-only read from *Project not found*, and Client Invoices, Client Receipts and Supplier Payments use the write-outcome helper. **58 older write sites keep the earlier behaviour**: raw SDK error text, and a write made offline leaves the dialog on *Saving…* — user confusion, not a data-integrity risk (single-document, Rules-guarded writes). E1–E10 browser acceptance not recorded. *As written before release:* IMPLEMENTED, NOT DEPLOYED; until deployed, a failed projects read showed *Project not found* | L3 assessment, 21 November 2026 |
| **False membership notice on a cold load (tracker D3 #32, 25 November 2026)** | With the database unreachable while the page loads, the membership gate states *No active membership*; it recovers by itself when the server answers. Seen on local emulators, not in production with a session. No data or authorisation effect. Relevant to any field or mobile use. **P2 — the next implementation task (Lead Architect, 25 November 2026); the correction must not weaken authorisation and adds no service worker or PWA.** **CLOSED 26 November 2026 — the correction is LIVE (`main` `0bdca38`) and was verified in production (TESTING.md §76).** *As written before the release:* **Correction IMPLEMENTED 25 November 2026 on `fix/membership-resolution-state` (uncommitted; not deployed): only a server-confirmed profile decides membership; a cache-only answer shows *Waiting for the server*. Until it is deployed, production still has the defect** | TESTING.md §74.3, §74.10, §75; tracker D3 #32, B11 |
| **GST half-cent rounding — financial precision concern (tracker D3 #35, 25 November 2026)** | `roundMoney(x × 0.1)` gives a GST amount one cent below exact decimal half-up on some half-cent boundaries (1,632 amounts per $10,000; never high). The Rules pins admit it — compatibility, not independent mathematical correctness. Deliberate and documented; `roundMoney` was left unchanged by the GST boundary hotfix. Rounding semantics are to be assessed before client credit notes and client retention; nothing changes now | PROJECT_DECISIONS.md → *ADR-40 / ADR-57 Correction: GST Boundary Hotfix* (*Limitations*), ADR-57 decision 4, ADR-10; TESTING.md §74.4, §74.10 |
| **Rules capacity** | **236,737 of 245,000 bytes — 8,263 bytes of headroom (live ruleset read 25 November 2026 — VERIFIED).** A new collection block of the source size of `supplierCreditNotes` (8,403 bytes) exceeds that source headroom. **Source-file size alone does not establish deployable Rules capacity (Lead Architect, 25 November 2026):** a capacity assessment, then any necessary recovery, precedes client credit-note implementation. *As written:* 232,460 of 245,000 bytes — 12,540 bytes of headroom (REPORTED published 20 November 2026). The 1000-expression ceiling and access-call budget are unchanged by ADR-76 | SECURITY.md → *Ruleset source-size limit*; ADR-76, ADR-77 |
| **Client-enforced controls** | Several lifecycle, uniqueness and cumulative-cap controls remain client-only | SECURITY.md → *Deferred Controls* |
| **Final Account (deployed, not accepted)** | No revision has been prepared or approved in production; approval consistency is proven against the EMULATOR only. The reconciliation correction is REPORTED released (20 November 2026), so the callable is REPORTED to refuse an over-allocated client invoice and the live view to label forecast figures as forecasts — not re-read from production in this revision. A draft's figures are unverified until the callable recomputes them; the Admin SDK and console can alter an approved revision; the server calculation must be regenerated when `lib/finalAccount.js` or a module it imports changes; registers stay writable after approval — differences are reported, not prevented | SECURITY.md item 47; ADR-77 |
| **General App Check enforcement** | Not enabled on Firestore, Storage or Auth | DEPLOYMENT.md → *Deferred: general App Check enforcement* |

---

## J. Exact next action

**Done, 16–18 November 2026 (records in DEPLOYMENT.md and TESTING.md
§54–§59):** monitoring policies A and B; the eight-callable deploy and the
deactivation regression; activation of periodic reconciliation at 2 hours
with policy C; Stages 2 and 3; the external document access correction;
the final external-member acceptance in production; the DC46 documentation
closeout (this branch).

**Done, 18 November 2026:** the DC46 documentation closeout (merged as
`84c9fb3`); the international infrastructure assessment (read-only,
architect-approved); the L2-A Commercial Report implementation (branch,
uncommitted).

**Done, 19–20 November 2026:** L2-B Stage A (ADR-76) live; L2-B Stage B
(ADR-77) implemented, merged as `c4b93e5` and REPORTED deployed (Rules, the
one callable, Hosting); a read-only production reconciliation of the test
project's receivables (one over-allocated invoice, CI-0012, by 500.00 — no
calculation defect); the reconciliation correction implemented, merged as
`891043a` and REPORTED deployed, with negative-readiness and reconciliation
acceptance passed; the L2-C read-only assessment and, after the Lead
Architect's GO (ADR-78), the L2-C Portfolio Report — merged as `93db6cc`
and deployed, visual and export acceptance REPORTED passed; the GANTT core
completion read-only assessment (production state of GANTT 1A1 / 1A2 / 1B
and PULSE 1C VERIFIED) and, after the Lead Architect's GO (ADR-79), its
implementation on `feature/gantt-core-completion` (uncommitted).

**Next, from 25 November 2026 (Lead Architect decision on the L3 / GST / Dashboard run — REPORTED). Each step needs explicit authorisation and its own brief.**

0. **Git integration** of `docs/l3-regression-acceptance` (authorised;
   documentation only; uncommitted until asked). *DONE — `main` `1bc46bc`,
   VERIFIED in Git, 25 November 2026.*
1. **D3 #32 membership reliability fix** — P2. Correct the membership-state
   handling without weakening authorisation. No service worker, no PWA.
   Correct the E2 procedure (D3 #34) with it.
   **IMPLEMENTED 25 November 2026 on `fix/membership-resolution-state`
   (uncommitted) — awaiting architect review, then integration and a
   Hosting deploy, each on explicit authorisation (TESTING.md §75).**
2. **L3 E2 corrected acceptance.** L3 stays open until then. *E2-A and E2-B
   PASS on local emulators; the production run follows the deploy
   (TESTING.md §75.9). E2-C is a recorded limitation.*
3. **Client credit-note architecture assessment and ADR** — with the
   rounding-semantics assessment (D3 #35).
4. **Firestore Rules capacity assessment and any necessary capacity
   recovery.** Do not treat source-file size alone as deployable capacity.
5. **Client credit-note implementation.** The outstanding GST manual checks
   (§44 steps 1–3) are retained for the relevant financial milestone.
6. **Client retention.**

Preserved: estimating, approval segregation and the remaining approved
commercial roadmap; the post-L4 development order; the customer-onboarding
gate. Still open, not passed: Dashboard §22 checks 2 and 3.

*As written at the run —* **Next, from 25 November 2026 (L3 / GST / Dashboard run). Each step needs explicit authorisation.**

1. **Lead Architect decision on the run** (tracker B10; TESTING.md §74.9):
   L3 closure with E2 open; acceptance of the GST hotfix and Dashboard v2
   with their unexecuted checks; priorities of D3 #32–#34.
2. **Git integration** of `docs/l3-regression-acceptance` (documentation
   only; uncommitted) once reviewed.
3. **Proposed: L3 reliability correction** — D3 #32, Hosting-only, with unit
   tests of the membership gate; then re-run §66 E2 with the corrected
   procedure (D3 #34).
4. **Proposed next commercial milestone: client credit notes** — assessment
   and ADR first; a Firestore Rules capacity recovery before its Rules
   change (8,263 bytes of headroom today). Status and dependencies of the
   other commercial gaps: tracker D4a.
5. **Optional, if wanted:** the GST §44 manual steps on an authorised
   synthetic fixture (scope in TESTING.md §74.4); Dashboard §22 checks 2
   and 3.
6. The post-L4 development order and the customer-onboarding gate are
   unchanged.

*As written for the C1-A closeout:* **Next, from 25 November 2026 (C1-A closeout). Each step needs explicit authorisation.**

*Done, 24–25 November 2026:* C1-B CLOSED and merged (`2561344`); C1-A
remaining acceptance run and **C1-A CLOSED** (Lead Architect, 25 November).

*Done, 25 November 2026 (NZDT):* C1-A closeout integrated (`main` `0cf17e6` —
VERIFIED in Git; Azure green — REPORTED). L4 remaining acceptance and the
Stage A internal-role regression **run in production** (tracker B7, TESTING.md
§71) and **CLOSED by the Lead Architect** — L4 with recorded evidence
limitations, Stage A within its applicable scope.

0. **Now (C1-D closeout):** Git integration of `docs/c1d-monitoring-acceptance`
   (authorised; C1-D CLOSED by the Lead Architect, 25 November 2026). Then
   **the next milestone — L3 Stage 2 E1–E10 remaining acceptance.** *As
   written at the run:* the architect's decision on **C1-D closure** (tracker
   B9, TESTING.md §73 — recommended GO), then Git integration of
   `docs/c1d-monitoring-acceptance` (uncommitted: docs, plus the aligned
   availability policy file and its test). Next milestone proposed: **L3
   Stage 2 E1–E10**. *Done:* `docs/c1c-gantt-acceptance` integrated
   (`main` `caf6ecf`). *As written for the C1-C closeout revision:*
   **Now (C1-C closeout):** Git integration of `docs/c1c-gantt-acceptance`
   (documentation only, uncommitted; authorised). Then **the next milestone —
   C1-D — monitoring and alert delivery** (needs its own brief and an
   authorised synthetic trigger), then L3 Stage 2 E1–E10. C1-C functional
   acceptance is CLOSED; its carried-forward checks and D3 #30–#31 (P3) stay
   tracked. *As written at the run:* the architect's decision on **C1-C closure**
   (tracker B8, TESTING.md §72 — recommended GO with the recorded limits),
   then Git integration of `docs/c1c-gantt-acceptance` (documentation only,
   uncommitted) and the triage of D3 #30–#31. Recommended next milestone:
   **C1-D — monitoring alert-delivery test** (an authorised synthetic
   trigger), then L3 Stage 2 E1–E10. *Done:* `docs/l4-stage-a-acceptance`
   integrated (`main` `8b8c3e5`). *As written for the previous revision:*
   Git integration of `docs/l4-stage-a-acceptance` (documentation
   only, uncommitted). Then **the next milestone — C1-C GANTT production
   acceptance** (item 3; needs its own brief, a programme on a test project
   and, for role checks, a fresh invitation). The **P2 external-role UI
   correction bundle** (D3 #27–#29, with #5 and #6) is a separate Hosting-only
   change when scheduled. Items 1 and 2 below are kept as written and are
   complete.
1. **Git integration of `docs/c1a-final-account-acceptance`** (documentation
   only; authorised by the closure decision, not yet committed).
2. **Next milestone — L4 remaining acceptance and M2-A2 Stage A
   internal-role regression** (Lead Architect, 25 November 2026): L4 T9, T14
   and the Quant step of T16 (TESTING.md §67); Stage A M3–M5, M7, M8 (§68).
   T14 needs an active external session (operator re-provisioning + Product
   Owner sign-in); that same session carries the **F16 restricted-notice
   check** from C1-A and the §61 W4 check. The retained TEST Company Admin,
   Project Manager and QS serve the internal items (tracker C4 → *What the
   retained test identities can serve*).
3. **Other remaining C1 items** (tracker C4): C1-C GANTT baseline scenarios;
   C1-D alert-delivery test; L3 Stage 2 E1–E10; §61 W2–W3.
4. **Deferred UX and reporting correction bundle** (one Hosting-only change
   when scheduled): D3 #9, #19, #21 and, from C1-A, #22–#26; #20 needs a
   reproduction first.
5. **Policy gap, not a defect:** creator ≠ approver segregation on Final
   Account is not implemented (self-approval is permitted and labelled) — for
   a future approval-segregation implementation.

*As written for the C1-B revision (earlier on 24 November):*

**Next, from 24 November 2026 (C1-B revision). Each step needs explicit authorisation.**

1. **Architect review of `docs/c1b-portfolio-acceptance`** (documentation
   only) and the **C1-B closure decision** — recommended GO with P15 local
   only and the measurement limits recorded (tracker B5, C4).
2. **Decide the final state of the PM and QS test identities** (retain
   active for C1-A role checks, or deactivate from the Team page).
3. **Next C1 item: C1-A Final Account role checks** (F5, F6, F15, F16, PM
   approval) — they can reuse the retained PM / QS identities; F14 native
   print / PDF; retest R5.
4. **Deferred UX corrections** (one Hosting-only bundle when scheduled): D3
   #9 subtotal count wording, #19 Reports-tab working-budget label, #21
   offline status line; #20 needs a reproduction first.

*As written earlier on 24 November (before the C1-B revision):*

**Next, from 24 November 2026. Each step needs explicit authorisation.**

*Done, 23–24 November 2026:* M2-A2 Stage B merged (`bd9021c`) and its three
callables deployed; production acceptance PASSED in the isolated test
company; Stage A, Stage B and Deferred Control 20 CLOSED (Lead Architect).

1. **Architect review and Git integration** of
   `docs/m2-a2-stage-b-closeout` (documentation only, no deploy).
2. **Operator tooling safety — IMPLEMENTED, PENDING INTEGRATION (24
   November 2026, `feature/operator-tooling-safety`, uncommitted, awaiting
   architect review)** — `bootstrap-company.mjs` is dry-run by default and
   never prints its link (`--apply` + `--no-link` / `--link-file`; explicit
   `--rotate`); the four older scripts set `process.exitCode` and terminate
   the Firestore client after a refused transaction. Scripts and their tests
   only; no Rules, Functions, Hosting, deployment or production write.
   Architect corrections applied the same day: provisioning uses the shared
   link-file helper (D3 #16), `npm run test:team` readiness and Vite host
   fixed and run end-to-end, cleanup failures reported explicitly.
   TESTING.md §70; DEPLOYMENT.md → *Operator tooling safety*.
3. **Then C1 — Core acceptance closeout** (still PROPOSED), with the
   remaining items indexed in
   [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → *C*:
   C1-A Final Account role checks and native print / PDF; C1-B Portfolio
   P18, parity and M1–M5 (P19–P20 DONE); C1-C GANTT baseline scenarios;
   C1-D alert-delivery test; L3 E1–E10; L4 T9, T14, Quant step of T16;
   Stage A internal M-items; W2–W4; GST hotfix and Premium Dashboard v2
   production evidence.
4. **A readiness decision for real customer external onboarding** — after
   the residual risks in SECURITY.md → *External Project Isolation — M2-A2
   Stage B* are accepted or reduced.
5. **The post-L4 development order is unchanged** (ROADMAP.md →
   *Approved development order (post-L4)*).

*As written from 22 November 2026:* **Next, from 22 November 2026. Each step needs explicit authorisation.**

1. **Architect review and Git integration** of
   `docs/post-l4-roadmap-alignment`. It is documentation only and has no
   deploy.
2. **Proposed next milestone: C1 — Core acceptance closeout (PROPOSED — not
   approved; priority 1 of the post-L4 order).** Finish accepting what is
   already in production before new functionality is built on it. It is
   mostly manual acceptance on test data; any defect found gets its own
   fix brief.
   - **L2-B Final Account positive path** — TESTING.md §62 F3–F17, with
     backend evidence for F9. It is the last commercial stage, it is
     deployed, and no revision has been approved in production.
   - **L2-C Portfolio** — TESTING.md §63 P4, P19–P20 and M1–M5 (access,
     parity, performance).
   - **GANTT baselines** — the scenarios not exercised in the browser.
   - **Production confirmation** — Product Owner confirmation of the GST
     boundary hotfix and Premium Dashboard v2 (section F → *Left for
     verification*).
   - **Alerting** — a notification-delivery test of the L3 alert policies.
   - **Optionally**, the L4 browser gaps T9 and T14, if a restricted-role
     test login is authorised.
   - **Out of C1:** new functionality, Rules, Functions and data
     migrations.
3. **Candidates after C1 — not ordered, not approved.** Each needs its own
   assessment.
   - **Remaining core functionality:**
     - client credit notes (the client-invoice `credit_note` type is
       reserved);
     - client retention;
     - estimating (ROADMAP.md item 4c);
     - creator ≠ approver segregation on Final Account;
     - the 58 older write sites without the L3 write-outcome helper.
   - **Commercial launch dependencies:**
     - self-serve company onboarding (company creation and
       external-member provisioning are operator tasks);
     - company legal identity on client invoices (legal name and tax
       number are not captured);
     - billing and subscriptions;
     - billing-account administration (DC46 follow-up);
     - client-side error reporting;
     - general App Check enforcement;
     - international tax and currency (Australian GST only; no BSD).
   - **Future enhancements:**
     - Photos;
     - direct PO invoicing of new-scope work;
     - negative claims;
     - subcontract final accounts.

*As written before 22 November 2026:* **Next. Each step needs explicit authorisation.**

*Done, 20–21 November 2026:* GANTT core completion merged as `9ce433d`,
released Hosting-only and Product Owner accepted; the L3 read-only
assessment; L3 Stage 1 merged as `4bd358a`, its monitoring created and its
restoration verification run successfully (steps 1–3 below are DONE and
kept as written).

1. **Architect review and Git integration** of
   `chore/l3-recovery-monitoring` (L3 Stage 1), then refresh this file's
   checkpoint line. No deploy belongs to it.
2. **Create the L3 monitoring** — the uptime check, then the two policies
   (DEPLOYMENT.md → *L3 Stage 1* → *Creating the monitoring*; TESTING.md
   §65 O1–O4).
3. **Run the Firestore restoration verification** —
   `ops/recovery/README.md`; TESTING.md §65 V1–V6. It creates and deletes
   a temporary database and never touches `(default)`.
4. **L3 Stage 2** — application error recovery (ADR-80): IMPLEMENTED on
   `fix/l3-application-error-recovery`; architect review, then merge, one
   Hosting deploy and TESTING.md §66 E1–E10.
5. **Product acceptance outside L3** — L2-B positive approval (TESTING.md
   §62 F3–F17, with backend evidence for F9; L2-B is not accepted until
   then); the remaining L2-C checks (TESTING.md §63: P4, P19–P20, M1–M5);
   the GANTT baseline scenarios not exercised in the browser.
6. **Billing administration** — owner, a backup administrator, a budget and
   its notifications (DEPLOYMENT.md → *Billing continuity*). Still open.

Not in L3 by assessment: an availability monitor outside the production
project, a client error-reporting service, a CI deploy stage and general
App Check enforcement.

After each production step: record what happened in DEPLOYMENT.md, then
update this handover.

---

## K. Moving to a new ChatGPT conversation

### Before leaving the old conversation

1. **Update this handover first.** Ask Claude Code (documentation-only brief)
   to refresh section A, the *Last updated* line and anything that changed,
   following [AGENT.md](../AGENT.md) → *Development Continuity*. Have it
   reviewed like any other document.
2. Note anything agreed in conversation that is not yet in the repository.
   If it matters, it goes into a document before the switch.

### Starting the new conversation

3. **Upload `docs/CHATGPT_HANDOVER.md`** to the new conversation. Add
   `AGENT.md` and `ROADMAP.md` if the session will plan new work.
4. **Paste the standard continuation prompt:**

```
You are resuming the Constrap development programme.

The attached CHATGPT_HANDOVER.md is the operational handover. It is a
point-in-time snapshot, not proof of the current production state.

Your roles: Lead Software Architect, Senior Software Engineer, Technical
Product Architect and Development Supervisor. I am the Product Owner: I
own product decisions, authorise changes and releases, run Git and
deployment, and confirm production acceptance. Claude Code is the
implementation engineer and works only from your briefs; it does not
commit or deploy without approval.

Before giving any direction:
1. Read the handover in full and follow its section K.
2. State the current milestone, the Git checkpoint it records, and the
   exact next action.
3. List every action still awaiting authorisation. Treat none as approved.
4. Ask me for the current Git state and for anything done in production
   since the handover's last-updated date.
5. Do not re-propose or restart completed milestones.
6. Do not treat merged code or passing CI as deployed.

Then wait for my confirmation before issuing a brief.
```

### What the new session must do

1. **Restore roles and protocol** — sections C and D. Briefs are detailed,
   copyable plain text with a mandatory report and a stop instruction.
2. **Read the relevant authoritative documents** — at minimum
   [AGENT.md](../AGENT.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md)
   and [ROADMAP.md](../ROADMAP.md); then the named sections of
   [DEPLOYMENT.md](DEPLOYMENT.md), [SECURITY.md](SECURITY.md),
   [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) and [TESTING.md](TESTING.md)
   for the area in hand. These files are large — ask for the section, not
   the file.
3. **Identify the current verified checkpoint.** Ask the Product Owner for
   `git branch --show-current`, `git rev-parse HEAD`, `git status` and
   `git log --oneline -5`, and compare with section A. If they differ, this
   file is stale: establish what changed before proceeding.
4. **Review the current milestone and status** — sections A and G — and ask
   whether anything was done in production since the *Last updated* date.
5. **Confirm the next action** with the Product Owner — section J.
6. **Preserve outstanding approval gates.** Everything listed as awaiting
   authorisation in section A is still unapproved. A new conversation
   inherits no approval.
7. **Preserve architectural decisions.** Section E and the ADRs stand.
   Changing one needs a new ADR, not a new conversation.
8. **Do not assume deployment from implementation or CI alone.** A feature is
   live only when a release record says so, and accepted only when
   acceptance evidence is recorded.
9. **Do not repeat completed work.** Section F lists what is done. Do not
   re-propose, re-design or re-implement it.

---

## Maintenance rules

The binding protocol is [AGENT.md](../AGENT.md) → *Development Continuity —
ChatGPT Handover*. In short, update this file:

- at major milestone closeout;
- after a significant architecture decision;
- after every production deployment;
- when roadmap priorities change;
- before moving to a new ChatGPT conversation.

When updating: change *Last updated* and the Git checkpoint; keep every claim
under one of VERIFIED / REPORTED / PROPOSED / BLOCKED / NOT STARTED; do not
promote REPORTED to VERIFIED without saying what was checked; move an item to
"live" only when its release record exists, never because tests or CI passed;
never let planned work read as complete. Keep it short — link to the source
instead of copying it.

Never include credentials, access tokens, personal account details, email
addresses, private customer records or sensitive operational secrets.
