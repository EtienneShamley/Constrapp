import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  commercialCompletionActivated, COMMERCIAL_NOT_ACTIVATED_CODE, COMMERCIAL_MAINTENANCE_TITLE, COMMERCIAL_MAINTENANCE_TEXT,
  COMMERCIAL_ACTIVATION_FIELD, isCommercialNotActivated, commercialActivationState,
  clientInvoiceVoidOffered, CLIENT_INVOICE_VOID_STATUS, commercialFailureMessage,
} from '../../src/lib/commercialActivation'
import { CI_STATUS } from '../../src/lib/clientInvoices'
import { describeSupplierFinanceFailure, runSupplierFinance, SupplierFinanceError, SF_ERROR, SF_CALLABLE } from '../../src/lib/supplierFinanceActions'
import { describeVariationCallFailure, VariationWriteError, VARIATION_WRITE_ERROR } from '../../src/lib/variationActions'
import { describeEstimateFailure, runEstimateOperation, EstimateError, ESTIMATE_ERROR } from '../../src/lib/estimatingActions'
import { describeTransferFailure, BOQ_TRANSFER_ERROR } from '../../src/lib/boqBudgetTransferActions'
import { describeWriteError, WRITE_FAILURE } from '../../src/lib/writeOutcome'

// A callable refusal as the Functions SDK delivers it: HttpsError
// failed-precondition carrying the typed code in `details`.
const notActivated = () => Object.assign(new Error('This company has not been switched over yet.'), {
  name: 'FirebaseError', code: 'functions/failed-precondition', details: { code: COMMERCIAL_NOT_ACTIVATED_CODE },
})
const typed = (code, message = 'server sentence') => Object.assign(new Error(message), {
  name: 'FirebaseError', code: 'functions/failed-precondition', details: { code },
})

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const strip = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('commercialCompletionActivated — strict `=== true`', () => {
  it('only the boolean true activates', () => {
    expect(COMMERCIAL_ACTIVATION_FIELD).toBe('commercialCompletionEnabled')
    expect(commercialCompletionActivated({ id: 'c1', commercialCompletionEnabled: true })).toBe(true)
    for (const v of [false, 'true', 1, 'yes', {}, [], null, undefined]) {
      expect(commercialCompletionActivated({ commercialCompletionEnabled: v }), String(v)).toBe(false)
    }
    expect(commercialCompletionActivated({})).toBe(false)
    expect(commercialCompletionActivated(null)).toBe(false)
    expect(commercialCompletionActivated(undefined)).toBe(false)
    // Client finance activation is a different switch.
    expect(commercialCompletionActivated({ clientFinanceEnabled: true })).toBe(false)
  })
})

describe('commercialActivationState — what a page shows and offers', () => {
  const on = { commercialCompletionEnabled: true }
  it('activated: writes offered, no notice', () => {
    expect(commercialActivationState(on)).toEqual({ loading: false, activated: true, writable: true, maintenance: false })
  })
  it('not activated (missing, false, truthy non-boolean, unreadable null): read-only with the notice', () => {
    for (const company of [{}, { commercialCompletionEnabled: false }, { commercialCompletionEnabled: 'true' }, null]) {
      expect(commercialActivationState(company)).toEqual({ loading: false, activated: false, writable: false, maintenance: true })
    }
  })
  it('loading (company or profile): no write offered AND no notice — never a flash', () => {
    for (const flags of [{ companyLoading: true }, { profileLoading: true }, { companyLoading: true, profileLoading: true }]) {
      expect(commercialActivationState(null, flags)).toEqual({ loading: true, activated: false, writable: false, maintenance: false })
      // Even an activated document is not trusted while a flag says loading.
      expect(commercialActivationState(on, flags).writable).toBe(false)
    }
  })
})

describe('gating helpers leave Phase 1 actions untouched', () => {
  const active = commercialActivationState({ commercialCompletionEnabled: true })
  const inactive = commercialActivationState({})
  const loading = commercialActivationState(null, { companyLoading: true })

  it('the client invoice Void: a DRAFT (Phase 1) always; an ISSUED invoice (Phase 2) only when activated', () => {
    expect(CLIENT_INVOICE_VOID_STATUS).toEqual({ DRAFT: CI_STATUS.DRAFT, ISSUED: CI_STATUS.ISSUED })
    for (const state of [active, inactive, loading, undefined]) expect(clientInvoiceVoidOffered(CI_STATUS.DRAFT, state)).toBe(true)
    expect(clientInvoiceVoidOffered(CI_STATUS.ISSUED, active)).toBe(true)
    expect(clientInvoiceVoidOffered(CI_STATUS.ISSUED, inactive)).toBe(false)
    expect(clientInvoiceVoidOffered(CI_STATUS.ISSUED, loading)).toBe(false)
    expect(clientInvoiceVoidOffered(CI_STATUS.VOID, active)).toBe(false)
  })

  it('commercialFailureMessage: the maintenance text for the activation refusal only', () => {
    expect(commercialFailureMessage(notActivated(), 'other')).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    expect(commercialFailureMessage(typed('contract-value-stale'), 'other')).toBe('other')
    expect(commercialFailureMessage(new Error('x'), 'other')).toBe('other')
    expect(isCommercialNotActivated(notActivated())).toBe(true)
    expect(isCommercialNotActivated({ code: COMMERCIAL_NOT_ACTIVATED_CODE })).toBe(false)   // only details.code counts
    expect(isCommercialNotActivated(null)).toBe(false)
  })
})

