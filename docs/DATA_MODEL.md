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
                                        variationsClient, variationsSupplier, clientInvoices,
                                        clientReceipts, supplierPayments, tenderPackages)
  projects/{projectId}
    boqItems/{itemId}                    (measured Bill of Quantities)
    budgetLines/{lineId}
    purchaseOrders/{poId}
    progressClaims/{claimId}
    supplierInvoices/{invoiceId}
    clientInvoices/{invoiceId}
    clientReceipts/{receiptId}
    supplierPayments/{paymentId}
    variations/{variationId}
    tenderPackages/{packageId}
    tenderBids/{bidId}
    forecastLines/{costCodeId}           (deterministic id = costCodeId)
    cashFlowLines/{lineId}               (authored Cash Flow timing inputs)
    activities/{activityId}              (project programme — NON-FINANCIAL)
    counters/rfis                        (PER-PROJECT RFI numbering — the only project-scoped counter)
    rfis/{rfiId}                         (Requests for Information — NON-FINANCIAL evidence record)
    retentionReleases/{releaseId}        (authored retention-release authorisations)
    commercial/baseline                  (single doc; deterministic id = "baseline")
    drawings/{drawingId}                 (drawing master — random id)
      revisions/{revisionId}             (IMMUTABLE issues — random id)
    documents/{documentId}               (flat general document register — random id)
```

**Cloud Storage** (a separate service with its own rules file — see
[SECURITY.md](SECURITY.md)) holds the file bytes for the last two collections, at
deterministic paths built from these same IDs:

```
companies/{companyId}/projects/{projectId}/drawings/{drawingId}/{revisionId}/original.{ext}
companies/{companyId}/projects/{projectId}/documents/{documentId}/original.{ext}
```

`users/` is the only top-level collection besides `companies/`. Everything else
is company-scoped for multi-tenancy. Money amounts are plain numbers in the
**project's currency** (`project.currency` → `company.baseCurrency` → `AUD`; see
Company Country & Currency below); line and budget amounts are **ex-GST** unless
a field name says otherwise. There is **no FX conversion** — a currency is a
label for amounts entered in it, never a conversion instruction.

## users/{uid}

Document ID = Firebase Auth UID. Created manually today (no signup/invite flow).

**Client-read-only (ADR-27).** A user may read their own profile; `create`,
`update` and `delete` are **all blocked by rules**. No field below is writable
from the browser — not even `name` or `avatarInitials` — because no application
code writes this document (the only `users/` reference in `frontend/src` is the
read in `hooks/useProfile.jsx`). Profiles are **provisioned out of band**
(Firebase console / admin tooling, whose admin credentials bypass rules).
`role` and `companyId` are the fields every other rule in the file `get()`s to
authorise a request, which is why the whole document is closed rather than
partially allow-listed. Any future signup, invitation, or user-administration
flow must issue membership from a **trusted backend**, never from the client.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Preferred over Auth displayName in the UI |
| `email` | string | |
| `role` | string | `super_admin` \| `company_admin` \| `project_manager` \| `qs` \| `subcontractor` \| `client` |
| `companyId` | string | Links the user to their company — the multi-tenancy anchor; security rules `get()` this document |
| `avatarInitials` | string | Optional; falls back to initials derived from name/email |

## companies/{companyId}

Company **creation and deletion are blocked** from the client (admin tooling
only). Rules permit `company_admin` to update **four named currency fields and
nothing else** — `name` and every other field remain immutable from the client.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Read-only from the client |
| `countryCode` | string | **ISO 3166-1 alpha-2** (`NZ`, `AU`, `ZA`, `US`, `GB`). **Absent = never configured.** Suggests a currency; never forces one |
| `baseCurrency` | string | **ISO 4217** (`NZD`, `AUD`, `ZAR`, `USD`, `GBP`, `EUR`). The default inherited by **new** projects. Absent ⇒ display falls back to `AUD` and the setup banner shows; **nothing is auto-written** |
| `currencyUpdatedAt` / `currencyUpdatedBy` | timestamp / uid | Stamped on every currency configuration save |

Other fields (e.g. `createdAt`, `plan`) are incidental. Changing `baseCurrency`
later affects only the default for **new** projects — it never converts,
recalculates, or relabels any existing project or amount.

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
`supplierInvoices`, `variationsClient`, `variationsSupplier`, `clientInvoices`,
`clientReceipts`, `supplierPayments`, `supplierCreditNotes`, `tenderPackages`.

| Field | Type | Notes |
|---|---|---|
| `next` | number | The next number to assign. Read and incremented in the **same transaction** as the numbered document's creation, so concurrent users never share a number. Missing counter ⇒ starts at 1 |

Numbers render as `PO-0001` / `PC-0001` / `SI-0001` / `CV-0001` / `SV-0001` /
`CI-0001` / `CR-0001` / `SP-0001` / `SCN-0001` / `TP-0001` (zero-padded to 4). Tender **bids**
carry no number and use no counter — a bid is identified by its bidder and package.

**RFIs are NOT numbered here.** They use the **per-project** counter
`…/projects/{projectId}/counters/rfis` (below) — the only project-scoped counter —
so every project numbers its RFIs from `RFI-0001` independently.

## companies/{companyId}/projects/{projectId}

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `status` | string | UI labels: `Planning`, `In Progress`, `Backlogged`, `On Hold`, `Completed` |
| `budget` | number | Headline project budget (display only — not reconciled against budget lines) |
| `startDate` | Timestamp \| null | |
| `location` | string | |
| `progress` | number | 0–100, manually set at creation |
| `currency` | string | **ISO 4217** — THE display authority for every money figure on this project. Inherited from `company.baseCurrency` at creation and overridable there. **Absent** on projects predating this foundation ⇒ resolved through the company (see below) |
| `currencyLocked` | boolean | The **currency ratchet**. Once `true`, Firestore rules reject any change to a **well-formed** `currency` (including deleting or blanking it) and any attempt to set this back to `false`. One carve-out: a locked project storing **no** well-formed currency may receive its **first** explicit code, so a legacy project can still be pinned by Company Settings — see [SECURITY.md](SECURITY.md) → project currency ratchet. Set at creation when `budget > 0`, and by the single centralised lock operation whenever monetary data is first written. **Absent** ⇒ treated as `false` |
| `createdAt` / `createdBy` | timestamp / uid | |

### Currency resolution & locking

Display resolves `project.currency` → `company.baseCurrency` → `AUD`
(`lib/currency.js` → `resolveProjectCurrency`). Company setup pins an explicit
`currency` onto every existing project precisely so a later company-currency
change can never relabel it.

Currency **locks** as soon as the project holds any monetary value — a non-zero
`budget`, any budget line, any purchase order (**including draft and
cancelled**), any progress claim, supplier invoice, **client invoice (including
draft and void)**, **client receipt (including draft and void)**, **supplier
payment (including draft and void)**, client or
supplier variation, **any tender bid (including void — tender packages never
lock: they carry scope and dates, no amounts)**, any forecast line with
`uncommittedCostToComplete !== null`, any **priced** BOQ item (`rate !== null`,
including rate 0 and voided priced items — an unpriced item is a measurement,
not money, and never locks), or an established commercial baseline. Cost Codes and Contacts are company-wide and
hold no money, so they **never** lock. Detecting that evidence is
**client-enforced** (`lib/currency.js` → `monetaryLockReasons`); Firestore rules
cannot enumerate random-id subcollections. What rules **do** enforce is the
one-way ratchet once the flag is set. See [SECURITY.md](SECURITY.md).

## …/projects/{projectId}/boqItems/{itemId}

One measured line in the project's Bill of Quantities (ADR-32 Part 1). One BOQ
per project — a flat register with **no header document** (mirroring
`budgetLines`); random ids, **no counter** (a BOQ item is never quoted to a
supplier or client, so ADR-5 does not apply). **Reads restricted to financial
roles** — the BOQ is the internal estimate.

| Field | Type | Notes |
|---|---|---|
| `itemNumber` | string | User-authored label (`"2.1"`), NOT a sequence; may be `''` |
| `section` | string | Free-text grouping; may be `''` |
| `description` | string | Required, non-whitespace |
| `quantity` | number | Required, ≥ 0 — a measurement, not money |
| `unit` | string | Required; prefilled from the cost code's `unit`, editable |
| `rate` | number \| null | Ex-GST rate. **`null` = not yet priced** — never 0-as-unpriced; 0 is a price |
| `amount` | number \| null | **Derived** `quantity × rate` (whole-cent, rules-enforced); **`null` whenever `rate` is `null`** |
| `costCodeId` | string | **Required** — the cost-code spine |
| `costCodeName` | string | Frozen display snapshot at write time |
| `status` | string | `active` \| `void` — lifecycle **rules-enforced**; void terminal, reasoned |
| `voidedAt` / `voidedBy` / `voidReason` | | Null / `''` until voided |
| `currency` | string | Audit snapshot; the project currency remains the display authority |
| `revision` | number | Always `1` (reserved) |
| `notes` | string | |
| `attachments` | array | Reserved `[]` — no uploads (no Storage rules exist) |
| `externalRefs` | map | Reserved `{}` |
| `createdAt/By`, `updatedAt/By` | | Rules-verified stamps |

### Stored vs derived

Only the measurement and pricing inputs are stored. The BOQ total, the unpriced
count, and the **BOQ vs Approved Budget** comparison (per cost code, union of
both sides, variance suppressed while any contributing item is unpriced) are
derived at read time in `lib/boq.js` and never written anywhere. **BOQ items
feed no financial figure** — Budgeted, Committed, Actual, Invoiced, Forecast,
Margin, and Cash Flow are untouched. Estimating (margin/overheads), BOQ →
Budget transfer, and Tender entities are NOT modelled (see Planned Commercial
Entities below).

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
| `supplierName` | string | Snapshot of the contact's `displayName` at write time — permanently denormalised; contact renames never rewrite issued documents. **Immutable after create** with `supplierId` (ADR-36): the draft editor never writes either; wrong supplier → cancel and recreate. Free text on POs created before the Contacts module |
| `supplierId` | string \| null | → company contact. Null on POs created before the Contacts module — such POs render from `supplierName` and are never backfilled; code must never assume `supplierId` resolves |
| `description`, `notes` | string | |
| `lineItems` | array | **Embedded**; editable while `draft` (add/remove/reorder, cost code, description, qty, unit, rate — `costCodeName` re-snapshotted from the live list on save, ADR-36); frozen once the PO leaves draft. Both the draft-only edit and the freeze are **client-side only** — rules check tenant and role, not status |
| `subtotal`, `gst`, `total` | number | Denormalised from lines; GST = 10% of subtotal |
| `currency` | string | **Audit snapshot** of the project currency at write time (frozen, like `supplierName`/`costCodeName`). **Never read for display** — the project currency is the display authority, so a project can never render mixed currencies. Documents created before this foundation keep their stored `AUD` and are **never rewritten** |
| `revision` | number | 1 today |
| `sentAt`, `closedAt`, `cancelledAt` | timestamp \| null | Stamped on transition |
| `externalRefs` | map | Empty today; reserved for accounting integrations (Xero/MYOB/QuickBooks IDs) |
| `createdAt` / `createdBy` | timestamp / uid | |

Each line item: `{ costCodeId, costCodeName, description, qty, unit, unitPrice, lineTotal }`
(`lineTotal` = qty × unitPrice, ex-GST, rounded to cents).

## …/projects/{projectId}/progressClaims/{claimId}

Cumulative supplier claims against one **sent** PO. One open claim
(draft/submitted/under_review) per PO at a time.

**Draft editing (ADR-37).** While `status` is `draft` the claim may be corrected
in place through the single create/edit editor. Editable: `periodEnding`,
`claimRef`, `notes`, `retention` and each line's cumulative `claimedToDate` —
nothing else. `claimNumber`, `poId`/`poNumber`, `supplierId`/`supplierName` and
every field below marked as a stamp, snapshot or approved value are **immutable
after create** at the product/client level; wrong PO or supplier → withdraw and
raise a new claim. ⚠️ Both the draft-only edit and the `submitted` freeze are
**client-side only** — rules check tenant and role, not status (SECURITY.md
Deferred Controls 1 and 2).

| Field | Type | Notes |
|---|---|---|
| `claimNumber` | string | `PC-0001` — from the company-wide counter |
| `status` | string | `draft` \| `submitted` \| `under_review` (reserved) \| `approved` \| `rejected` \| `invoiced` (reserved) |
| `poId`, `poNumber`, `supplierName`, `supplierId` | | Denormalised from the PO at creation |
| `periodEnding` | string | Date string (may be empty) |
| `claimRef` | string | Supplier's own reference |
| `variationId` | string \| null | **Reserved forward-link** to a Supplier Variation. Always `null` in the current branch — the Variations foundation does **not** wire claim-against-variation yet (claim documents are never modified). Activated in a later phase (claim-against-variation linkage) |
| `lineItems` | array | **Embedded, and the line SET IS FIXED**: exactly one line per PO line, created one-to-one when the claim is raised. Lines are never added, removed or reordered — `poLineIndex` is downstream identity. A draft edit authors only each line's `claimedToDate`; every identity field is rebuilt from the stored line and `claimedThisPeriod` is re-derived (ADR-37). See below |
| `retention` | number | Ex-GST amount withheld, clamped to subtotal |
| `claimedSubtotal`, `claimedGst`, `claimedTotal` | number | GST applies to (subtotal − retention) |
| `approvedSubtotal`, `approvedGst`, `approvedTotal` | number \| null | Null until approved; frozen after |
| `assessmentNotes`, `notes` | string | |
| `currency`, `revision` | | **Audit snapshot** of the project currency at write time (never read for display; historical `AUD` values are never rewritten), 1 |
| `submittedAt`, `approvedAt`, `rejectedAt`, `invoicedAt` | timestamp \| null | Stamped on transition |
| `approvedBy` | uid \| null | |
| `externalRefs` | map | Reserved for accounting integrations |
| `createdAt` / `createdBy` | timestamp / uid | |

Each claim line item:

```
{ poLineIndex,            // stable key — PO lines freeze after draft; NEVER rewritten
  costCodeId, costCodeName, description, poLineTotal,   // denormalised from PO line
  previouslyApproved,     // approved-to-date across earlier approved/invoiced claims.
                          //   PRESERVED verbatim by a draft edit, never re-derived (ADR-37)
  claimedToDate,          // cumulative figure the supplier claims — the ONE authored
                          //   per-line value in a draft edit
  claimedThisPeriod,      // ALWAYS derived: roundMoney(claimedToDate − previouslyApproved);
                          //   a caller-supplied figure is never trusted
  approvedThisPeriod }    // null until assessed; certified ex-GST amount.
                          //   Forced null on every rebuilt draft line
