import { ALLOWED_CONTENT_TYPES, storageExtension } from './files'

// ── Showing and saving a stored file from its BYTES (DC46-A, ADR-73) ─────────
//
// Constrap no longer hands a Firebase download-token URL to the browser. A file
// is fetched through the Storage SDK (`getFileBlob` in hooks/useStorageUpload),
// which Storage Rules authorise on EVERY read, and is then shown or saved from
// a `blob:` object URL. A blob URL is not a bearer link: it resolves only inside
// this browser profile, only for this origin, and only until it is revoked or
// the page that made it goes away. Copied into an email it opens nothing.
//
// This module is PURE with respect to Firebase — it never imports the SDK — and
// every browser global it touches arrives through `env`, so the whole lifecycle
// (create, hand over, revoke) is unit-tested in plain Node.
//
// ⚠️ A BLOB URL IS SAME-ORIGIN WITH THE APP. The old download URL rendered on
// firebasestorage.googleapis.com; a blob renders as app.constrap.com. Uploaded
// bytes are never inspected by Storage Rules, so the blob's TYPE is what decides
// how the browser treats it. `typedBlob` therefore forces the type to one of the
// three allowed content types and refuses anything else — a blob is never
// created as text/html or image/svg+xml, whatever the object claims to be.
//
// ⚠️ REVOCATION IS DELIBERATELY LATE, NEVER EARLY.
//   · an INLINE preview's URL belongs to the component that made it and is
//     revoked when the revision changes or the component unmounts;
//   · a URL handed to ANOTHER TAB is revoked when that tab is closed, not when
//     the app navigates — otherwise reloading the opened PDF would fail;
//   · a URL handed to a DOWNLOAD is revoked after a generous delay, because
//     some browsers (iOS Safari) only start reading it once the user confirms.
// The cost is memory: the bytes stay referenced until the URL is revoked.

export const OPEN_OUTCOME = {
  TAB:           'tab',            // shown in a new tab
  SAVED:         'saved',          // this browser cannot show a PDF inline — saved instead
  POPUP_BLOCKED: 'popup-blocked',  // the new tab was blocked — saved instead
  CANCELLED:     'cancelled',      // the user closed the tab before the file arrived
}

export const TAB_POLL_MS          = 3_000
export const SAVE_REVOKE_DELAY_MS = 5 * 60_000

