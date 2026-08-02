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
                                        clientReceipts)
  projects/{projectId}
    budgetLines/{lineId}
    purchaseOrders/{poId}
    progressClaims/{claimId}
    supplierInvoices/{invoiceId}
    clientInvoices/{invoiceId}
    clientReceipts/{receiptId}
    variations/{variationId}
    forecastLines/{costCodeId}           (deterministic id = costCodeId)
    commercial/baseline                  (single doc; deterministic id = "baseline")
```

`users/` is the only top-level collection besides `companies/`. Everything else
is company-scoped for multi-tenancy. Money amounts are plain numbers in the
**project's currency** (`project.currency` → `company.baseCurrency` → `AUD`; see
Company Country & Currency below); line and budget amounts are **ex-GST** unless
a field name says otherwise. There is **no FX conversion** — a currency is a
label for amounts entered in it, never a conversion instruction.

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
`clientReceipts`.

| Field | Type | Notes |
|---|---|---|
| `next` | number | The next number to assign. Read and incremented in the **same transaction** as the numbered document's creation, so concurrent users never share a number. Missing counter ⇒ starts at 1 |

Numbers render as `PO-0001` / `PC-0001` / `SI-0001` / `CV-0001` / `SV-0001` /
`CI-0001` / `CR-0001` (zero-padded to 4).

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
| `currencyLocked` | boolean | The **currency ratchet**. Once `true`, Firestore rules reject any change to `currency` and any attempt to set this back to `false`. Set at creation when `budget > 0`, and by the single centralised lock operation whenever monetary data is first written. **Absent** ⇒ treated as `false` |
| `createdAt` / `createdBy` | timestamp / uid | |

### Currency resolution & locking

Display resolves `project.currency` → `company.baseCurrency` → `AUD`
(`lib/currency.js` → `resolveProjectCurrency`). Company setup pins an explicit
`currency` onto every existing project precisely so a later company-currency
change can never relabel it.

Currency **locks** as soon as the project holds any monetary value — a non-zero
`budget`, any budget line, any purchase order (**including draft and
cancelled**), any progress claim, supplier invoice, **client invoice (including
draft and void)**, **client receipt (including draft and void)**, client or
supplier variation, any forecast line with
`uncommittedCostToComplete !== null`, or an established commercial baseline. Cost Codes and Contacts are company-wide and
hold no money, so they **never** lock. Detecting that evidence is
**client-enforced** (`lib/currency.js` → `monetaryLockReasons`); Firestore rules
cannot enumerate random-id subcollections. What rules **do** enforce is the
one-way ratchet once the flag is set. See [SECURITY.md](SECURITY.md).

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
| `currency`, `revision` | | **Audit snapshot** of the project currency at write time (never read for display; historical `AUD` values are never rewritten), 1 |
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
| `currency`, `revision` | | **Audit snapshot** of the project currency at write time (never read for display; historical `AUD` values are never rewritten), 1 |
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
| `receiptDate` | string | `'YYYY-MM-DD'` — the date the money was **received**. **This, never `createdAt`/`postedAt`, is the cash date the future Cash Flow module consumes** |
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
| **Forecast period snapshots** | Immutable monthly cost-to-complete snapshots + prior-period comparison (the *current* per-cost-code forecast inputs are **implemented** above as `forecastLines`) | Aggregated by cost code |
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
- Forecast lines → cost codes via `costCodeId`, which is **also the document ID** (one current forecast per cost code). They store only the manual `uncommittedCostToComplete` + `notes`; every displayed figure is derived at read time and never written back (`lib/forecast.js`). Forecast lines never mutate POs, claims, invoices, variations, or budget lines.
- The commercial baseline → a client contact via `clientId` (with a frozen `clientName` snapshot); optional. It stores contract inputs only — every margin figure is derived at read time from the baseline, approved client variations, and Forecast Final Cost, and is never written back to the baseline or any other document.
- Client invoices → a client contact via `clientId`, with the client's name, legal name, ABN, email, phone, and address **snapshotted at creation** so later contact edits never rewrite billing history; → approved **client** variations via an optional per-line `variationId` (+ frozen `variationNumber`/`variationDescription`). The linkage is **read-time only**: invoicing **never** mutates a variation (no stamp, no status change, no back-reference) and never touches the commercial baseline or Budget Lines. Line `costCodeId` is **optional** (ADR-22).
- Client receipts → a client contact via a **required** `clientId` (with a frozen `clientName` snapshot); → issued client invoices via **embedded** `allocations[].clientInvoiceId` (+ a frozen `invoiceNumber` snapshot). The linkage is **read-time only**: a receipt **never** mutates an invoice (no balance field, no payment status, no back-reference), which is exactly why voiding a receipt restores every balance with no reversal record. Receipts touch no cost figure, no forecast, and no margin figure — cash is not revenue.
- Counters are company-wide: PO/claim/invoice/receipt numbers are unique per **company**, not per project. Contacts, forecast lines, and the commercial baseline carry no sequential number.
