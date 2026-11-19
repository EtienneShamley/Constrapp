import { useCallback, useEffect, useRef, useState } from 'react'
import {
  collection, doc, query, orderBy, where, getDocsFromServer, getDocFromServer,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'
import { createPortfolioLoader, loadProjectSources } from '../lib/portfolioSources'

// ── L2-C Portfolio Report — the one-shot loader (ADR-78) ─────────────────────
//
// Reads each in-scope project's financial records ONCE and hands the raw
// documents to lib/portfolioReport.js. This hook opens NO persistent listener:
// a company-wide page that kept ~15 live queries open per project is exactly
// what ADR-42 rejected. The price is that the page is a point-in-time read —
// it does not update itself; the user presses Refresh.
//
// WHAT is read, in what shape and how many projects at a time is decided by
// lib/portfolioSources.js (pure, unit-tested, and structurally compared with
// the live hooks). This file only supplies the Firestore reader and the React
// state.
//
// ⚠️ SERVER READS ONLY. `getDocsFromServer` / `getDocFromServer` FAIL when the
// server cannot be reached. The default one-shot reads may instead answer from
// the local cache — and an empty cache would arrive as an empty register,
// i.e. as a genuine zero. A failed read here becomes `error: true` and the
// figures that need it render Unavailable.
//
// The Security Rules decide every one of these reads exactly as they decide the
// live hooks' — same paths, financial roles of the caller's own company only.
// The role check on the page is UX; it only avoids issuing reads the rules
// would deny.
//
// State follows the app's keyed pattern: results carry the run key they belong
// to (company + refresh count) and are exposed only for the CURRENT key, and
// state is written only from the loader's asynchronous callback — never
// synchronously in an effect.

const projectDoc = (companyId, projectId) => ['companies', companyId, 'projects', projectId]

const record = (d) => ({ id: d.id, ...d.data() })

const firestoreReader = {
  async list({ companyId, projectId, collection: name, orderBy: order, where: filter }) {
    const ref = collection(db, ...projectDoc(companyId, projectId), name)
    const constraints = []
    if (filter) constraints.push(where(...filter))
    if (order) constraints.push(orderBy(...order))
    const snapshot = await getDocsFromServer(constraints.length > 0 ? query(ref, ...constraints) : ref)
    return snapshot.docs.map(record)
  },
  async get({ companyId, projectId, path }) {
    const d = await getDocFromServer(doc(db, ...projectDoc(companyId, projectId), ...path))
    return d.exists() ? record(d) : null
  },
}

const NO_RESULTS = Object.freeze({})

// `projectIds` — the in-scope project ids, in display order. Returns
// `results` (project id → { sources, readStates, reads, loadedAt }; a project
// with no entry is still loading) and `refresh`, which discards everything and
// reads again.
export function usePortfolioReport(projectIds) {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  const [refreshCount, setRefreshCount] = useState(0)
  const [snap, setSnap] = useState({ key: null, results: NO_RESULTS })
  const runRef = useRef(null)

  // Firestore document ids never contain '/', so the joined string is a
  // faithful, stable dependency for the id list.
  const idsKey = (projectIds ?? []).join('/')
  const key = companyId ? `${companyId}#${refreshCount}` : null

  useEffect(() => {
    if (!key) return
    const ids = idsKey ? idsKey.split('/') : []

    // A new run (another company, or Refresh): the previous loader is
    // cancelled, so nothing it still has in flight is ever reported.
    if (!runRef.current || runRef.current.key !== key) {
      runRef.current?.loader.cancel()
      const loader = createPortfolioLoader({
        loadProject: (projectId) => loadProjectSources(firestoreReader, { companyId, projectId }),
        onResult: (projectId, result) => setSnap(prev => ({
          key,
          results: {
            ...(prev.key === key ? prev.results : NO_RESULTS),
            [projectId]: { ...result, loadedAt: new Date() },
          },
        })),
      })
      runRef.current = { key, loader }
    }

    // Same run, scope changed: drop queued projects that left the scope and
    // add the ones that entered it. Projects already read are not read again.
    runRef.current.loader.retain(ids)
    runRef.current.loader.enqueue(ids)
  }, [key, idsKey, companyId])

  // Leaving the page ends the run: queued projects never start, and results
  // still in flight are discarded.
  useEffect(() => () => {
    runRef.current?.loader.cancel()
    runRef.current = null
  }, [])

  const results = key !== null && snap.key === key ? snap.results : NO_RESULTS
  const refresh = useCallback(() => setRefreshCount(c => c + 1), [])

  return { results, refresh }
}
