# Financial Workflows

How Budget Lines, Purchase Orders, and Progress Claims behave and how the six
budget figures are computed. Schema detail: [DATA_MODEL.md](DATA_MODEL.md).
Decision rationale: [PROJECT_DECISIONS.md](PROJECT_DECISIONS.md).

All amounts are in the **project's currency** (`project.currency` →
`company.baseCurrency` → `AUD`) — see *Currency & tax* below. Budget figures, PO
line totals, retention, and claim line amounts are **ex-GST**. Every money figure
passes through `roundMoney()` (round-half-up to cents) so totals reconcile
against accounting exports later.

## Currency & tax

**Currency is a label, never a conversion.** Each project reports in exactly one
currency. Constrapp performs **no FX conversion**, holds no exchange rates, and
supports no mixed-currency project transactions. Changing a currency never
converts, recalculates, or alters a stored amount — which is why the project
currency **locks** as soon as the project holds any monetary value (a non-zero
headline budget, budget line, purchase order including draft/cancelled, progress
claim, supplier invoice, client invoice, **client receipt**, **supplier
payment**, variation, forecast
input, or established commercial baseline). Cost Codes and Contacts hold no money
and never lock. POs, claims,
supplier invoices, and variations snapshot the project currency at write time as
**audit context**; the project currency remains the display authority, and
documents created before this foundation keep their stored `AUD`. Definitions:
[DATA_MODEL.md](DATA_MODEL.md); rationale: ADR-21.

> **⚠️ Tax limitation.** Currency **display** is configurable; **tax calculation
> is not.** `GST_RATE` is a flat Australian **10%**, and the "GST 10%" labels on
> purchase orders, progress claims, supplier invoices, and variations are
> Australian. Every formula in this document — PO GST, claim GST on the net
> post-retention amount, `retentionGst = retention × 10%`, per-line `taxCode`
> handling — is **Australian GST**. Selecting New Zealand (GST 15%), South Africa
> (VAT 15%), the United Kingdom (VAT 20%), the United States (sales tax, a
> different model), or any other country changes **only the currency label** and
> does **not** make Constrapp tax-compliant there. Company Settings states this
> whenever the chosen country is not `AU`. Country-specific tax configuration is
> a separate future foundation.

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
  subtotal. It is **excluded from what is payable** — Supplier Payments settle
  `payableTotal`, which is already net of it (see *Supplier Payments* below).
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
`draft`/`approved`. Forward-only. `received`, `under_review`, and `disputed` are
**reserved** (defined, no UI transition yet).

> **⚠️ `paid` is DEPRECATED IN PLACE, not reserved.** Supplier Payments have
> shipped and deliberately did **not** activate it: payment state is **derived**
> from posted Supplier Payment allocations (see *Supplier Payments* below), so an
> authored `paid` status would be a second, contradictory source of payment
> truth. `SI_TRANSITIONS` contains **no** transition into `paid` and never will,
> and `paidAt` is written once as `null` and never updated. Both are retained
> only so legacy or malformed documents still render. Because supplier-invoice
> lifecycle rules remain deferred ([SECURITY.md](SECURITY.md) → Deferred Control
> 1), a **direct-SDK caller can still forge `status: 'paid'`** — which is exactly
> why `paid` is deliberately left in the counting statuses below. See ADR-24.

- **Draft** — fully editable.
- **Approved** — internally certified; locked except for valid lifecycle actions.
  `approvedAt`/`approvedBy` stamped.
- **Posted** — the **financial commit point**: the invoice now counts toward
  Invoiced and Actual and matures Committed. Immutable. `postedAt`/`postedBy`
  stamped. **Posted invoices cannot be cancelled or unposted** — corrections are
  **Supplier Credit Notes** (see below; a posted, retention-free invoice can
  receive one).
- **Cancelled** — audit record retained (never deleted); contributes nothing.
  `cancelledAt` stamped.

**Counting statuses** (contribute to budget figures): `posted` and `paid`. The
app never produces a `paid` document, so in practice this means **posted**.
`paid` is nonetheless **retained** in `SI_COUNTING_STATUSES` on purpose: if a
direct-SDK caller forged that status on a real invoice, removing it here would
silently erase that invoice from Invoiced and Actual. Counting it is the safe
failure mode — the cost stays visible. It is **not** used for payment
reconciliation, which reads **only `posted`** invoices (see *Supplier Payments*).

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

## Client Invoice Lifecycle (Accounts Receivable)

Client invoices are the **revenue side** — what the company has formally billed
the head-contract client. They are the mirror of supplier invoices (accounts
payable) and share no documents with them: a client invoice is controlled against
the **Current Contract Sum** and **approved client variations**, never against a
PO, a progress claim, or a supplier. Numbering: `CI-0001` from
`counters/clientInvoices`, incremented in the same transaction as the write.

