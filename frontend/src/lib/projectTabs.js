// ⚠️ Photos and Reports are DELIBERATELY ABSENT.
//
// Both are unimplemented placeholder screens. Their routes and
// `ProjectPlaceholder` pages remain in App.jsx — typing the URL still renders
// them — but a private-beta user must not be offered a tab that leads nowhere.
// Re-add the entry here when the module ships; do not delete the route.
export const PROJECT_TABS = [
  { to: 'overview',         label: 'Overview' },
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
  { to: 'timeline',         label: 'Timeline' },
  { to: 'rfis',             label: 'RFIs' },
]
