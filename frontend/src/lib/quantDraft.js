import { MEASUREMENT_KINDS, MAX_POINTS, isPointList, normalisePoints, takeoffPageId, isPageNumber } from './quant'

// ── Remembering unsaved takeoff work (Quant 1C-A, ADR-53) ───────────────────
//
// The Quant workspace is unmounted on every project-tab change (the layout's
// keyed Outlet, ADR-52 Decision 9) and on refresh, and until 1C-A every
// half-drawn length, area, count, calibration pair or geometry edit lived only
// in React state and vanished with it. This module keeps that IN-PROGRESS work
// in the browser's sessionStorage, PER PROJECT AND PER SHEET, beside the
// remembered sheet (lib/quantSelection.js), so leaving the tab, refreshing, or
// opening another measurement's sheet from the summary or the BOQ dialog
// (Quant 1C-B) never costs the work on the sheet it was drawn on: each sheet's
// draft waits under its own key until the user is back on that sheet.
//
// Deliberate limits — the same as the selection module's:
//   · UI state only. Nothing here is written to Firestore. A draft is not a
//     measurement; it becomes one only through the existing save dialog and
//     the revision-guarded transactions, which are untouched.
//   · sessionStorage, not localStorage: per browser tab, gone when it closes
//     (which is why the workspace still warns before the tab is closed).
//   · A saved draft is INTENT, restored only when the workspace lands on the
//     very sheet it was drawn on (`pageId` matches) and, for a geometry edit,
//     only when that measurement still exists, is active and has the revision
//     the edit started from — anything else is dropped, never applied.
//   · Pure: the storage object is injected, so the tests run in plain Node and
//     a browser without usable storage degrades to "remember nothing".

export const DRAFT_VERSION = 2
const KEY_PREFIX = 'constrapp.quant.draft.'
const MAX_ID = 128
const EDIT_TOOL = 'edit'
const DRAFT_TOOLS = ['select', 'calibrate', ...MEASUREMENT_KINDS, EDIT_TOOL]

const projectPrefix = (projectId) => `${KEY_PREFIX}${projectId}.`
export const draftStorageKey = (projectId, pageId) => `${projectPrefix(projectId)}${pageId}`

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && !v.includes('/')
const isBoundedPoints = (points) => isPointList(points) && points.length <= MAX_POINTS

// A draft with nothing in it is not worth remembering.
export function isDraftEmpty(draft) {
  if (!draft) return true
  return (draft.points?.length ?? 0) === 0
    && (draft.calibrationPoints?.length ?? 0) === 0
    && !draft.editing
}

// The saved shape, or null for anything unusable. Never throws. The sheet
// identity is carried explicitly and must agree with the page id, so a draft
// can always be opened again from a list of remembered drafts.
export function parseSavedDraft(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let data
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || data.v !== DRAFT_VERSION) return null
  if (!isId(data.drawingId) || !isId(data.revisionId) || !isPageNumber(data.page)) return null
  if (data.pageId !== takeoffPageId(data.drawingId, data.revisionId, data.page)) return null
  if (!DRAFT_TOOLS.includes(data.tool)) return null
  if (!isBoundedPoints(data.points ?? [])) return null
  if (!isBoundedPoints(data.calibrationPoints ?? []) || (data.calibrationPoints ?? []).length > 2) return null
  let editing = null
  if (data.editing !== null && data.editing !== undefined) {
    const e = data.editing
    if (!e || typeof e !== 'object' || !isId(e.measurementId) || !Number.isInteger(e.revision) || e.revision < 1) return null
    if (!isBoundedPoints(e.points) || e.points.length === 0) return null
    editing = { measurementId: e.measurementId, revision: e.revision, points: normalisePoints(e.points) }
  }
  const draft = {
    pageId: data.pageId,
    drawingId: data.drawingId,
    revisionId: data.revisionId,
    page: data.page,
    tool: data.tool,
    points: normalisePoints(data.points ?? []),
    calibrationPoints: normalisePoints(data.calibrationPoints ?? []),
    editing,
  }
  return isDraftEmpty(draft) ? null : draft
}