```

## …/projects/{projectId}/supplierInvoices/{invoiceId}

Accounts-payable supplier invoices ("bills") the company receives. The general
word *invoices* is reserved for future client/accounts-receivable invoicing.
Lifecycle and the budget-figure effects: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).
Reads are restricted to internal financial roles (see [SECURITY.md](SECURITY.md)).

Two sources: `progress_claim` (from one approved claim) and `direct_po` (directly
against one sent/closed PO, no claim). All canonical line amounts are **ex-GST**;
GST is stored per line as `gstAmount`.

**Editable while `draft` (ADR-38).** `approved` is the AUTHORING FREEZE POINT
(`posted`, later, is the financial counting point). A draft may be corrected in
place instead of cancelled and re-raised:

| Source | Editable |
|---|---|
| both | `supplierInvoiceNumber`, `invoiceDate`, `receivedDate`, `dueDate`, `notes` |
| `direct_po` | additionally, per **stored** line: `amount`, `taxCode`; and header `retention` |
| `progress_claim` | **header only** — amounts, tax codes and retention are the claim's certified values and are read-only |

Everything else is immutable from creation and is never written by an edit:
`invoiceNumber`, `status`, `docType`, `source`, `supplierId`/`supplierName`,
`poId`/`poNumber`, `progressClaimId`/`claimNumber`, `paymentTerms`, `currency`,
`revision`, all lifecycle stamps, `paidAt`, `adjustsInvoiceId`, `attachments`,
`externalRefs`, `createdAt`/`createdBy`. Per line, `poLineIndex`, `costCodeId`,
`costCodeName` and `description` are identity, read from the **stored** line on
every rebuild and structurally unwritable; `gstAmount` is always re-derived from
`amount` + `taxCode`, never accepted from a caller. **The stored line set is
fixed** — no add, remove, reorder or reseed, in either mode: create filters out
zero-amount lines, so a PO line never priced at create was never stored and cannot
be added by editing (cancel and raise a new invoice); a line that *is* stored may
be taken to zero and brought back. All of this is **client-enforced only** — see
[SECURITY.md](SECURITY.md) → Deferred Controls 1 and 2.

| Field | Type | Notes |
|---|---|---|
| `invoiceNumber` | string | `SI-0001` — from the company-wide `counters/supplierInvoices` |
| `supplierInvoiceNumber` | string | The supplier's own invoice number — the duplicate-detection key |
| `status` | string | `draft` \| `approved` \| `posted` \| `cancelled` (live); `received` \| `under_review` \| `disputed` reserved. **`paid` is DEPRECATED IN PLACE, not reserved** — no supported path writes it and `SI_TRANSITIONS` reaches it from nowhere; payment state derives from Supplier Payment allocations (ADR-24). It is retained for legacy rendering, and because supplier-invoice lifecycle rules are still deferred a direct-SDK caller **can** still forge it |
| `docType` | string | `invoice`; the reserved `credit_note` value is **SUPERSEDED, never activated** — Supplier Credit Notes live in their own `supplierCreditNotes` collection (ADR-31) |
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
| `currency`, `revision` | | **Audit snapshot** of the project currency at write time (never read for display; historical `AUD` values are never rewritten), 1 |
| `notes` | string | |
| `approvedAt`/`approvedBy` | timestamp / uid | Stamped on approve |
| `postedAt`/`postedBy` | timestamp / uid | Stamped on post (the financial commit point) |
| `cancelledAt` | timestamp \| null | Stamped on cancel |
| `paidAt` | timestamp \| null | **DEPRECATED IN PLACE** — written once as `null` at creation and **never updated**. Supplier Payments shipped without activating it: payment state derives from posted Supplier Payment allocations, and setting a date here would create a second source of payment truth (ADR-24) |
| `adjustsInvoiceId` | string \| null | **SUPERSEDED, never activated** — the target reference lives on the Supplier Credit Note document (`supplierCreditNotes.supplierInvoiceId`, ADR-31), pointing the correct direction so nothing is ever written onto an invoice. Still written as `null` for shape stability |
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

## …/projects/{projectId}/clientInvoices/{invoiceId}

Accounts-**receivable** invoices issued to the head-contract client — the revenue
mirror of `supplierInvoices`. They reference the project's commercial baseline
(contract sum) and **approved client variations**; they never reference a PO, a
progress claim, or a supplier. Lifecycle, formulas, and the receivables
limitation: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Reads are
restricted to internal financial roles (see [SECURITY.md](SECURITY.md)).

All canonical line amounts are **ex-GST**; GST is stored per line as `gstAmount`.
There is **no retention and no payable/gross split** on the client side in this
foundation — `grossTotal` is what the client was billed. Numbers come from the
company-wide `counters/clientInvoices` (`CI-0001`), incremented in the same
transaction as the write.

| Field | Type | Notes |
|---|---|---|
| `invoiceNumber` | string | `CI-0001` — from the company-wide counter |
| `status` | string | `draft` \| `issued` \| `void`; `sent` **reserved** (no delivery mechanism exists, so nothing transitions into it). There is deliberately **no** `paid`/`partially_paid` — not even reserved |
| `docType` | string | `invoice`; `credit_note` reserved |
| `adjustsInvoiceId` | string \| null | **Reserved** — Credit Note target |
| `clientId` | string \| null | → company contact (type `client`) |
| `clientName` | string | **Frozen snapshot** of the contact's `displayName` at creation |
| `clientLegalName`, `clientAbn`, `clientEmail`, `clientPhone` | string | **Frozen snapshots** (`''` when unknown) |
| `clientAddress` | map | **Frozen snapshot** `{ street, suburb, state, postcode }` |
| `clientRef` | string | The **client's** own contract/PO reference. **Not** an invoice number |
| `externalInvoiceReference` | string | **Authored, optional.** The reference of the invoice actually issued to the client from Xero / MYOB / QuickBooks or a manual process. Editable while `draft`, **immutable after issue**. Distinct from `clientRef`; `externalRefs` below stays reserved for future *structured* integrations |
| `description` | string | Optional header description |
| `periodEnding` | string | `'YYYY-MM-DD'` \| `''` — the period this invoice covers |
| `invoiceDate` | string | `'YYYY-MM-DD'` |
| `dueDate` | string | `'YYYY-MM-DD'` \| `''` — seeded from `paymentTerms`, always editable; **blank when no terms exist** (never a hidden default) |
| `paymentTerms` | map \| null | `{ days, basis }` **frozen snapshot** from the client contact at creation |
| `lineItems` | array | **Embedded** (ADR-6) — see below |
| `subtotal` | number | Σ line `amount` — ex-GST |
| `gstTotal` | number | Σ line `gstAmount` |
| `grossTotal` | number | `subtotal + gstTotal` — the amount billed |
| `currency` | string | **Audit snapshot** of the project currency at write time. **Never read for display** — the project currency is the display authority |
| `revision` | number | 1 |
| `notes` | string | |
| `issuedAt` / `issuedBy` | timestamp / uid | `null` until issued. Rules require `issuedBy == request.auth.uid` and `issuedAt == request.time` |
| `voidedAt` / `voidedBy` | timestamp / uid | `null` unless void. Same rules constraints |
| `voidReason` | string | **Required non-empty** on void (rules-enforced) |
| `attachments` | array | **Reserved** — always `[]` |
| `externalRefs` | map | **Reserved** — structured accounting-system IDs |
| `createdAt` / `createdBy` | timestamp / uid | Set once; rules reject any later change |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** write path |

Each line item:

```
{ description,            // required
  amount,                 // ex-GST authored amount (≥ 0; credits are future Credit Notes)
  taxCode,                // 'gst' (10%) | 'gst_free' | 'input_taxed'
  gstAmount,              // derived at write time
  variationId,            // → an APPROVED client variation, or null for a contract line
  variationNumber,        // frozen snapshot 'CV-0003' | null
  variationDescription,   // frozen snapshot of the variation title | null
  costCodeId,             // OPTIONAL — null on contract lines (see below)
  costCodeName,           // frozen snapshot | null
  sortOrder }
