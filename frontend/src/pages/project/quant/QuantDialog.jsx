import { useEffect, useRef } from 'react'
import { modalShellCls, modalCardCls } from './styles'
import { tabbableWithin, tabTarget } from '../../../lib/dialogFocus'

// ── The accessible dialog shell for the Quant™ dialogs (Quant 1C-A, ADR-53) ──
//
// Presentation and keyboard behaviour only — no data, no save logic. It gives
// the calibration, measurement-details and void dialogs exactly what the Quant
// 1B apply dialog already has (DESIGN_SYSTEM.md → UI Conventions → Modals):
//
//   · `role="dialog"`, `aria-modal`, an accessible name from the title
//   · initial focus: the form's own `autoFocus` field wins; otherwise the panel
//   · Escape closes — never while `busy` (a save in flight is not discarded
//     and never misreported), exactly like the disabled Cancel button
//   · Tab / Shift+Tab stay inside the panel through lib/dialogFocus.js
//   · the control that opened the dialog gets focus back when it closes
//   · the backdrop closes on click, but not while busy
//
// Errors are the caller's `role="alert"` paragraphs, unchanged.

export default function QuantDialog({ title, titleId, onClose, busy = false, panelClassName = 'max-w-[520px]', children }) {
  const panelRef = useRef(null)

  useEffect(() => {
    const opener = document.activeElement
    const panel = panelRef.current
    // A form field with autoFocus already took focus during mount; only an
    // empty panel takes it itself.
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
    <div className={modalShellCls} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60" onClick={busy ? undefined : onClose} />
      <div ref={panelRef} tabIndex={-1} className={`${modalCardCls} ${panelClassName} outline-none focus-visible:ring-2 focus-visible:ring-brand-accent`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 id={titleId} className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
