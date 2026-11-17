import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ── DC46-C monitoring — the committed alert policy and metric files ──────────
//
// ops/monitoring/*.policy.json are applied by hand with
// `gcloud monitoring policies create --policy-from-file`, and the one
// *.metric.json with `gcloud logging metrics create --config-from-file`, each
// only once authorised (docs/DEPLOYMENT.md → DC46-C monitoring readiness).
// Policies A and B were created in production on 16 November 2026; policy C
// and its metric are PREPARED, not created. Nothing in CI creates any of them.
// This suite only keeps the committed files honest:
//   · no recipient, channel or address is ever committed
//   · each policy stays scoped to the ONE worker service
//   · the settings that were verified against production stay as verified
// It proves nothing about Cloud Monitoring itself.

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ops/monitoring')
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
const files = readdirSync(dir).filter(f => f.endsWith('.policy.json')).sort()
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
  it('are exactly the three standing policies, the heartbeat metric and the one temporary delivery test', () => {
    expect(files).toEqual([POLICY_C, 'dc46-worker-error-log.policy.json', 'dc46-worker-no-successful-run.policy.json'])
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).sort()).toEqual([TEMPORARY, METRIC, ...files].sort())
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
