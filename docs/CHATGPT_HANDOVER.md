# Constrap — ChatGPT Development Handover

Operational handover for a **new ChatGPT (architect) conversation**. It lets a
fresh session resume Constrap development without the previous conversation
history. It is an index and a checkpoint, **not** a second copy of the
documentation: where this file and a source document disagree, the source
document wins and this file must be corrected.

**Last updated:** 16 November 2026. **Git checkpoint:** `main` at `5615239`
(*Merge DC46-C monitoring readiness*). This revision was prepared on the
uncommitted branch `docs/constrap-context-continuity`; once that branch is
merged, the checkpoint is the merge commit and this line must be refreshed.

**This file is a point-in-time snapshot.** It does not replace checking the
current Git state or verifying production. Maintenance is mandatory —
[AGENT.md](../AGENT.md) → *Development Continuity — ChatGPT Handover*.

**Status words used throughout — never blur them:**

| Word | Meaning |
|---|---|
| **VERIFIED** | Read directly from the repository (files, Git history) when this file was last updated |
| **REPORTED** | Stated by the Product Owner or the architect and recorded in the repository documents; not independently re-checked here. Every production "LIVE" claim is at best REPORTED in this file, because production was not accessed to write it |
| **PROPOSED** | Designed or prepared; does not exist in production |
| **BLOCKED** | Cannot proceed until a named precondition or authorisation is met |
| **NOT STARTED** | No design, code or scope in the repository |

---

## A. Current checkpoint

| Item | State |
|---|---|
| **Current milestone** | DC46 security (Deferred Control 46 — Storage download links after a membership ends), part C. Stage 1 is production-accepted; monitoring is prepared but not created |
| **Latest Git checkpoint** | **VERIFIED:** branch `main`, HEAD `561523935deb1a88ff8c0f354aa8596f0ec555f6` (`5615239` *Merge DC46-C monitoring readiness*), working tree clean apart from the documentation branch that carries this file. Azure CI status for `5615239` was not checked when this file was written — confirm it. Preceding commits: `2b5c8a2` (monitoring readiness), `aab1f2f` (Stage 1 closeout merge), `38ab578` (Stage 1 merge) |
| **Production** | **REPORTED:** live at `https://app.constrap.com` on Firebase project `constrapp-69b5d`. Last production change: the DC46-C Stage 1 **worker-only** deploy on 13 November 2026, accepted 16 November 2026. Nothing has been deployed since. The monitoring-readiness merge changed **no** production resource |
| **Deferred Control 46** | **OPEN** |

**Active risks (detail in section I):** billing continuity unconfirmed · no
monitoring or alerting exists · periodic reconciliation is off · the eight
callables run an older build than the worker · Firestore rules source is 3,076
bytes under its approved size budget.

**Exact next development action:** DC46-C monitoring configuration (section
J). It is Product Owner cloud work from an already-reviewed procedure, not a
coding task, and each step still needs explicit authorisation. Before it:
Git integration of the `docs/constrap-context-continuity` branch, once the
architect approves it.

**Awaiting authorisation — none of these is approved yet:**

