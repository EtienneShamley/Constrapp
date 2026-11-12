import { isValidId } from './validation.js'

// ── Legacy file-link tokens — the Cloud Storage side (ADR-74, DC46-B) ────────
//
// A Firebase "download URL" is a bearer link: it carries a token that Firebase
// stores on the object as the custom-metadata key below, and it is served
// WITHOUT Storage Rules. The app no longer mints such URLs (ADR-73), but every
// upload still creates a token and any URL copied earlier keeps working.
// REMOVING the key revokes the URL — verified against real Firebase Storage on
// disposable data (ADR-74 evidence, 12 November 2026); it is NOT documented by
// Firebase, so nothing here is described as guaranteed.
//
// What this module does, and nothing else:
//   · lists objects under ONE company prefix, one page at a time;
//   · for each object that carries the key, removes THAT KEY ONLY, guarded by
//     the object's generation and metageneration, so a concurrent change is
//     never overwritten and unrelated metadata is never touched;
//   · counts outcomes.
//
// ⚠️ TOKEN VALUES ARE SECRETS. They are read only to learn that one exists.
// Nothing in this file logs, returns, stores or throws a token value — results
// are counts, and failures are reported by object path and HTTP status only.
// Object paths are built from document ids (lib/files.js), never a filename.
//
// The bucket is injected, so every branch is unit-tested with a fake.

export const TOKEN_KEY = 'firebaseStorageDownloadTokens'
export const PAGE_SIZE = 500
export const CONCURRENCY = 16
export const MAX_ATTEMPTS = 4

// Ask Cloud Storage for nothing but identity, the two version counters and the
// one key — unrelated custom metadata never leaves the bucket.
export const LIST_FIELDS = `items(name,generation,metageneration,metadata/${TOKEN_KEY}),nextPageToken`

// The ONLY prefix a company sweep may list. The trailing slash is what stops
// `companies/acme` from also matching `companies/acme-two/…`.
export function companyPrefix(companyId) {
  if (!isValidId(companyId)) throw new Error('file-links: invalid company id')
  return `companies/${companyId}/`
}

const statusOf = (err) => {
  const c = err?.code ?? err?.response?.status ?? err?.status
  return typeof c === 'number' ? c : Number.isInteger(Number(c)) ? Number(c) : null
}
const isTransient = (status) => status === null || status === 408 || status === 429 || (status >= 500 && status <= 599)

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const backoffMs = (attempt) => Math.min(250 * 2 ** attempt, 4000)

export const hasToken = (item) => {
  const v = item?.metadata?.[TOKEN_KEY]
  return typeof v === 'string' && v.length > 0
}

const isCounter = (v) => (typeof v === 'string' && /^[0-9]+$/.test(v)) || (Number.isSafeInteger(v) && v >= 0)

// The OBJECT RESOURCE for one listed item. With a `fields` mask — which
// listPage always sends — @google-cloud/storage returns the raw JSON resource
// ({ name, generation, metageneration, metadata: {custom keys} }); without
// one it returns File instances whose `.metadata` is that resource. A File is
// recognised by its methods, never by a property name a custom-metadata key
// could imitate.
export const objectResource = (f) => (f && typeof f.getMetadata === 'function' ? f.metadata : f)

