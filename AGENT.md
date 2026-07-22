# Constrapp — Agent & Contributor Guide

This file governs how AI agents and contributors must approach work in this codebase.
It covers mandatory conventions, guardrails, workflow, and architectural invariants.
For detail, follow the links into `docs/`.

## Strategic Invariants (mandatory)

Constrapp is **the connected commercial operating system for construction projects**. These invariants are as binding as the financial ones below:

- **Cost Codes are the commercial spine.** Every commercial document references a cost code (`costCodeId` + a `costCodeName` snapshot). New commercial modules join through it — they must not invent a parallel key.
- **New commercial modules integrate with the existing lifecycle** (Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved Budget → Commitment → PO → Variation → Progress Claim → Supplier Invoice → Actual Cost → Forecast → Cash Flow → Final Project Margin → Final Account) rather than operate as standalone tools.
- **Field features must state their commercial input or output** (e.g. drawing measurement → BOQ quantity, site photo → progress/claim evidence, delay → forecast impact). A field feature with no commercial linkage is out of scope.
- **Do not build generic form-first or HSEQ-first functionality** (no-code form builders, HSEQ template libraries, generic field reporting, payroll/workforce, fleet/equipment, or broad enterprise integrations before product-market fit) **without an approved strategy change.** See [PRODUCT.md](PRODUCT.md) → "What Constrapp Is Not".
- **PULSE™, SHIELD™, IQ™, and Quant™ remain placeholders** until their planned sprint (see [ROADMAP.md](ROADMAP.md) and the AI Feature Placeholder Rule below).

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 8 (JavaScript, no TypeScript) |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` — tokens in `@theme` in `frontend/src/index.css`; there is **no** `tailwind.config.js` |
| Routing | React Router 7 (`react-router-dom`) |
| State | React Context + hooks (no Redux) |
| Charts | Recharts 3 |
| Backend | Firebase **client SDK only** (Auth, Firestore, Storage). No Cloud Functions, no server code, no `firebase.json`/`.firebaserc` yet |
| Font | Sora (Google Fonts), fallback DM Sans |

## Repository Structure

The app lives entirely under `frontend/`. Root holds documentation; `docs/` holds
detailed docs plus design-reference assets (prototype `.jsx`, screenshots, Word doc)
that must not be moved or renamed.

```
frontend/
  firestore.rules   Firestore security rules (published manually — see docs/DEPLOYMENT.md)
  src/
    components/     UI primitives: Card, Btn, Badge, Stat, ProgBar, PageHeader, ProtectedRoute
    layouts/        AppShell (Sidebar + TopBar), AuthLayout, ProjectDetailLayout
    pages/          Top-level routes; pages/project/ holds Project Detail tabs
    hooks/          useAuth, useProfile, useCompany, useProjects, useProject,
                    useCostCodes, useContacts, useBudgetLines, usePurchaseOrders,
                    useProgressClaims, useSupplierInvoices
    lib/            firebase.js, formatters.js, nav.js, projectTabs.js,
                    purchaseOrders.js, progressClaims.js, supplierInvoices.js,
                    contacts.js (pure domain logic)
