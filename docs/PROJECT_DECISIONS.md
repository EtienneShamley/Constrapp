# Project Decisions

Concise architectural decision records (ADRs). Each records what was decided,
why, and the accepted consequences. Mechanics live in
[DATA_MODEL.md](DATA_MODEL.md) and [FINANCIAL_WORKFLOWS.md](FINANCIAL_WORKFLOWS.md).

## ADR-0a: Cost Codes as the Commercial Spine

Cost Codes are the single join key connecting every commercial stage of the
lifecycle (Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved
Budget → Commitment → PO → Variation → Progress Claim → Supplier Invoice →
Actual Cost → Forecast → Cash Flow → Final Project Margin → Final Account).
Every commercial document references a `costCodeId` and snapshots a
`costCodeName` at write time.
**Why:** a builder's commercial truth reconciles only if one taxonomy runs
through estimate, budget, commitment, claim, invoice, and final account; a
parallel key at any stage breaks cross-stage reconciliation and reporting.
**Consequences:** every new commercial module must integrate through the
cost-code spine rather than invent its own key (ADR-1 makes cost codes
company-wide precisely so they can serve this role); the snapshot pattern
(ADR-15/ADR-6 idiom) is mandatory so renames never rewrite history.

## ADR-0b: Field Information Must Feed Commercial Outcomes

Field features are included only when they feed or evidence a commercial
outcome — site progress → forecast update, approved variation → budget and
commitment update, defect/delay → risk and forecast impact, drawing
measurement → BOQ quantity, subcontractor bid → award and commitment, site
photo → progress/claim evidence.
**Why:** Constrapp is a commercial-control system, not a field-reporting
product; every field capability must earn its place by improving a commercial
decision, or it dilutes the product into a generic tool.
**Consequences:** a proposed field feature with no stated commercial input or
output is out of scope; Drawings, Photos, and Timeline are positioned as
commercial inputs (see [PRODUCT.md](../PRODUCT.md)), not standalone modules.

## ADR-0c: Opinionated Commercial Workflow Instead of Form-First Configuration

Constrapp ships an opinionated commercial workflow for small and mid-sized
contractors rather than a configurable, form-first toolkit. It is explicitly
**not** a Dashpivot-style platform: no generic no-code form builders, HSEQ
template libraries, generic field reporting, payroll/workforce, fleet/equipment,
or broad enterprise integrations before product-market fit.
**Why:** the differentiated value is a connected commercial lifecycle with
strong defaults; a form-first configuration surface would fragment the data,
undermine the cost-code spine, and compete in a commoditised category.
**Consequences:** these directions are anti-goals requiring an approved
strategy change, not backlog items (see [ROADMAP.md](../ROADMAP.md) →
Anti-Goals and [AGENT.md](../AGENT.md) → Strategic Invariants); detailed
data-model ADRs for BOQ, Tender, Variations, and Forecast are deferred to those
features' implementation sprints.

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

## ADR-15: Single Company-wide Contacts Collection

Contacts live in one collection (`companies/{id}/contacts`) of entities —
organisations or individuals — carrying a multi-valued `contactTypes` array
(supplier, subcontractor, consultant, client, other). Contact people are
embedded on organisation documents (stable generated `id`s, `primaryPersonId`
pointer). The Subcontractors page is a filtered view, not a collection.
POs store `supplierId` (live link) plus a permanent `supplierName` snapshot of
the contact's display name at write time; claims inherit both from the PO.
Historical documents are never backfilled — `supplierId: null` remains valid
forever. Directory reads are restricted to internal financial roles
(third-party PII). Archive via `isActive: false`; deletes blocked (ADR-12
applies — contacts are referenced by financial audit records).
**Why:** real construction entities hold several roles at once — separate
collections would force duplicate records and ambiguous PO references;
embedding people follows ADR-6 (few, always read with parent, no independent
query); the snapshot pattern matches `costCodeName` so renames never rewrite
history.
**Consequences:** type-specific views filter client-side; people needing
independent identity (portal logins) will require extraction to a
subcollection later; duplicate detection is client-side warn-only (see
SECURITY.md); GST status and payment terms are stored but not yet connected
to any calculation.

## ADR-16: Embedded Project Assignments on Contacts

