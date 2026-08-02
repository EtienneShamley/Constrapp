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
- [x] **Variations (foundation)** — one type-discriminated collection (`variations`): **Client Variations** (`CV-0001`, head-contract revenue) and **Supplier Variations** (`SV-0001`, subcontract commitment, one/no PO), company-wide counters. Cost-code spine on every line, per-line tax codes (ex-GST canonical, derived GST, negatives supported), `draft → submitted → approved`/`rejected`/`withdrawn` lifecycle with unbounded per-line approval and required assessment notes on change. Approved-only, read-time: Approved Supplier Variations + **Commitment Exposure** (separate from Committed) on the Budget tab; approved Client Variations are revenue-side only. Financial-role-only reads. **No** Budget Line/PO/claim/invoice mutation; `progressClaims.variationId` stays `null` (claim/invoice linkage deferred); no uploads; no migration

- [x] **Forecast Cost to Complete (foundation)** — forward-looking, **strictly cost-side** control layer. Per-cost-code `forecastLines` keyed by a deterministic `costCodeId` document ID; the **only** stored input is `uncommittedCostToComplete` (`number | null`; `null` = not forecast, `0` = reviewed/no further cost, `< 0` rejected) plus notes and audit stamps. Everything else is derived at read time by composing the existing Budget-page helpers (`lib/forecast.js`): **Forecast Final Cost** = Actual + Remaining Committed + Uncommitted CTC; **Variance to Budget** = Budgeted − Forecast Final Cost. No automatic remaining-budget default (a Remaining Budget Reference backs an explicit "Use remaining budget" action). Approved/pending **supplier variation exposure shown separately, never added** to the forecast (variations don't yet mature). Cost-code union across budget/PO/actual/invoice/variation/forecast rows; closed-PO residual flagged, not removed. Living editable inputs (no approval/snapshots). Financial-role-only reads; deletes blocked (clear via `null`). **No** Budget Line/PO/claim/invoice/variation mutation; no migration

- [x] **Project Margin (foundation)** — the first revenue-and-margin layer, closing the "what profit do we forecast?" question. A dedicated **Project Commercial Baseline** document (`…/projects/{projectId}/commercial/baseline`, deterministic id `baseline`) stores the only authored inputs — `originalContractValue`, `originalApprovedBudget` (`number | null`), `contractStartDate`/`contractCompletionDate` (`Timestamp | null`), `clientId`/`clientName` snapshot, `notes`, audit stamps. Everything else is derived at read time (`lib/margin.js` composing `lib/variations.js` + `lib/forecast.js`): **Current Contract Sum** = Original Contract Value + Approved Client Variations; **Forecast Revenue** = Current Contract Sum; **Forecast Gross Profit** = Forecast Revenue − Forecast Final Cost; **Forecast Margin %**; **Original Planned Profit/Margin %**; **Margin Movement**. All ex-GST. Pending client variations stay separate revenue exposure; approved/pending supplier variations stay separate cost exposure and are **never** added to Forecast Final Cost. New **Commercial** project tab + financial-role-only margin cards on Overview (one shared derivation). Reads/writes restricted to financial roles via a rules block scoped to the single `baseline` document; delete blocked. **No** mutation of Projects/Budget Lines/POs/Claims/Invoices/Variations/Forecast Lines; no migration. **Deferred:** Cash Flow, Client Invoices, Accounts Receivable, Payments, retention modelling, monthly periods, snapshots, approvals, probability weighting. Currency remains the app's existing AUD display — see **Company Country & Currency** next.

- [x] **Company Country & Currency (foundation)** — Constrapp is no longer hard-coded to AUD. A company stores `countryCode` (ISO 3166-1 alpha-2) + `baseCurrency` (ISO 4217) + audit stamps, set on a new **Company Settings** page (`/settings/company`, `company_admin` only) reached from the sidebar company chip or a first-run setup banner: country **suggests** a currency, the admin **confirms or overrides** it, and every existing project is listed and **pinned** to an explicit currency in the same confirmed action (projects written first, then the company; additive and idempotent; **no amount converted**). Projects store `currency` (inherited from the company base currency, overridable at creation) and `currencyLocked`. Currency **locks** on any monetary value — non-zero `project.budget`, budget lines, POs (**including draft/cancelled**), claims, supplier invoices, variations, forecast lines with a non-null input, or an established commercial baseline; Cost Codes/Contacts never lock. One shared `formatCurrency(amount, currencyCode)` (`Intl.NumberFormat`, fixed `en-AU` locale, whole units) replaced **all 77** money call sites; the old `currency()` export was **deleted** so a missed site is a build error. POs/claims/invoices/variations now snapshot the resolved project currency as **audit context** (never displayed; historical `'AUD'` never rewritten). Rules: `company_admin` may update **four company currency fields only** (`affectedKeys().hasOnly`, create/delete still blocked); the currency **ratchet** is rules-enforced once set (no currency change, no unlock); `qs` gets one narrow permission — `currencyLocked` `false`→`true` and nothing else. Lock activation is **atomic**: every monetary write engages the ratchet inside its own Firestore transaction (`hooks/projectCurrencyLock.js`), so record and lock commit or roll back together. **Client-enforced (deferred):** deciding the lock should engage, since rules cannot enumerate random-id subcollections. **No FX conversion, no mixed-currency transactions, no migration** (unconfigured companies display AUD and show the banner; nothing auto-written). **Tax is NOT in scope** — GST stays a flat Australian 10% and Company Settings warns for any non-AU country

- [x] **Client Invoices / Accounts Receivable (foundation)** — the revenue-side register, answering "what have we invoiced, what remains available to invoice, and when was it due?" Project-scoped `clientInvoices` (`CI-0001` from a company-wide counter), controlled against the **Current Contract Sum** and **approved client variations** — never against a PO, claim, or supplier. Lifecycle `draft → issued → void` (void terminal, non-empty reason required; `sent` reserved). Lines are amount-only, ex-GST, with the existing per-line tax codes; `costCodeId` is **optional** (contract revenue sits above the cost-code spine, ADR-22) and a variation line inherits a cost code only when its variation resolves to exactly one. Read-time derivation: **Issued Client Invoices**, **Available to Invoice**, per-variation invoiced/remaining, and **ageing by due date** — nothing written back to the baseline, variations, or Budget Lines. Client identity (name, legal name, ABN, email, phone, address) and payment terms are **snapshotted** at creation; the due date is suggested from the client contact's terms with the source **named in the UI**, blank when no terms exist. Over-invoicing (contract and per-variation) is **warned with an explicit acknowledgement, never blocked**. Pending client variations are not invoiceable; negative approved ones reduce the contract sum but cannot be invoiced. **First collection whose lifecycle and post-issue immutability are enforced by Firestore rules** — the intended future standard for the others. Invoice creation, number allocation, and the project-currency ratchet commit in **one transaction**. An optional authored `externalInvoiceReference` ties a record to the invoice actually issued from Xero/MYOB/QuickBooks. Lives under the **Commercial** tab (Margin | Client Invoices); the supplier tab is relabelled **Supplier Invoices**. Financial-role-only reads; deletes blocked. **No** payments, receipts, paid status, credit notes, retention, revenue recognition, printable/PDF/email output, or "Tax Invoice" labelling — company legal name and ABN do not exist, so Constrapp cannot produce a compliant Australian Tax Invoice. No migration

- [x] **Client Receipts (foundation)** — the settlement half of accounts receivable and Constrapp's **first real cash record**. Project-scoped `clientReceipts` (`CR-0001` from a company-wide counter) storing **gross cash received** — `receiptDate`, `amount`, an explicitly-chosen `paymentMethod` (never defaulted; `other` requires a description), optional bank/external references — with **embedded `allocations[]`** (`clientInvoiceId` + frozen `invoiceNumber` + `allocatedAmount`) against issued Client Invoices. `clientId`/`clientName` are **required non-empty** (rules-enforced): unlike every other counterparty link, a receipt with no client is not a record. Lifecycle `draft → posted → void` (void terminal, non-whitespace reason), **rules-enforced** with posted receipts immutable — the second collection to meet the ADR-22 standard. **Read-time derivation:** Received to Date, Remaining to Reconcile, reconciliation state (*unreconciled / partly / fully / over-reconciled*), receipt summaries, and the corrected AR ageing — **nothing written onto a Client Invoice**, which gains no balance field, no payment status, and no back-reference, so voiding a receipt restores every balance with **no reversal record**. **AR ageing corrected** to age the *remaining* balance: fully reconciled invoices leave ageing, partially reconciled ones age only their remainder, over-reconciled ones are excluded into a signed callout, and the pre-Receipts disclaimer is replaced by the limits that genuinely remain. Unallocated receipts are permitted, reported separately as money on account, and **never auto-applied** (an explicit *Allocate oldest first* action yields an editable proposal). Over-allocating an **invoice** is warned with an acknowledgement, never blocked; over-allocating the **receipt** is hard-blocked and its scalar arithmetic (`allocatedTotal + unallocatedAmount == amount`, compared in **whole cents** via `math.round`, because IEEE-754 rejects `0.10 + 0.20 == 0.30`) is **rules-enforced**. An invoice voided *after* a posted allocation surfaces as an **exception**, never auto-reversed. Counter, receipt, and the project currency ratchet commit in **one transaction**. Shared, direction-agnostic `lib/payments.js` + AR adapter `lib/clientReceipts.js`; new **Receipts** sub-view on the Commercial tab (Margin · Client Invoices · Receipts). Financial-role-only reads; deletes blocked. **⚠️ Cash is not revenue** — no GST, no tax code, no net amount; the six budget figures, Forecast, and Margin are unchanged. **No** Supplier Payments, cash flow, refunds, bank reconciliation, accounting integration, attachments, or remittance output. **Supplier invoice `paid`/`paidAt` were NOT touched** — they stay reserved and unused. No migration

Firestore security rules for all of the above are written in `frontend/firestore.rules` and published manually.

---

## Documentation Sprint — Current

Bring documentation in line with the implemented system:

- Corrected root docs (AGENT, README, PRODUCT, ROADMAP) + new CLAUDE.md
- New `docs/`: ARCHITECTURE, DATA_MODEL, FINANCIAL_WORKFLOWS, SECURITY, TESTING, DESIGN_SYSTEM, PROJECT_DECISIONS, DEPLOYMENT

---

## Known Gaps & Deferred Work

**Placeholders (screens exist, no functionality):** PULSE™, SHIELD™, and the BOQ, Documents, Photos, Timeline, and Reports project tabs. Dashboard KPIs/charts are partly static. Subcontractors shows the live contacts directory but its IQ™ scoring is a placeholder. None of these are complete. (The Forecast tab is now live — Forecast Cost to Complete foundation.)

**Deferred security hardening** (client-enforced today, server enforcement deferred — full list in [docs/SECURITY.md](docs/SECURITY.md)):

- Server-enforced lifecycle transitions and post-submission immutability
- One-open-claim race protection
- Creator ≠ approver segregation
- Supplier-scoped subcontractor access
- Counter tamper protection
- Audit logging
- Client-invoice **Available to Invoice** and per-variation limits (rules cannot
  sum sibling documents, so over-invoicing is warned, never blocked, and
  concurrent invoicing of the same remaining value is possible)
- Client-receipt **allocation integrity** — rules cannot iterate an array or sum
  sibling documents, so `allocatedTotal` vs the array sum, invoice existence/
  status/client-match, over-allocation, and concurrent allocation of the same
  balance are all unverified server-side (the *scalar* amount invariant **is**
  rules-enforced). Posting a future-dated receipt is blocked in the client only
- Company legal name / ABN / address / tax number — absent, so Constrapp cannot
  produce a compliant Australian Tax Invoice

*Note:* `clientInvoices` and `clientReceipts` are the collections whose lifecycle
transitions and post-commit immutability **are** rules-enforced — the intended
future standard for purchase orders, claims, supplier invoices, and variations.

**Other deferred foundations:** user management UI (invite, assign role/company), project edit/delete (currency is the only project field editable after creation), self-serve signup and password reset, Firebase CLI config (`firebase.json`/`.firebaserc`), Hosting, CI.

**Country-specific tax configuration** — currency display is configurable as of
the Company Country & Currency foundation, but **tax calculation is not**:
`GST_RATE` is a flat Australian 10% and every "GST 10%" label is Australian.
NZ GST 15%, ZA VAT 15%, UK VAT 20%, and US sales tax are **not** supported.
Company Settings warns about this for any non-AU country. A tax-regime foundation
must land before Constrapp can claim tax compliance in those markets.

---

## Development Order

The sequence closes the commercial-control loop first (the back half of the lifecycle is already in the schema), then completes the preconstruction side (the front half), then layers intelligence and commercially linked field features. Each item integrates through the cost-code spine.

**1. Variations** — *foundation shipped (see Completed Foundations).*
One type-discriminated `variations` collection (Client/​Supplier), cost-code spine,
approved-only read-time derivation, and a **Commitment Exposure** figure kept
separate from Committed. **Remaining (deferred to a follow-up phase):**
claim-against-variation and invoice-against-variation linkage (activating the
reserved `progressClaims.variationId` and maturing variation commitment against
claims/invoices). The foundation deliberately does not fold variations into the
canonical Committed formula until that linkage lands.

**2. Forecast Cost to Complete** — *foundation shipped (see Completed Foundations).*
Per-cost-code `forecastLines` (deterministic `costCodeId` IDs) with a single manual
input (Uncommitted Cost to Complete), read-time Forecast Final Cost / Variance to
Budget, no automatic remaining-budget default, and supplier-variation exposure kept
strictly separate from the forecast total. **Remaining (deferred):** reporting
periods, immutable monthly snapshots, prior-period comparison, and any approval
workflow — the current forecast is a living editable input until those land.

**3. Project Margin** — *foundation shipped (see Completed Foundations).*
Project Commercial Baseline + read-time margin derivation (Current Contract Sum,
Forecast Revenue, Forecast Gross Profit/Margin %, Original Planned Profit/Margin %,
Margin Movement), all ex-GST, on a new Commercial tab. **Remaining (deferred):**
cash-flow forecasting (see item 3c), manual/probability-weighted revenue forecast,
and immutable margin period snapshots.

**3a. Company Country & Currency** — *foundation shipped (see Completed Foundations).*
Company `countryCode`/`baseCurrency`, project `currency`/`currencyLocked`, a
Company Settings page with confirmed setup and existing-project pinning, the
currency ratchet, and one shared `formatCurrency` across every financial screen.
**No FX conversion** — a project reports in one currency and a currency is a label,
never a conversion. **Remaining (deferred):** server-derived lock activation and
known-code validation in rules (both need a trusted backend), per-country display
locales, **date localisation** (`formatDate` is still `en-AU`, a known limitation
for US users), self-serve company signup (the settings form is built to be reused
as a signup step), and — importantly — **country-specific tax configuration**:
this foundation makes currency *display* configurable but leaves GST a flat
Australian 10%, so selecting NZ/ZA/US/GB does **not** make Constrapp tax-compliant
there. That is the honest prerequisite for genuinely serving those markets.

**3b-i. Client Invoices / Accounts Receivable** — *foundation shipped (see Completed
Foundations).* Client-side billing controlled against the Current Contract Sum and
approved client variations, with read-time Available to Invoice, per-variation
balances, and ageing by due date. **Remaining (deferred):** client retention,
credit notes, client progress claims, revenue recognition, printable/PDF/email
output, company legal & tax identity (the prerequisite for a compliant Australian
Tax Invoice), and contract-level payment terms on the commercial baseline.

**3b-ii. Client Receipts** — *foundation shipped (see Completed Foundations).*
Cash received from clients, allocated against issued client invoices, turning
"issued, not yet reconciled" into a real receivables balance. Balances are
**derived at read time** from receipt records — no payment field was ever
reserved on the client invoice (ADR-22), and none was added (ADR-23).

**3b-iii. Supplier Payments** — *next.*
The money-out mirror, reusing the shared `lib/payments.js` foundation unchanged:
project-scoped `supplierPayments` (`SP-0001`), embedded allocations against
**posted supplier invoices' `payableTotal`** (*not* `grossTotal` — retention is
withheld and is not payable on that invoice), read-time **Paid to Date** and
**Remaining Payable**, and AP ageing on the remaining balance.
**⚠️ The reserved supplier-invoice `paid` status and `paidAt` field will be
DEPRECATED IN PLACE, not activated** — payment state derives from allocations,
and activating them would create a second, contradictory source of payment truth.
That code and documentation change belongs to this branch; **as of the Client
Receipts branch nothing about them has changed** — they remain reserved, never
written, and still counted inertly in `SI_COUNTING_STATUSES` (no document can
hold that status). Retention release remains unmodelled.

