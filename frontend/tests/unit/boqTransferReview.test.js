import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import BoqBudgetTransferModal from '../../src/pages/project/boq/BoqBudgetTransferModal'
import WriteFeedback, { DEFAULT_ACKNOWLEDGE_LABEL } from '../../src/components/WriteFeedback'
import { WRITE_PHASE, WRITE_MESSAGES } from '../../src/lib/writeOutcome'
import { boqLineAmount } from '../../src/lib/boq'
import {
  buildTransferProposal, transferSummary, transferRequestKey, TRANSFER_ROW_STATE,
} from '../../src/lib/boqBudgetTransfer'
import { runBoqBudgetTransfer } from '../../src/lib/boqBudgetTransferActions'
import {
  transferConfirmationKey, isConfirmationCurrent, reconcileConfirmation, canSubmitTransfer,
  transferRequestToSend, confirmationLabel, reviewedChangesPhrase, unpricedItemLabels,
  TRANSFER_UNCERTAIN_ACK_LABEL, TRANSFER_UNCERTAIN_HINT,
} from '../../src/lib/boqTransferReview'

// ── L4 acceptance correction: the reviewer's confirmation and the copy ──────
//
// The unit runner has no DOM, so the dialog's behaviour is exercised through
// the pure functions it calls on every render and on submit
// (lib/boqTransferReview.js), its static markup (react-dom/server), and pins
// on the dialog's source for what cannot be rendered.

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(resolve(HERE, '../..', p), 'utf8')

const CODES = [
  { id: 'cc1', code: '0100', name: 'Site Works', active: true },
  { id: 'cc2', code: '0200', name: 'Foundation', active: true },
  { id: 'cc3', code: '0300', name: 'Concrete', active: true },
]
const item = (id, costCodeId, quantity, rate, o = {}) => ({
  id, costCodeId, quantity, rate, unit: 'm2', status: 'active', currency: 'AUD',
  amount: rate === null ? null : boqLineAmount(quantity, rate), description: `Item ${id}`, itemNumber: '', ...o,
})
const ITEMS = [item('a1', 'cc1', 10, 100), item('a2', 'cc1', 5, 0), item('b1', 'cc2', 4, 312.5)]

// What the dialog derives on one render.
function render(boqItems, budgetLines = [], zero = []) {
  const proposal = buildTransferProposal({ boqItems, budgetLines, costCodes: CODES, currencyCode: 'AUD' })
  const zeroChoices = proposal.rows.filter(r => r.state === TRANSFER_ROW_STATE.ZERO_AVAILABLE && zero.includes(r.costCodeId)).map(r => r.costCodeId)
  const summary = transferSummary(proposal, zeroChoices)
  return { proposal, zeroChoices, summary, currentKey: transferConfirmationKey(proposal.reviewKey, zeroChoices) }
}
const can = (r, confirmedFor, o = {}) => canSubmitTransfer({
  ready: true, locked: false, pending: null, operationCount: r.summary.operationCount, confirmedFor, currentKey: r.currentKey, ...o,
})
const toSend = (r, confirmedFor, pending = null) =>
  transferRequestToSend({ pending, reviewKey: r.proposal.reviewKey, zeroChoices: r.zeroChoices, confirmedFor })

describe('A. the initial review requires confirmation', () => {
  it('nothing confirmed: submit is disabled and the handler sends nothing', () => {
    const r = render(ITEMS)
    expect(r.summary.operationCount).toBe(2)
    expect(can(r, null)).toBe(false)
    expect(toSend(r, null)).toBeNull()
  })
  it('the dialog renders the box unticked and Apply disabled', () => {
    const html = renderToStaticMarkup(h(BoqBudgetTransferModal, { boqItems: ITEMS, budgetLines: [], costCodes: CODES, currencyCode: 'AUD', onTransfer: () => {}, onClose: () => {} }))
    expect(html).toMatch(/<input type="checkbox"[^>]*data-confirmed-for=""/)
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*data-confirmed-for/)
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Apply transfer<\/button>/)
  })
})

