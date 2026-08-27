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
| Backend | Firebase **client SDK only** (Auth, Firestore, Cloud Storage). No Cloud Functions and no server code. `frontend/firebase.json` **does exist** — it points the Firestore **and Storage** emulators at `firestore.rules` / `storage.rules` for the automated rules suites. There is still **no `.firebaserc`**, no hosting config, and no deploy pipeline: both rules files are published manually |
| Font | Sora (Google Fonts), fallback DM Sans |

## Repository Structure

The app lives entirely under `frontend/`. Root holds documentation; `docs/` holds
detailed docs plus design-reference assets (prototype `.jsx`, screenshots, Word doc)
that must not be moved or renamed.

```
frontend/
  firestore.rules   Firestore security rules (published manually — see docs/DEPLOYMENT.md)
  storage.rules     Cloud Storage security rules — the SECOND trust boundary
                    (published manually; see docs/DEPLOYMENT.md)
  src/
    components/     UI primitives: Card, Btn, Badge, Stat, ProgBar, PageHeader, ProtectedRoute
    layouts/        AppShell (Sidebar + TopBar), AuthLayout, ProjectDetailLayout,
                    ProjectCommercialLayout (Commercial sub-nav:
                    Margin | Client Invoices | Client Receipts | Supplier Payments
                    | Cash Flow),
                    ProjectDocumentsLayout (Documents sub-nav:
                    Drawings | General Documents)
    pages/          Top-level routes; pages/project/ holds Project Detail tabs;
                    pages/project/documents/ holds the Documents & Drawings
                    modals, viewer and shared class strings
    hooks/          useAuth, useProfile, useCompany, useProjects, useProject,
                    useCostCodes, useContacts, useBudgetLines, usePurchaseOrders,
                    useProgressClaims, useSupplierInvoices, useSupplierCreditNotes,
                    useClientInvoices,
                    useClientReceipts, useSupplierPayments, useVariations,
                    useBoqItems, useTenderPackages, useTenderBids,
                    useForecastLines, useProjectCommercial, useCashFlowLines,
                    useProjectActivities (project programme — NON-financial),
                    useStorageUpload (the ONLY place file bytes are written),
                    useDrawings, useDrawingRevisions, useProjectDocuments,
                    useRfis (RFI register — NON-financial; per-project counter)
    lib/            firebase.js, formatters.js, currency.js, nav.js, projectTabs.js,
                    purchaseOrders.js, progressClaims.js, supplierInvoices.js,
                    supplierCreditNotes.js (reduction records vs posted supplier
                    invoices), clientInvoices.js,
                    payments.js (shared, direction-agnostic),
                    clientReceipts.js, supplierPayments.js, variations.js,
                    tenders.js (packages, bids, validity gate, comparison, award),
                    forecast.js, margin.js, cashFlow.js (pure monthly cash
                    aggregation + forecast layers), contacts.js, boq.js (pure
                    BOQ arithmetic + read-time budget comparison),
                    projectTimeline.js (programme domain logic — no financial
                    arithmetic), timelineGantt.js (Gantt geometry only),
                    files.js (file types, size ceilings, deterministic storage
                    paths), drawings.js, projectDocuments.js (pure domain logic),
                    rfis.js (RFI lifecycle, reference shape, overdue/response
                    derivation — NON-financial)
  tests/unit/       Unit tests for pure lib/ logic (npm run test:unit — no emulator)
  tests/rules/      Firestore AND Storage security-rules suites
                    (npm run test:rules — starts both emulators)
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
- **`users/{uid}` is CLIENT-READ-ONLY (ADR-27).** A user may read their own profile; `create`, `update` and `delete` are all blocked by rules. No app code writes it — the only `users/` reference in `frontend/src` is the read in `hooks/useProfile.jsx`. Do not add a profile-write path, a "harmless field" allow-list, or admin user management: membership is **provisioned out of band**, and signup/invites/user administration require a trusted backend (Admin SDK), never the browser
- Check `frontend/firestore.rules` before adding any new collection or field; rules are published manually via the Firebase console (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
- `frontend/firebase.json` exists **only** to point the Firestore and Storage emulators at `firestore.rules` / `storage.rules` for the automated Security Rules suites (`npm run test:rules`). There is **no `.firebaserc`**, no hosting, and no functions config — do not claim or assume Firebase CLI/Hosting deployment, and never run `firebase deploy`. Both rules files are still published manually
- **Run `npm run test:rules` before any `firestore.rules` OR `storage.rules` change is published** (see [docs/TESTING.md](docs/TESTING.md) §0). One command starts both emulators and runs both suites

## Cloud Storage Conventions

- **`frontend/storage.rules` is a trust boundary, exactly like `firestore.rules`.** Client-side file validation in `lib/files.js` is a convenience mirror and never a control
- All Storage access goes through `hooks/useStorageUpload.jsx` — never call `firebase/storage` directly from a page
- **The path is the authority.** Object paths are deterministic and company-namespaced, built by `lib/files.js` from Firestore document IDs; every object is named `original.{ext}`. The uploaded filename is metadata only, and `customMetadata` is never consulted for authorisation
- **Upload order is Storage FIRST, Firestore SECOND.** An orphaned object is preferable to a register row pointing at bytes that never arrived
- **Objects are create-only.** `update` and `delete` are denied on every path, so a retry must mint a new document ID and a new path. Orphans are accepted and documented; there is no cleanup path without a trusted backend
- **Never persist `getDownloadURL()` output.** A download URL is a bearer link; mint it on demand and discard it

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
                                             clientInvoices, clientReceipts, supplierPayments,
                                             supplierCreditNotes, tenderPackages)
companies/{companyId}/projects/{projectId}   name, status, budget, startDate, location, progress,
                                             currency (ISO 4217 — the display authority),
                                             currencyLocked (one-way ratchet)
  …/budgetLines/{lineId}                     costCodeId, costCodeName, budgeted, notes
  …/boqItems/{itemId}                        measured Bill of Quantities: itemNumber (user label, NO counter),
                                             section, description, quantity (≥ 0), unit (prefilled from the
                                             cost code, editable), rate (number ≥ 0 | null — NULL MEANS
                                             UNPRICED, never 0), amount (DERIVED quantity × rate, null while
                                             rate is null — the whole-cent invariant is RULES-ENFORCED),
                                             REQUIRED costCodeId + costCodeName snapshot, status active|void
                                             (LIFECYCLE RULES-ENFORCED; void terminal, reasoned), currency,
                                             revision 1 — feeds NO financial figure; BOQ-vs-budget comparison
                                             derived read-time on the BOQ page only (lib/boq.js, ADR-32);
                                             reads restricted to financial roles
  …/purchaseOrders/{poId}                    poNumber, status, supplierName, lineItems[], subtotal, gst, total
  …/progressClaims/{claimId}                 claimNumber, status, poId, cumulative lineItems[], retention,
                                             claimed/approved subtotal-gst-total
  …/supplierInvoices/{invoiceId}             invoiceNumber (SI-####), status, source, poId, progressClaimId,
                                             ex-GST lineItems[] w/ per-line taxCode, retention, subtotal-gst-net-total —
                                             accounts payable; reads restricted to financial roles
  …/supplierCreditNotes/{creditNoteId}       creditNumber (SCN-####), status draft|posted|void, FROZEN target
                                             (supplierInvoiceId + invoiceNumber/supplierInvoiceNumber/
                                             supplierId/supplierName/currency snapshots — core-preserved),
                                             supplierCreditReference, creditDate ('YYYY-MM-DD'), REQUIRED
                                             non-whitespace reason, ex-GST lineItems[] w/ per-line taxCode +
                                             REQUIRED costCodeId (from the target invoice's lines; NO
                                             poLineIndex), subtotal/gstTotal/grossTotal (whole-cent header
                                             invariant rules-enforced) — REDUCTION records against exactly
                                             ONE posted, ZERO-RETENTION supplier invoice; LIFECYCLE + POSTED
                                             IMMUTABILITY RULES-ENFORCED, and rules GET() THE TARGET (exists,
                                             posted, zero retention, supplier+currency match, grossTotal ≤
                                             payableTotal); cumulative cap app-enforced only (DC25); posted
                                             valid-target credits reduce Invoiced/Actual by cost code and the
                                             invoice's remaining payable AT READ TIME — the invoice is NEVER
                                             written; reads restricted to financial roles
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
  …/tenderPackages/{packageId}               tenderNumber (TP-####), status draft|issued|awarded|cancelled, name,
                                             scope (free text), costCodes[] {costCodeId, costCodeName} (≥1),
                                             closingDate (INFORMATIONAL ONLY — never blocks a bid), awardedBidId +
                                             awardedBidderName snapshot, awardNotes, cancelReason — NO amounts, NO
                                             currency, NO awardTotal; LIFECYCLE + ISSUED-SCOPE FREEZE + AWARD
                                             INTEGRITY (bid exists · same package · received · name snapshot ·
                                             single award, via get()) ARE RULES-ENFORCED; award creates NO PO and
                                             changes NO financial figure; reads restricted to financial roles
  …/tenderBids/{bidId}                       tenderPackageId + frozen tenderNumber, status received|void (no draft —
                                             a bid is a transcription), bidderContactId + frozen bidderName
                                             (contact existence/type rules-verified via get()), bidDate, bidderRef,
                                             ex-GST lineItems[] {costCodeId, costCodeName, description, amount}
                                             (NO GST fields, NO stored bidTotal — totals derive through the
                                             assessBid validity gate; malformed bids fail safely), exclusions,
                                             notes — bid writes permitted ONLY while the package is issued (bids
                                             freeze on award/cancel, rules-enforced); a bid is currency-lock
                                             evidence; reads restricted to financial roles (competitor pricing)
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
  …/activities/{activityId}                  PROJECT PROGRAMME (NON-FINANCIAL): name, description, isMilestone,
                                             status not_started|in_progress|on_hold|completed|cancelled,
                                             DATE-ONLY 'YYYY-MM-DD' plannedStart/plannedFinish (finish INCLUSIVE,
                                             finish >= start rules-enforced) + nullable actualStart/actualFinish,
                                             INTEGER percentComplete 0-100 (MANUALLY AUTHORED, unverified),
                                             optional responsibleContactId + frozen responsibleName (a CONTACT,
                                             never a user — ADR-27), OPTIONAL costCodeId + frozen costCodeName
                                             (the commercial spine link — a JOIN KEY only, no derivation),
                                             sortOrder (NOT unique), notes, cancelReason/cancelledAt/cancelledBy —
                                             duration/overdue/horizon/summary all derived read-time, never stored;
                                             LIFECYCLE IS RULES-ENFORCED but DELIBERATELY NOT FORWARD-ONLY
                                             (backwards correction allowed — an explicit ADR-11 departure);
                                             cancelled terminal, delete blocked; NO currency, NO counter,
                                             NO transaction, NO currency ratchet; reads company_admin/
                                             project_manager/qs, writes company_admin/project_manager ONLY
                                             (QS READ-ONLY); WRITES NO FINANCIAL VALUE ANYWHERE
  …/counters/rfis                            { next } — the ONLY PROJECT-SCOPED counter: every project numbers
                                             its RFIs from RFI-0001 independently (financial counters stay
                                             company-wide); same financial-role audience; delete blocked
  …/rfis/{rfiId}                             RFI — REQUEST FOR INFORMATION (NON-FINANCIAL EVIDENCE RECORD,
                                             ADR-33): rfiNumber (RFI-####, per-project counter, allocated in
                                             the create transaction — NO currency ratchet), status
                                             draft|open|answered|closed|cancelled (FORWARD-ONLY, NO REOPEN,
                                             answered CANNOT be cancelled, closed/cancelled terminal — ALL
                                             RULES-ENFORCED), title, question, AUTHORED raisedDate
                                             ('YYYY-MM-DD'), raisedByName (client-authored snapshot of the
                                             creator's OWN profile name — NOT rules-verified, DC27), ZERO-OR-
                                             ONE scalar reference (referenceType none|drawing|document;
                                             drawing REQUIRES referenceDrawingId + referenceRevisionId, both
                                             EXISTENCE-VERIFIED by rules via the nested revisions path so the
                                             RFI stays pinned to the exact sheet issued; document requires
                                             referenceDocumentId, existence-verified; frozen referenceLabel +
                                             referenceRevisionCode snapshots; NO storagePath, NO download
                                             URL), OPTIONAL costCodeId + frozen costCodeName (JOIN KEY ONLY,
                                             no derivation), assignedToContactId + frozen assignedToName (a
                                             CONTACT, never a user — ADR-27), dueDate (>= raisedDate) — both
                                             REQUIRED TO RAISE, optional on a draft; the QUESTION BLOCK
                                             FREEZES AT RAISE, the MANAGEMENT BLOCK (assignee/due) FREEZES AT
                                             ANSWER; answer + AUTHORED answerDate (>= raisedDate) written by
                                             the answer transition only; closeOutNote; raised/answered/
                                             closed/cancelled At/By stamps; overdue, days open, response
                                             days, grouping, summary ALL derived read-time; delete blocked;
                                             reads AND writes company_admin/project_manager/qs ONLY;
                                             WRITES NO FINANCIAL VALUE ANYWHERE
  …/retentionReleases/{releaseId}            releaseNumber (RR-####, company counter), status draft|posted|void,
                                             docType 'retention_release', supplierInvoiceId (SCALAR — rules get()
                                             it and verify it is POSTED), invoiceNumber/supplierInvoiceNumber/
                                             supplierId(null ok)/supplierName snapshots, previouslyReleasedAmount
                                             (DERIVED snapshot, never user-authored), amount (ex-GST, > 0),
                                             gstAmount (= cumulative rounding delta), releaseTotal, releaseDate
                                             ('YYYY-MM-DD' — the AGREED date, NOT a DLP/entitlement/payment-due
                                             date), reason (non-whitespace), notes — the AUTHORISATION that makes
                                             already-withheld retention PAYABLE. NOT an invoice, tax invoice,
                                             credit note, or payment; no costCodeId (cash, not cost); NO paid
                                             status. LIFECYCLE IS RULES-ENFORCED (draft→posted→void terminal),
                                             as are the target invoice, the PER-DOCUMENT cap, and the EXACT GST
                                             formula; the CUMULATIVE cap is client-only (DC24); delete blocked;
                                             reads restricted to financial roles
  …/commercial/baseline                      single doc (id = "baseline"): originalContractValue, originalApprovedBudget
                                             (number|null), contract start/completion (Timestamp|null), clientId/clientName
                                             snapshot, notes — the ONLY stored Project Margin inputs; Current Contract Sum,
                                             Forecast Revenue, Forecast Gross Profit, Margin %, Margin Movement all derived
                                             at read time (lib/margin.js); ex-GST; reads restricted to financial roles
```

