# Project Decisions

Concise architectural decision records (ADRs). Each records what was decided,
why, and the accepted consequences. Mechanics live in
[DATA_MODEL.md](DATA_MODEL.md) and [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).

## ADR-1: Company-wide Cost Codes

Cost codes live at `companies/{companyId}/costCodes`, not per project.
**Why:** one taxonomy across all projects enables cross-project reporting and
consistent supplier/PO coding; builders reuse the same code library job to job.
**Consequences:** codes can't be project-customised; deactivation (`isActive`)
instead of deletion keeps history valid.

## ADR-2: Project-level Budget Lines

Budget allocations live under each project (`…/projects/{id}/budgetLines`),
referencing company cost codes.
**Why:** budgets are per-job; the same code carries different allocations on
different jobs.
**Consequences:** project financial views join budget lines to POs/claims by
`costCodeId` at read time.

## ADR-3: Read-time Financial Derivation

Committed, Claimed, and Actual are computed in the browser from live PO/claim
snapshots on every render — never stored as rollups.
**Why:** stored rollups drift (missed updates, races, partial failures) and
client-maintained ones can't be trusted; deriving from source documents is
always consistent with what's on screen.
**Consequences:** O(POs + claims) work per render (fine at current scale);
cross-project dashboards will eventually need aggregation (Cloud Functions or
scheduled rollups) — accepted future cost.

## ADR-4: No Client Writes from POs/Claims into Budget Lines

Corollary of ADR-3, held as an invariant: no PO or claim code path ever
updates a budget line's financial fields.
**Why:** budget lines would silently corrupt on any bug/race in the writer;
audit trail stays clean when financial truth lives only on the source documents.
**Consequences:** the vestigial `committed`/`actual` zeros on budget-line docs
are ignored; `invoiced` stays stored-but-zero until an invoices module (a
server-side writer) exists.

## ADR-5: Company-wide Transactional Document Numbering

PO/claim numbers come from `companies/{id}/counters/{type}.next`, read and
incremented inside the same Firestore transaction that creates the document.
**Why:** builders expect gapless-ish, human-referenceable sequential numbers
unique across the company (suppliers see them); a transaction prevents
duplicates under concurrency.
**Consequences:** counters are a write hot-spot (fine at current volume);
counter documents are client-writable for now (see SECURITY.md deferred item).

## ADR-6: Embedded PO Line Items

PO line items are an array on the PO document, not a subcollection.
**Why:** lines are always read/written with their PO, are few in number, and
freeze after sending — no independent query need.
**Consequences:** 1 MiB doc limit bounds line count (not a practical concern);
claim lines reference PO lines by array index (`poLineIndex`).

## ADR-7: Frozen PO Lines After Sending

A PO's supplier, lines, and amounts are editable only in `draft`; from `sent`
onward they are immutable (client-enforced today).
**Why:** a sent PO is a commercial commitment — the committed figure and any
claims against it must reference stable values; also makes `poLineIndex` a
stable key.
**Consequences:** corrections require cancel + re-raise (revision workflow is
future); server-side immutability enforcement is a deferred security item.

## ADR-8: Cumulative Progress Claims

Claims capture *claimed-to-date* per PO line; this-period amounts are derived
by subtracting previously approved amounts.
**Why:** matches Australian construction practice (progress certificates are
cumulative) and self-corrects — each claim re-anchors on certified-to-date, so
disputes don't compound.
**Consequences:** creating a claim needs the PO's earlier approved claims
loaded; claimed-to-date can't drop below approved-to-date.

## ADR-9: One Open Progress Claim per PO

A PO can have only one claim in draft/submitted/under_review at a time.
**Why:** two open claims would race over the same previously-approved baseline,
double-counting this-period amounts.
**Consequences:** suppliers queue claims per PO (matches monthly claim cycles);
enforcement is client-side today — the server-side race guard is a deferred
security item.

## ADR-10: Retention and GST Treatment

Retention is entered per claim as an ex-GST amount clamped to the subtotal;
GST (10%) applies to the net payable (subtotal − retention); all line/budget
amounts are ex-GST; every figure passes `roundMoney` (cents).
**Why:** matches AU practice — retention is withheld before GST, and budgets
compare ex-GST; central rounding keeps totals reconcilable with accounting
systems.
**Consequences:** retention release is not yet modelled; percentage-based
retention is manual for now.

## ADR-11: Forward-only Lifecycles

PO and claim statuses only move forward (`canTransition` whitelists);
`closed`/`cancelled`/`rejected`/`invoiced` are terminal. Reserved statuses
(`pending_approval`, `under_review`, `invoiced`) exist in code with no UI path.
**Why:** financial documents shouldn't un-happen; corrections are new documents
(re-raise a PO, raise a corrected claim), preserving the audit story.
**Consequences:** no "undo"; mis-sent POs must be cancelled and re-raised.

## ADR-12: No Deletion of Financial Audit Records

Firestore rules block deletes on cost codes, budget lines, POs, claims, and
counters. Cancellation/rejection/deactivation are status changes.
**Why:** POs and claims are audit records with legal/commercial weight;
numbering gaps and dangling references are worse than visible cancelled rows.
**Consequences:** data corrections happen by status + new documents; genuine
cleanup (e.g. test data) requires console/admin access.

## ADR-13: Hooks-only Firestore Access

All Firestore access flows through `src/hooks/*`; pages never import
`firebase/firestore`. Pure domain logic lives in `src/lib/`.
**Why:** one place per collection for queries/writes, consistent live-snapshot
behaviour and error handling, and pages stay presentational; lib functions are
unit-testable without Firebase.
**Consequences:** new collections need a hook first; some hooks re-subscribe
per page mount (acceptable; context providers exist where sharing matters).

## ADR-14: Deferred Cloud Functions & Server-side Enforcement

No backend today: client SDK + Firestore rules only. Lifecycle legality,
immutability, claim races, approver segregation, counter integrity, and audit
logging are client-enforced (see [SECURITY.md](SECURITY.md)).
**Why:** maximum iteration speed pre-validation; every write is still tenant-
and role-gated by rules, and all users are hand-provisioned insiders while the
product is unlaunched.
**Consequences:** a malicious/buggy authorized client can corrupt financial
state; hardening (Functions and/or richer rules) must land before external
users — tracked in [ROADMAP.md](../ROADMAP.md).
