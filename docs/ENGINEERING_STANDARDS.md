# Engineering & Security Standards

Permanent, binding standards for **all** future Constrapp development — by humans or
AI coding agents. They exist to stop vague or generic implementation: every change
must follow Constrapp's *actual* architecture, not a plausible-looking pattern from
elsewhere.

These standards are as binding as the Strategic Invariants ([AGENT.md](../AGENT.md))
and Financial Invariants. Where this document and a general convention disagree, this
document wins. Where this document and [docs/SECURITY.md](SECURITY.md) overlap,
SECURITY.md is the source of truth for what is *enforced*; this document governs how
you *work and report*.

Read alongside: [AGENT.md](../AGENT.md), [docs/ARCHITECTURE.md](ARCHITECTURE.md),
[docs/SECURITY.md](SECURITY.md), [docs/PROJECT_DECISIONS.md](PROJECT_DECISIONS.md),
[docs/DATA_MODEL.md](DATA_MODEL.md), [docs/FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).

---

## 1. Non-negotiable architectural invariants

These are facts about the system, restated as rules. Do not "improve" around them
without an approved architecture change (record it in
[PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) first).

- **Client-SDK-only backend.** There is no server, no Cloud Functions, no
  `firebase.json`. Firestore Security Rules are the **single trust boundary**. Do not
  assume, claim, or write server-side code until a trusted backend is actually
  introduced (see §9, §12). The `backend/` directory is a **reserved, intentionally
  empty placeholder** — it holds no code and must not be treated as an existing
  backend.
- **Hooks-only Firestore access.** Every read/write goes through a hook in
  `frontend/src/hooks/`. Pages and components **never** import `firebase/*`
  (the sole legacy exception is `Login.jsx` calling `signInWithEmailAndPassword`).
- **Pure domain logic lives in `lib/`.** Status machines, totals, derivations, and
  validation live in `frontend/src/lib/*` so they are testable and shared across
  create/assess/invoice/forecast flows. Do not inline this logic in components.
- **Read-time financial derivation.** Committed, Claimed, Actual, Invoiced, variation
  exposure, and all forecast figures are derived at read time from source documents.
  **No client code ever writes a financial rollup onto a Budget Line.** (ADR-3/ADR-4.)
- **Cost Codes are the commercial spine.** Every commercial document references a
  `costCodeId` and snapshots `costCodeName` at write time. New commercial modules join
  through the cost-code spine — never invent a parallel key. (ADR-0a.)
- **Company-scoped multi-tenancy.** Every document except `users/{uid}` lives under
  `companies/{companyId}/…`. Never create a document outside that scope.
- **Forward-only lifecycles; no deletion of financial records.** Transitions move
  forward only (`canTransition` whitelists); cancellation/rejection is a status change;
  Firestore rules block deletes on financial collections. (ADR-11/ADR-12.)

## 2. Pre-implementation checklist (required before writing any code)

1. Read [AGENT.md](../AGENT.md) and the relevant `docs/` for the area you touch.
2. Read the **target page, its hook, and its `lib/` module** — all three — before
   editing any of them. Do not assume structure.
3. Open `frontend/firestore.rules` and locate the block(s) for every collection you
   read or write. A new collection/field needs a rules block **before** the feature is
   done (§8).
4. Confirm the task is in scope ([ROADMAP.md](../ROADMAP.md), [PRODUCT.md](../PRODUCT.md)
   → "What Constrapp Is Not"). If it is out of scope or requires a strategy change,
   **flag it — do not build it.**
5. Identify the **cost-code spine impact** and the **read-time derivation impact**
   (does any figure need deriving? never storing?).
6. Identify the **trust boundary**: today, only Firestore Rules enforce anything.
   Decide what the rules must allow/deny, not just what the UI shows.

## 3. Implementation standards

- **New collection ⇒ new hook first**, then a matching rules block, then UI. Never wire
  a page straight to Firestore.
- **All money through `roundMoney`** (cents); all canonical line amounts are ex-GST;
  GST derived per line. (ADR-10.)
- **Snapshot display names at write time** (`costCodeName`, `supplierName`); never
  backfill historical documents when the source is renamed. (ADR-0a/ADR-15.)
