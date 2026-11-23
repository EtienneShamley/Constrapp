// ⚠️ Photos is DELIBERATELY ABSENT.
//
// It is an unimplemented placeholder screen. Its route and `ProjectPlaceholder`
// page remain in App.jsx — typing the URL still renders it — but a
// private-beta user must not be offered a tab that leads nowhere. Re-add the
// entry here when the module ships; do not delete the route. (Reports shipped
// as the L2-A Commercial Report and is a tab again.)
export const PROJECT_TABS = [
  { to: 'overview',         label: 'Overview' },
  // PULSE™ 1A (ADR-47): deterministic project health indicators over the
  // project's own records — read-only, financial roles. The hidden top-level
  // /pulse route remains a pointer only. `mark` shows the static PULSE line
  // mark beside the compact label (ADR-48) — no animation in the tab bar.
  { to: 'pulse',            label: 'PULSE', mark: 'pulse' },
  // SHIELD™ foundation (ADR-50): five deterministic commercial assurance checks
  // over the project's own commitment and payables records — read-only,
  // financial roles. The hidden top-level /shield route remains a pointer only.
  // `mark` shows the static SHIELD line mark beside the compact label.
  { to: 'shield',           label: 'SHIELD', mark: 'shield' },
  // Quant™ 1A (ADR-51): manual drawing measurement — calibrate a sheet,
  // measure lengths, areas and counts, persist traceable measurement records.
  // Writes NO BOQ quantity (Quant 1B). `mark` shows the static Quant line mark.
  { to: 'quant',            label: 'Quant', mark: 'quant' },
  { to: 'boq',              label: 'BOQ' },
  { to: 'tenders',          label: 'Tenders' },
  { to: 'budget',           label: 'Budget' },
  { to: 'cost-codes',       label: 'Cost Codes' },
  { to: 'purchase-orders',  label: 'Purchase Orders' },
  { to: 'progress-claims',  label: 'Progress Claims' },
  // Route kept as `invoices` (unchanged); the label disambiguates it from
  // Client Invoices, which lives under the Commercial tab.
  { to: 'invoices',         label: 'Supplier Invoices' },
  { to: 'forecasting',      label: 'Forecast' },
  { to: 'variations',       label: 'Variations' },
  { to: 'commercial',       label: 'Commercial' },
  // L2-A Commercial Report: read-only, one project, financial roles (the page
  // shows a restricted notice to other roles and opens no financial read).
  { to: 'reports',          label: 'Reports' },
  { to: 'documents',        label: 'Documents' },
  // Constrapp GANTT™ (ADR-64): the ADR-29 project programme — activities,
  // milestones, the activity table and the Gantt chart — under its module
  // name. The ROUTE stays `timeline` so every existing link (Dashboard
  // Programme panel, PULSE indicator 4, bookmarks) still resolves; only the
  // label and the static mark changed. One collection, one listener, one
  // editor — never a second scheduler.
  { to: 'timeline',         label: 'GANTT', mark: 'gantt' },
  { to: 'rfis',             label: 'RFIs' },
]

// The tabs offered to a role (M2-A2). Internal roles get every tab. Any other
// role — in practice a client or subcontractor on an ASSIGNED project — gets
// the two whose data it can read: the project's directory entry (Overview) and
// its drawings and project-visible documents (Documents). Every other tab
// reads a collection the rules refuse to it.
//
// ⚠️ A UX filter only, like lib/nav.js: the routes still exist, each page
// gates itself, and Firestore Security Rules are the enforced boundary. The
// role list is spelled out (it mirrors lib/projects.js →
// PROJECT_INTERNAL_ROLES, asserted equal by tests/unit/externalProjectIsolation.test.js)
// so this module stays free of imports.
const INTERNAL_TAB_ROLES = ['company_admin', 'project_manager', 'qs']
export const EXTERNAL_PROJECT_TABS = ['overview', 'documents']
export const projectTabsFor = (role) => (INTERNAL_TAB_ROLES.includes(role)
  ? PROJECT_TABS
  : PROJECT_TABS.filter(tab => EXTERNAL_PROJECT_TABS.includes(tab.to)))