// One page of a company's objects: [{ name, generation, metageneration, has }].
// `has` is a boolean — the token value is dropped here and goes no further.
export async function listPage(bucket, companyId, pageToken = null, { pageSize = PAGE_SIZE } = {}) {
  const prefix = companyPrefix(companyId)
  const query = { prefix, autoPaginate: false, maxResults: pageSize, fields: LIST_FIELDS }
  if (pageToken) query.pageToken = pageToken
  const [files, nextQuery] = await bucket.getFiles(query)
  const items = (files ?? []).map((f) => {
    const r = objectResource(f)
    const name = r?.name
    // Defence in depth: a listing that returns anything outside the prefix is
    // a bug or a misconfigured bucket — stop, never touch it.
    if (typeof name !== 'string' || !name.startsWith(prefix)) throw new Error('file-links: listing returned an object outside the company prefix')
    // FAIL CLOSED. An object without its version counters means the listing
    // was not read the way this code expects; deciding "no token" from it
    // would let a sweep report success while every token is still in place
    // (exactly the defect Stage 0 found). Stop; the sweep is not complete.
    if (!isCounter(r.generation) || !isCounter(r.metageneration)) throw new Error('file-links: listing returned an object without version counters')
    return { name, generation: String(r.generation), metageneration: String(r.metageneration), has: hasToken(r) }
  })
  return { items, nextPageToken: nextQuery?.pageToken ?? null }
}

export const OUTCOME = { REMOVED: 'removed', CLEAN: 'clean', GONE: 'gone', FAILED: 'failed' }

// Remove the key from ONE object.
//   removed — the conditional update succeeded
//   clean   — the object no longer carries the key (someone else removed it)
//   gone    — the object no longer exists
//   failed  — still carries the key after bounded retries; the caller's pass
//             must NOT be reported complete
//
// Every update names the generation AND metageneration it was decided on. If
// either has moved (412) the object is re-read and decided again, once per
// attempt — an update is never sent blind.
export async function removeToken(bucket, item, { sleep = realSleep, log = null, companyId = null } = {}) {
  let { generation, metageneration } = item
  let lastStatus = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const file = bucket.file(item.name)
    try {
      if (generation === null || metageneration === null) {
        const [meta] = await file.getMetadata()
        if (!hasToken(meta)) return OUTCOME.CLEAN
        generation = meta.generation
        metageneration = meta.metageneration
      }
      await file.setMetadata(
        { metadata: { [TOKEN_KEY]: null } },
        { ifGenerationMatch: generation, ifMetagenerationMatch: metageneration },
      )
      return OUTCOME.REMOVED
    } catch (err) {
      lastStatus = statusOf(err)
      if (lastStatus === 404) return OUTCOME.GONE
      if (lastStatus === 412) {
        // Changed underneath us (or our own earlier attempt landed and its
        // response was lost). Re-read on the next attempt.
        generation = null
        metageneration = null
        continue
      }
      if (!isTransient(lastStatus)) break
      await sleep(backoffMs(attempt))
    }
  }
  // Path and status only — never the error message or body.
  log?.warn?.('file-links: token removal failed', { companyId, object: item.name, status: lastStatus })
  return OUTCOME.FAILED
}

async function pool(items, limit, worker) {
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next
      next += 1
      await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

// List one page and clean it. Returns counts and the next page token only.
export async function sweepPage(bucket, companyId, pageToken = null, { pageSize = PAGE_SIZE, concurrency = CONCURRENCY, sleep = realSleep, log = null } = {}) {
  const { items, nextPageToken } = await listPage(bucket, companyId, pageToken, { pageSize })
  const counts = { scanned: items.length, withToken: 0, removed: 0, clean: 0, gone: 0, failed: 0 }
  const targets = items.filter((i) => i.has)
  counts.withToken = targets.length
  await pool(targets, concurrency, async (item) => {
    const outcome = await removeToken(bucket, item, { sleep, log, companyId })
    counts[outcome] += 1
  })
  return { ...counts, nextPageToken }
}

// READ-ONLY inventory of one company: how many objects, how many carry a
// token. Used by the operator script's default dry run.
export async function inventoryCompany(bucket, companyId, { pageSize = PAGE_SIZE } = {}) {
  const totals = { scanned: 0, withToken: 0, pages: 0 }
  let pageToken = null
  do {
    const page = await listPage(bucket, companyId, pageToken, { pageSize })
    totals.scanned += page.items.length
    totals.withToken += page.items.filter((i) => i.has).length
    totals.pages += 1
    pageToken = page.nextPageToken
  } while (pageToken)
  return totals
}
