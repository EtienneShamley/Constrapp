# Architecture

Current, factual description of the implemented system. Product intent lives in
[PRODUCT.md](../PRODUCT.md); conventions in [AGENT.md](../AGENT.md).

## Conceptual Commercial Architecture

Constrapp is organised around one connected commercial dataset. Conceptually it
moves through six phases, joined end-to-end by the **cost-code spine**:

```
Preconstruction → Procurement → Delivery → Cost Control → Forecasting → Final Account
```

| Phase | What happens | Modules (status) |
|---|---|---|
| **Preconstruction** | Measure quantities, build the BOQ, estimate, transfer to an approved budget | **Drawings** *(implemented — foundation)*; **Quant™ 1A manual takeoff** *(live in production — measurement records)*; **Quant™ 1B** *(live in production — link a measurement to a BOQ item and explicitly apply the reviewed total, ADR-52)*; **Quant™ 1C** *(implemented — not yet deployed; 1C-A area-geometry correctness, draft protection, full geometry editing, on-sheet selection, anchored pan/zoom, accessible dialogs; 1C-B read-only project summary, attention list and Open-in-Quant traceability — no schema or rules change, ADR-53)*; **BOQ** *(implemented — foundation)*; Estimating incl. BOQ → Budget transfer *(planned)*; **Cost Codes**, **Budgets** *(implemented)* |
| **Procurement** | Tender packages, subcontractor invitations, bid levelling, award, commitment | **Tender & Award** *(implemented — foundation)*; subcontractor invitations, bid levelling, and Award → PO transfer *(planned)* → **Purchase Orders** *(implemented)* |
| **Delivery** | Scope variations, cumulative progress claims against commitments | **Variations** *(implemented — foundation)*; **Progress Claims** *(implemented)* |
| **Cost Control** | Supplier invoices, actual cost, payments/credit notes | **Supplier Invoices**, **Supplier Payments**, **Supplier Credit Notes** *(implemented)*; Retention Release *(future)* |
| **Revenue Control** | Client invoices issued against the contract sum and approved client variations; receivables, and the cash received to settle them | **Client Invoices / Accounts Receivable**, **Client Receipts** *(implemented — foundation)* |
| **Forecasting** | Forecast cost to complete and project margin *(implemented — foundation)*; cash flow | **Forecast Cost to Complete**, **Project Margin**, **Cash Flow** (actual + forecast, with visualisation) *(implemented — foundation)*; Cash Flow date filtering *(planned)* |
| **Final Account** | Reconcile budget + variations + actual into final margin; commercial reporting | Final Account, Commercial Reporting *(future/planned)* |

**Cost Codes are the spine** across all six phases: a cost code links a BOQ line
to an estimate, an award to a budget line, a budget line to a PO, and a PO to its
variations, claims, and supplier invoices. Every commercial document snapshots its
`costCodeName` at write time so the whole lifecycle reconciles through one taxonomy.

**What is implemented today** is the Delivery and Cost-Control middle
(Budgets → POs → Progress Claims → Supplier Invoices) plus the Cost-Code spine and
Contacts, the **Variations** foundation, and the **Forecast Cost to Complete**
foundation (read-time, cost-side) — see the module table and factual detail below.
**Planned commercial architecture** (Preconstruction, Procurement
front, Cash Flow/Margin, Final Account) is described conceptually here and in
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md); it has **no implemented schema
yet** — exact collections and fields are decided in each feature's design sprint
(see [DATA_MODEL.md](DATA_MODEL.md) → "Planned Commercial Entities"). **Placeholder
modules** (screens exist, no functionality) are listed in the module-status table.

## Stack

