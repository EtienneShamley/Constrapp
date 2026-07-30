# Financial Workflows

How Budget Lines, Purchase Orders, and Progress Claims behave and how the six
budget figures are computed. Schema detail: [DATA_MODEL.md](DATA_MODEL.md).
Decision rationale: [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md).

All amounts are AUD. Budget figures, PO line totals, retention, and claim line
amounts are **ex-GST**. Every money figure passes through `roundMoney()`
(round-half-up to cents) so totals reconcile against accounting exports later.

## The Core Invariant

**Purchase Orders and Progress Claims never write financial values onto Budget
Lines.** Committed, Claimed, and Actual are recomputed in the browser on every
render from the live PO and claim documents. There are no stored rollups to
drift out of sync, and no client is trusted to maintain them. (Budget line
documents do carry vestigial `committed: 0` / `actual: 0` fields written once at
creation — the UI ignores them.)

## Budget Lines

- A budget line allocates `budgeted` dollars of a project's budget to one
  company cost code, with optional notes.
- Create-only today (no edit/delete UI; deletes blocked by rules).
- The Budget tab shows per-line and project-total **Budgeted, Committed,
  Claimed, Actual, Invoiced, Remaining**, plus a usage bar
  (Actual ÷ Budgeted, red at ≥100%).
- A PO can commit against a cost code with no budget line; the Budget tab
  surfaces this as an amber "Committed via PO — no budget line" warning row.

## Purchase Order Lifecycle

Statuses: `draft` → (`pending_approval`) → `sent` → `closed`, with `cancelled`
reachable from draft/pending_approval/sent. Forward-only — no status ever moves
backwards, and `closed`/`cancelled` are terminal. `pending_approval` is
**reserved** (defined in code, no UI path yet).

- **Draft** — fully editable (supplier, lines, notes). Not committed.
- **Sent** — lines and amounts freeze permanently. The PO now counts toward
  Committed and becomes claimable. `sentAt` stamped.
- **Closed** — work complete; still counts toward Committed; takes no further
  claims. `closedAt` stamped.
- **Cancelled** — audit record retained (never deleted); **drops out of
  Committed entirely**. `cancelledAt` stamped.

Numbering: `PO-0001` from the company-wide `counters/purchaseOrders` document,
incremented in the same transaction as the PO write.

### Committed-cost calculation

```
Committed(costCode) = Σ lineTotal of every line with that costCodeId
                      across POs in status ∈ { sent, closed }
```

## Progress Claim Lifecycle

Statuses: `draft` → `submitted` → (`under_review`) → `approved` → (`invoiced`),
with `rejected` reachable from draft (withdrawal), submitted, and under_review.
Forward-only; `rejected` and `invoiced` are terminal. `under_review` and
`invoiced` are **reserved** (no UI path yet — invoiced awaits the invoices
module).

- Claims can only be raised against **sent** POs (closed POs are complete;
  draft/cancelled POs are not commitments).
- **One open claim per PO**: a PO with a claim in draft/submitted/under_review
  cannot take another claim until that claim is approved or rejected.
- **Draft** — editable (amounts, retention, period, notes).
- **Submitted** — claimed amounts freeze; awaits assessment. `submittedAt` stamped.
- **Approved** — carries per-line certified amounts; `approvedAt`/`approvedBy`
  stamped; approved amounts frozen forever.
- **Rejected** — terminal audit record; contributes nothing to any budget figure.

Numbering: `PC-0001` from `counters/progressClaims`, same transactional pattern.

## Cumulative Claiming

Suppliers claim **cumulatively**: for each PO line the creator enters
*claimed to date*, not an increment.

- Each claim line starts pre-filled at `previouslyApproved` = the sum of
  `approvedThisPeriod` across earlier **approved/invoiced** claims on the same
  PO line (keyed by `poLineIndex`, which is stable because PO lines freeze).
- `claimedThisPeriod = claimedToDate − previouslyApproved`.
- Claimed-to-date **cannot be reduced below** previously approved (negative
  `claimedThisPeriod` blocks creation — "Below approved").
