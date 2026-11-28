# ops/monitoring/phase2 — Phase 2 financial callables: alert policies and log-based metrics

**Status: PARTLY CREATED (28 November 2026, 06:18 UTC, by the Product
Owner).** In `constrapp-69b5d` there exist the four `phase2_*` log-based
metrics and two policies — `callable-error-log` (`7829793872908465132`) and
`baseline-failure` (`3721707461277719113`) — each verified read-only to equal
its file and to notify the Product Owner channel only. The other three
Stage-A policies and the two Stage-F policies do NOT exist: creation stopped
on an over-long condition display name (*API field constraints*, below).
Every creation, change or deletion below is a production cloud change that
needs the Product Owner's explicit authorisation for that sitting. The stage
at which each object is created is part of the cutover (docs/DEPLOYMENT.md →
*Phase 2 — the complete cutover*).

Conventions are those of the DC46 and L3 files one level up
(`ops/monitoring/README.md`): request bodies for `projects.alertPolicies.create`
and `projects.metrics.create` (Logging), **no recipient committed** (channels
are passed on the command line), edited from the file and re-created, never
tuned by hand in the console. `frontend/tests/unit/phase2Monitoring.test.js`
pins them: no address or channel, the exact service list (from
`functions/src/index.js`), one classification for every refusal code in
`functions/src/lib/errors.js`, and the log fields the filters read.

## What is watched

The 22 Cloud Run services of the callables the Phase 2 cutover deploys: the
14 new ones (`createvariation`, `updatevariationdraft`, `approvevariation`,
`applyvariationcommitment`, `progressclaimoperation`,
`supplierinvoiceoperation`, `suppliersettlementoperation`, `postclientrefund`,
`voidclientrefund`, `postclientreceiptapplication`,
`voidclientreceiptapplication`, `voidclientinvoice`, `contractvalueoperation`,
`estimateoperation`) and the 8 changed ones (`postclientcreditnote`,
`voidclientcreditnote`, `postclientretentionrelease`,
`voidclientretentionrelease`, `postclientreceipt`, `voidclientreceipt`,
`transferboqtobudget`, `approvefinalaccount`), region `australia-southeast1`.
A 2nd-gen function's Cloud Run service is its name in lower case (as
`approvefinalaccount` in the L3 policy). The eight team callables and the
file-link worker are not watched here (their DC46 / L3 policies are
unchanged).

## Coverage

