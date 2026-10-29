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

## Ruleset source-size limit — a publish can silently fail

Firestore refuses to publish a ruleset whose **source text exceeds 256 KB
(262,144 bytes)**. In the console that is an error banner and **nothing
changes: the previous ruleset stays active**, so every collection added since
is denied by Firestore's default-deny and the app reports it as *unavailable*.
This is what blocked Quant™ 1A production verification in October 2026: the
file had reached 264,907 bytes.

Controls now in place:

- `tests/unit/rulesSize.test.js` fails the unit suite (and CI) if
  `frontend/firestore.rules` exceeds the approved budget of **245,000 UTF-8
  bytes** — measured in bytes, not characters, because the file contains
  multi-byte characters. Raising the budget is an explicit decision.
- The explanatory comment blocks that preceded each `match` were trimmed
  (October 2026) to the collection's one-paragraph summary plus a pointer
  here; the **non-comment rule text is byte-identical** before and after
  (verified by normalised comparison and by the full emulator suite). The
  rationale, the enforced controls and the client-only gaps for every
  collection live in this document's per-collection sections, the Deferred
  Controls list and the ADRs — nothing was dropped, only de-duplicated.
- **ADR-60 (27 October 2026, NOT YET DEPLOYED)** recovered the headroom M2-B3
  had consumed: thirteen helpers are declared once at the
  `match /databases/{database}/documents` scope (`financialMember(companyId)`,
  `sameCompany(companyId)`, `memberRole()`, `changedKeys()`, `updateStamped()`,
  `cents()`, `gstCents()`, `revisionIncremented()`, `isIsoDate()`,
  `amountInvariant()`, `projectPath()`, `poPath()`, `resolvedCurrency()`) in
  place of 95 byte-identical local copies, and the duplicated comments and
  block headers were consolidated here and into the ADRs. **237,851 →
  201,523 bytes** with the 32 match paths and every allow rule unchanged; the
  emulator suite passed unchanged. The tenant and path helpers take
  `companyId` / `projectId` as arguments because path wildcards are not in
  scope at that level — every call site passes its own match's wildcards.
  `variations` keeps its ADR-59 predicate verbatim as `variationMember()`.
- **M3-A (ADR-61, 29 October 2026, NOT YET DEPLOYED)** adds the award →
  PO source link to the `purchaseOrders` and `tenderPackages` blocks:
  **201,523 → 207,620 bytes** (+6,097), 37,380 under the budget.
- **Size compliance is not deployment proof.** The emulator suite proves the
  repo file; the size test proves it can be published; only the console shows
  what is live — see [DEPLOYMENT.md](DEPLOYMENT.md) → *Verifying which rules
  version is published*.

## Authentication & Membership — Implemented

- Firebase Auth **email/password** sign-in only. The Create Account and Forgot
  **Password reset is implemented** — `pages/ForgotPassword.jsx` calls
  `sendPasswordResetEmail` and deliberately shows the SAME success state for an
  unknown address as for a real one, so the form cannot be used to enumerate
  accounts. Account creation remains a stub: users are provisioned manually
  (Auth user + matching `users/{uid}` document), and the Login page states that
  rather than linking to the stub.
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

Shared pattern: *write* requires an authenticated member of the company in the
path whose role ∈ {`company_admin`, `project_manager`, `qs`} (called "financial
roles" below — since ADR-60 one shared `financialMember(companyId)` declared at
the documents scope and called with each block's own `companyId`; `variations`
keeps its ADR-59 form as `variationMember()`); *delete* is blocked everywhere. **Reads are restricted to the
financial roles on every commercially sensitive collection** — since ADR-56
(M2-A) that includes `costCodes`, `budgetLines`, `purchaseOrders` and
`progressClaims`, which until then were readable by any company member (the
confirmed P0 exposure, below). The collections any provisioned member may still
read are `companies`, `projects`, `drawings` (+ revisions) and
project-visibility `documents` — company-wide, not project-scoped (Deferred
Control 20).

