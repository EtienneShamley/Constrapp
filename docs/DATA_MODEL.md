# Firestore Data Model

Current, implemented schema. Financial semantics and formulas:
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Access control:
[SECURITY.md](SECURITY.md).

## Hierarchy

```
users/{uid}
companies/{companyId}
  costCodes/{costCodeId}
  contacts/{contactId}
  counters/{counterId}                 (purchaseOrders, progressClaims, supplierInvoices,
                                        variationsClient, variationsSupplier)
  projects/{projectId}
    budgetLines/{lineId}
    purchaseOrders/{poId}
    progressClaims/{claimId}
    supplierInvoices/{invoiceId}
    variations/{variationId}
```

`users/` is the only top-level collection besides `companies/`. Everything else
is company-scoped for multi-tenancy. All money amounts are AUD numbers; line and
budget amounts are **ex-GST** unless a field name says otherwise.

## users/{uid}

Document ID = Firebase Auth UID. Created manually today (no signup/invite flow).

| Field | Type | Notes |
|---|---|---|
| `name` | string | Preferred over Auth displayName in the UI |
| `email` | string | |
| `role` | string | `super_admin` \| `company_admin` \| `project_manager` \| `qs` \| `subcontractor` \| `client` |
| `companyId` | string | Links the user to their company — the multi-tenancy anchor; security rules `get()` this document |
| `avatarInitials` | string | Optional; falls back to initials derived from name/email |

## companies/{companyId}

Read-only from the client (rules block all client writes). Only `name` is read
by the app today; other fields (e.g. `createdAt`, `plan`) are incidental.

## companies/{companyId}/costCodes/{costCodeId}

Company-wide taxonomy shared by every project (see
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md)).

| Field | Type | Notes |
|---|---|---|
| `code` | string | e.g. `03-100`; list is ordered by `code` |
| `name` | string | e.g. `Concrete Slab` |
| `category` | string | Optional |
| `unit` | string | Optional, e.g. `m³` |
| `isActive` | boolean | Deactivate instead of delete (deletes are blocked by rules) |
| `createdAt` / `createdBy` | timestamp / uid | |

Budget lines, PO lines, and claim lines all reference cost codes by
`costCodeId` and denormalise a display string `costCodeName`
(`"03-100 — Concrete Slab"`) at write time, so renames don't rewrite history.

## companies/{companyId}/contacts/{contactId}

Company-wide directory of the businesses and individuals the company deals
with. One shared collection — a contact can hold several types at once (the
same entity is often both supplier and subcontractor). The Subcontractors page
is a filtered view of this collection. Reads are restricted to internal
financial roles (third-party PII — see [SECURITY.md](SECURITY.md)).

| Field | Type | Notes |
|---|---|---|
| `entityType` | string | `organisation` \| `individual` |
| `contactTypes` | array | ≥ 1 of `supplier`, `subcontractor`, `consultant`, `client`, `other` |
| `legalName` | string | Required for organisations |
| `tradingName` | string | Optional (organisations) |
| `firstName` / `lastName` | string | Required for individuals |
| `displayName` | string | Denormalised: `tradingName \|\| legalName` (org) or `firstName lastName` (individual) — the string POs snapshot |
| `nameLower` | string | `displayName` lower-cased — list ordering and search |
| `abn` | string | Optional; digits only; checksum-validated (blocked if invalid) when `country` is `AU` |
| `country` | string | Default `AU` |
| `email`, `phone` | string | Organisation-level |
| `address` | map | `{ street, suburb, state, postcode }` — all optional |
| `trades` | array | Free-text trade/category tags, e.g. `['Concrete']` |
| `paymentTerms` | map \| null | `{ days, basis: 'invoice' \| 'eom' }` — stored only; unused by calculations until invoices |
| `gstStatus` | string | `unknown` (default) \| `registered` \| `not_registered` — **not** connected to PO/claim GST math |
| `notes` | string | |
| `people` | array | Embedded contact people (organisations only) — see below |
| `primaryPersonId` | string \| null | Points at a `people[].id`; the only primary indicator |
| `projectAssignments` | array | Embedded project assignments — see below. Missing on contacts created before this field existed ⇒ unassigned |
| `projectIds` | array | **Derived** from `projectAssignments` (deduped `projectId`s) in the same write — membership filters and future `array-contains` queries; never edited directly |
| `isActive` | boolean | Archive flag — archive/reactivate instead of delete (deletes blocked by rules) |
| `externalRefs` | map | Empty today; reserved for accounting-system contact IDs (Xero/MYOB/QuickBooks) |
| `createdAt` / `createdBy` | timestamp / uid | |
| `updatedAt` / `updatedBy` | timestamp / uid | Contacts are editable, unlike frozen financial documents |

