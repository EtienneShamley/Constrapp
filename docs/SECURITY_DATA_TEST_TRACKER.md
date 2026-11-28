# Security, Data Integrity & Production Acceptance — Test Tracker

One running record of what has been tested, where, with what result, and what
is still open. It **summarises and links**; it does not repeat procedures.
Procedures and full records live in [TESTING.md](TESTING.md); controls and
accepted risks in [SECURITY.md](SECURITY.md); decisions in
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md); releases in
[DEPLOYMENT.md](DEPLOYMENT.md); order of work in [../ROADMAP.md](../ROADMAP.md);
the operational checkpoint in [CHATGPT_HANDOVER.md](CHATGPT_HANDOVER.md).

**Last updated:** 27 November 2026 (NZDT) — **Commercial Finance Phase 1 (CF1–CF6) LIVE and CLOSED within its accepted scope** (Lead Architect — REPORTED; B18; TESTING.md §82). Cutover steps 0 and A–I executed by the Product Owner 26 Nov 22:30 – 27 Nov 03:19 UTC; `main` `c9df38b`; general availability for Apex Builders (operator script, no deploy).
- **Production evidence (PROD-VERIFIED / PROD-BROWSER, TEST company):** non-zero historical baseline reconciled exactly (F2); consolidated acceptance H — every figure equal to an independent integer-cent calculation, seven ledgers reconciled to their entries, 15 direct-write probes refused, replays and concurrent posts without a second effect, 29 audit events exactly as expected, Final Account blocked by an amount owed and approved after valid lifecycle; GST §44 steps 1, 2 and the financial parts of 3 PASSED in production.
- **Void policy approved:** invariant-based, not strict reverse order (ADR-89 → *Void policy*).
- **Apex:** activated 03:19:15 UTC; one audit event; no Apex financial test transaction; its receipt baseline awaits its first genuine receipt operation.
- **Carried forward:** D3 #35 (payable side), #36, #37, #39; alert coverage for the six new callables; Hosting entry-point cache; Dashboard §22 checks 2–3; printed credit-note paper layout; Final Account CSV; external-role §44 3a checks; production role matrix and not-activated refusal (emulator evidence only); refund and credit-settlement workflow; production load testing; international tax compliance; CI/CD performance and cost.

*As written at the final integration gate:* 27 November 2026 (NZDT) — **Commercial Finance Phase 1 — final integration safeguards: IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (B13–B17; TESTING.md §77–§81). Backend architecture and the six callables APPROVED by the Lead Architect (REPORTED). On `feature/commercial-finance-phase-1` (uncommitted). Nothing deployed; production not written; one read-only aggregate inventory.
- **Historical receipts:** production holds 9 posted receipts on 5 issued invoices. An exact one-time baseline per project brings them into the invoice ledgers; a missing baseline refuses every finance operation and is never read as zero.
- **Cutover:** no moment with both posting paths; both switches off at deploy; receipts unavailable between the Rules and their enabling (announced).
- **Activation:** per company, server-written flag, enforced in Rules and backend; TEST company first.
- **EMULATOR / LOCAL evidence:** unit 116 / 6,085; rules 40 / 2,632; Functions pure 9 / 256; Functions emulator 14 / 623; lint, build, generated-file checks clean. Rules 236,120 bytes (binding file 236,800 — **8,200 under budget**).
- **Open:** D3 #35 (payable-side rounding), D3 #37 (Phase 2 plan), D3 #39 (wording), GST §44 in production, compiled Rules size, every production acceptance step, the refund / credit-settlement workflow, the load test (Phase 3).

*As written at the first integration gate:* 26 November 2026 (NZDT) — **Commercial Finance Phase 1 (CF1–CF6): IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (B13, B14; TESTING.md §77, §78). On `feature/commercial-finance-phase-1` (uncommitted; at the final integration gate, awaiting the Lead Architect). Nothing deployed; production not read or written.
- **Decisions (Lead Architect, 26 Nov 2026 — REPORTED):** ADR-85 to ADR-88 approved and numbered; per-invoice ledger; exact receivable-side GST; proportional retention GST; proportional credit against retained invoices; invoice void refused while posted entries exist; version-aware Final Account comparison.
- **EMULATOR / LOCAL evidence:** unit 111 / 5,789; rules 40 / 2,548; Functions pure 8 / 179; Functions emulator 11 / 372; lint, build, generated-file checks clean. Rules 243,104 bytes (binding file 243,784 — 1,216 under budget).
- **D3 #35:** receivable side RESOLVED in the implementation (exact integer cents; corrective documents derive from stored figures); **payable side stays OPEN** — unchanged, a version-aware correction is recorded as a future decision.
- **D3 #37:** INVESTIGATED — no legitimate request fails; three pre-existing blocks run within about 6–10% of the 1,000-expression ceiling on allowed requests; the new blocks are not among them. Stays open for a follow-up `let`-binding pass.
- **Not done:** GST §44 manual steps 1–3 in a browser (emulator equivalents pass); browser coverage is targeted (TESTING.md §78.5); compiled Rules size unmeasured — a release prerequisite.

*As written at the assessment checkpoint:* 26 November 2026 (NZDT) — **Commercial Finance Phase 1: repository assessment complete; Rules capacity recovery 3 (ADR-85) IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION; D3 #35 rounding assessment delivered (ADR-86 PROPOSED); client credit-note and client retention architecture PROPOSED (ADR-87, ADR-88) — awaiting the Lead Architect's rulings; D3 #37 recorded** (B13; TESTING.md §77). On `feature/commercial-finance-phase-1` (uncommitted). Nothing deployed; production not read or written.
- **CF3 (EMULATOR):** `firestore.rules` 236,737 → 228,289 bytes; binding headroom (the transitional file) 7,582 → 16,031. 55 helper call sites proven to expand to the `8702728` text; rules suite 39 / 2,492 unchanged; unit 104 / 5,357.
- **CF2:** no calculation changed. The deviation is seven `roundMoney(x × 0.1)` call sites; the receivable chain can be made exact with no compatibility risk; the payable side needs a versioned correction and is proposed for a separate decision. D3 #35 stays open until ruled.
- **CF1 / CF4 / CF5:** not implemented. Nine rulings requested (PROJECT_DECISIONS.md ADR-86 to ADR-88, *(architect)* items).
- **New finding D3 #37:** the rules suite logs 4,560 "maximum of 1000 expressions" messages on refused requests, on `main` and unchanged by the recovery.

