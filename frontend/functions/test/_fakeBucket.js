// ── An in-memory stand-in for a Cloud Storage bucket (ADR-74 tests) ──────────
//
// Models exactly the behaviour VERIFIED against real Cloud Storage for ADR-74:
//   · listing by prefix, in name order, paged by `maxResults` / `pageToken`
//   · PATCH merges custom metadata; a `null` value deletes that one key
//   · `ifGenerationMatch` / `ifMetagenerationMatch` → 412 when stale
//   · a successful PATCH leaves `generation` alone and bumps `metageneration`
//   · a missing object → 404
//
// The Storage EMULATOR cannot be used for this: its PATCH ignores
// preconditions and does not clear tokens (ADR-74 evidence).
//
// `objects` maps name → { generation, metageneration, contentType, metadata }.
// `hooks.patchError(name, attempt)` may return an HTTP status to fail a PATCH;
// `hooks.beforePatch(name)` runs first and may mutate the store (a concurrent
// change); `hooks.listError(pageToken)` may return a status to fail a listing.

const httpError = (status) => Object.assign(new Error(`fake storage error ${status}`), { code: status })

export function fakeBucket(objects = {}, hooks = {}) {
  const store = new Map(Object.entries(objects).map(([name, o]) => [name, {
    generation: '1000', metageneration: '1', contentType: 'application/pdf', ...o, metadata: { ...(o.metadata ?? {}) },
  }]))
  const calls = { list: [], get: [], patch: [] }
  const attempts = new Map()
  let inFlight = 0
  let maxInFlight = 0

  const resource = (name, o) => ({
    name, generation: o.generation, metageneration: o.metageneration, contentType: o.contentType, metadata: { ...o.metadata },
  })

  return {
    store, calls, hooks,
    get maxInFlight() { return maxInFlight },

    async getFiles(query) {
      calls.list.push({ ...query })
      const status = hooks.listError?.(query.pageToken ?? null)
      if (status) throw httpError(status)
      const names = [...store.keys()].filter(n => n.startsWith(query.prefix ?? '')).sort()
      const start = query.pageToken ? names.findIndex(n => n > query.pageToken) : 0
      const from = start === -1 ? names.length : start
      const page = names.slice(from, from + (query.maxResults ?? 1000))
      const more = from + page.length < names.length
      const files = page.map((name) => {
        const o = store.get(name)
        // Honour the field mask the worker sends: only the one metadata key.
        const key = 'firebaseStorageDownloadTokens'
        const metadata = key in o.metadata ? { [key]: o.metadata[key] } : undefined
        const resource = { name, generation: o.generation, metageneration: o.metageneration, ...(metadata ? { metadata } : {}) }
        // EXACTLY like @google-cloud/storage: with a `fields` mask the item is
        // the raw resource; without one, a File-like object wrapping it.
        // (Stage 0 found the worker reading the wrong shape; the earlier fake
        // returned File-likes even with a mask, which hid it.)
        return query.fields ? resource : { name, metadata: resource, getMetadata: async () => [resource] }
      })
      return [files, more ? { ...query, pageToken: page.at(-1) } : null, {}]
    },

    file(name) {
      return {
        name,
        async getMetadata() {
          calls.get.push(name)
          const o = store.get(name)
          if (!o) throw httpError(404)
          return [resource(name, o)]
        },
        async setMetadata(patch, options = {}) {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            await new Promise(r => setTimeout(r, 1))
            const n = (attempts.get(name) ?? 0) + 1
            attempts.set(name, n)
            calls.patch.push({ name, patch: JSON.parse(JSON.stringify(patch)), options: { ...options } })
            await hooks.beforePatch?.(name, n)
            const status = hooks.patchError?.(name, n)
            if (status) throw httpError(status)
            const o = store.get(name)
            if (!o) throw httpError(404)
            if (options.ifGenerationMatch !== undefined && String(options.ifGenerationMatch) !== String(o.generation)) throw httpError(412)
            if (options.ifMetagenerationMatch !== undefined && String(options.ifMetagenerationMatch) !== String(o.metageneration)) throw httpError(412)
            for (const [k, v] of Object.entries(patch.metadata ?? {})) {
              if (v === null) delete o.metadata[k]; else o.metadata[k] = v
            }
            for (const [k, v] of Object.entries(patch)) if (k !== 'metadata') o[k] = v
            o.metageneration = String(Number(o.metageneration) + 1)
            return [resource(name, o)]
          } finally {
            inFlight -= 1
          }
        },
      }
    },
  }
}

// Deterministic object names for a company, mirroring lib/files.js shapes.
export const drawingObject = (companyId, n) => `companies/${companyId}/projects/p1/drawings/d${String(n).padStart(4, '0')}/r1/original.pdf`
export const documentObject = (companyId, n) => `companies/${companyId}/projects/p1/documents/doc${String(n).padStart(4, '0')}/original.pdf`

export const SECRET = (n) => `SECRET-TOKEN-${n}-do-not-leak`

// `count` objects for a company; every `tokenEvery`-th carries a token.
export function seedObjects(companyId, count, { tokenEvery = 1, extra = {} } = {}) {
  const out = {}
  for (let i = 1; i <= count; i += 1) {
    const metadata = { ...extra }
    if (tokenEvery > 0 && i % tokenEvery === 0) metadata.firebaseStorageDownloadTokens = SECRET(`${companyId}-${i}`)
    out[drawingObject(companyId, i)] = { metadata }
  }
  return out
}

export const tokensLeft = (bucket, prefix = '') =>
  [...bucket.store.entries()].filter(([n, o]) => n.startsWith(prefix) && 'firebaseStorageDownloadTokens' in o.metadata).length