Each embedded person: `{ id, name, jobTitle, email, phone, notes }` — `id` is a
client-generated stable UUID. People are embedded (not a subcollection) for the
same reasons as PO line items (ADR-6): few per organisation, always read and
written with their parent, no independent query need yet.

Each project assignment:
`{ projectId, trade, projectRole, scope, status, notes }` — at most one per
`projectId` (normalisation dedupes; first wins). Defaults on creation:
`status: 'active'`, all other fields `''`; only membership (`projectId`) is
editable in the UI today — the remaining fields are reserved for future
project-specific detail and are preserved through every save. Assignments are
**administrative**, not financial: they never alter POs or claims (which stay
self-contained via their `supplierId`/`supplierName` snapshots), removing one
touches nothing else, and no `projectName` snapshot is stored — names resolve
live from the projects collection (projects can't be deleted; every contact
reader can read projects). Contacts predating these fields are simply
unassigned — **no migration or backfill**; they acquire the fields on their
next save. Embedding (not a `contactAssignments` subcollection) follows ADR-16.

## companies/{companyId}/counters/{counterId}

Company-wide sequential numbering. Documents: `purchaseOrders`, `progressClaims`,
`supplierInvoices`, `variationsClient`, `variationsSupplier`.

| Field | Type | Notes |
|---|---|---|
| `next` | number | The next number to assign. Read and incremented in the **same transaction** as the numbered document's creation, so concurrent users never share a number. Missing counter ⇒ starts at 1 |

Numbers render as `PO-0001` / `PC-0001` / `SI-0001` / `CV-0001` / `SV-0001`
(zero-padded to 4).

## companies/{companyId}/projects/{projectId}

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `status` | string | UI labels: `Planning`, `In Progress`, `Backlogged`, `On Hold`, `Completed` |
| `budget` | number | Headline project budget (display only — not reconciled against budget lines) |
| `startDate` | Timestamp \| null | |
| `location` | string | |
| `progress` | number | 0–100, manually set at creation |
| `createdAt` / `createdBy` | timestamp / uid | |

## …/projects/{projectId}/budgetLines/{lineId}

One allocation of project budget against a company cost code.

| Field | Type | Notes |
|---|---|---|
| `costCodeId` | string | → company cost code |
| `costCodeName` | string | Denormalised display string |
| `budgeted` | number | **Stored** — the allocation (ex-GST) |
| `invoiced` | number | Written once as `0` at creation and **never updated — ignored by the UI.** Invoiced is derived at read time from supplier invoices (see below), matching Committed/Actual — nothing writes this field |
| `committed` | number | Written once as `0` at creation and **never updated — ignored by the UI** |
| `actual` | number | Written once as `0` at creation and **never updated — ignored by the UI** |
| `notes` | string | |
| `createdAt` / `createdBy` | timestamp / uid | |

### Stored vs derived

Only `budgeted` is an authoritative stored value.
**Committed, Claimed, Actual, and Invoiced are all derived at read time** —
computed in the browser from the project's purchase orders, progress claims, and
supplier invoices (`maturedCommittedByCostCode`, `actualClaimsByCostCode` +
`invoicedByCostCode`, `claimedPendingByCostCode`, `invoicedByCostCode` in `lib/`),
keyed by `costCodeId`. Nothing ever writes these onto budget lines; the
`committed`/`actual`/`invoiced` fields exist only as vestigial zeros from
creation. A PO or invoice can hit a cost code that has no budget line — the
Budget page shows it as a warning row rather than hiding it. Exact formulas
(including Committed as *remaining open commitment*): [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).

