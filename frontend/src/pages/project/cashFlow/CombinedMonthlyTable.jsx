import { useState } from 'react'
import Card from '../../../components/Card'
import { formatCurrency } from '../../../lib/formatters'
import { monthLabel, monthKeyFromDate } from '../../../lib/cashFlow'

// ── Combined monthly table (actual + forecast) with month drill-down ─────────
//
// Presentation only — every figure arrives pre-derived from lib/cashFlow.js.
// Past months render forecast cells as "—" (not applicable — the boundary rule
// makes their forecast structurally zero), never a fabricated $0 forecast.
// When a forecast source failed, forecast-bearing cells render "—" as well:
// unavailable is never presented as zero.

const thCls   = 'text-left px-3.5 py-[10px] text-brand-muted text-[11px] font-bold uppercase tracking-[0.4px]'
const tdMoney = 'px-3.5 py-2.5 text-[12.5px] tabular-nums text-right'
const labelCls = 'block text-[11px] font-bold text-brand-muted uppercase tracking-[0.4px] mb-1'

export default function CombinedMonthlyTable({
  combinedRows, forecastUnavailable, nowMonth, currencyCode,
  inRows, outRows, arRows, apRows, activeLines,
}) {
  const money = (n) => formatCurrency(n, currencyCode)
  const [expandedMonth, setExpandedMonth] = useState(null)

  const monthDetail = (monthKey) => ({
    receipts: inRows.filter(r => monthKeyFromDate(r.receiptDate) === monthKey),
    payments: outRows.filter(p => monthKeyFromDate(p.paymentDate) === monthKey),
    arDue: monthKey >= nowMonth
      ? arRows.filter(r => r.remaining > 0 && monthKeyFromDate(r.dueDate) === monthKey) : [],
    apDue: monthKey >= nowMonth
      ? apRows.filter(r => r.remaining > 0 && monthKeyFromDate(r.dueDate) === monthKey) : [],
    lines: monthKey >= nowMonth
      ? activeLines.filter(l => l.monthKey === monthKey) : [],
  })

  return (
    <Card padding={false} className="mb-3.5">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse">
          <thead>
            <tr className="bg-brand-card">
              <th className={thCls}>Month</th>
              <th className={`${thCls} text-right`}>Actual In</th>
              <th className={`${thCls} text-right`}>Actual Out</th>
              <th className={`${thCls} text-right`}>Forecast In</th>
              <th className={`${thCls} text-right`}>Forecast Out</th>
              <th className={`${thCls} text-right`}>Total In</th>
              <th className={`${thCls} text-right`}>Total Out</th>
              <th className={`${thCls} text-right`}>Net</th>
              <th className={`${thCls} text-right`}>Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {combinedRows.map((row) => {
              const detail = expandedMonth === row.monthKey ? monthDetail(row.monthKey) : null
              // A future/current cell whose forecast source failed is "—".
              const na = forecastUnavailable && !row.isPast
              return [
                <tr
                  key={row.monthKey}
                  className="border-b border-brand-border hover:bg-brand-card cursor-pointer"
                  onClick={() => setExpandedMonth(expandedMonth === row.monthKey ? null : row.monthKey)}
                >
                  <td className="px-3.5 py-2.5 text-[12.5px] text-brand-text whitespace-nowrap">
                    {monthLabel(row.monthKey)}
                    {row.isCurrent && <span className="ml-2 text-[10.5px] font-semibold text-brand-accent">Current</span>}
                  </td>
                  <td className={`${tdMoney} text-brand-text`}>{money(row.actualCashIn)}</td>
                  <td className={`${tdMoney} text-brand-text`}>{money(row.actualCashOut)}</td>
                  <td className={`${tdMoney} text-brand-text-soft`}>{row.isPast || na ? '—' : money(row.forecastCashIn)}</td>
                  <td className={`${tdMoney} text-brand-text-soft`}>{row.isPast || na ? '—' : money(row.forecastCashOut)}</td>
                  <td className={`${tdMoney} text-brand-text`}>{na ? '—' : money(row.totalCashIn)}</td>
                  <td className={`${tdMoney} text-brand-text`}>{na ? '—' : money(row.totalCashOut)}</td>
                  <td className={`${tdMoney} ${row.net < 0 ? 'text-brand-red' : 'text-brand-text'}`}>{na ? '—' : money(row.net)}</td>
                  <td className={`${tdMoney} font-semibold ${row.cumulativePosition < 0 ? 'text-brand-red' : 'text-brand-text'}`}>{na ? '—' : money(row.cumulativePosition)}</td>
                </tr>,
                detail && (
                  <tr key={`${row.monthKey}-detail`} className="border-b border-brand-border bg-brand-bg/50">
                    <td colSpan={9} className="px-5 py-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div>
                          <p className={labelCls}>Actual transactions</p>
                          {detail.receipts.length === 0 && detail.payments.length === 0 && (
                            <p className="m-0 text-[11.5px] text-brand-muted">None</p>
                          )}
                          {detail.receipts.map(r => (
                            <p key={r.receiptId} className="m-0 text-[11.5px] text-brand-text">
                              {r.receiptNumber} · {r.clientName} · <span className="tabular-nums">{money(r.amount)}</span> in
                            </p>
                          ))}
                          {detail.payments.map(p => (
                            <p key={p.paymentId} className="m-0 text-[11.5px] text-brand-text">
                              {p.paymentNumber} · {p.supplierName} · <span className="tabular-nums">{money(p.amount)}</span> out
                            </p>
                          ))}
                        </div>
                        <div>
                          <p className={labelCls}>Invoice balances due</p>
                          {detail.arDue.length === 0 && detail.apDue.length === 0 && (
                            <p className="m-0 text-[11.5px] text-brand-muted">{row.isPast ? 'Past month — actual only' : 'None'}</p>
                          )}
                          {detail.arDue.map(r => (
                            <p key={r.id} className="m-0 text-[11.5px] text-brand-text">
                              {r.invoiceNumber} · <span className="tabular-nums">{money(r.remaining)}</span> expected in
                            </p>
                          ))}
                          {detail.apDue.map(r => (
                            <p key={r.id} className="m-0 text-[11.5px] text-brand-text">
                              {r.invoiceNumber} · <span className="tabular-nums">{money(r.remaining)}</span> payable out
                            </p>
                          ))}
                        </div>
                        <div>
                          <p className={labelCls}>Manual timing lines</p>
                          {detail.lines.length === 0 && (
                            <p className="m-0 text-[11.5px] text-brand-muted">{row.isPast ? 'Past month — actual only' : 'None'}</p>
                          )}
                          {detail.lines.map(l => (
                            <p key={l.id} className="m-0 text-[11.5px] text-brand-text">
                              {l.description} · <span className="tabular-nums">{money(l.amount)}</span> {l.direction}
                            </p>
                          ))}
                        </div>
                      </div>
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      </div>
      <div className="px-3.5 py-3 border-t border-brand-border">
        <p className="m-0 text-[11px] text-brand-muted">
          Cash is grouped by the date money moved — Receipt Date drives Cash In and Payment Date drives
          Cash Out. Forecast amounts land in the current month or later only; past months are actual-only.
          Click a month for its breakdown.
        </p>
        <p className="m-0 mt-1 text-[11px] text-brand-muted">
          Cumulative net cash movement on this project. Not a bank balance. Constrapp does not model a bank
          account, an opening cash position or project financing. This shows cash recorded into and out of this
          project only.
        </p>
      </div>
    </Card>
  )
}