| Path | Read | Create/Update | Delete |
|---|---|---|---|
| `users/{uid}` | own doc only | **blocked** — client-read-only; provisioned out of band | **blocked** |
| `companies/{companyId}` | company member | **`company_admin`, four currency fields only** (`countryCode`, `baseCurrency`, `currencyUpdatedAt`, `currencyUpdatedBy`); create blocked | blocked |
| `…/projects/{id}` | company member | `company_admin`, `project_manager`; **`qs`: `currencyLocked` false→true only** | blocked |
| `…/costCodes/{id}` | **financial roles only** (ADR-56; was company member) | financial roles | blocked — deactivate via `isActive` |
| `…/contacts/{id}` | **financial roles only** | financial roles | blocked — archive via `isActive` |
| `…/projects/{id}/budgetLines/{id}` | **financial roles only** (ADR-56; was company member) | financial roles | blocked |
| `…/projects/{id}/boqItems/{id}` | **financial roles only** | financial roles, **create active-only; transitions, post-void immutability and the `amount == quantity × rate` invariant rules-enforced; the optional `quantApplied` map (ADR-52) absent at create and, on an edit, preserved verbatim or fresh — exact keys, `by == caller`, `at == request.time`, `quantity == the written quantity`** — the version guard on edits and the Quant apply is CLIENT-only (DC33) | blocked — void via status |
| `…/projects/{id}/purchaseOrders/{id}` | **financial roles only** (ADR-56; was company member) | financial roles, **create draft-only with the exact key set, creator / audit stamps at server time and the project's resolved currency; draft-only content edits (`hasOnly`); `draft\|pending_approval → sent`, `sent → closed`, `draft\|pending_approval → cancelled`, `sent → cancelled` each stamps-only with actor == caller and time == `request.time`; identity, money and earlier stamps frozen after send; `subtotal + gst == total` in cents and `gst` exactly 10% half-up (one cent below also accepted on a half-cent boundary only); nothing enters `pending_approval`; closed / cancelled terminal — ALL RULES-ENFORCED (ADR-57, M2-B1, live since 27 October 2026)**. **Since ADR-61 (M3-A, not yet deployed): the OPTIONAL source triple `sourceTenderPackageId / sourceTenderBidId / sourceTenderNumber` is admitted at create only all-present and `get()`-verified against an AWARDED same-project package and its RECEIVED winning bid (supplier id + name match), with the package pointing back at this PO after the commit (`getAfter()`); frozen for life.** `lineItems` contents, Σ lineTotal, the linked claim / invoice / supplier-variation cancel policy (DC35) and that a raised PO's lines equal the bid's (DC38) are client-only | blocked — cancel via status |
| `…/projects/{id}/progressClaims/{id}` | **financial roles only** (ADR-56; was company member) | financial roles, **create draft-only with the exact key set, creator / audit stamps at server time, the project's resolved currency and a `get()` on the source PO (same project, exists, `sent`; number, supplier identity and line count pinned); draft-only content edits (`hasOnly`, line count fixed); `draft → submitted`, `submitted\|under_review → approved`, `draft\|submitted\|under_review → rejected` each with actor == caller and time == `request.time` (approval also carrying the certified lines, the approved header and the notes); claimed header frozen after submit, approved values frozen forever; whole-cent headers on both sides (retention ≥ 0 and ≤ subtotal, GST exactly 10% of the net half-up or one cent below on a boundary, totals exact, approved subtotal ≤ claimed subtotal); `revision` exactly +1 on every update; `under_review` / `invoiced` unauthorable; approved / rejected / invoiced terminal — ALL RULES-ENFORCED (ADR-58, M2-B2, live since 27 October 2026)**. `lineItems` contents, Σ lines, one open claim per PO, cumulative ceilings, the mixed-mode overlap and creator ≠ approver are client-only (DC36) | blocked — reject via status |
| `…/projects/{id}/supplierInvoices/{id}` | **financial roles only** | financial roles | blocked — cancel via status |
| `…/projects/{id}/clientInvoices/{id}` | **financial roles only** | financial roles, **create draft-only; transitions and issued-immutability rules-enforced** | blocked — void via status |
| `…/projects/{id}/clientReceipts/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, posted-immutability and the scalar amount invariant rules-enforced** | blocked — void via status |
| `…/projects/{id}/supplierPayments/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, posted-immutability and the scalar amount invariant rules-enforced** | blocked — void via status |
| `…/projects/{id}/supplierCreditNotes/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, posted-immutability, the header cent invariant, AND the target-invoice checks (exists, posted, zero retention, supplier/currency match, grossTotal ≤ payableTotal) rules-enforced via a `get()` on the target at create, draft edit, and posting** | blocked — void via status |
| `…/projects/{id}/variations/{id}` | **financial roles only** | financial roles, **create draft-only with the exact key set, creator / audit stamps at server time, the project's resolved currency, a type-consistent counterparty (`CV-` client / `SV-` supplier, the other side null) and — for a PO-linked supplier variation — a `get()` on the source PO (same project, exists, `sent`\|`closed`; number and supplier snapshot pinned); draft-only content edits (`hasOnly`, line count free); `draft → submitted`, `submitted\|under_review → approved`, `submitted\|under_review → rejected`, `draft\|submitted\|under_review → withdrawn` each with actor == caller and time == `request.time` (approval also carrying the certified lines, the SIGNED approved header, the notes and the dates); submitted header frozen after submit, approved values frozen forever; SIGNED whole-cent headers on both sides (never clamped; `subtotal + gst == total` exact); `revision` exactly +1 on every update; the originating-RFI link (`originRfi*`) rules-verified via a `get()` when it changes and frozen outside `draft` (ADR-34); reserved statuses unauthorable; approved / rejected / withdrawn terminal — ALL RULES-ENFORCED (ADR-59, M2-B3, live since 27 October 2026)**. `lineItems` contents, the header GST against the lines, notes-required-when-differing, uniqueness and creator ≠ approver are client-only (DC37) | blocked — reject/withdraw via status |
| `…/projects/{id}/tenderPackages/{id}` | **financial roles only** | financial roles, **create draft-only; transitions, issued-scope freeze, the closingDate/notes carve-out, and award integrity (bid exists · same package · received · name snapshot · once) rules-enforced; since ADR-61 (M3-A, not yet deployed) an AWARDED package records the ONE current PO raised from it — `raisedPoId / raisedPoNumber / raisedPoAt / raisedPoBy`, written once (branch f) or again only after the linked PO is `get()`-verified CANCELLED (branch g), actor == caller, time == `request.time`, and only in the commit that creates that PO (`getAfter()`)** | blocked — cancel via status |
| `…/projects/{id}/tenderBids/{id}` | **financial roles only** | financial roles, **create received-only against an issued same-project package with a real supplier/subcontractor contact; edits/voids only while the package stays issued; bids freeze on award/cancel** | blocked — void via status |
| `…/projects/{id}/forecastLines/{id}` | **financial roles only** | financial roles | blocked — clear via `null`, never deleted |
| `…/projects/{id}/cashFlowLines/{id}` | **financial roles only** | financial roles, **create active-only; transitions and post-void immutability rules-enforced** | blocked — void via status |
| `…/projects/{id}/commercial/baseline` | **financial roles only** | financial roles | blocked — the single baseline doc is never deleted |
| `…/projects/{id}/activities/{id}` | **`company_admin`, `project_manager`, `qs`** | **`company_admin`, `project_manager` ONLY — `qs` is READ-ONLY**; shape, closed status set, date/milestone/percentage invariants, cancellation branch and cancelled-terminality rules-enforced | blocked — cancel via status |
| `…/projects/{id}/pulseAcknowledgements/{indicatorId}` | **`company_admin`, `project_manager`, `qs`** | **`company_admin`, `project_manager` ONLY — `qs` is READ-ONLY**; six-indicator id allowlist (id == stored `indicatorId`), exact keys, create active/revision 1, re-acknowledge and withdraw transitions, actor == caller, server stamps, non-blank `note` ≤ 500, `reviewBy` shape, `evidenceKeys` list ≤ 200, immutable `createdAt/By`, **`revision` must be exactly +1 on every update** — all rules-enforced (ADR-49) | blocked — withdraw via status |
| `…/projects/{id}/drawings/{id}` | **any company member** — including `subcontractor` and `client` | **`company_admin`, `project_manager` only — QS excluded**; born-empty create, four `hasOnly` update shapes, +1 revision count, non-whitespace withdraw reason | blocked — withdraw via status |
| `…/projects/{id}/drawings/{id}/revisions/{id}` | **any company member** | same drawing writers; **file and authored identity immutable**, exact `storagePath` required, legal transitions only | blocked — a revision is never deleted |
| `…/projects/{id}/documents/{id}` | `internal` → financial roles; `project` → **any company member** | financial roles; **file identity immutable**, three `hasOnly` update shapes, non-whitespace withdraw reason | blocked — withdraw via status |
| `…/projects/{id}/takeoffPages/{drawingId}_{revisionId}_{page}` | **`company_admin`, `project_manager`, `qs`** | same three roles; **id recomputed from the stored sheet identity; drawing + revision EXISTENCE and revision-not-withdrawn via `exists()`/`get()`; exact keys; source/rotation vocabularies; positive page dimensions; calibration shape or null; `calibrationRevision` 0 → exactly +1 per re-calibration; identity, geometry and creation stamps immutable; `revision` exactly +1** | blocked |
| `…/projects/{id}/takeoffMeasurements/{id}` | **`company_admin`, `project_manager`, `qs`** | same three roles; **`takeoffPageId` recomputed and the page, drawing, revision and cost code must EXIST (revision not withdrawn); kind vocabulary; point-list SIZE by kind (≤ 500); label/name bounds; calibration snapshot for length/area, null for count; identity, kind and creation stamps immutable; `revision` exactly +1; active→void terminal with a non-whitespace reason; the OPTIONAL `boqItemId` (ADR-52) — when set, the target item is `get()`: same project, exists, active, same `costCodeId`, re-verified whenever the link or the cost code changes; the OPTIONAL `deductions` (ADR-54) — absent, or on an AREA only, a LIST of ≤ 50, movable only through the active-edit branch and frozen by void** — point CONTENT, deduction ELEMENT content (shape, simplicity, containment, overlap, net > 0) and unit compatibility are NOT checked | blocked — void via status |
| `…/counters/{id}` | financial roles | financial roles | blocked |
| `…/projects/{id}/counters/{id}` | financial roles | financial roles — **the per-project RFI counter** (`rfis`); +1 semantics NOT enforced | blocked |
| `…/projects/{id}/rfis/{id}` | **`company_admin`, `project_manager`, `qs`** | same three roles; **create draft-only; the forward-only lifecycle (no reopen, answered cannot cancel, closed/cancelled terminal), the question-block freeze from `open`, the management freeze from `answered`, the raise gate (assignee + due date), `answerDate`/`dueDate >= raisedDate`, and referenced drawing + revision / document EXISTENCE are all rules-enforced** | blocked — cancel via status (draft/open only) |

Contacts reads are deliberately tighter than the shared pattern: the directory
holds third-party PII (names, phones, emails, ABNs, payment terms), so
`subcontractor` and `client` users must not read the company's full contact
book. Since ADR-56 those roles read no PO or claim either; for financial roles
the `supplierName` snapshot on POs/claims still renders supplier identity with
no contact read.

**Supplier invoices reads are likewise restricted to financial roles** (the
posture POs and claims adopted in ADR-56): the accounts-payable register exposes supplier
billing detail, so `subcontractor` and `client` users must not read it.

## Supplier Invoices — rules-enforced lifecycle (ADR-40)

**This was the highest-risk collection in the database, and it no longer is.**
Until ADR-40 the block enforced role and tenancy and **nothing else**, while three
other blocks `get()` these documents and trust what they find:
`supplierCreditNotes` (status, `supplierId`, `currency`, `retentionTotal`,
`payableTotal`), `retentionReleases` (status, `retention`), and `supplierPayments`
(allocations against `payableTotal`). A forged `status: 'posted'` with an inflated
`payableTotal` therefore unlocked valid-looking credit notes and payment
allocations against an invoice that never existed.

**Reads** stay restricted to `company_admin` / `project_manager` / `qs`.
**Delete** stays blocked for every role and every status.

**Two lifecycle points, not one.** Unlike every earlier hardened collection,
`approved` is the **authoring freeze point** (content stops changing) and
`posted` is the **financial commit point** (the invoice starts counting toward
Invoiced, Actual, Committed maturation and Remaining Payable). An approved
invoice is frozen but not yet financial.

*Rules-enforced:*

- `create` only with `status: 'draft'`, `docType: 'invoice'`, a `source` of
  `direct_po` or `progress_claim`, `createdBy == request.auth.uid`,
  `createdAt == request.time`, `updatedBy`/`updatedAt` likewise, and **null
  lifecycle stamps** (`approvedAt`/`By`, `postedAt`/`By`, `cancelledAt`/`By`)
  plus null `paidAt` and `adjustsInvoiceId`.
- **Source-document validation at create** (cross-document `get()`): `poId` must
  name a purchase order **in this project** whose status is `sent` or `closed`;
  a `progress_claim` invoice's `progressClaimId` must name an **approved** claim
  in this project; and a `direct_po` invoice must carry `progressClaimId: null`
  (a posted invoice's claim reference removes that claim from the claim side of
  Actual, so a forged one would erase an approved claim from the cost position).
  ⚠️ **Create-only, deliberately.** Both references are core-preserved and can
  never change, so re-checking them later could only strand a legitimate invoice
  whose PO was subsequently closed or cancelled (the ADR-34 rule). One accepted
  consequence: an approved claim whose PO is later cancelled can no longer be
  invoiced.
- **Every** update preserves a sixteen-field identity: `invoiceNumber`,
  `docType`, `source`, `currency`, `revision`, `createdAt`, `createdBy`,
  `supplierId`, `supplierName`, `poId`, `poNumber`, `progressClaimId`,
  `claimNumber`, `paymentTerms`, and the two dead fields `paidAt` and
  `adjustsInvoiceId` — pinned at the null they are born with, so no second source
  of payment truth can ever be authored (ADR-24/ADR-31). Every update also stamps
  `updatedBy == request.auth.uid` and `updatedAt == request.time`.
- **Draft-only editing, split by source.** A `progress_claim` invoice is
  **header-only by rules**: `changedKeys().hasOnly(['supplierInvoiceNumber',
  'invoiceDate', 'receivedDate', 'dueDate', 'notes', 'updatedAt', 'updatedBy'])`.
  Certified money has no channel through which to move, from any caller — the
  ADR-38 D1 reconciliation invariant is now structural rather than validated. A
  `direct_po` invoice may re-author line money, subject to the full shape and the
  scalar identities, and its stored **line count** is pinned.
- **`draft → approved`**, **`approved → posted`** and **`draft|approved →
  cancelled`** each affect **only** `status`, their own two stamps, and
  `updatedAt`/`updatedBy`, with the actor `== request.auth.uid` and the timestamp
  `== request.time`. A transition can therefore carry **no** content change.
- **`posted` and `cancelled` are terminal and immutable** — they match no update
  branch at all. A posted invoice cannot be cancelled, unposted, or rewritten;
  corrections are Supplier Credit Notes.
- **The status enum is enforced by omission.** `received`, `under_review`,
  `disputed` and the deprecated `paid` are **unauthorable from any path**, which
  closes the ADR-24 hole in which a direct-SDK caller could forge `status:
  'paid'`. ⚠️ This prevents *future* forgery and does **not** revert *past*
  forgery — which is exactly why `paid` remains in `SI_COUNTING_STATUSES`.
- **Scalar money invariants**, in whole cents: `subtotal + gstTotal ==
  grossTotal`; `retention + retentionGst == retentionTotal`; `subtotal −
  retention == net`; `gstTotal − retentionGst == payableGst`; `grossTotal −
  retentionTotal == payableTotal`; `retentionGst == round(retention × 10%)`
  (using the `math.floor((c + 5) / 10)` formula proven in `retentionReleases`);
  `subtotal > 0`; `grossTotal > 0`; `gstTotal`, `retention`, `retentionGst`,
  `retentionTotal` and `net` all `>= 0`; and `retention <= subtotal`. The
  **`retention >= 0` floor closes a real create-path hole** — `invoiceTotals`
  clamps only the upper bound, so a negative retention used to be stored verbatim
  and made the payable exceed the gross invoice value.

*Client-enforced only (deferred — never describe these as enforced):* see
**Deferred Control 29** for the full list, and **Deferred Control 30** for the
negative-payable domain issue this hardening deliberately did not fix.

⚠️ **Publishing these rules requires an ordering gate.** The block requires
`updatedAt`/`updatedBy` on every write and `cancelledBy` on a cancellation, and
pre-ADR-40 application code sends none of the three. **The application build ships
first; the rules are published second** — see [DEPLOYMENT.md](DEPLOYMENT.md).
Existing documents are unaffected: `cancelledBy` is compared through
`get(key, null)` on both sides and the audit stamps are required only of the
incoming document, so a pre-ADR-40 invoice stays editable and acquires the new
fields on its next valid write.

## Purchase Orders — rules-enforced lifecycle (ADR-57, M2-B1 — LIVE since 27 October 2026)

**Until ADR-57 the `purchaseOrders` block enforced tenant and role and nothing
else**, while `supplierInvoices` `get()`s a PO's `status` at invoice create and
every Committed, Forecast Final Cost, Cash Flow, SHIELD and PULSE figure trusts
`status`, `lineItems` and the header totals at read time. A financial-role
caller with the Firebase SDK could create a PO already `sent`, rewrite a sent
PO's lines or supplier, move a cancelled PO back to `sent`, forge any stamp, or
store a header total unrelated to its GST. **Nothing below is enforced in
production until the revised ruleset is published** (DEPLOYMENT.md →
*M2-B1 release order*).

**Reads** stay restricted to `company_admin` / `project_manager` / `qs`
(ADR-56). **Delete** stays blocked for every role and every status.

**One freeze-and-commit point — `sent`.** Unlike supplier invoices, a PO has a
single lifecycle point: `sent` freezes the authored content AND starts the
commitment counting (`PO_COMMITTED_STATUSES`). `closed` keeps counting and
takes no further claims; `cancelled` drops out of Committed.

*Rules-enforced (`tests/rules/purchaseOrders.rules.test.js`):*

- `create` only with the **exact key set** the hook writes (`poNumber`,
  `status`, `supplierName`, `supplierId`, `description`, `lineItems`,
  `subtotal`, `gst`, `total`, `currency`, `revision`, `notes`, the six lifecycle
  stamps `sentAt/By`, `closedAt/By`, `cancelledAt/By`, `externalRefs`,
  `createdAt/By`, `updatedAt/By`), `status: 'draft'`, `createdBy` and
  `updatedBy` `== request.auth.uid`, `createdAt` and `updatedAt` `==
  request.time`, **all six lifecycle stamps null**, `poNumber` matching
  `PO-####` (four or more digits), a non-empty `supplierName` ≤ 200,
  `supplierId` null or a non-empty string (pre-Contacts POs), `revision` a
  number, `externalRefs` a map, `description` ≤ 2000, `notes` ≤ 5000, and
  `lineItems` a list of **1 to 200** elements.
- **Currency and project consistency at create:** the project document must
  exist, and `currency` must equal the project's resolved currency exactly as
  `lib/currency.js → resolveProjectCurrency` computes it — the project's
  well-formed `currency`, else the company's well-formed `baseCurrency`, else
  `AUD` — via two `get()`s. The field is frozen afterwards.
- **Scalar money, in whole cents:** `subtotal`, `gst`, `total` numbers `>= 0`;
  `cents(subtotal) + cents(gst) == cents(total)` **exactly**; and `cents(gst)
  == floor((cents(subtotal) + 5) / 10)` (10% round-half-up) **exactly** — with
  one precisely bounded allowance: when `cents(subtotal) % 10 == 5` (a
  half-cent boundary) `gst` may also be **one cent below** half-up. ⚠️ Why:
  `lib/purchaseOrders.js → poTotals` computes `roundMoney(subtotal × 0.1)` in
  binary floating point, and on some half-cent boundaries the product lands a
  hair below .5 and rounds **down** (40.15 → 4.01 where half-up is 4.02;
  likewise 41.05, 80.85, 327,680.05 — while 0.05, 1,234.45 and most other
  boundaries round up as expected). Swept exhaustively to $1,000,000 and
  sampled to $90,000,000 (and to $10,000 inside the unit suite): the deviation
  is **always −1, never +1, and never off a boundary**, so the rule admits
  exactly the app's own output and nothing else. Off a boundary the pin is
  exact: one cent either way is refused; on a boundary one cent above or two
  below is refused; `total` is always exact. GST is a flat 10% whatever the
  currency (an NZD project with a 15% figure is refused — currency is a label,
  not tax). `poTotals` itself is unchanged (no global rounding change).
