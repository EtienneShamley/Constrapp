import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  TOKEN_KEY, LIST_FIELDS, MAX_ATTEMPTS, OUTCOME, companyPrefix, listPage, removeToken, sweepPage, inventoryCompany,
} from '../src/lib/fileLinkTokens.js'
import {
  FILE_LINK_STATUS, DELAY_AFTER_MS, LEGACY_MARGIN_MS, REASON, fileLinkStatus, fileLinkRow, reducesFileAccess,
} from '../src/lib/fileLinkRevocation.js'
import { AUDIT, auditPayload } from '../src/lib/audit.js'
import { fakeBucket, seedObjects, drawingObject, documentObject, tokensLeft, SECRET } from './_fakeBucket.js'
import { Storage } from '@google-cloud/storage'

// ── ADR-74 (DC46-B) — pure tests: the Storage side and the status rule ───────
//
// No emulator and no network. The bucket is a fake that models the Cloud
// Storage behaviour verified for ADR-74 (see _fakeBucket.js). The durable
// state machine is covered against the Firestore emulator in
// frontend/tests/functions/team.fileLinks.test.js.

const noSleep = async () => {}
const recorder = () => {
  const lines = []
  const push = (level) => (msg, fields) => lines.push({ level, msg, fields })
  return { lines, info: push('info'), warn: push('warn'), error: push('error') }
}
const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('company scope (tenant isolation)', () => {
  it('builds exactly companies/{id}/ and refuses anything that is not a plain id', () => {
    expect(companyPrefix('acme')).toBe('companies/acme/')
    for (const bad of ['', 'a/b', '../x', 'acme/', 'a b', null, undefined, 'x'.repeat(65), '*']) {
      expect(() => companyPrefix(bad), String(bad)).toThrow(/invalid company id/)
    }
  })

  it('a sweep of one company never lists or changes a company whose id merely starts the same', async () => {
    const bucket = fakeBucket({ ...seedObjects('acme', 3), ...seedObjects('acme-two', 3), ...seedObjects('other', 2) })
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    expect(page).toMatchObject({ scanned: 3, withToken: 3, removed: 3, failed: 0, nextPageToken: null })
    expect(tokensLeft(bucket, 'companies/acme/')).toBe(0)
    expect(tokensLeft(bucket, 'companies/acme-two/')).toBe(3)
    expect(tokensLeft(bucket, 'companies/other/')).toBe(2)
    expect(bucket.calls.list.every(q => q.prefix === 'companies/acme/')).toBe(true)
    expect(bucket.calls.patch.every(c => c.name.startsWith('companies/acme/'))).toBe(true)
  })

  it('stops if a listing ever returns an object outside the company prefix', async () => {
    const bucket = fakeBucket(seedObjects('acme', 1))
    bucket.getFiles = async () => [[{ name: 'companies/other/x/original.pdf', generation: '1', metageneration: '1' }], null]
    await expect(listPage(bucket, 'acme')).rejects.toThrow(/outside the company prefix/)
  })
})

describe('listing', () => {
  it('pages through a company with a bounded page size, a field mask and no auto-pagination', async () => {
    const bucket = fakeBucket(seedObjects('acme', 5))
    const seen = []
    let token = null
    do {
      const page = await listPage(bucket, 'acme', token, { pageSize: 2 })
      seen.push(...page.items.map(i => i.name))
      token = page.nextPageToken
    } while (token)
    expect(seen).toEqual([1, 2, 3, 4, 5].map(n => drawingObject('acme', n)))
    expect(bucket.calls.list).toHaveLength(3)
    for (const q of bucket.calls.list) {
      expect(q).toMatchObject({ prefix: 'companies/acme/', autoPaginate: false, maxResults: 2, fields: LIST_FIELDS })
    }
    expect(LIST_FIELDS).toBe(`items(name,generation,metageneration,metadata/${TOKEN_KEY}),nextPageToken`)
  })

  it('reduces each object to identity, version counters and a boolean — the token value goes no further', async () => {
    const bucket = fakeBucket({ ...seedObjects('acme', 1), [documentObject('acme', 1)]: { metadata: { keep: 'yes' } } })
    const { items } = await listPage(bucket, 'acme')
    expect(items).toEqual([
      { name: documentObject('acme', 1), generation: '1000', metageneration: '1', has: false },
      { name: drawingObject('acme', 1), generation: '1000', metageneration: '1', has: true },
    ])
    expect(JSON.stringify(items)).not.toContain('SECRET-TOKEN')
  })
})

