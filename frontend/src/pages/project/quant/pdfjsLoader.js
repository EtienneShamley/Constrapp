// ── Lazy PDF.js loader (Quant 1A, ADR-51) ────────────────────────────────────
//
// pdfjs-dist is the one runtime dependency Quant adds, and nothing outside the
// Quant tab pays for it: the library and its matching worker are imported on
// first use through dynamic `import()`, so Vite emits them as separate chunks
// and every other page's bundle is unchanged.
//
// The worker is the SAME pinned build (`pdfjs-dist/build/pdf.worker.min.mjs`)
// resolved to an asset URL by Vite's `?url` suffix, so the API and worker
// versions can never disagree. `GlobalWorkerOptions.workerSrc` is set once.
//
// Browser-only by design (the `?url` import is a bundler feature). The Node
// unit suite exercises lib/pdfRender.js with the legacy build directly.

let pdfjsPromise = null

export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    }).catch((err) => {
      // Let the next attempt retry a transient chunk-load failure.
      pdfjsPromise = null
      throw err
    })
  }
  return pdfjsPromise
}