- Claiming **above the PO line value is allowed but warned** (amber ⚠) — real
  claims sometimes exceed the PO pending a variation.
- A claim must have at least one line with `claimedThisPeriod > 0`.

## Assessment & Partial Approval

Assessing a submitted claim certifies a per-line `approvedThisPeriod`, pre-filled
with the claimed amounts and editable downward — **partial approval** is normal
(certify less than claimed, with optional `assessmentNotes` explaining why).

**Approval validation bounds** (enforced in `validateApprovedAmounts`, both in
the modal UI and again inside the approve transition, so programmatic calls
can't bypass them):

- Every claim line must have a certified amount (array length must match).
- Each amount must be a finite number, ≥ 0, and ≤ that line's `claimedThisPeriod`.

Approval writes the certified line amounts plus `approvedSubtotal/Gst/Total`;
rejection stamps `rejectedAt` (with optional assessment notes) and frees the PO
for a corrected claim.

## Retention & GST

- **Retention** is entered per claim as an ex-GST amount, clamped to the claim
  subtotal.
- **GST (10%) applies to the net payable**, not the gross claim:

```
subtotal  = Σ line amounts (claimedThisPeriod or approvedThisPeriod, ex-GST)
retention = min(retention input, subtotal)
net       = subtotal − retention
gst       = net × 0.10
total     = net + gst          ← "Total payable" (inc. GST)
```

- PO totals are simpler: `gst = subtotal × 0.10`, `total = subtotal + gst`.
- Retention release is not yet modelled (future work alongside invoices).

## Supplier Invoice Lifecycle

Supplier invoices are **accounts payable** — the cost-side bills the company
receives. (The word *invoices* is reserved for future client/AR invoicing.)
Numbering: `SI-0001` from `counters/supplierInvoices`, same transactional pattern
as POs/claims.

Two sources:

- **`direct_po`** — entered directly against one **sent** or **closed** PO, with
  no progress claim. Lines seed from the PO lines; the user enters the invoiced
  amount per line (zero on unused lines). Multiple direct invoices may be entered
  against the same PO over time. Retention is normally 0.
- **`progress_claim`** — created from one **approved** progress claim. Lines seed
  from the claim's certified `approvedThisPeriod` amounts, which are **fixed**
  (invoice exactly the approved claim — no more, no less; partial invoicing of a
  claim is deferred). PO and claim references and the claim's retention are
  copied. One approved claim may have only **one non-cancelled** supplier invoice.

Statuses: `draft` → `approved` → `posted`, with `cancelled` reachable from
`draft`/`approved`. Forward-only. `received`, `under_review`, `disputed`, and
`paid` are **reserved** (defined, no UI transition yet — `paid` arrives with the
Payments module).

- **Draft** — fully editable.
- **Approved** — internally certified; locked except for valid lifecycle actions.
  `approvedAt`/`approvedBy` stamped.
- **Posted** — the **financial commit point**: the invoice now counts toward
  Invoiced and Actual and matures Committed. Immutable. `postedAt`/`postedBy`
  stamped. **Posted invoices cannot be cancelled or unposted** — corrections are
  future Credit Notes.
- **Cancelled** — audit record retained (never deleted); contributes nothing.
  `cancelledAt` stamped.

**Counting statuses** (contribute to budget figures): `posted` and `paid`. `paid`
is reserved but already included in the domain calculations for forward
compatibility with the Payments module.

### Line amounts, GST & retention

All canonical line `amount`s are **ex-GST**. Each line carries a `taxCode`
(`gst` 10% · `gst_free` · `input_taxed`) and a computed `gstAmount`, so one
invoice can mix tax treatments. GST-inclusive entry may be a UI mode, but storage
stays ex-GST + per-line `gstAmount`.

Gross figures describe the **full taxable supply**; payable figures are what is
**due this invoice** after retention. They are stored separately and
unambiguously:

```
subtotal       = Σ line amount            (gross certified, ex-GST)
gstTotal       = Σ line gstAmount         (GST on the gross lines)
grossTotal     = subtotal + gstTotal      (full tax-invoice value, inc. GST)

retention      = retained ex-GST (clamped to subtotal)
retentionGst   = retention × 10%          (0 when retention is 0)
retentionTotal = retention + retentionGst

net            = subtotal − retention
payableGst     = gstTotal − retentionGst
payableTotal   = grossTotal − retentionTotal   ← net payable (NOT the full value)
```

**Retention carries its own GST** so that a claim-sourced invoice reconciles
exactly to the approved Progress Claim (whose GST is charged on the *net*,
post-retention amount — see "Retention & GST" above). Because Progress Claims use
flat 10% GST, `retentionGst = retention × 10%`, which makes
`payableGst = approvedGst` and `payableTotal = approvedTotal`. **Direct-PO
invoices** use retention 0, so `retentionGst`/`retentionTotal` are 0 and
`payableGst = gstTotal`, `payableTotal = grossTotal`.

- Worked example (claim path): subtotal 1,000, retention 100 → gstTotal 100,
  grossTotal 1,100, retentionGst 10, retentionTotal 110, net 900, payableGst 90,
  **payableTotal 990** (= the claim's approvedTotal).
- Worked example (direct path): subtotal 1,000, retention 0 → gstTotal 100,
  **grossTotal = payableTotal 1,100**.
- Contact `gstStatus` is **advisory only** (may warn; never auto-selects a tax
  code; never blocks). Retention **release** is not yet modelled (future work
  alongside Payments/Retentions).

### Claim reconciliation guard

Creating a `progress_claim` invoice is **blocked** unless its `payableGst` equals
the approved claim's `approvedGst` **and** its `payableTotal` equals the claim's
`approvedTotal` (`claimReconciliationError`, enforced in the create modal and
again in the hook). This guarantees a claim-sourced invoice never drifts from the
certified amount it bills.

### Over-invoicing & duplicates

- Invoicing beyond a PO line (or PO total) is **warned (amber ⚠) but never
  blocked** — variations and price changes are real. It simply drives that line's
  open commitment to zero.
- Duplicate detection is **warning-only and client-side**: it flags a matching
  normalised `supplierInvoiceNumber` for the same supplier (`supplierId` when
  present, else the `supplierName` snapshot for pre-Contacts POs). Never blocks;
  server-enforced uniqueness is deferred.

### No Budget Line writes

Like POs and claims, supplier invoices **never write onto Budget Line
documents**. Invoiced, and the invoice contributions to Committed and Actual, are
all derived at read time from invoice documents.

## The Six Budget Figures — Exact Definitions

All derived figures group PO/claim **line items by `costCodeId`** and are ex-GST.

| Figure | Definition | Source |
|---|---|---|
| **Budgeted** | Σ `budgeted` across the project's budget lines | Stored on budget lines |
| **Committed** | Remaining **open** commitment: per PO line (POs in `sent`/`closed`), `lineTotal − posted/paid invoiced-to-date against that line`, floored at 0, grouped by cost code | Derived from POs + invoices |
| **Claimed** | Σ `claimedThisPeriod` of claim lines, claims in `submitted`/`under_review` — uncertified exposure only | Derived from claims |
| **Actual** | Σ `approvedThisPeriod` of claim lines (claims in `approved`/`invoiced`) **not superseded by a posted/paid invoice** + Σ ex-GST line `amount` of posted/paid supplier invoices | Derived from claims + invoices |
| **Invoiced** | Σ ex-GST line `amount` of supplier invoices in `posted`/`paid`, grouped by cost code | Derived from invoices |
| **Remaining** | `Budgeted − Actual` (per line and in total) | Computed |

**The six canonical figures are unchanged by Variations.** The Budget page adds
two **separate, clearly-labelled** read-time figures sourced from approved supplier
variations (`lib/variations.js`), and **does not** alter the Committed formula:

| Figure | Definition | Source |
|---|---|---|
| **Approved Supplier Variations** | Σ approved supplier-variation line `approvedAmount` by cost code (signed; not clamped) | Derived from variations |
| **Commitment Exposure** | `Committed + Approved Supplier Variations` (ex-GST) — **not** "Adjusted Committed" | Computed |

Commitment Exposure is explicitly **separate** from Committed: approved variation
amounts **do not yet mature** against progress claims or supplier invoices. UI
helper text states this.

### Committed now means *remaining open commitment*

Before invoices, Committed was the full value of every sent/closed PO. **Now that
supplier invoices exist, Committed matures to the remaining open commitment** —
each PO line's value less what has been invoiced (posted/paid) against it, floored
at zero. As invoices post, value moves out of Committed and into Invoiced/Actual,
so the figures are **complementary rather than overlapping**: Committed answers
"what have we ordered but not yet been billed for?", Actual answers "what has this
project actually cost?" Over-invoicing a line simply drives its open commitment to
zero (never negative).

### Actual: claims are replaced by their invoice, never double-counted

An approved progress claim contributes to Actual **until a supplier invoice
sourced from it is posted**. At that point the claim is excluded from the
claim-side Actual (a **read-time** exclusion keyed on the invoice's
`progressClaimId` — the claim document is *never* mutated or stamped) and the
posted invoice contributes instead. A **direct** supplier invoice (no claim) adds
to Actual on its own — so material/direct costs that never had a progress claim
now reach Actual, which the claims-only model could not do. The net effect: each
cost is counted exactly once.

## Planned Commercial Lifecycle (not yet implemented)

The sections above describe **implemented** behaviour. The following extend the
commercial lifecycle upstream (preconstruction) and downstream (forecast, margin,
final account). They are **conceptual and planned** — the app does not calculate
them today, and their exact formulas, fields, and lifecycles are decided in each
feature's design sprint (order: [ROADMAP.md](../ROADMAP.md)). Nothing below is a
shipped guarantee; all commercial figures will follow the read-time-derivation and
cost-code-spine invariants when built.

### BOQ and Estimating *(planned)*

A Bill of Quantities captures measured quantities against **cost codes**; applying
rates plus margin/overheads produces an **estimate**, which transfers into an
**approved budget** (budget lines). The cost code is the join from measurement all
the way to budget. Manual quantity entry precedes any AI takeoff.

### Tender and Award *(planned)*

Tender packages are assembled from BOQ items grouped by trade/cost code;
subcontractors are invited; bids are compared and levelled **by cost code** against
the estimate. The winning bid is **awarded**, becoming a commitment (a purchase
order). Award snapshots values at the transfer point, mirroring the existing
snapshot idiom.

### Variations *(implemented — foundation)*

Commercial change control is modelled as **one type-discriminated collection**
(`variations`, ADR-18), project-scoped, `CV-0001`/`SV-0001` numbered from
company-wide counters. Two types:

- **Client Variation** (`variationType: 'client'`, *Head Contract Variation*) — a
  change to **contract revenue**. No PO relationship. Approved client variations
  are a **revenue-side input only**: they never alter Budgeted, Committed,
  Claimed, Invoiced, or Actual. Forecast Revenue / Cash Flow / Margin consumers
  are deferred.
- **Supplier Variation** (`variationType: 'supplier'`, *Subcontract Variation*) — a
  change to a **supplier/subcontract commitment**, referencing **one** sent/closed
  PO or **none**. Approved supplier variations feed **Commitment Exposure** at
  read time (see below).

**Lifecycle** (forward-only, no deletion):

```
draft → submitted → approved            (terminal)
                  → rejected            (terminal)
      → withdrawn / (submitted →) withdrawn   (terminal)
```

`under_review`, `disputed`, and `superseded` are **reserved** (no UI transition).
A **submitted** request becomes an **approved** order through approval — these are
lifecycle stages, not separate entities.

- **Draft** — fully editable.
- **Submitted** — content freezes; may only be assessed or transitioned.
- **Approved** — carries per-line `approvedAmount` values, **prefilled from
  submitted** and **unbounded** (above, below, equal, zero, or negative — variation
  negotiation is not bounded like a progress claim). `assessmentNotes` are
  **required** when any approved amount differs from its submitted amount.
  Approved amounts and commercial content freeze forever.
- **Rejected / Withdrawn** — terminal audit records; contribute nothing financially.

**Tax & totals.** All line amounts are **ex-GST**. Per-line `taxCode`
(`gst` 10% · `gst_free` 0% · `input_taxed` 0%) yields a per-line, per-side
`submittedGst`/`approvedGst`; header subtotals/GST/totals **derive from the lines**
(no flat header rate). Negative amounts and negative GST are supported for
credits/omissions and are **not** clamped.

**Counting point — `approved` only.** Pending (`draft`/`submitted`) variations are
**exposure only** and count nowhere.

- **Approved Supplier Variations** are derived by `costCodeId` at read time
  (`approvedSupplierVariationsByCostCode`). They **never** write to Budget Lines,
  **never** mutate POs/claims/invoices, and **do not** directly affect Claimed,
  Invoiced, or Actual. Negative approved supplier variations reduce the total;
  nothing is clamped to zero.
- **Approved Client Variations** are derived as revenue totals at read time and do
  **not** alter the cost Budget. Revenue and supplier-cost variations stay strictly
  separate.

**Deferred (not in this foundation):** claim-against-variation and
invoice-against-variation linkage (the reserved `progressClaims.variationId` stays
`null`; no variation references are added to PO/claim/invoice line items), and
maturing variation commitment against claims/invoices. **Internal Budget
Adjustments** (budget transfers/revisions with no external counterparty) are a
**separate future document type**, deliberately *not* modelled as variations.

### Forecast Cost to Complete *(implemented — foundation)*

A forward-looking, **strictly cost-side** control layer that answers "what do we
currently expect this project to cost when complete?" It is **read-time derived**
like the six budget figures — the only stored value is one manual input per cost
code. Lives on the project **Forecast** tab; inputs are per-cost-code
`forecastLines` (document ID = `costCodeId`; see [DATA_MODEL.md](DATA_MODEL.md)).

**The single manual input.** Per cost code, the forecaster enters **Uncommitted
Cost to Complete** — the Estimate to Complete for work *not already represented by
Actual or Remaining Committed*. It is `number | null`: `null` = *not forecast*,
`0` = reviewed with no further uncommitted cost expected, `< 0` = rejected. Every
other figure below is derived from the exact same read-time calculations the
Budget page uses (`lib/forecast.js` composes the existing `lib/` helpers — Actual,
Remaining Committed, approved/pending supplier-variation exposure are **not**
recomputed independently).

**Formulas (all ex-GST, per cost code and rolled up per project):**

```
Cost to Complete    = Remaining Committed + Uncommitted Cost to Complete
Forecast Final Cost = Actual + Remaining Committed + Uncommitted Cost to Complete   (a.k.a. Estimate at Completion / EAC)
Variance to Budget  = Budgeted − Forecast Final Cost                                (a.k.a. Variance at Completion / VAC)
```

- **Variance to Budget > 0 ⇒ forecast under budget; < 0 ⇒ forecast over budget.**
- **`null` (not forecast) contributes zero** to totals for calculation while the
  row stays visibly *not forecast*; a project-level count of unforecasted cost
  codes is shown.

**No automatic remaining-budget forecast.** A **Remaining Budget Reference**
(`Budgeted − Actual − Remaining Committed`) is shown as information only and backs
an explicit **"Use remaining budget"** action (copies the reference when positive,
otherwise 0). It is **never** auto-applied: remaining budget is a target, not a
prediction — assuming it equals remaining cost would force Variance to zero and
hide overruns.

**Supplier variations are separate exposure, never added to the forecast.**
Approved and pending supplier variations **do not yet mature** against claims or
invoices, so they are shown as **separate context** (Approved Supplier Variation
Exposure, Pending Supplier Variation Exposure) and are **not** added into Forecast
Final Cost. There is deliberately **no "Forecast Final Cost including variation
exposure" total** — because a variation cannot yet be attributed against the claims
or invoices on its PO, auto-adding it would double-count it the moment the varied
PO is invoiced. The forecaster instead consciously folds the remaining expected
variation cost into **Uncommitted Cost to Complete**. (Client variations are
revenue-side and do **not** appear on the cost forecast at all.)

**Cost-code union.** The Forecast table includes every cost code that appears in
**any** of: budget lines, sent/closed PO lines, Actual, posted/paid supplier
invoices, supplier variations, or existing forecast lines — using the same
unbudgeted-row treatment as the Budget page (amber row when there is no budget
line). A cost code never disappears for having only actual / only a PO / only a
variation / only a forecast line, and inactive cost codes are retained.

**Closed-PO residual.** Remaining Committed uses the **identical** calculation as
the Budget page (PO lifecycle and commitment maths are unchanged). When a **closed**
PO still carries uninvoiced commitment, the row shows an amber indicator so the QS
can judge it — the amount is **left visible**, never silently removed.

**Lifecycle.** Current forecast lines are **living, editable inputs** — not
immutable financial records. There is intentionally **no** Draft/Review/Approved/
Superseded status, no formal approval, and no creator-vs-approver segregation in
this foundation. Saving is explicit (per dirty row or all dirty rows), rejects
negatives, shows progress/errors, and never auto-saves on keypress or silently
discards edits; `updatedAt`/`updatedBy` are shown after save. No calculated
staleness flag is claimed (there is no reliable source-change / reporting-period
rule yet) — only *Not forecast*, *Last updated*, and *Updated by* are surfaced.

**Deferred:** reporting periods, monthly reporting, forecast cut-off dates, period
locking, immutable period snapshots, prior-period comparison, approval workflow,
probability weighting, risk allowance, forecast adjustment, final-forecast
override, and — strictly out of this cost-side branch — Forecast Revenue, Cash
Flow, Project Margin, Final Account, and PULSE. `variations.forecastAmount` is
**not** used here.

### Cash Flow *(planned)*

Time-phased projection of cost and income across the project, driven by claims,
invoices, payment terms, and schedule inputs. A commercial output, not a generic
chart.

### Project Margin *(implemented — foundation)*

The first revenue-and-margin layer, answering "how much profit and margin do we
forecast, and how far has it moved from what we originally planned?" It is
**read-time derived** exactly like the six budget figures — the only stored values
are the **Project Commercial Baseline** inputs (one document per project;
`…/projects/{projectId}/commercial/baseline`, deterministic id `baseline`; see
[DATA_MODEL.md](DATA_MODEL.md)). Lives on the project **Commercial** tab, with
financial-role-only headline cards mirrored on the Overview tab from the **same**
derivation (`lib/margin.js`).

**Stored inputs** (baseline): `originalContractValue` (ex-GST),
`originalApprovedBudget` (ex-GST, `number | null`), `contractStartDate`,
`contractCompletionDate`, `clientId`/`clientName`, `notes`, audit stamps. **Everything
below is derived** by `lib/margin.js`, composing `lib/variations.js` (approved/pending
client & supplier variation totals) and `lib/forecast.js` (Forecast Final Cost) — no
figure is written back.

**Formulas (all ex-GST):**

```
Current Contract Sum       = Original Contract Value + Approved Client Variations
Forecast Revenue           = Current Contract Sum
Forecast Gross Profit      = Forecast Revenue − Forecast Final Cost
Forecast Margin %          = Forecast Gross Profit ÷ Forecast Revenue × 100
Original Planned Profit    = Original Contract Value − Original Approved Budget
Original Planned Margin %  = Original Planned Profit ÷ Original Contract Value × 100
Margin Movement            = Forecast Gross Profit − Original Planned Profit
```

- **Forecast Final Cost** is the identical read-time Estimate at Completion shown on
  the Forecast tab (Actual + Remaining Committed + Uncommitted Cost to Complete) —
  not recomputed independently.
- **Margin vs markup, revenue vs cash.** Margin % is profit as a share of **revenue**
  (markup — profit over **cost** — is a different, larger number and is not shown).
  *Forecast Revenue* is the contractual value of work; it is **not** invoiced revenue
  or cash received — Constrapp has no Client Invoices / Accounts Receivable or
  Payments, so there is deliberately **no cash figure** in this foundation.

**Null / zero behaviour (mandatory):**

- **Forecast Revenue ≤ 0** ⇒ Forecast Margin % is `null`, displayed **"—"** (never
  `NaN`/`Infinity`/`0%`). Same guard for Original Planned Margin % when Original
  Contract Value ≤ 0.
- **`originalApprovedBudget === null`** (baseline not established) ⇒ Original Planned
  Profit, Original Planned Margin %, and Margin Movement all display **"—"**.
- **No baseline / no Original Contract Value** ⇒ the revenue-side figures display
  **"—"** with a prompt to set the baseline; the cost side (Forecast Final Cost) still
  shows.

**Variations stay separate.** **Approved client variations** raise Current Contract
Sum (signed — negative approved client variations reduce it, never clamped).
**Pending client variations** are shown as separate **revenue exposure** and are
**not** in Forecast Revenue. **Approved and pending supplier variations** are shown as
separate **cost exposure** and are **never** added to Forecast Final Cost (they do not
yet mature against claims/invoices — auto-adding would double-count once the varied PO
is invoiced; the forecaster folds real expected variation cost into Uncommitted Cost
to Complete on the Forecast tab).

**Currency.** Margin values are **ex-GST** and use the app's existing AUD display; the
baseline stores no `currency` field and no new hard-coded AUD values are introduced.
Company/project currency inheritance and removal of hard-coded AUD formatting are the
next foundation (`feature/company-country-currency`); no FX conversion is planned.

**Lifecycle.** The baseline is a **living, editable input** — no draft/approved
status, no snapshots, no approval workflow, and Original-Approved-Budget immutability
is **not** claimed (it cannot be enforced without a trusted backend). Reads/writes are
restricted to internal financial roles; the baseline **never** mutates Projects,
Budget Lines, POs, claims, supplier invoices, variations, or forecast lines.

**Deferred:** Cash Flow, Client Invoices, Accounts Receivable, Payments, retention
modelling, monthly periods, immutable snapshots, approval workflow, probability
weighting, and any manual/probability-weighted revenue forecast override.

### Final Account *(planned)*

The closing reconciliation: approved budget + approved variations vs actual cost,
resolving to the **final project margin**. Commercial reporting summarises margin,
cost-to-complete, cash flow, and the final account.

## Future Integrations

- **Payments** — the reserved `paid` status / `paidAt` stamp, payment records,
  and retention release follow the invoices foundation.
- **Credit Notes** — the reserved `docType: 'credit_note'` / `adjustsInvoiceId`
  fields will carry supplier credits/negative adjustments that reduce Invoiced.
- **Attachments** — the reserved `attachments: []` array on invoices anchors
  future Firebase Storage uploads (invoice PDFs); no uploads today.
- **Variation → claim/invoice linkage** — the reserved `variationId` on claims
  will link a Supplier Variation into claiming; invoice-against-variation and
  maturing variation commitment against claims/invoices follow. The Variations
  foundation itself is implemented (see above); only this downstream linkage is
  deferred.
- **Budget Adjustments** — internal budget transfers/revisions (no external
  counterparty) as a distinct future document type, separate from Variations.
- **Xero / MYOB / QuickBooks** — the empty `externalRefs` map on POs, claims, and
  invoices is the anchor for accounting-system document IDs; per-line invoice
  `taxCode`s map to accounting tax codes; `roundMoney` exists so totals reconcile
  to the cent with those systems.
