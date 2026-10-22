import { describe, it, expect } from 'vitest'
import {
  SELECTION_VERSION, selectionStorageKey, parseSavedSelection, readSelection, writeSelection, clearSelection,
  selectableDrawing, effectivePage,
} from '../../src/lib/quantSelection.js'

// ── lib/quantSelection.js — the Quant workspace remembers its sheet ──────────
//
// Pure: a Map-backed stand-in plays sessionStorage, so these run in plain
// Node. The scenarios mirror the user's: leave the tab and come back, refresh,
// open another project, come back to a drawing that has since been withdrawn.

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    get size() { return m.size },
    keys: () => [...m.keys()],
  }
}
const throwingStorage = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceededError') },
  removeItem: () => { throw new Error('SecurityError') },
}

const drawings = [
  { id: 'd-a201', drawingNumber: 'A-201', status: 'active', currentRevisionId: 'r-a201-a' },
  { id: 'd-a101', drawingNumber: 'A-101', status: 'active', currentRevisionId: 'r-a101-b' },
  { id: 'd-gone', drawingNumber: 'A-900', status: 'withdrawn', currentRevisionId: 'r-gone-a' },
]
const revisions = [
  { id: 'r-a101-b', status: 'current' },
  { id: 'r-a101-a', status: 'superseded' },
  { id: 'r-a101-p1', status: 'withdrawn' },
]

