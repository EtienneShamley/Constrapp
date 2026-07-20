# Architecture

Current, factual description of the implemented system. Product intent lives in
[PRODUCT.md](../PRODUCT.md); conventions in [AGENT.md](../AGENT.md).

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

## Client-SDK-Only Backend

There is **no backend code**: no Cloud Functions, no server, no `functions/`
directory, no `firebase.json` or `.firebaserc`. The browser talks directly to
Firebase Auth and Firestore; Storage is initialised in `lib/firebase.js` but not
yet used by any feature. All business rules run client-side, backed only by
Firestore security rules (see [SECURITY.md](SECURITY.md) for what that does and
does not enforce). Cloud Functions and server-side enforcement are deliberate
deferrals — see [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md).

## Repository Layout

```
frontend/                  The entire application (run all npm commands here)
  firestore.rules          Security rules — published manually (see DEPLOYMENT.md)
  .env.example             Vite env vars (Firebase web config)
  src/
    main.jsx               Entry — StrictMode + App
    App.jsx                Providers + all routes
    index.css              Tailwind import + @theme tokens + base styles
    components/            Card, Btn, Badge, Stat, ProgBar, PageHeader, ProtectedRoute
    layouts/               AppShell, Sidebar, TopBar, AuthLayout, ProjectDetailLayout
    pages/                 Login, CreateAccount, ForgotPassword, Dashboard, Projects,
                           Contacts (company directory), Subcontractors (filtered
                           contacts view + IQ™ placeholder), Pulse, Shield
    pages/project/         ProjectOverview, ProjectBudget, ProjectCostCodes,
                           ProjectPurchaseOrders, ProjectProgressClaims, ProjectPlaceholder
    hooks/                 All Firestore access (see below)
    lib/                   firebase.js, formatters.js, nav.js, projectTabs.js,
                           purchaseOrders.js, progressClaims.js, contacts.js
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
`usePurchaseOrders(projectId)`, `useProgressClaims(projectId)`.

## Routing Structure

```
/login, /create-account, /forgot-password    AuthLayout (redirects to / when signed in)

ProtectedRoute (redirects to /login when signed out)
└─ AppShell (Sidebar + TopBar)
   ├─ /                        Dashboard
   ├─ /projects                Projects list
   ├─ /projects/:projectId     ProjectDetailLayout (tab bar; index → overview)
   │    overview | budget | cost-codes | purchase-orders | progress-claims   (live)
   │    boq | forecasting | variations | documents | photos | timeline | reports  (ProjectPlaceholder)
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
| Projects (create, list) + Project Detail shell | Implemented (no edit/delete) |
| Cost Codes (create, list) | Implemented |
| Budget Lines + financial rollups | Implemented |
| Purchase Orders | Implemented |
| Progress Claims | Implemented |
| Dashboard | Partial — live project list; static KPI/chart data |
| Contacts | Implemented (foundation) — company-wide directory; supplier picker on POs |
| Subcontractors | Partial — filtered contacts view; IQ™ scoring is a placeholder |
| PULSE™, SHIELD™ | Placeholder screens |
| BOQ, Forecasting, Variations, Documents, Photos, Timeline, Reports tabs | Placeholder (`ProjectPlaceholder`) |

## Hooks-Only Firestore Access

Every Firestore read/write goes through a hook in `frontend/src/hooks/`
(auth state included, via `useAuth`). Pages never import `firebase/*` directly —
the only exceptions today are the Login page calling `signInWithEmailAndPassword`
and the hooks themselves. Reads are live `onSnapshot` subscriptions; writes are
`addDoc`/`updateDoc`/`runTransaction` inside hook callbacks. Pure domain logic
(status machines, totals, derivations) lives in `lib/purchaseOrders.js` and
`lib/progressClaims.js` so it is testable and shared between create/assess flows.
