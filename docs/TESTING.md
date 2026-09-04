# Testing

**Two automated suites exist and are deliberately separate:**

- **§0 — Security Rules tests** (`npm run test:rules`) — emulator-only, covering
  **both trust boundaries**: `firestore.rules` and `storage.rules`. One command
  starts both emulators.
- **§0b — Unit tests for pure `lib/` domain logic** (`npm run test:unit`) — plain
  Node, no Firebase, no emulator. Currently covers the Cash Flow arithmetic
  (`lib/cashFlow.js`), the Cash Flow chart presentation transform
  (`lib/cashFlowChart.js`), the BOQ derivations (`lib/boq.js`), the Tender
  validity gate, comparison, and award helpers (`lib/tenders.js`), the
  programme logic (`lib/projectTimeline.js`, `lib/timelineGantt.js`), the
  retention and supplier-credit-note derivations (`lib/retention.js`,
  `lib/supplierCreditNotes.js`), and the Documents & Drawings domain
  (`lib/files.js`, `lib/drawings.js`, `lib/projectDocuments.js`); the remaining
  pure `lib/` modules (`purchaseOrders.js`, `progressClaims.js`,
  `clientInvoices.js`, …) are the natural next targets.

Everything else is manual, and there is no CI. Verify application changes with
the manual acceptance tests below, run against a dev Firebase project with the
current rules published.

## 0. Security Rules — automated (emulators)

They load `frontend/firestore.rules` and `frontend/storage.rules` verbatim and
exercise them against the **Firestore and Storage emulators** — never a real
project (each suite throws if its emulator host variable is unset).

```bash
cd frontend
npm run test:rules
```

That script runs
`firebase emulators:exec --only firestore,storage --project constrapp-rules-test "vitest run --config vitest.rules.config.js"`.

- **Requires a JDK.** `firebase-tools` is pinned to `^13` because v14+ requires
  **JDK 21**, while the Firestore emulator under v13 runs on **JDK 17**. If you
  upgrade `firebase-tools`, you must also install JDK 21+.
- Config: `frontend/firebase.json` (both emulators + both rules pointers only —
  no hosting, no functions, and **no `.firebaserc`**, so nothing can be
  deployed). The Storage emulator runs on port 9199.
- **Both boundaries are proven by the same command on purpose.** A separate
  command for Storage Rules is a command that eventually stops being run.
- Tests — **1236 in total across 20 files: 1190 Firestore + 46 Storage**:
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
  - `frontend/tests/rules/projects.rules.test.js` — **89 tests** covering the
    project document, the **currency ratchet**, and (since ADR-39) **metadata
    correction**. `currency` is the display authority for
    every money figure on a project and Constrapp performs **no FX conversion**,
    so changing a stored currency **relabels** existing amounts; these tests are
    the only automated proof that it cannot happen. Covers the read audience
    (all six Company A roles, cross-company/unauthenticated/orphan denied), the
    create shape, blocked deletes for every role, and the whole ratchet:
    **locked + no stored currency may be pinned ONCE** by `company_admin` and
    `project_manager` (including the exact `writeBatch` shape
    `useCompany.saveCompanyCurrency` issues, and empty-string, malformed
    (`'aud'`) and non-string stored values all counting as unpinned); then the
    door shuts — `'AUD'` → `'NZD'`, `'AUD'` → deleted, `'AUD'` → `''`, and a
    relabel smuggled alongside a legitimate edit are all rejected, while an
    identical-value rewrite and non-currency edits still succeed;
    `currencyLocked` `true` → `false`, its deletion, and non-boolean values are
    rejected while `false` → `true` (optionally pinning in the same write)
    succeeds; unlocked projects stay freely settable; and nine malformed code
    shapes are rejected on both locked and unlocked projects. A dedicated
    **`qs`** group proves that narrow rule did not widen: `qs` may flip
    `currencyLocked` `false`/absent → `true` **alone** and nothing else — it
    cannot pin a currency on a locked or unlocked project, cannot combine the
    lock with a pin, cannot smuggle `budget`/`name`/`status`/`progress`, cannot
    re-write `true` on an already-locked project (which is why
    `stageProjectCurrencyLock` stages a no-op), and cannot create a project.
    It also asserts the documented **client-only** gap honestly: an **unknown**
    but well-formed code (`'XYZ'`) is ACCEPTED by rules, because rules validate
    shape and cannot hold an enum.
    **Verified as a real regression test:** with the carve-out reverted, exactly
    the nine initialisation cases fail and all 43 denial cases still pass.
  - `frontend/tests/rules/clientInvoices.rules.test.js` — **32 tests** covering
    every case in §15i-x below, including the **void-reason regression** (`10`,
    `10b`, `10c`): this block previously compared `voidReason.size() > 0` while
    every other financial block compared `voidReason.trim().size() > 0`, so a
    whitespace-only reason was ACCEPTED — confirmed against the emulator before
    the fix. `10b` now proves every blank shape (space, tab, newline) is rejected
    from **both** `draft` and `issued`, and `10c` proves a real reason with
    surrounding whitespace is still accepted.
  - `frontend/tests/rules/clientReceipts.rules.test.js` — **46 tests** covering
    every case in §15j-x below, including the whole-cent scalar-invariant cases.
  - `frontend/tests/rules/supplierPayments.rules.test.js` — **47 tests** covering
    every case in §15k-x below, including the whole-cent scalar-invariant cases.
  - `frontend/tests/rules/cashFlowLines.rules.test.js` — **58 tests** covering
    every case in §15m-x below. It also asserts the two documented
    **client-only** gaps: a PAST `monthKey` and an unknown `sourceType` of valid
    shape are both ACCEPTED by rules.
  - `frontend/tests/rules/supplierCreditNotes.rules.test.js` — **57 tests**
    covering every case in §15r-x below, including the whole-cent header
    invariant and the **target-invoice `get()` checks** (missing, unposted,
    retained, wrong-supplier, wrong-currency, and over-payable targets all
    rejected; retargeting a draft rejected; a draft edit failing against a
    since-cancelled target while voiding still succeeds). A dedicated
    **post-time revalidation** group (`P1`–`P7`) proves the `draft → posted`
    transition re-runs the target `get()`: a draft whose target was cancelled,
    given retention, had its payable cut below the credit gross, had its
    supplier or currency changed, or was deleted **cannot be posted**, while an
    unchanged target still posts and voiding a stranded draft always succeeds.
    It also asserts the one documented **client-only** gap honestly: a second
    credit whose CUMULATIVE total exceeds the target's payable is ACCEPTED by
    rules (Deferred Control 25 — the app hard-blocks it).
  - `frontend/tests/rules/boqItems.rules.test.js` — **50 tests** covering every
    case in §15s-v below: the two-state lifecycle (active edit / active → void
    terminal, reasoned), the whole-cent `amount == quantity × rate` invariant
    for priced items, the `rate: null ⟺ amount: null` unpriced pairing (0 can
    never mean unpriced), the mandatory cost-code spine, delete-blocking, and
    forged-stamp rejection. It also asserts the two documented **client-only**
    gaps (Deferred Control 26): a `costCodeId` of valid shape naming NO real
    cost code and a duplicate of an existing item are both ACCEPTED by rules.
  - `frontend/tests/rules/tenderPackages.rules.test.js` — **38 tests** covering
    the Tender Package cases in §15s below: draft create/edit for every
    financial role, the stamp-only issue, the issued **closingDate/notes
    carve-out** (and its inability to smuggle content), the award `get()`
    integrity set (nonexistent bid, another package's bid, void bid, forged
    bidder-name snapshot, non-issued package, **second award**, smuggled
    changes, wrong actor), cancel-reason enforcement, terminal
    awarded/cancelled, delete-blocking in every status, subcontractor/client/
    **super_admin**/unauthenticated/cross-company denial, and the skewed-clock
    timestamp assertions on create/issue/award/cancel.
  - `frontend/tests/rules/tenderBids.rules.test.js` — **32 tests** covering the
    Tender Bid cases in §15s below: received create for every financial role,
    subcontractor-type bidders, **late bids accepted (closing date is
    informational)**, the parent-issued gate (draft/awarded/cancelled/
    nonexistent packages all rejected), the contact `get()` set (nonexistent
    contact, wrong type, forged name snapshot), the forged tenderNumber
    snapshot, immutable-core enforcement, the **bid freeze after package
    award/cancel**, void-reason and terminal-void enforcement,
    delete-blocking, role/tenant denial, and the skewed clocks. It also
    asserts the documented **client-only** gap: malformed `lineItems`
    **elements** (non-numeric amounts, out-of-scope codes, non-object lines)
    are ACCEPTED by rules — the read-time validity gate is the mitigation.
  - `frontend/tests/rules/activities.rules.test.js` — **66 tests** covering
    every case in §15p-x below (the project programme, ADR-29). It is the only
    suite where the **read and write audiences differ**: it asserts that `qs`
    can read but cannot create, edit or cancel, that `subcontractor`, `client`
    and `super_admin` are denied entirely, and that **no role can delete**. It
    also asserts the deliberate **non**-forward-only lifecycle (`completed →
    in_progress` and `in_progress → not_started` both SUCCEED) and the four
    documented **client-only** gaps: an impossible-but-well-shaped calendar
    date (`2026-02-30`), a `responsibleContactId`/`costCodeId` naming nothing,
    a duplicate `sortOrder`, and a full-document overwrite (last-write-wins)
    are all ACCEPTED by rules.
  - `frontend/tests/rules/retentionReleases.rules.test.js` — **62 tests**
    covering every case in §15q below (Retention Release, ADR-30). It asserts
    the `draft → posted → void` lifecycle with **void terminal**, delete blocked
    in every status, and the **target-invoice `get()` checks** (missing,
    unposted, and zero-retention targets rejected; the target frozen at
    creation). It pins the **EXACT GST formula** — the rules helper
    `gstCents(exGstCents) = math.floor((exGstCents + 5) / 10)`, which compensates
    for Firestore rules' integer truncation at the half cent — and the
    **per-document cap** (`previouslyReleasedAmount + amount <= retention`, in
    whole cents). It also asserts the two documented **client-only** gaps
    honestly (Deferred Control 24): a **cumulative** over-release across sibling
    releases, and a forged `previouslyReleasedAmount`, are both ACCEPTED by
    rules — rules cannot sum siblings.
  - `frontend/tests/rules/supplierInvoices.rules.test.js` — **141 tests**
    covering every case in §13f below (Supplier Invoice Rules Hardening,
    ADR-40). This block was the highest-risk collection in the database — role
    and tenancy and nothing else, while `supplierCreditNotes`,
    `retentionReleases` and `supplierPayments` all trust these documents — so the
    suite is correspondingly broad. It asserts the **TWO lifecycle points**
    (`approved` = authoring freeze, `posted` = financial commit): every legal
    transition, every illegal one (`draft → posted` skipping approval,
    `approved → draft`, every exit from `posted` and from `cancelled`, and every
    move into the reserved `received`/`under_review`/`disputed` or the deprecated
    `paid` — the **ADR-24 forgery hole, now closed**), **transition purity**
    (seven kinds of content smuggled into each of approve/post/cancel, forged
    actors, and three skewed client clocks per stamp), the **approved authoring
    freeze**, **posted and cancelled terminality** including that a posted
    invoice cannot be cancelled, and blocked deletes for every role × status.
    It pins the create shape (status/source/docType, provenance against
    `request.time`, all eight null lifecycle/dead-field stamps), the
    **sixteen-field immutable identity** across both a draft edit and a
    transition, the **scalar money invariants** — each of the five identities
    broken by exactly one cent, plus a ten-value **retention-GST rounding sweep**
    proving the rules helper `gstCents(c) = math.floor((c + 5) / 10)` matches
    JavaScript `roundMoney(x × 10%)` on half-cent boundaries — and the
    **create-only Tier-2 source `get()`s** (missing/draft/cancelled/wrong-project
    PO, non-approved claim, and a `direct_po` invoice forbidden a claim
    reference), together with the **ADR-34 rule that an unchanged reference is
    never revalidated**: a PO cancelled *after* create must not trap the invoice.
    The two draft-edit contracts are asserted separately — `direct_po` (line
    money re-authored, line **count** pinned) and `progress_claim`
    (**header-only**, so certified money has no channel). A dedicated group
    proves **documents raised before ADR-40 stay writable** and acquire
    `updatedAt`/`updatedBy`/`cancelledBy` on their next valid write, and another
    proves `supplierCreditNotes` and `retentionReleases` still accept an invoice
    created and posted through the new rules.
    Finally, **fourteen tests assert the security CEILING honestly** (Deferred
    Controls 29 and 30): duplicate supplier references and duplicate SI-####
    numbers, two invoices against one approved claim, cumulative over-invoicing
    against a PO, header totals contradicting their own lines, a negative
    per-line amount, a bogus cost code, an invalid tax code, a per-line
    `gstAmount` that disagrees with itself, an arbitrary `poLineIndex`,
    creator == approver == poster, an impossible-but-well-shaped date, a
    future-dated invoice, and last-write-wins concurrency — **all ACCEPTED by
    rules**. Two further tests pin the deliberate absence of a
    `payableGst`/`payableTotal` floor and of any `gstTotal` ceiling: a wholly
    GST-free retained invoice (negative payable — Deferred Control 30) and a
    `gstTotal` above 10% of subtotal (per-line roundings) are both accepted,
    because rejecting them would reject documents the app itself writes.
  - `frontend/tests/rules/drawings.rules.test.js` — **86 tests** over the drawing
    master and its `revisions` subcollection: the **broad read** (all six Company
    A roles read masters and revisions, cross-company and unauthenticated denied),
    the writer matrix (**QS denied**, subcontractor/client/super_admin denied),
    the **born-empty** create shape, all four `hasOnly` master update shapes,
    the **+1 revision count**, reinstatement requiring an existing current
    revision, terminal withdrawal with a non-whitespace reason, revision creation
    shape (status `current`, positive integer sequence, contentType/fileExt
    agreement, 50 MB ceiling, zero-byte rejection, `pageCount: null`,
    `sheetSize: ''`), the **exact `storagePath`** (another revision's folder,
    another drawing's folder, another tenant's path and a non-`original.{ext}`
    name are all rejected), **file and authored immutability**, every legal and
    illegal lifecycle transition, and blocked deletes. It also asserts the
    **documented gaps** honestly: duplicate drawing numbers and revision codes
    are accepted, a second `current` sibling can be forged, `currentRevisionId`
    existence is unchecked, a count-bumping reinstatement is indistinguishable
    from a promotion, `fileSize` is unverifiable metadata, and membership is
    **company-wide** (a subcontractor reads a project they were never assigned).
  - `frontend/tests/rules/projectDocuments.rules.test.js` — **51 tests** over the
    general document register: visibility-gated reads, the writer matrix (QS
    **included** here), **list-query behaviour** — an unfiltered query by a
    subcontractor fails entirely while the same query with
    `where('visibility','==','project')` succeeds — create shape, the 25 MB
    ceiling, exact `storagePath`, **file-identity immutability**, supersession
    and withdrawal legality, terminal states, blocked deletes, and the documented
    gaps (unchecked `supersededByDocumentId`, non-unique names, unverifiable
    `fileSize`, and visibility flips that cannot un-read what was already read).
  - `frontend/tests/rules/rfis.rules.test.js` — **79 tests** covering every
    case in §15t-x below (RFIs, ADR-33) plus the **per-project counter**. It
    asserts the single read/write audience (`company_admin`/`project_manager`/
    `qs`; `subcontractor`/`client`/`super_admin`/cross-company/orphan/
    unauthenticated all denied on read and on every write branch), the exact
    create shape (extra field, missing field, wrong type, non-draft creation,
    every forged lifecycle stamp, skewed clocks), the **forward-only lifecycle
    with NO reopen** — `answered → cancelled` REJECTED, `closed`/`cancelled`
    terminal including an identical-data rewrite — the **question-block freeze**
    (eight field groups × four post-raise statuses), the management edit
    allowed only while `open`, the raise gate (no assignee / no due date /
    supplied in the same write / smuggled question edit), whitespace answers
    and cancel reasons, `answerDate`/`dueDate` ordering, and the
    **existence-verified reference**: a drawing master WITHOUT a revision is
    rejected, a nonexistent master or revision is rejected, a revision that
    exists under a DIFFERENT drawing is rejected, a drawing/document in
    ANOTHER project is rejected, and valid drawing+revision and document
    references are accepted (re-verified on draft edit). The counter group
    proves two projects number independently. It also asserts the documented
    **client-only** gaps (Deferred Control 27): an arbitrary `raisedByName`, a
    duplicate `rfiNumber`, an assignee/cost code naming nothing, a stale
    reference label, an impossible calendar date of valid shape, and an
    arbitrary counter value are all ACCEPTED. A dedicated **open-state
    invariant** group (REGRESSION 1–8) proves an open RFI can be reassigned
    and re-dated but can **never** lose its assignee, assignee name or due
    date, while a draft still may, and raise still requires both.
  - `frontend/tests/rules/variations.rules.test.js` — **107 tests**, the first
    dedicated suite for the `variations` block (ADR-18 · ADR-34). It **pins the
    existing posture** — the three financial roles read/create/update;
    `subcontractor`/`client`/`super_admin`/cross-company/unauthenticated denied;
    delete blocked at every status; and, deliberately, that a **direct status
    forgery and a post-approval amount rewrite are still accepted** (Deferred
    Controls 1 and 2 are unchanged). It then proves the **originating-RFI
    link**: create with the null triple, with the keys absent (legacy client),
    and against a same-project open/answered/closed RFI (supplier and client
    variations, every financial role); create denied for a draft RFI, a
    cancelled RFI, a nonexistent id, an RFI in **another project** of the same
    company, an RFI in **another company**, seven partial/malformed triples, a
    wrong number snapshot, a wrong title snapshot (including trimmed and
    re-cased copies) and non-string snapshots; the RFI document is **untouched**
    (still exactly 34 keys). Draft update: add (incl. to a legacy document),
    change, remove, unrelated edits with an unchanged or identically re-sent
    link, and denial of every invalid target, of snapshot-only or id-only
    rewrites, and of partial removal. The **critical historical case**: link an
    open RFI → cancel the RFI → an unrelated draft edit, **every** lifecycle
    transition (submit, approve, withdraw, reject) and a re-send of the same
    triple all still succeed and leave the link intact — while *changing* the
    link to that now-cancelled RFI, or re-linking it after removal, is denied.
    Freeze: from `submitted`/`approved`/`rejected`/`withdrawn` no role can add,
    remove, or change the id, number or title (legacy documents included), while
    transition-shaped writes with an unchanged, absent or identically re-sent
    triple remain allowed. Smuggling: draft → submitted with an unchanged link,
    or while setting/changing/removing to a **valid** link, is allowed; with an
    invalid link the **whole write** fails (document still draft, still
    unlinked); a non-draft source cannot bundle any origin change with a
    transition, nor by rewriting `status: 'draft'` in the same request.
  - `frontend/tests/rules/storage.rules.test.js` — **46 tests**, the **Storage**
    boundary. Requires **both** emulator hosts, because the document read rule
    performs a `firestore.get()`. Covers: drawing files readable by every
    provisioned company member and denied cross-company/unauthenticated/no-
    membership; the drawing writer set (**QS, subcontractor, client and
    super_admin all denied**); **create-only semantics** (overwrite, metadata
    update and delete all denied for every role); zero-byte, unsupported content
    type, content-type/object-name mismatch, non-`original.{ext}` names, and the
    **50 MB** ceiling with an at-ceiling success; the document writer set (QS
    allowed), the **25 MB** ceiling, and document overwrite/delete denial;
    visibility-gated document reads including the **pre-metadata upload window
    failing closed** for non-internal roles while internal roles read through it,
    a visibility flip removing access, and metadata in another company failing to
    unlock a path; and the **catch-all deny** for arbitrary paths, a
    company-shaped but unapproved collection, and drawing objects nested one
    folder too deep or too shallow.
  - All sixteen run for `company_admin`, `project_manager`, `qs`,
    `subcontractor`, `client`, an unauthenticated caller, and a financial-role
    user in a **second company**; the projects, tender, activities, drawings,
    documents, rfis and storage suites add `super_admin` (proving it has no
    special power). The users, projects, activities, drawings, documents, rfis
    and storage suites add a further identity: an authenticated caller with
    **no** `users/{uid}` document at all (the orphan case).
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

