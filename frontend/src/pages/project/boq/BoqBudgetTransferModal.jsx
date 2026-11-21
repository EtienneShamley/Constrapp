import { useMemo, useState } from 'react'
import Btn from '../../../components/Btn'
import Badge from '../../../components/Badge'
import WriteFeedback from '../../../components/WriteFeedback'
import ActivityDialog from '../timeline/ActivityDialog'
import { useWriteAction } from '../../../hooks/useWriteAction'
import { formatCurrency } from '../../../lib/formatters'
import { WRITE_PHASE } from '../../../lib/writeOutcome'
import {
  TRANSFER_ROW_STATE, TRANSFER_ROW_STATE_LABELS, TRANSFER_BLOCKER_LABELS,
  buildTransferProposal, transferSummary, centsToAmount,
} from '../../../lib/boqBudgetTransfer'
import { BOQ_TRANSFER_ERROR, transferOutcomeText } from '../../../lib/boqBudgetTransferActions'

// ── Transfer the BOQ to the working budget — review, confirm, apply (ADR-81) ──
//
// The proposal is computed here from the registers the BOQ page already holds
// (live listeners), with lib/boqBudgetTransfer.js — the SAME module the
// trusted `transferBoqToBudget` callable runs on its own transactional reads.
// This dialog sends the proposal's reviewKey and the ticked set-to-zero cost
// codes, never an amount; if the server's recomputed key differs, it refuses
// and nothing is written.
//
// WHAT A TRANSFER TOUCHES: working budget lines only. An approved budget
// version is never changed here — it changes only through the existing SHIELD
// capture and approval on the Budget tab.
//
// OUTCOMES (lib/writeOutcome.js, the L3 convention): a result is shown only
// when the server answered. A typed refusal is shown as a failure with
// "nothing was written". A timeout or lost connection is UNCERTAIN: the
// dialog says so, keeps the request it sent, and a repeat sends that SAME
// request — the server applies it once only.

const thCls = 'text-left px-3 py-2 text-brand-muted text-[10.5px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const tdCls = 'px-3 py-2.5 text-[12.5px] text-brand-text align-top'
const hintCls = 'm-0 text-[11px] text-brand-muted'

const STATE_BADGE = {
  [TRANSFER_ROW_STATE.CREATE]:         'active',
  [TRANSFER_ROW_STATE.REFRESH]:        'info',
  [TRANSFER_ROW_STATE.UNCHANGED]:      'soon',
  [TRANSFER_ROW_STATE.ZERO_AVAILABLE]: 'pending',
  [TRANSFER_ROW_STATE.BLOCKED]:        'danger',
}

function Fact({ label, value }) {
  return (
    <div className="rounded-lg bg-brand-bg/60 px-3 py-2">
      <p className="m-0 text-[10px] font-bold uppercase tracking-[0.4px] text-brand-muted">{label}</p>
      <p className="m-0 mt-0.5 text-[15px] font-black tabular-nums text-brand-text">{value}</p>
    </div>
  )
}