*As written before this phase:* 26 November 2026 (NZDT) — **D3 #32 production verification and L3 closeout: D3 #32 CLOSED; D3 #34 CLOSED; L3 Stage 2 CLOSED within its accepted scope** (B12; TESTING.md §76). On `docs/l3-membership-closeout` (uncommitted, documentation only; awaiting the Lead Architect's review).
- **Release PROD-VERIFIED:** `main` `0bdca38` (commit `893bed3`); Hosting release `edc2bf6f34568d78`, 25 Nov 2026 20:32:18 UTC (deployed by the Product Owner — REPORTED); the live bundle on all three origins is SHA-256-identical to a build of that commit. Firestore and Storage Rules byte-identical to the repository and unchanged since 23 Nov; no Function or monitoring change.
- **Membership:** 9 profiles — 3 admitted, 6 deactivated, none malformed, **none newly restricted**; every enabled Auth account has a profile.
- **Production acceptance (TEST Company Admin, `constrapp-69b5d.web.app` only):** normal start-up, project access, reload — PASS, no notice, no console error. **E2-A PASS and E2-B PASS under a transport failure injected in the page** (the released bundle on production data; injected at the browser's request API, in a same-origin frame — not a real outage). **E2-C not run in production** — offline start-up is not supported; a future offline-first PWA requirement.
- **Integrity:** no production write; only the reconciliation worker's own document changed between the snapshots; test identities still disabled; 111 financial register documents unchanged.
- **D3 #36 — observed in production:** every cold load of a project URL shows *Project not found.* for 55–100 ms before the company read answers. Not introduced by this release. P2, unchanged.
- **Open, preserved:** E2-C; D3 #33 (P3); D3 #35 (GST rounding assessment); D3 #36 (P2); GST §44 steps 1–3; Dashboard §22 checks 2–3; D3 #11.
- **Next milestone:** client credit-note architecture assessment and ADR.

*As written before the release:* 25 November 2026 (NZDT) — **D3 #32 membership resolution correction: IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (B11; TESTING.md §75). On `fix/membership-resolution-state` (uncommitted; awaiting architect review). Hosting-only; **not deployed**.
- **Root cause:** with the backend unreachable the SDK answers the `users/{uid}` listener from its empty cache with a document that "does not exist"; the provider took that as settled and the gate said *No active membership*.
- **Correction:** only a server-confirmed snapshot decides membership. A cache-only answer is *Waiting for the server* — not a denial, not an admission. An established session is unchanged by a dropped connection. Authorisation is not weakened: Firestore and Storage Rules are untouched and still decide every read and write.
- **Architect corrections (Lead Architect, 25 Nov 2026 — REPORTED; implemented 26 Nov; TESTING.md §75.10):** implementation accepted in principle; the 22–25 ms waiting notice **accepted** (no delay, timer or debounce); local E2-A / E2-B accepted; E2-C stays a future offline-first requirement. **The gate now also requires a documented role and a string `companyId`** — a server-confirmed profile that names a company but has a missing, null, empty, non-string or unknown role is *invalid*: a notice, no shell, no automatic sign-out, and it admits by itself once corrected. `super_admin` is admitted as a documented role — **for the architect to confirm**. Remaining cache handling split out as **D3 #36**.
- **Release preflight (Lead Architect, 26 Nov 2026 — REPORTED: GO for integration, subject to the preflight; TESTING.md §75.11):** `super_admin` retained, no added permission; legacy profiles preserved; `CompanyProvider` guard approved; **D3 #36 classified P2 — reliability hardening before customer onboarding; not blocking this release or commercial implementation.** **Production membership inventory (PROD-VERIFIED, read-only, 25 Nov 20:05 UTC): 9 profiles — 3 valid active (all `company_admin`; 2 legacy without a status), 6 deactivated, 0 malformed; 0 newly restricted by the corrected gate.** Defensive check: a `companyId` string containing `/` could still throw or resolve to another path — corrected by applying the existing id contract (`ID_RE`). Unit now **5,336**.
- **Evidence:** unit 103 files / **5,333** tests at the corrections report (89 new; the regression test fails on `main`'s source); *at the first report 5,315 (71 new);* local browser acceptance on emulators PASS, including E2-A and E2-B (TESTING.md §75.6). **Nothing was run against production.**
- **D3 #34:** the E2 procedure is rewritten as E2-A / E2-B / E2-C (TESTING.md §75.7, §66). E2-C — a full offline hard reload — is a recorded limitation: offline start-up is not supported.
- **L3 stays NOT closed; E2 stays OPEN** until the correction is deployed and E2-A / E2-B are run in production.
- **Unchanged:** D3 #33 (P3, deferred), D3 #35 (financial precision — assessment before client credit notes and client retention; no calculation changed), the decided order of work, fixtures, deactivated test identities, the external-onboarding restriction.

*As written for the architect decision on the L3 run:* 25 November 2026 (NZDT) — **L3 regression acceptance: architect decision recorded** (Lead Architect, 25 Nov 2026 — REPORTED; B10; TESTING.md §74.10). **GO for documentation integration; NO-GO for full L3 closure.** On `docs/l3-regression-acceptance` (uncommitted, documentation only).
- **L3 Stage 2:** E1 and E3–E10 **ACCEPTED** with their actual evidence classes and limitations (E1 production; E3–E10 local emulators only). **E2 remains OPEN** against D3 #32. L3 is **not closed**.
- **GST boundary hotfix:** deployment verified; calculation compatibility accepted. §44 manual steps 1–3 remain **outstanding** (not passed), retained for the relevant financial implementation milestone.
- **Premium Dashboard v2:** deployment verified; tested financial calculations accepted. §22 checks 2 and 3 remain **open** (not passed).
- **Defect triage:** D3 #32 **P2 — next implementation task** (no weakening of authorisation; no service worker or PWA in the correction); D3 #33 **P3 — deferred**; D3 #34 corrected alongside #32.
- **Financial precision:** the half-cent GST rounding discrepancy is kept as an explicit concern — **D3 #35**. Rules compatibility is not independent mathematical correctness. An assessment of rounding semantics is tracked **before** client credit notes and client retention. No calculation or historical record changes now.
- **Order decided:** 1 D3 #32 membership reliability fix → 2 L3 E2 corrected acceptance → 3 client credit-note architecture assessment and ADR → 4 Firestore Rules capacity assessment and any necessary capacity recovery → 5 client credit-note implementation → 6 client retention. Estimating, approval segregation and the remaining approved commercial roadmap are preserved.
- Fixtures, deactivated test identities and the external-onboarding restriction are unchanged.

*As written at the run (before the decision):* 25 November 2026 (NZDT) — **L3 Stage 2 E1–E10, GST boundary hotfix and Premium Dashboard v2: consolidated regression acceptance RUN — awaiting architect review** (B10; TESTING.md §74). Prepared on `docs/l3-regression-acceptance` (uncommitted, documentation only).
- **Release state PROD-VERIFIED:** the live bundle on all three origins is SHA-256-identical to a build of `main` `875910e`; both live rulesets are byte-identical to the repository. The GST hotfix (Rules and Hosting), Dashboard v2 and L3 Stage 2 are therefore **deployed**.
- **L3:** E1 PASS in production. E3–E10 PASS on **local emulators only** (failure injection in a throwaway browser). **E2 NOT PASSED as written** — new defect D3 #32.
- **GST hotfix:** calculations equal an independent exact-decimal check; §44 manual steps 1–3 NOT RUN in production (they need new financial records).
- **Dashboard v2:** figures on six projects in five currencies equal independent expectations; no stale value while switching; §22 checks 2 and 3 NOT RUN.
- **Integrity:** the test company (167 documents) and Apex Builders (258) are unchanged by update time; test identities still disabled; monitoring unchanged.
- **Findings:** D3 #32 (P2 proposed), #33 (P3), #34 (test procedure). *(Priorities since decided — above.)*
- **Integration:** the C1-D closeout is integrated (`main` `875910e`, VERIFIED in Git); Azure `main` GREEN — REPORTED by the Product Owner.

*As written for the C1-D closure revision:* 25 November 2026 (NZDT) — **C1-D monitoring and alert delivery CLOSED** (Lead Architect decision, 25 Nov 2026 — REPORTED; B9; TESTING.md §73). D1–D7 accepted; integration authorised. **Evidence limitations (stand after closure):** the billing-administrator channel was not tested in this run; exact email arrival times are unknown; not every permanent policy has fired on its intended condition (only policy B, once); the permanent policies' recovery-notification behaviour is unverified; receipt of policy B's 17 November email is unverified; observed timings are not service levels. Next milestone: **L3 Stage 2 E1–E10**.

*As written for the run revision:* **C1-D monitoring and alert delivery RUN — awaiting architect review** (B9; TESTING.md §73):
- Inventory and repository parity VERIFIED. The L3 availability policy file was aligned with production; the check-id filter and `resource.label.*` grouping were verified to have the intended meaning.
- One approved temporary heartbeat policy, on the Product Owner channel only, opened an incident (22:29:20 UTC), **recovered naturally** (22:33:35), and was deleted (22:34:58).
- Opening and recovery emails received (REPORTED by the Product Owner; exact arrival times not visible).
- Policy B's real incident of 17–18 Nov recorded, and the earlier "never matched" statements corrected.
- C1-C closeout integrated (`main` `caf6ecf`, VERIFIED in Git); Azure `main` GREEN (REPORTED by the Product Owner).

*As written for the C1-C closure revision:* **C1-C GANTT functional acceptance CLOSED** (Lead Architect decision, 25 Nov 2026 — REPORTED; B8; TESTING.md §72): scheduling, dependencies, baseline management, revision protection, variance calculations and downstream consistency accepted; existing role evidence accepted. **Carried forward, not passed:** native print / PDF R1–R13; Safari and Firefox; Day / Month chart visuals; the dashed baseline outlines; the individual attention-filter checks; overnight G11; offline capture; the stale quick-action and stale cancellation scenarios. D3 #30, #31 → P3 deferred UX corrections; Deferred Control 23 retained as a data-integrity hardening requirement before customer readiness (D1 R-7). Final fixture state VERIFIED to hold only valid calendar dates (86 values, read-only). Browser-isolation deviation recorded; required origins restated (section A). Git integration of `docs/c1c-gantt-acceptance` authorised. **Next milestone: C1-D monitoring and alert delivery.**
*As written for the run revision:* **C1-C GANTT production acceptance RUN — awaiting architect review** (B8; TESTING.md §72). In the isolated company, on a new retained CAD fixture (`V2Vj8jds7RUkBAmZ1jzm`): scheduling, finish-to-start dependencies, conflict acknowledgement, cycle prevention, the activity revision guard, baseline capture / approval / drift / re-baselining / withdrawal, variance against the active and a historical baseline, PULSE parity, the programme CSV and the Dashboard panel **PASSED**, each equal to an independent calculation; 22 server-side refusals PROD-VERIFIED. Not run: print / PDF, a QS or external session on the programme (emulator + §71 M8), other browsers. New P3 findings D3 #30, #31. One unintended fixture write (documented DC23 behaviour) corrected. Apex unchanged; test identities still deactivated. The L4 / Stage A closeout is integrated (`main` `8b8c3e5` — VERIFIED in Git); Azure `main` GREEN — REPORTED by the Product Owner. Prepared on `docs/c1c-gantt-acceptance` (uncommitted, documentation only).
*As written for the previous revision (L4 / Stage A closure):* 25 November 2026 (NZDT) — **L4 acceptance CLOSED with recorded evidence limitations; M2-A2 Stage A regression CLOSED within its applicable scope** (Lead Architect decision, 25 Nov 2026 — REPORTED; B7). Next milestone: **C1-C GANTT production acceptance.** D3 #27–#29 triaged to a P2 external-role UI correction bundle; D3 #28 inspected — an external purchase order create is refused by the Rules (no authorisation defect). The consolidated production run (24 Nov 2026 19:00–19:42 UTC — section B7: T9, the Quant step of T16, T14 as `subcontractor`, M3, M4, M8, W2–W4 PASS and the F16 notice OBSERVED in production; M5 and M7 in part; M1, M2 superseded; T14 as `client` not re-run) is the evidence. The TEST Project Manager, QS and the re-activated external identity are **deactivated** again; reconcile 0 findings; Apex unchanged. C1-A integration (`main` `0cf17e6` — VERIFIED in Git) and Azure `main` GREEN are REPORTED by the Product Owner. Prepared on `docs/l4-stage-a-acceptance` (uncommitted, documentation only).
*As written for the previous revision (C1-A closure):* 25 November 2026 — **C1-A CLOSED** (Lead Architect decision, 25 Nov 2026 — REPORTED; F16 accepted on combined evidence, its restricted notice not observed in production; next milestone L4 remaining acceptance and Stage A internal-role regression). Run of 24 November 2026 (C1-A Final Account remaining acceptance, 10:21–10:53 UTC — section B6: F5, F6, F15, Project Manager approval, F14 native PDF and R5 PASS in production on a dedicated USD fixture in the isolated test company; F16 PARTLY — the restricted notice was not observed in production. **C1-B CLOSED** — closeout merged as `c236bd9`, merge `2561344`; Azure `main` CI GREEN — both REPORTED by the Lead Architect). Prepared on `docs/c1a-final-account-acceptance` (uncommitted, documentation only).
`main` `2561344`, equal to `origin/main` (fetched 24 Nov 2026 — VERIFIED).
*As written for the previous revision (C1-B):* 24 November 2026 (C1-B final targeted acceptance, 07:15–07:37 UTC — section B5: P7, P9, P18 PASS in production on retained NZD commercial fixtures in the isolated test company; P15 PASS locally only. Earlier the same day: C1-B read-only run, 05:14–05:27 UTC — section B4; operator tooling safety INTEGRATED — merged as `bc64487`, merge `62e824a`). Prepared on `docs/c1b-portfolio-acceptance` (uncommitted, documentation only). Earlier the same day: M2-A2 final closeout — Stage A, Stage B and DC20 CLOSED by the Lead Architect.
`main` `62e824a`, equal to `origin/main` (fetched 24 Nov 2026 — VERIFIED).
*As written for the previous revision:* operator tooling safety, D3 #1–#3 and #16 — IMPLEMENTED — PENDING INTEGRATION on `feature/operator-tooling-safety`; `main` `2e48a2a`.

## Evidence classes

Every result below carries one of these. Never promote a class without new
evidence.

| Class | Meaning |
|---|---|
| **PROD-VERIFIED** | Read from production by the engineer (read-only REST / API / browser), with the read recorded |
| **PROD-REPORTED** | Reported by the Product Owner or Lead Architect; not re-read from production |
| **EMULATOR** | Local emulators or unit tests only — says nothing about production |
| **NOT RUN** | Implemented (and possibly deployed) but never exercised — *not* the same as not implemented |
| **NOT BUILT** | No implementation exists |

All times are UTC unless marked otherwise.

---

## A. Current project status

| Item | State |
|---|---|
| Current milestone | **None in progress. Commercial Finance Phase 1 (CF1–CF6) LIVE and CLOSED within its accepted scope** (27 Nov 2026; B18; TESTING.md §82). **Next: Phase 2 — Commercial Completion (ROADMAP), not started.** *As written at the final integration gate:* **Commercial Finance Phase 1 with the ADR-89 backend correction — IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION (26 Nov 2026; TESTING.md §79; B15).** At the final integration gate. *As written at the first gate (NO-GO):* **Commercial Finance Phase 1 (CF1–CF6) — IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION (26 Nov 2026; `feature/commercial-finance-phase-1`, uncommitted; TESTING.md §77–§78; B13, B14).** At the final integration gate. *As written at the assessment checkpoint:* **Commercial Finance Phase 1 (CF1–CF6) — IN PROGRESS on `feature/commercial-finance-phase-1` (26 Nov 2026; uncommitted; TESTING.md §77).** CF3 Rules capacity recovery 3 (ADR-85): **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (228,289 bytes; binding headroom 16,031; not published). CF2 rounding assessment (D3 #35): **delivered; ADR-86 PROPOSED**, no calculation changed. CF1 architecture: **ADR-87 (client credit notes) and ADR-88 (client retention) PROPOSED** — nine *(architect)* rulings requested. CF4, CF5, CF6: **NOT STARTED**, blocked on those rulings. *As written before this phase:* **Client credit-note architecture assessment and ADR — NEXT, not started (own brief).** L3 Stage 2 **CLOSED within its accepted scope**; D3 #32 and D3 #34 **CLOSED** (26 Nov 2026; B12; TESTING.md §76). *As written before the release:* **D3 #32 membership reliability fix — IMPLEMENTED on `fix/membership-resolution-state` (25 Nov 2026; uncommitted; B11; TESTING.md §75) — PENDING INTEGRATION AND PRODUCTION VERIFICATION; awaiting architect review.** Hosting-only, not deployed. L3 E2 stays OPEN until E2-A and E2-B are run in production. *As written before the fix:* **D3 #32 membership reliability fix — NEXT, not started** (Lead Architect, 25 Nov 2026 — REPORTED; needs its own brief). **L3 Stage 2 is NOT closed:** E1 and E3–E10 accepted with their evidence classes and limitations; **E2 OPEN** against D3 #32 (B10). GST hotfix: deployment verified, calculation compatibility accepted, §44 steps 1–3 outstanding. Dashboard v2: deployment verified, tested calculations accepted, §22 checks 2–3 open. *As written at the run:* **L3 Stage 2 E1–E10, GST hotfix and Dashboard v2 — consolidated regression acceptance: RUN 25 Nov 2026, awaiting architect review** (B10; TESTING.md §74). Recommended: close L3 E1 and E3–E10 with their evidence classes and keep E2 open against D3 #32; accept the GST hotfix on deployment, emulator and independent-arithmetic evidence; GO for Dashboard v2 §22 check 1. *As written for the C1-D closure revision:* **None in progress. C1-D — monitoring and alert delivery CLOSED** (Lead Architect, 25 Nov 2026 — REPORTED; B9; TESTING.md §73); evidence limitations and retained monitoring requirements in B9. **Next: L3 Stage 2 E1–E10.** *As written for the run revision:* **C1-D — monitoring and alert delivery: RUN, awaiting architect review** (B9; TESTING.md §73). D1–D7 PASS. Delivery was shown through the Product Owner channel (opened and resolved, receipt REPORTED). Natural recovery was observed. No production policy has fired on a real failure. Recommended: GO for closure. *As written for the C1-C closure revision:* **None in progress. C1-C — GANTT functional acceptance CLOSED** (Lead Architect, 25 Nov 2026 — REPORTED; B8; TESTING.md §72); presentation, browser and resilience checks tracked, not passed: native print / PDF R1–R13; Safari and Firefox; Day / Month chart visuals; the dashed baseline outlines; the individual attention-filter checks; overnight G11; offline capture; the stale quick-action and stale cancellation scenarios. *As written for the run revision:* **C1-C — GANTT production acceptance: RUN, awaiting architect review** (B8; TESTING.md §72). Recommended: GO for closure with the recorded limits (print / PDF, QS / external programme sessions, other browsers, chart visuals at Day / Month zoom). *As written for the previous revision:* **None in progress. L4 acceptance CLOSED with recorded evidence limitations; M2-A2 Stage A regression CLOSED within its applicable scope** (Lead Architect, 25 Nov 2026 — REPORTED; B7). Evidence: T9, the Quant step of T16, T14 (as `subcontractor`), M3, M4, M8, W2–W4 PASS; the F16 notice OBSERVED in production; M5 page load PASS, pin not run; M1, M2 and the stale-bundle part of M7 superseded; T14 as `client` not re-run; a real disconnection not tested. *As written for the previous revision:* **None in progress. C1-A — L2-B Final Account: CLOSED** (Lead Architect decision, 25 Nov 2026 — REPORTED; B6) — F5, F6, F15, Project Manager approval, F14 native PDF and R5 PASS in production (24 Nov); F16 **accepted on combined evidence** (no figure reaches a signed-out, deactivated or non-financial account in production; the restricted notice itself was **not** observed in production — unit test only; its browser check is carried forward to the external-role session of L4 T14 / §61 W4). **C1-B — L2-C Portfolio: CLOSED** (Lead Architect, 24 Nov 2026 — REPORTED; closeout merged `c236bd9` / `2561344`; Azure `main` GREEN — REPORTED). *As written for the previous revision:* **C1-B — L2-C Portfolio acceptance — final targeted run COMPLETE (24 Nov 2026), awaiting architect closure decision** — P7, P9, P18 PASS in production (B5); P15 PASS on local emulators only; financial parity ACCEPTED by the architect (B4). *As written after the read-only run:* read-only production run COMPLETE; NOT closed (P18 blocked on internal-role sessions — section B4). **Operator tooling safety (D3 #1–#3, #16, #18, R-6) — INTEGRATED** (merged as `bc64487`, merge `62e824a`; no deployment required). Last closed: **M2-A2 External Project Isolation** — Stage A (ADR-83) and Stage B (ADR-84) **LIVE and CLOSED**; **Deferred Control 20 CLOSED** (Lead Architect, 24 Nov 2026) |
| Release status | Stage B merged as `cddfca8`, `main` `bd9021c`. Three callables live since 23 Nov 2026 ~09:11 UTC — `acceptinvitation-00005-mol`, `deactivatemember-00005-suy`, `resendinvitation-00005-mer`; source identical to `main`; other eight services unchanged; Firestore `67b6425a…`, Storage `2f3a4788…`, Hosting `index-BOg2hoYg.js` unchanged (PROD-VERIFIED 23–24 Nov) |
| Acceptance | **Complete (24 Nov 2026 00:50 UTC):** S1–S3, R1–R3, P1–P14 PASS; §68 X1–X7 PASS (X1–X3, X6 for both external roles); §63 P19–P20 PASS for both roles with the network-payload limitation; reconcile 0 findings; directory 13 / 13; Apex unchanged. Recorded in TESTING.md §63, §68, §69 (closeout branch `docs/m2-a2-stage-b-closeout`) |
| Documentation | Closeout merged to `main` (`a219deb`, merge `2e48a2a`; VERIFIED in Git 24 Nov). *As written:* closeout on `docs/m2-a2-stage-b-closeout` (uncommitted): ROADMAP, PROJECT_DECISIONS (ADR-83 / ADR-84 closure records), SECURITY (DC20, Stage A / B), TESTING, DEPLOYMENT (release record), DATA_MODEL, ARCHITECTURE, CHATGPT_HANDOVER, this file |
| Next step | **Architect review and integration of `docs/commercial-finance-phase-1-closeout` (documentation only; uncommitted until asked). Then Phase 2 — Commercial Completion, each workstream on its own brief (ROADMAP).** *As written before the cutover:* **Lead Architect review of the backend-correction report; then, each on explicit authorisation: two-commit integration, Azure green, Rules → five callables → Hosting, production acceptance (DEPLOYMENT.md).** *As written at the first gate:* **Lead Architect review of the consolidated Phase 1 report, then — each on explicit authorisation — two-commit integration (ADR-85 hoist; then the finance work), Azure green, Rules → `approveFinalAccount` → Hosting, production acceptance (DEPLOYMENT.md → *Commercial Finance Phase 1 release order*).** *As written at the assessment checkpoint:* **Lead Architect rulings on the *(architect)* items of ADR-86, ADR-87 and ADR-88 (PROJECT_DECISIONS.md), and triage of D3 #37.** Then, on those rulings: CF2 implementation, CF4 client credit notes, CF5 client retention, CF6 local integrated acceptance; integration and every production step separately authorised. ADR-85 is Rules-only and may be integrated and published on its own. *As written before this phase:* **Architect review of the closeout record (B12), then Git integration of `docs/l3-membership-closeout` (documentation only; uncommitted until asked).** Then the client credit-note architecture assessment and ADR, with the D3 #35 rounding-semantics assessment. *The integration and deploy named below are DONE — `main` `0bdca38`, Hosting release `edc2bf6f34568d78`, VERIFIED 26 Nov 2026.* *As written before:* **Integration — GO given by the Lead Architect (26 Nov 2026 — REPORTED), preflight complete (TESTING.md §75.11); commit, merge and deploy each still need the explicit instruction.** Hosting deploy from `frontend/`: `firebase deploy --only hosting --project constrapp-69b5d`. *As written before:* **Architect review of the D3 #32 correction (B11).** Then, each on explicit authorisation: Git integration → Hosting deploy → production verification (TESTING.md §75.9) → L3 E2 decision. The rest of the decided order is unchanged. *The integration named below is DONE — `main` `1bc46bc`, VERIFIED in Git, 25 Nov 2026.* *As written before:* **Git integration of `docs/l3-regression-acceptance`** (authorised by the decision; documentation only; uncommitted until asked). Then, each on its own brief: 1 D3 #32 membership reliability fix → 2 L3 E2 corrected acceptance → 3 client credit-note architecture assessment and ADR → 4 Firestore Rules capacity assessment and any necessary capacity recovery → 5 client credit-note implementation → 6 client retention (D4a). No test account is to be reactivated; no service worker or PWA in the #32 correction. *As written at the run:* **Architect decision on B10** (L3 closure, GST and Dashboard acceptance, D3 #32–#34 priorities, the proposed next milestone in D4). `docs/l3-regression-acceptance` is uncommitted. No test account is to be reactivated. *Done:* `docs/c1d-monitoring-acceptance` integrated (`main` `875910e`, VERIFIED in Git; Azure GREEN — REPORTED by the Product Owner). *As written for the C1-D closure revision:* Git integration of `docs/c1d-monitoring-acceptance` (authorised by the C1-D decision; documentation plus the aligned monitoring file and its test). **Next milestone: L3 Stage 2 E1–E10 remaining acceptance.** No test account is to be reactivated. *As written for the run revision:* **Architect decision on C1-D closure** (B9), then Git integration of `docs/c1d-monitoring-acceptance` (documentation plus the aligned monitoring file and its test; uncommitted). Next proposed milestone: **L3 Stage 2 E1–E10** browser acceptance. No test account is to be reactivated. *Done:* `docs/c1c-gantt-acceptance` integrated (`main` `caf6ecf`, VERIFIED in Git; Azure GREEN — REPORTED by the Product Owner). *As written for the C1-C closure revision:* Git integration of `docs/c1c-gantt-acceptance` (authorised by the C1-C decision; documentation only). **Next milestone: C1-D — monitoring and alert delivery** (needs its own brief and an authorised synthetic trigger). No test account is to be reactivated. *As written for the run revision:* **Architect decision on C1-C closure** (B8). Then the next C1 item — recommended **C1-D monitoring alert-delivery test** (needs an authorised synthetic trigger; independent of C1-C). The Project Manager, QS and external test accounts stay **deactivated**; the CAD fixture and every earlier fixture are retained. *As written for the previous revision:* **C1-C GANTT production acceptance** (Lead Architect, 25 Nov 2026; C4) — needs its own brief. Git integration of `docs/l4-stage-a-acceptance` is not yet done (uncommitted). The Project Manager, QS and external test accounts stay **deactivated**; the TEST Company Admin and every fixture are retained. C1-C needs a programme on a test project and, if role checks are wanted, a fresh internal-role invitation (the TEST Project Manager and QS are deactivated). *As written for the previous revision:* **L4 remaining acceptance and M2-A2 Stage A internal-role regression** (Lead Architect, 25 Nov 2026; C4) — needs its own brief. Git integration of `docs/c1a-final-account-acceptance` is authorised by the closure decision and not yet done (uncommitted). The TEST Project Manager and QS stay **active** (architect, 25 Nov). *As written before the decision:* Architect decision on C1-A closure (B6, C4 — recommended GO with the F16 notice recorded as not observed in production, or one external-session check first). *As written for the previous revision:* Architect decision on **C1-B closure** (B5 — recommended GO with P15 local-only and the measurement limits recorded) and on the final state of the two internal test identities (PM and QS, both active). Then the next C1 item — C1-A Final Account role checks can reuse the same PM / QS identities. *As written after the read-only run:* a decision on P18 — not to be run in Apex Builders (architect, 24 Nov) |
| Real customer external onboarding | **BLOCKED** pending a readiness decision. The residual risks in D1 are tracked, **not** accepted for a customer release by the M2-A2 closure |

### Isolated test environment (production project `constrapp-69b5d`)

Never use Apex Builders (`2Vf3CVuYE8wWzg8hLjR5`) for Stage B tests. Do not
delete any record below without approval.

| Record | ID |
|---|---|
| Company | `constrap-acceptance-test` — *Constrap Acceptance — TEST (not a customer)*, AU / AUD |
| TEST Company Admin | `oOANhAEf30XdPphGmci60Xpls7M2` — active |
| Internal QS (R2–R3) | `PvzTgu8t0XW8AUGQ9CkUelR3ziy1` — **deactivated** |
| Project A | `Fsoo2u42FUqhKdt0fM8B` — headline budget 123,456.00, currency locked |
| Project B | `RfTtgCjS6U0LC2A6vXWP` |
| Project C | `0LRmY1DmytJeebthfouK` |
| Fixtures, project A | drawing TA-001 `7IGmo0BIEm7BQdNs7qPP` (rev `pVrVrJfYV0kKN4w3ooGZ`); project-visible document `Pemwyp3TbEKvGNnWH4sr`; INTERNAL document `QKYa9UiC8DIFJGrYAzLQ` |
| Fixtures, project B | drawing TB-001 `P1JVxz4mmVizpeBm8UbU` (rev `jIL3EgtP4UrjnuBM3xX7`); project-visible document `n1pqZVxZqWZabMCFkkTx` |
| Subcontractor invitation (P3, resent P4) | `Hpaa6JjEUJJNpuHBczVn` — **accepted** 23 Nov 23:46:15 UTC |
| Former subcontractor → client (P5 → P12 → P13; deactivated at the end) | `R5SbTZ8KBnZ0V9DHOPiZizaGq0h1` — **deactivated** 24 Nov 00:49:03, Auth disabled, no `projectIds` |
| Client invitation (P7) | `9d0NBe1iNKvmTiVxVmhU` — **accepted** 24 Nov 00:05:41 UTC |
| Client (P7 → X7; deactivated at the end) | `KZ1uF9XWcIMfDjrLziY0Q1W22dc2` — **deactivated** 24 Nov 00:49:24, Auth disabled, no `projectIds` |
| Internal QS (R2–R3) — **re-activated for C1-B P18** | `PvzTgu8t0XW8AUGQ9CkUelR3ziy1` — re-invited (`L5EK7cPAmldIFNBxs9lY`), account re-enabled 24 Nov 07:24:13, accepted 07:25:02; **active `qs`**, same uid and creation time, no `projectIds`. Retained for the remaining internal-role acceptance (final state for architect review) |
| Internal Project Manager — **new for C1-B P18** | `KSC9zfPAhZR6eYWLEZ9oSxdPcjJ3` — invited (`1zY5f0BshNiwgKcCji7d`), registered and accepted 24 Nov 07:23:39; **active `project_manager`**, email verified, no custom claims, no `projectIds`. Retained (final state for architect review) |
| Commercial regression fixture X (NZD) | `xDi4s4wnEXUC6q6dEdxX` — *TEST NZD-1 — Commercial regression (large)*: OCV 200,000; budget line CT-100 150,000; **approved version 1** (`sX5XWlgS9XTi49WjIThd`) 150,000; forecast CTC 160,000 → FFC 160,000, variance −10,000, GP 40,000, margin 20.00%. Planning. **Retained** |
| Commercial regression fixture Y (NZD) | `5jSw0R9QVWizCwWqJZyU` — *TEST NZD-2 — Commercial regression (small)*: OCV 50,000; budget line CT-100 30,000; **approved version 1** (`e3XQDi0sWR8XyWYtB21J`) 30,000; forecast CTC 25,000 → FFC 25,000, variance 5,000, GP 25,000, margin 50.00%. Planning (Completed 07:30 → restored 07:31). **Retained** |
| Company cost code (shared by X and Y) | `Ixk3c3hJ0zUnL3tKp68a` — *CT-100 Synthetic regression works (TEST)*, active (cost codes cannot be deleted). **Retained** |
| Final Account fixture Z (USD) — **new for C1-A** | `5hmVvUCoOIEPrzdeowYK` — *TEST USD-1 — Final Account acceptance*: OCV 120,000; budget line CT-100 90,000; **approved version 1** (`MCZAWTGUppOCDpnZOgUJ`); PO-0001 `SeVdS0hBqDVP1MdqltyC` Sent, 84,321.50 ex-GST; SI-0001 `ErpD5Uu0oRNFLYNXl2fF` Posted, 84,321.50 + GST 8,432.15 = 92,753.65; forecast CT-100 saved 0. Final Accounts: revision 1 withdrawn; **revision 2 approved and current** (QS-prepared, PM-approved; audit event `LIjIrpnKz00G6rDyiqeH`). Planning. **Retained** — revision 2 is immutable; any record later posted to this project shows as drift against it |
| Supplier contact (used by Z) | `b7k4hVAvbJoLEIVuDE1F` — *TEST Supplier (synthetic, not a real company)*; supplier, active, linked to Z only. **Retained** |
| Company counters (created by Z's PO and invoice) | `counters/purchaseOrders` and `counters/supplierInvoices`, each `next` = 2 |
| Internal identities after C1-A | TEST Company Admin (`oOANhA…`), Project Manager (`KSC9zf…`) and QS (`PvzTgu…`) — all **active**, retained for the remaining internal-role tests (Product Owner, 24 Nov) |
| **Identities after the L4 / Stage A run (B7, 24 Nov 19:41 UTC) — current state** | TEST Company Admin `oOANhA…` **active** (retained). Project Manager `KSC9zf…` **deactivated** 19:40:48; QS `PvzTgu…` **deactivated** 19:40:28; external `R5SbTZ…` re-activated as `subcontractor` on `[Z, L4]` (invitation `Ex7dAVpluJujF0RFL9FR`, accepted 19:35:13) and **deactivated** 19:40:05, `projectIds` removed; `client` `KZ1uF9…` unchanged, deactivated. All four: Auth disabled. Rows above that call the Project Manager or QS *active* describe earlier dates |
| L4 acceptance fixture (GBP) — **new for the L4 / Stage A run** | `gdaYQYRD7cc0yUTkK0cD` — *TEST GBP-1 — L4 BOQ-to-budget acceptance*, *In Progress*, start 1 Dec 2026, progress 10, currency locked. Drawing TL4-001 `7keEbCKSQZOopNBCRJjh` (rev A `XoSnxRQ7ubl4FcQ3wdYv`, one Storage object, no token); takeoff page and area measurement `LgBMG4MJqiL42cJjEbvu` (96.006 m²); BOQ items 1.1 `er81HxyVHoCHp2gMisrE` (96.006 m2 × 123.45 = 11,851.94) and 1.2 `vB8FVZJbdvzFLwcc3y7R` (41 lm × 17.40 = 713.40); BOQ-sourced budget line `boq-Ixk3c3hJ0zUnL3tKp68a` 12,565.34; **approved version 1** (`OBAF1CduuHAff610rXd2`) 12,565.34; forecast CT-100 12,000.00 → FFC 12,000.00, variance 565.34. No contract value, PO, claim or invoice. **Retained** — it is the only GBP project, so the GBP Portfolio group equals it alone |
| GANTT programme fixture (CAD) — **new for C1-C** | `V2Vj8jds7RUkBAmZ1jzm` — *TEST CAD-1 — C1-C GANTT programme acceptance*, *Planning*, CAD, no financial record (its own Portfolio group at CAD 0.00). 11 activities (T01–T10, M01; T06 and T07 cancelled), Baseline 1 *C1C Baseline A* `h09hcFrJCpDwgvsZMn6k` (approved, *Original*), Baseline 2 *C1C Baseline B* `0fE0x3cgfKowu0vPfUhp` (approved, *Active*), *C1C Baseline C* `OKcMBtOz24ddnXHUwHMe` (withdrawn). **Retained** as the programme regression fixture; final state VERIFIED read-only to hold only valid calendar dates (86 values across 11 activities and 3 snapshots; T08 9–16 Dec, revision 4) — detail TESTING.md §72 |

The NZD fixtures are deliberately **not AUD**: Projects A, B and C are open AUD
projects with no contract value, so an AUD group could never show a contract or
margin subtotal (Product Owner decision, 24 Nov). They hold no PO, claim,
invoice, variation, receipt or adjustment. Do not modify A, B or C to make an
AUD margin render.

Fixture Z is deliberately **USD**: a third NZD project would change the NZD
subtotals that X and Y exist to pin (26.00%), and an AUD project would join the
A–C group. The test company's Portfolio therefore reads 6 open projects in
three currency groups, with the USD group equal to Z alone.

Origins: `app.constrap.com` is the Product Owner's Apex session (never used by
tests); `constrapp-69b5d.web.app` the TEST admin; `constrapp-69b5d.firebaseapp.com`
the test users. Emailed links use `app.constrap.com` and must be opened on
the test host. Testers use Product-Owner-controlled mail aliases; addresses
are not recorded here.

Fixture CAD-1 is deliberately **CAD**, a currency no other fixture uses, so the
NZD (26.00%), USD and GBP subtotals stay pinned; the Portfolio now reads 8 open
projects in five currency groups. **Browser-isolation deviation (C1-C, recorded by
the Lead Architect, 25 Nov 2026):** the connected tab on `app.constrap.com`
opened in the Product Owner's personal Apex session; the engineer stopped
before any action, and the Product Owner then replaced that session with the
TEST Company Admin on `app.constrap.com` — the session uid was checked in the
page before any write, and nothing was done in Apex Builders. **Required
origins from now on:** `app.constrap.com` — the Product Owner's personal
session only, never replaced or signed out for a test; `constrapp-69b5d.web.app`
— the TEST Company Admin; `constrapp-69b5d.firebaseapp.com` — every other test
identity. Close only Claude-controlled testing tabs and dedicated windows.

Other retained production test records (Apex Builders; do not modify):
Stage A test project `Iusni6U8enVn47fKBGDB`; L4 sandbox `3OyBieoY4QHAfQsxBH8T`;
C1-A sandbox `oeqHCgEM3GsB9ZKtifZb`.

---

## B. Completed tests

### B1. M2-A2 Stage A — External Project Isolation (ADR-83)

| Check | Result | Class | Date | Record |
|---|---|---|---|---|
| FINAL Firestore ruleset and Hosting bundle identical to `main` `22cf7db` | PASS | PROD-VERIFIED | 23 Nov | TESTING.md §68 |
| Paired project + directory create and edit through the app (Company Admin) | PASS | PROD-VERIFIED | 23 Nov | §68 |
| Directory entry holds exactly five display fields, no budget | PASS | PROD-VERIFIED | 23 Nov | §68 |
| Backfill: 10/10 in sync (now 13/13 with the test company) | PASS | PROD-VERIFIED | 23 Nov | §68; this file B2 |
| Storage ruleset `2f3a4788…` published and identical to `main` (second pass — first pass found it unpublished) | PASS | PROD-VERIFIED | 23 Nov | §68; DEPLOYMENT.md |
| Isolation, directory, malformed-assignment, cross-company Rules suites (39 files / 2,492) | PASS | EMULATOR | 23 Nov | §68 |
| External role allowed / denied in production: X1–X3, X6 (subcontractor) | PASS | PROD-VERIFIED | 23 Nov | B2a (Stage B P6) |
| X-checks as a `client` (P7), X4 (empty assignment), X5 (removal), X7 (reassignment) | PASS | PROD-VERIFIED | 24 Nov | B2, B2b, B2c (Stage B P7–P8, final run) |

### B2. M2-A2 Stage B — Production acceptance in `constrap-acceptance-test` (ADR-84)

All PROD-VERIFIED by read-only Firestore / Auth / Rules REST reads before and
after each step. Apex Builders' fingerprint (42 audit events, 4 invitations,
2 members, 10 projects / 10 directory entries) was unchanged after every step.

| ID | Objective | Result | Date / time | Notes |
|---|---|---|---|---|
| Pre-flight | Worker `-00003-ceg` compatible with ADR-84 reasons; flags inert; plan | PASS | 23 Nov ~09:40 | Read-only |
| S1 | Bootstrap the isolated test company (dry run, then once live) | PASS | 23 Nov 20:10 | Admin invitation `oAZMPYeKml5iLR2Uj7w8` (operator); link kept in a 0600 file outside the repo |
| S2 | TEST Company Admin registers and accepts | PASS | 23 Nov 20:22 | Users, member, invitation and audit share one commit time; no `projectIds` |
| S3 | Projects A/B/C and five synthetic PDF fixtures through the UI | PASS | 23 Nov 20:30–20:34 | Each project and its directory entry share a commit; object checksums match; backfill 13/13 |
| R1 | Team page loads; Invite offers internal roles only | PASS | 23 Nov ~20:39 | No writes |
| R2 | Internal QS invited, accepts, full internal access; no `projectIds` | PASS | 23 Nov 20:44–20:54 | Own company reads 200; Apex company / project / file **403** from the QS session |
| R3 | Deactivate the QS: signed out, Auth disabled, file-link revocation | PASS | 23 Nov 21:20–21:21 | Urgent sweep seq 2 complete; Team page *Old file links: revoked* |
| P1 | Dry-run subcontractor provisioning on project A | PASS | 23 Nov ~21:35 | Exit 0; 56-line snapshot identical before/after |
| P2 | Dry runs that must be refused | PASS | 23 Nov ~21:35 | Apex project id, nonexistent, duplicate, 31 ids, mixed A + Apex → refused (exit 1); role `qs`, trailing comma, path, `*` → refused before any I/O (exit 2) |
| P3 | `--apply --no-link`: one operator invitation for a subcontractor on A | PASS | 23 Nov 23:30:37 | Exactly three writes: invitation, one `invite.created` audit event (`source: operator`, `projectIds [A]`), membership lock v6. No link printed. No Auth account, profile or `projectIds` written. Backfill 13/13. Team page showed *Subcontractor · Pending · Operator link* |
| P4 | Company Admin *Resend* once; email delivered; assignment unchanged | PASS | 23 Nov 23:38:53 | `resendInvitation` 200 (one call); banner *Invitation sent*; badge *Sent*; `deliveredVia` email, `sendCount` 1, provider message id, no send error; link rotated (P3 hash moved to `previousTokenHash`); role and `[A]` unchanged; audit `j1kkjxiYQZulAuwbr9HZ` `invite.resent`; plus resend rate-limit record and lock. Email receipt and *Subcontractor* wording confirmed by the Product Owner (PROD-REPORTED) |
| P5 | Invitee registers and accepts; `projectIds` exactly `[A]` in the same commit | PASS | 23 Nov 23:46:15 | `previewInvitation` 200 then `acceptinvitation-00005-mol` 200. Auth account enabled, `emailVerified` true, password provider, no custom claims. `users/{uid}`: active `subcontractor`, company `constrap-acceptance-test`, `projectIds ['Fsoo2u42FUqhKdt0fM8B']`. Profile, member record, invitation (`accepted`), audit `RTagOfbIJigSqDb9cPYN` (`invite.accepted`, after `projectIds [A]`) and lock share commit time 23:46:17.851400Z. Other six Auth accounts and Apex unchanged. A first *Registered* report at 23:41 had no production trace (no request, no account) — registration was completed at 23:46 |
| P6 | Live isolation as the subcontractor: §68 X1–X3, §63 P19–P20 | **PASS** | 23 Nov 23:53–23:57 | Real session (uid `R5SbTZ…`, verified in the page) against deployed Rules: **10 allowed → all 200**, **58 denied → all 403**; UI shows A only, no budget, no project creation, no internal document, no Portfolio; zero writes. Matrix in B2a |
| P7a | Pre-flight for the client | PASS | 24 Nov ~00:02 | `main` `bd9021c` clean apart from this file; client address has no Auth account, profile, member or invitation in either company; A, B, C and their directory entries exist; subcontractor holds `[A]` only; backfill 13/13; snapshot equal to post-P6 |
| P7b | Client provisioning: dry run, then `--apply --no-link` once on `[A, B]` | PASS | 24 Nov 00:03:50 | Dry run exit 0, nothing written. Apply exit 0: invitation `9d0NBe1iNKvmTiVxVmhU` (`client`, `[A, B]`, operator delivery, pending), audit `7vBxSAqOO1h4MrWbekbk` `invite.created` (`source: operator`, after lists `[A, B]`), lock. No link printed; no Auth account |
| P7c | Company Admin *Resend* once (Team page showed *Client · Pending · Operator link*) | PASS | 24 Nov 00:04:42 | One `resendInvitation` POST 200 (cold start); banner *Invitation sent*; badge *Sent*; `deliveredVia` email, `sendCount` 1, provider message id, no error; link rotated; role and `[A, B]` unchanged; audit `5TVV3tqIYaIyou0HWeId` `invite.resent`; resend rate-limit record; lock. Email arrived and names *Client* (PROD-REPORTED by the Product Owner) |
| P7d | Client registers and accepts; `projectIds` exactly `[A, B]` | PASS | 24 Nov 00:05:41 | `previewInvitation` 200 then `acceptinvitation-00005-mol` 200. Auth enabled, `emailVerified` true, password provider, no custom claims. `users/{uid}`: active `client`, `projectIds ['Fsoo2u42FUqhKdt0fM8B', 'RfTtgCjS6U0LC2A6vXWP']`, no C. Profile, member, invitation (`accepted`), audit `gsX5M0CJSqJQFE0kT9MH` (`invite.accepted`, after `[A, B]`), lock: one commit time 00:05:42.560866Z. Subcontractor still `[A]`; Apex unchanged |
| P7e | Live isolation as the client: §68 X1–X3, X6; §63 P19–P20 | **PASS** | 24 Nov 00:10–00:13 | Real session (uid `KZ1uF9…`, verified in the page): **18 allowed → all 200**, **80 denied → all 403**; UI A and B only; C and Apex *Project not found*; Portfolio restricted; zero writes. Matrix in B2b |
| P8 pre-flight | State before the removal | PASS | 24 Nov 00:20 | `main` = origin, tracker the only change; client active `[A, B]`; subcontractor active `[A]`; TEST admin active; QS deactivated; five fixtures present, MD5 equal to the local fixtures, unchanged since 23 Nov 21:04, no download token on any (the first reading used a wrong metadata key; re-read correctly 00:21 — conclusion unchanged: the four untouched objects have metageneration 2 since 23 Nov 21:04, and sweep seq 3 removed 0); worker `-00003-ceg` healthy (no WARNING+ in 3 h, runs every minute), revocation `requestSeq` = `completedSeq` = 3 (last: periodic, 24 Nov 00:06:02 → 00:07:02, scanned 5, removed 0), queue marker absent; directory 13/13; snapshot equal to post-P7; client session present in the testing profile (A and B listed) |
| P9 control | Positive control: a working copied link to B's project document | PASS | 24 Nov 00:21 | Architect-approved. ONE authenticated metadata read (`getDownloadURL`-equivalent) by the client's own session at 00:21:16 → 200; Storage then showed **one** download token on that object only (metageneration 2 → 3, generation and MD5 unchanged). The link was held in page memory only (never printed, no file). Anonymous request with it at 00:21:28 → **200**, 1,320 B, SHA-256 equal to the fixture; same object without the token → 403 |
| P8 | Remove B from the client: dry run, then `--apply` once | PASS | 24 Nov 00:22:06 | Dry run: now `[A, B]`, after `[A]`, *would queue a file-link revocation*. Apply exit 0, *request 4*. `users/{uid}.projectIds` `[A, B]` → `[A]` (00:22:06.754Z); member record `fileLinkRevocationSeq 4`, `fileAccessReducedAt`; audit `Uu3KXSCWFe2LYeiZA2Yf` `member.projects_changed` (before `[A, B]`, after `[A]`, `source: operator`) and `WF2vRmi9KNI4q1HM6DBl` `file_links.revocation_requested` (seq 4, reason `member.assignment_removed`) in the same commit; revocation state `requestSeq 4`, priority `urgent`, requested by `operator`; queue marker set. Subcontractor unchanged `[A]` |
| X5 (P8) | Removed project closes at the next read — same session, no sign-out | PASS | 24 Nov ~00:22:25 | Client session ~20 s after the removal: A directory, drawing, document and both A files 200; B directory, drawing, revision, document, drawings list and **both B files 403**; C and A/B financial collections and the A project record 403. The open Projects page showed *1 project · TEST A* at 00:22:46 **without a reload** |
| P9 | The copied link stops working after the removal | PASS | 24 Nov 00:23:17 | Same link, anonymous: 200 at 00:22:31 (after removal, before the sweep — the expected window), **403 at 00:23:17**. Urgent sweep **seq 4** ran 00:23:02.720 → 00:23:03.044: scanned 5, **removed 1**, failed 0, complete; queue marker cleared; audit `OJMXUSDadoIMiC146obg` `file_links.revoked` (`source: worker`). Token absent afterwards (metageneration 4, MD5 unchanged). Team page: *Old file links: revoked*. **Urgent, not periodic:** last periodic seq 3 ran 00:06–00:07 (before the token existed); next periodic not due before ~02:06. Link cleared from page memory and the tab closed |
| P10 | Repeat the removal | PASS | 24 Nov 00:24:00 | Same command with `--apply`: *No change: the member already holds exactly that list. Nothing written.* exit 0. Snapshot identical across the run — no audit event, no revocation request (`requestSeq` = `completedSeq` = 4) |
| P8–P10 integrity | Only the intended writes | PASS | 24 Nov 00:24 | Since 00:20: client profile and member record, three audit events, revocation state, lock — nothing else. Projects A/B/C untouched since S3; all five fixture MD5s unchanged, no token on any; directory 13/13; subcontractor `[A]`; TEST admin active; QS deactivated; Apex unchanged |
| Final pre-flight | Baseline for the final lifecycle run | PASS | 24 Nov 00:28 | `main` = origin, tracker the only change; client and subcontractor active on `[A]`; TEST admin active; QS deactivated; five fixtures unchanged, no token; worker healthy, revocation 4/4, no queue marker; directory 13/13; snapshot equal to post-P10 |
| X4 (run) | Clear every assignment of the client (`--clear`), same session | PASS | 24 Nov 00:28:52 | Dry run warned *the member will hold NO project*; apply once → `projectIds: []` (field kept), membership active; audit `m9VbykXQWTJbEh7gnM53` `member.projects_changed` `[A]` → `[]` and `naLKgfVoX677KPN0gZA3` revocation request **seq 5** (`member.assignment_removed`, urgent); worker 00:29:02.605 → .868, scanned 5, removed 0 (no token existed), `file_links.revoked`. Client session (no sign-out): Dashboard *No projects have been assigned to you yet*, Projects *0 projects … Ask your contact at the company to arrange access*, no *Add New Project*; Rules probes 00:29:45 — own profile and company document 200, **42 others 403** (A, B, C directory / record / drawings / documents / five financial collections each; A and B drawings, revision, documents incl. internal; all five files; project and directory lists; Apex) |
| X7 (run) | Reassign the client to C only (`--add C`) | PASS | 24 Nov 00:30:32 | Dry run then apply once → `[C]`; one audit event `pdMyVHY2Mm4zUMhe3EEw` (`[]` → `[C]`); **no revocation request** (sequence stayed 5); only profile, audit and lock written. Open Projects page switched to *TEST C — Reassignment* without a reload; C opens (Overview, Documents — empty register); A URL *Project not found*. Probes 00:30:57: C directory 200, C drawings and documents lists 200 (0 — C has no fixtures, so access is proven at list level), C project record and C financial collections 403; every A and B resource and all five files 403 — no earlier permission returned |
| P11 (run) | Assignment refused for an internal member | PASS | 24 Nov 00:31 | Dry runs against the TEST Company Admin: `--add A` and `--clear` → *Refused: invalid-assignment — role*, exit 1; against the deactivated QS → *Refused: not-found — member*. Snapshot identical (no write, no audit). Apply path shares the check: the script always runs the read-only pass first (`set-member-projects.mjs:79`) and the write path re-runs `planAssignment` inside the locked transaction (`memberProjects.js:166–167`), which refuses non-external roles (`:129`) |
| P12 (run) | Deactivate the subcontractor from the Team page | PASS | 24 Nov 00:32:38 | In-app dialog named *Joe*; confirmed once (`deactivatemember-00005-suy` 200 after a cold start). Banner *Joe was deactivated. Old file links are being revoked in the background.*; row *Deactivated · revocation pending*, later *revoked*. `users/{uid}`: `deactivated`, `companyId` / `role` null, `formerRole subcontractor`, **`projectIds` field removed**; Auth **disabled**, `validSince` 00:32:39 (refresh tokens revoked). Audit `KweyHVeoJyBJUNlkogpm` `member.deactivated` (before `[A]`, after `[]`), `mHSdxi61EJaIIloRuX1b` revocation request **seq 6** (`member.deactivated`, urgent), `uZBgzDYMdaaujJjQm69T` `member.auth_synced` (`disabled`, `refreshTokensRevoked`); worker 00:33:02.086 → .271, scanned 5, removed 0, `file_links.revoked`. Client unaffected (`[C]`, active). Not tested live: no subcontractor browser session existed (the client was signed in); a disabled account cannot sign in, and Rules deny a profile with `companyId` null (proven for the QS in R3) |
| P13a | Re-provision the former subcontractor as `client` on `[C]`; Resend | PASS | 24 Nov 00:33:48 / 00:34:24 | Dry run: *a DISABLED account with no active membership: opening the invitation re-enables it*. Apply once `--no-link` → invitation `X3klK9MdfYNbBCXIyUiq` (`client`, `[C]`, operator, pending), audit `V20YEkXCDgHWxIO32C2X` `invite.created`. **Auth still disabled after provisioning.** Team page *Client · Pending · Operator link*; Resend once → one POST 200, `sendCount` 1, provider id, no error, `[C]` unchanged, audit `wcs2EV4kNpS36ahTv37A` `invite.resent` |
| P13b | Re-acceptance by the existing identity | PASS (server) | 24 Nov 00:35:00 / 00:35:42 | Opening the invitation re-enabled the account: audit `pVCoKYblUvBtriZqOUjk` `member.auth_reenabled` (disabled true → false, 00:35:00). Acceptance `acceptinvitation-00005-mol` 200: **same uid `R5SbTZ…`, one Auth account for the address, Auth total still 8, creation time unchanged**; enabled, email verified. `users/{uid}`: role **`client`**, active, `projectIds` **exactly `[C]`**, `formerRole` / `formerCompanyId` cleared — **`[A]` not restored**. Profile, member record, invitation (`accepted`, `reactivatedUid` set) and audit `IQSS72qjaiyidXRIV3fT` `invite.accepted` (before `deactivated`, after `client` `[C]`) share commit 00:35:43.801698Z. Session checks: pending — the Product Owner signed in from another browser; the testing profile has no session |
| P13c | Access as the re-activated member (client on `[C]`), real session | PASS | 24 Nov 00:44 | Product Owner signed in on `firebaseapp.com` in the testing profile; session uid `R5SbTZ…` verified in the page. UI: *Joe · Client*; Projects *1 project · TEST C — Reassignment*; no money, no *Budget*, no *Add New Project*; sidebar Dashboard and Projects; A URL *Project not found*; C opens; `/portfolio` restricted. Probes 00:44:04: C directory 200, C drawings and documents lists 200 (0), own profile and company document 200; **57 others 403** — every A resource of the earlier assignment (directory, record, drawing, revision, documents incl. internal, lists, both files), all B resources, project records and eight financial collections + baseline on A, B and C, other members' profiles, company members / invitations / audit, Apex. No write |
| P14 | `reconcile-membership.mjs`, report only (no `--fix`) | PASS | 24 Nov 00:43 | Test company: *No inconsistencies found.* (JSON `[]`); whole project: **0 findings** — no R1–R9, so no R7 / R8 / R9 (no stray, invalid or stale assignment; Auth, profile and member records consistent). Snapshot identical (no write); directory 13/13 |
| Final safety | Deactivate both external test accounts from the Team page | PASS | 24 Nov 00:49:03 / 00:49:24 | TEST admin session (on `firebaseapp.com`); in-app dialogs named *Joe* then *Bill*; each confirmed once (`deactivatemember-00005-suy` 200 ×2). Both: `users/{uid}` deactivated, `companyId` / `role` null, **`projectIds` field removed**; Auth **disabled**, new `validSince` (refresh tokens revoked); audit `member.deactivated` (before `[C]`), `file_links.revocation_requested` (Joe seq **7**, Bill seq **8**, `member.deactivated`, urgent), `member.auth_synced` (`disabled`, `refreshTokensRevoked`) — ids `RqOrQxLK…`, `g2peXQDa…`, `pJPBQqQ1…`, `fdM5Rr71…`, `jE8L16Zt…`, `22tCejPL…`. Worker pass **seq 8** (covers 7) 00:50:02.534 → .861, scanned 5, removed 0, failed 0, complete; `file_links.revoked` `aywnALihSQms3Bh2cvYa`; queue cleared. **Joe's live session on `web.app` was signed out automatically** (tab on `/login` by 00:49:08, ~5 s after the deactivation). Team page: 1 active member (TEST admin) |
| Final integrity | End state of the run | PASS | 24 Nov 00:50 | Snapshot diff across the deactivations: only the two profiles, member records and Auth accounts, seven audit events, revocation state, lock. Projects A / B / C unchanged since S3 (A budget 123,456, B and C 0); their only subcollections are `documents` and `drawings` (A, B) and none (C) — no financial record exists or was written. Five fixture MD5s equal to the local files, **no download token on any**. Directory 13/13. Reconcile (report only, whole project) after the deactivations: `[]`. **Apex fingerprint identical to the pre-P1 baseline** (company update 2026-08-24, 42 audit events, 4 invitations, 2 members, 10 projects / 10 entries, lock 2026-11-18). `main` `bd9021c`; this file the only local change |

### B2a. P6 access matrix — subcontractor `R5SbTZ…`, assigned `[A]` (23 November 2026, PROD-VERIFIED)

Method: the subcontractor's own browser session on `firebaseapp.com`; Firestore
REST with the session's ID token and Storage `alt=media` downloads with the
same token, against the deployed Rules (no Admin SDK). Status codes and byte
counts only; no token or download URL recorded. Positive controls returned
200 in the same session.

| Expected | Resource | Result |
|---|---|---|
| Allowed | A directory entry (fields exactly `location`, `name`, `progress`, `startDate`, `status` — no budget) | 200 |
| Allowed | A drawing TA-001, its revision, the A drawings list | 200 ×3 (list: 1) |
| Allowed | A project-visible document; A documents list filtered `project` + `active` | 200 ×2 (list: 1) |
| Allowed | A drawing file; A project document file | 200 (1,318 B; 1,319 B) |
| Allowed | Own `users/{uid}`; company document (`name`, `countryCode`, `baseCurrency`, `createdAt`, `createdBy`) | 200 ×2 |
| Denied | A **project document** (headline budget, currency) | 403 |
| Denied | `projects` list; `projectDirectory` list | 403 ×2 |
| Denied | B and C directory entries; B and C project documents | 403 ×4 |
| Denied | B drawing, revision, drawings list; C drawings list; B project-visible document | 403 ×5 |
| Denied | A **internal** document; A documents list unfiltered | 403 ×2 |
| Denied | B drawing file (download and metadata); B document file; A internal document file | 403 ×4 |
| Denied | Apex company, project, directory entry, document record, projects list, document file | 403 ×6 |
| Denied | Another member's `users/{uid}` (TEST admin) | 403 |
| Denied (§63 P20) | 22 financial / commercial collections listed on the **assigned** project A — budget lines, POs, claims, supplier invoices, variations, forecasts, client invoices, receipts, payments, credit notes, cash flow, retention releases, final accounts, budget approvals / snapshots / adjustments, BOQ, tender packages / bids, activities, programme baselines, RFIs | 403 ×22 |
| Denied (§63 P20) | A `commercial/baseline`, `approvedBudget/current` | 403 ×2 |
| Denied | Collection-group queries: `budgetLines`, `projects`, `documents` (`project` + `active`) | 403 ×3 |
| Denied | Company `members`, `invitations`, `auditEvents`, `system/fileLinkRevocation`, `costCodes`, `contacts` | 403 ×6 |

**Application (X1–X3, P19):** Dashboard and Projects list *TEST A — Assigned*
only, with no money, no *Budget* text and no *Add New Project*; the sidebar
offers Dashboard and Projects only. Project A shows Overview (start date and
progress only) and Documents; Drawings lists TA-001; General Documents lists
the project spec only, with the notice that internal documents are not
listed. Project B, project C and an Apex project URL each show *Project not
found*. Direct `/portfolio` shows *The Portfolio Report is restricted*. No
console error. No Cloud Function request from the subcontractor. Production
snapshot identical before and after.

**Limits of this evidence.** Network traffic on `/portfolio` was only the
shared Firestore Listen channel, whose request bodies could not be decoded
(two capture attempts; the positive control captured nothing, so no claim is
made from them). That no financial collection is *requested* by the page rests
on the code and unit tests (§63); that none is *readable* is proven by the
P20 rows above. No write was attempted. Files were fetched, not opened in the
application's viewer.

### B2b. P7 access matrix — client `KZ1uF9…`, assigned `[A, B]` (24 November 2026, PROD-VERIFIED)

Same method and limits as B2a (the client's own session; Firestore REST and
Storage `alt=media` with its ID token; status codes and byte counts only).

| Expected | Resource | Result |
|---|---|---|
| Allowed | A and B directory entries (each exactly `location`, `name`, `progress`, `startDate`, `status` — no budget) | 200 ×2 |
| Allowed | A and B drawings, revisions and drawings lists | 200 ×6 (lists: 1 each) |
| Allowed | A and B project-visible documents; both documents lists filtered `project` + `active` | 200 ×4 (lists: 1 each) |
| Allowed | A drawing, B drawing, A document, B document files | 200 ×4 (1,318 / 1,319 / 1,319 / 1,320 B) |
| Allowed | Own `users/{uid}`; company document (same five fields as B2a) | 200 ×2 |
| Denied | **A, B and C project records** (headline budget, currency); `projects` and `projectDirectory` lists | 403 ×5 |
| Denied | C directory entry; C drawings list; C documents list (`project` + `active`) | 403 ×3 |
| Denied | A **internal** document, its file and file metadata; A and B documents lists unfiltered | 403 ×5 |
| Denied (§63 P20) | 22 financial / commercial collections + `commercial/baseline` + `approvedBudget/current` on **each** assigned project (A and B) | 403 ×48 |
| Denied | Collection-group queries: `budgetLines`, `clientInvoices`, `projects`, `documents` (`project` + `active`) | 403 ×4 |
| Denied | Company `members`, `invitations`, `auditEvents`, `costCodes`, `contacts`, `system/fileLinkRevocation` | 403 ×6 |
| Denied | Subcontractor's and TEST admin's `users/{uid}`; `users` list | 403 ×3 |
| Denied | Apex company, project record, directory entry, document record, projects list, document file | 403 ×6 |

**Application (X1–X3, P19):** Dashboard and Projects list *TEST A — Assigned*
and *TEST B — Removable* only; no money, no *Budget* text, no *Add New
Project*; sidebar Dashboard and Projects. A and B each show Overview (start
date, progress) and Documents; A lists TA-001 and its project spec only (no
internal document), B lists TB-001 and its project spec. Project C (overview
and documents) and the Apex project URL show *Project not found*. Direct
`/portfolio` shows *The Portfolio Report is restricted*; no sidebar entry;
no console error; backend traffic only the Auth lookup and the shared
Firestore Listen channel (bodies not inspected — B2a limits). No Cloud
Function request from the client. Production snapshot identical before and
after the session tests.

**Production note.** `system/fileLinkRevocation` changed at 00:07:02 UTC during
P7: the scheduled periodic sweep (request seq 3, requested by the worker,
scanned 5, removed 0, complete) — not a test write.

### B2c. Observed revocation timings (production, 24 November 2026)

| Event | Trigger | Rules denial in the member's session | Worker request → completion | Copied link |
|---|---|---|---|---|
| P8 remove B | operator script | ~20 s (next read; UI updated without reload in ~40 s) | seq 4: 00:22:06 → 00:23:03 (57 s), removed 1 | 200 → **403** at +71 s |
| X4 clear `[A]` | operator script | next read (~50 s, first probe) | seq 5: 00:28:52 → 00:29:03 (11 s), removed 0 | none existed |
| P12 deactivate subcontractor | Team page | session already absent; Auth disabled at once | seq 6: 00:32:38 → 00:33:02 (24 s), removed 0 | none existed |
| Final deactivations | Team page | live `web.app` session signed out in ~5 s | seq 7 + 8: 00:49:03 / 00:49:24 → 00:50:03, removed 0 | none existed |
| X7 add C | operator script | C readable at next read | **no request** (addition only) | — |

The worker runs every minute, so completion is bounded by the next tick plus the
pass (0.2–0.4 s for five objects). Periodic reconciliation (2 h) played no part:
the only periodic pass in the window was seq 3 at 00:06–00:07, before any token
was minted.

### B3. Earlier security and data-integrity milestones

Status as recorded in the linked section; class shown where the record states it.

| Milestone | What was accepted | Class | Record |
|---|---|---|---|
| M1 forecast integrity; M2-A read containment; M2-B1/B2/B3 PO, claim, variation lifecycle Rules; ADR-60; M3-A/B1/B2 | Rules-enforced lifecycles, read containment, commitment pairing | EMULATOR + PROD-REPORTED (live from 27 Oct 2026) | TESTING.md §31–§39 |
| SHIELD 2A, 2B1, 2B2; ADR-69 capacity recovery | Claim↔invoice pairing; approved budget versions; adjustments | EMULATOR + PROD-REPORTED | §45–§48 |
| L1 Team Management (ADR-72) | Invitations, acceptance, roles, deactivation via trusted backend | PROD-REPORTED (11 Nov) | §49 |
| DC46-A/B/C (ADR-73–75) | Authenticated downloads; token revocation; periodic reconciliation (2 h); external access follows status. **DC46 CLOSED 18 Nov with accepted risks** | PROD-VERIFIED + PROD-REPORTED | §51–§59 |
| L2-A Commercial Report | Read-only report, CSV, print | PROD-REPORTED (19 Nov) | §60 |
| L2-B Stage A — capacity recovery 3 (ADR-76) | Live ruleset byte-identical to `main` | PROD-VERIFIED (19 Nov) | §61 |
| L2-B Final Account (ADR-77) + C1-A | F3, F4, F7–F13, F17 PASS in sandbox; forecast-readiness correction live; retest R1, R2, R4 PASS, R3 blocking PASS. **24 Nov (B6):** F5, F6, F15, Project Manager approval, F14 native PDF, R5 PASS; F16 partly | PROD-VERIFIED (22 Nov; 24 Nov) | §62, §62b, §62c; B6 |
| L2-C Portfolio (ADR-78) | Visual, CSV, PDF acceptance | PROD-REPORTED (20 Nov) | §63 |
| C1-B Portfolio | P4 row parity to the cent; M2 load timings | PROD-VERIFIED (22 Nov) — report to architect; superseded as the recorded parity evidence by the 24 Nov run (B4) | §63 |
| C1-B Portfolio (24 Nov) | P1–P8, P12, P13, P21, P22; M1, M4; CSV = screen; P4 on five rows (55 figures) | PROD-VERIFIED (24 Nov) — read-only, Company Admin; P18 blocked | §63; B4 |
| GANTT 1A1/1A2/1B, PULSE 1C, GANTT core completion (ADR-79) | Live bundle verified; PO accepted | PROD-VERIFIED (bundle) + PROD-REPORTED | §40–§43, §64 |
| L3 Stage 1 monitoring + restoration verification | Monitoring created; restore SUCCESSFUL (counts + one sample hash) | PROD-VERIFIED (monitoring) + PROD-REPORTED (restore) | §65 |
| L4 BOQ → working budget (ADR-81) | T1–T8, T10–T13, T15, T16 PASS; UX correction PASS | PROD-VERIFIED (22 Nov) | §67 |
| Operator tooling safety (D3 #1–#3, #16, #18) | Merged (`bc64487`, merge `62e824a`); unit 101 / 5,244, Functions pure 8 / 179, Functions emulator 11 / 367; `npm run test:team` PASS ×4; Azure `main` green (REPORTED by the Lead Architect); no deployment required | EMULATOR + PROD-REPORTED (CI) — **never exercised against production** | §70; D5 |

### B4. C1-B — L2-C Portfolio read-only production acceptance (24 November 2026, PROD-VERIFIED)

**Session.** Apex Builders (`2Vf3CVuYE8wWzg8hLjR5`), the Product Owner's
existing `company_admin` session on `app.constrap.com`, in a dedicated
Claude-controlled tab (no sign-in needed). 05:14–05:27 UTC. Live Hosting
bundle unchanged since L2-C. Every action read-only: no button other than
Refresh and Export CSV was used; the CSV was captured in page memory (the
download was intercepted, no file written) and discarded afterwards. No
Admin SDK write; no production configuration read or changed beyond
Cloud Monitoring and Logging reads.

**No write (P22, backend evidence).** Cloud Monitoring
`firestore.googleapis.com/document/write_count` and `delete_count` for the
whole database: **0 in every minute from 05:12 to the end of the session**.
The only writes near the window — 13 writes and 2 deletes in the 05:10–05:11
points, before the browser session started at 05:14:34 — are the DC46 worker's
periodic reconciliation (`processfilelinkrevocations`: *reconciliation plan
complete* 05:10:03, worker runs 05:10:03 and 05:11:02), not a test action.

**Scope at the time of the run (M1).** Two companies exist: Apex Builders and
the isolated test company (3 projects, no financial records). Apex: **10
open projects, 0 completed** — AUD 7, USD 2, ZAR 1; Planning 7, In Progress
3; 8 working budget only; 2 approved (C1-A sandbox version 1, L4 sandbox
version 2); 6 with no contract value. Three of the ten are retained test
projects (Stage A `Iusni6U8…`, L4 `3OyBieoY…`, C1-A `oeqHCgEM…`). No real
customer company exists yet, so M1 = 10 is the largest company, not a
customer measurement.

| # | Result | Evidence |
|---|---|---|
| P1 | PASS | Sidebar order Dashboard, Projects, **Portfolio**, Contacts, Subcontractors |
| P2 | PASS | During Refresh: status *Loading project records… 7 of 10 projects read*, Export and Print disabled until settled; subtotals in a loading state; then *All 10 projects have been read.* |
| P3 | PASS | *Apex Builders*; *Open projects (10 projects)* (no completed projects, so no "completed not included" clause); *AUD, USD, ZAR — reported separately, never combined*; generation time; *Records read between 06:14:35 pm and 06:14:36 pm* NZDT (CSV: 05:14:35.989Z → 05:14:36.702Z) |
| P4 | **PASS — 5 rows, 55 of 55 figures to the cent** | Portfolio row = project Reports tab for C1-A (approved v1), L4 (approved v2), Gold Coast apartments, Residential Developements (both working budget, contract set) and Peter House (ZAR). Figures in the table below |
| P5 | PASS | Eight working-budget rows: *Budget: Working budget (not approved)*; Approved budget and Variance *Not approved* with *Working budget …* / *Working variance …* beneath; AUD, USD and ZAR Approved Budget and Variance subtotals *Incomplete* with the count |
| P6 | PASS | Six rows with no contract value: Contract sum, Gross profit, Margin *Not set*; AUD and USD contract / profit / margin subtotals *Incomplete* |
| P7 | PARTIAL — precondition absent | No currency has every project approved and complete. The six complete AUD subtotals checked by hand: Actual 23,199.50; Remaining committed 13,000.50; Forecast final cost 65,850.00; Supplier invoices unpaid 5,521.45; Client invoices outstanding 839,100.00; Pending client variations 142,000.00 — all equal the row sums. Aggregate margin checked only on ZAR (one project: 550,000 ÷ 550,000 = 100%); a multi-project aggregate margin is not exercisable on this data |
| P8 | PASS | Three sections (AUD, USD, ZAR), each with its own subtotals; the only cross-currency block is *Project counts · all currencies · no money*; no combined figure |
| P9 | NOT EXERCISABLE | No completed project in any company. Needs a completed project (a status write) |
| P10, P11, P14, P16, P17 | Not re-run | Covered by the visual / CSV / PDF acceptance (PROD-REPORTED 20 Nov; per-item record not held). P11 link target `/projects/{id}/reports` confirmed in source (`CurrencyGroup.jsx`); the Reports tabs were opened by URL |
| P12 | PASS | Refresh at 05:19 UTC: rows returned to loading and reloaded; read window moved from 06:14:35 pm to 06:19:18–06:19:19 pm NZDT; every subtotal unchanged |
| P13 | PASS (content) | CSV generated through the page's own Export: header block (company, scope, currencies, generated, records read, coverage COMPLETE, amounts basis), column glossary, 10 PROJECT and 3 SUBTOTAL lines, each with a Currency cell; incomplete subtotals `INCOMPLETE` with notes (*Approved Budget: 2 of 7 projects (5 budget not approved)*); numbers unformatted. **Every CSV value equals the screen.** Not opened in a spreadsheet application |
| P15 | NOT RUN | Needs DevTools → Network → Offline (not available to the browser extension); unit-tested (§63) |
| P18 | **BLOCKED — needs writes** | Apex has no active `project_manager` or `qs` (the one PM, `L1vCSi…`, is deactivated; two `company_admin` users). The test company has no financial records and its QS is deactivated. Prerequisite and scope below |
| P19, P20 | PASS (reused, not repeated) | B2a, B2b — subcontractor and client, 24 Nov; payload limitation retained |
| P21 | PASS | Dashboard: *Portfolio · project counts* (active 3, total 10, by status) — no money; the only amounts are in the one-project snapshot (Lakes Apartments, AUD) |
| P22 | PASS | Zero Firestore writes / deletes during the session (above) |
| M1 | 10 projects | Above |
| M2 | Reused (22 Nov) | Cold navigation → *All 9 read* ≈ 2.7 s; warm reload 1.5 s; in-page Refresh 480–612 ms. 24 Nov loader read windows (10 projects): cold 0.71 s, Refresh ≤ 1 s (display resolution) |
| M3 | Not measurable as specified (reused) | Server reads travel over the shared Listen WebChannel, not one HTTP request per read (22 Nov). The loader's request plan for this company is 13 × 8 + 15 + 16–17 = 135–136 document requests (code; §63 unit tests) |
| M4 | **136 document reads for one Portfolio read (in-page Refresh)** | Cloud Monitoring `document/read_count`, whole database, raw 1-minute points: idle 1 / min at 05:16, 05:17 and 05:20; Refresh at 05:19:18 → **21 + 115 = 136** over the 05:18–05:19 points (the sampler splits one burst across two points; includes ~1–2 idle reads). Cold page load including the application shell's listeners: **102 + 189 = 291** over 05:14–05:15. A per-register breakdown is not available from the metric |
| M5 | Not measurable (reused) | Cross-origin streamed responses report no transfer size (22 Nov) |

**P4 figures (each identical on the Portfolio row, the Reports tab and the CSV).**

| Project (currency, budget) | Contract | Budget | Actual | Rem. committed | FFC | Variance | Gross profit | Margin | Payables | Receivables | Pending client var. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1-A (AUD, approved v1) | 10,500.00 | 8,000.00 | 1,000.00 | 0.00 | 1,000.00 | 7,000.00 | 9,500.00 | 90.5% | 1,100.00 | 0.00 | 0.00 |
| L4 (AUD, approved v2) | Not set | 3,440.00 | 0.00 | 0.00 | 0.00 | 3,440.00 | Not set | Not set | 0.00 | 0.00 | 0.00 |
| Gold Coast apartments (AUD, working) | 1,071,200.00 | working 542,000.00 | 21,899.50 | 8,000.50 | 59,400.00 | working 482,600.00 | 1,011,800.00 | 94.5% | 4,421.45 | 91,100.00 | 2,000.00 |
| Residential Developements (AUD, working) | 1,075,000.00 | working 1,000.00 | 300.00 | 2,200.00 | 2,650.00 | working −1,650.00 | 1,072,350.00 | 99.8% | 0.00 | 748,000.00 | 140,000.00 |
| Peter House (ZAR, working) | 550,000.00 | working 0.00 | 0.00 | 0.00 | 0.00 | working 0.00 | 550,000.00 | 100% | 0.00 | 22,000.00 | 0.00 |

Each row is also internally consistent: gross profit = contract − FFC;
variance = budget − FFC; margin = profit ÷ contract (CSV to two decimals:
90.48, 99.75, 94.45, 100.00). Working-budget figures are shown by the
Portfolio as *Not approved* with the working amount beneath, and by the
Reports tab under its *Approved budget* card with the sub-label *Working
budget (not approved)* — same value, different presentation (D3 #19).

**Subtotal wording (D3 #9) — assessed against the live UI.** For the AUD
Approved Budget subtotal the three surfaces read: card *Incomplete — Not
totalled — 5 of 7 projects: 5 budget not approved*; table footer
*Incomplete / 2 of 7*; CSV *Approved Budget: 2 of 7 projects (5 budget not
approved)*. All three come from the same `subtotalFor` result (`included` 2,
`affected` 5, `total` 7) and every surface withholds the value — no partial
sum is shown or exported anywhere. The card counts **excluded** projects
(`portfolioSubtotalNote`, `portfolioReport.js:517`), the table counts
**included** projects without saying so (`CurrencyGroup.jsx:241`), and the CSV
gives both. The source comment above `portfolioSubtotalNote` describes the
included-count form (*"4 of 6 projects — 2 budget not approved"*), so the card
text departs from its own stated intent. **Classification: cosmetic wording
only** — not a reporting inconsistency of any value, not a calculation
defect. Recommended correction in D3 #9.

**P18 — prerequisite and scope (not authorised here).** One active
`project_manager` and one active `qs` in Apex Builders — two Team-page
invitations to Product-Owner-controlled aliases and their acceptances (new
accounts) — or the reactivation of the deactivated PM. Then, in each session,
read-only: open `/portfolio`, compare every subtotal and the five P4 rows with
the table above (or a fresh Company Admin read the same hour), export the CSV
in memory; then deactivate both from the Team page (urgent file-link sweep
expected, as in B2). The same sessions would cover C1-A F5, F6, F15, F16, L4
T14 and the Stage A internal M-items (C4) — one role-session task rather than
three.

### B5. C1-B — final targeted acceptance in `constrap-acceptance-test` (24 November 2026, PROD-VERIFIED unless marked)

**Architect decisions applied:** financial parity ACCEPTED (B4); no test
accounts in Apex Builders; work only in the isolated test company. **Product
Owner decisions (24 Nov, in session):** fixtures in **NZD** rather than AUD
(see the note under *Isolated test environment*); one shared company cost code
`CT-100`. Every write went through the application as the TEST Company Admin
(`oOANhA…`, session verified in the page) on `constrapp-69b5d.web.app`; role
sessions on `constrapp-69b5d.firebaseapp.com`. No Admin SDK write; no derived
value written.

**Writes made (complete list, 07:15–07:31 UTC):** two projects with their
directory entries (each one commit); one cost code; two commercial baselines
(each sets the project's currency lock in the same transaction); two budget
lines; two forecast lines; two budget approvals (capture → approve version 1:
header, immutable snapshot, pointer); two invitations (`invite.created`) with
their rate-limit records; PM registration and acceptance (`invite.accepted`;
new Auth account, `users`, `members`); QS re-activation (`member.auth_reenabled`)
and acceptance (`invite.accepted`); membership lock; Y status Planning →
Completed → Planning (project + directory entry in one commit each). Invitation
emails sent to Product-Owner aliases (Resend, `sendCount` 1, no error).

**Independent expectations** (computed in Python with `Decimal` from the stored
records read over REST — baseline OCV, budget lines, forecast lines, approval
snapshot `entries` / `total`; no PO, claim, invoice, credit note, variation,
receipt, payment, retention or adjustment exists): FFC = actual 0 + committed 0
+ CTC; GP = contract − FFC; margin = GP ÷ contract (ADR-78: aggregate
`marginPercent(Σ profit, Σ contract)`, never the mean of project margins).

| | Contract | Approved budget | FFC | Variance | GP | Margin |
|---|---|---|---|---|---|---|
| X | 200,000.00 | 150,000.00 | 160,000.00 | −10,000.00 | 40,000.00 | 20.00% |
| Y | 50,000.00 | 30,000.00 | 25,000.00 | 5,000.00 | 25,000.00 | 50.00% |
| **NZD subtotal** | **250,000.00** | **180,000.00** | **185,000.00** | **−5,000.00** | **65,000.00** | **26.00%** (arithmetic mean would be 35.00%) |
| X only (Y completed, default view) | 200,000.00 | 150,000.00 | 160,000.00 | −10,000.00 | 40,000.00 | 20.00% |

| # | Result | Evidence |
|---|---|---|
| P7 — incomplete budget | **PASS** | With X approved and Y on its working budget (07:20): NZD contract 250,000, FFC 185,000, GP 65,000, **margin 26%** (CSV 26.00) — margin needs no approved budget; Approved Budget and Variance subtotals *Incomplete — Not totalled — 1 of 2 projects: 1 budget not approved*; CSV `INCOMPLETE` with *1 of 2 projects (1 budget not approved)*; Y row *Not approved*, working 30,000 / working variance 5,000 |
| P7 — complete group | **PASS** | Both approved (07:21): every NZD subtotal equals the table above to the cent on screen and in the CSV; **margin 26% / 26.00, not 35** — weighted, not averaged; variance −5,000 signed. The AUD group (A, B, C) stays *Incomplete* (3 contract value not set, 3 budget not approved) — unchanged behaviour |
| P9 | **PASS** | Y set Completed through the Edit form (07:30). Default view: *Open projects (4 projects) · 1 completed not included*; counts 4, *Planning 4*; NZD group *1 project*, subtotals = X only (200,000 / 150,000 / 160,000 / −10,000 / 40,000 / **20%**); CSV scope and lines identical. *Include completed*: status line went straight to *4 of 5 projects read* (only Y was read; the loaded rows were not re-read) → *All projects, including completed (5 projects)*, *Planning 4 · Completed 1*, NZD subtotals back to 26%; CSV scope *All projects, including completed (5 projects)*, Y line `Completed`. Y restored to Planning (07:31; the lifecycle allows any status change) and the default view re-checked: 5 projects, 26% |
| P18 — Company Admin | **PASS** | Figures above; controls Refresh, Export CSV, Print / Save as PDF, *Include completed* only; no console message |
| P18 — Project Manager (`KSC9zf…`) | **PASS** | Session uid verified in the page. Same scope (5 projects, AUD and NZD separate), same NZD subtotals and rows; CSV PROJECT + SUBTOTAL lines (7, excluding the read-time column) SHA-256 `15310838fd5c3249…` — **identical to the Company Admin's**; same three buttons and one checkbox, no mutation control on the page; zero console messages across two loads |
| P18 — QS (`PvzTgu…`) | **PASS** | Session uid verified. Identical scope, subtotals, rows; CSV fingerprint `15310838fd5c3249…` — identical; same controls; zero console messages |
| P18 — cross-company | **PASS (application level)** | As PM and as QS, the Apex project URL (Gold Coast) shows *Project not found.*, no console message. A direct REST probe of non-financial Apex paths with the role's session token was **not run** (blocked by the session's safety controls); Rules-level cross-company denial rests on R2 (23 Nov, QS session: Apex company / project / file 403) and the Rules suites. No Apex financial data was requested |
| P15 | **PASS — LOCAL ONLY (EMULATOR)** | Not production acceptance. Local emulators (`npm run test:team`, project `constrapp-rules-test`) + Vite on 127.0.0.1:5173; one seeded company / NZD project; headless Chrome 158 driven over DevTools (`Network.emulateNetworkConditions offline: true`). Online: 200,000 / 160,000 / 20%. Offline → Refresh: settled in 0.2 s; **13 figures *Unavailable* (never 0)**, *Could not load: …* per source, *Financial coverage is incomplete: records could not be loaded for 1 of 1 project*, every subtotal *Incomplete — 1 unavailable*, source data incomplete 1. Online → Refresh: figures restored. Only SDK transport warnings in the console. The production browser extension cannot simulate offline; the owner's network was not touched |

**Data integrity (read-only snapshots taken before the first write at 07:15 and after 07:37).** Apex
Builders: 257 of 257 documents unchanged except `system/fileLinkRevocation`
(07:12:02 — the DC46 periodic reconciliation: *reconciliation plan complete*
07:11:03; worker runs 07:11 / 07:12). Test company: Projects A, B, C and all
their documents and drawings unchanged; five Storage fixtures byte-identical
(MD5), no download token; directory **5 / 5 in sync** (fields equal; X's
project document additionally carries the currency lock from its baseline
commit, a field the directory does not hold); only the writes listed above.
`users`: QS profile (re-activation) and the new PM profile only; the
subcontractor and client profiles unchanged. Auth: `ct-sub` and `ct-client`
**disabled**; `ct-admin`, `ct-pm`, `ct-qs` enabled. Five audit events:
`invite.created` ×2, `invite.accepted` (PM), `member.auth_reenabled` (QS),
`invite.accepted` (QS), all `source: callable`.

**Observations (not blocking; recorded in D3).**
- #20 — after the first *Save all changes* on X's Forecast tab, the page kept
  showing *Not forecast* and FFC 0 although the forecast line was written
  (verified over REST, 07:18:10); a reload showed FFC 160,000. Y's save
  updated at once. Seen once in two saves; not reproduced.
- #21 — offline (P15), the status line still reads *All 1 project has been
  read.* while every source failed; the coverage notice below it is correct.
- The PM's first registration left the test-user tab signed in as the TEST
  Company Admin, not the PM; signed out and the PM signed in again. Test
  procedure only (D3 #15).

### B6. C1-A — Final Account remaining acceptance in `constrap-acceptance-test` (24 November 2026, PROD-VERIFIED unless marked)

**Architect decision (25 November 2026 — REPORTED).** **GO — C1-A is CLOSED.** F16 is
accepted on the combined evidence: production access denial (signed out,
Auth-disabled accounts, Rules 403 for both external roles) plus the unit test
of the restricted notice. The notice is **not** recorded as observed in
production; its browser check is carried forward to the external-role session
that L4 T14 and §61 W4 need. Every limitation below stands, including R5 on
stored-state evidence and the zero-only client-side and cash figures. Project
Z, its supplier contact, the two counters and the approved revision are
retained; the TEST Project Manager and QS stay active. D3 #22–#26 go to the
deferred UX and reporting correction bundle. Self-approval remains a
documented policy gap for a future approval-segregation implementation. Next
milestone: L4 remaining acceptance and M2-A2 Stage A internal-role regression.

**Scope.** The items left open by the 22 November run: F5, F6, F15, F16, the
native print / PDF part of F14, Project Manager approval and retest R5
(TESTING.md §62, §62b). Run 10:21–10:53 UTC on `main` `2561344` (= `origin/main`,
fetched — VERIFIED); Hosting bundle `index-BOg2hoYg.js`; callable
`approvefinalaccount-00003-jad` (both unchanged since the 22–23 November
records). Isolated company only. Every commercial write went through the
application (TEST Company Admin on `constrapp-69b5d.web.app`; QS, then Project
Manager, on `constrapp-69b5d.firebaseapp.com`; session uid verified in the page
before each role's tests). No Admin SDK write; nothing written to Apex Builders,
Projects A–C or fixtures X / Y. Full record: TESTING.md §62c.

**Reused, not repeated.** F3, F4, F7–F13, F17 and R1–R4 (22 November, sandbox
`oeqHCgEM…`); the print rules observed in the live page (22 November); P20 —
`finalAccounts` unreadable to both external roles (B2a, B2b); the Rules suite
(81 tests) and the approval emulator suite (65+ tests) for contention, forged
drafts and concurrency, which a browser cannot reach.

**Dedicated fixture Z (retained).** `5hmVvUCoOIEPrzdeowYK` — *TEST USD-1 — Final
Account acceptance*, **USD**, Planning. USD rather than NZD so the NZD group
stays exactly X + Y (26.00%) as a Portfolio regression fixture; the AUD group is
untouched. Records: baseline OCV 120,000; budget line CT-100 90,000; approved
budget version 1 (`MCZAWTGUppOCDpnZOgUJ`); supplier contact
`b7k4hVAvbJoLEIVuDE1F` (*TEST Supplier (synthetic, not a real company)*);
PO-0001 `SeVdS0hBqDVP1MdqltyC` Sent, one CT-100 line 84,321.50 ex-GST (gross
92,753.65); SI-0001 `ErpD5Uu0oRNFLYNXl2fF` *C1A-TEST-USD-INV-1* Posted,
84,321.50 + GST 8,432.15 = 92,753.65, no retention; forecast CT-100 saved 0.
No claim, credit note, variation, client invoice, receipt, payment, retention
release or budget adjustment.

**Independent expectations** (Python `Decimal` over the stored records read by
REST — baseline, approval snapshot, PO, posted invoice, forecast line; figure
definitions from `lib/finalAccount.js`):

| Figure | Expected | Stored rev 2 | Screen (approved) | Reports tab | Portfolio row | CSV | Native PDF |
|---|---|---|---|---|---|---|---|
| Original contract sum | 120,000.00 | 120000 | ✓ | ✓ | — | ✓ | ✓ |
| Approved client variations | 0.00 | 0 | ✓ | ✓ | — | ✓ | ✓ |
| Final adjusted contract sum | 120,000.00 | 120000 | ✓ | ✓ (*Current contract sum*) | ✓ | ✓ | ✓ |
| Invoiced to client / remaining to invoice | 0.00 / 120,000.00 | 0 / 120000 | ✓ | — | — | ✓ | ✓ |
| Approved budget | 90,000.00 | 90000 | ✓ | ✓ | ✓ | ✓ | ✓ |
| Approved supplier variations | 0.00 | 0 | ✓ | ✓ | — | ✓ | ✓ |
| Actual cost | 84,321.50 | 84321.5 | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cost to complete | 0.00 (commitment 84,321.50 − invoiced 84,321.50, + uncommitted 0) | 0 | ✓ | ✓ | ✓ (*Rem. committed* 0) | ✓ | ✓ |
| Final cost | 84,321.50 | 84321.5 | ✓ | ✓ (*Forecast final cost*) | ✓ | ✓ | ✓ |
| Variance to budget | 5,678.50 | 5678.5 | ✓ | ✓ | ✓ | ✓ | ✓ |
| Final gross profit | 35,678.50 | 35678.5 | ✓ | ✓ (*Forecast*) | ✓ | ✓ | ✓ |
| Final margin | 29.732083…% → **29.73** by `marginPercent` (2 dp) | 29.73 | 29.7% | 29.7% | 29.7% | 29.73 | 29.7% |
| Client gross figures (invoiced, received, outstanding, cash received, unallocated) | 0.00 each | 0 | ✓ | ✓ (cash, outstanding) | ✓ (receivables) | ✓ | ✓ |
| Cash paid / unallocated supplier payments / retention held | 0.00 each | 0 | ✓ | ✓ (cash paid) | — | ✓ | ✓ |
| Supplier invoices unpaid | 92,753.65 | 92753.65 | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cost-code row CT-100 (budget / actual / variance) | 90,000.00 / 84,321.50 / 5,678.50 | same | ✓ | ✓ | — | ✓ | ✓ |

All 22 stored figures equal the expectations in whole cents (margin at the
implemented 2-decimal rounding). *Forecast* and *final* figures are the same
numbers here by construction — approval requires cost to complete = 0, so
final cost = actual cost; the difference is the label and that revision 2 is
frozen while the Reports tab and Portfolio stay live. The Portfolio NZD group
read 250,000 / 180,000 / 185,000 / −5,000 / 65,000 / 26% and the AUD group
3 projects *Incomplete* — both as recorded in B5.

| # | Result | Evidence |
|---|---|---|
| F5 — QS opens the draft | **PASS** | QS session `PvzTgu…` (*Zac · QS / Office*) on draft revision 1 (prepared by the Company Admin): no *Approve*, no *Withdraw draft* (not the preparer), no Export / Print; *Approval is by a Company Admin or Project Manager.* shown. Beyond the hidden control: the callable called as the QS with a real App Check token → `permission-denied` / `not-approver` (twice — another user's draft and the QS's own; log *final account call refused*, HTTP 403); seven direct writes denied by Rules (below) |
| F6 — second user prepares another draft | **PASS** | QS opened *Prepare* while no draft existed; the Company Admin then prepared revision 1 (10:29:38); the QS's still-open dialog (now titled *Revision 2*) submitted → *A draft revision is already open. Approve or withdraw it before preparing another.* — refused by the action's fresh server read. One document only. Rules level: a forged `finalAccounts/2` with a complete valid draft shape → `permission-denied` for the QS and the Company Admin while revision 1 was open; the same shape was accepted through the app once revision 1 was withdrawn (positive control) |
| F15 — `updateDoc(finalAccounts/N, { status: 'approved' })` as Company Admin | **PASS** | `oOANhA…` on draft revision 1 → `permission-denied`. Also denied: a complete forged approval (stamps, approver, revision + 1), editing a draft figure, delete, a second draft, creating an `approved` document directly. Revision 1 unchanged (`updateTime` = its create time until the real withdrawal) |
| Project Manager approval | **PASS** | Revision 2 prepared by the QS (10:32:46), approved by `KSC9zf…` (*Drdre · Project Manager*) through the app at 10:43:11. *Approve revision* disabled until the acknowledgement was ticked; no self-approval note. Stored: `approvedBy` = PM uid, `approvedByRole` `project_manager`, `selfApproved` false, `createdBy` = QS uid, `approvedAt` 10:43:11.437, `sourcesReadAt` 10:43:11.109, `revision` 2, figures = expectations. One audit event `LIjIrpnKz00G6rDyiqeH` `final_account.approved` (actor = PM, `source: callable`, before draft / 1, after approved / 2, contract 120,000, cost 84,321.50, budget approval id) — same commit time as the revision (10:43:11.461357Z); audit events 43 → 44. Log: *final account approval* `replay: false`, `attempts: 1`, HTTP 200 |
| — before approval, as PM | **PASS** | Direct `status: 'approved'`, complete forged approval, figure edit, delete → `permission-denied` ×4: the Project Manager can approve only through the callable |
| — repeated approval | **PASS** | Same request again as the PM → `alreadyApproved: true`, revision still 2, no second audit event, document `updateTime` unchanged (log `replay: true`). `expectedRevision: 2` → `final-account-not-draft`; the withdrawn revision 1 → `final-account-not-draft`; a request carrying an amount key → `invalid-argument`; another company's project id → `not-found` (looked up under the caller's company only — no Apex read) |
| — protection after approval | **PASS** | As the PM, on approved revision 2: figure edit, withdraw, back to draft, change approver name, delete → `permission-denied` ×5; on withdrawn revision 1: reopen, delete → denied ×2. Revision 2 SHA-256(fields) `74cc8f7a0f0a78a3…`, `updateTime` 10:43:11.461357Z before and after. UI: no Approve or Withdraw on an approved revision |
| F14 — native print / PDF | **PASS** (two cosmetic observations) | Product Owner clicked *Print / Save as PDF* in the TEST admin tab and saved from Chrome's dialog with nothing changed. File: Chrome 157 / Skia PDF, **3 pages, A4 landscape** (841.92 × 594.96 pt), text (no raster image — not a screenshot). Project, revision, *Approved* / *Current*, currency USD, disclaimer (header and footnote), prepared / basis / reference / budget source / approved (time · approver) / records read, all four figure groups (22 figures) and the cost-code table present and equal to the screen and the expectations; no sidebar, tabs, sub-tabs, buttons, readiness checklist, live position or revision history; white background; right-most amount ends 54 pt inside the page edge — no clipped column. Observations: D3 #22 (a section heading left alone at the foot of page 1), #23 (Chrome's default header / footer prints the page URL). File deleted after checking |
| F16 — deactivated or non-financial account opens the URL | **PARTLY** — no figure: PASS; the notice: NOT RUN in production. **Accepted for closure on this combined evidence (architect, 25 Nov); the browser check is carried forward** | Signed out on the test origin, the Final Account URL → `/login`, no figure; `finalAccounts/2`, the project and the baseline → `permission-denied` (10:33:35). Deactivated: both external test accounts are Auth-disabled (read today) and cannot hold a session; a live session was signed out within ~5 s of deactivation (B2, 24 Nov 00:49). Non-financial: `finalAccounts` → 403 for the subcontractor and the client on assigned projects (B2a, B2b). **Not observed:** the *Final Account is restricted* card for a signed-in non-financial account — unit test only (`finalAccountPage.test.js`); it needs an active external session, and both external accounts stay disabled under this brief |
| R5 (§62b) | **PASS — stored state** (read-only) | Apex sandbox `oeqHCgEM…` read over REST and compared with the 22 November capture: revision 4 withdrawn (17:35:07 UTC, 21 Nov UTC date), forecast 0300 restored to 0 (17:34:46), revisions 1–3 `updateTime` and SHA-256 identical (rev 2 `dbbd94a6…`). The on-screen *all Met* reading was not re-observed in the sandbox (no Apex session is used by tests); the same end state was observed on fixture Z — 19 requirements Met after approval, *Prepare revision 3* enabled |
| Readiness on a new project (not an open item) | Observed | Before the forecast was saved: *Every cost code has a saved forecast — Not met — 1 of 1 not forecast: CT-100…*, *Prepare* disabled; after saving 0: 19 Met |

**Where each control is enforced (production observations, 24 November).**

| Action | Company Admin | Project Manager | QS | Enforced by |
|---|---|---|---|---|
| Read revisions | allowed | allowed | allowed | Rules (`financialMember`); signed out → denied; external roles → 403 (B2a / B2b) |
| Prepare a draft | allowed (rev 1) | not exercised (Rules + unit) | allowed (rev 2) | Rules `draftValid`; one open draft: action server read + Rules |
| Withdraw a draft | allowed (own, rev 1) | control shown (not used) | another user's: no control, write denied; own: control shown (not used) | Rules |
| Approve | 22 Nov (sandbox) | **allowed (rev 2)** | no control; callable `not-approver` | Callable only — every direct write to `approved` denied for all three roles |
| Change or delete an approved or withdrawn revision | denied (emulator; draft-stage writes denied today) | **denied** | denied (emulator) | Rules; Admin SDK / console bypass remains (D2) |

24 distinct direct-write shapes denied (QS 7, Company Admin 6, Project Manager
11) and 3 signed-out reads. Probes used the Firebase Web SDK loaded in each
role's own tab on the persisted session — no token was read or exported. The
callable probes carried a reCAPTCHA Enterprise App Check token obtained by the
SDK; a callable request *without* App Check was not tested today. Every
callable answer was 2xx / 4xx — nothing the L3 failure alert counts.

**Writes made (complete list, UTC).** 10:24:08 project + directory entry;
10:25:03 baseline (+ currency lock); 10:25:35 budget line; 10:25:46 budget
approval draft and snapshot; 10:26:05 approval version 1 (header, pointer);
10:26:31 supplier contact; 10:27:02 PO-0001 draft (+ `counters/purchaseOrders`);
10:27:09 Sent; 10:27:35 SI-0001 draft (+ `counters/supplierInvoices`), approved,
10:27:50 Posted; 10:28:23 forecast line; 10:29:38 Final Account revision 1
draft (Company Admin); 10:32:24 withdrawn; 10:32:46 revision 2 draft (QS);
10:43:11 revision 2 approved (callable) + one audit event. The QS was signed
out through the user menu (10:33); the Product Owner signed in as the PM
(10:42:16). No invitation, email, role change, deactivation or Storage write.

**Data integrity (read-only snapshots 10:21–10:23 and 10:50–10:53).** Apex
Builders: 258 of 258 lines identical (no sweep fell in the window; the 09:14
periodic pass is the only change since B5). `users`: identical. Auth: `ct-sub`
and `ct-client` **disabled**; `ct-admin`, `ct-pm`, `ct-qs` enabled; only the
PM's last sign-in time moved. Storage: five fixtures byte-identical (MD5,
metageneration), no token. Test company: 100 → 116 documents — exactly the 16
listed above (project, directory entry, 10 project sub-documents, contact, two
counters, one audit event); Projects A, B, C, X, Y, CT-100, members,
invitations and system documents unchanged. Directory **6 / 6 in sync**.

**Final retained state.** Fixture Z: revision 1 withdrawn, **revision 2
approved and current** (QS-prepared, PM-approved), project Planning; its
contact, PO, invoice and counters retained — do not delete or modify. Portfolio
now reads 6 open projects in three currency groups (USD = Z alone). TEST PM and
QS remain **active**; the testing profile holds the TEST admin (`web.app`) and
the PM (`firebaseapp.com`) sessions; test tabs closed.

**Limits.** F16 notice not observed in production (above). Client invoices,
receipts, payments, retention and variations were exercised at zero only on Z
(non-zero payables only). Production serializable behaviour under contention,
forged-draft refusal by the callable and the 5xx paths remain emulator-only.
The PDF was produced by Chrome on macOS only; no physical print. App Check is
not enforced on Firestore (R-4), so the Rules probes needed no App Check.

### B7. L4 remaining acceptance, Stage A internal regression, W2–W4 and the F16 notice in `constrap-acceptance-test` (24 November 2026 19:00–19:42 UTC, PROD-VERIFIED unless marked)

Full record: [TESTING.md §71](TESTING.md). Sessions: TEST Company Admin on
`constrapp-69b5d.web.app`; Project Manager, then QS, then the external
`subcontractor` on `constrapp-69b5d.firebaseapp.com` (each sign-in by the
Product Owner; every session uid checked in the page before use). Server state
read through the Firestore, Identity Toolkit, Storage and Rules REST APIs with
operator credentials, read-only. Financial expectations computed separately in
exact `Decimal` arithmetic from the stored source records.

| Step | Result | Evidence |
|---|---|---|
| Pre-flight | PASS | `main` `0cf17e6` = `origin/main`; Firestore ruleset `67b6425a…` 236,737 bytes and Storage ruleset `2f3a4788…` 10,323 bytes byte-identical to `main`; `transferboqtobudget-00001-zol`, flag `true`; baseline snapshot 19:00:50 (test company 116 documents, Apex 258). Hosting bundle not re-compared with a build |
| M3 create (Company Admin) | PASS | L4 `gdaYQYRD…` and its directory entry, one commit 19:04:27.399505Z, five equal fields |
| M3 / M7 edit (**Project Manager**) | PASS | Name, status, location, start date, progress; both documents in one commit 19:05:41.228204Z |
| Drawing and Quant measurement (Project Manager) | PASS | TL4-001 rev A 19:07:31; calibration 19:08:29 (0.02 m per page unit); area 19:08:58 — expected 96.006026459 → 96.006 m²; project still unlocked |
| W2, M8 (Project Manager) | PASS | Z: Budget, Purchase Orders, Commercial Report, Final Account, GANTT; Portfolio — figures, nothing *Unavailable* |
| M5, M8 (Company Admin) | PASS / pin NOT RUN | Company Settings loads (7 projects, each with a stored currency; nothing to pin; nothing saved); GANTT, Commercial Report, Final Account, Portfolio open |
| M4 (QS) — list, no create, no edit | PASS | 7 projects, no *Edit*; UI create refused (*Missing or insufficient permissions.*); Rules: paired create, paired edit, single edit → `permission-denied` (QS session, Web SDK), read control OK |
| M4 (QS) — currency lock | PASS (BOQ item, not a budget line) | Item 1.1 and `currencyLocked` true in one commit 19:19:08.545102Z; directory entry untouched |
| T16 — apply a Quant quantity (QS) | PASS | Link 19:20:49; apply 19:21:12: 90 → 96.006 m2, 11,110.50 → 11,851.94 |
| Transfer (QS) | PASS | Create 12,545.94, audit `PjdCFrfO…`, 19:21:57.735005Z |
| **T9 — stale review** | **PASS** | Held 19:23:57.014; admin edit committed 19:24:04.986673Z; released 19:24:07.579; server 400 `boq-transfer-stale-review`; dialog stale message, tick cleared; line and audit count (45) unchanged |
| Transfer after re-review (QS) | PASS | Refresh 12,545.94 → 12,565.34, audit `MKAfTZs7…`, 19:25:15.179408Z |
| Budget approval authority | PASS | QS capture 19:25:46; QS has no *Approve*; QS approve transaction → `permission-denied` (19:26:34); Company Admin approval as version 1, header and pointer in one commit 19:27:04.182849Z |
| W3 (QS) | PASS | Forecast line saved 19:27:40.108739Z |
| W2, M8 (QS) | PASS | L4: Budget, Purchase Orders, Commercial Report (approved 12,565.34, FFC 12,000.00, variance 565.34), GANTT; Z Final Account; Portfolio (GBP row equal; NZD 26%) |
| External provisioning | PASS | Dry run 19:29:40 (snapshot identical); `--apply --no-link` 19:30:41 → invitation `Ex7dAVpl…` + `invite.created` + lock, nothing else; *Resend* 19:31:57 (`sendCount` 1, `deliveredVia` email); account re-enabled at preview 19:32:23; accepted 19:35:13 — same uid, `subcontractor`, `[Z, L4]` |
| **T14** (`subcontractor`) | **PASS** | Projects lists Z and L4 only; L4 tabs Overview, Documents; `/boq` *The BOQ is restricted*; 3 reads allowed, 18 denied (list in §71); callable 403 `boq-transfer-forbidden` 19:39:04 |
| **W4** | **PASS** | Restricted notices on BOQ, Reports, Forecast, Commercial, Final Account, Portfolio; no figure anywhere; Budget and Purchase Orders show no figure and no notice (D3 #27, #28) |
| **F16 notice** | **PASS — OBSERVED** | Z `/commercial/final-account`: *Final Account is restricted*; no figure, no button; `finalAccounts` denied |
| Deactivation ×3 (Team page) | PASS | 19:40:05, 19:40:28, 19:40:48; Auth disabled, tokens revoked; 9 audit events; sweep seq 19 at 19:41:02 (scanned 6, removed 1, failed 0); the subcontractor's open session signed out within 5 s |
| Reconciliation (report only) | PASS | No inconsistencies — company and whole project; directory dry run 17 / 17 in sync |
| Integrity | PASS | Apex 258 documents identical; A, B, C, X, Y, Z untouched; five Storage fixtures identical and token-free; NZD margin 26%; Z revision 2 agrees with current records; 32 new test-company documents, all accounted for (§71) |

**Evidence by layer.** *UI:* what the application showed each role. *Rules:*
reads and writes sent with the Firebase Web SDK from the member's own signed-in
tab (no Admin SDK, no token handled). *Callable:* the transfer function's HTTP
answers (200, 400, 200, 403) in its Cloud Run log, and its typed error codes
received in the browser. *Emulator only:* the `client` half of T14 at callable
level, the M5 currency pin, contention and 5xx paths.

**Reused, not repeated.** L4 T1–T8, T10–T13, T15 (simulated) and the T16
double-click (22 Nov, §67); external X1–X7 and P1–P14 (23–24 Nov, B2); Portfolio
P7 / P18 (B5); Final Account F1–F15, F17 (B6); M6 (23 Nov).

**Architect decision (25 Nov 2026 — REPORTED).** GO. L4 acceptance **CLOSED
with the limits below**; Stage A regression **CLOSED within its applicable
scope**; T14 as `client` accepted on existing production and emulator evidence;
M1, M2 and the stale-bundle part of M7 **superseded**; the M4 BOQ-item lock
variant accepted, the budget-line variant not run; the M5 pin emulator-only;
T15 not executed; the F16 notice observed; W2–W4 accepted with UI findings;
D3 #27–#29 → P2 external-role UI correction bundle. Fixtures retained; the
Project Manager, QS and external accounts stay deactivated.

**D3 #28 inspection (25 Nov 2026, repository and local emulator only).** An
external role cannot create a purchase order: `firestore.rules` `purchaseOrders`
`allow create` (line 988) requires `financialMember(companyId)` — an allow-list
of the three internal roles (lines 21–26); `projectIds` is not consulted. Proven
by `purchaseOrders.rules.test.js` (*subcontractor and client can neither read
nor write*) and `externalRoles.rules.test.js` (an **assigned** subcontractor and
client *still CANNOT create a purchaseOrders document*, with a payload the
financial roles create successfully); 12 selected cases re-run PASS. EMULATOR
for the create; PROD-VERIFIED for the ruleset identity and the read denial. A
production create was not attempted. **Not an authorisation defect; a P2
display and gating defect.** Detail: TESTING.md §71.

**Limits (stand after closure).** Token replay after deactivation not tested
(only the session sign-out was observed); the Hosting bundle not re-compared
with a build. T14 as `client` not re-run (Product Owner decision — one
reactivation); no real disconnection; M5 pin and the M4 budget-line variant not
run; M1, M2 and the stale-bundle part of M7 were never verified and cannot now
be reproduced; one browser (Chrome, macOS); Apex Storage objects and document
contents beyond update times not compared; client-SDK financial writes leave no
`auditEvents` entry.


### B8. C1-C — GANTT production acceptance in `constrap-acceptance-test` (24 November 2026 20:30–21:16 UTC, PROD-VERIFIED unless marked) — functional acceptance CLOSED

**Architect decision (25 Nov 2026 — REPORTED).** GO — C1-C **functional acceptance CLOSED** and Git integration authorised. Scheduling, dependencies, baseline management, revision protection, variance calculations and downstream consistency accepted; existing role evidence (§71 M8, emulator) accepted — no account to be reactivated. **Carried forward, tracked and not passed:** native print / PDF R1–R13; Safari and Firefox; Day / Month chart visuals; the dashed baseline outlines; the individual attention-filter checks; overnight G11; offline capture; the stale quick-action and stale cancellation scenarios. D3 #30, #31 → P3 deferred UX corrections. Deferred Control 23 retained as a data-integrity hardening requirement before customer readiness (D1 R-7). The unintended invalid-date write and its correction stay in this history; the final fixture state was re-read and holds only valid dates. **Future negative production probes must first verify the expected enforcement mechanism** (Rules text, Deferred Controls, the existing Rules test). The browser-isolation deviation is recorded in section A.

Full record: [TESTING.md §72](TESTING.md). One session — the TEST Company
Admin (`oOANhA…`, uid checked in the page) on `app.constrap.com`, in two tabs
for the concurrency checks. Server state read through the Firestore, Identity
Toolkit, Storage, Rules and Hosting REST APIs with operator credentials,
read-only. Expectations from a separate Python standard-library date model
fed with the stored records, computed before each surface was read.

| Step | Result | Evidence |
|---|---|---|
| Pre-flight | PASS | `main` `8b8c3e5` = `origin/main`; Firestore `67b6425a…` and Storage `2f3a4788…` byte-identical to `main`; **Hosting `index-BOg2hoYg.js` / `index-CAs65qiC.css` SHA-256-identical to a clean build of `main`**; no GANTT source change since `9ce433d` — GANTT 1A1, 1A2, 1B, PULSE 1C, ADR-79 deployed. Unit 101 files / 5,244 PASS |
| Scheduling (§40–§41) | PASS | Durations (inclusive, calendar days, across a month end), earliest starts incl. lag 2 and the milestone same-day rule, boundary starts with no conflict, conflict + acknowledgement (refused without it), cycle candidates = exactly the five transitive successors, overdue / blocked / due-soon counts — all equal to the model |
| Server refusals | PASS | 22 SDK writes from the session refused by the deployed Rules (blind / skipped revision, finish < start, `SS`, lag −1 / 366, self / missing predecessor, progress 101, not-started at 50%, delete; approve a withdrawn baseline; rename / withdraw / delete an approved header; edit / delete a snapshot; header or snapshot alone; edit / reopen a cancelled activity; forged cancellation). Nothing created |
| Revision guard | PASS | Stale save refused (*Someone else changed this activity…*), nothing written, edits kept; *Reload latest* then save → revision 3 holding both edits. Same account in two tabs |
| Baselines (§42) | PASS | Capture (header + snapshot one commit, 9 entries = programme), self-approval shown, approval stamps, snapshot hash constant; variance (T08 +6, M01 −3, T01 completion +2, added, cancelled), envelope +7 / +11, early / unchanged / later counts; drift (*Edited*, *Added*, *Cancelled since capture*) and the refused approval after a further change; re-baselining (B2 Active, A Original); historical comparison; withdrawal with and without a reason; invalid programme refused at capture |
| PULSE parity (§43, G2) | PASS | Overdue, blocked, dependency review (3 links / 3 activities) and later-than-baseline (T08, 6 days) equal to GANTT and to the model |
| Export / downstream | PASS | CSV captured in memory (no file saved): every row equal to the records and the model, 0 empty cells, no write. Dashboard Programme panel equal. Overview and Portfolio carry no programme figure (not built). Portfolio: CAD own group; NZD 26%, GBP 12,565.34 |
| Print / PDF; QS / external programme session; Safari / Firefox | NOT RUN | Print dialog blocks automation; roles rest on §71 M8 (PROD) and 5 Rules files / 445 tests (EMULATOR) |
| Integrity | PASS | Apex 258 documents identical; test company 148 → 167, the 19 additions all the fixture's; no existing document changed; no audit event; Storage, users and the four disabled accounts unchanged; Z revision 2 hash `74cc8f7a…` equals C1-A; L4 *ALL CHECKS OK* |

**Unintended write (engineer error).** One probe set T08's planned start to
`2026-02-30`, expecting a refusal; the Rules accept a valid-shaped impossible
date — documented Deferred Control 23, proven by an existing Rules test — so
this is not a new defect. Confined to the fixture, used for the §42 check 3
evidence, then corrected through the editor (T08 revision 3).

**Findings.** D3 #30, #31 (P3). **Limits.** As listed under *Still not
covered* in §72; Apex compared by path and update time only.

### B9. C1-D — Monitoring and alert delivery acceptance (24 November 2026 21:56–22:36 UTC, PROD-VERIFIED unless marked) — **CLOSED**

**Architect decision (25 November 2026 — REPORTED).** GO — **C1-D is CLOSED** and integration is authorised. D1–D7 accepted; the Product Owner's opening and recovery notifications confirmed; natural incident recovery verified; the repository uptime-policy correction and the strengthened configuration test approved; all temporary resources removed and the permanent production policies unchanged. **Evidence limitations (stand after closure):** the billing-administrator channel was not tested in this run; exact email arrival times are unknown; not every permanent policy has fired on its intended condition (only policy B, once); the permanent policies' recovery-notification behaviour is unverified; receipt of policy B's 17 November email is unverified; observed timings are not service levels. **Monitoring requirements retained for operational hardening and customer readiness:** a `transferBoqToBudget` failure alert; callable errors without a 5xx; membership-reconciliation monitoring; backup monitoring; billing-outage monitoring; independent notification paths. **Next milestone: L3 Stage 2 E1–E10 remaining acceptance.**

*Heading as written at the run:* … — RUN, awaiting architect review

Full record: [TESTING.md §73](TESTING.md); DEPLOYMENT.md → *L3 Stage 1* →
*C1-D alert delivery acceptance record*. Operator: the Product Owner's
gcloud account. Approved production mutations: create and delete one
temporary alert policy. Nothing else changed. No browser session was used.

| Check | Result | Evidence |
|---|---|---|
| D1 inventory | PASS — 5 policies enabled; 2 email channels unmodified since 16 Nov; 1 uptime check; 1 log metric; 0 open incidents | PROD-VERIFIED |
| D2 parity | PASS after correction. L3 availability policy created with a check-id filter and `resource.label.*` grouping: same series over its whole history, intended meaning. File and test aligned; live policy unchanged | PROD-VERIFIED; audit log |
| D3 incident | PASS — heartbeat 22:24:03; incident `0.ofehms6qj26w` opened 22:29:20 | PROD-VERIFIED |
| D4 delivery | PASS, Product Owner channel — opening email by 11:32 NZDT | **REPORTED** (arrival time and incident id not visible) |
| D5 recovery | PASS — natural recovery and closure 22:33:35; recovery email by 11:34 NZDT | PROD-VERIFIED / **REPORTED** |
| D6 clean-up | PASS — deleted 22:34:58 (26 min after creation); five policies byte-identical to before; channels unchanged; no open incident; audit log shows only the create and the delete; worker 59/59, Scheduler `ENABLED`; no business-data mutation | PROD-VERIFIED |
| D7 documents | Done (this revision) | — |
| Historical | Policy B's real incident on 17 Nov 19:18:06 → 18 Nov 19:22:24 (the predicted activation overdue line). Receipt not recorded | PROD-VERIFIED |

**Limits.**
- The billing-administrator channel was not used; it was unavailable, as the
  approval required.
- Exact email arrival times are not known.
- No production policy has fired on a real failure.
- Behaviour during a billing suspension is untested.
- Resolved emails from the permanent policies are not established.

**Gaps retained** (operational hardening and customer readiness; no policy
added):
- a `transferBoqToBudget` failure alert;
- callable errors without a 5xx;
- membership-reconciliation monitoring;
- backup monitoring;
- billing-outage monitoring;
- independent notification paths.

### B10. L3 Stage 2 E1–E10, GST boundary hotfix and Premium Dashboard v2 — consolidated regression acceptance (25 November 2026 00:32–01:08 UTC) — E1 and E3–E10 ACCEPTED with evidence limitations; **E2 OPEN (D3 #32) — L3 NOT closed** (Lead Architect, 25 Nov 2026 — REPORTED)

*Heading as written at the run:* … — RUN, awaiting architect review

Full record: [TESTING.md §74](TESTING.md). Baseline `main` `875910e`.
Production access was read-only throughout: REST with the operator's login,
and the TEST Company Admin's browser session on `constrapp-69b5d.web.app`.
Offline, refused-write and write steps ran on **local emulators** (class
EMULATOR below; TESTING.md §74 calls it LOCAL).

| Check | Result | Class | Evidence |
|---|---|---|---|
| Live Hosting bundle = build of `main` `875910e` (three origins) | PASS | PROD-VERIFIED | SHA-256 `5bf43ffc…ef4e`; §74.1 |
| Live Firestore and Storage rulesets = repository | PASS | PROD-VERIFIED | `67b6425a…` 236,737 bytes; `2f3a4788…` 10,323 bytes |
| GST hotfix, Dashboard v2 and L3 Stage 2 deployed | PASS | PROD-VERIFIED (content identity + Git ancestry) | §74.1. Original release dates of the first two still unrecorded |
| L3 E1 | PASS | PROD-VERIFIED | Project opens with 18 tabs; unknown id → *Project not found.* |
| L3 E2 | **NOT PASSED as written** | EMULATOR; public Hosting observation | Offline reload never loads the page; backend unreachable at load → false *No active membership* (D3 #32); designed *Waiting for the server* state PASS under injection |
| L3 E3 | PASS (refused read) | EMULATOR | Notice with *Try again*; recovers after access is restored. *Could not be loaded* variant unit-only |
| L3 E4, E5, E6, E7, E7a, E7b, E7c | PASS | EMULATOR | One record per action; guards, notices and timings as specified (15.2 s to *Waiting for confirmation…*); no React or unhandled-promise error |
| L3 E8 | PASS | EMULATOR | Double-click on a create and on *Issue*: one write, one record |
| L3 E9 | PASS (simulated) | EMULATOR | Refused create and post: red *…Nothing was saved.*; no SDK text |
| L3 E10 | PASS | EMULATOR | Client invoice create / issue / void; supplier payment create / post / void; figures equal independent arithmetic |
| GST: fixture Z stored figures | PASS | PROD-VERIFIED | 84,321.50 + 8,432.15 = 92,753.65; not a boundary amount |
| GST: app rounding, `gstPinned`, release delta, apportionment | PASS | Independent arithmetic (EMULATOR class — no production) | 10,000,001 amounts; 2,000,000 release pairs; 20,000 apportionments; §74.4 |
| GST: §44 manual acceptance 1–3 | **NOT RUN** | — | Needs new financial records; minimum scope in §74.4 |
| Dashboard v2: portfolio counts | PASS | PROD-VERIFIED | Active 1, total 8, Planning 7, In Progress 1 |
| Dashboard v2: snapshot figures, GBP-1, USD-1, NZD-1, NZD-2, CAD-1, A | PASS to the displayed unit | PROD-VERIFIED | Independent `Decimal` expectations from raw records; §74.5 |
| Dashboard v2: programme panel, CAD-1 | PASS | PROD-VERIFIED | Equal to the 11 activity documents for 25 Nov 2026 |
| Dashboard v2: switching, reload | PASS | PROD-VERIFIED | No stale figure or currency in any sampled frame; selection kept |
| Dashboard v2: §22 check 2 (external roles, first-load "—"), check 3 (layout), throttling, a failed source | **NOT RUN** | UNIT only | Test identities deactivated |
| Automated suites | PASS | EMULATOR | Unit 101 / 5,244; Rules 39 / 2,492; Functions pure 8 / 179; lint clean |
| Integrity: test company, Apex, users, Auth, Final Account Z, Storage, monitoring | Unchanged | PROD-VERIFIED (update times and selected fields — not bytes) | §74.6. Only differences: the worker's own state document (00:27:02, before the run) and the TEST admin's last sign-in |

**Evidence reused, not repeated:** C1-A (cent-level figures of fixture Z,
§62c); C1-B (NZD fixtures and the 26.00% weighted margin, §63); L4 / Stage A
(GBP fixture, §71); C1-C (CAD programme, §72); C1-D (alert delivery, §73 —
no alert test was repeated; limitations of B9 stand).

**Limitations.** E2–E10 were not executed in production. The local run used
the development build of the deployed source, one browser (Chrome 158,
headless) and simulated failures. The false membership notice (D3 #32) was
not observed in production with a session. No production record exercises a
half-cent GST boundary or a claim-sourced invoice.

**Browser-isolation event.** The testing tab on `web.app` opened in the
Product Owner's personal Apex Builders session (one read-only Dashboard
load; nothing clicked or written). The Product Owner replaced it with the
TEST Company Admin; the uid was checked in the page before any step
(§74.6). **Origin rule clarified by this event:** check the session uid on
*any* origin before the first action — an origin's designated use does not
guarantee which account it holds.

**Architect decision (25 November 2026 — REPORTED).** **GO for documentation
integration. NO-GO for full L3 closure.**

| Subject | Decision | What stays open (not passed) |
|---|---|---|
| L3 E1, E3–E10 | **Accepted** with their actual evidence classes and limitations — E1 production; E3–E10 local emulators only, one browser, simulated failures | Nothing was executed in production for E3–E10; that limit stands |
| L3 E2 | **OPEN** against D3 #32 | E2, after the #32 correction and a corrected procedure (#34) |
| GST boundary hotfix | Deployment verified; **calculation compatibility accepted** | §44 manual steps 1–3 — outstanding, retained for the relevant financial implementation milestone |
| Premium Dashboard v2 | Deployment verified; **tested financial calculations accepted** | §22 checks 2 and 3 |
| D3 #32 | **P2 — next implementation task.** Correct the membership-state handling **without weakening authorisation** | — |
| D3 #33 | **P3 — deferred** UX correction | — |
| D3 #34 | Correct the E2 procedure **alongside #32** | — |
| Scope limit | **No service worker and no PWA** in the upcoming correction | — |
| Financial precision | The half-cent GST rounding discrepancy is kept as an explicit concern (**D3 #35**); an assessment of rounding semantics is tracked before client credit notes and client retention; **no calculation and no historical financial record changes now** | The assessment |
| Order | 1 D3 #32 membership reliability fix → 2 L3 E2 corrected acceptance → 3 client credit-note architecture assessment and ADR → 4 Firestore Rules capacity assessment and any necessary capacity recovery → 5 client credit-note implementation → 6 client retention | Estimating, approval segregation and the rest of the approved commercial roadmap are preserved |

No unexecuted test is marked passed by this decision. The data-integrity
comparison limits (update times and selected fields, not bytes; root
collections other than `users` and the two companies not compared), the
browser-isolation event above, the retained regression fixtures, the
deactivated test identities and the external-onboarding restriction all
stand as recorded.

### B11. D3 #32 — membership resolution correction, and the corrected E2 procedure (D3 #34) — `fix/membership-resolution-state` (25 November 2026, local runs 03:05–03:30 UTC) — **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**

Full record: TESTING.md §75. Uncommitted; awaiting architect review.
**Local emulators and unit tests only — nothing run against production.**

| Item | Result | Class | Note |
|---|---|---|---|
| Reproduction on `main`'s source | Reproduced | LOCAL | A seeded Company Admin, backend blocked at load: *No active membership* for the 25 s observed; recovered 4.3 s after the block was removed |
| Root cause | Established | MEASURED; code | The SDK answers from its empty cache (`exists: false`, `fromCache: true`) at once; the provider did not read the metadata; the gate read a settled null profile as no membership (TESTING.md §75.1, §75.2) |
| Correction | Implemented | — | Only a server-confirmed snapshot decides membership (`lib/team.js → foldProfileReport`); the listener asks for metadata changes; gate states *waiting* and *refused* added; *Try again* replaces *Reload*. Three source files |
| Regression test | **PASS**; fails on `main`'s source | UNIT | `membershipResolution.test.js` — `expected 'none' not to be 'none'` against the original |
| Unit suite | **PASS** — 103 files, **5,336** tests (after the release preflight; 5,333 after the architect corrections; 5,315 at the first report) | UNIT | 89 new tests in two files |
| Role validation (architect correction) | **PASS** | UNIT; LOCAL | Six documented roles admitted, with and without a status; missing, null, empty, unknown and non-string roles and a non-string `companyId` are *invalid* — no shell, no sign-out; live invalidation and recovery; invitation acceptance and reactivation unchanged (TESTING.md §75.10) |
| Production membership inventory | **0 profiles newly restricted** | PROD-VERIFIED (read-only, aggregates) | 9 profiles: 3 valid active (`company_admin`; 2 legacy), 6 deactivated, 0 malformed role, `companyId` or status (TESTING.md §75.11) |
| Malformed `companyId` **string** | **Gap found and corrected** | MEASURED; UNIT | `a/b` threw; `c1/` resolved to `companies/c1`; `a/b/c` to a nested document. `profileCompanyId` and the gate now apply the existing id contract (`ID_RE`) |
| Malformed `companyId` above the gate | **Fault found and corrected** | LOCAL; UNIT | A numeric `companyId` threw inside `CompanyProvider` and showed the application error screen; the provider now takes its target from `profileCompanyId` |
| Rules / Functions suites | **PASS** — Rules 39 files / 2,492; Functions emulator (team-management lifecycle) 11 / 367; Functions pure 8 / 179 | EMULATOR | Unchanged counts; no Rules or Functions file changed |
| E2-A — application loaded, Firestore unreachable before resolution | **PASS** | LOCAL | *Waiting for the server*; never a denial; no protected content; recovery without a reload (4.9–6.2 s). Member, non-member and deactivated accounts |
| E2-B — membership confirmed, then data unavailable | **PASS** | LOCAL | The project route's own waiting state below the gate; an established session through two 21 s TCP cuts with no notice and no sign-out |
| E2-C — full offline hard reload | **Limitation recorded** | LOCAL | The browser's own error page; no service worker. Offline start-up is not supported |
| Deactivation, role change, refused read, identity switch, same-tab re-sign-in | **PASS** | LOCAL | Including deactivation and role change made **while disconnected**, applied on reconnection |
| L3 uncertain write (E5) through a real disconnection | **PASS** | LOCAL | Uncertain message; nothing written; after reconnection exactly one draft |
| Lint, production build, `git diff --check` | clean / succeeds / clean | — | — |

**Invariants (client-side presentation; the Rules are the boundary and are unchanged).**
No shell before a server-confirmed active profile. A cache-only missing
document is not a denial. Nothing carries over from another uid or an earlier
sign-in. A cached profile never overrides a server-confirmed deactivation. A
refused read is not an authorised state. Nobody is signed out for being
offline.

**Observations and limits.**
- A same-tab sign-out and sign-in, online, shows *Waiting for the server*
  for 22–25 ms before the shell. **ACCEPTED by the Lead Architect; no delay,
  timer or debounce is to be added.**
- The gate now requires a documented role (architect correction). `super_admin`
  is retained as a recognised role, with no added permission (architect,
  26 Nov 2026).
- **Closed by the production inventory (TESTING.md §75.11): no production
  profile has a missing or unsupported role; none is newly restricted.**
  *As written before:* a production profile provisioned by hand with a
  missing or misspelt role would now see the *needs attention* notice.
- `CompanyProvider` and the Dashboard, Projects and Portfolio pages still do
  not read `fromCache` (unchanged; out of scope).
- Not exercised: production, the minified bundle, Safari, Firefox, a mobile
  network, App Check refusal.

**Deployment.** Hosting only. No Rules, Storage Rules, Functions, index,
monitoring, Auth-configuration or data change. Proposed production checks:
TESTING.md §75.9.

**Unchanged by this branch:** Firestore Rules, Storage Rules, Functions
source, monitoring configuration, Firebase Auth configuration, production
data, every financial calculation. D3 #33 and D3 #35 stand as recorded.

### B12. D3 #32 — production verification and L3 Stage 2 closeout (26 November 2026 NZDT; 25 November 20:05–20:50 UTC) — **D3 #32 CLOSED; D3 #34 CLOSED; L3 Stage 2 CLOSED within its accepted scope**

Full record: TESTING.md §76. No production write; no reactivation; no malformed profile created; `app.constrap.com` not opened.

| Item | Result | Class | Note |
|---|---|---|---|
| Release identity | **Verified** | PROD-VERIFIED | Live bundle `index-Cp40Ga_v.js` (SHA-256 `b9101cb1…`) on all three origins = a build of `main` `0bdca38`; Hosting release `edc2bf6f34568d78`, 25 Nov 20:32:18 UTC |
| Rules, Functions, monitoring | **Unchanged** | PROD-VERIFIED | Rulesets `67b6425a…` / `2f3a4788…`, byte-identical to the repository; 11 Cloud Run services, none updated since 23 Nov; 5 policies, 2 channels, 1 uptime check |
| Membership preflight, after the deploy | **0 newly restricted** | PROD-VERIFIED | 9 profiles: 3 admitted, 6 deactivated, 0 malformed; 9 Auth accounts, 6 disabled, every enabled one has a profile |
| Session identity | TEST Company Admin (`oOANhA…`) | PROD-BROWSER | Read before any application page, and again at the end |
| Normal start-up, project access, reload | **PASS** | PROD-BROWSER | No membership notice; 0 console messages on reload |
| E2-A | **PASS** | PROD-BROWSER (injected) | *Waiting for the server* after 0.7 s, held 26 s; no denial; no protected content; 8 requests blocked, 0 passed; the shell 1.8 s after release, no reload |
| E2-B, established session | **PASS** | PROD-BROWSER (injected) | Six open streams aborted, new ones blocked 30 s: no screen change, no sign-out; reconnected 3.4 s after release |
| E2-B, project route waiting state | **PASS** | PROD-BROWSER (injected) | Cut at the projects listener: the route's own *Waiting for the server* (6.0 s and 12.0 s, two runs); shell kept; the project 1.7 s after release |
| E2-C | **Not run in production — limitation stands** | LOCAL | Offline start-up is not supported; 0 service workers registered in production |
| Data integrity | **Unchanged** | PROD-VERIFIED | Before / after: only `system/fileLinkRevocation` (the worker, 20:42:03 UTC); `users` and Auth identical; 111 financial register documents unchanged |

**Evidence limit of the injected checks.** The failure was produced by replacing `fetch` / `XMLHttpRequest` for the Firestore host inside a same-origin frame, before the application script loaded. It shows what the released application does on production data when those requests fail. It is not a real network outage, not a top-level tab, and Chrome only.

**Not exercised in production:** non-member, deactivated, refused-read and invalid-profile paths; role change; identity switch; the uncertain-write path — each needs a write, a reactivation or another account. LOCAL evidence stands (TESTING.md §75.6, §75.10).

---

## C. Remaining tests

### C1. M2-A2 Stage B — P4–P14 ([TESTING.md §69](TESTING.md)) — COMPLETE

**None remaining.** Every §69 step (P1–P14) and the added X4 / X7 PASSED in
production by 24 Nov 2026 00:50 UTC — evidence in B2. Rows below are kept for
reference until TESTING.md §69 records the results.

| ID | Objective | Status | Needs |
|---|---|---|---|
| X7 | Reassign the client to project C (`--add C`): C appears, its records open | **PASS** (24 Nov) — see B2 | Final run |
| P13 | Re-provision the same email as `client` on C only: `[C]`; A denied | **PASS** (24 Nov) — P13a–c in B2 | — |
| P14 | `reconcile-membership.mjs` report: no R7, R8, R9 | **PASS** (24 Nov) — see B2 | — |

### C2. External-role isolation — [TESTING.md §68](TESTING.md) X1–X7 — COMPLETE

| ID | Objective | Status | Covered by |
|---|---|---|---|
| X1 | Subcontractor on A: Projects lists A only; no budget column; no *Add New Project* | **PASS** — subcontractor (23 Nov), client on `[A, B]` (24 Nov) | P6 — B2a; P7 — B2b |
| X2 | Project A: Overview (no budget) and Documents only; files open | **PASS** — both roles; files fetched through Storage Rules (200), not opened in the viewer | P6 — B2a; P7 — B2b |
| X3 | Unassigned project URL → *Project not found*; direct reads of project records and unassigned directory / drawings / files → denied | **PASS** — subcontractor (B unassigned), client (C unassigned) | P6 — B2a; P7 — B2b |
| X4 | Client with no assignment: empty list; every direct read denied | **PASS** (24 Nov) — see B2 | Final run |
| X5 | Assignment removed → project disappears at next read | **PASS** (24 Nov) — B denied ~20 s after removal in the same session; UI updated without a reload | P8 — B2 |
| X6 | §63 P19–P20 | **PASS** — subcontractor (23 Nov) and client (24 Nov) | P6 — B2a; P7 — B2b |

### C3. Portfolio — [TESTING.md §63](TESTING.md) — COMPLETE for closure review (24 Nov: B4 read-only run; B5 P7, P9, P18 in production, P15 locally)

| ID | Objective | Status |
|---|---|---|
| P19 | External user: no Portfolio entry; `/portfolio` restricted; no financial request | **PASS** — subcontractor and client: no entry, restricted message; only the Auth lookup and shared Listen channel seen (bodies not decodable — B2a limits) |
| P20 | External user: direct financial read denied by Rules | **PASS** — subcontractor (24 reads on A → 403) and client (48 reads on A and B → 403) |
| P4 | Row = Reports tab to the cent | **PASS** (24 Nov) — five rows, 55 / 55 figures; CSV = screen (B4) |
| P1–P3, P5, P6, P8, P12, P13, P21, P22 | Page, states, currencies, refresh, CSV, Dashboard, no write | **PASS** (24 Nov, B4); P22 by Monitoring write / delete counts (0) |
| P7 | Hand-checked subtotals and aggregate margin | **PASS** (24 Nov, B5) — NZD fixtures: weighted margin 26.00% (not the 35% mean) against independent expectations; incomplete-budget treatment per spec. *Earlier:* PARTIAL on Apex data (B4) |
| P9 | *Include completed* | **PASS** (24 Nov, B5) — default excludes, counts and subtotals X-only; toggle reads only the completed project; CSV scope follows; status restored |
| P15 | Offline | **PASS — LOCAL ONLY** (24 Nov, B5; emulators + headless Chrome) — not production acceptance |
| P10, P11, P14, P16, P17 | Indicators, links, PDF, widths, keyboard | Not re-run — PROD-REPORTED visual / export acceptance (20 Nov) |
| P18 | Role-specific access (PM / QS) | **PASS** (24 Nov, B5) — Company Admin, PM, QS: identical figures and CSV fingerprint, no mutation control, no console message; Apex project *Project not found* for PM and QS. *Earlier:* BLOCKED in Apex (B4) |
| M1–M5 | Performance | M1 = 10 (Apex; no customer company yet); M2 reused (22 Nov); **M4 = 136 reads per Portfolio read** (isolated Refresh; cold page load incl. shell 291); M3 not measurable as specified (WebChannel; plan 135–136 requests); M5 not measurable cross-origin |

### C4. Remaining acceptance roadmap

Reconciled against TESTING.md, ROADMAP.md and CHATGPT_HANDOVER.md on 24 Nov
2026. Detail and procedures stay in the linked TESTING.md sections. *C1* is
the roadmap's proposed **Core acceptance closeout** (PROPOSED — not
approved); its IDs below are the Lead Architect's.

| ID | Area | Remaining | Already done (do not reopen) | Needs | Record |
|---|---|---|---|---|---|
| C1-A | L2-B Final Account | **CLOSED** (Lead Architect, 25 Nov 2026 — REPORTED; B6). **The carried-forward F16 notice check is DONE — the notice was OBSERVED in production (B7, 24 Nov 19:37 UTC).** *As written at closure:* **Carried forward, not blocking:** the F16 *Final Account is restricted* notice for a signed-in non-financial account — still not observed in production (the property behind it — no figure, Rules denial — is proven); to be checked in the external-role session of L4 T14 / §61 W4. Limits kept: R5 on stored-state evidence only; client invoices, receipts, payments, retention and variations at zero on the accepted Final Accounts; contention, forged-draft refusal by the callable and 5xx paths emulator-only; D3 #10, #22–#26 (deferred bundle) | Positive path F3, F4, F7–F13, F17 (22 Nov); correction retested R1–R4; **24 Nov (B6): F5, F6, F15, Project Manager approval, repeated approval, protection after approval, F14 native PDF, R5** | For the F16 notice only: one active external session on an assigned project — the session L4 T14 also needs | §62, §62b, §62c; B6 |
| C1-B | L2-C Portfolio | **CLOSED** (Lead Architect, 24 Nov 2026 — REPORTED; closeout merged `c236bd9` / `2561344`). *As written:* None blocking — architect closure decision (B5). Limits kept: P15 local only; P10, P11, P14, P16, P17 rest on the REPORTED visual / export acceptance; M3, M5 not measurable; P19 payloads not decoded; REST-level cross-company probe as PM / QS not run. Deferred UX: D3 #9, #19, #20, #21 | Visual, CSV, PDF (REPORTED 20 Nov); P19–P20 PASS for both external roles (24 Nov; payloads not decoded); **read-only run 24 Nov (B4): P1–P6, P8, P12, P13, P21, P22 PASS, P7 partial, P4 five rows to the cent, M1, M4 measured** | — (PM / QS identities and NZD fixtures now exist in the test company) | §63; B4; B5 |
| C1-C | GANTT | **Functional acceptance CLOSED (architect, 25 Nov 2026; B8).** **Carried forward, open:** native print / PDF R1–R13; Safari and Firefox; Day / Month chart visuals; the dashed baseline outlines; the individual attention-filter checks; overnight G11; offline capture; the stale quick-action and stale cancellation scenarios. Role evidence accepted; D3 #30, #31 P3 deferred. *As written at the run:* **RUN 25 Nov 2026 (B8) — awaiting architect review.** Not run, proposed as recorded limits: print / PDF R1–R13; a QS or external session on the programme (emulator + §71 M8); Safari / Firefox; chart visuals at Day / Month zoom, grouping, baseline outlines; attention chips one by one; G11 across midnight; offline capture. Findings D3 #30, #31 (P3). *As written:* Baseline scenarios not exercised in the browser; no per-step record for ADR-79 | 1A1 / 1A2 / 1B / PULSE 1C / ADR-79 live bundle VERIFIED (again 25 Nov — SHA-256 equal to a build of `main`); §40–§42 and the programme parts of §43 / §64 PASSED in production on fixture CAD-1 with independent expectations; 22 server refusals | Architect decision | §72 (§40–§43, §64) |
| C1-D | Monitoring | **CLOSED (Lead Architect, 25 Nov 2026 — REPORTED; B9).** Limits kept: billing-administrator channel not tested in this run; arrival times unknown; not every permanent policy has fired; permanent recovery-notification behaviour and policy B's 17 Nov email receipt unverified; timings not service levels. *As written at the run:* **RUN 24 Nov 2026 UTC — awaiting architect review (B9).** D1–D7 PASS. Temporary heartbeat policy on the Product Owner channel; opened and resolved emails received (REPORTED); natural recovery observed. Not covered: the billing-administrator channel at this run; any policy on its real failure. Gaps retained (B9). *As written:* A notification-delivery test of the L3 alert policies; no alert has fired on a real condition | Policies and uptime check created (VERIFIED read-only 21 Nov); DC46 policy email path REPORTED; policy B's real incident 17–18 Nov (recorded by C1-D) | — (closed) | §65, §73; DEPLOYMENT.md |
| L3 | Stage 2 error recovery | **CLOSED within its accepted scope (26 Nov 2026; B12; TESTING.md §76.6):** E1 in production; E2-A and E2-B in production under in-page transport injection; E3–E10 on local emulators only. E2-C (offline start-up) is a recorded limitation — a future offline-first PWA requirement. *As written before the release:* **Still NOT closed. D3 #32 correction IMPLEMENTED 25 Nov 2026 (B11), pending integration and production verification; E2 rewritten as E2-A / E2-B / E2-C (D3 #34) — E2-A and E2-B PASS on local emulators only, to be run in production after a Hosting deploy.** *As decided before the fix:* **NOT closed (architect, 25 Nov 2026 — REPORTED): E1 and E3–E10 accepted with their evidence classes and limitations; E2 OPEN against D3 #32 (P2, next implementation task).** *As written at the run:* **RUN 25 Nov 2026 (B10) — awaiting architect review.** E1 PASS in production; E3–E10 PASS on local emulators only. **Open: E2** — not passed as written (D3 #32, #34). Not run: any E2–E10 step in production; other browsers; the minified bundle. *As written:* E1–E10 browser acceptance | Deployed — bundle SHA-256-identical to `main` (PROD-VERIFIED 25 Nov). *As written:* Live through the L4 Hosting release (REPORTED) | The D3 #32 correction (own brief; no service worker / PWA; authorisation not weakened), then E2 with the corrected procedure (#34). *As written at the run:* Architect decision; a Hosting-only correction of D3 #32, then a re-run of E2 | §66, §74; B10 |
| L4 | BOQ → budget transfer | **CLOSED with recorded limitations (architect, 25 Nov). B7 (24 Nov): T9 PASS, Quant step of T16 PASS, T14 PASS as `subcontractor`.** Not run, accepted as limits: T14 as `client` in a live session (earlier evidence X1–X3, P20, emulator); a real disconnection. *As written:* T9 server stale refusal; T14 restricted roles; the Quant step of T16; a real disconnection | T1–T8, T10–T13, T15, T16 PASS (22 Nov); UX correction PASS | A forced race; restricted-role sessions | §67 |
| M2-A2 A | Stage A internal regression | **CLOSED within its applicable scope (architect, 25 Nov). B7 (24 Nov): M3 (Project Manager edit), M4, M8 PASS; M6 PASS again; M5 page load PASS.** Not run: the M5 currency pin (emulator-only); M4 with a budget line (the BOQ-item variant accepted). **Superseded, never verified:** M1, M2, the stale-bundle part of M7. *As written:* M1, M2, M4, M5, M7, M8 (M3 run as Company Admin only; M6 PASS) | External X1–X7 PASS | Internal-role sessions | §68 |
| L2-B A | Rules capacity recovery 3 smoke | **None — W2, W3, W4 PASS (B7, 24 Nov), accepted with UI findings D3 #27, #28 (architect, 25 Nov).** *As written:* W2–W4 | Live ruleset byte-identical (VERIFIED 19 Nov) | Financial-role session | §61 |
| Evidence | Production state of the GST hotfix and Dashboard v2 | **Architect, 25 Nov 2026 (REPORTED): deployment verified for both; GST calculation compatibility accepted; Dashboard tested financial calculations accepted. Still open, not passed: GST §44 manual steps 1–3 (retained for the relevant financial implementation milestone); Dashboard §22 checks 2 and 3; the rounding-semantics assessment (D3 #35).** *As written at the run:* **Deployment PROD-VERIFIED 25 Nov 2026 (B10)** — live rulesets byte-identical and live bundle SHA-256-identical to `main`, which contains both. **Remaining:** GST §44 manual acceptance 1–3 (need new financial records — minimum scope in §74.4; not authorised); Dashboard §22 check 2 (external roles, first-load "—") and check 3 (layout). Original release dates unrecorded. *As written:* GST boundary hotfix (merged `ea2eea8`); Premium Dashboard v2 (merged `ba52821`) — production state unconfirmed | Both VERIFIED merged; GST calculations verified by independent arithmetic; Dashboard §22 check 1 PASS in production without throttling (B10) | For GST steps 1–3: the financial implementation milestone that next touches GST, with an authorised synthetic fixture. *As written at the run:* Architect decision on acceptance; for GST steps 1–3 an authorised synthetic fixture | §44, §22, §74; B10 |

**Next (Lead Architect, 25 Nov 2026 — REPORTED): the D3 #32 membership reliability fix, then L3 E2 corrected acceptance.** L3 is not closed. Open C1 rows: C1-C (carried-forward checks only), L3 (E2 only) and *Evidence* (GST §44 steps 1–3, Dashboard §22 checks 2–3, D3 #35 assessment). Decided order of work: D4a. *As written at the run:* **L3 / GST / Dashboard run (25 Nov 2026 NZDT, B10) — awaiting the architect's decision.** Open C1 rows after it: C1-C (carried-forward checks only), L3 (E2 only, against D3 #32) and *Evidence* (the unexecuted GST and Dashboard checks listed in that row). Proposed next step and next commercial milestone: D4. *As written for the C1-D closure revision:* **Next milestone (Lead Architect, 25 Nov 2026): L3 Stage 2 E1–E10 remaining acceptance.** C1-D is **CLOSED** (B9). The remaining open C1 rows are C1-C (carried-forward checks only), L3 and *Evidence*. *As written at the run:* **C1-D run (25 Nov 2026 NZDT, B9) — awaiting the architect's closure decision.** Recommended GO. Proposed next: L3 Stage 2 E1–E10. *As written for the C1-C closure revision:* **Next milestone (Lead Architect, 25 Nov 2026): C1-D — monitoring and alert delivery.** C1-C functional acceptance is **CLOSED** (B8) with its presentation, browser and resilience checks carried forward. The remaining open C1 rows are C1-C (carried-forward checks only), C1-D, L3 and *Evidence*. *As written at the run:* **C1-C run (25 Nov 2026, B8) — awaiting the architect's closure decision.** Recommended next, once decided: **C1-D** (an authorised synthetic trigger for the L3 alert policies), then L3 Stage 2 E1–E10.

*As written for the previous revision —* **Next milestone (Lead Architect, 25 Nov 2026): C1-C GANTT production acceptance.** The L4 / Stage A milestone below is **CLOSED** (B7): L4 with recorded evidence limitations, Stage A within its applicable scope. The remaining open C1 rows are C1-C, C1-D, L3 and *Evidence*.

*As written before the run —* **Next milestone (Lead Architect, 25 Nov 2026):** L4 remaining acceptance (T9,
T14, the Quant step of T16 — row *L4*) and the M2-A2 Stage A internal-role
regression (M3–M5, M7, M8 — row *M2-A2 A*). The external-role session T14
needs also carries the F16 notice check (C1-A) and §61 W4.

**Superseded by B7 (24 Nov 19:42 UTC):** every *Yes* row below except L3 was executed, and the TEST Project Manager, QS and external identities are deactivated again — a further role session needs a new invitation (internal: Team page; external: operator provisioning). The table keeps its wording of 24 November.

**What the retained test identities can serve (assessed 24 Nov, B6 — not executed).**
TEST Company Admin, Project Manager and QS are active in the isolated company;
both external test accounts are disabled.

| Open item | Reusable now? | Note |
|---|---|---|
| M2-A2 A — M3 / M7 (admin creates a project; PM edits name, status, location, start date, progress; directory entry has five equal fields) | **Yes** — Company Admin + PM | A new throw-away project in the test company, or Z's non-financial fields; the stale-bundle part of M7 can no longer be reproduced |
| M2-A2 A — M4 (QS lists every project, cannot create or edit; a budget line engages the currency lock) | **Yes** — QS | The currency-lock step needs an unlocked project (a new one; X, Y, Z are locked) |
| M2-A2 A — M5 (Company Settings loads; currency pin) | **Yes** — Company Admin | The pin step only if the test company is not already pinned |
| M2-A2 A — M8 (Portfolio, Commercial Report, Final Account, GANTT open for the internal roles) | **Yes** — all three | Partly evidenced already: Portfolio for all three (B5), Final Account for all three (B6), Commercial Report as Company Admin (B6); GANTT and the Commercial Report as PM / QS remain |
| M2-A2 A — M1, M2 | No | They describe the transitional release stage (old bundle on Stage-1 Rules), which no longer exists |
| L2-B A — W2, W3 | **Yes** — any internal role | Incidental today as Company Admin on Z (Budget, Purchase Orders and the Commercial Report loaded; a forecast save was accepted) — not recorded as the W-checks |
| L2-B A — W4; L4 — T14 | **No** — need an active `client` or `subcontractor` session | Both external accounts are disabled; one operator re-provisioning + Product Owner sign-in would serve W4, T14 and the F16 notice together |
| L4 — T9 (server stale-review refusal) | **Yes** — Company Admin or PM, with a transfer sandbox in the test company | The browser cannot reach it through the UI; today's method (the callable called from the role's own session with the SDK's App Check token) can send a deliberately stale request |
| L4 — Quant step of T16 | Yes — Company Admin | Needs a drawing with a takeoff in a test-company project |
| L3 Stage 2 — E1–E10 | Yes for the online steps | The offline steps need a controlled disconnection the extension cannot simulate |

---

## D. Remaining implementation

### D1. Security risk register

Tracked items after the M2-A2 closure. **None is newly accepted for a
customer release by that closure**; each still needs its own decision before
real customer external onboarding. Internal roles reading every project of
their company is an **accepted architectural decision** (ADR-83), not an
item here.

| ID | Risk | Category | Status | Evidence | Gate / next step |
|---|---|---|---|---|---|
| R-1 | **Copied download links (DC46).** Any active member can mint a working link for a file it may read with one direct request; it works anonymously until a sweep removes the token (urgent after removal or deactivation — 11–57 s observed, not guaranteed; otherwise the 2-hour periodic pass) | Security | Open — DC46 closed with this as an accepted risk for internal use; not yet decided for external customers | Stage B P9 (PROD-VERIFIED); ADR-74 / ADR-75 | Onboarding readiness decision; DC46 follow-ups (faster revocation) |
| R-2 | **Privileged bypass.** Admin SDK and console writes bypass the Rules, the operator scripts' validation, their audit events and the revocation request | Security / data integrity | Open — inherent; control is production-credential custody | ADR-84 *Operator trust*; reconcile R7–R9 detect shapes only | Credential-custody statement in the readiness decision |
| R-3 | **Withdrawn drawing revisions.** An assigned external member reads every revision of an assigned project's drawings, withdrawn ones included (Firestore and Storage) | Security | Open — documented limitation | ADR-83; SECURITY.md item 46 | Drawing-revision visibility policy (DC46 follow-up) |
| R-4 | **App Check not enforced** on Firestore, Storage or Authentication (callables enforce it) | Security | Open — deferred | DEPLOYMENT.md → *Deferred: general App Check enforcement* | Commercial-readiness milestone |
| R-5 | **Internal regression unrecorded.** TESTING.md §68 M1, M2, M4, M5, M7, M8 | Reliability | **Largely closed by B7 (24 Nov)** — M3, M4, M8 PASS in production with all three internal roles; M5 page load PASS. Residual, **accepted by the architect (25 Nov 2026): M1, M2 and the stale-bundle part of M7 classified superseded** — never verified, not reproducible (the transitional release stage is over); the M5 currency pin and M4 with a budget line rest on the emulator. **CLOSED within the applicable scope.** *As written:* Open — untested, not failed | §68; §71; B7 | None |
| R-6 | **Operator tooling safety.** `bootstrap-company.mjs` wrote by default and printed its acceptance link; four older scripts called `process.exit(1)` after a refused transaction (lock held until timeout) | Operator safety | **MITIGATED — INTEGRATED** (merged as `bc64487`, merge `62e824a`, 24 Nov 2026; Azure `main` green — REPORTED by the Lead Architect; no deployment required). D3 #1–#3, #16, #18 complete. **Not tested against production:** transaction cleanup after a refused production transaction is proven on the emulator only. Remaining: scripts validate, they do not authorise (R-2); a link file proves nothing about the mailbox; local emulators hold the operator's CLI login (D3 #17) | ADR-84 lessons; Stage B S1; TESTING.md §70 (EMULATOR) | None for this item; D3 #17 separately |
| R-7 | **Impossible programme dates (Deferred Control 23).** The `activities` Rules check the date *shape* only, so a valid-shaped impossible date (`2026-02-30`) is accepted by a direct write — reproduced unintentionally in production on the CAD fixture (B8) and corrected; the app degrades safely (no duration, capture refused) | Data integrity | Open — **retained as a hardening requirement before customer readiness** (Lead Architect, 25 Nov 2026) | SECURITY.md item 23; `activities.rules.test.js`; TESTING.md §72 | Customer-readiness hardening (calendar-valid dates server-side, or an accepted risk decision) |

**Decided, not a risk:** a Company Admin may *Resend* or *Revoke* an
operator-created external invitation — permitted under ADR-84 for as long as
neither can change the role or the assignment (Lead Architect, 24 Nov 2026).

### D2. Other data-integrity and lifecycle limits (unchanged by M2-A2)

- Copied download URLs and the 2-hour periodic interval (ADR-75) — see R-1.
- Final Account: an approved revision can be altered by the Admin SDK /
  console; production serializable behaviour proven on the emulator only
  (SECURITY.md item 47). Client-side immutability of approved and withdrawn
  revisions and the callable-only path to `approved` are PROD-VERIFIED for
  all three internal roles (B6, 24 Nov). Creator ≠ approver segregation is
  **not implemented** — self-approval is permitted and labelled; that is a
  documented policy gap for a future approval-segregation implementation
  (Lead Architect, 25 Nov 2026), not a defect.
- Firestore recovery: counts and one hash compared, not every document;
  Storage objects are outside Firestore backups (7-day soft delete only).
- Client-only controls (uniqueness, cumulative caps, some concurrency):
  SECURITY.md → *Deferred Controls*.
- Portfolio P19: the page's Firestore request payloads could not be decoded;
  *no financial request* rests on code and unit tests, *no financial data
  readable* is proven (P20).
- Rules capacity: `firestore.rules` 236,737 of 245,000 bytes; the
  1000-expression ceiling; one project / directory pair per commit.

### D3. Defect and finding register (#1–#3, #16, #18 integrated in `62e824a`; #9 assessed, #19–#21 recorded by C1-B, 24 Nov; #9 and #19 deferred by the architect; #22–#26 recorded by C1-A, 24 Nov, and placed in the deferred UX and reporting correction bundle by the architect, 25 Nov; #27–#29 recorded by the L4 / Stage A run, B7, and triaged P2 into the external-role UI correction bundle by the architect, 25 Nov; #30–#31 recorded by C1-C, B8, and deferred P3 by the architect, 25 Nov; **#32–#34 recorded by the L3 / GST / Dashboard run, B10, 25 Nov — priorities proposed, not yet decided**)

Priority: **P1** before customer external onboarding; **P2** next
convenient milestone; **P3** backlog.

| # | Finding | Category | Status | Priority | Dependency | Proposed milestone | Source |
|---|---|---|---|---|---|---|---|
| 1 | `bootstrap-company.mjs` writes by default (`--dry-run` to preview) | Operator safety | **COMPLETE — INTEGRATED** (`62e824a`) — dry run by default; writes need `--apply` + exactly one delivery option; conflicting flags exit 2; a read-only plan pass precedes every write; a pending invitation is rotated only on `--rotate` (EMULATOR: §70 OT1–OT6) | P1 | — | Operator tooling safety (D5) — done | ADR-84; Stage B S1 |
| 2 | `bootstrap-company.mjs` prints the acceptance link to stdout | Operator safety / security | **COMPLETE — INTEGRATED** (`62e824a`) — never printed; `--no-link` or `--link-file` (new 0600 file, outside the repository on the real path, O_EXCL + O_NOFOLLOW, reserved before any write, verified after creation); a failed write after the commit exits 3, removes the partial file, names the invitation; recovery `--rotate --link-file` (EMULATOR + pure: §70 OT3, OT7–OT9) | P1 | — | Operator tooling safety (D5) — done | ADR-84; Stage B S1 |
| 3 | Four older scripts call `process.exit(1)` after a refused transaction (rollback not awaited → lock held until timeout) | Operator safety / reliability | **COMPLETE — INTEGRATED** (`62e824a`; production cleanup not exercised) — shared `runOperatorScript`: `process.exitCode`, then `Firestore.terminate()` (awaits the rollback), forced exit only after a 30 s shutdown timeout that starts after the operation settled; a failed or timed-out cleanup is printed as an explicit failure, never as success; exit code kept; no retry. Hazard measured (~1 min lock with `process.exit`, none after); sensitivity-checked (EMULATOR + pure: §70 OT10–OT14, runner tests) | P1 | — | Operator tooling safety (D5) — done | ADR-84 |
| 4 | Withdrawn drawing revisions readable by assigned externals (R-3) | Security | Open | P1 (policy decision) | Architect policy | Drawing-revision visibility (DC46 follow-up) | ADR-83 |
| 5 | *+ Add New Project* shown to `qs` (`Projects.jsx:300`; Rules deny the create) | UX | Open | P2 | — | UX fix bundle (Hosting-only) | Stage B R2 |
| 6 | External roles reach `/settings/company` and `/settings/team` from the user menu (read-only notices; country and currency) | UX | Open | P2 | — | UX fix bundle | Stage B P6 |
| 7 | Top bar reads *Dashboard* on `/settings` pages | UX | Open | P3 | — | UX fix bundle | Stage B R1 |
| 8 | No in-app notice when an assignment is removed (project disappears; stale link shows *Project not found*) | UX | Open | P2 | Design | UX fix bundle (needs a design) | Stage B P8 / X5 |
| 9 | Portfolio subtotal count wording: the card counts **excluded** projects (*Not totalled — 5 of 7 projects: 5 budget not approved*, `portfolioReport.js:517`), the table footer counts **included** projects unlabelled (*2 of 7*, `CurrencyGroup.jsx:241`), the CSV gives both (*2 of 7 projects (5 budget not approved)*) | UX — **cosmetic wording only** (re-assessed on the live UI 24 Nov: one `subtotalFor` result; no value shown or exported for an incomplete subtotal; no calculation or reporting-value defect) | Open | P3 — not blocking C1-B; **deferred** (architect) | — | UX fix bundle (Hosting-only). Smallest fix: one wording for both — the card note to `Not totalled — {included} of {total} projects included; {reasons}` (matches the CSV and the function's own comment) and the footer to `{included} of {total} included`; update the two `portfolioSubtotalNote` expectations in `portfolioReport.test.js` (lines 417, 473) | C1-B (22 Nov; B4) |
| 10 | Final Account open draft does not name the missing forecast cost code | UX | Accepted, non-blocking | P3 | — | Backlog | C1-A retest R3 |
| 11 | 58 older write sites keep raw SDK error text and *Saving…* offline | Reliability / UX | Open | P3 | — | Core functionality (ROADMAP) | §66; handover I |
| 12 | Three source comments still say *DC46 — still OPEN* — **one remains** (`frontend/src/hooks/useStorageUpload.jsx:99`, VERIFIED 27 Nov 2026) | Documentation | Open | P3 | Next change in those files | Opportunistic | Handover A |
| 13 | SECURITY.md *Known limitations* still says every Storage object carries its token (superseded by DC46 sweeps) | Documentation | Open | P3 | — | Next SECURITY.md change | Observed 24 Nov |
| 14 | Operator checks must read `custom_fields` for Storage download tokens; zsh needs `${VAR}:method` braces in REST URLs | Operator tooling note | Recorded | — | — | Runbook note | Stage B |
| 15 | Testing-profile sessions are per origin and replaced by any sign-in on that origin; sign-ins in another browser do not reach it | Test procedure | Recorded | — | — | Test procedure | Stage B P5, P13, final |
| 16 | `provision-external-member.mjs --link-file` checks the repository boundary on the typed path; a folder that is a symbolic link into the working tree is not caught (final-component and existing-file checks are sound) | Operator safety | **COMPLETE — INTEGRATED** (`62e824a`) — the hole demonstrated on `main` `2e48a2a` (exit 0, link file created in the repository; emulator); now `_linkFile.mjs` (real path, O_EXCL + O_NOFOLLOW, 0600, reserved before the write); exit 3 on a post-commit delivery failure with Resend recovery; no rotation, no duplicate (EMULATOR: §70 OT15–OT16) | P1 (raised by the architect) | — | Operator tooling safety — done | Operator tooling safety |
| 17 | Emulator credential isolation. **CLOSED 28 Nov 2026 by the Lead Architect (REPORTED) within the verified scope of `test:rules`, `test:functions` and `test:team` only — not universal credential isolation** (TESTING.md §84.2). *As recorded 24 Nov:* the Firebase CLI handed the operator's CLI login to the Functions emulator as credentials. The remainder is #40 | Local tooling / security | **CLOSED (scoped)** | P3 | Design | — | TESTING.md §84.2 |
| 19 | Reports tab (L2-A) shows a working budget under its *Approved budget* card, with the sub-label *Working budget (not approved)*; the Portfolio shows the same value as *Not approved* with the working amount beneath | UX — wording (observation; values identical; pre-dates L2-C) | Open — **deferred** (architect) | P3 | — | UX fix bundle, if accepted | C1-B (24 Nov; B4) |
| 20 | Forecast tab: after the first *Save all changes* on a project, the page kept showing *Not forecast* / FFC 0 although the forecast line was written (REST-verified); a reload showed the saved figure. Seen once in two saves, not reproduced | Reliability / UX — display only (stored value and every other surface correct) | Open — needs a reproduction (not reproduced on fixture Z's first save, 24 Nov 10:28) | P3 | Reproduction | UX / reliability bundle | C1-B B5 (fixture X, 07:18) |
| 21 | Portfolio status line reads *All N projects have been read.* when every read failed (offline); the coverage notice below it is correct | UX — wording | Open | P3 | — | UX fix bundle (with #9) | C1-B B5 (P15, local) |
| 18 | `npm run test:team` did not wait for the Auth emulator (first-run bootstrap `ECONNREFUSED :9099`) and probed Vite on `127.0.0.1` while Vite 8 bound `::1` only (*Starting Vite… failed*) | Local tooling | **COMPLETE — INTEGRATED** (`62e824a`) — bounded readiness for Auth, Firestore, Functions and the CLI ready signal; Vite `--host 127.0.0.1`; bounded shutdown wait. End-to-end PASS, four fresh runs (§70) | P2 | — | Operator tooling safety — done | First implementation report |
| 22 | Final Account PDF: the *COST (EX-GST)* group heading prints as the last line of page 1 while its figures start on page 2; the single figures card runs across all three pages | UX — print layout (cosmetic; every figure present, legible and unclipped) | Open — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle (Hosting-only): keep a group heading with its first row of figures | C1-A B6 (native PDF, Chrome 157, macOS) |
| 23 | Final Account PDF: Chrome's default *Headers and footers* option prints the date, the tab title (*Constrap* — not the project or revision) and the full page URL, project id included, on every page | Observation — a browser option the user can untick; not application content | Recorded — **deferred** (architect, 25 Nov) | P3 | Decision | Deferred UX and reporting correction bundle — optional: a project / revision document title while printing; user guidance | C1-A B6 |
| 24 | Final Account status line reads *No Final Account has been prepared for this project.* when the only revision is a withdrawn draft (the revision history below lists it) | UX — wording | Open — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle | C1-A B6 (fixture Z, after revision 1 was withdrawn) |
| 25 | The approver's role is stored on an approved revision (`approvedByRole`), but no surface shows it — screen, CSV and PDF give the approver's name and the time only | Observation — audit presentation | Recorded — **deferred** (architect, 25 Nov) | P3 | Architect decision | Deferred UX and reporting correction bundle | C1-A B6 |
| 27 | Budget tab opened by URL as an external role has no restricted notice: it reports *Some commercial records could not be loaded* and reads *Unavailable* throughout (`ProjectBudget.jsx` has no role gate; every read is refused by the Rules) | UX — a refused role looks like a loading fault; **no figure shown** | Open — **triaged** (architect, 25 Nov) | P2 | — | External-role UI correction bundle (Hosting-only): the same restricted notice the other financial tabs show | L4 / Stage A run B7 (`subcontractor` on L4) |
| 28 | Purchase Orders tab opened by URL as an external role has no restricted notice: the refused read is shown as *No purchase orders yet* with *+ New Purchase Order* and *Create your first purchase order* offered (not pressed; the Rules deny the read and a create). Seen on a project that truly has no order; on one that has, the same empty state would be untrue | Display and gating defect — misleading empty state; **no figure shown; not an authorisation defect:** the Rules refuse an external role's read, create and update (`firestore.rules` `purchaseOrders`, `financialMember`, lines 986–988; emulator tests `purchaseOrders.rules.test.js` and `externalRoles.rules.test.js`, the latter with an assigned subcontractor and client — B7, TESTING.md §71). A production create by an external role was not attempted | Open — **triaged** (architect, 25 Nov); server-side enforcement inspected | P2 | — | External-role UI correction bundle (with #27, #29, #5). The fix needs a unit test of the page gate (restricted notice for a non-financial role; no empty register after a refused read); no further Rules test required | L4 / Stage A run B7 |
| 29 | A `/commercial/…` URL shows the Commercial sub-navigation (Margin, Client Invoices, Client Receipts, Supplier Payments, Cash Flow, Retention, Final Account) to an external role; the pages behind it are restricted (Margin and Final Account observed) | UX | Open — **triaged** (architect, 25 Nov) | P2 | — | External-role UI correction bundle (with #27, #28, #6) | L4 / Stage A run B7 |
| 26 | Final margin precision differs by surface: stored value and CSV two decimals (29.73), screen, PDF and Portfolio one decimal (29.7%) | Observation — presentation only; one stored value | Recorded — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle (no change proposed yet) | C1-A B6 |
| 30 | Baseline review dialog closes without a message when another session withdraws (or approves) the draft under review: the reviewer's dialog disappears and the draft leaves the panel; §42's *Someone else changed this baseline* is not shown | UX — no data effect; the server refuses an approve of a withdrawn header (PROD-VERIFIED, B8) | Open — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle (a short notice when the reviewed draft changes state) | C1-C B8 |
| 31 | For a **cancelled** successor the programme CSV / List predecessor text still reads *Starts before its predecessor allows*, while the *Dependency conflict* column and every count correctly exclude it | UX — wording; counts correct | Open — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle | C1-C B8 (T06) |
| 32 | On a **cold load with the Firestore backend unreachable** (page served, database not answering) the membership gate states *No active membership — This account is signed in but is not a member of a company*, with only *Sign out*. The SDK answers the `users/{uid}` listener from an empty cache as "does not exist"; `ProfileProvider` (`hooks/useProfile.jsx`) ignores `metadata.fromCache` and `membershipGate` (`lib/team.js` line 122) reads a settled null profile as no membership. It recovers by itself when the server answers (0.8 s locally; no sign-out, no data effect). Because the gate (ADR-72) sits above the project route, ADR-80's *Waiting for the server* cannot be reached on a reload — only when the connection drops after the membership read | Reliability / UX — a false statement about the user's access; no data or authorisation effect | **CLOSED — 26 Nov 2026** (B12; TESTING.md §76): released from `main` `0bdca38`, live bundle verified, *Waiting for the server* observed in production under injection, no account newly restricted. *As recorded before the release:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (25 Nov 2026; `fix/membership-resolution-state`, uncommitted; B11; TESTING.md §75): only a server-confirmed snapshot decides membership; a cache-only answer shows *Waiting for the server*. Unit and local browser acceptance PASS; not deployed. *As recorded before:* Open — **new** (B10). Observed on local emulators; **not observed in production with a session** (expected there: same source deployed, and Hosting serves a recently loaded URL from the HTTP cache while offline — observed, unauthenticated) | **P2 — next implementation task** (architect, 25 Nov 2026). *As recorded at the run:* P2 — proposed | — | **Decided:** correct the membership-state handling **without weakening authorisation** — a confirmed missing or inactive membership must still be refused; **no service worker and no PWA** in the correction; then L3 E2 corrected acceptance. *Proposed at the run (design not yet approved):* treat a cache-only missing profile as unconfirmed, not as no membership; unit tests of the gate; then re-run §66 E2 | B10; TESTING.md §74.3 |
| 33 | Dashboard budget card reads *Working Budget — "—" — Not approved · Σ budget lines* for about a quarter of a second after a project switch, on a project whose budget is approved, until the approved-budget pointer loads (`ProjectSnapshot.jsx` line 209 chooses the label from `budgetSource.approved`) | UX — wording while loading; the value shown is "—", never a wrong number | Open — **new** (B10; observed in production, fixture Z) | **P3 — deferred** (architect, 25 Nov 2026). *As recorded at the run:* P3 — proposed | — | Deferred UX and reporting correction bundle (a neutral label while the pointer is loading) | B10; TESTING.md §74.5 |
| 34 | TESTING.md §66 **E2 cannot be executed as written**: *DevTools → Offline, then reload* returns the browser's own error page — production Hosting registers no service worker — so the application never renders | Test procedure | **CLOSED — 26 Nov 2026** (B12): E2-A and E2-B PASSED in production under in-page transport injection (TESTING.md §76.3); E2-C stays a recorded limitation. *As recorded before the release:* **Procedure corrected** (25 Nov 2026; TESTING.md §75.7 and §66): E2-A (application loaded, Firestore unreachable before resolution), E2-B (membership confirmed, then data unavailable), E2-C (full offline hard reload — a recorded limitation; offline start-up is not supported; kept for a future PWA / offline-first increment). E2-A and E2-B PASS on local emulators; **production run outstanding**. *As recorded before:* Open — **to be corrected alongside #32** (architect, 25 Nov 2026). *As recorded at the run:* Recorded (B10) | — | #32 | Rewrite E2 with the #32 correction: block the Firestore host, or navigate to a cached URL while offline. No service worker is to be added to make the written step pass | B10; TESTING.md §74.3 |
| 35 | **Financial precision concern — GST half-cent rounding.** `roundMoney(x × 0.1)` (`lib/purchaseOrders.js`, binary floating point) returns a GST amount **one cent below exact decimal round-half-up** on some half-cent boundaries: 26,208 of 10,000,001 amounts from 0.00 to 100,000.00 (1,632 per $10,000), never high, never off a boundary (independent `Decimal` check, B10; e.g. 40.15 → 4.01, exact 4.02). The Rules pins were widened to **admit** this output (GST boundary hotfix). **Rules compatibility is not independent mathematical correctness:** the Rules accept what the application computes; they do not show that the figure is the arithmetically exact one. **Governing decision:** PROJECT_DECISIONS.md → *ADR-40 / ADR-57 Correction: GST Boundary Hotfix* (3 Nov 2026), *Limitations* — "`roundMoney` itself is unchanged … replacing it with exact decimal rounding would change stored figures across every module and is a separate decision"; the allowance was first bounded in ADR-57, decision 4; `roundMoney` as the money convention dates from ADR-10. FINANCIAL_WORKFLOWS.md line 10 describes `roundMoney` as *round-half-up to cents*, which this result contradicts on those boundaries (not edited here — outside the six files) | Financial precision — documented, deliberate behaviour; not a Rules or authorisation defect; no production record of the test company sits on a boundary. Not a tax-compliance statement either way | **Receivable side LIVE and production-verified (27 Nov 2026, B18: 803.00 / 40.15 → 4.02). Payable side OPEN — carried into Phase 2/3 (version-aware correction); production §44 shows 4.01 as documented.** *As recorded at integration:* **Receivable side RESOLVED in implementation (26 Nov 2026, ADR-86 — PENDING INTEGRATION):** client-invoice line GST is exact integer cents for drafts authored or edited from this release (40.15 → 4.02); credit notes and client retention derive GST from stored invoice figures, so a full credit reverses the stored amount exactly. **Payable side OPEN:** `poTotals`, `claimTotals`, the supplier and variation `gstForLine`, supplier `retentionGst` and `cumulativeRetentionGst` are unchanged; a version-aware correction (calculation version on new documents; four legacy read-time comparisons made version-aware) is a recorded future decision. *As recorded before:* Open — **tracked** (architect, 25 Nov 2026; recorded from the B10 evidence). **No calculation and no historical financial record is to change now** | **Assessment required before client credit notes and client retention** | — | Assess rounding semantics (exact decimal half-up versus the current output; effect on stored figures, credit-note reversal symmetry and retention release deltas) within or before the client credit-note architecture assessment and ADR. GST §44 manual steps 1–3 stay outstanding and are retained for that financial milestone | B10; TESTING.md §74.4, §74.10; PROJECT_DECISIONS.md (GST Boundary Hotfix; ADR-57; ADR-10) |
| 36 | **Cache-only answers are still taken as final outside the membership gate and the project route.** (a) `CompanyProvider` (`hooks/useCompany.jsx`) opens its listener without `includeMetadataChanges`, does not read `fromCache` and does not expose a read error: a cache-only "missing" company, or a failed company read, settles as `company: null` with `companyLoading: false`. Every data hook takes its target from `company?.id`, so all of them go idle — no listener, not loading, empty. The project route then says *Project not found*, and the pages below say there are no projects. A cache-only answer corrects itself when the server replies; a **failed** company read does not — there is no retry, only a reload. (b) **Projects** (`pages/Projects.jsx`) reads neither `projectsError` nor `projectsFromCache`: a failed or unconfirmed list shows *No projects yet. Create your first one*. (c) **Dashboard** and **Portfolio** read `projectsError` but not `projectsFromCache`: an unconfirmed empty list is presented as no projects. | Reliability / UX — a false "nothing here"; no data or authorisation effect (the Rules decide every read) | Open — carried forward, P2 (27 Nov 2026). Related, separate: the Hosting entry point is cached for an hour, so an old tab keeps the previous bundle after a release (B18). *As recorded:* Open — **new, recorded 26 Nov 2026** (architect direction; split from D3 #32). **Read from the code; not reproduced** — *except, since 26 Nov 2026 (PROD-BROWSER, TESTING.md §76.4): on every cold load of a project URL the page shows* Project not found. *for 55–100 ms between the membership read and the company read (five loads). Not introduced by the D3 #32 release.* (c) and part of (b) were already noted in ADR-80 *Limits* without a tracker id | **P2 — reliability hardening before customer onboarding** (architect, 26 Nov 2026 — REPORTED). **Does not block the D3 #32 release or the upcoming commercial implementation.** *As proposed at recording:* P3 | — | Reliability hardening and the future offline-first design; not part of D3 #32. Same correction pattern as the project route (ADR-80) and the profile (D3 #32): act only on a server-confirmed answer, expose the failure, offer a retry | TESTING.md §75.8, §75.10; PROJECT_DECISIONS.md → *Membership Resolution* |
| 37 | **Refused requests reach the Rules 1,000-expression ceiling in six blocks.** A full `npm run test:rules` run logs 4,560 *"Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached"* messages in the emulator debug log: `variations` update 1,688 and create 100, `progressClaims` update 1,130 and create 22, `supplierInvoices` update 668 and create 16, `rfis` update 532, `tenderPackages` update 320, `supplierCreditNotes` update 260. Every one belongs to a request the suite expects to be refused, and it is refused; the suite passes (39 files / 2,492). The counts are identical on `main` `8702728` and on the ADR-85 hoisted rules — **not introduced by Commercial Finance Phase 1**. ADR-40 D10 records "zero evaluation errors" as the regression signal; that is no longer the state of the ruleset (SECURITY.md already notes the M3-B2 and `rfis` cases individually). Not established: whether any request that should be **allowed** is close to the ceiling | Rules capacity — the outcome of every affected request is the intended denial; a diagnostic and headroom concern, not an authorisation defect | **OPEN — carried into Phase 2:** the three near-ceiling paths (`variations` create with an RFI, claim-sourced `supplierInvoices` create, `progressClaims` and pairing) move to the trusted backend (ADR-89 Decision 9). *As recorded:* **INVESTIGATED 26 Nov 2026 (TESTING.md §78.2; ADR-85):** no legitimate request fails (2,492 of 2,492 at zero padding); allowed requests in three pre-existing blocks sit within about 6–10% of the ceiling (`variations` create with an RFI fails at 16 padding comparisons of 196; `supplierInvoices` claim-sourced create at 20; `progressClaims` / pairing by 30); the ADR-87 / ADR-88 blocks pass at 60 and log no ceiling message. **Stays OPEN** for a semantics-preserving `let`-binding pass on those three blocks. *As recorded before:* Open — **recorded 26 Nov 2026**, for the architect to triage | Constrains how the client credit-note and retention blocks are written; does not block them | — | Decide whether to measure allowed-path expression headroom per block (the emulator reports the ceiling only when reached), and whether the larger blocks need `let`-binding before further rules are added | B13; TESTING.md §77.2; PROJECT_DECISIONS.md ADR-85 |
| 38 | **The local launcher cannot exercise App-Check-enforced callables from the browser, and the refusal is mis-described.** `npm run test:team` starts the browser build with no App Check key; the Gen 2 callables (`enforceAppCheck: true`) are then refused by the Functions emulator (`app: MISSING, auth: VALID`), although the launcher prints *"App Check is skipped by the Functions emulator"*. The dialog reports *"Your session has ended. Nothing was changed — sign in again and retry."* for a request whose session was valid. Applies to every App-Check-enforced callable in the launcher, not only the four added by ADR-89; found by the Phase 1 browser acceptance, which proceeded by adding the automated harness's unsigned emulator token in the tab. Nothing is written when it happens | Developer tooling and message accuracy — no production effect established (production builds carry an App Check key); not an authorisation defect | **Resolved locally 26 Nov 2026 — pending integration** (ADR-89 A8): the emulator build supplies an unsigned emulator-only token through the App Check `CustomProvider`; the launcher's line is corrected; the client-finance dialogs distinguish an App Check refusal from an ended session. Verified in the browser without a manual token | Local browser acceptance of any callable needs a manual token; does not block integration | — | Give the launcher an emulator App Check debug path (or document the token step), correct the launcher's printed line, and distinguish an App Check refusal from an ended session in the message | B15, B16; TESTING.md §79.5, §80.4 |
| 39 | **Two older callable surfaces still mis-describe an App Check refusal.** An untyped `unauthenticated` answer is shown as *"Sign in to continue."* by the team callables (`lib/team.js`) and as *"You do not have permission to do this."* by Final Account approval (`lib/finalAccountActions.js`); the BOQ transfer already names both causes. Found while correcting D3 #38; left unchanged because both surfaces are live and production-accepted and were outside the final pass | Message accuracy only — nothing is written and no authorisation is affected | Open — carried forward (27 Nov 2026; unchanged by the release). *As recorded:* Open — **recorded 26 Nov 2026** | None for integration | — | Apply the client-finance wording (signed-in ⇒ App Check; otherwise session ended) in a small UX change | TESTING.md §80.4 |
| 40 | **Three older dev launchers run outside the credential isolation** (`test:boq`, `test:quant`, `test:credit-notes`: real project id from `.env.local`, real Firebase Auth sign-in; `tender-dev.mjs` uses a `demo-` id but not the isolated environment). **28 Nov 2026 — fail-closed safeguard ADDED (uncommitted):** `scripts/realAuthLauncherGuard.mjs` refuses to start them unless `CONSTRAP_REAL_AUTH_LAUNCHER` names the exact project, and refuses outright under CI (`CI`, `TF_BUILD`, `GITHUB_ACTIONS`); a separately authorised session still works by naming the project for that one command (unit tests: `tests/unit/realAuthLauncherGuard.test.js`). The launchers themselves are unchanged — still outside the isolation | Local tooling / security | **Open — safeguarded** | P3 | Design | Migrate to the isolating launcher with emulated Auth, or retire | TESTING.md §85.6 |
| 41 | **Stale variation editor overwrote a concurrent save.** The draft editor saved against the LIVE revision from its subscription, not the revision it was opened on, so a form left open silently replaced another user's later save. Pre-dates Phase 2 (same code on `main`). Found in local browser acceptance, 28 Nov. **FIXED on the Phase 2 branch** (the editor sends its opening revision; the backend refuses `variation-stale`); re-tested in two tabs | Variations / data integrity | Fixed on branch — not deployed | P2 | Defect | Ships with ADR-90 | TESTING.md §84.4 |
| 42 | **Variation editor and assessment dialog showed whole dollars**, so the one-cent difference between legacy and exact GST was invisible exactly where the user is told about it. Found in local browser acceptance, 28 Nov. **FIXED on the branch** (both dialogs show cents; lists and summary cards keep whole units) | Variations / UX | Fixed on branch — not deployed | P3 | Defect | Ships with ADR-90 | TESTING.md §84.4 |
| 43 | **Variations page reachable by direct URL for a subcontractor**: the tab is hidden and every read is refused by Rules (no data shown), but the page renders an empty register with *New Variation* and *No variations yet*. Same class as #27–#29 (external-role UI bundle). Observed 28 Nov, not changed | External-role UI | Open — recorded | P2 bundle (proposed) | UX | With the external-role UI correction bundle | TESTING.md §84.4 |
| 44 | **A trusted-callable refusal was shown as a connection problem** on the supplier-invoice page ("Failed to update status. Check your connection") — a CERTAIN refusal presented as an uncertain one. Found in local browser acceptance, 28 Nov. **FIXED on the branch**: the page shows the server's reason, and the shared write-outcome helper classifies callable failures (typed refusal certain; untyped transport failure uncertain); regression test in `writeOutcome.test.js` | Supplier finance / UX honesty | Fixed on branch — not deployed | P2 | Defect | Ships with ADR-93 | TESTING.md §87.5 |
| 45 | **Outdated control wording** after ADR-94: the payment editor's over-allocation line said "This is allowed" while the save was blocked, and the release editor said concurrent releases can both succeed. Found 28 Nov; **both corrected on the branch** | Supplier finance / UX honesty | Fixed on branch — not deployed | P3 | Defect | Ships with ADR-94 | TESTING.md §87.5 |
| 46 | **Rules-held segregated approvals compare against the last editor of ANY kind.** Budget version, budget adjustment, tender award and PO send are client writes, so they carry no trusted `lastMaterialEditBy`; the Rules exclude `createdBy` and the stored `updatedBy`. A colleague's later edit (even cosmetic) replaces the earlier editor in that comparison. Fix options: a Rules-validated material-edit stamp on every draft write of the four collections (Rules capacity cost), or moving those approvals to trusted callables (ADR-89 direction). Found in the final-batch approval review, 28 Nov | Approval segregation (ADR-96) | **RESOLVED on the branch (ADR-98 Decision 5)** — Rules-maintained `lastMaterialEditBy`/`lastMaterialEditAt` on POs and tender packages; budget versions / adjustments have no draft edits (creator only). Not deployed | P2 | Control gap | Ships with ADR-98 | ADR-98, TESTING.md §89 |
| 47 | **Refund authorisation is outside Constrap.** A client refund records money already returned (bounded by the receipt and invoice ledgers, reason and actor recorded); it has no draft → confirm step, so segregation cannot require a second person. Policy question carried to the architect (final-batch ruling B) | Client settlement (ADR-95/96) | **DECIDED and implemented (ADR-98 Decision 6)** — recording single-person; void of a posted refund segregated under strict mode. Not deployed | P3 | Policy | Ships with ADR-98 | ADR-98, TESTING.md §89 |
| 48 | **Functions emulator suite timeouts were the host sleeping, not the code.** macOS power log shows the machine on battery entering system sleep (`sleep 1`) for 190–1,022 s at a time during the long runs; the 'timed-out' tests report ~1,000 s elapsed against a 30 s timeout, and every file passes in 34–45 s when run awake. Resolution: run the long suite under `caffeinate -i` (documented in TESTING.md); no timeout or assertion changed | Test infrastructure | **Resolved — root cause established** | P3 | Test infra | — | TESTING.md §88 |
| 49 | **Global-only Phase 2 activation rejected by the architect.** Resolved: one operator-written company marker `commercialCompletionEnabled`, enforced before any baseline and inside every operation's transaction; inactive companies are read-only (maintenance) after the final Rules | Release control | **Resolved on the branch (ADR-98 Decisions 1–4)** — not deployed | P1 | Release control | Ships with ADR-98 | TESTING.md §89 |
| 50 | **Baseline final digest was outside the completion transaction** (a source could change between the last digest and the marker becoming complete). Resolved: the digest is taken through the completion transaction's own reads; adversarial tests | Supplier finance (ADR-94) | **Resolved on the branch (ADR-98 Decision 7)** — not deployed | P2 | Consistency | Ships with ADR-98 | TESTING.md §89 |
| 51 | **Self-approval wording ignored the segregation policy.** Budget version, budget adjustment, PO send, tender award and Final Account approval dialogs said "approving it yourself is permitted" while the company's policy made the server / Rules refuse it, and Rules-held refusals showed a generic permission text. Found in local browser acceptance 28 Nov. **Fixed on the branch** (`lib/approvalSegregation.js`, `useApprovalPolicy`, the five dialogs; unit tests) | Approval segregation / UX honesty | Fixed on branch — not deployed | P2 | Defect | Ships with ADR-98 | TESTING.md §89.2 |
| 52 | **Refused tender-package updates reach the 1,000-expression ceiling** (the refusal names the ceiling). Reproduced against the base commit — pre-existing, same class as D3 #37; refusal either way (fail-closed). Allowed paths measured separately (§89.6) | Rules capacity | **Open — pre-existing, RETAINED by the architect (not reopened in Phase 2)** | P3 | Capacity | Rules capacity work | TESTING.md §89.4 |
| 53 | **BOQ item text fields have no Rules length bound** (description, section, cost-code name, notes). A financial-role member can make the estimating build's and the ADR-81 transfer's BOQ read very large (≤ 5,000 items × up to 1 MiB). Fails without writing; an availability / cost risk, not an integrity one. Pre-existing (BOQ, Phase 1). Estimating now reads only the fields a line uses and bounds its own stored text; a Rules bound on the BOQ fields needs a decision on existing long values | BOQ / Rules capacity | **DECIDED (architect, ADR-98 Decision 9b)** — no truncation or rewrite; estimating refuses over-bound text clearly (`text-too-long`); oversized values inventoried at stage A; general BOQ text hardening → Phase 3 | P3 | Availability | Phase 3 | ADR-98, DEPLOYMENT stage A |
| 54 | **Strict mode and legacy unstamped POs / tender packages.** Under segregation a PO or tender package written before `lastMaterialEditBy` existed cannot be sent / awarded until a material save records its preparer; an ISSUED package or PENDING_APPROVAL PO has no edit path (cancel and re-raise, or leave the policy off). Mitigated: the approval-policy operator tool now lists them (ids only) in its dry run before enabling | Approval segregation | **DECIDED (architect, ADR-98 Decision 9c)** — never fabricate provenance; strict approvals fail closed; existing save / cancel / reissue workflows remain; affected records in the stage A inventory (`po-preparer-unrecorded`, `tender-preparer-unrecorded`) | P3 | Operability | — | ADR-98, DEPLOYMENT stage A |
| 55 | **Inactive-company client lifecycle writes** (claim submit; variation submit / reject / withdraw) were refused only in the UI. **RESOLVED on the branch (ADR-98 Decision 9a):** the Rules require `commercialCompletionEnabled == true` (`commercialActive`); direct-SDK tests for missing / false / non-boolean / true / deactivated during use | Release control / Rules | Resolved on branch — not deployed | P1 | Control gap | Ships with ADR-98 | TESTING.md §89.8 |

**Reconciled against the repository, 25 Nov 2026 (`main` `875910e`; no fix made).**
#5 unchanged (`Projects.jsx` line 300: the button is shown to every internal
role, `qs` included). #11 unchanged — 42 files, 58 saving states, as pinned in
`writeOutcome.test.js`. #12: **one** source comment still says *Deferred
Control 46 — still OPEN* (`hooks/useStorageUpload.jsx` line 99); the other two
this row counted are no longer present. #13 unchanged (SECURITY.md line 1752).
#27, #28 unchanged — neither `ProjectBudget.jsx` nor
`ProjectPurchaseOrders.jsx` has a role gate. Every other open row was not
re-tested and stands as written. No ID was renumbered or merged.

**Classification of the open items (25 Nov 2026 — proposed at the run; priorities of #32–#34 and the addition of #35 decided by the architect the same day).**

| Category | Open items |
|---|---|
| Security | #4 (withdrawn drawing revisions, R-3); risk register R-1, R-2, R-4 (D1) |
| Financial correctness | **No defect open against the specification; one explicit precision concern — #35** (architect, 25 Nov 2026): `roundMoney`'s one-cent-low result on a half-cent boundary is documented behaviour that the Rules admit, and that admission is compatibility, not independent mathematical correctness. Assessment tracked before client credit notes and client retention. *As written at the run:* **None open.** `roundMoney`'s one-cent-low result on a half-cent boundary is documented behaviour that the Rules admit (GST boundary hotfix), not a defect; replacing it is a separate decision (PROJECT_DECISIONS.md) |
| Data integrity | R-7 (DC23, impossible programme dates); the D2 limits |
| Reliability | **#32**; #11 (58 older write sites); #20 (needs a reproduction) |
| Operator safety | #17 (emulator holds the CLI login). #1–#3, #16, #18 complete |
| UX and presentation | P2: #5, #6, #8, #27, #28, #29. P3: #7, #9, #10, #19, #21–#26, #30, #31, **#33** |
| Documentation and procedure | #12, #13, #14, #15, **#34** |
| Deferred product functionality | D4 → *Not yet implemented* |

| Question | Answer on current evidence |
|---|---|
| Genuine release blockers (the product as used today, internally) | **None found** |
| Customer external onboarding blockers (onboarding stays separately gated) | Decisions on #4 / R-3, R-1, R-2, R-4 and R-7; the external-role UI bundle #27–#29 with #6 and #8; #32 (P2, next implementation task), which any user on a poor connection can meet |
| Correct before commercial implementation resumes | **Decided (architect, 25 Nov 2026): #32, then L3 E2 corrected acceptance.** Before client credit-note *implementation*: the credit-note assessment and ADR, the #35 rounding-semantics assessment, and the Rules capacity assessment. *As written at the run:* Proposed: **#32** only — small, Hosting-only, and it closes L3 E2; new commercial dialogs will reuse the same helper |
| Safe to group into a later correction bundle | Every P3 row; #5; the documentation rows |

### D4. Implementation roadmap (strategic order unchanged)

| State | Items |
|---|---|
| **Implemented and production-accepted** | Commercial foundations; M1, M2-A, M2-B1/B2/B3, M3-A/B1/B2; SHIELD 2A / 2B1 / 2B2; L1 Team Management; DC46 (closed with accepted risks); L2-A; L2-B Stage A; L4 (**remaining acceptance CLOSED with recorded limitations, 25 Nov** — T9, the Quant step of T16 and T14 as `subcontractor` PASSED, B7; T14 as `client` and a real disconnection not run); **M2-A2 Stage A and B (DC20 closed; Stage A internal regression CLOSED within its applicable scope, 25 Nov — B7)**; **L2-C Portfolio (C1-B CLOSED, 24 Nov — REPORTED)**; **L2-B Final Account (C1-A CLOSED, 25 Nov — REPORTED; F16 notice not observed in production and carried forward; R5 on stored-state evidence; zero-only client-side and cash scenarios — B6)**. *Integrated, no production acceptance required:* operator tooling safety (`62e824a`) |
| **Implemented, with residual checks (25 Nov 2026, B10 — decided by the architect the same day)** | L3 Stage 2 — **not closed** (E1, E3–E10 accepted with their evidence classes — E1 in production, the rest on local emulators; **E2 open** against D3 #32); GST boundary hotfix (deployment verified; calculation compatibility accepted; §44 manual steps 1–3 outstanding; precision concern D3 #35); Premium Dashboard v2 (deployment verified; tested financial calculations accepted; §22 checks 2 and 3 open) |
| **Implemented, not fully accepted** *(as written before B10)* | GANTT 1A1 / 1A2 / 1B and core completion (C1-C — **functional acceptance CLOSED 25 Nov, B8; print / PDF, Safari / Firefox, Day / Month visuals, baseline outlines, individual filters, G11, offline capture and stale quick-action / cancel carried forward**); L3 Stage 1 alerting (C1-D — **CLOSED 25 Nov 2026**, with evidence limitations; B9) and Stage 2 (E1–E10); GST boundary hotfix and Premium Dashboard v2 (production evidence) |
| **Known defects requiring fixes** | **D3 #32 — CLOSED 26 Nov 2026 (B12)** *(was: P2 — false *No active membership* on a cold load with the backend unreachable)*, #33 (P3, deferred — Dashboard loading label), #34 — **CLOSED 26 Nov 2026** (test procedure; E2-A / E2-B passed in production) — B10; #35 (financial precision concern — assessment, no fix decided); #36 (**P2** — cache-only answers taken as final in the company provider and on Dashboard, Projects and Portfolio — recorded 26 Nov; reliability hardening before customer onboarding; not blocking);** D3 #27–#29 (**P2 external-role UI correction bundle** — display and gating on Budget, Purchase Orders and the Commercial sub-navigation; no data exposed; server-side refusal confirmed for #28), D3 #4–#9, #19, #21 (UX; #9, #19, #21 wording only), #22 and #24 (Final Account print layout and wording — deferred bundle with #23, #25, #26), #20 (needs reproduction), #17 (local tooling), **#30, #31 (P3, GANTT wording / notice — deferred, C1-C)**. D3 #1–#3, #16, #18 complete (`62e824a`) |
| **Security hardening** | D1 R-1 … R-7 (R-7: DC23 calendar-valid programme dates, before customer readiness); general App Check enforcement; DC46 follow-ups (Storage audit logs, faster revocation, drawing-revision policy, load testing at triggers); billing-account administration |
| **Not yet implemented** | Real customer external onboarding (gated); self-serve company signup; billing and subscriptions; client portal; client refunds and credit settlement; estimating; creator ≠ approver segregation on Final Account; company legal / tax identity; client-side error reporting; external availability monitor |
| **Deferred (order per ROADMAP → *Approved development order (post-L4)*)** | 1 remaining core functionality and acceptance (C1) → 2 SaaS readiness and international foundations → 3 mobile / PWA → 4 Xero (ADR-82 PROPOSED) → 5 Constrap IQ → 6 Quant AI → 7 final production audit. Stage 8 advanced modules unscoped |

#### D4a. Commercial lifecycle gaps — status and dependencies (reconciled 25 Nov 2026; nothing redesigned, nothing reordered)

Read from ROADMAP.md → *Development Order* and *Known Gaps*, DATA_MODEL.md,
SECURITY.md and the code. The approved post-L4 order is unchanged (last row
of the table above).

| Item | State | What exists | Actual dependencies |
|---|---|---|---|
| Supplier credit notes | **Implemented and live** (ADR-31, foundation) | Own collection `supplierCreditNotes`; refuses an invoice that carries retention | — |
| Client credit notes | **LIVE — Commercial Finance Phase 1 (27 Nov 2026; B18).** *As reconciled 25 Nov:* **Not implemented** | `clientInvoices.docType` reserves `credit_note`; the Rules pin `docType == 'invoice'`. An issued client invoice can only be voided whole | Client Invoices and Client Receipts (live). Every consumer of issued client invoices must take the credit: Available to Invoice, receivables and ageing, Cash Flow, Commercial Report, Portfolio, Final Account. **Rules capacity:** the comparable supplier block is 8,403 bytes of source and the source headroom against the repository's 245,000-byte working limit is 8,263 (236,737) — an indication only. **Source-file size alone does not establish deployable Rules capacity** (architect, 25 Nov 2026): a capacity **assessment** comes first — it must establish the limits that actually govern a publish (compiled size and expression limits as well as source bytes; SECURITY.md records Firestore's 1000-expressions-per-request ceiling being reached in the emulator) — and then any necessary recovery. **Rounding semantics (D3 #35)** are assessed before implementation. No trusted backend needed |
| Variation-originated credit notes; negative progress claims; direct PO invoicing of new-scope work | **Not implemented** | Listed as remaining under *Variations* | Supplier credit notes and M3-B2 (live) |
| Client retention | **LIVE — Commercial Finance Phase 1 (27 Nov 2026; B18).** *As reconciled 25 Nov:* **Not implemented** | Supplier retention and retention release exist (ADR-30); the Final Account's retention figures have been exercised at zero only | Client Invoices; a rule for a credit against a retained invoice (so client credit notes first, or decided together); Cash Flow; Final Account; contract payment terms on the baseline (not built) |
| Estimating (ROADMAP 4c) | **Not implemented — Phase 2 (Commercial Completion)** | BOQ foundation with rates; BOQ → working budget transfer live and accepted (L4) | A design for rate build-ups and margins; independent of the items above; the largest of these |
| Approval segregation (creator ≠ approver) | **Not implemented anywhere — Phase 2** | Self-approval is permitted and documented on purchase orders, claims, variations, client invoice issue, programme baselines and the Final Account (where it is labelled); the acting users are rules-verified on claims, purchase orders and variations, and the policy itself is not approved (DC4) | A policy decision first — a small contractor may have one financial user, so a company setting or a minimum-users rule is needed. The Final Account can be enforced in the `approveFinalAccount` callable with no Rules bytes; the others need Rules changes in large blocks (capacity again) |
| Other recorded gaps | **Not implemented** | — | Forecast periods and snapshots; Cash Flow date filtering and invoice retiming; tender packages from the BOQ and bid levelling; client progress claims; revenue recognition; company legal and tax identity and a printable client invoice; refunds and payment reversals (**client refunds and credit settlement: Phase 2**); subcontract final accounts; client signature |

**Preserved, unchanged and not started (ROADMAP stages and the post-L4
order):** security hardening (D1; general App Check; DC46 follow-ups);
customer onboarding (gated); SaaS billing, subscriptions and administration;
international tax and currencies (Australian GST only today); international
latency (measured from New Zealand only — CHATGPT_HANDOVER.md → *I*); mobile
/ PWA and offline field use (D3 #32 and #11 are direct inputs to it); Xero
(ADR-82 PROPOSED); Constrap IQ; Quant AI; the final production audit.

**Decided order of work (Lead Architect, 25 November 2026 — REPORTED). Each
step needs its own brief; nothing below is started.**

1. **D3 #32 membership reliability fix** — correct the membership-state
   handling without weakening authorisation; no service worker, no PWA.
   *IMPLEMENTED 25 Nov 2026 (B11) — pending integration, a Hosting deploy
   and production verification.*
2. **L3 E2 corrected acceptance** — with the corrected procedure (D3 #34).
   *Procedure corrected; E2-A and E2-B PASS on local emulators; the
   production run follows the deploy.*
3. **Client credit-note architecture assessment and ADR** — including the
   rounding-semantics assessment (D3 #35).
4. **Firestore Rules capacity assessment and any necessary capacity
   recovery** — source-file size alone does not establish deployable
   capacity.
5. **Client credit-note implementation** — the outstanding GST manual
   regression checks (§44 steps 1–3) are retained for the relevant financial
   implementation milestone.
6. **Client retention.**

Estimating, approval segregation and the remaining approved commercial
roadmap are **preserved** — not removed, not reordered within the post-L4
order (D4, last row).

*As written at the run —* **Recommended next steps (PROPOSED — not approved; the order of work stays
the Product Owner's and the architect's).**

1. **L3 reliability correction** — D3 #32, Hosting-only, with unit tests of
   the membership gate; re-run §66 E2. It is the smallest outstanding task
   behind an open acceptance gate.
2. **Next commercial milestone: client credit notes.** It is the smallest of
   the named commercial gaps, mirrors a pattern already live (ADR-31), every
   surface that must consume it exists and is accepted, and client retention
   depends on its rule for retained invoices. Dependencies: an assessment
   and ADR; a Firestore Rules capacity recovery before the Rules change; the
   consumers listed above; no trusted-backend change.
   *Smaller alternative, if a policy is decided first:* creator ≠ approver on
   the Final Account, in the callable only.

Real customer external onboarding remains separately gated.

### D5. Operator tooling safety — INTEGRATED (24 November 2026)

*Status (24 Nov 2026, C1-B revision):* **merged to `main`** as `bc64487`
(*fix(security): harden operator tooling and secure invitation delivery*),
merge `62e824a` (VERIFIED in Git, equal to `origin/main`). Azure `main` CI
green (REPORTED by the Lead Architect; not read here). Corrections D3 #1–#3,
#16 and #18 complete; D3 #17 outstanding. No production deployment was
required and none was made. **Production transaction cleanup was not
tested** — the refused-transaction lock behaviour and its fix are proven on
the emulator only. *Next actionable milestone (updated after B5):* the architect's C1-B closure decision, then C1-A role checks using the retained PM / QS identities.

*As written before integration:* implemented on `feature/operator-tooling-safety` (uncommitted),
awaiting architect review. **Deployment: none required** — no Rules, Storage
Rules, Hosting, callable or `functions/src` change. Tests (after the
architect corrections): functions pure 8 files / 179 (was 7 / 155); functions
emulator 11 files / 367 (was 11 / 354; TESTING.md §70); unit 101 / 5,244
unchanged; `npm run test:team` end-to-end PASS (four fresh runs). *First
implementation report:* pure 177, emulator 365. Safe procedure, migration and recovery:
DEPLOYMENT.md → *Operator tooling safety*. Remaining acceptance: merge, Azure
green. No production dry run needed (architect). Not closed.

*As proposed:* **Operator tooling safety** — D3 #1–#3 / R-6: `bootstrap-company.mjs`
dry-run by default with an explicit `--apply`, and its link never printed
(`--no-link` / `--link-file`, as ADR-84's scripts already do); the four older
scripts to set `process.exitCode` after a refused transaction. Scripts and
their tests only — no Rules, Functions, Hosting, deploy or production write.
It removes one residual risk gating customer onboarding and is smaller than
any C1 item that needs new role sessions.

### B13. Commercial Finance Phase 1 — assessment, Rules capacity recovery 3 (ADR-85), rounding assessment (26 November 2026 NZDT) — **LIVE — production-accepted in B18 (27 Nov 2026).** *As written:* **CF3 IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION; CF1 / CF2 decisions PROPOSED**

Full record: TESTING.md §77. `feature/commercial-finance-phase-1`, uncommitted. No production access of any kind.

| Item | Result | Class | Note |
|---|---|---|---|
| Baseline | Unit 103 / 5,336; rules 39 / 2,492 | EMULATOR | `main` = `origin/main` = `8702728`, clean |
| Hoist equivalence (ADR-85) | **Proven** | LOCAL (script) | `verify-rules-helper-hoist.mjs --base 8702728`: 55 call sites expand to the original text in all three rules files |
| Rules suite on the hoisted files | **39 / 2,492 passed** | EMULATOR | No test changed; same count as the baseline |
| Expression-ceiling messages, before / after | **4,560 / 4,560**, same per rule | EMULATOR | D3 #37 |
| Unit suite, lint | 104 / 5,357; 0 / 0 | LOCAL | +21: `rulesHelperHoist.test.js` |
| Source size | 236,737 → **228,289**; binding headroom 7,582 → **16,031** | LOCAL | The transitional file is the largest of the three |
| Compiled-ruleset size | **Not measured** | NOT RUN | Reported only by the Rules API when a ruleset is created |
| Rounding sweep (D3 #35) | 419,426 of 20,000,000 half-cent boundaries one cent low; none high; none off a boundary | LOCAL | To $2,000,000.00; integer form exact throughout |
| GST §44 manual steps 1–3 | **NOT RUN** | NOT RUN | Scheduled for the local integrated acceptance (CF6) |
| Client credit notes, client retention | **NOT BUILT** | NOT BUILT | ADR-87 / ADR-88 PROPOSED |

**Not published.** The recovery is Rules-only and may be published alone; it changes no decision the ruleset makes.

### B14. Commercial Finance Phase 1 — implementation and integrated local acceptance (26 November 2026 NZDT) — **LIVE — production-accepted in B18 (27 Nov 2026).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**

Full record: TESTING.md §78. `feature/commercial-finance-phase-1`, uncommitted. No production access of any kind; no production account used.

| Item | Result | Class | Note |
|---|---|---|---|
| Unit suite | **111 / 5,789 passed** | LOCAL | +8 files; includes an independent BigInt decimal oracle and a 500-sequence property test |
| Rules suite | **40 / 2,548 passed** | EMULATOR | +56: `clientLedger.rules.test.js` |
| Functions pure / emulator | **8 / 179; 11 / 372 passed** | LOCAL / EMULATOR | +5: the callable recomputes credit notes and retention |
| Extended property runs | 2 × 30,000 sequences, ~188,000 steps each: **no accepted allocation broke an invariant or produced a negative basis** | LOCAL (temporary) | Not committed; the committed test runs 500 |
| Cumulative cap under concurrency | Exactly one of two simultaneous postings lands (credit / credit, credit / release, release / release, posting / invoice void) | EMULATOR | Real Rules, real transactions |
| Unpaired, forged, reused, substituted ledger writes | **All refused** | EMULATOR | Deferred Control 49 lists what stays with the application |
| Role matrix | admin / PM / QS allowed; subcontractor, client, other company, unauthenticated denied | EMULATOR | Emulator identities only |
| Expression headroom (D3 #37) | New blocks pass at 60 of 196 padding comparisons; three older blocks fail at 16–30 | EMULATOR | Method: TESTING.md §78.2 |
| Browser acceptance | Retention, credit note, release, void lock and four-surface parity **as computed** | LOCAL (Auth / Firestore / Functions emulators) | Targeted; untested paths listed in §78.5 |
| Final Account compatibility | Old-schema revision shows no false difference; later credit note is reported; drafts must carry every key | LOCAL | Unit tests; no production revision read |
| GST §44 manual steps 1–3 | **NOT RUN** | NOT RUN | Emulator equivalents pass; supplier formulas unchanged and pinned |
| Compiled Rules size | **Not measured** | NOT RUN | Release prerequisite |
| Production | **Nothing deployed, read or written** | — | |

### B15. Commercial Finance Phase 1 — authoritative backend correction (ADR-89) and completed local acceptance (26 November 2026 NZDT) — **LIVE — production-accepted in B18 (27 Nov 2026).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**

Full record: TESTING.md §79. `feature/commercial-finance-phase-1`, uncommitted. No production access; no production account used. B14 records the first design, which was not integrated.

| Item | Result | Class | Note |
|---|---|---|---|
| Unit suite | **113 / 5,935 passed** | LOCAL | Independent BigInt oracle; 500-sequence property test with voids |
| Rules suite | **40 / 2,597 passed** | EMULATOR | `clientLedger.rules.test.js` 105: restrictions, bypass attempts, honest gaps |
| Functions pure / emulator | **9 / 241; 12 / 497 passed** | LOCAL / EMULATOR | `clientFinance.test.js` 125 |
| Blocker A — line validation | **Closed**: every forged-line draft refused, nothing written | EMULATOR | Server re-derives every line, GST, total and the retention split |
| Blocker B — DC49 receipts | **Closed for the release void**: refused when receipts depend on it; a concurrent receipt is ordered against the void | EMULATOR | A receipt posted *after* a void can still over-allocate — the accepted policy; shown as owed to the client |
| Direct bypass | Draft → posted, any ledger write, any change to a posted entry: **refused for every financial role**, including the pair the first design accepted | EMULATOR + LOCAL browser (REST with the user's token) | |
| Cross-company and unauthorised calls | Refused (not found / forbidden) | EMULATOR + LOCAL browser | |
| Idempotent retries | Same answer, one movement, one audit event | EMULATOR + LOCAL browser | |
| Concurrency | Exactly the fitting set lands; credit / release; posting / invoice void; receipt / release void | EMULATOR | |
| Mixed-tax high-retention edge case | **Incorrect semantics found and corrected**; basis never rises above one cent of rounding | LOCAL | 435,847 randomised steps, two seeds, with voids |
| 20,000,000.00 retention limit | **Removed**; exact at 250,000,000.00 and 9,999,999,999.99 | LOCAL + EMULATOR | |
| Rules source | 235,387; binding file 236,067 — **8,933 under budget** | LOCAL | First design 243,784; before the phase 237,417 |
| Browser acceptance A–L | **PASS** (J with one limit) | LOCAL | With an injected emulator App Check token — D3 #38 |
| GST §44 manual steps 1–3 | **Run locally — PARTIAL**: two steps cannot be performed as written (recorded); what can be performed passes | EMULATOR | Still NOT RUN in production |
| Deployment compatibility | Obsolete-client bypass refused; released build's contract unchanged; kill switch | EMULATOR | New build against the old Rules, and an open tab across a release: not run |
| Compiled Rules size; load test | **Not measured / not run** | NOT RUN | Release prerequisite; plan in ARCHITECTURE.md |
| Production | **Nothing deployed, read or written** | — | |

---




### B16. Commercial Finance Phase 1 — final release-readiness pass (26 November 2026 NZDT) — **LIVE — production-accepted in B18 (27 Nov 2026).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**

Full record: TESTING.md §80; decisions: ADR-89 *Final-pass amendments* A1–A9. `feature/commercial-finance-phase-1`, uncommitted. No production access.

| Item | Result | Class | Note |
|---|---|---|---|
| Unit / rules / Functions pure / Functions emulator | **115 / 6,019; 40 / 2,621; 9 / 249; 13 / 552 passed** | LOCAL / EMULATOR | |
| Receipt dependency without a scan | Release void, credit-note void and receipt post read 6 documents, receipt void 5 — identical with 0 and with 5,200 unrelated receipts; no query | EMULATOR | The 5,000 limit and its refusal are deleted |
| Receipts posted and voided by the server | Stale-tab over-allocation refused without acknowledgement; allocated invoices validated; future date refused; idempotent | EMULATOR + LOCAL browser | Acknowledged over-allocation is permitted by policy |
| Direct receipt posting / posted-void by a client | **Refused for every financial role** | EMULATOR + LOCAL browser | Drafts and draft-voids unchanged |
| Concurrency: receipt ∥ release void; receipt ∥ credit; receipt ∥ receipt | Forbidden end state never reached | EMULATOR | Two orderings asserted but not hit |
| Named void refusals | Blocking credit note, release or receipt named with its number, including from a stale tab | EMULATOR + LOCAL browser | Lookup cannot change the decision |
| One-cent receivable rise | **Reproduced, classified incorrect, corrected by rounding direction; proven not to recur** | LOCAL | Proof covers the allocation from any valid state; reachability of valid states is asserted, not proven |
| Supported monetary range | 999,999,999,999.99 per invoice; exact conversion tested to 10^13; refused above | LOCAL | Firestore numeric storage relied on as documented |
| D3 #38 — App Check in development | **Resolved locally**; production build contains none of it | LOCAL + LOCAL browser | D3 #39 records two older surfaces with the old wording |
| GST §44, corrected procedure, steps 1a, 1b, 2, 3a, 3b | **PASS locally**; 3b with a stated limit | EMULATOR / LOCAL browser | **Production: NOT RUN** |
| Release compatibility | Old build refused cleanly; obsolete writes refused; both kill switches; App Check refusal and recovery; idempotent retries | LOCAL browser (switches staged) | New build on old Rules / missing callables: not run in a browser |
| Rules source | 235,321; binding 236,001 — **8,999 under budget** | LOCAL | Compiled size **not measured** — release prerequisite |
| Production | **Nothing deployed, read or written** | — | Read-only prerequisite before release: no client invoice with retention |

---


### B17. Commercial Finance Phase 1 — final integration safeguards (27 November 2026 NZDT) — **LIVE — production-accepted in B18 (27 Nov 2026).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**

Full record: TESTING.md §81; decisions: ADR-89 S1–S5. `feature/commercial-finance-phase-1`, uncommitted. Production: one read-only aggregate inventory; no write.

| Item | Result | Class | Note |
|---|---|---|---|
| Unit / rules / Functions pure / Functions emulator | **116 / 6,085; 40 / 2,632; 9 / 256; 14 / 623 passed** | LOCAL / EMULATOR | Includes the receipt activation gate for the cutover (ADR-89 S6; TESTING.md §81.5). One unexplained slow overnight run recorded (§81.1) |
| Production inventory | 18 client invoices; 12 receipts (9 posted); 9 allocations on posted receipts; 5 invoices with history; 0 retained; one receipt shape | **PRODUCTION, READ-ONLY** | Counts and field names only |
| Historical baseline | Exact per invoice; partial, full, over-allocated, mixed, void, concurrent initialisation, stale tab, acknowledgement — all pass | EMULATOR | Not run against real Firestore |
| Missing or inconsistent baseline | Every operation refused; nothing written; never zero | EMULATOR | |
| Per-operation cost | One more document read (the marker); no query; unchanged with 5,200 unrelated receipts | EMULATOR | One-time baseline measured at 300 receipts |
| Company activation | Rules and callables refuse a non-activated company; no client can set the flag; one company does not open another | EMULATOR | Browser: §81.4 |
| Monetary range | Server and Rules refuse above the maximum; ledger totals safe integers on read and write | EMULATOR | No rounding change |
| Commit 1 tree (ADR-85 only) | Prover OK; unit 104 / 5,357; rules 39 / 2,492 | LOCAL / EMULATOR | Built from a temporary index; working tree untouched |
| Rules source | 236,120; binding 236,800 — **8,200 under budget** | LOCAL | Compiled size **not measured** |
| Production | **Nothing deployed or written** | — | Baseline writes and activation flags will be production writes at and after cutover |

---


### B18. Commercial Finance Phase 1 — production cutover, acceptance and general availability (26–27 November 2026 UTC) — **LIVE; Phase 1 CLOSED within its accepted scope** (Lead Architect, 27 Nov 2026 — REPORTED)

Full record: TESTING.md §82; release record DEPLOYMENT.md → *Release record (as executed)*; decisions ADR-85 to ADR-89 (*Void policy*, *Production closure*). Executed by the Product Owner; verified by the engineer. Production writes: the configuration commits' deployments, the activation flags, the F2 and Stage H fixtures in `constrap-acceptance-test`, and Apex's activation flag — nothing else.

| Item | Result | Class | Note |
|---|---|---|---|
| Release identity (A–G) | Six new callables + `approveFinalAccount` source identical to `main`; ruleset `0e228bd0…` byte-identical (236,120); Hosting `2f85dee4071c61d6` byte-identical to a build; effective parameters read from each service | PROD-VERIFIED | First Step A attempt failed on the filter (no `team:`); nothing deployed; corrected |
| Restriction (C) | Released build and direct writes refused; unappliable-precondition probes calibrated | PROD-BROWSER / PROD-VERIFIED | Hosting `index.html` cached 1 h — confirm the bundle first |
| Non-zero historical baseline (F2) | Marker 1 / 1 / 1 / 60000; ledger 110000 = independent sum; historical void → 50000; replay no effect; four audit events exactly | PROD-BROWSER + PROD-VERIFIED | Apex refusal not observed live (emulator + configuration evidence) |
| Apex baseline compatibility (F3) | Callable's own summing function, read-only: 9 / 9 / 5, no problem | PROD-VERIFIED (read-only) | Not initialised; first genuine receipt operation establishes it |
| Financial lifecycle (H1) | Boundary GST 4.02; mixed and GST-free; partial, full, multiple credits; credit on retained invoice; credit after receipt; partial and final releases; receipt on released retention; over-allocation refused / accepted; owed to client; dependency-ordered voids; stale draft refused then refreshed; invoice void protection — **all equal to independent expectations** | PROD-BROWSER | Not run: input-taxed line; stale receipt through a second tab |
| Ledger reconciliation | Seven ledgers equal the sums of their posted entries | PROD-VERIFIED | |
| Direct-write probes | 15 refused (credit notes, releases, ledgers, marker, flags, posted receipt, invoice void, posted supplier invoice) | PROD-VERIFIED | Company Admin only; role matrix EMULATOR |
| Concurrency / idempotency | Three concurrent posts → one effect; four replays → `alreadyApplied` | PROD-VERIFIED | |
| Audit | 29 events since G, exactly the expected set | PROD-VERIFIED | |
| Final Account (H2) | Owed-to-client blocker; approval with every figure as expected; later movement shown as a 2-figure difference; fixture Z revision 2 unchanged, new figures *Not recorded* | PROD-BROWSER + PROD-VERIFIED | |
| Reporting parity | Client Invoices, Receipts, Client Retention, Commercial Report + CSV, Portfolio + CSV equal to the cent; Cash Flow and Dashboard consistent in whole dollars | PROD-BROWSER | Final Account CSV **not tested**; Dashboard §22 2–3 open |
| Printable credit note | Content accepted | PROD-BROWSER | **Paper layout not viewed** |
| GST §44 (supplier side) | 1a, 1b, 2, 3a (financial), 3b PASS | PROD-BROWSER + PROD-VERIFIED | 3a external-role checks **NOT RUN**; D3 #35 payable side OPEN |
| Void policy | Invariant-based void accepted (invoice B); refusals where invariant or receipts require | PROD-BROWSER | **Approved** by the architect |
| Stage I | Apex `clientFinanceEnabled` true; one audit event; 17 services, Hosting, rulesets unchanged; Apex data unchanged apart from the flag and its event | PROD-VERIFIED | No Apex financial test transaction |

---

### B19. Phase 2 — first integration checkpoint: steps 0–2 (27 November 2026 NZDT) — **IMPLEMENTED, NOT DEPLOYED; LOCAL / EMULATOR evidence only; awaiting the Lead Architect**

[TESTING.md §83](TESTING.md); ADR-90, ADR-91, ADR-92.

| Item | Result |
|---|---|
| D3 #37 — near-ceiling Rules paths | **Path 1 of 3 (variations) resolved in the repository** by moving create, approve and legacy apply to the backend. Paths 2 and 3 (claims and supplier invoices, one unit) not started. Expression headroom not re-measured. **OPEN** |
| D3 #35 — payable-side precision | Calculation-version foundation implemented; **variations only**. PO, claim, supplier-invoice, credit-note and release formulas unchanged. **OPEN** |
| D3 #17 — emulator holds the operator's credentials | Fail-closed project and host guard added; credentials themselves NOT isolated (observed with gcloud hidden and with a `demo-` id). **OPEN** |
| DC37 — variation line and concurrency gaps | Narrowed in the repository (TESTING.md §83.5; SECURITY.md DC37). Not live |
| DC4 — approval segregation | Unchanged. Approver's relation to the document now recorded in the audit event |
| Suites | unit 120 / 6,157 · rules 40 / 2,638 · Functions 10 / 273 and 15 / 674 (Node 22) |
| Not done | Browser acceptance; any production step; compiled Rules size |

## E. Test history

Newest first. Add one row per test or step; keep detail in the linked record.

| ID / milestone | Objective | Environment | Result | Evidence | Date | Open issues | Follow-up |
|---|---|---|---|---|---|---|---|
| Closeout / Commercial Finance Phase 1 | Record the cutover, acceptance and Phase 1 closure; correct the five deploy commands; carry forward open requirements; prepare Phase 2 | Repository (docs only) | Architect decision recorded; nothing marked passed that was not run | `docs/commercial-finance-phase-1-closeout` (uncommitted); `git diff --check` clean | 27 Nov 2026 | See B18 carried-forward list | Integration on Product Owner approval; Phase 2 briefs |
| Stage I / Commercial Finance Phase 1 | General availability for Apex Builders | Prod read-only after the Product Owner's operator run | Flag and one audit event; nothing else changed | TESTING.md §82.8 | 27 Nov 03:19–03:20 | Apex baseline on first genuine receipt | — |
| Stage H / Commercial Finance Phase 1 | Consolidated production financial acceptance; GST §44 | Prod, TEST company (Company Admin, `web.app`); REST probes; independent integer-cent calculator | **Accepted within tested scope** — every figure equal; 15 probes refused; 29 audit events exact | TESTING.md §82.5–§82.7; B18 | 27 Nov 02:48–03:12 | Paper layout; Final Account CSV; §44 3a external roles; §22 2–3; role matrix in production | Stage I |
| Cutover A–G, F2 / Commercial Finance Phase 1 | Staged release; non-zero baseline; receipts for all; finance switch | Prod; read-only verification + TEST browser | PASS — each step verified; F2 accepted; F3 accepted | TESTING.md §82.1–§82.4 | 26 Nov 22:30 – 27 Nov 02:44 | First Step A filter failure (corrected); Hosting entry-point cache | Stage H |
| Commercial Finance Phase 1 — final integration safeguards (B17) | Exact historical receipt baseline; cutover with no dual posting path; company-scoped activation; authoritative range | Local: unit runner; Firestore, Storage, Auth and Functions emulators; Chrome on the emulator launcher. Production: read-only aggregate inventory | **PASS locally** — unit 116 / 6,085; rules 40 / 2,632; Functions 9 / 256 and 14 / 623 | TESTING.md §81; ADR-89 S1–S5 | 27 Nov 2026 | D3 #35, #37, #39; compiled Rules size; production acceptance | Architect review; integration on Product Owner approval |
| Commercial Finance Phase 1 — final release-readiness pass (B16) | Remove the receipt scan; server-posted receipts; named void refusals; rounding direction; monetary range; App Check development correction; corrected GST §44; release compatibility | Local: unit runner; Firestore, Storage, Auth and Functions emulators; Chrome against the emulator launcher | **PASS locally** — unit 115 / 6,019; rules 40 / 2,621; Functions 9 / 249 and 13 / 552; browser A–C, GST §44 1a–3b, compatibility 1–6 | TESTING.md §80; ADR-89 A1–A9 | 26 Nov 2026 | D3 #35, #37, #39; compiled Rules size; production acceptance | Architect review; integration on Product Owner approval |
| Commercial Finance Phase 1 — backend correction (B15) | Move posting and voiding to trusted callables; close blockers A and B; reduce the Rules; correct the mixed-tax allocation; complete local acceptance | Local: unit runner; Firestore, Storage, Auth and Functions emulators; Chrome against the emulators with disposable identities. **No production access** | Unit 113 / 5,935; rules 40 / 2,597; Functions 9 / 241 and 12 / 497; browser A–L pass; §44 partial | TESTING.md §79 | 26 Nov 2026 | D3 #35 (payable side), #37, #38; compiled Rules size; load test; refund workflow | Architect review at the integration gate |
| Commercial Finance Phase 1 — implementation (B14) | Client credit notes, client retention, the invoice ledger, exact receivable GST, downstream reports, integrated local acceptance | Local: unit runner; Firestore, Storage, Auth and Functions emulators; Chrome against the emulators with a disposable account. **No production access** | Unit 111 / 5,789; rules 40 / 2,548; Functions 8 / 179 and 11 / 372; browser parity as computed | TESTING.md §78 | 26 Nov 2026 | D3 #35 (payable side), D3 #37 (follow-up), GST §44 manual steps, compiled Rules size, untested browser paths | Architect review at the integration gate; then integration and release, each separately authorised |
| Commercial Finance Phase 1 — assessment / ADR-85 (B13) | Assess the finance architecture, rounding and Rules capacity; recover capacity; propose the client credit-note and retention decisions | Local: unit runner, Firestore and Storage emulators. **No production access** | Recovery implemented and proven equivalent; rules 39 / 2,492 and unit 104 / 5,357 pass; ADR-86 to ADR-88 proposed | TESTING.md §77 | 26 Nov 2026 | D3 #35 (awaiting ruling), D3 #37 (new); compiled size unmeasured | Architect rulings on the nine *(architect)* items, then CF2 / CF4 / CF5 / CF6 |
| D3 #32 production verification / L3 closeout (B12) | Verify the released correction; E2-A / E2-B in production; close L3 | Prod read-only (REST, public Hosting); prod browser as TEST Company Admin on `web.app`, in-page transport injection | Release identity verified; 0 accounts newly restricted; start-up, project access, reload PASS; **E2-A PASS; E2-B PASS (injected)**; E2-C not run (limitation); data unchanged. **D3 #32, D3 #34 CLOSED; L3 Stage 2 CLOSED within scope** | TESTING.md §76; `docs/l3-membership-closeout` (uncommitted) | 26 Nov 2026 | E2-C; D3 #33, #35, #36; GST §44 1–3; Dashboard §22 2–3 | Client credit-note architecture assessment and ADR |
| D3 #32 / membership resolution correction (B11) | Reproduce and correct the false *No active membership*; correct the E2 procedure (D3 #34) | Local emulators (Auth, Firestore); headless Chrome 158, throwaway profile; unit runner. **No production access** | Reproduced on `main`'s source; correction implemented; unit 103 / 5,336 PASS after the architect corrections and release preflight; production membership inventory read-only: 0 newly restricted (regression test fails on the original); role validation added and PASS (unit and local browser); E2-A and E2-B PASS locally; E2-C recorded as a limitation; deactivation, role change, refused read, identity switch and an L3 uncertain write PASS locally | TESTING.md §75; `fix/membership-resolution-state` (uncommitted) | 25 Nov 2026 | Not deployed; production E2-A / E2-B outstanding; 22–25 ms waiting notice on a same-tab re-sign-in (observation) | Architect review → integration → Hosting deploy → TESTING.md §75.9 |
| Closeout / L3 regression acceptance | Architect decision: E1, E3–E10 accepted with limitations; E2 OPEN; GST and Dashboard accepted as far as executed; D3 #32–#34 triaged; D3 #35 recorded; order of work decided | Repository (docs only) | Decision recorded; **L3 not closed**; nothing executed, nothing marked passed that was not run | The six documents on `docs/l3-regression-acceptance` (uncommitted); `git diff --check` clean | 25 Nov 2026 | E2; §44 steps 1–3; §22 checks 2–3; D3 #35 assessment | D3 #32 fix (own brief) |
| L3 E1–E10 / GST hotfix / Dashboard v2 (consolidated) | Release verification; §66 E1–E10; GST hotfix deployment and calculations; §22 Dashboard figures and switching; integrity | Prod read-only (REST; TEST Company Admin on `web.app`); local Auth + Firestore emulators, Vite development server and headless Chrome 158 with failure injection; unit 101 / 5,244, Rules 39 / 2,492, Functions pure 8 / 179 | Deployment of all three PROD-VERIFIED. E1 PASS (prod); E3–E10 PASS (local only); **E2 not passed as written**. GST arithmetic equal to an independent `Decimal` check; §44 steps 1–3 not run. Dashboard figures on six projects equal independent expectations; no stale value | B10; TESTING.md §74; bundle and ruleset hashes; snapshot diffs (test company and Apex unchanged) | 25 Nov 00:32–01:08 | D3 #32–#34; E2–E10 not run in production; §22 checks 2–3 and §44 steps 1–3 unexecuted | Architect decision; D3 #32 correction, then E2 |
| Integration / C1-D closeout | Merge; CI | Git; Azure | `main` `875910e` *Merge C1-D monitoring acceptance closeout* (commit `6e00f98`) — VERIFIED in Git; Azure `main` GREEN — REPORTED by the Product Owner | `git log`; Product Owner | 25 Nov 2026 | — | — |
| C1-C GANTT production acceptance | §40–§42 and the programme parts of §43 / §64 on a new retained CAD fixture: scheduling, dependencies, revision guard, baselines, variance, PULSE parity, CSV, Dashboard; release verification; integrity | Prod, isolated test company (TEST Company Admin, two tabs); local Rules emulator (5 files / 445) and unit suite (101 / 5,244) | **PASS** for every executed check, each equal to an independent calculation; 22 server refusals; one unintended fixture write (DC23) corrected — **functional acceptance CLOSED** (architect, 25 Nov); final fixture dates VERIFIED valid | TESTING §72; B8; fixture `V2Vj8jds7RUkBAmZ1jzm` | 25 Nov 2026 (24 Nov 20:30–21:16 UTC) | Carried forward: print / PDF, Safari / Firefox, Day / Month visuals, baseline outlines, individual filters, G11, offline capture, stale quick-action / cancel; D3 #30, #31 P3 deferred; DC23 → R-7 | C1-D |
| C1-D monitoring and alert delivery | Inventory, repository parity, one approved temporary heartbeat alert (create → incident → natural recovery → delete), historical evidence | Prod Cloud Monitoring / Logging / audit log, read-only except the one temporary policy; Product Owner channel only; `monitoringPolicies.test.js` 24 / 24 | **PASS** D1–D7. Incident 22:29:20 → natural close 22:33:35 UTC; both emails received (REPORTED); L3 availability policy file aligned with production; policy B's 17–18 Nov incident recorded — **CLOSED** (architect, 25 Nov) | TESTING §73; B9; DEPLOYMENT.md → *C1-D alert delivery acceptance record* | 25 Nov 2026 (24 Nov 21:56–22:36 UTC) | Billing-administrator channel not exercised at this run; no policy fired on a real failure; gaps retained (B9) | L3 E1–E10 |
| Integration / L4 and Stage A closeout | Merge; CI | Git; Azure | `main` `8b8c3e5` *Merge L4 and Stage A acceptance closeout* (documentation commit `0062cb7`) — VERIFIED in Git; Azure `main` GREEN — REPORTED by the Product Owner | `git log` | 25 Nov 2026 | — | — |
| Closeout / L4 and Stage A | L4 acceptance CLOSED with recorded limitations; Stage A regression CLOSED within its applicable scope; D3 #27–#29 triaged P2; D3 #28 server-side enforcement inspected | Repository (docs only); local Rules emulator for 12 selected cases — no production access | Architect decision recorded; no authorisation defect found | ROADMAP, TESTING §71, CHATGPT_HANDOVER, this file on `docs/l4-stage-a-acceptance` (uncommitted); `firestore.rules` lines 21–26, 986–988, 1044; `purchaseOrders.rules.test.js`, `externalRoles.rules.test.js`, `externalIsolation.rules.test.js` | 25 Nov 2026 | T14 as `client`, T15, M5 pin, M4 budget-line variant not run; token replay, Apex Storage, Hosting bundle not checked; D3 #27–#29 open | **C1-C GANTT production acceptance** |
| L4 / Stage A / §61 / F16 (consolidated) | T9; Quant step of T16; T14; M3–M8; W2–W4; the F16 notice; final deactivation of the Project Manager, QS and external identity | Prod, isolated test company (new GBP fixture L4; TEST admin, Project Manager, QS and one re-activated `subcontractor` session) | T9, T16 Quant, T14 (`subcontractor`), M3, M4, M8, W2–W4 PASS; F16 notice OBSERVED; M5 in part; M1, M2, M7 stale-bundle superseded | B7; TESTING.md §71; independent Decimal expectations; callable log 200 / 400 / 200 / 403; Rules probes from each role's session; snapshot diffs (Apex identical); reconcile 0 findings | 24 Nov 19:00–19:42 | T14 as `client` not re-run; no real disconnection; M5 pin, M4 budget-line variant not run; D3 #27–#29 | **CLOSED** (architect, 25 Nov) |
| Integration / C1-A closeout | Merge; CI | Git; Azure | `main` `0cf17e6` *Merge C1-A Final Account acceptance closeout* (VERIFIED in Git); Azure `main` GREEN (REPORTED by the Product Owner) | `git log`; Product Owner | 25 Nov 2026 | — | — |
| Closeout / C1-A | C1-A CLOSED; F16 accepted on combined evidence; next milestone set | Repository (docs only) | Architect decision recorded | ROADMAP, TESTING, CHATGPT_HANDOVER, this file on `docs/c1a-final-account-acceptance` (uncommitted) | 25 Nov 2026 | F16 notice not observed in production (carried forward); D3 #22–#26 deferred; self-approval policy gap | L4 remaining acceptance and Stage A internal-role regression |
| C1-A / L2-B (remaining) | F5, F6, F15, F16, F14 native PDF, Project Manager approval, R5 | Prod, isolated test company (dedicated USD fixture Z; TEST admin, QS, PM sessions); R5 read-only on the Apex sandbox | F5, F6, F15, PM approval, F14, R5 PASS; F16 PARTLY | B6; TESTING.md §62c; independent Decimal expectations; stored revision, audit event `LIjIrpnK…`, callable logs; PDF properties and text; snapshot diffs (Apex unchanged) | 24 Nov 10:21–10:53 | F16 notice not observed in production; D3 #22–#26 | **CLOSED** (architect, 25 Nov); F16 notice check carried to the L4 T14 / W4 external session |
| Integration / C1-B closeout | Merge; CI; closure | Git; Azure | Merged `c236bd9` / `2561344` (VERIFIED in Git); Azure green and C1-B CLOSED (REPORTED) | `git log`; Lead Architect | 24 Nov 2026 | — | — |
| C1-B / L2-C (final) | P7 weighted margin and incomplete budget; P9 completed filter; P18 three roles; P15 offline | Prod, isolated test company (NZD fixtures, TEST admin, new PM, re-activated QS); P15 local emulators + headless Chrome | P7, P9, P18 PASS; P15 PASS (local only) | B5; independent Decimal expectations; CSV fingerprints; snapshot diffs (Apex unchanged) | 24 Nov 07:15–07:37 | D3 #20, #21; REST cross-company probe not run | Architect closure decision |
| C1-B / L2-C | Portfolio read-only acceptance: P1–P22 where read-only, M1–M5 | Prod, read-only, Company Admin (Apex), dedicated tab | P1–P6, P8, P12, P13, P21, P22 PASS; P4 5 rows / 55 figures; P7 partial; P9 not exercisable; P15 not run; P18 BLOCKED; M1 10; M4 136 reads | B4; TESTING.md §63; Monitoring read / write / delete counts; worker log | 24 Nov 05:14–05:27 | P18 needs PM / QS (writes); D3 #9, #19 wording | Architect decision on P18 |
| Integration / operator tooling safety | Merge; CI | Git; Azure | Merged `bc64487` / `62e824a`; Azure green (REPORTED) | `git log`; Lead Architect | 24 Nov 2026 | D3 #17; production cleanup untested | — |
| Corrections / operator tooling safety | D3 #16 provisioning link file; `test:team` readiness and Vite host; explicit cleanup-failure reporting | Local emulators + pure tests; `npm run test:team` × 4 (no production) | IMPLEMENTED — PENDING INTEGRATION; automated PASS (pure 179, emulator 367, unit 5,244); launcher PASS | TESTING.md §70 OT15–OT16, runner tests, launcher table; D3 #16 demonstrated on `main` | 24 Nov 2026 | D3 #17 (emulator credentials, `demo-` id) | Architect review → merge |
| Operator tooling safety / D3 #1–#3 | Bootstrap dry-run default; link never printed; graceful termination of four older scripts | Local emulators + pure tests (no production) | IMPLEMENTED — PENDING INTEGRATION; automated PASS | TESTING.md §70 OT1–OT14; pure `operatorTooling.test.js`; hazard measurement and sensitivity check (scratch) | 24 Nov 2026 | D3 #16 (provision link-file real path); production lock behaviour unmeasured | Architect review → merge |
| Closeout / M2-A2 | Stage A, Stage B, DC20 CLOSED; documentation closeout | Repository (docs only) | Architect decision recorded | ROADMAP, PROJECT_DECISIONS, SECURITY, TESTING, DEPLOYMENT, DATA_MODEL, ARCHITECTURE, HANDOVER on `docs/m2-a2-stage-b-closeout` | 24 Nov 2026 | Customer onboarding gated; D1 risks open | D5 |
| Final run / M2-A2 B | X4, X7, P11–P14, final deactivation of both external accounts | Prod, operator + TEST admin + client sessions | PASS | B2 rows *Final pre-flight* … *Final integrity*; B2c timings | 24 Nov 00:28–00:50 | Origin-swap of test sessions (procedure); none in product | Architect closure decision |
| P8–P10 / M2-A2 B | Remove B from the client; X5; copied-link revocation; idempotency | Prod, operator + client session + anonymous | PASS | B2 P9 control, P8, X5, P9, P10: 200 → 403 for the copied link across urgent sweep seq 4; snapshot diff | 24 Nov 00:20–00:24 | Pre-flight token check used a wrong key (corrected) | P11–P14 |
| P7 / M2-A2 B | Client provisioning, email, acceptance on `[A, B]`; live client isolation; X1–X3, X6; P19–P20 | Prod, operator + TEST admin + client session | PASS | B2 P7a–e; B2b: 18 × 200, 80 × 403; snapshot identical during tests | 24 Nov 00:02–00:13 | — | P8–P10 |
| P6 / M2-A2 B | Live subcontractor isolation; §68 X1–X3; §63 P19–P20 | Prod, subcontractor browser session | PASS | B2a: 10 × 200, 58 × 403; UI; snapshot identical | 23 Nov 23:53–23:57 | `/settings` reachable (UX); Portfolio network bodies not decodable | P7 |
| P5 / M2-A2 B | Subcontractor registration and acceptance (completed) | Prod, PO browser | PASS | Auth, profile, member, invitation, audit, lock — one commit time; callable logs | 23 Nov 23:46 | — | P6 needs a session in the testing profile |
| P5 (first report) / M2-A2 B | Subcontractor registration and acceptance | Prod, PO browser | NOT EVIDENCED | Auth lookup 0; invitation pending; no preview / accept request in Cloud Run logs; snapshot unchanged since P4 | 23 Nov 23:41 | Reported complete, absent in production | PO retries; then P5 verification, P6 |
| P4 / M2-A2 B | Resend operator invitation by email | Prod, TEST admin browser | PASS | Invitation + audit read; snapshot diff (4 docs) | 23 Nov 23:38 | — | P5 |
| P3 / M2-A2 B | Operator subcontractor invitation on A | Prod, test company | PASS | Snapshot diff (3 docs); invitation + audit read | 23 Nov 23:30 | — | P4 on authorisation |
| P1–P2 / M2-A2 B | Valid and refused dry runs | Prod, read-only | PASS | 56-line snapshot identical | 23 Nov ~21:35 | Dry run does not print delivery mode | — |
| R3 / M2-A2 B | QS deactivation + urgent revocation | Prod, test company | PASS | Audit seq 2; Auth disabled; sweep log | 23 Nov 21:20 | — | — |
| R2 / M2-A2 B | Internal QS invite, accept, access | Prod, test company | PASS | REST 200 / 403 controls | 23 Nov 20:44 | *Add New Project* to QS | Fix brief (UX) |
| R1 / M2-A2 B | Team page regression | Prod, browser | PASS | listTeam 200; fingerprint unchanged | 23 Nov 20:39 | Top bar title | Cosmetic |
| S3 / M2-A2 B | Projects + fixtures | Prod, test company | PASS | Commit times; md5; backfill 13/13 | 23 Nov 20:30 | — | — |
| S2 / M2-A2 B | Admin acceptance | Prod, test company | PASS | One commit time across 4 docs | 23 Nov 20:22 | — | — |
| S1 / M2-A2 B | Test-company bootstrap | Prod | PASS | Company + invitation + audit read | 23 Nov 20:10 | — | — |
| Deploy / M2-A2 B | Three callables live, source = `main` | Prod | PASS | Source archive diff | 23 Nov | Docs said NOT DEPLOYED — corrected in the 24 Nov closeout | — |
| §68 / M2-A2 A | Paired writes, directory, rulesets | Prod | PASS | §68 table | 23 Nov | X1–X6 not run | Stage B P6–P8 |
| C1-B / L2-C | Portfolio parity and timings | Prod, read-only | P4 PASS; M2 measured | Report to architect | 22 Nov | Subtotal wording; P18–P20, M4 | Record in §63 |
| C1-A / L2-B | Final Account positive path + correction retest | Prod sandbox | PASS (listed items) | §62b | 22 Nov | Role checks, F14 | Role sessions |
| L4 / ADR-81 | BOQ → budget transfer | Prod sandbox | PASS (listed items) | §67 | 22 Nov | T9, T14, T16 Quant | — |
| §59 / DC46 | Final external-member acceptance | Prod | PASS | §59 | 18 Nov | Accepted risks | — |

---

## F. Release gates

| Milestone | Implemented | Deployed | Emulator-tested | Accepted in production | Blocked | Deferred |
|---|---|---|---|---|---|---|
| M2-A2 Stage A (ADR-83) | Yes | Yes | Yes | **Yes — CLOSED** (23 Nov); external X1–X7 PASSED (24 Nov); internal regression M3, M4, M8 PASSED (B7, 24 Nov), M5 in part; M1, M2 and the stale-bundle part of M7 superseded, never verified — **regression CLOSED within its applicable scope** (25 Nov) | — | — |
| M2-A2 Stage B (ADR-84) | Yes | Yes (3 callables) | Yes | **Yes — CLOSED** (24 Nov): S1–S3, R1–R3, P1–P14 PASS; **DC20 CLOSED** | Real customer external onboarding (readiness decision) | — |
| Operator tooling safety (D3 #1–#3, #16, #18) | Yes — **merged** `62e824a` | Not applicable (scripts and local launcher only; no deployment) | Yes (§70); `test:team` end-to-end PASS ×4; Azure green (REPORTED) | Not required (architect); production cleanup never exercised | — | D3 #17 |
| L2-B Final Account (ADR-77) | Yes | Yes | Yes | **Yes — CLOSED** (25 Nov, REPORTED) — positive path (22 Nov); role checks, Project Manager approval, native PDF, R5 (24 Nov, B6); the F16 restricted notice not observed at closure (accepted on combined evidence) and since **observed in production** (B7, 24 Nov) | — | — |
| L2-C Portfolio (ADR-78) | Yes | Yes | Yes (unit) | **Yes — CLOSED** (24 Nov, REPORTED) — B4 read-only run, B5 P7 / P9 / P18 PASS; P19–P20 PASSED; P15 local only; M1, M4 measured | — | — |
| L4 transfer (ADR-81) | Yes | Yes | Yes | **Yes — CLOSED** (22 Nov; remaining acceptance CLOSED with recorded limitations 25 Nov, REPORTED): T9, the Quant step of T16 and T14 as `subcontractor` PASSED (B7, 24 Nov); T14 as `client` accepted on earlier production and emulator evidence; a real disconnection not run | — | — |
| GANTT 1A1 / 1A2 / 1B, PULSE 1C, ADR-79 (C1-C) | Yes | Yes (bundle SHA-256-verified 25 Nov) | Yes | **Functional acceptance CLOSED** (25 Nov, REPORTED; B8) — presentation, browser and resilience checks carried forward, not passed; role evidence accepted | — | Progress variance, programme indicators on Overview / Portfolio: not built |
| L3 Stage 2 (ADR-80) | Yes | Yes (bundle SHA-256-verified 25 Nov) | Yes | **Yes — CLOSED within its accepted scope (26 Nov; B12).** *As written before:* **Not closed (architect, 25 Nov — REPORTED):** E1 (production) and E3–E10 (local emulators only) accepted with their limitations; **E2 OPEN** (D3 #32) | E2, after the D3 #32 fix | — |
| D3 #32 membership resolution correction | Yes — `main` `0bdca38` | **Yes — Hosting release `edc2bf6f34568d78`, 25 Nov 20:32 UTC; bundle PROD-VERIFIED 26 Nov** | Yes (unit 103 / 5,336; local browser acceptance, B11) | **Yes — CLOSED** (26 Nov; B12): start-up, access, reload; E2-A and E2-B under in-page injection | — | E2-C (offline start-up — future PWA) |
| DC46 (ADR-73–75) | Yes | Yes | Yes | Yes — CLOSED 18 Nov | — | Stage 4 volume |
| Commercial Finance Phase 1 (ADR-85–89) | Yes — `main` `9e31bb0` (+ config `0f623c6`, `4c54a45`, `c9df38b`) | **Yes — steps A–G 26–27 Nov; GA (Apex) 27 Nov 03:19 UTC** | Yes (unit 116 / 6,085; rules 40 / 2,632; Functions 9 / 256, 14 / 623) | **Yes — CLOSED within its accepted scope** (27 Nov; B18) | — | Paper layout, Final Account CSV, §44 3a external roles, production role matrix; D3 #35 / #36 / #37 / #39; callable alerts; refunds; load test; tax compliance |
| GST boundary hotfix | Yes | **Yes — Rules and Hosting PROD-VERIFIED 25 Nov** (release dates unrecorded) | Yes (Rules 39 / 2,492) | **Calculation compatibility accepted (architect, 25 Nov — REPORTED):** stored figures of fixture Z agree with exact decimals; the app, the Rules pins and an independent implementation agree on what is admitted. §44 corrected steps 1, 2 and the financial parts of 3 **PASSED in production 27 Nov (B18)**; the external-role checks of 3a not run. *As written:* §44 manual acceptance 1–3 **outstanding — not run** in production. Precision concern D3 #35 open (payable side) | — | §44 3a external-role checks; D3 #35 payable side |
| Premium Dashboard v2 (ADR-45) | Yes | **Yes — PROD-VERIFIED 25 Nov** (release date unrecorded) | Yes (unit) | **Tested financial calculations accepted (architect, 25 Nov — REPORTED):** §22 check 1 PASS without throttling (six projects, five currencies, independent expectations, no stale value); checks 2 and 3 **open — not run** | — | §22 checks 2 and 3 |
| General App Check enforcement | No | — | — | — | — | Yes |
| Xero (ADR-82) | No | — | — | — | PMF gate | Yes |
| Constrap IQ / Quant AI | No | — | — | — | — | Yes |
| Billing, self-serve signup, client portal | No | — | — | — | — | Yes |

---

## Maintaining this file

- **This file is the central acceptance and progress index.** Every milestone
  closeout updates it in the same change as the TESTING.md record it
  summarises; link to procedures and ADRs rather than copying them.
- A result needs evidence: a TESTING.md section, a read-only production read,
  or a named report. Without one it stays NOT RUN.
- Never record credentials, invitation links, tokens, password-reset links or
  personal email addresses here.
- When a status changes, change the row; keep history in section E, not by
  striking text through.


**Phase 2 steps 3–6 (28 November 2026 — IMPLEMENTED, NOT DEPLOYED; local / emulator evidence, TESTING.md §85–§87).** Closed IN CODE, pending release: Deferred Control 36 for claims (one open claim per PO — authoritative per-PO claim ledger); DC40 (claim line contents — derived and verified by the backend); DC24 (release aggregate cap), DC25 (credit cumulative cap), DC18 (payment allocation cap) — authoritative per-invoice ledger; G1 (credits on retained invoices), G2 (authoritative cumulative caps), G3 (dependency-safe voids); D8 (client invoice void with money recorded — ADR-95); DC4 approval segregation available as an operator-controlled company policy (ADR-96, disabled by default); G5 original contract value protected. Open: production history inventory before release (supplier and variation); per-user rate limiting of the new callables; duplicate external references (DC9); the Rules-held approvals compare creator / last updater only; G4, G6, DC15 (Phase 3).
