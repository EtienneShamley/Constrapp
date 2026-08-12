import { useState, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../../components/Card'
import Badge from '../../components/Badge'
import Btn from '../../components/Btn'
import Stat from '../../components/Stat'
import { useProfile } from '../../hooks/useProfile'
import { useSupplierInvoices } from '../../hooks/useSupplierInvoices'
import { useRetentionReleases } from '../../hooks/useRetentionReleases'
import { formatCurrency } from '../../lib/formatters'
import { isFinancialRole } from '../../lib/margin'
import {
  RR_STATUS, RR_STATUS_LABELS, RR_BADGE_VARIANTS,
  retentionBySupplier, retentionSummary, retentionInvoiceRows,
  releaseExceptions, overReleasedRows, RELEASE_EXCEPTION_REMEDY,
  RETENTION_HELD_NOTICE, RETENTION_RELEASED_NOTICE,
  RETENTION_RELEASE_CONCURRENCY_NOTICE, RETENTION_PAID_NOTICE,
  postBlockedReason,
} from '../../lib/retention'
import { LEGACY_SUPPLIER_MATCH_NOTE } from '../../lib/supplierPayments'
import ReleaseModal from './retention/ReleaseModal'
import ReleaseVoidModal from './retention/ReleaseVoidModal'

// ── Supplier Retention register ──────────────────────────────────────────────
//
// Answers the two questions the commercial model could not answer before
// ADR-30: "how much retention are we holding, and on whom?" and "how does any
// of it ever become payable?"
//
// Everything on this page is DERIVED at read time from posted Supplier Invoices
// and posted Retention Releases. Nothing is written onto a supplier invoice:
// `retention`, `retentionGst`, and `retentionTotal` are immutable for the life
// of that document. The only thing this page authors is a Retention Release.
//
// ⚠️ RETENTION PAID IS NOT REPORTED. A payment settles a supplier invoice
// balance as ONE balance, and nothing identifies whether the money settled the
// original payable or released retention. Reporting a "retention paid" or
// "released but unpaid" figure would require inventing an allocation policy.
//
// ⚠️ A FAILED SUBSCRIPTION IS NEVER A ZERO. If releases cannot be read, every
// release-dependent figure renders "—" and all release actions are disabled —
// an empty list would silently overstate retention held and understate payables.

const thCls   = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px] whitespace-nowrap'
const thRight = `${thCls} text-right`
const tdCls   = 'px-3.5 py-2.5 text-[13px] text-brand-text whitespace-nowrap'
const tdMoney = 'px-3.5 py-2.5 text-[13px] tabular-nums text-right whitespace-nowrap'

