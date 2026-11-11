import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

// ── Authenticated Storage downloads (DC46-A, ADR-73) ─────────────────────────
//
// Two things are pinned here.
//
//   1. getFileBlob — the ONE read path for viewing and downloading a file —
//      against a mocked Storage SDK: what it asks the SDK for, and what each
//      failure (denied, missing, expired session, too slow) becomes.
//
//   2. A STATIC GUARD over the whole of src/: the app must never mint, build or
//      hold a Firebase download-token URL again. This is the regression test
//      for the defect itself.
//
// What this file does NOT prove: that Storage Rules deny a deactivated or
// cross-company caller. That is proven against the emulator in
// tests/rules/storage.rules.test.js.

const sdk = vi.hoisted(() => ({
  getBlob: vi.fn(),
  getBytes: vi.fn(),
  ref: vi.fn((storage, path) => ({ storage, path })),
  uploadBytesResumable: vi.fn(),
}))

vi.mock('firebase/storage', () => sdk)
vi.mock('../../src/lib/firebase', () => ({ storage: { app: 'test-storage' } }))

const { getFileBlob, getFileBytes, FILE_BYTES_TIMEOUT_MS } = await import('../../src/hooks/useStorageUpload.jsx')
const { DRAWING_MAX_BYTES, DOCUMENT_MAX_BYTES } = await import('../../src/lib/files.js')

const PATH = 'companies/companyA/projects/projectA/drawings/d1/r1/original.pdf'
const storageError = (code) => Object.assign(new Error(`Firebase Storage: (${code})`), { code })

