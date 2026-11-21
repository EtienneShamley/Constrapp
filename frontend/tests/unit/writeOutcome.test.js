import { describe, it, expect, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  WRITE_PHASE, WRITE_FAILURE, WRITE_MESSAGES, WRITE_CONFIRM_TIMEOUT_MS, TRACKED_STATUS,
  describeWriteError, createWriteController, createWriteTracker, writeFlags,
} from '../../src/lib/writeOutcome'
import WriteFeedback from '../../src/components/WriteFeedback'
import UnconfirmedWrites from '../../src/components/UnconfirmedWrites'

// ── Write outcome: confirmed, failed or uncertain (L3 Stage 2) ───────────────
//
// The controller is pure, so every path runs here with a hand-driven promise
// and a hand-driven timer: no Firebase, no emulator, no DOM. What this suite
// CANNOT show is a real browser going offline — TESTING.md §66 lists those
// manual checks.

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const read = (rel) => readFileSync(SRC + rel, 'utf8')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const firebaseError = (code, message = `[code=${code}]: raw SDK text`) =>
  Object.assign(new Error(message), { name: 'FirebaseError', code })

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }

// A controller with a manual timer and its own tracker.
function harness(options = {}) {
  const timers = []
  const tracker = options.tracker ?? createWriteTracker()
  const controller = createWriteController({
    label: 'Client receipt draft',
    tracker,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
    now: () => 1000,
    ...options,
  })
  const expire = () => timers.filter((t) => !t.cleared).forEach((t) => t.fn())
  return { controller, tracker, timers, expire, phase: () => controller.getState().phase }
}

describe('describeWriteError: what a thrown value says about the write', () => {
  it('a refusal is certain, and never shows the SDK text', () => {
    for (const code of ['permission-denied', 'unauthenticated', 'not-found', 'already-exists', 'aborted',
      'failed-precondition', 'invalid-argument', 'out-of-range', 'unimplemented', 'resource-exhausted']) {
      const d = describeWriteError(firebaseError(code))
      expect(d.certain, code).toBe(true)
      expect(d.message, code).toContain('Nothing was saved')
      expect(d.message, code).not.toMatch(/raw SDK|code=/)
    }
    expect(describeWriteError(firebaseError('permission-denied')).kind).toBe(WRITE_FAILURE.PERMISSION)
    expect(describeWriteError(firebaseError('firestore/permission-denied')).kind).toBe(WRITE_FAILURE.PERMISSION)
  })

  it('a network failure is NOT certain, and never claims nothing was saved', () => {
    for (const code of ['unavailable', 'deadline-exceeded', 'cancelled', 'internal', 'unknown', 'data-loss']) {
      const d = describeWriteError(firebaseError(code))
      expect(d.certain, code).toBe(false)
      expect(d.message, code).not.toContain('Nothing was saved')
      expect(d.message, code).not.toMatch(/raw SDK|code=/)
    }
    expect(describeWriteError(firebaseError('unavailable')).kind).toBe(WRITE_FAILURE.UNREACHABLE)
    expect(describeWriteError(firebaseError('unavailable')).message).toBe(WRITE_MESSAGES.unreachable)
    expect(describeWriteError(firebaseError('deadline-exceeded')).kind).toBe(WRITE_FAILURE.NO_ANSWER)
  })

  it('a Firebase error with a code this module does not know is uncertain', () => {
    const d = describeWriteError(firebaseError('something-new'))
    expect(d).toMatchObject({ certain: false, kind: WRITE_FAILURE.NO_ANSWER })
  })

  it("a hook's own validation or lifecycle refusal is certain and keeps its message", () => {
    const d = describeWriteError(new Error('Only draft receipts can be edited'))
    expect(d).toEqual({ certain: true, kind: WRITE_FAILURE.LOCAL, message: 'Only draft receipts can be edited' })
    expect(describeWriteError(null).message).toBe(WRITE_MESSAGES.local)
    expect(describeWriteError(new Error('   ')).message).toBe(WRITE_MESSAGES.local)
  })

  it('a domain error wrapping a Firestore failure is classified by its cause', () => {
    const wrapped = Object.assign(new Error('You do not have permission to change purchase orders on this project.'), {
      name: 'PoWriteError', cause: firebaseError('permission-denied'),
    })
    expect(describeWriteError(wrapped)).toMatchObject({
      certain: true, kind: WRITE_FAILURE.PERMISSION,
      message: 'You do not have permission to change purchase orders on this project.',
    })
    const offline = Object.assign(new Error('Could not reach the server … nothing was saved.'), {
      name: 'PoWriteError', cause: firebaseError('unavailable'),
    })
    // An ambiguous cause stays uncertain whatever the wrapper's wording claims.
    expect(describeWriteError(offline)).toMatchObject({ certain: false, message: WRITE_MESSAGES.unreachable })
  })
})

