# Constrapp — Development Roadmap

## Guiding Principles

- Web-first. Mobile-ready via responsive layout from day one.
- PWA packaging and native mobile app after web MVP is validated.
- Firebase backend throughout — currently client SDK only; Cloud Functions/Hosting when needed.
- Each sprint ships working, demo-able software — no dead screens.

---

## Completed Foundations

- [x] Vite + React + Tailwind v4 scaffolding, dark theme design tokens
- [x] Responsive shell layout (sidebar drawer + topbar + content area)
- [x] **Authentication** — email/password sign-in, protected routes (signup/reset screens are stubs; users provisioned manually)
- [x] **Company/user foundation** — `users/{uid}` profile with `companyId` + `role`; company context throughout the app (the document is **client-read-only** since the User Profile Security Hardening below — ADR-27)
- [x] **Projects** — create, list, status badges, progress
- [x] **Project Detail** — tabbed layout (`/projects/:projectId/*`) hosting all project modules
- [x] **Cost Codes** — company-wide taxonomy (create, list)
- [x] **Budget Lines** — per-project allocations with read-time Committed/Claimed/Actual rollups
- [x] **Purchase Orders** — embedded line items, transactional numbering, forward-only lifecycle, committed-cost derivation
- [x] **Progress Claims** — cumulative claiming, one open claim per PO, assessment with partial approval, retention + GST
- [x] **Contacts** — company-wide directory (suppliers, subcontractors, consultants, clients; organisations + individuals), ABN validation, embedded contact people, duplicate warnings, archive/reactivate; PO supplier picker with quick-create writes `supplierId` + `supplierName` snapshot; Subcontractors page is a filtered contacts view
- [x] **Contact project assignments** — embedded `projectAssignments` (+ derived `projectIds`) on contacts; multi-project checkbox assignment on the contact form, project/unassigned filter, PO picker grouped "This project" / "Other company contacts", quick-create auto-assigns to the current project; no rules changes, no migration of existing contacts
- [x] **Supplier Invoices** — accounts-payable bills (`SI-0001`) via two paths: `direct_po` (against a sent/closed PO) and `progress_claim` (from one approved claim); per-line ex-GST amounts with per-line tax codes, retention carried from claims, `draft → approved → posted` lifecycle (posted immutable), duplicate + over-invoicing warnings, financial-role-only reads. Read-time derivation: Invoiced from posted/paid invoices, Committed matured to remaining open commitment, Actual replaces a source claim with its posted invoice (no claim mutation, no double-count). No Budget Line writes; no migration
- [x] **Variations (foundation)** — one type-discriminated collection (`variations`): **Client Variations** (`CV-0001`, head-contract revenue) and **Supplier Variations** (`SV-0001`, subcontract commitment, one/no PO), company-wide counters. Cost-code spine on every line, per-line tax codes (ex-GST canonical, derived GST, negatives supported), `draft → submitted → approved`/`rejected`/`withdrawn` lifecycle with unbounded per-line approval and required assessment notes on change. Approved-only, read-time: Approved Supplier Variations + **Commitment Exposure** (separate from Committed) on the Budget tab; approved Client Variations are revenue-side only. Financial-role-only reads. **No** Budget Line/PO/claim/invoice mutation; `progressClaims.variationId` stays `null` (claim/invoice linkage deferred); no uploads; no migration