| Layer | Technology | Notes |
|---|---|---|
| UI | React 19 (JavaScript, JSX) | No TypeScript |
| Build | Vite 8 (`@vitejs/plugin-react`) | Vite root is `frontend/` |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` | Tokens in `@theme` in `frontend/src/index.css`; no `tailwind.config.js` |
| Routing | React Router 7 (`react-router-dom`) | `BrowserRouter` |
| State | React Context + hooks | No Redux/Zustand |
| Charts | Recharts 3 | Cash Flow chart only. The Dashboard uses **plain SVG** (no chart library): the Budget, cost & revenue bars and the programme status donut (ADR-45) — its original charts were fabricated data and were removed |
| Backend | Firebase JS SDK 12 — Auth, Firestore, Storage | **Client SDK only** |
| Lint | ESLint 10 (flat config) | `npm run lint` = `eslint . --max-warnings 0`. Standing policy **0 errors / 0 warnings**, blocking in CI (ADR-41) |
| Rules tests | Vitest 4 + `@firebase/rules-unit-testing` + `firebase-tools` 13 (emulator) | `npm run test:rules` — **dev-only**. Requires JDK 17 |
| Unit tests | Vitest 4 (Node, no emulator) | `npm run test:unit` — pure `lib/` domain logic plus a few structural source tests (`tests/unit/`); separate config (`vitest.config.js`). **No jsdom, no testing-library** |
| CI | Azure Pipelines (`azure-pipelines.yml`) | `npm ci → lint → test:unit → test:rules → build`, all blocking. No deploy stage |

## Client-SDK-Only Backend

There is **no backend code**: no Cloud Functions, no server, no `functions/`
directory, and no `.firebaserc`. (`frontend/firebase.json` declares the Firestore
and Storage emulators, the two rules-file paths for the automated Security Rules
suites, and a **Firebase Hosting** block, first deployed by hand on 19 October
2026 — no functions target, and with no `.firebaserc` a deploy must name
`--project` explicitly.) The browser talks directly to
Firebase Auth, Firestore **and Cloud Storage**, which since the Documents &
Drawings foundation carries real file bytes. All business rules run client-side,
backed by **two** rules files — `firestore.rules` and `storage.rules` — which are
the only trust boundaries (see [SECURITY.md](SECURITY.md) for what they do and do
not enforce). Cloud Functions and server-side enforcement are deliberate
deferrals — see [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md).

A root-level `backend/` directory exists but is a **reserved, intentionally empty
placeholder** — it holds no code and no configuration. It marks where a future
trusted backend would live; do not treat it as an existing backend. The controls
that must be activated when that backend arrives are listed in
[SECURITY.md](SECURITY.md) → Trusted-Backend Activation Requirements and
[ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §6.

## Repository Layout

```
frontend/                  The entire application (run all npm commands here)
  firestore.rules          Firestore security rules — published manually (see DEPLOYMENT.md)
  storage.rules            Cloud Storage security rules — the SECOND trust boundary,
                           also published manually
  firebase.json            Firestore + Storage EMULATORS, both rules paths, and a
                           Hosting block, deployed by hand since 19 October 2026 (no functions, no .firebaserc)
  vitest.rules.config.js   Vitest config for the rules suite (Node, no app plugins)
  vitest.config.js         Vitest config for the UNIT suite (tests/unit/ only)
  tests/rules/             Firestore AND Storage Security Rules tests (both emulators)
  tests/unit/              Unit tests for pure lib/ domain logic (no emulator)
  .env.example             Vite env vars (Firebase web config)
  src/
    main.jsx               Entry — StrictMode + App
    App.jsx                Providers + all routes
    index.css              Tailwind import + @theme tokens + base styles
    components/            Card, Btn, Badge, Stat, ProgBar, PageHeader, ProtectedRoute,
                           ErrorBoundary (wraps <App/> in main.jsx — the ONLY class
                           component; renders a reload fallback and never shows a stack)
    layouts/               AppShell, Sidebar, TopBar, AuthLayout, ProjectDetailLayout,
                           ProjectCommercialLayout (Commercial sub-nav:
                           Margin | Client Invoices | Client Receipts |
                           Supplier Payments | Cash Flow),
                           ProjectDocumentsLayout (Documents sub-nav:
                           Drawings | General Documents)
    pages/                 Login, CreateAccount, ForgotPassword, Dashboard (+ dashboard/:
                           ProjectSnapshot — the financial-role-gated child that
                           mounts the snapshot's financial hooks; ProgrammePanel —
                           the programme-role-gated child that mounts the one
                           activities hook; PortfolioSummary, KpiCard,
                           CostPerformanceChart, ProjectRegister — presentation
                           only, ADR-45), Projects,
                           CompanySettings (country & base currency),
                           Contacts (company directory), Subcontractors (filtered
                           contacts view), Pulse, Shield and Quant (hidden pointer
                           pages to the project tabs — no subscription)
    pages/project/         ProjectOverview, ProjectShield (SHIELD™ foundation,
                           ADR-50; pages/project/shield/ShieldCheckCard.jsx is
                           its presentation-only card), ProjectQuant (Quant™ 1A
                           role gate + branded heading, ADR-51),
                           project/quant/ (TakeoffWorkspace — selection (remembered
                           per project in sessionStorage via lib/quantSelection.js,
                           ADR-52 Decision 9), tools, drafts and the geometry-edit
                           session (remembered per project via lib/quantDraft.js and
                           guarded by one discard confirmation, ADR-53), zoom;
                           SourcePicker (page input commits on Enter/blur);
                           PageViewer — PDF.js canvas or <img> under an SVG overlay
                           in canonical page units, one pointer model: tap, nearest-
                           vertex drag, touch/Select pan, pinch and Ctrl-wheel zoom
                           anchored through lib/quant.js → zoomAboutPoint (ADR-53);
                           QuantDialog — the accessible dialog shell shared by the
                           calibration / details / void dialogs (ADR-53);
                           TakeoffSummary — the read-only project-summary view
                           (Measure / Project summary toggle) over
                           lib/quantSummary.js, with Open → the workspace's own
                           selection (ADR-53, 1C-B);
                           MeasurementOverlay; MeasurementList (+ BOQ-item
                           column, ADR-52); CalibrationModal;
                           MeasurementEditorModal (+ optional BOQ-item link
                           picker, ADR-52); MeasurementVoidModal;
                           pdfjsLoader — the only pdfjs-dist import, lazy;
                           styles.js — page-local), ProjectBudget, ProjectCostCodes,
                           ProjectPurchaseOrders, ProjectProgressClaims,
                           ProjectInvoices (supplier/AP), ProjectClientInvoices (client/AR),
                           ProjectClientReceipts (cash received),
                           ProjectSupplierPayments (cash paid),
                           ProjectCashFlow (actual + forecast cash),
                           project/cashFlow/ (CashFlowChart, CombinedMonthlyTable,
                           LineEditorModal, LineVoidModal — page-local),
                           ProjectVariations, ProjectForecast,
                           ProjectBoq (Bill of Quantities),
                           project/boq/ (BoqItemEditorModal, BoqItemVoidModal —
                           page-local),
                           ProjectCommercial (margin),
                           ProjectTimeline (project programme),
                           project/timeline/ (TimelineGantt, ActivityTable,
                           ActivityCards, ActivityEditorModal,
                           ActivityCancelModal, ActivityQuickActions —
                           page-local),
                           ProjectDrawings (register), ProjectDrawingDetail (route),
                           ProjectGeneralDocuments,
                           project/documents/ (DrawingViewer, RevisionUploadModal,
                           RevisionHistoryTable, RevisionWithdrawModal,
                           DrawingEditorModal, DocumentUploadModal,
                           DocumentWithdrawModal, styles.js — page-local),
                           ProjectPlaceholder
    hooks/                 All Firestore access (see below); projectCurrencyLock.js
                           stages the project currency ratchet inside a caller's
                           transaction so monetary writes and the lock are atomic
    lib/                   firebase.js, formatters.js, currency.js, nav.js, projectTabs.js,
                           purchaseOrders.js, progressClaims.js, supplierInvoices.js,
                           supplierCreditNotes.js (reduction records against posted
                           supplier invoices), clientInvoices.js,
                           payments.js (shared, direction-agnostic),
                           clientReceipts.js, supplierPayments.js, cashFlow.js
                           (pure monthly cash aggregation), cashFlowChart.js
                           (chart presentation transform — no arithmetic),
                           variations.js, forecast.js, margin.js,
                           projectSnapshot.js (Dashboard snapshot — COMPOSES
                           projectForecastTotals / computeMargin / payablesSummary,
                           plus per-figure availability and SVG bar geometry
                           (compositionLayout / performanceLayout); no formula of
                           its own), dashboardProgramme.js (Dashboard programme
                           panel — timelineSummary + status tally + donut geometry
                           + nextMilestone; NON-financial, no completion %),
                           contacts.js,
                           boq.js (pure BOQ arithmetic + read-time budget comparison),
                           boqActions.js (Quant™ 1B, ADR-52 — the two
                           version-guarded BOQ transactions: the manual edit
                           and the Quant apply; injected SDK, no Firebase import),
                           quantBoq.js (Quant™ 1B, ADR-52 — pure unit alias
                           table with factor 1 only, link state, the per-item
                           aggregate of eligible linked measurements summed
                           unrounded and rounded once, blockers, readiness,
                           preview through boqLineAmount, latest-application state),
                           quant.js (Quant™ 1A — pure geometry: distances,
                           polyline length, shoelace area, counts; metric
                           calibration; quantity derivation from points ×
                           calibration; calibration-review state; validation;
                           display-only render bounds; NO financial arithmetic;
                           ADR-51; since ADR-53 polygon simplicity — segment
                           intersection, ring normalisation, `polygonProblem` —
                           the INVALID quantity reasons, the edit helpers
                           (nearest vertex / segment, insert, remove), the
                           zoom-aware hit test, and the wheel / pinch /
                           zoom-about-point arithmetic), quantDraft.js (ADR-53 —
                           the remembered in-progress draft: sessionStorage
                           injected, per project and per sheet, validated
                           against the live sheet before restore; no Firestore),
                           quantSummary.js (ADR-53, 1C-B — pure classification
                           of every measurement into current & valid /
                           attention / historical / void, per-kind totals that
                           never mix, grouping by cost code and by drawing →
                           revision → page, readiness, navigation targets;
                           calls the existing derivations only),
                           quantActions.js (the five revision-guarded
                           takeoff transactions — injected SDK, no Firebase
                           import), pdfRender.js (PDF.js adapter — the scale-1
                           viewport IS the canonical page space; bounded render;
                           the module is handed the loaded library, so the Node
                           suite uses the legacy build against a fixture),
                           shield.js (SHIELD™ foundation — five read-only
                           commercial assurance checks COMPOSING
                           normaliseInvoiceRef / invoiceTotals /
                           postedInvoicedByPoLine / postedInvoicedByPo / status
                           constants / the payables exception selectors through
                           figureState; no formula of its own; ADR-50),
                           projectTimeline.js (programme domain logic — NON-financial),
                           activityQuickActions.js (guarded quick status write —
                           injected SDK, no Firebase import; ADR-46),
                           timelineGantt.js (Gantt geometry — no arithmetic),
                           files.js (file types, size ceilings, deterministic
                           Storage paths), drawings.js, projectDocuments.js
