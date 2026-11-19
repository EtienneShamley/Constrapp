import { csvRows, csvMoney, filenameSlug } from './csv'
import {
  FINAL_ACCOUNT_STATUS, FINAL_ACCOUNT_FIGURES, FIGURE_BASIS, FIGURE_GROUP_LABELS, FINAL_ACCOUNT_DISCLAIMER,
} from './finalAccount'
import { figurePresentation, FIGURE_VIEW } from './finalAccountDisplay'

// ── Final Account → CSV (pure; APPROVED revisions only) ──────────────────────
//
// Serialises ONE approved revision exactly as stored — the frozen figures and
// rows, never a live recomputation and never a raw source record. A draft or
// withdrawn revision is REFUSED: an unapproved Final Account must not leave
// the app looking like a finalised financial document. Text goes through
// lib/csv.js (formula-injection protection); money is a 2-decimal number.

const iso = (t) => {
  if (!t) return ''
  const d = typeof t.toDate === 'function' ? t.toDate() : (t instanceof Date ? t : null)
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''
}

export const BASIS_LABEL = {
  [FIGURE_BASIS.EX_GST]:  'ex-GST',
  [FIGURE_BASIS.GROSS]:   'gross (incl. GST)',
  [FIGURE_BASIS.PERCENT]: '%',
}

export function finalAccountFilename(account, projectName) {
  const slug = filenameSlug(projectName, 'project')
  return `constrap-final-account-${slug}-revision-${account?.number ?? 0}.csv`
}

const amount = (v) => (v === null || v === undefined ? 'NOT CALCULABLE' : (csvMoney(v) ?? 'NOT CALCULABLE'))
const budgetCell = (v) => (v === null || v === undefined ? 'NO BUDGET LINE' : (csvMoney(v) ?? 'NO BUDGET LINE'))

export function finalAccountCsv(account, { projectName = '', superseded = false } = {}) {
  if (!account || account.status !== FINAL_ACCOUNT_STATUS.APPROVED) {
    throw new Error('Only an approved Final Account revision can be exported.')
  }
  const ccy = account.currency
  const f = account.figures ?? {}
  const rows = [
    ['Constrap Final Account'],
    ['Project', projectName],
    ['Revision', account.number, superseded ? 'SUPERSEDED by a later approved revision' : 'Current approved revision'],
    ['Currency', ccy],
    ['Status', 'APPROVED (internal)'],
    ['Approved', iso(account.approvedAt)],
    ['Approved by', account.approvedByName || 'Name not recorded', account.selfApproved ? 'Also prepared this revision (self-approval)' : ''],
    ['Prepared by', account.preparedByName || 'Name not recorded'],
    ['Records read', iso(account.sourcesReadAt), 'The figures are the project records as read at this time. They are not recalculated.'],
    ['Budget source', account.sources?.budgetCaption ?? ''],
    ['Basis', account.reason ?? ''],
    ['Reference', account.reference ?? ''],
    ['Disclaimer', FINAL_ACCOUNT_DISCLAIMER],
    ['Amounts', `${ccy}. Ex-GST and gross figures are listed separately and are never added together. GST is the Australian 10% model only.`],
    [],
    ['Section', 'Figure', 'Value', 'Unit', 'Basis', 'Notes'],
    ...FINAL_ACCOUNT_FIGURES.map(def => ({ def, text: figurePresentation(def, FIGURE_VIEW.REVISION) })).map(({ def, text }) => [
      FIGURE_GROUP_LABELS[def.group],
      text.label,
      amount(f[def.key]),
      def.basis === FIGURE_BASIS.PERCENT ? '%' : ccy,
      BASIS_LABEL[def.basis],
      [def.open ? 'OUTSTANDING BALANCE — acknowledged at approval' : '', text.note].filter(Boolean).join('; '),
    ]),
    [],
    ['Cost code breakdown (ex-GST)'],
    ['Cost code', `Approved budget (${ccy})`, `Actual cost (${ccy})`, `Variance to budget (${ccy})`],
    ...(account.rows ?? []).map(r => [r.costCodeName, budgetCell(r.approvedBudget), amount(r.actualCost), budgetCell(r.variance)]),
  ]
  if ((account.rows ?? []).length === 0) rows.push(['No cost codes'])
  return csvRows(rows)
}
