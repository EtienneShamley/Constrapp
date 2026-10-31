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
  `clientInvoices.js`, …) are the natural next targets. This suite also holds a
  small number of **structural source tests** — they read files under `src/` and
  assert structure rather than rendering anything (`betaSurfaces.test.js`,
  `documentsResponsive.test.js`, `hookSubscriptionPattern.test.js`,
  `loadingNotZero.test.js`, `financialReliability.test.js`,
  `forecastLayout.test.js`).

**CI: Azure Pipelines** (`azure-pipelines.yml`, on `main` and every PR to it)
runs `npm ci → lint → test:unit → test:rules → build`. **All four are blocking.**
Lint runs first because it takes seconds while the Rules suite boots two
emulators under a JDK; it is `eslint . --max-warnings 0`, and the standing policy
is **0 errors and 0 warnings** (ADR-41). There is **no deploy stage** — and the
CI build is not deployable in any case, because the pipeline sets none of the
`VITE_FIREBASE_*` variables (see [DEPLOYMENT.md](DEPLOYMENT.md)).

**There is no automated React/DOM coverage.** The unit runner is plain Node with
no jsdom and no testing-library, and no hook or component is rendered by any
test. Everything below is manual: verify application changes against a dev
Firebase project with the current rules published.

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
- Config: `frontend/firebase.json` (both emulators + both rules pointers, plus
  the Hosting block first deployed by hand on 19 October 2026; no functions and
  **no `.firebaserc`**). The
  emulator commands pass `--only firestore,storage`, so the Hosting block is
  inert here. The Storage emulator runs on port 9199.
- **Both boundaries are proven by the same command on purpose.** A separate
  command for Storage Rules is a command that eventually stops being run.
