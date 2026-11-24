# Security, Data Integrity & Production Acceptance — Test Tracker

One running record of what has been tested, where, with what result, and what
is still open. It **summarises and links**; it does not repeat procedures.
Procedures and full records live in [TESTING.md](TESTING.md); controls and
accepted risks in [SECURITY.md](SECURITY.md); decisions in
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md); releases in
[DEPLOYMENT.md](DEPLOYMENT.md); order of work in [../ROADMAP.md](../ROADMAP.md);
the operational checkpoint in [CHATGPT_HANDOVER.md](CHATGPT_HANDOVER.md).

**Last updated:** 24 November 2026 (operator tooling safety, D3 #1–#3 and #16 — IMPLEMENTED — PENDING INTEGRATION on `feature/operator-tooling-safety`, uncommitted; architect corrections applied: provisioning link file, local launcher, shutdown reporting). Earlier the same day: M2-A2 final closeout — Stage A, Stage B and DC20 CLOSED by the Lead Architect.
`main` `2e48a2a`.

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
| Current milestone | **Operator tooling safety (D3 #1–#3, #16, R-6) — IMPLEMENTED — PENDING INTEGRATION** (24 Nov 2026; architect accepted the design and its corrections are applied; scripts, local launcher and tests only; no deployment). Last closed: **M2-A2 External Project Isolation** — Stage A (ADR-83) and Stage B (ADR-84) **LIVE and CLOSED**; **Deferred Control 20 CLOSED** (Lead Architect, 24 Nov 2026) |
| Release status | Stage B merged as `cddfca8`, `main` `bd9021c`. Three callables live since 23 Nov 2026 ~09:11 UTC — `acceptinvitation-00005-mol`, `deactivatemember-00005-suy`, `resendinvitation-00005-mer`; source identical to `main`; other eight services unchanged; Firestore `67b6425a…`, Storage `2f3a4788…`, Hosting `index-BOg2hoYg.js` unchanged (PROD-VERIFIED 23–24 Nov) |
| Acceptance | **Complete (24 Nov 2026 00:50 UTC):** S1–S3, R1–R3, P1–P14 PASS; §68 X1–X7 PASS (X1–X3, X6 for both external roles); §63 P19–P20 PASS for both roles with the network-payload limitation; reconcile 0 findings; directory 13 / 13; Apex unchanged. Recorded in TESTING.md §63, §68, §69 (closeout branch `docs/m2-a2-stage-b-closeout`) |
| Documentation | Closeout merged to `main` (`a219deb`, merge `2e48a2a`; VERIFIED in Git 24 Nov). *As written:* closeout on `docs/m2-a2-stage-b-closeout` (uncommitted): ROADMAP, PROJECT_DECISIONS (ADR-83 / ADR-84 closure records), SECURITY (DC20, Stage A / B), TESTING, DEPLOYMENT (release record), DATA_MODEL, ARCHITECTURE, CHATGPT_HANDOVER, this file |
| Next step | Architect review and Git integration of `feature/operator-tooling-safety` (section D5); the M2-A2 closeout branch is merged (`2e48a2a`) |
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
| L2-B Final Account (ADR-77) + C1-A | F3, F4, F7–F13, F17 PASS in sandbox; forecast-readiness correction live; retest R1, R2, R4 PASS, R3 blocking PASS | PROD-VERIFIED (22 Nov) | §62, §62b |
| L2-C Portfolio (ADR-78) | Visual, CSV, PDF acceptance | PROD-REPORTED (20 Nov) | §63 |
| C1-B Portfolio | P4 row parity to the cent; M2 load timings | PROD-VERIFIED (22 Nov) — report to architect, **not yet recorded in TESTING.md** | §63 |
| GANTT 1A1/1A2/1B, PULSE 1C, GANTT core completion (ADR-79) | Live bundle verified; PO accepted | PROD-VERIFIED (bundle) + PROD-REPORTED | §40–§43, §64 |
| L3 Stage 1 monitoring + restoration verification | Monitoring created; restore SUCCESSFUL (counts + one sample hash) | PROD-VERIFIED (monitoring) + PROD-REPORTED (restore) | §65 |
| L4 BOQ → working budget (ADR-81) | T1–T8, T10–T13, T15, T16 PASS; UX correction PASS | PROD-VERIFIED (22 Nov) | §67 |

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

### C3. Portfolio — [TESTING.md §63](TESTING.md) — P19–P20 COMPLETE; P18, M1–M5 open

| ID | Objective | Status |
|---|---|---|
| P19 | External user: no Portfolio entry; `/portfolio` restricted; no financial request | **PASS** — subcontractor and client: no entry, restricted message; only the Auth lookup and shared Listen channel seen (bodies not decodable — B2a limits) |
| P20 | External user: direct financial read denied by Rules | **PASS** — subcontractor (24 reads on A → 403) and client (48 reads on A and B → 403) |
| P18 | Role-specific access (PM / QS) | NOT RUN — needs PM / QS sessions |
| M1–M5 | Performance | M2 measured (C1-B); M4 needs one isolated load; M3 premise wrong (WebChannel); M5 not measurable cross-origin |

### C4. Remaining acceptance roadmap

Reconciled against TESTING.md, ROADMAP.md and CHATGPT_HANDOVER.md on 24 Nov
2026. Detail and procedures stay in the linked TESTING.md sections. *C1* is
the roadmap's proposed **Core acceptance closeout** (PROPOSED — not
approved); its IDs below are the Lead Architect's.

| ID | Area | Remaining | Already done (do not reopen) | Needs | Record |
|---|---|---|---|---|---|
| C1-A | L2-B Final Account | Role checks F5, F6, F15, F16 and Project Manager approval; F14 native print dialog and a PDF file; retest R5 | Positive path F3, F4, F7–F13, F17 PASS in production (22 Nov); forecast-readiness correction live and retested (R1, R2, R4, R3 blocking) | PM / QS / second-user sessions on a test project | §62, §62b |
| C1-B | L2-C Portfolio | P18 (PM / QS); row-to-Reports-tab parity as a recorded acceptance; M1–M5 (M4: one isolated load; M3 premise wrong; M5 not measurable cross-origin) | Visual, CSV, PDF (REPORTED 20 Nov); **P19–P20 PASS for both external roles** (24 Nov; payloads not decoded); a P4 read-only run on four rows (22 Nov, reported — not recorded as accepted) | PM / QS sessions; a quiet window for M4 | §63 |
| C1-C | GANTT | Baseline scenarios not exercised in the browser; no per-step record for ADR-79 | 1A1 / 1A2 / 1B / PULSE 1C live bundle VERIFIED; GANTT core completion PO-accepted (REPORTED) | A test project with a programme | §42, §64 |
| C1-D | Monitoring | A notification-delivery test of the L3 alert policies; no alert has fired on a real condition | Policies and uptime check created (VERIFIED read-only 21 Nov); DC46 policy email path REPORTED | An authorised synthetic trigger | §65; DEPLOYMENT.md |
| L3 | Stage 2 error recovery | E1–E10 browser acceptance | Live through the L4 Hosting release (REPORTED) | Browser session; controlled offline | §66 |
| L4 | BOQ → budget transfer | T9 server stale refusal; T14 restricted roles; the Quant step of T16; a real disconnection | T1–T8, T10–T13, T15, T16 PASS (22 Nov); UX correction PASS | A forced race; restricted-role sessions | §67 |
| M2-A2 A | Stage A internal regression | M1, M2, M4, M5, M7, M8 (M3 run as Company Admin only; M6 PASS) | External X1–X7 PASS | Internal-role sessions | §68 |
| L2-B A | Rules capacity recovery 3 smoke | W2–W4 | Live ruleset byte-identical (VERIFIED 19 Nov) | Financial-role session | §61 |
| Evidence | Production state unconfirmed | GST boundary hotfix (merged `ea2eea8`); Premium Dashboard v2 (merged `ba52821`) | Both VERIFIED merged | Product Owner confirmation, or a read-only bundle check | §44, §22; handover F |

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
| R-6 | **Operator tooling safety.** `bootstrap-company.mjs` writes by default and prints its acceptance link; four older scripts call `process.exit(1)` after a refused transaction (lock held until timeout) | Operator safety | **IMPLEMENTED — PENDING INTEGRATION** (24 Nov 2026) — not closed. D3 #16 corrected in the same change. Remaining: scripts validate, they do not authorise (R-2); a link file proves nothing about the mailbox; local emulators hold the operator's CLI login (D3 #17) | ADR-84 lessons; Stage B S1; TESTING.md §70 (EMULATOR) | Architect review → merge → Azure green (no production dry run needed — architect) |

**Decided, not a risk:** a Company Admin may *Resend* or *Revoke* an
operator-created external invitation — permitted under ADR-84 for as long as
neither can change the role or the assignment (Lead Architect, 24 Nov 2026).

### D2. Other data-integrity and lifecycle limits (unchanged by M2-A2)

- Copied download URLs and the 2-hour periodic interval (ADR-75) — see R-1.
- Final Account: an approved revision can be altered by the Admin SDK /
  console; production serializable behaviour proven on the emulator only
  (SECURITY.md item 47).
- Firestore recovery: counts and one hash compared, not every document;
  Storage objects are outside Firestore backups (7-day soft delete only).
- Client-only controls (uniqueness, cumulative caps, some concurrency):
  SECURITY.md → *Deferred Controls*.
- Portfolio P19: the page's Firestore request payloads could not be decoded;
  *no financial request* rests on code and unit tests, *no financial data
  readable* is proven (P20).
- Rules capacity: `firestore.rules` 236,737 of 245,000 bytes; the
  1000-expression ceiling; one project / directory pair per commit.

### D3. Defect and finding register (#1–#3 implemented on `feature/operator-tooling-safety`; nothing else changed)

Priority: **P1** before customer external onboarding; **P2** next
convenient milestone; **P3** backlog.

| # | Finding | Category | Status | Priority | Dependency | Proposed milestone | Source |
|---|---|---|---|---|---|---|---|
| 1 | `bootstrap-company.mjs` writes by default (`--dry-run` to preview) | Operator safety | **IMPLEMENTED — PENDING INTEGRATION** — dry run by default; writes need `--apply` + exactly one delivery option; conflicting flags exit 2; a read-only plan pass precedes every write; a pending invitation is rotated only on `--rotate` (EMULATOR: §70 OT1–OT6) | P1 | Merge | Operator tooling safety (D5) | ADR-84; Stage B S1 |
| 2 | `bootstrap-company.mjs` prints the acceptance link to stdout | Operator safety / security | **IMPLEMENTED — PENDING INTEGRATION** — never printed; `--no-link` or `--link-file` (new 0600 file, outside the repository on the real path, O_EXCL + O_NOFOLLOW, reserved before any write, verified after creation); a failed write after the commit exits 3, removes the partial file, names the invitation; recovery `--rotate --link-file` (EMULATOR + pure: §70 OT3, OT7–OT9) | P1 | Merge | Operator tooling safety (D5) | ADR-84; Stage B S1 |
| 3 | Four older scripts call `process.exit(1)` after a refused transaction (rollback not awaited → lock held until timeout) | Operator safety / reliability | **IMPLEMENTED — PENDING INTEGRATION** — shared `runOperatorScript`: `process.exitCode`, then `Firestore.terminate()` (awaits the rollback), forced exit only after a 30 s shutdown timeout that starts after the operation settled; a failed or timed-out cleanup is printed as an explicit failure, never as success; exit code kept; no retry. Hazard measured (~1 min lock with `process.exit`, none after); sensitivity-checked (EMULATOR + pure: §70 OT10–OT14, runner tests) | P1 | Merge | Operator tooling safety (D5) | ADR-84 |
| 4 | Withdrawn drawing revisions readable by assigned externals (R-3) | Security | Open | P1 (policy decision) | Architect policy | Drawing-revision visibility (DC46 follow-up) | ADR-83 |
| 5 | *+ Add New Project* shown to `qs` (`Projects.jsx:300`; Rules deny the create) | UX | Open | P2 | — | UX fix bundle (Hosting-only) | Stage B R2 |
| 6 | External roles reach `/settings/company` and `/settings/team` from the user menu (read-only notices; country and currency) | UX | Open | P2 | — | UX fix bundle | Stage B P6 |
| 7 | Top bar reads *Dashboard* on `/settings` pages | UX | Open | P3 | — | UX fix bundle | Stage B R1 |
| 8 | No in-app notice when an assignment is removed (project disappears; stale link shows *Project not found*) | UX | Open | P2 | Design | UX fix bundle (needs a design) | Stage B P8 / X5 |
| 9 | Portfolio subtotal card *4 of 6* (affected) vs table / CSV *2 of 6* (included) | UX | Open | P3 | — | C1-B or UX fix bundle | C1-B |
| 10 | Final Account open draft does not name the missing forecast cost code | UX | Accepted, non-blocking | P3 | — | Backlog | C1-A retest R3 |
| 11 | 58 older write sites keep raw SDK error text and *Saving…* offline | Reliability / UX | Open | P3 | — | Core functionality (ROADMAP) | §66; handover I |
| 12 | Three source comments still say *DC46 — still OPEN* | Documentation | Open | P3 | Next change in those files | Opportunistic | Handover A |
| 13 | SECURITY.md *Known limitations* still says every Storage object carries its token (superseded by DC46 sweeps) | Documentation | Open | P3 | — | Next SECURITY.md change | Observed 24 Nov |
| 14 | Operator checks must read `custom_fields` for Storage download tokens; zsh needs `${VAR}:method` braces in REST URLs | Operator tooling note | Recorded | — | — | Runbook note | Stage B |
| 15 | Testing-profile sessions are per origin and replaced by any sign-in on that origin; sign-ins in another browser do not reach it | Test procedure | Recorded | — | — | Test procedure | Stage B P5, P13, final |
| 16 | `provision-external-member.mjs --link-file` checks the repository boundary on the typed path; a folder that is a symbolic link into the working tree is not caught (final-component and existing-file checks are sound) | Operator safety | **IMPLEMENTED — PENDING INTEGRATION** — the hole demonstrated on `main` (exit 0, link file created in the repository; emulator); now `_linkFile.mjs` (real path, O_EXCL + O_NOFOLLOW, 0600, reserved before the write); exit 3 on a post-commit delivery failure with Resend recovery; no rotation, no duplicate (EMULATOR: §70 OT15–OT16) | P1 (raised by the architect) | Merge | Operator tooling safety | Operator tooling safety |
| 17 | `npm run test:team` / `test:functions`: the Firebase CLI makes one authenticated metadata request for the emulator project id (403 — no access; no production project read) and hands the operator's CLI login to the Functions emulator as credentials; Storage and Pub/Sub are not emulated there | Local tooling / security | Open — limitation recorded | P3 | Design | Use a `demo-` emulator project id (separate change: `.env`, harness, suites) | Launcher end-to-end run, 24 Nov |
| 18 | `npm run test:team` did not wait for the Auth emulator (first-run bootstrap `ECONNREFUSED :9099`) and probed Vite on `127.0.0.1` while Vite 8 bound `::1` only (*Starting Vite… failed*) | Local tooling | **IMPLEMENTED — PENDING INTEGRATION** — bounded readiness for Auth, Firestore, Functions and the CLI ready signal; Vite `--host 127.0.0.1`; bounded shutdown wait. End-to-end PASS, four fresh runs (§70) | P2 | Merge | Operator tooling safety | First implementation report |

### D4. Implementation roadmap (strategic order unchanged)

| State | Items |
|---|---|
| **Implemented and production-accepted** | Commercial foundations; M1, M2-A, M2-B1/B2/B3, M3-A/B1/B2; SHIELD 2A / 2B1 / 2B2; L1 Team Management; DC46 (closed with accepted risks); L2-A; L2-B Stage A; L4 (closed with listed gaps); **M2-A2 Stage A and B (DC20 closed)** |
| **Implemented, not fully accepted** | L2-B Final Account (C1-A); L2-C Portfolio (C1-B); GANTT 1A1 / 1A2 / 1B and core completion (C1-C); L3 Stage 1 alerting (C1-D) and Stage 2 (E1–E10); GST boundary hotfix and Premium Dashboard v2 (production evidence) |
| **Known defects requiring fixes** | D3 #1–#3, #16, #18 implemented, pending integration; D3 #4–#9 (UX), #17 (local tooling) |
| **Security hardening** | D1 R-1 … R-6; general App Check enforcement; DC46 follow-ups (Storage audit logs, faster revocation, drawing-revision policy, load testing at triggers); billing-account administration |
| **Not yet implemented** | Real customer external onboarding (gated); self-serve company signup; billing and subscriptions; client portal; client credit notes and client retention; estimating; creator ≠ approver segregation on Final Account; company legal / tax identity; client-side error reporting; external availability monitor |
| **Deferred (order per ROADMAP → *Approved development order (post-L4)*)** | 1 remaining core functionality and acceptance (C1) → 2 SaaS readiness and international foundations → 3 mobile / PWA → 4 Xero (ADR-82 PROPOSED) → 5 Constrap IQ → 6 Quant AI → 7 final production audit. Stage 8 advanced modules unscoped |

### D5. Next smallest actionable milestone — IMPLEMENTED — PENDING INTEGRATION (24 November 2026)

*Status:* implemented on `feature/operator-tooling-safety` (uncommitted),
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
| Operator tooling safety (D3 #1–#3, #16, #18) | Yes — PENDING INTEGRATION | Not applicable (scripts and local launcher only; no deployment) | Yes (§70); `test:team` end-to-end PASS | Not required (architect: no production dry run for this review) | — | — |
| L2-B Final Account (ADR-77) | Yes | Yes | Yes | **Partly** — positive path; role checks open | — | — |
| L2-C Portfolio (ADR-78) | Yes | Yes | Yes (unit) | **Partly** — visual / export, P4; P19–P20 PASSED (subcontractor and client); P18, M-checks open | — | — |
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