Contacts carry an embedded `projectAssignments` array
(`{ projectId, trade, projectRole, scope, status, notes }`, one entry per
project) plus a `projectIds` string array derived from it in the same write
(the `displayName`/`nameLower` denormalisation idiom — single writer, no
drift). A contact stays company-wide; assignment is an additive preference,
never an ownership or visibility boundary. The PO supplier picker groups
project-assigned contacts first but every active supplier remains selectable;
quick-creating a supplier from a PO auto-assigns it to that project, while
merely *selecting* an unassigned contact never mutates it. No `projectName`
snapshot is stored — assignments are administrative, not frozen financial
records, and names resolve live from the (undeletable) projects collection.
**Why not a `contactAssignments` subcollection:** assignments are few, always
read/written with their parent contact, and every consumer already filters the
full in-memory directory (ADR-6/ADR-15 reasoning); a subcollection would force
batched multi-document writes, extra listeners or collection-group indexes,
and — decisively — new manually-published security rules to keep contact PII
restricted to financial roles, whereas embedded fields are covered by the
existing contacts rules with **zero rules changes**.
**Consequences:** POs and claims are untouched — they stay self-contained via
`supplierId`/`supplierName` snapshots, so assignments can be added or removed
freely; pre-existing contacts lack the fields and are treated as unassigned
(no migration/backfill); archived-contact assignment restrictions and
`projectIds` consistency are client-enforced only (ADR-14 posture — see
SECURITY.md); if per-project data later needs independent lifecycle (portal
access, compliance documents), extraction to a subcollection is the recorded
path, mirroring ADR-15's escape hatch for `people`.

## ADR-17: Supplier Invoices (Accounts Payable)

