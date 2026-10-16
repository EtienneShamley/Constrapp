import { useEffect, useState } from 'react'
import { msUntilNextLocalDay, isDifferentLocalDay } from '../lib/projectTimeline'

// ── The viewer's current calendar day, kept fresh across midnight ────────────
//
// Returns a `Date` that changes ONLY when the viewer's local calendar day
// changes. Screens derive every date-relative figure (overdue, due soon, the
// look-ahead groups, the Gantt's today line) from ONE value per render, so a
// stable-within-the-day object keeps their memos stable too.
//
// Why it exists: the Timeline captured `new Date()` once at mount, so a tab
// left open past midnight kept showing yesterday's overdue state. This hook:
//   · schedules a timer for the next LOCAL midnight (lib/projectTimeline.js →
//     msUntilNextLocalDay, DST-safe), then re-arms itself; and
//   · re-checks on `visibilitychange` and window `focus`, because browsers
//     throttle or suspend timers in background tabs and sleeping laptops.
//
// Not a Firestore subscription — no listener, no read. State is written only
// from the timer and event callbacks, never synchronously in the effect body.
// Dates stay date-only 'YYYY-MM-DD' strings in storage; this only decides
// which day "today" is, in the viewer's timezone (the documented convention).
export function useLocalToday() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer = null

    const refresh = () => {
      const fresh = new Date()
      setNow(prev => (isDifferentLocalDay(prev, fresh) ? fresh : prev))
    }
    const schedule = () => {
      timer = setTimeout(() => { refresh(); schedule() }, msUntilNextLocalDay(new Date()))
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return now
}
