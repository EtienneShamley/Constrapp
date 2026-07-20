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

## Next — Financial Core Completion

- ~~Contacts~~ — done: company-wide directory; new POs link `supplierId` (pre-existing POs keep `supplierId: null` and are not backfilled)
- Supplier invoices matched to approved claims → real Invoiced values; Committed matures to PO value − invoiced-to-date
- Variations affecting budget and claims
- Budget burn bar and variance indicators; project edit
- User management (invite, assign role, assign company)

## Then — Tender & Reporting

- BOQ & Tender Tool — QS line items → overhead/margin → tender price → transfer to budget
- Reports — PDF export (financial summary, project progress)
- Subcontractors module — linked to contacts and cost codes

## Then — Site, Field & Forecasting

- Forecasting & Cashflow — area charts, profit breakdown per project
- Drawings & Documents — upload, version control, revision warnings
- Site Photos — upload, tag by project, gallery view
- Timeline — Gantt-style schedule, delay flags
- Basic markup tool on drawings

## Then — Intelligence Layer (Sprint 5)

- Constrapp PULSE™ — portfolio health scoring engine
- Constrapp IQ™ — AI alerts for schedule, variations, accountability
- Constrapp SHIELD™ — document hashing, audit trail, access anomaly detection

## Then — Growth (Sprint 6)

- Constrapp Quant™ — AI quantity takeoff from uploaded PDFs/drawings
- Billing & subscriptions — Stripe integration, plan management in-app
- Accounting integrations — Xero, MYOB, QuickBooks (via `externalRefs`)
- Client portal — limited external access for project owners
- PWA packaging and mobile-optimised layouts

## Future

- Native iOS / Android app (React Native or Expo)
- White-label option for enterprise
- API access tier