- **Every** update preserves `poNumber`, `supplierName`, `supplierId`,
  `currency`, `revision`, `externalRefs`, `createdAt`, `createdBy` and stamps
  `updatedBy == request.auth.uid`, `updatedAt == request.time`.
- **Draft-only editing:** on a `draft`, `changedKeys().hasOnly(['description',
  'notes', 'lineItems', 'subtotal', 'gst', 'total', 'updatedAt', 'updatedBy'])`
  with the content shape and money invariants re-checked. The line COUNT may
  change on a draft (add / remove). Status and every stamp are outside the list.
- **Transitions, stamps only:** `draft|pending_approval → sent`
  (`hasOnly(['status', 'sentAt', 'sentBy', 'updatedAt', 'updatedBy'])`, the stored
  `lineItems` non-empty), `sent → closed` (`closedAt/By`),
  `draft|pending_approval|sent → cancelled` (`cancelledAt/By`); each with the
  actor `== request.auth.uid` and the timestamp `== request.time`. A transition
  can carry **no** content change and cannot touch another transition's stamps.
- **The reserved `pending_approval` is unauthorable as a target** — nothing
  enters it (it has no stamp and no application path), but a document already
  holding it can still be sent or cancelled, so none is stranded. `closed` and
  `cancelled` are **terminal** — they match no update branch; a cancelled PO
  cannot be revived and a closed one cannot be cancelled or reopened. Any
  unknown status is refused from every state.
- **Creator self-approval is permitted** — the creator may send their own PO.
  Mandatory separation of duties is **not approved** (Deferred Control 4).

*Client-enforced only (deferred — never describe these as enforced):* the strict
**cancellation policy** (a PO with a non-rejected claim, a non-cancelled
supplier invoice, or a supplier variation that is neither rejected nor
withdrawn may not be cancelled — `lib/poCancellation.js`, re-checked inside
the guarded transaction `lib/purchaseOrderActions.js` against the server
copies of the records the client knew about), `lineItems` **contents**,
`subtotal == Σ lineTotal`, PO-number uniqueness, that `supplierId` names a real
contact, and the version guard on draft edits — see **Deferred Control 35**.

**Award-raised POs (ADR-61, M3-A — NOT YET DEPLOYED).** A PO may be born
from an awarded tender package. *Rules-enforced
(`tests/rules/awardToPo.rules.test.js`):* the three source keys are admitted
by `exactKeys()`'s `hasOnly` but not its `hasAll`, so a manual or legacy
create carries none; when ANY is present all three must be non-empty strings
and `sourceTenderValid()` holds — `get()` of the same-project package:
`status == 'awarded'`, `awardedBidId == sourceTenderBidId`, `tenderNumber ==
sourceTenderNumber`; `get()` of the same-project bid: `tenderPackageId ==
sourceTenderPackageId`, `status == 'received'`, `bidderContactId ==
supplierId`, `bidderName == supplierName`; and `getAfter(package).raisedPoId
== poId` — the package must point back at this PO once the commit lands, so a
PO citing an award cannot be created outside the transaction that records
the link (a dangling or spoofed source is refused; a batch that also updates
the package is admitted only through the package's own branches f / g). The
three keys are frozen for life by `corePreserved()` (absent keys compare as
null, so legacy documents are unaffected) and a manual PO can never acquire
them. Every ADR-57 create invariant still applies. *Client-enforced only
(Deferred Control 38):* that the PO's `lineItems` are the bid's lines mapped
one-to-one and that `subtotal` equals the Awarded Bid Value (rules cannot
iterate either array — a header that balances is accepted whatever the
lines, proven); the supplier contact's active state; the same-supplier
duplicate WARNING; the review blockers in `lib/awardToPo.js`.

⚠️ **Publishing these rules requires the ADR-40 ordering gate.** The block
requires `updatedAt`/`updatedBy` on every write and the `*By` stamps on every
transition and at create, and the pre-M2-B1 application bundle sends none of
them. **The application build ships first; the rules are published second** —
see DEPLOYMENT.md. Existing documents are unaffected: the optional keys are
compared through `get(key, null)` on both sides, the audit stamps are required
only of the incoming document, and the exact key set applies to `create` only,
so a pre-ADR-57 PO stays editable, sendable, closable and cancellable and
acquires the new fields on its next valid write.

## Progress Claims — rules-enforced lifecycle (ADR-58, M2-B2 — LIVE since 27 October 2026)

**Until ADR-58 the `progressClaims` block enforced tenant and role and nothing
else**, while `supplierInvoices` `get()`s a claim's `status` at invoice create
and Actual, Remaining Committed, Forecast Final Cost, Cash Flow, Margin, PULSE
and SHIELD trust `status`, `lineItems[].approvedThisPeriod`, `poId` and the
header totals at read time. A financial-role caller with the Firebase SDK
could create a claim already `approved` against any (or no) PO, certify more
than was claimed, rewrite an approved claim's lines or supplier, revive a
rejected claim, forge `approvedBy`, or store a header unrelated to its GST.
**Nothing below is enforced in production until the revised ruleset is
published** (DEPLOYMENT.md → *M2-B2 release order*).

**Reads** stay restricted to `company_admin` / `project_manager` / `qs`
(ADR-56). **Delete** stays blocked for every role and every status.

**Two freeze points.** `submitted` freezes the authored content (claimed lines,
retention, period, refs, notes) and starts the Claimed counting;
`approved` writes the certified lines and the approved header once and is
terminal — approved amounts are frozen forever. `rejected` (a withdrawal from
`draft`) and the reserved `invoiced` are terminal too.

*Rules-enforced (`tests/rules/progressClaims.rules.test.js`):*

- `create` only with the **exact key set** the hook writes (the 29 existing
  keys plus `submittedBy`, `rejectedBy`, `updatedAt`, `updatedBy`),
  `status: 'draft'`, `createdBy` and `updatedBy` `== request.auth.uid`,
  `createdAt` and `updatedAt` `== request.time`, **every lifecycle stamp and
  every approved value null**, `assessmentNotes` empty, `claimNumber` matching
  `PC-####`, `supplierName` ≤ 200, `supplierId` null or non-empty,
  `variationId` **null** (reserved), `revision` 1, `externalRefs` a map,
  `claimRef` ≤ 200, `periodEnding` empty or `YYYY-MM-DD`, `notes` ≤ 5000, and
  `lineItems` a list of **1 to 200**.
- **Source PO at create (a `get()` on the scalar `poId`):** the PO must exist
  **in the same project path** and be `sent` (`CLAIMABLE_PO_STATUSES`), and
  the claim's `poNumber`, `supplierName`, `supplierId` and **line count** must
  be the PO's. A draft, pending, closed or cancelled PO, a PO from another
  project or company, a foreign supplier snapshot or a different line count is
  refused. Checked at create only — a claim whose PO is later closed or
  cancelled still edits, submits, approves and rejects (the PO is read nowhere
  else).
- **Currency and project consistency at create:** the project must exist and
  `currency` must equal the project's resolved currency exactly as
  `lib/currency.js → resolveProjectCurrency` computes it (project → company
  `baseCurrency` → `AUD`) — the ADR-57 mirror. Frozen afterwards.
- **Scalar money, in whole cents, with the claim's own formula** (GST on the
  NET — `lib/progressClaims.js → claimTotals`): *claimed side* (create and
  draft edit) — `retention >= 0` (the ADR-40 floor; a negative retention would
  raise the payable above the claim), `claimedSubtotal > 0` (at least one line
  claims something), `cents(retention) <= cents(claimedSubtotal)`,
  `cents(claimedGst)` **exactly** 10% round-half-up of `cents(claimedSubtotal)
  − cents(retention)` — or one cent below it on a half-cent boundary only (the
  provable floating-point deviation of `claimTotals`, swept in the unit
  suite) — and `cents(claimedTotal)` exact. *Approved side* (approval only) —
  `approvedSubtotal >= 0`, **`cents(approvedSubtotal) <= cents(claimedSubtotal)`**
  (certify at most what was claimed), the STORED `retention` clamped to the
  approved subtotal exactly as `claimTotals(approvedAmounts, claim.retention)`
  does, the same GST pin on that net, the total exact. The stored retention is
  used by identity and not re-floored at approval, so a legacy claim approves
  exactly as the app computes it.
- **Every** update preserves `claimNumber`, `poId`, `poNumber`, `supplierName`,
  `supplierId`, `variationId`, `currency`, `externalRefs`, `createdAt`,
  `createdBy`; stamps `updatedBy == request.auth.uid`, `updatedAt ==
  request.time`; and carries **`revision == stored + 1`** (a missing legacy
  key reads as 0).
- **Draft-only editing:** on a `draft`, `changedKeys().hasOnly(['claimRef',
  'periodEnding', 'notes', 'lineItems', 'retention', 'claimedSubtotal',
  'claimedGst', 'claimedTotal', 'revision', 'updatedAt', 'updatedBy'])` with
  the content shape and claimed money re-checked and the **line count equal to
  the stored count** (the set is one line per PO line — ADR-37). Status, every
  stamp, every approved value and the assessment notes are outside the list.
- **Transitions:** `draft → submitted` (`hasOnly(['status', 'submittedAt',
  'submittedBy', 'revision', 'updatedAt', 'updatedBy'])`, the stored lines
  non-empty); `submitted|under_review → approved` (`hasOnly(['status',
  'lineItems', 'approvedSubtotal', 'approvedGst', 'approvedTotal',
  'assessmentNotes', 'approvedAt', 'approvedBy', 'revision', 'updatedAt',
  'updatedBy'])`, the certified line count equal to the stored count, notes
  ≤ 5000, the approved money as above); `draft|submitted|under_review →
  rejected` (`hasOnly(['status', 'rejectedAt', 'rejectedBy',
  'assessmentNotes', 'revision', 'updatedAt', 'updatedBy'])`); each with the
  actor `== request.auth.uid` and the timestamp `== request.time`. Submit and
  reject can carry **no** content change; approval can touch nothing but the
  certified lines, the approved header, the notes and its stamps — the claimed
  header and the retention are frozen from `submitted` on.
- **The reserved `under_review` and `invoiced` are unauthorable as targets**
  (no stamp, no application path — the ADR-57 `pending_approval` posture; the
  hook refuses them too), but a document already holding `under_review` can
  still be approved or rejected, so none is stranded. `approved`, `rejected`
  and `invoiced` are **terminal** — they match no update branch; a rejected
  claim cannot be revived and an approved one cannot be re-assessed, rejected
  or reopened. Any unknown status is refused from every state. Posting a
  claim-sourced supplier invoice writes **nothing** to the claim — the
  hand-over is the read-time `invoicedClaimIds` exclusion, unchanged.
- **Creator self-approval is permitted** — the creator may submit and approve
  their own claim. Mandatory separation of duties is **not approved**
  (Deferred Control 4).

*Client-enforced only (deferred — never describe these as enforced):* the
**revision-guarded stale check** (`lib/progressClaimActions.js` refuses a copy
whose status OR revision moved on the server; the rule only makes a write
carrying `reviewed + 1` fail — a caller who reads first and writes `stored + 1`
passes), **one open claim per PO**, **cumulative claiming** (the
`previouslyApproved` seed, no line below it, at least one line claimed above
zero — the editor and `validateClaimDraft`), **per-line certified ≤ claimed**
(`approvedLineError` — rules bound the subtotal only), `lineItems` **contents**,
`Σ claimedThisPeriod == claimedSubtotal`, the mixed-mode overlap with a direct
invoice (DC34), claim-number uniqueness (DC6) — see **Deferred Control 36**.

⚠️ **Publishing these rules requires the ADR-40 ordering gate.** The block
requires `updatedAt`/`updatedBy` and `revision + 1` on every write and the
`*By` stamps on every transition and at create, and the pre-M2-B2 application
bundle sends none of them. **The application build ships first; the rules are
published second** — see DEPLOYMENT.md (the combined M1 / M2-B1 / M2-B2
order). Existing documents are unaffected: the optional keys are compared
through `get(key, null)`, the stamps are required only of the incoming
document, a missing `revision` reads as 0, and the exact key set applies to
`create` only, so a pre-ADR-58 claim stays editable, submittable, approvable
and rejectable and acquires the new fields on its next valid write.