§15i-x, §15j-x, §15k-x, §15m-x, §15p-x, §15r-x, §15s-v and §15t-x below remain the
human-readable specification of what those tests assert; the other manual
sections are not automated. The **projects/currency-ratchet** suite is the one
place where the split matters: it fully automates the rules half of §15h-vii and
§15h-vii-a (what the boundary accepts and rejects), so the manual steps there are
deliberately reduced to the short **end-to-end** acceptance run the emulator
cannot cover — the real Company Settings page writing real projects and the
figures on screen not moving. The users suite is self-describing and has no
manual counterpart — `users/{uid}` has no UI, so there is nothing to click
through: the rules ARE the feature.

## 0b. Unit tests — pure `lib/` domain logic (no emulator)

The second automated suite. Plain Node — no React, no Firebase, no emulator, no
JDK. Discovered only from `frontend/tests/unit/` via a dedicated config
(`frontend/vitest.config.js`), so it can never bleed into the rules suite (and
vice versa — `vitest.rules.config.js` discovers only `tests/rules/`).

```bash
cd frontend
npm run test:unit
```

- `frontend/tests/unit/projects.test.js` — **26 tests** over `lib/projects.js`
  (ADR-39): the five-value status vocabulary and its rejection of legacy slugs
  (`'in_progress'`); the deliberate **absence** of a transition graph — every
  status accepted from every other, `Completed` reopenable; the editable key set
  proven never to contain `budget`, `currency`, `currencyLocked`, `createdAt` or
  `createdBy`, with `buildProjectFields` emitting only those keys; progress
  clamping (bounds, numeric strings, junk → 0 rather than NaN); name/location
  trimming; a blank start date mapping to **null**, not `''`; and
  `projectStartDateToInput` round-tripping a Timestamp and degrading to `''` on
  malformed legacy values instead of throwing.
- `frontend/tests/unit/costCodes.test.js` — **34 tests** over `lib/costCodes.js`
  (ADR-39): a **missing `isActive` means ACTIVE** (the legacy-document rule every
  picker relies on); `resolveCostCodeName`'s three-step chain (live → stored
  snapshot → `"Unknown cost code"`), including resolving an *inactive* code live;
  duplicate detection that is case- and whitespace-insensitive and **excludes the
  record being edited**; field trimming and bounds; `buildCostCodeFields` proven
  never to emit `isActive` or provenance; and the deactivate notice asserted to
  promise no figure change while making no per-project count claim.
- `frontend/tests/unit/budgetLines.test.js` — **23 tests** over
  `lib/budgetLines.js` (ADR-39): the editable key set is exactly
  `budgeted` + `notes`, proven never to contain `costCodeId`, `costCodeName`, the
  vestigial figures or provenance; **zero is a valid budget** while blank, null,
  junk, non-finite and array input are all rejected rather than coerced to 0
  (the `Number([]) === 0` hole is closed by an explicit type guard); notes
  bounds; and `budgetLineToForm` rendering a stored `0` as `'0'`, not blank.
- `frontend/tests/unit/foundationEditInvariance.test.js` — **42 tests**, the
  FINANCIAL INVARIANCE proof for ADR-39, exercising the real read-time
  derivations rather than any re-implementation. **Project metadata edits** are
  shown financially inert structurally — the ten financial `lib/` modules are
  asserted to read no `project.<field>` at all. **Cost-code rename and
  deactivation** are shown to change no number: forecast rollups byte-identical,
  every numeric row field unchanged (only the label and the `isInactive` flag
  move), the deactivated code keeping its row, margin unchanged, and the BOQ
  comparison unchanged — with the historical budget-line snapshot proven
  un-rewritten. **A `budgeted` edit** is shown to move Approved Budget, Variance
  to Budget, Remaining Budget Reference, Budget-tab Remaining and the BOQ
  comparison by *exactly* the delta, while **Forecast Final Cost**, the cost-side
  rollups, **every margin output** (Forecast Gross Profit, Forecast Margin %,
  Current Contract Sum, Original Planned Profit, Margin Movement) and **Cash
  Flow** are byte-identical — including the proof that a stored Uncommitted CTC
  is *not* recomputed even though the "use remaining budget" suggestion moves.
  A final group covers correcting a budget to **zero**: the row survives with
  `hasBudgetLine` true, FFC still does not move, and the variance goes negative
  so an overrun is surfaced rather than hidden.
- `frontend/tests/unit/cashFlow.test.js` — **131 tests** over `lib/cashFlow.js`
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

- `frontend/tests/unit/tenders.test.js` — **65 tests** over `lib/tenders.js`
  (plus the `monetaryLockReasons` tender-bid evidence in `lib/currency.js`):
  `TP-0001` numbering, both lifecycle transition maps (terminal states,
  unknown statuses), package and bid draft validation (≥1 cost code,
  duplicates, closing-date shape, contact-type checks, one-active-bid-per-
  bidder including the void-then-rebid and self-exclusion cases), and — the
  centre of gravity — the **bid validity gate** (`assessBid`): zero amounts
  valid, cents summing exactly, and every malformed shape (no lines,
  non-array, non-object line, missing/out-of-scope cost code, non-string
  snapshot/description, `NaN`/`Infinity`/string/negative amounts) invalidating
  the WHOLE bid with a `null` total — **never a partial sum, never $0, never
  clamped** — including the **finite-lines-that-overflow** case (`1e308`), where
  a non-finite *total* invalidates the bid instead of passing as valid, with its
  exclusion from ranking, variance, the matrix, award, and the Awarded Bid Value
  asserted end to end. Comparison tests pin the sign convention (**Variance to Budget =
  Approved Budget − Bid**, positive = under budget), variance-to-lowest,
  lowest-bid **ties** (whole-cent), void/invalid exclusion from ranking while
  staying visible, the **no-budget → unavailable (never zero)** rule, row
  ordering, the awarded flag, the per-cost-code matrix (multi-line sums,
  `null` for unpriced codes, invalid/void bids excluded), award gating
  (each blocked reason, including malformed bids), the derived Awarded Bid
  Value (unavailable when missing/malformed), input **purity** (frozen
  inputs), and that tender bids (including void) are currency-lock evidence
  while packages alone are not.

  ⚠️ It deliberately does **not** retest Cash Flow arithmetic — cumulative
  position, peak-funding maths, reconciliation, completeness and the
  month-boundary rules have exactly one home, `cashFlow.test.js` above.

- `frontend/tests/unit/files.test.js` — **43 tests** over `lib/files.js`. The
  **storage-path** tests matter most: those exact strings are what
  `firestore.rules` and `storage.rules` independently recompute, so a change
  here that is not mirrored in both rules files breaks every upload. Also covers
  extension parsing, the content-type → single-extension mapping (JPEG always
  stores as `.jpg`), `original.{ext}` naming, upload validation (unsupported
  extension, unsupported MIME, extension/MIME **disagreement**, zero-byte, the
  ceilings **at** and one byte **over**, and the smaller document ceiling applied
  independently), size formatting, filename capping, and the upload-error
  mapping (a rules rejection reads as a permission problem, a missing bucket
  names itself rather than blaming the connection).

- `frontend/tests/unit/drawings.test.js` — **55 tests** over `lib/drawings.js`:
  the discipline and status vocabularies, the write-role matrix (**QS excluded**),
  every legal and illegal revision/master transition with `withdrawn` terminal,
  drawing-number and revision-code normalisation, duplicate detection (warning
  only), **ordering by `revisionSequence` and never by `revisionCode`** — proven
  with codes that sort lexically into the wrong order — next-sequence derivation,
  current-revision resolution and its fallbacks, reinstatement candidates
  (withdrawn revisions never offered), draft and reason validation, register
  filtering with withdrawn hidden by default, and the **warning text** for
  superseded/withdrawn revisions and withdrawn masters.

- `frontend/tests/unit/projectDocuments.test.js` — **30 tests** over
  `lib/projectDocuments.js`: the ten flat categories, two visibilities and three
  statuses, `project` as the safe default, the write and internal-read role
  matrices (**QS included**), document transitions, draft validation including an
  optional-but-well-formed date, and register sorting/filtering.
  The chart component itself is **not** unit-tested: that would require jsdom
  and testing-library, and the transform boundary above is what makes the
  honesty rules testable without them (ADR-26). Chart *rendering* is verified
  manually in §15n.

- `frontend/tests/unit/boq.test.js` — **46 tests** over `lib/boq.js`, the BOQ's
  pure domain logic: the two-state lifecycle map, `normalizeRate` (blank form
  input → `null`, never 0), `isPriced` (0 IS a price; only null/undefined is
  unpriced), `boqLineAmount` (quantity × rate to the cent, **null while
  unpriced**, rounding that mirrors the rules' `cents()` exactly — including
  the `1 × 1.005 → 1.00` half-cent float boundary roundMoney would get wrong),
  active/void filters, `boqTotals` (priced active items only; unpriced
  contributes nothing), `budgetedTotal`, `boqVarianceToBudget` (**null** —
  never 0 or a partial figure — for an empty BOQ or while any item is
  unpriced), `boqByCostCode`, `boqVsBudgetRows` (the buildForecastRows union
  discipline: codes never disappear; live-name resolution with snapshot
  fallbacks; per-row variance suppressed for partial pricing), natural-order
  register sorting (`2.9` before `2.10`), `formatQuantity`, draft validation,
  and input purity.

- `frontend/tests/unit/supplierCreditNotes.test.js` — **97 tests** over
  `lib/supplierCreditNotes.js` and its read-time consumers (the first unit
  suite for a financial-document lib): the forward-only lifecycle and
  posted-only counting; header cent arithmetic; eligibility (posted + zero
  retention + stored currency, with the deprecated `paid` rejected as a
  creation target); **valid-target counting** — missing/cancelled/
  wrong-supplier/wrong-currency targets contribute ZERO (the safe failure),
  while a target forged to `paid` still counts so credit and invoice can never
  disagree; `creditedByInvoice`/`creditedByCostCode` derivations; exceptions;
  the **cumulative over-credit HARD BLOCK** (cent-exact full credit allowed,
  one cent over rejected, drafts/voids excluded, edited credit excluded, and a
  broken-link posted credit still consuming headroom); target-cost-code
  restriction; draft validation and `postBlockedReason` re-checks; duplicate
  credit references; AP integration (`remaining = payable − paid − credited`,
  a fully-credited invoice reading fully reconciled and leaving ageing, credit
  after full payment going over-reconciled and never netted into arrears, the
  payment picker offering the net remaining); Forecast integration (Actual net
  of credits, **Remaining Committed deliberately NOT restored**, an
  over-credited cost code going negative and staying visible, backwards
  compatibility when no credits are passed); and input purity. A dedicated
  **read-time integrity** group asserts the safe-failure contract against
  documents Firestore rules would ACCEPT: the proven exploit (`grossTotal: 100`
  with lines totalling 50,000) contributing **zero to BOTH** the payable and
  cost derivations and appearing as an exception; header/line mismatch in either
  direction; a one-cent discrepancy; forged per-line GST; GST on a GST-free
  line; unknown tax codes; foreign cost codes; **offsetting +/− lines that
  reconcile to an innocuous header**; zero, non-numeric, missing and non-array
  line items (without throwing); retention appearing on the target after
  posting; `payableTotal` cut after posting; and gross above payable — each
  excluded whole, never clamped, with valid and mixed sets still counting
  correctly. A further group proves **why an empty credit list is not a safe
  default** (it overstates remaining payable, the picker figure, and AP ageing)
  — the lib fact behind the page-level unavailable handling in §15r-xv.

- `frontend/tests/unit/projectTimeline.test.js` — **79 tests** over
  `lib/projectTimeline.js`, the project-programme domain logic (ADR-29). Covers
  the five-status vocabulary and its labels/badges, transition legality
  **including the deliberate backwards corrections** (`completed →
  in_progress`, `in_progress → not_started`) and `cancelled` terminality, the
  read/write role split (`qs` reads but cannot author), ISO date validation
  **rejecting impossible calendar dates** (`2026-02-30`, `2026-04-31`,
  `2025-02-29`) that a regex alone would accept, UTC-based day arithmetic that
  survives DST and year boundaries, **inclusive** duration (same-day = 1 day)
  and **zero-day milestones**, overdue/days-late/days-until-due against an
  **injected clock**, the horizon grouping windows and their boundaries, the
  four summary counts, **deterministic sorting** through every tie-break level
  (a total tie resolves identically whichever order it arrives in), draft
  normalisation and every validation message including all status invariants
  and the milestone rules, cancellation-reason validation, and **input purity**
  (no draft or activity list is ever mutated).

- `frontend/tests/unit/timelineGantt.test.js` — **33 tests** over
  `lib/timelineGantt.js`, the Gantt **geometry transform**. Covers month
  snapping and real month lengths (including February in a leap year), the
  visible window widening for actual dates outside the plan and reaching to
  today **only** when the programme is within a month of it, month/week ticks
  with clipped partial months, bar offsets and **inclusive** widths, progress
  fill as a share of the drawn bar with nonsense percentages **clamped**,
  milestone centring, today-marker presence and absence, explicit-window
  **clipping** with the cut end reported, exclusion of undrawable and
  wholly-out-of-window activities (**reported, never silently dropped**), the
  empty/single-activity/all-milestone cases, row order matching the table, and
  input purity.

  ⚠️ Neither Timeline suite retests the other's concern: geometry has one home
  and programme semantics have another. The Gantt **component** is not
  unit-tested — that would need jsdom and testing-library; the transform
  boundary is what makes the geometry testable without them (the ADR-26
  precedent). Rendering is verified manually in §15p-viii.

- `frontend/tests/unit/retention.test.js` — **79 tests** over `lib/retention.js`
  and its supplier-payments consumers (ADR-30): the `draft → posted → void`
  lifecycle and posted-only counting; retention **held** derived from posted
  invoices vs **released** derived from posted releases; `releasedByInvoiceId`;
  **GST telescoping** across partial releases (each release carries the
  cumulative rounding delta, so N partial releases and one full release agree to
  the cent); the payable-basis extension (`payableBasis(invoice, released)`) and
  its **regression guarantee** — an empty release map reproduces every
  pre-ADR-30 figure exactly; released retention becoming **allocatable** to a
  payment; the over-release hard block; **void restoring every figure** with no
  reversal document; and the proof that a release is **not cash** — Actual Cash
  Out is unchanged while future cash requirement rises (the double-count proof
  shared with `cashFlow.test.js`). Input purity throughout.

  ⚠️ It asserts what rules CANNOT do as passing tests, so the client-only
  cumulative cap (Deferred Control 24) is never mistaken for enforcement.

