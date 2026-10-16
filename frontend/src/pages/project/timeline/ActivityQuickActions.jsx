import Btn from '../../../components/Btn'
import { quickActionsFor } from '../../../lib/projectTimeline'

// ── Quick status buttons — shared by the table (desktop) and cards (mobile) ──
//
// Offers ONLY the transitions planQuickAction would accept for this activity as
// loaded (lib/projectTimeline.js → quickActionsFor), so the table and the cards
// can never disagree about what is possible. The write itself re-plans against
// the server copy inside a guarded transaction.
//
// ⚠️ Rendered by the parent only when `canWrite` (company_admin /
// project_manager). That is UX only — the `activities` rules block is the
// boundary, and QS remains read-only there.
//
// An action that needs a date the click cannot supply (e.g. completing work
// with no recorded actual start) is simply not offered; Edit remains the path.

export default function ActivityQuickActions({ activity, now, onQuickAction, busyId, compact = false }) {
  const actions = quickActionsFor(activity, now)
  if (actions.length === 0) return null
  const busy = busyId === activity.id
  const anyBusy = busyId !== null && busyId !== undefined

  return (
    <>
      {actions.map(({ action, label }) => (
        <Btn
          key={action}
          sm={compact}
          variant="success"
          className={compact ? '' : 'flex-1'}
          disabled={anyBusy}
          aria-label={`${label}: ${activity.name}`}
          onClick={() => onQuickAction(activity, action)}
        >
          {busy ? 'Saving…' : label}
        </Btn>
      ))}
    </>
  )
}
