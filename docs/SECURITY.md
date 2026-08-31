# Security

What is actually enforced today, and what is deliberately deferred. The rules
source of truth is `frontend/firestore.rules`, published **manually** via the
Firebase console (see [DEPLOYMENT.md](DEPLOYMENT.md)). Working conventions and the
current-vs-backend control matrix live in
[ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md).

## Firestore Security Rules — not SQL Row Level Security

Constrapp's data-access boundary is **Firestore Security Rules**, evaluated by
Firebase on every read/write. Firestore does **not** use SQL Row Level Security
(RLS); there is no relational database in the stack today. If PostgreSQL or
Supabase is introduced later, **RLS becomes mandatory and must be enabled and
tested on every tenant-owned table** (see Trusted-Backend Activation
Requirements below) — it does not replace the Firestore rules while both exist,
it sits alongside them.

Client-side role and lifecycle checks (in hooks and `lib/`) are **UX only** and
are never sufficient authorisation — any authenticated, authorized client can
bypass them with direct SDK calls. The only thing standing between a client and
the data is the rules file.

## Authentication & Membership — Implemented

- Firebase Auth **email/password** sign-in only. The Create Account and Forgot
  Password screens are stubs; users are provisioned manually (Auth user +
  matching `users/{uid}` document).
- Membership and role live on the **`users/{uid}` Firestore document**
  (`companyId`, `role`). Security rules authorize every company-scoped request
  by `get()`-ing that document and comparing its `companyId` to the path.
- **Firebase Auth custom claims are NOT implemented.** No rule or UI guard reads
  `request.auth.token.role`/`companyId`. Any doc that says otherwise is stale.
- Users can read their own `users/{uid}` document and **nothing else**. **Every
  client write to `users/{uid}` is blocked — `create`, `update` and `delete`
  alike.** Because rules trust that document's `role` and `companyId`, a
  client-writable profile meant self-promotion and cross-tenant access; the
  document is now **client-read-only** (ADR-27). Profiles are **provisioned out
  of band** — Firebase console or admin tooling, using admin credentials, which
  bypass rules entirely. There is deliberately **no harmless-field allow-list**
  (no profile-editing feature exists to need one) and **no admin management of
  other users** (`company_admin` has no special power over this collection).
  Automated coverage: `frontend/tests/rules/users.rules.test.js`.
- **This prevents future tampering; it does not revert past tampering.** Any
  `role`/`companyId` already stored remains authoritative — see Deferred
  Control 8.
- Client route protection: `ProtectedRoute` redirects signed-out users to
  `/login`; `AuthLayout` redirects signed-in users into the app. There is no
  per-role UI gating yet.

## Current Rules by Collection

Shared pattern: *read* requires being an authenticated member of the company in
the path; *write* additionally requires role ∈ {`company_admin`,
`project_manager`, `qs`} (called "financial roles" below); *delete* is blocked
everywhere. **Contacts and counters are exceptions: reads are also restricted
to financial roles.**

| Path | Read | Create/Update | Delete |
|---|---|---|---|
| `users/{uid}` | own doc only | **blocked** — client-read-only; provisioned out of band | **blocked** |
| `companies/{companyId}` | company member | **`company_admin`, four currency fields only** (`countryCode`, `baseCurrency`, `currencyUpdatedAt`, `currencyUpdatedBy`); create blocked | blocked |
| `…/projects/{id}` | company member | `company_admin`, `project_manager`; **`qs`: `currencyLocked` false→true only** | blocked |
| `…/costCodes/{id}` | company member | financial roles | blocked — deactivate via `isActive` |
| `…/contacts/{id}` | **financial roles only** | financial roles | blocked — archive via `isActive` |
| `…/projects/{id}/budgetLines/{id}` | company member | financial roles | blocked |
| `…/projects/{id}/boqItems/{id}` | **financial roles only** | financial roles, **create active-only; transitions, post-void immutability and the `amount == quantity × rate` invariant rules-enforced** | blocked — void via status |
| `…/projects/{id}/purchaseOrders/{id}` | company member | financial roles | blocked — cancel via status |
| `…/projects/{id}/progressClaims/{id}` | company member | financial roles | blocked — reject via status |
| `…/projects/{id}/supplierInvoices/{id}` | **financial roles only** | financial roles | blocked — cancel via status |
| `…/projects/{id}/clientInvoices/{id}` | **financial roles only** | financial roles, **create draft-only; transitions and issued-immutability rules-enforced** | blocked — void via status |
| `…/projects/{id}/clientReceipts/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, posted-immutability and the scalar amount invariant rules-enforced** | blocked — void via status |
| `…/projects/{id}/supplierPayments/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, posted-immutability and the scalar amount invariant rules-enforced** | blocked — void via status |
| `…/projects/{id}/supplierCreditNotes/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, posted-immutability, the header cent invariant, AND the target-invoice checks (exists, posted, zero retention, supplier/currency match, grossTotal ≤ payableTotal) rules-enforced via a `get()` on the target at create, draft edit, and posting** | blocked — void via status |
| `…/projects/{id}/variations/{id}` | **financial roles only** | financial roles; **the originating-RFI link (`originRfi*`) is rules-verified via a `get()` on the same-project RFI when created or changed and frozen once the variation leaves `draft` — nothing else on the document is lifecycle-enforced** | blocked — reject/withdraw via status |
| `…/projects/{id}/tenderPackages/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, issued-scope freeze, the closingDate/notes carve-out, and award integrity (bid exists · same package · received · name snapshot · once) rules-enforced** | blocked — cancel via status |
| `…/projects/{id}/tenderBids/{id}` | **financial roles only** | financial roles, **create received-only against an issued same-project package with a real supplier/subcontractor contact; edits/voids only while the package stays issued; bids freeze on award/cancel** | blocked — void via status |
| `…/projects/{id}/forecastLines/{id}` | **financial roles only** | financial roles | blocked — clear via `null`, never deleted |
| `…/projects/{id}/cashFlowLines/{id}` | **financial roles only** | financial roles, **create active-only; transitions and post-void immutability rules-enforced** | blocked — void via status |
| `…/projects/{id}/commercial/baseline` | **financial roles only** | financial roles | blocked — the single baseline doc is never deleted |
| `…/projects/{id}/activities/{id}` | **`company_admin`, `project_manager`, `qs`** | **`company_admin`, `project_manager` ONLY — `qs` is READ-ONLY**; shape, closed status set, date/milestone/percentage invariants, cancellation branch and cancelled-terminality rules-enforced | blocked — cancel via status |
| `…/projects/{id}/drawings/{id}` | **any company member** — including `subcontractor` and `client` | **`company_admin`, `project_manager` only — QS excluded**; born-empty create, four `hasOnly` update shapes, +1 revision count, non-whitespace withdraw reason | blocked — withdraw via status |
| `…/projects/{id}/drawings/{id}/revisions/{id}` | **any company member** | same drawing writers; **file and authored identity immutable**, exact `storagePath` required, legal transitions only | blocked — a revision is never deleted |
| `…/projects/{id}/documents/{id}` | `internal` → financial roles; `project` → **any company member** | financial roles; **file identity immutable**, three `hasOnly` update shapes, non-whitespace withdraw reason | blocked — withdraw via status |
| `…/counters/{id}` | financial roles | financial roles | blocked |
| `…/projects/{id}/counters/{id}` | financial roles | financial roles — **the per-project RFI counter** (`rfis`); +1 semantics NOT enforced | blocked |
| `…/projects/{id}/rfis/{id}` | **`company_admin`, `project_manager`, `qs`** | same three roles; **create draft-only; the forward-only lifecycle (no reopen, answered cannot cancel, closed/cancelled terminal), the question-block freeze from `open`, the management freeze from `answered`, the raise gate (assignee + due date), `answerDate`/`dueDate >= raisedDate`, and referenced drawing + revision / document EXISTENCE are all rules-enforced** | blocked — cancel via status (draft/open only) |

Contacts reads are deliberately tighter than the shared pattern: the directory
holds third-party PII (names, phones, emails, ABNs, payment terms), so
`subcontractor` and `client` users must not read the company's full contact
book. Financial documents still render supplier identity for those roles via
the `supplierName` snapshot on POs/claims — no contact read required.

**Supplier invoices reads are likewise restricted to financial roles** (tighter
than the POs/claims read pattern): the accounts-payable register exposes supplier
billing detail, so `subcontractor` and `client` users must not read it.

## Client Invoices — deliberately stricter than every other collection

**Reads are restricted to financial roles.** Client invoices expose contract
revenue, client PII (legal name, ABN, billing address, email, phone), and — read
against the Current Contract Sum — the project's implied margin position, so
`subcontractor` and `client` users must not read them. In this foundation a
`client`-role user has **no** access to their own invoices; a client portal is
separate, later work with its own scoping design (see Deferred Control 10).

**This is the first collection whose lifecycle is enforced by Firestore rules.**
Everywhere else, transition legality and post-commit immutability are
client-enforced only (Deferred Controls 1 and 2). Here both are rules-enforced,
because the client-invoice lifecycle is small enough to express **without any
cross-document read**, and an invoice issued to a client is an outward-facing
revenue document. **This asymmetry is intentional and is the intended future
standard** for POs, claims, supplier invoices, and variations — those remain
client-enforced until a hardening pass or a trusted backend lands.

*Rules-enforced:*

- `create` only with `status: 'draft'`, `docType: 'invoice'`, a shape-valid
  `currency`, `createdBy == request.auth.uid`, `createdAt == request.time`, and
  **null lifecycle stamps** (`issuedAt`/`issuedBy`/`voidedAt`/`voidedBy`) — they
  cannot be forged at creation.
- **Every** update must preserve `invoiceNumber`, `currency`, `createdAt`,
  `createdBy`, `docType`, and `revision`, and must stamp
  `updatedBy == request.auth.uid` and `updatedAt == request.time`.
- **Draft edits** may change content but not the status, and may not forge a
  lifecycle stamp.
- **`draft → issued`** may affect **only** `status`, `issuedAt`, `issuedBy`,
  `updatedAt`, `updatedBy`, with `issuedBy == request.auth.uid` and
  `issuedAt == request.time`. Issuing is therefore necessarily a **separate
  operation** after the draft is saved — it can carry no content change.
- **`draft|issued → void`** may affect **only** `status`, `voidedAt`, `voidedBy`,
  `voidReason`, `updatedAt`, `updatedBy`, with `voidedBy == request.auth.uid`,
  `voidedAt == request.time`, and a **non-empty** `voidReason`.
- **Issued-invoice immutability** falls out of the above: once `status` is
  `issued`, voiding is the only permitted update and it may touch nothing else.
- **`void` is terminal**; there is no `issued → draft` and no `void → anything`.
  There is **no `paid`/`partially_paid` status** — a payment status without a
  Receipt record would be fabricated.
- `delete` is blocked for drafts as well as issued invoices.

*Client-enforced only (deferred — never describe these as enforced):*

- **Line-total consistency** (`subtotal`/`gstTotal`/`grossTotal` matching the
  lines) — rules cannot iterate or aggregate an array.