| Condition | Signal (file) | Alert? | Create at | Why |
|---|---|---|---|---|
| Backend server failure per callable (HTTP 5xx: untyped `internal` 500, crash, 504 timeout, 503) | `run.googleapis.com/request_count`, `response_code_class="5xx"`, one series per service (`phase2-callable-server-failure.policy.json`) | **Yes**, ERROR, one incident per service | Stage F, after the switches are on | `approveFinalAccount` is excluded: the L3 policy already covers it. A switch that is OFF answers `…-disabled` with **503**, so this policy must not exist while switches are off |
| Internal error not tied to a 5xx (untyped exception, framework `Unhandled error`, memory-limit kill) | Any `severity>=ERROR` line in the containers' stdout / stderr / `varlog/system` (`phase2-callable-error-log.policy.json`) | **Yes**, ERROR, at most one notification an hour | Stage A (before the Functions deploy) | Every typed refusal is INFO, so an ERROR line is always a fault |
| Historical baseline failure | Refusal lines with a baseline code (`phase2-baseline-failure.policy.json`) | **Yes**, ERROR, rate-limited | Stage A | The project's family stays refused until reviewed |
| Unexpected financial inconsistency | Refusal lines with a ledger / figures / invariant / unsupported-record code (`phase2-financial-inconsistency.policy.json`), **except `client-ledger-invariant` from `voidClientCreditNote` / `voidClientRetentionRelease`** (M1, below) | **Yes**, ERROR, rate-limited | Stage A | Stored data does not reconcile; never a user error |
| Repeated contention, stalled or repeatedly abandoned initialisation | Counter `phase2_contention_refusals` (`…-busy`, `estimate-build-superseded`) → more than 3 per service in 10 min (`phase2-contention-refusals.metric.json`, `phase2-contention-repeated.policy.json`) | **Yes**, WARNING, threshold | Stage A | One busy refusal is ordinary; a run is not. Includes `baseline-in-progress` / `baseline-superseded` / `baseline-source-changed` (all `supplier-finance-busy`) |
| Markers left `building` (supplier baseline past its 150 s lease, estimate past 180 s) | **No log signal exists** — read-only inventory (`ops/recovery/phase2-inventory.mjs`: `serverState.supplierBaselineMarker`, `serverState.estimates.buildingExpired`) | No (scheduled check) | Run at Stages G and I, and on any contention alert | See *Gaps* |
| Repeated infrastructure failure (timeouts, `DEADLINE_EXCEEDED`, `UNAVAILABLE`, `RESOURCE_EXHAUSTED`) | Counter `phase2_infrastructure_failures` (request log status 504, or a `call failed` stack naming one of those) → more than 2 per service in 15 min (`phase2-infrastructure-failures.metric.json`, `phase2-infrastructure-repeated.policy.json`) | **Yes**, ERROR, threshold | Stage A | Single ones are already raised by the two policies above |
| Abuse / client loop (one member hammering an operation) | `request_count`, all classes, more than 300 per service in 10 min (`phase2-request-surge.policy.json`) | **Yes**, WARNING | Stage F | No per-user rate limit exists; this is the detection |
| Ordinary business refusals (validation, permission, stale, cap exceeded, segregation, dependency, id conflict) | Counter `phase2_refusals_by_code`, labelled with the code only (`phase2-refusals-by-code.metric.json`) | **No** | Stage A | Dashboards and verification only |
| Company not activated, switch off | Same counter | **No** | — | Expected for every inactive company and while a brake is pulled |
| Baselines established | Counter `phase2_baselines_established` (`phase2-baselines-established.metric.json`) | **No** | Stage A | Verification at G and I |

Every refusal code is in exactly one class in `phase2-refusal-codes.json`:
**alerting** — `baselineFailure` (5 codes), `financialInconsistency` (10),
`contention` (7, threshold only); **never alerting** — `switchOff` (8),
`notActivated` (2: `commercial-completion-not-activated`,
`client-finance-not-activated`), `businessRefusal` (70, including
`approval-segregation-required`, `supplier-finance-cap-exceeded`,
`…-stale`, `…-forbidden`, `invalid-argument`, `unauthenticated`) and
`teamOnly` (22). The test fails if `errors.js` gains a code that is not
classified, or if a non-alerting code appears in an alerting filter.

## The log fields the filters rely on

Read from `functions/src/index.js` and the handlers, and from
`firebase-functions/lib/logger` (the version in `functions/node_modules`).
Cloud Run turns each JSON line on stdout / stderr into `jsonPayload`.

| Line (exact `jsonPayload.message`) | Severity, stream | Fields | Written by |
|---|---|---|---|
| `variation call refused`, `supplier-finance call refused`, `client finance call refused`, `contract-value call refused`, `estimate call refused`, `boq transfer call refused`, `final account call refused` | INFO, stdout | `code` (= `details.code`), `uid`, and `fn` for the variation, supplier-finance and client-finance families | every typed refusal (each wrapper in `index.js`) |
| begins `Error: <family> call failed` — **the logger replaces an ERROR message with the stack of a new Error, and that also overwrites the `message` field the wrapper passes** | ERROR, stderr | `stack` (the original error, e.g. `4 DEADLINE_EXCEEDED: …`), `uid`, `fn` where the family has it | every untyped exception |
| `Unhandled error …` | ERROR, stderr | — | firebase-functions, for the same exception |
| `<family> request aborted by contention` (variation, supplier-finance, client finance), `boq transfer aborted by contention`, `final account approval aborted by contention` | WARNING, stdout | `attempts`, `uid`, `projectId`, `op` | before a `…-busy` caused by contention (not for estimating) |
| `supplier-finance baseline`, `client receipt baseline established` | INFO, stdout | counts (the receipt line also carries `legacyCents`; nothing here reads it) | a baseline's completion |
| Cloud Run request log `run.googleapis.com/requests` | by status | `httpRequest.status` | the platform |
| `Memory limit of … exceeded` | ERROR, `run.googleapis.com/varlog/system` | text | the platform |

