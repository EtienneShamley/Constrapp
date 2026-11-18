# ops/monitoring — Cloud Monitoring alert policies for the DC46 worker

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

- Policy C exists only as files. Its filter is pinned to the exact line the
  worker writes; its behaviour in Cloud Monitoring is untested.
- Policy B notifies only when the worker writes a matching error-level line.
  A run that dies without writing one is left to policy A.
- **Neither policy has fired on its real condition.** No absence and no
  error line was deliberately produced in production.
- Both policies live in the project they watch. An independent external
  availability monitor does not exist; it remains future reliability work.

## Testing delivery

Google provides no test function for an email channel; its documented method
is an alerting policy whose condition is met. That is the temporary file
above. It was run once on 16 November 2026: one incident opened, the policy
was deleted, the incident closed. That both recipients received the email is
reported by the Product Owner; it is not observed in any cloud record. A
repeat needs explicit approval and is deleted in the same sitting.

## Cost

Alerting is not charged before 1 September 2027 (Google's published date).
After that the published rates apply per policy and per point returned;
estimates are in the deployment document and are not a commitment.

Specification, the release record, the creation and delivery-test
procedures, the response runbook, billing continuity and rollback are in
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) → *DC46-C monitoring readiness*
(policy C: its *Policy C* section; activation: *DC46-C* → *Activation
runbook*).
