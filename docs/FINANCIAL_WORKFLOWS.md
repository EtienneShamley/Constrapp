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

## Future Integrations

- **Payments** — the reserved `paid` status / `paidAt` stamp, payment records,
  and retention release follow the invoices foundation.
- **Credit Notes** — the reserved `docType: 'credit_note'` / `adjustsInvoiceId`
  fields will carry supplier credits/negative adjustments that reduce Invoiced.
- **Attachments** — the reserved `attachments: []` array on invoices anchors
  future Firebase Storage uploads (invoice PDFs); no uploads today.
- **Variations** — the reserved `variationId` on claims will link approved
  scope changes into claiming and budget adjustments.
- **Xero / MYOB / QuickBooks** — the empty `externalRefs` map on POs, claims, and
  invoices is the anchor for accounting-system document IDs; per-line invoice
  `taxCode`s map to accounting tax codes; `roundMoney` exists so totals reconcile
  to the cent with those systems.
