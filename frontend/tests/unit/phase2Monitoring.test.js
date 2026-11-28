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
