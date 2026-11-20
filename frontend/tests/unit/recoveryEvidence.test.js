import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { COLLECTION_GROUPS, parseArgs, canonical, fieldsHash, compare } from '../../../ops/recovery/firestore-count-evidence.mjs'

// ── ops/recovery/firestore-count-evidence.mjs (L3 Stage 1) ───────────────────
//
// The operator script that produces the evidence for a Firestore restore
// verification (ops/recovery/README.md). It is run by hand, never by CI, and
// no restore has been performed. This suite keeps three things true:
//   · it can only READ (two request kinds, no write verb anywhere)
//   · it counts every collection the Rules, the hooks and the Functions use
//   · its argument, hashing and comparison logic behave as the runbook says
// It proves nothing about a real restore.

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const read = (p) => readFileSync(path.resolve(root, p), 'utf8')
const script = read('ops/recovery/firestore-count-evidence.mjs')

describe('firestore-count-evidence — read-only by construction', () => {
  it('sends only a count aggregation (POST) and one document GET, to the Firestore documents API', () => {
    expect(script.match(/fetch\(/g)).toHaveLength(2)
    expect(script).toContain('fetch(`${base}:runAggregationQuery`, { method: \'POST\'')
    expect(script).toContain('const res = await fetch(url, { headers })')
    expect(script).toContain('https://firestore.googleapis.com/v1/projects/${args.project}/databases/${encodeURIComponent(args.database)}/documents')
    for (const verb of ['PATCH', 'DELETE', 'PUT', ':commit', ':batchWrite', ':write', ':restore', 'databases.delete', 'firebase-admin']) {
      expect(script).not.toContain(verb)
    }
  })

  it('prints counts and a hash, never a document field', () => {
    expect(script).toContain('sample = { fieldCount: Object.keys(json.fields ?? {}).length, fieldsSha256: fieldsHash(json.fields) }')
    expect(script).not.toMatch(/console\.log\([^)]*fields/)
  })
})

describe('firestore-count-evidence — collection coverage', () => {
  it('is sorted, unique and free of path syntax', () => {
    expect([...COLLECTION_GROUPS].sort()).toEqual(COLLECTION_GROUPS)
    expect(new Set(COLLECTION_GROUPS).size).toBe(COLLECTION_GROUPS.length)
    for (const g of COLLECTION_GROUPS) expect(g).toMatch(/^[A-Za-z]+$/)
  })

  it('names every collection the Firestore Rules match', () => {
    const rules = read('frontend/firestore.rules')
    const matched = new Set([...rules.matchAll(/match \/(?:[^\s{]*\/)?([A-Za-z]+)\/\{/g)].map(m => m[1]))
    // `match /databases/{database}/documents` is the ruleset root, not a collection.
    matched.delete('databases')
    for (const m of rules.matchAll(/\/([A-Za-z]+)\/\{[A-Za-z]+\}/g)) if (m[1] !== 'databases') matched.add(m[1])
    // Single-document blocks written with a literal id.
    for (const m of rules.matchAll(/match \/\S*\/([A-Za-z]+)\/[A-Za-z]+ \{/g)) matched.add(m[1])
    for (const literal of ['approvedBudget', 'commercial']) expect(matched).toContain(literal)
    expect(matched.size).toBeGreaterThanOrEqual(30)
    for (const name of matched) expect(COLLECTION_GROUPS, `Rules collection ${name}`).toContain(name)
  })

  it('names every collection the hooks and the trusted backend address', () => {
    const hooksDir = path.resolve(root, 'frontend/src/hooks')
    const hooks = readdirSync(hooksDir).filter(f => /\.jsx?$/.test(f)).map(f => readFileSync(path.join(hooksDir, f), 'utf8')).join('\n')
    const fromHooks = [...hooks.matchAll(/(?:collection|doc)\(db,([^)]*)\)/g)]
      .flatMap(m => [...m[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1]))
    const fnDir = path.resolve(root, 'frontend/functions/src')
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') && d.indexOf('generated') === -1 ? [path.join(d, e.name)] : []))
    const fn = walk(fnDir).map(f => readFileSync(f, 'utf8')).join('\n')
    const fromFunctions = [
      ...[...fn.matchAll(/collection(?:Group)?\('([A-Za-z]+)'\)/g)].map(m => m[1]),
      ...[...fn.matchAll(/QUEUE_COLLECTION = '([A-Za-z]+)'/g)].map(m => m[1]),
    ]
    expect(fromFunctions).toContain('fileLinkRevocationQueue')
    // Document ids that appear as string segments in a path are not collections.
    const DOCUMENT_IDS = new Set(['baseline', 'current', 'membership', 'fileLinkRevocation', 'fileLinkReconciliation'])
    const names = new Set([...fromHooks, ...fromFunctions].filter(n => !DOCUMENT_IDS.has(n)))
    expect(names.size).toBeGreaterThanOrEqual(30)
    const missing = [...names].filter(n => !COLLECTION_GROUPS.includes(n))
    // Anything listed here is either a new collection (add it to the script)
    // or a literal document id (add it to DOCUMENT_IDS above).
    expect(missing).toEqual([])
  })
})

describe('firestore-count-evidence — arguments', () => {
  it('requires the project and the database: the database has no default', () => {
    expect(() => parseArgs(['--project', 'p'])).toThrow('--database is required')
    expect(() => parseArgs(['--database', 'd'])).toThrow('--project is required')
    expect(parseArgs(['--project', 'p', '--database', '(default)'])).toEqual({ project: 'p', database: '(default)' })
  })

  it('accepts a read time only at a whole UTC minute, as the API does', () => {
    const base = ['--project', 'p', '--database', 'd', '--read-time']
    expect(parseArgs([...base, '2026-11-20T17:01:00Z'])['read-time']).toBe('2026-11-20T17:01:00Z')
    for (const bad of ['2026-11-20T17:01:09Z', '2026-11-20T17:01:09.939894Z', '2026-11-20T17:01:00+13:00', '2026-11-20', 'now']) {
      expect(() => parseArgs([...base, bad])).toThrow('whole UTC minute')
    }
  })

  it('refuses unknown arguments, missing values and a sample that is not a document path', () => {
    expect(() => parseArgs(['--project', 'p', '--database', 'd', '--delete', 'x'])).toThrow('Unknown argument')
    expect(() => parseArgs(['--project', '--database', 'd'])).toThrow('needs a value')
    const base = ['--project', 'p', '--database', 'd', '--sample']
    expect(() => parseArgs([...base, 'companies'])).toThrow('document path')
    expect(() => parseArgs([...base, 'companies/a/counters'])).toThrow('document path')
    expect(() => parseArgs([...base, '/companies/a'])).toThrow('document path')
    expect(parseArgs([...base, 'companies/a/counters/rfis']).sample).toBe('companies/a/counters/rfis')
  })
})

describe('firestore-count-evidence — hashing and comparison', () => {
  it('hashes a document the same whatever the key order', () => {
    const a = { next: { integerValue: '12' }, label: { stringValue: 'x' } }
    const b = { label: { stringValue: 'x' }, next: { integerValue: '12' } }
    expect(canonical(a)).toBe(canonical(b))
    expect(fieldsHash(a)).toBe(fieldsHash(b))
    expect(fieldsHash(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(fieldsHash({ next: { integerValue: '13' } })).not.toBe(fieldsHash({ next: { integerValue: '12' } }))
    expect(fieldsHash(undefined)).toBe(fieldsHash({}))
  })

  it('ignores the database segment of a reference, so a restored copy hashes like its source', () => {
    const at = (db) => ({ ref: { referenceValue: `projects/p/databases/${db}/documents/companies/a` }, list: { arrayValue: { values: [{ referenceValue: `projects/p/databases/${db}/documents/x/y` }] } } })
    expect(fieldsHash(at('(default)'))).toBe(fieldsHash(at('restore-verify-20261121-0930')))
    expect(fieldsHash(at('(default)'))).not.toBe(fieldsHash({ ref: { referenceValue: 'projects/p/databases/(default)/documents/companies/b' } }))
  })

  it('reports every differing group and a differing or missing sample', () => {
    const expected = { counts: { a: 1, b: 2, c: 0 }, sample: { fieldsSha256: 'h1' } }
    expect(compare(expected, { counts: { a: 1, b: 2, c: 0 }, sample: { fieldsSha256: 'h1' } })).toEqual([])
    expect(compare(expected, { counts: { a: 1, b: 3 }, sample: { fieldsSha256: 'h2' } })).toEqual([
      'b: expected 2, found 3', 'c: expected 0, found undefined', 'sample: field hash differs',
    ])
    expect(compare(expected, { counts: { a: 1, b: 2, c: 0 } })).toEqual(['sample: field hash differs'])
    expect(compare({ counts: { a: 1 } }, { counts: { a: 1 } })).toEqual([])
  })
})