// ── The REAL client's listing shape (Stage 0 defect, 12 November 2026) ──────
// The deployed worker once listed real objects, decided none carried a token
// and reported the sweep complete. These run listPage through the INSTALLED
// @google-cloud/storage getFiles, with only its HTTP layer stubbed, so the
// shape the code reads is the shape the library really returns.
describe('listing through the real @google-cloud/storage client', () => {
  const realBucket = (responses) => {
    const bucket = new Storage({ projectId: 'unit-test' }).bucket('unit-test-bucket')
    const seen = []
    bucket.request = (opts, cb) => { seen.push(opts); cb(null, responses.shift() ?? { items: [] }) }
    return { bucket, seen }
  }
  const item = (n, extra = {}) => ({ name: drawingObject('acme', n), generation: `${1000 + n}`, metageneration: '3', ...extra })

  it('reads name, counters and the token key from the raw resources the client returns under a field mask', async () => {
    const { bucket, seen } = realBucket([{ items: [
      item(1, { metadata: { [TOKEN_KEY]: SECRET(1) } }),
      item(2),
      item(3, { metadata: { generation: 'imitation', [TOKEN_KEY]: SECRET(3) } }),
    ], nextPageToken: 'next-1' }])
    const page = await listPage(bucket, 'acme')
    expect(page.items).toEqual([
      { name: drawingObject('acme', 1), generation: '1001', metageneration: '3', has: true },
      { name: drawingObject('acme', 2), generation: '1002', metageneration: '3', has: false },
      { name: drawingObject('acme', 3), generation: '1003', metageneration: '3', has: true },
    ])
    expect(page.nextPageToken).toBe('next-1')
    expect(seen[0]).toMatchObject({ uri: '/o', qs: { prefix: 'companies/acme/', fields: LIST_FIELDS, maxResults: 500 } })
  })

  it('FAILS CLOSED when an item has no version counters — a sweep can never complete on a listing it misread', async () => {
    const { bucket } = realBucket([{ items: [{ name: drawingObject('acme', 1), metadata: { [TOKEN_KEY]: SECRET(1) } }] }])
    await expect(listPage(bucket, 'acme')).rejects.toThrow(/without version counters/)
    const { bucket: b2 } = realBucket([{ items: [item(1, { generation: 'abc' })] }])
    await expect(listPage(b2, 'acme')).rejects.toThrow(/without version counters/)
  })

  it('a misread listing is an interrupted sweep, never a completed one', async () => {
    const { bucket } = realBucket([{ items: [{ name: drawingObject('acme', 1) }] }])
    await expect(sweepPage(bucket, 'acme', null, { sleep: noSleep })).rejects.toThrow(/without version counters/)
  })
})

