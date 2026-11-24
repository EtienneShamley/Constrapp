# ops/monitoring — Cloud Monitoring alert policies

**L3 Stage 1 (21 November 2026): the three L3 objects are CREATED and
enabled** — an uptime check on `app.constrap.com`, its alert policy
(`15559930914799323534`), and an alert on server failures of
`approveFinalAccount` (`9683374685335961795`). The three DC46 policies are
preserved. Notification channels are connected. **C1-D (24 November 2026
UTC): alert delivery was tested end to end through a temporary policy on the
Product Owner channel.** The opened and resolved emails were received (as
reported by the Product Owner), and the condition recovered by itself. Record:
docs/DEPLOYMENT.md → *L3 Stage 1* → *C1-D alert delivery acceptance record*.
Neither L3 alert has fired on its real condition. **C1-D CLOSED by the Lead
Architect, 25 November 2026**, with its evidence limitations (TESTING.md
§73). They are described in *L3 files* at the end of this document. The rest of
this document is the DC46 worker monitoring, unchanged.

## DC46 worker policies

**Status: policies A and B are CREATED in production (`constrapp-69b5d`,
16 November 2026). The temporary delivery-test policy was created, used and
deleted the same day; it does not exist in the cloud. Policy C and its
log-based metric were CREATED on 17 November 2026 and are enabled.** Any further change
to these resources is a production cloud change that needs its own
authorisation. Deferred Control 46 was CLOSED on 18 November 2026 with
accepted risks (docs/SECURITY.md item 46); these policies detect, they
revoke nothing, and they live in the same cloud project as the worker.

| File | Policy | Condition | Cloud state |
|---|---|---|---|
| `dc46-worker-no-successful-run.policy.json` | A — the worker has stopped | No 2xx request to the Cloud Run service `processfilelinkrevocations` (`australia-southeast1`) for 15 minutes | **Permanent — created 16 November 2026, enabled** |
| `dc46-worker-error-log.policy.json` | B — the worker logged an error | Any `ERROR` line written by that service's container; at most one notification an hour | **Permanent — created 16 November 2026, enabled** |
| `dc46-planning-heartbeat.metric.json` | Log-based counter `dc46_reconciliation_plan_complete` | Counts the worker's `file-links: reconciliation plan complete` info line (one per planning pass, about hourly while reconciliation is on) | **Permanent — created 17 November 2026** |
| `dc46-planning-heartbeat-absent.policy.json` | C — planning has stopped | No count on that metric for 3 hours, summed across revisions | **Permanent — created 17 November 2026, enabled** — disable on rollback to interval `0` |
| `dc46-delivery-test.temporary-policy.json` | Temporary delivery test | Fires because the worker IS healthy. Created to exercise email delivery, then deleted | **Removed — created and deleted 16 November 2026. Kept here only so the test can be repeated under a new approval** |

A read-only check on 16 November 2026 found policies A and B identical to
these files, each attached to two email notification channels
(`DC46 - Product Owner`, `DC46 - Billing Administrator`). **Edit a policy
from its file and re-create it; do not tune it by hand in the console alone,
or this folder stops describing production.**

The files are request bodies for `projects.alertPolicies.create`, checked
field by field against the API's published schema and accepted by the API as
written. They hold **no recipient**: notification channels are created
outside Git and passed on the command line.
`frontend/tests/unit/monitoringPolicies.test.js` fails if an address or a
channel name is ever committed here.

## Policy C

Created with `gcloud logging metrics create … --config-from-file` and then
`gcloud monitoring policies create … --policy-from-file`, both on separate
authorisation (commands in the deployment document). It is safe to create
at interval `0`: an absence condition stays dormant until its first data
point. It **will** fire about 3 hours after reconciliation is switched off,
so the rollback disables it. Like policy A it raises nothing for a deleted
service and is not claimed to detect a billing interruption; it has never
existed, let alone fired.

## What policy A is not

It is a detection aid inside the project. It is **not** a guaranteed
external availability monitor, and it is **not** claimed to detect a billing
interruption.

