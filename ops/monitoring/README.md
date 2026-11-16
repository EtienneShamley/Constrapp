# ops/monitoring — PROPOSED Cloud Monitoring alert policies

**Status: PROPOSED. Nothing in this folder exists in Google Cloud.** Creating
any of it is a production cloud change that needs its own authorisation.
Deferred Control 46 stays OPEN.

| File | Policy | Condition |
|---|---|---|
| `dc46-worker-no-successful-run.policy.json` | A — the worker has stopped | No 2xx request to the Cloud Run service `processfilelinkrevocations` (`australia-southeast1`) for 15 minutes |
| `dc46-worker-error-log.policy.json` | B — the worker logged an error | Any `ERROR` line written by that service's container; at most one notification an hour |
| `dc46-delivery-test.temporary-policy.json` | Temporary delivery test | Fires because the worker IS healthy. Created once to prove email delivery, then deleted in the same sitting |

The files are request bodies for `projects.alertPolicies.create`, checked
field by field against the API's published schema. They hold **no
recipient**: notification channels are created outside Git and passed on the
command line. `frontend/tests/unit/monitoringPolicies.test.js` fails if an
address or a channel name is ever committed here.

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

## Testing delivery

Google provides no test function for an email channel; its documented method
is an alerting policy whose condition is met. That is the temporary file
above. It needs explicit approval, creates exactly one incident marked as a
test, and is deleted straight after both recipients confirm.

## Cost

Alerting is not charged before 1 September 2027 (Google's published date).
After that the published rates apply per policy and per point returned;
estimates are in the deployment document and are not a commitment.

Specification, verification evidence, the creation and delivery-test
procedures, the response runbook, billing continuity and rollback are in
[docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) → *DC46-C monitoring readiness*.