describe('removing a token', () => {
  it('removes ONLY the token key, under generation and metageneration preconditions, and keeps everything else', async () => {
    const name = drawingObject('acme', 1)
    const bucket = fakeBucket({ [name]: { generation: '777', metageneration: '4', contentType: 'image/png', cacheControl: 'private, max-age=0', metadata: { keep: 'yes', other: 'x', [TOKEN_KEY]: SECRET(1) } } })
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    expect(page).toMatchObject({ scanned: 1, removed: 1, failed: 0 })
    expect(bucket.calls.patch).toEqual([{ name, patch: { metadata: { [TOKEN_KEY]: null } }, options: { ifGenerationMatch: '777', ifMetagenerationMatch: '4' } }])
    const after = bucket.store.get(name)
    expect(after.metadata).toEqual({ keep: 'yes', other: 'x' })
    expect(after).toMatchObject({ generation: '777', metageneration: '5', contentType: 'image/png', cacheControl: 'private, max-age=0' })
  })

  it('never patches an object that carries no token', async () => {
    const bucket = fakeBucket(seedObjects('acme', 6, { tokenEvery: 3, extra: { keep: 'yes' } }))
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    expect(page).toMatchObject({ scanned: 6, withToken: 2, removed: 2, failed: 0 })
    expect(bucket.calls.patch.map(c => c.name)).toEqual([drawingObject('acme', 3), drawingObject('acme', 6)])
    for (const o of bucket.store.values()) expect(o.metadata).toEqual({ keep: 'yes' })
  })

  it('is idempotent: a second sweep finds nothing to do', async () => {
    const bucket = fakeBucket(seedObjects('acme', 4))
    await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    const patches = bucket.calls.patch.length
    const again = await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    expect(again).toMatchObject({ scanned: 4, withToken: 0, removed: 0, failed: 0 })
    expect(bucket.calls.patch).toHaveLength(patches)
  })

  it('a stale precondition (412) re-reads the object and retries with fresh counters', async () => {
    const name = drawingObject('acme', 1)
    const bucket = fakeBucket(seedObjects('acme', 1, { extra: { keep: 'yes' } }), {
      // Someone else changes unrelated metadata between the listing and our update.
      beforePatch: (n, attempt) => { if (attempt === 1) { const o = bucket.store.get(n); o.metadata.added = 'meanwhile'; o.metageneration = '2' } },
    })
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    expect(page).toMatchObject({ removed: 1, failed: 0 })
    expect(bucket.calls.patch.map(c => c.options.ifMetagenerationMatch)).toEqual(['1', '2'])
    expect(bucket.calls.get).toEqual([name])
    // The concurrent change survived; only the token is gone.
    expect(bucket.store.get(name).metadata).toEqual({ keep: 'yes', added: 'meanwhile' })
  })

  it('a 412 whose re-read shows the token already gone counts as clean, not as a failure', async () => {
    const bucket = fakeBucket(seedObjects('acme', 1), {
      beforePatch: (n, attempt) => { if (attempt === 1) { const o = bucket.store.get(n); delete o.metadata[TOKEN_KEY]; o.metageneration = '2' } },
    })
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep })
    expect(page).toMatchObject({ withToken: 1, removed: 0, clean: 1, failed: 0 })
    expect(bucket.calls.patch).toHaveLength(1)
  })

  it('an object deleted meanwhile (404) is gone, not failed', async () => {
    const bucket = fakeBucket(seedObjects('acme', 1), { beforePatch: (n) => { bucket.store.delete(n) } })
    expect(await sweepPage(bucket, 'acme', null, { sleep: noSleep })).toMatchObject({ gone: 1, failed: 0 })
  })

  it('retries a transient error with backoff, bounded, then succeeds', async () => {
    const sleeps = []
    const bucket = fakeBucket(seedObjects('acme', 1), { patchError: (_n, attempt) => (attempt <= 2 ? 503 : null) })
    const page = await sweepPage(bucket, 'acme', null, { sleep: async (ms) => { sleeps.push(ms) } })
    expect(page).toMatchObject({ removed: 1, failed: 0 })
    expect(bucket.calls.patch).toHaveLength(3)
    expect(sleeps).toEqual([250, 500])
  })

  it('gives up after a bounded number of attempts and reports FAILED — the token is still there', async () => {
    const log = recorder()
    const bucket = fakeBucket(seedObjects('acme', 1), { patchError: () => 429 })
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep, log })
    expect(page).toMatchObject({ withToken: 1, removed: 0, failed: 1 })
    expect(bucket.calls.patch).toHaveLength(MAX_ATTEMPTS)
    expect(tokensLeft(bucket)).toBe(1)
    expect(log.lines).toEqual([{ level: 'warn', msg: 'file-links: token removal failed', fields: { companyId: 'acme', object: drawingObject('acme', 1), status: 429 } }])
  })

  it('does not retry a permanent refusal (403)', async () => {
    const bucket = fakeBucket(seedObjects('acme', 1), { patchError: () => 403 })
    expect(await sweepPage(bucket, 'acme', null, { sleep: noSleep })).toMatchObject({ failed: 1 })
    expect(bucket.calls.patch).toHaveLength(1)
  })

  it('one failing object does not stop the others on the page', async () => {
    const bad = drawingObject('acme', 2)
    const bucket = fakeBucket(seedObjects('acme', 4), { patchError: (n) => (n === bad ? 403 : null) })
    expect(await sweepPage(bucket, 'acme', null, { sleep: noSleep })).toMatchObject({ scanned: 4, removed: 3, failed: 1 })
    expect(tokensLeft(bucket)).toBe(1)
  })

  it('bounds concurrency', async () => {
    const bucket = fakeBucket(seedObjects('acme', 40))
    await sweepPage(bucket, 'acme', null, { sleep: noSleep, concurrency: 4 })
    expect(bucket.maxInFlight).toBeLessThanOrEqual(4)
    expect(bucket.maxInFlight).toBeGreaterThan(1)
    expect(tokensLeft(bucket)).toBe(0)
  })

  it('removeToken reads the object first when it has no version counters', async () => {
    const name = drawingObject('acme', 1)
    const bucket = fakeBucket(seedObjects('acme', 1))
    expect(await removeToken(bucket, { name, generation: null, metageneration: null }, { sleep: noSleep })).toBe(OUTCOME.REMOVED)
    expect(bucket.calls.get).toEqual([name])
  })
})

