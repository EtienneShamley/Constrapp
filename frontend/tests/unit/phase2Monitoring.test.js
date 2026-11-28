import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ── ops/monitoring/phase2 — Phase 2 alert policy and metric definitions ──────
//
// PREPARED, NOT CREATED. These request bodies are applied by hand
// (`gcloud logging metrics create --config-from-file`, `gcloud monitoring
// policies create --policy-from-file`) only on the Product Owner's
// authorisation, at the cutover stage the README names. Nothing in CI creates
// them. This suite keeps the committed files honest:
//   · no recipient, channel or address is ever committed
//   · every filter is scoped to the exact Phase 2 services (the callables
//     exported by functions/src/index.js), in the one region
//   · every refusal code in functions/src/lib/errors.js is classified once,
//     and only the alerting classes can raise an alert
//   · the log fields the filters rely on are the ones the callables write
// It proves nothing about Cloud Monitoring itself.

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '../../../ops/monitoring/phase2')
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
const policies = files.filter(f => f.endsWith('.policy.json'))
const metrics = files.filter(f => f.endsWith('.metric.json'))
const index = readFileSync(path.resolve(here, '../../functions/src/index.js'), 'utf8')
const errors = readFileSync(path.resolve(here, '../../functions/src/lib/errors.js'), 'utf8')
const classes = read('phase2-refusal-codes.json').classes

const NEW = ['createVariation', 'updateVariationDraft', 'approveVariation', 'applyVariationCommitment', 'progressClaimOperation', 'supplierInvoiceOperation', 'supplierSettlementOperation', 'postClientRefund', 'voidClientRefund', 'postClientReceiptApplication', 'voidClientReceiptApplication', 'voidClientInvoice', 'contractValueOperation', 'estimateOperation']
const CHANGED = ['postClientCreditNote', 'voidClientCreditNote', 'postClientRetentionRelease', 'voidClientRetentionRelease', 'postClientReceipt', 'voidClientReceipt', 'transferBoqToBudget', 'approveFinalAccount']
const SERVICES = [...NEW, ...CHANGED].map(n => n.toLowerCase())
const filterOf = (o) => o.filter ?? o.conditions[0].conditionMatchedLog?.filter ?? o.conditions[0].conditionThreshold.filter
const quoted = (s) => [...s.matchAll(/"([a-z0-9-]+)"/g)].map(m => m[1])

describe('ops/monitoring/phase2 — files', () => {
  it('are the seven policies, the four log-based metrics and the code classification', () => {
    expect(policies).toEqual([
      'phase2-baseline-failure.policy.json', 'phase2-callable-error-log.policy.json', 'phase2-callable-server-failure.policy.json',
      'phase2-contention-repeated.policy.json', 'phase2-financial-inconsistency.policy.json', 'phase2-infrastructure-repeated.policy.json',
      'phase2-request-surge.policy.json',
    ])
    expect(metrics).toEqual([
      'phase2-baselines-established.metric.json', 'phase2-contention-refusals.metric.json', 'phase2-infrastructure-failures.metric.json', 'phase2-refusals-by-code.metric.json',
    ])
    expect(files).toHaveLength(policies.length + metrics.length + 1)
  })

  it.each(files)('%s carries no recipient, channel, address or server-assigned name', (name) => {
    const text = readFileSync(path.join(dir, name), 'utf8')
    const body = JSON.parse(text)
    expect(body.notificationChannels).toBeUndefined()
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
    expect(text).not.toMatch(/notificationChannels\//)
    if (name.endsWith('.policy.json')) expect(body.name).toBeUndefined()
  })

  it.each(policies)('%s is one enabled condition with documentation inside the API limits', (name) => {
    const p = read(name)
    expect(p.enabled).toBe(true)
    expect(p.combiner).toBe('OR')
    expect(p.conditions).toHaveLength(1)
    expect(['ERROR', 'WARNING']).toContain(p.severity)
    expect(p.documentation.mimeType).toBe('text/markdown')
    expect(p.documentation.content.length).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(p.documentation.subject, 'utf8')).toBeLessThanOrEqual(255)
    expect(filterOf(p).length).toBeLessThanOrEqual(2048)
    for (const [k, v] of Object.entries(p.userLabels)) expect(`${k}=${v}`).toMatch(/^[a-z][a-z0-9_-]*=[a-z0-9_-]+$/)
    if (p.conditions[0].conditionMatchedLog) {
      // Required for a log-match policy; nothing from the entry is copied out.
      expect(p.alertStrategy.notificationRateLimit).toEqual({ period: '3600s' })
      expect(p.conditions[0].conditionMatchedLog.labelExtractors).toBeUndefined()
    }
  })
})