- Tests — **1796 in total across 27 files** (M3-B1 / ADR-62 adds **28** cases to `variations.rules.test.js` and the new `variationsTransitional.rules.test.js`, **9** cases against the Stage-1 transitional ruleset — — the stamps on approve for every role and against a closed PO, the pre-M3-B1 approve payload still accepted, refusals on a cancelled / draft PO, manual-mode and client variations, forged or half stamps, stamps at create or on any other branch, the legacy Apply once and refused on repeat for every revision, from every non-approved status, with bundled changes, forged actor / time / revision, denied roles, a legacy document, the app's transactions incl. two concurrent applies and a stale copy, and the DC39 ceiling; M3-A / ADR-61 adds `awardToPo.rules.test.js`, **33** cases — the getAfter() feasibility proof, the source / back-link rules, immutability, duplicate protection and re-raise, roles / tenancy / legacy / manual paths, and the app's own raise transaction incl. two concurrent raises; no other suite changed; run locally on 29 October 2026 on the native arm64 Java 17 — see §37; 1726 across 25 files before ADR-61, unchanged by ADR-60 — the rules capacity refactor touched no test file and the whole suite re-ran green against the refactored ruleset on 27 October 2026, see §36; 1731 across 25 files before ADR-59: `variations.rules.test.js` was rewritten from 107 to **102** cases — every ADR-34 case kept in the new write shape, the old "forgery accepted", "smuggling allowed", "legacy keys absent on create" and "identical triple on an approved document" cases replaced by their refusals, the freeze re-proven per status and per role, and the PO link / counterparty / type proven frozen from creation; no other suite changed; the full suite was run locally on 27 October 2026 on the native arm64 Java 17 — see §35; 1629 across 24 files before ADR-58: `progressClaims.rules.test.js` adds **102**; the `externalRoles` claim fixtures and its one PO seed, and the PO suite's one claim-create case, were revised to the ADR-58 shape with no change to any assertion or count; 1550 across 23 files before ADR-57: `purchaseOrders.rules.test.js` adds **79**; the `externalRoles` PO fixtures were revised to the ADR-57 shape; the full suite was run locally on 27 October 2026 on the native arm64 Java 17 — see §33 and §34):
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
  - `frontend/tests/rules/boqItems.rules.test.js` — **62 tests** covering every
    case in §15s-v below: the two-state lifecycle (active edit / active → void
    terminal, reasoned), the whole-cent `amount == quantity × rate` invariant
    for priced items, the `rate: null ⟺ amount: null` unpriced pairing (0 can
    never mean unpriced), the mandatory cost-code spine, delete-blocking, and
    forged-stamp rejection. It also asserts the two documented **client-only**
    gaps (Deferred Control 26): a `costCodeId` of valid shape naming NO real
    cost code and a duplicate of an existing item are both ACCEPTED by rules.
    **Quant 1B (ADR-52, §28) adds 12:** the optional `quantApplied` map —
    accepted when fresh (caller actor, server time, `quantity == the written
    quantity`, integer count ≥ 1, a non-blank `evidence` string ≤ 128) for
    each financial role; refused for another actor, a client clock, a
    disagreeing quantity, a zero or fractional count, a missing or extra key,
    a missing, null, blank, oversized or non-string `evidence`, a non-map, or
    at CREATE; preserved verbatim through a manual edit, refused when altered
    without a fresh stamp, kept by void; a LEGACY record whose map has no
    `evidence` key is still preserved verbatim through an edit and a void and
    replaced by a fresh application; a legacy item without the map still takes
    every write — and **5 tests run
    the REAL `lib/boqActions.js` transactions** against the rules: an apply
    from the reviewed copy writes the derived amount and provenance and
    **engages the currency ratchet for a `qs` user**; a STALE copy (re-priced
    underneath) is refused end to end and the fresh copy applies at the new
    rate; an unpriced item changes quantity only and leaves the project
    unlocked; a void item and a denied role are refused with nothing written;
    the manual editor's save is refused as STALE after a concurrent save and
    prices with the ratchet from the fresh copy. **1 test proves the DC33
    gap**: a direct-SDK valid payload written without reading first passes —
    the version guard is the app's, not the rules'.
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
  - `frontend/tests/rules/activities.rules.test.js` — **82 tests** covering
    every case in §15p-x below (the project programme, ADR-29), plus **16**
    that run the app's own **guarded quick-action transaction** (ADR-46)
    against the **unchanged** rules: admin/PM Start, Complete, Put on hold and
    milestone Mark reached each change **only** the intended keys plus the
    audit stamps; QS, subcontractor, client, super_admin and other-company
    users are **denied by the rules** (nothing written); a write by another user
    after the UI loaded the activity makes the action **stale** (nothing
    written), as does a second action from the same stale view; a deleted
    activity is refused as **missing**; a cancelled activity and a Complete with
    no recorded actual start are refused (no history invented). It is the only
    suite where the **read and write audiences differ**: it asserts that `qs`
    can read but cannot create, edit or cancel, that `subcontractor`, `client`
    and `super_admin` are denied entirely, and that **no role can delete**. It
    also asserts the deliberate **non**-forward-only lifecycle (`completed →
    in_progress` and `in_progress → not_started` both SUCCEED) and the four
    documented **client-only** gaps: an impossible-but-well-shaped calendar
    date (`2026-02-30`), a `responsibleContactId`/`costCodeId` naming nothing,
    a duplicate `sortOrder`, and a full-document overwrite (last-write-wins)
    are all ACCEPTED by rules.
  - `frontend/tests/rules/takeoff.rules.test.js` — **71 tests** covering the
    two Quant™ 1A collections (ADR-51, §27), the Quant 1B link (ADR-52, §28) and the Quant 1D `deductions` key (ADR-54, §30 — #65 the key absent / empty / with holes on an area for each role and fifty as the ceiling; #66 refused on a length or count, as a non-list, above 50; #67 add / replace / clear with revision +1, a legacy document gaining the key, blind and skipped revisions refused; #68 non-list, > 50, the key on a length, and a deductions edit on a withdrawn sheet refused while void still passes; #69 void freezes the holes, a voided parent refuses further change, denied roles and another company can neither write nor read; #70 the real `runUpdateMeasurement` end to end — no key at create, first hole revision 2, a stale copy and an outside hole write nothing, a denied role is PERMISSION; #71 NOT ENFORCED — junk elements, an outside hole, overlapping holes and a hole equal to the parent all pass rules): the three-role read/write matrix
    with `subcontractor`/`client`/`super_admin`, cross-tenant, anonymous and
    no-membership callers denied; page create — id ↔ fields agreement, the
    drawing and revision must exist and the revision must not be withdrawn (a
    superseded one is allowed), positive-integer page, source/geometry/rotation
    vocabularies, calibration shape or null with `calibrationRevision` 0,
    exact keys, caller stamps, server time, revision 1; page update —
    recalibration only, `revision` and `calibrationRevision` exactly +1, blind
    and skipped revisions refused, identity/geometry/creation stamps immutable,
    no forged actor or client clock, delete blocked; measurement create — page
    id recomputed and the page document, drawing, revision and cost code must
    exist, kind vocabulary, point-list size by kind (≥2/≥3/≥1, ≤500 — the
    500th passes, the 501st fails), label/name bounds, snapshot required for
    length/area and null for count, born active, no forged void stamps, exact
    keys (a `quantity`, `amount` or `currency` field is refused, as is a
    mistyped `boqItemId` — the one OPTIONAL key since ADR-52); measurement
    update — active edit of points/label/cost code/snapshot, blind overwrite
    refused, identity/kind/creation immutable, content revalidated, void with a
    non-whitespace reason and caller stamp only, voided records immutable, no
    delete; **4 tests run the app's own revision-guarded transactions**
    (`lib/quantActions.js`) against the real rules — first calibration,
    recalibration from the seen copy, a **stale** recalibration refused with
    nothing written, ensure-page then count, a length on an uncalibrated page
    refused, a measurement save made **stale** by a recalibration underneath,
    edit/void from a stale copy refused end to end, and a denied role refused
    as **permission** with nothing written; and **6 tests prove the documented
    client-only gaps** (Deferred Control 32): junk point elements, a
    `pageDistance` that does not match the points, an absurd real distance, a
    page number beyond any PDF, an inactive cost code and a snapshot unrelated
    to the page all PASS, as does a read-then-write `+1`. **8 tests pin the
    exact sheet-status contract** (SECURITY.md → Quant™ 1A table): pages and
    measurements on superseded and withdrawn revisions, and on a withdrawn
    drawing, stay READABLE by the three roles and unreadable by everyone else;
    create is refused on a withdrawn drawing even though its revision reads
    "current"; re-calibration and every active edit succeed on a superseded
    **…and 8 tests (#57–#64) pin the Quant 1B BOQ link (ADR-52):** the 1A
    shape (no key), `boqItemId: null` and a VALID link all create for each
    role; a link to a MISSING, VOID, different-cost-code or OTHER-PROJECT item
    (same company, and the same id in another company's identical path) is
    refused, as is a blank or oversized id; link / re-link / unlink are active
    edits with `revision` +1 and a legacy document gains the key; a label or
    geometry edit still passes when the EXISTING link's item has since been
    voided, while moving the link to a void item is refused and clearing it
    passes; a cost-code change on a LINKED measurement is refused unless the
    link is cleared or re-pointed to an item on the new code in the SAME
    write (an unlinked measurement re-codes freely); void keeps the link and
    may not change it; the denied roles and another company cannot link; the
    REAL `runCreateMeasurement` writes `boqItemId: null` by default or the
    chosen link, a link to a void item comes back as PERMISSION with nothing
    written, and `runUpdateMeasurement` clears a link on re-code in the same
    commit (`linkCleared: true`) and links/unlinks explicitly; and **1 test
    proves the DC33 gap**: a LENGTH links to an item measured in m³ — rules
    cannot normalise units. Earlier pins revised explicitly: #30 now refuses a
    mistyped `boqItemId` rather than the key itself. On the 1A side,
    sheet and are refused on a withdrawn revision or drawing; void succeeds on
    all of them (still reasoned and revision-guarded, immutable afterwards);
    no measurement or page can be re-pointed to a live sheet; and the real
    guarded transactions get *permission* for an edit on a withdrawn sheet
    while the void commits.
  - `frontend/tests/rules/pulseAcknowledgements.rules.test.js` — **37 tests**
    covering every case in §25-x below (PULSE™ 1B acknowledgements, ADR-49),
    including **6** that run the app's own **revision-guarded transactions**
    (`lib/pulseAcknowledgementActions.js`) against the real rules: a first
    acknowledgement stores revision 1 with sorted keys; a re-acknowledgement
    with the seen revision writes revision 2 while a **stale** one is refused
    with nothing changed; a user who saw **no** acknowledgement cannot
    overwrite one that appeared meanwhile; withdraw succeeds once, is
    **invalid** a second time and **stale** from an old view; `qs`,
    `subcontractor` and `client` are refused by the rules as **permission**
    with nothing written; a disallowed indicator id is never written. The
    matrix asserts `qs` **read-only**, `subcontractor`/`client`/`super_admin`/
    cross-tenant/orphan/unauthenticated denied, and **no role can delete**.
    Shape: the six-id allowlist and id/field agreement, every missing and
    extra field (incl. `resolved`, `acknowledgedByName`, `amount`, `severity`),
    create-as-active/revision-1/null-withdraw-stamps, forged actors and
    skewed-clock stamps, blank/oversized notes, malformed review dates, 200
    vs 201 evidence keys and non-list values; transitions: re-acknowledge
    from active and from withdrawn, **revision conflicts** (same, +2, −1,
    string, omitted), immutable `createdAt`/`createdBy`/`indicatorId`,
    withdraw with a smuggled content edit or forged stamp, `withdrawn →
    withdrawn`, and a bare status flip. It also asserts the documented
    **client-only** gaps (Deferred Control 31): an impossible-but-well-shaped
    review date, a **past** review date and non-string evidence keys are all
    ACCEPTED by rules.
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
  - `frontend/tests/rules/purchaseOrders.rules.test.js` — **79 tests**
    covering every case in §33 below (Purchase Order Lifecycle Security,
    ADR-57 / M2-B1). Until M2-B1 this block enforced role and tenancy and
    nothing else while `supplierInvoices` get()s a PO's `status` and every
    Committed / FFC / Cash Flow / SHIELD figure trusts its fields. It asserts
    the roles / membership / tenant matrix (three financial roles allowed;
    `subcontractor`, `client`, orphan, anonymous and the other tenant denied;
    delete blocked for every role × status), the **create** contract (exact
    key set, born draft, creator and audit stamps against `request.time` with
    three skewed clocks each, all six lifecycle stamps null, PO-number shape,
    supplier name / id, revision, externalRefs, description / notes bounds,
    1–200 lines), **currency and project consistency** (the project's explicit
    currency; the company `baseCurrency` fallback; the `AUD` fallback; every
    other well-formed code refused; malformed codes refused; a non-existent
    project refused), the **whole-cent money invariants** (negative and
    non-numeric money refused; `total` one cent off refused; off a half-cent
    boundary `gst` is EXACT — one cent either way, two cents, zero, doubled and
    a 15% figure all refused; on a boundary BOTH the half-up value and one cent
    below pass while one above or two below fail, at 40.15 and at the smallest
    boundary 0.05; zero money passes only as exact zeros; a $12.3M exact header
    passes and one cent off fails; the REAL `poTotals` accepted on the
    boundaries where floating point rounds down — 40.15, 41.05, 80.85,
    327,680.05 — and on boundaries where it rounds up — 0.05, 0.15, 1,234.45;
    an NZD project accepts 10% and refuses 15% — currency is not tax), the
    **draft edit** (the hook payload for each
    role; lines added / removed / re-priced; a pre-ADR-57 document gaining the
    stamps; missing / forged / client-clock stamps refused; status or stamp
    moves refused; eight identity rewrites refused; shape and money breaks
    refused; every content key refused on `pending_approval` / `sent` /
    `closed` / `cancelled` — the freeze after send), the **legal transitions**
    (`draft → sent`, `pending_approval → sent|cancelled`, `sent → closed`,
    `draft|sent → cancelled`, creator self-send permitted, legacy documents
    without `*By` / `updatedAt` / `externalRefs` / `supplierId` keys taking
    every write), the **illegal transitions** (skip to closed, entry to
    `pending_approval`, reopen from sent / closed / cancelled, re-send,
    unknown statuses from every state, a no-line draft cannot be sent but can
    be cancelled, a bare re-stamp of a SENT PO refused while on a DRAFT it is an
    accepted empty edit), **transition purity** (eight kinds of smuggled
    content on send / close / cancel, another transition's stamps, forged
    actors, three skewed clocks per stamp, missing audit stamps), **direct-SDK
    bypasses** the old block admitted (create already sent, rewrite a sent
    PO's lines with a full setDoc, revive a cancelled PO, strip stamps or
    provenance), the **dependent collections** (a PO created and sent through
    the new rules is a valid `direct_po` invoice source; draft and cancelled are
    not; a claim against a sent PO still creates), **the REAL guarded
    transaction** `lib/purchaseOrderActions.js → runTransitionPurchaseOrder`
    against the rules (exact write; STALE copy refused with nothing written
    then the fresh copy closes; INVALID / MISSING / reserved target before any
    read; cancel BLOCKED by a draft, submitted, approved or invoiced claim, by
    a draft or posted invoice, and by a draft, submitted or approved SUPPLIER
    variation, with the PO left `sent`, while a rejected / withdrawn / client /
    manual-mode (`poId: null`) variation does not block; cancel SUCCEEDS when
    every link is rejected / cancelled / withdrawn or nothing is linked; the SERVER copy
    decides — a claim the snapshot called rejected but the server calls
    approved blocks, a vanished record cannot block; a denied role is
    PERMISSION with nothing written). Finally **six tests assert the security
    CEILING honestly** (Deferred Control 35): a direct-SDK cancel of a sent PO
    carrying an approved claim, a posted invoice and an approved supplier
    variation, junk `lineItems`
    elements, a header unrelated to its lines, creator == sender, duplicate PO
    numbers, a `supplierId` naming no contact, an unknown but well-formed
    project currency, and a blind last-write-wins draft edit are **all ACCEPTED
    by rules**.
  - `frontend/tests/rules/progressClaims.rules.test.js` — **102 tests**
    covering every case in §34 below (Progress Claim Lifecycle Security,
    ADR-58 / M2-B2). Until M2-B2 this block enforced role and tenancy and
    nothing else while `supplierInvoices` get()s a claim's `status` and Actual
    / Remaining Committed / FFC / Cash Flow / SHIELD trust its fields. It
    asserts the roles / membership / tenant matrix (three financial roles can
    create, read, edit, submit, approve and reject; `subcontractor`, `client`,
    orphan, anonymous and the other tenant denied; delete blocked for every
    role × six statuses), **valid create** (the hook payload for each role; a
    pre-Contacts `supplierId: null` PO and claim; retention, a five-digit
    number, blank refs, a retention equal to the subtotal, a cumulative second
    claim; the REAL `claimTotals` accepted on the half-cent boundaries where
    floating point rounds down — net 40.15, 41.05, 80.85, 327,680.05 — and
    where it rounds up — 0.05, 1,234.45 — with and without a retention moving
    the net onto the boundary; 200 lines against a 200-line PO), the
    **source-PO `get()`** (no PO, empty / null / numeric `poId`; draft,
    pending, closed and cancelled POs refused; a PO in another project or
    company unreachable; a foreign `poNumber`, `supplierName` or `supplierId`
    refused; a line count other than the PO's refused), **currency and project
    consistency** (the project's explicit currency; the company `baseCurrency`
    fallback; the `AUD` fallback; every other code refused; malformed codes;
    a non-existent project), the **create shape** (born draft — every other
    status refused even with plausible stamps; creator and audit stamps
    against `request.time` with three skewed clocks each; every lifecycle
    stamp, every approved value and the assessment notes null / empty; the
    exact 33-key set — each key missing and two extra keys refused; number
    pattern, supplier-name bound, revision 1, `externalRefs` map, reserved
    `variationId` null; claimRef / notes bounds, five bad `periodEnding`
    shapes, zero lines, 201 lines, a non-list), the **claimed money** (a
    negative retention — the floor; a retention above the subtotal; a zero
    or negative subtotal; non-numeric money in every key; `total` one cent
    off; GST one cent off, zero, and the PO formula refused once retention is
    withheld; on a boundary half-up and one below accepted, one above and two
    below refused; an NZD project at 10% vs 15%; a header unrelated to its
    lines ACCEPTED — DC36), the **draft edit** (the hook payload; a second
    edit at revision 3; a pre-ADR-58 document gaining the stamps; missing /
    forged / client-clock stamps refused; status, stamp, approved-value and
    notes moves refused; eleven identity rewrites refused; line-count change,
    shape and money breaks refused; every content key refused on `submitted`
    / `under_review` / `approved` / `rejected` / `invoiced` — the freeze after
    submit), the **revision** (same, +2, string, null, 0 and missing refused
    on every branch; a stored 7 takes 8 only; a legacy document with no key
    takes 1; two writers who both reviewed revision 1 — the second plain
    write is refused and the first stands), the **legal transitions** (submit
    with stamps; approve in full, partially and at zero with the certified
    lines and header; approval with a stored retention clamped to the
    certified subtotal and never rewritten; `under_review` → approved /
    rejected; withdraw from draft, reject with notes from submitted; creator
    self-submit and self-approve; legacy documents without `*By` /
    `updatedAt` keys, with a NEGATIVE legacy retention, and with neither
    `externalRefs` nor `supplierId` taking every write), the **illegal
    transitions** (draft → approved / under_review / invoiced; submitted →
    draft / re-submit / under_review / invoiced; approved terminal — reopen,
    re-approve, reject and the reserved `invoiced` all refused; rejected and
    invoiced terminal from every target; unknown statuses from every state; a
    no-line draft cannot be submitted; a bare re-stamp of a draft is an
    accepted empty edit), **transition purity** (fourteen kinds of smuggled
    content on submit, thirteen on reject, fourteen on approve incl. the
    claimed header, the retention and the identity; another transition's
    stamps; forged actors on all three; three skewed clocks per stamp;
    missing audit stamps), the **approval money** (`approvedSubtotal` one cent
    above the stored `claimedSubtotal` refused; negative and non-numeric
    refused; GST one cent off, zero and the PO formula refused with a stored
    retention; the boundary allowance on the approved side; the certified
    line COUNT pinned while a per-line over-certification that sums under
    the claimed subtotal is ACCEPTED — DC36), **direct-SDK bypasses** (create
    already approved / against no PO / against another supplier's PO; a full
    setDoc rewriting a submitted claim's lines, supplier or PO; moving an
    approved claim's cost to another PO, supplier or project or changing its
    certified value; reviving a rejected claim or reopening an approved one;
    stripping stamps or provenance), the **claim-to-invoice lifecycle and the
    M1 figures** (a claim raised, submitted and approved through the new
    rules is a valid `progress_claim` invoice source while draft, submitted
    and rejected are not; posting the invoice writes nothing to the claim, a
    direct `invoiced` write is refused, and `invoicedClaimIds` hands the cost
    over at read time; Actual 1,000 / Remaining Committed 1,500 / pending
    exposure derived from a claim approved under the new rules with the added
    keys changing nothing; a rejected claim contributes nothing and the next
    claim seeds from the certified amounts; a claim whose PO is later
    cancelled still edits, submits and approves while no new claim can be
    raised), **the REAL guarded transactions**
    `lib/progressClaimActions.js → runUpdateClaimDraft / runTransitionClaim`
    against the rules (exact draft write with rebuilt lines; STALE on a
    revision moved underneath and on a status moved underneath, with nothing
    written, then the fresh copy saves; invalid edits refused before any
    read; submit / approve with cent-normalised amounts / reject each +1; a
    STALE assessment never overwrites the first assessor; illegal move,
    reserved target, over-certification and missing document refused before
    any write; a denied role is PERMISSION; a legacy draft edits and submits
    acquiring the keys). Finally **seven tests assert the security CEILING
    honestly** (Deferred Control 36): a second open claim on the same PO,
    junk `lineItems` elements, a header unrelated to its lines and cumulative
    claiming above the PO line, creator == approver and duplicate claim
    numbers, the mixed-mode overlap with a direct invoice, a read-then-write
    `stored + 1` stale bypass, and a line below its previously approved
    amount whose header balances are **all ACCEPTED by rules**.
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
  - `frontend/tests/rules/variations.rules.test.js` — **102 tests**, the
    `variations` block after ADR-59 (M2-B3) — see §35. Roles and tenancy
    (every financial role creates a manual, a PO-linked and a client
    variation, edits, submits, approves, rejects and withdraws;
    `subcontractor` / `client` / `super_admin`, anonymous, orphan and another
    company denied; a member cannot write into another company's project; no
    create under a missing project); delete blocked at six statuses; valid
    creates (SENT and CLOSED POs, a pre-Contacts PO, an all-negative credit, a
    zero-value variation, mixed signs and tax codes, 200 lines, the ADR-34 link
    on both types); the exact key set, born-draft status, creator stamps
    against skewed clocks, every stamp / approved value / date / note empty at
    birth, reserved fields at reserved values, the type-pinned number prefix;
    counterparty consistency between the two types; the source-PO `get()`
    (draft / pending / cancelled / missing / other-project PO, wrong number,
    wrong supplier name or id, a manual-mode pair that is not both null);
    currency resolution through project → company → AUD; content shape;
    SIGNED whole-cent headers with the exact total identity; every ADR-34
    create case (draft / cancelled / nonexistent / other-project /
    other-company RFI, seven malformed triples, wrong or re-cased snapshots,
    the RFI untouched at 34 keys, the keys now mandatory). Draft edit: the hook
    payload with a changing line count, a client draft's clientRef, notes, a
    partial edit, a legacy draft acquiring the keys, refused stamps / revision
    / skewed clocks, refused status and stamp changes, every identity /
    counterparty / PO / reserved / provenance field refused, content and money
    re-validated, the reference kept on its own side; the ADR-34 add / change
    / remove cases (legacy included), the invalid targets, the **critical
    historical case** (link, cancel the RFI, every later edit and transition
    still passes; only changing TO it is refused) and the freeze on every
    non-draft status — remove, partial removal, id / number / title change and
    a valid re-link refused for every financial role, an unlinked and a legacy
    document unable to gain a link, re-sending the identical triple refused
    outside draft. **Source PO link, counterparty and type frozen from
    creation** (the final-review question): a legitimately created PO-linked
    variation refuses every re-link (cancelled, draft, foreign-project, valid-
    but-different, nonexistent, id-only, number-only, demotion to manual mode),
    every supplier-snapshot forgery, a type flip and a number change — alone,
    bundled with a content edit, as a whole-document replacement and bundled
    with a transition — then submits and approves against its ORIGINAL PO and
    stays frozen afterwards; manual-mode and client variations can never gain
    a PO; a legacy link survives its PO's cancellation and cannot be
    "repaired" to another PO. Revision
    exactly +1 on every branch, a stored 7 → 8, a missing key → 1, two
    assessors. The legal matrix (submit with the date kept / set / empty;
    approve with the SIGNED header on four sign patterns; reject with and
    without notes; withdraw from draft and submitted; `under_review` as a
    source only) and every illegal move, reserved target and unknown status.
    Transition purity (no content on submit / reject / withdraw; approval
    touches only its own keys; actor and time on every branch against skewed
    clocks; the certified line count pinned; the approved date required; notes
    and dates bounded; the stored draft must hold a line). Approval money on
    every sign. Direct-SDK bypasses (create approved / submitted / withdrawn,
    rewrite a submitted or approved document by replacement, move exposure to
    another PO / supplier / type / project, attach a foreign-project RFI,
    revive a terminal document, strip stamps). Legacy documents (foundation
    shape: edit, submit, withdraw, approve, reject; terminal stays terminal; a
    PO-linked one whose PO was since cancelled). Downstream figures from
    variations approved through the new rules — Commitment Exposure by cost
    code, the four exposure totals, the Current Contract Sum through
    `computeMargin` (positive and credit), the M2-B1 cancel guard, the RFI
    reverse view. The two REAL transactions (`lib/variationActions.js`): draft
    edit, STALE by revision and by status, invalid before any read, link /
    keep / unlink through the edit, submit → approve (cents, notes) → reject /
    withdraw, a STALE assessment, illegal / reserved / missing, a denied role
    as PERMISSION, a legacy draft. Six **honest-ceiling** cases (DC37): junk
    line contents, a header GST unrelated to the lines, an approval that
    differs with empty notes, self-approval and duplicates, the read-then-write
    stale bypass, the PO read at create only.
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
  - `frontend/tests/rules/externalRoles.rules.test.js` — **176 tests**, the
    **ADR-56 (M2-A) financial read containment**. For each of `costCodes`,
    `budgetLines`, `purchaseOrders` and `progressClaims`, **get** and **list**
    are proven ALLOWED for `company_admin` / `project_manager` / `qs` and
    DENIED for `subcontractor`, `client`, `super_admin`, an **unknown role**
    (`auditor`), a membership document with **no role**, a signed-in user with
    **no membership document**, an **anonymous** caller and a financial role
    in **another company** (both directions); the **write rules are proven
    unchanged** (financial roles still create and update, every other identity
    still cannot, delete still blocked); **no alternate match grants access**
    (a collection-group query over each name and a document nested below a
    contained document are denied for admin and subcontractor alike); and the
    **neighbouring surfaces are pinned in both directions** — `projects` and
    `drawings` still read for every company member and still deny another
    tenant / orphan / anonymous, project-visibility `documents` still read for
    external roles while `internal` ones still deny them, external roles still
    cannot write projects or drawings, and the Storage drawing / document
    objects behave exactly as before (requires both emulators).
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

- `frontend/tests/unit/shield.test.js` — **202 tests** over `lib/shield.js`
  and the SHIELD page wiring (SHIELD™ foundation, ADR-50): see §26.
- `frontend/tests/unit/pulseAttention.test.js` — **65 tests** over
  `lib/pulseAttention.js` and `lib/pulseAcknowledgementActions.js` (PULSE™ 1B,
  ADR-49): see §25.
- `frontend/tests/unit/variationCommitment.test.js` — **32 tests** over the
  M3-B1 commitment application (ADR-62): see §38 — the worked cases A–E
  (100,000 + 12,000; claim 5,000; full claim and invoice; −8,000; a prior
  claim), several variations on one line, several lines and cost codes, mixed
  and new-scope-only variations, legacy unapplied, invalid links, negative
  revised lines, duplicate documents, eligibility and the approve-time
  decision, the commercial-effect preview and the CTC warning, and
  Forecast / Margin / Snapshot / Cash Flow / PULSE consistency; plus **16**
  cases added to `variationActions.test.js` and **10** to `shield.test.js`.
- `frontend/tests/unit/rulesSize.test.js` — **5 tests** pinning the
  `firestore.rules` SOURCE-SIZE budget (ADR-51 hotfix; 210,926 bytes after
  ADR-62, 207,620 after M3-A): under the approved
  **245,000 UTF-8 bytes** and under Firestore's **262,144-byte** publish limit,
  measured in bytes (the file is not pure ASCII), with real headroom between
  the two; `storage.rules` far below. Passing proves the file CAN be published —
  not that it IS (DEPLOYMENT.md → *Verifying which rules version is published*).
- `frontend/tests/unit/quantDeductions.test.js` — **41 tests** over the
  Quant™ 1D deductions (ADR-54): see §30 — the geometry primitives
  (`segmentsCross` proper only; on-boundary points; `polygonWithinPolygon`
  with touching allowed and straddling refused; the CONCAVE regression — a
  hole in a U's notch with every vertex on the boundary and no proper
  crossing is outside; an edge that leaves and re-enters; `polygonsDisjoint`
  failing touching, crossing, nested, identical, collinear-partial-overlap
  and plus-sign pairs), `deductionsProblem` (the brief's door + window valid;
  self-crossing / collapsed → invalid; outside; overlap with both ids named;
  duplicate geometry; duplicate ids and junk → malformed; > 100 points; a
  hole equal to the parent → exceed), the NET derivation (30 − 2 − 3 = 25 with
  gross/deducted/count beside it; a legacy area derives byte-identically; mm
  and re-calibrated scales; unrounded; zero, negative and a sub-3-dp sliver
  → INVALID while a 0.05 m² sliver survives; every reason labelled; a crossed
  PARENT reported first; uncalibrated stays uncalibrated; holes ignored on a
  length; the original quantity is the original NET and the whole measurement
  needs review), validation (labels, ≤ 100 points, the complete list with the
  derivation's own words, the 3 dp gate only with a calibration, 50 ok / 51
  refused, fresh distinct ids, `withDeduction` / `withoutDeduction`,
  readability — a bad hole is named not hidden, holes on a length unreadable,
  evenodd path data, a tap inside a hole selects the parent), the guarded
  update against the in-memory stand-in (create writes no key; first hole is
  revision 2; rename / outline / remove each +1; the key emptied; outside,
  overlap, exceed, duplicate id, non-list, on-a-length and the 3 dp sliver
  refused with their reasons; a stale copy is STALE with nothing written and
  the SERVER outline decides containment; a parent move that strands a hole
  is refused and one that keeps every hole inside passes; the snapshot never
  moves so *needs review* stays; void keeps the holes and refuses further
  change; an invalid stored set is corrected by Remove), draft memory (parent
  id and hole id round-trip; a deduct draft without its parent never parses or
  is written; pre-1D entries parse unchanged; restore needs the parent active
  on the sheet, a hole edit the hole at the same revision), the page totals,
  project summary and BOQ aggregate consuming net once (an invalid set is
  attention / blocks the apply), the fingerprint (byte-identical row key and
  `v1` for a measurement without holes; a hole added, moved or removed changes
  it; order-independent across holes; a prior application reads *outdated*),
  and structure pins (rules key in `hasOnly` not `hasAll`, area-only ≤ 50 list,
  active-edit list, void unchanged, under budget; no key at create and 3/3
  transactions; evenodd fill and dashed holes with no pointer events; the
  list's sub-list and actions; the dialog's label-only form on the shell; the
  workspace's Deduct, deduct tool, STALE message, no snapshot on a deductions
  save, cursor mode; the BOQ apply untouched; no financial import anywhere).
- `frontend/tests/unit/quantSummary.test.js` — **39 tests** over
  `lib/quantSummary.js` and the 1C-B wiring (ADR-53): see §29 —
  classification (current & valid with its own-page quantity and live cost
  code; unlinked still valid but listed; needs review / uncalibrated /
  non-derivable are attention and never totalled; a missing drawing or page
  is *source missing*; the four invalid-link states; an earlier revision and a
  withdrawn drawing are historical, totalled apart, not in the attention list;
  void counted only; unreadable; a record counts once), **the historical
  qualification regression** (a needs-review, crossed or uncalibrated
  measurement on an earlier revision or a withdrawn drawing is badged, stays in
  the historical list and is NEVER summed into the historical total — by
  `isTotalable`, the one gate `kindTotals` applies; a missing page is
  *source missing*; valid historical quantities still total apart from
  current), totals (per kind with
  their own units, no grand total, unrounded sums, by cost code with current
  and historical apart, by drawing → revision → page with the current revision
  first and a target only for an openable drawing, the attention order and
  per-issue counts, an empty project), readiness (unavailable beats loading
  beats ready; the view renders counts only when ready and the workspace feeds
  every source's flags), traceability (`measurementTarget` for a live
  measurement and each explained problem; `revisionLabel` proving only what it
  can; `measuredAt` from a real Timestamp only), the remembered selection's
  optional `measurementId` (round trip, absent when null, junk ignored,
  projects isolated), and structure pins (a view on the Quant tab over the
  existing subscriptions — no new hook, tab or route; *Open* validates then
  moves the selection behind the same confirmation and resolves the target
  from a microtask; the BOQ page writes the selection and navigates with the
  app router, the dialog's button, no second router; the apply write,
  fingerprint and readiness gates unchanged; per-sheet drafts and the
  other-sheets notice; the measured date in list and summary; no Firestore or
  financial import in any Quant file; ≥44 px buttons, tables above `md`, cards
  below; the view sums nothing).
- `frontend/tests/unit/quantInteraction.test.js` — **59 tests** over the
  Quant™ 1C-A additions (ADR-53; the draft pins revised by 1C-B to per-sheet
  keys, with `listDrafts`): see §29 — the simplicity check (the
  asymmetric crossing with a NON-ZERO shoelace result is refused and derives
  `INVALID` with reason `self_intersecting`; the symmetric bow-tie now reads
  *crosses itself*; square, concave L, triangle and a 500-point circle pass
  unchanged; adjacent edges may share a vertex, a collinear mid-edge vertex is
  legal, a spike, a T-touch and a pinched figure-of-eight are refused; a
  repeated closing vertex and consecutive duplicates normalise; collinear,
  coincident and fewer-than-three-distinct rings are *degenerate*; lengths may
  cross and counts still count; an uncalibrated page does not hide a crossing;
  a crossed draft is refused by `validateMeasurementDraft`; an EXISTING crossed
  record is counted incomplete, never summed, and BLOCKS the apply through the
  unchanged aggregate with no fingerprint; 500 points validate in well under a
  frame; segment primitives), the edit helpers (distance to a segment, nearest
  vertex / segment with the closing edge only for areas, insert after an edge,
  remove by index, minimum counts per kind, a crossing drag flagged live), hit
  testing (point in polygon incl. a concave notch, edge / marker / boundary
  distances, nearest wins, the SMALLEST containing area, voided and unreadable
  never hit, the 22 px tolerance scaled by the CSS scale), zoom arithmetic
  (`wheelZoom` direction, symmetry, line / page modes and clamping;
  `pinchZoom` ratio, clamp and degenerate distances; `zoomAboutPoint` keeps the
  content point under the pointer fixed and inverts; pointer → canonical exact
  at 0.25× to 8×), `clampPageInput` ("12" is 12, clamped, junk null), the
  remembered draft (per-project key, versioned shape, junk and bad tools /
  points / three calibration points refused, empty clears, a missing or throwing
  storage never throws, an edit round-trips with its revision, `restorableDraft`
  restores only on the same sheet and an edit only against the same active
  measurement at the same revision — otherwise dropped and SAID so — and no
  Firebase import), and structure pins: the workspace's unsaved-work
  definition and `confirmDiscard` in every change handler and on starting an
  edit, Cancel without a second question, the before-unload and link guards,
  every save counted in flight, the once-only microtask restore and the
  persist-after-restore effect, Select hit-testing on tap and measuring taps
  refused unless measurable, the edit session's history / vertex / insert /
  markers / Save through the guarded update, Finish withheld while a draft
  crosses; the viewer's non-passive Ctrl/⌘-wheel listener and its removal,
  anchored layout effect, pinch coalesced per frame and cancelled on unmount,
  touch-or-Select pan, mouse slip, nearest-vertex drag within tolerance,
  pointer capture and cancel, `touch-none`, unchanged render cancellation and
  no new dependency; the overlay handling no pointer events; `QuantDialog`'s
  contract and each dialog rendering through it with a unique title id, its
  saving state as `busy`, `autoFocus` and `role="alert"` kept and no overlay of
  its own; business behaviour unchanged; the list naming a non-derivable
  quantity and scrolling the selected row into view; no Quant file gaining a
  financial import or a Firestore write; nearest-vertex resolution for two
  handles 30 px apart; the 7 px handle and 22 px target constants; every new
  control a ≥44 px button; closed vocabularies.
- `frontend/tests/unit/quant.test.js` — **118 tests** over `lib/quant.js`,
  `lib/quantActions.js`, `lib/pdfRender.js` and the Quant™ 1A page wiring
  (ADR-51): see §27. (ADR-53 revised five pins explicitly: the bow-tie is now
  refused by the simplicity check — the asymmetric crossing is the regression;
  an INVALID quantity carries its `reason`; the change handlers confirm before
  resetting; the viewer receives a `mode` and `editPoints` instead of
  `pointerEnabled`; Select hit-tests on tap.) (The count is the runner's — an earlier figure of 112
  was a hand count; ADR-52 revised four 1A boundary pins explicitly and added
  one: the workspace may READ BOQ items, no Quant file may call a BOQ write.
  The Quant 1B UI polish added one more: the mobile measurement card's compact
  action group — review badge beside *Mark reviewed*, the rest as equal 44px
  cells with a visible focus state — while the table row is unchanged. The
  workspace-persistence correction added nine and revised two 1A pins
  explicitly (the selection setters are now `setDrawingChoice` /
  `setPageChoice`): the keyed Outlet as the root cause, the remembered
  selection read once from sessionStorage, validated before use, written back
  only once the records have settled, measurability still from live records;
  which actions a measurement card offers and why a withdrawn sheet shows
  *Show* and *Void* only; the compact group clips nothing; and the
  deterministic seed — A-201 calibrated, the 12 m² area linked to 2.1, the
  rectangle re-derived through `measurementQuantity` and `boqLineAmount`,
  no `--import` / `--export-on-exit` in the launcher.)
- `frontend/tests/unit/quantSelection.test.js` — **14 tests** over
  `lib/quantSelection.js` (Quant 1B correction; ADR-52 Decision 9): the
  per-project sessionStorage key and versioned shape (junk, wrong version,
  slash-bearing or over-long ids and bad pages are null or defaulted);
  Quant → BOQ → Quant and refresh read back what was written; last write wins
  and "no drawing" clears the entry; project switching never leaks (two
  projects, two keys; clearing one leaves the other); a missing or throwing
  storage reads null and writes false without an exception; a saved drawing
  is restored only from a SETTLED register and only when not withdrawn; an
  explicit revision only from the loaded list (withdrawn and superseded are
  listed, deleted is not); the page follows the saved revision and resets to
  1 when that revision could not be honoured; the valid default when nothing
  is saved; and an end-to-end restore / withdrawn / deleted-revision walk.
- `frontend/tests/unit/quantBoq.test.js` — **59 tests** over `lib/quantBoq.js`
  (Quant™ 1B, ADR-52; two pins revised explicitly by ADR-53 — degenerate or
  crossed geometry now BLOCKS the apply as *Quantity cannot be derived* instead
  of summing 0, and the 500-point fingerprint polygon is traced in order so it
  is simple): see §28 — unit normalisation and every accepted alias
  per dimension, the refused units (m³, mm, cm, kg, t, hr, lump sums, %,
  blanks, unknowns, imperial) and no dimension ever crossed, linkable items
  (active · same cost code · compatible unit), link state, aggregation
  (sum-unrounded-round-once proven on three ⅓ strips → 1.000 not 0.999,
  dedupe, void excluded, cross-page/cross-drawing within one project), every
  blocker in isolation and "one blocked = no total", readiness (loading and
  unavailable first, then void / unsupported unit / blocked / none / unchanged),
  the preview through `boqLineAmount` (priced, zero rate, unpriced),
  `quantApplied` readability and state, **the evidence fingerprint** (review
  correction: deterministic, order-independent, versioned, bounded even for a
  500-point polygon; **5 + 7 → 4 + 8 — same total, same count, changed
  geometry — is DIFFERENT evidence and reads *outdated***; a changed
  measurement revision alone is detected; a swapped id, a re-calibrated page,
  a moved current-revision pointer and a snapshot change all change it; no
  fingerprint while anything is blocked; a LEGACY record without one is
  *cannot verify*, never *matches*; loading, unavailable, a missing drawing
  or page and an absent aggregate are never *matches*), the evidence key
  (built from the same canonical row text as the fingerprint), and structural pins
  (no Firebase import; the only money derivation is `boqLineAmount`; the BOQ
  page mounts the existing hooks read-only; the dialog binds confirmation to
  the evidence key; the editor clears the link on re-code; the dialog closes on
  Escape unless saving, contains Tab / Shift+Tab through `lib/dialogFocus.js`
  with no focus-trap dependency, and shows existing and proposed amounts with
  `{ precise: true }` — cents — like the BOQ editor and void dialogs).
- `frontend/tests/unit/dialogFocus.test.js` — **11 tests** over
  `lib/dialogFocus.js`, the pure keyboard-containment helper first used by the
  Quant 1B apply dialog: `isTabbable` (disabled, hidden, `tabindex="-1"`,
  hidden inputs and `aria-hidden` are skipped), `tabbableWithin` (document
  order, filtered), and `tabTarget` — Tab from the last control wraps to the
  first, Shift+Tab from the first wraps to the last, focus between the edges is
  NOT intercepted (null), focus on the panel itself or behind the overlay is
  pulled to the first / last control, a lone control always receives focus,
  and a panel with nothing tabbable keeps focus on the fallback.
- `frontend/tests/unit/boqActions.test.js` — **21 tests** over
  `lib/boqActions.js` (ADR-52) against an in-memory Firestore stand-in:
  `sameStamp` / `boqVersionMatches` (stamps decide when both sides have one;
  a LEGACY record without one is guarded field by field — never "match"),
  the error vocabulary and SDK-code mapping, the manual edit (fields + stamps,
  ratchet only when priced, STALE refused, legacy content guard, missing /
  void / invalid / no actor), and the Quant apply (priced writes quantity +
  amount from the SERVER rate + provenance + stamps and nothing else; unpriced
  leaves amount null with no ratchet; zero rate is a price; STALE on a changed
  rate / unit / cost code / quantity; unchanged refused — set, never add;
  applying twice does not accumulate; a bounded `evidence` fingerprint is
  required — missing, blank, oversized or non-string refused before any write;
  a zero total is legitimate).
- `frontend/tests/unit/moduleBranding.test.js` — **39 tests** over the
  advanced module branding (ADR-48; pins revised by ADR-50 and ADR-51): see §24.
- `frontend/tests/unit/dashboardV2.test.js` — **78 tests** over the Premium
  Dashboard v2 (ADR-45): see §22.
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
- `frontend/tests/unit/forecast.test.js` — **47 tests** over the forecast-row
  composition (ADR-43): `isUnforecasted` (null/undefined only; **0 is a
  forecast**; malformed values are *not* unforecasted and contribute zero) and
  `isOverBudget` at cent resolution (−0.005 rounds to zero, −0.006 does not);
  `composeForecastRow` proven equal to the named functions it calls, over every
  row shape the cost-code union produces — budgeted, saved-zero, **inactive**
  actual-only, **missing** with a stored name, unbudgeted-with-cost (never over
  budget), variation-only, budget-only — plus an **over-credited** code whose
  negative Actual flows through unclamped; `projectForecastTotals` carrying the
  counts and `costToComplete` it never did while its headline figures are
  unchanged, a fully forecast project (zeros saved) at count 0, a budget edit
  moving `overBudgetCount` but no cost figure, and rename/deactivation moving
  neither count; **parity** between the Forecast page's no-edits overlay
  (reproduced exactly) and the saved path, field by field, including a malformed
  stored value; **end to end** — the count reaching `costCoverage` →
  `completenessState` (never Complete) → `peakFundingSuppression` (exact reason
  string), the timed percentage unchanged by the flag, Complete restored on a
  fully forecast project, and a zero basis of unforecast codes reported as both
  unavailable and incomplete; and the three-caller **structure** (margin, page
  and invariance suite all compose through the one helper; the page calls none
  of the pieces directly).
- `frontend/tests/unit/financialReliability.test.js` — **150 tests**, the
  ADR-44 proof for Forecast, Commercial and Overview. **Dependencies verified by
  perturbation** against the real selectors (`projectForecastTotals`,
  `buildForecastRows`, `computeMargin`): for every figure key the tabs display,
  emptying any declared source moves it and emptying any undeclared source does
  not (mutation-checked in both directions). **Availability**: every
  dependency loading → `—`, failed → Unavailable naming the source, settled
  zero → a real `$0`, a failure never hiding an unrelated figure; **credit-note
  failure** makes exactly the Actual-derived figures Unavailable and the
  notices say so (Budget's notice no longer claims otherwise). **Dashboard
  invariance**: the eight ADR-42 dependency lists byte-identical and the
  snapshot shape unchanged. **Currency lock**: the evidence list equals
  `monetaryLockReasons`' parameters, each source alone is evidence, and any
  loading/failed source keeps the selector closed. **Baseline client name**
  (`resolveBaselineClient`): an unresolved stored client keeps its name, any
  other unresolved id is refused. **Structure**: the Forecast and Commercial
  wrappers mount no financial or contacts hook for other roles; every figure
  is routed through the availability helpers; Save / Save all / Use remaining
  budget / Use current approved budget / baseline Save / currency Save are
  gated; the project outlet is keyed by `projectId`.
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

- `frontend/tests/unit/timelineScheduling.test.js` — **74 tests** for the
  Timeline & Scheduling Enhancements (ADR-46): the **Due** filter (overdue
  only; due within 14 days inclusive of today and day 14, excluding day 15),
  completed/cancelled never overdue or due soon, both counts equal to the
  summary cards, **combined filters only narrow**, the legacy `overdueOnly`
  flag, desktop/mobile receiving the same filtered set; **date rollover**
  (the same activity flips from due-soon to overdue across midnight,
  `msUntilNextLocalDay` incl. month/year ends, the page and panel no longer
  freezing `now`, `useLocalToday` re-arming and cleaning up); the **quick-action
  planner** for every status × action (Start records today only when no actual
  start exists; Complete never invents an actual start, never overwrites an
  actual finish, refuses a future actual start; milestones get only Mark
  reached; no audit/content/cancellation key ever written; already-invalid
  stored data sent to the editor); author-only rendering; the **guarded
  transaction** with a fake Firestore (only planned keys + stamps written;
  stale by timestamp or writer; a contention re-run refused rather than
  re-applied; re-validation against the server copy; missing; locally
  pending; permission; offline; error-code mapping; no UI side effects in the
  callback; the full editor documented as still unguarded); and
  **nextMilestone** (nearest upcoming incl. today, overdue fallback to the
  oldest, overdue count, deterministic ties, completed/cancelled/
  non-milestone/invalid-date exclusions, none, midnight rollover) plus the
  panel's loading/unavailable/no-milestone states, no percentage and keyed
  project isolation.

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

- `frontend/tests/unit/forecastLayout.test.js` — **6 tests** pinning the
  Forecast table's **Use remaining budget** action (source structure, no
  jsdom): its Uncommitted Cost to Complete cell wraps (`whitespace-normal`)
  so the action can never again sit beside the input and draw over Cost to
  Complete; the button is block-level, full-width and has a 44px touch target;
  its `applyRemainingBudget` / `disabled={!editable}` wiring is unchanged; and
  the table keeps its own `overflow-x-auto` container.

- `frontend/tests/unit/betaSurfaces.test.js` — **28 tests** guarding the
  private-beta surfaces. Not domain logic: like `documentsResponsive.test.js`
  these assert **source structure**, because the defects are structural and the
  runner has no jsdom. Three groups: (1) each of the four tables the Beta Launch
  Readiness assessment found bare inside a `Card` — Dashboard, Projects, Project
  Budget, Project Cost Codes — is wrapped in its own `overflow-x-auto` container
  and keeps its assessed `min-w`, so the Actions column can never become
  unreachable again; (2) `lib/nav.js` and `lib/projectTabs.js` offer no
  placeholder module (no Photos, Reports, PULSE™ or SHIELD™) **while the routes
  in `App.jsx` still exist** — the test pins both halves, so "hidden" can never
  quietly become "deleted", and it also lists every tab that must survive so
  hiding two never becomes hiding six; (3) `pages/Dashboard.jsx` contains no
  `recharts` import, no `chartData`/`donutData`, and none of the removed
  hardcoded figures, while still deriving its counts from the live projects
  subscription. The Dashboard group strips comments before asserting, because
  the file's header comment deliberately **names** the numbers that were
  removed and that record is worth keeping.

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

- `frontend/tests/unit/variationActions.test.js` — **25 tests** over
  `lib/variationActions.js` (ADR-59, M2-B3 — see §35): revision arithmetic
  and `todayIso`; `draftUpdate` (exactly the draft-editable keys, the signed
  header, the approved side forced null, the reference on the SERVER copy's
  type, notes and the RFI triple only when passed, every INVALID reason, a
  legacy copy writing revision 1); `transitionUpdate` (submit with the date
  kept or set, reject / withdraw stamps-only, approve with the certified lines
  / signed header / notes / dates, the effective-date fallback, unbounded
  amounts, count mismatch / non-number / differing-without-notes refused, the
  reserved targets refused, the stamp map complete); and both transactions
  over a scripted fake — check order before any read, the write built over
  the server copy, STALE by revision and by status with nothing written,
  MISSING, PERMISSION, error-code mapping and pass-through.
- `frontend/tests/unit/variations.test.js` — **72 tests**: 38 over the
  originating-RFI helpers in `lib/variations.js` (ADR-34), 29 over the
  draft-edit helpers (ADR-35 — see the end of this bullet) and **5 ADR-59
  cases** — the four-entry stamp map with the reserved statuses absent and
  every legal target stamped, `validateVariationDraft` refusing 201 lines and
  accepting 200, a sweep of every cent from −$10,000 to $10,000 on each tax
  code and 20,000 random mixed-sign multi-line variations through the REAL
  `variationTotals` against the rules' replicated whole-cent check and total
  identity, and the check's non-vacuity: `ORIGIN_RFI_STATUSES`
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
- [ ] `/forgot-password` is a working password-reset form (full acceptance in §18a); `/create-account` is still a "coming soon" stub. Both have a working **Back to sign in** link.
- [ ] Sign out from the topbar menu returns to `/login`.
- [ ] A user whose `users/{uid}` doc has a different `companyId` sees none of this company's data.

## 2. Projects

- [ ] Projects page lists projects newest-first; empty state prompts creation.
- [ ] Create a project with name/status/budget/start date/location/progress → appears immediately (live snapshot), correct badge colour, formatted AUD budget and date.
- [ ] Project name is required; budget/progress inputs reject negatives (progress clamps 0–100).
- [ ] Open a project → lands on `/projects/{id}/overview` showing budget, start date, progress bar.
- [ ] Unknown project ID shows "Project not found."; unmatched routes redirect to `/projects`.
- [ ] The **Photos and Reports tabs are not shown** (hidden for private beta — see §18). Navigating directly to `/projects/{id}/photos` or `/projects/{id}/reports` still renders the placeholder card. Documents is live (Variations — see §14 — Forecast — see §15 — Commercial — see §15g — BOQ and Tenders — see §15s — and Timeline — see §15p — are now live).

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
- [ ] **Cancel guard (ADR-57):** on a sent PO with a draft, submitted or approved claim, a draft / approved / posted supplier invoice, or a draft / submitted / approved supplier variation raised against it, **Cancel** opens no confirm dialog and shows the red reason naming each record and its status (*… reject the claims, cancel the invoices and reject or withdraw the supplier variations first — cancelling the PO never changes them*); the PO stays Sent and no claim, invoice or variation changes. Reject the claim(s), cancel the invoice(s), reject or withdraw the variation(s) → **Cancel** now confirms and succeeds. A supplier variation raised in manual mode (no PO) never blocks.
- [ ] **Cancel guard fails closed:** with the Progress Claims, Supplier Invoices or Variations read failing (simulate offline or a denied read), **Cancel** shows *Linked progress claims, supplier invoices or variations could not be loaded…* and does nothing.
- [ ] **Stale transition (ADR-57):** tab A shows a draft; tab B sends it; tab A clicks **Cancel** → confirm → the message reads *PO-000n is now Sent, not Draft. Reload the page…*; nothing changed. Same for **Send** on a PO another tab cancelled.
- [ ] A negative quantity or rate typed into the editor is refused at Save with *Line n: quantity and rate cannot be negative* (no document written).
- [ ] Editor is usable at 375 / 768 / 1280 px (context block stacks on mobile; line grid wraps as at create).

## 6. PO Cancellation Removes Committed Cost

- [ ] Send a PO against a budgeted cost code → Budget tab Committed equals the PO's ex-GST line total.
- [ ] Cancel that PO (no claim or invoice linked — ADR-57) → Committed returns to previous value immediately, without editing the budget line.
- [ ] Send a PO against a cost code with **no** budget line → amber "Committed via PO — no budget line" warning row appears; cancel → row disappears.
- [ ] A PO that carries an approved claim or a posted invoice **cannot** be cancelled through the app (§5, cancel guard); Committed, Actual and FFC therefore never lose a commitment that still has recognised cost against it.

## 7. Progress Claim Creation

- [ ] With no sent POs: claims tab disables creation and links to Purchase Orders.
- [ ] New claim: only **sent** POs (without an open claim) appear in the selector.
- [ ] Selecting a PO lists its lines with "of {PO line total}" and pre-filled claimed-to-date; totals footer shows Claimed this period, Retention, GST 10%, Total payable.
- [ ] Retention: entering more than the subtotal clamps to subtotal; GST is 10% of (subtotal − retention). A **negative** retention is refused in the editor (*Retention cannot be negative*) — and by rules once ADR-58 is published.
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
- [ ] **Concurrent draft edit (ADR-58):** tab A and tab B both open Edit on the same draft; tab B saves a change → tab A's Save is refused with *"PC-000n was changed by another user since you loaded it. Review the latest version and retry — your entries are kept."*, the editor stays open with every entry intact, and the register shows tab B's figures; closing and re-opening the editor then saves. The same refusal protects **Assess**: two assessors on one submitted claim — the second Approve / Reject is refused naming the claim's new status, and the first assessment stands.
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
- [ ] ⚠️ This is **client-only** (Deferred Control 36): rules cannot see sibling claims, so a direct write can still raise a second open claim; SHIELD check 4 lists it.

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
- [ ] Signed in as a `subcontractor` or `client` role user, the Forecast tab shows **"Forecast data is restricted"** and no figures, and opens no financial subscription (ADR-44 — see §20.4). Rules block the financial-role-only reads regardless; budget lines, POs and claims remain readable by company members under rules, so the page gate is a UX mirror, not a control.

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
- [ ] If the baseline **fails to load**, the card row **does** appear, with Current Contract Sum, Forecast Gross Profit and Forecast Margin % reading **Unavailable** and a note that this does not mean the contract value is unset (ADR-44 — §20.3).
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
- `frontend/tests/rules/costCodes.rules.test.js` — **52 tests** (51 before ADR-56): the read
  audience (**financial roles only since ADR-56**; subcontractor / client /
  super_admin denied — the earlier "every role reads" case was revised, not
  weakened, because it pinned the P0 exposure) and tenant isolation; create by the three writer roles and refused for
  the rest; provenance immutability; the update key allow-list; every field shape
  and length bound; `isActive` reversible in **both** directions and a legacy
  document with no `isActive` key still writable; deletes blocked for every role;
  and **Group F proves the documented gap** — duplicate codes are accepted at the
  boundary, because rules cannot query siblings.
- `frontend/tests/rules/budgetLines.rules.test.js` — **66 tests** (65 before ADR-56): the read
  audience (**financial roles only since ADR-56**; subcontractor / client /
  super_admin denied — revised for the same reason) and tenant isolation; create shape (`costCodeId` required, `budgeted`
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

**Incomplete cost basis (ADR-43)** — the count behind the warning is
`projectForecastTotals().unforecastedCount`, the same figure the Forecast tab
header shows as "N of M cost codes not yet forecast". Set up a project with full
revenue and cost coverage lines, then:

- [ ] With **one** cost code that has a PO or an actual but **no saved
  forecast** (blank, "Not forecast" on the Forecast tab): the notice reads
  *"Cost to Complete is incomplete — 1 cost code is not forecast…"*, the badge is
  **Partially timed** (never Complete), and **Cost timed %** is the same number
  it showed before the notice appeared.
- [ ] On the Forecast tab save **0** on that code → the notice disappears and,
  with everything else timed, the badge becomes **Complete**. A saved zero is a
  forecast.
- [ ] Clear the input back to blank and save → the notice returns. The Forecast
  tab's "N of M not yet forecast" count and the Cash Flow notice's N **always
  agree**.
- [ ] A cost code with **only** an actual (e.g. a posted invoice line, finished
  work) and no forecast line is counted — it is not exempt because nothing is
  committed on it.
- [ ] An **inactive** cost code that still carries activity and no forecast is
  counted; deactivating it changes neither count.
- [ ] A project whose only cost codes are **budget-only** (no PO, no actual, no
  forecast) shows the incomplete notice, **"—"** for Cost timed, the badge
  **Unavailable**, and does **not** also say *"No Cost to Complete remains to
  time"* — the two notices never appear together.
- [ ] A project with no cost codes at all (or every code forecast and nothing
  left to time) still shows *"No Cost to Complete remains to time"* without the
  incomplete notice.

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

**Unforecast cost codes suppress (ADR-43)** — using the project from §15m-ix:

- [ ] With one cost code unforecast and **everything else timed**, the headline
  reads **"Cannot be calculated reliably yet"** and the reason list contains
  exactly *"Cost to Complete is incomplete (unforecast cost codes)"*.
- [ ] If the projected position goes negative, the **lower bound** line still
  appears beneath the reasons ("Lower bound only: at least … in …"); if it never
  goes negative, no figure is shown.
- [ ] Save **0** (or a value) on that code → the headline peak funding figure (or
  "No funding shortfall projected") returns, and its **amount and month are
  identical** to what the lower bound showed — suppression changes presentation,
  never the computed trough.
- [ ] The chart's peak marker follows the same rule: no authoritative marker
  while suppressed, marker back once every code is forecast.
- [ ] The monthly table's figures do not change at any point in this sequence.

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

**Loading is not a zero — the three late gates (ADR-43).** The page's single
*"Loading cash and forecast records…"* placeholder now also waits on Supplier
Credit Notes, Retention Releases and the Commercial Baseline. On a project that
has a posted credit note, a posted retention release and an established
baseline:

- [ ] Throttle the network (DevTools → Slow 3G) and open Cash Flow. The
  placeholder stays until **every** source settles; at no point does the page
  flash a Forecast Cash Out, Remaining Payable, Actual or Forecast Final Cost
  figure that then changes, nor a momentary *"No commercial baseline"* notice or
  a *"revenue basis unavailable"* suppression reason that then disappears.
- [ ] Switch between two projects from the Cash Flow tab: the placeholder shows
  during the switch and the first figures rendered are the new project's final
  figures.
- [ ] The three **error** behaviours are unchanged: a failed credit-note,
  release or baseline read still shows its named *unavailable* banner / notice
  — never the loading placeholder forever, and never a zero.

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
- [ ] **Due → Overdue only** shows exactly the activities counted by the
  **Overdue** card; no completed or cancelled activity appears, and an activity
  due **today** does not appear.
- [ ] **Due → Due within 14 days** shows exactly the **Due next 14 days** count;
  it includes an activity due today and one due in 14 days, and excludes
  overdue work. The hint under the filters explains the active window.
- [ ] Due combines with Search, Status and Responsible (each narrows further);
  **Due + Status = Completed** is empty by design.
- [ ] With any filter active, a line reads *"Showing N of M activities"* with a
  working **Clear filters** link that also resets **Due**.
- [ ] There is **no filter builder** — exactly five controls.
- [ ] **Midnight rollover:** leave the Timeline (and the Dashboard) open across
  local midnight, or put the laptop to sleep and wake it the next day — an
  activity due "today" moves to **Overdue** without a reload (also on tab
  refocus).

### 15p-vii-b. Quick status actions (ADR-46)

- [ ] As **admin/PM**, a not-started activity offers **Start today** and **Put
  on hold**; Start sets *In progress* with today's actual start and nothing
  else changes.
- [ ] An on-hold activity with an actual start offers **Resume** (actual start
  unchanged) and **Complete today**; one with **no** actual start offers only
  **Start today** — completing requires Edit.
- [ ] **Complete today** sets *Completed*, 100% and today's actual finish.
- [ ] An open milestone offers only **Mark reached today**; completed milestones
  show 100% and no actual start is added.
- [ ] Completed and cancelled activities show **no** quick action.
- [ ] As **QS**, no quick action appears (read-only).
- [ ] Mobile (375px): the quick buttons sit above Edit/Cancel, ≥44px, wrap.
- [ ] While one action saves, the buttons show *Saving…*/disabled; the outcome
  is announced in the message strip (dismissible).

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
  field. This is expected for the **full editor** (last-write-wins) — confirm
  `updatedAt`/`updatedBy` reflect the second writer.
- [ ] **Quick action guard:** open the Timeline in two browsers; in browser A
  edit an activity; in browser B, *before* its list refreshes (e.g. offline
  then online, or quickly), click a quick action on that activity — it is
  refused with *"Someone else changed this activity…"* and nothing is written.
- [ ] **Offline quick action:** go offline and click a quick action — it is
  refused as offline and is **not** applied later on reconnect.
- [ ] Simulate a read failure (e.g. sign in as a denied role): the page reports
  the programme as **unavailable, not empty**, and never shows a false "no
  activities" state.

### 15p-xii. Responsive

- [ ] **375px:** no Gantt; grouped cards; Edit/Cancel buttons full-width and
  ≥44px; filters stack; modals scroll internally and fit; no horizontal page
  scroll.
- [ ] **768px:** Gantt and table appear; filter grid goes two-up; modal centred.
- [ ] **1280px:** four summary cards in one row; five filters in one row; table
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
  BOQ, RFIs and — since ADR-56 — Cost Codes, Budget Lines, Purchase Orders
  and Progress Claims** all show no data — reads are blocked by rules, not
  merely absent from the nav. **AUTOMATED for the four ADR-56 collections —
  see §0** (`externalRoles.rules.test.js`).
- [ ] The same user **can** still read the company's Projects (name, status,
  currency), Drawings and project-visibility Documents — the remaining
  member-readable set, still **company-wide, not project-scoped** (Deferred
  Control 20; external onboarding stays NOT SAFE until M2-A2).
  ⚠️ **Correction (ADR-56):** until 27 October 2026 this item stated that the
  same user could read Cost Codes, Budget Lines, POs and Progress Claims "by
  intent". That was the confirmed P0 exposure, not product intent; it is
  removed by ADR-56 and must never be re-recorded as expected behaviour.
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
  uniqueness are client-enforced only **on `progressClaims` and
  `variations`**. **Exception:** `clientInvoices`, `clientReceipts`,
  `supplierPayments`, `supplierCreditNotes`, `retentionReleases`, **since
  ADR-40 `supplierInvoices`, and — since ADR-57 (M2-B1, live since 27 October 2026) —
  `purchaseOrders`** enforce transitions and post-commit immutability
  **by rules** — see §15i-x, §15j-x, §15k-x, §15r-x, §15q, **§13f** and **§33**,
  which test them as real rejections. The PO **cancellation policy** (no
  non-rejected claim / non-cancelled invoice) stays client-only (DC35). ⚠️ The consequence recorded here is now **closed**: a
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

---

## 18. Beta Launch Readiness

Manual acceptance for the Beta Launch Readiness increment. Nothing here is
covered by the emulator suite; the structural parts (table wrappers, hidden
navigation, no fabricated Dashboard literals) are pinned by
`tests/unit/betaSurfaces.test.js`, which is a source-structure guard, not a
render test.

### 18a. Password reset

- [ ] `/login` → **Forgot password?** opens a real form (email field, Send reset
      link button), not a "coming soon" card.
- [ ] A **real** beta account: submit → success message → the reset email
      actually arrives → the link opens Firebase's hosted confirmation page →
      set a new password → sign in with it.
- [ ] An **unknown but well-formed** address: submit → the **identical** success
      message. ⚠️ Any difference in wording, timing or error state between this
      and the real account is an account-enumeration leak and a defect.
- [ ] A **malformed** address that clears the browser's `type="email"` check
      (e.g. `a@b`) → inline "That email address doesn't look right."
- [ ] Repeated rapid submissions → "Too many attempts. Please try again later."
- [ ] **Back to sign in** works from both the form and the success state.
- [ ] Layout matches Login at 375px: 44px submit target, no overflow.

### 18b. Login — no dead signup affordance

- [ ] The Login page shows **non-clickable** copy ("No account? Constrapp
      accounts are set up for you — contact your company admin"), not a link.
- [ ] `/create-account` typed directly still renders its existing stub page —
      the route was kept deliberately.

### 18c. Dashboard — nothing fabricated (updated by Dashboard Analytics, ADR-42)

> **Superseded in layout by Premium Dashboard v2 (ADR-45, §22).** The
> "nothing fabricated" intent below still holds; the specifics changed: the two
> counts now live in a Portfolio card (shown as "—"/Unavailable until projects
> load), the snapshot adds a plain-SVG Budget, cost & revenue chart and a
> Programme donut (activity counts, no %), and the register is a table from
> `lg:` and cards below. Still: no Pending POs / Budget Utilization / Upcoming
> Tasks, no 72%, no portfolio money.

- [ ] **No fabricated chart.** No "Project Financial Overview" bar chart, no "Task
      Progress" donut, no 72% figure anywhere. The only visual is the Project
      Snapshot's cost-composition bar (§18h).
- [ ] Exactly **two** KPI cards: **Active Projects** (with an "N total" sub) and
      **Total Projects**. No Pending POs, no Budget Utilization, no Upcoming
      Tasks, and no "placeholder data" caption.
- [ ] Active Projects equals the number of projects whose status is
      **In Progress**; Total equals the full project count. Change a project's
      status → both update live.
- [ ] **Projects by status** shows Planning / In Progress / Backlogged / On Hold /
      Completed counts that sum to Total Projects. No money in the strip.
- [ ] The table is headed **Projects** (not "Active Projects") and lists **every**
      project, which is what makes that heading honest.
- [ ] Row values are real: name, location, status badge, **Headline Budget** in
      the **project's** currency, reported **Progress** bar + %, **Currency**
      code, start date. No per-project financial column.
- [ ] Loading shows "Loading projects…"; a genuinely empty company shows "No
      projects yet"; a **failed** project read shows **"Projects unavailable"**
      — never "No projects yet".
- [ ] Welcome line shows the real profile name and company name.

### 18d. Responsive tables — 375 / 768 / 1280px

At **375px**, for each of Dashboard, Projects, Project Budget and Project Cost
Codes:

- [ ] The table **scrolls horizontally inside the card** — it is not clipped and
      the page body does not scroll sideways.
- [ ] The **last column is reachable** by scrolling: Actions on Dashboard,
      Projects and Cost Codes; the row-action cell on Budget.
- [ ] No column is crushed to unreadability; no text overlaps the card edge.
- [ ] At 768px and 1280px the tables look unchanged from before this increment.

### 18e. Navigation — nothing unbuilt is offered

- [ ] Sidebar shows **Dashboard, Projects, Contacts, Subcontractors** only. No
      PULSE™, no SHIELD™, and no animated "live" dots.
- [ ] The project tab bar has **no Photos and no Reports** tab; every other tab
      is present and lands on its live page.
- [ ] Typing `/pulse`, `/shield`, `/projects/{id}/photos`, `/projects/{id}/reports`
      still renders the existing placeholder pages — hiding is not deleting.
- [ ] The TopBar has **no search box** and **no notification bell / red unread
      dot**. The user menu still opens and Sign out still works.
- [ ] Subcontractors shows the contacts table with **no Constrapp IQ™ "Coming
      Soon" card** beneath it.
- [ ] No "Sprint 3 / 4 / 5" text appears anywhere a beta user can reach.

### 18f. Error boundary

- [ ] Temporarily add `throw new Error('boundary check')` at the top of a page
      component (e.g. `pages/Projects.jsx`), run `npm run dev`, and open it.
- [ ] A styled Constrapp fallback appears — "Something went wrong", neutral copy
      pointing at reload and then the company administrator, and a **Reload
      Constrapp** button.
- [ ] The copy makes **no claim about the user's data**. A render can fail after a
      Firestore write has already committed, so any "your data is safe" wording is
      a guarantee the boundary cannot make — treat it as a defect if it reappears.
- [ ] **No stack trace, error message, component name or file path** is visible
      on screen. The detail appears in the browser console only.
- [ ] The Reload button reloads the app.
- [ ] ⚠️ **Revert the temporary throw** and confirm the app renders normally
      again before considering this checklist complete.

### 18g. Hosting configuration (config review only — do NOT deploy)

- [ ] `npm run build` succeeds and writes `frontend/dist/` with `index.html` and
      a hashed `assets/` bundle.
- [ ] `frontend/firebase.json` has a `hosting` block with `"public": "dist"` —
      correct because `firebase.json` itself lives in `frontend/`.
- [ ] The SPA rewrite `** → /index.html` is present, so deep links survive a hard
      refresh once deployed.
- [ ] `npm run test:rules` still starts both emulators and passes — the Hosting
      block must not disturb it.
- [ ] Nothing was deployed and no rules were published; the release steps live in
      [DEPLOYMENT.md](DEPLOYMENT.md) → Private-Beta Release Checklist.

### 18h. Dashboard Project Snapshot (ADR-42)

Use **Gold Coast apartments** (or any project with budget lines, POs, claims,
posted supplier invoices, a credit note, payments, a retention release and a
commercial baseline). Open its Forecast, Commercial and Commercial → Supplier
Payments tabs in a second tab for comparison. **Save** any Forecast edits first —
the snapshot shows saved forecast inputs only.

- [ ] Heading reads **Project Snapshot · Gold Coast apartments · {currency}**.
- [ ] **Approved Budget, Actual, Remaining Committed, Forecast Final Cost,
      Variance to Budget** equal the Forecast tab's summary cards exactly.
- [ ] **Forecast Gross Profit** and the **Forecast Margin %** beneath it equal the
      Commercial tab.
- [ ] **Remaining Payable** equals Supplier Payments → Remaining Payable.
- [ ] The cost-composition bar's labelled **Forecast Final Cost** equals the card;
      its legend shows Actual / Remaining Committed / Uncommitted Cost to
      Complete; the budget marker sits at the Approved Budget (inside the bar when
      over budget, at its end when under).
- [ ] Variance to Budget is red only when negative.
- [ ] A project with no commercial baseline shows **"Contract value not set"** with
      a **Set contract value →** link to its Commercial tab — never $0 or 0%.
- [ ] A settled project with no records shows real **$0** figures (not "—").
- [ ] Throttle the network (DevTools → Slow 3G) and switch project: figures show
      **"—"** while loading, then settle. **Project A's figures never appear under
      Project B's heading.**
- [ ] Failed source (emulator with one collection denied, or a role change mid-
      session): the dependent figures show **Unavailable** and name the source;
      unrelated cards still show values.
- [ ] **URL:** choosing a project in the picker, or a row's **Snapshot** action,
      sets `?project=<id>` (Snapshot also scrolls to the panel). **Refresh** keeps
      the same project. A bogus `?project=nope` falls back to the first In
      Progress project; no `?project` does the same.
- [ ] An **NZD** project's snapshot heading and every figure show **NZD**.
- [ ] **No portfolio money** anywhere on the Dashboard — no total across
      projects in any currency.
- [ ] Signed in as **subcontractor** or **client**: no snapshot, no picker, no
      Snapshot row action, and **no rules-denied read errors** in the console.
- [ ] **375 / 768 / 1280px:** cards reflow (2 / 3 / 4 columns), the picker and
      links are ≥44px tall, the bar spans the card width, and the register scrolls
      horizontally inside its card with the Actions column reachable.

## 19. Subscription-Hook Migration — keyed snapshot / derived loading (ADR-41)

Eleven hooks moved from the legacy `setLoading(true)`-in-an-effect shape to the
keyed-snapshot pattern. **No page, layout or `lib/` file changed**, and no hook's
public API changed — so anything that breaks here is a subscription-lifecycle
regression, not a feature change.

The two things being proved are: (a) nothing regressed, and (b) a project switch
no longer shows the previous project's rows.

**Migrated:** `useCostCodes`, `useContacts`, `useBudgetLines`, `useForecastLines`,
`usePurchaseOrders`, `useProgressClaims`, `useVariations`, `useSupplierInvoices`,
`useProjects`, `useCompany`, `useProfile`.

⚠️ Run §19.4 (**Unavailable**) at least once. It is the ADR-24 invariant, and it
is the only part of this checklist that a passing app can still silently fail.

### 19.1 Auth / root

- [ ] **Fresh sign in** from `/login` → lands on Dashboard. No white screen, no
      console error.
- [ ] **Company context** loads: company name renders; the Currency Setup Banner
      shows or hides exactly as it did before.
- [ ] **Project list** loads on Dashboard and on `/projects`.
- [ ] **Refresh while signed in**, on `/` → spinner, then Dashboard. No bounce to
      `/login`.
- [ ] **Deep project refresh** — hard-refresh on `/projects/:id/budget` →
      "Loading project…" then the Budget tab. **Never** "Project not found."
- [ ] **Sign out** → `/login`. No stale name or initials in the top bar on the
      way out; no console error.
- [ ] **Sign back in as the same user** → same company, same project list.
- [ ] **Sign in as a different user in a different company** → the previous
      user's profile, company and projects never appear, **not even for one
      frame**.
- [ ] **Role gating** — sign in as `subcontractor` / `client`: the eight
      `profileLoading`-gated pages (Commercial, Cash Flow, Client Invoices,
      Client Receipts, Supplier Payments, Retention, BOQ, Tenders) reach the
      correct access outcome and **never flash "Access denied" before
      resolving**.

### 19.2 Project switching

- [ ] Open project **A** → Budget; note a distinctive figure. Switch to project
      **B** → Budget. **A's rows must never appear under B's header**, not for
      one frame. Expect: loading state, then B's rows.
- [ ] Switch B → A again. Same.
- [ ] Repeat A → B for **Forecast**, **Purchase Orders**, **Progress Claims**,
      **Supplier Invoices** and **Variations**.
- [ ] **Cost Codes stays company-scoped** — switching project must **not** put it
      back into a loading state or re-fetch it.
- [ ] With a read-error banner showing on A (see §19.4), switch to B → the banner
      **clears**; it must not persist into B's load window.

### 19.3 Financial reads — normal path

Per module (Budget · Forecast · Progress Claims · Purchase Orders · Supplier
Invoices · Variations):

- [ ] The register shows the **same rows and totals as before** the change.
- [ ] The loading indicator appears and then resolves. It never sticks — a stuck
      spinner is the key-drift failure (ADR-41 Decision 4).
- [ ] Creating a record makes it appear **live**, without a refresh (proves the
      listener is attached, not just a one-shot read).
- [ ] Editing a draft appears live.

Cross-module:

- [ ] **Project Cash Flow** — every derived figure matches its pre-change value;
      the source-error banner list is empty.
- [ ] **Commercial / Margin** — Current Contract Sum, Forecast Revenue, Forecast
      Gross Profit and Forecast Margin % all match pre-change values.
- [ ] **BOQ** — the BOQ-vs-Budget comparison matches pre-change.
- [ ] **Retention** — held and released figures match pre-change.

### 19.4 Unavailable path ⚠️ (the ADR-24 invariant)

Sign in as a role whose rules deny the collection (e.g. `subcontractor` against
`supplierInvoices`), or block the request in devtools.

- [ ] **Project Cash Flow** names each failed source in its "unavailable" banner
      — **not** a zero.
- [ ] Forecast Gross Profit and Forecast Margin % render **`—`**, never `0`.
- [ ] **BOQ** shows *budget unavailable*, not a zero budget.
- [ ] **Retention** shows *invoices unavailable*, not zero retention held.
- [ ] **RFI detail** shows *Linked variations: Unavailable*, not *None*.
- [ ] The error state **persists** after settling — it must not clear itself back
      into a zero-value register on a later render.
- [ ] The error does **not** flash while switching projects (covered in §19.2).

### 19.5 Other surfaces

- [ ] **Contacts** — register loads; the project-assignment picker lists projects
      and reports no false "unknown assignment".
- [ ] **Cost Codes** — register loads; the picker populates in the PO, Claim,
      Invoice, Variation, Budget, Forecast, BOQ and Cash Flow editors; the
      duplicate-code check still fires on create and on edit.
- [ ] **Dashboard** — the project table loads; "No projects yet" is not left
      showing once data arrives.
- [ ] **Project Overview** — loads for a project with data and for an empty one.
- [ ] **Company Settings** — loads; the currency form's Save stays disabled while
      `projectsLoading`, and the project list for pinning is **complete** before
      Save enables (pinning against a partial list has a financial consequence).
- [ ] 375px / 768px / 1280px spot-check on Budget and Cash Flow — no layout
      change is expected; this confirms none happened.

### 19.6 Loading is not a zero ⚠️

**Three states, three renderings — they must never collapse into each other:**

| state | expected |
|---|---|
| loading | **`—`** (or the page's loading placeholder) |
| read failed | the **unavailable** notice / banner |
| settled and genuinely nil | a real **`0`** |

Watch the window *immediately after a project switch* (throttle the network in
devtools to widen it). On each surface below, the figures must show **`—`**, then
resolve to the correct value. **Seeing `0.00` first is a failure.**

- [ ] **Project Budget** — Budgeted, Committed, Claimed, Actual, Remaining,
      Approved Supplier Variations and Commitment Exposure all show `—` while
      loading; the usage bar is **empty**, not part-filled.
- [ ] **Project Retention** — Retention Held, Released to Date and Total Withheld
      show `—` while loading.
- [ ] **Project BOQ** — Approved Budget and Variance to Budget show `—` while
      loading, with the sub-line "Loading the Approved Budget…".
- [ ] **Project Cash Flow** — the page shows "Loading cash and forecast records…"
      until **all ten** subscriptions settle; no figure renders before that.

Then confirm the three states stay distinct:

- [ ] **Settled and genuinely nil** — on a project with no budget lines,
      Budgeted shows a real **`0`**, never `—`.
- [ ] **Read failed** — as a denied role (§19.4), BOQ still shows the red
      "Unavailable — budget failed to load" sub-line, and Retention still shows
      its unavailable notice with actions disabled. Loading must not have
      swallowed the error presentation.

## 20. Financial Loading & Error Reliability (ADR-44)

Forecast, Commercial and Project Overview must never present incomplete
financial data as authoritative. **Every figure has four renderings:**

| state | expected |
|---|---|
| a source it reads is still loading | **`—`** |
| a source it reads failed | **Unavailable** (amber), naming the source |
| settled, genuinely nil | a real **`$0`** |
| settled | the figure, identical to before this change |

Automated coverage: `tests/unit/financialReliability.test.js` (§0b). There is
no DOM runner, so everything below is manual. Sign in as a financial role
unless stated.

**Simulating a failed read.** The Firestore SDK multiplexes every listener over
one channel, so devtools request-blocking fails *every* source at once — useful
for §20.2 "everything failed", not for single sources. To fail **one** source,
use a local emulator launcher (e.g. `npm run test:credit-notes`) with a
**temporary, local-only** edit to `frontend/firestore.rules` that denies `read`
on that one collection; revert it with `git checkout -- frontend/firestore.rules`
afterwards. **Never publish an edited rules file.**

### 20.1 Loading is `—`, never `$0`

Throttle the network (devtools → Slow 3G) and hard-refresh each tab.

- [ ] **Forecast** — all five summary cards and both supplier-variation cards
      show `—`; the toolbar reads "Loading forecast…" (never "No cost codes or
      commercial activity yet"); the table shows "Loading forecast…"; **Save
      all** is disabled; search/filters are hidden.
- [ ] **Commercial** — after "Loading commercial baseline…", every figure that
      reads a still-loading source shows `—`; no "$0.00" appears first. The
      live Current Approved Budget reads `—` and **Use current approved budget**
      is disabled until budget lines load; **Save baseline** is disabled with
      "Loading client contacts…" until contacts load.
- [ ] **Overview** (baseline established) — the Commercial card row shows `—`
      until its sources settle; the margin never flashes an optimistic figure.
- [ ] **Overview → Project currency** (admin / PM, project with **no**
      `currencyLocked` flag) — the selector and **Save currency** are disabled
      with "Checking this project's financial records…" until every evidence
      source (including Cash Flow Lines) has loaded.

### 20.2 A failed read is Unavailable, never a partial total

For each row, deny ONE collection as described above.

- [ ] **Supplier Credit Notes denied** — Forecast: Actual, Forecast Final Cost
      and Variance read **Unavailable** ("Could not load: Supplier Credit
      Notes"); Approved Budget, Remaining Committed and both variation cards
      still show values; the banner lists the source and carries the credit
      notice saying figures are shown as Unavailable; the table is replaced by
      "Forecast unavailable — could not load: Supplier Credit Notes". Commercial:
      Forecast Final Cost, Forecast Gross Profit, Forecast Margin % and Margin
      Movement are Unavailable; Original Contract Value, Current Contract Sum and
      the client/supplier variation lines still show values. Overview: FFC,
      profit and margin Unavailable; Current Contract Sum still shows.
- [ ] **Forecast Lines denied** — Forecast: FFC and Variance Unavailable, the
      table replaced by the Unavailable panel, **Save all** disabled; no row is
      shown as "Not forecast".
- [ ] **Commercial baseline denied** — Commercial: Original Contract Value,
      Current Contract Sum, Forecast Revenue, profit, margin, Original Approved
      Budget, Original Planned Profit/Margin and Margin Movement read
      **Unavailable**; the amber note says this does **not** mean the contract
      value is unset; there is **no** "Set and save an Original Contract Value"
      prompt; **Save baseline is disabled** with the explanation. Overview: the
      Commercial card row **appears** with Unavailable figures and a note.
- [ ] **Budget Lines denied** — Forecast: Approved Budget and Variance
      Unavailable, table replaced; Commercial: live Current Approved Budget reads
      **Unavailable** and *Use current approved budget* is disabled.
- [ ] **Variations denied** — Forecast: both variation cards Unavailable, FFC
      still shows; Commercial: Current Contract Sum, client and supplier
      variation lines, profit, margin and Margin Movement Unavailable; FFC and
      Original Contract Value still show.
- [ ] **Any lock-evidence source denied** (e.g. BOQ Items) on an unflagged
      project — Overview currency selector stays disabled, naming the source.
- [ ] **Budget page** with credit notes denied — unchanged behaviour (figures
      shown); the notice now says they are calculated **without** credits and
      may be overstated.

### 20.3 A settled zero is a real `$0`

- [ ] On a new project with no records: Forecast shows `$0.00` for Approved
      Budget, Actual, Remaining Committed, FFC and Variance and "No cost codes or
      commercial activity yet."; Commercial shows `$0.00` for Forecast Final Cost
      and the variation lines, and "—" plus the amber "Set and save…" prompt for
      the contract figures (baseline cleanly absent).
- [ ] Once every source settles on a populated project, every figure on all
      three tabs matches its pre-change value (spot-check against the Dashboard
      Project Snapshot, §18h, which is unchanged).

### 20.4 Role gate — no subscription for other roles

- [ ] Signed in as `subcontractor` and as `client`: Forecast shows "Forecast
      data is restricted"; Commercial shows "Commercial data is restricted";
      neither shows any figure.
- [ ] In devtools → Network (or the Firestore emulator request log), opening
      Forecast and Commercial as those roles issues **no** listen request for
      budget lines, POs, claims, supplier invoices, credit notes, variations,
      forecast lines, the baseline **or contacts**, and the console shows no
      `permission-denied` error from these pages.
- [ ] As `qs`: Forecast and Commercial work; Overview shows margin cards but no
      currency card (unchanged).

### 20.5 Project switching never carries unsaved state

The in-app UI has no direct same-tab project switch; use the browser history.

- [ ] Open project **A → Forecast**, type an Uncommitted CTC on a cost code that
      also exists in project B, **do not save**. Navigate to Projects → **B →
      Forecast**. Long-press the browser **Back** button and jump straight to
      **A → Forecast**, then jump forward straight to **B → Forecast**: B shows
      **no** dirty row and **Save all** reads with no count. Nothing was written
      to B (check B's row "Last updated").
- [ ] Same with **Overview → Project currency**: pick a different currency on A
      without saving, jump to B's Overview via history — B's selector shows B's
      own currency.
- [ ] **Within one project**, unsaved Forecast edits survive switching the
      search box and filters, and tab navigation still works as before.

### 20.6 Editing actions wait for complete inputs

- [ ] Forecast: while any row source is loading or failed, **Use remaining
      budget**, row **Save** and **Save all** are unavailable (table hidden or
      buttons disabled). After recovery (reload), unsaved edits made before a
      failure are still present.
- [ ] Commercial: a baseline whose client contact has since been **archived**
      shows that client in the dropdown ("not an active client contact");
      re-saving keeps the stored client name. With contacts denied, the stored
      client still shows, Save is enabled once the read settles, and saving
      keeps the stored client name (never blanks it).
- [ ] Overview: on a project whose `currencyLocked` flag **is** set, the card is
      locked as before regardless of loading (unchanged).
- [ ] 375px / 768px / 1280px: the Unavailable banners, the restricted cards and
      the currency notice wrap without horizontal scroll.

## 21. Login Redesign — split-screen auth layout

Manual acceptance for the split-screen auth shell (`layouts/AuthLayout.jsx`)
that recreates the Constrapp v5 prototype's login. The redesign is **visual
only**: sign-in, reset, session persistence, redirects and the enumeration
protections are unchanged. The structural parts (Firebase calls, guards, routes,
labels, alert role, responsive classes, no demo/pricing/planned-module copy, no
hex) are pinned by `tests/unit/authSurface.test.js`, a source-structure guard,
not a render test.

### 21a. Layout

- [ ] **1280px+**: product panel on the left (logo + wordmark, headline with a
      teal second line, supporting text, five feature rows with icon tiles, the
      Australian-built panel, two faint background circles) taking ≈55% of the
      width; the sign-in panel (≈45%, left border) with the form centred at a
      readable ~420px width. Check 1280px, 1440px and 1660px: no cramped form,
      no large dead space, the teal headline line always on its own line. No horizontal scroll.
- [ ] **1280×800**: the whole page fits without vertical scroll; at shorter
      heights the page may scroll, but the sign-in form stays fully visible.
- [ ] **≥ 900px tall**: spacing opens out to the prototype's rhythm.
- [ ] **768px**: single column — compact logo + tagline, the form on a card,
      footer line. The feature list is hidden. No cramped or clipped content.
- [ ] **375px**: as 768px with 16px gutters. Inputs render at 16px (iOS Safari
      does **not** zoom on focus). With the on-screen keyboard open the focused
      field and the **Sign in** button remain reachable by scrolling.
- [ ] `/forgot-password` and `/create-account` use the same shell at all widths.

### 21b. Authentication unchanged

- [ ] Correct credentials → Dashboard. Back button does not return to `/login`.
- [ ] Wrong password **and** unknown email → the **same** "Incorrect email or
      password." message.
- [ ] Repeated failures → "Too many attempts. Please try again later."
- [ ] Signed in, visit `/login` → redirected to `/`. Signed out, visit `/` →
      `/login`. Refresh while signed in → spinner, never a flash of the login
      page. Sign out → `/login`.
- [ ] Close and reopen the browser → still signed in (persistence unchanged;
      there is deliberately no "Remember me").
- [ ] Re-run §18a (password reset, including the identical-success check for an
      unknown address) and §18b.

### 21c. Accessibility

- [ ] Keyboard only: Tab order is Email → Password → Forgot password? → Sign in;
      each shows a visible teal focus ring. Enter submits.
- [ ] Screen reader: inputs announce their labels ("Email", "Password"); a
      failed sign-in announces the error and the inputs report invalid.
- [ ] One `<h1>` per page ("Sign in" / "Reset password" / "Create Account"); the
      product panel is an "About Constrapp" landmark, the form is in `main`.
- [ ] 200% browser zoom: no overlap, no horizontal scroll.
- [ ] Forced-colors / high-contrast mode: input focus is still visible.
- [ ] Password-manager autofill works for email and password.

### 21d. Product boundaries

- [ ] No demo access, demo-account quick-fill, membership, pricing, or
      "Remember me" anywhere on the three auth routes.
- [ ] No planned module named or implied; no "world-first", "patent-pending",
      "only platform" or "100% Australian-owned" claims.
- [ ] "No account?" guidance is plain text, not a link.

## 22. Premium Dashboard v2 (ADR-45)

Automated: `tests/unit/dashboardV2.test.js` (78 tests) — every new figure equals
its selector (`projectForecastTotals` / `computeMargin`), per-figure loading /
Unavailable / genuine-zero states, missing-baseline and no-original-budget
handling, chart geometry (one scale, over/under budget, negative and zero
cases, rounding clamp, nothing drawn from loading or failed cost sources, a
failed contract removing only its own bar), programme counts equal
`timelineSummary` with no completion %, portfolio counts null until settled,
role gates and keyed children, exactly one added hook, no writes, no money
arithmetic, no chart library / inline style / hex, responsive breakpoints and
44px targets. The ADR-42 invariance and ADR-44 perturbation suites still pass
(the latter now also verifies `uncommittedCostToComplete`).

Manual — three checks only:

- [ ] **Figures, chart and switching.** On a project with budget, POs, invoices,
      a forecast and a commercial baseline (e.g. Gold Coast apartments): the four
      KPIs and the strip equal the Forecast / Commercial / Supplier Payments tabs;
      the chart's three labelled amounts equal Current Contract Sum, Approved
      Budget and Forecast Final Cost, with the budget line inside the cost bar
      when over budget; the Programme counts equal the Timeline tab's summary
      cards. Then, with DevTools → Slow 3G, switch to a project in another
      currency (e.g. NZD): only "—" appears, then that project's figures in its
      currency — never the previous project's — and **Refresh** keeps it selected.
- [ ] **Roles and states.** Signed in as **subcontractor** or **client**: portfolio
      and register only — no snapshot, no chart, no Programme panel, no picker, and
      **no permission-denied errors** in the console. On first load (any role) the
      portfolio counts show "—", never 0, until projects arrive.
- [ ] **Layout.** At **375px**, **768px**, **1280px** and a wide desktop (≥1600px):
      no horizontal page scroll; KPIs reflow 1 → 2 → 4 columns; the chart sits
      beside the Programme panel from 1024px and stacks above it below; the
      register is cards below 1024px (actions ≥44px) and a table above it; the
      picker is full width on mobile.

## 23. Constrapp PULSE™ 1A (ADR-47)

Automated: `tests/unit/pulse.test.js` (282 tests since ADR-49 — two ADR-47 pins revised explicitly, one added) — every indicator × every
dependency × loading / failed / **missing** source → never "no issue";
dependency isolation by perturbation (declared sources move the result,
undeclared and even *failed* undeclared sources do not); every amount equals its
selector (`projectForecastTotals`, `projectForecastRows`, `computeMargin`,
`payablesSummary`, `apAgeing`, `paymentSummary`, the pending-variation totals,
`timelineSummary`) and the Dashboard snapshot is byte-identical for the same
fixture; the `projectForecastRows` extraction ≡ `projectForecastTotals`; saved
0 is a forecast; cent boundaries on variance and profit; contract-not-set vs
loading vs failed baseline; remaining payable with credits, retention
held/released, draft and void payments, partial settlement, unallocated cash and
missing due dates; due-today, completed and cancelled activities; clock
sensitivity; draft vs submitted exposure with no double counting; the engine's
no-arithmetic / no-Firebase / no-score structure; the page's role gate, exact
eleven subscriptions, snapshot-shaped source states, `useLocalToday`, no write
callback, project currency from the outlet, tab/route/pointer wiring, tokens
only, 44px controls, scroller-wrapped tables and collapsed no-issue section.
`npm run test:rules` is unchanged (no rules edit).

Manual — three checks only:

- [ ] **Findings equal their tabs.** On a project with budget, POs, posted
      supplier invoices (at least one past its due date and partly paid), a
      forecast with at least one cost code left blank, a commercial baseline,
      a draft or submitted variation and an overdue Timeline activity: the
      PULSE tab's Approved Budget / Forecast Final Cost / Variance equal the
      Forecast tab; Forecast Gross Profit equals the Commercial tab; each
      past-due row's Remaining payable equals the Supplier Payments register;
      the overdue activities and days late equal the Timeline's **Overdue only**
      filter; pending exposure equals the Variations tab's pending totals.
      "Cost codes not yet forecast" lists exactly the Forecast tab's **Not
      forecast** rows. Save a forecast of **0** on every blank code: that
      indicator becomes *No issue found* and the over-budget / gross-profit
      indicators leave *Needs data* (or keep their finding with the caveat
      gone). Every link opens the named tab.
- [ ] **States and roles.** With DevTools → Slow 3G, open PULSE: every indicator
      shows *Loading* with "—" (no figure, no "no issue") until records arrive;
      then switch to a project in another currency — only that project's
      figures in its currency appear, never the previous project's. Signed in
      as **subcontractor** or **client**: the tab shows "PULSE indicators are
      restricted", no figures, and **no permission-denied errors** in the
      console. Block the `retentionReleases` read (DevTools → network block):
      only *Supplier invoices past due* becomes **Unavailable**, naming the
      source; the other five are unaffected.
- [ ] **Layout.** At **375px**, **768px** and **1280px**: no horizontal page
      scroll; the project tab bar wraps and PULSE sits after Overview; state
      counts reflow 2 → 5; key figures 2 → 4; evidence tables scroll inside
      their card; "Show all N" and every link are ≥44px tall; *No issue found*
      is collapsed until tapped.

## 24. Advanced Module Branding (ADR-48)

Automated: `tests/unit/moduleBranding.test.js` (36 tests) — the four exact full
names (`MODULE_NAMES`); PULSE still the second of 15 tabs and the only one with
a mark; no SHIELD / Quant / IQ tab, sidebar entry or route; `/pulse`, `/shield`
and the project `pulse` route unchanged; the tab renders a static mark with the
shared active styling, unchanged padding, still wrapping and with no animation;
the project name stays the `<h1>` and the module heading an `<h2>`; pink and
cyan exist only as `brand-pulse` / `brand-shield` tokens and no branded file
carries a hex or inline style; pink is never a PULSE status colour; the SVG is
`aria-hidden` + `focusable="false"` with no `<title>`, and the dot is
`aria-hidden`; no emoji mark; the animation token is a continuous 1.8s
heartbeat (the only `infinite` in `@theme`) that animates scale ≤1.25 and a
6–11px token glow but never opacity, its rest frame equals the dot's permanent
static glow, and it is applied once, only via `motion-safe:`, only while not
paused, only to the dot, only on the project PULSE heading, beside its
`BeatToggle`, with no React timer, frame loop or canvas; the toggle is a real
`type="button"` with an action-naming `aria-label` that contains the visible
word, a 44px target, a visible focus outline, a decorative glyph, and is
hidden under reduced motion; the pause state lives in `PulseHeading`, not in
the subscription-owning workspace; no
LIVE / real-time / monitoring / patent / proprietary / AI / score claim; SHIELD
keeps Coming Soon and describes commercial assurance, not safety; no hook,
Firebase import or dependency added, and ProjectPulse still opens exactly
eleven subscriptions. The ADR-47 tab pin in `pulse.test.js` now expects
`mark: 'pulse'`. `npm run test:rules` is unchanged (no rules edit).

Manual — three checks only:

- [ ] **PULSE heading and dot.** Open a project's PULSE tab (financial role):
      the heading reads *Constrapp PULSE™* / *Project health indicators* beside
      a pink heartbeat-line tile; the small pink dot at the tile corner beats
      gently and **continuously** (about one lub-dub every 1.8s), always softly
      glowing and never vanishing or flashing; the heartbeat line itself never
      moves. Every state count and indicator card is as before. Tab to the
      muted **Pause** control and press Enter/Space: the dot stops, still lit,
      and the control reads **Resume**; press again and the beat resumes.
- [ ] **Reduced motion and assistive tech.** DevTools → Rendering → *Emulate
      CSS prefers-reduced-motion: reduce*, reload the PULSE tab: the dot is
      still but still glowing, and the Pause control is not shown. Then, with
      reduced motion off and VoiceOver/NVDA running: the control is announced
      "Pause heartbeat animation, button" (then "Resume heartbeat
      animation"), the tab "PULSE, link" and the heading "Constrapp PULSE™,
      heading level 2" — the mark and dot are not announced.
- [ ] **Tabs and hidden pages at 375 / 768 / 1280px.** The tab bar wraps with
      PULSE (mark + label) after Overview, nothing animates in it, the active
      underline is teal like every other tab, and keyboard Tab/Enter reaches
      and opens it. Typing `/shield` shows *Constrapp SHIELD™* with a static
      cyan shield and no animation (since ADR-50 it is a pointer page naming
      the five checks and linking to Projects — the **Coming Soon** badge this
      step originally checked is gone; see §26); typing `/pulse` shows the
      static pointer page.

## 25. Constrapp PULSE™ 1B — acknowledgement & review (ADR-49)

*Released to production 19 October 2026 (rules published, Hosting deployed,
live behaviour verified).*

Automated: `tests/unit/pulseAttention.test.js` (65 tests) — evidence keys per
indicator (cost-code ids incl. the unbudgeted rows for *over budget*; record
ids for activities / supplier invoices / variations; none for gross profit),
sorted and de-duplicated, unchanged by list order, render order or amounts,
empty for any non-finding, and a malformed stored document (non-list keys,
non-string note or date, missing revision) never throws; the attention matrix (no acknowledgement · covered
· new evidence (wins over a due review) · review date today / past / future ·
clock crossing the review date · unparseable date counts as due · withdrawn ·
keyless finding lapses only by date · cleared records reported but not
reopening); resolution only when the condition disappears (*no longer
present*, no `resolvedAt`; same-id reappearance before the review date reads
as still acknowledged — the documented limitation — while a different record
reopens at once); loading / unavailable / needs-data never acknowledgeable;
**failed acknowledgement read → unknown, never "nobody acknowledged"**; the
200-key limit refuses before any transaction and never truncates; **isolation
— `evaluatePulse` output and `summarisePulse` counts are byte-identical with
an acknowledgement source present and failed**, the hook is in no dependency
list and `lib/pulse.js` never mentions the layer; input validation (note,
500 chars, ISO date, strictly after today); write roles = programme writers
(qs/sub/client excluded); the guarded transactions — first acknowledgement
shape, re-acknowledgement `+1` preserving creation stamps, **stale on revision
mismatch / vanished document / unseen appearance**, pending local revision
never matches, permission / offline / aborted / not-found mapping, no
success before the transaction resolves, withdraw refusals (stale, invalid,
missing) with nothing written; structure (no Firebase / React / money
arithmetic / currency lock / forbidden vocabulary; the rules block carries the
allowlist, limits and `+1`); page wiring (attention derived after
`evaluatePulse`, counts untouched, `canManageAcknowledgements(role)` from the
gated wrapper, keyed-by-project hook, You / Another user, no notification or
assignment surface). `tests/unit/pulse.test.js` (282) keeps every ADR-47 pin
with two revised explicitly: the workspace mounts **eleven sources + the
acknowledgement subscription** (never passed to `evaluatePulse`, mounted only
after the role gate), and consumes **exactly two write callbacks**
(`acknowledgeFinding`, `withdrawAcknowledgement`) with still no financial
write and no Firebase import; the 44px and tokens-only pins now cover
`AcknowledgementPanel.jsx`. Rules: `pulseAcknowledgements.rules.test.js`
(37) — **AUTOMATED, see §0**.

Manual — three checks only (no production commercial record is written; an
acknowledgement is the only write, and it can be withdrawn):

- [ ] **Acknowledge, renew, withdraw.** As **project_manager** on a project
      with at least one PULSE finding: the Findings section shows *Needs
      attention* with "No acknowledgement recorded" and an **Acknowledge**
      button (on *Pending variation exposure*: **Mark as reviewed**). Submit
      with a blank note, then with today's date: each is refused inline
      (`role="alert"`), nothing saved. Save a note and a future date: the card
      moves to **Acknowledged** showing *Acknowledged by You on dd/mm/yyyy ·
      review by dd/mm/yyyy*, the note, the covered-record count — and the
      state badge, headline, figures, evidence table, link and the **state
      counts above are unchanged**. In a second browser as **company_admin**,
      the same card reads *Another user*; **Withdraw** there, then back in the
      first browser the card is *Needs attention — withdrawn by Another user*.
      Re-acknowledge from the first browser; in the second, click **Withdraw**
      on the (now stale) view: refused with "Someone else changed this
      acknowledgement…", nothing changed, and the card refreshes to the
      current acknowledgement.
- [ ] **New evidence and the clock.** With an acknowledged *Programme
      activities overdue*, add another activity with a planned finish before
      today on the Timeline: the PULSE card returns to *Needs attention — 1
      new source record since…* at once; acknowledge again. Set the review-by
      date to tomorrow and change the machine date (or wait): the card reads
      *Review date … has arrived*. Complete every overdue activity: the
      indicator moves to *No issue found* and its management block reads
      **Condition no longer present** with the acknowledgement still shown and
      **no resolution date**. Signed in as **qs**: every management block is
      visible but has **no** Acknowledge / Withdraw button; as
      **subcontractor** or **client**: the tab is restricted as before and the
      console shows no permission-denied error. Block the
      `pulseAcknowledgements` read (DevTools → network block): every finding
      shows **Status unknown** and all six indicators keep their state.
- [ ] **Layout.** At **375px**, **768px** and **1280px**: the acknowledgement
      form stacks (note over date) below `sm:` and sits side by side above;
      every Acknowledge / Mark as reviewed / Withdraw / Save / Cancel control
      is ≥44px tall; no horizontal page scroll; the heartbeat dot still beats
      and **Pause / Resume** still works; *No issue found* stays collapsed.

## 26. Constrapp SHIELD™ foundation — five commercial assurance checks (ADR-50)

Automated: `tests/unit/shield.test.js` (202 tests) — the fixed five-check
contract and currency carry-through; for every check and every declared source,
loading → *loading*, failed → *unavailable* naming the source, missing from
`sourceStates` → *unavailable*, and a failed source on an empty project still
*unavailable* (never *needs data* or *no issue*); dependency isolation
**verified by perturbation** (emptying a declared source changes the check;
emptying, failing or loading an undeclared one changes nothing); the empty
project is *needs data* on all five. Check 1: grouping by supplier id first and
the frozen name only for legacy null-id documents (different ids never combined
by name; a null-id never combined with an id), references normalised exactly as
`duplicateInvoiceWarnings` (a hyphen is a different reference), cancelled
invoices ignored, a draft still joins a group, blank references skipped and
reported, all-blank is *needs data (references missing)*, malformed documents
tolerated, wording "potential duplicates to review". Check 2: only counting
invoices (an inconsistent draft and an approved invoice are never failures);
`invoiceTotals` reconciliation field by field in cents (sub-cent floats pass,
one cent fails); the create path's unrounded-GST artefact is not a finding;
retention reconciles through the same composition; a counted line with no cost
code lists its ex-GST amount; missing/non-numeric data is *malformed* and alone
is *needs data*. Check 3: line and PO-level excess equal
`postedInvoicedByPoLine` / `postedInvoicedByPo` against the PO, exact match is
not excess and one cent is; separate totals never added; approved supplier
variations on the PO are context from `approvedSupplierVariationsTotal`, never
deducted, and submitted or client variations are never context; a ghost line
index is excess against zero; a PO not in the project is "not comparable"
rather than clean. Check 4: exactly the four approved conditions, one row per
related record, draft/pending/cancelled POs with counted cost, closed/cancelled
POs with open claims, two open claims per PO, two active invoices per claim
(one cancelled clears it), rejected/cancelled/committed records raise nothing,
a missing PO renders "Not found". Check 5: rows ARE `allocationExceptions` /
`creditNoteExceptions` / `releaseExceptions` / `overReleasedRows` /
`overReconciledPayableRows(payablesSummary)` outputs, one row per exception
with its module; the invalid credit reduces nothing; voiding clears each
exception. Financial consistency: the Dashboard snapshot is byte-identical
before and after, inputs are never mutated, evaluation is deterministic, every
money value is cent-rounded, every row has a unique id and a source number,
the engine has no GST rate, formula, score, threshold, trend, Firebase or
write. Page wiring (source structure): the financial-role gate wraps the
workspace that alone mounts exactly the seven approved hooks; every source's
loading and error flag reaches `evaluateShield`; no write callback, Firebase
import, transaction or storage; currency from the outlet context only; keyed
outlet and keyed-snapshot hooks; five distinct state renderings; five-row
evidence preview with Show all; static branding and tokens only; the tab sits
third with its mark and the `/shield` pointer opens no subscription.

`moduleBranding.test.js` and `betaSurfaces.test.js` pins revised **explicitly**
(16 tabs; marks `['pulse', 'shield']`; `/shield` is a pointer, no Coming Soon;
`shield` in the shipped-tab list — revised again by ADR-51 to 17 tabs and
`['pulse', 'shield', 'quant']`). No rules change, so no rules test.

Manual — three checks only, all read-only (SHIELD writes nothing):

- [ ] **Role gate and honest states.** As **qs** open a project's **SHIELD**
      tab: the *Constrapp SHIELD™* heading with the cyan tile whose small dot
      glows and gently beats (Pause / Resume beside it; still but lit when
      paused or under reduced motion), five state counts, and five check cards
      each with a state badge.
      On a project with no supplier invoices the first two checks and the
      exceptions check read **Needs data** (never *No issue found*). Block the
      `supplierInvoices` read (DevTools → network block) and reload: every check
      that reads invoices shows **Unavailable — Could not load: Supplier
      Invoices**, and no count reads 0 as if clean. As **subcontractor** or
      **client**: "SHIELD checks are restricted", and the console shows no
      permission-denied error (no subscription was opened).
- [ ] **Traceable findings.** On a project with real records: raise (or find)
      two non-cancelled supplier invoices for one supplier with the same
      supplier reference — *Potential duplicate supplier invoices* lists both
      with their SI numbers, statuses, dates and gross totals, grouped, and the
      caveat says a reissue can match legitimately; **Open Supplier Invoices**
      lands on the register. On a PO whose posted invoices exceed a line,
      *Purchase order over-invoicing exposure* lists the line and the PO total
      separately with the PO value, posted invoiced and excess, and any approved
      supplier variation on that PO in the context column — unchanged on the
      Budget and Forecast pages. Close a sent PO that still has a submitted
      claim: *Commitment records requiring reconciliation* lists the claim
      against the closed PO. Nothing on the Budget, Forecast, Commercial or
      Supplier Payments pages moves at any point.
- [ ] **Layout.** At **375px**, **768px** and **1280px**: the tab bar wraps with
      SHIELD (mark + label, static) after PULSE and the active underline is teal; every
      card's module links and **Show all** / **Show fewer** controls are ≥44px
      tall; each evidence table scrolls inside its own container with no
      horizontal page scroll; *No issue found* stays collapsed; VoiceOver/NVDA
      announces "Constrapp SHIELD™, heading level 2" and each check as a
      level-3 heading, and the shield mark is not announced.

## 27. Constrapp Quant™ 1A — manual drawing measurement (ADR-51)

Automated: `tests/unit/quant.test.js` (118 tests — the runner's count) — lengths and areas against
hand-calculated values (3-4-5 triangle, 3×4 rectangle in both windings, a right
triangle, a concave L-shape), implicit polygon closure and degenerate shapes
(collinear → zero area refused, coincident → zero length refused, bow-tie,
minimum points per kind, the 500-point ceiling), counts without calibration,
calibration in mm and m giving the same metres-per-unit, the implied drawing
scale for PDF pages only, zoom independence (the same sheet position at two
rendered sizes maps to one canonical point; rendered → canonical round trip
leaves the quantity unchanged; fit/zoom bounds; backing-store bounds), the
PDF.js adapter against the committed two-page fixture through the legacy Node
build (two pages; page 1 = 612×792 rotation 0; **page 2 with `/Rotate 90` and a
CropBox = canonical 500×750, rotation 90, origin at user-space (50, 50)**;
scale-2 viewport = 2× canonical; backing store sized and bounded, CSS box
untouched), image intrinsic coordinates, scale changes and review flags
(current → needs review after a recalibration; current quantity doubles while
the original stays explainable; uncalibrated is null never 0; the dialog
demands an acknowledgement), metric conversion incl. squared areas, three-
decimal display with no currency symbol, refusal of NaN/Infinity/zero/negative
inputs, malformed stored records (unreadable → listed, never drawn or summed),
the persisted lifecycle through an in-memory Firestore stand-in (create → edit
geometry → rename → void, each exactly +1; a rename never refreshes the
snapshot; drafts refused before any transaction; permission/offline/unknown
kinds), stale concurrent edits (recalibration, create after recalibration,
edit and void from a stale copy — refused, nothing written), drawing/revision/
page isolation, keyed subscriptions and the keyed project outlet, superseded
and withdrawn revisions (measure on current and superseded, never withdrawn;
the Documents wording reused; a measurement never follows the current
pointer), permission-gated subscriptions (the page gates, only the workspace
mounts hooks), **no financial write and no BOQ quantity change** (no Quant file
imports a financial hook, BOQ write, currency lock or money arithmetic; the
hook touches only the two takeoff collections; the actions write no quantity
field; the rules schema has no quantity/amount/boqItemId key), and PDF worker
loading and cleanup (lazy import of library + matching worker from the same
pinned package, worker wired once, failed load retried, nothing outside the
Quant folder imports pdfjs-dist, render task cancelled / page cleaned up /
document destroyed, bounded render by device class, bytes fetch bounded in
time and naming the CORS prerequisite), the KNOWN rectangles of the
acceptance fixture (page 1: 400 × 300 pt at canonical (100, 392)–(500, 692);
page 2, rotated and cropped: user-space (100, 100)–(700, 500) → canonical
(50, 50)–(450, 650); calibrating the 400 pt edge as 4000 mm gives 12 m² /
14 m / 5 m and 24 m² / 20 m), the exact sheet-status contract in the rules
text (read any; create, re-calibrate and edit only while live; void always),
the viewer's fit-to-width measuring the scroller's content box and rendering
only once measured, and the local acceptance environment (`npm run
test:quant` starts both emulators in exec mode, the child-only opt-ins, the
seed's loopback / credentials / probe refusals, the committed fixture, the
three Quant 1B BOQ items and no budget line, and the app's Storage-emulator
gate that older launchers never set).
Rules: `takeoff.rules.test.js` (64, §0). **Production-incident regressions
(October 2026):** the missing-revision banner is computed only for a selected
drawing whose revisions have settled (no drawing → no banner; loading → the
picker's loading state; a failed revisions read → its own *unavailable*
banner, never *not found*; a genuinely missing revision on a selected drawing
still warns; every input derives from the current drawing id so a switch
carries no stale banner), and `rulesSize.test.js` guards the publish limit.

**Browser verification (October 2026).** The PDF.js adapter (`lib/pdfRender.js`)
and the lazy loader (`pages/project/quant/pdfjsLoader.js`) were exercised in
Chrome through a throwaway Vite harness outside the repo: the worker loaded
from the Vite-served `?url`, both fixture pages rendered, and an SVG overlay
in canonical units sat exactly on the drawn rectangles of the portrait sheet
and of the rotated, cropped sheet (device pixel ratio 1.8, backing store
660 × 855 and 539 × 809). This verifies the adapter and loader in a browser;
the full Quant tab is verified by the manual checks below.

**Local acceptance environment — `npm run test:quant`.** One command starts
the Firestore AND Cloud Storage emulators (`firebase emulators:exec --only
firestore,storage`, so both stop with it), seeds the fixture below with rules
bypassed, and starts Vite on port 5178 with `--mode emulator` and BOTH opt-ins
set for the child process only. Firebase Auth is REAL: sign in with your
normal account (`TEST_USER_UID=<uid> npm run test:quant` seeds another
tester; `TEST_USER_ROLE=qs` seeds the QS-as-author path). Open DevTools →
Console FIRST: the app prints `FIRESTORE → LOCAL EMULATOR 127.0.0.1:8080` and
`STORAGE → LOCAL EMULATOR 127.0.0.1:9199` the moment it loads — **no banners
means you are not on the disposable environment; stop.** The seed refuses to
run unless both emulator hosts are set, loopback and answering, and if
`GOOGLE_APPLICATION_CREDENTIALS` is present. Nothing is written to a file; the
older launchers never set the Storage flag and are unchanged.

**What a restart resets — everything.** `emulators:exec` runs both emulators
in memory with no `--import` / `--export-on-exit`: Ctrl+C discards every
Firestore document and every Storage object — the fixture AND whatever you
calibrated, measured, linked, applied or voided — and the next start re-seeds
exactly the fixture below (deterministic ids; `setDoc` overwrites, so a
re-run against live emulators resets the seeded documents and leaves other
documents alone). This is deliberate: every acceptance run starts from a
known state, and nothing can be mistaken for production. The only state that
survives is in your browser: the Quant tab remembers its sheet per project in
sessionStorage (ADR-52 Decision 9) — a restored id that the fresh seed does
not contain is simply not selected. *Assessed, not implemented (needs
approval):* the smallest safe opt-in for a resumable session is an
environment variable, e.g. `QUANT_STATE_DIR=.emulator-state npm run
test:quant`, under which the launcher adds `--import=<dir>
--export-on-exit=<dir>` and skips the seed when the directory already holds
an export (so a resumed session is exactly what you left, and a fresh
directory is exactly the fixture); the directory must be git-ignored and
the default, with the variable unset, must stay disposable.

**If a sheet stays at *Loading sheet…*** (and a measurement card offers only
*Show* and *Void*), the Storage emulator is not answering: the viewer's
`getDownloadURL` retries for up to two minutes before it reports an error, and
without the sheet's geometry nothing is measurable, so *Details*, *Geometry*
and the tools stay hidden by design. Seen in a `test:quant` session left
running for a day: the Storage emulator had exited while Firestore and Vite
kept serving, and its port answered the CORS preflight with 503 and then
refused connections. Stop with Ctrl+C and start `npm run test:quant` again.

Seeded (all ids deterministic; tenant `2Vf3CVuYE8wWzg8hLjR5` "Apex Builders";
project `quant-takeoff-test` "Quant Takeoff Test Project", AUD, no money):

| Drawing | Revision | Status | File | Known dimension → expected result |
|---|---|---|---|---|
| A-101 Ground Floor Plan (`quant-drawing-a101`) | B (`quant-rev-a101-b`) | current | PDF, 2 pages (`quant-two-page.pdf`) | p.1: 400 × 300 pt rectangle labelled 4000 × 3000 mm — calibrate the bottom edge as 4000 mm → area **12 m²**, perimeter **14 m**, diagonal **5 m**. p.2 (rotated 90°, cropped): 600 × 400 pt rectangle, shown 400 wide × 600 tall — calibrate the short edge as 4000 mm → area **24 m²**, perimeter **20 m** |
| A-101 | A (`quant-rev-a101-a`) | superseded | PNG 800 × 600 | calibrated (400 px = 4000 mm) with one seeded length — measurable, warned |
| A-101 | P1 (`quant-rev-a101-p1`) | withdrawn | PNG 800 × 600 | calibrated with one seeded length — inspect or void only |
| A-201 Site Plan (`quant-drawing-a201`) | A (`quant-rev-a201-a`) | current | PNG 800 × 600 | **calibrated** (400 px = 4000 mm); one **active area** seeded (`quant-seed-m-a201-area`, *Slab edge formwork (seeded, linked to 2.1)*) — the 400 × 300 px rectangle (outer edges x 200–600, y 150–450) = **12 m²**, on 04-100 Formwork, **linked to BOQ 2.1**; the perimeter drawn as a length = **14 m** |

Cost codes: 03-100 Concrete (m3) · 04-100 Formwork (m2) · 08-100 Doors (no).
Since Quant 1B (ADR-52) three BOQ items are seeded (§28 lists them) and the
A-201 area above is already linked to 2.1; measuring on the Quant tab still
changes none of them — the §27 checks below hold unchanged (use A-101 Rev B,
the PDF, or draw further measurements on A-201). `moduleBranding.test.js` and `betaSurfaces.test.js` pins revised
**explicitly** (17 tabs; marks `['pulse', 'shield', 'quant']`; the `/quant`
pointer; `brand-quant` token; `pdfjs-dist` the one added dependency, pinned).

Manual — three checks only, on `npm run test:quant` (Quant writes measurement
records; it never writes a BOQ item):

- [ ] **Calibrate, measure, persist, return.** As **qs** open a project's
      **Quant** tab: the *Constrapp Quant™ · Manual quantity takeoff* heading
      with the lime tile whose dot glows and gently beats (Pause / Resume
      beside it; still but lit when paused or under reduced motion). Choose a
      drawing with a **PNG or JPEG** revision (needs no CORS) — the sheet
      renders, Fit width / Fit page / − / + work and the overlay stays aligned
      with the image at every zoom. **Calibrate**: tap two ends of a known
      dimension, enter it (e.g. `3600` mm) — the dialog shows metres per page
      unit; save. **Length**: tap two points, *Finish*, label it, choose a cost
      code, save — it appears in the list with its quantity in **m** and
      *Current scale*. **Area**: three or more taps, *Finish*, save — **m²**.
      **Count**: three taps, *Finish*, save — **3 no.**, *No scale needed*.
      Reload the page: all three are drawn and listed with the same
      quantities. Open the **BOQ** tab: **no item's quantity changed** and the
      BOQ total is identical. As **subcontractor**: "Quant takeoff is
      restricted" and no permission-denied error in the console.
- [ ] **Re-calibration review and stale refusal.** On that page press
      **Calibrate** again, pick two points, enter a distance that halves the
      scale — the dialog refuses to save until the acknowledgement box is
      ticked; save. Every length and area now reads **Needs review — scale
      changed** with its new quantity and *was …* the previous one; the count
      is untouched. *Mark reviewed* on one measurement → *Current scale*. Edit
      another's geometry (drag a handle, *Save geometry*) → re-measured under
      the current scale. Open the same project in a **second tab**, rename a
      measurement there, then in the first tab rename the same measurement:
      the first tab reports *Another user changed this record since you loaded
      it* and nothing is overwritten. Void a measurement with a reason — it
      moves to *Voided* and is no longer drawn; without a reason the dialog
      refuses.
- [ ] **Revisions, PDFs and layout.** On A-101 select revision **A
      (superseded)**: the SUPERSEDED banner (Documents wording plus the
      historical sentence) shows, the seeded length is listed and *Details /
      Geometry / Void* are offered; select **P1 (withdrawn)**: the banner says
      measurements can be inspected or voided only, every tool is disabled, the
      seeded length is listed with *Show* and *Void* only, and voiding it with
      a reason succeeds. Select **B (current, PDF)**: page 1 renders upright;
      ‹ › moves to page 2, which displays as a 400-wide × 600-tall sheet (the
      PDF's rotation and CropBox applied) with its labels readable; calibrate
      the short edge as 4000 mm and the rectangle measures **24 m²**. On a
      production bucket without CORS the same revision reads *"The PDF could
      not be downloaded for measuring…"* within 20 seconds and names
      `docs/DEPLOYMENT.md` — PNG revisions still work. At **375px**, **768px** and
      **1280px**: the tab bar wraps with **Quant** after SHIELD, tools are
      ≥44px, one-finger scroll pans the sheet while a tap adds a point, the
      list becomes cards below `md`, and VoiceOver/NVDA announces "Constrapp
      Quant™, heading level 2" with the scale-rule mark not announced.

## 28. Constrapp Quant™ 1B — measurement → BOQ linkage and explicit apply (ADR-52)

Automated: `tests/unit/quantBoq.test.js` (59), `tests/unit/boqActions.test.js`
(21), `tests/unit/dialogFocus.test.js` (11) and `tests/unit/quantSelection.test.js`
(14) — see §0b; `tests/rules/takeoff.rules.test.js` #57–#64 and the twelve
Quant 1B tests in `tests/rules/boqItems.rules.test.js` — see §0, including the
REAL `lib/boqActions.js` transactions against the emulator (stale refused, the
ratchet engaged for a QS, a denied role, legacy stamps) and the two DC33
gap-proofs. Four Quant 1A pins were revised explicitly (`quant.test.js`,
`moduleBranding.test.js`): the workspace may READ BOQ items; no Quant file may
call a BOQ write; the measurement schema gained exactly `boqItemId`; the copy
now says applying is the BOQ tab's explicit step. Lint 0/0.

**Seeded BOQ items (`npm run test:quant`, in addition to §27's fixture; 2.1 is
already linked from the seeded 12 m² area on A-201 Rev A — the deterministic
Quant 1B case — the other two are unlinked; the project is seeded with
`currencyLocked: false` although a priced item exists, so the first priced BOQ
write engages the ratchet — itself a check):**

| Item | Cost code | Unit | Qty | Rate | Expected behaviour |
|---|---|---|---|---|---|
| 2.1 Formwork to slab edge (`quant-boq-formwork-m2`) | 04-100 Formwork | m2 | 10 | $85.00 → $850.00 | **Quant (1)** from the start: the seeded 12 m² area; the dialog proposes **12 m² / $1,020.00**. Offered to further AREA measurements on 04-100 |
| 2.2 Concrete in slab on ground (`quant-boq-concrete-m3`) | 03-100 Concrete | m3 | 24 | $310.40 | **never offered** — m³ is incompatible with every Quant kind |
| 8.1 Internal doors, flush panel (`quant-boq-doors-no`) | 08-100 Doors | no | 0 | unpriced | offered to COUNT measurements on 08-100; applying changes the quantity only, no amount |

Manual — three checks only, all on the emulators (nothing here touches
production; Quant 1B writes exactly one BOQ item per confirmed apply):

- [ ] **Link and apply.** As **qs** open A-201 Rev A (PNG, current): it is
      already calibrated and lists *Slab edge formwork (seeded, linked to
      2.1)* — **12 m²**, *Current scale*, **BOQ item** column *2.1 · Formwork
      to slab edge*. Open its **Details**: the *BOQ item* select shows **2.1 ·
      Formwork to slab edge · m2 · qty 10** and nothing on another cost code
      (choosing 03-100 lists no item because 2.2 is m³); cancel. Switch to the
      **BOQ** tab and back to **Quant**: A-201 Rev A page 1 is still selected
      (ADR-52 Decision 9); reload the browser tab: still selected. On the
      **BOQ** tab row 2.1 offers **Quant (1)**; the dialog
      lists the measurement with *A-201 · Rev A · p.1*, **12 m²**, *Current
      scale*; Proposed change reads existing **10 m2** → proposed **12 m2**,
      difference **+2 m2**, rate **$85.00 (unchanged)**, amount **$850.00 →
      $1,020.00**; *Latest Quant application: No Quant application recorded*.
      Tick the confirmation, **Apply 12 m2**: the row now shows **12** with
      *Quant applied <today>*, BOQ Total (priced) rises by $170.00 and the
      Formwork comparison row moves by the same; **Budget, Forecast, Cash
      Flow and Commercial pages are unchanged**; the project document is now
      `currencyLocked: true`. Reopen *Quant (1)*: *Matches the current
      measurements*, confirmation disabled with *The measured total already
      equals the BOQ quantity*. Now drag one corner of the rectangle so the
      area stays 12 m² but the shape differs (e.g. 300 × 400 → 400 × 300 px),
      *Save geometry*: the dialog reads **Outdated — the linked measurements
      changed** although existing and proposed quantity are both 12 — the
      fingerprint, not the total, decides. Draw a **Count** of 3 on 08-100 Doors linked
      to **8.1**; apply → quantity **3**, *Unpriced — no monetary amount is
      calculated*, BOQ total unchanged.
- [ ] **Blockers, evidence change and stale refusal.** On A-201 re-calibrate
      with a halved distance (tick the acknowledgement): the BOQ dialog for
      2.1 now shows the measurement as **Needs review — scale changed**, lists
      it under *1 measurement blocks applying* with its remedy, and the
      confirmation is disabled (*Resolve every blocker below*). *Mark reviewed*
      on the Quant tab → the dialog (left open in another tab, or reopened)
      shows the eligible total again; if it was open and confirmed, the amber
      *changed while this dialog was open — review the updated result and
      confirm again* notice appears and the box is unticked. On A-101 select
      Rev **A (superseded)** and link its seeded length to a new `lm` item on
      04-100 (create one first): the dialog says **Not on the current
      revision** and blocks. Edit the linked area's **cost code** to 03-100 in
      the Quant editor: the picker clears with *The BOQ item link was cleared
      because the cost code changed*; save — the BOQ column reads *—* and 2.1
      loses its *Quant (n)*. Finally open 2.1's dialog in **two tabs**, apply
      in the first, then apply in the second: the second reports *Another user
      changed this BOQ item since you loaded it* and nothing is written; the
      same message appears if a manual **Edit** was saved in another tab first.
- [ ] **Roles and layout.** As **project_manager** and **company_admin** the
      link picker and *Quant (n)* behave exactly as for qs. As
      **subcontractor**: *Quant takeoff is restricted*, *The BOQ is
      restricted*, and **no permission-denied error** in the console. With the
      BOQ read failing (deny `boqItems` reads in the emulator rules
      temporarily): the Quant editor's picker reads *BOQ unavailable — linking
      disabled*, the list column reads *BOQ unavailable* (never *—*), and the
      BOQ tab shows its failed-to-load card rather than zeros. At **375px**,
      **768px** and **1280px** the apply dialog scrolls within the viewport,
      its measurement table scrolls horizontally, every control is ≥ 44 px,
      the confirmation checkbox is reachable by keyboard (Tab → Space → Enter
      on Apply), the dialog panel takes focus when it opens, **Tab from the
      Apply button lands on the × close button and Shift+Tab from × lands on
      Apply** (focus never reaches the page behind the overlay), **Escape
      closes the dialog** and the *Quant (1)* button has focus again after
      Escape or Cancel (while *Applying…* is shown Escape does nothing, like
      the disabled Cancel), *Existing amount* and *Proposed amount* read with
      cents (**$850.00 → $1,062.50** for 10 → 12.5 m² at $85), and
      VoiceOver/NVDA announces *Apply Quant measurements · 2.1 · Formwork to
      slab edge, dialog*. On the Quant tab at **375px** a measurement card with
      *Needs review* shows the badge and *Mark reviewed* on one line and
      *Show · Details · Geometry · Void* as one row of equal 44px cells (no
      wrapped third line; Void in red; a visible outline when tabbed to); at
      **768px** and **1280px** the table row's inline actions are unchanged.

## 29. Constrapp Quant™ 1C — manual takeoff reliability, interaction, summary and traceability (ADR-53)

Automated: `tests/unit/quantInteraction.test.js` (59, stage 1C-A) and
`tests/unit/quantSummary.test.js` (39, stage 1C-B) — see §0b; five pins in
`quant.test.js` and two in `quantBoq.test.js` revised explicitly for 1C-A,
one more in `quant.test.js` for 1C-B (§0b). The rules suite is unchanged (no
rule changed; `firestore.rules` is byte-identical to the 1B release) and still
runs as the gate. Lint 0/0. Unit total **3250 across 49 files**. **Live in
production since 23 October 2026** — merged, Azure CI passed, Hosting deployed,
the product owner's live smoke checks passed that day; the checks below were
the acceptance for that release and remain the regression script.

**Nothing below the UI changed:** no collection, field, rule, BOQ write,
evidence fingerprint, selector, drawing write or dependency. A production
document that already holds a crossed polygon is not altered — it is read as
*cannot be derived* and blocked from apply until its geometry is corrected.
The project summary stores nothing and reads nothing new.

Manual — **1C-A**, three checks, on `npm run test:quant` (the §27/§28 fixture;
nothing here writes a BOQ item except where §28 already does):

- [ ] **Crossed outlines are refused, named, and blocked — and corrected
      without starting over.** As **qs** on A-201 Rev A (calibrated PNG) choose
      **Area** and tap four corners in a figure-of-eight order (top-left,
      bottom-right, top-right, bottom-left): the draft strip shows *The outline
      crosses itself…*, **Finish is disabled**; *Undo* the last point and tap
      the correct corner — Finish enables and the preview reads **12 m²**.
      Save it. Now open its **Geometry**: drag one corner across the opposite
      edge — the edit strip turns red with the same sentence and **Save
      geometry is disabled**; **Undo** restores the square. Tap the middle of
      the top edge — a fifth point appears there (*Point 2 selected*); drag it
      upward: the quantity rises live. Tap that point, press **Remove point**
      (or Delete) — back to four. **Cancel** — the saved shape is untouched.
      To see an EXISTING invalid record: with the emulator rules bypassed
      (`withSecurityRulesDisabled` in a one-off script, or the Firestore
      emulator UI) set a stored area's `points` to `[{x:0,y:0},{x:300,y:0},
      {x:100,y:400},{x:300,y:400}]`: its row reads **—** with *The outline
      crosses itself — move or remove the crossing points in Geometry*, the
      page total says *1 needs attention*, and on the **BOQ** tab the item's
      *Quant (n)* dialog lists it under **Quantity cannot be derived** with
      Apply disabled. Fix it through Geometry (drag the third point back to
      the corner) — the row, the total and the dialog recover; the BOQ item's
      quantity never changed by itself.
- [ ] **Unsaved work survives; discarding asks once; the page box commits
      once.** Start a **Length** with two points and do NOT finish. Switch to
      the **BOQ** tab and back to **Quant**: the same sheet is selected, the
      two amber points and the Length tool are back, and a notice says your
      unsaved work was restored. Reload the browser tab: the browser prompts
      (cancel it, or accept — the draft is back either way). Now change the
      **Revision** select: a confirmation asks before discarding; **Cancel**
      keeps the draft and the select snaps back; **OK** discards it. With a
      clean sheet, changing drawing / revision / page / tool asks nothing. On
      A-101 Rev B (two-page PDF) type **2** in the page box without pressing
      Enter — nothing happens until Enter or Tab; type **12** and press Enter —
      it clamps to page 2 directly (never page 1 first); type `abc` — the box
      resets to the current page. Open **Geometry** on a measurement, drag a
      point, switch to the BOQ tab and back — the edit session is restored
      with your moved point; in a second browser tab rename that measurement
      (its revision moves on), then reload the first tab — a notice says the
      geometry edit was dropped because the measurement changed, and nothing
      was written. While *Saving…* is shown on any dialog, Escape and the
      backdrop do nothing and the × is disabled.
- [ ] **Select, pan, zoom and touch at 375px, 768px and 1280px.** With
      **Select** active click a saved area's edge on the sheet — the shape turns
      `brand-accent`, its row highlights and scrolls into view, and the
      selection bar offers Details / Geometry / Void / Clear; click inside a
      small room drawn within a larger area — the room is selected, not the
      floor; click empty sheet — cleared. Drag with the mouse in Select — the
      sheet pans (grab cursor) and no point is placed; in **Length** a mouse
      drag places nothing and a click places a point. **Ctrl/⌘ + wheel** over a
      corner of the drawn rectangle — that corner stays under the cursor while
      the sheet zooms in and out; plain wheel scrolls; the toolbar **−/+** zoom
      about the centre; the overlay stays exactly on the bitmap at 25 % and
      800 %. On a touch device (or DevTools touch emulation): one finger pans in
      every tool, a tap adds a point, two fingers pinch about their midpoint
      and lifting one finger does not add a point; in Geometry a vertex is
      picked up within a fingertip (22 px) of it even at 800 %, two close
      handles never both move, and the selected vertex shows its dashed target
      ring. Keyboard: open **Calibrate**'s dialog — focus is in the distance
      field, Tab cycles inside the dialog and never reaches the page, Escape
      closes it and focus returns to the Calibrate button; the same for
      Details and Void; VoiceOver/NVDA announce *Calibrate this page, dialog* /
      *Edit measurement details, dialog* / *Void measurement, dialog*. As
      **subcontractor**: *Quant takeoff is restricted*, no console error.
      **Budget, Forecast, Cash Flow and Commercial are unchanged throughout.**

Manual — **1C-B**, three checks, on the same fixture (the seed has A-101 Rev B
current with no measurements, A-101 Rev A superseded with a seeded length,
P1 withdrawn with a seeded length, and A-201 Rev A with the 12 m² area linked
to 2.1):

- [ ] **Totals never mix and historical stays apart.** As **qs** on the Quant
      tab press **Project summary**: *Current & valid · 1* (the A-201 area),
      *Historical · 2* (the Rev A and P1 lengths), *Needs attention* counts
      only what is wrong, and the *Current & valid — project totals* panel
      shows Length **—**, Area **12.000 m²**, Count **—** while the
      *Historical* panel shows the two lengths under Length only — no cell
      ever adds m, m² and no. together and no single "project total" exists.
      *By cost code* lists 04-100 Formwork with 12.000 m² under Area and
      nothing under Length; *By drawing* lists A-101 (Rev B · current first,
      then Rev A · superseded / P1 · withdrawn with their lengths under the
      historical cells) and A-201. Draw a **Length** of 5 m on A-201 without
      linking it and a **Count** of 3: the current panel reads Length
      **5.000 m**, Area 12.000 m², Count **3 no.**, and the attention list
      names both as *Not linked to a BOQ item* while *Current & valid* rises
      to 3 — unlinked is valid work. Re-calibrate A-201 with a halved
      distance: the area and length move to *Needs review — scale changed*,
      the current totals drop to Count 3 no. only, and nothing is summed from
      them. With the Firestore emulator stopped mid-session the summary reads
      *A required source failed to load* — never zeros, never "nothing needs
      attention".
- [ ] **Open from the summary lands on the exact sheet, or explains.** In the
      attention list press **Open** on the seeded Rev A length: the workspace
      switches to Measure, the picker shows A-101 · Rev A (superseded, with
      its banner), page 1, the length is highlighted on the sheet and its row
      is highlighted and scrolled into view, and the notice reads *"…" is
      selected on this sheet*. From the *By drawing* table press **Open
      sheet** on A-101 Rev B p.2: page 2 of the PDF opens with nothing
      selected. Open the P1 (withdrawn revision) length: it opens as inspect-
      or-void-only, exactly as choosing P1 in the picker does. Void a
      measurement, then press **Open** on it in the Voided list — there is no
      button; open it from an old summary row (reload the tab with its id in
      the remembered selection, or void it in a second browser tab after
      pressing Open in the first): the notice says it has been voided and
      nothing else is selected. Withdraw drawing A-101 as **project_manager**
      in the Documents tab, return to the summary: its rows read *Drawing
      withdrawn* under Historical, their *Open* says the drawing has been
      withdrawn and the picker does not move. Start a **Length** on A-201,
      switch to the summary and back: the draft is still there; press
      **Open** on an A-101 row — the discard confirmation asks first; cancel
      keeps you on A-201 with the draft; press Open again and accept — A-101
      opens, and a notice above the picker says *Unsaved work on another
      sheet is remembered* only if you had left work elsewhere (the accepted
      discard cleared A-201's).
- [ ] **Open in Quant from the BOQ dialog, roles and layout.** On the **BOQ**
      tab open **Quant (1)** on 2.1 and press **Open in Quant →** beside *A-201
      · Rev A · p.1*: the dialog closes, the Quant tab opens on A-201 Rev A
      page 1 with the 12 m² area highlighted and its row scrolled into view;
      the BOQ item's quantity is unchanged (no apply happened). Go back to the
      BOQ tab: *Quant (1)* still opens the same dialog with the same proposal,
      fingerprint status and confirmation — the review-and-apply workflow is
      untouched. Reload the browser on the Quant tab: the same sheet and the
      same highlighted measurement return. As **subcontractor**: *Quant
      takeoff is restricted* and *The BOQ is restricted*, no permission error
      in the console. At **375px** the summary's tables become cards and the
      issue badges wrap, every *Open* is a 44 px button, the *Measure / Project
      summary* toggle wraps under the heading; at **768px** and **1280px** the
      tables scroll inside their cards; VoiceOver/NVDA read the four count
      badges and announce the loading status and the unavailable alert.
      **Budget, Forecast, Cash Flow and Commercial are unchanged throughout.**

## 30. Constrapp Quant™ 1D — manual opening and void deductions (ADR-54)

Automated: `tests/unit/quantDeductions.test.js` (41) — see §0b; four pins in
`tests/unit/quantInteraction.test.js` revised explicitly (the closed set of
quantity reasons gained five deduction codes; `editDirty` compares with the
session's `basePoints` so a hole edit is judged against the hole; nine tracked
saves; four dialogs on the QuantDialog shell). Rules: `takeoff.rules.test.js`
#65–#71 (§0). Lint 0/0. **Rules changed (one optional key) — the release was
RULES-FIRST** (DEPLOYMENT.md). **Production-verified 26 October 2026** (merged,
Azure CI passed, rules published first, Hosting deployed, the checks below run
live by the product owner; the repository records the day, not a time).

**The implementation machine could not boot the Firestore emulator** (its only
JDK is x86_64 Temurin 17 on an arm64 Mac without Rosetta: *Bad CPU type in
executable*). The seven new rules cases parse (`node --check`) and mirror the
unit-level transaction tests, but their first emulator run must happen on the
reviewer's machine or in Azure CI (`test:rules` is blocking there) **before the
rules are published**.

Manual — three checks, on `npm run test:quant` (the §27/§28 fixture: A-201
Rev A is a calibrated PNG with a 12 m² area linked to BOQ item 2.1):

- [ ] **Gross − deductions = net, everywhere, and nothing is a row of its own.**
      As **qs** on A-201 Rev A, **Select** the 12 m² area and press **Deduct**
      in the selection bar (or on its row): the strip reads *Deduction from
      "…": 0 points · needs 3 — trace the opening inside the area*. Tap four
      corners of a 1 m × 2 m rectangle inside it: the strip shows *gross
      12.000 m² · this deduction 2.000 m² · net 10.000 m²* and the hole draws
      dashed amber. Press **Finish deduction**: the *Save deduction* dialog
      shows Gross 12.000 m² · This deduction 2.000 m² · All deductions 2.000 m²
      · 1 · Net 10.000 m², focus is in the label field, Tab stays inside,
      Escape closes it. Enter *Door D01* and save: the notice names it, the
      area's row now reads **10.000 m²** with *gross 12.000 m² − 1 deduction
      2.000 m²* beneath, the hole is a dashed opening cut out of the fill on
      the sheet, a sub-row *− Door D01 2.000 m²* offers **Edit outline ·
      Rename · Remove**, the page status reads Area **10.000 m²** with *net ·
      gross 12.000 m² − deductions 2.000 m²*, and **Project summary** shows
      Area 10.000 m² (gross 12.000 m² − deductions 2.000 m²) with *Current &
      valid* unchanged at 1 — the deduction is never a second row and the
      attention list is unchanged. Add a 1 m × 3 m window deduction the same
      way: net 7.000 m², *2 deductions 5.000 m²*. Open **Details** on the area:
      *Net quantity 7.000 m²* with the breakdown line; the label, cost code and
      BOQ link are exactly as before. **Rename** the door — the sub-row updates
      and nothing else moves. **Edit outline** on the window: the parent
      outline and the door show faintly, drag a corner outward past the slab
      edge — the strip turns red with *A deduction lies partly outside the
      area…* and **Save geometry** is disabled; drag it back, enlarge it a
      little, Save — *Deduction "Window W01" outline saved* and the net falls
      accordingly. Now open **Geometry** on the AREA itself and drag its
      corner so the door would fall outside: the same red sentence, Save
      disabled; Undo. Re-calibrate the page with a halved distance: the area
      reads *Needs review — scale changed*, its figure quadruples and the
      *was 7.000 m²* line shows the original **net**; **Mark reviewed** clears
      it. **Budget, Forecast, Cash Flow and Commercial are unchanged throughout.**
- [ ] **Every refusal names its reason; an existing bad set is visible,
      blocked and correctable; drafts and stale writes behave.** With the area
      selected press **Deduct** and trace a second rectangle overlapping the
      door: the strip reads *Two deductions overlap or touch…* and *Finish
      deduction* is disabled; trace one that straddles the slab edge — *…lies
      partly outside…*; trace a figure-of-eight — *…crosses itself…*; trace a
      rectangle flush against the slab's bottom edge (touching, inside) —
      allowed, net updates; trace one covering the whole remaining area —
      *The deductions leave no area…*. Cancel. Start a deduction with two
      points, switch to the **BOQ** tab and back: the same area is selected,
      the deduct tool and the two amber points are restored (*Your unsaved
      work on this sheet was restored*). In a second browser tab (same user)
      **Rename** the area; back in the first tab finish and save the
      deduction: the dialog shows *The area changed while you were working on
      this deduction… Your deduction is kept…*, the points are still on the
      sheet, the preview now judges them against the live outline; save again
      — it commits. Void the area in the second tab and try again in the first:
      *The area this deduction belongs to is no longer on this sheet*. To see
      an EXISTING invalid record, with the emulator rules bypassed set a
      stored area's `deductions` to a hole outside its outline: its row reads
      **—** with *A deduction lies partly outside…* and the offending sub-row
      marked *see note*; the page total says *1 needs attention*; the project
      summary lists it under *Needs attention · Quantity cannot be derived*;
      on the **BOQ** tab *Quant (n)* lists it under **Quantity cannot be
      derived** with Apply disabled. Press **Remove** on the bad hole (confirm)
      — row, totals and dialog recover. Set `deductions` to `["junk"]`: the
      row shows *A deduction could not be read…* and a sub-row *(unreadable
      deduction)* with **Remove** only. As **subcontractor**: *Quant takeoff
      is restricted*; a direct write of `deductions` on a length, a non-list,
      or 51 holes is refused by rules (the emulator log shows
      PERMISSION_DENIED), while an outside hole is accepted by rules and named
      by the app — exactly DC32.
- [ ] **The BOQ apply writes the NET; evidence goes outdated when a hole
      changes; layout.** With the area at net 7.000 m² linked to 2.1 open
      **Quant (1)** on the BOQ tab: the row's Quantity reads **7.000 m²** with
      *gross 12.000 m² − 2 deductions 5.000 m²* beneath; *Measured total 7 m²*;
      tick, **Apply 7 m²** — quantity 7, amount at the unchanged rate, *Latest
      Quant application · Matches the current measurements*. On the Quant tab
      **Remove** the door deduction; back on the BOQ tab the dialog now
      proposes 9 m² and the latest application reads **Outdated — the linked
      measurements changed**; the item's quantity is still 7 until applied
      again. Apply, then **Rename** the window: the fingerprint moves (the
      measurement's revision did) and the application reads outdated again —
      a rename is still a change to the record. An item applied BEFORE 1D
      from a measurement with no deductions still reads *Matches* after the
      upgrade (fingerprints without holes are byte-identical). At **375px**
      the deduction sub-rows sit under the card with 44 px *Edit outline /
      Rename / Remove* cells, *Deduct* beside the review badge, and the
      breakdown line wraps under the quantity; at **768px** and **1280px** the
      table shows the sub-row under its parent across all columns; the
      evenodd hole stays cut out at 25 % and 800 % zoom and under a pinch.
      VoiceOver/NVDA announce *Save deduction, dialog* and read the
      *Deductions from "…"* list. **No budget line, forecast line, PO, claim,
      invoice, payment, variation, cash-flow line or baseline changed.**


## 31. Forecast and Actual Cost Integrity — M1 (ADR-55)

Automated: `tests/unit/poLineRecognition.test.js` (24, new);
`tests/unit/claimInvoiceLifecycle.test.js` (10, new — the approved-claim →
invoice lifecycle step by step: Actual, Remaining Committed, Cost to Complete,
FFC and the Cash Flow basis at no claim, submitted, approved, draft / approved /
cancelled / posted claim-sourced invoice; partial claim-sourced invoices proven
unreachable through `claimReconciliationError`, `claimHasActiveInvoice` and the
terminal `posted` state); `forecast.test.js`
§8 (11 new cases: the 1,250 → 950 fixture, claim approved before invoice,
claim converted to a posted invoice, partial and multiple claims, direct
invoice + claim on one line, legacy line without `poLineIndex`, closed and
cancelled POs, rejected claim / cancelled invoice, the new rollup fields);
pins revised **explicitly, with the reason beside each**: `forecast.test.js`
(fixture claims gained `poLineIndex`; cc1 FFC 1,250 → 950, variance −250 → +50,
over-budget count 1 → 0; totals RC 1,120 → 700, FFC 1,690 → 1,270; the
malformed-CTC parity case 1,100 → 800), `progressClaims.test.js` (APPROVING
now moves Remaining Committed; total commitment never moves),
`purchaseOrders.test.js` and `supplierInvoices.test.js`
(`maturedCommittedByCostCode` → `remainingCommittedByCostCode`),
`cashFlow.test.js` (each cost-coded source has its own balance; D_cost gains
the approved-claim basis), `shield.test.js` (five conditions; condition E
suite), `financialReliability.test.js` (`remainingCommitted` depends on
`progressClaims`; fixture claim on po1; Forecast/Commercial destructure the
exposed hook errors), `loadingNotZero.test.js` (Budget readiness model),
`costCodes.test.js` (`selectableCostCodes`; the three pickers filter). Unit
suite 52 files / 3,347 tests; lint 0 errors / 0 warnings; **no rules change —
Hosting-only release, LIVE IN PRODUCTION since 27 October 2026 (the deployed
build verified against matching local and production asset hashes).** The rules
suite is unaffected and must still be green in Azure CI before release (this
machine cannot boot the emulators — §30).

Manual — three checks, as **project_manager** on a project with one sent PO
(two lines, say 800 and 500), approved budget 1,000 on the first line's cost
code and a saved Uncommitted CTC of 150 on it:

- [ ] **An approved claim is counted once.** Raise a claim on the PO claiming
      300 on line 1, submit and approve it (certify 300). **Budget** tab:
      Committed for that code reads **500** (not 800), Actual **300**,
      Commitment Exposure 500 + approved SVs; the help text says a cost is
      never in both. **Forecast** tab: Remaining Committed 500, Cost to
      Complete 650, Forecast Final Cost **950**, Variance **+50** (green, not
      over budget); **Commercial** FFC 950; **Dashboard** snapshot Remaining
      Committed 500 with help *not yet recognised as Actual*; **PULSE**
      indicator 1 reads *no issue* (it read *finding* before this release on
      the same records). Raise the supplier invoice **From approved claim**,
      approve and post it: every figure above is **unchanged** (Actual 300 now
      from the invoice, Committed still 500). **Cash Flow**: before posting,
      *Approved claims awaiting invoice* showed 300 as its own untimed line and
      *Cost timed* measured against 500 + 300 + 150; after posting it is 0 and
      the 330 gross balance is timed by the invoice due month. Mark the PO
      **Closed**: Budget and Commercial show *⚠ incl. 500 on closed PO(s)*
      beside Committed / under the margin card; nothing is released.
- [ ] **One recognition path per PO line.** With an open or approved claim on
      line 1, open **New Supplier Invoice → Direct against PO**, pick the PO
      and enter an amount on line 1: the red notice names the claim
      (*Line 1 … is already being claimed through PC-000x*) and **Create** is
      disabled; enter the amount on line 2 instead and it saves. Post a direct
      invoice on line 2, then open **New Progress Claim** on the PO: claiming
      above zero on line 2 is refused with the invoice number; line 1 claims
      normally. In the emulator or with a direct SDK write, create a posted
      direct invoice on a line that also carries an approved claim: the
      Supplier Invoices register shows the amber *counted through both…*
      notice with the overlap and **Review in SHIELD**; **SHIELD** check 4 is a
      *finding* with condition *PO line counted through both a direct invoice
      and an approved claim*, amount = the smaller of the two, both record
      numbers in the row; Budget Actual still shows **both** amounts (nothing
      was offset) and the caveat says so. Cancel the direct invoice: the
      finding clears.
- [ ] **Readiness, not zeros; failed reads are named — tested with a
      CONTROLLED denial, never by assuming an external role's permissions.**
      Use either method, as a **financial role**: (a) *simulated subscription
      failure* — in Chrome DevTools → Network → *Block request URL*, add the
      pattern `*Firestore/Listen*` (or `*firestore.googleapis.com*`) **before**
      opening the tab, so every `onSnapshot` errors instead of settling; or
      (b) *controlled emulator denial* — against the local emulators
      (`firebase emulators:start --only firestore,storage`), load a copy of
      `frontend/firestore.rules` in which the `supplierInvoices` and
      `variations` `allow read` lines are changed to `if false`, then open the
      Budget tab. **Budget** then shows Budgeted and Claimed as values and
      Committed, Actual, Invoiced, Remaining and Commitment Exposure as
      **Unavailable** (never $0); the amber banner names the failed sources;
      every row cell in those columns reads *Unavailable* while Budgeted still
      prints. With method (a), *Budget lines unavailable* replaces the
      empty-register prompt and every summary figure reads **—** until the
      block is removed. Repeat method (a) for the **Purchase Orders**,
      **Variations**, **BOQ** and **Cost Codes** tabs and the **Contacts** /
      **Subcontractors** pages: each shows the amber *could not be loaded*
      card (and disables *+ New …*) instead of *Create your first…*;
      **Forecast** shows the card and disables editing; **Commercial** blocks
      the baseline save with the contacts note. ⚠️ This check does **not**
      exercise, and must not be read as securing, the `subcontractor` /
      `client` roles: rules let those roles read every project's POs, claims,
      budget lines and cost codes company-wide — an **unresolved P0 security
      issue for M2** (SECURITY.md → *Documented Roles vs Enforced Roles*). Deactivate a cost code: it disappears from the **New PO**,
      **New Variation** and **Add BOQ Item** pickers but stays selected on an
      existing draft that already uses it, and no Budget, Forecast or Margin
      figure moves. At **375px**, **768px** and **1280px** the Budget summary
      wraps to two columns, the closed-PO note sits under Committed, and the
      register scrolls horizontally inside its card. **No PO, claim, invoice,
      payment, credit note, variation, budget line, forecast line, cash-flow
      line or baseline document changed.**

## 32. Financial Read-Access Containment — M2-A (ADR-56)

Automated: `tests/rules/externalRoles.rules.test.js` (176, new) and the revised
read groups of `costCodes.rules.test.js` (52) and `budgetLines.rules.test.js`
(66) — see §0. Full rules suite: **23 files / 1550 tests**, run locally on
27 October 2026 on arm64 Java 17 and required green in Azure CI. Rules file
**197,035 bytes** (196,622 before) against the 245,000-byte budget. **Rules-only
release — no Hosting deploy**; the live bundle is unchanged.

**Status: LIVE IN PRODUCTION since 27 October 2026** — merged, Azure green, the
ruleset published and the three checks below verified in production by the
product owner that day (the repository records the day, not a time). Whether
any `subcontractor` / `client` user exists in production is still **NOT
VERIFIED** from the repository.

Manual acceptance — at most three checks, run **after** the publish, against
production, by the product owner (completed 27 October 2026; kept as the
record):

- [ ] **The published ruleset is this one.** Firebase console → Firestore →
      Rules: the active version's timestamp is after the publish, the editor
      finds `ADR-56` in the `costCodes`, `budgetLines`, `purchaseOrders` and
      `progressClaims` comments, and `wc -c frontend/firestore.rules` matches
      the pasted text at **197,035** bytes (`diff <(pbpaste)
      frontend/firestore.rules` is empty).
- [ ] **A controlled external-role read is denied.** Using a **non-production
      test tenant** (or the emulator with the published file), sign in as a
      provisioned `subcontractor` and open a project's **Budget**, **Cost
      Codes**, **Purchase Orders** and **Progress Claims** tabs: each shows the
      amber *unavailable / could not be loaded* state, never a register, and
      DevTools → Network → the `Listen/channel` stream carries
      `"status": "PERMISSION_DENIED"` for exactly those four collection paths;
      the **Documents → Drawings** tab still lists drawings. Do **not** create a
      subcontractor account in the production tenant for this check.
- [ ] **Financial roles are unaffected.** As `company_admin`, `project_manager`
      and `qs`, open Budget, Cost Codes, Purchase Orders, Progress Claims,
      Overview, Dashboard, Forecast and Commercial on a project with data: every
      figure renders as before the publish (record Budgeted, Committed, Actual,
      FFC and Margin before and after → identical), a draft PO and a draft claim
      can be created and edited, and no *Unavailable* banner appears.

## 33. Purchase Order Lifecycle Security — M2-B1 (ADR-57)

Automated: `tests/rules/purchaseOrders.rules.test.js` (**79**, new — see §0),
`tests/unit/poCancellation.test.js` (**19**, new — the strict policy over
claims, invoices and supplier variations, the reason text, the fail-closed
guard), `tests/unit/purchaseOrderActions.test.js` (**11**, new — the exact
transition write, check order, variation blockers and error kinds over a
scripted transaction) and the **12** ADR-57 cases added to
`tests/unit/purchaseOrders.test.js` (lifecycle constants, negative-line and
line-ceiling validation, the stamped update-payload contract, and a sweep of
every subtotal from $0.00 to $10,000.00 through the REAL `poTotals` against
the rules' exact-or-boundary GST check, proving every deviation is −1 on a
half-cent boundary). The revised `externalRoles.rules.test.js` PO fixtures
carry the ADR-57 shape; its assertions and count are unchanged. Full rules
suite: **24 files / 1629 tests**; unit **54 files / 3389 tests**; lint 0 / 0;
build green — all run locally on 27 October 2026 on arm64 Java 17. Rules file
**207,567 bytes** (197,035 before) against the 245,000-byte budget.

**Status: LIVE IN PRODUCTION since 27 October 2026.** Hosting was deployed
first and the ruleset published second (the ADR-40 ordering gate); the product
owner verified the build against matching local and production asset hashes
and inspected the published ruleset, which carries ADR-57 / ADR-58 / ADR-59.
The checks below are the acceptance record of that release.

Manual acceptance — at most three checks, run **after both deploy steps**,
against production, by the product owner (every rules invariant is automated
in §0; these prove the deployed build and the published ruleset are the ones
tested):

- [ ] **The deployed build and the published ruleset are this release.** On a
      project with cost codes, raise a draft PO, edit it, send it, and cancel a
      second draft: all four succeed, and in the Firestore console the sent
      document shows `sentBy` = your uid, `sentAt`, `updatedAt` / `updatedBy`
      and `closedBy: null` / `cancelledBy: null`. Firebase console → Firestore →
      Rules: the active version's timestamp is after the publish, the editor
      finds `ADR-57` in the `purchaseOrders` block, and `diff <(pbpaste)
      frontend/firestore.rules` is empty (**207,567** bytes).
- [ ] **The cancel guard and the rules both hold.** On a sent PO that has an
      approved claim (or a posted supplier invoice, or an approved supplier
      variation), **Cancel** shows the red reason naming the record, opens no
      confirm, and the PO stays Sent; Budget Committed, Actual, FFC and
      Commitment Exposure do not move. Then, in the Firebase console (a
      direct write, as a financial-role identity), attempt to edit that sent
      PO's `subtotal` or set `status` back to `draft` → *Missing or insufficient
      permissions*; attempt `status: 'cancelled'` with `cancelledBy` set to
      another user's uid → refused. (A console cancel with your own uid and a
      server timestamp **succeeds** — the cancel policy is client-only, DC35 —
      and SHIELD check 4 then lists it; this is the documented ceiling, not a
      failure.)
- [ ] **Legacy documents and downstream figures are unaffected.** Pick a PO
      created before this release (no `sentBy` key in the console): a draft one
      edits and sends; a sent one closes or cancels (if unlinked); the document
      gains the new keys. Record Budget Committed, Actual, FFC, Forecast Cash
      Out and the Commercial margin before and after the release on a project
      with data → identical. Raise a supplier invoice against a PO sent through
      the new rules → succeeds; a progress claim against it → succeeds.

## 34. Progress Claim Lifecycle Security — M2-B2 (ADR-58)

Automated: `tests/rules/progressClaims.rules.test.js` (**102**, new — see §0),
`tests/unit/progressClaimActions.test.js` (**23**, new — the exact draft-edit
and transition writes, revision arithmetic, check order, stale detection over
a scripted transaction, error kinds) and the **9** ADR-58 cases added to
`tests/unit/progressClaims.test.js` (the retention floor and line ceiling in
`validateClaimDraft`, the stamp map, and a sweep of every subtotal from $0.01
to $10,000.00 plus 100,000 (subtotal, retention) pairs and 20,000 negative
legacy retentions through the REAL `claimTotals` against the rules'
exact-or-boundary GST check on the NET; the update-payload replica is now the
module's own `draftUpdate` and carries `revision + 1` and the stamps). The
revised `externalRoles.rules.test.js` claim fixtures (and its one PO seed, now
`sent` with a close as its update) and the PO suite's one claim-create case
carry the ADR-58 shape; every assertion and count is unchanged. Full rules
suite: **25 files / 1731 tests**; unit **55 files / 3421 tests**; lint 0 / 0;
build green — all run locally on 27 October 2026 on arm64 Java 17. Rules file
**224,528 bytes** (207,567 after M2-B1; 197,035 live) against the
245,000-byte budget.

**Status: LIVE IN PRODUCTION since 27 October 2026.** Hosting was deployed
first and the ruleset published second (the ADR-40 ordering gate); the product
owner verified the build against matching local and production asset hashes
and inspected the published ruleset, which carries ADR-57 / ADR-58 / ADR-59.
The checks below are the acceptance record of that release.

Manual acceptance — at most three checks, run **after both deploy steps**,
against production, by the product owner (every rules invariant is automated
in §0; these prove the deployed build and the published ruleset are the ones
tested):

- [ ] **The deployed build and the published ruleset are this release.** On a
      project with a sent PO, raise a draft claim, edit it (change one line
      and the retention), submit it, assess it → certify less than claimed on
      one line → Approve; withdraw a second draft: all succeed, and in the
      Firestore console the approved document shows `submittedBy` and
      `approvedBy` = your uid, `submittedAt` / `approvedAt`, `updatedAt` /
      `updatedBy`, `rejectedBy: null`, `revision: 3` (create 1, edit 2,
      submit 3 → approve 4 if edited; count the writes), and the withdrawn one
      `rejectedBy` = your uid. Firebase console → Firestore → Rules: the active
      version's timestamp is after the publish, the editor finds `ADR-58` in
      the `progressClaims` block (and `ADR-57` in `purchaseOrders`), and
      `diff <(pbpaste) frontend/firestore.rules` is empty (**224,528** bytes).
- [ ] **The guards and the rules both hold.** Open the same submitted claim's
      Assess dialog in two tabs; approve in tab A, then approve in tab B → tab
      B shows the red *"… is now Approved, not Submitted …"* reason, keeps its
      entries, and the first certified figures stand; Budget Actual, FFC and
      Remaining Committed reflect tab A's figures exactly once. Then, in the
      Firebase console (a direct write, as a financial-role identity), attempt
      to edit that approved claim's `approvedSubtotal`, set `status` back to
      `submitted`, or set `status: 'invoiced'` → *Missing or insufficient
      permissions* each time; attempt to create a claim document with
      `status: 'approved'` → refused. (A console write of a SECOND draft claim
      on the same PO with the correct shape, your uid, server timestamps and
      `revision: 1` **succeeds** — one open claim per PO is client-only, DC36 —
      and SHIELD check 4 then lists it; this is the documented ceiling, not a
      failure.)
- [ ] **Legacy documents, the invoice hand-over and downstream figures are
      unaffected.** Pick a claim created before this release (no
      `submittedBy` key in the console): a draft one edits and submits; a
      submitted one approves or rejects; the document gains the new keys and
      `revision` 2. Raise a supplier invoice from a claim approved through the
      new rules → it reconciles and posts; the claim stays `approved` and
      Actual is unchanged in total (the invoice replaces the claim). Record
      Budget Committed, Claimed, Actual, FFC, Forecast Cash Out and the
      Commercial margin before and after the release on a project with data →
      identical.

## 35. Variation Lifecycle Security — M2-B3 (ADR-59)

Automated: `tests/rules/variations.rules.test.js` (**102**, rewritten from the
107-case ADR-34 suite — see §0; every ADR-34 case is kept in the new write
shape, and the source-PO link, counterparty and type are proven frozen from
creation through submit and approve), `tests/unit/variationActions.test.js` (**25**, new — the exact
draft-edit and transition writes, revision arithmetic, check order, stale
detection over a scripted transaction, error kinds) and the **5** ADR-59 cases
added to `tests/unit/variations.test.js` (the stamp map, the line ceiling, and
sweeps of every cent from −$10,000 to $10,000 on each tax code plus 20,000
random mixed-sign multi-line variations through the REAL `variationTotals`
against the rules' replicated whole-cent check and total identity). No other
suite changed. Full rules suite: **25 files / 1726 tests**; unit **56 files /
3451 tests**; lint 0 / 0; build green — all run locally on 27 October 2026 on
arm64 Java 17. Rules file **237,851 bytes** (224,528 after M2-B2; 197,035
live) against the 245,000-byte budget — 7,149 bytes of headroom.

**Status: LIVE IN PRODUCTION since 27 October 2026.** Hosting was deployed
first and the ruleset published second (the ADR-40 ordering gate); the product
owner verified the build against matching local and production asset hashes
and inspected the published ruleset, which carries ADR-57 / ADR-58 / ADR-59.
The checks below are the acceptance record of that release.

Manual acceptance — at most three checks, run **after both deploy steps**,
against production, by the product owner (every rules invariant is automated
in §0; these prove the deployed build and the published ruleset are the ones
tested):

- [ ] **The deployed build and the published ruleset are this release.** On a
      project with a sent PO, raise a draft supplier variation against it with
      one positive `GST 10%` line and one negative `GST-free` line, edit it
      (change a line and add one), submit it, assess it → certify a different
      amount on one line with a note → Approve; withdraw a second draft; raise
      and approve a client variation: all succeed, the register shows the
      signed totals, and in the Firestore console the approved supplier
      document shows `submittedBy` and `approvedBy` = your uid, `submittedAt` /
      `approvedAt`, `updatedAt` / `updatedBy`, `withdrawnBy: null`,
      `revision: 4` (create 1, edit 2, submit 3, approve 4), and the withdrawn
      one `withdrawnBy` = your uid. Firebase console → Firestore → Rules: the
      active version's timestamp is after the publish, the editor finds
      `ADR-59` in the `variations` block (and `ADR-57` / `ADR-58` in
      `purchaseOrders` / `progressClaims`), and `diff <(pbpaste)
      frontend/firestore.rules` is empty (**237,851** bytes).
- [ ] **The guards and the rules both hold.** Open the same submitted
      variation's Assess dialog in two tabs; approve in tab A, then approve in
      tab B → tab B shows the red *"… is now Approved, not Submitted …"*
      reason, keeps its entries, and the first certified figures stand; Budget
      *Approved Supplier Variations* / *Commitment Exposure* (or the
      Commercial *Current Contract Sum* for a client variation) reflect tab A's
      figures exactly once. Then, in the Firebase console (a direct write, as a
      financial-role identity), attempt to edit that approved variation's
      `approvedSubtotal`, change its `poId`, set `status` back to `submitted`,
      or set `status: 'disputed'` → *Missing or insufficient permissions* each
      time; attempt to create a variation document with `status: 'approved'`
      → refused. (A console write that approves a submitted variation with a
      certified value different from the submitted one and **empty**
      `assessmentNotes` — correct shape, your uid, server timestamps,
      `revision + 1` — **succeeds**: notes-required-when-differing is
      client-only, DC37; this is the documented ceiling, not a failure.)
- [ ] **Legacy documents and downstream figures are unaffected.** Pick a
      variation created before this release (no `updatedAt` key in the
      console): a draft one edits and submits; a submitted one approves,
      rejects or withdraws; the document gains the new keys and `revision` 2.
      Record Budget Approved Supplier Variations, Commitment Exposure,
      Pending Supplier Variation Exposure, the Commercial Current Contract
      Sum, Forecast Revenue, Gross Profit, PULSE indicator 6 and the SHIELD
      check 4 variation column before and after the release on a project with
      data → identical; attempt to cancel a sent PO that a live supplier
      variation references → still refused with the variation named (the
      M2-B1 guard reads the same fields).

## 36. Firestore Rules Capacity Optimisation — ADR-60

Automated: no test was added, changed or removed — that is the point. The
refactor is proven by the suites that already exist: the full rules suite
(**25 files / 1726 tests**, every case unchanged, including `externalRoles`'
176 tenancy / role cases, the legacy-document, forged-stamp and
boundary-money cases of §33–§35 and the Quant source-status cases) and the
unit suite (**56 files / 3451 tests**) — the five structural tests that read
`firestore.rules` (`quant.test.js`, `quantDeductions.test.js`,
`quantBoq.test.js`, `pulseAttention.test.js`, `rulesSize.test.js`) pass
because their anchors were kept local (ADR-60); lint 0 / 0; build green;
`git diff --check` clean — all run locally on 27 October 2026 on arm64
Java 17, after each of the three passes. Rules file **201,523 bytes**
(237,851 live) against the 245,000-byte budget. Mechanical checks beyond the
suites: the 32 match paths identical; every `allow` line identical modulo the
helper renames; every deleted local body normalised-identical to its shared
replacement; every call in every block resolved to one definition with the
right arity; the two comment-only passes byte-identical in non-comment text.

**Status: LIVE IN PRODUCTION since 29 October 2026** (published as part of the
M3-A ruleset and confirmed by the product owner). Rules-only; the live bundle is
unaffected either way, so there is no ordering gate. See DEPLOYMENT.md →
*ADR-60 release order*.

Manual acceptance — at most three checks, **read-only**, run after the
publish, by the product owner:

- [ ] **The published ruleset is this file.** Firebase console → Firestore →
      Rules: the active version's timestamp is after the publish, the editor
      finds `Shared helpers (ADR-60)` near the top and `ADR-59` in the
      `variations` block, and `diff <(pbpaste) frontend/firestore.rules` is
      empty (**201,523** bytes). No *Rules are too large* banner appeared.
- [ ] **Financial-role reads are unchanged.** As `project_manager` and again
      as `qs`, open one project's Budget, Purchase Orders, Progress Claims,
      Supplier Invoices, Variations, Commercial (Margin, Cash Flow), Tenders,
      Documents & Drawings, Quant and PULSE tabs, and the company Contacts
      and Cost Codes: every register loads with its previous figures and no
      tab reports *Unavailable*. (Reads exercise every shared helper's tenant
      path; nothing is written.)
- [ ] **External-role reads are still denied.** In a non-production tenant
      or the emulator — never by provisioning an external user in production
      — a `subcontractor` / `client` identity still cannot read cost codes,
      budget lines, POs, claims, invoices, variations, forecast lines, the
      baseline or contacts (the §32 method); another user's `users/{uid}`
      remains unreadable to everyone.

## 37. Awarded Tender → Linked Draft Purchase Order — M3-A (ADR-61)

Automated: `tests/rules/awardToPo.rules.test.js` (**33**, new — see §0): the
Phase 0 feasibility proof (PO create + package back-link succeed as ONE batch
for every financial role; a PO with source keys but no back-link is denied; a
back-link without its PO is denied; a back-link to a PRE-EXISTING draft —
even one citing the package — is denied; both halves roll back when either is
invalid and the counter does not advance; an overwrite of an existing PO
inside the batch is denied), the source rules (package not awarded; bid not
the awarded one / void / other package / missing; tender number, supplier id
or name mismatch; partial or malformed triple; every ADR-57 create invariant;
other-project and other-company packages), immutability (draft edit, the
three transitions, a manual PO can never acquire provenance, the back-link
untouchable by every other branch, no pre-filled link at create), duplicate
protection and re-raise (a second raise refused while the first is draft or
sent; after cancellation a re-raise relinks and the cancelled PO keeps its
source; never back to the same PO; a link naming a vanished PO; forged actor
/ time / smuggled content), roles / tenancy / legacy / manual compatibility,
the normal tender workflow unchanged, and the app's transaction
`lib/awardToPoActions.js` against the real rules (counter 2 → 3, exact
document, every role; the currency lock in the same commit, a QS included;
ALREADY_RAISED with nothing written; **two concurrent raises → one PO, one
link, one increment**; re-raise after cancellation; STALE; a denied role is
PERMISSION with nothing written; and the DC38 ceiling — lines unrelated to the
bid are ACCEPTED by rules when the header balances). `tests/unit/awardToPo
.test.js` (**30**): the one-to-one mapping, subtotal == Awarded Bid Value over
a 300-fixture sweep, exclusions shown never copied, 100 lines, every blocker
(package status, bid missing / void / wrong / other package, validity gate,
sub-cent amount, missing cost code, archived / missing supplier, currency
mismatch, active / unknown link) and warning (inactive code, retyped /
renamed contact, same-supplier POs), the link-state helpers, the fail-closed
gate over loading / failed sources, the shared `buildPurchaseOrderDocument`
(23 keys manual, +3 award) and the financial regression (a raised draft
contributes nothing; sending commits exactly the bid lines; the award is never
added). `tests/unit/awardToPoActions.test.js` (**10**): the exact writes and
their order, every refusal writes nothing, re-raise, SDK error mapping. Rules
suite **26 files / 1759 tests**; unit **58 files / 3491 tests**; lint 0 / 0;
build green; `git diff --check` clean — all run locally on 29 October 2026 on
arm64 Java 17. Rules file **207,620 bytes** (201,523 before) against the
245,000-byte budget.

**Status: LIVE IN PRODUCTION since 29 October 2026** (rules first, then
Hosting — see DEPLOYMENT.md → *M3-A release order*; confirmed by the product
owner that day). **No production transaction is part of this section's
automation**; the checks below are the acceptance record, run on a project the
product owner chooses.

Manual acceptance — at most three checks, run **after both publish steps**,
against production, by the product owner (every rules invariant is automated
above; these prove the published ruleset and the deployed build are the ones
tested):

- [ ] **Raise, highlight, refuse twice.** Open an awarded tender package →
      *Raise purchase order…* → the review dialog shows the supplier, one
      line per bid line, *Subtotal = awarded bid value*, GST 10%, the bid's
      exclusions (if any) and the draft-only statement → *Create draft
      purchase order*. The Purchase Orders tab opens with the new draft
      highlighted at the top, *From TP-####* beneath its number, and the
      normal Edit / Send / Cancel controls. Back on the package, the award
      panel shows *Purchase order: PO-#### Draft* with *Open PO* and **no**
      raise button; the register row shows no second raise path.
- [ ] **Nothing moves until Send.** Note the Budget tab's Committed and
      Forecast Final Cost for the bid's cost codes before raising; after
      raising they are unchanged. Send the draft: Committed rises by exactly
      the PO subtotal, which equals the Awarded Bid Value on the Tenders tab,
      and that value itself is unchanged. (A test project, or cancel the PO
      afterwards if it has no claims or invoices.)
- [ ] **Manual path and re-raise.** Raise a manual PO on the same project
      through *+ New Purchase Order* (no source text appears), edit and send
      it as before. Cancel the linked draft from the first check (on a test
      project): the package now offers *Raise again…*; it creates a new
      draft, the package links to it, and the cancelled PO still shows
      *From TP-####*.


## 38. Supplier Variation Commitment Integration — M3-B1 (ADR-62) — LIVE (confirmed by the product owner after the three-stage release)

Automated: `tests/rules/variations.rules.test.js` (**+27**, the four ADR-62
blocks): approve WITH the commitment stamps for every financial role against a
sent PO and a closed PO (the document is then read by
`appliedSupplierVariationAdjustments` as `{ PO: { line 0: 900 } }` and Remaining
Committed rises 2,500 → 3,400); under the **FINAL** rules the pre-M3-B1
approve payload (no stamps; an old-bundle tab) is **DENIED on a PO-linked
variation for every role** with nothing written while a manual-mode plain
approve still passes; a cancelled / draft / pending PO refuses the approval with
AND without the pair (the variation stays submitted and can still be withdrawn);
a missing PO and another project's PO refuse both payloads while a legacy
approved unstamped document stays readable and applicable; refused on a
manual-mode and a client variation; forged stamps (another actor, client clocks, half the pair);
the pair refused at create (present or null) and on a draft edit, submit, reject
or withdraw; the legacy Apply for every role (stamps + revision + audit only,
every other field byte-identical), refused on repeat with every revision, on
every non-approved status, on manual / client, on a cancelled / draft PO, with
any bundled change, with forged actor / time / revision / audit, for every
denied role, and succeeding on a legacy document; the app's transactions
against the real rules (approve-and-apply in one write; a cancelled or missing
PO refuses the approval as PO_INVALID with an actionable message and nothing
written; apply once then ALREADY_APPLIED; **two concurrent applies → one
application, one revision**; STALE then the fresh copy; cancelled PO INVALID;
denied role PERMISSION); and the DC39 ceiling (invalid lines ACCEPTED by rules
and classified by the client; a PO cancelled after application keeps the pair).
`tests/unit/variationCommitment.test.js` (**32**): cases A–E of the brief
through the real selectors, several variations per line, several lines / cost
codes, mixed and new-scope-only, legacy unapplied unchanged, invalid links
never attributed elsewhere, negative revised line listed and floored, duplicate
documents once, eligibility and `shouldApplyOnApproval`, the commercial-effect
preview and CTC warning, Forecast / Margin / Dashboard snapshot (variations now
gate Remaining Committed and FFC) / Cash Flow basis / PULSE.
`tests/rules/variationsTransitional.rules.test.js` (**9**, against
`firestore.transitional.rules`): the OLD bundle's PO-linked approve without the
pair ACCEPTED for every role on a sent and a closed PO and the document then
legacy-applicable once; create / submit / withdraw unchanged; the NEW bundle's
stamped approve ACCEPTED; a cancelled / draft / pending / missing /
other-project PO refuses BOTH payloads; manual / client semantics, forged
stamps, stamps at create, roles and tenancy unchanged.
`tests/unit/rulesTransitional.test.js` (**7**): the committed transitional file
equals the generator's output, the two files differ in exactly one rule line,
the PO-state requirement is in both, both under budget, the generator refuses a
source without exactly one marker. `tests/unit/variationActions.test.js`
(**+19**): the approve write with and without the pair, the server-side PO
decision — cancelled / draft / pending / missing PO refused as PO_INVALID with
an actionable message and nothing written, no poRef refused before any read, a
stale PO decided on the server copy, manual / client unchanged — the legacy
Apply contract, two concurrent applies, stale, missing, cancelled PO, SDK error
mapping. `tests/unit/shield.test.js` (**+16**): check 3 against the revised
ceiling, check 4 condition F, and condition G (a valid partial claim and a claim
at the ceiling never list; a negative variation below a recognised claim lists
with PO, cost code, revised value, claim and invoice recognition apart; a claim
approved above the line before its covering variation lists and clears once
the variation is applied; the claim → invoice hand-over leaves one row with the
recognition moved between columns and never doubles; a partly invoiced claim
counts each once; an invoice-only overrun is check 3's; a failed or loading
variations read is unavailable, never zero). `financialReliability.test.js` and `shield.test.js`
dependency pins updated (variations is an FFC source; check 4 reads variations).
Rules suite **27 files / 1796 tests**; unit **60 files / 3592 tests**; lint
0 / 0; build green; `git diff --check` clean — all run locally on 30 October
2026 on arm64 Java 17. FINAL rules file **210,926 bytes** (207,620 before),
transitional **211,378**, against the 245,000-byte budget.

**Status: IMPLEMENTED, NOT YET DEPLOYED.** Three stages — transitional rules,
Hosting, FINAL rules — see DEPLOYMENT.md → *M3-B1 release order*. **No production transaction is part of
this section's automation**; the checks below are run once, after both publish
steps, on a project the product owner chooses.

Manual acceptance — at most three checks, run **after both publish steps**,
against production, by the product owner (every rules invariant is automated
above; these prove the published ruleset and the deployed build are the ones
tested):

- [ ] **Approve applies.** On a sent PO of a known value (say 100,000 on one
      cost code, no claims), raise a supplier variation in PO mode with one
      line against that PO line for 12,000; submit; *Assess* shows the
      *Commercial effect* panel (current 100,000 → revised 112,000, remaining
      112,000) and, if a positive Uncommitted CTC is saved on that cost code,
      the acknowledgement; the button reads *Approve & apply to commitment*.
      Approve. The register row shows *Fully incorporated · applied* with
      approved 12,000 · in commitment 12,000 · exposure 0; the Budget
      tab's Committed for the cost code reads 112,000, *Applied Supplier
      Variations* 12,000, *Unapplied* 0, Commitment Exposure 112,000; the
      Forecast tab's Remaining Committed and Forecast Final Cost rose by
      exactly 12,000; the PO document is unchanged (console spot-check:
      same lines, totals and `updatedAt`).
- [ ] **Recognition and a negative variation.** Raise a progress claim of
      5,000 on that line and approve it: Committed 107,000, Actual 5,000,
      Forecast Final Cost unchanged. Raise, submit and approve a second
      supplier variation of −8,000 on the same line: Committed 99,000, nothing
      in Actual changes, no credit note appears. Post a supplier invoice from
      the claim: Committed and Forecast Final Cost unchanged.
- [ ] **Legacy Apply, once; invalid PO refused.** A supplier variation
      approved before this release (PO-linked, PO still sent) shows *Not yet
      applied* and an *Apply to commitment* action; open it in two browser
      tabs; confirm in the first (the row changes to *Fully incorporated*,
      Committed moves by the approved amount); confirm in the second — refused
      with the already-applied message and no change. A manual-mode (no PO)
      supplier variation and a client variation show no Apply action. On a
      test project, cancel a sent PO that carries a SUBMITTED supplier
      variation (reject its claims first if any): *Assess* on that variation
      shows the red PO notice and a disabled Approve; Reject still works.

## 39. New-Scope Variation Claim & Invoice Integration — M3-B2 (ADR-63)

Automated: `tests/unit/sourceLine.test.js` (the one source-line identity: a
null, string, float or negative index is NEVER coerced to 0; PO-origin vs
variation-origin vs INVALID; collision-safe keys; duplicate detection).
`tests/unit/newScopeClaims.test.js` (the brief's lifecycle through the REAL
selectors — PO 100,000 · SV +12,000 existing · SV +4,000 new scope committed ·
CTC 10,000: revised 116,000 / remaining 116,000 / FFC 126,000; claim 2,000 →
remaining 114,000, Actual 2,000, awaiting 2,000, FFC 126,000; invoice posted →
awaiting 0, nothing twice; second claim 1,500 → remaining 112,500, Actual 3,500,
awaiting 1,500 (not 3,500); third claim 1,000 with the second still uninvoiced →
the line floors at 0, Actual 4,500, awaiting 2,500, FFC 126,500 and SHIELD check
4 G lists the 500; the second and third invoices posted → awaiting 1,000 then 0
(the sequential A–F block, Actual and Remaining asserted at every step); the
Cash Flow reconciliation block — posted ≠ paid: unpaid AP from
`payablesSummary` (gross) and its due-month bucket, cash out from posted
payments, and the identity FFC = Remaining + awaiting + CTC + posted invoiced
ex-GST at every step, with a partial payment, a draft payment, a valid and an
invalid credit note and a negative new-scope variation; two variations on one
cost code with distinct identities; a PO line claimed 30,000 before the commit;
the over-recognition warning; a negative −3,000 new scope never matured or
claimable; a cancelled / missing PO makes new scope INVALID; duplicate and
forged sources refused by `validateClaimDraft` / `variationSourceError` and
listed by SHIELD H; check 3 compares variation-line invoices with their own
ceiling; builders preserve identity; margin, snapshot, cash-flow denominator and
PULSE carry the one figure). `tests/rules/variations.rules.test.js` (ADR-63
blocks: both pairs required on approve under FINAL, the M3-B1 payload denied,
forged / half scope pairs refused, the pair refused on manual / client / create
/ other branches; per-pair branch f — scope-only commit once on a B1-applied
document, the full Apply refused there, both pairs once on a never-applied
document, repeats refused, empty stamp writes refused, cancelled PO and roles
refused; the app's `runApplyVariationCommitment` writes only the missing pair).
`tests/rules/progressClaims.rules.test.js` (ADR-63 blocks: create with
variation lines for every role, several variations per claim, FINAL requires the
count, bad counts, the count pin, the first/last shape pins; **the old-client
protection** — the exact pre-M3-B2 rebuild of a variation line is REFUSED on
draft edit and on approve while the new payload passes; identity re-pointing
and count changes refused; legacy claims still edit / submit / approve; the
app's `runUpdateClaimDraft` against the real rules; the DC40 ceiling — forged
sources, a malformed middle line and a duplicated line are ACCEPTED by rules).
`tests/rules/supplierInvoices.rules.test.js` (ADR-63 blocks: the new payload
from a claim with a variation line for every role; the old payload REFUSED;
count bounded by the claim's and matching the last line; plain claims accept
absent or 0; direct PO invoices refuse any count > 0 or variation-shaped line;
`variationLineCount` frozen through the lifecycle; the DC40 ceiling).
`tests/rules/variationsTransitional.rules.test.js` (the Stage-1 file: the
M3-B1 approve accepted and then scope-committed once; the new approve accepted;
the pre-M3-B1 approve refused; Correction A for every payload; the M3-B1 claim
create without a count and the new create with one both accepted; the count and
shape pins and the invoice guard ACTIVE; every other control unchanged).
`tests/unit/rulesTransitional.test.js` (the two marked line pairs; both files
under budget). Rules suite **27 files / 1,828 tests**; unit **62 files / 3,653 tests**.

Manual (production, after Stage 2 — at most three):

1. **Approve commits new scope.** On a project with a sent PO, raise a supplier
   variation against it with one existing-line amount and one positive
   new-scope line, submit and assess it. The Assess modal lists the new-scope
   line as *committed on approval*, warns about any saved Uncommitted CTC or any
   PO line already recognised above its revised value, and reads *Approve, apply
   & commit new scope*. After approval the Variations register shows *Fully
   incorporated · applied · new scope committed*; Budget **Committed** and
   **Committed New Scope**, Forecast **Remaining Committed** and **Forecast Final
   Cost** rise by exactly the existing-line amount + the new-scope amount;
   **Unapplied Supplier Variations** is unchanged.
2. **Claim → approve → invoice → post moves the amount once.** Raise a progress
   claim on that PO: the editor lists the PO lines then the new-scope line
   (labelled with the variation number, "of <approved amount> (new scope)").
   Claim part of the new-scope amount, submit, approve. Budget / Forecast:
   Actual rises by the certified amount, Remaining Committed falls by exactly
   it, FFC is unchanged, the Cash Flow tab shows it as *approved claims awaiting
   invoice*. Raise the supplier invoice *From approved claim* (the line keeps
   the variation label), approve and post it: Actual and Remaining Committed are
   unchanged, awaiting-invoice falls to zero, the AP balance appears. SHIELD
   checks 3 and 4 show no finding. Raise a second claim on the same line: it
   pre-fills at the approved-to-date and claims the remainder cumulatively.
3. **Legacy commit, once; negative new scope never.** On a variation approved
   and applied under M3-B1 that carries a positive new-scope line, the register
   reads *Partially incorporated · new scope uncommitted* and offers **Commit new
   scope**; confirm it (the dialog shows the effect and requires the
   acknowledgement when it warns) — Committed and FFC rise by the new-scope
   amount, the action disappears, and a second tab's attempt is refused with
   "already been applied". On a variation whose only new-scope line is
   negative, no commit is offered, the register reads *Negative new scope —
   review*, the amount stays in Unapplied Supplier Variations (signed) and
   SHIELD check 4 lists it for review.
