# Firestore Data Model

Current, implemented schema. Financial semantics and formulas:
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Access control:
[SECURITY.md](SECURITY.md).

## Hierarchy

```
users/{uid}
companies/{companyId}
  costCodes/{costCodeId}
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
| `supplierName` | string | Free text today |
| `supplierId` | string \| null | Always null until the Contacts module exists |
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
- Claims → POs via `poId`, with `poNumber`/`supplierName`/`supplierId`/`poLineTotal` snapshotted.
- `supplierId` and `variationId` are forward-references to unbuilt modules (Contacts, Variations) — always null today.
- Counters are company-wide: PO/claim numbers are unique per **company**, not per project.
