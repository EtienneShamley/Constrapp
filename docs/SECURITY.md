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
| `…/projects/{id}/forecastLines/{id}` | **financial roles only** | financial roles | blocked — clear via `null`, never deleted |
| `…/counters/{id}` | financial roles | financial roles | blocked |

Contacts reads are deliberately tighter than the shared pattern: the directory
holds third-party PII (names, phones, emails, ABNs, payment terms), so
`subcontractor` and `client` users must not read the company's full contact
book. Financial documents still render supplier identity for those roles via
the `supplierName` snapshot on POs/claims — no contact read required.

**Supplier invoices reads are likewise restricted to financial roles** (tighter
than the POs/claims read pattern): the accounts-payable register exposes supplier
billing detail, so `subcontractor` and `client` users must not read it.

**Forecast Lines reads are restricted to financial roles** — deliberately tighter
than the company-member `budgetLines` read. The Forecast Cost to Complete data
exposes expected project overruns and implied margin (Forecast Final Cost,
Variance to Budget), so `subcontractor` and `client` users must not read it. This
is a considered asymmetry with budget lines (which are company-member readable),
matching the more conservative posture already applied to Variations, Supplier
Invoices, and Contacts. Delete is blocked — clearing an input writes `null`; the
document is never deleted.

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
10. **Scoped variation visibility** — variations are readable only by financial
    roles today; a future client portal (client sees their own head-contract
    variations) and subcontractor-scoped supplier-variation access are deferred
    with the other scoping controls (item 5).
11. **Contact project-assignment guards** — the `projectAssignments` /
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
      collections (Contacts, Supplier Invoices, Variations, Forecast Lines,
      Counters) restrict **reads** to financial roles.
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
   integrity (+1 only), and (contacts / supplier-invoice / variation) uniqueness
   — all moved server-side (the Deferred Controls above, promoted to hard gates).
3. **Authentication hardening** — Firebase Auth custom claims for role/company,
   invites and user management, self-serve signup and password reset, and
   locking down self-managed `role`/`companyId`.
4. **Rate limiting** on all write/mutating endpoints and auth flows.
5. **Server-side input validation and explicit API schemas** — the client
   validation is convenience only; the server is authoritative.
6. **Secrets server-side** — Stripe, AI, email/SMS provider keys and any
   service-account credentials held in a server secret store, never in the
   bundle; **privileged provider calls run server-side only.**
7. **Webhook security** — signature verification plus replay/idempotency
   protection on every inbound webhook (payments, email events, etc.).
8. **File-upload controls** — Firebase Storage Security Rules **before** the
   first upload feature ships, plus server-side size/type/content validation and
   antivirus scanning; scoped, company-namespaced storage paths.
9. **Audit logging** — who performed each transition/edit, when, and from what
   prior state, beyond the current `createdBy`/`approvedBy` stamps.
10. **Cost & budget caps** — per-provider spend caps and alerting on metered
    services (AI inference, email/SMS, storage) to bound abuse and runaway cost.
11. **Dependency scanning in CI** — automated advisory scanning and an update
    policy, in addition to the manual `npm audit` gate used today.