- `frontend/tests/unit/retentionCreditNotes.test.js` — **19 tests** over the
  **combined** payable model where ADR-30 (retention release) and ADR-31
  (supplier credit notes) meet in `lib/supplierPayments.js`. Every other unit
  suite exercises exactly one of the two, so this is the only proof that they
  compose: `basis = payableTotal + released`, `settled = paid + credited`,
  `remaining = basis − settled`. It pins the retained-invoice basis, a posted
  release RAISING the basis (with `retentionHeld + releasedTotal ==
  retentionTotal`, which is what makes double-counting retention structurally
  impossible), a valid posted credit LOWERING what remains, draft/void
  contributing zero on **both** sides, strict additivity when both apply,
  released retention becoming **allocatable** to an ordinary payment, a release
  **not** being cash (Actual Cash Out stays payments-only), over-reconciliation
  staying **signed** and **excluded from AP ageing** while reported separately,
  and the **regression guarantee** that empty adjustments reproduce every
  pre-ADR-30/31 figure at every arity.

  ⚠️ It also pins the **accepted ADR-31 boundary as a passing test**: a credit
  against a **retained** invoice contributes **ZERO — even once the retention
  has been fully released**, because the gate reads the stored, immutable
  `retentionTotal`. Releasing retention is not a back door into crediting a
  retained invoice; do not relax that case to make a future change pass.

- `frontend/tests/unit/documentsResponsive.test.js` — **16 tests** over the
  Documents register's responsive layout helpers.

- `frontend/tests/unit/clientInvoices.test.js` — **109 tests** over
  `lib/clientInvoices.js`, which previously had **no** unit coverage at all.
  Covers the forward-only `draft → issued → void` lifecycle and the deliberate
  absence of any `paid`/`partially_paid` status (ADR-22); `CI-####` numbering;
  the tax codes and per-line GST, including the **§15i-iv mixed acceptance case**
  (1,000 `gst` + 500 `gst_free` + 200 `input_taxed` → subtotal **1,700**, GST
  **100**, gross **1,800**), zero/garbage amounts, an unknown tax code attracting
  **no** GST, and half-up cent rounding; header totals summing to whole cents;
  the **§15i-v contract-control figures** (Current Contract Sum 1,010,000;
  Available to Invoice 610,000 after a 400,000 invoice; a draft not reducing
  availability; a void returning its value immediately); `availableToInvoice`
  going **negative** and never being clamped; the **§15i-vii variation rules** —
  draft and submitted variations are not invoiceable, an approved **positive**
  one is, an approved **negative** one is **not offered** yet still reduces the
  contract sum; `invoicedByVariation` counting **issued** invoices only; the
  single-cost-code snapshot rule (several cost codes → `null`); the
  approved/invoiced/remaining table including the signed **−5,000** double-invoice
  case; both over-invoice warnings (and that neither says "prevented" or
  "blocked"); due-date suggestion on the `invoice` and `eom` bases and the
  deliberate **blank** when terms are absent; date-only `isPastDue`; ageing by
  due date on the **remaining** balance, with fully-reconciled invoices dropping
  out and over-reconciled invoices excluded into `overSettled`; and every
  `validateInvoiceDraft` branch. It also pins two **no-mutation** invariants at
  the derivation layer: `contractControl` reports the supplied contract sum
  unchanged whatever the invoices say, and every derivation runs against
  **frozen** variation and invoice documents without writing to them.

- `frontend/tests/unit/clientReceipts.test.js` — **113 tests** over the AR /
  reconciliation half of `lib/clientReceipts.js` (the cash half,
  `cashInRows`, is covered in `cashFlow.test.js`). Pins the accounting
  invariants: a **draft** receipt reconciles nothing, a **posted** one does, and
  a **void** one restores the balance at the next render with no reversal
  document; allocations landing on the invoice they name and on no other;
  unallocated cash reducing **no** invoice balance; `remainingToReconcile`
  signed and never clamped; reconciliation state across
  unreconciled/partly/fully/over; rows and summaries excluding **draft and void
  invoices**; an over-reconciled balance reported **separately** so it can never
  offset genuine arrears (`remaining` 2,200 with `overReconciled` −500, never a
  netted 1,700); allocation targets restricted to issued invoices of the
  **selected client**, sorted oldest-first, with the receipt being edited
  excluded from its own figures; `allocateOldestFirst` consuming rows in the
  given order, never exceeding the cash or an invoice's balance, and skipping
  settled invoices; over-allocation **warned, never blocked**; the three
  allocation-exception reasons; corrected AR ageing under draft/posted/void
  receipts and the over-reconciled exclusion; `isPastDueUnreconciled` being false
  for a fully reconciled but overdue invoice; every `validateReceiptDraft`
  branch including the hard block on allocating more than the receipt amount and
  the target checks (missing, non-issued, wrong-client); posting rules
  (backdating allowed, future-dating blocked); and `buildAllocations` storing
  **only** the three allocation fields. A closing purity block proves every AR
  derivation leaves both the invoice and the receipt documents **byte-identical**
  — no balance, reconciliation state, `paid` status or receipt back-reference is
  ever added — and that the derivations are idempotent.

- `frontend/tests/unit/taxLimitation.test.js` — **12 tests** over the tax
  limitation in `lib/currency.js`, which had no coverage. Pins `TAX_JURISDICTION`
  as `AU` and the flat 10% `GST_RATE`; `needsTaxLimitationNotice` **false** for
  `AU`, **true** for `NZ`, `ZA` and every other supported market, and **true**
  for every non-AU country in the full list (AU is the sole exemption);
  **false** for a blank/unset country, preserving §15h-i backwards compatibility;
  and **true** for an unrecognised non-empty code, so the disclaimer fails loud.
  It also asserts the notice never claims compliance in another jurisdiction.

- `frontend/tests/unit/supplierPaymentsPurity.test.js` — **13 tests** closing the
  one thing the retention and credit-note suites do not assert: that the **whole
  payment-side derivation set** in `lib/supplierPayments.js` leaves a supplier
  invoice **byte-identical** at runtime. `status` never moves to `paid`, `paidAt`
  is never set (ADR-24), no balance / reconciliation-state / payment-reference
  field is ever added, and the immutable `retention*` fields are never reduced by
  a payment. It also re-pins that a void or draft payment reduces nothing (so
  voiding restores the payable for free) and that payments settle the derived
  **payable basis**, never `grossTotal`.

- `frontend/tests/unit/projectCurrencyLock.test.js` — **19 tests** over
  `currencyToPinOnLock` in `lib/currency.js`, the client half of the
  locked-but-unpinned fix: it decides what `useProjects.lockProjectCurrency`
  writes alongside `currencyLocked: true`, so the app stops **minting** projects
  that are locked with no currency. Pins both refusals — a project already
  carrying a well-formed code is left completely alone (overwriting would
  **relabel**, and its stored code still beats a differing company base
  currency), and an **unconfigured** company yields `null` rather than freezing
  the `DEFAULT_CURRENCY` rendering fallback, which is the live Apex Builders
  state and is what keeps Gold Coast apartments repairable through Company
  Settings. Proves the returned code is **exactly** `resolveProjectCurrency`, so
  pinning changes no label; that empty/malformed/non-string stored values and a
  malformed company `baseCurrency` are each treated as absent; and a purity
  block asserting both arguments are left **byte-identical**, that no monetary
  field is read or written, that the result is a bare `^[A-Z]{3}$` code (never a
  rate or an amount), and that repeated calls agree. Closes with the monotonic
  invariants: a set flag reports locked with **no** visible records, pinning
  cannot unlock, and once pinned the helper declines forever — even after the
  company base currency changes.

- `frontend/tests/unit/rfis.test.js` — **81 tests** over `lib/rfis.js`
  (ADR-33): `RFI-0001` formatting (zero-padding, overflow past 9999,
  round-trip parsing), the complete **transition map** — every legal edge,
  every illegal pair including self-transitions, **no reopen**, **answered
  cannot cancel**, closed/cancelled terminal, unknown statuses — the
  editability predicates by status (question block draft-only, management
  block draft/open), the UX role mirror, **reference-shape validation** (a
  drawing reference REQUIRES both drawing and revision ids plus both frozen
  labels; a master-only reference is rejected; stray ids on `none`/`document`
  are rejected; normalisation drops fields that do not belong to the chosen
  type), assignment and cost-code both-or-neither pairs, whitespace and
  length boundaries on every bounded string, `dueDate >= raisedDate` and
  `answerDate >= raisedDate` including equality and the year boundary, the
  raise/answer/close/cancel gates, the **overdue boundary** (open + past due
  only; due today is not overdue; never for draft/answered/closed/cancelled),
  days late / until due / open, **response days** (`answerDate − raisedDate`),
  the six-group horizon, the summary counts, the deterministic sort (number
  desc, unparseable last, title, id — stable across shuffles), every filter
  alone and combined (assignee names are NOT searched), and a **purity** block
  proving every exported function leaves deep-frozen inputs intact.

- `frontend/tests/unit/variations.test.js` — **67 tests**: 38 over the
  originating-RFI helpers in `lib/variations.js` (ADR-34) and 29 over the
  draft-edit helpers (ADR-35 — see the end of this bullet): `ORIGIN_RFI_STATUSES`
  is exactly open/answered/closed and every RFI status classifies one way;
  `normaliseOriginRfi` maps null/undefined/non-objects and every partial or
  malformed RFI to the all-null triple, a valid RFI to the **exact** id/number/
  title (no trim, truncation or reformatting — a 400-character title survives
  byte-for-byte), returns a fresh unfrozen object, ignores every non-link
  field, does not decide eligibility, and never mutates its input;
  `hasOriginRfi` and `originRfiLabel` on linked, explicitly unlinked and
  **legacy (keys absent)** variations; `eligibleOriginRfis` filtering, RFI-number
  ordering with an id tie-break (deterministic regardless of input order),
  junk tolerance, and no input reordering; `canEditOriginRfi` is draft-only and
  equals the existing `VARIATION_EDITABLE_STATUSES` freeze point;
  `variationsForRfi` exact-id matching (no prefix/case/null matching, every
  status included, legacy null ids never match `null`). **Financial-isolation
  regression guards**: `variationTotals`, both approved/pending supplier maps
  and totals, both client totals, `openVariationCount` and
  `duplicateVariationWarnings` return **identical** results for a register with
  the keys absent, the explicit null triple, and a populated link; and the
  triple carries only strings — no amount, currency or GST.
  **Draft editing (ADR-35, 29 tests):** `variationLineToForm` maps stored
  new-scope and PO-inherited lines to form strings (index → string, no chosen
  cost code on an inherited line, negatives/zero preserved, legacy/junk → safe
  defaults); `buildVariationLineItem` inherits cost code + snapshot from the PO
  line and **ignores a stale chosen cost code**, uses the chosen cost code for
  new scope, ignores `poLineIndex` without a PO, rounds to cents, derives GST
  per tax code, keeps negatives, and **always** emits `approvedAmount`/
  `approvedGst: null`; stored → form → built **round-trips** exactly;
  `validateVariationDraft` rejects a blank title, zero lines and a line with
  no cost code, and accepts negative/zero amounts (no stricter policy);
  `stripApprovedFromLines`; the origin-RFI payload contract (undefined =
  preserve, RFI = replace, null = remove, and a link to a **since-cancelled**
  RFI survives an unrelated edit); `notes` pass-through; purity over
  deep-frozen inputs; and a **financial regression** that edits a draft
  supplier and a draft client variation and proves every approved / committed
  / forecast / revenue / margin / invoicing output is **identical** while only
  the pending exposure figures move by the exact delta (including between
  cost codes, and via a PO that is now cancelled).

  Combined unit total: **1,125 tests** across the twenty files.

  ⚠️ **Runtime non-mutation across COLLECTIONS is still not automated.** The
  purity blocks above prove the pure derivation layer never writes to the
  documents it reads. They do **not** prove that `useClientInvoices`,
  `useClientReceipts` or `useSupplierPayments` write only to their own collection
  and counter, nor that Budgeted / Committed / Claimed / Invoiced / Actual /
  Forecast / margin figures are unmoved on the Budget and Commercial pages. Those
  remain manual (§15i-xv, §15j-xiii, §15k-xvi) until the integration-test
  milestone.

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
- [ ] Documents/Photos/Reports tabs show placeholder cards, no data wiring (Variations — see §14 — Forecast — see §15 — Commercial — see §15g — BOQ and Tenders — see §15s — and Timeline — see §15p — are now live).

### 2a. Edit Project metadata (ADR-39)

Rules coverage is automated (§0). These are the end-to-end checks the emulator
cannot make.

- [ ] Signed in as `company_admin` or `project_manager`, each project row shows **View ▾** and **Edit**. Signed in as `qs`, `subcontractor` or `client`, **no Edit action appears**.
- [ ] Edit → the modal is titled **Edit Project**, prefilled with the stored name, status, start date, location and progress, and the primary button reads **Save Changes**.
- [ ] Change name, location, start date, progress (0 → 35) and status (Planning → In Progress) → Save. The list row, the project header, the Overview cards and the Dashboard **"active projects"** count all update immediately.
- [ ] **Headline Budget renders READ-ONLY** in the modal, with the note that it is set at creation and that the current Approved Budget lives on the Budget tab. **Currency renders READ-ONLY**, pointing at the Overview currency card.
- [ ] The Budget column, project header and Overview card are all labelled **"Headline Budget"**, never plain "Budget".
- [ ] The status list offers all five values from **every** current status, and a **Completed** project can be set back to **In Progress** — status is descriptive, not a lifecycle. The modal says so.
- [ ] Clearing the start date and saving shows "—" wherever the date appeared.
- [ ] A blank project name blocks Save with an inline message.
- [ ] **Financial invariance:** before and after the whole edit, the Budget, Forecast, Commercial (Margin) and Cash Flow tabs show **identical figures**.
- [ ] There is **no Delete or Archive** action on a project.
- [ ] Modals are usable at 375 px, 768 px and 1280 px.

## 3. Cost Codes

- [ ] Cost Codes tab (within a project) lists company-wide codes ordered by code.
- [ ] Create one (code + name required; category/unit optional) → appears in **every** project's Cost Codes tab and in PO/budget-line dropdowns.
- [ ] New codes are created `isActive: true`; there is no delete action.

### 3-i. Edit, Deactivate and Reactivate Cost Codes (ADR-39)

