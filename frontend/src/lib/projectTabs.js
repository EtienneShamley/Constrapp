// ⚠️ Photos and Reports are DELIBERATELY ABSENT.
//
// Both are unimplemented placeholder screens. Their routes and
// `ProjectPlaceholder` pages remain in App.jsx — typing the URL still renders
// them — but a private-beta user must not be offered a tab that leads nowhere.
// Re-add the entry here when the module ships; do not delete the route.
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
