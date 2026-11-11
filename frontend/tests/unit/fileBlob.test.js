import { describe, it, expect } from 'vitest'
import {
  OPEN_OUTCOME, TAB_POLL_MS, SAVE_REVOKE_DELAY_MS,
  typedBlob, downloadFileName, canShowPdfInline, opensInTab,
  createObjectUrl, prepareTab, showBlobInTab, saveBlob,
  openStoredFile, downloadStoredFile, openOutcomeNotice,
} from '../../src/lib/fileBlob.js'

// ── lib/fileBlob.js — showing and saving a file from its bytes (DC46-A) ──────
//
// The unit runner is plain Node with no jsdom (the ADR-26 convention), so the
// browser is a small FAKE passed in as `env`: a URL registry that records every
// create/revoke, timers that fire on demand, a document that records the
// anchor it was asked to click, and a window whose `open` can be made to fail.
// What is proven here is the LIFECYCLE — that a blob URL is created once,
// handed to the right place, and revoked late but never leaked or early.

const PDF = 'application/pdf'
const PNG = 'image/png'

function fakeEnv({ popupBlocked = false, pdfViewerEnabled = true } = {}) {
  const live = new Set()
  const log = { created: [], revoked: [], anchors: [], timeouts: [], intervals: new Map(), tabs: [] }
  let seq = 0
  let timerSeq = 0
  const env = {
    URL: {
      createObjectURL(blob) {
        const url = `blob:https://app.test/${++seq}`
        live.add(url)
        log.created.push({ url, blob })
        return url
      },
      revokeObjectURL(url) {
        live.delete(url)
        log.revoked.push(url)
      },
    },
    navigator: { pdfViewerEnabled },
    window: {
      open(url, target) {
        if (popupBlocked) return null
        const tab = {
          openedWith: [url, target], opener: env.window, closed: false,
          document: { title: '', body: { textContent: '' } },
          location: { replaced: null, replace(u) { this.replaced = u } },
          close() { this.closed = true },
        }
        log.tabs.push(tab)
        return tab
      },
    },
    document: {
      body: { children: [], appendChild(el) { this.children.push(el) } },
      createElement(tag) {
        const el = {
          tag, clicked: 0, removed: false,
          click() { this.clicked += 1; this.hrefLiveAtClick = live.has(this.href) },
          remove() { this.removed = true },
        }
        log.anchors.push(el)
        return el
      },
    },
    setTimeout(fn, ms) { log.timeouts.push({ fn, ms }); return ++timerSeq },
    setInterval(fn, ms) { const id = ++timerSeq; log.intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { log.intervals.delete(id) },
  }
  const tick = () => { for (const { fn } of [...log.intervals.values()]) fn() }
  return { env, log, live, tick }
}

const pdfBlob = (size = 2048, type = PDF) => new Blob([new Uint8Array(size)], { type })

// ── The blob's type ──────────────────────────────────────────────────────────

describe('typedBlob — the blob is only ever one of the three allowed types', () => {
  it('returns the same blob when the type already matches', () => {
    const blob = pdfBlob()
    expect(typedBlob(blob, PDF)).toBe(blob)
  })

  it('restores the type the SDK size cap strips (blob.slice drops it)', () => {
    const sliced = pdfBlob().slice(0, 2048)
    expect(sliced.type).toBe('')
    const typed = typedBlob(sliced, PDF)
    expect(typed.type).toBe(PDF)
    expect(typed.size).toBe(2048)
  })

  it('overrides a served type with the recorded allowed type — never renders text/html', () => {
    const typed = typedBlob(pdfBlob(64, 'text/html'), PDF)
    expect(typed.type).toBe(PDF)
  })

  it('REFUSES a recorded type outside the allow-list (html, svg, anything else)', () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream', '', null, undefined]) {
      expect(() => typedBlob(pdfBlob(), type)).toThrow(/cannot be opened/)
    }
  })

  it('refuses a missing or empty blob', () => {
    expect(() => typedBlob(null, PDF)).toThrow(/not available/)
    expect(() => typedBlob(new Blob([], { type: PDF }), PDF)).toThrow(/empty/)
  })
})