## Variations — rules-enforced lifecycle (ADR-59, M2-B3 — LIVE since 27 October 2026)

**Until ADR-59 the `variations` block enforced tenant, role and the ADR-34
originating-RFI link and nothing else**, while approved supplier variations
feed Commitment Exposure, SHIELD check 4 and the M2-B1 PO cancel guard,
approved client variations raise the Current Contract Sum, Forecast Revenue,
Gross Profit and the client-invoice variation rows, and pending variations feed
PULSE indicator 6 — all trusting `status`, `variationType`, `poId`,
`lineItems[].approvedAmount` and the header totals at read time. A
financial-role caller with the Firebase SDK could create a variation already
`approved` with any header, rewrite an approved variation's lines, header,
counterparty or PO, convert a supplier variation into a client one, revive a
rejected one, forge `approvedBy`, or store a header unrelated to its own
total. **Nothing below is enforced in production until the revised ruleset is
published** (DEPLOYMENT.md → *M2-B3 release order*).

**Reads** stay restricted to `company_admin` / `project_manager` / `qs`.
**Delete** stays blocked for every role and every status.

**Two freeze points.** `submitted` freezes the authored content (title,
lines, submitted header, references, dates, notes and the RFI link);
`approved` writes the certified lines and the SIGNED approved header once and
is terminal — approved amounts are frozen forever. `rejected` and `withdrawn`
are terminal too. Only `approved` counts financially; nothing here changes
that counting point, the supplier-versus-client semantics or the sign
conventions (negative variations are valid and never clamped).

*Rules-enforced (`tests/rules/variations.rules.test.js`):*

- `create` only with the **exact key set** the hook writes (the 47 existing
  keys plus `updatedAt`, `updatedBy`), `status: 'draft'`, `createdBy` and
  `updatedBy` `== request.auth.uid`, `createdAt` and `updatedAt`
  `== request.time`, **every lifecycle stamp and every approved value null**,
  `approvedDate` and `assessmentNotes` empty, `revision` 1, `externalRefs` a
  map, `attachments` `[]`, `supersededByVariationId` and `forecastAmount`
  null, `title` 1–500, `description` ≤ 5000, `reason` in the enum or empty,
  the four authored dates empty or `YYYY-MM-DD`, `notes` ≤ 5000, `lineItems`
  a list of **1 to 200**.
- **Type consistency:** `variationType` is `client` or `supplier`;
  `variationNumber` matches `CV-####` for a client and `SV-####` for a
  supplier variation; a client variation carries `clientId` (null or
  non-empty), `clientName` and `clientRef` (strings ≤ 200) and **null**
  `supplierId` / `supplierName` / `supplierRef` / `poId` / `poNumber`; a
  supplier variation the mirror image, its `poId` / `poNumber` **both null**
  (manual mode) or a verified PO link. The external reference stays on the
  document's own side on every draft edit.
- **Source PO at create (a `get()` on the scalar `poId`, supplier variations
  only):** the PO must exist **in the same project path** and be `sent` or
  `closed` (`VARIATION_PO_STATUSES`), and the variation's `poNumber`,
  `supplierName` and `supplierId` must be the PO's (a pre-Contacts PO's
  missing `supplierId` reads as null). A draft, pending or cancelled PO, a PO
  from another project or company, or a foreign supplier snapshot is refused.
  Checked at create only — and **the link is frozen from creation**: `poId`,
  `poNumber`, `supplierId`, `supplierName`, `clientId`, `clientName`,
  `variationType` and `variationNumber` are in no update branch's `hasOnly`
  list, so a draft cannot be re-pointed at another PO, demoted to or promoted
  from manual mode, given a forged supplier snapshot or flipped to the other
  type, alone or bundled with an edit, a transition or a replacement (proven
  end to end). A variation whose PO is later cancelled still submits,
  approves, rejects and withdraws (the PO is read nowhere else).
- **Currency and project consistency at create:** the project must exist and
  `currency` must equal the project's resolved currency exactly as
  `lib/currency.js → resolveProjectCurrency` computes it (project → company
  `baseCurrency` → `AUD`). Frozen afterwards.
- **SIGNED whole-cent headers, never clamped.** On the submitted side (create
  and draft edit) and the approved side (approval): each of the three figures
  is a number within a thousandth of a cent of whole cents (the exact shape
  `roundMoney` produces — swept in the unit suite) and `cents(subtotal) +
  cents(gst) == cents(total)` **exactly**. No sign constraint and no bound of
  approved against submitted — negatives, zero and an approval above or below
  what was submitted are valid by product decision. The header GST **cannot**
  be pinned: it is Σ per-line `gstForLine(amount, taxCode)` over mixed tax
  codes and signs (DC37).
- **Every** update stamps `updatedBy == request.auth.uid`, `updatedAt ==
  request.time` and carries **`revision == stored + 1`** (a missing legacy
  key reads as 0). **Identity is frozen by the `hasOnly` lists** —
  `variationNumber`, `variationType`, `clientId`, `clientName`, `supplierId`,
  `supplierName`, `poId`, `poNumber`, `currency`, `forecastAmount`,
  `attachments`, `externalRefs`, `supersededByVariationId`, `createdAt`,
  `createdBy` and every stamp or figure a branch does not own appear in none
  of them, so no update can add, remove or change them.
- **Draft-only editing:** on a `draft`, `changedKeys().hasOnly(['title',
  'description', 'reason', 'clientRef', 'supplierRef', 'identifiedDate',
  'responseDueDate', 'effectiveDate', 'lineItems', 'submittedSubtotal',
  'submittedGst', 'submittedTotal', 'notes', 'originRfiId',
  'originRfiNumber', 'originRfiTitle', 'revision', 'updatedAt', 'updatedBy'])`
  with the content shape, the reference side and the submitted money
  re-checked; the line count may change (lines are authored); the ADR-34 link
  is validated **only when it changes**.
- **Transitions:** `draft → submitted` (`hasOnly(['status', 'submittedDate',
  'submittedAt', 'submittedBy', 'revision', 'updatedAt', 'updatedBy'])`, the
  stored lines non-empty, the date empty or `YYYY-MM-DD`);
  `submitted|under_review → approved` (`hasOnly(['status', 'lineItems',
  'approvedSubtotal', 'approvedGst', 'approvedTotal', 'assessmentNotes',
  'approvedDate', 'effectiveDate', 'approvedAt', 'approvedBy', 'revision',
  'updatedAt', 'updatedBy'])`, the certified line count equal to the stored
  count, notes ≤ 5000, `approvedDate` a non-empty date, the approved money as
  above); `submitted|under_review → rejected` (`hasOnly(['status',
  'rejectedAt', 'rejectedBy', 'assessmentNotes', 'revision', 'updatedAt',
  'updatedBy'])`); `draft|submitted|under_review → withdrawn`
  (`hasOnly(['status', 'withdrawnAt', 'withdrawnBy', 'revision',
  'updatedAt', 'updatedBy'])`); each with the actor `== request.auth.uid` and
  the timestamp `== request.time`. Submit, reject and withdraw carry **no**
  content change; approval touches nothing but the certified lines, the
  approved header, the notes, the two dates and its stamps. A draft is
  withdrawn, never rejected (`VARIATION_TRANSITIONS`, unchanged).
- **The reserved `under_review`, `disputed` and `superseded` are unauthorable
  as targets** (no stamp, no application path), but a document already
  holding `under_review` can still be approved, rejected or withdrawn so none
  is stranded. `approved`, `rejected`, `withdrawn`, `disputed` and
  `superseded` are **terminal** — they match no update branch. Any unknown
  status is refused from every state.
- **The ADR-34 originating-RFI link** keeps every rule recorded under
  *Variations reads* below — verified by `get()` when created or changed,
  never re-validated when unchanged (the historical case), frozen outside
  `draft` — and is now editable **through the draft edit only**: the earlier
  allowance to change it in the same write as `draft → submitted` (which the
  app never used) is withdrawn, because every transition is stamps-only.
- **Creator self-approval is permitted** — mandatory separation of duties is
  **not approved** (Deferred Control 4).

*Client-enforced only (deferred — never describe these as enforced):* the
**revision-guarded stale check** (`lib/variationActions.js` refuses a copy
whose status OR revision moved on the server; the rule only makes a write
carrying `reviewed + 1` fail — a caller who reads first and writes `stored + 1`
passes), **assessment notes required when approved differs from submitted**
(`validateApprovedAmounts`), **a cost code on every line**
(`validateVariationDraft`), `lineItems` **contents**, `Σ lines == header`, the
header GST against the lines, duplicate-reference warnings (DC9), number
uniqueness (DC6), that `clientId` / `supplierId` name a real contact, and the
PO cancel policy's view of variations (DC35) — see **Deferred Control 37**.

⚠️ **Publishing these rules requires the ADR-40 ordering gate.** The block
requires `updatedAt`/`updatedBy` and `revision + 1` on every write, and the
pre-M2-B3 application bundle sends neither and never increments `revision`.
**The application build ships first; the rules are published second** — see
DEPLOYMENT.md (the combined M1 / M2-B1 / M2-B2 / M2-B3 order). Existing
documents are unaffected: the stamps are required only of the incoming
document, the link keys are compared through `get(key, null)`, a missing
`revision` reads as 0, and the exact key set applies to `create` only, so a
pre-ADR-59 variation stays editable, submittable, approvable, rejectable and
withdrawable and acquires the new fields on its next valid write.

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

**⚠️ The `supplierInvoices` asymmetry is CLOSED (ADR-40).** This section
previously recorded that the `supplierInvoices` block enforced neither lifecycle
legality nor post-`posted` immutability, with two accepted consequences: a
direct-SDK caller could cancel a posted supplier invoice a payment had already
settled, and could forge `status: 'paid'` on one. **Both are now prevented** — a
posted supplier invoice matches no update branch at all, and `paid` is
unauthorable from any path.

Three things did **not** change, and none should be rounded up:

- **Allocation targets are still unverifiable from here.** Allocations live in an
  **array**, and rules can neither iterate it nor `get()` per element, so this
  block still cannot check that an allocated invoice exists, is posted, belongs
  to this project, or belongs to the selected supplier (Deferred Control 18).
- **The allocation-exception machinery stays.** Constrapp still surfaces a broken
  allocation on both views rather than auto-reversing — it now catches invoices
  tampered with *before* ADR-40, and allocations that never pointed at a valid
  invoice.
- **`paid` stays inside `SI_COUNTING_STATUSES`.** Rules prevent *future* forgery
  and do not revert *past* forgery, so removing it could still make a real cost
  vanish from Invoiced and Actual (ADR-24).

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

**The award → PO back-link (ADR-61, M3-A — NOT YET DEPLOYED).** An AWARDED
package may record the ONE current purchase order raised from it, in four
keys — `raisedPoId`, `raisedPoNumber`, `raisedPoAt`, `raisedPoBy` — absent or
null on every package until a PO is raised (create admits either; the
draft-edit branch preserves them; every transition branch's `hasOnly`
excludes them). Branch **(f)** writes the link once: `awarded → awarded`,
`changedKeys().hasOnly` of the four keys + audit stamps, the stored link
null, `raisedPoBy == request.auth.uid`, `raisedPoAt == request.time`, and —
through `getAfter()`, because the PO is created in the SAME transaction and
`get()` cannot see it — the linked PO must stand after the commit as a
`draft` whose `createdAt == request.time` (created in this commit, not a
pre-existing document), whose `poNumber` equals `raisedPoNumber`, and whose
`sourceTenderPackageId` / `sourceTenderBidId` name THIS package and ITS
`awardedBidId`. Branch **(g)** re-links only when the stored link is a string,
the new id differs, and `get()` of the previously linked PO reads
`cancelled`. A back-link without its PO, a back-link to a pre-existing PO, a
second active link, a forged actor or time, and any smuggled content are all
refused — proven. The two blocks therefore pair the PO's source and the
package's link atomically; neither half can exist alone.

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

