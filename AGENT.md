# Constrapp — Agent & Contributor Guide

This file governs how AI agents and contributors must approach work in this codebase.
It covers mandatory conventions, guardrails, workflow, and architectural invariants.
For detail, follow the links into `docs/`.

## Strategic Invariants (mandatory)

Constrapp is **the connected commercial operating system for construction projects**. These invariants are as binding as the financial ones below:

- **Cost Codes are the commercial spine.** Every commercial document references a cost code (`costCodeId` + a `costCodeName` snapshot). New commercial modules join through it — they must not invent a parallel key.
- **New commercial modules integrate with the existing lifecycle** (Drawing → Quantity → BOQ → Estimate → Tender → Award → Approved Budget → Commitment → PO → Variation → Progress Claim → Supplier Invoice → Actual Cost → Forecast → Cash Flow → Final Project Margin → Final Account) rather than operate as standalone tools.
- **Field features must state their commercial input or output** (e.g. drawing measurement → BOQ quantity, site photo → progress/claim evidence, delay → forecast impact). A field feature with no commercial linkage is out of scope.
- **Do not build generic form-first or HSEQ-first functionality** (no-code form builders, HSEQ template libraries, generic field reporting, payroll/workforce, fleet/equipment, or broad enterprise integrations before product-market fit) **without an approved strategy change.** See [PRODUCT.md](PRODUCT.md) → "What Constrapp Is Not".
- **IQ™ remains a placeholder** until its planned sprint (see [ROADMAP.md](ROADMAP.md) and the AI Feature Placeholder Rule below). **Quant™ 1A (ADR-51) is live in production (October 2026, after the rules-size / CORS / revision-banner hotfix — see DEPLOYMENT.md)**: a project-scoped MANUAL drawing-measurement tab (calibrate a sheet from one known distance; measure lengths, areas and counts; persist traceable measurement records in two collections) that by itself **writes no BOQ quantity and no financial document**. **Quant™ 1B (ADR-52) is live in production (October 2026; rules published first, then Hosting, verified per TESTING.md §28)**: a measurement may carry an optional `boqItemId` link to an ACTIVE BOQ item on the SAME cost code (rules-verified), and the BOQ tab's *Quant (n)* dialog lets a user review the linked measurements, their blockers and the eligible total, then **explicitly apply** that total to the one item's `quantity` (derived `amount` through `boqLineAmount`, `quantApplied` provenance, version-guarded) — no automatic sync, no BOQ item creation, no AI. **Quant™ 1C (ADR-53; stages 1C-A and 1C-B) is live in production since 23 October 2026 (merged, Azure CI passed, Hosting deployed, live smoke checks verified by the product owner that day; Hosting-only, no rules change)**: 1C-A, manual-takeoff correctness and interaction — a self-intersecting or collapsed area outline is refused at save and derives as INVALID when stored (client-only, Deferred Control 32; the BOQ apply blocks it through the unchanged aggregate), unsaved drafts and geometry edits are remembered per project AND per sheet in sessionStorage and restored on that sheet with one explicit confirmation before anything discards them, geometry editing gains insert / remove / count markers / undo, the Select tool hit-tests shapes on the sheet, pan and zoom are pointer-anchored (Ctrl/⌘-wheel, pinch, drag-to-pan), vertex targets are 44 px, and the three Quant dialogs share the accessible shell; 1C-B, project-wide visibility and traceability — a *Project summary* view on the same tab (`lib/quantSummary.js`, pure, over the subscriptions already mounted) with per-kind totals that never mix metres, square metres and counts, current & valid work totalled apart from historical sheets, one attention list (unlinked, needs review, uncalibrated, non-derivable, invalid links, missing sources), grouping by cost code and by drawing → revision → page, and *Open* on every row that validates the target and moves the selection to the exact sheet with the measurement highlighted; the BOQ apply dialog's *Open in Quant* hands over through the same remembered selection (optional `measurementId`); measured dates shown only from the stored timestamp. **Quant™ 1D (ADR-54) is live in production since 26 October 2026 (merged, Azure CI passed, rules published first, Hosting deployed, production-verified that day); its release was RULES-FIRST**: manual opening and void deductions — an AREA measurement may carry `deductions: [{ id, label, points }]` (≤ 50 holes of ≤ 100 canonical points, written only once the first deduction exists; earlier documents untouched), traced by the QS inside a selected area with the existing area taps and saved with a label through the one guarded `runUpdateMeasurement`; `measurementQuantity` derives the area's **NET** (gross − Σ holes, scaled through the same calibration) as `quantity.value`, so page totals, the project summary, the BOQ aggregate and the evidence fingerprint all carry net with no second formula, while gross and deducted ride beside it for the *Gross · Deductions · Net* breakdown; a hole must be simple, inside or touching its parent, strictly disjoint from the others, and leave a positive net at 3 dp (client-only, DC32 — refused at Finish/Save and against the server outline, derived INVALID with the hole named when stored anyway, blocking the apply); a deductions change never touches the calibration snapshot, a parent edit that would strand a hole is refused, a stale write keeps the draft, void freezes the holes, and removing a hole keeps no history. Rules accept the key on an area only, as a list of ≤ 50 (`firestore.rules` 196,622 bytes). AI takeoff, DWG, revision copy-forward, length/volume deductions and per-deduction audit history stay deferred. **PULSE™ 1A is live in production as a deterministic, read-only project tab (ADR-47)** — six explainable indicators composed from existing selectors — and **PULSE™ 1B (ADR-49) is live in production since 19 October 2026**, adding a human acknowledgement workflow on top of them (acknowledge a finding with a note and a required review-by date; withdraw; derived *needs attention / acknowledged* status — never a resolution). **SHIELD™ is commercial assurance — never HSEQ (ADR-50)** — and its foundation is **live in production since 19 October 2026**: a read-only, project-scoped tab of exactly five checks (`lib/shield.js`) composed from existing selectors, with no persistence. Everything PULSE™ and SHIELD™ do not yet do (scores, severity, trends, prediction, portfolio views, assignment, notifications, background monitoring, any AI) stays under the placeholder rule.

## Engineering & Security Standards (mandatory)

[docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md) is **binding** for
every change, by humans or AI agents — as binding as the Strategic and Financial
Invariants. Before writing code, run its pre-implementation checklist; before
marking a task done, run its validation and security-review checklists. In
particular:

- **Firestore Security Rules are the single trust boundary.** Client-side role and
  lifecycle checks are **UX only** and never sufficient authorisation. When you
  describe a control, distinguish *rules-enforced* from *client-enforced* — **never
  claim a feature is secure or a control is enforced when it is client-side only.**
  Use the honesty protocol in ENGINEERING_STANDARDS.md §7 and cite the relevant
  [docs/SECURITY.md](docs/SECURITY.md) Deferred Controls item.
- **No secret in the frontend, ever.** Every `VITE_`-prefixed variable ships in the
  public bundle. Never `VITE_`-prefix or read a real secret (Stripe/AI/email keys,
  service-account JSON) from frontend code, and never call a privileged provider
  operation directly from the browser (see [docs/SECURITY.md](docs/SECURITY.md) →
  Secrets & the Vite bundle).
- **A new collection or field is not done until its rules block is written and a
  security-review pass is complete.** Rule changes need a manual publish and a review
  against [docs/SECURITY.md](docs/SECURITY.md).