The filters read only `resource.*`, `log_id`, `severity`, `httpRequest.status`,
`jsonPayload.message`, `jsonPayload.code` and (for transport errors) a
substring of `jsonPayload.stack`. The one label extracted is `code`. **No
filter, label or notification reads a uid, a project or document id, an
amount, a payload or a credential**, and a notification never contains the
log line.

## Gaps — log lines that do not exist (reported, not changed)

1. **`details.reason` is not logged.** `supplier-finance-busy` carries
   `baseline-in-progress`, `baseline-superseded` or `baseline-source-changed`;
   `supplier-finance-baseline-invalid` carries `missing` / `incomplete`;
   `client-ledger-invariant` carries the invariant — none of it reaches the
   refusal line. Stalled or abandoned initialisation therefore cannot be told
   from contention by a log filter: the contention policy counts them
   together, and the WARNING `aborted by contention` line (present only for
   contention) is the tell-tale. *Recommended:* add `reason:
   err.details.reason ?? null` to the seven refusal log calls in `index.js`.
2. **No project id on a refusal or failure line** (only `uid`, `fn`, `code`).
   Triage needs the user or the request time. *Recommended:* the validated
   `projectId` (an id, never a figure).
3. **No line when a supplier baseline run starts, is released after a
   source change, or loses its lease** — only its completion is logged. A
   marker left `building` is visible only to the inventory.
4. **Estimating** writes no contention line, and an abandoned build writes
   nothing (ADR-97: the audit event is at completion).
5. **`contractValueOperation` with its switch off** answers
   `contract-value-invalid` (HTTP 400) with a custom message, not a
   `…-disabled` code, so "switched off" and "invalid request" look the same in
   the logs.
6. The supplier-finance, estimate and contract-value refusal lines do not
   carry the `operation` discriminator (their success lines do).
7. App Check and missing-token refusals happen before the handler: only the
   request log (401) records them.
8. The Phase 1 line `client receipt baseline established` logs a cents total
   (`legacyCents`). It is live code; nothing here reads the field.
   *Recommended:* drop the figure from the log line.

## M1 — the approved void refusal is not paged (28 November 2026)

`client-ledger-invariant` is ambiguous: genuine ledger problems raise it, and
so does the LIVE Phase 1 void of a posted client credit note or retention
release when the void would breach an invariant — the approved ADR-89 *Void
policy* refusal, an ordinary user outcome (production: once in 30 days,
2026-11-27T02:58:50Z, `voidclientcreditnote`, the Phase 1 Stage H probe). The
refusal line carries `fn`, not the reason. The financial-inconsistency filter
therefore ends:

    … AND (jsonPayload.code=(<the nine other codes>)
           OR (jsonPayload.code="client-ledger-invariant"
               AND NOT jsonPayload.fn=("voidClientCreditNote" OR "voidClientRetentionRelease")))

Only that (code, `fn`) pair is excluded. The code stays in the
`financialInconsistency` class, in the logs and in `phase2_refusals_by_code`;
every other policy and metric is unchanged. **Gap (accepted):** a genuinely
malformed client invoice ledger first met by one of those two voids does not
page; it pages on the next posting, receipt void, refund or application on
that invoice. Splitting the code into a business and a data refusal is Phase 3.
`client-entry-invalid` can also be reached by a user (a stale-tab void of a
receipt that is no longer a draft); 0 occurrences in 30 days — watched, not
excluded.