- **Available-to-Invoice and per-variation limits** — rules have no list, query,
  or count, so an aggregate over sibling documents is impossible. Over-invoicing
  is warned with an explicit acknowledgement, never blocked, and **two users can
  concurrently consume the same remaining availability** (Deferred Control 14).
- **Company-wide invoice-number uniqueness** — the transaction prevents
  concurrent collision, but the counter is client-writable (Deferred Control 6).
- **Approved-variation linkage validity** — verifying each line's `variationId`
  points at an approved *client* variation would need a `get()` per array
  element; rules cannot iterate `lineItems`.
- **Creator ≠ issuer segregation** — nothing stops the drafter issuing their own
  invoice (Deferred Control 4 posture).

**Constrapp does not produce a compliant Australian Tax Invoice.** The company
document holds no legal name, ABN, address, or tax number, and the company rules
permit updating only the four currency fields — so the supplier-identity content
an ATO tax invoice requires cannot be captured today. This branch therefore ships
**no printable invoice, no PDF, no email, and no "Tax Invoice" labelling**; the
register records what was invoiced and carries an optional
`externalInvoiceReference` pointing at the document the client actually received.
Adding company legal/tax identity requires new fields, a Company Settings
section, and a rules change widening the company `hasOnly([...])` allow-list —
which would be the **second** grant of client write access to the company
document and needs its own security review.

## Client Receipts — cash records, rules-enforced lifecycle

**Reads are restricted to financial roles.** A receipt exposes the project's cash
position, bank references, and unallocated balances, so `subcontractor` and
`client` users must not read them. **A future client portal must never expose a
receipt's `allocations`, `unallocatedAmount`, `bankReference`, or `notes`** — a
client seeing which of their payments we left unallocated, or our internal
allocation decisions, is a commercial exposure. That portal is separate, later
work with its own scoping design (Deferred Control 10).

**The lifecycle is rules-enforced**, following `clientInvoices` as the standard
(ADR-22/ADR-23):

- `create` only with `status: 'draft'`, `docType: 'receipt'`, **non-empty
  `clientId` and `clientName`** (uniquely among counterparty links, these are
  never null — a receipt with no client is not a record), a shape-valid
  `currency` and `'YYYY-MM-DD'` `receiptDate`, a non-empty bounded
  `paymentMethod`, `allocations` as a list of at most 100, `createdBy ==
  request.auth.uid`, `createdAt == request.time`, and **null lifecycle stamps**.
- **The scalar amount invariant**: `amount > 0`, `allocatedTotal >= 0`,
  `unallocatedAmount >= 0`, and
  `allocatedTotal + unallocatedAmount == amount`, compared in **whole cents** via
  `math.round(v * 100)`. Exact float equality would reject legitimate money
  (`0.10 + 0.20` is `0.30000000000000004`), so both sides are compared as
  integers — a *representation fix, not a loosened invariant*: any discrepancy of
  one cent or more still fails. This prevents a receipt **claiming** more
  allocation than the cash it holds.
- **Every** update must preserve `receiptNumber`, `currency`, `createdAt`,
  `createdBy`, `docType`, and `revision`, and must stamp `updatedBy ==
  request.auth.uid` and `updatedAt == request.time`.
- **Draft edits** may change content (including allocations) but not the status,
  must still satisfy the full shape and the scalar invariant, and may not forge a
  lifecycle stamp.
- **`draft → posted`** may affect **only** `status`, `postedAt`, `postedBy`,
  `updatedAt`, `updatedBy`, with `postedBy == request.auth.uid` and
  `postedAt == request.time`. Posting is therefore necessarily a **separate
  operation** — the amount and allocations that were reviewed are the ones
  committed.
- **`draft|posted → void`** may affect **only** `status`, `voidedAt`, `voidedBy`,
  `voidReason`, `updatedAt`, `updatedBy`, with a **non-whitespace** `voidReason`
  (`voidReason.trim().size() > 0`).
- **Posted-receipt immutability** falls out of the above: voiding is the only
  permitted update.
- **`void` is terminal**; `delete` is blocked for drafts and posted receipts
  alike.

*Client-enforced only (deferred — never describe these as enforced):*

- **The shape of each `allocations[]` element** — rules cannot iterate or index
  into an array, so `clientInvoiceId`, `invoiceNumber`, the per-allocation
  `> 0` rule, and the no-duplicate-invoice rule are all unverified.
- **`allocatedTotal` matching the sum of `allocations[]`** — same limitation.
  Only the scalar invariant above is enforced.
- **That an allocated invoice exists, is `issued` (not draft/void), and belongs
  to the selected client** — each would need a `get()` per array element.
- **Invoice remaining balance / over-allocation** — see Deferred Control 16.
- **That `receiptDate` is not in the future.** Rules check only the
  `'YYYY-MM-DD'` shape; the "cannot post a future-dated receipt" rule is client
  -side, so a direct SDK call can post one.
- **Payment-method membership** of the app's enum — validated by shape only, to
  avoid the enum drift ADR-21 records for currency codes.
- **Business truth** — that the money was genuinely received at all.

## Supplier Payments — cash records, rules-enforced lifecycle

**Reads are restricted to financial roles.** A payment exposes the project's cash
position, bank and remittance references, supplier pricing, and unallocated
balances, so `subcontractor` and `client` users must not read them. **A future
client or subcontractor portal must never expose Supplier Payments at all** —
and specifically never a payment's `allocations`, `unallocatedAmount`,
`bankReference`, `remittanceReference`, `notes`, or the supplier pricing they
reveal. A subcontractor seeing what other trades were paid, or when, is a direct
commercial exposure; a client seeing supplier costs exposes the project's margin.
That portal is separate, later work with its own scoping design (Deferred
Control 10).

**The lifecycle is rules-enforced**, following `clientInvoices`/`clientReceipts`
as the standard (ADR-22/ADR-23/ADR-24):

- `create` only with `status: 'draft'`, `docType: 'payment'`, **non-empty
  `supplierId` and `supplierName`** (never null — unlike supplier *invoices*,
  which may carry a legacy `supplierId: null`, a new payment always carries a
  real link), a shape-valid `currency` and `'YYYY-MM-DD'` `paymentDate`, a
  non-empty bounded `paymentMethod`, `allocations` as a list of at most 100,
  `createdBy == request.auth.uid`, `createdAt == request.time`, and **null
  lifecycle stamps**.
- **The scalar amount invariant**: `amount > 0`, `allocatedTotal >= 0`,
  `unallocatedAmount >= 0`, and `allocatedTotal + unallocatedAmount == amount`,
  compared in **whole cents** via `math.round(v * 100)` — identical to the
  `clientReceipts` rule and mirrored by `lib/payments.js → toCents()`. A
  representation fix, not a loosened invariant: a one-cent discrepancy still
  fails. This prevents a payment **claiming** more allocation than the cash it
  moved.
- **Every** update must preserve `paymentNumber`, `currency`, `createdAt`,
  `createdBy`, `docType`, and `revision`, and must stamp `updatedBy ==
  request.auth.uid` and `updatedAt == request.time`.
- **Draft edits** may change content (including the supplier and the
  allocations) but not the status, must still satisfy the full shape and the
  scalar invariant, and may not forge a lifecycle stamp.
- **`draft → posted`** may affect **only** `status`, `postedAt`, `postedBy`,
  `updatedAt`, `updatedBy`, with `postedBy == request.auth.uid` and
  `postedAt == request.time`. Posting is therefore necessarily a **separate
  operation** — the amount and allocations that were reviewed are the ones
  committed.
- **`draft|posted → void`** may affect **only** `status`, `voidedAt`, `voidedBy`,
  `voidReason`, `updatedAt`, `updatedBy`, with a **non-whitespace** `voidReason`
  (`voidReason.trim().size() > 0`).
- **Posted-payment immutability** falls out of the above: voiding is the only
  permitted update.
- **`void` is terminal**; `delete` is blocked for drafts, posted, and void
  payments alike.

*Client-enforced only (deferred — never describe these as enforced):*

- **The shape of each `allocations[]` element** — rules cannot iterate or index
  into an array, so `supplierInvoiceId`, `invoiceNumber`,
  `supplierInvoiceNumber`, the per-allocation `> 0` rule, and the
  no-duplicate-invoice rule are all unverified.
- **`allocatedTotal` matching the sum of `allocations[]`** — same limitation.
  Only the scalar invariant above is enforced.
- **That an allocated invoice exists, is `posted` (not draft/approved/cancelled),
  belongs to this project, and belongs to the selected supplier** — each would
  need a `get()` per array element. The **legacy `supplierId: null` name match**
  is likewise unverified.
- **That allocations use `payableTotal` rather than `grossTotal`, and that
  retention is excluded** — rules cannot read the invoice at all, so the payable
  basis and the retention exclusion are client-side facts.
- **Invoice remaining payable / over-reconciliation** — see Deferred Control 18.
- **That `paymentDate` is not in the future.** Rules check only the
  `'YYYY-MM-DD'` shape; the "cannot post a future-dated payment" rule is
  client-side, so a direct SDK call can post one.
- **Payment-method membership** of the app's enum — validated by shape only, to
  avoid the enum drift ADR-21 records for currency codes.
- **Business truth** — that the money genuinely left the bank account.

**⚠️ Deliberate asymmetry with `supplierInvoices`.** This block enforces
lifecycle legality and post-`posted` immutability; the `supplierInvoices` block
still enforces neither (Deferred Controls 1–2), and the Supplier Payments branch
did **not** harden it. The consequence is real and accepted: a direct-SDK caller
can cancel a posted supplier invoice that a payment has already settled, or forge
`status: 'paid'` on one. Constrapp surfaces the first as an **allocation
exception** on both views rather than auto-reversing, and deliberately keeps
`paid` inside `SI_COUNTING_STATUSES` so the second cannot make a real cost vanish
from Invoiced and Actual (ADR-24). Neither is prevented.

## Cash Flow — one authored collection, rules-enforced lifecycle

**Reads are restricted to financial roles.** The Cash Flow view aggregates both
cash directions into the project's cash position, funding profile, and — read
beside the commercial-context panel — its implied margin standing, so
`subcontractor` and `client` users must not read it. **A future client or
subcontractor portal must never expose Cash Flow at all** (Deferred Control 10).

Cash Flow reads `clientReceipts`, `supplierPayments`, `clientInvoices`,
`supplierInvoices`, and the Budget/Forecast/Margin sources — all already
restricted by their own blocks — and **writes only `cashFlowLines`**. No other
financial document is ever mutated by it.

**The `cashFlowLines` lifecycle is rules-enforced**, following
`clientInvoices`/`clientReceipts`/`supplierPayments` as the standard, but with
**two states rather than three**: a forecast line is a planning record, not a
transaction, so it has no financial commit point.

- `create` only with `status: 'active'`, `basis: 'gross'`, `revision: 1`, a
  valid `'YYYY-MM'` `monthKey`, `direction in ['in','out']`, `amount > 0`,
  `sourceAmountExGst` null-or-non-negative, a bounded non-empty `sourceType`, a
  **non-whitespace `description`**, a shape-valid `currency`, `createdBy ==
  request.auth.uid`, `createdAt == request.time`, and **null void stamps**.
