import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Btn from '../../components/Btn'
import Stat from '../../components/Stat'
import { useAuth } from '../../hooks/useAuth'
import { useProfile } from '../../hooks/useProfile'
import { useContacts } from '../../hooks/useContacts'
import { useCostCodes } from '../../hooks/useCostCodes'
import { useRfis } from '../../hooks/useRfis'
import {
  RFI_STATUS, RFI_STATUS_ORDER, RFI_STATUS_LABELS,
  canReadRfis, canWriteRfis,
  rfiSummary, sortRfis, filterRfis, assigneeOptions, validateRaise,
} from '../../lib/rfis'
import RfiTable from './rfis/RfiTable'
import RfiCards from './rfis/RfiCards'
import RfiEditorModal from './rfis/RfiEditorModal'
import RfiAnswerModal from './rfis/RfiAnswerModal'
import RfiCloseModal from './rfis/RfiCloseModal'
import RfiCancelModal from './rfis/RfiCancelModal'
import RfiDetailModal from './rfis/RfiDetailModal'

// ── RFIs — Requests for Information (ADR-33) ─────────────────────────────────
//
// THE HONEST FRAME, stated on the page and not only in the docs:
//
//   · This is an INTERNAL REGISTER of questions asked elsewhere, not a
//     communication channel. Nothing is emailed and nobody is notified — an
//     assignee learns of an RFI only if someone tells them.
//   · It is FINANCIALLY INERT. Raising, answering or closing an RFI changes no
//     budget, commitment, actual, forecast, margin, cash-flow or variation
//     figure. The optional cost code is a join key for future analysis only.
//   · The lifecycle is FORWARD-ONLY with NO REOPEN. An unsatisfactory answer
//     is closed with a note and a new RFI is raised.
//
// One clock for the whole screen (`now`), passed down to the table, the cards
// and the detail view, so no two panels can disagree about today.