export default function ProjectRetention() {
  const { projectId, currencyCode } = useOutletContext()
  const money = (n) => formatCurrency(n, currencyCode)
  const moneyExact = (n) => formatCurrency(n, currencyCode, { precise: true })

  const { profile, profileLoading } = useProfile()
  const canView = isFinancialRole(profile?.role)
  // Non-financial roles never trigger the commercially-sensitive reads (rules
  // would deny them anyway — this is the UX mirror; rules are the boundary).
  const mid = canView ? projectId : null

  const { supplierInvoices, supplierInvoicesLoading, supplierInvoicesError } = useSupplierInvoices(mid)
  const {
    retentionReleases, retentionReleasesLoading, retentionReleasesError,
    createRetentionRelease, updateRetentionRelease, postRetentionRelease, voidRetentionRelease,
  } = useRetentionReleases(mid)

  const [releaseFor, setReleaseFor] = useState(null) // { invoice, release? }
  const [voidTarget, setVoidTarget] = useState(null)
  const [actionError, setActionError] = useState(null)

  // ⚠️ THE HONESTY GATE. Release data missing means the released totals are
  // UNKNOWN, not zero. Every derived figure below is suppressed and every
  // action disabled while this is true.
  const releasesUnavailable = retentionReleasesError
  const invoicesUnavailable = supplierInvoicesError
  const figuresUnavailable  = releasesUnavailable || invoicesUnavailable

  const invoiceById = useMemo(
    () => new Map((supplierInvoices ?? []).map(inv => [inv.id, inv])),
    [supplierInvoices],
  )

  const groups = useMemo(
    () => (figuresUnavailable ? [] : retentionBySupplier(supplierInvoices, retentionReleases)),
    [figuresUnavailable, supplierInvoices, retentionReleases],
  )
  const summary = useMemo(
    () => (figuresUnavailable ? null : retentionSummary(supplierInvoices, retentionReleases)),
    [figuresUnavailable, supplierInvoices, retentionReleases],
  )
  const exceptions = useMemo(
    () => (figuresUnavailable ? [] : releaseExceptions(retentionReleases, supplierInvoices)),
    [figuresUnavailable, retentionReleases, supplierInvoices],
  )
  const overReleased = useMemo(
    () => (figuresUnavailable ? [] : overReleasedRows(retentionInvoiceRows(supplierInvoices, retentionReleases))),
    [figuresUnavailable, supplierInvoices, retentionReleases],
  )

  const sortedReleases = useMemo(
    () => [...(retentionReleases ?? [])].sort(
      (a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')
             || (b.releaseNumber || '').localeCompare(a.releaseNumber || ''),
    ),
    [retentionReleases],
  )

  const loading = profileLoading || supplierInvoicesLoading || retentionReleasesLoading

  if (!profileLoading && !canView) {
    return (
      <Card>
        <p className="m-0 text-[13px] text-brand-muted">
          Retention is restricted to Company Admin, Project Manager, and QS roles.
        </p>
      </Card>
    )
  }

  async function run(fn) {
    setActionError(null)
    try { await fn() } catch (err) { setActionError(err?.message || 'Action failed.') }
  }

  const dash = (value) => (figuresUnavailable ? '—' : value)

  return (
    <div className="space-y-4">
      {/* ── Summary ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <Stat
            label="Retention Held"
            value={dash(money(summary?.retentionHeld))}
            sub="Withheld, not released — not payable"
            accent
          />
        </Card>
        <Card>
          <Stat
            label="Released to Date"
            value={dash(money(summary?.releasedToDate))}
            sub="Cumulative — not an outstanding balance"
          />
        </Card>
        <Card>
          <Stat
            label="Total Withheld to Date"
            value={dash(money(summary?.totalWithheld))}
            sub={dash(`${summary?.invoiceCount ?? 0} invoice${summary?.invoiceCount === 1 ? '' : 's'}`)}
          />
        </Card>
        <Card>
          <Stat
            label="Suppliers"
            value={dash(String(summary?.supplierCount ?? 0))}
            sub="Holding retention on this project"
          />
        </Card>
      </div>

      {/* ── Unavailability, honestly ────────────────────────────────────────── */}
      {figuresUnavailable && (
        <Card>
          <p className="m-0 text-[12.5px] font-bold text-brand-red">Retention figures are unavailable</p>
          <ul className="m-0 mt-2 pl-4 text-[12px] text-brand-muted list-disc space-y-1">
            {invoicesUnavailable && <li>Supplier Invoices could not be read — retention withheld is unknown.</li>}
            {releasesUnavailable && <li>Retention Releases could not be read — released amounts are unknown.</li>}
          </ul>
          <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
            These figures are shown as “—” rather than zero, and releasing is disabled: treating missing release
            data as “nothing released” would overstate retention held and understate what is payable.
          </p>
        </Card>
      )}

      {actionError && (
        <Card><p className="m-0 text-[12.5px] text-brand-red">{actionError}</p></Card>
      )}

      {/* ── Exceptions ──────────────────────────────────────────────────────── */}
      {exceptions.length > 0 && (
        <Card>
          <p className="m-0 text-[12.5px] font-bold text-brand-amber">
            {exceptions.length} retention release{exceptions.length === 1 ? '' : 's'} need{exceptions.length === 1 ? 's' : ''} attention
          </p>
          <div className="mt-2 space-y-1.5">
            {exceptions.map(ex => (
              <p key={ex.releaseId} className="m-0 text-[12px] text-brand-muted">
                <span className="font-semibold text-brand-text">{ex.releaseNumber}</span>
                {' · '}{moneyExact(ex.releaseTotal)}{' — '}{ex.reason}
              </p>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11.5px] text-brand-muted">{RELEASE_EXCEPTION_REMEDY}</p>
        </Card>
      )}

      {overReleased.length > 0 && (
        <Card>
          <p className="m-0 text-[12.5px] font-bold text-brand-red">
            {overReleased.length} invoice{overReleased.length === 1 ? '' : 's'} released beyond the retention withheld
          </p>
          <div className="mt-2 space-y-1.5">
            {overReleased.map(r => (
              <p key={r.id} className="m-0 text-[12px] text-brand-muted">
                <span className="font-semibold text-brand-text">{r.invoiceNumber}</span>
                {' — withheld '}{moneyExact(r.retentionTotal)}{', released '}{moneyExact(r.releasedTotal)}
              </p>
            ))}
          </div>
          <p className="m-0 mt-2 text-[11.5px] text-brand-muted">
            Constrapp blocks this in the app, so it indicates concurrent releasing or a direct SDK write.
            Void the release that should not stand — nothing is reversed automatically.
          </p>
        </Card>
      )}

      {/* ── Register by supplier ────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-brand-border">
          <h2 className="text-[14px] font-bold text-brand-text m-0">Retention by supplier</h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            Derived from posted supplier invoices and posted retention releases. Nothing is written onto an invoice.
          </p>
        </div>

        {loading ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Loading…</p>
        ) : figuresUnavailable ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Unavailable — see above.</p>
        ) : groups.length === 0 ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">
            No retention is held on this project. Retention appears here once a supplier invoice that withholds
            retention is posted.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[880px]">
              <thead>
                <tr className="border-b border-brand-border">
                  <th className={thCls}>Supplier</th>
                  <th className={thRight}>Invoices</th>
                  <th className={thRight}>Total Withheld</th>
                  <th className={thRight}>Released</th>
                  <th className={thRight}>Held</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {groups.map(group => (
                  <SupplierGroup
                    key={group.key}
                    group={group}
                    money={money}
                    moneyExact={moneyExact}
                    onRelease={(row) => setReleaseFor({ invoice: invoiceById.get(row.id) })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Release register ────────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="px-5 py-4 border-b border-brand-border">
          <h2 className="text-[14px] font-bold text-brand-text m-0">Retention releases</h2>
          <p className="m-0 mt-0.5 text-[11.5px] text-brand-muted">
            An internal commercial authorisation that makes withheld retention payable. Not a supplier invoice,
            tax invoice, credit note, or payment — and not a cash movement.
          </p>
        </div>

        {releasesUnavailable ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">Unavailable — retention releases could not be read.</p>
        ) : sortedReleases.length === 0 ? (
          <p className="px-5 py-6 m-0 text-[13px] text-brand-muted">
            No retention has been released yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse min-w-[980px]">
              <thead>
                <tr className="border-b border-brand-border">
                  <th className={thCls}>RR #</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Release Date</th>
                  <th className={thCls}>Invoice</th>
                  <th className={thCls}>Supplier</th>
                  <th className={thRight}>Amount (ex-GST)</th>
                  <th className={thRight}>GST</th>
                  <th className={thRight}>Total</th>
                  <th className={thCls}>Reason</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {sortedReleases.map(r => {
                  const isDraft = r.status === RR_STATUS.DRAFT
                  const isVoid  = r.status === RR_STATUS.VOID
                  const blocked = isDraft
                    ? postBlockedReason(r, supplierInvoices, retentionReleases)
                    : null
                  return (
                    <tr key={r.id} className="border-b border-brand-border hover:bg-brand-card transition-colors">
                      <td className={`${tdCls} font-semibold`}>{r.releaseNumber}</td>
                      <td className={tdCls}>
                        <Badge label={RR_STATUS_LABELS[r.status] ?? r.status} variant={RR_BADGE_VARIANTS[r.status]} sm />
                      </td>
                      <td className={tdCls}>{r.releaseDate || '—'}</td>
                      <td className={tdCls}>
                        {r.invoiceNumber}
                        {r.supplierInvoiceNumber ? <span className="text-brand-muted"> · {r.supplierInvoiceNumber}</span> : null}
                      </td>
                      <td className={tdCls}>{r.supplierName || '—'}</td>
                      <td className={tdMoney}>{moneyExact(r.amount)}</td>
                      <td className={`${tdMoney} text-brand-muted`}>{moneyExact(r.gstAmount)}</td>
                      <td className={`${tdMoney} font-semibold`}>{moneyExact(r.releaseTotal)}</td>
                      <td className={`${tdCls} max-w-[220px] truncate`} title={r.reason}>{r.reason || '—'}</td>
                      <td className="px-3.5 py-2.5 whitespace-nowrap">
                        {!isVoid && (
                          <div className="flex items-center gap-1.5 justify-end">
                            {isDraft && (
                              <>
                                <Btn
                                  sm variant="ghost"
                                  disabled={releasesUnavailable}
                                  onClick={() => setReleaseFor({
                                    invoice: invoiceById.get(r.supplierInvoiceId), release: r,
                                  })}
                                >
                                  Edit
                                </Btn>
                                <Btn
                                  sm variant="success"
                                  disabled={releasesUnavailable || !!blocked}
                                  title={blocked || 'Make this retention payable'}
                                  onClick={() => run(() => postRetentionRelease(r, { invoices: supplierInvoices }))}
                                >
                                  Post
                                </Btn>
                              </>
                            )}
                            <Btn sm variant="ghost" onClick={() => setVoidTarget(r)}>Void</Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-5 py-4 border-t border-brand-border space-y-1.5">
          <p className="m-0 text-[11.5px] text-brand-muted">{RETENTION_HELD_NOTICE}</p>
          <p className="m-0 text-[11.5px] text-brand-muted">{RETENTION_RELEASED_NOTICE}</p>
          <p className="m-0 text-[11.5px] text-brand-muted">{RETENTION_PAID_NOTICE}</p>
          <p className="m-0 text-[11.5px] text-brand-muted">{RETENTION_RELEASE_CONCURRENCY_NOTICE}</p>
          <p className="m-0 text-[11.5px] text-brand-muted">
            Released retention has no due date of its own, so it ages from the original invoice due date in AP
            ageing — normally the oldest bucket. Retention due dates and defects-liability dates are not modelled.
          </p>
        </div>
      </Card>

      {releaseFor?.invoice && (
        <ReleaseModal
          invoice={releaseFor.invoice}
          release={releaseFor.release ?? null}
          releases={retentionReleases}
          currencyCode={currencyCode}
          onClose={() => setReleaseFor(null)}
          onSave={async (input) => {
            if (releaseFor.release) {
              await updateRetentionRelease(releaseFor.release, { ...input, invoice: releaseFor.invoice })
            } else {
              await createRetentionRelease(input)
            }
          }}
        />
      )}

      {voidTarget && (
        <ReleaseVoidModal
          release={voidTarget}
          currencyCode={currencyCode}
          onClose={() => setVoidTarget(null)}
          onConfirm={(reason) => voidRetentionRelease(voidTarget, reason)}
        />
      )}
    </div>
  )
}

// One supplier group, expandable to its retention-holding invoices.
function SupplierGroup({ group, money, moneyExact, onRelease }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <tr className="border-b border-brand-border hover:bg-brand-card transition-colors">
        <td className={tdCls}>
          <button
            onClick={() => setOpen(o => !o)}
            className="inline-flex items-center gap-2 cursor-pointer text-brand-text hover:text-brand-accent min-h-[32px]"
          >
            <span className="text-brand-muted text-[11px] w-3 inline-block">{open ? '▾' : '▸'}</span>
            <span className="font-semibold">{group.supplierName || '—'}</span>
          </button>
          {group.legacyNameMatch && (
            <p className="m-0 mt-0.5 ml-5 text-[10.5px] text-brand-muted">{LEGACY_SUPPLIER_MATCH_NOTE}</p>
          )}
        </td>
        <td className={`${tdMoney} text-brand-muted`}>{group.invoiceCount}</td>
        <td className={tdMoney}>{money(group.retentionTotal)}</td>
        <td className={`${tdMoney} text-brand-muted`}>{group.releasedTotal ? money(group.releasedTotal) : '—'}</td>
        <td className={`${tdMoney} font-semibold`}>{money(group.retentionHeld)}</td>
        <td className={tdCls} />
      </tr>

      {open && group.rows.map(row => (
        <tr key={row.id} className="border-b border-brand-border bg-brand-bg/40">
          <td className={`${tdCls} pl-10`}>
            <span className="font-semibold">{row.invoiceNumber}</span>
            {row.supplierInvoiceNumber ? <span className="text-brand-muted"> · {row.supplierInvoiceNumber}</span> : null}
            <span className="text-brand-muted"> · {row.invoiceDate || '—'}</span>
          </td>
          <td className={`${tdMoney} text-brand-muted text-[12px]`}>
            {moneyExact(row.retention)} + {moneyExact(row.retentionGst)}
          </td>
          <td className={tdMoney}>{moneyExact(row.retentionTotal)}</td>
          <td className={`${tdMoney} text-brand-muted`}>{row.releasedTotal ? moneyExact(row.releasedTotal) : '—'}</td>
          <td className={`${tdMoney} font-semibold`}>{moneyExact(row.retentionHeld)}</td>
          <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
            <Btn
              sm variant="ghost"
              disabled={row.remainingRetentionExGst <= 0}
              title={row.remainingRetentionExGst <= 0 ? 'All retention on this invoice has been released' : 'Release retention'}
              onClick={() => onRelease(row)}
            >
              Release
            </Btn>
          </td>
        </tr>
      ))}
    </>
  )
}