```

**`costCodeId` is optional here — a deliberate, recorded exception (ADR-22).**
Head-contract revenue sits **above** the cost-code spine, exactly as ADR-20
already established for the commercial baseline ("contract revenue has no cost
code, exactly as client variations have no PO"). A **contract line** always
stores `null`; a **variation line** inherits a frozen cost-code snapshot **only
when the linked variation resolves to exactly one cost code**, and stores `null`
when the variation spans several (a single snapshot would be a false
attribution). Users are never made to invent a revenue cost code.

**Stored vs derived.** Only the fields above are authored or snapshotted.
**Issued Client Invoices, Available to Invoice, invoiced-and-remaining per
variation, and every receivables ageing bucket are derived at read time**
(`lib/clientInvoices.js`) and are **never** written back — not to this document,
not to the commercial baseline, not to variations, not to Budget Lines. Voided
invoices retain their number, so a void leaves an intentional, visible gap in the
sequence. **No migration** — a project with no `clientInvoices` loads normally.

## …/projects/{projectId}/clientReceipts/{receiptId}

**Cash actually received** from the head-contract client, with **embedded
allocations** against issued Client Invoices — the settlement half of accounts
receivable. Semantics, lifecycle, and the balance formulas:
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Reads are restricted to
internal financial roles (see [SECURITY.md](SECURITY.md)). Rationale: ADR-23.

A receipt records **gross cash**, not an accrual figure. It carries **no GST, no
tax code, no net amount, and no revenue meaning** — the tax was already recorded
on the invoice being reconciled, and a cash movement is not a new taxable supply.
Numbers come from the company-wide `counters/clientReceipts` (`CR-0001`),
incremented in the same transaction as the write.

| Field | Type | Notes |
|---|---|---|
| `receiptNumber` | string | `CR-0001` — from the company-wide counter |
| `status` | string | `draft` \| `posted` \| `void`. **No `cleared`, no `reconciled`** — reconciliation is a derived state of an *invoice*, never a receipt status |
| `docType` | string | `receipt`; `refund` **reserved** (money moving *back* to a client is a different event from voiding a mis-keyed receipt) |
| `clientId` | string | **REQUIRED non-empty** → company contact (type `client`). Unlike every other counterparty link in the app this is **never null**: a receipt with no client is not a record (rules-enforced) |
| `clientName` | string | **REQUIRED non-empty frozen snapshot** of the contact's `displayName` at creation |
| `receiptDate` | string | `'YYYY-MM-DD'` — the date the money was **received**. **This, never `createdAt`/`postedAt`, is the cash date the Cash Flow view consumes** |
| `amount` | number | **Gross cash received**, `> 0` (rules-enforced), in the project currency |
| `paymentMethod` | string | `bank_transfer` \| `card` \| `cash` \| `cheque` \| `direct_debit` \| `other`. **Required and never defaulted** — an unselected method is an unanswered question. Rules validate *shape* only (ADR-21 anti-drift precedent) |
| `paymentMethodOther` | string | Required non-empty when `paymentMethod` is `other`; `''` otherwise |
| `bankReference` | string | Optional — our bank-statement reference; the key for future bank reconciliation |
| `externalReference` | string | Optional — the receipt in Xero / MYOB / QuickBooks |
| `notes` | string | Optional |
| `allocations` | array | **Embedded** (ADR-6) — see below. Max 100 (rules-enforced) |
| `allocatedTotal` | number | **Derived at write** — Σ `allocations[].allocatedAmount` |
| `unallocatedAmount` | number | **Derived at write** — `amount − allocatedTotal`. Stored *specifically* so rules can enforce the scalar invariant below |
| `currency` | string | **Audit snapshot** of the project currency at write time. **Never read for display** |
| `revision` | number | 1 |
| `postedAt` / `postedBy` | timestamp / uid | `null` until posted. Rules require `postedBy == request.auth.uid` and `postedAt == request.time` |
| `voidedAt` / `voidedBy` | timestamp / uid | `null` unless void. Same constraints |
| `voidReason` | string | **Required non-whitespace** on void (rules-enforced) |
| `attachments` | array | **Reserved** — always `[]` |
| `externalRefs` | map | **Reserved** — structured accounting-system IDs |
| `createdAt` / `createdBy` | timestamp / uid | Set once; rules reject any later change |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** write path |

Each allocation:

```
{ clientInvoiceId,   // → an ISSUED client invoice on THIS project
  invoiceNumber,     // frozen snapshot 'CI-0004' — so a register row renders
                     // without reading invoice documents
  allocatedAmount }  // > 0, gross (inc. GST), in the project currency
```

**The scalar invariant.** Rules enforce
`allocatedTotal + unallocatedAmount == amount` (with both ≥ 0 and `amount > 0`),
compared in **whole cents** via `math.round(v * 100)`. Exact float equality would
reject legitimate money — `0.10 + 0.20` is `0.30000000000000004` in IEEE-754 — so
both sides are compared as integers. This is a *representation fix, not a
loosened invariant*: any discrepancy of one cent or more still fails.
`lib/payments.js → toCents()` mirrors it exactly.

**Stored vs derived.** Only the fields above are authored or snapshotted.
**Received to Date, Remaining to Reconcile, reconciliation state, the corrected
AR ageing, and every project-level cash total are derived at read time**
(`lib/clientReceipts.js` over `lib/payments.js`) and are **never** written
back — not onto this document, and above all **not onto Client Invoices**, which
gain no balance field, no payment status, and no receipt back-reference. Voiding
a receipt therefore restores every invoice balance for free, with no reversal
document. **No migration** — a project with no `clientReceipts` loads normally.

## …/projects/{projectId}/supplierPayments/{paymentId}

**Cash actually paid** to a supplier or subcontractor, with **embedded
allocations** against **posted** Supplier Invoices — the settlement half of
accounts payable and the money-out mirror of `clientReceipts`. Semantics,
lifecycle, and the balance formulas:
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Reads are restricted to
internal financial roles (see [SECURITY.md](SECURITY.md)). Rationale: ADR-24.

A payment records **gross cash**, not an accrual figure. It carries **no GST, no
tax code, no net amount, and no cost meaning** — the tax and the cost were both
recorded on the posted supplier invoice being settled. Numbers come from the
company-wide `counters/supplierPayments` (`SP-0001`), incremented in the same
transaction as the write. **`projectId` is deliberately not stored** — the
collection path carries it, and a redundant copy would be a second source of
truth.

| Field | Type | Notes |
|---|---|---|
| `paymentNumber` | string | `SP-0001` — from the company-wide counter; immutable after creation |
| `status` | string | `draft` \| `posted` \| `void`. **No `cleared`, no `reconciled`** — reconciliation is a derived state of an *invoice*, never a payment status |
| `docType` | string | `payment`; `refund` **reserved** (money moving *back* from a supplier is a different event from voiding a mis-keyed payment) |
| `supplierId` | string | **REQUIRED non-empty** → company contact (type `supplier` or `subcontractor`). **Never null** — unlike supplier *invoices*, which may carry a legacy `supplierId: null`, a new payment always carries a real link (rules-enforced) |
| `supplierName` | string | **REQUIRED non-empty frozen snapshot** of the contact's `displayName` at creation |
| `paymentDate` | string | `'YYYY-MM-DD'` — the date the money **left the account**. **This, never `createdAt`/`postedAt`, is the cash date the Cash Flow view consumes** |
| `amount` | number | **Gross cash paid**, `> 0` (rules-enforced), in the project currency |
| `paymentMethod` | string | `bank_transfer` \| `card` \| `cash` \| `cheque` \| `direct_debit` \| `other`. **Required and never defaulted**. Rules validate *shape* only (ADR-21 anti-drift precedent) |
| `paymentMethodOther` | string | Required non-empty when `paymentMethod` is `other`; `''` otherwise |
| `bankReference` | string | Optional — our bank-statement reference; the key for future bank reconciliation |
| `remittanceReference` | string | Optional — the reference communicated to the supplier. **Constrapp generates no remittance advice** (no PDF, no email) |
| `externalReference` | string | Optional — the payment in Xero / MYOB / QuickBooks |
| `notes` | string | Optional |
| `allocations` | array | **Embedded** (ADR-6) — see below. Max 100 (rules-enforced) |
| `allocatedTotal` | number | **Derived at write** — Σ `allocations[].allocatedAmount` |
| `unallocatedAmount` | number | **Derived at write** — `amount − allocatedTotal`. Stored *specifically* so rules can enforce the scalar invariant below |
| `currency` | string | **Audit snapshot** of the project currency at write time. **Never read for display** |
| `revision` | number | 1 |
| `postedAt` / `postedBy` | timestamp / uid | `null` until posted. Rules require `postedBy == request.auth.uid` and `postedAt == request.time` |
| `voidedAt` / `voidedBy` | timestamp / uid | `null` unless void. Same constraints |
| `voidReason` | string | **Required non-whitespace** on void (rules-enforced) |
| `attachments` | array | **Reserved** — always `[]` |
| `externalRefs` | map | **Reserved** — structured accounting-system IDs |
| `createdAt` / `createdBy` | timestamp / uid | Set once; rules reject any later change |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** write path |

Each allocation:

```
{ supplierInvoiceId,     // → a POSTED supplier invoice on THIS project
  invoiceNumber,         // frozen snapshot 'SI-0007' — Constrapp's number
  supplierInvoiceNumber, // frozen snapshot 'INV-4471' — the SUPPLIER'S own
                         // reference, which is what AP staff reconcile against.
                         // '' when the invoice carries none — never invented
  allocatedAmount }      // > 0, against payableTotal, in the project currency
```

Both references are frozen so a register row renders without reading invoice
documents, and both are searchable (`SI-0007 · INV-4471`).

**The payable basis.** Allocations reconcile against
**`supplierInvoice.payableTotal`** (`grossTotal − retentionTotal`), **never
`grossTotal`**. `payableTotal` is already net of retention withheld and of
retention's own GST; using gross would present retained money as currently
payable. A payment **never** writes, clears, or reduces `retention`,
`retentionGst`, or `retentionTotal` — they are immutable for the life of the
invoice. Retention becomes payable only through a posted Retention Release
(ADR-30), which raises the DERIVED payable basis and is never written back here.

**The scalar invariant.** Rules enforce
`allocatedTotal + unallocatedAmount == amount` (with both ≥ 0 and `amount > 0`),
compared in **whole cents** via `math.round(v * 100)` — identical to the
`clientReceipts` rule, and mirrored by `lib/payments.js → toCents()`. A
representation fix, not a loosened invariant: a one-cent discrepancy still fails.

**Stored vs derived.** Only the fields above are authored or snapshotted.
**Paid to Date, Remaining Payable, reconciliation state, the AP ageing, and every
project-level cash-out total are derived at read time**
(`lib/supplierPayments.js` over `lib/payments.js`) and are **never** written
back — not onto this document, and above all **not onto Supplier Invoices**,
which gain no balance field, no payment status, and no payment back-reference,
and whose `status` is **never** moved to `paid` and whose `paidAt` is **never**
set (ADR-24). Voiding a payment therefore restores every invoice balance for
free, with no reversal, refund, or bank-reversal document. **No migration** — a
project with no `supplierPayments` loads normally.

## …/projects/{projectId}/supplierCreditNotes/{creditNoteId}

Project-scoped **reduction records** against exactly one **posted** Supplier
Invoice (ADR-31): supplier credits for over-claimed quantities, rejected work,
back-charges, or negotiated reductions. The third payable-side document kind —
the invoice holds the cost/payable fact, the payment holds the cash fact, the
credit note holds the reduction fact — and none is ever mutated to reflect
another. All canonical line amounts are **ex-GST** with per-line
`taxCode`/`gstAmount`, exactly like the supplier-invoice lines they reverse.

| Field | Type | Notes |
|---|---|---|
| `creditNumber` | string | `SCN-0001` from `counters/supplierCreditNotes`; immutable (rules-enforced) |
| `status` | string | `draft` \| `posted` \| `void` — lifecycle **rules-enforced** to the ADR-22 standard; `posted` is the counting point; void terminal |
| `docType` | string | `credit_note` (rules-enforced literal, frozen) |
| `supplierInvoiceId` | string | **The one target** — a posted, zero-retention supplier invoice in this project. **Frozen at creation and core-preserved by rules**: retargeting is a void plus a new credit note |
| `invoiceNumber` | string | Frozen `SI-####` snapshot of the target |
| `supplierInvoiceNumber` | string | Frozen supplier's-own-reference snapshot (`''` when none) |
| `supplierId` | string \| null | Frozen from the target invoice — null allowed only because legacy invoices may carry null (rules require equality with the target) |
| `supplierName` | string | Frozen display-name snapshot, required non-empty |
| `supplierCreditReference` | string | The supplier's own credit-note number (e.g. `CN-1042`); `''` when none; duplicate-warned, never blocked |
| `creditDate` | string | `'YYYY-MM-DD'` (shape rules-enforced) |
| `reason` | string | **Required non-whitespace (rules-enforced)** — a credit without a stated cause is an audit hole |
| `lineItems[]` | array | 1–100 entries (size rules-enforced; element shape client-side) |
| `subtotal` | number | Σ line `amount` (ex-GST), `> 0` |
| `gstTotal` | number | Σ line `gstAmount`, `≥ 0` |
| `grossTotal` | number | `subtotal + gstTotal` — **whole-cent header invariant rules-enforced**, and `grossTotal ≤ target payableTotal` enforced via the rules `get()` |
| `currency` | string | Audit snapshot **frozen from the target invoice** (rules require the match); never read for rendering |
| `revision` | number | `1`; frozen |
| `notes` | string | Optional |
| `postedAt` / `postedBy` | Timestamp/string \| null | Rules: `== request.time` / caller on the post transition, null before |
| `voidedAt` / `voidedBy` / `voidReason` | — | Void audit; reason non-whitespace (rules-enforced) |
| `attachments` | array | **Reserved** — always `[]` (no Storage) |
| `externalRefs` | map | **Reserved** — accounting sync |
| `createdAt/By`, `updatedAt/By` | — | Unforgeable stamps (rules-enforced) |

