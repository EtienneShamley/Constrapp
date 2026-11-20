import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

// ── The moment a print is in progress (ADR-79) ───────────────────────────────
//
// A print-only view (the GANTT™ Programme Report) is mounted only while the
// browser is printing. That is safe only if the view is IN THE DOM before the
// browser lays the page out for print, and the browser does that immediately
// after its `beforeprint` listeners return — it does not wait for a scheduled
// React render.
//
// So every state change here that must be visible to the print is wrapped in
// `flushSync` (react.dev → flushSync: "force React to flush any updates inside
// the provided callback synchronously", so the DOM is updated by the time the
// call returns). flushSync also flushes updates already pending — a filter or
// a baseline selection changed in the same event is rendered into the print
// too, never the previous value.
//
//   · `print()`       — the page's own button: mount synchronously, then
//                        window.print(). The browser then fires `beforeprint`
//                        itself, which refreshes the moment (same content).
//   · `beforeprint`   — the browser's own Print command (menu, Ctrl/Cmd+P):
//                        mount synchronously inside the event.
//   · `afterprint`    — unmount. An ordinary update: nothing is waiting on it.
//
// `printAt` is the Date the print was requested, or null when no print is in
// progress. The hook reads and writes no data of any kind.
export function usePrintMoment() {
  const [printAt, setPrintAt] = useState(null)

  useEffect(() => {
    const before = () => flushSync(() => setPrintAt(new Date()))
    const after = () => setPrintAt(null)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  const print = useCallback(() => {
    flushSync(() => setPrintAt(new Date()))
    window.print()
  }, [])

  return { printAt, print }
}
