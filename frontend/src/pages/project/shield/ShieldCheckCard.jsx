import { useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../../../components/Card'
import Badge from '../../../components/Badge'
import { formatCurrency } from '../../../lib/formatters'
import { formatIsoDate } from '../../../lib/projectTimeline'
import { SHIELD_STATE, SHIELD_SOURCE_LABELS, COLUMN, CHECK } from '../../../lib/shield'

// ── SHIELD · one check card (ADR-50) ─────────────────────────────────────────
//
// PRESENTATION ONLY. Everything shown here — state, headline, explanation,
// values, evidence rows and caveats — is the lib/shield.js evaluation carried
// through unchanged. This file formats; it never compares, sums or decides.
// Money is formatted with the project's resolved currency, dates with the
// Timeline's date-only formatter, and a loading figure is "—".
//
// Deliberately its own component: the PULSE IndicatorCard carries PULSE's
// value rows and acknowledgement panel, and ADR-50 does not refactor it.

const STATE_BADGE = {
  [SHIELD_STATE.FINDING]:     { label: 'Finding',        variant: 'danger' },
  [SHIELD_STATE.NEEDS_DATA]:  { label: 'Needs data',     variant: 'info' },
  [SHIELD_STATE.UNAVAILABLE]: { label: 'Unavailable',    variant: 'pending' },
  [SHIELD_STATE.NO_ISSUE]:    { label: 'No issue found', variant: 'active' },
  [SHIELD_STATE.LOADING]:     { label: 'Loading',        variant: 'soon' },
}

// The key figures each check shows above its evidence — engine counts and
// selector outputs named by the engine; the list only decides which to print.
const VALUE_ROWS = {
  [CHECK.DUPLICATE_INVOICE_REFERENCES]: [
    { key: 'groupCount',          label: 'Reference groups',    kind: COLUMN.INT },
    { key: 'invoiceCount',        label: 'Invoices in groups',  kind: COLUMN.INT },
    { key: 'assessedCount',       label: 'Invoices compared',   kind: COLUMN.INT },
    { key: 'blankReferenceCount', label: 'No supplier ref',     kind: COLUMN.INT },
  ],
  [CHECK.INVOICE_INTEGRITY]: [
    { key: 'assessedCount',        label: 'Posted invoices',     kind: COLUMN.INT },
    { key: 'mismatchCount',        label: 'Totals differ',       kind: COLUMN.INT },
    { key: 'missingCostCodeCount', label: 'Line without code',   kind: COLUMN.INT },
    { key: 'malformedCount',       label: 'Not verifiable',      kind: COLUMN.INT },
  ],
  [CHECK.PO_OVER_INVOICING]: [
    { key: 'poCount',         label: 'POs over-invoiced',       kind: COLUMN.INT },
    { key: 'invoicedPoCount', label: 'POs with posted invoices', kind: COLUMN.INT },
    { key: 'lineExcessTotal', label: 'Line excess (ex-GST)',    kind: COLUMN.MONEY },
    { key: 'poExcessTotal',   label: 'PO-level excess (ex-GST)', kind: COLUMN.MONEY },
  ],
  [CHECK.COMMITMENT_STATE_CONFLICTS]: [
    { key: 'conflictCount', label: 'Records to reconcile', kind: COLUMN.INT },
    { key: 'poCount',       label: 'Purchase orders',      kind: COLUMN.INT },
    { key: 'claimCount',    label: 'Claims',               kind: COLUMN.INT },
    { key: 'invoiceCount',  label: 'Supplier invoices',    kind: COLUMN.INT },
  ],
  [CHECK.FINANCIAL_EXCEPTIONS]: [
    { key: 'exceptionCount',      label: 'Exceptions',               kind: COLUMN.INT },
    { key: 'postedInvoiceCount',  label: 'Posted invoices',          kind: COLUMN.INT },
    { key: 'postedPaymentCount',  label: 'Posted payments',          kind: COLUMN.INT },
    { key: 'overReconciledTotal', label: 'Over-reconciled (gross)',  kind: COLUMN.MONEY },
  ],
}

const EVIDENCE_PREVIEW = 5

function formatValue(value, kind, currencyCode) {
  if (value === null || value === undefined || value === '') return '—'
  switch (kind) {
    case COLUMN.MONEY: return formatCurrency(value, currencyCode, { precise: true })
    case COLUMN.DATE:  return formatIsoDate(value)
    case COLUMN.INT:   return String(value)
    default:           return String(value)
  }
}

const failedLabel = (failedSources) =>
  (failedSources ?? []).map(s => SHIELD_SOURCE_LABELS[s] ?? s).join(', ')

const isNumericKind = (kind) => kind === COLUMN.MONEY || kind === COLUMN.INT

function Values({ check, currencyCode }) {
  const rows = VALUE_ROWS[check.id] ?? []
  const shown = rows.filter(r => check.values?.[r.key] !== undefined)
  if (shown.length === 0) return null
  return (
    <dl className="m-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
      {shown.map(r => (
        <div key={r.key} className="min-w-0">
          <dt className="m-0 text-[10.5px] font-bold uppercase tracking-[0.4px] text-brand-muted">{r.label}</dt>
          <dd className="m-0 mt-0.5 text-[15px] font-bold tabular-nums text-brand-text">
            {formatValue(check.values[r.key], r.kind, currencyCode)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Evidence({ check, currencyCode }) {
  const [showAll, setShowAll] = useState(false)
  const rows = check.evidence ?? []
  const cols = check.evidenceColumns ?? []
  if (rows.length === 0 || cols.length === 0) return null
  const visible = showAll ? rows : rows.slice(0, EVIDENCE_PREVIEW)

  return (
    <div className="mt-3">
      <p className="m-0 mb-1.5 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted">
        Source records · {rows.length}
      </p>
      {/* The scroller wraps the table so the Card's overflow-hidden clips
          nothing at a narrow width (betaSurfaces convention). */}
      <div className="overflow-x-auto rounded-lg border border-brand-border">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="bg-brand-bg/60">
              {cols.map(c => (
                <th key={c.key} scope="col" className={`px-3 py-2 text-[11px] font-bold uppercase tracking-[0.4px] text-brand-muted whitespace-nowrap ${isNumericKind(c.kind) ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={row.id ?? i} className="border-t border-brand-border">
                {cols.map(c => {
                  const v = row[c.key]
                  const numeric = isNumericKind(c.kind)
                  // Only money that means "over" or "excess" is coloured: an
                  // excess, a difference, or a negative remaining balance.
                  const danger = c.kind === COLUMN.MONEY && typeof v === 'number'
                    && ((c.key === 'excess' || c.key === 'difference') ? v !== 0 : (c.key === 'amount' && v < 0))
                  const wrap = c.key === 'reason' || c.key === 'description' || c.key === 'detail'
                  return (
                    <td key={c.key} className={`px-3 py-2 text-[12.5px] align-top ${wrap ? 'min-w-[220px]' : 'whitespace-nowrap'} ${numeric ? 'text-right tabular-nums' : 'text-left'} ${danger ? 'text-brand-red' : 'text-brand-text'}`}>
                      {formatValue(v, c.kind, currencyCode)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > EVIDENCE_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll(s => !s)}
          className="mt-1 inline-flex min-h-[44px] items-center text-[12px] font-semibold text-brand-accent hover:underline focus-visible:outline-2 focus-visible:outline-brand-accent"
        >
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

export default function ShieldCheckCard({ check, projectId, currencyCode }) {
  const badge = STATE_BADGE[check.state] ?? STATE_BADGE[SHIELD_STATE.LOADING]
  const unavailable = check.state === SHIELD_STATE.UNAVAILABLE
  const loading = check.state === SHIELD_STATE.LOADING
  const links = check.links ?? []

  return (
    <Card className="mb-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[14px] font-bold text-brand-text">{check.title}</h3>
            <Badge label={badge.label} variant={badge.variant} sm />
          </div>
          {loading && <p className="m-0 mt-1 text-[12.5px] text-brand-muted">Waiting for records…</p>}
          {unavailable && (
            <p className="m-0 mt-1 text-[12.5px] text-brand-amber">
              Could not load: {failedLabel(check.failedSources)}. This check was not assessed.
            </p>
          )}
          {!loading && !unavailable && (
            <>
              <p className="m-0 mt-1 text-[13px] font-semibold text-brand-text">{check.headline}</p>
              {check.explanation && (
                <p className="m-0 mt-1 text-[12px] text-brand-text-soft">{check.explanation}</p>
              )}
            </>
          )}
        </div>
        {links.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {links.map(link => (
              <Link
                key={link.to}
                to={`/projects/${projectId}/${link.to}`}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-brand-border px-3 text-[12px] font-semibold text-brand-accent hover:bg-brand-card focus-visible:outline-2 focus-visible:outline-brand-accent"
              >
                {link.label} →
              </Link>
            ))}
          </div>
        )}
      </div>

      {!loading && !unavailable && (
        <>
          <Values check={check} currencyCode={currencyCode} />
          <Evidence check={check} currencyCode={currencyCode} />
          {(check.caveats ?? []).length > 0 && (
            <ul className="m-0 mt-3 list-disc space-y-1 pl-4">
              {check.caveats.map((c, i) => (
                <li key={i} className="text-[11.5px] text-brand-muted">{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
