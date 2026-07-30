# Testing

**There is no automated test suite.** No test runner, no test files, no CI. The
`lib/` domain modules (`purchaseOrders.js`, `progressClaims.js`) are pure
functions and are the natural first target when a suite is added. Until then,
verify changes with the manual acceptance tests below, run against a dev
Firebase project with the current rules published.

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
  Invoices, Variations, Forecast, and Commercial** all show no data — reads are
  blocked by rules, not merely absent from the nav.
- [ ] The same user **can** still read company members' Projects, Cost Codes,
  Budget Lines, POs, and Progress Claims (the intended coarser read model).

### 17c. Write authorisation & delete-blocking

- [ ] A `subcontractor`/`client` role user cannot create or update POs, claims,
  invoices, variations, budget lines, or cost codes (rules reject the write).
- [ ] No client path can delete a financial/audit document (POs, claims,
  invoices, variations, budget lines, cost codes, contacts, counters, forecast
  lines, commercial baseline) — cancellation/rejection/archive is always a
  status/`isActive` change (the baseline is edited in place).

### 17d. Client-only controls are *not* a security boundary (known gaps)

These document current deferred limitations — a direct SDK call by an authorized
financial-role user can still bypass client checks (see SECURITY.md → Deferred
Controls). They are **expected** to be bypassable today; do not report them as
enforced.

- [ ] Lifecycle-transition legality, post-submission/`posted`/`approved`
  immutability, one-open-claim / one-invoice-per-claim races, creator ≠ approver
  segregation, counter integrity, and uniqueness are all client-enforced only.

### 17e. Secrets

- [ ] The built bundle (`frontend/dist/`) contains only public `VITE_*` values
  (Firebase web config). No Stripe/AI/email/service-account secret appears in the
  bundle or in any `VITE_`-prefixed variable.