describe('B. a confirmation allows only the request it names', () => {
  it('the matching key submits exactly that reviewKey and choices', () => {
    const r = render(ITEMS)
    expect(can(r, r.currentKey)).toBe(true)
    expect(toSend(r, r.currentKey)).toEqual({ reviewKey: r.proposal.reviewKey, setToZero: [] })
  })
  it('the key is the server request key; a different key, a bare true or an empty string submits nothing', () => {
    const r = render(ITEMS)
    expect(r.currentKey).toBe(transferRequestKey(r.proposal.reviewKey, []))
    for (const bad of [transferRequestKey('v1:' + '0'.repeat(32), []), true, '', undefined, 1]) {
      expect(can(r, bad)).toBe(false)
      expect(toSend(r, bad)).toBeNull()
    }
  })
  it('no review key (sources not ready) gives no confirmable key', () => {
    expect(transferConfirmationKey(undefined, [])).toBeNull()
    expect(isConfirmationCurrent(null, null)).toBe(false)
  })
})

describe('C/D. a live BOQ change while the dialog is open', () => {
  it('invalidates the confirmation, refuses the old one at submit, and accepts a reconfirmation of the new figures', async () => {
    let items = ITEMS
    const first = render(items)
    const confirmedFor = first.currentKey                      // the reviewer ticks
    expect(can(first, confirmedFor)).toBe(true)

    // The listener delivers a rate change asynchronously, as Firestore does.
    await new Promise(r => setTimeout(r, 5))
    items = items.map(i => (i.id === 'a1' ? item('a1', 'cc1', 10, 110) : i))
    const second = render(items)
    expect(second.proposal.reviewKey).not.toBe(first.proposal.reviewKey)

    // Same render: not shown as ticked, Apply disabled, the stale key is dropped.
    expect(isConfirmationCurrent(confirmedFor, second.currentKey)).toBe(false)
    expect(can(second, confirmedFor)).toBe(false)
    expect(reconcileConfirmation(confirmedFor, second.currentKey)).toBeNull()

    // G. A submit that fires before any render-phase reset still sends nothing.
    const calls = []
    const call = async (data) => { calls.push(data); return { outcome: 'applied' } }
    const req = toSend(second, confirmedFor)
    expect(req).toBeNull()
    if (req) await runBoqBudgetTransfer({ call, projectId: 'p1', ...req })
    expect(calls).toEqual([])

    // D. Reconfirming the changed proposal sends the NEW reviewKey.
    const again = toSend(second, second.currentKey)
    expect(again).toEqual({ reviewKey: second.proposal.reviewKey, setToZero: [] })
    await runBoqBudgetTransfer({ call, projectId: 'p1', ...again })
    expect(calls).toEqual([{ projectId: 'p1', reviewKey: second.proposal.reviewKey, setToZero: [] }])
  })
  it('a confirmation does not come back if the figures return to what was ticked', () => {
    const first = render(ITEMS)
    let confirmedFor = first.currentKey
    const changed = render(ITEMS.map(i => (i.id === 'b1' ? item('b1', 'cc2', 5, 312.5) : i)))
    confirmedFor = reconcileConfirmation(confirmedFor, changed.currentKey)  // the dialog clears it in that render
    const back = render(ITEMS)
    expect(back.currentKey).toBe(first.currentKey)
    expect(can(back, confirmedFor)).toBe(false)
  })
  it('a new manual line or a new unpriced item also invalidates it', () => {
    const first = render(ITEMS)
    const manual = render(ITEMS, [{ id: 'm1', costCodeId: 'cc2', budgeted: 700 }])
    const unpriced = render([...ITEMS, item('c2', 'cc1', 8, null)])
    expect(can(manual, first.currentKey)).toBe(false)
    expect(can(unpriced, first.currentKey)).toBe(false)
  })
})

describe('E. unchanged snapshots and unrelated renders keep the confirmation', () => {
  it('a fresh snapshot with the same figures (new objects, other order, renamed text, timestamps) keeps the same key', () => {
    const first = render(ITEMS)
    const snapshot = [...ITEMS].reverse().map(i => ({ ...i, description: `${i.description} (renamed)`, notes: 'x', updatedAt: { seconds: 9 } }))
    const again = render(snapshot)
    expect(again.currentKey).toBe(first.currentKey)
    expect(reconcileConfirmation(first.currentKey, again.currentKey)).toBe(first.currentKey)
    expect(can(again, first.currentKey)).toBe(true)
  })
})