- The `backend/` directory is a **reserved, intentionally empty placeholder** — it
  contains no code; do not treat it as an existing backend.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 8 (JavaScript, no TypeScript) |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` — tokens in `@theme` in `frontend/src/index.css`; there is **no** `tailwind.config.js` |
| Routing | React Router 7 (`react-router-dom`) |
| State | React Context + hooks (no Redux) |
| Charts | Recharts 3 |
| Backend | Firebase **client SDK only** (Auth, Firestore, Cloud Storage). No Cloud Functions and no server code. `frontend/firebase.json` **does exist** — it points the Firestore **and Storage** emulators at `firestore.rules` / `storage.rules` for the automated rules suites, and since Beta Launch Readiness it also carries a **Firebase Hosting block** (`public: dist`, SPA rewrite) — **first deployed to production on 19 October 2026** (PULSE™ 1B release), by hand. There is still **no `.firebaserc`** and no deploy pipeline: every deploy must name `--project` explicitly, and both rules files are published manually |
| Font | Sora (Google Fonts), fallback DM Sans |

## Repository Structure

The app lives entirely under `frontend/`. Root holds documentation; `docs/` holds
detailed docs plus design-reference assets (prototype `.jsx`, screenshots, Word doc)
that must not be moved or renamed.

```
frontend/
  firestore.rules   Firestore security rules (published manually — see docs/DEPLOYMENT.md);
                    the tenant, stamp, cents, GST, revision, path and currency helpers are
                    declared ONCE at the documents scope and take companyId / projectId as
                    arguments (ADR-60) — call them, never re-declare them per block
  storage.rules     Cloud Storage security rules — the SECOND trust boundary
                    (published manually; see docs/DEPLOYMENT.md)
  src/
    components/     UI primitives: Card, Btn, Badge, Stat, ProgBar, PageHeader, ProtectedRoute
    layouts/        AppShell (Sidebar + TopBar), AuthLayout, ProjectDetailLayout,
                    ProjectCommercialLayout (Commercial sub-nav:
                    Margin | Client Invoices | Client Receipts | Supplier Payments
                    | Cash Flow),
                    ProjectDocumentsLayout (Documents sub-nav:
                    Drawings | General Documents)
    pages/          Top-level routes; pages/project/ holds Project Detail tabs;
                    pages/project/documents/ holds the Documents & Drawings
                    modals, viewer and shared class strings;
                    pages/project/pulse/ holds the PULSE™ indicator card
                    (presentation only — formats lib/pulse.js output; ADR-47);
                    pages/project/shield/ holds the SHIELD™ check card
                    (presentation only — formats lib/shield.js output; ADR-50);
                    pages/project/quant/ holds the Quant™ 1A takeoff workspace
                    (TakeoffWorkspace, SourcePicker, PageViewer + SVG overlay,
                    MeasurementList, calibration / editor / void modals,
                    DeductionDialog (ADR-54 — label-only, on the shared shell),
                    pdfjsLoader — the ONLY place pdfjs-dist is imported, lazily;
                    ADR-51; the editor's optional BOQ-item link picker and the
                    list's BOQ column are Quant 1B, ADR-52; QuantDialog is the
                    shared accessible dialog shell the three modals render
                    through, and TakeoffSummary the read-only project-summary
                    view over lib/quantSummary.js, ADR-53);
                    pages/project/boq/ holds the BOQ editor / void modals and
                    BoqQuantityApplyModal (Quant 1B review-and-apply, ADR-52);
                    pages/project/tenders/ holds RaisePurchaseOrderModal (the
                    M3-A award → draft PO review-and-confirm dialog, ADR-61)
    hooks/          useAuth, useProfile, useCompany, useProjects, useProject,
                    useCostCodes, useContacts (both expose costCodesError /
                    contactsError since ADR-55 — a failed read is never an
                    empty library), useBudgetLines, usePurchaseOrders,
                    useProgressClaims, useSupplierInvoices, useSupplierCreditNotes,
                    useClientInvoices,
                    useClientReceipts, useSupplierPayments, useVariations,
                    useBoqItems, useTenderPackages, useTenderBids,
                    useForecastLines, useProjectCommercial, useCashFlowLines,
                    useProjectActivities (project programme — NON-financial;
                    quickUpdateActivity = the one guarded write, ADR-46),
                    usePulseAcknowledgements (PULSE™ 1B — one document per
                    indicator; revision-guarded acknowledge/withdraw
                    transactions; NOT a PULSE source, ADR-49),
                    useLocalToday (viewer's calendar day, advanced at local
                    midnight — a timer, NOT a subscription),
                    useStorageUpload (the ONLY place file bytes are written —
                    and read: getFileUrl / getFileBytes),
                    useTakeoff (Quant™ 1A — useTakeoffPages +
                    useTakeoffMeasurements; revision-guarded transactions via
                    lib/quantActions.js; writes ONLY the two takeoff
                    collections, never a BOQ item; ADR-51 — a measurement's
                    optional `boqItemId` LINK is still a measurement write,
                    ADR-52), useBoqItems (ADR-32; since ADR-52 its edit and
                    the Quant `applyBoqQuantity` are version-guarded
                    transactions in lib/boqActions.js),
                    useDrawings, useDrawingRevisions, useProjectDocuments,
                    useRfis (RFI register — NON-financial; per-project counter)
    lib/            firebase.js, formatters.js, currency.js, nav.js, projectTabs.js,
                    purchaseOrders.js, progressClaims.js, supplierInvoices.js,
                    supplierCreditNotes.js (reduction records vs posted supplier
                    invoices), clientInvoices.js,
                    payments.js (shared, direction-agnostic),
                    clientReceipts.js, supplierPayments.js, variations.js,
                    tenders.js (packages, bids, validity gate, comparison, award),
                    forecast.js, margin.js, projectSnapshot.js (Dashboard
                    Project Snapshot — composes existing selectors + per-figure
                    availability, NO formula of its own; ADR-42), pulse.js
                    (PULSE™ 1A — six read-only indicators that compose
                    projectForecastRows / computeMargin / payablesSummary /
                    isOverdue through figureState; comparisons with zero,
                    counts and filters ONLY — no arithmetic, score, threshold,
                    trend or prediction; ADR-47), pulseAttention.js (PULSE™ 1B —
                    stable evidence keys + derived needs-attention / acknowledged
                    status BESIDE the evaluation; never changes an indicator;
                    ADR-49), pulseAcknowledgementActions.js (the two
                    revision-guarded transactions, SDK injected), shield.js
                    (SHIELD™ foundation — five read-only commercial assurance
                    checks composing normaliseInvoiceRef / invoiceTotals /
                    postedInvoicedByPoLine / postedInvoicedByPo / status
                    constants / the existing payables exception selectors
                    through figureState; cent comparisons, grouping and
                    counts ONLY — no formula, score, severity, trend or
                    prediction; ADR-50),
                    cashFlow.js (pure monthly cash
                    aggregation + forecast layers), contacts.js, boq.js (pure
                    BOQ arithmetic + read-time budget comparison),
                    projectTimeline.js (programme domain logic — no financial
                    arithmetic; incl. due filters, quick-action planner,
                    nextMilestone), activityQuickActions.js (guarded quick-
                    action transaction — Firestore SDK injected, ADR-46),
                    timelineGantt.js (Gantt geometry only),
                    files.js (file types, size ceilings, deterministic storage
                    paths), drawings.js, projectDocuments.js (pure domain logic),
                    rfis.js (RFI lifecycle, reference shape, overdue/response
                    derivation — NON-financial), quant.js (Quant™ 1A — pure
                    geometry, metric calibration, quantity derivation, review
                    state, validation; NO financial arithmetic; ADR-51; since
                    ADR-53 also polygon simplicity, the edit / hit-test
                    helpers and the gesture-zoom arithmetic; since ADR-54
                    the deduction geometry, the NET derivation and
                    `validateDeductions`), quantDraft.js
                    (ADR-53 — the remembered in-progress draft, sessionStorage
                    only, per sheet, validated before restore), quantSummary.js
                    (ADR-53 — pure classification and per-kind grouping of a
                    project's measurements, readiness, navigation targets; no
                    arithmetic of its own), quantActions.js (the
                    five revision-guarded takeoff transactions, SDK injected),
                    pdfRender.js (the PDF.js adapter — canonical scale-1
                    viewport, bounded render),
                    poLineRecognition.js (ADR-55 — one recognition path per PO
                    line: the direct-invoice / claim authoring guards and the
                    mixed-mode overlap detection; pure, client-only),
                    poCancellation.js (ADR-57 — the strict PO cancel policy over
                    claims, invoices and supplier variations: blockers, reason
                    text, fail-closed guard; pure, client-only, DC35), purchaseOrderActions.js (ADR-57 — the ONE guarded
                    send / close / cancel transaction, SDK injected; refuses a
                    stale copy and re-checks the cancel policy against server
                    copies), awardToPo.js (ADR-61, M3-A — the bid → PO
                    proposal: one line per bid line, blockers, warnings, link
                    state, fail-closed gate; pure, client-only, DC38),
                    awardToPoActions.js (ADR-61 — the ONE guarded raise
                    transaction: counter + draft PO + package back-link +
                    currency lock, SDK injected; refuses a stale award and an
                    already-raised package), progressClaimActions.js (ADR-58 — the two
                    revision-guarded claim transactions, draft edit and
                    submit / approve / reject, SDK injected; refuses a copy
                    whose status OR revision moved; rebuilds lines over the
                    server copy; certified amounts normalised to cents),
                    quantBoq.js (Quant™ 1B — pure unit alias table with
                    factor 1 only, link state, the per-item aggregate of
                    eligible linked measurements summed unrounded and rounded
                    once, blockers, readiness, preview through boqLineAmount,
                    latest-application state; ADR-52), boqActions.js (the two
                    version-guarded BOQ transactions — the manual edit and the
                    Quant apply — SDK injected; ADR-52)
  tests/unit/       Unit tests for pure lib/ logic (npm run test:unit — no emulator)
  tests/rules/      Firestore AND Storage security-rules suites
                    (npm run test:rules — starts both emulators)
