import { describe, it, expect } from 'vitest'
import {
  runBoqBudgetTransfer, describeTransferFailure, transferOutcomeText, BoqTransferError,
  BOQ_TRANSFER_ERROR as E, BOQ_TRANSFER_MESSAGES as M, TRANSFER_CALL_TIMEOUT_MS,
} from '../../src/lib/boqBudgetTransferActions'
import { describeWriteError, createWriteController, WRITE_PHASE } from '../../src/lib/writeOutcome'

// ── The transfer CALL and its outcomes (ADR-81; L3 write-outcome convention) ─

const KEY = 'v1:' + 'a'.repeat(32)
const typed = (code, grpc = 'failed-precondition') => Object.assign(new Error('x'), { name: 'FirebaseError', code: `functions/${grpc}`, details: { code } })
const untyped = (grpc) => Object.assign(new Error('x'), { name: 'FirebaseError', code: `functions/${grpc}` })
const run = (call, over = {}) => runBoqBudgetTransfer({ call, projectId: 'p1', reviewKey: KEY, setToZero: [], ...over })
const caught = async (p) => { try { await p } catch (e) { return e } throw new Error('no throw') }

describe('the request', () => {
  it('sends identifiers and guards only — the project, the review key and the sorted, unique set-to-zero choices', async () => {
    let sent = null
    const res = await run(async (d) => { sent = d; return { outcome: 'applied', created: 1 } }, { setToZero: ['b', 'a', 'b'] })
    expect(sent).toEqual({ projectId: 'p1', reviewKey: KEY, setToZero: ['a', 'b'] })
    expect(res.outcome).toBe('applied')
  })
  it('a malformed key never reaches the server', async () => {
    let calls = 0
    const e = await caught(run(async () => { calls += 1 }, { reviewKey: 'nope' }))
    expect(calls).toBe(0)
    expect(e).toMatchObject({ kind: E.FAILED, code: 'invalid-argument' })
  })
  it('the client waits longer than the function may run (120 s)', () => {
    expect(TRANSFER_CALL_TIMEOUT_MS).toBeGreaterThan(120000)
  })
})

describe('the three results', () => {
  it.each(['applied', 'already-applied', 'unchanged'])('%s is returned as the server gave it', async (outcome) => {
    expect((await run(async () => ({ outcome, created: 0 }))).outcome).toBe(outcome)
  })
  it('an answer that is not one of the three outcomes is UNCERTAIN, never a success', async () => {
    for (const bad of [null, undefined, {}, { outcome: 'ok' }]) {
      expect(await caught(run(async () => bad))).toMatchObject({ kind: E.UNCERTAIN })
    }
  })
  it('each result has its own wording; only APPLIED claims a change', () => {
    const money = (n) => `$${n}`
    expect(transferOutcomeText({ outcome: 'applied', created: 2, refreshed: 1, zeroed: 1, before: 10, after: 30 }, money)).toEqual({
      title: 'Transfer applied',
      body: 'The server confirmed: 2 budget lines created, 1 line refreshed, 1 line set to zero. Those working lines moved from $10 to $30.',
    })
    expect(transferOutcomeText({ outcome: 'already-applied' }).body).toMatch(/applied earlier.*Nothing was written again/)
    expect(transferOutcomeText({ outcome: 'unchanged' }).body).toMatch(/Nothing was written/)
  })
})

describe('refusals and failures', () => {
  it.each([
    ['boq-transfer-stale-review', E.STALE_REVIEW, M.stale],
    ['boq-transfer-blocked', E.BLOCKED, M.blocked],
    ['boq-transfer-busy', E.FAILED, M.busy],
    ['boq-transfer-forbidden', E.FAILED, M.forbidden],
    ['boq-transfer-disabled', E.FAILED, M.disabled],
    ['boq-transfer-too-large', E.FAILED, M.tooLarge],
    ['not-found', E.FAILED, M.notFound],
    ['membership-inactive', E.FAILED, M.forbidden],
    ['invalid-argument', E.FAILED, M.invalid],
  ])('typed %s → %s, CERTAIN, with "nothing was written"', async (code, kind, message) => {
    const e = await caught(run(async () => { throw typed(code) }))
    expect(e).toBeInstanceOf(BoqTransferError)
    expect(e.kind).toBe(kind)
    expect(e.message).toBe(message)
    expect(e.message).toMatch(/Nothing was written/)
    const d = describeWriteError(e)
    expect(d.certain).toBe(true)
    expect(d.message).toBe(message)
  })
  it.each(['unauthenticated', 'permission-denied', 'not-found', 'invalid-argument'])('untyped %s is answered before the handler runs — CERTAIN', async (grpc) => {
    const e = await caught(run(async () => { throw untyped(grpc) }))
    expect(e.kind).toBe(E.FAILED)
    expect(describeWriteError(e).certain).toBe(true)
  })
  it.each(['deadline-exceeded', 'unavailable', 'internal', 'unknown', 'cancelled', 'aborted', 'resource-exhausted', ''])('untyped "%s" is UNCERTAIN — never "nothing was written"', async (grpc) => {
    const e = await caught(run(async () => { throw untyped(grpc) }))
    expect(e.kind).toBe(E.UNCERTAIN)
    const d = describeWriteError(e)
    expect(d.certain).toBe(false)
    expect(d.message).not.toMatch(/Nothing was (written|saved)/)
  })
  it('a plain network error with no code at all is UNCERTAIN', () => {
    expect(describeTransferFailure(new TypeError('Failed to fetch')).kind).toBe(E.UNCERTAIN)
  })
})

describe('with the shared write controller', () => {
  const settle = () => new Promise(r => setTimeout(r, 0))
  const controller = () => createWriteController({ label: 'BOQ to budget transfer', tracker: { blocks: () => false, add: () => 'w', settle() {}, remove() {}, dismiss() {} } })

  it('a stale review is a definite failure: the dialog unlocks and the same button may be used again', async () => {
    const c = controller()
    c.run(() => run(async () => { throw typed('boq-transfer-stale-review') }))
    await settle()
    expect(c.getState()).toMatchObject({ phase: WRITE_PHASE.FAILED, message: M.stale })
    expect(c.run(() => run(async () => ({ outcome: 'applied' })))).toBe(true)
  })
  it('an uncertain outcome LOCKS the dialog until acknowledged, and a duplicate submission is refused without calling', async () => {
    const c = controller()
    let calls = 0
    c.run(() => run(async () => { calls += 1; throw untyped('deadline-exceeded') }))
    await settle()
    expect(c.getState().phase).toBe(WRITE_PHASE.UNCERTAIN)
    expect(c.run(() => run(async () => { calls += 1; return { outcome: 'applied' } }))).toBe(false)
    expect(calls).toBe(1)
    expect(c.acknowledge()).toBe(true)
    let confirmed = null
    c.run(() => run(async () => { calls += 1; return { outcome: 'already-applied' } }), { onConfirmed: (v) => { confirmed = v } })
    await settle()
    expect(confirmed).toEqual({ outcome: 'already-applied' })
    expect(calls).toBe(2)
  })
  it('a second click while the call is in flight sends nothing', async () => {
    const c = controller()
    let calls = 0
    let release
    c.run(() => run(() => { calls += 1; return new Promise(r => { release = r }) }))
    expect(c.run(() => run(async () => { calls += 1 }))).toBe(false)
    release({ outcome: 'applied' })
    await settle()
    expect(calls).toBe(1)
  })
})