describe('controller: confirmed success', () => {
  it('reports success only when the write resolves, then calls onConfirmed once', async () => {
    const { controller, phase, timers } = harness()
    const d = deferred()
    const onConfirmed = vi.fn()
    expect(controller.run(() => d.promise, { onConfirmed })).toBe(true)
    expect(phase()).toBe(WRITE_PHASE.SAVING)
    await flush()
    expect(onConfirmed).not.toHaveBeenCalled()
    d.resolve('doc-1')
    await flush()
    expect(onConfirmed).toHaveBeenCalledTimes(1)
    expect(onConfirmed).toHaveBeenCalledWith('doc-1')
    expect(phase()).toBe(WRITE_PHASE.IDLE)
    expect(timers[0].cleared).toBe(true)
    expect(timers[0].ms).toBe(WRITE_CONFIRM_TIMEOUT_MS)
  })
})

describe('controller: confirmed failure', () => {
  it('permission denied is a failure, re-enables the submit and may be tried again', async () => {
    const { controller, phase } = harness()
    const onConfirmed = vi.fn()
    controller.run(() => Promise.reject(firebaseError('permission-denied')), { onConfirmed })
    await flush()
    expect(phase()).toBe(WRITE_PHASE.FAILED)
    expect(controller.getState().kind).toBe(WRITE_FAILURE.PERMISSION)
    expect(writeFlags(controller.getState()).locked).toBe(false)
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(controller.run(() => Promise.resolve())).toBe(true)
  })

  it('an operation that throws synchronously is a failure, not a crash', async () => {
    const { controller, phase } = harness()
    controller.run(() => { throw new Error('Enter a reason for voiding this receipt') })
    await flush()
    expect(phase()).toBe(WRITE_PHASE.FAILED)
    expect(controller.getState().message).toBe('Enter a reason for voiding this receipt')
  })

  it('clearFailure returns a failed dialog to idle and touches nothing else', async () => {
    const { controller, phase } = harness()
    controller.run(() => Promise.reject(new Error('no')))
    await flush()
    controller.clearFailure()
    expect(phase()).toBe(WRITE_PHASE.IDLE)
  })
})

