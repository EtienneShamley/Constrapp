import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import { todayIso } from '../../../lib/payments'
import { useDrawings } from '../../../hooks/useDrawings'
import { useDrawingRevisions } from '../../../hooks/useDrawingRevisions'
import { useProjectDocuments } from '../../../hooks/useProjectDocuments'
import { sortRevisions, isWithdrawnDrawing, isWithdrawnRevision } from '../../../lib/drawings'
import { sortDocuments, isWithdrawnDocument } from '../../../lib/projectDocuments'
import {
  REFERENCE_TYPE, LIMITS, RFI_STATUS,
  validateRfiDraft, validateManagementDraft,
} from '../../../lib/rfis'
import RfiModalShell, { inputCls, labelCls, hintCls } from './RfiModalShell'

// ── RFI editor ───────────────────────────────────────────────────────────────
//
// Two modes over ONE form:
//   · DRAFT (create, or edit a draft) — every authored field
//   · MANAGEMENT (an OPEN RFI) — assignee and due date ONLY; the question
//     block is rendered read-only because it is frozen for life by rules
//
// Pure UI over lib/rfis.js validation — every rule shown here has a
// counterpart in the `rfis` block of firestore.rules, so the form can never
// assemble a document the server rejects for a reason the user cannot see.
//
// THE REFERENCE PICKER offers a drawing REVISION (drawing + the specific
// revision, both required) or a general document — never a master-only
// drawing reference. The RFI must stay pinned to exactly the sheet as issued
// when the question was asked.
//
// RAISING IS NOT HERE. A draft is saved first, then raised from the register,
// so the raise gate (assignee + due date) is a visible, separate step.