**The originating-RFI link (ADR-34) was, until ADR-59, the ONE rules-enforced
content control on a variation; since ADR-59 (M2-B3, live since 27 October 2026) the
whole lifecycle is enforced — see *Variations — rules-enforced lifecycle*
above. The link's own rules are unchanged.** A variation may cite zero
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
genuinely caused the variation. Status legality and post-submit immutability
of amounts, lines and text — recorded under Deferred Controls 1 and 2 until
M2-B3 — are rules-enforced since ADR-59 (live since 27 October 2026); the one change
ADR-59 made to the link is that it may now be set, changed or removed through
the draft edit only, no longer in the same write as `draft → submitted`.

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
the currency ratchet inside the create, edit and Quant-apply transactions);
Budgeted, Committed, Actual, Invoiced, Forecast, Margin, and Cash Flow are
untouched, and the BOQ-vs-budget comparison is derived at read time in
`lib/boq.js`, never stored (ADR-32 Part 1).

**Quant 1B (ADR-52) adds two things to this block and nothing to its
audience.** (1) An optional `quantApplied: { at, by, quantity,
measurementCount, evidence }` map — the LATEST explicit application of a
measured total. Rules refuse it at create; on an active edit it must be
**preserved verbatim** (the editor's full-content save carries it along) or
**fresh**: exact keys, `by == request.auth.uid`, `at == request.time`,
`quantity == the quantity being written`, `measurementCount` an integer ≥ 1,
`evidence` a non-blank string ≤ 128; the void branch's `hasOnly` leaves it
untouched. `evidence` is the client's deterministic fingerprint of the
eligible measurements (shape-checked only — rules cannot recompute it). It is
a record of one confirmed action, never a certification. (2) Both the **manual edit** and the **Quant apply** now run
through `lib/boqActions.js`, which reads the server item inside the
transaction and refuses a copy that differs from the one the user reviewed.
**That version guard is CLIENT-ENFORCED** — the BOQ `revision` is frozen at
`1`, so rules cannot assist it — and a direct-SDK client can still overwrite
blindly (Deferred Control 33). `boqItems` still has no key allow-list
(`hasOnly`): an unknown extra key on an active edit is accepted by rules
(pre-existing, DC26) — `quantApplied` is validated precisely because it is
named.

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
| `subcontractor`, `client` | Read `companies`, `projects`, `drawings` / revisions and project-visibility `documents` across the **whole company** — **not** scoped to their own projects (DC20). **No financial collection since ADR-56** (M2-A — LIVE IN PRODUCTION since 27 October 2026: merged, Azure green, ruleset published and production-verified by the product owner) |

The fine-grained per-module access matrix in PRODUCT.md is product intent, not
implementation.

> **⚠️ P0 — CLOSED IN PRODUCTION (ADR-56, M2-A), LIVE since 27 October 2026.
> Company-wide financial read exposure for `subcontractor` / `client`.**
> Until ADR-56 the `costCodes`, `budgetLines`, `purchaseOrders` and
> `progressClaims` blocks allowed **read** to any authenticated member of the
> company (`companyId` match only), so a user provisioned with either role read
> **every project's** approved budget by cost code, **every supplier's**
> purchase-order pricing and every progress claim, company-wide. ADR-56 moves
> those four read sets to the `financialMember()` predicate the other twenty
> sensitive collections use; `tests/rules/externalRoles.rules.test.js` (176
> cases) proves the denial for `subcontractor`, `client`, `super_admin`, an
> unknown role, a role-less membership, an orphan uid, an anonymous caller and
> another tenant, for `get` and `list`, and proves `projects`, `drawings`,
> `documents` and Storage unchanged. **The revised ruleset was published and
> production-verified on 27 October 2026** (DEPLOYMENT.md), so the four reads
> are now denied in production. **External-user onboarding remains NOT SAFE**
> after M2-A: `projects`, `drawings`, revisions, project-visibility `documents`
> and their Storage objects stay readable company-wide (Deferred Control 20)
> until project-level scoping (M2-A2) is implemented and verified. **Whether any
> `subcontractor` / `client` user exists in production is NOT VERIFIED** from
> this repository (membership is provisioned out of band, ADR-27) — check
> `users/{uid}.role` in the console. Rollback of the ruleset would restore the
> exposure and cannot undo reads performed before 27 October. The PO, claim
> and variation **write** rules are hardened by ADR-57 / ADR-58 / ADR-59
> (M2-B1 / M2-B2 / M2-B3, all live since 27 October 2026 — one Hosting deploy,
> then one rules publish).

Since ADR-27 the enforced `role` in that table is **settable only out of band**:
`users/{uid}` is client-read-only, so no user can move themselves between the
rows above. That is what makes the table meaningful — previously any user could
place themselves in any row with a single write.

## Deferred Controls

These are known gaps, deliberately deferred (client-side checks exist in the
hooks, but any authorized user could bypass them with direct Firestore calls):

1. **Server-enforced lifecycle transitions** — for the collections listed below,
   rules don't validate status changes; `canTransition` runs client-side only, so
   a financial-role user could set any status directly.
   **None still deferred: `variations` was the last, closed by ADR-59 (M2-B3,
   live since 27 October 2026).**
   **Rules-enforced: `clientInvoices`, `clientReceipts`, `supplierPayments`,
   `supplierCreditNotes`, `retentionReleases`, `cashFlowLines`, `activities`,
   `rfis`, `boqItems`, `tenderPackages`, `tenderBids`, since ADR-40
   `supplierInvoices`, since ADR-57 (M2-B1, live since 27 October 2026)
   `purchaseOrders`, since ADR-58 (M2-B2, live since 27 October 2026)
   `progressClaims`, and — since ADR-59 (M2-B3, live since 27 October 2026) —
   `variations`** (see *Purchase Orders*, *Progress Claims* and *Variations —
   rules-enforced lifecycle*). ⚠️ The supplier-invoice consequence recorded here is
   **closed**: a posted supplier invoice can no longer be cancelled or unposted,
   and `status: 'paid'` is unauthorable from any path (ADR-24/ADR-40). Rules
   prevent *future* forgery only — a document tampered with before ADR-40 keeps
   whatever status it holds.
2. **Post-submission immutability** — **closed for every financial collection
   since ADR-59 (M2-B3, live since 27 October 2026): variation content IS frozen by
   rules after `submitted` and the certified lines and SIGNED approved header
   after `approved`** — a submitted variation admits approval, rejection or
   withdrawal, an approved, rejected or withdrawn one admits nothing; what is
   NOT frozen there is anything inside `lineItems` beyond its count at approval
   (item 37). **PO lines, header totals,
   supplier and number ARE frozen by rules after `sent` since ADR-57 (M2-B1,
   live since 27 October 2026)** — a sent, closed or cancelled PO admits a stamps-only
   transition or nothing. **Claim amounts ARE frozen by rules after
   `submitted` and the certified lines and approved header after `approved`
   since ADR-58 (M2-B2, live since 27 October 2026)** — a submitted claim admits
   approval or rejection, an approved, rejected or invoiced one admits
   nothing; what is NOT frozen there is anything inside `lineItems` beyond
   its count (item 36). A variation's `originRfiId`/`originRfiNumber`/
   `originRfiTitle` have been frozen by rules outside `draft` since ADR-34; the
   rest of the variation joined them with ADR-59.
   **Exception: issued `clientInvoices`, posted `clientReceipts`, posted
   `supplierPayments`, posted `supplierCreditNotes`, posted `retentionReleases`
   and — since ADR-40 — `approved` AND `posted` `supplierInvoices` ARE immutable
   by rules.** Supplier invoices are the one case with **two** freeze points:
   `approved` freezes authored content (only post and cancel remain), and
   `posted` is terminal — it matches no update branch at all. What is **not**
   frozen there is anything inside `lineItems`, which rules cannot inspect (item
   29).
3. **One-open-claim / one-invoice-per-claim race protection** — these checks
   read the local snapshot; two simultaneous creators can produce two open claims
   on one PO, or two supplier invoices against one approved claim. **ADR-40 did
   not change this**: rules have no list, query, or count, so no rule can sum or
   even see sibling documents. Rules *can* now verify that the referenced claim
   exists and is approved — they cannot verify it is not already invoiced. Proven
   unenforced by `tests/rules/supplierInvoices.rules.test.js`.
4. **Creator vs approver segregation** — nothing prevents the claim (or
   variation) creator from approving their own document. Since ADR-58 the
   claim's `submittedBy` / `approvedBy`, and since ADR-59 the variation's
   `submittedBy` / `approvedBy` / `rejectedBy` / `withdrawnBy`, are
   **verified** actors (`== request.auth.uid`), so the record of WHO is
   trustworthy even though the two may be the same person — permitted by
   decision; an opt-in policy needs product approval.
5. **Supplier-scoped subcontractor access** — ⚠️ **superseded in direction by
   ADR-56 (M2-A):** `subcontractor` / `client` can now read **no** PO, claim,
   budget line or cost code at all (LIVE since 27 October 2026). What remains deferred is
   the opposite capability — a supplier reading **only its own** POs and
   claims — which needs a `users/{uid}` → contact link and query-constrained
   list rules (M3 supplier portal). There is no self-service claim flow today.
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
    leaving it implicit. **ADR-56 (M2-A) removed the four financial collections
    from the member-readable set**, so this control now concerns `projects`,
    `drawings`, revisions, project-visibility `documents` and their Storage
    objects only; project-level scoping (M2-A2 — a provisioned `projectIds`
    list on `users/{uid}`, fail-closed when absent) is the separate follow-on.
    Until it lands, external-user onboarding is **NOT SAFE**: provision
    `subcontractor` and `client` accounts only for companies whose whole
    drawing and document set they may see.
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
    **Partial mitigation (ADR-46), client-side only:** the Timeline's quick
    status actions run in a transaction that refuses to write when the
    activity's `(updatedAt, updatedBy)` differs from the copy the user acted on.
    This protects the *quick action* from overwriting a newer write; it does
    **not** protect anything *from* the full editor, which remains an
    unconditioned update, and it is **not rules-enforced** — a direct SDK write
    bypasses it. The `revision` compare-and-set remains deferred.
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
    ⚠️ **ADR-40 strengthened what that `get()` is worth.** The target invoice's
    `status` and `retention` are now themselves rules-enforced and immutable once
    posted, so the release block is no longer validating against a document any
    caller could rewrite afterwards. Voiding a release still deliberately does
    **not** re-check the target — a release whose invoice is gone is exactly the
    one that most needs withdrawing.
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
    - **Rules never fire again after a write.** ⚠️ **ADR-40 narrowed this
      sharply.** A posted supplier invoice is now rules-immutable and
      rules-terminal, so a direct SDK call can no longer cancel it, unpost it,
      add retention to it, or reduce its `payableTotal` — which was precisely
      the drift this bullet described. What remains is the array limitation
      above: the target's own **line** data is still unverifiable, so a target
      whose headers and lines disagree can still underlie a credit, and a
      document tampered with *before* ADR-40 keeps whatever state it holds.

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

29. **Supplier-invoice line and aggregate gaps (ADR-40)** — the
    `supplierInvoices` block now enforces the lifecycle, the immutable identity,
    the audit stamps, the create-time source references, and the scalar header
    arithmetic (see *Supplier Invoices — rules-enforced lifecycle* above). What it
    **cannot** enforce, and what must never be described as enforced:

    - **The SHAPE OF EACH `lineItems[]` ELEMENT.** Rules can neither iterate nor
      map an array, so `poLineIndex`, `costCodeId`, `costCodeName`,
      `description`, `amount`, `taxCode` and `gstAmount` are **wholly
      unverified**. A per-line **negative amount**, a **bogus cost code**, an
      **invalid tax code**, and a `gstAmount` that disagrees with its own amount
      and tax code are all writable. The identity discipline that makes these
      correct lives in `lib/supplierInvoices.js → buildInvoiceLine`, which reads
      every identity field from the **stored** line and always re-derives
      `gstAmount` — client-side, and bypassable by a direct SDK call.
    - **`subtotal`/`gstTotal` matching the sum of `lineItems[]`.** Same
      limitation. A document whose headers and lines disagree is **writeable**;
      only the scalar header invariant is enforced. What rules *do* pin is the
      stored line **COUNT** on a `direct_po` draft edit — the honest ceiling on
      ADR-38's "the stored line set is fixed".
    - **Tax-code membership** of `TAX_CODES` — validated nowhere in rules,
      because an enum duplicated into a manually-published file would drift out
      of sync with `lib/supplierInvoices.js` (the ADR-21 precedent).
    - **The claim reconciliation itself.** Rules freeze a `progress_claim`
      invoice's money so it *cannot move*, but cannot verify it equals the
      claim's certified `approvedGst`/`approvedTotal`.
    - **One active invoice per approved claim**, and **cumulative over-invoicing**
      against a PO line or a PO total — rules have no list, query, or count, so
      no rule can sum sibling invoices. Two users can invoice the same claim, or
      the same remaining PO value, concurrently and both writes succeed.
    - **Duplicate `(supplierId + supplierInvoiceNumber)`** detection (item 9) and
      **company-wide SI-#### uniqueness** (item 6, the counter is
      client-writable).
    - **Creator ≠ approver ≠ poster** segregation (item 4).
    - **Calendar validity** — `2026-02-30` matches the `YYYY-MM-DD` shape — and
      **future-dating**; **that `costCodeId` names a real cost code**, or that the
      invoice's cost codes are confined to the source PO/claim lines;
      **concurrency**, which stays last-write-wins; and **business truth** — that
      the supplier issued this invoice at all.

    Every item above is **proven unenforced** by a passing test in
    `frontend/tests/rules/supplierInvoices.rules.test.js`, so the ceiling is
    documented as explicitly as the floor.

