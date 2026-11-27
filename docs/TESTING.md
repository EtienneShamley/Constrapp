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

- **Requires JDK 21+.** Since ADR-72 `firebase-tools` is `^15` (the v13
  Functions emulator cannot load `firebase-functions` v7), and v15 refuses a
  JDK older than 21. Azure CI uses Java 21; locally any JDK ≥ 21 (for example
  `JAVA_HOME=/opt/homebrew/opt/openjdk@26/libexec/openjdk.jdk/Contents/Home`).
- Config: `frontend/firebase.json` (the emulators + both rules pointers, the
  Hosting block first deployed by hand on 19 October 2026, and since ADR-72 the
  `functions` codebase plus the Auth and Functions emulators; **no
  `.firebaserc`**). The
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
  - `frontend/tests/rules/activities.rules.test.js` — **97 tests** covering
    every case in §15p-x below (the project programme, ADR-29), **15 for
    ADR-65** (the revision contract: create at 1; an edit or cancel must carry
    stored + 1 — unchanged, +2, backwards, non-integer and absent all refused;
    a legacy document moves 1 → 2 with no key invented; and the optional
    `predecessors` list: absent / empty / well-formed accepted, every
    non-list, non-map, extra-key, missing-key, empty-id, non-FS shape refused,
    lag 0 and 365 accepted and −1 / 366 / non-integer refused, self-reference
    and a source that does not exist in THIS project refused (including the
    same id in another company's project), 20 accepted and 21 refused, the
    LAST entry pinned as well as the first, cancellation unable to change the
    list, the write roles unchanged — and the DC41 gaps **proven ACCEPTED**: a
    malformed / missing / self MIDDLE entry, a duplicate, a cancelled source
    and a two-node cycle; the former "last-write-wins" overwrite test now
    proves the increment is REQUIRED and that a caller who read the revision
    can still overwrite), plus **16** that run the app's own **guarded
    quick-action transaction** (ADR-46) against the rules: admin/PM Start,
    Complete, Put on hold and milestone Mark reached each change **only** the
    intended keys plus `revision` and the audit stamps; QS, subcontractor, client, super_admin and other-company
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
    a duplicate `sortOrder`, and a full-document overwrite that carries the
    correct next revision are all ACCEPTED by rules.
  - `frontend/tests/rules/programmeBaselines.rules.test.js` — **85 tests**
    over the two ADR-66 blocks: the read / capture / approve matrix for every
    role (qs read-only; external roles, another company and anonymous
    denied); tenant and project isolation through the first / last
    `exists()` pin; the PAIR both ways (header alone, snapshot alone, a
    snapshot against a seeded header, mismatched counts, another actor, a
    client clock all refused; the correct pair stored with one server
    instant on both); 19 header create pins; 27 snapshot shape and first /
    last entry pins; every status, a one-day milestone and a cost-code key
    accepted; the DC42 gaps PROVEN (a garbage middle entry, duplicates, an
    entry whose dates differ from its source all ACCEPTED); a real
    **2,000-entry worst-case write** accepted under the ceilings and 2,001
    refused; the lifecycle (approve with caller stamp, server time and
    revision 2; self-approval permitted; another actor, client clocks,
    revision 1 / 3 and any content change riding along refused; withdraw
    with a reason, blank / long / another actor refused; an APPROVED or
    WITHDRAWN header admitting NO update; no delete in any state by anyone);
    the snapshot immutable (no update, no identical rewrite, no delete);
    and the app's own transactions against the emulator with the real
    `getDocsFromServer` — capture writes the pair with cancelled history
    kept, refuses a malformed stored activity by name, is refused for qs by
    the RULES; approve with no drift, drift unacknowledged refused with the
    drift attached, drift acknowledged by key approved, a programme that
    moved AGAIN refused; **two concurrent approvals** (first wins, second
    refused, nothing re-approved); a stale (withdrawn) copy and a missing
    snapshot refused; withdraw; and the `activities` block unaffected (a
    1A2 edit and cancel still pass beside an approved baseline).
  - `frontend/tests/rules/activitiesTransitional.rules.test.js` — **7 tests**
    against `firestore.transitional.rules` (ADR-65 Stage 1): the 1A1 bundle's
    edit and cancel (revision UNCHANGED) ACCEPTED; the 1A2 bundle's (+1)
    ACCEPTED with the stored revision advancing; +2, backwards and a string
    revision REFUSED even in Stage 1; an old-client edit after a new-client
    edit lands with the stamp moved (the documented Stage-1 gap, DC41); create
    still at revision 1 with the optional `predecessors` key accepted; the
    first/last pins, self-reference, missing source, lag range and size
    ACTIVE from Stage 1 (an old-client edit cannot smuggle a malformed list
    either); roles, tenancy, stamps and the cancellation key restriction
    unchanged.
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
  - `frontend/tests/rules/pulseAcknowledgements.rules.test.js` — **38 tests**
    (37 + one PULSE™ 1C case, ADR-67: the three schedule ids create,
    re-acknowledge and withdraw with the app's composite keys, QS read-only,
    no delete; the six-id pin revised explicitly to nine; near-miss ids
    such as `blockedactivities` / `scheduleRisk` still refused — see §43)
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
- `frontend/tests/unit/pulseSchedule.test.js` — **47 tests** over
  `lib/pulseSchedule.js` and the three PULSE™ 1C schedule indicators in
  `lib/pulse.js` (ADR-67): see §43.
- `frontend/tests/unit/pulseAttention.test.js` — **68 tests** (65 + three
  ADR-67 identity cases: link and versioned keys; a re-baseline and a new
  link reopen attention; the same link on another day does not) over
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

- `frontend/tests/unit/timelineGantt.test.js` — **54 tests** over
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
  input purity. **ADR-64 (21 tests):** the three zoom scales as ONE geometry
  (identical window, offsets, day counts and today offset at 22 / 8 / 3 px per
  day; a single-day activity one day wide at every scale; day ticks only at
  day zoom, week ticks labelled, a day tick run across a month and a year
  boundary; zooming never mutates the input); the **recorded-dates overlay**
  (`actualSpan`: span clamped like a bar, start-only and finish-only markers,
  a reached milestone, nothing for nothing / an invalid date / an inverted pair
  treated as a start-only fact / a span outside the window; the model widens
  for it); the **plan comparison** (`finishVarianceDays` needs BOTH valid
  finishes; late / early / on-the-day; labels that say *current plan* with
  singular and plural days and *Reached* for a milestone, never *baseline* or
  *slip*); **scroll-to-today** (centred in the canvas beside the sticky labels,
  clamped at both ends, null off-window); and the model's `barsById` index,
  join keys and legacy `dayWidth` call shape.

- `frontend/tests/unit/ganttGrouping.test.js` — **19 tests** over
  `lib/ganttGrouping.js` and `layoutGanttRows` (ADR-64). The three grouping
  modes; ungrouped as ONE group in programme order; **cost-code groups** keyed
  by `costCodeId`, ordered by category then label, labelled from the live cost
  code else the frozen snapshot, with the category as a hint and the truthful
  *No category* / *Category unavailable* fallbacks (and the whole set when no
  cost-code list exists at all — nothing invented), *No cost code* last;
  **responsible groups** by contact id, alphabetical, *Unassigned* last; every
  activity in exactly one group with per-group overdue counts; determinism
  whatever the input order; input purity; the collapse helpers (new Set each
  time, collapse-all, totals independent of collapse); and **rows over one
  model** — header + bar rows with stacked `y`, collapsing hides rows but keeps
  counts and never touches the model's window or today line, an excluded
  activity is counted but not a row, an array of keys works as well as a Set.

- `frontend/tests/unit/ganttSurface.test.js` — **24 source-level pins** for
  the GANTT™ 1A1 surface (the betaSurfaces idiom): one scroller with sticky
  labels and header; zoom as a pressed-state button group, a labelled group
  select, *Today* disabled off-window; day/week/month tick selection; the chart
  hidden below `md:` with the cards kept; every bar and milestone a real
  `<button>` with `aria-label` and a focus ring and **no nested control**; the
  accessible-name parts; group headers with `aria-expanded` and counts; the
  overlay `aria-hidden`; nothing drags; activation resolves the record from the
  loaded programme and routes author → editor, reader or cancelled → detail;
  the **read-only detail** has no form, Save, quick action or write import; the
  shared `ActivityDialog` contract and its adoption by editor, cancel and
  detail (`autoFocus`, no private overlay); the editor's validation and save
  path unchanged; Chart / List as two views of `filtered`; summary over the
  whole programme; zoom / grouping / collapse never stored; hook, domain and
  rules-facing field set untouched; geometry and grouping pure; the Dashboard
  and PULSE links still target `timeline` labelled *Open GANTT*; tokens only;
  the current-plan wording; no new dependency.
  `moduleBranding.test.js` was revised explicitly for the fifth module name,
  the fourth marked tab (still 17 tabs, `timeline` relabelled), the `/gantt`
  pointer, the `brand-gantt` token, the DOT / TONE / TILE entries, one beating
  tile beside one pause control on the programme page, the heading's local
  pause state, no timer / canvas, no misleading claim, and **orange never a
  status colour** on the chart, the table, the cards or the detail.

- `frontend/tests/unit/ganttDependencies.test.js` — **25 tests** over
  `lib/ganttDependencies.js` (ADR-65, GANTT 1A2): the vocabulary (FS only, 20
  max, lag 0–365); a document without the key reading as none; every
  malformed entry shape marked and never thrown on; the draft shape and
  validator (lag, type, empty id, duplicate, 20 / 21); the successor index;
  **finish-to-start arithmetic** on the inclusive calendar — the day after an
  ordinary finish plus lag, the SAME day for a milestone, month and year ends,
  a leap day, both DST changes, an unusable predecessor; **cycles** — direct,
  indirect, self, a 2,000-node ring, malformed and missing references as
  non-edges, `wouldCreateCycle` for self / direct / indirect closure and a
  safe link; **derived states** — valid / conflict / missing / cancelled /
  cycle / malformed with precedence, finished never true for an unresolved
  link, **blocked only when the start has arrived** (a future start never
  blocked; started / held / completed never blocked; a cancelled, missing or
  cyclic link blocks when due), the Lead Architect correction (a cancelled
  predecessor never satisfies the link and contributes no earliest start), the
  midnight flip, input purity and junk tolerance; **editor validation** —
  candidate errors (self, duplicate, missing, cancelled, cycle), the draft
  list with RETAINED missing / cancelled links tolerated and new ones refused,
  draft conflicts and the order-insensitive acknowledgement key; the
  **accessible text** (every link named with lag, finished state and problem;
  Blocked / Conflict / Review flags; conflict days); and the version helpers
  (`activityRevision` reads a legacy document as 1; `sameActivityVersion`
  needs revision AND stamps).

- `frontend/tests/unit/ganttBaseline.test.js` — **37 tests** over
  `lib/ganttBaseline.js` (ADR-66): the header lifecycle and the draft /
  withdraw validators; the capture projection (exactly the ten entry keys,
  no description / notes / actual dates / predecessors / name snapshots; a
  legacy document read as revision 1; never repaired) and `validateBaselineEntry`
  with a precise reason per fault; `buildCapturePayload` (every activity in
  programme order with cancelled history and counts; REFUSED by name on a
  malformed record or a duplicate id — nothing excluded silently; an empty
  programme, > 2,000 entries and an oversized payload refused without
  truncation; the 2,000 × 120-character worst case under the 900,000-byte
  ceiling and 1 MiB); the Firestore storage-size formula; approved history
  (ordering by `approvedAt`, id tie-break, drafts and withdrawn never
  approved, a malformed approved header never active, ordinals,
  designations, labels, selector options, `selectedBaseline`); the snapshot
  index and usability; drift (changed / added / cancelled-since / missing,
  the order-independent key, a legacy revision); variance (signs, start and
  finish separately, completion ONLY from a recorded finish, month / year /
  leap-day boundaries, milestones, every classification with null
  variances); `baselineComparison` incl. orphaned entries and no snapshot;
  every label (never "current plan"); and the summary (each class counted
  once, the single largest finish movement with an id tie-break, the
  latest-planned-finish envelope, no average and no completion claim,
  unavailable without a snapshot).

- `frontend/tests/unit/programmeBaselineActions.test.js` — **18 tests** over
  `lib/programmeBaselineActions.js` with a fake transaction AND a fake
  server read: capture reads the SERVER first then writes the header and
  the snapshot in ONE transaction exactly once each (the exact documents);
  cancelled history captured in order; an invalid name / reason refused
  BEFORE any read; a malformed server activity refused by name with nothing
  written; OVERSIZED refused without truncation; empty, offline (never a
  cache fallback), no uid and transaction failures mapped; the drift check;
  approve — server read, then header + snapshot reads, then ONE stamps-only
  update at revision 2; drift unacknowledged → DRIFT with the drift attached
  and nothing read in a transaction; the acknowledged key must match the
  drift found NOW; MISSING, STALE by revision or by stamps, a non-draft, a
  missing or mismatched snapshot refused with nothing written; pending copy
  and no uid refused before any read; the snapshot never updated; withdraw
  (stamps + reason + revision 2 after the read; blank reason, stale copy and
  an approved baseline refused); every error message states nothing was
  written or changed.

  `timelineGantt.test.js` gained **5** ghost tests (`baselineSpan` from the
  ENTRY dates with offset, inclusive width and milestone x; clamping and
  the cut ends; nothing for an unusable entry; the model carrying the ghost
  only when a baseline map is given and widening the window for it, scaled
  at every zoom; an undrawn or unmapped activity drawing nothing and moving
  no window; zoom and grouping never touching the map); `ganttSurface.test.js`
  **10** ADR-66 pins (the decorative dashed outline in `brand-text-soft`
  behind the bar, never a fill or orange, no animation; the baseline
  sentence in the bar name and the two legend entries; the List column,
  card line and detail row as text; the page deriving selection, comparison
  and summary with nothing stored; the stale ADR-65 copy gone; the two hooks
  — one bounded headers listener, one single-document snapshot listener,
  `getDocsFromServer`, no direct write; the action layer — server read
  first, the pair in one transaction, drift by key, no Firebase import, the
  snapshot never updated, no financial module; the pure domain never
  inferring a finish from a status; the dialogs on the shared shell with the
  preview, the refusal and the explicit drift acknowledgement; no new
  dependency and no Dashboard or PULSE import of the baseline modules).

- `frontend/tests/unit/activityActions.test.js` — **13 tests** over
  `lib/activityActions.js` with a fake transaction: the full edit writes the
  normalised fields + `revision` (stored + 1) + stamps exactly once AFTER the
  read; a legacy document moves 1 → 2 and gains `predecessors: []`; STALE by
  revision and STALE by stamps alone (a legacy-session write) refused with
  nothing written and the "Nothing was saved" message; MISSING, a cancelled
  server copy and a locally pending base refused; an invalid draft refused
  before any read; every NEW predecessor read on the server BEFORE the write
  and a retained one not re-read; a missing, cancelled or self source refused;
  a contention re-run that sees a newer copy refused, never re-applied;
  permission / offline / aborted mapped with the cause kept; create at
  revision 1 with empty cancellation stamps after checking new sources; cancel
  writing the cancellation keys + revision + stamps only, and refusing stale,
  missing, already-cancelled and an empty reason.

  `timelineGantt.test.js` gained **7** arrow tests (`dependencyArrows`,
  `arrowPath`: one arrow per drawable link with its state and geometry, scaled
  at every zoom, following grouping, omitted and COUNTED when an end is
  collapsed or filtered out, the density limit with counts kept, forward and
  doubled-back paths, the 2,000 × 20 worst case bounded); `ganttSurface.test.js`
  **8** ADR-65 pins (one `aria-hidden` SVG overlay with pointer-events none;
  state-styled arrows and the three legend entries; hidden / truncated
  disclosure; the dependency sentence in the bar name and the flag in the
  labels, table, cards and detail; the editor's fieldset, disabled-with-reason
  picker, lag bounds, acknowledgement key and reset; stale handling with
  *Reload latest*; the action layer's read-before-write, combined version
  check, single increment and new-source reads, never the whole graph; the
  pure, iterative domain; the page deriving states over the whole programme);
  `timelineScheduling.test.js` **+1** (a stale revision alone is refused; the
  quick action writes stored + 1) and its editor pin inverted (no
  unconditioned write remains); `rulesTransitional.test.js` pins the THIRD
  marked pair and the activities block's sameness in both files.

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
- [ ] The Constrap IQ™ "Coming Soon" card still renders below the list.
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

### 15p-viii. Gantt (desktop/tablet) — since ADR-64 the Constrapp GANTT™ chart; see also §40

- [ ] The Gantt renders at **768px and 1280px** and is **absent below `md:`
  (375px)** — the cards replace it. Confirm no squashed chart appears on a
  phone. (ADR-64: above `md:` the **Chart / List** toggle selects the chart or
  the activity table; the toggle itself is absent on a phone.)
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
- [ ] **Nothing is draggable or resizable**, and clicking a bar changes no date
  by itself — it opens the existing editor (admin / PM) or the read-only detail
  (QS); the footer states there is no drag-to-reschedule and no dependencies.
- [ ] An activity with unusable dates is reported as *not drawn* and still
  appears in the activity list — never silently dropped.

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
- [ ] Subcontractors shows the contacts table with **no Constrap IQ™ "Coming
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
      product panel is an "About Constrap" landmark, the form is in `main`.
- [ ] 200% browser zoom: no overlap, no horizontal scroll.
- [ ] Forced-colors / high-contrast mode: input focus is still visible.
- [ ] Password-manager autofill works for email and password.

### 21d. Product boundaries

- [ ] No demo access, demo-account quick-fill, membership, pricing, or
      "Remember me" anywhere on the three auth routes.
- [ ] No planned module named or implied; no "world-first", "patent-pending",
      "only platform" or "100% Australian-owned" claims.
- [ ] "No account?" guidance is plain text, not a link.

## 22. Premium Dashboard v2 (ADR-45) — DEPLOYED (VERIFIED read-only, 25 November 2026 — §74.1); check 1 PASSED in production without throttling (§74.5) — tested financial calculations ACCEPTED (Lead Architect, §74.10); checks 2 and 3 NOT RUN — OPEN

*Heading as written before 25 November 2026:* Premium Dashboard v2 (ADR-45)

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
      the heading reads *Constrap PULSE™* / *Project health indicators* beside
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
      animation"), the tab "PULSE, link" and the heading "Constrap PULSE™,
      heading level 2" — the mark and dot are not announced.
- [ ] **Tabs and hidden pages at 375 / 768 / 1280px.** The tab bar wraps with
      PULSE (mark + label) after Overview, nothing animates in it, the active
      underline is teal like every other tab, and keyboard Tab/Enter reaches
      and opens it. Typing `/shield` shows *Constrap SHIELD™* with a static
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
      tab: the *Constrap SHIELD™* heading with the cyan tile whose small dot
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
      announces "Constrap SHIELD™, heading level 2" and each check as a
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
Storage read retries (bounded by the download timeout) before it reports an error, and
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
      **Quant** tab: the *Constrap Quant™ · Manual quantity takeoff* heading
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

**Status: LIVE IN PRODUCTION (confirmed by the Product Owner).** Three stages — transitional rules,
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

## 40. Constrapp GANTT™ — Programme 1A1 (ADR-64) — LIVE in production (confirmed by the Product Owner)

**Automated:** `tests/unit/timelineGantt.test.js` (33 → 54), new
`tests/unit/ganttGrouping.test.js` (19) and `tests/unit/ganttSurface.test.js`
(24), `moduleBranding.test.js` / `betaSurfaces.test.js` /
`timelineScheduling.test.js` pins revised explicitly — unit **64 files /
3,720 tests**. Rules: **no change**; the full suite re-ran unchanged (27 files
/ 1,828 tests) and `firestore.rules` is byte-identical (217,864 bytes). The
chart component itself is still not unit-tested (no jsdom); the three checks
below cover rendering, interaction and regression by hand. Preconditions: a
project with a programme of mixed statuses, at least one milestone, one
overdue activity, one completed activity with both actual dates, one activity
with an actual start only, cost codes with and without a category, and two
responsible contacts; an admin / PM login and a QS login.

**Manual acceptance (maximum three):**

1. **Branded module, zoom and sticky layout (1280 px, then 768 px).** The
   project tab bar reads **GANTT** with a static orange mark (nothing animates
   in the tab bar). The tab opens at `/projects/{id}/timeline` with the
   *Constrap GANTT™ · Construction programme* heading, an orange tile whose
   corner dot beats gently, and a **Pause** button that stills it (Resume
   restores it). With the OS *reduce motion* setting on, the dot is still and
   lit and the Pause button is absent. Switch **Day → Week → Month**: a
   one-day activity and a milestone sit on the same dates at every zoom (read
   the row label and the List); the month header widths follow real month
   lengths; the label column stays put while scrolling sideways and the header
   stays put while scrolling down; **Today** recentres the today line; the
   Dashboard *Open GANTT →* link and the PULSE indicator-4 *Open GANTT* link
   both land here. Group by **Cost code**: groups are ordered by category with
   the category shown as a hint (a retired code shows *Category unavailable*,
   not an invented one; *No cost code* is last); collapsing a group hides its
   rows while its header still shows its count and *n overdue*, and the four
   summary cards do not change. Bars keep their existing colours — nothing on
   the canvas is orange.

2. **Keyboard activation, editor, read-only detail.** As admin / PM, Tab to a
   bar (a visible focus ring appears; a screen reader or the tooltip reads the
   activity, status, %, planned dates, recorded dates, any *…after / before the
   current plan* text, *Overdue* and *Opens the editor*), press **Enter**: the
   existing **Edit activity** dialog opens with focus in the name field; Tab
   cycles inside the dialog; change the planned finish and save — the bar and
   the List update together and focus returns to the bar; **Escape** closes
   the dialog without saving. The completed activity shows a thin
   recorded-dates line beneath its bar and the detail / name reads *Finished n
   days after (or before) the current plan*; the start-only activity shows a
   single start tick and no invented finish. Sign in as **QS**: Enter on a bar
   opens the **Activity** detail with the same values, one **Close** button and
   **no Save or status control**; an admin pressing Enter on a *cancelled*
   activity gets the same read-only detail. On a phone (375 px) the chart and
   the Chart / List toggle are absent and the grouped cards work as before.

3. **Regression — nothing else moved.** The List view is the unchanged
   activity table: filters (search, status, responsible, Due, hide closed)
   narrow the chart and the list identically; quick actions (*Start today*,
   *Put on hold*, *Complete today*) and **Cancel** behave exactly as §15p;
   the Dashboard **Programme** panel and PULSE **indicator 4** show the same
   counts and next milestone as before. Open the Budget and Forecast tabs
   before and after editing an activity and grouping / zooming the chart:
   every figure is identical — the programme writes no financial document,
   and Firestore shows no new field on any activity.

## 41. Constrapp GANTT™ — Programme 1A2, dependencies and scheduling integrity (ADR-65) — LIVE in production (confirmed by the Product Owner)

**Automated:** unit **66 files / 3,775 tests** (new `ganttDependencies.test.js`,
`activityActions.test.js`; `timelineGantt`, `ganttSurface`,
`timelineScheduling` and `rulesTransitional` extended — see §0b); rules **28
files / 1,850 tests** (new `activitiesTransitional.rules.test.js`;
`activities.rules.test.js` 82 → 97). FINAL `firestore.rules` 217,864 →
**219,930 bytes**; transitional **220,564**; `npm run rules:transitional:check`
clean. The chart component itself is still not unit-tested (no jsdom); the
three checks below cover rendering, interaction and the rollout by hand.
Preconditions: a project with a programme of at least six activities and one
milestone, two browser tabs (or two users) with admin / PM logins, a QS login,
and the Stage-1 ruleset published in the test project for check 3.

**Manual acceptance (maximum three):**

1. **Links, conflict, blocked, review — at every zoom.** Edit activity B, add
   A as a predecessor with a lag of 2: the fieldset shows *Earliest permitted
   start* = A's planned finish + 3 days; set B's planned start before it and
   the amber conflict panel appears, Save is refused until the acknowledgement
   is ticked, changing the start date un-ticks it, and after saving the chart
   draws a red dashed arrow A → B with *Conflict* in B's row label, the List
   and the cards. Move B's start after the earliest date: the arrow turns muted
   and the flag clears. Add a milestone M as a predecessor of C with lag 0 and
   set C to start ON the milestone day: no conflict. Switch Day / Week / Month
   and group by cost code: every arrow still joins the end of its predecessor
   bar to the start of its successor bar; collapse A's group and the A → B
   arrow disappears while B keeps *← 1* and the chart reports one dependency
   not drawn. Try to make A depend on B: the picker lists B as *would create a
   dependency cycle* and it cannot be chosen. Cancel A: B now reads *Review*
   with *Predecessor cancelled — requires review*, and once B's planned start
   has passed (set it to yesterday) B reads *Blocked* and the bar carries the
   red ring; remove the link in B's editor and the flags clear. As QS, Enter
   on B opens the read-only detail listing the predecessors with their states
   and B's successors, with no Save.

2. **Two editors, one activity.** Open the same activity in two tabs. Tab 1
   changes the name and saves (the record's `revision` goes from 1 to 2). Tab
   2 changes the notes and saves: the save is refused with *Someone else
   changed this activity after you opened it. Nothing was saved — your edits
   are still here*, the typed notes remain, and **Reload latest** replaces the
   form with Tab 1's name; save again and it succeeds (revision 3). Repeat
   with a quick action (Start today) from a stale tab: refused, nothing
   written. Cancel from a stale tab: refused. In Firestore the document shows
   `revision` 3 and `predecessors` present; no other field was invented.

3. **Stage-1 compatibility and regression.** With the TRANSITIONAL ruleset
   published and a pre-1A2 (1A1) bundle open in one tab: that tab can still
   edit and cancel an activity (revision stays 1) and the 1A2 tab then detects
   the change as stale by the moved stamp before its own save. With the FINAL
   ruleset published the 1A1 tab's edit is refused with a permission error
   and a reload fixes it. Regression: the 1A1 chart (zoom, grouping, sticky
   layout, Today, actual overlay), the Dashboard Programme panel, PULSE
   indicator 4 and the Budget / Forecast figures are unchanged before and after
   adding dependencies; a project with no dependencies shows no arrows, no
   flags and no disclosure line.

## 42. Constrapp GANTT™ — Programme 1B, approved schedule baselines & progress variance (ADR-66) — LIVE in production (confirmed by the Product Owner)

**Production acceptance (25 November 2026 NZDT) — see §72; functional acceptance CLOSED (Lead Architect, 25 November 2026 — REPORTED); the dashed outlines, offline capture and Day / Month visuals carried forward.** Checks 1 and 2 PASSED in production on the retained CAD fixture `V2Vj8jds7RUkBAmZ1jzm`, with every variance equal to an independent calculation; check 3: the invalid-programme refusal and the Rules refusals PASSED, the QS session and the offline capture were not run (Rules evidence: emulator and §71 M8). One UX finding: D3 #30. The text below is kept as written.

**Automated:** unit **68 files / 3,861 tests** (new `ganttBaseline.test.js`
and `programmeBaselineActions.test.js`; `timelineGantt` and `ganttSurface`
extended — see §0b); rules **29 files / 1,935 tests** (new
`programmeBaselines.rules.test.js`, 85 — see §0). FINAL `firestore.rules`
219,930 → **228,967 bytes**; transitional **229,601**; `npm run
rules:transitional:check` clean. The chart, the panel and the two dialogs are
not unit-rendered (no jsdom); the three checks below cover them by hand.
Preconditions: a project with a programme of at least six activities and one
milestone (one cancelled), admin / PM and QS logins, two browser tabs.

**Manual acceptance (maximum three):**

1. **Capture, approve, compare.** As PM, *Capture baseline*: the preview
   shows the activity count with the cancelled one as history, the milestone
   count and an estimated size; enter a name and reason and capture — the
   panel lists the draft as *not approved*. *Review draft*: the dialog reports
   *No activity has changed since this baseline was captured*, the
   self-approval note appears (you captured it), Approve — the panel now
   reads *Baseline 1 — name · Active · Original*, approved by You, *captured
   and approved by the same person*. Move one activity's planned finish 6
   days later and a milestone 3 days earlier: the chart shows a dashed
   outline where each bar used to be (a hollow diamond for the milestone),
   the bar's description reads *Planned … finish +6 days against baseline*,
   the List's *vs baseline* column shows `+6 d` (amber) and `−3 d`, the
   summary counts *1 later · 1 earlier · the largest finish movement* and the
   latest-planned-finish line, and the mobile cards (375 px) carry the same
   sentence. Record an actual finish on a completed activity 2 days after its
   baseline finish: *Finished 2 days after the baseline finish* appears in the
   list and the detail. Add a new activity: *Added after the baseline was
   approved*; cancel another: *Cancelled since the baseline was approved* and
   the summary counts them. *Hide baseline* removes the outlines and the
   column; Day / Week / Month and grouping keep every outline on its dates.
   In Firestore the header is `approved` at revision 2 and the snapshot is
   byte-identical to the capture.

2. **Drift, concurrency and re-baselining.** Capture a second draft, then in
   another tab edit one activity and add one. *Review draft* in the first tab
   lists *Edited since capture · 1* (with the revision move) and *Added since
   capture · 1*; Approve is disabled until the acknowledgement is ticked. Tick
   it, then in the other tab cancel a third activity; Approve in the first
   tab is refused with *The programme changed again after you reviewed it*,
   the list now shows *Cancelled since capture · 1* and the box is un-ticked;
   tick and approve — it succeeds as *Baseline 2 · Active*, *Baseline 1* is
   now *Original* and selectable in *Compare with*, and selecting it shows
   the earlier dates. Open the same remaining draft in two tabs and approve
   in both: the second is refused (*Someone else changed this baseline*),
   nothing is re-approved. Withdraw a draft with a blank reason: refused;
   with a reason: it leaves the drafts list. In Firestore no approved
   header or any snapshot has changed.

3. **Roles, refusals and regression.** As QS: the panel, the selector, the
   outlines, the column and the summary are visible; there is no *Capture
   baseline* and no *Review draft*; a direct write is refused by the rules.
   Make an activity invalid through the SDK (planned finish before start)
   and *Capture baseline*: the preview names it and the capture button is
   disabled — nothing is written. Go offline and try to capture a valid
   programme: *You appear to be offline … nothing was written.* Regression:
   the 1A1 chart (zoom, grouping, sticky layout, Today, actual overlay), the
   1A2 arrows and flags, the Dashboard Programme panel, PULSE indicator 4 and
   every Budget / Forecast figure are unchanged with and without a baseline;
   a project with no baseline shows *No approved baseline*, no outlines, no
   column and every activity remains editable.


## 43. Constrapp PULSE™ 1C — Schedule Intelligence (ADR-67) — LIVE in production (confirmed by the Product Owner)

**Automated:** unit **69 files / 4,023 tests** (new `pulseSchedule.test.js`,
47 — see §0b; `pulse.test.js` 394 and `pulseAttention.test.js` 68 after the
explicit pin revisions; `ganttSurface.test.js` one ADR-66 pin revised
explicitly); rules **29 files / 1,936 tests** (`pulseAcknowledgements.rules.test.js`
38 — the nine-id allowlist, the composite keys, near-miss ids refused).
FINAL `firestore.rules` 228,967 → **229,126 bytes** (the three ids in
`indicatorValid()` and nothing else); transitional **229,760**;
`npm run rules:transitional:check` clean. The page is not unit-rendered (no
jsdom); the three checks below cover it by hand. Preconditions: a project
with a programme of at least six activities including a milestone, with the
GANTT 1B rules **already live in production** (verify in the Console that the
published ruleset contains `programmeBaselineSnapshots`), admin / PM and QS
logins, two browser tabs.

**Manual acceptance (maximum three):**

1. **Blocked and dependencies.** On GANTT, make activity B depend on an
   in-progress activity A and set B's planned start to yesterday; make C
   depend on a cancelled activity D with C's start today. Open PULSE: *Nine
   conditions* in the header; **Programme activities blocked by
   predecessors** is a Finding — *2 activities should have started but are
   blocked by a predecessor*, B's row names A under *Waiting on*, C's row
   names D under *Needs review* (*Predecessor cancelled — requires review*),
   *Days waiting* 1 and 0, *Of which overdue* as applicable; **Programme
   dependencies need review** lists C → D (cancelled) and, if B starts before
   A's finish allows, B → A (*Starts before its predecessor allows*, with the
   earliest start), headline *n dependency links on m open activities need
   review*. Acknowledge the blocked finding with a note and a review-by date
   → *Acknowledged*; on GANTT complete A → B's row disappears and the card
   reads *Needs attention* only if C remains, else *No longer present*; add
   a new blocked activity E → *Needs attention — 1 new source record*.
   **Programme activities overdue** is unchanged throughout (same rows, same
   wording, no baseline dependency).

2. **Baseline.** With no approved baseline, **Programme later than approved
   baseline** reads *Needs data — No approved baseline to compare against*
   (never a Finding; with a draft, *1 draft baseline is awaiting review*).
   On GANTT capture and approve a baseline, then move a milestone's date 5
   days later and an activity's finish 3 days later. PULSE: a Finding — *1
   milestone and 1 activity are planned later than Baseline 1 — name*, the
   milestone first, *Later by* 5 days and 3 days, *Baseline finish* and
   *Planned finish* shown, *Compared with Baseline 1 — name · Approved on
   dd/mm/yyyy*, *Latest planned finish moved (envelope)* as `+n days`, and
   the caveat *planning evidence … not a project delay*. Acknowledge it;
   capture and approve a second baseline on GANTT → PULSE reads *Needs
   attention — new source records* against *Baseline 2*, the acknowledgement
   shown beneath. Set the moved finish back → *No open activity is planned
   later than Baseline 2 … (n compared)* and *No longer present*.

3. **Roles, failure and regression.** As QS: every schedule card is visible
   with its evidence; no Acknowledge button; a direct SDK write to
   `pulseAcknowledgements/blockedActivities` is refused. As subcontractor or
   client: the tab shows *PULSE indicators are restricted*. With DevTools
   blocking the `programmeBaselineSnapshots` read: the baseline card reads
   *Unavailable — Could not load: Programme Baseline Snapshot*, and the
   other eight cards are unchanged; blocking `activities` makes the four
   programme cards Unavailable and the five financial ones unchanged. A
   programme with no dependencies recorded: both dependency cards read *No
   issue found* with the explicit wording *No dependencies are recorded*.
   Regression: the six ADR-47 cards show the same states, figures, rows and
   acknowledgements as before; the Dashboard, the GANTT tab, every Budget /
   Forecast / Commercial figure and the SHIELD tab are unchanged; the beat
   dot and its Pause control behave as in §24.


## 44. GST boundary hotfix — `fix/gst-boundary-pins` (findings F2 / F3 of the SHIELD inspection of 3 November 2026) — DEPLOYED, Rules and Hosting (VERIFIED read-only, 25 November 2026 — §74.1; the release dates are not recorded); calculations verified independently (§74.4) — calculation compatibility ACCEPTED (Lead Architect, §74.10); **corrected manual acceptance steps 1, 2 and the financial parts of 3 PASSED in production, 27 November 2026 (§82.7); the external-role checks of step 3a NOT RUN**; precision concern tracker D3 #35 (payable side OPEN). *As written before:* manual acceptance 1–3 NOT RUN in production — OUTSTANDING, retained for the relevant financial implementation milestone

*Heading as written before 25 November 2026:* … — implemented, NOT YET DEPLOYED

**Root causes.** *F2:* `roundMoney(x × 0.1)` computes in binary floating point
and on some half-cent boundaries rounds DOWN (40.15 → 4.01 where half-up gives
4.02; 1,632 such retention values per $10,000, e.g. 5% of $803.00); the
`supplierInvoices.retentionGst` pin and the `retentionReleases` cumulative-GST
pin were EXACT half-up, so the app's own direct-PO invoice, any claim-sourced
invoice whose claim carried such a retention, and a first release of such an
amount were refused with permission-denied (ADR-57 had recorded it for POs and
claims only; the existing boundary cases — 100.05, 1234.55, 9999.95 — all
happen to round UP). *F3:* a claim certifies GST once on its net total
(`claimTotals`) while the claim-sourced invoice derived GST per line; three
certified lines of 10.05 gave 1.01 × 3 = 3.03 against a certified 3.02, so
`claimReconciliationError` refused the invoice and the claim stayed *awaiting
invoice*. Both are recorded in PROJECT_DECISIONS.md → *ADR-40 / ADR-57
Correction: GST Boundary Hotfix*.

**Automated:** unit **70 files / 4,051 tests** (new
`claimSourcedGstAllocation.test.js`, **28** — the integer apportionment:
3 × 10.05 → 1.01 + 1.01 + 1.00, largest remainder with index tie-break,
residual spread never concentrated, two-cent refusal ceiling, non-taxable and
zero lines excluded, malformed input refused, 200-line claim, a 3,000-case
deterministic sweep with and without cent-level retention proving exact
totals and per-line bounds; the line builder: reconciliation of two-, multi-
and single-line claims with and without retention, identity / amount / tax
code / cost code untouched, claim never mutated, idempotent, refuses a GST-free
line rather than fake a match; the EDIT rebuild matches CREATE and still
refuses a forged header; and the financial regression — the 30.15 counted
once in Actual, Remaining Committed 489.95 per line before and after posting,
FFC unchanged, AP = the certified payable total); every pre-existing unit test
passes unchanged. Rules **29 files / 1,960 tests** (+24):
`supplierInvoices.rules.test.js` +12 — six boundary retentions accepted as the
app writes them (each proven one cent below half-up), both alternatives for
40.15 (4.01 and the historical 4.02), one cent ABOVE on a boundary and two
below refused, ±1 off a boundary refused, the pre-hotfix 100.05 case kept with
its direction reversed (10.02 refused), an arbitrary self-consistent
`retentionGst` refused, and the claim-sourced invoice the app now builds
(3 × 10.05 apportioned, and a boundary-retention claim) created, approved and
posted through the rules; `retentionReleases.rules.test.js` +12 — six
boundary first releases accepted, both alternatives for 40.15, +1 / −2 on a
boundary refused, ±1 off a boundary refused, a later release after a boundary
cumulative (prev 40.15) with the client's +1 delta accepted and ±1 beyond it
refused, the telescoping 40.15 + 40.15 + 19.70 sequence, and arbitrary or
non-number GST refused; the old "one cent off" cases in both suites now assert
the ABOVE direction (the below direction is the admitted boundary variant).
FINAL `firestore.rules` 229,126 → **230,340 bytes** (+1,214: `gstPinned()`
hoisted to the shared helpers, the two pins, the release block's type/balance
split); transitional **230,974**; `npm run rules:transitional:check` clean;
lint 0 / 0; build clean; `git diff --check` clean.

**Manual acceptance — CORRECTED PROCEDURE (Commercial Finance Phase 1 final pass, 26 November 2026).** The procedure as first written could not be executed (§79.5): step 1 asked for a second release on an invoice whose retention the first release had exhausted; step 2 read figures the dialog showed only in whole units; step 3 named a comparison with no defined baseline. **No expected financial outcome is changed** — the supplier-side calculation is the one this section accepted (legacy `roundMoney(x × 0.1)`, one cent low on a half-cent boundary), and every figure below was recomputed from it. The original wording follows under *As first written*.

1. **Boundary retention (F2).**
   - **1a — the boundary itself.** Raise a direct-PO supplier invoice with one
     line of $803.00 and retention $40.15 (5%): the create succeeds (previously
     *permission-denied*) and the stored retention GST reads **$4.01**. Approve
     and post it. Post a Retention Release of $40.15: it succeeds with GST
     **$4.01**, release total $44.16. The retention is now fully released —
     *Release* is disabled on that invoice. Remaining Payable, Retention Held /
     Released and Cash Flow move exactly as for a non-boundary retention.
   - **1b — a release AFTER a boundary cumulative.** Raise, approve and post a
     second direct-PO invoice with one line of $2,000.00 and retention $100.00
     (retention GST $10.00). Post three releases in order: $40.15 → GST
     **$4.01**; $10.01 → GST **$1.01**; $49.84 → GST **$4.98**. Each succeeds;
     the three GST figures sum to **$10.00**, the invoice's stored retention
     GST, and nothing remains held.
2. **Cent-level claim (F3).** Approve a progress claim with three lines
   certified at $10.05 each (claim GST $3.02). *Raise invoice from claim*: the
   dialog — which shows amounts **to the cent** and the GST of each line since
   the final pass — previews line GST **$1.01 / $1.01 / $1.00**, GST total
   **$3.02**, payable total **$33.17**, with no reconciliation warning; saving
   succeeds (previously *does not reconcile … 3.03 vs 3.02*). Edit the draft's
   header (reference, dates, notes) and save — accepted; the lines are
   unchanged. Post it: Actual shows $30.15 once across the three cost codes,
   the claim leaves *awaiting invoice*, Remaining Committed is unchanged from
   before posting, AP shows $33.17.
3. **Regression.**
   - **3a — behaviour.** A whole-dollar claim (e.g. 300 + 200) still invoices
     with the same per-line GST as before; a direct-PO invoice with retention 0
     and with retention $100.00 is unchanged; a claim-sourced create with one
     line switched to *GST-free* is still refused by the reconciliation guard
     (it is never silently matched); a subcontractor or client login still
     cannot read or write supplier invoices or releases; a posted invoice still
     cannot be edited or cancelled.
   - **3b — figures unchanged for existing documents (a defined comparison).**
     Choose a project that already holds documents and is not written to
     during the check (locally: the seeded fixture of `scripts/seed-emulator.mjs`;
     in production: an existing regression fixture of the isolated acceptance
     company). **Before** the build under test is in use, record from that
     project: Budget (Budgeted, Committed, Actual, Remaining — totals), Forecast
     (Forecast Final Cost, Variance to Budget), Commercial (Current Contract
     Sum, Forecast Gross Profit, Margin %), Cash Flow (Actual Cash In / Out, net),
     the Dashboard snapshot figures for the project, and the SHIELD finding
     counts. **After**, read the same figures on the build under test. Every
     figure must be identical to the cent. Record both sets and the build
     identities. Locally the "before" build is `main` at the release's base
     commit, served from a separate working copy against the same emulator data.

*As first written (kept as the record; superseded by the corrected procedure above):*


**Manual acceptance (maximum three):**

1. **Boundary retention (F2).** Raise a direct-PO supplier invoice with one
   line of $803.00 and retention $40.15 (5%): the create succeeds (previously
   *permission-denied*), the stored retention GST reads $4.01, approve and post
   it; then post a Retention Release of $40.15 against it — succeeds, GST
   $4.01 — and a second release of $10.01 — succeeds. Remaining Payable,
   Retention Held / Released and Cash Flow move exactly as for a non-boundary
   retention.
2. **Cent-level claim (F3).** Approve a progress claim with three lines
   certified at $10.05 each (claim GST $3.02). *Raise invoice from claim*:
   the modal previews line GST $1.01 / $1.01 / $1.00, GST total $3.02,
   payable total $33.17 — no reconciliation warning — and saving succeeds
   (previously *does not reconcile … 3.03 vs 3.02*). Edit the draft's header
   (reference, dates, notes) and save — accepted; the lines are unchanged.
   Post it: Actual shows $30.15 once across the three cost codes, the claim
   leaves *awaiting invoice*, Remaining Committed is unchanged from before
   posting, AP shows $33.17.
3. **Regression.** A whole-dollar claim (e.g. 300 + 200) still invoices with
   the same per-line GST as before; a direct-PO invoice with retention 0 and
   with retention $100.00 is unchanged; a claim-sourced create with one line
   switched to *GST-free* is still refused by the reconciliation guard (it is
   never silently matched); a subcontractor or client login still cannot read
   or write supplier invoices or releases; a posted invoice still cannot be
   edited or cancelled; Budget, Forecast, Commercial, Cash Flow, Dashboard and
   SHIELD figures are unchanged for every existing document.

## 45. Constrapp SHIELD™ 2A — Claim-to-Invoice Source Pairing (ADR-68) — LIVE in production (confirmed by the Product Owner)

**What is enforced.** One approved progress claim reserves at most ONE active
(draft / approved / posted) claim-sourced supplier invoice — by Firestore Rules,
through the claim's `supplierInvoiceId` backlink written in the same transaction
as the invoice and cleared in the same transaction as its cancellation
(`lib/supplierInvoiceActions.js`; rules pair both halves with `getAfter()`). A
claim with NO link key (approved before the pairing) fails closed until it
records its existing active invoice; there is no "confirm no invoice" action.

**Automated:** unit **71 files / 4,087 tests** (new `supplierInvoiceActions.test.js`,
**30** — link-state classification by key PRESENCE, the document / link /
unlink writes, the paired create's read-before-write order, SUCCESS /
ALREADY_INVOICED (a retry re-reads the linked claim and never creates a second
invoice) / LEGACY_UNRECONCILED / STALE / MISSING / INVALID / PERMISSION /
OFFLINE / UNKNOWN, identity and certified-figure checks, the paired cancel incl.
two concurrent cancellations, the reconcile action's eligibility on both
copies, the absence of any attestation write, the reconciliation classifier,
and the financial pins — Actual / Remaining Committed / the hand-over set
identical for a legacy, an unlinked and a linked claim, no selector reads the
link, no extra listener; `shield.test.js` +6 for condition I; the ADR-58 approve
payload pin and the transitional pins extended). Rules **31 files / 2,006 tests** (new
`claimInvoicePairing.rules.test.js`, **37** — the getAfter feasibility proof for
every financial role, the unpaired create refused and HOW (a `getAfter()`
evaluation error, never a grant; a create failing before the pairing term is a
clean false), link-without-invoice / wrong-claim / wrong-id / forged stamps
refused, rollback with the counter untouched, a LEGACY claim fail-closed, a
submitted / draft / rejected / linked claim refused, PO / supplier id / supplier
name / claim number agreement (a trimmed name and a pre-Contacts null agree),
same project and tenant, every ADR-40 / ADR-63 create invariant still applied,
the reservation held through approve and post, link replacement / wrong
revision / extra key refused, absent key never set to null, paired cancel for
draft and approved by every role, cancel-without-unlink and unlink-without-cancel
refused, posted never cancelled or unlinked, re-invoicing after cancellation
(cancel → invoice → cancel → invoice; the cancelled document never reused),
legacy / stray / orphan / null-reference invoices cancelling ALONE, RECONCILE
of a legacy and a new-format null claim to a draft / approved / posted invoice
for every role, every refusal (cancelled, missing, other claim / PO / supplier,
direct_po, other project, non-approved, already linked, forged, wrong revision),
existing duplicates reconciled to ONE with the other left listed, a legacy claim
with no active invoice fail-closed, roles / tenancy / cross-company, and the
app's three transactions — the 4-document create (counter 5 → 6, SI-0005, the
link at revision 3, the project locked, a QS included), retry = ALREADY_INVOICED
with the counter untouched, TWO CONCURRENT creates → exactly one invoice,
LEGACY_UNRECONCILED / STALE, PERMISSION for a subcontractor, cancel + unlink
then a new create, a legacy invoice cancelling alone, posted INVALID, reconcile
then ALREADY_INVOICED; `claimInvoicePairingTransitional.rules.test.js`, **5** —
Stage 1 accepts the pre-2A claim create and approve, refuses a string link,
REFUSES the unpaired create, accepts the paired one and refuses the duplicate,
fails a legacy claim closed, reconciles, and pairs the cancel; the existing
`supplierInvoices`, `progressClaims`, `variationsTransitional` and
`purchaseOrders` suites with every claim-sourced create paired and the DC 3
"two invoices remain possible" case flipped to refused). FINAL
`firestore.rules` 230,340 → **238,325 bytes** (+7,985); transitional
**239,005**; `npm run rules:transitional:check` clean; lint 0 / 0; build clean;
`git diff --check` clean.

**Manual acceptance (maximum three):**

1. **Pairing.** Approve a progress claim (new bundle). Supplier Invoices →
   *New* → *From approved claim*: the claim is offered; create the draft. On
   the Progress Claims tab the claim's **Invoice** column shows the SI number
   and *Draft*; in a second tab the claim has left the invoiceable list without
   a refresh, and a second *New from approved claim* for it is impossible. In
   the second tab (opened BEFORE the create) try to create from the same claim:
   the editor reports *already has an active supplier invoice … the linked
   invoice is shown* with a **Show SI-####** link — no second invoice, no
   SI number consumed (the next invoice takes the next number).
2. **Cancel and re-invoice.** Cancel that draft: the claim's Invoice column
   returns to *Not yet invoiced* and the claim is offered again; the cancelled
   invoice stays in the register with its claim number. Create again — a NEW
   SI number — approve and post it: the Invoice column shows *Posted*, the
   claim leaves *awaiting invoice*, Actual shows the certified amount once,
   Remaining Committed is unchanged from before posting, and *Cancel* is no
   longer offered on the posted invoice.
3. **Legacy claim.** On a claim approved BEFORE this release: it is NOT offered
   in the invoice editor (the editor says one approved claim was approved
   before pairing and must be reconciled); on the Progress Claims tab its
   Invoice column reads *Approved before pairing — …*. If it has exactly one
   active invoice, **Link SI-####** appears — link it, the column shows the
   invoice, and the claim stays uninvoiceable while that invoice is active. If
   it has no invoice, NO action is offered (awaiting trusted reconciliation)
   and SHIELD check 4 lists it under *Claim-to-invoice link needs
   reconciliation*. With the invoice register failing to load (e.g. offline
   before the first snapshot), the column reads *Invoice register unavailable*
   and nothing is offered.

## 46. Firestore Rules Capacity Recovery 2 (ADR-69) — LIVE

**What changed.** Whole-line comments in `frontend/firestore.rules` only: 113
comment runs shortened, **238,325 → 218,840 bytes** (−19,485). The transitional
file was regenerated (`239,005 → 219,520`). No executable rules line, no
permission, no data shape, no client code and no test changed.

**Automated:** lint 0 / 0; unit **71 files / 4,087 tests** (unchanged — the
size test now reports 26,160 bytes under budget; the transitional test still
finds exactly four marked pairs); rules **31 files / 2,006 tests** (unchanged,
run against the cleaned file); build clean; `npm run rules:transitional:check`
clean; `git diff --check` clean.

**The equivalence proof (run from `frontend/`; reproducible from the
repository alone).** The script retrieves both original files from the base
commit with `git show` and verifies the working copies against them:

```bash
node scripts/verify-rules-comment-only.mjs --base 634e69c
```

Both lines must print `EQUIVALENT — 3041 retained non-comment lines are
byte-identical` (FINAL 238,325 → 218,840; transitional 239,005 → 219,520) and
the exit code must be 0. The script drops every line whose trimmed content
begins with `//` from both files and compares what remains byte-for-byte —
blank lines, inline comments and executable statements alike; any other
difference exits 1 and names the first differing line. Negative controls
verified: `--base ea2eea8` (the pre-2A commit) fails at the claims `hasAll`
line, and a copy with one `allow delete: if false;` flipped to `true` fails
at that line. A two-path form (`node scripts/verify-rules-comment-only.mjs
<original> <cleaned>`) compares any pair of files on disk.

**Manual (three checks, after the FINAL publish):**

1. Firebase Console → Firestore → Rules: the live source reads **218,840
   bytes**, contains `function gstPinned(netC, gstC)` and
   `function linkedInvoiceCreatedHere()`, and contains NO
   `TRANSITIONAL (STAGE 1)` marker.
2. In the app, raise and send a purchase order, create and approve a progress
   claim, and raise its supplier invoice: every write succeeds exactly as before
   (no permission-denied), and a `subcontractor` sign-in still cannot read
   supplier invoices.
3. `diff <(pbpaste) frontend/firestore.rules` (macOS, with the Console source on
   the clipboard) is empty — the published ruleset is the repo file.

## 47. Constrapp SHIELD™ 2B1 — Approved Budget Versions (ADR-70) — LIVE

**What is enforced.** A budget approval is a header (`budgetApprovals/{id}`) and
ONE immutable snapshot (`budgetApprovalSnapshots/{id}`) of every working budget
line, born together in one commit (rules pair them with `getAfter()` both
ways, pin count / total / currency, and pin the FIRST and LAST entries to
their source lines with `get()`); approval flips the header to `approved`
with its version AND creates / advances the pointer (`approvedBudget/current`,
`versionCount` exactly +1) in the same commit — by `company_admin` /
`project_manager` only; approved and withdrawn are terminal; the snapshot is
never updated or deleted. The Approved Budget shown anywhere is the SUM of the
active snapshot's entries; a disagreement between pointer, header and snapshot
makes every budget figure Unavailable. What rules cannot prove is Deferred
Control 44.

**Automated:** unit **73 files / 4,236 tests** (new `budgetApproval.test.js`,
**34** — lifecycle, roles, capture validation incl. duplicates / missing codes /
inactive codes / sub-cent / 2,000-line and byte ceilings, snapshot reading,
every integrity problem, the source adapter in every state incl. fail-closed
and the original, drift and its key, versions, the pending difference, the
version delta, the financial invariants — Budgeted / Variance / Remaining
Reference move by the approved delta while Actual, Remaining Committed, CTC,
FFC, Gross Profit, Margin %, Current Contract Sum, payables and cash are
byte-identical, BOQ / tender parity, the Dashboard snapshot's source and
gating; `budgetApprovalActions.test.js`, **17** — read order, the capture
pair, every refusal before a write, drift acknowledged by key, SUPERSEDED on a
moved pointer, the retry-after-timeout guard, withdraw, error messages, hook
structure; `pulse.test.js`, `shield.test.js`, `financialReliability.test.js`,
`projectSnapshot.test.js`, `dashboardV2.test.js` and `loadingNotZero.test.js`
re-pinned to the approved source with the perturbation suites proving the
approved source moves every budget figure and the working lines no longer
do). Rules **33 files / 2,093 tests** (new `budgetApprovals.rules.test.js`,
**51** — read matrix, the capture pair by role / tenant / agreement / clock /
currency / end-entry pins incl. another project's line and a missing cost
code, the DC44 proofs (garbage and duplicate middle entries ACCEPTED), the
2,000-entry worst-case write, the app's capture, the approval pair by role,
without the pointer, mismatched version / actor / clock / identity, stamps-only
+1, the later version's +1 / different id / frozen original, approved
immutability, snapshot immutability, pointer forgery, the app's approve incl.
drift by key, SUPERSEDED, TWO CONCURRENT approvals landing exactly one
version 1, the retry guard, and withdraw by capturer / approver only,
terminal; `commercialBaseline.rules.test.js`, **36** — read / create / update
matrices, money, dates, client, notes, exact keys, stamps, provenance, legacy
documents, delete blocked, and the legacy original scalar frozen once a
version exists while the live bundle's unchanged re-send passes). Lint 0 / 0;
build clean; `rules:transitional:check` clean; `git diff --check` clean.
FINAL `firestore.rules` 218,840 → **234,479 bytes** (+15,639; 10,521 under
budget); transitional **235,159** (the same four marked lines).

**Manual (three checks, after both steps of the DEPLOYMENT.md release order):**

1. On a project with budget lines and no approved version, every surface
   (Budget, Forecast, Commercial, Overview, BOQ, Tenders, PULSE indicator 1,
   Dashboard snapshot) labels the figure *Working budget (not approved)*; as a
   QS, *Prepare approval* captures a draft (the preview names the lines, the
   total and the size); the *Approve* button is absent for the QS and present
   for a Project Manager, who approves it as version 1. Every surface now reads
   *Approved Budget · version 1* with the captured total; the Budget tab shows
   an *Approved v1* column beside *Working*; the Commercial tab's Original
   Approved Budget reads version 1's total and is no longer editable.
2. Edit a working budget line after approval: the Approved Budget, Variance to
   Budget, PULSE and the Dashboard do not move; the Budget tab shows the
   pending difference and *⚠ differs from approved* on the line; Actual,
   Remaining Committed, Forecast Final Cost, Gross Profit, Remaining Payable
   and Cash Flow are unchanged. Prepare and approve version 2: it becomes
   current, version 1 stays in the history unchanged, and the Original Approved
   Budget still reads version 1.
3. Open the same draft in two browser tabs and approve in both: the second
   reports *Another budget version was approved…* and the history shows one
   version. On the SHIELD tab, check 6 reads *No issue found* naming the
   version; a `subcontractor` sign-in cannot read any approval document.

## 48. Constrapp SHIELD™ 2B2 — Controlled Budget Adjustments (ADR-71) — LIVE in production (confirmed by the Product Owner)

**What is enforced.** An adjustment (`budgetAdjustments/{id}`) is ONE movement
— increase, decrease or transfer between two different cost codes — of a
positive whole-cent amount, bound at preparation to the pointer's ACTIVE
version (no pointer: refused). Approval writes the record and the pointer's
ledger in one commit (rules pair them with `getAfter()` both ways: count
exactly +1, `sequence` == the new count, net moved by exactly `+amount` /
`−amount` / `0`, active version frozen) — by `company_admin` /
`project_manager` only; approved and withdrawn are terminal. Every version
approval resets the ledger to zero, so a superseded adjustment never counts
twice. The Approved Budget shown anywhere is the active snapshot PLUS the
active version's approved adjustments, reconciled against the ledger; any
mismatch, or a cost code below zero, makes every budget figure Unavailable.
What rules cannot prove is Deferred Control 45.

**Automated.** Unit — `budgetAdjustment.test.js`, **56** (movement model and
derived net; the exhaustive two-decimal sweep 0.01–10,000.00 and large
values; draft validation and normalisation; the resulting-balance preview —
below zero refused, exactly zero allowed, a new cost code receiving budget;
staleness, history, labels; the adapter — 1,000,000 + 50,000 = 1,050,000,
transfers net zero, new cost codes, drafts never counted, and UNAVAILABLE for
a missing / extra record, a sequence gap or duplicate, a net mismatch, a
foreign-version record, a malformed amount or type, a foreign currency, a
negative cost code, a malformed ledger, a stale last-adjustment reference, a failed or absent read; LOADING
while the read settles; the Original stays version 1; NO DOUBLE COUNTING
across a re-approval (1,050,000 captured → 1,050,000, not 1,100,000; the
unchanged register → 1,000,000); the supersession summary and its key;
parity — Forecast rows, totals, BOQ, tenders, the Dashboard snapshot, PULSE
and SHIELD check 6 read the same adjusted figure while Actual, Remaining
Committed, FFC, Cost to Complete, payables, cash and margin do not move;
structure — the Budget page and the review dialog use the shared selectors,
no other module folds movements, the listener opens only when the ledger
records adjustments); `budgetAdjustmentActions.test.js`, **24** (server read
before the transaction, every read before any write, the exact writes, the
idempotent same-id prepare, NO_BASE / STALE_BASE / SUPERSEDED / NEGATIVE /
PERMISSION outcomes, the lost-race mapping, retry never applying twice, and
the re-approval supersession guard and ledger reset). Rules —
`budgetAdjustments.rules.test.js`, **67** (read matrix; prepare matrix and
every refusal; the two-decimal pin accepting 26 and refusing 9 boundary
values; the approval pair both ways — wrong sequence, +2, wrong net per type,
foreign pairing, stale base, forged ledger writes, branch confinement;
immutability and withdrawal including a stale draft; the ledger reset — an
old-bundle re-approval fails closed, a legacy pointer re-approves unchanged,
version + adjustment in one commit refused, a kept last-adjustment
reference refused, a non-empty ledger or reference at creation refused; the app's transactions — prepare → approve, contingency as a
transfer, double-click, NO_BASE, NEGATIVE, QS refused, retry, two CONCURRENT
approvals, the re-approval race, no double counting, the acknowledgement
refusals; DC45 — a forged below-zero approval is accepted by the rules and
the adapter fails closed). Totals: unit **76 files / 4,331**; rules **34
files / 2,160**. Lint 0 / 0; build clean; `rules:transitional:check` clean;
`git diff --check` clean. FINAL `firestore.rules` 234,479 → **241,924 bytes**
(3,076 under budget); transitional **242,604**.

**Manual (three checks, after both steps of the DEPLOYMENT.md release order):**

1. On a project with an approved version, as a QS prepare a **transfer** of
   10,000 from one cost code to another and an **increase** of 5,000 (each
   dialog shows the resulting per-code figures; a transfer larger than the
   source's approved figure cannot be saved). As a Project Manager approve
   both: the Budget tab's summary shows the version base unchanged, net
   adjustments +5,000 and Current Approved Budget base + 5,000; the table
   shows one *Approved adjustments · net* row per affected code; Forecast,
   Commercial, BOQ, PULSE and the Dashboard read the same figure captioned
   *version N + 2 adjustments*; Actual, Remaining Committed, Forecast Final
   Cost, Gross Profit, Remaining Payable and Cash Flow are unchanged; SHIELD
   check 6 reads *No issue found* naming the two adjustments.
2. Without editing the working lines, prepare a new budget version and open
   its review: it shows the current adjusted total, the proposed total, the
   −5,000 difference, both adjustments as superseded and the per-code
   changes, and *Approve* stays disabled until the acknowledgement is ticked.
   Approve it: the Approved Budget equals the captured total (no adjustment
   counted twice), the two adjustments remain in the history as superseded,
   and a draft prepared before the re-approval shows *Stale · withdraw only*.
3. Open the same draft adjustment in two tabs as two approvers and approve in
   both: one succeeds and the other reports *Another budget adjustment was
   approved…* (or that it is no longer a draft); the ledger shows ONE
   approval. A `subcontractor` sign-in cannot read any adjustment.

## 49. L1 — Trusted Backend & Team Management (ADR-72) — LIVE in production (confirmed by the Product Owner, 11 November 2026)

**Production acceptance record (11 November 2026, `https://app.constrap.com`,
reported by the Product Owner).** Passed:

- All eight callables deployed in `australia-southeast1` on Node.js 22, with App
  Check enforced on the callables.
- **App Check refusal probe (release order step 2) — PASSED.** A production
  `POST` to `listTeam` with **no** App Check token returned `HTTP/2 401` with
  `{"error":{"message":"Unauthenticated","status":"UNAUTHENTICATED"}}`. The
  subsequent authenticated `listTeam` request returned `HTTP 200`.
- **Check 1 (invitation end-to-end):** the invitation email was delivered
  through Resend, the invitation was accepted, and the new member worked as
  **Project Manager** with the expected permissions.
- **Check 3 (deactivation):** the member was deactivated and lost access.
- Regressions: Quant™ PDF viewing and Storage; Authentication. Azure CI
  green on `main`.

**Not recorded as run (do not treat as verified):** the check 2 guards (the
last-admin refusal with two admins, self-demotion, and resend making the old
link *not valid*); check 3's two sub-steps — whether an open screen showed data
written AFTER the deactivation, and the *Welcome back* re-invitation of the
same email. General App Check enforcement for Firestore, Storage and Authentication
is **OFF**, and no App Check monitoring period has been completed.

**Automated.**

- `frontend/functions/test/` (pure, `npm --prefix functions test`, also the
  Functions predeploy hook): tokens (256-bit, hash-only, constant-time,
  fragment link), strict input schemas, error codes, derived invitation
  states, legacy-profile semantics, email rendering and the Resend adapter
  (no retry on 4xx, one retry on 5xx, idempotency key), the emulator-only
  outbox guard, and the callable surface (eight handlers, App Check, one
  region, secret binding, instance cap, kill switch, unauthenticated refusal).
  Also run on **Node.js 22** (the production runtime).
- `frontend/tests/functions/` (`npm run test:functions` — Auth + Firestore +
  Functions emulators):
  - `team.handlers.test.js` — the handlers against real transactions and Auth
    records: unauthenticated, no-membership, deactivated and non-admin
    callers; every internal role; wrong-company targets; invitation creation,
    normalisation, duplicate and already-member refusals, email failure then
    resend, unconfigured URL, rate limits; token rotation, revocation, expiry,
    the ten-guess lock and its reset; generic refusals for unknown and
    cross-company ids; every preview account state including reactivation and
    `blocked`; acceptance (atomic, idempotent, email-bound, operator links not
    email-verified, other-company and already-member refusals, concurrent
    acceptance → one membership); listing with legacy and operator-managed
    members; role changes (self, stale, operator, unknown, unsupported,
    concurrent last-admin); deactivation (history kept, Auth disabled, refresh
    tokens revoked, idempotent, last admin, concurrent mutual deactivation,
    injected Auth failure → pending → repeat completes); reactivation with the
    same uid; the kill switch.
  - `team.callable.test.js` — the DEPLOYED wrappers through the Functions
    emulator over the callable protocol: a request without App Check is
    refused before the handler (401); typed refusals; the full
    invite → preview → browser-SDK registration → bare account refused →
    accept → list → role change → deactivate flow; malformed input over the wire.
  - `team.revocation.test.js` — the client SDK reading THROUGH THE RULES: a
    bare Auth account reads nothing; after deactivation every new request is
    denied and the member's own profile listener delivers the loss; a role
    change applies on the next request. **Observed in the Firestore emulator
    (4 November 2026): already-open company and project listeners received
    `permission-denied` after the deactivation** — recorded, not asserted;
    production is check 3 below.
  - `scripts.test.js` — `bootstrap-company.mjs` (argument validation, dry run
    writes nothing, company + operator invitation + link printed once,
    acceptance makes the first admin, idempotent re-run, rotation instead of a
    second invitation, refusal of an ambiguous rename — *as written for L1;
    since operator tooling safety the link is never printed and rotation needs
    `--rotate`, §70*) and
    `reconcile-membership.mjs` (report vs `--fix`; only the pending Auth sync is
    fixed).
- `tests/rules/teamPaths.rules.test.js` — every browser role, including
  `company_admin`, is denied get / list / create / update / delete on
  `invitations`, `members`, `auditEvents`, `rateLimits`, `devOutbox` and
  `system/membership`; `users/{uid}` stays client-read-only; a deactivated
  profile (`companyId: null`) reads nothing of the company. **No rules bytes
  changed** (241,924).
- `tests/unit/team.test.js` and `tests/unit/teamSurface.test.js` — the pure
  client helpers (fragment parsing, sessionStorage hand-off, accept steps,
  membership gate, error copy) and the routing / gate / hooks-only / App Check
  / dialog contracts.

**Manual (three checks, after the DEPLOYMENT.md → L1 release order):**

1. **Invitation end-to-end.** As the bootstrapped Company Admin, open Company
   Settings → Team and invite a mailbox you control as *Project Manager*. The
   email arrives from the verified sender; the link opens `/accept-invite`
   and the address bar loses the `#c=…&t=…` part immediately. Create the
   account (12+ characters) — you land on the Dashboard as Project Manager;
   Team shows the member active and no pending invitation. Opening the same
   link again reports *already been used*.
2. **Guards.** As that Project Manager, Company Settings → Team shows the
   read-only notice. As the admin, try to demote yourself (no Change role
   button on your own row) and, with a second admin, demote one while the
   other is the only admin left: *A company must keep at least one active
   Company Admin*. Resend an invitation: the old link reports *not valid*,
   the new one works.
3. **Deactivation in production.** With the Project Manager signed in on a
   second browser and a project open, deactivate them. Within seconds the
   second browser leaves the project screens and shows the sign-in page (the
   gate signs it out); signing in again shows *This account has been
   disabled*. Record whether any open screen showed data written AFTER the
   deactivation (expected: none). Re-invite the same email: the link reports
   *Welcome back*, sign-in (or *Forgot password?*) works, and the member
   returns with the same history.

## 50. Brand — Constrap (chore/constrap-branding) — LIVE in production at `https://app.constrap.com` (confirmed live on 11 November 2026)

Presentation only: no rule, field, collection, financial formula or
permission changed. Run on the Hosting preview (or production after release)
at the existing `web.app` origin; repeat step 4 at `https://app.constrap.com`
(confirmed live on 11 November 2026 — DEPLOYMENT.md → *Custom domain —
app.constrap.com*).

**Recorded so far (11 November 2026):** the live tab title reads *Constrap*
(observed), and the L1 acceptance delivered a Resend invitation from the
`constrap.com` domain whose link was accepted on the production origin (part
of step 4). The checkboxes below have **not** been recorded as run in full;
leave them unticked until they are.

1. - [ ] Signed out: the browser tab reads **Constrap**; the sign-in page shows
      the **Constrap** wordmark, *Access your Constrap workspace.* and the
      "About Constrap" product panel at ≥ lg. `/create-account` reads
      *Constrap accounts are created by invitation.*
2. - [ ] Signed in: the sidebar wordmark reads **Constrap**; the PULSE,
      SHIELD, Quant and GANTT tabs head with *Constrap PULSE™*, *Constrap
      SHIELD™*, *Constrap Quant™* and *Constrap GANTT™*. No screen shows
      "Constrapp".
3. - [ ] Existing data, sign-in, a pending invitation link created before the
      release, and an unsaved Quant™ draft (sessionStorage) all still work —
      their keys and identifiers were deliberately not renamed.
4. - [ ] Once L1 email is configured: a new invitation's subject reads
      *You're invited to {company} on Constrap*, arrives from
      `invites@constrap.com`, and its link opens the configured
      `APP_BASE_URL`'s `/accept-invite`.

## 51. DC46-A — Authenticated Storage downloads (ADR-73) — LIVE IN PRODUCTION (11 November 2026)

> **Status at DC46 closeout (18 November 2026).** Deferred Control 46 was CLOSED on 18 November 2026 with accepted risks (§59). Statements below that it "stays OPEN", or that reconciliation is off, are the record as written at the time.

**Recorded by the Product Owner, 11 November 2026:** drawing viewer — pass;
General Documents — pass; Quant PDF and image viewing — pass; iPhone Safari —
pass; deactivated member denied new Open / Download requests — pass.
**Android Chrome — NOT YET TESTED** (step 12). Steps not named here were not
reported individually.

Hosting only. Use a TEST company and TEST files; never open, copy or record a
customer's file or URL. Deferred Control 46 stays OPEN after this section
passes — step 9 is expected to show that.

**Automated (must pass first):** `tests/unit/fileBlob.test.js`,
`tests/unit/storageDownloads.test.js`, `tests/unit/files.test.js`,
`tests/rules/storage.rules.test.js` 47–57.

**Desktop (Chrome, Safari, Firefox)**

1. - [ ] Drawing with a PDF revision: the preview appears below the buttons;
      **Open** shows the PDF in a new tab whose address begins `blob:`;
      **Download** saves a file with the ORIGINAL uploaded filename.
2. - [ ] The same for a PNG and a JPEG revision (inline image, Open, Download).
3. - [ ] Switch revisions quickly: no stale preview, the new revision loads,
      and a tab opened for the earlier revision still shows and reloads.
4. - [ ] Leave the drawing page with an opened PDF tab still open: the tab
      still scrolls, searches and prints.
5. - [ ] General Documents → **Open** for a PDF and an image; with popups
      blocked, the file is saved instead and the notice says so.
6. - [ ] DevTools → Network while doing steps 1–5: no request URL contains
      `token=`; the address bar and page source never show
      `firebasestorage.googleapis.com/...token=`.
7. - [ ] Quant: open a PDF sheet and an image sheet; calibrate, measure a
      length, an area and a count; switch page and revision. Results match a
      pre-release measurement of the same sheet.

**Access control (two browsers, test company)**

8. - [ ] As a test member, open a drawing. Have an admin **deactivate** that
      member. Without reloading, press Open / Download / switch revision:
      *You do not have permission to open this file.* within seconds.
9. - [ ] **Expected to still work (DC46 is open):** a download URL for a test
      object obtained BEFORE this release opens in a private window. Record
      the result; do not treat it as a failure of this release.
10. - [ ] A member of a second test company cannot open the first company's
       drawing by any route the app offers; a subcontractor cannot open an
       `internal` document.
11. - [ ] Re-invite the deactivated member; after accepting, files open again.

**Mobile and large files**

12. - [ ] iPhone Safari and Android Chrome: opening a PDF drawing page starts
       NO file download (Network / data counter) until Open or Download is
       tapped. Open shows the PDF (iOS) or saves it under its real filename
       with the notice (Android without a PDF viewer). Download keeps the
       filename.
13. - [ ] A drawing close to 50 MB on a throttled connection (DevTools *Fast
       4G*): the buttons show progress text, the file opens, and the tab
       stays responsive. Note the time taken.
14. - [ ] Go offline and press Open: a readable error, the placeholder tab
       closes, and a retry after reconnecting works.

## 52. DC46-B — Legacy download-token revocation (ADR-74) — LIVE IN PRODUCTION (deployed and accepted, 12 November 2026)

> **Status at DC46 closeout (18 November 2026).** Deferred Control 46 was CLOSED on 18 November 2026 with accepted risks (§59). Statements below that it "stays OPEN", or that reconciliation is off, are the record as written at the time.

**Production acceptance record — 12 November 2026 (`constrapp-69b5d`).**
Constrap had not launched; the only company was the Product Owner's
development tenant, so "test company" below was that tenant. Deployment
sequence and infrastructure checks: DEPLOYMENT.md → *DC46-B* → *Production
release record*. Times are UTC.

| Step below | Result in production |
|---|---|
| 1 — worker runs each minute, silent when idle | **Passed.** Deployed alone first; every run HTTP 200, no log line while the queue was empty |
| 2 — operator dry run | **Passed.** 1 company, 4 objects, 4 with a token; a repeat gave the same counts |
| 12–14 — clean-up, run with `--company-id` (the only company) | **Passed.** Exit 0; *4 scanned, 4 token(s) removed, 0 failed*; dry run afterwards 0 with a token; generation, size and MD5 of every object unchanged |
| 3 — upload a test file, its download URL opens | **Passed** (Product Owner; a disposable PDF; URL taken from the Firebase console, checked with `curl`, never displayed) |
| 4 — deactivate a test member → *revocation pending* | **Passed** (Product Owner). The member had been re-invited first (§49 reactivation: `member.auth_reenabled`, `invite.accepted`) |
| 5 — *revoked*; old URL 403; file still opens in the app | **Passed** (Product Owner). Worker sweep finished 24 s after the deactivation: *5 scanned, 3 removed, 0 failed* |
| 9 — audit events, no token value | **Passed.** `file_links.revocation_requested` (source `callable`, same timestamp as `member.deactivated`) and `file_links.revoked` (source `worker`); no token-shaped string in state, queue, audit events or logs |
| 10 — browsers cannot read the state document | **Not run in the browser.** The published Firestore ruleset is byte-identical to the repository and has no block for either path (default deny); proven in the emulator suite |
| 6 — dialog and notice wording | **Not recorded** as a separate check |
| 7, 8 — overlapping clean-ups; *delayed* after a paused worker | **Not run in production.** Validation project and automated suites only |
| 11 — *not yet revoked* for a member deactivated before the release | **Not recorded** |
| 15 — spot-check customers' Team pages | **Not applicable** — no customers yet |
| 16 — regression §51 (including Android Chrome) | **Not recorded**; Android Chrome is still untested |

**Unexpected in step 5:** three tokens were removed, not one. Two objects
cleaned earlier that day had a token again (`metageneration` 2 → 4). Cause
unproven (no Storage data-access logs; the Firebase console's file panel is
the likely source). Tracked under Deferred Control 46.

Functions first, then Hosting. Use a TEST company and TEST files only; never
capture, open or record a customer's file or URL. Deferred Control 46 stays
OPEN after this section passes.

**Automated (must pass first):** `functions/test/fileLinks.test.js` (the
Storage side and the status rule, fake bucket, plus `listPage` through the
real `@google-cloud/storage` client), `functions/test/handlers.test.js`
(worker options and per-project service accounts), `tests/functions/
team.fileLinks.test.js` (the transactions, lease, checkpoints, audit and
rules denial, Firestore emulator), `tests/functions/scripts.test.js`
(operator script refusals), `tests/unit/team.test.js` and
`tests/unit/teamSurface.test.js` (wording and surface).

**⚠️ What the automated tests do NOT prove.** They use a fake bucket. That
removing a token refuses a real URL was verified once, by hand, against real
Firebase Storage (ADR-74 evidence). Steps 3–5 below are the production check.

**Operator evidence — real Firebase Storage, `constrap-dc46-validation`, 12 November 2026.**
Credential: Application Default Credentials of type
`impersonated_service_account` (the operator's own login impersonating
`file-link-operator@constrap-dc46-validation`; no key file;
`GOOGLE_APPLICATION_CREDENTIALS` unset). The access token's `azp` matched that
account's unique id. That account has roles only in the validation project
(`datastore.user`, the file-link custom role on its bucket), so the credential
cannot act on production; production was not probed. Scheduler paused
throughout, so only the operator ran. Test company `dc46Op`, disposable 60-byte
PDFs, token values never printed (SHA-256 fingerprints).

| Check | Result |
|---|---|
| Default (no flags) | exit 0; *3 objects, 3 with a download token*; objects and revocation state byte-for-byte unchanged |
| `--execute --confirm-project some-other-project` · `--execute` alone | both exit 2 (*--execute needs --confirm-project <the same project id>*); nothing changed |
| `--execute --confirm-project constrap-dc46-validation` | exit 0; *3 scanned, 3 token(s) removed, 0 failed*; 0 tokens left; old URLs **403, 403, 403**; authenticated SDK reads **200, 200, 200**; audit `file_links.revocation_requested` + `file_links.revoked`, source `operator` |
| Same command again | exit 0; *0 token(s) removed*; no object's `metageneration` changed |
| Operator account limited to `storage.objectViewer` on the bucket, one new file with a token | **exit 3**; *NOT complete: 1 object(s) failed. Old links for those objects may still work*; old URL still **200**; `completedSeq` not advanced; `consecutiveIncomplete` 1 |
| Role restored, same command | exit 0; *1 token(s) removed, 0 failed*; old URL **403**; authenticated read **200**; request complete |
| Token values in any script output | none |

**Rehearsal (disposable project) and production pilot (test company)**

1. - [ ] Deploy Functions. In Cloud Logging the worker
      (`processFileLinkRevocations`) runs every minute and logs nothing when
      no company is queued.
2. - [ ] Operator dry run (`--company-id <test company>`): prints object and
      token counts, changes nothing (re-run: same counts).
3. - [ ] As an admin of the test company, upload a test drawing. In the
      browser console obtain its download URL (test company only) and confirm
      it opens in a private window.
4. - [ ] Deactivate a test member. **Immediately:** the member is refused
      (§51 step 8). The Team row shows *Old file links: revocation pending* —
      **not** *revoked*.
5. - [ ] Within a few minutes, after reloading Team: *Old file links:
      revoked*. The URL from step 3 now returns 403 in a private window. The
      drawing still opens in the app (viewer, Download, Quant).
6. - [ ] The deactivate dialog and its success notice say the links are
      revoked by a background clean-up; nothing on the page says
      "immediately" about links.
7. - [ ] Deactivate a second test member while a clean-up is running (large
      test company or rehearsal project): the second member stays *pending*
      until a later clean-up finishes.
8. - [ ] Pause the worker (`FILE_LINK_REVOCATION_ENABLED=false`, redeploy),
      deactivate a test member, wait 15 minutes: *Revocation delayed:
      retrying*. Re-enable: it becomes *revoked*.
9. - [ ] Firestore console: `companies/{c}/auditEvents` holds
      `file_links.revocation_requested` and `file_links.revoked` with a
      sequence and counts, and **no token value** anywhere in
      `system/fileLinkRevocation`, the queue, the audit events or the logs.
10. - [ ] Signed in as a company admin, the browser console cannot read
       `companies/{c}/system/fileLinkRevocation` (permission denied).
11. - [ ] A member deactivated before this release shows *Old file links: not
       yet revoked* until the all-company clean-up, then *revoked*.

**First all-company clean-up (production, Product Owner approval)**

12. - [ ] Dry run `--all-companies`: totals recorded.
13. - [ ] `--execute --confirm-project constrapp-69b5d`: every company
       completes with 0 failed; exit code 0.
14. - [ ] Dry run again: 0 objects with a token in every company.
15. - [ ] Spot-check three customers' Team pages (with their consent or as
       the operator): no row reads *pending* or *delayed*.
16. - [ ] Regression: §51 steps 1–7 and 12 (including **Android Chrome**).

## 53. DC46-C — Periodic token reconciliation, Stage 1 (ADR-75) — WORKER DEPLOYED 13 November 2026; revocation PRODUCTION-ACCEPTED 16 November 2026; periodic reconciliation ACTIVATED 17 November 2026 (2-hour interval)

> **Status at DC46 closeout (18 November 2026).** Periodic reconciliation has been ACTIVE at a 2-hour interval since 17 November 2026 19:16 UTC (§56, §59). The text below is the record as written at the time.

On `main` (`38ab578`). **Manual steps 1–3 below have been run in production;
steps 4–8 have not, and periodic reconciliation is OFF**
(`FILE_LINK_RECONCILE_INTERVAL_HOURS=0`). Switching it on needs its own
authorisation (DEPLOYMENT.md → *DC46-C*). Deferred Control 46 stays OPEN.

**Production acceptance record — 13–16 November 2026 (`constrapp-69b5d`).**
What was accepted is the existing membership-triggered revocation (§52)
running through the Stage 1 worker — not periodic reconciliation, which has
never run in production. The only company was the Product Owner's development
tenant (count-only check: one company document, one company prefix in the
bucket). Deployment and infrastructure checks: DEPLOYMENT.md → *DC46-C* →
*Production release record*. Times are UTC.

| Step below | Result in production |
|---|---|
| 1 — record concurrency and attempt deadline before the deploy | **Done, 13 November.** Concurrency 80, attempt deadline 300 s, on `processfilelinkrevocations-00001-cep` |
| 2 — worker deployed with the interval `0`; ten quiet minutes | **Passed, 13 November.** Revision `processfilelinkrevocations-00002-had`, concurrency 1, max instances 1; 13 consecutive scheduled runs HTTP 200 and silent; no `system/fileLinkReconciliation` document; queue count 0 |
| 3 — deactivate a test member: *pending* → *revoked* as in §52 | **Passed on backend evidence, 16 November** — table below. The on-screen *pending* → *revoked* change, the old URL's status afterwards and in-app access were **not separately recorded** for this run |
| 4–8 — activation, periodic sweep, urgent-before-periodic, approved interval | **Not run. Not authorised** |

Step 3, 16 November — what each party established:

| Time | Backend-confirmed (request logs, worker log, audit trail — read-only) |
|---|---|
| 03:01:44 | `createInvitation` 200; audit `invite.created` |
| 03:02:03 | audit `member.auth_reenabled` (auth account re-enabled by the invitation) |
| 03:02:31 | `acceptInvitation` 200; audit `invite.accepted` |
| 03:06:44 | `deactivateMember` HTTP 200 |
| 03:06:45 | audit `member.deactivated` and `file_links.revocation_requested` (source `callable`, same timestamp, **sequence 3**), then `member.auth_synced` |
| 03:07:02 | worker log `file-links: worker run` on `processfilelinkrevocations-00002-had`: 1 company, urgent 1, periodic 0, action `complete`; audit `file_links.revoked` (source `worker`) |

Counters, identical in the worker log and the audit event: **5 scanned, 1
page, 1 token removed, 0 failed**. Queue markers afterwards: 0 (count-only
query). No warning, error, incomplete sweep or retry in the logs. Scheduler
enabled, every minute, recent attempts all 200. No token value or URL in any
log line or audit field read.

| Product Owner reported (not independently observed) | Corroboration |
|---|---|
| The controlled Project Manager test member was reactivated | Consistent with the invitation events above. The member's identity and role were not read by the verifier |
| A legacy download URL for a disposable PDF returned HTTP 200 before the deactivation | Not observable from the backend. Consistent with the sweep finding exactly one token |
| The member was deactivated through Constrap | Confirmed (`deactivateMember` 200, `member.deactivated`) |
| The test passed | Confirmed for the request, the sweep and its completion |
| The old URL returned 403 afterwards · an authorised user could still open the file | **No result was reported or recorded for 16 November.** Both were verified in §52 on 12 November. Do not quote them for this run |

**An earlier reported pass is not evidence.** Before this run a manual test
was reported as passed, but the logs for that period held only two `listTeam`
requests (16 November 02:27) — no `deactivateMember` call and no worker
sweep. It is not part of this record. Two things can produce a false pass
and should be ruled out in any future run: a member deactivated earlier
already reads *Old file links: revoked*, and deactivating an
already-deactivated member returns success without queuing anything
(`lib/members.js`). Start from an ACTIVE member and confirm the
`deactivateMember` request and the `worker run` line in the logs.

**A scripted production test is not available.** The callables enforce App
Check, whose token comes from reCAPTCHA Enterprise in a real browser; no
debug token is registered for this purpose and no test credential exists.
The acceptance above therefore used the real application, with the backend
evidence read afterwards.

**Automated (must pass first).** Run from `frontend/`; the emulator suites
need Java 21+.

| Suite | Command | Result, 12 November 2026 |
|---|---|---|
| Functions, pure | `npm run functions:test` | 3 files, 70 tests |
| Functions, emulator | `npm run test:functions` | 6 files, 134 tests (51 in the new file) |
| Frontend unit | `npm run test:unit` | 80 files, 4,427 tests |
| Rules | `npm run test:rules` | 35 files, 2,204 tests |
| Lint | `npm run lint`, `npm run functions:lint` | clean |
| Build | `npm run build` | clean |

`tests/functions/team.reconciliation.test.js` uses the Firestore emulator, the
fake bucket and an injected clock. Where a test needs time to pass, the fake
bucket's listing advances the clock by a fixed cost; nothing sleeps.

| Group | What is asserted |
|---|---|
| A. Interval `0` | No cursor read, no company enumeration, no periodic request over repeated runs; urgent revocation unchanged |
| Configuration | Absent and `0` are off and valid; a valid value switches planning on; an invalid value does the urgent work, keeps reconciliation off and fails the run; every env file holds a valid value and production holds `0` |
| B. Eligibility | Due, not due, never swept; a zero-removal sweep writes no audit event and moves the clock to its START; a removal writes `file_links.reconciled`; an incomplete sweep moves nothing; outstanding and backing-off companies get no second request |
| C. Cursor | 250 companies in three bounded invocations, each examined once; budget-limited batches; a failed batch repeated without duplicates; companies added and removed mid-pass; five corrupted shapes; resume after a valid cursor; two planners at once; a cursor changed underneath; invalid ids; planning failure does not stop urgent work |
| D. Priority and fairness | Urgent before periodic; routine run bounded to 45 s plus one page; large company yields and resumes from its checkpoint; any number of yields is not a failure; a lone company is not sliced; routine share under endless urgent work; hard stop; no company served twice while another waits; same-company pre-emption without false completion; urgent sweeps never restarted |
| E. Failure | Failed listing resumes; HTTP 400, 410, 404 and 403 while resuming keep the checkpoint and restart nothing; a position refused for good ends in five failures, a backoff and a fresh sweep from the first page; five consecutive failed runs close as incomplete; a new urgent request then clears the backoff; killed runs count as failures; failures must be consecutive; a persistent conditional-update failure is never complete; repeated runs after success change nothing |
| Fairness under stress | A killed run does not keep its company at the front; sustained urgent arrivals do not starve a waiting company; a page slower than the whole run only yields; work finished elsewhere mid-run is passed over and new work is picked up next run; planning pauses on a full periodic queue |
| Overdue | Counted each pass, error log, one audit per episode, cleared by success |
| F. Isolation | Only the company's own prefix listed and changed (including a prefix that begins with another company's name); no token value or URL in any document, log or result; bounded log line |

**⚠️ What these tests do NOT prove.** They use a fake bucket and an injected
clock. Not measured or verified anywhere: how long a real page takes; whether
the 60 s / 30 s slices and the 45 s routine share suit real workloads; which
error Cloud Storage returns for a stale page token (none is assumed); Cloud
Scheduler's behaviour when an overlapping tick is refused. (`concurrency: 1`
on the deployed function was confirmed on 13 November 2026.) No latency
figure may be quoted from this section.

**Manual, in production.** Steps 1–3: run — see the acceptance record at the
head of this section. **Steps 4–8: NOT RUN, NOT AUTHORISED — and superseded
for activation by §56** (one deploy at the selected 2-hour interval instead
of a short interval followed by the approved one; step 6 is not run in
production — emulator evidence only). Development
tenant only, test files only, after explicit authorisation.

1. - [ ] Read-only: record the deployed worker's concurrency and the
      Scheduler job's attempt deadline before the deploy.
2. - [ ] Deploy the worker with the interval `0`. For ten minutes: every run
      succeeds and logs nothing; no `system/fileLinkReconciliation` document
      exists; the queue is empty.
3. - [ ] Deactivate a test member: *pending* → *revoked* exactly as in §52.
      *(Accepted on backend evidence; record the old URL's 403 and in-app
      access explicitly the next time this step is run.)*
4. - [ ] With authorisation, set a short interval and redeploy the worker.
      Within about an hour a `file-links: reconciliation plan complete` log
      line appears and the cursor document exists.
5. - [ ] Obtain a download URL for a test file (it opens). Make no membership
      change. After the next periodic sweep the URL returns **403**, the file
      still opens in the app, and the audit trail has `file_links.reconciled`
      with a count and no token value.
6. - [ ] While a periodic sweep is queued, deactivate a test member: that
      revocation completes first **and is audited `file_links.revoked`**.
      *Required the callable deploy first — with the ADR-74 callables this
      audit event was not written (§54, group 6). That deploy was done on
      16 November 2026 (§55); run §55's outstanding deactivation check
      before this step.*
7. - [ ] A company with no tokens is swept without an audit event.
8. - [ ] Set the approved interval and redeploy. Regression: §51 and §52.

## 54. DC46-C — Callable compatibility and monitoring readiness (16 November 2026) — tests merged; alert policies A and B CREATED in production 16 November 2026; delivery test run and removed

> **Status at DC46 closeout (18 November 2026).** Deferred Control 46 was CLOSED on 18 November 2026 with accepted risks (§59). Statements below that it "stays OPEN", or that reconciliation is off, are the record as written at the time.

Branch `ops/dc46-c-monitoring-readiness` (merged, `5615239`). No production logic changed: two
test files, two proposed alert-policy files and one temporary delivery-test
policy file, documentation. Deferred Control
46 stays OPEN; periodic reconciliation stays OFF.

**Automated.** Run from `frontend/`; the emulator suites need Java 21+.

| Suite | Command | Result, 16 November 2026 |
|---|---|---|
| Functions, pure | `npm run functions:test` | 3 files, 70 tests (unchanged) |
| Functions, emulator | `npm run test:functions` | 7 files, 148 tests (14 in the new file) |
| Frontend unit | `npm run test:unit` | 81 files, 4,438 tests (11 in the new file) |
| Rules | `npm run test:rules` | 35 files, 2,204 tests (unchanged) |
| Lint | `npm run lint`, `npm run functions:lint` | clean |

`tests/functions/team.callableCompat.test.js` — the Firestore emulator, the
fake bucket and an injected clock, as in §53. Membership requests go through
the real `deactivateMember` handler.

| Group | What is asserted |
|---|---|
| 1. Periodic request queued | A deactivation makes the state and the marker `urgent`, keeps the company's place in the queue, and ONE sweep covers both; audited `file_links.revoked`, never `file_links.reconciled`; with reconciliation on it is served in the urgent phase and not requested again |
| 2. Periodic sweep completed earlier | The stale `periodic` priority is overridden; the sweep is urgent and is audited `file_links.revoked` even when it finds no token; a role reduction and an operator request behave the same |
| 3. Periodic sweep open | The periodic sweep is superseded once and never completed; the urgent sweep starts from the first page after the deactivation (a token re-minted behind the old checkpoint is removed); two deactivations supersede it once; a deactivation landing inside a running periodic sweep is not covered by it — the member stays *pending* until a second, urgent sweep completes |
| 4. Concurrency | Two deactivations and the planner at once: distinct consecutive sequences, one marker, urgent wins, nothing lost, nothing completed early; a deactivation racing the worker's own transactions; three deactivations at once |
| 5. Interval `0` | The DC46-B path exactly: request, sweep, `file_links.revoked`, status; no cursor read, no periodic field, no reconciliation event; idle runs write and log nothing |
| 6. **Deployment skew (characterisation)** | The documents the ADR-74 callable build writes, served by the Stage 1 worker. Interval `0`: correct. After a periodic request has existed: swept and completed, but recorded as periodic — no `file_links.revoked`, no audit event when no token is found, and an open periodic sweep is not superseded. This is why the callable deploy had to precede activation (DEPLOYMENT.md → *DC46-C monitoring readiness*) |

Group 6 describes two builds side by side, not desired behaviour. If the
worker is ever made tolerant of the old documents, rewrite it. **Since
16 November 2026 production no longer runs that pairing** — the eight
callables were redeployed from `main` (§55). Group 6 now characterises a
past deployment, and what a rollback of the callables to the ADR-74 build
would bring back; the test file's header comment still calls the ADR-74
build "the build deployed on 12 November 2026", which is accurate as
history.

`tests/unit/monitoringPolicies.test.js` keeps the three files in
`ops/monitoring/` honest: no recipient, channel or address committed; each
policy scoped to the one worker service and region; policy A summed across
revisions with a 15-minute absence; policy B limited to container output,
rate-limited, with no log content extracted; policy B's runbook names every
error line the worker can write; the temporary delivery test watches policy
A's exact series, fires on healthy traffic and says it is a test.

The files were also checked field by field against the Cloud Monitoring
API's published schema (every field and enumerated value exists). That check
was run by hand on 16 November 2026 and is not part of the suite.

**⚠️ What these tests do NOT prove.** Nothing about Cloud Monitoring: the
policy files are checked as text. The filters were replayed read-only against
production on 16 November 2026 (DEPLOYMENT.md), but **the suite creates no
policy, sends no notification and fires no alert.** What was done in
production is the manual acceptance below. The
emulator tests use a fake bucket; nothing here ran against real Cloud Storage
or a deployed callable.

**Production monitoring acceptance — 16 November 2026 (run by the Product
Owner; verified read-only).** The verification checklist and the delivery
test in DEPLOYMENT.md → *DC46-C monitoring readiness*. Google provides no
test function for an email channel, so delivery was exercised by one
temporary policy that fires on healthy traffic. Times are UTC. *Cloud* means
read from the Monitoring API, the audit log or Cloud Logging; *Reported*
means stated by the Product Owner and not independently observed. Nothing in
it stopped, paused or broke the production worker.

| Step | Result | Evidence |
|---|---|---|
| Two email channels created | `DC46 - Product Owner` 17:20:55; `DC46 - Billing Administrator` 17:23:06; both enabled, two distinct addresses | Cloud |
| Policies A and B created | A 18:23:12; B 18:24:26; both enabled, identical to the committed files, each with both channels | Cloud |
| API accepted the values | Including policy B's one-hour rate limit | Cloud |
| Policy A receives data | One point a minute since creation; no open incident | Cloud |
| Temporary policy created | 18:26:30, with both channels | Cloud |
| Test condition met, incident opened | 18:29:30 | Cloud |
| Product Owner received the email | Yes | Reported |
| Billing administrator received the email | Yes | Reported, through the Product Owner |
| Temporary policy deleted | 18:37:51 | Cloud |
| Test incident closed | 18:38:51 | Cloud |
| Clean-up | Exactly two policies remain, none named `TEST`; one incident in total, closed | Cloud |
| Worker and Scheduler throughout | Revision unchanged, interval `0`, job enabled, 60 of 60 attempts returned 200 in the preceding hour; no Functions, Rules or IAM change in the audit log | Cloud |

**Limits of this validation.**

- Email arrival is reported, not observed: no per-recipient delivery record
  was found. The arrival times and the incident id shown in the email were
  not recorded.
- The delivery test shows that the channels deliver and that the filter and
  aggregation select the live series. It does not show that an absence opens
  an incident or that policy B matches.
- **Neither permanent failure condition was deliberately triggered in
  production.** Policy A has never opened an incident. *Corrected
  25 November 2026 (C1-D):* policy B **has** matched once, on the predicted
  first-pass overdue line at activation (17 November 2026; incident 19:18:06
  – 18 November 19:22:24 UTC; §73). *As written:* "policy B has never
  matched a line."
- The billing administrator's receipt says nothing about billing alerts, a
  budget or the billing account; billing continuity is still unconfirmed.

**Not testable in production, and unverified until tested elsewhere:**
policy A firing on a real absence; policy B firing on a real error. **Not
testable at all:** what Cloud Monitoring does during a billing suspension.
Policy A is not claimed to detect one, nor the deletion of the worker
service (Google documents that a deleted or shut-down resource raises no
absence alert).

## 55. DC46-C — Eight-callable deployment (16 November 2026) — DEPLOYED and PRODUCTION-ACCEPTED; deactivation regression on the new revisions PASSED 16 November 2026

> **Status at DC46 closeout (18 November 2026).** The callables described here (`-00003-*`) were replaced by `-00004-*` on 17 November 2026 (§57); periodic reconciliation was activated on 17 November 2026 (§56). The text below is the record as written at the time.

Release record: DEPLOYMENT.md → *DC46-C* → *Callable release record*. A
deploy of the eight team callables only, from `main` `44446a0`; the worker
was not redeployed. No code changed for it. Deferred Control 46 stays OPEN.

**Automated — release gates, run on `main` `44446a0` before the deploy
(16 November 2026).** From `frontend/`; the emulator suites need Java 21+.

| Gate | Command | Result |
|---|---|---|
| Functions lint | `npm run functions:lint` | clean |
| Functions, pure | `npm run functions:test` | 3 files, 70 tests |
| Functions, emulator | `npm run test:functions` | 7 files, 148 tests — includes the 14 in `team.callableCompat.test.js` (§54) |
| Rules | `npm run test:rules` | 35 files, 2,204 tests |
| Frontend lint | `npm run lint` | clean |
| Frontend unit | `npm run test:unit` | 81 files, 4,438 tests |
| Production build | `npm run build` | succeeded |
| Whitespace | `git diff --check` | clean; working tree clean afterwards |

The deploy's own predeploy hook runs the Functions lint and pure tests
again; its output on the day was not recorded.

**Production verification (16 November 2026, UTC).** **Cloud** = read-only
inspection; **Reported** = stated by the Product Owner.

| Check | Result | Evidence |
|---|---|---|
| Eight new revisions, ACTIVE, 100 % traffic | `listteam-00003-qon`, `createinvitation-00003-pup`, `resendinvitation-00003-nem`, `revokeinvitation-00003-wag`, `previewinvitation-00003-juq`, `acceptinvitation-00003-giw`, `changememberrole-00003-meb`, `deactivatemember-00003-qey` | Cloud |
| Build | Hash `afc3ba3a…` on all eight (before: `53bb71de…`); the `deactivateMember` source archive identical to `main` | Cloud |
| Configuration | `nodejs22`, 30 s, 256 Mi, max instances 5, concurrency 80, default compute account, `EMAIL_API_KEY` version `1` — unchanged; `FILE_LINK_RECONCILE_INTERVAL_HOURS=0` added to each | Cloud |
| No App Check token, no sign-in | HTTP 401 `UNAUTHENTICATED` from each of the eight, 20:24:14–20:24:17, on the new revisions | Cloud |
| Invoker IAM, secret accessors | unchanged; no IAM change in the audit log | Cloud |
| Worker and Scheduler | `processfilelinkrevocations-00002-had`, concurrency 1, max instances 1, interval `0`; job enabled, every minute; 60 of 60 attempts returned 200 in the preceding hour | Cloud |
| No reconciliation | no reconciliation log line; queue count 0; no cursor document | Cloud |
| Monitoring | policies A and B enabled, both channels attached; no open incident; no temporary policy | Cloud |
| Hosting, Rules | no release since 12 November and 3 November | Cloud |
| `listTeam` on the new revision | `OPTIONS` 204 and `POST` 200 on `listteam-00003-qon` at 20:22:51 | Cloud |
| Team page in the live app | Rendered: two active administrators, the previously deactivated test member still deactivated, no pending invitation, no visual or loading error (screenshot supplied) | Reported |

The screenshot and the 20:22:51 log entry are separate evidence. The
screenshot is not proof of that exact request, and the log entry does not
name the caller.

**Limits of this validation.**

- *(At the deploy.)* No membership-changing call had been made on the new
  revisions in production. **Superseded the same day:** the deactivation
  regression below exercised `createInvitation`, `previewInvitation`,
  `acceptInvitation` and `deactivateMember`.
- Sign-in and company authorisation are evidenced by the deployed source
  being identical to the tested source and by one successful administrator
  call — not by exercising each refusal in production. A scripted
  production test is still not available (§53).
- Nothing about the request priority can be observed at interval `0`.

**Production deactivation regression — PASSED, 16 November 2026
(22:58–23:13 UTC).** Run once by the Product Owner on the development
tenant, on explicit authorisation, from the previously deactivated test
member (re-invited first, so the run started from an ACTIVE member). Each
step confirmed in the backend, not from a report alone. **Do not repeat it
for activation.** **Cloud** = read-only inspection (request logs, worker
log, Firestore, Storage object versions — never a token value);
**Reported** = stated by the Product Owner.

1. - [x] Re-invite and accept: `createInvitation` 22:58:30, `previewInvitation`
      22:58:50, `acceptInvitation` 22:59:15 — each HTTP 200 on a `-00003-*`
      revision; audit `invite.created`, `member.auth_reenabled`,
      `invite.accepted`. The member was then an active project manager with
      sign-in enabled; four invitations, all accepted. *(Cloud)*
2. - [x] A legacy download URL for the disposable test PDF opened before the
      deactivation. *(Reported, 23:09; the object's version counters were
      unchanged since 03:07:57 — Cloud)*
3. - [x] `deactivateMember` HTTP 200 on `deactivatemember-00003-qey` at
      23:12:48. Audit, one transaction at 23:12:49.398: `member.deactivated`
      and `file_links.revocation_requested`; then `member.auth_synced` at
      23:12:49.550. The request's trace id equals the audit `requestId`.
      *(Cloud)*
4. - [x] Company state: request sequence 3 → **4**, `requestPriority: urgent`,
      `queuedAt` written — fields the ADR-74 callable build never wrote, so
      the new build served the request. *(Cloud)*
5. - [x] Worker `processfilelinkrevocations-00002-had`, 23:13:02:
      `file-links: worker run`, sequence 4 **complete — 5 objects scanned,
      1 page, 1 token removed, 0 failed**; audit `file_links.revoked`, source
      `worker`, 23:13:02.460; the test PDF's metageneration 5 → 6 at
      23:13:02.373; queue count **0**; no cursor document (interval `0`; no
      periodic reconciliation occurred). *(Cloud)*
6. - [x] The old URL returned **HTTP 403**, and an authorised user still
      opened the PDF in the app. *(Reported — both recorded this time)*
7. - [x] Both company administrators remain active; the test member is
      deactivated. *(Cloud)* — `changeMemberRole`, `resendInvitation` and
      `revokeInvitation` were **not exercised** on the new revisions.

**Afterwards (read-only, 16 November 23:51 UTC):** state 4 / 4, queue 0, no
cursor document, interval `0`; the test PDF still at metageneration 6, last
updated 23:13:02.373 — so no token was re-created by the 403 check or the
in-app open (inferred from version counters; no token value was read).

**What this does not show.** The request-priority behaviour against a
periodic request (pre-emption) — impossible at interval `0`; emulator
evidence only (§53 group D, §54, §56). The cause of the two earlier token
re-creations (§53, DEPLOYMENT.md → *DC46-C*).

## 56. DC46-C — Activation, 2-hour interval (17 November 2026) — PERFORMED 17 November 2026 19:16 UTC; policy C CREATED and enabled; steady state OBSERVED

> **Status at DC46 closeout (18 November 2026).** Policy C was created on 17 November 2026 before activation; the worker was deployed alone at interval `2` at 19:16 UTC (`processfilelinkrevocations-00003-ceg`, `main` `2b3ba9a`). Observed read-only: heartbeats hourly from 19:17 (overdue 1 on the first pass, as predicted, then 0); periodic sweeps 19:18:02 (5 scanned, 0 removed), 22:19:02 (5, 0; 181 minutes later) and 18 November 00:21:02 (9, 4 removed), all complete with zero failures. The checklist items below that were written as outstanding are covered by that evidence and §59. The text below is the record as written at the time.

Branch `feature/dc46-c-activation-readiness` (uncommitted at the time of
writing). Architect decision, 17 November 2026: prepare an initial interval
of **2 hours**; **1 hour rejected**. Production keeps
`FILE_LINK_RECONCILE_INTERVAL_HOURS=0`. No source under `functions/src`
changed. Deferred Control 46 stays OPEN. Runbook: DEPLOYMENT.md → *DC46-C* →
*Activation runbook*.

**Automated — scheduling over whole days.**
`tests/functions/team.reconciliationSchedule.test.js` (7 tests, Firestore
emulator). It calls `runScheduledWorker` — the scheduled function's own body
— once a simulated minute with the RAW interval text (`"2"`), so planning,
eligibility, cursor, queue, leases, checkpoints, slices, pre-emption, retry
and overdue are the production code. Simulated, and only these: Scheduler
ticks starting 0–5 s after each minute (seeded jitter; production showed
about 2.0–2.6 s); an invocation due while the previous one still runs is
refused, as `concurrency: 1` does; every clock read advances 1–15 ms; the
ADR-74 fake bucket, optionally with a fixed cost per page. A seeded generator
makes every run identical.

| Test | Hours | What is asserted |
|---|---|---|
| Initial planning and steady state | 30 | The first invocation plans; due companies are swept on the NEXT invocation; a company swept 30 min before activation waits for its own clock. Every later gap between successful sweeps is ≥ 2 h and ≤ 3 h 3 min; gaps on both sides of the hourly planning boundary occur (observed 121–182 min); planning passes 60–61 min apart, numbered without a gap; no error line, no overdue audit, no `overdueSince`; empty sweeps write no audit; a removal writes exactly one `file_links.reconciled`; a token planted at hour 10 is gone within 3 h 3 min |
| Second jitter seed | 24 | The same gap and heartbeat bounds — no seed-specific pass |
| Urgent priority | 26 | A 60-object company needs several invocations per sweep (yields against the 45 s routine share); an urgent request arriving mid-sweep pre-empts it on the next invocation, is served first, completes, is audited `file_links.revoked` with its sequence; the abandoned periodic sweep is never recorded; the next periodic sweep is ≥ 2 h after the urgent one; one overlapping tick refused and nothing lost; no overdue |
| Retry and incomplete | 26 | A token whose removal fails for 20 min after the first failed sweep: incomplete sweeps with backoff, audited, the eligibility clock never moved, then recovery (token gone, counters reset); two consecutive listing failures resumed, not escalated; longest gap 213 min — still no overdue |
| A real overdue is still detected | 24 | Removal failing for 6 h: exactly one `file_links.reconciliation_overdue` audit (`intervalHours: 2`), error lines, cleared by the next success — the "no false overdue" results are not vacuous |
| First pass at activation | 24 | A company last swept 5 h earlier is reported overdue ONCE, by pass 1 only, in the first invocation; swept on the next invocation; never again. A company swept 1 h earlier is not reported |
| Why 1 hour was rejected (characterisation) | 24 | At interval `"1"` the same code gives gaps of 61 and 120–122 min on jitter alone, and false overdue audits and error lines with nothing failing |

**Automated — policy C configuration.** `tests/unit/monitoringPolicies.test.js`
(15 tests, 11 before: two new, two new per-file cases for policy C, the file-list test changed): the metric filter matches EXACTLY the info line
`file-links: reconciliation plan complete` that `planReconciliation` writes
once per finished pass (pinned against the source, which writes it once),
scoped to the worker's stdout in `australia-southeast1`; a plain DELTA INT64
counter with nothing extracted; policy C is an absence of that metric summed
across revisions for 10,800 s — three planning periods, the period read from
the source; severity ERROR; no recipient committed; its runbook names the
rollback disable.

**Results on this branch (17 November 2026).** Functions pure 3 files / 70;
Functions emulator 8 files / 155 (7 new); monitoring unit file 15; Functions
lint clean; ESLint clean on the two changed test files.

**⚠️ What these tests do NOT prove.** Real page latency; real Scheduler
jitter beyond the simulated 0–5 s; Cloud Logging ingestion or Cloud
Monitoring evaluation (policy C has never existed); behaviour during a
billing suspension. No latency figure may be quoted from this section.

**Manual, in production — NOT RUN, NOT AUTHORISED.** Development tenant only.
Each step on explicit authorisation; commands in DEPLOYMENT.md → *DC46-C* →
*Activation runbook*.

1. - [ ] Preconditions recorded: billing owner and backup administrator
      confirmed; the activation commit merged with CI green; the rollback
      checkpoint SHA captured and verified (DEPLOYMENT.md → *Activation
      runbook* → C2) and written into the release record; both alert
      recipients told to expect one first-pass overdue email.
2. - [ ] Policy C metric and policy created, verified identical to the files,
      both channels attached; no incident while the interval is `0`.
3. - [ ] *(Optional, separately authorised.)* A token planted on the
      disposable test PDF from the Firebase console before the deploy; record
      the object's metageneration before and after merely VIEWING it (tests
      the console hypothesis); never copy a token value into any record.
4. - [ ] Worker-only deploy at `2`; new revision serving, interval `2`,
      concurrency 1; the eight callables still on `-00003-*`.
5. - [ ] First invocation: `reconciliation plan complete` (pass 1, requested
      1) and — expected — one `reconciliation overdue` error line in the
      same minute; next invocation: a periodic sweep completes
      (`lastPass.priority: periodic`), `overdueSince` cleared, queue 0,
      cursor document present. With step 3: `file_links.reconciled`, the old
      URL 403, the PDF still opens in the app.
6. - [ ] Heartbeats about hourly for 3 h; policy C metric has points; no
      policy C incident; pass 2 onwards report `overdue: 0`.
7. - [ ] A second periodic sweep 2–3 h after the first, no overdue.

## 57. DC46-C — Stages 2 and 3: visibility-reduction lock and external-member removal (18 November 2026) — LIVE since 17 November 2026 UTC; PRODUCTION-ACCEPTED 18 November 2026

> **Status at DC46 closeout (18 November 2026).** Merged as `main` `5fb96da`; Rules released 17 November 2026 20:47 UTC, the eight callables 20:49 (`-00004-*`), Hosting 20:49. Production checks 1–3 were run on 18 November 2026 and PASSED (§59); check 4 does not apply — production has no `super_admin` row. The text below is the record as written at the time.

Branch `feature/dc46-visibility-external-removal` (uncommitted at the time of
writing). ADR-75 decisions 12, 14 and 15. Nothing is deployed; production is
unchanged. Deferred Control 46 stays OPEN. Runbook: DEPLOYMENT.md → *DC46-C
Stages 2 and 3 — release runbook*.

**Automated — Rules emulator** (`tests/rules/projectDocuments.rules.test.js`,
60 numbered cases; suite 35 files / 2,213 tests):

- 29 (rewritten) — every internal role still edits name, category, version,
  date and notes with visibility unchanged.
- 51 (rewritten) — the former documented gap is closed: the flip is refused
  and the subcontractor still reads the document.
- 52–53 — `project → internal` refused for `company_admin`,
  `project_manager` and `qs`, alone or riding with another edit.
- 54–56 — `internal → project` allowed for each internal role; an internal
  document stays editable; a project document keeps every other edit.
- 57–58 — creation as `internal`, replacement uploaded as `internal`,
  supersede and withdraw on both visibilities; neither transition can carry
  a reduction.
- 59–60 — external roles, `super_admin` and another company's admin can
  change visibility in neither direction, in either tenant path.

**Automated — Functions.** Pure (`functions/test`, 3 files / 72): the static
pin that no executable line under `functions/src` or `functions/scripts`
mentions `visibility`. Emulator (`tests/functions/team.handlers.test.js`;
suite 8 files / 165): a Company Admin deactivates a subcontractor and a
client — membership cleared, Auth disabled, urgent request and marker
written, audit events consistent; `super_admin` refused with nothing
written; non-admin and external callers refused; another company's member
`not-found` in both directions and nothing written under the other company;
idempotent repeat (no second request or audit event); Auth failure leaves
access removed and `authSyncPending`, a repeat completes it; `listTeam`
before and after; role changes and invitations still refuse external roles;
re-acceptance clears the two member fields while the state document, the
queue marker and every earlier audit event are unchanged; a later
deactivation stamps a fresh sequence.

**Automated — frontend unit** (81 files / 4,443): `canDeactivateMember` and
`isExternalRole` (`tests/unit/team.test.js`); `canEditMember` unchanged.

Lint clean in both packages; production build clean; `git diff --check`
clean; `rules:transitional:check` up to date.

**Not repeated:** the accepted deactivation of ordinary internal roles
(§55), the worker, and periodic reconciliation (§56).

**Manual — production, after each release step, each separately approved:**

1. - [x] *After Rules (step 1).* On the development tenant, as an internal
      role, a direct SDK `updateDoc` setting `visibility: 'internal'` on a
      disposable `project` test document is refused with a permission
      error; the document is unchanged. Uploading, replacing and
      withdrawing a document from the app still work.
2. - [x] *After callables (step 2).* Eight new revisions, worker revision
      unchanged, interval still `2`, 401 without App Check (read-only).
3. - [x] *After Hosting (step 3).* A disposable operator-provisioned
      subcontractor on the development tenant shows *Deactivate* and no
      *Change role*; deactivating it succeeds. Confirm on the backend, not
      from the UI alone: the `deactivatemember` request, the
      `member.deactivated` and `file_links.revocation_requested` events, and
      the worker's `file-links: worker run` line completing the urgent sweep.
4. - [ ] A `super_admin` row, if one exists, offers neither action. *(Not applicable on 18 November 2026: production has no `super_admin`.)*

## 58. DC46 — External document access follows status (18 November 2026) — LIVE since 17 November 2026 22:15 UTC; PRODUCTION-ACCEPTED 18 November 2026

> **Status at DC46 closeout (18 November 2026).** Merged as `main` `0225b03`; both rules files released 17 November 2026 22:14 UTC, Hosting 22:15, each verified byte-identical to `main`. The production checks at the foot of this section were run on 18 November 2026 and PASSED (§59). The text below is the record as written at the time.

Branch `fix/dc46-external-document-access` (uncommitted at the time of
writing). ADR-75 → *External document access follows status*. Nothing is
deployed; production is unchanged. Deferred Control 46 stays OPEN. Runbook:
DEPLOYMENT.md → *DC46 — external document access correction*.

**Automated — Rules emulator** (suite 35 files / 2,238 tests; 25 new).

`tests/rules/projectDocuments.rules.test.js` (cases numbered to 73):

- 9 (rewritten) — the non-internal list query succeeds with the visibility
  AND status filters.
- 61–63 — `subcontractor`, `client` and `super_admin` read an active project
  document; a superseded one and a withdrawn one are denied.
- 64 — internal history preserved: `company_admin`, `project_manager` and
  `qs` get every status, project or internal, and list the whole collection.
- 65–68 — query compatibility: both filters succeed and return only the
  active document; the previous bundle's visibility-only query is refused
  (the fail-closed intermediate state); a status filter alone is refused
  once an internal document exists; a query for superseded or withdrawn
  documents is refused.
- 69–70 — another company and an unauthenticated caller are denied every
  status, by `get` and by the filtered query.
- 71–72 — lifecycle through real client writes: a withdrawal, and a
  replacement with supersession, remove external access at the next read
  while the writer keeps it; the replacement is readable; superseded →
  withdrawn still works.
- 73 — the Stage 2 lock is unchanged.

`tests/rules/storage.rules.test.js` (cases numbered to 69):

- 58–60 — bytes and object metadata of an active project document allowed
  to the three non-internal roles; withdrawn and superseded denied.
- 61–62 — internal roles read active, superseded and withdrawn bytes,
  including a withdrawn internal document.
- 63–64 — withdrawing or superseding removes byte access at the next read.
- 65–66 — missing metadata, and metadata with no `status`, fail closed for
  non-internal roles; internal roles still read.
- 67–68 — cross-tenant denial in both directions; unauthenticated denial.
- 69 — drawings unchanged: every member reads a drawing file.

**Automated — unit** (82 files / 4,452 tests; 9 new):
`tests/unit/documentsExternalAccess.test.js` pins, by source structure, the
hook's two-filter query for non-internal roles, the unfiltered internal
query, the absence of any `orderBy` or range filter (no composite index),
the gated *Show withdrawn* toggle, and the read branch in `firestore.rules`,
the transitional copy and `storage.rules`.

**Also run:** `npm run lint` (clean), `npm run build` (clean),
`npm run rules:transitional:check` (up to date), `git diff --check` (clean).
Functions suites not run — no Functions file changed.

**Index check (production, read-only, 17 November 2026 21:40 UTC).** The
two-equality structured query was accepted on all seven production projects
with no missing-index error; the database has no single-field index
exemption.

**What the emulator does not prove.** Nothing about download-token URLs —
they are served without rules.

**Production checks — RUN 18 November 2026, all PASSED (§59).**

- [x] Before step 1: the published rulesets match `main` before this change.
- [x] After step 1: both published rulesets are byte-identical to the
      released commit (242,163 and 9,271 bytes).
- [x] After step 2, as an internal user: the Documents tab lists active,
      superseded and (with *Show withdrawn*) withdrawn documents; Open works
      on each; Upload, Replace and Withdraw work.
- [x] As the external test member: only active project documents are
      listed; no *Show withdrawn* toggle; Open works on an active document.
- [x] An internal user withdraws a project document the external member
      could see: it leaves the external list without a reload, and stays in
      the internal list.
- [x] Remove the external member from the Team page (Stage 3 acceptance,
      TESTING.md §57) and confirm the `deactivatemember` request and the
      worker's sweep in the logs.

## 59. DC46 — Final external-member acceptance in production (18 November 2026) — PASSED; Deferred Control 46 CLOSED with accepted risks

One controlled exercise, authorised by the Product Owner, on the production
test company (*Apex Builders*, the only company) and one test project
(*Gold Coast apartments*). Release under test: `main` `0225b03`. Record:
ADR-75 → *DC46 closure record*. Nothing here is repeated from §55; no
internal member was deactivated. All times UTC.

**Preconditions verified read-only (17 November 22:31).** `main` =
`origin/main` = `0225b03`, clean; both published rulesets byte-identical to
`main`; Hosting release `b70a1504ff327671`; callables `-00004-*`; worker
`-00003-ceg`, interval `2`; Scheduler enabled; policies A, B and C enabled;
no WARNING or ERROR since the expected activation line.

**Test identity.** One subcontractor, UID `q1IctaF2YhdRTdaY0GdpdetKc3U2`,
provisioned by the operator at 22:48:42 on 17 November: a Firebase Auth
account with no password and `users/{uid}` (`name`, `email`, `role:
'subcontractor'`, `companyId`, `avatarInitials`, `createdAt` — the shape of
the existing operator-provisioned profiles). Membership is company-wide; the
Product Owner confirmed beforehand that everything such a member can read in
the company is test data. The Product Owner set the password and signed in
both sessions personally; no credential, reset link or code was recorded.
The earlier test member's account was not touched.

**Fixtures.** Uploaded through the app as a Company Admin (22:49–22:50),
four disposable one-page PDFs: *DC46 Test - Active* (`project`), *DC46 Test -
Superseded* then replaced by *DC46 Test - Replacement* (`project`), *DC46
Test - Internal* (`internal`); plus the existing withdrawn *Test Method
Statement*.

| # | Check | Expected | Actual | Result | Time |
|---|---|---|---|---|---|
| A1 | External: Documents list | Only active `project` documents | *Active* and *Replacement* only | PASS | 18 Nov 02:09 |
| A2 | External: open an active document | Opens | Opened from a `blob:` URL, no error | PASS | 02:09 |
| A3 | External: *Show withdrawn* | Absent | Absent; notice names what is not listed | PASS | 02:09 |
| A4 | External: rules-checked metadata read, own session | 200 active; denied otherwise | active 200, replacement 200; superseded 403, withdrawn 403, internal 403 | PASS | 02:10:22 |
| A5 | External: rules-checked byte read (Storage) | 200 active; denied otherwise | active 200 (634 B), replacement 200 (622 B); superseded 403, withdrawn 403, internal 403 | PASS | 02:10:22 |
| A6 | External: queries | Two-filter query only | two filters 200 (2 rows); visibility-only 403; withdrawn 403; superseded 403; internal 403 | PASS | 02:10:22 |
| A7 | External: an internal-only collection (contacts) | Denied | 403 | PASS | 02:10:22 |
| B1 | Internal: history | Everything readable | all five documents and files 200; unfiltered list 200, 5 rows; page lists all five with *Show withdrawn* | PASS | 02:10:48 |
| B2 | Internal: workflows | Upload, Replace, Withdraw work | all three performed on the fixtures | PASS | 17 Nov 22:49 – 18 Nov 02:12 |
| C1 | Stage 2 lock (Company Admin, client write) | Control edit accepted; `project → internal` refused | notes-only edit 200; visibility write 403 `PERMISSION_DENIED`; document unchanged | PASS | 02:10:48 |
| A8 | Live withdrawal of *Replacement* | Leaves the external list without a reload | Gone from the open external page | PASS | 02:11:09 |
| D1 | Team page, subcontractor row | *Deactivate*; no *Change role* | As expected ("Managed by operator") | PASS | 02:11:21 |
| D2 | `deactivateMember` | HTTP 200 on a `-00004` revision | 200 on `deactivatemember-00004-kom`, request id `03738f7a8ae4…` | PASS | 02:11:42 |
| D3 | Membership | Inactive | `users/{uid}`: `status: 'deactivated'`, role and company cleared, former role `subcontractor`; `members/{uid}`: deactivated, revocation sequence 8 | PASS | 02:11:43 |
| D4 | Audit | Three events, one request id | `member.deactivated`, `file_links.revocation_requested` (seq 8, `member.deactivated`), `member.auth_synced` | PASS | 02:11:43 |
| D5 | Firebase Auth | Disabled; sessions revoked | disabled; refresh tokens revoked 02:11:44; `authSyncPending: false` | PASS | 02:11:44 |
| D6 | External session | Ends | The open page returned to the sign-in screen | PASS | 02:11:54 |
| D7 | Worker | Urgent sweep completes | `file-links: worker run`, urgent 1: complete, seq 8, 9 scanned, 0 removed, 0 failed | PASS | 02:12:02 |
| D8 | Queue and lease | None left | queue 0; no lease; no open sweep; `completedSeq` 8 = `requestSeq` 8 | PASS | 02:12:58 |
| E1 | Cross-tenant | Denied | Emulator suite on the deployed, byte-identical rules (Firestore 5, 11, 69; Storage 39, 53, 67); production has one company | PASS (emulator) | — |

**Tokens.** The four uploads each created a download token (as every upload
does). The periodic sweep of 18 November 00:21:02 removed all four (9
scanned, 4 removed, 0 failed; `file_links.reconciled`), 91 minutes after the
uploads and with no membership change. The urgent sweep at 02:12:02 found
none on any of the nine objects, and no object has changed since. The
authenticated opens during the acceptance did not create a token.

**Cleanup (verified 02:13).** Test identity deactivated, Auth disabled;
membership and audit records kept. All four disposable documents withdrawn
with the reason *DC46 acceptance test - disposable document* (the superseded
one by a rules-checked client write — the page has no *Withdraw* on a
superseded row). No pending invitation. Worker, interval, Scheduler,
policies and billing unchanged; no error logged.

**Not covered.** A `client` or `super_admin` identity; a second production
tenant; Android Chrome. The emailed password-reset link for the
operator-created account failed for a reason not established (a
server-generated reset code for the same account verified as valid); it is
not part of the control and is noted in the closure record.

## 60. L2-A — Commercial Report (18 November 2026) — LIVE and Product Owner accepted (REPORTED 19 November 2026; no per-step acceptance record is held here); automated tests PASS

**Scope.** The project **Reports** tab (`/projects/:id/reports`): a read-only,
live Commercial Report for one project in one currency, CSV export and a
print / Save-as-PDF layout. Hosting only — no Rules, Functions or data change
(DEPLOYMENT.md → *L2-A Commercial Report — release*).

**Automated evidence (18 November 2026, `feature/l2a-commercial-report`).**
`tests/unit/commercialReport.test.js` — 70 tests: every headline figure equals
the Dashboard snapshot; cost-code totals equal the headline figures; hand-
derived pins; approved-version vs working budget; claims (submitted / under
review) never in Actual; Committed is remaining open commitment; cash is
recorded cash only; approved vs pending variations; failed, missing-state and
loading sources (never zero); genuine zeros on an empty project; "not set"
contract; currency carried, never converted; deterministic order; CSV quoting,
CRLF, formula-injection guard (`= + - @`, full-width forms, leading
whitespace, control, zero-width, bidi and BOM characters, leading TAB / CR);
export content and filename; role-gate, route, read-only and print-CSS
structure. `betaSurfaces.test.js` and `moduleBranding.test.js` updated for the
new tab (18 tabs). Unit suite: 83 files, 4,521 tests, all pass. ESLint clean.
Production build succeeds.

**Manual acceptance (Product Owner, after the Hosting release).** Use a test
project with at least one budget line, a sent PO, a submitted and an approved
claim, a posted supplier invoice, a pending and an approved client variation,
a posted receipt and a posted payment.

| # | Step | Expected |
|---|---|---|
| R1 | Company Admin, PM or QS opens a project → **Reports** | Report renders: project name, currency, budget source, "Generated …" with the not-a-cut-off wording |
| R2 | Compare the summary with the Dashboard snapshot and the Forecast tab for the same project | Approved Budget, Committed, Actual, Forecast Final Cost, Variance, Gross Profit and Margin identical |
| R3 | Compare the cost-code table with the Forecast tab | Same rows, same Actual / Committed / CTC / FFC per code; Claimed equals the Budget tab's Claimed |
| R4 | Pending client variation | Shown under *Pending*; not in the Current Contract Sum |
| R5 | Cash | Cash received / paid equal the Cash Flow tab's actual totals; invoices outstanding are not shown as cash |
| R6 | Subcontractor or client account opens the Reports URL | "Reports are restricted"; no financial data; no permission errors in the console |
| R7 | **Export CSV** | File `constrap-commercial-report-<project>-<date>.csv`; opens in Excel / Numbers / Google Sheets with numbers as numbers; no cell evaluates as a formula |
| R8 | **Print / Save as PDF** (Chrome, Safari, Edge) | Landscape A4; no sidebar, top bar, tabs or buttons; light background; no clipped figures; table header repeats on each page |
| R9 | Narrow window / phone | Table scrolls horizontally inside its card; nothing overlaps |
| R10 | Disconnect the network mid-load (DevTools offline) | Figures show "—" while loading, never 0; export and print disabled until loaded |

**Not covered by automated tests.** Rendered DOM, real browser print output,
spreadsheet application behaviour, and the production rules path (the report
adds no read the financial roles did not already make on other tabs).

## 61. L2-B Stage A — Firestore Rules Capacity Recovery 3 (ADR-76, 19 November 2026) — LIVE since 18 November 2026 21:57 UTC; automated checks PASS; live ruleset VERIFIED byte-identical to `main` (read-only, 19 November 2026); browser smoke checks W2–W4 PASSED in production, 25 November 2026 (§71) and accepted with display findings (Lead Architect, 25 November 2026 — REPORTED)

*Heading as written before the 25 November 2026 run:* … browser smoke checks W2–W4 NOT RECORDED

**What changed.** Leading spaces in `frontend/firestore.rules` only: every
non-blank line indented 16 or more spaces loses exactly 8 (1,631 of 4,122
lines). **242,163 → 229,115 bytes** (−13,048; 15,885 under the 245,000 budget).
The transitional file was regenerated (`242,843 → 229,795`). No executable
token, comment, permission, data shape or client code changed.

**Automated:** lint 0 / 0; unit **83 files / 4,521 tests** (two pins that embed
a continuation indent updated by the same 8 spaces; the transitional test still
finds exactly four marked pairs); rules **35 files / 2,238 tests**, run against the
re-indented file with no rules test changed; `npm run rules:transitional:check`
clean; `git diff --check` clean; `git diff -w` empty for both rules files.

**The equivalence proof (run from `frontend/`; reproducible from the repository
alone).**

```bash
node scripts/verify-rules-whitespace-only.mjs --base 2d5787c
```

Expected: `frontend/firestore.rules: EQUIVALENT — 4122 lines identical after
their leading spaces (1631 re-indented)` and `frontend/firestore.transitional.rules:
EQUIVALENT — 4127 lines …`, exit 0. The script requires equal line counts and
compares each line byte-for-byte after its leading spaces (comments, inline
comments and string literals included); a tab, a changed blank line, a deeper
indent or any other difference exits 1 and names the line. Negative control
verified: a copy with one `allow delete: if false;` changed to `if true;` fails
with *content after the leading whitespace differs*.

**Production smoke checks after the Rules publish (NOT RUN — nothing is
published).**

| # | Check | Expected |
|---|---|---|
| W1 | Console → Firestore → Rules | The new ruleset is 229,115 bytes |
| W2 | Financial role opens Budget, Purchase Orders and the Commercial Report | Figures load as before; nothing reads *Unavailable* |
| W3 | Financial role saves one ordinary edit (for example a forecast line note) | Accepted |
| W4 | A deactivated or non-financial account opens a financial tab | Still refused |

**Result, 25 November 2026 (§71; tracker B7).** W2 **PASS** (Project Manager and QS), W3 **PASS** (QS forecast save), W4 **PASS** (a signed-in `subcontractor`: no figure on any financial tab, Rules denials from the same session; after deactivation the session was signed out). W1 stands on the 19 November read-only verification; the live ruleset is now 236,737 bytes (later releases) and was again byte-identical to `main`. Two display findings on the Budget and Purchase Orders tabs: tracker D3 #27, #28 (P2 external-role UI correction bundle; server-side refusal of an external purchase order create established in §71).

## 62. L2-B Stage B — Final Account (ADR-77, 19 November 2026) — DEPLOYED; production acceptance: F1–F15 and F17 PASSED (F1–F2 Product Owner, 20 November; F3, F4, F7–F13, F17 on 22 November — §62b; F5, F6, F14 native PDF, F15 and Project Manager approval on 24 November — §62c); F16 accepted on combined evidence (production access denial and the unit test; the restricted notice NOT observed in production at closure — **OBSERVED in production on 25 November 2026, §71**) — **C1-A CLOSED** (Lead Architect, 25 November 2026 — REPORTED)

*Heading as written before the 24 November revision:* L2-B Stage B — Final Account (ADR-77, 19 November 2026) — DEPLOYED — PRODUCTION ACCEPTANCE PENDING; automated tests PASS (emulators); production acceptance PARTIAL (F1 and F2 confirmed by the Product Owner, 20 November 2026; F3–F17 NOT RUN)

**What changed.** A `finalAccounts` collection (one Rules block), the
`approveFinalAccount` callable, the generated server calculation, and a Final
Account sub-tab under Commercial. No existing selector, hook or figure changed.

**Automated (all against local emulators — nothing here is production-verified):**
lint 0 / 0 (frontend and Functions); unit **86 files / 4,642 tests**; Functions pure
**4 files / 99 tests**; Rules **36 files / 2,319 tests** (Rules unchanged since
that run); Functions emulator **9 files / 230 tests**; `npm run rules:transitional:check` and
`npm run functions:calc:check` clean; `firestore.rules` 232,460 bytes; build
clean; `git diff --check` clean.

| Suite | File | Tests | Covers |
|---|---|---|---|
| Unit | `tests/unit/finalAccount.test.js` | 69 | Figures equal the Commercial Report and their own selectors; contract / invoiced / received / outstanding distinct; ex-GST and gross never combined; every readiness blocker; failed and loading sources; working and unreconciled budgets; commitment close-out by an applied negative variation; draft payload and size; drift (later invoice, edited contract value, re-approved budget, cent boundary, unreadable live records); history and supersession; roles; client actions send no amount; CSV (approved only, formula injection, disclaimer, superseded, self-approval); display states; dialogs; page wiring, permission gate, print reuse |
| Unit | `tests/unit/finalAccountBundle.test.js` | 30 | Generated bundle FRESH (byte-identical on rebuild, deterministic), SELF-CONTAINED (no import, no browser / Firebase reference, no build-machine path), EQUAL to the source module across 15 project variants and failed / loading sources; the callable's source surface; the Rules block has no client path to `approved` |
| Unit | `tests/unit/finalAccountPage.test.js` | 14 | The whole page rendered with stubbed hooks in every state: restricted role, nothing prepared, not ready, loading, a failed register, draft (approver / qs / stale), approved, approved with drift, live records unreadable, history with superseded and withdrawn revisions, self-approval, revision read failed |
| Functions pure | `functions/test/finalAccount.test.js` | 27 | Gate order (kill switch, authentication, validation — with no database); the request schema; approver membership; the shipped calculation; **release safety** — the flag defaults to off in code and is stated in every project env file, no existing production parameter changed, the export name and codebase the deploy filter targets, bounded reads, only ABORTED typed as busy |
| Rules | `tests/rules/finalAccounts.rules.test.js` | 81 | Reads by role and tenant; draft creation through the app action and 24 forged shapes; 1,000 rows accepted as one document, 1,001 refused; revision numbering; two concurrent prepares land one draft; **no role can approve by any write shape**; draft figures cannot be edited; withdrawal rights and 9 refused shapes; approved and withdrawn immutable; delete denied; no other document written |
| Functions emulator | `tests/functions/finalAccount.approve.test.js` | 65 | Who may approve; cross-tenant NOT FOUND; request validation; server figures replace the draft's; 10 forged drafts refused; readiness from the server's own read (7 cases); adjustments folded; lifecycle guards; correction as revision 2 leaves revision 1 byte-identical; idempotent replay; two approvers at once; double submit; forced ABORTED retried once; non-retryable failure writes nothing; **contention on all five attempts → typed busy; a deadline error left untyped and safely retried; a failed read at three different points approves nothing; a register over the document bound refused by name and accepted exactly at the bound**; **three source-write races and a withdraw race**; a 1,000-row / 2,200-document approval in one transaction; the deployed wrapper over HTTP (App Check, ID token) |

**Concurrency evidence (emulator).** A competing write was started after the
approval transaction had read its sources and before it wrote: (1) an update
to `commercial/baseline`, (2) a new submitted variation inserted into the
queried `variations` register, (3) a new posted supplier invoice inserted into
`supplierInvoices`. Observed in two consecutive runs, every case: the approval
succeeded on its first attempt, and the competing write's commit time was
strictly later than the approved revision's update time — the write waited
for the transaction. The tests accept either serializable history (retry and
refuse, or approve then write) and fail on the one that must never happen: an
approval that succeeded although an unaccounted write had already committed.
The emulator's locking may be coarser than production's; production relies on
Firestore's documented serializable isolation and pessimistic locking for
server SDKs on a Standard-edition database, and that has NOT been exercised
in production.

**Bundle portability.** `rolldown` is an explicit dev dependency at `1.0.3`
(the version Vite pins). A clean `npm ci` from the lockfile in an empty
directory installed one copy and `functions:calc:check` reported the committed
bundle up to date; the same check passed with the WebAssembly binding forced
(`NAPI_RS_FORCE_WASI=1`) in place of the native macOS one — two different
compiled bindings, identical bytes. The `linux-x64-gnu` binding is in the
lockfile at `1.0.3`. **It was NOT run on Linux** (no container runtime on the
development machine): the first Azure CI run on the branch is that proof, and
the freshness test fails loudly there if the output differs.

**Reproduce (from `frontend/`; Java 21+).**

```bash
npm run test:unit
npm run functions:test
npm run test:rules
npm run test:functions
npm run functions:calc:check && npm run rules:transitional:check
```

**Production acceptance after the three-step release (NOT RUN — nothing is deployed).**

| # | Step | Expected |
|---|---|---|
| F1 | Company Admin opens a project → Commercial → Final Account | The sub-tab is present; "No Final Account has been prepared"; the readiness checklist lists every requirement with Met / Not met; the current position shows figures, never 0 for a figure that failed to load |
| F2 | On a project that is NOT ready (an open claim, a draft invoice, or a forecast cost to complete) | The requirement reads Not met with its fix; *Prepare* is disabled |
| F3 | On a ready project, *Prepare Final Account* without ticking the acknowledgement | Refused with a message; nothing is written |
| F4 | Prepare with a basis and the acknowledgement | Draft revision 1 appears, marked DRAFT — not approved; no Export or Print button |
| F5 | As QS, open the draft | No *Approve* button; "Approval is by a Company Admin or Project Manager" |
| F6 | As a second user, try to prepare another draft | Refused: a draft is already open |
| F7 | Edit the contract value on the Commercial tab, then return to the draft | *Approve* is disabled: the current records differ from this draft |
| F8 | Withdraw the draft with a reason; prepare revision 2; approve it as Project Manager | Revision 2 is Approved and Current; approver name, time and "Records read" time shown; revision 1 stays Withdrawn in the history |
| F9 | Backend evidence for F8 | A `final account approval` log line on the `approvefinalaccount` service for that request; one `final_account.approved` audit event |
| F10 | Approve a draft you prepared yourself | Permitted; the revision shows "self-approval" |
| F11 | Post a new supplier invoice after approval; reopen the Final Account | An alert names the changed figures and shows the current value beside each; the approved figures are unchanged |
| F12 | Prepare and approve revision 3 | Revision 3 is Current; revision 2 is Superseded and its figures are unchanged |
| F13 | *Export CSV* on an approved revision | Opens in a spreadsheet; revision, currency, approver, date and the disclaimer present; ex-GST and gross in separate rows; a cost code beginning with `=` shows as text |
| F14 | *Print / Save as PDF* on an approved revision | Landscape A4; no sidebar, tabs, sub-tabs, checklist or history; light background; the disclaimer present |
| F15 | With browser developer tools, attempt `updateDoc(finalAccounts/N, { status: 'approved' })` as a Company Admin | Refused: permission denied |
| F16 | A deactivated or non-financial account opens the URL | "Final Account is restricted"; no figure |
| F17 | 375 px, 768 px and 1280 px widths | No overlap; the cost-code table scrolls inside its card; touch targets at least 44 px |

**Not covered by automated tests.** Rendered DOM and focus behaviour in a real
browser, real print output, spreadsheet behaviour, App Check with a real
reCAPTCHA Enterprise token, production transaction behaviour under load, and
the production Rules path.

### 62a. L2-B reconciliation correction (20 November 2026) — DEPLOYED (REPORTED by the Lead Architect, 20 November 2026; merged to `main` as `891043a`); automated tests PASS; negative-readiness and reconciliation acceptance PASSED with browser screenshots verified (REPORTED); positive approval, revision and export acceptance PENDING

**Production reconciliation (read-only, 20 November 2026; test project *Gold
Coast apartments*; invoice headers and receipt allocations only).** Six issued
invoices, nine posted receipts, no document without `createdAt`, no allocation
to a non-issued invoice, every receipt's allocations equal to its
`allocatedTotal`.

| Invoice | Gross | Allocated | Balance |
|---|---|---|---|
| CI-0001 | 165,000.00 | 165,000.00 | 0.00 |
| CI-0012 | 22,000.00 | 22,500.00 | **−500.00** |
| CI-0013 | 12,100.00 | 11,000.00 | 1,100.00 |
| CI-0014 | 55,000.00 | 20,000.00 | 35,000.00 |
| CI-0015 | 27,500.00 | 27,500.00 | 0.00 |
| CI-0016 | 55,000.00 | 0.00 | 55,000.00 |
| **Total** | **336,600.00** | **246,000.00** | positive 91,100.00 · over-allocated −500.00 · net 90,600.00 |

Σ `subtotal` + Σ `gstTotal` = Σ `grossTotal` = 336,600.00 (no header
inconsistency). Posted receipts: Σ amount 247,000.00 = 246,000.00 allocated +
1,000.00 unallocated. Cause: ONE over-allocated invoice. Not a calculation
defect.

**Automated:** lint 0 / 0; unit **86 files / 4,659 tests** (`finalAccount.test.js`
82, `finalAccountBundle.test.js` 31, `finalAccountPage.test.js` 17); Functions
pure **4 files / 99 tests**; Final Account Functions emulator file **67 tests**;
build clean; `functions:calc:check` and `rules:transitional:check` clean;
`git diff --check` clean. Rules unchanged — the Rules suite was not re-run.
New coverage: the blocker at one cent over, not at exact payment, not below a
cent; posted / issued only; ordinary balances still non-blocking; the
production figures reproduced with the blocker naming CI-0012; server bundle
parity and independent enforcement by the callable (one cent over refused,
exact payment approved); live versus revision labels in the component, the
whole page and the CSV; the two corrected notes; draft views labelled
*Proposed final …* and never *Final …*; the unapplied-variation requirement
worded in forecast-cost terms.
### 62b. C1-A production acceptance and the forecast-readiness correction (22 November 2026) — positive-path acceptance PASSED in production (Lead Architect); correction IMPLEMENTED on `fix/c1a-final-account-forecast-readiness`, automated tests PASS (emulators), NOT DEPLOYED, production retest PENDING

*Status, 24 November 2026:* the correction is deployed and was retested in the browser (R1, R2, R4 PASS; R3 blocking PASS — REPORTED by the Lead Architect, 23 November; CHATGPT_HANDOVER.md). R5 and the remaining role checks are recorded in §62c. The heading above and the *NOT RUN* / *NOT DONE* notes below keep the wording of their date.

**Production acceptance (22 November 2026; sandbox *C1-A Final Account
Acceptance — TEST*, `oeqHCgEM3GsB9ZKtifZb`, Company Admin session).** F3, F4,
F7, F8 (approved by a Company Admin — Project Manager approval NOT TESTED in
the browser), F9, F10, F11, F12, F13 (formula protection exercised on the
Reference field, no `=` cost code exists; not opened in a spreadsheet), F17:
PASS. F14: print rules verified in the live page; the native print dialog and
a PDF file NOT TESTED. F5, F6, F15, F16: NOT TESTED (no QS, second-user or
restricted session; F15 excluded) — emulator coverage only. Revision 1
withdrawn; revisions 2 and 3 approved; revision 2 byte-identical after a
later posted invoice and after revision 3; audit events
`9gXkKE81Y3sFZkNmPJ3o` and `GN3FfErV84h7mojSMp47`. The sandbox stays in
production and contributes to the Portfolio totals; do not delete or modify it.

**Defect found.** With two budgeted cost codes never forecast, *Cost to
complete is zero* read Met and *Prepare* was enabled (observed before the
zero forecasts were saved). Cause: the gate tested the cost-to-complete
amount only; an unforecast code contributes zero.

**Correction.** A new requirement, *Every cost code has a saved forecast*
(`forecastIncomplete`), in `lib/finalAccount.js` — the one module the browser
and the callable share (FINANCIAL_WORKFLOWS.md → *Forecast completeness*). No
Rules change (`firestore.rules` 232,776 bytes, unchanged).

**Automated (local emulators — not production-verified):** lint 0 / 0
(frontend and Functions); unit **100 files / 5,190 tests** (5,174 before);
Functions pure **5 / 130**; Functions emulator **10 files / 303 tests** (295
before); Rules **36 / 2,336** (unchanged, re-run because the shared fixture
changed); `functions:calc:check`, `functions:transfer-calc:check` and
`rules:transitional:check` clean; build clean; `git diff --check` clean.

| Suite | New coverage |
|---|---|
| `tests/unit/finalAccount.test.js` (+13) | No forecast on a budgeted code; no forecast line at all; explicit 0; a blank (null) line; a positive amount (cost to complete, not completeness); mixed coverage incl. an unbudgeted code with cost; more than five named; unreadable / loading sources; a forecast missing after the draft (figures agree, readiness refuses); no draft from incomplete records; an approved revision untouched; no second copy of the rule |
| `tests/unit/finalAccountPage.test.js` (+2) | The requirement, the named codes and the fix rendered, *Prepare* disabled; *Approve* disabled on a draft whose forecast went missing |
| `tests/unit/finalAccountBundle.test.js` (2 variants) | Server bundle equal to the source for unforecast and partly forecast projects |
| `tests/functions/finalAccount.approve.test.js` (+8) | Refusal by name with no forecast line, with mixed coverage, with a forecast cleared or removed after the draft; a positive amount refused as cost to complete; explicit 0 approved; a clear racing the approval is serialised; an approved revision unchanged and replayed without a write |

The shared *ready* fixture now carries a saved 0 on both cost codes.

**Release (NOT DONE).** One callable, then Hosting: (1)
`firebase deploy --only functions:team:approveFinalAccount` — the eight team
callables, the worker and `transferBoqToBudget` are NOT redeployed; (2)
Hosting. No Rules publish. Between the two steps the old browser bundle may
show *Prepare* enabled for an incomplete forecast; the callable already
refuses the approval.

**Production retest after release (sandbox only; NOT RUN).**

| # | Step | Expected |
|---|---|---|
| R1 | Open the sandbox Final Account (all forecasts are saved 0) | *Every cost code has a saved forecast* — Met; *Prepare revision 4* enabled |
| R2 | On the Forecast tab clear the 0300 input and save; reopen Final Account | The requirement is Not met and names *0300 — Concrete*; *Prepare* disabled; *Cost to complete is zero* still Met |
| R3 | Restore 0 on 0300; prepare revision 4; clear 0300 again; open the draft | *Approve* disabled: the current records do not meet the readiness requirements |
| R4 | (Server proof, optional — needs a client that still sends the request) | `final-account-not-ready` with `forecastIncomplete`; emulator coverage otherwise |
| R5 | Restore 0 on 0300; withdraw or approve revision 4 | Readiness all Met; revisions 2 and 3 unchanged (compare `updateTime`) |

### 62c. C1-A remaining production acceptance (24 November 2026) — F5, F6, F15, Project Manager approval, F14 native PDF and R5 PASSED in production; F16 PARTLY (no figure reaches a signed-out, deactivated or non-financial account — PROD-VERIFIED; the *Final Account is restricted* notice itself NOT observed in production) — **C1-A CLOSED** (Lead Architect, 25 November 2026 — REPORTED; F16 accepted on combined evidence, its browser check carried forward)

**Architect decision (25 November 2026 — REPORTED).** GO — **C1-A is CLOSED.** F16 is accepted on
the combined evidence (production access denial plus the unit test of the
notice); the notice is **not** recorded as observed in production, and its
browser check is carried forward to the external-role session that L4 T14
(§67) and W4 (§61) need. The limitations in this section stand, including R5
on stored-state evidence and the zero-only client-side and cash figures.
Fixture Z, its supplier contact, the two counters and the approved revision
are retained; the findings (tracker D3 #22–#26) are deferred to the UX and
reporting correction bundle; self-approval remains a documented policy gap.

**Update, 25 November 2026 (§71; tracker B7).** The carried-forward browser
check was run in the external-role session: a signed-in `subcontractor`
assigned to fixture Z opened the Final Account URL and saw *Final Account is
restricted*, with no figure and no control; `finalAccounts` was
`permission-denied` from the same session. **The F16 notice is now observed in
production.** Fixture Z and revision 2 were not changed by that run. The text
below keeps the wording of 24 November.

**Run (10:21–10:53 UTC; `main` `2561344`; Hosting `index-BOg2hoYg.js`; callable
`approvefinalaccount-00003-jad`).** Isolated company `constrap-acceptance-test`
only. One dedicated synthetic project, created and driven through the
application and **retained**: Z `5hmVvUCoOIEPrzdeowYK` *TEST USD-1 — Final
Account acceptance* (USD; OCV 120,000; approved budget v1 90,000 on `CT-100`;
PO-0001 Sent and SI-0001 Posted for 84,321.50 ex-GST, gross 92,753.65; forecast
saved 0). Sessions: TEST Company Admin, QS, then Project Manager (the Product
Owner signed in; uid verified in the page each time). No Admin SDK write; Apex
Builders, Projects A–C and the NZD fixtures X / Y untouched. Full record,
figures, enforcement matrix and integrity diffs:
[SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → B6.

Not repeated (accepted 22 November, §62b): F3, F4, F7–F13, F17, R1–R4.

| # | Result |
|---|---|
| F5 | **PASS** — as QS on a draft prepared by the Company Admin: no *Approve*, no *Withdraw draft*, no Export / Print; *Approval is by a Company Admin or Project Manager.* shown. The callable called as the QS (real App Check token) → `permission-denied` / `not-approver`; direct writes to `approved` → `permission-denied` |
| F6 | **PASS** — the QS's *Prepare* dialog, opened before the Company Admin prepared revision 1 and submitted after → *A draft revision is already open. Approve or withdraw it before preparing another.*; one document only. A forged second draft with a complete valid shape → `permission-denied` (QS and Company Admin) |
| F8 — the Project Manager part | **PASS** — revision 2 prepared by the QS, approved by the Project Manager through the app: *Approved* / *Current*, approver name, time and *Records read* shown; stored `approvedByRole` `project_manager`, `selfApproved` false; one `final_account.approved` audit event (actor = the PM) in the revision's own commit; log line `replay: false`, `attempts: 1`. Revision 1 stays *Withdrawn* in the history |
| Repeated approval | **PASS** — the same request again → `alreadyApproved: true`, no write, no second audit event; a later revision number → `final-account-not-draft`; a request carrying an amount → `invalid-argument`; another company's project id → `not-found` |
| After approval | **PASS** — as the PM: figure edit, withdraw, back to draft, change of approver, delete on the approved revision, and reopen / delete on the withdrawn one → `permission-denied` (7); `updateTime` and SHA-256 of revision 2 unchanged |
| F14 — native print / PDF | **PASS** — *Print / Save as PDF* → Chrome's dialog → *Save as PDF* (Product Owner, nothing changed in the dialog): 3 pages, **A4 landscape**, text PDF; header block, all 22 figures in four groups, cost-code table, disclaimer; no sidebar, tabs, sub-tabs, buttons, checklist, live position or history; light background; no clipped column; every amount equal to the screen. Cosmetic: the *COST (EX-GST)* heading is the last line of page 1 with its figures on page 2 (tracker D3 #22); Chrome's own header / footer (date, tab title *Constrap*, page URL, page n / N) is printed unless the user unticks it (D3 #23). File deleted after checking |
| F15 | **PASS** — as Company Admin, `updateDoc(finalAccounts/1, { status: 'approved' })` → `permission-denied`; so are a complete forged approval, a figure edit, delete, and creating an `approved` document directly. As Project Manager on revision 2 before approving: the same four → denied |
| F16 | **PARTLY** — signed out: the URL → `/login`, no figure, direct reads `permission-denied`. Deactivated: the external test accounts are Auth-disabled (read 24 November) and hold no session. Non-financial: `finalAccounts` 403 for both external roles (§63 P20; tracker B2a, B2b). **The *Final Account is restricted* notice was NOT observed in production** — it needs a signed-in non-financial account and the external test accounts stay disabled in this run; covered by `finalAccountPage.test.js` only. Accepted for closure on this combined evidence (architect, 25 November); the browser check is carried forward |
| R5 (§62b) | **PASS — stored state, read-only** — sandbox `oeqHCgEM…`: revision 4 withdrawn, forecast 0300 back to a saved 0, revisions 1–3 `updateTime` and SHA-256 identical to the 22 November capture. The on-screen readiness was not re-read in the sandbox; on Z all 19 requirements read Met after approval |

**Financial parity (independent `Decimal` expectations from the stored baseline,
approval snapshot, PO, posted invoice and forecast line).** Contract 120,000.00;
approved budget 90,000.00; actual cost = final cost 84,321.50; cost to complete
0.00; variance 5,678.50; final gross profit 35,678.50; final margin 29.732083…%
→ stored **29.73** (`marginPercent` rounds to two decimals; the screen, PDF and
Portfolio show 29.7%, the CSV 29.73); supplier invoices unpaid 92,753.65 gross;
every client-side and cash figure 0.00. The stored revision (22 of 22 figures),
the screen, the project Reports tab, the Portfolio row and USD subtotal, the
CSV and the PDF agree to the cent. Final and forecast figures coincide by
construction (approval requires cost to complete = 0); the approved revision is
frozen, the Reports tab and Portfolio stay live.

**Data integrity.** Apex Builders unchanged (258 / 258); `users` unchanged;
external test accounts still disabled; Storage fixtures byte-identical;
Projects A–C, X, Y and `CT-100` unchanged; directory 6 / 6 in sync; the test
company gained exactly 16 documents, all listed in tracker B6.

**Still not covered.** The F16 notice in production; non-zero client invoices,
receipts, payments, retention and variations on a Final Account (zero on Z);
production transaction behaviour under contention and the 5xx paths (emulator
only); a physical print or a browser other than Chrome on macOS.

---

## 63. L2-C — Portfolio Report (ADR-78, 20 November 2026) — DEPLOYED; visual, CSV and PDF acceptance confirmed (REPORTED); P19–P20 PASSED for both external roles; read-only production run PASSED (parity ACCEPTED by the architect); P7, P9, P18 PASSED in production on retained NZD fixtures in the isolated test company; P15 PASSED locally only (24 November 2026) — awaiting the architect's closure decision

**Status update (24 November 2026, 07:15–07:37 UTC) — C1-B final targeted
acceptance (PROD-VERIFIED unless marked).** Isolated company
`constrap-acceptance-test` only (no Apex Builders account or write). Two
synthetic **NZD** commercial fixtures created through the application by the
TEST Company Admin and **retained** — X `xDi4s4wnEXUC6q6dEdxX` (OCV 200,000,
approved v1 150,000, CTC 160,000) and Y `5jSw0R9QVWizCwWqJZyU` (OCV 50,000,
approved v1 30,000, CTC 25,000), sharing cost code `CT-100`. NZD, not AUD,
because open Projects A–C have no contract value, so an AUD margin subtotal can
never render (Product Owner decision). Internal identities: a new
`project_manager` (`KSC9zf…`) and the re-activated `qs` (`PvzTgu…`), both via
Team invitations, both retained and active. Full record:
[SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → B5.

| # | Result |
|---|---|
| P7 | **PASS** — expectations computed independently (Python `Decimal`) from the stored baseline, budget, forecast and approval-snapshot records: NZD contract 250,000, approved budget 180,000, FFC 185,000, variance −5,000, GP 65,000, **margin 26.00%** (aggregate profit ÷ aggregate contract; the mean of 20% and 50% would be 35%). Screen and CSV equal to the cent. With Y's budget still working: margin 26% shown; Approved Budget and Variance subtotals *Incomplete — 1 of 2, 1 budget not approved* (CSV `INCOMPLETE`) |
| P9 | **PASS** — Y set Completed through the Edit form: default scope *4 projects · 1 completed not included*, NZD subtotals = X only (20%); *Include completed* read only the completed project (*4 of 5 projects read*), restored 26% and the 5-project scope; CSV scope and lines follow; Y restored to Planning |
| P18 | **PASS** — Company Admin, Project Manager and QS (session uids verified): identical scope, rows and subtotals; CSV PROJECT / SUBTOTAL lines SHA-256 `15310838fd5c3249…` identical for all three; controls Refresh, Export CSV, Print, *Include completed* only; zero console messages. Apex project URL → *Project not found* for PM and QS (a REST-level probe with the role's token was not run) |
| P15 | **PASS — LOCAL ONLY, not production acceptance** — local emulators (`npm run test:team`) + Vite on 127.0.0.1, headless Chrome 158 with DevTools offline emulation: every figure *Unavailable* (never 0), *Financial coverage is incomplete*, subtotals *Incomplete*; recovered online |

Data integrity: Apex Builders unchanged apart from the DC46 periodic sweep
(07:12); Projects A–C, their documents, drawings and five Storage fixtures
unchanged (no token); directory 5 / 5 in sync; subcontractor and client still
disabled. Observations recorded as tracker D3 #20 (Forecast tab showed *Not
forecast* once after a save that succeeded; not reproduced) and #21 (*All N
projects have been read* while every read failed offline). Deferred UX
wording: D3 #9, #19.

**Status update (24 November 2026, 05:14–05:27 UTC) — C1-B read-only
production run (PROD-VERIFIED).** Apex Builders, the Product Owner's existing
`company_admin` session, dedicated browser tab; read-only (Refresh and
Export CSV only; the CSV captured in page memory, no file). Cloud Monitoring
shows **zero Firestore writes and deletes** for the whole database across the
session (the only nearby writes, at 05:10–05:11, are the DC46 worker's
periodic reconciliation). Full record, figures and method:
[SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → B4.

| # | Result |
|---|---|
| P1, P2, P3, P5, P6, P8, P12, P21, P22 | PASS |
| P4 | **PASS** — C1-A (approved v1), L4 (approved v2), Gold Coast apartments, Residential Developements (AUD, working budget) and Peter House (ZAR): every one of the 11 figures equals the project's Reports tab to the cent (55 / 55) |
| P7 | PARTIAL — the six complete AUD subtotals equal the row sums (checked by hand); no currency has every project approved and complete; aggregate margin checked on the one-project ZAR group only |
| P9 | NOT EXERCISABLE — no completed project exists |
| P13 | PASS (content) — the CSV's every value equals the screen; header block, Currency cell on every line, `INCOMPLETE` subtotals with counts; not opened in a spreadsheet |
| P15 | NOT RUN — DevTools offline unavailable to the browser extension; unit-tested |
| P10, P11, P14, P16, P17 | Not re-run — covered by the visual / export acceptance (REPORTED) |
| P18 | **BLOCKED** — Apex Builders has no active `project_manager` or `qs`; needs invitations (production writes) — prerequisite in the tracker, B4 |
| P19, P20 | PASS (24 November, M2-A2 Stage B — reused, not repeated) |
| M1 | 10 open projects, 0 completed (AUD 7, USD 2, ZAR 1), of which 3 are retained test projects — the largest of the two companies; no customer company yet |
| M2 | Reused from 22 November (cold ≈ 2.7 s, warm 1.5 s, Refresh 480–612 ms); 24 November loader read windows 0.71 s (cold) and ≤ 1 s (Refresh) |
| M3 | Not measurable as specified — reads share the Listen WebChannel; the loader's plan for this company is 135–136 document requests |
| M4 | **136 document reads** for one Portfolio read (an in-page Refresh, quiet minutes either side, 1-minute Monitoring points); a cold page load including the application shell: 291 |
| M5 | Not measurable — cross-origin streamed responses report no size |

**Subtotal wording (finding D3 #9) re-assessed on the live page:** the card
counts excluded projects (*Not totalled — 5 of 7 projects*), the table footer
included projects (*2 of 7*), the CSV both (*2 of 7 projects (5 budget not
approved)*), all from one subtotal result; no surface shows or exports a
partial sum. Cosmetic wording only — not a calculation or reporting-value
defect.

**Status update (24 November 2026) — P19–P20 PASSED for both external roles**
(M2-A2 Stage B production acceptance, §69 P6 / P7 / P13; isolated test
company). **P19:** as a `subcontractor` and as a `client`, no Portfolio entry
in the sidebar; typing `/portfolio` shows *The Portfolio Report is
restricted*; no console error; the only backend traffic was the Auth lookup
and the shared Firestore Listen channel. **Limitation:** the Listen-channel
request bodies could not be decoded (two capture attempts; the positive
control captured nothing), so *the page requests no financial collection* is
NOT proven by network inspection — it rests on the code and the unit tests
below. **P20:** from each external session, direct reads of 22 financial and
commercial collections plus `commercial/baseline` and
`approvedBudget/current` on every **assigned** project were denied by the
Firestore Rules (403): 24 reads as the subcontractor, 48 as the client on two
projects. Still OPEN: P18 (Project Manager / QS sessions), row-to-Reports-tab
parity as recorded here, M1–M5. A C1-B read-only run of 22 November 2026
(P4 parity on four rows, M2 timings) was reported to the architect and is not
recorded here as accepted.

**Status update (21 November 2026, NZ).** Visual, CSV and PDF acceptance is confirmed (REPORTED by the Lead Architect). Still OPEN: the external-role access checks, row-to-Reports-tab parity and the performance measurements below. Classified in the L3 assessment as a product acceptance item, not an L3 dependency.

**Status update (20 November 2026).** L2-C is merged to `main` as `93db6cc`
and the live Hosting bundle is the build of that commit (VERIFIED read-only —
PROJECT_DECISIONS.md → *ADR-79 → Production evidence*). The Lead Architect
REPORTS that the visual and export acceptance passed. **Still open:** the
security (external-role), parity (row = Reports tab) and performance
(M1–M5) checks below — no result is recorded in this file for any P or M
item, so which individual items the reported pass covers is not recorded
here. The text below is the section as written before the release.

**What was run (20 November 2026, branch `feature/l2c-portfolio-reporting`,
uncommitted).** `npm run lint` clean (0 errors / 0 warnings); `npm run build`
clean; `npm run test:unit` **89 files / 4,809 tests pass** (86 / 4,659 before
this change; +150: `portfolioSources.test.js` 52, `portfolioReport.test.js`
60, `portfolioSurface.test.js` 38); `git diff --check` clean. **Not run:**
the Rules and Functions suites (no rule, Function or code they cover
changed), and any browser or production check.

**What the automated tests prove.**

| Area | Proven by | What |
|---|---|---|
| Selector parity | `portfolioReport.test.js` | Every row figure equals the L2-A report figure for the same records, and the independently stated fixture figures; the model imports no selector below `buildCommercialReport` |
| Same-currency subtotals | same | Two-project sums to the cent; integer-cent addition (0.10 + 0.20 = 0.30; 1,000 × 0.01 = 10); a genuine zero is a valid figure |
| Mixed currencies | same | One group per currency; no cross-currency sum anywhere in the model; only integer counts span currencies; the company base currency changes nothing; an inherited currency is marked |
| Margin | same | Aggregate = `marginPercent(Σ profit, Σ contract)` (25.47%), not the average of project percentages; suppressed when incomplete; *Not calculable* on a non-positive contract sum |
| Working vs approved | same | Working budget → *Not approved* with the working amount apart; budget / variance subtotals incomplete; a failed integrity check is Unavailable, never the working figure |
| Loading / failed | same | Unread project → "—" everywhere and not exportable; a failed register → only its dependent figures Unavailable, the group subtotal incomplete with the affected count, coverage incomplete; a wholly failed project is Unavailable, not zero |
| Adverse figures | same | Budget overrun and negative margin carried signed, with the matching PULSE findings |
| PULSE | same | Exactly the five financial indicators; finding / no finding / not evaluated kept apart; a failed source is *not evaluated*; counts only |
| CSV | same | Scope, currencies, time, read window, coverage; a currency on every line; `INCOMPLETE` subtotals (never the partial sum, never zero); `NOT APPROVED` + working column; formula-injection neutralised in project, status and company names; a loading or empty portfolio refused |
| Query parity | `portfolioSources.test.js` | Each register's collection, `createdAt` ordering and document mapping match the live hook's source; document paths; the adjustments filter; the approved-budget conditionals |
| Approved budget | same | Pointer only (working); version 1; version 2 with a separate original; adjustments present / absent; failed pointer, header, snapshot, adjustments and missing original each Unavailable; equal to the live composite object |
| Loader | same | Whole registers; failures kept as `error: true` and never reject the project; 13 / 15 / 17 reads; at most three projects at once; no double read; cancelled and superseded runs report nothing; a StrictMode-cancelled loader issues no read |
| No listener / no write | same | The hook contains no listener, uses server reads only, no collection-group query, limit, write, Function call or timer |
| Access (UX) | `portfolioSurface.test.js` | Sidebar entry for the three financial roles only; the role gate precedes the view and only the view calls the loader; no page file imports Firebase |
| Page structure | same | Controls; export / print disabled until settled; incomplete-coverage wording outside the print-hidden controls; table at `lg` and in print, cards below; accessible table markup; drill-down links; tokens only; the Dashboard imports nothing from the portfolio |

**Company isolation and external-role denial are NOT re-proven here** — they
are Rules behaviour, unchanged, covered by `tests/rules/externalRoles.rules.test.js`
(get and list for every financial collection, other-company and
collection-group denial). The unit tests above prove only that the page does
not *issue* the reads for a non-financial role.

### Manual acceptance — browser, before or at release (NOT RUN)

Use a company with at least three projects, one of them Completed, one with
a working budget only, and — if available — one in a second currency.

| # | Step | Expected |
|---|---|---|
| P1 | Sign in as `company_admin`. Sidebar | A **Portfolio** entry between Projects and Contacts |
| P2 | Open Portfolio | Rows show "—" then fill in project by project; the status line counts projects read; Export and Print are disabled until all have loaded |
| P3 | Header | Company, "Open projects (N projects); M completed not included", the currencies, a generation time and a "Records read between … and …" window |
| P4 | For three projects, open each project's **Reports** tab in another tab | Contract sum, approved budget, actual, committed, forecast final cost, variance, gross profit, margin, supplier invoices unpaid, client invoices outstanding and pending client variations match the portfolio row **to the cent** |
| P5 | A project with a working budget only | Budget source "Working budget (not approved)"; Approved budget and Variance read **Not approved** with "Working budget …" beneath; that currency's Approved Budget and Variance subtotals read **Incomplete** with "n of m" |
| P6 | A project with no contract value | Contract sum, gross profit and margin read **Not set**; the matching subtotals are Incomplete |
| P7 | A currency whose projects are all complete and approved | Each subtotal equals the sum of its rows (check two by hand); the margin equals subtotal profit ÷ subtotal contract sum |
| P8 | Two currencies (if available) | Two separate sections, each with its own subtotals; no figure anywhere combines them; "reported separately, never combined" in the header |
| P9 | Tick **Include completed** — **PASSED 24 Nov 2026 (B5)** | Completed projects appear and load; already-loaded rows do not reload (Network tab: no repeat requests for them) |
| P10 | Expand a row's **Financial indicators** | Five indicators, each *Finding*, *No finding* or *Not evaluated*, with a link to the relevant project tab; no programme indicator |
| P11 | Click a project name | The project's Reports tab opens |
| P12 | **Refresh** | Rows return to "—" and reload; the read window changes |
| P13 | **Export CSV**; open in a spreadsheet | Header block (scope, currencies, generated, records read, coverage); one PROJECT line per project and one SUBTOTAL line per currency, each with a Currency cell; incomplete subtotals read `INCOMPLETE`; numbers are numbers |
| P14 | **Print / Save as PDF** | Landscape; no sidebar, top bar or buttons; scope, currencies, generation time, read window and any incomplete-coverage notice present; the table (not the cards) printed; nothing clipped |
| P15 | Offline test: DevTools → Network → Offline, then **Refresh** | Every figure reads **Unavailable** (not 0, not "—" forever); "Financial coverage is incomplete"; subtotals Incomplete. Go back online and Refresh |
| P16 | 375 px, 768 px and 1280 px widths | Cards below `lg`, table from `lg` scrolling inside its own container; controls wrap; touch targets ≥ 44 px; no horizontal page scroll |
| P17 | Keyboard only | Checkbox, Refresh, Export, Print, each project link and each indicator disclosure reachable and operable; focus visible |
| P18 | Sign in as `project_manager`, then `qs` — **PASSED 24 Nov 2026 (isolated test company, B5)** | Same page, same figures |
| P19 | **Negative path.** Sign in as a `subcontractor` (or `client`) test user — **PASSED 24 Nov 2026 for both roles; network payloads not decoded (status update above)** | No Portfolio entry in the sidebar. Typing `/portfolio` shows "The Portfolio Report is restricted". Network tab: **no** Firestore request for budget lines, purchase orders, invoices or any other financial collection from this page |
| P20 | Still as the external user, in the console attempt a direct read of a financial collection — **PASSED 24 Nov 2026 for both roles (403)** | Denied by **Firestore Rules** (`permission-denied`) — the rule, not the page, is the control |
| P21 | Dashboard, as a financial role | Unchanged: counts only in the portfolio card, no financial column in the project register, one project in the snapshot |
| P22 | Budget tab of any project, before and after visiting Portfolio | Figures unchanged — the page wrote nothing |

### Production measurement — at release (NOT RUN; do not estimate)

| # | Measure | Record |
|---|---|---|
| M1 | Largest real company: number of in-scope projects | N |
| M2 | Time from opening Portfolio to "All N projects have been read" | seconds (and the read window shown in the header) |
| M3 | Firestore requests issued by one load (Network tab), against 13–17 × N expected | count |
| M4 | Firestore document reads for one load (Cloud Console → Firestore → Usage, before and after, at a quiet time) | reads |
| M5 | Largest single response (Network tab, by size) | which register / snapshot, and its size |

There is no pass threshold recorded yet: these are the first measurements.
A load that is slow for a real company is a design-review trigger (ADR-78 →
*Performance, stated plainly*), not grounds to add a stored aggregate.

---

## 64. GANTT™ core completion — attention filter, programme export / print, last change (ADR-79, 20 November 2026) — LIVE since 20 November 2026 08:52 UTC; Product Owner accepted (REPORTED; no per-step record held here); automated tests PASS

**Per-step production record (25 November 2026 NZDT) — see §72; functional acceptance CLOSED (Lead Architect, 25 November 2026 — REPORTED); R1–R13, Safari / Firefox, G3–G6, G9–G11 carried forward, not passed.** G1, G2, G7, G8, G8a, C1, C3–C5, C9 and L1 PASSED on the CAD fixture, L7 in part (same account in two tabs — refusal, *Reload latest* and the reloaded *Last changed* time PASSED; the "by another user" wording not observable); R1–R13, G3–G6, G9–G11, C2, C6–C8, L2–L6, A1–A3 not run in this record (A1–A3 rest on the emulator and §71 M8). The text below is kept as written.

**Status update (21 November 2026, NZ) — LIVE and Product Owner accepted.** Merged to `main` as `9ce433d` (*Merge GANTT core completion*; feature commit `8e60eb7`) — VERIFIED in Git. Released Hosting-only on 20 November 2026 08:52 UTC: the live bundle `index-Cz4wMhcy.js` is SHA-256-identical to a clean build of `main` `9ce433d` (VERIFIED read-only, 21 November 2026). The three additions — the Lead Architect's G1, G2 and G3 — are Product Owner accepted (REPORTED by the Lead Architect, 21 November 2026; no per-step acceptance record is held here). Certain baseline scenarios were not exercised in the browser and remain a separate product acceptance check. The steps below are kept as written; none is ticked here because no per-step result was supplied.

**What was run (20 November 2026, branch `feature/gantt-core-completion`,
uncommitted).** From `frontend/`: `npm run lint` clean (0 errors / 0
warnings); `npm run build` clean; `npm run test:unit` **93 files / 4,964
tests pass** (89 / 4,809 before this change; +155: `programmeAttention.test.js`
38, `programmeReport.test.js` 59, `activityLastChange.test.js` 21,
`programmePrintAndBaseline.test.js` 37 — the architect corrections); the
PULSE suites (`pulseSchedule.test.js`, `pulse.test.js`, `pulseAttention.test.js`)
pass unmodified after the integrity check was extracted;
`npm run rules:transitional:check` and `npm run functions:calc:check` up to
date; `git diff --check` clean. **Rules (emulator, unchanged ruleset):**
`activities.rules.test.js`, `programmeBaselines.rules.test.js` and
`externalRoles.rules.test.js` — **3 files / 358 tests pass** — run only to
confirm programme access is as before; `firestore.rules` is untouched
(232,460 bytes). **Not run:** the rest of the Rules suite and the Functions
suite (nothing they cover changed).

**One print run, outside the application.** The printed report component was
rendered to static markup with a 160-activity fixture, wrapped in the app
shell's print markers, given the production stylesheet from `npm run build`
and printed to PDF by headless Chrome. Result: A4 landscape, 16 pages, the
table header repeated on each page, no row split, sidebar / top bar / project
header / interactive page absent, no column clipped; the no-baseline, filtered
variant printed on one page with no baseline column and the "outside this
filtered scope" notice. With the named page removed the browser printed
portrait and scaled to fit. **This is evidence about the stylesheet and the
component, not about the running page** — the `beforeprint` mounting, the
print dialog and other browsers are in the manual checks below.

**Print mechanism run, outside the application (architect correction).** The
real `hooks/usePrintMoment.jsx` and the real `ProgrammeReport.jsx`, in a
temporary page (not in the repository) served by the Vite dev server and
loaded in headless Chrome:

| Step | Observed |
|---|---|
| Page loaded | Report not in the DOM |
| Print button — DOM read at the instant `window.print()` is called | Report mounted; scope "Whole programme — 3 of 3 activities"; active baseline; 3 rows |
| `afterprint` | Report removed |
| `beforeprint` event — DOM read synchronously after the listeners return | Report mounted, same content |
| `afterprint` | Report removed |
| One click that changes the filter AND the selected baseline and prints | At `window.print()`: scope "Filtered programme — 1 of 3 activities (Attention: Blocked)", the historical baseline and its notice, 1 row — the pending changes, not the previous values |
| `afterprint` | Report removed |
| Chrome's own print pipeline (`--print-to-pdf`; nothing mounted beforehand) | The PDF contains the report with that filter and baseline; sidebar and interactive content absent |

This establishes that the mounting is synchronous in Chrome's engine. It is
not the GANTT page with live data, not the print dialog, and not Safari or
Firefox.

**What the automated tests prove.**

| Area | Proven by | What |
|---|---|---|
| Print mounting and cleanup (source) | `programmePrintAndBaseline.test.js` | `flushSync` from `react-dom`; both mounting updates are inside it (button and `beforeprint`); `window.print()` is called after the flush; `afterprint` unmounts; listeners removed on unmount, registered once; no print library; the page holds no print state of its own; L2-A / L2-C / Final Account pages do not use the hook |
| Filters and baseline in print | same | The printed model is the page's one memoised report over the displayed set, with every filter and the baseline among its inputs; a filter narrows the rows and is named; changing the selected version changes label, basis and variances together |
| One integrity check | same | `baselineSnapshotProblem` equals `resolveActiveBaseline`'s verdict case by case; GANTT availability returns PULSE's problem and reason for the same pair; the count comparison exists once in the codebase; the page has one usability answer |
| Invalid baseline suppression | same | Five bad pairs (count mismatch ×2, missing, wrong version, malformed): comparison null, flag `null`, no baseline date or variance on any row, nothing matches the filter; CSV `UNAVAILABLE` / `NOT EVALUATED` with the reason; PULSE refuses the same pair; the counter-example shows the incomplete snapshot WOULD have produced plausible figures; current-plan flags unaffected; a header without an integer count stays comparable |
| Valid baseline = PULSE | same | Active version selected: the flag count and the flagged activities equal the PULSE indicator's |
| Historical vs active | same | A valid historical version is still compared (2 later) while PULSE on the active one reports 1; `isActive`, the basis sentence, CSV `HISTORICAL` / `ACTIVE`; nothing claimed when the header list is unknown |
| Hide baseline | same | `baselineShown` appears only in the visual view; absent from availability, attention and the report |
| No mutation | same | Frozen activities, headers and snapshots (valid and invalid) unchanged; no baseline hook writes |
| Overdue / blocked / conflict / review / later than baseline | `programmeAttention.test.js` | Each flag on a fixture built to isolate it; `daysLate` and `laterBy` values; a future start is never blocked; a missing or cancelled predecessor is *review*, never *conflict* |
| Combined flags and counts | same | One activity with several flags, fixed order; `any` counts unique activities (6) while the flags total 9; the filtered list length equals its count for every filter value |
| Cancelled / completed | same | Cancelled history carries no flag; work finished after its baseline is not flagged; cancelling a flagged activity clears its flags; a link problem on a closed successor is not counted |
| No baseline selected | same | Four no-baseline shapes: count `null` (not zero), nothing matches the filter, the other four flags unchanged; a different selected version gives a different answer |
| Hidden predecessors still block | same | A search showing only the successor still reports it blocked and in conflict; counts unchanged; the counter-example (states built from the filtered list) yields a DIFFERENT flag, proving why the page must not do it |
| PULSE consistency | same | `evaluatePulse` and the index over the same records: overdue, blocked, link and activity counts for dependency review, and later-than-baseline are equal; the module imports the selectors and contains no date, status or graph logic |
| Page wiring (source) | same | States and the index are built from `ordered`; chart, list and cards all receive `filtered`; the choice is validated page state cleared with the other filters; the disabled "not evaluated" choice |
| Report rows | `programmeReport.test.js` | Activity and milestone rows; status labels; per-link dependency text with lag and state (full and compact forms); flags; unusable stored values become null |
| Scope | same | Whole and filtered wording naming every filter; rows in displayed order; whole-programme counts on a filtered report; the outside-scope count and sentence; a predecessor outside the scope still named; empty programme and empty scope |
| Baseline | same | Eight input cases → the five availability states, in precedence order, each with its explanation; label and approval day; signed variances (negative is not a flag); *added after* / *cancelled* with no day figure; no baseline → no variance, no date, no flag; a comparison without an available baseline is ignored; not exportable while loading |
| CSV | same | Header block; counts as numbers; the documented headings; ISO dates quoted, numbers unquoted (incl. a negative and a zero variance); every missing value a marker, no empty cell; no-baseline and failed-baseline markers distinct; filtered scope and note; CRLF; refusal of a loading report or a missing time; file name |
| Formula injection | same | Six hostile names (`=`, `+`, `-`, `@`, leading tab, leading spaces) in activity, responsible, cost code, company and project cells are quoted and apostrophe-prefixed; a hostile predecessor name cannot start the dependency cell; quotes, commas and line breaks survive; the serialiser uses `csvRows` only |
| No data writes | same | Report and CSV built from deep-frozen records: nothing mutated, output deterministic; the three modules and the print component contain no Firebase, hook, storage or clock; the page's export / print handlers call no activity or baseline write and the page has no Firestore write; no export collection in hooks or Rules |
| Print surface (source) | same | The report carries `.commercial-report` and the existing report classes; hidden on screen, shown in print; wrap not clip; no new colour or font; every new selector scoped to the report; a table with caption and header cells, never the chart; company, project, title, time, scope and baseline in the header; baseline column only when available; mounted only while printing; dialogs inside the hidden wrapper; CSV and print share one model |
| Last changed | `activityLastChange.test.js` | Timestamp and plain `{seconds, nanoseconds}` shapes; thirteen non-instants → null (never "now"); you / another user / not recorded; no uid to compare → "another user", never the viewer; missing, pending (`updatedAt` null) and malformed metadata; no text contains a uid or a guessed date; the creator is not presented as the last author; no lookup, no audit collection, one listener; shown in the read-only detail (QS) and the editor; role flags unchanged |

**What the automated tests do NOT prove.** Anything rendered in a browser:
the filter chips and counts on a real programme, that the chart / list /
cards actually update together, the downloaded file opening in a spreadsheet
application, the print dialog output from the running page, focus and
keyboard behaviour, and every role's real session. The checks below cover
those. **None has been run.**

### Manual acceptance — after the Hosting release (production, an existing test project; read-only except where stated)

Use a project with: at least one overdue activity; a not-started activity
whose start has arrived and whose predecessor is unfinished; an activity
planned to start before its predecessor allows; a link to a cancelled
activity; an approved baseline with at least one open activity whose planned
finish is later than it. Create nothing new unless the project lacks a case.

**Attention filter**

| # | Check | Expected |
|---|---|---|
| G1 | Open GANTT as a project manager | A *Schedule attention* row of six choices with counts under the existing filters; nothing pressed; chart unchanged |
| G2 | Compare each count with the PULSE tab of the same project | Overdue = *Programme activities overdue*; Blocked = *blocked by predecessors*; Dependency conflict + Dependency requires review activities = *dependencies need review* (activities); Later than baseline = *later than approved baseline* when the ACTIVE baseline is selected |
| G3 | Press each flag in turn | Chart, List and (narrow window) cards show the same activities; "Showing n of N" equals the count; pressing again releases it |
| G4 | Press *Needs attention* | The union; an activity with two flags appears once |
| G5 | Search for the blocked successor only, then press *Blocked* | It is still listed and still labelled Blocked although its predecessor is not shown |
| G6 | Tick *Hide completed & cancelled* and set Status = Not started | Counts in the attention row do not change |
| G7 | Select a different approved baseline in the baseline panel | The *Later than baseline* count follows the selection; press *Hide baseline* — the count does not change |
| G8 | A project with no approved baseline | *Later than baseline* is disabled and reads "not evaluated" with the reason — not 0 |
| G8a | Select a historical approved baseline (a project with two) | The comparison is shown; an amber line under the chips says it is a historical baseline, names the active one and says the PULSE count can differ; the CSV has `Baseline basis: HISTORICAL` and the printed header carries the same sentence. Select the active one again: the line goes and the count equals PULSE |
| G9 | *Clear filters* | Every filter, including the attention choice, is released |
| G10 | Tab to the chips; Space / Enter | Each is reachable, shows focus, and announces its pressed state and count |
| G11 | Leave the tab open across local midnight (or change the device date and refocus) | Overdue and blocked counts move with the day, as the chart does |

**CSV**

| # | Check | Expected |
|---|---|---|
| C1 | *Export CSV* with no filter | `constrap-programme-report-<project>-<date>.csv` downloads; nothing changes on the page; the Network tab shows no Firestore write |
| C2 | Open it in Excel and in Google Sheets / Numbers | Header block (company, project, generated time, scope "Whole programme — N of N", baseline, counts, notes); one row per activity in programme order; accents and em dashes intact |
| C3 | Dates and numbers | Dates read `YYYY-MM-DD`; Duration, Progress, Days overdue and the variances are numeric (sum / sort works); a later finish is positive, an earlier one negative |
| C4 | Compare five rows with the List view | Every value matches; a milestone has Type Milestone and Duration 0 |
| C5 | Missing values | Actual dates `NOT RECORDED`; no responsible `NOT ASSIGNED`; an activity added after the baseline `NOT IN BASELINE` / `NOT COMPARED` with the reason; no empty cell in the table |
| C6 | Export with *Blocked* pressed | Scope line names the filter; only those rows; a Note says how many flagged activities are outside the scope; the counts are still the whole programme's |
| C7 | Export on a project with no approved baseline | Baseline `NO APPROVED BASELINE`; every baseline cell says so; *Later than baseline* `NOT EVALUATED`; no variance of 0 anywhere |
| C8 | Temporarily name a test activity `=1+1` (author role; rename back) | The cell shows the text `'=1+1`, not 2 |
| C9 | Baselines after export | The baseline panel is unchanged: no new draft, no new approved version |

**Print / Save as PDF**

| # | Check | Expected |
|---|---|---|
| R1 | *Print / Save as PDF* (Chrome), preview | A light report: title block, attention counts, schedule table. No sidebar, top bar, project tabs, filters, chart or buttons |
| R2 | Orientation and width | A4 landscape; every column visible; no text cut at the right edge |
| R3 | A programme of 60+ activities | Several pages; the column headings repeat on each; no activity row is split across two pages |
| R4 | Long activity name; an activity with three predecessors | Both wrap inside their cell; nothing overlaps |
| R5 | Header content | Company, project, scope, baseline name and approval day, generation date and time with zone; "printing creates no baseline" |
| R6 | With a filter pressed | The scope line names it; the amber notice states how many flagged activities are not listed |
| R7 | No approved baseline | "No approved baseline" with the explanation; no baseline column; *Later than baseline* "Not evaluated" |
| R8 | Cancel the dialog | The page is exactly as before; no report visible on screen; no leftover blank area |
| R9 | Browser menu Print (Ctrl / Cmd + P) on the GANTT tab | The same report, not the dark interactive screen and **not a blank page** |
| R9a | Change a filter, then immediately print (button, then menu) | The scope line and rows are the new filter's, never the previous one |
| R9b | Print twice in a row; then print, cancel, and inspect the page (DevTools → Elements, search `programme-report`) | Each print is complete; after the dialog closes no report element remains in the DOM |
| R10 | With the activity editor open, Ctrl / Cmd + P | The report prints; the dialog does not |
| R11 | Safari and Firefox | Report prints readable; if portrait, choose Landscape — record what each browser does |
| R12 | Print another tab (e.g. Budget) afterwards | Unchanged from before this release |
| R13 | Reports tab and Portfolio print | Unchanged (they share the print rules) |

**Last change**

| # | Check | Expected |
|---|---|---|
| L1 | As a project manager, edit an activity you saved earlier | Above the buttons: *Last changed* date, time and zone "by you", with the "most recent saved change only" caption |
| L2 | Open an activity last saved by a different user | "by another user" — no name, no email |
| L3 | Save a change, reopen the editor | The time is the save just made |
| L4 | As QS, open a bar | The read-only detail shows the same *Last changed* row; still no Save, no quick action |
| L5 | A cancelled activity (any role) | The detail shows when it was last changed (the cancellation) |
| L6 | *Add activity* | No *Last changed* line in the new-activity form |
| L7 | Two sessions: open the editor in A, save the same activity in B, save in A | A is refused with *Reload latest* exactly as before; after reloading, *Last changed* shows B's save as "by another user" |

**Access (unchanged behaviour — confirm)**

| # | Check | Expected |
|---|---|---|
| A1 | QS | Filter, export and print work; no add / edit / cancel / capture controls |
| A2 | Subcontractor and client | "Programme not available"; no export or print control; no programme read in the Network tab |
| A3 | A user of another company | Cannot open the project |

**Stop and report if:** a count differs from PULSE for the active baseline;
the chart and the list show different activities; an export or print creates
or changes any document; a baseline variance appears without an approved
baseline; a name or email appears in *Last changed*; or any other tab prints
differently than before.

## 65. L3 Stage 1 — recovery verification, availability check and Final Account failure alert (21 November 2026) — CLOSED: monitoring CREATED (VERIFIED read-only); restoration verification SUCCESSFUL (REPORTED); alert delivery TESTED 24 November 2026 UTC through a temporary policy on the Product Owner channel (C1-D, §73); neither L3 alert has fired on its real condition; not every document's contents compared

**Status update — Stage 1 closed (recorded 21 November 2026, NZ).** Evidence and its labels are in DEPLOYMENT.md → *L3 Stage 1* → *Monitoring release record* and *Firestore recovery protection* → *Restoration verification record*. Against the operator checklists below (left unticked as written):

| Check | Result | Status |
|---|---|---|
| O2 — five policies, all enabled | Uptime policy `15559930914799323534` and Final Account policy `9683374685335961795` enabled; DC46 A, B, C preserved | VERIFIED read-only, 21 November 2026 |
| O1, O3 — every location passing for 15 minutes; no incident opened | Not re-read for this record | NOT RECORDED |
| O4 — release record written | Done in this revision | — |
| V1 — only `(default)`, delete protection ENABLED | Confirmed | VERIFIED read-only, 21 November 2026 |
| V3 — unauthenticated request returns 403 | 403 | REPORTED by the Lead Architect |
| V4 — counts and sample hash | 44 collection groups and 211 documents matched; sample hash matched | REPORTED |
| V5 — cleanup | Temporary database `restore-verify-20261120-2329` removed; listing shows only `(default)` | REPORTED; listing VERIFIED 21 November 2026. Deletion time and mechanism not independently established |
| V2, V6 and the IAM / TTL parts of V3 | Not supplied | NOT RECORDED |

**Updated 25 November 2026 (C1-D, §73):** delivery of an opened and a resolved alert notification through the Product Owner channel was TESTED with a temporary heartbeat policy; receipt was REPORTED by the Product Owner, and natural recovery was observed in the cloud. The availability policy file was aligned with the policy as created (check-id filter, `resource.label.*` grouping). Neither L3 alert has fired on its real condition. *As written:* **Still open:** actual delivery of an alert notification has NOT been tested. The restoration check compared counts and one document hash; it did NOT compare every document's contents.

**What this stage is.** Operational files and documentation only
(DEPLOYMENT.md → *L3 Stage 1*). No application code, Rules, Functions or
dependency changed, so the full unit, Rules and Functions suites were not
re-run; they are unaffected by construction and still run in CI.

**What was run (21 November 2026, branch `chore/l3-recovery-monitoring`,
uncommitted).** From `frontend/`:

- `npx vitest run --config vitest.config.js tests/unit/monitoringPolicies.test.js tests/unit/recoveryEvidence.test.js`
  — **2 files / 35 tests pass** (24 monitoring, of which 5 are new; 11 new
  recovery-script tests).
- `npx eslint tests/unit/monitoringPolicies.test.js tests/unit/recoveryEvidence.test.js --max-warnings 0` — clean.
- `git diff --check` — clean.

**What the tests pin.** The uptime check's body match is text
`frontend/index.html` contains; the availability policy needs two or more
failing locations for two check periods; the callable policy names the
service of the `approveFinalAccount` export and its region; the only
expected Final Account refusal that answers 5xx is the deliberate off
switch, which the notification names; no recipient is committed; the count
script sends only a count query and one document read, names every
collection the Rules, the hooks and the Functions use, refuses a read time
that is not a whole minute, and has no default database.

**Read-only production checks (21 November 2026).**

- Both alert filters accepted by the live Monitoring API (`timeSeries.list`).
- The uptime metric `monitoring.googleapis.com/uptime_check/check_passed`
  and the `uptime_url` resource labels (`project_id`, `host`) read from the
  API.
- Request-body field names and enum values checked against the Monitoring
  v3 discovery document.
- `gcloud` 593.0.0 help read for every command in the restore procedure;
  every read-only command in it and in `ops/RUNBOOK.md` was executed.
- The guard in the restore procedure refuses `(default)` in zsh and bash.
- The count script run against `(default)` at the two whole minutes either
  side of backup `f6e32570…`: 211 documents in 44 collection groups at
  both, sample hash equal, zero writes in that minute.
- The exact snapshot time is refused by the API (`not a whole minute`), as
  the procedure states.

**Not verified — cannot be without a production change.**

- That the three monitoring files are accepted on creation (the API has no
  dry run), and that either alert fires and notifies on its real condition.
- Everything about the restore itself: its duration, the restored
  database's default configuration, the Security Rules behaviour of a
  restored database (documented by Google as deny-all for an id never used
  before; the procedure checks it), and the count comparison on restored
  data.

### Operator acceptance — monitoring (after authorisation)

- [ ] O1 — The uptime check exists and every location passes for 15 minutes.
- [ ] O2 — Five policies listed, all enabled; the two new ones match their files and carry the intended channels.
- [ ] O3 — No incident opened by creating them.
- [ ] O4 — *Monitoring release record* written; status lines corrected.

### Operator acceptance — restoration verification (after authorisation)

- [ ] V1 — Step 0: one database, `(default)`, delete protection ENABLED; the guard prints OK.
- [ ] V2 — Step 2: expected counts captured; the two minutes MATCH; no write in that minute.
- [ ] V3 — Step 4: unauthenticated request to the temporary database returns 403; no public IAM member; no TTL policy or schedule on it.
- [ ] V4 — Step 5: MATCH on every collection group and the sample hash.
- [ ] V5 — Steps 7–8: temporary database deleted; `(default)` unchanged (same uid, protection, schedule, backups); application loads.
- [ ] V6 — *Restoration verification record* written with no customer content.

**Stop and report if:** the guard prints STOP; the unauthenticated request
returns 200; any count differs; the delete names anything but the temporary
database; or cleanup fails (ops/recovery/README.md → *If cleanup fails*).

## 66. L3 Stage 2 — application error recovery (ADR-80, 21 November 2026) — LIVE (released with the L4 Hosting deploy from `main` `a30699e`, which contains `b7f825f`; REPORTED, 22 November 2026); automated tests PASS; **E1–E10 RUN 25 November 2026 (§74.3); NOT closed (Lead Architect, 25 November 2026 — §74.10):** E1 (production) and E3–E10 (local emulators only) ACCEPTED with their evidence limitations; **E2 OPEN** — not passed as written (tracker D3 #32, #34)

*Heading as written at the run:* … **E1–E10 RUN 25 November 2026 (§74.3), awaiting architect review:** E1 PASSED in production; E3–E10 PASSED on local emulators only; **E2 NOT PASSED as written** (tracker D3 #32, #34)

**L3 Stage 2 CLOSED within its accepted scope, 26 November 2026 (§76.6):** E1 in production; E2-A and E2-B in production under in-page injection (§76.3); E3–E10 on local emulators only. E2-C is a recorded limitation.

*As written before the release:* D3 #32 correction and the corrected E2 procedure: §75 (25 November 2026) — IMPLEMENTED on `fix/membership-resolution-state`, pending integration and production verification. E2 stays OPEN until then.

*Heading as written before 25 November 2026:* … automated tests PASS; E1–E10 browser acceptance NOT RECORDED

*As written on 21 November 2026:* IMPLEMENTED on `fix/l3-application-error-recovery` (uncommitted); automated tests PASS; NOT DEPLOYED; browser behaviour NOT VERIFIED.

**What changed.** (1) The project route no longer says *Project not found.* when the projects read failed, was refused or has only been answered from the local cache. (2) A reusable write-outcome helper (`lib/writeOutcome.js`, `hooks/useWriteAction.jsx`, `components/WriteFeedback.jsx`, `components/UnconfirmedWrites.jsx`) applied to the three money registers: Client Invoices, Client Receipts and Supplier Payments (nine writes). No Rules, Functions, data-hook, formula or dependency change.

**SDK behaviour the design answers to — MEASURED, 21 November 2026** (the real Web SDK, firebase 12, in Node, pointed at a closed local port; no production access):

| Operation with the backend unreachable | Result |
|---|---|
| `onSnapshot` on a collection | An EMPTY snapshot with `metadata.fromCache === true`, at once; no error |
| `setDoc` (a plain write) | Never settled in 45 s — the SDK queues it |
| `runTransaction` | Rejected with `unavailable` after about 9 s |

A browser tab going offline, and a reply lost after a commit, were NOT reproduced.

**Automated — PASS.** `npm run test:unit`: 96 files, 5,050 tests (two new files, 66 tests; one existing assertion in `projectSnapshot.test.js` updated for the three additive context fields).

- `tests/unit/projectLoadState.test.js` (18): the six states; a failed read is never *not found* whatever the code; `useProject` over a stubbed context; the route layout rendered for ready, loading, not found, unavailable (with *Try again*), permission denied and unconfirmed; a project in another company is plain *not found*; the provider still opens one listener on the same query.
- `tests/unit/writeOutcome.test.js` (48): error classification (refusals certain, network failures uncertain, no SDK text shown, domain messages kept); success reported only on resolution; permission denied; a stalled write leaves *Saving…* after the limit without failing; a second submission and an acknowledgement refused while in flight; late success and late refusal after the limit; the operation runs exactly once; an uncertain outcome locks the submit until acknowledged; a closed dialog hands the write to the page notice; the three pages' wiring; the data hooks unchanged; the remaining-site count. **Lifecycle checks added after the architect's final correction (9):** closing a dialog during an unresolved write starts no second write; a REOPENED dialog of the same kind is refused, without calling the write, while the first is unanswered and until the server confirms it; a dialog closed on an uncertain outcome keeps the guard until the user clears the page notice, and that clearing is never recorded as a confirmed result; a late uncertain result after closure keeps the guard and a late definite failure frees it; five rapid submits call the write once; a late settlement after closure notifies no dialog listener and leaves no unhandled rejection; the controller holds no cancel mechanism.

ESLint: clean. Production build: succeeds. `git diff --check`: clean. The Rules and Functions suites were NOT run: no Rules, Functions or data-hook file changed.

**Not covered by automation.** Interaction (clicking *Try again*, the acknowledgement, *Dismiss*), real connectivity loss, and the visual result. The unit runner has no DOM.

**Manual acceptance (after a Hosting deploy; a test project, not customer data).** *Run on 25 November 2026 — results, evidence classes and limits in §74.3. The boxes below are left unticked: only E1 was executed in production; E3–E10 passed on local emulators; E2 did not pass as written.*

- [ ] E1 — Open a project normally: header and tabs as before. Open `/projects/<an id that does not exist>`: *Project not found.*
- [x] E2 — **replaced on 25 November 2026 (tracker D3 #34; full procedure and local results in §75.7 and §75.6). E2-A and E2-B PASSED in production on 26 November 2026 NZDT, under in-page transport injection (§76.3).**
  - [x] E2-A — signed in on a project URL, block the Firestore host only (DevTools → Network request blocking), then reload: *Waiting for the server* from the membership gate; never *No active membership*; no project or company content. Remove the block: the project appears by itself.
  - [x] E2-B — with a project open, cut the connection: the page stays and nobody is signed out; back online it continues. (The project route's own *Waiting for the server* needs the connection to drop between the membership read and the projects read — by injection only, §75.6.)
  - E2-C — full offline hard reload: the browser's own error page. **Offline start-up is not supported** (no service worker). A recorded limitation, kept for a future PWA / offline-first increment — not a check to pass.
  - *As written before 25 November 2026 (not executable — an offline reload never loads the page):* E2 — DevTools → Network → Offline, then reload a project URL: *Waiting for the server* (not *Project not found*). Back online: the project appears without a reload.
- [ ] E3 — As a deactivated or wrong-company test member (or with the projects request blocked so the listener errors): *could not be loaded* or *do not have access*, with *Try again*; after access or connectivity is restored, *Try again* loads the project.
- [ ] E4 — Client Receipts → create a draft online: the dialog closes and ONE draft appears, numbered as before.
- [ ] E5 — Offline, create a draft receipt (a transaction): after some seconds an amber message says it was not confirmed; the submit button is disabled; the form keeps its contents. Check the list, use *I have checked…*, go online, submit: ONE draft exists.
- [ ] E6 — Offline, post a draft receipt (a plain write): *Posting…* for 15 s, then *Waiting for confirmation…* with *Close* enabled. Close: the notice at the top of the page says it is unconfirmed. Go online: the notice changes to *was saved*; the receipt is posted once.
- [ ] E7 — Repeat E6 leaving the dialog open: it closes by itself when the connection returns.
- [ ] E7a — During E6, after closing the dialog and while the notice still says unconfirmed, reopen *Post* on the same or another draft receipt and submit: a red message says an earlier attempt is unconfirmed and this one was not sent; no second write happens. After the notice turns to *was saved*, a new post works.
- [ ] E7b — During E5, close the dialog while the amber uncertain message shows: the page notice says it *may or may not have been saved*. Reopen *New receipt* and submit: refused. Click *I have checked the list* on the notice, submit again: ONE draft is created.
- [ ] E7c — With the browser console open through E5–E7b: no React warning about updating an unmounted component and no *Uncaught (in promise)* error.
- [ ] E8 — Double-click a submit button, and double-click *Issue* on a client invoice: one write, one record.
- [ ] E9 — As a role without write access, attempt a write through a stale tab: a red message ending *Nothing was saved*; no raw SDK text.
- [ ] E10 — Supplier Payments and Client Invoices: create, post or issue, and void each still work online, with unchanged figures.

**Remaining write sites (not changed).** 42 files with 58 hand-rolled `setSaving(true)` states (pinned in `writeOutcome.test.js`), plus `setBusy` in Team Settings, Accept Invite and the PULSE acknowledgement panel. They behave as before: a plain write made offline leaves the dialog on *Saving…*, and raw SDK text can appear. Suggested order for a later rollout: Supplier Invoices, Purchase Orders, Progress Claims and Variations (create and edit); Retention Releases and Cash Flow lines; Budget and Forecast; then documents, RFIs, programme and settings. Dialogs built on the `*Actions.js` modules already map errors but still wait without limit.

## 67. L4 — BOQ → working budget transfer (ADR-81, 21 November 2026) — CLOSED: LIVE and production-accepted (REPORTED by the Lead Architect, 22 November 2026); acceptance UX correction LIVE and PASSED; **T9, T14 (as `subcontractor`) and the Quant step of T16 PASSED in production on 25 November 2026 (§71) — remaining acceptance CLOSED with recorded limitations (Lead Architect, 25 November 2026 — REPORTED)**; T14 as `client` accepted on earlier production and emulator evidence, not re-run; a real disconnection not tested (emulator coverage retained)

*Heading as written before the 25 November 2026 run:* … acceptance UX correction LIVE and PASSED; browser gaps T9, T14, the Quant step of T16 and a real disconnection remain (emulator coverage retained)

*As written before closure:* DEPLOYED (`main` `a30699e`; REPORTED by the Lead Architect); production browser acceptance 22 November 2026: 13 of 16 PASS, T16 partly exercised, T9 and T14 NOT TESTED in production; acceptance UX correction IMPLEMENTED on `fix/l4-transfer-acceptance` (uncommitted), NOT DEPLOYED.

**Automated — PASS (run locally, 21 November 2026).**

| Suite | Command | Result | New in L4 |
|---|---|---|---|
| Unit | `npm run test:unit` | 99 files, 5,152 tests | 3 files, 102 tests |
| Functions pure (predeploy) | `npm run functions:test` | 5 files, 130 tests | 1 file, 31 tests |
| Rules emulator | `npm run test:rules` | 36 files, 2,336 tests | 17 tests in `budgetLines.rules.test.js` |
| Functions emulator | `npm run test:functions` | 10 files, 295 tests | 1 file, 63 tests |

ESLint (app and Functions): clean. Production build: succeeds. `functions:calc:check`, `functions:transfer-calc:check`, `rules:transitional:check`: up to date. `git diff --check`: clean. Two existing pins were updated because a third callable now exists: the `onCall(` count in `finalAccountBundle.test.js` (2 → 3) and the exported-function count in `functions/test/finalAccount.test.js` (10 → 11). No existing security assertion was relaxed.

- `tests/unit/boqBudgetTransfer.test.js` (42): grouping and whole-cent sums against `lib/boq.js`; zero rate transfers at 0, null rate blocks the whole code; void items excluded; every blocker (unpriced, unusable source, currency, missing and inactive cost code, manual line, two lines on a code, unreadable line); create / refresh / unchanged / fully voided; set-to-zero only when chosen; the summary; the review key (deterministic; unchanged by read order, timestamps, actors, names and notes; changed by a quantity, rate, unit, new item, void, unpricing, cost-code move, working amount, new manual line, deactivated code, currency); the request key; already-applied recognised after a commit and NOT after a BOQ change, a manual edit or different choices; transferred lines capture into a SHIELD snapshot and a later working change does not move the approved total.
- `tests/unit/boqBudgetTransferBundle.test.js` (27): the generated bundle is fresh, deterministic, self-contained and equal to its source for eleven variants covering every row state and blocker; the callable surface (App Check, region, no secret, schema, company from membership, every read transactional and before the first write, no approved-budget collection named); the browser surface (no Firebase import in the page or dialog, no amount in the request, the shared write-outcome controller, no hook writes a BOQ-sourced line).
- `tests/unit/boqBudgetTransferActions.test.js` (33): the request; the three results; every typed refusal is certain and says nothing was written; `unauthenticated`, `permission-denied`, `not-found`, `invalid-argument` without detail are certain; `deadline-exceeded`, `unavailable`, `internal`, `unknown`, `cancelled`, `aborted`, `resource-exhausted` and a bare network error are UNCERTAIN; with the write controller a stale review unlocks, an uncertain outcome locks until acknowledged, and a second click sends nothing.
- `functions/test/boqBudget.test.js` (31): gates before any data access; the exact request schema; membership; the shipped bundle; one transaction with five attempts; the kill switch default off in code, present in every env file and `true` for production; the flag is read by the new callable only and the Final Account gate is unchanged; `.env.local` is ignored by Git and by the Functions deploy and no env file carries a secret; no existing production parameter changed.
- `tests/rules/budgetLines.rules.test.js` (+17): no financial role can create a line at a `boq-` id or with `boqSource` (including `{}` and `null`); an id merely containing `boq-` is ordinary; no client can alter, replace, remove or add `boqSource`; each financial role can still correct `budgeted` and `notes` on a BOQ-sourced line with the provenance untouched; non-financial roles can neither read nor change one; delete and re-pointing stay refused; cross-company create refused.
- `tests/functions/boqBudgetTransfer.test.js` (63), real Admin SDK transactions against the emulators:
  - who may transfer: unauthenticated, no membership, each of the three roles, subcontractor / client / super_admin refused, deactivated, a role removed just before the transaction, another company (not found; with a same-id project of their own, a stale review that reveals nothing), the kill switch, an amount in the request;
  - transfer: one line per cost code at the server's amounts with `first` / `latest`, the currency lock and one audit event; a refresh moves `budgeted` and `latest` together and preserves `first`; a manual edit shows as a discrepancy and the next transfer offers a refresh; blocked codes left alone; currency mismatch; a review made in another currency is stale; zero rate;
  - fully voided source: unticked writes nothing; ticked sets zero; an ineligible tick refuses the whole request;
  - stale and repeats: stale after a BOQ edit, after a manual line, and for a manual line with no `createdAt`; the identical request after a commit is *already applied* with no second line, event or rewrite; after a BOQ change or a manual edit it is stale; different choices are not the applied request; a current review with nothing to write is *unchanged* with no event; an empty BOQ locks no currency;
  - simultaneous transfers: two users, and one user three times — one set of lines, one event; a forced abort is retried once;
  - concurrent source writes (a BOQ edit, a new priced item, a new unpriced item, a new manual line, a void) started between the transaction's reads and writes: the transfer either refuses or the competing write commits strictly after it;
  - failures: an error in the transaction, and a commit rejected by the server, leave no line, no lock and no event; five aborts give the typed busy refusal; a deadline is not typed and a repeat applies once; a lost response after a commit is answered *already applied*; an over-bound register is refused by name;
  - approved budget: after a create, a refresh and a set-to-zero, the pointer, header, snapshot and adjustment documents are byte-for-byte unchanged with unchanged update times, and the resolved approved total and per-cost-code figures are unchanged; only `budgetLines`, the project lock and the audit event are written; an already-locked project is not rewritten;
  - scale; the deployed wrapper (App Check required, typed refusals, end to end).

**Measured (emulator, one run, this machine).** 150 BOQ items over 40 cost codes: 40 lines in 42 ms, audit event 5,814 bytes. 2,000 items over 500 cost codes: 500 lines in 209 ms, audit event 67,818 bytes; the repeat recognised as already applied. No production timing exists. Each register is bounded by detection at 5,000 documents.

**Concurrency — both serial orders, forced (10 tests, *forced overlap*).** Three overlaps with an in-progress transfer: a BOQ item UPDATE, a BOQ item CREATE (priced, and unpriced) and a MANUAL budget-line insert. The order is fixed by explicit synchronisation and then confirmed from the server's commit times.

| Order | How it is forced | Persisted result |
|---|---|---|
| **B — transfer first** | The competing write starts after the transfer has read its sources and is checked to be still unsettled 500 ms later, as the transfer proceeds to its writes | The transfer applies the EARLIER source (cc1 at 137.02, two items); the write's commit time is later than the line's; the BOQ change is then visible as drift (*Refresh* to 187.02 or 637.02), and a late manual line as *Blocked — more than one budget line* |
| **A — source write first** | The same start; the transfer's first attempt is then aborted (retryable ABORTED), the write commits, and a gate holds the second attempt until that commit is acknowledged. Recorded sequence: attempt 1 read → attempt 1 aborted → source write committed → attempt 2 read | With a review of the OLD source: refused as stale; no line, no lock, no audit event. With a review of the NEW source: applied on the CHANGED source (cc1 at 187.02; 637.02 with three items); with a new unpriced item, cc1 blocked and never part-summed; with a manual line, cc1 blocked and no `boq-cc1` beside it. The line's commit time is later than the write's |

No transfer was observed that disagreed with its serialisation point, and **no guard was added to the Function** — the tests observe Firestore's existing transaction guarantees. The five earlier race tests, which let the backend choose, took order B every time. All of this is the EMULATOR; production has not been exercised.

**Not covered by automation.** The dialog's interaction and appearance (the unit runner has no DOM); real connectivity loss in a browser; App Check with a real token; production.

**Production acceptance — 22 November 2026 (Chrome, signed in as `company_admin`; RUN by the engineer).** In a sandbox project the Product Owner authorised: **L4 Acceptance Sandbox**, project `3OyBieoY4QHAfQsxBH8T`, company Apex Builders (`2Vf3CVuYE8wWzg8hLjR5`), AUD, existing company cost codes 0100, 0200, 0300 and 0900. Every financial write was confined to the sandbox and checked against the server records (read-only Firestore reads). Before the run, the deployed Rules were byte-identical to `main` (232,776 bytes), `transferBoqToBudget` was at revision `-00001-zol` with every other function on its earlier revision, and `BOQ_BUDGET_TRANSFER_ENABLED=true` was set on that one service (VERIFIED read-only).

| Check | Production result |
|---|---|
| T1–T8, T10–T13, T15 | **PASS** (13 checks) |
| T16 | **Partly exercised:** a double-click sent one request — one line, one audit event; adding, editing and voiding BOQ items, adding and editing manual lines, and SHIELD capture and approval worked. Applying a Quant quantity was NOT exercised |
| T9 | **NOT TESTED in production.** The second tab's change always reached the first tab's live list before a submit, so the server's stale-review refusal was never reached in the browser. It is covered by the Functions emulator tests only |
| T14 | **NOT TESTED in production** — no `subcontractor` or `client` test login exists and none was created. Covered by the Functions emulator and Rules tests only |
| T15 | **PASS by simulation:** a lost response was simulated in the page (the request reached the server and committed; the response was replaced with a network error). The dialog showed the uncertain state, made no automatic retry, locked until acknowledged, and the resend of the same `reviewKey` was answered *Already applied* — one write and one audit event for two requests. **An actual network disconnection was NOT tested** |
| T11, T13 (SHIELD) | Version 1 ($3,320, `ot2xqdkX2hfDA4dmIXAf`) and version 2 ($3,440, `yBLZIcxyaucKuoVuvmj3`) approved in the sandbox. After a transfer under version 1, the version 1 approval, its snapshot and the pointer were byte-identical with unchanged update times; after version 2, version 1's approval and snapshot were unchanged and the pointer moved to version 2. No adjustment was created |

Callable logs for the run: 8 requests, all HTTP 200; 7 `boq_budget.transferred` audit events (the repeat wrote nothing). No browser console errors were observed. **This is not full browser coverage:** one account and one browser; no restricted roles; no real disconnection; DevTools were not available.

**The sandbox is RETAINED** (not deleted). It holds 6 BOQ items, 4 working budget lines and 2 approved SHIELD versions, and **its amounts currently appear in the company Portfolio report** (Approved Budget $3,440, AUD subtotal).

**Acceptance findings and correction — IMPLEMENTED on `fix/l4-transfer-acceptance` (uncommitted), NOT DEPLOYED, NOT browser-verified.** Found in the run: (1) the review tick stayed ticked when a live BOQ change altered the proposal on screen (the request sent was always the one displayed, never a different figure, but the reviewer had confirmed other values); (2) after an uncertain outcome the acknowledgement read *"it was not saved. Let me try again"*, which is wrong when the server did commit; (3) "these 1 change"; (4) a row blocked by an unpriced item did not name it. The correction (Hosting-only; no Rules, Functions, generated bundle or financial-model change):

- The tick stores the key of the exact request it confirms (`transferRequestKey` of the reviewKey and set-to-zero choices — `lib/boqTransferReview.js`). It shows and counts only while that key is the current one; a changed proposal or a set-to-zero toggle clears it in the same render, and it does not come back if the figures return. Submit re-derives the request and sends nothing unless the stored key names it — no React effect is relied on. An unchanged snapshot (new objects, other read order, renamed text) keeps it. The server's stale-review refusal is unchanged.
- The transfer's uncertain state now says the result is not known, to check the Budget tab, that nothing is retried automatically, and that sending again resends the same reviewed transfer, which the server applies once only; the button reads *"I have checked the budget lines — let me send the same transfer again."* Every other dialog keeps the L3 wording (`WriteFeedback`'s default).
- "this change" / "these N changes"; a row blocked by an unpriced item names up to three such items from the BOQ register the page already holds.
- Tests: `tests/unit/boqTransferReview.test.js` (22) — initial confirmation required; only the matching key submits; an asynchronous BOQ change invalidates it and a submit before any reset sends nothing; reconfirmation sends the new key; unchanged snapshots keep it; set-to-zero invalidates it; the uncertain wording claims neither failure nor success; the copy; the server bundle and Functions do not import the module. Two pins in `boqBudgetTransferBundle.test.js` were updated to the new, stricter form.

To accept the correction after its Hosting release: in the sandbox, open *Transfer to budget* with a change pending, tick, change that BOQ item in a second tab — the tick clears and *Apply* is disabled until ticked again; tick a set-to-zero after confirming — the tick clears; read the singular wording on a one-change review and the named unpriced item on a blocked row.

**L4 closure record — 22 November 2026 (REPORTED by the Lead Architect and the Product Owner; not re-read from production in this revision).**

| Item | State |
|---|---|
| L4 BOQ → working budget transfer | **LIVE** |
| Azure CI on `main` and the production deployment (Rules, the one callable, Hosting) | **PASSED** |
| Production financial acceptance (above) | **PASSED** |
| Acceptance UX correction (merged as `d90e21f`, `main` `74c2a6f` — VERIFIED in Git) and its final confirmation-UX checks | **PASSED** |
| SHIELD approved versions 1 and 2 in the sandbox | **VERIFIED** (row T11, T13 above) |
| Browser gaps that remain | T9 server stale-review refusal not reproduced; T14 restricted-role check not performed; the Quant apply step of T16 not performed; a real network disconnection not tested |
| Coverage of those gaps | The existing Functions-emulator and Rules-emulator tests are RETAINED as the evidence; no production run covers them |
| L4 Acceptance Sandbox (`3OyBieoY4QHAfQsxBH8T`) | **RETAINED in production**; it contributes to the company Portfolio totals. Do not delete or modify it without a separate authorisation |

**Remaining acceptance — 25 November 2026 (§71; tracker B7).** Run in the isolated test company on a new retained fixture (`gdaYQYRD7cc0yUTkK0cD`, GBP), not in the Apex sandbox, which was not touched. **T9 PASS** — a held request made stale by a second user's BOQ edit was refused by the server (`boq-transfer-stale-review`), the dialog showed the stale message and nothing was written. **T16 Quant step PASS** — a measured 96.006 m² was applied to a BOQ item and flowed through the transfer to an approved version 1 of 12,565.34, equal to independent `Decimal` expectations. **T14 PASS as `subcontractor`** — no BOQ tab or button, *The BOQ is restricted* by URL, Rules denials and the callable's `boq-transfer-forbidden`; **`client` not re-run** (earlier production evidence: §68 X1–X3, §63 P20). A real disconnection (T15) is still not tested.

**Manual acceptance (after all three release steps; a TEST project, not customer data).**

- [ ] T1 — As `qs`, on a project with no budget lines, add BOQ items on three cost codes: two fully priced (one with a rate of 0 on one item), one with an unpriced item. Open *Transfer to budget*: two codes *Create*, one *Blocked* naming the unpriced item; totals match the BOQ page.
- [ ] T2 — *Apply transfer* is disabled until the review box is ticked. Tick and apply: *Transfer applied*, with the counts and the before → after amounts.
- [ ] T3 — Budget tab: two lines marked *From BOQ*, each equal to its BOQ total; the summary says *Working budget (not approved)*. BOQ tab comparison: variance 0 on both.
- [ ] T4 — Open the dialog again: both codes *Unchanged*; *Apply transfer* stays disabled.
- [ ] T5 — Price the unpriced item; reopen: that code is now *Create*. Apply. Three lines.
- [ ] T6 — Add a manual budget line on a fourth cost code, then a priced BOQ item on that code: the dialog shows *Blocked — a manually entered budget line already holds this cost code*; nothing is added for it.
- [ ] T7 — Change a BOQ rate. Reopen: that code is *Refresh* with the old and new amounts. Apply; the Budget line updates and still shows *From BOQ* with the new last-transferred amount.
- [ ] T8 — Edit a BOQ-sourced line's amount on the Budget tab: it shows *changed by hand since the BOQ transfer*. The dialog offers *Refresh* with the hand-change note.
- [ ] T9 — Stale review: open the dialog; in a second tab change a BOQ quantity; in the first tab the list updates. (To force the server refusal, apply within the moment before the first tab updates, or block the listener in DevTools.) A stale request shows *changed since you reviewed … Nothing was written*.
- [ ] T10 — Void every BOQ item on one transferred code: the dialog shows *BOQ items void* with *Set this line to zero* UNTICKED and the line unchanged after an apply of other codes. Tick it and apply: the line is 0.
- [ ] T11 — As `project_manager`, prepare and approve the budget (version 1). Forecast, Commercial Report and Portfolio show the approved total.
- [ ] T12 — Change a BOQ rate and transfer again: the dialog states the Approved Budget does not change; after applying, the Budget tab shows the pending difference and every report still shows version 1's total.
- [ ] T13 — Approve version 2: reports now show the new total; version 1 is unchanged in the history.
- [ ] T14 — As `subcontractor` and as `client`: no *Transfer to budget* button; the BOQ tab is restricted as before.
- [ ] T15 — DevTools → Network → Offline, then apply: an amber uncertain message, the button locked; go online, acknowledge, *Send the same transfer again*: *Transfer applied* or *Already applied*, and exactly one line per cost code.
- [ ] T16 — Double-click *Apply transfer*: one transfer. Existing flows unchanged: add and edit a manual budget line; add, edit and void a BOQ item; apply a Quant quantity.

**Release order and rollback.** DEPLOYMENT.md → *L4*: merge, Azure `main` green, Rules, ONLY the new callable, verify, Hosting, then T1–T16. Emergency rollback restores the previous Hosting release and disables the callable by its flag; the L4 Rules and every working budget line are retained.

---

## 68. M2-A2 Stage A — External Project Isolation (ADR-83, 23 November 2026) — STAGE A LIVE — CLOSED and production-accepted 23 November 2026; paired create / edit and directory PASSED in production; external-role checks X1–X7 PASSED in production 23–24 November 2026 (Stage B run, §69); internal regression: **M3, M4, M8 PASSED in production on 25 November 2026 (§71)**, M5 and M7 in part, M1, M2 and the stale-bundle part of M7 SUPERSEDED (never verified; not reproducible) — **regression CLOSED within its applicable scope (Lead Architect, 25 November 2026 — REPORTED)**; automated tests PASS (emulators)

*Heading as written before the 25 November 2026 run:* … internal regression M1, M2, M4, M5, M7, M8 NOT RECORDED; automated tests PASS (emulators)

**Scope.** Rules, Storage Rules, the projects provider, the directory hook,
the role-filtered navigation and the backfill script (ADR-83). §63 P19–P20
remain pending. *As written before deployment:* Deferred Control 20 is open
in production.

**Production acceptance record — 23 November 2026 (Company Admin session,
Apex Builders `2Vf3CVuYE8wWzg8hLjR5`; server state read through the
Firestore and Rules REST APIs, read-only).**

| Check | Result |
|---|---|
| Pre-flight: FINAL Firestore ruleset and Hosting bundle identical to `main` `22cf7db`; 9 projects, 9 matching entries | PASS |
| Create *M2-A2 Security Acceptance — TEST* through the application | PASS — project `Iusni6U8enVn47fKBGDB`; project and entry created at `2026-11-23T02:52:52.060012Z`, the same instant |
| Entry holds exactly `name`, `status`, `location`, `startDate`, `progress`, equal to the project; no budget, currency or other key | PASS |
| Rename to *… — VERIFIED* and set progress 25 through the application | PASS — both documents updated at `2026-11-23T02:53:27.658907Z`; all five fields equal |
| 10 projects, 10 matching entries, no orphan; backfill dry run `in sync 10 · missing 0 · invalid 0 · mismatch 0 · orphan 0 · failed 0` | PASS |
| The nine existing projects (update time and fields) | Unchanged |
| No financial record on the test project (ten subcollections read) | PASS |
| Browser: write requests 200; no permission error. Console capture began after the create click | PASS |
| Storage ruleset: `2f3a4788…`, 10,323 bytes, identical to `main`; both `get` rules use `projectReader`; no membership-only read | PASS — on the second pass; the first found the pre-M2-A2 ruleset still live (DEPLOYMENT.md → *M2-A2 Stage A → Release record*) |

**What that record does and does not show.** It shows the paired writes are
accepted by the deployed FINAL Rules — including the access-call budget, for
one pair — and that the deployed Rules are the emulator-tested source. **It
does not show an external role being denied in production:** no external
account exists and none was created. Against the checklist below: M3 was run
as a Company Admin for both the create and the edit (the Project Manager
edit was not); M6 PASSED; M1, M2, M4, M5, M7 and M8 are not recorded; X1–X6
were NOT RUN. The test project stays in production — do not delete or
modify it.

**Automated (local emulators, 23 November 2026 — not production-verified).**

| Suite | Result |
|---|---|
| Unit | **101 files / 5,244 tests** PASS (100 / 5,198 before) |
| Firestore + Storage Rules emulator | **39 files / 2,492 tests** PASS (36 / 2,336 before) |
| Functions pure | **6 files / 136** PASS (5 / 130 before) |
| Functions emulator | **10 files / 310** PASS (303 before) |
| `npm run lint` (frontend), Functions lint | 0 errors / 0 warnings |
| `npm run build` | clean (the existing chunk-size notice only) |
| `rules:transitional:check` (both derived rulesets), `functions:calc:check`, `functions:transfer-calc:check` | up to date |
| `git diff --check` | clean |

| Suite | Coverage |
|---|---|
| `tests/rules/externalIsolation.rules.test.js` (76) | Assigned project allowed (records and files, `get` and `list`); unassigned project denied; another company denied, including the SAME project id in two companies; the project document denied to every external role, by `get`, list, id-filtered and collection-group query; the headline budget absent from the directory entry; directory listing denied to external roles; ten malformed assignments (missing, null, empty, string, map, list of objects, number, boolean, `*`, prefix); `super_admin`, an unknown role, a role-less and a wrong-case role denied with an assignment present; a deactivated profile with a stale assignment; internal roles unchanged; internal / superseded / withdrawn documents and the upload window still denied; no client can write `users/{uid}`; server-side assignment change takes effect at the next read |
| `tests/rules/projectDirectory.rules.test.js` | Paired create and edit accepted; a project created or display-edited WITHOUT its entry rejected; an entry without a project, for another project id, or changed alone rejected; ten injected keys (budget, currency, `projectIds`, role and others); each of the five fields wrong, missing or wrongly typed; delete denied; writers limited to `company_admin` / `project_manager`; a project that pre-dates the directory; currency pin, currency lock and the QS ratchet unaffected, with and without an entry |
| `tests/rules/projectDirectoryTransitional.rules.test.js` | Stage-1 ruleset: the pre-M2-A2 create and edit still accepted; the directory already strict; the read boundary already final |
| `tests/rules/` — `drawings`, `externalRoles`, `projects`, `projectDocuments`, `storage` | 55 cases that asserted the company-wide read now assert the boundary — among them drawings test 85, which had pinned DC20 as a limitation |
| `tests/unit/externalProjectIsolation.test.js` (46) | Role sets; `assignedProjectIds`; the directory fold (never half-loaded; a refused entry is absent, any other failure makes the list unavailable); tabs and navigation; the provider's read selection and paired writes; every other project writer touches no display field; the Stage-1 ruleset is derived and differs in two lines; the access-call budget |
| `functions/test/projectDirectory.test.js`, `tests/functions/scripts.test.js` | Backfill: dry-run by default and non-mutating; `--apply` creates five-field entries, touches no project, is idempotent; mismatch, wrong type and orphan refused with exit 1; `--company-id` |

**Access-call limits.** Firestore allows 10 document-access calls per
operation and 20 per commit. Counting every call: project half 8, directory
half 9, one pair 17. The app commits one pair. **The emulator does not prove
this** — it counts distinct documents per operation and does not enforce the
per-commit limit (measured 23 November 2026). The first production project
create and edit after the Hosting step are the real check (M3 below).

**Manual acceptance — internal regression (after DEPLOYMENT.md → *M2-A2
Stage A* steps 1–4; a TEST project, not customer data). RUN on 25 November
2026 with the TEST Company Admin, Project Manager and QS — results in §71
(tracker B7): M3 PASS (Project Manager edit included), M4 PASS (the lock
engaged by a BOQ item, not a budget line), M5 page load PASS / pin not run,
M6 PASS again (17 in sync), M7 repeat PASS / stale-bundle part superseded,
M8 PASS; M1 and M2 superseded — the Stage-1 ruleset and the old bundle no
longer exist. The boxes below are left as written.** *As written before:* NOT RUN.

- [ ] M1 — After step 1 (Stage-1 Rules, old bundle): as each internal role, Dashboard, Projects, a project Overview, a drawing and a document open as before.
- [ ] M2 — After step 1: create and edit a project with the OLD bundle — both succeed.
- [ ] M3 — After step 2 (Hosting): as `company_admin`, create a project; as `project_manager`, edit its name, status, location, start date and progress. Both succeed (this is the production check of the access-call budget). The Firestore console shows `projectDirectory/{id}` with exactly five fields equal to the project.
- [ ] M4 — As `qs`: Projects lists every project; no project can be created or edited (unchanged). Record a budget line on an unlocked project — the currency lock engages as before.
- [ ] M5 — Company Settings: change nothing, confirm the page loads; on a test company, the currency pin still succeeds.
- [ ] M6 — After step 3: the dry run reports every project `in sync`.
- [ ] M7 — After step 4 (FINAL Rules): repeat M3. A tab left open on the old bundle fails to edit a project until reloaded (expected).
- [ ] M8 — Portfolio, Commercial Report, Final Account and GANTT open for the internal roles as before.

**Manual acceptance — external roles. PASSED in production, 23–24 November
2026** (Stage B run in the isolated test company `constrap-acceptance-test`,
§69 → *Production acceptance record*; full matrices in
[SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → B2a, B2b,
B2c). Evidence kinds: **Rules probes** — requests from the member's own
signed-in browser session (Firestore REST and Storage downloads with that
session's ID token, against the deployed Rules; no Admin SDK); **browser** —
what the application showed; **operator** — read-only server reads.
*As written before:* BLOCKED: needs Stage B (ADR-84 — IMPLEMENTED, NOT
DEPLOYED; §69) deployed, and an isolated test company with two
Product-Owner-controlled emails. NOT RUN.

- [x] X1 — A `subcontractor` assigned to project A only: Projects lists A alone, with no Headline Budget column and no *Add New Project*; the sidebar offers Dashboard and Projects. **PASS** — browser, subcontractor on `[A]` (P6, 23 Nov) and client on `[A, B]` (P7, 24 Nov).
- [x] X2 — Project A shows the Overview (no budget card) and Documents tabs only; drawings and active project documents open and download. **PASS** — browser (tabs, registers; the internal document not listed) and Rules probes (files downloaded 200 through the Storage Rules; not opened in the application's viewer).
- [x] X3 — Entering project B's URL directly: *Project not found*. A direct SDK read of `projects/A`, `projects/B`, `projectDirectory/B`, a drawing of B and a Storage object of B is `permission-denied`. **PASS** — browser and Rules probes (403), for the subcontractor (B unassigned) and the client (C unassigned).
- [x] X4 — A `client` with no assignment: *No projects have been assigned to you yet*; every direct read is denied. **PASS** (24 Nov) — `set-member-projects.mjs --clear`; same session, no sign-out; own profile and company document 200, 42 other probes 403.
- [x] X5 — Remove the assignment (operator): project A disappears at the next read. **PASS** (24 Nov, run on project B) — denied about 20 s after the removal in the same session; the open page dropped the project without a reload.
- [x] X6 — §63 P19–P20. **PASS** for both external roles, with the network limitation recorded in §63.
- [x] X7 (added 24 November 2026) — Reassign a cleared client to project C only: C opens; nothing previously assigned returns. **PASS** — `--add C`; one audit event, no revocation request; C directory and lists 200, C project record and financial collections 403, every A and B resource and file 403.

**Not covered by any test.** The production access-call limit; a production
project whose stored field types differ from what the app writes (the
backfill dry run reports these). *As written before Stage B:* A real browser
session of an external role — now covered (X1–X7 above).

## 69. M2-A2 Stage B — External member assignments and provisioning (ADR-84, 23 November 2026) — STAGE B LIVE since 23 November 2026 — CLOSED and production-accepted 24 November 2026 (S1–S3, R1–R3, P1–P14 PASS); automated tests PASS (emulators); real customer external onboarding still BLOCKED pending a readiness decision

**Scope.** `acceptInvitation`, `deactivateMember`, the operator library
(`functions/src/lib/memberProjects.js`), the two operator scripts and the
reconcile checks (ADR-84). No Rules, Storage Rules or Hosting change.

**Automated — all PASS, 23 November 2026 (local emulators; not production).**
Unit 101 files / 5,244 · Rules emulator 39 files / 2,492 (unchanged — no Rule changed) ·
Functions pure 7 files / 155 · Functions emulator 11 files / 354. ESLint (application
and Functions) 0 errors, 0 warnings; production build clean, bundle
`index-BOg2hoYg.js` (unchanged); transitional-rules and both generated-bundle
checks up to date; `git diff --check` clean.

| Requirement | Where it is tested |
|---|---|
| Valid client and subcontractor provisioning | `team.externalProvisioning.test.js` → *provisionExternalMember*; `scripts.test.js` → *provision-external-member.mjs* |
| Assignment to permitted projects — through the real Rules | *the Rules open exactly the assigned projects…* (client SDK reads of the directory entry and a drawing) |
| Cross-company and unassigned denial | same test; provisioning and assignment refusals for another company's project id |
| Removed-project denial | *removing a project closes it at once…* |
| Re-invitation and stale assignments | *an assignment ends with the membership and never comes back* (four tests) |
| Deactivated membership | *deactivation removes projectIds in the same commit…*; assignment of a deactivated member refused |
| Unknown and internal roles | provisioning, library, acceptance (tampered stored role) and assignment refusals |
| Invalid invitation assignments | creation refusals (missing, empty, 31, duplicate, malformed, nonexistent, cross-company); acceptance re-validation (project removed since; tampered list) |
| Client-supplied assignment ignored | *a browser cannot create or shape an external membership* (schema refusals; Rules refuse the member writing their own `users/{uid}`) |
| Atomic with activation | the profile and the consumed invitation carry the same commit time |
| Concurrent assignment changes | four concurrent changes all land, audit events chain; a change racing a deactivation |
| Audit correctness | `member.projects_changed`, `invite.created`, `invite.accepted`, `member.deactivated` before / after |
| Revocation request creation | removal → request, queue marker, member sequence, Team-page status *pending*; addition → none |
| Repeated requests | no second write, event or request |
| Operator scripts, dry run and apply | argument refusals, dry run writes nothing, `--no-link`, `--link-file` (mode 0600, link absent from output), refusals leave no file |
| Reconcile | R7, R8, R9 reported; `--fix` removes R7 / R8 only, audited |
| Existing Team Management regressions | every pre-existing Functions suite unchanged and passing; internal invitation, acceptance and deactivation shapes pinned unchanged |
| Structure | `functions/test/memberProjects.test.js`: still eight callables; the operator library is imported by the two scripts only; which files write `projectIds` |

**Regression after the Functions deploy — PASSED 23 November 2026** (isolated
test company; *Production acceptance record* below). *As written before:* NOT RUN.

- [x] R1 — Settings → Team loads for a Company Admin; members and pending invitations list as before. **PASS** (browser + operator).
- [x] R2 — Invite an internal member (Product-Owner-controlled email), accept, sign in: full access as before. `users/{uid}` carries no `projectIds` (read-only check). **PASS** — QS invited and accepted; own-company reads 200, Apex reads 403 (Rules probes from the QS session); no `projectIds`.
- [x] R3 — Deactivate that member: signed out, Auth disabled, *Old file links: revocation pending* then *revoked*. **PASS** — the open QS tab was signed out; urgent sweep seq 2 completed.

**Production acceptance — PASSED, 23–24 November 2026** (Lead Architect:
Stage B CLOSED, 24 November 2026). *As written before:* NOT RUN. Needs: the
three callables deployed; an isolated test company (not Apex Builders) with
at least three projects created through the application, a drawing and an
active project-visibility document in two of them; two
Product-Owner-controlled mailboxes with no existing account; operator
credentials; an authorisation for each `--apply`.

- [x] P1 — Dry run of `provision-external-member.mjs` for a `subcontractor` on project A: plan printed, nothing written (no invitation, no audit event).
- [x] P2 — Dry runs that must be refused: a project id of another company; a nonexistent id; a duplicated id; role `qs`. (Also refused: 31 ids, a mixed list, a trailing comma, a path-like id, `*`.)
- [x] P3 — `--apply --no-link`: one pending invitation, delivery *Operator link*, in the Team page. The terminal shows no link.
- [x] P4 — A Company Admin presses *Resend*: the email arrives at the invited address and names *Subcontractor*. (Receipt REPORTED by the Product Owner; send VERIFIED: provider message id, no error.)
- [x] P5 — The invitee registers and accepts. `users/{uid}`: `role` `subcontractor`, `projectIds` exactly `[A]`, written in the same commit as the membership (read-only check).
- [x] P6 — TESTING.md §68 X1–X3 as that subcontractor (project A only; project B's URL and direct reads denied; no budget anywhere).
- [x] P7 — Provision a `client` on projects A and B the same way; §68 X-checks for a client. §63 P19–P20.
- [x] P8 — `set-member-projects.mjs --remove B` (dry run, then `--apply`): project B disappears for the client at the next read; one `member.projects_changed` event with both lists; a revocation request; the Team page shows *revocation pending*, later *revoked*. (§68 X5)
- [x] P9 — Before P8, copy a document download URL of project B if one can be obtained; record whether it still opens after P8 and when it stops. (No fixture carried a token; the positive control was minted by one architect-approved `getDownloadURL`-equivalent request from the client's own session. 200 before the removal, 200 after it until the sweep, 403 after the urgent sweep.)
- [x] P10 — Repeat the P8 command: *No change*.
- [x] P11 — `set-member-projects.mjs` against a Company Admin, Project Manager or QS: refused. (Run against the Company Admin and the deactivated QS; no Project Manager exists in the test company. The apply path re-runs the same check inside its transaction — code inspection.)
- [x] P12 — A Company Admin deactivates the subcontractor: signed out; `projectIds` absent from `users/{uid}`; the audit event records what it was. (Auth disabled and refresh tokens revoked — VERIFIED. **No subcontractor browser session was open during P12**, so the sign-out was not observed there; it was observed for the final deactivation of the same account, below.)
- [x] P13 — Re-provision the same email as a `client` on project C only and accept: `projectIds` is exactly `[C]`; project A is denied. (Same Auth identity re-enabled; no duplicate account; `[A]` not restored.)
- [x] P14 — `reconcile-membership.mjs` (report only): no R7, R8 or R9. (0 findings for the test company and the whole project; still 0 after the final deactivations.)

**Production acceptance record (23–24 November 2026; project
`constrapp-69b5d`; company `constrap-acceptance-test`, bootstrapped for this
test; Apex Builders not touched).** Server state was read through the
Firestore, Identity Toolkit, Cloud Storage and Cloud Logging APIs,
read-only; access was tested from each member's own browser session. Every
`--apply` and Team-page mutation ran once, on Product Owner authorisation.
Per-step evidence, audit-event ids and timings:
[SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md) → B2, B2a,
B2b, B2c.

| Area | Result | Evidence kind |
|---|---|---|
| S1–S3: test company bootstrapped; TEST Company Admin accepted; projects A (headline budget 123,456), B, C and five synthetic PDF fixtures created through the application | PASS | operator reads, browser |
| Subcontractor on `[A]` (P6): 10 reads allowed, 58 denied | PASS | Rules probes, browser |
| Client on `[A, B]` (P7): 18 allowed, 80 denied — incl. 22 financial collections + baseline + approved budget on **each** assigned project | PASS | Rules probes, browser |
| Removal of B (P8 / X5): denied in the same session ~20 s later; UI updated without a reload | PASS | Rules probes, browser |
| Copied download URL (P9): anonymous 200 → 403 after the urgent sweep (seq 4, 57 s after the removal, removed 1) | PASS | anonymous HTTP, operator reads |
| Clear (X4), reassign (X7), internal-role refusal (P11) | PASS | Rules probes, browser, operator |
| Deactivation (P12) and re-invitation of the same identity as a client (P13) | PASS | operator reads, Rules probes, browser |
| Reconcile (P14) | PASS — 0 findings | operator |
| Final state | Both external test accounts and the QS deactivated (Auth disabled, no `projectIds`); TEST admin active; projects and fixtures kept, no token; directory 13 / 13; Apex unchanged | operator reads |

**Observed revocation timings are evidence, not guarantees.** Urgent sweeps
completed 11–57 s after their request (the worker runs every minute); the
periodic 2-hour reconciliation played no part. A copied link lives until a
sweep removes its token; completion depends on scheduling, worker health and
backlog (ADR-75).

**Not covered by any test.** Production IAM for the operator identity; the
Firestore lock behaviour of a refused script run on production (emulator
only); a Project Manager target for P11; the decoded payload of the
Portfolio page's Firestore requests (§63 P19 note). *As written before:* A
real browser session of an external role; real email delivery of an external
invitation; a download URL copied before a removal (P9) — all three now
covered.

## 70. Operator tooling safety — D3 #1–#3 and #16 (24 November 2026) — INTEGRATED (merged as `bc64487`, merge `62e824a`; Azure `main` green — REPORTED by the Lead Architect); automated tests PASS (emulators and pure); `npm run test:team` end-to-end PASS; scripts only, no deployment; NOT exercised against production

*Integration note (24 November 2026):* merged with the architect corrections
(D3 #16, #18 and explicit cleanup-failure reporting). Counts at merge: unit
101 files / 5,244; Functions pure 8 / 179; Functions emulator 11 / 367;
four fresh `npm run test:team` runs PASS. D3 #17 remains open. The text below
was written before integration.

Branch `feature/operator-tooling-safety` (uncommitted). Procedure, migration
and recovery: [DEPLOYMENT.md](DEPLOYMENT.md) → *Operator tooling safety*.
Summary index: [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md)
→ D1 R-6, D3 #1–#3.

### Automated — `frontend/functions/test/operatorTooling.test.js` (pure, no emulator; 24 tests)

| Area | Checks |
|---|---|
| Link-file destination | new file in a private folder accepted; repository refused directly and through a folder symbolic link into it; existing file, symbolic link to a file and dangling symbolic link refused (targets untouched); missing folder, a file as folder, group- or world-writable folder refused; sticky world-writable folder accepted; folder of another uid refused |
| Reservation and delivery | empty regular file, mode 0600, one link, operator-owned; a second reservation of the path refused; **eight concurrent processes → exactly one creates it**; a failed (partial) write removes the file and returns no link; discard never removes a file that replaced the reserved one; a reservation through a link into the repository leaves nothing there; credential redaction |
| `runOperatorScript` (real child processes) | returned code kept (0 / 1 / 3); error → 1, `UsageError` → 2 with usage; shutdown steps run after `main` settles, also after an error; **a failing step is an explicit `✖ Cleanup FAILED … INCOMPLETE` (codes 0 / 1 / 3 kept), never a clean-shutdown message**; a shutdown that never finishes → `✖ Cleanup did NOT complete within 1 s — the process is being terminated`, forced exit, no hang, code kept (0 / 1); **the timeout starts only after `main` settled** (a 1.5 s operation with a 0.5 s timeout completes normally); a clean shutdown prints nothing; `main` runs exactly once, also when it throws |
| Source pins (also `memberProjects.test.js` for provisioning) | provisioning uses `_linkFile.mjs` (`checkLinkFileDestination`, `reserveLinkFile` before `dryRun: false`, `deliverToLinkFile`), no `openSync` / `writeSync` / `REPO_ROOT` of its own, exit 3 on a post-commit delivery failure, no rotation path; the four older scripts: no `process.exit(`, `runOperatorScript(main, …)`, `releaseOnExit(() => db.terminate())`; the runner's only `process.exit` is the timeout fallback, after `process.exitCode`; bootstrap: plan → dry-run return → reservation → first write, plan function read-only; the link reaches only `deliverToLinkFile`; no console printing; rotation re-checked under the lock; deployed entry points import no script |

### Automated — `frontend/tests/functions/scripts.test.js` (emulators; bootstrap 11 tests, provisioning +2, lifecycle 3 tests)

| ID | Check | Result |
|---|---|---|
| OT1 | Twelve bad command lines (no project, bad id, unknown flag, `--apply` alone, `--apply --dry-run`, both / no delivery option, delivery without `--apply`, `--app-url` with `--no-link`, a non-origin URL) → exit 2; a key file → exit 1; **nothing written** (companies, invitations, audit, lock, users, Auth) | PASS |
| OT2 | Default, `--dry-run`, the old write command (`--app-url` only) and `--rotate` dry runs → read only; a dry run against an existing pending invitation → read only | PASS |
| OT3 | `--apply --link-file`: company, operator invitation, `company.bootstrapped` + `invite.created`; link only in the 0600 file, never on stdout / stderr; the link accepts and makes the first admin (not email-verified); re-run → nothing to do, no file; rename → refused, no write | PASS |
| OT4 | `--apply --no-link`: no link anywhere; later `--rotate --link-file` delivers the same invitation with a new token (`invite.resent`) | PASS |
| OT5 | A pending invitation: plain re-run refused (no file, no write); `--rotate` keeps one invitation, kills the old link, the new one works | PASS |
| OT6 | `--rotate` refuses a pending `project_manager` invitation and an email with nothing pending; no write | PASS |
| OT7 | Unsafe destinations (repository, folder link into it, existing file, links, missing / shared folder, no origin) → exit 2 before any write; targets untouched | PASS |
| OT8 | Two runs racing for one link file → exactly one exit 0; the other exit 1 / 2 and **no document of its company** | PASS |
| OT9 | Link write fails after the commit (ENOSPC fixture, partial write) → exit 3, invitation named and pending, partial file removed, no credential in output; plain re-run refused; `--rotate --link-file` recovers the same invitation | PASS |
| OT10 | Refusal inside the invitation transaction and inside a rotation (fixture) → exit 1, one attempt only, no invitation / audit / lock write, no link file, **membership lock writable at once** | PASS |
| OT11 | Refusal inside the company transaction → no company, no audit, document writable at once | PASS |
| OT12 | `backfill-project-directory.mjs --apply`, refused transaction → `FAILED` once, exit 1, no entry, project and entry writable at once | PASS |
| OT13 | `reconcile-membership.mjs --fix`, refused F2 → exit 1, field kept, no audit, profile writable at once | PASS |
| OT14 | Exit codes and prompt exit (< 15 s, no shutdown warning) for the four scripts on success, refusal and usage error; reconcile JSON mode still one stdout line | PASS |
| OT15 | **D3 #16 regression** — `provision-external-member.mjs --apply --link-file` through a folder symbolic link into `frontend/functions` and into the repository root, a link to a file, a dangling link, a world-writable folder → exit 2, nothing in the repository, targets untouched, no invitation or audit | PASS |
| OT16 | Provisioning: link write fails after the commit (ENOSPC fixture) → exit 3, invitation named and pending (role, projects kept), partial file removed, no credential in output; a plain re-run refused `invite-pending` (no duplicate, no rotation); a Company Admin's Resend delivers a fresh link for the same invitation | PASS |

**Sensitivity check (not committed):** with the runner temporarily changed back
to an immediate `process.exit(code)`, OT10–OT13's lock assertions failed
(`expected false to be true`), as did OT14; restored byte-identical
afterwards. **Hazard measurement (scratch, not committed):** on a fresh
emulator, a transaction that read `companies/x/system/membership` and was
refused: `process.exit(1)` → a one-attempt write of that document failed with
`ABORTED: Transaction lock timeout` for about 45–60 s; `process.exitCode` and
`Firestore.terminate()` → written in ~90 ms.

**D3 #16 demonstration (emulator, not committed):** `main`'s
`provision-external-member.mjs` with `--link-file <tmp>/repo-alias/zz-leak.txt`
(`repo-alias` → `frontend/functions`) exited 0 and created
`frontend/functions/zz-leak.txt` (`git status`: untracked) — the link inside the
working tree. This branch: exit 2, *must be OUTSIDE this repository*, no file,
0 invitations. The file and the temporary copy were removed.

### `npm run test:team` end-to-end (local emulators, 24 November 2026) — PASS

Four consecutive fresh runs, driven from a scratch script that never printed
the link:

| Check | Result (runs 1–4) |
|---|---|
| Emulators ready (Auth config endpoint, Firestore *Ok*, Functions, *All emulators ready*) | ready in 17–22 s each run |
| Bootstrap on the **first** attempt (`--apply --link-file`, private temp folder) | `done` every run (before the fix, the first run failed `ECONNREFUSED 127.0.0.1:9099`) |
| Emulator link shown by the launcher; temp link folder removed | yes; 0 folders left |
| Link origin | `http://127.0.0.1:5173` |
| The link is a working invitation (`previewInvitation` through the Functions emulator, unsigned emulator App Check token) | HTTP 200, role `company_admin`, account `new` (run 4; runs 1–3 sent no App Check header → 401, a probe error) |
| Vite reachable; bind address | `http://127.0.0.1:5173/` → 200; listening on `127.0.0.1:5173` only (no `::1`, no wildcard) |
| Ctrl+C shutdown | *Stopped*; 0 processes and 0 emulator / Vite ports left |
| Production connection | **None to the production project or its data.** Non-loopback traffic seen only from the Firebase CLI process: one metadata request for `constrapp-rules-test` → 403 (`--debug`). firebase-tools hands the CLI login to the Functions emulator as credentials (DEPLOYMENT.md → *Local emulators and credentials*) |

### Manual — not required for integration

- [ ] A production dry run — **not needed for this review** (architect, 24
  November 2026).
- [ ] A browser session against `npm run test:team` (accept the link, open the
  Team page) — not run; the HTTP checks above stand in for it.

**Not covered.** The lock behaviour on production Firestore (emulator only;
production expiry may differ); a real full disk; another OS user racing for the
link folder.

---

## 71. L4 remaining acceptance, M2-A2 Stage A internal regression, §61 W2–W4 and the F16 notice — consolidated production run (25 November 2026 NZDT; 24 November 2026 19:00–19:42 UTC) — **CLOSED** (Lead Architect, 25 November 2026 — REPORTED): T9, the Quant step of T16, T14 (subcontractor), M3, M4, M8, W2–W4 and the F16 notice PASSED in production; M5 and M7 in part; M1, M2 SUPERSEDED; recorded evidence limitations stand

**Architect decision (25 November 2026 — REPORTED).** GO — **the L4 acceptance is CLOSED with the evidence limitations recorded here, and the Stage A regression is CLOSED within its applicable scope.** T14 as `client` is accepted on the existing production and emulator evidence (§68 X1–X3, §63 P20, the Functions emulator) — it was not run in a live session. M1, M2 and the stale-bundle part of M7 are classified **superseded**. The M4 currency-lock check is accepted in its BOQ-item form; the literal budget-line variant was **not run**. The M5 currency pin remains **emulator-only**. T15, a real disconnection, was **not executed**. The F16 notice is recorded as **observed in production**. W2–W4 are accepted with the display findings. D3 #27–#29 go to a **P2 external-role UI correction bundle**. The GBP fixture and every earlier regression fixture are retained; the Project Manager, QS and external test accounts stay deactivated; the TEST Company Admin is retained. Limitations that stand: token replay after deactivation not tested; Apex Storage objects not compared; the Apex comparison is by document path and update time, not content; the Hosting bundle not re-compared with a build. Next milestone: **C1-C GANTT production acceptance.**

*Heading as written before the decision:* … RUN: T9, the Quant step of T16, T14 (subcontractor), M3, M4, M8, W2–W4 and the F16 notice PASSED in production; M5 and M7 in part; M1, M2 SUPERSEDED; awaiting architect review

**Scope.** The items carried forward by §61 (W2–W4), §62c (the F16 notice),
§67 (T9, T14, the Quant step of T16) and §68 (M1–M8). Run by the engineer in
the isolated company `constrap-acceptance-test`; nothing was done in Apex
Builders. Documentation only on `docs/l4-stage-a-acceptance` (uncommitted); no
application code, Rules, Functions or deployment changed. Evidence classes as
in [SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md); the full
record is tracker **B7**.

**Pre-flight (read-only, 19:00–19:03 UTC).** `main` `0cf17e6` clean and equal
to `origin/main` (VERIFIED in Git; Azure `main` green and the C1-A integration
are REPORTED by the Product Owner). Deployed Firestore ruleset `67b6425a…`
236,737 bytes and Storage ruleset `2f3a4788…` 10,323 bytes, each byte-identical
to `main`; `transferboqtobudget-00001-zol` with `BOQ_BUDGET_TRANSFER_ENABLED=true`.
The Hosting bundle was **not** re-compared with a build of `main` in this run.
Since the C1-A run, production differed only by the revocation worker's marker
in each company.

**What each carried-forward item is, and how it was classified.**

| Item | Classification before the run | Result |
|---|---|---|
| §67 T9 — server stale-review refusal | Outstanding production acceptance; needs a production mutation | **PASS** |
| §67 T14 — `subcontractor` and `client`: no *Transfer to budget*, BOQ restricted | Outstanding for a live external session; the `client` half previously evidenced at Rules and tab level (§68 X1–X3, §63 P20 — tracker B2b) and by the Functions emulator | **PASS as `subcontractor`**; `client` **not re-run** (Product Owner decision, one reactivation) |
| §67 T16 — *apply a Quant quantity* | Outstanding production acceptance; needs a drawing and a takeoff | **PASS** |
| §67 T15 — a real network disconnection | Requires tooling the session does not have (no DevTools offline) | **NOT RUN** — unchanged |
| §68 M1, M2 — Stage-1 Rules with the old bundle | Obsolete release-stage requirement: that deployment state ended on 23 November and is not recreated | **SUPERSEDED — never verified, not reproducible** |
| §68 M3 — admin creates, Project Manager edits five fields | Outstanding (the Project Manager half) | **PASS** |
| §68 M4 — QS lists, cannot create or edit; currency lock | Outstanding | **PASS**; the lock was engaged by a priced BOQ item, not a budget line (below) |
| §68 M5 — Company Settings loads; currency pin | Outstanding; pin step emulator-only | **Loads: PASS. Pin: NOT RUN** — nothing to pin in the test company |
| §68 M6 — directory dry run | Previously accepted (23 November) | Re-run: 17 projects, 17 in sync |
| §68 M7 — repeat M3 on FINAL Rules; stale tab fails until reloaded | The repeat is M3 (FINAL is the only live ruleset); the stale-bundle part is an obsolete release-stage requirement | **Repeat: PASS. Stale-bundle part: SUPERSEDED — never verified** |
| §68 M8 — Portfolio, Commercial Report, Final Account, GANTT for internal roles | Outstanding (GANTT; Commercial Report as Project Manager and QS) | **PASS** for all three roles |
| §61 W2, W3 | Outstanding | **PASS** |
| §61 W4 | Outstanding; needs a live non-financial session | **PASS** (no figure reaches the account) with two display findings |
| §62 F16 — *Final Account is restricted* | Accepted on combined evidence; notice not observed | **Notice OBSERVED in production** |

**Fixture (new, RETAINED).** One additional synthetic project, authorised by
the Product Owner: **L4 `gdaYQYRD7cc0yUTkK0cD`** — *TEST GBP-1 — L4
BOQ-to-budget acceptance*, GBP, *In Progress*. GBP so that it forms its own
Portfolio currency group and changes no existing subtotal. Cost code CT-100
reused. Records, all created through the application:

| Record | Detail |
|---|---|
| Drawing | TL4-001 `7keEbCKSQZOopNBCRJjh`, revision A `XoSnxRQ7ubl4FcQ3wdYv` — a generated 881-byte one-page PDF (a 600 × 400 unit rectangle and a 500 unit scale bar); stored object md5 equals the local file; no download token after the sweep |
| Quant | Takeoff page `…_XoSnxRQ7ubl4FcQ3wdYv_1`, calibration 10,000 mm over 500 page units; area measurement `LgBMG4MJqiL42cJjEbvu` on CT-100, linked to item 1.1 |
| BOQ | Item 1.1 `er81HxyVHoCHp2gMisrE` — 96.006 m2 × 123.45 = 11,851.94; item 1.2 `vB8FVZJbdvzFLwcc3y7R` — 41 lm × 17.40 = 713.40 |
| Working budget | Line `boq-Ixk3c3hJ0zUnL3tKp68a` — 12,565.34, BOQ-sourced, `transferCount` 2 |
| Approved budget | Version 1 `OBAF1CduuHAff610rXd2` — 12,565.34; one-entry snapshot; pointer `approvedBudget/current` |
| Forecast | CT-100 uncommitted cost to complete 12,000.00 (with a note) |

**Independent expectations (exact `Decimal` arithmetic from the stored source
records, read through the Firestore REST API; half-up to the stated places).**

| Figure | Calculation | Expected | Stored / shown |
|---|---|---|---|
| Metres per page unit | 10 m ÷ 500.0000000000001 | 0.02 | 0.0200000 (dialog) |
| Measured area | shoelace of the four stored points × 0.02² | 96.006026459 → 96.006 m² | 96.006 (Quant, apply dialog, BOQ item, `quantApplied.quantity`) |
| Item 1.1 before the apply | 90 × 123.45 | 11,110.50 | 11,110.50 |
| Item 1.1 after the apply | 96.006 × 123.45 = 11,851.9407 | 11,851.94 | 11,851.94 |
| Item 1.2 (as created; after the rate edit; after the quantity edit) | 40 × 17.35; 40 × 17.40; 41 × 17.40 | 694.00; 696.00; 713.40 | 694.00; 696.00; 713.40 |
| First transfer (create) | 11,851.94 + 694.00 | 12,545.94 | line, dialog, audit event |
| Proposal reviewed and then refused as stale | 11,851.94 + 696.00 | 12,547.94 | dialog only — never written |
| Second transfer (refresh) | 11,851.94 + 713.40 | 12,565.34 | line, dialog, audit event |
| Approved budget version 1 | the one working line | 12,565.34 | header, snapshot, Budget, Forecast, Commercial Report, Portfolio |
| Forecast final cost; variance | 0 + 0 + 12,000.00; 12,565.34 − 12,000.00 | 12,000.00; 565.34 | Forecast, Commercial Report, Portfolio |

No amount was chosen on an exact half-cent boundary; a BOQ amount there follows
the IEEE product by design (`lib/boq.js` → `boqLineAmount`) and was not probed.

**Results — L4 (§67).**

| Check | Result | Evidence |
|---|---|---|
| Drawing → Quantity | **PASS** | Project Manager uploaded TL4-001 rev A, calibrated the page and saved the area measurement (19:07–19:08). The project stayed currency-unlocked — a measurement is not monetary |
| T16 — apply a Quant quantity | **PASS** | QS linked the measurement to item 1.1 (only the m2 item was offered; the lm item was not) and applied it on the BOQ tab after ticking the review box: 90 → 96.006 m2, 11,110.50 → 11,851.94 (19:21:12). Item 1.2 untouched |
| Transfer as QS (T1–T3 path, first time as a non-admin) | **PASS** | *Create* 0 → 12,545.94; *Apply* disabled until ticked; one line, the currency already locked, audit `PjdCFrfOUxGhCrFT4lAb` `boq_budget.transferred` in the same commit (19:21:57.735005Z); BOQ-vs-budget variance 0 |
| **T9 — stale review** | **PASS** | QS dialog open and ticked on a pending refresh (12,545.94 → 12,547.94). The `transferBoqToBudget` request was held in the page before sending (19:23:57.014); the Company Admin, in another session, saved item 1.2 quantity 40 → 41 (commit 19:24:04.986673Z); the request was released (19:24:07.579). **Server: HTTP 400 `FAILED_PRECONDITION`, `boq-transfer-stale-review`** (19:24:07.80). Dialog: *The BOQ or the working budget changed since you reviewed this transfer. Nothing was written…*, tick cleared, list at the current position (12,545.94 → 12,565.34). Server state: budget line update time unchanged (19:21:57), no audit event, audit count unchanged at 45 |
| Transfer after re-review | **PASS** | *Refresh* 12,545.94 → 12,565.34 (19:25:15.179408Z); `first` kept at 12,545.94, `latest` 12,565.34, `transferCount` 2; audit `MKAfTZs76mp1YtP7SXaZ` |
| Budget approval authority | **PASS** | QS captured the draft (19:25:46). QS review dialog: no *Approve*, *Approval is reserved for Company Admin and Project Manager roles*. **Rules:** the application's own approve transaction (header → `approved`, pointer created) sent from the QS session → `permission-denied`; draft unchanged. Company Admin approved it as version 1 (19:27:04.182849Z, header and pointer in one commit; `createdBy` QS, `approvedBy` admin; snapshot not rewritten) |
| Downstream reporting (T11) | **PASS** | Budget, Forecast, Commercial Report and Portfolio (GBP group) show *Approved version 1* 12,565.34; after the forecast save, FFC 12,000.00 and variance 565.34 on all three reports |
| **T14 — restricted role** (`subcontractor`, assigned to L4 and Z) | **PASS** | **UI:** tabs Overview and Documents only; `/boq` → *The BOQ is restricted*, no *Transfer to budget*, no figure. **Rules** (the member's own session, Web SDK): directory L4 and Z and the L4 drawing list allowed; 18 denials — L4 `boqItems`, `budgetLines`, `budgetApprovals`, `budgetApprovalSnapshots`, `forecastLines`, `takeoffMeasurements`, `takeoffPages`, `purchaseOrders`, `approvedBudget/current`, the project document; Z `finalAccounts`, `budgetLines`, `purchaseOrders`, `supplierInvoices`, `forecastLines`; unassigned project A's directory entry; `costCodes`; a BOQ item create. **Callable:** `transferBoqToBudget` called from that session with a real App Check token → HTTP 403, `permission-denied` / `boq-transfer-forbidden` (19:39:04) |

Callable log for the run: four `POST` requests — 200, 400, 200, 403; two audit
events. *Duplicate-operation protection* was not re-exercised (T4, T15 and the
T16 double-click stand from 22 November).

**Results — Stage A internal regression (§68).**

| Check | Result | Evidence |
|---|---|---|
| M3 / M7 repeat | **PASS** | Company Admin created L4: project and directory entry in one commit (19:04:27.399505Z), five equal fields. **Project Manager** changed name, status, location, start date and progress: both documents in one commit (19:05:41.228204Z), five equal fields, no other key |
| M4 | **PASS** | QS: Projects lists all 7; no *Edit*. *+ Add New Project* is shown (D3 #5) and a submit was refused: *Missing or insufficient permissions.* **Rules** (QS session): the paired create, the paired edit and a single-field edit → `permission-denied`; the read control succeeded. **Currency lock:** the QS's first priced BOQ item committed with `currencyLocked` false → true in the same commit (19:19:08.545102Z), the directory entry untouched. *As written the check names a budget line;* with one cost code in the test company a manual line would have blocked the transfer, so a BOQ item was used (Product Owner decision) — the same ratchet and the same QS-only Rules path; the budget-line variant was **not run** |
| M5 | **In part** | Company Settings loads for the Company Admin (country, base currency, 7 projects, each with its stored currency). The pin step was **not run**: every project already carries an explicit currency and nothing was saved. Emulator evidence only (`projectDirectory.rules.test.js`) |
| M6 | PASS (re-run) | Dry run 17 projects · in sync 17 · missing 0 · mismatch 0 · orphan 0 |
| M8 | **PASS** | Portfolio, Commercial Report, Final Account and GANTT opened with figures and no restricted or unavailable state for the Company Admin, the Project Manager (fixture Z) and the QS (L4 and Z). GANTT showed *+ Add activity* to the Project Manager and not to the QS |
| M1, M2, stale-bundle part of M7 | **SUPERSEDED** | The Stage-1 ruleset and the pre-M2-A2 bundle are no longer deployed. No record of these checks exists from the release; they are neither passed nor failed |

**Results — §61 and §62.**

| Check | Result | Evidence |
|---|---|---|
| W2 | **PASS** | Project Manager on Z and QS on L4: Budget, Purchase Orders and the Commercial Report load with figures; nothing reads *Unavailable* |
| W3 | **PASS** | QS saved a forecast line with a note on L4 (19:27:40) — *Saved*; also the BOQ, apply and capture writes above |
| W4 | **PASS** | Signed-in `subcontractor`: BOQ, Reports, Forecast, Commercial and Final Account show their restricted notices, `/portfolio` *The Portfolio Report is restricted*; no figure on any of them; Rules denials as under T14. After deactivation the open session was signed out to `/login` within 5 s (no persisted user). Budget and Purchase Orders show no figure but no restricted notice either — findings below |
| **F16** | **PASS — notice OBSERVED** | Signed-in `subcontractor` on assigned fixture Z, `/commercial/final-account`: ***Final Account is restricted** — The Final Account is visible to Company Admin, Project Manager, and QS roles only.* No figure, no button; `finalAccounts` on Z `permission-denied` from the same session. No control was weakened to reach it |

**External session.** One existing identity (`R5SbTZ…`) was re-provisioned
with the hardened flow: dry run (19:29:40, nothing written), then `--apply
--no-link` (19:30:41 — invitation `Ex7dAVpluJujF0RFL9FR`, `subcontractor`,
`[Z, L4]`; no link produced), Team *Resend* by the TEST Company Admin
(19:31:57), acceptance by the Product Owner (19:35:13). The same uid was
re-enabled and reused — 9 user profiles before and after, 9 Auth accounts after; role
`subcontractor`, exactly the two assignments. P1–P14 and X1–X7 were not repeated.

**Final account states (19:40–19:41 UTC; Team page, TEST Company Admin).**
Subcontractor `R5SbTZ…` (19:40:05), QS `PvzTgu…` (19:40:28) and Project Manager
`KSC9zf…` (19:40:48) **deactivated**: Auth disabled with tokens valid only
since the deactivation second; profile company and role cleared; the
subcontractor's `projectIds` removed; three `member.deactivated`, three
`file_links.revocation_requested` (seq 17–19, urgent) and three
`member.auth_synced` events; one worker pass (19:41:02 — seq 19, scanned 6,
removed 1, failed 0). `reconcile-membership.mjs` report-only: **no
inconsistencies**, for the company and for the whole project; `--fix` not used.
The TEST Company Admin stays active; the `client` identity stays deactivated.

**Integrity (path and update time of every Firestore document, before 19:00:50
and after 19:41:52).** Apex Builders: 258 documents, identical (no difference at
all). Test company: 116 → 148 documents; the only pre-existing documents changed
are the three member records and the two `system` markers; nothing under
projects A, B, C, X, Y or Z changed. New: the L4 project and its 11 records,
its directory entry, one invitation, 16 audit events, two rate-limit records.
Storage: the five earlier fixtures unchanged (md5, metageneration, no token);
one new object. Portfolio after the run: NZD subtotal margin **26%**, USD group
unchanged, Z's Final Account revision 2 *agrees with the current records*.
**Not compared:** Apex Storage objects (no test touched them); document
contents beyond update times.

**Findings (no figure was exposed; tracker D3 #27–#29 — P2 external-role UI correction bundle, architect, 25 November 2026).**

1. Budget tab opened by URL as an external role: no restricted notice; the
   page reports *Some commercial records could not be loaded* and reads
   *Unavailable* throughout.
2. Purchase Orders tab opened by URL as an external role: no restricted notice;
   the refused read is shown as *No purchase orders yet* with *+ New Purchase
   Order* offered (not pressed; the Rules deny the read and would deny a create).
3. A `/commercial/…` URL shows the Commercial sub-navigation (Margin, Client
   Invoices, Client Receipts, Supplier Payments, Cash Flow, Retention, Final
   Account) to an external role; each page behind it is restricted.

**D3 #28 — is an external purchase order create refused by the server? YES (inspection, 25 November 2026; no production write).** *Mechanism:* `frontend/firestore.rules`, block `purchaseOrders` (line 865): `allow read` (line 986), `allow create` (line 988) and `allow update` each require `financialMember(companyId)` — the caller's own `users/{uid}` profile must name this company and a role in `company_admin`, `project_manager`, `qs` (lines 21–26); `allow delete: if false` (line 1044). A project assignment (`projectIds`) is not consulted, so an assigned `client` or `subcontractor` is refused exactly as an unassigned one; no wildcard rule exists that could grant it. The application's create also reads and advances `companies/{c}/counters/purchaseOrders` and reads the cost-code library, each limited to the same three roles. *Emulator tests (existing; the three suites re-run locally on 25 November — 12 selected cases PASS):* `tests/rules/purchaseOrders.rules.test.js` → *subcontractor and client can neither read nor write* (a read, a create with the hook's own payload, a draft edit and a send, each refused) and *delete is blocked for every role in every status*; `tests/rules/externalRoles.rules.test.js` → *… still CANNOT create a purchaseOrders document* for a `subcontractor` and a `client` that are **assigned to that project**, with the same payload the three financial roles are shown to create successfully — so the refusal is the role, not the shape; `tests/rules/externalIsolation.rules.test.js` → *no financial collection of the ASSIGNED project is readable*. *Production:* the deployed ruleset is byte-identical to that source (§71 pre-flight) and the `subcontractor` session's `purchaseOrders` reads on L4 and Z were `permission-denied`; **a purchase order create by an external role was not attempted in production** — that half rests on the ruleset identity and the emulator. *In the page:* `ProjectPurchaseOrders.jsx` disables *+ New Purchase Order* when the cost-code read fails (line 528), but the empty-state button (line 563) is not disabled and the register ignores its own read error, which is why a refused read reads *No purchase orders yet*. **Classification: a display and gating defect (P2), not an authorisation defect and not cosmetic** — the empty state can be untrue on a project that has orders. **Test requirement for the correction:** no further Rules test is needed; the fix must add a unit test that the page shows the restricted notice to a non-financial role and never the empty register after a refused read (none exists — the unit runner has no DOM, so it follows the `finalAccountPage.test.js` pattern).

**Still not covered.** T14 as `client` in a live session; a real network
disconnection (T15); the M5 currency pin; M1, M2 and the stale-bundle part of
M7; M4 with a budget line; a Project Manager approving a budget on this
fixture; replay of a deactivated account's old token (only the session
sign-out was observed); any browser other than Chrome on macOS. Budget
approvals, BOQ edits and forecast saves are client-SDK writes and leave no
`auditEvents` entry — the record itself carries the actor and time.

## 72. C1-C — GANTT production acceptance (25 November 2026 NZDT; 24 November 2026 20:30–21:16 UTC) — **functional acceptance CLOSED** (Lead Architect, 25 November 2026 — REPORTED); presentation, browser and resilience checks carried forward, not passed

**Architect decision (25 November 2026 — REPORTED).** GO — **C1-C functional
acceptance is CLOSED** and Git integration is authorised. Scheduling,
dependencies, baseline management, revision protection, variance calculations
and downstream consistency are accepted; the existing role evidence (§71 M8
and the Rules emulator) is accepted and no test account is to be reactivated.
**Carried forward — tracked, NOT passed:** native print / PDF R1–R13; Safari
and Firefox; Day / Month chart visuals; the dashed baseline outlines; the
individual attention-filter checks (G3–G6, G9–G10); overnight G11; offline
capture; the unexecuted stale quick-action and stale cancellation scenarios.
**Triage:** D3 #30 and #31 are P3 deferred UX corrections. **Deferred Control
23** (valid-shaped impossible dates accepted by the Rules) is retained as a
**data-integrity hardening requirement before customer readiness** (tracker
D1 R-7). The unintended invalid-date write and its correction (below) remain
part of this record. **Final fixture state VERIFIED (read-only, after the
decision):** all 86 date values on the 11 activities and 3 baseline snapshots
are real calendar dates, every planned finish is on or after its start, T08 is
9–16 December 2026 at revision 4, and no activity was written after 21:04:37
UTC. No further production mutation was made. **Rule for future negative
production probes:** verify the expected enforcement mechanism first (the
Rules text, SECURITY.md → *Deferred Controls*, and the existing Rules test)
and send only probes whose refusal is established. **Browser isolation:** the
deviation is recorded in tracker section A; required origins —
`app.constrap.com` the Product Owner's personal session only (never replaced
for a test), `constrapp-69b5d.web.app` the TEST Company Admin,
`constrapp-69b5d.firebaseapp.com` every other test identity. **Next
milestone: C1-D — monitoring and alert delivery.**

*Heading as written before the decision:* … RUN: scheduling, dependencies, baselines, variance, revision guard and downstream consistency PASSED in production on a new retained CAD fixture; independent calculations equal on every surface; print, QS / external sessions and other browsers NOT RUN — awaiting architect review

**Scope.** The outstanding GANTT acceptance: §40–§42 (GANTT 1A1, 1A2, 1B), the
programme parts of §43 (PULSE 1C) and §64 (ADR-79), which had no per-step
production record (tracker C4 row C1-C). Run by the engineer as the TEST
Company Admin (`oOANhA…`) in the isolated company `constrap-acceptance-test`
— on `app.constrap.com`, where the Product Owner replaced the personal session
with the TEST admin (a browser-isolation deviation; see the decision above);
nothing was done in Apex Builders. Documentation only on
`docs/c1c-gantt-acceptance` (uncommitted); no application code, Rules,
Functions, configuration or deployment changed. Evidence classes as in
[SECURITY_DATA_TEST_TRACKER.md](SECURITY_DATA_TEST_TRACKER.md); summary in
tracker **B8**.

**Pre-flight (read-only, 20:30–20:40 UTC).** `main` `8b8c3e5` clean and equal
to `origin/main` (VERIFIED in Git; the L4 / Stage A closeout is integrated —
merge `8b8c3e5`, documentation commit `0062cb7`; Azure `main` GREEN is REPORTED
by the Product Owner). Deployed Firestore ruleset `67b6425a…` (236,737 bytes)
and Storage ruleset `2f3a4788…` (10,323 bytes) byte-identical to `main`. The
live Hosting release (23 November 2026 02:43 UTC) serves `index-BOg2hoYg.js`
and `index-CAs65qiC.css`, **SHA-256-identical to a clean `npm run build` of
`main` `8b8c3e5`** (PROD-VERIFIED); no GANTT source file has changed since
`9ce433d` (ADR-79). So GANTT 1A1, 1A2, 1B, PULSE 1C and ADR-79 are deployed as
merged. D3 #28 is recorded (tracker B7, §71). No unresolved server-side
security defect was found. Baseline snapshot: Apex 258 documents; test company
148 documents, 7 projects and 7 directory entries; PM, QS, `subcontractor` and
`client` Auth accounts disabled, TEST Company Admin active.

**Scheduling semantics used (from the code and ADR-29 / 65 / 66 — nothing
assumed).** Calendar days only (no working calendar, weekends or holidays);
the planned finish is **inclusive** — duration = finish − start + 1; a
milestone has duration 0 and finish = start. Dependencies are **finish-to-start
only**, lag an integer 0–365 days: earliest start = predecessor finish + 1 +
lag, or milestone date + lag for a milestone predecessor. A conflict is
*start < earliest*; **nothing is rescheduled** (no automatic dependency-driven
scheduling, no critical path, no resource levelling). Overdue = open and
planned finish before today (viewer's local day); blocked = not started,
planned start today or earlier, and a predecessor not completed or unresolved.
Baseline variance = current − baseline (start, finish), completion = actual
finish − baseline finish; positive = later. **Progress variance is not
implemented** (the snapshot stores `percentComplete`; no surface compares it)
— a roadmap item, not a failure.

**Fixture (new, RETAINED).** *TEST CAD-1 — C1-C GANTT programme acceptance*,
`V2Vj8jds7RUkBAmZ1jzm`, CAD (a currency no other fixture uses, so it forms its
own Portfolio group at CAD 0.00), created through *Projects → Add New Project*
at 20:54:36 UTC with its directory entry in the same commit. No financial
record. Final programme (11 activities, all written through the GANTT dialogs
except where stated):

| Key | Activity | Planned | Status at close | Predecessor | Rev |
|---|---|---|---|---|---|
| T01 | Site establishment | 16–20 Nov | Completed, actual 16–22 Nov | — | 2 |
| T02 | Excavation | 23–27 Nov | In progress 40% | T01 +0 | 1 |
| T03 | Footings | 30 Nov–4 Dec | Not started | T02 +2 | 1 |
| M01 | Foundations complete (milestone) | 2 Dec (was 5 Dec) | Not started | T03 +0 (acknowledged conflict) | 2 |
| T04 | Ground slab | 5–11 Dec | Not started | M01 +0 | 2 |
| T05 | Survey set-out | 18–24 Nov | In progress 85% (overdue) | — | 3 |
| T06 | Services trenching | 25–26 Nov | **Cancelled** | T02 +0 | 2 |
| T07 | Temporary hoarding | 7–8 Dec | **Cancelled** | — | 2 |
| T08 | Scaffold erection | 9–16 Dec (was 9–10 Dec) | Not started | T07 +0 (now *review*) | 4 |
| T09 | Roof sheeting | 14–18 Dec | Not started (added after Baseline A) | — | 1 |
| T10 | Handover | 21–22 Dec | Not started (added after Baseline B capture) | — | 1 |

Baselines: **Baseline 1 — C1C Baseline A** `h09hcFrJCpDwgvsZMn6k` (approved,
9 entries, *Original*); **Baseline 2 — C1C Baseline B** `0fE0x3cgfKowu0vPfUhp`
(approved, 10 entries incl. T07 as cancelled history, *Active*); **C1C
Baseline C (concurrency draft)** `OKcMBtOz24ddnXHUwHMe` (withdrawn, 11
entries). Keep all three.

**Independent expectations.** A separate Python standard-library model
(`datetime.date` arithmetic only; no application code), fed first with the
planned programme and then with the records read back through the Firestore
REST API, produced every expected duration, earliest start, conflict, blocked,
overdue, due-soon, variance, summary count and envelope below **before** each
UI surface was read. The UI, PULSE, the Dashboard and the CSV were then each
compared with those figures — never one surface with another as the only
evidence.

**Results — scheduling and dependencies (§40, §41).**

| # | Check | Expected (independent) | Observed | Result |
|---|---|---|---|---|
| S1 | Create activities (normal, completed with actuals, in progress, milestone) | Stored exactly as entered; revision 1; exact 24-key shape; author `oOANhA…` | REST read: all nine initial records equal the plan field for field | **PASS** (PROD-VERIFIED) |
| S2 | Duration | T01 5, T03 5 (30 Nov–4 Dec, across a month end), T04 7, T05 7, T06/T07/T08 2; M01 milestone; later T08 8, T09 5, T10 2 | Editor *Duration: n days*, List and CSV identical | **PASS** |
| S3 | Earliest start | T02 21/11 (20 + 1 + 0); T03 30/11 (27 + 1 + **2**); M01 05/12; T04 05/12 (milestone + 0); T06 28/11; T08 09/12 | Editor *Earliest permitted start* identical in each case | **PASS** |
| S4 | Boundary cases | T03 starting ON its earliest date; T04 starting ON the milestone day — no conflict | No conflict panel, no acknowledgement box | **PASS** |
| S5 | Conflict and acknowledgement | T06 starts 25/11 < 28/11 | *Conflict: earliest permitted start 28/11/2026, planned start 25/11/2026*; Save without the tick refused (*Tick the acknowledgement to save it anyway*); changing the start un-ticked it; saved after ticking. Likewise M01 at 02/12 < 05/12 | **PASS** |
| S6 | Cycle prevention (UI) | T01's successors, direct and transitive: T02, T03, T06, M01, T04 | Exactly those five listed as *this would create a dependency cycle* and disabled; T01 itself not offered; T05, T07, T08 offered | **PASS** (client-side; Rules cannot traverse the graph — Deferred Control 41) |
| S7 | Invalid dependency / record — server | Refused | SDK writes from the TEST admin's own session (App Check initialised): blind write with unchanged revision, revision skip, finish before start, type `SS`, lag −1, lag 366, self-predecessor, non-existent predecessor, progress 101, not-started at 50%, delete — **11 × `permission-denied`**, record unchanged | **PASS** (PROD-VERIFIED server-side) |
| S8 | Attention, initial | Needs 2, Overdue 1 (T05, 1 day), Blocked 1 (T06), Conflict 1 (T06), Review 0; *Later than baseline* not evaluated | Identical; *Later than baseline · not evaluated* disabled with the reason (G8) | **PASS** |
| S9 | Summary cards | Overdue 1, Due next 14 days 5, In progress 2, Milestones remaining 1 | Identical | **PASS** |
| S10 | Progress update | T05 80 → 85 stored at revision 3 | REST read | **PASS** |
| S11 | Cancellation | Blank reason refused; with a reason T07, T06 cancelled; T08 then *Review — Predecessor cancelled* | *Enter a reason for cancelling this activity*; cancellation stored; T08 flagged *Review* | **PASS** |
| S12 | Persistence after reload | A second tab, the Dashboard and the REST API show the saved values | Identical after fresh page loads | **PASS** |
| S13 | Last changed (L1) | T01 saved 20:55:08 UTC | *Last changed 25 Nov 2026, 09:55 am NZDT by you* | **PASS** |

**Results — revision and concurrency (§41 check 2, §64 L7).** Same TEST admin
in two tabs (no further account was activated). Tab A opened T05 (revision 1);
tab B saved a note → revision 2. Tab A then saved 85%: **refused** — *Someone
else changed this activity after you opened it. Nothing was saved — your edits
are still here*; the typed 85% remained; the server `updateTime` was
unchanged. **Reload latest** loaded tab B's note; saving again wrote
**revision 3 holding both changes** (tab B's note and tab A's 85%) — no
silent overwrite. Server enforcement: a blind write that does not carry the
next revision is refused by the Rules (S7). **Not reproduced:** a stale *quick
action* and a stale cancel through the UI (the list re-renders from the live
listener, so a stale copy could not be held without a fetch hold); the
"by another user" wording (one account). Both rest on §41 automated tests and
the Rules evidence above.

**Results — baselines and variance (§42).**

| # | Check | Expected (independent) | Observed | Result |
|---|---|---|---|---|
| B1 | Capture | Preview 9 activities, 0 cancelled history, 1 milestone; header `draft` rev 1 + one snapshot in the same commit | Preview identical; header and snapshot share the commit time; the 9 snapshot entries equal the stored programme, each with exactly the ten keys | **PASS** (PROD-VERIFIED) |
| B2 | Review and self-approval | No drift; self-approval note | *No activity has changed since this baseline was captured*; *You captured this draft. Approving it yourself is permitted…*; approved → *Baseline 1 … Active · Original*, *captured and approved by the same person* | **PASS** |
| B3 | Approval stamps; snapshot immutable | Header `approved`, revision 2, `approvedBy` = caller; snapshot unchanged | REST: as expected; snapshot SHA-256 identical before and after approval and to the end of the run | **PASS** |
| B4 | Variance after edits (T08 finish +6; M01 −3 with acknowledged conflict; T01 actual finish 22 Nov; T09 added; T07 cancelled) | Captured 9, added 1, cancelled since 1, compared 8: earlier 1, unchanged 6, later 1; completed late 1 of 1; largest finish movement T08 +6; envelope 11/12 → 18/12 **+7** | Panel identical; List *vs baseline*: T01 0 d *Finished 2 days after the baseline finish*, M01 −3 d, T08 +6 d, T07 *Cancelled*, T09 *Added* | **PASS** |
| B5 | Early / on-time / delayed | M01 earlier (−3), six unchanged, T08 later (+6) | As expected, milestone shown as *Milestone* | **PASS** |
| B6 | Attention with a baseline | Needs 4; Overdue 1; Blocked 1; Conflict 2 (T06, M01); Review 1 (T08); Later than baseline 1 (T08) | Identical; *Hide baseline* removes the column and leaves the count at 1 (G7) | **PASS** |
| B7 | PULSE parity (G2, §43) | Same four sets | PULSE: overdue T05 1 day; blocked T06, 0 days, waiting on T02; *3 dependency links on 3 open activities* (M01 earliest 05/12; T08 cancelled predecessor; T06); later than Baseline 1: T08 10/12 → 16/12, 6 days | **PASS** |
| B8 | Drift and refused approval (§42 check 2) | Draft B, then T04 edited and T10 added in tab B | *Edited since capture · T04 revision 1 → 2*, *Added since capture · T10*; Approve disabled until ticked. After tab B cancelled T06, Approve in tab A **refused** — *The programme changed again after you reviewed it. Nothing was approved*; list now shows *Cancelled since capture · T06*; box un-ticked; header unchanged (REST) | **PASS** |
| B9 | Re-baselining | B approved → *Baseline 2 · Active*, A → *Original* and selectable | As expected. Against B2: captured 10 (1 cancelled history), added 1, cancelled since 1, unchanged 8, later 0; attention Needs 3, Overdue 1, Blocked 0, Conflict 1, Review 1, Later 0 — equal to the model | **PASS** |
| B10 | Historical comparison (G8a) | Against A after all changes: captured 9, added 2, cancelled 2, compared 7: earlier 1, unchanged 5, later 1; envelope 11/12 → 22/12 **+11** | Identical; *Later than baseline* 1 while PULSE (active B2) has 0; the amber line names the historical basis | **PASS** |
| B11 | Withdrawal | Blank reason refused; with a reason → `withdrawn` | *Enter a reason for withdrawing this draft*; C stored `withdrawn`, revision 2 | **PASS** |
| B12 | Concurrent approve after a withdrawal | Second action refused | **UI:** the stale review dialog in tab A **closed by itself** when its listener saw the draft withdrawn, with no message (D3 #30) — the approve could not be sent. **Server:** an approve of the withdrawn header sent through the SDK → `permission-denied` | **PASS with a UX finding** |
| B13 | Baseline immutability — server | Refused | SDK: rename / withdraw / delete an approved header, edit / delete an approved snapshot, a snapshot without its header, a header without its snapshot, edit / reopen a cancelled activity, a create with a forged cancellation — **10 × `permission-denied`** (11 with the B12 probe); none of the probe documents exists afterwards; every header and snapshot hash unchanged since its last legitimate write | **PASS** (PROD-VERIFIED) |
| B14 | Invalid programme cannot be baselined (§42 check 3) | Capture refused, naming the record | With T08 holding an impossible date (see *Unintended write* below): *1 activity cannot be captured as stored … C1C T08 Scaffold erection has no usable planned start*; *Capture draft baseline* disabled; the List shows "—" for its start and duration rather than an invented figure | **PASS** |
| B15 | Progress variance | Not implemented | — | NOT BUILT (roadmap) |

**Results — export and downstream (§64, item 7 of the brief).**

| Surface | Expected (independent) | Observed | Result |
|---|---|---|---|
| Programme CSV (captured in memory, nothing saved to disk) | Whole programme 11 of 11; active basis B2; per-row dates, durations, flags and variances as above | File name `constrap-programme-report-test-cad-1-c1-c-gantt-programme-acceptance-2026-11-25.csv`; header block, *Baseline basis ACTIVE*; every row equal to the stored records and the model (T08 8 days, T10 *NOT IN BASELINE / NOT COMPARED*, T06 *Cancelled since the baseline was approved*, T07 *Already cancelled when the baseline was approved*); **0 empty cells**; no write (REST before / after) | **PASS** (C1, C3–C5, C9) |
| Dashboard Programme panel | 11 activities: 6 not started, 2 in progress, 1 completed, 2 cancelled; overdue 1; due in 14 days 3 (T02, M01, T03); next milestone M01 02/12, 7 days | Identical | **PASS** |
| Project Overview | — | No programme figure (only the GANTT tab) | Not built — roadmap |
| Portfolio | CAD in its own group, all CAD 0.00; no programme indicator | As expected; **NZD weighted margin 26%**, **GBP approved budget 12,565.34**, USD 29.7% unchanged | **PASS**; programme indicators on the Portfolio not built — roadmap |
| Commercial / financial records | Programme writes no financial document | The fixture holds no budget line, BOQ item, PO, invoice, forecast, approval, snapshot, adjustment, claim, variation, Final Account or PULSE acknowledgement; no other project's document changed | **PASS** |
| Print / Save as PDF (R1–R13) | — | **NOT RUN** (a print dialog blocks browser automation); PO acceptance of ADR-79 REPORTED | NOT RUN |

**Role and security evidence.** Production: the deployed ruleset is
byte-identical to `main`; every refusal above came from the deployed Rules in
the TEST admin's own session. Earlier production evidence reused: §71 M8 — the
Company Admin, Project Manager and QS opened GANTT, *+ Add activity* shown to
the Project Manager and not to the QS. Emulator (re-run 25 November):
`activities.rules.test.js`, `activitiesTransitional.rules.test.js`,
`programmeBaselines.rules.test.js`, `externalRoles.rules.test.js`,
`externalIsolation.rules.test.js` — **5 files / 445 tests PASS** — the QS can
read but not write activities or baselines; `client` and `subcontractor`
cannot read `activities` or `programmeBaselines` even on an assigned project.
Role matrix as documented (`PROGRAMME_READ_ROLES` / `PROGRAMME_WRITE_ROLES`;
Rules `programmeReader` / `programmeWriter`, `baselineReader` /
`baselineWriter`). **Not run in production:** a QS or external-role session on
the programme (the accounts stay deactivated; no further live role evidence is
needed for closure in the engineer's view — §71 M8 and the emulator cover the
matrix).

**Unintended write (engineer error, recorded).** Probe S7-12 sent
`plannedStart: '2026-02-30'` to T08 expecting a refusal; the Rules check the
date **shape** only and **accepted** it (revision 1 → 2). This is the
documented Deferred Control 23 (SECURITY.md item 23; proven by
`activities.rules.test.js` — *ACCEPTS an impossible calendar date of valid
shape*) — not a new defect — and the probe should not have been sent. It was
confined to the fixture; it was used for B14, and T08 was then corrected
through the editor (revision 3, 9–10 Dec). The app degraded safely ("—", no
invented duration, capture refused).

**Observations (not defects).** The conflict acknowledgement is bound to the
exact start + predecessor combination: any change clears it, and restoring
the acknowledged combination shows it ticked again (`ackKey === currentAckKey`
in `ActivityEditorModal.jsx`) — by design. The *Activities* figure in the
capture preview counted 8 while T08's date was unusable and 9 once corrected.

**Findings (tracker D3).** **#30** (P3, UX) — a baseline review dialog closes
without a message when another session withdraws (or approves) the draft; the
§42 wording *Someone else changed this baseline* was not seen; the server
refusal is proven. **#31** (P3, wording) — for a cancelled successor the CSV /
List predecessor text still reads *Starts before its predecessor allows*
although the *Dependency conflict* column and the attention counts correctly
exclude it.

**Data integrity (20:36 → 21:16 UTC).** Apex Builders: 258 documents, path and
update time **identical** (including the worker's system document — no run in
the window). Test company: 148 → 167 documents; the 19 additions are the
fixture project, its directory entry, 11 activities, 3 baseline headers and
3 snapshots; **no existing document changed**; 8 projects and 8 directory
entries. No `auditEvents` entry was written (programme writes are client-SDK
writes and carry their own actor and time). Fixtures A–C, X, Y, Z and L4 and
their Storage objects (md5, metageneration, no token) unchanged; Z's approved
Final Account revision 2 hash `74cc8f7a…` equals its C1-A record; L4
independent check *ALL CHECKS OK*. `users` unchanged; PM, QS, `subcontractor`
and `client` Auth accounts still disabled; only the TEST admin's last sign-in
moved (Product Owner sign-in, 20:53 UTC). **Not compared:** Apex document
contents (path and update time only); Apex Storage.

**Still not covered.** Print / PDF R1–R13 and Safari / Firefox; chart
visuals at Day and Month zoom, cost-code grouping with collapsed arrows, and
the dashed baseline outlines (the chart was seen at Week zoom only); the
attention-filter chips pressed one by one (G3–G6, G9–G10); G11 across local
midnight; a QS or external session on the programme; "by another user"
(L2); a stale quick action or cancel through the UI; offline capture;
§41 check 3 and §43 checks for the Stage-1 / failure paths (release-stage or
DevTools-blocking scenarios).

## 73. C1-D — Monitoring and alert delivery acceptance (25 November 2026 NZDT; 24 November 2026 21:56–22:36 UTC) — **CLOSED** (Lead Architect, 25 November 2026 — REPORTED): inventory and parity VERIFIED; temporary heartbeat alert delivered to the Product Owner channel and recovered naturally; evidence limitations recorded

**Architect decision (25 November 2026 — REPORTED).** GO — **C1-D is CLOSED** and integration is authorised. D1–D7 accepted; the Product Owner's opening and recovery notifications confirmed; natural incident recovery verified; the repository uptime-policy correction and the strengthened configuration test approved; all temporary resources removed and the permanent production policies unchanged. **Evidence limitations (stand after closure):** the billing-administrator channel was not tested in this run; exact email arrival times are unknown; not every permanent policy has fired on its intended condition (only policy B, once); the permanent policies' recovery-notification behaviour is unverified; receipt of policy B's 17 November email is unverified; observed timings are not service levels. **Monitoring requirements retained for operational hardening and customer readiness:** a `transferBoqToBudget` failure alert; callable errors without a 5xx; membership-reconciliation monitoring; backup monitoring; billing-outage monitoring; independent notification paths. **Next milestone: L3 Stage 2 E1–E10 remaining acceptance.**

*Heading as written at the run:* … RUN: inventory and parity VERIFIED; temporary heartbeat alert delivered and recovered naturally; awaiting architect review

**Scope.** The C1-D row of the tracker (C4): a production inventory of the
alerting, repository parity, and one end-to-end alert-delivery test using a
synthetic signal approved by the Lead Architect. It also gathers existing
evidence. Read-only except for the approved creation and deletion of one
temporary alert policy. No application code, deploy, Rules, Functions,
Scheduler, channel, account or business-data change. Context: the C1-C
closeout is integrated (`main` `caf6ecf`, VERIFIED in Git); Azure `main`
GREEN is REPORTED by the Product Owner. Records: DEPLOYMENT.md → *L3 Stage 1*
→ *C1-D alert delivery acceptance record* and *Operational incident log*;
DEPLOYMENT.md → *DC46-C monitoring readiness* → *Policy B incident*; tracker B9.

**Checklist.**

| # | Check | Result | Evidence |
|---|---|---|---|
| D1 | Policies, channels, uptime check and log metric exist and are enabled | **PASS.** 5 policies, all enabled and none edited since creation; 2 email channels, enabled and unmodified since 16 Nov; 1 uptime check (all 6 locations passing); 1 log metric; 0 open incidents | Cloud, 24 Nov 21:56–22:05 UTC |
| D2 | Live configuration equals the repository | **PASS after correction.** DC46 A, B, C, the metric and the uptime check are identical. The L3 availability policy was created with a check-id filter and `resource.label.*` grouping; these were verified to mean the same (below), and the file and its test were aligned with production. The Final Account policy omits the default `thresholdValue` 0 | Cloud; audit log; `monitoringPolicies.test.js` |
| D3 | The synthetic signal opens an incident on a policy using a production channel | **PASS.** Heartbeat at 22:24:03 UTC; incident `0.ofehms6qj26w` opened at 22:29:20 | Cloud |
| D4 | Notification sent and receipt confirmed | **PASS (Product Owner channel).** The opening email was received by 11:32 NZDT, showing the test policy, start 22:29 UTC, threshold 0 and value 1 | **Reported** by the Product Owner; exact arrival times and the incident id not visible |
| D5 | The condition clears and the incident closes | **PASS — natural recovery.** At 22:33:35 the condition "returned to normal with a value of 0.000" and the incident closed; the resolved email was received by 11:34 NZDT | Cloud; **Reported** |
| D6 | Temporary policy removed, nothing else changed | **PASS.** Deleted at 22:34:58, 26 minutes after creation; post-test checks below | Cloud |
| D7 | Documentation and tracker | Done in this revision | — |

**The synthetic test.** One temporary policy, `TEST - C1-D alert delivery
check - delete after use` (`10264183102153085239`). It is a threshold above
0 on the planning-heartbeat metric `dc46_reconciliation_plan_complete`, with
a 5-minute `ALIGN_DELTA` window, a duration of 60 s,
`EVALUATION_MISSING_DATA_INACTIVE`, OPENED and CLOSED notifications, no
renotification, and a 30-minute auto-close. It went to the Product Owner
channel only: the billing administrator was not available, as the approval
required. It reads an existing metric and calls nothing. The full body and
the timeline are in the deployment record.

| UTC, 24 Nov | Event | Class |
|---|---|---|
| 22:08:41 | Policy created (audit) | Cloud |
| 22:24:03.05 | Heartbeat log line; metric point 22:23:51–22:24:51 = 1 | Cloud |
| 22:29:20 | Incident opened | Cloud |
| by 22:32 | Opening email received | Reported |
| 22:33:35 | Natural recovery; incident closed | Cloud |
| by 22:34 | Recovery email received | Reported |
| 22:34:58 | Policy deleted (audit) | Cloud |

Observed — **not service levels**:
- Heartbeat to incident: 5 min 17 s.
- Incident duration: 4 min 15 s; the Product Owner's email shows 4 min 14 s.
- Open to email: no more than about 4 min.
- Recovery to email: no more than about 1.5 min.

**Post-test integrity (Cloud, 22:35 UTC):**
- The five original policies are byte-identical to the pre-test read and
  match their files.
- No TEST policy remains.
- Both channels are unchanged.
- Three incidents in all, none open; history is kept.
- The audit log since 22:00 holds only the create and the delete.
- No error-level line from any service.
- The worker `-00003-ceg` is at 100 % with 59/59 requests successful; the
  Scheduler job is `ENABLED`.
- The Firestore writes at 22:25–22:26 match the worker's periodic sweep (the
  same pattern as 20:22 / 20:23). The test made no Firestore call. No
  business data, account or Apex Builders record was touched.

**Evidence gathered, not repeated:**
- **16 November** — a delivery test on both channels (receipt reported, no
  times recorded).
- **17–18 November** — **policy B's real incident.** The predicted
  first-pass `reconciliation overdue` line at activation (19:17:02) opened
  `0.of4o1z1d3uvz` at 19:18:06, which auto-closed on 18 November at
  19:22:24. This corrects §54, DEPLOYMENT.md, `ops/monitoring/README.md`,
  ADR-75 and the handover, which said policy B had never matched. Its email
  receipt was not recorded. A mailbox search is optional and was not
  reported.
- **30-day health** — zero 5xx on all 11 services. The only non-2xx were
  401 / 400 / 403 / 404 probes and refusals. One single-location uptime
  failure (24 November 11:11:41 UTC) stayed below the two-location threshold
  by design.

**The availability policy's filter as created (D2).** Both forms were read
read-only over the check's whole history (1,157 five-minute rounds), and
both return one identical series. `uptime_url` carries only `project_id` and
`host`, and the check id is the only one on the host. The production form is
narrower and has the intended meaning, so it was adopted. The test now pins
the exact id, and requires that the id derives from the committed check's
display name. Each of three deliberate mutations makes it fail: the old
host-only filter, the old grouping, and a foreign id. The live policy was
not changed.

**Coverage.** Implemented and deployed:
- worker policies A, B and C;
- the uptime check and its policy;
- the `approveFinalAccount` 5xx policy.

Verified alert delivery: the Product Owner channel (C1-D, opened and
resolved); the billing-administrator channel only as reported on
16 November.

**Missing — retained for operational hardening and customer readiness;
no policy added:**
- a `transferBoqToBudget` failure alert;
- callable errors that do not return a 5xx (handler errors returned as 4xx
  or 200, and error lines in the eight team callables);
- monitoring of membership reconciliation (an operator script, not
  scheduled);
- backup monitoring (manual weekly check only);
- billing-outage monitoring, and alerting independent of this project;
- independent notification paths (two email recipients only, no second
  medium).

Still never fired on a real condition: policy A, policy C, the uptime
policy, and the Final Account policy. Whether the permanent metric policies
send a resolved email is not established: their `notificationPrompts` is
unset, and log-based policy B notifies on opening only.

**Automated checks (this revision):**
- `npx vitest run --config vitest.config.js tests/unit/monitoringPolicies.test.js`
  — **1 file / 24 tests pass**.
- The three negative mutations each fail one test.
- ESLint is clean on the test file.
- `git diff --check` is clean.

No application code changed, so the other suites were not re-run.

**Not covered:**
- the billing-administrator channel at this run;
- exact email arrival times;
- any policy firing on its real failure condition;
- behaviour during a billing suspension.

## 74. L3 Stage 2 E1–E10, GST boundary hotfix and Premium Dashboard v2 — consolidated regression acceptance (25 November 2026 NZDT; 00:32–01:08 UTC) — **E1 and E3–E10 ACCEPTED with evidence limitations; E2 OPEN (tracker D3 #32) — L3 NOT closed; GST calculation compatibility and Dashboard tested calculations ACCEPTED, their unexecuted checks still open** (Lead Architect, 25 November 2026 — REPORTED; §74.10)

*Heading as written at the run:* … — **RUN, awaiting architect review**

Documentation only, on `docs/l3-regression-acceptance` (uncommitted). No
application code, Rules, Functions, Hosting or monitoring change; no
deployment; no production business-data write. Tracker section B10.

**Baseline.** `main` `875910e` (*Merge C1-D monitoring acceptance closeout*;
documentation commit `6e00f98`), equal to `origin/main` and clean — VERIFIED in
Git. Azure `main` GREEN — REPORTED by the Product Owner; not read here.

**What "passed" means below.** Three evidence classes are kept apart:

| Class | Meaning in this section |
|---|---|
| PROD-VERIFIED | Read from production read-only (REST with the operator's own login, or the TEST Company Admin's browser session on `constrapp-69b5d.web.app`) |
| LOCAL (EMULATOR) | The application source of `main` `875910e` served by the Vite development server against local Auth and Firestore emulators (project id `demo-constrap-l3`, so no production contact), with the repository `firestore.rules`; driven in headless Chrome 158 in a throwaway profile over the DevTools Protocol. **Simulated** — it says nothing about production behaviour beyond the fact that the same source and the same Rules are deployed |
| UNIT | `npm run test:unit` and the pure / emulator suites |

### 74.1 Release state — PROD-VERIFIED (read-only, 25 November 2026 00:35 UTC)

| Item | Reading |
|---|---|
| Hosting, all three origins (`app.constrap.com`, `constrapp-69b5d.web.app`, `constrapp-69b5d.firebaseapp.com`) | `index-BOg2hoYg.js`, SHA-256 `5bf43ffc…ef4e`, **identical to a clean build of `main` `875910e`** (`index.html` and the stylesheet identical too); `last-modified` 23 November 2026 02:43:14 GMT |
| Firestore ruleset | `67b6425a…`, released 23 November 2026 02:50:09, 236,737 bytes — **byte-identical to `frontend/firestore.rules`**; it contains the shared `gstPinned()` (nine occurrences, its one definition included) |
| Storage ruleset | `2f3a4788…`, 10,323 bytes — byte-identical to `frontend/storage.rules` |
| Ancestry | `ea2eea8` (GST boundary hotfix), `ba52821` (Premium Dashboard v2) and `b7f825f` (L3 Stage 2) are ancestors of `main` `875910e` |

**Consequence.** The GST boundary hotfix (Rules step and Hosting step),
Premium Dashboard v2 and L3 Stage 2 are **deployed**: the live Rules and the
live bundle are the ones `main` builds, and `main` contains all three. This
replaces the "production state unconfirmed" entries for the GST hotfix and
Dashboard v2. It is a statement about deployed content. The original release
dates of those two items are still not recorded anywhere.

### 74.2 Requirement classification

| Requirement | Source | Classification before this run | After this run |
|---|---|---|---|
| L3 E1 | §66 | Outstanding production check | **PASS — PROD-VERIFIED** and LOCAL |
| L3 E2 | §66 | Outstanding; needs a controlled disconnection | **NOT PASSED as written** — the written step cannot reach the application; one new defect (D3 #32); the designed state PASS under injection, LOCAL only |
| L3 E3 | §66 | Outstanding; needs a refused or failed read | **PASS — LOCAL** (refused read); the *could not be loaded* variant UNIT only |
| L3 E4–E7, E7a–E7c, E8, E10 | §66 | Requires production mutation (drafts, posts, issues, voids) or a disconnection | **PASS — LOCAL**; not run in production |
| L3 E9 | §66 | Requires a role session without write access (no reactivation authorised) | **PASS — LOCAL**, the refusal simulated by an emulator-only Rules variant |
| GST hotfix — deployed | §44; DEPLOYMENT.md; handover F | Unconfirmed | **PROD-VERIFIED** (74.1) |
| GST hotfix — manual acceptance 1–3 | §44 | Requires production mutation | **NOT RUN in production**; covered by the Rules emulator suite, the unit suite and an independent exact-decimal check (74.4) |
| Dashboard v2 — deployed | §22; handover F | Unconfirmed | **PROD-VERIFIED** (74.1) |
| Dashboard v2 — figures, chart labels and switching | §22 check 1 | Outstanding production check | **PASS — PROD-VERIFIED** without network throttling (74.5) |
| Dashboard v2 — roles and states | §22 check 2 | Needs an external session (deactivated) | NOT RUN; UNIT only |
| Dashboard v2 — layout at 375 / 768 / 1280 / ≥1600 px | §22 check 3 | Outstanding | NOT RUN |
| Monitoring | §73 | Already accepted (C1-D) | Reused; the five policies re-read and unchanged (74.6) |

### 74.3 L3 Stage 2 — E1–E10

**Production (PROD-VERIFIED, TEST Company Admin on `web.app`, 01:04 UTC).**
E1 only. `/projects/<fixture X>` opened the project with its header and all
18 tabs; `/projects/l3e1DoesNotExist` showed *Project not found.*
(`data-project-state="not-found"`). No console message was recorded on either
page. Nothing was written.

**Local method.** A throwaway company, one Company Admin, two projects, a
client and a supplier contact, one sent purchase order, one posted supplier
invoice and a contract baseline were seeded into the emulators with the
emulator's rules-bypassing owner token. Every write under test went through
the application's own dialogs and the repository Rules. Failure injection:

- *Browser offline:* `Network.emulateNetworkConditions { offline: true }`.
- *Backend unreachable, page reachable:* `Network.setBlockedURLs` on the
  emulator's address.
- *Connection lost between two reads:* `Fetch` interception failing the
  request that opens the projects listener and every later backend request.
- *Server refusal:* an emulator-only copy of `firestore.rules` with one
  `allow` line changed, loaded through the emulator's REST endpoint and
  restored afterwards. The repository file was never edited.

Server state after each step was read from the emulator directly, not from
the page.

| ID | Result | Class | What was observed |
|---|---|---|---|
| E1 | **PASS** | PROD-VERIFIED; LOCAL | As above; locally the same two states |
| E2 | **NOT PASSED as written** | LOCAL; one public production Hosting observation | See *E2 in detail* below |
| E3 | **PASS** (refused read) | LOCAL | With project reads refused, a reload of the project URL showed *You do not have access to this company's projects* with *Try again*, never *Project not found*. *Try again* while still refused kept the notice; after the Rules were restored, *Try again* loaded the project. Not exercised: the *This project could not be loaded* (non-permission failure) notice — UNIT only; a real deactivated or wrong-company session |
| E4 | **PASS** | LOCAL | The dialog closed; exactly one draft, `CR-0001`, 100.00 |
| E5 | **PASS** | LOCAL | Offline: *Saving…* for 8.1 s, then the amber *Could not reach the server, so this was not confirmed as saved…* message; submit disabled; client and amount kept; server unchanged. *I have checked the list — it was not saved. Let me try again.* re-enabled submit. Online: one new draft, `CR-0002`, 200.00 — two drafts in total |
| E6 | **PASS** | LOCAL | Offline post of `CR-0001`: *Posting…* for 15.2 s, then *Waiting for confirmation…* with *Close* enabled. *Close*: the page notice read *Client receipt posting has not been confirmed by the server yet…*; server still `draft`. Online: the notice changed to *was saved. The server has now confirmed it.* within 0.3 s; `CR-0001` posted once |
| E7 | **PASS** | LOCAL | Same on `CR-0003` with the dialog left open: it closed by itself 0.1 s after the connection returned; posted once; no page notice |
| E7a | **PASS** | LOCAL | During E6, with the notice still unconfirmed, *Post* on `CR-0002` showed the red *An earlier attempt at this has not been confirmed by the server … This new attempt was not sent.*; server unchanged. After *was saved*, the same post succeeded |
| E7b | **PASS** | LOCAL | Dialog closed on the amber uncertain message: the page notice read *could not be confirmed by the server: it may or may not have been saved*. A reopened *New Client Receipt* was refused with the red message; nothing written. *I have checked the list* cleared the notice; the next submit created exactly one draft, `CR-0003` |
| E7c | **PASS** | LOCAL | Console captured from E4 to E7: 0 React state-update warnings, 0 unhandled promise rejections, 0 window errors. 50 Firestore SDK transport warnings, expected while offline |
| E8 | **PASS** | LOCAL | Two synchronous clicks on *Create draft receipt*: one draft. Two synchronous clicks on *Issue* (`CI-0003`): one write message carrying one invoice mutation, one record, status `issued`. *Observation:* the two synthetic clicks raised two native confirmations — the page's own `locked` check had not re-rendered — and the controller refused the second run. A person cannot produce this: the first confirmation is modal |
| E9 | **PASS** (simulated) | LOCAL | With client-receipt create and update refused by the Rules while the dialog was open: a create (transaction) and a post (plain write) each showed the red *You do not have permission to do this. Nothing was saved.*; no SDK text, error code or `FirebaseError` anywhere on the page; nothing written. Not exercised: a real role change in a second session (no reactivation authorised) |
| E10 | **PASS** | LOCAL | Client Invoices: create, issue, void. Supplier Payments: create with *Allocate oldest first*, post, void. Stored and displayed figures equal the independent arithmetic below. No console error |

**E10 figures — independent arithmetic (Python `Decimal`, half-up).**

| Record | Entered (ex-GST) | Expected GST / gross | Stored |
|---|---|---|---|
| `CI-0001` | 1,234.55 | 123.46 / 1,358.01 | 123.46 / 1,358.01 |
| `CI-0002` | 803.00 | 80.30 / 883.30 | 80.30 / 883.30 |
| `CI-0003` | 10.05 | 1.01 / 11.06 | 1.01 / 11.06 |
| Issued, after `CI-0002` was voided | 1,244.60 ex-GST; 1,369.07 gross; 48,755.40 available of 50,000 | — | shown as $1,245, $1,369, $48,755 (the page shows whole currency units) |
| `SP-0001` | 6,600.00 against `SI-0001` (payable 6,600.00) | Remaining payable 0 after posting; 6,600 after the void | $0, then $6,600 |

**E2 in detail.**

1. *The step as written cannot reach the application.* With the browser
   offline, a reload of a project URL returns the browser's own error page
   (`ERR_INTERNET_DISCONNECTED`). The same was observed on production
   Hosting, unauthenticated, on the public sign-in page: no service worker is
   registered; an offline reload fails; an offline navigation to a URL loaded
   within the hour is served from the HTTP cache (`cache-control:
   max-age=3600`).
2. *Backend unreachable from the start of the load, page reachable — a new
   defect (tracker D3 #32).* The application showed **No active membership —
   This account is signed in but is not a member of a company…** with a
   *Sign out* button, within a second, and kept showing it for the 20 s
   observed. It never showed *Waiting for the server*. When the backend
   became reachable the project appeared by itself in 0.8 s, without a reload
   and without a sign-out. Cause, read from the code: with an unreachable
   backend the SDK answers the `users/{uid}` listener from its empty cache
   with a document that "does not exist"; `ProfileProvider`
   (`hooks/useProfile.jsx`) does not read `metadata.fromCache`, and
   `membershipGate` (`lib/team.js`) treats a settled null profile as *no
   membership*. The gate (ADR-72) sits above the project route, so the L3
   state below it is never reached on a cold load. **Not observed in
   production with a signed-in session.** It is expected there because the
   same source is deployed and item 1 shows the page can be served offline
   from the HTTP cache — an inference.
3. *The designed state — PASS under injection.* With the membership and
   company reads answered and the connection cut before the projects read:
   *Loading project…* for 11–12 s, then **Waiting for the server** with no
   *Try again* button and never *Project not found*. When the connection was
   restored the project appeared without a reload in 1.1 s.

**Not covered by this run.** Any E2–E10 step in production; Safari and
Firefox; the minified production bundle (the local run used the development
build of the same source); a real mobile network; a reply lost after a
commit; the 58 older write sites (D3 #11), which are unchanged and outside
ADR-80.

### 74.4 GST boundary hotfix

**The defect and the fix** are as recorded in §44 and PROJECT_DECISIONS.md →
*ADR-40 / ADR-57 Correction*: F2, two exact 10% pins refused the
application's own rounding on a half-cent boundary; F3, a claim-sourced
invoice recomputed GST per line instead of apportioning the certified figure.

**Scope of the tax behaviour verified.** The application applies a flat 10%
GST on a `gst` tax code and nothing on `gst_free` or `input_taxed`, on every
project **whatever its currency** (fixture Z is USD and carries 10%). That is
the documented behaviour (*Australian GST only*); international tax is
deferred. **This section verifies the software against its own specification.
It is not a statement of tax compliance in any country.**

| Check | Class | Result |
|---|---|---|
| Deployed (Rules and Hosting) | PROD-VERIFIED | 74.1 |
| Fixture Z, `SI-0001` (read-only) | PROD-VERIFIED | Stored 84,321.50 + GST 8,432.15 = 92,753.65; independent `Decimal`: 8,432.15 and 92,753.65. Not a boundary amount; retention 0. Actual cost 84,321.50 is ex-GST and the payable 92,753.65 is gross on the Dashboard (74.5), as accepted for the Final Account and the Portfolio in §62c and §63. **No production record exercises F2 or F3:** the test company holds no retention, no claim and no claim-sourced invoice |
| The application's `roundMoney(x × 0.1)` against exact half-up | Independent arithmetic (the app's function in Node; the expectation in Python `Decimal`; no shared code) | Every whole-cent amount from 0.00 to 100,000.00 (10,000,001 values): equal for all but 26,208, each **exactly one cent low** and each on a half-cent boundary (2.62% of the 1,000,000 boundary amounts); none high; none off a boundary; **1,632 within 0–10,000**, the figure in §44; first case 40.15 → 4.01 (exact 4.02) |
| `gstPinned()` restated from the Rules text | Independent arithmetic | Accepts the application's figure for all 10,000,001 amounts; never accepts exact + 1; never accepts exact − 1 off a boundary. The Rules helper `floor((c + 5) / 10)` equals `Decimal` half-up for every amount |
| Retention release delta, `roundMoney(next × 0.1) − roundMoney(prev × 0.1)` | Independent arithmetic | 2,000,000 sampled (previous, amount) pairs, half forced onto boundaries: the delta is exact, one low or one high (1,949,300 / 22,503 / 28,197) and the release rule's two alternatives accept every one. 40.15 + 40.15 + 19.70 gives 4.01 + 4.02 + 1.97 = 10.00 |
| `allocateGstCents` (the application's function, bundled unmodified) against an independent largest-remainder implementation | Independent arithmetic | 20,000 generated cases, 1–8 lines, some non-taxable, target varied by up to ±3 cents: identical output in all 20,000 (5,885 refusals among them, each more than two cents from 10% of the taxable lines); every accepted result sums to the target; no GST on a non-taxable line. 3 × 10.05 with 3.02 certified gives 1.01 / 1.01 / 1.00 |
| Rules emulator suite | EMULATOR | `npm run test:rules`: 39 files, 2,492 tests PASS, including the §44 boundary cases in `supplierInvoices.rules.test.js` and `retentionReleases.rules.test.js` |
| Unit suite | UNIT | 101 files, 5,244 tests PASS, including `claimSourcedGstAllocation.test.js` |
| Local browser | LOCAL | The three client invoices of 74.3 E10 only; 10.05 → 1.01 is the app's own half-up result |
| §44 manual acceptance 1–3 | — | **NOT RUN in production** — each needs new financial records |

**If the architect wants §44 steps 1–3 in production**, the smallest scope
is one new synthetic project in the isolated test company, in a currency no
fixture uses (to keep the NZD, USD, GBP and CAD subtotals pinned), holding:
one sent purchase order; one direct-PO supplier invoice of 803.00 with
retention 40.15, approved and posted; one or two retention releases; one
progress claim of three lines at 10.05, approved; one claim-sourced invoice
created, header-edited and posted. About nine documents plus the company
counters for claims and releases, and a ninth project and sixth currency
group on the Portfolio. Not authorised and not done.

### 74.5 Premium Dashboard v2 — PROD-VERIFIED (TEST Company Admin, `web.app`, 01:02–01:05 UTC)

**Method.** Expected figures were calculated first from the raw production
records of each project (read-only REST; Python `Decimal`; formulas restated
from FINANCIAL_WORKFLOWS.md; no application code). The Dashboard was then
read in the browser. While each project was selected, the snapshot was
sampled on every animation frame and each frame checked for any figure or
currency of the previously selected project. The Dashboard shows whole
currency units, so agreement is to the displayed unit; agreement to the cent
on the same records was established on the Forecast, Final Account and
Portfolio surfaces in §62c, §63, §71 and is reused.

**Portfolio counts.** Active 1, total 8; Planning 7, In Progress 1, the
other three statuses 0 — equal to the eight project documents.

| Project (currency) | Budget card | Forecast Final Cost · variance | Forecast gross profit · margin · movement | Remaining payable | Actual · remaining committed · uncommitted | Expected (independent) | Stale frames |
|---|---|---|---|---|---|---|---|
| GBP-1 (GBP) | Approved, version 1, GBP 12,565 | GBP 12,000 · within budget, GBP 565 | *Contract value not set* | GBP 0 | 0 · 0 · GBP 12,000 | 12,565.34; 12,000.00; 565.34; no contract; 0 | first load |
| USD-1 Z (USD) | Approved, version 1, USD 90,000 | USD 84,322 · within budget, USD 5,679 | USD 35,679 · 29.7% · ▲ USD 5,679 | USD 92,754 | USD 84,322 · 0 · 0 | 90,000; 84,321.50; 5,678.50; 35,678.50; 29.73%; +5,678.50; 92,753.65 gross | 0 |
| NZD-1 X (NZD) | Approved, version 1, NZD 150,000 | NZD 160,000 · over budget, −NZD 10,000 | NZD 40,000 · 20% · ▼ −NZD 10,000 | NZD 0 | 0 · 0 · NZD 160,000 | 150,000; 160,000; −10,000; 40,000; 20.00%; −10,000; 0 | 0 |
| NZD-2 Y (NZD) | Approved, version 1, NZD 30,000 | NZD 25,000 · within budget, NZD 5,000 | NZD 25,000 · 50% · ▲ NZD 5,000 | NZD 0 | 0 · 0 · NZD 25,000 | 30,000; 25,000; 5,000; 25,000; 50.00%; +5,000; 0 | 0 |
| CAD-1 (CAD) | Working, not approved, CAD 0 | CAD 0 · variance CAD 0 | *Contract value not set* | CAD 0 | 0 · 0 · 0 | No financial record: every figure a genuine zero; no contract | 0 |
| A (AUD) | Working, not approved, $0 | $0 · variance $0 | *Contract value not set* | $0 | 0 · 0 · 0 | Headline 123,456 only (register: $123,456); no other record | 0 |

- **Movement against the original plan** is (contract − Forecast Final Cost)
  − (contract − original approved budget). The original approved budget is
  the total of the original approved version (ADR-70), not the baseline's
  legacy field, which is empty on these fixtures.
- **Chart labels** (Current Contract Sum, Approved Budget, Forecast Final
  Cost, Actual, Remaining Committed, Uncommitted Cost to Complete) equal the
  cards on NZD-1 and NZD-2. With no figure at all (CAD-1, A) the chart reads
  *No budget, cost or contract value recorded yet.* The bar geometry and the
  budget marker were **not inspected visually**.
- **Programme panel, CAD-1.** 11 activities; not started 6, in progress 2,
  on hold 0, completed 1, cancelled 2; *Completed 1 of 11*; overdue 1; due in
  14 days 3; milestones left 1; next milestone *C1C M01*, 2 December 2026,
  due in 7 days. Equal to an independent reading of the 11 activity documents
  for 25 November 2026 (overdue: T05; due: T02, T03, M01). The other projects
  read *No programme activities yet.*
- **Switching.** No frame showed a figure or a currency of the previous
  project under the new project's heading (five switches sampled). A reload kept the selected project (`?project=` in the URL).
- **Zero and unavailable.** A project with no financial record shows genuine
  zeros and *Contract value not set*, not "—". A headline budget of 0 is
  shown as "—" in the register and on the Overview (a truthiness check; 0
  means none was entered). *Unavailable* (a failed source) was not produced
  in production — UNIT only.
- **Currency.** Each snapshot, its chart and its register row carried the
  project's own currency; AUD is shown with "$", the others with their code.
  No amount is summed across projects.

**New observation (tracker D3 #33, P3).** For about a quarter of a second
after a switch the budget card read **Working Budget — "—" — Not approved ·
Σ budget lines** for a project whose budget *is* approved, then changed to
*Approved Budget*. The value shown was "—", never a wrong number. The label
is chosen from `budgetSource.approved`, which is false until the
approved-budget pointer has loaded (`ProjectSnapshot.jsx` line 209).

**Not run.** Network throttling (the first check of §22 asks for Slow 3G);
the portfolio counts reading "—" before the first projects answer; a
`subcontractor` or `client` session (test identities deactivated; UNIT
only); the layout widths of §22 check 3; a failed source.

### 74.6 Data integrity — scope of the comparison

Read-only snapshots at 00:32–00:34 UTC and 01:05–01:08 UTC, compared with
each other and with the end state of the C1-C run.

| Scope | What was compared | Result |
|---|---|---|
| Test company `constrap-acceptance-test` | Path and `updateTime` of every document (167, recursive, invitations and audit events included) | Identical before and after. Against the C1-C end state, one difference: `system/fileLinkRevocation`, written by the reconciliation worker at 00:27:02, before this run began |
| Apex Builders | Path and `updateTime` of every document (258) | Identical before and after. Against the C1-C end state, the same single worker document (00:27:02) |
| `users` | 9 documents: `updateTime`, company, role, flags | Identical |
| Test Auth accounts (5) | Disabled flag, verification, last sign-in, `validSince` | Project Manager, QS, `subcontractor` and `client` still **disabled**. One difference: the TEST Company Admin's last sign-in, 01:02:14 — the Product Owner's sign-in for this run |
| Final Account, fixture Z | Status, revision and a SHA-256 of the fields of both revisions | Identical; revision 2 approved and current |
| Projects and directory | 8 + 8 entries: name, currency, status, `updateTime` | Identical; directory in step |
| Storage objects of the test company | 6 objects: MD5, metageneration, token presence | Identical |
| Independent financial expectations, all 8 projects | The derived figures of 74.5 | Identical |
| Monitoring | 5 alert policies, 2 channels, 1 uptime check | Each policy identical to its C1-D final state; all enabled; none created, edited or deleted |

Not compared: field contents outside the items above (update times were
compared, not bytes); root collections other than `users` and the two
companies; Apex Storage objects; Cloud Run revisions.

**Browser-isolation event.** The connected tab on
`constrapp-69b5d.web.app` opened in the Product Owner's **personal Apex
Builders session** — that origin held it, not the TEST Company Admin's. The
Dashboard rendered once, read-only (portfolio counts only were read). Nothing
was clicked and nothing was written; Apex is unchanged (above). The engineer
stopped; the Product Owner signed out there and signed in as the TEST
Company Admin; the session uid was checked in the page before any further
step. `app.constrap.com` was not opened. The testing tab was closed at the
end, and the local emulators, Vite server and throwaway browser were stopped.

### 74.7 Automated results (local, 25 November 2026)

| Suite | Command | Result |
|---|---|---|
| Unit | `npm run test:unit` | 101 files, 5,244 tests PASS |
| Rules emulator | `npm run test:rules` | 39 files, 2,492 tests PASS |
| Functions pure | `npm run functions:test` | 8 files, 179 tests PASS |
| Lint | `npm run lint` | clean |
| Production build | `vite build` to a scratch directory | succeeds; bundle hash equal to production |

The Functions emulator suite was not run: no callable is in scope.

### 74.8 Findings

| Tracker | Finding | Priority proposed at the run (decided: §74.10) |
|---|---|---|
| D3 #32 | On a cold load with the Firestore backend unreachable, the membership gate states *No active membership*; *Waiting for the server* is unreachable on a reload | P2 |
| D3 #33 | Dashboard budget card reads *Working Budget … Not approved* while the approved-budget pointer loads | P3 |
| D3 #34 | §66 E2 cannot be executed as written (an offline reload never loads the page); procedure to be rewritten with the D3 #32 correction | Test procedure |

### 74.9 Recommendation (as written at the run, before the decision — the decision is 74.10)

- **L3 Stage 2:** the nine converted writes and the project route behave as
  ADR-80 specifies in every executed step; E2 does not pass as written
  because of D3 #32, which predates L3 and carries no data risk.
  Recommended: close E1 and E3–E10 on the evidence above with its classes
  recorded, and keep E2 open against a Hosting-only correction of D3 #32.
- **GST boundary hotfix:** deployed and arithmetically verified; §44 steps
  1–3 unexecuted in production. Recommended: accept on the deployment,
  emulator and independent-arithmetic evidence, or authorise the scope in
  74.4.
- **Premium Dashboard v2:** recommended GO on §22 check 1 as far as executed;
  checks 2 and 3 remain unexecuted.

### 74.10 Architect decision (25 November 2026 — REPORTED)

**GO for documentation integration. NO-GO for full L3 closure.** Nothing was
executed for this decision, and no unexecuted test is marked passed by it.

| Subject | Decision | Still open — not passed |
|---|---|---|
| L3 E1 | Accepted — PROD-VERIFIED | — |
| L3 E3–E10 | Accepted with their actual evidence class: **local emulators only**, development build of the deployed source, Chrome 158 headless, simulated failures | Not executed in production; other browsers; the minified bundle |
| L3 E2 | **OPEN** against tracker D3 #32 | E2, after the correction and with a corrected procedure |
| GST boundary hotfix | Deployment verified; **calculation compatibility accepted** (74.4) | §44 manual steps 1–3 — outstanding, retained for the relevant financial implementation milestone |
| Premium Dashboard v2 | Deployment verified; **tested financial calculations accepted** (74.5) | §22 checks 2 and 3 |

**Defect triage.**

- **D3 #32 — P2, the next implementation task.** Correct the
  membership-state handling **without weakening authorisation**: a confirmed
  missing or inactive membership must still be refused.
- **D3 #33 — P3, deferred** UX correction.
- **D3 #34 —** the E2 procedure is corrected alongside #32.
- **No service worker and no PWA** in the upcoming correction.

**Financial precision (tracker D3 #35).** The half-cent GST rounding
discrepancy of 74.4 is kept as an explicit financial precision concern.

- What 74.4 shows is **compatibility**: the Rules pins admit exactly what the
  application computes. That is not the same as independent mathematical
  correctness — on 26,208 of 10,000,001 amounts (1,632 per $10,000) the
  application's GST is one cent below exact decimal round-half-up.
- **Governing decision:** PROJECT_DECISIONS.md → *ADR-40 / ADR-57
  Correction: GST Boundary Hotfix* (3 November 2026), *Limitations*:
  `roundMoney` is unchanged, every rule admits its output, and replacing it
  with exact decimal rounding "is a separate decision". The allowance was
  first bounded in ADR-57 (decision 4); `roundMoney` as the money convention
  dates from ADR-10.
- An **assessment of rounding semantics** is tracked before client credit
  notes and client retention are implemented.
- **No calculation and no historical financial record changes now.**
- The outstanding GST manual regression checks (§44 steps 1–3) are retained
  for the relevant financial implementation milestone.

**Order of work decided.** Each step needs its own brief.

1. D3 #32 membership reliability fix.
2. L3 E2 corrected acceptance.
3. Client credit-note architecture assessment and ADR.
4. Firestore Rules capacity assessment and any necessary capacity recovery.
   Source-file size alone does not establish deployable Rules capacity.
5. Client credit-note implementation.
6. Client retention.

Estimating, approval segregation and the remaining approved commercial
roadmap are preserved.

**Preserved as recorded:** the production / local distinction of every
result above; the data-integrity comparison limits of 74.6 (update times and
selected fields, not bytes); the browser-session event of 74.6; the retained
regression fixtures; the deactivated test identities; the restriction on
real customer external onboarding.

## 75. D3 #32 — membership resolution reliability, and the corrected E2 procedure (D3 #34) — **LIVE and CLOSED 26 November 2026** (`main` `0bdca38` (commit `893bed3`); Hosting release `edc2bf6f34568d78`, 25 November 2026 20:32:18 UTC; production verification §76)

*Heading as written before the release:* … `fix/membership-resolution-state` (25 November 2026 NZDT; local runs 03:05–03:30 UTC) — **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION**; uncommitted; automated tests PASS; local browser acceptance PASS (emulators only); NOT DEPLOYED; **L3 E2 stays OPEN**

**Evidence classes.** MEASURED — the real Web SDK against the local Firestore
emulator, in Node. UNIT — `npm run test:unit`. LOCAL — the development build
of this branch on the Auth and Firestore emulators, in a throwaway headless
Chrome 158 profile. Nothing in this section was run against production; no
production read or write was made.

### 75.1 Root cause

Three facts, in sequence:

1. `ProfileProvider` (`hooks/useProfile.jsx`) opened the `users/{uid}`
   listener without `includeMetadataChanges` and never read
   `snapshot.metadata`.
2. With the backend unreachable the SDK does not report an error and does not
   stay silent: it answers the listener **at once from its local cache**. The
   application uses the default in-memory cache, which is empty on every page
   load, so the answer is a document that "does not exist", flagged
   `fromCache: true` (measured — 75.2).
3. The provider stored that as a settled `profile: null`, so
   `profileLoading` became false, and `membershipGate` (`lib/team.js`) read a
   settled null profile as `GATE.NONE` — *No active membership*.

Two further facts were found while reproducing, both of the same kind (a
cache answer treated as a server answer):

- **A cached ACTIVE profile admitted without the server.** After a sign-out
  and a new sign-in in the same tab the SDK still holds the document and
  answers from the cache first (measured). The old provider did not read
  `fromCache`, so it would enter the shell on that answer — read from the
  code; not reproduced in a browser on `main`. Firestore Rules still decide
  every read, so no data would be shown that the server would not serve; the
  gate, however, would be decided by a cache.
- **The provider kept its last answer under the uid.** Signing out and back
  in as the same uid found the earlier confirmation still under its key.
  Found by a unit test of the correction and closed in it (75.3).

### 75.2 SDK behaviour — MEASURED (firebase 12.15.0, `@firebase/firestore` 4.16.0, document listener, through a TCP gate that makes the emulator unreachable)

| Scenario | Snapshots delivered |
|---|---|
| Document missing; backend unreachable; **no** `includeMetadataChanges` | `exists: false, fromCache: true` after 40 ms. After the backend returned: **nothing, for the 45 s observed** — the server's confirmation changes no data, so it is never delivered |
| Document missing; backend unreachable; **with** `includeMetadataChanges` | `exists: false, fromCache: true` after 25 ms; after the backend returned, a metadata-only `exists: false, fromCache: false` |
| Document active; backend unreachable; either option | `exists: false, fromCache: true` at once; after the backend returned, `exists: true, fromCache: false` |
| Confirmed online, then unreachable, deactivated on the server meanwhile, then reachable (metadata on) | `active, fromCache: false` → `active, fromCache: true` when the connection dropped → `deactivated, fromCache: false` on reconnection. Nothing while unreachable |
| Online role change, then deletion | Each delivered with `fromCache: false` |
| Read refused by the Rules | The error callback, `permission-denied`, once; no snapshot; nothing afterwards |
| Same client: confirmed, unsubscribe, sign out, sign in, listen again while unreachable | `active, fromCache: true` after 2 ms (the cache survived the sign-out); `fromCache: false` after reconnection |
| Unsubscribe while unreachable | No callback after the unsubscribe |

`hasPendingWrites` was false throughout — no client code writes `users/{uid}`
and the Rules refuse it. Reconnection took 4–20 s after the backend returned:
that is the SDK's own back-off, not an application timer.

### 75.3 The correction

**One rule: only a server-confirmed snapshot decides membership.**

- `lib/team.js → foldProfileReport` (pure). A snapshot with `fromCache` or
  `hasPendingWrites` other than exactly `false` decides nothing. Before any
  confirmation it leaves the profile null; after a confirmation it leaves the
  confirmed profile exactly as it is. A server-confirmed snapshot replaces it.
  A listener error drops the profile and records the code. State is tagged
  with the listener's key (`uid|attempt`); a report under a new key starts
  from nothing.
- `hooks/useProfile.jsx`. The listener now asks for metadata changes.
  `profileLoading` stays true until the server has answered for this uid or
  the listener has failed. Three additive context fields:
  `profileWaiting` (the SDK is answering from its cache), `profileErrorCode`
  and `retryProfile`. A callback from a replaced listener is ignored, and
  closing a listener discards what it had established.
- `lib/team.js → membershipGate`. Two new states: `WAITING`, and `REFUSED`
  (a `permission-denied` read; any other failed read stays `ERROR`).
- `components/MembershipGate.jsx`. *Waiting for the server* for `WAITING`,
  with *Sign out* and no retry control — the SDK reconnects by itself.
  *Try again* (re-opens the listener; no page reload) replaces *Reload* on
  the two failure notices.

No timer, no polling, no one-shot read, no new dependency, no persistence
change, no service worker. One listener per signed-in user, as before.

**State flow.**

| | Before | After |
|---|---|---|
| Listener has not reported | spinner | spinner |
| Cache-only answer, document missing | **No active membership** | *Waiting for the server* |
| Cache-only answer, profile active | **the application shell** | *Waiting for the server* |
| Server: active | shell | shell |
| Server: missing, or no `companyId` | No active membership | No active membership |
| Server: deactivated | deactivated notice; sign-out if the session was active | the same |
| Read refused | *Could not load your membership*, *Reload* | *Your membership could not be confirmed*, *Try again* |
| Other failed read | *Could not load your membership*, *Reload* | the same title, *Try again* |
| Confirmed, then the connection drops | shell, unchanged | shell, unchanged |

### 75.4 Membership invariants

| Invariant | Where it holds | Evidence |
|---|---|---|
| No session enters the shell before a server-confirmed active profile | `foldProfileReport`; `profile` is null unless confirmed | UNIT; LOCAL |
| A cache-only missing document is not a denial | the same | UNIT (the regression test); LOCAL |
| No profile from another uid, or from an earlier session of the same uid, grants access | key `uid|attempt`; reset on listener close; late callbacks ignored | UNIT; LOCAL |
| A cached profile never overrides a server-confirmed deactivation or absence | cache snapshots change nothing after confirmation | UNIT |
| A refused read is not an authorised state | error drops the profile; the shell unmounts | UNIT; LOCAL |
| Deactivation and assignment revocation still take effect | server snapshots always apply; the sign-out effect is unchanged | UNIT; LOCAL |
| Role changes still reach the application | the same | UNIT; LOCAL |
| A profile without a `companyId` string does not admit | `membershipGate`, unchanged | UNIT; LOCAL |
| Nobody is signed out, and no form is discarded, because the connection dropped | cache snapshots return the SAME state object: no re-render | UNIT; LOCAL |

**These are client-side presentation controls.** Firestore and Storage Rules
decide every read and write and were not changed. The gate decides only which
screen is shown.

**Superseded by the architect's correction — the gate now requires a
documented role (§75.10).** *As written at the first report:* Not changed,
and recorded as an observation: the gate does not require a
`role`. A server-confirmed profile with a `companyId` and no usable role still
enters the shell, where every role check and every Rule refuses it — as before
this branch. Tightening it is a separate decision: production profiles cannot
be inspected under this brief.

### 75.5 Automated — PASS (local, 25 November 2026)

| Suite | Command | Result |
|---|---|---|
| Unit | `npm run test:unit` | **103 files, 5,333 tests PASS after the architect corrections (§75.10)** — 89 new tests in two files. *At the first report:* 103 files, 5,315 tests PASS (was 101 / 5,244: two new files, 71 tests; one assertion in `teamSurface.test.js` updated for the gate's two added arguments) |
| Rules emulator | `npm run test:rules` | 39 files, 2,492 tests PASS (unchanged; no Rules file changed) |
| Functions emulator (team management) | `npm run test:functions` | 11 files, 367 tests PASS — invitation, acceptance, deactivation and reactivation lifecycle (no Functions file changed) |
| Functions pure | `npm run functions:test` | 8 files, 179 tests PASS |
| Lint | `npm run lint` | clean |
| Production build | `npm run build` | succeeds |
| `git diff --check` | | clean |

- `tests/unit/membershipResolution.test.js` (61). The pure fold and the gate
  decision; then the REAL `ProfileProvider` and `MembershipGate`, run by a
  small hook runtime (state, effects with clean-up, refs; optional doubled
  mount as in React Strict Mode) over a fake listener that reproduces 75.2,
  including the non-delivery of a metadata-only change to a listener opened
  without the option. Groups: A initial resolution; B metadata and
  connectivity (metadata-only confirmation, temporary unavailability,
  recovery without a reload, refused read, *Try again*, repeated
  transitions); C security and identity lifecycle (cached active then
  server deactivation, role and assignment changes, identity switch, late
  callbacks, rapid changes, same-uid re-sign-in, sign-out while pending,
  unmount, Strict Mode, invalid data, one listener); D existing workflows
  (invitation acceptance, reactivation, reconnection, the write-outcome
  helper and the three money registers untouched); source structure (no
  timer, no polling, no persistence, no service worker).
- `tests/unit/membershipGateRender.test.js` (10). The gate rendered for each
  of the seven states: the shell only when active; *No active membership*
  only on a server-confirmed absence; the waiting and failure notices; no SDK
  text.

**Regression evidence.** With `useProfile.jsx`, `MembershipGate.jsx` and
`lib/team.js` restored to `main`, the test *D3 #32 REGRESSION — a cache-only
missing profile is not "No active membership"* fails with `expected 'none'
not to be 'none'`. With the correction it passes.

**What the unit layer does not do.** It has no DOM and no Firebase. The fake
listener encodes measured behaviour; it is not the SDK.

### 75.6 Local browser acceptance — LOCAL only (25 November 2026, 03:05–03:30 UTC)

**Reproduction first, on `main`'s source (before any change).** A seeded
Company Admin, signed in, reloading a project URL with the Firestore address
blocked: **No active membership** within one sample, held for the 25 s
observed; the project appeared 4.3 s after the block was removed.

**Injection used.** *Blocked URL* — `Network.setBlockedURLs` on the emulator
address: new requests fail; **a stream that is already open is not cut**, so
this is valid for cold loads only. *TCP cut* — the application pointed at a
local TCP gate in front of the emulator; closing the gate destroys the open
sockets (4 → 0, counted) and refuses new ones. *Cut after the membership
read* — `Fetch` interception failing the request that opens the projects
listener and every later backend request. *Refused read* — an emulator-only
copy of the Rules with the `users/{uid}` read line changed, loaded through
the emulator's REST endpoint and restored; the repository file was not
edited. Server changes were written to the emulator directly.

| ID | Result | What was observed |
|---|---|---|
| E2-A, member, blocked URL | **PASS** | *Waiting for the server* on the first sample, held 20 s. Screens: spinner → waiting. Never *No active membership*. No project, company or navigation text on the page. *Sign out* shown, no *Try again* |
| E2-A, recovery | **PASS** | The project appeared 5.2 s after the block was removed. No reload, no sign-out |
| E2-A, member, TCP cut | **PASS** | The same; recovery 4.9 s and 6.2 s (two runs) |
| E2-A, repeated transitions on a cold load | **PASS** | Unreachable → reachable 1.5 s → unreachable 3 s → reachable: waiting, then the project; never a denial |
| E2-A, non-member | **PASS** | Online: *No active membership* after 0.16 s. Unreachable: *Waiting for the server*, no denial for the 8 s observed. Reachable: *No active membership* after 5.5 s — the metadata-only confirmation. The shell never rendered |
| E2-A, deactivated account | **PASS** | Unreachable: waiting. Reachable: *Your membership was deactivated* after 3.1 s |
| E2-B, cut after the membership read | **PASS** | *Loading project…*, then the project route's own *Waiting for the server* after 13.1 s. The shell stayed; no gate notice; never *Project not found*. The project appeared 1.7 s after the connection returned |
| E2-B, established session, TCP cut | **PASS** | Two disconnections of 21 s (open sockets 4 → 0): the project stayed on screen, no notice, no sign-out, same uid afterwards |
| E2-C, full offline hard reload | **Recorded — a limitation, not a pass** | The browser's own error page (`chrome-error://chromewebdata/`, `ERR_INTERNET_DISCONNECTED`). No service worker is registered. The application does not start offline |
| Role change, live | **PASS** | The sidebar role label changed within one sample; the shell stayed |
| Role change while disconnected (TCP cut) | **PASS** | Changed on the server 3 s into the cut; the old role was still shown 15 s later; the new role 11 s after reconnection |
| Deactivation, live | **PASS** | Deactivated notice, then the sign-in page within 0.1 s; no session left in the browser |
| Deactivation while disconnected (TCP cut) | **PASS** | Deactivated on the server 3 s into the cut; the session was unchanged 15 s later; signed out 16 s after reconnection |
| Refused read | **PASS** | *Your membership could not be confirmed*, *Try again*; no SDK text or code; no protected content. *Try again* while still refused: the same notice. After the Rules were restored, *Try again* showed the project in 0.1 s, without a reload |
| Profile without a `companyId` | **PASS** | *No active membership* |
| Same tab: sign out, then sign in with the backend unreachable | **PASS** | *Waiting for the server*; the shell never rendered; shell 3.0 s after the backend returned |
| Identity switch in one tab, member → non-member | **PASS** | The non-member was denied after 0.1 s; the member's shell was never shown under the new identity |
| L3 uncertain write (E5) through a TCP cut | **PASS** | *Create draft receipt* while disconnected: the amber *not confirmed as saved* message after 7.9 s; the amount kept; the shell stayed; 0 receipts on the server. Acknowledged, reconnected, submitted: exactly one draft, `CR-0001`, 100 |
| Normal online reload | **PASS** | spinner → shell. No waiting notice |
| Console, both runs | **PASS** | 0 React warnings, 0 uncaught errors, 0 unhandled rejections. SDK transport warnings while disconnected, expected |

**One observation, not a failure.** Signing out and in again **in the same
tab, online**, shows *Waiting for the server* for 22–25 ms (three runs)
before the shell: the SDK answers from its surviving cache a moment before
the server does. The statement is true for those milliseconds. Nothing in the
snapshot distinguishes "online, not yet answered" from "unreachable" on that
path, so removing the flash needs a delay — a presentation decision, not made
here. A normal page load does not show it.

**A harness note for the record.** The first run used the blocked URL for
the established-session checks; a server change arrived through the still
open stream, which is how the limit of that injection was found. Those checks
were repeated with the TCP cut. The results above are the valid ones.

### 75.7 Corrected E2 procedure (D3 #34)

§66 E2 as written — *DevTools → Offline, then reload* — never reaches the
application: the page itself cannot load. It is replaced by three checks.

- **E2-A — the application loads, Firestore is unreachable before membership
  is resolved.** Signed in on a project URL, block the Firestore host only
  (DevTools → Network request blocking → `firestore.googleapis.com`; the page
  and Auth stay reachable), then reload. Expect *Waiting for the server* from
  the membership gate; never *No active membership*; no project or company
  content. Remove the block: the project appears by itself, without a reload
  or a new sign-in, after the SDK's reconnection delay (seconds).
- **E2-B — membership confirmed, then project data unavailable.** With a
  project open, cut the connection. The page stays; nobody is signed out.
  The local run used a TCP cut. DevTools → Offline for 30 s is the proposed
  step in a real browser; whether it severs a stream that is already open
  was not verified here, so its effect is to be observed, not assumed. For the project route's own
  waiting state, the connection has to drop between the membership read and
  the projects read — reproducible only by injection (75.6); on a live
  network it is a timing window.
- **E2-C — full offline hard reload.** The browser shows its own error page.
  **Offline start-up is not supported** — there is no service worker and no
  offline-first build. This is a recorded limitation, kept as a requirement
  for a future PWA / offline-first increment. It is not to be made to pass by
  adding a service worker to this correction.

A request-blocking step in a production browser session affects only that
browser tab. It needs no change to the network or to production.

### 75.8 Not covered, and limits

- **Production.** Nothing here ran against production. The minified
  production bundle, Safari, Firefox and a real mobile network were not
  exercised.
- **App Check.** The emulator skips it. A profile read refused for a missing
  App Check token would present as the refused-read notice — not observed.
- **The company read and three list pages — now tracker D3 #36 (§75.10).**
  `CompanyProvider` has the same shape the profile
  provider had: it does not read `fromCache`. If the connection drops after
  the membership read and before the company read, the company is briefly
  taken as missing. Not exercised separately; not changed (out of scope).
  The Dashboard, Projects and Portfolio pages likewise still ignore
  `fromCache` (ADR-80, *Limits*).
- **The 22–25 ms waiting notice** on a same-tab re-sign-in (75.6) —
  **ACCEPTED by the Lead Architect (§75.10); no delay, timer or debounce is
  to be added.**
- **Every reconnection re-evaluates the profile.** The listener now delivers
  cache-state changes; they produce no re-render (the state object is kept).
- **Reconnection speed** is the SDK's back-off, 4–20 s here after a long
  outage. The waiting notice has no countdown and no retry button.
- **58 older write sites** (D3 #11) are unchanged.

### 75.9 Deployment and production verification

**Hosting only.** No Firestore Rules, Storage Rules, Functions, index,
monitoring, Auth-configuration or data change. No migration. Rollback is the
previous Hosting release.

Proposed checks after a Hosting deploy (TEST company only; no network
change, no production write):

1. Release identity: the live bundle equals a build of the released commit.
2. Normal sign-in and reload as the TEST Company Admin: the shell, no waiting
   notice.
3. E2-A with DevTools request blocking on the Firestore host: *Waiting for
   the server*, then recovery without a reload.
4. E2-B: a project open, DevTools → Offline for 30 s, then online: the page
   stays, nobody is signed out.
5. A signed-in account without membership, if one is available: *No active
   membership* online. No identity is to be reactivated for this.
6. L3 E2 can be closed by the Lead Architect on 3 and 4.

### 75.10 Architect corrections (Lead Architect, 25 November 2026 — REPORTED) — implemented 26 November 2026 NZDT; status unchanged: IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION

**Decisions.**

- The implementation is accepted in principle.
- **The 22–25 ms waiting notice is accepted.** No presentation delay, timer or
  debounce.
- The established-session connectivity behaviour is preserved.
- The local E2-A and E2-B results are accepted. E2-C stays a requirement for
  a future offline-first PWA.
- **The membership gate is to refuse a server-confirmed profile whose role is
  missing, malformed or unsupported.**
- The remaining `fromCache` handling is a separate tracked finding
  (D3 #36), not part of D3 #32.

**The membership contract.** A server-confirmed profile enters the shell only
if all three hold:

| Field | Requirement | Otherwise |
|---|---|---|
| `status` | not `'deactivated'` (absent means active — legacy profiles, as the backend and the Rules treat it) | *Your membership was deactivated* |
| `companyId` | a non-empty string | absent, null or empty: *No active membership*. Any other type: **invalid** |
| `role` | one of the six documented roles: `super_admin`, `company_admin`, `project_manager`, `qs`, `subcontractor`, `client` | **invalid** |

`status` is read first: deactivation writes `role: null` and
`companyId: null` by design, and that profile is *deactivated*, never
*invalid*.

**One role registry.** `lib/formatters.js` already held the one table naming
all six roles (the labels). It now exports `KNOWN_ROLES` and `isKnownRole`
from that table; `membershipGate` uses the predicate. No second list was
written. A unit test holds the table equal to the trusted backend's
`INTERNAL_ROLES` + `OPERATOR_ROLES` and to the enum in DATA_MODEL.md.

**`super_admin` is admitted.** The correction brief names five roles. The
sixth is a documented role (PRODUCT.md; DATA_MODEL.md; SECURITY.md →
*Documented Roles vs Enforced Roles*: "treated as an ordinary company
member"), operator-provisioned, and may exist on a production profile, which
cannot be read under this brief. Refusing it could lock a legitimate account
out. **For the architect to confirm or reverse** — one line either way.

**The invalid state.** New gate state `INVALID`: *Your membership needs
attention* — the record is incomplete or not recognised; not a connection
problem; ask the Company Admin to contact support; the page continues by
itself once the record is corrected. *Sign out* only — no *Try again* (the
listener is open and a corrected profile admits by itself). **No automatic
sign-out:** an invalid profile is a configuration fault, not a loss of
membership. The stored value is never shown.

**A fault found by the browser check and corrected.** A `companyId` that is
not a string reached `doc(db, 'companies', 42)` in `CompanyProvider`, which
sits above the gate; the SDK threw and the error boundary replaced the whole
application. Protected content was not shown, but neither was the notice.
`lib/team.js → profileCompanyId` now gives a non-empty string or null, and
`CompanyProvider` takes its target from it and from nowhere else. No other
behaviour of that provider changed; its `fromCache` handling is untouched
(D3 #36).

**Lifecycle compatibility — inspected in the source, not in production.**

| Path | What it writes | Result |
|---|---|---|
| `acceptInvitation` (internal invitation; bootstrap of a first Company Admin; operator invitation for `client` / `subcontractor`, ADR-84) | `companyId`, `role` and `status: 'active'` in one commit; the role is re-validated at acceptance | admitted |
| Reactivation (a deactivated member re-accepts) | the same write | admitted |
| `updateMemberRole` | one of the three internal roles | admitted |
| `deactivateMember` | `companyId: null`, `role: null`, `status: 'deactivated'` | *deactivated*; an admitted session is signed out, as before |
| Legacy profile (no `status`) with a documented role | — | admitted |
| A profile with a `companyId` and no documented role | written by no backend path | **invalid** |

No supported path produces an invalid profile, and no data migration is
needed by any path inspected. **Residual dependency:** a production profile
provisioned by hand before ADR-72 with a missing or misspelt role would now
see the notice instead of an application in which the Rules already refuse
it every role-gated write. Whether one exists was not checked (no production
read). The read-only `reconcile-membership.mjs` does not test roles.

**Automated — PASS (26 November 2026 NZDT).**

| Suite | Result |
|---|---|
| Unit | 103 files, **5,333** tests (89 new since `main`: `membershipResolution.test.js` 77, `membershipGateRender.test.js` 12) |
| Functions emulator (team-management lifecycle) | 11 files, 367 tests |
| Functions pure | 8 files, 179 tests |
| Rules emulator | **Not re-run** — no Rules file changed since the 39 / 2,492 run of §75.5 |
| Lint / production build / `git diff --check` | clean / succeeds / clean |

New coverage (group E of `membershipResolution.test.js`, and the render
file): each of the six roles, with and without a status; a missing, null,
empty, blank, unknown, wrong-case, padded, numeric, boolean, array and object
role, and inherited object keys (`toString`, `constructor`, `__proto__`); a
malformed `companyId` of five types; an absent `companyId` still *no
membership*; a deactivated profile never *invalid*; an unresolved or failed
read never *invalid*; the real provider and gate for every supported role and
every malformed profile, with no sign-out; a cached valid role not repairing
a server-confirmed invalid one; the five member roles in turn on one session;
server-confirmed invalidation and recovery without a reload or a new
listener; invalid then deactivated; invitation acceptance for the five roles
the backend can write; reactivation; the notice's words. **All D3 #32 tests
are kept;** three assertions were updated for the eighth gate state.

**Local browser check — LOCAL only (emulators; headless Chrome 158).**

| Check | Result |
|---|---|
| Six roles and a legacy profile without a status | **PASS** — the shell, no notice (7 of 7) |
| Role missing, null, empty, unknown, numeric; `companyId` numeric | **PASS** — the *needs attention* notice; no project, company or navigation text; still signed in (6 of 6). *The numeric `companyId` case failed on the first run with the application error screen — the fault described above — and passes after the guard* |
| Live invalidation of an admitted session | **PASS** — the notice within 0.1 s; project content gone; not signed out |
| Live recovery | **PASS** — the project back within 0.1 s with the corrected role, no reload |
| Deactivation afterwards | **PASS** — signed out |
| Console | 0 React warnings, 0 uncaught errors |

**Remaining production verification** — §75.9, plus: after the deploy, the
TEST Company Admin still enters the application (the role check on a real
profile). No invalid profile is to be created in production to test the
notice.

### 75.11 Release preflight (Lead Architect decision, 26 November 2026 NZDT — REPORTED: GO for integration, subject to this preflight) — status unchanged: IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION

**Decisions.** `super_admin` stays a recognised role, with no added
permission. Legacy profiles without a `status` are preserved. The
`CompanyProvider` guard is approved. **D3 #36 is P2 — reliability hardening
before customer onboarding;** it blocks neither this release nor the
upcoming commercial implementation. D3 #32 and D3 #34 stay pending
production verification; L3 stays open until then.

**Production membership inventory — PROD-VERIFIED, read-only (25 November
2026 20:05 UTC; project `constrapp-69b5d`).** Firestore REST `GET` of
`users`, field-masked to `companyId`, `role`, `status` and `projectIds` —
names and email addresses were not fetched — and of the `companies` document
ids. Operator credentials; no write, no `--fix`, no account change.
Aggregates only.

| Measure | Count |
|---|---|
| Membership profiles (`users` documents) | 9 |
| Company documents | 2 |
| **Admitted by the corrected gate (valid active)** | **3** — all `company_admin`; 2 and 1 per company; each names an existing company |
| …of which legacy (no `status` field) | 2 |
| Intentionally deactivated (`status: 'deactivated'`, `companyId` and `role` both null — the shape `deactivateMember` writes) | 6 |
| Unassociated (no `companyId`, not deactivated) | 0 |
| Missing, null, empty, non-string or unknown `role` on an active profile | 0 |
| Malformed `companyId` (not a string, or outside the id contract) | 0 |
| Unexpected `status` value | 0 |
| Other roles in use (`super_admin`, `project_manager`, `qs`, `subcontractor`, `client`) | 0 active |
| **Profiles newly restricted by the corrected gate** | **0** |

Both company ids, and the `companyId` on all three active profiles, meet the
id contract. **Not inventoried:** Firebase Auth accounts that have no
`users` document. They are *No active membership* before and after — the
correction changes nothing for them.

**Compatibility.** Every active production profile enters the application
under the corrected gate exactly as it does today. No migration and no
profile correction is needed.

**Defensive company-id check — a genuine gap, corrected.** The guard of
§75.10 stopped non-strings only. Measured against the SDK (`doc(db,
'companies', id)`, firebase 12.15.0):

| `companyId` string | `doc()` |
|---|---|
| `a/b`, `a//b` | **throws** — the error screen, from above the gate |
| `c1/`, `/c1` | **resolves to `companies/c1`** — a different document from the one the profile names |
| `a/b/c`, `c1/projects/p1` | **resolves to a nested document** |
| a space, leading or trailing whitespace, a tab or newline, `.`, `..`, `__x__`, non-ASCII | a reference is built; no exception |

`users/{uid}` is server-managed, so only an operator error could store such
a value, and the Rules compare the stored string exactly — the two
"different document" cases would be refused by the server, not served. The
fault was the crash and the unintended reference, not an exposure.

*Correction (two lines):* `profileCompanyId` now requires the **existing**
id contract — `ID_RE`, `^[A-Za-z0-9_-]{1,64}$`, already in `lib/team.js` and
identical to the backend's (`functions/src/lib/validation.js`, applied by
`isValidId` to every company id the callables accept). `membershipGate`
calls the same helper, so such a profile is shown *Your membership needs
attention*. Nothing new was defined, and no value that meets the contract is
affected.

**Automated — PASS.** Unit 103 files, **5,336** tests (92 new since `main`;
three added here: eighteen malformed strings through the helper, the gate,
and the real provider and gate; real id shapes still admitted; the client
and backend patterns held identical). Lint clean; production build succeeds;
`git diff --check` clean. Functions, Rules and their suites: no file changed
since the runs of §75.10 and §75.5.

**Hosting deployment — exact command.** Working directory: **`frontend/`**
(it holds `firebase.json`; there is no `.firebaserc`, so the project is
named on the command line). From the released commit on `main`:

```
cd frontend
npm ci
npm run lint && npm run test:unit && npm run build
firebase deploy --only hosting --project constrapp-69b5d
```

Hosting only — no `--only firestore:rules`, `storage` or `functions`.
Rollback: the previous release in the Firebase Hosting console. Then the
checks of §75.9 and §75.10.

## 76. D3 #32 — production verification and L3 Stage 2 closeout (26 November 2026 NZDT; 25 November 2026 20:05–20:50 UTC) — **D3 #32 CLOSED; D3 #34 CLOSED; L3 Stage 2 CLOSED within its accepted scope** (recorded on the Lead Architect's closeout instruction; awaiting the architect's review of this record)

**Evidence classes.** PROD-VERIFIED — read from production, read-only (REST
`GET`, read RPCs, public Hosting). PROD-BROWSER — the released bundle on
`constrapp-69b5d.web.app`, signed in as the TEST Company Admin, production
data. PROD-BROWSER (injected) — the same, with a transport failure injected
in the page (below). LOCAL — §75. Nothing was written to production. No
account was reactivated. No malformed profile was created.

### 76.1 Release verification — PROD-VERIFIED

| Item | Reading |
|---|---|
| Repository | `main` clean and equal to `origin/main`: `0bdca38` *Merge membership resolution reliability fix* (commit `893bed3`). The release changed no Rules, Storage Rules, Functions, `ops/`, `firebase.json` or pipeline file |
| Hosting, all three origins | `index-Cp40Ga_v.js`, SHA-256 `b9101cb1…44b5`; `index.html` and the stylesheet too — **identical to a build of `main` `0bdca38`** made to a scratch directory (with the installed dependencies, not a fresh `npm ci`). `last-modified` 25 November 2026 20:32:18 GMT |
| Hosting release | `edc2bf6f34568d78`, type DEPLOY, FINALIZED, 25 November 2026 20:32:18 UTC. The previous release is `bb562d62c119df3c` (23 November) — the rollback target |
| Firestore ruleset | `67b6425a…`, released 23 November 2026, 236,737 bytes — **byte-identical to `frontend/firestore.rules`**; the same ruleset as §74.1 |
| Storage ruleset | `2f3a4788…`, 10,323 bytes — byte-identical to `frontend/storage.rules`; the same as §74.1 |
| Functions (Cloud Run, 11 services) | Latest service update 23 November 2026 09:11 UTC; none since |
| Monitoring | 5 alert policies, all enabled, latest mutation 20 November 2026; 2 channels; 1 uptime check — as §74.6 |

**Membership preflight — repeated after the deploy (20:38 UTC).** 9 profiles:
3 admitted by the corrected gate (all `company_admin`, 2 legacy without a
`status`), 6 deactivated, none malformed, **none newly restricted** —
identical to §75.11. Firebase Auth: 9 accounts, 6 disabled, 3 enabled, and
**every enabled account has a profile** — which closes the "Auth accounts
without a `users` document were not inventoried" note of §75.11: there are
none.

### 76.2 Browser isolation

Only `constrapp-69b5d.web.app` was opened. `app.constrap.com` was not
opened. Before any application page, the session was read on
`/accept-invite` (which renders no company data): **the TEST Company Admin,
uid prefix `oOANhA`**, running `index-Cp40Ga_v.js`. No sign-in was needed;
no password or token was requested. The same uid was confirmed again at the
end. The testing tab was closed.

### 76.3 Production acceptance

**How the failure was injected.** The extension cannot drive DevTools
request blocking, so the application was loaded in a **same-origin frame**
inside the testing tab, and the frame's `fetch` and `XMLHttpRequest` were
replaced — before the application's script existed in the document
(verified: 0 scripts at the moment of patching) — so that requests to
`firestore.googleapis.com` fail as a network error while a flag is set. The
page, Firebase Auth and Hosting were untouched; nothing outside that frame
was affected; the network was not disconnected. A request counter and the
frame's resource timings prove the block (requests blocked; **no** Firestore
request completed while it was on). This is a failure injected at the
browser's request API, not on the wire: it is production evidence for the
application's behaviour, and not for any particular kind of real outage.

| Check | Result | Class | What was observed |
|---|---|---|---|
| Normal authenticated start-up | **PASS** | PROD-BROWSER | `/projects`: the shell, the TEST company, 8 projects, *Company Admin*; no membership notice |
| Existing project access | **PASS** | PROD-BROWSER | CAD fixture `V2Vj8jds7RUkBAmZ1jzm`: header and tabs. A project id of the other company: *Project not found*, as designed |
| Reload | **PASS** | PROD-BROWSER | Twice: the project again, no notice; 0 console messages of any kind |
| No unexpected membership notice | **PASS** | PROD-BROWSER | Two recorded normal loads, sampled from the first frame: spinner → shell. Never *waiting*, *needs attention* or a denial |
| **E2-A** — application loaded, Firestore unreachable before membership is resolved | **PASS** | PROD-BROWSER (injected) | spinner → **Waiting for the server** after 0.7 s, held 26 s. Never *No active membership*. No project, company or navigation text. *Sign out* shown, no *Try again*. 8 requests blocked, 0 passed, 0 Firestore resource entries |
| **E2-A** — automatic recovery | **PASS** | PROD-BROWSER (injected) | The shell 1.8 s after the block was lifted, then the project. No reload (one navigation entry), no sign-in |
| **E2-B** — established session loses connectivity | **PASS** | PROD-BROWSER (injected) | With the project open, the six open Firestore streams were aborted and new ones blocked for 30 s (3 retries refused): **no screen change at all**, the project stayed, no notice, no sign-out, same uid. A request passed 3.4 s after the block was lifted; the page was unchanged |
| **E2-B** — the project route's waiting state | **PASS** | PROD-BROWSER (injected) | Connection cut at the request that opens the projects listener, after the membership and company reads (two runs): *Loading project…*, then the project route's **Waiting for the server** after 6.0 s and 12.0 s. The shell stayed; no membership notice; no *Try again*. Released 3 s later: the project in 1.7 s, without a reload |
| **E2-C** — full offline hard reload | **Not run — limitation stands** | LOCAL (§75.6) | Not attempted in production: it needs the browser offline. `navigator.serviceWorker` registrations in production: 0. **Offline start-up is not supported;** kept for a future offline-first PWA |
| Console | **PASS** | PROD-BROWSER | No application error, no React warning, no uncaught exception, no unhandled rejection in any frame. 31 Firestore SDK transport warnings, all during the injected disconnections |

**Not exercised in production, by design or by limit.** A non-member, a
deactivated account, a refused read, an invalid profile, a role change and
an identity switch (each needs a write, a reactivation or a second account —
LOCAL evidence, §75.6 and §75.10). A real network outage. A top-level tab
(the injected checks ran in a frame). Safari, Firefox, a mobile browser. The
L3 uncertain-write path (it would write).

### 76.4 Observation recorded against D3 #36 — PROD-BROWSER

On **every** cold load of a project URL — three normal loads and the two
E2-B runs — the page shows **Project not found.** for 55–100 ms between the
membership read and the company read, then *Loading project…*, then the
project. `CompanyProvider` is still unresolved for that moment, so every
data hook is idle and the route reads an idle projects list as final. It is
the mechanism described in D3 #36, now observed. It is **not introduced by
this release** (`CompanyProvider`'s loading logic is unchanged, and the
state is not a membership notice); whether it was visible before was not
measured. No data or authorisation effect.

### 76.5 Security and data integrity — PROD-VERIFIED (read-only snapshots before the browser run, about 20:35 UTC, and after it, about 20:48 UTC)

| Scope | What was compared | Result |
|---|---|---|
| Both companies | Path and `updateTime` of every document (164 and 253 by this run's listing) | Identical before and after, except `system/fileLinkRevocation` in each — the reconciliation worker's own two-hourly write (20:42:03 UTC) |
| Since the previous run (25 November 01:08 UTC) | Any document with a later `updateTime` | Only that worker document |
| `users` | 9 documents: `updateTime` and a hash of `companyId`, `role`, `status`, `projectIds` | Identical; no membership change |
| Auth accounts | Disabled flag, last sign-in, `validSince` (9) | Identical; **6 disabled, still disabled**; no new sign-in (the existing TEST session was used) |
| Financial registers | 111 documents across budget lines, purchase orders, claims, invoices, receipts, payments, variations and final accounts | 0 changed; latest update 24 November 2026 |
| Rules, Functions, monitoring | As 76.1, read again after the run | Unchanged |

**Scope limits.** Update times and paths, not field bytes (membership fields
excepted). This run's document counts (164 / 253) are not on the same basis
as §74.6's (167 / 258) and are not compared with them; a deletion since
§74.6 would not be detected by this run — none is expected, and no document
carries a later update time. Storage objects were not listed.

### 76.6 Closure

- **D3 #32 — CLOSED.** Released, the live bundle verified, the corrected
  behaviour observed in production under injection, no account newly
  restricted.
- **D3 #34 — CLOSED.** E2 is E2-A / E2-B / E2-C; E2-A and E2-B passed in
  production; E2-C is a recorded limitation, not a check.
- **L3 Stage 2 (ADR-80) — CLOSED within its accepted scope:** E1 in
  production; E2-A and E2-B in production under in-page injection; E3–E10 on
  local emulators only (§74.10).

**Preserved, open.** E2-C — offline start-up, a future offline-first PWA
requirement. D3 #33 (P3, deferred UX). D3 #35 — the GST rounding-semantics
assessment, before client credit notes and client retention. D3 #36 (P2,
reliability hardening before customer onboarding). GST §44 manual steps 1–3
and Dashboard §22 checks 2 and 3. The 58 older write sites (D3 #11). Every
evidence limit of §74 and §75.

**Next milestone:** client credit-note architecture assessment and ADR.

## 77. Commercial Finance Phase 1 — repository assessment, Rules capacity recovery 3 (ADR-85) and the rounding assessment (D3 #35) — **LIVE — production-accepted; Phase 1 CLOSED within its accepted scope (27 November 2026; §82).** *As written:* **CF3 IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION; CF1 and CF2 ASSESSED, decisions PROPOSED (ADR-86, ADR-87, ADR-88) and awaiting the Lead Architect; CF4, CF5 and CF6 NOT STARTED** (26 November 2026 NZDT; `feature/commercial-finance-phase-1` from `main` at `8702728`, uncommitted)

Evidence class for everything in this section: **EMULATOR / local**. Nothing was
deployed; production was neither read nor written.

### 77.1 Baseline, before any change

- `main` clean and identical to `origin/main` at `8702728`.
- Unit: **103 files / 5,336 tests** passed.
- Rules (Firestore and Storage, one run): **39 files / 2,492 tests** passed.
- `firestore.rules` 236,737 bytes; `firestore.transitional.rules` 237,417;
  `firestore.m2a2-transitional.rules` 237,176. The 245,000-byte budget is
  applied to all three, so the binding headroom was **7,582 bytes**.

### 77.2 Rules capacity recovery 3 (ADR-85)

| Check | Result |
|---|---|
| `node scripts/verify-rules-helper-hoist.mjs --base 8702728` | **OK** for all three files: 55 call sites expand to the original text, compared line for line (4,232 / 4,237 / 4,238 lines) |
| `npm run rules:transitional:check` | both generated files up to date |
| `npm run test:unit` | **104 files / 5,357 tests** passed (+1 file, +21: `rulesHelperHoist.test.js`) |
| `npm run test:rules` on the hoisted files | **39 files / 2,492 tests** passed — the same count as the baseline, no test changed |
| `npm run lint` | 0 errors / 0 warnings |
| Sizes | `firestore.rules` **228,289**; transitional **228,969**; m2a2-transitional **228,728**. Binding headroom **16,031** |

**Expression-ceiling comparison.** The emulator debug log of a full rules run
was captured twice — on the `8702728` rules and on the hoisted rules — and the
"maximum of 1000 expressions" messages counted per rule:

| Rule (block) | `8702728` | hoisted |
|---|---|---|
| `variations` update | 1,688 | 1,688 |
| `progressClaims` update | 1,130 | 1,130 |
| `supplierInvoices` update | 668 | 668 |
| `rfis` update | 532 | 532 |
| `tenderPackages` update | 320 | 320 |
| `supplierCreditNotes` update | 260 | 260 |
| `variations` create | 100 | 100 |
| `progressClaims` create | 22 | 22 |
| `supplierInvoices` create | 16 | 16 |
| **Total** | **4,560** | **4,560** |

The hoist changed none of them. **The messages themselves are a finding
(tracker D3 #37):** they are present on `main`. Each belongs to a request the
suite expects to be refused, and it is refused; the suite passes. But ADR-40
D10 records "zero evaluation errors" as the regression signal, and that is no
longer the state of the ruleset: six blocks reach the 1,000-expression ceiling
on some refused requests. Whether any request that should be **allowed** is
near the ceiling is not established by this count. It bounds how the client
credit-note and retention blocks may be written (bind repeated reads once,
guard `allow update` with `resource != null`) and it is the reason source
bytes are not the capacity measure.

### 77.3 Rounding assessment (D3 #35)

- Sweep of every half-cent boundary from $0.05 to $2,000,000.00 (20,000,000
  amounts) through `roundMoney(x × 0.1)`: **419,426 one cent below exact
  half-up; none above.** 20,000,001 non-boundary and boundary cent amounts to
  $200,000.00: no deviation off a boundary. The integer form
  `floor((cents + 5) / 10)` agrees with exact half-up on every amount tested.
  This reproduces §74.4 on a wider range.
- The deviation is produced at seven call sites and nowhere else (ADR-86,
  Finding 1). Four read-time comparisons would report a one-cent difference
  on legacy boundary documents if the payable formulas changed (Finding 3).
- **No calculation changed.** GST §44 manual steps 1–3 remain NOT RUN; they are
  scheduled for the local integrated acceptance (CF6) and keep their class.

### 77.4 Not done

- No client credit-note, client retention or ledger code, Rules or tests.
- No Functions suite run (nothing under `functions/` or the calc bundles
  changed): the recorded 8 files / 179 pure and 11 files / 367 emulator tests
  stand from §75.
- No browser acceptance; no production step.
- The compiled-ruleset limit (250 KB) is not measurable locally and is
  unmeasured.

## 78. Commercial Finance Phase 1, FIRST DESIGN (Rules-paired ledger) — money precision (ADR-86), client credit notes and the invoice ledger (ADR-87), client retention (ADR-88), the D3 #37 investigation and the integrated local acceptance — **NOT INTEGRATED: Lead Architect NO-GO, 26 November 2026; enforcement replaced by ADR-89 — see §79. Kept as the record of what was built and measured; §78.2 (D3 #37) and the hoist evidence stand** (26 November 2026 NZDT; `feature/commercial-finance-phase-1` from `main` at `8702728`, uncommitted)

Evidence class for everything in this section: **EMULATOR / LOCAL**. Nothing was
deployed; production was neither read nor written; no production account was
used or reactivated. The browser run used a disposable account on the local
Auth emulator. **None of this is production acceptance.**

### 78.1 Automated results — final state of the branch

| Suite | Command | Result |
|---|---|---|
| Unit | `npm run test:unit` | **111 files / 5,789 tests** passed (baseline 103 / 5,336) |
| Rules (Firestore + Storage) | `npm run test:rules` | **40 files / 2,548 tests** passed (baseline 39 / 2,492; +56 in `clientLedger.rules.test.js`) |
| Functions, pure | `npm run functions:test` | **8 files / 179 tests** passed |
| Functions, emulator | `npm run test:functions` | **11 files / 372 tests** passed (baseline 367; +5 in `finalAccount.approve.test.js`) |
| Lint | `npm run lint`, `npm run functions:lint` | 0 errors / 0 warnings |
| Generated files | `rules:transitional:check`, `functions:calc:check`, `functions:transfer-calc:check` | all up to date (the BOQ transfer bundle is unchanged) |
| Build | `npm run build` | succeeds |
| `git diff --check` | | clean |
| Hoist equivalence (ADR-85) | `verify-rules-helper-hoist.mjs <8702728 file> <hoist-only file>` | OK × 3, 55 call sites each — run against the hoist-only rules files, which are the first of the two commits recommended in DEPLOYMENT.md |

Rules source: `firestore.rules` **243,104** bytes; `firestore.transitional.rules`
**243,784** (binding; **1,216** under the 245,000 budget);
`firestore.m2a2-transitional.rules` 243,543.

### 78.2 D3 #37 — expression headroom (method and results)

`scripts/rules-expression-headroom.mjs <source> <out> <K>` writes a copy of a
ruleset in which every `allow` statement must also evaluate K trivially-true
comparisons **after** its real condition has passed. A refused request never
reaches the padding. The emulator suite is run against the padded files (in a
copy of the tree — the padded files are never placed in the repository).

*Calibration.* A ruleset whose only rule is the padding passes with **196**
comparisons and fails with 197. (A single `&&` chain of several hundred terms
is refused at compile time, so the padding is grouped into nested helpers.)

*Existing rules (`8702728` + ADR-85 hoist), full suite, 2,492 tests:*

| K | Allowed cases that fail | Where |
|---|---|---|
| 0 | 0 | — |
| 4, 8, 12 | 0 (four tightest suites) | — |
| 16 | 3 | `variations` create with an originating RFI |
| 20 | 5 | + `supplierInvoices` claim-sourced create with a boundary retention |
| 30 | 32 | + claim-to-invoice pairing, `progressClaims` |
| 45 | 57 | same four suites |
| 60 | 137 | ten suites |
| 120 | 472 | twenty-five suites |
| 160 | 804 | thirty-five suites |

*New blocks (final rules), `clientLedger` + `clientInvoices` + `clientReceipts`
suites:* 0 failures at K = 0, 20, 40 and 60; 2 at K = 80 (a credit-note draft
edit; the stale-draft posting sequence); 43 at K = 100.

*Refused requests.* A full suite run logs 4,560 "maximum of 1000 expressions"
messages, all on refused requests in six pre-existing blocks; the count is the
same on `8702728`, after ADR-85 and on the final rules. **The new blocks log
none.**

*Reading.* No legitimate request fails today. Three pre-existing blocks run
within roughly 6–10% of the ceiling on allowed requests; the new blocks keep at
least 30% in hand. Exact expression counts are not established and are not
claimed. *Access calls:* posting an entry reads five distinct documents across
its two writes (limit 20); a draft create or edit reads two (limit 10).

### 78.3 Independent reconciliation

- `tests/unit/money.test.js` — a BigInt decimal oracle that shares no code with
  `lib/money.js`: every cent from 0.00 to 100,000.00 and a spread to
  20,000,000.00 for `gstOfCents` / `gstExact` / `toCents` / `fromCents`;
  `shareOfCents` near the 64-bit cap and beyond 2^53. The supplier-side
  `gstForLine(40.15)` is pinned at 4.01 (unchanged, deliberately).
- `tests/unit/clientLedger.test.js` — zero-tax, fully taxable and mixed-tax
  invoices; a legacy invoice whose stored line GST is one cent low (a full
  credit reverses 4.01, not 4.02); partial credits and releases in 1 / 2 / 3 /
  7 pieces summing exactly to the stored figures; credit before, after a
  partial and after a full release; full credit of a retained invoice; voids.
  **Property test:** 500 seeded random sequences of credits, releases and voids
  with retention from 0 to 100% of the subtotal; after every step every
  invariant holds, the ledger equals the oracle's sums of the applied
  documents, and the receivable basis is never negative.
- **Extended runs (temporary, not committed):** two further seeds × 30,000
  sequences — 188,352 and 187,850 applied steps (credits, releases and voids);
  5,227 and 5,328 voids refused by the invariant (legitimate); **no accepted
  allocation produced an invariant error or a negative basis**, and every
  sequence closed with credited GST equal to invoice GST and nothing held.
- `tests/unit/commercialFinanceReconciliation.test.js` — the integrated
  lifecycle (contract → invoice with a half-cent-boundary line and a GST-free
  line → 5% retention → issue → partial credit → receipt → partial release →
  second credit → final release) with every stage compared to the oracle;
  zero-value line; full credit; credit of a fully received invoice (owed to
  client); two currencies as labels, never summed; a historical invoice with
  no retention fields.
- **Two defects found by these tests and corrected before this record:** (1)
  on a mixed-tax invoice, a release followed by a credit of a GST-free line
  left retention GST held with no ex-GST retention behind it; (2) an accepted
  credit could take the receivable basis below zero on a mixed-tax invoice with
  very high retention or after a release void. Both came from letting retention
  GST follow cumulative shares of the original figures; the allocation now
  takes shares of what is **still held**, bounded by the GST **still billed**
  (ADR-88, *As implemented*). The ledger invariants in the library and the
  Rules were tightened with it.

### 78.4 Security and concurrency (emulator, real Rules)

`tests/rules/clientLedger.rules.test.js` — 56 tests, two kinds: what the app
writes (through the real transaction functions of `lib/clientLedgerActions.js`)
and what an attacker writes (direct SDK calls and hand-built batches).

| Property | Evidence |
|---|---|
| Roles | company_admin, project_manager and qs draft, post and void; subcontractor, client, another company and an unauthenticated caller read and write nothing; nothing is deleted |
| Credit-only / ledger-only | each refused without the other |
| Forged ledger | wrong totals, wrong `seq`, wrong kind, non-integer, extra key, forged stamps — 15 variants refused, the correct pair accepted |
| Reuse | an already-posted credit cannot justify a second ledger movement |
| Duplicate submission | the same draft posted three times concurrently: one success, one financial effect |
| Concurrency | two postings prepared against one state: exactly one lands; a credit and a release together: one; two full releases: one; a posting racing the invoice void: never both |
| One commit | two credits against one ledger write refused, with one or two ledger writes |
| Substitution | another invoice's ledger, another company's path — refused |
| Stale draft | refused by the application and, independently, by the Rules |
| Exact reversal | a full credit of a legacy 40.15 / 4.01 invoice posts with 4.01; 4.02 and 4.00 are refused |
| Ledger permanence | no delete, no reset, no rewind, no in-place rewrite |
| Voids | a draft voids with no ledger; a posted entry only with the ledger moved back by exactly it; a ledger cannot be moved back by a never-posted entry; posted and void entries immutable |
| Retention pins | taxable, GST-free, mixed, zero and absent retention accepted; a flat 10% on a mixed or GST-free invoice refused; out-of-range, fractional and partial field sets refused; frozen at issue |
| Releases | partial releases telescope to the stored GST; over-release, double release and a short final release refused |
| Credit × retention | before, after partial and after full release; full credit clears the retention held; held never negative; no stranded retention GST; a release cannot be voided while a later credit depends on it |
| Invoice void | allowed with no ledger or only draft entries; refused while a credit note or release is posted, for every role; allowed again once they are voided; nothing can be posted against a void invoice |

Client-only, stated in SECURITY.md → Deferred Control 49: the line array, the
proportion inside the caps, the invoice's own headers, receipts.

`tests/functions/finalAccount.approve.test.js` (+5): the callable reads the two
new registers and recomputes credited, net invoiced, retention held and
outstanding itself; draft credit notes, draft releases and a failing posted
credit note each block approval by name; a credit note posted after a draft was
prepared prevents approval.

### 78.5 Browser acceptance — LOCAL, targeted

Chrome against `npm run test:team` (Auth, Firestore and Functions emulators;
Vite on 127.0.0.1), signed in as a disposable `company_admin` created on the
Auth emulator. One project (AUD), one client contact, contract value
100,000.00.

| Step | Expected (computed independently) | Observed |
|---|---|---|
| Invoice editor: 1,000.00 GST + 40.15 GST + 500.00 GST-free; 10% helper | subtotal 1,540.15; GST 104.02 (40.15 → 4.02); billed 1,644.17; retention 154.02 + 10.40 = 164.42; receivable 1,479.75 | identical |
| Issue | row: billed 1,644.17, retention held 164.42, receivable 1,479.75 | identical |
| Credit note editor: 200.00 on line 1 | 200.00 + 20.00 = 220.00; reduces retention held 21.35; reduces receivable 198.65 | identical |
| Post credit note | Issued 1,340.15; Credited 200.00; Available to Invoice 98,659.85; contract sum 100,000.00 unchanged; retention held 143.07; receivable 1,281.10 | identical |
| Invoice Void after the posting | disabled, with the reason | disabled, with the reason |
| Release editor: 50.00 | GST 3.38; becomes receivable 53.38 | identical |
| Post release | withheld 164.42 = released 53.38 + credited 21.35 + held 89.69 | identical |
| Final Account (live view) | invoiced 1,340.15 / 1,424.17 gross; credited 200.00; client retention held 89.69; outstanding 1,334.48 | identical |
| Portfolio | Client Invoices Outstanding 1,334.48 | identical |
| Cash Flow | client retention held excluded from Forecast Cash In, stated | stated ($90, whole-unit display) |

No console error on the pages read. **Not exercised in the browser:** receipts
and the *Owed to client* presentation, a second (stale) draft and *Refresh
figures*, credit-note and release voids, the Client Receipts allocation picker,
the Reports page text, CSV and print output, PM / QS / subcontractor / client
sessions (roles are covered by the Rules suite), narrow-screen layout. The
application's native *Issue?* confirmation blocked the automation once; it was
then auto-accepted in the page.

### 78.6 GST §44 manual steps 1–3

**NOT RUN as browser-manual steps — still outstanding.** They exercise the
supplier side (purchase order → supplier invoice with a boundary retention →
releases; a cent-level claim → invoice from claim), which this phase did not
change. Their emulator equivalents ran as part of the rules suite and pass —
`retentionReleases.rules.test.js` (*GST boundary hotfix — the delta the client
actually computes is accepted, nothing else*, including the 40.15 first release
and the 10.01 follow-on) and `supplierInvoices.rules.test.js` (*accepts BOTH
boundary alternatives for 40.15*; *the claim-sourced invoice the app now builds
passes the rules*, including the 803.00 at 5% case) — and
`tests/unit/money.test.js` pins the supplier `gstForLine(40.15)` at 4.01. That
is EMULATOR evidence of an unchanged calculation; it is not the manual run.

### 78.7 Manual acceptance steps (for the production acceptance, when authorised)

A–G as recorded for the UI: (A) retention on an invoice — proportional GST and
the receivable; (B) a partial credit note; (C) a stale draft, *Refresh figures*
and a full credit; (D) a credit after receipt — *Owed to client*, never zero;
(E) a release, and a refused void of a release that receipts rely on; (F) the
refused invoice void, including the two-tab race; (G) a failed read shows
*Unavailable*. Run on the isolated acceptance company only, on new records.

## 79. Commercial Finance Phase 1 — authoritative backend correction (ADR-89): trusted callables for posting and voiding, reduced Rules, the corrected allocation rule and the completed local acceptance — **LIVE — production-accepted (27 November 2026; §82).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (26 November 2026 NZDT; `feature/commercial-finance-phase-1` from `main` at `8702728`, uncommitted)

Evidence class for everything in this section: **EMULATOR / LOCAL**. Nothing was
deployed; production was neither read nor written; no production account was
used. **None of this is production acceptance.** Supersedes §78.1, §78.4, §78.5
and §78.6; §78.2 and §78.3's method stand.

### 79.1 Automated results — final state of the branch

| Suite | Command | Result |
|---|---|---|
| Unit | `npm run test:unit` | **113 files / 5,935 tests** passed (baseline 103 / 5,336) |
| Rules (Firestore + Storage) | `npm run test:rules` | **40 files / 2,597 tests** passed (baseline 39 / 2,492; `clientLedger.rules.test.js` 105) |
| Functions, pure | `npm run functions:test` | **9 files / 241 tests** passed (baseline 8 / 179) |
| Functions, emulator | `npm run test:functions` | **12 files / 497 tests** passed (baseline 11 / 367; `clientFinance.test.js` 125, `finalAccount.approve.test.js` +5) |
| Lint | `npm run lint`, `npm run functions:lint` | 0 errors / 0 warnings |
| Generated files | `rules:transitional:check`, `functions:calc:check`, `functions:transfer-calc:check`, `functions:finance-calc:check` | all up to date (the BOQ transfer bundle is unchanged) |
| Build | `npm run build` | succeeds |
| `git diff --check` | | clean |
| Hoist equivalence (ADR-85) | prover against the hoist-only files | OK × 3, 55 call sites each |

Rules source: `firestore.rules` **235,387** bytes; `firestore.transitional.rules`
**236,067** (binding; **8,933** under the 245,000 budget);
`firestore.m2a2-transitional.rules` 235,826. Before the phase: 236,737 /
237,417 / 237,176. First design: 243,104 / 243,784 / 243,543.

Expression headroom of the reduced client rules (method §78.2):
`clientLedger` + `clientInvoices` suites pass at 60 padding comparisons, 1
failure at 100 (a retained draft-invoice edit), 63 at 140. The first design
failed at 80. A full suite run still logs 4,560 ceiling messages on refused
requests, all in the six pre-existing blocks (D3 #37, unchanged).

### 79.2 The trusted boundary (Functions emulator, `tests/functions/clientFinance.test.js`, 125 tests)

Handlers called directly with injected dependencies, and through the deployed
callable in the Functions emulator. Drafts in the suite are written by the
app's own draft functions.

| Property | Evidence |
|---|---|
| Authorisation | Unauthenticated, no membership, deactivated member, subcontractor and client refused; company_admin, project_manager and qs succeed; another company's admin gets *not found* for this project's identifiers; the kill switch refuses before anything is read |
| Input contract | Any key beyond the identifiers and a reason — an `amount`, a `subtotal`, a `companyId` — is refused; malformed identifiers; blank or over-long reason |
| Exact effects | For each of the four operations: the exact ledger document afterwards (six totals, `seq`, last entry, per-line map), the entry stamps, and exactly one audit event with the totals before and after |
| **Blocker A — line validation** | A draft whose line GST is not the derived share, whose line exceeds the invoice line, repeats or names a non-existent line, changes the tax code or variation, whose headers do not sum to its lines, whose retention split is not the derived one, or whose subtotal exceeds the invoice — refused, nothing written (entry still draft, no ledger, no audit event) |
| Untrusted draft document | Unknown key, missing key, snapshot not equal to the invoice's, malformed number, bad date, pre-set `voidReason` or `postedBy`, a line with an extra key or a description differing from the invoice's — refused |
| Stale draft | Two drafts on one ledger state: the first posts, the second is refused as figures-changed, and posts after being rebuilt |
| Source invoice | Draft, void, missing, other client, other currency refused; an invoice whose retention figures are one cent off (as the Rules' half-cent tolerance admits at a tie) refused as inconsistent |
| Caps and invariants | Over-credit across two entries; a full credit of a legacy 40.15 / 4.01 invoice reverses 4.01 exactly; retention held never negative; release above held |
| Concurrency | Two postings that cannot both fit: exactly one lands; two that can: both land, `seq` 1 and 2, exact totals; a credit and a release together; the same draft posted by two callers: one write, one audit event; a posting racing an invoice void: never both |
| **Blocker B — receipts** | A release void refused when posted receipts allocated to the invoice exceed the basis after the void; allowed when they do not; a receipt written concurrently with the void never yields "void committed and received above basis"; a receipts register over the read limit (5,000) refused by name, not truncated |
| Idempotency | All four operations: the same caller repeating gets the same answer, one ledger movement, one audit event; a different caller gets a typed refusal |
| Void ordering | A release that a later credit depends on cannot be voided until that credit is voided |
| Blast radius | Each operation writes the entry, the ledger and the audit event and no other document |

Pure tests (`functions/test/clientFinance.test.js`, 62): the input contracts
and the stored-versus-derived comparison. `tests/unit/clientFinanceBundle.test.js`
(18): the generated bundle is byte-fresh and the callable source contains no
arithmetic of its own.

### 79.3 Rules (emulator, `tests/rules/clientLedger.rules.test.js`, 105 tests)

Client paths only — the file imports no posting function. Covered: the role
and tenancy matrix for read (get and list), draft create, draft edit, draft
void and delete; every clause of the draft shape; frozen fields on edit;
**direct bypass attempts, all denied for every financial role** — draft →
posted alone, in a batch with a *correct* ledger write, and in a transaction
(the pair the first design accepted); creating an entry already posted; posted
→ void with and without the correct ledger reversal; posted → draft; any edit
of a posted or void entry; **any ledger create, update or delete, including
the exact body the backend would write**; the invoice void against a seeded
ledger (denied while credited or released, allowed at zero, a malformed ledger
fails closed); the retention pins including a 250,000,000.00 invoice and a
half-cent tie; and **the honest gaps** — a draft with nonsensical figures or
unknown fields is accepted *as a draft* (the backend, not the Rules, refuses
it at posting).

### 79.4 Independent reconciliation and the edge-case evidence

- BigInt decimal oracle sharing no code with the libraries (`money.test.js`,
  `clientLedger.test.js`, `commercialFinanceReconciliation.test.js`); the
  supplier `gstForLine(40.15)` pinned at 4.01.
- **Property test (committed, 500 seeded sequences; retention 0–100% of the
  subtotal, mixed tax codes, voids):** after every applied step — invariants
  hold; ledger totals equal the oracle's sums of the applied documents; the
  retained-share invariant computed independently from the documents; basis
  never negative; no credit raises the basis by more than one cent.
- **Extended runs (temporary, not committed), 2 seeds × 30,000 sequences:**
  217,539 and 218,308 applied steps; 10,548 and 10,861 voids refused by an
  invariant (legitimate — about one in five of these adversarial random
  voids); **0** invariant errors after an accepted allocation; **0** negative
  bases; **0** differences from the oracle; **0** basis rises above one cent;
  2 rises of exactly one cent in about 258,000 credits; every sequence closed
  with credited GST equal to invoice GST, nothing held and basis 0.
- **The mixed-tax, high-retention case** (the credit that raised the
  receivable): 1,000.00 taxable (GST 100.00) + 1,000.00 GST-free, retention
  2,000.00 (GST 100.00), basis at issue 0.00. *Before correction:* crediting
  the GST-free line raised the basis from 0.00 to 50.00. *Now:* credit B
  (1,000.00 + 0.00) → retention part 1,000.00 + 0.00, basis 0.00 → 0.00, held
  1,000.00 + 100.00; then credit A (1,000.00 + 100.00) → retention part
  1,000.00 + 100.00, basis 0.00, nothing held. In the other order: credit A
  takes 1,000.00 + 100.00, leaving 1,000.00 + 0.00 held; credit B takes
  1,000.00 + 0.00. Also tested at 50%, 91% and 100% retention, with a release
  before the credit, with release → release-void → credit, and a three-line
  invoice in all six credit orders — each table asserted literal = oracle =
  library, with the basis never rising. Finding: **incorrect semantics in the
  earlier rule, corrected** (ADR-88, *Corrections*); reconciliation had held
  throughout and was not accepted as evidence.
- **Large invoices** (the removed 20,000,000.00 limit): 250,000,000.00,
  9,999,999,999.99 and a 7,500,000,000.00 mixed-tax invoice at 91% retention;
  releases in 2, 3, 7 and 13 pieces, partial credits with releases between,
  and a final full credit — all equal the oracle.
- **Negative figures, distinguished:** the receivable *basis* is never
  negative (an error if it were — forbidden by the invariants); *remaining*
  = basis − received is legitimately negative when receipts exceed the basis,
  and is reported as **owed to the client**, never clamped and never netted
  across invoices.

### 79.5 Browser acceptance — LOCAL (Auth, Firestore and Functions emulators; disposable emulator identities)

Chrome against `npm run test:team`. Users created directly on the Auth
emulator with membership documents written to the Firestore emulator: a
`company_admin`, a `qs`, a `subcontractor`, and an admin of a second company.
Every expected figure was computed independently before the screen was read.

**Limitation that qualifies every "posted from the UI" result below (tracker
D3 #38).** The callables enforce App Check, and the dev launcher starts the
browser build with no App Check key, so out of the box the Functions emulator
refuses every callable from the browser (`app: MISSING`) and the dialog shows
*"Your session has ended…"* — a misleading message for that cause. The run
proceeded by adding, in the tab, the same unsigned emulator token the automated
harness uses. The posting path exercised is therefore the real browser code and
the real callable, with an injected test token.

| | Scenario | Result | Observed |
|---|---|---|---|
| A | Setup: AUD project, client, contract 100,000.00 | PASS | |
| B | Invoice 1,000.00 GST + 40.15 GST + 500.00 GST-free, 10% retention; issue | PASS | 1,540.15 / GST 104.02 / billed 1,644.17 / retention 154.02 + 10.40 = 164.42 / receivable 1,479.75 — editor and issued row |
| C | Credit 200.00 on line 1: draft, post (server) | PASS | 220.00; retention part 22.00, receivable part 198.00; held 142.42, receivable 1,281.75; ledger `seq` 1 (20000 / 2000 / 2000 / 200); one `client_credit_note.posted` audit event |
| D | Stale draft | PASS | Post disabled with *Refresh figures*; after refresh the post succeeded. A direct server call on another stale draft: `client-entry-figures-changed`, no ledger change, no audit event |
| E | Receipt, then a credit → owed to client | PASS | Allocation picker: *remaining $1,182.75 of $1,182.75 receivable*. After a 100.00 GST-free credit: row *Owed to client $90.00*, callout on Client Invoices and Client Receipts, every ageing bucket empty, Final Account blocker *1 over-allocated: CI-0001* |
| F | Credit-note voids | PASS | Posted void restored every figure (ledger `seq` 4 → 5, one `voided` event). Draft void: no callable, `seq` unchanged, audit count unchanged |
| G | Release 50.00; release void with dependent receipts | PASS | GST 2.98 → 52.98; withheld 164.42 = released 52.98 + credited 33.00 + held 78.44. Void **refused by the server** while a receipt depended on it; succeeded after that receipt was voided. (A second receipt of 52.98 was posted to create the dependency) |
| H | Invoice void lock | PASS | Button disabled with its reason |
| I | Direct Firestore writes with the signed-in admin's token, through the Rules | PASS | Refused (403): patching a ledger total; draft → posted; editing a posted note; creating a ledger; plus client-side void of a posted note, ledger delete, direct invoice void. Control: a draft `notes` edit with a server-time transform was accepted |
| J | Roles | PASS, one limit | QS drafted and posted. Subcontractor: *Project not found*, 403 on every read, `client-finance-forbidden` on the callable. Other company's admin: 403 on reads, 404 on the callable. Repeating a post: `alreadyApplied: true`, audit count unchanged. *Not run:* PM and client sessions; a subcontractor assigned to the project |
| K | Parity | PASS | Net issued 1,240.15, credited 300.00, retention held 78.44, outstanding 52.98, owed 0.00 agree wherever a surface shows them (Client Invoices, Client Retention, Cash Flow in whole units, Reports, Portfolio, Final Account live view) |
| L | CSV and print | PASS | Commercial Report CSV: outstanding 52.98, retention held 78.44, owed 0.00. Portfolio CSV: 52.98. Printable credit note read from the print DOM for a draft, a posted and a void note; "Tax Invoice" appears in none. *Not run:* a real print preview |
| M | GST §44 manual steps 1–3 (supplier side, unchanged code) | PARTIAL | Below |

Refusal messages as shown — stale draft: *"Another credit note or retention
release has been posted or voided on this invoice since this draft was
prepared. Re-open and save the draft to refresh its figures, then post it."*
Release void: *"Receipts are already allocated against this released
retention, so the server refused to void it. Void or re-allocate those
receipts before voiding the release."* Invoice void tooltip: *"This invoice
has a posted credit note or a posted retention release, so it cannot be
voided. Void those first."* No console error on any page read.

**GST §44 steps 1–3 — run locally; class EMULATOR, not production.**

- *Step 1 (boundary retention).* Performed. **The step as written is
  internally inconsistent:** an invoice with retention 40.15 cannot take a
  40.15 release and then a 10.01 release — after the first, *Release* is
  disabled (*All retention on this invoice has been released*). Supplementary
  check, labelled as such: on an invoice with retention 100.00, releases of
  40.15 (GST 4.01) and then 10.01 (GST 1.01) both posted. The supplier-side
  one-cent-low GST is unchanged, as intended (ADR-86).
- *Step 2 (cent-level claim).* The stored invoice raised from the claim, read
  from the emulator, carries 1.01 / 1.01 / 1.00, GST 3.02, payable 33.17 — as
  the step expects. **The preview the step describes is not observable as
  written:** the *Raise invoice from claim* dialog shows no per-line GST and
  whole-unit totals ($30 / $3 / $33); supplier-side pages display whole units.
- *Step 3 (regression).* Subcontractor reads of supplier invoices, releases,
  claims and POs refused. **Not run:** "figures unchanged for every existing
  document" (the emulator holds no prior documents); Forecast, Dashboard and
  SHIELD were not read; no client-role session.

§44's manual steps are therefore **exercised locally with the two wording
defects above recorded**; they remain NOT RUN in production.

**Other observations.** For 6–9 seconds after a full page load, `/projects`
showed *No projects yet* and a project URL *Project not found* (the known D3
#36 behaviour, slower on the emulator). Final Account readiness showed *Every
figure is a valid amount — NOT MET* on this project, which has only a working
budget (not investigated; pre-existing readiness item).

**Not exercised in a browser at all:** PM and client sessions; two-tab races
(covered by the emulator concurrency tests); failed-read states; narrow-screen
layout; a real print preview; voiding a credit note while a later release
still stands (covered by unit and Functions tests).

*Note on §78.5.* The figures recorded there (21.35 / 198.65 / 143.07 /
1,281.10; release GST 3.38) were produced by the second allocation rule,
since corrected; under the rule in force the same steps give 22.00 / 198.00 /
142.42 / 1,281.75 and 2.98, as this run observed.

### 79.6 Deployment compatibility (what was tested, and how)

| Combination | Evidence | Class |
|---|---|---|
| Obsolete client (this branch's first design: direct posting with a correct ledger write) against the final Rules | Refused — §79.3, the batch and transaction bypass tests | EMULATOR |
| Any client writing a ledger or changing a posted entry | Refused — §79.3 | EMULATOR |
| The released (`main`) build's writes against the final Rules | The full pre-existing rules suite passes unchanged (39 files / 2,492 tests are the released build's contract); the new invoice fields are optional | EMULATOR |
| The released build's writes against `firestore.transitional.rules` and the m2a2 transitional file | The transitional suites pass; both files are regenerated from the final file | EMULATOR |
| New client, callables refusing (kill switch) | Typed *temporarily unavailable*; nothing written | EMULATOR |
| New client, callable endpoint absent | Mapped to a definite *not available* message on 404 and to *uncertain* on a bare network failure (unit tests of the error mapping); **not observed against a real undeployed endpoint** | LOCAL (unit) |
| New client against the OLD (released) Rules | Not run as a suite: the new collections have no block there, so reads are refused and the pages show *Unavailable* (the pages' failed-read handling is unit-tested) | REASONED, not run |
| A browser tab left open across the release | Not simulated | NOT RUN |
| Historical records | Invoices without retention fields read as zero retention and reproduce pre-phase figures (unit tests); an approved Final Account revision of the old schema shows no false difference and still reports a later credit note (unit tests). **No production record was read** | LOCAL |

---

## 80. Commercial Finance Phase 1 — final release-readiness pass (ADR-89 final-pass amendments A1–A9): scalable receipt dependency, server-posted receipts, named void refusals, the rounding-direction correction, the supported monetary range, the App Check development correction and release compatibility — **LIVE — production-accepted (27 November 2026; §82).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (26 November 2026 NZDT; `feature/commercial-finance-phase-1` from `main` at `8702728`, uncommitted)

Evidence class throughout: **LOCAL / EMULATOR**. Nothing deployed; production
not read or written. §79 records the branch as it stood at the previous gate;
where a figure differs, this section governs.

### 80.1 Automated results — final state of the branch

| Check | Result |
|---|---|
| `npm run test:unit` | **115 files / 6,019 tests passed** |
| `npm run test:rules` (Firestore + Storage emulators) | **40 files / 2,621 tests passed** |
| `npm run functions:test` (pure) | **9 files / 249 tests passed** |
| `npm run test:functions` (Auth, Firestore, Functions emulators) | **13 files / 552 tests passed** |
| `npm run lint`, `npm run functions:lint` | clean, zero warnings |
| `rules:transitional:check`, `functions:calc:check`, `functions:transfer-calc:check`, `functions:finance-calc:check` | all up to date |
| `npm run build` | passes |
| `git diff --check` | clean |
| ADR-85 hoist prover, hoist-only copies against `8702728` | three `OK`, 55 call sites each (236,737 → 228,289; 237,417 → 228,969; 237,176 → 228,728) |

Rules source: `firestore.rules` **235,321** bytes; `firestore.transitional.rules`
**236,001** (binding; **8,999** under the 245,000 budget);
`firestore.m2a2-transitional.rules` 235,760. **Compiled size: not measurable
locally — a production release prerequisite** (a refused publish leaves the
previous ruleset active).

### 80.2 Receipt dependency and large-project evidence (Functions emulator, `tests/functions/clientReceipts.test.js` and `clientFinance.test.js`, 180 tests together)

**Measured** by a recording database proxy that lists every document each
transaction read, on a project with an empty receipt register and on the same
project with **5,200 unrelated posted receipts**:

| Operation | Documents read (empty / 5,200) | Queries | Time, one run on this machine |
|---|---|---|---|
| Post a receipt (one allocation) | 6 / 6 | 0 | 13 ms / 10 ms |
| Void a credit note | 6 / 6 | 0 | 11 ms / 8 ms |
| Void a retention release | 6 / 6 | 0 | 10 ms / 9 ms |
| Void a receipt (one allocation) | 5 / 5 | 0 | 11 ms / 10 ms |

The test asserts the two path lists are identical (caller, company, project,
the entry, the invoice, its ledger) and that no unrelated receipt is read. All
four operations succeed on the large project. The timings are emulator
figures on one machine and say nothing about production latency.

**Concurrency** (each race run with both requests in flight, and the forbidden
end state asserted whichever order the database chose):

| Race | Outcome observed | Forbidden state |
|---|---|---|
| Receipt post ∥ release void (receipt relies on the release) | Exactly one lands; the other is refused (receipt: over-allocation without acknowledgement; void: names the receipt) | Both landing |
| Amended draft receipt post ∥ release void | Either order seen across runs; never both | Both landing |
| Receipt that fits without the release ∥ release void | Both land | — |
| Receipt void ∥ release void | Receipt void lands; the release void succeeds once it is ordered after it | A void decided on a stale figure |
| Credit-note post ∥ receipt post | Credit first, receipt then refused without acknowledgement | Silent over-allocation |
| Two receipts that cannot both fit | Exactly one lands | Both without acknowledgement |
| Two receipts that fit | Both land, ledger sequence 1 and 2 | A lost update |

*Stated limits of this evidence.* Two orderings were written and asserted but
not hit in the recorded runs (credit ∥ receipt with the receipt first; the
plain receipt ∥ void race with the receipt first). Serialisation rests on
Firestore's transactions as the emulator implements them; it has not been
exercised in production.

Also covered: a stale-tab receipt after a credit note and after a release void
(refused, invoice named, nothing written; posts with the acknowledgement); a
legitimate client credit balance (acknowledged surplus → owed to client, never
clamped); legacy receipts (no ledger movement on void); both kill switches
independently; idempotent retries of both receipt operations (one movement,
one audit event); nothing written outside the receipt, the allocated ledgers
and the audit event; blocking-document identification with its fall-back
wording.

**Rules** (`tests/rules/clientReceipts.rules.test.js`, 70;
`clientLedger.rules.test.js`, 105): a client cannot post a receipt or void a
posted one, for every financial role; drafts and draft-voids still work; the
invoice-void lock reads a missing ledger total as zero and a wrong-typed one
fails closed.

### 80.3 Monetary edge cases

*The one-cent rises.* The two cases from the earlier randomised run (seed
987654321, sequences 13986 and 24918) and a minimal case (1.00 taxable,
retention 0.55 / 0.06, credit of 0.01) are reproduced as fixed tests, each with
its figures under the old rule and the new:

| | Minimal | Sequence 13986 | Sequence 24918 (after a void) |
|---|---|---|---|
| Receivable basis, old rule | 0.49 → **0.50** | 767,021,600.99 → **767,021,601.00** | 103,193.25 → **103,193.26** |
| Receivable basis, new rule | 0.49 → 0.48 | 767,021,600.99 → 767,021,600.98 | 103,193.25 → 103,193.24 |
| Credit's retention part / its GST, old → new | 0.01 / 0.01 → 0.00 / 0.00 | same | same |

Each sequence still closes exactly (credited GST = invoice GST, nothing held,
basis 0). Classification, proof and its limits: ADR-89 A5.

*Strict property runs* (basis may not rise by any amount; retention part gross
≤ credit gross for every credit), voids on, retention 0–100 %, mixed tax:

| | Seed 31415926 (tiny amounts) | Seed 27182818 (tiny amounts) | Seed 987654321 (standard) |
|---|---|---|---|
| Sequences / applied steps | 30,000 / 222,297 | 30,000 / 222,004 | 30,000 / 218,308 |
| Credits / releases | 130,750 / 46,914 | 130,500 / 46,824 | 129,209 / 46,553 |
| Any rise of the basis | 0 | 0 | 0 |
| Invariant errors, oracle mismatches, close-out failures | 0 | 0 | 0 |
| Credits where the rounding step applied | 34 | 40 | 2 |
| Voids refused of attempted (dependency order) | 8,950 of 53,583 | 8,848 of 53,528 | 10,861 of 53,407 |

The extended runs were made once and are not part of the suite; two
500-sequence strict runs (standard and tiny profiles) are. **Randomised
evidence is not proof**; the proof is the written argument in ADR-89 A5 and
`tests/unit/clientLedger.test.js`.

*Range.* `tests/unit/money.test.js`, `moneyRange.test.js`, `clientLedger.test.js`:
conversion exact for every tested amount to 10^13 (first failure at 2^45);
share arithmetic exact at 10^13–10^15 cents; the full lifecycle at
999,999,999,999.99 and one cent below, single- and mixed-tax, retention 5–100 %;
the editor accepts the maximum and refuses one cent more. Firestore's 64-bit
integer and double storage is relied on as documented behaviour, not tested.

### 80.4 App Check in local development (D3 #38)

`tests/unit/emulatorAppCheck.test.js` (12): the emulator-only provider sits
inside the emulator guard and nowhere else; reCAPTCHA Enterprise and the debug
token are never armed in emulator mode; every `onCall` has the literal
`enforceAppCheck: true` and `functions/src` has no switch that weakens it; the
launcher blanks both App Check inputs and never names the production project;
no token literal exists in the repository. **Build evidence:** a normal build
and an adversarial build with all three emulator flags forced contain neither
the provider nor its marker. **Browser (LOCAL):** with no manual step, the Team
page and an invitation arrived at the emulator as `app: VALID, auth: VALID`; a
request with a valid ID token and no App Check header was refused 401
(`app: MISSING`).

### 80.5 Browser acceptance — LOCAL (emulator launcher `npm run test:team`; disposable emulator identities; **no manual App Check token**)

Fixture created through the UI as a company admin: an AUD project, one client,
one supplier. Functions emulator log for the session: 31 callable requests
`app: VALID, auth: VALID`; 3 `app: MISSING`, all deliberate probes (80.6).

| # | Scenario | Result | Observed |
|---|---|---|---|
| A | Launcher: post a receipt, a credit note and a retention release, and void each, from the UI | **PASS** | Console banner ends *"App Check: unsigned emulator-only token."*; every request verified |
| B1 | Invoice 1,000.00 + GST; receipt 600.00 posted by the server | **PASS** | Received 600.00, Remaining 500.00, *Partly reconciled* |
| B2 | Over-allocation known when the draft is saved (600.00 against 500.00) | **PASS** | Post disabled until the acknowledgement is ticked; then posted; *Owed to client $100.00* |
| B3 | Stale request: receipt fits 390.00 when its dialog opens; a credit note (50.00 + 5.00) is posted from a second tab before the request arrives | **PASS** | Refused: *"The balance of an invoice changed since this receipt was prepared. CI-0001 has 335.00 remaining and this receipt allocates 55.00 more than that. Nothing was posted. Review the allocations, or tick the over-allocation acknowledgement to post anyway."* Draft unchanged; the checkbox appears; ticked → posted; *Owed to client $55.00* |
| B4 | Void a posted receipt with a reason | **PASS** | Void; balance restored |
| B5 | Receipt dated in the future | **PASS** | Dialog blocks posting with the reason; the server refuses a direct call (`client-receipt-future-dated`), draft unchanged |
| C1 | Void a credit note that a later release was calculated on (taxable 1,000.00 + GST-free 1,000.00, retention 100.00; credit of the whole taxable line; release 50.00) | **PASS** | *"CCN-0003 cannot be voided while CRR-0001, posted after it, still stands. Void CRR-0001 first."* Stays posted |
| C2 | Void a release that a receipt relies on (2,000.00 + GST, retention 100.00 + 10.00, full release, receipt 2,200.00) | **PASS** | Refused naming receipt CR-0006; after voiding the receipt the release void succeeds (retention held 110.00, receivable 2,090.00) |
| C3 | The same refusal from a tab whose void dialog was already open | **PASS** | *"CRR-0003 cannot be voided: receipts CR-0009 and CR-0007 have allocated 2200.00 to this invoice, more than the 2090.00 it would be owed without this release. Void or re-allocate them first."* |
| C4 | A release draft and a credit-note draft post after an unrelated receipt on the same invoice | **PASS** | No false *figures changed* message |

*How B3 was staged.* Open tabs update live, so a tab that is merely old shows
the warning before the click. To reach the server refusal the request from the
first tab was delayed seven seconds by a wrapper in the page; no application
change.

*Corrected after the run (unit-tested, not re-run in the browser):* the
single-receipt refusal in C2 read *"has allocated 2200.00 against this released
retention"* — the released retention was 110.00; it now uses the same accurate
form as C3. The acknowledgement panel said the balance *had changed* even when
the draft was knowingly saved over-allocated (B2); it now says the receipt
allocates more than the invoice is currently owed, for either reason.

*Recorded, not changed:* amounts inside server refusal messages are plain
(`2200.00`), not formatted as the rest of the page; the server accepts a
receipt dated up to one day after its own UTC date (a time-zone allowance)
while the dialog says *today or earlier*; the first console banner of the
launcher still says *"Auth is real"* (the second, correct, banner follows);
one page reload during the session could not be attributed.

### 80.6 GST §44 — corrected procedure, run LOCALLY (production acceptance remains NOT RUN and is a separate evidence class)

| Step | Expected | Observed | Result |
|---|---|---|---|
| 1a | Invoice 803.00, retention 40.15 → retention GST 4.01; one release of 40.15 → GST 4.01, payable 44.16; Release then unavailable | Editor: *Retention withheld −$44.16 (ex-GST $40.15 + GST $4.01)*, net payable 839.14. Release 40.15 / 4.01 / 44.16; the button is disabled (*All retention on this invoice has been released*) | **PASS** |
| 1b | Invoice 2,000.00, retention 100.00 (GST 10.00); releases 40.15 → 4.01, 10.01 → 1.01, 49.84 → 4.98 | Exactly those three; GST sums to 10.00; held 0.00 | **PASS** |
| 2 | Claim of three lines of 10.05: claim GST 3.02; invoice dialog line GST 1.01 / 1.01 / 1.00, GST 3.02, payable 33.17, no warning; header edit accepted; posting counts Actual once and leaves Committed unchanged | As expected, shown to the cent in both dialogs; stored totals 3.02 / 33.17 / 33.17; Budget Committed and Actual identical before and after posting, only Invoiced moved; claim leaves *Not yet invoiced* | **PASS** |
| 3a | Unchanged behaviour on ordinary figures | Whole-dollar claim 300 + 200 → GST 30.00 / 20.00, 550.00, no warning; a GST-free switch on a claim line blocks creation with the reconciliation message; external roles refused list and create on supplier invoices and retention releases; a posted invoice admits no direct edit | **PASS** |
| 3b | The listed figures identical between the released build (`main` at `8702728`) and this build on the same data | Both builds served against the same emulators and seed fixture, same user: every figure on Dashboard, Budget, Forecast, Commercial and SHIELD identical; Cash Flow identical apart from the new *client retention held* line | **PASS, with a stated limit** |

*Limit of 3b.* The seed fixture is small and whole-dollar and most compared
pages show whole dollars, so this comparison could not reveal a one-cent
difference; SHIELD shows cents and matched. The production form of 3b (a
regression fixture recorded before and after the release) remains to be run.

*Precision.* The supplier-invoice and claim dialogs, the Supplier Retention
page and every client-side page show cents. Register **tables** for supplier
invoices, progress claims, budget, supplier payments and cash flow still show
whole dollars (33.17 reads *$33*) — unchanged, pre-existing presentation.

### 80.7 Release compatibility — LOCAL

| # | State | Result | Observed |
|---|---|---|---|
| 1 | Released build (`main`) against the new callables and new Rules | **PASS** | Posting a draft receipt, voiding a posted receipt and voiding an issued invoice that carries credits: *"You do not have permission to do this. Nothing was saved."*, document unchanged. Every other page loads. It shows old-model balances for invoices with credits or releases (it does not know them) |
| 2 | Obsolete direct writes under the new Rules, with the signed-in user's own SDK session | **PASS** | Draft receipt → posted; posted receipt → void; draft credit note → posted; ledger create, update, delete: all `permission-denied`. Positive controls (a notes edit on each draft) accepted |
| 3 | Kill switches | **PASS (staged)** | Finance off: *"Posting and voiding credit notes and retention releases is temporarily unavailable. Nothing was changed."*, receipts still post. Receipts off: *"Posting and voiding client receipts is temporarily unavailable. Nothing was changed."*, credit notes still post. Both on: normal |
| 4 | App Check refusal and recovery | **PASS** | No header: HTTP 401, `app: MISSING, auth: VALID`, nothing written. In the UI: *"The server could not verify this app (App Check), so the request was refused. Nothing was changed — reload the page and try again."*; the next attempt succeeded |
| 5 | Idempotent retries | **PASS** | Replays answer `alreadyApplied: true`; ledger sequence, `receivedCents` and the audit count unchanged. A true concurrent double submit: one applied, one already applied; ledger and audit moved once |
| 6 | A tab left open | Recorded | Registers update live; an open Post dialog gained the over-allocation warning by itself |
| — | New build against the **old** Rules; new build with the callables **not deployed** | **NOT RUN in a browser** | By construction and by the rules suite: the old Rules have no block for the three new collections (reads refused → *Unavailable*, never zero); a missing callable writes nothing. The exact message for a missing endpoint was not observed |

*How 3 was staged.* The Functions emulator applies its env files over the
process environment, so a flag cannot be turned off without editing a file.
Two extra Functions emulators were run from scratch copies of the working
tree's `functions/` directory with one flag off each, against the same Auth and
Firestore emulators, and the tab's requests pointed at them. The messages are
the real code path with the flag off; the routing is test staging. A retention
release was not tried with the finance switch off (same switch, same wrapper).

Cleanup confirmed: every emulator, dev server and test tab stopped or closed;
ports free; scratch copies deleted; the working tree unchanged by the run.

---

## 81. Commercial Finance Phase 1 — final integration safeguards (ADR-89 S1–S5): exact historical receipt baseline, cutover with no dual posting path, company-scoped activation, authoritative monetary range — **INTEGRATED (`main` `9e31bb0`) and LIVE — production cutover and acceptance in §82 (27 November 2026).** *As written:* **IMPLEMENTED — PENDING INTEGRATION AND PRODUCTION VERIFICATION** (27 November 2026 NZDT; `feature/commercial-finance-phase-1` from `main` at `8702728`, uncommitted)

Evidence class: **LOCAL / EMULATOR**, except 81.2, which is a **read-only
production inventory** (aggregate counts; authorised by the Lead Architect).
Nothing deployed; production not written. §77–§80 stand as recorded; where a
statement there differs (the "lower bound" for historical receipts; receipts
enabled at release; legacy receipt voids moving no ledger), this section
governs.

### 81.1 Automated results — final state of the branch

| Check | Result |
|---|---|
| `npm run test:unit` | **116 files / 6,085 tests passed** |
| `npm run test:rules` | **40 files / 2,632 tests passed** |
| `npm run functions:test` (pure) | **9 files / 256 tests passed** |
| `npm run test:functions` (emulators) | **14 files / 616 tests passed** |
| `npm run lint`, `npm run functions:lint`, four generated-file checks, `npm run build`, `git diff --check` | clean |
| **Commit 1 tree** (`ddce71b…`, ADR-85 hoist only; built from a temporary index and exported, working tree untouched) | prover three `OK`, 55 call sites each; `rules:transitional:check`; unit **104 / 5,357**; rules **39 / 2,492** |

Rules source: `firestore.rules` **236,120** bytes; `firestore.transitional.rules`
**236,800** (binding; **8,200** under the 245,000 budget);
`firestore.m2a2-transitional.rules` 236,559. Compiled size: not measurable
locally — a production release prerequisite.

*An unexplained slow run, recorded.* In one full Functions emulator run made
overnight, two existing concurrency tests took 1,025 s and 789 s and timed
out. They passed in isolation, in a full-file run (3.5 s and 9.8 s) and in two
later full-suite runs, including the final one above. The cause was not
established (the run spanned a period in which the machine may have been
suspended); a rare contention path in the emulator is not ruled out.

### 81.2 Production inventory — READ-ONLY, aggregate (`ops/cutover/client-receipt-inventory.mjs`, 26 November 2026 10:05 UTC)

Collection-group reads through the Firestore REST API as the operator; counts
and field **names** only — no value, name, number or amount was printed or
kept.

| Quantity | Count |
|---|---|
| Companies | 2 (neither activated for client finance) |
| Client invoices | 18 — draft 3, issued 10, void 5; all in one company; AUD 17, ZAR 1 |
| Client invoices with a retention field / with retention > 0 | 0 / 0 |
| Client receipts | 12 — draft 1, **posted 9**, void 2; all in the same company |
| Receipt allocations — all statuses / on posted receipts | 11 / **9** |
| Posted receipts with no allocation | 1 |
| Most allocations on one receipt | 2 |
| **Invoices with historical (posted) allocations** | **5**, all issued; none referencing a missing invoice |
| Posted receipts already carrying `allocatedInvoiceIds` | 0 |
| Allocation amounts that are not whole cents | 0 |
| Receipt field shapes | one — the same 28 fields for every status; allocations `{allocatedAmount, clientInvoiceId, invoiceNumber}` |
| Ledgers, credit notes, retention releases, baseline markers | 0, 0, 0, 0 |

### 81.3 Historical receipt baseline and authoritative balances (Functions emulator, `tests/functions/clientReceiptBaseline.test.js`, 61 tests; historical receipts seeded in exactly the 28-field production shape)

| Required case | Result |
|---|---|
| Historical partial receipt | The remainder posts with no acknowledgement; one cent more is refused without it |
| Historical full receipt | Any new allocation needs the acknowledgement |
| Historical over-allocation | Baseline exceeds the invoice (remaining −2,100.00); refused without acknowledgement, posts with it (−2,200.00); never clamped |
| Mixed historical and new receipts | Ledger total exact against an independent sum of the posted receipts themselves (asserted in every baseline test) |
| Historical receipt void | Ledger reduced exactly once; a repeat is *already applied* and changes nothing; also on an invoice that has new receipts |
| A void that would take the figure below zero, or with no ledger | Refused, nothing written (all-or-nothing across two invoices) |
| Concurrent initialisation | Eight parallel attempts: one established, seven found it; one marker, one audit event. A receipt post, a historical void and a credit-note post at once on a fresh project: all land, each ledger baselined once. Two posts on different invoices: both land |
| Stale-tab receipt on a historical invoice; explicit surplus acknowledgement | Refused naming the invoice; posts with the acknowledgement |
| Release void where the received figure includes history | Refused or allowed correctly (four tests) |
| Missing marker inside an operation | Each of the six operations refuses (`client-receipt-baseline-missing`), nothing written |
| A tracked receipt present with no marker | Refused as inconsistent, nothing written |
| Malformed historical allocation (nine shapes) | Refused, the receipt named, nothing written — never skipped |
| A switch off; a company not activated | Refused **before** any baseline is written |
| A project with no receipts | Marker with zeros; operations proceed |
| History above one transaction's reach | 448 invoices established; 449 refused explicitly |

*Per-operation reads, measured* (identical with an empty register and with
5,200 unrelated posted receipts; no query in any operation transaction): post
receipt 7, void credit note 7, void release 7, void receipt 6 — the previous
figures plus the marker. Each call also makes one single-document transaction
that reads only the marker. *One-time baseline, measured on the emulator:* 300
historical receipts over 34 invoices — 337 documents read in one query, 36
written, 28 ms; every later call 1 read, 0 writes. Emulator figures, not
production latency.

*Monetary range (authoritative).* Invoice at 999,999,999,999.99 accepted and
one cent above refused, by the server and by the Rules; receipt at ten times
that accepted and one cent above refused, by both; nine maximum receipts
accumulate exactly and the tenth is refused; a stored ledger figure that is
negative, fractional or not a safe integer is refused on read (six shapes);
ledger integers survive a Firestore round trip as integers. The allocation
rule and its independent property tests are unchanged and pass.

*Company activation.* Rules (`tests/rules/clientLedger.rules.test.js`): with
the flag absent, `false`, `null` or a truthy non-boolean, no financial role
can create a retained invoice, edit a draft to carry retention, or create or
edit a draft credit note or release — and an unretained invoice still works;
no role can set the flag by any shape of write, nor for another company;
activation of one company does not open another; the baseline marker cannot be
read or written by any client. Backend: the four callables refuse a
non-activated company inside the transaction; a non-activated company's admin
naming an activated company's project gets *not found*; one HTTP test through
the Functions emulator. Operator script: seven tests (dry run by default,
unknown company refused, audited).

*Not proven.* The baseline against real Firestore (emulator only; production
has 9 receipts on 5 invoices). The refusal branch of a deactivation racing a
posting was written but not observed. Transaction serialisation is the
emulator's.

### 81.4 Browser acceptance — LOCAL (emulator launcher; no manual App Check token; two companies: T activated, X not activated with three historical posted receipts seeded in the 28-field shape)

| # | Scenario | Result | Observed |
|---|---|---|---|
| 1a | X: no Client Retention tab; the route opened directly | **PASS** | *"Client retention is not available yet"* with *"Client credit notes and client retention are not yet available for this company."*; no actions |
| 1b | X: invoice editor | **PASS** | No retention input or helper; totals Subtotal / GST / Invoice total only; invoices of 1,100.00 and 2,200.00 created and issued; stored retention figures 0 |
| 1c | X: invoice rows and detail | **PASS** | No *Record credit note* action |
| 1d | X: forged writes with the admin's own SDK session | **PASS** | Retained draft invoice, draft credit note, setting `clientFinanceEnabled`, reading the baseline marker: all `permission-denied`. Control: the same draft invoice with retention 0 created |
| 1e | X: forged callables | **PASS** | `postClientCreditNote`, `postClientRetentionRelease`: *"Client credit notes and retention releases are not yet available for this company. Nothing was changed."*; no marker, ledger or audit event written. (Called with a non-existent draft id) |
| 2a | X before any operation | **PASS** | Invoice 1: Received 600.00, Remaining 500.00; invoice 2 fully reconciled; no marker, no ledger |
| 2b | X: post 500.00 to invoice 1 | **PASS** | No acknowledgement asked. Marker: 3 historical posted receipts, 2 allocations, 2 invoices, 280,000 cents. Ledger 1: received 110,000, baseline 60,000. Ledger 2: received 220,000, baseline 220,000. Exactly one `client_receipt.baseline_established` audit event |
| 2c | X: over-allocation on historical invoices | **PASS, one limit** | Editor and Post dialog require the acknowledgement. Direct call without it on invoice 2 (paid only by a historical receipt): refused `client-receipt-over-allocated`, remaining 0, excess 10,000 cents, draft unchanged. With it: posted; *Owed to client $100.00* |
| 2d | X: void the historical receipt of 600.00, then replay | **PASS** | Ledger 1 received 110,000 → 50,000; baseline record still 60,000; replay *already applied*, state byte-identical |
| 2e | X: screen figures against the ledgers | **PASS** | Agree after each step |
| 3 | T: tab, retention editor, retained invoice (2,000.00 + GST, retention 100.00), credit note 200.00, release 40.00 | **PASS** | All posted; baseline marker with zeros written by the first posting; 12 of 12 callable requests `app: VALID, auth: VALID` |
| 4 | T's admin against X's data | **PASS** | Company, project, invoices, receipts, ledger, marker: `permission-denied`; `postClientReceipt` on X's project: *not found* |
| 5 | Console | **PASS** | No errors |

*Limit of 2c.* The on-screen form of the server's over-allocation refusal was
not reached in this run (the dialog disables Post without the tick); it was
observed on screen in §80.5 B3 and its text is unit-tested.

*Recorded, not changed.* A non-activated company still sees zero-value figures
and wording that mention the features (*Credited $0.00*, *Client retention
held $0.00*, *"…lines, tax codes and retention freeze"*) — figures and copy,
no action. Some refusals above are Rules *evaluation errors* rather than a
clean false (the result is the required denial). A void replayed with a
different reason answers *already void*, not *already applied*. An activated
company's admin cannot read its own baseline marker (server-only, as
designed).

### 81.5 Receipt activation gate for the cutover (ADR-89 S6) — LOCAL / EMULATOR, 27 November 2026

Added after the architect's instruction not to rely on a quiet-period
deployment. Full suites re-run on the final tree: unit **116 / 6,085**; rules
**40 / 2,632**; Functions pure **9 / 256**; Functions emulator **14 / 623**
(616 + 7); lint, functions lint and build clean. `firestore.rules` unchanged
(236,120 bytes). This supersedes the Functions emulator count in 81.1.

| Case (`tests/functions/clientReceiptBaseline.test.js`, scope `false`) | Result |
|---|---|
| Company without the receipt flag (absent, `false`, `null`, `'true'`, `1`, `{}`), with posted history and the credit-note flag set | Post, post-with-acknowledgement and void refused `client-receipt-disabled` (`unavailable`); nothing written; no marker, no ledger, no audit event |
| Scope value anything but `true` (absent, `false`, `null`, `'true'`, `1`) | Refused — fail closed |
| Activated company with one historical receipt (600.00 on an 1,100.00 invoice) | First post (500.00) establishes the baseline (1 receipt, 1 allocation, 1 invoice, 60,000 cents); ledger 110,000 = independent sum of the posted receipts; one more cent needs the acknowledgement; historical void → 50,000, repeat → 50,000; the non-activated company stays refused and untouched throughout |
| Receipt flag versus credit notes and releases | The four callables still refuse `client-finance-not-activated`; no baseline written |
| Activated company naming another company's project | Not found; nothing read or written there |
| Global receipt switch off, or the company deactivated again | Refused; no baseline |
| General availability (scope `true`) | The held-back company posts with no flag; its baseline is established then, exactly |
| Operator script `--receipts` (`tests/functions/scripts.test.js`) | Dry run by default; writes only `clientReceiptsEnabled` and one `company.client_receipts_set` event; independent of the other flag in both directions |
| Rules (`tests/rules/clientLedger.rules.test.js`) | No role can set `clientReceiptsEnabled` by any shape of write |

*Not proven.* Browser acceptance of the scoped state was not run (the refusal
shown is the existing *temporarily unavailable* message, covered in §80.5).
The gate has not run in production. The receipt company check is made by the
handler and is not repeated inside the operation's transaction.

## 82. Commercial Finance Phase 1 — production cutover and acceptance (steps 0, A–I; ADR-85 to ADR-89) — **LIVE; Phase 1 (CF1–CF6) CLOSED within its accepted scope** (Lead Architect, 27 November 2026 NZDT — REPORTED)

Production project `constrapp-69b5d`, 26 November 2026 22:00 UTC to
27 November 2026 03:20 UTC. **Every commit, merge, push, deployment and
operator script was executed by the Product Owner.** The engineer prepared the
commands and verified each step read-only (REST and `gcloud` reads, deployed
source archives, public Hosting files) and ran the browser work as the TEST
Company Admin on `constrapp-69b5d.web.app` in the isolated acceptance company
`constrap-acceptance-test`. No Apex Builders financial record was created,
posted or voided by the engineer or the Product Owner. Times are UTC.
Procedure: DEPLOYMENT.md → *Commercial Finance Phase 1 release order*.

### 82.1 Release record (as executed)

| Step | What | When (UTC) | Identifiers | Verification |
|---|---|---|---|---|
| Integration | ADR-85 hoist, then the finance work, merged | 26 Nov | `7730652`, `4a62fbe`, merge `9e31bb0` (tree `f0dff990…`); Azure `main` GREEN — REPORTED | VERIFIED in Git |
| Preflight | Read-only inventory; F2 fixture created through the released build in the acceptance company | 22:00–22:10 | Project `cZEtvoFbr5jR7umM9jeg`: CI-0001 1,000.00 + GST 100.00 = 1,100.00; CR-0001 600.00 posted (legacy 28-field shape) | Inventory and 27-group fingerprint recorded |
| A | Six new callables, all three parameters `false` | 22:30 | `post/voidClientReceipt`, `post/voidClientCreditNote`, `post/voidClientRetentionRelease`, each `-00001-*` | Source archives identical to `main`; parameters `false`; invoker as `approvefinalaccount`; refusal without App Check (401); 11 existing services unchanged |
| A (first attempt) | **Failed: *No function matches given --only filters*** — the documented filter lacked the `team:` codebase prefix | before 22:30 | — | Nothing deployed (root cause proven from `firebase-tools` 15.36.0 and local SDK discovery). Corrected commands in DEPLOYMENT.md |
| B | Restrictive Firestore Rules | 22:35:43 | Ruleset `0e228bd0-fc7e-407c-bb93-0728ba4457c0`, 236,120 bytes, byte-identical to `main` (previous `67b6425a…`, 236,737) | Publish accepted (compiled size is not exposed; no refusal); read back byte-identical |
| C | Propagation wait (10 min), then probes in project AUD-3 `sMtmXPoVRKmR8qpEqimK` | from 22:45:43 | — | 82.2 |
| D | Frozen inventory | after C | 19 invoices; 14 receipts (draft 1, posted 10, void 3); 10 posted allocations on 6 invoices; 0 ledgers, markers, credit notes, releases, activations | All stop conditions false; Apex identical to the 22:03 fingerprint |
| E | `approveFinalAccount`, then Hosting | 22:52:25; 22:52:48 | `approvefinalaccount-00004-tiv`; Hosting version `2f85dee4071c61d6` (previous `edc2bf6f34568d78`); bundle `index-BEwVCddF.js`, `index-DqWvP0JF.css` | Source identical to `main`; all 8 live Hosting files byte-identical to a build of `main`; the three origins serve the same files; no development App Check code in the live bundle |
| F1 config | Receipt switch `true`, TEST scope | 27 Nov | `f0c5f98`, merge `0f623c6` — two lines (env value and its release-safety pin) | Azure GREEN — REPORTED |
| F1 deploy | Receipt callables only | 01:08 | `postclientreceipt-00002-gic`, `voidclientreceipt-00002-wod` | Effective parameters read from the services: receipt `true`, all-companies `false`, finance `false`; 15 other services unchanged |
| F1 activation | `--receipts --enable --apply` on the TEST company | 01:20:14 | `clientReceiptsEnabled: true`; one `company.client_receipts_set` (operator) | The first verification found the flag absent (the script had not been applied); re-verified after the Product Owner applied it |
| F2 | Non-zero historical baseline in TEST | 01:22–01:23 | 82.3 | Accepted by the Lead Architect |
| F3 config / deploy | Receipts for all companies | 02:05:24 | `f7da7e2`, merge `4c54a45`; `-00003-vac`, `-00003-peb` | Effective parameters receipt `true`, all-companies `true`, finance `false`; source identical to `main`; 15 other services unchanged |
| G config / deploy | Finance switch `true` | 02:43 | `88e2f6b`, merge `c9df38b`; `postclientcreditnote-00002-yif`, `voidclientcreditnote-00002-dox`, `postclientretentionrelease-00002-mix`, `voidclientretentionrelease-00002-rob` | Source identical to `main`; effective finance switch `true` on the four; receipt callables unchanged |
| G activation | `--enable --apply` on the TEST company | 02:44:26 | `clientFinanceEnabled: true`; one `company.client_finance_set` | Apex flag absent |
| H | Consolidated production acceptance in TEST | 02:48–03:12 | 82.5–82.7 | Accepted within its tested scope |
| I | `--enable --apply` on the Apex Builders company | 03:19:15 | `clientFinanceEnabled: true`; one `company.client_finance_set` (operator, before `null`, after `true`) | 82.8 |

Hosting, Firestore Rules (`0e228bd0…`) and Storage Rules (`2f3a4788…`) did
not change after step E; the 17 services did not change after step G.

### 82.2 Steps C–E — restriction and release identity

- **Released build after the Rules (C):** *Post* on a draft receipt refused
  (*"You do not have permission to do this. Nothing was saved."*); the draft
  stayed a draft.
- **Direct writes (C, REST as the TEST Company Admin):** post a draft receipt,
  create a receipt as posted, create a ledger, create a marker — **403**.
  Void of the F2 historical receipt and a write of the activation flag were
  probed with a precondition that can never hold (`currentDocument.updateTime`
  in the year 2000), calibrated on the probe draft: a write the Rules allow →
  400 `FAILED_PRECONDITION`; a write they deny → 403. Both → **403**. Nothing
  was applied. *Lesson:* `currentDocument.exists: false` makes the Rules
  evaluate a **create**, so it cannot probe an update.
- **New build (E):** dashboard and projects load without a membership error;
  F2 figures unchanged (1,100.00 billed; 600.00 received; 500.00 remaining);
  no Client Retention tab, no credit-note action and no retention editor
  (company not activated); *Post* answered *"Posting and voiding client
  receipts is temporarily unavailable. Nothing was changed."* (callable 503,
  App Check and auth `VALID`); the probe draft was voided as a draft.
- **Hosting entry point is cached for an hour.** `index.html` is served with
  `cache-control: max-age=3600`. A browser that opened a URL in the hour
  before the release keeps the previous bundle for that URL until it expires
  or is reloaded; the first post attempt at E did exactly that and showed the
  old *"You do not have permission…"* message. Fail closed (the Rules deny the
  old path), but every browser check must first confirm the bundle name.

### 82.3 F2 — the historical baseline in production (TEST)

| Check | Expected (independent) | Observed |
|---|---|---|
| Before | CI-0001 1,100.00; CR-0001 600.00 posted; remaining 500.00; no ledger, no marker | As expected |
| Post CR-0004, 500.00 → CI-0001 | No acknowledgement needed | Posted first attempt; `overAllocationAcknowledged: false` |
| Marker | Exactly one: 1 receipt, 1 allocation, 1 invoice, `legacyCents` 60000 | As expected |
| Ledger `receivedCents` | 110000; `receiptBaseline.legacyCents` 60000 | 110000; 60000 |
| Independent sum of posted allocations to CI-0001 | 110000 | 110000; screen remaining 0.00 |
| Void historical CR-0001 (trusted backend) | Ledger 50000; remaining 600.00; provenance kept | 50000; 600.00; marker unchanged; `receiptBaseline` unchanged |
| Replay of the same void (the page's own request re-sent) | No effect | `alreadyApplied: true`; server log `replay: true, ledgerMoves: 0`; ledger update time unchanged |
| Audit since F1 | One each of `company.client_receipts_set`, `client_receipt.baseline_established`, `client_receipt.posted`, `client_receipt.voided` | Exactly those four (60 → 64) |

Apex during F2: no flag, no marker, no ledger, fingerprint unchanged, no call
to a receipt callable. **No live refusal for an Apex account was observed**
(the engineer does not use the Apex session); the scope denial rests on the
emulator tests (§81.5), the effective `CLIENT_RECEIPT_ALL_COMPANIES=false` and
the integrity evidence. The F2 fixture is now consumed and is retained as a
record (CR-0001 void, CR-0004 posted, ledger 50000).

### 82.4 F3 and G — verification

- F3: receipts available to every company by configuration. A read-only run
  of the callable's own summing function over Apex's posted receipts:
  9 receipts, 9 allocations, 5 invoices in one project — **compatible** (no
  problem, within the 448-invoice bound, safe-integer total). **Apex's baseline
  is not initialised; it will be established by its first genuine receipt
  operation.** (The same dry run reports the F2 project as *inconsistent*
  because it now holds a backend-posted receipt; the callable never re-sums a
  project that has a marker.)
- G: as in 82.1. The four services previously carried the receipt switches as
  `false` from their own deployment; the G redeploy aligned them.
  `approveFinalAccount` still carries all three as `false`; it reads none.

### 82.5 Stage H — consolidated financial acceptance (TEST; 02:48–03:12 UTC)

**Method.** Expected figures were computed **before** each operation by an
independent integer-cent calculator written from the documented rules (half-up
integer division; never the application's output), kept with the evidence
(`expected.py`, `expected2.py`; outside the repository). Every ledger was then
reconciled against the sums of its own posted entry documents by a separate
read-only script. Fixtures: project **H1** `z8ImerIFZ3VdZmjxH7Ve` ("TEST
AUD-4", contract 50,000.00) and project **H2** `CBfsKnnZBJAvzLYZOdYg` ("TEST
AUD-5", contract 10,000.00), both new; synthetic client and supplier contacts
of the acceptance company.

**Invoices as issued (all equal to the expectation).**

| Invoice | Lines (ex-GST) | GST | Retention + GST | Receivable |
|---|---|---|---|---|
| A CI-0002 | 803.00 GST | 80.30 | 40.15 + **4.02** (exact half-up boundary) | 839.13 |
| B CI-0003 | 1,000.00 GST; 1,000.00 GST-free; 10.05 GST | 101.01 (line GST 100.00 / 0 / 1.01) | 100.00 + 5.03 | 2,006.03 |
| C CI-0004 | 500.00 GST-free | 0.00 | — | 500.00 |
| D CI-0005 | 1,000.00 GST | 100.00 | — | 1,100.00 |
| E CI-0007 | 1,000.00 GST; 1,000.00 GST-free | 100.00 | 100.00 + 5.00 | 1,995.00 |
| F CI-0006 | 100.00 GST | 10.00 | — | 110.00 |
| G CI-0008 (H2) | 4,000.00 GST; 1,000.00 GST-free | 400.00 | 250.00 + 20.00 | 5,130.00 |

**Lifecycle (every amount equal to the expectation, on screen and in the ledger).**

| # | Scenario | Result |
|---|---|---|
| H1 | Receipt 839.13 → A | Posted; zero-history baseline marker for H1 |
| H2 | Partial release on A, 20.00 | GST 2.00; total 22.00 |
| H3 | Final release on A, 20.15 | GST 2.02 (remainder); nothing held; *Release* unavailable |
| H4 | Receipt against released retention, 44.17 → A | Posted; A fully reconciled |
| H5 | Receipt-dependent void restriction: void the final release | **Refused** `client-receipts-depend-on-release`: *"CRR-0002 cannot be voided: receipts CR-0006 and CR-0005 have allocated 883.30 to this invoice, more than the 861.13 it would be owed without this release."* |
| H6 | Dependency-ordered voiding | Receipt CR-0006 voided, then CRR-0002 voided; A back to 22.00 remaining |
| H7 | Partial credit on B, line 1 300.00 | GST 30.00; retention reduced 14.93 + 1.50; receivable reduced 313.57 |
| H8 | Second credit on B: GST-free 200.00 + the 10.05 line in full | GST 1.01; retention 10.45 + 0.05; receivable 200.56 |
| H9 | Release on B after two credits, 50.00 | GST 2.33 |
| H10 | Credit-note void while a later release stands (B, CCN-0002) | **Accepted** — the resulting position satisfies every invariant (82.9) |
| H11 | Stale credit draft (B): drafted at ledger seq 4, a release posted in between | Dialog blocks *Post* and offers *Refresh figures*; a direct call was refused `client-entry-figures-changed`; after refresh: retention 1.47 + 0.15, receivable 108.38 — posted |
| H12 | Receipt for B's remaining 1,646.57 | Posted; B fully reconciled |
| H13 | Full credit of a GST-free invoice (C) | 500.00 + 0.00; C fully reconciled at 0.00 |
| H14 | Credit after receipt (D, 200.00) | GST 20.00; **owed to client 220.00** |
| H15 | Over-allocation (F, 150.00 against 110.00) | Draft needs the acknowledgement; a direct post without it refused `client-receipt-over-allocated` (draft unchanged); posted with it; **owed to client 40.00** |
| H16 | Credit of E's whole taxable line, then release 50.00 | Credit 1,000.00 + 100.00, retention 50.00 + 5.00; release GST 0.00 |
| H17 | Invariant-based void refusal (E, CCN-0006) | **Refused** `client-ledger-invariant`, naming CRR-0005: *"CCN-0006 cannot be voided while CRR-0005, posted after it, still stands."* |
| H18 | Invoice void protection | *Void* disabled with the reason on every invoice carrying a posted credit or release; the direct write denied (82.6) |
| H19 | Silent clamping | None: over-receipts show as *Owed to client*, never as 0 |

**Not run:** an input-taxed line; a receipt made stale through a second tab
(the server's over-allocation refusal was proven by a direct call instead);
retention credited to zero by a final credit on a retained invoice with
releases (emulator evidence only).

**Ledger reconciliation (read-only, after the session).** All seven ledgers
equal the sums of their posted entries: credited subtotal, GST, retention and
retention GST; released retention and its GST; received.

| Invoice | Ledger (credited ex / GST / ret / ret GST / released / rel GST / received, cents) |
|---|---|
| A | 0 / 0 / 0 / 0 / 2000 / 200 / 86113 |
| B | 40000 / 4000 / 1640 / 165 / 6000 / 249 / 164657 |
| C | 50000 / 0 / 0 / 0 / 0 / 0 / 0 |
| D | 20000 / 2000 / 0 / 0 / 0 / 0 / 110000 |
| E | 100000 / 10000 / 5000 / 500 / 5000 / 0 / 0 |
| F | 0 / 0 / 0 / 0 / 0 / 0 / 15000 |
| G (H2) | 40000 / 4000 / 2000 / 200 / 14000 / 1096 / 485217 |

(A's received figure includes the 22.00 receipt CR-0010 used for the
concurrency check in 82.6.) H1 end position: net issued 4,313.05; credited 2,100.00;
available to invoice 45,686.95; received 3,757.70; outstanding 1,000.00; owed
to client 260.00; client retention held 46.66.

### 82.6 Stage H — security, concurrency, idempotency and audit

**Direct-write probes** (REST, TEST Company Admin, unappliable precondition,
calibrated: allowed → 400, denied → 403):

| Write | Result |
|---|---|
| Void, edit, or create-as-posted a client credit note | 403 |
| Void, edit, or create-as-posted a client retention release | 403 |
| Update or create an invoice ledger | 403 |
| Read or update the baseline marker | 403 |
| Set `clientFinanceEnabled` or `clientReceiptsEnabled` | 403 |
| Void a posted receipt directly | 403 |
| Void a client invoice carrying a posted credit | 403 (calibration: void of an invoice without entries → 400) |
| Edit a posted supplier invoice | 403 |

No prohibited write succeeded. **Production probes cover the Company Admin
only;** the role matrix (PM, QS, external roles) and the not-activated refusal
for credit notes and releases remain **EMULATOR / LOCAL** evidence (§79–§81)
— the test identities stay deactivated.

**Concurrency.** Three simultaneous posts of one receipt: one applied, two
`alreadyApplied`; one ledger movement; one audit event. Two server retries
(`attempts` 2) were logged across the session; no error.

**Idempotency.** Re-sending the page's own request for a release post, a
credit-note post, a release void and a credit-note void each returned
`alreadyApplied: true`, with no ledger change and no audit event.

**Audit events since the G activation:** exactly 29 — 2
`client_receipt.baseline_established` (one per new project, zero history),
8 `client_receipt.posted`, 2 `client_receipt.voided`, 7
`client_credit_note.posted`, 1 `client_credit_note.voided`, 7
`client_retention_release.posted`, 1 `client_retention_release.voided`, 1
`final_account.approved`. Drafts write no audit event. Callable logs: only
the TEST administrator; no error.

### 82.7 Stage H — Final Account, reporting and GST §44

**Final Account (H2).**

| Check | Result |
|---|---|
| Amount owed to the client blocks preparation | With a 4,900.00 receipt (owed 47.83), *No over-allocated issued client invoices* was the only requirement **NOT MET** and *Prepare* was disabled |
| No invented settlement | The receipt was voided and re-entered for 4,852.17 (valid lifecycle) |
| Revision 1 approved (callable 200) | Every figure equal to the expectation: original and final contract sum 10,000.00; invoiced 4,600.00; credited 400.00; remaining to invoice 5,400.00; approved budget 8,000.00; actual, cost to complete and final cost 0.00; variance 8,000.00; profit 10,000.00 (100%); invoiced gross 4,960.00; received 4,852.17; outstanding 0.00; client retention held 107.83; owed to client 0.00; cash received 4,852.17 |
| Genuine movement after approval | A 10.00 release (GST 0.79) posted afterwards: *"differs … in 2 figures"* — current outstanding 10.79 and retention held 97.04 shown beside the approved figures, which are unchanged |
| Historical approved revision (fixture Z `5hmVvUCoOIEPrzdeowYK`, revision 2) | No difference reported; the three new figures read *Not recorded* with the explanation; the stored revision was last written 24 November; withdrawn revision 1 unchanged |

**Reporting and output parity (H1 unless stated).**

| Surface | Result |
|---|---|
| Client Invoices, Client Receipts, Client Retention | Equal to the expectation to the cent (retention withheld 254.20, released 134.49, reduced by credits 73.05, still held 46.66) |
| Commercial Report and its CSV | Equal: cash received 3,757.70; outstanding 1,000.00; client retention held 46.66; owed to client 260.00; actual cost 3,333.15 |
| Portfolio (screen and CSV) | CSV receivables H1 1,000.00, H2 10.79, F2 600.00; fixture Z and NZD-1 equal to the figures recorded on 24–25 November |
| Cash Flow | Consistent in whole dollars (cash in 3,758; owed −260; client retention 47) |
| Dashboard | Loads without error; H1 and H2 snapshots consistent in whole dollars. It shows no client-receivable figure. **§22 checks 2 and 3 remain open** |
| Printable credit note (CCN-0001) | **Content accepted** (300.00 / 30.00 / 330.00 / retention 16.43 / receivable 313.57, disclaimer). The print dialog was stubbed: **paper layout not viewed** |
| Final Account CSV | **Not exported — untested** |

**GST §44 — corrected procedure, production (supplier side; legacy rounding
preserved).**

| Step | Expected | Observed |
|---|---|---|
| 1a | SI 803.00, retention 40.15 → retention GST **4.01**, net payable 839.14; release 40.15 → GST 4.01, 44.16; *Release* then unavailable | As expected (stored 4.01 / 839.14 / 44.16) |
| 1b | SI 2,000.00, retention 100.00 (GST 10.00); releases 40.15 → 4.01, 10.01 → 1.01, 49.84 → 4.98; sum 10.00; held 0.00 | As expected |
| 2 | Claim 3 × 10.05: claim GST 3.02; invoice line GST 1.01 / 1.01 / 1.00; payable 33.17; header edit accepted; posting leaves Actual and Remaining Committed unchanged; claim leaves *awaiting invoice* | As expected; stored to the cent; Actual 2,833 and Committed 500 before and after (whole-dollar display) |
| 3a | Whole-dollar claim 300 + 200 → GST 30.00 / 20.00, 550.00; a GST-free switch on a claim line blocked by the reconciliation guard; a posted invoice cannot be edited | As expected (the edit probe → 403) |
| 3a (external roles) | A subcontractor or client cannot read or write supplier invoices or releases | **NOT RUN in production** — the external identities stay deactivated |
| 3b | Existing figures unchanged | Fixture Z and NZD-1 equal to their recorded figures; no existing document changed (fingerprint) |

Supplier-side rounding is **not** fixed: the payable side still produces 4.01
where the receivable side produces the exact 4.02. **D3 #35 stays open.**

### 82.8 Stage I and data integrity

- **Stage I (read-only, 03:20 UTC):** Apex `clientFinanceEnabled: true`
  (03:19:15); exactly one `company.client_finance_set` on Apex (operator;
  before `null`, after `true`) — its only client-finance audit event; TEST
  still has both flags; finance switch `true` on the four callables; receipts
  open to all companies; 17 services, Hosting and both rulesets unchanged
  since G.
- **Apex records:** between the end of Stage H and the Stage I read, the only
  Apex changes in the 27 measured collection groups are the company document
  and that one audit event. No Apex user called a finance callable. No Apex
  ledger or marker exists; Apex's receipt flag is absent and not needed
  (all-companies scope). Through steps 0–H, every Apex group stayed identical
  to the 22:03 UTC pre-fixture fingerprint.
- **Fingerprint scope:** 27 collection groups by document path and update time
  (per company); counts only for the rest of the 49 groups.
- **Fixtures retained:** F2 `cZEtvoFbr5jR7umM9jeg`, AUD-3 probe project
  `sMtmXPoVRKmR8qpEqimK` (void CR-0002, CR-0003), H1 and H2 — all in the
  acceptance company.

### 82.9 Architect decision (27 November 2026 — REPORTED)

Stage H **accepted within its tested scope**; GO for Stage I (executed by the
Product Owner). **The invariant-based void policy is approved:** strict reverse
posting order is not required when the resulting position is valid; posted
amounts, tax allocations, receipt dependencies and ledger integrity are
preserved (ADR-89 → *Void policy*). Jurisdiction-specific tax compliance is
retained for Phase 3. **Phase 1 (CF1–CF6) CLOSED within its accepted scope.**

**Not passed — carried forward:** printable credit-note paper layout; the
Final Account CSV; the external-role checks of §44 step 3a; the role matrix
and the not-activated refusal in production; Dashboard §22 checks 2–3; an
input-taxed line; console capture began late in the H session (no error
shown in the interface).