Line item: `{ costCodeId, costCodeName, description, amount (ex-GST > 0),
taxCode ('gst'|'gst_free'|'input_taxed'), gstAmount }`. Every line **requires a
cost code drawn from the target invoice's lines** (client-enforced) — a
header-only credit would reduce AP cash but leave cost-code Actual/Invoiced
overstated. There is **no `poLineIndex`**: commitment maturing deliberately
ignores credits (ADR-31).

**The target checks (first cross-document `get()` in a financial rules
block).** On create, on every draft edit, and on the `draft → posted`
transition, rules verify the target exists, is
`posted`, matches `supplierId` and `currency`, carries **`retentionTotal` of
zero** (retained invoices cannot be credited while retention release is
unmodelled), and that this credit's `grossTotal` does not exceed its
`payableTotal` (whole cents). The **cumulative** cap across sibling credit
notes is app-enforced only — a HARD BLOCK, Deferred Control 25.

**Stored vs derived.** Only the fields above are authored or snapshotted.
**Credited-by-invoice, credited-by-cost-code, the net Invoiced/Actual figures,
the net Remaining Payable, and the exceptions list are derived at read time**
(`lib/supplierCreditNotes.js` and its consumers) and are **never** written back
— above all **not onto the Supplier Invoice**, which gains no credited total,
no status change, and no back-reference. A posted credit counts **only while it
passes the read-time validity gate** (`creditTargetException`): target still
resolving to a counting invoice with matching supplier, currency and zero
retention and a payable covering the credit's gross, **and** stored headers
reconciling to its own `lineItems` with per-line GST, positive amounts, and
cost codes present on the target. Otherwise it contributes zero to **both** the
payable and cost derivations and is surfaced as an exception — never clamped
(safe failure: cost stays visible). Voiding a credit note restores every figure
at the next render with no reversal document. **No migration** — a project with
no `supplierCreditNotes` loads normally.

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
| `originRfiId` | string \| null | **Originating RFI** (ADR-34) — the **one** same-project `rfis/{id}` that originated or materially supports this variation, or `null`. **Evidence link only** — no financial effect. Rules verify the RFI **exists in this project** and is `open`/`answered`/`closed` **when the link is created or changed**; an unchanged link is never re-checked, so it **survives** a later cancellation of the RFI. **Frozen by rules once the variation leaves `draft`.** Legacy documents may lack all three keys (read as unlinked) |
| `originRfiNumber` | string \| null | Frozen snapshot of `rfi.rfiNumber` — **rules-verified equal** to the RFI at link time (the number is immutable on the RFI) |
| `originRfiTitle` | string \| null | Frozen snapshot of `rfi.title` — **rules-verified equal** to the RFI at link time (the title is frozen for life once an RFI is raised, so every eligible RFI's title is immutable) |
| `lineItems` | array | See below — ex-GST, per-line tax |
| `submittedSubtotal`, `submittedGst`, `submittedTotal` | number | Derived from submitted line amounts (signed) |
| `approvedSubtotal`, `approvedGst`, `approvedTotal` | number \| null | Null until approved; frozen after (signed) |
| `forecastAmount` | number \| null | **Reserved** — likely settlement value of a pending variation, for future forecast |
| `identifiedDate`, `submittedDate`, `responseDueDate`, `approvedDate`, `effectiveDate` | string | Human `YYYY-MM-DD` strings (may be empty) |
| `currency`, `revision` | | **Audit snapshot** of the project currency at write time (never read for display; historical `AUD` values are never rewritten), 1 |
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

**Originating RFI (ADR-34).** The relationship is **one-directional** —
`Variation → RFI` — held in the three `originRfi*` scalars above (all `null`
or all populated, never partial; zero or one RFI per variation). The RFI
document stores **nothing** back: an RFI's *Linked variations* are derived at
read time by `variationsForRfi(variations, rfiId)` in `lib/variations.js`.
The link takes part in **no** derivation — not `variationTotals`, not the
approved/pending maps and totals, not duplicate detection, not invoicing.

**Draft editing (ADR-35).** While `status` is `draft` the editor may rewrite
**only** the authored content: `title`, `description`, `reason`, `clientRef`
(client) / `supplierRef` (supplier), `identifiedDate`, `responseDueDate`,
`effectiveDate`, `lineItems[]` (each line's `costCodeId` + re-snapshotted
`costCodeName`, `description`, `submittedAmount`, `taxCode`, `poLineIndex`, with
`submittedGst` and `submittedSubtotal`/`submittedGst`/`submittedTotal`
re-derived) and the `originRfi*` triple. Every draft line's `approvedAmount`/
`approvedGst` is forced `null` on write. **Never rewritten by an edit:**
`variationNumber`, `variationType`, `status`, `clientId`/`clientName`,
`supplierId`/`supplierName`, `poId`/`poNumber`, the `approved*` totals,
`assessmentNotes`, `submittedDate`/`approvedDate`, every `…At`/`…By` stamp,
`currency`, `revision`, `forecastAmount`, `attachments`, `externalRefs`,
`supersededByVariationId`, `createdAt`/`createdBy` — and `notes`, which has no
editor input and passes through unchanged. Immutability of these fields is
client-side (the rules freeze only `originRfi*` post-draft — Deferred Control
2); there is no `updatedAt`/`updatedBy` on this collection.

## …/projects/{projectId}/forecastLines/{costCodeId}

Per-cost-code **Forecast Cost to Complete** inputs — the forward-looking,
**strictly cost-side** control layer. The document ID is the **costCodeId**
itself (a deterministic natural key), so there is exactly one current forecast
per cost code and saves are idempotent upserts (never `addDoc` with a random ID).
Semantics and formulas: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Reads
are restricted to internal financial roles (commercially sensitive — see
[SECURITY.md](SECURITY.md)).

| Field | Type | Notes |
|---|---|---|
| `costCodeId` | string | → company cost code; also the document ID |
| `costCodeName` | string | Snapshot of the **current** cost-code display string at save time; the stored value is the fallback when the cost code is missing/inactive |
| `uncommittedCostToComplete` | number \| **null** | **The only authored input.** `null` = *not forecast*; `0` = reviewed, no further uncommitted cost expected; values `< 0` are rejected |
| `notes` | string | Optional assessor commentary |
| `createdAt` / `createdBy` | timestamp / uid | Set **only on first creation** and preserved across edits |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** save (`updatedBy` doubles as "prepared by") |

**Stored vs derived.** Only `uncommittedCostToComplete` and `notes` are authored;
everything shown on the Forecast page — **Actual, Remaining Committed, Cost to
Complete, Forecast Final Cost, Variance to Budget, Budgeted, and the approved/
pending supplier-variation exposure** — is **derived at read time** from the same
POs, claims, supplier invoices, variations, and budget lines the Budget page uses
(`lib/forecast.js` composes the existing `lib/` helpers). Nothing derived is ever
written here or onto Budget Lines. `null` contributes **zero** to totals for
calculation while the row stays visibly *not forecast*. No sequential number, no
counter. **No migration** — a project with no `forecastLines` loads normally and
every relevant cost code appears as *not forecast*.

## …/projects/{projectId}/commercial/baseline

The **Project Commercial Baseline** — the only authored inputs of the **Project
Margin** foundation. A single document in a one-document subcollection, keyed by a
**deterministic id `baseline`** (idempotent upsert, never `addDoc`). Stored on its
own document rather than on the Project document because contract value and implied
margin are commercially sensitive: reads are restricted to internal financial roles,
whereas the Project document is company-member readable. Firestore rules match only
the `baseline` id — no other `commercial/*` document is permitted. Reads restricted
to financial roles (see [SECURITY.md](SECURITY.md)). Semantics and margin formulas:
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).

| Field | Type | Notes |
|---|---|---|
| `originalContractValue` | number | **Ex-GST.** The original head-contract sum. Required to establish the baseline and to calculate margin |
| `originalApprovedBudget` | number \| **null** | **Ex-GST.** The original planned cost budget. `null` = *not established* — Original Planned Profit/Margin and Margin Movement then display "—". Never silently populated; an explicit "Use current approved budget" action copies the live Σ budget lines, and the value stays editable (server-enforced immutability is deferred) |
| `contractStartDate` | Timestamp \| null | Contract commencement (optional) |
| `contractCompletionDate` | Timestamp \| null | Contract completion (optional) |
| `clientId` | string \| null | → company contact (type `client`); optional |
| `clientName` | string \| null | Snapshot of the client contact's `displayName` at save time (frozen idiom); `null` when no client chosen |
| `notes` | string | Optional |
| `createdAt` / `createdBy` | timestamp / uid | Set **only on first creation** and preserved across edits |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** save |

**No `currency` field.** The baseline stores no currency and needs none: it
inherits the **project** currency like every other figure on the project (an
established baseline is itself monetary data and therefore locks that currency).
No FX conversion is performed or planned.

**Stored vs derived.** Only the fields above are authored. **Current Contract Sum,
Forecast Revenue, Forecast Gross Profit, Forecast Margin %, Original Planned
Profit/Margin %, and Margin Movement are all derived at read time** by `lib/margin.js`
(composing `lib/variations.js` for approved/pending client & supplier variation
totals and `lib/forecast.js` for Forecast Final Cost) — never written here or onto
any other document. **No migration** — a project with no baseline document loads
normally and shows an empty "baseline not set" state; margin figures appear once an
Original Contract Value is saved.

## …/projects/{projectId}/cashFlowLines/{lineId}

