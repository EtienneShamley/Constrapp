import { isWithdrawnDrawing } from './drawings'

// ── Remembering which sheet the Quant workspace was on ───────────────────────
//
// The workspace (pages/project/quant/TakeoffWorkspace.jsx) is unmounted every
// time the user leaves the Quant tab — the project layout renders each tab
// through `<Outlet key={projectId}>` — and its selection (drawing → revision →
// page) lived only in React state, so Quant → BOQ → Quant, and a refresh,
// started from "Choose a drawing…". This module remembers the selection in
// the browser's sessionStorage, PER PROJECT, and validates it against the
// LOADED records before anything uses it.
//
// Deliberate limits:
//   · UI state only. Nothing here is written to Firestore, and nothing here
//     decides whether a sheet may be measured — `canMeasureOnRevision`, the
//     revision banner and the transactions are untouched. A restored withdrawn
//     revision is exactly as inspect-or-void-only as a chosen one.
//   · sessionStorage, not localStorage: it is scoped to the browser tab and
//     dies with it, which is what "where was I" state should do. Nothing
//     personal or financial is stored — three ids and a page number.
//   · Pure: the storage object is injected (a `Storage` or anything with
//     getItem / setItem / removeItem), so the unit tests run in plain Node and
//     the browser code tolerates a storage that is missing or throws (Safari
//     private mode, a blocked origin).
//   · `revisionId` is the user's EXPLICIT choice, or null for "the current
//     revision". Saving the explicit choice only means that a user who was on
//     the current revision follows a newly issued one, and a user who had
//     deliberately opened an older sheet is returned to it — with the same
//     SUPERSEDED / WITHDRAWN banner they saw when they chose it.

export const SELECTION_VERSION = 1
const KEY_PREFIX = 'constrapp.quant.selection.'
const MAX_ID = 128
const MAX_PAGE = 10000

export const selectionStorageKey = (projectId) => `${KEY_PREFIX}${projectId}`

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && !v.includes('/')
const isPage = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_PAGE

// The saved shape, or null for anything unusable. Never throws.
export function parseSavedSelection(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let data
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || data.v !== SELECTION_VERSION) return null
  if (!isId(data.drawingId)) return null
  const revisionId = data.revisionId === null || data.revisionId === undefined ? null : data.revisionId
  if (revisionId !== null && !isId(revisionId)) return null
  return { drawingId: data.drawingId, revisionId, page: isPage(data.page) ? data.page : 1 }
}

export function readSelection(storage, projectId) {
  if (!storage || !isId(projectId)) return null
  try {
    return parseSavedSelection(storage.getItem(selectionStorageKey(projectId)))
  } catch {
    return null
  }
}

// Writes the EFFECTIVE selection. A selection without a drawing clears the
// entry — "nothing chosen" is remembered as nothing. Failures are swallowed:
// remembering the sheet is a convenience, never a reason to break the page.
export function writeSelection(storage, projectId, { drawingId, revisionId = null, page = 1 } = {}) {
  if (!storage || !isId(projectId)) return false
  try {
    const key = selectionStorageKey(projectId)
    if (!isId(drawingId)) { storage.removeItem(key); return true }
    storage.setItem(key, JSON.stringify({
      v: SELECTION_VERSION,
      drawingId,
      revisionId: isId(revisionId) ? revisionId : null,
      page: isPage(page) ? page : 1,
    }))
    return true
  } catch {
    return false
  }
}

export function clearSelection(storage, projectId) {
  return writeSelection(storage, projectId, { drawingId: null })
}

// ── Validation against loaded records ────────────────────────────────────────

// The drawing a (saved or chosen) id may select: it must be in the loaded
// register and not withdrawn — exactly what the picker offers. Null while
// the register is still loading or failed: a saved id is never trusted before
// the records that would vouch for it have arrived.
export function selectableDrawing(drawings, drawingId, { settled = true } = {}) {
  if (!settled || !isId(drawingId) || !Array.isArray(drawings)) return null
  const d = drawings.find(x => x?.id === drawingId) ?? null
  return d && !isWithdrawnDrawing(d) ? d : null
}

// The page to show: the saved page while the saved revision is the one on
// screen; page 1 when an explicit choice could not be honoured (`chosen` is
// the revision the workspace found in the LOADED list for `revisionId`, or
// null — the saved revision is gone or inaccessible, so the page number
// belonged to a different sheet). A page beyond the sheet is left to the
// viewer, which reports "This PDF has n pages" rather than rendering anything.
export function effectivePage({ page, revisionId, chosen, settled }) {
  if (!isPage(page)) return 1
  if (isId(revisionId) && settled && !chosen) return 1
  return page
}
