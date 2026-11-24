import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ── Monitoring — the committed alert policy, metric and uptime-check files ───
//
// L3 Stage 1 added three files (an uptime check, its alert policy and the
// approveFinalAccount failure policy): CREATED in production on 21 November
// 2026. Their tests are at the end of this file. The DC46 notes below are unchanged.
//
// ops/monitoring/*.policy.json are applied by hand with
// `gcloud monitoring policies create --policy-from-file`, and the one
// *.metric.json with `gcloud logging metrics create --config-from-file`, each
// only once authorised (docs/DEPLOYMENT.md → DC46-C monitoring readiness).
// Policies A and B were created in production on 16 November 2026; policy C
// and its metric on 17 November 2026. Nothing in CI creates any of them.
// This suite only keeps the committed files honest:
//   · no recipient, channel or address is ever committed
//   · each policy stays scoped to the ONE worker service
//   · the settings that were verified against production stay as verified
// It proves nothing about Cloud Monitoring itself.

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ops/monitoring')
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
const files = readdirSync(dir).filter(f => f.endsWith('.policy.json')).sort()
// L3 Stage 1 — created in production 21 November 2026.
const L3_UPTIME = 'l3-app-availability.uptime-check.json'
const L3_UPTIME_POLICY = 'l3-app-availability.policy.json'
const L3_CALLABLE_POLICY = 'l3-final-account-callable-failure.policy.json'
// The delivery test is a separate kind of file on purpose: it is created,
// used once and deleted, and must never be mistaken for a standing policy.
const TEMPORARY = 'dc46-delivery-test.temporary-policy.json'
const allFiles = [...files, TEMPORARY]
const METRIC = 'dc46-planning-heartbeat.metric.json'
const POLICY_C = 'dc46-planning-heartbeat-absent.policy.json'
const here = path.dirname(fileURLToPath(import.meta.url))
const workerSource = () => readFileSync(path.resolve(here, '../../functions/src/lib/fileLinkRevocation.js'), 'utf8')

const SERVICE = 'resource.labels.service_name="processfilelinkrevocations"'
const REGION = 'resource.labels.location="australia-southeast1"'

