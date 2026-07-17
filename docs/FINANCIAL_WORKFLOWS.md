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

## The Six Budget Figures — Exact Definitions

All derived figures group PO/claim **line items by `costCodeId`** and are ex-GST.

| Figure | Definition | Source |
|---|---|---|
| **Budgeted** | Σ `budgeted` across the project's budget lines | Stored on budget lines |
| **Committed** | Σ `lineTotal` of PO lines, POs in `sent`/`closed` | Derived from POs |
| **Claimed** | Σ `claimedThisPeriod` of claim lines, claims in `submitted`/`under_review` — uncertified exposure only | Derived from claims |
| **Actual** | Σ `approvedThisPeriod` of claim lines, claims in `approved`/`invoiced` | Derived from claims |
| **Invoiced** | Stored `invoiced` on budget lines — always 0 until the invoices module exists | Stored (future) |
| **Remaining** | `Budgeted − Actual` (per line and in total) | Computed |

### Committed and Actual overlap — never add them

A claim certifies part of a PO's value. That value is **already inside
Committed** (the PO) and, once approved, **also inside Actual** (the claim).
They answer different questions — "what have we promised to pay?" vs "what
value have we certified?" — and summing them double-counts. Today Committed
stays at full PO value regardless of claims; once invoicing exists, Committed
matures to *PO value − invoiced-to-date* so the figures become complementary.

## Future Integrations

- **Invoices** — supplier invoices matched to approved claims will populate
  `invoiced` (and `invoicedAt` on claims via the reserved `invoiced` status),
  and mature the Committed formula as above.
- **Variations** — the reserved `variationId` on claims will link approved
  scope changes into claiming and budget adjustments.
- **Payments** — payment recording and retention release follow invoices.
- **Xero / MYOB / QuickBooks** — the empty `externalRefs` map on POs and claims
  is the anchor for accounting-system document IDs; `roundMoney` exists so
  totals reconcile to the cent with those systems.
