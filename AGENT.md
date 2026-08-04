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

## Engineering & Security Standards (mandatory)

[docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) is **binding** for
every change, by humans or AI agents — as binding as the Strategic and Financial
Invariants. Before writing code, run its pre-implementation checklist; before
marking a task done, run its validation and security-review checklists. In
particular:

- **Firestore Security Rules are the single trust boundary.** Client-side role and
  lifecycle checks are **UX only** and never sufficient authorisation. When you
  describe a control, distinguish *rules-enforced* from *client-enforced* — **never
  claim a feature is secure or a control is enforced when it is client-side only.**
  Use the honesty protocol in ENGINEERING_STANDARDS.md §7 and cite the relevant
  [docs/SECURITY.md](docs/SECURITY.md) Deferred Controls item.
- **No secret in the frontend, ever.** Every `VITE_`-prefixed variable ships in the
  public bundle. Never `VITE_`-prefix or read a real secret (Stripe/AI/email keys,
  service-account JSON) from frontend code, and never call a privileged provider
  operation directly from the browser (see [docs/SECURITY.md](docs/SECURITY.md) →
  Secrets & the Vite bundle).
- **A new collection or field is not done until its rules block is written and a
  security-review pass is complete.** Rule changes need a manual publish and a review
  against [docs/SECURITY.md](docs/SECURITY.md).
- The `backend/` directory is a **reserved, intentionally empty placeholder** — it
  contains no code; do not treat it as an existing backend.

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
    layouts/        AppShell (Sidebar + TopBar), AuthLayout, ProjectDetailLayout,
                    ProjectCommercialLayout (Commercial sub-nav:
                    Margin | Client Invoices | Client Receipts | Supplier Payments
                    | Cash Flow)
    pages/          Top-level routes; pages/project/ holds Project Detail tabs
    hooks/          useAuth, useProfile, useCompany, useProjects, useProject,
                    useCostCodes, useContacts, useBudgetLines, usePurchaseOrders,
                    useProgressClaims, useSupplierInvoices, useClientInvoices,
                    useClientReceipts, useSupplierPayments, useVariations,
                    useForecastLines, useProjectCommercial, useCashFlowLines
    lib/            firebase.js, formatters.js, currency.js, nav.js, projectTabs.js,
                    purchaseOrders.js, progressClaims.js, supplierInvoices.js,
                    clientInvoices.js, payments.js (shared, direction-agnostic),
                    clientReceipts.js, supplierPayments.js, variations.js,
                    forecast.js, margin.js, cashFlow.js (pure monthly cash
                    aggregation + forecast layers), contacts.js (pure domain logic)
  tests/unit/       Unit tests for pure lib/ logic (npm run test:unit — no emulator)
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
- `frontend/firebase.json` exists **only** to point the Firestore emulator at `firestore.rules` for the automated Security Rules suite (`npm run test:rules`). There is **no `.firebaserc`**, no hosting, and no functions config — do not claim or assume Firebase CLI/Hosting deployment, and never run `firebase deploy`. Rules are still published manually
- **Run `npm run test:rules` before any `firestore.rules` change is published** (see [docs/TESTING.md](docs/TESTING.md) §0)

## Firestore Data Model (summary)

