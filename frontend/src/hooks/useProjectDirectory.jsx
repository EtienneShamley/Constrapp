import { useCallback, useEffect, useMemo, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { EMPTY_DIRECTORY_SNAPSHOT, foldDirectoryReport } from '../lib/projects'

// ── Assigned project directory (M2-A2) ───────────────────────────────────────
//
// The projects of a client / subcontractor: ONE document listener per assigned
// project on companies/{c}/projectDirectory/{projectId} — the external-safe
// entry holding name, status, location, startDate and progress, and nothing
// else. Consumed only by ProjectsProvider, which hands the result out as
// `projects`, so every page and useProject work unchanged.
//
// WHY PER-DOCUMENT READS, NOT A QUERY. Rules are not filters: a collection
// query is refused unless EVERY document it could return is readable, and an
// external role may read only its assigned entries — so listing the directory
// is denied to it outright (internal roles only). A `get` of one assigned
// entry is what the rules can prove.
//
// ⚠️ `projectIds` comes from the caller's own profile, which they cannot write
// (users/{uid} is client-read-only). It selects which listeners to open; the
// RULES decide whether each one is answered. An id that is not assigned is
// refused by the server whatever is passed here.
//
// Keyed-snapshot pattern (ADR-41). The key is set only when every listener has
// reported (lib/projects.js → foldDirectoryReport), so a partly loaded list is
// never shown. `attempt` re-opens listeners that ended with an error.
export function useProjectDirectory(companyId, projectIds) {
  const idsKey = (projectIds ?? []).join('/')

  const [snap, setSnap] = useState({ key: null, ...EMPTY_DIRECTORY_SNAPSHOT })
  const attempt = snap.attempt

  useEffect(() => {
    if (!companyId || !idsKey) return undefined

    const key = `${companyId}|${idsKey}|${attempt}`
    const ids = idsKey.split('/')

    const unsubscribes = ids.map((id) => onSnapshot(
      doc(db, 'companies', companyId, 'projectDirectory', id),
      { includeMetadataChanges: true },
      (docSnap) => setSnap((s) => foldDirectoryReport(s, key, ids, id, {
        project: docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null,
        fromCache: docSnap.metadata.fromCache === true,
        code: null,
      })),
      (err) => setSnap((s) => foldDirectoryReport(s, key, ids, id, { project: null, fromCache: false, code: err?.code ?? 'unknown' })),
    ))
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [companyId, idsKey, attempt])

  // Re-open the listeners after a failed read. Reads only.
  const retryDirectory = useCallback(() => {
    setSnap((s) => (s.error ? { ...EMPTY_DIRECTORY_SNAPSHOT, attempt: s.attempt + 1 } : s))
  }, [])

  const targetKey = companyId && idsKey ? `${companyId}|${idsKey}|${attempt}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const directory = useMemo(
    () => (settled ? snap.projects : []),
    [settled, snap.projects],
  )
  const directoryLoading = targetKey !== null && !settled
  const directoryError = settled ? snap.error : false
  const directoryErrorCode = directoryError ? snap.readCode : null
  const directoryFromCache = settled && snap.fromCache === true

  return { directory, directoryLoading, directoryError, directoryErrorCode, directoryFromCache, retryDirectory }
}
