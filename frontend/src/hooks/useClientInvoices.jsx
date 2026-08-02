import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import { useProject } from './useProject'
import { stageProjectCurrencyLock } from './projectCurrencyLock'
import { resolveProjectCurrency } from '../lib/currency'
import {
  CI_STATUS, CI_DOC_TYPE, CLIENT_INVOICE_COUNTER_ID,
  canTransition, invoiceTotals, formatClientInvoiceNumber, validateInvoiceDraft,
} from '../lib/clientInvoices'

// ── Client Invoices (accounts receivable) ────────────────────────────────────
//
// The revenue-side register: what has been formally billed to the head-contract
// client. Reads are restricted to internal financial roles by Firestore rules.
//
// This hook writes ONLY client invoice documents (plus the company-wide counter
// and the project currency ratchet, both inside the create transaction). It
// never mutates the commercial baseline, variations, budget lines, purchase
// orders, progress claims, or supplier invoices — every contract-control and
// receivables figure is derived at read time in lib/clientInvoices.js.
//
// LIFECYCLE NOTE. Unlike every other financial collection in this app, the
// client-invoice lifecycle is ALSO enforced by Firestore rules: create is
// draft-only, draft edits cannot rewrite the invoice number/currency/creation
// stamps, issuing and voiding may touch only their own audit fields, and an
// issued invoice is otherwise immutable. The checks below are the UX mirror —
// the rules are the boundary.
export function useClientInvoices(projectId) {
  const { user }    = useAuth()
  const { company } = useCompany()
  const { project } = useProject(projectId)

  const companyId = company?.id ?? null

  // The currency this project reports in — project.currency, falling back to
  // the company base currency and finally AUD.
  const projectCurrency = resolveProjectCurrency(project, company)

  // Live subscription state, tagged with the target (`key`) it belongs to. The
  // effect is subscription-only: state is written ONLY from the onSnapshot
  // callbacks, never synchronously in the effect body, so loading/error are
  // derived at render time below (matching useProjectCommercial).
  const [snap, setSnap] = useState({ key: null, invoices: [], error: false })

  useEffect(() => {
    if (!companyId || !projectId) return undefined

    const key = `${companyId}/${projectId}`
    const ref = collection(db, 'companies', companyId, 'projects', projectId, 'clientInvoices')
    const q   = query(ref, orderBy('createdAt', 'desc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        invoices: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection for a non-financial role) —
      // degrade gracefully rather than crashing the page.
      () => setSnap({ key, invoices: [], error: true }),
    )
    return unsubscribe
  }, [companyId, projectId])

  const targetKey = companyId && projectId ? `${companyId}/${projectId}` : null
  const settled = targetKey !== null && snap.key === targetKey
  const clientInvoices = settled ? snap.invoices : []
  const clientInvoicesLoading = targetKey !== null && !settled
  const clientInvoicesError = settled ? snap.error : false

  // Creates a DRAFT client invoice. The company-wide counter is read and
  // incremented in the same transaction as the invoice write (ADR-5), and the
  // project currency ratchet is staged in the same transaction (ADR-21) — a
  // client invoice is monetary data, so the record and the lock must commit or
  // roll back together.
  //
  // The caller supplies the frozen client snapshot and built line items (ex-GST
  // amount + taxCode + gstAmount, optional variation and cost-code snapshots);
  // header totals are derived here.
  const createClientInvoice = useCallback(async ({
    clientId, clientName, clientLegalName, clientAbn, clientEmail, clientPhone, clientAddress,
    clientRef, externalInvoiceReference,
    description, periodEnding,
    invoiceDate, dueDate, paymentTerms,
    lineItems, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')

    const validationError = validateInvoiceDraft({ clientId, clientName, invoiceDate, lineItems })
    if (validationError) throw new Error(validationError)

    const totals = invoiceTotals(lineItems)

    const counterRef = doc(db, 'companies', companyId, 'counters', CLIENT_INVOICE_COUNTER_ID)
    const invoiceRef = doc(collection(db, 'companies', companyId, 'projects', projectId, 'clientInvoices'))

    await runTransaction(db, async (tx) => {
      const counterSnap = await tx.get(counterRef)
      const next = counterSnap.exists() ? counterSnap.data().next : 1
      // The currency ratchet is staged during the transaction's READ phase and
      // committed below, so this invoice and the project lock succeed or fail
      // together. Firestore requires all transaction reads before any writes.
      const commitLock = await stageProjectCurrencyLock(tx, companyId, projectId)

      tx.set(counterRef, { next: next + 1 }, { merge: true })

      tx.set(invoiceRef, {
        invoiceNumber: formatClientInvoiceNumber(next),
        status:        CI_STATUS.DRAFT,
        docType:       CI_DOC_TYPE.INVOICE,

        // Client identity — FROZEN at creation so later contact edits never
        // rewrite billing history (the supplierName/costCodeName idiom).
        clientId:        clientId ?? null,
        clientName:      (clientName || '').trim(),
        clientLegalName: (clientLegalName || '').trim(),
        clientAbn:       (clientAbn || '').trim(),
        clientEmail:     (clientEmail || '').trim(),
        clientPhone:     (clientPhone || '').trim(),
        clientAddress: {
          street:   clientAddress?.street   || '',
          suburb:   clientAddress?.suburb   || '',
          state:    clientAddress?.state    || '',
          postcode: clientAddress?.postcode || '',
        },

        // The CLIENT's own contract/purchase-order reference — what they asked
        // us to quote on their remittance. Distinct from
        // externalInvoiceReference below.
        clientRef: clientRef?.trim() || '',

        // The reference of the invoice actually issued through an external
        // accounting system (Xero / MYOB / QuickBooks) or a manual process.
        // Optional and authored — Constrapp does not produce a compliant
        // Australian Tax Invoice (company legal name and ABN are not captured),
        // so this is how a user ties this record to the document the client
        // received. Editable while draft; immutable after issue.
        // `externalRefs` below stays RESERVED for future structured integrations.
        externalInvoiceReference: externalInvoiceReference?.trim() || '',

        description:  description?.trim() || '',
        periodEnding: periodEnding || '',

        invoiceDate:  invoiceDate || '',
        dueDate:      dueDate     || '',
        // Frozen snapshot of the terms that produced the suggested due date.
        paymentTerms: paymentTerms ?? null,

        // Money — ex-GST canonical, per-line GST; headers derive from the lines.
        // No retention and no payable/gross split on the client side in this
        // foundation (client retention is a separate future foundation).
        lineItems,
        subtotal:   totals.subtotal,
        gstTotal:   totals.gstTotal,
        grossTotal: totals.grossTotal,

        // Audit snapshot of the currency this document was raised in. The
        // PROJECT currency remains the display authority — this field is never
        // read for rendering, so a project can never show mixed currencies.
        currency: projectCurrency,
        revision: 1,

        notes: notes?.trim() || '',

        // Lifecycle audit stamps. Rules require these to be null at create.
        issuedAt:   null,
        issuedBy:   null,
        voidedAt:   null,
        voidedBy:   null,
        voidReason: '',

        // Reserved for future modules (Credit Notes, Storage, accounting sync).
        adjustsInvoiceId: null,
        attachments:      [],
        externalRefs:     {},

        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      })
      commitLock()
    })
    return invoiceRef.id
  }, [companyId, projectId, user, projectCurrency])

  // Draft-only edits. The invoice number, currency, docType, revision, and
  // creation stamps are never written here — and Firestore rules reject an
  // update that changes any of them.
  const updateClientInvoice = useCallback(async (invoice, {
    clientId, clientName, clientLegalName, clientAbn, clientEmail, clientPhone, clientAddress,
    clientRef, externalInvoiceReference,
    description, periodEnding,
    invoiceDate, dueDate, paymentTerms,
    lineItems, notes,
  }) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (invoice.status !== CI_STATUS.DRAFT) throw new Error('Only draft client invoices can be edited')

    const validationError = validateInvoiceDraft({ clientId, clientName, invoiceDate, lineItems })
    if (validationError) throw new Error(validationError)

    const totals = invoiceTotals(lineItems)
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'clientInvoices', invoice.id)

    await updateDoc(ref, {
      clientId:        clientId ?? null,
      clientName:      (clientName || '').trim(),
      clientLegalName: (clientLegalName || '').trim(),
      clientAbn:       (clientAbn || '').trim(),
      clientEmail:     (clientEmail || '').trim(),
      clientPhone:     (clientPhone || '').trim(),
      clientAddress: {
        street:   clientAddress?.street   || '',
        suburb:   clientAddress?.suburb   || '',
        state:    clientAddress?.state    || '',
        postcode: clientAddress?.postcode || '',
      },
      clientRef:                clientRef?.trim() || '',
      externalInvoiceReference: externalInvoiceReference?.trim() || '',
      description:  description?.trim() || '',
      periodEnding: periodEnding || '',
      invoiceDate:  invoiceDate  || '',
      dueDate:      dueDate      || '',
      paymentTerms: paymentTerms ?? null,
      lineItems,
      subtotal:   totals.subtotal,
      gstTotal:   totals.gstTotal,
      grossTotal: totals.grossTotal,
      notes:      notes?.trim() || '',
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  // Issuing is a SEPARATE operation performed after the draft is saved — it
  // never carries content changes. Firestore rules permit this update to touch
  // only status/issuedAt/issuedBy/updatedAt/updatedBy, require issuedBy to be
  // the calling user, and require issuedAt to be the server request time.
  const issueClientInvoice = useCallback(async (invoice) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(invoice.status, CI_STATUS.ISSUED)) {
      throw new Error(`Cannot issue a ${invoice.status} client invoice`)
    }
    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'clientInvoices', invoice.id)
    await updateDoc(ref, {
      status:    CI_STATUS.ISSUED,
      issuedAt:  serverTimestamp(),
      issuedBy:  user.uid,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, projectId, user])

  // Voiding is terminal and available from draft or issued. A non-empty reason
  // is required — by this hook AND by Firestore rules. Financial documents are
  // never deleted (ADR-12); the invoice number is retained, so a voided invoice
  // leaves a visible, intentional gap in the issued sequence.
  const voidClientInvoice = useCallback(async (invoice, voidReason) => {
    if (!companyId || !projectId || !user) throw new Error('Not authenticated')
    if (!canTransition(invoice.status, CI_STATUS.VOID)) {
      throw new Error(`Cannot void a ${invoice.status} client invoice`)
    }
    const reason = (voidReason || '').trim()
    if (!reason) throw new Error('Enter a reason for voiding this invoice')

    const ref = doc(db, 'companies', companyId, 'projects', projectId, 'clientInvoices', invoice.id)
    await updateDoc(ref, {
      status:     CI_STATUS.VOID,
      voidedAt:   serverTimestamp(),
      voidedBy:   user.uid,
      voidReason: reason,
      updatedAt:  serverTimestamp(),
      updatedBy:  user.uid,
    })
  }, [companyId, projectId, user])

  return {
    clientInvoices,
    clientInvoicesLoading,
    clientInvoicesError,
    createClientInvoice,
    updateClientInvoice,
    issueClientInvoice,
    voidClientInvoice,
  }
}
