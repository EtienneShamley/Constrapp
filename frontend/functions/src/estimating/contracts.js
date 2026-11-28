import { CODE, fail } from '../lib/errors.js'
import { isValidId } from '../lib/validation.js'
import * as calc from '../generated/estimatingCalc.js'

// ── Request contracts of `estimateOperation` (ADR-97) ────────────────────────
//
// `{ operation, request }`. The operation is chosen from a FIXED table — an
// unknown one is refused — and EACH operation has its own exact-key contract:
// identifiers, guards and authored content only. No request carries a
// quantity, a rate, an amount, a total or a selling price: the backend derives
// every figure from records it reads itself.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (d, keys) => isObject(d) && Object.keys(d).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(d, k))
const isRevision = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000
const bad = (field) => fail(CODE.INVALID_ARGUMENT, { field })

export const DISCARD_REASON_MAX = 500

function parseBuild(r) {
  if (!exactKeys(r, ['projectId', 'estimateId', 'expectedRevision', 'settings'])) bad('keys')
  if (!isValidId(r.projectId) || !isValidId(r.estimateId)) bad('ids')
  // 0 names a header whose FIRST build never completed (state `building`): its
  // rebuild by another member, once the build lease has passed.
  if (r.expectedRevision !== null && !(r.expectedRevision === 0 || isRevision(r.expectedRevision))) bad('expectedRevision')
  const problem = calc.estimateSettingsProblem(r.settings)
  if (problem) fail(CODE.INVALID_ARGUMENT, { field: 'settings', message: problem })
  return { projectId: r.projectId, estimateId: r.estimateId, expectedRevision: r.expectedRevision, settings: calc.normaliseEstimateSettings(r.settings) }
}

function parseApprove(r) {
  if (!exactKeys(r, ['projectId', 'estimateId', 'expectedRevision', 'contentSha256'])) bad('keys')
  if (!isValidId(r.projectId) || !isValidId(r.estimateId)) bad('ids')
  if (!isRevision(r.expectedRevision)) bad('expectedRevision')
  if (typeof r.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.contentSha256)) bad('contentSha256')
  return { ...r }
}

function parseDiscard(r) {
  if (!exactKeys(r, ['projectId', 'estimateId', 'expectedRevision', 'reason'])) bad('keys')
  if (!isValidId(r.projectId) || !isValidId(r.estimateId)) bad('ids')
  if (!Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0 || r.expectedRevision > 1_000_000) bad('expectedRevision')
  if (typeof r.reason !== 'string' || r.reason.length > DISCARD_REASON_MAX) bad('reason')
  return { ...r, reason: r.reason.trim() }
}

function parseSetComponents(r) {
  if (!exactKeys(r, ['projectId', 'items'])) bad('keys')
  if (!isValidId(r.projectId)) bad('ids')
  if (!Array.isArray(r.items) || r.items.length < 1 || r.items.length > calc.SET_COMPONENTS_MAX_ITEMS) bad('items')
  const seen = new Set()
  const items = r.items.map((it) => {
    if (!exactKeys(it, ['boqItemId', 'components']) || !isValidId(it.boqItemId) || seen.has(it.boqItemId)) bad('items')
    seen.add(it.boqItemId)
    if (it.components === null) return { boqItemId: it.boqItemId, components: null }
    if (!exactKeys(it.components, calc.COMPONENT_KEYS) || calc.COMPONENT_KEYS.some(k => calc.rateUnits(it.components[k]) === null)) bad('components')
    return { boqItemId: it.boqItemId, components: Object.fromEntries(calc.COMPONENT_KEYS.map(k => [k, it.components[k]])) }
  })
  return { projectId: r.projectId, items }
}

const PARSERS = { build: parseBuild, approve: parseApprove, discard: parseDiscard, setComponents: parseSetComponents }
export const ESTIMATE_OPERATION_NAMES = Object.keys(PARSERS)

export function parseEstimateOperation(data) {
  if (!exactKeys(data, ['operation', 'request']) || typeof data.operation !== 'string' || !Object.prototype.hasOwnProperty.call(PARSERS, data.operation)) {
    fail(CODE.INVALID_ARGUMENT, { field: 'envelope' })
  }
  return { operation: data.operation, input: PARSERS[data.operation](data.request) }
}