Full detail, field lists, and relationships: [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

```
users/{uid}                                  name, email, role, companyId, avatarInitials
companies/{companyId}                        name, countryCode (ISO 3166-1 alpha-2),
                                             baseCurrency (ISO 4217), currencyUpdatedAt/By —
                                             client may update ONLY those four currency fields
                                             (company_admin); create/delete blocked
companies/{companyId}/costCodes/{id}         code, name, category, unit, isActive — company-wide taxonomy
companies/{companyId}/contacts/{contactId}   entityType, contactTypes[], names, abn, gstStatus, people[],
                                             projectAssignments[] + derived projectIds[], isActive —
                                             company-wide directory; reads restricted to financial roles
companies/{companyId}/counters/{counterId}   next — sequential numbering (purchaseOrders, progressClaims,
                                             supplierInvoices, variationsClient, variationsSupplier,
                                             clientInvoices, clientReceipts, supplierPayments)
companies/{companyId}/projects/{projectId}   name, status, budget, startDate, location, progress,
                                             currency (ISO 4217 — the display authority),
                                             currencyLocked (one-way ratchet)
  …/budgetLines/{lineId}                     costCodeId, costCodeName, budgeted, notes
  …/purchaseOrders/{poId}                    poNumber, status, supplierName, lineItems[], subtotal, gst, total
  …/progressClaims/{claimId}                 claimNumber, status, poId, cumulative lineItems[], retention,
                                             claimed/approved subtotal-gst-total
  …/supplierInvoices/{invoiceId}             invoiceNumber (SI-####), status, source, poId, progressClaimId,
                                             ex-GST lineItems[] w/ per-line taxCode, retention, subtotal-gst-net-total —
                                             accounts payable; reads restricted to financial roles
  …/clientReceipts/{receiptId}               receiptNumber (CR-####), status draft|posted|void, REQUIRED clientId +
                                             clientName snapshot, receiptDate ('YYYY-MM-DD'), gross `amount` (> 0),
                                             paymentMethod (never defaulted), bank/external refs, EMBEDDED
                                             allocations[] {clientInvoiceId, invoiceNumber, allocatedAmount},
                                             allocatedTotal + unallocatedAmount (scalar invariant rules-enforced in
                                             whole cents) — CASH RECEIVED; no GST, no tax code, no net amount;
                                             Received to Date / Remaining to Reconcile / reconciliation state derived
                                             read-time and NEVER written onto an invoice; LIFECYCLE + POSTED
                                             IMMUTABILITY ARE RULES-ENFORCED; reads restricted to financial roles
  …/clientInvoices/{invoiceId}               invoiceNumber (CI-####), status draft|issued|void, client identity
                                             snapshot (name/legalName/abn/email/phone/address), ex-GST lineItems[]
                                             w/ per-line taxCode + OPTIONAL costCodeId + optional variationId,
                                             invoiceDate/dueDate, paymentTerms snapshot, externalInvoiceReference —
                                             accounts receivable; contract control + ageing derived read-time;
                                             LIFECYCLE + ISSUED IMMUTABILITY ARE RULES-ENFORCED (the only collection
                                             where they are); reads restricted to financial roles
  …/supplierPayments/{paymentId}             paymentNumber (SP-####), status draft|posted|void, REQUIRED supplierId +
                                             supplierName snapshot, paymentDate ('YYYY-MM-DD'), gross `amount` (> 0),
                                             paymentMethod (never defaulted), bank/remittance/external refs, EMBEDDED
                                             allocations[] {supplierInvoiceId, invoiceNumber, supplierInvoiceNumber,
                                             allocatedAmount} against POSTED supplier invoices' payableTotal (NOT
                                             grossTotal — retention is withheld and is not payable), allocatedTotal +
                                             unallocatedAmount (scalar invariant rules-enforced in whole cents) —
                                             CASH PAID; no GST, no tax code, no net amount; Paid to Date / Remaining
                                             Payable / reconciliation state / AP ageing derived read-time and NEVER
                                             written onto an invoice (no `paid` status, no `paidAt`); LIFECYCLE +
                                             POSTED IMMUTABILITY ARE RULES-ENFORCED; reads restricted to financial roles
  …/variations/{variationId}                 variationNumber (CV-#### client / SV-#### supplier), variationType,
                                             status, client/supplier + poId snapshots, ex-GST lineItems[] w/ per-line
                                             taxCode (submitted/approved sides), costCodeId spine — commercial change
                                             control; approved-only read-time; reads restricted to financial roles
  …/forecastLines/{costCodeId}               costCodeId (= doc id), costCodeName, uncommittedCostToComplete (number|null),
                                             notes — the ONLY stored Forecast Cost to Complete input; all other forecast
                                             figures derived at read time; reads restricted to financial roles
  …/cashFlowLines/{lineId}                   AUTHORED monthly Cash Flow timing inputs: monthKey ('YYYY-MM'),
                                             direction in|out, basis 'gross', amount (> 0 — direction carries
                                             the sign), sourceAmountExGst (ex-GST COVERAGE only, null for
                                             manual), sourceType (contract_revenue | uninvoiced_claim |
                                             remaining_committed | uncommitted_ctc | manual — invoice types
                                             deliberately EXCLUDED, they are timed automatically),
                                             costCodeId + frozen costCodeName on cost-side lines,
                                             sourceRef/counterpartyName snapshots, description, status
                                             active|void — NO counter, NO number, NO sourceId, NO posted
                                             status; LIFECYCLE IS RULES-ENFORCED (active edit / active→void
                                             terminal, non-whitespace reason); delete blocked; the
                                             no-past-month rule is CLIENT-enforced; reads restricted to
                                             financial roles
  …/commercial/baseline                      single doc (id = "baseline"): originalContractValue, originalApprovedBudget
                                             (number|null), contract start/completion (Timestamp|null), clientId/clientName
                                             snapshot, notes — the ONLY stored Project Margin inputs; Current Contract Sum,
                                             Forecast Revenue, Forecast Gross Profit, Margin %, Margin Movement all derived
                                             at read time (lib/margin.js); ex-GST; reads restricted to financial roles
```

## Financial Invariants (mandatory)

- **Purchase Orders, Progress Claims, Supplier Invoices, Variations, and Forecast Lines never write financial values onto Budget Lines.** Committed, Claimed, Actual, Invoiced, the variation figures (Approved Supplier Variations / Commitment Exposure), and every forecast figure (Cost to Complete, Forecast Final Cost, Variance to Budget) are derived at read time from PO, claim, invoice, and variation documents (`lib/purchaseOrders.js`, `lib/progressClaims.js`, `lib/supplierInvoices.js`, `lib/variations.js`, `lib/forecast.js`) — never stored back. **Forecast Lines store only the manual `uncommittedCostToComplete` (number|null) + notes; supplier-variation exposure is shown separately and is never added into Forecast Final Cost.** Approved variations count only at read time and never mutate POs, claims, or invoices; **Commitment Exposure is separate from Committed** (variation commitment does not yet mature against claims/invoices). Committed now means *remaining open commitment* (PO line − posted/paid invoiced-to-date); Actual counts a posted invoice instead of its source claim (read-time exclusion — the claim is never mutated)
- Document numbers (`PO-0001`, `PC-0001`, `SI-0001`, `CV-0001`, `SV-0001`, `CI-0001`, `CR-0001`, `SP-0001`) come from company-wide counters incremented in the same transaction as the document write
- **Client Invoices are revenue-side and never touch a cost figure.** They never write onto Budget Lines, the Commercial Baseline, or Variations; `Issued Client Invoices`, `Available to Invoice`, per-variation invoiced/remaining, and receivables ageing are all derived at read time (`lib/clientInvoices.js`). Only **approved** client variations are invoiceable; **negative** approved ones reduce the Current Contract Sum but cannot be invoiced. Over-invoicing is **warned, never blocked** — the limit cannot be rules-enforced. **There is still no payment state ON THE INVOICE**: no `paid`/`partially_paid` status and no payment field. Since Client Receipts shipped, *Received to Date*, *Remaining to Reconcile*, and the reconciliation state (*unreconciled / partly / fully / over-reconciled*) are **derived at read time from posted receipt allocations** and are **never written onto an invoice** — which is why voiding a receipt restores balances with no reversal record. The words *paid* and *unpaid* must never be used as an invoice status. Constrapp does **not** produce a compliant Australian Tax Invoice (no company legal name/ABN) — never label output "Tax Invoice"
- **Client Receipts are cash, not revenue.** A receipt stores gross cash received — **no GST, no tax code, no net amount** — and feeds **no** budget figure, forecast figure, or margin figure. Allocations are **embedded** on the receipt and **nothing is ever written onto a Client Invoice** (no balance, no payment status, no back-reference). Over-allocating the *receipt* is hard-blocked and its scalar arithmetic is rules-enforced (in whole cents); over-allocating an *invoice* is **warned, never blocked** — rules cannot sum sibling documents. Unallocated receipts are permitted, reported separately, and **never auto-applied**. Cash Flow must consume `receiptDate`, never `createdAt`/`postedAt`
- **Supplier Payments are cash out, not cost.** A payment settles an Actual cost that a **posted** supplier invoice already recognised, so it feeds **no** budget figure, forecast figure, or margin figure. Allocations reconcile against `supplierInvoice.payableTotal` — **never `grossTotal`** — because retention withheld is not payable, and a payment never writes, clears, or reduces `retention`/`retentionGst`/`retentionTotal` (retention release is not modelled). Allocations are **embedded** on the payment and **nothing is ever written onto a Supplier Invoice** (no balance, no payment status, no back-reference). **`SI_STATUS.PAID` and `paidAt` are DEPRECATED IN PLACE, never activated** — no path writes them and `SI_TRANSITIONS` reaches `paid` from nowhere; `paid` stays in `SI_COUNTING_STATUSES` deliberately so a direct-SDK-forged document cannot vanish from Invoiced/Actual (ADR-24). Over-allocating the *payment* is hard-blocked and its scalar arithmetic is rules-enforced (whole cents); over-reconciling an *invoice* is **warned, never blocked**. Unallocated payments are permitted, reported separately, and **never auto-applied** — and their **full amount** is still actual Cash Out. Cash Flow must consume `paymentDate`, never `createdAt`/`postedAt`
- **Cash Flow consumes cash records and writes only its own timing lines — gross cash only.** Every figure is derived at read time in `lib/cashFlow.js` across three layers: **actual** (posted Client Receipts / Supplier Payments via `cashInRows()`/`cashOutRows()`), **automatic near-term forecast** (positive remaining on issued Client Invoices at gross, and on posted Supplier Invoices at `payableTotal`, timed by `dueDate` **month**), and **manual longer-term timing** (`cashFlowLines`). It consumes the **total transaction `amount`** (never `allocatedTotal`) on the **transaction date** (`receiptDate`/`paymentDate`, never `createdAt`/`postedAt`) and groups by `date.slice(0, 7)`. **THE BOUNDARY RULE: months before the current month are ACTUAL ONLY** — no forecast amount, automatic or manual, ever lands in a past month, which is what makes actual-vs-forecast provably non-double-counting. Past-due and undated invoice balances are **never guessed into a month**; they are reported untimed. Cash Flow **writes only `cashFlowLines`** — no receipt, payment, invoice, PO, claim, variation, forecast line, budget line, or baseline is ever mutated. A timing line stores an expected **gross** `amount` plus, separately, the **ex-GST `sourceAmountExGst`** it represents (completeness only — the two bases are never added together); invoice source types are **excluded** so an invoice balance can never be timed twice; approved-claim cost sits **inside** Remaining Committed and is never an additive second denominator. The cumulative position starts at **zero** and is net project cash movement, **never presented as a bank balance** (no bank account, opening balance, financing, retention release, or GST/BAS remittance is modelled — each is warned about, never silently adjusted). **A failed subscription is reported as unavailable, never as a genuine zero.**
- PO line items freeze once a PO leaves `draft`; claim amounts freeze once submitted; approved amounts are frozen forever; supplier invoices freeze once `posted` (and posted invoices cannot be cancelled/unposted)
- Lifecycles are forward-only; financial documents are never deleted — cancellation/rejection is a status change
- One open Progress Claim per PO at a time; claims are cumulative (claimed-to-date per PO line)
- POs snapshot `supplierName` from the chosen contact at write time (`supplierId` is the live link); contact edits or archiving never rewrite issued documents, and POs/claims with `supplierId: null` (pre-Contacts) render from the snapshot and are never backfilled
- **One currency per project; a currency is a label, never a conversion.** There is **no FX conversion**, no exchange rates, and no mixed-currency transactions. Money is formatted **only** through `formatCurrency(amount, currencyCode)` in `lib/formatters.js` with the currency resolved by `lib/currency.js` (`project.currency` → `company.baseCurrency` → `AUD`) — never hard-code a currency code or a `$`. Project currency **locks** once the project holds any monetary value (non-zero `budget`, budget lines, POs incl. draft/cancelled, claims, invoices, receipts, **supplier payments (incl. draft/void)**, variations, non-null forecast inputs, established baseline); Cost Codes and Contacts never lock. The lock *condition* is client-enforced (rules cannot enumerate subcollections); the *ratchet* is rules-enforced once set (ADR-21)
- **Currency is not tax.** `GST_RATE` remains a flat Australian 10% and every "GST 10%" label is Australian. Selecting another country changes the currency label only — never describe Constrapp as tax-compliant outside Australia
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
- Do not hard-code a currency code, a currency symbol, or a locale in a component — use `formatCurrency` with the resolved project currency
- Do not add FX conversion, exchange rates, or mixed-currency transactions
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
