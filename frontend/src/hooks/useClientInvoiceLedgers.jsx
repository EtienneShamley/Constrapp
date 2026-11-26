import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useCompany } from './useCompany'

// ── Client invoice ledgers (ADR-87) — read only ──────────────────────────────
//
// One document per client invoice that has had a credit note or a retention
// release posted against it; the document id IS the invoice id. Pages read
// them for two things only: to build a draft against the current totals, and
// to cross-check the ledger against its documents
// (lib/clientReceivables.js → ledgerExceptions). No figure is taken from here.
// There is no write path in this hook: a ledger moves only inside the
// transactions of lib/clientLedgerActions.js.
export function useClientInvoiceLedgers(projectId) {
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const [snap, setSnap] = useState({ key: null, ledgers: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined
    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientInvoiceLedgers')
    return onSnapshot(
      ref,
      (querySnap) => setSnap({ key, ledgers: querySnap.docs.map(d => ({ id: d.id, ...d.data() })), error: false }),
      () => setSnap({ key, ledgers: [], error: true }),
    )
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  return {
    clientInvoiceLedgers: settled ? snap.ledgers : [],
    clientInvoiceLedgersLoading: targetKey !== null && !settled,
    clientInvoiceLedgersError: settled ? snap.error : false,
  }
}
