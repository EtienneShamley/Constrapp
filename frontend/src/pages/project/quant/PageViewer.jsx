import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { getFileBytes, getFileUrl } from '../../../hooks/useStorageUpload'
import { isImageContentType, isPdfContentType } from '../../../lib/files'
import { openPdf, pageGeometry, renderPage, isRenderCancelled } from '../../../lib/pdfRender'
import {
  PAGE_SOURCE, RENDER_LIMITS, HIT_TOLERANCE_PX,
  screenToCanonical, nearestVertex, wheelZoom, pinchZoom, zoomAboutPoint, pointerDistance,
} from '../../../lib/quant'
import { loadPdfjs } from './pdfjsLoader'
import MeasurementOverlay from './MeasurementOverlay'

// ── The sheet on screen (Quant 1A, ADR-51; interaction ADR-53) ───────────────
//
// Renders ONE page of ONE drawing revision — a PDF page into a <canvas>
// through PDF.js, or a PNG/JPEG into an <img> — under an SVG overlay drawn in
// the page's CANONICAL coordinates (lib/quant.js). The overlay's box IS the
// page's CSS box (pageWidth × cssScale by pageHeight × cssScale); the canvas
// fills that box, so the bitmap and the geometry line up at every zoom and
// any device pixel ratio. Pointer positions are converted to canonical units
// from the overlay's rendered rectangle — screen pixels are never stored.
//
// Resources are released on every change: an in-flight render is cancelled,
// the page proxy is cleaned up, and the document is destroyed when the
// revision changes or the viewer unmounts. Bytes are fetched once per
// revision (getFileBytes); a download URL is minted for images and never
// persisted.
//
// INTERACTION (Quant 1C-A). One pointer model on the <svg>, resolved in
// canonical units so nothing depends on zoom:
//   · a TAP (press and release within the slop) → `onTap(point, { tolerance })`
//     — the workspace decides what a tap means for the active tool
//   · in `edit` mode a press within 22 px of a vertex (half a 44 px target,
//     nearest vertex wins — never two) starts a VERTEX DRAG
//   · a press that moves beyond the slop PANS the scroller — any touch, or a
//     mouse/pen while the Select tool is active; measuring tools ignore a
//     mouse drag, so a slip never places a point
//   · two pointers PINCH-ZOOM about their midpoint; Ctrl/⌘ + wheel zooms
//     about the cursor; plain wheel scrolls as the browser always did; the
//     toolbar's −/+ zoom about the centre of the visible area
// Every zoom change is anchored: the sheet position under the pointer (or the
// centre) stays put, through the pure lib/quant.js → zoomAboutPoint. The <svg>
// is `touch-action: none` so both fingers reach us; pointer capture keeps a
// drag alive outside the sheet; cancel clears every gesture.
//
// State is written only from async callbacks, never synchronously in an
// effect body (ADR-41 discipline, react-hooks/set-state-in-effect).

const TAP_SLOP_PX = 6

const isTouchLimits = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches

const MEASURING_MODES = ['calibrate', 'length', 'area', 'count', 'edit']