- **The cost-code pairing**: `costCodeId` and `costCodeName` must be null/`''`
  together or both non-empty together.
- **Every** update must preserve `currency`, `createdAt`, `createdBy`, `basis`,
  and `revision`, and must stamp `updatedBy == request.auth.uid` and
  `updatedAt == request.time`.
- **Active edits** may change content (month, direction, source, amounts, cost
  code, description) but not the status, must satisfy the full shape, and may
  not forge a void stamp.
- **`active → void`** may affect **only** `status`, `voidedAt`, `voidedBy`,
  `voidReason`, `updatedAt`, `updatedBy`, with `voidedBy == request.auth.uid`,
  `voidedAt == request.time`, and a **non-whitespace** `voidReason`.
- **`void` is terminal**; `delete` is blocked for active and void lines alike.

`direction` and `basis` are validated as **literal closed sets** — a deliberate
exception to the ADR-21 no-enum-in-rules precedent, because they are two-value
and one-value sets that structurally determine which cash column an amount lands
in and whether it is a cash figure at all. Adding a `basis` therefore *requires*
a rules change and a security review, which is the intended friction.

*Client-enforced only (deferred — never describe these as enforced):*

- **That `monthKey` is not a PAST month.** Rules validate the `'YYYY-MM'` shape
  and have no calendar to compare against the caller's local date, so a direct
  SDK call can create or retime a line into a past month. In the app this is
  blocked (`lib/cashFlow.js → validateCashFlowLineDraft`), and a line that
  becomes stale as the calendar advances is excluded from every total and
  surfaced for retiming or voiding.
- **`sourceType` membership** of the app's list, and every per-type conditional
  — that cost-side types carry a cost code, that coverage types carry a
  `sourceAmountExGst`, and that `manual` lines carry none. Validated by shape
  only, to avoid the enum drift ADR-21 records.
- **That `costCodeId` names a real cost code** in this company.
- **Any source remaining balance, and therefore aggregate over-coverage** —
  rules have no list, query, or count, so several lines can together claim more
  ex-GST coverage than a source holds, and **two users can time the same
  balance concurrently**. Over-coverage is warned with an explicit
  acknowledgement, never blocked (Deferred Control 19).
- **Duplicate source timing** across sibling lines.
- **That `amount` is a correct gross of `sourceAmountExGst`** — per-line tax
  codes make a flat conversion unreliable, so the gross figure is authored and
  the "+ GST 10%" button is an explicit suggestion only.
- **Timing realism, forecast completeness, period locking, and business truth.**
  An active line remains **freely rewritable after being reported**: there is no
  period lock, no immutable snapshot, and no history beyond last-write
  `updatedAt`/`updatedBy` (Deferred Control 7 territory).

## Tenders — competitor pricing, rules-enforced lifecycle

**Reads are restricted to financial roles on BOTH collections.** A tender bid
**is competitor pricing**, and a package read beside its bids reveals the whole
competitive position — so `subcontractor` and `client` users must not read
either collection. A subcontractor can therefore **never see a competitor's
tender pricing** (nor their own bid — there is no bidder portal; Deferred
Control 10 posture). `super_admin` has no special power here, as everywhere.

**Both lifecycles are rules-enforced** (the ADR-22 standard). Packages:
create draft-only with null stamps and empty award/cancel fields; draft edits
only while draft; `draft → issued` is stamp-only and **freezes
name/description/scope/costCodes**; issued edits may touch **only
`closingDate` and `notes`** (`affectedKeys().hasOnly`); `issued → awarded`
touches only the award fields, forces `awardedBy == request.auth.uid` and
`awardedAt == request.time`, and — via `get()` on the bid document — verifies
the awarded bid **exists in this project, belongs to this package
(`bid.tenderPackageId == packageId`), is `received`**, and that
`awardedBidderName` equals the bid's own `bidderName`; because the branch
requires the current status to be `issued`, a **second/concurrent award is
rejected** (Firestore serialises writes per document). `draft|issued →
cancelled` needs a non-whitespace reason. Awarded and cancelled are terminal;
delete is blocked in every status.

Bids: create only as `received` (no draft state — a bid is a transcription),
with `createdBy == request.auth.uid`, `createdAt == request.time`, null void
stamps, and — via `get()`s — a **same-project parent package whose status is
`issued`**, a `tenderNumber` equal to that package's own, and a
`bidderContactId` naming a **real contact whose `contactTypes` include
supplier or subcontractor**, with `bidderName` equal to that contact's
`displayName` (this contact verification deliberately **exceeds** the
supplierPayments precedent, which leaves `supplierId` existence unverified — a
fabricated bidder in a competitive record is worth the extra `get()`).
Received edits and voids are permitted **only while the package remains
`issued`** — once it is awarded or cancelled, **every bid write is rejected**,
which is what freezes the awarded bid's lines and makes the derived award
value trustworthy. Void is terminal; delete is blocked.

**⚠️ NO STORED TOTALS — deliberate.** Bids store no `bidTotal` and packages
store no `awardTotal`: rules cannot iterate or sum an array, so a stored
header total would be unverifiable and forgeable by direct SDK call (the
header-vs-lines integrity problem previously identified in Credit Notes).
Every displayed figure derives at read time through the **central validity
gate** (`lib/tenders.js → assessBid`): a bid with any malformed line — or whose
finite lines total beyond representable range — is invalid as a whole, total
`null`, never a partial sum, never $0, never clamped, and is excluded from the
lowest-bid ranking, the budget comparison, the per-cost-code matrix, and the
**Awarded Bid Value**, while remaining visible and flagged. Malformed documents
**fail safely instead of being trusted.**

**⚠️ The award TRANSITION on a malformed bid is client-blocked only — state
this precisely.** Rules verify the awarded bid's *identity and status*
(exists · same package · `received` · name snapshot · single award) but
**cannot read its `lineItems`**, so a financial-role caller using the SDK
directly **can award a bid whose embedded lines are malformed**. The app
refuses to (`awardBlockedReason`), but that is UX, not a boundary. The
consequence is deliberately bounded and must not be overstated in either
direction: the award record is created, but **no malformed figure is ever
trusted anywhere** — `awardedBidValue` returns *unavailable*, the package
renders "awarded bid missing or malformed" instead of a number, and because an
award writes no PO and no financial value at all, **nothing downstream moves**.
Preventing the transition itself is not achievable in this architecture and is
not claimed; the alternative — a rules-checkable stored total — was rejected
precisely because it would let the same caller forge a *plausible* number
instead of an obviously unavailable one (ADR-32 Part 2).

*Client-enforced only (deferred — never describe these as enforced; Deferred
Control 26):*

- **The shape of each `lineItems[]` element** — rules cannot iterate an array,
  so per-line `costCodeId`/`costCodeName`/`description`/`amount` are
  unverified, including finite-number and ≥ 0 checks. **A malicious direct-SDK
  caller can create malformed embedded line data** — rules enforce
  package/status/identity/lifecycle controls, not per-line integrity. Because
  no derivation trusts a malformed bid (the validity gate above), such data
  fails safely rather than silently influencing the comparison.
- **Line cost-code containment** within the package's `costCodes`, and that any
  `costCodeId` (on packages or bid lines) names a **real, active** cost code.
- **The shape of each `costCodes[]` element** on packages.
- **One active bid per bidder per package** — bid ids are random and rules have
  no queries; two simultaneous creators can duplicate (the Deferred Control 9
  posture). The comparison shows duplicates rather than hiding them.
- **Closing-date enforcement — there is none, anywhere.** The closing date is
  informational only; rules validate its `'YYYY-MM-DD'` shape and nothing else,
  and a bid can be recorded after it (in the app and by direct SDK alike). The
  UI states this wherever the date appears.
- **`bidDate` realism** — shape only.
- **Business truth** — that the transcribed prices match the paper bid.

**Forecast Lines reads are restricted to financial roles** — deliberately tighter
than the company-member `budgetLines` read. The Forecast Cost to Complete data
exposes expected project overruns and implied margin (Forecast Final Cost,
Variance to Budget), so `subcontractor` and `client` users must not read it. This
is a considered asymmetry with budget lines (which are company-member readable),
matching the more conservative posture already applied to Variations, Supplier
Invoices, and Contacts. Delete is blocked — clearing an input writes `null`; the
document is never deleted.

**Project Commercial Baseline reads are restricted to financial roles.** The
baseline holds the Original Contract Value and drives Project Margin (Forecast
Revenue, Forecast Gross Profit, Margin %), so `subcontractor` and `client` users
must not read it — the same conservative posture as Variations, Supplier Invoices,
and Forecast Lines. This is precisely why the baseline is a **separate document**
rather than fields on the Project document (which is company-member readable):
Firestore rules apply one read rule per document, so keeping contract value off the
Project doc is what lets it stay financial-role-only without locking down the whole
Projects collection. The rule matches only the deterministic `baseline` document id,
so no arbitrary `commercial/*` documents are permitted. Delete is blocked — the
baseline is edited in place, never deleted. **Client-enforced only (deferred):**
non-negative amounts and Original-Approved-Budget immutability once set are validated
in the hook only and can be bypassed by a direct SDK call by a financial-role user
(ADR-14 posture); server-side enforcement is deferred.

**Variations reads are also restricted to financial roles.** The register exposes
client contract revenue (Client Variations) and supplier pricing (Supplier
Variations), so `subcontractor` and `client` users must not read it. In this
foundation they receive **no** variation access at all; client- and
subcontractor-scoped visibility (e.g. a client seeing their own head-contract
variations) is future work alongside the deferred scoping controls below.

**The originating-RFI link is the ONE rules-enforced content control on a
variation (ADR-34) — and deliberately the only one.** A variation may cite zero
or one RFI in three scalar fields (`originRfiId` + frozen `originRfiNumber` /
`originRfiTitle`). When that triple is **created or changed**, rules require
the RFI to exist at `companies/{c}/projects/{p}/rfis/{originRfiId}` — so an id
from another project or another company is simply not there — with status
`open`, `answered` or `closed`, and both snapshots to **equal** the RFI's
`rfiNumber` and `title` (honest to verify: the `rfis` block keeps the number in
`corePreserved()` and freezes the title for life at raise). "Changed" is a
**value** comparison with absent keys read as `null`, so legacy documents and
the hook's partial transition writes never register as a change, and an
**unchanged link is never re-validated** — an RFI cancelled *after* it was
linked cannot block later draft edits or lifecycle transitions; the link is
historical evidence and survives. A change is permitted **only while the stored
status is `draft`**; from `submitted` onward the triple is immutable by rules.
**Not enforced (client-only, never present otherwise):** that the RFI
genuinely caused the variation; and everything Deferred Controls 1 and 2 list
for the rest of the variation — status legality, post-submit immutability of
amounts, lines and text — which this feature does **not** change.

