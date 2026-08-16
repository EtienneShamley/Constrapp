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
| **Preconstruction** | Measure quantities, build the BOQ, estimate, transfer to an approved budget | Drawings/Takeoff, BOQ & Estimating *(planned)*; **Cost Codes**, **Budgets** *(implemented)* |
| **Procurement** | Tender packages, subcontractor invitations, bid levelling, award, commitment | Tender & Award *(future)* → **Purchase Orders** *(implemented)* |
| **Delivery** | Scope variations, cumulative progress claims against commitments | **Variations** *(implemented — foundation)*; **Progress Claims** *(implemented)* |
| **Cost Control** | Supplier invoices, actual cost, payments/credit notes | **Supplier Invoices**, **Supplier Payments** *(implemented)*; Credit Notes, Retention Release *(future)* |
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
| Charts | Recharts 3 | Dashboard only |
| Backend | Firebase JS SDK 12 — Auth, Firestore, Storage | **Client SDK only** |
| Lint | ESLint 10 (flat config) | `npm run lint` |
| Rules tests | Vitest 4 + `@firebase/rules-unit-testing` + `firebase-tools` 13 (emulator) | `npm run test:rules` — **dev-only**. Requires JDK 17 |
| Unit tests | Vitest 4 (Node, no emulator) | `npm run test:unit` — pure `lib/` domain logic (`tests/unit/`); separate config (`vitest.config.js`) |

## Client-SDK-Only Backend

There is **no backend code**: no Cloud Functions, no server, no `functions/`
directory, and no `.firebaserc`. (`frontend/firebase.json` exists, but declares
only the Firestore emulator and the rules-file path for the automated Security
Rules suite — no hosting and no functions target, and with no `.firebaserc` there
is no project to deploy to.) The browser talks directly to
Firebase Auth and Firestore; Storage is initialised in `lib/firebase.js` but not
yet used by any feature. All business rules run client-side, backed only by
Firestore security rules (see [SECURITY.md](SECURITY.md) for what that does and
does not enforce). Cloud Functions and server-side enforcement are deliberate
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
  firestore.rules          Security rules — published manually (see DEPLOYMENT.md)
  firebase.json            Firestore EMULATOR + rules path only (no hosting/functions,
                           no .firebaserc) — backs `npm run test:rules`
  vitest.rules.config.js   Vitest config for the rules suite (Node, no app plugins)
  vitest.config.js         Vitest config for the UNIT suite (tests/unit/ only)
  tests/rules/             Firestore Security Rules tests (emulator)
  tests/unit/              Unit tests for pure lib/ domain logic (no emulator)
  .env.example             Vite env vars (Firebase web config)
  src/
    main.jsx               Entry — StrictMode + App
    App.jsx                Providers + all routes
    index.css              Tailwind import + @theme tokens + base styles
    components/            Card, Btn, Badge, Stat, ProgBar, PageHeader, ProtectedRoute
    layouts/               AppShell, Sidebar, TopBar, AuthLayout, ProjectDetailLayout,
                           ProjectCommercialLayout (Commercial sub-nav:
                           Margin | Client Invoices | Client Receipts |
                           Supplier Payments | Cash Flow)
    pages/                 Login, CreateAccount, ForgotPassword, Dashboard, Projects,
                           CompanySettings (country & base currency),
                           Contacts (company directory), Subcontractors (filtered
                           contacts view + IQ™ placeholder), Pulse, Shield
    pages/project/         ProjectOverview, ProjectBudget, ProjectCostCodes,
                           ProjectPurchaseOrders, ProjectProgressClaims,
                           ProjectInvoices (supplier/AP), ProjectClientInvoices (client/AR),
                           ProjectClientReceipts (cash received),
                           ProjectSupplierPayments (cash paid),
                           ProjectCashFlow (actual + forecast cash),
                           project/cashFlow/ (CashFlowChart, CombinedMonthlyTable,
                           LineEditorModal, LineVoidModal — page-local),
                           ProjectVariations, ProjectForecast,
                           ProjectCommercial (margin), ProjectPlaceholder
    hooks/                 All Firestore access (see below); projectCurrencyLock.js
                           stages the project currency ratchet inside a caller's
                           transaction so monetary writes and the lock are atomic
    lib/                   firebase.js, formatters.js, currency.js, nav.js, projectTabs.js,
                           purchaseOrders.js, progressClaims.js, supplierInvoices.js,
                           clientInvoices.js, payments.js (shared, direction-agnostic),
                           clientReceipts.js, supplierPayments.js, cashFlow.js
                           (pure monthly cash aggregation), cashFlowChart.js
                           (chart presentation transform — no arithmetic),
                           variations.js, forecast.js, margin.js, contacts.js
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
`useSupplierInvoices(projectId)`, `useClientInvoices(projectId)`,
`useClientReceipts(projectId)`, `useSupplierPayments(projectId)`,
`useVariations(projectId)`, `useForecastLines(projectId)`,
`useProjectCommercial(projectId)`.

