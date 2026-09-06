import { useEffect, useState, useCallback } from 'react'
import {
  collection, doc, onSnapshot, query, orderBy,
  addDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../lib/firebase'
import { useAuth } from './useAuth'
import { useCompany } from './useCompany'
import {
  ENTITY_TYPE, GST_STATUS, contactDisplayName, normaliseAbn, validateContact,
  normaliseProjectAssignments, projectIdsFromAssignments,
} from '../lib/contacts'

// Normalises form input into the stored contact shape. displayName/nameLower
// are denormalised here so list ordering and search never recompute names.
function buildContactFields(data) {
  const entityType  = data.entityType
  const legalName   = data.legalName?.trim()   || ''
  const tradingName = data.tradingName?.trim() || ''
  const firstName   = data.firstName?.trim()   || ''
  const lastName    = data.lastName?.trim()    || ''
  const displayName = contactDisplayName({ entityType, tradingName, legalName, firstName, lastName })
  const days        = Number(data.paymentTerms?.days)
  const projectAssignments = normaliseProjectAssignments(data.projectAssignments)
  const people      = entityType === ENTITY_TYPE.ORGANISATION
    ? (data.people ?? []).map(p => ({
        id:       p.id,
        name:     p.name?.trim()     || '',
        jobTitle: p.jobTitle?.trim() || '',
        email:    p.email?.trim()    || '',
        phone:    p.phone?.trim()    || '',
        notes:    p.notes?.trim()    || '',
      })).filter(p => p.name)
    : []

  return {
    entityType,
    contactTypes: [...(data.contactTypes ?? [])],
    legalName,
    tradingName,
    firstName,
    lastName,
    displayName,
    nameLower:   displayName.toLowerCase(),
    abn:         normaliseAbn(data.abn),
    country:     data.country?.trim() || 'AU',
    email:       data.email?.trim() || '',
    phone:       data.phone?.trim() || '',
    address: {
      street:   data.address?.street?.trim()   || '',
      suburb:   data.address?.suburb?.trim()   || '',
      state:    data.address?.state?.trim()    || '',
      postcode: data.address?.postcode?.trim() || '',
    },
    trades:       (data.trades ?? []).map(t => t.trim()).filter(Boolean),
    paymentTerms: Number.isFinite(days) && days > 0
      ? { days, basis: data.paymentTerms?.basis || 'invoice' }
      : null,
    gstStatus: data.gstStatus || GST_STATUS.UNKNOWN,
    notes:     data.notes?.trim() || '',
    people,
    primaryPersonId: people.some(p => p.id === data.primaryPersonId) ? data.primaryPersonId : null,
    projectAssignments,
    projectIds: projectIdsFromAssignments(projectAssignments),
  }
}

export function useContacts() {
  const { user }    = useAuth()
  const { company } = useCompany()
  const companyId = company?.id ?? null

  // Live subscription state, tagged with the target (`key`) it belongs to —
  // the keyed-snapshot pattern used by useProjectActivities / useDrawings. The
  // effect is subscription-only: state is written ONLY from the async
  // onSnapshot callbacks, never synchronously in the effect body, and
  // contacts/loading are DERIVED at render time below
  // (react-hooks/set-state-in-effect).
  //
  // The target is the COMPANY alone — the contact book is company-scoped, so
  // switching project neither re-subscribes nor reloads it.
  //
  // `error` is tracked here for pattern uniformity but deliberately NOT
  // exposed: adding a `contactsError` would change this hook's public API. A
  // failed read therefore still presents as an empty list, exactly as it did
  // before this migration.
  const [snap, setSnap] = useState({ key: null, contacts: [], error: false })

  useEffect(() => {
    if (!companyId) return undefined

    const key = companyId
    const ref = collection(db, 'companies', companyId, 'contacts')
    const q   = query(ref, orderBy('nameLower', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (querySnap) => setSnap({
        key,
        contacts: querySnap.docs.map(d => ({ id: d.id, ...d.data() })),
        error: false,
      }),
      // Read error (most often a rules rejection) — degrade gracefully rather
      // than crashing every supplier/client picker in the app.
      () => setSnap({ key, contacts: [], error: true }),
    )
    return unsubscribe
  }, [companyId])

  // Derived, at render time: no synchronous setState in the effect. With no
  // target we are idle (no data, not loading); with a target we are loading
  // until the subscription reports for THAT target (`settled`), which also
  // hides a previous company's contacts immediately.
  const targetKey = companyId || null
  const settled = targetKey !== null && snap.key === targetKey
  const contacts = settled ? snap.contacts : []
  const contactsLoading = targetKey !== null && !settled

  // Returns the new contact's document ID so callers (e.g. the PO supplier
  // quick-create) can select it immediately.
  const createContact = useCallback(async (data) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    const fields = buildContactFields(data)
    const validationError = validateContact(fields)
    if (validationError) throw new Error(validationError)

    const col = collection(db, 'companies', companyId, 'contacts')
    const ref = await addDoc(col, {
      ...fields,
      isActive:     true,
      externalRefs: {},
      createdAt:    serverTimestamp(),
      createdBy:    user.uid,
      updatedAt:    serverTimestamp(),
      updatedBy:    user.uid,
    })
    return ref.id
  }, [companyId, user])

  const updateContact = useCallback(async (contact, data) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    const fields = buildContactFields(data)
    const validationError = validateContact(fields)
    if (validationError) throw new Error(validationError)

    const ref = doc(db, 'companies', companyId, 'contacts', contact.id)
    await updateDoc(ref, {
      ...fields,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, user])

  // Archiving is administrative, not a financial lifecycle — it is reversible.
  const setContactActive = useCallback(async (contact, isActive) => {
    if (!companyId || !user) throw new Error('Not authenticated')
    const ref = doc(db, 'companies', companyId, 'contacts', contact.id)
    await updateDoc(ref, {
      isActive,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid,
    })
  }, [companyId, user])

  const archiveContact    = useCallback((contact) => setContactActive(contact, false), [setContactActive])
  const reactivateContact = useCallback((contact) => setContactActive(contact, true),  [setContactActive])

  return { contacts, contactsLoading, createContact, updateContact, archiveContact, reactivateContact }
}
