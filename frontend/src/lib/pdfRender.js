import { PAGE_ROTATIONS, PAGE_SOURCE, boundedRenderScale, RENDER_LIMITS } from './quant'

// ── PDF.js adapter (Quant 1A, ADR-51) ────────────────────────────────────────
//
// The ONLY file that talks to pdfjs-dist. It never imports the library
// itself: the caller passes the loaded module in (`pdfjs`), so the browser
// passes the lazily imported `pdfjs-dist` with its worker configured, and the
// Node unit suite passes `pdfjs-dist/legacy/build/pdf.mjs` and proves the
// same functions against a local fixture with no canvas at all.
//
// THE CANONICAL PAGE SPACE IS `page.getViewport({ scale: 1 })`: PDF.js applies
// the page's /Rotate and its CropBox offset in that transform, so the
// canonical origin is the top-left of the sheet AS IT IS MEANT TO BE SEEN,
// y runs down, and one unit is one PDF point. Rendering at any other scale is
// that same viewport multiplied by one number — which is why a stored point
// never depends on zoom, device pixel ratio or the canvas backing store.

// Opens a PDF from bytes. Returns a handle whose `destroy()` releases the
// worker-side document. `data` is copied by PDF.js (it transfers the buffer),
// so a caller must not reuse the ArrayBuffer afterwards.
export async function openPdf(pdfjs, data, options = {}) {
  const task = pdfjs.getDocument({ data, ...options })
  const doc = await task.promise
  return {
    numPages: doc.numPages,
    getPage: (n) => doc.getPage(n),
    destroy: () => task.destroy(),
  }
}

// The canonical geometry of one page — what takeoffPages persists.
export function pageGeometry(page) {
  const viewport = page.getViewport({ scale: 1 })
  const rotation = ((page.rotate % 360) + 360) % 360
  return {
    source: PAGE_SOURCE.PDF,
    pageWidth:  viewport.width,
    pageHeight: viewport.height,
    pageRotation: PAGE_ROTATIONS.includes(rotation) ? rotation : 0,
  }
}

// A canonical point (scale-1 viewport space) → the same point in the
// viewport rendered at `scale`. Pure multiplication, stated once.
export const canonicalToRendered = (point, scale) => ({ x: point.x * scale, y: point.y * scale })
export const renderedToCanonical = (point, scale) => ({ x: point.x / scale, y: point.y / scale })

// The PDF user-space coordinates of a canonical point (for anyone who needs to
// relate a measurement to the PDF's own coordinate system — never stored).
export function canonicalToPdfUserSpace(page, point) {
  const viewport = page.getViewport({ scale: 1 })
  const [x, y] = viewport.convertToPdfPoint(point.x, point.y)
  return { x, y }
}

// Renders `page` into `canvas` at a canonical→device scale bounded by the
// backing-store limits. `cssScale` is CSS pixels per canonical unit (the fit
// factor × zoom); `devicePixelRatio` sharpens on high-density screens up to
// the bound. Only the BACKING STORE is sized here: the canvas's CSS box is
// owned by the layout (it fills the overlay's box, which is cssScale ×
// canonical), so the overlay stays aligned even when the backing store was
// capped — the browser simply scales the bitmap into the box.
//
// Returns { task, renderScale }; `task.promise` resolves when the page is
// drawn and `task.cancel()` abandons an in-flight render (a cancelled render
// rejects with a RenderingCancelledException, which callers ignore).
export function renderPage(page, canvas, { cssScale, devicePixelRatio = 1, limits = RENDER_LIMITS.desktop }) {
  const base = page.getViewport({ scale: 1 })
  const renderScale = boundedRenderScale(base.width, base.height, cssScale * devicePixelRatio, limits)
  const viewport = page.getViewport({ scale: renderScale })

  canvas.width  = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))

  const task = page.render({ canvas, viewport })
  return { task, renderScale }
}

export const isRenderCancelled = (err) =>
  err?.name === 'RenderingCancelledException'
