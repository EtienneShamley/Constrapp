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
- [ ] BOQ/Forecasting/Variations/Documents/Photos/Timeline/Reports tabs show placeholder cards, no data wiring.

## 3. Cost Codes

- [ ] Cost Codes tab (within a project) lists company-wide codes ordered by code.
- [ ] Create one (code + name required; category/unit optional) → appears in **every** project's Cost Codes tab and in PO/budget-line dropdowns.
- [ ] New codes are created `isActive: true`; there is no delete action.

## 4. Budget Lines

- [ ] With zero cost codes: Budget tab disables "Add Budget Line" and links to Cost Codes.
- [ ] Create a line (cost code + budgeted) → row shows Budgeted, zeros/— elsewhere, Remaining = Budgeted.
- [ ] Summary card shows Budgeted / Committed / Claimed / Actual / Remaining totals and a usage bar.

## 5. Purchase Orders

- [ ] With zero cost codes: PO tab disables creation and links to Cost Codes.
- [ ] Create a draft PO: supplier required, every line needs a cost code; line total = qty × rate; footer shows Subtotal, GST 10%, Total.
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

## 14. Responsive Checks — 375px, 768px, 1280px

- [ ] **375px:** sidebar hidden behind hamburger; drawer opens/closes (tap overlay); nav items ≥44px tall; project tab bar wraps; PO/claim tables scroll horizontally inside their card; modals fit with internal scrolling; all actions reachable by tap (no hover-only).
- [ ] **768px:** sidebar visible and static; two-column grids engage; modals centred with margin.
- [ ] **1280px:** dashboard/detail content capped at max-width 1280px; 4-column KPI grid; 5-column budget summary; no horizontal page scroll at any width.