30. **Negative `payableGst` / `payableTotal` on a GST-free retained invoice
    (deferred DOMAIN issue, not a rules gap)** — under the current financial
    model both figures subtract a retention-derived amount that carries 10% GST,
    while `gstTotal` may legitimately be **zero** on an invoice whose lines are
    all `gst_free` or `input_taxed`. Retention on such an invoice therefore
    produces a **negative payable**, and at the clamped maximum
    (`retention == subtotal`) `payableTotal` reaches `−10% × subtotal`.

    This is app-reachable today, so ADR-40 deliberately applies **no**
    `payableGst >= 0` or `payableTotal >= 0` floor: doing so would reject
    documents the application itself writes. (The same reasoning excludes any
    `gstTotal <= 10% of subtotal` ceiling — `gstTotal` is a **sum of per-line
    roundings**, which can legitimately exceed one rounding of the sum.) A
    passing test asserts the negative figures are accepted, so the behaviour is
    pinned rather than latent.

    **Downstream effect:** such an invoice presents a negative payable to
    Supplier Payments and to the credit-note `payableTotal` cap. Fixing it means
    changing retention or GST semantics — clamping retention against the payable
    rather than the subtotal, or deriving retention GST from the taxable portion
    only — which is a deliberate financial-model decision, not a hardening one,
    and is **out of scope for ADR-40**.

31. **PULSE™ acknowledgements — what a management record cannot prove (ADR-49).**
    The `pulseAcknowledgements` block enforces tenant, role (`qs` read-only),
    the six-indicator allowlist, exact keys, transitions, actors, server stamps,
    note/date/list shape, immutable creation stamps, `revision + 1` and no
    delete. It **cannot** enforce, and the app checks only client-side:
    - that a PULSE **finding actually existed** for the indicator when it was
      acknowledged — rules cannot evaluate `lib/pulse.js`; a direct client can
      acknowledge a condition that is not present;
    - that `evidenceKeys` are **truthful record ids**, or strings at all —
      rules bound the list's size (≤ 200) but cannot inspect its elements or
      check them against other documents;
    - that `reviewBy` is a **real calendar day** (`2026-02-30` passes the
      shape) or **not already in the past** (the app requires strictly after
      today; rules cannot compare a date string with `request.time`);
    - **true concurrency safety** — the `+1` revision rule rejects a *blind*
      overwrite, but a client that reads the document and writes `revision +
      1` itself passes; the app's transaction refuses a stale write, the
      rules merely assist it;
    - project scoping of the writer roles (item 20) — any company PM can
      acknowledge any project's findings.

    **Consequence, bounded:** a forged or careless acknowledgement can change
    only the derived *Management* label beneath a finding. It can never hide a
    finding, change an indicator's state or count, or touch any financial
    figure (the acknowledgement is not a PULSE source — pinned by test). An
    acknowledgement must therefore never be described as server-certified
    evidence of anything beyond *who wrote it and when*. Every item above is
    proven unenforced by a passing test in
    `frontend/tests/rules/pulseAcknowledgements.rules.test.js`.

