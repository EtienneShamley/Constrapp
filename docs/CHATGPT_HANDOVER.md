# Constrap — ChatGPT Development Handover

Operational handover for a **new ChatGPT (architect) conversation**. It lets a
fresh session resume Constrap development without the previous conversation
history. It is an index and a checkpoint, **not** a second copy of the
documentation: where this file and a source document disagree, the source
document wins and this file must be corrected.

**Last updated:** 20 November 2026 (NZ). **Git checkpoint:** `main` at
`93db6cc` (*Merge L2-C Portfolio Reporting*), equal to `origin/main` (checked
with `git fetch`, 20 November 2026). This revision was prepared on the
uncommitted branch `feature/gantt-core-completion` (GANTT core completion,
ADR-79 — IMPLEMENTED, NOT DEPLOYED); once that branch is merged, the
checkpoint is the merge commit and this line must be refreshed.

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
| **Current milestone** | **GANTT™ core completion — IMPLEMENTED — NOT DEPLOYED** (ADR-79; branch `feature/gantt-core-completion`, uncommitted; Hosting-only): a schedule attention filter built from the PULSE schedule selectors over the complete programme, programme *Export CSV* and *Print / Save as PDF* from one report model (the printed output is a table under the L2-A print standard; exporting writes nothing and issues no baseline), and the existing `updatedAt` / `updatedBy` stamps shown as *Last changed*. No Rules, Functions, collection, field, index, dependency or write. Unit 93 files / 4,964 pass; the Lead Architect's two corrections are incorporated (synchronous print mounting isolated in `hooks/usePrintMoment.jsx`; one baseline integrity check shared with PULSE, with a historical selection labelled); print layout and mounting were each checked in headless Chrome outside the app; **no browser session against the app and no production verification** (TESTING.md §64). **GANTT 1A1, 1A2, 1B and PULSE 1C: DEPLOYED — VERIFIED read-only 20 November 2026** (ADR-79 → *Production evidence*). **L2-C Portfolio Reporting — DEPLOYED** (ADR-78; merged as `93db6cc`, VERIFIED; live bundle = that build, VERIFIED): visual and export acceptance PASSED (REPORTED by the Lead Architect, 20 November 2026); **remaining security, parity and performance checks OPEN** (TESTING.md §63). *The rest of this cell was written before the L2-C release and describes it as not deployed:* a company-wide, currency-grouped Portfolio page for financial roles, composed from the L2-A Commercial Report model, with all-or-nothing subtotals inside one currency and a one-shot bounded loader; no Rules, Functions, index or write; unit tests pass, **no browser or production verification** (TESTING.md §63). It is a narrow exception to ADR-42 for that page only; the Dashboard is unchanged. **L2-B reconciliation correction (20 November 2026):** merged as `891043a` (VERIFIED) and REPORTED by the Lead Architect as deployed, with negative-readiness and reconciliation acceptance passed and browser screenshots verified; **positive approval, revision and export acceptance still PENDING — L2-B is NOT accepted.** The remainder of this cell was written before that release and describes the correction as not deployed: **L2-B Final Account — DEPLOYED — PRODUCTION ACCEPTANCE PENDING** (ADR-77). Rules, the `approveFinalAccount` callable and Hosting are REPORTED deployed with Azure CI green; the Product Owner has confirmed navigation, rendering, the readiness checklist and the disabled *Prepare*; the rest of TESTING.md §62 is NOT run and **L2-B is NOT accepted**. A **reconciliation correction** is IMPLEMENTED, NOT DEPLOYED on `fix/l2b-final-account-reconciliation` (uncommitted): a readiness requirement against over-allocated client invoices (enforced by the callable too), forecast labels on the live position, proposed labels on drafts, corrected supplier-variation wording (ADR-77 item 12; TESTING.md §62a). Stage A (ADR-76) LIVE. **L2-A Commercial Report LIVE and Product Owner accepted.** Firestore recovery protection ENABLED and verified 19 November 2026; the first READY backup is UNVERIFIED and the restore test is PENDING. DC46 CLOSED 18 November 2026 |
| **Latest Git checkpoint** | **VERIFIED:** branch `main`, HEAD `93db6cc` (*Merge L2-C Portfolio Reporting*; preceded by `4ebdd4e`, the feature commit), equal to `origin/main` (`git fetch`, 20 November 2026); working tree clean before `feature/gantt-core-completion` was branched from it. Before that: `891043a` (*Merge L2-B Final Account reconciliation fixes*; preceded by `24e65c1`, the correction itself), `c4b93e5` (*Merge L2-B Final Account*). Azure CI on `main`: REPORTED green. Preceding commits: `2047a0d` (Final Account), `28e5c9f` (Rules capacity merge), `02e973a`, `2d5787c` (L2-A merge), `84c9fb3` (DC46 closeout), `a2544a1` (worker rollback checkpoint) |
| **Production** | **REPORTED:** live at `https://app.constrap.com` on Firebase project `constrapp-69b5d`. **VERIFIED read-only, 20 November 2026 (latest reading):** Firestore ruleset `10c7596c…` (released 19 November 2026 04:23 UTC; **232,460 bytes**) byte-identical to `frontend/firestore.rules` on `main`; Hosting release `765058ff63073a4b` (19 November 2026 23:54 UTC) serves `index-Co3P5JIm.js`, the bundle a clean build of `main` `93db6cc` produces — so the live application is `main`, including GANTT 1A1 / 1A2 / 1B, PULSE 1C, L2-B and L2-C. Functions and Storage Rules were not re-read on 20 November. *Earlier reading, kept for the record —* **VERIFIED** read-only, 19 November 2026: Firestore ruleset `05c78d00…` (**229,115 bytes**, created 18 November 2026 21:57 UTC) byte-identical to `main` `28e5c9f`; Storage ruleset `8b8edc14…` (9,271 bytes) byte-identical to `main`; eight callables on `-00004-*`; worker `processfilelinkrevocations-00003-ceg`; latest Hosting release `e38715de08e664b5` (18 November 05:29 UTC — REPORTED as the L2-A release; its files were not compared with `main` in this revision). **L2-B (20 November 2026): the Final Account Rules, the `approveFinalAccount` callable and Hosting are REPORTED deployed; they were not re-read from production in this revision.** The figures before this sentence are the 19 November reading, taken before that release. Earlier verification (17–18 November): concurrency 1, `FILE_LINK_RECONCILE_INTERVAL_HOURS=2`, Scheduler enabled, Policies A, B and C enabled, 1 company, 2 active Company Admins, 2 deactivated test members, 0 active external users |
| **Deferred Control 46** | **CLOSED — 18 November 2026, with accepted risks; production acceptance approved by the architect** (SECURITY.md item 46; ADR-75 → *DC46 closure record*; TESTING.md §59) |

