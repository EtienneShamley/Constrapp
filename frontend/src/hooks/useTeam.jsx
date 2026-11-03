import { useCallback, useMemo } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'

// ── Team management callables (ADR-72) ───────────────────────────────────────
//
// The ONLY place the app talks to the trusted backend. Eight callables, each a
// thin `httpsCallable` that unwraps `.data`. No Firestore access here: the
// backend reads and writes `users/{uid}`, `members`, `invitations` and the
// audit log with the Admin SDK, behind its own authorisation; the browser
// still cannot write `users/{uid}` (ADR-27) and cannot read the new
// collections at all (no rules block).
//
// Not a subscription hook — nothing here listens. The Team page refreshes by
// calling listTeam again after every action.

const NAMES = [
  'listTeam', 'createInvitation', 'resendInvitation', 'revokeInvitation',
  'previewInvitation', 'acceptInvitation', 'changeMemberRole', 'deactivateMember',
]

export function useTeam() {
  const call = useCallback(async (name, data = {}) => {
    const res = await httpsCallable(functions, name)(data)
    return res.data
  }, [])

  return useMemo(() => Object.fromEntries(NAMES.map(n => [n, (data) => call(n, data)])), [call])
}
