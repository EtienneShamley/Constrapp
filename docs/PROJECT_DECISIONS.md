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
their `supplierName` snapshot. **Reserved for later:**
Credit Notes (`docType`/`adjustsInvoiceId`), attachments (`attachments: []`),
accounting sync (`externalRefs`). **`paid`/`paidAt` were reserved here for a
future Payments module; Supplier Payments have since shipped and deliberately
DEPRECATED them in place rather than activating them — see ADR-24.**

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

## ADR-21: Company Country & Project Currency (inherited, locked, label-only; no FX)

A company stores `countryCode` (ISO 3166-1 alpha-2) and `baseCurrency` (ISO
4217); a project stores `currency` (ISO 4217) and `currencyLocked` (boolean).
Country **suggests** a currency, the user **confirms or overrides** it, a new
project **inherits** the company base currency (overridable at creation), and
every financial screen displays the **project's** currency through one shared
`formatCurrency(amount, currencyCode)` helper. Display resolves
`project.currency` → `company.baseCurrency` → `AUD`.

**Why a label and never a conversion.** Constrapp performs **no FX conversion**,
holds no rates, and supports no mixed-currency project transactions. A currency
is a *label* for amounts that were entered in it. This is the reason for every
other decision here: relabelling a number without converting it silently
falsifies it.

**Why currency locks on any monetary value.** Currency locks as soon as the
project holds money — a non-zero headline `budget`, any budget line, any
purchase order (**including draft and cancelled** — a cancelled PO is a retained
audit record carrying amounts, ADR-12), any progress claim, supplier invoice,
client or supplier variation, any forecast line with
`uncommittedCostToComplete !== null` (a `null` row is *not forecast* and carries
no money), or an established commercial baseline. `project.budget` is
**deliberately included**: it is a monetary amount, and excluding it would let a
project's headline budget be relabelled after entry. Cost Codes and Contacts are
company-wide and hold no monetary value, so they never lock.

**Why the ratchet, and what it does not do.** Firestore Security Rules offer
`get()`/`exists()` on a known document path only — no list, query, or count — and
every financial subcollection uses random document ids. **No rule can determine
whether a project has financial records.** Rather than pretend, the design
splits the control: the *evidence check* is client-side (`lib/currency.js` →
`monetaryLockReasons`), and the *consequence* is rules-enforced — once
`currencyLocked` is `true`, rules reject any change to `currency` and any attempt
to set the flag back to `false`. A client that bypasses the app can decline to
**set** the lock; no client can **unset** it.

**Lock activation is atomic with the record.** Every hook that writes monetary
data stages the ratchet inside its **own Firestore transaction** via one shared
helper (`hooks/projectCurrencyLock.js` → `stageProjectCurrencyLock`), so the
record and the lock succeed or fail together. A separate post-write lock would
have left a real gap: if the record committed and the lock write then failed
(network drop, closed tab, rules rejection), the project would hold amounts while
its currency stayed changeable — the exact harm the ratchet exists to prevent.
Because Firestore requires all transaction reads before any writes, the helper
splits into a read phase (returning a commit callback) and a write phase. It
stages the write **only** when the project is not already locked: besides saving
a redundant write, an unconditional `true` would be **rejected** by the narrow
`qs` rule (`false` → `true` only) and would fail the whole financial write for a
QS user. `useProjects.lockProjectCurrency` survives solely as a repair path for
projects whose monetary data predates this behaviour, self-healing on the next
Project Overview visit by a `company_admin`/`project_manager`. No page ever writes
the project document to engage the lock.

**Why `qs` gets one narrow project permission.** `qs` writes budget lines, POs,
claims, invoices, variations, and forecast lines, all of which must engage the
lock — but `qs` deliberately has no general project write access. Rules therefore
grant `qs` exactly one project update: `currencyLocked` `false`→`true`, with a
`hasOnly(['currencyLocked'])` diff so it cannot touch currency, name, budget,
status, or dates. The lock write carries **no audit stamps** so that rule can
stay maximally narrow.

**Why existing companies are not auto-backfilled.** A company without
`baseCurrency` displays `AUD` — reproducing the previous output byte-for-byte —
and shows a setup banner. **Nothing is written until an admin confirms.**
Auto-writing `AUD` would assert a business fact nobody stated and would make a
guess indistinguishable from a confirmed choice.

**Why existing projects are pinned during setup.** A project with no stored
`currency` resolves through the company, so confirming a base currency would
otherwise **relabel every historical project at once**. Company setup therefore
lists every existing project, defaults each to the chosen currency, lets the
admin override individual projects, and pins them in the same confirmed action.
Writes are **projects first, then the company**: if the project writes fail the
company stays unconfigured, the banner stays up, and retrying is safe — the
reverse order would leave a configured company with floating projects. The
backfill is additive and idempotent (only projects whose effective currency
differs are written; a project that already carries an explicit currency is never
overwritten unless the admin deliberately re-points it while still eligible), and
it deliberately does **not** set `currencyLocked`, so one confirmation never
performs two irreversible operations.

**Why document `currency` snapshots are kept but never displayed.** POs, claims,
supplier invoices, and variations already stored a hard-coded `currency: 'AUD'`
that nothing read. They now snapshot the resolved **project** currency at write
time (the frozen `supplierName`/`costCodeName` idiom) and remain **audit context
only** — the project currency stays the display authority, so a project can never
render mixed currencies. Historical `'AUD'` values are **never rewritten**: they
are the correct record of documents raised when the app was AUD-only.

**Why one fixed display locale.** `formatCurrency` uses a single `en-AU` locale,
unchanged from the previous formatter. AUD therefore still renders `$1,235` —
byte-for-byte the old output — while every other currency renders with its ISO
code (`NZD 1,235`), so an AUD figure can never be mistaken for an NZD or USD one
in a company running projects in several currencies. Whole units
(`maximumFractionDigits: 0`) are preserved as the default so migrating 77 call
sites changed no existing display; `{ precise: true }` defers to each currency's
ISO 4217 minor-unit convention. `0` formats as a real zero (ADR-19 relies on `0`
meaning *reviewed, no further cost*); `null`/`undefined`/non-finite render `—`; a
malformed code falls back to `CODE 1,235` rather than throwing, so one bad
document cannot blank a financial page. **Per-country display locales and date
localisation are deliberately out of scope** and recorded as a later improvement
— `formatDate` remains `en-AU`, which is a known limitation for US users
(`03/04/2026` reads differently there).

**Why a local country/currency mapping.** ~100 lines of data that changes on a
decade timescale, against AGENT.md's prohibition on new dependencies. Complete
ISO data would also produce a 249-entry dropdown for a product targeting a
handful of markets. The mapping only ever *suggests*: country → currency is not
a function (dollarised economies, EU-but-not-eurozone, cross-border currency
unions, and decisively — a company's country is not its contract's currency),
which is exactly why confirmation is mandatory.