describe('every Phase 2 mapper: the activation refusal is CERTAIN, with the maintenance text', () => {
  it('supplier finance (claims, invoices, settlement)', async () => {
    const e = describeSupplierFinanceFailure(notActivated())
    expect(e).toBeInstanceOf(SupplierFinanceError)
    expect(e.kind).toBe(SF_ERROR.UNAVAILABLE)
    expect(e.message).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    expect(e.code).toBe(COMMERCIAL_NOT_ACTIVATED_CODE)
    expect(describeWriteError(e)).toEqual({ certain: true, kind: WRITE_FAILURE.REJECTED, message: COMMERCIAL_MAINTENANCE_TEXT })
    const thrown = await runSupplierFinance(async () => { throw notActivated() }, SF_CALLABLE.CLAIM, 'create', {}).then(() => null, x => x)
    expect(thrown.message).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    // Other codes are classified as before.
    expect(describeSupplierFinanceFailure(typed('supplier-finance-disabled')).message).toBe('This action is not available yet. Nothing was saved.')
    expect(describeSupplierFinanceFailure(typed('supplier-finance-stale', 'Moved.')).message).toBe('Moved.')
    expect(describeSupplierFinanceFailure(new TypeError('Failed to fetch')).kind).toBe(SF_ERROR.UNCERTAIN)
  })

  it('variations', () => {
    const e = describeVariationCallFailure(notActivated())
    expect(e).toBeInstanceOf(VariationWriteError)
    expect(e.kind).toBe(VARIATION_WRITE_ERROR.UNAVAILABLE)
    expect(e.message).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    expect(describeWriteError(e)).toEqual({ certain: true, kind: WRITE_FAILURE.REJECTED, message: COMMERCIAL_MAINTENANCE_TEXT })
    expect(describeVariationCallFailure(typed('variation-processing-disabled')).message).toBe('This action is temporarily unavailable on the server. Nothing was saved.')
    expect(describeVariationCallFailure(new TypeError('Failed to fetch')).kind).toBe(VARIATION_WRITE_ERROR.UNCERTAIN)
  })

  it('estimating', async () => {
    const e = describeEstimateFailure(notActivated())
    expect(e).toBeInstanceOf(EstimateError)
    expect(e.kind).toBe(ESTIMATE_ERROR.UNAVAILABLE)
    expect(e.message).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    expect(describeWriteError(e).certain).toBe(true)
    const thrown = await runEstimateOperation(async () => { throw notActivated() }, 'build', {}).then(() => null, x => x)
    expect(thrown.message).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    expect(describeEstimateFailure(typed('estimate-disabled')).message).toBe('Estimating is not available yet. Nothing was changed.')
  })

  it('the BOQ transfer sent as an estimate handover', () => {
    const e = describeTransferFailure(notActivated())
    expect(e.kind).toBe(BOQ_TRANSFER_ERROR.FAILED)
    expect(e.message).toBe(COMMERCIAL_MAINTENANCE_TEXT)
    expect(describeTransferFailure(new TypeError('Failed to fetch')).kind).toBe(BOQ_TRANSFER_ERROR.UNCERTAIN)
  })

  it('contract value (no module of its own): the page shows the maintenance text via commercialFailureMessage', () => {
    const page = read('src/pages/project/ProjectCommercial.jsx')
    expect(page).toContain("setError(commercialFailureMessage(err, err?.message || 'The request did not complete. Reload and check before trying again.'))")
  })
})