- [ ] Signed in as `company_admin`, `project_manager` or `qs`, each row shows **Edit** plus **Deactivate**/**Reactivate**. As `subcontractor` or `client`, **no write actions appear** and "+ Add Cost Code" is hidden.
- [ ] Edit a code's **code and name** → Save. The Cost Codes list, the **Budget tab row label**, and the **Forecast** and **BOQ** row labels all show the new label immediately.
- [ ] **No backfill:** open an existing **sent PO** and a **posted supplier invoice** that used that code — their stored line labels are **UNCHANGED**. Same for an approved progress claim and a variation.
- [ ] **Financial invariance after the rename:** Budget (Budgeted/Committed/Actual/Invoiced/Remaining), Forecast (including Forecast Final Cost), Commercial (Margin) and Cash Flow are all **unchanged**.
- [ ] Saving a code that duplicates another code (differing only in case or spacing) is **blocked** with "already in use". Saving the **same record** with its own unchanged code succeeds.
- [ ] **Deactivate** shows a confirmation explaining that existing records keep the code and no figure changes → confirm. The row badge flips to **Inactive**.
- [ ] After deactivation: the code **no longer appears** in the New Budget Line picker; the **existing budget line still shows and still totals**; Forecast and BOQ rows still show it, flagged **(inactive)**; every figure is unchanged.
- [ ] **Reactivate** restores it to the picker.
- [ ] A cost code created before the `isActive` flag existed still shows as **Active** and remains editable.
- [ ] There is **no Delete** action.

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

### 4a. Edit Budget Lines (ADR-39)

Rules coverage is automated (§0). **This is the one edit in this feature with a
financial effect, so the invariance checks below are the important ones.**

- [ ] Signed in as `company_admin`, `project_manager` or `qs`, each budget row shows **Edit**. As `subcontractor` or `client`, no Edit appears and "+ Add Budget Line" is hidden.
- [ ] The **create** picker offers **ACTIVE cost codes only**. With no active codes, the tab disables creation and links to Cost Codes.
- [ ] Edit a line → the modal is titled **Edit Budget Line**; **the cost code renders READ-ONLY** with the reason, and only **Budgeted** and **Notes** are editable. A line whose cost code has since been **deactivated** still opens and still saves.
- [ ] Change Budgeted 100,000 → 112,500 and Save. Then check, one screen each:
  - [ ] **Budget tab** — line Budgeted 112,500, line Remaining **+12,500**, header Budgeted and Remaining **+12,500**, usage bar moves. **Committed, Claimed, Actual and Invoiced are UNCHANGED.**
  - [ ] **Forecast tab** — row Budgeted and **Variance to Budget +12,500**, Remaining Budget Reference **+12,500**, and **Forecast Final Cost UNCHANGED** (the stored Uncommitted CTC is not recomputed).
  - [ ] **Commercial tab** — **Forecast Gross Profit, Forecast Margin %, Current Contract Sum, Original Planned Profit and Margin Movement all UNCHANGED.**
  - [ ] **Cash Flow tab** — **UNCHANGED** in every figure.
  - [ ] **BOQ tab** — Approved Budget total and the BOQ variance move by 12,500.
- [ ] Setting Budgeted to **0** saves (a reviewed allocation of nothing) and the row stays, showing a negative variance rather than disappearing.
- [ ] A **negative** or non-numeric Budgeted is blocked with an inline message and nothing is written.
- [ ] Editing only **Notes** leaves every figure untouched.
- [ ] There is **no Delete**, no way to change the cost code, and no bulk edit.

## 5. Purchase Orders

- [ ] With zero cost codes: PO tab disables creation and links to Cost Codes.
- [ ] Create a draft PO: supplier is picked from active supplier/subcontractor contacts (required); every line needs a cost code; line total = qty × rate; footer shows Subtotal, GST 10%, Total.
- [ ] "+ New" beside the supplier picker quick-creates a minimal contact (name + type) and auto-selects it; the contact then appears on `/contacts`.
- [ ] The created PO stores `supplierId` and shows the contact's display name; renaming the contact afterwards does **not** change the PO's supplier name.
- [ ] POs created before the Contacts module (`supplierId: null`) still display their free-text supplier name.
- [ ] PO number is sequential company-wide (`PO-0001`, `PO-0002`, …) even when two users create simultaneously.
- [ ] Draft badge shown; draft row actions are **Edit · Send · Cancel** (Send/Cancel with confirm dialog).
- [ ] **Edit draft (ADR-36):** header reads `Edit PO-000n`; a read-only block shows PO number, the stored supplier name and the Draft badge — no supplier dropdown, no "+ New". Description, notes and every line are prefilled.
- [ ] Change description + notes → **Save changes** → register updates; PO number and supplier unchanged.
- [ ] Change a qty/rate → footer Subtotal/GST/Total recompute → Save → register total updates; Budget / Forecast / Commercial Committed figures **unchanged** while Draft.
- [ ] Add a line, remove a line, change a line's cost code → Save → Cost Codes column updates. An untouched Edit → Save leaves the document unchanged.
- [ ] A draft line whose cost code has since been removed shows no selection and an amber "choose a current cost code" hint; Save is disabled until a current code is picked.
- [ ] Send the edited PO → **Edit** disappears; Budget Committed equals the **edited** ex-GST line totals; claims / invoices / supplier variations can use the Sent PO normally.
- [ ] Stale edit: tab A opens Edit on a draft; tab B Sends it → tab A shows "This purchase order is no longer Draft…" and Save is disabled; a save attempted at that moment is refused with the same message.
- [ ] A legacy PO with `supplierId: null` is editable and shows its stored free-text supplier name.
- [ ] Sent PO: no edit path; can be **Closed** or **Cancelled**; Closed/Cancelled show no further actions and no **Edit**.
- [ ] Editor is usable at 375 / 768 / 1280 px (context block stacks on mobile; line grid wraps as at create).

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

## 7a. Edit Draft Progress Claims (ADR-37)

- [ ] Draft claim row actions are **Edit · Submit · Withdraw**, Edit first. No **Edit** appears on a submitted, under review, approved, rejected or invoiced claim.
- [ ] **Edit** opens `Edit PC-000n`. A read-only block shows Claim #, PO number, the stored supplier name and the Draft badge, with *"Fixed at creation — wrong PO or supplier? Withdraw and raise a new claim."* — **no PO selector, no supplier control**.
- [ ] Period Ending, Claim Ref, Notes, Retention and every line's claimed-to-date are prefilled from the stored claim; lines render in stored order with cost code, description, "of {PO line total}" and, where non-zero, "approved {previously approved}".
- [ ] Change Period Ending, Claim Ref and Notes → **Save changes** → register Period updates; claim number, PO and supplier unchanged.
- [ ] Change one line's claimed-to-date → the ±this-period figure recomputes → the footer Claimed / Retention / GST 10% / Total payable recompute → Save → the register's **Claimed (inc. GST)** updates.
- [ ] Change Retention → GST is 10% of (subtotal − retention), **not** 10% of the subtotal. Enter retention above the subtotal → it clamps to the subtotal on save and the payable total is zero.
- [ ] Enter a line below its previously-approved amount → red **Below approved** on the line, an amber "claimed to date cannot be below the previously approved amount" hint, and Save disabled.
- [ ] Zero every line → amber "must claim an amount on at least one line" and Save disabled.
- [ ] Enter above the PO line value → amber **⚠** but Save **remains enabled** (warned, not blocked).
- [ ] **No add / remove / reorder line control exists** in either Create or Edit; the line count always equals the PO's line count.
- [ ] An untouched Edit → Save leaves the document unchanged.
- [ ] **Draft financial non-effect:** before and after the edit, Budget (Committed / Claimed / Actual / Remaining), Forecast, Commercial, Overview margin cards, Cash Flow and Retention are **all identical**, and the Invoices tab still offers no invoice from this claim.
- [ ] **Submit** the edited claim → **Edit disappears**; Budget **Claimed** rises by exactly the edited claimed-this-period; Actual unchanged.
- [ ] **Assess → Approve** → certified amounts are bounded by the **edited** claimed amounts (entering more is rejected); Claimed falls, Actual rises by the certified total; a claim-sourced Supplier Invoice reconciles as normal.
- [ ] **Withdraw** a separate draft → it becomes Rejected with no **Edit**, and its PO becomes claimable again.
- [ ] **Stale edit:** tab A opens Edit on a draft; tab B Submits (or Withdraws) it → tab A shows *"This progress claim is no longer Draft. Close the editor and review the latest version."* and Save is disabled; a save attempted at that moment is refused with the same message.
- [ ] A draft claim whose PO has since been **Closed or Cancelled** is still editable, with a muted advisory naming the PO's new status.
- [ ] A legacy claim with `supplierId: null` is editable and shows its stored free-text supplier name.
- [ ] Editor is usable at 375 / 768 / 1280 px (context block stacks on mobile; line grid wraps as at create).

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

## 13e. Edit Draft Supplier Invoices (ADR-38)

*Draft is the only editable status. `approved` is the authoring freeze point;
`posted` is the financial counting point. Draft-only editing and every
immutability below are **client-enforced only** — a direct-SDK caller can still
rewrite an approved or posted invoice ([SECURITY.md](SECURITY.md) → Deferred
Controls 1 and 2).*

### Direct against PO

- [ ] Create a draft invoice against a **sent** PO with two priced lines. The row action set reads **Edit · Approve · Cancel**, with Edit first.
- [ ] **Edit** → title reads `Edit SI-####`. There is **no** source toggle, PO picker, claim picker or supplier picker.
- [ ] The read-only context shows the SI number, `Direct against PO`, the supplier name, the PO number and status **Draft**.
- [ ] Supplier invoice #, invoice date, received date, due date and notes are prefilled from the stored values.
- [ ] The line list shows exactly the lines stored when the draft was raised, with cost code and description read-only, and amount + tax code prefilled.
- [ ] Change the supplier invoice number, invoice date and notes → **Save changes** → the register and detail modal show the new values; `SI-####`, supplier, PO and source are unchanged.
- [ ] Change a line amount and pick a different valid tax code → the totals footer recomputes live (subtotal, GST, gross, net payable) → Save → the detail modal matches, and the line's GST equals 10% of the amount for `gst` and 0 for `gst_free`/`input_taxed`.
- [ ] Set retention > 0 → net payable falls by retention × 1.1; the footer shows the ex-GST + GST split → Save → the detail modal matches.
- [ ] Set retention **above** the subtotal → it clamps to the subtotal, net payable is 0, never negative.
- [ ] Enter a **negative** retention → Save is **blocked** with "Retention cannot be negative" (not only the input's `min`; the hook refuses it too).
- [ ] Clear the supplier invoice number → Save blocked. Clear the invoice date → Save blocked. Set **every** stored line amount to zero → Save blocked.
- [ ] Enter the supplier invoice number of another non-cancelled invoice for the **same** supplier → amber duplicate warning appears and **Save is still allowed**.
- [ ] Reopen that same invoice and save it unchanged → **no** duplicate warning against itself.
- [ ] Take a line above its PO line value → amber ⚠ on the line; take the total above the PO subtotal → the over-PO advisory. **Neither blocks Save.**
- [ ] Confirm there is **no** control to add a line, remove a line or reorder lines, and that a PO line left at zero when the draft was created is **not** shown (the editor says so; cancel and raise a new invoice instead).
- [ ] Take a stored line to **zero**, save, reopen → the line is still listed at 0 with its cost code intact, and can be given an amount again.
- [ ] **Legacy tax code:** for a draft whose stored line carries an unrecognised `taxCode`, the tax select shows an empty red *"Choose a tax code…"* placeholder, Save is blocked with `Line N: choose a tax code…`, and the code is **not** silently converted to GST. Picking a valid code unblocks Save.

### From an approved claim

- [ ] Create a draft invoice from an approved progress claim → **Edit**.
- [ ] Context shows `From approved claim` with both the PO and claim numbers.
- [ ] Supplier invoice #, invoice date, received date, due date and notes are editable.
- [ ] Line **amounts are read-only**; **tax codes are read-only** (rendered as text, not a select); **retention is read-only** with "Carried from the approved claim."
- [ ] Save a header-only change → succeeds; the detail modal shows the new header values and **identical** subtotal, GST, gross, retention, payable GST and payable total.
- [ ] Post the invoice → the payable GST and payable total still equal the claim's certified `approvedGst` / `approvedTotal`.

### Financial non-effect

- [ ] Note Budget **Invoiced / Actual / Committed / Remaining**, Forecast, Forecast Final Cost, Commercial, Overview **Margin %**, Cash Flow (Actual and Forecast Cash Out, open AP), **Retention Held**, Supplier Payments payables, Credit Notes register and PO remaining. Now make a **large** draft edit (change both amounts, change both tax codes, add retention) → **every one of those figures is unchanged.**
- [ ] **Approve** the edited draft → *Edit* disappears (row shows Post · Cancel only) → **still** no movement in any figure above.
- [ ] **Post** it → Budget Invoiced and Actual rise by the **edited** ex-GST total, Committed for those PO lines drops by the same amounts, and Retention Held shows the **edited** retention.

### Downstream still works

- [ ] Post an edited **zero-retention** invoice → *Record credit note* appears → raise and post one → remaining payable falls correctly.
- [ ] Post an edited invoice → *Record payment* → allocate → Paid to Date and Remaining Payable are correct and **no allocation exception** is raised.
- [ ] Post an edited invoice **with** retention → it appears on the Retention register with the edited figures; a retention release works.

### Stale editor (two tabs)

- [ ] Tab A: open **Edit** on a draft. Tab B: **Approve** it. Tab A shows *"This supplier invoice is no longer Draft. Close the editor and review the latest version."* and Save is disabled.
- [ ] Repeat with **Cancel** in Tab B → same behaviour.
- [ ] Two draft editors open on the same invoice remain **last-write-wins** (documented, not prevented).

### Legacy records

- [ ] A pre-Contacts invoice (`supplierId: null`) opens for edit, shows its stored `supplierName`, and saves; duplicate detection falls back to the name match.
- [ ] An invoice whose PO has since been **closed or cancelled** still opens and saves; the over-invoicing advisory is simply absent.
- [ ] An invoice with a missing or malformed stored line `amount` renders `0`, not a blank input.

### Responsive

- [ ] **375 / 768 / 1280** — the editor scrolls within `max-h-[90vh]`, the line grid reflows at `sm:`, there is no horizontal page overflow, and the close button stays ≥ 44 px.

## 13f. Supplier Invoice Rules Hardening — Rules-enforced (AUTOMATED — see §0)

**Everything in this section is proven by the automated emulator suite**
`frontend/tests/rules/supplierInvoices.rules.test.js` (141 tests), not by
clicking. It is listed here so the manual pass knows what the boundary now
guarantees, and — just as importantly — what it still does not.

⚠️ **These rules must not be published before the updated application code is
deployed.** They require `updatedAt`/`updatedBy` on every write and
`cancelledBy` on a cancellation, and pre-ADR-40 builds send none of the three.
See [DEPLOYMENT.md](DEPLOYMENT.md) → *Ordering gate*.

### Rules-enforced (automated)

- [ ] Reads, creates and updates are `company_admin` / `project_manager` / `qs`
      only; `subcontractor`, `client`, unauthenticated, cross-company and a user
      with **no membership document** are all denied. Delete is blocked for every
      role in every status.
- [ ] A create must be `status: 'draft'`, `docType: 'invoice'`, a `source` of
      `direct_po` or `progress_claim`, with `createdBy`/`updatedBy` == the caller
      and `createdAt`/`updatedAt` == server time, and **all eight** of
      `approvedAt`/`By`, `postedAt`/`By`, `cancelledAt`/`By`, `paidAt`,
      `adjustsInvoiceId` null.
- [ ] **Source validation at create:** the `poId` must be a `sent`/`closed` PO in
      **this** project; a `progress_claim` invoice's claim must be `approved` in
      this project; a `direct_po` invoice must carry `progressClaimId: null`.
- [ ] **Those references are never revalidated.** Cancel the PO afterwards (or
      reject the claim) and the invoice can still be edited, approved and posted.
- [ ] Sixteen identity fields are immutable for life, including both source
      references, `paymentTerms`, and the dead `paidAt`/`adjustsInvoiceId`.
- [ ] Only `draft → approved`, `approved → posted`, `draft|approved → cancelled`.
      **`draft → posted` is rejected** (posting cannot skip approval).
      `posted` and `cancelled` accept **no** update at all — a posted invoice
      cannot be cancelled, unposted, or rewritten.
- [ ] `received`, `under_review`, `disputed` and `paid` are **unauthorable from
      any path**, at create and at every transition.
- [ ] Each transition carries **only** `status`, its own two stamps and
      `updatedAt`/`updatedBy`; the actor must be the caller and the timestamp the
      server's. Smuggled content is rejected.
- [ ] An **approved** invoice takes no header, line, retention or total edit —
      only post or cancel.
- [ ] A `progress_claim` draft is **header-only**: any line, retention or total
      change is rejected, including an internally consistent one.
- [ ] A `direct_po` draft may re-author line money, but the stored **line count**
      cannot grow or shrink.
- [ ] Header money must balance in whole cents (five identities), `retentionGst`
      must be exactly `round(retention × 10%)`, `subtotal > 0`, `retention >= 0`
      and `retention <= subtotal`.
- [ ] Invoices raised **before** ADR-40 (no `updatedAt`/`updatedBy`/
      `cancelledBy`) stay editable and acquire the fields on their next write; a
      legacy **posted** invoice is still terminal.

### Manual spot-checks (the app must still work against the new rules)

- [ ] Create a `direct_po` draft, edit it, approve it, post it — each step
      succeeds with no permission error in the console.
- [ ] Create a `progress_claim` draft from an approved claim, correct its header,
      approve and post it.
- [ ] Cancel a draft and cancel an approved invoice; both succeed.
- [ ] A **posted** invoice offers no Edit and no Cancel, and the register renders
      unchanged.
- [ ] **Negative retention is refused at create**, not just on edit — the hook
      throws "Retention cannot be negative" before anything is written.
- [ ] An approved claim whose PO has since been **cancelled** can no longer be
      invoiced (a create-time refusal). This is the one accepted behavioural
      consequence of the Tier-2 checks — see ADR-40 D4.

### Deliberately NOT enforced — do not report these as controls

- [ ] Duplicate supplier invoice references, duplicate `SI-####` numbers, two
      invoices against one approved claim, and cumulative over-invoicing against
      a PO all still succeed at the boundary (no sibling aggregation).
- [ ] `lineItems` contents are unverified: header totals contradicting their own
      lines, a negative per-line amount, a bogus cost code, an invalid tax code,
      a self-contradicting `gstAmount` and an arbitrary `poLineIndex` are all
      writable (Deferred Control 29).
- [ ] Creator == approver == poster is permitted; impossible-but-well-shaped and
      future dates are permitted; concurrent draft edits are last-write-wins.
- [ ] A wholly **GST-free retained invoice** produces a **negative**
      `payableGst`/`payableTotal` and is **accepted** — a deferred *domain*
      issue, not a rules gap (Deferred Control 30). Do not "fix" it here.

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

### 14d-0. Originating RFI (evidence link — ADR-34; rules AUTOMATED — see §0)

- [ ] New Variation (either type) shows **Originating RFI (optional)** with `None` selected. Create without choosing one → the register row shows no RFI sub-line; summary cards and every financial figure are exactly as before.
- [ ] Raise an RFI (`open`), then create a variation choosing it. The option reads `RFI-0001 — <title>`. The register shows a muted `RFI-0001 — <title>` line under the variation title. Search for `RFI-0001` finds it.
- [ ] A **draft** RFI and a **cancelled** RFI are **not** offered in the dropdown. With no open/answered/closed RFI in the project the dropdown is disabled and explains why.
- [ ] A **draft** variation row has an **Edit** action (ADR-35 — the link-only *Origin RFI* action no longer exists). Edit opens the variation editor with **Originating RFI** pre-selected; change it to another eligible RFI → Save draft → sub-line updates; set `None` → sub-line disappears. Nothing else on the variation changes unless you edit it (title, lines, totals, status, dates).
- [ ] **Submit** the variation → the **Edit** action disappears; the sub-line remains. Submitted/approved/rejected/withdrawn rows never show Edit.
- [ ] Open the linked RFI's detail → **Linked variations** lists `SV-0001 — <title>` with its status badge. An RFI nobody cites shows `None`.
- [ ] Budget, Forecast, Commercial, Cash Flow and Client Invoice figures are **identical** before and after linking (the link is metadata). The RFI document is unchanged (spot-check: no `variationId` on it).
- [ ] Submit → Assess → Approve / Reject / Withdraw all still work on a linked variation exactly as on an unlinked one.
- [ ] **Historical case:** link an **open** RFI to a draft variation, then **cancel** that RFI from the RFIs tab. The variation still shows the `RFI-… — …` sub-line; Edit shows the selection as `RFI-… — title (no longer eligible)` with an explanation; **Save draft without touching it → the link is kept** (spot-check `originRfiId` unchanged); editing another field, submitting, assessing and approving all still succeed. Choosing that cancelled RFI as a *new* link is not possible (not listed on any other variation; a direct write is rules-rejected).

### 14d-1. Edit Draft Variations (ADR-35)

**Supplier Variation**

- [ ] Create a draft **Supplier Variation** against a sent PO with one **PO-inherited** line and one **new-scope** line (own cost code), and an **Originating RFI**. Note Pending Supplier Exposure on the Variations cards, the Forecast pending column per cost code, and Commercial's *Pending Supplier Variation Exposure*.
- [ ] The draft row shows **Edit · Submit · Withdraw** (Edit first). Edit opens `Edit SV-000n`: type, supplier and PO are shown as **read-only information** (with "withdraw and recreate" guidance), every other field is pre-filled, live totals work.
- [ ] Change **title** and **reason** → **Save draft** → row updates; number, type, counterparty, PO, status and Submitted total unchanged.
- [ ] Edit the **new-scope amount** (e.g. 300 → −150) → Save → Pending Supplier Exposure and the Forecast pending cell move by exactly the delta; **Approved Supplier Variations, Commitment Exposure (Budget), Forecast Final Cost, Current Contract Sum, Gross Profit** are unchanged.
- [ ] **Add** a line on another cost code and **remove** the original new-scope line → Save → pending exposure moves between cost codes on Forecast; the register cost-code filter follows.
- [ ] Change the new-scope line's **cost code** → Save → the register's cost-code filter and the Forecast pending column follow; the PO-inherited line still shows its PO cost code (locked) and the PO document is unchanged.
- [ ] Change the **Origin RFI** to another eligible RFI → Save → sub-line and the RFI detail's *Linked variations* follow. Set **None** → Save → sub-line gone.
- [ ] **Historical:** link an open RFI, cancel it on the RFIs tab, Edit → the selection reads `(no longer eligible)`; Save without touching it → link preserved. Then choose None or another RFI → Save → replaced.
- [ ] **Submit** → **Edit disappears**; Assess/Withdraw continue exactly as before; Approve uses the edited submitted amounts as its prefill.

**Client Variation**

- [ ] Create a draft **Client Variation**; note *Pending Client Variation Exposure* (Variations cards, Commercial, Client Invoices) and *Current Contract Sum* / *Available to Invoice*.
- [ ] Edit title, **Client Reference** and the line amount → Save → Pending Client Exposure changes; **Current Contract Sum and Available to Invoice do not**; the draft is still not offered on a client invoice line.
- [ ] Submit → Edit disappears.

**Stale editor**

- [ ] Open Edit on a draft. In a second tab **Submit** or **Withdraw** it. The stale editor shows "This variation is no longer Draft…" and **Save draft is blocked**; a save attempt never writes (the submitted/withdrawn document is unchanged).

**Responsive**

- [ ] At 375 / 768 / 1280 px the editor scrolls inside the modal, the read-only context block stacks, and line rows wrap without horizontal page scroll.

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

### 15h-vii-a. Legacy project with NO currency — the one-time pin (regression)

The defect this scenario exists for was confirmed against live data: a project
with `currencyLocked: true`, **no** stored `currency`, and real financial records
could not be pinned by Company Settings — the save failed with **"Missing or
insufficient permissions."** The rules ratchet was comparing
`request.currency == resource.currency` and read the project's FIRST currency
(`''` → `'AUD'`) as a forbidden relabel, leaving such projects permanently
unpinnable and their amounts floating on the company base currency.

### ADR-39 rules suites (automated — see §0)

- `frontend/tests/rules/projects.rules.test.js` gained **37 tests**: the
  headline `budget` is immutable in both directions (including delete, a smuggled
  change, an accepted identical rewrite, and a project with no `budget` key);
  `createdAt`/`createdBy` immutable; the five-value status enum accepted, every
  status-to-status move accepted (including reopening `Completed`), and
  out-of-vocabulary/non-string values rejected; `name`/`progress`/`location`/
  `startDate` shapes including both bounds and clearing `startDate` to null; the
  **legacy carve-out** (an untouched out-of-enum status leaves the document
  writable, the Company Settings currency pin still succeeds on it, a legacy
  status may be corrected once and a valid one can never regress); the `qs`
  ratchet branch proven unaffected; and non-writer roles still refused.
- `frontend/tests/rules/costCodes.rules.test.js` — **new, 51 tests**: the read
  audience and tenant isolation; create by the three writer roles and refused for
  the rest; provenance immutability; the update key allow-list; every field shape
  and length bound; `isActive` reversible in **both** directions and a legacy
  document with no `isActive` key still writable; deletes blocked for every role;
  and **Group F proves the documented gap** — duplicate codes are accepted at the
  boundary, because rules cannot query siblings.
- `frontend/tests/rules/budgetLines.rules.test.js` — **new, 65 tests**: the read
  audience and tenant isolation; create shape (`costCodeId` required, `budgeted`
  numeric ≥ 0, zero accepted, negative rejected); **`costCodeId` re-pointing
  rejected** (alone, smuggled, and deleted); **`costCodeName` re-snapshot
  rejected**; the vestigial `committed`/`actual`/`invoiced` frozen; provenance
  immutable; `budgeted` numeric safety (zero, decimals, negative, numeric string,
  null/bool/map, deletion); the key allow-list; **audit stamps verified** against
  caller and `request.time` using the deliberately skewed client clocks; legacy
  documents (no `notes`, no `costCodeName`) still correctable but unable to
  *gain* a snapshot; deletes blocked; and **Group G proves the documented gaps** —
  a non-existent `costCodeId` and a second line on one cost code are both
  accepted at the boundary.

**Automated coverage is in `frontend/tests/rules/projects.rules.test.js`** (§0) —
every accept and reject listed below is asserted there against the emulator. The
steps here are the **end-to-end** check the emulator cannot make: the real page,
the real batch write, and the real figures on screen.

Setup: a project with `currencyLocked: true`, no `currency` field, and financial
records (a headline budget, budget lines, POs — anything monetary). Sign in as
`company_admin`. Reaching this state honestly needs a project created before the
currency foundation, or one seeded that way with admin credentials.

- [ ] Company Settings lists that project with stored currency **"Not set"** (amber)
  and an **enabled** selector — a locked project with no currency is offered for a
  one-time pin, while a locked project that already carries a currency shows
  **🔒 locked — has financial records** and no control.
- [ ] Choose the currency the amounts were actually entered in, tick the
  confirmation, and **Save** → the save **succeeds** (this is the regression: it
  previously failed with "Missing or insufficient permissions").
- [ ] The project now carries an **explicit** `currency`, and `currencyLocked` is
  **still `true`** (check the console) — the pin does not release the ratchet.
- [ ] **No amount changed.** Budget, Committed, Claimed, Invoiced, Actual,
  Forecast, and the Commercial margin are identical before and after; only the
  label the figures carry is now stored rather than inherited.
- [ ] Re-open Company Settings → that project is now **frozen** (🔒, read-only).
  Attempting a **direct SDK** write changing its currency is **rejected by rules**,
  and so is deleting or blanking it. The pin is one-way, exactly like the lock.
- [ ] Changing the company base currency afterwards leaves that project's
  currency and every amount unchanged.

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
- [ ] Locked projects that already carry an explicit currency appear in the settings list as
  **frozen** (🔒, read-only), not editable. A locked project with **no** stored currency is the
  one exception and stays editable for its single one-time pin — see §15h-vii-a.

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
- [ ] The **Commercial** tab shows sub-navigation **Margin · Client Invoices · Client
  Receipts · Supplier Payments · Cash Flow · Retention**. Margin is the default and is
  byte-for-byte the previous Commercial page.
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

> **Client Receipts now exist.** This panel no longer ages an invoice at its full
> gross forever — it ages the **remaining balance after posted receipts**. The
> arithmetic is covered automatically by
> `frontend/tests/unit/clientInvoices.test.js` → *ageingByDueDate* and
> `frontend/tests/unit/clientReceipts.test.js` → *arAgeing*. Check the **wording
> and presentation** here.

- [ ] The AR panel is titled **"Accounts Receivable — ageing by due date"**, subtitled
  **"Gross (inc. GST) · remaining balance after posted receipts"**, and shows
  **Received to Date** and **Remaining to Reconcile**, plus buckets *No due date*,
  *Not yet due*, *Past due 1–30 / 31–60 / 61–90 / 90+ days*.
- [ ] A standing notice states that balances reflect **posted receipts**, that
  over-allocation is **warned but not blocked**, that two users allocating the same
  balance concurrently cannot be prevented, and that **unallocated receipts are shown
  separately and reduce no invoice balance**.
- [ ] No screen claims receipts are unrecorded, or that an issued invoice stays listed
  "regardless of payment" — that was the pre-Receipts disclaimer and is now wrong.
- [ ] No screen uses **"paid"**, **"unpaid"**, or **"partially paid"** as an invoice
  *status*, and no invoice row shows a payment-status badge. Reconciliation is reported
  as *Unreconciled / Partly reconciled / Fully reconciled / Over-reconciled* (ADR-22).
  *(Search the running UI, not the source: the source contains those words only in
  comments recording that they are deliberately not used.)*
- [ ] Buckets use **gross (inc. GST)** amounts and count **issued** invoices only —
  drafts and voids appear in none of them.
- [ ] An invoice dated 45 days past due lands in *Past due 31–60 days*; the register row
  shows "Past due 45d" in red; the **Past due date** filter narrows to it.
- [ ] Reconcile that invoice in full with a posted receipt → it leaves the buckets
  entirely and is **no longer** marked past due. Void the receipt → the balance and the
  past-due marker both return.
- [ ] Over-reconcile an invoice → it is **excluded** from the buckets and reported in its
  own **"Over-reconciled invoices"** callout, so a negative balance never offsets
  genuine arrears.

### 15i-x. Lifecycle — Rules-enforced (AUTOMATED — see §0)

**These cases are covered by the automated emulator suite** in
`frontend/tests/rules/clientInvoices.rules.test.js` (`npm run test:rules`, 32
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
- [ ] void with a `voidReason` that is **empty (`""`)** or **whitespace-only (`"   "`,
  a tab, a newline)**, or with `voidedBy` ≠ the caller. A void reason is an audit
  record, so the rule compares `voidReason.trim().size() > 0` — matching
  clientReceipts, supplierPayments, supplierCreditNotes, retentionReleases and
  boqItems. A reason with real content **surrounded** by whitespace is still accepted.
  *(This block previously compared `voidReason.size() > 0`, which accepted `"   "`.
  Tests `10`, `10b` and `10c` in the suite are the regression guard.)*
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

**Already proven automatically — do NOT re-test by hand.** The emulator Rules suite
(`npm run test:rules`) is the authoritative test for the trust boundary and already
exercises `company_admin`, `project_manager`, `qs`, `subcontractor`, `client`, an
unauthenticated caller and a financial-role user in a **second company**:

- role permissions (financial roles allowed; subcontractor and client denied read,
  create, update and delete) — `clientInvoices.rules.test.js` §17;
- unauthenticated denial — §17b;
- cross-company denial **in both directions** — §18.

Do not create six accounts to repeat these. What a human still needs to check:

- [ ] Signed in as `subcontractor` or `client`, the Client Invoices view shows the
  **restricted card** and **no** invoice data. *(This is the UI's own gating — the rules
  suite proves the data is unreachable, not that the screen looks right.)*
- [ ] Record every Budget figure, Forecast rollup, and Commercial margin figure before
  and after this whole suite → **every number identical**. Client invoices are
  revenue-side and change no cost figure and no margin figure.
- [ ] No Budget Line, PO, Progress Claim, Supplier Invoice, Variation, Forecast Line, or
  Commercial Baseline document is modified by any client-invoice action.
- [ ] The **client variation** document is byte-identical before and after invoicing —
  `status`, `approvedSubtotal`, `lineItems`, and no invoice back-reference.

> The last three remain **manual** on purpose. The read-time derivations are guarded by
> `frontend/tests/unit/clientInvoices.test.js` (frozen-input purity: no derivation writes
> to the variation or invoice objects it reads), but nothing yet asserts at runtime that
> the **hook** writes only to `clientInvoices` and its counter. That is an
> integration-test gap, tracked for the integration-test milestone.

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
  Client Receipts · Supplier Payments · Cash Flow · Retention**; Margin remains
  the default. The sub-nav label is **"Client Receipts"** — the shorter word
  "Receipts" appears nowhere in the navigation.
- [ ] `/projects/{id}/commercial/receipts` loads directly and is shareable. The
  **URL keeps the shorter `receipts` segment** (it predates Supplier Payments and
  was deliberately not renamed) — only the label was disambiguated.
- [ ] With no client-type contacts, creation is disabled with a link to Contacts.
- [ ] Signed in as `subcontractor` or `client`, the **Client Receipts** view shows
  the restricted card and **no** data. *(Role, tenant and unauthenticated denial
  itself is already proven by `clientReceipts.rules.test.js` §17/§17b/§18 — do not
  re-test it by hand; this checks the UI's own gating.)*

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

> **Partly automated.** `frontend/tests/unit/clientReceipts.test.js` → *purity*
> already proves every AR derivation leaves the Client Invoice and the receipt
> **byte-identical** — no balance, reconciliation state, `paid` status or receipt
> back-reference is added. What is **not** automated is whether the hook writes
> outside `clientReceipts` and its counter, and whether the Budget/Forecast/margin
> figures move. Those are the checks below.

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

> **Partly automated.** `frontend/tests/unit/supplierPaymentsPurity.test.js`
> already proves the whole payment-side derivation set leaves the Supplier Invoice
> **byte-identical**: `status` never becomes `paid`, `paidAt` stays `null`, the
> immutable `retention*` fields are never reduced, and no balance or
> payment-reference field is added. What is **not** automated is whether the hook
> writes outside `supplierPayments` and its counter, and whether the accrual
> figures move. Those are the checks below.

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

## 15o. Documents & Drawings

⚠️ **These tests require Cloud Storage to be enabled and `storage.rules`
published** — see [DEPLOYMENT.md](DEPLOYMENT.md) → *Enabling Cloud Storage*.
Before that, every upload correctly fails with *"File storage is not set up for
this Firebase project yet."*

### 15o-i. Drawings register

- [ ] Project → **Documents** shows a sub-nav with **Drawings** and **General
  Documents**; Drawings is the index and there is **no new top-level tab**.
- [ ] As `company_admin` or `project_manager`, **+ New Drawing** creates a
  master. You land on the drawing detail route
  (`/projects/:projectId/documents/drawings/:drawingId`) and it honestly shows
  **no current revision** — not an error, not a blank file.
- [ ] The register shows drawing number, title, discipline, current revision,
  issued date and status. Withdrawn drawings are **hidden by default**; "Show
  withdrawn" reveals them.
- [ ] Search matches number, title, discipline and current revision code; the
  discipline filter narrows correctly.
- [ ] Creating a second drawing with an existing number **warns and still
  allows it** (uniqueness is not enforced — see SECURITY.md).
- [ ] As `qs`, `subcontractor` or `client`: the register is **readable** but
  **+ New Drawing**, Edit, New Revision and Withdraw are absent.

### 15o-ii. Issuing revisions

- [ ] Upload Revision A (PDF): a progress bar runs, then the drawing shows
  **Rev A / Current** and the history has one row.
- [ ] Upload Revision B: B becomes current; **A becomes Superseded** in the same
  action; `revisionCount` reaches 2 and history is ordered **B then A**.
- [ ] Issue a revision coded **"10"** on a drawing that already has **"2"**:
  history still orders by issue sequence, **not** alphabetically.
- [ ] Cancel mid-upload: the upload stops, nothing appears in the register, and
  the dialog says *Upload cancelled.*
- [ ] Reject cases: a `.dwg` file, a `.docx`, a 0-byte file, and a file over
  **50 MB** are all refused **before** any upload starts.
- [ ] Duplicate revision code on the same drawing **warns, never blocks**.
- [ ] ⚠️ **Concurrency:** open the same drawing in two browsers, start an upload
  in both, and let the first finish first. The second fails with *"Another user
  issued a revision while you were uploading. Review the drawing before
  re-issuing."*, **nothing is promoted**, and the register still shows the first
  user's revision as current. (The second user's bytes are an accepted orphan.)
- [ ] After any failure, **Try Again** re-uploads under a **new** revision ID —
  it never overwrites the previous path.

### 15o-iii. Viewing, superseded and withdrawn warnings

- [ ] Open the current revision: file name, size, type and sequence show; the
  PDF opens in the browser's own viewer via **Open**; **Download** saves it.
- [ ] A PNG/JPEG revision renders inline; a PDF shows an iframe preview at
  desktop width only.
- [ ] Select a **superseded** revision from the history: a non-dismissible
  banner reads **SUPERSEDED — Revision B / Do not build from this drawing.
  Current revision is C.** It cannot be closed.
- [ ] Select a **withdrawn** revision: the banner reads **WITHDRAWN / Do not use
  this drawing.**
- [ ] Both warnings are legible with colour removed (print to greyscale or use a
  colour-blind simulator) — the **words** carry the meaning.

### 15o-iv. Withdrawal and succession

- [ ] Withdraw a **non-current** revision: it becomes Withdrawn; the current
  revision and the master pointer are **untouched**.
- [ ] Withdraw the **current** revision: the dialog **requires** an explicit
  choice and offers no default — either reinstate a named earlier revision or
  "No replacement". A whitespace-only reason is rejected.
- [ ] Choosing an earlier revision: it becomes **Current** again, the master
  shows its code and issue date, and `revisionCount` does **not** change.
- [ ] Choosing "No replacement": the drawing becomes **WITHDRAWN** with no
  current revision, a banner explains it, and no further revisions can be
  issued.
- [ ] Withdrawn revisions are never offered for reinstatement.
- [ ] **Nothing is ever deleted** — every withdrawn revision remains in the
  history with its reason.
- [ ] A drawing created but never uploaded to can be withdrawn from its detail
  page (**Withdraw Drawing**), with a reason.

### 15o-v. General documents

- [ ] As `qs`, upload a document with category, visibility, version and date.
  The register lists it and **Internal is shown with the word "Internal"** plus a
  lock glyph, not by colour alone.
- [ ] Reject cases: unsupported type, 0 bytes, and a file over **25 MB** (note
  this ceiling is **lower** than a drawing's).
- [ ] **Replace** a document: the new record is active, the old one shows
  **Superseded**, and **both files remain openable**.
- [ ] Withdraw a document with a reason; a whitespace-only reason is rejected.
- [ ] As `subcontractor` or `client`: `project` documents are listed and
  openable; **`internal` documents do not appear at all**, and the page says
  internal documents are not listed rather than implying the register is empty.
- [ ] Flip a document from `project` to `internal` while a subcontractor has the
  page open: it disappears from their register on the next read. ⚠️ A download
  URL they already opened keeps working (SECURITY.md → Deferred Control 22).

### 15o-vi. Failure honesty and responsive

- [ ] Go offline or sign in as a role whose read is denied: the registers say
  **"Drawings are unavailable"** / **"Documents are unavailable"** — never "No
  drawings" or "No documents".
- [ ] At **375px**: both registers render as **cards, not squeezed tables**; the
  drawing number and title are large; the whole card is tappable; every action
  is ≥44px; there is no page-level horizontal scroll.
- [ ] At **768px / 1280px**: the register tables render; modals fit with internal
  scrolling.
- [ ] ⚠️ **At 768px and at every width between 768px and full desktop**, the
  Drawings register, the General Documents register and the Revision History
  table **scroll horizontally inside their own card** and the row actions
  (Open · Replace · Withdraw, and View · Withdraw on revisions) are reachable
  **without widening the browser**. A register table sits inside `Card`, which
  is `overflow-hidden` for its rounded corners, so a table with no
  `overflow-x-auto` container of its own is **clipped, not scrolled**, and its
  right-hand action column becomes permanently unreachable — the live
  acceptance defect this check exists to catch. Drag the register left/right;
  the page itself must not scroll sideways.
- [ ] No financial figure anywhere in the app changes as a result of any action
  in this section.

## 15p. Project Timeline (project programme)

Covers the **Timeline** project tab (`/projects/:projectId/timeline`).
Rationale and every deliberate exclusion: **ADR-29**.

⚠️ **Frame every check against the current plan, not a baseline.** Constrapp
stores no immutable programme baseline, so the only claim under test is *"late
against the dates as they stand now"*. If any screen implies slippage against an
**approved** programme, that is a defect.

⚠️ **No check in this section may change a financial figure.** Before and after
the whole section, Budget, Forecast, Margin, Cash Flow and the Projects list
progress bar must be **identical**.

### 15p-i. Access matrix (the one place QS is read-only)

- [ ] As **company_admin** and as **project_manager**: the Timeline tab loads,
  and **+ Add activity**, **Edit** and **Cancel** are all present.
- [ ] As **qs**: the programme loads and is fully readable, but **no** Add /
  Edit / Cancel control is rendered, and the footer note says access is
  read-only.
- [ ] As **subcontractor** or **client**: the tab shows the *"Programme not
  available"* card explaining that those roles are not yet project-scoped — no
  activity data appears.
- [ ] Rules (not just UI) enforce this — see §17 and
  `tests/rules/activities.rules.test.js`.

### 15p-ii. Create an activity

- [ ] **+ Add activity** → name, planned start and planned finish are required;
  saving without them shows a message and writes nothing.
- [ ] A finish **before** the start is rejected.
- [ ] A **same-day** activity is accepted and reports **1 day** duration
  (the finish is inclusive).
- [ ] Duration is labelled **calendar days** — a Fri→Mon span reports **4
  days**, not 2. There is no weekend or public-holiday handling anywhere.
- [ ] Choosing **Responsible** lists company Contacts with this project's
  contacts first; leaving it blank is allowed. There is **no option to assign an
  internal staff member** (user management does not exist — ADR-27).
- [ ] Choosing a **Cost code** is optional, and the hint states it changes no
  budget, forecast or cash figure.
- [ ] Saving returns to the programme with the activity in the table, the Gantt
  and (at 375px) the cards.

### 15p-iii. Milestones

- [ ] Ticking **This is a milestone** collapses the two date fields to a single
  **Milestone date**, and progress becomes a **Not reached (0%) / Reached
  (100%)** choice — no free percentage.
- [ ] A saved milestone shows **"Milestone"** as its duration (zero days, not
  one day), a **◆** marker in the table/cards, and a **diamond** on the Gantt.
- [ ] A milestone cannot be saved with a finish different from its start
  (the form makes this impossible; rules also reject it).

### 15p-iv. Status lifecycle and invariants

- [ ] Selecting **In progress** pre-fills **Actual start** with today
  **visibly, in the field** — never silently on save. Saving without an actual
  start is rejected.
- [ ] Selecting **Completed** pre-fills progress **100%** and **Actual finish**
  with today. Saving at less than 100%, or with no actual finish, is rejected.
- [ ] Selecting **Not started** clears progress to 0 and blanks both actual
  dates; saving a not-started activity with any actual date is rejected.
- [ ] **On hold** keeps its recorded progress and actual start, and the notes
  field prompts for the blocker. The table/card shows *"On hold — <notes>"*.
- [ ] **BACKWARDS CORRECTION WORKS AND IS INTENDED:** take a **Completed**
  activity back to **In progress** (clearing the actual finish) and save — it
  succeeds. Take an **In progress** activity back to **Not started** — it
  succeeds. This is the deliberate ADR-11 departure; a programme is a plan.
- [ ] Progress accepts whole numbers 0–100 only — `12.5`, `-1` and `101` are
  rejected.

### 15p-v. Cancellation (no hard delete)

- [ ] **Cancel** opens its own modal (not the editor) with a warning that
  cancelling is permanent, and requires a **reason**; whitespace-only is
  rejected.
- [ ] After cancelling: the activity remains listed, dimmed, badged
  **Cancelled**, showing *"Cancelled — <reason>"*, with **no Edit or Cancel
  action**.
- [ ] A cancelled activity **cannot** be reopened, edited, re-cancelled or
  deleted by any route.
- [ ] It stops counting: **Overdue**, **Due next 14 days**, **In progress** and
  **Milestones remaining** all exclude it, and it moves to the
  **Completed / Cancelled** group on mobile.
- [ ] There is **no delete button anywhere** in the module.

### 15p-vi. Derived overdue and horizon

- [ ] An open activity whose planned finish is **yesterday** shows an
  **"Overdue"** badge/row plus **"1 day late"** — the word *Overdue* is always
  present, so the state never depends on colour alone.
- [ ] An activity due **today** is **not** overdue and reads *"Due today"*;
  tomorrow reads *"Due tomorrow"*.
- [ ] Marking an overdue activity **Completed** removes it from Overdue
  immediately. Cancelling it does the same.
- [ ] Nothing stores overdue: reload and the state still derives from today's
  date.
- [ ] Mobile groups read **Overdue → This week (≤7 days) → Upcoming (7–28
  days) → Later → Completed / Cancelled**, each with its count and a plain
  explanation of the window.

### 15p-vii. Summary and filters

- [ ] The four cards read **Overdue**, **Due next 14 days**, **In progress**,
  **Milestones remaining**, and each matches a hand count of the table.
- [ ] **Search** matches activity name, description, notes, responsible name and
  cost code, case-insensitively.
- [ ] **Status** and **Responsible** filters work and combine with search.
- [ ] **Hide completed & cancelled** removes both at once.
- [ ] With any filter active, a line reads *"Showing N of M activities"* with a
  working **Clear filters** link.
- [ ] There is **no filter builder** — exactly four controls.

### 15p-viii. Gantt (read-only, desktop/tablet)

- [ ] The Gantt renders at **768px and 1280px** and is **absent below `md:`
  (375px)** — the cards replace it. Confirm no squashed chart appears on a
  phone.
- [ ] Bars sit on a **calendar-day grid**; month headers show each month's real
  day count; weekly gridlines are present.
- [ ] A **today line** is drawn when today falls inside the visible span, and is
  absent when the whole programme is far in the past.
- [ ] Bar length matches the planned span **inclusively**; the filled portion
  matches the entered percentage.
- [ ] Milestones render as **diamonds**, centred on their day.
- [ ] Overdue bars carry a red outline **and** the word "Overdue" in the row
  label — never colour alone. The legend is **textual**.
- [ ] The whole canvas scrolls **horizontally inside its card** on a long
  programme; the page itself never scrolls sideways.
- [ ] **Nothing is draggable or resizable**, and clicking a bar changes no date.
  The footer states there is no drag-to-reschedule and no dependencies.
- [ ] An activity with unusable dates is reported as *not drawn* and still
  appears in the table — never silently dropped.

### 15p-ix. The table is the record

- [ ] Every figure shown on the Gantt is readable in the table: name,
  responsible, cost code, planned start/finish, duration, status, %, actual
  dates, overdue.
- [ ] Filtering updates the Gantt and the table together, in the same order.
- [ ] Turning off the Gantt (narrowing to mobile) loses **no** information.

### 15p-x. Honesty and financial isolation

- [ ] The footer card states, in plain language: current plan not an approved
  baseline · progress is entered by hand and unverified · calendar days ·
  no dependencies or critical path · cost code is a label only · responsibility
  is a Contact · cancelled not deleted · simultaneous edits overwrite.
- [ ] The editor's progress hint says Constrapp **never** derives it from dates
  or Progress Claims.
- [ ] **Financial non-effect:** record Budget (all six figures), Forecast Final
  Cost, Margin, Cash Flow totals and the Projects-list progress bar; create,
  edit, complete and cancel activities; re-check — **every figure is
  unchanged**.
- [ ] **Currency non-effect:** on a project whose currency is **not yet
  locked**, create an activity — the project currency **stays unlocked and
  editable**. A programme write must never engage the currency ratchet.

### 15p-xi. Concurrency and unavailability

- [ ] Open the same activity in two browsers, edit different fields in each and
  save both: the **second save wins outright**, including the first user's
  field. This is expected (last-write-wins) — confirm `updatedAt`/`updatedBy`
  reflect the second writer.
- [ ] Simulate a read failure (e.g. sign in as a denied role): the page reports
  the programme as **unavailable, not empty**, and never shows a false "no
  activities" state.

### 15p-xii. Responsive

- [ ] **375px:** no Gantt; grouped cards; Edit/Cancel buttons full-width and
  ≥44px; filters stack; modals scroll internally and fit; no horizontal page
  scroll.
- [ ] **768px:** Gantt and table appear; filter grid goes two-up; modal centred.
- [ ] **1280px:** four summary cards in one row; four filters in one row; table
  scrolls inside its card only.
- [ ] No hover-only affordance anywhere — every action is reachable by tap.

## 15q. Supplier Retention register & Retention Release

Automated coverage: `tests/unit/retention.test.js` (pure domain, GST telescoping,
supplier-payments regression, cash-flow double-count proof) and
`tests/rules/retentionReleases.rules.test.js` (the trust boundary). The checks
below are the **manual** acceptance pass.

### 15q-i. The register

- [ ] Commercial now shows **six** sub-tabs, ending in **Retention**; below `sm:`
  the strip scrolls horizontally rather than wrapping, and every link stays ≥44px.
- [ ] `…/commercial/retention` shows **Retention Held**, **Released to Date**,
  **Total Withheld to Date**, and a **supplier count**. There is **no**
  "released but unpaid" figure anywhere.
- [ ] Suppliers are grouped with Invoices / Total Withheld / Released / Held, and
  expand to per-invoice rows showing retention ex-GST + GST, total, released, held.
- [ ] A project with no retention shows the empty state, not zeroes-as-facts.
- [ ] A pre-Contacts invoice (`supplierId: null`) groups by its frozen supplier
  name and is labelled as a name match.
- [ ] **Non-financial roles** (subcontractor, client) see the restricted message
  and trigger no reads.

### 15q-ii. Releasing (the hard block)

- [ ] **Release** on an invoice row opens the modal showing retention withheld
  (ex-GST, GST, total), already released, and **available to release**.
- [ ] **Release all remaining** fills the exact remaining ex-GST amount; it is
  never pre-filled automatically.
- [ ] GST and the resulting payable total are **derived and read-only**, and
  update live as the amount changes.
- [ ] Entering **more than the remaining retention is HARD-BLOCKED** — Save is
  disabled and the message names what remains. **There is no acknowledgement
  override.**
- [ ] Over by exactly **one cent** is still blocked.
- [ ] A blank/whitespace reason, a missing date, and a zero/negative amount are
  each blocked.
- [ ] Saving creates **RR-0001** as a **draft**, and the first release on a fresh
  project sets `project.currencyLocked` — both in one transaction.
- [ ] A draft release changes **no** payable figure anywhere.

### 15q-iii. Posting and the payable basis

- [ ] Posting a draft moves it to **Posted** with server-stamped `postedAt`/`postedBy`.
- [ ] On **Supplier Invoices**, that invoice's **Retention Held** falls by the
  released amount, **Currently Payable** rises by the same amount, and
  **Remaining Payable** rises correspondingly. `Gross` is unchanged.
- [ ] Open the invoice detail: the retention callout now states how much has been
  released (included in the payable figures) and how much is still held, and says
  retention **paid** is not reported.
- [ ] On **Supplier Payments**, the invoice appears as an allocation target with
  the released amount available; the target line reads **retention held**, and
  shows **retention released** separately — never the same money twice.
- [ ] The AP reconciliation table shows separate **Retention Held** and
  **Released** columns.
- [ ] AP **ageing** now includes the released balance. ⚠️ Confirm it ages from the
  **original invoice due date** (usually the oldest bucket) — expected in V1.
- [ ] Record and post a Supplier Payment for the released amount: Remaining
  Payable returns to zero and the invoice reads fully reconciled.
- [ ] Confirm **no** supplier-invoice field changed at any point — `retention`,
  `retentionGst`, `retentionTotal`, `payableTotal`, and `status` are identical
  before and after (inspect in the Firebase console).

### 15q-iv. Partial releases and GST

- [ ] Release retention in **two or three parts** that together equal the full
  retention. The **sum of the GST amounts equals the invoice's `retentionGst`
  exactly**, and the sum of the release totals equals `retentionTotal` exactly.
- [ ] Use a drift-prone retention (e.g. **100.05**, whose GST is 10.01) split
  three ways: the final release carries the **remainder**, not its own rounding,
  and the totals still reconcile to the cent.
- [ ] After full release, Retention Held for that invoice is **0**, the Release
  button is disabled, and Currently Payable equals the invoice's **gross**.

### 15q-v. Void and concurrency

- [ ] Voiding a **posted** release requires a non-whitespace reason and states
  that the amount returns to retention held.
- [ ] After voiding, **every** figure returns to its pre-release value — payable,
  remaining, ageing, retention held — with **no** reversal or credit-note document.
- [ ] Void is **terminal**: a void release offers no Post, Edit, or Void action.
- [ ] Releases are **never deleted** — the voided RR row remains in the register.
- [ ] Prepare a draft, post a *different* release on the same invoice from another
  session, then try to post the first: it is **blocked** with a message to re-open
  and save the draft (the stale-snapshot guard).
- [ ] Cancel a posted supplier invoice that has a posted release (direct SDK):
  the release surfaces in the **exceptions** panel, is **not** auto-reversed, and
  the invoice is not modified.

### 15q-vi. Failed-subscription honesty (mandatory)

Simulate a `retentionReleases` read failure (e.g. temporarily deny the collection
in rules, or go offline before first load).

- [ ] **Retention** page: every figure renders **“—”**, the reason is named, and
  release actions are disabled. **No figure shows as 0.**
- [ ] **Supplier Payments**: a red notice states the payable figures may
  understate what is owed; the page does not silently show pre-release balances
  as if correct.
- [ ] **Supplier Invoices**: the same notice appears above the register.
- [ ] **Cash Flow**: "Retention Releases" is listed among the unavailable
  forecast sources; Retention held, AP no-due-date, and AP past-due render “—”,
  and Forecast Cash Out is unavailable rather than understated.

### 15q-vii. Cash Flow — no double count

- [ ] With retention held and **nothing** released, "Retention held (not released
  — not payable)" equals the full retention withheld, exactly as before ADR-30.
- [ ] Release part of it and post: the held figure **falls** by that amount, and
  the released amount appears **once** in the open-AP classification (normally
  "past due — expected payment not retimed"). It is **not** also counted as
  retention held.
- [ ] Held + released reconciles to the total retention withheld.
- [ ] Fully release: retention held reads **0**.
- [ ] Peak funding is **suppressed** while the released balance sits past-due —
  expected, and the reason is named.

### 15q-viii. Responsive

- [ ] At **375px / 768px / 1280px**: both register tables scroll horizontally
  **inside their card** with no page-level horizontal scroll; the release modal
  fits with internal scrolling; every action stays ≥44px.

## 15r. Supplier Credit Notes

Sign in as a financial-role user (`company_admin` / `project_manager` / `qs`).
Setup: a project with sent POs and, on the Supplier Invoices view: **SI-A** — a
posted direct-PO invoice with two cost-coded GST lines (600 + 400 ex-GST →
payable **1,100** gross) and **no retention**; **SI-B** — a posted claim-sourced
invoice **with retention withheld**; **SI-C** — an approved (not posted)
invoice; and one posted Supplier Payment of **500** allocated to SI-A. Note the
Budget/Forecast Actual and the Commercial Margin figures before starting.

### 15r-i. Navigation & gating

- [ ] Credit notes live **inside the Supplier Invoices view** — no new project
  tab and no new Commercial sub-route. The register section appears only once a
  credit note exists.
- [ ] "Record credit note" appears on **SI-A only**: not on SI-B (retention),
  not on SI-C (not posted), not on draft or cancelled invoices.
- [ ] As `subcontractor` or `client`, the Supplier Invoices view (and with it
  every credit-note surface) stays restricted; a direct SDK read of
  `supplierCreditNotes` is denied (automated, §15r-x).

### 15r-ii. Numbering & atomicity

- [ ] The first credit note is **SCN-0001**; the sequence is company-wide
  (create one on a second project — it takes the next number).
- [ ] Voiding a credit note retains its number — an intentional gap in the
  sequence, never reused.
- [ ] Creating the first credit note on an unlocked project flips
  `currencyLocked` to `true` in the SAME transaction (check as `qs` too — the
  false→true ratchet path).
- [ ] A failed create (e.g. rules rejection via a doctored payload) advances no
  counter and locks no currency.

### 15r-iii. Eligibility & the retained-invoice block

- [ ] The editor opens pre-locked to the chosen invoice; the target cannot be
  changed on a saved draft ("void and record a new credit note" is stated).
- [ ] SI-B cannot receive a credit anywhere: no action button, domain
  validation names the retention block, and a direct SDK create against it is
  rejected by rules (automated).
- [ ] The editor states the maximum creditable (payable − already-posted
  credits) and the target's payable.

### 15r-iv. Draft creation & lines

- [ ] Cost-code options are exactly SI-A's cost codes — nothing else on the
  project is offered.
- [ ] Each kept line requires a description, a positive ex-GST amount, and a
  tax code; per-line GST is 10% for `gst` and zero for `gst_free` /
  `input_taxed`; header totals reconcile to the lines.
- [ ] A **reason is required** (whitespace rejected) — a credit without a
  stated cause cannot be saved.
- [ ] The supplier's own credit reference is optional; entering one that
  already exists for this supplier **warns** (never blocks).
- [ ] A draft credit note changes **no figure anywhere** — Invoiced, Actual,
  Remaining Payable, ageing, Forecast, Margin all unchanged.

### 15r-v. Over-credit — HARD BLOCK (not warn-and-acknowledge)

- [ ] A credit note of exactly **1,100** gross against SI-A saves (cent-exact
  full credit allowed).
- [ ] 1,100.01 is **blocked** with a message naming the payable total — there
  is no acknowledgement checkbox and no way to save.
- [ ] With a posted credit of 1,000 in place, a second credit of 100 saves but
  100.01 is blocked — the cap is **cumulative** across posted credit notes.
- [ ] The cumulative block re-runs at **post** time: save two 1,000 drafts,
  post the first, then posting the second is blocked with the cap message.

### 15r-vi. Cent arithmetic (AUTOMATED)

- [ ] Covered by the emulator suite (§0) and the unit suite (§0b): the header
  invariant accepts `0.10 + 0.20 = 0.30`-class values and still rejects a
  one-cent discrepancy; the payable cap is compared in whole cents.

### 15r-vii. Posting

- [ ] Posting is a separate confirmed action carrying no content change.
- [ ] Posting re-validates against **current** data: cancel the target (or
  post a competing sibling credit) after saving the draft — posting is blocked
  with a specific message. The target half of that check is **rules-enforced**
  too (§15r-x, `P1`–`P7`), so a direct SDK post is blocked as well; only the
  cumulative sibling cap is app-only.
- [ ] Only a draft can be posted; posted is immutable except void (automated).

### 15r-viii. Financial effects of a posted credit (100 ex-GST + 10 GST on cc1)

- [ ] Budget: **Invoiced** and **Actual** for cc1 drop by 100 (ex-GST);
  **Committed and Claimed are unchanged** — commitment is deliberately NOT
  re-opened (ADR-31).
- [ ] Forecast: cc1's Actual and Forecast Final Cost drop by 100; Remaining
  Committed unchanged; Variance to Budget improves by 100.
- [ ] Commercial: Forecast Gross Profit rises by 100; Forecast Revenue
  unchanged.
- [ ] Overview margin cards agree with the Commercial tab.
- [ ] Supplier Invoices: SI-A's row shows Credited −110 and Remaining Payable
  490 (1,100 − 500 paid − 110 credited); the detail modal shows the credit in
  its own table with the same figures.
- [ ] Supplier Payments: the reconciliation table shows the Credited column;
  AP ageing ages **490**, not 600; the payment editor's picker offers 490 as
  SI-A's remaining.
- [ ] Cash Flow: Actual Cash Out unchanged (a credit moves no money); Forecast
  Cash Out for SI-A's due month drops to the net remaining.
- [ ] An over-credited cost code (credit > invoiced on that code) shows a
  **negative** Invoiced/Actual — visible, never clamped to zero.

### 15r-ix. Payments interaction — credit before, after partial, after full

- [ ] **Before any payment:** remaining payable = payable − credit; ageing and
  forecast cash out follow.
- [ ] **After partial payment (the 500):** remaining = 1,100 − 500 − 110 = 490;
  state *Partly reconciled*.
- [ ] **Fully credited, unpaid:** an 1,100 credit on an unpaid posted invoice
  reads *Fully reconciled* and leaves ageing entirely.
- [ ] **After full payment:** paying the remaining 490 and then crediting more
  drives remaining **negative** — the invoice reads *Over-reconciled*, is
  EXCLUDED from ageing buckets, and both the AP summary and the invoice detail
  surface it as **money recoverable from the supplier**, with the text stating
  no refund is recorded automatically.

### 15r-x. Lifecycle — Rules-enforced (AUTOMATED — see §0)

`frontend/tests/rules/supplierCreditNotes.rules.test.js` — 57 emulator tests.

**Must be ALLOWED:** financial-role create (draft-only) / read / draft edit /
post / void (draft and posted, non-whitespace reason); a full credit equal to
the payable to the cent; 100 lines; empty supplier references; a legacy
`supplierId: null` target matched by a null-frozen credit; the cent-arithmetic
header cases; the full create → edit → post → void sequence with
`serverTimestamp()`.

**Must be REJECTED:** create as posted/void; forged lifecycle stamps at every
stage (three skewed client clocks); impersonated `createdBy`/`postedBy`/
`voidedBy`; wrong `docType`/`currency`/`revision`; missing target reference or
supplier name; malformed `creditDate`; empty/whitespace `reason` or
`voidReason`; header-invariant violations (zero/negative/non-number totals, a
one-cent discrepancy); `lineItems` not a list, EMPTY, or over 100; **every
target failure via the rules `get()`** — missing, draft, approved, cancelled,
`paid`, retained (even one cent), wrong supplier, wrong currency, grossTotal
above payableTotal, a draft edit raising totals beyond the payable, and any
retargeting of the frozen `supplierInvoiceId`/snapshot fields; posted content
edits; posted → draft; anything after void; all deletes; subcontractor/client/
unauthenticated/cross-company access.

**Post-time revalidation (`P1`–`P7`):** posting a legitimately-saved draft must
FAIL once the target has been cancelled or moved to any non-posted status
(including the forgeable `paid`), had retention added (even one cent), had its
`payableTotal` cut below the credit gross, had its supplier or currency
changed, or was deleted — while an unchanged target still posts, a payable
reduction that still covers the gross still posts, and **voiding** a draft
whose target went bad always succeeds.

Plus the honest gap test: a **cumulative** over-credit by a sibling document is
ACCEPTED by rules (Deferred Control 25 — app-enforced only).

### 15r-xi. Void & restoration

- [ ] Voiding requires a written reason; the modal states restoration happens
  at the next render with no reversal document.
- [ ] Voiding the posted credit restores **every** figure from §15r-viii to
  its pre-credit value — Budget, Forecast, Margin, AP, ageing, Cash Flow.
- [ ] The voided credit note stays on the register with its reason, badge, and
  number.

### 15r-xii. Exceptions — broken targets and failed integrity

- [ ] Via direct SDK (emulator/console), cancel SI-A **after** its credit
  posted: the credit immediately counts **zero** everywhere (Invoiced/Actual/
  payable restored — cost stays visible) and appears in the **Credit-note
  exceptions** panel naming the cause; nothing is auto-reversed.
- [ ] Restoring the invoice to posted removes the exception and the credit
  counts again.
- [ ] Add retention to SI-A by direct SDK after its credit posted: the credit
  drops to zero everywhere and is listed as an exception naming retention.
- [ ] Reduce SI-A's `payableTotal` below the credit gross by direct SDK: same
  result, naming the payable.
- [ ] **The forged-document case (the important one).** By direct SDK, write a
  posted credit note whose header says `subtotal: 90.91 / gstTotal: 9.09 /
  grossTotal: 100` but whose single line claims `amount: 50000, gstAmount:
  5000` on one of SI-A's cost codes. Rules ACCEPT this write (they cannot read
  line items). Confirm in the app that it: contributes **0** to Credited and
  Remaining Payable; contributes **0** to Invoiced and Actual (the cost code is
  unchanged — **not** reduced by 50,000, and not reduced by 100 either);
  appears in the **Credit-note exceptions** panel with a reason naming the
  totals mismatch; and is **not** silently clamped to any value.
- [ ] Repeat with a line whose cost code is not on SI-A, and with a line whose
  `gstAmount` does not match its tax code — both excluded and listed.

### 15r-xv. Credit notes unavailable (failed subscription)

Simulate a failed credit-note read (block the `supplierCreditNotes` collection
in rules, or go offline after load and force a re-subscribe).

- [ ] **Supplier Payments:** a banner explains credit notes could not be loaded;
  **Remaining Payable**, every AP ageing bucket, and the Credited / Remaining /
  Reconciliation columns render **"—"**, never a figure computed as though no
  credits exist; **+ New Payment**, **Edit** and **Post** are disabled; **Void**
  remains enabled. Confirm it is impossible to record a payment in this state.
- [ ] **Supplier Invoices:** a banner appears; the **Credited** and **Remaining
  Payable** summary figures, the register's Credited/Remaining/Reconciliation
  columns, and the invoice detail modal's reconciliation block all render
  unavailable; **Record credit note** is disabled.
- [ ] **Budget / Forecast / Overview / Commercial:** each states that credit
  notes are unavailable and that cost and margin figures may be **overstated**
  (the conservative direction — cost stays visible), rather than silently
  rendering as though no credits exist.
- [ ] **Cash Flow** continues to list Supplier Credit Notes in its source-error
  panel and marks Forecast Cash Out unavailable (unchanged behaviour).
- [ ] While credit notes are still **loading**, Supplier Payments shows its
  loading state rather than briefly rendering an overstated Remaining Payable.
- [ ] Restore the read: every figure and action returns without a page reload
  beyond the normal snapshot update.

### 15r-xiii. No-mutation, currency & register

- [ ] After create/post/void, SI-A's **document is byte-for-byte unchanged**
  (no credited total, no back-reference, no status change) — verify in the
  emulator/console. The progress claim, PO, budget lines, and payments are
  likewise untouched.
- [ ] The credit note stores the target invoice's currency as an audit
  snapshot; all amounts render in the project currency.
- [ ] Register search/filters on the invoice table are unaffected; the credit
  register shows SCN #, target, supplier, reference, date, totals, reason, and
  status.

### 15r-xiv. Responsive

- [ ] At **375px / 768px / 1280px** (per §16): the credit register and the
  detail credit table scroll horizontally inside their cards; the editor modal
  fits with internal scrolling; all actions reachable by tap.

## 15s. BOQ & Tender Foundation

> **§15s-i – §15s-v cover the Bill of Quantities (ADR-32 Part 1); §15s-vi
> onward cover Tenders (ADR-32 Part 2).** §15o (Documents & Drawings),
> §15p (Project Timeline), §15q (Supplier Retention), and §15r (Supplier Credit
> Notes) are above.

### Bill of Quantities (BOQ) — §15s-i to §15s-v

The measured schedule on the project's BOQ tab (ADR-32 Part 1). Setup: a
project with cost codes (at least one carrying a `unit`) and a few budget
lines. Estimating (margin/overheads) and BOQ → Budget transfer are NOT part of
this foundation — nothing in these steps should offer them. Tenders are a
separate, BOQ-independent foundation (§15s-vi onward); the BOQ tab does not
link to them.

### 15s-i. Navigation & gating

- [ ] The **BOQ** project tab (label unchanged) opens the live Bill of
  Quantities — the old placeholder card is gone. There is **no** Tender
  navigation anywhere.
- [ ] As `company_admin`, `project_manager`, and `qs`: the register, summary
  cards, and comparison render; Add/Edit/Void all work.
- [ ] As `subcontractor` or `client`: the page shows the "BOQ is restricted"
  card and triggers **no** boqItems read (no console rules error). A direct
  SDK read/write as either role is denied by rules (AUTOMATED — see §0).
- [ ] With no cost codes in the company: the empty state points to Cost Codes
  and the Add button is disabled — every BOQ item requires a cost code.

### 15s-ii. Item creation & editing

- [ ] Add an item: cost code (required), item number and section (optional
  labels), description (required), quantity (required, ≥ 0), unit (required),
  rate (optional). Save → appears immediately, ordered by section, then item
  number in **natural** order (`2.9` before `2.10`), then entry order.
- [ ] Choosing a cost code **prefills the unit** from the code's `unit` when
  the unit field is empty — and never overwrites a unit already typed. The
  prefilled unit remains editable.
- [ ] The cost-code name is snapshotted at write time (`costCodeName`);
  renaming the code later does not rewrite existing items (register shows the
  live name in the comparison, the stored snapshot survives on the document).
- [ ] Whitespace-only description is rejected; negative quantity is rejected;
  a quantity of 0 is accepted (a real measurement).
- [ ] Editing an active item works for any field, including changing the cost
  code; the derived amount updates live in the modal preview.

### 15s-iii. Unpriced items & the derived amount

- [ ] Leaving the rate **blank** saves `rate: null` and `amount: null` — the
  register shows an amber "Unpriced" in the Rate column and "—" for Amount,
  **never $0**.
- [ ] Entering a rate of **0** is different: the item is PRICED at $0.00 and
  shows a real zero amount — it is not counted as unpriced.
- [ ] The amount is **derived, never typed**: quantity × rate, rounded to the
  cent (12.5 × $310.40 = $3,880.00; fractional quantities like 3.333 × $14.99
  round to $49.96). A forged amount is rejected by rules (AUTOMATED — §0).
- [ ] Pricing an unpriced item later (edit, enter a rate) works; clearing the
  rate un-prices it again and the amount returns to "—".
- [ ] The **Unpriced Items** summary card counts active unpriced items and
  shows amber while non-zero; the BOQ Total card is labelled "(priced)" and
  reads "N of M items priced".

### 15s-iv. BOQ vs Approved Budget (read-time only)

- [ ] The summary Variance card = Approved Budget − BOQ Total, positive when
  the BOQ is under budget, red when negative — and shows **"—"** (suppressed,
  with the reason) while the BOQ is empty OR any active item is unpriced. It
  never shows a partial figure as if complete.
- [ ] The per-cost-code table unions codes from the BOQ **and** the budget: a
  budget-only code shows BOQ "—" (never "under budget by everything"); a
  BOQ-only code shows Budgeted "—"; a code with any unpriced item shows its
  priced sum but a suppressed variance with "N unpriced" noted; inactive and
  unknown codes stay visible, flagged.
- [ ] **No financial effect:** record every figure on Budget, Forecast,
  Commercial/Margin, and Cash Flow, then add, price, edit, and void BOQ items —
  every one of those figures is **unchanged**. The BOQ writes only `boqItems`.
- [ ] Voiding an item removes it from the BOQ total and the comparison
  immediately (read-time derivation, nothing to "recalculate").

### 15s-v. Lifecycle — Rules-enforced (AUTOMATED — see §0), currency & responsive

- [ ] Void requires a non-whitespace reason; voided items are hidden behind a
  "Show N voided items" toggle, render dimmed with a Void badge, and have no
  Edit/Void actions. There is **no delete** anywhere.
- [ ] Rules enforce (automated): create only as `active` with null void stamps
  and true caller/server stamps; active edits re-validate the full shape and
  cannot forge void stamps; `active → void` touches only the void audit keys
  with a non-whitespace reason; void is terminal; delete is blocked for every
  role; core identity (currency, revision, creation stamps) is immutable.
- [ ] **Currency lock:** on a fresh project, saving the first **priced** BOQ
  item engages the currency ratchet in the same transaction (Overview shows
  the currency locked, citing "N priced BOQ item(s)"). Purely **unpriced**
  items do NOT lock — a quantity is a measurement, not money (the
  forecast-input precedent). Rates display through `formatCurrency` in the
  project currency — never a hard-coded symbol.
- [ ] At **375px / 768px / 1280px**: the register and comparison tables scroll
  horizontally inside their cards (no page-level scroll); the editor modal
  fits with internal scrolling; all touch targets ≥ 44px; Add/Edit/Void all
  reachable by tap.

### Tenders — §15s-vi onward

### 15s-vi. Navigation, gating & empty state

- [ ] A **Tenders** tab appears on Project Detail immediately after BOQ and
  routes to the Tender register. The BOQ placeholder itself is unchanged.
- [ ] As `company_admin`, `project_manager`, or `qs`: the register loads, shows
  an empty state with a "create your first tender package" action, and the
  page states that awards create **no purchase order**.
- [ ] As `subcontractor` or `client`: the page shows the restricted-access
  card; no tender data is fetched (and rules would deny it — §17b).
- [ ] With connectivity broken, the register shows the "couldn't load" warning
  rather than rendering an empty register as truth.

### 15s-vii. Package lifecycle

- [ ] Creating a package requires a name and **at least one cost code**;
  numbers assign sequentially (`TP-0001`, `TP-0002`, …) even when two users
  create simultaneously (transactional counter).
- [ ] A draft package's name, description, scope, cost codes, closing date,
  and notes are all editable; Issue and Cancel are offered.
- [ ] Issuing freezes name/description/scope/cost codes: the UI stops offering
  the edit, and only **Closing date / notes** remains editable (the
  carve-out modal), plus Record bid / Award / Cancel.
- [ ] Cancelling (from draft or issued) demands a reason, is terminal, and the
  package keeps its number — a visible gap in the register is expected.
- [ ] No delete action exists in any status.

### 15s-viii. Closing date is informational

- [ ] Everywhere the closing date is entered or shown, the UI states that bids
  are **not** automatically blocked after it.
- [ ] Recording a bid against an issued package whose closing date has passed
  **succeeds** — deliberately (there is no trusted clock; see
  SECURITY.md → Deferred Control 26). **AUTOMATED at the rules layer — see §0.**

### 15s-ix. Bid entry & bidder selection

- [ ] The bidder picker offers **active supplier/subcontractor contacts only**;
  the chosen name is snapshotted onto the bid and later contact renames never
  rewrite it.
- [ ] Bid lines are priced per cost code, restricted to the **package's own
  cost codes**; amounts are ex-GST with **no GST fields**; a `0` amount saves.
- [ ] The derived total updates live and the editor states that **no total is
  stored**.
- [ ] A second bid for a bidder who already has an active bid on the package is
  blocked with a "void it first" message; after voiding, a replacement bid
  saves. (Client-side only — Deferred Control 26.)
- [ ] A received bid can be **corrected** (date, ref, lines, exclusions, notes
  — not the bidder) and **voided** (reason required) while the package is
  issued; once the package is awarded or cancelled, both actions disappear.

### 15s-x. Lifecycle — Rules-enforced (AUTOMATED — see §0)

Direct-SDK negative paths for both collections: create-state enforcement,
forged stamps, immutable cores, the issued-scope freeze and carve-out, the
parent-issued bid gate and post-award/cancel bid freeze, award integrity
(nonexistent / wrong-package / void bid, forged bidder-name snapshot, second
award), contact existence/type at bid create, terminal states, and
delete-blocking. The two tender suites in §0 prove every case as a real
rejection.

### 15s-xi. Bid validity gate & derived totals

- [ ] Seed (via console/SDK) a bid whose lines include a non-numeric amount:
  the register and detail show it as **Invalid / Malformed** — never $0,
  never a partial total — it is excluded from the comparison ranking, and
  the Award dialog refuses it.
- [ ] A bid with a line whose cost code is outside the package scope behaves
  the same way.
- [ ] Correcting the bid's lines in the app restores it to the comparison.

### 15s-xii. Tender Comparison

- [ ] The section is titled **"Tender Comparison"** (never "Bid Levelling") and
  shows bidder, bid date, derived total ex-GST, **vs Budget**, **vs Lowest**,
  exclusions, and status, with the awarded badge after award.
- [ ] **Sign convention:** with Approved Budget 100k, a 90k bid shows
  **10k under** (positive variance) and a 110k bid shows **10k over** —
  Variance to Budget = Approved Budget − Bid.
- [ ] With **no budget lines** on the package's cost codes, the budget line
  reads *unavailable / no budget* and no bid shows a variance — never a
  comparison against zero.
- [ ] Two bids with the same total are **both** flagged LOWEST with zero
  variance-to-lowest.
- [ ] Void bids stay visible (dimmed, excluded from every calculation); the
  lowest-bid figure ignores them.
- [ ] The per-cost-code matrix shows each valid bid's sum per package cost
  code, with *not priced* (never $0) for unpriced codes.

### 15s-xiii. Award

- [ ] Award is offered only on an issued package with ≥1 active bid; the dialog
  states it records a decision only — **no PO, no budget/commitment/actual/
  forecast/cash-flow change** — and that it is permanent and freezes bids.
- [ ] Malformed bids appear disabled in the winner picker.
- [ ] After award: the package shows **Awarded to …** with the **Awarded Bid
  Value derived from the frozen bid's lines**, labelled as a tender decision
  value that is never netted against Purchase Orders; every bid's
  Correct/Void action is gone; the package offers no further transitions.
- [ ] Award notes are displayed on the detail view.

### 15s-xiv. Financial isolation

- [ ] Record packages, bids, and an award, then compare Budget, Forecast,
  Margin (Commercial), and Cash Flow before/after: **every figure is
  identical**. Committed, Claimed, Actual, Invoiced, Available to Invoice,
  Forecast Final Cost, margin values, and both cash directions are untouched.
- [ ] No PO exists that the award created; the PO register is unchanged.

### 15s-xv. Currency

- [ ] Creating a tender **package** on a fresh project does **not** lock the
  project currency (Company Settings still allows changing it / Overview
  shows unlocked).
- [ ] Recording the first **bid** locks it in the same transaction, and the
  lock reasons include "1 tender bid"; a voided bid still counts as
  evidence.
- [ ] All tender amounts render in the project currency via the shared
  formatter; the bid's stored `currency` is an audit snapshot only.

### 15s-xvi. Roles & responsive

- [ ] `qs` can create, issue, record bids, **award**, cancel, and void — the
  full workflow (rules-proven in §0; confirm the UI offers it).
- [ ] `super_admin` sees the restricted card like any non-financial role.
- [ ] 375px: register and comparison tables scroll horizontally inside their
  cards; modals fit with internal scrolling; all touch targets ≥44px.

## 15t. RFIs — Requests for Information

Setup: a project with at least one drawing carrying two revisions (A and B),
one general document, one consultant Contact, one cost code, and a recorded
baseline of **Budget, Committed, Actual, Forecast Final Cost, Project Margin,
and the Cash Flow closing position**. Signed in as `company_admin` unless
stated. Reads and writes for `project_manager` and `qs` are identical.

### 15t-i. Navigation & register

- [ ] The project tab bar shows **RFIs** immediately after Timeline. Opening it
  on a fresh project shows the empty-state card and a **+ New RFI** action.
- [ ] Signed in as `subcontractor` or `client`, the tab shows **"RFIs not
  available"** — never an empty register — and no create action.

### 15t-ii. Create a draft

- [ ] Create an RFI with title, question, raised date (defaults to today), no
  assignee, no due date, no reference. It saves as **Draft** numbered
  **RFI-0001**, "Raised by" shows your profile name, and the summary cards
  read Open 0 · Overdue 0 · Awaiting close 0 · Closed 0 (with "1 draft").

### 15t-iii. Edit a draft

- [ ] Edit the draft: change the title and question, add a cost code, assign
  the consultant Contact, and set a due date. It saves; the number is
  unchanged. Setting the due date **before** the raised date is rejected with
  "Due date cannot be before the raised date".
- [ ] Re-open the draft and press **Clear** beside the due date → the field
  empties; **Save draft** succeeds and the register shows no due date
  (`dueDate` is `null`, not a year-0001 date). Re-open: the field is empty and
  Clear is not shown until a date is entered again.
- [ ] Type a partial date by deleting only the year in the native control →
  Save draft is rejected with "Due date is not a valid date" (the app's
  message, not a browser popup); press Clear → saves.

### 15t-iv. Per-project numbering

- [ ] Create a second RFI → **RFI-0002**. Cancel it (reason required) → its
  number is retained. Create a third → **RFI-0003** (never reused).
- [ ] Open a **different project** and create an RFI → **RFI-0001**. Return to
  the first project: its numbering is unaffected.

### 15t-v. Raise gate

- [ ] On a draft with **no assignee**, press **Raise** → blocked with "Assign
  the RFI to a contact before raising it"; the draft stays a draft.
- [ ] Assign a contact but clear the due date → **Raise** is blocked with "Set
  a due date before raising the RFI".

### 15t-v-a. Stale action errors clear

- [ ] With the "Set a due date before raising the RFI" message showing, edit
  the draft and add a due date → on **Save draft** the red message
  disappears. Press **Raise** with the fix in place → succeeds, no message.
- [ ] Trigger the message again on another draft, then open **any** other
  action (New RFI, Edit, Answer, Close, Cancel) → the message clears on
  opening; a failure inside that modal is shown **in the modal**, not in the
  register banner.

### 15t-vi. Raise

- [ ] With assignee and due date set, **Raise** → status **Open**; the detail
  view's History shows "Raised by You" with the server time; the Open card
  reads 1.

### 15t-vii. Question / reference freeze

- [ ] On the open RFI, **Edit** opens the editor in **update mode**: title,
  question, raised date, reference and cost code are disabled with the notice
  that they are frozen; only assignee and due date are editable.

### 15t-viii. Open management edit

- [ ] Change the assignee to a different Contact and extend the due date → it
  saves and the register reflects both.
- [ ] On the open RFI the assignee picker offers **no** "Not assigned" option
  and there is **no Clear** beside the due date; blanking the due date by hand
  is rejected with "An open RFI must keep a due date". Both remain mandatory
  for the life of an open RFI.

### 15t-ix. Overdue

- [ ] Set the due date to **yesterday** → the row shows **Overdue · 1 day
  overdue** (in words, not colour alone), the Overdue card reads 1, and the
  "Overdue only" filter shows just this RFI. Set it to **today** → not overdue
  ("Due today").

### 15t-x. Answer — Rules-enforced (AUTOMATED — see §0)

- [ ] **Record answer** with an answer and an answer date **before** the raised
  date → rejected. With a whitespace-only answer → rejected.
- [ ] Record a real answer dated after the raised date → status **Answered**,
  Overdue returns to 0, Awaiting close reads 1, the detail view shows the
  answer with "N days to respond", and the editor no longer offers assignee /
  due-date changes.

### 15t-xi. Answered cannot be cancelled

- [ ] On the answered RFI, **no Cancel action is offered** (table, cards or
  detail). The only actions are View and **Close**.

### 15t-xii. Close

- [ ] **Close** with a close-out note → status **Closed**, Closed card reads 1,
  the note appears in the detail view, and **no action of any kind** is
  offered on the RFI — no edit, no cancel, no reopen, no delete.

### 15t-xiii. Cancel a draft / open RFI

- [ ] Cancel a **draft** with a reason → **Cancelled**, retained in the
  register (filter Status → Cancelled), excluded from Open/Overdue counts. A
  whitespace-only reason is rejected.
- [ ] Cancel an **open** RFI the same way → same result.

### 15t-xiv. Terminal states

- [ ] Closed and cancelled RFIs offer **View only**. The detail view's action
  row is absent for them.

### 15t-xv. Drawing revision stays pinned

- [ ] Create a draft referencing drawing **A-101 at Rev A** (the picker
  requires choosing the drawing AND the revision; a drawing alone cannot be
  saved — "Choose the specific drawing revision"). Raise it.
- [ ] Issue **Rev B** of A-101 from the Drawings register. Return to the RFI:
  the reference still reads **A-101 … · Rev A** in the register and the detail
  view — it has not moved to the new current revision.
- [ ] Rename the drawing's title. The RFI's stored label is **unchanged**.

### 15t-xvi. General-document reference

- [ ] Create a draft referencing the general document → the register shows
  the document name as the reference. Switching the reference type to "No
  reference" on the draft clears it; saving with the document type but no
  document chosen is rejected.

### 15t-xvii. Financial non-effect

- [ ] After every step above, re-check **Budget, Committed, Actual, Forecast
  Final Cost, Project Margin, and the Cash Flow closing position**: every
  figure is identical to the recorded baseline. No PO, claim, invoice,
  variation, forecast line or cash-flow line was created or changed.

### 15t-xviii. Currency does not lock

- [ ] On a **fresh** project with no monetary values, create, raise, answer and
  close an RFI. The project's currency remains **unlocked** (Company Settings
  still allows changing it / Overview shows unlocked).

### 15t-xix. Responsive

- [ ] **375px:** no table; grouped cards (Overdue → Due this week → Open →
  Awaiting close → Draft → Closed/Cancelled); every action reachable by tap
  with ≥44px targets; modals fit with internal scrolling.
- [ ] **768px / 1280px:** the register table renders and scrolls horizontally
  inside its card; four summary cards in one row at 1280px.

### 15t-xx. Roles & tenant (negative path — rules, not UI)

- [ ] Signed in as `subcontractor`, issue a **direct SDK** read and write
  against `companies/{c}/projects/{p}/rfis` and `…/counters/rfis` → both
  rejected. Repeat as a `company_admin` of a **second company** → rejected.
  (Rules-proven in §0; confirm end-to-end once.)

### 15t-xxi. Linked variations (read-time — ADR-34)

- [ ] The RFI detail modal shows a **Linked variations** box: `None` for an
  uncited RFI; `CV-0002 — <title> · Draft` (number, title, status badge) for
  each variation whose `originRfiId` is this RFI, at every variation status.
  The RFI document itself gains no field (§14d-0). If the variations read fails
  (simulate offline or a rules rejection) the box reads **Unavailable**, never
  `None`.

## 16. Responsive Checks — 375px, 768px, 1280px

- [ ] **375px:** sidebar hidden behind hamburger; drawer opens/closes (tap overlay); nav items ≥44px tall; project tab bar wraps; PO/claim tables scroll horizontally inside their card; modals fit with internal scrolling; all actions reachable by tap (no hover-only).
- [ ] **768px:** sidebar visible and static; two-column grids engage; modals centred with margin.
- [ ] **1280px:** dashboard/detail content capped at max-width 1280px; 4-column KPI grid; 5-column budget summary; no horizontal page scroll at any width.
- [ ] **Timeline:** the read-only Gantt renders at 768px and 1280px and is **not rendered at all below `md:`** — 375px shows grouped activity cards instead (see §15p-viii / §15p-xii).

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
  Tenders (packages AND bids — competitor pricing), Forecast, Commercial,
  BOQ, and RFIs** all show no data — reads are blocked by rules, not merely
  absent from the nav.
- [ ] The same user **can** still read company members' Projects, Cost Codes,
  Budget Lines, POs, and Progress Claims (the intended coarser read model).
- [ ] **Project Timeline:** a `subcontractor`/`client` user is denied the
  programme entirely (the tab shows the "not available" card), while a `qs` user
  **can** read it. **AUTOMATED — see §0** (`activities.rules.test.js`).

### 17c. Write authorisation & delete-blocking

- [ ] A `subcontractor`/`client` role user cannot create or update POs, claims,
  invoices, variations, budget lines, BOQ items, or cost codes (rules reject
  the write).
- [ ] No client path can delete a financial/audit document (POs, claims,
  invoices, variations, budget lines, BOQ items, cost codes, contacts,
  counters, forecast lines, tender packages, tender bids, timeline activities,
  commercial baseline)
  — cancellation/rejection/archive is always a status/`isActive` change (the
  baseline is edited in place).
- [ ] **Project Timeline is the one collection where `qs` cannot write:** a `qs`
  user can read the programme but cannot create, edit or cancel an activity, and
  **no role can delete** one (cancellation is the only exit, and it is terminal
  and requires a reason). **AUTOMATED — see §0**.
- [ ] **`users/{uid}` cannot be written at all** — no client can change its own
  `role` or `companyId` (nor `name`/`avatarInitials`/`email`), create a
  membership document, or delete one. **AUTOMATED — see §0**; the users suite
  proves every case, so this needs no manual pass.

### 17d. Client-only controls are *not* a security boundary (known gaps)

**Project Timeline (Deferred Control 23)** — rules enforce the activity shape
and lifecycle thoroughly, but a direct SDK call by an authorised writer can
still store an **impossible-but-well-shaped calendar date** (`2026-02-30`), a
`responsibleContactId`/`costCodeId` that **names nothing**, a **duplicate
`sortOrder`**, and any `percentComplete` regardless of physical truth; a
backwards status change cannot be judged legitimate; and concurrent edits are
**last-write-wins**. All are proven unenforced by the automated suite. Blast
radius is bounded by design: the programme writes no financial value.

These document current deferred limitations — a direct SDK call by an authorized
financial-role user can still bypass client checks (see SECURITY.md → Deferred
Controls). They are **expected** to be bypassable today; do not report them as
enforced.

- [ ] Lifecycle-transition legality, post-submission/`approved` immutability,
  one-open-claim races, creator ≠ approver segregation, counter integrity, and
  uniqueness are client-enforced only **on `purchaseOrders`, `progressClaims` and
  `variations`**. **Exception:** `clientInvoices`, `clientReceipts`,
  `supplierPayments`, `supplierCreditNotes`, `retentionReleases` **and — since
  ADR-40 — `supplierInvoices`** enforce transitions and post-commit immutability
  **by rules** — see §15i-x, §15j-x, §15k-x, §15r-x, §15q and **§13f**, which test
  them as real rejections. ⚠️ The consequence recorded here is now **closed**: a
  posted supplier invoice can no longer be cancelled by any caller, and
  `status: 'paid'` is unauthorable. What remains is that a document tampered with
  *before* ADR-40 keeps its state, which is why `paid` stays in
  `SI_COUNTING_STATUSES`.
- [ ] **Supplier-invoice `lineItems` integrity is client-side only**, identically
  to the allocation arrays: rules cannot iterate an array, so header totals may
  contradict their own lines, and a per-line negative amount, bogus cost code,
  invalid tax code, self-contradicting `gstAmount` or arbitrary `poLineIndex` are
  all writable. One-invoice-per-claim, cumulative PO over-invoicing, duplicate
  supplier references and `SI-####` uniqueness are likewise unenforceable (no
  sibling aggregation). Expected — do not report as enforced (SECURITY.md →
  Deferred Control 29). The **scalar header** invariants and the create-time
  **source-document `get()`s** ARE rules-enforced (§13f).
- [ ] A wholly **GST-free supplier invoice carrying retention** stores a
  **negative** `payableGst`/`payableTotal`, and rules deliberately accept it — a
  floor would reject documents the app itself writes. Expected, and a **deferred
  domain issue** rather than a rules gap (SECURITY.md → Deferred Control 30). Do
  not "fix" it in a hardening pass.
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
- [ ] Tender **line-item integrity** is client-side only: rules cannot iterate
  `lineItems` (or a package's `costCodes`), so a direct SDK call can store
  malformed embedded line data, out-of-scope cost codes, or a duplicate
  bidder's bid. Expected — do not report as enforced (SECURITY.md → Deferred
  Control 26). The mitigation is **read-time**: the `assessBid` validity gate
  invalidates the whole bid (flagged, excluded, never $0), and **no stored
  `bidTotal`/`awardTotal` exists to forge**. The **closing date blocks
  nothing** anywhere, by design. What **is** rules-enforced: both lifecycles,
  the issued-scope freeze, the bid-write windows, and the award/contact
  `get()` checks — see §0.
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
