# ops/recovery — Firestore restoration verification

**Status: RUN ONCE, SUCCESSFULLY (recorded 21 November 2026).** The 20
November 2026 backup was restored into the temporary database
`restore-verify-20261120-2329`; an unauthenticated request to it returned
403; all 44 collection groups (211 documents) and the sample document hash
matched. That temporary database no longer exists, and production
`(default)` remains protected (delete protection and point-in-time recovery
enabled). The exact time and mechanism of the temporary database's deletion
were not established. The check compares counts and one document hash; it
does not compare every document's contents. Record: docs/DEPLOYMENT.md →
*Restoration verification record*.

**The procedure below is kept unchanged for future runs — every warning
still applies, and a past success authorises nothing.** Use a NEW temporary
database id each time; never reuse `restore-verify-20261120-2329`. Every step that creates or deletes a database
needs explicit Product Owner authorisation for that sitting. Nothing here
runs in CI.

This is a **verification** of the backups: restore one backup into a new,
temporary database, prove it holds what production held at the backup's
snapshot time, and delete it. It is not the disaster-recovery procedure for
replacing production data; that decision and its cut-over are out of scope.

## What is verified today (read-only, 21 November 2026 NZ)

| Item | State |
|---|---|
| Database | `(default)`, Firestore Native, `australia-southeast1`, uid `c296a8a4-ff1a-4576-a13a-9ab628a3d430` |
| Point-in-time recovery | ENABLED, 7 days (`versionRetentionPeriod: 604800s`); earliest version 18 November 2026 19:28 UTC, so the full window is reached on 25 November 2026 |
| Delete protection | `DELETE_PROTECTION_ENABLED` on `(default)` |
| Backup schedule | One daily schedule `86b478d6-9a91-49f8-9c55-ff4d183fed3f`, retention 14 days (`1209600s`) |
| TTL policies | None exist on `(default)` (`gcloud firestore fields ttls list`: 0) |
| Composite indexes | None exist on `(default)` |

| Backup id | Snapshot time (UTC) | Expires (UTC) | State |
|---|---|---|---|
| `d05840df-e4ff-489f-ace8-c123630775ef` | 19 November 2026 16:51:15 | 3 December 2026 16:51:15 | READY |
| `f6e32570-aea9-480c-b5c0-d7aa9d33d9f4` | 20 November 2026 17:01:09 | 4 December 2026 17:01:09 | READY |

Full resource name:
`projects/constrapp-69b5d/locations/australia-southeast1/backups/<backup id>`.
A new backup is added about every 24 hours and each expires after 14 days,
so **re-list the backups on the day** (step 1); the two above are a record,
not an instruction to use them.

**Expected counts already captured for backup `f6e32570…`.** Read from
`(default)` at 17:01:00 and 17:02:00 UTC on 20 November 2026 (the whole
minutes either side of the snapshot): identical at both, **211 documents in
44 collection groups**, and Cloud Monitoring shows zero Firestore writes in
that minute. The sample document (one `counters` document, one field) hashed
identically at both minutes.

| Group | n | Group | n | Group | n |
|---|---|---|---|---|---|
| activities | 2 | costCodes | 8 | pulseAcknowledgements | 0 |
| approvedBudget | 0 | | | | |
| auditEvents | 33 | counters | 10 | purchaseOrders | 10 |
| boqItems | 4 | devOutbox | 0 | rateLimits | 6 |
| budgetAdjustments | 0 | documents | 5 | retentionReleases | 1 |
| budgetApprovalSnapshots | 0 | drawings | 3 | revisions | 4 |
| budgetApprovals | 0 | fileLinkRevocationQueue | 0 | rfis | 4 |
| budgetLines | 12 | finalAccounts | 0 | supplierCreditNotes | 0 |
| cashFlowLines | 6 | forecastLines | 4 | supplierInvoices | 13 |
| clientInvoices | 18 | invitations | 4 | supplierPayments | 7 |
| clientReceipts | 12 | members | 2 | system | 3 |
| commercial | 3 | programmeBaselineSnapshots | 0 | takeoffMeasurements | 0 |
| companies | 1 | programmeBaselines | 0 | takeoffPages | 0 |
| contacts | 6 | progressClaims | 8 | tenderBids | 0 |
| | | projects | 7 | tenderPackages | 0 |
| | | | | users | 4 |
| | | | | variations | 11 |