docs/                      This documentation + design-reference assets
                           (Constrapp_v5.jsx prototype, screenshots, Word doc — do not move)
AGENT.md / CLAUDE.md / README.md / PRODUCT.md / ROADMAP.md   (canonical root docs)
```

Known stray file: `frontend/src/index 2.css` is a tracked duplicate of an older
`index.css` and is unused — cleanup candidate, kept for now to avoid unrelated churn.

## Provider / Context Hierarchy

`App.jsx` nests providers in dependency order; each derives from the one above:

```
AuthProvider          Firebase Auth user (onAuthStateChanged)
└─ ProfileProvider    users/{uid} Firestore doc → profile { name, role, companyId, … }
   └─ CompanyProvider companies/{profile.companyId} doc → company
      └─ ProjectsProvider   companies/{companyId}/projects (live query, createProject)
         └─ BrowserRouter → Routes
```

Per-page hooks (not context providers): `useProject(projectId)` (lookup within
ProjectsProvider), `useCostCodes()`, `useContacts()`, `useBudgetLines(projectId)`,
`usePurchaseOrders(projectId)`, `useProgressClaims(projectId)`,
`useSupplierInvoices(projectId)`, `useSupplierCreditNotes(projectId)`,
`useClientInvoices(projectId)`,
`useClientReceipts(projectId)`, `useSupplierPayments(projectId)`,
`useVariations(projectId)`, `useForecastLines(projectId)`,
`useProjectCommercial(projectId)`, `useProjectActivities(projectId)`, `usePulseAcknowledgements(projectId)`,
`useTakeoffPages(projectId)` and `useTakeoffMeasurements(projectId)` (both in `hooks/useTakeoff.jsx`,
Quant™ 1A — two keyed subscriptions plus the five revision-guarded takeoff writes; since ADR-52 a
measurement save may carry the optional `boqItemId` link). `useBoqItems(projectId)` exposes
`createBoqItem`, the version-guarded `updateBoqItem`, `voidBoqItem` and the Quant 1B
`applyBoqQuantity` (ADR-52; the last two writes live in `lib/boqActions.js`). The BOQ page mounts
the two takeoff hooks and `useDrawings` read-only; the Quant workspace mounts `useBoqItems` read-only.

## Routing Structure

```
/login, /create-account, /forgot-password    AuthLayout (redirects to / when signed in)

