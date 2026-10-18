import { useState } from 'react'
import Badge from '../../../components/Badge'
import { formatIsoDate } from '../../../lib/projectTimeline'
import {
  ATTENTION, ATTENTION_REASON, ACK_NOTE_MAX_LENGTH, EVIDENCE_KEY_LIMIT,
  ackWording, acknowledgementAvailability, validateAcknowledgementInput,
  timestampToIso, localDayIso,
} from '../../../lib/pulseAttention'

// ── PULSE · the acknowledgement panel on one indicator card (ADR-49) ─────────
//
// PRESENTATION of a lib/pulseAttention.js attention result plus the one form
// the workflow needs. It never decides attention itself, never changes the
// indicator above it, and never hides it: the finding, its figures and its
// evidence stay exactly as PULSE 1A renders them. The two write callbacks come
// from usePulseAcknowledgements via the page; the panel only calls them and
// shows their outcome AFTER the server has confirmed (a resolved promise).
//
// Who is shown as "You" / "Another user" — users/{uid} is client-read-only
// (ADR-27), so no other user's name can be resolved.

const who = (uid, currentUid) => (uid ? (uid === currentUid ? 'You' : 'Another user') : '—')
const onDay = (ts) => {
  const iso = timestampToIso(ts)
  return iso ? formatIsoDate(iso) : 'saving…'
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const fieldLabel = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5'
const fieldInput = 'w-full min-h-[44px] rounded-lg border border-brand-border bg-brand-bg px-3 py-2 text-[13px] text-brand-text focus:outline-none focus:border-brand-accent'
const ghostBtn  = 'inline-flex items-center rounded-lg border border-brand-border px-3 text-[12px] font-semibold text-brand-text hover:bg-brand-card disabled:opacity-50 disabled:cursor-not-allowed'
const primaryBtn = 'inline-flex items-center rounded-lg bg-brand-accent/10 border border-brand-accent/25 px-3 text-[12px] font-semibold text-brand-accent hover:bg-brand-accent/20 disabled:opacity-50 disabled:cursor-not-allowed'

// The acknowledgement line: who, when, review-by — the recorded date and the
// required review date are always shown together, because an acknowledgement
// speaks for the records as they stood on its date, not for today's values.
function AckLine({ ack, currentUid, past }) {
  return (
    <p className="m-0 text-[12.5px] text-brand-text">
      <span className="font-semibold">{past} by {who(ack.acknowledgedBy, currentUid)}</span>
      {' '}on {onDay(ack.acknowledgedAt)} · review by {formatIsoDate(ack.reviewBy)}
    </p>
  )
}

function AckNote({ note }) {
  // Rules require a string; a malformed stored value is simply not rendered.
  if (typeof note !== 'string' || note.trim().length === 0) return null
  return <p className="m-0 mt-1 whitespace-pre-wrap text-[12.5px] text-brand-text-soft">{note}</p>
}

function AckForm({ indicator, wording, now, onSubmit, onCancel }) {
  const [note, setNote] = useState('')
  const [reviewBy, setReviewBy] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const noteId = `ack-note-${indicator.id}`
  const dateId = `ack-review-${indicator.id}`
  const errId  = `ack-error-${indicator.id}`
  const today = localDayIso(now)

  const submit = async (e) => {
    e.preventDefault()
    const validationError = validateAcknowledgementInput({ note, reviewBy }, now)
    if (validationError) { setError(validationError); return }
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ note, reviewBy })
      // Success is the server's commit; the live subscription re-renders the
      // card and this form unmounts with it.
    } catch (err) {
      setError(err?.message || 'The acknowledgement could not be saved. Nothing was changed.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mt-3 rounded-lg border border-brand-border bg-brand-bg/60 p-3">
      <p className="m-0 mb-2.5 text-[12px] text-brand-text-soft">
        Record that this finding has been seen and what is being done. This does not resolve it: the
        finding stays until the records change, and it returns to <em>Needs attention</em> when new source
        records appear or the review-by date arrives.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
        <div>
          <label className={fieldLabel} htmlFor={noteId}>Note (required)</label>
          <textarea
            id={noteId}
            className={`${fieldInput} min-h-[88px]`}
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={ACK_NOTE_MAX_LENGTH}
            rows={3}
            required
            aria-describedby={error ? errId : undefined}
            disabled={busy}
          />
          <p className="m-0 mt-1 text-[11px] text-brand-muted">{note.trim().length} / {ACK_NOTE_MAX_LENGTH}</p>
        </div>
        <div>
          <label className={fieldLabel} htmlFor={dateId}>Review by (required)</label>
          <input
            id={dateId}
            type="date"
            className={fieldInput}
            value={reviewBy}
            min={today}
            onChange={e => setReviewBy(e.target.value)}
            required
            aria-describedby={error ? errId : undefined}
            disabled={busy}
          />
          <p className="m-0 mt-1 text-[11px] text-brand-muted">Must be after today.</p>
        </div>
      </div>
      {error && (
        <p id={errId} role="alert" className="m-0 mt-2 text-[12px] font-semibold text-brand-red">{error}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className={`${primaryBtn} min-h-[44px]`} disabled={busy}>
          {busy ? 'Saving…' : wording.save}
        </button>
        <button type="button" className={`${ghostBtn} min-h-[44px]`} onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  )
}

function WithdrawButton({ onWithdraw, onError }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    onError(null)
    try {
      await onWithdraw()
    } catch (err) {
      onError(err?.message || 'The acknowledgement could not be withdrawn. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className={`${ghostBtn} min-h-[44px]`} onClick={run} disabled={busy}>
      {busy ? 'Withdrawing…' : 'Withdraw'}
    </button>
  )
}

export default function AcknowledgementPanel({ indicator, attention, canManage, currentUid, now, onAcknowledge, onWithdraw }) {
  const [formOpen, setFormOpen] = useState(false)
  const [actionError, setActionError] = useState(null)
  if (!attention || attention.state === ATTENTION.NOT_APPLICABLE) return null

  const wording = ackWording(indicator.id)
  const ack = attention.ack

  let body
  switch (attention.state) {
    case ATTENTION.LOADING:
      body = <p className="m-0 text-[12.5px] text-brand-muted">Loading {wording.noun} status…</p>
      break

    case ATTENTION.UNKNOWN:
      body = (
        <p className="m-0 text-[12.5px] text-brand-amber">
          {wording.past === 'Reviewed' ? 'Review' : 'Acknowledgement'} status unknown — this project&apos;s
          acknowledgements could not be loaded. This does not mean nobody has acknowledged the finding, and the
          finding above is unaffected.
        </p>
      )
      break

    case ATTENTION.NO_LONGER_PRESENT:
      body = (
        <>
          <p className="m-0 text-[12.5px] font-semibold text-brand-text">Condition no longer present</p>
          <p className="m-0 mt-0.5 text-[12px] text-brand-text-soft">
            The records no longer support this finding, so the {wording.noun} below no longer applies. No
            resolution date is recorded — PULSE keeps no history.
          </p>
          <div className="mt-2"><AckLine ack={ack} currentUid={currentUid} past={wording.past} /><AckNote note={ack.note} /></div>
          {canManage && (
            <div className="mt-2 flex flex-wrap gap-2">
              <WithdrawButton onWithdraw={() => onWithdraw(ack)} onError={setActionError} />
            </div>
          )}
        </>
      )
      break

    case ATTENTION.ACKNOWLEDGED:
      body = (
        <>
          <AckLine ack={ack} currentUid={currentUid} past={wording.past} />
          <AckNote note={ack.note} />
          <p className="m-0 mt-1 text-[11.5px] text-brand-muted">
            Covers {plural(attention.currentKeys.length, 'source record', 'source records')} as they stood on that date —
            amounts may have changed since; the current figures are shown above. No new source records since.
            {attention.clearedKeys.length > 0 && ` ${plural(attention.clearedKeys.length, 'acknowledged record is', 'acknowledged records are')} no longer present.`}
          </p>
          {canManage && (
            <div className="mt-2 flex flex-wrap gap-2">
              <WithdrawButton onWithdraw={() => onWithdraw(ack)} onError={setActionError} />
            </div>
          )}
        </>
      )
      break

    case ATTENTION.NEEDS_ATTENTION: {
      const availability = acknowledgementAvailability(indicator)
      const reasonText = {
        [ATTENTION_REASON.NONE]:         `No ${wording.noun} recorded.`,
        [ATTENTION_REASON.NEW_EVIDENCE]: ack
          ? `${plural(attention.newKeys.length, 'new source record', 'new source records')} since the ${wording.noun} by ${who(ack.acknowledgedBy, currentUid)} on ${onDay(ack.acknowledgedAt)}.`
          : '',
        [ATTENTION_REASON.REVIEW_DUE]:   ack
          ? `Review date ${formatIsoDate(ack.reviewBy)} has arrived — ${wording.past.toLowerCase()} by ${who(ack.acknowledgedBy, currentUid)} on ${onDay(ack.acknowledgedAt)}.`
          : '',
        [ATTENTION_REASON.WITHDRAWN]:    ack
          ? `${wording.past === 'Reviewed' ? 'Review' : 'Acknowledgement'} withdrawn by ${who(ack.withdrawnBy, currentUid)} on ${onDay(ack.withdrawnAt)}.`
          : '',
      }[attention.reason] ?? ''
      body = (
        <>
          <p className="m-0 text-[12.5px] text-brand-text">{reasonText}</p>
          {ack && attention.reason !== ATTENTION_REASON.NONE && <AckNote note={ack.note} />}
          {!canManage && (
            <p className="m-0 mt-1 text-[11.5px] text-brand-muted">
              A Company Admin or Project Manager can {wording.verb.toLowerCase()} this finding.
            </p>
          )}
          {canManage && !availability.ok && availability.reason === 'too_many_evidence' && (
            <p className="m-0 mt-1 text-[12px] text-brand-amber">
              {wording.verb} is unavailable: this finding rests on {availability.keyCount} source records, more
              than the {EVIDENCE_KEY_LIMIT} one {wording.noun} can reference. Nothing is truncated — work the
              finding down through its workflow first.
            </p>
          )}
          {canManage && availability.ok && !formOpen && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={`${primaryBtn} min-h-[44px]`} onClick={() => { setActionError(null); setFormOpen(true) }}>
                {wording.verb}
              </button>
            </div>
          )}
          {canManage && availability.ok && formOpen && (
            <AckForm
              indicator={indicator}
              wording={wording}
              now={now}
              onSubmit={(input) => onAcknowledge(indicator, ack, input)}
              onCancel={() => setFormOpen(false)}
            />
          )}
        </>
      )
      break
    }
    default:
      body = null
  }

  const badge = {
    [ATTENTION.NEEDS_ATTENTION]:   { label: 'Needs attention', variant: 'pending' },
    [ATTENTION.ACKNOWLEDGED]:      { label: wording.past,       variant: 'info' },
    [ATTENTION.NO_LONGER_PRESENT]: { label: 'No longer present', variant: 'soon' },
    [ATTENTION.UNKNOWN]:           { label: 'Status unknown',   variant: 'pending' },
    [ATTENTION.LOADING]:           { label: 'Loading',          variant: 'soon' },
  }[attention.state]

  return (
    <div className="mt-3 border-t border-brand-border pt-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <p className="m-0 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">Management</p>
        {badge && <Badge label={badge.label} variant={badge.variant} sm />}
      </div>
      {body}
      {/* Outcome of a withdraw — in the DOM so it is announced. */}
      <div aria-live="polite" role="status">
        {actionError && <p className="m-0 mt-2 text-[12px] font-semibold text-brand-red">{actionError}</p>}
      </div>
    </div>
  )
}
