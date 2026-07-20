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
  counters/{counterId}                 (purchaseOrders, progressClaims)
  projects/{projectId}
    budgetLines/{lineId}
    purchaseOrders/{poId}
    progressClaims/{claimId}
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

Company-wide sequential numbering. Documents: `purchaseOrders`, `progressClaims`.

| Field | Type | Notes |
|---|---|---|
| `next` | number | The next number to assign. Read and incremented in the **same transaction** as the numbered document's creation, so concurrent users never share a number. Missing counter ⇒ starts at 1 |

Numbers render as `PO-0001` / `PC-0001` (zero-padded to 4).

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
| `invoiced` | number | **Stored** — always 0 today; will be written by the future invoices module |
| `committed` | number | Written once as `0` at creation and **never updated — ignored by the UI** |
| `actual` | number | Written once as `0` at creation and **never updated — ignored by the UI** |
| `notes` | string | |
| `createdAt` / `createdBy` | timestamp / uid | |

### Stored vs derived

Only `budgeted` (and, in future, `invoiced`) are authoritative stored values.
**Committed, Claimed, and Actual are derived at read time** — computed in the
browser from the project's purchase orders and progress claims
(`committedByCostCode`, `approvedByCostCode`, `claimedPendingByCostCode` in
`lib/`), keyed by `costCodeId`. Nothing ever writes these onto budget lines; the
`committed`/`actual` fields exist only as vestigial zeros from creation.
A PO can commit against a cost code that has no budget line — the Budget page
shows it as a warning row rather than hiding it.

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
| `variationId` | string \| null | Always null until the Variations module exists |
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

## Relationships & Denormalisation Summary

- Budget lines, PO lines, claim lines → cost codes via `costCodeId`; each carries a `costCodeName` snapshot.
- Contacts → projects via `projectAssignments[].projectId` (with derived `projectIds`) — administrative preference only; no name snapshot, and financial documents never read it. The PO supplier picker groups project-assigned contacts first but any active supplier remains selectable.
- POs → contacts via `supplierId`, with `supplierName` snapshotted at write time (same pattern as `costCodeName`). Null `supplierId` = pre-Contacts PO; render from the snapshot.
- Claims → POs via `poId`, with `poNumber`/`supplierName`/`supplierId`/`poLineTotal` snapshotted. Claims inherit supplier identity from the PO — they never reference contacts directly.
- `variationId` is a forward-reference to the unbuilt Variations module — always null today.
- Counters are company-wide: PO/claim numbers are unique per **company**, not per project. Contacts carry no sequential number.