Note the asymmetry: `qs` can write cost codes, budget lines, POs, and claims but
**not** projects — with one deliberate, narrowly-scoped exception described below.

## Bill of Quantities — the internal estimate, rules-enforced lifecycle

**Reads are restricted to financial roles.** The BOQ is the project's internal
estimate — measured quantities and the rates the contractor expects to pay —
so `subcontractor` and `client` users must not read it: a bidder who can read
the estimate prices against it. This is the tightest-audience posture in the
app to date, and **any future tender or bidder-facing surface must never expose
BOQ rates at all.**

BOQ items feed **no financial figure**. The hook writes only `boqItems` (plus
the currency ratchet inside the create transaction); Budgeted, Committed,
Actual, Invoiced, Forecast, Margin, and Cash Flow are untouched, and the
BOQ-vs-budget comparison is derived at read time in `lib/boq.js`, never stored
(ADR-32 Part 1).

**The `boqItems` lifecycle is rules-enforced** — the two-state `cashFlowLines`
shape (a BOQ item is a preconstruction record with no financial commit point):

- `create` only with `status: 'active'`, `revision: 1`, a non-whitespace
  `description`, a bounded non-empty `unit`, `quantity >= 0`, a **mandatory**
  `costCodeId` + non-empty `costCodeName` snapshot, a shape-valid `currency`,
  `createdBy == request.auth.uid`, `createdAt == request.time`, and **null
  void stamps**.
- **The pricing invariant** — the one arithmetic guarantee rules can give
  here: `rate` and `amount` are **both null** (unpriced) or **both
  non-negative numbers** with `cents(quantity × rate) == cents(amount)`
  (whole-cent comparison, the `clientReceipts` idiom — exactly equivalent to a
  half-cent tolerance). A priced item can never carry an amount that disagrees
  with its own quantity × rate, and `0` can never be smuggled in to mean
  "unpriced".
- **Every** update must preserve `currency`, `createdAt`, `createdBy`, and
  `revision`, and must stamp `updatedBy == request.auth.uid` and
  `updatedAt == request.time`.
- **Active edits** may change content (measurement, pricing, cost code,
  labels) but not the status, must satisfy the full shape, and may not forge a
  void stamp.
- **`active → void`** may affect **only** `status`, `voidedAt`, `voidedBy`,
  `voidReason`, `updatedAt`, `updatedBy`, with `voidedBy == request.auth.uid`,
  `voidedAt == request.time`, and a **non-whitespace** `voidReason`.
- **`void` is terminal**; `delete` is blocked for active and void items alike.

*Client-enforced only (deferred — never describe these as enforced; Deferred
Control 26):*

- **That `costCodeId` names a real, active cost code** in this company —
  validated by shape only (the ADR-21 no-enum reasoning).
- **That `unit` matches the cost code's unit**, or any unit convention at all.
- **Duplicate items** (same code/section/item number) across siblings — rules
  have no list, query, or count.
- **BOQ ↔ Budget consistency — deliberately none.** The BOQ and the Approved
  Budget are independent records compared only at read time; neither validates
  the other, and no reconciliation is stored.

## Company Country & Currency

**Company document — four fields, not the document.** The company document was
previously `allow write: if false`. It now permits `company_admin` to **update**
`countryCode`, `baseCurrency`, `currencyUpdatedAt`, and `currencyUpdatedBy`, and
nothing else: the rule requires
`request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])`, so
`name` and every other field stay immutable from the client. **Create and delete
remain blocked** — opening `create` would let any authenticated user mint
companies. Codes are validated by **shape** (`^[A-Z]{2}$` / `^[A-Z]{3}$`) rather
than against an enum, because an enum duplicated into this manually-published
file would drift out of sync with `frontend/src/lib/currency.js` and start
rejecting valid writes; the *known-code* check is client-side only.

**⚠️ Escalation note.** Deferred Control 8 below records that users can write
their own `users/{uid}` document, including `role`. Because rules trust that
document, **any authenticated user can currently self-assign `company_admin`**,
so the `company_admin` gate on the currency fields is not a real boundary
against a determined insider today. This is pre-existing (ADR-14: all users are
hand-provisioned insiders while the product is unlaunched), but this foundation
is the first to grant *any* client write access to the company document, and it
widens the blast radius of that gap from reading another company's data to
rewriting its base currency. Keeping `create`/`delete` blocked and scoping the
update to four fields bounds it; locking down self-managed `role`/`companyId`
remains a trusted-backend requirement.

**Project currency ratchet — what is and is not enforced.** `project.currency`
is the display authority for every money figure on a project, so changing it
after amounts exist would **relabel** them without converting them.

*Rules-enforced:* once `project.currencyLocked` is `true`, rules reject any
change to a **well-formed** stored `currency` — including deleting or blanking
it — **and** any attempt to set `currencyLocked` back to `false`. Codes are
shape-validated on create and update. Reads stay company-member level so every
role can render amounts with the correct label.

*The one carve-out — legacy initialisation.* `currencyLocked` and `currency` are
separate fields and the lock write is a lone `currencyLocked: true` (see **The
`qs` ratchet rule** below), so a project predating this foundation can be
**locked while storing no currency at all**, rendering through the company base
currency. Company Settings exists to repair that by pinning the label the
project is already displaying, and a strict
`request.currency == resource.currency` comparison rejected that repair as a
relabel — a defect confirmed against live data (`''` → `'AUD'` failed with
*Missing or insufficient permissions*), leaving such projects permanently
unpinnable. `currency` is therefore frozen while locked **except** when the
stored value is not a well-formed ISO 4217 code, in which case the **first**
explicit code may be written.

This cannot become a relabel. The carve-out's precondition is a property of the
**stored** document, and the only write it permits is the one that destroys that
precondition: the moment a well-formed code lands the equality branch takes over
for every subsequent write, so `'AUD'` → `'NZD'` and `'AUD'` → deleted/blank are
both rejected. It is strictly one-way, like the lock itself, and it is **not** a
general "locked projects may edit currency" exception. It also grants no new
audience — it lives inside the `company_admin`/`project_manager` branch, so the
`qs` rule below is untouched. Automated proof:
`frontend/tests/rules/projects.rules.test.js`.

*Client-enforced (deferred — Deferred Control 12):* **deciding that the lock
should engage.** Firestore Security Rules offer `get()`/`exists()` on a known
document path only — there is no list, query, or count — and budget lines, POs,
claims, invoices, and variations all use random document ids. **No rule can
determine whether a project holds financial records.** The evidence check lives
in `lib/currency.js` (`monetaryLockReasons`), and every hook that writes monetary
data engages the flag **inside the same Firestore transaction as the record
itself** (`hooks/projectCurrencyLock.js` → `stageProjectCurrencyLock`), so the
record and the lock commit or roll back together — a project can never end up
holding amounts with a still-changeable currency because a separate lock write
failed. The honest guarantee is therefore asymmetric: a client that bypasses the
app entirely can **decline to set** the lock, but no client can **unset** it or
change a locked currency, and no *in-app* write can leave the two out of step.

**The `qs` ratchet rule.** `qs` deliberately has **no** general project write
access, yet `qs` can write budget lines, POs, claims, invoices, variations, and
forecast lines — all of which must engage the lock. `qs` is therefore granted
exactly one project permission: flipping `currencyLocked` from `false`/absent to
`true`, with
`request.resource.data.diff(resource.data).affectedKeys().hasOnly(['currencyLocked'])`.
That single-key diff is what prevents a `qs` user from touching `currency`,
`name`, `budget`, `status`, dates, or any other project field through this rule.
The lock write carries no audit stamps for exactly this reason — adding them
would force the rule to be widened.

**Tax is not currency.** This foundation makes currency **display** configurable.
It does **not** make tax calculation configurable: `GST_RATE` is a flat
Australian 10% and the "GST 10%" labels on POs, claims, invoices, and variations
are Australian. Selecting NZ, ZA, US, GB, or any other country does **not** make
Constrapp tax-compliant there; Company Settings states this explicitly whenever
the chosen country is not `AU`. Country-specific tax configuration is a separate
future foundation.

## Drawings — deliberately the BROADEST read in the app

Every other project-scoped collection either gates reads on the three financial
roles or on company membership for figures that are not commercially sensitive.
Drawings go further: `allow read: if companyMember()` with **no role list**, so
`subcontractor` and `client` users read drawing masters and revisions.

**This is intentional, and it is the opposite of the financial reasoning.** A
drawing is operational site information. The failure mode of withholding it —
someone building from a sheet they were never given, or from a superseded one
they still have — is worse than the failure mode of over-sharing it. Commercial
sensitivity lives in the financial collections, which remain closed.

**Writes stay narrow.** `company_admin` and `project_manager` only. **QS is
deliberately excluded**: a QS measures from drawings but does not control what
the site builds from. QS *does* have general-document write, because a QS owns
contracts, subcontracts and specifications.

**What the rules enforce (automated, proven by `tests/rules/drawings.rules.test.js`):**

- a master is **born empty** — no pointer, no mirrored code/date, no count, no
  forged withdrawal stamps
- exactly four master update shapes, each `hasOnly`-restricted: identity edit,
  promotion, reinstatement, withdrawal
- promotion moves `revisionCount` by **exactly +1**; reinstatement may not touch
  it and requires an existing current revision
- withdrawal is terminal, clears the pointer, stamps the caller and server time,
  and requires a **non-whitespace** reason
- a revision is born `current`, with a positive integer `revisionSequence`, an
  allowed content type that **agrees with `fileExt`**, a size within the 50 MB
  ceiling, and `pageCount: null` / `sheetSize: ''`
- a revision's `storagePath` must equal the **exact path derived from the
  company/project/drawing/revision IDs** — so a revision can never reference
  another tenant's bytes, another drawing's bytes, or a caller-chosen filename
- a revision's file identity **and** authored identity are immutable: every
  update branch is restricted to its own lifecycle stamps
- legal transitions only (`current→superseded`, `current→withdrawn`,
  `superseded→current`, `superseded→withdrawn`); `withdrawn` is terminal
- `delete: if false` on masters and revisions alike

**What the rules CANNOT enforce — never describe these as enforced:**

- **drawingNumber and revisionCode uniqueness.** Rules cannot query siblings.
  Both are warned in the UI and both can be defeated by concurrent creates
- **exactly one current revision.** The promotion transaction supersedes the
  previous current in the same commit, but a direct SDK caller with a writer
  role can create a second `current` sibling
- **that `currentRevisionId` names a revision that exists.** It is created in the
  same transaction, so a rules `exists()` would evaluate pre-transaction state
  and reject every legitimate promotion
- **that a reinstatement is not a promotion.** The two differ only in whether the
  target revision is newly created, which rules cannot see
- **that the mirrored `currentRevisionCode`/`IssuedDate` match the revision**
- **that the bytes at `storagePath` exist, or match the declared type and size**

## Cloud Storage — the SECOND trust boundary

`frontend/storage.rules` is a trust boundary in exactly the sense
`firestore.rules` is. The client-side checks in `lib/files.js` are a convenience
mirror and are **never** a control.

