# Security, Data Integrity & Production Acceptance — Test Tracker

One running record of what has been tested, where, with what result, and what
is still open. It **summarises and links**; it does not repeat procedures.
Procedures and full records live in [TESTING.md](TESTING.md); controls and
accepted risks in [SECURITY.md](SECURITY.md); decisions in
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md); releases in
[DEPLOYMENT.md](DEPLOYMENT.md); order of work in [../ROADMAP.md](../ROADMAP.md);
the operational checkpoint in [CHATGPT_HANDOVER.md](CHATGPT_HANDOVER.md).

**Last updated:** 25 November 2026 — **C1-A CLOSED** (Lead Architect decision, 25 Nov 2026 — REPORTED; F16 accepted on combined evidence, its restricted notice not observed in production; next milestone L4 remaining acceptance and Stage A internal-role regression). Run of 24 November 2026 (C1-A Final Account remaining acceptance, 10:21–10:53 UTC — section B6: F5, F6, F15, Project Manager approval, F14 native PDF and R5 PASS in production on a dedicated USD fixture in the isolated test company; F16 PARTLY — the restricted notice was not observed in production. **C1-B CLOSED** — closeout merged as `c236bd9`, merge `2561344`; Azure `main` CI GREEN — both REPORTED by the Lead Architect). Prepared on `docs/c1a-final-account-acceptance` (uncommitted, documentation only).
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
| Current milestone | **None in progress. C1-A — L2-B Final Account: CLOSED** (Lead Architect decision, 25 Nov 2026 — REPORTED; B6) — F5, F6, F15, Project Manager approval, F14 native PDF and R5 PASS in production (24 Nov); F16 **accepted on combined evidence** (no figure reaches a signed-out, deactivated or non-financial account in production; the restricted notice itself was **not** observed in production — unit test only; its browser check is carried forward to the external-role session of L4 T14 / §61 W4). **C1-B — L2-C Portfolio: CLOSED** (Lead Architect, 24 Nov 2026 — REPORTED; closeout merged `c236bd9` / `2561344`; Azure `main` GREEN — REPORTED). *As written for the previous revision:* **C1-B — L2-C Portfolio acceptance — final targeted run COMPLETE (24 Nov 2026), awaiting architect closure decision** — P7, P9, P18 PASS in production (B5); P15 PASS on local emulators only; financial parity ACCEPTED by the architect (B4). *As written after the read-only run:* read-only production run COMPLETE; NOT closed (P18 blocked on internal-role sessions — section B4). **Operator tooling safety (D3 #1–#3, #16, #18, R-6) — INTEGRATED** (merged as `bc64487`, merge `62e824a`; no deployment required). Last closed: **M2-A2 External Project Isolation** — Stage A (ADR-83) and Stage B (ADR-84) **LIVE and CLOSED**; **Deferred Control 20 CLOSED** (Lead Architect, 24 Nov 2026) |
| Release status | Stage B merged as `cddfca8`, `main` `bd9021c`. Three callables live since 23 Nov 2026 ~09:11 UTC — `acceptinvitation-00005-mol`, `deactivatemember-00005-suy`, `resendinvitation-00005-mer`; source identical to `main`; other eight services unchanged; Firestore `67b6425a…`, Storage `2f3a4788…`, Hosting `index-BOg2hoYg.js` unchanged (PROD-VERIFIED 23–24 Nov) |
| Acceptance | **Complete (24 Nov 2026 00:50 UTC):** S1–S3, R1–R3, P1–P14 PASS; §68 X1–X7 PASS (X1–X3, X6 for both external roles); §63 P19–P20 PASS for both roles with the network-payload limitation; reconcile 0 findings; directory 13 / 13; Apex unchanged. Recorded in TESTING.md §63, §68, §69 (closeout branch `docs/m2-a2-stage-b-closeout`) |
| Documentation | Closeout merged to `main` (`a219deb`, merge `2e48a2a`; VERIFIED in Git 24 Nov). *As written:* closeout on `docs/m2-a2-stage-b-closeout` (uncommitted): ROADMAP, PROJECT_DECISIONS (ADR-83 / ADR-84 closure records), SECURITY (DC20, Stage A / B), TESTING, DEPLOYMENT (release record), DATA_MODEL, ARCHITECTURE, CHATGPT_HANDOVER, this file |
| Next step | **L4 remaining acceptance and M2-A2 Stage A internal-role regression** (Lead Architect, 25 Nov 2026; C4) — needs its own brief. Git integration of `docs/c1a-final-account-acceptance` is authorised by the closure decision and not yet done (uncommitted). The TEST Project Manager and QS stay **active** (architect, 25 Nov). *As written before the decision:* Architect decision on C1-A closure (B6, C4 — recommended GO with the F16 notice recorded as not observed in production, or one external-session check first). *As written for the previous revision:* Architect decision on **C1-B closure** (B5 — recommended GO with P15 local-only and the measurement limits recorded) and on the final state of the two internal test identities (PM and QS, both active). Then the next C1 item — C1-A Final Account role checks can reuse the same PM / QS identities. *As written after the read-only run:* a decision on P18 — not to be run in Apex Builders (architect, 24 Nov) |
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
| C1-A | L2-B Final Account | **CLOSED** (Lead Architect, 25 Nov 2026 — REPORTED; B6). **Carried forward, not blocking:** the F16 *Final Account is restricted* notice for a signed-in non-financial account — still not observed in production (the property behind it — no figure, Rules denial — is proven); to be checked in the external-role session of L4 T14 / §61 W4. Limits kept: R5 on stored-state evidence only; client invoices, receipts, payments, retention and variations at zero on the accepted Final Accounts; contention, forged-draft refusal by the callable and 5xx paths emulator-only; D3 #10, #22–#26 (deferred bundle) | Positive path F3, F4, F7–F13, F17 (22 Nov); correction retested R1–R4; **24 Nov (B6): F5, F6, F15, Project Manager approval, repeated approval, protection after approval, F14 native PDF, R5** | For the F16 notice only: one active external session on an assigned project — the session L4 T14 also needs | §62, §62b, §62c; B6 |
| C1-B | L2-C Portfolio | **CLOSED** (Lead Architect, 24 Nov 2026 — REPORTED; closeout merged `c236bd9` / `2561344`). *As written:* None blocking — architect closure decision (B5). Limits kept: P15 local only; P10, P11, P14, P16, P17 rest on the REPORTED visual / export acceptance; M3, M5 not measurable; P19 payloads not decoded; REST-level cross-company probe as PM / QS not run. Deferred UX: D3 #9, #19, #20, #21 | Visual, CSV, PDF (REPORTED 20 Nov); P19–P20 PASS for both external roles (24 Nov; payloads not decoded); **read-only run 24 Nov (B4): P1–P6, P8, P12, P13, P21, P22 PASS, P7 partial, P4 five rows to the cent, M1, M4 measured** | — (PM / QS identities and NZD fixtures now exist in the test company) | §63; B4; B5 |
| C1-C | GANTT | Baseline scenarios not exercised in the browser; no per-step record for ADR-79 | 1A1 / 1A2 / 1B / PULSE 1C live bundle VERIFIED; GANTT core completion PO-accepted (REPORTED) | A test project with a programme | §42, §64 |
| C1-D | Monitoring | A notification-delivery test of the L3 alert policies; no alert has fired on a real condition | Policies and uptime check created (VERIFIED read-only 21 Nov); DC46 policy email path REPORTED | An authorised synthetic trigger | §65; DEPLOYMENT.md |
| L3 | Stage 2 error recovery | E1–E10 browser acceptance | Live through the L4 Hosting release (REPORTED) | Browser session; controlled offline | §66 |
| L4 | BOQ → budget transfer | T9 server stale refusal; T14 restricted roles; the Quant step of T16; a real disconnection | T1–T8, T10–T13, T15, T16 PASS (22 Nov); UX correction PASS | A forced race; restricted-role sessions | §67 |
| M2-A2 A | Stage A internal regression | M1, M2, M4, M5, M7, M8 (M3 run as Company Admin only; M6 PASS) | External X1–X7 PASS | Internal-role sessions | §68 |
| L2-B A | Rules capacity recovery 3 smoke | W2–W4 | Live ruleset byte-identical (VERIFIED 19 Nov) | Financial-role session | §61 |
| Evidence | Production state unconfirmed | GST boundary hotfix (merged `ea2eea8`); Premium Dashboard v2 (merged `ba52821`) | Both VERIFIED merged | Product Owner confirmation, or a read-only bundle check | §44, §22; handover F |

**Next milestone (Lead Architect, 25 Nov 2026):** L4 remaining acceptance (T9,
T14, the Quant step of T16 — row *L4*) and the M2-A2 Stage A internal-role
regression (M3–M5, M7, M8 — row *M2-A2 A*). The external-role session T14
needs also carries the F16 notice check (C1-A) and §61 W4.

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
| R-5 | **Internal regression unrecorded.** TESTING.md §68 M1, M2, M4, M5, M7, M8 | Reliability | Open — untested, not failed | §68 | C4 row *M2-A2 A* |
| R-6 | **Operator tooling safety.** `bootstrap-company.mjs` wrote by default and printed its acceptance link; four older scripts called `process.exit(1)` after a refused transaction (lock held until timeout) | Operator safety | **MITIGATED — INTEGRATED** (merged as `bc64487`, merge `62e824a`, 24 Nov 2026; Azure `main` green — REPORTED by the Lead Architect; no deployment required). D3 #1–#3, #16, #18 complete. **Not tested against production:** transaction cleanup after a refused production transaction is proven on the emulator only. Remaining: scripts validate, they do not authorise (R-2); a link file proves nothing about the mailbox; local emulators hold the operator's CLI login (D3 #17) | ADR-84 lessons; Stage B S1; TESTING.md §70 (EMULATOR) | None for this item; D3 #17 separately |

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

### D3. Defect and finding register (#1–#3, #16, #18 integrated in `62e824a`; #9 assessed, #19–#21 recorded by C1-B, 24 Nov; #9 and #19 deferred by the architect; #22–#26 recorded by C1-A, 24 Nov, and placed in the deferred UX and reporting correction bundle by the architect, 25 Nov)

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
| 12 | Three source comments still say *DC46 — still OPEN* | Documentation | Open | P3 | Next change in those files | Opportunistic | Handover A |
| 13 | SECURITY.md *Known limitations* still says every Storage object carries its token (superseded by DC46 sweeps) | Documentation | Open | P3 | — | Next SECURITY.md change | Observed 24 Nov |
| 14 | Operator checks must read `custom_fields` for Storage download tokens; zsh needs `${VAR}:method` braces in REST URLs | Operator tooling note | Recorded | — | — | Runbook note | Stage B |
| 15 | Testing-profile sessions are per origin and replaced by any sign-in on that origin; sign-ins in another browser do not reach it | Test procedure | Recorded | — | — | Test procedure | Stage B P5, P13, final |
| 16 | `provision-external-member.mjs --link-file` checks the repository boundary on the typed path; a folder that is a symbolic link into the working tree is not caught (final-component and existing-file checks are sound) | Operator safety | **COMPLETE — INTEGRATED** (`62e824a`) — the hole demonstrated on `main` `2e48a2a` (exit 0, link file created in the repository; emulator); now `_linkFile.mjs` (real path, O_EXCL + O_NOFOLLOW, 0600, reserved before the write); exit 3 on a post-commit delivery failure with Resend recovery; no rotation, no duplicate (EMULATOR: §70 OT15–OT16) | P1 (raised by the architect) | — | Operator tooling safety — done | Operator tooling safety |
| 17 | `npm run test:team` / `test:functions`: the Firebase CLI makes one authenticated metadata request for the emulator project id (403 — no access; no production project read) and hands the operator's CLI login to the Functions emulator as credentials; Storage and Pub/Sub are not emulated there | Local tooling / security | Open — limitation recorded | P3 | Design | Use a `demo-` emulator project id (separate change: `.env`, harness, suites) | Launcher end-to-end run, 24 Nov |
| 19 | Reports tab (L2-A) shows a working budget under its *Approved budget* card, with the sub-label *Working budget (not approved)*; the Portfolio shows the same value as *Not approved* with the working amount beneath | UX — wording (observation; values identical; pre-dates L2-C) | Open — **deferred** (architect) | P3 | — | UX fix bundle, if accepted | C1-B (24 Nov; B4) |
| 20 | Forecast tab: after the first *Save all changes* on a project, the page kept showing *Not forecast* / FFC 0 although the forecast line was written (REST-verified); a reload showed the saved figure. Seen once in two saves, not reproduced | Reliability / UX — display only (stored value and every other surface correct) | Open — needs a reproduction (not reproduced on fixture Z's first save, 24 Nov 10:28) | P3 | Reproduction | UX / reliability bundle | C1-B B5 (fixture X, 07:18) |
| 21 | Portfolio status line reads *All N projects have been read.* when every read failed (offline); the coverage notice below it is correct | UX — wording | Open | P3 | — | UX fix bundle (with #9) | C1-B B5 (P15, local) |
| 18 | `npm run test:team` did not wait for the Auth emulator (first-run bootstrap `ECONNREFUSED :9099`) and probed Vite on `127.0.0.1` while Vite 8 bound `::1` only (*Starting Vite… failed*) | Local tooling | **COMPLETE — INTEGRATED** (`62e824a`) — bounded readiness for Auth, Firestore, Functions and the CLI ready signal; Vite `--host 127.0.0.1`; bounded shutdown wait. End-to-end PASS, four fresh runs (§70) | P2 | — | Operator tooling safety — done | First implementation report |
| 22 | Final Account PDF: the *COST (EX-GST)* group heading prints as the last line of page 1 while its figures start on page 2; the single figures card runs across all three pages | UX — print layout (cosmetic; every figure present, legible and unclipped) | Open — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle (Hosting-only): keep a group heading with its first row of figures | C1-A B6 (native PDF, Chrome 157, macOS) |
| 23 | Final Account PDF: Chrome's default *Headers and footers* option prints the date, the tab title (*Constrap* — not the project or revision) and the full page URL, project id included, on every page | Observation — a browser option the user can untick; not application content | Recorded — **deferred** (architect, 25 Nov) | P3 | Decision | Deferred UX and reporting correction bundle — optional: a project / revision document title while printing; user guidance | C1-A B6 |
| 24 | Final Account status line reads *No Final Account has been prepared for this project.* when the only revision is a withdrawn draft (the revision history below lists it) | UX — wording | Open — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle | C1-A B6 (fixture Z, after revision 1 was withdrawn) |
| 25 | The approver's role is stored on an approved revision (`approvedByRole`), but no surface shows it — screen, CSV and PDF give the approver's name and the time only | Observation — audit presentation | Recorded — **deferred** (architect, 25 Nov) | P3 | Architect decision | Deferred UX and reporting correction bundle | C1-A B6 |
| 26 | Final margin precision differs by surface: stored value and CSV two decimals (29.73), screen, PDF and Portfolio one decimal (29.7%) | Observation — presentation only; one stored value | Recorded — **deferred** (architect, 25 Nov) | P3 | — | Deferred UX and reporting correction bundle (no change proposed yet) | C1-A B6 |

### D4. Implementation roadmap (strategic order unchanged)

| State | Items |
|---|---|
| **Implemented and production-accepted** | Commercial foundations; M1, M2-A, M2-B1/B2/B3, M3-A/B1/B2; SHIELD 2A / 2B1 / 2B2; L1 Team Management; DC46 (closed with accepted risks); L2-A; L2-B Stage A; L4 (closed with listed gaps); **M2-A2 Stage A and B (DC20 closed)**; **L2-C Portfolio (C1-B CLOSED, 24 Nov — REPORTED)**; **L2-B Final Account (C1-A CLOSED, 25 Nov — REPORTED; F16 notice not observed in production and carried forward; R5 on stored-state evidence; zero-only client-side and cash scenarios — B6)**. *Integrated, no production acceptance required:* operator tooling safety (`62e824a`) |
| **Implemented, not fully accepted** | GANTT 1A1 / 1A2 / 1B and core completion (C1-C); L3 Stage 1 alerting (C1-D) and Stage 2 (E1–E10); GST boundary hotfix and Premium Dashboard v2 (production evidence) |
| **Known defects requiring fixes** | D3 #4–#9, #19, #21 (UX; #9, #19, #21 wording only), #22 and #24 (Final Account print layout and wording — deferred bundle with #23, #25, #26), #20 (needs reproduction), #17 (local tooling). D3 #1–#3, #16, #18 complete (`62e824a`) |
| **Security hardening** | D1 R-1 … R-6; general App Check enforcement; DC46 follow-ups (Storage audit logs, faster revocation, drawing-revision policy, load testing at triggers); billing-account administration |
| **Not yet implemented** | Real customer external onboarding (gated); self-serve company signup; billing and subscriptions; client portal; client credit notes and client retention; estimating; creator ≠ approver segregation on Final Account; company legal / tax identity; client-side error reporting; external availability monitor |
| **Deferred (order per ROADMAP → *Approved development order (post-L4)*)** | 1 remaining core functionality and acceptance (C1) → 2 SaaS readiness and international foundations → 3 mobile / PWA → 4 Xero (ADR-82 PROPOSED) → 5 Constrap IQ → 6 Quant AI → 7 final production audit. Stage 8 advanced modules unscoped |

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

---

## E. Test history

Newest first. Add one row per test or step; keep detail in the linked record.

| ID / milestone | Objective | Environment | Result | Evidence | Date | Open issues | Follow-up |
|---|---|---|---|---|---|---|---|
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
| M2-A2 Stage A (ADR-83) | Yes | Yes | Yes | **Yes — CLOSED** (23 Nov); external X1–X7 PASSED (24 Nov); internal regression M1, M2, M4, M5, M7, M8 not recorded | — | — |
| M2-A2 Stage B (ADR-84) | Yes | Yes (3 callables) | Yes | **Yes — CLOSED** (24 Nov): S1–S3, R1–R3, P1–P14 PASS; **DC20 CLOSED** | Real customer external onboarding (readiness decision) | — |
| Operator tooling safety (D3 #1–#3, #16, #18) | Yes — **merged** `62e824a` | Not applicable (scripts and local launcher only; no deployment) | Yes (§70); `test:team` end-to-end PASS ×4; Azure green (REPORTED) | Not required (architect); production cleanup never exercised | — | D3 #17 |
| L2-B Final Account (ADR-77) | Yes | Yes | Yes | **Yes — CLOSED** (25 Nov, REPORTED) — positive path (22 Nov); role checks, Project Manager approval, native PDF, R5 (24 Nov, B6); the F16 restricted notice not observed in production (accepted on combined evidence; browser check carried forward) | — | — |
| L2-C Portfolio (ADR-78) | Yes | Yes | Yes (unit) | **Yes — CLOSED** (24 Nov, REPORTED) — B4 read-only run, B5 P7 / P9 / P18 PASS; P19–P20 PASSED; P15 local only; M1, M4 measured | — | — |
| L4 transfer (ADR-81) | Yes | Yes | Yes | Yes (CLOSED) with listed gaps | — | — |
| L3 Stage 2 (ADR-80) | Yes | Yes | Yes | Not recorded (E1–E10) | — | — |
| DC46 (ADR-73–75) | Yes | Yes | Yes | Yes — CLOSED 18 Nov | — | Stage 4 volume |
| GST boundary hotfix | Yes | Unconfirmed | Yes | Not recorded | — | — |
| Premium Dashboard v2 (ADR-45) | Yes | Unconfirmed | Yes | Not recorded | — | — |
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