## …/projects/{projectId}/purchaseOrders/{poId}

Lifecycle and semantics: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).

| Field | Type | Notes |
|---|---|---|
| `poNumber` | string | `PO-0001` — from the company-wide counter |
| `status` | string | `draft` \| `pending_approval` (reserved) \| `sent` \| `closed` \| `cancelled` |
| `supplierName` | string | Snapshot of the contact's `displayName` at write time — permanently denormalised; contact renames never rewrite issued documents. Free text on POs created before the Contacts module |
| `supplierId` | string \| null | → company contact. Null on POs created before the Contacts module — such POs render from `supplierName` and are never backfilled; code must never assume `supplierId` resolves |
| `description`, `notes` | string | |
| `lineItems` | array | **Embedded**; frozen once the PO leaves draft |
| `subtotal`, `gst`, `total` | number | Denormalised from lines; GST = 10% of subtotal |
| `currency` | string | `AUD` |
| `revision` | number | 1 today |
| `sentAt`, `closedAt`, `cancelledAt` | timestamp \| null | Stamped on transition |
| `externalRefs` | map | Empty today; reserved for accounting integrations (Xero/MYOB/QuickBooks IDs) |
| `createdAt` / `createdBy` | timestamp / uid | |

Each line item: `{ costCodeId, costCodeName, description, qty, unit, unitPrice, lineTotal }`
(`lineTotal` = qty × unitPrice, ex-GST, rounded to cents).

## …/projects/{projectId}/progressClaims/{claimId}

Cumulative supplier claims against one **sent** PO. One open claim
(draft/submitted/under_review) per PO at a time.

| Field | Type | Notes |
|---|---|---|
| `claimNumber` | string | `PC-0001` — from the company-wide counter |
| `status` | string | `draft` \| `submitted` \| `under_review` (reserved) \| `approved` \| `rejected` \| `invoiced` (reserved) |
| `poId`, `poNumber`, `supplierName`, `supplierId` | | Denormalised from the PO at creation |
| `periodEnding` | string | Date string (may be empty) |
| `claimRef` | string | Supplier's own reference |
| `variationId` | string \| null | **Reserved forward-link** to a Supplier Variation. Always `null` in the current branch — the Variations foundation does **not** wire claim-against-variation yet (claim documents are never modified). Activated in a later phase (claim-against-variation linkage) |
| `lineItems` | array | One per PO line — see below |
| `retention` | number | Ex-GST amount withheld, clamped to subtotal |
| `claimedSubtotal`, `claimedGst`, `claimedTotal` | number | GST applies to (subtotal − retention) |
| `approvedSubtotal`, `approvedGst`, `approvedTotal` | number \| null | Null until approved; frozen after |
| `assessmentNotes`, `notes` | string | |
| `currency`, `revision` | | `AUD`, 1 |
| `submittedAt`, `approvedAt`, `rejectedAt`, `invoicedAt` | timestamp \| null | Stamped on transition |
| `approvedBy` | uid \| null | |
| `externalRefs` | map | Reserved for accounting integrations |
| `createdAt` / `createdBy` | timestamp / uid | |

Each claim line item:

```
{ poLineIndex,            // stable key — PO lines freeze after draft
  costCodeId, costCodeName, description, poLineTotal,   // denormalised from PO line
  previouslyApproved,     // approved-to-date across earlier approved/invoiced claims
  claimedToDate,          // cumulative figure the supplier claims
  claimedThisPeriod,      // claimedToDate − previouslyApproved
  approvedThisPeriod }    // null until assessed; certified ex-GST amount
```

## …/projects/{projectId}/supplierInvoices/{invoiceId}

Accounts-payable supplier invoices ("bills") the company receives. The general
word *invoices* is reserved for future client/accounts-receivable invoicing.
Lifecycle and the budget-figure effects: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).
Reads are restricted to internal financial roles (see [SECURITY.md](SECURITY.md)).