export default function PageViewer({
  revision, page, zoom, fitMode,
  onGeometry,        // (geometry | null, { numPages }) — canonical page metadata
  onZoomChange,      // (zoom) — a wheel or pinch asks for a new zoom (already clamped)
  mode = 'none',     // 'none' | 'select' | 'calibrate' | 'length' | 'area' | 'count' | 'edit'
  onTap,             // (canonicalPoint, { tolerance }) — a tap on the sheet
  editPoints = null, // the points being edited (edit mode) — for vertex hit testing
  onVertexDragStart, // (index)
  onVertexDrag,      // (index, canonicalPoint)
  onVertexDragEnd,   // ()
  overlay,           // props for MeasurementOverlay (measurements, draft, editing, …)
}) {
  const containerRef = useRef(null)
  const canvasRef    = useRef(null)
  const svgRef       = useRef(null)
  // Gesture bookkeeping — never rendered, so refs, written only in handlers/effects.
  const pointersRef  = useRef(new Map())
  const gestureRef   = useRef(null)
  const zoomRef      = useRef(zoom)
  const anchorRef    = useRef(null)
  const scaleRef     = useRef(null)
  const frameRef     = useRef(0)

  const storagePath = revision?.storagePath ?? null
  const contentType = revision?.contentType ?? null
  const isPdf   = isPdfContentType(contentType)
  const isImage = isImageContentType(contentType)

  // Document state — keyed by storagePath so a revision switch shows nothing stale.
  const [docState, setDocState] = useState({ key: null, pdf: null, imageUrl: null, error: null })
  // Page state — keyed by `${storagePath}#${page}`.
  const [pageState, setPageState] = useState({ key: null, pageProxy: null, geometry: null, error: null })
  const [containerWidth, setContainerWidth] = useState(0)
  const [rendering, setRendering] = useState(false)
  const [panning, setPanning] = useState(false)

  useEffect(() => { zoomRef.current = zoom }, [zoom])

  // ── Container width (fit-to-width) ────────────────────────────────────────
  // Observes the SCROLLER's content box (contentRect excludes its border), so a
  // fit-to-width sheet is exactly as wide as the area it scrolls in and never
  // one border-width wider — which would otherwise leave a permanent 2px
  // horizontal scroll and a visible misfit at "Fit width".
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0
      setContainerWidth(Math.floor(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Load the document (PDF bytes → PDF.js; image → download URL) ─────────
  useEffect(() => {
    if (!storagePath || (!isPdf && !isImage)) return undefined
    let cancelled = false
    let handle = null

    if (isPdf) {
      Promise.all([loadPdfjs(), getFileBytes(storagePath)])
        .then(([pdfjs, bytes]) => openPdf(pdfjs, new Uint8Array(bytes)))
        .then((opened) => {
          if (cancelled) { opened.destroy(); return }
          handle = opened
          setDocState({ key: storagePath, pdf: opened, imageUrl: null, error: null })
        })
        .catch((err) => {
          if (!cancelled) setDocState({ key: storagePath, pdf: null, imageUrl: null, error: err?.message || 'Could not open this PDF.' })
        })
    } else {
      getFileUrl(storagePath).then(
        (url) => { if (!cancelled) setDocState({ key: storagePath, pdf: null, imageUrl: url, error: null }) },
        (err) => { if (!cancelled) setDocState({ key: storagePath, pdf: null, imageUrl: null, error: err?.message || 'Could not open this image.' }) },
      )
    }
    return () => {
      cancelled = true
      if (handle) handle.destroy()
    }
  }, [storagePath, isPdf, isImage])

  const docSettled = docState.key === storagePath
  const pdf      = docSettled ? docState.pdf : null
  const imageUrl = docSettled ? docState.imageUrl : null
  const docError = docSettled ? docState.error : null

  // ── Load the page proxy and report its canonical geometry ─────────────────
  const pageKey = storagePath ? `${storagePath}#${page}` : null
  useEffect(() => {
    if (!pdf || !pageKey) return undefined
    let cancelled = false
    let proxy = null
    if (page < 1 || page > pdf.numPages) {
      // Reported through the same async path so the effect body stays pure.
      Promise.resolve().then(() => {
        if (!cancelled) setPageState({ key: pageKey, pageProxy: null, geometry: null, error: `This PDF has ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}.` })
      })
      return () => { cancelled = true }
    }
    pdf.getPage(page).then(
      (p) => {
        if (cancelled) { p.cleanup(); return }
        proxy = p
        setPageState({ key: pageKey, pageProxy: p, geometry: pageGeometry(p), error: null })
      },
      (err) => { if (!cancelled) setPageState({ key: pageKey, pageProxy: null, geometry: null, error: err?.message || 'Could not read this page.' }) },
    )
    return () => {
      cancelled = true
      if (proxy) proxy.cleanup()
    }
  }, [pdf, page, pageKey])

  const pageSettled = pageState.key === pageKey
  const pageProxy = pageSettled ? pageState.pageProxy : null
  const geometry  = pageSettled ? pageState.geometry : null
  const pageError = pageSettled ? pageState.error : null

  // Image geometry arrives from the <img> load event.
  const onImageLoad = useCallback((e) => {
    const img = e.currentTarget
    setPageState({
      key: pageKey,
      pageProxy: null,
      geometry: { source: PAGE_SOURCE.IMAGE, pageWidth: img.naturalWidth, pageHeight: img.naturalHeight, pageRotation: 0 },
      error: null,
    })
  }, [pageKey])

  // Tell the parent what the sheet is (or that it is not available).
  useEffect(() => {
    onGeometry?.(geometry, { numPages: pdf?.numPages ?? (imageUrl ? 1 : 0) })
  }, [geometry, pdf, imageUrl, onGeometry])

  // ── Scale: CSS pixels per canonical unit ─────────────────────────────────
  const cssScale = (() => {
    if (!geometry || containerWidth <= 0) return 1
    const byWidth = containerWidth / geometry.pageWidth
    const fit = fitMode === 'page'
      ? Math.min(byWidth, Math.max(240, Math.floor(window.innerHeight * 0.7)) / geometry.pageHeight)
      : byWidth
    return fit * zoom
  })()
  const cssWidth  = geometry ? Math.max(1, Math.round(geometry.pageWidth * cssScale)) : 0
  const cssHeight = geometry ? Math.max(1, Math.round(geometry.pageHeight * cssScale)) : 0

  // ── Anchored zoom: keep the point under the pointer (or the centre) still ─
  // Runs after the SVG has its new size and before paint, so the scroll jump
  // and the resize land in the same frame. Only a SCALE change on the SAME
  // sheet in the SAME container is anchored — a new page or a resized window
  // keeps the browser's own scroll position.
  useLayoutEffect(() => {
    const el = containerRef.current
    const prev = scaleRef.current
    scaleRef.current = { cssScale, pageKey, containerWidth }
    if (!el || !prev || prev.pageKey !== pageKey || prev.containerWidth !== containerWidth || prev.cssScale === cssScale) {
      anchorRef.current = null
      return
    }
    const anchor = anchorRef.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
    anchorRef.current = null
    const next = zoomAboutPoint({
      scrollLeft: el.scrollLeft, scrollTop: el.scrollTop,
      pointerX: anchor.x, pointerY: anchor.y,
      scaleBefore: prev.cssScale, scaleAfter: cssScale,
    })
    el.scrollLeft = next.scrollLeft
    el.scrollTop = next.scrollTop
  }, [cssScale, pageKey, containerWidth])

  // ── Render the PDF page into the canvas at the current scale ─────────────
  // Waits for the scroller to be measured: rendering at the provisional scale
  // of 1 would be thrown away a frame later.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!pageProxy || !canvas || cssScale <= 0 || containerWidth <= 0) return undefined
    let cancelled = false
    const limits = isTouchLimits() ? RENDER_LIMITS.touch : RENDER_LIMITS.desktop
    const { task } = renderPage(pageProxy, canvas, {
      cssScale,
      devicePixelRatio: window.devicePixelRatio || 1,
      limits,
    })
    Promise.resolve().then(() => { if (!cancelled) setRendering(true) })
    task.promise.then(
      () => { if (!cancelled) setRendering(false) },
      (err) => { if (!cancelled && !isRenderCancelled(err)) setRendering(false) },
    )
    return () => {
      cancelled = true
      task.cancel()
    }
  }, [pageProxy, cssScale, containerWidth])

  // ── Wheel: Ctrl/⌘ + wheel zooms about the cursor; plain wheel scrolls ─────
  // A native, NON-passive listener: React's onWheel is passive and could not
  // preventDefault the browser's page zoom. Removed with the scroller.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !onZoomChange) return undefined
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      anchorRef.current = { x: e.clientX - rect.left - el.clientLeft, y: e.clientY - rect.top - el.clientTop }
      onZoomChange(wheelZoom(zoomRef.current, e.deltaY, e.deltaMode))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoomChange])

  // Pinch updates are coalesced to one per animation frame.
  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }, [])

  // ── Pointer handling ──────────────────────────────────────────────────────
  const toCanonical = useCallback((e) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !geometry) return null
    return screenToCanonical(e.clientX, e.clientY, rect, geometry.pageWidth, geometry.pageHeight)
  }, [geometry])

  const tolerance = HIT_TOLERANCE_PX / cssScale
  const canPanWithMouse = mode === 'select'

  const endGesture = useCallback((e) => {
    const g = gestureRef.current
    gestureRef.current = null
    if (g?.kind === 'drag') onVertexDragEnd?.()
    if (g?.kind === 'pan') setPanning(false)
    if (e) e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [onVertexDragEnd])

  const onPointerDown = useCallback((e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      // A second finger turns whatever was happening into a pinch — no tap,
      // no drag, no pan will follow from either pointer.
      const [a, b] = [...pointersRef.current.values()]
      if (gestureRef.current?.kind === 'drag') onVertexDragEnd?.()
      if (gestureRef.current?.kind === 'pan') setPanning(false)
      gestureRef.current = { kind: 'pinch', startDistance: pointerDistance(a, b), startZoom: zoomRef.current }
      e.currentTarget.setPointerCapture?.(e.pointerId)
      return
    }
    if (pointersRef.current.size > 2) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (mode === 'edit' && Array.isArray(editPoints) && editPoints.length > 0) {
      const p = toCanonical(e)
      const hit = p ? nearestVertex(editPoints, p) : null
      if (hit && hit.distance <= tolerance) {
        gestureRef.current = { kind: 'drag', index: hit.index }
        onVertexDragStart?.(hit.index)
        return
      }
    }
    const el = containerRef.current
    gestureRef.current = {
      kind: 'press', x: e.clientX, y: e.clientY,
      scrollLeft: el?.scrollLeft ?? 0, scrollTop: el?.scrollTop ?? 0,
      pointerType: e.pointerType,
    }
  }, [mode, editPoints, toCanonical, tolerance, onVertexDragStart, onVertexDragEnd])

  const onPointerMove = useCallback((e) => {
    const pointers = pointersRef.current
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gestureRef.current
    if (!g) return
    if (g.kind === 'pinch') {
      if (pointers.size < 2 || !onZoomChange) return
      const [a, b] = [...pointers.values()]
      const el = containerRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        anchorRef.current = { x: (a.x + b.x) / 2 - rect.left - el.clientLeft, y: (a.y + b.y) / 2 - rect.top - el.clientTop }
      }
      const next = pinchZoom(g.startZoom, g.startDistance, pointerDistance(a, b))
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => { frameRef.current = 0; onZoomChange(next) })
      return
    }
    if (g.kind === 'drag') {
      const p = toCanonical(e)
      if (p) onVertexDrag?.(g.index, p)
      return
    }
    if (g.kind === 'press') {
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= TAP_SLOP_PX) return
      if (g.pointerType === 'touch' || canPanWithMouse) {
        gestureRef.current = { ...g, kind: 'pan' }
        setPanning(true)
      } else {
        // A mouse slip while measuring: not a tap, not a pan — nothing.
        gestureRef.current = { ...g, kind: 'slip' }
      }
    }
    const pan = gestureRef.current
    if (pan.kind === 'pan') {
      const el = containerRef.current
      if (!el) return
      el.scrollLeft = pan.scrollLeft - (e.clientX - pan.x)
      el.scrollTop  = pan.scrollTop  - (e.clientY - pan.y)
    }
  }, [onZoomChange, toCanonical, onVertexDrag, canPanWithMouse])

  const onPointerUp = useCallback((e) => {
    const pointers = pointersRef.current
    pointers.delete(e.pointerId)
    const g = gestureRef.current
    if (g?.kind === 'pinch') {
      // The pinch ends when the second finger lifts; the remaining pointer
      // must not turn into a tap, so the gesture is cleared for both.
      if (pointers.size < 2) endGesture(e)
      return
    }
    if (g?.kind === 'press' && onTap) {
      const p = toCanonical(e)
      endGesture(e)
      if (p) onTap(p, { tolerance })
      return
    }
    endGesture(e)
  }, [onTap, toCanonical, tolerance, endGesture])

  const onPointerCancel = useCallback((e) => {
    pointersRef.current.delete(e.pointerId)
    endGesture(e)
  }, [endGesture])

  // ── Render ────────────────────────────────────────────────────────────────
  if (!revision) {
    return <div className="px-5 py-10 text-center text-[13px] text-brand-muted">Choose a drawing revision to measure.</div>
  }
  if (!isPdf && !isImage) {
    return <div className="px-5 py-10 text-center text-[13px] text-brand-muted">This revision&apos;s file type cannot be measured.</div>
  }
  const error = docError || pageError
  if (error) {
    return (
      <div className="px-5 py-10 text-center" role="alert">
        <p className="text-[13px] text-brand-red m-0">The sheet could not be displayed.</p>
        <p className="text-[12px] text-brand-muted mt-1 mb-0">{error}</p>
      </div>
    )
  }

  const cursor = panning ? 'cursor-grabbing'
    : MEASURING_MODES.includes(mode) ? 'cursor-crosshair'
    : mode === 'select' ? 'cursor-grab'
    : 'cursor-default'

  return (
    <div className="w-full">
      {!geometry && (
        <p className="m-0 px-5 py-6 text-center text-[13px] text-brand-muted" role="status">
          {docSettled ? 'Preparing page…' : 'Loading sheet…'}
        </p>
      )}
      {/* The scroller pans. Its content box is what fit-to-width measures. The
          overlay is `touch-none` so one finger pans through our handler, a tap
          that does not move adds a point, and two fingers pinch. */}
      <div ref={containerRef} className="max-h-[75vh] overflow-auto rounded-lg border border-brand-border bg-white/5 touch-pan-x touch-pan-y overscroll-contain">
        <div className="relative inline-block align-top">
          {isPdf && (
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full bg-white"
              aria-hidden="true"
            />
          )}
          {/* The image reports its intrinsic size on load (the box is 0×0 until
              the overlay exists; the load event fires regardless of layout). */}
          {isImage && imageUrl && (
            <img
              src={imageUrl}
              alt={`Drawing revision ${revision.revisionCode}`}
              onLoad={onImageLoad}
              className="absolute inset-0 h-full w-full"
              draggable={false}
            />
          )}
          {geometry && (
            <svg
              ref={svgRef}
              role="img"
              aria-label={`Measurement overlay for page ${page}`}
              viewBox={`0 0 ${geometry.pageWidth} ${geometry.pageHeight}`}
              width={cssWidth}
              height={cssHeight}
              className={`relative block select-none touch-none ${cursor}`}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerMove={onPointerMove}
              onPointerCancel={onPointerCancel}
              onContextMenu={(e) => e.preventDefault()}
            >
              <MeasurementOverlay
                pageWidth={geometry.pageWidth}
                pageHeight={geometry.pageHeight}
                cssScale={cssScale}
                {...overlay}
              />
            </svg>
          )}
        </div>
      </div>
      {rendering && <p className="m-0 mt-1.5 text-[11px] text-brand-muted" role="status">Rendering…</p>}
    </div>
  )
}