| Action | State |
|---|---|
| Create the two email notification channels | PROPOSED |
| Create alert Policies A and B in production | PROPOSED |
| Run the temporary delivery-test policy (and delete it) | PROPOSED — needs its own approval |
| Billing continuity confirmation by the billing account owner | NOT DONE — administrator action |
| All-Functions deploy (`firebase deploy --only functions`) | BLOCKED on architect review and explicit authorisation |
| Activate periodic reconciliation (non-zero interval) | BLOCKED on the all-Functions deploy, a monitoring decision, **and a separate approval** |
| DC46-C Stages 2, 3, 4 | PROPOSED in ADR-75; not started |

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
ops/monitoring/      PROPOSED alert policy files — nothing here exists in the cloud
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
| Callables | `listTeam`, `createInvitation`, `resendInvitation`, `revokeInvitation`, `previewInvitation`, `acceptInvitation`, `changeMemberRole`, `deactivateMember` — App Check enforced | REPORTED live; running the ADR-74 build |
| Worker | Cloud Run service `processfilelinkrevocations`, revision `-00002-had`, concurrency 1, own service account | REPORTED (read-only production check, 13–16 November 2026) |
| Scheduler | `firebase-schedule-processFileLinkRevocations-australia-southeast1`, every minute | REPORTED |
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
| **Trusted backend is narrow** | `frontend/functions/` does team membership and download-token clean-up only. No financial write, general API or new trigger without a new ADR | [ARCHITECTURE.md](ARCHITECTURE.md) → *Client-SDK Data Access + One Narrow Trusted Backend*; ADR-72, ADR-74 |
| **Rules capacity** | The Firestore ruleset must stay under the approved 245,000-byte budget (hard limit 262,144). Current FINAL file: 241,924 bytes | [SECURITY.md](SECURITY.md) → *Ruleset source-size limit*; ADR-60, ADR-69 |
| **Financial correctness** | Committed, Claimed, Actual, Invoiced, forecast, margin and cash figures are derived at read time. Nothing writes a financial rollup onto a Budget Line. All money through `roundMoney`; canonical amounts ex-GST. A failed or loading source shows *Unavailable*, never zero | [AGENT.md](../AGENT.md) → *Financial Invariants*; [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md); ADR-41, ADR-44, ADR-55 |
| **Approved Budget** | An immutable approved version plus approved adjustments; never a silent fallback to working lines | ADR-70, ADR-71 |
| **Per-project currency** | One currency per project; a label, never a conversion. No FX. Format only through `formatCurrency`. GST stays a flat Australian 10% — currency is not tax | [AGENT.md](../AGENT.md) → *Financial Invariants*; ADR-21 |
| **Commercial lifecycle integration** | New commercial modules join the lifecycle through the cost-code spine (`costCodeId` + `costCodeName` snapshot). Field features must state their commercial input or output | [AGENT.md](../AGENT.md) → *Strategic Invariants* |
| **Data integrity** | Forward-only lifecycles; financial records are never deleted; transactional document numbering; names snapshotted at write time and never backfilled; paired writes verified in rules with `getAfter()` where a cross-document invariant matters | [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §1, §3; ADR-57 to ADR-59, ADR-61, ADR-68 |
| **Code structure** | Hooks-only Firestore access; pure domain logic in `frontend/src/lib/`; no new dependency without instruction | [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §1, §3 |
| **Error handling** | Hooks expose their error state; pages gate every figure on its verified sources; messages are friendly and leak nothing | ADR-41, ADR-44 |
| **Production safety** | Nothing reaches production without a named authorisation. Release order per item is documented and followed. No secret in the frontend bundle or in Git. Proposed work is never described as live | [DEPLOYMENT.md](DEPLOYMENT.md); [SECURITY.md](SECURITY.md) → *Secrets & the Vite bundle* |

All decision records: [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) (ADR-0a to
ADR-75).

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
| **GANTT** | 1A1 programme tab; 1A2 dependencies; 1B approved baselines and variance | ADR-64 to ADR-66 | LIVE |
| **L1 Team Management** | Invitations, acceptance, role changes, deactivation through the trusted backend; Constrap brand and custom domain | ADR-72 | LIVE and accepted, 11 November 2026 |
| **DC46-A** | Authenticated Storage reads; the app mints no download URL | ADR-73 | LIVE, 11 November 2026 |
| **DC46-B** | Scheduled worker removes legacy download tokens after a membership change | ADR-74 | LIVE and accepted, 12 November 2026 |
| **DC46-C Stage 1** | Updated worker (fair scheduling, recovery rules, concurrency 1). Membership-triggered revocation accepted through it | ADR-75 | Worker DEPLOYED 13 November; ACCEPTED 16 November 2026. **Periodic reconciliation NOT ACTIVATED** |

**Planned, partial or not built — do not present as complete:**

| Item | State |
|---|---|
| DC46-C periodic reconciliation | Implemented, switched off in production |
| DC46-C monitoring (Policies A/B, channels) | PROPOSED — files only |
| DC46-C Stages 2–4 | PROPOSED in ADR-75, not started |
| GST boundary hotfix (`fix/gst-boundary-pins`) | Merged; production state unconfirmed — see the verification list below |
| Estimating; BOQ → Approved Budget transfer | Not built |
| Final Account; commercial reports | Not built (Reports is a hidden placeholder) |
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

## G. Current DC46 state

Sources: [SECURITY.md](SECURITY.md) → *Deferred Controls* item 46;
[DEPLOYMENT.md](DEPLOYMENT.md) → *DC46-B*, *DC46-C*, *DC46-C monitoring
readiness*; [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) → ADR-73, ADR-74,
ADR-75; [TESTING.md](TESTING.md) §52–§54; [ops/monitoring/README.md](../ops/monitoring/README.md).

| Item | State |
|---|---|
| ADR-74 (DC46-B, token revocation by a scheduled worker) | LIVE and accepted, 12 November 2026 — REPORTED |
| ADR-75 (DC46-C) Stage 1 | Merged (`38ab578`). Worker deployed 13 November; revocation production-accepted 16 November 2026 on backend evidence — REPORTED |
| Worker and Scheduler | The existing worker and its one Scheduler job, every minute. No new function, job or service account was added by Stage 1 |
| Periodic reconciliation | **Interval 0 — NOT ACTIVATED** (`FILE_LINK_RECONCILE_INTERVAL_HOURS=0`). No planning has ever run in production. Proposed value on activation: 24 |
| Monitoring readiness | Merged to `main` (`5615239`) — VERIFIED. Contains policy files, tests, runbook and procedure only |
| Production Policies A and B | **NOT CONFIGURED.** Production inventory on 16 November 2026: 0 alert policies, 0 notification channels, 0 log-based metrics — REPORTED |
| Policy C (planning heartbeat) | Specified only; to be created with activation |
| All-Functions deployment | **OUTSTANDING, not authorised.** The eight callables run the ADR-74 build beside the Stage 1 worker. Correct only while the interval is 0 (test-proven) |
| Billing continuity verification | **OUTSTANDING** — administrator action, not confirmed |
| Stage 2 (visibility-reduction lock, Rules) | PROPOSED, not started |
| Stage 3 (external-member removal through the app) | PROPOSED, not started |
| Stage 4 (measurement at volume, alerting, closure wording) | PROPOSED, not started |
| **Deferred Control 46** | **OPEN** |

**Wording rules.** Never describe the proposed monitoring as live. Never say
tokens are "periodically reconciled" or "revoked within 24 hours". Revocation
is not immediate — membership removal is. Policy A must not be described as
detecting a billing interruption.

---

## H. Roadmap

**Source of truth:** [ROADMAP.md](../ROADMAP.md) → *Strategic Development
Sequence*. Read it there; the list below is only the order.

1. Complete DC46 security — **IN PROGRESS** (sections G and J).
2. International infrastructure assessment — NOT STARTED.
3. L2 — Commercial Reports and Final Account — NOT STARTED.
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
| **Billing continuity** | The project lost billing for about 17 hours on 12–13 November 2026 and the worker did not run. That the project now sits on a permanent paid account, who owns it, a second administrator and a budget alert are all **unconfirmed** | DEPLOYMENT.md → *Billing interruption*, *Billing continuity* |
| **Monitoring absence** | No alert policy, channel or metric exists. A stopped worker produces no error. The interruption was noticed by people | DEPLOYMENT.md → *DC46-C monitoring readiness* |
| **Periodic reconciliation disabled** | Tokens on new uploads, and tokens created outside the app, live until the next membership change or operator run | SECURITY.md item 46 |
| **Callable deployment dependency** | The callables must be redeployed from `main` and verified before any non-zero interval, or revocations are mis-audited | DEPLOYMENT.md → *Dependency on the all-Functions deploy* |
| **Visibility-based revocation** | Reducing a document from `project` to `internal` triggers no revocation; an external member keeps a copied link until the next sweep (Stage 2) | SECURITY.md item 46 |
| **External-role removal** | Subcontractor and client members are removed out of band; the operator must run the revocation script afterwards (Stage 3) | SECURITY.md item 46 |
| **Storage-token limitations** | Revocation is not immediate; an active member can still obtain a link by a direct SDK call; token behaviour relied on is undocumented by Firebase; tokens reappeared once from an unproven cause; scale is unmeasured (largest sweep: five objects) | SECURITY.md item 46; ADR-74 |
| **Monitoring's own limits** | Once created, Policy A cannot be relied on for a billing suspension or a deleted service; it lives in the same project | DEPLOYMENT.md → *Policy A* limitations |
| **International region / latency** | All backend resources are in `australia-southeast1`; suitability for other markets is not assessed. Tax remains Australian GST only | ROADMAP.md → *Strategic Development Sequence* stage 2; AGENT.md |
| **Rules capacity** | 241,924 of 245,000 bytes used — 3,076 bytes of headroom. Stage 2 is a Rules change and will need capacity recovered first | SECURITY.md → *Ruleset source-size limit* |
| **Client-enforced controls** | Several lifecycle, uniqueness and cumulative-cap controls remain client-only | SECURITY.md → *Deferred Controls* |
| **General App Check enforcement** | Not enabled on Firestore, Storage or Auth | DEPLOYMENT.md → *Deferred: general App Check enforcement* |

---

## J. Exact next action

**DC46-C monitoring configuration.** Procedure, checklists and runbook are already
written and reviewed: [DEPLOYMENT.md](DEPLOYMENT.md) → *DC46-C monitoring
readiness*. Each step is a production cloud change by the Product Owner and
needs explicit authorisation.

1. **Configure notification channels** — two email channels (Product Owner;
   an authorised billing administrator). Recipients stay outside Git.
2. **Create and validate Policies A and B** from `ops/monitoring/*.policy.json`,
   then run the verification checklist.
3. **Confirm billing continuity** — the billing account owner completes the
   actions in *Billing continuity*.
4. **Verify alert delivery** — the temporary delivery-test policy, with
   delivery evidence per recipient, then delete it and verify clean-up. This
   needs its own approval.
5. **Then review the all-Functions deployment** — architect review first; the
   deploy itself is a separate authorisation.
6. **Periodic reconciliation activation requires a separate approval** — and
   is blocked until step 5 is deployed and verified.

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