**Authored monthly Cash Flow timing inputs** — the ONLY stored Cash Flow data.
They time longer-term revenue and cost into months so a projected cash curve can
be derived; every projected figure itself is derived at read time
(`lib/cashFlow.js`) and never written back. Semantics and formulas:
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md). Reads are restricted to
internal financial roles (see [SECURITY.md](SECURITY.md)). Rationale: ADR-25.

A timing line is a **planning record, not a transaction**: there is no counter,
no sequential number, and no posted status. Document ids are random.

| Field | Type | Notes |
|---|---|---|
| `monthKey` | string | `'YYYY-MM'` — the month the cash is expected. Rules validate the shape; **that it is not a PAST month is client-enforced only** |
| `direction` | string | `in` \| `out` — **rules-enforced membership**. Direction carries the sign |
| `basis` | string | `'gross'` — rules-enforced. `'ex_gst'` is deliberately **not** defined; adding a basis requires a rules change and a security review |
| `amount` | number | **Expected GROSS cash, `> 0`** (rules-enforced). The only cash figure. A reduction is a line in the opposite direction, never a negative amount |
| `sourceAmountExGst` | number \| null | The **ex-GST source value** this line represents — **completeness COVERAGE only, never a cash column**. `null` on `manual` lines. Rules enforce `null` or `≥ 0`; the per-type requirement is client-enforced |
| `sourceType` | string | `contract_revenue` (in) · `uninvoiced_claim` / `remaining_committed` / `uncommitted_ctc` (out) · `manual` (either). **`client_invoice` and `supplier_invoice` are deliberately EXCLUDED** — open invoice balances are timed automatically by due date, so a manual line would double-count them (reserved for a future invoice-retiming feature). Rules validate **shape only** (ADR-21 anti-drift) |
| `costCodeId` | string \| null | The **coverage key and cost-code spine link** for cost-side types; `null` for `contract_revenue` and `manual` (revenue sits above the spine — ADR-20/ADR-22) |
| `costCodeName` | string | **Frozen snapshot**; non-empty exactly when `costCodeId` is non-null (rules-enforced pairing) |
| `sourceRef` | string | **Frozen human label** — `'CV-0003'`, `'PO-0012'`, `'PC-0007'`, `''`. A label only: it links nothing and changes no figure |
| `counterpartyName` | string | **Frozen snapshot**, `''` when none |
| `description` | string | **Required non-whitespace** (rules-enforced) |
| `notes` | string | Optional |
| `status` | string | `active` \| `void`. Create is `active`-only; **void is terminal** |
| `voidReason` | string | **Required non-whitespace** on void (rules-enforced) |
| `voidedAt` / `voidedBy` | timestamp / uid | `null` until void. Rules require `voidedBy == request.auth.uid` and `voidedAt == request.time` |
| `currency` | string | **Audit snapshot** of the project currency at write time. **Never read for display** |
| `revision` | number | `1` — rules-enforced on create, preserved on update |
| `createdAt` / `createdBy` | timestamp / uid | Set once; rules reject any later change |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** write |

**Deliberately NOT stored:** `projectId` (the collection path carries it — the
ADR-24 precedent), `sourceId` (every coverage key is a `costCodeId` or nothing,
so a polymorphic source id would always be null), any monthly total, cumulative
total, projected closing position, peak funding, or completeness percentage.

**Stored vs derived.** Only the fields above are authored. **Every monthly row,
the projected cumulative and closing position, source coverage, completeness,
the untimed buckets, and the peak-funding trough are derived at read time**
(`lib/cashFlow.js`) and are **never** written back — not here, and above all not
onto a client invoice, supplier invoice, PO, claim, variation, forecast line,
budget line, or the commercial baseline. A timing line is monetary data, so
creating one **locks the project currency in the same transaction** (ADR-21);
voided lines are retained and remain lock evidence. **No migration** — a project
with no `cashFlowLines` loads normally with an empty manual forecast.

## …/projects/{projectId}/activities/{activityId}

**The project programme** — Constrapp's first and only **non-financial** project
collection. An activity is a planning record: it holds no money, no currency, no
counter and no sequential number, and it **writes nothing to any financial
document** (no Forecast Line, Cash Flow Line, Commercial Baseline, Progress
Claim, PO, Supplier/Client Invoice, Budget Line or Variation) and **never
touches `projects/{projectId}.progress`**. Document ids are random and stable.
Rationale and the full set of deliberate exclusions: **ADR-29**. Access matrix
(the one place `qs` is read-only): [SECURITY.md](SECURITY.md).

⚠️ **This is a CURRENT-PLAN programme, not approved-baseline variance.** No
immutable baseline exists, so "overdue" means late against the planned dates *as
they stand now* — editing a planned date silently redefines "on time". Never
present a Timeline figure as slippage against an approved programme.

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required non-whitespace**, ≤ 120 chars (rules-enforced) |
| `description` | string | Optional, ≤ 500 |
| `isMilestone` | bool | A **point in time**, not a one-day activity: forces `plannedFinish == plannedStart` (rules-enforced), restricts `percentComplete` to `0` or `100`, and derives a duration of **0 days** |
| `status` | string | `not_started` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` — **closed set, rules-enforced**. `on_hold` deliberately replaces `blocked` (a blocked activity is usually part-done; the blocker goes in `notes`) |
| `plannedStart` | string | `'YYYY-MM-DD'` **date-only string**, required |
| `plannedFinish` | string | `'YYYY-MM-DD'`, required, **`>= plannedStart` (rules-enforced)**. **INCLUSIVE** — the last day of work |
| `actualStart` | string \| null | `'YYYY-MM-DD'` or `null` |
| `actualFinish` | string \| null | `'YYYY-MM-DD'` or `null`; **`>= actualStart` when both present** (rules-enforced) |
| `percentComplete` | number | **Integer 0–100, rules-enforced.** ⚠️ **Manually authored and unverifiable** — never derived from dates, child tasks, or Progress Claims, and it feeds **no** budget, forecast, margin or cash figure (ADR-29) |
| `responsibleContactId` | string \| null | → `companies/{c}/contacts/{id}`. **Never a user account** — `users/{uid}` is client-read-only (ADR-27), so no client can resolve another company user |
| `responsibleName` | string | **Frozen snapshot**, ≤ 120; non-empty exactly when `responsibleContactId` is non-null (rules-enforced pairing) |
| `costCodeId` | string \| null | **OPTIONAL** commercial-spine link → `companies/{c}/costCodes/{id}`. Not every programme activity maps to a cost code |
| `costCodeName` | string | **Frozen snapshot**, ≤ 120; same both-or-neither pairing (rules-enforced) |
| `sortOrder` | number | Manual programme order. ⚠️ **NOT unique** — rules cannot enforce uniqueness (no query/count) and concurrent creation can tie; display order breaks ties deterministically on planned start, planned finish, name, then id |
| `notes` | string | Optional, ≤ 500. Where an `on_hold` blocker is recorded |
| `cancelReason` | string | **Required non-whitespace** on cancellation, ≤ 500 (rules-enforced); `''` otherwise |
| `cancelledAt` / `cancelledBy` | timestamp / uid | `null` until cancelled. Rules require `cancelledBy == request.auth.uid` and `cancelledAt == request.time` |
| `revision` | number | `1` — rules-enforced on create, preserved on update |
| `createdAt` / `createdBy` | timestamp / uid | Set once; rules reject any later change |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** write. ⚠️ Records *who wrote last*, **not what changed** |

**Status invariants (all rules-enforced, all within-document):**
`not_started` ⇒ `percentComplete == 0` and both actual dates `null`;
`in_progress` ⇒ `actualStart != null`;
`completed` ⇒ `percentComplete == 100` and `actualFinish != null`;
`cancelled` is **terminal** and reachable only through the cancellation branch.

**⚠️ The lifecycle is deliberately NOT forward-only** — an explicit departure
from ADR-11. Any non-cancelled status may move to any other, **including
backwards** (`completed → in_progress`), because a programme is a plan that gets
corrected, not an audit record. Financial lifecycles are unaffected.

**Deliberately NOT stored:** `companyId`/`projectId` (the collection path
carries them — the ADR-24 precedent), `durationDays` (**derived**: a stored
duration is a third fact that can disagree with the two dates), `baselineStart`/
`baselineFinish` or any dependency/predecessor field (speculative — ADR-29
defers both), `currency` (an activity holds no money, so **no currency ratchet
is engaged** and creation needs no transaction), any sequential activity number,
and any stored `overdue`/`isLate` flag (**derived on every read** — a stored
flag would be wrong by tomorrow).

**Dates are date-only strings, not Timestamps.** A programme date is a day on a
wall chart, not an instant. This follows `lib/payments.js` (`invoiceDate`,
`dueDate`, `receiptDate`, `paymentDate`) and makes `plannedFinish >=
plannedStart` expressible **inside Firestore rules**. *(Note the older
inconsistency this does not copy: `commercial/baseline` stores contract dates as
`Timestamp|null`.)* Durations are **calendar days** — weekends, public holidays
and working calendars are not modelled. Overdue/due-soon comparisons use the
viewer's local date with **no timezone normalisation**, the same documented
limitation as `daysPastDue`/`isFutureDate`.

**Stored vs derived.** Only the fields above are authored. Duration, overdue,
days late, days until due, the horizon grouping (Overdue / This week / Upcoming
/ Later / Completed-Cancelled), the four summary counts, and every Gantt
coordinate are derived at read time (`lib/projectTimeline.js`,
`lib/timelineGantt.js`) and never written back. **Deletion is blocked** — cancel
via status. **No migration**: a project with no `activities` loads normally with
an empty programme.

## …/projects/{projectId}/counters/{counterId}

**Per-project sequential numbering.** Today the only document is `rfis`. This is
the first — and only — project-scoped counter: every financial counter is
company-wide (above). Same audience (financial roles), same tenant gate, delete
blocked.

| Field | Type | Notes |
|---|---|---|
| `next` | number | The next RFI number for **this project**. Read and incremented in the **same transaction** as the RFI's creation (`hooks/useRfis.jsx`), so two concurrent creates through the app never share a number. Missing counter ⇒ starts at 1 |

⚠️ Rules cannot enforce `+1` semantics or sibling uniqueness (no list, query or
count) — a direct-SDK caller can set any value or duplicate a number
(Deferred Control 6 / 27).

## …/projects/{projectId}/rfis/{rfiId}

**Requests for Information** — the second **non-financial** project collection
(after `activities`), and an **evidence record**: who asked what, of whom,
against which drawing revision or document, when it was due, what the answer
was and when it arrived. Rationale: **ADR-33**. Access matrix: [SECURITY.md](SECURITY.md).

**The commercial frame.** RFI V1 is an **evidence layer for future delay / EOT /
variation / forecast analysis**. It stores the record and **stable commercial
join keys only** (an optional cost code; a drawing-revision or document
reference). It implements **no financial derivation** and changes **no financial
figure**. An RFI holds no amount, no currency and no GST; creating one engages
**no currency ratchet** (the create transaction exists for the counter only).

| Field | Type | Notes |
|---|---|---|
| `rfiNumber` | string | `RFI-0001` from the **per-project** counter above, allocated in the create transaction. Shape `^RFI-[0-9]{4,}$` rules-enforced; **immutable** after create. Never reused — a cancelled RFI keeps its number |
| `status` | string | `draft` \| `open` \| `answered` \| `closed` \| `cancelled` — closed set, **forward-only, rules-enforced** (see lifecycle below) |
| `title` | string | **Required non-whitespace**, ≤ 200. **Frozen from `open`** |
| `question` | string | **Required non-whitespace**, ≤ 5000. **Frozen from `open`** |
| `raisedDate` | string | `'YYYY-MM-DD'` **authored** — the date on the RFI, not the transcription date. Required. **Frozen from `open`** |
| `raisedByName` | string | **Snapshot of the creator's OWN profile name** (`users/{uid}.name`), ≤ 120, non-whitespace. The first stored user-name snapshot in the app. ⚠️ **Client-authored and NOT rules-verified** against the profile (Deferred Control 27) — rules validate shape only. Frozen from `open` |
| `referenceType` | string | `none` \| `drawing` \| `document` — **zero or one** reference, held in **scalar** fields (never an array — rules cannot iterate one). Frozen from `open` |
| `referenceDrawingId` | string \| null | → `…/drawings/{id}`. **Required with `referenceRevisionId` when `drawing`**; null otherwise. **Existence rules-verified** at create and draft edit |
| `referenceRevisionId` | string \| null | → `…/drawings/{referenceDrawingId}/revisions/{id}`. **Required when `drawing`** — a master-only reference is **not accepted**; the RFI stays pinned to the exact revision the question was asked against. **Existence rules-verified via the nested path**, which is what proves the revision belongs to that drawing |
| `referenceDocumentId` | string \| null | → `…/documents/{id}`. Required when `document`; null otherwise. **Existence rules-verified** |
| `referenceLabel` | string | **Frozen display snapshot** (`A-101 Ground Floor Plan` / `Structural Specification`), ≤ 200, non-whitespace whenever a reference exists, `''` for `none`. Never backfilled on rename |
| `referenceRevisionCode` | string | **Frozen** revision code (`C`), ≤ 40, non-whitespace for `drawing`, `''` otherwise. Never sort by it |
| `costCodeId` | string \| null | **OPTIONAL** commercial-spine link → `companies/{c}/costCodes/{id}`. **Join key only** — no derivation reads it in V1. Frozen from `open` |
| `costCodeName` | string | **Frozen snapshot**, ≤ 120; both-or-neither pairing (rules-enforced) |
| `assignedToContactId` | string \| null | → `companies/{c}/contacts/{id}`. **A Contact, never a user** (ADR-27). Optional on a draft; **required to raise and REQUIRED for the life of an open RFI** — may be reassigned while `open` but never cleared (rules-enforced); **frozen from `answered`** |
| `assignedToName` | string | **Frozen snapshot**, ≤ 120; both-or-neither pairing (rules-enforced) |
| `dueDate` | string \| null | `'YYYY-MM-DD'`, **`>= raisedDate` (rules-enforced)**. Optional on a draft; **required to raise and REQUIRED for the life of an open RFI** — may be changed while `open` but never cleared (rules-enforced); frozen from `answered` |
| `raisedAt` / `raisedBy` | timestamp / uid | `null` until raised. Written **only** by the raise transition; rules require `raisedBy == request.auth.uid`, `raisedAt == request.time` |
| `answer` | string | `''` until answered; then **required non-whitespace**, ≤ 5000, written **only** by the answer transition and **immutable** afterwards (no reopen, no revision) |
| `answerDate` | string \| null | `'YYYY-MM-DD'` **authored** — the real-world date the answer was received/given, **`>= raisedDate` (rules-enforced)**. Kept separate from `answeredAt` because the transcription date is not the answer date; **response time is measured between the authored dates** |
| `answeredAt` / `answeredBy` | timestamp / uid | System stamps, answer transition only |
| `closeOutNote` | string | Optional, ≤ 1000, written **only** by the close transition. Where an unsatisfactory answer is recorded ("answer insufficient — raised RFI-0012 instead") |
| `closedAt` / `closedBy` | timestamp / uid | Close transition only |
| `cancelReason` | string | **Required non-whitespace** on cancellation, ≤ 500; `''` otherwise |
| `cancelledAt` / `cancelledBy` | timestamp / uid | Cancel transition only |
| `revision` | number | `1` — rules-enforced on create, preserved on update |
| `createdAt` / `createdBy` | timestamp / uid | Set once; rules reject any later change. `createdBy` is the raiser's uid; `raisedByName` is the human-readable snapshot |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on **every** write. ⚠️ Records *who wrote last*, **not what changed** |

**Lifecycle (rules-enforced, forward-only, NO reopen):**

```
draft ──raise──► open ──answer──► answered ──close──► closed
  │                │
  └──cancel──►  cancelled  ◄──cancel──┘