beforeEach(() => {
  sdk.getBlob.mockReset()
  sdk.getBytes.mockReset()
  sdk.ref.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('getFileBlob — authorised retrieval', () => {
  it('reads through the SDK getBlob on the exact storage path and returns the blob', async () => {
    const blob = new Blob([new Uint8Array(16)], { type: 'application/pdf' })
    sdk.getBlob.mockResolvedValue(blob)
    await expect(getFileBlob(PATH)).resolves.toBe(blob)
    expect(sdk.ref).toHaveBeenCalledWith({ app: 'test-storage' }, PATH)
    expect(sdk.getBlob).toHaveBeenCalledTimes(1)
    expect(sdk.getBlob.mock.calls[0][0]).toEqual({ storage: { app: 'test-storage' }, path: PATH })
  })

  it('caps the download at 50 MB by default and at the caller’s ceiling when given', async () => {
    sdk.getBlob.mockResolvedValue(new Blob(['x']))
    await getFileBlob(PATH)
    expect(sdk.getBlob.mock.calls[0][1]).toBe(DRAWING_MAX_BYTES)
    await getFileBlob(PATH, { maxBytes: DOCUMENT_MAX_BYTES })
    expect(sdk.getBlob.mock.calls[1][1]).toBe(DOCUMENT_MAX_BYTES)
  })

  it('never touches the SDK without a storage path', async () => {
    await expect(getFileBlob('')).rejects.toThrow('This file is not available')
    await expect(getFileBlob(null)).rejects.toThrow('This file is not available')
    expect(sdk.getBlob).not.toHaveBeenCalled()
  })
})

describe('getFileBlob — unauthorised retrieval and failures', () => {
  it('a rules denial (cross-company, internal document, DEACTIVATED member) is named as a permission failure', async () => {
    const cause = storageError('storage/unauthorized')
    sdk.getBlob.mockRejectedValue(cause)
    const err = await getFileBlob(PATH).catch(e => e)
    expect(err.message).toBe('You do not have permission to open this file.')
    expect(err.cause).toBe(cause)
  })

  it('an expired session, a missing object and an unknown fault each get their own sentence', async () => {
    sdk.getBlob.mockRejectedValueOnce(storageError('storage/unauthenticated'))
    await expect(getFileBlob(PATH)).rejects.toThrow(/session has expired/)
    sdk.getBlob.mockRejectedValueOnce(storageError('storage/object-not-found'))
    await expect(getFileBlob(PATH)).rejects.toThrow(/missing from storage/)
    sdk.getBlob.mockRejectedValueOnce(storageError('storage/quota-exceeded'))
    await expect(getFileBlob(PATH)).rejects.toThrow('Could not open this file. Check your connection and try again.')
  })

  it('a raw Firebase code never reaches the user', async () => {
    sdk.getBlob.mockRejectedValue(storageError('storage/unauthorized'))
    const err = await getFileBlob(PATH).catch(e => e)
    expect(err.message).not.toMatch(/storage\//)
  })

  it('the wait is bounded: a download that never settles fails after timeoutMs, naming connection and CORS', async () => {
    vi.useFakeTimers()
    sdk.getBlob.mockReturnValue(new Promise(() => {}))
    const pending = getFileBlob(PATH, { timeoutMs: 45_000 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(44_999)
    let settled = false
    pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = await pending
    expect(err.message).toMatch(/could not be downloaded/)
    expect(err.message).toMatch(/CORS/)
    expect(err.cause.code).toBe('constrapp/timeout')
  })

  it('the default wait is the existing 20 s, and a fast download leaves no timer behind', async () => {
    expect(FILE_BYTES_TIMEOUT_MS).toBe(20_000)
    vi.useFakeTimers()
    sdk.getBlob.mockResolvedValue(new Blob(['x']))
    await getFileBlob(PATH)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('getFileBytes (Quant PDFs) is unchanged', () => {
  it('still reads through getBytes with the 50 MB cap and its own messages', async () => {
    const buf = new ArrayBuffer(8)
    sdk.getBytes.mockResolvedValue(buf)
    await expect(getFileBytes(PATH)).resolves.toBe(buf)
    expect(sdk.getBytes.mock.calls[0][1]).toBe(DRAWING_MAX_BYTES)
    sdk.getBytes.mockRejectedValue(storageError('storage/unauthorized'))
    await expect(getFileBytes(PATH)).rejects.toThrow('You do not have permission to open this file.')
    sdk.getBytes.mockRejectedValue(storageError('storage/object-not-found'))
    await expect(getFileBytes(PATH)).rejects.toThrow('The file for this revision is missing from storage.')
  })
})

// ── Static guard ─────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

function sourceFiles(dir = SRC) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(js|jsx|mjs|ts|tsx)$/.test(name) ? [full] : []
  })
}

// Comments may (and do) explain why download URLs are banned; code may not use them.
const stripComments = (src) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const FILES = sourceFiles().map((full) => ({
  rel: relative(SRC, full).split('\\').join('/'),
  raw: readFileSync(full, 'utf8'),
}))
const CODE = FILES.map(f => ({ ...f, code: stripComments(f.raw) }))
const read = (rel) => stripComments(FILES.find(f => f.rel === rel).raw)

describe('STATIC GUARD — no Firebase download-token URL anywhere in frontend source', () => {
  it('scans a real tree (the guard cannot pass vacuously)', () => {
    expect(FILES.length).toBeGreaterThan(100)
    expect(FILES.some(f => f.rel === 'hooks/useStorageUpload.jsx')).toBe(true)
  })

  it('getDownloadURL is not referenced by any source file', () => {
    const offenders = CODE.filter(f => /getDownloadURL/i.test(f.code)).map(f => f.rel)
    expect(offenders).toEqual([])
  })

  it('no source file reads download tokens from object metadata or builds a token URL by hand', () => {
    const banned = /downloadTokens|firebaseStorageDownloadTokens|firebasestorage\.googleapis\.com|alt=media|getMetadata\s*\(/
    const offenders = CODE.filter(f => banned.test(f.code)).map(f => f.rel)
    expect(offenders).toEqual([])
  })

  it('firebase/storage is imported ONLY by the storage hook and lib/firebase.js', () => {
    const importers = CODE.filter(f => /from\s+['"]firebase\/storage['"]/.test(f.code)).map(f => f.rel).sort()
    expect(importers).toEqual(['hooks/useStorageUpload.jsx', 'lib/firebase.js'])
  })

  it('the hook imports getBlob and getBytes — and nothing that mints or edits a URL or metadata', () => {
    const hook = read('hooks/useStorageUpload.jsx')
    const imported = hook.match(/import\s*\{([^}]*)\}\s*from\s*'firebase\/storage'/)[1]
      .split(',').map(s => s.trim().split(/\s+as\s+/)[0]).sort()
    expect(imported).toEqual(['getBlob', 'getBytes', 'ref', 'uploadBytesResumable'])
    expect(hook).not.toMatch(/export (async )?function getFileUrl/)
    expect(hook).toContain('Promise.race([getBlob(storageRef(storage, storagePath), maxBytes), timeout])')
  })

  it('nothing writes a blob or object URL into Firestore from the storage hook or the blob helper', () => {
    for (const rel of ['hooks/useStorageUpload.jsx', 'lib/fileBlob.js']) {
      expect(read(rel)).not.toMatch(/setDoc|updateDoc|addDoc|firebase\/firestore/)
    }
    expect(read('lib/fileBlob.js')).not.toMatch(/firebase/)
  })

  it('object URLs are created only through lib/fileBlob.js', () => {
    const creators = CODE.filter(f => /createObjectURL/.test(f.code)).map(f => f.rel)
    expect(creators).toEqual(['lib/fileBlob.js'])
  })
})

// ── The three views (source structure — no jsdom in this runner) ─────────────

describe('DrawingViewer — preview, open and download from authenticated bytes', () => {
  const viewer = read('pages/project/documents/DrawingViewer.jsx')

  it('reads through getFileBlob with the 50 MB ceiling and a size-aware timeout', () => {
    expect(viewer).toContain('getFileBlob(storagePath, { maxBytes: DRAWING_MAX_BYTES, timeoutMs: downloadTimeoutMs(fileSize) })')
    expect(viewer).not.toMatch(/getFileUrl/)
  })

  it('a PDF preview is fetched eagerly ONLY at md and up; an image always', () => {
    expect(viewer).toContain("const WIDE_QUERY = '(min-width: 768px)'")
    expect(viewer).toContain('const eager = !!storagePath && (isImage || (isPdf && wide))')
    expect(viewer).toContain('if (!eager || previewRef.current) return undefined')
    // The iframe is not merely hidden with CSS (a hidden iframe still downloads).
    expect(viewer).toContain('{url && isPdf && wide && (')
    expect(viewer).not.toContain('hidden md:block')
  })

  it('the preview URL is revoked, and the cached bytes dropped, when the revision changes or the viewer unmounts', () => {
    const cleanup = viewer.slice(viewer.indexOf('useEffect(() => () => {'))
    const body = cleanup.slice(0, cleanup.indexOf('}, [storagePath])'))
    expect(body).toContain('previewRef.current?.revoke()')
    expect(body).toContain('previewRef.current = null')
    expect(body).toContain('fetchRef.current = { key: null, promise: null }')
    expect(cleanup).toContain('}, [storagePath])')
  })

  it('the bytes are fetched once per revision and a failed fetch is retried, not cached', () => {
    expect(viewer).toContain('if (cached.key === storagePath && cached.promise) return cached.promise')
    expect(viewer).toContain('if (fetchRef.current.promise === promise) fetchRef.current = { key: null, promise: null }')
  })

  it('the preview is typed before it is rendered, and stale state is never shown', () => {
    expect(viewer).toContain('createObjectUrl(typedBlob(blob, contentType))')
    expect(viewer).toContain('const previewSettled = preview.key === storagePath')
  })

  it('Open and Download are buttons that pass the original filename; neither is an <a href> to a URL', () => {
    expect(viewer).toContain('const args = { fetchBlob: loadBlob, contentType, fileName }')
    expect(viewer).toContain("kind === 'open' ? await openStoredFile(args) : await downloadStoredFile(args)")
    expect(viewer).toContain("onClick={() => run('open')}")
    expect(viewer).toContain("onClick={() => run('download')}")
    expect(viewer).not.toMatch(/<a\s/)
    expect(viewer).not.toMatch(/href=/)
  })

  it('loading, failure and fallback are all announced', () => {
    expect(viewer).toContain('Loading preview…')
    expect(viewer).toContain('role="alert">{acting.error}')
    expect(viewer).toContain('role="status">{acting.notice}')
    expect(viewer).toContain('disabled={acting.busy !== null}')
  })
})

describe('General Documents — Open', () => {
  const page = read('pages/project/ProjectGeneralDocuments.jsx')

  it('opens through openStoredFile + getFileBlob with the 25 MB ceiling, type and filename', () => {
    expect(page).toContain('await openStoredFile({')
    expect(page).toContain('getFileBlob(document.storagePath, {')
    expect(page).toContain('maxBytes: DOCUMENT_MAX_BYTES, timeoutMs: downloadTimeoutMs(document.fileSize),')
    expect(page).toContain('contentType: document.contentType,')
    expect(page).toContain('fileName: document.fileName,')
    expect(page).not.toMatch(/getFileUrl|window\.open|location\.(href|assign)/)
  })

  it('a second click cannot start a second download, and the busy state always clears', () => {
    expect(page).toContain('if (openingId) return')
    expect(page).toMatch(/finally \{\s*setOpeningId\(null\)/)
    expect(page.match(/disabled=\{openingId !== null\} aria-busy=\{openingId === d\.id\}>Open</g)).toHaveLength(2)
    expect(page).toContain('{openingId && <p')
  })
})

describe('Quant PageViewer — images from authenticated bytes, PDFs unchanged', () => {
  const viewer = read('pages/project/quant/PageViewer.jsx')

  it('an image is a typed blob URL that is revoked with the revision', () => {
    expect(viewer).toContain('getFileBlob(storagePath, { timeoutMs: downloadTimeoutMs(fileSize) })')
    expect(viewer).toContain('imageHandle = createObjectUrl(typedBlob(blob, contentType))')
    expect(viewer).toContain('if (imageHandle) imageHandle.revoke()')
    expect(viewer).not.toMatch(/getFileUrl/)
  })

  it('the PDF path and the measurement geometry are untouched', () => {
    expect(viewer).toContain('Promise.all([loadPdfjs(), getFileBytes(storagePath)])')
    expect(viewer).toContain('if (handle) handle.destroy()')
    expect(viewer).toContain('onLoad={onImageLoad}')
    expect(viewer).toContain('img.naturalWidth')
  })
})