```

## Design Tokens

Tokens are defined as CSS variables in the `@theme` block of `frontend/src/index.css`
(e.g. `--color-brand-bg` → the `bg-brand-bg` utility). Do not hardcode hex values in
components and do not create new colour values — use the existing tokens. The full
token list, component conventions, and the recorded existing violations (technical
debt, not licence to add more) are in [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

## Component Conventions

- Primitives live in `frontend/src/components/` — `Card`, `Btn`, `Badge`, `Stat`, `ProgBar`, `PageHeader`
- Pages compose primitives; keep business logic in hooks and `lib/`
- No new inline style objects — use Tailwind classes only (existing violations are logged in docs/DESIGN_SYSTEM.md)
- Responsive: mobile-first; the sidebar collapses to a drawer below the `md:` breakpoint
- Touch targets at least 44px; no hover-only interactions
- Test responsive behaviour at 375px, 768px, and 1280px before marking a task done

## Firebase Conventions

- All Firestore access goes through custom hooks in `frontend/src/hooks/` — never call `firebase/*` directly from a page component
- Multi-tenancy: everything except `users/` nests under `companies/{companyId}/…`
- Membership and role come from the `users/{uid}` Firestore document (`companyId`, `role`); security rules `get()` that document to authorize access. **Firebase Auth custom claims are not implemented** — do not reference them in rules or UI guards
- Check `frontend/firestore.rules` before adding any new collection or field; rules are published manually via the Firebase console (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
- `firebase.json` and `.firebaserc` do not exist yet — do not claim or assume Firebase CLI/Hosting configuration

## Firestore Data Model (summary)

Full detail, field lists, and relationships: [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

```
users/{uid}                                  name, email, role, companyId, avatarInitials
companies/{companyId}                        name, …
companies/{companyId}/costCodes/{id}         code, name, category, unit, isActive — company-wide taxonomy
companies/{companyId}/contacts/{contactId}   entityType, contactTypes[], names, abn, gstStatus, people[],
                                             projectAssignments[] + derived projectIds[], isActive —
                                             company-wide directory; reads restricted to financial roles
companies/{companyId}/counters/{counterId}   next — sequential numbering (purchaseOrders, progressClaims,
                                             supplierInvoices)
companies/{companyId}/projects/{projectId}   name, status, budget, startDate, location, progress
  …/budgetLines/{lineId}                     costCodeId, costCodeName, budgeted, notes
  …/purchaseOrders/{poId}                    poNumber, status, supplierName, lineItems[], subtotal, gst, total
  …/progressClaims/{claimId}                 claimNumber, status, poId, cumulative lineItems[], retention,
                                             claimed/approved subtotal-gst-total
  …/supplierInvoices/{invoiceId}             invoiceNumber (SI-####), status, source, poId, progressClaimId,
                                             ex-GST lineItems[] w/ per-line taxCode, retention, subtotal-gst-net-total —
                                             accounts payable; reads restricted to financial roles
```

## Financial Invariants (mandatory)

- **Purchase Orders, Progress Claims, and Supplier Invoices never write financial values onto Budget Lines.** Committed, Claimed, Actual, and Invoiced are derived at read time from PO, claim, and invoice documents (`lib/purchaseOrders.js`, `lib/progressClaims.js`, `lib/supplierInvoices.js`) — never stored back. Committed now means *remaining open commitment* (PO line − posted/paid invoiced-to-date); Actual counts a posted invoice instead of its source claim (read-time exclusion — the claim is never mutated)
- Document numbers (`PO-0001`, `PC-0001`, `SI-0001`) come from company-wide counters incremented in the same transaction as the document write
- PO line items freeze once a PO leaves `draft`; claim amounts freeze once submitted; approved amounts are frozen forever; supplier invoices freeze once `posted` (and posted invoices cannot be cancelled/unposted)
- Lifecycles are forward-only; financial documents are never deleted — cancellation/rejection is a status change
- One open Progress Claim per PO at a time; claims are cumulative (claimed-to-date per PO line)
- POs snapshot `supplierName` from the chosen contact at write time (`supplierId` is the live link); contact edits or archiving never rewrite issued documents, and POs/claims with `supplierId: null` (pre-Contacts) render from the snapshot and are never backfilled
- Exact definitions and formulas: [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md); rationale: [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md)

## Naming

- Files: `PascalCase` for components, `camelCase` for hooks and lib files
- Firestore collections: `camelCase` plural (`projects`, `costCodes`, `purchaseOrders`, `progressClaims`, `supplierInvoices`)
- Tailwind class order: layout → spacing → colour → typography → interactive

## What Not To Do

- Do not write inline style objects — use Tailwind classes
- Do not add Stripe, AI, or billing code until Sprint 6
- Do not install native mobile packages (React Native, Capacitor, Expo) in this repo
- Do not create Firestore documents outside a `companies/{companyId}` scope (except `users/{uid}`) — security rules will reject them
- Do not put business logic in page components — extract to hooks or `lib/`
- Do not create new colour values — use the tokens in `frontend/src/index.css`
- Do not write committed/claimed/actual values onto budget lines from any client code
- Do not edit `frontend/firestore.rules` casually — rule changes need a manual publish and a security review against [docs/SECURITY.md](docs/SECURITY.md)

## Inspection Workflow

Before starting any task, an agent must:

1. Read `AGENT.md` (this file) in full
2. Read `PRODUCT.md` for scope and the role model; `ROADMAP.md` for what is current and what is out of scope
3. Read the relevant `docs/` documents for the area being touched (data model, financial workflows, security, design system)
4. Inspect the existing repository structure and relevant files before making changes — do not assume a layout
5. Read the relevant page component and its hooks before editing either
6. Check `frontend/firestore.rules` before adding any new collection or field
7. Confirm the task falls within current scope — if not, flag it rather than build it

## Web-First / Mobile-Ready Philosophy

- Build every layout mobile-first using Tailwind breakpoints (`sm:`, `md:`, `lg:`)
- The sidebar collapses to an overlay drawer below `md:`; the TopBar hamburger opens it
- Touch targets must be at least 44px tall on interactive elements
- No hover-only interactions — every action must also work on tap
- PWA manifest and service worker come in a later sprint — do not anticipate them now

## AI Feature Placeholder Rule

PULSE™, IQ™, Quant™, and SHIELD™ are reserved proprietary features.

- Do not implement any AI, ML, scoring, or hashing logic for these features
- If a screen references one, render a placeholder card: feature name, one-line description, "Coming Soon" badge — no data, calculations, or API calls behind it
- Never import an AI/ML library (TensorFlow, OpenAI SDK, LangChain, etc.) without explicit instruction

## Git Workflow

- Branch from `main` for every piece of work: `feature/`, `fix/`, `chore/`, `docs/` prefixes, lowercase kebab-case
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- One logical change per commit — do not bundle unrelated edits
- Open a PR against `main`; do not push directly to `main`
- Do not commit `.env.local`, Firebase service account keys, or any secret file