describe('no token value leaves the module', () => {
  it('results, logs and thrown errors never contain a token', async () => {
    const log = recorder()
    const bucket = fakeBucket(seedObjects('acme', 6), { patchError: (n) => (n === drawingObject('acme', 3) ? 500 : null) })
    const page = await sweepPage(bucket, 'acme', null, { sleep: noSleep, log })
    const inv = await inventoryCompany(bucket, 'acme')
    const everything = JSON.stringify({ page, inv, log: log.lines })
    expect(page.failed).toBe(1)
    expect(everything).not.toContain('SECRET-TOKEN')
    expect(everything).not.toContain(TOKEN_KEY)
  })

  it('the source never logs, stores or returns the token value', () => {
    const tokens = src('lib/fileLinkTokens.js')
    const state = src('lib/fileLinkRevocation.js')
    // The value is read in exactly one place: the boolean presence test.
    expect(tokens.match(/\[TOKEN_KEY\]/g)).toHaveLength(2) // hasToken read + the null patch
    expect(tokens).toMatch(/const v = item\?\.metadata\?\.\[TOKEN_KEY\]\s*\n\s*return typeof v === 'string' && v\.length > 0/)
    expect(state).not.toMatch(/TOKEN_KEY|firebaseStorageDownloadTokens|\.metadata\b/)
    expect(tokens).not.toMatch(/err\??\.message|err\??\.response\??\.data|JSON\.stringify/)
  })
})

describe('inventory (the operator dry run)', () => {
  it('counts across pages and changes nothing', async () => {
    const bucket = fakeBucket({ ...seedObjects('acme', 7, { tokenEvery: 2 }), ...seedObjects('other', 3) })
    expect(await inventoryCompany(bucket, 'acme', { pageSize: 3 })).toEqual({ scanned: 7, withToken: 3, pages: 3 })
    expect(bucket.calls.patch).toHaveLength(0)
    expect(bucket.calls.get).toHaveLength(0)
    expect(tokensLeft(bucket)).toBe(6)
  })
})

describe('which role changes reduce file access', () => {
  it('only leaving the internal set does', () => {
    for (const from of ['company_admin', 'project_manager', 'qs']) {
      for (const to of ['company_admin', 'project_manager', 'qs']) expect(reducesFileAccess(from, to), `${from}→${to}`).toBe(false)
      for (const to of ['subcontractor', 'client']) expect(reducesFileAccess(from, to), `${from}→${to}`).toBe(true)
    }
    expect(reducesFileAccess('subcontractor', 'client')).toBe(false)
    expect(reducesFileAccess('client', 'project_manager')).toBe(false)
  })
})