// ── Filenames ────────────────────────────────────────────────────────────────

describe('downloadFileName — the original filename is preserved', () => {
  it('keeps the uploaded filename, spaces and dots included', () => {
    expect(downloadFileName('A-101 Ground Floor.rev.B.pdf', PDF)).toBe('A-101 Ground Floor.rev.B.pdf')
  })

  it('strips path separators and control characters', () => {
    expect(downloadFileName('..\\..//etc/\u0000plan\n.pdf', PDF)).toBe('....etcplan.pdf')
  })

  it('falls back to file.{ext} from the content type', () => {
    expect(downloadFileName('', PDF)).toBe('file.pdf')
    expect(downloadFileName('   ', 'image/jpeg')).toBe('file.jpg')
    expect(downloadFileName(null, 'text/plain')).toBe('file')
  })

  it('caps the name at 255 characters', () => {
    expect(downloadFileName('x'.repeat(400), PDF)).toHaveLength(255)
  })
})

// ── Where a file can be shown ────────────────────────────────────────────────

describe('opensInTab — mobile browsers with no PDF viewer save instead', () => {
  it('a PDF opens in a tab unless the browser SAYS it has no viewer', () => {
    expect(canShowPdfInline({ pdfViewerEnabled: true })).toBe(true)
    expect(canShowPdfInline({})).toBe(true) // older browsers: flag absent
    expect(canShowPdfInline(undefined)).toBe(true)
    expect(canShowPdfInline({ pdfViewerEnabled: false })).toBe(false)
    expect(opensInTab(PDF, { pdfViewerEnabled: false })).toBe(false)
    expect(opensInTab(PDF, { pdfViewerEnabled: true })).toBe(true)
  })

  it('an image always opens in a tab; an unknown type never does', () => {
    expect(opensInTab(PNG, { pdfViewerEnabled: false })).toBe(true)
    expect(opensInTab('image/jpeg', {})).toBe(true)
    expect(opensInTab('text/html', {})).toBe(false)
  })
})

// ── Blob URL lifecycle ───────────────────────────────────────────────────────

describe('createObjectUrl — an inline preview owns exactly one URL', () => {
  it('creates one URL and revokes it exactly once, however often revoke is called', () => {
    const { env, log, live } = fakeEnv()
    const handle = createObjectUrl(pdfBlob(), env.URL)
    expect(handle.url).toMatch(/^blob:/)
    expect(live.has(handle.url)).toBe(true)
    expect(handle.revoked).toBe(false)
    handle.revoke()
    handle.revoke()
    expect(log.revoked).toEqual([handle.url])
    expect(handle.revoked).toBe(true)
    expect(live.size).toBe(0)
  })

  it('two revisions get two independent URLs — revoking one leaves the other', () => {
    const { env, live } = fakeEnv()
    const a = createObjectUrl(pdfBlob(), env.URL)
    const b = createObjectUrl(pdfBlob(), env.URL)
    a.revoke()
    expect(live.has(a.url)).toBe(false)
    expect(live.has(b.url)).toBe(true)
  })
})

describe('prepareTab — opened synchronously, detached from the app', () => {
  it('opens a blank tab, clears opener and writes a placeholder', () => {
    const { env, log } = fakeEnv()
    const tab = prepareTab(env.window)
    expect(log.tabs).toHaveLength(1)
    expect(tab.openedWith).toEqual(['', '_blank'])
    expect(tab.opener).toBeNull()
    expect(tab.document.body.textContent).toMatch(/Preparing/)
  })

  it('returns null when the popup is blocked or open() throws', () => {
    expect(prepareTab(fakeEnv({ popupBlocked: true }).env.window)).toBeNull()
    expect(prepareTab({ open() { throw new Error('nope') } })).toBeNull()
  })
})