Validated read-only against production (Logging `entries:list`, every page
read): the revised filter is accepted and matches 0 entries in 30 days; the
previous filter matched the probe; the revised filter with the exclusion
pointed at a non-existent function matches it again; `NOT jsonPayload.fn=(…)`
keeps entries with no `fn`. `phase2Monitoring.test.js` pins the clause.

## API field constraints (28 November 2026)

`alertPolicies.create` refused `phase2-financial-inconsistency.policy.json`
with `INVALID_ARGUMENT: display_name must not be more than 100 characters`.
The field was the CONDITION display name (118 characters after the M1
wording was added). **This limit is enforced by the service and is not in the
published v3 reference**, which states 512 characters for the policy name
only; it is recorded here as observed. `phase2-infrastructure-repeated` (116)
had the same defect. Both names were shortened — nothing else in either file
changed; the filters, thresholds, aggregations, labels, documentation and the
M1 exclusion are byte-identical.

`frontend/tests/unit/phase2Monitoring.test.js` → *API field constraints* now
checks every policy and metric file against: policy and condition display
names ≤ 100; 1–6 conditions of one supported type with exactly the expected
fields; combiner, severity, comparison (GT / LT only), aligner and reducer
values; `userLabels` (≤ 64, key and value ≤ 63, lowercase letters, digits,
`_`, `-`, key starts with a letter); documentation (markdown, content ≤ 8,192
characters and ≤ 10,240 bytes, subject ≤ 255 bytes); a notification rate
limit on every log-match policy and on no other; `autoClose`; threshold
filter ≤ 2,048 characters naming the metric and resource type; duration and
alignment period in whole minutes (alignment 60 s – 25 h); metric identifier
≤ 100 characters from the permitted set; metric description ≤ 8,000 and
filter ≤ 20,000 characters; a DELTA / INT64 / unit `1` descriptor sending no
output-only field; every descriptor label matched by an extractor.

**What that proves and what it does not.** It is schema validation of the
request bodies. Read-only validation against the live services was also run
(every log filter through `entries.list`; every threshold filter with its
aggregation through `timeSeries.list`; the two created policies and four
created metrics compared with their files). **Neither API offers a
validate-only create**, so acceptance of the five policies not yet created is
NOT proven — the service may enforce further limits it does not publish, as
it did here. Only creation proves it; a refusal stops the sitting.

**Resuming after the partial creation:** keep the four metrics and the two
policies; create only `financial-inconsistency`, `contention-repeated` and
`infrastructure-repeated` (the loop under *Creation* would duplicate the two
existing policies — display names are not unique keys — so it is not re-run
as written).

## Notification channel (verified read-only, 28 November 2026)

`13613525651613947442` — e-mail, *DC46 - Product Owner*, enabled, created
16 November 2026, used by every DC46 and L3 policy; its address is the Product
Owner's account address (compared, never printed). `3870502445512488908` is
*DC46 - Billing Administrator* and is not used here. E-mail channels report no
verification status: **the Product Owner confirms ownership and intended
delivery before Block 3.** The id is passed on the command line, never
committed in a policy file.

## Creation (authorised sittings only)

Read-only checks first, from the repository root, with your own login:

    # each log filter returns entries or nothing — never an error
    gcloud logging read "$(jq -r '.conditions[0].conditionMatchedLog.filter // .filter' ops/monitoring/phase2/<file>)" \
      --project constrapp-69b5d --freshness 7d --limit 3 --format 'value(timestamp,resource.labels.service_name,jsonPayload.code)'

    # each Monitoring filter is accepted by timeSeries.list (read only), as for L3
    curl -s -G -H "Authorization: Bearer $(gcloud auth print-access-token)" \
      'https://monitoring.googleapis.com/v3/projects/constrapp-69b5d/timeSeries' \
      --data-urlencode "filter=$(jq -r '.conditions[0].conditionThreshold.filter' ops/monitoring/phase2/phase2-callable-server-failure.policy.json)" \
      --data-urlencode 'interval.startTime=2026-11-28T00:00:00Z' --data-urlencode "interval.endTime=$(date -u +%FT%TZ)" \
      --data-urlencode 'view=HEADERS' | head -c 400

