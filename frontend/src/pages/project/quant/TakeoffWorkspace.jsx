import { useCallback, useState } from 'react'
import Card from '../../../components/Card'
import Btn from '../../../components/Btn'
import { useProfile } from '../../../hooks/useProfile'
import { useDrawings } from '../../../hooks/useDrawings'
import { useDrawingRevisions } from '../../../hooks/useDrawingRevisions'
import { useCostCodes } from '../../../hooks/useCostCodes'
import { useTakeoffPages, useTakeoffMeasurements } from '../../../hooks/useTakeoff'
import { currentRevision } from '../../../lib/drawings'
import {
  MEASUREMENT_KIND, KIND_LABELS, MIN_POINTS, MAX_POINTS, ZOOM_STEP, clampZoom, FIT_MODE,
  canUseQuant, canMeasureOnRevision, sourceWarning, takeoffPageId, measurementsForPage,
  activeMeasurements, calibrationSnapshot, validatePoints, formatMeasurementQuantity,
  measurementQuantity, summariseMeasurements, isReadableMeasurement, QUANT_ERROR,
} from '../../../lib/quant'
import { toolBtnCls } from './styles'
import SourcePicker from './SourcePicker'
import PageViewer from './PageViewer'
import MeasurementList from './MeasurementList'
import CalibrationModal from './CalibrationModal'
import MeasurementEditorModal from './MeasurementEditorModal'
import MeasurementVoidModal from './MeasurementVoidModal'

// ── The takeoff workspace (Quant 1A, ADR-51) ─────────────────────────────────
//
// Owns the selection (drawing → revision → page), the active tool, the
// in-progress geometry and the zoom; mounts the drawing, revision, cost-code
// and takeoff subscriptions; and routes every save through the hooks'
// revision-guarded transactions. It never computes a quantity itself and never
// touches a BOQ item, budget line or any financial record.
//
// Interaction model (desktop and touch alike):
//   · pick a tool, tap the sheet to add points; Finish (or Enter) completes a
//     length or area and opens the save dialog; Undo (or Backspace) removes
//     the last point; Cancel (or Escape) abandons the draft
//   · Calibrate: two taps, then the known distance
//   · Geometry: drag a measurement's handles, then Save geometry
// Everything that changes a record asks for confirmation inside a dialog and
// reports success only after the transaction has committed.

const TOOL = {
  SELECT:    'select',
  CALIBRATE: 'calibrate',
  LENGTH:    MEASUREMENT_KIND.LENGTH,
  AREA:      MEASUREMENT_KIND.AREA,
  COUNT:     MEASUREMENT_KIND.COUNT,
}

const isKindTool = (tool) => tool === TOOL.LENGTH || tool === TOOL.AREA || tool === TOOL.COUNT

