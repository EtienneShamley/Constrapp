import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls, modalShellCls, modalCardCls } from './styles'
import {
  DISCIPLINES, formatDiscipline,
  findDuplicateDrawingNumber, normaliseDrawingNumber, validateDrawingDraft,
} from '../../../lib/drawings'

// Creates or edits a DRAWING MASTER — its identity only. Files are never
// touched here: a new file is a new revision, issued from the drawing detail.
//
// A created master is deliberately EMPTY. The caller sends the user straight to
// the drawing, where the first revision is uploaded; until that upload succeeds
// the drawing honestly shows "No current revision".
export default function DrawingEditorModal({ drawing, drawings, onClose, onSave }) {
  const editing = Boolean(drawing)

  const [drawingNumber, setDrawingNumber] = useState(drawing?.drawingNumber ?? '')
  const [title, setTitle]                 = useState(drawing?.title ?? '')
  const [discipline, setDiscipline]       = useState(drawing?.discipline ?? 'architectural')
  const [description, setDescription]     = useState(drawing?.description ?? '')
  const [saving, setSaving]               = useState(false)
  const [error, setError]                 = useState(null)

  // ⚠️ WARNING ONLY, NEVER A BLOCK. Firestore rules cannot query siblings, so
  // drawing-number uniqueness is not — and cannot be — enforced. Re-numbering a
  // sheet is also legitimate, so the register warns and lets the user decide.
  const duplicate = findDuplicateDrawingNumber(drawings, drawingNumber, drawing?.id ?? null)

  async function handleSubmit(e) {
    e.preventDefault()
    const validationError = validateDrawingDraft({ drawingNumber, title, discipline })
    if (validationError) { setError(validationError); return }

    setSaving(true)
    setError(null)
    try {
      await onSave({ drawingNumber, title, discipline, description })
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  return (
    <div className={modalShellCls}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`${modalCardCls} max-w-[520px]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-border">
          <h2 className="text-[15px] font-bold text-brand-text m-0">
            {editing ? 'Edit Drawing' : 'New Drawing'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-brand-muted hover:text-brand-text text-xl leading-none cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 flex flex-col gap-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Drawing Number <span className="text-brand-red">*</span></label>
              <input
                className={inputCls}
                placeholder="e.g. A-101"
                value={drawingNumber}
                onChange={e => setDrawingNumber(e.target.value)}
                required
                autoFocus
              />
              <p className="text-[11px] text-brand-muted mt-1">
                Stored as {normaliseDrawingNumber(drawingNumber) || '—'}
              </p>
            </div>
            <div>
              <label className={labelCls}>Discipline <span className="text-brand-red">*</span></label>
              <select className={inputCls} value={discipline} onChange={e => setDiscipline(e.target.value)}>
                {DISCIPLINES.map(d => (
                  <option key={d} value={d}>{formatDiscipline(d)}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Title <span className="text-brand-red">*</span></label>
            <input
              className={inputCls}
              placeholder="e.g. Ground Floor Plan"
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
            />
          </div>

          <div>
            <label className={labelCls}>Description</label>
            <textarea
              className={inputCls}
              rows={2}
              placeholder="Optional notes about this sheet"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          {duplicate && (
            <p className="text-[12px] text-brand-amber m-0">
              ⚠ Drawing {duplicate.drawingNumber} already exists ({duplicate.title}). Numbers are not
              checked for uniqueness — continue only if this is intentional.
            </p>
          )}

          {!editing && (
            <p className="text-[12px] text-brand-muted m-0">
              The drawing is created without a revision. You will upload Revision A next; until that
              upload succeeds the drawing shows no current revision.
            </p>
          )}

          {error && <p className="text-[12px] text-brand-red m-0">{error}</p>}

          <div className="flex justify-end gap-2 pt-1 border-t border-brand-border">
            <Btn variant="ghost" type="button" onClick={onClose} sm disabled={saving}>Cancel</Btn>
            <Btn type="submit" sm disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Drawing'}
            </Btn>
          </div>
        </form>
      </div>
    </div>
  )
}