Two sources: `progress_claim` (from one approved claim) and `direct_po` (directly
against one sent/closed PO, no claim). All canonical line amounts are **ex-GST**;
GST is stored per line as `gstAmount`.

| Field | Type | Notes |
|---|---|---|
| `invoiceNumber` | string | `SI-0001` — from the company-wide `counters/supplierInvoices` |
| `supplierInvoiceNumber` | string | The supplier's own invoice number — the duplicate-detection key |
| `status` | string | `draft` \| `approved` \| `posted` \| `cancelled` (live); `received` \| `under_review` \| `disputed` \| `paid` reserved |
| `docType` | string | `invoice`; `credit_note` reserved (Credit Notes are future) |
| `source` | string | `progress_claim` \| `direct_po` |
| `supplierId` | string \| null | → contact, snapshotted from the PO/claim; null for pre-Contacts POs |
| `supplierName` | string | Snapshot from the PO/claim — never re-read |
| `poId`, `poNumber` | string \| null | The one PO this invoice bills against (snapshot) |
| `progressClaimId`, `claimNumber` | string \| null | The one approved claim (source `progress_claim`), else null |
| `invoiceDate` | string | Supplier's tax-invoice date (`YYYY-MM-DD`) |
| `receivedDate` | string | When the invoice was received |
| `dueDate` | string | Explicit; seeded from payment terms, editable |
| `paymentTerms` | map \| null | `{ days, basis }` snapshot from the contact at write time |
| `lineItems` | array | See below — **ex-GST** amounts + per-line tax |
| `subtotal` | number | Σ line `amount` — gross certified ex-GST |
| `gstTotal` | number | Σ line `gstAmount` — GST on the gross lines |
| `grossTotal` | number | `subtotal + gstTotal` — full taxable supply inc. GST |
| `retention` | number | Ex-GST header-level withholding; carried from the claim (`progress_claim`), normally 0 for `direct_po` |
| `retentionGst` | number | GST on the retained amount (`retention × 10%`; 0 when retention 0) |
| `retentionTotal` | number | `retention + retentionGst` — amount withheld from the payable |
| `net` | number | `subtotal − retention` |
| `payableGst` | number | `gstTotal − retentionGst` — equals the source claim's `approvedGst` |
| `payableTotal` | number | `grossTotal − retentionTotal` — net payable; equals the source claim's `approvedTotal`. **Not** the full tax-invoice value (that is `grossTotal`) |
| `currency`, `revision` | | `AUD`, 1 |
| `notes` | string | |
| `approvedAt`/`approvedBy` | timestamp / uid | Stamped on approve |
| `postedAt`/`postedBy` | timestamp / uid | Stamped on post (the financial commit point) |
| `cancelledAt` | timestamp \| null | Stamped on cancel |
| `paidAt` | timestamp \| null | **Reserved** — set by the future Payments module |
| `adjustsInvoiceId` | string \| null | **Reserved** — Credit Note target |
| `attachments` | array | **Reserved** — always `[]`; no Storage uploads yet |
| `externalRefs` | map | **Reserved** — accounting-system IDs (Xero/MYOB/QuickBooks) |
| `createdAt` / `createdBy` | timestamp / uid | |

Each line item:

```
{ poLineIndex,            // links to the PO line (stable — PO lines freeze after draft)
  costCodeId, costCodeName, description,   // cost code inherited from the PO/claim line
  amount,                 // ex-GST (certified value for progress_claim; entered for direct_po)
  taxCode,                // 'gst' (10%) | 'gst_free' | 'input_taxed'
  gstAmount }             // GST for the line: 10% of amount for 'gst', else 0
```

GST-inclusive entry may be offered as a UI mode, but storage is always ex-GST +
`gstAmount`. Contact `gstStatus` is **advisory only** — it can raise a warning
but never auto-selects a tax code and never blocks. Cost codes are constrained to
the selected PO/claim lines — arbitrary non-PO cost-code lines are not allowed.