## Financial Invariants (mandatory)

- **Purchase Orders, Progress Claims, Supplier Invoices, Variations, and Forecast Lines never write financial values onto Budget Lines.** Committed, Claimed, Actual, Invoiced, the variation figures (Approved Supplier Variations / Commitment Exposure), and every forecast figure (Cost to Complete, Forecast Final Cost, Variance to Budget) are derived at read time from PO, claim, invoice, and variation documents (`lib/purchaseOrders.js`, `lib/progressClaims.js`, `lib/supplierInvoices.js`, `lib/variations.js`, `lib/forecast.js`) — never stored back. **Forecast Lines store only the manual `uncommittedCostToComplete` (number|null) + notes; supplier-variation exposure is shown separately and is never added into Forecast Final Cost.** Approved variations count only at read time and never mutate POs, claims, or invoices; **Commitment Exposure is separate from Committed** (variation commitment does not yet mature against claims/invoices). Committed now means *remaining open commitment* (PO line − posted/paid invoiced-to-date); Actual counts a posted invoice instead of its source claim (read-time exclusion — the claim is never mutated). **BOQ items feed no financial figure at all** — the BOQ is measurement provenance; its only derived output is the read-time BOQ-vs-budget comparison on the BOQ page, never stored (ADR-32); a BOQ `rate: null` means UNPRICED (never 0) and its `amount` is derived quantity × rate (whole-cent, rules-enforced), null while unpriced
- Document numbers (`PO-0001`, `PC-0001`, `SI-0001`, `CV-0001`, `SV-0001`, `CI-0001`, `CR-0001`, `SP-0001`, `SCN-0001`) come from company-wide counters incremented in the same transaction as the document write
- **Supplier Credit Notes are the reduction fact — never a mutation of the invoice and never cash.** A credit note targets exactly **one posted, zero-retention** supplier invoice (target frozen at creation; both enforced by rules via a `get()` on the target) and **nothing is ever written onto that invoice** — no credited total, no status change, no back-reference. Posted **valid-target** credits reduce Invoiced/Actual by cost-coded ex-GST lines (signed, never clamped) and the invoice's Remaining Payable by `grossTotal` — all at read time (`lib/supplierCreditNotes.js`), so voiding restores everything with no reversal document. **Actual Cash Out stays payment-only**, and **Remaining Committed is never re-opened by a credit** (no `poLineIndex` on credit lines). Over-crediting beyond the target's `payableTotal` is **HARD-BLOCKED** in the app (cumulative; rules enforce only the single-document cap — Deferred Control 25). A posted credit counts **only while it passes the central read-time validity gate** (`creditTargetException`): target still valid AND stored headers reconciling to its own `lineItems` with correct per-line GST, positive amounts, and cost codes present on the target — rules cannot iterate an array, so this is the only thing standing between a rules-valid forged document and an unbounded silent cost reduction. Anything failing counts **zero** on BOTH the payable and cost sides, is **never clamped**, and surfaces as an exception — cost stays visible (ADR-31). A failed credit-note subscription is **unknown, never zero**: payable figures render unavailable and payment actions are disabled
- **Client Invoices are revenue-side and never touch a cost figure.** They never write onto Budget Lines, the Commercial Baseline, or Variations; `Issued Client Invoices`, `Available to Invoice`, per-variation invoiced/remaining, and receivables ageing are all derived at read time (`lib/clientInvoices.js`). Only **approved** client variations are invoiceable; **negative** approved ones reduce the Current Contract Sum but cannot be invoiced. Over-invoicing is **warned, never blocked** — the limit cannot be rules-enforced. **There is still no payment state ON THE INVOICE**: no `paid`/`partially_paid` status and no payment field. Since Client Receipts shipped, *Received to Date*, *Remaining to Reconcile*, and the reconciliation state (*unreconciled / partly / fully / over-reconciled*) are **derived at read time from posted receipt allocations** and are **never written onto an invoice** — which is why voiding a receipt restores balances with no reversal record. The words *paid* and *unpaid* must never be used as an invoice status. Constrapp does **not** produce a compliant Australian Tax Invoice (no company legal name/ABN) — never label output "Tax Invoice"
- **Client Receipts are cash, not revenue.** A receipt stores gross cash received — **no GST, no tax code, no net amount** — and feeds **no** budget figure, forecast figure, or margin figure. Allocations are **embedded** on the receipt and **nothing is ever written onto a Client Invoice** (no balance, no payment status, no back-reference). Over-allocating the *receipt* is hard-blocked and its scalar arithmetic is rules-enforced (in whole cents); over-allocating an *invoice* is **warned, never blocked** — rules cannot sum sibling documents. Unallocated receipts are permitted, reported separately, and **never auto-applied**. Cash Flow must consume `receiptDate`, never `createdAt`/`postedAt`
- **Supplier Payments are cash out, not cost.** A payment settles an Actual cost that a **posted** supplier invoice already recognised, so it feeds **no** budget figure, forecast figure, or margin figure. Allocations reconcile against `supplierInvoice.payableTotal` — **never `grossTotal`** — because retention withheld is not payable, and a payment never writes, clears, or reduces `retention`/`retentionGst`/`retentionTotal` — those stay immutable for the life of the invoice. **Retention becomes payable only through a posted Retention Release** (ADR-30), which raises the derived payable basis and is then settled by an ordinary payment; a release is not itself cash. Allocations are **embedded** on the payment and **nothing is ever written onto a Supplier Invoice** (no balance, no payment status, no back-reference). **`SI_STATUS.PAID` and `paidAt` are DEPRECATED IN PLACE, never activated** — no path writes them and `SI_TRANSITIONS` reaches `paid` from nowhere; `paid` stays in `SI_COUNTING_STATUSES` deliberately so a direct-SDK-forged document cannot vanish from Invoiced/Actual (ADR-24). Over-allocating the *payment* is hard-blocked and its scalar arithmetic is rules-enforced (whole cents); over-reconciling an *invoice* is **warned, never blocked**. Unallocated payments are permitted, reported separately, and **never auto-applied** — and their **full amount** is still actual Cash Out. Cash Flow must consume `paymentDate`, never `createdAt`/`postedAt`
- **Cash Flow consumes cash records and writes only its own timing lines — gross cash only.** Every figure is derived at read time in `lib/cashFlow.js` across three layers: **actual** (posted Client Receipts / Supplier Payments via `cashInRows()`/`cashOutRows()`), **automatic near-term forecast** (positive remaining on issued Client Invoices at gross, and on posted Supplier Invoices at `payableTotal`, timed by `dueDate` **month**), and **manual longer-term timing** (`cashFlowLines`). It consumes the **total transaction `amount`** (never `allocatedTotal`) on the **transaction date** (`receiptDate`/`paymentDate`, never `createdAt`/`postedAt`) and groups by `date.slice(0, 7)`. **THE BOUNDARY RULE: months before the current month are ACTUAL ONLY** — no forecast amount, automatic or manual, ever lands in a past month, which is what makes actual-vs-forecast provably non-double-counting. Past-due and undated invoice balances are **never guessed into a month**; they are reported untimed. Cash Flow **writes only `cashFlowLines`** — no receipt, payment, invoice, PO, claim, variation, forecast line, budget line, or baseline is ever mutated. A timing line stores an expected **gross** `amount` plus, separately, the **ex-GST `sourceAmountExGst`** it represents (completeness only — the two bases are never added together); invoice source types are **excluded** so an invoice balance can never be timed twice; approved-claim cost sits **inside** Remaining Committed and is never an additive second denominator. The cumulative position starts at **zero** and is net project cash movement, **never presented as a bank balance** (no bank account, opening balance, financing, retention release, or GST/BAS remittance is modelled — each is warned about, never silently adjusted). **A failed subscription is reported as unavailable, never as a genuine zero.**
- **Tenders are a decision trail, not a financial document set.** Tender packages hold scope (≥1 cost codes + free text) and **no amounts**; bids hold ex-GST per-cost-code lines with **NO stored `bidTotal`** and packages store **NO `awardTotal`** — rules cannot sum an array, so a stored header total would be forgeable (the Credit Notes header-vs-lines lesson). Every figure derives through the `lib/tenders.js → assessBid` **validity gate**: a bid with any malformed line is invalid whole — total `null`, never a partial sum, never $0 — and is excluded from comparison and award. **An award creates NO Purchase Order and changes NO financial figure** (no budget, committed, claimed, actual, invoiced, forecast, margin, or cash-flow effect); the Awarded Bid Value derives from the rules-frozen awarded bid and is **never netted against POs** (no Award → PO linkage exists). Comparison variance uses **Approved Budget − Bid** (positive = under budget) and shows *no budget* rather than comparing against zero. The **closing date is informational only** — nothing blocks a late bid, anywhere. Tender bids (incl. void) are currency-lock evidence; packages never lock
- **Retention Releases are an authorisation, not a document type of any other kind.** A Retention Release makes retention **already withheld** on a posted supplier invoice **payable**. It is **not** a supplier invoice, tax invoice, credit note, or payment, carries **no cost code**, and moves **no cash** — only a posted Supplier Payment does. Held is derived from posted invoices, released from **posted** releases, and paid stays derived from payment allocations; **nothing is written onto a supplier invoice** and `retention`/`retentionGst`/`retentionTotal` are immutable for its life. Partial releases are supported and their GST is the **cumulative rounding delta** (`round((prev+amount)×10%) − round(prev×10%)`), which telescopes exactly to `retentionGst`/`retentionTotal` — never each release rounding its own share. Rules enforce the target invoice, the **per-document** cap, and the exact GST formula; the **cumulative** cap is client-only and **hard-blocked in the UI** (no acknowledgement override) — see DC24. **Retention *paid* is not derivable and must never be reported**, and a failed release read must never be treated as "nothing released" (ADR-30)
- PO line items freeze once a PO leaves `draft`; claim amounts freeze once submitted; approved amounts are frozen forever; supplier invoices freeze once `posted` (and posted invoices cannot be cancelled/unposted)
- Lifecycles are forward-only; financial documents are never deleted — cancellation/rejection is a status change
- One open Progress Claim per PO at a time; claims are cumulative (claimed-to-date per PO line)
- POs snapshot `supplierName` from the chosen contact at write time (`supplierId` is the live link); contact edits or archiving never rewrite issued documents, and POs/claims with `supplierId: null` (pre-Contacts) render from the snapshot and are never backfilled
- **One currency per project; a currency is a label, never a conversion.** There is **no FX conversion**, no exchange rates, and no mixed-currency transactions. Money is formatted **only** through `formatCurrency(amount, currencyCode)` in `lib/formatters.js` with the currency resolved by `lib/currency.js` (`project.currency` → `company.baseCurrency` → `AUD`) — never hard-code a currency code or a `$`. Project currency **locks** once the project holds any monetary value (non-zero `budget`, budget lines, POs incl. draft/cancelled, claims, invoices, receipts, **supplier payments (incl. draft/void)**, variations, non-null forecast inputs, established baseline); Cost Codes and Contacts never lock. The lock *condition* is client-enforced (rules cannot enumerate subcollections); the *ratchet* is rules-enforced once set (ADR-21)
- **Currency is not tax.** `GST_RATE` remains a flat Australian 10% and every "GST 10%" label is Australian. Selecting another country changes the currency label only — never describe Constrapp as tax-compliant outside Australia
- **The Project Timeline writes no financial value, in either direction.** Activities never write onto Budget Lines, Forecast Lines, Cash Flow Lines, the Commercial Baseline, Progress Claims, POs, Supplier/Client Invoices, or Variations, and never touch `projects/{projectId}.progress`. `percentComplete` is **manually authored and unverified** — it is never derived from dates, from child tasks, or from Progress Claims, and it feeds **no** budget, forecast, margin or cash figure. A claim is a supplier's cumulative dollar claim against a PO line; an activity percentage is physical progress on a programme line — deriving either from the other would create a second source of financial truth (ADR-23/ADR-24). The optional `costCodeId` is a **join key reserved for a future read-time derivation** (`delay → forecast impact`), never an authored commercial value (ADR-29)
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