export default function ProjectRfis() {
  const { projectId } = useOutletContext()
  const { user }    = useAuth()
  const { profile } = useProfile()
  const { contacts }  = useContacts()
  const { costCodes } = useCostCodes()
  const {
    rfis, rfisLoading, rfisError,
    createRfi, updateRfiDraft, updateRfiManagement,
    raiseRfi, answerRfi, closeRfi, cancelRfi,
  } = useRfis(projectId)

  const [search, setSearch]       = useState('')
  const [status, setStatus]       = useState('')
  const [assignee, setAssignee]   = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [editing, setEditing]     = useState(null)   // 'new' | rfi | null
  const [viewing, setViewing]     = useState(null)
  const [answering, setAnswering] = useState(null)
  const [closing, setClosing]     = useState(null)
  const [cancelling, setCancelling] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [raising, setRaising]     = useState(false)

  const role = profile?.role
  // ⚠️ UX ONLY. Firestore rules are the trust boundary — these flags hide
  // actions the server would reject, they do not authorise anything.
  const canRead  = canReadRfis(role)
  const canWrite = canWriteRfis(role)

  // ONE clock. Re-created per render is intentional and harmless.
  const now = useMemo(() => new Date(), [])

  const ordered  = useMemo(() => sortRfis(rfis), [rfis])
  const summary  = useMemo(() => rfiSummary(ordered, now), [ordered, now])
  const filtered = useMemo(
    () => filterRfis(ordered, { search, status, assignedToContactId: assignee, overdueOnly }, now),
    [ordered, search, status, assignee, overdueOnly, now],
  )
  const people = useMemo(() => assigneeOptions(ordered), [ordered])

  // The detail view follows the live document, so a transition made from it
  // re-renders in place rather than showing stale state.
  const viewingLive = useMemo(
    () => (viewing ? ordered.find(r => r.id === viewing.id) ?? viewing : null),
    [viewing, ordered],
  )

  const filtersActive = Boolean(search || status || assignee || overdueOnly)

  // ── Action-error ownership ───────────────────────────────────────────────
  //
  // `actionError` is the ONE register-level error (raise is the only action
  // with no modal of its own). Two rules keep it from going stale:
  //   · BEGINNING any new action clears it — the message described a state
  //     the user is now acting on
  //   · a SUCCESSFUL mutation clears it — the corrective action worked
  // A genuinely failed mutation keeps (or sets) it. Modal-internal failures
  // are shown inside the modal and never touch this state.
  const clearActionError = () => setActionError(null)

  // Runs a hook mutation and clears the register error only if it succeeds.
  // A throw propagates to the modal, which renders it in place.
  const succeeds = (fn) => async (...args) => {
    const result = await fn(...args)
    clearActionError()
    return result
  }

  async function handleSave(fields) {
    if (editing === 'new') await createRfi(fields)
    else if (editing.status === RFI_STATUS.OPEN) await updateRfiManagement(editing, fields)
    else await updateRfiDraft(editing, fields)
    clearActionError()
  }

  // Raise is a one-click action from the register — the gate is visible as a
  // message rather than a form, because the fix (assign + due date) lives in
  // the editor.
  async function handleRaise(rfi) {
    setActionError(null)
    const gateError = validateRaise(rfi)
    if (gateError) { setActionError(`${rfi.rfiNumber}: ${gateError}`); return }
    setRaising(true)
    try {
      await raiseRfi(rfi)
      clearActionError()
    } catch (err) {
      setActionError(`${rfi.rfiNumber}: ${err?.message || 'Failed to raise'}`)
    } finally {
      setRaising(false)
    }
  }

  const openEditor = (rfi) => { clearActionError(); setViewing(null); setEditing(rfi) }
  const openAnswer = (rfi) => { clearActionError(); setViewing(null); setAnswering(rfi) }
  const openClose  = (rfi) => { clearActionError(); setViewing(null); setClosing(rfi) }
  const openCancel = (rfi) => { clearActionError(); setViewing(null); setCancelling(rfi) }
  const openNew    = () => { clearActionError(); setEditing('new') }

  const listProps = {
    canWrite,
    now,
    onView: setViewing,
    onEdit: openEditor,
    onRaise: handleRaise,
    onAnswer: openAnswer,
    onCloseRfi: openClose,
    onCancel: openCancel,
  }

  if (!canRead) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-brand-text font-semibold">RFIs not available</p>
        <p className="m-0 mt-1.5 text-[12px] text-brand-muted">
          The RFI register is visible to company admins, project managers and QS users. Subcontractor and
          client access is not available: those roles are not yet scoped to their own projects, and RFI
          content carries contractual positions.
        </p>
      </Card>
    )
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[17px] font-semibold text-brand-text m-0">Requests for Information</h2>
          <p className="m-0 mt-0.5 text-[12px] text-brand-muted">
            Questions that needed a formal answer — who asked, who owes the answer, and how long it took.
          </p>
        </div>
        {canWrite && (
          <Btn onClick={openNew} disabled={rfisError}>+ New RFI</Btn>
        )}
      </div>

      {rfisError ? (
        <Card>
          <p className="m-0 text-[12.5px] text-brand-amber">
            The RFI register failed to load — it is <strong>unavailable, not empty</strong>. Reload the page;
            if it persists, your role may not have RFI access.
          </p>
        </Card>
      ) : rfisLoading ? (
        <p className="text-[13px] text-brand-muted">Loading RFIs…</p>
      ) : ordered.length === 0 ? (
        <Card className="text-center py-14">
          <div className="text-4xl mb-3 leading-none" aria-hidden="true">❓</div>
          <h3 className="text-brand-text font-bold text-base mb-2 m-0">No RFIs yet</h3>
          <p className="text-brand-muted text-[12.5px] mb-4 max-w-md mx-auto">
            Record the questions this project raises with its consultants, client and subcontractors. Each
            one is numbered from RFI-0001 for this project, tracked to a due date, and kept as evidence once
            answered.
          </p>
          {canWrite && <Btn onClick={openNew}>+ Draft the first RFI</Btn>}
        </Card>
      ) : (
        <>
          {/* ── Summary ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3.5">
            <Card>
              <Stat label="Open" value={summary.open} sub="Raised, awaiting an answer" />
            </Card>
            <Card>
              <Stat
                label="Overdue"
                value={summary.overdue}
                sub="Past due, no answer"
                color={summary.overdue > 0 ? 'var(--color-brand-red)' : undefined}
              />
            </Card>
            <Card>
              <Stat label="Awaiting close" value={summary.awaitingClose} sub="Answered, not yet closed" />
            </Card>
            <Card>
              <Stat label="Closed" value={summary.closed} sub={`${summary.draft} draft · ${summary.cancelled} cancelled`} />
            </Card>
          </div>

          {/* ── Filters ──────────────────────────────────────────────── */}
          <Card className="mb-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="rfi-search">
                  Search
                </label>
                <input
                  id="rfi-search"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text placeholder:text-brand-muted focus:border-brand-accent focus:outline-none min-h-[44px]"
                  placeholder="Number, title or question…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="rfi-status">
                  Status
                </label>
                <select
                  id="rfi-status"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {RFI_STATUS_ORDER.map(s => <option key={s} value={s}>{RFI_STATUS_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1.5" htmlFor="rfi-assignee-filter">
                  Assigned to
                </label>
                <select
                  id="rfi-assignee-filter"
                  className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-[13px] text-brand-text focus:border-brand-accent focus:outline-none min-h-[44px]"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">Anyone</option>
                  {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-[12.5px] text-brand-text cursor-pointer min-h-[44px]">
                  <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
                  Overdue only
                </label>
              </div>
            </div>
            {filtersActive && (
              <p className="m-0 mt-3 text-[11.5px] text-brand-muted">
                Showing {filtered.length} of {ordered.length} RFIs.{' '}
                <button
                  type="button"
                  className="text-brand-accent hover:underline cursor-pointer"
                  onClick={() => { setSearch(''); setStatus(''); setAssignee(''); setOverdueOnly(false) }}
                >
                  Clear filters
                </button>
              </p>
            )}
          </Card>

          {actionError && (
            <Card className="mb-3.5">
              <p className="m-0 text-[12px] text-brand-red">{actionError}</p>
            </Card>
          )}

          {filtered.length === 0 ? (
            <Card>
              <p className="m-0 text-[12.5px] text-brand-muted">No RFI matches these filters.</p>
            </Card>
          ) : (
            <>
              {/* ── Table — DESKTOP/TABLET ──────────────────────────── */}
              <Card padding={false} className={`mb-3.5 hidden md:block ${raising ? 'opacity-70' : ''}`}>
                <div className="px-3.5 py-3 border-b border-brand-border">
                  <p className="text-[13px] font-bold text-brand-text m-0">Register</p>
                  <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
                    Newest first. Every figure above is read from here.
                  </p>
                </div>
                <RfiTable rfis={filtered} {...listProps} />
              </Card>

              {/* ── Cards — MOBILE ──────────────────────────────────── */}
              <div className={`md:hidden mb-3.5 ${raising ? 'opacity-70' : ''}`}>
                <RfiCards rfis={filtered} {...listProps} />
              </div>
            </>
          )}

          {/* ── What this register is, and is not ────────────────────── */}
          <Card>
            <p className="text-[12.5px] font-bold text-brand-text m-0 mb-1.5">What this register is</p>
            <ul className="m-0 pl-4 text-[11.5px] text-brand-muted space-y-1">
              <li>
                <strong className="text-brand-text-soft">A record, not a channel.</strong> Nothing is emailed and
                nobody is notified — the assignee learns of an RFI only if you tell them. Answers are
                transcribed here from the correspondence.
              </li>
              <li>
                <strong className="text-brand-text-soft">Financially inert.</strong> Raising, answering or closing
                an RFI changes no budget, commitment, forecast, margin, cash-flow or variation figure. The
                optional cost code is a link for future analysis only.
              </li>
              <li>
                <strong className="text-brand-text-soft">Forward-only, no reopen.</strong> Once raised, the question
                and its reference are frozen; once answered, the answer is final. An unsatisfactory answer is
                closed with a note and a new RFI raised. An answered RFI cannot be cancelled.
              </li>
              <li>
                <strong className="text-brand-text-soft">Pinned to a drawing revision.</strong> A drawing reference
                names the exact revision the question was asked against — issuing a newer revision never moves it.
              </li>
              <li>
                Numbered from RFI-0001 per project. RFIs are cancelled, never deleted — and simultaneous edits
                by two people overwrite each other, so agree who is updating a draft.
              </li>
            </ul>
          </Card>
        </>
      )}

      {editing && (
        <RfiEditorModal
          rfi={editing === 'new' ? null : editing}
          contacts={contacts}
          costCodes={costCodes}
          projectId={projectId}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {viewingLive && (
        <RfiDetailModal
          rfi={viewingLive}
          now={now}
          currentUid={user?.uid}
          canWrite={canWrite}
          onEdit={openEditor}
          onRaise={handleRaise}
          onAnswer={openAnswer}
          onCloseRfi={openClose}
          onCancel={openCancel}
          onClose={() => setViewing(null)}
        />
      )}

      {answering && (
        <RfiAnswerModal rfi={answering} onAnswer={succeeds(answerRfi)} onClose={() => setAnswering(null)} />
      )}

      {closing && (
        <RfiCloseModal rfi={closing} onCloseRfi={succeeds(closeRfi)} onClose={() => setClosing(null)} />
      )}

      {cancelling && (
        <RfiCancelModal rfi={cancelling} onCancelRfi={succeeds(cancelRfi)} onClose={() => setCancelling(null)} />
      )}
    </div>
  )
}
