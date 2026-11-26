import { describe, it, expect } from 'vitest'
import {
  LEDGER_KIND, LEDGER_TOTAL_KEYS,
  emptyLedger, readLedger, ledgerInvariantError, ledgerPosition,
  allocateCredit, allocateRelease, creditNoteCents,
  applyCredit, applyCreditVoid, applyRelease, applyReleaseVoid,
  applyReceipt, applyReceiptVoid, ledgerRemainingCents, ledgerStateProblem, storedLedgerProblem,
  ledgerDocument, expectedLedgerTotals, ledgerDisagreement,
} from '../../src/lib/clientLedger'
import {
  gstForLine, invoiceTotals, invoiceRetention, hasRetention,
  retentionError, retentionFromPercent,
} from '../../src/lib/clientInvoices'
import { buildClientCreditNote, clientCreditException, invoicesById } from '../../src/lib/clientCreditNotes'
import { buildClientRetentionRelease } from '../../src/lib/clientRetention'

// ── The client-invoice receivable ledger (ADR-87 / ADR-88) — pure tests ──────
//
// The load-bearing properties proven below:
//   1. A FULL CREDIT REVERSES WHAT THE INVOICE STORES — including a legacy line
//      whose stored GST is one cent low (40.15 → 4.01, never 4.02).
//   2. PARTIAL CREDITS AND PARTIAL RELEASES TELESCOPE: any split sums exactly
//      to the stored line GST / the stored retention GST.
//   3. EVERY STATE AN ALLOCATION PRODUCES SATISFIES THE LEDGER INVARIANTS, in
//      every credit × retention order, and reconciles exactly.
//   4. A FULL CREDIT OF A RETAINED INVOICE clears exactly the retention still
//      held: held → 0 and the receivable basis → 0.
//   5. RETENTION GST OF A CREDIT (the third and final rule): after a credit the
//      retention GST still HELD is the retained fraction of the GST STILL
//      BILLED, never more than was held before, and nil once no ex-GST
//      retention is held. Crediting a GST-free line of a mixed-tax invoice
//      frees no retention GST; crediting a taxable line frees its retained share.
//   6. THERE IS NO UPPER LIMIT. Retention, credit and release arithmetic is
//      exact on invoices of 250,000,000.00 and 9,999,999,999.99.
//
// Every expected figure comes from an INDEPENDENT ORACLE written below: decimal
// STRINGS parsed to BigInt cents, decimal round-half-up by quotient and
// remainder. It imports nothing from src/lib and uses no floating point.
//
//   7. A CREDIT NEVER RAISES THE RECEIVABLE BASIS — strictly, with no one-cent
//      allowance: the receivable part of every credit is ≥ 0. Argued in full
//      in the describe "a credit never raises the receivable", and measured
//      by the property test.

// ── Oracle helpers (strings + BigInt only) ───────────────────────────────────

function parseCents(text) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!m) throw new Error(`not a two-decimal amount: ${text}`)
  const magnitude = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] === '-' ? -magnitude : magnitude
}
// A stored two-decimal number as BigInt cents, through its decimal string.
const cents = (n) => parseCents(Number(n || 0).toFixed(2))

function lcg(seed) {
  let state = BigInt(seed)
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn
    return Number(state >> 33n)
  }
}
const below = (next, n) => next() % n
// A draw below n for n beyond 31 bits (two draws, 62 bits).
const wideBelow = (next, n) => Number((BigInt(next()) * 2147483648n + BigInt(next())) % BigInt(n))

