# ops/RUNBOOK — production operations (L3)

Short, executable checks for the Constrap production project
`constrapp-69b5d` (`australia-southeast1`, `https://app.constrap.com`).
Everything in sections 1 to 5 is **read-only**. Section 8 lists what needs
approval first. Detailed procedures live where they always have:
[docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) (releases, DC46 worker),
[ops/monitoring/README.md](monitoring/README.md) (alert policies),
[ops/recovery/README.md](recovery/README.md) (restore verification).

**Status, 21 November 2026:** the DC46 worker policies A, B and C are live.
The two L3 policies and the uptime check in `ops/monitoring/` are PREPARED,
NOT CREATED. The restore verification is PREPARED, NOT RUN.

```
export P=constrapp-69b5d
```

## 1. Backup freshness and READY state — weekly, and before any release that changes data shape

```
gcloud firestore backups list --project="$P" --format='table(name.basename(),snapshotTime,expireTime,state)'
gcloud firestore backups schedules list --database='(default)' --project="$P" --format='table(name.basename(),retention,dailyRecurrence)'
gcloud firestore databases describe --database='(default)' --project="$P" \
  --format='yaml(pointInTimeRecoveryEnablement,earliestVersionTime,versionRetentionPeriod,deleteProtectionState)'
```

Healthy:

- The newest backup's `snapshotTime` is **less than 26 hours old** and its
  state is `READY`. The schedule is daily; Google chooses the time of day
  (observed: about 17:00 UTC).
- Up to 14 backups are listed once the schedule has run for two weeks; each
  expires 14 days after its snapshot.
- One daily schedule with `retention: 1209600s`.
- `POINT_IN_TIME_RECOVERY_ENABLED`, `versionRetentionPeriod: 604800s`,
  `DELETE_PROTECTION_ENABLED`.

No alert watches this. It is a manual check on purpose: no backup-failure
metric has been confirmed, and a wrong alert would be worse than a weekly
look.

## 2. A scheduled backup is missing or late

| Observation | Action |
|---|---|
| Newest backup 26 to 48 hours old | Check again in a few hours. Check billing: `gcloud billing projects describe "$P"` must show `billingEnabled: true` |
| Newest backup in state `CREATING` | Normal while it is being taken. Check again in an hour. `NOT_AVAILABLE` on any backup: record its id and escalate |
| Newest backup more than 48 hours old | Confirm the schedule still exists (section 1). Check https://status.cloud.google.com/ for Firestore. Record an incident and escalate to the Product Owner the same day |
| The schedule is gone, or point-in-time recovery or delete protection is off | Someone changed production configuration. Read who and when: `gcloud logging read 'protoPayload.serviceName="firestore.googleapis.com" AND logName:"cloudaudit.googleapis.com%2Factivity"' --project="$P" --freshness=30d --limit=20 --format='table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)'`. Escalate at once. Re-enabling is a production change (section 8; commands in DEPLOYMENT.md → *Firestore recovery protection*) |

Point-in-time recovery still covers the last 7 days while backups are late.
A missed day is a reduced margin, not a data loss.

## 3. The uptime check on app.constrap.com is failing

Alert: *L3 app.constrap.com: HTTPS check failing from two or more locations
for 10 minutes* (once created). The check requests `https://app.constrap.com/`
every 5 minutes from Google's checker locations and passes only on HTTP 200,
a valid certificate, a reply within 10 seconds and the application shell in
the body. **A passing check proves the static page is served. It does not
prove sign-in, Firestore, Storage or the Functions work.**

```
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://app.constrap.com/
curl -sS -o /dev/null -w '%{http_code}\n' https://constrapp-69b5d.web.app/
gcloud billing projects describe "$P" --format='value(billingEnabled)'
echo | openssl s_client -connect app.constrap.com:443 -servername app.constrap.com 2>/dev/null | openssl x509 -noout -enddate
dig +short app.constrap.com
```

| Finding | Meaning | Action |
|---|---|---|
| Both origins answer 200 from your machine | A regional or checker-side problem, or already recovered | Open the uptime check in Cloud Monitoring and read the failing locations and errors. Watch for the incident to close |
| `web.app` answers 200, the custom domain does not | DNS or certificate for `app.constrap.com` | Check the DNS records at the DNS host and the domain's status in Firebase Console → Hosting. DEPLOYMENT.md → *Custom domain* |
| Neither answers, `billingEnabled` is false | Billing lapse | Contact the billing administrator now. Nothing else restores service |
| Neither answers, billing is on | Hosting outage or a bad release | https://status.firebase.google.com/. If it began at a deploy: Firebase Console → Hosting → release history → *Rollback* (needs approval, section 8) |
| The page loads but users report failures | Outside what this check sees | Sections 4 and 5; browser console of the affected user |