// The browser globals this module uses. Read lazily so importing the module in
// Node (the unit runner) touches nothing.
export function browserEnv() {
  return {
    window:        globalThis.window,
    document:      globalThis.document,
    navigator:     globalThis.navigator,
    URL:           globalThis.URL,
    setTimeout:    (fn, ms) => globalThis.setTimeout(fn, ms),
    setInterval:   (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  }
}

// The blob, carrying EXACTLY the allowed content type recorded for the file.
// Needed for two reasons: the SDK's size-capped download returns `blob.slice()`,
// which drops the type, and a typeless or mistyped blob must never be rendered
// in the app's origin.
export function typedBlob(blob, contentType) {
  const type = String(contentType ?? '').toLowerCase()
  if (!ALLOWED_CONTENT_TYPES.includes(type)) {
    throw new Error('This file type cannot be opened in the app.')
  }
  if (!blob || typeof blob.slice !== 'function') throw new Error('This file is not available')
  if (!(blob.size > 0)) throw new Error('The file for this record is empty.')
  return blob.type === type ? blob : blob.slice(0, blob.size, type)
}

// The name a saved file gets: the user's original filename (Firestore metadata),
// with path separators and control characters removed, or `file.{ext}`.
export function downloadFileName(fileName, contentType) {
  const cleaned = Array.from(String(fileName ?? ''))
    .filter(ch => ch.charCodeAt(0) >= 32 && ch !== '/' && ch !== '\\')
    .join('')
    .trim()
    .slice(0, 255)
  if (cleaned) return cleaned
  const ext = storageExtension(contentType)
  return ext ? `file.${ext}` : 'file'
}

// False ONLY when the browser says it has no inline PDF viewer (Android Chrome
// without the native viewer, some in-app browsers). Unknown counts as true:
// older browsers do not expose the flag and nearly all of them show PDFs.
export const canShowPdfInline = (nav) => nav?.pdfViewerEnabled !== false

// Whether "Open" should use a new tab. Images always can. A PDF only where the
// browser can display one — sending a PDF blob to a tab that cannot show it
// produces a download named after the blob's UUID, so it is saved under its
// real filename instead.
export function opensInTab(contentType, nav) {
  const type = String(contentType ?? '').toLowerCase()
  if (type === 'application/pdf') return canShowPdfInline(nav)
  return ALLOWED_CONTENT_TYPES.includes(type)
}

// An object URL with an idempotent `revoke` — the unit an inline preview owns.
export function createObjectUrl(blob, urlApi = globalThis.URL) {
  const url = urlApi.createObjectURL(blob)
  let live = true
  return {
    url,
    get revoked() { return !live },
    revoke() {
      if (!live) return
      live = false
      urlApi.revokeObjectURL(url)
    },
  }
}

// Opens the tab SYNCHRONOUSLY, inside the click — a tab opened after an await
// is blocked as a popup. `opener` is cleared so the tab cannot reach back into
// the app. Returns null when the browser refused to open it.
export function prepareTab(win) {
  let tab
  try { tab = win.open('', '_blank') } catch { return null }
  if (!tab) return null
  try {
    tab.opener = null
    tab.document.title = 'Opening file…'
    tab.document.body.textContent = 'Preparing file…'
  } catch { /* a placeholder is a nicety — never a reason to fail */ }
  return tab
}

// A tab we can no longer see counts as closed.
function isTabClosed(tab) {
  try { return tab.closed !== false } catch { return true }
}

// Points an already-open tab at the blob and keeps the URL alive for as long as
// that tab exists. Returns the handle (tests and callers may revoke early).
export function showBlobInTab({ tab, blob, env = browserEnv(), pollMs = TAB_POLL_MS }) {
  const handle = createObjectUrl(blob, env.URL)
  tab.location.replace(handle.url)
  const timer = env.setInterval(() => {
    if (isTabClosed(tab)) {
      env.clearInterval(timer)
      handle.revoke()
    }
  }, pollMs)
  return handle
}

// Saves the blob under `fileName` through a temporary same-origin <a download>.
// (The `download` attribute is honoured for blob URLs; it was ignored for the
// old cross-origin download URL.)
export function saveBlob({ blob, fileName, env = browserEnv(), revokeAfterMs = SAVE_REVOKE_DELAY_MS }) {
  const handle = createObjectUrl(blob, env.URL)
  const a = env.document.createElement('a')
  a.href = handle.url
  a.download = fileName
  a.rel = 'noopener'
  a.hidden = true
  env.document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
    env.setTimeout(() => handle.revoke(), revokeAfterMs)
  }
  return handle
}

// "Open": fetch the bytes and show them in a new tab, or save them where a tab
// cannot work. `fetchBlob` is the rules-checked SDK read; a rejection (denied,
// missing, timed out) closes the placeholder tab and propagates unchanged.
export async function openStoredFile({ fetchBlob, contentType, fileName, env = browserEnv() }) {
  const inTab = opensInTab(contentType, env.navigator)
  const tab = inTab ? prepareTab(env.window) : null
  let blob
  try {
    blob = typedBlob(await fetchBlob(), contentType)
  } catch (err) {
    try { tab?.close() } catch { /* already gone */ }
    throw err
  }
  if (tab) {
    if (isTabClosed(tab)) return OPEN_OUTCOME.CANCELLED
    showBlobInTab({ tab, blob, env })
    return OPEN_OUTCOME.TAB
  }
  saveBlob({ blob, fileName: downloadFileName(fileName, contentType), env })
  return inTab ? OPEN_OUTCOME.POPUP_BLOCKED : OPEN_OUTCOME.SAVED
}

// "Download": fetch the bytes and save them under the original filename.
export async function downloadStoredFile({ fetchBlob, contentType, fileName, env = browserEnv() }) {
  const blob = typedBlob(await fetchBlob(), contentType)
  saveBlob({ blob, fileName: downloadFileName(fileName, contentType), env })
  return OPEN_OUTCOME.SAVED
}

// What to tell the user when "Open" did something other than open a tab.
export function openOutcomeNotice(outcome) {
  if (outcome === OPEN_OUTCOME.SAVED) {
    return 'This browser cannot display PDFs in a tab, so the file was saved to your downloads instead.'
  }
  if (outcome === OPEN_OUTCOME.POPUP_BLOCKED) {
    return 'Your browser blocked the new tab, so the file was saved to your downloads instead.'
  }
  return null
}