## Routing Structure

```
/login, /create-account, /forgot-password    AuthLayout (redirects to / when signed in)

ProtectedRoute (redirects to /login when signed out)
└─ AppShell (Sidebar + TopBar)
   ├─ /                        Dashboard
   ├─ /projects                Projects list
   ├─ /projects/:projectId     ProjectDetailLayout (tab bar; index → overview)
   │    overview | tenders | budget | cost-codes | purchase-orders | progress-claims | invoices | variations | forecasting | commercial  (live)
   │      (the `forecasting` route renders the Forecast Cost to Complete page; the tab is labelled "Forecast".
   │       the `invoices` route renders SUPPLIER invoices (AP); the tab is labelled "Supplier Invoices".
   │       the `commercial` route is a nested layout — index = Project Margin,
   │       `commercial/client-invoices` = Client Invoices / Accounts Receivable (AR),
   │       `commercial/receipts` = Client Receipts (cash received; the sub-nav
   │        LABEL reads "Client Receipts" while the route stays `receipts`),
   │       `commercial/supplier-payments` = Supplier Payments (cash paid),
   │       `commercial/cash-flow` = Cash Flow (ACTUAL recorded cash movement —
   │        read-only; forecast and charts are later branches).
   │       the `tenders` route renders the Tender register — packages, bids,
   │        Tender Comparison, and the award decision record; financial roles only)
   │    boq | documents | photos | timeline | reports  (ProjectPlaceholder)
   ├─ /settings/company        Company country & base currency (company_admin writes)
   ├─ /contacts                Company-wide contact directory
   ├─ /subcontractors          Filtered contacts view (+ IQ™ placeholder card)
   ├─ /pulse                   Placeholder (PULSE™)
   ├─ /shield                  Placeholder (SHIELD™)
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
| Auth (sign-in), protected routing | Implemented (signup/reset screens are stubs) |
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
| Supplier Payments (cash paid) | Implemented (foundation) — embedded allocations against posted invoices' `payableTotal`, read-time Paid to Date / Remaining Payable / AP ageing; **no retention release** |
| Cash Flow (actual + forecast) | Implemented (foundation) — read-time monthly actual, automatic invoice due-date forecast, manual `cashFlowLines` timing, projected cumulative/closing position, completeness, untimed reporting, peak funding with suppression, and a two-panel chart that consumes those derived rows without re-deriving them (ADR-26); **no date filtering, not a bank balance** |
| Variations (client + supplier) | Implemented (foundation) |
| Tenders (packages, bids, comparison, award) | Implemented (foundation) — cost-code + free-text scope (BOQ-independent), manual bids, read-time comparison, award as a decision record; **no stored totals, no PO creation, closing date informational** |
| Forecast Cost to Complete | Implemented (foundation) — read-time, cost-side |
| Project Margin (Commercial tab) | Implemented (foundation) — read-time, ex-GST; commercial baseline is the only stored input |
| Dashboard | Partial — live project list; static KPI/chart data |
| Contacts | Implemented (foundation) — company-wide directory; supplier picker on POs |
| Subcontractors | Partial — filtered contacts view; IQ™ scoring is a placeholder |
| PULSE™, SHIELD™ | Placeholder screens |
| BOQ, Documents, Photos, Timeline, Reports tabs | Placeholder (`ProjectPlaceholder`) |

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