```

- `draft → open` requires an assignee **and** a due date already on the stored
  draft; the write touches only `status` + raise stamps.
- `open → answered` requires a non-whitespace `answer` and an authored
  `answerDate >= raisedDate`; touches only those + answer stamps.
- `answered → closed` touches only `closeOutNote` + close stamps.
- `draft|open → cancelled` requires a non-whitespace reason; touches only that
  + cancel stamps. **`answered` cannot be cancelled** — an answered question was
  not a mistake to ask; close it with a note.
- `closed` and `cancelled` are **terminal** — no update of any kind.
- Backwards moves and reopen do **not** exist. An unsatisfactory answer is
  closed with a note and a **new** RFI is raised. No answer history, no
  threads, no `supersedesRfiId`.

**Editability (rules-enforced):** the **question block** (`title`, `question`,
`raisedDate`, `raisedByName`, every `reference*`, `costCodeId`/`costCodeName`)
is editable in `draft` only and **frozen for life from `open`**. The
**management block** (`assignedToContactId`/`assignedToName`, `dueDate`) is
editable in `draft` and `open` — but while `open` it may only be **changed,
never cleared** (the open-state invariant) — and frozen from `answered`. Each transition
branch is `hasOnly`-restricted to its own keys, so nothing else can ride along.

**Deliberately NOT stored:** `companyId`/`projectId` (path), `currency`/any
amount (financially inert — **no currency ratchet**), `storagePath`/any download
URL (the reference is an id, never bytes), `assignedToUid` (no user-to-user
resolution exists — ADR-27), `supersedesRfiId`/answer history (no reopen),
`costImpact`/`timeImpact` (deferred), any `variationId`/`variationIds`/
`linkedVariations` (the RFI → Variation relationship is owned by the
**variation** — `originRfiId` — and the reverse view is derived at read time,
ADR-34), and any stored `overdue`/`responseDays` (**derived on every read**).

**Stored vs derived.** Only the fields above are authored. Overdue (open + due
date past; due today is not overdue), days late, days until due, days open,
**response days** (`answerDate − raisedDate`), the horizon grouping (Overdue ·
Due this week · Open · Awaiting close · Draft · Closed/Cancelled), the summary
counts, filtering and the deterministic sort (number desc, title, id) are
derived at read time (`lib/rfis.js`) and never written back. **Deletion is
blocked** — cancel via status. **No migration**: a project with no `rfis` loads
normally with an empty register.

## …/projects/{projectId}/retentionReleases/{releaseId}

The authored event that makes retention **already withheld** on a posted Supplier
Invoice **payable**. Random document ids; `RR-####` from the company-wide
`counters/retentionReleases` document.

> ⚠️ **A retention release is NOT a supplier invoice, a tax invoice, a credit
> note, or a payment.** It is an internal commercial authorisation. It creates no
> taxable supply, no cost, and no cash movement — only a posted Supplier Payment
> moves cash, and the cost was fully recognised when the invoice posted.

| Field | Type | Notes |
|---|---|---|
| `releaseNumber` | string | `RR-0001` |
| `status` | string | `draft` \| `posted` \| `void` (void terminal). **No `paid`** — payment state derives from Supplier Payment allocations (ADR-24) |
| `docType` | string | `retention_release` |
| `supplierInvoiceId` | string | The target invoice. A **scalar**, which is why rules can `get()` it and verify it is `posted` |
| `invoiceNumber`, `supplierInvoiceNumber` | string | Frozen snapshots — a register row renders without reading the invoice |
| `supplierId` | string \| null | `null` for legacy pre-Contacts invoices; never backfilled (ADR-15) |
| `supplierName` | string | Required non-empty; frozen snapshot |
| `previouslyReleasedAmount` | number | **Derived snapshot**, never user-editable: ex-GST released before this release. Makes the partial-release GST telescope |
| `amount` | number | Ex-GST released by this document, > 0 |
| `gstAmount` | number | `roundMoney((prev + amount) × 10%) − roundMoney(prev × 10%)` — the cumulative rounding delta, rules-enforced exactly |
| `releaseTotal` | number | `amount + gstAmount` — the cash that becomes payable |
| `releaseDate` | string | `YYYY-MM-DD`, the date the release was **agreed**. **Not** a defects-liability date, contractual entitlement date, or payment due date — none is modelled |
| `reason` | string | Required non-whitespace |
| `notes` | string | Optional |
| `currency`, `revision` | string, number | Audit snapshot / `1` |
| `createdAt/By`, `updatedAt/By`, `postedAt/By`, `voidedAt/By`, `voidReason` | | Standard audit stamps |
| `externalRefs` | map | `{}` — reserved for accounting sync |

**Deliberately absent:** `costCodeId` (a release moves cash, not cost),
`retentionPaid`, `retentionDueDate`, `defectsLiabilityDate`,
`supplierReleaseInvoiceReference`, and every client-retention or PO-retention
field.

**Stored vs derived.** Only the fields above are authored. **Retention held,
retention released, the derived payable basis, Remaining Payable, reconciliation
state, and AP ageing are all derived at read time** (`lib/retention.js` +
`lib/supplierPayments.js`) and **never** written back. In particular
**`retention`, `retentionGst`, and `retentionTotal` on the supplier invoice are
immutable for the life of that document** — no release reduces, clears, or stamps
them, and no `released` status joins `SI_STATUS`. Voiding a release therefore
restores every balance at the next render with no reversal record. A release is
monetary data, so creating one **locks the project currency in the same
transaction** (ADR-21); voided releases remain lock evidence. **No migration** —
a project with no `retentionReleases` behaves exactly as before ADR-30.

**Retention *paid* is not derivable and is not stored.** A payment allocation
settles an invoice balance as one balance; nothing identifies whether it settled
the original payable or released retention (ADR-30).

## …/projects/{projectId}/drawings/{drawingId}

