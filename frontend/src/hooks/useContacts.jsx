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
  const [contacts, setContacts]               = useState([])
  const [contactsLoading, setContactsLoading] = useState(true)

  const companyId = company?.id ?? null

  useEffect(() => {
    if (!companyId) {
      setContacts([])
      setContactsLoading(false)
      return
    }

    setContactsLoading(true)
    const ref = collection(db, 'companies', companyId, 'contacts')
    const q   = query(ref, orderBy('nameLower', 'asc'))

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setContacts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setContactsLoading(false)
      },
      () => {
        setContacts([])
        setContactsLoading(false)
      }
    )
    return unsubscribe
  }, [companyId])

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
