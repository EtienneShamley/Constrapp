import { useSyncExternalStore } from 'react'
import { TRACKED_STATUS, writeTracker } from '../lib/writeOutcome'

// Page-level notice for writes whose dialog was closed before the server
// answered (lib/writeOutcome.js). Mounted once in the app shell. It reports
// the eventual outcome, so a late success is never silent and a write still in
// flight keeps warning against entering the record again.
const TEXT = {
  [TRACKED_STATUS.PENDING]:
    'has not been confirmed by the server yet. It may still be saved — do not enter it again. Keep this tab open.',
  [TRACKED_STATUS.CONFIRMED]: 'was saved. The server has now confirmed it.',
  [TRACKED_STATUS.FAILED]:    'was not saved.',
  [TRACKED_STATUS.UNCERTAIN]: 'could not be confirmed by the server: it may or may not have been saved. Check the list before entering it again.',
}

const TONE = {
  [TRACKED_STATUS.PENDING]:   'border-brand-amber/40 text-brand-amber',
  [TRACKED_STATUS.CONFIRMED]: 'border-brand-accent/40 text-brand-accent',
  [TRACKED_STATUS.FAILED]:    'border-brand-red/40 text-brand-red',
  [TRACKED_STATUS.UNCERTAIN]: 'border-brand-amber/40 text-brand-amber',
}

export default function UnconfirmedWrites({ tracker = writeTracker }) {
  const entries = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot)
  if (entries.length === 0) return null
  return (
    <div data-print-hide data-unconfirmed-writes className="flex flex-col gap-2 mb-4" role="status" aria-live="polite">
      {entries.map((e) => (
        <div key={e.id} className={`flex items-start justify-between gap-3 rounded-lg border bg-brand-card px-3 py-2 text-[12.5px] ${TONE[e.status]}`}>
          <p className="m-0">
            <span className="font-semibold">{e.label}</span>{' '}
            {TEXT[e.status]}
            {e.status === TRACKED_STATUS.FAILED && e.message ? ` ${e.message}` : ''}
          </p>
          {e.status !== TRACKED_STATUS.PENDING && (
            <button
              type="button"
              onClick={() => tracker.dismiss(e.id)}
              className="text-[11.5px] font-semibold text-brand-muted hover:text-brand-text cursor-pointer bg-transparent border-0 p-0 shrink-0"
            >
              {e.status === TRACKED_STATUS.UNCERTAIN ? 'I have checked the list' : 'Dismiss'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
