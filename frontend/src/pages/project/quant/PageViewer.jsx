import { useEffect, useRef, useState, useCallback } from 'react'
import { getFileBytes, getFileUrl } from '../../../hooks/useStorageUpload'
import { isImageContentType, isPdfContentType } from '../../../lib/files'
import { openPdf, pageGeometry, renderPage, isRenderCancelled } from '../../../lib/pdfRender'
import { PAGE_SOURCE, RENDER_LIMITS, screenToCanonical } from '../../../lib/quant'
import { loadPdfjs } from './pdfjsLoader'
import MeasurementOverlay from './MeasurementOverlay'

// ── The sheet on screen (Quant 1A, ADR-51) ───────────────────────────────────
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
// State is written only from async callbacks, never synchronously in an
// effect body (ADR-41 discipline, react-hooks/set-state-in-effect).

const TAP_SLOP_PX = 6

const isTouchLimits = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches

export default function PageViewer({
  revision, page, zoom, fitMode,
  onGeometry,        // (geometry | null, { numPages }) — canonical page metadata
  onPoint,           // (canonicalPoint) — a tap/click on the sheet
  onDragPoint,       // (index, canonicalPoint) — a handle being dragged
  pointerEnabled,    // whether taps add points
  overlay,           // props for MeasurementOverlay (measurements, draft, editing, …)
}) {
  const containerRef = useRef(null)
  const canvasRef    = useRef(null)
  const svgRef       = useRef(null)
  const pressRef     = useRef(null)
  const dragRef      = useRef(null)

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

  // ── Pointer handling: tap adds a point; drag moves an edit handle ────────
  const toCanonical = useCallback((e) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !geometry) return null
    return screenToCanonical(e.clientX, e.clientY, rect, geometry.pageWidth, geometry.pageHeight)
  }, [geometry])

  const onPointerDown = useCallback((e) => {
    if (dragRef.current) return
    pressRef.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onPointerUp = useCallback((e) => {
    const press = pressRef.current
    pressRef.current = null
    if (dragRef.current) {
      // End of a handle drag.
      dragRef.current = null
      e.currentTarget.releasePointerCapture?.(e.pointerId)
      return
    }
    if (!press || !pointerEnabled) return
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX) return
    const p = toCanonical(e)
    if (p) onPoint?.(p)
  }, [pointerEnabled, toCanonical, onPoint])

  const onPointerMove = useCallback((e) => {
    if (!dragRef.current) return
    const p = toCanonical(e)
    if (p) onDragPoint?.(dragRef.current.index, p)
  }, [toCanonical, onDragPoint])

  const onHandlePointerDown = useCallback((index, e) => {
    e.stopPropagation()
    dragRef.current = { index }
    pressRef.current = null
    svgRef.current?.setPointerCapture?.(e.pointerId)
  }, [])

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

  return (
    <div className="w-full">
      {!geometry && (
        <p className="m-0 px-5 py-6 text-center text-[13px] text-brand-muted" role="status">
          {docSettled ? 'Preparing page…' : 'Loading sheet…'}
        </p>
      )}
      {/* The scroller pans. `touch-pan-*` keeps one-finger scrolling on touch;
          a tap that does not move adds a point. Its content box is what
          fit-to-width measures. */}
      <div ref={containerRef} className="max-h-[75vh] overflow-auto rounded-lg border border-brand-border bg-white/5 touch-pan-x touch-pan-y">
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
              className={`relative block select-none ${pointerEnabled ? 'cursor-crosshair' : 'cursor-default'}`}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerMove={onPointerMove}
              onPointerCancel={() => { pressRef.current = null; dragRef.current = null }}
            >
              <MeasurementOverlay
                pageWidth={geometry.pageWidth}
                pageHeight={geometry.pageHeight}
                cssScale={cssScale}
                onHandlePointerDown={onHandlePointerDown}
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