describe('ops/monitoring/phase2 — scope', () => {
  it('names exactly the Phase 2 services, which index.js exports', () => {
    for (const n of [...NEW, ...CHANGED]) expect(index).toMatch(new RegExp(`export const ${n}\\s*=`))
    for (const name of files.filter(f => f !== 'phase2-refusal-codes.json')) {
      const f = filterOf(read(name))
      expect(f).toContain('resource.type="cloud_run_revision"')
      expect(f).toContain('resource.labels.location="australia-southeast1"')
      if (f.includes('service_name')) {
        const listed = quoted(f.slice(f.indexOf('service_name'), f.indexOf(')', f.indexOf('service_name'))))
        // approveFinalAccount's 5xx are already alerted by the L3 policy.
        expect(listed.sort(), name).toEqual((name === 'phase2-callable-server-failure.policy.json' ? SERVICES.filter(s => s !== 'approvefinalaccount') : SERVICES).sort())
      }
    }
  })

  it('reads the user metrics by the names they are created under', () => {
    for (const [policy, metric] of [['phase2-contention-repeated.policy.json', 'phase2-contention-refusals.metric.json'], ['phase2-infrastructure-repeated.policy.json', 'phase2-infrastructure-failures.metric.json']]) {
      expect(filterOf(read(policy))).toContain(`metric.type="logging.googleapis.com/user/${read(metric).name}"`)
    }
  })

  it('never extracts anything but the refusal code from a log entry', () => {
    for (const m of metrics.map(read)) {
      if (m.name === 'phase2_refusals_by_code') expect(m.labelExtractors).toEqual({ code: 'EXTRACT(jsonPayload.code)' })
      else expect(m.labelExtractors).toBeUndefined()
      // No filter or extractor ever touches the caller, a figure or a payload field.
      expect(m.filter + JSON.stringify(m.labelExtractors ?? {})).not.toMatch(/jsonPayload\.(uid|projectId|[A-Za-z]*Cents|amount|legacy)/i)
    }
  })
})

