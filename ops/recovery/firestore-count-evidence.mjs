#!/usr/bin/env node
// ── Firestore restore verification — count evidence (L3 Stage 1) ─────────────
//
// READ-ONLY. This script sends exactly two kinds of request to the Firestore
// REST API and nothing else:
//   · POST …/documents:runAggregationQuery   — a COUNT per collection group
//   · GET  …/documents/<path>                — ONE optional sample document
// It never writes, deletes, restores or creates anything, and it prints no
// document content: counts, and for the sample only a SHA-256 of its fields.
//
// It authenticates as the operator through `gcloud auth print-access-token`
// (IAM, not Security Rules), so it works on a restored database whose rules
// deny every client.
//
// Usage (procedure: ops/recovery/README.md):
//
//   node ops/recovery/firestore-count-evidence.mjs \
//     --project constrapp-69b5d --database '(default)' \
//     --read-time 2026-11-20T17:01:00Z [--sample <document path>] > expected.json
//
//   node ops/recovery/firestore-count-evidence.mjs \
//     --project constrapp-69b5d --database restore-verify-20261121-0930 \
//     [--sample <document path>] --expect expected.json > restored.json
//
// --database has NO default on purpose: the operator always names the
// database being read. --read-time must be a whole minute (the API refuses
// anything else older than one hour) inside the point-in-time recovery window.
// With --expect the script exits 1 unless every count and the sample hash
// match the earlier output.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Every collection id the application, the Rules and the Functions use.
// Counted as COLLECTION GROUPS, so nesting depth does not matter. Pinned
// against the Rules and Functions sources by
// frontend/tests/unit/recoveryEvidence.test.js.
export const COLLECTION_GROUPS = [
  'activities', 'approvalPolicy', 'approvedBudget', 'auditEvents', 'boqItems', 'budgetAdjustments', 'budgetApprovalSnapshots',
  'budgetApprovals', 'budgetLines', 'cashFlowLines', 'clientCreditNotes', 'clientFinanceState',
  'clientInvoiceLedgers', 'clientInvoices', 'clientReceiptApplications', 'clientReceiptLedgers', 'clientReceipts',
  'clientRefunds', 'clientRetentionReleases',
  'commercial', 'companies', 'contacts', 'contractValueRevisions', 'costCodes', 'counters', 'devOutbox', 'documents',
  'drawings', 'estimateItemInputs', 'estimateState', 'estimates', 'fileLinkRevocationQueue', 'finalAccounts', 'forecastLines', 'invitations', 'lines',
  'members', 'poClaimLedgers', 'programmeBaselineSnapshots', 'programmeBaselines', 'progressClaims', 'projectDirectory',
  'projects', 'pulseAcknowledgements', 'purchaseOrders', 'rateLimits', 'retentionReleases', 'revisions',
  'rfis', 'supplierCreditNotes', 'supplierFinanceState', 'supplierInvoiceLedgers', 'supplierInvoices', 'supplierPayments', 'system',
  'takeoffMeasurements', 'takeoffPages', 'tenderBids', 'tenderPackages', 'users', 'variations',
]

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!['--project', '--database', '--read-time', '--sample', '--expect'].includes(key)) {
      throw new Error(`Unknown argument: ${key}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`)
    out[key.slice(2)] = value
    i += 1
  }
  if (!out.project) throw new Error('--project is required')
  if (!out.database) throw new Error('--database is required (it has no default)')
  if (out['read-time'] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(out['read-time'])) {
    throw new Error('--read-time must be a whole UTC minute, e.g. 2026-11-20T17:01:00Z')
  }
  if (out.sample && (out.sample.startsWith('/') || out.sample.split('/').length % 2 !== 0)) {
    throw new Error('--sample must be a document path such as companies/<id>/counters/<name>')
  }
  return out
}

// A stable text form of a document's `fields`: keys sorted, and the database
// segment of any reference value removed, so the same document hashes the
// same in the source and in a restored database.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => {
      const v = k === 'referenceValue' && typeof value[k] === 'string'
        ? value[k].replace(/^projects\/[^/]+\/databases\/[^/]+\//, '')
        : value[k]
      return `${JSON.stringify(k)}:${canonical(v)}`
    }).join(',')}}`
  }
  return JSON.stringify(value)
}

export const fieldsHash = (fields) => createHash('sha256').update(canonical(fields ?? {})).digest('hex')

export function compare(expected, actual) {
  const problems = []
  const groups = new Set([...Object.keys(expected.counts), ...Object.keys(actual.counts)])
  for (const g of [...groups].sort()) {
    if (expected.counts[g] !== actual.counts[g]) {
      problems.push(`${g}: expected ${expected.counts[g]}, found ${actual.counts[g]}`)
    }
  }
  if (expected.sample || actual.sample) {
    if (expected.sample?.fieldsSha256 !== actual.sample?.fieldsSha256) problems.push('sample: field hash differs')
  }
  return problems
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()
  const base = `https://firestore.googleapis.com/v1/projects/${args.project}/databases/${encodeURIComponent(args.database)}/documents`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const readTime = args['read-time']

  const counts = {}
  for (const collectionId of COLLECTION_GROUPS) {
    const body = {
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId, allDescendants: true }] },
        aggregations: [{ alias: 'n', count: {} }],
      },
      ...(readTime ? { readTime } : {}),
    }
    const res = await fetch(`${base}:runAggregationQuery`, { method: 'POST', headers, body: JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(`count of ${collectionId} failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
    counts[collectionId] = Number(json[0].result.aggregateFields.n.integerValue)
  }

  let sample
  if (args.sample) {
    const url = `${base}/${args.sample.split('/').map(encodeURIComponent).join('/')}${readTime ? `?readTime=${encodeURIComponent(readTime)}` : ''}`
    const res = await fetch(url, { headers })
    const json = await res.json()
    if (!res.ok) throw new Error(`sample read failed: HTTP ${res.status} ${json?.error?.status ?? ''}`)
    sample = { fieldCount: Object.keys(json.fields ?? {}).length, fieldsSha256: fieldsHash(json.fields) }
  }

  const result = {
    project: args.project,
    database: args.database,
    readTime: readTime ?? 'latest',
    takenAt: new Date().toISOString(),
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    ...(sample ? { sample } : {}),
  }
  console.log(JSON.stringify(result, null, 2))

  if (args.expect) {
    const problems = compare(JSON.parse(readFileSync(args.expect, 'utf8')), result)
    if (problems.length > 0) {
      console.error(`MISMATCH (${problems.length}):\n  ${problems.join('\n  ')}`)
      process.exit(1)
    }
    console.error(`MATCH: ${Object.keys(counts).length} collection groups, ${result.total} documents${sample ? ', sample hash equal' : ''}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(2) })
}