describe('controller: a stalled write (the plain-write hang)', () => {
  it('stops showing Saving after the limit, without failing and without cancelling', async () => {
    const { controller, phase, expire } = harness()
    const d = deferred()
    const operation = vi.fn(() => d.promise)
    controller.run(operation)
    expire()
    expect(phase()).toBe(WRITE_PHASE.UNCONFIRMED)
    expect(controller.getState().message).toBe(WRITE_MESSAGES.unconfirmed)
    const flags = writeFlags(controller.getState())
    expect(flags).toMatchObject({ busy: false, waiting: true, locked: true, canAcknowledge: false })
    // The operation was started once and is still the same pending promise.
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('refuses a second submission and an acknowledgement while the write is in flight', async () => {
    const { controller, expire, phase } = harness()
    const d = deferred()
    const second = vi.fn(() => Promise.resolve())
    controller.run(() => d.promise)
    expect(controller.run(second)).toBe(false)
    expire()
    expect(controller.run(second)).toBe(false)
    expect(controller.acknowledge()).toBe(false)
    expect(phase()).toBe(WRITE_PHASE.UNCONFIRMED)
    expect(second).not.toHaveBeenCalled()
  })

  it('a LATE success after the limit is still reported as success', async () => {
    const { controller, expire, phase } = harness()
    const d = deferred()
    const onConfirmed = vi.fn()
    controller.run(() => d.promise, { onConfirmed })
    expire()
    expect(onConfirmed).not.toHaveBeenCalled()
    d.resolve('late')
    await flush()
    expect(onConfirmed).toHaveBeenCalledWith('late')
    expect(phase()).toBe(WRITE_PHASE.IDLE)
  })

  it('a LATE refusal after the limit becomes a definite failure', async () => {
    const { controller, expire, phase } = harness()
    const d = deferred()
    controller.run(() => d.promise)
    expire()
    d.reject(firebaseError('permission-denied'))
    await flush()
    expect(phase()).toBe(WRITE_PHASE.FAILED)
    expect(writeFlags(controller.getState()).locked).toBe(false)
  })

  it('never retries: the operation runs exactly once through every path', async () => {
    const { controller, expire } = harness()
    const d = deferred()
    const operation = vi.fn(() => d.promise)
    controller.run(operation)
    expire(); expire()
    d.reject(firebaseError('unavailable'))
    await flush()
    expect(operation).toHaveBeenCalledTimes(1)
  })
})

describe('controller: an uncertain outcome', () => {
  it('an unreachable server locks the submit until the user acknowledges', async () => {
    const { controller, phase } = harness()
    const again = vi.fn(() => Promise.resolve())
    controller.run(() => Promise.reject(firebaseError('unavailable')))
    await flush()
    expect(phase()).toBe(WRITE_PHASE.UNCERTAIN)
    expect(writeFlags(controller.getState())).toMatchObject({ locked: true, canAcknowledge: true, busy: false })
    expect(controller.run(again)).toBe(false)
    expect(again).not.toHaveBeenCalled()
    expect(controller.acknowledge()).toBe(true)
    expect(phase()).toBe(WRITE_PHASE.IDLE)
    expect(controller.run(again)).toBe(true)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('acknowledge does nothing unless the outcome is uncertain', () => {
    const { controller } = harness()
    expect(controller.acknowledge()).toBe(false)
  })
})

describe('controller: the dialog is closed before the server answers', () => {
  it('hands the write to the tracker and reports a late success there, not to the dialog', async () => {
    const { controller, tracker, expire } = harness()
    const d = deferred()
    const onConfirmed = vi.fn()
    controller.run(() => d.promise, { onConfirmed })
    expire()
    controller.detach()
    expect(tracker.getSnapshot()).toEqual([
      { id: 'w1', label: 'Client receipt draft', startedAt: 1000, status: TRACKED_STATUS.PENDING, message: null },
    ])
    d.resolve()
    await flush()
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(tracker.getSnapshot()[0].status).toBe(TRACKED_STATUS.CONFIRMED)
  })

  it('reports a late failure and a late uncertain outcome there too', async () => {
    for (const [code, status] of [['permission-denied', TRACKED_STATUS.FAILED], ['unavailable', TRACKED_STATUS.UNCERTAIN]]) {
      const { controller, tracker } = harness()
      const d = deferred()
      controller.run(() => d.promise)
      controller.detach()
      d.reject(firebaseError(code))
      await flush()
      expect(tracker.getSnapshot()[0].status, code).toBe(status)
      expect(tracker.getSnapshot()[0].message, code).toBeTruthy()
    }
  })

  it('a settled dialog leaves nothing in the tracker', async () => {
    const { controller, tracker } = harness()
    controller.run(() => Promise.resolve())
    await flush()
    controller.detach()
    expect(tracker.getSnapshot()).toEqual([])
  })

  it("React's development remount (detach then attach) keeps the dialog in charge", async () => {
    const { controller, tracker } = harness()
    const d = deferred()
    const onConfirmed = vi.fn()
    controller.run(() => d.promise, { onConfirmed })
    controller.detach()
    controller.attach()
    expect(tracker.getSnapshot()).toEqual([])
    d.resolve()
    await flush()
    expect(onConfirmed).toHaveBeenCalledTimes(1)
  })
})

// ── Lifecycle checks from the architect's final correction (21 Nov 2026) ─────

describe('lifecycle: closing and reopening a dialog cannot get round the guard', () => {
  it('closing a dialog during an unresolved write starts no second write', async () => {
    const { controller, expire } = harness()
    const d = deferred()
    const operation = vi.fn(() => d.promise)
    controller.run(operation)
    expire()
    controller.detach()
    d.resolve()
    await flush()
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('a REOPENED dialog of the same kind is refused while the first write is unanswered', async () => {
    const first = harness()
    const d = deferred()
    first.controller.run(() => d.promise)
    first.controller.detach()

    const reopened = harness({ tracker: first.tracker })
    const again = vi.fn(() => Promise.resolve())
    expect(reopened.controller.run(again)).toBe(false)
    expect(again).not.toHaveBeenCalled()
    expect(reopened.controller.getState()).toEqual({
      phase: WRITE_PHASE.FAILED, kind: WRITE_FAILURE.BLOCKED, message: WRITE_MESSAGES.blocked,
    })
    // Accurate wording: this attempt was not sent; nothing claims the first failed or succeeded.
    expect(WRITE_MESSAGES.blocked).toContain('was not sent')
    expect(WRITE_MESSAGES.blocked).not.toMatch(/was saved|Nothing was saved|failed/)

    // Once the SERVER confirms the first write, the kind is free again.
    d.resolve()
    await flush()
    expect(first.tracker.getSnapshot()[0].status).toBe(TRACKED_STATUS.CONFIRMED)
    expect(reopened.controller.run(again)).toBe(true)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('a different kind of write is not blocked', () => {
    const first = harness()
    first.controller.run(() => deferred().promise)
    first.controller.detach()
    const other = harness({ tracker: first.tracker, label: 'Supplier payment draft' })
    expect(other.controller.run(() => Promise.resolve())).toBe(true)
  })

  it('closing a dialog on an UNCERTAIN outcome keeps the guard; reopening is refused until the user clears it', async () => {
    const first = harness()
    first.controller.run(() => Promise.reject(firebaseError('unavailable')))
    await flush()
    expect(first.phase()).toBe(WRITE_PHASE.UNCERTAIN)
    first.controller.detach()
    expect(first.tracker.getSnapshot()).toEqual([
      { id: 'w1', label: 'Client receipt draft', startedAt: 1000, status: TRACKED_STATUS.UNCERTAIN, message: WRITE_MESSAGES.unreachable },
    ])

    const reopened = harness({ tracker: first.tracker })
    const again = vi.fn(() => Promise.resolve())
    expect(reopened.controller.run(again)).toBe(false)
    expect(again).not.toHaveBeenCalled()

    // The user's acknowledgement REMOVES the entry. It is never turned into a
    // server-confirmed success or failure.
    const statuses = []
    first.tracker.subscribe(() => statuses.push(...first.tracker.getSnapshot().map((e) => e.status)))
    first.tracker.dismiss('w1')
    expect(first.tracker.getSnapshot()).toEqual([])
    expect(statuses).not.toContain(TRACKED_STATUS.CONFIRMED)
    expect(statuses).not.toContain(TRACKED_STATUS.FAILED)
    expect(reopened.controller.run(again)).toBe(true)
  })

  it('a late uncertain result after closure also keeps the guard', async () => {
    const first = harness()
    const d = deferred()
    first.controller.run(() => d.promise)
    first.controller.detach()
    d.reject(firebaseError('deadline-exceeded'))
    await flush()
    expect(first.tracker.blocks('Client receipt draft')).toBe(true)
    const reopened = harness({ tracker: first.tracker })
    expect(reopened.controller.run(() => Promise.resolve())).toBe(false)
  })

  it('a late DEFINITE failure after closure frees the kind: nothing was written', async () => {
    const first = harness()
    const d = deferred()
    first.controller.run(() => d.promise)
    first.controller.detach()
    d.reject(firebaseError('permission-denied'))
    await flush()
    expect(first.tracker.blocks('Client receipt draft')).toBe(false)
  })

  it('five rapid submits call the operation once', async () => {
    const { controller } = harness()
    const d = deferred()
    const operation = vi.fn(() => d.promise)
    const results = [1, 2, 3, 4, 5].map(() => controller.run(operation))
    expect(results).toEqual([true, false, false, false, false])
    d.resolve()
    await flush()
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('a late settlement after closure notifies no dialog listener and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      for (const settleWith of ['resolve', 'reject']) {
        const { controller } = harness()
        const d = deferred()
        const listener = vi.fn()
        const unsubscribe = controller.subscribe(listener)
        controller.run(() => d.promise)
        const before = listener.mock.calls.length
        // What React does on unmount: unsubscribe the store, then run the effect cleanup.
        unsubscribe()
        controller.detach()
        if (settleWith === 'resolve') d.resolve(); else d.reject(firebaseError('unavailable'))
        await flush()
        await new Promise((r) => setTimeout(r, 0))
        expect(listener.mock.calls.length, settleWith).toBe(before)
      }
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('the waiting limit is only a timer: nothing in the controller can cancel the operation', () => {
    const src = stripComments(read('lib/writeOutcome.js'))
    expect(src).not.toMatch(/AbortController|\.abort\(|\.cancel\(|terminate|disableNetwork/)
  })
})

describe('tracker', () => {
  it('a pending write cannot be dismissed; a settled one can', () => {
    const tracker = createWriteTracker()
    const seen = vi.fn()
    tracker.subscribe(seen)
    const id = tracker.add({ label: 'Supplier payment draft', startedAt: 1 })
    tracker.dismiss(id)
    expect(tracker.getSnapshot()).toHaveLength(1)
    tracker.settle(id, TRACKED_STATUS.CONFIRMED)
    tracker.dismiss(id)
    expect(tracker.getSnapshot()).toHaveLength(0)
    expect(seen).toHaveBeenCalledTimes(4)
  })
})

describe('rendered feedback', () => {
  const view = (state) => renderToStaticMarkup(h(WriteFeedback, { write: { ...state, ...writeFlags(state), acknowledge: () => {} } }))

  it('renders nothing while idle or saving', () => {
    expect(view({ phase: WRITE_PHASE.IDLE, message: null })).toBe('')
    expect(view({ phase: WRITE_PHASE.SAVING, message: null })).toBe('')
  })

  it('a failure is red and offers no acknowledgement', () => {
    const html = view({ phase: WRITE_PHASE.FAILED, message: 'Nope. Nothing was saved.' })
    expect(html).toContain('text-brand-red')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('<button')
  })

  it('an unanswered write is amber and offers no acknowledgement', () => {
    const html = view({ phase: WRITE_PHASE.UNCONFIRMED, message: WRITE_MESSAGES.unconfirmed })
    expect(html).toContain('text-brand-amber')
    expect(html).not.toContain('<button')
  })

  it('only a settled uncertain outcome offers the acknowledgement', () => {
    const html = view({ phase: WRITE_PHASE.UNCERTAIN, message: WRITE_MESSAGES.unreachable })
    expect(html).toContain('text-brand-amber')
    expect(html).toContain('I have checked the list')
  })

  it('the page notice lists tracked writes and only settled ones can be dismissed', () => {
    const tracker = createWriteTracker()
    expect(renderToStaticMarkup(h(UnconfirmedWrites, { tracker }))).toBe('')
    const a = tracker.add({ label: 'Client receipt draft', startedAt: 1 })
    tracker.add({ label: 'Supplier payment posting', startedAt: 2 })
    tracker.settle(a, TRACKED_STATUS.CONFIRMED)
    const html = renderToStaticMarkup(h(UnconfirmedWrites, { tracker }))
    expect(html).toContain('Client receipt draft')
    expect(html).toContain('was saved')
    expect(html).toContain('do not enter it again')
    expect(html.match(/Dismiss/g)).toHaveLength(1)
    // An uncertain entry is cleared by the user's own statement, worded as such.
    tracker.add({ label: 'Client invoice void', startedAt: 3, status: TRACKED_STATUS.UNCERTAIN })
    const withUncertain = renderToStaticMarkup(h(UnconfirmedWrites, { tracker }))
    expect(withUncertain).toContain('it may or may not have been saved')
    expect(withUncertain).toContain('I have checked the list')
    expect(withUncertain.match(/Dismiss/g)).toHaveLength(1)
    expect(html).toContain('data-print-hide')
  })
})

// ── Wiring, as source structure (the ADR-26 convention) ─────────────────────

const APPLIED = {
  'pages/project/ProjectClientInvoices.jsx':   ['Client invoice draft', 'Client invoice void', 'Client invoice issue'],
  'pages/project/ProjectClientReceipts.jsx':   ['Client receipt draft', 'Client receipt posting', 'Client receipt void'],
  'pages/project/ProjectSupplierPayments.jsx': ['Supplier payment draft', 'Supplier payment posting', 'Supplier payment void'],
}

describe('the helper is pure and never writes or retries by itself', () => {
  it('lib/writeOutcome.js imports nothing and touches no Firestore API', () => {
    const src = stripComments(read('lib/writeOutcome.js'))
    expect(src).not.toMatch(/^import /m)
    expect(src).not.toMatch(/firebase|addDoc|setDoc|updateDoc|runTransaction|writeBatch|onSnapshot/)
  })

  it('the hook and both components reach no Firestore API either', () => {
    for (const f of ['hooks/useWriteAction.jsx', 'components/WriteFeedback.jsx', 'components/UnconfirmedWrites.jsx']) {
      expect(stripComments(read(f)), f).not.toMatch(/firebase|addDoc|setDoc|updateDoc|runTransaction|writeBatch/)
    }
  })

  it('the controller calls the operation in exactly one place', () => {
    expect(stripComments(read('lib/writeOutcome.js')).match(/operation\(\)/g)).toHaveLength(1)
  })

  it('the app shell mounts the page-level notice once', () => {
    expect(stripComments(read('layouts/AppShell.jsx')).match(/<UnconfirmedWrites \/>/g)).toHaveLength(1)
  })
})

describe('the three money registers use the helper for every write they start', () => {
  for (const [file, labels] of Object.entries(APPLIED)) {
    it(`${file}: one useWriteAction per write, no hand-rolled saving state`, () => {
      const src = stripComments(read(file))
      for (const label of labels) expect(src, label).toContain(`useWriteAction('${label}')`)
      expect(src.match(/useWriteAction\('/g)).toHaveLength(labels.length)
      expect(src).not.toMatch(/setSaving|\bsaving\b|setError\(|err\?\.message/)
      // No write is awaited by the page: success is only ever onConfirmed.
      expect(src).not.toMatch(/await on(Save|Confirm)\(/)
      expect(src.match(/\{ onConfirmed: onClose \}/g)).toHaveLength(labels.filter((l) => !l.endsWith('issue')).length)
    })

    it(`${file}: submit is disabled by write.locked and Cancel stays usable once waiting`, () => {
      const src = stripComments(read(file))
      const dialogs = labels.filter((l) => !l.endsWith('issue')).length
      expect(src.match(/disabled=\{write\.locked \|\| /g)).toHaveLength(dialogs)
      expect(src.match(/disabled=\{write\.busy\}>\{write\.waiting \? 'Close' : 'Cancel'\}/g)).toHaveLength(dialogs)
      expect(src.match(/<WriteFeedback write=\{write\} \/>/g)).toHaveLength(dialogs)
    })
  }

  it('the page-level Issue action refuses a second click while one is unanswered', () => {
    const src = stripComments(read('pages/project/ProjectClientInvoices.jsx'))
    expect(src).toContain('if (issueWrite.locked) return')
    expect(src).toContain('issueWrite.run(() => issueClientInvoice(invoice))')
  })

  it('the data hooks behind them were not changed: same transactions, no retry loop', () => {
    for (const f of ['hooks/useClientInvoices.jsx', 'hooks/useClientReceipts.jsx', 'hooks/useSupplierPayments.jsx']) {
      const src = stripComments(read(f))
      expect(src, f).not.toMatch(/writeOutcome|useWriteAction|retry/i)
      expect(src.match(/runTransaction\(db/g), f).toHaveLength(1)
    }
  })
})

// The rollout inventory: every page or dialog that still awaits a write with a
// hand-rolled `setSaving(true)`. The count is pinned so a later rollout (or a
// new dialog written the old way) has to update TESTING.md §66 with it.
describe('remaining call sites are known', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsx') ? [p] : []
  })
  const remaining = walk(`${SRC}pages`)
    .map((p) => [p.slice(SRC.length), (stripComments(readFileSync(p, 'utf8')).match(/setSaving\(true\)/g) || []).length])
    .filter(([, n]) => n > 0)

  it('42 files and 58 hand-rolled saving states remain outside the helper', () => {
    expect(remaining.length).toBe(42)
    expect(remaining.reduce((a, [, n]) => a + n, 0)).toBe(58)
    for (const f of Object.keys(APPLIED)) expect(remaining.map(([p]) => p)).not.toContain(f)
  })
})