```

## Design Tokens

Tokens are defined as CSS variables in the `@theme` block of `frontend/src/index.css`
(e.g. `--color-brand-bg` → the `bg-brand-bg` utility). Do not hardcode hex values in
components and do not create new colour values — use the existing tokens. The full
token list, component conventions, and the recorded existing violations (technical
debt, not licence to add more) are in [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

## Component Conventions

- Primitives live in `frontend/src/components/` — `Card`, `Btn`, `Badge`, `Stat`, `ProgBar`, `PageHeader`
- Pages compose primitives; keep business logic in hooks and `lib/`
- No new inline style objects — use Tailwind classes only (existing violations are logged in docs/DESIGN_SYSTEM.md)
- Responsive: mobile-first; the sidebar collapses to a drawer below the `md:` breakpoint
- Touch targets at least 44px; no hover-only interactions
- Test responsive behaviour at 375px, 768px, and 1280px before marking a task done

## Firebase Conventions

- All Firestore access goes through custom hooks in `frontend/src/hooks/` — never call `firebase/*` directly from a page component
- **Every subscription hook uses the KEYED-SNAPSHOT / DERIVED-LOADING pattern (ADR-41).** One state — `useState({ key: null, <data>: …, error: false })` — written **only** from the `onSnapshot` callbacks; the effect body performs **no** synchronous `setState` and idles with `return undefined`. Data, loading and error are **derived at render time**: `settled = targetKey !== null && snap.key === targetKey`, then `settled ? snap.<data> : <empty>`, `targetKey !== null && !settled`, and `settled ? snap.error : false`. Never reintroduce a `setLoading(true)` inside an effect. Copy the `key` and `targetKey` expressions **together** — if they diverge, `settled` is never true and the page loads forever. References: `useProjectActivities` / `useDrawings` (collections), `useProjectCommercial` (single document). `tests/unit/hookSubscriptionPattern.test.js` enforces this
- **A failed financial read is UNAVAILABLE, never a zero.** Expose the error as `settled ? snap.error : false` — never raw — so a rules rejection cannot render as an empty, zero-value register (ADR-24) and a project switch cannot flash the previous project's error. Consumers must render `—` / "unavailable", never `0`
- Multi-tenancy: everything except `users/` nests under `companies/{companyId}/…`
- Membership and role come from the `users/{uid}` Firestore document (`companyId`, `role`); security rules `get()` that document to authorize access. **Firebase Auth custom claims are not implemented** — do not reference them in rules or UI guards
- **`users/{uid}` is CLIENT-READ-ONLY (ADR-27).** A user may read their own profile; `create`, `update` and `delete` are all blocked by rules. No app code writes it — the only `users/` reference in `frontend/src` is the read in `hooks/useProfile.jsx`. Do not add a profile-write path, a "harmless field" allow-list, or admin user management: membership is **provisioned out of band**, and signup/invites/user administration require a trusted backend (Admin SDK), never the browser
- Check `frontend/firestore.rules` before adding any new collection or field; rules are published manually via the Firebase console (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
- `frontend/firebase.json` points the Firestore and Storage emulators at `firestore.rules` / `storage.rules` for the automated Security Rules suites (`npm run test:rules`), and carries a **Firebase Hosting** block, **deployed by hand for the first time on 19 October 2026** (PULSE™ 1B). There is **no `.firebaserc`** and no functions config — do not claim an unreleased branch is deployed, and **never run `firebase deploy` from a task that was not explicitly asked to deploy**. When a release does deploy, it is `firebase deploy --only hosting --project constrapp-69b5d`: `--only hosting` is mandatory, because both rules files are still published **manually** through the console after review (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))
- **Run `npm run test:rules` before any `firestore.rules` OR `storage.rules` change is published** (see [docs/TESTING.md](docs/TESTING.md) §0). One command starts both emulators and runs both suites

## Cloud Storage Conventions

- **`frontend/storage.rules` is a trust boundary, exactly like `firestore.rules`.** Client-side file validation in `lib/files.js` is a convenience mirror and never a control
- All Storage access goes through `hooks/useStorageUpload.jsx` — never call `firebase/storage` directly from a page
- **The path is the authority.** Object paths are deterministic and company-namespaced, built by `lib/files.js` from Firestore document IDs; every object is named `original.{ext}`. The uploaded filename is metadata only, and `customMetadata` is never consulted for authorisation
- **Upload order is Storage FIRST, Firestore SECOND.** An orphaned object is preferable to a register row pointing at bytes that never arrived
- **Objects are create-only.** `update` and `delete` are denied on every path, so a retry must mint a new document ID and a new path. Orphans are accepted and documented; there is no cleanup path without a trusted backend
- **Never persist `getDownloadURL()` output.** A download URL is a bearer link; mint it on demand and discard it

## Firestore Data Model (summary)

Full detail, field lists, and relationships: [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

```
users/{uid}                                  name, email, role, companyId, avatarInitials
companies/{companyId}                        name, countryCode (ISO 3166-1 alpha-2),
                                             baseCurrency (ISO 4217), currencyUpdatedAt/By —
                                             client may update ONLY those four currency fields
                                             (company_admin); create/delete blocked
companies/{companyId}/costCodes/{id}         code, name, category, unit, isActive — company-wide taxonomy;
                                             reads restricted to financial roles (ADR-56)
companies/{companyId}/contacts/{contactId}   entityType, contactTypes[], names, abn, gstStatus, people[],
                                             projectAssignments[] + derived projectIds[], isActive —
                                             company-wide directory; reads restricted to financial roles
companies/{companyId}/counters/{counterId}   next — sequential numbering (purchaseOrders, progressClaims,
                                             supplierInvoices, variationsClient, variationsSupplier,
                                             clientInvoices, clientReceipts, supplierPayments,
                                             supplierCreditNotes, tenderPackages)
companies/{companyId}/projects/{projectId}   name, status, budget, startDate, location, progress,
                                             currency (ISO 4217 — the display authority),
                                             currencyLocked (one-way ratchet)
  …/budgetLines/{lineId}                     costCodeId, costCodeName, budgeted, notes — reads restricted to
                                             financial roles (ADR-56)
  …/boqItems/{itemId}                        measured Bill of Quantities: itemNumber (user label, NO counter),
                                             section, description, quantity (≥ 0), unit (prefilled from the
                                             cost code, editable), rate (number ≥ 0 | null — NULL MEANS
                                             UNPRICED, never 0), amount (DERIVED quantity × rate, null while
                                             rate is null — the whole-cent invariant is RULES-ENFORCED),
                                             REQUIRED costCodeId + costCodeName snapshot, status active|void
                                             (LIFECYCLE RULES-ENFORCED; void terminal, reasoned), currency,
                                             revision 1 — feeds NO financial figure; BOQ-vs-budget comparison
                                             derived read-time on the BOQ page only (lib/boq.js, ADR-32);
                                             OPTIONAL quantApplied {at, by, quantity, measurementCount,
                                             evidence} — the LATEST explicit Quant application (absent at
                                             create; preserved verbatim or fresh caller/server-stamped with
                                             quantity == the written quantity and a non-blank evidence string
                                             ≤ 128, RULES-ENFORCED by shape; `evidence` is the client's
                                             deterministic fingerprint of the eligible measurements — ids,
                                             revisions, geometry, calibration, source state — recomputed at
                                             read time to tell "same evidence" from "same total"; a record,
                                             never a certificate; ADR-52); edits and the Quant apply are version-guarded
                                             transactions (CLIENT-enforced — revision stays 1, DC33);
                                             reads restricted to financial roles
  …/purchaseOrders/{poId}                    poNumber, status, supplierName, supplierId (null pre-Contacts),
                                             lineItems[] (1–200), subtotal, gst, total, currency (pinned to the
                                             project's resolved currency at create), revision, sentAt/By,
                                             closedAt/By, cancelledAt/By, externalRefs, createdAt/By, updatedAt/By —
                                             reads restricted to financial roles (ADR-56); LIFECYCLE (born draft;
                                             draft|pending_approval→sent; sent→closed; draft|pending_approval|sent
                                             →cancelled; nothing enters pending_approval; closed/cancelled terminal),
                                             DRAFT-ONLY EDITING, FREEZE AFTER SEND, ACTOR == CALLER + SERVER-TIME
                                             STAMPS and the WHOLE-CENT HEADER (subtotal + gst == total exactly; gst
                                             exactly 10% half-up, one cent below admitted on a half-cent boundary
                                             only) are RULES-ENFORCED (ADR-57, M2-B1, live since 27 October 2026 — Hosting
                                             first, rules second); the strict CANCEL policy (no non-rejected claim,
                                             non-cancelled invoice or non-rejected/non-withdrawn supplier variation
                                             — lib/poCancellation.js, re-checked in
                                             the guarded transaction lib/purchaseOrderActions.js) and lineItems
                                             contents are CLIENT-only (DC35); OPTIONAL sourceTenderPackageId /
                                             sourceTenderBidId / sourceTenderNumber (ADR-61, M3-A — LIVE since 29 October 2026: present together only on a PO raised from an awarded
                                             package, absent on manual / legacy POs; get()-verified against the
                                             AWARDED package and its RECEIVED winning bid with supplier id + name
                                             pinned, and the package's back-link getAfter()-verified in the same
                                             commit; frozen for life; read by NO financial selector — the raised
                                             draft counts only once SENT, like any PO; lines == bid lines is
                                             CLIENT-only, DC38)
  …/progressClaims/{claimId}                 claimNumber, status, poId/poNumber, supplierId/supplierName (from the
                                             PO), cumulative lineItems[] (one per PO line, then — ADR-63, M3-B2,
                                             IMPLEMENTED NOT YET DEPLOYED — one per claimable new-scope variation
                                             line: poLineIndex null + variationId + variationNumber +
                                             variationLineIndex + variationLineTotal; a null index is NEVER coerced
                                             to 0), header variationLineCount (int ≥ 0, REQUIRED at create by the
                                             FINAL rules, frozen; COUNT rules-pinned to PO lines + count; the
                                             first/last variation lines' shape and stored identity rules-pinned on
                                             create, edit and approve — the old-browser guard; header variationId
                                             stays null by decision),
                                             retention, claimed/approved subtotal-gst-total, revision, submittedAt/By,
                                             approvedAt/By, rejectedAt/By, invoicedAt (reserved), createdAt/By,
                                             updatedAt/By — reads restricted to financial roles (ADR-56); LIFECYCLE
                                             (born draft against a get()-verified SENT same-project PO with number,
                                             supplier and line count pinned; draft → submitted; submitted|under_review
                                             → approved; draft|submitted|under_review → rejected; nothing enters
                                             under_review or invoiced; approved/rejected/invoiced terminal),
                                             DRAFT-ONLY EDITING, CLAIMED HEADER FROZEN AT SUBMIT, APPROVED VALUES
                                             FROZEN FOREVER, ACTOR == CALLER + SERVER-TIME STAMPS, WHOLE-CENT HEADERS
                                             ON BOTH SIDES (retention ≥ 0 and ≤ subtotal; GST 10% of the net, exact or
                                             one cent below on a boundary; approved subtotal ≤ claimed subtotal) and
                                             REVISION EXACTLY +1 are RULES-ENFORCED (ADR-58, M2-B2, live since 27 October 2026 —
                                             Hosting first, rules second); the draft edit and every transition run
                                             through revision-guarded transactions (lib/progressClaimActions.js —
                                             stale copy refused, entries kept); one open claim per PO, cumulative
                                             claiming, lineItems contents and the mixed-mode guard are CLIENT-only
                                             (DC36); which variation a variation-origin line names, duplicates and
                                             every line beyond the two pinned ends are CLIENT-only (DC40)
  …/supplierInvoices/{invoiceId}             invoiceNumber (SI-####), status, source, poId, progressClaimId,
                                             OPTIONAL variationLineCount (ADR-63 — the number of variation-origin
                                             lines copied from the claim, 0 on direct_po; rules require it declared
                                             and ≤ the claim's whenever the claim carries variation lines, so the
                                             M3-B1 bundle can never post new-scope work onto PO line 0; frozen),
                                             ex-GST lineItems[] w/ per-line taxCode (a variation-origin line keeps
                                             poLineIndex null + variationId + variationLineIndex), retention, subtotal-gst-net-total —
                                             accounts payable; reads restricted to financial roles. LIFECYCLE +
                                             APPROVED AUTHORING FREEZE + POSTED/CANCELLED IMMUTABILITY + IMMUTABLE
                                             IDENTITY + SCALAR HEADER ARITHMETIC ARE RULES-ENFORCED (ADR-40), and
                                             rules GET() THE SOURCE AT CREATE (PO sent|closed; claim approved).
                                             lineItems CONTENTS stay client-enforced (DC29); payableGst/payableTotal
                                             can legitimately go NEGATIVE on a GST-free retained invoice (DC30)
  …/supplierCreditNotes/{creditNoteId}       creditNumber (SCN-####), status draft|posted|void, FROZEN target
                                             (supplierInvoiceId + invoiceNumber/supplierInvoiceNumber/
                                             supplierId/supplierName/currency snapshots — core-preserved),
                                             supplierCreditReference, creditDate ('YYYY-MM-DD'), REQUIRED
                                             non-whitespace reason, ex-GST lineItems[] w/ per-line taxCode +
                                             REQUIRED costCodeId (from the target invoice's lines; NO
                                             poLineIndex), subtotal/gstTotal/grossTotal (whole-cent header
                                             invariant rules-enforced) — REDUCTION records against exactly
                                             ONE posted, ZERO-RETENTION supplier invoice; LIFECYCLE + POSTED
                                             IMMUTABILITY RULES-ENFORCED, and rules GET() THE TARGET (exists,
                                             posted, zero retention, supplier+currency match, grossTotal ≤
                                             payableTotal); cumulative cap app-enforced only (DC25); posted
                                             valid-target credits reduce Invoiced/Actual by cost code and the
                                             invoice's remaining payable AT READ TIME — the invoice is NEVER
                                             written; reads restricted to financial roles
  …/clientReceipts/{receiptId}               receiptNumber (CR-####), status draft|posted|void, REQUIRED clientId +
                                             clientName snapshot, receiptDate ('YYYY-MM-DD'), gross `amount` (> 0),
                                             paymentMethod (never defaulted), bank/external refs, EMBEDDED
                                             allocations[] {clientInvoiceId, invoiceNumber, allocatedAmount},
                                             allocatedTotal + unallocatedAmount (scalar invariant rules-enforced in
                                             whole cents) — CASH RECEIVED; no GST, no tax code, no net amount;
                                             Received to Date / Remaining to Reconcile / reconciliation state derived
                                             read-time and NEVER written onto an invoice; LIFECYCLE + POSTED
                                             IMMUTABILITY ARE RULES-ENFORCED; reads restricted to financial roles
  …/clientInvoices/{invoiceId}               invoiceNumber (CI-####), status draft|issued|void, client identity
                                             snapshot (name/legalName/abn/email/phone/address), ex-GST lineItems[]
                                             w/ per-line taxCode + OPTIONAL costCodeId + optional variationId,
                                             invoiceDate/dueDate, paymentTerms snapshot, externalInvoiceReference —
                                             accounts receivable; contract control + ageing derived read-time;
                                             LIFECYCLE + ISSUED IMMUTABILITY ARE RULES-ENFORCED (the only collection
                                             where they are); reads restricted to financial roles
  …/supplierPayments/{paymentId}             paymentNumber (SP-####), status draft|posted|void, REQUIRED supplierId +
                                             supplierName snapshot, paymentDate ('YYYY-MM-DD'), gross `amount` (> 0),
                                             paymentMethod (never defaulted), bank/remittance/external refs, EMBEDDED
                                             allocations[] {supplierInvoiceId, invoiceNumber, supplierInvoiceNumber,
                                             allocatedAmount} against POSTED supplier invoices' payableTotal (NOT
                                             grossTotal — retention is withheld and is not payable), allocatedTotal +
                                             unallocatedAmount (scalar invariant rules-enforced in whole cents) —
                                             CASH PAID; no GST, no tax code, no net amount; Paid to Date / Remaining
                                             Payable / reconciliation state / AP ageing derived read-time and NEVER
                                             written onto an invoice (no `paid` status, no `paidAt`); LIFECYCLE +
                                             POSTED IMMUTABILITY ARE RULES-ENFORCED; reads restricted to financial roles
  …/variations/{variationId}                 variationNumber (CV-#### client / SV-#### supplier), variationType,
                                             status, client/supplier + poId snapshots, ex-GST lineItems[] w/ per-line
                                             taxCode (submitted/approved sides), costCodeId spine, revision,
                                             submittedAt/By, approvedAt/By, rejectedAt/By, withdrawnAt/By,
                                             createdAt/By, updatedAt/By, OPTIONAL scopeCommittedAt/By (ADR-63,
                                             M3-B2 — IMPLEMENTED NOT YET DEPLOYED: the second rules-stamped pair —
                                             written WITH the applied pair on a PO-linked approve, or once by the
                                             legacy action for the pair still missing; makes each POSITIVE
                                             new-scope line a committed, claimable commitment line in its own right;
                                             a negative new-scope line is never matured or claimed), OPTIONAL
                                             commitmentAppliedAt/By (ADR-62,
                                             M3-B1 — LIVE: the rules-stamped pair — actor == caller,
                                             time == server, PO get()-verified sent|closed — written by the approve
                                             transition for a PO-linked supplier variation, or once by the legacy
                                             Apply branch; absent until then; an applied variation's existing-line
                                             amounts revise its PO line inside Remaining Committed at read time) —
                                             commercial change control; approved-only
                                             read-time; reads restricted to financial roles; LIFECYCLE (born draft
                                             with a type-consistent counterparty and, for a PO-linked supplier
                                             variation, a get()-verified SENT|CLOSED same-project PO with number and
                                             supplier pinned; draft → submitted; submitted|under_review →
                                             approved|rejected; draft|submitted|under_review → withdrawn; nothing
                                             enters under_review/disputed/superseded; approved/rejected/withdrawn
                                             terminal), DRAFT-ONLY EDITING, SUBMITTED HEADER FROZEN AT SUBMIT,
                                             APPROVED VALUES FROZEN FOREVER, ACTOR == CALLER + SERVER-TIME STAMPS,
                                             SIGNED WHOLE-CENT HEADERS ON BOTH SIDES (subtotal + gst == total exact;
                                             never clamped, never bounded against submitted), REVISION EXACTLY +1 and
                                             the ADR-34 originating-RFI link (verified on change, frozen outside
                                             draft) are RULES-ENFORCED (ADR-59, M2-B3, live since 27 October 2026 — Hosting
                                             first, rules second); the draft edit and every transition run through
                                             revision-guarded transactions (lib/variationActions.js — stale copy
                                             refused, entries kept); lineItems contents, the header GST against the
                                             lines, notes-required-when-differing and uniqueness are CLIENT-only
                                             (DC37)
  …/tenderPackages/{packageId}               tenderNumber (TP-####), status draft|issued|awarded|cancelled, name,
                                             scope (free text), costCodes[] {costCodeId, costCodeName} (≥1),
                                             closingDate (INFORMATIONAL ONLY — never blocks a bid), awardedBidId +
                                             awardedBidderName snapshot, awardNotes, cancelReason — NO amounts, NO
                                             currency, NO awardTotal; LIFECYCLE + ISSUED-SCOPE FREEZE + AWARD
                                             INTEGRITY (bid exists · same package · received · name snapshot ·
                                             single award, via get()) ARE RULES-ENFORCED; award creates NO PO and
                                             changes NO financial figure; OPTIONAL raisedPoId + raisedPoNumber +
                                             raisedPoAt/By (ADR-61, M3-A — LIVE since 29 October 2026: the ONE current draft
                                             PO raised from the award by explicit confirmation, written in the
                                             same transaction as that PO and getAfter()-verified; re-linked only
                                             after the linked PO is get()-verified CANCELLED; absent / null until
                                             raised); reads restricted to financial roles
  …/tenderBids/{bidId}                       tenderPackageId + frozen tenderNumber, status received|void (no draft —
                                             a bid is a transcription), bidderContactId + frozen bidderName
                                             (contact existence/type rules-verified via get()), bidDate, bidderRef,
                                             ex-GST lineItems[] {costCodeId, costCodeName, description, amount}
                                             (NO GST fields, NO stored bidTotal — totals derive through the
                                             assessBid validity gate; malformed bids fail safely), exclusions,
                                             notes — bid writes permitted ONLY while the package is issued (bids
                                             freeze on award/cancel, rules-enforced); a bid is currency-lock
                                             evidence; reads restricted to financial roles (competitor pricing)
  …/forecastLines/{costCodeId}               costCodeId (= doc id), costCodeName, uncommittedCostToComplete (number|null),
                                             notes — the ONLY stored Forecast Cost to Complete input; all other forecast
                                             figures derived at read time; reads restricted to financial roles
  …/cashFlowLines/{lineId}                   AUTHORED monthly Cash Flow timing inputs: monthKey ('YYYY-MM'),
                                             direction in|out, basis 'gross', amount (> 0 — direction carries
                                             the sign), sourceAmountExGst (ex-GST COVERAGE only, null for
                                             manual), sourceType (contract_revenue | uninvoiced_claim |
                                             remaining_committed | uncommitted_ctc | manual — invoice types
                                             deliberately EXCLUDED, they are timed automatically),
                                             costCodeId + frozen costCodeName on cost-side lines,
                                             sourceRef/counterpartyName snapshots, description, status
                                             active|void — NO counter, NO number, NO sourceId, NO posted
                                             status; LIFECYCLE IS RULES-ENFORCED (active edit / active→void
                                             terminal, non-whitespace reason); delete blocked; the
                                             no-past-month rule is CLIENT-enforced; reads restricted to
                                             financial roles
  …/activities/{activityId}                  PROJECT PROGRAMME (NON-FINANCIAL): name, description, isMilestone,
                                             status not_started|in_progress|on_hold|completed|cancelled,
                                             DATE-ONLY 'YYYY-MM-DD' plannedStart/plannedFinish (finish INCLUSIVE,
                                             finish >= start rules-enforced) + nullable actualStart/actualFinish,
                                             INTEGER percentComplete 0-100 (MANUALLY AUTHORED, unverified),
                                             optional responsibleContactId + frozen responsibleName (a CONTACT,
                                             never a user — ADR-27), OPTIONAL costCodeId + frozen costCodeName
                                             (the commercial spine link — a JOIN KEY only, no derivation),
                                             sortOrder (NOT unique), notes, cancelReason/cancelledAt/cancelledBy —
                                             duration/overdue/horizon/summary all derived read-time, never stored;
                                             LIFECYCLE IS RULES-ENFORCED but DELIBERATELY NOT FORWARD-ONLY
                                             (backwards correction allowed — an explicit ADR-11 departure);
                                             cancelled terminal, delete blocked; NO currency, NO counter,
                                             NO transaction, NO currency ratchet; reads company_admin/
                                             project_manager/qs, writes company_admin/project_manager ONLY
                                             (QS READ-ONLY); WRITES NO FINANCIAL VALUE ANYWHERE
  …/pulseAcknowledgements/{indicatorId}      PULSE™ 1B MANAGEMENT RECORD (ADR-49): one doc per indicator, id ∈ the
                                             six INDICATOR ids (rules allowlist; stored indicatorId must match),
                                             status active|withdrawn, evidenceKeys (list of stable record ids,
                                             ≤ 200), note (non-blank ≤ 500), reviewBy ('YYYY-MM-DD', REQUIRED),
                                             acknowledgedAt/By, withdrawnAt/By, revision (INCREMENTS — every
                                             update must be exactly +1), createdAt/By, updatedAt/By — EXACT KEYS;
                                             NO amount, NO currency, NO name snapshot, NO history; an
                                             acknowledgement is NOT a resolution and changes NO indicator state,
                                             count or figure; reads company_admin/project_manager/qs, writes
                                             company_admin/project_manager ONLY (QS READ-ONLY); delete blocked
  …/takeoffPages/{drawingId}_{revisionId}_{page}  QUANT™ 1A SHEET RECORD (ADR-51, NON-FINANCIAL): drawingId,
                                             revisionId, page (int ≥ 1) — the id is RECOMPUTED by rules from
                                             these; source pdf|image; canonical pageWidth/pageHeight (PDF.js
                                             scale-1 viewport points, or intrinsic pixels) + pageRotation
                                             (0|90|180|270); calibration {pointA, pointB, pageDistance,
                                             realDistance, unit mm|m} | null; calibrationRevision (0 while
                                             uncalibrated, EXACTLY +1 per re-calibration); calibratedAt/By;
                                             revision (EXACTLY +1 per update); createdAt/By, updatedAt/By —
                                             EXACT KEYS; drawing + revision EXISTENCE and revision not
                                             withdrawn rules-verified; NO amount, NO currency, NO BOQ ref;
                                             reads AND writes company_admin/project_manager/qs; delete blocked
  …/takeoffMeasurements/{measurementId}      QUANT™ 1A MEASUREMENT (ADR-51, NON-FINANCIAL): takeoffPageId +
                                             drawingId/revisionId/page (consistent, rules-recomputed; the page
                                             doc must EXIST), kind length|area|count, points [{x,y}] in the
                                             page's CANONICAL space (≥2/≥3/≥1, ≤500 — element CONTENT is
                                             client-only), label (non-blank ≤120), REQUIRED costCodeId (must
                                             EXIST) + costCodeName snapshot, calibration SNAPSHOT {revision,
                                             pageDistance, realDistance, unit} for length/area | null for
                                             count, OPTIONAL boqItemId (string|null — ADR-52: absent on 1A
                                             documents, which stay valid; when set, rules get() the item:
                                             SAME PROJECT, EXISTS, ACTIVE, SAME costCodeId — at create and
                                             whenever the link or the cost code changes; unit compatibility
                                             is client-only, DC33), OPTIONAL deductions (ADR-54: AREA only,
                                             a list of ≤ 50 holes {id, label, points ≤ 100} — absent on every
                                             earlier document and never written at create; element content,
                                             containment, overlap and net > 0 are client-only, DC32; the
                                             area's derived quantity is then its NET), status active|void (void terminal,
                                             reasoned, RULES-ENFORCED), revision (EXACTLY +1), stamps —
                                             EXACT KEYS otherwise; A QUANTITY IS NEVER STORED (derived from
                                             points × calibration at read time); a measurement write NEVER
                                             changes a BOQ quantity — the apply is the BOQ tab's explicit
                                             step; reads AND writes company_admin/project_manager/qs;
                                             delete blocked
  …/counters/rfis                            { next } — the ONLY PROJECT-SCOPED counter: every project numbers
                                             its RFIs from RFI-0001 independently (financial counters stay
                                             company-wide); same financial-role audience; delete blocked
  …/rfis/{rfiId}                             RFI — REQUEST FOR INFORMATION (NON-FINANCIAL EVIDENCE RECORD,
                                             ADR-33): rfiNumber (RFI-####, per-project counter, allocated in
                                             the create transaction — NO currency ratchet), status
                                             draft|open|answered|closed|cancelled (FORWARD-ONLY, NO REOPEN,
                                             answered CANNOT be cancelled, closed/cancelled terminal — ALL
                                             RULES-ENFORCED), title, question, AUTHORED raisedDate
                                             ('YYYY-MM-DD'), raisedByName (client-authored snapshot of the
                                             creator's OWN profile name — NOT rules-verified, DC27), ZERO-OR-
                                             ONE scalar reference (referenceType none|drawing|document;
                                             drawing REQUIRES referenceDrawingId + referenceRevisionId, both
                                             EXISTENCE-VERIFIED by rules via the nested revisions path so the
                                             RFI stays pinned to the exact sheet issued; document requires
                                             referenceDocumentId, existence-verified; frozen referenceLabel +
                                             referenceRevisionCode snapshots; NO storagePath, NO download
                                             URL), OPTIONAL costCodeId + frozen costCodeName (JOIN KEY ONLY,
                                             no derivation), assignedToContactId + frozen assignedToName (a
                                             CONTACT, never a user — ADR-27), dueDate (>= raisedDate) — both
                                             REQUIRED TO RAISE, optional on a draft; the QUESTION BLOCK
                                             FREEZES AT RAISE, the MANAGEMENT BLOCK (assignee/due) FREEZES AT
                                             ANSWER; answer + AUTHORED answerDate (>= raisedDate) written by
                                             the answer transition only; closeOutNote; raised/answered/
                                             closed/cancelled At/By stamps; overdue, days open, response
                                             days, grouping, summary ALL derived read-time; delete blocked;
                                             reads AND writes company_admin/project_manager/qs ONLY;
                                             WRITES NO FINANCIAL VALUE ANYWHERE
  …/retentionReleases/{releaseId}            releaseNumber (RR-####, company counter), status draft|posted|void,
                                             docType 'retention_release', supplierInvoiceId (SCALAR — rules get()
                                             it and verify it is POSTED), invoiceNumber/supplierInvoiceNumber/
                                             supplierId(null ok)/supplierName snapshots, previouslyReleasedAmount
                                             (DERIVED snapshot, never user-authored), amount (ex-GST, > 0),
                                             gstAmount (= cumulative rounding delta), releaseTotal, releaseDate
                                             ('YYYY-MM-DD' — the AGREED date, NOT a DLP/entitlement/payment-due
                                             date), reason (non-whitespace), notes — the AUTHORISATION that makes
                                             already-withheld retention PAYABLE. NOT an invoice, tax invoice,
                                             credit note, or payment; no costCodeId (cash, not cost); NO paid
                                             status. LIFECYCLE IS RULES-ENFORCED (draft→posted→void terminal),
                                             as are the target invoice, the PER-DOCUMENT cap, and the EXACT GST
                                             formula; the CUMULATIVE cap is client-only (DC24); delete blocked;
                                             reads restricted to financial roles
  …/commercial/baseline                      single doc (id = "baseline"): originalContractValue, originalApprovedBudget
                                             (number|null), contract start/completion (Timestamp|null), clientId/clientName
                                             snapshot, notes — the ONLY stored Project Margin inputs; Current Contract Sum,
                                             Forecast Revenue, Forecast Gross Profit, Margin %, Margin Movement all derived
                                             at read time (lib/margin.js); ex-GST; reads restricted to financial roles
```

## Financial Invariants (mandatory)

- **Purchase Orders, Progress Claims, Supplier Invoices, Variations, and Forecast Lines never write financial values onto Budget Lines.** Committed, Claimed, Actual, Invoiced, the variation figures (Approved Supplier Variations / Commitment Exposure), and every forecast figure (Cost to Complete, Forecast Final Cost, Variance to Budget) are derived at read time from PO, claim, invoice, and variation documents (`lib/purchaseOrders.js`, `lib/progressClaims.js`, `lib/supplierInvoices.js`, `lib/variations.js`, `lib/forecast.js`) — never stored back. **Forecast Lines store only the manual `uncommittedCostToComplete` (number|null) + notes; supplier-variation exposure is shown separately and is never added into Forecast Final Cost.** Approved variations count only at read time and never mutate POs, claims, or invoices. **An approved PO-linked supplier variation APPLIED to its commitment (M3-B1, ADR-62 — LIVE) revises the PO LINE it extends at read time** (`revised = lineTotal + Σ applied approved amounts`, through `lib/variations.js → appliedSupplierVariationAdjustments` — THE one shared adjustment map — into the one Remaining Committed formula); it is recorded by the rules-stamped `commitmentAppliedAt/By` pair the approve transition writes while the PO is sent/closed (approval is the trigger; legacy approved variations stay UNAPPLIED until the one-time, rules-idempotent Apply). **A SCOPE-COMMITTED variation's POSITIVE new-scope lines are commitment lines in their own right (M3-B2, ADR-63 — IMPLEMENTED, NOT YET DEPLOYED):** the second rules-stamped pair `scopeCommittedAt/By` (written with the applied pair on approval, or once by the legacy action) makes each one a claimable line (ceiling = its approved amount, on its own cost code, identity `variationId` + line index) inside the ONE combined Remaining Committed (`lib/commitment.js → remainingCommitment` — PO lines + committed new-scope lines, each netted once by posted invoices and approved claims not yet invoiced; every consumer composes through it). Claims carry such a line with `poLineIndex: null` + `variationId` + `variationLineIndex` (header `variationLineCount`; the header `variationId` stays null); claim-sourced invoice lines keep the identity; **a null `poLineIndex` is never coerced to 0** and a malformed or duplicated identity is refused, never repaired (`lib/sourceLine.js`). Negative new-scope lines are never matured or claimed (signed exposure, review). **Unapplied** approved value (legacy, new scope not yet committed, negative new scope, invalid links) is separate exposure, never in FFC, and **Commitment Exposure = Remaining Committed + unapplied** — never both. The PO document is never written. Committed means *remaining open commitment* — **ordered and not yet recognised as Actual** (ADR-55): per PO line, `(lineTotal + applied approved supplier-variation adjustments) − posted/paid invoiced-to-date − approved claim value not yet superseded by a posted claim-sourced invoice`, floored at 0, through the ONE formula `lib/purchaseOrders.js → remainingCommittedByCostCode` that Budget, Forecast, Commercial, Dashboard, Cash Flow and PULSE all consume; Actual counts a posted invoice instead of its source claim (read-time exclusion — the claim is never mutated), so `Actual + Remaining Committed` never counts a certified claim twice. **A PO line is recognised through a progress claim OR a direct invoice, never both** (`lib/poLineRecognition.js` — client-only guards in the two editors, Deferred Control 34; existing overlaps are listed by SHIELD check 4 condition E and never offset). Cash Flow times the approved claim value awaiting its invoice as its own future-cash basis (`approvedClaimsAwaitingInvoice`), separate from Remaining Committed. **BOQ items feed no financial figure at all** — the BOQ is measurement provenance; its only derived output is the read-time BOQ-vs-budget comparison on the BOQ page, never stored (ADR-32); a BOQ `rate: null` means UNPRICED (never 0) and its `amount` is derived quantity × rate (whole-cent, rules-enforced), null while unpriced
- Document numbers (`PO-0001`, `PC-0001`, `SI-0001`, `CV-0001`, `SV-0001`, `CI-0001`, `CR-0001`, `SP-0001`, `SCN-0001`) come from company-wide counters incremented in the same transaction as the document write
- **Supplier Credit Notes are the reduction fact — never a mutation of the invoice and never cash.** A credit note targets exactly **one posted, zero-retention** supplier invoice (target frozen at creation; both enforced by rules via a `get()` on the target) and **nothing is ever written onto that invoice** — no credited total, no status change, no back-reference. Posted **valid-target** credits reduce Invoiced/Actual by cost-coded ex-GST lines (signed, never clamped) and the invoice's Remaining Payable by `grossTotal` — all at read time (`lib/supplierCreditNotes.js`), so voiding restores everything with no reversal document. **Actual Cash Out stays payment-only**, and **Remaining Committed is never re-opened by a credit** (no `poLineIndex` on credit lines). Over-crediting beyond the target's `payableTotal` is **HARD-BLOCKED** in the app (cumulative; rules enforce only the single-document cap — Deferred Control 25). A posted credit counts **only while it passes the central read-time validity gate** (`creditTargetException`): target still valid AND stored headers reconciling to its own `lineItems` with correct per-line GST, positive amounts, and cost codes present on the target — rules cannot iterate an array, so this is the only thing standing between a rules-valid forged document and an unbounded silent cost reduction. Anything failing counts **zero** on BOTH the payable and cost sides, is **never clamped**, and surfaces as an exception — cost stays visible (ADR-31). A failed credit-note subscription is **unknown, never zero**: payable figures render unavailable and payment actions are disabled
- **Client Invoices are revenue-side and never touch a cost figure.** They never write onto Budget Lines, the Commercial Baseline, or Variations; `Issued Client Invoices`, `Available to Invoice`, per-variation invoiced/remaining, and receivables ageing are all derived at read time (`lib/clientInvoices.js`). Only **approved** client variations are invoiceable; **negative** approved ones reduce the Current Contract Sum but cannot be invoiced. Over-invoicing is **warned, never blocked** — the limit cannot be rules-enforced. **There is still no payment state ON THE INVOICE**: no `paid`/`partially_paid` status and no payment field. Since Client Receipts shipped, *Received to Date*, *Remaining to Reconcile*, and the reconciliation state (*unreconciled / partly / fully / over-reconciled*) are **derived at read time from posted receipt allocations** and are **never written onto an invoice** — which is why voiding a receipt restores balances with no reversal record. The words *paid* and *unpaid* must never be used as an invoice status. Constrapp does **not** produce a compliant Australian Tax Invoice (no company legal name/ABN) — never label output "Tax Invoice"
- **Client Receipts are cash, not revenue.** A receipt stores gross cash received — **no GST, no tax code, no net amount** — and feeds **no** budget figure, forecast figure, or margin figure. Allocations are **embedded** on the receipt and **nothing is ever written onto a Client Invoice** (no balance, no payment status, no back-reference). Over-allocating the *receipt* is hard-blocked and its scalar arithmetic is rules-enforced (in whole cents); over-allocating an *invoice* is **warned, never blocked** — rules cannot sum sibling documents. Unallocated receipts are permitted, reported separately, and **never auto-applied**. Cash Flow must consume `receiptDate`, never `createdAt`/`postedAt`
- **Supplier Payments are cash out, not cost.** A payment settles an Actual cost that a **posted** supplier invoice already recognised, so it feeds **no** budget figure, forecast figure, or margin figure. Allocations reconcile against `supplierInvoice.payableTotal` — **never `grossTotal`** — because retention withheld is not payable, and a payment never writes, clears, or reduces `retention`/`retentionGst`/`retentionTotal` — those stay immutable for the life of the invoice. **Retention becomes payable only through a posted Retention Release** (ADR-30), which raises the derived payable basis and is then settled by an ordinary payment; a release is not itself cash. Allocations are **embedded** on the payment and **nothing is ever written onto a Supplier Invoice** (no balance, no payment status, no back-reference). **`SI_STATUS.PAID` and `paidAt` are DEPRECATED IN PLACE, never activated** — no path writes them and `SI_TRANSITIONS` reaches `paid` from nowhere; `paid` stays in `SI_COUNTING_STATUSES` deliberately so a direct-SDK-forged document cannot vanish from Invoiced/Actual (ADR-24). Over-allocating the *payment* is hard-blocked and its scalar arithmetic is rules-enforced (whole cents); over-reconciling an *invoice* is **warned, never blocked**. Unallocated payments are permitted, reported separately, and **never auto-applied** — and their **full amount** is still actual Cash Out. Cash Flow must consume `paymentDate`, never `createdAt`/`postedAt`
- **Cash Flow consumes cash records and writes only its own timing lines — gross cash only.** Every figure is derived at read time in `lib/cashFlow.js` across three layers: **actual** (posted Client Receipts / Supplier Payments via `cashInRows()`/`cashOutRows()`), **automatic near-term forecast** (positive remaining on issued Client Invoices at gross, and on posted Supplier Invoices at `payableTotal`, timed by `dueDate` **month**), and **manual longer-term timing** (`cashFlowLines`). It consumes the **total transaction `amount`** (never `allocatedTotal`) on the **transaction date** (`receiptDate`/`paymentDate`, never `createdAt`/`postedAt`) and groups by `date.slice(0, 7)`. **THE BOUNDARY RULE: months before the current month are ACTUAL ONLY** — no forecast amount, automatic or manual, ever lands in a past month, which is what makes actual-vs-forecast provably non-double-counting. Past-due and undated invoice balances are **never guessed into a month**; they are reported untimed. Cash Flow **writes only `cashFlowLines`** — no receipt, payment, invoice, PO, claim, variation, forecast line, budget line, or baseline is ever mutated. A timing line stores an expected **gross** `amount` plus, separately, the **ex-GST `sourceAmountExGst`** it represents (completeness only — the two bases are never added together); invoice source types are **excluded** so an invoice balance can never be timed twice; approved-claim cost sits **inside** Remaining Committed and is never an additive second denominator. The cumulative position starts at **zero** and is net project cash movement, **never presented as a bank balance** (no bank account, opening balance, financing, retention release, or GST/BAS remittance is modelled — each is warned about, never silently adjusted). **A failed subscription is reported as unavailable, never as a genuine zero.**
- **Tenders are a decision trail, not a financial document set.** Tender packages hold scope (≥1 cost codes + free text) and **no amounts**; bids hold ex-GST per-cost-code lines with **NO stored `bidTotal`** and packages store **NO `awardTotal`** — rules cannot sum an array, so a stored header total would be forgeable (the Credit Notes header-vs-lines lesson). Every figure derives through the `lib/tenders.js → assessBid` **validity gate**: a bid with any malformed line is invalid whole — total `null`, never a partial sum, never $0 — and is excluded from comparison and award. **An award creates NO Purchase Order and changes NO financial figure** (no budget, committed, claimed, actual, invoiced, forecast, margin, or cash-flow effect); the Awarded Bid Value derives from the rules-frozen awarded bid and is **never netted against POs** (no Award → PO linkage exists). Comparison variance uses **Approved Budget − Bid** (positive = under budget) and shows *no budget* rather than comparing against zero. The **closing date is informational only** — nothing blocks a late bid, anywhere. Tender bids (incl. void) are currency-lock evidence; packages never lock. **"Raise PO from Award" (ADR-61, M3-A — LIVE since 29 October 2026) is the explicit, reviewed, confirmed transfer of the awarded bid into a linked DRAFT purchase order** — supplier from the bid, one PO line per bid line (qty 1, blank unit, rate = the ex-GST amount, so subtotal == Awarded Bid Value), GST through `poTotals`, one guarded transaction with the package back-link, one current PO per award, re-raise only after cancellation, **never sent automatically**; the draft moves no figure and the sent PO is the commitment, counted once through its own lines — the Awarded Bid Value is still never netted against POs and never added beside them
- **Retention Releases are an authorisation, not a document type of any other kind.** A Retention Release makes retention **already withheld** on a posted supplier invoice **payable**. It is **not** a supplier invoice, tax invoice, credit note, or payment, carries **no cost code**, and moves **no cash** — only a posted Supplier Payment does. Held is derived from posted invoices, released from **posted** releases, and paid stays derived from payment allocations; **nothing is written onto a supplier invoice** and `retention`/`retentionGst`/`retentionTotal` are immutable for its life. Partial releases are supported and their GST is the **cumulative rounding delta** (`round((prev+amount)×10%) − round(prev×10%)`), which telescopes exactly to `retentionGst`/`retentionTotal` — never each release rounding its own share. Rules enforce the target invoice, the **per-document** cap, and the exact GST formula; the **cumulative** cap is client-only and **hard-blocked in the UI** (no acknowledgement override) — see DC24. **Retention *paid* is not derivable and must never be reported**, and a failed release read must never be treated as "nothing released" (ADR-30)
- PO line items freeze once a PO leaves `draft` (rules-enforced, ADR-57); claim amounts freeze once submitted and approved amounts are frozen forever (rules-enforced, ADR-58 — both live since 27 October 2026); supplier invoices freeze once `posted` (and posted invoices cannot be cancelled/unposted)
- Lifecycles are forward-only; financial documents are never deleted — cancellation/rejection is a status change
- One open Progress Claim per PO at a time (client-enforced only — rules cannot see sibling claims, DC36); claims are cumulative (claimed-to-date per PO line)
- POs snapshot `supplierName` from the chosen contact at write time (`supplierId` is the live link); contact edits or archiving never rewrite issued documents, and POs/claims with `supplierId: null` (pre-Contacts) render from the snapshot and are never backfilled
- **One currency per project; a currency is a label, never a conversion.** There is **no FX conversion**, no exchange rates, and no mixed-currency transactions. Money is formatted **only** through `formatCurrency(amount, currencyCode)` in `lib/formatters.js` with the currency resolved by `lib/currency.js` (`project.currency` → `company.baseCurrency` → `AUD`) — never hard-code a currency code or a `$`. Project currency **locks** once the project holds any monetary value (non-zero `budget`, budget lines, POs incl. draft/cancelled, claims, invoices, receipts, **supplier payments (incl. draft/void)**, variations, non-null forecast inputs, established baseline); Cost Codes and Contacts never lock. The lock *condition* is client-enforced (rules cannot enumerate subcollections); the *ratchet* is rules-enforced once set (ADR-21)
- **Currency is not tax.** `GST_RATE` remains a flat Australian 10% and every "GST 10%" label is Australian. Selecting another country changes the currency label only — never describe Constrapp as tax-compliant outside Australia
- **The Project Timeline writes no financial value, in either direction.** Activities never write onto Budget Lines, Forecast Lines, Cash Flow Lines, the Commercial Baseline, Progress Claims, POs, Supplier/Client Invoices, or Variations, and never touch `projects/{projectId}.progress`. `percentComplete` is **manually authored and unverified** — it is never derived from dates, from child tasks, or from Progress Claims, and it feeds **no** budget, forecast, margin or cash figure. A claim is a supplier's cumulative dollar claim against a PO line; an activity percentage is physical progress on a programme line — deriving either from the other would create a second source of financial truth (ADR-23/ADR-24). The optional `costCodeId` is a **join key reserved for a future read-time derivation** (`delay → forecast impact`), never an authored commercial value (ADR-29)
- Exact definitions and formulas: [docs/FINANCIAL_WORKFLOWS.md](docs/FINANCIAL_WORKFLOWS.md); rationale: [docs/PROJECT_DECISIONS.md](docs/PROJECT_DECISIONS.md)

## Naming

- Files: `PascalCase` for components, `camelCase` for hooks and lib files
- Firestore collections: `camelCase` plural (`projects`, `costCodes`, `purchaseOrders`, `progressClaims`, `supplierInvoices`)
- Tailwind class order: layout → spacing → colour → typography → interactive

## What Not To Do

- Do not write inline style objects — use Tailwind classes
- Do not add Stripe, AI, or billing code until Sprint 6
- Do not install native mobile packages (React Native, Capacitor, Expo) in this repo
- Do not create Firestore documents outside a `companies/{companyId}` scope (except `users/{uid}`) — security rules will reject them
- Do not put business logic in page components — extract to hooks or `lib/`
- Do not create new colour values — use the tokens in `frontend/src/index.css`
- Do not write committed/claimed/actual values onto budget lines from any client code
- Do not hard-code a currency code, a currency symbol, or a locale in a component — use `formatCurrency` with the resolved project currency
- Do not add FX conversion, exchange rates, or mixed-currency transactions
- Do not edit `frontend/firestore.rules` casually — rule changes need a manual publish and a security review against [docs/SECURITY.md](docs/SECURITY.md)

## Inspection Workflow

Before starting any task, an agent must:

1. Read `AGENT.md` (this file) in full
2. Read `PRODUCT.md` for scope and the role model; `ROADMAP.md` for what is current and what is out of scope
3. Read the relevant `docs/` documents for the area being touched (data model, financial workflows, security, design system)
4. Inspect the existing repository structure and relevant files before making changes — do not assume a layout
5. Read the relevant page component and its hooks before editing either
6. Check `frontend/firestore.rules` before adding any new collection or field
7. Confirm the task falls within current scope — if not, flag it rather than build it

## Web-First / Mobile-Ready Philosophy

- Build every layout mobile-first using Tailwind breakpoints (`sm:`, `md:`, `lg:`)
- The sidebar collapses to an overlay drawer below `md:`; the TopBar hamburger opens it
- Touch targets must be at least 44px tall on interactive elements
- No hover-only interactions — every action must also work on tap
- PWA manifest and service worker come in a later sprint — do not anticipate them now

## AI Feature Placeholder Rule

PULSE™, IQ™, Quant™, and SHIELD™ are reserved proprietary features. **SHIELD™ means commercial assurance, never HSEQ (ADR-50).**

- Do not implement any AI, ML, scoring, or hashing logic for these features
- If a screen references one, render a placeholder card: feature name, one-line description, "Coming Soon" badge — no data, calculations, or API calls behind it
- **Placeholder cards live only on the module's own route**, which stays hidden from navigation until the feature ships (Beta Launch Readiness). **Never** add a Coming Soon card, reserved empty slot or mock widget for these features to the Dashboard or any navigation surface (ADR-45) — they join the Dashboard only with real data
- Never import an AI/ML library (TensorFlow, OpenAI SDK, LangChain, etc.) without explicit instruction
- **PULSE™ 1A exception (ADR-47), scoped exactly:** the project PULSE tab (`lib/pulse.js`, `pages/project/ProjectPulse.jsx`) may evaluate the six approved indicators — forecast over budget, cost codes not forecast, negative forecast gross profit, overdue programme activities, past-due supplier invoices, pending variation exposure — **only** by composing existing selectors and comparing with zero at cent resolution. Every indicator must resolve to loading / unavailable / needs data / finding / no issue, and a loading, failed or missing source can never yield "no issue". **PULSE™ 1B exception (ADR-49), scoped exactly:** the same tab may hold ONE acknowledgement document per indicator (`…/pulseAcknowledgements/{indicatorId}`, `hooks/usePulseAcknowledgements.jsx`, `lib/pulseAttention.js`) — a human note plus a required review-by date, withdrawable, company_admin/project_manager only — and may derive a *needs attention / acknowledged / no longer present / unknown* management status **beside** each finding. An acknowledgement never changes an indicator's state, a count or a figure, is never a resolution, and is never a dismissal (a finding stays visible). **Still prohibited for PULSE™:** any score, weighting, severity or risk threshold, trend or history, prediction, portfolio or cross-currency aggregation, dismissal/hiding of findings, assignment to users, notifications or reminders, background monitoring or scheduled jobs, automated commercial actions, Dashboard widgets, and any AI/ML. The top-level `/pulse` route stays hidden from the sidebar and is a pointer to the project tab, not a surface. **SHIELD™ foundation exception (ADR-50), scoped exactly:** the project SHIELD tab (`lib/shield.js`, `pages/project/ProjectShield.jsx`, `pages/project/shield/ShieldCheckCard.jsx`) may evaluate **exactly five** checks — potential duplicate supplier invoices, supplier invoice integrity, purchase order over-invoicing exposure, commitment records requiring reconciliation, existing financial exceptions — **only** by composing existing selectors and status constants, comparing in whole cents, grouping and counting; every check resolves to loading / unavailable / needs data / finding / no issue through declared dependencies, and a loading, failed, missing or empty source can never yield "no issue". It reads the seven existing hooks (POs, claims, supplier invoices, credit notes, payments, retention releases, variations) behind the financial-role gate and **has no write path, persistence, acknowledgement, rules change or dependency**. A finding is an exception or a condition needing review, never proof of wrongdoing. **Still prohibited for SHIELD™:** any further check without a separate approval (missing approval evidence, segregation-of-duties alerts, currency mismatch, duplicate payments, further cost-code or commitment conditions), any score, severity, threshold, trend, prediction, portfolio or cross-currency view, compliance or regulatory claim, fraud wording, notification, persistence, Dashboard widget, and any AI/ML. The top-level `/shield` route stays hidden and is a pointer to the project tab. **Quant™ 1A exception (ADR-51), scoped exactly:** the project Quant tab (`lib/quant.js`, `lib/quantActions.js`, `lib/pdfRender.js`, `hooks/useTakeoff.jsx`, `pages/project/ProjectQuant.jsx`, `pages/project/quant/*`) may render a drawing revision's PDF page or image, let a company_admin / project_manager / qs calibrate the page from ONE known metric distance, place points to measure lengths, areas and counts, and persist those records in `takeoffPages` / `takeoffMeasurements` through revision-guarded transactions — **manual measurement only.** Every quantity is reproduced from stored geometry × calibration at read time; none is stored. **Quant™ 1B exception (ADR-52), scoped exactly:** a measurement may carry an optional `boqItemId` link to an active BOQ item on the same cost code (`lib/quantBoq.js` owns the unit alias table, link state and the per-item aggregate; `lib/boqActions.js` the version-guarded BOQ writes), and the BOQ tab's `BoqQuantityApplyModal` may — after a human reviews the linked measurements, every blocker and the eligible total — write that total to the ONE item's `quantity` with its derived `amount` and a `quantApplied` record, through `useBoqItems.applyBoqQuantity`. The Quant tab itself still writes no BOQ field. **Quant™ 1D exception (ADR-54), scoped exactly:** an AREA measurement may carry manual `deductions` — holes the QS traces inside it — and `measurementQuantity` derives the area's net; the holes are written only through the existing guarded `runUpdateMeasurement`, carry no cost code, link or stamps of their own, and are never listed, linked or summed apart. **Still prohibited for Quant™:** any automatic or background update of a BOQ quantity, suggesting or writing a rate or amount of its own, creating BOQ items from measurements, applying a blocked, unreviewed or stale aggregate, any Budget/Forecast/Margin/Cash Flow effect, automatic or AI-assisted recognition, detection, snapping or inference of geometry, OCR, drawing comparison, portfolio views, Dashboard surfaces, notifications, and any claim that a measurement or an applied quantity is verified beyond who placed the points, who confirmed the application, and when

## Git Workflow

- Branch from `main` for every piece of work: `feature/`, `fix/`, `chore/`, `docs/` prefixes, lowercase kebab-case
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`
- One logical change per commit — do not bundle unrelated edits
- Open a PR against `main`; do not push directly to `main`
- Do not commit `.env.local`, Firebase service account keys, or any secret file
