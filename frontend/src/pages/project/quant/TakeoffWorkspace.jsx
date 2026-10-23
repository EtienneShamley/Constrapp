import { useCallback, useEffect, useState } from 'react'
import Card from '../../../components/Card'
import Btn from '../../../components/Btn'
import { useProfile } from '../../../hooks/useProfile'
import { useDrawings } from '../../../hooks/useDrawings'
import { useDrawingRevisions } from '../../../hooks/useDrawingRevisions'
import { useCostCodes } from '../../../hooks/useCostCodes'
import { useBoqItems } from '../../../hooks/useBoqItems'
import { useTakeoffPages, useTakeoffMeasurements } from '../../../hooks/useTakeoff'
import { currentRevision } from '../../../lib/drawings'
import { readSelection, writeSelection, selectableDrawing, effectivePage } from '../../../lib/quantSelection'
import { readDraft, writeDraft, clearDraft, listDrafts, restorableDraft } from '../../../lib/quantDraft'
import { summariseTakeoff, summaryReadiness, measurementTarget } from '../../../lib/quantSummary'
import {
  MEASUREMENT_KIND, MEASUREMENT_STATUS, KIND_LABELS, MIN_POINTS, MAX_POINTS, ZOOM_STEP, clampZoom, FIT_MODE,
  canUseQuant, canMeasureOnRevision, sourceWarning, takeoffPageId, measurementsForPage,
  activeMeasurements, calibrationSnapshot, validatePoints, formatMeasurementQuantity,
  measurementQuantity, quantityIssue, summariseMeasurements, isReadableMeasurement, QUANT_ERROR,
  hitTestMeasurements, nearestSegment, insertPointAt, removePointAt, canRemovePoint,
} from '../../../lib/quant'
import { toolBtnCls } from './styles'
import SourcePicker from './SourcePicker'
import PageViewer from './PageViewer'
import MeasurementList from './MeasurementList'
import CalibrationModal from './CalibrationModal'
import MeasurementEditorModal from './MeasurementEditorModal'
import MeasurementVoidModal from './MeasurementVoidModal'
import TakeoffSummary from './TakeoffSummary'

// ── The takeoff workspace (Quant 1A, ADR-51; interaction ADR-53) ─────────────
//
// Owns the selection (drawing → revision → page), the active tool, the
// in-progress geometry, the geometry-edit session and the zoom; mounts the
// drawing, revision, cost-code, takeoff and (READ-ONLY, ADR-52) BOQ-item
// subscriptions; and routes every save through the hooks' revision-guarded
// transactions. It never computes a quantity itself and never WRITES a BOQ
// item, budget line or any financial record: the BOQ items are read so a
// measurement can be LINKED to one, and applying a measured quantity is the
// BOQ tab's explicit step.
//
// Interaction model (desktop and touch alike):
//   · Select: tap a shape on the sheet to select it (zoom-aware hit test in
//     lib/quant.js); drag to pan; the selected measurement's row is
//     highlighted and its Details / Geometry / Void controls are offered
//   · Length / Area / Count: tap the sheet to add points; Finish (or Enter)
//     completes and opens the save dialog; Undo (or Backspace) removes the
//     last point; Cancel (or Escape) abandons the draft
//   · Calibrate: two taps, then the known distance
//   · Geometry: drag a vertex; tap an edge to insert a vertex; tap a vertex to
//     select it, then Remove point (or Delete); Count: tap to add a marker;
//     Undo steps back within the session; Save geometry (or Enter) persists;
//     Cancel (or Escape) discards every change
// Everything that changes a record asks for confirmation inside a dialog and
// reports success only after the transaction has committed.
//
// UNSAVED WORK (ADR-53). The sheet is remembered per project in sessionStorage
// (lib/quantSelection.js) and, since 1C-A, so is the in-progress draft or edit
// (lib/quantDraft.js): leaving the tab (the layout's keyed Outlet unmounts
// this workspace), switching routes or refreshing brings both back on the same
// sheet, validated against the live records. Changing the drawing, revision,
// page or tool while something is unsaved asks first; closing the tab warns
// through the browser; a save in flight is never discarded — navigation is
// held behind a confirmation until it has committed. Nothing is written to
// Firestore until the user saves.
//
// SUMMARY AND TRACEABILITY (Quant 1C-B, ADR-53). A second VIEW on the same
// tab — Measure / Project summary — renders lib/quantSummary.js over the
// subscriptions already mounted here (no new listener): per-kind totals of
// current, valid measurements, historical sheets kept apart, and an attention
// list. "Open" on any row or page is `openTarget`: the target is validated
// against the live register first (void, missing or withdrawn → an explanation,
// never another sheet), then the selection moves — with the same discard
// confirmation as any other sheet change — and the measurement is highlighted
// once its sheet has loaded. The BOQ apply dialog's "Open in Quant" arrives the
// same way, through the remembered selection's optional `measurementId`.
// Drafts are remembered PER SHEET, so opening another measurement's sheet
// never costs the work on the one you left.

const TOOL = {
  SELECT:    'select',
  CALIBRATE: 'calibrate',
  LENGTH:    MEASUREMENT_KIND.LENGTH,
  AREA:      MEASUREMENT_KIND.AREA,
  COUNT:     MEASUREMENT_KIND.COUNT,
}

const isKindTool = (tool) => tool === TOOL.LENGTH || tool === TOOL.AREA || tool === TOOL.COUNT

export const DISCARD_MESSAGE = 'You have unsaved measurement work on this sheet. Discard it?'
const LEAVE_WHILE_SAVING_MESSAGE = 'A save is still in progress. Leave this page anyway? The save will complete, but its result will not be shown.'

// The browser's per-tab storage, or null where there is none (lib/quantSelection.js
// treats null as "remember nothing"). Read inside the initialiser and the
// effect only — never during render.
const browserStorage = () => (typeof window !== 'undefined' ? window.sessionStorage : null)

const samePoints = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((p, i) => p.x === b[i].x && p.y === b[i].y)

