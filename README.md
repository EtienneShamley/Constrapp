# Constrapp

**Constrapp is the connected commercial operating system for construction projects.**

Australian-built and web-first, it gives builders, contractors, and quantity surveyors one connected commercial dataset — from preconstruction to final account — instead of disconnected spreadsheets and tools.

Web-first · React 19 + Vite + Tailwind CSS v4 · Firebase (client SDK)

## The Commercial Lifecycle

One connected dataset flows through every stage, with **Cost Codes as the spine** joining them:

```
Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved Budget
  → Commitment → Purchase Order → Variation → Progress Claim
  → Supplier Invoice → Actual Cost → Forecast → Cash Flow
  → Final Project Margin → Final Account
```

Today the delivery-and-cost-control middle of this lifecycle is implemented (budgets → POs → claims → supplier invoices); the preconstruction front (BOQ, tender, takeoff), variations, and forecasting are planned. See [PRODUCT.md](PRODUCT.md) and [ROADMAP.md](ROADMAP.md) for module-by-module status, and [PRODUCT.md](PRODUCT.md) → "What Constrapp Is Not" for the strategic boundaries.

## What Works Today

- Email/password sign-in (account creation and password reset screens are stubs — users are provisioned manually)
- Multi-tenant company/user foundation (`users/{uid}` → `companies/{companyId}`)
- Projects: create and list, with a Project Detail area (Overview, Budget, Cost Codes, Purchase Orders, Progress Claims, Supplier Invoices, Variations, Forecast, and Commercial tabs live; other tabs are placeholders)
- Company-wide Cost Codes
- Company-wide Contacts: suppliers, subcontractors, consultants, and clients with ABN validation, contact people, duplicate warnings, and archive/reactivate (reads restricted to internal financial roles)
- Budget Lines per project, with Committed / Claimed / Actual derived live from POs and claims
- Purchase Orders: draft → sent → closed/cancelled lifecycle with transactional numbering; supplier picked from Contacts (older POs keep their free-text supplier)
- Progress Claims: cumulative claiming against sent POs, assessment, and partial approval
- Supplier Invoices (Actual Cost): accounts-payable bills against a sent/closed PO or from one approved claim; `draft → approved → posted` (posted is immutable); reads restricted to internal financial roles
- Variations (foundation): client (`CV-####`) and supplier (`SV-####`) commercial change control, approved-only read-time, with Commitment Exposure shown separately from Committed; reads restricted to financial roles
- Forecast Cost to Complete (foundation): one manual Uncommitted Cost to Complete input per cost code, every other figure derived at read time; reads restricted to financial roles
- Project Margin (foundation): a per-project Commercial Baseline (Original Contract Value + Original Approved Budget + contract dates + client) drives read-time Current Contract Sum, Forecast Revenue, Forecast Gross Profit, Forecast Margin %, and Margin Movement (all ex-GST) on a new Commercial tab; reads restricted to financial roles

Dashboard KPIs and charts are partly placeholder data. PULSE™ and SHIELD™ are
placeholder screens; Subcontractors lists live contacts but its IQ™ scoring is
a placeholder. See [PRODUCT.md](PRODUCT.md) for module-by-module status.

## Local Setup

All commands run from `frontend/`.

### Prerequisites

- Node.js 20+
- A Firebase project (see below)

### Install & Run

```bash
cd frontend
npm install
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev
```

### Build

```bash
cd frontend
npm run build
```

## Firebase Setup

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication** (Email/Password provider)
3. Enable **Firestore** (production mode)
4. Copy the web app config values into `frontend/.env.local`
5. Publish the Firestore rules **manually**: paste the contents of
   `frontend/firestore.rules` into Firebase console → Firestore → Rules → Publish

There is no `firebase.json` or `.firebaserc` yet — Firebase CLI configuration,
Hosting, and automated deployment are future work (see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Repository Layout

```
frontend/         The entire application (Vite root); firestore.rules lives here
docs/             Detailed documentation + design-reference assets
AGENT.md          Conventions and guardrails for contributors and AI agents
CLAUDE.md         Task routing for AI agents
PRODUCT.md        Product overview and module status
ROADMAP.md        Sprint plan and current status
```

## Documentation Index

| Document | Contents |
|---|---|
| [AGENT.md](AGENT.md) | Mandatory conventions, guardrails, architectural invariants |
| [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) | Binding engineering & security standards, checklists, control matrix |
| [CLAUDE.md](CLAUDE.md) | Task routing for AI agents |
| [PRODUCT.md](PRODUCT.md) | Vision, roles, modules with implementation status |
| [ROADMAP.md](ROADMAP.md) | Sprint plan — what's done, current, and next |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, repo layout, providers, routing, module status |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Full Firestore hierarchy, fields, relationships |
| [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md) | Budget/PO/claim lifecycles, definitions, formulas |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth/membership implementation, rules, deferred controls |
| [docs/TESTING.md](docs/TESTING.md) | Manual acceptance tests (no automated suite yet) |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Tokens, components, UI conventions, known debt |
| [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md) | Architectural decision records |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Env vars, build, manual rules publishing |

## Roles

`super_admin` · `company_admin` · `project_manager` · `qs` · `subcontractor` · `client`

Role is a field on the `users/{uid}` Firestore document. Firebase Auth custom
claims are **not** implemented. Current enforcement is described in
[docs/SECURITY.md](docs/SECURITY.md).
