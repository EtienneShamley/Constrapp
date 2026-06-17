# Constrapp — Development Roadmap

## Guiding Principles

- Web-first. Mobile-ready via responsive layout from day one.
- PWA packaging and native mobile app after web MVP is validated.
- Firebase backend (Auth, Firestore, Storage, Hosting) throughout.
- Each sprint ships working, demo-able software — no dead screens.

---

## Sprint 1 — Foundation (Current)

**Goal:** Working app skeleton with auth, data model, and project list.

- [ ] Firebase project setup (Auth, Firestore, Storage, Hosting)
- [ ] Vite + React + Tailwind scaffolding
- [ ] Dark theme design tokens (from prototype colour palette)
- [ ] Responsive shell layout (sidebar + topbar + content area)
- [ ] Login page with email/password auth
- [ ] Role-based route protection
- [ ] Company structure in Firestore (multi-tenant)
- [ ] User management (invite, assign role, assign company)
- [ ] Projects list — create, view, status badges, progress
- [ ] Dashboard shell — KPI stat cards (static/placeholder data)

**Not in Sprint 1:** AI, billing, BOQ, drawing takeoff, subscriptions, Stripe, photos, native mobile.

---

## Sprint 2 — Financial Core

- Budgets module — cost codes with committed/actual/invoiced/remaining
- Purchase Orders — create, send, link to cost code
- Contacts — subcontractors, suppliers, consultants
- Budget burn bar and variance indicators
- Project detail view (budget summary, linked POs, cost code breakdown)

---

## Sprint 3 — Tender & Reporting

- BOQ & Tender Tool — QS line items → overhead/margin → tender price → transfer to budget
- Reports — PDF export (financial summary, project progress)
- Subcontractors module — linked to contacts and cost codes

---

## Sprint 4 — Site, Field & Forecasting

- Forecasting & Cashflow — area charts, profit breakdown per project
- Drawings & Documents — upload, version control, revision warnings
- Site Photos — upload, tag by project, gallery view
- Timeline — Gantt-style schedule, delay flags
- Basic markup tool on drawings (annotate, pin, circle)

---

## Sprint 5 — Intelligence Layer

- Constrapp PULSE™ — portfolio health scoring engine
- Constrapp IQ™ — AI alerts for schedule, variations, accountability
- Constrapp SHIELD™ — document hashing, audit trail, access anomaly detection

---

## Sprint 6 — Growth

- Constrapp Quant™ — AI quantity takeoff from uploaded PDFs/drawings
- Billing & subscriptions — Stripe integration, plan management in-app
- Client portal — limited external access for project owners
- PWA packaging and mobile-optimised layouts

---

## Future

- Native iOS / Android app (React Native or Expo)
- White-label option for enterprise
- API access tier