These counts stay valid for that backup after the point-in-time window has
moved past it (27 November 2026). For any other backup, capture them in
step 2.

## What the documentation says (read 21 November 2026)

- A restore creates a **new** database in the backup's location; the
  database is not readable or writable until the operation completes
  ([backups](https://docs.cloud.google.com/firestore/native/docs/backups)).
- A backup holds data and index configuration. **It does not hold TTL
  policies or Firebase Security Rules.** Both must be set again on a
  database that is going to be used.
- "By default, the rules for a database that was not previously used
  prohibit all reads and writes from web and mobile clients." If the
  database id **was used before** in the project, rules for that id may
  still exist. This is why the id below carries a date and time and why
  step 4 checks the behaviour instead of assuming it.
- Security Rules are applied separately to each named database
  ([manage and deploy](https://firebase.google.com/docs/rules/manage-deploy)).
- A count query can be read at a past time only at a **whole minute**
  inside the point-in-time window (Firestore REST
  `RunAggregationQueryRequest.readTime`). A backup's snapshot time is not a
  whole minute; the API answers `The requested 'read_time' is not a whole
  minute` (tried on production, 21 November 2026). Step 2 therefore reads the
  two whole minutes either side of the snapshot and requires them to agree.

Commands were checked against `gcloud` 593.0.0 (`gcloud <command> --help`)
on 21 November 2026: `firestore databases restore` takes
`--source-backup` and `--destination-database`; `firestore databases delete`
takes `--database` and `--etag`. `gcloud firestore databases restore` itself
permits `(default)` as a destination, so the guard in step 0 is the control,
not the tool.

## Limits of this verification

- It compares **document counts per collection group** and **one sample
  document's field hash**. It does not compare every document's content.
- Two equal counts either side of the snapshot do not prove nothing changed
  inside that minute (a create and a delete in the same group would cancel).
  The write-count check in step 2 covers this.
- Cloud Storage objects (drawings, documents) are not in a Firestore backup.
  Their only recovery protection is 7-day soft delete (DEPLOYMENT.md →
  *Cloud Storage recovery protection*).
- It proves the backup restores. It does not rehearse switching the
  application to a restored database.

## Cost and risk

| Item | Estimate |
|---|---|
| Restore | Billed per GiB of backup. Database size 2.39 MB; at the Sydney price recorded on 19 November 2026 (US$0.256/GiB) under US$0.01. Confirm on the pricing page if the database has grown |
| Temporary database storage | Minutes to an hour of 2.39 MB: negligible. Billed until the database is deleted |
| Count reads | About 90 reads per run of the script; a named database has no free quota: negligible |

| Risk | Control |
|---|---|
| A destructive command names `(default)` | The `guard` in step 0 before every create and delete; delete protection is ENABLED on `(default)` and is re-checked in step 0; the delete uses `--etag` of the temporary database; `--quiet` is never used |
| The restored data is readable by a client | Unique never-used id; behaviour checked in step 4 before anything else; a failed check goes straight to cleanup |
| The temporary database is left behind | Step 7 and its final checks; *If cleanup fails* below |
| Customer data in evidence | The script prints counts and a hash only; nothing else is recorded |
| The application reads the wrong database | Not possible by configuration: the web app and the Functions use the unnamed default (`frontend/src/lib/firebase.js`, `frontend/functions/src/lib/firebaseAdmin.js`), and no Function is triggered by Firestore writes |

## Procedure

Run every step in one sitting, in one terminal, from the repository root.
Needs `gcloud` signed in as a project owner and Node 18 or later. Stop at
the first unexpected result.

### 0. Authorisation, variables and the guard

Product Owner authorisation recorded for this sitting: yes / no. If no, stop.

```
export P=constrapp-69b5d
export RESTORE_DB="restore-verify-$(date -u +%Y%m%d-%H%M)"

guard() {
  if [[ "$P" == "constrapp-69b5d" && "$RESTORE_DB" =~ ^restore-verify-[0-9]{8}-[0-9]{4}$ ]]; then
    echo "OK: project $P, temporary database $RESTORE_DB"
  else
    echo "STOP: unexpected project or database id"; return 1
  fi
}
guard
```

```
gcloud config list account
gcloud billing projects describe "$P" --format='value(billingEnabled)'
gcloud firestore databases list --project="$P" \
  --format='table(name.basename(),uid,deleteProtectionState,pointInTimeRecoveryEnablement,locationId)'
```

Expect exactly one row: `(default)`, uid `c296a8a4-…`,
`DELETE_PROTECTION_ENABLED`, `POINT_IN_TIME_RECOVERY_ENABLED`. If delete
protection on `(default)` is not enabled, or `$RESTORE_DB` is already
listed, stop.

Confirm the id has no rules from an earlier use (expect only the
`cloud.firestore` and `firebase.storage/…` releases, none naming
`$RESTORE_DB`):

```
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $P" \
  "https://firebaserules.googleapis.com/v1/projects/$P/releases?fields=releases(name)"
```

### 1. Choose the backup

```
gcloud firestore backups list --project="$P" --format='table(name.basename(),snapshotTime,expireTime,state)'
```

Choose a backup that is `READY` and whose snapshot is **less than 6 days
old** (inside the point-in-time window), or `f6e32570-…`, whose expected
counts are recorded above.

```
export BACKUP_ID=<backup id>
export BACKUP="projects/$P/locations/australia-southeast1/backups/$BACKUP_ID"
gcloud firestore backups describe --location=australia-southeast1 --backup="$BACKUP_ID" --project="$P"
```

Record the snapshot time. Set `M0` to it with the seconds cut to `:00Z` and
`M1` to one minute later, for example snapshot `2026-11-20T17:01:09.939894Z`
gives:

```
export M0=2026-11-20T17:01:00Z
export M1=2026-11-20T17:02:00Z
```

### 2. Capture the expected counts from `(default)` (read-only)

Skip for `f6e32570-…` only if the point-in-time window has passed it; use
the table above instead.

Pick the sample: one `counters` document. Its path contains the company id,
so keep it in the shell and out of any record.

```
export SAMPLE='companies/<company id>/counters/<counter name>'
node ops/recovery/firestore-count-evidence.mjs --project "$P" --database '(default)' \
  --read-time "$M0" --sample "$SAMPLE" > /tmp/expected.json
node ops/recovery/firestore-count-evidence.mjs --project "$P" --database '(default)' \
  --read-time "$M1" --sample "$SAMPLE" --expect /tmp/expected.json > /dev/null
```

The second command must print `MATCH`. Then confirm no write happened in
that minute (expect every point between `M0` and `M1` to be `0`, or no
series at all):

```
curl -s -G -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://monitoring.googleapis.com/v3/projects/$P/timeSeries" \
  --data-urlencode 'filter=metric.type="firestore.googleapis.com/document/write_count"' \
  --data-urlencode "interval.startTime=$M0" --data-urlencode "interval.endTime=$M1"
```

If the counts differ or a write is shown, the snapshot fell in a busy
minute: choose another backup and repeat from step 1. Nothing has been
created yet.

### 3. Restore into the temporary database

**This creates a database.**

```
guard && gcloud firestore databases restore \
  --source-backup="$BACKUP" --destination-database="$RESTORE_DB" --project="$P"
```

Wait for the operation to finish (`done: true`, no `error`):

```
gcloud firestore operations list --database="$RESTORE_DB" --project="$P"
```

If the operation ends in an error, go to step 7: a database entry may exist
and must be removed.

### 4. Verify the temporary database's configuration — before reading it

```
gcloud firestore databases describe --database="$RESTORE_DB" --project="$P" \
  --format='yaml(name,uid,locationId,type,deleteProtectionState,pointInTimeRecoveryEnablement,etag)'
```

Record the output. `locationId` must be `australia-southeast1`.

**Security Rules — check the behaviour, do not assume it.** A request with
no credential is evaluated by Security Rules:

```
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://firestore.googleapis.com/v1/projects/$P/databases/$RESTORE_DB/documents/companies"
```

Expect **`403`**. (On `(default)` the same request returns 403 because the
published rules require sign-in; a database that does not exist returns
404.) **If it returns `200`, the restored data is readable without
credentials: skip step 5 and delete the database now (step 7).** Then repeat
the release listing from step 0 and record whether any release names
`$RESTORE_DB` (expect none).

**IAM.** Firestore access for operators and service accounts is granted at
project level; there is no per-database grant to add or remove. Confirm the
project policy has no public member and is otherwise as expected (two
owners; no IAM change is part of this test):

```
gcloud projects get-iam-policy "$P" --format=json | grep -c -E 'allUsers|allAuthenticatedUsers'
```

Expect `0`.

**What was not restored.**

```
gcloud firestore fields ttls list --database="$RESTORE_DB" --project="$P"
gcloud firestore backups schedules list --database="$RESTORE_DB" --project="$P"
```

Expect no TTL policy and no backup schedule. Production has no TTL policy
today, so nothing is missing; in a real recovery any TTL policy and the
Security Rules would have to be re-created on the restored database before
use.

Do not open the application against this database and do not publish rules
to it.

### 5. Compare with the expected counts

```
node ops/recovery/firestore-count-evidence.mjs --project "$P" --database "$RESTORE_DB" \
  --sample "$SAMPLE" --expect /tmp/expected.json > /tmp/restored.json
```

Must print `MATCH: 44 collection groups, <total> documents, sample hash
equal` and exit 0. When using the recorded table for `f6e32570-…` instead of
`/tmp/expected.json`, run without `--expect` and compare `counts` with the
table by eye (total 211).

A `MISMATCH` is a finding, not a reason to retry: record the listed groups
and go to step 7.

### 6. Record the evidence

Record in `docs/DEPLOYMENT.md` → *Firestore recovery protection* →
*Restoration verification record*: date and operator; backup id and snapshot
time; temporary database id and uid; restore operation start and end; the
describe output of step 4; the HTTP status of the rules check; the `counts`,
`total` and sample hash from both files; `MATCH` or the mismatches; the
deletion time. **Never record the sample path, a document id or any field
value.** Delete `/tmp/expected.json` and `/tmp/restored.json` afterwards.

### 7. Cleanup — delete the temporary database

**This deletes a database.** Run the guard, read the etag of the temporary
database, and delete that database only:

```
guard && export ETAG="$(gcloud firestore databases describe --database="$RESTORE_DB" --project="$P" --format='value(etag)')"
guard && gcloud firestore databases delete --database="$RESTORE_DB" --etag="$ETAG" --project="$P"
```

Read the confirmation prompt: it must name `$RESTORE_DB`. Answer it by
hand; never add `--quiet`.

### 8. Final checks

```
gcloud firestore databases list --project="$P" \
  --format='table(name.basename(),uid,deleteProtectionState,pointInTimeRecoveryEnablement,locationId)'
gcloud firestore backups schedules list --database='(default)' --project="$P"
gcloud firestore backups list --project="$P" --format='table(name.basename(),snapshotTime,state)'
curl -s -o /dev/null -w '%{http_code}\n' https://app.constrap.com/
```

Expect: one database, `(default)`, the same uid as in step 0, delete
protection and point-in-time recovery still enabled; the daily schedule
present; the backups still listed and READY; the application answering 200.
Sign in to the application and open one project.

## If cleanup fails

The temporary database is a private copy of production data. While it
exists it costs almost nothing and, if step 4 returned 403, it is reachable
only through project IAM. So a failed delete is not an emergency: **stop,
do not improvise, and never run a command that names `(default)`.**

1. Re-run the step 4 rules check. If it is not 403, treat it as urgent and
   call the Product Owner now.
2. Read the error and the operations list
   (`gcloud firestore operations list --database="$RESTORE_DB" --project="$P"`).
   A restore still in progress must finish before the database can be
   deleted.
3. `FAILED_PRECONDITION` on the etag: the database changed since the etag
   was read. Repeat step 7 from the `describe`.
4. Delete protection: if `deleteProtectionState` of the **temporary**
   database is enabled, switch it off on that database only and repeat
   step 7:
   `guard && gcloud firestore databases update --database="$RESTORE_DB" --no-delete-protection --project="$P"`
5. Still failing: leave the database in place, record its id, uid, the
   error text and the time, and escalate to the Product Owner and the Lead
   Architect. Deleting it from the Google Cloud console (Firestore,
   Databases) is the supported alternative; check the id on screen twice.

Until it is gone, repeat the step 8 listing daily and keep the entry open
in the incident log (`ops/RUNBOOK.md`).