describe('ops/monitoring policy files', () => {
  it('are exactly the three standing DC46 policies, the two L3 policies, the heartbeat metric, the uptime check and the one temporary delivery test', () => {
    expect(files).toEqual([
      POLICY_C, 'dc46-worker-error-log.policy.json', 'dc46-worker-no-successful-run.policy.json',
      L3_UPTIME_POLICY, L3_CALLABLE_POLICY,
    ])
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).sort()).toEqual([TEMPORARY, METRIC, L3_UPTIME, ...files].sort())
  })

  it.each(allFiles)('%s carries no recipient: no channel, no email address, no server-assigned name', (name) => {
    const text = readFileSync(path.join(dir, name), 'utf8')
    const policy = JSON.parse(text)
    expect(policy.notificationChannels).toBeUndefined()
    expect(policy.name).toBeUndefined()
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
    expect(text).not.toMatch(/notificationChannels\//)
    expect(JSON.stringify(policy.alertStrategy ?? {})).not.toMatch(/notificationChannelStrategy/)
  })

  it.each(allFiles)('%s is one enabled condition with documentation inside the API limits', (name) => {
    const policy = read(name)
    expect(policy.enabled).toBe(true)
    expect(policy.combiner).toBe('OR')
    expect(policy.conditions).toHaveLength(1)
    expect(policy.documentation.mimeType).toBe('text/markdown')
    expect(policy.documentation.content.length).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(policy.documentation.content, 'utf8')).toBeLessThanOrEqual(10240)
    expect(Buffer.byteLength(policy.documentation.subject, 'utf8')).toBeLessThanOrEqual(255)
    for (const [k, v] of Object.entries(policy.userLabels)) expect(`${k}=${v}`).toMatch(/^[a-z][a-z0-9_-]*=[a-z0-9_-]+$/)
  })

  it('policy A: absence of 2xx requests to the worker, summed across revisions, for 15 minutes', () => {
    const policy = read('dc46-worker-no-successful-run.policy.json')
    const c = policy.conditions[0].conditionAbsent
    expect(c.filter).toContain('metric.type="run.googleapis.com/request_count"')
    expect(c.filter).toContain('resource.type="cloud_run_revision"')
    expect(c.filter).toContain(SERVICE)
    expect(c.filter).toContain(REGION)
    expect(c.filter).toContain('metric.labels.response_code_class="2xx"')
    expect(c.duration).toBe('900s')
    expect(c.trigger).toEqual({ count: 1 })
    // Summed across revision_name: a deploy creates a NEW per-revision series,
    // and an alert on the old one going quiet would fire on every deploy.
    expect(c.aggregations).toEqual([{
      alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_DELTA', crossSeriesReducer: 'REDUCE_SUM', groupByFields: ['resource.labels.service_name'],
    }])
    expect(policy.severity).toBe('CRITICAL')
  })

  it('policy B: ERROR lines written by the worker container only, rate-limited, with no log content extracted', () => {
    const policy = read('dc46-worker-error-log.policy.json')
    const c = policy.conditions[0].conditionMatchedLog
    expect(c.filter).toContain('resource.type="cloud_run_revision"')
    expect(c.filter).toContain(SERVICE)
    expect(c.filter).toContain(REGION)
    expect(c.filter).toContain('severity>=ERROR')
    // Container output only: not the platform's request log, where a refused
    // overlapping tick or an unauthenticated probe is recorded.
    expect(c.filter).toContain('log_id("run.googleapis.com/stderr")')
    expect(c.filter).not.toContain('run.googleapis.com/requests')
    // Nothing from a log entry is copied into a notification.
    expect(c.labelExtractors).toBeUndefined()
    // Required for a log-match policy by the Monitoring API.
    expect(policy.alertStrategy.notificationRateLimit).toEqual({ period: '3600s' })
    expect(policy.alertStrategy.autoClose).toBe('86400s')
  })

  it('the temporary delivery test watches the SAME series as policy A, fires on healthy traffic, and says it is a test', () => {
    const a = read('dc46-worker-no-successful-run.policy.json').conditions[0].conditionAbsent
    const policy = read(TEMPORARY)
    const c = policy.conditions[0].conditionThreshold
    expect(c.filter).toBe(a.filter)
    expect(c.aggregations).toEqual(a.aggregations)
    expect(c).toMatchObject({ comparison: 'COMPARISON_GT', thresholdValue: 0, duration: '60s', trigger: { count: 1 } })
    expect(policy.displayName).toMatch(/^TEST - .*delete after use$/)
    expect(policy.documentation.subject).toMatch(/^TEST ONLY/)
    expect(policy.documentation.content).toContain('This is a test. Nothing is wrong.')
    expect(policy.severity).toBe('WARNING')
    expect(policy.alertStrategy).toEqual({ autoClose: '1800s' })
    expect(policy.userLabels.policy).toBe('temporary-delivery-test')
  })

  it('policy B\'s runbook names every ERROR line the worker can write', () => {
    const doc = read('dc46-worker-error-log.policy.json').documentation.content
    const src = ['../../functions/src/lib/fileLinkRevocation.js', '../../functions/src/index.js']
      .map(p => readFileSync(path.resolve(here, p), 'utf8')).join('\n')
    const messages = [...src.matchAll(/(?:log\?\.error\?\.|logger\.error)\(\s*[`']file-links: ([^`'${]+)/g)].map(m => m[1])
    expect(messages.length).toBeGreaterThanOrEqual(7)
    const known = [
      'worker run failed', 'FILE_LINK_RECONCILE_INTERVAL_HOURS is set but', 'sweep interrupted; will resume', 'sweep incomplete; old links may still work',
      'reconciliation overdue', 'reconciliation cursor unreadable', 'could not be read', 'planning failed', 'refusing an invalid company id',
    ]
    for (const k of known) expect(doc).toContain(k)
    for (const m of messages) expect(known.some(k => m.includes(k) || k.includes(m.trim()))).toBe(true)
  })

  // ── Policy C (ADR-75): the planning heartbeat — PREPARED, not created ──────
  const HEARTBEAT = 'file-links: reconciliation plan complete'

  it('the heartbeat metric counts EXACTLY the line the worker writes at the end of a planning pass, from that one container', () => {
    const m = read(METRIC)
    expect(m.name).toBe('dc46_reconciliation_plan_complete')
    // The source still writes this message, at info level, once per finished pass.
    const src = workerSource()
    expect(src).toContain(`log?.info?.('${HEARTBEAT}', { passSeq: cur.passSeq, ...counts`)
    expect(src.split(`'${HEARTBEAT}'`)).toHaveLength(2)
    // The filter matches the message EXACTLY (it carries no stack, unlike an
    // error line) in the container's stdout — where the worker's info lines
    // were found in production — and nothing else.
    expect(m.filter).toBe(`resource.type="cloud_run_revision" AND ${SERVICE} AND ${REGION} AND log_id("run.googleapis.com/stdout") AND jsonPayload.message="${HEARTBEAT}"`)
    // A plain counter: nothing copied out of the entry, no bucket scoping.
    expect(m.metricDescriptor).toEqual({ metricKind: 'DELTA', valueType: 'INT64', unit: '1', displayName: expect.any(String) })
    expect(m.labelExtractors).toBeUndefined()
    expect(m.valueExtractor).toBeUndefined()
    expect(m.bucketName).toBeUndefined()
    expect(m.disabled).toBeUndefined()
    const text = readFileSync(path.join(dir, METRIC), 'utf8')
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
  })

  it('policy C: absence of that metric, summed across revisions, for 3 hours — three planning periods', () => {
    const policy = read(POLICY_C)
    const c = policy.conditions[0].conditionAbsent
    expect(c.filter).toBe(`metric.type="logging.googleapis.com/user/${read(METRIC).name}" AND resource.type="cloud_run_revision" AND ${SERVICE} AND ${REGION}`)
    expect(c.duration).toBe('10800s')
    expect(c.trigger).toEqual({ count: 1 })
    // Same reasoning as policy A: a deploy starts a new per-revision series.
    expect(c.aggregations).toEqual(read('dc46-worker-no-successful-run.policy.json').conditions[0].conditionAbsent.aggregations)
    // Planning runs once an hour; 3 hours tolerates two late passes.
    const plan = workerSource().match(/export const PLAN_EVERY_MS = (\d+) \* (\d+) \* (\d+)\n/)
    expect(plan).not.toBe(null)
    const planMs = plan.slice(1).reduce((a, b) => a * Number(b), 1)
    expect(planMs).toBe(60 * 60 * 1000)
    expect(Number(c.duration.replace('s', '')) * 1000).toBe(3 * planMs)
    // Revocation may still be running: an error, not critical like policy A.
    expect(policy.severity).toBe('ERROR')
    expect(policy.alertStrategy).toEqual({ autoClose: '604800s' })
    expect(policy.userLabels.policy).toBe('c-planning-heartbeat')
    // The runbook says when it is expected, and that rollback disables it.
    expect(policy.documentation.content).toContain('This policy must be DISABLED as part of that rollback')
    expect(policy.documentation.content).toContain('planning paused; periodic queue is full')
    expect(policy.documentation.content).toContain(HEARTBEAT)
  })
})

// ── L3 Stage 1 — availability check and Final Account callable failure ───────
//
// CREATED in production 21 November 2026 (docs/DEPLOYMENT.md → L3 Stage 1).
// The availability policy file was aligned with the created policy during
// C1-D (24 November 2026 UTC). These pin the files against the things they must
// agree with in THIS repository: the page the check fetches, the function the
// policy watches, and the error codes that must not raise an alert.
describe('ops/monitoring L3 files', () => {
  const root = path.resolve(here, '../../..')
  const src = (p) => readFileSync(path.resolve(root, p), 'utf8')
  const HOST = 'app.constrap.com'

  it('the uptime check requests the production origin over verified HTTPS and holds no recipient or server-assigned name', () => {
    const text = readFileSync(path.join(dir, L3_UPTIME), 'utf8')
    const check = JSON.parse(text)
    expect(check.name).toBeUndefined()
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
    expect(check.monitoredResource).toEqual({ type: 'uptime_url', labels: { project_id: 'constrapp-69b5d', host: HOST } })
    expect(check.httpCheck).toEqual({
      requestMethod: 'GET', useSsl: true, validateSsl: true, port: 443, path: '/',
      acceptedResponseStatusCodes: [{ statusValue: 200 }],
    })
    // The only periods the API accepts are 60s, 300s, 600s and 900s; the
    // timeout must be 1 to 60 seconds. No region list: every checker region.
    expect(check.period).toBe('300s')
    expect(check.timeout).toBe('10s')
    expect(check.selectedRegions).toBeUndefined()
    expect(check.checkerType).toBe('STATIC_IP_CHECKERS')
    // The production origin is the one the app documents.
    expect(src('docs/DEPLOYMENT.md')).toContain(`https://${HOST}`)
  })

  it('the uptime check\'s content match is text the built page really contains', () => {
    const check = read(L3_UPTIME)
    expect(check.contentMatchers).toEqual([{ matcher: 'CONTAINS_STRING', content: '<div id="root"></div>' }])
    // Vite copies index.html into the build; Hosting rewrites every path to
    // it. If the shell element ever changes, this check must change with it.
    expect(src('frontend/index.html')).toContain(check.contentMatchers[0].content)
  })

  it('the availability policy alerts only on repeated failure: two or more locations, for two check periods', () => {
    const policy = read(L3_UPTIME_POLICY)
    const c = policy.conditions[0].conditionThreshold
    // Tied to the ONE check by host AND by the check's id. The id is assigned
    // by the server when the check is created (21 November 2026); this file
    // records the production policy as created, verified read-only on
    // 24 November 2026 UTC (C1-D). The server derives the id from the check's
    // display name, so the id must still belong to the committed check. If the
    // check is ever re-created it gets a new id, and this policy must be
    // re-created with it.
    const CHECK_ID = 'l3-app-constrap-com-https-availability-10ehOIKFFlc'
    const slug = read(L3_UPTIME).displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    expect(CHECK_ID).toMatch(new RegExp(`^${slug}-[A-Za-z0-9]+$`))
    expect(c.filter).toBe(`metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND resource.labels.host="${read(L3_UPTIME).monitoredResource.labels.host}" AND metric.label.check_id="${CHECK_ID}"`)
    // Grouped by every resource label of uptime_url (project_id, host): with
    // one host in one project that is one group, so REDUCE_COUNT_FALSE counts
    // the failing checker locations of this check — the same result as
    // grouping by host (compared over the check's whole history, C1-D).
    expect(c.aggregations).toEqual([{
      alignmentPeriod: '1200s', perSeriesAligner: 'ALIGN_NEXT_OLDER', crossSeriesReducer: 'REDUCE_COUNT_FALSE', groupByFields: ['resource.label.*'],
    }])
    // More than one failing location, never a single checker's bad minute.
    expect(c).toMatchObject({ comparison: 'COMPARISON_GT', thresholdValue: 1, trigger: { count: 1 } })
    const period = Number(read(L3_UPTIME).period.replace('s', ''))
    expect(Number(c.duration.replace('s', ''))).toBe(2 * period)
    expect(policy.severity).toBe('CRITICAL')
    // The limit of the check is stated to whoever receives the alert.
    expect(policy.documentation.content).toContain('What a passing check does NOT prove')
    expect(policy.documentation.content).toContain('ops/RUNBOOK.md')
  })

  it('the callable policy watches approveFinalAccount\'s own service, in its region, and nothing else', () => {
    const policy = read(L3_CALLABLE_POLICY)
    const c = policy.conditions[0].conditionThreshold
    const index = src('frontend/functions/src/index.js')
    // The Cloud Run service of a 2nd-gen function is its export name in lower case.
    expect(index).toContain('export const approveFinalAccount = onCall(')
    expect(c.filter).toBe(`metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.labels.service_name="${'approveFinalAccount'.toLowerCase()}" AND ${REGION} AND metric.labels.response_code_class="5xx"`)
    expect(c.filter).not.toContain('processfilelinkrevocations')
    // Summed across revisions, like policy A, so a deploy is not a new series.
    expect(c.aggregations).toEqual(read('dc46-worker-no-successful-run.policy.json').conditions[0].conditionAbsent.aggregations)
    // One server failure is enough: approvals are rare and each one matters.
    expect(c).toMatchObject({ comparison: 'COMPARISON_GT', thresholdValue: 0, duration: '0s', trigger: { count: 1 } })
    expect(policy.severity).toBe('ERROR')
    expect(policy.alertStrategy).toEqual({ autoClose: '3600s' })
  })

  it('no EXPECTED Final Account refusal is a 5xx, except the deliberate off switch, which the runbook names', () => {
    const errors = src('frontend/functions/src/lib/errors.js')
    // gRPC codes firebase-functions answers with an HTTP 5xx status.
    const SERVER = ['internal', 'unknown', 'unavailable', 'deadline-exceeded', 'data-loss', 'unimplemented']
    const grpc = Object.fromEntries([...errors.matchAll(/\[CODE\.([A-Z_]+)\]:\s+'([a-z-]+)',/g)].map(m => [m[1], m[2]]))
    const finalAccount = Object.entries(grpc).filter(([k]) => k === 'NOT_APPROVER' || k.startsWith('FINAL_ACCOUNT_'))
    expect(finalAccount.length).toBe(8)
    const fiveXx = finalAccount.filter(([, v]) => SERVER.includes(v)).map(([k]) => k)
    expect(fiveXx).toEqual(['FINAL_ACCOUNT_DISABLED'])
    const doc = read(L3_CALLABLE_POLICY).documentation.content
    expect(doc).toContain('FINAL_ACCOUNT_APPROVAL_ENABLED')
    expect(src('frontend/functions/src/lib/params.js')).toContain("defineBoolean('FINAL_ACCOUNT_APPROVAL_ENABLED'")
    // The runbook quotes the one error line the function writes, and the audit event.
    const index = src('frontend/functions/src/index.js')
    expect(index).toContain("logger.error('final account call failed'")
    expect(doc).toContain('final account call failed')
    expect(errors + src('frontend/functions/src/lib/audit.js')).toContain("'final_account.approved'")
    expect(doc).toContain('final_account.approved')
  })
})