The **drawing master** — the stable identity of a sheet ("A-101 Ground Floor
Plan"). Random Firestore ID: `drawingId` is the immutable identity a future
takeoff will reference, so it must survive the drawing number being corrected.
`companyId`/`projectId` are **not** duplicated into the document — the path
already carries ownership.

Reads are open to **every provisioned company member** (including subcontractor
and client); writes are `company_admin`/`project_manager` only — QS is excluded
in this branch. See [SECURITY.md](SECURITY.md) and ADR-28.

| Field | Type | Notes |
|---|---|---|
| `drawingNumber` | string | Normalised: trimmed, whitespace collapsed, upper-cased. **Not unique** — rules cannot query siblings; the UI warns |
| `title` | string | Required, non-whitespace |
| `discipline` | string | `architectural` \| `structural` \| `civil` \| `mechanical` \| `electrical` \| `hydraulic` \| `landscape` \| `other` |
| `description` | string | Optional |
| `status` | string | `active` \| `withdrawn`. Withdrawal is **terminal** — there is no reactivation |
| `currentRevisionId` | string \| **null** | Pointer to the authored current revision. `null` on a newly created master and after withdrawal with no replacement |
| `currentRevisionCode` | string | Mirrored for register display; `''` when there is no current revision |
| `currentRevisionIssuedDate` | string \| null | `'YYYY-MM-DD'`, mirrored for register display |
| `revisionCount` | int | High-water mark. Rules force **+1 exactly** on promotion, which is what makes `revisionSequence` dense and monotonic |
| `revisionSchemaVersion` | int | `1`. Immutable — lets a future migration tell old revisions from new ones |
| `withdrawnAt` / `withdrawnBy` | timestamp / uid \| null | Set only on withdrawal, stamped by rules |
| `withdrawReason` | string | **Required non-whitespace** on withdrawal (rules-enforced); `''` otherwise |
| `createdAt` / `createdBy` | timestamp / uid | Immutable after creation |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on every write |

**A master is BORN EMPTY** — rules reject a creation carrying a pointer, a
mirrored code/date, a revision count, or any withdrawal stamp. The first revision
is promoted afterwards, so a failed upload can never leave a drawing advertising
a revision whose bytes do not exist.

## …/projects/{projectId}/drawings/{drawingId}/revisions/{revisionId}

One **immutable issue** of a drawing. Random Firestore ID. Never deleted, never
overwritten, never repointed at different bytes.

| Field | Type | Notes |
|---|---|---|
| `revisionCode` | string | Author's code ("A", "B", "P1"), normalised (whitespace stripped, upper-cased), ≤ 12 chars. **Not unique** within a drawing — the UI warns |
| `revisionSequence` | int | **The ordering key.** `master.revisionCount + 1` at promotion. ⚠️ Revisions are ordered by this, **never** by `revisionCode` |
| `revisionDate` | string | `'YYYY-MM-DD'` — the date the revision was issued |
| `status` | string | `current` \| `superseded` \| `withdrawn`. Always born `current`; `withdrawn` is terminal |
| `notes` | string | What changed in this revision |
| `fileName` | string | The **user's original filename — metadata only, never identity** |
| `fileExt` | string | `pdf` \| `png` \| `jpg`. Must agree with `contentType` (rules-enforced) |
| `fileSize` | int | Bytes; `> 0` and `≤ 52428800` (50 MB), rules-enforced. ⚠️ Declared metadata — rules never see the bytes |
| `contentType` | string | `application/pdf` \| `image/png` \| `image/jpeg` |
| `storagePath` | string | **Must equal the exact path derived from the company/project/drawing/revision IDs** (rules-enforced), so a revision can never point at another tenant's bytes |
| `pageCount` | **null** | Reserved for a future takeoff module. Rules reject any other value — never fabricated |
| `sheetSize` | `''` | Reserved likewise |
| `supersededAt` / `supersededBy` | timestamp / uid \| null | Stamped when a newer revision is issued |
| `supersededByRevisionId` | string \| null | The revision that replaced this one; cleared on reinstatement |
| `withdrawnAt` / `withdrawnBy` | timestamp / uid \| null | Stamped on withdrawal |
| `withdrawReason` | string | **Required non-whitespace** on withdrawal |
| `revision` | int | `1` — document schema version |
| `createdAt` / `createdBy` | timestamp / uid | Immutable |
| `updatedAt` / `updatedBy` | timestamp / uid | Refreshed on every lifecycle write |

**Immutable in practice, not just by convention.** Every update branch in
`firestore.rules` is `hasOnly`-restricted to its own lifecycle stamps, so
`revisionCode`, `revisionSequence`, `revisionDate`, `notes`, `fileName`,
`fileExt`, `fileSize`, `contentType` and `storagePath` are unwritable after
creation.

**Lifecycle.** `current → superseded` (a newer revision was issued) ·
`current → withdrawn` · `superseded → current` (explicit reinstatement) ·
`superseded → withdrawn`. `withdrawn` is terminal. Promotion, supersession and
the master pointer move in **one transaction** with a concurrency check — see
[FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md)'s sibling document ADR-28.

## …/projects/{projectId}/documents/{documentId}

The **flat general document register**: specifications, contracts, subcontracts,
reports, certificates, safety documents, programmes, manuals, correspondence.
Random Firestore ID. **No folders and no revision subcollection** — a
replacement is a new record.

Writes are `company_admin`/`project_manager`/`qs` (QS **is** included here,
unlike drawings). Reads depend on `visibility`.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required, non-whitespace |
| `category` | string | `specification` \| `contract` \| `subcontract` \| `report` \| `certificate` \| `safety` \| `schedule` \| `manual` \| `correspondence` \| `other` |
| `visibility` | string | `project` (every provisioned company member) \| `internal` (company_admin/project_manager/qs). Defaults to `project` |
| `versionLabel` | string | Free text ("Rev 2", "Issue C") — **not** a revision spine |
| `documentDate` | string \| null | `'YYYY-MM-DD'` or null; plenty of documents are undated |
| `status` | string | `active` \| `superseded` \| `withdrawn`. Withdrawn is terminal |
| `supersededByDocumentId` | string \| null | Forward link to the replacement record. ⚠️ **Existence is not rules-checked** |
| `notes` | string | Optional |
| `fileName` | string | The user's original filename — **metadata only** |
| `fileExt` / `contentType` | string | Must agree; `pdf`/`png`/`jpg` |
| `fileSize` | int | `> 0` and `≤ 26214400` (**25 MB** — smaller than a drawing's ceiling) |
| `storagePath` | string | Must equal the exact derived path (rules-enforced) |
| `withdrawnAt` / `withdrawnBy` / `withdrawReason` | timestamp / uid / string | Withdrawal audit; reason **required non-whitespace** |
| `revision` | int | `1` — document schema version |
| `createdAt` / `createdBy` / `updatedAt` / `updatedBy` | timestamp / uid | Creation stamps immutable |

**⚠️ Rules are not filters.** Firestore evaluates the read rule against every
document a query returns, so one `internal` document fails an UNFILTERED query
for a subcontractor or client. `hooks/useProjectDocuments.jsx` subscribes with
`where('visibility','==','project')` for those roles — a **query requirement**,
not a security control. Ordering is applied client-side, so no composite index
is needed.

## Cash Flow — what is and is not persisted

`cashFlowLines` above is the **only** Cash Flow collection. Everything else the
Cash Flow view shows is derived at read time from collections that already
existed:

- **Actual cash** — `…/clientReceipts` and `…/supplierPayments` (posted only,
  total `amount`, grouped by `receiptDate` / `paymentDate`)
- **Automatic near-term forecast** — `…/clientInvoices` (issued, gross
  remaining) and `…/supplierInvoices` (posted, `payableTotal` remaining),
  timed by `dueDate` **month**
- **Coverage denominators** — the existing Budget/Forecast/Margin derivations
  over `budgetLines`, `purchaseOrders`, `progressClaims`, `supplierInvoices`,
  `variations`, `forecastLines`, and `commercial/baseline`

Nothing is written to any of them.

## …/projects/{projectId}/tenderPackages/{packageId}

A **Tender Package** — a named scope (free-text + ≥1 selected cost codes) put to
market, and the durable record of the **award decision**. The step between
Estimate and Commitment in the connected lifecycle. Numbered `TP-0001` from the
company-wide `counters/tenderPackages`, incremented in the same transaction as
the write. Lifecycle and semantics: [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md)
→ Tenders. Reads are restricted to internal financial roles (see
[SECURITY.md](SECURITY.md)). Rationale: ADR-32 Part 2.

A package holds **no amounts and no currency field** — the money lives on Tender
Bids. Creating a package therefore does **not** lock the project currency.

| Field | Type | Notes |
|---|---|---|
| `tenderNumber` | string | `TP-0001` — from the company-wide counter; immutable |
| `status` | string | `draft` \| `issued` \| `awarded` \| `cancelled`. Awarded and cancelled are **terminal** — there is no un-award/rescind in V1 |
| `name` | string | Required non-whitespace (rules-enforced) |
| `description` | string | Optional one-line summary |
| `scope` | string | **Free-text scope of works** — the V1 scope carrier. A structured BOQ scope schedule is future work (see ADR-32 Part 2) |
| `costCodes` | array | `[{ costCodeId, costCodeName }]` — **≥ 1 required**, ≤ 100 (rules enforce list-ness and size; **element shape is client-only**). Names are frozen snapshots. Editable while draft, **frozen at issue** |
| `closingDate` | string | `'YYYY-MM-DD'` \| `''`. **⚠️ INFORMATIONAL ONLY — bids are NOT automatically blocked after this date** (no trusted backend/clock exists). Editable while draft **and while issued** (the carve-out) |
| `notes` | string | Editable while draft and while issued (the carve-out) |
| `awardedBidId` | string \| null | Null until awarded. On award, rules `get()` the bid and verify it **exists in this project, belongs to this package, and is `received`** |
| `awardedBidderName` | string \| null | Frozen snapshot — rules require it to **equal the awarded bid's own `bidderName`** |
| `awardNotes` | string | The decision rationale — the point of the record |
| `cancelReason` | string | **Required non-whitespace** on cancel (rules-enforced) |
| `revision` | number | 1 |
| `issuedAt`/`issuedBy`, `awardedAt`/`awardedBy`, `cancelledAt`/`cancelledBy` | ts / uid | Null until each transition. Rules force the actor to the caller and the stamp to `request.time` |
| `createdAt`/`createdBy` | ts / uid | Set once; rules reject any later change |
| `updatedAt`/`updatedBy` | ts / uid | Refreshed on **every** write path |

**⚠️ Deliberately NOT stored:** `awardTotal` (see the bid section — no stored
header totals, ever), `currency` (no amounts to label), `projectId` (the path
carries it — the ADR-24 precedent), `attachments`/`externalRefs` (tender
documents are explicitly deferred; nothing is reserved).

**Lifecycle (rules-enforced, ADR-22 standard):** create draft-only with null
stamps and empty award/cancel fields; draft edits change content only;
`draft → issued` is a stamp-only operation that **freezes
name/description/scope/costCodes**; while issued, only `closingDate` and
`notes` may change (`affectedKeys().hasOnly`); `issued → awarded` touches only
the award fields and verifies the bid via `get()` — and because the branch
requires the current status to be `issued`, a **second award is rejected**;
`draft|issued → cancelled` needs a non-whitespace reason. Delete blocked.

## …/projects/{projectId}/tenderBids/{bidId}

A **Tender Bid** — the manual transcription of a bid received from a
supplier/subcontractor contact against an **issued** package, priced **per cost
code** (ex-GST; **no GST fields** — comparison is ex-GST, tax is a
commitment-time concern). **Random document ids, no number, no counter.**
Project-level with a `tenderPackageId` reference (the progressClaims→PO idiom),
not a subcollection. Reads are restricted to internal financial roles — a bid
**is competitor pricing** (see [SECURITY.md](SECURITY.md)).

| Field | Type | Notes |
|---|---|---|
| `tenderPackageId` | string | → package in the **same project** (rules `get()` it from the same path). Immutable |
| `tenderNumber` | string | **Frozen snapshot** — rules require it to equal the package's own at create |
| `status` | string | `received` \| `void`. **No draft state** — a bid is a transcription of an external document, not an authored document with a commit point (a deliberate, documented deviation from the create-draft-only standard, analogous to `cashFlowLines`) |
| `bidderContactId` | string | → contact of type `supplier`/`subcontractor`. Rules `get()` the contact at create and verify it **exists** and `contactTypes.hasAny(['supplier','subcontractor'])`. Immutable — a wrong-bidder entry is voided and re-recorded |
| `bidderName` | string | **Frozen snapshot** — rules require it to equal the contact's `displayName` at create. Immutable |
| `bidDate` | string | `'YYYY-MM-DD'` — when the bid was received. Informational; that it is realistic or before the closing date is unchecked everywhere |
| `bidderRef` | string | The bidder's own quote/tender reference |
| `lineItems` | array | **Embedded** (ADR-6) — see below. 1–100 (rules enforce list-ness and size; **element shape is client-only** — see Deferred Control 26) |
| `exclusions` | string | First-class free text — surfaced prominently in the comparison |
| `notes` | string | |
| `voidReason` | string | **Required non-whitespace** on void (rules-enforced) |
| `voidedAt`/`voidedBy` | ts / uid | Null until void; caller + `request.time` rules-forced |
| `currency` | string | **Audit snapshot** of the project currency at write time. **Never read for display** |
| `revision` | number | 1 |
| `createdAt`/`createdBy`, `updatedAt`/`updatedBy` | ts / uid | Standard stamps, rules-forced |

Each line item:

```
{ costCodeId,     // must sit inside the package's costCodes (CLIENT-enforced)
  costCodeName,   // frozen snapshot from the PACKAGE's own frozen list
  description,
  amount }        // ex-GST, finite, ≥ 0 (zero is a legitimate price) — CLIENT-enforced
```

**⚠️ NO STORED `bidTotal` — the header-vs-lines decision (ADR-32 Part 2).**
Firestore rules cannot iterate or sum an array, so a stored total would be an
unverifiable second copy of the lines (the exact integrity problem previously
found in Credit Notes). Every total is **derived at read time** through the
central validity gate (`lib/tenders.js → assessBid`): a bid with ANY malformed
line — or whose finite lines total beyond representable range — is **invalid as
a whole**, its total `null` (never a partial sum, never $0, never clamped), it
is excluded from the lowest-bid ranking, the budget comparison, the
per-cost-code matrix, and the Awarded Bid Value, and it renders visibly
flagged. A direct-SDK caller can store malformed embedded line data **and can
award such a bid** — rules read the bid's identity and status, never its lines,
so the app's refusal to award it is UX only. The gate is what makes such a
document **fail safely** instead of influencing a figure: the award value reads
*unavailable*, and an award writes no PO and no financial value regardless
(docs/SECURITY.md → Tenders, Deferred Control 26).

**Write windows (rules-enforced):** create only while the parent package is
`issued`; received bids stay correctable (bidDate, bidderRef, lineItems,
exclusions, notes) and voidable **only while the package remains `issued`**;
once the package is awarded or cancelled **every bid write is rejected** —
bids freeze, which is what makes the awarded bid's derived total trustworthy.
Void is terminal. Delete blocked.

**Stored vs derived.** Only the fields above are authored. **Bid totals, the
Tender Comparison (variance to Approved Budget = Approved Budget − Bid,
variance to lowest, lowest flags), the per-cost-code matrix, and the Awarded
Bid Value are all derived at read time** (`lib/tenders.js`) and are **never**
written back — not here, not onto the package, and above all not onto Budget
Lines, POs, forecasts, margin, or Cash Flow. A tender bid is monetary data, so
creating one **locks the project currency in the same transaction** (ADR-21);
voided bids are retained and remain lock evidence. **No migration** — a
project with no tender collections loads normally.

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
| ~~**BOQ lines**~~ | **Implemented** as `boqItems` above (ADR-32 Part 1) | Each item carries a mandatory `costCodeId` |
| **Estimates** | Rates + margin/overheads applied to BOQ items → estimate; BOQ → Budget transfer | Priced per cost code |
| ~~**Tender packages / bids / awards**~~ | **Implemented** as `tenderPackages` + `tenderBids` above (ADR-32 Part 2) — cost-code + free-text scope, manual bids, read-time Tender Comparison, award as a decision record | Package `costCodes[]` and bid `lineItems[]` carry `costCodeId` |
| **BOQ scope schedule on tenders** | Optional frozen snapshot of BOQ items onto a package at issue (future, separate design) | Adds `boqItemId` per schedule line |
| **"Raise PO from Award"** | Explicit Award → PO linkage (V1 deliberately creates no PO and infers no awarded-vs-committed netting) | Transfers the awarded bid's cost-coded amounts into a draft PO |
| **Budget Adjustments** | Internal budget transfers/revisions (no external counterparty) — **a distinct future document type, not a variation** | Reallocate budget by cost code |
| **Forecast period snapshots** | Immutable monthly cost-to-complete snapshots + prior-period comparison (the *current* per-cost-code forecast inputs are **implemented** above as `forecastLines`) | Aggregated by cost code |
| **Final account records** | Closing budget-vs-actual reconciliation | Reconciled per cost code |

No collection paths or field lists are committed here; adding any of these requires
a design assessment, a hook, and (where a new collection is introduced) a manual
`firestore.rules` change and security review — per [AGENT.md](../AGENT.md) and
[SECURITY.md](SECURITY.md).

## Relationships & Denormalisation Summary

- Budget lines, PO lines, claim lines → cost codes via `costCodeId`; each carries a `costCodeName` snapshot.
- BOQ items → cost codes via a **required** `costCodeId` (with a `costCodeName` snapshot). BOQ items reference **nothing else** and are referenced **by nothing**: no budget line, PO, claim, invoice, variation, forecast line, or cash figure reads or writes them, and the BOQ-vs-budget comparison is derived at read time (`lib/boq.js`) — never stored.
- Contacts → projects via `projectAssignments[].projectId` (with derived `projectIds`) — administrative preference only; no name snapshot, and financial documents never read it. The PO supplier picker groups project-assigned contacts first but any active supplier remains selectable.
- POs → contacts via `supplierId`, with `supplierName` snapshotted at write time (same pattern as `costCodeName`). Null `supplierId` = pre-Contacts PO; render from the snapshot.
- Claims → POs via `poId`, with `poNumber`/`supplierName`/`supplierId`/`poLineTotal` snapshotted. Claims inherit supplier identity from the PO — they never reference contacts directly.
- Variations → cost codes via `costCodeId` (with `costCodeName` snapshot) on every line; supplier variations → one PO via `poId` (with `poNumber`/`supplierName` snapshot) and optionally a PO line via `poLineIndex`; client variations → a client contact via `clientId`/`clientName`. Approved variations affect figures **only at read time** — no PO/claim/invoice/budget-line mutation.
- `progressClaims.variationId` is a **reserved** forward-link to a Supplier Variation — still `null`; the Variations foundation does not wire claim-against-variation yet.
- Supplier invoices → POs via `poId` (required; one PO per invoice) and → approved claims via `progressClaimId` (source `progress_claim` only). Supplier identity is snapshotted from the PO/claim (`supplierId`/`supplierName`) — invoices never read contacts for identity. Invoice lines link to PO lines via `poLineIndex`. Claims are **never** mutated or stamped when invoiced; double-counting is avoided at read time (see [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md)).
- Forecast lines → cost codes via `costCodeId`, which is **also the document ID** (one current forecast per cost code). They store only the manual `uncommittedCostToComplete` + `notes`; every displayed figure is derived at read time and never written back (`lib/forecast.js`). Forecast lines never mutate POs, claims, invoices, variations, or budget lines.
- The commercial baseline → a client contact via `clientId` (with a frozen `clientName` snapshot); optional. It stores contract inputs only — every margin figure is derived at read time from the baseline, approved client variations, and Forecast Final Cost, and is never written back to the baseline or any other document.
- Client invoices → a client contact via `clientId`, with the client's name, legal name, ABN, email, phone, and address **snapshotted at creation** so later contact edits never rewrite billing history; → approved **client** variations via an optional per-line `variationId` (+ frozen `variationNumber`/`variationDescription`). The linkage is **read-time only**: invoicing **never** mutates a variation (no stamp, no status change, no back-reference) and never touches the commercial baseline or Budget Lines. Line `costCodeId` is **optional** (ADR-22).
- Client receipts → a client contact via a **required** `clientId` (with a frozen `clientName` snapshot); → issued client invoices via **embedded** `allocations[].clientInvoiceId` (+ a frozen `invoiceNumber` snapshot). The linkage is **read-time only**: a receipt **never** mutates an invoice (no balance field, no payment status, no back-reference), which is exactly why voiding a receipt restores every balance with no reversal record. Receipts touch no cost figure, no forecast, and no margin figure — cash is not revenue.
- Supplier payments → a supplier/subcontractor contact via a **required** `supplierId` (with a frozen `supplierName` snapshot); → **posted** supplier invoices via **embedded** `allocations[].supplierInvoiceId` (+ frozen `invoiceNumber` **and** `supplierInvoiceNumber` snapshots). A supplier invoice with a legacy `supplierId: null` is matched on its frozen `supplierName` instead and is **never backfilled**. The linkage is **read-time only**: a payment **never** mutates a supplier invoice (no balance field, no payment status, no back-reference, no `paid` status, no `paidAt`), which is exactly why voiding a payment restores every balance with no reversal record. Payments touch no cost figure, no forecast, and no margin figure — cash out is not cost.
- Supplier credit notes → exactly **one posted** supplier invoice via a **frozen** `supplierInvoiceId` (+ frozen `invoiceNumber`/`supplierInvoiceNumber`/`supplierId`/`supplierName`/`currency` snapshots — all core-preserved by rules). The target must be posted with **zero retention** at create/edit time (rules `get()`). The linkage is **read-time only**: a credit note **never** mutates the invoice; posted valid-target credits subtract from Invoiced/Actual by line `costCodeId` (ex-GST) and from the invoice's Remaining Payable by `grossTotal`. Credit lines carry cost codes drawn from the target invoice's lines and **no `poLineIndex`** — Remaining Committed is never restored by a credit (ADR-31).
- Tender packages → cost codes via `costCodes[].costCodeId` (with frozen `costCodeName` snapshots — the package's join onto the spine); → the winning bid via `awardedBidId` (with a frozen `awardedBidderName` snapshot rules-matched to the bid's own). The award is **read-time only**: it never creates a PO, never touches Budget Lines, and stores no total.
- Tender bids → one package via `tenderPackageId` (with a frozen `tenderNumber` snapshot rules-matched to the package); → a supplier/subcontractor contact via `bidderContactId` (with a frozen `bidderName` snapshot rules-matched to the contact); → cost codes via `lineItems[].costCodeId` (client-constrained to the package's own codes, with `costCodeName` snapshots from the package's frozen list). No stored totals anywhere — every figure derives through the `assessBid` validity gate.
- Timeline activities → a company contact via an optional `responsibleContactId` (with a frozen `responsibleName` snapshot), and → cost codes via an **optional** `costCodeId` (with a frozen `costCodeName`). Both linkages are **labels only**: an activity never mutates a contact, a cost code, or any commercial document, and no financial figure is derived from one. The cost code is the **join key reserved for a future read-time "delay → forecast impact" derivation** (ADR-29) — it authors nothing today. Activities reference **no user account** (`users/{uid}` is client-read-only — ADR-27) and carry **no dependency link** to another activity.
- Drawing revisions → their master via the **path** (`drawings/{drawingId}/revisions/{revisionId}`); the master → its current revision via `currentRevisionId` plus mirrored `currentRevisionCode`/`currentRevisionIssuedDate` for register display. A revision → its Storage object via `storagePath`, which rules require to equal the exact path derived from the IDs. ⚠️ The **immutable takeoff identity is `{ drawingId, revisionId }`** — never `drawingNumber` (correctable), never `master.currentRevisionId` (moves by design), never the filename (user text). Drawings link to no cost code, no contact and no financial document: the commercial linkage arrives with the future takeoff/BOQ module.
- General documents → their replacement via `supersededByDocumentId` (forward only; existence not rules-checked) and → their Storage object via `storagePath`. They carry no cost code, no contact and no counter — a `versionLabel` is free text, not a sequence.
- Counters are company-wide: PO/claim/invoice/receipt/payment/credit-note/tender-package/retention-release numbers are unique per **company**, not per project. Drawings, revisions and general documents use **random Firestore IDs and no counter** — a drawing number is authored, not allocated. Contacts, forecast lines, tender bids, timeline activities, and the commercial baseline carry no sequential number.