- It cannot fire until the worker has reported at least once after the
  policy is created or edited.
- The metric arrives up to about two minutes late; late data counts as
  missing. Expect a notification roughly 17 to 20 minutes after the last
  successful run (an estimate).
- Google documents that a metric-absence policy raises no alert when the
  monitored resource is deleted or shut down. If the function or its Cloud
  Run service is deleted, assume silence.
- What Cloud Monitoring does while the project's billing is suspended is
  not documented and not tested.
- A run that returns 200 counts as healthy, whatever it did.

## What has and has not been shown

- Policy C exists in production since 17 November 2026, and its metric counts
  one point per hourly planning pass. Its absence condition has never fired.
  *As written before creation:* "Policy C exists only as files."
- Policy B notifies only when the worker writes a matching error-level line.
  A run that dies without writing one is left to policy A.
- **Policy B has matched a real line once** (corrected 25 November 2026,
  C1-D). The predicted first-pass `reconciliation overdue` line at
  activation (17 November 2026 19:17:02 UTC) opened an incident at 19:18:06,
  which auto-closed on 18 November at 19:22:24. Its email receipt was not
  recorded. **Policy A has never fired.** No absence and no error line was
  deliberately produced in production. *As written:* "Neither policy has
  fired on its real condition."
- Both policies live in the project they watch. An independent external
  availability monitor does not exist; it remains future reliability work.

## Testing delivery

Google provides no test function for an email channel; its documented method
is an alerting policy whose condition is met. That is the temporary file
above. It was run once on 16 November 2026: one incident opened, the policy
was deleted, the incident closed. That both recipients received the email is
reported by the Product Owner; it is not observed in any cloud record. A
repeat needs explicit approval and is deleted in the same sitting.

**C1-D (24 November 2026 UTC)** used a different temporary policy, held
outside this folder so that the committed file set is unchanged; its body is
in the deployment record. It is a threshold condition on the heartbeat
metric with a 5-minute window, `EVALUATION_MISSING_DATA_INACTIVE`, and
OPENED and CLOSED notifications, so it opens on a healthy heartbeat and
recovers by itself.
- It went to the Product Owner channel only.
- Created 22:08:41; incident opened 22:29:20; natural recovery and closure
  22:33:35; deleted 22:34:58.
- The opened and resolved emails were received (reported by the Product
  Owner; exact arrival times not visible).
- Cloud Monitoring records incident open and resolve events
  (`monitoring.googleapis.com/ViolationOpenEventv1`,
  `ViolationAutoResolveEventv1`), but **no per-recipient delivery record**:
  receipt can only come from the recipient.

## Cost

Alerting is not charged before 1 September 2027 (Google's published date).
After that the published rates apply per policy and per point returned;
estimates are in the deployment document and are not a commitment.

Specification, the release record, the creation and delivery-test
procedures, the response runbook, billing continuity and rollback are in
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) → *DC46-C monitoring readiness*
(policy C: its *Policy C* section; activation: *DC46-C* → *Activation
runbook*).

## L3 files — CREATED in production 21 November 2026; delivery path TESTED 24 November 2026 UTC (C1-D); neither alert has fired

**Status (21 November 2026).** All three exist in `constrapp-69b5d` and are
enabled; the *Cloud state* column below is current. The three DC46 policies
are unchanged. Notification channels are connected. No L3 alert has fired.
*Updated 25 November 2026 (C1-D):* the email path these policies use was
tested with a temporary policy on the Product Owner channel. The
availability policy file was aligned with the created policy (see
*Availability policy as created*). *As written 21 November:* "No L3 alert
has fired and no test notification was sent, so delivery is unproven." Release record:
docs/DEPLOYMENT.md → *L3 Stage 1* → *Monitoring release record*.