> **⚠️ Invoiced is not paid, and invoiced revenue is not cash.** Client Receipts
> now exist (see *Client Receipts* below), so a real receivables balance is
> available — but it is **derived at read time from receipt allocations and never
> stored on an invoice**. There is still **no `paid` status** on any invoice, and
> *paid*/*unpaid* are never used as an invoice status. Constrapp records the cash
> a user tells it about; it cannot verify that money was genuinely received.

### The six terms that must never blur

```
Client Progress Claim   what we ASK the client to certify          (NOT MODELLED)
Client Invoice          what we FORMALLY BILL the client           (implemented)
Invoiced Revenue        Σ issued, non-void client invoices ex-GST  (read-time)
Accounts Receivable     issued invoices less posted receipt allocations
                        → the REMAINING BALANCE (read-time, gross inc. GST)
Cash Received           money actually banked                      (implemented —
                        Client Receipts; posted receipts only)
Recognised Revenue      revenue earned under an accounting policy  (NOT MODELLED)
```

*Cash Received* is **not** revenue: it feeds no budget figure, no forecast, and
no margin figure. An unallocated receipt is cash received against **no** invoice.

*Forecast Revenue* (Project Margin, below) is **contractual value** and is none of
these.

### Lifecycle

```
draft ──▶ issued ──▶ void        (void is terminal)
  └────────────────▶ void
```

- **Draft** — fully editable. Contributes to nothing; shown as a separate
  "Draft Client Invoices" figure, never netted against Available to Invoice.
- **Issued** — the commercial commit point and the single counting status.
  Immutable: the only permitted change is voiding. `issuedAt`/`issuedBy` stamped.
- **Void** — terminal audit record, contributing nothing forever. Requires a
  **non-empty reason**. The invoice number is retained, so a void leaves an
  intentional, visible gap in the sequence. Financial records are never deleted.
- **`sent` is reserved** (defined with no transition into it). Constrapp has no
  delivery mechanism and no email provider, so a `sent` status would assert that
  a client received something the app cannot evidence.
- **There is no `paid` or `partially_paid` status — not even reserved.** Payment
  state will be derived at read time from Receipt records; a payment field on the
  invoice would invite a client-maintained rollup (ADR-3/ADR-4).

**Unlike every other financial collection, this lifecycle is enforced by
Firestore rules, not only by the client hook** — see [SECURITY.md](SECURITY.md).

### Contract-value control (all read-time, all ex-GST)

```
Current Contract Sum   = Original Contract Value + Approved Client Variations   (lib/margin.js)
Issued Client Invoices = Σ subtotal of invoices with status 'issued'            (drafts & voids excluded)
Available to Invoice   = Current Contract Sum − Issued Client Invoices          (a.k.a. Unbilled Contract Value)
```

`Available to Invoice` is **signed** — it goes negative on an over-invoiced
contract and is never clamped, because hiding an over-invoiced position is the
whole problem.

**Over-invoicing is warned, never blocked**, matching over-claiming and AP
over-invoicing. Exceeding the Current Contract Sum, or a variation's approved
amount, raises an amber warning and requires an **explicit acknowledgement tick**
before saving. It is never described as prevented: Firestore rules cannot sum
sibling documents, so **the limit is client-side only and two users can
concurrently consume the same remaining availability** (SECURITY.md → Deferred
Controls).

### Variation invoicing

An invoice line is either a **contract line** (billed against the contract sum,
`variationId: null`, no cost code) or an **approved client variation line**
carrying `variationId` plus frozen `variationNumber`/`variationDescription`.

```
Invoiced (variation)  = Σ ex-GST line amount across ISSUED invoices for that variationId
Remaining (variation) = approvedSubtotal − Invoiced                    (signed)
```

- **Only `approved` client variations are invoiceable.** Pending
  (draft/submitted) variations are exposure only — approval is the counting point
  (ADR-18) — and billing unapproved work is exactly what this guard prevents.
- **Negative approved client variations (credits/omissions) are not offered.** A
  credit cannot be positively invoiced. They still **reduce the Current Contract
  Sum**, and therefore Available to Invoice, through the existing signed
  `approvedClientVariationsTotal`; a future Credit Note bills them.
- **Variation documents are never mutated by invoicing** — no stamp, no status
  change, no back-reference. The linkage is entirely read-time, exactly as ADR-17
  keeps claims unmutated by supplier invoices.

### Line amounts, GST & currency

All canonical line `amount`s are **ex-GST**, each with a `taxCode`
(`gst` 10% · `gst_free` · `input_taxed`) and a computed `gstAmount`.

```
subtotal   = Σ line amount        (ex-GST)
gstTotal   = Σ line gstAmount
grossTotal = subtotal + gstTotal  ← what the client was billed
```

There is **no retention and no payable/gross split** on the client side in this
foundation (client retention is a separate future foundation), so `grossTotal` is
unambiguous. GST remains a flat **Australian 10%** regardless of the project's
currency; a non-AU company sees the standard tax-limitation notice. The project
currency is snapshotted as **audit context** and never read for display, and a
client invoice is monetary data, so creating one **locks the project currency in
the same transaction** (ADR-21).

### Due dates and payment terms

`invoiceDate` and `dueDate` are `'YYYY-MM-DD'` strings. The due date is suggested
from the **client contact's** `paymentTerms` (`{ days, basis: 'invoice' | 'eom' }`),
snapshotted onto the invoice, and **always editable**. The resolution chain is
deliberately shallow and is **named in the UI**:

```
manual override on the invoice   →   client contact's payment terms   →   BLANK
```

When no terms exist the due date is **left blank with an explanatory note** — no
hidden 30-day default is ever applied. Contract-level payment terms on the
commercial baseline are the correct long-term home (the same client can carry
different terms on two contracts) and are **deferred**, since this branch does not
modify the baseline.

### Accounts Receivable — ageing on the remaining balance

Issued invoices are bucketed on their **remaining gross (inc. GST) balance after
posted receipt allocations**: *No due date* · *Not yet due* · *Past due 1–30* ·
*31–60* · *61–90* · *90+ days*.

- **Fully reconciled invoices contribute zero and leave ageing entirely** — they
  stay in the register with a *Fully reconciled* badge, so nothing is hidden.
- **Partially reconciled invoices age only their remainder.**
- **Over-reconciled invoices are excluded from the buckets** and listed in a
  dedicated callout with their signed negative balance, so a credit position can
  never offset genuine arrears inside a bucket total.
- **Voiding a receipt restores the balance immediately** at the next render —
  there is no reversal record and no invoice write.
- **Unallocated receipts reduce no invoice balance** and appear nowhere in
  ageing; they are reported separately as money on account.
- *Past due* means past the due date **and still owing** — an invoice past its
  due date but fully reconciled is not past due in any sense that matters.

The pre-Receipts disclaimer ("Constrapp has no Receipt records, so every issued
invoice stays here until it is voided") is **removed**, replaced by the limits
that genuinely remain:

> Balances reflect posted receipts allocated to each invoice. Constrapp warns but
> does not block over-allocation, and cannot prevent two users allocating the
> same balance concurrently. Unallocated receipts are shown separately and do not
> reduce any invoice balance.

### No writes to any other document

Like POs, claims, and supplier invoices, client invoices **never write onto
Budget Lines** — and additionally never write onto the commercial baseline or
variations. Every contract-control and receivables figure is derived at read time
in `lib/clientInvoices.js`. The six budget figures are **completely unchanged**:
client invoices are revenue-side and touch no cost figure.

### Deferred

Printable invoice, PDF, email, branding · **"Tax Invoice" labelling and company
legal/tax identity** (see [SECURITY.md](SECURITY.md)) · **client** credit notes
(supplier credit notes have since shipped — see *Supplier Credit Notes*; the
client-side `docType`/`adjustsInvoiceId` fields stay reserved, and a future
client credit note must never subtract from revenue a second time, because
negative approved client variations already reduce the Current Contract Sum) ·
client retention · revenue recognition · client progress claims ·
client portal access. (Receipts, allocations, partial settlement, overpayments,
payment date/method/bank reference, and the invoice balance after receipts have
since **shipped** — see *Client Receipts* below.)

## Client Receipts (cash received — accounts receivable settlement)

Client Receipts record **money actually received** from a head-contract client
and allocate it against issued Client Invoices. They are the settlement half of
accounts receivable, and the first real cash record in Constrapp. Numbering:
`CR-0001` from `counters/clientReceipts`, incremented in the same transaction as
the write. Schema: [DATA_MODEL.md](DATA_MODEL.md); rationale: ADR-23.

> **⚠️ Cash is not revenue, and a receipt is not a taxable supply.** A receipt
> stores **gross cash only** — no GST, no tax code, no net amount. The tax was
> already recorded on the invoice being reconciled; recomputing it here would
> double-count it and would disagree with the invoice on a partial payment.
> Receipts feed **no** budget figure, **no** forecast figure, and **no** margin
> figure.

### Lifecycle

```
draft ──▶ posted ──▶ void        (void is terminal)
  └────────────────▶ void
```

- **Draft** — fully editable (amount, date, method, references, allocations).
  Contributes to nothing; shown as a separate "Draft Receipts" figure.
- **Posted** — the financial commit point and the single counting status.
  Immutable: the only permitted change is voiding. `postedAt`/`postedBy` stamped.
- **Void** — terminal audit record, contributing nothing forever. Requires a
  **non-whitespace reason**. The number is retained, leaving an intentional,
  visible gap. Financial records are never deleted.
- **`posted`, not "confirmed" or "reconciled".** *Reconciled* names the derived
  state of an **invoice**; reusing it as a transaction status would blur the two
  ideas this module exists to keep apart.

Like `clientInvoices`, **this lifecycle is enforced by Firestore rules**, not
only by the client hook — see [SECURITY.md](SECURITY.md).

### Allocation

Allocations are **embedded** on the receipt (ADR-6 idiom):
`{ clientInvoiceId, invoiceNumber, allocatedAmount }`.

```
Allocated Total     = Σ allocations[].allocatedAmount
Unallocated Amount  = Receipt Amount − Allocated Total
```

- One receipt may allocate across **several** invoices; several receipts may
  allocate against **one** invoice.
- Only **issued**, non-void invoices **belonging to the selected client** on
  **this project** may be allocated (client-enforced).
- Allocations are freely editable while `draft` and **freeze permanently** when
  posted.
- Changing the client on a draft **clears its allocations after an explicit
  confirmation** — an invoice belongs to one client.
- Allocating **more than the receipt amount is hard-blocked** (the money does not
  exist) — and the scalar arithmetic is rules-enforced.
- Allocating **more than an invoice's remaining balance is warned with an
  explicit acknowledgement, never blocked** — it cannot be enforced anywhere
  (rules cannot sum sibling documents).

### Unallocated receipts are permitted and normal

A receipt may be saved and posted fully allocated, partly allocated, or entirely
unallocated. Real cases: the client pays before the invoice is raised, the client
overpays, or the payment is recorded before the allocation is known.

**Unallocated money reduces no invoice balance.** It is reported separately as
*"Unallocated — on account"* and is **never** auto-applied to the oldest invoice:
that is an accounting policy decision Constrapp does not make on the user's
behalf. An explicit **"Allocate oldest first"** action exists, produces an
editable proposal, and runs only when pressed.

### Invoice balance derivation (read-time, never stored)

```
Received Against Invoice = Σ allocatedAmount across POSTED, non-void receipts
                             referencing that invoice
Remaining to Reconcile   = clientInvoice.grossTotal − Received Against Invoice   (SIGNED)
```

Measured against **gross** (inc. GST), because gross is what the client was
billed — client invoices carry no retention and no payable/gross split (ADR-22).
The balance is **signed and never clamped**.

Derived reconciliation state — **never an authored invoice status**:

| State | Condition |
|---|---|
| **Unreconciled** | received = 0 |
| **Partly reconciled** | 0 < received < gross |
| **Fully reconciled** | received = gross (compared in whole cents) |
| **Over-reconciled** | received > gross |

Draft receipts count nothing. Void receipts count nothing — **which is why
voiding restores balances automatically at read time, with no reversal document
and no write to any invoice.**

### Receipt dates

`receiptDate` is a `'YYYY-MM-DD'` string — the date money was **received**, not
the date it was entered. **The future Cash Flow module consumes `receiptDate`,
never `createdAt` or `postedAt`,** and can group by month with
`receiptDate.slice(0, 7)` without constructing a Date.

- **Backdating is allowed** without warning — entering last month's bank
  statement is the normal case.
- **A future-dated draft may be SAVED but not POSTED.** Posting asserts money has
  actually been received. ⚠️ This block is **client-enforced only**: Firestore
  rules validate the `'YYYY-MM-DD'` shape and have no reliable comparison against
  the caller's local calendar date.

### Allocation exceptions

An issued invoice can be **voided after** a receipt was posted against it; rules
cannot prevent that (voiding needs no cross-document read). Constrapp surfaces it
rather than automating a fix:

- the **cash stays real** — the receipt keeps its amount and stays counted;
- the **allocation is listed as an exception** on both the Receipts and Client
  Invoices views;
- the void invoice stays out of ageing (it is void);
- **nothing is deleted, reassigned, or reversed automatically.**

Documented remedy: void the receipt and record a new one against the correct
invoice.

### No writes to any other document

Client receipts **never write onto Client Invoices** (no balance field, no
payment status, no back-reference), and never onto Budget Lines, the commercial
baseline, variations, POs, claims, or supplier invoices. Every figure is derived
in `lib/clientReceipts.js` over `lib/payments.js`. The six budget figures,
Forecast Final Cost, and every margin figure are **completely unchanged**.

### Deferred (Client Receipts)

Refunds and reversal records (`docType: 'refund'` reserved) · client credit
notes · bank reconciliation and bank feeds · accounting integrations ·
attachments · printable remittance · email · automatic allocation policies ·
financial periods and period locking. (**Supplier Payments have since shipped** —
see below; the **Actual Cash Flow foundation** now consumes posted receipts —
see *Cash Flow — Actual*.)

## Supplier Payments (cash paid — accounts payable settlement)

Supplier Payments record **money actually paid** to a supplier or subcontractor
and allocate it against **posted** Supplier Invoices. They are the settlement
half of accounts payable and the money-out mirror of Client Receipts. Numbering:
`SP-0001` from `counters/supplierPayments`, incremented in the same transaction
as the write. Schema: [DATA_MODEL.md](DATA_MODEL.md); rationale: ADR-24.

> **⚠️ Cash out is not cost.** A payment settles an Actual cost that a **posted
> supplier invoice already recognised**. It stores **gross cash only** — no GST,
> no tax code, no net amount. Payments feed **no** budget figure, **no** forecast
> figure, and **no** margin figure: Budgeted, Committed, Claimed, Invoiced,
> Actual, Remaining Committed, Forecast Cost to Complete, Forecast Final Cost,
> Current Contract Sum, Forecast Revenue, Forecast Gross Profit, and Forecast
> Margin % are **all unchanged** by this module.

### Lifecycle

```
draft ──▶ posted ──▶ void        (void is terminal)
  └────────────────▶ void
```

- **Draft** — fully editable (supplier, amount, date, method, references,
  allocations). Contributes to nothing; shown as a separate "Draft Payments"
  figure.
- **Posted** — the financial commit point and the single counting status.
  Immutable: the only permitted change is voiding. `postedAt`/`postedBy` stamped.
  Posting is a **separate operation** carrying no content change.
- **Void** — terminal audit record, contributing nothing forever. Requires a
  **non-whitespace reason**. The number is retained, leaving an intentional,
  visible gap. Financial records are never deleted. **No reversal, refund, or
  bank-reversal record is created** — voiding corrects Constrapp's record, not
  the bank account.

Like `clientInvoices` and `clientReceipts`, **this lifecycle is enforced by
Firestore rules** — see [SECURITY.md](SECURITY.md).

### The payable basis — `payableTotal`, never `grossTotal`

```
payableTotal = grossTotal − retentionTotal        (already net of retention GST)
```

Allocations reconcile against **`supplierInvoice.payableTotal`**. `grossTotal` is
the **full taxable supply** — the face value of the supplier's tax invoice, not
what is owed on it. Allocating against gross would present **retained money as
currently payable** and leave a permanent phantom balance on every retained
invoice that could never be settled.

- **Retention withheld is not currently payable** and is excluded from every
  payment figure and every AP ageing bucket.
- **Retention release is not modelled.** A payment **never** writes, clears, or
  reduces `retention`, `retentionGst`, or `retentionTotal`.
- Invoices with `retentionTotal > 0` display gross invoiced, retention withheld,
  payable, Paid to Date, and Remaining Payable; the retention line is hidden when
  nothing is withheld.
- The user-facing label is **"Remaining Payable"** — never *Balance Due*, *Amount
  Owing*, *Outstanding Payable*, or *Overdue Payable*.

### Allocation

Allocations are **embedded** on the payment (ADR-6 idiom):
`{ supplierInvoiceId, invoiceNumber, supplierInvoiceNumber, allocatedAmount }`.
**Both** invoice references are frozen — Constrapp's `SI-0007` and the supplier's
own `INV-4471`, which is what AP staff reconcile against — and both are
searchable.

```
Allocated Total     = Σ allocations[].allocatedAmount
Unallocated Amount  = Payment Amount − Allocated Total
```

- One payment may settle **several** invoices; several payments may settle
  **one**.
- Only **posted**, non-cancelled invoices belonging to the selected supplier on
  **this project** may be allocated (client-enforced), sorted oldest first.
  **`approved` is not the financial commit point — `posted` is**, so approved
  invoices are deliberately not payable.
- Allocations are freely editable while `draft` and **freeze permanently** when
  posted.
- Changing the supplier on a draft **clears its allocations after an explicit
  confirmation**; cancelling leaves both untouched. An invoice belongs to one
  supplier.
- Allocating **more than the payment amount is hard-blocked** (the money does not
  exist) — and the scalar arithmetic is rules-enforced.
- Allocating **more than an invoice's remaining payable is warned with an
  explicit acknowledgement, never blocked** — it cannot be enforced anywhere
  (rules cannot sum sibling documents).
- The **same invoice cannot be selected twice** on one payment (client-enforced;
  already-chosen invoices drop out of the other rows' pickers).

### Supplier identity

`supplierId` and `supplierName` are **required non-empty on every new payment**
(rules-enforced) — unlike every other counterparty link, and for the same reason
`clientReceipts.clientId` is: this is a new collection with no history to
accommodate, and money paid to nobody is not a record. Suppliers are chosen from
the same `PO_SUPPLIER_TYPES` list the PO picker uses (`supplier` and
`subcontractor` contacts).

Supplier **invoices** may still carry a legacy `supplierId: null` from before the
Contacts module. Those are matched on their **frozen `supplierName`** snapshot
(trim → lower-case → collapse whitespace), labelled in the UI as *"Matched by
supplier name — this invoice predates the Contacts module"*, and are **never
backfilled or otherwise modified**.

### Unallocated payments are permitted and normal

A payment may be posted fully allocated, partly allocated, or entirely
unallocated. Real cases: a supplier advance or deposit, a payment recorded before
the invoice arrives, an overpayment, or a bank line not yet matched.

**Unallocated money is still actual Cash Out** — the whole amount left the bank.
It **reduces no invoice balance**, appears **nowhere** in AP ageing, is reported
separately as *"Unallocated — on account"*, is **not** styled as an error, and is
**never** auto-applied. An explicit **"Allocate oldest first"** action exists,
produces an editable proposal, and runs **only when pressed** — never on opening
the editor, on changing the supplier, on changing the amount, on adding an
invoice, or on posting.

### Invoice balance derivation (read-time, never stored)

```
Paid Against Invoice     = Σ allocatedAmount across POSTED, non-void payments
                             referencing that invoice
Credited Against Invoice = Σ grossTotal across POSTED, valid-target Supplier
                             Credit Notes referencing that invoice
Remaining Payable        = supplierInvoice.payableTotal
                             − Paid Against Invoice
                             − Credited Against Invoice                (SIGNED)
```

The balance is **signed and never clamped**. Paid and Credited are carried as
**separate columns** — cash and reduction are different facts — and their sum
is what settles the payable. Derived reconciliation state (settled = paid +
credited) — **never an authored invoice status**:

| State | Condition |
|---|---|
| **Unreconciled** | settled = 0 |
| **Partly reconciled** | 0 < settled < payableTotal |
| **Fully reconciled** | settled = payableTotal (compared in whole cents) — a fully-credited unpaid invoice reads fully reconciled |
| **Over-reconciled** | settled > payableTotal — where a credit note contributes, the excess is **money recoverable from the supplier** (no refund is recorded automatically) |

Draft payments and credits count nothing. Void ones count nothing — **which is
why voiding restores balances automatically at read time, with no reversal
document and no write to any invoice.**

### Payment dates

`paymentDate` is a `'YYYY-MM-DD'` string — the date money **left the account**,
not the date it was entered. **The future Cash Flow module consumes
`paymentDate`, never `createdAt` or `postedAt`,** and can group by month with
`paymentDate.slice(0, 7)` without constructing a Date.

- **Backdating is allowed** without warning — entering last month's bank
  statement is the normal case.
- **A future-dated draft may be SAVED but not POSTED.** Posting asserts money has
  actually been paid. ⚠️ This block is **client-enforced only**: Firestore rules
  validate the `'YYYY-MM-DD'` shape and have no reliable comparison against the
  caller's local calendar date.

### Accounts Payable — ageing on the remaining payable

Posted supplier invoices are bucketed on their **remaining payable after posted
payment allocations and posted supplier credit notes**: *No due date* · *Not yet
due* · *Past due 1–30* · *31–60* · *61–90* · *90+ days*. A credited slice is no
longer owed, so it never ages as arrears.

- **Fully reconciled invoices contribute zero and leave ageing entirely** — they
  stay in the register with a *Fully reconciled* badge, so nothing is hidden.
- **Partially reconciled invoices age only their remainder.**
- **Over-reconciled invoices are excluded from the buckets** and listed in a
  dedicated signed callout, so a credit position can never offset genuine arrears
  inside a bucket total.
- **Voiding a payment restores the balance immediately** at the next render.
- **Unallocated payments reduce no invoice balance** and appear nowhere in
  ageing.
- **Retention is excluded throughout** — the basis is `payableTotal`.
- *Past due* means past the due date **and still payable**. The supplier-invoice
  register therefore uses the payment-aware `isPastDuePayable()`, not the
  date-only `isOverdue()` (which is retained unchanged for backwards
  compatibility and carries a warning JSDoc). The word **unpaid** is never used
  as an authored invoice status.

Honest limits, shown in the UI:

> Balances reflect posted Supplier Payments allocated to each invoice, net of
> posted Supplier Credit Notes. Constrapp warns but does not block
> over-reconciliation, and cannot prevent two users allocating the same
> remaining payable concurrently. Unallocated payments are shown separately and
> reduce no invoice balance. Retention withheld is excluded — retention release
> is not modelled.

### Allocation exceptions

A posted supplier invoice can be **cancelled after** a payment was posted against
it. Rules cannot prevent that — supplier-invoice lifecycle legality is still
client-enforced, so a **direct SDK call** can cancel a posted invoice. Constrapp
surfaces it rather than automating a fix:

- the **cash stays real** — the payment keeps its amount and stays counted;
- the **allocation is listed as an exception** on both the Supplier Payments and
  Supplier Invoices views, alongside supplier mismatches and unreadable invoices;
- the cancelled invoice stays out of AP ageing;
- **nothing is deleted, reassigned, or reversed automatically.**

Documented remedy: investigate first; where the payment itself was wrong, void it
and record a new one against the correct invoice.

### No writes to any other document

Supplier payments **never write onto Supplier Invoices** (no balance field, no
payment status, no back-reference, **no `paid` status, no `paidAt`**), and never
onto Budget Lines, POs, claims, variations, forecast lines, the commercial
baseline, client invoices, or client receipts. Every figure is derived in
`lib/supplierPayments.js` over `lib/payments.js`. The six budget figures,
Forecast Final Cost, and every margin figure are **completely unchanged**.

### Deferred (Supplier Payments)

**Forecast Cash Flow** (the *Actual* Cash Flow foundation has since shipped —
see *Cash Flow — Actual*) · retention
release · refunds and payment reversals
(`docType: 'refund'` reserved; supplier **credit notes** have since shipped —
see *Supplier Credit Notes* below) · payment batches and payment runs ·
remittance advice PDF · email · attachments · bank reconciliation and bank
feeds · accounting integrations · payment approval workflow and creator ≠
approver segregation · financial periods and period locking.

## Supplier Credit Notes (reduction records — accounts payable)

A **Supplier Credit Note** (`SCN-0001` from the company-wide
`counters/supplierCreditNotes`) records a reduction the supplier issued against
**exactly one posted supplier invoice**: over-claimed quantities, rejected
work, a back-charge, or a negotiated reduction (ADR-31). It is the third
payable-side document kind, and each kind holds one truth: the **invoice** is
the cost/payable fact, the **payment** is the cash fact, the **credit note** is
the reduction fact. None is ever mutated to reflect another.

### Lifecycle

`draft → posted → void` (void from draft or posted; terminal) —
**rules-enforced** to the ADR-22 standard, with unforgeable stamps and a
required non-whitespace `reason` (a credit without a stated cause is an audit
hole) and `voidReason`. Only **posted** credits count; voiding restores every
figure at the next render with no reversal document. The **target is frozen at
creation** — retargeting is a void plus a new credit note.

### Eligible targets — posted, zero retention

Only a **posted** supplier invoice with **no retention withheld** (and a stored
currency) can receive a credit note. Crediting a retained invoice is ambiguous
— payable slice or retained slice? — while retention release is unmodelled, so
it is blocked in the UI, in domain validation, **and by Firestore rules**,
which `get()` the target (the first cross-document read in a financial rules
block) and verify: it exists in this project, is `posted`, matches the credit's
`supplierId` and `currency`, carries `retentionTotal` of **zero**, and its
`payableTotal` covers this credit's `grossTotal` (whole cents).

### Lines, GST & the over-credit cap

Credit lines mirror invoice lines — ex-GST `amount` + per-line `taxCode` with
`gstAmount` (10% for `gst`, zero otherwise) — and **every line requires a cost
code drawn from the target invoice's lines**: a header-only credit would
reduce AP cash but leave cost-code Actual/Invoiced (and therefore FFC and
Margin) overstated. Headers: `subtotal` / `gstTotal` / `grossTotal`, with the
whole-cent header invariant rules-enforced. No retention and no payable/gross
split — a credit's gross **is** its payable effect.

```
Maximum creditable = supplierInvoice.payableTotal
                       − Σ grossTotal of already-POSTED credit notes on it
```

The cap is a **HARD BLOCK** in the editor and re-checked at post time —
deliberately stricter than the warn-and-acknowledge over-payment posture,
because crediting more than a debt is not a judgement call. Rules enforce the
**single-document** half (`grossTotal ≤ payableTotal` via the target `get()`);
the **cumulative** half across sibling credit notes cannot be rules-enforced
(no list/query/count — Deferred Control 25), so two users can still post
concurrent credits by direct SDK call.

### Financial effects (all read-time, never stored)

A **posted, valid-target** credit note:

- **reduces Invoiced and Actual** by its ex-GST line amounts per `costCodeId`
  (signed, never clamped — an over-credited cost code goes negative and stays
  visible), and through Actual reduces **Forecast Final Cost** and improves
  **Margin**;
- **reduces the target's Remaining Payable** by `grossTotal`, flowing into AP
  ageing, the payment-allocation picker, and **Forecast Cash Out**;
- **does NOT restore Remaining Committed** — credit lines carry no
  `poLineIndex`, so commitment maturing reads invoices only. Between a credit
  and any corrected re-invoice, FFC is briefly understated by the credited
  amount; the QS adjusts Uncommitted CTC if re-invoicing is expected (a
  documented ADR-31 limitation);
- **moves no cash** — Actual Cash Out remains payment-only, and a credit never
  appears in any cash column.

### Credit before, after partial, and after full payment

- **Before payment:** the remaining payable simply drops.
- **After partial payment:** `remaining = payable − paid − credited`; the
  invoice partly reconciles.
- **After full payment (or credits + payments exceeding the payable):** the
  balance goes **negative** — *Over-reconciled*, excluded from ageing buckets
  (never netted against arrears), and surfaced honestly as **money recoverable
  from the supplier**. No refund transaction is invented; the supplier refund
  workflow stays deferred (`docType: 'refund'` reserved).

### Read-time validity gating & exceptions

A posted credit counts toward **no** figure — neither the payable side nor the
cost side — unless it passes the single central gate in
`lib/supplierCreditNotes.js → creditTargetException`:

| Class | Checked |
|---|---|
| **Target** | still resolves to a counting supplier invoice · matching supplier · matching currency · **zero retention** · `payableTotal` covers the credit's `grossTotal` |
| **Document integrity** | stored `subtotal`/`gstTotal`/`grossTotal` reconcile to the credit's own `lineItems` (whole cents) · each line's GST matches its amount and tax code · each line amount is **positive** · every line's `costCodeId` appears on the target invoice |

The target class matters because rules validate the target at create, draft edit
and post but **never fire again**, so a target cancelled or altered afterwards
by a direct SDK call (supplier-invoice lifecycle is still client-enforced —
Deferred Controls 1 and 2) is caught here. The integrity class matters because
**rules cannot iterate `lineItems` at all**: only the scalar header invariant is
enforced server-side, so without this gate a rules-valid document could store
`grossTotal: 100` while its lines claimed 50,000 — reducing the payable by 100
and Actual by 50,000 simultaneously.

A failing credit is excluded **whole and never clamped**, and listed in a
*Credit-note exceptions* panel — the safe failure keeps project cost visible.
The target-status check uses the counting statuses (`posted` + the deprecated
forgeable `paid`), so a credit and its invoice can never disagree about whether
the invoice's cost exists. Nothing is deleted, reassigned, or reversed
automatically.

⚠️ This gate protects the figures Constrapp renders. It is **not** enforcement
and does not repair the stored document — see [SECURITY.md](SECURITY.md) →
Deferred Control 25.

### When credit notes cannot be read

A failed credit-note subscription is treated as **unknown, never zero**. Posted
credits reduce what is owed, so an empty list would *overstate* the remaining
payable and could invite paying money already credited. Supplier Payments and
Supplier Invoices therefore render every credit-dependent figure as
unavailable and disable the actions that consume a remaining payable; the
cost-side pages (Budget, Forecast, Overview, Commercial) warn that Actual and
margin may be overstated, since that direction is conservative. Cash Flow
already reports the same failure through its source-error panel.

### No writes to any other document

Supplier credit notes **never write onto Supplier Invoices** (no credited
total, no status change, no back-reference) and never onto Budget Lines, POs,
claims, variations, forecast lines, the commercial baseline, payments, client
invoices, or client receipts. Every net figure is derived in
`lib/supplierCreditNotes.js` and its consumers.

### Deferred (Supplier Credit Notes)

Client credit notes (a separate future collection; must never double-subtract
revenue already reduced by negative client variations) · crediting retained
invoices and any retention interaction · re-opening Remaining Committed ·
line-index (`poLineIndex`) matching · free-standing/unallocated credits ·
applying a credit as payment against a future invoice · refunds · an approval
stage before posting · attachments (no Storage) · accounting sync ·
final-account linkage.

## Tenders (packages, bids, comparison, award — financially inert)

The step between Estimate and Commitment, implemented as a **decision trail,
not a financial document set** (ADR-32 Part 2). A **Tender Package**
(`TP-0001`) names a scope — free text plus **≥1 selected cost codes** — and is
issued to market (issuing freezes the scope; only the informational closing
date and notes stay editable). **Tender Bids** are manual transcriptions of
received bids from supplier/subcontractor contacts, priced **per cost code**
within the package scope, **ex-GST with no GST fields** — GST enters the
lifecycle at commitment (PO), not at tender.

**No stored totals.** A bid stores only its lines; there is no `bidTotal` and
no `awardTotal` anywhere. Every displayed figure passes through the read-time
validity gate (`lib/tenders.js → assessBid`): a bid with any malformed line —
or whose finite lines total beyond representable range — is invalid as a whole,
total `null`, never a partial sum, never $0, and is excluded from ranking,
budget comparison, the cost-code matrix, and the Awarded Bid Value while
remaining visible and flagged. The app also refuses to award such a bid,
though that refusal is client-side only — see [SECURITY.md](SECURITY.md) →
Tenders for the direct-SDK case and why its consequence is bounded.

**Tender Comparison** (never "bid levelling") derives at read time:

```
Bid Total (ex-GST)        = Σ valid lineItems.amount            (assessBid)
Approved Budget (package) = Σ budgetLines.budgeted over the package's cost codes
Variance to Budget        = Approved Budget − Bid Total          (positive = under budget)
Variance to Lowest        = Bid Total − lowest valid bid total
```

When no budget line exists for any package cost code, the comparison reports
**no budget** — it never compares against zero. Void and invalid bids are
excluded from every calculation.

**Award changes no financial figure.** `issued → awarded` records
`awardedBidId`, the bidder-name snapshot, and notes. It creates **no PO** and
touches none of the six budget figures, no forecast, no margin, and no cash
flow; the **Awarded Bid Value** shown on the Tender pages is derived from the
rules-frozen awarded bid's lines and is a tender decision value only — it is
**never netted against Purchase Orders** (V1 has no Award → PO linkage, and
such netting is wrong whenever packages share cost codes or POs span
packages). Raising the PO remains a separate, deliberate act ("Raise PO from
Award" is future work). Tender reads: the comparison **reads** budget lines;
tender writes: packages, bids, the counter, and the currency-lock flag —
nothing else, ever.

**Currency.** A package holds no amounts and never locks the project currency;
recording the first **bid** locks it in the same transaction (a voided bid
remains lock evidence).

## The Six Budget Figures — Exact Definitions

All derived figures group PO/claim **line items by `costCodeId`** and are ex-GST.

| Figure | Definition | Source |
|---|---|---|
| **Budgeted** | Σ `budgeted` across the project's budget lines | Stored on budget lines |
| **Committed** | Remaining **open** commitment: per PO line (POs in `sent`/`closed`), `lineTotal − posted/paid invoiced-to-date against that line`, floored at 0, grouped by cost code | Derived from POs + invoices |
| **Claimed** | Σ `claimedThisPeriod` of claim lines, claims in `submitted`/`under_review` — uncertified exposure only | Derived from claims |
| **Actual** | Σ `approvedThisPeriod` of claim lines (claims in `approved`/`invoiced`) **not superseded by a posted/paid invoice** + Σ ex-GST line `amount` of posted/paid supplier invoices **− Σ ex-GST line `amount` of posted valid-target supplier credit notes** (signed, never clamped) | Derived from claims + invoices − credit notes |
| **Invoiced** | Σ ex-GST line `amount` of supplier invoices in `posted`/`paid` **− Σ ex-GST line `amount` of posted valid-target supplier credit notes**, grouped by cost code (signed, never clamped) | Derived from invoices − credit notes |
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

### BOQ *(implemented — foundation)* and Estimating *(planned)*

The **BOQ foundation is implemented** (ADR-32 Part 1): a per-project measured
schedule at `…/projects/{id}/boqItems` — description, quantity, unit, a
**mandatory** cost code (frozen name snapshot), and, once priced, an ex-GST
`rate` with a **derived** `amount = quantity × rate` (whole-cent,
rules-enforced). **`rate: null` means unpriced** — an unpriced item contributes
nothing to any total and suppresses the budget variance; 0 is a price.
Lifecycle `active → void` (terminal, reasoned), rules-enforced; delete blocked.

**The BOQ feeds no financial figure.** It never writes onto Budget Lines and
never enters Committed, Actual, Invoiced, Forecast, Margin, or Cash Flow. Its
only derived output is the read-time **BOQ vs Approved Budget** comparison on
the BOQ page (`lib/boq.js`): per cost code over the union of both sides,
`variance = Budgeted − BOQ` (positive ⇒ BOQ under budget), with the variance
**null — never 0 or a partial figure** — wherever either side is missing or
any contributing item is unpriced.

**Still planned (Estimating):** applying margin/overheads to produce an
estimate, and the **BOQ → Budget transfer** into budget lines. The cost code
remains the join from measurement all the way to budget. Manual quantity entry
precedes any AI takeoff.

### Tender and Award *(implemented — foundation; see the Tenders section above)*

Tender packages, manual bid capture, read-time Tender Comparison, and the award
decision record are **implemented** (ADR-32 Part 2), scoped by **cost codes +
free-text scope** and financially inert. Still planned: assembling packages
from **BOQ items** (an optional frozen scope schedule at issue — a separate
follow-up now that both foundations coexist), subcontractor invitations, item-level **bid levelling**
against the estimate, and **"Raise PO from Award"** — the explicit transfer of
the awarded bid into a commitment. Award-to-PO transfer will snapshot values at
the transfer point, mirroring the existing snapshot idiom.

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

### Cash Flow — Actual *(implemented — foundation)*

The first Cash Flow output, deliberately **actual-only**: recorded cash
movement, derived at read time on the Commercial tab's **Cash Flow** sub-view
(`…/commercial/cash-flow`). It stores **nothing** and writes **nothing** — no
new collection, no rules change; the two cash collections it reads are the
security boundary. Pure aggregation lives in `lib/cashFlow.js`, over the two
cash-row adapters (`lib/clientReceipts.js → cashInRows()` and
`lib/supplierPayments.js → cashOutRows()`), and is covered by the unit suite
(`npm run test:unit`).

> **⚠️ Not a bank balance.** The cumulative position starts at **zero** and is
> the project's net recorded cash movement. Constrapp models no bank account,
> no opening cash position, no financing, and no GST/BAS remittance — the page
> states this permanently.

**Formulas (all gross, inc. GST; every accumulation through `roundMoney`):**

```
Actual Cash In           = Σ amount of Client Receipts   with status 'posted'
Actual Cash Out          = Σ amount of Supplier Payments with status 'posted'
Actual Net Cash          = Actual Cash In − Actual Cash Out

Monthly Actual Cash In   = Σ posted receipt amounts where receiptDate.slice(0, 7) = month key
Monthly Actual Cash Out  = Σ posted payment amounts where paymentDate.slice(0, 7) = month key
Monthly Actual Net       = Monthly Actual Cash In − Monthly Actual Cash Out
Cumulative Position      = 0 + running Σ of Monthly Actual Net
```

**Rules of the derivation:**

- **Total transaction `amount`, never `allocatedTotal`** — that is what moved
  through the bank; a fully or partly unallocated receipt or payment counts its
  **full** amount (a supplier advance is real cash out, an overpayment is real
  cash in).
- **Transaction dates only** — `receiptDate` drives Cash In, `paymentDate`
  drives Cash Out; `createdAt`/`postedAt` are entry/commit facts and are never
  consulted. Month keys are `'YYYY-MM'` via `date.slice(0, 7)` — no Date
  construction, lexicographic order is chronological order, month labels come
  from a fixed lookup (no locale).
- **Drafts and voids count nothing** — `posted` is the single counting status,
  so voiding a posted transaction removes it from cash flow at the next render
  with no reversal record.
- **Dense months** — the table runs from the earliest to the latest
  posted-cash month; a gap month renders as a zero row (a cumulative curve
  with holes would misstate timing).
- **Unallocated cash is reported, never netted** — *Unallocated Cash In/Out —
  on account* reuse the existing `receiptSummary()`/`paymentSummary()`
  derivations; unallocated money reduces no invoice balance and is never
  auto-applied.
- **Gross stays separate from ex-GST** — the page's *Commercial context* panel
  (Current Contract Sum, Forecast Revenue, Forecast Final Cost, Forecast Gross
  Profit, Forecast Margin %, via the same shared `lib/margin.js` composition)
  is labelled **accrual, ex-GST** and is never added to, plotted against, or
  netted with a cash figure.
- **One currency** — everything displays in the project currency; there is no
  FX and nothing is ever summed across currencies.

**Deferred (the next branch):** **Cash Flow visualisation** — charts and
date-range filtering — and **invoice retiming** (see below). Also not modelled:
retention release, GST/BAS cash flows, opening-balance input, bank
feeds/reconciliation, financing, scenarios, exports.

### Cash Flow — Forecast *(implemented — foundation)*

Two further read-time layers project forward from the actual foundation. The
only stored data is the authored `cashFlowLines` collection (see
[DATA_MODEL.md](DATA_MODEL.md)); every projected figure is derived on render in
`lib/cashFlow.js`. Rationale: ADR-25.

> **⚠️ THE BOUNDARY RULE.** **Months strictly before the current month are
> ACTUAL ONLY.** No forecast amount — automatic or manual — ever lands in a past
> month. This is what makes actual-versus-forecast *provably* non-double-
> counting: for any past month the forecast contribution is structurally zero,
> so an actual and the forecast it fulfilled can never both be counted.

**Layer 2 — automatic, near-term (open invoice balances by due date):**

```
Forecast Cash In (M)  += Σ remaining of ISSUED client invoices   (GROSS, inc. GST)
                          where remaining > 0 and dueDate month = M ≥ current month
Forecast Cash Out (M) += Σ remaining of POSTED supplier invoices (payableTotal,
                          already net of retention AND of posted supplier
                          credit notes)
                          where remaining > 0 and dueDate month = M ≥ current month
```

Both reuse the existing reconciliation rows (`clientInvoiceReconciliationRows` /
`supplierInvoiceReconciliationRows`) — no balance is re-derived, so a posted
credit note reduces expected cash out automatically. Classification:

- **Fully reconciled** (zero remaining) contributes nothing and leaves the
  forecast entirely; **partly reconciled** forecasts only its remainder.
- **Over-reconciled** (negative remaining) is **excluded from every month** and
  reported as a signed callout — a credit position must never offset a genuine
  expected receipt or payment.
- **Past due** (`due month < current month`) is **not timed into any month** —
  past months are actual-only, and inventing a recovery date would be false
  precision. It waits in *Past due — expected recovery/payment not retimed*.
- **No due date** waits in *Untimed AR/AP — no due date*.
- ⚠️ The test is **MONTH-level, not day-level**: an invoice due earlier in the
  *current* month is still automatically timed into the current month.
- Voiding a receipt or payment restores the balance at the next render, and it
  re-enters the forecast — no reversal record.

**Layer 3 — manual, longer-term (`cashFlowLines`):** authored monthly timing of
what invoices cannot yet show. Each line stores an expected **gross** `amount`
(the only cash figure) and, separately, the **ex-GST `sourceAmountExGst`** it
represents (coverage only). Allowed sources:

| Direction | Sources |
|---|---|
| **In** | `contract_revenue` (Remaining Uninvoiced Contract Value) · `manual` |
| **Out** | `uninvoiced_claim` · `remaining_committed` · `uncommitted_ctc` · `manual` |

**`client_invoice` and `supplier_invoice` are deliberately excluded** — those
balances are already timed automatically, so a manual line would double-count
them. Approved **client** variations are already inside the Current Contract Sum
and are therefore never a separate source (a line may name one in `sourceRef` as
a label only). Approved **supplier** variations are never in Forecast Final Cost
(ADR-19), so their expected cost reaches Cash Flow only through Uncommitted Cost
to Complete on the Forecast tab.

**Monthly formulas (gross; every accumulation through `roundMoney`):**

```
Forecast Cash In (M)  = 0 for M < current month, else layer 2 + layer 3 in-lines
Forecast Cash Out (M) = 0 for M < current month, else layer 2 + layer 3 out-lines
Total Cash In (M)     = Actual Cash In (M)  + Forecast Cash In (M)
Total Cash Out (M)    = Actual Cash Out (M) + Forecast Cash Out (M)
Monthly Net (M)       = Total Cash In (M) − Total Cash Out (M)
Cumulative Position   = 0 + running Σ Monthly Net        (zero opening position)
Projected Closing Position = cumulative position of the last month in range
```

The month range is dense across the union of actual months, automatic forecast
months, counted manual-line months, and the current month.

**Source coverage and completeness (ex-GST — never a cash figure):**

```
Revenue coverage % = Σ contract_revenue coverage ÷ Remaining Uninvoiced Contract Value
Cost coverage %    = ( remaining_committed + uninvoiced_claim + uncommitted_ctc coverage )
                     ÷ D_cost
D_cost             = Remaining Committed + Uncommitted Cost to Complete
                   ( ≡ Cost to Complete — the figure the Forecast tab publishes )
```

> **⚠️ Approved-claim cost sits INSIDE Remaining Committed.** An approved claim
> consumes PO commitment, and Remaining Committed subtracts only **posted
> invoicing** — so `uninvoiced_claim` coverage counts against the **same
> cost-code committed balance** as `remaining_committed`, and is **never** an
> additive second denominator or an additional untimed cost total. It is shown
> only as a labelled breakdown: *"Approved claim awaiting invoice — included
> within Remaining Committed."*

```
Untimed Remaining Committed = max(0, Remaining Committed
                                     − coverage('remaining_committed')
                                     − coverage('uninvoiced_claim'))
Untimed Uncommitted CTC     = max(0, Uncommitted CTC − coverage('uncommitted_ctc'))
Untimed Uninvoiced Contract = max(0, max(0, Available to Invoice)
                                     − coverage('contract_revenue'))
```

Disjointness from layer 2 is structural: Remaining Committed is already net of
posted invoicing, `uninvoiced_claim` excludes claims superseded by a posted
invoice, Uncommitted CTC is by definition outside Actual and Remaining
Committed, and Available to Invoice is already net of issued invoices.

Coverage percentages are **`null`** — displayed **"—"**, never a false 0% or
100% — when the basis is unavailable: no commercial baseline, a fully or
over-invoiced contract, no remaining cost, or a failed source read. When cost
codes remain unforecast, the percentage is shown **with** an explicit
*incomplete basis* warning. Completeness states: **Complete** (full coverage,
no untimed AR/AP, complete basis) · **Partially timed** · **Incomplete
forecast** · **Unavailable**.

**Untimed reporting uses three separate bases and never sums them:**

| Basis | Contents |
|---|---|
| **Gross cash** | AR/AP with no due date · past-due AR/AP not retimed · retention withheld |
| **Ex-GST source value** | untimed uninvoiced contract value · untimed Remaining Committed (with the approved-claim breakdown *within* it) · untimed Uncommitted CTC |
| **Exposure — context only** | approved/pending supplier variations · pending client variations |

**Peak funding:**

```
Peak Funding Requirement = |lowest negative projected cumulative position|
Month of Peak Funding    = the EARLIEST month achieving that trough
```

The **headline is suppressed** whenever significant amounts remain untimed or a
basis is unavailable — untimed cost makes the trough shallower than reality, so
an unqualified figure would **understate** the funding need. When suppressed,
the computed value appears only as a labelled **lower bound** with the specific
unmet conditions listed. Suppression triggers: untimed remaining revenue, untimed
committed cost, untimed uncommitted CTC, AR/AP with no due date, past-due AR/AP
not retimed, revenue basis unavailable, cost basis unavailable, cost basis
incomplete.

**Retention withheld and unallocated cash WARN prominently but never suppress.**
Retention release is not modellable at all, so suppressing on it would disable
peak funding permanently on any project that withholds retention; unallocated
cash is already correctly counted in actuals and only creates a *risk* that
invoice balances overstate future movement. The peak-funding presentation states
explicitly that **retention release and GST/BAS cash movement are excluded**.
Neither is ever silently netted — the remedy in both cases is an explicit manual
timing line.

**Stale lines and the no-past-month rule.** Creating a line in a past month, or
editing/retiming one into the past, is **blocked in the client** (Firestore
rules validate the `'YYYY-MM'` shape but have no calendar — see
[SECURITY.md](SECURITY.md)). An existing line becomes **stale** naturally as the
calendar advances past its month: it then contributes to no month, no cumulative
figure, and no peak-funding calculation, and surfaces in a stale panel where it
can be **retimed forward or voided with a reason**. Nothing is ever silently
moved, replaced, or deleted — a line stranded in a past month is real signal.

**Lifecycle.** `active → active` (edit) and `active → void` (terminal,
non-whitespace reason), both **rules-enforced**; delete blocked. There is
deliberately **no posted status, no approval, no period locking, and no
immutable snapshot** — an active line remains editable after being reported,
which SECURITY.md records as *not enforced*.

**Over-coverage is warned with an explicit acknowledgement, never blocked** —
Firestore rules cannot sum sibling lines, so several lines can together claim
more coverage than a source holds and two users can time the same balance
concurrently.

**Currency.** A timing line is monetary data: creating one engages the project
currency ratchet **in the same transaction** (ADR-21), and voided lines remain
lock evidence. Amounts display in the project currency; there is no FX.

**Deferred:** charts and date filtering · **invoice retiming** (reserved
`client_invoice`/`supplier_invoice` source types, letting a past-due balance be
moved to a future month) · scenarios · authored opening balance · financing ·
retention-release modelling · GST/BAS forecasting · bank and accounting
integrations · exports.

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
  or cash received. Client Invoices / Accounts Receivable now exist (see above) and
  report **Issued Client Invoices** separately on the Commercial tab's Client Invoices
  view — margin is deliberately **not** affected by invoicing, and there is still **no
  cash figure**, because Payments and Receipts are not implemented.

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

**Currency.** Margin values are **ex-GST** and display in the **project's**
currency. The baseline stores no `currency` field and needs none — it inherits the
project currency like every other figure (and an established baseline is itself
monetary data, so it locks that currency). No FX conversion is performed or
planned. Tax remains Australian GST regardless of currency (see *Currency & tax*).

**Lifecycle.** The baseline is a **living, editable input** — no draft/approved
status, no snapshots, no approval workflow, and Original-Approved-Budget immutability
is **not** claimed (it cannot be enforced without a trusted backend). Reads/writes are
restricted to internal financial roles; the baseline **never** mutates Projects,
Budget Lines, POs, claims, supplier invoices, variations, or forecast lines.

**Deferred:** Cash Flow, Payments and Receipts, retention modelling, monthly
periods, immutable snapshots, approval workflow, probability weighting, and any
manual/probability-weighted revenue forecast override. (Client Invoices and
Accounts Receivable have since shipped — see the Client Invoice Lifecycle above.
They report invoiced value alongside margin and do **not** feed it.)

### Final Account *(planned)*

The closing reconciliation: approved budget + approved variations vs actual cost,
resolving to the **final project margin**. Commercial reporting summarises margin,
cost-to-complete, cash flow, and the final account.

## Future Integrations

- **Supplier Payments** — *implemented; see the Supplier Payments section above.*
  Retention release remains unmodelled.
- **Credit Notes** — *supplier side implemented; see the Supplier Credit Notes
  section above* (its own `supplierCreditNotes` collection, ADR-31). The
  `docType: 'credit_note'` / `adjustsInvoiceId` fields reserved on both invoice
  collections are **superseded and stay reserved, never activated**; client
  credit notes remain future work.
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
