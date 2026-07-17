# Constrapp — Product Overview

## What It Is

Constrapp is an Australian-built, web-first construction project management platform for builders, contractors, and quantity surveyors. It replaces spreadsheets and disconnected tools with a single workspace covering budgets, purchase orders, progress claims, tendering, subcontractor management, drawings, site photos, and reporting.

This document describes both what is **implemented today** and the **product intent**. Each module below is marked accordingly — do not read an unmarked ambition as shipped behaviour. Technical status detail lives in [ROADMAP.md](ROADMAP.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Target Market

- Small-to-medium Australian construction companies (primary)
- Project managers, quantity surveyors, company admins
- Subcontractors and clients who need controlled read/limited access

## User Roles

Product intent — the full role model the product is designed around:

| Role | Intended Access |
|---|---|
| Super Admin | Platform owner — cross-company visibility |
| Company Admin | Full access within their company |
| Project Manager | Projects, budgets, contacts, drawings, POs, claims |
| QS / Office | BOQ, budgets, forecasting, claims assessment, reports |
| Subcontractor | Assigned projects, drawings, POs, photos |
| Client | Dashboard, pulse view, photos, reports |

**Implemented today:** role is a field on the user's Firestore document; security rules distinguish only *company member (read)* vs *company_admin / project_manager / qs (write)*. Super Admin has no special powers yet, and Subcontractor/Client scoping is not implemented. See [docs/SECURITY.md](docs/SECURITY.md).

## Core Modules

Status legend: **Implemented** · **Partial** · **Placeholder** (screen exists, no functionality) · **Future** (not built).

- **Dashboard** — *Partial.* Live project list and company/user context; KPI cards and charts still show static placeholder numbers.
- **Projects** — *Implemented (foundation).* Create and list projects with status, budget, progress; Project Detail area with tabbed modules. No edit/delete yet.
- **Budgets** — *Implemented (foundation).* Per-project budget lines against company-wide cost codes, tracking **Budgeted, Committed, Claimed, Actual, Invoiced, Remaining**. Committed/Claimed/Actual are derived live from POs and progress claims; Invoiced awaits the invoices module. Definitions: [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md).
- **Cost Codes** — *Implemented (foundation).* Company-wide taxonomy (code, name, category, unit) reused across all projects.
- **Purchase Orders** — *Implemented (foundation).* Create draft POs with embedded line items against cost codes, transactional PO numbering, draft → sent → closed/cancelled lifecycle. Sending to suppliers by email/PDF is future.
- **Progress Claims** — *Implemented (foundation).* Cumulative supplier claims against sent POs: claimed-to-date entry per PO line, overclaim warnings, one open claim per PO, assessment with per-line certification, partial approval, retention and GST handling.
- **BOQ & Tender Tool** — *Placeholder.* Build a Bill of Quantities, set margin/overheads, transfer to budget.
- **Forecasting & Cashflow** — *Placeholder.* Income/expense curves, profit analysis per project.
- **Variations** — *Placeholder.* Scope variations and their budget impact.
- **Contacts** — *Placeholder.* Subcontractors, suppliers, consultants with ABN/trade/notes.
- **Drawings & Documents** — *Placeholder.* Upload, version, and mark up drawings.
- **Site Photos** — *Placeholder.* Tagged photo uploads per project.
- **Subcontractors** — *Placeholder.* IQ™ accountability scoring, budget vs cost code breakdown.
- **Timeline** — *Placeholder.* Gantt-style schedule view with delay detection.
- **Reports** — *Placeholder.* PDF/CSV exports for financial, progress, and cashflow.
- **Invoices & Payments** — *Future.* Supplier invoices matched to approved claims; drives Invoiced and matures Committed. Accounting integrations (Xero, MYOB, QuickBooks) attach here via the `externalRefs` fields already stored on POs and claims.

## Proprietary Features (Future Phases)

- **Constrapp PULSE™** — Living AI project health engine; real-time portfolio score *(placeholder screen exists)*
- **Constrapp IQ™** — AI-powered schedule, variation, and accountability intelligence
- **Constrapp Quant™** — AI quantity takeoff directly from uploaded drawing files
- **Constrapp SHIELD™** — Document integrity hashing, audit trail, and anomaly detection *(placeholder screen exists)*

## Pricing

Subscription plans are planned; billing is not implemented. Contact us for current arrangements.

## Ownership

100% Australian-built and owned. All proprietary features are original IP.