ProtectedRoute (redirects to /login when signed out)
└─ AppShell (Sidebar + TopBar)
   ├─ /                        Dashboard
   ├─ /projects                Projects list
   ├─ /projects/:projectId     ProjectDetailLayout (tab bar; index → overview)
   │    overview | pulse | shield | quant | boq | tenders | budget | cost-codes | purchase-orders | progress-claims | invoices | variations | forecasting | commercial  (live)
   │      (the `pulse` route renders PULSE™ 1A (ADR-47): six deterministic, read-only
   │       project health indicators from lib/pulse.js — financial roles only; the
   │       workspace mounts the ten Dashboard-snapshot hooks plus useProjectActivities
   │       for THIS project; no score. Since PULSE™ 1B (ADR-49) it also mounts
   │       usePulseAcknowledgements — NOT a PULSE source — and derives a needs-attention /
   │       acknowledged status beside each finding from lib/pulseAttention.js; the only
   │       PULSE writes are the two revision-guarded acknowledge / withdraw transactions)
   │      (the `shield` route renders the SHIELD™ foundation (ADR-50): five deterministic,
   │       read-only commercial assurance checks from lib/shield.js — financial roles only;
   │       the workspace mounts seven existing hooks (POs, claims, supplier invoices,
   │       credit notes, payments, retention releases, variations) for THIS project;
   │       no write path, no persistence, no score)
   │      (the `quant` route renders Quant™ 1A (ADR-51): MANUAL drawing measurement —
   │       pick a drawing revision and page from the existing Documents register, render it
   │       (PDF via lazily loaded PDF.js, PNG/JPEG via <img>), calibrate from one known
   │       metric distance, measure lengths / areas / counts, and persist them to
   │       takeoffPages / takeoffMeasurements through revision-guarded transactions;
   │       company_admin / project_manager / qs; a measurement may LINK to one active BOQ
   │       item on the same cost code (ADR-52) but the tab writes NO BOQ quantity)
   │      (the `forecasting` route renders the Forecast Cost to Complete page; the tab is labelled "Forecast".
   │       the `invoices` route renders SUPPLIER invoices (AP); the tab is labelled "Supplier Invoices".
   │       the `commercial` route is a nested layout — index = Project Margin,
   │       `commercial/client-invoices` = Client Invoices / Accounts Receivable (AR),
   │       `commercial/receipts` = Client Receipts (cash received; the sub-nav
   │        LABEL reads "Client Receipts" while the route stays `receipts`),
   │       `commercial/supplier-payments` = Supplier Payments (cash paid),
   │       `commercial/cash-flow` = Cash Flow (ACTUAL recorded cash movement —
   │        read-only; forecast and charts are later branches),
   │       `commercial/retention` = Supplier Retention register + Retention
   │        Release (ADR-30);
   │       the `tenders` route renders the Tender register — packages, bids,
   │        Tender Comparison, and the award decision record; financial roles only)
   │    boq                  Bill of Quantities (ProjectBoq — measured items,
   │                          derived amounts, read-time BOQ-vs-budget comparison;
   │                          since ADR-52 an active item with linked Quant
   │                          measurements offers "Quant (n)" → BoqQuantityApplyModal:
   │                          review the linked measurements, blockers and eligible
   │                          total, then EXPLICITLY apply it to that one item's
   │                          quantity through a version-guarded write;
   │                          tab label stays "BOQ"; the Tenders tab follows it)
   │    timeline  (live — the project PROGRAMME: activities, milestones,
   │      responsibility, manually entered progress, read-only Gantt,
   │      Due filter (overdue / due within 14 days), guarded quick status
   │      actions (ADR-46). Read: company_admin/project_manager/qs; write:
   │      company_admin/project_manager only. Writes no financial document.)
   │    documents  (live)
   │      (the `documents` route is a nested layout — index = the Drawings register,
   │       `documents/drawings/:drawingId` = the drawing detail ROUTE (not a modal:
   │        a drawing is linked to, shared and bookmarked),
   │       `documents/general` = the General Documents register)
   │    photos | reports  (ProjectPlaceholder — routes LIVE, tabs HIDDEN:
   │      the entries are absent from lib/projectTabs.js for private beta, so
   │      the URL still renders but nothing offers it)
   ├─ /settings/company        Company country & base currency (company_admin writes)
   ├─ /contacts                Company-wide contact directory
   ├─ /subcontractors          Filtered contacts view
   ├─ /pulse                   PULSE™ pointer — route LIVE, sidebar entry HIDDEN; explains
   │                            that indicators live on each project's PULSE tab and links
   │                            to /projects (ADR-47). No portfolio health view exists
   ├─ /shield                  SHIELD™ pointer — route LIVE, sidebar entry HIDDEN; explains
   │                            that the checks live on each project's SHIELD tab and links
   │                            to /projects (ADR-50). No portfolio assurance view exists
   ├─ /quant                   Quant™ pointer — route LIVE, sidebar entry HIDDEN; explains
   │                            that measuring lives on each project's Quant tab and links
   │                            to /projects (ADR-51). No portfolio takeoff view exists
   │                            (all three pointers absent from lib/nav.js for private beta)
   └─ *                        → /projects