// 4015n → "40.15".
function centsText(value) {
  const sign = value < 0n ? '-' : ''
  const magnitude = value < 0n ? -value : value
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`
}

// Decimal round-half-up of num ÷ den (non-negative num, positive den).
function halfUp(num, den) {
  const q = num / den
  return (num % den) * 2n >= den ? q + 1n : q
}
const share = (total, part, whole) => (whole <= 0n || part <= 0n || total <= 0n ? 0n : halfUp(total * part, whole))
const least = (...xs) => xs.reduce((a, b) => (b < a ? b : a))
const most = (...xs) => xs.reduce((a, b) => (b > a ? b : a))

// ── The oracle: one invoice and everything posted against it ─────────────────
//
//   specs          — [amountText, taxCode, storedGstText?] per line
//   retentionText  — the ex-GST retention withheld
//
// S, G  the subtotal and GST (sums of the lines);  R, RG  the retention and its
// GST (RG = the share of G that R is of S).  cS, cG, cR, cRG  credited subtotal,
// GST, retention part and retention GST part;  rel, relG  released.
//
// `previousRule: true` reproduces the rule BEFORE the rounding-direction
// correction (half-up shares, no step down) — used only to reproduce the
// historical counterexamples.
function oracleBook(specs, retentionText = '0.00', { previousRule = false } = {}) {
  const lines = specs.map(([amountText, taxCode, storedGst]) => {
    const amount = parseCents(amountText)
    const gst = storedGst !== undefined ? parseCents(storedGst) : taxCode === 'gst' ? halfUp(amount, 10n) : 0n
    return { amount, gst, credited: 0n, creditedGst: 0n }
  })
  const S = lines.reduce((sum, l) => sum + l.amount, 0n)
  const G = lines.reduce((sum, l) => sum + l.gst, 0n)
  const R = parseCents(retentionText)
  const o = { S, G, R, RG: share(G, R, S), cS: 0n, cG: 0n, cR: 0n, cRG: 0n, rel: 0n, relG: 0n }
  const heldEx = () => o.R - o.rel - o.cR
  const heldGst = () => o.RG - o.relG - o.cRG
  // What is receivable before receipts: billed and not credited, less held.
  const basis = () => (o.S - o.cS - heldEx()) + (o.G - o.cG - heldGst())
  // I4: the most retention GST the retention held may carry — the retained
  // fraction of the GST still billed.
  const retainedShare = () => share(o.G - o.cG, heldEx(), o.S - o.cS)
  return {
    o, lines, heldEx, heldGst, basis, retainedShare,
    // rows — [lineIndex, amountText].
    credit(rows) {
      let subtotal = 0n
      let gst = 0n
      const parts = []
      for (const [index, amountText] of rows) {
        const l = lines[index]
        const amount = parseCents(amountText)
        const after = l.credited + amount
        if (after > l.amount) throw new Error('oracle: over-credit')
        // Cumulative share of the line's STORED GST; all of it when full.
        const cumulative = after === l.amount ? l.gst : share(l.gst, after, l.amount)
        const lineGst = least(most(0n, cumulative - l.creditedGst), l.gst - l.creditedGst)
        parts.push([index, amount, lineGst])
        subtotal += amount
        gst += lineGst
      }
      // RETENTION, ex-GST: the fraction of the retention still held that the
      // credit is of the amount still billed; the credit that takes everything
      // still billed takes everything held. Never below what I3 requires.
      const stillBilled = o.S - o.cS
      const final = subtotal === stillBilled
      const floor = most(0n, o.cS + subtotal - o.cR - (o.S - o.R + o.rel))
      // ITS GST, for a given ex-GST retention part: what is left HELD is the
      // retained fraction of the GST still billed — never more than was held,
      // nil once nothing is held ex-GST.
      const retentionGstFor = (part) => {
        const heldExAfter = heldEx() - part
        const heldGstAfter = heldExAfter === 0n
          ? 0n
          : least(heldGst(), share(o.G - o.cG - gst, heldExAfter, stillBilled - subtotal))
        return heldGst() - heldGstAfter
      }
      let retention = final
        ? heldEx()
        : most(least(share(heldEx(), subtotal, stillBilled), heldEx(), subtotal), floor)
      let retentionGst = retentionGstFor(retention)
      const halfUp = { retention, retentionGst }
      // ROUNDING DIRECTION: when the two half-up roundings together exceed the
      // credit, the ex-GST part steps DOWN a cent at a time — never below the
      // I3 floor, never on the final credit — until the part fits in the credit.
      if (!previousRule) {
        while (!final && retention + retentionGst > subtotal + gst && retention > floor) {
          retention -= 1n
          retentionGst = retentionGstFor(retention)
        }
      }
      for (const [index, amount, lineGst] of parts) {
        lines[index].credited += amount
        lines[index].creditedGst += lineGst
      }
      o.cS += subtotal; o.cG += gst; o.cR += retention; o.cRG += retentionGst
      return { subtotal, gst, retention, retentionGst, parts, floor, final, halfUp }
    },
    release(amountText) {
      const amount = parseCents(amountText)
      if (amount > heldEx()) throw new Error('oracle: over-release')
      // The same rule as a credit's: what is left HELD is the retained fraction
      // of the GST still billed, never more than was held; the release takes
      // the rest, and the release of everything held takes it all.
      const heldGstAfter = amount === heldEx()
        ? 0n
        : least(heldGst(), share(o.G - o.cG, heldEx() - amount, o.S - o.cS))
      const gst = heldGst() - heldGstAfter
      o.rel += amount; o.relG += gst
      return { amount, gst }
    },
    voidCredit(credit) {
      for (const [index, amount, lineGst] of credit.parts) {
        lines[index].credited -= amount
        lines[index].creditedGst -= lineGst
      }
      o.cS -= credit.subtotal; o.cG -= credit.gst; o.cR -= credit.retention; o.cRG -= credit.retentionGst
    },
    voidRelease(release) { o.rel -= release.amount; o.relG -= release.gst },
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A line as the editor authors it today (exact GST). `storedGst` overrides the
// GST to model a line stored before ADR-86.
const line = (amount, taxCode = 'gst', storedGst = undefined) => ({
  description: 'Work', amount, taxCode,
  gstAmount: storedGst === undefined ? gstForLine(amount, taxCode) : storedGst,
  variationId: null, variationNumber: '', costCodeId: null, costCodeName: null,
})

// An issued invoice built through the REAL invoiceTotals(), so the fixture
// cannot drift from production arithmetic.
function invoice(lines, retention = 0, over = {}) {
  return {
    id: 'inv1', invoiceNumber: 'CI-0001', status: 'issued',
    clientId: 'client1', clientName: 'Acme Developments', currency: 'AUD',
    lineItems: lines,
    ...invoiceTotals(lines, retention),
    ...over,
  }
}

// Splits whole cents into n near-equal positive pieces.
function pieces(totalCents, n) {
  const base = Math.floor(totalCents / n)
  const extra = totalCents - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

const totalsOf = (ledger) => Object.fromEntries(LEDGER_TOTAL_KEYS.map(k => [k, ledger[k]]))

// A running book for one invoice: builds each entry through the REAL builders
// against the current ledger, applies it, and asserts the invariants hold.
function book(inv) {
  let ledger = emptyLedger()
  let n = 0
  const credits = []
  const releases = []
  return {
    get ledger() { return ledger },
    credits,
    releases,
    position: () => ledgerPosition(inv, ledger),
    credit(rows) {
      const built = buildClientCreditNote(inv, ledger, rows)
      if (built.error) return built
      n += 1
      const cn = {
        id: `cn${n}`, creditNumber: `CCN-${n}`, status: 'posted',
        clientInvoiceId: inv.id, clientId: inv.clientId, currency: inv.currency,
        lineItems: built.lineItems, ...built.totals, ledgerSeq: built.ledgerSeq,
      }
      // HARD: whatever allocateCredit accepts must satisfy every invariant and
      // leave a receivable basis that is not negative.
      ledger = applyCredit(ledger, cn)
      expect(ledgerInvariantError(inv, ledger)).toBeNull()
      expect(ledgerPosition(inv, ledger).receivableBasisCents).toBeGreaterThanOrEqual(0)
      credits.push(cn)
      return cn
    },
    release(amount) {
      const built = buildClientRetentionRelease(inv, ledger, amount)
      if (built.error) return built
      n += 1
      const r = { id: `rr${n}`, releaseNumber: `CRR-${n}`, status: 'posted', clientInvoiceId: inv.id, ...built }
      ledger = applyRelease(ledger, r)
      expect(ledgerInvariantError(inv, ledger)).toBeNull()
      expect(ledgerPosition(inv, ledger).receivableBasisCents).toBeGreaterThanOrEqual(0)
      releases.push(r)
      return r
    },
    // Returns the invariant error and leaves the book untouched when refused.
    voidCredit(cn) {
      const next = applyCreditVoid(ledger, cn)
      const broken = ledgerInvariantError(inv, next)
      if (broken) return broken
      ledger = next
      credits.splice(credits.indexOf(cn), 1)
      return null
    },
    voidRelease(r) {
      const next = applyReleaseVoid(ledger, r)
      const broken = ledgerInvariantError(inv, next)
      if (broken) return broken
      ledger = next
      releases.splice(releases.indexOf(r), 1)
      return null
    },
  }
}

// The standard retained invoice of the combination tests:
//   subtotal 1000.00 · GST 100.00 · gross 1100.00
//   retention 100.00 · retention GST 10.00 · withheld 110.00 · receivable 990.00
const retained = () => invoice([line(1000)], 100)

// The library and the oracle, step for step. The invoice is built through the
// real invoiceTotals() from the same decimal strings the oracle parses; every
// entry is built by the real builders, compared with the oracle's own figures,
// applied, and the six ledger totals, the held retention and the receivable
// basis compared again. A void the invariants refuse is returned, not applied.
function lockstep(specs, retentionText = '0.00', over = {}) {
  const inv = invoice(
    specs.map(([amountText, taxCode, storedGst]) =>
      line(Number(amountText), taxCode, storedGst === undefined ? undefined : Number(storedGst))),
    Number(retentionText), over)
  const o = oracleBook(specs, retentionText)
  const b = book(inv)
  expect([cents(inv.subtotal), cents(inv.gstTotal), cents(inv.retention), cents(inv.retentionGst)])
    .toEqual([o.o.S, o.o.G, o.o.R, o.o.RG])
  const agree = () => {
    const L = b.ledger
    expect([
      L.creditedSubtotalCents, L.creditedGstCents, L.creditedRetentionCents, L.creditedRetentionGstCents,
      L.releasedRetentionCents, L.releasedRetentionGstCents,
    ].map(BigInt)).toEqual([o.o.cS, o.o.cG, o.o.cR, o.o.cRG, o.o.rel, o.o.relG])
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents, p.receivableBasisCents].map(BigInt))
      .toEqual([o.heldEx(), o.heldGst(), o.basis()])
  }
  agree()
  return {
    inv, o, b,
    // rows — [lineIndex, amountText].
    credit(rows) {
      const basisBefore = o.basis()
      const expected = o.credit(rows)
      const cn = b.credit(rows.map(([invoiceLineIndex, amountText]) => ({ invoiceLineIndex, amount: Number(amountText) })))
      expect(cn.error).toBeUndefined()
      expect([cents(cn.subtotal), cents(cn.gstTotal), cents(cn.retentionAmount), cents(cn.retentionGst)])
        .toEqual([expected.subtotal, expected.gst, expected.retention, expected.retentionGst])
      expect(cn.lineItems.map(li => [li.invoiceLineIndex, cents(li.amount), cents(li.gstAmount)]))
        .toEqual([...expected.parts].sort((x, y) => x[0] - y[0]))
      agree()
      return { cn, expected, basisBefore, basisAfter: o.basis() }
    },
    release(amountText) {
      const expected = o.release(amountText)
      const r = b.release(Number(amountText))
      expect(r.error).toBeUndefined()
      expect([cents(r.amount), cents(r.gstAmount), cents(r.releaseTotal)])
        .toEqual([expected.amount, expected.gst, expected.amount + expected.gst])
      agree()
      return { r, expected }
    },
    voidCredit(entry) {
      const refused = b.voidCredit(entry.cn)
      if (!refused) { o.voidCredit(entry.expected); agree() }
      return refused
    },
    voidRelease(entry) {
      const refused = b.voidRelease(entry.r)
      if (!refused) { o.voidRelease(entry.expected); agree() }
      return refused
    },
  }
}

// The evidence table of a scenario, twice: from the library and from the
// oracle. One row per CREDIT, as two-decimal strings:
//
//   [ credit subtotal, credit GST, retention part ex-GST, retention GST part,
//     basis before, basis after, retention held after ex-GST, retention GST held after ]
//
//   steps — ['credit', rows] | ['release', amountText] | ['voidRelease', stepIndex]
function creditTables(specs, retentionText, steps) {
  const run = lockstep(specs, retentionText)
  const made = []
  const library = []
  const oracle = []
  const text = (n) => centsText(BigInt(n))
  for (const [kind, arg] of steps) {
    if (kind === 'credit') {
      const before = run.b.position().receivableBasisCents
      const entry = run.credit(arg)
      const p = run.b.position()
      made.push(entry)
      library.push([
        centsText(cents(entry.cn.subtotal)), centsText(cents(entry.cn.gstTotal)),
        centsText(cents(entry.cn.retentionAmount)), centsText(cents(entry.cn.retentionGst)),
        text(before), text(p.receivableBasisCents), text(p.retentionHeldExCents), text(p.retentionHeldGstCents),
      ])
      oracle.push([
        entry.expected.subtotal, entry.expected.gst, entry.expected.retention, entry.expected.retentionGst,
        entry.basisBefore, entry.basisAfter, run.o.heldEx(), run.o.heldGst(),
      ].map(centsText))
    } else if (kind === 'release') {
      made.push(run.release(arg))
    } else {
      expect(run.voidRelease(made[arg])).toBeNull()
      made.push(null)
    }
  }
  return { library, oracle, run }
}

// Both tables equal the expected one, and no credit in it raises the basis.
function expectCreditTable(specs, retentionText, steps, expected) {
  const { library, oracle, run } = creditTables(specs, retentionText, steps)
  expect(oracle).toEqual(expected)
  expect(library).toEqual(expected)
  for (const row of expected) {
    const [basisBefore, basisAfter] = [parseCents(row[4]), parseCents(row[5])]
    expect(basisBefore >= 0n && basisAfter >= 0n).toBe(true)
    expect(basisAfter <= basisBefore).toBe(true)
  }
  return run
}

// ── State shape ──────────────────────────────────────────────────────────────

describe('emptyLedger / readLedger / ledgerDocument', () => {
  it('an empty ledger is all zeros at seq 0', () => {
    expect(emptyLedger()).toEqual({
      seq: 0,
      creditedSubtotalCents: 0, creditedGstCents: 0,
      creditedRetentionCents: 0, creditedRetentionGstCents: 0,
      releasedRetentionCents: 0, releasedRetentionGstCents: 0,
      receivedCents: 0,
      lines: {},
    })
    // A fresh object every call — never a shared mutable default.
    expect(emptyLedger()).not.toBe(emptyLedger())
    expect(emptyLedger().lines).not.toBe(emptyLedger().lines)
  })

  it('a missing ledger document reads as empty (nothing has ever been posted)', () => {
    expect(readLedger(null)).toEqual(emptyLedger())
    expect(readLedger(undefined)).toEqual(emptyLedger())
    expect(readLedger({})).toEqual(emptyLedger())
  })

  it('reads a stored document and drops anything that is not a whole number', () => {
    const state = readLedger({
      seq: 3, creditedSubtotalCents: 2000, creditedGstCents: 200,
      creditedRetentionCents: '5', releasedRetentionCents: 1.5, releasedRetentionGstCents: null,
      lines: { 0: { amountCents: 2000, gstCents: 200 }, 2: { amountCents: 'x' }, 4: null },
      lastEntryId: 'cn1', updatedBy: 'u1',
    })
    expect(state.seq).toBe(3)
    expect(state.creditedSubtotalCents).toBe(2000)
    expect(state.creditedGstCents).toBe(200)
    expect(state.creditedRetentionCents).toBe(0)
    expect(state.releasedRetentionCents).toBe(0)
    expect(state.releasedRetentionGstCents).toBe(0)
    expect(state.lines).toEqual({
      0: { amountCents: 2000, gstCents: 200 },
      2: { amountCents: 0, gstCents: 0 },
      4: { amountCents: 0, gstCents: 0 },
    })
  })

  it('ledgerDocument carries seq, lines, the last entry, the six totals and receivedCents', () => {
    const b = book(retained())
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    const doc = ledgerDocument(b.ledger)
    expect(Object.keys(doc).sort()).toEqual(
      ['seq', 'lines', 'lastEntryId', 'lastEntryKind', 'receivedCents', ...LEDGER_TOTAL_KEYS].sort())
    expect(doc.receivedCents).toBe(0)
    expect(doc.seq).toBe(1)
    expect(doc.lastEntryId).toBe(cn.id)
    expect(doc.lastEntryKind).toBe(LEDGER_KIND.CREDIT)
    expect(doc.lines).toEqual({ 0: { amountCents: 20000, gstCents: 2000 } })
    // A stored document reads back to the same totals.
    expect(totalsOf(readLedger(doc))).toEqual(totalsOf(b.ledger))
  })

  it('names the six entry kinds; receivedCents is NOT one of the six invariant totals', () => {
    expect(LEDGER_KIND).toEqual({
      CREDIT: 'credit', CREDIT_VOID: 'credit_void', RELEASE: 'release', RELEASE_VOID: 'release_void',
      RECEIPT: 'receipt', RECEIPT_VOID: 'receipt_void',
    })
    expect(LEDGER_TOTAL_KEYS).toHaveLength(6)
    expect(LEDGER_TOTAL_KEYS).not.toContain('receivedCents')
  })

  it('readLedger / ledgerDocument carry receivedCents: 0 by default, and anything not a whole number reads as 0', () => {
    expect(readLedger(null).receivedCents).toBe(0)
    expect(readLedger({ seq: 2 }).receivedCents).toBe(0)
    expect(readLedger({ receivedCents: 12345 }).receivedCents).toBe(12345)
    for (const junk of ['5', 1.5, null, undefined, NaN]) expect(readLedger({ receivedCents: junk }).receivedCents).toBe(0)
    // A state without the field (a ledger written before receipts were tracked) stores 0.
    const legacy = emptyLedger()
    delete legacy.receivedCents
    expect(ledgerDocument(legacy).receivedCents).toBe(0)
    expect(ledgerDocument({ ...emptyLedger(), receivedCents: 990 }).receivedCents).toBe(990)
    expect(readLedger(ledgerDocument({ ...emptyLedger(), receivedCents: 990 })).receivedCents).toBe(990)
  })

  it('applying an entry never mutates the state it was given', () => {
    const inv = retained()
    const before = emptyLedger()
    const cn = { id: 'cn1', ...buildClientCreditNote(inv, before, [{ invoiceLineIndex: 0, amount: 200 }]).totals,
      lineItems: buildClientCreditNote(inv, before, [{ invoiceLineIndex: 0, amount: 200 }]).lineItems }
    const after = applyCredit(before, cn)
    expect(before).toEqual(emptyLedger())
    const snapshot = JSON.stringify(after)
    applyCreditVoid(after, cn)
    applyRelease(after, { id: 'r1', amount: 10, gstAmount: 1 })
    expect(JSON.stringify(after)).toBe(snapshot)
  })
})

// ── Invariants ───────────────────────────────────────────────────────────────

describe('ledgerInvariantError — each invariant', () => {
  const inv = retained()
  const state = (over) => ({ ...emptyLedger(), ...over })

  it('accepts the empty ledger and a legitimate state', () => {
    expect(ledgerInvariantError(inv, emptyLedger())).toBeNull()
    expect(ledgerInvariantError(inv, state({
      seq: 2, creditedSubtotalCents: 20000, creditedGstCents: 2000,
      creditedRetentionCents: 2000, creditedRetentionGstCents: 200,
      releasedRetentionCents: 4000, releasedRetentionGstCents: 400,
    }))).toBeNull()
  })

  it('refuses a figure that is negative or not a whole number', () => {
    expect(ledgerInvariantError(inv, state({ creditedGstCents: -1 })))
      .toBe('The ledger figure creditedGstCents is not a whole, non-negative number of cents.')
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 0.5 })))
      .toBe('The ledger figure releasedRetentionCents is not a whole, non-negative number of cents.')
    expect(ledgerInvariantError(inv, state({ seq: -1 }))).toMatch(/ledger figure seq/)
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: undefined }))).toMatch(/creditedSubtotalCents/)
  })

  it('I1 — credits cannot exceed the subtotal or the GST, and a full credit reverses the GST exactly', () => {
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 100001 })))
      .toBe('Credits exceed the invoice subtotal.')
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 1000, creditedGstCents: 10001 })))
      .toBe('Credited GST exceeds the invoice GST.')
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 100000, creditedGstCents: 9999,
      creditedRetentionCents: 10000, creditedRetentionGstCents: 1000,
    }))).toBe('A full credit must reverse the invoice GST exactly.')
  })

  it('I2 — retention credited and released together cannot exceed what was withheld', () => {
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 60000, creditedGstCents: 6000,
      creditedRetentionCents: 6000, releasedRetentionCents: 5000,
    }))).toBe('Retention credited and released together exceed the retention withheld.')
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 60000, creditedGstCents: 6000,
      creditedRetentionCents: 5000, releasedRetentionCents: 5000,
      creditedRetentionGstCents: 600, releasedRetentionGstCents: 500,
    }))).toBe('Retention GST credited and released together exceed the retention GST withheld.')
  })

  it('I3 — retention still held never exceeds what is still billed (ex-GST)', () => {
    // 950.00 credited with no retention credited: only 900.00 is receivable
    // (equivalently: 100.00 retention held against 50.00 still billed).
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 95000, creditedGstCents: 9500 })))
      .toBe('Credits against the receivable part exceed what is receivable.')
    // Exactly at the bound is valid: 100.00 + 10.00 held against 100.00 + 10.00 still billed.
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 90000, creditedGstCents: 9000 }))).toBeNull()
    // The 950.00 credit is fine once it carries its retention part.
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 95000, creditedGstCents: 9500,
      creditedRetentionCents: 9500, creditedRetentionGstCents: 950,
    }))).toBeNull()
  })

  it('I4 — retention GST held never exceeds the retained share of the GST still billed, after ANY movement', () => {
    const message = 'Retention GST held would exceed the retained share of the GST still billed.'
    // 100.00 + 10.00 held. 900.00 credited with 95.00 of GST: the retained share
    // of the 5.00 of GST still billed is 5.00 × 100 ÷ 100 = 5.00 < 10.00 held.
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 90000, creditedGstCents: 9500 }))).toBe(message)
    // EXACT, in whole cents round-half-up. 500.00 credited, 100.00 + 10.00 held:
    //   GST credited 50.02 → 49.98 × 100 ÷ 500 = 9.996 → 10.00: valid
    //   GST credited 50.03 → 49.97 × 100 ÷ 500 = 9.994 →  9.99: refused
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 50000, creditedGstCents: 5000 }))).toBeNull()
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 50000, creditedGstCents: 5002 }))).toBeNull()
    expect(ledgerInvariantError(inv, state({ creditedSubtotalCents: 50000, creditedGstCents: 5003 }))).toBe(message)
    // It is STRICTER than "no more than the GST still billed": 5.00 held against
    // 5.00 of GST still billed passed the superseded bound, but the retained
    // share of that 5.00 is 5.00 × 100 ÷ 500 = 1.00.
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 50000, creditedGstCents: 9500, creditedRetentionGstCents: 500,
    }))).toBe(message)
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 50000, creditedGstCents: 9500, creditedRetentionGstCents: 900,
    }))).toBeNull()
    // A partial release must take its GST with it: 50.00 held may carry 5.00.
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 5000, releasedRetentionGstCents: 499 }))).toBe(message)
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 5000, releasedRetentionGstCents: 500 }))).toBeNull()
    // LESS than the retained share is valid (the cap never re-withholds).
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 5000, releasedRetentionGstCents: 501 }))).toBeNull()
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 9999, releasedRetentionGstCents: 900 }))).toBe(message)

    // COROLLARY: once no ex-GST retention is held, no retention GST is held
    // either (the retained share of nothing is nothing). Reached by releases alone…
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 10000, releasedRetentionGstCents: 900 }))).toBe(message)
    expect(ledgerInvariantError(inv, state({ releasedRetentionCents: 10000, releasedRetentionGstCents: 1000 }))).toBeNull()
    // …by a credit alone…
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 50000, creditedGstCents: 5000,
      creditedRetentionCents: 10000, creditedRetentionGstCents: 900,
    }))).toBe(message)
    // …or by the two together.
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 50000, creditedGstCents: 5000,
      creditedRetentionCents: 4000, creditedRetentionGstCents: 400,
      releasedRetentionCents: 6000, releasedRetentionGstCents: 599,
    }))).toBe(message)
    expect(ledgerInvariantError(inv, state({
      creditedSubtotalCents: 50000, creditedGstCents: 5000,
      creditedRetentionCents: 4000, creditedRetentionGstCents: 400,
      releasedRetentionCents: 6000, releasedRetentionGstCents: 600,
    }))).toBeNull()
    // The two superseded messages no longer exist.
    const every = [
      state({ creditedSubtotalCents: 90000, creditedGstCents: 9500 }),
      state({ releasedRetentionCents: 10000, releasedRetentionGstCents: 900 }),
    ].map(l => ledgerInvariantError(inv, l))
    expect(every).toEqual([message, message])
  })

  it('an invoice with no retention fields allows credits up to its totals and no release at all', () => {
    const legacy = invoice([line(1000)], 0)
    delete legacy.retention; delete legacy.retentionGst; delete legacy.retentionTotal; delete legacy.receivableTotal
    expect(ledgerInvariantError(legacy, state({ creditedSubtotalCents: 100000, creditedGstCents: 10000 }))).toBeNull()
    expect(ledgerInvariantError(legacy, state({ releasedRetentionCents: 1 })))
      .toBe('Retention credited and released together exceed the retention withheld.')
  })
})

// ── Credit allocation: GST ───────────────────────────────────────────────────

describe('allocateCredit — line GST', () => {
  it('zero-GST invoice: every credit carries no GST, and a full credit is valid', () => {
    const inv = invoice([line(1000, 'gst_free')])
    expect(inv.gstTotal).toBe(0)
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 250 }])).toEqual({
      lines: [{ invoiceLineIndex: 0, amountCents: 25000, gstCents: 0 }],
      subtotalCents: 25000, gstCents: 0, retentionCents: 0, retentionGstCents: 0,
    })
    const b = book(inv)
    b.credit([{ invoiceLineIndex: 0, amount: 250 }])
    b.credit([{ invoiceLineIndex: 0, amount: 750 }])
    expect(totalsOf(b.ledger)).toEqual({
      creditedSubtotalCents: 100000, creditedGstCents: 0,
      creditedRetentionCents: 0, creditedRetentionGstCents: 0,
      releasedRetentionCents: 0, releasedRetentionGstCents: 0,
    })
  })

  it('input-taxed lines behave as GST-free', () => {
    const inv = invoice([line(500, 'input_taxed')])
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 500 }]).gstCents).toBe(0)
  })

  it('fully taxable invoice: the credit carries the line share of GST', () => {
    const inv = invoice([line(1000)])
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 250 }])).toEqual({
      lines: [{ invoiceLineIndex: 0, amountCents: 25000, gstCents: 2500 }],
      subtotalCents: 25000, gstCents: 2500, retentionCents: 0, retentionGstCents: 0,
    })
    const full = allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 1000 }])
    expect(full.gstCents).toBe(10000)
  })

  it('accepts a missing ledger state (nothing posted yet)', () => {
    const inv = invoice([line(1000)])
    expect(allocateCredit(inv, null, [{ invoiceLineIndex: 0, amount: 250 }]).gstCents).toBe(2500)
    expect(allocateCredit(inv, undefined, [{ invoiceLineIndex: 0, amount: 250 }]).gstCents).toBe(2500)
  })

  it('MIXED-tax invoice: GST follows each source line, never a blended rate', () => {
    const inv = invoice([line(40.15), line(100, 'gst_free')])
    expect(inv.subtotal).toBe(140.15)
    expect(inv.gstTotal).toBe(4.02)
    const b = book(inv)
    const first = b.credit([{ invoiceLineIndex: 0, amount: 20.07 }, { invoiceLineIndex: 1, amount: 50 }])
    // 4.02 × 20.07 ÷ 40.15 = 2.0095 → 2.01; the GST-free line carries none.
    expect(first.lineItems.map(li => [li.invoiceLineIndex, li.amount, li.gstAmount, li.taxCode]))
      .toEqual([[0, 20.07, 2.01, 'gst'], [1, 50, 0, 'gst_free']])
    expect(first.subtotal).toBe(70.07)
    expect(first.gstTotal).toBe(2.01)
    expect(first.grossTotal).toBe(72.08)
    const second = b.credit([{ invoiceLineIndex: 1, amount: 50 }, { invoiceLineIndex: 0, amount: 20.08 }])
    // Rows are stored in invoice-line order whatever order they were entered in.
    expect(second.lineItems.map(li => li.invoiceLineIndex)).toEqual([0, 1])
    expect(second.gstTotal).toBe(2.01)
    expect(b.ledger.creditedSubtotalCents).toBe(14015)
    expect(b.ledger.creditedGstCents).toBe(402)
    expect(b.ledger.lines).toEqual({
      0: { amountCents: 4015, gstCents: 402 },
      1: { amountCents: 10000, gstCents: 0 },
    })
  })

  it('crediting only the GST-free line of a mixed invoice carries no GST', () => {
    const inv = invoice([line(40.15), line(100, 'gst_free')])
    const a = allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 1, amount: 100 }])
    expect(a.gstCents).toBe(0)
    expect(a.subtotalCents).toBe(10000)
  })

  describe('LEGACY invoice whose stored line GST is one cent low (40.15 stored with 4.01)', () => {
    const legacy = () => invoice([line(40.15, 'gst', 4.01)])

    it('the fixture really is the legacy shape', () => {
      const inv = legacy()
      expect(gstForLine(40.15, 'gst')).toBe(4.02) // what would be authored today
      expect(inv.lineItems[0].gstAmount).toBe(4.01)
      expect(inv.gstTotal).toBe(4.01)
      expect(inv.grossTotal).toBe(44.16)
    })

    it('a FULL credit reverses the stored figures exactly — 4.01, not 4.02', () => {
      const b = book(legacy())
      const cn = b.credit([{ invoiceLineIndex: 0, amount: 40.15 }])
      expect(cn.gstTotal).toBe(4.01)
      expect(cn.grossTotal).toBe(44.16)
      expect(b.ledger.creditedGstCents).toBe(401)
      expect(b.position().netIssuedGrossCents).toBe(0)
      expect(b.position().receivableBasisCents).toBe(0)
    })

    it.each([2, 3, 7])('partial credits in %i pieces sum exactly to the stored line GST', (n) => {
      const b = book(legacy())
      let gst = 0
      for (const piece of pieces(4015, n)) {
        const cn = b.credit([{ invoiceLineIndex: 0, amount: piece / 100 }])
        expect(cn.error).toBeUndefined()
        expect(cents(cn.gstTotal) >= 0n).toBe(true)
        gst += Number(cents(cn.gstTotal))
      }
      expect(gst).toBe(401)
      expect(b.ledger.creditedSubtotalCents).toBe(4015)
      expect(b.ledger.creditedGstCents).toBe(401)
      expect(b.ledger.lines[0]).toEqual({ amountCents: 4015, gstCents: 401 })
    })
  })

  it.each([2, 3, 7])('partial credits in %i pieces on one exact boundary line sum to its 4.02', (n) => {
    const b = book(invoice([line(40.15)]))
    for (const piece of pieces(4015, n)) b.credit([{ invoiceLineIndex: 0, amount: piece / 100 }])
    expect(b.credits).toHaveLength(n)
    expect(b.credits.reduce((sum, cn) => sum + Number(cents(cn.gstTotal)), 0)).toBe(402)
    expect(b.ledger.creditedGstCents).toBe(402)
  })

  it('multiple credits across several lines reconcile line by line', () => {
    const inv = invoice([line(600), line(40.15), line(300, 'gst_free')])
    expect(inv.subtotal).toBe(940.15)
    expect(inv.gstTotal).toBe(64.02)
    const b = book(inv)
    const c1 = b.credit([{ invoiceLineIndex: 0, amount: 100 }, { invoiceLineIndex: 2, amount: 50 }])
    expect([c1.subtotal, c1.gstTotal, c1.grossTotal]).toEqual([150, 10, 160])
    const c2 = b.credit([{ invoiceLineIndex: 0, amount: 500 }, { invoiceLineIndex: 1, amount: 40.15 }])
    expect([c2.subtotal, c2.gstTotal, c2.grossTotal]).toEqual([540.15, 54.02, 594.17])
    expect(b.ledger.lines).toEqual({
      0: { amountCents: 60000, gstCents: 6000 },
      1: { amountCents: 4015, gstCents: 402 },
      2: { amountCents: 5000, gstCents: 0 },
    })
    const c3 = b.credit([{ invoiceLineIndex: 2, amount: 250 }])
    expect([c3.subtotal, c3.gstTotal]).toEqual([250, 0])
    expect(b.ledger.creditedSubtotalCents).toBe(94015)
    expect(b.ledger.creditedGstCents).toBe(6402)
    expect(b.ledger.seq).toBe(3)
    // Nothing is left to credit on any line.
    expect(b.credit([{ invoiceLineIndex: 0, amount: 0.01 }]).error)
      .toBe('Line 1: only 0.00 of 600.00 remains to credit.')
  })
})

describe('allocateCredit — refusals', () => {
  const inv = invoice([line(600), line(400)])

  it('refuses an over-credit of a line, naming what remains', () => {
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 600.01 }]))
      .toEqual({ error: 'Line 1: only 600.00 of 600.00 remains to credit.' })
    const b = book(inv)
    b.credit([{ invoiceLineIndex: 0, amount: 100 }])
    expect(b.credit([{ invoiceLineIndex: 0, amount: 500.01 }]))
      .toEqual({ error: 'Line 1: only 500.00 of 600.00 remains to credit.' })
    // The refusal changed nothing, and exactly the remainder is accepted.
    expect(b.ledger.seq).toBe(1)
    expect(b.credit([{ invoiceLineIndex: 0, amount: 500 }]).error).toBeUndefined()
  })

  it('an over-credit of one line is refused even when the invoice as a whole has room', () => {
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 1, amount: 401 }]).error)
      .toBe('Line 2: only 400.00 of 400.00 remains to credit.')
  })

  it('refuses a duplicate row for one line', () => {
    expect(allocateCredit(inv, emptyLedger(), [
      { invoiceLineIndex: 0, amount: 10 }, { invoiceLineIndex: 1, amount: 5 }, { invoiceLineIndex: 0, amount: 20 },
    ])).toEqual({ error: 'Line 1 is credited twice — combine those rows.' })
  })

  it('refuses a row that names no line, a non-positive amount, and no rows at all', () => {
    for (const bad of [2, -1, 1.5, 'x', undefined]) {
      expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: bad, amount: 10 }]).error)
        .toBe('A credit line does not name a line of the invoice.')
    }
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 0 }]).error)
      .toBe('Line 1: the credit amount must be greater than zero.')
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 1, amount: -5 }]).error)
      .toBe('Line 2: the credit amount must be greater than zero.')
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 1, amount: 0.004 }]).error)
      .toBe('Line 2: the credit amount must be greater than zero.')
    expect(allocateCredit(inv, emptyLedger(), []).error).toBe('Add at least one line with an amount.')
    expect(allocateCredit(inv, emptyLedger(), null).error).toBe('Add at least one line with an amount.')
  })

  it('refuses an amount carrying a fraction of a cent — never rounded silently', () => {
    for (const bad of [10.005, 10.001, 599.999, '10.005']) {
      expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: bad }]))
        .toEqual({ error: 'Line 1: the credit amount cannot carry a fraction of a cent.' })
    }
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 10 }, { invoiceLineIndex: 1, amount: 0.015 }]).error)
      .toBe('Line 2: the credit amount cannot carry a fraction of a cent.')
    // The non-positive check comes first, so its message is unchanged.
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 0.004 }]).error)
      .toBe('Line 1: the credit amount must be greater than zero.')
    // Whole cents, as a number or a numeric string, are accepted.
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: 10.01 }]).subtotalCents).toBe(1001)
    expect(allocateCredit(inv, emptyLedger(), [{ invoiceLineIndex: 0, amount: '10.01' }]).subtotalCents).toBe(1001)
  })

  it('refuses an invoice whose headers do not reconcile to its own lines', () => {
    const wrongSubtotal = { ...inv, subtotal: 1000.01 }
    const wrongGst = { ...inv, gstTotal: 99.99 }
    const noLines = { ...inv, lineItems: undefined }
    for (const broken of [wrongSubtotal, wrongGst, noLines]) {
      expect(allocateCredit(broken, emptyLedger(), [{ invoiceLineIndex: 0, amount: 10 }]))
        .toEqual({ error: 'CI-0001 stores totals that do not reconcile to its own lines, so it cannot be credited.' })
    }
    expect(allocateCredit({ ...wrongGst, invoiceNumber: '' }, emptyLedger(), [{ invoiceLineIndex: 0, amount: 10 }]).error)
      .toBe('This invoice stores totals that do not reconcile to its own lines, so it cannot be credited.')
  })
})

// ── Retention on the invoice ─────────────────────────────────────────────────

describe('invoiceTotals — retention GST is the invoice\'s own GST in proportion', () => {
  it('no retention: the four fields are zero and the whole gross is receivable', () => {
    expect(invoiceTotals([line(1000)])).toEqual({
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
      retention: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: 1100,
    })
  })

  it('zero-tax invoice withholds no GST', () => {
    expect(invoiceTotals([line(1000, 'gst_free')], 50)).toEqual({
      subtotal: 1000, gstTotal: 0, grossTotal: 1000,
      retention: 50, retentionGst: 0, retentionTotal: 50, receivableTotal: 950,
    })
  })

  it.each([
    [1000, 50, 5, 1045], [1000, 100, 10, 990], [10000, 500, 50, 10450],
    [250000, 12500, 1250, 261250], [800, 80, 8, 792],
  ])('fully taxable %d with retention %d withholds exactly a tenth of it in GST (%d)', (subtotal, retention, gst, receivable) => {
    const t = invoiceTotals([line(subtotal)], retention)
    expect(t.retentionGst).toBe(gst)
    expect(t.retentionTotal).toBe(retention + gst)
    expect(t.receivableTotal).toBe(receivable)
  })

  it('mixed-tax invoice withholds its BLENDED share, never a flat 10%', () => {
    // GST 60.00 on a 1000.00 subtotal → 6% blended; 100.00 withheld → 6.00.
    expect(invoiceTotals([line(600), line(400, 'gst_free')], 100)).toEqual({
      subtotal: 1000, gstTotal: 60, grossTotal: 1060,
      retention: 100, retentionGst: 6, retentionTotal: 106, receivableTotal: 954,
    })
  })

  it('rounds the withheld GST half up, in whole cents', () => {
    // 4.02 × 2.01 ÷ 40.15 = 0.20125 → 0.20
    expect(invoiceTotals([line(40.15)], 2.01).retentionGst).toBe(0.2)
    // 33.33 × 33.33 ÷ 333.33 = 3.33267 → 3.33
    expect(invoiceTotals([line(333.33)], 33.33).retentionGst).toBe(3.33)
    // 0.50 × 0.25 ÷ 5.00 = 0.025 → 0.03 (exact half goes up)
    expect(invoiceTotals([line(5)], 0.25).retentionGst).toBe(0.03)
  })

  it('withholding the whole subtotal withholds the whole GST', () => {
    const t = invoiceTotals([line(40.15), line(100, 'gst_free')], 140.15)
    expect(t.retentionGst).toBe(4.02)
    expect(t.retentionTotal).toBe(144.17)
    expect(t.receivableTotal).toBe(0)
  })

  it('a negative retention reads as none', () => {
    expect(invoiceTotals([line(1000)], -50).retention).toBe(0)
    expect(invoiceTotals([line(1000)], -50).receivableTotal).toBe(1100)
  })

  it('retentionFromPercent proposes round-half-up of the subtotal percentage', () => {
    expect(retentionFromPercent(1000, 5)).toBe(50)
    expect(retentionFromPercent(1000, 10)).toBe(100)
    expect(retentionFromPercent(40.15, 5)).toBe(2.01)      // 2.0075 → 2.01
    expect(retentionFromPercent(33.33, 2.5)).toBe(0.83)    // 0.83325 → 0.83
    expect(retentionFromPercent(61540.15, 5)).toBe(3077.01) // 3077.0075 → 3077.01
    expect(retentionFromPercent(0.1, 5)).toBe(0.01)        // 0.005 → 0.01
    expect(retentionFromPercent(1000, '5')).toBe(50)
    expect(retentionFromPercent(1000, 100)).toBe(1000)
    expect(retentionFromPercent(1000, 250)).toBe(1000)     // capped at the subtotal
    for (const none of [0, -5, NaN, 'abc', undefined, null, Infinity]) {
      expect(retentionFromPercent(1000, none)).toBe(0)
    }
  })

  it('invoiceRetention / hasRetention read the stored position in whole cents', () => {
    expect(invoiceRetention(retained())).toEqual({
      subtotalCents: 100000, gstCents: 10000, grossCents: 110000,
      retentionCents: 10000, retentionGstCents: 1000,
      retentionTotalCents: 11000, receivableCents: 99000,
    })
    expect(hasRetention(retained())).toBe(true)
    // A pre-ADR-88 invoice has none of the fields.
    const legacy = { subtotal: 40.15, gstTotal: 4.01, grossTotal: 44.16 }
    expect(invoiceRetention(legacy)).toEqual({
      subtotalCents: 4015, gstCents: 401, grossCents: 4416,
      retentionCents: 0, retentionGstCents: 0, retentionTotalCents: 0, receivableCents: 4416,
    })
    expect(hasRetention(legacy)).toBe(false)
    expect(hasRetention(null)).toBe(false)
  })

  it('retentionError mirrors the scalar pins', () => {
    expect(retentionError('', 1000)).toBeNull()
    expect(retentionError(null, 1000)).toBeNull()
    expect(retentionError(0, 1000)).toBeNull()
    expect(retentionError(50, 1000)).toBeNull()
    expect(retentionError(1000, 1000)).toBeNull()
    expect(retentionError('abc', 1000)).toBe('Retention must be a number.')
    expect(retentionError(-1, 1000)).toBe('Retention cannot be negative.')
    expect(retentionError(1.005, 1000)).toBe('Retention cannot carry a fraction of a cent.')
    expect(retentionError(1000.01, 1000)).toBe('Retention cannot exceed the invoice subtotal (ex-GST).')
  })

  it('retentionError has NO upper limit — the former 20,000,000.00 refusal is gone', () => {
    // [subtotal, one cent more than it]
    for (const [subtotal, over] of [
      [20000000, 20000000.01], [20000000.01, 20000000.02], [250000000, 250000000.01], [9999999999.99, 10000000000],
    ]) {
      expect(retentionError(0, subtotal)).toBeNull()
      expect(retentionError(1, subtotal)).toBeNull()
      expect(retentionError(subtotal, subtotal)).toBeNull()
      // The ordinary pins still apply at any size.
      expect(retentionError(over, subtotal)).toBe('Retention cannot exceed the invoice subtotal (ex-GST).')
      expect(retentionError(1.005, subtotal)).toBe('Retention cannot carry a fraction of a cent.')
    }
  })
})

// ── Releases ─────────────────────────────────────────────────────────────────

describe('allocateRelease', () => {
  // 333.33 + 33.33 GST, 33.33 withheld → 3.33 of GST withheld (3.33267 down).
  const awkward = () => invoice([line(333.33)], 33.33)

  it('a single full release releases the stored retention GST', () => {
    expect(allocateRelease(retained(), emptyLedger(), 100)).toEqual({ amountCents: 10000, gstCents: 1000 })
    expect(allocateRelease(awkward(), null, 33.33)).toEqual({ amountCents: 3333, gstCents: 333 })
  })

  it('a partial release leaves the retained share of the GST held and takes the rest', () => {
    expect(allocateRelease(retained(), emptyLedger(), 40)).toEqual({ amountCents: 4000, gstCents: 400 })
    // 23.33 stays held: 33.33 × 23.33 ÷ 333.33 = 2.3328 → 2.33, so the release takes 3.33 − 2.33 = 1.00
    expect(allocateRelease(awkward(), emptyLedger(), 10)).toEqual({ amountCents: 1000, gstCents: 100 })
  })

  it.each([1, 2, 3, 7])('releases in %i pieces telescope exactly to the stored retentionGst', (n) => {
    const inv = awkward()
    expect(inv.retentionGst).toBe(3.33)
    const b = book(inv)
    for (const piece of pieces(3333, n)) {
      const r = b.release(piece / 100)
      expect(r.error).toBeUndefined()
      expect(cents(r.gstAmount) >= 0n).toBe(true)
      expect(cents(r.releaseTotal)).toBe(cents(r.amount) + cents(r.gstAmount))
    }
    expect(b.releases.reduce((sum, r) => sum + Number(cents(r.gstAmount)), 0)).toBe(333)
    expect(b.ledger.releasedRetentionCents).toBe(3333)
    expect(b.ledger.releasedRetentionGstCents).toBe(333)
    expect(b.position().retentionHeldCents).toBe(0)
    expect(b.position().retentionHeldGstCents).toBe(0)
    // Everything withheld is now receivable: the basis is the full gross.
    expect(b.position().receivableBasisCents).toBe(b.position().grossCents)
  })

  it.each([1, 2, 3, 7])('mixed-tax retention released in %i pieces telescopes to its blended GST', (n) => {
    const inv = invoice([line(40.15), line(100, 'gst_free'), line(87.35)], 22.75)
    const b = book(inv)
    for (const piece of pieces(2275, n)) b.release(piece / 100)
    expect(b.ledger.releasedRetentionGstCents).toBe(invoiceRetention(inv).retentionGstCents)
    expect(b.position().retentionHeldCents).toBe(0)
  })

  it('a release above the retention still held is refused', () => {
    expect(allocateRelease(retained(), emptyLedger(), 100.01))
      .toEqual({ error: 'Only 100.00 of retention (ex-GST) is still held on CI-0001.' })
    const b = book(retained())
    b.release(40)
    expect(b.release(60.01)).toEqual({ error: 'Only 60.00 of retention (ex-GST) is still held on CI-0001.' })
    expect(b.ledger.seq).toBe(1)
    b.release(60)
    expect(b.release(0.01)).toEqual({ error: 'Only 0.00 of retention (ex-GST) is still held on CI-0001.' })
  })

  it('refuses a non-positive amount and an invoice that withheld nothing', () => {
    expect(allocateRelease(retained(), emptyLedger(), 0)).toEqual({ error: 'The release amount must be greater than zero.' })
    expect(allocateRelease(retained(), emptyLedger(), -5)).toEqual({ error: 'The release amount must be greater than zero.' })
    expect(allocateRelease(retained(), emptyLedger(), 'abc')).toEqual({ error: 'The release amount must be greater than zero.' })
    expect(allocateRelease({ ...invoice([line(1000)]), invoiceNumber: '' }, emptyLedger(), 1))
      .toEqual({ error: 'Only 0.00 of retention (ex-GST) is still held on this invoice.' })
  })

  it('refuses an amount carrying a fraction of a cent — never rounded silently', () => {
    for (const bad of [10.005, 10.001, 99.999, '10.005']) {
      expect(allocateRelease(retained(), emptyLedger(), bad))
        .toEqual({ error: 'The release amount cannot carry a fraction of a cent.' })
    }
    // The non-positive check comes first, so its message is unchanged.
    expect(allocateRelease(retained(), emptyLedger(), 0.004)).toEqual({ error: 'The release amount must be greater than zero.' })
    expect(allocateRelease(retained(), emptyLedger(), 10.01)).toEqual({ amountCents: 1001, gstCents: 100 })
    expect(allocateRelease(retained(), emptyLedger(), '10.01')).toEqual({ amountCents: 1001, gstCents: 100 })
  })

  it('retention already taken by a credit cannot be released', () => {
    const b = book(retained())
    b.credit([{ invoiceLineIndex: 0, amount: 200 }]) // takes 20.00 of the retention
    expect(b.release(80.01)).toEqual({ error: 'Only 80.00 of retention (ex-GST) is still held on CI-0001.' })
    const r = b.release(80)
    // The release that empties the held retention takes ALL the GST still held.
    expect([r.amount, r.gstAmount, r.releaseTotal]).toEqual([80, 8, 88])
    expect(b.position().retentionHeldCents).toBe(0)
  })
})

// ── Credit × retention ───────────────────────────────────────────────────────

// gross − credited − held, by hand.
const basisIdentity = (p) => p.grossCents - p.creditedGrossCents - p.retentionHeldCents

describe('credit × retention — every order reconciles and satisfies the invariants', () => {
  it('credit BEFORE any release: the credit falls on retention and receivable in proportion', () => {
    const b = book(retained())
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    expect(cn).toMatchObject({
      subtotal: 200, gstTotal: 20, grossTotal: 220,
      retentionAmount: 20, retentionGst: 2, retentionTotal: 22, receivableTotal: 198,
    })
    expect(totalsOf(b.ledger)).toEqual({
      creditedSubtotalCents: 20000, creditedGstCents: 2000,
      creditedRetentionCents: 2000, creditedRetentionGstCents: 200,
      releasedRetentionCents: 0, releasedRetentionGstCents: 0,
    })
    const p = b.position()
    expect(p.netIssuedSubtotalCents).toBe(80000)
    expect(p.netIssuedGrossCents).toBe(88000)
    expect(p.retentionHeldExCents).toBe(8000)
    expect(p.retentionHeldGstCents).toBe(800)
    expect(p.retentionHeldCents).toBe(8800)
    expect(p.receivableBasisCents).toBe(79200) // 990.00 − 198.00
    expect(p.receivableBasisCents).toBe(basisIdentity(p))
  })

  it('credit AFTER a partial release: it takes its fraction of what is STILL held', () => {
    const b = book(retained())
    const r = b.release(40)
    expect([r.amount, r.gstAmount, r.releaseTotal]).toEqual([40, 4, 44])
    expect(b.position().receivableBasisCents).toBe(103400) // 990.00 + 44.00
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    // 60.00 still held × 200 ÷ 1000 still billed = 12.00, leaving 48.00;
    // GST left held 80.00 × 48 ÷ 800 = 4.80, so the credit takes 6.00 − 4.80 = 1.20.
    expect(cn).toMatchObject({ retentionAmount: 12, retentionGst: 1.2, retentionTotal: 13.2, receivableTotal: 206.8 })
    const p = b.position()
    expect(p.retentionHeldExCents).toBe(4800)  // 100 − 40 released − 12 credited
    expect(p.retentionHeldCents).toBe(5280)
    expect(p.releasedGrossCents).toBe(4400)
    expect(p.receivableBasisCents).toBe(82720) // 1100 − 220 − 52.80
    expect(p.receivableBasisCents).toBe(basisIdentity(p))
  })

  it('after a release there is NO catch-up: a credit never takes more than its fraction of what is held', () => {
    const b = book(retained())
    b.release(95) // 5.00 + 0.50 still held
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    // 5.00 × 200 ÷ 1000 = 1.00 (the superseded cumulative rule took all 5.00);
    // GST left held 80.00 × 4 ÷ 800 = 0.40, so the credit takes 0.50 − 0.40 = 0.10.
    expect(cn).toMatchObject({ retentionAmount: 1, retentionGst: 0.1, retentionTotal: 1.1, receivableTotal: 218.9 })
    const p = b.position()
    expect(p.retentionHeldExCents).toBe(400)
    expect(p.retentionHeldCents).toBe(440)
    expect(p.receivableBasisCents).toBe(87560) // 1100 − 220 − 4.40
    expect(p.receivableBasisCents).toBe(basisIdentity(p))
    // What is left is still releasable against the 800.00 still billed.
    const r = b.release(4)
    expect([r.amount, r.gstAmount]).toEqual([4, 0.4])
    expect(b.position().retentionHeldCents).toBe(0)
  })

  it('credit AFTER a FULL release: all of it falls on the receivable, retention portion 0', () => {
    const b = book(retained())
    const r = b.release(100)
    expect([r.amount, r.gstAmount, r.releaseTotal]).toEqual([100, 10, 110])
    expect(b.position().receivableBasisCents).toBe(110000)
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    expect(cn).toMatchObject({
      subtotal: 200, gstTotal: 20, grossTotal: 220,
      retentionAmount: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: 220,
    })
    const p = b.position()
    expect(p.creditedRetentionGrossCents).toBe(0)
    expect(p.retentionHeldCents).toBe(0)
    expect(p.receivableBasisCents).toBe(88000)
    expect(p.receivableBasisCents).toBe(basisIdentity(p))
    // And a full credit afterwards has no retention left to clear.
    const rest = b.credit([{ invoiceLineIndex: 0, amount: 800 }])
    expect(rest).toMatchObject({ retentionAmount: 0, retentionGst: 0, receivableTotal: 880 })
    expect(b.position().receivableBasisCents).toBe(0)
  })

  it('multiple credits and releases interleaved reconcile at every step', () => {
    const b = book(retained())
    const steps = []
    const snap = () => {
      const p = b.position()
      expect(p.receivableBasisCents).toBe(basisIdentity(p))
      steps.push([p.creditedGrossCents, p.creditedRetentionGrossCents, p.releasedGrossCents, p.retentionHeldCents, p.receivableBasisCents])
    }
    const c1 = b.credit([{ invoiceLineIndex: 0, amount: 100 }]); snap()
    const r1 = b.release(30); snap()
    const c2 = b.credit([{ invoiceLineIndex: 0, amount: 250 }]); snap()
    const r2 = b.release(43.33); snap() // exactly what is still held ex-GST

    expect([c1.gstTotal, c1.retentionAmount, c1.retentionGst]).toEqual([10, 10, 1])
    expect([r1.amount, r1.gstAmount]).toEqual([30, 3])
    // 60.00 still held × 250 ÷ 900 still billed = 16.667 → 16.67, leaving 43.33;
    // GST left held 65.00 × 43.33 ÷ 650 = 4.333 → 4.33, so the credit takes 6.00 − 4.33 = 1.67.
    expect([c2.gstTotal, c2.retentionAmount, c2.retentionGst]).toEqual([25, 16.67, 1.67])
    // The final release takes all the GST still held: 10.00 − 1.00 − 3.00 − 1.67.
    expect([r2.amount, r2.gstAmount, r2.releaseTotal]).toEqual([43.33, 4.33, 47.66])

    expect(steps).toEqual([
      // credited, credited-retention, released, held, basis
      [11000, 1100, 0, 9900, 89100],
      [11000, 1100, 3300, 6600, 92400],
      [38500, 2934, 3300, 4766, 66734],
      [38500, 2934, 8066, 0, 71500],
    ])
    expect(totalsOf(b.ledger)).toEqual({
      creditedSubtotalCents: 35000, creditedGstCents: 3500,
      creditedRetentionCents: 2667, creditedRetentionGstCents: 267,
      releasedRetentionCents: 7333, releasedRetentionGstCents: 733,
    })
    expect(b.ledger.seq).toBe(4)
    expect(b.ledger.lastEntryKind).toBe(LEDGER_KIND.RELEASE)
    // The ledger equals the sum of the posted documents.
    expect(ledgerDisagreement(ledgerDocument(b.ledger), 'inv1', b.credits, b.releases)).toEqual([])
  })

  it('a FULL credit of a retained invoice clears exactly the retention still held', () => {
    const b = book(retained())
    b.release(40)
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(cn).toMatchObject({
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
      retentionAmount: 60, retentionGst: 6, retentionTotal: 66, receivableTotal: 1034,
    })
    const p = b.position()
    expect(p.retentionHeldExCents).toBe(0)
    expect(p.retentionHeldGstCents).toBe(0)
    expect(p.retentionHeldCents).toBe(0)
    expect(p.receivableBasisCents).toBe(0)
    expect(p.netIssuedSubtotalCents).toBe(0)
    expect(p.netIssuedGrossCents).toBe(0)
    // The released 44.00 stays released — it was receivable and is now credited.
    expect(p.releasedGrossCents).toBe(4400)
    expect(b.release(0.01).error).toBe('Only 0.00 of retention (ex-GST) is still held on CI-0001.')
  })

  it('a FULL credit with nothing released clears the whole retention', () => {
    const b = book(retained())
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(cn).toMatchObject({ retentionAmount: 100, retentionGst: 10, retentionTotal: 110, receivableTotal: 990 })
    expect(b.position().retentionHeldCents).toBe(0)
    expect(b.position().receivableBasisCents).toBe(0)
  })

  it('a full credit reached in several credits ends at held 0 and basis 0 (awkward figures)', () => {
    const inv = invoice([line(40.15), line(100, 'gst_free'), line(333.33)], 47.35)
    const b = book(inv)
    b.credit([{ invoiceLineIndex: 0, amount: 13.37 }, { invoiceLineIndex: 2, amount: 111.11 }])
    b.release(11.11)
    b.credit([{ invoiceLineIndex: 1, amount: 99.99 }])
    b.release(3.33)
    b.credit([{ invoiceLineIndex: 0, amount: 26.78 }, { invoiceLineIndex: 1, amount: 0.01 }, { invoiceLineIndex: 2, amount: 222.22 }])
    const p = b.position()
    expect(b.ledger.creditedSubtotalCents).toBe(p.subtotalCents)
    expect(b.ledger.creditedGstCents).toBe(p.gstCents)
    expect(p.retentionHeldExCents).toBe(0)
    expect(p.retentionHeldGstCents).toBe(0)
    expect(p.receivableBasisCents).toBe(0)
    expect(b.ledger.creditedRetentionCents + b.ledger.releasedRetentionCents).toBe(p.retentionCents)
    expect(b.ledger.creditedRetentionGstCents + b.ledger.releasedRetentionGstCents).toBe(p.retentionGstCents)
  })
})

describe('credit × retention — retention GST is never stranded (mixed-tax invoice)', () => {
  // Mixed-tax invoice:  A 1000.00 gst_free  ·  B 1000.00 gst (GST 100.00)
  //   subtotal 2000.00 · GST 100.00 · gross 2100.00
  //   retention 200.00 · retention GST 10.00 (blended 5%)
  //
  // Under the superseded cumulative rule, "release 100.00 then credit line A in
  // full" left 5.00 of retention GST held with NO ex-GST retention behind it,
  // unreleasable (reported defect). Now the retention GST left held after a
  // credit is the retained fraction of the GST still billed, and nil once no
  // ex-GST retention is held.
  const mixed = () => invoice([line(1000, 'gst_free'), line(1000)], 200)

  it('release then credit of the GST-free line: retention and its GST move together', () => {
    const inv = mixed()
    expect(invoiceRetention(inv)).toMatchObject({ retentionCents: 20000, retentionGstCents: 1000 })
    const b = book(inv)
    const r = b.release(100)
    expect([r.amount, r.gstAmount]).toEqual([100, 5])
    expect(b.position().receivableBasisCents).toBe(199500) // 2100 − 105.00 held
    // Ex-GST: 100.00 still held × 1000 ÷ 2000 still billed = 50.00.
    // GST left held: GST still billed 100.00 × 50.00 held ÷ 1000.00 still billed
    // = 5.00 — all 5.00 that was held. The GST-free credit frees NO retention GST.
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(cn).toMatchObject({
      subtotal: 1000, gstTotal: 0, grossTotal: 1000,
      retentionAmount: 50, retentionGst: 0, retentionTotal: 50, receivableTotal: 950,
    })
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents, p.retentionHeldCents]).toEqual([5000, 500, 5500])
    expect(p.receivableBasisCents).toBe(104500) // 2100 − 1000 − 55.00
    expect(p.receivableBasisCents).toBe(basisIdentity(p))

    // The retention still held is releasable, and releasing it makes the whole
    // of what is still billed (line B: 1000.00 + 100.00) receivable.
    const last = b.release(50)
    expect([last.amount, last.gstAmount]).toEqual([50, 5])
    const end = b.position()
    expect([end.retentionHeldExCents, end.retentionHeldGstCents, end.retentionHeldCents]).toEqual([0, 0, 0])
    expect(end.netIssuedGrossCents).toBe(110000)
    expect(end.receivableBasisCents).toBe(110000)
  })

  it('no retention GST is held once no ex-GST retention is — at every step of the reproduction', () => {
    const b = book(mixed())
    const stranded = () => {
      const p = b.position()
      return p.retentionHeldExCents === 0 && p.retentionHeldGstCents !== 0
    }
    b.release(100); expect(stranded()).toBe(false)
    b.credit([{ invoiceLineIndex: 0, amount: 1000 }]); expect(stranded()).toBe(false)
    b.release(50); expect(stranded()).toBe(false)
    expect(b.position().retentionHeldExCents).toBe(0)
    expect(b.position().receivableBasisCents).toBe(110000)
  })

  it('a credit that takes the LAST ex-GST retention takes all the retention GST with it', () => {
    // Retention of 0.02 on the mixed invoice: GST 100.00 × 0.02 ÷ 2000.00 = 0.001 → 0.00,
    // so force a GST remainder with a legacy-style stored figure instead.
    const inv = { ...mixed(), retention: 0.02, retentionGst: 0.01, retentionTotal: 0.03, receivableTotal: 2099.97 }
    const b = book(inv)
    // 0.02 × 1999.99 ÷ 2000.00 = 0.0199 → 0.02: not a full credit, yet it takes
    // ALL the ex-GST retention — and therefore all the retention GST.
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 1000 }, { invoiceLineIndex: 1, amount: 999.99 }])
    expect(cn).toMatchObject({ retentionAmount: 0.02, retentionGst: 0.01 })
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([0, 0])
  })

  it('without the earlier release the same credit takes half the retention and none of its GST; one release clears the rest', () => {
    const b = book(mixed())
    // 200.00 × 1000 ÷ 2000 = 100.00. GST left held: 100.00 × 100.00 ÷ 1000.00 =
    // 10.00 — everything that was held, so the credit takes none.
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(cn).toMatchObject({ retentionAmount: 100, retentionGst: 0 })
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([10000, 1000])
    const r = b.release(100)
    expect(r.gstAmount).toBe(10)
    expect(b.position().retentionHeldCents).toBe(0)
    expect(b.position().receivableBasisCents).toBe(110000)
  })
})

describe('credit × retention — an allocated credit always leaves a valid ledger (formerly reported defects)', () => {
  // On a MIXED-TAX invoice the retained slice is a blend, while the GST a
  // credit takes is its own line's. An earlier rule could allocate a credit
  // whose retention GST left MORE retention GST held than GST still billed: the
  // ledger broke I3 and the receivable basis went negative before any receipt.
  // The retention GST left held is now the retained fraction of the GST still
  // billed, so it can never exceed it.
  const mixed = (retention) => invoice([line(1000), line(1000, 'gst_free')], retention)

  it('A: crediting the taxable line of a fully-retained mixed-tax invoice takes ALL the retention GST', () => {
    // A 1000.00 gst (GST 100.00) · B 1000.00 gst_free · retention 2000.00 + 100.00.
    // Credit A in full: retention part 2000 × 1000 ÷ 2000 = 1000.00. Retention GST
    // left held: GST still billed (100 − 100 = 0.00) × 1000 ÷ 1000 = 0.00
    // → the credit takes all 100.00.
    const inv = mixed(2000)
    expect(invoiceRetention(inv)).toMatchObject({ retentionCents: 200000, retentionGstCents: 10000, receivableCents: 0 })
    const b = book(inv)
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 1000 }])
    expect(cn).toMatchObject({
      subtotal: 1000, gstTotal: 100, grossTotal: 1100,
      retentionAmount: 1000, retentionGst: 100, retentionTotal: 1100, receivableTotal: 0,
    })
    expect(ledgerInvariantError(inv, b.ledger)).toBeNull()
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([100000, 0])
    expect(p.receivableBasisCents).toBe(0) // 2100 − 1100 − 1000 held
    // The GST-free remainder is still fully retained and releasable.
    const r = b.release(1000)
    expect([r.amount, r.gstAmount]).toEqual([1000, 0])
    expect(b.position().receivableBasisCents).toBe(100000)
  })

  it('A, the other order: crediting the GST-free line first frees NO retention GST and leaves the basis at 0', () => {
    const inv = mixed(2000)
    const b = book(inv)
    expect(b.position().receivableBasisCents).toBe(0)
    // Held after: GST still billed 100.00 × 1000.00 held ÷ 1000.00 still billed
    // = 100.00 — all of it. (The superseded rule took 50.00 here and RAISED the
    // receivable from 0.00 to 50.00 on a credit that carried no GST.)
    const cn = b.credit([{ invoiceLineIndex: 1, amount: 1000 }])
    expect(cn).toMatchObject({ gstTotal: 0, retentionAmount: 1000, retentionGst: 0, retentionTotal: 1000, receivableTotal: 0 })
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([100000, 10000])
    // 2100 − 1000 credited − 1100 held.
    expect(p.receivableBasisCents).toBe(0)
  })

  it('B: a credit allocated after a release void (10% retention) takes all the retention GST no longer billed', () => {
    // retention 200.00 + 10.00.
    //   1. release 200.00 (+10.00)   2. credit B 900.00   3. credit A 900.00 (GST 90.00)
    //      — neither takes retention, none is held
    //   4. void the release (I3 holds exactly)   5. credit A 100.00 (GST 10.00)
    // Step 5: retention part 200 × 100 ÷ 200 = 100.00; retention GST left held
    // = GST still billed (100 − 100 = 0.00) × 100 ÷ 100 = 0.00 → takes 10.00.
    const inv = mixed(200)
    const b = book(inv)
    const r = b.release(200)
    const c1 = b.credit([{ invoiceLineIndex: 1, amount: 900 }])
    const c2 = b.credit([{ invoiceLineIndex: 0, amount: 900 }])
    expect([c1.retentionAmount, c1.retentionGst, c2.retentionAmount, c2.retentionGst]).toEqual([0, 0, 0, 0])
    expect(b.voidRelease(r)).toBeNull()
    const c3 = b.credit([{ invoiceLineIndex: 0, amount: 100 }])
    expect(c3).toMatchObject({ subtotal: 100, gstTotal: 10, retentionAmount: 100, retentionGst: 10, receivableTotal: 0 })
    expect(ledgerInvariantError(inv, b.ledger)).toBeNull()
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([10000, 0])
    expect(p.netIssuedGrossCents).toBe(10000) // 100.00 of the GST-free line
    expect(p.receivableBasisCents).toBe(0)    // all of it still retained
  })

  it('rounding: a tiny single-tax invoice never ends a cent below zero', () => {
    // 0.35 gst (GST 0.04) · retention 0.31 + 0.04 (0.04 × 31 ÷ 35 = 0.035 → 0.04).
    // Credit 0.31: line GST 0.04 × 31 ÷ 35 = 0.035 → 0.04 (all of it); retention
    // part 0.31 × 31 ÷ 35 = 0.2746 → 0.27; retention GST left held
    // = GST still billed 0.00 × 0.04 ÷ 0.04 = 0.00 → takes 0.04.
    const inv = invoice([line(0.35)], 0.31)
    expect(invoiceRetention(inv)).toMatchObject({ gstCents: 4, retentionCents: 31, retentionGstCents: 4 })
    const b = book(inv)
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 0.31 }])
    expect(cn).toMatchObject({ gstTotal: 0.04, retentionAmount: 0.27, retentionGst: 0.04 })
    const p = b.position()
    expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([4, 0])
    expect(p.receivableBasisCents).toBe(0) // 0.39 − 0.35 − 0.04
  })
})

// ── Evidence: mixed-tax invoices with high retention ─────────────────────────
//
// Every row of every table: [ credit subtotal, credit GST, retention part
// ex-GST, retention GST part, basis before, basis after, retention held after
// ex-GST, retention GST held after ]. Each table is asserted three ways: the
// oracle computes it, the library produces it, and no row raises the basis.

describe('mixed-tax, high-retention: a credit never raises the receivable', () => {
  // Line A 1000.00 gst (GST 100.00) · line B 1000.00 gst_free
  //   subtotal 2000.00 · GST 100.00 · gross 2100.00
  const TWO = [['1000.00', 'gst'], ['1000.00', 'gst_free']]
  const A = ['credit', [[0, '1000.00']]]
  const B = ['credit', [[1, '1000.00']]]

  describe('retention 2000.00 (100%): retention GST 100.00, nothing receivable', () => {
    it('the invoice withholds everything: receivable basis 0.00', () => {
      const inv = invoice([line(1000), line(1000, 'gst_free')], 2000)
      expect(invoiceRetention(inv)).toEqual({
        subtotalCents: 200000, gstCents: 10000, grossCents: 210000,
        retentionCents: 200000, retentionGstCents: 10000, retentionTotalCents: 210000, receivableCents: 0,
      })
    })

    it('credit B (GST-free) then A: B frees NO retention GST and the basis stays 0.00', () => {
      // B: ex-GST 2000 × 1000 ÷ 2000 = 1000.00. GST left held = GST still billed
      //    100.00 × 1000.00 held ÷ 1000.00 still billed = 100.00 → takes 0.00.
      //    (The superseded rule took 50.00 and raised the basis from 0.00 to 50.00.)
      // A: the final credit takes everything still held, 1000.00 + 100.00.
      expectCreditTable(TWO, '2000.00', [B, A], [
        ['1000.00', '0.00', '1000.00', '0.00', '0.00', '0.00', '1000.00', '100.00'],
        ['1000.00', '100.00', '1000.00', '100.00', '0.00', '0.00', '0.00', '0.00'],
      ])
    })

    it('credit A (taxable) then B: A frees ALL 100.00 of retention GST and the basis stays 0.00', () => {
      // A: ex-GST 1000.00. GST left held = GST still billed 0.00 × … = 0.00 → takes 100.00.
      // B: the final credit takes the 1000.00 still held; no retention GST is left.
      expectCreditTable(TWO, '2000.00', [A, B], [
        ['1000.00', '100.00', '1000.00', '100.00', '0.00', '0.00', '1000.00', '0.00'],
        ['1000.00', '0.00', '1000.00', '0.00', '0.00', '0.00', '0.00', '0.00'],
      ])
    })
  })

  describe.each([
    // retention, retention GST, basis at issue, table B→A, table A→B
    ['1000.00', '50%', '50.00', '1050.00',
      [
        ['1000.00', '0.00', '500.00', '0.00', '1050.00', '550.00', '500.00', '50.00'],
        ['1000.00', '100.00', '500.00', '50.00', '550.00', '0.00', '0.00', '0.00'],
      ],
      [
        ['1000.00', '100.00', '500.00', '50.00', '1050.00', '500.00', '500.00', '0.00'],
        ['1000.00', '0.00', '500.00', '0.00', '500.00', '0.00', '0.00', '0.00'],
      ]],
    ['1820.00', '91%', '91.00', '189.00',
      [
        ['1000.00', '0.00', '910.00', '0.00', '189.00', '99.00', '910.00', '91.00'],
        ['1000.00', '100.00', '910.00', '91.00', '99.00', '0.00', '0.00', '0.00'],
      ],
      [
        ['1000.00', '100.00', '910.00', '91.00', '189.00', '90.00', '910.00', '0.00'],
        ['1000.00', '0.00', '910.00', '0.00', '90.00', '0.00', '0.00', '0.00'],
      ]],
    ['2000.00', '100%', '100.00', '0.00',
      [
        ['1000.00', '0.00', '1000.00', '0.00', '0.00', '0.00', '1000.00', '100.00'],
        ['1000.00', '100.00', '1000.00', '100.00', '0.00', '0.00', '0.00', '0.00'],
      ],
      [
        ['1000.00', '100.00', '1000.00', '100.00', '0.00', '0.00', '1000.00', '0.00'],
        ['1000.00', '0.00', '1000.00', '0.00', '0.00', '0.00', '0.00', '0.00'],
      ]],
  ])('retention %s (%s)', (retention, _percent, retentionGst, basisAtIssue, tableBA, tableAB) => {
    it(`withholds ${retentionGst} of GST and leaves ${basisAtIssue} receivable`, () => {
      const o = oracleBook(TWO, retention)
      expect([centsText(o.o.RG), centsText(o.basis())]).toEqual([retentionGst, basisAtIssue])
      const inv = invoice([line(1000), line(1000, 'gst_free')], Number(retention))
      expect([cents(inv.retentionGst), cents(inv.receivableTotal)]).toEqual([o.o.RG, o.basis()])
    })

    it('credit B (GST-free) then A', () => {
      const run = expectCreditTable(TWO, retention, [B, A], tableBA)
      // The GST-free credit freed no retention GST; the taxable one all of it.
      expect(tableBA.map(row => row[3])).toEqual(['0.00', retentionGst])
      expect(run.b.position().receivableBasisCents).toBe(0)
    })

    it('credit A (taxable) then B', () => {
      const run = expectCreditTable(TWO, retention, [A, B], tableAB)
      expect(tableAB.map(row => row[3])).toEqual([retentionGst, '0.00'])
      expect(run.b.position().receivableBasisCents).toBe(0)
    })
  })

  describe('retention 1820.00 (91%) with a partial release of 500.00 before the credit', () => {
    // Release 500.00: GST 91.00 × 500 ÷ 1820 = 25.00. Held 1320.00 + 66.00;
    // basis 189.00 + 525.00 = 714.00.
    const released = ['release', '500.00']

    it('the release carries 25.00 of GST and makes 525.00 receivable', () => {
      const run = lockstep(TWO, '1820.00')
      const { expected } = run.release('500.00')
      expect([expected.amount, expected.gst].map(centsText)).toEqual(['500.00', '25.00'])
      expect(centsText(run.o.basis())).toBe('714.00')
    })

    it('then credit B (GST-free), then A', () => {
      // B: 1320 × 1000 ÷ 2000 = 660.00; GST left held 100 × 660 ÷ 1000 = 66.00 → takes 0.00.
      expectCreditTable(TWO, '1820.00', [released, B, A], [
        ['1000.00', '0.00', '660.00', '0.00', '714.00', '374.00', '660.00', '66.00'],
        ['1000.00', '100.00', '660.00', '66.00', '374.00', '0.00', '0.00', '0.00'],
      ])
    })

    it('then credit A (taxable), then B', () => {
      // A: 660.00; GST left held 0.00 × … = 0.00 → takes all 66.00.
      expectCreditTable(TWO, '1820.00', [released, A, B], [
        ['1000.00', '100.00', '660.00', '66.00', '714.00', '340.00', '660.00', '0.00'],
        ['1000.00', '0.00', '660.00', '0.00', '340.00', '0.00', '0.00', '0.00'],
      ])
    })
  })

  describe('retention 2000.00 (100%): a release of 700.00, its void, then the credit', () => {
    // Release 700.00 (+35.00) makes 735.00 receivable; the void takes it back.
    // The credits then behave exactly as if the release had never been posted.
    const releasedAndVoided = [['release', '700.00'], ['voidRelease', 0]]

    it('the release makes 735.00 receivable and its void restores 0.00', () => {
      const run = lockstep(TWO, '2000.00')
      const entry = run.release('700.00')
      expect([entry.expected.amount, entry.expected.gst].map(centsText)).toEqual(['700.00', '35.00'])
      expect(centsText(run.o.basis())).toBe('735.00')
      expect(run.voidRelease(entry)).toBeNull()
      expect([run.o.heldEx(), run.o.heldGst(), run.o.basis()].map(centsText)).toEqual(['2000.00', '100.00', '0.00'])
    })

    it('then credit B (GST-free), then A', () => {
      expectCreditTable(TWO, '2000.00', [...releasedAndVoided, B, A], [
        ['1000.00', '0.00', '1000.00', '0.00', '0.00', '0.00', '1000.00', '100.00'],
        ['1000.00', '100.00', '1000.00', '100.00', '0.00', '0.00', '0.00', '0.00'],
      ])
    })

    it('then credit A (taxable), then B', () => {
      expectCreditTable(TWO, '2000.00', [...releasedAndVoided, A, B], [
        ['1000.00', '100.00', '1000.00', '100.00', '0.00', '0.00', '1000.00', '0.00'],
        ['1000.00', '0.00', '1000.00', '0.00', '0.00', '0.00', '0.00', '0.00'],
      ])
    })
  })

  describe('three lines (gst 1000.00 · gst_free 600.00 · gst 400.00), retention 1820.00 (91%), credited line by line', () => {
    // subtotal 2000.00 · GST 140.00 · gross 2140.00
    // retention 1820.00 · retention GST 140 × 1820 ÷ 2000 = 127.40 · basis 192.60
    const THREE = [['1000.00', 'gst'], ['600.00', 'gst_free'], ['400.00', 'gst']]
    const full = [['credit', [[0, '1000.00']]], ['credit', [[1, '600.00']]], ['credit', [[2, '400.00']]]]
    // The row each line produces depends on what was credited before it.
    const L0 = ['1000.00', '100.00', '910.00', '91.00']
    const L1 = ['600.00', '0.00', '546.00', '0.00']
    const L2 = ['400.00', '40.00', '364.00', '36.40']

    it('withholds 127.40 of GST and leaves 192.60 receivable', () => {
      const o = oracleBook(THREE, '1820.00')
      expect([o.o.S, o.o.G, o.o.RG, o.basis()].map(centsText)).toEqual(['2000.00', '140.00', '127.40', '192.60'])
    })

    it.each([
      ['0, 1, 2', [0, 1, 2], [
        [...L0, '192.60', '93.60', '910.00', '36.40'],
        [...L1, '93.60', '39.60', '364.00', '36.40'],
        [...L2, '39.60', '0.00', '0.00', '0.00'],
      ]],
      ['0, 2, 1', [0, 2, 1], [
        [...L0, '192.60', '93.60', '910.00', '36.40'],
        [...L2, '93.60', '54.00', '546.00', '0.00'],
        [...L1, '54.00', '0.00', '0.00', '0.00'],
      ]],
      ['1, 0, 2', [1, 0, 2], [
        [...L1, '192.60', '138.60', '1274.00', '127.40'],
        [...L0, '138.60', '39.60', '364.00', '36.40'],
        [...L2, '39.60', '0.00', '0.00', '0.00'],
      ]],
      ['1, 2, 0', [1, 2, 0], [
        [...L1, '192.60', '138.60', '1274.00', '127.40'],
        [...L2, '138.60', '99.00', '910.00', '91.00'],
        [...L0, '99.00', '0.00', '0.00', '0.00'],
      ]],
      ['2, 0, 1', [2, 0, 1], [
        [...L2, '192.60', '153.00', '1456.00', '91.00'],
        [...L0, '153.00', '54.00', '546.00', '0.00'],
        [...L1, '54.00', '0.00', '0.00', '0.00'],
      ]],
      ['2, 1, 0', [2, 1, 0], [
        [...L2, '192.60', '153.00', '1456.00', '91.00'],
        [...L1, '153.00', '99.00', '910.00', '91.00'],
        [...L0, '99.00', '0.00', '0.00', '0.00'],
      ]],
    ])('order %s', (_label, order, expected) => {
      const run = expectCreditTable(THREE, '1820.00', order.map(i => full[i]), expected)
      // The GST-free line never frees retention GST; the two taxable lines free
      // 91.00 and 36.40 — the whole 127.40 — whatever the order.
      const freed = Object.fromEntries(order.map((lineIndex, k) => [lineIndex, expected[k][3]]))
      expect(freed).toEqual({ 0: '91.00', 1: '0.00', 2: '36.40' })
      const p = run.b.position()
      expect([p.retentionHeldExCents, p.retentionHeldGstCents, p.receivableBasisCents]).toEqual([0, 0, 0])
      expect(run.b.ledger.creditedGstCents).toBe(14000)
    })
  })
})

// ── What "never raises" does NOT cover ───────────────────────────────────────

describe('a credit never raises the receivable: the argument, and the three historical one-cent counterexamples', () => {
  // ── ARGUMENT (a paper proof of ONE statement; read what it does not cover) ──
  //
  // STATEMENT. Take a ledger state that satisfies I1–I4, and a credit that
  // allocateCredit accepts. Then the receivable part of the credit,
  //     P = (c − r) + (g − rg),
  // is ≥ 0, and therefore basis(after) = basis(before) − P ≤ basis(before).
  //
  // NOTATION (whole cents, before the credit):
  //   b, Gb   amount and GST still billed          h, hg   retention and retention GST held
  //   c, g    the credit and its GST (1 ≤ c ≤ b, 0 ≤ g ≤ Gb)
  //   f = max(0, c − (b − h))                      the I3 floor
  //   r       the ex-GST retention part chosen     (f ≤ r)
  //   rg(r) = hg − min(hg, share(Gb − g, h − r, b − c)), and rg(r) = hg when r = h
  //   share(t, p, w) = round-half-up(t × p ÷ w):   x − ½ < share ≤ x + ½ for its real value x
  //   basis = (b − h) + (Gb − hg), so the credit changes it by exactly −P.
  //
  // The rounding-direction loop stops as soon as P(r) ≥ 0 or r = f. So it is
  // enough to show P(f) ≥ 0, whatever happened on the way down.
  //
  //  (1) NON-FINAL, FLOOR 0 (c < b and h ≤ b − c), at r = 0.
  //      If the min is hg, rg = 0 and P = c + g > 0. Otherwise
  //        rg = hg − share(Gb − g, h, b − c)
  //           < (Gb·h/b + ½) − ((Gb − g)·h/(b − c) − ½)        [I4: hg ≤ share(Gb, h, b)]
  //           = h·(g·b − Gb·c) / (b·(b − c)) + 1
  //           ≤ g·h/(b − c) + 1  ≤  g + 1                      [Gb·c ≥ 0;  h ≤ b − c]
  //      rg is a whole number strictly below g + 1, so rg ≤ g and P(0) ≥ c ≥ 1.
  //      This answers the question asked: with the floor at 0,
  //      retentionGstFor(0) ≤ g — never more than the credit's OWN GST, let
  //      alone its gross. There is no valid state in which it exceeds c + g.
  //
  //  (2) NON-FINAL, FLOOR POSITIVE (h > b − c), at r = f. Then h − f = b − c,
  //      so the share is of the whole: share(Gb − g, b − c, b − c) = Gb − g, and
  //        rg = max(0, hg − (Gb − g))
  //        P(f) = (b − h) + g − rg = min( (b − h) + g , (b − h) + (Gb − hg) ) ≥ 0
  //      by I3 (h ≤ b) and I4 (hg ≤ share(Gb, h, b) ≤ Gb). So the floor never
  //      forces a negative receivable part: no exception is needed.
  //
  //  (3) FINAL (c = b). Every line is then fully credited, so g = Gb (line GST
  //      is cumulative to the stored figure); r = h and rg = hg:
  //        P = (b − h) + (Gb − hg) ≥ 0, and the basis lands on exactly 0.
  //
  // WHAT IS PROVEN: the statement above, for exact integer arithmetic.
  // WHAT IS NOT PROVEN HERE, only enforced or measured:
  //   · that every REACHABLE state satisfies I1–I4 — credits and releases
  //     preserve them by construction and a void that would not is refused;
  //     this is checked after every step by the property tests, not proven;
  //   · that the library computes these formulas — measured: it equals the
  //     independent oracle on every entry of every run;
  //   · case (3) uses per-line totals that agree with the ledger totals (true by
  //     construction; the invariants do not look at lines);
  //   · amounts beyond the supported range (see the monetary-range tests).
  //
  // ── THE COUNTEREXAMPLES ─────────────────────────────────────────────────────
  //
  // Before the rounding-direction rule, r was the half-up share and nothing
  // else. Three credits were found that RAISED the basis by one cent — the
  // minimal one by hand, two by the 30,000-sequence run on seed 987654321. All
  // three have the same shape: a ONE-CENT credit carrying no GST of its own,
  // and TWO roundings that both went against the receivable:
  //   (i)  the ex-GST share, a fraction of a cent, rounded UP to the whole cent;
  //   (ii) the retention GST held had been rounded UP to its retained share,
  //        and the retained share after the credit rounded DOWN — one cent of
  //        retention GST "freed" where the real figure is a few hundredths.
  // Old result: a 0.01 credit carrying 0.02 of retention — receivable part
  // −0.01. In real (unrounded) terms the receivable part was positive in all
  // three (between +0.12 and +0.40 of a cent), so the old result had the wrong
  // SIGN, not just the wrong cent. New result: the ex-GST part steps down to
  // 0.00, no GST is freed, and the whole cent falls on the receivable.

  // Runs `history` under the previous rule (oracle only) and under the current
  // one (library and oracle in lockstep), then the offending credit on both.
  function reproduce(specs, retention, history, rows) {
    const old = oracleBook(specs, retention, { previousRule: true })
    history(old)
    const run = lockstep(specs, retention)
    history(run)
    // Identical up to here: the rule had not yet made a difference.
    const state = (o) => [o.heldEx(), o.heldGst(), o.o.S - o.o.cS, o.o.G - o.o.cG, o.basis()]
    expect(state(run.o)).toEqual(state(old))
    const before = {
      heldEx: old.heldEx(), heldGst: old.heldGst(), stillBilled: old.o.S - old.o.cS, gstStillBilled: old.o.G - old.o.cG,
      basis: old.basis(),
    }
    const oldCredit = old.credit(rows)
    const entry = run.credit(rows)
    return { old, oldCredit, run, entry, before }
  }

  // The two roundings, stated on the numbers themselves.
  function expectTheTwoRoundings({ before, oldCredit }) {
    const { heldEx: h, heldGst: hg, stillBilled: b, gstStillBilled: Gb } = before
    const c = oldCredit.subtotal
    expect([c, oldCredit.gst]).toEqual([1n, 0n])
    // (i) the real ex-GST share h × c ÷ b is LESS than one cent, and rounds up to it.
    expect(h * c < b).toBe(true)
    expect(share(h, c, b)).toBe(1n)
    // (ii) the GST held is its retained share rounded UP (real value below it)…
    expect(share(Gb, h, b)).toBe(hg)
    expect(Gb * h < hg * b).toBe(true)
    // …and the retained share after the credit rounds DOWN to a cent less
    // (real value above it): one cent freed for a real movement far below a cent.
    expect(share(Gb, h - 1n, b - c)).toBe(hg - 1n)
    expect(Gb * (h - 1n) > (hg - 1n) * (b - c)).toBe(true)
    // In real terms the receivable part was POSITIVE: c − h·c/b − (Gb·h/b − Gb·(h−1)/(b−c)) > 0.
    // Multiplied through by b·(b − c):
    expect(c * b * (b - c) - h * c * (b - c) - (Gb * h * (b - c) - Gb * (h - 1n) * b) > 0n).toBe(true)
  }

  // Credits everything left in one note and expects the exact close.
  function expectExactClose(run) {
    const rest = run.o.lines
      .map((l, i) => [i, centsText(l.amount - l.credited)])
      .filter(([, amountText]) => parseCents(amountText) > 0n)
    const last = run.credit(rest)
    expect(last.basisAfter).toBe(0n)
    const p = run.b.position()
    expect(BigInt(run.b.ledger.creditedGstCents)).toBe(run.o.o.G)
    expect(BigInt(run.b.ledger.creditedSubtotalCents)).toBe(run.o.o.S)
    expect([p.retentionHeldExCents, p.retentionHeldGstCents, p.retentionHeldCents, p.receivableBasisCents, p.netIssuedGrossCents])
      .toEqual([0, 0, 0, 0, 0])
    expect(ledgerInvariantError(run.inv, run.b.ledger)).toBeNull()
    return last
  }

  it('MINIMAL — 1.00 taxable, 0.55 retained, credit 0.01: was 0.49 → 0.50, is 0.49 → 0.48', () => {
    // GST 0.10; retention GST 0.10 × 0.55 ÷ 1.00 = 0.055 → 0.06; basis 1.10 − 0.61 = 0.49.
    // Credit 0.01: line GST 0.10 × 0.01 ÷ 1.00 = 0.001 → 0.00.
    //  OLD  (i)  retention 0.55 × 0.01 ÷ 1.00 = 0.0055 → 0.01
    //       (ii) GST left held 0.10 × 0.54 ÷ 0.99 = 0.0545 → 0.05, against 0.06 held
    //            (itself 0.055 rounded up): the credit takes 0.01.
    //       A 0.01 credit carrying 0.01 + 0.01 of retention: receivable part −0.01.
    //  NEW  0.02 > 0.01, so the ex-GST part steps down to 0.00; GST left held
    //       0.10 × 0.55 ÷ 0.99 = 0.0556 → 0.06 — all of it. Receivable part +0.01.
    const found = reproduce([['1.00', 'gst']], '0.55', () => {}, [[0, '0.01']])
    const { old, oldCredit, run, entry, before } = found
    expect([before.heldEx, before.heldGst, before.basis].map(centsText)).toEqual(['0.55', '0.06', '0.49'])

    expect([oldCredit.subtotal, oldCredit.gst, oldCredit.retention, oldCredit.retentionGst].map(centsText))
      .toEqual(['0.01', '0.00', '0.01', '0.01'])
    expect(centsText(old.basis())).toBe('0.50') // ROSE by a cent
    expectTheTwoRoundings(found)

    expect(entry.cn).toMatchObject({
      subtotal: 0.01, gstTotal: 0, grossTotal: 0.01,
      retentionAmount: 0, retentionGst: 0, retentionTotal: 0, receivableTotal: 0.01,
    })
    expect([entry.expected.halfUp.retention, entry.expected.halfUp.retentionGst]).toEqual([1n, 1n])
    expect([entry.basisBefore, entry.basisAfter].map(centsText)).toEqual(['0.49', '0.48'])
    expect([run.o.heldEx(), run.o.heldGst()].map(centsText)).toEqual(['0.55', '0.06'])
    expect(ledgerInvariantError(run.inv, run.b.ledger)).toBeNull()
    // The cent of retention not taken now is taken by the closing credit.
    const last = expectExactClose(run)
    expect([last.expected.subtotal, last.expected.gst, last.expected.retention, last.expected.retentionGst].map(centsText))
      .toEqual(['0.99', '0.10', '0.55', '0.06'])
  })

  it('SEED 987654321, sequence 13986 (no void) — 6,225,106,778.46 gst + 0.01 gst_free, 6,012,208,126.65 retained', () => {
    // subtotal 6,225,106,778.47 · GST 622,510,677.85 · retention GST 601,220,812.67 · basis 234,188,517.00
    //   1. credit line 1: 3,603,899,252.80 (GST 360,389,925.28) → takes 3,480,645,898.36 + 348,064,589.84
    //   2. release 607,647,067.16 (+60,764,706.71)
    //      → held 1,923,915,161.13 + 192,391,516.12 against 2,621,207,525.67 + 262,120,752.57 still billed
    //   3. THE CREDIT: 0.01 of the GST-free line.
    //  OLD  (i)  1,923,915,161.13 × 0.01 ÷ 2,621,207,525.67 = 0.0073 → 0.01
    //       (ii) GST held …516.12 is the retained share …516.115201 rounded up;
    //            after the credit it is …516.114935 → …516.11: takes 0.01.
    //       Basis 767,021,600.99 → 767,021,601.00.
    //  NEW  ex-GST part 0.00; retained share …516.115935 → …516.12, nothing freed.
    //       Basis 767,021,600.99 → 767,021,600.98.
    const specs = [['6225106778.46', 'gst'], ['0.01', 'gst_free']]
    const history = (book) => {
      book.credit([[0, '3603899252.80']])
      book.release('607647067.16')
    }
    const found = reproduce(specs, '6012208126.65', history, [[1, '0.01']])
    const { old, oldCredit, run, entry, before } = found
    expect([before.heldEx, before.heldGst, before.stillBilled, before.gstStillBilled, before.basis].map(centsText))
      .toEqual(['1923915161.13', '192391516.12', '2621207525.67', '262120752.57', '767021600.99'])

    expect([oldCredit.subtotal, oldCredit.gst, oldCredit.retention, oldCredit.retentionGst].map(centsText))
      .toEqual(['0.01', '0.00', '0.01', '0.01'])
    expect(centsText(old.basis())).toBe('767021601.00') // ROSE by a cent
    expectTheTwoRoundings(found)

    expect([entry.expected.subtotal, entry.expected.gst, entry.expected.retention, entry.expected.retentionGst].map(centsText))
      .toEqual(['0.01', '0.00', '0.00', '0.00'])
    expect(entry.cn).toMatchObject({ retentionAmount: 0, retentionGst: 0, receivableTotal: 0.01 })
    expect([entry.basisBefore, entry.basisAfter].map(centsText)).toEqual(['767021600.99', '767021600.98'])
    expect([run.o.heldEx(), run.o.heldGst()].map(centsText)).toEqual(['1923915161.13', '192391516.12'])
    const last = expectExactClose(run)
    expect([last.expected.subtotal, last.expected.gst, last.expected.retention, last.expected.retentionGst].map(centsText))
      .toEqual(['2621207525.66', '262120752.57', '1923915161.13', '192391516.12'])
  })

  it('SEED 987654321, sequence 24918 (after a void) — 0.01 gst + 2,426,216.71 gst, 2,091,264.26 retained', () => {
    // subtotal 2,426,216.72 · GST 242,621.67 (the 0.01 line carries 0.00) · retention GST 209,126.42 · basis 368,447.71
    //   1. release 1,127,223.92 (+112,722.39)        2. void that release (back to the issued position)
    //   3. credit line 2: 1,746,692.32 (GST 174,669.23) → takes 1,505,551.91 + 150,555.18
    //      → held 585,712.35 + 58,571.24 against 679,524.40 + 67,952.44 still billed
    //   4. THE CREDIT: the 0.01 taxable line (its GST is 0.00).
    //  OLD  (i)  585,712.35 × 0.01 ÷ 679,524.40 = 0.0086 → 0.01
    //       (ii) GST held 58,571.24 is the retained share 58,571.235000 — an exact
    //            half — rounded up; after the credit it is 58,571.234861 → …571.23: takes 0.01.
    //       Basis 103,193.25 → 103,193.26.
    //  NEW  ex-GST part 0.00; retained share 58,571.235861 → …571.24, nothing freed.
    //       Basis 103,193.25 → 103,193.24.
    const specs = [['0.01', 'gst'], ['2426216.71', 'gst']]
    const history = (book) => {
      const release = book.release('1127223.92')
      book.voidRelease(release)
      book.credit([[1, '1746692.32']])
    }
    const found = reproduce(specs, '2091264.26', history, [[0, '0.01']])
    const { old, oldCredit, run, entry, before } = found
    expect([before.heldEx, before.heldGst, before.stillBilled, before.gstStillBilled, before.basis].map(centsText))
      .toEqual(['585712.35', '58571.24', '679524.40', '67952.44', '103193.25'])
    // The retained share before the credit is an EXACT half-cent.
    expect(2n * before.gstStillBilled * before.heldEx).toBe((2n * before.heldGst - 1n) * before.stillBilled)

    expect([oldCredit.subtotal, oldCredit.gst, oldCredit.retention, oldCredit.retentionGst].map(centsText))
      .toEqual(['0.01', '0.00', '0.01', '0.01'])
    expect(centsText(old.basis())).toBe('103193.26') // ROSE by a cent
    expectTheTwoRoundings(found)

    expect([entry.expected.subtotal, entry.expected.gst, entry.expected.retention, entry.expected.retentionGst].map(centsText))
      .toEqual(['0.01', '0.00', '0.00', '0.00'])
    expect(entry.cn).toMatchObject({ retentionAmount: 0, retentionGst: 0, receivableTotal: 0.01 })
    expect([entry.basisBefore, entry.basisAfter].map(centsText)).toEqual(['103193.25', '103193.24'])
    expect([run.o.heldEx(), run.o.heldGst()].map(centsText)).toEqual(['585712.35', '58571.24'])
    const last = expectExactClose(run)
    expect([last.expected.subtotal, last.expected.gst, last.expected.retention, last.expected.retentionGst].map(centsText))
      .toEqual(['679524.39', '67952.44', '585712.35', '58571.24'])
  })

  it('the step down happens only when needed: an ordinary credit keeps its half-up share', () => {
    const run = lockstep([['1000.00', 'gst']], '100.00')
    const { expected } = run.credit([[0, '200.00']])
    expect([expected.retention, expected.retentionGst]).toEqual([expected.halfUp.retention, expected.halfUp.retentionGst])
    expect([expected.retention, expected.retentionGst].map(centsText)).toEqual(['20.00', '2.00'])
  })

  it('the FINAL credit is never stepped down: it takes all that is held and leaves the basis at 0', () => {
    // 0.01 taxable (GST 0.00), fully retained: the final credit of 0.01 takes the 0.01 held.
    const run = lockstep([['0.01', 'gst']], '0.01')
    const { expected, basisBefore, basisAfter } = run.credit([[0, '0.01']])
    expect(expected.final).toBe(true)
    expect([expected.retention, expected.retentionGst].map(centsText)).toEqual(['0.01', '0.00'])
    expect([basisBefore, basisAfter]).toEqual([0n, 0n])
  })

  it('where the I3 floor is positive the part cannot go below it — and the receivable part is still not negative (case 2)', () => {
    // 100.00 taxable, fully retained (100.00 + 10.00): basis 0.00. Every credit
    // must take its whole ex-GST amount from retention (floor = the credit).
    const run = lockstep([['100.00', 'gst']], '100.00')
    for (const amountText of ['0.01', '0.04', '33.33', '0.05']) {
      const { expected, basisBefore, basisAfter } = run.credit([[0, amountText]])
      expect(expected.floor).toBe(parseCents(amountText))
      expect(expected.retention).toBe(expected.floor)
      // At the floor the retention GST part is exactly the credit's own GST…
      expect(expected.retentionGst).toBe(expected.gst)
      // …so the receivable part is nil and the basis stays 0.00.
      expect([basisBefore, basisAfter]).toEqual([0n, 0n])
    }
    expectExactClose(run)
  })
})

describe('the cap: a credit never RE-WITHHOLDS retention GST (held after ≤ held before)', () => {
  const held = (run) => [run.o.heldEx(), run.o.heldGst()].map(centsText)

  it('by a cent, with no void: the retained fraction rounds DOWN at the release and UP after the credit', () => {
    // 689.25 gst (GST 68.93) · 3183.20 input_taxed · retention 140.57 + 2.50
    //   (68.93 × 140.57 ÷ 3872.45 = 2.5022).
    const run = lockstep([['689.25', 'gst'], ['3183.20', 'input_taxed']], '140.57')
    // Release 108.28, leaving 32.29: the retained fraction of the GST billed is
    // 68.93 × 32.29 ÷ 3872.45 = 0.5748 → 0.57 held, so the release takes 1.93.
    expect(centsText(run.release('108.28').expected.gst)).toBe('1.93')
    expect(held(run)).toEqual(['32.29', '0.57'])
    // Credit the input-taxed line: 32.29 × 3183.20 ÷ 3872.45 = 26.5427 → 26.54,
    // leaving 5.75. The retained fraction of the GST still billed is
    // 68.93 × 5.75 ÷ 689.25 = 0.5750 → 0.58 — a cent MORE than is held. The cap
    // binds: 0.57 stays held and the credit takes 0.00, never −0.01.
    const { expected, basisBefore, basisAfter } = run.credit([[1, '3183.20']])
    expect([expected.retention, expected.retentionGst].map(centsText)).toEqual(['26.54', '0.00'])
    expect(held(run)).toEqual(['5.75', '0.57'])
    expect(basisAfter <= basisBefore).toBe(true)
    // The last release still clears everything.
    expect(centsText(run.release('5.75').expected.gst)).toBe('0.57')
    expect(held(run)).toEqual(['0.00', '0.00'])
  })

  it('materially, after a credit void: retention GST released meanwhile is not withheld again', () => {
    // A 1000.00 gst · B 1000.00 gst_free · retention 200.00 + 10.00.
    const run = lockstep([['1000.00', 'gst'], ['1000.00', 'gst_free']], '200.00')
    const first = run.credit([[1, '1000.00']])         // B: takes 100.00 + 0.00
    expect(held(run)).toEqual(['100.00', '10.00'])
    expect(centsText(run.release('50.00').expected.gst)).toBe('5.00')
    expect(run.voidCredit(first)).toBeNull()
    // 150.00 + 5.00 held; the retained fraction of the GST billed would be
    // 100.00 × 150 ÷ 2000 = 7.50. The 2.50 short was released and stays receivable.
    expect(held(run)).toEqual(['150.00', '5.00'])
    // Credit B again: 150 × 1000 ÷ 2000 = 75.00, leaving 75.00; retained
    // fraction 100.00 × 75 ÷ 1000 = 7.50 > 5.00 held → the cap binds, takes 0.00.
    const again = run.credit([[1, '1000.00']])
    expect([again.expected.retention, again.expected.retentionGst].map(centsText)).toEqual(['75.00', '0.00'])
    expect(held(run)).toEqual(['75.00', '5.00'])
    expect(again.basisAfter <= again.basisBefore).toBe(true)
    // Half of A: 37.50; retained fraction 50.00 × 37.50 ÷ 500 = 3.75 → takes 1.25.
    const half = run.credit([[0, '500.00']])
    expect([half.expected.retention, half.expected.retentionGst].map(centsText)).toEqual(['37.50', '1.25'])
    expect(centsText(run.release('37.50').expected.gst)).toBe('3.75')
    expect([run.o.heldEx(), run.o.heldGst(), run.o.basis()].map(centsText)).toEqual(['0.00', '0.00', '550.00'])
  })
})

describe('a void that would leave the retained slice carrying GST at a stale proportion is REFUSED', () => {
  // Formerly a reported defect: such a void was accepted, and the NEXT credit,
  // whatever it credited, "trued up" by moving the surplus retention GST into
  // the receivable (0.01 credited, basis +4.99). I4 now refuses the void; the
  // entries computed on top of the voided one are voided first.
  const TWO = [['1000.00', 'gst'], ['1000.00', 'gst_free']]
  const REFUSED = 'Retention GST held would exceed the retained share of the GST still billed.'
  const state = (run) => [run.o.heldEx(), run.o.heldGst(), run.o.basis()].map(centsText)

  it('credit A, release what is left: voiding the CREDIT is refused; void the release first and everything works', () => {
    // Retention 200.00 + 10.00.
    //   1. credit A in full: takes 100.00 and ALL 10.00 of retention GST (no GST is still billed)
    //   2. release the 100.00 still held (+0.00 GST — it was computed on top of the credit)
    //   3. void the credit → 100.00 + 10.00 would be held, where the retained share
    //      of the GST billed is 100.00 × 100 ÷ 2000 = 5.00: REFUSED.
    const run = lockstep(TWO, '200.00')
    const credit = run.credit([[0, '1000.00']])
    expect([credit.expected.retention, credit.expected.retentionGst].map(centsText)).toEqual(['100.00', '10.00'])
    const release = run.release('100.00')
    expect(centsText(release.expected.gst)).toBe('0.00')
    expect(state(run)).toEqual(['0.00', '0.00', '1000.00'])

    const before = totalsOf(run.b.ledger)
    expect(ledgerInvariantError(run.inv, applyCreditVoid(run.b.ledger, credit.cn))).toBe(REFUSED)
    expect(run.voidCredit(credit)).toBe(REFUSED)
    // The refusal changed nothing.
    expect(totalsOf(run.b.ledger)).toEqual(before)
    expect(run.b.ledger.seq).toBe(2)

    // THE VALID ORDER: the later entry first.
    expect(run.voidRelease(release)).toBeNull()
    expect(state(run)).toEqual(['100.00', '0.00', '900.00'])
    expect(run.voidCredit(credit)).toBeNull()
    expect(state(run)).toEqual(['200.00', '10.00', '1890.00'])
    expect(totalsOf(run.b.ledger)).toEqual(totalsOf(emptyLedger()))

    // The credit that used to raise the basis by 4.99 now frees no retention GST.
    const small = run.credit([[1, '0.01']])
    expect([small.expected.gst, small.expected.retention, small.expected.retentionGst].map(centsText))
      .toEqual(['0.00', '0.00', '0.00'])
    expect([small.basisBefore, small.basisAfter].map(centsText)).toEqual(['1890.00', '1889.99'])
    // And the rest of the life of the invoice never raises it.
    for (const rows of [[[1, '999.99']], [[0, '400.00']], [[0, '600.00']]]) {
      const next = run.credit(rows)
      expect(next.basisAfter <= next.basisBefore).toBe(true)
    }
    expect(state(run)).toEqual(['0.00', '0.00', '0.00'])
  })

  it('release, credit half of A: voiding the RELEASE is refused; void the credit first and everything works', () => {
    // Retention 200.00 + 10.00.
    //   1. release 100.00 (+5.00)                 held 100.00 + 5.00
    //   2. credit A 500.00 (GST 50.00): takes 25.00 + 2.50 (computed on top of the release)
    //   3. void the release → 175.00 + 7.50 would be held, where the retained share
    //      of the GST still billed is 50.00 × 175 ÷ 1500 = 5.83: REFUSED.
    const run = lockstep(TWO, '200.00')
    const release = run.release('100.00')
    expect(centsText(release.expected.gst)).toBe('5.00')
    const credit = run.credit([[0, '500.00']])
    expect([credit.expected.retention, credit.expected.retentionGst].map(centsText)).toEqual(['25.00', '2.50'])
    expect(state(run)).toEqual(['75.00', '2.50', '1472.50'])

    const before = totalsOf(run.b.ledger)
    expect(ledgerInvariantError(run.inv, applyReleaseVoid(run.b.ledger, release.r))).toBe(REFUSED)
    expect(run.voidRelease(release)).toBe(REFUSED)
    expect(totalsOf(run.b.ledger)).toEqual(before)

    // THE VALID ORDER: the later entry first.
    expect(run.voidCredit(credit)).toBeNull()
    expect(state(run)).toEqual(['100.00', '5.00', '1995.00'])
    expect(run.voidRelease(release)).toBeNull()
    expect(state(run)).toEqual(['200.00', '10.00', '1890.00'])

    // Re-entered without the release, the same credit takes 50.00 + 5.00, and
    // the small GST-free credit (formerly +1.66 on the basis) frees nothing.
    const again = run.credit([[0, '500.00']])
    expect([again.expected.retention, again.expected.retentionGst].map(centsText)).toEqual(['50.00', '5.00'])
    const small = run.credit([[1, '0.01']])
    expect(centsText(small.expected.retentionGst)).toBe('0.00')
    expect(small.basisAfter <= small.basisBefore).toBe(true)
  })

  it('a void in creation order is refused only when a later entry depends on it: independent entries void freely', () => {
    // Single-tax invoice: every entry keeps the 10% proportion, so any void order is consistent.
    const run = lockstep([['1000.00', 'gst']], '100.00')
    const c1 = run.credit([[0, '200.00']])
    const r1 = run.release('30.00')
    const c2 = run.credit([[0, '100.00']])
    expect(run.voidCredit(c1)).toBeNull()
    expect(run.voidRelease(r1)).toBeNull()
    expect(run.voidCredit(c2)).toBeNull()
    expect(totalsOf(run.b.ledger)).toEqual(totalsOf(emptyLedger()))
  })
})

// ── No upper limit ───────────────────────────────────────────────────────────

describe('very large invoices — retention, credit and release arithmetic is exact (no 20,000,000.00 limit)', () => {
  const LARGE = [
    // 250,000,000.00 + GST 25,000,000.00; 5% retained → 12,500,000.00 + 1,250,000.00.
    ['250,000,000.00 taxable, 5% retained',
      [['250000000.00', 'gst']], '12500000.00',
      { subtotal: '250000000.00', gst: '25000000.00', retentionGst: '1250000.00', receivable: '261250000.00' }],
    // 9,999,999,999.99 + GST 999,999,999.999 → 1,000,000,000.00; retained
    // 1,000,000,000.00; its GST 10^9 × 10^9 ÷ 9,999,999,999.99 = 100,000,000.0000001 → 100,000,000.00.
    ['9,999,999,999.99 taxable, 1,000,000,000.00 retained',
      [['9999999999.99', 'gst']], '1000000000.00',
      { subtotal: '9999999999.99', gst: '1000000000.00', retentionGst: '100000000.00', receivable: '9899999999.99' }],
    // Mixed tax, 7,500,000,000.00: GST 624,817,289.36 (…289.364 down) + 4.02 (4.015 up).
    // 91% retained = 6,825,000,000.00; its GST 624,817,293.38 × 0.91 = 568,583,736.9758 → …736.98.
    ['7,500,000,000.00 mixed-tax, 91% retained',
      [['6248172893.64', 'gst'], ['1234567890.12', 'gst_free'], ['40.15', 'gst'], ['17259176.09', 'input_taxed']], '6825000000.00',
      { subtotal: '7500000000.00', gst: '624817293.38', retentionGst: '568583736.98', receivable: '731233556.40' }],
  ]

  describe.each(LARGE)('%s', (_label, specs, retention, stored) => {
    it('the invoice stores the hand-computed figures and is not refused', () => {
      const run = lockstep(specs, retention)
      expect([run.o.o.S, run.o.o.G, run.o.o.RG, run.o.basis()].map(centsText))
        .toEqual([stored.subtotal, stored.gst, stored.retentionGst, stored.receivable])
      expect([cents(run.inv.subtotal), cents(run.inv.gstTotal), cents(run.inv.retentionGst), cents(run.inv.receivableTotal)].map(centsText))
        .toEqual([stored.subtotal, stored.gst, stored.retentionGst, stored.receivable])
      expect(retentionError(run.inv.retention, run.inv.subtotal)).toBeNull()
      expect(ledgerInvariantError(run.inv, emptyLedger())).toBeNull()
    })

    it.each([2, 3, 7, 13])('releases in %i uneven pieces telescope EXACTLY to the stored retention GST', (n) => {
      const run = lockstep(specs, retention)
      // Uneven pieces: 1, 2, … n−1 parts of the triangular total, then the rest.
      const R = run.o.o.R
      const unit = R / BigInt(n * (n + 1) / 2)
      let gst = 0n
      for (let k = 1; k <= n; k += 1) {
        const piece = k === n ? run.o.heldEx() : unit * BigInt(k) + 1n
        gst += run.release(centsText(piece)).expected.gst
      }
      expect(centsText(gst)).toBe(stored.retentionGst)
      const p = run.b.position()
      expect([p.retentionHeldExCents, p.retentionHeldGstCents]).toEqual([0, 0])
      expect(BigInt(p.receivableBasisCents)).toBe(run.o.o.S + run.o.o.G)
    })

    it('partial credits of every line in several pieces, a release between them, and a final full credit', () => {
      const run = lockstep(specs, retention)
      const remaining = (i) => run.o.lines[i].amount - run.o.lines[i].credited
      const rows = (amountOf) => specs.map((_, i) => [i, centsText(amountOf(i))]).filter(([, text]) => parseCents(text) > 0n)
      const raised = []
      const credit = (r) => {
        const entry = run.credit(r)
        if (entry.basisAfter > entry.basisBefore) raised.push([centsText(entry.basisBefore), centsText(entry.basisAfter)])
        return entry
      }

      credit(rows(() => 1n))                                  // one cent of every line
      credit(rows((i) => run.o.lines[i].amount / 3n))         // a third of every line
      run.release(centsText(run.o.heldEx() / 7n))             // a seventh of what is held
      credit([[0, centsText(remaining(0) / 2n + 1n)]])        // half of the first line
      run.release('0.01')
      credit(rows((i) => remaining(i) - (i === 0 ? 1n : 0n))) // everything but one cent of line 1
      expect(run.o.o.S - run.o.o.cS).toBe(1n)
      // Whatever is still held is held against one cent still billed (I3).
      expect(run.o.heldEx() <= 1n).toBe(true)
      const heldBeforeLast = [run.o.heldEx(), run.o.heldGst()]
      const last = credit([[0, '0.01']])                      // the final credit takes ALL still held
      expect([last.expected.retention, last.expected.retentionGst]).toEqual(heldBeforeLast)

      expect(raised).toEqual([])
      const p = run.b.position()
      expect(run.b.credits).toHaveLength(5)
      expect(centsText(BigInt(run.b.ledger.creditedSubtotalCents))).toBe(stored.subtotal)
      expect(centsText(BigInt(run.b.ledger.creditedGstCents))).toBe(stored.gst)
      expect([p.retentionHeldExCents, p.retentionHeldGstCents, p.retentionHeldCents, p.receivableBasisCents, p.netIssuedGrossCents])
        .toEqual([0, 0, 0, 0, 0])
      // Retention withheld = retention released + retention credited, ex-GST and GST.
      expect(run.o.o.rel + run.o.o.cR).toBe(run.o.o.R)
      expect(run.o.o.relG + run.o.o.cRG).toBe(run.o.o.RG)
    })

    it('a single full credit clears everything, with or without a release first', () => {
      const all = specs.map(([amountText], i) => [i, amountText])
      const plain = lockstep(specs, retention)
      const full = plain.credit(all)
      expect([full.expected.subtotal, full.expected.gst, full.expected.retention, full.expected.retentionGst].map(centsText))
        .toEqual([stored.subtotal, stored.gst, retention, stored.retentionGst])
      expect(plain.b.position().receivableBasisCents).toBe(0)

      const released = lockstep(specs, retention)
      const r = released.release('1234567.89')
      const rest = released.credit(all)
      expect(rest.expected.retention + r.expected.amount).toBe(parseCents(retention))
      expect(rest.expected.retentionGst + r.expected.gst).toBe(parseCents(stored.retentionGst))
      expect(released.b.position().receivableBasisCents).toBe(0)
      expect(released.b.position().retentionHeldCents).toBe(0)
    })
  })

  it('tiny releases against 1,000,000,000.00 of retention round exactly, and the remainder telescopes', () => {
    // GST held 100,000,000.00 × 0.01 ÷ 1,000,000,000.00 = 0.001 → 0.00 for a
    // one-cent release; 5.00 releases 0.50; 4.99 releases 0.499 → 0.50.
    const run = lockstep([['9999999999.99', 'gst']], '1000000000.00')
    expect(centsText(run.release('0.01').expected.gst)).toBe('0.00')
    expect(centsText(run.release('5.00').expected.gst)).toBe('0.50')
    expect(centsText(run.release('4.99').expected.gst)).toBe('0.50')
    expect(run.b.release(1000000000).error).toBe('Only 999999990.00 of retention (ex-GST) is still held on CI-0001.')
    const last = run.release('999999990.00')
    expect(centsText(last.expected.gst)).toBe('99999999.00')
    expect(run.b.position().retentionHeldCents).toBe(0)
  })
})

// ── Receipts on the ledger (ADR-89) ──────────────────────────────────────────

describe('applyReceipt / applyReceiptVoid / ledgerRemainingCents', () => {
  it('a receipt adds to receivedCents, steps seq, names the entry and touches no invariant total', () => {
    const before = emptyLedger()
    const after = applyReceipt(before, 30000, 'cr1')
    expect(after.receivedCents).toBe(30000)
    expect([after.seq, after.lastEntryId, after.lastEntryKind]).toEqual([1, 'cr1', LEDGER_KIND.RECEIPT])
    expect(totalsOf(after)).toEqual(totalsOf(emptyLedger()))
    expect(before).toEqual(emptyLedger()) // not mutated
    const more = applyReceipt(after, 20000, 'cr2')
    expect([more.receivedCents, more.seq, more.lastEntryId]).toEqual([50000, 2, 'cr2'])
    expect(after.receivedCents).toBe(30000)
    // A state that has no receivedCents yet (an older ledger) starts from 0.
    const legacy = emptyLedger()
    delete legacy.receivedCents
    expect(applyReceipt(legacy, 100, 'cr3').receivedCents).toBe(100)
    expect(ledgerInvariantError(retained(), more)).toBeNull()
  })

  it('a receipt void takes it back and steps seq; taking back MORE than is recorded is never clamped — it leaves a state the backend refuses', () => {
    const posted = applyReceipt(applyReceipt(emptyLedger(), 30000, 'cr1'), 20000, 'cr2')
    const voided = applyReceiptVoid(posted, 30000, 'cr1')
    expect(voided.receivedCents).toBe(20000)
    expect([voided.seq, voided.lastEntryId, voided.lastEntryKind]).toEqual([3, 'cr1', LEDGER_KIND.RECEIPT_VOID])
    expect(posted.receivedCents).toBe(50000) // not mutated
    expect(applyReceiptVoid(voided, 20000, 'cr2').receivedCents).toBe(0)
    expect(Object.is(applyReceiptVoid(voided, 20000, 'cr2').receivedCents, -0)).toBe(false)
    expect(ledgerStateProblem(applyReceiptVoid(voided, 20000, 'cr2'))).toBeNull()
    // More than is recorded: the figure is EXACT, so this is an invariant breach.
    // It is not read as zero — the state is negative and is named as invalid.
    const over = applyReceiptVoid(voided, 20001, 'old')
    expect(over.receivedCents).toBe(-1)
    expect(ledgerStateProblem(over)).toBe('The ledger figure receivedCents is not a whole, non-negative number of cents.')
    expect(ledgerInvariantError(retained(), over)).toBe('The ledger figure receivedCents is not a whole, non-negative number of cents.')
    expect(applyReceiptVoid(emptyLedger(), 500, 'old').receivedCents).toBe(-500)
    const legacy = emptyLedger()
    delete legacy.receivedCents
    expect(applyReceiptVoid(legacy, 500, 'old').receivedCents).toBe(-500)
    expect(totalsOf(over)).toEqual(totalsOf(emptyLedger()))
  })

  it('receipts survive credits, releases and their voids untouched', () => {
    const b = book(retained())
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    const withReceipt = applyReceipt(b.ledger, 12345, 'cr1')
    const r = { id: 'rr1', amount: 30, gstAmount: 3 }
    const moved = applyCreditVoid(applyReleaseVoid(applyRelease(withReceipt, r), r), cn)
    expect(moved.receivedCents).toBe(12345)
    expect(totalsOf(moved)).toEqual(totalsOf(emptyLedger()))
    expect(readLedger(ledgerDocument(moved)).receivedCents).toBe(12345)
  })

  it('ledgerRemainingCents = receivable basis − received: signed, never clamped', () => {
    const inv = retained() // basis 990.00
    expect(ledgerRemainingCents(inv, emptyLedger())).toBe(99000)
    expect(ledgerRemainingCents(inv, null)).toBe(99000)
    expect(ledgerRemainingCents(inv, undefined)).toBe(99000)
    const legacy = emptyLedger()
    delete legacy.receivedCents
    expect(ledgerRemainingCents(inv, legacy)).toBe(99000)

    const b = book(inv)
    b.release(40)                                        // basis 1034.00
    let ledger = applyReceipt(b.ledger, 103400, 'cr1')
    expect(ledgerRemainingCents(inv, ledger)).toBe(0)
    // A credit after the money was received: 220.00 gross, 13.20 of it retention
    // → the basis falls by 206.80 and that much is owed to the client.
    const cn = buildClientCreditNote(inv, ledger, [{ invoiceLineIndex: 0, amount: 200 }])
    ledger = applyCredit(ledger, { id: 'cn1', lineItems: cn.lineItems, ...cn.totals })
    expect(ledgerPosition(inv, ledger).receivableBasisCents).toBe(82720)
    expect(ledgerRemainingCents(inv, ledger)).toBe(-20680)
    // The basis itself is not negative — only what remains after receipts is.
    expect(ledgerPosition(inv, ledger).receivableBasisCents).toBeGreaterThanOrEqual(0)
    expect(ledgerInvariantError(inv, ledger)).toBeNull()
    expect(ledgerRemainingCents(inv, applyReceiptVoid(ledger, 103400, 'cr1'))).toBe(82720)
  })
})

// ── The supported maximum ────────────────────────────────────────────────────
//
// 999,999,999,999.99 per invoice (ex-GST subtotal), i.e. below 10^12 — the
// bound Rules already use for budget adjustments. Evidence for the bound is in
// tests/unit/money.test.js ("the supported monetary range"). Here: the whole
// lifecycle AT the maximum and one cent below it, single-tax and mixed-tax.

describe('the supported maximum — the whole lifecycle at 999,999,999,999.99 and at 999,999,999,999.98', () => {
  const CASES = [
    ['999,999,999,999.99 single-tax, 87,654,321,098.77 retained',
      [['999999999999.99', 'gst']], '87654321098.77',
      { subtotal: '999999999999.99', gst: '100000000000.00', gross: '1099999999999.99' }],
    ['999,999,999,999.99 mixed-tax, 91% retained',
      [['600000000000.00', 'gst'], ['399999999999.99', 'gst_free']], '909999999999.99',
      { subtotal: '999999999999.99', gst: '60000000000.00', gross: '1059999999999.99' }],
    ['999,999,999,999.98 single-tax, FULLY retained',
      [['999999999999.98', 'gst']], '999999999999.98',
      { subtotal: '999999999999.98', gst: '100000000000.00', gross: '1099999999999.98' }],
    ['999,999,999,999.98 mixed-tax, 5% retained',
      [['123456789012.34', 'gst'], ['876543210987.64', 'input_taxed']], '49999999999.99',
      { subtotal: '999999999999.98', gst: '12345678901.23', gross: '1012345678901.21' }],
  ]

  describe.each(CASES)('%s', (_label, specs, retention, stored) => {
    // Every Number the ledger holds is a safe integer, and the stored document
    // survives JSON unchanged (whole cents are integers; Firestore stores
    // integers as 64-bit signed and these are far inside 2^53).
    const expectStorable = (run) => {
      const doc = ledgerDocument(run.b.ledger)
      for (const key of [...LEDGER_TOTAL_KEYS, 'receivedCents', 'seq']) expect(Number.isSafeInteger(doc[key])).toBe(true)
      for (const l of Object.values(doc.lines)) expect(Number.isSafeInteger(l.amountCents) && Number.isSafeInteger(l.gstCents)).toBe(true)
      expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
      const p = run.b.position()
      for (const value of Object.values(p)) expect(Number.isSafeInteger(value)).toBe(true)
    }

    it('the invoice stores exact figures and is accepted', () => {
      const run = lockstep(specs, retention)
      expect([run.o.o.S, run.o.o.G, run.o.o.S + run.o.o.G].map(centsText)).toEqual([stored.subtotal, stored.gst, stored.gross])
      expect([cents(run.inv.subtotal), cents(run.inv.gstTotal), cents(run.inv.grossTotal)].map(centsText))
        .toEqual([stored.subtotal, stored.gst, stored.gross])
      // The stored dollar amounts are the doubles their decimal strings name.
      expect(run.inv.subtotal).toBe(Number(stored.subtotal))
      expect(run.inv.grossTotal).toBe(Number(stored.gross))
      expect(run.inv.retention).toBe(Number(retention))
      expect(retentionError(run.inv.retention, run.inv.subtotal)).toBeNull()
      expect(invoiceRetention(run.inv).grossCents).toBe(Number(run.o.o.S + run.o.o.G))
      expectStorable(run)
    })

    it('credits, releases, voids in a valid order, and the final credit: exact at every step, basis never rises', () => {
      const run = lockstep(specs, retention)
      const remaining = (i) => run.o.lines[i].amount - run.o.lines[i].credited
      const rows = (amountOf) => specs.map((_, i) => [i, centsText(amountOf(i))]).filter(([, t]) => parseCents(t) > 0n)
      const credit = (r) => {
        const entry = run.credit(r)
        expect(entry.basisAfter <= entry.basisBefore).toBe(true)
        expectStorable(run)
        return entry
      }
      const release = (amountText) => { const entry = run.release(amountText); expectStorable(run); return entry }

      credit(rows((i) => run.o.lines[i].amount / 3n + 1n))  // a third of every line
      const r1 = release(centsText(run.o.heldEx() / 7n + 1n))
      const c2 = credit([[0, '0.01']])                       // one cent
      // Voids, later entry first: both are accepted.
      expect(run.voidCredit(c2)).toBeNull()
      expect(run.voidRelease(r1)).toBeNull()
      expectStorable(run)
      release(centsText(run.o.heldEx() / 3n))
      release('0.01')
      credit([[0, centsText(remaining(0) / 2n)]])
      credit(rows((i) => remaining(i) - (i === 0 ? 1n : 0n))) // all but one cent
      const held = [run.o.heldEx(), run.o.heldGst()]
      const last = credit([[0, '0.01']])                     // the final credit
      expect([last.expected.retention, last.expected.retentionGst]).toEqual(held)

      const p = run.b.position()
      expect(centsText(BigInt(run.b.ledger.creditedSubtotalCents))).toBe(stored.subtotal)
      expect(centsText(BigInt(run.b.ledger.creditedGstCents))).toBe(stored.gst)
      expect([p.retentionHeldExCents, p.retentionHeldGstCents, p.retentionHeldCents, p.receivableBasisCents, p.netIssuedGrossCents])
        .toEqual([0, 0, 0, 0, 0])
      expect(run.o.o.rel + run.o.o.cR).toBe(run.o.o.R)
      expect(run.o.o.relG + run.o.o.cRG).toBe(run.o.o.RG)
    })

    it('a full release, the whole gross received, then a full credit: everything received is owed back, exactly', () => {
      const run = lockstep(specs, retention)
      run.release(retention)
      const gross = Number(run.o.o.S + run.o.o.G)
      expect(Number.isSafeInteger(gross)).toBe(true)
      expect(run.b.position().receivableBasisCents).toBe(gross)
      let ledger = applyReceipt(run.b.ledger, gross, 'cr1')
      expect(ledgerRemainingCents(run.inv, ledger)).toBe(0)
      const all = specs.map(([amountText], i) => [i, amountText])
      const entry = run.credit(all)
      ledger = applyReceipt(run.b.ledger, gross, 'cr1')
      expect(entry.basisAfter).toBe(0n)
      expect(ledgerRemainingCents(run.inv, ledger)).toBe(-gross)
      expect(JSON.parse(JSON.stringify(ledgerDocument(ledger)))).toEqual(ledgerDocument(ledger))
    })
  })
})

describe('voids', () => {
  it('voiding a credit returns every total to the prior state', () => {
    const b = book(retained())
    b.release(40)
    const before = totalsOf(b.ledger)
    const positionBefore = b.position()
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    expect(totalsOf(b.ledger)).not.toEqual(before)
    expect(b.voidCredit(cn)).toBeNull()
    expect(totalsOf(b.ledger)).toEqual(before)
    expect(b.position()).toEqual(positionBefore)
    expect(b.ledger.lines).toEqual({ 0: { amountCents: 0, gstCents: 0 } })
    // Every movement steps seq, including the void.
    expect(b.ledger.seq).toBe(3)
    expect(b.ledger.lastEntryId).toBe(cn.id)
    expect(b.ledger.lastEntryKind).toBe(LEDGER_KIND.CREDIT_VOID)
  })

  it('voiding a release returns every total to the prior state', () => {
    const b = book(retained())
    b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    const before = totalsOf(b.ledger)
    const positionBefore = b.position()
    const r = b.release(30)
    expect(b.position().receivableBasisCents).toBe(positionBefore.receivableBasisCents + 3300)
    expect(b.voidRelease(r)).toBeNull()
    expect(totalsOf(b.ledger)).toEqual(before)
    expect(b.position()).toEqual(positionBefore)
    expect(b.ledger.seq).toBe(3)
    expect(b.ledger.lastEntryKind).toBe(LEDGER_KIND.RELEASE_VOID)
  })

  it('void then re-enter gives the same figures again', () => {
    const b = book(invoice([line(40.15)], 4))
    const first = b.credit([{ invoiceLineIndex: 0, amount: 13.37 }])
    b.voidCredit(first)
    const again = b.credit([{ invoiceLineIndex: 0, amount: 13.37 }])
    for (const key of ['subtotal', 'gstTotal', 'grossTotal', 'retentionAmount', 'retentionGst', 'receivableTotal']) {
      expect(again[key]).toBe(first[key])
    }
  })

  it('an out-of-order credit void still lets the line be fully credited to its stored GST', () => {
    const b = book(invoice([line(40.15, 'gst', 4.01)]))
    const c1 = b.credit([{ invoiceLineIndex: 0, amount: 13.38 }])
    b.credit([{ invoiceLineIndex: 0, amount: 13.38 }])
    expect(b.voidCredit(c1)).toBeNull()
    b.credit([{ invoiceLineIndex: 0, amount: 26.77 }])
    expect(b.ledger.creditedSubtotalCents).toBe(4015)
    expect(b.ledger.creditedGstCents).toBe(401)
  })

  it('a release void that would break an invariant is REPORTED (S=100.00 R=10.00)', () => {
    const inv = invoice([line(100)], 10)
    expect(invoiceRetention(inv)).toMatchObject({ subtotalCents: 10000, retentionCents: 1000, retentionGstCents: 100 })
    const b = book(inv)
    const r = b.release(10)
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 95 }])
    // All retention was already released, so the credit is wholly on the receivable.
    expect(cn).toMatchObject({ retentionAmount: 0, retentionGst: 0, receivableTotal: 104.5 })
    const snapshot = totalsOf(b.ledger)

    const voided = applyReleaseVoid(b.ledger, r)
    // Without the release only 90.00 was ever receivable — 95.00 is credited on it.
    expect(ledgerInvariantError(inv, voided)).toBe('Credits against the receivable part exceed what is receivable.')
    expect(b.voidRelease(r)).toBe('Credits against the receivable part exceed what is receivable.')
    expect(totalsOf(b.ledger)).toEqual(snapshot)

    // Voiding the credit first makes the release void legitimate.
    expect(b.voidCredit(cn)).toBeNull()
    expect(b.voidRelease(r)).toBeNull()
    expect(totalsOf(b.ledger)).toEqual(totalsOf(emptyLedger()))
  })

  it('a release void is fine when the credits still fit the un-released receivable', () => {
    const inv = invoice([line(100)], 10)
    const b = book(inv)
    const r = b.release(10)
    b.credit([{ invoiceLineIndex: 0, amount: 90 }])
    expect(b.voidRelease(r)).toBeNull()
    expect(b.position().retentionHeldCents).toBe(1100)
    expect(b.position().receivableBasisCents).toBe(0) // 99.00 receivable − 99.00 credited
  })
})

// ── Cross-check ──────────────────────────────────────────────────────────────

describe('expectedLedgerTotals / ledgerDisagreement / creditNoteCents', () => {
  it('sums only the entries of the named invoice', () => {
    const b = book(retained())
    b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    b.release(30)
    const foreignCredit = { ...b.credits[0], id: 'x', clientInvoiceId: 'other' }
    const foreignRelease = { ...b.releases[0], id: 'y', clientInvoiceId: 'other' }
    const expected = expectedLedgerTotals('inv1', [...b.credits, foreignCredit, null], [...b.releases, foreignRelease, null])
    expect(totalsOf(expected)).toEqual(totalsOf(b.ledger))
    expect(totalsOf(expectedLedgerTotals('nobody', b.credits, b.releases))).toEqual(totalsOf(emptyLedger()))
    expect(totalsOf(expectedLedgerTotals('inv1', null, undefined))).toEqual(totalsOf(emptyLedger()))
  })

  it('reports exactly the keys that disagree', () => {
    const b = book(retained())
    b.credit([{ invoiceLineIndex: 0, amount: 200 }])
    b.release(30)
    const doc = ledgerDocument(b.ledger)
    expect(ledgerDisagreement(doc, 'inv1', b.credits, b.releases)).toEqual([])
    expect(ledgerDisagreement({ ...doc, creditedGstCents: doc.creditedGstCents + 1 }, 'inv1', b.credits, b.releases))
      .toEqual(['creditedGstCents'])
    expect(ledgerDisagreement(doc, 'inv1', b.credits, [])).toEqual(['releasedRetentionCents', 'releasedRetentionGstCents'])
    expect(ledgerDisagreement(null, 'inv1', b.credits, [])).toEqual([
      'creditedSubtotalCents', 'creditedGstCents', 'creditedRetentionCents', 'creditedRetentionGstCents',
    ])
    expect(ledgerDisagreement(null, 'inv1', [], [])).toEqual([])
  })

  it('creditNoteCents reads a stored credit note in whole cents', () => {
    const b = book(invoice([line(40.15), line(100, 'gst_free')], 14.02))
    const cn = b.credit([{ invoiceLineIndex: 0, amount: 20.07 }, { invoiceLineIndex: 1, amount: 50 }])
    const c = creditNoteCents(cn)
    expect(c.subtotalCents).toBe(7007)
    expect(c.gstCents).toBe(201)
    expect(c.lines).toEqual([
      { invoiceLineIndex: 0, amountCents: 2007, gstCents: 201 },
      { invoiceLineIndex: 1, amountCents: 5000, gstCents: 0 },
    ])
    expect(creditNoteCents(null)).toEqual({
      subtotalCents: 0, gstCents: 0, retentionCents: 0, retentionGstCents: 0, lines: [],
    })
  })
})

// ── Property test ────────────────────────────────────────────────────────────
//
// A seeded generator drives 500 random sequences of credits, releases and voids
// over random invoices: 1–5 lines of mixed tax codes (some stored with legacy
// GST one cent low, some beyond 20,000,000.00), retention anywhere from 0% to
// 100% of the subtotal. The library and the oracle run step for step.
//
// HARD, after EVERY applied step (a failure stops the run):
//   · every figure of every credit note and release equals the oracle's;
//   · the ledger satisfies every invariant;
//   · I4 computed INDEPENDENTLY, by the oracle from the posted documents:
//     retention GST held ≤ share(GST still billed, retention held, amount still billed);
//   · every ledger total equals the BigInt sum of the applied documents;
//   · the receivable basis is not negative.
// An allocation the library ACCEPTS is never allowed to leave an invalid
// ledger; only a VOID may be refused by the invariants, and it is counted by
// the message that refused it.
//
// COLLECTED, and asserted at the end (STRICT — no one-cent allowance):
//   · every credit that raised the receivable basis at all;
//   · every credit whose retention part (gross) exceeded the credit (gross),
//     i.e. whose receivable part was negative — including where the I3 floor
//     is positive, which is counted separately.
//
// Every sequence ends with a closing credit of everything left: credited GST =
// invoice GST exactly, nothing held, basis 0.

const PROPERTY_TALLY = {}

function runProperty(seed, sequences, profile = 'standard') {
  const next = lcg(seed)
  const TAX = ['gst', 'gst', 'gst', 'gst', 'gst_free', 'gst_free', 'input_taxed']
  const BOUNDARY = [4015, 4105, 8085, 5, 15, 25, 9995, 33333, 1]
  const text = (n) => centsText(BigInt(n))

  // [specs, retentionText] — decimal strings, from whole-cent draws.
  // The 'tiny' profile makes a third of the invoices out of lines of 0.01–5.00,
  // credited and released 0.01–0.05 at a time: where rounding bites.
  let tiny = false
  function randomInvoice() {
    tiny = profile === 'tiny' && below(next, 3) === 0
    const count = 1 + below(next, 5)
    const legacy = below(next, 6) === 0
    const specs = []
    for (let i = 0; i < count; i += 1) {
      const roll = below(next, 12)
      const amountCents = tiny ? 1 + below(next, 500)
        : roll === 0 ? 0
        : roll <= 2 ? BOUNDARY[below(next, BOUNDARY.length)]
          : roll === 3 ? 1 + below(next, 300_000_000)
            : roll === 4 ? 1 + wideBelow(next, 1_000_000_000_000) // to 10,000,000,000.00
              : 1 + below(next, 500_000)
      const taxCode = TAX[below(next, TAX.length)]
      const exactGst = taxCode === 'gst' ? halfUp(BigInt(amountCents), 10n) : 0n
      // A legacy invoice stores some GST lines one cent low.
      if (legacy && exactGst > 0n && below(next, 2) === 0) specs.push([text(amountCents), taxCode, centsText(exactGst - 1n)])
      else specs.push([text(amountCents), taxCode])
    }
    if (specs.every(([amountText]) => parseCents(amountText) === 0n)) specs[0] = ['100.00', 'gst']
    const subtotal = specs.reduce((sum, [amountText]) => sum + parseCents(amountText), 0n)
    const roll = below(next, 10)
    const retention = roll <= 1 ? 0n
      : roll === 2 ? subtotal                                                  // 100%
        : roll === 3 ? halfUp(subtotal * BigInt(9000 + below(next, 1001)), 10000n) // 90–100%
          : roll <= 6 ? halfUp(subtotal * BigInt(1 + below(next, 2000)), 10000n)   // 0.01–20%
            : BigInt(wideBelow(next, Number(subtotal) + 1))                    // anywhere
    return [specs, centsText(retention)]
  }

  const sumField = (docs, field) => docs.reduce((sum, d) => sum + cents(d[field]), 0n)

  function assertReconciles(inv, b) {
    const L = b.ledger
    // Every total against the oracle sum of the documents themselves.
    expect(BigInt(L.creditedSubtotalCents)).toBe(sumField(b.credits, 'subtotal'))
    expect(BigInt(L.creditedGstCents)).toBe(sumField(b.credits, 'gstTotal'))
    expect(BigInt(L.creditedRetentionCents)).toBe(sumField(b.credits, 'retentionAmount'))
    expect(BigInt(L.creditedRetentionGstCents)).toBe(sumField(b.credits, 'retentionGst'))
    expect(BigInt(L.releasedRetentionCents)).toBe(sumField(b.releases, 'amount'))
    expect(BigInt(L.releasedRetentionGstCents)).toBe(sumField(b.releases, 'gstAmount'))

    // Per-line totals against the oracle sum of the credit lines.
    const perLine = new Map()
    for (const cn of b.credits) {
      for (const li of cn.lineItems) {
        const at = perLine.get(li.invoiceLineIndex) ?? [0n, 0n]
        perLine.set(li.invoiceLineIndex, [at[0] + cents(li.amount), at[1] + cents(li.gstAmount)])
      }
    }
    for (const [index, stored] of Object.entries(L.lines)) {
      const [amount, gst] = perLine.get(Number(index)) ?? [0n, 0n]
      expect(BigInt(stored.amountCents)).toBe(amount)
      expect(BigInt(stored.gstCents)).toBe(gst)
      expect(amount <= cents(inv.lineItems[index].amount)).toBe(true)
      expect(gst <= cents(inv.lineItems[index].gstAmount)).toBe(true)
    }

    expect(ledgerInvariantError(inv, L)).toBeNull()
    expect(ledgerDisagreement(ledgerDocument(L), inv.id, b.credits, b.releases)).toEqual([])

    const p = b.position()
    expect(p.retentionHeldExCents).toBeGreaterThanOrEqual(0)
    expect(p.retentionHeldGstCents).toBeGreaterThanOrEqual(0)
    // Before receipts the receivable basis is NEVER negative.
    expect(p.receivableBasisCents).toBeGreaterThanOrEqual(0)
    expect(p.receivableBasisCents).toBe(p.grossCents - p.creditedGrossCents - p.retentionHeldCents)
    expect(p.netIssuedGrossCents).toBe(p.grossCents - p.creditedGrossCents)
    // I4, stated independently of ledgerInvariantError: once credited
    // retention + released retention equals the retention withheld, the same
    // holds for their GST — no retention GST is ever stranded.
    const R = cents(inv.retention)
    const RG = cents(inv.retentionGst)
    const goneEx = sumField(b.credits, 'retentionAmount') + sumField(b.releases, 'amount')
    const goneGst = sumField(b.credits, 'retentionGst') + sumField(b.releases, 'gstAmount')
    expect(goneEx <= R).toBe(true)
    expect(goneGst <= RG).toBe(true)
    // I3, stated independently: retention held never exceeds what is still billed.
    const stillBilled = cents(inv.subtotal) - sumField(b.credits, 'subtotal')
    const gstStillBilled = cents(inv.gstTotal) - sumField(b.credits, 'gstTotal')
    expect(R - goneEx <= stillBilled).toBe(true)
    // I4, computed independently from the posted documents: the retained slice
    // carries no more than its share of the GST still billed, exactly.
    expect(RG - goneGst <= share(gstStillBilled, R - goneEx, stillBilled)).toBe(true)
    // Its corollaries: never more than the GST still billed, and none once no
    // ex-GST retention is held.
    expect(RG - goneGst <= gstStillBilled).toBe(true)
    if (goneEx === R) expect(goneGst).toBe(RG)
    if (p.retentionHeldExCents === 0) expect(p.retentionHeldGstCents).toBe(0)
  }

  const tally = {
    sequences, steps: 0, credits: 0, releases: 0, creditVoids: 0, releaseVoids: 0, refusedVoids: 0,
    // Voids attempted and refused, by kind, and the refusals by invariant message.
    creditVoidsAttempted: 0, creditVoidsRefused: 0, releaseVoidsAttempted: 0, releaseVoidsRefused: 0,
    refusedByMessage: {},
    retained: 0, fullyRetained: 0, mixedTax: 0, beyondFormerLimit: 0, closed: 0,
    creditsBeforeAnyVoid: 0,
    // Credits that raised the basis: by one cent with no void before them
    // (rounding), by one cent after a void, and by more than a cent.
    tinyInvoices: 0, raised: [],
    // Credits for which the I3 floor is positive, those whose retention part IS
    // the floor, and the most by which any of them exceeded its credit.
    floorPositive: 0, floorDecided: 0, steppedDown: 0, worstExcessWhereFloorPositive: null,
    receivablePartNegative: [],
    // The most by which the retention part of a credit (gross) exceeded the
    // credit's own gross, and the most retention GST a credit with NO GST of
    // its own took — each while no entry had been voided, and overall.
    worstRetentionExcessNoVoid: -(10n ** 30n), worstRetentionExcess: -(10n ** 30n),
    worstGstFreeRetentionGstNoVoid: 0n, worstGstFreeRetentionGst: 0n,
  }

  for (let sequence = 0; sequence < sequences; sequence += 1) {
    const [specs, retentionText] = randomInvoice()
    if (tiny) tally.tinyInvoices += 1
    const run = lockstep(specs, retentionText, { id: `inv${sequence}` })
    const { inv, b, o } = run
    const byId = invoicesById([inv])
    if (hasRetention(inv)) tally.retained += 1
    if (o.o.R === o.o.S) tally.fullyRetained += 1
    if (o.lines.some(l => l.gst > 0n) && o.lines.some(l => l.gst === 0n && l.amount > 0n)) tally.mixedTax += 1
    if (o.o.S > 2_000_000_000n) tally.beyondFormerLimit += 1
    const creditEntries = []
    const releaseEntries = []
    let voided = false
    let seq = 0
    const stepped = () => { seq += 1; tally.steps += 1; expect(b.ledger.seq).toBe(seq); assertReconciles(inv, b) }
    const remainingOn = (index) => Number(o.lines[index].amount - o.lines[index].credited)

    const credit = (rows) => {
      const entry = run.credit(rows) // compares with the oracle, asserts the invariants
      const { cn, expected, basisBefore, basisAfter } = entry
      // A credit the builder produces passes the read-time validity gate.
      expect(clientCreditException(cn, byId)).toBeNull()
      expect(cents(cn.grossTotal)).toBe(cents(cn.subtotal) + cents(cn.gstTotal))
      expect(cents(cn.receivableTotal)).toBe(cents(cn.grossTotal) - cents(cn.retentionTotal))
      creditEntries.push(entry)
      tally.credits += 1
      if (!voided) tally.creditsBeforeAnyVoid += 1
      stepped()

      // STRICT: no credit raises the receivable basis, by any amount.
      if (basisAfter > basisBefore) {
        tally.raised.push({ seed, sequence, specs, retention: retentionText, rows, from: centsText(basisBefore), to: centsText(basisAfter), afterAVoid: voided })
      }
      // The receivable part of the credit is never negative: retention part
      // gross ≤ credit gross — including where the I3 floor is positive.
      const excess = expected.retention + expected.retentionGst - expected.subtotal - expected.gst
      if (excess > 0n) tally.receivablePartNegative.push({ seed, sequence, specs, retention: retentionText, rows, excess: centsText(excess), floor: centsText(expected.floor) })
      tally.worstRetentionExcess = most(tally.worstRetentionExcess, excess)
      if (!voided) tally.worstRetentionExcessNoVoid = most(tally.worstRetentionExcessNoVoid, excess)
      if (expected.floor > 0n) {
        tally.floorPositive += 1
        if (expected.retention === expected.floor) tally.floorDecided += 1
        tally.worstExcessWhereFloorPositive = tally.worstExcessWhereFloorPositive === null
          ? excess : most(tally.worstExcessWhereFloorPositive, excess)
      }
      if (expected.retention < expected.halfUp.retention) tally.steppedDown += 1
      if (expected.gst === 0n) {
        tally.worstGstFreeRetentionGst = most(tally.worstGstFreeRetentionGst, expected.retentionGst)
        if (!voided) tally.worstGstFreeRetentionGstNoVoid = most(tally.worstGstFreeRetentionGstNoVoid, expected.retentionGst)
      }
    }

    const steps = 6 + below(next, 11)
    for (let s = 0; s < steps; s += 1) {
      const roll = below(next, 100)
      if (roll < 45) {
        const rows = []
        for (let i = 0; i < specs.length; i += 1) {
          const remaining = remainingOn(i)
          if (remaining <= 0 || below(next, 2) === 0) continue
          const amountCents = below(next, 4) === 0 ? remaining
            : tiny ? 1 + below(next, Math.min(5, remaining))
              : 1 + wideBelow(next, remaining)
          rows.push([i, text(amountCents)])
        }
        if (rows.length === 0) continue
        credit(rows)
      } else if (roll < 70) {
        const held = Number(o.heldEx())
        if (held <= 0) continue
        const amountCents = below(next, 3) === 0 ? held
          : tiny ? 1 + below(next, Math.min(5, held))
            : 1 + wideBelow(next, held)
        releaseEntries.push(run.release(text(amountCents))) // compares with the oracle, asserts the invariants
        tally.releases += 1
        stepped()
      } else if (roll < 85) {
        if (creditEntries.length === 0) continue
        const index = below(next, creditEntries.length)
        tally.creditVoidsAttempted += 1
        const refusal = run.voidCredit(creditEntries[index])
        if (refusal) {
          tally.refusedVoids += 1
          tally.creditVoidsRefused += 1
          tally.refusedByMessage[refusal] = (tally.refusedByMessage[refusal] ?? 0) + 1
          continue
        }
        creditEntries.splice(index, 1)
        voided = true
        tally.creditVoids += 1
        stepped()
      } else {
        if (releaseEntries.length === 0) continue
        const index = below(next, releaseEntries.length)
        tally.releaseVoidsAttempted += 1
        const refusal = run.voidRelease(releaseEntries[index])
        if (refusal) {
          tally.refusedVoids += 1
          tally.releaseVoidsRefused += 1
          tally.refusedByMessage[refusal] = (tally.refusedByMessage[refusal] ?? 0) + 1
          continue
        }
        releaseEntries.splice(index, 1)
        voided = true
        tally.releaseVoids += 1
        stepped()
      }
    }

    // The closing FULL credit: everything that is left, in one credit note.
    const rest = []
    for (let i = 0; i < specs.length; i += 1) {
      if (remainingOn(i) > 0) rest.push([i, text(remainingOn(i))])
    }
    if (rest.length > 0) credit(rest)
    const p = b.position()
    expect(b.ledger.creditedSubtotalCents).toBe(p.subtotalCents)
    expect(BigInt(b.ledger.creditedGstCents)).toBe(o.o.G)
    expect(p.retentionHeldExCents).toBe(0)
    expect(p.retentionHeldGstCents).toBe(0)
    expect(p.retentionHeldCents).toBe(0)
    expect(p.receivableBasisCents).toBe(0)
    expect(p.netIssuedGrossCents).toBe(0)
    tally.closed += 1
  }
  return tally
}

describe('property: random credit / release / void sequences — STRICT', () => {
  const RUNS = [
    // label, seed, sequences, profile
    ['500 sequences, all sizes (to 10,000,000,000.00 a line)', 20261126, 500, 'standard'],
    ['500 sequences, a third of them tiny (lines 0.01–5.00, entries 0.01–0.05)', 20261127, 500, 'tiny'],
  ]

  describe.each(RUNS)('%s', (_label, seed, sequences, profile) => {
    const tallyOf = () => {
      PROPERTY_TALLY[profile] ??= runProperty(seed, sequences, profile)
      return PROPERTY_TALLY[profile]
    }

    it('every step equals the oracle, keeps the invariants (I4 independently) and never leaves a negative basis', () => {
      const tally = tallyOf()
      // The generator really exercised every kind of step and every kind of invoice.
      expect(tally.closed).toBe(sequences)
      expect(tally.credits).toBeGreaterThan(sequences)
      expect(tally.releases).toBeGreaterThan(200)
      expect(tally.creditVoids).toBeGreaterThan(100)
      expect(tally.releaseVoids).toBeGreaterThan(50)
      expect(tally.retained).toBeGreaterThan(250)
      expect(tally.fullyRetained).toBeGreaterThan(20)
      expect(tally.mixedTax).toBeGreaterThan(150)
      expect(tally.creditsBeforeAnyVoid).toBeGreaterThan(300)
      if (profile === 'standard') expect(tally.beyondFormerLimit).toBeGreaterThan(20)
      if (profile === 'tiny') expect(tally.tinyInvoices).toBeGreaterThan(100)
    }, 120_000)

    it('NO credit raises the receivable basis — basis(after) ≤ basis(before), with no one-cent allowance', () => {
      expect(tallyOf().raised).toEqual([])
    })

    it('the retention part of a credit (gross) never exceeds the credit (gross) — also where the I3 floor is positive', () => {
      const tally = tallyOf()
      expect(tally.receivablePartNegative).toEqual([])
      expect(tally.worstRetentionExcess <= 0n).toBe(true)
      // The floor was really reached, and never forced an excess.
      expect(tally.floorPositive).toBeGreaterThan(0)
      expect(tally.floorDecided).toBeGreaterThan(0)
      expect(tally.worstExcessWhereFloorPositive <= 0n).toBe(true)
      // A credit with no GST of its own frees at most a cent of retention GST.
      expect(tally.worstGstFreeRetentionGst <= 1n).toBe(true)
    })

    it('voids are refused only by an invariant, and the refusals are counted by message', () => {
      const tally = tallyOf()
      expect(tally.creditVoidsAttempted).toBe(tally.creditVoids + tally.creditVoidsRefused)
      expect(tally.releaseVoidsAttempted).toBe(tally.releaseVoids + tally.releaseVoidsRefused)
      expect(Object.values(tally.refusedByMessage).reduce((a, b) => a + b, 0)).toBe(tally.refusedVoids)
      const known = [
        'Credits against the receivable part exceed what is receivable.',
        'Retention GST held would exceed the retained share of the GST still billed.',
      ]
      expect(Object.keys(tally.refusedByMessage).filter(m => !known.includes(m))).toEqual([])
      expect(tally.refusedByMessage[known[1]]).toBeGreaterThan(0)
    })
  })

})

// ── The ledger's figures are exact, safe integers (ADR-89, final pass) ───────

describe('storedLedgerProblem / ledgerStateProblem — a figure is refused, never coerced', () => {
  const MAX_SAFE = Number.MAX_SAFE_INTEGER
  const figure = (key) => `The ledger figure ${key} is not a whole, non-negative number of cents.`

  it('a missing ledger, an empty one and one carrying only some figures are sound', () => {
    expect(storedLedgerProblem(null)).toBeNull()
    expect(storedLedgerProblem(undefined)).toBeNull()
    expect(storedLedgerProblem({})).toBeNull()
    expect(storedLedgerProblem(ledgerDocument(emptyLedger()))).toBeNull()
    expect(storedLedgerProblem({ seq: 3, creditedSubtotalCents: 100 })).toBeNull()   // written before receipts were tracked
    expect(storedLedgerProblem({ ...ledgerDocument(emptyLedger()), receivedCents: MAX_SAFE })).toBeNull()
    expect(storedLedgerProblem({ receivedCents: 5, receiptBaseline: { legacyCents: 5, legacyReceipts: 1 } })).toBeNull()
  })

  it.each([
    ['a fraction', 1.5], ['a negative', -1], ['a string', '500'], ['null', null], ['NaN', NaN], ['Infinity', Infinity],
    ['one past the safe range', MAX_SAFE + 1], ['a float that looks whole but is unsafe', 2 ** 53], ['a boolean', true],
  ])('a PRESENT figure that is %s is named — where readLedger would have read it as zero or kept it', (_label, bad) => {
    for (const key of ['seq', ...LEDGER_TOTAL_KEYS, 'receivedCents']) {
      expect(storedLedgerProblem({ ...ledgerDocument(emptyLedger()), [key]: bad }), key).toBe(figure(key))
    }
    expect(storedLedgerProblem({ lines: { 0: { amountCents: bad, gstCents: 0 } } })).toBe(figure('lines.0'))
    expect(storedLedgerProblem({ lines: { 2: { amountCents: 0, gstCents: bad } } })).toBe(figure('lines.2'))
    expect(storedLedgerProblem({ receivedCents: 0, receiptBaseline: { legacyCents: bad } })).toBe(figure('receiptBaseline.legacyCents'))
  })

  it('a state to be written must carry EVERY figure, each whole, non-negative and safe — receivedCents included', () => {
    expect(ledgerStateProblem(emptyLedger())).toBeNull()
    expect(ledgerStateProblem({ ...emptyLedger(), receivedCents: MAX_SAFE })).toBeNull()
    for (const key of ['seq', ...LEDGER_TOTAL_KEYS, 'receivedCents']) {
      for (const bad of [-1, 0.5, MAX_SAFE + 1, undefined, null, '1']) {
        expect(ledgerStateProblem({ ...emptyLedger(), [key]: bad }), `${key}=${bad}`).toBe(figure(key))
        expect(ledgerInvariantError(retained(), { ...emptyLedger(), [key]: bad }), `${key}=${bad}`).toBe(figure(key))
      }
    }
  })

  it('cumulative receipts at the receipt maximum stay exact while they are safe, and the first unsafe total is named', () => {
    let state = emptyLedger()
    for (let i = 1; i <= 9; i += 1) {
      state = applyReceipt(state, 999_999_999_999_990, `cr${i}`)
      expect(state.receivedCents).toBe(999_999_999_999_990 * i)
      expect(BigInt(state.receivedCents)).toBe(999_999_999_999_990n * BigInt(i))
      expect(ledgerStateProblem(state), `after ${i}`).toBeNull()
    }
    expect(ledgerStateProblem(applyReceipt(state, 999_999_999_999_990, 'cr10'))).toBe(figure('receivedCents'))
    // …and nine voids take it back to exactly zero.
    for (let i = 9; i >= 1; i -= 1) state = applyReceiptVoid(state, 999_999_999_999_990, `cr${i}`)
    expect(state.receivedCents).toBe(0)
  })

  it('the ledger at the maximum survives JSON unchanged', () => {
    const doc = { ...ledgerDocument({ ...emptyLedger(), receivedCents: 8_999_999_999_999_910, creditedSubtotalCents: 99_999_999_999_999 }), receiptBaseline: { legacyCents: 8_999_999_999_999_910, legacyReceipts: 9 } }
    const back = JSON.parse(JSON.stringify(doc))
    expect(back).toEqual(doc)
    expect(back.receivedCents).toBe(8_999_999_999_999_910)
    expect(Number.isSafeInteger(back.receivedCents)).toBe(true)
    expect(storedLedgerProblem(back)).toBeNull()
  })

  it('readLedger and ledgerDocument leave `receiptBaseline` alone: it is written once by the backend and never rewritten', () => {
    const stored = { ...ledgerDocument(applyReceipt(emptyLedger(), 100, 'cr1')), receiptBaseline: { legacyCents: 40, legacyReceipts: 1 } }
    expect(readLedger(stored)).not.toHaveProperty('receiptBaseline')
    expect(ledgerDocument(applyReceipt(readLedger(stored), 5, 'cr2'))).not.toHaveProperty('receiptBaseline')
  })
})
