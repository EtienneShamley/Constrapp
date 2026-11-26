import { useId } from 'react'

// The dialog shell shared by the Client Credit Note and Client Retention
// Release dialogs — the DESIGN_SYSTEM modal contract (overlay, centred panel,
// title row with a 44px close button), announced as a dialog.
export default function ReceivableDialog({ title, onClose, children, wide = false }) {
  const titleId = useId()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative z-10 w-full ${wide ? 'max-w-[900px]' : 'max-w-[560px]'} max-h-[90vh] overflow-y-auto bg-brand-surface border border-brand-border rounded-xl shadow-2xl`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 id={titleId} className="text-[15px] font-bold text-brand-text m-0">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