**Accepted risks (not eliminated — detail in section I):** copied download
links live until a sweep removes the token (the two-hour reconciliation
interval is not a strict revocation deadline — completion depends on
scheduling, worker health and backlog) · console and
Admin SDK writes bypass Rules · the November token re-creations are
unattributed · every member reads every drawing revision · monitoring
shares the worker's cloud project · the Firestore Rules have 12,540 bytes of headroom
with the Final Account block (REPORTED published).

**Exact next development action:** architect review of
`feature/gantt-core-completion` (GANTT core completion, ADR-79), then Git
integration (Product Owner), then its **Hosting-only** release on a separate
authorisation and the TESTING.md §64 acceptance. Open in parallel and NOT
blocking it: the remaining L2-C checks (TESTING.md §63 — security, parity,
performance) and the L2-B positive acceptance (TESTING.md §62 — approval,
revisions, export). After GANTT: **L3**, then L4, L5 and commercial
readiness; Constrap IQ / Quant AI, mobile / field and the final audit later
(Lead Architect's sequencing, 20 November 2026). **Next release gate:** the
GANTT core completion Hosting deploy. **Pre-customer
gate:** the first READY Firestore backup and the non-production restore test
(PENDING).

**Awaiting authorisation — none of these is approved yet:**

| Action | State |
|---|---|
| Git integration of `feature/gantt-core-completion` (GANTT core completion, ADR-79) | Awaiting architect review — IMPLEMENTED, NOT DEPLOYED |
| Hosting-only release of GANTT core completion, then TESTING.md §64 (G1–G11 + G8a, C1–C9, R1–R13 + R9a–R9b, L1–L7, A1–A3) | NOT AUTHORISED. No Rules or Functions deploy belongs to it |
| L2-C Portfolio Report (ADR-78) | DONE — merged as `93db6cc` (VERIFIED) and deployed (live bundle VERIFIED 20 November 2026). Visual and export acceptance PASSED (REPORTED). **OPEN:** the security, parity and performance checks of TESTING.md §63 |
| `fix/l2b-final-account-reconciliation` (over-allocation readiness requirement; live / draft wording) | DONE — merged as `891043a` (VERIFIED); REPORTED deployed 20 November 2026 |
| L2-B positive production acceptance — approval, revisions, export (TESTING.md §62 F3–F17) | PENDING. The reconciliation correction's release is REPORTED done (20 November 2026). Written before that release: The team callables and the reconciliation worker must NOT be redeployed. On the test project the user must first correct the receipt over-allocating CI-0012 before a Final Account can be prepared |
| **Firestore recovery** — the first READY scheduled backup, and a non-production restore test (DEPLOYMENT.md → *Firestore recovery protection*) | Protection itself is ENABLED and VERIFIED read-only (19 November 2026): PITR 7 days, daily backups retained 14 days, delete protection. **No backup existed yet at that check; the restore test has not been run.** Both required before commercial customer onboarding |
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
ops/monitoring/      alert policy files — A and B created in production; the test policy removed
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
| Monitoring | Alert Policies A, B and C; log-based metric `dc46_reconciliation_plan_complete`; email channels `DC46 - Product Owner` and `DC46 - Billing Administrator` (addresses held only in Cloud Monitoring) | VERIFIED by read-only production check, 18 November 2026 (three policies, all enabled, two channels each) |
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
ADR-77).