A filter error (`INVALID_ARGUMENT`) stops the sitting; correct the file, rerun
the unit test, never edit in the console. Then, **Stage A** (four metrics
before the policies that read them; `<channels>` = the existing Product Owner
channel id, outside Git):

    for m in contention-refusals infrastructure-failures refusals-by-code baselines-established; do
      gcloud logging metrics create "phase2_${m//-/_}" --project constrapp-69b5d \
        --config-from-file "ops/monitoring/phase2/phase2-${m}.metric.json"
    done
    # Gate: the two threshold policies read user metrics. Do not assume a fixed
    # delay — wait until Monitoring knows BOTH metric types (timeSeries.list
    # answers NOT_FOUND until then; it did at Stage A, before creation):
    for t in phase2_contention_refusals phase2_infrastructure_failures; do
      until curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
          "https://monitoring.googleapis.com/v3/projects/constrapp-69b5d/metricDescriptors/logging.googleapis.com/user/${t}" \
          | grep -q '"type": "logging.googleapis.com/user/'"${t}"'"'; do sleep 30; done
      echo "metric ${t} available"
    done
    for p in callable-error-log baseline-failure financial-inconsistency contention-repeated infrastructure-repeated; do
      gcloud monitoring policies create --project constrapp-69b5d \
        --policy-from-file "ops/monitoring/phase2/phase2-${p}.policy.json" --notification-channels <channels>
    done

**Stage F**, after the switch deploy is verified:

    for p in callable-server-failure request-surge; do
      gcloud monitoring policies create --project constrapp-69b5d \
        --policy-from-file "ops/monitoring/phase2/phase2-${p}.policy.json" --notification-channels <channels>
    done

## Verification (read only)

    gcloud monitoring policies list --project constrapp-69b5d \
      --filter='userLabels.programme="phase2"' --format='table(name,displayName,enabled,severity)'
    gcloud logging metrics list --project constrapp-69b5d --filter='name:phase2_' --format='table(name,metricDescriptor.type)'

Expect seven policies (five after Stage A), all enabled, each with the
channel, and four metrics; compare each `--format=json` output with its file
(conditions, aggregations, `userLabels`, documentation). At Stage G the
baseline counter shows one count per project that ran its first operation,
and `phase2_refusals_by_code` shows the acceptance probes' codes
(`commercial-completion-not-activated` for the inactive company). No policy
has fired on its real condition until a real condition occurs; that is
recorded honestly, as for DC46 and L3.

## Recovery

- **Pulling a brake** (a switch `false` and a redeploy of that family):
  policy A will see 503s from the braked services if users try them —
  expected. Acknowledge or temporarily disable policy A
  (`gcloud monitoring policies update <name> --no-enabled`, authorised) and
  re-enable it when the brake is released.
- **A policy that misfires**: disable it, correct the file, run the unit
  test, delete and re-create it. Never tune it only in the console.
- **Removing everything** (authorised): `gcloud monitoring policies delete
  <name>` for each, then `gcloud logging metrics delete <metric>`. It changes
  no data and no function.

Monitoring detects; it brakes nothing and reverses nothing. Disabling a
switch or deactivating a company is a brake, not a reversal of financial
data.

## Cost

Four user-defined log-based metrics (counts of a few lines a day; one with a
label of at most ~120 values) and seven policies. On the rates quoted in the
L3 note: alerting is not charged before 1 September 2027; after that about
US$0.35 a month per condition plus a negligible per-point charge, and the
metric volume stays far inside the free ingestion allotment at today's scale.
Estimates, not a commitment.
