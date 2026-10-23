import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls } from './styles'
import {
  CALIBRATION_UNITS, CALIBRATION_UNIT_CODES, buildCalibration, distance,
  impliedDrawingScale, metresPerPageUnit, validateCalibrationDraft,
} from '../../../lib/quant'
import { formatQuantity } from '../../../lib/boq'
import QuantDialog from './QuantDialog'

// ── Calibrate a page from one known distance ─────────────────────────────────
//
// The two points are already picked on the sheet. The user enters the real
// distance between them and its unit, reviews what the calibration implies,
// and saves. When the page is ALREADY calibrated and carries length/area
// measurements, saving requires an explicit acknowledgement: every one of
// those measurements will be flagged "needs review" (its stored quantity
// snapshot stays as the record of what it measured before). Nothing is ever
// silently re-scaled. Dialog semantics, Escape (not while saving), focus
// containment and focus return come from QuantDialog (ADR-53).

export default function CalibrationModal({
  pointA, pointB, source, existingCalibration, affectedCount, onSave, onClose,
}) {
  const [realDistance, setRealDistance] = useState('')
  const [unit, setUnit] = useState(existingCalibration?.unit ?? 'mm')
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const pageDistance = distance(pointA, pointB)
  const draft = { pointA, pointB, realDistance, unit }
  const validationError = validateCalibrationDraft(draft)
  const preview = validationError ? null : buildCalibration(draft)
  const replacing = !!existingCalibration
  const needsAck = replacing && affectedCount > 0

  async function submit(e) {
    e.preventDefault()
    if (validationError) { setError(validationError); return }
    if (needsAck && !acknowledged) { setError('Confirm that the existing measurements will be flagged for review.'); return }
    setSaving(true); setError(null)
    try {
      await onSave(draft)
      onClose()
    } catch (err) {
      setError(err?.message || 'The calibration could not be saved. Nothing was saved.')
      setSaving(false)
    }
  }

  return (
    <QuantDialog
      title={replacing ? 'Re-calibrate this page' : 'Calibrate this page'}
      titleId="quant-calibration-title"
      onClose={onClose}
      busy={saving}
    >
      <form onSubmit={submit} className="p-5">
        <p className="m-0 text-[12.5px] text-brand-text">
          The two points you picked are <span className="font-semibold">{formatQuantity(pageDistance)}</span> page units apart.
          Enter the real distance between them.
        </p>

        <div className="mt-4 grid grid-cols-[1fr_120px] gap-3">
          <div>
            <label className={labelCls} htmlFor="quant-cal-distance">Known distance *</label>
            <input
              id="quant-cal-distance"
              className={inputCls}
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              placeholder="e.g. 3600"
              value={realDistance}
              onChange={e => setRealDistance(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="quant-cal-unit">Unit *</label>
            <select id="quant-cal-unit" className={inputCls} value={unit} onChange={e => setUnit(e.target.value)}>
              {CALIBRATION_UNIT_CODES.map(code => (
                <option key={code} value={code}>{CALIBRATION_UNITS[code].label}</option>
              ))}
            </select>
          </div>
        </div>

        <dl className="m-0 mt-4 grid grid-cols-2 gap-3 rounded-lg bg-brand-bg/60 px-3 py-2.5">
          <div>
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Metres per page unit</dt>
            <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">
              {preview ? metresPerPageUnit(preview).toPrecision(6) : '—'}
            </dd>
          </div>
          <div>
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Implied drawing scale</dt>
            <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">
              {preview ? (impliedDrawingScale(preview, source) ?? 'n/a for images') : '—'}
            </dd>
          </div>
        </dl>
        <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
          Check the implied scale against the title block before saving. Every length and area on this page
          is computed from this one ratio — a wrong distance here makes every quantity wrong.
        </p>

        {needsAck && (
          <label className="mt-4 flex items-start gap-2.5 rounded-lg border-2 border-brand-amber bg-brand-amber/10 px-3 py-3 text-[12.5px] text-brand-text cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 shrink-0"
              checked={acknowledged}
              onChange={e => setAcknowledged(e.target.checked)}
            />
            <span>
              This page already has <span className="font-bold">{affectedCount}</span> length or area
              measurement{affectedCount === 1 ? '' : 's'}. Replacing the calibration flags each one{' '}
              <span className="font-bold">Needs review</span>; its recorded quantity under the previous scale stays
              visible until you review it. Nothing is re-scaled silently.
            </span>
          </label>
        )}

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving || !!validationError}>{saving ? 'Saving…' : replacing ? 'Replace calibration' : 'Save calibration'}</Btn>
        </div>
      </form>
    </QuantDialog>
  )
}
