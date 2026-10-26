import { useState } from 'react'
import Btn from '../../../components/Btn'
import { inputCls, labelCls } from './styles'
import {
  MEASUREMENT_KIND, LABEL_MAX, measurementQuantity, formatMeasurementQuantity, quantityBreakdown, quantityIssue,
  measurementDeductions, withDeduction, validateDeductionLabel,
} from '../../../lib/quant'
import QuantDialog from './QuantDialog'

// ── Name a deduction — a new one just traced, or an existing one renamed ─────
//
// Quant 1D (ADR-54). The ONLY input is the label: the geometry was traced on
// the sheet and is previewed here, never typed. Gross, deductions and the
// resulting net are lib/quant.js → measurementQuantity over the parent WITH
// the candidate hole in place — exactly what the list will show once saved —
// so what the user confirms is what will derive. Saving is the parent's
// revision-guarded update (lib/quantActions.js → runUpdateMeasurement with
// the complete deductions list); nothing here touches a BOQ item, a cost code
// or a calibration. Dialog semantics, Escape (not while saving), focus
// containment and focus return come from QuantDialog (ADR-53).
//
// `deduction` set → rename (points come from the stored hole);
// otherwise `points` is the freshly traced outline.

const DRAFT_ID = '__draft__'

export default function DeductionDialog({ parent, deduction = null, points = null, calibration, onSave, onClose }) {
  const renaming = !!deduction
  const [label, setLabel] = useState(deduction?.label ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const holePoints = renaming ? deduction.points : points
  const candidate = { id: deduction?.id ?? DRAFT_ID, label: label || 'deduction', points: holePoints }
  const preview = measurementQuantity(
    { ...parent, deductions: withDeduction(measurementDeductions(parent), candidate) },
    calibration,
  )
  const breakdown = quantityBreakdown(preview)
  const issue = quantityIssue(preview)
  const thisHole = formatMeasurementQuantity(measurementQuantity({ kind: MEASUREMENT_KIND.AREA, points: holePoints }, calibration))

  async function submit(e) {
    e.preventDefault()
    const labelError = validateDeductionLabel(label)
    if (labelError) { setError(labelError); return }
    setSaving(true); setError(null)
    try {
      await onSave({ label: label.trim() })
      onClose()
    } catch (err) {
      setError(err?.message || 'The deduction could not be saved. Nothing was saved.')
      setSaving(false)
    }
  }

  return (
    <QuantDialog
      title={renaming ? 'Rename deduction' : 'Save deduction'}
      titleId="quant-deduction-title"
      onClose={onClose}
      busy={saving}
    >
      <form onSubmit={submit} className="p-5">
        <p className="m-0 text-[12.5px] text-brand-text">
          Deducted from <span className="font-semibold">{parent?.label}</span> · {parent?.costCodeName}
        </p>
        <dl className="m-0 mt-3 grid grid-cols-2 gap-3 rounded-lg bg-brand-bg/60 px-3 py-2.5 sm:grid-cols-4">
          <div>
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Gross</dt>
            <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{breakdown?.gross ?? '—'}</dd>
          </div>
          <div>
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">This deduction</dt>
            <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{thisHole}</dd>
          </div>
          <div>
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">All deductions</dt>
            <dd className="m-0 mt-0.5 text-[13px] font-semibold tabular-nums text-brand-text">{breakdown ? `${breakdown.deducted} · ${breakdown.count}` : '—'}</dd>
          </div>
          <div>
            <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">Net</dt>
            <dd className="m-0 mt-0.5 text-[13px] font-bold tabular-nums text-brand-text">{breakdown?.net ?? '—'}</dd>
          </div>
        </dl>
        {issue && <p className="m-0 mt-2 text-[11.5px] text-brand-red" role="alert">{issue}</p>}

        <label className={`${labelCls} mt-4`} htmlFor="quant-deduction-label">Deduction label *</label>
        <input
          id="quant-deduction-label"
          className={inputCls}
          placeholder="e.g. Door D01 opening"
          maxLength={LABEL_MAX}
          value={label}
          onChange={e => setLabel(e.target.value)}
          autoFocus
        />
        <p className="m-0 mt-1.5 text-[11.5px] text-brand-muted">
          A deduction is part of this area&apos;s geometry: it shares the area&apos;s cost code, calibration and BOQ link, is
          never listed or summed on its own, and changes no BOQ quantity by itself — applying the net total is still the
          explicit step on the BOQ tab.
        </p>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red" role="alert">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn type="submit" disabled={saving || (!renaming && !!issue)}>{saving ? 'Saving…' : renaming ? 'Save name' : 'Save deduction'}</Btn>
        </div>
      </form>
    </QuantDialog>
  )
}
