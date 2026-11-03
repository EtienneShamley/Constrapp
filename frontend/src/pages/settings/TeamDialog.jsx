import { useEffect, useRef } from 'react'
import { tabbableWithin, tabTarget } from '../../lib/dialogFocus'

// ── The accessible dialog shell for the Team page (ADR-72) ───────────────────
//
// The QuantDialog contract (DESIGN_SYSTEM.md → UI Conventions → Modals):
//   · role="dialog", aria-modal, an accessible name from the title
//   · initial focus: an autoFocus field wins, otherwise the panel
//   · Escape closes — never while `busy`
//   · Tab / Shift+Tab stay inside the panel (lib/dialogFocus.js)
//   · the opener gets focus back on close; the backdrop closes unless busy

const shellCls = 'fixed inset-0 z-50 flex items-center justify-center p-4'
const cardCls  = 'relative z-10 w-full bg-brand-surface border border-brand-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto'

export default function TeamDialog({ title, titleId, onClose, busy = false, panelClassName = 'max-w-[480px]', children }) {
  const panelRef = useRef(null)

  useEffect(() => {
    const opener = document.activeElement
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
    return () => { if (opener && typeof opener.focus === 'function') opener.focus() }
  }, [])

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (busy) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const target = tabTarget({
      shiftKey: e.shiftKey,
      active: document.activeElement,
      tabbable: tabbableWithin(panel),
      fallback: panel,
    })
    if (target) { e.preventDefault(); target.focus() }
  }

  return (
    <div className={shellCls} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" onClick={busy ? undefined : onClose} />
      <div ref={panelRef} tabIndex={-1} className={`${cardCls} ${panelClassName} outline-none focus-visible:ring-2 focus-visible:ring-brand-accent`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 id={titleId} className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="min-w-[44px] min-h-[44px] -mr-3 flex items-center justify-center text-brand-muted hover:text-brand-text disabled:opacity-50 rounded-lg focus-visible:outline-2 focus-visible:outline-brand-accent"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