## …/projects/{projectId}/variations/{variationId}

Project-scoped commercial change control. **One type-discriminated collection**
holds both commercial variation types (ADR-18). Lifecycle and financial
semantics: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Reads are restricted
to internal financial roles (see [SECURITY.md](SECURITY.md)).

- **Client Variation** (`variationType: 'client'`) — a change to **contract
  revenue** (a.k.a. *Head Contract Variation*). No PO relationship. Revenue-side
  only: never touches Budgeted/Committed/Claimed/Invoiced/Actual.
- **Supplier Variation** (`variationType: 'supplier'`) — a change to a
  **supplier/subcontract commitment** (a.k.a. *Subcontract Variation*). References
  **one** sent/closed PO, or **none**. Approved amounts feed **Commitment
  Exposure** at read time — a figure kept separate from the canonical Committed.

All canonical amounts are **ex-GST**; GST is derived per line from `taxCode`.
Header totals derive from the line items (no flat header rate). Numbers come from
`counters/variationsClient` (`CV-0001`) / `counters/variationsSupplier`
(`SV-0001`), incremented in the same transaction as the write.

| Field | Type | Notes |
|---|---|---|
| `variationNumber` | string | `CV-0001` (client) or `SV-0001` (supplier) |
| `variationType` | string | `client` \| `supplier` |
| `status` | string | `draft` \| `submitted` \| `approved` \| `rejected` \| `withdrawn`; `under_review` \| `disputed` \| `superseded` reserved |
| `title`, `description` | string | |
| `reason` | string | Optional reserved enum: `design_change` \| `site_condition` \| `client_instruction` \| `error_omission` \| `other` \| `''` |
| `clientId` | string \| null | Client type: → contact (type `client`). `null` on supplier variations |
| `clientName` | string \| null | Snapshot of the client's display name at write time (frozen). `null` on supplier variations |
| `clientRef` | string \| null | Client's/superintendent's own VO number (optional). `null` on supplier variations |
| `supplierId` | string \| null | Supplier type: → contact, or snapshotted from the linked PO. `null` on client variations |
| `supplierName` | string \| null | Snapshot (frozen). `null` on client variations |
| `supplierRef` | string \| null | Supplier's own variation/quote number (optional). `null` on client variations |
| `poId` | string \| null | Supplier type: the **one** PO this varies, or `null` (no-PO / manual). Always `null` on client variations |
| `poNumber` | string \| null | Snapshot of the PO number |
| `lineItems` | array | See below — ex-GST, per-line tax |
| `submittedSubtotal`, `submittedGst`, `submittedTotal` | number | Derived from submitted line amounts (signed) |
| `approvedSubtotal`, `approvedGst`, `approvedTotal` | number \| null | Null until approved; frozen after (signed) |
| `forecastAmount` | number \| null | **Reserved** — likely settlement value of a pending variation, for future forecast |
| `identifiedDate`, `submittedDate`, `responseDueDate`, `approvedDate`, `effectiveDate` | string | Human `YYYY-MM-DD` strings (may be empty) |
| `currency`, `revision` | | `AUD`, 1 |
| `notes`, `assessmentNotes` | string | `assessmentNotes` required when approved amounts differ from submitted |
| `submittedAt`/`submittedBy`, `approvedAt`/`approvedBy`, `rejectedAt`/`rejectedBy`, `withdrawnAt`/`withdrawnBy` | timestamp / uid | Stamped on transition |
| `attachments` | array | **Reserved** — always `[]`; no Storage uploads yet |
| `externalRefs` | map | **Reserved** — accounting-system IDs |
| `supersededByVariationId` | string \| null | **Reserved** — revision workflow |
| `createdAt` / `createdBy` | timestamp / uid | |

Each line item:

```
{ costCodeId, costCodeName,       // MANDATORY spine + frozen snapshot
  description,
  submittedAmount, submittedGst,  // ex-GST proposed amount + derived GST (signed)
  approvedAmount, approvedGst,     // null until approved; ex-GST certified + derived GST (signed)
  poLineIndex,                     // supplier only: the PO line this extends, or null (new scope)
  taxCode }                        // 'gst' (10%) | 'gst_free' (0%) | 'input_taxed' (0%)
```