---

## F. Completed milestones

Production status below is **REPORTED** — taken from the repository's release
records, most of them "confirmed by the Product Owner". Dates are as recorded.

| Module | What is live | ADRs | Status |
|---|---|---|---|
| **Commercial workflow** | Cost Codes, Budgets, Purchase Orders, Progress Claims, Supplier Invoices, Variations, Forecast, Margin, Client Invoices, Client Receipts, Supplier Payments, Credit Notes, Retention Release, Cash Flow, BOQ, Tenders, Contacts, Documents & Drawings, RFIs, Company Country & Currency | See ROADMAP.md → *Completed Foundations* | LIVE (foundations) |
| Commercial integrity releases | M1 forecast integrity; M2-A read containment; M2-B1/B2/B3 PO, claim and variation lifecycle rules; M3-A award → draft PO; M3-B1 variation commitment; M3-B2 new-scope claims | ADR-55 to ADR-63 | LIVE (from 27 October 2026) |
| **Premium Dashboard** | Dashboard v2 on derived figures only | ADR-42, ADR-45 | Merged and recorded as implemented; **production release not recorded** — see the verification list below |
| **PULSE** | 1A six commercial indicators; 1B acknowledgement; 1C three schedule indicators | ADR-47, ADR-49, ADR-67 | LIVE |
| **SHIELD** | Foundation (five assurance checks); 2A claim-to-invoice pairing; 2B1 Approved Budget Versions; 2B2 Budget Adjustments | ADR-50, ADR-68, ADR-70, ADR-71 | LIVE |
| **Quant** | 1A manual measurement; 1B BOQ link and explicit apply; 1C editing and summary; 1D deductions | ADR-51 to ADR-54 | LIVE (October 2026) |
| **GANTT** | 1A1 programme tab; 1A2 dependencies; 1B approved baselines and variance | ADR-64 to ADR-66 | LIVE — DEPLOYED, VERIFIED read-only 20 November 2026 (ADR-79 → *Production evidence*) |
| **GANTT core completion** | Schedule attention filter; programme CSV and print; last-change visibility | ADR-79 | **IMPLEMENTED — NOT DEPLOYED** (branch `feature/gantt-core-completion`) |
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

**Planned, partial or not built — do not present as complete:**

