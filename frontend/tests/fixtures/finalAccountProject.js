// ── A project that is READY for Final Account — shared test fixture ──────────
//
// Plain documents (no SDK types), keyed by the collection they live in, used by
// the unit suite (as selector input), the Rules suite and the Functions suite
// (seeded into the emulator). Every amount is chosen so that the expected
// figures below are non-trivial and DISTINCT — no test can pass by two zeros
// agreeing.
//
//   Contract 10,000 + approved client variation 2,000            = 12,000
//   Approved budget 7,000 (cc1 4,000 + cc2 3,000)
//   One sent PO fully invoiced by one posted supplier invoice     = 6,000 actual
//   → cost to complete 0, final cost 6,000, profit 6,000, margin 50%
//   Client invoiced 9,000 ex-GST (9,900 gross); 7,700 received
//   Supplier invoice payable 6,490 (110 retention held); 5,200 paid, 5,000 allocated

export const FA_CURRENCY = 'AUD'

export const readyProject = () => ({
  company: { name: 'Acme Builders', countryCode: 'AU', baseCurrency: 'AUD' },
  project: { name: 'Harbour Road Units', status: 'Completed', currency: 'AUD', currencyLocked: true, budget: 7000 },
  costCodes: [
    { id: 'cc1', code: '03-100', name: 'Concrete', isActive: true },
    { id: 'cc2', code: '03-200', name: 'Formwork', isActive: true },
  ],
  baseline: { originalContractValue: 10000, originalApprovedBudget: null },
  budgetLines: [
    { id: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 4000 },
    { id: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 3000 },
  ],
  pointer: { activeApprovalId: 'ba1', originalApprovalId: 'ba1', versionCount: 1 },
  budgetApprovals: [
    { id: 'ba1', status: 'approved', version: 1, entryCount: 2, total: 7000, currency: 'AUD', reason: 'Original budget', revision: 2 },
  ],
  budgetApprovalSnapshots: [
    { id: 'ba1', entryCount: 2, total: 7000, currency: 'AUD', entries: [
      { lineId: 'bl1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', budgeted: 4000 },
      { lineId: 'bl2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', budgeted: 3000 },
    ] },
  ],
  purchaseOrders: [
    { id: 'po1', poNumber: 'PO-0001', status: 'sent', supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD',
      lineItems: [
        { costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', lineTotal: 3500 },
        { costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', lineTotal: 2500 },
      ], subtotal: 6000, gst: 600, total: 6600 },
  ],
  progressClaims: [],
  supplierInvoices: [
    { id: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100', status: 'posted', source: 'direct_po',
      supplierId: 'sup1', supplierName: 'Ace Concrete', currency: 'AUD', poId: 'po1', progressClaimId: null,
      lineItems: [
        { poLineIndex: 0, costCodeId: 'cc1', costCodeName: '03-100 — Concrete', description: 'Slab', amount: 3500, taxCode: 'gst', gstAmount: 350 },
        { poLineIndex: 1, costCodeId: 'cc2', costCodeName: '03-200 — Formwork', description: 'Forms', amount: 2500, taxCode: 'gst', gstAmount: 250 },
      ],
      retention: 100, retentionGst: 10, retentionTotal: 110,
      subtotal: 6000, gstTotal: 600, grossTotal: 6600, net: 5900, payableGst: 590, payableTotal: 6490,
      invoiceDate: '2026-09-01', dueDate: '2026-09-30' },
  ],
  supplierCreditNotes: [],
  variations: [
    { id: 'v1', variationNumber: 'CV-0001', variationType: 'client', status: 'approved', approvedSubtotal: 2000, lineItems: [] },
  ],
  // Every cost code is forecast: a saved 0 (ADR-43) — "reviewed, nothing left".
  forecastLines: [
    { id: 'cc1', costCodeId: 'cc1', costCodeName: '03-100 — Concrete', uncommittedCostToComplete: 0, notes: '' },
    { id: 'cc2', costCodeId: 'cc2', costCodeName: '03-200 — Formwork', uncommittedCostToComplete: 0, notes: '' },
  ],
  supplierPayments: [
    { id: 'pay1', paymentNumber: 'SP-0001', status: 'posted', supplierId: 'sup1', supplierName: 'Ace Concrete',
      paymentDate: '2026-10-02', amount: 5200, allocatedTotal: 5000, unallocatedAmount: 200,
      allocations: [{ supplierInvoiceId: 'inv1', invoiceNumber: 'SI-0001', supplierInvoiceNumber: 'INV-100', allocatedAmount: 5000 }] },
  ],
  retentionReleases: [],
  clientInvoices: [
    { id: 'ci1', invoiceNumber: 'CI-0001', status: 'issued', clientId: 'c1', clientName: 'Owner Pty Ltd',
      subtotal: 9000, gstTotal: 900, grossTotal: 9900, invoiceDate: '2026-09-01', dueDate: '2026-10-01', lineItems: [] },
  ],
  clientReceipts: [
    { id: 'cr1', receiptNumber: 'CR-0001', status: 'posted', clientId: 'c1', clientName: 'Owner Pty Ltd', receiptDate: '2026-10-10',
      amount: 7700, allocatedTotal: 7700, unallocatedAmount: 0, allocations: [{ clientInvoiceId: 'ci1', invoiceNumber: 'CI-0001', allocatedAmount: 7700 }] },
  ],
})

// The project-level collections whose documents are listed above.
export const FA_PROJECT_COLLECTIONS = [
  'budgetLines', 'budgetApprovals', 'budgetApprovalSnapshots', 'purchaseOrders', 'progressClaims', 'supplierInvoices',
  'supplierCreditNotes', 'variations', 'forecastLines', 'supplierPayments', 'retentionReleases', 'clientInvoices', 'clientReceipts',
]

export const EXPECTED_FIGURES = {
  originalContractValue: 10000, approvedClientVariations: 2000, finalContractSum: 12000,
  invoicedToClient: 9000, remainingToInvoice: 3000,
  approvedBudget: 7000, approvedSupplierVariations: 0, actualCost: 6000, costToComplete: 0, finalCost: 6000, varianceToBudget: 1000,
  finalProfit: 6000, finalMarginPct: 50,
  invoicedToClientGross: 9900, receivedAgainstInvoices: 7700, receivablesOutstanding: 2200, cashReceived: 7700, unallocatedReceipts: 0,
  cashPaid: 5200, payablesOutstanding: 1490, unallocatedPayments: 200, retentionHeld: 110,
}

// The `sources` object computeFinalAccount takes, from the documents above.
export function sourcesOf(p) {
  const settled = {
    pointerLoading: false, pointerError: false, headerLoading: false, headerError: false, snapshotLoading: false, snapshotError: false,
    originalSnapshot: null, originalLoading: false, originalError: false, originalRequested: false,
    adjustments: p.budgetAdjustments ?? [], adjustmentsLoading: false, adjustmentsError: false,
  }
  const activeId = p.pointer?.activeApprovalId ?? null
  return {
    budgetLines: p.budgetLines, purchaseOrders: p.purchaseOrders, progressClaims: p.progressClaims,
    supplierInvoices: p.supplierInvoices, supplierCreditNotes: p.supplierCreditNotes, variations: p.variations,
    forecastLines: p.forecastLines, baseline: p.baseline, supplierPayments: p.supplierPayments,
    retentionReleases: p.retentionReleases, clientInvoices: p.clientInvoices, clientReceipts: p.clientReceipts,
    costCodes: p.costCodes,
    approvedBudget: {
      ...settled,
      pointer: p.pointer ?? null,
      header: p.budgetApprovals.find(h => h.id === activeId) ?? null,
      snapshot: p.budgetApprovalSnapshots.find(s => s.id === activeId) ?? null,
    },
  }
}