export default function TakeoffWorkspace({ projectId }) {
  const { profile } = useProfile()
  const canWrite = canUseQuant(profile?.role)

  const { drawings, drawingsLoading, drawingsError } = useDrawings(projectId)
  const { costCodes } = useCostCodes()
  // Read-only here: the picker in the editor and the BOQ column in the list.
  // The hook's write functions are deliberately not destructured.
  const { boqItems, boqItemsLoading, boqItemsError } = useBoqItems(projectId)
  const { takeoffPages, takeoffPagesLoading, takeoffPagesError, saveCalibration } = useTakeoffPages(projectId)
  const {
    takeoffMeasurements, takeoffMeasurementsLoading, takeoffMeasurementsError,
    createMeasurement, updateMeasurement, voidMeasurement,
  } = useTakeoffMeasurements(projectId)

  // ── Selection ─────────────────────────────────────────────────────────────
  // Initial values come from the remembered selection for THIS project (null
  // when nothing is remembered or the browser has no usable sessionStorage).
  const [saved] = useState(() => readSelection(browserStorage(), projectId))
  const [drawingChoice, setDrawingChoice] = useState(saved?.drawingId ?? null)
  const [revisionChoice, setRevisionChoice] = useState(saved?.revisionId ?? null) // null → the current revision
  const [pageChoice, setPageChoice] = useState(saved?.page ?? 1)

  // A choice counts only once the records that vouch for it have loaded: the
  // drawing must be in the register and not withdrawn (what the picker offers),
  // the revision must be in the drawing's list. Until then nothing is selected
  // and no revision subscription is opened for an unverified id.
  const drawingsSettled = !drawingsLoading && !drawingsError
  const drawing = selectableDrawing(drawings, drawingChoice, { settled: drawingsSettled })
  const drawingId = drawing?.id ?? null
  const { revisions, revisionsLoading, revisionsError } = useDrawingRevisions(projectId, drawingId)
  const revisionsSettled = !!drawing && !revisionsLoading && !revisionsError
  // An explicit choice counts only if the loaded list contains it (withdrawn and
  // superseded revisions ARE listed — they stay inspectable; a deleted or
  // foreign id is not). Inlined: the React Compiler could not preserve the
  // callbacks' memoisation when this lookup went through an imported helper.
  const chosen = (revisionsSettled && revisionChoice && revisions.find(r => r.id === revisionChoice)) || null
  const revision = chosen || currentRevision(drawing, revisions)
  const revisionId = revision?.id ?? null
  const page = effectivePage({ page: pageChoice, revisionId: revisionChoice, chosen, settled: revisionsSettled })

  // ── Sheet geometry (reported by the viewer) ───────────────────────────────
  const [sheet, setSheet] = useState({ geometry: null, numPages: 0 })
  const onGeometry = useCallback((geometry, { numPages }) => setSheet({ geometry, numPages }), [])
  const geometry = sheet.geometry

  // ── Tool, drafts, edit session, zoom ──────────────────────────────────────
  const [tool, setTool] = useState(TOOL.SELECT)
  const [draftPoints, setDraftPoints] = useState([])
  const [calibrationPoints, setCalibrationPoints] = useState([])
  // { measurement, kind, points, history: [points…], vertex: index | null, pending: points | null }
  const [editing, setEditing] = useState(null)
  // The remembered selection may name a measurement to highlight (1C-B).
  const [selectedId, setSelectedId] = useState(saved?.measurementId ?? null)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState(FIT_MODE.WIDTH)
  const [notice, setNotice] = useState(null)         // { tone: 'ok' | 'error', text }
  const [pendingSaves, setPendingSaves] = useState(0)
  const [view, setView] = useState('measure')        // 'measure' | 'summary'
  // A source being opened (from the summary, the BOQ dialog or the remembered
  // selection): checked against the live records as they settle, explained
  // when it cannot be reached. { drawingId, revisionId, page, measurementId }
  const [target, setTarget] = useState(saved?.measurementId
    ? { drawingId: saved.drawingId, revisionId: saved.revisionId, page: saved.page, measurementId: saved.measurementId }
    : null)

  // Remember the EFFECTIVE selection — only once the records have settled, so
  // a loading or failed register never overwrites what was remembered. A
  // cleared drawing clears the entry. sessionStorage only; never Firestore.
  // Since 1C-B the selected measurement rides along (optional `measurementId`).
  useEffect(() => {
    if (!drawingsSettled) return
    if (drawingId && !revisionsSettled) return
    writeSelection(browserStorage(), projectId, { drawingId, revisionId: chosen?.id ?? null, page, measurementId: selectedId })
  }, [projectId, drawingsSettled, revisionsSettled, drawingId, chosen, page, selectedId])

  // ── Dialogs ───────────────────────────────────────────────────────────────
  const [calibrationDialog, setCalibrationDialog] = useState(null) // { pointA, pointB }
  const [saveDialog, setSaveDialog] = useState(null)               // { kind, points }
  const [detailsDialog, setDetailsDialog] = useState(null)         // measurement
  const [voidDialog, setVoidDialog] = useState(null)               // measurement

  // ── Derived ───────────────────────────────────────────────────────────────
  const identity = drawingId && revisionId ? { drawingId, revisionId, page } : null
  const pageId = identity ? takeoffPageId(identity.drawingId, identity.revisionId, identity.page) : ''
  const takeoffPage = takeoffPages.find(p => p.id === pageId) ?? null
  const pageMeasurements = measurementsForPage(takeoffMeasurements, pageId)
  const activeOnPage = activeMeasurements(pageMeasurements).filter(isReadableMeasurement)
  // The sheet banner is computed ONLY for a selected drawing whose revisions
  // have actually loaded. With no drawing there is nothing to warn about; while
  // revisions load the picker shows its loading state; a failed revisions read
  // is reported as unavailable (never as "revision not found"). Only a drawing
  // that genuinely has no loadable revision — or a superseded / withdrawn one —
  // gets the warning. Each value here derives from the CURRENT drawingId, so a
  // drawing switch can never carry a stale banner across.
  const warning = revisionsSettled ? sourceWarning(revision, drawing) : null
  // `measurable` — new measurements, geometry edits, details, review and
  // re-calibration: the sheet must be LIVE (revision and drawing not withdrawn).
  // `voidable` — void only: permitted on a withdrawn sheet too (the one write
  // rules allow there; a reasoned void of a historical measurement is
  // housekeeping, never a re-measurement).
  const sheetLive = canMeasureOnRevision(revision, drawing)
  const measurable = !!identity && !!geometry && sheetLive && canWrite
    && !takeoffPagesError && !takeoffMeasurementsError
  const voidable = !!identity && canWrite && !takeoffPagesError && !takeoffMeasurementsError
  const calibrated = !!takeoffPage?.calibration
  const summary = summariseMeasurements(pageMeasurements, takeoffPage?.calibration ?? null)
  const selected = selectedId ? activeOnPage.find(m => m.id === selectedId) ?? null : null

  // Unsaved work: a draft with points, a calibration pair in progress, or a
  // geometry edit that changed something. A clean edit session is not "work".
  const editDirty = !!editing && !samePoints(editing.points, editing.measurement.points)
  const hasUnsavedWork = draftPoints.length > 0 || calibrationPoints.length > 0 || editDirty

  // Clears the in-progress state AND this sheet's remembered draft — called only
  // once the user has saved, cancelled, or agreed to discard.
  const resetDrafts = () => {
    setDraftPoints([])
    setCalibrationPoints([])
    setEditing(null)
    if (pageId) clearDraft(browserStorage(), projectId, pageId)
  }

  // One explicit question before anything discards unsaved work. Never asked
  // for a clean state. `window.confirm` is the register convention for a
  // state-changing row action (DESIGN_SYSTEM.md → Tables).
  const confirmDiscard = () => !hasUnsavedWork || window.confirm(DISCARD_MESSAGE)

  // Changing sheet clears every draft — a half-drawn polygon must never be
  // saved onto a different page. Done in the change handlers (the only paths
  // that move the selection), never in an effect, and only after the user has
  // agreed to lose what is unsaved.
  const changeDrawing = (id) => { if (!confirmDiscard()) return; resetDrafts(); setDrawingChoice(id); setRevisionChoice(null); setPageChoice(1); setSelectedId(null); setNotice(null) }
  const changeRevision = (id) => { if (!confirmDiscard()) return; resetDrafts(); setRevisionChoice(id); setPageChoice(1); setSelectedId(null); setNotice(null) }
  const changePage = (n) => {
    if (Number.isInteger(n) && n >= 1 && (!sheet.numPages || n <= sheet.numPages)) {
      if (!confirmDiscard()) return
      resetDrafts(); setPageChoice(n); setSelectedId(null)
    }
  }

  const chooseTool = (next) => {
    if (!confirmDiscard()) return
    resetDrafts()
    setTool(t => (t === next ? TOOL.SELECT : next))
  }

  // ── Opening a source (summary, BOQ dialog, remembered selection) ──────────
  // `t` = { drawingId, revisionId, page, measurementId | null }. The selection
  // moves exactly as the picker would move it (same discard confirmation, same
  // validation of the ids against the loaded records); `target` then watches
  // the records settle and explains anything that cannot be reached.
  const openTarget = (t) => {
    if (!t?.drawingId || !t?.revisionId || !Number.isInteger(t.page)) return
    const samePage = t.drawingId === drawingId && t.revisionId === revisionId && t.page === page
    if (!samePage) {
      if (!confirmDiscard()) return
      resetDrafts()
      setDrawingChoice(t.drawingId)
      setRevisionChoice(t.revisionId)
      setPageChoice(t.page)
    } else {
      setEditing(null)
    }
    setTool(TOOL.SELECT)
    setSelectedId(t.measurementId ?? null)
    setNotice(null)
    setTarget({ drawingId: t.drawingId, revisionId: t.revisionId, page: t.page, measurementId: t.measurementId ?? null })
    setView('measure')
  }

  // A measurement row's "Open": void, missing or withdrawn sources are
  // explained, never navigated to (lib/quantSummary.js → measurementTarget).
  const openMeasurement = (m) => {
    const result = measurementTarget(m, { drawings })
    if (!result.ok) { setNotice({ tone: 'error', text: result.message }); setView('measure'); return }
    openTarget(result)
  }

  // Resolve the target as the records arrive. Each outcome is said once, then
  // the target is cleared; state is written from a microtask only.
  useEffect(() => {
    if (!target) return undefined
    let outcome = null
    if (drawingsSettled && drawingChoice === target.drawingId && !drawing) {
      outcome = { tone: 'error', text: 'That drawing is not in the register or has been withdrawn, so its sheet cannot be opened here.' }
    } else if (drawing && revisionsSettled && revisionChoice === target.revisionId && !chosen) {
      outcome = { tone: 'error', text: 'That drawing revision could not be found. The current revision is shown instead; the measurement was not opened.' }
    } else if (pageId && pageId === takeoffPageId(target.drawingId, target.revisionId, target.page) && !takeoffMeasurementsLoading && !takeoffMeasurementsError) {
      if (!target.measurementId) outcome = { tone: 'ok', text: 'Sheet opened.' }
      else {
        const m = takeoffMeasurements.find(x => x.id === target.measurementId) ?? null
        if (!m) outcome = { tone: 'error', text: 'That measurement no longer exists on this sheet (it may have been removed or is not accessible to you).' }
        else if (m.status !== MEASUREMENT_STATUS.ACTIVE) outcome = { tone: 'error', text: `"${m.label}" has been voided. It is listed under Voided below and is no longer drawn.` }
        else outcome = { tone: 'ok', text: `"${m.label}" is selected on this sheet.` }
      }
    } else if (takeoffMeasurementsError) {
      outcome = { tone: 'error', text: 'Takeoff records are unavailable, so the measurement could not be located.' }
    }
    if (!outcome) return undefined
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      setNotice(outcome)
      if (outcome.tone === 'error' && outcome.text.includes('voided')) setSelectedId(null)
      setTarget(null)
    })
    return () => { cancelled = true }
  }, [target, drawingsSettled, drawingChoice, drawing, revisionsSettled, revisionChoice, chosen, pageId, takeoffMeasurementsLoading, takeoffMeasurementsError, takeoffMeasurements])

  // ── Browser-level protection ──────────────────────────────────────────────
  // Closing or reloading the tab with unsaved work or a save in flight gets
  // the browser's own "leave this page?" prompt. (A reload restores the draft
  // from sessionStorage; closing the tab would not — hence the prompt.)
  useEffect(() => {
    if (!hasUnsavedWork && pendingSaves === 0) return undefined
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedWork, pendingSaves])

  // While a save is in flight, an in-app link (a project tab, the sidebar) is
  // held behind a confirmation: the transaction would still commit, but its
  // outcome could no longer be shown. Drafts need no such hold — they are
  // remembered and restored.
  useEffect(() => {
    if (pendingSaves === 0) return undefined
    const onClick = (e) => {
      const link = e.target?.closest?.('a[href]')
      if (!link || link.target === '_blank' || e.defaultPrevented) return
      if (!window.confirm(LEAVE_WHILE_SAVING_MESSAGE)) { e.preventDefault(); e.stopPropagation() }
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [pendingSaves])

  // ── Remembered drafts (sessionStorage, per sheet, validated before use) ───
  // `restoredFor` is the sheet whose draft has been looked up; `otherDrafts`
  // are the project's remembered drafts on OTHER sheets, offered to reopen.
  const [restoredFor, setRestoredFor] = useState(null)
  const [otherDrafts, setOtherDrafts] = useState([])

  // Restore ONCE PER SHEET, when the workspace knows which sheet it is on and
  // has that sheet's measurements (a geometry edit is restored only against
  // the same active measurement at the same revision; a stale one is dropped
  // and said so). Drafts on other sheets are left where they are. State is
  // written from a microtask, never in the effect body.
  useEffect(() => {
    if (!pageId || takeoffMeasurementsLoading || restoredFor === pageId) return undefined
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      const storage = browserStorage()
      const saved = readDraft(storage, projectId, pageId)
      const result = restorableDraft(saved, { pageId, measurements: measurementsForPage(takeoffMeasurements, pageId) })
      if (result?.draft) {
        const d = result.draft
        setTool(d.tool === 'edit' || !Object.values(TOOL).includes(d.tool) ? TOOL.SELECT : d.tool)
        setDraftPoints(d.points)
        setCalibrationPoints(d.calibrationPoints)
        if (d.calibrationPoints.length === 2) setCalibrationDialog({ pointA: d.calibrationPoints[0], pointB: d.calibrationPoints[1] })
        if (d.editing) {
          const m = d.editing.measurement
          setEditing({ measurement: m, kind: m.kind, points: d.editing.points, history: [], vertex: null, pending: null })
          setSelectedId(m.id)
        }
        setNotice({ tone: 'ok', text: result.droppedEdit ? 'Your unsaved work was restored; a geometry edit was dropped because that measurement changed.' : 'Your unsaved work on this sheet was restored.' })
      } else if (result?.droppedEdit) {
        setNotice({ tone: 'error', text: 'An unsaved geometry edit was dropped: the measurement changed since you started it.' })
        clearDraft(storage, projectId, pageId)
      }
      setOtherDrafts(listDrafts(storage, projectId).filter(d => d.pageId !== pageId))
      setRestoredFor(pageId)
    })
    return () => { cancelled = true }
  }, [restoredFor, pageId, takeoffMeasurementsLoading, takeoffMeasurements, projectId])

  // Persist this sheet's in-progress work once its restore has run (so an
  // empty initial state never erases a remembered draft). An empty draft
  // clears this sheet's entry and no other.
  useEffect(() => {
    if (!pageId || restoredFor !== pageId || !drawingId || !revisionId) return
    writeDraft(browserStorage(), projectId, {
      pageId,
      drawingId,
      revisionId,
      page,
      tool: editing ? 'edit' : tool,
      points: draftPoints,
      calibrationPoints,
      editing: editing ? { measurementId: editing.measurement.id, revision: editing.measurement.revision, points: editing.points } : null,
    })
  }, [restoredFor, projectId, pageId, drawingId, revisionId, page, tool, draftPoints, calibrationPoints, editing])

  // ── Taps on the sheet (canonical point + zoom-aware tolerance) ────────────
  const editTap = (p, tolerance) => {
    setEditing(prev => {
      if (!prev) return prev
      if (prev.kind === MEASUREMENT_KIND.COUNT) {
        if (prev.points.length >= MAX_POINTS) return prev
        return { ...prev, history: [...prev.history, prev.points], points: [...prev.points, p], vertex: prev.points.length, pending: null }
      }
      const seg = nearestSegment(prev.points, p, prev.kind === MEASUREMENT_KIND.AREA)
      if (seg && seg.distance <= tolerance && prev.points.length < MAX_POINTS) {
        return { ...prev, history: [...prev.history, prev.points], points: insertPointAt(prev.points, seg.index, p), vertex: seg.index + 1, pending: null }
      }
      // Off the shape: just drop the vertex selection.
      return prev.vertex === null ? prev : { ...prev, vertex: null }
    })
  }

  const onTap = (p, { tolerance }) => {
    if (editing) {
      if (!measurable) return
      editTap(p, tolerance)
      return
    }
    if (tool === TOOL.SELECT) {
      setSelectedId(hitTestMeasurements(activeOnPage, p, tolerance))
      return
    }
    if (!measurable) return
    if (tool === TOOL.CALIBRATE) {
      setCalibrationPoints(prev => {
        const next = [...prev, p].slice(-2)
        if (next.length === 2) setCalibrationDialog({ pointA: next[0], pointB: next[1] })
        return next
      })
      return
    }
    if (isKindTool(tool)) {
      if (tool !== TOOL.COUNT && !calibrated) {
        setNotice({ tone: 'error', text: 'Calibrate this page before measuring a length or an area.' })
        return
      }
      setDraftPoints(prev => (prev.length >= MAX_POINTS ? prev : [...prev, p]))
    }
  }

  // ── Vertex drags (edit session) ───────────────────────────────────────────
  const onVertexDragStart = useCallback((index) => {
    setEditing(prev => (prev ? { ...prev, vertex: index, pending: prev.points } : prev))
  }, [])
  const onVertexDrag = useCallback((index, p) => {
    setEditing(prev => {
      if (!prev) return prev
      const points = prev.points.slice()
      points[index] = p
      // The first move of a drag records the pre-drag points for Undo.
      const history = prev.pending ? [...prev.history, prev.pending] : prev.history
      return { ...prev, points, history, pending: null }
    })
  }, [])
  const onVertexDragEnd = useCallback(() => {
    setEditing(prev => (prev && prev.pending ? { ...prev, pending: null } : prev))
  }, [])

  const undoEdit = () => setEditing(prev => {
    if (!prev || prev.history.length === 0) return prev
    const history = prev.history.slice()
    const points = history.pop()
    return { ...prev, points, history, vertex: null, pending: null }
  })
  const removeVertex = () => {
    if (!editing) return
    if (editing.vertex === null) { setNotice({ tone: 'error', text: 'Tap a point on the sheet to select it, then remove it.' }); return }
    if (!canRemovePoint(editing.kind, editing.points)) {
      setNotice({ tone: 'error', text: `A ${KIND_LABELS[editing.kind].toLowerCase()} needs at least ${MIN_POINTS[editing.kind]} point${MIN_POINTS[editing.kind] === 1 ? '' : 's'}.` })
      return
    }
    setNotice(null)
    setEditing(prev => ({ ...prev, history: [...prev.history, prev.points], points: removePointAt(prev.points, prev.vertex), vertex: null, pending: null }))
  }

  const undoPoint = () => setDraftPoints(prev => prev.slice(0, -1))
  const cancelDraft = () => { resetDrafts(); setNotice(null) }

  const finishDraft = () => {
    if (!isKindTool(tool)) return
    const error = validatePoints(tool, draftPoints)
    if (error) { setNotice({ tone: 'error', text: error }); return }
    setSaveDialog({ kind: tool, points: draftPoints })
  }

  // Keyboard: Enter finishes (or saves geometry), Backspace undoes (or removes
  // the selected vertex), Escape cancels — on the viewer region, never while a
  // dialog or an input has focus.
  const onKeyDown = (e) => {
    if (calibrationDialog || saveDialog || detailsDialog || voidDialog) return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return
    if (editing) {
      if (e.key === 'Enter') { e.preventDefault(); handleSaveGeometry() }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (editing.vertex !== null) removeVertex(); else undoEdit() }
      if (e.key === 'Escape') { e.preventDefault(); cancelDraft() }
      return
    }
    if (e.key === 'Enter' && isKindTool(tool) && draftPoints.length > 0) { e.preventDefault(); finishDraft() }
    if (e.key === 'Backspace' && draftPoints.length > 0) { e.preventDefault(); undoPoint() }
    if (e.key === 'Escape') { e.preventDefault(); cancelDraft() }
  }

  // ── Saves (each resolves only after the server committed) ─────────────────
  // Every save is counted while in flight: the browser warns before unloading
  // and in-app navigation asks first, so a commit is never left unreported.
  const tracked = async (work) => {
    setPendingSaves(n => n + 1)
    try { return await work() } finally { setPendingSaves(n => n - 1) }
  }

  const report = (err, fallback) => {
    const text = err?.kind === QUANT_ERROR.STALE
      ? err.message
      : (err?.message || fallback)
    setNotice({ tone: 'error', text })
    throw err
  }

  const handleSaveCalibration = async (draft) => {
    try {
      await tracked(() => saveCalibration({ identity, geometry, draft, seenPage: takeoffPage }))
      setCalibrationPoints([])
      setTool(TOOL.SELECT)
      setNotice({ tone: 'ok', text: takeoffPage?.calibration ? 'Calibration replaced. Existing lengths and areas are flagged for review.' : 'Calibration saved.' })
    } catch (err) { report(err, 'The calibration could not be saved.') }
  }

  const handleSaveMeasurement = async ({ label, costCodeId, costCodeName, boqItemId }) => {
    try {
      await tracked(() => createMeasurement({
        identity, geometry,
        draft: { kind: saveDialog.kind, points: saveDialog.points, label, costCodeId, costCodeName, boqItemId: boqItemId ?? null },
        seenPage: takeoffPage,
      }))
      setDraftPoints([])
      setNotice({ tone: 'ok', text: `${KIND_LABELS[saveDialog.kind]} saved${boqItemId ? ' and linked to the BOQ item' : ''}.` })
    } catch (err) { report(err, 'The measurement could not be saved.') }
  }

  const handleSaveDetails = async ({ label, costCodeId, costCodeName, boqItemId }) => {
    try {
      const result = await tracked(() => updateMeasurement({ seen: detailsDialog, changes: { label, costCodeId, costCodeName, boqItemId: boqItemId ?? null } }))
      setNotice({ tone: 'ok', text: result?.linkCleared ? 'Measurement details saved. The BOQ item link was cleared because the cost code changed.' : 'Measurement details saved.' })
    } catch (err) { report(err, 'The details could not be saved.') }
  }

  const startGeometryEdit = (m) => {
    if (!measurable) { setNotice({ tone: 'error', text: 'This sheet cannot be edited.' }); return }
    if (!confirmDiscard()) return
    setTool(TOOL.SELECT)
    setDraftPoints([])
    setCalibrationPoints([])
    setSelectedId(m.id)
    setNotice(null)
    setEditing({ measurement: m, kind: m.kind, points: m.points.map(p => ({ x: p.x, y: p.y })), history: [], vertex: null, pending: null })
  }

  const handleSaveGeometry = async () => {
    if (!editing) return
    const error = validatePoints(editing.kind, editing.points)
    if (error) { setNotice({ tone: 'error', text: error }); return }
    if (!editDirty) { setNotice({ tone: 'ok', text: 'No geometry change to save.' }); setEditing(null); return }
    try {
      const calibration = editing.kind === MEASUREMENT_KIND.COUNT ? undefined : calibrationSnapshot(takeoffPage)
      if (editing.kind !== MEASUREMENT_KIND.COUNT && !calibration) {
        setNotice({ tone: 'error', text: 'Calibrate this page before editing a length or an area.' })
        return
      }
      await tracked(() => updateMeasurement({ seen: editing.measurement, changes: { points: editing.points }, calibration }))
      setEditing(null)
      setNotice({ tone: 'ok', text: 'Geometry saved and re-measured under the current scale.' })
    } catch (err) {
      setNotice({ tone: 'error', text: err?.message || 'The geometry could not be saved.' })
    }
  }

  const handleReview = async (m) => {
    const calibration = calibrationSnapshot(takeoffPage)
    if (!calibration) { setNotice({ tone: 'error', text: 'This page has no calibration to review against.' }); return }
    try {
      await tracked(() => updateMeasurement({ seen: m, changes: {}, calibration }))
      setNotice({ tone: 'ok', text: `"${m.label}" marked as reviewed under the current scale.` })
    } catch (err) {
      setNotice({ tone: 'error', text: err?.message || 'The review could not be saved.' })
    }
  }

  const handleVoid = async (reason) => {
    try {
      await tracked(() => voidMeasurement({ seen: voidDialog, reason }))
      if (selectedId === voidDialog.id) setSelectedId(null)
      setNotice({ tone: 'ok', text: 'Measurement voided.' })
    } catch (err) { report(err, 'The measurement could not be voided.') }
  }

  // ── Live draft quantity (preview only) ────────────────────────────────────
  const draftQ = isKindTool(tool) && draftPoints.length >= MIN_POINTS[tool]
    ? measurementQuantity({ kind: tool, points: draftPoints }, takeoffPage?.calibration ?? null)
    : null
  const draftQuantity = draftQ ? formatMeasurementQuantity(draftQ) : null
  const draftIssue = quantityIssue(draftQ)
  const editingQ = editing
    ? measurementQuantity({ kind: editing.kind, points: editing.points }, takeoffPage?.calibration ?? null)
    : null
  const editingQuantity = editingQ ? formatMeasurementQuantity(editingQ) : null
  const editError = editing ? (validatePoints(editing.kind, editing.points) || quantityIssue(editingQ)) : null
  const selectedQuantity = selected ? formatMeasurementQuantity(measurementQuantity(selected, takeoffPage?.calibration ?? null)) : null

  const unavailable = takeoffPagesError || takeoffMeasurementsError
  const viewerMode = !geometry ? 'none' : editing ? 'edit' : tool

  // ── Project summary (1C-B) — derived from the subscriptions already mounted ─
  const projectSummary = summariseTakeoff({ measurements: takeoffMeasurements, takeoffPages, drawings, costCodes, boqItems, revisions })
  const summaryState = summaryReadiness({
    measurements: { loading: takeoffMeasurementsLoading, error: takeoffMeasurementsError },
    pages:        { loading: takeoffPagesLoading,        error: takeoffPagesError },
    drawings:     { loading: drawingsLoading,            error: drawingsError },
    boq:          { loading: boqItemsLoading,            error: boqItemsError },
  })
  const drawingNumber = (id) => drawings.find(d => d.id === id)?.drawingNumber ?? 'a drawing'

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quant view">
        <button type="button" className={toolBtnCls(view === 'measure')} aria-pressed={view === 'measure'} onClick={() => setView('measure')}>Measure</button>
        <button type="button" className={toolBtnCls(view === 'summary')} aria-pressed={view === 'summary'} onClick={() => setView('summary')}>
          Project summary{summaryState === 'ready' && projectSummary.counts.attention > 0 ? ` · ${projectSummary.counts.attention} need attention` : ''}
        </button>
        {hasUnsavedWork && view === 'summary' && (
          <span className="text-[11.5px] text-brand-amber" role="status">Unsaved work on the current sheet is kept while you review.</span>
        )}
      </div>

      {otherDrafts.length > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-amber/50 bg-brand-amber/10 px-3 py-2 text-[12.5px] text-brand-text">
          <span>Unsaved work on {otherDrafts.length === 1 ? 'another sheet' : `${otherDrafts.length} other sheets`} is remembered:</span>
          {otherDrafts.map(d => (
            <Btn key={d.pageId} sm variant="ghost" onClick={() => openTarget({ drawingId: d.drawingId, revisionId: d.revisionId, page: d.page, measurementId: d.editing?.measurementId ?? null })}>
              Open {drawingNumber(d.drawingId)} · p.{d.page}
            </Btn>
          ))}
        </div>
      )}

      {view === 'summary' && (
        <TakeoffSummary
          summary={projectSummary}
          readiness={summaryState}
          onOpenMeasurement={openMeasurement}
          onOpenPage={openTarget}
        />
      )}

      {/* The measuring workspace stays MOUNTED behind the summary (hidden, not
          unmounted), so the loaded sheet, the zoom and any in-progress draft
          survive a look at the summary. */}
      <div className={view === 'summary' ? 'hidden' : 'flex flex-col gap-3.5'}>
      <Card>
        <SourcePicker
          drawings={drawings} drawingsLoading={drawingsLoading} drawingsError={drawingsError}
          drawingId={drawingId} onDrawingChange={changeDrawing}
          revisions={revisions} revisionsLoading={revisionsLoading} revisionsError={revisionsError}
          revisionId={revisionId} onRevisionChange={changeRevision}
          page={page} numPages={sheet.numPages} onPageChange={changePage}
        />
      </Card>

      {warning && (
        <div role="alert" className={`rounded-lg border-2 px-4 py-3 ${warning.tone === 'withdrawn' ? 'border-brand-red bg-brand-red/10' : 'border-brand-amber bg-brand-amber/10'}`}>
          <p className={`text-[13px] font-bold tracking-[0.5px] m-0 ${warning.tone === 'withdrawn' ? 'text-brand-red' : 'text-brand-amber'}`}>{warning.title}</p>
          <p className="text-[13px] font-semibold text-brand-text mt-1 mb-0">{warning.body}</p>
        </div>
      )}

      {drawing && revisionsError && (
        <div role="alert" className="rounded-lg border-2 border-brand-red bg-brand-red/10 px-4 py-3">
          <p className="text-[13px] font-bold text-brand-red m-0">This drawing&apos;s revisions are unavailable.</p>
          <p className="text-[12.5px] text-brand-text mt-1 mb-0">
            The revision list could not be loaded, so no sheet can be shown. Check your connection and refresh.
          </p>
        </div>
      )}

      {unavailable && (
        <div role="alert" className="rounded-lg border-2 border-brand-red bg-brand-red/10 px-4 py-3">
          <p className="text-[13px] font-bold text-brand-red m-0">Takeoff records are unavailable.</p>
          <p className="text-[12.5px] text-brand-text mt-1 mb-0">
            The saved calibration and measurements could not be loaded, so nothing is shown and nothing can be
            saved. Check your connection and refresh.
          </p>
        </div>
      )}

      {identity && (
        <Card>
          {/* Tool strip */}
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Takeoff tools">
            <button type="button" className={toolBtnCls(tool === TOOL.SELECT && !editing)} aria-pressed={tool === TOOL.SELECT && !editing} onClick={() => { if (tool !== TOOL.SELECT || editing) chooseTool(TOOL.SELECT) }} disabled={!geometry}>
              Select
            </button>
            <button type="button" className={toolBtnCls(tool === TOOL.CALIBRATE)} aria-pressed={tool === TOOL.CALIBRATE} onClick={() => chooseTool(TOOL.CALIBRATE)} disabled={!measurable}>
              Calibrate{calibrated ? ' ✓' : ''}
            </button>
            <button type="button" className={toolBtnCls(tool === TOOL.LENGTH)} aria-pressed={tool === TOOL.LENGTH} onClick={() => chooseTool(TOOL.LENGTH)} disabled={!measurable || !calibrated}>Length</button>
            <button type="button" className={toolBtnCls(tool === TOOL.AREA)} aria-pressed={tool === TOOL.AREA} onClick={() => chooseTool(TOOL.AREA)} disabled={!measurable || !calibrated}>Area</button>
            <button type="button" className={toolBtnCls(tool === TOOL.COUNT)} aria-pressed={tool === TOOL.COUNT} onClick={() => chooseTool(TOOL.COUNT)} disabled={!measurable}>Count</button>
            <span className="mx-1 hidden h-6 w-px bg-brand-border sm:block" aria-hidden="true" />
            <button type="button" className={toolBtnCls(false)} onClick={() => setZoom(z => clampZoom(z / ZOOM_STEP))} aria-label="Zoom out" disabled={!geometry}>−</button>
            <span className="min-w-[52px] text-center text-[12px] tabular-nums text-brand-muted" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button type="button" className={toolBtnCls(false)} onClick={() => setZoom(z => clampZoom(z * ZOOM_STEP))} aria-label="Zoom in" disabled={!geometry}>+</button>
            <button type="button" className={toolBtnCls(fitMode === FIT_MODE.WIDTH && zoom === 1)} onClick={() => { setFitMode(FIT_MODE.WIDTH); setZoom(1) }} disabled={!geometry}>Fit width</button>
            <button type="button" className={toolBtnCls(fitMode === FIT_MODE.PAGE && zoom === 1)} onClick={() => { setFitMode(FIT_MODE.PAGE); setZoom(1) }} disabled={!geometry}>Fit page</button>
          </div>
          <p className="m-0 mt-1.5 text-[11px] text-brand-muted">
            Ctrl/⌘ + scroll or pinch to zoom · drag with Select (or one finger) to pan · plain scroll moves the sheet.
          </p>

          {/* Draft / edit / selection controls */}
          {(isKindTool(tool) || tool === TOOL.CALIBRATE || editing) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-brand-bg/60 px-3 py-2" role="status">
              {editing ? (
                <>
                  <span className="text-[12.5px] text-brand-text">
                    Editing <span className="font-semibold">{editing.measurement.label}</span> —{' '}
                    {editing.kind === MEASUREMENT_KIND.COUNT
                      ? 'tap the sheet to add a marker, tap a marker to select it.'
                      : 'drag a point, tap an edge to add one, tap a point to select it.'}
                    {editingQuantity && <> Now <span className="font-semibold tabular-nums">{editingQuantity}</span>.</>}
                    {editing.vertex !== null && <> Point {editing.vertex + 1} selected.</>}
                  </span>
                  <Btn sm onClick={handleSaveGeometry} disabled={!!editError || !editDirty}>Save geometry</Btn>
                  <Btn sm variant="ghost" onClick={removeVertex} disabled={editing.vertex === null || !canRemovePoint(editing.kind, editing.points)}>Remove point</Btn>
                  <Btn sm variant="ghost" onClick={undoEdit} disabled={editing.history.length === 0}>Undo</Btn>
                  <Btn sm variant="ghost" onClick={cancelDraft}>Cancel</Btn>
                  {editError && <span className="basis-full text-[12px] text-brand-red" role="alert">{editError}</span>}
                </>
              ) : tool === TOOL.CALIBRATE ? (
                <>
                  <span className="text-[12.5px] text-brand-text">
                    Tap two points a known distance apart ({calibrationPoints.length} of 2).
                  </span>
                  <Btn sm variant="ghost" onClick={cancelDraft}>Cancel</Btn>
                </>
              ) : (
                <>
                  <span className="text-[12.5px] text-brand-text">
                    {KIND_LABELS[tool]}: {draftPoints.length} point{draftPoints.length === 1 ? '' : 's'}
                    {draftQuantity && <> · <span className="font-semibold tabular-nums">{draftQuantity}</span></>}
                    {draftPoints.length < MIN_POINTS[tool] && <> · needs {MIN_POINTS[tool]}</>}
                  </span>
                  <Btn sm onClick={finishDraft} disabled={draftPoints.length < MIN_POINTS[tool] || !!draftIssue}>Finish</Btn>
                  <Btn sm variant="ghost" onClick={undoPoint} disabled={draftPoints.length === 0}>Undo</Btn>
                  <Btn sm variant="ghost" onClick={cancelDraft}>Cancel</Btn>
                  {draftIssue && <span className="basis-full text-[12px] text-brand-red" role="alert">{draftIssue}</span>}
                </>
              )}
            </div>
          )}

          {selected && !editing && tool === TOOL.SELECT && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-brand-accent/30 bg-brand-accent/5 px-3 py-2" role="status">
              <span className="text-[12.5px] text-brand-text">
                Selected: <span className="font-semibold">{selected.label}</span> · {KIND_LABELS[selected.kind]}
                {selectedQuantity && <> · <span className="font-semibold tabular-nums">{selectedQuantity}</span></>}
              </span>
              {measurable && <Btn sm variant="ghost" onClick={() => setDetailsDialog(selected)}>Details</Btn>}
              {measurable && <Btn sm variant="ghost" onClick={() => startGeometryEdit(selected)}>Geometry</Btn>}
              {voidable && <Btn sm variant="ghost" className="text-brand-red" onClick={() => setVoidDialog(selected)}>Void</Btn>}
              <Btn sm variant="ghost" onClick={() => setSelectedId(null)}>Clear</Btn>
            </div>
          )}

          {notice && (
            <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`m-0 mt-2.5 text-[12.5px] ${notice.tone === 'error' ? 'text-brand-red' : 'text-brand-accent'}`}>
              {notice.text}
            </p>
          )}

          {/* The sheet. tabIndex makes the keyboard shortcuts reachable. */}
          <div className="mt-3 outline-none focus-visible:ring-2 focus-visible:ring-brand-accent rounded-lg" tabIndex={0} onKeyDown={onKeyDown}>
            <PageViewer
              revision={revision}
              page={page}
              zoom={zoom}
              fitMode={fitMode}
              onGeometry={onGeometry}
              onZoomChange={setZoom}
              mode={viewerMode}
              onTap={onTap}
              editPoints={editing && measurable ? editing.points : null}
              onVertexDragStart={onVertexDragStart}
              onVertexDrag={onVertexDrag}
              onVertexDragEnd={onVertexDragEnd}
              overlay={{
                measurements: editing ? activeOnPage.filter(m => m.id !== editing.measurement.id) : activeOnPage,
                selectedId,
                draft: isKindTool(tool) ? { kind: tool, points: draftPoints } : null,
                editing: editing ? { kind: editing.kind, points: editing.points, vertex: editing.vertex } : null,
                calibration: takeoffPage?.calibration ?? null,
                calibrationDraft: calibrationPoints,
              }}
            />
          </div>

          {/* Page status */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-brand-bg/60 px-3 py-2">
              <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Calibration</p>
              <p className="m-0 mt-0.5 text-[13px] font-semibold text-brand-text">
                {takeoffPagesLoading ? '—' : calibrated ? `${takeoffPage.calibration.realDistance} ${takeoffPage.calibration.unit} known · rev ${takeoffPage.calibrationRevision}` : 'Not calibrated'}
              </p>
            </div>
            {[MEASUREMENT_KIND.LENGTH, MEASUREMENT_KIND.AREA, MEASUREMENT_KIND.COUNT].map(kind => (
              <div key={kind} className="rounded-lg bg-brand-bg/60 px-3 py-2">
                <p className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{KIND_LABELS[kind]} · {summary[kind].count}</p>
                <p className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">
                  {takeoffMeasurementsLoading ? '—' : summary[kind].count === 0 ? '—'
                    : summary[kind].incomplete > 0 ? `${summary[kind].incomplete} need${summary[kind].incomplete === 1 ? 's' : ''} attention`
                    : formatMeasurementQuantity({ value: summary[kind].total, unit: summary[kind].unit })}
                </p>
              </div>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11px] text-brand-muted">
            Page totals are a read-time summary of this page only. Quant writes no BOQ quantity by itself — link a
            measurement to a BOQ item here, then review and apply the measured total on the BOQ tab.
          </p>
        </Card>
      )}

      {identity && (
        <div>
          <h2 className="text-[13px] font-bold text-brand-text mb-2">Measurements on this page</h2>
          <Card padding={false}>
            {takeoffMeasurementsError ? (
              <p className="m-0 px-4 py-8 text-center text-[13px] text-brand-red">Measurements are unavailable.</p>
            ) : takeoffMeasurementsLoading ? (
              <p className="m-0 px-4 py-8 text-center text-[13px] text-brand-muted">Loading measurements…</p>
            ) : (
              <MeasurementList
                measurements={pageMeasurements}
                page={takeoffPage}
                costCodes={costCodes}
                boqItems={boqItems}
                boqItemsLoading={boqItemsLoading}
                boqItemsError={boqItemsError}
                selectedId={selectedId}
                canEdit={measurable}
                canVoid={voidable}
                onSelect={(m) => setSelectedId(id => (id === m.id ? null : m.id))}
                onEditDetails={(m) => setDetailsDialog(m)}
                onEditGeometry={startGeometryEdit}
                onReview={handleReview}
                onVoid={(m) => setVoidDialog(m)}
              />
            )}
          </Card>
        </div>
      )}
      </div>

      {calibrationDialog && (
        <CalibrationModal
          pointA={calibrationDialog.pointA}
          pointB={calibrationDialog.pointB}
          source={geometry?.source}
          existingCalibration={takeoffPage?.calibration ?? null}
          affectedCount={activeOnPage.filter(m => m.kind !== MEASUREMENT_KIND.COUNT).length}
          onSave={handleSaveCalibration}
          onClose={() => { setCalibrationDialog(null); setCalibrationPoints([]) }}
        />
      )}

      {saveDialog && (
        <MeasurementEditorModal
          measurement={{ kind: saveDialog.kind, points: saveDialog.points }}
          calibration={takeoffPage?.calibration ?? null}
          costCodes={costCodes}
          boqItems={boqItems}
          boqItemsLoading={boqItemsLoading}
          boqItemsError={boqItemsError}
          onSave={handleSaveMeasurement}
          onClose={() => setSaveDialog(null)}
        />
      )}

      {detailsDialog && (
        <MeasurementEditorModal
          measurement={detailsDialog}
          calibration={takeoffPage?.calibration ?? null}
          costCodes={costCodes}
          boqItems={boqItems}
          boqItemsLoading={boqItemsLoading}
          boqItemsError={boqItemsError}
          onSave={handleSaveDetails}
          onClose={() => setDetailsDialog(null)}
        />
      )}

      {voidDialog && (
        <MeasurementVoidModal
          measurement={voidDialog}
          onConfirm={handleVoid}
          onClose={() => setVoidDialog(null)}
        />
      )}
    </div>
  )
}