describe('showBlobInTab — the URL lives exactly as long as the tab', () => {
  it('navigates the tab to the blob URL and does NOT revoke while it is open', () => {
    const { env, log, live, tick } = fakeEnv()
    const tab = prepareTab(env.window)
    const handle = showBlobInTab({ tab, blob: pdfBlob(), env })
    expect(tab.location.replaced).toBe(handle.url)
    expect([...log.intervals.values()][0].ms).toBe(TAB_POLL_MS)
    tick(); tick(); tick()
    expect(live.has(handle.url)).toBe(true)
    expect(log.revoked).toEqual([])
  })

  it('revokes once the tab is closed, and stops polling', () => {
    const { env, log, live, tick } = fakeEnv()
    const tab = prepareTab(env.window)
    const handle = showBlobInTab({ tab, blob: pdfBlob(), env })
    tab.close()
    tick()
    expect(live.has(handle.url)).toBe(false)
    expect(log.intervals.size).toBe(0)
    tick()
    expect(log.revoked).toEqual([handle.url])
  })

  it('a tab that can no longer be inspected counts as closed', () => {
    const { env, live, tick } = fakeEnv()
    const tab = prepareTab(env.window)
    const handle = showBlobInTab({ tab, blob: pdfBlob(), env })
    Object.defineProperty(tab, 'closed', { get() { throw new Error('detached') } })
    tick()
    expect(live.has(handle.url)).toBe(false)
  })
})

describe('saveBlob — a real download under the original filename', () => {
  it('clicks a hidden same-origin <a download> while the URL is live, then removes it', () => {
    const { env, log } = fakeEnv()
    const handle = saveBlob({ blob: pdfBlob(), fileName: 'A-101.pdf', env })
    const [a] = log.anchors
    expect(a.tag).toBe('a')
    expect(a.href).toBe(handle.url)
    expect(a.download).toBe('A-101.pdf')
    expect(a.hidden).toBe(true)
    expect(a.clicked).toBe(1)
    expect(a.hrefLiveAtClick).toBe(true)
    expect(a.removed).toBe(true)
  })

  it('does NOT revoke immediately — only after the generous delay', () => {
    const { env, log, live } = fakeEnv()
    const handle = saveBlob({ blob: pdfBlob(), fileName: 'A-101.pdf', env })
    expect(live.has(handle.url)).toBe(true)
    expect(log.timeouts).toHaveLength(1)
    expect(log.timeouts[0].ms).toBe(SAVE_REVOKE_DELAY_MS)
    expect(SAVE_REVOKE_DELAY_MS).toBeGreaterThanOrEqual(60_000)
    log.timeouts[0].fn()
    expect(live.has(handle.url)).toBe(false)
  })
})

// ── Open / Download orchestration ────────────────────────────────────────────