**THE PATH IS THE AUTHORITY.** Objects live at deterministic,
company-namespaced paths built from Firestore document IDs, and every object is
named `original.{ext}`:

```
companies/{companyId}/projects/{projectId}/drawings/{drawingId}/{revisionId}/original.{ext}
companies/{companyId}/projects/{projectId}/documents/{documentId}/original.{ext}
```

The uploaded filename is metadata only. **`customMetadata` is never consulted
for authorisation** — it is caller-supplied and therefore worthless as a
control.

**AUTOMATED / ENFORCED** (proven by `tests/rules/storage.rules.test.js`, 46
tests, run by `npm run test:rules` alongside the Firestore suites):

- **tenant and path isolation** — membership is resolved from `users/{uid}` via
  `firestore.get()` and compared against the `companyId` **in the object path**
- **writer roles** — drawings: `company_admin`/`project_manager`; documents:
  `company_admin`/`project_manager`/`qs`
- **allowed content type** — `application/pdf`, `image/png`, `image/jpeg` only
- **allowed object name** — must be exactly `original.{ext}` for its content
  type, so name and bytes cannot disagree
- **byte-size ceiling** — 50 MB drawings, 25 MB documents, enforced server-side
- **non-zero size** — a zero-byte upload is rejected
- **create-only immutability** — `update` and `delete` are denied on every path,
  so an object can be written once and never overwritten, re-pointed or removed
- **document visibility** — a non-internal role may read a document object only
  once its Firestore metadata **exists** and says `visibility: 'project'`
- **catch-all deny** — every other location in the bucket, including a drawing
  object nested one folder too deep, is denied
- reads grant `get` only, never `list`: nothing in the app enumerates Storage

**The upload window fails CLOSED.** Uploads are Storage-first, so a document
object exists briefly with no Firestore metadata. During that window a
non-internal role is **denied**, because visibility is not yet knowable.

**DEFERRED — not enforced, and must never be described as enforced:**

- **Malware / antivirus scanning.** Impossible client-SDK-only; needs a trusted
  backend. Rules see upload metadata, never bytes.
- **Real byte semantics.** `contentType` and `size` are declared by the uploader.
  The ceiling is enforced; the honesty of the type label is not. A caller can
  send arbitrary bytes labelled `application/pdf`.
- **Backend orphan cleanup.** Because uploads are Storage-first and delete is
  denied, an object whose Firestore write failed remains unreferenced forever.
  This is accepted: a delete permission able to tidy orphans would also let a
  client destroy an issued drawing revision.
- **Project-specific membership.** See Deferred Control 20.
- **Per-trade drawing distribution.** Every company member sees every drawing;
  there is no "issued to" list.
- **Revocation of already-issued download URLs.** A Firebase download URL is a
  bearer link. The app never persists one, but a user who copies a URL keeps
  working access until the object's token is rotated out of band — including
  after a revision is superseded or withdrawn, or a document is made internal.

## Documented Roles vs Enforced Roles

[PRODUCT.md](../PRODUCT.md) documents six product roles. The rules enforce a much
coarser model:

| Product role | Actually enforced today |
|---|---|
| `super_admin` | **No special powers** — treated as an ordinary company member (cannot even write projects) |
| `company_admin`, `project_manager` | Write access to everything writable |
| `qs` | Same, except projects |
| `subcontractor`, `client` | Read-only across the whole company — **not** scoped to their own projects/POs |

The fine-grained per-module access matrix in PRODUCT.md is product intent, not
implementation.

Since ADR-27 the enforced `role` in that table is **settable only out of band**:
`users/{uid}` is client-read-only, so no user can move themselves between the
rows above. That is what makes the table meaningful — previously any user could
place themselves in any row with a single write.

## Deferred Controls

These are known gaps, deliberately deferred (client-side checks exist in the
hooks, but any authorized user could bypass them with direct Firestore calls):

1. **Server-enforced lifecycle transitions** — rules don't validate status
   changes; `canTransition` runs client-side only. A financial-role user could
   set any status directly. Applies equally to supplier invoices (including the
   "posted invoices cannot be cancelled/unposted" rule) and to variations
   (draft → submitted → approved/rejected/withdrawn legality).
   **Exception: `clientInvoices`, `clientReceipts` and `supplierPayments`
   transitions ARE rules-enforced** — that is the intended future standard for
   the collections above. Note the live consequence of the gap: a direct-SDK
   caller can cancel a **posted** supplier invoice that a Supplier Payment has
   already settled, or forge `status: 'paid'` on one (ADR-24).
2. **Post-submission immutability** — freezing PO lines after `sent`, claim
   amounts after submission/approval, supplier invoices after `posted`, and
   variation content after `submitted` / approved amounts after `approved` is
   client-side only; rules allow full document updates. **One narrow
   exception (ADR-34):** a variation's `originRfiId`/`originRfiNumber`/
   `originRfiTitle` **are** frozen by rules once it leaves `draft` — nothing
   else on the variation is.
   **Exception: issued `clientInvoices`, posted `clientReceipts` and posted
   `supplierPayments` ARE immutable by rules** (voiding is the only permitted
   update, and it may touch only the void audit fields).
3. **One-open-claim / one-invoice-per-claim race protection** — these checks
   read the local snapshot; two simultaneous creators can produce two open claims
   on one PO, or two supplier invoices against one approved claim.
4. **Creator vs approver segregation** — nothing prevents the claim (or
   variation) creator from approving their own document.
5. **Supplier-scoped subcontractor access** — subcontractors can read all
   company POs/claims, not just those matching their `supplierId`.
6. **Counter tamper protection** — any financial-role user can set
   `counters/*.next` to an arbitrary value; rules don't require +1 increments.
7. **Audit logging** — no audit trail beyond `createdBy`/`approvedBy` and
   status timestamps; no record of who performed other transitions or edits.
   Contacts additionally carry `updatedAt`/`updatedBy`, but last-write only —
   no field-level change history (contacts feed payment flows later, so this
   joins the audit-logging remediation).
8. **Profile provisioning depends on out-of-band trust** — ⚠️ **The
   self-modification half of this control is CLOSED (ADR-27).** `users/{uid}`
   is now **client-read-only**: `create`, `update` and `delete` are all
   blocked by rules, so a user can no longer promote their own `role`, move
   their own `companyId` to another tenant, mint their own membership, add a
   privilege-bearing field, or delete their membership document. Proven by
   `frontend/tests/rules/users.rules.test.js`.
   **What remains deferred** is the provisioning path itself: membership
   documents are created **by hand** (Firebase console / admin tooling, using
   admin credentials that bypass rules), so the security of every `role` and
   `companyId` rests on whoever performs that step. There is no invite flow,
   no user-management UI, and no self-serve signup — and **none of them can be
   built on client-side membership creation.** Any future signup, invitation,
   or user administration must issue membership from a **trusted backend**
   (Admin SDK), never from the browser; see Trusted-Backend Activation
   Requirement 3 and ADR-14.
   **Two limits to state plainly:** the rule prevents *future* tampering and
   does **not** revert *past* tampering — any `role`/`companyId` already stored
   stays authoritative and should be reviewed directly in the console; and a
   user *provisioned into* a financial role retains every capability that role
   confers (see Deferred Control 17, which this does **not** solve).
9. **Contact, supplier-invoice & variation uniqueness** — duplicate detection
   (contacts: ABN/email/name; supplier invoices: `supplierId`/`supplierName` +
   `supplierInvoiceNumber`; variations: counterparty + external reference) is a
   client-side warn-only check against the in-memory list; two simultaneous
   creators can still produce duplicates. Server-enforced uniqueness would need
   an index collection or Cloud Functions.
10. **Scoped variation visibility** — variations are readable only by financial
    roles today; a future client portal (client sees their own head-contract
    variations) and subcontractor-scoped supplier-variation access are deferred
    with the other scoping controls (item 5). **The same portal must never expose
    Supplier Payments** — not the payments themselves, and not their
    `allocations`, `unallocatedAmount`, `bankReference`, `remittanceReference`,
    `notes`, or the supplier pricing they reveal — **and must never expose the
    Cash Flow view**, which aggregates both cash directions into the project's
    cash position and funding profile.
11. **Company currency validation** — rules validate the *shape* of
    `countryCode`/`baseCurrency` (`^[A-Z]{2}$` / `^[A-Z]{3}$`) but not that the
    code is a **known** country or currency; `XX`/`XXX` would be accepted. The
    known-code check, the confirmation step, and the "which existing projects
    get pinned" review are client-side only.
12. **Project currency lock activation** — rules enforce the one-way ratchet
    once `currencyLocked` is `true`, but **cannot** determine whether a project
    holds financial records (no collection enumeration in rules). A
    financial-role user could create monetary data via a **direct SDK call**,
    bypassing the app, without setting the flag — leaving the currency
    changeable. Within the app this cannot happen: every monetary write engages
    the flag in the **same transaction** as the record, and Project Overview
    self-heals any project whose records predate this behaviour.
13. **Contact project-assignment guards** — the `projectAssignments` /
    `projectIds` fields on contacts required **no rules changes** (they live on
    documents already covered by the contacts block), but their invariants are
    client-enforced only: rules don't verify that `projectIds` matches
    `projectAssignments`, that `projectId`s reference real projects, that there
    is at most one assignment per project, or that **archived contacts gain no
    new assignments**. Same trust level as other client-written denormalised
    fields (`displayName`, `nameLower`, `supplierName`). Assignments are
    administrative and never alter financial documents, so the blast radius of
    a tampered assignment is picker grouping and list filters, not money.
14. **Client-invoice aggregate limits & concurrency** — *Available to Invoice*
    (Current Contract Sum − issued invoices) and the per-variation remaining
    balance are **client-side warnings only**. Firestore rules offer no list,
    query, or count, so no rule can sum sibling documents, and a stored rollup is
    forbidden by ADR-3/ADR-4. Consequences, all accepted and never presented
    otherwise: over-invoicing is warned (with an explicit acknowledgement) rather
    than blocked; **two users can simultaneously invoice the same remaining
    contract or variation value**, and both writes succeed; and line-total
    consistency and approved-variation linkage validity are likewise unverified
    server-side. The invoice *number* is still race-free (transactional counter).
15. **Company legal & tax identity absent** — no legal name, ABN, address, or tax
    number exists on the company document, so Constrapp cannot produce a
    compliant Australian Tax Invoice. This is a **capability gap, not a control
    gap**, but it is recorded here because the remediation (new company fields)
    requires widening the company document's `hasOnly([...])` update allow-list —
    a change needing its own security review.
16. **Client-receipt allocation integrity & concurrency** — Firestore rules
    enforce the *scalar* invariant (`allocatedTotal + unallocatedAmount ==
    amount`, in whole cents) but **cannot** verify the allocation array itself:
    rules cannot iterate an array, and have no list, query, or count with which
    to sum sibling receipt documents. Consequences, all accepted and never
    presented otherwise: `allocatedTotal` may not match the array's sum; an
    allocation may reference a non-existent, draft, void, or wrong-client
    invoice; **an invoice can be over-allocated** (warned with an explicit
    acknowledgement, never blocked); and **two users can allocate the same
    remaining balance concurrently, with both writes succeeding**. Additionally,
    posting a **future-dated** receipt is blocked in the client only. The receipt
    *number* is still race-free (transactional counter). Directly analogous to
    Deferred Control 14.