```

## Data Hierarchy: Company → Projects → Project Detail

Everything except `users/` is scoped under `companies/{companyId}` for
multi-tenancy. The signed-in user's profile (`users/{uid}`) carries `companyId`,
which selects the company; projects nest under the company; budget lines,
purchase orders, and progress claims nest under each project. Cost codes,
contacts, and counters are **company-wide** (shared across projects). Full
field detail: [DATA_MODEL.md](DATA_MODEL.md).

## Implemented vs Placeholder Modules

| Module | Status |
|---|---|
| Auth (sign-in, password reset), protected routing | Implemented — reset does not enumerate accounts; **signup remains a stub** (membership is provisioned out of band, ADR-27) |
| Company/user context | Implemented |
| Projects (create, list) + Project Detail shell | Implemented (no general edit/delete; currency editable until locked) |
| Company Country & Currency | Implemented (foundation) — company country/base currency, project currency inheritance + ratchet lock, one shared formatter; no FX, tax stays Australian GST |
| Cost Codes (create, list) | Implemented |
| Budget Lines + financial rollups | Implemented |
| Purchase Orders | Implemented |
| Progress Claims | Implemented |
| Supplier Invoices (accounts payable) | Implemented (foundation) |
| Client Invoices / Accounts Receivable | Implemented (foundation) — read-time contract control and read-time reconciliation against receipts; **no tax-invoice output** |
| Client Receipts (cash received) | Implemented (foundation) — embedded allocations, read-time balances |
| Supplier Payments (cash paid) | Implemented (foundation) — embedded allocations against each posted invoice's **derived payable basis** (stored `payableTotal` + posted retention released), read-time Paid to Date / Remaining Payable / AP ageing |
| Supplier Credit Notes | Implemented (foundation) — reduction records against exactly one posted, retention-free supplier invoice; rules-enforced lifecycle **with target-invoice `get()` checks**; read-time subtraction from Invoiced/Actual/Remaining Payable; lives inside the Supplier Invoices view; **no client credit notes, no refunds** |
| Supplier Retention & Retention Release | Implemented (foundation) — read-time register grouped by supplier; retention **held** derived from posted invoices, **released** from posted `retentionReleases`; partial releases with cumulative-snapshot GST; **no client retention, no retention due/DLP dates, no retention-paid attribution** (ADR-30) |
| Cash Flow (actual + forecast) | Implemented (foundation) — read-time monthly actual, automatic invoice due-date forecast, manual `cashFlowLines` timing, projected cumulative/closing position, completeness, untimed reporting, peak funding with suppression, and a two-panel chart that consumes those derived rows without re-deriving them (ADR-26); **no date filtering, not a bank balance** |
| Variations (client + supplier) | Implemented (foundation) |
| Tenders (packages, bids, comparison, award) | Implemented (foundation) — cost-code + free-text scope (BOQ-independent), manual bids, read-time comparison, award as a decision record; **no stored totals, no PO creation, closing date informational** |
| Forecast Cost to Complete | Implemented (foundation) — read-time, cost-side |
| Project Margin (Commercial tab) | Implemented (foundation) — read-time, ex-GST; commercial baseline is the only stored input |
| Dashboard | **Premium Dashboard v2 (ADR-45)** over Analytics v1 (ADR-42) — portfolio counts and status breakdown (null until the projects read settles — never a false 0) and the register (table from `lg:`, cards below) from the existing projects subscription (no new listener, no money); plus a financial-role-only **Project Snapshot** for one selected project (`?project=<id>`): four headline KPIs, the remaining established figures, and a plain-SVG **Budget, cost & revenue** chart. The snapshot child mounts ten existing project-scoped hooks and renders `lib/projectSnapshot.js`, which only composes `projectForecastTotals` / `computeMargin` / `payablesSummary`. Beside the chart, a programme-role-only **Programme** panel mounts the one added subscription (`useProjectActivities`, selected project only) and renders `timelineSummary` counts — no completion %. No portfolio money, no rules change |
| Contacts | Implemented (foundation) — company-wide directory; supplier picker on POs |
| Subcontractors | Implemented — filtered contacts view (the IQ™ "Coming Soon" card was removed for private beta) |
| Documents & Drawings | Implemented (foundation) — drawing masters + **immutable** revisions with a transactional current-revision pointer, revision history, current/superseded/withdrawn lifecycle, explicit succession on withdrawal, and a flat general-document register with project/internal visibility. Bytes in Cloud Storage, metadata in Firestore, **uploads Storage-first**; **no photos, DWG, markup, OCR, AI or takeoff** |
| Constrapp PULSE™ | **Implemented and live in production (1A ADR-47; 1B ADR-49, released 19 October 2026)** — a project tab of six deterministic, explainable indicators (forecast over budget · cost codes not forecast · negative forecast gross profit · overdue programme activities · past-due supplier invoices · pending variation exposure), each in one of five states (loading / unavailable / needs data / finding / no issue), composed in `lib/pulse.js` from `projectForecastRows` / `computeMargin` / `payablesSummary` / `isOverdue` through the ADR-42 `figureState` vocabulary; evidence rows and tab-level links; **no score, threshold, trend, prediction or Dashboard surface**. **PULSE™ 1B (ADR-49)** adds the one PULSE write path: an acknowledgement per indicator (`…/pulseAcknowledgements/{indicatorId}`, new rules block) with a note and a required review-by date, withdrawable, derived *needs attention / acknowledged / no longer present / unknown* status beside each finding (`lib/pulseAttention.js`) — never a resolution, never a change to an indicator. The top-level `/pulse` route is a hidden pointer to the tab |
| Constrapp SHIELD™ | **Implemented and live in production (foundation, ADR-50, released 19 October 2026).** Commercial assurance, never HSEQ. A project tab of five deterministic, read-only checks (potential duplicate supplier invoices · supplier invoice integrity · purchase order over-invoicing exposure · commitment records requiring reconciliation · existing financial exceptions), each in one of five states (loading / unavailable / needs data / finding / no issue), composed in `lib/shield.js` from existing selectors and status constants through the ADR-42 `figureState` vocabulary over declared dependencies; evidence rows with source ids and tab-level links; **no write path, persistence, score, severity, trend, prediction or Dashboard surface**. The top-level `/shield` route is a hidden pointer to the tab |
| Constrapp Quant™ | **Quant 1A and 1B live in production (ADR-51, ADR-52 — October 2026); Quant 1C (1C-A + 1C-B) implemented (ADR-53) — NOT YET DEPLOYED.** Manual drawing measurement: a project tab that renders one page of an existing drawing revision (PDF through the pinned, lazily loaded `pdfjs-dist`; PNG/JPEG through `<img>`), calibrates it from one known metric distance, measures lengths, areas and counts as canonical page-space geometry, and persists each as a traceable record (`takeoffPages`, `takeoffMeasurements` — two new rules blocks) with a required cost code and a calibration snapshot; quantities are **derived at read time, never stored**; re-calibration flags dependent measurements for review; superseded revisions stay inspectable with a warning; every write is a revision-guarded transaction. **The tab writes no BOQ quantity and no financial figure; no AI.** **Quant 1B (ADR-52):** a measurement may carry an optional `boqItemId` link to one ACTIVE BOQ item on the SAME cost code (rules `get()` the target; unit compatibility — length `m`/`lm`, area `m2`/`m²`/`sqm`, count `no`/`nr`/`each`, factor 1 only — is client-side); the BOQ tab's *Quant (n)* dialog derives the eligible total from the existing subscriptions (current revision, reviewed, calibrated, compatible — any blocked measurement blocks the apply), previews existing → proposed quantity and amount through `boqLineAmount`, and on one explicit confirmation writes that item's `quantity`, derived `amount` and a `quantApplied` record through a version-guarded transaction (`lib/boqActions.js`) that also now guards the manual editor (released rules-first, then Hosting). **Quant 1C-A (ADR-53):** a crossed or collapsed area outline is refused at save and derives as INVALID (with a reason) when stored — never summed, blocks the apply; drafts and geometry edits are remembered per project in sessionStorage and restored on the same sheet, with one confirmation before a sheet or tool change discards them and the browser's prompt before unload; geometry editing gains insert / remove / count markers / undo; Select hit-tests shapes on the sheet; Ctrl/⌘-wheel, pinch and toolbar zoom are anchored, drag-to-pan with Select; 44 px vertex targets; the three Quant dialogs share `QuantDialog`. **Quant 1C-B:** a *Project summary* view on the same tab (`lib/quantSummary.js` over the existing subscriptions — no new listener): per-kind totals of current, valid measurements, historical sheets totalled apart, one attention list, grouping by cost code and drawing → revision → page, loading / unavailable said out loud; *Open* validates the target and moves the workspace's own selection to the exact sheet with the measurement highlighted; the BOQ apply dialog's *Open in Quant* hands over through the remembered selection's optional `measurementId`; measured dates from the stored timestamp only; drafts remembered per sheet. **No schema, rules, BOQ-write or selector change — Hosting-only release; not production-verified.** `/quant` is a hidden pointer |
| BOQ (Bill of Quantities) | Implemented (foundation) — measured items with optional rates, rules-enforced derived amounts, read-time budget comparison; **feeds no financial figure**; since ADR-52 the edit is version-guarded and an item can receive a reviewed Quant total explicitly (`quantApplied` records the latest application); Estimating and BOQ → Budget transfer are later branches |
| Project Timeline (programme) | Implemented (foundation) — activities + milestones, date-only planned/actual dates, manual progress, read-time overdue/horizon derivation, Due filter (overdue / due within 14 days), guarded quick status actions and a midnight-advancing clock (ADR-46), read-only CSS/SVG Gantt (no new dependency), cancel-not-delete; **`qs` is read-only**, subcontractor/client denied; **no baseline, no dependencies, no financial effect** |
| Photos, Reports tabs | Placeholder (`ProjectPlaceholder`) — routes and pages live, **hidden from the project tab bar** for private beta (`lib/projectTabs.js`) |

## Hooks-Only Firestore Access

Every Firestore read/write goes through a hook in `frontend/src/hooks/`
(auth state included, via `useAuth`). Pages never import `firebase/*` directly —
the only exceptions today are the Login page calling `signInWithEmailAndPassword`
and the hooks themselves. Reads are live `onSnapshot` subscriptions; writes are
`addDoc`/`updateDoc`/`runTransaction` inside hook callbacks. Pure domain logic
(status machines, totals, derivations) lives in `lib/purchaseOrders.js`,
`lib/progressClaims.js`, `lib/supplierInvoices.js`, `lib/variations.js`, and
`lib/forecast.js` so it is testable and shared between create/assess/invoice/
forecast flows. `lib/forecast.js` **composes** the other modules' read-time
helpers rather than duplicating them.

The cash modules follow the same shape: `lib/payments.js` holds only the
**direction-agnostic** primitives (lifecycle, payment methods, allocation
arithmetic, the whole-cent invariant, reconciliation states, remaining balances,
generic ageing, shared validators), with `lib/clientReceipts.js` as the money-in
adapter and `lib/supplierPayments.js` as the money-out adapter. Supplier Payments
reuse `lib/payments.js` **entirely unchanged**. `lib/cashFlow.js` sits on top as
a pure consumer: it aggregates the adapters' cash rows (`cashInRows()` /
`cashOutRows()`), the invoice reconciliation rows, and the authored
`cashFlowLines` into monthly actual + forecast rows, a cumulative-from-zero
position, source coverage, completeness, and the peak-funding trough. It holds
no document shapes of its own beyond the timing-line vocabulary and is covered
by the unit suite (`npm run test:unit`).

**Cloud Storage follows the same discipline.** `hooks/useStorageUpload.jsx` is
the only place the app writes file bytes or mints a download URL; pages never
import `firebase/storage`. `lib/files.js` holds the pure half — allowed types,
size ceilings, and the **deterministic storage paths** that Firestore Rules and
Storage Rules each independently recompute — with `lib/drawings.js` and
`lib/projectDocuments.js` holding the register vocabulary, lifecycle legality,
validation and filtering. `hooks/useDrawings.jsx` owns drawing masters,
`hooks/useDrawingRevisions.jsx` owns every write that moves a current-revision
pointer (because each is one transaction spanning master and revisions), and
`hooks/useProjectDocuments.jsx` owns the flat document register.