describe('ops/monitoring/phase2 — refusal codes', () => {
  const defined = [...errors.slice(errors.indexOf('export const CODE = {'), errors.indexOf('const GRPC')).matchAll(/:\s*'([a-z-]+)'/g)].map(m => m[1]).sort()
  const classified = Object.values(classes).flatMap(c => c.codes)

  it('classifies every code errors.js defines, exactly once', () => {
    expect(defined.length).toBeGreaterThanOrEqual(120)
    expect([...classified].sort()).toEqual(defined)
    for (const c of Object.values(classes)) expect([...c.codes].sort()).toEqual(c.codes)
  })

  it('alerts on baseline, inconsistency and contention codes only — never on an ordinary refusal', () => {
    const codesIn = (name) => quoted(filterOf(read(name)).slice(filterOf(read(name)).indexOf('jsonPayload.code=')))
    expect(codesIn('phase2-baseline-failure.policy.json').sort()).toEqual(classes.baselineFailure.codes)
    expect(codesIn('phase2-financial-inconsistency.policy.json').sort()).toEqual(classes.financialInconsistency.codes)
    expect(codesIn('phase2-contention-refusals.metric.json').sort()).toEqual(classes.contention.codes)
    const quiet = [...classes.businessRefusal.codes, ...classes.notActivated.codes, ...classes.switchOff.codes, ...classes.teamOnly.codes]
    for (const name of files.filter(f => f !== 'phase2-refusal-codes.json' && f !== 'phase2-refusals-by-code.metric.json')) {
      for (const code of quiet) expect(filterOf(read(name)), `${name} ${code}`).not.toContain(`"${code}"`)
    }
  })

  it('M1: client-ledger-invariant pages everywhere except the two approved void-invariant refusals, which stay counted', () => {
    // The live Phase 1 void of a posted client credit note / retention release
    // refuses a void that would breach an invariant with this code (ADR-89 Void
    // policy) — an ordinary user outcome. Only that (code, fn) pair is excluded.
    const f = filterOf(read('phase2-financial-inconsistency.policy.json'))
    expect(f).toContain(' AND (jsonPayload.code=("client-entry-invalid" OR ')
    expect(f.endsWith(' OR (jsonPayload.code="client-ledger-invariant" AND NOT jsonPayload.fn=("voidClientCreditNote" OR "voidClientRetentionRelease")))')).toBe(true)
    expect(f.match(/client-ledger-invariant/g)).toHaveLength(1)
    expect(f.match(/jsonPayload\.fn/g)).toHaveLength(1)
    // `fn` is the exported name the client-finance wrapper logs on every refusal.
    for (const n of ['voidClientCreditNote', 'voidClientRetentionRelease']) expect(index).toMatch(new RegExp(`export const ${n}\\s*= clientFinanceCall\\('${n}'\\)`))
    expect(index).toMatch(/logger\.info\('client finance call refused', \{ fn: name, code: err\.details\.code/)
    // The refusal being excluded is the void path's invariant check.
    const tx = readFileSync(path.resolve(here, '../../functions/src/clientFinance/transactions.js'), 'utf8')
    expect(tx).toContain('if (broken) fail(CODE.CLIENT_LEDGER_INVARIANT, { invariant: broken, number: refused.number })')
    // Still visible: the refusal metric counts every code of these services.
    const metric = filterOf(read('phase2-refusals-by-code.metric.json'))
    expect(metric).toContain('"voidclientcreditnote"')
    expect(metric).toContain('"voidclientretentionrelease"')
    expect(metric).not.toContain('jsonPayload.fn')
  })

  it('maps the switch-off codes to HTTP 503 and every alerting refusal to a 4xx', () => {
    const grpc = (code) => {
      const key = errors.slice(0, errors.indexOf('const GRPC')).match(new RegExp(`([A-Z_]+):\\s*'${code}'`))[1]
      return errors.match(new RegExp(`\\[CODE\\.${key}\\]:\\s*'([a-z-]+)'`))[1]
    }
    for (const c of classes.switchOff.codes) expect(grpc(c), c).toBe('unavailable')
    for (const c of [...classes.baselineFailure.codes, ...classes.financialInconsistency.codes, ...classes.contention.codes, ...classes.notActivated.codes, ...classes.businessRefusal.codes]) {
      expect(['unavailable', 'internal', 'unknown', 'deadline-exceeded']).not.toContain(grpc(c))
    }
  })
})

describe('ops/monitoring/phase2 — the log lines the filters rely on', () => {
  const REFUSED = ['variation call refused', 'supplier-finance call refused', 'client finance call refused', 'contract-value call refused', 'estimate call refused', 'boq transfer call refused', 'final account call refused']

  it('every financial wrapper logs a typed refusal at INFO with `code`, and anything else at ERROR with `stack`', () => {
    for (const m of REFUSED) {
      expect(index).toMatch(new RegExp(`logger\\.info\\('${m}', \\{[^}]*code: err\\.details\\.code`))
      const failed = m.replace('refused', 'failed')
      expect(index).toMatch(new RegExp(`logger\\.error\\('${failed}', \\{[^}]*stack: err\\?\\.stack`))
    }
    // The refusal filters name exactly these messages.
    const f = filterOf(read('phase2-baseline-failure.policy.json'))
    for (const m of REFUSED) expect(f).toContain(`"${m}"`)
  })

  it('matches error lines by substring: the Functions logger turns an ERROR message into a stack', () => {
    // firebase-functions/logger: severity ERROR → message = new Error(message).stack,
    // which also OVERWRITES a `message` field passed in the data object.
    const logger = readFileSync(path.resolve(here, '../../functions/node_modules/firebase-functions/lib/logger/index.js'), 'utf8')
    expect(logger).toContain('if (severity === "ERROR" && !args.find((arg) => arg instanceof Error))')
    expect(logger).toContain('message = new Error(message).stack || message')
    const infra = filterOf(read('phase2-infrastructure-failures.metric.json'))
    expect(infra).toContain('jsonPayload.message:"call failed"')
    expect(infra).toContain('jsonPayload.stack:"DEADLINE_EXCEEDED"')
  })

  it('counts the baseline completions the backend logs', () => {
    expect(readFileSync(path.resolve(here, '../../functions/src/supplierFinance/baseline.js'), 'utf8')).toContain("log.info('supplier-finance baseline', {")
    expect(readFileSync(path.resolve(here, '../../functions/src/clientFinance/baseline.js'), 'utf8')).toContain("log.info('client receipt baseline established', {")
  })
})

// ── API field constraints ────────────────────────────────────────────────────
//
// Block 3 (28 Nov 2026) stopped at `alertPolicies.create` with
// "`display_name` must not be more than 100 characters": a CONDITION display
// name of 118 characters. That limit is enforced by the service and is NOT in
// the published v3 reference (which states 512 for the POLICY name only), so
// it is pinned here as OBSERVED. Every other bound below is the documented
// one (monitoring v3 AlertPolicy / MetricThreshold / Aggregation /
// Documentation; logging v2 LogMetric / MetricDescriptor / LabelDescriptor).
// This is schema validation of the request bodies. It is not API acceptance:
// neither API has a validate-only create, so only creation proves that.
const seconds = (d) => { expect(d).toMatch(/^\d+s$/); return Number(d.slice(0, -1)) }
const CONDITION_KEYS = { conditionMatchedLog: ['filter'], conditionThreshold: ['aggregations', 'comparison', 'duration', 'filter', 'thresholdValue', 'trigger'] }
const ALIGNERS = ['ALIGN_DELTA', 'ALIGN_RATE', 'ALIGN_SUM', 'ALIGN_COUNT', 'ALIGN_MEAN', 'ALIGN_MIN', 'ALIGN_MAX']
const REDUCERS = ['REDUCE_SUM', 'REDUCE_COUNT', 'REDUCE_MEAN', 'REDUCE_MIN', 'REDUCE_MAX']

describe('ops/monitoring/phase2 — API field constraints', () => {
  it.each(policies)('%s: names, labels, strategy and documentation are inside the limits', (name) => {
    const p = read(name)
    // Only fields alertPolicies.create accepts from a client; nothing server-assigned.
    expect(Object.keys(p).sort()).toEqual(['alertStrategy', 'combiner', 'conditions', 'displayName', 'documentation', 'enabled', 'severity', 'userLabels'])
    // Documented 512 for the policy; the stricter observed 100 is applied to both names.
    expect(p.displayName.trim()).toBe(p.displayName)
    expect([...p.displayName].length).toBeGreaterThan(0)
    expect([...p.displayName].length).toBeLessThanOrEqual(100)
    expect(['AND', 'OR', 'AND_WITH_MATCHING_RESOURCE']).toContain(p.combiner)
    expect(['CRITICAL', 'ERROR', 'WARNING']).toContain(p.severity)
    expect(p.conditions.length).toBeGreaterThanOrEqual(1)
    expect(p.conditions.length).toBeLessThanOrEqual(6)
    // userLabels: at most 64; key and value at most 63 characters; lowercase
    // letters, digits, underscores and dashes; a key begins with a letter.
    const labels = Object.entries(p.userLabels)
    expect(labels.length).toBeLessThanOrEqual(64)
    for (const [k, v] of labels) {
      expect(k).toMatch(/^[a-z][a-z0-9_-]{0,62}$/)
      expect(v).toMatch(/^[a-z0-9_-]{1,63}$/)
    }
    expect(p.userLabels.programme).toBe('phase2')
    expect(`phase2-${p.userLabels.policy}.policy.json`).toBe(name)
    // Documentation: markdown only; content 8,192 characters AND 10,240 bytes; subject 255 bytes.
    expect(Object.keys(p.documentation).sort()).toEqual(['content', 'mimeType', 'subject'])
    expect(p.documentation.mimeType).toBe('text/markdown')
    expect([...p.documentation.content].length).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(p.documentation.content, 'utf8')).toBeLessThanOrEqual(10240)
    expect(Buffer.byteLength(p.documentation.subject, 'utf8')).toBeGreaterThan(0)
    expect(Buffer.byteLength(p.documentation.subject, 'utf8')).toBeLessThanOrEqual(255)
    // autoClose: at least 30 minutes, at most 7 days.
    expect(seconds(p.alertStrategy.autoClose)).toBeGreaterThanOrEqual(1800)
    expect(seconds(p.alertStrategy.autoClose)).toBeLessThanOrEqual(604800)
  })

  it.each(policies)('%s: every condition is one supported, fully specified type', (name) => {
    const p = read(name)
    const seen = new Set()
    for (const c of p.conditions) {
      // The observed service limit that stopped Block 3.
      expect([...c.displayName].length).toBeGreaterThan(0)
      expect([...c.displayName].length).toBeLessThanOrEqual(100)
      expect(seen.has(c.displayName)).toBe(false)
      seen.add(c.displayName)
      expect(c.name).toBeUndefined()
      const types = Object.keys(c).filter(k => k !== 'displayName')
      expect(types).toHaveLength(1)
      const type = types[0]
      expect(Object.keys(CONDITION_KEYS)).toContain(type)
      expect(Object.keys(c[type]).sort()).toEqual(CONDITION_KEYS[type])
      const f = c[type].filter
      expect(typeof f).toBe('string')
      expect(f.trim()).toBe(f)
      expect(f.length).toBeGreaterThan(0)
      // Balanced quotes and parentheses: a truncated or mis-edited filter never ships.
      expect((f.match(/"/g) ?? []).length % 2).toBe(0)
      expect((f.match(/\(/g) ?? []).length).toBe((f.match(/\)/g) ?? []).length)
      if (type === 'conditionMatchedLog') {
        // A log-match condition must be the only condition, is combined by OR,
        // and REQUIRES a notification rate limit (5 minutes to 2 days).
        expect(p.conditions).toHaveLength(1)
        expect(p.combiner).toBe('OR')
        expect(Object.keys(p.alertStrategy).sort()).toEqual(['autoClose', 'notificationRateLimit'])
        const period = seconds(p.alertStrategy.notificationRateLimit.period)
        expect(period).toBeGreaterThanOrEqual(300)
        expect(period).toBeLessThanOrEqual(172800)
        expect(f).toMatch(/^resource\.type="cloud_run_revision" AND /)
        expect(f.length).toBeLessThanOrEqual(20000)
      } else {
        // The rate limit is not implemented for a non-log policy: never sent.
        expect(Object.keys(p.alertStrategy)).toEqual(['autoClose'])
        const t = c.conditionThreshold
        // The filter names the metric type AND the resource type; at most 2,048 characters.
        expect(f.length).toBeLessThanOrEqual(2048)
        expect(f).toMatch(/^metric\.type="[a-z0-9_./-]+" AND resource\.type="cloud_run_revision" AND /)
        // Only COMPARISON_GT and COMPARISON_LT are supported.
        expect(['COMPARISON_GT', 'COMPARISON_LT']).toContain(t.comparison)
        expect(typeof t.thresholdValue).toBe('number')
        expect(Number.isFinite(t.thresholdValue)).toBe(true)
        // duration: a whole number of minutes (0 allowed).
        expect(seconds(t.duration) % 60).toBe(0)
        expect(Object.keys(t.trigger)).toEqual(['count'])
        expect(Number.isInteger(t.trigger.count)).toBe(true)
        expect(t.trigger.count).toBeGreaterThanOrEqual(1)
        expect(t.aggregations).toHaveLength(1)
        for (const a of t.aggregations) {
          expect(Object.keys(a).sort()).toEqual(['alignmentPeriod', 'crossSeriesReducer', 'groupByFields', 'perSeriesAligner'])
          // alignmentPeriod: at least 60 s, at most 25 h for an alerting policy, whole minutes.
          const period = seconds(a.alignmentPeriod)
          expect(period).toBeGreaterThanOrEqual(60)
          expect(period).toBeLessThanOrEqual(90000)
          expect(period % 60).toBe(0)
          // A reducer requires an aligner other than ALIGN_NONE; both metrics
          // read here are DELTA / INT64 counters, for which these are valid.
          expect(ALIGNERS).toContain(a.perSeriesAligner)
          expect(REDUCERS).toContain(a.crossSeriesReducer)
          expect(a.groupByFields).toEqual(['resource.labels.service_name'])
        }
      }
    }
  })

  it.each(metrics)('%s: a counter the logging API accepts, named as its file and as the policies read it', (name) => {
    const m = read(name)
    expect(Object.keys(m).filter(k => k !== 'labelExtractors').sort()).toEqual(['description', 'filter', 'metricDescriptor', 'name'])
    // Identifier: at most 100 characters from the permitted set, not starting with "/".
    expect(m.name).toMatch(/^[A-Za-z0-9_\-.,+!*'()%][A-Za-z0-9_\-.,+!*'()%/]{0,99}$/)
    expect(`phase2-${m.name.replace(/^phase2_/, '').replaceAll('_', '-')}.metric.json`).toBe(name)
    expect(m.description.length).toBeGreaterThan(0)
    expect(m.description.length).toBeLessThanOrEqual(8000)
    expect(m.filter.length).toBeGreaterThan(0)
    expect(m.filter.length).toBeLessThanOrEqual(20000)
    expect(m.filter).toMatch(/^resource\.type="cloud_run_revision" AND /)
    expect((m.filter.match(/"/g) ?? []).length % 2).toBe(0)
    expect((m.filter.match(/\(/g) ?? []).length).toBe((m.filter.match(/\)/g) ?? []).length)
    // A counter: DELTA / INT64 / unit "1"; name, type and description of the
    // descriptor are output only and never sent.
    const d = m.metricDescriptor
    expect(Object.keys(d).filter(k => k !== 'labels').sort()).toEqual(['displayName', 'metricKind', 'unit', 'valueType'])
    expect(d.metricKind).toBe('DELTA')
    expect(d.valueType).toBe('INT64')
    expect(d.unit).toBe('1')
    expect(d.displayName.length).toBeGreaterThan(0)
    expect(d.displayName.length).toBeLessThanOrEqual(100)
    // Every descriptor label has an extractor and every extractor a label; at most 10.
    const labels = d.labels ?? []
    expect(labels.length).toBeLessThanOrEqual(10)
    expect(labels.map(l => l.key).sort()).toEqual(Object.keys(m.labelExtractors ?? {}).sort())
    for (const l of labels) {
      expect(l.key).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/)
      expect(['STRING', 'BOOL', 'INT64']).toContain(l.valueType)
      expect(m.labelExtractors[l.key]).toMatch(/^(EXTRACT\([A-Za-z0-9_.]+\)|REGEXP_EXTRACT\(.+\))$/)
    }
  })

  it('no two policies and no two metrics share a display name', () => {
    const names = policies.map(f => read(f).displayName)
    expect(new Set(names).size).toBe(names.length)
    const metricNames = metrics.map(f => read(f).name)
    expect(new Set(metricNames).size).toBe(metricNames.length)
  })
})