**3c. Cash-flow Forecasting**
Cash-flow curves close the current project-control loop. **Actual Cash In now
exists** (posted Client Receipts: amount, `receiptDate`, project, client,
currency); **actual Cash Out does not** until Supplier Payments ship, so this
item is blocked on 3b-iii — building it sooner would present forecast timing as
actual cash, the exact dishonesty the receipts foundation removed. It must
consume the **total transaction amount** on the **transaction date** (never
`createdAt`/`postedAt`), keep the allocated/unallocated split available, and
never sum across currencies.

**4. BOQ and Estimating**
Opens the preconstruction side: a Bill of Quantities against cost codes, with rates/margin/overheads producing an estimate that transfers to an approved budget.

**5. Tender Packages, Subcontractor Invitations, and Bid Levelling**
Tender packages built from the BOQ, subcontractor invitations, and bid comparison/levelling by cost code, feeding award → commitment.

**6. Manual QS Takeoff connected to BOQ quantities**
Measured quantities populate BOQ quantity lines by cost code. Manual takeoff must exist before Quant™ AI — the AI accelerates an established pipeline rather than inventing one.

**7. Credit Notes and Retention Release**
Supplier credits (`docType`/`adjustsInvoiceId`) and retention release. Supplier
payments themselves moved forward to item 3b-iii, alongside Client Receipts,
because Cash Flow depends on them. **The reserved `paid`/`paidAt` fields are for
deprecation, not activation** — see 3b-iii.

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