export function readDraft(storage, projectId, pageId) {
  if (!storage || !isId(projectId) || !isId(pageId)) return null
  try {
    return parseSavedDraft(storage.getItem(draftStorageKey(projectId, pageId)))
  } catch {
    return null
  }
}

// Writes the in-progress work for ITS sheet, or clears that sheet's entry when
// there is none. Returns true when the storage accepted the write — the
// workspace keeps its before-unload warning regardless, because sessionStorage
// dies with the tab.
export function writeDraft(storage, projectId, draft) {
  if (!storage || !isId(projectId) || !draft || !isId(draft.pageId)) return false
  try {
    const key = draftStorageKey(projectId, draft.pageId)
    if (isDraftEmpty(draft) || !isId(draft.drawingId) || !isId(draft.revisionId) || !isPageNumber(draft.page)
        || draft.pageId !== takeoffPageId(draft.drawingId, draft.revisionId, draft.page)) {
      storage.removeItem(key)
      return true
    }
    storage.setItem(key, JSON.stringify({
      v: DRAFT_VERSION,
      pageId: draft.pageId,
      drawingId: draft.drawingId,
      revisionId: draft.revisionId,
      page: draft.page,
      tool: DRAFT_TOOLS.includes(draft.tool) ? draft.tool : 'select',
      points: normalisePoints(draft.points ?? []),
      calibrationPoints: normalisePoints(draft.calibrationPoints ?? []).slice(0, 2),
      editing: draft.editing
        ? { measurementId: draft.editing.measurementId, revision: draft.editing.revision, points: normalisePoints(draft.editing.points) }
        : null,
    }))
    return true
  } catch {
    return false
  }
}

export function clearDraft(storage, projectId, pageId) {
  if (!storage || !isId(projectId) || !isId(pageId)) return false
  try { storage.removeItem(draftStorageKey(projectId, pageId)); return true } catch { return false }
}

// Every remembered draft of ONE project — so the workspace can say "you have
// unsaved work on two other sheets" and open them. Needs a storage that can be
// enumerated (`length` + `key(i)`); otherwise an empty list, never a throw.
export function listDrafts(storage, projectId) {
  if (!storage || !isId(projectId) || typeof storage.key !== 'function') return []
  const prefix = projectPrefix(projectId)
  const out = []
  try {
    const n = Number(storage.length) || 0
    for (let i = 0; i < n; i++) {
      const key = storage.key(i)
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue
      const draft = parseSavedDraft(storage.getItem(key))
      if (draft) out.push(draft)
    }
  } catch {
    return []
  }
  return out.sort((a, b) => a.pageId.localeCompare(b.pageId))
}

// ── Validation against the live sheet ────────────────────────────────────────
//
// What may actually be restored once the workspace knows which sheet it is on
// and has the page's measurements: the draft must belong to THIS page; a
// geometry edit is restored only against the same active measurement at the
// same revision (a measurement edited, voided or re-measured by anyone since is
// a different record — the edit is dropped, with a notice, never re-applied).
// Returns { draft, droppedEdit } or null when nothing applies.
export function restorableDraft(saved, { pageId, measurements = [] } = {}) {
  if (!saved || !isId(pageId) || saved.pageId !== pageId) return null
  let editing = null
  let droppedEdit = false
  if (saved.editing) {
    const m = measurements.find(x => x?.id === saved.editing.measurementId) ?? null
    if (m && m.status === 'active' && m.revision === saved.editing.revision && MEASUREMENT_KINDS.includes(m.kind)) {
      editing = { measurement: m, points: saved.editing.points }
    } else {
      droppedEdit = true
    }
  }
  const draft = { ...saved, editing }
  if (isDraftEmpty(draft)) return droppedEdit ? { draft: null, droppedEdit } : null
  return { draft, droppedEdit }
}