Supplier invoices live at
`companies/{id}/projects/{id}/supplierInvoices` — project-scoped, `SI-0001`
numbered from a company-wide counter (ADR-5). They are the **cost side**
(accounts payable); the word *invoices* is reserved for future client/AR
invoicing. Two sources: `direct_po` (against one sent/closed PO, no claim, entered
amounts, multiple over time) and `progress_claim` (from one approved claim,
certified amounts fixed, one non-cancelled invoice per claim). One PO per invoice;
multiple POs per invoice and partial invoicing of a claim are deferred. Line
amounts are ex-GST with per-line `taxCode` (`gst`/`gst_free`/`input_taxed`) and
computed `gstAmount`, so mixed-tax invoices are representable; contact `gstStatus`
is advisory only. Gross and payable totals are stored separately
(`subtotal`/`gstTotal`/`grossTotal` vs `net`/`payableGst`/`payableTotal`), with
retention carrying its own `retentionGst` (`retention × 10%`) so a claim-sourced
invoice reconciles **exactly** to the approved claim's `approvedGst`/
`approvedTotal` — creation is blocked otherwise; direct-PO invoices use retention
0 so payable equals gross. Lifecycle `draft → approved → posted` (+ `cancelled` pre-post);
`received`/`under_review`/`disputed`/`paid` reserved. **`posted` is the financial
commit point and is immutable — no cancel/unpost; corrections are future Credit
Notes.** Reads are restricted to financial roles (AP billing detail).
**Why:** real AU construction has two distinct invoicing realities — subbies
invoice against a certified progress claim, while material suppliers invoice
directly with no claim — and both must reach Actual. Per-line tax codes match
real supplier invoices and map cleanly to accounting tax codes later. The
snapshot/immutability/forward-only patterns mirror POs and claims (ADR-7/11/12).
**Consequences (budget figures):** all figures stay **read-time derived** — no
Budget Line writes (ADR-3/ADR-4 upheld; the vestigial `invoiced: 0` field stays
ignored). **Committed matures** to *remaining open commitment* (PO line −
posted/paid invoiced-to-date, floored at 0), so Committed and Invoiced/Actual
become complementary rather than overlapping. **Actual** = approved claims *not
superseded by a posted/paid invoice* + posted/paid invoice lines; the anti-double-
count is a **read-time exclusion** keyed on the invoice's `progressClaimId` — the
claim document is **never** mutated or stamped `invoiced` (honouring "don't
rewrite claims" and self-healing when an invoice is cancelled). Over-invoicing and
duplicate `supplierInvoiceNumber`s warn but never block; server-side transition
legality, post-`posted` immutability, one-invoice-per-claim races, and uniqueness
are deferred (ADR-14). Existing `supplierId: null` POs remain invoiceable via
their `supplierName` snapshot. **Reserved for later:** Payments (`paid`/`paidAt`),
Credit Notes (`docType`/`adjustsInvoiceId`), attachments (`attachments: []`),
accounting sync (`externalRefs`).

## ADR-18: Variations (one type-discriminated collection; approved-only; read-time)

Commercial variations live in **one** collection
(`companies/{id}/projects/{id}/variations`) discriminated by `variationType`:
**client** (head-contract revenue change) and **supplier** (subcontract commitment
change). Numbered `CV-0001`/`SV-0001` from company-wide counters
(`variationsClient`/`variationsSupplier`, ADR-5). Cost Codes are the mandatory
spine on every line (`costCodeId` + frozen `costCodeName`). Amounts are ex-GST with
a per-line `taxCode` (`gst`/`gst_free`/`input_taxed`); header totals derive from
the lines (no flat header rate); negative amounts/GST (credits/omissions) are
supported and never clamped. Lifecycle `draft → submitted → approved`, plus
`rejected`/`withdrawn` (all terminal); `under_review`/`disputed`/`superseded`
reserved. A submitted **request** becomes an approved **order** through approval —
stages, not separate entities. Approval uses per-line `approvedAmount` prefilled
from submitted, **unbounded** (above/below/zero/negative), requiring
`assessmentNotes` when values differ. **Only `approved` counts, and only at read
time.** A supplier variation references **one** sent/closed PO or **none**; a line
may inherit+lock a PO line via `poLineIndex` (new scope otherwise). Reads are
restricted to internal financial roles.
**Why:** real construction has two distinct change realities — a change to what the
client pays (revenue) and a change to what a subcontractor is owed (cost) — and
both must reconcile through the cost-code spine; one type-discriminated collection
mirrors ADR-15's single-contacts decision and shares one register/hook/rules block.
**Consequences (budget figures):** the six canonical figures are **unchanged**.
Approved **supplier** variations are surfaced as a **separate** read-time
**Commitment Exposure** (`Committed + approved supplier variations`, ex-GST) —
deliberately *not* "Adjusted Committed" and not folded into Committed, because
variation commitment **does not yet mature** against claims/invoices. Approved
**client** variations are a **revenue-side input only** — they never touch the cost
Budget. Variations **never** write onto Budget Lines and **never** mutate POs,
claims, or invoices (ADR-3/ADR-4/ADR-7 upheld). The reserved
`progressClaims.variationId` stays `null`; claim-against-variation and
invoice-against-variation linkage are **deferred**, and no variation references are
added to PO/claim/invoice line items. **Internal Budget Adjustments** (transfers/
revisions with no external counterparty) are a **separate future document type**,
not variations. Attachments (`attachments: []`) reserved — no uploads. Server-side
transition legality, post-submit/approval immutability, creator≠approver
segregation, and (counterparty + reference) uniqueness are **deferred** (ADR-14);
duplicate detection is client-side warn-only. No migration — additive only;
existing documents and snapshots are untouched.

## ADR-19: Forecast Cost to Complete (per-cost-code inputs; read-time; cost-side only)

The **Forecast Cost to Complete** foundation lives at
`companies/{id}/projects/{id}/forecastLines`, one document per cost code with the
**document ID = `costCodeId`** (a deterministic natural key — one current forecast
per cost code, idempotent upsert, never `addDoc`). The **only** stored input is
`uncommittedCostToComplete` (`number | null`) plus `notes` and audit stamps; a
transaction sets `createdAt`/`createdBy` once and refreshes `updatedAt`/`updatedBy`
every save. `null` = *not forecast*, `0` = reviewed/no further cost, `< 0` rejected.
Every displayed figure is **derived at read time** by composing the existing
Budget-page helpers (`lib/forecast.js` over `purchaseOrders.js`/`progressClaims.js`/
`supplierInvoices.js`/`variations.js`), never stored back (ADR-3/ADR-4 upheld):

```
Cost to Complete    = Remaining Committed + Uncommitted Cost to Complete
Forecast Final Cost = Actual + Remaining Committed + Uncommitted Cost to Complete   (EAC)
Variance to Budget  = Budgeted − Forecast Final Cost                                (VAC)
```

**Why cost-side only, single input, no auto-defaults, variations kept separate:**
a builder's forward number must be a *conscious* estimate, not an arithmetic
assumption. The forecast is deliberately **strictly cost-side** (no revenue, cash
flow, margin, or final account). Defaulting Uncommitted CTC to remaining budget is
**refused** — it would force Variance to zero and mask overruns; a **Remaining
Budget Reference** is shown only behind an explicit "Use remaining budget" action.
Approved **and** pending supplier variations are shown as **separate exposure** and
are **never** added into Forecast Final Cost — there is intentionally **no**
"FFC including variation exposure" total — because supplier variations do not yet
mature against claims/invoices (ADR-18), so auto-adding one would double-count it
once its PO is invoiced; the forecaster folds the remaining expected variation cost
into Uncommitted CTC instead. Client variations do not appear on the cost forecast.
**Consequences:** the Forecast tab reuses the exact Remaining Committed / Actual
calculations (PO lifecycle and commitment maths unchanged); closed-PO residual
commitment is flagged (amber) but left visible for QS judgement, not removed. The
cost-code **union** spans budget lines, sent/closed PO lines, Actual, posted/paid
invoices, supplier variations, and existing forecast lines (same unbudgeted-row
idiom as the Budget page); inactive codes are retained. Current forecast lines are
**living editable inputs**, not immutable records — **no** Draft/Review/Approved
status, formal approval, or creator≠approver segregation (all deferred, ADR-14
posture). Reads are restricted to internal financial roles (forecast reveals
expected overruns/implied margin — tighter than the company-member `budgetLines`
read, matching Variations/Supplier Invoices/Contacts). Deletes blocked — clearing
an input writes `null`. **Deferred:** reporting periods, monthly reporting, cut-off
dates, period locking, immutable snapshots, prior-period comparison, probability
weighting, risk allowance, forecast adjustment, final-forecast override, and (out
of this branch) Forecast Revenue, Cash Flow, Project Margin, Final Account, PULSE.
`variations.forecastAmount` is **not** used. No migration — additive only; a project
without `forecastLines` loads normally with every cost code *not forecast*. Current
inputs vs future **immutable period snapshots** is the recorded evolution path
(mirrors the current-vs-frozen split elsewhere).

## ADR-20: Project Margin (commercial baseline as a separate document; read-time; ex-GST; no currency field)

The **Project Margin** foundation adds a per-project **Commercial Baseline** at
`companies/{id}/projects/{id}/commercial/baseline` — a single document with the
**deterministic id `baseline`** (idempotent upsert; a transaction sets
`createdAt`/`createdBy` once and refreshes `updatedAt`/`updatedBy`). It stores the
**only** authored inputs: `originalContractValue` (ex-GST),
`originalApprovedBudget` (ex-GST, `number | null`), `contractStartDate`/
`contractCompletionDate` (`Timestamp | null`), `clientId` + frozen `clientName`
snapshot, and `notes`. Every margin figure is **derived at read time** by
`lib/margin.js`, which **composes** `lib/variations.js` (approved/pending client &
supplier variation totals) and `lib/forecast.js` (Forecast Final Cost) — nothing is
recomputed independently and nothing is written back (ADR-3/ADR-4 upheld):

```
Current Contract Sum      = Original Contract Value + Approved Client Variations
Forecast Revenue          = Current Contract Sum
Forecast Gross Profit     = Forecast Revenue − Forecast Final Cost
Forecast Margin %         = Forecast Gross Profit ÷ Forecast Revenue × 100
Original Planned Profit   = Original Contract Value − Original Approved Budget
Original Planned Margin %  = Original Planned Profit ÷ Original Contract Value × 100
Margin Movement           = Forecast Gross Profit − Original Planned Profit
```

**Why a separate document, not fields on the Project doc:** Firestore rules apply one
read rule per document. The Project document is **company-member readable**
(subcontractors/clients can read it), but contract value and implied margin are
commercially sensitive and must be **financial-role-only** reads (matching Variations,
Supplier Invoices, Forecast Lines, Contacts). A dedicated document gets its own rules
block restricted to the single `baseline` id (no arbitrary `commercial/*` docs), keeps
contract value off the company-member-readable Project doc, and lets `qs` write it
(the Project doc is writable only by `company_admin`/`project_manager`). No migration
— a project without a baseline loads with a "not set" empty state.
**Why read-time, revenue = current contract sum, no currency field, no cash:**
margin must never drift, so only the baseline is stored. Forecast Revenue equals the
**Current Contract Sum** in the foundation (no separate manual revenue forecast —
there is no reliable anchor for one yet); pending client variations are separate
**revenue exposure**, approved/pending supplier variations are separate **cost
exposure** never folded into Forecast Final Cost (ADR-19 reasoning — they don't yet
mature, so auto-adding double-counts). Values are **ex-GST** and use the app's existing
AUD display; the baseline stores **no `currency` field** and introduces **no** new
hard-coded AUD values — company/project currency inheritance and removal of hard-coded
AUD formatting are the **next foundation** (`feature/company-country-currency`), with
**no FX conversion**. There is deliberately **no cash figure**: Client Invoices,
Accounts Receivable, and Payments do not exist, so *Forecast Revenue* is never
presented as invoiced or received. **Null/zero:** revenue ≤ 0 ⇒ Margin % `null` ("—");
`originalApprovedBudget === null` ⇒ Original Planned Profit/Margin and Margin Movement
"—"; negative approved variations stay signed and reduce Current Contract Sum.
**Consequences:** the six budget figures and the Forecast tab are unchanged; margin is
project-level (it sits above the cost-code spine — contract revenue has no cost code,
exactly as client variations have no PO), shown on a new **Commercial** tab and as
financial-role-only cards on Overview via the same `lib/margin.js` derivation (no
duplicated logic). The baseline is a **living editable input** — no draft/approved
status, no snapshots, no approval workflow; **Original-Approved-Budget immutability is
not claimed** (unenforceable without a trusted backend). Server-side non-negative
validation and immutability are **deferred** (ADR-14; duplicate/immutability guards are
client-side only). **Deferred:** Cash Flow, Client Invoices, Accounts Receivable,
Payments, retention modelling, monthly periods, immutable snapshots, probability
weighting. The recorded sequence is **Project Margin → Company Country & Currency →
Payments/Client Invoices → Cash Flow**.
