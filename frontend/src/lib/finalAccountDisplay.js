import { formatCurrency, percent } from './formatters'
import { FIGURE_BASIS } from './finalAccount'

// The text ONE Final Account figure renders as (ADR-24 display states):
// loading "—"; a missing amount "Unavailable" — never a zero; a figure that
// legitimately cannot be calculated (margin on non-positive revenue) "Not
// calculable"; a genuine zero a formatted zero. Formatting only.
export function figureText(value, basis, currencyCode, { nullable = false, pending = false } = {}) {
  if (pending) return '—'
  if (value === null || value === undefined) return nullable ? 'Not calculable' : 'Unavailable'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable'
  return basis === FIGURE_BASIS.PERCENT ? percent(value) : formatCurrency(value, currencyCode, { precise: true })
}
