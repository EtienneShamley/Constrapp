# Security

What is actually enforced today, and what is deliberately deferred. The rules
source of truth is `frontend/firestore.rules`, published **manually** via the
Firebase console (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Authentication & Membership — Implemented

- Firebase Auth **email/password** sign-in only. The Create Account and Forgot
  Password screens are stubs; users are provisioned manually (Auth user +
  matching `users/{uid}` document).
- Membership and role live on the **`users/{uid}` Firestore document**
  (`companyId`, `role`). Security rules authorize every company-scoped request
  by `get()`-ing that document and comparing its `companyId` to the path.
- **Firebase Auth custom claims are NOT implemented.** No rule or UI guard reads
  `request.auth.token.role`/`companyId`. Any doc that says otherwise is stale.
- Users can read **and write** their own `users/{uid}` document. Since rules
  trust that document's `role` and `companyId`, a user can currently edit their
  own role/company — acceptable only while users are provisioned by hand
  (see Deferred Controls).
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
| `users/{uid}` | own doc only | own doc only | own doc (write includes delete) |
| `companies/{companyId}` | company member | **blocked** (admin tooling only) | blocked |
| `…/projects/{id}` | company member | `company_admin`, `project_manager` | blocked |
| `…/costCodes/{id}` | company member | financial roles | blocked — deactivate via `isActive` |
| `…/contacts/{id}` | **financial roles only** | financial roles | blocked — archive via `isActive` |
| `…/projects/{id}/budgetLines/{id}` | company member | financial roles | blocked |
| `…/projects/{id}/purchaseOrders/{id}` | company member | financial roles | blocked — cancel via status |
| `…/projects/{id}/progressClaims/{id}` | company member | financial roles | blocked — reject via status |
| `…/projects/{id}/supplierInvoices/{id}` | **financial roles only** | financial roles | blocked — cancel via status |
| `…/projects/{id}/variations/{id}` | **financial roles only** | financial roles | blocked — reject/withdraw via status |
| `…/counters/{id}` | financial roles | financial roles | blocked |

Contacts reads are deliberately tighter than the shared pattern: the directory
holds third-party PII (names, phones, emails, ABNs, payment terms), so
`subcontractor` and `client` users must not read the company's full contact
book. Financial documents still render supplier identity for those roles via
the `supplierName` snapshot on POs/claims — no contact read required.

**Supplier invoices reads are likewise restricted to financial roles** (tighter
than the POs/claims read pattern): the accounts-payable register exposes supplier
billing detail, so `subcontractor` and `client` users must not read it.

**Variations reads are also restricted to financial roles.** The register exposes
client contract revenue (Client Variations) and supplier pricing (Supplier
Variations), so `subcontractor` and `client` users must not read it. In this
foundation they receive **no** variation access at all; client- and
subcontractor-scoped visibility (e.g. a client seeing their own head-contract
variations) is future work alongside the deferred scoping controls below.

Note the asymmetry: `qs` can write cost codes, budget lines, POs, and claims but
**not** projects.

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

## Deferred Controls

These are known gaps, deliberately deferred (client-side checks exist in the
hooks, but any authorized user could bypass them with direct Firestore calls):

1. **Server-enforced lifecycle transitions** — rules don't validate status
   changes; `canTransition` runs client-side only. A financial-role user could
   set any status directly. Applies equally to supplier invoices (including the
   "posted invoices cannot be cancelled/unposted" rule) and to variations
   (draft → submitted → approved/rejected/withdrawn legality).
2. **Post-submission immutability** — freezing PO lines after `sent`, claim
   amounts after submission/approval, supplier invoices after `posted`, and
   variation content after `submitted` / approved amounts after `approved` is
   client-side only; rules allow full document updates.
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
8. **Self-managed profile** — as above, users can write their own `role`/
   `companyId`; needs locking down once invites/user management exist.
9. **Contact, supplier-invoice & variation uniqueness** — duplicate detection
   (contacts: ABN/email/name; supplier invoices: `supplierId`/`supplierName` +
   `supplierInvoiceNumber`; variations: counterparty + external reference) is a
   client-side warn-only check against the in-memory list; two simultaneous
   creators can still produce duplicates. Server-enforced uniqueness would need
   an index collection or Cloud Functions.
11. **Scoped variation visibility** — variations are readable only by financial
    roles today; a future client portal (client sees their own head-contract
    variations) and subcontractor-scoped supplier-variation access are deferred
    with the other scoping controls (item 5).
10. **Contact project-assignment guards** — the `projectAssignments` /
    `projectIds` fields on contacts required **no rules changes** (they live on
    documents already covered by the contacts block), but their invariants are
    client-enforced only: rules don't verify that `projectIds` matches
    `projectAssignments`, that `projectId`s reference real projects, that there
    is at most one assignment per project, or that **archived contacts gain no
    new assignments**. Same trust level as other client-written denormalised
    fields (`displayName`, `nameLower`, `supplierName`). Assignments are
    administrative and never alter financial documents, so the blast radius of
    a tampered assignment is picker grouping and list filters, not money.

The intended remediation is server-side enforcement (Cloud Functions and/or
richer rules) — see [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) for why this
is deferred and [ROADMAP.md](../ROADMAP.md) for when it's planned.
