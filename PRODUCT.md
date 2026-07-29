# Constrapp — Product Overview

## What It Is

**Constrapp is the connected commercial operating system for construction projects.**

Australian-built and web-first, it gives builders, contractors, and quantity surveyors one connected commercial dataset that runs from preconstruction through to final account. It replaces spreadsheets and disconnected tools with a single source of commercial truth covering budgets, procurement, purchase orders, variations, progress claims, supplier invoices, forecasting, and margin — with **Cost Codes as the spine** that joins every stage.

This document describes both what is **implemented today** and the **product intent**. Each module below is marked accordingly — do not read an unmarked ambition as shipped behaviour. Technical status detail lives in [ROADMAP.md](ROADMAP.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The Connected Commercial Lifecycle

Constrapp models one continuous commercial dataset, not a set of disconnected tools. The same data flows through every stage:

```
Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved Budget
  → Commitment → Purchase Order → Variation → Progress Claim
  → Supplier Invoice → Actual Cost → Forecast → Cash Flow
  → Final Project Margin → Final Account
```

Field information exists to serve a commercial outcome — never as an end in itself:

- Site progress → forecast update
- Approved variation → budget and commitment update
- Defect or delay → project risk and forecast impact
- Drawing measurement → BOQ quantity
- Subcontractor bid → award and commitment
- Site photo → progress or claim evidence

## Cost Codes — The Commercial Spine

Cost Codes are the single join key connecting every commercial stage. A cost code links a BOQ line to an estimate, an estimate to a tender package, an award to a budget line, a budget line to a purchase order, and a PO to its variations, claims, and supplier invoices. Every commercial document references a cost code and snapshots its display name at write time, so the whole lifecycle reconciles through one taxonomy. New commercial modules must integrate through the cost-code spine rather than operate independently.

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

## Commercial Workflow Module Tiers

Status legend: **Implemented** (foundation shipped) · **Partial** (some functionality, gaps noted) · **Placeholder** (screen exists, no functionality) · **Future** (not built). Modules are grouped by their role in the commercial lifecycle, not by screen.

### Tier 1 — Commercial spine (the connected lifecycle)

- **Cost Codes** — *Implemented (foundation).* Company-wide taxonomy (code, name, category, unit) reused across all projects; the join key for every commercial stage.
- **Approved Budget (Budgets)** — *Implemented (foundation).* Per-project budget lines against company-wide cost codes, tracking **Budgeted, Committed, Claimed, Actual, Invoiced, Remaining**. All six are derived live from POs, progress claims, and supplier invoices — none are stored on budget lines. Committed is *remaining open commitment* (PO value net of posted invoicing). Definitions: [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md).
- **Purchase Orders (Commitment)** — *Implemented (foundation).* Create draft POs with embedded line items against cost codes, transactional PO numbering, draft → sent → closed/cancelled lifecycle. Suppliers are picked from company Contacts (with inline quick-create); sending to suppliers by email/PDF is future.
- **Progress Claims** — *Implemented (foundation).* Cumulative supplier claims against sent POs: claimed-to-date entry per PO line, overclaim warnings, one open claim per PO, assessment with per-line certification, partial approval, retention and GST handling.
- **Supplier Invoices (Actual Cost)** — *Implemented (foundation).* Accounts-payable supplier bills (`SI-0001`), created either directly against a sent/closed PO (`direct_po`) or from one approved progress claim (`progress_claim`). Per-line ex-GST amounts with per-line tax codes (GST / GST-free / input-taxed), retention carried from the claim, `draft → approved → posted` lifecycle (posted is immutable). Posted/paid invoices drive **Invoiced**, mature **Committed** to remaining open commitment, and feed **Actual** (replacing their source claim without double-counting). Reads restricted to internal financial roles. Payments, Credit Notes, attachments, and accounting sync are reserved/future.
- **BOQ & Estimating** — *Placeholder.* Build a Bill of Quantities against cost codes, apply rates/margin/overheads to produce an estimate, and transfer to an approved budget. *Planned* — see [ROADMAP.md](ROADMAP.md).
- **Tender & Award** — *Future.* Tender packages built from the BOQ, subcontractor invitations, and bid comparison/levelling by cost code, feeding award → commitment. *Planned.*
- **Variations** — *Implemented (foundation).* One type-discriminated collection: **Client Variations** (`CV-0001`, head-contract revenue changes) and **Supplier Variations** (`SV-0001`, subcontract commitment changes; one PO or none). Cost-code spine on every line, per-line tax codes (ex-GST canonical, negatives supported), `draft → submitted → approved`/`rejected`/`withdrawn` lifecycle with unbounded per-line approval. Approved-only, read-time: approved supplier variations surface as **Commitment Exposure** (separate from Committed) on the Budget tab; approved client variations are revenue-side only. No Budget Line/PO/claim/invoice mutation. *Deferred:* claim/invoice-against-variation linkage (the reserved `variationId`), forecast/margin consumers, and internal Budget Adjustments (a separate future type).
- **Forecast Cost to Complete** — *Implemented (foundation).* A forward-looking, **strictly cost-side** control layer answering "what do we currently expect this project to cost when complete?" One manual input per cost code — **Uncommitted Cost to Complete** (`number | null`; `null` = not forecast, `0` = reviewed/no further cost) — stored in per-cost-code `forecastLines` keyed by `costCodeId`; everything else is derived at read time. **Forecast Final Cost** = Actual + Remaining Committed + Uncommitted CTC; **Variance to Budget** = Budgeted − Forecast Final Cost. No automatic remaining-budget default (a Remaining Budget Reference backs an explicit "Use remaining budget" action). Approved and pending **supplier variation exposure are shown separately and never added** to the forecast (they do not yet mature against claims/invoices). Financial-role-only reads. Definitions: [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md).
- **Cash Flow & Project Margin** — *Placeholder.* Cash-flow curves and project margin — the remaining outputs that close the project-control loop. *Planned.*
- **Final Account** — *Future.* Reconciliation of approved budget, variations, and actual cost into final project margin. *Planned.*

### Tier 2 — Commercial enablers

- **Projects** — *Implemented (foundation).* Create and list projects with status, budget, progress; Project Detail area with tabbed modules. No edit/delete yet.
- **Contacts** — *Implemented (foundation).* Company-wide directory of suppliers, subcontractors, consultants, and clients (organisations and individuals) with ABN validation, trades, payment terms, GST status, embedded contact people, duplicate warnings, and archive/reactivate. Contacts can be assigned to any number of projects (administrative tags — contacts always stay company-wide); the PO supplier picker lists the current project's contacts first, and quick-created suppliers are auto-assigned to that project. New Purchase Orders pick their supplier from Contacts (`supplierId` + `supplierName` snapshot). Directory reads are restricted to internal financial roles.
- **Subcontractors** — *Partial.* Live filtered view of Contacts (type = subcontractor). IQ™ accountability scoring and budget vs cost code breakdown remain future.
- **Manual QS Takeoff** — *Future.* Enter measured quantities that populate BOQ quantity lines by cost code — the manual pipeline that Quant™ AI later accelerates. *Planned.*
- **Payments** — *Future.* Recording payments against posted supplier invoices (the reserved `paid` status / `paidAt`), plus retention release. Accounting integrations (Xero, MYOB, QuickBooks) attach via the `externalRefs` fields on POs, claims, and invoices.
- **Credit Notes** — *Future.* Supplier credits/negative adjustments against posted invoices (reserved `docType: 'credit_note'` / `adjustsInvoiceId`), reducing Invoiced.
- **Commercial Reporting** — *Placeholder.* Margin, cost-to-complete, cash-flow, and final-account reporting (not a generic export builder). *Planned.*

### Tier 3 — Field features (repositioned as commercial inputs/outputs)

Each field feature earns its place by feeding or evidencing a commercial outcome; none is a standalone reporting product.

- **Drawings & Documents** — *Placeholder.* The source of measured quantities: drawing measurement → BOQ quantity. Upload, version, and mark up drawings in service of takeoff/BOQ.
- **Site Photos** — *Placeholder.* Progress and claim evidence: site photo → progress or claim evidence.
- **Timeline** — *Placeholder.* Schedule input to forecast and cash flow: delay → forecast impact.
- **Dashboard** — *Partial.* Live project list and company/user context; KPI cards and charts still show static placeholder numbers — to be driven by commercial outputs (margin, CTC) once those exist.

### Tier 4 — Intelligence & assurance (commercially anchored, later)

Reserved proprietary features. They read the commercial spine; they do not introduce a parallel model. All remain placeholders until their planned sprint (see [ROADMAP.md](ROADMAP.md)).

- **Constrapp PULSE™** — *Placeholder.* Commercial health engine — surfaces margin erosion, forecast cost trend, committed-versus-budget exposure, cash-flow risk, unapproved variation exposure, and uncertified claim exposure.
- **Constrapp SHIELD™** — *Placeholder.* Commercial audit and assurance — approval segregation, financial-document immutability, duplicate invoice detection, overclaim and over-invoice anomalies, and out-of-sequence commercial approvals.
- **Constrapp IQ™** — *Future.* AI intelligence for schedule, variation, and accountability.
- **Constrapp Quant™** — *Future.* AI quantity takeoff from uploaded drawings, populating the same BOQ quantities as manual takeoff.

## What Constrapp Is Not

Constrapp is a commercial-control system, **not a Dashpivot-style form-first platform**. The following are deliberate anti-goals, not backlog items — building them requires an approved strategy change:

- Generic no-code form builders
- Large HSEQ template libraries
- Generic field reporting
- Payroll or broad workforce management
- Fleet or equipment management
- Broad enterprise integrations before product-market fit

Field capability is always in service of a commercial outcome (see the lifecycle above); a feature that cannot state its commercial input or output does not belong in scope.

## Pricing

Subscription plans are planned; billing is not implemented. Contact us for current arrangements.

## Ownership

100% Australian-built and owned. All proprietary features are original IP.
