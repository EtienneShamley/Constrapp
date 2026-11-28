# Constrap — ChatGPT Architectural Handover

**The consolidated entry point for ChatGPT architectural continuity.** A new
ChatGPT conversation that reads this file should be able to take over as Lead
Software Architect without the earlier conversations. It summarises and
indexes the repository; it does not replace it (see *Source-of-truth
hierarchy* below).

| | |
|---|---|
| **Last updated** | 28 November 2026 (NZDT) — Phase 2 Stage A accepted; Stage A completion (A2 TEST fixture, TEST PM invitation, M1 monitoring correction) delivered for review |
| **Branch** | `fix/phase2-release-preparation` from `main` (VERIFIED) |
| **HEAD** | `c74f8f4` = `origin/main` = remote `main` (*Merge Phase 2 CI validation fix (D3 #56)*) (VERIFIED) |
| **Working tree** | **Uncommitted** M1 monitoring correction, its test, and the Stage A documentation (VERIFIED) |
| **Production** | Commercial Finance Phase 1 LIVE (PROD-VERIFIED read-only 28 Nov 2026: 17 functions; Firestore ruleset `0e228bd0…` = the Phase 1 rules, 236,120 B; Storage rules = `main`; Hosting `2f85dee4071c61d6`, bundle `index-BEwVCddF.js`). **Phase 2 NOT deployed; no company activated; no Phase 2 server state; every Phase 2 switch `false`.** Only TEST-company writes made: the A2 fixture and one PM invitation (TESTING.md §91) |
| **Azure CI** | **GREEN on `c74f8f4`** — Build #20261128.2 succeeded, 0 errors / 0 warnings (PROD-VERIFIED via the public GitHub check-run); suite counts unit 6,489 · Rules 2,861 · Functions pure 296 · emulator 834 (REPORTED) |
| **History** | Earlier revisions of this file, verbatim: [CHATGPT_HANDOVER_HISTORY.md](CHATGPT_HANDOVER_HISTORY.md) (archive, not authoritative) |

**Evidence classes used throughout:** **VERIFIED** (checked in the repository,
Git or a test run) · **REPORTED** (recorded in a repository document as stated
by the Product Owner or Lead Architect, not re-checked) · **IMPLEMENTED** (in
code and tested locally, not deployed) · **PROPOSED** · **APPROVED** (decision
recorded, not necessarily built) · **NOT STARTED** · **DEFERRED** ·
**BLOCKED**. Passing tests or CI never make anything "live".

## Source-of-truth hierarchy

1. **Source code and reproducible test evidence** establish what the
   application actually does.
2. **Approved ADRs** ([PROJECT_DECISIONS.md](PROJECT_DECISIONS.md)) establish
   architectural intent and constraints.
3. **[ROADMAP.md](../ROADMAP.md)** establishes planned direction (and, for
   Phase 2, the progress register).
4. **Progress registers** —
   [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md),
   [TESTING.md](TESTING.md) sections, [DEPLOYMENT.md](DEPLOYMENT.md) release
   records — establish recorded delivery and acceptance status.
5. **This handover** consolidates 1–4 for continuity. It never overrides them.

When they disagree: name the contradiction, state what is verified, record
the discrepancy (section O), correct stale documentation where the intended
behaviour is established, and escalate genuine architectural or financial
policy conflicts. An unresolved contradiction is never presented as fact.

---

## A. Product identity and purpose

**What it is.** Constrap is *the connected commercial operating system for
construction projects* — one commercial dataset from drawing and quantity
through budget, commitment, claims, invoices, cash and margin to the final
account, joined by cost codes. Sources: [PRODUCT.md](../PRODUCT.md),
[AGENT.md](../AGENT.md) → *Strategic Invariants*.

**Customers.** Small and mid-sized contractors, builders and quantity
surveyors; Australian first. Internal users are Company Admin, Project
Manager and QS / Office; subcontractor and client users have controlled,
project-assigned read access (M2-A2, ADR-83/84).

**Problems it solves.** Replaces disconnected spreadsheets and tools with one
system of record for commercial control: what is budgeted, committed,
claimed, certified, invoiced, paid and received; what the project will cost;
what margin remains; and a defensible final account — every figure derived
from source documents rather than retyped.

**Positioning.** An opinionated commercial workflow for contractors — **not**
a form-first or HSEQ platform. Generic form builders, HSEQ libraries, payroll,
fleet and broad integrations before product-market fit are anti-goals
([ROADMAP.md](../ROADMAP.md) → *Anti-Goals*; PRODUCT.md → *What Constrap Is
Not*). Field features exist only to feed or evidence a commercial outcome.

**Brand.** Customer-facing name **Constrap** (renamed from "Constrapp" on
10 November 2026). The old spelling is deliberately kept in internal
identifiers — the Firebase project id, package names, storage keys, history.
Never search-and-replace it (AGENT.md → *Brand Name*). Proprietary module
names: PULSE™, SHIELD™, GANTT™, Quant™, IQ™.

**International direction.** Projects already report in their own currency,
with **no FX** and **Australian GST only** — Constrap is not tax-compliant
outside Australia, and says so. The Sydney region is retained (international
infrastructure assessment, 18 November 2026). International tax compliance is
deferred (Phase 3).

**Commercial status (REPORTED).** Live at `https://app.constrap.com`. One
production customer company and an isolated acceptance-test company are
active (DEPLOYMENT.md names them). Company creation and external-member
provisioning are operator tasks; there is **no** self-serve signup, billing
or subscription. External customer onboarding stays gated (section O).

---

## B. Commercial lifecycle

```
Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved Budget
  → Commitment → Purchase Order → Variation → Progress Claim
  → Supplier Invoice → Actual Cost → Forecast → Cash Flow
  → Final Project Margin → Final Account
```

**The cost-code spine.** Every commercial document line carries a
`costCodeId` and a `costCodeName` snapshot taken at write time (never
backfilled). Cost codes are company-wide; they join the BOQ, budget, tenders,
POs, variations, claims, invoices, credits, forecasts and reports. New
commercial modules must join through them (ADR-0a, AGENT.md).

**Read-time derivation.** Committed, Claimed, Actual, Invoiced, exposure,
forecast, margin, receivables, payables and cash figures are **derived when
read** from the source documents; nothing writes a rollup onto a budget line
(ADR-3/4; [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md)). A failed or
loading source shows *Unavailable*, never zero (ADR-41, ADR-44).

**Authoritative sources.**

| Figure | Authoritative source | Notes |
|---|---|---|
| Approved Budget | Active approved version's immutable snapshot + its approved adjustments | ADR-70/71; without one the page shows *Working budget (not approved)* |
| Committed | Sent/closed PO lines + applied supplier variations + committed new-scope lines, net of posted invoicing and approved claims | ADR-55, ADR-62, ADR-63 (one formula) |
| Claimed / Actual / Invoiced | Approved progress claims; posted supplier invoices (replacing their claim); posted supplier credits reduce Invoiced/Actual | ADR-30, ADR-31, ADR-68 |
| Forecast Final Cost | Actual + Remaining Committed + authored Uncommitted Cost to Complete (`forecastLines`) | Supplier variation exposure shown separately, never added |
| Contract revenue | Original Contract Value (commercial baseline) + approved client variations | ADR-20; credit notes never move it |
| Margin | Forecast revenue − Forecast Final Cost | Unaffected by invoicing or cash |
| Client receivables | Issued client invoices − credits − retention held + released − receipts | One selector: `lib/clientReceivables.js → receivableContext` |
| Supplier payables | Posted invoice `payableTotal` + released retention − credits − payments | `lib/supplierPayments.js`, `lib/payments.js` |
| Cash | Posted receipts (in) and posted payments (out), by transaction date, gross | Not a bank balance |
| Final Account | An approved revision's stored figures, recomputed by the server at approval | ADR-77; never recalculated afterwards |

**Lifecycle status.**

| Stage | Status |
|---|---|
| Drawing, Quant takeoff, BOQ | LIVE (Quant manual 1A–1D; BOQ foundation) |
| **Estimate** | **NOT BUILT** — Phase 2 step 7 (D1–D3) |
| Tender, Award, Award → draft PO | LIVE (packages independent of the BOQ) |
| Approved Budget (versions, adjustments), BOQ → working budget | LIVE (ADR-70/71/81) |
| PO, Variation, Progress Claim, Supplier Invoice, Credit Note, Retention Release, Supplier Payment | LIVE — lifecycles Rules-enforced; supplier-side cumulative caps **not** authoritative (Phase 2 steps 3–4) |
| Client Invoice, Receipt, Client Credit Note, Client Retention | LIVE (receipts and client entries posted by trusted callables, ADR-89) |
| Refunds / credit settlement | **NOT BUILT** — Phase 2 step 5 (D6–D8); an amount owed to a client blocks the Final Account |
| Forecast, Cash Flow (actual, forecast, chart), Margin | LIVE |
| Commercial Report, Portfolio | LIVE (Portfolio: some access, parity and performance checks open) |
| Final Account | LIVE and accepted (C1-A closed 25 November 2026) |

**Remaining commercial gaps** (ADR-92 D10; tracker D4a). In Phase 2:
retained supplier-invoice credits (G1), authoritative supplier cumulative
caps (G2), dependency-safe supplier voids (G3), original contract value
protection (G5), supplier payment over-reconciliation (DC18). Retained for
Phase 3: client over-invoicing policy (G4), numbering (G6), legal identity
and printable tax invoice (DC15), forecast-line shape validation.

---

## C. Product modules

Detail: [PRODUCT.md](../PRODUCT.md) (module tiers), [ROADMAP.md](../ROADMAP.md)
(*Development Order*), and the named ADRs.

| Module | Status | Built | Outstanding / constraints |
|---|---|---|---|
| **Core commercial** (cost codes, budgets, POs, variations, claims, supplier invoices, credits, retention, payments, client invoices, receipts, client credits and retention) | LIVE | All lifecycles; read-time figures; Rules-enforced lifecycles; client finance via trusted callables | Phase 2 steps 2–6 move the remaining financial mutations to the backend and close supplier-side caps. PO "send" is a status only — no PDF or email |
| **Dashboard** (Premium v2) | LIVE (ADR-42/45) | Portfolio counts + one selected project's KPIs and programme panel | §22 role and layout checks 2–3 not run. No portfolio money on the dashboard (by decision) |
| **Project administration** | LIVE | Create; edit name, status, location, start date, progress; per-project currency (locks once money exists) | No delete (by design) |
| **Documents & Drawings** | LIVE (ADR-28, ADR-73–75, ADR-83) | Drawing register with immutable revisions; general documents; authenticated downloads; token revocation | Assigned externals read every revision, withdrawn included (D3 #4, policy open). Photos: placeholder |
| **Procurement** (tender, award, award → PO) | LIVE (ADR-32, ADR-61) | Packages by cost code, manual bids, comparison, award decision, one linked draft PO | BOQ-built packages, invitations, bid levelling, award rescission, split awards: deferred |
| **Estimating & BOQ** | BOQ LIVE; estimating NOT BUILT | BOQ with rates, Quant link, BOQ → working budget transfer (callable) | Phase 2 step 7: estimate layer, rate components, prelims, contingency, overheads, markup or margin, approved revisions (D1–D3) |
| **Quant™** | LIVE 1A–1D (ADR-51–54) | Calibrated manual takeoff, BOQ link and explicit apply, deductions, project summary | Quant AI deferred |
| **PULSE™** | LIVE 1A/1B/1C (ADR-47/49/67) | Nine deterministic health indicators; acknowledgement | No scores, trends, prediction or AI |
| **SHIELD™** | LIVE foundation + 2A/2B1/2B2 (ADR-50/68/70/71) | Five assurance checks; claim–invoice pairing; approved budget versions; adjustments | Single-actor segregation alert deferred to step 6. Supplier-invoice integrity re-derives `retentionGst` (must become version-aware, step 3). **Never HSEQ** |
| **GANTT™** | LIVE 1A1/1A2/1B + core completion (ADR-64–66, ADR-79) | Programme chart, finish-to-start dependencies, approved baselines and variance, attention filter, CSV and print | No critical path, auto-reschedule or calendars. Financially inert |
| **IQ™** | NOT BUILT — DEFERRED | — | AI placeholder rule (AGENT.md) in force |
| **Reporting & analytics** | LIVE: Commercial Report (L2-A), Portfolio (L2-C, ADR-78) | CSV + print; currency-grouped portfolio, never summed across currencies | Charts, trends, saved history not built |
| **Cash Flow** | LIVE | Actual; forecast by due date; manual timing lines; visualisation | Date filtering and invoice retiming deferred; retention held and GST/BAS excluded and warned |
| **Final Account** | LIVE and accepted (ADR-77) | Draft revisions, trusted approval recomputing every figure, immutable revisions, drift comparison, CSV and print | Client signature and subcontract final accounts not built; settlement of amounts owed to clients (step 5); segregation (step 6) |
| **Company & team** | LIVE (L1, ADR-72; ADR-84) | Invitations, roles, deactivation via callables; operator-provisioned externals with project assignment | Last-admin protection only; no approver-count protection yet |
| **Customer onboarding** | NOT BUILT | Operator bootstrap scripts | Gated — section O |
| **Subscription billing & entitlements** | NOT BUILT | — | No scope recorded in the repository |
| **Mobile & field** | Responsive web only | Touch-ready layouts | PWA, offline and native not started; D3 #32 and #36 are inputs |
| **External integrations** | NOT BUILT | `externalRefs` fields reserved on documents | Xero assessed, DEFERRED (ADR-82 PROPOSED, not approved) |

---

## D. Technical architecture

**Stack (VERIFIED from the `package.json` files, 27 November 2026).**

| Layer | Technology |
|---|---|
| Frontend | React 19.2, Vite 8.0, Tailwind CSS 4.3, React Router 7.18, Recharts 3.8, JavaScript (no TypeScript), Firebase JS SDK 12.15 |
| Trusted backend | `frontend/functions/` — Gen 2 Cloud Functions, codebase `team`, **Node.js 22** (`firebase.json` → `nodejs22`), firebase-admin 14.5, firebase-functions 7.4 |
| Data | Firebase Auth (email and password), Cloud Firestore, Cloud Storage |
| Hosting | Firebase Hosting, deployed by the Product Owner (no CI deploy stage) |
| CI | Azure Pipelines (`azure-pipelines.yml`) on Node 24.19.0: lint (blocking), unit, Rules emulator, transitional-rules and bundle freshness checks, Functions emulator. No deploy |
| Tests | Vitest 4.1: `test:unit`, `test:rules`, `functions:test` (pure; also the Functions predeploy), `test:functions` (emulators). firebase-tools 15.34 (needs Java 21+) |
| Infrastructure | Firebase / GCP project `constrapp-69b5d`; region `australia-southeast1`; emulator project `demo-constrap-test` (tests only; suites start only through the isolating launcher — section I); no `.firebaserc` — every deploy names `--project` |

**Repository structure.** `frontend/` is the whole application:
`src/pages`, `src/components`, `src/hooks` (all Firestore access), `src/lib`
(pure domain logic); `functions/` (trusted backend; `src/generated/` holds
bundles built from `src/lib`); `tests/{unit,rules,functions}`;
`firestore.rules` (FINAL) and the generated `firestore.transitional.rules` /
`firestore.m2a2-transitional.rules`; `storage.rules`; `scripts/` (bundle
builders, transitional generator, capacity tools, dev launchers). `ops/`
holds monitoring policy files, the recovery procedure and the runbook.
`docs/` holds this file and the detailed documentation; `docs/Constrapp_v5.jsx`
and the Word document there are the original prototype artefacts (visual
reference only, not requirements).

**Patterns that must be preserved.**

- **Hooks-only Firestore access**; pages never import `firebase/*`.
- **Keyed-snapshot subscriptions** with derived loading and a failed read
  shown as unavailable (ADR-41); figures gated on verified sources (ADR-44).
- **Pure domain modules in `src/lib/`; no formula in the Functions package.**
  A trusted callable runs a **generated bundle** of the browser's own modules
  (`scripts/build-*-bundle.mjs`), checked for freshness by unit tests and CI.
- **Write-outcome helper** (ADR-80): confirmed / failed / *uncertain* — never
  report success early, never retry automatically.
- **Transactional numbering** from `companies/{c}/counters/{type}` (ADR-5).

**Trusted backend boundary (ADR-72 → ADR-89 → ADR-90).** Security Rules are
the trust boundary for client-SDK data. The Functions use the Admin SDK,
bypass Rules, and authorise every call themselves: switch → authenticated →
active membership and role (re-read inside the transaction) → company from the
membership, never from the request. App Check is enforced on every callable.
**Rule since ADR-89:** a mutation that reads an array or a register, holds a
cumulative or cross-document invariant, or derives stored financial figures is
a trusted callable; simple scalar single-document writes stay with Rules;
drafts and reads stay in the browser.

| Service | Purpose | Status |
|---|---|---|
| 8 team callables (`listTeam`, `createInvitation`, `resendInvitation`, `revokeInvitation`, `previewInvitation`, `acceptInvitation`, `changeMemberRole`, `deactivateMember`) | Membership only (ADR-72, ADR-84) | LIVE |
| `processFileLinkRevocations` (scheduled worker, own service account) | Storage download-token removal (ADR-74/75) | LIVE |
| `approveFinalAccount` | Final Account approval (ADR-77) | LIVE |
| `transferBoqToBudget` | BOQ → working budget lines (ADR-81) | LIVE |
| 6 client-finance callables (post/void client credit note, retention release, receipt) | Client finance and per-invoice ledgers (ADR-89) | LIVE |
| `createVariation`, `updateVariationDraft`, `approveVariation`, `applyVariationCommitment` | Variations (ADR-90 and its checkpoint correction) | **Branch only — IMPLEMENTED, NOT DEPLOYED** |

Production: 17 services (REPORTED, Phase 1 release record).

**Rules capacity.** Platform limits: 262,144 bytes of source, about 250 KB
compiled, 1,000 expressions per request. Internal budget: 245,000 bytes on
each of the three files. **Production:** 236,120 bytes (binding transitional
file 236,800). **Branch:** 222,000 (binding 222,610; 22,390 under budget). Compiled size has never
been measured. The expression headroom of the remaining near-ceiling paths
(claims and supplier invoices) was last measured before ADR-90
(TESTING.md §78.2).

**Development and emulator environment.** Frontend and CI run on Node
24.19.0; Functions acceptance runs on **Node 22** through
`npm run test:functions:node22` and `npm run functions:test:node22`, which
refuse any other major version. Emulators need Java 21+. Both emulator suites
refuse to start outside loopback hosts and the test project
(`frontend/tests/_emulatorGuard.js`). The Functions emulator still carries the
operator's Firebase CLI credentials (D3 #17; section F).

**Known technical debt and transitional architecture.** Transitional rulesets
are generated, never hand-edited, and published only in the release stage
that needs them. 58 older write sites lack the write-outcome helper (D3 #11).
Cache-only answers are taken as final in some providers (D3 #36). Counters are
client-writable (DC6). Supplier-side cumulative caps and line contents are
client-enforced (DC18/24/25/29/36/37 — narrowing in Phase 2). Unpaginated
register subscriptions and the per-type number counter are known scale
ceilings (ARCHITECTURE.md → *Capacity and load-test plan*).

Detail: [ARCHITECTURE.md](ARCHITECTURE.md), [DEPLOYMENT.md](DEPLOYMENT.md),
[ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md).

---

## E. Data architecture and financial integrity

**Tenancy.** Every document except `users/{uid}` lives under
`companies/{companyId}/…`, project data under `…/projects/{projectId}/…`.
`users/{uid}` is the one authoritative, client-read-only membership document
(`companyId`, `role`, `status`; `projectIds` for external roles). Rules `get()`
it and compare `companyId` with the path. Deactivation clears `companyId` and
`role`, so the next request fails. Detail: [DATA_MODEL.md](DATA_MODEL.md),
[SECURITY.md](SECURITY.md).

**Integrity rules that apply everywhere.**

- Forward-only lifecycles; financial records are never deleted (void or
  cancel by status). Issued, posted and approved documents are immutable.
- Names snapshotted at write time, never backfilled.
- Ex-GST canonical amounts; flat Australian 10% GST; per-project currency,
  no FX.
- Paired cross-document writes are verified with `getAfter()` (ADR-61,
  ADR-68) or — since ADR-89 — performed in one server transaction.
- Approved records (budget versions, adjustments, baselines, Final Account
  revisions) are never recalculated; corrections are new records.

**Calculation versioning (ADR-86, ADR-91).** Receivable side: exact integer
cents since Phase 1. Payable side: `calcVersion` on a document — absent or 1
is the legacy `roundMoney(x × 0.1)` (one cent low on some half-cent
boundaries, and not sign-symmetric); 2 is exact, half away from zero; any
other value is refused. It is written once by the backend; a document is
always recalculated under its own version; a derived document takes its GST as
an integer share of the source's stored figure and records `sourceCalcVersion`
(the rule is fixed; implementation comes with steps 3–4). **Implemented so
far: variations only, on the branch.**

**Ledgers and aggregates.** One `clientInvoiceLedgers/{invoiceId}` per client
invoice (credited, retention credited and released, received cents; `seq`),
written only by callables, with invariants I1–I4 (ADR-87/88/89). A missing
ledger reads as zero only once the project's receipt-baseline marker exists.
The approved-budget pointer carries the adjustment ledger (ADR-71).
**Supplier-invoice ledgers with a lazy historical baseline are APPROVED in
principle (D10), not built.** Per-PO or per-line aggregates for cumulative
claiming are to be assessed in step 3 (D11).

**Idempotency and concurrency.** Callables are idempotent by document state:
a repeat by the same caller answers `alreadyApplied` with no second write or
audit event. Creates are idempotent by a client-chosen document id (ADR-90).
Contention is confined to one document (an invoice ledger, a variation);
contention on every attempt is a typed *busy* refusal; any other unexpected
failure is reported as *uncertain*. Company-wide number counters are the known
shared contention point.

**Corrections and voids.** Voids are invariant-based, not strict reverse order
(ADR-89 void policy): a void that would break a ledger invariant is refused
and names the entry in the way; a client retention-release void is refused
while receipts rely on it. A client invoice cannot be voided while credits or
releases are posted (ADR-87 D6). **D8 extends this to any receipt allocation,
including legacy ones — APPROVED, not built.**

**Protections by document (production unless marked).**

| Document | Protected by | Notable limits |
|---|---|---|
| Budget lines, approved versions, adjustments | Rules; immutable snapshots; pointer pairing | Drift acknowledgement is client-side (DC44/45) |
| Purchase Orders | Rules lifecycle (ADR-57) | Cancel policy client-side (DC35); line contents unverified (DC34) |
| **Variations** | Rules lifecycle (ADR-59); **branch: create, approve and apply by callables (ADR-90)** | Draft line contents (DC37, narrowed on the branch) |
| Progress claims | Rules lifecycle (ADR-58); claim–invoice pairing (ADR-68) | One open claim per PO and cumulative claiming client-side (DC3/36) — step 3 |
| Supplier invoices | Rules lifecycle (ADR-40); posted is terminal | Line and PO over-invoicing client-side (DC29); approve and post not transacted — step 3 |
| Supplier credits, releases, payments | Rules lifecycle and per-document caps | **Cumulative caps client-side (DC24/25/18); voids unguarded (G3); retained invoices cannot be credited (G1)** — step 4 |
| Client invoices | Rules lifecycle; void blocked while credits or releases are posted | Over-invoicing warned only (DC14, Phase 3) |
| Client receipts, credits, retention | Trusted callables + ledger (ADR-89) | No refund or re-allocation (step 5) |
| Forecast lines | Role-only Rules | No shape validation (Phase 3 finding) |
| Commercial baseline | Rules shape; legacy original budget frozen | **Original Contract Value freely editable (G5) — step 6** |
| Final Account | Trusted approval; immutable revisions | Self-approval permitted and recorded |

---

## F. Security architecture

- **Tenant isolation:** the company comes from `users/{uid}` in Rules and in
  callables; no callable accepts a company id.
- **Project-level access:** external roles (`client`, `subcontractor`) read
  only their assigned projects' drawings and project documents (ADR-83/84);
  the project document itself is internal-only; externals see an
  external-safe directory entry.
- **Roles:** financial roles are `company_admin`, `project_manager`, `qs`;
  approvers of budget versions, adjustments, baselines and the Final Account
  are `company_admin` and `project_manager`. `super_admin` is operator-only and
  has no Rules powers.
- **Revocation:** deactivation and role changes take effect on the next
  request; callables re-read membership inside their transaction.
- **Firestore Rules strategy:** access, drafts and immutability — *not
  arithmetic* (ENGINEERING_STANDARDS.md §9). Every Rules change is measured
  against the byte budget; transitional rulesets are generated.
- **Storage:** scoped paths, role gates, content-type and size checks;
  authenticated SDK reads only (ADR-73); legacy download tokens removed by the
  worker after membership changes and every two hours (ADR-74/75; DC46 CLOSED
  with accepted risks).
- **Trusted Functions:** App Check enforced; instance caps; typed errors that
  leak nothing; one audit event per committed financial operation
  (`companies/{c}/auditEvents`, Admin SDK only).
- **Financial authority migration:** client finance (ADR-89) live; variations
  (ADR-90) on the branch; claims, supplier invoices and supplier settlement in
  steps 3–4.
- **Approval segregation:** **not enforced anywhere today** (DC4). D4/D5 are
  approved for step 6 (optional company policy, default off, two-approver
  precondition, revocation never blocked).
- **IAM and service accounts:** callables run as the default runtime account;
  the worker has its own service account invocable only by Scheduler. No key
  files. Secrets in Secret Manager (`EMAIL_API_KEY`); nothing secret is
  `VITE_`-prefixed.
- **App Check:** enforced on every callable; **general enforcement on
  Firestore, Storage and Auth is NOT enabled** (metrics only).
- **Emulator credential isolation:** PARTIAL — the project and host guard is
  verified; the Functions emulator still holds the operator's CLI login
  (D3 #17 OPEN).

**Requirements that must never be weakened:** tenant isolation; Rules refusing
every client path to a backend-only mutation; callables authorising themselves
and deriving every stored figure; immutability of issued, posted and approved
records; no secret in the bundle or in Git; no production action without a
named authorisation; the honesty protocol (ENGINEERING_STANDARDS.md §7 — never
call a client-only control enforced).

Open findings: section O; [SECURITY.md](SECURITY.md) → *Deferred Controls*.

---

## G. Architectural decision index

All decisions: [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) (ADR-0a to
ADR-92). Those that most constrain future engineering:

| ADR | Subject | Decision and continuing constraint | Status |
|---|---|---|---|
| 0a, 3, 4 | Cost-code spine; read-time derivation | Every line carries a cost code; no rollups on budget lines | LIVE |
| 5, 11, 12 | Numbering; forward-only lifecycles; no deletion | Counter in the same transaction; status changes only | LIVE |
| 20, 21 | Revenue; per-project currency | The contract sum is revenue; currency is a label, no FX | LIVE |
| 40, 57–59 | Rules-enforced lifecycles (invoices, POs, claims, variations) | Stamps are the caller at server time; revision +1 | LIVE |
| 41, 44, 80 | Subscription and error standards | Unavailable, never zero; uncertain, never "saved" | LIVE |
| 55, 62, 63 | One Remaining Committed formula; variation commitment; new scope | Recognised once; the PO is never edited | LIVE |
| 60, 69, 76, 85 | Rules capacity recoveries | Byte-identical or proven-equivalent rewrites only | LIVE |
| 68 | Claim–invoice pairing | One active claim-sourced invoice per approved claim | LIVE |
| 70, 71 | Approved Budget versions and adjustments | Immutable snapshot; adjustments bound to a version | LIVE |
| 72 | Trusted backend for team management | Membership in `users/{uid}`; callables authorise themselves | LIVE |
| 73–75 | DC46 download-token revocation | Authenticated reads; worker removes tokens | LIVE (DC46 closed) |
| 77 | Final Account approval callable | The server recomputes; revisions immutable | LIVE |
| 78 | Portfolio | Grouped by currency; never summed across currencies | LIVE |
| 81 | BOQ → working budget callable | Working lines only; never an approved version | LIVE |
| 82 | Xero | One-way export design | **PROPOSED, not approved; deferred** |
| 83, 84 | External project isolation | Assigned projects only; operator provisioning | LIVE |
| 86 | Money precision | Exact receivables; payable side left for a versioned change | LIVE |
| 87, 88 | Client credit notes; client retention | Per-invoice ledger; proportional retention credit | LIVE |
| 89 | Trusted transaction boundary; ten permanent principles | Complex mutations are callables; Rules are for access | LIVE |
| **90** | Trusted variation processing | Create, approve and apply by callables; Rules keep draft, submit, reject, withdraw | **IMPLEMENTED, NOT DEPLOYED** |
| **91** | Version-aware supplier calculation | `calcVersion`; recalculate under the document's own version; derived documents share stored figures | **Foundation IMPLEMENTED (variations); remainder APPROVED** |
| **92** | Phase 2 programme decisions D1–D11 | Below | **APPROVED (REPORTED, 27 November 2026)** |

**Phase 2 decisions D1–D11 (ADR-92, as directed by the Lead Architect — read
the ADR for the full wording; do not reinterpret):**

| | Decision |
|---|---|
| D1 | Estimate layer over the BOQ with immutable approved revisions; optional rate components reconciling to the unit rate; prelims, contingency, overheads (classified, no double count), markup or margin, sell price; revisions reconstructable without one unbounded document |
| D2 | Explicit basis `markup_on_cost` / `margin_on_sell` in basis points; exact sell price; a margin of 100% or more is invalid |
| D3 | The ADR-81 transfer stays, ungated; show live vs approved estimate; the budget is cost; sell price only as a reviewed contract-value prefill |
| D4 | Optional company-level segregation, default off; an independent approver (not the creator, last material editor or preparer); the exact revision; no administrator bypass; authoritative enforcement |
| D5 | Two eligible approvers to enable; revocation never blocked; fewer than two → approvals fail closed, never silently disabled; operator-controlled, audited policy changes |
| D6 | `clientRefunds` and `clientReceiptApplications` as separate facts with the full invariant list; Final Account protection extended, not weakened |
| D7 | Settlement within one company, project, client and currency; no client wallet |
| D8 | Invoice void refused while any allocation or dependency remains, legacy included |
| D9 | ADR-91: sign-symmetric half-away-from-zero; no retrospective recalculation; version-aware SHIELD and drift checks; server-validated provenance |
| D10 | In Phase 2: G1, G2, G3, G5, DC18; supplier ledgers with a lazy baseline (local only). Phase 3: G4, G6, DC15, forecast-line shape |
| D11 | Migrate the complete authority boundary (variations; claims and invoices as one unit; supplier settlement); assess real bounds; prefer bounded aggregates; measure the Rules recovery |

---

## H. Development history and completed milestones

Production status is REPORTED from release records unless marked VERIFIED.
Detail: [ROADMAP.md](../ROADMAP.md) → *Completed Foundations* and *Strategic
Development Sequence*; DEPLOYMENT.md release records; the archive.

| Milestone | Status |
|---|---|
| Commercial foundations (cost codes → cash flow, BOQ, tenders, contacts, documents, RFIs, currency) | LIVE |
| Commercial integrity M1–M3 (forecast integrity, read containment, PO, claim and variation lifecycle Rules, award → PO, variation commitment, new scope) | LIVE from 27 October 2026 |
| PULSE 1A–1C; SHIELD foundation, 2A, 2B1, 2B2; Quant 1A–1D; GANTT 1A1–1B and core completion | LIVE (October – 20 November 2026) |
| L1 team management and the Constrap brand | LIVE and accepted, 11 November 2026 |
| DC46 A/B/C (download tokens) | LIVE; **DC46 CLOSED 18 November 2026** with accepted risks |
| Firestore recovery protection | ENABLED 18 November 2026; restoration verification SUCCESSFUL (REPORTED) |
| L2-A Commercial Report; L2-B Final Account; L2-C Portfolio | LIVE; Final Account accepted (C1-A, 25 November); Portfolio partially accepted |
| L3 reliability (monitoring, error recovery) | CLOSED; D3 #32 fixed and production-verified 26 November 2026 |
| L4 BOQ → budget transfer | LIVE and accepted, 22 November 2026 |
| M2-A2 external project isolation, Stages A and B | LIVE; CLOSED 24 November 2026 |
| C1 core acceptance closeout (A–D) | CLOSED 24–25 November 2026 |
| **Commercial Finance Phase 1** (ADR-85–89) | **LIVE and CLOSED 27 November 2026**; merged `9e31bb0` → `c9df38b`; closeout docs merged `dfe3618` (VERIFIED in Git) |
| **Phase 2 steps 0–2** (ADR-90–92) | **IMPLEMENTED locally — not accepted, not committed, not deployed** |

Architectural transitions: client-SDK only → narrow trusted backend (ADR-72)
→ individual financial callables (ADR-77, 81) → the trusted transaction
boundary as the rule for complex mutations (ADR-89) → migration of existing
Rules-validated paths (ADR-90, Phase 2).

---

## I. Current development checkpoint

| Item | State |
|---|---|
| Date | 28 November 2026 (NZDT) |
| Active phase / workstream | Phase 2 — Commercial Completion; **production release, Stage A completion — awaiting the Lead Architect** (Stage A assessment ACCEPTED, REPORTED) |
| Branch / HEAD / tree | `fix/phase2-release-preparation` / `c74f8f4` — created from a clean `main` equal to `origin/main` and remote `main` (VERIFIED) |
| Working tree | Uncommitted: M1 monitoring correction (`ops/monitoring/phase2/phase2-financial-inconsistency.policy.json`, `phase2-refusal-codes.json`, README), `tests/unit/phase2Monitoring.test.js`, and docs (DEPLOYMENT, TESTING §91, tracker, this handover) |
| Latest accepted checkpoint | Phase 2 integrated (`7e71793`) and CI-corrected (`c74f8f4`, D3 #56); Stage A read-only assessment accepted (REPORTED) |
| Latest implementation checkpoint | Steps 3–6 implemented in one programme (ADR-93 claims and supplier invoices; ADR-94 supplier ledgers, G1–G3, DC18; ADR-95 client refunds and receipt applications, D8; ADR-96 approval segregation and G5). Steps 0–2 closed LOCALLY by the architect (rulings recorded on the ADR-90 / ADR-91 correction). Report delivered 28 November 2026 |
| Accepted test baseline | 10,480 tests at `c74f8f4`: unit 6,489 · Rules 2,861 · Functions pure 296 · Functions emulator 834 (REPORTED; Azure #20261128.2 green VERIFIED) |
| Latest results (branch, local) | TESTING.md §91.10 / the Stage A completion report: `phase2Monitoring.test.js` 30 / 30; Phase 1 callable emulator suites; whitespace and link checks |
| Runtimes | Node 24.19.0 (frontend, Rules suite, CI); Node 22.23.2 (both Functions suites); JDK 26 for the emulators |
| CI | `c74f8f4` GREEN (Build #20261128.2); the branch is uncommitted |
| Production | Phase 1 LIVE, verified read-only 28 Nov 2026; Phase 2 not deployed; TEST-company writes only (A2 fixture, PM invitation) |
| Changed-file scope | The eight files of the Stage A completion (release-preparation manifest in the report); no application, Rules or Functions source change |
| Authorised scope | Stage A completion only: read-only production inspection; A2 synthetic fixture and the PM invitation in the TEST company; monitoring definitions and docs. **No deployment, monitoring creation, activation, IAM change or Git integration** |
| Pending Product Owner actions | Review; commit in the dependency-ordered groups of the checkpoint report; no deploy. Earlier: two stale local allowlist entries naming the old emulator project |
| Pending architect decisions | Accept steps 3–6; confirm the refinements (three callables with operation discriminators; payments / receipts / refunds / applications recorded, not segregated; supplier credits by cost-code and tax-code group; posting re-derives and refuses moved figures; no transitional ruleset for steps 3–6 — a maintenance restriction instead); authorise the read-only production inventories (variations, supplier history, counters, baselines); release grouping; then Step 7 |
| Known limitations | Nothing deployed. Production history (variations, claims, supplier settlement) not inventoried: the baselines refuse or mark inconsistent what they cannot account for. Compiled Rules size and post-change expression headroom not measured. No per-user rate limiting on the new callables. Rules-held approvals compare creator / last updater only. Refusals on Rules-held approvals show a generic permission message. Browser acceptance is local only and partial (TESTING.md §87.5) |
| Next recommended action | Lead Architect review of the consolidated checkpoint → authorise Step 7 (CC1 estimating) and the read-only production inventories that gate the release of steps 2–6 |
| CI correction (28 Nov 2026) | D3 #56: Azure #20261128.1 failed because `ProjectFinalAccount.jsx` gained `useApprovalPolicy` (D3 #51) and its render test did not mock it — the hook imports `src/lib/firebase.js`, whose `getAuth(app)` throws without an API key. Local runs passed only because `.env.local` reached the unit suite. Fixed on `fix/phase2-ci-validation`: mock added, `vitest.config.js` `envDir: false`, `tests/unit/unitIsolation.test.js`, ENGINEERING_STANDARDS §4. No application, Rules, Functions, pipeline or production-configuration change. Evidence TESTING.md §90 |

---

## J. Phase 2 — Commercial Completion programme

One consolidated, authorised programme with reviewable checkpoints (ADR-92;
ROADMAP.md → *Phase 2* progress register). Identifiers: CC1–CC5 are ROADMAP
Phase 2 items 1–5; **CC6 is the supplier monetary precision work (D3 #35)**;
CC7 is integrated acceptance.

| Step | Scope | Depends on | Key requirements | Status | Production implication |
|---|---|---|---|---|---|
| 0 | ADRs, progress register, environment safety | — | Functions acceptance on Node 22; fail-closed emulator guard | **CLOSED (local)** | None |
| 1 — CC6 | `lib/supplierCalc.js`, `calcVersion` | 0 | Legacy byte-identical; exact and sign-symmetric; independent oracle | **CLOSED (local)** — carried through claims, invoices, credits, releases (ADR-93/94) | Ships with the first document type that uses it |
| 2 — CC5-A | Trusted variations (ADR-90) | 1 | Complete boundary; no derived input accepted; reviewed revision; Rules −10 KB | **CLOSED (local)** — not deployed | 3 new and 7 rebundled callables, switch, Hosting, FINAL Rules (DEPLOYMENT.md → *Phase 2 step 2*) |
| 3 — CC5-B | Claims and supplier-invoice pairing: claim create and approve, claim-sourced invoice create, link existing, cancel, post | 1, 2 | One unit; per-PO / per-line aggregates assessed; version-aware SHIELD and drift; measured Rules recovery | **IMPLEMENTED, NOT DEPLOYED** (ADR-93) | Step 2's cutover pattern; may share a release with it |
| 4 — CC4 | Supplier-invoice ledgers and lazy baseline; retained-invoice credits (G1); cumulative caps (G2); dependency-safe voids (G3); payment protection (DC18) | 3 | The baseline accounts for every historical fact; fail closed; no rewrite; no supplier refund workflow | **IMPLEMENTED, NOT DEPLOYED** (ADR-94) | Baseline initialisation in production needs its own authorisation |
| 5 — CC3 | `clientRefunds`, `clientReceiptApplications`; Final Account settlement protection; D8 invoice-void protection | ADR-89 base | D6–D8 invariants; a refund is not a negative receipt | **IMPLEMENTED, NOT DEPLOYED** (ADR-95) | Client-finance callables + Rules |
| 6 — CC2 | Approval segregation (D4/D5); original contract value protection (G5) | 2–5 (approval points become callables) | Policy default off; operator-set; no administrator bypass; revocation never blocked | **IMPLEMENTED, NOT DEPLOYED** (ADR-96) | Company policy flag, operator-set |
| 7 — CC1 | Estimating (D1–D3) | 6 (segregation of estimate approval) | Bounded, immutable revisions; exact markup and margin | NOT STARTED | New collections and callable |
| 8 — CC7 | Integrated lifecycle acceptance; cutover design | 1–7 | Independent financial parity; historical fixtures; local browser on emulators | NOT STARTED | Produces the production cutover plan (not authorised) |

---

## K. Forward roadmap

Programme structure confirmed by the Product Owner and Lead Architect
(REPORTED, 27 November 2026; recorded in ROADMAP.md → *Consolidated phase
plan*). The earlier gap — "Phase 4" undefined in the repository — is closed.

| Phase | Status | Content |
|---|---|---|
| Foundation and previous acceptance | **CLOSED** within accepted scopes | Security, reliability, reporting, GANTT, monitoring (section H; tracker section B) |
| Phase 1 — Commercial Finance | **ACCEPTED and LIVE** | ADR-89 client-finance boundary (section H) |
| Phase 2 — Commercial Completion | **CURRENT** | D1–D11 and the step order of section J — unchanged |
| Phase 3 — Production and SaaS Readiness | **PENDING** — no implementation authorised; architecture and sequencing subject to a future assessment | Remaining security hardening; deferred onboarding controls; scalability and load testing; company and customer onboarding; subscription billing; feature entitlements; international readiness; supported-jurisdiction tax handling; legal company identity; printable tax invoices; duplicate document numbering (DC6 / G6); client over-invoicing policy (DC14 / G4); production monitoring; recovery and operational readiness; CI/CD optimisation; outstanding customer-readiness reliability and usability findings. **It is the commercial-launch and customer-onboarding readiness gate** |
| Phase 4 — Product Expansion | **DEFERRED** — nothing authorised | In order: (1) mobile and field experience, (2) Xero accounting integration, (3) Constrap IQ, (4) Quant AI, (5) final comprehensive production audit |

**Direction recorded with the phases.**
- *Mobile:* assess PWA and offline-first capability before committing to a
  separate native application.
- *International:* Australia, the Bahamas and wider markets. Sydney
  infrastructure is retained pending evidence that justifies migration;
  latency must be measured from the relevant customer locations. **Currency
  support is not tax compliance.**
- *Xero:* assessed and deferred; ADR-82 remains PROPOSED, not approved.
- *Constrap IQ and Quant AI:* deferred; the AI placeholder rule stays in force.
- *Security:* essential customer-readiness security is never deferred to
  Phase 4.

**Not recorded anywhere — do not assume:** pricing, subscription tiers, an
entitlement model, mobile requirements, AI architecture, launch dates.

**Carried with every phase:** D3 #36, #39, #40, #43; alert coverage for the
client-finance (and, once deployed, variation) callables; outstanding
Dashboard and browser acceptance items.

**Other deferred product decisions (unchanged):** tender invitations, bid
levelling, BOQ-built packages; cash-flow date filtering and retiming; client
progress claims; revenue recognition; subcontract final accounts; client
signature; photos; critical path; negative claims; direct PO invoicing of new
scope; DC46 follow-ups — none approved.

---

## L. Engineering and architectural principles

Binding sources: [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) (§1–§9;
§9 holds the ten permanent principles of ADR-89) and [AGENT.md](../AGENT.md) →
*Strategic Invariants*, *Financial Invariants*.

- Build a production-grade commercial application: one connected system of
  record, no competing financial models, authoritative calculations reused.
- Preserve historical financial records; never rewrite issued, posted or
  approved documents; recalculate a document under its own version.
- Enforce important invariants on trusted boundaries; Rules are for access.
- Strict multi-tenant isolation.
- Bounded reads and transactions; refuse by name above a limit, never
  truncate; design for realistic volumes and concurrency; avoid hotspots.
- Backward compatibility: additive fields; an absent field reads as its default.
- Incremental evolution; no wholesale rebuilds; an unavoidable major
  migration is an exceptional decision needing explicit approval.
- Do not overengineer; pay only for justified infrastructure; prefer
  components that idle at zero.
- Never weaken security or testing to go faster; never call a client-only
  control enforced.
- Use the existing architecture unless an evidence-backed change is needed.
- Keep development tied to actual commercial requirements; a field feature
  must state its commercial input or output.

---

## M. Governance and collaboration protocol

Recorded in [AGENT.md](../AGENT.md) → *Collaboration Protocol* (working
conventions, changed by Product Owner decision).

| Role | Responsibilities |
|---|---|
| **ChatGPT** | Lead Software Architect; Senior Software Engineer; Technical Product Lead; reviewer of architecture, implementation, security and financial integrity; roadmap and release oversight; writes briefs and approves gates |
| **Claude Code** | Repository inspection; technical assessment; implementation; testing; documentation; evidence-based reporting. Does not commit, push, merge, deploy, publish Rules or change cloud configuration unless a brief explicitly authorises that step |
| **Product Owner** | Business decisions; material scope approval; product acceptance; commits, pushes and merges; production deployment |

**Working practices.**
- Inspection before significant new implementation; architecture approval
  before material scope expansion; ChatGPT reviews Claude's recommendations
  independently.
- **Programme authorisation (from Phase 2):** a consolidated programme can be
  authorised once. Routine implementation then proceeds without per-step
  approval, through meaningful integration checkpoints, stopping only at the
  programme's stop conditions (ADR-92).
- Focused tests during implementation; integrated suites at dependency
  checkpoints; full acceptance before a major release.
- Consequential deviations are escalated explicitly. No unauthorised
  production operation, ever.
- **Model choice (Product Owner practice):** Opus for routine work; Fable for
  complex architecture, security, financial integrity, concurrency and
  difficult debugging. Fresh sessions for new workstreams where appropriate;
  one session through implementation, review and corrections.
- Every report gives dependency-ordered commit, merge and deployment guidance
  and says whether this handover needs updating.

---


**Standing collaboration conventions (established by the Lead Architect, 28 November 2026 — REPORTED).**
- **Consolidated authorisation.** Several workstreams may be authorised together and implemented as one programme, in dependency order, without a separate report or approval per workstream.
- **Autonomy within approved scope.** Routine technical decisions, refactoring where justified, approved lifecycle paths, tests, ordinary failure diagnosis, in-scope defect correction, isolated browser acceptance and documentation proceed without asking.
- **Meaningful checkpoints.** Work stops only at an agreed integration checkpoint or a genuine escalation condition: unresolved material financial policy, consequential architectural conflict, unresolved security invariant, incompatible historical data, substantial migration, new infrastructure, significant scope expansion, an unresolved engineering blocker, or a required Product Owner action.
- **Consolidated, evidence-based reports** — one per checkpoint, with evidence classes (automated, emulator, browser, production) kept distinct.
- **No repeated approval for routine authorised development.**
- **Production release approval is always separate**: the Product Owner executes every Git integration and production command; Claude prepares numbered terminal blocks (preflight, explicit staging, dependency-ordered commits, push, main verification, merge, main push — with fail-fast checks of branch, baseline and staged files) and never runs them; Azure CI gates precede any production deployment.
## N. Release and operational governance

- **Branches:** from `main` — `feature/`, `fix/`, `chore/`, `docs/`, `ops/`,
  `refactor/`; Conventional Commits; the Product Owner commits and merges
  (merge commits on `main`).
- **CI:** Azure on `main` and on PRs: lint (blocking), build, unit, Rules,
  transitional and bundle freshness checks, Functions emulator. **CI green is
  not a deployment.**
- **Local acceptance:** emulators and synthetic fixtures only; evidence
  classes kept separate (unit, Rules emulator, Functions emulator, local
  browser, production, reasoned but not run).
- **Firebase deployment:** by the Product Owner with an explicit `--project`;
  targeted Functions deploys need `functions:team:<name>`; each release's
  order is in DEPLOYMENT.md (Rules-first, Functions-first or multi-stage).
- **Trusted-backend cutover pattern (Phase 1, ADR-90):** callables deployed
  with the switch off → switch on (a two-line change: the env value and its
  release-safety test pin) → Hosting → acceptance → FINAL Rules. Transitional
  rulesets only when an older bundle must keep writing a shape the FINAL Rules
  refuse.
- **Verification:** confirm the served Hosting bundle before browser checks
  (`index.html` is cached for up to an hour); acceptance is confirmed against
  backend evidence (logs, audit events), never a report alone.
- **Recovery:** fix forward once financial records exist; switches are the
  brake; deactivating a company is a brake, not a data rollback; never
  restore previous Rules after an authority has moved to the backend.
- **Production testing limits:** the acceptance company and new records only;
  no test transactions in the customer company; no account reactivation.

Current deployment dependencies (not authorised): ADR-90 needs three new and
seven rebundled callables, the switch, Hosting, then FINAL Rules; whether it
ships alone or with step 3 is open.

---

## O. Open risks and decisions

| Id | Item | Impact | Status | Phase | Next action |
|---|---|---|---|---|---|
| D3 #56 | Azure CI red on `main` `7e71793` | Integration gate | **CLOSED** — `c74f8f4`, Azure #20261128.2 green | 2 | — |
| — | Phase 2 TEST baseline history (release prerequisite) | Stage G evidence | **MET** — A2 fixture, 17 / 17 cent checks (TESTING.md §91.3) | 2 | Reproduce at Stage G |
| D3 #57 | M1: inconsistency alert would page on the approved Phase 1 void refusal | False ERROR alerts | Corrected on `fix/phase2-release-preparation`, validated read-only | 2 | Integrate (Block 2) before monitoring creation |
| — | Stage G second approver | Segregation acceptance | PM invitation `+ct-pm2` pending | 2 | Product Owner accepts it on firebaseapp.com |
| — | Alert channel `13613525651613947442` (*DC46 - Product Owner*) | Alert delivery | Verified read-only; ownership to confirm | 2 | Product Owner confirms |
| D3 #59 | Five Apex legacy claims without the invoice-link key | Apex activation | No duplicate pairing possible; three cannot be pair-invoiced after activation | 2 | Re-verify and decide before Apex Stage H |
| D3 #58 | Frontend production dependency audit 10 high / 1 moderate | Dependency security | Not a release blocker on present evidence | 3 | Phase 3 upgrade |
| — | Phase 2 steps 0–2 acceptance | Gate to step 3 | Awaiting architect | 2 | Review the checkpoint report and TESTING.md §83 |
| D3 #37 | Near-ceiling Rules paths | Rules capacity | Variations resolved on the branch; claims and invoices open | 2 (step 3) | Step 3; re-measure headroom |
| D3 #35 | Payable-side GST precision | One-cent differences | Foundation on the branch; supplier formulas unchanged | 2 (steps 3–4) | Apply ADR-91 per document type |
| D3 #17 | Emulator holds the operator's CLI credentials | Test-to-production risk (mitigated by the project and host guard) | OPEN | 2 | Decide the `demo-` project rename (about 60 references) |
| DC4 | Approval segregation | Self-approval everywhere | Not enforced; D4/D5 approved | 2 (step 6) | Step 6 |
| G1 / G2 / G3 / DC18 | Credits on retained supplier invoices; cumulative caps; voids; payment over-reconciliation | Financial correctness | Client-enforced or unavailable | 2 (step 4) | Supplier ledgers |
| G5 | Original Contract Value freely editable | Anchors margin and the Final Account | Open | 2 (step 6) | Controlled revision process |
| — | Refunds and credit settlement | Customer onboarding blocker; Final Account blocked by owed amounts | Not built | 2 (step 5) | D6–D8 |
| DC6 / G6 | Counters client-writable | Duplicate numbers possible | Open | 3 | Numbering remediation |
| DC14 / G4 | Client over-invoicing warned only | Billing control | Open | 3 | Policy decision |
| DC15 | No legal identity or printable tax invoice | Not a Tax Invoice | Open | 3 | — |
| D3 #36 | Cache-only answers taken as final | Reliability | P2, open | Every phase | Before onboarding |
| D3 #39 | App Check refusal mis-described on older callables | UX | Open | Every phase | — |
| D3 #11 | 58 write sites without the write-outcome helper | UX on failure | P3 | — | Opportunistic |
| D3 #4 | Externals read withdrawn drawing revisions | Information exposure | Policy open (P1) | — | Architect policy |
| D3 #27–#29, #5–#8 | External-role UI corrections | UX | P2 bundle, open | — | Hosting-only bundle when scheduled |
| D3 #12 | Stale "DC46 still OPEN" comment | Docs | **One remains**, `frontend/src/hooks/useStorageUpload.jsx:99` (tracker says three) | — | Next change to that file |
| — | Compiled Rules size never measured | Release risk | Unmeasured | 2 | Measure at a release |
| — | Billing continuity (owner, second administrator, budget alerts) | The worker stopped for about 17 hours in November | Not done | — | Billing administrator |
| — | General App Check on Firestore, Storage, Auth | Abuse surface | Not enabled | 3 | — |
| — | Monitoring proven only by a synthetic test; no alerts for the client-finance or variation callables | Detection | Partial | Every phase | Alert coverage |
| — | Firestore restore beyond the verification sample; Storage files outside backups | Recovery | Partially proven | 3 (DR) | — |
| — | Load and cost unmeasured | Scale | Designed, not measured | 3 | Load test |
| — | External customer onboarding | Commercial launch | Gated | 3 | Readiness decision after refunds, D3 #36 and the residual risks |
| — | Phase 3 / Phase 4 boundaries | Planning | **RESOLVED 27 November 2026 (REPORTED):** defined in section K and ROADMAP.md. Still open: Phase 3's internal sequencing and architecture (future assessment); no pricing, tier or entitlement model exists | Product Owner / Lead Architect |

Full registers: [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md)
→ *D1*, *D3*, *D4a*; [SECURITY.md](SECURITY.md) → *Deferred Controls*.

---

## P. Immediate continuation instructions

**State (28 November 2026, Stage A):** Phase 2 is merged (`c74f8f4`), Azure
green, NOT deployed. The architect accepted the Stage A read-only assessment
(2 companies, 22 projects, 22 / 22 baselines would establish, 0 inconsistent,
0 duplicates, 6 review findings). Stage A completion (TESTING.md §91): the A2
TEST fixture is in production (17 / 17 independent cent checks; Apex
unchanged; no baseline, ledger or activation); a TEST PM invitation is pending
the Product Owner's acceptance; M1 corrected and validated read-only; the
22-function filter, the five switch pins and Phase 1 callable compatibility
re-verified. Uncommitted on `fix/phase2-release-preparation`.

**ChatGPT, next:** review the Stage A completion report; on GO the Product
Owner runs Block 2 (integration), waits for Azure `main` green, accepts the
PM invitation, confirms the alert channel, then Block 3 (Stage-A monitoring +
Stage B disabled backend) on its own authorisation.

**Earlier state (as written before Stage A):** Phase 2 is complete on the branch, uncommitted
and undeployed: steps 0–8 plus the final release-readiness batch (ADR-98 —
controlled company activation `commercialCompletionEnabled`; D3 #46 resolved
with Rules-maintained `lastMaterialEditBy` on POs and tender packages; D3 #47
refund-void policy; the baseline's final digest inside the completion
transaction; monitoring definitions in `ops/monitoring/phase2/`; read-only
inventory tool `ops/recovery/phase2-inventory.mjs`; the controlled-activation
cutover in DEPLOYMENT.md → *Phase 2 — the complete cutover*). Evidence:
TESTING.md §88–§89; tracker D3 #44–#54.

**Update (28 November 2026, later):** Phase 2 was merged to `main` as
`7e71793` (switches OFF, not deployed). Azure run #20261128.1 then failed in
the unit stage (D3 #56, a test-isolation defect; TESTING.md §90). The
correction is on `fix/phase2-ci-validation`; after its merge, Azure `main`
must be green before stage A is authorised.

**ChatGPT, next (as written before integration):** the architect gave a CONDITIONAL GO for Git integration
with a targeted correction, now done (ADR-98 Decision 9; TESTING.md §89.8;
tracker D3 #52–#55): claim submit and variation submit / reject / withdraw are
Rules-gated on company activation; D3 #53, #54, #52 and the estimating drift
policy are recorded as decided. Confirm GO; then authorise stage A (read-only
inventories, DEPLOYMENT.md → *Phase 2 — the complete cutover* → Stage A) as a
separate step.

**Claude is authorised to implement:** nothing further in Phase 2 until the
report is accepted. Phase 3 and Phase 4 remain out of scope.

**Product Owner, next:** after acceptance, run the ONE consolidated Git
terminal block from the report (it verifies the manifest, the runtimes, every
suite, the staged tree hash BEFORE committing, every kill switch, then
commits, pushes, merges to main and pushes main). Then wait for Azure main CI.
No deployment and no production read follows without separate authorisation.

**Outside authorised scope:** any production write, deployment, Rules
publish, flag change or account change; production baseline initialisation;
commits, pushes and merges; Phase 3 and Phase 4 work (load testing,
international tax, SaaS billing, onboarding, mobile and offline, Xero, IQ,
Quant AI); new infrastructure or dependencies without a stated need.

**Settled (do not reopen without a genuine contradiction):** everything in
section G — in particular ADR-89's boundary rule, D1–D11, ADR-90's boundary
and ADR-91's versioning.

**Open:** section O and the checkpoint decisions above.

**Product Owner, next:** review the final Phase 2 report; when satisfied,
run its ONE consolidated Git terminal block (preflight, staging from the
manifest, commits, feature push, main verification, merge, main push) — the
earlier steps 3–6 blocks are withdrawn (one branch
commit series, push, verification, merge to main). Steps 0–6 ship together as
one integration: their files interleave, so they are committed as layered
groups, not one group per step. No deployment — every new switch stays off in
production (`.env.constrapp-69b5d`).

**Read for detail:** [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) ADR-89 to
ADR-92; [ARCHITECTURE.md](ARCHITECTURE.md) → *Trusted transaction boundary*;
[SECURITY.md](SECURITY.md) → *Variations — trusted backend (ADR-90)*;
[DATA_MODEL.md](DATA_MODEL.md) → *variations*; [TESTING.md](TESTING.md) §82
(Phase 1), §83 (Phase 2 checkpoint), §84 (its corrections), §85 and §87 (steps 3–6, incl. §87.5 browser acceptance); [DEPLOYMENT.md](DEPLOYMENT.md) →
*Phase 2 step 2*; [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md)
→ B18, B19, D3, D4a.

### Starting a new ChatGPT conversation

1. Before leaving the old conversation, have this file refreshed (a
   documentation-only brief) and move anything agreed only in conversation
   into a repository document.
2. Upload this file (add `AGENT.md` and `ROADMAP.md` when planning) and paste:

```
You are resuming the Constrap development programme as Lead Software
Architect, Senior Software Engineer and Technical Product Lead.

The attached CHATGPT_HANDOVER.md is the consolidated handover. It is a
point-in-time snapshot of the repository, not proof of the current Git or
production state. Claude Code is the implementation engineer; I am the
Product Owner and control commits, merges and deployments.

Before giving any direction:
1. Read the handover in full.
2. State the current phase, the checkpoint (section I) and the exact next
   action (section P).
3. List the open decisions (sections I and O). Treat no production action
   as approved.
4. Ask me for the current `git status`, `git log --oneline -5` and anything
   done in production since the handover's Last updated date.
5. Do not reopen settled decisions (section G) or restart completed work
   (section H). Do not treat merged code or passing CI as deployed.

Then wait for my confirmation before issuing a brief.
```

3. In the new conversation, compare the Git state with section I. If it
   differs, establish what changed before directing work.

---

## Maintenance protocol

Binding rule: [AGENT.md](../AGENT.md) → *Development Continuity — ChatGPT
Handover*. In short:

- **Update at meaningful checkpoints:** an approved architectural decision,
  a completed workstream, an integration acceptance, a significant security
  finding or resolution, a material financial policy decision, a roadmap
  change, a production release, an infrastructure or deployment change, a
  session handover, or a change to the next authorised action. Not after
  every minor code change.
- **Targeted updates:** the header table, section I, the affected rows of
  sections C, G, H, J and O, and section P. Do not rewrite the whole file.
- **Pending until proven:** a commit, merge, CI result or deployment the
  Product Owner controls stays *pending* until evidence confirms it; reconcile
  it at the next checkpoint.
- **Superseded text:** when a status changes, replace it here; if the old
  wording has historical value, move it to
  [CHATGPT_HANDOVER_HISTORY.md](CHATGPT_HANDOVER_HISTORY.md) rather than
  growing this file with *as written* paragraphs.
- **Never include** credentials, tokens, keys, sensitive environment values,
  personal account details or customer records.