**Consequences.** No financial calculation changes anywhere: `lib/` domain
modules stay currency-agnostic pure number maths, the six budget figures,
forecast, and margin derivations are untouched, and no stored amount is
converted, recalculated, or migrated. **Tax is explicitly not in scope** —
`GST_RATE` remains a flat Australian 10% and the "GST 10%" labels remain
Australian; Company Settings warns whenever the chosen country is not `AU` that
currency display is configurable while tax calculation is not. Country-specific
tax configuration is a separate future foundation. **Deferred:** FX conversion
(never planned), mixed-currency transactions, per-country display locales, date
localisation, self-serve company signup (the settings form is designed to be
reused as a signup step), server-derived lock activation, and known-code
validation in rules.

## ADR-22: Client Invoices & Accounts Receivable (read-time control; rules-enforced lifecycle; no payment state)

Client invoices live at
`companies/{id}/projects/{id}/clientInvoices` — project-scoped, `CI-0001`
numbered from a company-wide counter (ADR-5). They are the **revenue mirror** of
supplier invoices (ADR-17): controlled against the **Current Contract Sum** and
**approved client variations**, never against a PO, a claim, or a supplier. Line
amounts are ex-GST with a per-line `taxCode` (`gst`/`gst_free`/`input_taxed`) and
a derived `gstAmount`; there is **no retention and no payable/gross split** on the
client side, so `grossTotal` is unambiguously what the client was billed.
Lifecycle `draft → issued → void` (void terminal); `sent` reserved. Reads are
restricted to internal financial roles. Every control figure — Issued Client
Invoices, Available to Invoice, per-variation invoiced/remaining, and the ageing
buckets — is **derived at read time** (`lib/clientInvoices.js`) and never written
back (ADR-3/ADR-4 upheld).

**Why no payment state, not even reserved.** Supplier invoices reserved a
`paidAt: null`. Client invoices deliberately reserve **nothing** payment-related —
no `paid`/`partially_paid` status, no `amountReceived`, no `balance`. A payment
field on the invoice is an invitation for a client-maintained rollup; receipts
will be their own collection and every balance will be derived. Because no
Receipt record exists, the product may not say **paid, unpaid, amount owing,
outstanding receivables,** or **overdue receivables** — it says
**"Issued, not yet reconciled"**, **"Past due date"**, and **"Ageing by due
date"**, with a permanent notice that an issued invoice stays listed until it is
voided regardless of payment. `sent` is reserved rather than live for the same
honesty reason: with no delivery mechanism, a `sent` status would assert
something about the outside world that the app cannot evidence.

**Why `costCodeId` is OPTIONAL on invoice lines (a recorded spine exception).**
AGENT.md requires every commercial document to join through the cost-code spine,
but ADR-20 already carved a project-level exception for contract revenue
("contract revenue has no cost code, exactly as client variations have no PO").
Head-contract billing has no natural cost code, and forcing one would make
builders invent revenue codes that corrupt the taxonomy. A **contract line**
therefore stores `null`; a **variation line** inherits a frozen cost-code
snapshot **only when the linked variation resolves to exactly one cost code**,
and `null` when it spans several — a single snapshot across a multi-code
variation would be a false attribution.

**Why the lifecycle is enforced in Firestore rules — a deliberate asymmetry.**
Every other financial collection enforces transitions and immutability in the
client hook only (SECURITY.md Deferred Controls 1–2). Here they are
**rules-enforced**, because this lifecycle needs no cross-document read and an
invoice issued to a client is an outward-facing revenue document: create is
draft-only with unforgeable lifecycle stamps; every update must preserve
`invoiceNumber`/`currency`/`createdAt`/`createdBy`/`docType`/`revision` and stamp
the caller and `request.time`; `draft → issued` and `draft|issued → void` may
each affect only their own key set, with `issuedBy`/`voidedBy` equal to the
caller, stamps equal to `request.time`, and a non-empty `voidReason`; issued
invoices are consequently immutable except for voiding; `void` is terminal and
delete is blocked outright. Issuing is therefore necessarily a **separate
operation** from saving the draft. **This asymmetry is the intended future
standard** for POs, claims, supplier invoices, and variations.

**What remains client-enforced (never claim otherwise).** Rules have no list,
query, or count, so they cannot sum sibling documents: **Available to Invoice and
the per-variation remaining balance are advisory warnings only**, over-invoicing
is warned with an explicit acknowledgement rather than blocked, and **two users
can concurrently invoice the same remaining value**. Line-total consistency
(rules cannot iterate an array), approved-variation linkage validity, invoice-
number uniqueness (Deferred Control 6), and creator ≠ issuer segregation are
likewise client-side. The invoice *number* itself is race-free — counter,
invoice, and the project currency ratchet commit in **one transaction** (ADR-21),
so a project can never hold an invoice with a still-changeable currency, and a
failed transaction leaves no counter gap. Gaps arise only from **voided
invoices**, which retain their number: intentional audit behaviour, not a defect.

**Why pending and negative variations are not invoiceable.** Approval is the
counting point (ADR-18), so billing a pending variation would bill unagreed work.
A **negative** approved variation (a credit/omission) cannot be positively
invoiced either — it still reduces the Current Contract Sum through the existing
signed `approvedClientVariationsTotal`, and a future Credit Note bills it.
Invoicing **never mutates a variation** — no stamp, no status change, no
back-reference — exactly as ADR-17 keeps claims unmutated by supplier invoices.