- **Transactional document numbering**: sequence numbers come from
  `companies/{id}/counters/{type}.next`, read+incremented in the **same transaction**
  as the document write. (ADR-5.)
- **Forward-only status via `canTransition`**; new statuses are added to the `lib/`
  transition map, not ad hoc in a component.
- **Audit stamps on writes**: `createdAt`/`createdBy` (via `serverTimestamp()` +
  `user.uid`) on create; `updatedAt`/`updatedBy` where the collection carries them.
- **Auth guards in hooks**: every write callback starts with
  `if (!companyId || !projectId || !user) throw new Error('Not authenticated')` and
  validates lifecycle preconditions before writing.
- **Styling**: Tailwind classes only; **tokens only** (no hardcoded hex, no new colour
  values, no inline style objects). (AGENT.md → Design Tokens.)
- **Responsive & touch**: mobile-first; test at 375px / 768px / 1280px; touch targets
  ≥44px; no hover-only interactions.
- **No new dependencies** (especially Stripe, AI/ML, email, payment, or native-mobile
  packages) without explicit instruction. (AGENT.md → What Not To Do, AI Placeholder
  Rule.)

## 4. Validation & testing checks (required)

- `npm run lint` **and** `npm run build` pass clean (run from `frontend/`).
- **If `frontend/firestore.rules` changed: `npm run test:rules` passes**, and new
  rules behaviour has matching cases in `frontend/tests/rules/`. This suite runs
  against the **Firestore emulator only** and must pass **before** rules are
  published (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- Add or update **manual acceptance steps** in [docs/TESTING.md](TESTING.md) for the
  feature — the rules suite is the only automated one; pure `lib/` functions are the
  next target.
- **Negative-path / authorisation test**: attempt the operation signed in as a
  `subcontractor` or `client` role and confirm **Firestore Rules** (not just the UI)
  block reads/writes on PII and financial-role-only collections.
- Confirm **no Budget Line financial writes** occurred (spot-check Budget figures are
  unchanged after the new flow).
- Run `npm audit` when dependencies change; do not add a package with an unresolved
  high/critical advisory.

## 5. Security review checklist (run on every change touching data or rules)

- [ ] **Tenant isolation**: every path is scoped to the caller's `companyId`; rules
      `get()` the `users/{uid}` doc and compare `companyId` to the path.
- [ ] **Authorisation**: read/write role sets are correct; PII and commercially
      sensitive collections (Contacts, Supplier Invoices, Client Invoices, Variations,
      Forecast Lines, Commercial Baseline, Counters) restrict **reads** to financial
      roles, not just writes.
- [ ] **Deletes blocked** on financial/audit collections; lifecycle is a status change.
- [ ] **No secret in the bundle**: nothing sensitive is `VITE_`-prefixed or read in
      frontend code (see SECURITY.md → Secrets & the Vite bundle).
- [ ] **No privileged provider call from the browser** (Stripe secret keys, AI/email
      provider keys, service accounts). Deferred until a trusted backend exists.
- [ ] **Input validated in the hook/`lib`** before the write.
- [ ] **New fields/collections covered by rules** (published manually — see
      [DEPLOYMENT.md](DEPLOYMENT.md)).
- [ ] **Audit stamps present.**
- [ ] **Client-only controls are labelled deferred** in SECURITY.md, not presented as
      enforced (see §7).

## 6. Control matrix — applies now vs. activate on a trusted backend

"Now" = the current client-SDK + Firestore-Rules architecture. "Backend" = the
controls that **must** be activated when a trusted backend (Cloud Functions and/or a
server API, and/or PostgreSQL/Supabase) is introduced — **before** any non-hand-
provisioned (external) users are onboarded.

| Control | Now (client-SDK) | Activate on trusted backend |
|---|---|---|
| **Firestore Security Rules** | ✅ **Sole boundary** — required for every collection/field | Keep as defense-in-depth |
| **PostgreSQL / Supabase RLS** | N/A — Firestore uses **Security Rules, not SQL RLS** | ✅ **Mandatory and tested on every tenant-owned table** |
| **Authentication** | ✅ Firebase email/password; role+`companyId` on `users/{uid}`; **no custom claims** | Custom claims, invites, self-serve signup/reset, user management |
| **Authorisation** | ⚠️ Rules-level tenant+role only; **client role checks are UX** | Move lifecycle legality, immutability, segregation server-side |
| **Company/project tenant isolation** | ✅ Enforced via `companyId` `get()` in rules | Re-enforce in RLS / backend queries |
| **Rate limiting** | ❌ Not possible from the client | ✅ Required at API/gateway |
| **Input validation** | ⚠️ Client hooks/`lib` only (bypassable by direct SDK calls) | ✅ Server-side authoritative validation |
| **API schemas** | N/A — no API surface | ✅ Explicit, validated request/response contracts |
| **Environment variables** | ✅ `VITE_*` only, all **public** by definition | Server-side env for anything secret |
| **Secrets** | ✅ Rule: **none in the frontend, ever** (Firebase web config is public by design) | ✅ Server-side secret store / vault |
| **Stripe & payment providers** | ❌ No secret-key calls from the browser; billing not implemented | ✅ Server-only; verify webhook signatures; idempotency keys |
| **Email providers** | ❌ Not from the browser | ✅ Server-only; no keys in bundle |
| **AI providers** | ❌ Not from the browser (also AGENT.md AI Placeholder Rule) | ✅ Server-only; keys server-side; cost caps (below) |
| **File uploads** | ⚠️ Storage initialised but **unused**; needs Storage Security Rules **before** first use | ✅ Server validation: size/type/content, AV scanning, scoped paths |
| **Webhooks** | N/A | ✅ Signature verification + replay/idempotency protection |
| **Logging** | Console only; **never log secrets or PII** | ✅ Structured logs, redaction, retention policy |
| **Audit trails** | ⚠️ `createdBy`/`approvedBy` + status timestamps only; no transition history | ✅ Full transition/edit logging (who/what/when) |
| **Error messages** | ✅ Friendly, non-leaking (see `useProfile` graceful-degrade pattern) | Same, and server-side too — never leak internals |
| **Dependency security** | ✅ `npm audit` in the validation checklist | Automated CI scanning + update policy |
| **Cost & budget caps** | N/A (no metered providers) | ✅ Per-provider spend caps (AI/email/SMS/storage) with alerts |

**Backend controls to activate (the hard gate before external users)** — these are
today's client-enforced-only items promoted to mandatory server-side enforcement:
server-enforced lifecycle-transition legality; post-submission / post-`posted` /
post-`approved` immutability; one-open-claim and one-invoice-per-claim race guards;
creator ≠ approver segregation; counter integrity (+1 only, no arbitrary set);
server-enforced uniqueness (contacts / supplier invoices / variations / one active
tender bid per bidder per package) and embedded-line integrity (tender bid
lineItems, allocation arrays); locking down
self-managed `role`/`companyId`; full audit logging; and moving every privileged
provider call server-side. The authoritative list and rationale live in
[SECURITY.md](SECURITY.md) → Deferred Controls / Trusted-Backend Activation
Requirements and [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md) ADR-14.

## 7. Reporting security limitations (mandatory honesty protocol)

Never describe a feature as "secure" or a control as "enforced" when only Firestore
rules-level tenant/role gating exists and the rest is client-side. Distinguish
**rules-enforced** from **client-enforced** every time.

Use this phrasing when a control is client-side only:

> "This is enforced only in the client hook and can be bypassed by a direct Firestore
> call; server-side enforcement is deferred (see SECURITY.md, Deferred Controls item N)."

When asked "is this secure?", answer with **what the trust boundary actually is**
today (Firestore Rules), what it enforces (tenant + role, read restrictions on PII/
financial collections, delete-blocking), and what it does **not** (lifecycle legality,
immutability, race protection, segregation, uniqueness — all deferred). Do not round up.

## 8. Definition of Done

A change is done only when: it follows §1–§3; §4 validation passes (lint, build,
acceptance steps added, negative-path checked); §5 security checklist passes; any new
collection/field has a rules block and SECURITY.md reflects reality; client-only
controls are labelled deferred (§7); and the diff is scoped to the task with anything
else flagged, not silently fixed.