- [x] **Forecast Cost to Complete (foundation)** — forward-looking, **strictly cost-side** control layer. Per-cost-code `forecastLines` keyed by a deterministic `costCodeId` document ID; the **only** stored input is `uncommittedCostToComplete` (`number | null`; `null` = not forecast, `0` = reviewed/no further cost, `< 0` rejected) plus notes and audit stamps. Everything else is derived at read time by composing the existing Budget-page helpers (`lib/forecast.js`): **Forecast Final Cost** = Actual + Remaining Committed + Uncommitted CTC; **Variance to Budget** = Budgeted − Forecast Final Cost. No automatic remaining-budget default (a Remaining Budget Reference backs an explicit "Use remaining budget" action). Approved/pending **supplier variation exposure shown separately, never added** to the forecast (variations don't yet mature). Cost-code union across budget/PO/actual/invoice/variation/forecast rows; closed-PO residual flagged, not removed. Living editable inputs (no approval/snapshots). Financial-role-only reads; deletes blocked (clear via `null`). **No** Budget Line/PO/claim/invoice/variation mutation; no migration

- [x] **Project Margin (foundation)** — the first revenue-and-margin layer, closing the "what profit do we forecast?" question. A dedicated **Project Commercial Baseline** document (`…/projects/{projectId}/commercial/baseline`, deterministic id `baseline`) stores the only authored inputs — `originalContractValue`, `originalApprovedBudget` (`number | null`), `contractStartDate`/`contractCompletionDate` (`Timestamp | null`), `clientId`/`clientName` snapshot, `notes`, audit stamps. Everything else is derived at read time (`lib/margin.js` composing `lib/variations.js` + `lib/forecast.js`): **Current Contract Sum** = Original Contract Value + Approved Client Variations; **Forecast Revenue** = Current Contract Sum; **Forecast Gross Profit** = Forecast Revenue − Forecast Final Cost; **Forecast Margin %**; **Original Planned Profit/Margin %**; **Margin Movement**. All ex-GST. Pending client variations stay separate revenue exposure; approved/pending supplier variations stay separate cost exposure and are **never** added to Forecast Final Cost. New **Commercial** project tab + financial-role-only margin cards on Overview (one shared derivation). Reads/writes restricted to financial roles via a rules block scoped to the single `baseline` document; delete blocked. **No** mutation of Projects/Budget Lines/POs/Claims/Invoices/Variations/Forecast Lines; no migration. **Deferred:** Cash Flow, Client Invoices, Accounts Receivable, Payments, retention modelling, monthly periods, snapshots, approvals, probability weighting. Currency remains the app's existing AUD display — see **Company Country & Currency** next.

- [x] **Company Country & Currency (foundation)** — Constrapp is no longer hard-coded to AUD. A company stores `countryCode` (ISO 3166-1 alpha-2) + `baseCurrency` (ISO 4217) + audit stamps, set on a new **Company Settings** page (`/settings/company`, `company_admin` only) reached from the sidebar company chip or a first-run setup banner: country **suggests** a currency, the admin **confirms or overrides** it, and every existing project is listed and **pinned** to an explicit currency in the same confirmed action (projects written first, then the company; additive and idempotent; **no amount converted**). Projects store `currency` (inherited from the company base currency, overridable at creation) and `currencyLocked`. Currency **locks** on any monetary value — non-zero `project.budget`, budget lines, POs (**including draft/cancelled**), claims, supplier invoices, variations, forecast lines with a non-null input, or an established commercial baseline; Cost Codes/Contacts never lock. One shared `formatCurrency(amount, currencyCode)` (`Intl.NumberFormat`, fixed `en-AU` locale, whole units) replaced **all 77** money call sites; the old `currency()` export was **deleted** so a missed site is a build error. POs/claims/invoices/variations now snapshot the resolved project currency as **audit context** (never displayed; historical `'AUD'` never rewritten). Rules: `company_admin` may update **four company currency fields only** (`affectedKeys().hasOnly`, create/delete still blocked); the currency **ratchet** is rules-enforced once set (no currency change, no unlock); `qs` gets one narrow permission — `currencyLocked` `false`→`true` and nothing else. Lock activation is **atomic**: every monetary write engages the ratchet inside its own Firestore transaction (`hooks/projectCurrencyLock.js`), so record and lock commit or roll back together. **Client-enforced (deferred):** deciding the lock should engage, since rules cannot enumerate random-id subcollections. **No FX conversion, no mixed-currency transactions, no migration** (unconfigured companies display AUD and show the banner; nothing auto-written). **Tax is NOT in scope** — GST stays a flat Australian 10% and Company Settings warns for any non-AU country

- [x] **Client Invoices / Accounts Receivable (foundation)** — the revenue-side register, answering "what have we invoiced, what remains available to invoice, and when was it due?" Project-scoped `clientInvoices` (`CI-0001` from a company-wide counter), controlled against the **Current Contract Sum** and **approved client variations** — never against a PO, claim, or supplier. Lifecycle `draft → issued → void` (void terminal, non-empty reason required; `sent` reserved). Lines are amount-only, ex-GST, with the existing per-line tax codes; `costCodeId` is **optional** (contract revenue sits above the cost-code spine, ADR-22) and a variation line inherits a cost code only when its variation resolves to exactly one. Read-time derivation: **Issued Client Invoices**, **Available to Invoice**, per-variation invoiced/remaining, and **ageing by due date** — nothing written back to the baseline, variations, or Budget Lines. Client identity (name, legal name, ABN, email, phone, address) and payment terms are **snapshotted** at creation; the due date is suggested from the client contact's terms with the source **named in the UI**, blank when no terms exist. Over-invoicing (contract and per-variation) is **warned with an explicit acknowledgement, never blocked**. Pending client variations are not invoiceable; negative approved ones reduce the contract sum but cannot be invoiced. **First collection whose lifecycle and post-issue immutability are enforced by Firestore rules** — the intended future standard for the others. Invoice creation, number allocation, and the project-currency ratchet commit in **one transaction**. An optional authored `externalInvoiceReference` ties a record to the invoice actually issued from Xero/MYOB/QuickBooks. Lives under the **Commercial** tab (Margin | Client Invoices); the supplier tab is relabelled **Supplier Invoices**. Financial-role-only reads; deletes blocked. **No** payments, receipts, paid status, credit notes, retention, revenue recognition, printable/PDF/email output, or "Tax Invoice" labelling — company legal name and ABN do not exist, so Constrapp cannot produce a compliant Australian Tax Invoice. No migration

- [x] **Client Receipts (foundation)** — the settlement half of accounts receivable and Constrapp's **first real cash record**. Project-scoped `clientReceipts` (`CR-0001` from a company-wide counter) storing **gross cash received** — `receiptDate`, `amount`, an explicitly-chosen `paymentMethod` (never defaulted; `other` requires a description), optional bank/external references — with **embedded `allocations[]`** (`clientInvoiceId` + frozen `invoiceNumber` + `allocatedAmount`) against issued Client Invoices. `clientId`/`clientName` are **required non-empty** (rules-enforced): unlike every other counterparty link, a receipt with no client is not a record. Lifecycle `draft → posted → void` (void terminal, non-whitespace reason), **rules-enforced** with posted receipts immutable — the second collection to meet the ADR-22 standard. **Read-time derivation:** Received to Date, Remaining to Reconcile, reconciliation state (*unreconciled / partly / fully / over-reconciled*), receipt summaries, and the corrected AR ageing — **nothing written onto a Client Invoice**, which gains no balance field, no payment status, and no back-reference, so voiding a receipt restores every balance with **no reversal record**. **AR ageing corrected** to age the *remaining* balance: fully reconciled invoices leave ageing, partially reconciled ones age only their remainder, over-reconciled ones are excluded into a signed callout, and the pre-Receipts disclaimer is replaced by the limits that genuinely remain. Unallocated receipts are permitted, reported separately as money on account, and **never auto-applied** (an explicit *Allocate oldest first* action yields an editable proposal). Over-allocating an **invoice** is warned with an acknowledgement, never blocked; over-allocating the **receipt** is hard-blocked and its scalar arithmetic (`allocatedTotal + unallocatedAmount == amount`, compared in **whole cents** via `math.round`, because IEEE-754 rejects `0.10 + 0.20 == 0.30`) is **rules-enforced**. An invoice voided *after* a posted allocation surfaces as an **exception**, never auto-reversed. Counter, receipt, and the project currency ratchet commit in **one transaction**. Shared, direction-agnostic `lib/payments.js` + AR adapter `lib/clientReceipts.js`; new **Receipts** sub-view on the Commercial tab (Margin · Client Invoices · Receipts). Financial-role-only reads; deletes blocked. **⚠️ Cash is not revenue** — no GST, no tax code, no net amount; the six budget figures, Forecast, and Margin are unchanged. **No** Supplier Payments, cash flow, refunds, bank reconciliation, accounting integration, attachments, or remittance output. **Supplier invoice `paid`/`paidAt` were NOT touched** — they stay reserved and unused. No migration

- [x] **Supplier Payments (foundation)** — the money-out mirror of Client Receipts, closing the cash picture. Project-scoped `supplierPayments` (`SP-0001` from a company-wide counter) storing **gross cash paid** — `paymentDate`, `amount`, an explicitly-chosen `paymentMethod` (never defaulted; `other` requires a description), optional bank/remittance/external references — with **embedded `allocations[]`** freezing **both** invoice references (`supplierInvoiceId` + Constrapp's `invoiceNumber` + the supplier's own `supplierInvoiceNumber` + `allocatedAmount`) against **posted** Supplier Invoices. `supplierId`/`supplierName` are **required non-empty** (rules-enforced), while supplier *invoices* with a legacy `supplierId: null` are matched on their frozen `supplierName` and **never backfilled**. Lifecycle `draft → posted → void` (void terminal, non-whitespace reason), **rules-enforced** with posted payments immutable — the third collection to meet the ADR-22 standard. **Allocations reconcile against `payableTotal`, never `grossTotal`** — retention withheld is not payable, and no payment writes, clears, or reduces a retention field (retention release stays unmodelled). **Read-time derivation:** Paid to Date, Remaining Payable, reconciliation state (*unreconciled / partly / fully / over-reconciled*), payment summaries, and **AP ageing on the remaining payable** — **nothing written onto a Supplier Invoice**, which gains no balance field, no payment status, and no back-reference, so voiding a payment restores every balance with **no reversal, refund, or bank-reversal record**. Only **posted** invoices are payable (`approved` is not the financial commit point). Unallocated payments are permitted, reported separately as money on account, **never auto-applied** (an explicit *Allocate oldest first* action yields an editable proposal) — and their **full amount is still actual Cash Out**. Over-reconciling an **invoice** is warned with an acknowledgement, never blocked; over-allocating the **payment** is hard-blocked and its scalar arithmetic is **rules-enforced** in whole cents. A posted invoice cancelled *after* an allocation surfaces as an **exception**, never auto-reversed. Counter, payment, and the project currency ratchet commit in **one transaction**. Shared `lib/payments.js` reused **entirely unchanged** + AP adapter `lib/supplierPayments.js`; new **Supplier Payments** sub-view on the Commercial tab (Margin · Client Invoices · Client Receipts · Supplier Payments — the Receipts *label* widened, its route unchanged). Supplier Invoices gain read-time Paid to Date / Remaining Payable / reconciliation badge, an allocated-payments detail modal, a *Record payment* action, a compact AP summary, an exceptions panel, and **payment-aware past-due** (`isPastDuePayable`; the date-only `isOverdue` is retained unchanged with a warning JSDoc). **⚠️ `SI_STATUS.PAID` and `paidAt` are DEPRECATED IN PLACE, not activated** — comments and documentation only; no stored value, constant, transition map, counting status, document, or supplier-invoice rules block changed. `paid` deliberately stays in `SI_COUNTING_STATUSES` so a direct-SDK-forged document cannot vanish from Invoiced/Actual. Financial-role-only reads; deletes blocked. **⚠️ Cash out is not cost** — no GST, no tax code, no net amount; the six budget figures, Forecast, and Margin are unchanged. **No** cash-flow UI, retention release, supplier credit notes, refunds, reversals, payment runs, remittance output, email, attachments, bank reconciliation, or accounting integration. No migration

- [x] **Actual Cash Flow (foundation)** — the first Cash Flow output, and deliberately **actual-only**: recorded cash movement, no forecast. A new **Cash Flow** sub-view on the Commercial tab (`…/commercial/cash-flow` — the fifth sub-tab; no new project tab, no new collection, **no Firestore rules change**) reads posted Client Receipts (Cash In, by `receiptDate`) and posted Supplier Payments (Cash Out, by `paymentDate`) through the existing hooks and derives everything at read time in a new pure module (`lib/cashFlow.js`): **Actual Cash In / Cash Out / Net Cash** (total transaction `amount`, **never `allocatedTotal`** — an unallocated advance is still cash that moved), monthly rows grouped by `date.slice(0, 7)` (`'YYYY-MM'` keys, lexicographic order, **no Date construction**), a **dense** month range with zero rows for gap months, and a **cumulative position starting from ZERO** — net project cash movement, explicitly **not a bank balance** (no bank account, opening balance, or financing is modelled, and the page says so permanently). Drafts and voids count nothing. Unallocated cash in/out is reported separately as *on account* via the existing `receiptSummary`/`paymentSummary` derivations, never netted. A separate **Commercial context (accrual, ex-GST)** panel shows Current Contract Sum / Forecast Revenue / Forecast Final Cost / Forecast Gross Profit / Forecast Margin % through the same shared `lib/margin.js` composition — clearly labelled, never added to any cash figure. `lib/clientReceipts.js` gains **`cashInRows()`**, the money-in mirror of `cashOutRows()`. First **unit-test suite** added for pure domain logic (`npm run test:unit`, Vitest, `tests/unit/` — separate from the emulator rules suite): 51 tests over month keys, grouping, statuses, unallocated amounts, date discipline, dense ranges, cumulative arithmetic, cent rounding, and purity. Financial-role-only (existing rules on the collections read are the boundary — this branch adds **no write surface**). **⚠️ Not included (deferred to the next branches):** Forecast Cash In/Out, invoice due-date collections, manual monthly timing (`cashFlowLines`), untimed AR/AP, completeness, peak funding, projected closing position, charts, date filtering, scenarios, opening-balance input, GST/BAS modelling, retention-release forecasting, exports. No migration

- [x] **Forecast Cash Flow (foundation)** — the second Cash Flow branch, adding projection on top of the actual foundation. Three read-time layers, with a single load-bearing rule: **months before the current month are ACTUAL ONLY**, so no forecast amount — automatic or manual — ever lands in a past month and an actual can never be double-counted with the forecast it fulfilled. **Layer 2 (automatic, near-term):** positive remaining balances on **issued** Client Invoices (gross, inc. GST) and **posted** Supplier Invoices (`payableTotal`, already net of retention), each timed by `dueDate` **month**; balances that are past due or carry no due date are **never guessed into a month** — they wait in dedicated untimed buckets; over-reconciled balances are excluded into a signed callout and never offset an expected amount. **Layer 3 (manual, longer-term):** a new authored `cashFlowLines` collection (`…/projects/{projectId}/cashFlowLines/{lineId}`, random ids, **no counter**) storing an expected **gross** `amount` plus, separately, the **ex-GST `sourceAmountExGst`** it represents — coverage only, never a cash column. Allowed sources are `contract_revenue` + `manual` (in) and `uninvoiced_claim` / `remaining_committed` / `uncommitted_ctc` + `manual` (out); **`client_invoice` and `supplier_invoice` are deliberately excluded** so an invoice balance can never be timed both automatically and manually (retiming is reserved for a later branch). Cost-side lines carry the **cost-code spine** (`costCodeId` + frozen `costCodeName`); `sourceId` is not stored. **⚠️ Corrected cost model:** approved-claim cost awaiting a supplier invoice sits **inside** Remaining Committed, so `D_cost = Remaining Committed + Uncommitted CTC` (= Cost to Complete — the figure the Forecast tab already publishes) and `uninvoiced_claim` coverage counts against the **same** cost-code committed balance; it is shown only as a labelled breakdown (*"Approved claim awaiting invoice — included within Remaining Committed"*), never as an additive second denominator. Combined over-coverage is **warned with an explicit acknowledgement, never blocked** (rules cannot sum sibling lines). Lifecycle `active → active` / `active → void` (terminal, non-whitespace reason), **rules-enforced**; delete blocked; **no post status, no approval, no period locking**. Creating or retiming a line into a **past month is blocked in the client** (rules validate the `YYYY-MM` shape but have no calendar); existing lines become **stale** naturally as the calendar advances, are excluded from every total, and surface in a stale panel to be retimed forward or voided — never silently moved or deleted. Outputs: projected monthly rows (Actual / Forecast / Total per direction), **projected cumulative position from zero**, projected closing position, revenue and cost **completeness** (`null` — never 0% or 100% — when a basis is unavailable), **untimed reporting on three separate bases** (gross cash · ex-GST source value · informational exposure, never summed together), and **peak funding** with an **earliest-month-wins** trough that is **suppressed** whenever significant amounts remain untimed or a basis is unavailable (a lower bound only is then shown). **Retention withheld and unallocated cash produce prominent warnings but never suppress** — retention release is unmodellable, so suppressing on it would disable peak funding permanently. Creation is atomic with the project **currency ratchet** (a timing line is monetary data; voided lines remain lock evidence). **Subscription-error hardening:** six hooks (`useBudgetLines`, `usePurchaseOrders`, `useProgressClaims`, `useSupplierInvoices`, `useVariations`, `useForecastLines`) gained additive error flags so a failed read is shown as **unavailable, never as a genuine zero**. Unit suite expanded to **130 tests**; new `cashFlowLines` emulator suite (**58 tests**, rules total **181**). Financial-role-only; the new rules block is purely additive. **⚠️ Not included:** charts, date filtering, invoice retiming, scenarios, opening-balance input, financing, retention-release modelling, GST/BAS forecasting, bank/accounting integrations, exports. **No source financial document is written.** No migration

- [x] **Cash Flow visualisation** — the third and final Cash Flow branch, and deliberately **presentation-only**: it adds no formula, no collection, no write, no route, no hook, no dependency and **no Firestore rules change**. A new page-local `CashFlowChart` (`pages/project/cashFlow/CashFlowChart.jsx`) sits between the summary Cards and the existing monthly table, consuming the **already-derived** `combinedRows`, `nowMonth`, `pf`, `suppression` and `forecastUnavailable` that `ProjectCashFlow.jsx` computes — it never regroups, re-sorts, re-rounds, re-sums, or recalculates a cumulative position, peak funding, invoice balance or completeness figure, and it never calls `currentMonthKey()` (the app keeps **one** clock). **Two panels sharing one chronological X domain, never a dual axis** (ADR-26): **Panel A** plots diverging stacked bars — Cash In above the zero baseline, Cash Out below it via a **display-only negation** that never surfaces as a negative figure to the reader — where **hue encodes direction** (`brand-accent` in, `brand-purple` out) and **texture encodes state** (solid actual, 45° hatch forecast), so actual-vs-forecast survives greyscale, print and forced-colors; **Panel B** plots the existing cumulative position from its **zero opening position** with an emphatic zero reference line and the sub-zero region shaded `brand-red` — one line colour, no threshold gradient and no second scale. The current month is marked on both panels from the row's existing `isPast` flag. **Honesty rules are enforced in tested code, not by convention:** a past month's forecast and any figure a failed source made unavailable become **`null`, never `0`** (Recharts skips a null and draws a zero, so the distinction is the whole contract), the cumulative line **breaks rather than bridges** across an unavailable stretch, the forecast region is not drawn when a forecast source failed, and the **peak-funding marker is plotted only when the figure is fully authoritative** — suppressed, non-negative and forecast-unavailable states plot **no marker at all**, and the qualified lower bound is deliberately **not** plotted because a chart mark reads as confirmed regardless of its caption. A custom tooltip shows all eight monthly figures through the existing `formatCurrency` (unavailable renders "—", never "$0"; Cash Out reads positive). Every colour is an existing token referenced as `var(--color-brand-*)` — **no token value changed and no hex hard-coded**, deliberately not repeating the recorded `Dashboard.jsx` styling debt. SVG hatch pattern ids are namespaced with React `useId()` (no effects, no state). Each month occupies a fixed 44px slot inside **one shared horizontal scroll container**, so both panels scroll together and multi-year projects stay readable instead of compressing; panels align via identical margins and a fixed Y-axis width. Accessibility: Recharts `accessibilityLayer` for keyboard tooltip traversal, per-panel `aria-label`s, a textual legend, and a **visible textual summary** generated by tested logic that degrades honestly when the forecast is unavailable, when peak funding is suppressed, when no shortfall exists, and when only actual data exists. **The existing monthly table remains the exact numeric record and the accessible equivalent** — the chart is never the only path to the data, and it is not rendered at all when there is no cash-flow data (the page's own empty state stands). New pure module `lib/cashFlowChart.js` holds **every** display decision (sign flip, unavailability nulling, boundary location, marker eligibility, layout width, summary) with **zero financial arithmetic**, which is what makes it unit-testable in the existing Node-only runner: unit suite **130 → 173 tests** (`tests/unit/cashFlowChart.test.js`, 43 tests) with **no jsdom, no testing-library and no vitest config change**. **⚠️ Not included:** date-range filtering, chart export/PDF, chart-based editing or drag-to-retime, scenarios, company-wide cash flow, opening-balance input, bank integration. No migration

- [x] **User Profile Security Hardening** — a small, purely defensive prerequisite closing the gap that capped every other control in the app. The `users/{uid}` membership document was readable **and writable** by its owner with no field constraint, while every other rules block authorises by `get()`-ing that same document for `companyId` (the multi-tenancy anchor) and `role` (every write gate). One direct SDK call therefore allowed **self-promotion** to `company_admin` — every financial write plus every financial-role read — and **tenant escape** by rewriting `companyId`; `write` also expands to `delete`, and a bare Auth account could **mint its own membership** with any company and role or pre-seed arbitrary privilege-bearing fields. The block is now **client-read-only**: a user reads their own profile, and `create`, `update` and `delete` are all blocked (ADR-27). There is deliberately **no harmless-field allow-list** — not even `name` or `avatarInitials` — because no profile-editing feature exists to need one, and blocking outright cannot drift the way a maintained allow-list can; and **no admin user management** was introduced (`company_admin` has no special power here, asserted by test). Membership is **provisioned out of band** (Firebase console / admin tooling, whose admin credentials bypass rules), which is exactly how it already worked: the only `users/` reference in `frontend/src` is the **read** in `hooks/useProfile.jsx`, so **zero application files changed** — the diff is one rules block, one new test suite, and documentation. New `users` emulator suite (**26 tests**, rules total **181 → 207** across 5 files); `users/{uid}` was previously the only collection with no rules coverage despite being the most security-critical. Three of those tests are **non-regression proofs** that rules-internal `get()` **bypasses** Security Rules, so the other ~40 membership lookups are unaffected. Lint held at its accepted 17 errors / 0 warnings and the unit suite at 173 — no `frontend/src`, `package.json`, `firebase.json`, or vitest-config change. **⚠️ Two honest limits:** the rule prevents **future** tampering and does **not** revert **past** tampering (every stored `role`/`companyId` must be reviewed in the console before publishing), and **Deferred Control 17 is NOT solved** — a user *provisioned into* a financial role can still fabricate cash records; what changed is that nobody can **grant themselves** that role. **Consequence to plan around:** self-serve signup, invitations, and user administration can no longer be built on client-side membership creation and now **require a trusted backend** (Admin SDK). No migration

- [x] **Project Timeline (foundation)** — the project **programme**, and Constrapp's first **non-financial** project collection. Delivered **out of the recorded roadmap order** (Timeline sits in item 10) with product-owner approval, because Documents & Drawings — the branch that would otherwise be next — is parked pending Firebase Storage production setup, and Timeline is **completely independent of Storage** (no upload, no file, no drawing, no Quant™). Project-scoped `activities` (random ids, **no counter, no number, no currency**) storing `name`/`description`, an `isMilestone` flag, a five-state `status`, **date-only `'YYYY-MM-DD'`** planned start/finish (finish **inclusive**) and optional actual start/finish, an **integer 0–100 `percentComplete`**, an optional responsible **Contact** (`responsibleContactId` + frozen `responsibleName`), an **optional `costCodeId` + frozen `costCodeName`** — the commercial-spine link — plus `sortOrder`, `notes`, cancellation stamps and audit stamps. **Milestones are a flag, not a second collection**: `plannedFinish == plannedStart`, progress restricted to 0/100, derived duration **0 days**. Everything else is derived at read time (`lib/projectTimeline.js`): calendar duration, overdue, days late, days until due, the horizon grouping (Overdue · This week · Upcoming · Later · Completed/Cancelled), the four summary counts, filtering and a **deterministic sort** (`sortOrder`, then planned start, planned finish, name, id — because `sortOrder` is **not unique** and rules cannot make it so). **Lifecycle is deliberately NOT forward-only** — an explicit departure from **ADR-11**: any non-cancelled status may move to any other, **including backwards** (`completed → in_progress`), because a programme is a plan that gets corrected, not an audit record. **`cancelled` is terminal**, requires a non-whitespace reason, and rules restrict the write to the cancellation keys so no content edit rides along; **delete is blocked** (ADR-12 posture). **Rules-enforced:** the exact field set (`keys().hasOnly()` + `hasAll()` — the ADR-27 lesson applied preventively), the closed status set, ISO date shape, `plannedFinish >= plannedStart`, milestone same-day, `actualFinish >= actualStart`, integer percentage 0–100, the milestone 0/100 rule, the `not_started`/`in_progress`/`completed` invariants, both-or-neither reference pairs, immutable `createdAt`/`createdBy`/`revision`, server-stamped audit fields, and cancelled-terminality. **Permissions:** read `company_admin`/`project_manager`/**`qs`**; write `company_admin`/`project_manager` **only** — **the one place QS is read-only** — and `subcontractor`/`client` denied entirely, because those roles are not scoped to their own projects (a read grant would expose every programme in the company). Desktop: four summary cards, four minimal filters, a **read-only Gantt** (calendar-day grid in one horizontal scroller, month/week ticks, today line, milestone diamonds, progress fill, clipped-bar edges) and the full activity table — **the table stays the exact record and the accessible equivalent** (the ADR-26 chart/table contract reused). **Mobile does NOT render the Gantt at all**; grouped activity cards replace it. **No new dependency** — a Gantt is date arithmetic plus positioned rectangles, and all geometry lives in a pure `lib/timelineGantt.js` so it is unit-testable in the existing Node-only runner (**no jsdom, no testing-library, no vitest config change**). **⚠️ Current-plan programme, NOT approved-baseline variance:** no immutable baseline exists, so "overdue" means late against the dates as they stand now, and the page states permanently that it cannot report slippage against an approved programme. **⚠️ Progress is manually authored, unverified, and financially inert** — never derived from dates, child tasks or Progress Claims (coupling them would create a second source of financial truth, the failure ADR-23/ADR-24 prevent), and it feeds no budget, forecast, margin or cash figure. **No financial document is written, `projects/{projectId}.progress` is untouched, and no currency ratchet is engaged** (an activity holds no money, so creation needs no transaction). Unit suite **173 → 285**; new `activities` emulator suite (**66 tests**, rules total **207 → 273** across 6 files), including tests that *prove* the client-only gaps (an impossible-but-well-shaped date, an id naming nothing, duplicate `sortOrder`, last-write-wins). Lint held at its accepted 17 errors / 0 warnings. **⚠️ Not included:** dependencies, critical path, automatic rescheduling, WBS/hierarchy, baseline/re-baseline, working calendars and public holidays, resource levelling, drag-to-reschedule, calendar view, print/PDF export, MS Project/Primavera import-export, progress-claim linkage, variation/EOT time impact, `project.progress` derivation, automatic Forecast/Cash Flow effect, notifications, IQ™ prediction, drawings/photos/attachments, comments, and a full audit-history system. No migration. **ADR-29** *(ADR-28 is reserved for the parked Documents & Drawings branch — see below).*

Firestore security rules for all of the above are written in `frontend/firestore.rules` and published manually.

**⚠️ Numbering note.** **ADR-28** and **docs/TESTING.md §15o** are **reserved for Documents & Drawings**, which is implemented on the parked `feature/documents-drawings-foundation` branch and will appear when that branch merges. Project Timeline therefore uses **ADR-29** and **§15p**, and the numbering skips 28/15o on this branch deliberately — reusing them would collide on merge and overwrite the Documents & Drawings records.

---

## Documentation Sprint — Current

Bring documentation in line with the implemented system:

- Corrected root docs (AGENT, README, PRODUCT, ROADMAP) + new CLAUDE.md
- New `docs/`: ARCHITECTURE, DATA_MODEL, FINANCIAL_WORKFLOWS, SECURITY, TESTING, DESIGN_SYSTEM, PROJECT_DECISIONS, DEPLOYMENT

---

## Known Gaps & Deferred Work

**Placeholders (screens exist, no functionality):** PULSE™, SHIELD™, and the BOQ, Documents, Photos, and Reports project tabs. (The Timeline tab is now live — Project Timeline foundation.) Dashboard KPIs/charts are partly static. Subcontractors shows the live contacts directory but its IQ™ scoring is a placeholder. None of these are complete. (The Forecast tab is now live — Forecast Cost to Complete foundation.)

**Deferred security hardening** (client-enforced today, server enforcement deferred — full list in [docs/SECURITY.md](docs/SECURITY.md)):

- Server-enforced lifecycle transitions and post-submission immutability
- One-open-claim race protection
- Creator ≠ approver segregation
- Supplier-scoped subcontractor access
- Counter tamper protection
- Audit logging
- Client-invoice **Available to Invoice** and per-variation limits (rules cannot
  sum sibling documents, so over-invoicing is warned, never blocked, and
  concurrent invoicing of the same remaining value is possible)
- Client-receipt **allocation integrity** — rules cannot iterate an array or sum
  sibling documents, so `allocatedTotal` vs the array sum, invoice existence/
  status/client-match, over-allocation, and concurrent allocation of the same
  balance are all unverified server-side (the *scalar* amount invariant **is**
  rules-enforced). Posting a future-dated receipt is blocked in the client only
- Company legal name / ABN / address / tax number — absent, so Constrapp cannot
  produce a compliant Australian Tax Invoice

- Supplier-payment **allocation integrity** — the AP twin of the client-receipt
  item above: rules cannot iterate an array or sum sibling documents, so
  `allocatedTotal` vs the array sum, invoice existence/status/project/supplier
  match, the **`payableTotal` basis and the retention exclusion**,
  over-reconciliation, and concurrent allocation of the same remaining payable
  are all unverified server-side (the *scalar* amount invariant **is**
  rules-enforced). Posting a future-dated payment is blocked in the client only

*Note:* `clientInvoices`, `clientReceipts` and `supplierPayments` are the
collections whose lifecycle transitions and post-commit immutability **are**
rules-enforced — the intended future standard for purchase orders, claims,
supplier invoices, and variations. The gap is not academic: because posted
supplier invoices are **not** yet protected, a direct-SDK caller can cancel one a
payment has already settled (surfaced as an allocation exception) or forge
`status: 'paid'` on one (ADR-24).

**Other deferred foundations:** user management UI (invite, assign role/company), project edit/delete (currency is the only project field editable after creation), self-serve signup and password reset, Firebase CLI config (`firebase.json`/`.firebaserc`), Hosting, CI.

⚠️ **User management, invitations, and self-serve signup now have a hard prerequisite.** Since ADR-27 made `users/{uid}` client-read-only, none of them can create a membership document from the browser — each requires **trusted provisioning** (a backend using the Admin SDK). Do not reopen client writes to `users/{uid}` to unblock them; see [docs/SECURITY.md](docs/SECURITY.md) → Deferred Control 8 and Trusted-Backend Activation Requirement 3.

**Country-specific tax configuration** — currency display is configurable as of
the Company Country & Currency foundation, but **tax calculation is not**:
`GST_RATE` is a flat Australian 10% and every "GST 10%" label is Australian.
NZ GST 15%, ZA VAT 15%, UK VAT 20%, and US sales tax are **not** supported.
Company Settings warns about this for any non-AU country. A tax-regime foundation
must land before Constrapp can claim tax compliance in those markets.

---

## Development Order

The sequence closes the commercial-control loop first (the back half of the lifecycle is already in the schema), then completes the preconstruction side (the front half), then layers intelligence and commercially linked field features. Each item integrates through the cost-code spine.

**1. Variations** — *foundation shipped (see Completed Foundations).*
One type-discriminated `variations` collection (Client/​Supplier), cost-code spine,
approved-only read-time derivation, and a **Commitment Exposure** figure kept
separate from Committed. **Remaining (deferred to a follow-up phase):**
claim-against-variation and invoice-against-variation linkage (activating the
reserved `progressClaims.variationId` and maturing variation commitment against
claims/invoices). The foundation deliberately does not fold variations into the
canonical Committed formula until that linkage lands.

**2. Forecast Cost to Complete** — *foundation shipped (see Completed Foundations).*
Per-cost-code `forecastLines` (deterministic `costCodeId` IDs) with a single manual
input (Uncommitted Cost to Complete), read-time Forecast Final Cost / Variance to
Budget, no automatic remaining-budget default, and supplier-variation exposure kept
strictly separate from the forecast total. **Remaining (deferred):** reporting
periods, immutable monthly snapshots, prior-period comparison, and any approval
workflow — the current forecast is a living editable input until those land.

**3. Project Margin** — *foundation shipped (see Completed Foundations).*
Project Commercial Baseline + read-time margin derivation (Current Contract Sum,
Forecast Revenue, Forecast Gross Profit/Margin %, Original Planned Profit/Margin %,
Margin Movement), all ex-GST, on a new Commercial tab. **Remaining (deferred):**
cash-flow forecasting (see item 3c), manual/probability-weighted revenue forecast,
and immutable margin period snapshots.

**3a. Company Country & Currency** — *foundation shipped (see Completed Foundations).*
Company `countryCode`/`baseCurrency`, project `currency`/`currencyLocked`, a
Company Settings page with confirmed setup and existing-project pinning, the
currency ratchet, and one shared `formatCurrency` across every financial screen.
**No FX conversion** — a project reports in one currency and a currency is a label,
never a conversion. **Remaining (deferred):** server-derived lock activation and
known-code validation in rules (both need a trusted backend), per-country display
locales, **date localisation** (`formatDate` is still `en-AU`, a known limitation
for US users), self-serve company signup (the settings form is built to be reused
as a signup step), and — importantly — **country-specific tax configuration**:
this foundation makes currency *display* configurable but leaves GST a flat
Australian 10%, so selecting NZ/ZA/US/GB does **not** make Constrapp tax-compliant
there. That is the honest prerequisite for genuinely serving those markets.

**3b-i. Client Invoices / Accounts Receivable** — *foundation shipped (see Completed
Foundations).* Client-side billing controlled against the Current Contract Sum and
approved client variations, with read-time Available to Invoice, per-variation
balances, and ageing by due date. **Remaining (deferred):** client retention,
credit notes, client progress claims, revenue recognition, printable/PDF/email
output, company legal & tax identity (the prerequisite for a compliant Australian
Tax Invoice), and contract-level payment terms on the commercial baseline.

**3b-ii. Client Receipts** — *foundation shipped (see Completed Foundations).*
Cash received from clients, allocated against issued client invoices, turning
"issued, not yet reconciled" into a real receivables balance. Balances are
**derived at read time** from receipt records — no payment field was ever
reserved on the client invoice (ADR-22), and none was added (ADR-23).

**3b-iii. Supplier Payments** — *foundation shipped (see Completed Foundations).*
The money-out mirror, reusing the shared `lib/payments.js` foundation entirely
unchanged: project-scoped `supplierPayments` (`SP-0001`), embedded allocations
against **posted supplier invoices' `payableTotal`** (*not* `grossTotal` —
retention is withheld and is not payable on that invoice), read-time **Paid to
Date** and **Remaining Payable**, and AP ageing on the remaining balance.
**The reserved supplier-invoice `paid` status and `paidAt` field were DEPRECATED
IN PLACE, not activated** (ADR-24) — payment state derives from allocations, and
activating them would create a second, contradictory source of payment truth.
Only comments and documentation changed; `paid` stays in `SI_COUNTING_STATUSES`
deliberately, because supplier-invoice lifecycle rules remain deferred and a
direct-SDK-forged `paid` document must not vanish from Invoiced/Actual.
**Remaining (deferred):** retention release, supplier credit notes, refunds and
payment reversals, payment runs/batches, remittance output, and bank
reconciliation.

**3c. Cash Flow** — *All three branches shipped (see Completed Foundations).*
The approved three-branch sequence was:

- **3c-i. Actual Cash Flow foundation** — *shipped.* Route, monthly actual
  table, cumulative-from-zero position, unallocated-cash reporting, commercial
  context panel, `cashInRows()`, `lib/cashFlow.js`, and the first unit-test
  suite. Consumes the **total transaction amount** on the **transaction date**
  (`receiptDate`/`paymentDate` — never `createdAt`/`postedAt`, never
  `allocatedTotal`), and never sums across currencies.
- **3c-ii. Forecast Cash Flow** — *shipped (see Completed Foundations).*
  Automatic invoice due-date forecasting both directions, the manual monthly
  timing model (`cashFlowLines`), untimed reporting on three separate bases,
  completeness, projected closing position, and peak funding with
  untimed-suppression.
- **3c-iii. Cash Flow visualisation** — *shipped (see Completed Foundations).*
  A two-panel chart on the existing Recharts dependency, consuming the derived
  monthly rows without re-deriving anything. **Date-range filtering was NOT
  included** and remains open. **Invoice retiming** — letting a past-due invoice
  balance be manually moved to a future month via reserved
  `client_invoice`/`supplier_invoice` source types — is a separate follow-up.

The recorded sequence is **Actual Cash Flow foundation shipped → Forecast Cash
Flow shipped → Cash Flow visualisation shipped.** Remaining Cash Flow work is
**date filtering** and **invoice retiming**.

**4. BOQ and Estimating**
Opens the preconstruction side: a Bill of Quantities against cost codes, with rates/margin/overheads producing an estimate that transfers to an approved budget.

**5. Tender Packages, Subcontractor Invitations, and Bid Levelling**
Tender packages built from the BOQ, subcontractor invitations, and bid comparison/levelling by cost code, feeding award → commitment.

**6. Manual QS Takeoff connected to BOQ quantities**
Measured quantities populate BOQ quantity lines by cost code. Manual takeoff must exist before Quant™ AI — the AI accelerates an established pipeline rather than inventing one.

**7. Credit Notes and Retention Release**
Supplier credits (`docType`/`adjustsInvoiceId`) and retention release. Supplier
payments themselves moved forward to item 3b-iii, alongside Client Receipts,
because Cash Flow depends on them, and **shipped there**. **The `paid`/`paidAt`
fields were deprecated in place, not activated** — see 3b-iii and ADR-24.
Retention release is the outstanding piece: a payment settles `payableTotal`,
which is already net of retention, so retained money has no route to becoming
payable until this lands.

**8. Final Account and Commercial Reporting**
Reconcile approved budget, variations, and actual cost into final project margin; commercial reporting on margin, cost-to-complete, cash flow, and final account (not a generic export builder).

**9. Intelligence layer**
Constrapp PULSE™ (commercial health), IQ™ (schedule/variation/accountability intelligence), SHIELD™ (commercial audit and assurance), and Quant™ (AI takeoff into BOQ quantities). Each reads the commercial spine; all remain placeholders until this sprint.

**10. Commercially linked field modules**
Drawings (drawing measurement → BOQ quantity), Site Photos (→ progress/claim evidence), Timeline (delay → forecast impact). Each lands only with its commercial input/output defined.

**Timeline shipped early from this item** — see Completed Foundations. It was
brought forward with product-owner approval because Documents & Drawings is
parked pending Firebase Storage production setup and Timeline needs no Storage.
Its commercial linkage is established **structurally** (the optional
`costCodeId` spine link) and **no derivation is implemented**: `delay →
forecast impact` remains future **read-time** intelligence composed from the
programme and the existing commercial derivations, never a duplicated authored
commercial value. **Remaining (deferred):** baseline/re-baseline and slippage
against an approved programme, dependencies and critical path, working
calendars, progress-claim comparison, variation/EOT time impact, and the
forecast/cash-flow delay derivation itself.

### Also tracked (not lifecycle-ordered)

- Budget burn bar and variance indicators; project edit
- User management (invite, assign role, assign company)
- Subcontractors module — linked to contacts and cost codes

## Anti-Goals (out of scope without an approved strategy change)

Constrapp is the connected commercial operating system for construction — **not a Dashpivot-style form-first platform**. The following are deliberately not on the roadmap:

- Generic no-code form builders
- Large HSEQ template libraries
- Generic field reporting
- Payroll or broad workforce management
- Fleet or equipment management
- Broad enterprise integrations before product-market fit

Field features are prioritised only when they feed or evidence a commercial outcome.

## Growth (later)

- Billing & subscriptions — Stripe integration, plan management in-app
- Accounting integrations — Xero, MYOB, QuickBooks (via `externalRefs`) — after product-market fit
- Client portal — limited external access for project owners
- PWA packaging and mobile-optimised layouts

## Future

- Native iOS / Android app (React Native or Expo)
- White-label option for enterprise
- API access tier