**Why `externalInvoiceReference` is authored while `externalRefs` stays reserved.**
Constrapp cannot produce a compliant Australian Tax Invoice: the company document
holds no legal name, ABN, address, or tax number, and its rules permit updating
only the four currency fields. This branch therefore ships **no printable
invoice, no PDF, no email, and no "Tax Invoice" labelling** — it is a commercial
control register, and the optional `externalInvoiceReference` string ties a record
to the invoice the client actually received from Xero/MYOB/QuickBooks or a manual
process. It is editable while draft and frozen on issue, and is distinct from
`clientRef` (the *client's* contract/PO reference). `externalRefs` remains an
empty reserved map for future *structured* integrations.

**Consequences.** The six budget figures, the Forecast tab, and Project Margin are
**unchanged** — client invoices are revenue-side and feed no cost figure, and
margin is deliberately not affected by invoicing (invoiced revenue is not
recognised revenue). Default client payment terms come from the **client contact**
and are snapshotted; contract-level terms on the commercial baseline are the
correct long-term home but are **deferred**, since this branch does not modify the
baseline. Client invoices join the currency-lock evidence in `lib/currency.js`.
The Commercial tab gains sub-navigation (Margin · Client Invoices) rather than a
fifteenth project tab, and the existing supplier-invoice tab is relabelled
**Supplier Invoices** so two modules are not both called "Invoices". **No
migration** — additive only; a project without `clientInvoices` loads normally.
**Deferred:** Payments and Receipts, cash flow, credit notes (`docType`/
`adjustsInvoiceId` reserved), client retention, revenue recognition, client
progress claims, printable/PDF/email output, company legal & tax identity, and
client-portal access. The recorded sequence is **Company Country & Currency →
Client Invoices / Accounts Receivable → Payments and Receipts → Cash Flow**.
(Client Receipts — the money-in half of Payments and Receipts — have since
shipped; see ADR-23.)

## ADR-23: Client Receipts (embedded allocations; read-time balances; cash ≠ revenue)

Client Receipts live at
`companies/{id}/projects/{id}/clientReceipts` — project-scoped, `CR-0001`
numbered from a company-wide counter (ADR-5). They record **cash actually
received** from a head-contract client and allocate it against issued Client
Invoices, turning *"issued, not yet reconciled"* into a real receivables balance.
Lifecycle `draft → posted → void` (void terminal), enforced by Firestore rules.
Reads are restricted to internal financial roles.

**Two collections, not one `cashTransactions`.** Supplier Payments will be a
separate sibling collection (`supplierPayments`), not a direction field on a
shared one. The app's precedent is the split, not the merge: `clientInvoices` and
`supplierInvoices` were deliberately kept apart (ADR-17/ADR-22) despite being
structurally similar. `variations` is the one type-discriminated collection
(ADR-18) precisely because both types share one register, one hook, and one rules
block — which receipts and payments do not. A merged collection would force every
rules clause to branch on direction, which is how rules become unreviewable. A
company-level cash collection was rejected outright: it would break project
isolation and, decisively, the one-currency-per-project guarantee (ADR-21).
Future company-wide cash reporting is reachable by collection-group query with
its own rule and index.

**Embedded allocations, and NOTHING written onto invoices.** Allocations are an
array on the receipt (`{ clientInvoiceId, invoiceNumber, allocatedAmount }`) per
the ADR-6 idiom: few, always read and written with their parent, frozen once
posted, no independent query need. **Received to Date, Remaining to Reconcile,
and reconciliation state are derived at read time** and never stored (ADR-3/
ADR-4). A stored `receivedToDate` rollup on the invoice was considered and
**rejected**: it would make over-allocation transactionally safe, but it would
require **widening the issued-invoice immutability rules — the app's only
rules-enforced immutability and the intended standard for every other
collection** — and the guarantee would still be partial, because rules cannot
verify the rollup against sibling receipt documents. Read-time derivation also
means **voiding a receipt restores every balance for free**, with no reversal
document and no invoice write.

**Cash is not revenue, and a receipt is not a taxable supply.** A receipt stores
gross cash only — **no GST, no tax code, no net amount**. The tax was recorded on
the invoice; recomputing it here would double-count it and disagree with the
invoice on a partial payment. Receipts feed no budget figure, no forecast, and no
margin figure. `receiptDate` is a `'YYYY-MM-DD'` string (the app's convention for
every human-entered financial date) — a cash date is a calendar fact off a bank
statement, not an instant, and the future Cash Flow module groups by month with
`slice(0, 7)` without constructing a Date. **Cash Flow must consume
`receiptDate`, never `createdAt`/`postedAt`.**

**Why `clientId` is required and never null.** Every other counterparty link in
the app tolerates `null` for pre-Contacts history (`supplierId`). A receipt has
no history to accommodate — it is a new collection — and money received from
nobody is not a record, so `clientId`/`clientName` are **required non-empty and
rules-enforced**.

**Unallocated money is permitted, and never auto-applied.** A receipt may be
posted fully, partly, or entirely unallocated (the client pays early, overpays,
or the allocation is not yet known). Unallocated cash **reduces no invoice
balance** and is reported separately as money on account; an explicit
"Allocate oldest first" action produces an editable proposal and runs only when
pressed. Auto-applying cash to the oldest debt is an accounting policy Constrapp
does not make on the user's behalf.

**The one arithmetic guarantee, in whole cents.** Rules enforce
`allocatedTotal + unallocatedAmount == amount` (both ≥ 0, `amount > 0`) so a
receipt can never *claim* more allocation than the cash it holds. It is compared
via `math.round(v * 100)` because rules numbers are IEEE-754 doubles and exact
equality rejects real money (`0.10 + 0.20` is `0.30000000000000004`) — a
**representation fix, not a loosened invariant**: a one-cent discrepancy still
fails, and `lib/payments.js → toCents()` mirrors it so client and rules never
disagree. Verified by emulator tests.

**What remains client-enforced (never claim otherwise).** Rules cannot iterate an
array, so allocation *element* shape, `allocatedTotal` matching the array sum,
invoice existence/status/client-match, and the per-allocation `> 0` rule are all
unverified. Rules have no list, query, or count, so **over-allocating an invoice
is warned with an explicit acknowledgement, never blocked, and two users can
allocate the same remaining balance concurrently** (Deferred Control 16). Posting
a **future-dated** receipt is blocked in the client only — rules validate the date
*shape* only. And no rule can verify that money was genuinely received
(Deferred Control 17).

**Shared foundation, deliberately mirrored.** `lib/payments.js` holds only the
direction-agnostic primitives (lifecycle, methods, allocation arithmetic,
reconciliation states, remaining balances, generic ageing, shared validators);
`lib/clientReceipts.js` is the AR adapter. Supplier Payments reuse the former
unchanged. **No unused supplier builders or dead abstractions were added ahead of
that branch.**

**Consequences.** The six budget figures, the Forecast tab, and Project Margin
are **unchanged** — cash touches no accrual figure. **AR ageing is corrected** to
age the remaining balance: fully reconciled invoices leave ageing, partially
reconciled ones age only their remainder, over-reconciled ones are excluded into
a signed callout, and the pre-Receipts disclaimer is replaced by the limits that
genuinely remain. An invoice voided *after* a posted allocation is surfaced as an
**exception**, never auto-reversed. Receipts join the currency-lock evidence and
their creation is atomic with the counter and the ratchet. The Commercial tab
gains a third sub-view (Margin · Client Invoices · Receipts) rather than a
fifteenth project tab. **No migration** — additive only.

**Supplier-invoice `paid`/`paidAt`: approved for deprecation, NOT yet changed.**
Payment state will derive from allocations, so activating the reserved `paid`
status would create a second, contradictory source of payment truth. The decision
is to **deprecate in place** — keep the constant and the field, never write them,
never transition into `paid`, and leave `SI_COUNTING_STATUSES` untouched.
**That code and documentation change belongs to the Supplier Payments branch and
has not been made here**; no supplier-invoice file was modified by the Client
Receipts branch. *(It has since been made — see ADR-24, which also corrects the
claim above that "no document can hold that status": supplier-invoice lifecycle
rules remain deferred, so a direct-SDK caller can still forge it.)* The recorded
sequence is now **Client Invoices / Accounts Receivable → Client Receipts
(shipped) → Supplier Payments → Cash Flow**.

## ADR-24: Supplier Payments (payableTotal basis; derived payment state; `paid`/`paidAt` deprecated in place)

Supplier Payments live at
`companies/{id}/projects/{id}/supplierPayments` — project-scoped, `SP-0001`
numbered from a company-wide counter (ADR-5). They record **cash actually paid**
to a supplier or subcontractor and allocate it against **posted** Supplier
Invoices, closing the money-out half of the cash picture. Lifecycle
`draft → posted → void` (void terminal), enforced by Firestore rules. Reads are
restricted to internal financial roles. The shared, direction-agnostic
`lib/payments.js` shipped with Client Receipts (ADR-23) is **reused entirely
unchanged** — the AP adapter is `lib/supplierPayments.js`.

**Project-scoped, not company-scoped.** ADR-23 already decided the split
(`supplierPayments` as a separate sibling collection, never a shared
`cashTransactions` with a direction field, because every rules clause would then
branch on direction). Project scoping additionally preserves the
**one-currency-per-project** guarantee (ADR-21): there is no FX, so a
company-level cash collection could not sum. `projectId` is **deliberately not
stored** on the document — the collection path already carries it, and a
redundant copy would be a second, driftable source of truth. Future company-wide
AP reporting is reachable by collection-group query with its own rule and index.

**Allocations settle `payableTotal`, NEVER `grossTotal`.** `payableTotal =
grossTotal − retentionTotal` and is already net of retention withheld *and of
retention's own GST* (ADR-17). `grossTotal` is the full taxable supply — the face
value of the supplier's tax invoice, not what is owed on it. Allocating against
gross would present **retained money as currently payable** and leave a permanent
phantom balance on every retained invoice that could never be settled. No payment
ever writes, clears, or reduces `retention`, `retentionGst`, or `retentionTotal`;
retention becomes payable through a future Retention Release document, which is
**not modelled**. The UI states this on every retained invoice row and beneath
every allocation table, and the user-facing label is **"Remaining Payable"** —
never "Balance Due", "Amount Owing", "Outstanding Payable", or "Overdue Payable".

**Only `posted` invoices are payable.** `approved` means internally certified;
`posted` is the **financial commit point** (ADR-17). Allowing payment against an
approved-but-unposted invoice would let cash leave before the Actual cost
existed. Draft and cancelled invoices are excluded for the same reason.

**`supplierId` is REQUIRED on a new payment; legacy invoices match by frozen
name.** The asymmetry is deliberate and load-bearing. `supplierPayments` is a new
collection with no history to accommodate, and money paid to nobody is not a
record — so `supplierId`/`supplierName` are **required non-empty and
rules-enforced**, exactly as `clientReceipts.clientId` is (ADR-23). Supplier
**invoices**, by contrast, may legitimately carry `supplierId: null` from before
the Contacts module and are **never backfilled** (ADR-15); those are matched on
the normalised `supplierName` snapshot (trim → lower-case → collapse whitespace,
the same shape `duplicateInvoiceWarnings` already uses) and are **labelled in the
UI** as name-matched. Suppliers are chosen from `PO_SUPPLIER_TYPES` — the same
list the PO picker uses; no parallel supplier-type list was invented. Changing
the supplier on a draft clears its allocations after an explicit confirmation; a
posted payment's supplier is immutable.

**Both invoice references are frozen in each allocation.**
`{ supplierInvoiceId, invoiceNumber, supplierInvoiceNumber, allocatedAmount }` —
the ADR-6 embedded idiom. `invoiceNumber` is Constrapp's `SI-0007`;
`supplierInvoiceNumber` is the supplier's own reference (`INV-4471`), which is
what AP staff actually reconcile against and what a supplier quotes on the phone.
Storing only the former would have forced a document read to render a register
row. A historical invoice with no supplier reference snapshots `''` rather than
an invented one.

**Payment state is DERIVED, and nothing is written onto an invoice.**
`Paid Against Invoice` = Σ allocations across **posted** payments;
`Remaining Payable` = `payableTotal − Paid Against Invoice`, **signed and never
clamped**. The reconciliation state (*unreconciled / partly / fully /
over-reconciled*, compared in whole cents) is a **function of allocations**, never
an authored invoice status. Supplier invoices gain no balance field, no payment
status, and no payment back-reference (ADR-3/ADR-4) — which is exactly why
**voiding a payment restores every balance for free**, at the next render, with
no reversal document, no refund record, and no bank reversal.

**`paid` and `paidAt` are DEPRECATED IN PLACE, not activated.** Activating
`SI_STATUS.PAID` would create a second, contradictory source of payment truth
with no way to reconcile the two and no server-side writer to keep them honest.
So: the constant, its label, and its badge variant are **retained** for legacy
rendering; `SI_TRANSITIONS` gains **no** transition into `paid` and never will;
`paidAt` is still written once as `null` at creation (so new documents keep the
historical shape) and is **never updated**; and `paid` is deliberately **left in
`SI_COUNTING_STATUSES`**. That last point is the subtle one and the reason the
Client Receipts branch's phrasing needed correcting: supplier-invoice lifecycle
rules are still deferred (SECURITY.md Deferred Control 1), so a **direct-SDK
caller can still forge `status: 'paid'`**. If that value were removed from the
counting statuses, such an invoice would silently vanish from Invoiced and
Actual. Counting it is the safe failure mode — the cost stays visible in the
budget figures. It is **not** used for payment reconciliation, which reads only
`posted` invoices. **No migration; no supplier-invoice document is rewritten; no
supplier-invoice rules changed.**

**Unallocated cash is real Cash Out.** A payment may be posted fully, partly, or
entirely unallocated (a supplier advance, a deposit, a payment recorded before
its invoice, an overpayment, or a bank line not yet matched). The whole amount
left the bank, so **Cash Flow consumes the total `amount`, never
`allocatedTotal`** — `cashOutRows()` exposes both, and the split travels
alongside the cash figure rather than instead of it. Unallocated money reduces no
invoice balance, appears nowhere in AP ageing, is reported separately as
*"Unallocated — on account"*, is not styled as an error, and is **never
auto-applied**: an explicit *Allocate oldest first* action produces an editable
proposal and runs only when pressed.

**Dates.** `paymentDate` is a `'YYYY-MM-DD'` string — the app's convention for
every human-entered financial date, and a calendar fact off a bank statement
rather than an instant. Backdating is always allowed; a **future-dated draft may
be saved but not posted**, because posting asserts money has already left the
account. Cash Flow must group by `paymentDate` (`slice(0, 7)`), never by
`createdAt`/`postedAt`, and must never sum across currencies.

**What is rules-enforced.** Tenant isolation; financial-role read/write; create
draft-only with unforgeable lifecycle stamps; `docType: 'payment'`; non-empty
`supplierId`/`supplierName`; currency and date **shape**; `amount > 0`;
`allocations` a list of at most 100; non-negative totals; the **whole-cent scalar
invariant** `allocatedTotal + unallocatedAmount == amount` (via
`math.round(v * 100)` — a representation fix, not a loosened invariant: a
one-cent discrepancy still fails, verified by emulator tests); identity
preservation on every update; exact-key `draft → posted` and
`draft|posted → void`; caller-owned audit stamps equal to `request.time`; a
**non-whitespace** `voidReason`; posted immutability; terminal void; and delete
blocked in every status.

**What remains client-enforced (never claim otherwise).** Rules cannot iterate an
array, so allocation *element* shape, `allocatedTotal` matching the array sum,
the per-allocation `> 0` rule, and the no-duplicate-invoice rule are unverified.
Rules cannot `get()` per element, so invoice existence, `posted` status, project
match, supplier match, and the legacy name match are unverified — and rules
cannot read the invoice at all, so the **`payableTotal` basis and the retention
exclusion are client-side facts**. Rules have no list, query, or count, so
**over-reconciling an invoice is warned with an explicit acknowledgement, never
blocked, and two users can allocate the same remaining payable concurrently**.
Posting a **future-dated** payment is blocked in the client only. Payment-method
enum membership is validated by shape only (the ADR-21 anti-drift precedent). And
no rule can verify that money genuinely left the bank.

**Deliberate rules asymmetry with `supplierInvoices`.** This block enforces
lifecycle and post-commit immutability; the `supplierInvoices` block above it
still enforces neither (Deferred Controls 1–2), and this branch does **not**
harden it. The consequence is real, accepted, and surfaced rather than hidden: a
direct-SDK caller can cancel a posted supplier invoice that a payment has already
settled, which Constrapp reports as an **allocation exception** on both the
Supplier Payments and Supplier Invoices views — the cash stays recorded, the
cancelled invoice stays out of ageing, and nothing is auto-reversed. This mirrors
ADR-22/ADR-23's asymmetry for `clientInvoices`/`clientReceipts` and is the
intended future standard for the older collections.

**Consequences.** The six budget figures, Remaining Committed, the Forecast tab,
and every margin figure are **completely unchanged** — a payment settles an
Actual cost that a posted invoice already recognised; cash out is not cost.
**AP ageing** ages the *remaining payable* of posted invoices: fully reconciled
invoices contribute zero and leave ageing entirely, partially reconciled ones age
only their remainder, over-reconciled ones are excluded into a signed callout,
and retention is excluded throughout. The supplier-invoice register's due-date
column moves from the date-only `isOverdue()` to the payment-aware
`isPastDuePayable()` (`isOverdue` is kept unchanged, with a warning JSDoc, for
backwards compatibility) — mirroring the `isPastDue`/`isPastDueUnreconciled`
split already on the AR side. Payments join the currency-lock evidence, and
creation is atomic with the counter and the ratchet. The Commercial tab gains a
fourth sub-view (Margin · Client Invoices · Client Receipts · Supplier Payments)
rather than a fifteenth project tab, and the existing *Receipts* label is
widened to *Client Receipts* — **label only; the route is unchanged**.
**No migration** — additive only.

**Cash Flow is now unblocked.** Both directions exist: posted Client Receipts
(amount, `receiptDate`, client, currency) and posted Supplier Payments (amount,
`paymentDate`, supplier, currency). `cashOutRows()` is a thin data adapter only —
this branch ships **no** Cash Flow UI, route, aggregation, period, or curve. The
recorded sequence is **Client Invoices / Accounts Receivable → Client Receipts →
Supplier Payments (shipped) → Cash Flow**. *(The Actual Cash Flow foundation has
since shipped — see ADR-25.)*

## ADR-25: Cash Flow (project-level; actual-only foundation; three-branch delivery; zero opening position; gross cash)

Cash Flow is delivered as **three sequential branches** — (1) the **Actual Cash
Flow foundation** *(shipped)*, (2) Forecast Cash Flow, (3) Cash Flow
visualisation — rather than one branch, so the security-relevant part (branch 2
introduces the only new collection and rules block) is reviewed on its own.
This ADR records the decisions the shipped first branch **implements**, and the
approved decisions it deliberately **defers**.

**Implemented (Actual Cash Flow foundation):**

- **Project-level, read-only, derived.** Cash Flow is a fifth sub-view on the
  Commercial tab (`…/commercial/cash-flow`) that **stores nothing and writes
  nothing** — no new collection, no field, no Firestore rules change. Every
  figure is derived at read time (ADR-3/ADR-4) by a pure module
  (`lib/cashFlow.js`) over the two cash-row adapters:
  `lib/clientReceipts.js → cashInRows()` (added by this branch as the exact
  money-in mirror) and `lib/supplierPayments.js → cashOutRows()` (unchanged).
  The existing financial-role rules on `clientReceipts`/`supplierPayments`
  are the entire security boundary.
- **Actual cash derives only from POSTED receipts and payments.** `posted` is
  the single counting status; drafts and voids count nothing, so voiding a
  posted transaction removes it from cash flow at the next render with no
  reversal record.
- **The total transaction `amount` is the cash figure — `allocatedTotal` never
  is.** The whole amount moved through the bank; a fully or partly unallocated
  transaction counts in full (a supplier advance is real cash out, an
  overpayment is real cash in). The allocated/unallocated split travels
  alongside for analysis only.
- **`receiptDate` and `paymentDate` are the cash dates.** Grouping is
  `date.slice(0, 7)` into `'YYYY-MM'` keys — no Date construction, no
  timezone; `createdAt`/`postedAt` are entry/commit facts and are never
  consulted. Monthly rows are **dense** (gap months render as zero rows) and
  month labels come from a fixed lookup, not a locale.
- **Unallocated transactions remain actual cash, reported and never netted.**
  *Unallocated Cash In/Out — on account* reuse the existing
  `receiptSummary()`/`paymentSummary()` derivations; auto-netting unallocated
  cash out of any figure would be the same accounting-policy decision ADR-23
  refused to make when it declined auto-allocation.
- **Zero opening position; cumulative movement is NOT a bank balance.** The
  cumulative column starts at 0 and is the project's net recorded cash
  movement. Constrapp models no bank account, opening balance, financing, or
  GST/BAS remittance, and the page says so permanently. No `openingBalance`,
  `bankBalance`, `financingBalance`, or `projectAccountBalance` field exists.
- **Gross cash is separated from ex-GST accrual context.** Cash figures are
  gross (inc. GST). The *Commercial context* panel (Current Contract Sum,
  Forecast Revenue, Forecast Final Cost, Forecast Gross Profit, Forecast
  Margin % — via the same shared `lib/margin.js` composition, never
  re-derived) is labelled **accrual, ex-GST**, kept visually separate, and is
  never added to, netted with, or plotted against a cash figure. With no
  baseline, revenue-side context shows "—", never zero.
- **No source-document mutation.** The view never writes to receipts,
  payments, invoices, POs, claims, variations, forecast lines, budget lines,
  or the commercial baseline. The six budget figures, Forecast Final Cost,
  and every margin figure are unchanged by this module.
- **Unit testing for arithmetic-heavy pure financial logic.** A second,
  separate Vitest suite (`npm run test:unit`, `frontend/vitest.config.js`,
  `tests/unit/` only — the emulator rules suite is untouched) covers the
  month-key, grouping, status, unallocated, cumulative, and cent-rounding
  behaviour. `lib/` unit coverage was the recorded "natural next target" in
  TESTING.md; the most arithmetic-dense pure module is where it starts.

**Why:** cash truth must not wait for forecast timing — the actual half is
derivable today from records that already exist, while a truthful forecast
needs a new authored data model (a substantial, security-reviewed change of its
own). Shipping actuals first also keeps the honest default visible: a page
that reports only what happened cannot overstate what will.

**Implemented by the Forecast branch (3c-ii), amending this ADR:**

- **Three layers, one boundary rule.** Layer 2 times **open invoice balances by
  due month** (issued client invoices at gross; posted supplier invoices at
  `payableTotal`, net of retention); layer 3 times **authored `cashFlowLines`**.
  **Months before the current month are ACTUAL ONLY** — no forecast amount ever
  lands in a past month, which makes actual-versus-forecast provably
  non-double-counting without matching any actual to any forecast.
- **`cashFlowLines`** at `companies/{id}/projects/{id}/cashFlowLines/{lineId}`:
  random ids, **no counter** (a planning input is never quoted by a supplier or
  client, so ADR-5's rationale does not apply), `active → active` / `active →
  void` (terminal) **rules-enforced**, delete blocked, **no posted status and no
  approval** — a forecast line has no financial commit point.
- **Two amounts, two bases.** `amount` is expected **gross** cash (the only cash
  figure; always `> 0`, with `direction` carrying the sign) and
  `sourceAmountExGst` is the **ex-GST source value** it represents —
  completeness coverage only, never a cash column. The two bases are never added
  together, and the untimed panel keeps gross cash, ex-GST source value, and
  informational exposure in three separate columns.
- **Invoice source types are EXCLUDED.** `client_invoice` and
  `supplier_invoice` are deliberately not offered: those balances are already
  timed automatically, so a manual line would double-count them. **Invoice
  retiming** — which would make them safe, because layer 2 provably never times
  a past-due balance — is reserved for its own branch, since it needs per-invoice
  coverage tracking, a past-due picker, and its own over-coverage arithmetic.
  The accepted cost is that past-due balances stay untimed, which *understates*
  future Cash In and therefore *overstates* funding need — the conservative
  direction, and visible because it suppresses the peak-funding headline.
- **`sourceId` is not stored.** Every coverage key is a `costCodeId` (cost side)
  or nothing (revenue sits above the spine, ADR-20/ADR-22), so a polymorphic
  source id would be null on every document Branch 2 can create. Adding it when
  invoice retiming lands is purely additive — no dead field ahead of its branch
  (the ADR-23 precedent).
- **⚠️ CORRECTED COST MODEL.** Approved-claim cost awaiting a supplier invoice
  sits **inside** Remaining Committed: an approved claim consumes PO commitment,
  and `maturedCommittedByCostCode` subtracts only **posted invoicing**.
  Therefore `D_cost = Remaining Committed + Uncommitted CTC` (≡ Cost to
  Complete, the figure the Forecast tab already publishes — no new arithmetic),
  and `uninvoiced_claim` coverage counts against the **same cost-code committed
  balance** as `remaining_committed`. It is surfaced only as a labelled
  breakdown *within* Remaining Committed, **never as an additive second
  denominator or an extra untimed total**. This corrects the broad assessment,
  which would have double-counted it.
- **Completeness is null, never a false 0% or 100%,** whenever the basis is
  unavailable (no baseline, over-invoiced contract, no remaining cost, or a
  failed source read) — the `marginPercent` guard applied to coverage.
- **Peak funding** takes the **earliest** month on a tie and its **headline is
  suppressed** while significant amounts remain untimed or a basis is
  unavailable, showing only a labelled lower bound: untimed cost makes the
  trough shallower than reality, so an unqualified figure would *understate* the
  funding need. **Retention withheld and unallocated cash warn but never
  suppress** — retention release is unmodellable, so suppressing on it would
  disable peak funding permanently on any project that withholds retention, and
  unallocated cash is already correctly counted in actuals. Both exclusions are
  stated beside the figure, and the remedy for each is an explicit manual line.
- **No past-month timing; stale lines are surfaced, never moved.** Creating or
  retiming a line into a past month is **client-blocked** (rules validate the
  `'YYYY-MM'` shape but have no calendar — recorded as Deferred Control 19). A
  line becomes stale naturally as the calendar advances, stops counting
  everywhere, and is retimed forward or voided with a reason. Nothing is
  silently deleted, replaced, or auto-matched to an actual.
- **Over-coverage is warned with an acknowledgement, never blocked** — rules
  cannot sum sibling lines (the Deferred Control 14/16/18 posture).
- **Subscription-error hardening.** Six hooks (`useBudgetLines`,
  `usePurchaseOrders`, `useProgressClaims`, `useSupplierInvoices`,
  `useVariations`, `useForecastLines`) gained **additive** error flags, because
  a silent degrade to `[]` would have rendered Forecast Cash Out as `$0` and
  cost coverage as 100% — a confidently wrong forecast in the dangerous
  direction. A failed read is now reported as **unavailable, never zero**.
- **`direction` and `basis` are enum-checked in rules** — a deliberate exception
  to ADR-21's anti-enum precedent, justified because they are two-value and
  one-value closed sets that decide which cash column an amount lands in and
  whether it is a cash figure at all. `sourceType` stays shape-only: that list
  will grow.

**Still approved but NOT implemented (branch 3c-iii and beyond):** charts and
date-range filtering; **invoice retiming** (the reserved
`client_invoice`/`supplier_invoice` source types); scenarios; an authored
opening balance; financing; retention-release modelling; GST/BAS forecasting;
period locking and immutable forecast snapshots; bank and accounting
integrations; exports.

**Consequences:** the recorded sequence is **Actual Cash Flow foundation
(shipped) → Forecast Cash Flow (shipped) → Cash Flow visualisation**. Forecast Cash In/
Out, expected collections and payments, manual monthly timing, untimed AR/AP,
projected closing position, peak funding, retention-release cash, GST/BAS cash,
opening-balance input, scenarios, company-wide cash flow, bank feeds/
reconciliation, financing, exports, PDF, and email are all absent by design in
this foundation — the page's Limitations card states the material ones. No
migration — a project with no posted cash shows an empty state.

## ADR-26: Cash Flow visualisation (consumes derived rows; two panels, never a dual axis; no peak marker when suppressed)

**Status:** Accepted — shipped with the Cash Flow visualisation branch (3c-iii),
the third and final Cash Flow branch on top of ADR-25.

**Context.** Cash Flow already derived everything a chart needs: dense monthly
rows carrying actual, forecast, total, net and cumulative figures, plus peak
funding and its suppression state. The risk in adding a visualisation was never
drawing the picture — it was that a chart quietly becomes a **second
calculation engine**, re-deriving totals or a cumulative curve that then
disagrees with the table beside it.

### Decision 1 — the chart consumes derived rows and re-derives nothing

`CashFlowChart` receives `combinedRows`, `nowMonth`, `pf`, `suppression` and
`forecastUnavailable` from `ProjectCashFlow.jsx` and treats every one as
authoritative. It does not regroup, re-sort, re-round, re-sum, or recompute a
cumulative position, peak-funding trough, invoice balance or completeness
figure. **`lib/cashFlow.js` remains the only Cash Flow engine.**

The chart does need a few genuine *display* decisions — negating Cash Out so it
plots below the baseline, turning unavailable figures into `null`, locating the
actual/forecast boundary, deciding whether a peak marker is permitted, and
composing the textual summary. Those live in a separate pure module,
**`lib/cashFlowChart.js`, which contains zero financial arithmetic**.

Splitting it out is not decoration. The unit suite runs in plain Node
(`environment: 'node'`, no jsdom), so logic inside the `.jsx` would be
**untestable**; in a `.js` module it is covered by the existing runner with no
config change, no jsdom and no testing-library. The module boundary is what
makes the honesty rules below *provable* rather than merely intended — and it
is why component tests were judged unnecessary rather than merely skipped.

The chart also **never calls `currentMonthKey()`**. It keys off the `isPast`
flag `lib/cashFlow.js` already stamped from the page's single `nowMonth`, so
the app keeps exactly one timezone-sensitive clock (ADR-25).

### Decision 2 — two panels sharing one X domain, never a dual axis

Monthly flow and cumulative position differ in magnitude — the cumulative curve
compounds while monthly bars do not. Plotting both against two Y scales in one
frame would let a reader infer crossings and relationships that are pure
artefacts of independent scaling. **Rejected.**

Instead: **Panel A** (diverging stacked bars, Cash In above zero and Cash Out
below) and **Panel B** (the cumulative line from a zero opening position) are
separate panels sharing one chronological X domain, identical margins and a
fixed Y-axis width so their plot areas stay in register. Both live in one
horizontal scroll container and scroll together, with each month given a fixed
slot so a multi-year project scrolls rather than compressing into unreadable
bars.

Cash Out is negated **for plotting only**. It is an amount of money, never
presented to the reader as negative — the tooltip shows it positive. Zero is
guarded explicitly against IEEE-754 `-0`.

**Hue encodes direction; texture encodes state.** Cash In is `brand-accent`,
Cash Out is `brand-purple`, actual is solid and forecast is a 45° hatch — so
actual-vs-forecast survives greyscale, print and forced-colors, and never
depends on colour alone. `brand-red` and `brand-amber` were deliberately **not**
used for direction: they are reserved status colours (negative figures and
warnings respectively), and painting every cash-out bar red would both alarm on
healthy projects and collide with the genuine negative-position signal.

### Decision 3 — no peak-funding marker when the figure is suppressed

ADR-25 suppresses the headline peak-funding figure whenever significant amounts
remain untimed, because untimed cost makes the trough shallower than reality and
an unqualified number would **understate** the funding need — the dangerous
direction.

A charted point inherits none of that hedging: **a mark on a chart reads as a
confirmed figure regardless of the caption beside it.** So the marker is plotted
only when the figure is fully authoritative. When peak funding is suppressed,
when the position never goes negative, or when a forecast source failed, the
chart plots **no marker at all**.

Plotting the computed value as a labelled "lower bound" marker was considered
and **rejected**: it would strip the qualification while doubling the
prominence. The qualified lower bound already appears, properly hedged, in the
peak-funding card above the chart.

The same asymmetry governs unavailability generally, mirroring
`CombinedMonthlyTable` exactly: a past month's forecast and any figure a failed
source made unavailable become **`null`, never `0`**. This is not cosmetic —
Recharts *skips* a null and *draws* a zero, so the distinction is the entire
honesty contract. The cumulative line uses `connectNulls={false}` so an
unavailable stretch **breaks the line** rather than bridging it with an invented
trajectory, and the forecast region shading is not drawn at all when a forecast
source failed, since that shading would itself assert that forecast data loaded.

**Consequences.** The chart adds no formula, collection, document, write, route,
hook, dependency or rules change; Recharts was already a dependency and already
in use. Colours are existing tokens referenced as `var(--color-brand-*)` — **no
token value was changed and no hex hard-coded**, deliberately not repeating the
`Dashboard.jsx` styling debt recorded in DESIGN_SYSTEM.md. SVG pattern ids are
namespaced with React `useId()` rather than global constants, introducing no
effects and no state. The monthly table remains the exact numeric record and the
accessible equivalent, so the chart is never the only path to the data, and it
is not rendered at all when there is no cash-flow data — the page's existing
empty state stands rather than being covered by an empty chart frame. **Date
filtering, chart export, chart-based editing and drag-to-retime are out of scope
and remain unbuilt.**

## ADR-27: `users/{uid}` is client-read-only (membership provisioned out of band)

**Context.** The membership document carried the only rule that granted a client
write access to its own authorisation data:

```
match /users/{uid} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```

`write` expands to `create` + `update` + `delete`, and the rule constrained no
field. Every other block in `firestore.rules` authorises by `get()`-ing this
document and reading `companyId` (the multi-tenancy anchor) and `role` (every
write gate), so one direct SDK call allowed **self-promotion** to
`company_admin` — granting every financial write and every financial-role read —
and **tenant escape** by rewriting `companyId` to another company. It also
allowed a bare Auth account to **mint its own membership** with any company and
role, **self-deletion** (orphaning the user against every rule), and the
pre-seeding of **arbitrary privilege-bearing fields**. This capped every other
control in the system: no role restriction is stronger than the ability to
assign yourself a role.

**Decision.** `users/{uid}` becomes **client-read-only**. A user may read their
own profile; `create`, `update` and `delete` are all blocked outright.
Provisioning stays **out of band** — Firebase console or admin tooling using
admin credentials, which bypass rules entirely.

**Why no harmless-field allow-list.** A `hasOnly(['name', 'avatarInitials'])`
update grant was considered and rejected. Repository evidence is unambiguous:
the only `users/` reference in `frontend/src` is the **read** in
`hooks/useProfile.jsx`; there is no profile route, no profile form, no
`updateProfile` call, and the Create Account and Forgot Password screens are
static stubs. An allow-list would authorise a caller that does not exist and
require a test asserting a capability with no user. `hasOnly` is the right tool
where a genuine editable surface exists — which is exactly why it guards the
company document's four currency fields, written by a real `saveCompanyCurrency`
caller. Blocking writes outright is also **structurally** complete: an
allow-list must be maintained as fields are added and fails open when someone
forgets, whereas `if false` cannot drift.

**Why `create` is blocked too.** Nothing in the client creates a profile, so
blocking create removes no behaviour. Permitting it would make a Firebase Auth
account alone sufficient to choose one's own company and role — the Firestore
document would be self-service rather than a second gate.

**Why the read scope was not widened.** The app never reads another user's
profile: `ProjectForecast.jsx` and `ProjectCommercial.jsx` deliberately render
the literal string `'Another user'` for any uid that is not the caller. Own-
document-only read is the real contract, not an accident.

**Consequences.**

- **Zero application-code change.** No file under `frontend/src` was touched;
  the diff is one rules block, one new test suite, and documentation. Lint
  stayed at its accepted 17 errors / 0 warnings and the unit suite at 173.
- **The other ~40 `get(/…/users/$(request.auth.uid))` lookups are unaffected.**
  Rules-internal `get()`/`exists()` **bypass** Security Rules and are not
  subject to the `users/{uid}` match block. Three non-regression tests prove
  this rather than assuming it.
- **`users/{uid}` gains its first rules suite** — 26 tests, previously the only
  collection in the file with none, despite being the most security-critical.
- **Signup, invitations, and user administration now require a trusted
  backend.** Membership must be issued via the Admin SDK, never from the
  browser. This is the intended outcome, not a regression — see SECURITY.md →
  Trusted-Backend Activation Requirement 3 and ADR-14.
- **Admin management of other users was deliberately not introduced.**
  `company_admin` has no special power over this collection; a rules test
  asserts it.
- **This prevents future tampering; it does not revert past tampering.** Any
  `role`/`companyId` already stored remains authoritative and must be reviewed
  directly in the Firebase console before the rules are published.
- **Deferred Control 17 is not solved.** A user *provisioned into* a financial
  role can still fabricate cash records by direct SDK call. What changed is that
  a user can no longer **grant themselves** that role, so the blast radius is
  now bounded by who is provisioned.

## ADR-32: BOQ & Tender Foundation — Part 2: Tender (packages · manual bids · read-time comparison · award as a decision record; no stored totals)

> **Numbering note.** ADR-28–31 and **ADR-32 Part 1 (BOQ)** are authored on
> feature branches not yet merged (Documents & Drawings, Project Timeline,
> Retention, Credit Notes, BOQ). The gaps here are intentional — numbering is
> allocated across branches and reconciles mechanically when they merge. This
> Part 2 is deliberately independent of Part 1: Tender V1 must work from
> current main, **without** BOQ.

**Context.** The connected lifecycle (Drawing → … → Estimate → **Tender →
Award** → Approved Budget → Commitment → …) had a hole between Estimate and
Commitment: no record of what scope was put to market, who priced it, what
they priced, or why the winner won. The award decision — the most consequential
commercial decision on a cost code — lived in email. BOQ is implemented on an
unmerged branch, so Tender V1 had to be designed against main, where `boqItems`
do not exist.

**Decision.** Two new project-scoped collections and one counter:

- **`tenderPackages`** (`TP-0001` from `counters/tenderPackages`) — a named
  scope of **≥1 selected cost codes + free-text scope**, lifecycle
  `draft → issued → awarded`, with `draft|issued → cancelled`. Issuing
  **freezes** name/description/scope/costCodes; while issued, only
  `closingDate` and `notes` stay editable (a deliberate `hasOnly` carve-out —
  extending an informational closing date must not force cancel-and-recreate).
  Awarded and cancelled are **terminal**: no un-award/rescind flow in V1.
- **`tenderBids`** — manual transcriptions of received bids, priced **per cost
  code** within the package scope (ex-GST, **no GST fields** — tax is a
  commitment-time concern), from **supplier/subcontractor contacts** with a
  frozen `bidderName` snapshot. Two states, `received → void` — **no draft**:
  a bid is a transcription of an external document, not an authored document
  with a commit point (the cashFlowLines two-state precedent). Random ids, no
  number, no counter. Project-level with a `tenderPackageId` reference (the
  progressClaims→PO idiom), never a subcollection — one subscription serves
  the register while rules still verify containment by `get()`.

**The header-vs-lines decision (load-bearing): NO STORED TOTALS.** Bids store
no `bidTotal`; packages store no `awardTotal`. Firestore rules cannot iterate
or sum an array, so any stored header total would be an unverifiable second
copy of the lines — the exact integrity defect previously identified in the
Credit Notes design. Instead every figure passes through one **read-time
validity gate** (`lib/tenders.js → assessBid`): a bid is valid only when every
line has a real object shape, a non-empty in-scope `costCodeId`, string
snapshot/description, and a finite numeric `amount ≥ 0` (zero is a legitimate
price) — **and the resulting total is itself finite**, because finite lines can
still sum beyond representable range and a non-finite total would otherwise
pass as valid while rendering as "—". One malformed line invalidates the
**whole bid** — total `null`, never a partial sum, never $0, never clamped —
excluding it from the lowest-bid ranking, the budget comparison, the
per-cost-code matrix, and the Awarded Bid Value while it stays visible and
flagged. A direct-SDK caller can store malformed embedded lines **and can
award such a bid** (rules verify the bid's identity and status but cannot read
its lines, so the app's refusal to award it is UX only); the gate makes the
resulting record **fail safely instead of being trusted** — the award value
reads *unavailable*, and since an award writes no PO and no financial value,
nothing downstream moves (Deferred Control 26).

**Tender Comparison — read-time, and never "Bid Levelling".** Derived rows per
package: derived total ex-GST, **Variance to Budget = Approved Budget − Bid**
(positive = under budget — the app-wide sign convention), variance to lowest,
whole-cent lowest ties, exclusions/notes, awarded flag, plus a per-cost-code
matrix. When the package's cost codes have **no** budget lines the comparison
reports *no budget* — it never compares against zero. Nothing is stored
(ADR-3); void and invalid bids are excluded from every calculation.

**Award is a commercial decision record ONLY.** `issued → awarded` stores
`awardedBidId`, a rules-matched `awardedBidderName` snapshot, `awardNotes`, and
stamps — nothing else. It creates **no Purchase Order** and writes **no
budget, commitment, actual, invoiced, forecast, margin, or cash-flow figure**.
Rules `get()` the bid and enforce: exists in this project, belongs to this
package, is `received`, name snapshot matches — and the branch's
`resource.data.status == 'issued'` requirement makes a **second award
impossible** (Firestore serialises writes per document). Ending the package's
issued state is also what **freezes every bid** (all bid writes require the
parent to be `issued`), which is why the displayed **Awarded Bid Value** can be
derived from the frozen bid's lines with no stored copy. **No inferred
"awarded but not committed" arithmetic exists**: V1 has no Award → PO linkage,
and netting awards against POs by cost code is wrong whenever packages share
cost codes or POs span packages — the value is labelled a tender decision
value only. "Raise PO from Award" is a separate future feature.

**Closing date is INFORMATIONAL ONLY.** No trusted backend or server clock
exists, so nothing blocks a late bid — in the app or by direct SDK — and the
UI says so wherever the date appears. Rules validate shape only.

**Privacy & roles.** Both collections are readable and writable by
`company_admin` / `project_manager` / `qs` only — a bid **is competitor
pricing**, so `subcontractor`/`client` read nothing, and `super_admin` has no
special power (rules-tested). **QS may award** (product decision). Bidder
contacts are rules-verified at create — existence, supplier/subcontractor
type, and name snapshot via one `get()` — deliberately exceeding the
supplierPayments precedent because a fabricated bidder in a competitive record
is worth the extra read.

**Currency.** Packages carry no amounts and no `currency` field and never lock
the project currency; a **bid** is monetary evidence (including void — a
retained audit record), so `createTenderBid` stages the ratchet in the same
transaction (ADR-21) and `monetaryLockReasons` gains `tenderBids`. Award adds
no lock logic: it stores no amount, and an awarded package already has a bid.

**Independence & future BOQ integration.** V1 uses no Firebase Storage, no
Cloud Functions, no new dependencies, no migration, and nothing from any
unmerged branch. When BOQ merges, the intended extension is an **optional
frozen scope schedule at issue** (`scopeSchedule` snapshotted from BOQ items)
as a separate follow-up feature with its own design and security review —
additive, absent-field-tolerant, and never required for a cost-code/free-text
package. Tender records must remain valid without it.

**Alternatives rejected.** Storing `bidTotal`/`awardTotal` (unverifiable —
the Credit Notes lesson); bids as a package subcollection (collection-group
rules weaken tenant scoping; the claims idiom already fits); a bid draft state
(a transcription has no commit point); lump-sum-only bids (breaks the
cost-code spine) and BOQ-item bids (no BOQ on main); deterministic
bidder-keyed bid ids for uniqueness (blocks legitimate re-bids after void);
automatic PO creation on award (award is a decision, commitment is a separate
deliberate act); an inferred awarded-vs-committed exposure (wrong under
shared cost codes); enforcing closure of tenders at the closing date (no
trusted clock — pretending would overclaim).

**Consequences.** The tender trail (scope → bidders → prices → decision) is
durable, auditable, and financially inert; comparison honesty degrades safely
under malformed data; and the award's derived value is exactly as trustworthy
as the rules-frozen bid behind it. The costs are accepted and documented:
per-line integrity, containment, bidder uniqueness, and closing behaviour are
client-side only (Deferred Control 26), and a mistaken award has no in-app
remedy in V1 (rescission is future work with its own audit design).