export default function RfiEditorModal({
  rfi,           // existing RFI when editing, null when creating
  contacts,      // active company contacts
  costCodes,     // active company cost codes
  projectId,
  onSave,        // async (fields) => void
  onClose,
}) {
  const creating = !rfi
  const managementOnly = rfi?.status === RFI_STATUS.OPEN
  const today = todayIso()

  const [title, setTitle]           = useState(rfi?.title ?? '')
  const [question, setQuestion]     = useState(rfi?.question ?? '')
  const [raisedDate, setRaisedDate] = useState(rfi?.raisedDate ?? today)
  const [referenceType, setReferenceType] = useState(rfi?.referenceType ?? REFERENCE_TYPE.NONE)
  const [drawingId, setDrawingId]   = useState(rfi?.referenceDrawingId ?? '')
  const [revisionId, setRevisionId] = useState(rfi?.referenceRevisionId ?? '')
  const [documentId, setDocumentId] = useState(rfi?.referenceDocumentId ?? '')
  const [costCodeId, setCostCodeId] = useState(rfi?.costCodeId ?? '')
  const [assignedToContactId, setAssignedToContactId] = useState(rfi?.assignedToContactId ?? '')
  const [dueDate, setDueDate]       = useState(rfi?.dueDate ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  // Reference sources — read-only subscriptions on the existing hooks.
  const { drawings, drawingsError }   = useDrawings(projectId)
  const { revisions, revisionsLoading, revisionsError } = useDrawingRevisions(projectId, drawingId || null)
  const { documents, documentsError } = useProjectDocuments(projectId)

  const activeDrawings = useMemo(
    () => (drawings ?? []).filter(d => !isWithdrawnDrawing(d))
      .sort((a, b) => String(a.drawingNumber ?? '').localeCompare(String(b.drawingNumber ?? ''))),
    [drawings],
  )
  // Withdrawn revisions are excluded from NEW references; an existing
  // reference to one is preserved (the record must not float).
  const selectableRevisions = useMemo(
    () => sortRevisions(revisions).filter(r => !isWithdrawnRevision(r) || r.id === rfi?.referenceRevisionId),
    [revisions, rfi],
  )
  const activeDocuments = useMemo(
    () => sortDocuments((documents ?? []).filter(d => !isWithdrawnDocument(d))),
    [documents],
  )

  // Contacts assigned to THIS project first — the same courtesy the PO supplier
  // picker gives, without changing who is selectable.
  const contactGroups = useMemo(() => {
    const active = (contacts ?? []).filter(c => c.isActive !== false)
    const mine   = active.filter(c => (c.projectIds ?? []).includes(projectId))
    const others = active.filter(c => !(c.projectIds ?? []).includes(projectId))
    const byName = (a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '')
    return { mine: [...mine].sort(byName), others: [...others].sort(byName) }
  }, [contacts, projectId])

  const activeCostCodes = useMemo(
    () => (costCodes ?? []).filter(c => c.isActive !== false),
    [costCodes],
  )

  const contactName = (id) => (contacts ?? []).find(c => c.id === id)?.displayName ?? ''
  const costCodeLabel = (id) => {
    const cc = (costCodes ?? []).find(c => c.id === id)
    if (!cc) return ''
    return cc.name ? `${cc.code} — ${cc.name}` : cc.code
  }
  const drawingLabel = (id) => {
    const d = (drawings ?? []).find(x => x.id === id)
    if (!d) return rfi?.referenceDrawingId === id ? rfi.referenceLabel : ''
    return d.title ? `${d.drawingNumber} ${d.title}` : String(d.drawingNumber ?? '')
  }
  const revisionCode = (id) => {
    const r = (revisions ?? []).find(x => x.id === id)
    if (!r) return rfi?.referenceRevisionId === id ? rfi.referenceRevisionCode : ''
    return String(r.revisionCode ?? '')
  }
  const documentLabel = (id) => {
    const d = (documents ?? []).find(x => x.id === id)
    if (!d) return rfi?.referenceDocumentId === id ? rfi.referenceLabel : ''
    return String(d.name ?? '')
  }

  const changeReferenceType = (value) => {
    setReferenceType(value)
    setDrawingId(''); setRevisionId(''); setDocumentId('')
  }
  const changeDrawing = (value) => {
    setDrawingId(value)
    setRevisionId('')
  }

  const isDrawing  = referenceType === REFERENCE_TYPE.DRAWING
  const isDocument = referenceType === REFERENCE_TYPE.DOCUMENT

  const fields = {
    title,
    question,
    raisedDate,
    referenceType,
    referenceDrawingId:    isDrawing ? (drawingId || null) : null,
    referenceRevisionId:   isDrawing ? (revisionId || null) : null,
    referenceDocumentId:   isDocument ? (documentId || null) : null,
    referenceLabel:        isDrawing ? drawingLabel(drawingId) : isDocument ? documentLabel(documentId) : '',
    referenceRevisionCode: isDrawing ? revisionCode(revisionId) : '',
    costCodeId:   costCodeId || null,
    costCodeName: costCodeId ? costCodeLabel(costCodeId) : '',
    assignedToContactId: assignedToContactId || null,
    assignedToName:      assignedToContactId ? contactName(assignedToContactId) : '',
    dueDate: dueDate || null,
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const validationError = managementOnly
      ? validateManagementDraft(fields, rfi)
      : validateRfiDraft(fields)
    if (validationError) { setError(validationError); return }
    setSaving(true); setError(null)
    try {
      await onSave(fields)
      onClose()
    } catch (err) {
      setError(err?.message || 'Failed to save. Check your connection and try again.')
      setSaving(false)
    }
  }

  const heading = creating ? 'New RFI' : managementOnly ? `Update ${rfi.rfiNumber}` : `Edit ${rfi.rfiNumber}`

  return (
    <RfiModalShell title={heading} onClose={onClose} wide>
      {/* noValidate: native date constraints (min/badInput) would BLOCK submit
          with a browser message and make a partially-cleared date field
          (which Chrome reports as year 0001) unsaveable. lib/rfis.js is the
          validator and its messages are the ones the user sees. */}
      <form onSubmit={handleSubmit} noValidate className="p-5">
        {managementOnly && (
          <div className="border border-brand-border rounded-lg p-3 mb-4">
            <p className="m-0 text-[12px] text-brand-text-soft">
              This RFI is <strong className="text-brand-text">open</strong>. The question, raised date, reference and
              cost code are frozen; only the assignee and due date can change.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rfi-title">Title *</label>
            <input
              id="rfi-title"
              className={inputCls}
              maxLength={LIMITS.title}
              placeholder="e.g. Slab thickness at grid C"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={managementOnly}
            />
          </div>

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rfi-question">Question *</label>
            <textarea
              id="rfi-question"
              className={`${inputCls} min-h-[120px]`}
              maxLength={LIMITS.question}
              placeholder="State the clarification needed, precisely enough that the answer can be actioned."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={managementOnly}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="rfi-raised">Raised date *</label>
            <input
              id="rfi-raised"
              type="date"
              className={inputCls}
              value={raisedDate}
              onChange={(e) => setRaisedDate(e.target.value)}
              disabled={managementOnly}
            />
            <p className={hintCls}>The date on the RFI, not the date you typed it in.</p>
          </div>

          <div>
            <label className={labelCls} htmlFor="rfi-due">Due date{managementOnly ? ' *' : ''}</label>
            {/* No native `min`: the >= raisedDate rule is enforced by
                validateDueDate (and by rules), which reports it in words. */}
            <div className="flex gap-2">
              <input
                id="rfi-due"
                type="date"
                className={inputCls}
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              {/* DRAFT ONLY. An open RFI must keep its due date, so the
                  explicit clear action is not offered in management mode.
                  Native date controls cannot be reliably emptied by hand. */}
              {!managementOnly && dueDate && (
                <Btn variant="ghost" type="button" sm className="shrink-0 self-center" onClick={() => setDueDate('')}>
                  Clear
                </Btn>
              )}
            </div>
            <p className={hintCls}>
              {managementOnly ? 'When the answer is needed — required while open.' : 'Optional on a draft — required to raise. Use Clear to remove it.'}
            </p>
          </div>

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rfi-assignee">Assigned to{managementOnly ? ' *' : ''}</label>
            <select
              id="rfi-assignee"
              className={inputCls}
              value={assignedToContactId}
              onChange={(e) => setAssignedToContactId(e.target.value)}
            >
              {/* Once open, an RFI must stay assigned — the empty choice is not offered. */}
              {!managementOnly && <option value="">— Not assigned —</option>}
              {contactGroups.mine.length > 0 && (
                <optgroup label="This project">
                  {contactGroups.mine.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                </optgroup>
              )}
              {contactGroups.others.length > 0 && (
                <optgroup label="Other company contacts">
                  {contactGroups.others.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                </optgroup>
              )}
            </select>
            <p className={hintCls}>
              A company Contact — the consultant, client or subcontractor who owes the answer. Optional on a
              draft; required to raise{managementOnly ? ' and must remain set while open' : ''}. Assigning an
              internal staff member is not available.
            </p>
          </div>

          {/* ── Reference ───────────────────────────────────────────── */}
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rfi-ref-type">Reference</label>
            <select
              id="rfi-ref-type"
              className={inputCls}
              value={referenceType}
              onChange={(e) => changeReferenceType(e.target.value)}
              disabled={managementOnly}
            >
              <option value={REFERENCE_TYPE.NONE}>No reference</option>
              <option value={REFERENCE_TYPE.DRAWING}>Drawing revision</option>
              <option value={REFERENCE_TYPE.DOCUMENT}>General document</option>
            </select>
            <p className={hintCls}>
              Links the question to an existing project drawing revision or document. Nothing is copied — the
              RFI stores the reference only, and a drawing reference stays pinned to the exact revision chosen.
            </p>
          </div>

          {isDrawing && (
            <>
              <div>
                <label className={labelCls} htmlFor="rfi-ref-drawing">Drawing *</label>
                <select
                  id="rfi-ref-drawing"
                  className={inputCls}
                  value={drawingId}
                  onChange={(e) => changeDrawing(e.target.value)}
                  disabled={managementOnly}
                >
                  <option value="">— Choose a drawing —</option>
                  {activeDrawings.map(d => (
                    <option key={d.id} value={d.id}>{d.drawingNumber} {d.title}</option>
                  ))}
                  {rfi?.referenceDrawingId && !activeDrawings.some(d => d.id === rfi.referenceDrawingId) && (
                    <option value={rfi.referenceDrawingId}>{rfi.referenceLabel} (withdrawn)</option>
                  )}
                </select>
                {drawingsError && <p className="m-0 mt-1 text-[10.5px] text-brand-amber">Drawings could not be loaded.</p>}
              </div>
              <div>
                <label className={labelCls} htmlFor="rfi-ref-revision">Revision *</label>
                <select
                  id="rfi-ref-revision"
                  className={inputCls}
                  value={revisionId}
                  onChange={(e) => setRevisionId(e.target.value)}
                  disabled={managementOnly || !drawingId}
                >
                  <option value="">{drawingId ? (revisionsLoading ? 'Loading…' : '— Choose the revision —') : 'Choose a drawing first'}</option>
                  {selectableRevisions.map(r => (
                    <option key={r.id} value={r.id}>
                      Rev {r.revisionCode}{r.status === 'current' ? ' (current)' : r.status === 'superseded' ? ' (superseded)' : ' (withdrawn)'}
                    </option>
                  ))}
                </select>
                <p className={hintCls}>The specific issue the question is about. Required.</p>
                {revisionsError && <p className="m-0 mt-1 text-[10.5px] text-brand-amber">Revisions could not be loaded.</p>}
              </div>
            </>
          )}

          {isDocument && (
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="rfi-ref-document">Document *</label>
              <select
                id="rfi-ref-document"
                className={inputCls}
                value={documentId}
                onChange={(e) => setDocumentId(e.target.value)}
                disabled={managementOnly}
              >
                <option value="">— Choose a document —</option>
                {activeDocuments.map(d => (
                  <option key={d.id} value={d.id}>{d.name}{d.versionLabel ? ` · ${d.versionLabel}` : ''}</option>
                ))}
                {rfi?.referenceDocumentId && !activeDocuments.some(d => d.id === rfi.referenceDocumentId) && (
                  <option value={rfi.referenceDocumentId}>{rfi.referenceLabel} (withdrawn)</option>
                )}
              </select>
              {documentsError && <p className="m-0 mt-1 text-[10.5px] text-brand-amber">Documents could not be loaded.</p>}
            </div>
          )}

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="rfi-cost-code">Cost code</label>
            <select
              id="rfi-cost-code"
              className={inputCls}
              value={costCodeId}
              onChange={(e) => setCostCodeId(e.target.value)}
              disabled={managementOnly}
            >
              <option value="">— None —</option>
              {activeCostCodes.map(cc => (
                <option key={cc.id} value={cc.id}>{cc.name ? `${cc.code} — ${cc.name}` : cc.code}</option>
              ))}
            </select>
            <p className={hintCls}>
              Optional. A join to the commercial spine only — it changes no budget, forecast or cash figure.
            </p>
          </div>
        </div>

        {error && <p className="m-0 mt-3 text-[12px] text-brand-red">{error}</p>}

        <div className="flex justify-end gap-2 mt-5 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn type="submit" disabled={saving}>
            {saving ? 'Saving…' : creating ? 'Save draft' : managementOnly ? 'Update RFI' : 'Save draft'}
          </Btn>
        </div>
      </form>
    </RfiModalShell>
  )
}