17. **Falsified cash records — both directions** — a financial-role user can
    create and post a **receipt** (cash in) or a **supplier payment** (cash out)
    for any amount by direct SDK call. Rules validate shape, lifecycle, and
    arithmetic; they cannot validate that money was received or paid.
    Fabricated cash out is the more damaging of the two, because it can be used
    to assert that a supplier was paid when it was not. Remediation is
    server-side enforcement plus audit logging.
    **⚠️ This control is NOT solved by ADR-27, and the escalation path it used
    to describe has narrowed rather than closed.** This entry previously read
    that, combined with Deferred Control 8, any user could *write their own
    `role`* and so escalate from reading data to fabricating cash records.
    That specific escalation is now blocked: `users/{uid}` is client-read-only,
    so **a user can no longer grant themselves a financial role.** What remains
    is the original gap — a user **provisioned into** `company_admin`,
    `project_manager`, or `qs` can still create and post fabricated receipts
    and payments by direct SDK call, because no rule can verify that money
    moved. The blast radius is now bounded by who is provisioned, which is
    itself an out-of-band trust decision (Deferred Control 8).
18. **Supplier-payment allocation integrity & concurrency** — the AP twin of
    Deferred Control 16. Firestore rules enforce the *scalar* invariant
    (`allocatedTotal + unallocatedAmount == amount`, in whole cents) but
    **cannot** verify the allocation array itself: rules cannot iterate an array,
    and have no list, query, or count with which to sum sibling payment
    documents. Consequences, all accepted and never presented otherwise:
    `allocatedTotal` may not match the array's sum; an allocation may reference a
    non-existent, draft, approved, cancelled, wrong-project, or wrong-supplier
    invoice; the **`payableTotal` basis and the retention exclusion are
    client-side only**, so a direct SDK call could allocate against gross or
    against retained money; **an invoice can be over-reconciled** (warned with an
    explicit acknowledgement, never blocked); and **two users can allocate the
    same remaining payable concurrently, with both writes succeeding**.
    Additionally, posting a **future-dated** payment is blocked in the client
    only. The payment *number* is still race-free (transactional counter).

19. **Cash-flow timing-line integrity, past-month timing & post-reporting
    mutability** — Firestore rules enforce the `cashFlowLines` shape and
    lifecycle but **cannot** verify the forecast itself. Consequences, all
    accepted and never presented otherwise: a **past-month** line can be created
    or retimed by a direct SDK call (rules validate the `'YYYY-MM'` shape and
    have no calendar); `sourceType` membership and every per-type conditional
    are unverified; `costCodeId` may not name a real cost code; **aggregate
    over-coverage cannot be blocked** because rules cannot sum sibling lines,
    so two users can time the same source balance concurrently and both writes
    succeed; and an **active line stays editable after being reported** — there
    is no period locking, no immutable snapshot, and no change history beyond
    last-write stamps. Fabricated timing lines are a lower-severity analogue of
    Deferred Control 17: a line asserts an expectation, not a bank movement.
20. **Project-specific membership does not exist.** Membership is
    **company-wide**: `users/{uid}.companyId` grants access to every project in
    that company. With Documents & Drawings this becomes visible rather than
    theoretical — a `subcontractor` provisioned for one job reads the drawings
    and `project` documents of **every** project in the company, in Firestore
    and in Storage alike. Rules cannot narrow this without a membership model
    (per-project member documents or custom claims), which is a redesign
    deliberately out of scope. A rules test asserts the limitation rather than
    leaving it implicit. Until it lands, provision `subcontractor` and `client`
    accounts only for companies whose whole drawing set they may see.
21. **File bytes are never inspected.** Storage Rules enforce content type,
    object name and size from **upload metadata**; they cannot verify that the
    bytes are what the metadata claims, and there is **no antivirus scanning**
    (see Trusted-Backend Activation Requirement 8). Firestore likewise stores
    `fileSize`/`contentType` as declared values. Treat every stored file as
    untrusted input: the app renders images and hands PDFs to the browser's own
    viewer, and never executes or parses uploaded content.
22. **Orphaned Storage objects accumulate, and issued download URLs cannot be
    revoked.** Uploads are Storage-first and objects are create-only, so a file
    whose Firestore write failed stays in the bucket unreferenced forever —
    accepted, because a delete permission able to clean it up could also destroy
    an issued drawing revision. Separately, a Firebase download URL is a **bearer
    link**: the app never persists one, but a user who copies a URL retains
    access after the revision is superseded or withdrawn, or after a document is
    switched to `internal`. Revoking requires rotating the object's download
    token out of band.

23. **Programme integrity & concurrency (Project Timeline)** — Firestore rules
    enforce the `activities` shape and lifecycle thoroughly (exact field set,
    closed status set, ISO date shape, `plannedFinish >= plannedStart`,
    milestone same-day, integer percentage 0–100, the
    status/progress/actual-date invariants, both-or-neither reference pairs,
    immutable `createdAt`/`createdBy`/`revision`, server-stamped audit fields,
    the cancellation key restriction, and cancelled-terminality) but **cannot
    verify programme truth**. All of the following are **client-side only** and
    are proven unenforced by tests in `tests/rules/activities.rules.test.js`:
    a **valid-shaped but impossible calendar date** is accepted (`2026-02-30`,
    `2026-04-31` — rules have no calendar); `responsibleContactId` and
    `costCodeId` **may name nothing**, and the frozen name snapshots are never
    checked against the referenced document; **`percentComplete` is an
    unverifiable assertion** — a manually authored figure that no rule can
    compare to physical progress; **actual dates need not reflect reality** or
    be plausible against the planned dates; **`sortOrder` uniqueness is not
    enforceable** (no query, no count — concurrent creation can tie, and the
    app breaks ties deterministically instead of claiming uniqueness); a
    **backwards status transition cannot be judged legitimate** rather than a
    cover-up (permitting correction is the deliberate design — ADR-29); and
    **dependency-cycle freedom is not enforced** because no dependency model
    exists in V1. Additionally, this collection is **LAST-WRITE-WINS**: there is
    no optimistic concurrency, so two users editing one activity overwrite each
    other including fields the second never looked at, and
    `updatedAt`/`updatedBy` record *who* wrote last, not *what* changed (no
    field-level history — Deferred Control 7 territory).
    **Blast radius is deliberately bounded:** the programme writes no financial
    document and feeds no financial figure, so a fabricated programme misleads
    reporting but cannot move money — which is precisely why ADR-29 refuses to
    couple `percentComplete` to Progress Claims.

24. **Retention-release aggregate cap & concurrency** — the `retentionReleases`
    block enforces materially **more** than the allocation blocks can, because
    `supplierInvoiceId` is a **scalar** field rather than an array element: rules
    `get()` the target invoice and verify it **exists** and is **`posted`**, that
    `amount > 0`, that the **per-document cap** holds
    (`previouslyReleasedAmount + amount <= invoice.retention`, in whole cents),
    that `gstAmount` **exactly** equals the cumulative rounding delta
    `round((prev + amount) × 10%) − round(prev × 10%)`, that
    `releaseTotal == amount + gstAmount`, plus the full lifecycle, role, and
    audit-stamp rules (posted content immutable, void terminal with a
    non-whitespace reason, delete blocked).
    **What they still cannot do:** rules have no `list`, query, or `count`, so
    they **cannot sum sibling releases** and therefore **cannot verify that
    `previouslyReleasedAmount` is truthful**. The consequences, all accepted and
    never presented otherwise: two documents can each claim
    `previouslyReleasedAmount: 0`, each pass the per-document cap, and
    **together over-release an invoice**; the cumulative snapshots may be
    **non-contiguous**, which breaks the GST telescoping to
    `invoice.retentionGst`; **two users can release the same retention
    concurrently** and both writes succeed; and no rule can evidence that the
    release was **genuinely agreed** with the supplier (the Deferred Control 17
    posture — a release asserts a commercial authorisation, not a bank
    movement). The normal UI **hard-blocks** an over-release against the
    currently-loaded posted releases and disables every release action when the
    release subscription fails — that is a correctness guard, **never** a
    security boundary. The register reports any resulting over-release rather
    than hiding it. Creator ≠ poster segregation is not enforced (Deferred
    Control 7). Both accepted gaps are proven as passing tests in
    `tests/rules/retentionReleases.rules.test.js` → *"accepted limitations"*.

25. **Supplier-credit-note cumulative cap & concurrency** — the
    `supplierCreditNotes` rules are the strongest financial block in the file:
    the first to `get()` another document, validating on **create, on every
    draft edit, AND on the `draft → posted` transition** that the target invoice
    exists, is `posted`, carries zero retention, matches the credit's supplier
    and currency, and has a `payableTotal` covering **this** credit's
    `grossTotal`. What they still **cannot** do is anything requiring
    aggregation, array iteration, or re-checking after the write:

    - **The CUMULATIVE cap is app-enforced only.** Total posted credits against
      one invoice never exceeding its `payableTotal` is a HARD BLOCK in the
      UI/hook (deliberately stricter than the warn-and-acknowledge over-payment
      posture), but rules have no list, query, or count with which to sum
      sibling credit notes, so **two users can post credits against the same
      invoice concurrently and both writes succeed**. This is the irreducible
      residue of this control.
    - **Rules cannot inspect `lineItems`.** `subtotal`/`gstTotal` may not match
      the array's sum, and per-line shape (positive amounts, valid tax codes,
      cost codes drawn from the target invoice) is unverified. Only the SCALAR
      header invariant is rules-enforced. A document whose headers and lines
      disagree is therefore **writeable**.
    - **Rules never fire again after a write.** Supplier-invoice lifecycle is
      itself client-enforced (Deferred Controls 1 and 2), so a direct SDK call
      can cancel or alter a target *after* its credit posted, and no rule
      re-runs.

    **What the app does about the last two.** `lib/supplierCreditNotes.js →
    creditTargetException` is a single central **read-time validity gate**: a
    posted credit contributes to **no** figure — neither the payable side
    (`grossTotal`) nor the cost side (`lineItems`) — unless the target still
    exists, is posted, matches supplier and currency, carries zero retention,
    covers the credit's gross, **and** the document's stored headers reconcile
    to its own lines in whole cents, each line's GST matches its tax code, each
    amount is positive, and every line's cost code appears on the target
    invoice. Anything failing is excluded whole (never clamped) and listed in
    the Credit-note exceptions panel. This closes the otherwise-unbounded
    divergence in which a document could reduce AP by its header while reducing
    Actual by its lines.

    ⚠️ **That gate is an additional correctness guard for what this app
    renders — it is NOT a substitute for Firestore rules and protects nothing
    that reads the data by another route** (an export, a future backend, a
    direct SDK reader). The malformed document still exists in Firestore; only
    Constrapp's own figures are protected from it. Do not describe read-time
    validation as enforcement.

    Also not enforced: creator ≠ poster (Deferred Control 4), and company-wide
    SCN-number uniqueness (shares Deferred Control 6).

