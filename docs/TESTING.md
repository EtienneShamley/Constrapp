# Testing

**Two automated suites exist and are deliberately separate:**

- **§0 — Firestore Security Rules tests** (`npm run test:rules`) — emulator-only.
- **§0b — Unit tests for pure `lib/` domain logic** (`npm run test:unit`) — plain
  Node, no Firebase, no emulator. Currently covers the Cash Flow arithmetic
  (`lib/cashFlow.js`) and the Cash Flow chart presentation transform
  (`lib/cashFlowChart.js`); the remaining pure `lib/` modules
  (`purchaseOrders.js`, `progressClaims.js`, `clientInvoices.js`, …) are the
  natural next targets.

Everything else is manual, and there is no CI. Verify application changes with
the manual acceptance tests below, run against a dev Firebase project with the
current rules published.

## 0. Firestore Security Rules — automated (emulator)

The only automated tests in the repo. They load `frontend/firestore.rules`
verbatim and exercise it against the **Firestore emulator** — never a real
project (the suite throws if `FIRESTORE_EMULATOR_HOST` is unset).

```bash
cd frontend
npm run test:rules
```

That script runs
`firebase emulators:exec --only firestore --project constrapp-rules-test "vitest run --config vitest.rules.config.js"`.

- **Requires a JDK.** `firebase-tools` is pinned to `^13` because v14+ requires
  **JDK 21**, while the Firestore emulator under v13 runs on **JDK 17**. If you
  upgrade `firebase-tools`, you must also install JDK 21+.
- Config: `frontend/firebase.json` (emulator + rules pointer only — no hosting,
  no functions, and **no `.firebaserc`**, so nothing can be deployed).