| Item | State |
|---|---|
| DC46 follow-ups (billing administration, Storage audit logs, Rules size, load testing at triggers, drawing visibility, faster revocation) | NOT STARTED, none approved — ROADMAP.md → *DC46 follow-ups* |
| DC46-C Stage 4 measurement at volume | DEFERRED to a threshold-triggered follow-up (about 500 companies, about 50,000 objects in one company, or routine deferral/overdue lines) |
| Independent external availability monitor | Not built; future reliability work, no scope recorded |
| GST boundary hotfix (`fix/gst-boundary-pins`) | Merged; production state unconfirmed — see the verification list below |
| Estimating; BOQ → Approved Budget transfer | Not built |
| Commercial reports | L2-A project Commercial Report LIVE and production-accepted (REPORTED, 19 November 2026). **L2-C Portfolio Report DEPLOYED** (ADR-78) — visual and export acceptance PASSED (REPORTED, 20 November 2026); security, parity and performance checks OPEN. Programme CSV / print: IMPLEMENTED — NOT DEPLOYED (ADR-79). Not built: charts, trends, portfolio cash-flow forecast, programme indicators on the portfolio, saved report history |
| Final Account | **L2-B DEPLOYED — PRODUCTION ACCEPTANCE PENDING** (ADR-77): revisions, trusted approval, immutable snapshot, drift comparison, CSV / print. The reconciliation correction is REPORTED deployed (20 November 2026); positive approval acceptance pending. Not built: client signature or certificate, client retention, subcontract final accounts, creator ≠ approver segregation |
| Constrap IQ; any AI capability | Not built; placeholder rule applies |
| Accounting integrations; billing and subscriptions; client portal | Not built |
| Photos; mobile / PWA packaging | Placeholder / not built |
| General App Check enforcement | Not enabled |

**Left for verification — production state not established by any release
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
2. International infrastructure assessment — **DONE** (18 November 2026). Firestore recovery protection ENABLED 18 November 2026; first READY backup unverified; restore test pending.
3. L2 — Commercial Reports and Final Account — **L2-A LIVE and accepted**; L2-B: Stage A LIVE; **Stage B DEPLOYED — PRODUCTION ACCEPTANCE PENDING** (reconciliation correction REPORTED deployed 20 November 2026; positive approval acceptance pending); **L2-C Portfolio Reporting DEPLOYED** (ADR-78; visual and export acceptance PASSED — REPORTED; security, parity and performance checks OPEN). **GANTT core completion (ADR-79) IMPLEMENTED — NOT DEPLOYED**; L3 is next after GANTT.
4. L3 — Production Reliability — NOT STARTED.
5. L4 — BOQ-to-Approved-Budget integration — NOT STARTED.
6. L5 — Accounting integrations, Xero first — NOT STARTED.
7. Constrap IQ and AI capabilities — NOT STARTED.
8. Advanced construction modules — NOT STARTED.
9. SaaS commercialisation — NOT STARTED.
10. Mobile and field experience — NOT STARTED.
11. Final production audit — NOT STARTED.

**This sequence is strategic intent, not an implementation commitment.** It
authorises nothing and overrides no ADR. Each stage needs its own assessment,
its own ADR where it introduces a pattern, and a separate implementation
approval. Stages 2, 4, 8 and 11 have no scope recorded in the repository.

- **L5:** Xero is the preferred first accounting integration, subject to
  product-market-fit validation and a separately approved integration
  strategy. Until then accounting integrations remain an anti-goal.
- **Stage 7:** the AI Feature Placeholder Rule in [AGENT.md](../AGENT.md)
  stays in force until an approved strategy lifts it.
- The *Anti-Goals* in ROADMAP.md apply to every stage.

---

## I. Open risks