describe('storage key and shape', () => {
  it('the key is scoped to the project id', () => {
    expect(selectionStorageKey('p1')).toBe('constrapp.quant.selection.p1')
    expect(selectionStorageKey('p1')).not.toBe(selectionStorageKey('p2'))
  })
  it('parses only the versioned shape with a usable drawing id; page defaults to 1; junk is null', () => {
    expect(parseSavedSelection(JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd', revisionId: null, page: 3 })))
      .toEqual({ drawingId: 'd', revisionId: null, page: 3 })
    expect(parseSavedSelection(JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd' }))).toEqual({ drawingId: 'd', revisionId: null, page: 1 })
    expect(parseSavedSelection(JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd', page: 0 }))).toEqual({ drawingId: 'd', revisionId: null, page: 1 })
    expect(parseSavedSelection(JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd', page: 2.5 }))).toEqual({ drawingId: 'd', revisionId: null, page: 1 })
    for (const junk of [null, undefined, '', 'not json', '[]', '42', JSON.stringify({ v: 99, drawingId: 'd' }),
      JSON.stringify({ v: SELECTION_VERSION }), JSON.stringify({ v: SELECTION_VERSION, drawingId: '' }),
      JSON.stringify({ v: SELECTION_VERSION, drawingId: 'a/b' }), JSON.stringify({ v: SELECTION_VERSION, drawingId: 'd', revisionId: 7 }),
      JSON.stringify({ v: SELECTION_VERSION, drawingId: 'x'.repeat(129) })]) {
      expect(parseSavedSelection(junk), String(junk)).toBeNull()
    }
  })
})

describe('Quant → BOQ → Quant, and refresh — the same project reads back what was written', () => {
  it('a written selection is read back from a fresh read (the workspace remounts; the tab survives)', () => {
    const storage = fakeStorage()
    expect(writeSelection(storage, 'p1', { drawingId: 'd-a201', revisionId: null, page: 1 })).toBe(true)
    // Leaving the tab unmounts the workspace; coming back reads once more.
    expect(readSelection(storage, 'p1')).toEqual({ drawingId: 'd-a201', revisionId: null, page: 1 })
    // A browser refresh keeps sessionStorage for the tab: the same read, the same answer.
    expect(readSelection(storage, 'p1')).toEqual({ drawingId: 'd-a201', revisionId: null, page: 1 })
  })
  it('an explicit revision and page are remembered as such', () => {
    const storage = fakeStorage()
    writeSelection(storage, 'p1', { drawingId: 'd-a101', revisionId: 'r-a101-a', page: 2 })
    expect(readSelection(storage, 'p1')).toEqual({ drawingId: 'd-a101', revisionId: 'r-a101-a', page: 2 })
  })
  it('the last write wins; "no drawing" clears the entry rather than storing nothing-as-something', () => {
    const storage = fakeStorage()
    writeSelection(storage, 'p1', { drawingId: 'd-a201' })
    writeSelection(storage, 'p1', { drawingId: 'd-a101', page: 2 })
    expect(readSelection(storage, 'p1')).toEqual({ drawingId: 'd-a101', revisionId: null, page: 2 })
    writeSelection(storage, 'p1', { drawingId: null })
    expect(readSelection(storage, 'p1')).toBeNull()
    expect(storage.size).toBe(0)
    writeSelection(storage, 'p1', { drawingId: 'd-a201' })
    clearSelection(storage, 'p1')
    expect(storage.size).toBe(0)
  })
  it('an invalid revision id or page is written as "current" / page 1, never as junk', () => {
    const storage = fakeStorage()
    writeSelection(storage, 'p1', { drawingId: 'd-a201', revisionId: 'a/b', page: -4 })
    expect(readSelection(storage, 'p1')).toEqual({ drawingId: 'd-a201', revisionId: null, page: 1 })
  })
})

describe('project switching — nothing leaks between projects', () => {
  it('each project has its own entry; another project reads null, and writing one never touches the other', () => {
    const storage = fakeStorage()
    writeSelection(storage, 'project-A', { drawingId: 'd-a201', page: 1 })
    expect(readSelection(storage, 'project-B')).toBeNull()
    writeSelection(storage, 'project-B', { drawingId: 'd-a101', revisionId: 'r-a101-a', page: 2 })
    expect(readSelection(storage, 'project-A')).toEqual({ drawingId: 'd-a201', revisionId: null, page: 1 })
    expect(readSelection(storage, 'project-B')).toEqual({ drawingId: 'd-a101', revisionId: 'r-a101-a', page: 2 })
    clearSelection(storage, 'project-B')
    expect(readSelection(storage, 'project-A')).toEqual({ drawingId: 'd-a201', revisionId: null, page: 1 })
    expect(storage.keys()).toEqual(['constrapp.quant.selection.project-A'])
  })
  it('a missing or unusable project id reads nothing and writes nothing', () => {
    const storage = fakeStorage()
    expect(readSelection(storage, null)).toBeNull()
    expect(readSelection(storage, '')).toBeNull()
    expect(writeSelection(storage, undefined, { drawingId: 'd' })).toBe(false)
    expect(writeSelection(storage, 'a/b', { drawingId: 'd' })).toBe(false)
    expect(storage.size).toBe(0)
  })
})

describe('a browser without usable storage — the page still works', () => {
  it('no storage → null / false; a throwing storage → null / false, never an exception', () => {
    expect(readSelection(null, 'p1')).toBeNull()
    expect(readSelection(undefined, 'p1')).toBeNull()
    expect(writeSelection(null, 'p1', { drawingId: 'd' })).toBe(false)
    expect(readSelection(throwingStorage, 'p1')).toBeNull()
    expect(writeSelection(throwingStorage, 'p1', { drawingId: 'd' })).toBe(false)
    expect(clearSelection(throwingStorage, 'p1')).toBe(false)
  })
})

describe('validation against LOADED records — a saved id is intent, not fact', () => {
  it('a saved drawing is restored only when the register has settled and lists it as not withdrawn', () => {
    expect(selectableDrawing(drawings, 'd-a201')).toBe(drawings[0])
    expect(selectableDrawing(drawings, 'd-a201', { settled: false })).toBeNull()   // still loading → nothing yet
    expect(selectableDrawing(drawings, 'd-gone')).toBeNull()                        // withdrawn → not offered, not restored
    expect(selectableDrawing(drawings, 'd-missing')).toBeNull()                     // deleted / another project's id
    expect(selectableDrawing([], 'd-a201')).toBeNull()
    expect(selectableDrawing(null, 'd-a201')).toBeNull()
    expect(selectableDrawing(drawings, null)).toBeNull()
    expect(selectableDrawing(drawings, '')).toBeNull()
  })
  // The workspace's own (inlined) lookup for an explicit revision — mirrored here so the rule is pinned.
  const chosenRevision = (list, id, { settled = true } = {}) => (settled && id ? list.find(r => r.id === id) ?? null : null)
  it('an explicit revision is restored only from the loaded list; withdrawn and superseded ARE listed (inspectable), unknown is not', () => {
    expect(chosenRevision(revisions, 'r-a101-a')).toBe(revisions[1])
    expect(chosenRevision(revisions, 'r-a101-p1')).toBe(revisions[2])
    expect(chosenRevision(revisions, 'r-a101-a', { settled: false })).toBeNull()
    expect(chosenRevision(revisions, 'r-deleted')).toBeNull()
    expect(chosenRevision(revisions, null)).toBeNull()
    expect(chosenRevision([], 'r-a101-a')).toBeNull()
  })
  it('the page follows the saved revision; it resets to 1 when an explicit revision could not be honoured', () => {
    const chosen = revisions[1]
    expect(effectivePage({ page: 2, revisionId: 'r-a101-a', chosen, settled: true })).toBe(2)
    expect(effectivePage({ page: 2, revisionId: null, chosen: null, settled: true })).toBe(2)         // "current" — page kept
    expect(effectivePage({ page: 2, revisionId: 'r-deleted', chosen: null, settled: true })).toBe(1) // saved revision gone
    expect(effectivePage({ page: 2, revisionId: 'r-a101-a', chosen: null, settled: false })).toBe(2) // not decided yet
    expect(effectivePage({ page: 0, revisionId: null, chosen: null, settled: true })).toBe(1)
    expect(effectivePage({ page: 'x', revisionId: null, chosen: null, settled: true })).toBe(1)
  })
  it('valid default — nothing saved means no drawing, the current revision and page 1', () => {
    const storage = fakeStorage()
    const saved = readSelection(storage, 'p1')
    expect(saved).toBeNull()
    expect(selectableDrawing(drawings, saved?.drawingId ?? null)).toBeNull()
    expect(chosenRevision(revisions, saved?.revisionId ?? null)).toBeNull()
    expect(effectivePage({ page: saved?.page ?? 1, revisionId: saved?.revisionId ?? null, chosen: null, settled: true })).toBe(1)
  })
  it('end to end: the remembered sheet is re-selected; a remembered WITHDRAWN drawing is not; a remembered deleted revision falls back to current with page 1', () => {
    const storage = fakeStorage()
    writeSelection(storage, 'p1', { drawingId: 'd-a101', revisionId: 'r-a101-a', page: 2 })
    let saved = readSelection(storage, 'p1')
    expect(selectableDrawing(drawings, saved.drawingId)?.id).toBe('d-a101')
    expect(chosenRevision(revisions, saved.revisionId)?.id).toBe('r-a101-a')
    expect(effectivePage({ page: saved.page, revisionId: saved.revisionId, chosen: revisions[1], settled: true })).toBe(2)

    writeSelection(storage, 'p1', { drawingId: 'd-gone', revisionId: null, page: 1 })
    saved = readSelection(storage, 'p1')
    expect(selectableDrawing(drawings, saved.drawingId)).toBeNull()

    writeSelection(storage, 'p1', { drawingId: 'd-a101', revisionId: 'r-deleted', page: 2 })
    saved = readSelection(storage, 'p1')
    const chosen = chosenRevision(revisions, saved.revisionId)
    expect(chosen).toBeNull()
    expect(effectivePage({ page: saved.page, revisionId: saved.revisionId, chosen, settled: true })).toBe(1)
  })
})