export default function TakeoffWorkspace({ projectId }) {
  const { profile } = useProfile()
  const canWrite = canUseQuant(profile?.role)

  const { drawings, drawingsLoading, drawingsError } = useDrawings(projectId)
  const { costCodes } = useCostCodes()
  const { takeoffPages, takeoffPagesLoading, takeoffPagesError, saveCalibration } = useTakeoffPages(projectId)
  const {
    takeoffMeasurements, takeoffMeasurementsLoading, takeoffMeasurementsError,
    createMeasurement, updateMeasurement, voidMeasurement,
  } = useTakeoffMeasurements(projectId)

  // ── Selection ─────────────────────────────────────────────────────────────
  const [drawingId, setDrawingId]   = useState(null)
  const [revisionChoice, setRevisionChoice] = useState(null) // null → the current revision
  const [page, setPage]             = useState(1)
  const { revisions, revisionsLoading, revisionsError } = useDrawingRevisions(projectId, drawingId)

  const drawing  = drawings.find(d => d.id === drawingId) ?? null
  const revision = (revisionChoice && revisions.find(r => r.id === revisionChoice)) || currentRevision(drawing, revisions)
  const revisionId = revision?.id ?? null

  // ── Sheet geometry (reported by the viewer) ───────────────────────────────
  const [sheet, setSheet] = useState({ geometry: null, numPages: 0 })
  const onGeometry = useCallback((geometry, { numPages }) => setSheet({ geometry, numPages }), [])
  const geometry = sheet.geometry

  // ── Tool, drafts, zoom ────────────────────────────────────────────────────
  const [tool, setTool] = useState(TOOL.SELECT)
  const [draftPoints, setDraftPoints] = useState([])
  const [calibrationPoints, setCalibrationPoints] = useState([])
  const [editing, setEditing] = useState(null)       // { measurement, points }
  const [selectedId, setSelectedId] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState(FIT_MODE.WIDTH)
  const [notice, setNotice] = useState(null)         // { tone: 'ok' | 'error', text }

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
  const warning = revision || !drawing ? sourceWarning(revision, drawing) : null
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

  const resetDrafts = useCallback(() => {
    setDraftPoints([])
    setCalibrationPoints([])
    setEditing(null)
  }, [])

  // Changing sheet clears every draft — a half-drawn polygon must never be
  // saved onto a different page. Done in the change handlers (the only paths
  // that move the selection), never in an effect.
  const changeDrawing = (id) => { resetDrafts(); setDrawingId(id); setRevisionChoice(null); setPage(1); setSelectedId(null); setNotice(null) }
  const changeRevision = (id) => { resetDrafts(); setRevisionChoice(id); setPage(1); setSelectedId(null); setNotice(null) }
  const changePage = (n) => {
    if (Number.isInteger(n) && n >= 1 && (!sheet.numPages || n <= sheet.numPages)) { resetDrafts(); setPage(n); setSelectedId(null) }
  }

  const chooseTool = (next) => {
    resetDrafts()
    setTool(t => (t === next ? TOOL.SELECT : next))
  }

  // ── Points from the sheet ─────────────────────────────────────────────────
  const onPoint = useCallback((p) => {
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
  }, [measurable, tool, calibrated])

  const onDragPoint = useCallback((index, p) => {
    setEditing(prev => {
      if (!prev) return prev
      const points = prev.points.slice()
      points[index] = p
      return { ...prev, points }
    })
  }, [])

  const undoPoint = () => setDraftPoints(prev => prev.slice(0, -1))
  const cancelDraft = () => { resetDrafts(); setNotice(null) }

  const finishDraft = () => {
    if (!isKindTool(tool)) return
    const error = validatePoints(tool, draftPoints)
    if (error) { setNotice({ tone: 'error', text: error }); return }
    setSaveDialog({ kind: tool, points: draftPoints })
  }

  // Keyboard: Enter finishes, Backspace undoes, Escape cancels — on the
  // viewer region, never while a dialog or an input has focus.
  const onKeyDown = (e) => {
    if (calibrationDialog || saveDialog || detailsDialog || voidDialog) return
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return
    if (e.key === 'Enter' && isKindTool(tool) && draftPoints.length > 0) { e.preventDefault(); finishDraft() }
    if (e.key === 'Backspace' && draftPoints.length > 0) { e.preventDefault(); undoPoint() }
    if (e.key === 'Escape') { e.preventDefault(); cancelDraft() }
  }

  // ── Saves (each resolves only after the server committed) ─────────────────
  const report = (err, fallback) => {
    const text = err?.kind === QUANT_ERROR.STALE
      ? err.message
      : (err?.message || fallback)
    setNotice({ tone: 'error', text })
    throw err
  }

  const handleSaveCalibration = async (draft) => {
    try {
      await saveCalibration({ identity, geometry, draft, seenPage: takeoffPage })
      setCalibrationPoints([])
      setTool(TOOL.SELECT)
      setNotice({ tone: 'ok', text: takeoffPage?.calibration ? 'Calibration replaced. Existing lengths and areas are flagged for review.' : 'Calibration saved.' })
    } catch (err) { report(err, 'The calibration could not be saved.') }
  }

  const handleSaveMeasurement = async ({ label, costCodeId, costCodeName }) => {
    try {
      await createMeasurement({
        identity, geometry,
        draft: { kind: saveDialog.kind, points: saveDialog.points, label, costCodeId, costCodeName },
        seenPage: takeoffPage,
      })
      setDraftPoints([])
      setNotice({ tone: 'ok', text: `${KIND_LABELS[saveDialog.kind]} saved.` })
    } catch (err) { report(err, 'The measurement could not be saved.') }
  }

  const handleSaveDetails = async ({ label, costCodeId, costCodeName }) => {
    try {
      await updateMeasurement({ seen: detailsDialog, changes: { label, costCodeId, costCodeName } })
      setNotice({ tone: 'ok', text: 'Measurement details saved.' })
    } catch (err) { report(err, 'The details could not be saved.') }
  }

  const startGeometryEdit = (m) => {
    if (!measurable) { setNotice({ tone: 'error', text: 'This sheet cannot be edited.' }); return }
    setTool(TOOL.SELECT)
    setDraftPoints([])
    setCalibrationPoints([])
    setSelectedId(m.id)
    setEditing({ measurement: m, kind: m.kind, points: m.points.map(p => ({ x: p.x, y: p.y })) })
  }

  const handleSaveGeometry = async () => {
    if (!editing) return
    const error = validatePoints(editing.kind, editing.points)
    if (error) { setNotice({ tone: 'error', text: error }); return }
    try {
      const calibration = editing.kind === MEASUREMENT_KIND.COUNT ? undefined : calibrationSnapshot(takeoffPage)
      if (editing.kind !== MEASUREMENT_KIND.COUNT && !calibration) {
        setNotice({ tone: 'error', text: 'Calibrate this page before editing a length or an area.' })
        return
      }
      await updateMeasurement({ seen: editing.measurement, changes: { points: editing.points }, calibration })
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
      await updateMeasurement({ seen: m, changes: {}, calibration })
      setNotice({ tone: 'ok', text: `"${m.label}" marked as reviewed under the current scale.` })
    } catch (err) {
      setNotice({ tone: 'error', text: err?.message || 'The review could not be saved.' })
    }
  }

  const handleVoid = async (reason) => {
    try {
      await voidMeasurement({ seen: voidDialog, reason })
      if (selectedId === voidDialog.id) setSelectedId(null)
      setNotice({ tone: 'ok', text: 'Measurement voided.' })
    } catch (err) { report(err, 'The measurement could not be voided.') }
  }

  // ── Live draft quantity (preview only) ────────────────────────────────────
  const draftQuantity = isKindTool(tool) && draftPoints.length >= MIN_POINTS[tool]
    ? formatMeasurementQuantity(measurementQuantity({ kind: tool, points: draftPoints }, takeoffPage?.calibration ?? null))
    : null
  const editingQuantity = editing
    ? formatMeasurementQuantity(measurementQuantity({ kind: editing.kind, points: editing.points }, takeoffPage?.calibration ?? null))
    : null

  const unavailable = takeoffPagesError || takeoffMeasurementsError

  return (
    <div className="flex flex-col gap-3.5">
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

          {/* Draft controls */}
          {(isKindTool(tool) || tool === TOOL.CALIBRATE || editing) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-brand-bg/60 px-3 py-2" role="status">
              {editing ? (
                <>
                  <span className="text-[12.5px] text-brand-text">
                    Editing geometry of <span className="font-semibold">{editing.measurement.label}</span> — drag the handles.
                    {editingQuantity && <> Now <span className="font-semibold tabular-nums">{editingQuantity}</span>.</>}
                  </span>
                  <Btn sm onClick={handleSaveGeometry}>Save geometry</Btn>
                  <Btn sm variant="ghost" onClick={cancelDraft}>Cancel</Btn>
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
                  <Btn sm onClick={finishDraft} disabled={draftPoints.length < MIN_POINTS[tool]}>Finish</Btn>
                  <Btn sm variant="ghost" onClick={undoPoint} disabled={draftPoints.length === 0}>Undo</Btn>
                  <Btn sm variant="ghost" onClick={cancelDraft}>Cancel</Btn>
                </>
              )}
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
              onPoint={onPoint}
              onDragPoint={onDragPoint}
              pointerEnabled={measurable && (isKindTool(tool) || tool === TOOL.CALIBRATE) && !editing}
              overlay={{
                measurements: editing ? activeOnPage.filter(m => m.id !== editing.measurement.id) : activeOnPage,
                selectedId,
                draft: isKindTool(tool) ? { kind: tool, points: draftPoints } : null,
                editing: editing ? { kind: editing.kind, points: editing.points } : null,
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
                    : summary[kind].incomplete > 0 ? `${summary[kind].incomplete} need scale`
                    : formatMeasurementQuantity({ value: summary[kind].total, unit: summary[kind].unit })}
                </p>
              </div>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11px] text-brand-muted">
            Page totals are a read-time summary of this page only. Quant 1A writes no BOQ quantity — linking and
            applying reviewed quantities to BOQ items is Quant 1B.
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
          onSave={handleSaveMeasurement}
          onClose={() => setSaveDialog(null)}
        />
      )}

      {detailsDialog && (
        <MeasurementEditorModal
          measurement={detailsDialog}
          calibration={takeoffPage?.calibration ?? null}
          costCodes={costCodes}
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
