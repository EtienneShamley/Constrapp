// ── A fake one-shot reader over plain documents — shared test fixture ────────
//
// lib/portfolioSources.js takes its reads through an injected `reader`
// ({ list, get }). This is that reader over the document sets of
// tests/fixtures/finalAccountProject.js (`readyProject()`), keyed by project
// id — so the Portfolio loader is exercised end to end in plain Node, with no
// SDK and no emulator.
//
//   · `calls`      — every read issued, in order (for path / shape assertions)
//   · `fail`       — a predicate; a matching read REJECTS (a failed source)
//   · `gate`       — optional async hook awaited before each read resolves
//                    (to hold reads open for the concurrency tests)

const docKey = (path) => path.join('/')

export function projectStore(p) {
  return {
    collections: {
      budgetLines: p.budgetLines ?? [],
      purchaseOrders: p.purchaseOrders ?? [],
      progressClaims: p.progressClaims ?? [],
      supplierInvoices: p.supplierInvoices ?? [],
      supplierCreditNotes: p.supplierCreditNotes ?? [],
      variations: p.variations ?? [],
      forecastLines: p.forecastLines ?? [],
      supplierPayments: p.supplierPayments ?? [],
      retentionReleases: p.retentionReleases ?? [],
      clientInvoices: p.clientInvoices ?? [],
      clientReceipts: p.clientReceipts ?? [],
      budgetAdjustments: p.budgetAdjustments ?? [],
    },
    docs: {
      'commercial/baseline': p.baseline ?? null,
      'approvedBudget/current': p.pointer ?? null,
      ...Object.fromEntries((p.budgetApprovals ?? []).map(h => [`budgetApprovals/${h.id}`, h])),
      ...Object.fromEntries((p.budgetApprovalSnapshots ?? []).map(s => [`budgetApprovalSnapshots/${s.id}`, s])),
    },
  }
}

export function fakeReader(storesByProjectId, { fail = () => false, gate = null } = {}) {
  const calls = []
  const run = async (call, produce) => {
    calls.push(call)
    if (gate) await gate(call)
    if (fail(call)) throw new Error('permission-denied')
    return produce()
  }
  return {
    calls,
    list({ companyId, projectId, collection, orderBy, where }) {
      const call = { kind: 'list', companyId, projectId, collection, orderBy, where }
      return run(call, () => {
        const all = storesByProjectId[projectId]?.collections?.[collection] ?? []
        return where ? all.filter(d => d[where[0]] === where[2]) : [...all]
      })
    },
    get({ companyId, projectId, path }) {
      const call = { kind: 'get', companyId, projectId, path, key: docKey(path) }
      return run(call, () => storesByProjectId[projectId]?.docs?.[docKey(path)] ?? null)
    },
  }
}