32. **Quant™ 1A takeoff — what a measurement record cannot prove (ADR-51).**
    The `takeoffPages` / `takeoffMeasurements` blocks enforce tenant, the
    three roles, exact keys, id ↔ fields agreement, drawing / revision / page /
    cost-code existence, revision-not-withdrawn, vocabularies, list sizes,
    label bounds, snapshot shape by kind, immutable identity and creation
    stamps, actors, server stamps, `revision + 1`, reasoned void and no
    delete. They **cannot** enforce, and the app checks only client-side:
    - the **content of `points`** — rules cannot iterate a list, so an element
      may be anything (`['a', 7]` passes); the app refuses non-finite points and
      lists unreadable records without drawing or summing them;
    - that points lie **on the page**, or that the geometry is
      **non-degenerate** (zero length, collinear area);
    - that an area's outline is **simple** (ADR-53): rules cannot test whether
      two edges cross, so a self-intersecting or collapsed polygon passes them;
      the app refuses one at save (`validatePoints`), derives a STORED one as
      `INVALID` with a reason (`measurementQuantity` — never a number, never
      summed, named in the list and the editor), and the BOQ apply blocks it
      through the unchanged aggregate — all **client-side**;
    - **everything about a deduction's ELEMENTS** (ADR-54): rules bound the
      `deductions` list (area only, a list, ≤ 50 — `takeoff.rules.test.js`
      #65–#69) and can see nothing inside it, so junk elements, a hole that
      lies outside its parent, two holes that overlap or duplicate one
      another, duplicate ids, a hole of more than 100 points, and a set that
      equals or exceeds the gross area **all pass rules** (#71). The app
      refuses each at Finish and Save (`validateDeductions`, run again against
      the SERVER outline inside `runUpdateMeasurement`), derives a STORED
      offending set as `INVALID` with a reason naming the hole(s) (never a
      number, never summed, removable from the list), and the BOQ apply
      blocks it through the unchanged aggregate — all **client-side**. A
      deduction amount therefore carries no more server-side assurance than
      any other quantity: *who placed these holes on which outline, when*;
    - that `pageWidth`/`pageHeight`/`pageRotation` are the sheet's **real**
      canonical geometry, and that `page` is **within the PDF's page count**;
    - that a calibration's `pageDistance` **equals the distance between its two
      points**, and — unknowable to any software — that the **real distance is
      true**: every length and area on the page is a function of this one
      ratio, which is why the dialog shows the implied drawing scale for
      review and why nothing is ever re-scaled silently;
    - that a measurement's calibration **snapshot** matches the page's current
      or any past calibration — the app derives the *needs review* flag from
      the stored revision numbers;
    - that the cost code is **active** (existence is checked, activity is not);
    - **true concurrency safety** — the `+1` revision rule rejects a *blind*
      overwrite, but a client that reads the document and writes `revision +
      1` itself passes; the app's transactions refuse a stale write, the rules
      merely assist them;
    - project scoping of the roles (item 20) — any company QS can measure on
      any project's drawings.

    **Consequence, bounded:** a forged or careless measurement can mislead the
    reader of the Quant tab, and — since Quant 1B — a person reviewing the BOQ
    apply dialog, who must still confirm before anything reaches a BOQ
    quantity (ADR-52; item 33). It reaches **no financial figure** either way.
    A measurement must therefore never be described as server-verified
    evidence of anything beyond *who placed these points on which sheet, under
    which stated calibration, and when*. Every item above is proven unenforced
    by a passing test in `frontend/tests/rules/takeoff.rules.test.js`.

33. **Quant™ 1B — what the BOQ link and the apply cannot prove (ADR-52).**
    Rules enforce the link target (same project, exists, active, same cost
    code — re-verified when the link or the cost code moves) and the
    `quantApplied` map's shape, actor, server time and agreement with the
    written quantity. They **cannot** enforce, and the app checks only
    client-side (`lib/quantBoq.js`, `lib/boqActions.js`):
    - **unit compatibility** — that the item's free-text `unit` accepts the
      measurement's kind (a length linked to an m³ item passes rules); the
      alias table is deliberately not duplicated into the rules file (the
      ADR-21 enum-drift reasoning), and the app never offers an incompatible
      item;
    - **the aggregate** — that the applied `quantity` equals the sum of the
      eligible linked measurements, that every linked active measurement was
      eligible (current revision, reviewed, calibrated, compatible), and that
      `measurementCount` is the real count: rules cannot read a list, so the
      total is computed in the browser and **confirmed by a person**, and the
      written `quantity` is validated only as a non-negative number whose
      `amount` reconciles; a client-computed total must never be described as
      independently verified by Firestore Security Rules;
    - **cross-record concurrency** — the manual edit and the apply refuse a
      copy whose `updatedAt` (or, for a legacy record without one, whose
      guarded content) differs from the server's, but the BOQ `revision` is
      frozen at `1`, so a direct-SDK client that writes a valid payload without
      reading first still passes (`boqItems.rules.test.js`, the DC33 test);
      the guard is the app's, not the rules'. Two *different* users applying
      the same evidence to the same item race on the transaction and the
      second is refused as stale — by the client, again;
    - **legacy and incomplete records** — a BOQ item without a usable
      `updatedAt` is guarded by field comparison, never by nothing; but a
      stale copy that happens to match every guarded field is accepted;
    - **provenance truth** — `quantApplied.quantity` must equal the quantity
      written and `by`/`at` are the caller and the server clock, but nothing
      proves the application was *reviewed* or that the count is honest. The
      `evidence` fingerprint (`v1:` + a 64-bit FNV-1a digest of the eligible
      measurements' ids, revisions, geometry, calibration and source state) is
      **client-computed and shape-checked only**: rules cannot recompute it, a
      direct-SDK client can write any string, it is not a cryptographic hash
      (collisions are vanishingly unlikely for this purpose but possible), and
      a record without one — or one written by a client that chose a stale
      fingerprint — yields *cannot verify* or a false *matches* respectively.
      What it does honestly is distinguish "the same evidence" from "the same
      total": 5 + 7 and 4 + 8 are both 12 from two measurements and now read
      as outdated. It is the LATEST confirmed action, not a history and not a
      certificate, and the UI never calls an item "synchronised" or "approved"
      from it, never *matches* while a source is loading or unavailable, and
      never *matches* on total and count alone;
    - **BOQ-side drift** — a BOQ item re-coded or re-united after linking is
      not visible to rules (no child reads); the app detects the mismatch at
      read time and blocks the apply.

    **Consequence, bounded:** a wrong link or a wrong total changes one BOQ
    item's `quantity` and derived `amount` — exactly what any financial-role
    user could already type by hand — and therefore the BOQ priced total and
    the read-time BOQ-vs-budget comparison, and nothing else: no budget,
    forecast, commitment, actual, margin or cash figure. Every item above is
    proven unenforced by a passing test in `takeoff.rules.test.js` (#64) or
    `boqItems.rules.test.js` (the DC33 test).

34. **One recognition path per PO line — the mixed-mode guards (ADR-55).**
    A PO line's cost must reach Actual through a progress claim OR a direct
    supplier invoice, never both; the claim→invoice hand-over keys on
    `progressClaimId`, so a direct invoice can never supersede a claim and a
    line touched by both paths is counted twice in Actual. The guards in
    `lib/poLineRecognition.js` (a direct invoice may not price a line any
    non-rejected claim occupies; a claim may not claim above zero on a line
    any non-cancelled direct invoice prices) run in the supplier invoice and
    progress claim editors **only**. Firestore rules cannot read sibling
    claims or invoices while validating a write (no list, query or count), so
    a direct-SDK caller — or two users saving concurrently — can still create
    the combination. Detection is what makes that visible: SHIELD check 4
    condition E and the Supplier Invoices register list every existing overlap
    with the overlapping amount, and **nothing is reclassified, offset or
    rewritten**. The same limitation applies to the Remaining Committed
    netting itself: rules do not recompute any derived figure, so a forged
    claim line (missing or wrong `poLineIndex`, or `approvedThisPeriod` above
    the certified value) moves Remaining Committed exactly as it moves Actual.
    Never describe the per-line recognition path, the Budget page's readiness
    gating or the exposed `costCodesError`/`contactsError` flags as enforced
    controls — they are client behaviour over data the rules admit.

35. **Purchase-order line, aggregate and cancellation gaps (ADR-57, M2-B1).**
    The `purchaseOrders` block now enforces the lifecycle, the immutable
    identity, the audit and transition stamps, the create-time currency /
    project consistency and the scalar header arithmetic (see *Purchase Orders
    — rules-enforced lifecycle* above). What it **cannot** enforce, and what
    must never be described as enforced:

    - **The CANCELLATION POLICY.** The app refuses to cancel a PO that has any
      non-rejected progress claim, any non-cancelled supplier invoice, or any
      SUPPLIER variation (scalar `poId` link) that is neither rejected nor
      withdrawn linked to it (drafts included) — `lib/poCancellation.js`, run
      against the live claim, invoice and variation subscriptions before the
      confirm dialog (failing CLOSED while any register is loading or failed)
      and again inside the guarded transaction
      `lib/purchaseOrderActions.js → runTransitionPurchaseOrder` against the
      SERVER copies of every linked record the client knew about. Firestore
      rules have no list, query or count, so no rule can see whether a claim or
      invoice references the PO; the client transaction can re-read only
      records whose ids it already holds (the Web SDK offers no query inside a
      transaction), so a claim or invoice created between the subscription
      snapshot and the commit is not seen. A direct-SDK cancel of a sent PO
      with an approved claim, a posted invoice and an approved supplier
      variation against it is **ACCEPTED by rules** — proven in the suite.
      SHIELD check 4 (conditions A and B) lists the claim / invoice state after
      the fact; **no SHIELD condition yet lists an approved supplier variation
      on a cancelled PO** (the exposure stays in Commitment Exposure, detached
      — `approvedSupplierVariationsByCostCode` does not filter by PO status),
      which is why the guard covers variations. Nothing is reclassified.
    - **The SHAPE OF EACH `lineItems[]` ELEMENT** — `costCodeId`,
      `costCodeName`, `description`, `qty`, `unit`, `unitPrice`, `lineTotal`
      are wholly unverified (no iteration). Junk elements, a negative
      `lineTotal` and a cost code naming nothing are writable; the discipline
      lives in `lib/purchaseOrders.js → buildPoLineItem / validatePoDraft`
      (which since ADR-57 also refuses a negative quantity or rate).
    - **`subtotal == Σ lineTotal`** — same limitation; only the scalar header
      invariant is enforced, and the stored line COUNT is bounded (1–200), not
      pinned.
    - **GST on a half-cent boundary** — when the subtotal's cents end in 5 the
      rules accept BOTH the half-up GST and one cent below it, because the
      app's own floating-point rounding writes the lower value there (see the
      section above). Off a boundary the pin is exact. This is the tightest
      rule that admits every legitimate app write; it is not a tolerance on
      the total, which is always exact.
    - **PO-number uniqueness** (the counter is client-writable, item 6), **that
      `supplierId` names a real, active contact**, that the project currency a
      PO was pinned to is a **known** code (shape only — item 11), **concurrency**
      on draft edits (last-write-wins; no version guard — unlike BOQ items), and
      **creator ≠ sender** segregation (permitted by decision, item 4).

    Every item above is **proven unenforced** by a passing test in
    `frontend/tests/rules/purchaseOrders.rules.test.js`, so the ceiling is
    documented as explicitly as the floor.

36. **Progress-claim line, aggregate, sibling and concurrency gaps (ADR-58,
    M2-B2).** The `progressClaims` block now enforces the lifecycle, the
    immutable identity, the audit and transition stamps, the create-time
    source-PO / currency / project consistency, the whole-cent claimed and
    approved headers, the approved-subtotal cap and the +1 revision (see
    *Progress Claims — rules-enforced lifecycle* above). What it **cannot**
    enforce, and what must never be described as enforced:

    - **ONE OPEN CLAIM PER PO.** `hasOpenClaim` runs against the live
      subscription in the hook and the page (the PO picker hides POs with a
      draft / submitted / under-review claim). Rules have no list, query or
      count, so a second open claim on the same PO is **ACCEPTED by rules** —
      proven. Two simultaneous creators remain item 3; SHIELD check 4 lists
      more than one open claim per PO after the fact.
    - **CUMULATIVE CLAIMING.** The `previouslyApproved` seed, "claimed to date
      cannot be below the previously approved amount", "at least one line
      claims something" and the warn-only over-PO marker live in
      `validateClaimDraft` / `buildClaimLine` and the editor. Rules see one
      document: a negative `claimedThisPeriod` whose header still balances, a
      claim above the PO line value, and a `claimedSubtotal` unrelated to its
      lines are all ACCEPTED.
    - **THE SHAPE OF EACH `lineItems[]` ELEMENT** — `poLineIndex`,
      `costCodeId`, `costCodeName`, `description`, `poLineTotal`,
      `previouslyApproved`, `claimedToDate`, `claimedThisPeriod`,
      `approvedThisPeriod` are wholly unverified (no iteration). Only the
      COUNT is pinned (to the PO's at create; to the stored count on edit and
      approval). A certified line above its own claimed amount that still
      sums under the claimed subtotal is ACCEPTED (the per-line bound is
      `approvedLineError`, client-only); so is a wrong `poLineIndex`, which
      moves Remaining Committed exactly as it moves Actual (item 34).
    - **THE MIXED-MODE OVERLAP** with a direct supplier invoice on the same PO
      line — item 34; ACCEPTED, proven.
    - **THE STALE GUARD IS RULES-ASSISTED, NOT RULES-PROVEN.** The rule
      requires `revision == stored + 1`; the client transaction writes the
      revision it REVIEWED + 1 after confirming the server copy's status and
      revision, so a write over a newer copy fails. A direct-SDK caller who
      reads first and writes `stored + 1` passes — proven. True compare-and-
      set needs a backend.
    - **GST on a half-cent boundary** — as item 35: the half-up value and one
      cent below are both admitted on a boundary of the NET (including a
      negative net reached through a legacy negative retention at approval);
      off a boundary the pin is exact; totals are always exact.
    - **Claim-number uniqueness** (the counter is client-writable, item 6),
      **that `supplierId` names a real contact** (the PO's value is pinned,
      not its existence), **creator ≠ approver** (permitted by decision,
      item 4), and **a rejection reason** (`assessmentNotes` stays optional —
      a product choice, not a rules gap).

    Every item above is **proven unenforced** by a passing test in
    `frontend/tests/rules/progressClaims.rules.test.js`, so the ceiling is
    documented as explicitly as the floor.

37. **Variation line, aggregate, sibling and concurrency gaps (ADR-59,
    M2-B3).** The `variations` block now enforces the lifecycle, the
    type-consistent immutable identity, the audit and transition stamps, the
    create-time source-PO / currency / project consistency, the SIGNED
    whole-cent headers on both sides and the +1 revision (see *Variations —
    rules-enforced lifecycle* above). What it **cannot** enforce, and what
    must never be described as enforced:

    - **THE SHAPE OF EACH `lineItems[]` ELEMENT** — `costCodeId`,
      `costCodeName`, `description`, `submittedAmount`, `submittedGst`,
      `approvedAmount`, `approvedGst`, `poLineIndex`, `taxCode` are wholly
      unverified (no iteration). Only the COUNT is bounded (1–200) and, at
      approval, pinned to the stored count. A junk element, a bogus cost code,
      an unknown tax code and an approved amount on a DRAFT line are all
      ACCEPTED — proven. A cost code on every line is `validateVariationDraft`
      (client); the approved side of a draft line is forced null by
      `stripApprovedFromLines` (client).
    - **THE HEADER GST AND THE LINE SUM.** The header GST is Σ per-line
      `gstForLine(amount, taxCode)` over lines of mixed tax codes and signs, so
      no rate can be pinned at header level; rules check only that each figure
      is whole-cent and that `subtotal + gst == total` exactly. A header whose
      GST is unrelated to its lines, or whose subtotal is unrelated to its
      lines, is ACCEPTED when the total identity holds — proven.
    - **ASSESSMENT NOTES WHEN APPROVED DIFFERS FROM SUBMITTED** — needs the
      lines; `validateApprovedAmounts` in the assess modal and the guarded
      transaction. An approval that differs with empty notes is ACCEPTED by
      rules — proven. (The notes are bounded to 5,000 characters.)
    - **THE STALE GUARD IS RULES-ASSISTED, NOT RULES-PROVEN.** The rule
      requires `revision == stored + 1`; the client transaction writes the
      revision it REVIEWED + 1 after confirming the server copy's status and
      revision, so a write over a newer copy fails. A direct-SDK caller who
      reads first and writes `stored + 1` passes — proven. True compare-and-
      set needs a backend.
    - **THE PO LINK IS READ AT CREATE ONLY.** The PO's later status or
      supplier name is never re-compared (a variation survives its PO's
      cancellation by design — the strict cancel policy is item 35), and a
      supplier variation's line cost codes are not checked against the PO's
      lines (new-scope lines are allowed anyway) — proven.
    - **Uniqueness** — number (the counter is client-writable, item 6) and
      counterparty + external reference (item 9) — **that `clientId` /
      `supplierId` name a real contact** (the PO's snapshot is pinned where a
      PO is linked; a manual-mode or client contact id is not looked up),
      **creator ≠ approver** (permitted by decision, item 4), and **a rejection
      reason** (`assessmentNotes` stays optional — a product choice, not a
      rules gap).

    Every item above is **proven unenforced** by a passing test in
    `frontend/tests/rules/variations.rules.test.js`, so the ceiling is
    documented as explicitly as the floor.

38. **Award-raised purchase orders — what the source link cannot prove
    (ADR-61, M3-A).** Rules pair a raised PO with its package atomically
    (source triple `get()`-verified against the awarded package and its
    winning bid; the package's back-link `getAfter()`-verified against the
    PO created in the same commit; both frozen for life; re-link only after
    a `get()`-verified cancellation — see *Purchase Orders* and *Tenders*
    above). What they **cannot** enforce, and what must never be described
    as enforced:

    - **THAT THE PO LINES ARE THE BID LINES.** Rules cannot iterate either
      array, so a raised PO whose `lineItems` differ from the bid's — fewer
      lines, other cost codes, other amounts — is ACCEPTED when its header
      balances (proven: a one-line $5 PO against a $1,250.15 bid). The
      one-to-one mapping (qty 1, blank unit, rate = amount) and the
      subtotal-equals-awarded-value check live in `lib/awardToPo.js` and
      are re-run by the hook before the transaction; the transaction
      re-reads the bid's lines and refuses a copy that differs from the one
      reviewed (STALE). A direct-SDK caller can raise any lines they like
      against an award — the PO is then an ordinary draft, counted through
      its own lines once sent, exactly like a manual PO.
    - **THE SUPPLIER CONTACT'S STATE.** Rules verify the bid's
      `bidderContactId` / `bidderName` snapshot, not that the contact is
      active or still typed supplier / subcontractor; the proposal blocks an
      archived or missing contact and warns on a retyped or renamed one.
    - **DUPLICATION AGAINST MANUAL POs.** One current linked PO per award is
      rules-enforced; that a MANUAL PO to the same supplier covers the same
      scope is unknowable — the dialog lists such POs as a warning that says
      it cannot tell, never as a finding.
    - **THE RAISE STATE SHOWN TO THE USER** is read from the PO register
      (`raiseState`): a loading or failed register reads as unknown and
      disables the action; it is never read as "none raised".
    - **A CONCURRENT LOSER'S ERROR KIND.** Two users raising at once get one
      PO; the loser is refused either by its retried read (ALREADY_RAISED)
      or by the rules against the winner's committed state (PERMISSION) —
      both refusals, proven in the emulator.

    Every item above is **proven** by a passing test in
    `frontend/tests/rules/awardToPo.rules.test.js` or
    `frontend/tests/unit/awardToPo.test.js`.

The intended remediation is server-side enforcement (Cloud Functions and/or
richer rules) — see [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) for why this
is deferred and [ROADMAP.md](../ROADMAP.md) for when it's planned.

## Quant™ 1A takeoff — two non-financial collections, `qs` is a full author

The `takeoffPages` and `takeoffMeasurements` blocks (ADR-51) share one audience
for reads AND writes: `company_admin`, `project_manager`, **`qs`** — a QS
measures, so unlike the drawing register (where QS cannot write) the QS is a
full author here. `subcontractor`, `client` and `super_admin` are denied both
ways: a takeoff is the internal estimate's provenance. Cross-company and
unauthenticated callers are denied.

**Rules-enforced (proven by `tests/rules/takeoff.rules.test.js` — 56 tests for 1A, #57–#64 for 1B, #65–#71 for 1D):**

- tenant via the path + `users/{uid}` lookup; the three roles
- **exact keys** on both documents (`hasOnly` + `hasAll`)
- a page's id **equals `{drawingId}_{revisionId}_{page}`** recomputed from its
  stored fields; a measurement's `takeoffPageId` likewise
- the **drawing and revision exist** and the **revision is not `withdrawn`**
  (`exists()`/`get()` on the nested revisions path — the RFI precedent) for
  pages and measurements alike; the **page document exists** and the **cost
  code exists** for a measurement
- `source ∈ {pdf, image}`, `pageWidth`/`pageHeight > 0`, `pageRotation ∈ {0,
  90, 180, 270}`, `page` a positive integer
- calibration **shape** — two `{x, y}` points, `pageDistance > 0`,
  `realDistance > 0`, `unit ∈ {mm, m}` — or `null` with `calibrationRevision
  0` and null stamps; a first calibration is `calibrationRevision 1`; every
  re-calibration moves it by **exactly +1** and stamps the caller
- measurement `kind ∈ {length, area, count}`; `points` is a **list** sized
  ≥ 2 / ≥ 3 / ≥ 1 by kind and ≤ 500; label non-blank ≤ 120; cost-code name
  non-blank ≤ 200; a calibration **snapshot** `{revision ≥ 1, pageDistance > 0,
  realDistance > 0, unit}` for length/area and **`null` for a count**
- immutable identity (sheet triple, page id, kind), geometry (pages) and
  creation stamps; `updatedBy == request.auth.uid`, `updatedAt ==
  request.time`; **`revision` exactly `resource.revision + 1`** on every update
- `active → void` only, with a non-whitespace reason and caller/server void
  stamps; a voided measurement is immutable; **delete blocked** on both

**The exact sheet-status contract** (rules-enforced through `sourceLive()`,
which `get()`s both the drawing master and the revision; the app mirrors it
with `canMeasureOnRevision`):

| Sheet state | Read | Create page / measurement | Re-calibrate | Edit (geometry · label · cost code · snapshot) | Void |
|---|---|---|---|---|---|
| Current revision | ✓ | ✓ | ✓ | ✓ | ✓ |
| Superseded revision | ✓ | ✓ (historical re-measure, warned) | ✓ | ✓ | ✓ |
| **Withdrawn revision** | ✓ (history) | ✗ | ✗ | ✗ | ✓ (reasoned) |
| **Withdrawn drawing** (any revision) | ✓ (history) | ✗ | ✗ | ✗ | ✓ (reasoned) |
| Drawing or revision missing | ✓ | ✗ | ✗ | ✗ | ✓ |

Reads are gated on role only — never on sheet status — so a takeoff taken on
a sheet that was later superseded or withdrawn stays inspectable by the three
roles (and by nobody else). The sheet identity (`drawingId`, `revisionId`,
`page`, `takeoffPageId`) is immutable in every state, so a measurement can
never be re-pointed from a withdrawn sheet to a live one. Void is the one
write permitted on a withdrawn sheet: it is housekeeping with a reason, it
leaves the geometry and label as recorded, and the record is immutable
afterwards.

**What the Quant tab does NOT do, by construction:** it has **no write path to
a BOQ item, a budget line or any financial collection** — the takeoff hook
writes only the two takeoff collections and stages no currency lock (pinned by
`tests/unit/quant.test.js`). Storage Rules are unchanged: the viewer reads a
drawing object through the existing `get` grant (bytes via the SDK for PDFs, a
download URL for images) and persists neither.

**Quant 1B — the BOQ link (ADR-52).** `takeoffMeasurements` gains ONE
optional key, `boqItemId` (string | null). It sits in `hasOnly` but **not**
`hasAll`, so every 1A document stays valid for every write (no migration, no
backfill). **Rules-enforced** (`linkValid()`, proven by
`tests/rules/takeoff.rules.test.js` #57–#63): when the link is non-null the
item must be in the **same project path**, **exist**, be **`active`** and
share the measurement's **`costCodeId`** — checked at create and on an active
edit whenever `boqItemId` **or** `costCodeId` is among the changed keys; a
cost-code change on a linked measurement is therefore refused unless the link
is cleared or re-pointed in the same write (the app does this itself). A label,
geometry or snapshot edit on a measurement whose item was voided *later* is
not refused — the stored link is history. Void keeps the link and may not
change it. Linking is a measurement write: the three Quant roles; a
subcontractor or client still cannot read or write either collection, and
reading BOQ items from the Quant tab is the existing `financialMember` grant
(the same three roles). **Not enforced** (#64, DC33): unit compatibility — a
length may link to an item measured in m³ as far as rules can tell; the app
never offers it.

**What is NOT enforced** is listed in Deferred Controls 32 and 33 — most
notably the **content** of `points` (including, since ADR-53, whether an area's
outline is simple, and, since ADR-54, everything inside `deductions`), the
**truth** of a calibration, the page number, unit compatibility, the
aggregate, and cross-record concurrency.

**Quant 1D — embedded deductions (ADR-54).** `takeoffMeasurements` gains ONE
more optional key, `deductions` — an AREA's openings, stored as holes in its
own geometry (`[{ id, label, points }]`). It sits in `hasOnly` but **not**
`hasAll`, so every earlier document stays valid for every write (no migration,
no backfill), and the app writes it only once the first deduction exists —
never at create. **Rules-enforced** (`deductionsValid()`, proven by
`tests/rules/takeoff.rules.test.js` #65–#70): absent, or `kind == 'area'`,
`is list`, `size() <= 50`; it may move only through the **active-edit** branch
(so the sheet must still be live and `revision` must move by exactly +1), and
the void branch freezes it with everything else. Deductions are a measurement
write by the same three roles; nobody else reads or writes them. **Not
enforced** (#71, Deferred Control 32): the elements. There is no separate
collection, no cost code and no BOQ link on a hole — it inherits its
parent's, which is why nothing can count it twice — and removing a hole is a
geometry edit of the parent: **no history of removed deductions is kept**
(the parent's `updatedAt`/`updatedBy` and `revision` move; the hole itself is
gone). **Release is RULES-FIRST** (DEPLOYMENT.md): the live `hasOnly` rejects
the new key, so Hosting ahead of the rules would refuse every save that adds a
deduction — and nothing else, because ordinary saves still send no key.

**Quant 1C (ADR-53, stages A and B) changed no rule and no document shape.**
Every control it added — polygon simplicity, the remembered draft in
sessionStorage, the discard confirmation, the edit session, hit testing, pan
and zoom, the dialog semantics, the project summary and the Open-in-Quant
hand-off — is client-side UX over the same two collections; `firestore.rules`
and `storage.rules` are byte-identical to the 1B release. The remembered draft
holds canonical points and ids only, in the browser's per-tab storage, is never
written to Firestore, and becomes a record only through the existing dialogs
and transactions. The project summary **reads nothing new**: it is composed
from the subscriptions the Quant workspace already opens (which the three
Quant roles may read and nobody else — rules-enforced), stores no total, and
offers *Open* only for a drawing that is in the register and not withdrawn; a
void, missing or withdrawn source is explained, never navigated to. The
remembered selection's optional `measurementId` is intent in sessionStorage:
the workspace looks it up on the live sheet and never bypasses the revision or
role gates (a withdrawn drawing is still not opened; a withdrawn revision is
still inspect-or-void-only). Nothing here widens any read or write.

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
23).

**Quick status actions (ADR-46) changed no rule.** Their writes are ordinary
edits through the existing update branch, so the role matrix above applies
unchanged (asserted in the emulator by running the app's own transaction as
every role). Their stale-version check is **client-side** — see Deferred
Control 23.

## PULSE™ acknowledgements — a management record, `qs` read-only, revision-guarded

The `pulseAcknowledgements` block (ADR-49) follows the `activities` audience
split exactly:

- **Read:** `company_admin`, `project_manager`, **`qs`** — the PULSE tab's
  audience; the note is commercial context.
- **Create/update:** `company_admin`, `project_manager` **only**. Acknowledging
  a finding is a management statement, so `qs` is **read-only** (asserted by
  test).
- **`subcontractor`, `client`, `super_admin`, cross-tenant and orphaned users
  are denied entirely.** The hook is mounted only inside the role-gated PULSE
  workspace (UX mirror); the rules are the control.

**Delete is blocked.** Withdrawing is a status change (`active → withdrawn`)
restricted to `status`/`withdrawnAt`/`withdrawnBy`/`revision`/`updatedAt`/
`updatedBy`, so no edit can ride along and the acknowledged content stays as
the record. Re-acknowledging (`active` or `withdrawn → active`) replaces the
statement in place — **no history is kept** (an append-only log was explicitly
not approved; full audit logging is Trusted-Backend requirement 9).

**`revision` increments here** — the one block where it is not pinned at 1.
Every update must carry exactly `resource.data.revision + 1`, which rejects a
blind overwrite and lets the app's transaction (`lib/pulseAcknowledgementActions.js`)
refuse to overwrite another manager's acknowledgement unseen. This is
rules-*assisted* concurrency, not rules-*proven* — see Deferred Control 31,
which also records that rules cannot verify the finding existed, that the
evidence ids are truthful, or that the review date is valid and future.

⚠️ **An acknowledgement is not a resolution, a financial approval or an audit
certification.** It changes no indicator state, count or figure; it is never
a PULSE source; and the page shows the acknowledger only as **You / Another
user** (`users/{uid}` is client-read-only — ADR-27; no name snapshot is
stored).

**Production rollout — done.** The block was published to production on
19 October 2026 with the rest of `frontend/firestore.rules`, after the full
rules suite passed; live behaviour was verified by the product owner.

## SHIELD™ — no new collection, no new rule; detection is not enforcement

The SHIELD™ foundation (ADR-50) adds **no collection, no field and no rules
change**. `pages/project/ProjectShield.jsx` mounts seven **existing**
subscriptions — `purchaseOrders`, `progressClaims` (any-member reads),
`supplierInvoices`, `supplierCreditNotes`, `supplierPayments`,
`retentionReleases`, `variations` (financial-role reads) — only behind the
`isFinancialRole` gate, so `subcontractor` and `client` users see a restricted
card and open no subscription (the UX mirror; the per-collection rules above are
the control). `lib/shield.js` is pure and has **no write path**: no transaction,
no persistence, no acknowledgement, no notification.

⚠️ **SHIELD detects; it enforces nothing.** Every condition it lists is one that
Firestore rules deliberately cannot prevent and a direct SDK caller can still
create: duplicate supplier references (Deferred Control 9), a stored header that
disagrees with its lines or a counted line with no cost code (item 29),
over-invoicing against a PO (item 29's aggregate gap), a PO closed or cancelled
with claims or posted invoices against it (items 1 and 2), a second open claim
or a second invoice per claim (item 3), and the payables exceptions (items 18,
24 and 25). A clean SHIELD tab is a statement about the records it could read
at that moment, not a certification — a loading, failed or empty source renders
*unavailable* or *needs data*, never *no issue*. Findings name source document
ids and numbers; they never name a user (`users/{uid}` is client-read-only,
ADR-27) and never assert wrongdoing.

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
      Bids**, Forecast Lines, Commercial Baseline, Counters, and — since
      ADR-56 — **Cost Codes, Budget Lines, Purchase Orders, Progress Claims**)
      restrict **reads** to financial roles.
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
- [ ] The `pulseAcknowledgements` rules still restrict writes to
      `company_admin`/`project_manager` (`qs` read-only), still accept only
      the six PULSE indicator ids with `indicatorId == documentId`, still
      require exact keys, create as `active`/`revision 1`/null withdraw
      stamps, `acknowledgedBy`/`withdrawnBy`/`updatedBy == request.auth.uid`
      with stamps `== request.time`, a **non-whitespace** `note` ≤ 500, a
      `'YYYY-MM-DD'` `reviewBy`, `evidenceKeys` a list of ≤ 200, immutable
      `createdAt`/`createdBy`/`indicatorId`, **`revision == resource.revision
      + 1`** on every update, withdraw limited to its `hasOnly` key set, and
      still reject `withdrawn → withdrawn` and every delete.
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