Only `approved` variations count financially, derived at read time
(`approvedSupplierVariationsByCostCode` and the exposure/total helpers in
`lib/variations.js`). Variations **never** write onto Budget Lines and **never**
mutate POs, claims, or invoices. Negative amounts (credits/omissions) are
supported and are **not** clamped to zero.

## Planned Commercial Entities (not yet modelled)

The schema above is **implemented**. The commercial lifecycle will introduce
further entities as their features are built. They are listed here for orientation
only — **exact fields, collection paths, and lifecycle schemas are deliberately
not defined yet**; each is decided in that feature's design assessment (order:
[ROADMAP.md](../ROADMAP.md)). What is fixed now is that every one of them joins the
commercial lifecycle through **`costCodeId`** (with a `costCodeName` snapshot),
exactly as budget lines, PO lines, claim lines, and invoice lines already do.

| Planned entity | Role in the lifecycle | Cost-code relationship (intended) |
|---|---|---|
| **BOQ lines** | Measured quantities in the Bill of Quantities | Each line carries a `costCodeId` |
| **Estimates** | Rates + margin/overheads applied to BOQ lines → estimate | Priced per cost code |
| **Tender packages** | BOQ items grouped for tender | Scoped by cost code / trade |
| **Tender bids** | Subcontractor responses, compared and levelled | Levelled per cost code against the estimate |
| **Awards** | The winning bid, transferred to commitment | Carries cost-coded amounts into POs/budget |
| **Budget Adjustments** | Internal budget transfers/revisions (no external counterparty) — **a distinct future document type, not a variation** | Reallocate budget by cost code |
| **Forecast snapshots / inputs** | Cost-to-complete, cash-flow, margin inputs | Aggregated by cost code |
| **Final account records** | Closing budget-vs-actual reconciliation | Reconciled per cost code |

No collection paths or field lists are committed here; adding any of these requires
a design assessment, a hook, and (where a new collection is introduced) a manual
`firestore.rules` change and security review — per [AGENT.md](../AGENT.md) and
[SECURITY.md](SECURITY.md).

## Relationships & Denormalisation Summary

- Budget lines, PO lines, claim lines → cost codes via `costCodeId`; each carries a `costCodeName` snapshot.
- Contacts → projects via `projectAssignments[].projectId` (with derived `projectIds`) — administrative preference only; no name snapshot, and financial documents never read it. The PO supplier picker groups project-assigned contacts first but any active supplier remains selectable.
- POs → contacts via `supplierId`, with `supplierName` snapshotted at write time (same pattern as `costCodeName`). Null `supplierId` = pre-Contacts PO; render from the snapshot.
- Claims → POs via `poId`, with `poNumber`/`supplierName`/`supplierId`/`poLineTotal` snapshotted. Claims inherit supplier identity from the PO — they never reference contacts directly.
- Variations → cost codes via `costCodeId` (with `costCodeName` snapshot) on every line; supplier variations → one PO via `poId` (with `poNumber`/`supplierName` snapshot) and optionally a PO line via `poLineIndex`; client variations → a client contact via `clientId`/`clientName`. Approved variations affect figures **only at read time** — no PO/claim/invoice/budget-line mutation.
- `progressClaims.variationId` is a **reserved** forward-link to a Supplier Variation — still `null`; the Variations foundation does not wire claim-against-variation yet.
- Supplier invoices → POs via `poId` (required; one PO per invoice) and → approved claims via `progressClaimId` (source `progress_claim` only). Supplier identity is snapshotted from the PO/claim (`supplierId`/`supplierName`) — invoices never read contacts for identity. Invoice lines link to PO lines via `poLineIndex`. Claims are **never** mutated or stamped when invoiced; double-counting is avoided at read time (see [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md)).
- Counters are company-wide: PO/claim/invoice numbers are unique per **company**, not per project. Contacts carry no sequential number.
