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
| `companies/{companyId}` | company member | **`company_admin`, four currency fields only** (`countryCode`, `baseCurrency`, `currencyUpdatedAt`, `currencyUpdatedBy`); create blocked | blocked |
| `…/projects/{id}` | company member | `company_admin`, `project_manager`; **`qs`: `currencyLocked` false→true only** | blocked |
| `…/costCodes/{id}` | company member | financial roles | blocked — deactivate via `isActive` |
| `…/contacts/{id}` | **financial roles only** | financial roles | blocked — archive via `isActive` |
| `…/projects/{id}/budgetLines/{id}` | company member | financial roles | blocked |
| `…/projects/{id}/purchaseOrders/{id}` | company member | financial roles | blocked — cancel via status |
| `…/projects/{id}/progressClaims/{id}` | company member | financial roles | blocked — reject via status |
| `…/projects/{id}/supplierInvoices/{id}` | **financial roles only** | financial roles | blocked — cancel via status |
| `…/projects/{id}/clientInvoices/{id}` | **financial roles only** | financial roles, **create draft-only; transitions and issued-immutability rules-enforced** | blocked — void via status |
| `…/projects/{id}/variations/{id}` | **financial roles only** | financial roles | blocked — reject/withdraw via status |
| `…/projects/{id}/forecastLines/{id}` | **financial roles only** | financial roles | blocked — clear via `null`, never deleted |
| `…/projects/{id}/commercial/baseline` | **financial roles only** | financial roles | blocked — the single baseline doc is never deleted |
| `…/counters/{id}` | financial roles | financial roles | blocked |

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

Note the asymmetry: `qs` can write cost codes, budget lines, POs, and claims but
**not** projects — with one deliberate, narrowly-scoped exception described below.

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
change to `currency` **and** any attempt to set `currencyLocked` back to
`false`. Codes are shape-validated on create and update. Reads stay
company-member level so every role can render amounts with the correct label.

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
   **Exception: `clientInvoices` transitions ARE rules-enforced** — that is the
   intended future standard for the collections above.
2. **Post-submission immutability** — freezing PO lines after `sent`, claim
   amounts after submission/approval, supplier invoices after `posted`, and
   variation content after `submitted` / approved amounts after `approved` is
   client-side only; rules allow full document updates.
   **Exception: issued `clientInvoices` ARE immutable by rules** (voiding is the
   only permitted update, and it may touch only the void audit fields).
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
      collections (Contacts, Supplier Invoices, **Client Invoices**, Variations,
      Forecast Lines, Commercial Baseline, Counters) restrict **reads** to
      financial roles.
- [ ] The `clientInvoices` lifecycle rules still permit exactly
      draft-edit / draft→issued / draft|issued→void, still require
      `issuedBy`/`voidedBy` to equal the caller and the stamps to equal
      `request.time`, and still reject `issued → draft` and `void → *`.
- [ ] Company document writes stay scoped to the four currency fields
      (`affectedKeys().hasOnly`); create/delete remain blocked.
- [ ] The `qs` project rule still affects `currencyLocked` **only**, and only
      `false` → `true`.
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