26. **BOQ & Tender integrity gaps (the shared ADR-32 control)** — one entry
    for the two preconstruction foundations, because both hit the same
    boundary: rules can enforce shape, lifecycle, and cross-document identity,
    but cannot verify measured or transcribed content.

    **BOQ portion (ADR-32 Part 1).** Firestore rules enforce the `boqItems` shape, lifecycle,
    and the `amount == quantity × rate` whole-cent invariant for priced items,
    but **cannot** verify the estimate itself. Consequences, all accepted and
    never presented otherwise: `costCodeId` is validated by **shape only** and
    may name no real (or an inactive) cost code; the `unit` is any bounded
    non-empty string — nothing ties it to the cost code's unit; **duplicate
    items cannot be blocked** (rules have no list, query, or count), so two
    users can measure the same scope concurrently and both writes succeed; an
    **active item stays freely editable** — there is no issue/freeze point, no
    period locking, and no change history beyond last-write stamps; and
    **nothing reconciles the BOQ against the Approved Budget** — deliberately,
    because the two are independent records compared only at read time.
    Fabricated BOQ items are the lowest-severity entry in this list: an item
    feeds **no** financial figure, so a forged one distorts only the BOQ page's
    own totals and its read-time budget comparison.

    **Tender portion (ADR-32 Part 2).** Firestore rules enforce the tender lifecycles, the issued-
    scope freeze, the bid-write windows, and the cross-document award checks
    (bid exists · same package · received · bidder-name snapshot · single
    award), plus bidder-contact existence and type at bid create. They
    **cannot** verify anything inside an embedded array. Consequences, all
    accepted and never presented otherwise: **a malicious direct-SDK caller
    can create malformed embedded `lineItems` data** (non-numeric, negative,
    or non-finite amounts; out-of-scope or fabricated cost codes; wrong
    element shape) — mitigated at read time, not at write time: the central
    validity gate (`lib/tenders.js → assessBid`) invalidates the whole bid, so
    it is flagged and excluded from every derived total, the comparison
    ranking, the cost-code matrix, and the Awarded Bid Value, and is never
    partially summed, clamped, or treated as $0. **The same caller can also
    AWARD such a bid**: the award rule checks the bid's identity and status
    via `get()` but cannot read its lines, so refusing to award a malformed
    bid is **client-only**. The bounded consequence — an award record whose
    value reads *unavailable*, with no PO and no financial figure written —
    is described in the Tenders section above and is accepted for V1.
    Likewise client-only: `costCodes[]`
    element shape on packages; real/active cost-code foreign-key integrity;
    line containment within the package scope; **one active bid per bidder
    per package** (random ids, no queries — two simultaneous creators can
    duplicate, the Deferred Control 9 posture); **closing-date enforcement
    (none exists anywhere — the date is informational only)**; `bidDate`
    realism; **currency-lock activation via direct SDK** (a bid created
    outside the app can decline to set the flag — the Deferred Control 12
    posture); and the **business truth** of manually transcribed prices.
    Because bids store no `bidTotal` and packages store no `awardTotal`,
    there is **no trusted header figure to forge** — the absence of stored
    totals is itself the mitigation for the header-vs-lines problem.

27. **RFI integrity gaps (ADR-33)** — Firestore rules enforce the `rfis`
    shape, the forward-only lifecycle (including **no reopen**, **answered
    cannot be cancelled**, and closed/cancelled terminality), the question-block
    freeze from `open`, the management-block freeze from `answered`, the raise
    gate, both date orderings, and — because the reference is held in **scalar**
    fields — the **existence** of the referenced drawing **and** its nested
    revision, or the referenced document. They **cannot** verify the following,
    all accepted and never presented otherwise:

    - **`rfiNumber` uniqueness within the project, and `+1` counter semantics.**
      The counter is per-project (`…/projects/{p}/counters/rfis`) but rules have
      no list, query or count, and the counter is client-writable with no
      increment constraint (the Deferred Control 6 posture). Normal app creates
      are **transaction-safe** — two concurrent creates serialise on the counter
      document — but a direct-SDK caller can duplicate a number or reset the
      counter.
    - **`raisedByName` truthfulness.** It is a snapshot the creator takes of
      their **own** profile name (the only profile a client can read — ADR-27),
      and it is **client-authored**: rules validate shape only and deliberately
      do **not** compare it against `users/{uid}.name`, because profiles are
      provisioned out of band and a blank provisioned name would then reject
      every create in that company. A direct-SDK caller can attribute an RFI to
      anyone. `createdBy` (the uid) remains the trustworthy identity.
    - **That `assignedToContactId` and `costCodeId` name real, active
      records** — shape only (the Deferred Control 23 posture).
    - **That the frozen `referenceLabel` / `referenceRevisionCode` match the
      referenced drawing/revision/document.** Existence is checked; content is
      not, and a later rename makes the label stale by design.
    - **Duplicate RFIs** (the same question raised twice) — rules cannot query
      siblings.
    - **Authored-date realism.** `raisedDate` and `answerDate` are user-entered
      and can be back- or forward-dated arbitrarily, including an impossible
      calendar date of valid shape (`2026-02-31`). Response-time figures are
      only as honest as the people entering them, and **overdue is computed
      from the client clock**.
    - **Last-write-wins** on concurrent draft/management edits (no
      compare-and-set); **creator ≠ answerer segregation** does not exist; and
      **project-specific membership** does not exist (Deferred Control 20) — a
      financial-role member reads the RFIs of every project in the company.

    Fabricated RFIs are a low-severity entry in this list: an RFI feeds **no**
    financial figure, so a forged one distorts only the register's own counts.

28. **Foundation record editing gaps (ADR-39)** — Projects, Cost Codes and
    Budget Lines became correctable after creation. Firestore rules enforce a
    great deal here, and the split below is exact.

    **RULES-ENFORCED** (the trust boundary, proven by
    `tests/rules/projects.rules.test.js`, `costCodes.rules.test.js` and
    `budgetLines.rules.test.js`):

    - **Projects** — `budget` (the headline figure) is **immutable**;
      `createdAt`/`createdBy` are immutable; `status` must be one of the five
      valid values **on change**; `name`, `progress`, `location` and `startDate`
      are shape-validated on change; the currency ratchet and the narrow `qs`
      ratchet branch are unchanged; delete blocked.
    - **Cost Codes** — `createdAt`/`createdBy` immutable; updates restricted by
      key allow-list to `code`, `name`, `category`, `unit`, `isActive` and the
      audit stamps; every field shape- and length-validated; delete blocked.
    - **Budget Lines** — **`costCodeId` and `costCodeName` are immutable** (no
      re-pointing, no snapshot rewrite); the vestigial `committed`/`actual`/
      `invoiced` zeros are frozen by the key allow-list; `createdAt`/`createdBy`
      immutable; `budgeted` must be a **number ≥ 0** on both create and update;
      `notes` bounded; `updatedBy`/`updatedAt` verified against the caller and
      `request.time`; delete blocked.

    **CLIENT-ENFORCED ONLY** — never present any of these as secure:

    - **Cost-code `code` uniqueness.** Rules have no list, query or count and
      cannot see sibling documents. `lib/costCodes.js` blocks duplicates in the
      app; a direct SDK call and two concurrent writers both bypass it (proved
      accepted at the boundary in `costCodes.rules.test.js` Group F). Nothing
      breaks — the document id remains the financial key — but list ordering
      becomes ambiguous.
    - **That a budget line's `costCodeId` names a real, ACTIVE cost code.**
      Shape only, matching the `boqItems` posture (Deferred Control 26). A
      forged id surfaces as an "Unknown cost code" row, never as a corrupted
      total.
    - **Inactive-code filtering in new authoring.** The Budget create picker
      hides deactivated codes; the boundary does not.
    - **That only `budgeted` and `notes` are offered by the editor**, and that
      the headline budget and cost code render read-only. Those are UX mirrors
      — the immutability itself *is* enforced above.
    - **Concurrent-edit safety.** All three records are **last-write-wins**;
      there is no transaction, version guard or compare-and-set, so two
      simultaneous editors silently overwrite one another.
    - **Edit history.** Only budget lines gain `updatedAt`/`updatedBy`, and
      that is a single latest-writer stamp, not a field-level audit trail
      (Deferred Control 7). A corrected budget's previous value is gone.

    ⚠️ **Project `status` transition legality is deliberately NOT enforced —
    and there is nothing to enforce.** `status` is descriptive: it gates no
    purchase order, claim, invoice, variation, payment or rule anywhere in the
    app. Any value may move to any other and `Completed` is freely reopenable.
    Rules constrain the **vocabulary** and nothing more; do not describe project
    status as a lifecycle control.

    ⚠️ **Legacy compatibility carve-out.** Every project field condition reads
    "**unchanged, or valid**" rather than "valid". Projects predating the
    current vocabulary store statuses outside the five-value enum (the rules
    suite's `LEGACY_PROJECT` fixture stores `'in_progress'`), and validating an
    untouched field would make those documents permanently unwritable —
    including by the Company Settings currency pin, reproducing the original
    pinning defect. The constraint is strictly one-way toward the current
    vocabulary: a legacy value may be corrected to a valid one, a valid one can
    never regress. Both directions are asserted by test.

The intended remediation is server-side enforcement (Cloud Functions and/or
richer rules) — see [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) for why this
is deferred and [ROADMAP.md](../ROADMAP.md) for when it's planned.

## Project Timeline — the one collection where `qs` is read-only

The `activities` block splits read from write more narrowly than anywhere else
in the file:

- **Read:** `company_admin`, `project_manager`, **`qs`** — the QS needs the
  programme as commercial context.
- **Create/update:** `company_admin`, `project_manager` **only**. Programme
  authorship is operational PM/admin responsibility, and `qs` is **read-only**
  here (asserted by test).
- **`subcontractor` and `client` are denied entirely.** This is an honesty
  constraint, not a policy preference: those roles are **not scoped to their own
  projects** (Deferred Control 5/10), so granting programme reads would expose
  **every project's programme in the company**. A per-activity or per-project
  "visibility" flag was deliberately **not** built — it could only be enforced
  client-side, and a control that cannot be enforced must not be presented as
  access control. Sharing a programme with a subcontractor or client is a
  **client-portal feature with its own scoping design**.
- **`super_admin` gains nothing**, matching every other collection.

**Delete is blocked** (`allow delete: if false`). Cancellation is terminal,
requires a non-whitespace reason, and rules restrict the write to
`status`/`cancelReason`/`cancelledAt`/`cancelledBy`/`updatedAt`/`updatedBy`, so
no content edit can ride along with a cancellation and a cancelled activity is
immutable retained history.

⚠️ **The lifecycle is deliberately NOT forward-only** (an explicit departure
from ADR-11): any non-cancelled status may move to any other, including
backwards, because a programme is a plan that gets corrected rather than an
audit record. This is a *design* decision, not a rules gap — but it does mean
the rules cannot tell a legitimate correction from a cover-up (Deferred Control
20).

## RFIs — narrow reads, rules-enforced forward-only lifecycle, existence-verified references

The `rfis` block (ADR-33) uses **one audience for reads and writes**:
`company_admin`, `project_manager`, `qs`. QS is a **full author** here (unlike
the programme) because scope and measurement ambiguity is the classic RFI
trigger and QS already writes general documents.

- **`subcontractor` and `client` are denied entirely** — deliberately **not**
  the drawings read model. RFI content routinely carries contractual positions,
  and those roles are not scoped to their own projects (Deferred Control 20).
  There is no external RFI portal in V1; building one is a client-portal
  feature with its own scoping design.
- **`super_admin` gains nothing**, matching every other collection.
- Because the read gate is uniform, **no `where()` query workaround is needed**
  (contrast `documents`, whose visibility split forces one).

**What is rules-enforced** (all asserted by `rfis.rules.test.js`): the exact
34-key shape at create; draft-only creation with every lifecycle stamp
null/empty; the six update branches, each `hasOnly`-restricted — draft edit,
raise, open management edit, answer, close, cancel; the **forward-only**
transition set (`draft → open|cancelled`, `open → answered|cancelled`,
`answered → closed`) with **no reopen** and **answered → cancelled rejected**;
`closed` and `cancelled` **terminal**; the question-block freeze from `open`
and the management-block freeze from `answered`; the raise gate (assignee +
due date already on the stored draft) **and the same pair as a standing
invariant of every open RFI** — the open management edit may reassign or
re-date but can never clear either; non-whitespace `answer` and
`cancelReason`; `dueDate >= raisedDate` and `answerDate >= raisedDate`;
caller + server time on every stamp; **referenced drawing AND nested revision
existence** (a master-only drawing reference is rejected; a revision under a
different drawing is rejected) or referenced document existence, at create and
draft edit; `delete: if false` at every status.

**The per-project counter** (`…/projects/{projectId}/counters/rfis`) is the
first project-scoped counter in the app and has the same financial-role
audience and tenant gate as the company counters. Rules do **not** enforce `+1`
semantics or number uniqueness — see Deferred Control 27.

⚠️ **Expression budget.** This block validates ~34 fields plus two existence
lookups and sits close to Firestore's **1000-expressions-per-request** limit.
Its shape helpers take the candidate map as an argument once, the exact-key
check is `hasAll` + `size()`, and the draft-edit branch is a `changedKeys()`
allow-list rather than a second full-shape pass. Do not "tidy" these back
into the longer form — the emulator hit the limit during development when they
were written the obvious way.

**What is NOT enforced** is listed in Deferred Control 27 — most notably
number uniqueness, `raisedByName` truthfulness, and reference-label accuracy.

## Secrets & the Vite bundle

**Every `VITE_`-prefixed environment variable is compiled into the public
frontend bundle and is readable by anyone.** Treat all `VITE_*` values as public.

- The Firebase web config (`VITE_FIREBASE_*`) is **public by design** — it
  identifies the project, it does not grant access. Access is enforced by
  Firestore Security Rules, not by hiding the config. Shipping it in the bundle
  is expected and safe.
- **No real secret may ever be `VITE_`-prefixed or read from frontend code.**
  That includes Stripe secret keys, AI provider API keys, email/SMS provider
  keys, webhook signing secrets, and any Firebase **service-account** JSON.
  These belong only in a trusted backend's server-side environment (which does
  not exist yet).
