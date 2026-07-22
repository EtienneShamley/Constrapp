# Constrapp — Development Roadmap

## Guiding Principles

- Web-first. Mobile-ready via responsive layout from day one.
- PWA packaging and native mobile app after web MVP is validated.
- Firebase backend throughout — currently client SDK only; Cloud Functions/Hosting when needed.
- Each sprint ships working, demo-able software — no dead screens.

---

## Completed Foundations

- [x] Vite + React + Tailwind v4 scaffolding, dark theme design tokens
- [x] Responsive shell layout (sidebar drawer + topbar + content area)
- [x] **Authentication** — email/password sign-in, protected routes (signup/reset screens are stubs; users provisioned manually)
- [x] **Company/user foundation** — `users/{uid}` profile with `companyId` + `role`; company context throughout the app
- [x] **Projects** — create, list, status badges, progress
- [x] **Project Detail** — tabbed layout (`/projects/:projectId/*`) hosting all project modules
- [x] **Cost Codes** — company-wide taxonomy (create, list)
- [x] **Budget Lines** — per-project allocations with read-time Committed/Claimed/Actual rollups
- [x] **Purchase Orders** — embedded line items, transactional numbering, forward-only lifecycle, committed-cost derivation
- [x] **Progress Claims** — cumulative claiming, one open claim per PO, assessment with partial approval, retention + GST
- [x] **Contacts** — company-wide directory (suppliers, subcontractors, consultants, clients; organisations + individuals), ABN validation, embedded contact people, duplicate warnings, archive/reactivate; PO supplier picker with quick-create writes `supplierId` + `supplierName` snapshot; Subcontractors page is a filtered contacts view
- [x] **Contact project assignments** — embedded `projectAssignments` (+ derived `projectIds`) on contacts; multi-project checkbox assignment on the contact form, project/unassigned filter, PO picker grouped "This project" / "Other company contacts", quick-create auto-assigns to the current project; no rules changes, no migration of existing contacts
- [x] **Supplier Invoices** — accounts-payable bills (`SI-0001`) via two paths: `direct_po` (against a sent/closed PO) and `progress_claim` (from one approved claim); per-line ex-GST amounts with per-line tax codes, retention carried from claims, `draft → approved → posted` lifecycle (posted immutable), duplicate + over-invoicing warnings, financial-role-only reads. Read-time derivation: Invoiced from posted/paid invoices, Committed matured to remaining open commitment, Actual replaces a source claim with its posted invoice (no claim mutation, no double-count). No Budget Line writes; no migration

Firestore security rules for all of the above are written in `frontend/firestore.rules` and published manually.

---

## Documentation Sprint — Current

Bring documentation in line with the implemented system:

- Corrected root docs (AGENT, README, PRODUCT, ROADMAP) + new CLAUDE.md
- New `docs/`: ARCHITECTURE, DATA_MODEL, FINANCIAL_WORKFLOWS, SECURITY, TESTING, DESIGN_SYSTEM, PROJECT_DECISIONS, DEPLOYMENT

---

## Known Gaps & Deferred Work

**Placeholders (screens exist, no functionality):** PULSE™, SHIELD™, and the BOQ, Forecasting, Variations, Documents, Photos, Timeline, and Reports project tabs. Dashboard KPIs/charts are partly static. Subcontractors shows the live contacts directory but its IQ™ scoring is a placeholder. None of these are complete.

**Deferred security hardening** (client-enforced today, server enforcement deferred — full list in [docs/SECURITY.md](docs/SECURITY.md)):

- Server-enforced lifecycle transitions and post-submission immutability
- One-open-claim race protection
- Creator ≠ approver segregation
- Supplier-scoped subcontractor access
- Counter tamper protection
- Audit logging

**Other deferred foundations:** user management UI (invite, assign role/company), project edit/delete, self-serve signup and password reset, Firebase CLI config (`firebase.json`/`.firebaserc`), Hosting, CI.

---

## Development Order

The sequence closes the commercial-control loop first (the back half of the lifecycle is already in the schema), then completes the preconstruction side (the front half), then layers intelligence and commercially linked field features. Each item integrates through the cost-code spine.

**1. Variations**
The missing connector between commitments, claims, invoices, and forecast. Approved scope changes update budget and commitment and flow into claiming — activating the reserved `variationId`. Highest leverage because every downstream figure depends on it, and the schema already anticipates it.

**2. Forecast Cost to Complete**
Derives remaining cost from budget, commitment, variations, and actuals — read-time, like the six budget figures. This is what turns recorded cost into a forward-looking control number.

**3. Cash-flow Forecasting and Project Margin**
Cash-flow curves and project margin close the current project-control loop: the system can now answer "where does this project finish?" not just "what has it cost?"

**4. BOQ and Estimating**
Opens the preconstruction side: a Bill of Quantities against cost codes, with rates/margin/overheads producing an estimate that transfers to an approved budget.

**5. Tender Packages, Subcontractor Invitations, and Bid Levelling**
Tender packages built from the BOQ, subcontractor invitations, and bid comparison/levelling by cost code, feeding award → commitment.

**6. Manual QS Takeoff connected to BOQ quantities**
Measured quantities populate BOQ quantity lines by cost code. Manual takeoff must exist before Quant™ AI — the AI accelerates an established pipeline rather than inventing one.

**7. Payments and Credit Notes**
Record payments against posted invoices (`paid`/`paidAt`, retention release) and supplier credits (`docType`/`adjustsInvoiceId`). Important for completeness, but less differentiating than Variations and Forecasting — hence sequenced after them despite the reserved fields already existing.

**8. Final Account and Commercial Reporting**
Reconcile approved budget, variations, and actual cost into final project margin; commercial reporting on margin, cost-to-complete, cash flow, and final account (not a generic export builder).

**9. Intelligence layer**
Constrapp PULSE™ (commercial health), IQ™ (schedule/variation/accountability intelligence), SHIELD™ (commercial audit and assurance), and Quant™ (AI takeoff into BOQ quantities). Each reads the commercial spine; all remain placeholders until this sprint.

**10. Commercially linked field modules**
Drawings (drawing measurement → BOQ quantity), Site Photos (→ progress/claim evidence), Timeline (delay → forecast impact). Each lands only with its commercial input/output defined.

### Also tracked (not lifecycle-ordered)

- Budget burn bar and variance indicators; project edit
- User management (invite, assign role, assign company)
- Subcontractors module — linked to contacts and cost codes

## Anti-Goals (out of scope without an approved strategy change)

Constrapp is the connected commercial operating system for construction — **not a Dashpivot-style form-first platform**. The following are deliberately not on the roadmap:

- Generic no-code form builders
- Large HSEQ template libraries
- Generic field reporting
- Payroll or broad workforce management
- Fleet or equipment management
- Broad enterprise integrations before product-market fit

Field features are prioritised only when they feed or evidence a commercial outcome.

## Growth (later)

- Billing & subscriptions — Stripe integration, plan management in-app
- Accounting integrations — Xero, MYOB, QuickBooks (via `externalRefs`) — after product-market fit
- Client portal — limited external access for project owners
- PWA packaging and mobile-optimised layouts

## Future

- Native iOS / Android app (React Native or Expo)
- White-label option for enterprise
- API access tier