describe('the pages withhold Phase 2 writes and show ONE notice (source pins)', () => {
  const PAGES = [
    'src/pages/project/ProjectVariations.jsx',
    'src/pages/project/ProjectProgressClaims.jsx',
    'src/pages/project/ProjectInvoices.jsx',
    'src/pages/project/ProjectRetention.jsx',
    'src/pages/project/ProjectSupplierPayments.jsx',
    'src/pages/project/ProjectClientReceipts.jsx',
    'src/pages/project/ProjectClientInvoices.jsx',
    'src/pages/project/ProjectCommercial.jsx',
    'src/pages/project/ProjectEstimate.jsx',
  ]
  it.each(PAGES)('%s reads the activation once and renders the notice once', (rel) => {
    const src = strip(read(rel))
    expect(src.match(/useCommercialActivation\(\)/g)).toHaveLength(1)
    expect(src.match(/<CommercialMaintenanceNotice /g)).toHaveLength(1)
    // UX only: the page never reads the company field itself.
    expect(src).not.toContain('commercialCompletionEnabled')
  })

  it('the register write modals open only when writable', () => {
    const checks = {
      'src/pages/project/ProjectVariations.jsx': ['{writable && editing && (', '{writable && assessing && (', '{writable && applying && (', '{writable && <RowActions'],
      'src/pages/project/ProjectProgressClaims.jsx': ['{writable && editing && (', '{writable && assessing && (', '{writable && <RowActions'],
      'src/pages/project/ProjectInvoices.jsx': ['{writable && editing && (', '{writable && creditEditor && (', '{writable && creditVoiding && (', '{writable && <RowActions'],
      'src/pages/project/ProjectRetention.jsx': ['{writable && releaseFor?.invoice && (', '{writable && voidTarget && (', 'canRelease={writable}'],
      'src/pages/project/ProjectSupplierPayments.jsx': ['{writable && editing && !payableStateUnknown && (', '{writable && posting && !payableStateUnknown && (', '{writable && voiding && ('],
      'src/pages/project/ProjectEstimate.jsx': ['const canPrepare = writable && canPrepareEstimate(role)', 'const canApprove = writable && canApproveEstimate(role)', '{writable && transferring && approved && ('],
    }
    for (const [rel, needles] of Object.entries(checks)) {
      const src = read(rel)
      for (const n of needles) expect(src, `${rel}: ${n}`).toContain(n)
    }
  })

  it('client receipts: refunds, applications and their voids are gated; receipts are not', () => {
    const src = read('src/pages/project/ProjectClientReceipts.jsx')
    expect(src).toContain('const settlementOffered = clientFinanceActivated(company) && !settlementError && activation.writable')
    expect(src).toContain('canVoid={activation.writable}')
    for (const m of ['{activation.writable && refunding && (', '{activation.writable && applying && (', '{activation.writable && correcting && (']) expect(src).toContain(m)
    // The receipt editor, post and void dialogs are unchanged.
    expect(src).toContain('      {editing && (\n        <ReceiptEditorModal')
    expect(src).toContain('      {posting && (\n        <PostModal')
    expect(src).toContain('      {voiding && (\n        <VoidModal')
  })

  it('client invoices: only the void of an ISSUED invoice is gated', () => {
    const src = read('src/pages/project/ProjectClientInvoices.jsx')
    expect(src).toContain('{clientInvoiceVoidOffered(inv.status, activation) && (')
    expect(src).toContain('{voiding && clientInvoiceVoidOffered(voiding.status, activation) && (')
  })

  it('contract value: corrections gated, the baseline form is not; the BOQ tab transfer (ADR-81) is untouched', () => {
    const commercial = read('src/pages/project/ProjectCommercial.jsx')
    expect(commercial).toContain(') : !writable ? null : (')
    expect(commercial).toContain('commercialFailureMessage(err,')
    const baseline = commercial.slice(commercial.indexOf('function BaselineForm('), commercial.indexOf('function ContractValueCorrections('))
    expect(baseline).not.toMatch(/writable|useCommercialActivation/)
    // The estimate handover is gated where it is offered (the Estimate page
    // opens the modal only when writable); the modal and the BOQ tab are not.
    expect(read('src/pages/project/boq/BoqBudgetTransferModal.jsx')).not.toContain('useCommercialActivation')
    expect(read('src/pages/project/ProjectBoq.jsx')).not.toContain('useCommercialActivation')
  })

  it('the notice uses the contract title and text, shown only for maintenance', () => {
    const notice = read('src/components/CommercialMaintenanceNotice.jsx')
    expect(notice).toContain('{COMMERCIAL_MAINTENANCE_TITLE}')
    expect(notice).toContain('{COMMERCIAL_MAINTENANCE_TEXT}')
    expect(notice).toContain("if (activation?.maintenance !== true) return null")
    expect(COMMERCIAL_MAINTENANCE_TITLE.length).toBeGreaterThan(0)
  })

  it('lib/commercialActivation.js imports nothing (it is reached by bundled modules)', () => {
    expect(read('src/lib/commercialActivation.js')).not.toMatch(/^import /m)
  })
})