- **Privileged provider operations must not be called directly from the
  browser.** Payment charges, AI inference against a keyed provider, and
  transactional email must run server-side once that provider is introduced —
  see Trusted-Backend Activation Requirements.
- `.env.local` is git-ignored and must never be committed; neither may any
  service-account key file (AGENT.md → Git Workflow). The root `.env.example`
  carries a few extra placeholders the app never reads — the canonical file is
  `frontend/.env.example` (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Security review checklist

Run this on every change that touches data access or `frontend/firestore.rules`.
The full working checklist (with the pre-implementation and validation steps
around it) lives in [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §5;
the security-specific gate is:

- [ ] Every path is scoped to the caller's `companyId` (rules `get()` the
      `users/{uid}` doc and compare `companyId` to the path).
- [ ] Read/write role sets are correct; PII and commercially sensitive
      collections (Contacts, Supplier Invoices, **Client Invoices**, Client
      Receipts, **Supplier Payments**, Variations, **Tender Packages, Tender
      Bids**, Forecast Lines, Commercial Baseline, Counters) restrict
      **reads** to financial roles.
- [ ] The `clientInvoices` lifecycle rules still permit exactly
      draft-edit / draft→issued / draft|issued→void, still require
      `issuedBy`/`voidedBy` to equal the caller and the stamps to equal
      `request.time`, and still reject `issued → draft` and `void → *`.
- [ ] The `clientReceipts` lifecycle rules still permit exactly
      draft-edit / draft→posted / draft|posted→void, still require
      `postedBy`/`voidedBy` to equal the caller and the stamps to equal
      `request.time`, still require a **non-whitespace** `voidReason`, and still
      enforce non-empty `clientId`/`clientName` plus the whole-cent scalar
      invariant (`allocatedTotal + unallocatedAmount == amount`, both ≥ 0,
      `amount > 0`).
- [ ] The `supplierPayments` lifecycle rules still permit exactly
      draft-edit / draft→posted / draft|posted→void, still require
      `postedBy`/`voidedBy` to equal the caller and the stamps to equal
      `request.time`, still require a **non-whitespace** `voidReason`, and still
      enforce non-empty `supplierId`/`supplierName` plus the whole-cent scalar
      invariant (`allocatedTotal + unallocatedAmount == amount`, both ≥ 0,
      `amount > 0`).
- [ ] The `cashFlowLines` lifecycle rules still permit exactly
      active-edit / active→void, still require `voidedBy` to equal the caller
      and the stamps to equal `request.time`, still require a **non-whitespace**
      `voidReason` and `description`, still enforce `basis == 'gross'`,
      `direction in ['in','out']`, `amount > 0`, `revision == 1`, the
      `'YYYY-MM'` `monthKey` shape, and the costCodeId/costCodeName pairing,
      and still reject `void → *`.
- [ ] The `tenderPackages` lifecycle rules still permit exactly
      draft-edit / draft→issued / issued closingDate-and-notes-only edit /
      issued→awarded / draft|issued→cancelled, still require
      `issuedBy`/`awardedBy`/`cancelledBy` to equal the caller and the stamps
      to equal `request.time`, still require a **non-whitespace**
      `cancelReason`, still freeze name/description/scope/costCodes at issue,
      and still verify the awarded bid via `get()` (same project · same
      package · `received` · `awardedBidderName` equals the bid's
      `bidderName`) with `resource.data.status == 'issued'` (single award).
- [ ] The `tenderBids` lifecycle rules still permit exactly received-edit /
      received→void, **both only while the parent package is `issued`**
      (`get()` on the same-project package), still require the create-time
      contact `get()` (exists · supplier/subcontractor · `bidderName` equals
      `displayName`) and tenderNumber-snapshot match, still require
      `voidedBy` to equal the caller with a **non-whitespace** `voidReason`,
      and still reject `void → *`. **No stored `bidTotal`/`awardTotal` field
      is introduced anywhere** — totals stay read-time-derived.
- [ ] Company document writes stay scoped to the four currency fields
      (`affectedKeys().hasOnly`); create/delete remain blocked.
- [ ] The `qs` project rule still affects `currencyLocked` **only**, and only
      `false` → `true` — the legacy-currency carve-out must not reach it.
- [ ] The project currency ratchet still rejects every relabel of a **well-formed**
      stored `currency` (change, delete, blank) and every `currencyLocked`
      `true` → `false`; the carve-out still permits **only** the first explicit
      code on a project storing none.
- [ ] Delete is blocked on financial/audit collections; lifecycle is a status
      change.
- [ ] No secret is `VITE_`-prefixed or read in frontend code; no privileged
      provider call from the browser.
- [ ] New collections/fields have a matching rules block, published manually.
- [ ] Any control that is client-side only is labelled deferred here — not
      presented as enforced (see the honesty protocol in
      [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §7).

## Trusted-Backend Activation Requirements

These controls are **not achievable** in the current client-SDK architecture.
They become **mandatory** the moment a trusted backend (Cloud Functions and/or a
server API, and/or PostgreSQL/Supabase) is introduced, and they **must** be in
place before any non-hand-provisioned (external) users are onboarded — see
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) ADR-14 and the control matrix in
[ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) §6.

1. **PostgreSQL/Supabase Row Level Security** — enabled and **tested** on every
   tenant-owned table (company/project isolation), with an explicit deny-by-
   default posture.
2. **Server-enforced authorisation** — lifecycle-transition legality, post-
   submission/`posted`/`approved` immutability, one-open-claim and
   one-invoice-per-claim race guards, creator ≠ approver segregation, counter
   integrity (+1 only), (contacts / supplier-invoice / variation) uniqueness, and
   **project-currency lock activation derived server-side from actual financial
   records (plus known-code validation of country/currency)** — all moved
   server-side (the Deferred Controls above, promoted to hard gates).
3. **Authentication hardening** — Firebase Auth custom claims for role/company,
   invites and user management, and self-serve signup and password reset.
   ✅ **Locking down self-managed `role`/`companyId` is DONE** — `users/{uid}`
   is client-read-only as of ADR-27. The rest of this item stands, and note the
   dependency it creates: because client-side membership creation is now
   blocked, **signup, invitations, and user administration cannot be built
   without this trusted backend** — membership must be issued via the Admin
   SDK, never from the browser.
4. **Rate limiting** on all write/mutating endpoints and auth flows.
5. **Server-side input validation and explicit API schemas** — the client
   validation is convenience only; the server is authoritative.
6. **Secrets server-side** — Stripe, AI, email/SMS provider keys and any
   service-account credentials held in a server secret store, never in the
   bundle; **privileged provider calls run server-side only.**
7. **Webhook security** — signature verification plus replay/idempotency
   protection on every inbound webhook (payments, email events, etc.).
8. **File-upload controls** — *partially satisfied.* Firebase Storage Security
   Rules **shipped with the first upload feature** (`frontend/storage.rules`,
   ADR-28), with scoped company-namespaced paths, role gates, content-type and
   object-name checks, size ceilings and create-only immutability, all covered by
   an automated emulator suite. **Still deferred to a trusted backend:**
   antivirus scanning, server-side inspection of actual file **content** (rules
   see declared metadata only), and orphan cleanup.
9. **Audit logging** — who performed each transition/edit, when, and from what
   prior state, beyond the current `createdBy`/`approvedBy` stamps.
10. **Cost & budget caps** — per-provider spend caps and alerting on metered
    services (AI inference, email/SMS, storage) to bound abuse and runaway cost.
11. **Dependency scanning in CI** — automated advisory scanning and an update
    policy, in addition to the manual `npm audit` gate used today.