describe('status rule', () => {
  const T = Date.parse('2026-11-12T10:00:00Z')
  const ts = (ms) => ({ toMillis: () => ms })
  const S = FILE_LINK_STATUS

  it('a member is revoked only when a completed sweep covers THEIR request sequence', () => {
    const m = { seq: 3, reducedAtMs: T, deactivated: true }
    expect(fileLinkStatus(m, { requestSeq: 3, completedSeq: 2 }, T + 1000)).toBe(S.PENDING)
    expect(fileLinkStatus(m, { requestSeq: 3, completedSeq: 3 }, T + 1000)).toBe(S.REVOKED)
    expect(fileLinkStatus(m, { requestSeq: 5, completedSeq: 4 }, T + 1000)).toBe(S.REVOKED)
    // No state document at all is never "revoked".
    expect(fileLinkStatus(m, null, T + 1000)).toBe(S.PENDING)
  })

  it('a sweep in progress does not count, however far it has got', () => {
    const m = { seq: 2, reducedAtMs: T, deactivated: true }
    const state = { requestSeq: 2, completedSeq: 1, pass: { seq: 2, scanned: 99999, removed: 500, failed: 0 } }
    expect(fileLinkStatus(m, state, T + 1000)).toBe(S.PENDING)
  })

  it('an incomplete sweep, or a long wait, is DELAYED — never revoked', () => {
    const m = { seq: 2, reducedAtMs: T, deactivated: true }
    expect(fileLinkStatus(m, { requestSeq: 2, completedSeq: 1, consecutiveIncomplete: 1 }, T + 1000)).toBe(S.DELAYED)
    expect(fileLinkStatus(m, { requestSeq: 2, completedSeq: 1 }, T + DELAY_AFTER_MS)).toBe(S.PENDING)
    expect(fileLinkStatus(m, { requestSeq: 2, completedSeq: 1 }, T + DELAY_AFTER_MS + 1)).toBe(S.DELAYED)
  })

  it('an active member with no access reduction has no status at all', () => {
    expect(fileLinkStatus({ seq: null, reducedAtMs: null, deactivated: false }, { requestSeq: 9, completedSeq: 9 }, T)).toBe(null)
  })

  it('a role-reduced ACTIVE member is tracked like anyone else', () => {
    const m = { seq: 4, reducedAtMs: T, deactivated: false }
    expect(fileLinkStatus(m, { requestSeq: 4, completedSeq: 3 }, T + 1)).toBe(S.PENDING)
    expect(fileLinkStatus(m, { requestSeq: 4, completedSeq: 4 }, T + 1)).toBe(S.REVOKED)
  })

  it('a member deactivated before this feature is covered only by a sweep that started clearly later', () => {
    const legacy = { seq: null, reducedAtMs: T, deactivated: true }
    expect(fileLinkStatus(legacy, null, T + 1)).toBe(S.NOT_REQUESTED)
    expect(fileLinkStatus(legacy, { requestSeq: 1, completedSeq: 1, completedPassStartedAt: ts(T - 1) }, T + 1)).toBe(S.NOT_REQUESTED)
    expect(fileLinkStatus(legacy, { requestSeq: 1, completedSeq: 1, completedPassStartedAt: ts(T + LEGACY_MARGIN_MS - 1) }, T + 1)).toBe(S.NOT_REQUESTED)
    expect(fileLinkStatus(legacy, { requestSeq: 1, completedSeq: 1, completedPassStartedAt: ts(T + LEGACY_MARGIN_MS) }, T + 1)).toBe(S.REVOKED)
    expect(fileLinkStatus(legacy, { requestSeq: 2, completedSeq: 1, requestedAt: ts(T + 5000) }, T + 6000)).toBe(S.PENDING)
  })

  it('the row carries a status, times and a failure count — nothing else', () => {
    const state = { requestSeq: 2, completedSeq: 1, consecutiveIncomplete: 2, lastPass: { failed: 7 }, completedAt: ts(T - 60000) }
    const row = fileLinkRow({ fileLinkRevocationSeq: 2, fileAccessReducedAt: ts(T) }, { deactivated: true }, state, T + 1000)
    expect(row).toEqual({ status: S.DELAYED, since: '2026-11-12T10:00:00.000Z', lastCompletedAt: '2026-11-12T09:59:00.000Z', outstanding: 7 })
    expect(fileLinkRow({}, { deactivated: false }, state, T)).toBe(null)
  })
})

describe('audit', () => {
  it('the three file-link audit types exist and carry counts only', () => {
    expect(AUDIT.FILE_LINKS_REVOCATION_REQUESTED).toBe('file_links.revocation_requested')
    expect(AUDIT.FILE_LINKS_REVOKED).toBe('file_links.revoked')
    expect(AUDIT.FILE_LINKS_REVOCATION_INCOMPLETE).toBe('file_links.revocation_incomplete')
    expect(Object.values(REASON)).toEqual(['member.deactivated', 'member.role_reduced', 'operator'])
    expect(() => auditPayload({ type: AUDIT.FILE_LINKS_REVOKED, after: { seq: 1, scanned: 2, removed: 1, failed: 0 } }, new Date())).not.toThrow()
  })
})