| File | What it is | Condition | Cloud state |
|---|---|---|---|
| `l3-app-availability.uptime-check.json` | Request body for `projects.uptimeCheckConfigs.create`: a public HTTPS check of `https://app.constrap.com/` | Every 5 minutes, from every checker region; passes on HTTP 200, a valid certificate, a reply within 10 seconds and `<div id="root"></div>` in the body | **Exists** — `l3-app-constrap-com-https-availability-10ehOIKFFlc` |
| `l3-app-availability.policy.json` | Alert on that check | Two or more checker locations failing, sustained for 10 minutes (two check periods). CRITICAL | **Exists, enabled** — `15559930914799323534` |
| `l3-final-account-callable-failure.policy.json` | Alert on `approveFinalAccount` | Any HTTP 5xx from the Cloud Run service `approvefinalaccount` (`australia-southeast1`). 4xx refusals are not counted. ERROR | **Exists, enabled** — `9683374685335961795` |

Same conventions as the DC46 files: request bodies checked against the
Monitoring API's published schema, no recipient committed, channels passed
on the command line, pinned by
`frontend/tests/unit/monitoringPolicies.test.js`. Both alert filters were
accepted by the live Monitoring API in a read-only `timeSeries.list` query
on 21 November 2026, before creation (no series then: the check did not
exist and the function had never returned a 5xx). The API has no dry run
for creating a policy or an uptime check; the files were proven as request
bodies when the objects were created from them. **What is still unproven is
that either alert fires on its real condition.** Email delivery through the
Product Owner channel, which both use, was shown by C1-D. *As written 21
November:* "…that either alert fires and that its notification is
delivered."

### What the availability check is not

- **HTTP 200 does not validate the application.** The check fetches one
  public static page. Sign-in, Firestore, Storage and the Functions can all
  be broken while it passes. Firebase Hosting also rewrites every path to
  that page, so the status code alone says little; the body match is what
  ties the check to a real build.
- It is not independent. The check and its policy live in the project they
  watch, exactly like policies A, B and C. What Cloud Monitoring does while
  the project's billing is suspended is not documented and not tested.
- **Availability policy as created** (corrected 25 November 2026, C1-D). The
  policy is tied to the check by host AND by the check's server-assigned id
  (`metric.label.check_id="l3-app-constrap-com-https-availability-10ehOIKFFlc"`),
  and it groups by `resource.label.*`. That is how it was created on
  20 November 2026 (audit log); the file and its test now say the same.
  - `uptime_url` has only `project_id` and `host`, so the grouping is one
    group and `REDUCE_COUNT_FALSE` counts the failing checker locations of
    this one check.
  - Over the check's whole history, the result was compared with the earlier
    host-only form and was identical.
  - A second check on the same host is no longer counted.
  - **If the check is re-created it gets a new id, and this policy must be
    re-created with it**, or it watches nothing.
  - *As written 21 November:* "tied to the check by host name, because a
    check's id is assigned when it is created. A second uptime check on the
    same host would be counted by the same policy."
- A single failing location, or one failed round, raises nothing by design.
  Expect a notification roughly 10 to 20 minutes after an outage begins (an
  estimate; never observed).

### What the callable alert is not

- It sees only responses with a 5xx status. A handler that returned a
  wrong answer with HTTP 200 is invisible to it.
- One 5xx is expected and deliberate: `FINAL_ACCOUNT_DISABLED` answers 503
  when `FINAL_ACCOUNT_APPROVAL_ENABLED` is off and a user tries to approve.
  The notification's runbook says so. Every other documented refusal is 4xx.
- The function had zero requests in the 14 days before these files were
  written. The policy is silent until a first failure, and it has never
  fired.
- It does not watch the eight team callables. Their failures in the last
  7 days were eight HTTP 401 probes and no 5xx; an alert there is not
  justified yet.

### Cost

Uptime checks: 1 million executions a month are free per project (Google's
pricing page, read 21 November 2026); this check runs about 52,000 a month
if six locations are used (288 a day each). Alerting is not charged before
1 September 2027 on the same page; after that, policies on uptime metrics
are listed as not charged and the callable policy would cost about US$0.35
a month plus a negligible per-point charge. Estimates, not a commitment.

Creation commands, channel choice, verification and rollback:
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) → *L3 Stage 1*. Response
runbook: [ops/RUNBOOK.md](../RUNBOOK.md).