export default function BoqBudgetTransferModal({
  boqItems, budgetLines, costCodes, currencyCode,
  sourcesLoading = false, sourcesError = false,
  budgetApproved = false, approvedCaption = '',
  onTransfer, onClose,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const cents = (c) => (c === null || c === undefined ? '—' : money(centsToAmount(c)))
  const write = useWriteAction('BOQ to budget transfer')

  const [zero, setZero] = useState(() => new Set())   // ticked set-to-zero cost codes — empty by default
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState(null)          // the server-confirmed outcome
  // The request last SENT whose outcome is not known. A repeat sends exactly
  // this — never a fresh proposal — so the server can recognise it.
  const [pending, setPending] = useState(null)

  const proposal = useMemo(
    () => buildTransferProposal({ boqItems, budgetLines, costCodes, currencyCode }),
    [boqItems, budgetLines, costCodes, currencyCode],
  )
  // A ticked code that has stopped being eligible is dropped from the request.
  const zeroChoices = useMemo(
    () => proposal.rows.filter(r => r.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE && zero.has(r.costCodeId)).map(r => r.costCodeId),
    [proposal, zero],
  )
  const summary = useMemo(() => transferSummary(proposal, zeroChoices), [proposal, zeroChoices])

  const ready = !sourcesLoading && !sourcesError
  const uncertain = write.phase === WRITE_PHASE.UNCERTAIN || write.phase === WRITE_PHASE.UNCONFIRMED
  const canSubmit = ready && !write.locked && (pending ? true : (summary.operationCount > 0 && confirmed))

  function toggleZero(costCodeId) {
    setResult(null)
    setConfirmed(false)
    setZero(prev => {
      const next = new Set(prev)
      if (next.has(costCodeId)) next.delete(costCodeId); else next.add(costCodeId)
      return next
    })
  }

  function submit(e) {
    e.preventDefault()
    if (!canSubmit) return
    const request = pending ?? { reviewKey: proposal.reviewKey, setToZero: zeroChoices }
    setPending(request)
    setResult(null)
    write.run(
      () => onTransfer(request).catch((err) => {
        // A certain refusal ends this request; only an uncertain one is kept.
        if (err?.kind !== BOQ_TRANSFER_ERROR.UNCERTAIN) setPending(null)
        throw err
      }),
      {
        onConfirmed: (res) => {
          setPending(null)
          setConfirmed(false)
          setZero(new Set())
          setResult(res)
        },
      },
    )
  }

  const outcome = result ? transferOutcomeText(result, money) : null
  const change = summary.afterCents - summary.beforeCents

  return (
    <ActivityDialog title="Transfer BOQ to working budget" titleId="boq-transfer-title" onClose={onClose} busy={write.busy} panelClassName="max-w-[860px]">
      <form onSubmit={submit} className="p-5">
        <p className="m-0 mb-3 text-[12px] text-brand-text-soft">
          Each cost code&apos;s priced BOQ total becomes <strong className="text-brand-text">one working budget line</strong>.
          Amounts are ex-GST and are calculated again on the server from the BOQ as it stands when you confirm — this
          screen sends no amount. A cost code is transferred only when every one of its active items is priced.
        </p>

        {budgetApproved ? (
          <div className="border border-brand-border rounded-lg p-3 mb-3">
            <p className="m-0 text-[12px] font-semibold text-brand-text">The Approved Budget does not change</p>
            <p className="m-0 mt-1 text-[11.5px] text-brand-muted">
              This project has an approved budget (version {approvedCaption}). A transfer changes working lines only; every
              report keeps using the approved amount. To publish these lines, prepare and approve a new version on the
              Budget tab. A new version replaces the current one and supersedes its approved adjustments, under the
              existing SHIELD review and acknowledgement.
            </p>
          </div>
        ) : (
          <p className={`${hintCls} mb-3`}>
            The result is a working (unapproved) budget. It becomes the Approved Budget only when a version is captured
            and approved on the Budget tab.
          </p>
        )}

        {sourcesLoading && <p className="m-0 mb-3 text-[12px] text-brand-muted">Loading the BOQ, budget lines and cost codes…</p>}
        {sourcesError && (
          <p className="m-0 mb-3 text-[12px] text-brand-red" role="alert">
            The BOQ, the budget lines or the cost codes could not be loaded, so no transfer can be reviewed. This is not
            an empty BOQ. Reload the page and try again.
          </p>
        )}

        {ready && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              <Fact label="To create" value={summary.createCount} />
              <Fact label="To refresh" value={summary.refreshCount + summary.zeroCount} />
              <Fact label="Unchanged" value={summary.unchangedCount} />
              <Fact label="Blocked" value={summary.blockedCount} />
            </div>
            {summary.operationCount > 0 && (
              <p className="m-0 mb-1 text-[12px] text-brand-text">
                Working budget on the {summary.operationCount} changing cost code{summary.operationCount === 1 ? '' : 's'}:{' '}
                <strong>{cents(summary.beforeCents)}</strong> → <strong>{cents(summary.afterCents)}</strong>
                {' '}({change >= 0 ? '+' : '−'}{money(centsToAmount(Math.abs(change)))})
              </p>
            )}
            {summary.blockedCount > 0 && (
              <p className={`${hintCls} mb-1`}>
                Not transferred: {summary.blockedCount} blocked cost code{summary.blockedCount === 1 ? '' : 's'}
                {summary.blockedBoqCents > 0 ? `, holding ${cents(summary.blockedBoqCents)} of priced BOQ value` : ''}
                {summary.blockedUnknownCount > 0 ? `; ${summary.blockedUnknownCount} cannot be valued until every item is priced and usable` : ''}.
              </p>
            )}

            {proposal.rows.length === 0 ? (
              <p className="m-0 mt-3 text-[12px] text-brand-muted">There are no active BOQ items to transfer.</p>
            ) : (
              <div className="overflow-x-auto border border-brand-border rounded-lg mt-3">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-brand-card border-b border-brand-border">
                      {['Cost code', 'BOQ (ex-GST)', 'Working budget now', 'After transfer', 'Action'].map(h => <th key={h} className={thCls}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.rows.map(row => {
                      const zeroTicked = zeroChoices.includes(row.costCodeId)
                      const after = row.state === TRANSFER_ROW_STATE.CREATE || row.state === TRANSFER_ROW_STATE.REFRESH
                        ? cents(row.boqCents)
                        : row.state === TRANSFER_ROW_STATE.BLOCKED
                          ? '—'
                          : zeroTicked ? cents(0) : cents(row.workingCents)
                      return (
                        <tr key={row.costCodeId} className="border-b border-brand-border last:border-b-0">
                          <td className={`${tdCls} font-semibold`}>
                            {row.costCodeName}
                            <span className="block text-[10.5px] font-normal text-brand-muted">
                              {row.itemCount === 0 ? 'No active BOQ items' : `${row.itemCount} active item${row.itemCount === 1 ? '' : 's'}`}
                              {row.unpricedCount > 0 ? ` · ${row.unpricedCount} unpriced` : ''}
                            </span>
                          </td>
                          <td className={`${tdCls} tabular-nums whitespace-nowrap`}>{row.itemCount === 0 ? '—' : cents(row.boqCents)}</td>
                          <td className={`${tdCls} tabular-nums whitespace-nowrap`}>{cents(row.workingCents)}</td>
                          <td className={`${tdCls} tabular-nums whitespace-nowrap font-semibold`}>{after}</td>
                          <td className={`${tdCls} min-w-[220px]`}>
                            <Badge sm variant={STATE_BADGE[row.state]} label={TRANSFER_ROW_STATE_LABELS[row.state]} />
                            {row.state === TRANSFER_ROW_STATE.BLOCKED && (
                              <ul className="m-0 mt-1 pl-4 text-[11px] text-brand-red space-y-0.5">
                                {row.blockers.map(b => <li key={b}>{TRANSFER_BLOCKER_LABELS[b] ?? b}</li>)}
                              </ul>
                            )}
                            {row.state === TRANSFER_ROW_STATE.REFRESH && row.manuallyChanged && (
                              <p className="m-0 mt-1 text-[11px] text-brand-amber">
                                This line was changed by hand after the last transfer
                                {row.latestTransferCents !== null ? ` (last transferred ${cents(row.latestTransferCents)})` : ''}.
                                Refreshing replaces it with the BOQ amount.
                              </p>
                            )}
                            {row.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE && (
                              <label className="flex items-start gap-2 mt-1.5 min-h-[44px] cursor-pointer text-[11.5px] text-brand-text">
                                <input
                                  type="checkbox"
                                  className="mt-0.5 w-4 h-4 accent-brand-accent"
                                  checked={zero.has(row.costCodeId)}
                                  disabled={write.locked || Boolean(pending)}
                                  onChange={() => toggleZero(row.costCodeId)}
                                />
                                <span>
                                  Set this line to zero
                                  <span className="block text-[10.5px] text-brand-muted">
                                    Every BOQ item transferred to this cost code is now void. Left unticked, the line stays at {cents(row.workingCents)}.
                                  </span>
                                </span>
                              </label>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── Server-confirmed outcome ───────────────────────────────── */}
        {outcome && (
          <div className="border border-brand-accent/40 rounded-lg p-3 mt-3" role="status" data-transfer-outcome={result.outcome}>
            <p className="m-0 text-[12.5px] font-bold text-brand-accent">{outcome.title}</p>
            <p className="m-0 mt-1 text-[11.5px] text-brand-text">{outcome.body}</p>
            <p className="m-0 mt-1 text-[11px] text-brand-muted">
              The list above now shows the current position. {budgetApproved
                ? 'The Approved Budget is unchanged.'
                : 'These are working lines — approve them on the Budget tab.'}
            </p>
          </div>
        )}

        {ready && !pending && summary.operationCount > 0 && (
          <label className="flex items-start gap-2 mt-4 min-h-[44px] cursor-pointer text-[12px] text-brand-text">
            <input
              type="checkbox"
              className="mt-0.5 w-4 h-4 accent-brand-accent"
              checked={confirmed}
              disabled={write.locked}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I have reviewed these {summary.operationCount} change{summary.operationCount === 1 ? '' : 's'} to the working budget
              {summary.zeroCount > 0 ? `, including ${summary.zeroCount} line${summary.zeroCount === 1 ? '' : 's'} set to zero` : ''}.
            </span>
          </label>
        )}

        <div className="mt-3">
          <WriteFeedback write={write} />
          {(uncertain || (pending && write.phase === WRITE_PHASE.IDLE)) && (
            <p className={`${hintCls} mt-1.5`}>
              Trying again sends the same reviewed transfer, not a new one. The server applies it once only: if it
              already went through and nothing has changed since, it answers &quot;already applied&quot; and writes nothing.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-brand-border">
          <Btn variant="ghost" type="button" onClick={onClose} disabled={write.busy}>{result || write.waiting ? 'Close' : 'Cancel'}</Btn>
          <Btn type="submit" disabled={!canSubmit}>
            {write.busy ? 'Transferring…' : write.waiting ? 'Waiting for confirmation…' : pending ? 'Send the same transfer again' : 'Apply transfer'}
          </Btn>
        </div>
      </form>
    </ActivityDialog>
  )
}