## 4. approveFinalAccount failed

Alert: *L3 approveFinalAccount: server failure (5xx)* (once created). It
counts only HTTP 5xx from the Cloud Run service `approvefinalaccount`.
Refusals are 4xx and are not counted: no sign-in or App Check token (401),
wrong role (403), not ready or figures changed (400), stale or busy (409).

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="approvefinalaccount" AND (severity>=ERROR OR httpRequest.status>=500)' \
  --project="$P" --freshness=2d --limit=20 --format='table(timestamp,severity,httpRequest.status,httpRequest.latency,jsonPayload.message)'
gcloud run services describe approvefinalaccount --region australia-southeast1 --project="$P" \
  --format='value(status.latestReadyRevisionName,status.conditions[0].status)'
```

| Finding | Meaning | Action |
|---|---|---|
| `final account call failed` | The handler threw. The entry holds the message and stack | Establish whether the revision was approved (below). Treat as a defect: record and escalate |
| 503 with no error line | Approval is switched off (`FINAL_ACCOUNT_APPROVAL_ENABLED`) and a user tried | Expected while it is off |
| 504, or latency near 120 s | The call hit its time limit | Record the project; escalate. Do not change the limit without approval |
| 500 or 503 with a Cloud Run memory or start-up message | The instance died or could not start | Confirm the latest revision is Ready; escalate if it repeats |

**Was anything approved?** The approval is one transaction: all or nothing.
Ask the user to reload Commercial → Final Account. The revision is either
still a draft (nothing was written) or approved (only the reply was lost).
An approval also writes one `final_account.approved` audit event. Never
correct a Final Account revision in the console.

## 5. Other callables and the worker

The eight team callables have no alert of their own; their failures appear
to the user on the Team page. To look:

```
gcloud logging read 'resource.type="cloud_run_revision" AND severity>=ERROR' --project="$P" --freshness=7d --limit=50 \
  --format='table(timestamp,resource.labels.service_name,jsonPayload.message)'
```

The file-link worker (`processfilelinkrevocations`) is covered by DC46
policies A, B and C; follow the runbook inside each notification and
DEPLOYMENT.md → *DC46-C monitoring readiness*.

## 6. Where alerts are delivered

Email, through two Cloud Monitoring notification channels: `DC46 - Product
Owner` and `DC46 - Billing Administrator`. The addresses are held only in
Cloud Monitoring, never in this repository. The channel names carry "DC46"
for historical reasons; they are the project's only channels and the L3
policies reuse them. List them (names and state only):

```
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://monitoring.googleapis.com/v3/projects/$P/notificationChannels?fields=notificationChannels(name,displayName,type,enabled)"
```

All alerting lives inside the project it watches. If the project's billing
is suspended or the project is damaged, assume no alert arrives.

## 7. Recording an incident, and when to escalate

Every alert that opens, and every manual finding in sections 1 to 5, gets
one dated entry in `docs/DEPLOYMENT.md` → *Operational incident log*:

- When it started and how it was noticed (alert name, user report, weekly check).
- What was affected and for how long (UTC).
- Evidence: the commands run and what they returned. No customer document
  content, no tokens, no download URLs, no email addresses.
- Cause, if established. Say "not established" otherwise.
- What was done, by whom, and under whose approval.
- Follow-up, or "none".

Escalate to the Product Owner immediately, and to the Lead Architect before
any corrective change, when:

- The application has been unavailable for 30 minutes.
- Billing is disabled.
- A backup is more than 48 hours late, or recovery protection was changed.
- `approveFinalAccount` failed twice for the same project, or an approval
  looks partly written.
- Any sign that data was read or changed by someone who should not have
  access.
- A temporary restore database cannot be deleted.

## 8. Operations that need explicit Product Owner approval

Nothing below is done on an operator's own judgement, during an incident or
otherwise:

- Any deploy: Hosting, Functions, Firestore Rules, Storage Rules; a Hosting
  rollback.
- Creating, editing, disabling or deleting an alert policy, uptime check,
  log-based metric or notification channel.
- Any Firestore database operation: restore, clone, export, import, delete,
  bulk delete; changing point-in-time recovery, the backup schedule or
  delete protection; deleting a backup.
- Any write to production data from the console, the Admin SDK or a script,
  including operator scripts in `frontend/functions/scripts/`.
- Any IAM, billing, App Check, Authentication or Secret Manager change.
- Changing a Function's configuration (time limit, memory, instances,
  environment values such as `FINAL_ACCOUNT_APPROVAL_ENABLED` or
  `FILE_LINK_RECONCILE_INTERVAL_HOURS`).

Read-only inspection (`describe`, `list`, `logging read`, count queries,
`ops/recovery/firestore-count-evidence.mjs`) needs no further approval.