| Risk | State | Source |
|---|---|---|
| **Billing continuity** | The project lost billing for about 17 hours on 12–13 November 2026 and the worker did not run. A permanent paid account is **REPORTED** by the Product Owner (17 November 2026); who owns it, a second administrator, a budget and who receives billing notices are all **unconfirmed** — a follow-up outside DC46 | DEPLOYMENT.md → *Billing interruption*, *Billing continuity*; ROADMAP.md → *DC46 follow-ups* |
| **Monitoring is unproven against a real failure** | Policies A, B and C exist, but none has fired on its real condition; only the email path was exercised, and receipt is reported, not observed. Policy B depends on the worker writing a matching error line. Monitoring and the worker share one project (accepted risk) | DEPLOYMENT.md → *DC46-C monitoring readiness* → *Monitoring release record* |
| **Reconciliation** | Active at 2 hours since 17 November 2026; three periodic sweeps observed, all complete. The two-hour interval is not a strict revocation deadline: completion depends on scheduling, worker health and backlog, and an incomplete sweep or a stopped worker lengthens it | ADR-75 → *DC46 closure record*; TESTING.md §56, §59 |
| **Rollback of reconciliation** | Rolling the callables back to the ADR-74 build is unsafe once any periodic request has existed. Policy C must be disabled if the interval is rolled back to `0` | DEPLOYMENT.md → *DC46-C* → *Activation runbook* |
| **Interval choice** | 1 hour is valid in code but rejected: it collides with the hourly planning period and raises false overdue alerts. A later change of interval must stay at 2 or more | ADR-75 → *Activation readiness*; TESTING.md §56 |
| **Visibility and status changes** | No client can reduce visibility; a correction needs an operator. A console or Admin SDK edit bypasses Rules and queues no revocation. After a withdrawal, supersession or console change a copied link lives until the next periodic sweep (accepted risk) | SECURITY.md item 46; DEPLOYMENT.md → *Operator procedure — correcting a document's visibility* |
| **External members** | Removal by a Company Admin is live and production-accepted. Provisioning is still an operator task (an Auth account plus `users/{uid}`); there is no script for it. Membership is company-wide — an external member reads every drawing revision in the company, withdrawn ones included (accepted risk) | SECURITY.md item 46; TESTING.md §59 |
| **Storage-token limitations** | Revocation is not immediate; an active member can still obtain a link by a direct SDK call; token behaviour relied on is undocumented by Firebase; tokens reappeared twice in November from an unattributed cause (none since); scale is unmeasured (largest sweep: nine objects) — load testing is a triggered follow-up | SECURITY.md item 46; ADR-74; ADR-75 |
| **Monitoring's own limits** | Policy A cannot be relied on for a billing suspension or a deleted service; both policies live in the project they watch. An independent external availability monitor remains future reliability work | DEPLOYMENT.md → *Policy A* limitations |
| **International region / latency** | All backend resources are in `australia-southeast1`. Assessed 18 November 2026: retained (architect decision). Measured from New Zealand only (Firestore request about 100–115 ms after TLS); no Caribbean, North American or European measurement exists — validate with a pilot customer session. Tax remains Australian GST only; international tax deferred | ROADMAP.md → *Strategic Development Sequence* stage 2; AGENT.md |
| **Firestore recovery** | PITR (7 days), daily backups (14-day retention) and delete protection ENABLED 18 November 2026 and VERIFIED read-only 19 November 2026. No backup existed yet at that check and no restore has been tested, so recovery is unproven | DEPLOYMENT.md → *Firestore recovery protection* |
| **Rules capacity** | 232,460 of 245,000 bytes — 12,540 bytes of headroom (REPORTED published 20 November 2026). The 1000-expression ceiling and access-call budget are unchanged by ADR-76 | SECURITY.md → *Ruleset source-size limit*; ADR-76, ADR-77 |
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

**Next. Each step needs explicit authorisation.**

1. **Architect review and Git integration** of
   `feature/gantt-core-completion` (GANTT core completion, ADR-79), then
   refresh this file's checkpoint line.
2. **Release it — Hosting only** (DEPLOYMENT.md → *GANTT™ core completion*).
   No Rules, no Functions. Then TESTING.md §64 — the PULSE-equality check
   (G2), the hidden-predecessor check (G5) and the real print preview
   (R1–R4, R9) are the ones that matter most.
3. **Remaining L2-C checks** — TESTING.md §63: the security, parity and
   performance items (row-to-Reports-tab agreement P4, the external-role
   negative path P19–P20, measurements M1–M5). Visual and export acceptance
   is REPORTED passed. Not a blocker for GANTT.
4. **L2-B positive production acceptance** — TESTING.md §62 F3–F17, with
   backend evidence for the approval (F9). L2-B is not accepted until then.
5. **Firestore recovery** — record the first READY scheduled backup and run
   the non-production restore test (before commercial customer onboarding).
6. **Billing administration** — owner, a backup administrator, a budget and
   its notifications (DEPLOYMENT.md → *Billing continuity*). Still open.

Still outstanding beyond that: an independent external reliability
monitor, which belongs to L3 — Production Reliability, and has no scope
recorded.

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