describe('F. set-to-zero choices are part of what is confirmed', () => {
  const sourced = { id: 'boq-cc3', costCodeId: 'cc3', budgeted: 3400, boqSource: { first: { amount: 3400 }, latest: { amount: 3400, fingerprint: 'x' } } }
  it('ticking or unticking a set-to-zero changes the key, so the earlier confirmation no longer submits', () => {
    const unticked = render(ITEMS, [sourced])
    expect(unticked.proposal.rows.find(r => r.costCodeId === 'cc3').state).toBe(TRANSFER_ROW_STATE.ZERO_AVAILABLE)
    const ticked = render(ITEMS, [sourced], ['cc3'])
    expect(ticked.currentKey).not.toBe(unticked.currentKey)
    expect(can(ticked, unticked.currentKey)).toBe(false)
    expect(toSend(ticked, unticked.currentKey)).toBeNull()
    expect(toSend(ticked, ticked.currentKey)).toEqual({ reviewKey: ticked.proposal.reviewKey, setToZero: ['cc3'] })
    expect(can(unticked, ticked.currentKey)).toBe(false)
  })
  it('the dialog also clears the confirmation in the toggle handler itself', () => {
    const modal = read('src/pages/project/boq/BoqBudgetTransferModal.jsx')
    expect(modal).toMatch(/function toggleZero\(costCodeId\) \{\s*setResult\(null\)\s*setConfirmedFor\(null\)/)
  })
})

describe('G. no window between a change and an effect', () => {
  const modal = read('src/pages/project/boq/BoqBudgetTransferModal.jsx')
  it('the confirmation is a stored request key, compared during render — no effect resets it', () => {
    expect(modal).toContain('const [confirmedFor, setConfirmedFor] = useState(null)')
    expect(modal).not.toMatch(/useState\(false\)/)
    expect(modal).not.toMatch(/useEffect/)
    expect(modal).toContain('const confirmed = isConfirmationCurrent(confirmedFor, currentKey)')
    expect(modal).toContain('onChange={(e) => setConfirmedFor(e.target.checked ? currentKey : null)}')
  })
  it('submit re-derives the request from the current proposal and sends nothing unless the confirmation names it', () => {
    const body = modal.slice(modal.indexOf('function submit(e)'), modal.indexOf('const outcome ='))
    const check = body.indexOf('transferRequestToSend({ pending, reviewKey: proposal.reviewKey, zeroChoices, confirmedFor })')
    expect(check).toBeGreaterThan(0)
    expect(body.indexOf('if (!request) { setConfirmedFor(null); return }')).toBeGreaterThan(check)
    expect(body.indexOf('setPending(request)')).toBeGreaterThan(check)
    expect(body.indexOf('onTransfer(request)')).toBeGreaterThan(check)
  })
  it('an unanswered request is resent exactly as sent, whatever the current proposal', () => {
    const r = render(ITEMS)
    const pending = { reviewKey: 'v1:' + 'a'.repeat(32), setToZero: [] }
    expect(toSend(r, null, pending)).toBe(pending)
    expect(can(r, null, { pending })).toBe(true)
    expect(can(r, r.currentKey, { locked: true })).toBe(false)
    expect(can(r, r.currentKey, { ready: false })).toBe(false)
  })
})

describe('H. an uncertain outcome never claims the write failed (or succeeded)', () => {
  const claims = /not saved|was not|failed|did not go through|succeeded|was saved/i
  it('the transfer acknowledgement and hint', () => {
    expect(TRANSFER_UNCERTAIN_ACK_LABEL).not.toMatch(claims)
    expect(TRANSFER_UNCERTAIN_HINT).not.toMatch(/not saved|did not go through/i)
    expect(TRANSFER_UNCERTAIN_HINT).toMatch(/not known/)
    expect(TRANSFER_UNCERTAIN_HINT).toMatch(/Check the Budget tab/)
    expect(TRANSFER_UNCERTAIN_HINT).toMatch(/Nothing is retried automatically/)
    expect(TRANSFER_UNCERTAIN_HINT).toMatch(/same reviewed transfer/)
    expect(TRANSFER_UNCERTAIN_HINT).toMatch(/applies it once only/)
  })
  it('WriteFeedback shows the transfer wording when given, and keeps the default for every other dialog', () => {
    const write = { phase: WRITE_PHASE.UNCERTAIN, message: WRITE_MESSAGES.noAnswer, canAcknowledge: true, acknowledge: () => {} }
    const transfer = renderToStaticMarkup(h(WriteFeedback, { write, acknowledgeLabel: TRANSFER_UNCERTAIN_ACK_LABEL }))
    expect(transfer).toContain('let me send the same transfer again')
    expect(transfer).not.toMatch(/not saved/)
    expect(renderToStaticMarkup(h(WriteFeedback, { write }))).toContain(DEFAULT_ACKNOWLEDGE_LABEL)
    expect(WRITE_MESSAGES.noAnswer).not.toMatch(/was not saved|failed/i)
  })
  it('the dialog passes the transfer wording and its hint', () => {
    const modal = read('src/pages/project/boq/BoqBudgetTransferModal.jsx')
    expect(modal).toContain('<WriteFeedback write={write} acknowledgeLabel={TRANSFER_UNCERTAIN_ACK_LABEL} />')
    expect(modal).toContain('{TRANSFER_UNCERTAIN_HINT}')
  })
})

describe('copy', () => {
  it('singular and plural', () => {
    expect(reviewedChangesPhrase(1)).toBe('this change')
    expect(reviewedChangesPhrase(3)).toBe('these 3 changes')
    expect(confirmationLabel(1, 0)).toBe('I have reviewed this change to the working budget.')
    expect(confirmationLabel(2, 1)).toBe('I have reviewed these 2 changes to the working budget, including 1 line set to zero.')
    expect(confirmationLabel(3, 2)).toBe('I have reviewed these 3 changes to the working budget, including 2 lines set to zero.')
  })
  it('a blocked row names its unpriced items from the register already loaded', () => {
    const items = [...ITEMS, item('c1', 'cc3', 20, 150), item('c2', 'cc3', 8, null, { description: 'Edge thickening', itemNumber: '3.2' }),
      item('c3', 'cc3', 1, null, { status: 'void', description: 'Voided' })]
    expect(unpricedItemLabels(items, 'cc3')).toEqual({ shown: ['3.2 Edge thickening'], more: 0 })
    const many = Array.from({ length: 5 }, (_, i) => item(`u${i}`, 'cc1', 1, null, { description: `U${i}` }))
    expect(unpricedItemLabels(many, 'cc1')).toEqual({ shown: ['U0', 'U1', 'U2'], more: 2 })
    const html = renderToStaticMarkup(h(BoqBudgetTransferModal, { boqItems: items, budgetLines: [], costCodes: CODES, currencyCode: 'AUD', onTransfer: () => {}, onClose: () => {} }))
    expect(html).toContain('Unpriced: 3.2 Edge thickening')
    expect(html).toContain('I have reviewed these 2 changes to the working budget.')
  })
  it('one change reads in the singular in the dialog', () => {
    const html = renderToStaticMarkup(h(BoqBudgetTransferModal, { boqItems: [item('b1', 'cc2', 4, 312.5)], budgetLines: [], costCodes: CODES, currencyCode: 'AUD', onTransfer: () => {}, onClose: () => {} }))
    expect(html).toContain('I have reviewed this change to the working budget.')
    expect(html).not.toContain('these 1 change')
  })
})

describe('I. server authority, idempotency and the calculation are untouched', () => {
  it('the review module is browser-only: neither the server bundle nor the Functions import it', () => {
    expect(read('functions/src/generated/boqBudgetTransferCalc.js')).not.toMatch(/boqTransferReview|confirmedFor/)
    expect(read('functions/src/boqBudget/transfer.js')).not.toMatch(/boqTransferReview/)
    expect(read('scripts/build-boq-transfer-bundle.mjs')).not.toMatch(/boqTransferReview/)
  })
  it('the request still carries no amount — only the reviewKey and the set-to-zero ids', () => {
    const r = render(ITEMS)
    expect(Object.keys(toSend(r, r.currentKey)).sort()).toEqual(['reviewKey', 'setToZero'])
  })
})