- Tests — **207 in total across 5 files**:
  - `frontend/tests/rules/users.rules.test.js` — **26 tests** covering the
    `users/{uid}` membership document (ADR-27): own-profile read succeeds;
    same-company, cross-company, unauthenticated and `company_admin` reads of
    **another** profile are denied; every update is denied (`role`
    self-promotion, any role-to-role change, `companyId` change, the two
    combined, a role change smuggled alongside a harmless field, `name`-only,
    `avatarInitials`-only, `email`-only, an arbitrary `isSuperAdmin` field, a
    `companyIds` field, an identical-data rewrite, and another user's
    document); every create is denied (own missing profile, elevated role,
    cross-company, another user's document); both deletes are denied. Three
    **non-regression** tests prove membership authorisation still works — a
    seeded `company_admin` still passes a role-authorised financial write, a
    seeded `subcontractor` still fails it, and an authenticated user with **no**
    membership document is denied company-scoped access. That trio is what
    demonstrates rules-internal `get()` **bypasses** Security Rules, so
    tightening this block cannot break the other ~40 lookups.
    Unlike the suites below it constrains **no timestamp field**, so the
    skewed-clock rule in the note further down does not apply to it.
  - `frontend/tests/rules/clientInvoices.rules.test.js` — **30 tests** covering
    every case in §15i-x below.
  - `frontend/tests/rules/clientReceipts.rules.test.js` — **46 tests** covering
    every case in §15j-x below, including the whole-cent scalar-invariant cases.
  - `frontend/tests/rules/supplierPayments.rules.test.js` — **47 tests** covering
    every case in §15k-x below, including the whole-cent scalar-invariant cases.
  - `frontend/tests/rules/cashFlowLines.rules.test.js` — **58 tests** covering
    every case in §15m-x below. It also asserts the two documented
    **client-only** gaps: a PAST `monthKey` and an unknown `sourceType` of valid
    shape are both ACCEPTED by rules.
  - All five run for `company_admin`, `project_manager`, `qs`, `subcontractor`,
    `client`, an unauthenticated caller, and a financial-role user in a **second
    company**. The users suite adds a sixth identity: an authenticated caller
    with **no** `users/{uid}` document at all (the orphan case).
- **Run this before publishing any rules change** (see
  [DEPLOYMENT.md](DEPLOYMENT.md)).

> **Timestamp assertions must use a deterministic client clock — never
> `Timestamp.now()`.** Where the rules require a stamp to equal `request.time`, a
> test proving that a *client-authored* value is rejected must supply a clock
> value that cannot coincide with server time. A bare `Timestamp.now()` is read
> microseconds before the write reaches the emulator and can legitimately equal
> `request.time`, in which case the rule correctly **accepts** it and
> `assertFails` fails — a non-deterministic test, not a rules defect. (This was
> real: the Client Invoice suite previously failed intermittently for exactly
> this reason — measured at 30/30, then 3 failures, then 2 failures across three
> runs.) **Both suites now assert against deliberately skewed clocks** — a clock
> 60s ahead, a clock 60s behind, and a fixed `2020-01-01` value — applied to
> every timestamp field the rules constrain. Keep any new timestamp assertion to
> that pattern. `Timestamp.now()` remains correct inside `seed()` helpers, which
> write **stored state** with rules disabled and assert nothing.

§15i-x, §15j-x, and §15k-x below remain the human-readable specification of what
those tests assert; the other manual sections are not automated. The users suite
is self-describing and has no manual counterpart — `users/{uid}` has no UI, so
there is nothing to click through: the rules ARE the feature.

## 0b. Unit tests — pure `lib/` domain logic (no emulator)

The second automated suite. Plain Node — no React, no Firebase, no emulator, no
JDK. Discovered only from `frontend/tests/unit/` via a dedicated config
(`frontend/vitest.config.js`), so it can never bleed into the rules suite (and
vice versa — `vitest.rules.config.js` discovers only `tests/rules/`).

```bash
cd frontend
npm run test:unit
```

- `frontend/tests/unit/cashFlow.test.js` — **130 tests** over `lib/cashFlow.js`
  and the cash-row adapters (`lib/clientReceipts.js → cashInRows()`,
  `lib/supplierPayments.js → cashOutRows()`): month-key validation and labels,
  lexicographic ordering, dense ranges across the December–January boundary,
  receiptDate/paymentDate grouping (never `createdAt`/`postedAt`), posted-only
  counting (drafts and voids excluded, including a posted-then-voided payment),
  full-amount counting of unallocated cash (`allocatedTotal` never the cash
  figure), zero-filled gap months, cumulative-from-zero arithmetic including
  negative and recovery sequences, whole-cent rounding (`0.10 + 0.20 = 0.30`;
  100 × `0.01` = `1.00`), and input purity (frozen inputs never mutated).
  Since the Forecast branch it additionally covers the source-type vocabulary,
  automatic AR/AP classification (due-month timing, month-level past-due,
  no-due-date, partial and over-reconciliation), manual lines, stale-line
  behaviour as the month advances, the actual/forecast boundary, combined
  monthly rows and projected cumulative/closing position, source coverage and
  the **corrected** committed/claim model, untimed values, completeness states,
  peak funding and each suppression trigger, the GST suggestion, draft
  validation including the **no-past-month rule**, and forecast rounding.

- `frontend/tests/unit/cashFlowChart.test.js` — **43 tests** over
  `lib/cashFlowChart.js`, the Cash Flow chart's **presentation transform**.
  Covers the display-only cash-out negation (and that zero never becomes
  IEEE-754 `-0`), cash out reading **positive** in the tooltip while plotting
  negative, the **unavailable-vs-zero rule** (a past month's forecast and any
  figure a failed source made unavailable become `null`, never `0` — Recharts
  skips a null and draws a zero), `forecastUnavailable` leaving historical
  actuals intact while nulling unpublishable forecast, total, net and cumulative
  values, actual/forecast boundary location (all-past, all-future, and a dataset
  with **no** current-month row), **peak-marker eligibility** (authoritative
  negative → marker; suppressed, non-negative, or forecast-unavailable → **no**
  marker, and no lower-bound marker), layout width, input **purity** (the
  financial rows are never mutated), and the textual summary degrading honestly
  in each state.

  ⚠️ It deliberately does **not** retest Cash Flow arithmetic — cumulative
  position, peak-funding maths, reconciliation, completeness and the
  month-boundary rules have exactly one home, `cashFlow.test.js` above.
  The chart component itself is **not** unit-tested: that would require jsdom
  and testing-library, and the transform boundary above is what makes the
  honesty rules testable without them (ADR-26). Chart *rendering* is verified
  manually in §15n.

  Combined unit total: **173 tests** across both files.

Setup: two provisioned users in the same company (e.g. a `project_manager` and a
`qs`), signed in via `/login`. Reset state between suites by using a fresh
project.

## 1. Authentication & Membership

- [ ] Visiting `/` signed out redirects to `/login`; visiting `/login` signed in redirects to `/`.
- [ ] Wrong password shows a friendly error, not a crash.
- [ ] After sign-in: sidebar/topbar show profile name, role label, and company name from Firestore (not just the Auth email).
- [ ] `/create-account` and `/forgot-password` show "coming soon" stubs with a working back link.
- [ ] Sign out from the topbar menu returns to `/login`.
- [ ] A user whose `users/{uid}` doc has a different `companyId` sees none of this company's data.

## 2. Projects

- [ ] Projects page lists projects newest-first; empty state prompts creation.
- [ ] Create a project with name/status/budget/start date/location/progress → appears immediately (live snapshot), correct badge colour, formatted AUD budget and date.
- [ ] Project name is required; budget/progress inputs reject negatives (progress clamps 0–100).
- [ ] Open a project → lands on `/projects/{id}/overview` showing budget, start date, progress bar.
- [ ] Unknown project ID shows "Project not found."; unmatched routes redirect to `/projects`.
- [ ] BOQ/Documents/Photos/Timeline/Reports tabs show placeholder cards, no data wiring (Variations — see §14 — Forecast — see §15 — and Commercial — see §15g — are now live).

## 3. Cost Codes

- [ ] Cost Codes tab (within a project) lists company-wide codes ordered by code.
- [ ] Create one (code + name required; category/unit optional) → appears in **every** project's Cost Codes tab and in PO/budget-line dropdowns.
- [ ] New codes are created `isActive: true`; there is no delete action.

## 3a. Contacts

- [ ] `/contacts` lists contacts ordered by display name; empty state prompts creation.
- [ ] Create an **organisation**: legal name required; trading name optional; display name in the list is trading name when set, else legal name.
- [ ] Create an **individual**: first and last name both required; display name is "First Last".
- [ ] At least one contact type must be ticked; multiple types show multiple badges.
- [ ] ABN: an invalid 11-digit Australian ABN (e.g. `12 345 678 901`) shows a red inline error and blocks saving; a valid one (e.g. `51 824 753 556`) saves and displays formatted `XX XXX XXX XXX`.
- [ ] With country ≠ Australia, ABN checksum is not enforced.
- [ ] Duplicate warnings: entering an ABN, email, or name matching an existing contact shows an amber "possible duplicates" panel but still allows saving.
- [ ] Contact people (organisations only): add/remove people; the primary radio sets exactly one primary; the primary person shows in the list; unnamed person rows are dropped on save.
- [ ] Edit preserves all fields; contact kind (organisation/individual) is locked when editing.
- [ ] Archive (with confirm) hides the contact from the default Active filter and from the PO supplier picker; Reactivate restores it. There is no delete action.
- [ ] Search matches name, ABN, email, and people; type and active/archived filters combine with search.
- [ ] Signed in as a `subcontractor` or `client` role user, `/contacts` shows no contact data (reads are blocked by rules).

## 3b. Subcontractors View

- [ ] `/subcontractors` lists only active contacts whose types include Subcontractor; records edited on `/contacts` update here live.
- [ ] The Constrapp IQ™ "Coming Soon" card still renders below the list.
- [ ] "Manage in Contacts" navigates to `/contacts`.

## 3c. Contact Project Assignments

- [ ] Contact create/edit forms show a **Projects** checkbox list of the company's projects; zero, one, or many can be ticked; with no projects yet an explanatory note shows instead.
- [ ] Assigning projects and saving shows the project names in the contact list's **Projects** column; unassigned contacts show "—".
- [ ] The **project filter** on `/contacts` narrows to contacts assigned to the chosen project; **Unassigned** shows only contacts with no assignments; both combine with search/type/status filters.
- [ ] Unticking a project and saving removes the assignment; the contact's other fields are untouched.
- [ ] Editing an **archived** contact: existing assignments stay ticked and can be unticked, but unassigned projects are disabled ("can't be assigned to new projects" note shows).
- [ ] A contact created before this feature (no `projectAssignments`/`projectIds` fields) opens, edits, and saves normally, appearing as unassigned — no migration required.
- [ ] Project assignment changes never modify any existing PO or progress claim (spot-check a PO raised for that contact before and after unassigning).

## 3d. PO Supplier Picker Grouping

- [ ] In a project with at least one assigned supplier/subcontractor contact, the new-PO supplier picker shows a **"This project"** group first and, when other eligible contacts exist, an **"Other company contacts"** group after it.
- [ ] Contacts in **both** groups can be selected and the PO saves normally either way.
- [ ] Selecting a contact from "Other company contacts" does **not** assign it to the project (check the contact on `/contacts` afterwards).
- [ ] In a project with **no** assigned contacts, the picker shows a flat ungrouped list (no empty "This project" group).
- [ ] Quick-create ("+ New") from a PO creates the contact, auto-selects it, **and** assigns it to the current project — it appears under "This project" on the next PO and carries the project on `/contacts`.
- [ ] Archived contacts appear in neither group.

## 4. Budget Lines

- [ ] With zero cost codes: Budget tab disables "Add Budget Line" and links to Cost Codes.
- [ ] Create a line (cost code + budgeted) → row shows Budgeted, zeros/— elsewhere, Remaining = Budgeted.
- [ ] Summary card shows Budgeted / Committed / Claimed / Actual / Remaining totals and a usage bar.

## 5. Purchase Orders

- [ ] With zero cost codes: PO tab disables creation and links to Cost Codes.
- [ ] Create a draft PO: supplier is picked from active supplier/subcontractor contacts (required); every line needs a cost code; line total = qty × rate; footer shows Subtotal, GST 10%, Total.
- [ ] "+ New" beside the supplier picker quick-creates a minimal contact (name + type) and auto-selects it; the contact then appears on `/contacts`.
- [ ] The created PO stores `supplierId` and shows the contact's display name; renaming the contact afterwards does **not** change the PO's supplier name.
- [ ] POs created before the Contacts module (`supplierId: null`) still display their free-text supplier name.
- [ ] PO number is sequential company-wide (`PO-0001`, `PO-0002`, …) even when two users create simultaneously.
- [ ] Draft badge shown; draft can be **Sent** or **Cancelled** (with confirm dialog).
- [ ] Sent PO: no edit path; can be **Closed** or **Cancelled**; Closed/Cancelled show no further actions.

## 6. PO Cancellation Removes Committed Cost

- [ ] Send a PO against a budgeted cost code → Budget tab Committed equals the PO's ex-GST line total.
- [ ] Cancel that PO → Committed returns to previous value immediately, without editing the budget line.
- [ ] Send a PO against a cost code with **no** budget line → amber "Committed via PO — no budget line" warning row appears; cancel → row disappears.

## 7. Progress Claim Creation

- [ ] With no sent POs: claims tab disables creation and links to Purchase Orders.
- [ ] New claim: only **sent** POs (without an open claim) appear in the selector.
- [ ] Selecting a PO lists its lines with "of {PO line total}" and pre-filled claimed-to-date; totals footer shows Claimed this period, Retention, GST 10%, Total payable.
- [ ] Retention: entering more than the subtotal clamps to subtotal; GST is 10% of (subtotal − retention).
- [ ] A claim with all lines at zero this period cannot be created.
- [ ] Claim numbers are sequential company-wide (`PC-0001`, …).

## 8. Cumulative Claiming

- [ ] Approve a claim on a PO, then start a second claim on the same PO: each line pre-fills at its approved-to-date value.
- [ ] Entering claimed-to-date **below** previously approved shows "Below approved" in red and blocks creation.
- [ ] `+this period` amount always equals claimed-to-date − previously approved.

## 9. One-Open-Claim Behaviour

- [ ] While a PO has a draft/submitted claim, it disappears from the new-claim selector.
- [ ] After that claim is approved or rejected/withdrawn, the PO becomes claimable again.

## 10. Overclaim Warnings

- [ ] Claimed-to-date above the PO line total shows the amber ⚠ marker but still allows creation (warned, not blocked).

## 11. Approval Validation

- [ ] Assess modal pre-fills certified amounts with claimed amounts.
- [ ] Certified amount negative, non-numeric, or above claimed-this-period → red field + inline error, Approve disabled.
- [ ] Rejecting asks for confirmation; rejected claim shows a red badge and no further actions.

## 12. Partial Approval

- [ ] Certify less than claimed on one line + assessment note → claim approved; Approved (inc. GST) column shows the certified total, less than claimed.
- [ ] The next claim on that PO pre-fills previously-approved with the **certified** (not claimed) amounts.

## 13. Budget Financial Rollups

- [ ] Committed = sum of sent+closed PO lines per cost code; unaffected by claims.
- [ ] Submit a claim → Claimed rises by claimed-this-period; Actual unchanged.
- [ ] Approve it → Claimed falls back; Actual rises by the certified amount; Remaining = Budgeted − Actual; usage bar tracks Actual ÷ Budgeted (red at 100%+).
- [ ] Reject a submitted claim → Claimed falls; Actual unchanged.
- [ ] Closing a PO keeps its value in Committed.

## 13a. Supplier Invoices — Direct PO

- [ ] Invoices tab sits after Progress Claims. With no sent/closed PO, creation is disabled and links to Purchase Orders.
- [ ] New Supplier Invoice → **Direct against PO**: only sent/closed POs are selectable; lines seed from the PO lines with fixed cost codes; enter an amount per line (zero allowed on unused lines).
- [ ] Supplier and PO snapshot show above the lines; supplier invoice number and invoice date are required.
- [ ] Per-line tax code (GST / GST-free / input-taxed) is selectable; the footer shows ex-GST subtotal, GST, and payable total; a GST-free line contributes no GST.
- [ ] Due date auto-fills from the supplier contact's payment terms when set, and stays editable; editing it stops further auto-fill.
- [ ] `SI-0001`, `SI-0002`… numbering is sequential company-wide even across two simultaneous creators.
- [ ] Entering an amount that pushes invoiced-to-date above a PO line (or the PO total) shows an amber ⚠ but still allows creation.
- [ ] Re-using the same supplier invoice number for the same supplier shows an amber duplicate warning but does not block.

## 13b. Supplier Invoices — From Approved Claim

- [ ] **From approved claim**: only approved progress claims with no active (non-cancelled) invoice are selectable.
- [ ] Lines seed from the claim's certified amounts and are **read-only** (cannot invoice more or less than the approved claim); retention is carried from the claim and read-only.
- [ ] PO and claim references are populated from the claim snapshot; supplier is the claim's supplier snapshot.
- [ ] Once an invoice exists for a claim, that claim disappears from the selector; cancelling the invoice makes it selectable again.
- [ ] The invoice's **Net payable** equals the approved claim's total payable (inc. GST); the footer additionally shows the higher **Gross invoice total** and the **Retention withheld** (ex-GST + its GST). If the figures don't reconcile, creation is blocked with a clear red error.

## 13c. Retention & GST Representation (reconciliation)

The invoice footer/list distinguish the full taxable supply (**Gross**) from the
amount due after retention (**Net payable**) — net payable is never labelled as
the full tax-invoice value.

- [ ] **Example A — claim with retention.** Certified subtotal 1,000 ex-GST,
  retention 100 (all GST lines). Expect: Subtotal 1,000 · GST 100 · Gross 1,100 ·
  Retention withheld 110 (ex-GST 100 + GST 10) · **Net payable 990**. The Net
  payable (990) and its GST (90) match the approved claim's `approvedTotal` /
  `approvedGst`.
- [ ] **Example B — direct invoice, no retention.** Lines 1,000 ex-GST, retention
  0. Expect: Subtotal 1,000 · GST 100 · Gross 1,100 · Retention — · **Net payable
  1,100** (Gross = Net payable when retention is 0).
- [ ] Budget **Invoiced/Actual** for both examples rise by the ex-GST line total
  (1,000), unaffected by GST or retention.

## 13d. Supplier Invoice Lifecycle & Budget Effects

- [ ] Draft invoice can be **Approved** or **Cancelled**; an approved invoice can be **Posted** or **Cancelled**; a posted invoice shows **no further actions** (no cancel/unpost, no manual Paid).
- [ ] Search matches internal number, supplier invoice number, supplier, and PO; status and supplier filters combine with search.
- [ ] An invoice with a past due date (not paid/cancelled) shows an **Overdue** indicator in the Due column.
- [ ] **Direct invoice, budget effect:** post a direct invoice against a budgeted cost code → Budget **Invoiced** rises by the ex-GST line total, **Committed** for that PO line drops by the same amount (remaining open commitment), **Actual** rises, **Remaining** falls. Nothing is written to the budget line document.
- [ ] **Claim-sourced invoice, no double-count:** approve a progress claim (Actual reflects it) → create + **post** an invoice from it → Actual is unchanged in total (the posted invoice replaces the claim; the claim is not mutated and its status stays `approved`), and Invoiced now reflects the invoice.
- [ ] Posting invoices beyond a PO's value drives that PO line's Committed to zero (never negative).
- [ ] Signed in as a `subcontractor` or `client` role user, the Invoices tab shows no data (reads are blocked by rules).

## 14. Variations

### 14a. Client Variation

- [ ] Variations tab is live (not a placeholder). Summary cards show Approved Supplier Variations, Pending Supplier Exposure, Approved Client Variations, Pending Client Exposure, and Open Variations; a note explains figures are ex-GST, approved-only, and do not yet mature against claims/invoices.
- [ ] New Variation → choose **Client Variation**; help text reads "Head Contract Variation". Only client-type contacts appear in the Client picker; there is **no** quick-create.
- [ ] Title is required; add cost-coded lines (each line requires a cost code); enter an amount and pick a tax code per line. Footer shows submitted subtotal, GST, total; a GST-free line contributes no GST.
- [ ] Numbering is `CV-0001`, `CV-0002`… sequential company-wide even across two simultaneous creators.
- [ ] Create → status Draft. Approved and pending client totals on the summary cards update after submit/approve.
- [ ] A client variation never changes the Budget tab's Budgeted/Committed/Actual/Invoiced or Commitment Exposure.

### 14b. Supplier Variation — against a PO

- [ ] New Variation → **Supplier Variation** (help text "Subcontract Variation") → **Against a Purchase Order**: only sent/closed POs are selectable; the supplier name is shown locked from the PO snapshot.
- [ ] A line can pick an existing PO line (inherits and **locks** its cost code, prefills description) or "New scope" (requires its own cost code). The PO document is never modified (spot-check the PO before/after).
- [ ] Numbering is `SV-0001`… sequential company-wide.

### 14c. Supplier Variation — no PO

- [ ] **No PO (manual)**: select an active supplier/subcontractor contact; every line requires a cost code entered manually. No synthetic PO is created (check Purchase Orders tab).

### 14d. Lifecycle & assessment

- [ ] Draft can be **Submitted** or **Withdrawn** (withdraw confirms). Submitted content is locked; actions are **Assess** or **Withdraw**.
- [ ] Assess prefills each approved amount from its submitted amount. Approved amounts accept values above, below, equal, zero, and **negative**. Approved GST/total recalculate live.
- [ ] Changing any approved amount away from its submitted value makes **Assessment Notes required** — Approve is blocked with a clear message until notes are entered.
- [ ] Approve (confirms) freezes approved amounts; Reject (confirms) and Withdraw are terminal and show no further actions. No delete action exists anywhere.

### 14e. Negatives, duplicates, filters

- [ ] A negative-amount supplier variation approved against a budgeted cost code **reduces** Approved Supplier Variations and Commitment Exposure (not clamped to zero).
- [ ] Re-using the same external reference for the same counterparty shows an amber possible-duplicate warning but does **not** block.
- [ ] All / Client / Supplier sub-tabs filter the list; search matches variation number, title, description, counterparty, client/supplier ref, and PO number; status, counterparty, and cost-code filters combine with search.
- [ ] Signed in as a `subcontractor` or `client` role user, the Variations tab shows no data (reads are blocked by rules).

### 14f. Budget-page integration

- [ ] Budget summary still shows the six canonical figures unchanged. Below them, **Approved Supplier Variations** and **Commitment Exposure** appear separately, with helper text stating Commitment Exposure = Committed + approved supplier variations and that variation amounts do not yet mature against claims/invoices.
- [ ] The Budget table has an **Appr. Supplier Var.** column showing approved supplier variation amounts by cost code; a variation on a cost code with no budget line surfaces as an amber warning row.
- [ ] Approving/withdrawing a supplier variation changes Commitment Exposure but leaves the canonical Committed figure untouched.

## 15. Forecast Cost to Complete

Sign in as a financial-role user (`company_admin`/`project_manager`/`qs`).

### 15a. Page, tab, and summary

- [ ] The project tab reads **Forecast** (not "Forecasting"); opening it shows a real page (no placeholder card).
- [ ] Core summary cards show **Approved Budget, Actual, Remaining Committed, Forecast Final Cost, Variance to Budget**, with helper text "Estimate at Completion (EAC)" under Forecast Final Cost and "Variance at Completion (VAC)" under Variance to Budget.
- [ ] Separate **Approved Supplier Variation Exposure** and **Pending Supplier Variation Exposure** cards appear with the note that they are shown separately, may overlap Actual/manual cost, and are **not** added to Forecast Final Cost.
- [ ] With no forecast inputs, every relevant cost code shows **Not forecast**, and the header shows "N of M cost codes not yet forecast."

### 15b. Cost-code union & unbudgeted rows

- [ ] The table lists every cost code appearing in budget lines, sent/closed POs, Actual, posted invoices, supplier variations, or existing forecast lines — even one with only a PO, only Actual, only a variation, or only a forecast line.
- [ ] A cost code with commitment/actual/variation but **no budget line** shows an amber row and a "no budget line" note, with Budgeted, Remaining Budget Reference, and Variance shown as "—".
- [ ] An **inactive** cost code that still has activity remains listed (marked "Inactive cost code"), not hidden.

### 15c. The single manual input & live calculations

- [ ] **Uncommitted Cost to Complete** is the only editable money field; Actual, Remaining Committed, variation exposure, Cost to Complete, Forecast Final Cost, and Variance are read-only.
- [ ] Entering a value updates **Cost to Complete** (= Remaining Committed + Uncommitted CTC), **Forecast Final Cost** (= Actual + Remaining Committed + Uncommitted CTC), and **Variance to Budget** (= Budgeted − FFC) immediately, before saving.
- [ ] A **blank** input shows "Not forecast"; entering **0** is treated as a completed forecast value (not missing) and clears the "Not forecast" marker.
- [ ] A **negative** value is rejected (red field, Save blocked / errors); non-numeric junk is rejected.
- [ ] Positive Variance renders normally; **negative Variance renders in red** (over budget) on budgeted rows.

### 15d. Remaining Budget suggestion

- [ ] Nothing is prefilled automatically — new rows start blank ("Not forecast").
- [ ] Pressing **"Use remaining budget"** copies the Remaining Budget Reference (`Budgeted − Actual − Remaining Committed`) into Uncommitted CTC when positive, and **0** when the reference is zero or negative; the copied value is then editable.
- [ ] The suggestion never includes supplier variation amounts.

### 15e. Saving & audit

- [ ] Editing a row reveals a **Save** action; a **Save all changes (N)** control saves every dirty row.
- [ ] Save shows progress, blocks negatives, surfaces clear errors, and does not discard other unsaved edits.
- [ ] After a successful save the row shows **Last updated** (date) and **Updated by**, and a "Saved" badge until edited again.
- [ ] Editing does not auto-save on each keypress.
- [ ] Reloading the page preserves saved inputs; a project that never had forecast lines still loads (every cost code "Not forecast").

### 15f. Closed-PO residual, filters, security

- [ ] A **closed** PO that still holds uninvoiced commitment shows an amber "incl. … on closed PO" indicator on Remaining Committed; the amount stays visible (not removed from the forecast).
- [ ] Search matches cost-code code/name; the **Not forecast**, **Forecast over budget**, **Unbudgeted**, and **All** filters work and combine with search.
- [ ] Saving a forecast line never changes any Budget Line, PO, Progress Claim, Supplier Invoice, or Variation (spot-check the Budget tab figures are unchanged).
- [ ] Signed in as a `subcontractor` or `client` role user, the Forecast tab shows no data (reads are blocked by rules).

## 15g. Project Margin (Commercial tab)

Sign in as a financial-role user (`company_admin`/`project_manager`/`qs`).

### 15g-i. Baseline form & missing baseline

- [ ] The project tab **Commercial** opens a real page. With no baseline saved, the margin summary shows "—" for Original Contract Value, Current Contract Sum, Forecast Revenue, Forecast Gross Profit, and Forecast Margin %, an amber prompt to set an Original Contract Value, and the baseline form below.
- [ ] Forecast Final Cost shows a real figure even with no baseline (it is the cost side, shown regardless), matching the Forecast tab's Forecast Final Cost for the same project.
- [ ] **Save** is disabled until a valid Original Contract Value (≥ 0) is entered; a negative or non-numeric value shows a red field and blocks saving.
- [ ] Saving creates the baseline; a "Saved" badge appears and **Last updated** / updated-by show. Reloading preserves the saved values.
- [ ] **Use current approved budget** copies the live Σ budget lines into Original Approved Budget; the value stays editable afterward. Leaving it blank keeps it "not established".

### 15g-ii. Margin maths (exact example)

Set up a project with budget lines totalling **1,000,000** ex-GST, a Forecast Final
Cost of **1,020,000** (via the Forecast tab), one **approved** client variation of
**+50,000** ex-GST, one **pending** (submitted) client variation of **+30,000**, and
one **approved** supplier variation of **+12,000**. On the Commercial tab with
`originalContractValue = 1,000,000` and `originalApprovedBudget = 950,000`:

- [ ] **Current Contract Sum** = 1,050,000 (1,000,000 + 50,000 approved client variation).
- [ ] **Forecast Revenue** = 1,050,000 (= Current Contract Sum).
- [ ] **Forecast Gross Profit** = 30,000 (1,050,000 − 1,020,000).
- [ ] **Forecast Margin %** = 2.9% (30,000 ÷ 1,050,000 × 100 = 2.857…, shown to 1 dp).
- [ ] **Original Planned Profit** = 50,000 (1,000,000 − 950,000).
- [ ] **Original Planned Margin %** = 5.0% (50,000 ÷ 1,000,000 × 100).
- [ ] **Margin Movement** = −20,000 (30,000 − 50,000), shown in red.
- [ ] **Pending Client Variation Exposure** = 30,000, shown separately; it is **not** in Forecast Revenue.
- [ ] **Approved Supplier Variation Exposure** = 12,000 and **Pending Supplier Variation Exposure** are shown separately and are **not** added to Forecast Final Cost.

### 15g-iii. Negative variations, zero & null behaviour

- [ ] A **negative** approved client variation (e.g. −40,000) **reduces** Current Contract Sum (1,000,000 → 960,000); it is not clamped.
- [ ] With `originalContractValue = 0` (and no positive approved client variation), Forecast Revenue ≤ 0 ⇒ **Forecast Margin %** displays **"—"** (no `NaN`/`Infinity`).
- [ ] With **Original Approved Budget blank** (null), **Original Planned Profit**, **Original Planned Margin %**, and **Margin Movement** all display **"—"**.

### 15g-iv. Overview cards, security & no-mutation

- [ ] On the **Overview** tab (financial role, baseline established) a **Commercial** card row shows Current Contract Sum, Forecast Final Cost, Forecast Gross Profit, and Forecast Margin %, matching the Commercial tab (one shared derivation).
- [ ] With no baseline established, the Overview Commercial card row does not appear.
- [ ] Signed in as a `subcontractor` or `client` role user: the **Commercial tab** shows a "restricted" message and **no** contract or margin data (reads blocked by rules), and the **Overview** Commercial cards do not appear.
- [ ] Saving or editing the baseline never changes any Budget Line, PO, Progress Claim, Supplier Invoice, Variation, or Forecast Line (spot-check the Budget and Forecast tabs before/after).
- [ ] No client path can delete the baseline document (delete blocked by rules); editing overwrites in place and preserves `createdAt`/`createdBy`.

## 15h. Company Country & Currency

Setup: a `company_admin`, a `project_manager`, a `qs`, and a `subcontractor`/`client`
in one company; a second company for isolation checks.

### 15h-i. Unconfigured company (backwards compatibility)

- [ ] A company with **no** `countryCode`/`baseCurrency` loads normally and every money
  figure renders exactly as before (`$1,235` style, whole units, no cents) on Projects,
  Dashboard, Budget, POs, Claims, Invoices, Variations, Forecast, and Commercial.
- [ ] A **setup banner** appears above page content: `company_admin` sees a
  "Set country & currency" action; other roles see the passive text with **no** action.
- [ ] Nothing is written to Firestore by merely viewing the banner or the settings page —
  the company document still has no `countryCode`/`baseCurrency` (check the console).

### 15h-ii. Country suggests, user confirms

- [ ] `/settings/company` (sidebar company chip) opens with country **unselected** — there
  is no pre-selection and no inference from browser locale, time zone, or IP.
- [ ] Country **New Zealand** → currency auto-sets to **NZD**; helper text names the
  suggestion. Repeat: **Australia → AUD**, **South Africa → ZAR**, **United States → USD**,
  **United Kingdom → GBP**, **Germany → EUR**.
- [ ] **Save is disabled** until country, currency, **and** the confirmation checkbox are all
  set.
- [ ] **Manual override:** with country NZ, change currency to **USD** → an amber note reads
  "NZD is normal for New Zealand — you have selected USD"; saving is still allowed and USD
  persists after reload.

### 15h-iii. Tax limitation notice

- [ ] Selecting **any country other than Australia** shows the amber tax note: currency
  display is configurable but tax calculations use existing Australian GST rules, and
  country-specific tax configuration is a separate future foundation.
- [ ] Selecting **Australia** shows **no** tax note.
- [ ] With an NZ/ZA/GB/US company configured, a PO footer still reads **"GST 10%"** and the
  GST is 10% of subtotal — the app does **not** claim NZ 15% / ZA 15% / UK 20% / US sales tax.

### 15h-iv. Existing projects are pinned, never floated

- [ ] With existing projects, the settings page lists **every** project with its stored
  currency ("Not set" in amber where absent) and a "will be set to" selector defaulted to the
  chosen company currency.
- [ ] Individual projects can be **overridden** to a different currency before confirming;
  the confirmation text names how many projects will be pinned.
- [ ] The page states explicitly that **no amount is converted**.
- [ ] Save → every listed project now carries an explicit `currency`; **no** `budget`,
  budget line, PO, claim, invoice, variation, or forecast amount changed (spot-check the
  Budget tab totals before and after — identical).
- [ ] **Ordering:** project currencies are written **before** the company document. Simulate a
  failure (e.g. offline mid-save) → the company stays unconfigured and the banner stays up;
  retrying is safe.
- [ ] **Idempotent:** re-opening settings and saving the same choices writes nothing new and
  changes nothing.
- [ ] A project that **already** carries an explicit currency is **not** overwritten unless it
  is deliberately re-pointed while still eligible.

### 15h-v. New project inheritance & override

- [ ] With company base **NZD**, the New Project modal shows a Currency select pre-set to
  **NZD** with "Inherited from your company (NZD)".
- [ ] Entering a **non-zero budget** switches the helper text to the amber warning that the
  currency **locks immediately on creation** — choose it correctly now.
- [ ] The Budget field's label tracks the selected currency, e.g. **"Budget (NZD)"**.
- [ ] Creating with the inherited NZD → project header, Overview budget card, and the
  Projects-list budget cell all show NZD.
- [ ] Creating with an **override** to AUD → that project shows AUD everywhere while sibling
  NZD projects are unaffected.
- [ ] A project created with **budget > 0** is immediately locked; one created with
  **budget = 0** (or blank) is not.

### 15h-vi. Currency locking — each condition alone must lock

Sign in as `company_admin`/`project_manager` and use the **Project currency** card on Overview.
Start each check from a fresh project with **budget 0** and no records.

- [ ] Fresh project → the card shows an **enabled** currency select; changing and saving works
  and re-renders every project page in the new currency.
- [ ] Adding only **cost codes** (company-wide) leaves it **editable** — cost codes never lock.
- [ ] Adding only a **contact** leaves it **editable**.
- [ ] A **forecast row saved blank** (`null`, "Not forecast") leaves it **editable**.
- [ ] An **absent/empty commercial baseline** leaves it **editable**.
- [ ] Each of the following, **alone**, locks the currency (card becomes static text + 🔒 +
  a reason naming the cause): a **non-zero headline budget**; one **budget line**; one
  **draft PO**; one **cancelled PO**; one **progress claim**; one **supplier invoice**; one
  **client variation**; one **supplier variation**; one **forecast input of 0**; one **saved
  commercial baseline**.
- [ ] The locked message explains that changing currency would **relabel amounts without
  converting them** and suggests raising a new project instead.

### 15h-vii. The ratchet (rules-enforced) and its honest limits

- [ ] Once locked, a **direct SDK** write changing `currency` on that project is **rejected by
  rules** (not merely hidden by the UI).
- [ ] A **direct SDK** write setting `currencyLocked` back to `false` is **rejected by rules**.
- [ ] A project holding financial records but with **no** `currencyLocked` flag (created before
  this foundation) gets the flag set the first time a `company_admin`/`project_manager` opens
  its Overview — and the UI shows it as locked **immediately**, from live records, even before
  the flag is written.
- [ ] **Atomicity — the record and the lock commit together.** For each of budget line, PO,
  progress claim, supplier invoice, variation, forecast input, and commercial baseline: create
  the record on an unlocked project and confirm the project is locked **in the same step** —
  there is never a state where the record exists and `currencyLocked` is absent. Simulate a
  failure mid-write (go offline, or use a role whose rules reject the project update) and
  confirm **neither** the record nor the lock is written — the financial record must not
  commit on its own.
- [ ] Creating a **second** record on an already-locked project still succeeds (the lock write
  is skipped, not re-attempted) — verify specifically as a **`qs`** user, whose rule permits
  only `false` → `true` and would reject a redundant re-write.
- [ ] **Known deferred limitation (expected to be bypassable — do not report as enforced):** a
  financial-role user can create monetary data by **direct SDK call**, bypassing the app,
  without setting `currencyLocked`, leaving the currency changeable. Firestore rules cannot
  enumerate random-id subcollections. Within the app this cannot occur (the writes are
  atomic). See SECURITY.md → Deferred Controls 12.

### 15h-viii. Roles & the qs ratchet rule

- [ ] `project_manager`, `qs`, `subcontractor`, and `client` all see `/settings/company` as
  **read-only** ("managed by a Company Admin") with no country/currency controls.
- [ ] A **direct SDK** company-currency write as `project_manager` or `qs` is **rejected by
  rules**.
- [ ] A **direct SDK** write to `companies/{id}.name` as `company_admin` is **rejected by
  rules** (only the four currency fields are writable).
- [ ] `qs` **cannot** change a project currency, name, budget, status, or dates (rules reject).
- [ ] `qs` **can** create a budget line / PO / claim / invoice / variation / forecast input on a
  fresh project, and doing so **succeeds** — the accompanying `currencyLocked` false→true write
  is permitted by the narrow qs ratchet rule and the financial write is not blocked.
- [ ] `qs` attempting a direct SDK write of `{ currencyLocked: true, budget: 999 }` is
  **rejected** (the diff affects more than `currencyLocked`).
- [ ] `subcontractor`/`client` can still **read** Projects and see correctly-labelled Budget,
  PO, and Claim figures in the project currency.

### 15h-ix. Company currency change does not touch existing projects

- [ ] With projects pinned to NZD (some with financial records), change the company base
  currency to **USD** and save → **every existing project still displays NZD**; no amount
  changed; Budget, Forecast, and Commercial figures are identical before and after.
- [ ] The **next new project** defaults to **USD**.
- [ ] Locked projects appear in the settings list as **frozen** (🔒, read-only), not editable.

### 15h-x. Formatting

- [ ] **AUD is unchanged:** an AUD project renders `$1,235` for 1234.56 — whole units, no
  cents, identical to before this foundation.
- [ ] **Non-AUD is unambiguous:** NZD/ZAR/USD/GBP/EUR render with the ISO code
  (`NZD 1,235`), never a bare `$`, so an AUD figure can't be mistaken for an NZD/USD one.
- [ ] **Zero** renders as a formatted zero (`$0` / `NZD 0`), **never** `—` — including a
  forecast input of `0` ("reviewed, no further cost").
- [ ] **null / undefined / NaN / Infinity** render `—`, never `NaN`, `$NaN`, `undefined`, or
  `∞` (check Margin "—" states with no baseline and blank Original Approved Budget).
- [ ] **Negatives** render with a leading minus in the project currency (e.g. a negative
  approved client variation, a negative Variance to Budget) and keep their existing red
  styling.
- [ ] **No hard-coded symbols:** `grep -rn "AUD" frontend/src` returns matches only in
  `lib/currency.js` and code comments; the `currency` export no longer exists in
  `formatters.js` (`npm run build` proves no caller survives).
- [ ] Sweep all eleven financial surfaces at **NZD**, **ZAR**, and **USD** — no `$` appears
  where the currency is not dollar-denominated.
- [ ] **Known limitation:** dates still format `en-AU` (`dd/mm/yyyy`) regardless of country —
  a US company will misread `03/04/2026`. Date localisation is deferred (ADR-21).

### 15h-xi. Isolation, persistence, responsiveness, no mutation

- [ ] A `company_admin` of Company A cannot read or write Company B's `countryCode`/
  `baseCurrency` (rules-denied). Company A on NZD and Company B on ZAR display independently.
- [ ] Company currency, project currency, and locked state all survive a hard reload and a
  re-login.
- [ ] Company Settings (including the projects table), the setup banner, the project currency
  card, and the locked state all render correctly at **375px / 768px / 1280px**; the projects
  table scrolls horizontally inside its card; touch targets ≥44px; no horizontal page scroll.
- [ ] **No mutation of financial amounts:** record every Budget figure, Forecast rollup, and
  Commercial margin figure before company setup; repeat after setup, after a project currency
  change, and after a company currency change → **every number identical**; only the symbol or
  code changes.
- [ ] Existing POs, claims, invoices, and variations retain their stored `currency: 'AUD'` —
  no backfill occurred. Newly created ones snapshot the project currency.

## 15i. Client Invoices & Accounts Receivable

Sign in as a financial-role user (`company_admin`/`project_manager`/`qs`). Setup:
a project with an established commercial baseline (Original Contract Value
**1,000,000**), at least one **client**-type contact, one **approved** client
variation of **+50,000**, one **submitted** (pending) client variation of
**+30,000**, and one **approved** client variation of **−40,000**.

### 15i-i. Navigation & gating

- [ ] The project tab formerly labelled "Invoices" now reads **Supplier Invoices**; its
  URL is unchanged (`/projects/{id}/invoices`) and the page is unchanged.
- [ ] The **Commercial** tab shows sub-navigation **Margin · Client Invoices**. Margin is
  the default and is byte-for-byte the previous Commercial page.
- [ ] `/projects/{id}/commercial/client-invoices` loads directly and is shareable.
- [ ] On a project with **no** commercial baseline, the Client Invoices view shows
  "Set the commercial baseline first" and a link to Margin — creation is not offered.
- [ ] In a company with **no** client-type contacts, creation is disabled with a link to
  Contacts.

### 15i-ii. Numbering

- [ ] First draft is `CI-0001`; the next is `CI-0002`.
- [ ] Numbering is sequential **company-wide** — create a draft on a second project in
  the same company and confirm it continues the sequence.
- [ ] Two simultaneous creators never receive the same number.
- [ ] Void `CI-0002` and create another → it is `CI-0003`. The number is **not reused**;
  the gap is intentional.
- [ ] A create that fails (go offline mid-save) leaves **no** counter gap — the next
  successful create takes the number that failed.

### 15i-iii. Draft creation & editing

- [ ] The client picker lists **client-type active contacts only** and pre-selects the
  baseline's client; it can be overridden.
- [ ] Save is blocked until a client, an invoice date, and at least one described,
  non-zero line exist.
- [ ] A trailing empty editor row does **not** block saving (it is dropped, not stored).
- [ ] A negative line amount is rejected with a message naming Credit Notes.
- [ ] Editing a draft preserves `CI-` number, currency, and created stamps; reloading
  shows the saved values.
- [ ] An **issued** invoice offers **no** Edit action.

### 15i-iv. GST totals

- [ ] Mixed invoice — 1,000 `GST 10%` + 500 `GST-free` + 200 `Input-taxed`:
  Subtotal **1,700**, GST **100**, Invoice total **1,800**.
- [ ] A GST-free line contributes no GST.
- [ ] There is no retention field and no "net payable" line — gross is what was billed.

### 15i-v. Contract-value control

- [ ] With OCV 1,000,000, an approved client variation of +50,000, and an approved
  variation of −40,000: **Current Contract Sum = 1,010,000**.
- [ ] Issue a 400,000 ex-GST invoice → **Issued Client Invoices 400,000**,
  **Available to Invoice 610,000**.
- [ ] A **draft** of 100,000 shows under **Draft Client Invoices** and does **not**
  reduce Available to Invoice.
- [ ] **Pending Client Variation Exposure** shows 30,000 and is **not** in the Current
  Contract Sum.
- [ ] Voiding an issued invoice returns its value to Available to Invoice immediately.

### 15i-vi. Over-invoicing (warned, never blocked)

- [ ] An invoice taking issued value above the Current Contract Sum shows an amber
  warning **and** requires the acknowledgement tick; Save stays disabled until ticked.
- [ ] After ticking, the invoice saves and issues successfully.
- [ ] Available to Invoice renders **negative in red** — never clamped to zero.
- [ ] No UI text anywhere claims over-invoicing is "prevented" or "blocked".

### 15i-vii. Variation linking

- [ ] The line picker's first column offers **Contract line** plus only **approved**
  client variations. The **pending** (+30,000) variation is absent.
- [ ] The **negative** (−40,000) approved variation is absent from the picker, yet it
  still reduces the Current Contract Sum (checked in 15i-v).
- [ ] Selecting a variation seeds the description and its **remaining** amount.
- [ ] The "Approved client variations" table shows approved / invoiced / remaining.
  Issue 30,000 against the +50,000 variation → invoiced 30,000, remaining 20,000.
- [ ] A second invoice of 25,000 against it warns (double-invoicing) and requires the
  acknowledgement, then saves; remaining renders **−5,000 in red**.
- [ ] A variation whose lines all share one cost code shows that cost code; one spanning
  several shows "—" and stores `costCodeId: null` (check the invoice detail view).
- [ ] Contract lines show no cost code.
- [ ] **The variation document is byte-identical before and after invoicing** — check
  status, `approvedSubtotal`, `lineItems`, and that no invoice reference was added.

### 15i-viii. Due dates and payment terms

- [ ] Client contact with `{30, invoice}` → due date auto-fills 30 days after the
  invoice date, and the helper text **names the source** ("Suggested from … payment
  terms (30 days from invoice)").
- [ ] Client contact with `{14, eom}` → due date is end-of-month + 14 days.
- [ ] Editing the due date stops further auto-fill even when the invoice date changes.
- [ ] A client with **no** payment terms leaves the due date **blank** with an
  explanatory note — no hidden 30-day default is applied.
- [ ] The invoice detail view shows the frozen payment-terms snapshot.

### 15i-ix. Accounts Receivable wording & ageing

- [ ] The AR panel is titled **"Accounts Receivable — ageing by due date"** and shows
  **"Issued, not yet reconciled"**, plus buckets *No due date*, *Not yet due*,
  *Past due 1–30 / 31–60 / 61–90 / 90+ days*.
- [ ] A permanent amber notice states that receipts are not recorded and that issued
  invoices stay listed until voided regardless of payment.
- [ ] `grep -rniE "unpaid|amount owing|outstanding receivable|overdue receivable" frontend/src`
  returns **no** matches.
- [ ] Buckets use **gross (inc. GST)** amounts and count **issued** invoices only —
  drafts and voids appear in none of them.
- [ ] An invoice dated 45 days past due lands in *Past due 31–60 days*; the register row
  shows "Past due 45d" in red; the **Past due date** filter narrows to it.

### 15i-x. Lifecycle — Rules-enforced (AUTOMATED — see §0)

**These cases are covered by the automated emulator suite** in
`frontend/tests/rules/clientInvoices.rules.test.js` (`npm run test:rules`, 30
tests). The list below is the specification those tests assert; re-run the suite
rather than performing these by hand, and always before publishing rules.

Every rejection must come from **Firestore**, signed in as a financial-role user —
these verify the rules, not the UI.

**Must be ALLOWED:**
- [ ] create with `status: 'draft'`; draft content edit; `draft → issued`;
  `draft → void` with a reason; `issued → void` with a reason.

**Must be REJECTED:**
- [ ] create with `status: 'issued'` or `status: 'void'`.
- [ ] create with `docType: 'credit_note'`, or with a non-null `issuedAt`/`issuedBy`/
  `voidedAt`/`voidedBy`.
- [ ] create with `createdBy` set to another user's uid, or `createdAt` set to a client
  clock value instead of `serverTimestamp()`.
- [ ] draft edit changing `invoiceNumber`, `currency`, `createdAt`, `createdBy`,
  `docType`, or `revision`.
- [ ] draft edit that also sets `status: 'issued'` **in the same write** (issuing must be
  a separate operation).
- [ ] draft edit that forges `issuedAt`/`issuedBy`/`voidedAt`/`voidedBy`.
- [ ] `draft → issued` that also changes `lineItems`, `subtotal`, `dueDate`,
  `externalInvoiceReference`, or any other field.
- [ ] `draft → issued` with `issuedBy` ≠ the caller, or `issuedAt` ≠ `serverTimestamp()`.
- [ ] **any** update to an `issued` invoice that is not a void — changing `lineItems`,
  `subtotal`, `clientName`, `dueDate`, `notes`, or `externalInvoiceReference`.
- [ ] `issued → draft`; `void → draft`; `void → issued`; any update to a `void` invoice.
- [ ] void with an empty or whitespace-only `voidReason`, or with `voidedBy` ≠ the caller.
- [ ] setting `status` to `paid`, `partially_paid`, or `sent`.
- [ ] **delete** of a draft invoice **and** of an issued invoice.
- [ ] create/update with a malformed `currency` (e.g. `AU`, `aud`, `1234`).

### 15i-xi. Currency

- [ ] On an NZD project every figure renders `NZD …`; the stored invoice `currency` is
  `NZD` and is never displayed.
- [ ] **Atomic lock:** on a fresh project with budget 0 and no records, creating the
  first client invoice locks the project currency **in the same step**; go offline
  mid-save and confirm **neither** the invoice nor the lock is written.
- [ ] Creating a second invoice on an already-locked project succeeds — verify
  specifically as a **`qs`** user (whose rule permits only `false → true`).
- [ ] Project Overview's currency card lists "N client invoices" among the lock reasons,
  and a **draft** or **void** invoice alone is enough to lock.

### 15i-xii. Tax limitation

- [ ] With `countryCode: 'NZ'`, the register and the editor show the amber tax-limitation
  notice, and GST is still **10%** (not NZ's 15%).
- [ ] With `countryCode: 'AU'`, no tax notice appears.
- [ ] No screen, button, or export anywhere says **"Tax Invoice"**; the footer states
  Constrapp does not produce a compliant Australian Tax Invoice. There is no print, PDF,
  download, or email action.

### 15i-xiii. External invoice reference

- [ ] `External Invoice Reference` is optional — an invoice saves and issues while blank.
- [ ] It is editable while draft, appears in the register and the detail view, and is
  matched by search.
- [ ] After issuing it is **not** editable, and a direct SDK write changing it on an
  issued invoice is **rejected by rules**.
- [ ] It is distinct from **Client Reference** — both are stored and displayed separately.

### 15i-xiv. Register, search & detail

- [ ] Clicking a `CI-` number opens the read-only detail view with the full client
  snapshot, lines, totals, payment-terms snapshot, and (when void) the void reason.
- [ ] Search matches CI number, client name, client reference, external reference,
  description, and variation number.
- [ ] Status, client, and **Past due date** filters combine with search.
- [ ] Editing the client contact afterwards (rename, change ABN/address) does **not**
  change any existing invoice's snapshot.

### 15i-xv. Roles, isolation & no-mutation

- [ ] Signed in as `subcontractor` or `client`: the Client Invoices view shows the
  restricted card and **no** invoice data; a direct SDK read is **denied by rules**, and
  a direct SDK create/update is **denied**.
- [ ] A user in Company B cannot read or write Company A's `clientInvoices`.
- [ ] Record every Budget figure, Forecast rollup, and Commercial margin figure before
  and after this whole suite → **every number identical**. Client invoices are
  revenue-side and change no cost figure and no margin figure.
- [ ] No Budget Line, PO, Progress Claim, Supplier Invoice, Variation, Forecast Line, or
  Commercial Baseline document is modified by any client-invoice action.

### 15i-xvi. Responsive

- [ ] At **375px / 768px / 1280px**: the Commercial sub-nav wraps, the register and the
  variation table scroll horizontally **inside their cards**, the editor modal scrolls
  internally, all touch targets are ≥44px, and there is no horizontal page scroll.

## 15j. Client Receipts (cash received) & AR reconciliation

Sign in as a financial-role user (`company_admin`/`project_manager`/`qs`). Setup:
a project with a commercial baseline, a **client**-type contact ("Acme"), a
second client contact ("Other Co"), and three **issued** client invoices for
Acme — `CI-0001` 1,100 gross (due 45 days ago), `CI-0002` 2,200 gross (due in 30
days), `CI-0003` 550 gross (no due date) — plus one **draft** and one **void**
invoice.

### 15j-i. Navigation & gating

- [ ] The **Commercial** tab shows sub-navigation **Margin · Client Invoices ·
  Receipts**; Margin remains the default.
- [ ] `/projects/{id}/commercial/receipts` loads directly and is shareable.
- [ ] With no client-type contacts, creation is disabled with a link to Contacts.
- [ ] Signed in as `subcontractor` or `client`, the Receipts view shows the
  restricted card and **no** data.

### 15j-ii. Numbering & atomicity

- [ ] The first draft is `CR-0001`; the next is `CR-0002`.
- [ ] Numbering is sequential **company-wide** — create a receipt on a second
  project in the same company and confirm it continues the sequence.
- [ ] Two simultaneous creators never receive the same number.
- [ ] Void `CR-0002` and create another → it is `CR-0003`; the number is **not**
  reused and the gap is intentional.
- [ ] A create that fails (go offline mid-save) leaves **no** counter gap — the
  next successful create takes the number that failed, and **no** receipt
  document exists.
- [ ] **Atomic currency lock:** on a fresh project with budget 0 and no records,
  creating the first receipt locks the project currency **in the same step**; go
  offline mid-save and confirm **neither** the receipt nor the lock is written.
- [ ] Creating a second receipt on an already-locked project succeeds — verify
  specifically as a **`qs`** user (whose rule permits only `false → true`).
- [ ] Project Overview's currency card lists "N client receipts" among the lock
  reasons, and a **draft** or **void** receipt alone is enough to lock.

### 15j-iii. Draft creation, client selection & payment method

- [ ] The client picker lists **client-type active contacts only**.
- [ ] **Payment method is not pre-filled** — the select starts empty and Save is
  blocked until a method is chosen.
- [ ] Choosing **Other** reveals a required description; Save is blocked while it
  is empty. Choosing any other method stores `paymentMethodOther` as `''`.
- [ ] Bank Reference and External Reference are optional — a receipt saves with
  both blank.
- [ ] Amount must be greater than zero; `0` and negatives are rejected.
- [ ] Editing a draft preserves the `CR-` number, currency, and created stamps.
- [ ] A **posted** receipt offers **no** Edit action.

### 15j-iv. Allocation

- [ ] The allocation picker lists only **Acme's issued** invoices — the draft and
  void invoices, and **Other Co's** invoices, never appear.
- [ ] Each row shows the invoice total, received to date, and remaining.
- [ ] **Allocate remaining** fills exactly that invoice's remaining balance,
  capped by the cash still unallocated on the receipt.
- [ ] **Allocate oldest first** runs **only** when pressed, fills oldest-invoice
  first, and the proposal is editable and discardable afterwards. Nothing is ever
  auto-allocated on open, on client change, or on amount change.
- [ ] One receipt allocated across **two** invoices saves and posts correctly.
- [ ] Two receipts allocated against **one** invoice both count.
- [ ] The same invoice cannot be selected twice on one receipt (already-chosen
  invoices drop out of the other rows' pickers; a duplicate is rejected).
- [ ] Allocating **more than the receipt amount** is **hard-blocked** with a
  message, and Save stays disabled.
- [ ] Changing the client on a draft that has allocations **asks for
  confirmation** and clears them; cancelling leaves both the client and the
  allocations untouched.
- [ ] Allocations are freely editable while draft and are **frozen** after
  posting.

### 15j-v. Unallocated amounts

- [ ] A receipt with **no** allocations saves and posts; it appears under
  **Unallocated — on account**.
- [ ] A partly allocated receipt shows the correct Allocated / Unallocated split,
  with an amber note before saving.
- [ ] Unallocated money **reduces no invoice balance** — confirm ageing and every
  invoice's Remaining are unchanged by an unallocated receipt.
- [ ] The **Has unallocated** filter narrows the register to those receipts.

### 15j-vi. Cent arithmetic (AUTOMATED — see §0)

- [ ] Amount 0.30 allocated 0.10 → unallocated 0.20 saves.
- [ ] Amount 10.01 allocated 3.33 → unallocated 6.68 saves.
- [ ] Amount 1000.00 allocated 999.99 → unallocated 0.01 saves.
- [ ] A one-cent discrepancy is rejected by **Firestore**, not just the UI.

### 15j-vii. Posting & future dates

- [ ] Post is a **separate confirmation** showing amount, allocated, unallocated,
  date, and method; it warns that posting freezes everything.
- [ ] A **future-dated** draft saves, shows an amber warning in the editor and a
  "future" marker in the register, and **Post is blocked** with an explanation.
- [ ] Correcting the date to today or earlier allows posting.
- [ ] **Backdated** receipts post with no warning.
- [ ] **Known deferred limitation (expected to be bypassable — do not report as
  enforced):** a direct SDK call can post a future-dated receipt; rules validate
  only the `YYYY-MM-DD` shape. See SECURITY.md → Deferred Control 16.

### 15j-viii. Invoice balances & reconciliation state

- [ ] Post a 1,100 receipt fully allocated to `CI-0001` → that invoice shows
  Received 1,100, Remaining 0, badge **Fully reconciled**.
- [ ] Post a 500 receipt allocated to `CI-0002` → Received 500, Remaining 1,700,
  badge **Partly reconciled**.
- [ ] An invoice with no receipts shows **Unreconciled**.
- [ ] Over-allocate `CI-0003` (600 against 550) → amber warning **and** the
  acknowledgement tick is required; after ticking it saves; the invoice shows
  Remaining **−50 in red**, badge **Over-reconciled**.
- [ ] The Client Invoice **detail** view lists the allocated receipts (CR #,
  date, method, bank ref, allocated amount).
- [ ] **Draft** receipts change no balance anywhere.

### 15j-ix. Corrected AR ageing

- [ ] The AR panel is titled **"Accounts Receivable — ageing by due date"** and
  its subtitle reads **"remaining balance after posted receipts"**.
- [ ] With `CI-0001` (45 days overdue) **fully reconciled**, it **disappears from
  every ageing bucket** while staying in the register.
- [ ] With `CI-0002` partly reconciled, *Not yet due* shows **only its
  remainder** (1,700), not 2,200.
- [ ] `CI-0003` (no due date) appears in **No due date** at its remaining balance.
- [ ] The **over-reconciled** invoice is **excluded from the buckets** and listed
  in the "Over-reconciled invoices — excluded from ageing" callout with its
  signed negative balance in red.
- [ ] **Void a posted receipt** → the invoice's balance is restored and it
  **re-enters** the correct ageing bucket immediately, with no page reload and no
  reversal record.
- [ ] The **Past due date** filter matches only invoices past due **and still
  owing** — a fully reconciled, long-overdue invoice is excluded.
- [ ] The old disclaimer ("Payments are not yet recorded… every issued invoice
  stays here until it is voided") is **gone**, replaced by the notice naming
  over-allocation, concurrency, and unallocated receipts.
- [ ] `grep -rniE "unpaid|amount owing|outstanding receivable|overdue receivable" frontend/src`
  returns **no** matches.

### 15j-x. Lifecycle — Rules-enforced (AUTOMATED — see §0)

**Covered by `frontend/tests/rules/clientReceipts.rules.test.js` (46 tests).**
Re-run the suite rather than performing these by hand, and always before
publishing rules.

**Must be ALLOWED:** create as draft (all three financial roles) · read · draft
edit (amount, date, method, references, allocations) · `draft → posted` ·
`draft → void` with a reason · `posted → void` with a reason · a fully
unallocated receipt · exactly 100 allocations · a backdated receipt · the three
cent-arithmetic combinations.

**Must be REJECTED:** create as `posted`/`void` · forged `postedAt`/`postedBy`/
`voidedAt`/`voidedBy` · `createdBy` = another uid · client-clock `createdAt`/
`updatedAt` · `docType: 'refund'` · malformed `currency` (`AU`, `aud`, `1234`) ·
**null or empty `clientId`/`clientName`** · malformed `receiptDate`
(`01/08/2026`, `2026-8-1`, `''`, a Timestamp) · `amount` of 0, negative, or a
string · negative `allocatedTotal`/`unallocatedAmount` · allocations claiming
more than the amount · a one-cent invariant break in either direction ·
`allocations` not a list · **101 allocations** · empty or over-long
`paymentMethod` · draft edit changing `receiptNumber`/`currency`/`createdAt`/
`createdBy`/`docType`/`revision` · draft edit breaking the invariant or the
required shape · `draft → posted` also changing content · `postedBy`/`updatedBy`
≠ caller · void with an empty **or whitespace-only** reason, or `voidedBy` ≠
caller · **any** non-void update to a posted receipt · `posted → draft` ·
`void → *` · fabricated statuses (`paid`, `reconciled`, `cleared`, …) ·
**delete** of draft, posted, and void · subcontractor/client read or write ·
unauthenticated read or write · cross-company read/write in both directions.

### 15j-xi. Allocation exceptions

- [ ] Post a receipt allocated to `CI-0002`, then **void that invoice** → an
  **Allocation exceptions** panel appears on **both** the Receipts and Client
  Invoices views naming the receipt, the invoice, and the amount.
- [ ] The receipt keeps its amount and stays counted in **Receipts Recorded** —
  the cash does **not** disappear.
- [ ] The voided invoice stays **out** of ageing.
- [ ] Nothing is deleted, reassigned, or reversed automatically; the documented
  remedy (void the receipt and re-record it) is shown.

### 15j-xii. Currency

- [ ] On an NZD project every receipt figure renders `NZD …`; the stored receipt
  `currency` is `NZD` and is **never** displayed as the authority.
- [ ] No currency picker appears anywhere in the receipt UI.
- [ ] Receipts show **no GST line, no net amount, and no tax code** — only gross
  cash.

### 15j-xiii. No mutation & no cost-side impact

- [ ] Record every Budget figure, Forecast rollup, and Commercial margin figure
  before and after this whole suite → **every number identical**. Cash is not
  revenue and touches no accrual figure.
- [ ] No Client Invoice document is modified by any receipt action — check
  `status`, `subtotal`, `gstTotal`, `grossTotal`, `lineItems`, and confirm **no**
  balance, payment-status, or receipt-reference field was added.
- [ ] No Budget Line, PO, Progress Claim, Supplier Invoice, Variation, Forecast
  Line, or Commercial Baseline document is modified.
- [ ] **No Supplier Invoice document is modified by any Client Receipt action.**
  Client Receipts are revenue-side settlement and never touch accounts payable —
  that remains true and is worth re-confirming here.
  *(Historical note: this checklist previously read "supplier invoices are
  untouched by this branch — `SI_STATUS.PAID` and `paidAt` remain exactly as they
  were on `main`". That was scoped to the Client Receipts branch and is no longer
  a statement about the codebase: the **Supplier Payments** branch has since
  changed the `paid`/`paidAt` **comments and documentation** — deprecating them
  in place. No supplier-invoice document, stored value, constant, transition map,
  counting status, or rules block changed. See §15k-xiii and ADR-24.)*

### 15j-xiv. Register, search & detail

- [ ] Clicking a `CR-` number opens the read-only detail with the client
  snapshot, date, amount, method, references, allocation table, and (when void)
  the void reason.
- [ ] Search matches CR number, client, bank reference, external reference,
  notes, and allocated invoice numbers.
- [ ] Status, client, and **Has unallocated** filters combine with search.
- [ ] Editing the client contact afterwards (rename) does **not** change any
  existing receipt's `clientName` snapshot.

### 15j-xv. Responsive

- [ ] At **375px / 768px / 1280px**: the Commercial sub-nav wraps, the register
  and allocation tables scroll horizontally **inside their cards**, the editor
  and post/void modals scroll internally, all touch targets are ≥44px, and there
  is no horizontal page scroll.

## 15k. Supplier Payments (cash paid) & AP reconciliation

Sign in as a financial-role user (`company_admin`/`project_manager`/`qs`). Setup:
a project with two **supplier** contacts ("BuildCo", "SteelCo"); four **posted**
supplier invoices for BuildCo — `SI-0001` payable 1,100 (supplier ref `INV-4471`,
due 45 days ago), `SI-0002` payable 2,200 (`INV-4488`, due in 30 days),
`SI-0003` payable 550 (`INV-4501`, no due date), and `SI-0004` **with retention**
(gross 1,100, retentionTotal 110, **payable 990**); one **draft**, one
**approved**, and one **cancelled** invoice; one posted invoice for SteelCo; and
one **legacy** posted invoice with `supplierId: null` and
`supplierName: "BuildCo"` (seed directly).

### 15k-i. Navigation & gating

- [ ] The **Commercial** tab shows sub-navigation **Margin · Client Invoices ·
  Client Receipts · Supplier Payments**; Margin remains the default.
- [ ] The Receipts sub-view label now reads **Client Receipts**, and its route is
  still `/projects/{id}/commercial/receipts` (unchanged and shareable).
- [ ] `/projects/{id}/commercial/supplier-payments` loads directly and is
  shareable.
- [ ] With no supplier/subcontractor contacts, creation is disabled with a link
  to Contacts.
- [ ] Signed in as `subcontractor` or `client`, the Supplier Payments view shows
  the restricted card and **no** data.

### 15k-ii. Numbering & atomicity

- [ ] The first draft is `SP-0001`; the next is `SP-0002`.
- [ ] Numbering is sequential **company-wide** — create a payment on a second
  project in the same company and confirm it continues the sequence.
- [ ] Two simultaneous creators never receive the same number.
- [ ] Void `SP-0002` and create another → it is `SP-0003`; the number is **not**
  reused and the gap is intentional.
- [ ] A create that fails (go offline mid-save) leaves **no** counter gap — the
  next successful create takes the number that failed, and **no** payment
  document exists.
- [ ] **Atomic currency lock:** on a fresh project with budget 0 and no records,
  creating the first payment locks the project currency **in the same step**; go
  offline mid-save and confirm **neither** the payment nor the lock is written.
- [ ] Creating a second payment on an already-locked project succeeds — verify
  specifically as a **`qs`** user (whose rule permits only `false → true`).
- [ ] Project Overview's currency card lists "N supplier payments" among the lock
  reasons, and a **draft** or **void** payment alone is enough to lock.

### 15k-iii. Draft creation, supplier selection & payment method

- [ ] The supplier picker lists **active supplier and subcontractor contacts
  only** — the same list the PO picker uses. Client-only contacts never appear.
- [ ] **Payment method is not pre-filled** — the select starts empty and Save is
  blocked until a method is chosen. It never defaults to bank transfer.
- [ ] Choosing **Other** reveals a required description; Save is blocked while it
  is empty. Choosing any other method stores `paymentMethodOther` as `''`.
- [ ] Bank Reference, **Remittance Reference**, and External Reference are all
  optional — a payment saves with all three blank.
- [ ] Amount must be greater than zero; `0` and negatives are rejected.
- [ ] Editing a draft preserves the `SP-` number, currency, and created stamps.
- [ ] A **posted** payment offers **no** Edit action.

### 15k-iv. Allocation & eligible invoices

- [ ] The allocation picker lists only BuildCo's **posted** invoices. The
  **draft**, **approved**, and **cancelled** invoices, and **SteelCo's**
  invoices, never appear. *(Approved is not the financial commit point — posted
  is.)*
- [ ] Each row shows payable, paid to date, and remaining payable — and, for
  `SI-0004` only, the gross and retention-withheld line.
- [ ] The **legacy** `supplierId: null` invoice appears when BuildCo is selected
  and is labelled **"Matched by supplier name — this invoice predates the
  Contacts module."** Confirm afterwards that the invoice document was **not**
  backfilled (`supplierId` is still `null`).
- [ ] Both invoice references render and are searchable: `SI-0007 · INV-4471`.
- [ ] **Allocate remaining** fills exactly that invoice's remaining payable,
  capped by the cash still unallocated on the payment.
- [ ] **Allocate oldest first** runs **only** when pressed, fills oldest first,
  and the proposal is editable and discardable. Nothing is ever auto-allocated on
  open, on supplier change, on amount change, on adding an invoice, or on
  posting.
- [ ] One payment allocated across **two** invoices saves and posts correctly.
- [ ] Two payments allocated against **one** invoice both count.
- [ ] The same invoice cannot be selected twice on one payment (already-chosen
  invoices drop out of the other rows' pickers; a duplicate is rejected).
- [ ] Allocating **more than the payment amount** is **hard-blocked** with a
  message, and Save stays disabled.
- [ ] Changing the supplier on a draft that has allocations **asks for
  confirmation** and clears them; cancelling leaves both the supplier and the
  allocations untouched.
- [ ] Allocations are freely editable while draft and are **frozen** after
  posting.

### 15k-v. Payable basis & retention

- [ ] `SI-0004` offers **990** as its payable, not its 1,100 gross.
- [ ] Allocating 990 to `SI-0004` reads **Fully reconciled** with Remaining
  Payable 0 — the 110 retention is **never** presented as payable.
- [ ] The retention line is shown for `SI-0004` and **hidden** for invoices with
  `retentionTotal` 0.
- [ ] The permanent helper text beneath the allocation table reads: *"Payments
  settle the net payable on each invoice, after retention withheld. Retention is
  not payable on this invoice and is never reduced by a payment. Retention
  release is not yet modelled in Constrapp."*
- [ ] After the whole suite, every invoice's `retention`, `retentionGst`, and
  `retentionTotal` are **byte-identical** to their pre-suite values.
- [ ] Retention appears in **no** AP ageing bucket.
- [ ] `grep -rniE "balance due|amount owing|outstanding payable|overdue payable" frontend/src`
  returns **no** matches.

### 15k-vi. Cent arithmetic (AUTOMATED — see §0)

- [ ] Amount 0.30 allocated 0.10 → unallocated 0.20 saves.
- [ ] Amount 10.01 allocated 3.33 → unallocated 6.68 saves.
- [ ] Amount 1000.00 allocated 999.99 → unallocated 0.01 saves.
- [ ] A one-cent discrepancy is rejected by **Firestore**, not just the UI.

### 15k-vii. Posting & future dates

- [ ] Post is a **separate confirmation** showing amount, allocated, unallocated,
  date, and method; it warns that posting freezes everything.
- [ ] A **future-dated** draft saves, shows an amber warning in the editor and a
  "future" marker in the register, and **Post is blocked** with an explanation.
- [ ] Correcting the date to today or earlier allows posting.
- [ ] **Backdated** payments post with no warning.
- [ ] **Known deferred limitation (expected to be bypassable — do not report as
  enforced):** a direct SDK call can post a future-dated payment; rules validate
  only the `YYYY-MM-DD` shape. See SECURITY.md → Deferred Control 18.

### 15k-viii. Invoice balances & reconciliation state

- [ ] Post a 1,100 payment fully allocated to `SI-0001` → that invoice shows Paid
  to Date 1,100, Remaining Payable 0, badge **Fully reconciled**.
- [ ] Post a 500 payment allocated to `SI-0002` → Paid 500, Remaining 1,700,
  badge **Partly reconciled**.
- [ ] An invoice with no payments shows **Unreconciled**.
- [ ] Over-reconcile `SI-0003` (600 against 550) → amber warning **and** the
  acknowledgement tick is required; after ticking it saves; the invoice shows
  Remaining **−50 in red**, badge **Over-reconciled**.
- [ ] The Supplier Invoice **detail** view (click the `SI-` number) lists the
  allocated payments (SP #, date, method, bank ref, remittance ref, allocated).
- [ ] **Draft** payments change no balance anywhere.
- [ ] Only **posted** supplier invoices appear in the reconciliation table —
  draft, approved, and cancelled invoices show `—` for Paid/Remaining.

### 15k-ix. AP ageing

- [ ] The AP panel is titled **"Accounts Payable — ageing by due date"** and its
  subtitle reads **"Remaining payable after posted Supplier Payments."**
- [ ] With `SI-0001` (45 days overdue) **fully reconciled**, it **disappears from
  every ageing bucket** while staying in the register.
- [ ] With `SI-0002` partly reconciled, *Not yet due* shows **only its
  remainder** (1,700), not 2,200.
- [ ] `SI-0003` (no due date) appears in **No due date** at its remaining
  balance.
- [ ] The **over-reconciled** invoice is **excluded from the buckets** and listed
  in the "Over-reconciled invoices — excluded from ageing" callout with its
  signed negative balance in red.
- [ ] **Void a posted payment** → the invoice's balance is restored and it
  **re-enters** the correct ageing bucket immediately, with no page reload and no
  reversal record.
- [ ] **Total Posted Supplier Invoices** sums `payableTotal` (not gross) across
  posted invoices only.

### 15k-x. Lifecycle — Rules-enforced (AUTOMATED — see §0)

**Covered by `frontend/tests/rules/supplierPayments.rules.test.js` (47 tests).**
Re-run the suite rather than performing these by hand, and always before
publishing rules.

**Must be ALLOWED:** create as draft (all three financial roles) · read · draft
edit (supplier, amount, date, method, references, allocations) · `draft → posted`
· `draft → void` with a reason · `posted → void` with a reason · a fully
unallocated payment · exactly 100 allocations · a backdated payment · an
allocation with an empty `supplierInvoiceNumber` · the cent-arithmetic
combinations · the complete create → edit → post → failed posted edit → void
sequence.

**Must be REJECTED:** create as `posted`/`void` · forged `postedAt`/`postedBy`/
`voidedAt`/`voidedBy` · `createdBy` = another uid · client-clock `createdAt`/
`updatedAt` · `docType: 'refund'` or `'receipt'` · malformed `currency` (`AU`,
`aud`, `1234`) · non-numeric `revision` · **null or empty `supplierId`/
`supplierName`** · malformed `paymentDate` (`01/08/2026`, `2026-8-1`, `''`, a
Timestamp) · `amount` of 0, negative, or a string · negative or non-numeric
`allocatedTotal`/`unallocatedAmount` · allocations claiming more than the amount ·
a one-cent invariant break in either direction · `allocations` not a list ·
**101 allocations** · empty, null, or over-40-character `paymentMethod` · draft
edit changing `paymentNumber`/`currency`/`createdAt`/`createdBy`/`docType`/
`revision` · draft edit forging a lifecycle stamp · draft edit breaking the
invariant or the required shape · `draft → posted` also changing content ·
`postedBy`/`updatedBy` ≠ caller · void with an empty **or whitespace-only**
reason, or `voidedBy` ≠ caller · **any** non-void update to a posted payment ·
`posted → draft` · `void → *` · double void · fabricated statuses (`paid`,
`partially_paid`, `reconciled`, `cleared`, `issued`, `approved`) · **delete** of
draft, posted, and void · subcontractor/client read or write · unauthenticated
read or write · cross-company read/write in both directions.

### 15k-xi. Unallocated payments

- [ ] A payment with **no** allocations saves and posts; it appears under
  **Unallocated — on account** and is **not** styled as an error.
- [ ] A partly allocated payment shows the correct Allocated / Unallocated split,
  with an amber note before saving.
- [ ] Unallocated money **reduces no invoice balance** — confirm AP ageing and
  every invoice's Remaining Payable are unchanged by an unallocated payment.
- [ ] **Payments Recorded** includes the unallocated payment in full — it is
  actual cash out.
- [ ] The **Has unallocated** filter narrows the register to those payments.

### 15k-xii. Allocation exceptions

- [ ] Post a payment allocated to `SI-0002`, then **cancel that invoice** (this
  requires a direct SDK call — posted supplier-invoice lifecycle is not
  rules-enforced) → an **Allocation exceptions** panel appears on **both** the
  Supplier Payments and Supplier Invoices views, naming the payment, both invoice
  references, and the amount, and stating that the cancellation may have happened
  through a direct SDK call.
- [ ] The payment keeps its amount and stays counted in **Payments Recorded** —
  the cash does **not** disappear.
- [ ] The cancelled invoice stays **out** of AP ageing.
- [ ] A payment allocated to another supplier's invoice (seed directly) surfaces
  as a **supplier mismatch** exception.
- [ ] Nothing is deleted, reassigned, or reversed automatically; the documented
  remedy is shown.

### 15k-xiii. `paid` / `paidAt` deprecation

- [ ] `grep -rn "SI_STATUS.PAID" frontend/src` returns **only** the deprecated
  definition, its label, its badge variant, its empty transition entry, the
  counting-statuses array, and the vestigial guard inside `isOverdue` — **no
  write**.
- [ ] No UI path anywhere transitions a supplier invoice to `paid`; a posted
  invoice's only row action is **Record payment**.
- [ ] After the whole suite, every supplier invoice's `paidAt` is still `null`
  and its `status` is unchanged.
- [ ] Seed a supplier invoice with `status: 'paid'` directly → it still counts
  toward **Invoiced** and **Actual** on the Budget tab (the safe failure mode),
  and it does **not** appear in AP reconciliation or ageing (only `posted` is
  payable).
- [ ] The Due column uses payment-aware past-due: a fully reconciled invoice
  whose due date has passed is **not** marked past due, while an unpaid overdue
  one reads **"Past due Nd"** in red.

### 15k-xiv. Supplier Invoice integration

- [ ] The Supplier Invoices header carries a **Supplier Payments** link.
- [ ] A compact AP summary shows **Total Posted Supplier Invoices**, **Paid to
  Date**, and **Remaining Payable**, with a link to Supplier Payments.
- [ ] **Record payment** appears only on **posted** rows; it opens the Supplier
  Payments editor with the supplier preselected and that invoice pre-added.
- [ ] Navigating **back** afterwards does **not** reopen the editor (the
  hand-off state is consumed once).
- [ ] Record payment on an invoice whose supplier contact is missing, or whose
  invoice is no longer posted, falls back safely to an empty/supplier-only
  editor rather than erroring.
- [ ] Clicking an `SI-` number opens the read-only invoice detail with lines,
  totals, retention, payment reconciliation, and the allocated payments table.

### 15k-xv. Currency

- [ ] On an NZD project every payment figure renders `NZD …`; the stored payment
  `currency` is `NZD` and is **never** displayed as the authority.
- [ ] No currency picker appears anywhere in the payment UI.
- [ ] Payments show **no GST line, no net amount, and no tax code** — only gross
  cash.

### 15k-xvi. No mutation & no accrual impact

- [ ] Record every Budget figure (Budgeted, Committed, Claimed, Actual, Invoiced,
  Remaining), every Forecast rollup (Cost to Complete, Forecast Final Cost,
  Variance to Budget), and every Commercial margin figure before and after this
  whole suite → **every number identical**. Cash out is not cost.
- [ ] No Supplier Invoice document is modified by any payment action — check
  `status`, `subtotal`, `gstTotal`, `grossTotal`, `payableTotal`, `retention*`,
  `lineItems`, `paidAt`, and confirm **no** balance, payment-status, or
  payment-reference field was added.
- [ ] No Budget Line, PO, Progress Claim, Variation, Forecast Line, Commercial
  Baseline, Client Invoice, or Client Receipt document is modified.
- [ ] **Client Receipts behave exactly as before** — only their sub-navigation
  label changed.

### 15k-xvii. Register, search & detail

- [ ] Clicking an `SP-` number opens the read-only detail with the supplier
  snapshot, date, amount, method, all three references, allocation table with
  both invoice references and live invoice status, audit stamps, and (when void)
  the void reason.
- [ ] Search matches SP number, supplier, bank reference, remittance reference,
  external reference, notes, **SI number**, and **supplier invoice number**.
- [ ] Status, supplier, and **Has unallocated** filters combine with search.
- [ ] Editing the supplier contact afterwards (rename) does **not** change any
  existing payment's `supplierName` snapshot.

### 15k-xviii. Cash Flow readiness

- [ ] A posted payment exposes amount, `paymentDate`, project, supplier identity,
  currency, `allocatedTotal`, and `unallocatedAmount` via
  `lib/supplierPayments.js → cashOutRows()`.
- [ ] An **unallocated** payment's **full amount** is present as cash out — not
  its `allocatedTotal`.
- [ ] Draft and void payments are excluded.
- [ ] **No Cash Flow route, page, chart, period, or aggregation exists in this
  branch.**

### 15k-xix. Responsive

- [ ] At **375px / 768px / 1280px**: the Commercial sub-nav wraps to four items,
  the register, reconciliation, AP-ageing, and allocation tables scroll
  horizontally **inside their cards**, the editor and post/void/detail modals
  scroll internally, all touch targets are ≥44px, and there is no horizontal
  page scroll.
  *(Since the Actual Cash Flow foundation the sub-nav carries five items and
  scrolls horizontally below `sm:` instead of wrapping — see §15l-xii.)*

## 15l. Actual Cash Flow

Unit-automated coverage: the arithmetic below (grouping, statuses, unallocated
amounts, ordering, cumulative totals, rounding) is asserted by
`tests/unit/cashFlow.test.js` (§0b). These manual steps verify the live page.

### 15l-i. Navigation & gating

- [ ] The Commercial sub-nav shows **Margin · Client Invoices · Client Receipts
  · Supplier Payments · Cash Flow**; the fifth tab routes to
  `/projects/:projectId/commercial/cash-flow`.
- [ ] There is **no** new top-level project tab.
- [ ] A `company_admin`, `project_manager`, and `qs` see the page; a
  `subcontractor` or `client` sees the restricted-access card and triggers no
  commercially-sensitive reads.
- [ ] The header links to Client Receipts and Supplier Payments work, and the
  page never describes itself as a bank statement or bank balance.

### 15l-ii. Monthly grouping by transaction date

- [ ] A posted receipt appears in the month of its **receiptDate**; a posted
  payment in the month of its **paymentDate**.
- [ ] A **backdated** receipt (entered today, dated last month) appears in
  **last** month — entry date and posting date change nothing.
- [ ] Two transactions in one month sum into one row.

### 15l-iii. Statuses

- [ ] A **draft** receipt or payment contributes nothing anywhere on the page.
- [ ] **Voiding** a posted payment removes it from Actual Cash Out, its month,
  and the cumulative position at the next render — with no reversal record.

### 15l-iv. Unallocated cash

- [ ] A posted, fully **unallocated receipt** counts its **full amount** in
  Actual Cash In and appears in *Unallocated Cash In — on account* with the
  advance/overpayment/awaiting-allocation wording. It is not styled as an
  error and is not netted against anything.
- [ ] The same for a fully unallocated **payment** on the Cash Out side.
- [ ] A **partly** allocated transaction still counts its full amount in the
  cash totals.

### 15l-v. Months, gaps & ordering

- [ ] With cash only in (say) August and October, September renders as a
  **zero row** and the cumulative position carries through it unchanged.
- [ ] Cash in December and the following January orders correctly across the
  year boundary.
- [ ] The current month is marked.

### 15l-vi. Cumulative position

- [ ] The cumulative column equals a hand-calculated running sum of the monthly
  nets, **starting from zero**.
- [ ] Negative monthly net and negative cumulative values use the red semantic
  styling.
- [ ] The zero-opening wording is present under the table: *"Cumulative net
  cash movement on this project. Not a bank balance. …"* — and no
  opening-balance input exists anywhere.

### 15l-vii. Wording & limitations

- [ ] The grouping explanation is present: *"Cash is grouped by the date money
  moved. Receipt Date drives Cash In and Payment Date drives Cash Out."*
- [ ] The Limitations card carries all four statements: not a bank balance /
  gross vs ex-GST / GST-BAS not modelled / forecast not included.

### 15l-viii. Commercial context panel

- [ ] The panel is visually separate, headed **"Commercial context — accrual,
  ex-GST"**, and shows the same Current Contract Sum, Forecast Revenue,
  Forecast Final Cost, Forecast Gross Profit, and Forecast Margin % as the
  Margin view (same shared derivation — compare values side by side).
- [ ] With **no commercial baseline**, revenue-side figures show **"—"** (never
  zero) with a prompt to the Margin view.
- [ ] No context figure appears in any cash total or the cumulative column.

### 15l-ix. Currency

- [ ] All figures display in the **project** currency; a project in another
  currency shows that currency; nothing is summed across projects.

### 15l-x. Loading, errors & empty state

- [ ] While the receipt/payment subscriptions resolve, the page shows a
  loading state — never zero totals.
- [ ] A failed receipt or payment subscription shows the error card naming the
  failed direction — never zero Cash In/Out.
- [ ] With **no posted cash** (drafts/voids may exist), the empty state shows
  *"No recorded cash movement yet"* with working links to Client Receipts and
  Supplier Payments.

### 15l-xi. No mutation & no accrual impact

- [ ] Using the Cash Flow page writes **no** document: receipts, payments,
  invoices, POs, claims, variations, forecast lines, budget lines, and the
  commercial baseline are all byte-identical afterwards.
- [ ] The six budget figures, Forecast Final Cost, Variance to Budget, and
  every margin figure are unchanged before vs after.

### 15l-xii. Responsive

- [ ] At **375px** the five sub-tabs form a horizontally scrolling strip — no
  wrapping, full labels, ≥44px touch targets; at **768px+** they wrap
  normally. The monthly table scrolls **inside its card**; there is no
  page-level horizontal scroll at 375px / 768px / 1280px.

## 15m. Forecast Cash Flow

Unit-automated coverage: the arithmetic (classification, coverage, completeness,
cumulative, peak funding, the boundary and no-past-month rules) is asserted by
`tests/unit/cashFlow.test.js` (§0b). Rules coverage is
`tests/rules/cashFlowLines.rules.test.js` (§0). These steps verify the live page.

### 15m-i. Automatic AR forecast

- [ ] An **issued** client invoice with a future due date appears in Forecast
  Cash In in its **due month**, at its **remaining gross** balance.
- [ ] A **partly reconciled** invoice forecasts only its remainder; a **fully
  reconciled** one disappears from the forecast entirely.
- [ ] An **over-reconciled** invoice appears in no month and is reported in the
  signed callout — it never offsets another invoice.
- [ ] Voiding a receipt restores the balance and it re-enters the forecast.

### 15m-ii. Automatic AP forecast

- [ ] A **posted** supplier invoice with a future due date appears in Forecast
  Cash Out at its **remaining payable** (`payableTotal`, not gross).
- [ ] Retention withheld is **excluded** from the forecast and reported in the
  untimed panel with the "release is not modelled" wording.
- [ ] Draft, approved, and cancelled supplier invoices contribute nothing.

### 15m-iii. Past-due and no-due-date

- [ ] An invoice whose due month is **before** the current month appears in
  **no** month and is reported under *Past due — expected recovery/payment not
  retimed*.
- [ ] An invoice due **earlier in the current month** is still timed into the
  current month (month-level, not day-level).
- [ ] An invoice with a **blank due date** is reported under *no due date* and
  is never guessed into a month.

### 15m-iv. Manual timing lines

- [ ] *Add timing line* offers exactly `contract_revenue` + `manual` for Cash In
  and `uninvoiced_claim` / `remaining_committed` / `uncommitted_ctc` + `manual`
  for Cash Out. **No invoice source type is offered anywhere.**
- [ ] A cost-side source requires a cost code; the picker shows each code's
  remaining ex-GST balance.
- [ ] The ex-GST coverage field **pre-fills a visible, editable suggestion**;
  *Use remaining* refills it. A `manual` line takes no coverage.
- [ ] **"+ GST 10%"** fills the gross amount only when pressed — never on
  changing the source, cost code, month, or coverage.
- [ ] The line appears in its month, in the register, and in the month
  drill-down.

### 15m-v. Splitting and coverage

- [ ] Two lines against one cost code split a balance across months; coverage
  sums and the untimed remainder falls accordingly.
- [ ] Coverage above the remaining balance shows the amber warning and
  **requires the acknowledgement tick** before saving — it is never blocked.
- [ ] An `uninvoiced_claim` line and a `remaining_committed` line on the **same
  cost code** both reduce the **same** untimed Remaining Committed figure.

### 15m-vi. No past-month timing

- [ ] Creating a line with a month **before** the current month is **blocked**
  with an explanatory message.
- [ ] Editing an active line **into** a past month is blocked.
- [ ] The month picker's minimum is the current month.

### 15m-vii. Stale lines

- [ ] A line whose month has passed is listed in the **stale panel**, excluded
  from every monthly total, the cumulative position, and peak funding.
- [ ] **Retime** moves it to the current month or later and it re-enters the
  forecast; **Void** requires a reason and removes it from the panel.
- [ ] Nothing is ever moved or deleted silently.

### 15m-viii. Boundary, cumulative and closing position

- [ ] Past months show **"—"** in both forecast columns — never `$0`.
- [ ] The current month combines actual and forecast.
- [ ] The cumulative column matches a hand calculation from **zero**, and the
  projected closing position equals the final month's cumulative value.
- [ ] Gap months render as zero rows.

### 15m-ix. Completeness

- [ ] Revenue and cost coverage percentages match a hand calculation.
- [ ] With **no baseline**, revenue coverage shows **"—"** — never 0% or 100%.
- [ ] On an **over-invoiced** contract, revenue coverage shows "—" with the
  over-invoiced explanation.
- [ ] With unforecast cost codes, cost coverage shows the *incomplete basis*
  warning.
- [ ] The state badge reads Complete / Partially timed / Incomplete forecast /
  Unavailable correctly.

### 15m-x. Peak funding

- [ ] With everything timed and both bases available, the headline peak funding
  and its month are shown; the **earliest** month wins a tie.
- [ ] With any untimed amount, the headline is **suppressed**, the specific
  reasons are listed, and only a **lower bound** is shown.
- [ ] When the position never goes negative it reads **"No funding shortfall
  projected"** — never `$0`.
- [ ] The panel always states that **retention release and GST/BAS cash movement
  are excluded**.
- [ ] Retention withheld and unallocated cash produce warnings but do **not**
  suppress.

### 15m-xi. Untimed panel — three bases

- [ ] The three columns are headed *Gross cash* · *Ex-GST source value* ·
  *Exposure — context only*, and **no total spans two bases**.
- [ ] Approved claim awaiting invoice is shown **indented within** Remaining
  Committed with the "included within Remaining Committed" wording — never as an
  additive line.

### 15m-xii. Lifecycle & register

- [ ] A voided line is hidden by default, shown by *Show voided*, struck
  through with its reason, and contributes nothing.
- [ ] A voided line cannot be edited or re-voided.
- [ ] No delete action exists anywhere.

### 15m-xiii. Subscription errors (never a genuine zero)

- [ ] Simulate a failed **Supplier Invoices** read (e.g. sign in as a role
  without access, or block the request): Forecast Cash Out and AP figures show
  **"—"** with a named error banner — never `$0`.
- [ ] The same for **Forecast Lines** (Cost to Complete and cost completeness),
  **Budget Lines**, **Purchase Orders**, **Progress Claims**.
- [ ] A **Variations** failure marks variation exposure and revenue coverage
  unavailable but leaves the cash layers working.
- [ ] A **Client Receipts** or **Supplier Payments** failure blocks the whole
  page with the existing error card.

### 15m-xiv. Currency & no mutation

- [ ] Every figure renders in the project currency; the first timing line
  **locks** the project currency; a voided line keeps it locked.
- [ ] After exercising the whole feature, receipts, payments, client invoices,
  supplier invoices, POs, claims, variations, forecast lines, budget lines, and
  the commercial baseline are **byte-identical**, and the six budget figures,
  Forecast Final Cost, Variance to Budget, and every margin figure are unchanged.

### 15m-xv. Roles & responsive

- [ ] `company_admin` / `project_manager` / `qs` can read and author lines;
  `subcontractor` and `client` see the restricted card.
- [ ] At **375px / 768px / 1280px**: the monthly table, register, and
  drill-downs scroll **inside their cards**, the editor and void modals scroll
  internally, touch targets are ≥44px, and there is no page-level horizontal
  scroll.

## 15n. Cash Flow visualisation (chart)

Unit-automated coverage: the presentation transform (sign, unavailability
nulling, boundary, peak-marker eligibility, summary) is asserted by
`tests/unit/cashFlowChart.test.js` (§0b). The chart component is not
unit-tested — these steps verify the rendered chart. **The chart must never
disagree with the monthly table directly beneath it**; when in doubt, the table
is the record.

### 15n-i. Placement, structure and agreement

- [ ] The chart renders **between** the projected-position / peak-funding cards
  and the monthly table, inside a `Card` matching the page's surrounding style.
- [ ] **Two stacked panels** — monthly bars above, cumulative line below. There
  is **no dual Y axis**.
- [ ] Every value in a chart tooltip **matches the same month's row** in the
  monthly table exactly.
- [ ] Hovering a month shows all eight figures: Actual In/Out, Forecast In/Out,
  Total In/Out, Net, Cumulative.

### 15n-ii. Direction, state and the zero baseline

- [ ] Cash In plots **above** zero, Cash Out **below** it.
- [ ] Cash Out reads as a **positive** amount in the tooltip despite plotting
  downward. No user-visible figure is negative merely because it is cash out.
- [ ] Actual bars are **solid**; forecast bars are **hatched**. In a greyscale
  screenshot the two remain distinguishable.
- [ ] The legend names all four series with matching swatches.
- [ ] Panel B has a clear zero line; the region below zero is shaded and a
  negative position is immediately obvious.

### 15n-iii. The actual/forecast boundary

- [ ] The current month is marked on **both** panels and the marks line up
  vertically.
- [ ] Months before the current month show **no** forecast segment — and the
  tooltip shows their forecast as **"—", never "$0"**.
- [ ] A current month holding both posted cash and forecast shows a **mixed**
  stacked bar.

### 15n-iv. Peak funding (honesty-critical)

- [ ] With a complete forecast and a negative trough: a peak-funding marker
  appears on Panel B at the same month the peak-funding card names.
- [ ] With peak funding **suppressed** (e.g. leave cost to complete untimed):
  **no marker of any kind appears on the chart** — not even a lower-bound
  marker — and an amber caption explains why. The lower bound remains visible
  only in the card above.
- [ ] With a position that never goes negative: no marker, and the caption reads
  "No funding shortfall projected."

### 15n-v. Unavailable and empty states

- [ ] Break the Client Invoices or Supplier Invoices subscription (e.g. sign in
  as a role without access, or go offline after load): forecast bars
  **disappear rather than dropping to zero**, the cumulative line **stops** at
  the last recorded month instead of bridging, the forecast region shading is
  **not** drawn, no peak marker appears, and an amber in-card note says only
  recorded cash is charted.
- [ ] Historical actual bars remain fully intact in that state.
- [ ] On a project with **no** cash-flow data the chart does **not** render at
  all — the existing page empty state stands, with no empty chart frame above
  it.
- [ ] With **only** actual data: bars render, no forecast is fabricated.
- [ ] With **only** current/future forecast: renders with no recorded history,
  and the summary does not claim recorded cash.

### 15n-vi. Summary, responsive and accessibility

- [ ] The textual summary beneath the chart states the month span and the
  recorded/projected boundary, and quotes a lowest projected position **only**
  when the peak marker is shown.
- [ ] At **375px / 768px / 1280px**: both panels scroll **together** in one
  horizontal container inside the card; bars stay readable on a multi-year
  project rather than compressing; there is no page-level horizontal scroll.
- [ ] Keyboard: focus the chart and use arrow keys — the tooltip traverses
  months (Recharts `accessibilityLayer`).
- [ ] The monthly table below remains the complete numeric equivalent, so no
  information is available only via the chart.
- [ ] Using the chart writes **no** document — it is read-only, with no
  clickable edit path.

## 16. Responsive Checks — 375px, 768px, 1280px

- [ ] **375px:** sidebar hidden behind hamburger; drawer opens/closes (tap overlay); nav items ≥44px tall; project tab bar wraps; PO/claim tables scroll horizontally inside their card; modals fit with internal scrolling; all actions reachable by tap (no hover-only).
- [ ] **768px:** sidebar visible and static; two-column grids engage; modals centred with margin.
- [ ] **1280px:** dashboard/detail content capped at max-width 1280px; 4-column KPI grid; 5-column budget summary; no horizontal page scroll at any width.

## 17. Security & Authorisation (negative-path)

Firestore Security Rules are the only trust boundary — these checks confirm the
**rules** (not just the UI) enforce access. See
[SECURITY.md](SECURITY.md) and [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md)
§4–§5. Run them whenever a collection, field, or rule changes.

### 17a. Tenant isolation

- [ ] A user whose `users/{uid}.companyId` differs from a document's company path
  cannot read or write that document (verify with a second company's data — a
  cross-company read returns nothing / is denied, not just hidden by the UI).

### 17b. Role-restricted reads (PII & financial collections)

- [ ] Signed in as a `subcontractor` or `client` role user, **Contacts, Supplier
  Invoices, Client Invoices, Client Receipts, Supplier Payments, Variations,
  Forecast, and Commercial** all show no data — reads are blocked by rules, not
  merely absent from the nav.
- [ ] The same user **can** still read company members' Projects, Cost Codes,
  Budget Lines, POs, and Progress Claims (the intended coarser read model).

### 17c. Write authorisation & delete-blocking

- [ ] A `subcontractor`/`client` role user cannot create or update POs, claims,
  invoices, variations, budget lines, or cost codes (rules reject the write).
- [ ] No client path can delete a financial/audit document (POs, claims,
  invoices, variations, budget lines, cost codes, contacts, counters, forecast
  lines, commercial baseline) — cancellation/rejection/archive is always a
  status/`isActive` change (the baseline is edited in place).
- [ ] **`users/{uid}` cannot be written at all** — no client can change its own
  `role` or `companyId` (nor `name`/`avatarInitials`/`email`), create a
  membership document, or delete one. **AUTOMATED — see §0**; the users suite
  proves every case, so this needs no manual pass.

### 17d. Client-only controls are *not* a security boundary (known gaps)

These document current deferred limitations — a direct SDK call by an authorized
financial-role user can still bypass client checks (see SECURITY.md → Deferred
Controls). They are **expected** to be bypassable today; do not report them as
enforced.

- [ ] Lifecycle-transition legality, post-submission/`posted`/`approved`
  immutability, one-open-claim / one-invoice-per-claim races, creator ≠ approver
  segregation, counter integrity, and uniqueness are all client-enforced only.
  **Exception:** `clientInvoices`, `clientReceipts` **and `supplierPayments`**
  transitions and post-commit immutability **are** rules-enforced — see §15i-x,
  §15j-x and §15k-x, which test them as real rejections. Note the live
  consequence of the remaining gap: a direct-SDK caller can cancel a **posted**
  supplier invoice that a payment has settled (surfaced as an allocation
  exception), or forge `status: 'paid'` on one (§15k-xiii).
- [ ] Client-invoice **Available to Invoice** and **per-variation remaining**
  limits are client-side warnings only: two users invoicing the same remaining
  value concurrently both succeed. Expected — do not report as enforced
  (SECURITY.md → Deferred Control 14).
- [ ] Client-receipt **allocation integrity** is client-side only: rules cannot
  iterate the allocations array, so `allocatedTotal` may not match its sum, an
  allocation may target a non-existent/draft/void/wrong-client invoice, an
  invoice can be over-allocated, and two users can allocate the same balance
  concurrently. Posting a **future-dated** receipt is likewise client-blocked
  only. Expected — do not report as enforced (SECURITY.md → Deferred Control 16).
  The **scalar** invariant (`allocatedTotal + unallocatedAmount == amount`, whole
  cents) **is** rules-enforced.
- [ ] Supplier-payment **allocation integrity** is client-side only, identically:
  an allocation may target a non-existent/draft/approved/cancelled/wrong-project/
  wrong-supplier invoice, an invoice can be over-reconciled, and two users can
  allocate the same remaining payable concurrently. The **`payableTotal` basis
  and the retention exclusion are also client-side** — rules cannot read the
  invoice. Posting a **future-dated** payment is client-blocked only. Expected —
  do not report as enforced (SECURITY.md → Deferred Control 18). The **scalar**
  invariant **is** rules-enforced.

### 17e. Secrets

- [ ] The built bundle (`frontend/dist/`) contains only public `VITE_*` values
  (Firebase web config). No Stripe/AI/email/service-account secret appears in the
  bundle or in any `VITE_`-prefixed variable.
