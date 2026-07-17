# Constrapp

Australian-built construction project management platform.

Web-first · React 19 + Vite + Tailwind CSS v4 · Firebase (client SDK)

## What Works Today

- Email/password sign-in (account creation and password reset screens are stubs — users are provisioned manually)
- Multi-tenant company/user foundation (`users/{uid}` → `companies/{companyId}`)
- Projects: create and list, with a Project Detail area (Overview, Budget, Cost Codes, Purchase Orders, Progress Claims tabs live; other tabs are placeholders)
- Company-wide Cost Codes
- Budget Lines per project, with Committed / Claimed / Actual derived live from POs and claims
- Purchase Orders: draft → sent → closed/cancelled lifecycle with transactional numbering
- Progress Claims: cumulative claiming against sent POs, assessment, and partial approval

Dashboard KPIs and charts are partly placeholder data. Contacts, Subcontractors,
PULSE™, and SHIELD™ are placeholder screens. See [PRODUCT.md](PRODUCT.md) for
module-by-module status.

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