describe('openStoredFile', () => {
  it('AUTHORISED: opens the tab before the fetch resolves, then shows the bytes in it', async () => {
    const { env, log } = fakeEnv()
    let resolve
    const fetchBlob = () => new Promise((r) => { resolve = r })
    const pending = openStoredFile({ fetchBlob, contentType: PDF, fileName: 'spec.pdf', env })
    expect(log.tabs).toHaveLength(1) // synchronously, inside the click
    expect(log.created).toHaveLength(0)
    resolve(pdfBlob())
    expect(await pending).toBe(OPEN_OUTCOME.TAB)
    expect(log.tabs[0].location.replaced).toBe(log.created[0].url)
    expect(log.created[0].blob.type).toBe(PDF)
    expect(log.anchors).toHaveLength(0)
  })

  it('UNAUTHORISED: the placeholder tab is closed, no URL is created, the error propagates', async () => {
    const { env, log } = fakeEnv()
    const denied = new Error('You do not have permission to open this file.')
    await expect(openStoredFile({ fetchBlob: () => Promise.reject(denied), contentType: PDF, fileName: 'x.pdf', env }))
      .rejects.toBe(denied)
    expect(log.tabs[0].closed).toBe(true)
    expect(log.created).toHaveLength(0)
    expect(log.anchors).toHaveLength(0)
  })

  it('a disallowed content type is refused before anything is rendered', async () => {
    const { env, log } = fakeEnv()
    await expect(openStoredFile({ fetchBlob: async () => pdfBlob(64, 'text/html'), contentType: 'text/html', fileName: 'x.html', env }))
      .rejects.toThrow(/cannot be opened/)
    expect(log.created).toHaveLength(0)
    expect(log.tabs).toHaveLength(0)
  })

  it('POPUP BLOCKED: falls back to saving under the original filename', async () => {
    const { env, log } = fakeEnv({ popupBlocked: true })
    const outcome = await openStoredFile({ fetchBlob: async () => pdfBlob(), contentType: PDF, fileName: 'spec.pdf', env })
    expect(outcome).toBe(OPEN_OUTCOME.POPUP_BLOCKED)
    expect(log.anchors[0].download).toBe('spec.pdf')
    expect(openOutcomeNotice(outcome)).toMatch(/blocked/)
  })

  it('NO PDF VIEWER (mobile): no tab is opened at all; the PDF is saved with its real name', async () => {
    const { env, log } = fakeEnv({ pdfViewerEnabled: false })
    const outcome = await openStoredFile({ fetchBlob: async () => pdfBlob(), contentType: PDF, fileName: 'spec.pdf', env })
    expect(outcome).toBe(OPEN_OUTCOME.SAVED)
    expect(log.tabs).toHaveLength(0)
    expect(log.anchors[0].download).toBe('spec.pdf')
    expect(openOutcomeNotice(outcome)).toMatch(/cannot display PDFs/)
  })

  it('an image still opens in a tab on a browser with no PDF viewer', async () => {
    const { env, log } = fakeEnv({ pdfViewerEnabled: false })
    const outcome = await openStoredFile({ fetchBlob: async () => pdfBlob(64, PNG), contentType: PNG, fileName: 'site.png', env })
    expect(outcome).toBe(OPEN_OUTCOME.TAB)
    expect(log.tabs).toHaveLength(1)
  })

  it('the user closing the tab while the file downloads cancels quietly — nothing is created', async () => {
    const { env, log } = fakeEnv()
    let resolve
    const pending = openStoredFile({ fetchBlob: () => new Promise((r) => { resolve = r }), contentType: PDF, fileName: 'x.pdf', env })
    log.tabs[0].close()
    resolve(pdfBlob())
    const outcome = await pending
    expect(outcome).toBe(OPEN_OUTCOME.CANCELLED)
    expect(log.created).toHaveLength(0)
    expect(openOutcomeNotice(outcome)).toBeNull()
  })

  it('a successful tab open produces no notice', () => {
    expect(openOutcomeNotice(OPEN_OUTCOME.TAB)).toBeNull()
  })
})

describe('downloadStoredFile', () => {
  it('saves under the original filename and never opens a tab', async () => {
    const { env, log } = fakeEnv()
    const outcome = await downloadStoredFile({ fetchBlob: async () => pdfBlob().slice(0, 2048), contentType: PDF, fileName: 'A-101 rev B.pdf', env })
    expect(outcome).toBe(OPEN_OUTCOME.SAVED)
    expect(log.tabs).toHaveLength(0)
    expect(log.anchors[0].download).toBe('A-101 rev B.pdf')
    expect(log.created[0].blob.type).toBe(PDF)
  })

  it('a denied read saves nothing', async () => {
    const { env, log } = fakeEnv()
    await expect(downloadStoredFile({ fetchBlob: () => Promise.reject(new Error('denied')), contentType: PDF, fileName: 'x.pdf', env }))
      .rejects.toThrow('denied')
    expect(log.anchors).toHaveLength(0)
    expect(log.created).toHaveLength(0)
  })
})
