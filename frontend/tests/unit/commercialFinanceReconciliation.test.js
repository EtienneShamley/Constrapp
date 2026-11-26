import { describe, it, expect } from 'vitest'
import {
  gstForLine, invoiceTotals, retentionFromPercent, contractControl, validateInvoiceDraft,
} from '../../src/lib/clientInvoices'
import { buildClientCreditNote, clientCreditException, invoicesById } from '../../src/lib/clientCreditNotes'
import { buildClientRetentionRelease } from '../../src/lib/clientRetention'
import {
  emptyLedger, applyCredit, applyRelease, ledgerDocument, ledgerInvariantError, ledgerDisagreement,
} from '../../src/lib/clientLedger'
import { receivablePositions, receivableContext, ledgerExceptions } from '../../src/lib/clientReceivables'
import { clientInvoiceReconciliationRows, receivablesSummary } from '../../src/lib/clientReceipts'

// ── CF6 — Commercial Finance Phase 1: integrated lifecycle reconciliation ────
//
//   Contract 100,000.00
//     → invoice (a half-cent boundary line, a GST-free line, a zero-value line)
//     → retention 5% → issue
//     → partial credit → receipt → partial release
//     → second credit → final release → final receipt → reconciled.
//
// At EVERY stage the library's figures (receivablePositions, receivablesSummary,
// contractControl) are compared with an INDEPENDENT ORACLE written here: decimal
// STRINGS parsed to BigInt cents, decimal round-half-up by quotient and
// remainder. The oracle imports nothing from src/lib/money.js and uses no
// floating point; the two sides meet only as two-decimal strings.

// ── The oracle ───────────────────────────────────────────────────────────────

function parseCents(text) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!m) throw new Error(`not a two-decimal amount: ${text}`)
  const magnitude = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] === '-' ? -magnitude : magnitude
}

function centsText(cents) {
  const sign = cents < 0n ? '-' : ''
  const magnitude = cents < 0n ? -cents : cents
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`
}

// Decimal round-half-up of num ÷ den (non-negative num, positive den).
function halfUp(num, den) {
  const q = num / den
  return (num % den) * 2n >= den ? q + 1n : q
}
const share = (total, part, whole) => (whole <= 0n || part <= 0n || total <= 0n ? 0n : halfUp(total * part, whole))
const least = (a, b) => (a < b ? a : b)

// One invoice and everything posted against it, in BigInt cents.
//
//   lines        — [amountText, taxCode, storedGstText?]
//   retentionBp  — retention as basis points of the subtotal (500n = 5%)
function oracleInvoice(lines, { retentionBp = 0n } = {}) {
  const L = lines.map(([amountText, taxCode, storedGst]) => {
    const amount = parseCents(amountText)
    const gst = storedGst !== undefined ? parseCents(storedGst) : taxCode === 'gst' ? halfUp(amount, 10n) : 0n
    return { amount, gst, credited: 0n, creditedGst: 0n }
  })
  const S = L.reduce((sum, l) => sum + l.amount, 0n)
  const G = L.reduce((sum, l) => sum + l.gst, 0n)
  const R = halfUp(S * retentionBp, 10000n)
  const RG = share(G, R, S)
  const o = { S, G, gross: S + G, R, RG, cS: 0n, cG: 0n, cR: 0n, cRG: 0n, rel: 0n, relG: 0n, received: 0n }

  const heldEx = () => o.R - o.rel - o.cR
  const heldGst = () => o.RG - o.relG - o.cRG

  return {
    o,
    heldEx,
    // rows — [lineIndex, amountText]. Returns the credit's own figures.
    credit(rows) {
      let subtotal = 0n
      let gst = 0n
      for (const [index, amountText] of rows) {
        const l = L[index]
        const after = l.credited + parseCents(amountText)
        if (after > l.amount) throw new Error('oracle: over-credit')
        // Cumulative share of the line's STORED GST; the remainder when full.
        const cumulative = after === l.amount ? l.gst : share(l.gst, after, l.amount)
        gst += cumulative - l.creditedGst
        subtotal += parseCents(amountText)
        l.credited = after
        l.creditedGst = cumulative
      }
      // RETENTION: the same fraction of the retention STILL HELD as the credit
      // is of the amount STILL BILLED; the credit that takes everything still
      // billed takes everything still held. No catch-up after a release.
      const stillBilled = o.S - o.cS
      let retention = subtotal === stillBilled
        ? heldEx()
        : least(least(share(heldEx(), subtotal, stillBilled), heldEx()), subtotal)
      // ITS GST: the retention GST left HELD is the retained fraction of the GST
      // STILL BILLED — never more than was held before, nil once no retention is
      // held. The credit takes whatever that removes: a GST-free credit frees
      // none, a taxable credit frees its retained share.
      const gstStillBilled = o.G - (o.cG + gst)
      const retentionGstFor = (part) => {
        const heldExAfter = heldEx() - part
        const heldGstAfter = heldExAfter <= 0n
          ? 0n
          : least(heldGst(), share(gstStillBilled, heldExAfter, stillBilled - subtotal))
        return heldGst() - heldGstAfter
      }
      let retentionGst = retentionGstFor(retention)
      // ROUNDING DIRECTION: a credit never raises what is receivable. When the
      // two half-up roundings together exceed the credit, the ex-GST part steps
      // down a cent at a time (never on the final credit) until it fits.
      while (subtotal !== stillBilled && retention + retentionGst > subtotal + gst && retention > 0n) {
        retention -= 1n
        retentionGst = retentionGstFor(retention)
      }
      o.cS += subtotal; o.cG += gst; o.cR += retention; o.cRG += retentionGst
      return {
        subtotal: centsText(subtotal), gstTotal: centsText(gst), grossTotal: centsText(subtotal + gst),
        retentionAmount: centsText(retention), retentionGst: centsText(retentionGst),
        receivableTotal: centsText(subtotal + gst - retention - retentionGst),
      }
    },
    release(amountText) {
      const amount = parseCents(amountText)
      if (amount > heldEx()) throw new Error('oracle: over-release')
      // The same rule as a credit's: what is left HELD is the retained fraction
      // of the GST still billed, never more than was held; the release takes the
      // rest, and the release of everything held takes it all.
      const heldGstAfter = amount === heldEx() ? 0n : least(heldGst(), share(o.G - o.cG, heldEx() - amount, o.S - o.cS))
      const gst = heldGst() - heldGstAfter
      o.rel += amount; o.relG += gst
      return { amount: centsText(amount), gstAmount: centsText(gst), releaseTotal: centsText(amount + gst) }
    },
    receive(amountText) { o.received += parseCents(amountText) },
    stored() {
      return {
        subtotal: centsText(o.S), gstTotal: centsText(o.G), grossTotal: centsText(o.gross),
        retention: centsText(o.R), retentionGst: centsText(o.RG), retentionTotal: centsText(o.R + o.RG),
        receivableTotal: centsText(o.gross - o.R - o.RG),
      }
    },
    // Every figure the stage comparison checks, as two-decimal strings.
    figures(contractText) {
      const credited = o.cS + o.cG
      const held = (o.R + o.RG) - (o.rel + o.relG) - (o.cR + o.cRG)
      const basis = o.gross - credited - held
      const remaining = basis - o.received
      const zero = 0n
      return {
        grossTotal: centsText(o.gross),
        creditedSubtotal: centsText(o.cS),
        creditedGst: centsText(o.cG),
        credited: centsText(credited),
        netIssued: centsText(o.S - o.cS),
        netIssuedGross: centsText(o.gross - credited),
        retentionTotal: centsText(o.R + o.RG),
        retentionHeld: centsText(held),
        released: centsText(o.rel + o.relG),
        creditedRetention: centsText(o.cR + o.cRG),
        receivableBasis: centsText(basis),
        received: centsText(o.received),
        remaining: centsText(remaining),
        outstanding: centsText(remaining > zero ? remaining : zero),
        owedToClient: centsText(remaining < zero ? -remaining : zero),
        contractSum: centsText(parseCents(contractText)),
        availableToInvoice: centsText(parseCents(contractText) - (o.S - o.cS)),
      }
    },
  }
}

// ── The library side ─────────────────────────────────────────────────────────

const money = (n) => Number(n).toFixed(2)
const CONTRACT = '100000.00'

// Builds the invoice the way the editor does, from the same decimal strings.
function libraryInvoice(id, lines, { retentionPercent = 0, currency = 'AUD', legacy = false } = {}) {
  const lineItems = lines.map(([amountText, taxCode, storedGst], i) => ({
    description: `Line ${i + 1}`,
    amount: Number(amountText),
    taxCode,
    gstAmount: storedGst !== undefined ? Number(storedGst) : gstForLine(Number(amountText), taxCode),
    variationId: null, variationNumber: '', costCodeId: null, costCodeName: null,
  }))
  const base = invoiceTotals(lineItems)
  const totals = invoiceTotals(lineItems, retentionFromPercent(base.subtotal, retentionPercent))
  const inv = {
    id, invoiceNumber: `CI-${id}`, status: 'draft',
    clientId: 'client1', clientName: 'Acme Developments', currency,
    invoiceDate: '2026-10-01', dueDate: '2026-10-31',
    lineItems, ...totals,
  }
  if (legacy) {
    // Exactly as stored before ADR-88: no retention fields at all.
    delete inv.retention; delete inv.retentionGst; delete inv.retentionTotal; delete inv.receivableTotal
  }
  return inv
}

// One project holding one invoice: every entry is built by the REAL builders
// against the running ledger, applied, and checked against the invariants.
function libraryBook(inv) {
  let ledger = emptyLedger()
  let n = 0
  const creditNotes = []
  const releases = []
  const receipts = []
  return {
    inv, creditNotes, releases, receipts,
    issue() { inv.status = 'issued' },
    credit(rows) {
      const built = buildClientCreditNote(inv, ledger, rows.map(([invoiceLineIndex, amountText]) => ({ invoiceLineIndex, amount: Number(amountText) })))
      if (built.error) return built
      n += 1
      const cn = {
        id: `${inv.id}-cn${n}`, creditNumber: `CCN-000${n}`, status: 'posted',
        clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, clientId: inv.clientId, currency: inv.currency,
        lineItems: built.lineItems, ...built.totals, ledgerSeq: built.ledgerSeq,
      }
      ledger = applyCredit(ledger, cn)
      expect(ledgerInvariantError(inv, ledger)).toBeNull()
      expect(clientCreditException(cn, invoicesById([inv]))).toBeNull()
      creditNotes.push(cn)
      return cn
    },
    release(amountText) {
      const built = buildClientRetentionRelease(inv, ledger, Number(amountText))
      if (built.error) return built
      n += 1
      const r = { id: `${inv.id}-rr${n}`, releaseNumber: `CRR-000${n}`, status: 'posted', clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, ...built }
      ledger = applyRelease(ledger, r)
      expect(ledgerInvariantError(inv, ledger)).toBeNull()
      releases.push(r)
      return r
    },
    receive(amountText) {
      n += 1
      receipts.push({
        id: `${inv.id}-cr${n}`, receiptNumber: `CR-000${n}`, status: 'posted', clientId: inv.clientId,
        receiptDate: '2026-11-05', amount: Number(amountText), allocatedTotal: Number(amountText), unallocatedAmount: 0,
        allocations: [{ clientInvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, allocatedAmount: Number(amountText) }],
      })
    },
    // The same figures as oracle.figures(), read from the library's three surfaces.
    figures(contractText) {
      const context = receivableContext([inv], creditNotes, releases)
      const p = context.positions[inv.id]
      const summary = receivablesSummary([inv], receipts, context.positions)
      const control = contractControl([inv], Number(contractText), context.totals)
      const row = summary.rows[0]
      // The ledger always equals the posted documents.
      expect(ledgerDisagreement(ledgerDocument(ledger), inv.id, creditNotes, releases)).toEqual([])
      expect(ledgerExceptions([inv], ledger.seq > 0 ? [{ id: inv.id, ...ledgerDocument(ledger) }] : [], creditNotes, releases)).toEqual([])
      // The three surfaces agree with each other before they meet the oracle.
      expect(money(row.receivableBasis)).toBe(money(p.receivableBasis))
      expect(money(row.credited)).toBe(money(p.credited))
      expect(money(row.retentionHeld)).toBe(money(p.retentionHeld))
      expect(money(row.releasedTotal)).toBe(money(p.releasedTotal))
      expect(money(summary.credited)).toBe(money(p.credited))
      expect(money(summary.retentionHeld)).toBe(money(p.retentionHeld))
      expect(money(summary.receivable)).toBe(money(p.receivableBasis))
      expect(money(summary.issuedGross)).toBe(money(p.grossTotal))
      expect(money(control.credited.subtotal)).toBe(money(p.creditedSubtotal))
      expect(money(control.credited.gstTotal)).toBe(money(p.creditedGst))
      expect(money(control.issued.gstTotal)).toBe(money(inv.gstTotal - p.creditedGst))
      expect(money(control.billed.subtotal)).toBe(money(inv.subtotal))
      return {
        grossTotal: money(p.grossTotal),
        creditedSubtotal: money(p.creditedSubtotal),
        creditedGst: money(p.creditedGst),
        credited: money(p.credited),
        netIssued: money(p.netIssuedSubtotal),
        netIssuedGross: money(p.netIssuedGross),
        retentionTotal: money(p.retentionTotal),
        retentionHeld: money(p.retentionHeld),
        released: money(p.releasedTotal),
        creditedRetention: money(p.creditedRetention),
        receivableBasis: money(p.receivableBasis),
        received: money(summary.received),
        remaining: money(row.remaining),
        outstanding: money(summary.remaining),
        owedToClient: money(summary.owedToClient),
        contractSum: money(control.currentContractSum),
        availableToInvoice: money(control.availableToInvoice),
        // contractControl's net Issued must be the position's.
        issuedByContractControl: money(control.issued.subtotal),
      }
    },
  }
}

// Runs one step on both sides and compares what each produced.
function both(lib, oracle) {
  const agree = () => {
    const expected = oracle.figures(CONTRACT)
    const actual = lib.figures(CONTRACT)
    expect(actual.issuedByContractControl).toBe(expected.netIssued)
    delete actual.issuedByContractControl
    expect(actual).toEqual(expected)
    return expected
  }
  return {
    agree,
    credit(rows) {
      const expected = oracle.credit(rows)
      const cn = lib.credit(rows)
      expect(cn.error).toBeUndefined()
      expect({
        subtotal: money(cn.subtotal), gstTotal: money(cn.gstTotal), grossTotal: money(cn.grossTotal),
        retentionAmount: money(cn.retentionAmount), retentionGst: money(cn.retentionGst),
        receivableTotal: money(cn.receivableTotal),
      }).toEqual(expected)
      return { expected, figures: agree() }
    },
    release(amountText) {
      const expected = oracle.release(amountText)
      const r = lib.release(amountText)
      expect(r.error).toBeUndefined()
      expect({ amount: money(r.amount), gstAmount: money(r.gstAmount), releaseTotal: money(r.releaseTotal) }).toEqual(expected)
      return { expected, figures: agree() }
    },
    receive(amountText) {
      oracle.receive(amountText)
      lib.receive(amountText)
      return { figures: agree() }
    },
  }
}

// The CF6 invoice: a large taxable line, the 40.15 half-cent boundary line, a
// GST-free line and a zero-value line.
const CF6_LINES = [
  ['60000.00', 'gst'],
  ['40.15', 'gst'],
  ['1500.00', 'gst_free'],
  ['0.00', 'gst'],
]

function cf6() {
  const inv = libraryInvoice('A', CF6_LINES, { retentionPercent: 5 })
  const oracle = oracleInvoice(CF6_LINES, { retentionBp: 500n })
  const lib = libraryBook(inv)
  return { inv, oracle, lib, step: both(lib, oracle) }
}

// ── The oracle is checked by hand first ──────────────────────────────────────

describe('the oracle', () => {
  it('computes the CF6 invoice as worked by hand', () => {
    // subtotal 60000.00 + 40.15 + 1500.00 + 0.00           = 61540.15
    // GST      6000.00 + 4.02 (4.015 → up) + 0 + 0         =  6004.02
    // retention 5% of 61540.15 = 3077.0075 → 3077.01
    // retention GST 6004.02 × 3077.01 ÷ 61540.15 = 300.2011 → 300.20
    expect(oracleInvoice(CF6_LINES, { retentionBp: 500n }).stored()).toEqual({
      subtotal: '61540.15', gstTotal: '6004.02', grossTotal: '67544.17',
      retention: '3077.01', retentionGst: '300.20', retentionTotal: '3377.21', receivableTotal: '64166.96',
    })
  })

  it('rounds decimal halves up and shares cumulatively', () => {
    expect(centsText(halfUp(parseCents('40.15'), 10n))).toBe('4.02')
    expect(centsText(halfUp(parseCents('40.14'), 10n))).toBe('4.01')
    const o = oracleInvoice([['40.15', 'gst']])
    expect(o.credit([[0, '20.07']]).gstTotal).toBe('2.01') // 2.0095 → 2.01
    expect(o.credit([[0, '20.08']]).gstTotal).toBe('2.01') // the remainder of 4.02
  })
})

// ── CF6 — the integrated lifecycle ───────────────────────────────────────────

describe('CF6 lifecycle: contract → invoice → retention → credit → receipt → release → reconcile', () => {
  it('reconciles to the oracle at every stage', () => {
    const { inv, oracle, lib, step } = cf6()

    // ── Stage 0: a DRAFT invoice bills nothing ────────────────────────────────
    expect(validateInvoiceDraft({
      clientId: inv.clientId, clientName: inv.clientName, invoiceDate: inv.invoiceDate,
      lineItems: inv.lineItems, retention: inv.retention,
    })).toBeNull()
    const stored = oracle.stored()
    for (const key of Object.keys(stored)) expect(money(inv[key])).toBe(stored[key])
    expect(receivablePositions([inv])).toEqual({})
    const draftControl = contractControl([inv], Number(CONTRACT))
    expect(money(draftControl.issued.subtotal)).toBe('0.00')
    expect(money(draftControl.drafts.subtotal)).toBe('61540.15')
    expect(money(draftControl.availableToInvoice)).toBe('100000.00')

    // ── Stage 1: issue ────────────────────────────────────────────────────────
    lib.issue()
    expect(step.agree()).toMatchObject({
      grossTotal: '67544.17', netIssued: '61540.15', credited: '0.00',
      retentionTotal: '3377.21', retentionHeld: '3377.21', released: '0.00',
      receivableBasis: '64166.96', received: '0.00', remaining: '64166.96', owedToClient: '0.00',
      contractSum: '100000.00', availableToInvoice: '38459.85',
    })

    // ── Stage 2: partial credit (part of the big line, half the boundary line) ─
    const c1 = step.credit([[0, '10000.00'], [1, '20.07']])
    // 1000.00 + 2.01 (4.02 × 20.07 ÷ 40.15 = 2.0095)
    expect(c1.expected).toMatchObject({ subtotal: '10020.07', gstTotal: '1002.01', grossTotal: '11022.08' })
    // retention 3077.01 held × 10020.07 ÷ 61540.15 still billed = 501.0038 → 501.00,
    //   leaving 2576.01 held against 51520.08 still billed.
    // its GST: GST still billed (6004.02 − 1002.01 = 5002.01) × 2576.01 ÷ 51520.08
    //   = 250.1011 → 250.10 stays held, so the credit takes 300.20 − 250.10 = 50.10.
    expect(c1.expected).toMatchObject({ retentionAmount: '501.00', retentionGst: '50.10', receivableTotal: '10470.98' })
    expect(c1.figures).toMatchObject({
      netIssued: '51520.08', creditedGst: '1002.01', credited: '11022.08',
      retentionHeld: '2826.11',     // 3377.21 − 551.10
      receivableBasis: '53695.98',  // 67544.17 − 11022.08 − 2826.11
      availableToInvoice: '48479.92', contractSum: '100000.00',
    })
    // The credit lowered the receivable: 64166.96 → 53695.98, by its receivable part.
    expect(parseCents('64166.96') - parseCents(c1.figures.receivableBasis)).toBe(parseCents(c1.expected.receivableTotal))

    // ── Stage 3: a receipt ────────────────────────────────────────────────────
    const r1 = step.receive('30000.00')
    expect(r1.figures).toMatchObject({
      received: '30000.00', receivableBasis: '53695.98', remaining: '23695.98', owedToClient: '0.00',
      // Cash changes nothing that was billed, credited or held.
      netIssued: '51520.08', retentionHeld: '2826.11', availableToInvoice: '48479.92',
    })

    // ── Stage 4: partial retention release ────────────────────────────────────
    const rel1 = step.release('1000.00')
    // 1576.01 stays held; its retained share of the GST still billed is
    // 5002.01 × 1576.01 ÷ 51520.08 = 153.0130 → 153.01, so the release takes 250.10 − 153.01 = 97.09
    expect(rel1.expected).toEqual({ amount: '1000.00', gstAmount: '97.09', releaseTotal: '1097.09' })
    expect(rel1.figures).toMatchObject({
      // held 2826.11 − 1097.09; basis 53695.98 + 1097.09; remaining − 30000.00
      released: '1097.09', retentionHeld: '1729.02', receivableBasis: '54793.07', remaining: '24793.07',
      // A release bills nothing and credits nothing.
      netIssued: '51520.08', credited: '11022.08', availableToInvoice: '48479.92',
    })

    // ── Stage 5: second credit (rest of the boundary line, part of the GST-free line) ─
    const c2 = step.credit([[1, '20.08'], [2, '500.00']])
    // GST: the remainder of the line's 4.02; none on the GST-free line.
    expect(c2.expected).toMatchObject({ subtotal: '520.08', gstTotal: '2.01', grossTotal: '522.09' })
    // retention 1576.01 held × 520.08 ÷ 51520.08 still billed = 15.9093 → 15.91,
    //   leaving 1560.10 held against 51000.00 still billed.
    // its GST: GST still billed (6004.02 − 1004.02 = 5000.00) × 1560.10 ÷ 51000.00
    //   = 152.9510 → 152.95 stays held, so the credit takes 153.01 − 152.95 = 0.06
    //   — the retained share of the 2.01 of GST it credits; the 500.00 of the
    //   GST-free line frees none.
    expect(c2.expected).toMatchObject({ retentionAmount: '15.91', retentionGst: '0.06', receivableTotal: '506.12' })
    expect(c2.figures).toMatchObject({
      netIssued: '51000.00', creditedSubtotal: '10540.15', creditedGst: '1004.02', credited: '11544.17',
      // held 1729.02 − 15.97; basis 67544.17 − 11544.17 − 1713.05; remaining − 30000.00
      retentionHeld: '1713.05', receivableBasis: '54286.95', remaining: '24286.95',
      availableToInvoice: '49000.00',
    })
    expect(parseCents(rel1.figures.receivableBasis) - parseCents(c2.figures.receivableBasis)).toBe(parseCents(c2.expected.receivableTotal))

    // ── Stage 6: the FINAL release — everything still held ────────────────────
    const heldEx = centsText(oracle.heldEx())
    expect(heldEx).toBe('1560.10') // 3077.01 − 1000.00 released − 516.91 credited
    const rel2 = step.release(heldEx)
    // All the GST still held: 300.20 − 97.09 released − 50.16 credited.
    expect(rel2.expected).toEqual({ amount: '1560.10', gstAmount: '152.95', releaseTotal: '1713.05' })
    expect(rel2.figures).toMatchObject({
      // released 1097.09 + 1713.05; credited retention 551.10 + 15.97
      retentionHeld: '0.00', released: '2810.14', creditedRetention: '567.07',
      receivableBasis: '56000.00', remaining: '26000.00',
    })
    // Nothing is left to release.
    expect(lib.release('0.01').error).toBe('Only 0.00 of retention (ex-GST) is still held on CI-A.')

    // ── Stage 7: the final receipt reconciles the invoice ─────────────────────
    const r2 = step.receive(rel2.figures.remaining)
    expect(r2.figures).toEqual({
      grossTotal: '67544.17',
      creditedSubtotal: '10540.15', creditedGst: '1004.02', credited: '11544.17',
      netIssued: '51000.00', netIssuedGross: '56000.00',
      retentionTotal: '3377.21', retentionHeld: '0.00', released: '2810.14', creditedRetention: '567.07',
      receivableBasis: '56000.00', received: '56000.00', remaining: '0.00',
      outstanding: '0.00', owedToClient: '0.00',
      contractSum: '100000.00', availableToInvoice: '49000.00',
    })
    const row = clientInvoiceReconciliationRows([inv], lib.receipts, receivablePositions([inv], lib.creditNotes, lib.releases))[0]
    expect(row.state).toBe('fully_reconciled')
    // The closing identities: cash received = net billed; nothing held; the
    // retention withheld is fully accounted for by releases and credits.
    expect(r2.figures.received).toBe(r2.figures.netIssuedGross)
    expect(parseCents(r2.figures.released) + parseCents(r2.figures.creditedRetention)).toBe(parseCents(r2.figures.retentionTotal))
    expect(parseCents(r2.figures.netIssued) + parseCents(r2.figures.availableToInvoice)).toBe(parseCents(CONTRACT))
  })

  it('the same lifecycle with the releases and credits in another order still ends reconciled', () => {
    const { lib, oracle, step } = cf6()
    lib.issue()
    // Release 500.00, leaving 2577.01 held: its retained share of the GST billed is
    // 6004.02 × 2577.01 ÷ 61540.15 = 251.4189 → 251.42, so the release takes 300.20 − 251.42 = 48.78.
    expect(step.release('500.00').expected).toEqual({ amount: '500.00', gstAmount: '48.78', releaseTotal: '548.78' })
    // The GST-free line in full: 2577.01 × 1500 ÷ 61540.15 = 62.8127 → 62.81, and NO
    // retention GST (6004.02 × 2514.20 ÷ 60040.15 = 251.4201 → all 251.42 stays held).
    expect(step.credit([[2, '1500.00']]).expected)
      .toMatchObject({ gstTotal: '0.00', retentionAmount: '62.81', retentionGst: '0.00', receivableTotal: '1437.19' })
    step.receive('12345.67')
    // 2514.20 × 33333.34 ÷ 60040.15 = 1395.8407 → 1395.84, leaving 1118.36;
    // GST left held 2670.69 × 1118.36 ÷ 26706.81 = 111.8360 → 111.84, so it takes 139.58.
    const c2 = step.credit([[0, '33333.33'], [1, '0.01']])
    expect(c2.expected).toMatchObject({ gstTotal: '3333.33', retentionAmount: '1395.84', retentionGst: '139.58' })
    expect(c2.figures).toMatchObject({ retentionHeld: '1230.20', receivableBasis: '28147.30' })
    expect(step.release(centsText(oracle.heldEx())).expected)
      .toEqual({ amount: '1118.36', gstAmount: '111.84', releaseTotal: '1230.20' })
    const end = step.receive(oracle.figures(CONTRACT).remaining)
    expect(end.figures).toMatchObject({
      retentionHeld: '0.00', remaining: '0.00', owedToClient: '0.00',
      released: '1778.98', creditedRetention: '1598.23', receivableBasis: '29377.50',
    })
    expect(end.figures.received).toBe(end.figures.netIssuedGross)
  })
})

// ── Scenarios ────────────────────────────────────────────────────────────────

describe('scenario: credits after a release take only their fraction of what is still held (no catch-up)', () => {
  it('a large credit after a large release leaves retention held for what is still billed', () => {
    const { lib, oracle, step } = cf6()
    lib.issue()
    // 2000.00 of the 3077.01 is released: 1077.01 + 105.08 GST stays held
    // (6004.02 × 1077.01 ÷ 61540.15 = 105.0754), so the release carries 300.20 − 105.08 = 195.12.
    const rel = step.release('2000.00')
    expect(rel.expected).toEqual({ amount: '2000.00', gstAmount: '195.12', releaseTotal: '2195.12' })
    expect(centsText(oracle.heldEx())).toBe('1077.01')

    // 1077.01 × 1500.00 ÷ 61540.15 = 26.2514 → 26.25, leaving 1050.76 held.
    // The line is GST-free, so the credit frees NO retention GST: what stays held
    // is 6004.02 × 1050.76 ÷ 60040.15 = 105.0752 → 105.08, all of it.
    const c1 = step.credit([[2, '1500.00']])
    expect(c1.expected).toMatchObject({ gstTotal: '0.00', retentionAmount: '26.25', retentionGst: '0.00', receivableTotal: '1473.75' })

    // 1050.76 × 33333.34 ÷ 60040.15 = 583.3668 → 583.37 — NOT the 1050.76 still
    // held, which the superseded cumulative rule took here. Leaving 467.39 held;
    // GST left held (6004.02 − 3333.33 = 2670.69) × 467.39 ÷ 26706.81 = 46.7392
    // → 46.74, so the credit takes 105.08 − 46.74 = 58.34.
    const c2 = step.credit([[0, '33333.33'], [1, '0.01']])
    expect(c2.expected).toMatchObject({ subtotal: '33333.34', retentionAmount: '583.37', retentionGst: '58.34' })
    expect(centsText(oracle.heldEx())).toBe('467.39')
    expect(c2.figures).toMatchObject({
      // held 467.39 + 46.74; basis 67544.17 − 38166.67 − 514.13
      netIssued: '26706.81', retentionHeld: '514.13', receivableBasis: '28863.37',
    })
    // Retention is still held against the 26,706.81 still billed, and is releasable.
    const last = step.release('467.39')
    expect(last.expected).toEqual({ amount: '467.39', gstAmount: '46.74', releaseTotal: '514.13' })
    expect(last.figures).toMatchObject({ retentionHeld: '0.00', receivableBasis: '29377.50' })
    expect(last.figures.receivableBasis).toBe(last.figures.netIssuedGross)
  })
})

describe('scenario: mixed tax, fully retained — a credit never raises the receivable on any surface', () => {
  // A 1000.00 gst (GST 100.00) · B 1000.00 gst_free · retention 100%:
  // 2000.00 + 100.00 withheld, nothing receivable.
  const lines = [['1000.00', 'gst'], ['1000.00', 'gst_free']]
  const build = () => {
    const lib = libraryBook(libraryInvoice('M', lines, { retentionPercent: 100 }))
    const oracle = oracleInvoice(lines, { retentionBp: 10000n })
    lib.issue()
    return { lib, oracle, step: both(lib, oracle) }
  }

  it('crediting the GST-free line frees no retention GST: basis 0.00 before and after', () => {
    const { step } = build()
    expect(step.agree()).toMatchObject({ retentionTotal: '2100.00', retentionHeld: '2100.00', receivableBasis: '0.00', remaining: '0.00' })
    // (The superseded rule took 50.00 of retention GST here: receivableTotal −50.00,
    // and the receivable rose from 0.00 to 50.00.)
    const b = step.credit([[1, '1000.00']])
    expect(b.expected).toEqual({
      subtotal: '1000.00', gstTotal: '0.00', grossTotal: '1000.00',
      retentionAmount: '1000.00', retentionGst: '0.00', receivableTotal: '0.00',
    })
    expect(b.figures).toMatchObject({
      retentionHeld: '1100.00', receivableBasis: '0.00', remaining: '0.00', outstanding: '0.00', owedToClient: '0.00',
    })
    const a = step.credit([[0, '1000.00']])
    expect(a.expected).toMatchObject({ gstTotal: '100.00', retentionAmount: '1000.00', retentionGst: '100.00', receivableTotal: '0.00' })
    expect(a.figures).toMatchObject({ retentionHeld: '0.00', receivableBasis: '0.00', netIssuedGross: '0.00', owedToClient: '0.00' })
  })

  it('crediting the taxable line first frees all 100.00 of retention GST: basis 0.00 before and after', () => {
    const { step } = build()
    const a = step.credit([[0, '1000.00']])
    expect(a.expected).toEqual({
      subtotal: '1000.00', gstTotal: '100.00', grossTotal: '1100.00',
      retentionAmount: '1000.00', retentionGst: '100.00', receivableTotal: '0.00',
    })
    expect(a.figures).toMatchObject({ retentionHeld: '1000.00', receivableBasis: '0.00', remaining: '0.00', owedToClient: '0.00' })
    // The GST-free remainder is still fully retained; releasing it makes exactly it receivable.
    const r = step.release('1000.00')
    expect(r.expected).toEqual({ amount: '1000.00', gstAmount: '0.00', releaseTotal: '1000.00' })
    expect(r.figures).toMatchObject({ retentionHeld: '0.00', receivableBasis: '1000.00', remaining: '1000.00' })
    expect(r.figures.receivableBasis).toBe(r.figures.netIssuedGross)
  })
})

describe('scenario: a zero-value line', () => {
  it('contributes nothing, and cannot be credited', () => {
    const { inv, lib, step } = cf6()
    lib.issue()
    expect(inv.lineItems[3]).toMatchObject({ amount: 0, gstAmount: 0 })
    step.agree()
    expect(lib.credit([[3, '0.00']]).error).toBe('Line 4: the credit amount must be greater than zero.')
    expect(lib.credit([[3, '0.01']]).error).toBe('Line 4: only 0.00 of 0.00 remains to credit.')
    expect(lib.creditNotes).toHaveLength(0)
    // The same invoice without the zero line has identical figures.
    const without = libraryInvoice('A', CF6_LINES.slice(0, 3), { retentionPercent: 5 })
    for (const key of ['subtotal', 'gstTotal', 'grossTotal', 'retention', 'retentionGst', 'retentionTotal', 'receivableTotal']) {
      expect(without[key]).toBe(inv[key])
    }
  })
})

describe('scenario: a FULL credit', () => {
  it('reverses the invoice GST exactly, clears the retention still held and re-opens the whole amount', () => {
    const { lib, step } = cf6()
    lib.issue()
    step.release('1000.00')
    // Every line that has value, in one credit note.
    const full = step.credit([[0, '60000.00'], [1, '40.15'], [2, '1500.00']])
    expect(full.expected).toMatchObject({ subtotal: '61540.15', gstTotal: '6004.02', grossTotal: '67544.17' })
    // The retention still held: 3077.01 − 1000.00 and 300.20 − 97.56.
    expect(full.expected).toMatchObject({ retentionAmount: '2077.01', retentionGst: '202.64' })
    expect(full.figures).toMatchObject({
      netIssued: '0.00', netIssuedGross: '0.00', creditedGst: '6004.02', credited: '67544.17',
      retentionHeld: '0.00', released: '1097.56', receivableBasis: '0.00', remaining: '0.00', owedToClient: '0.00',
      availableToInvoice: '100000.00', contractSum: '100000.00',
    })
    const row = clientInvoiceReconciliationRows([lib.inv], [], receivablePositions([lib.inv], lib.creditNotes, lib.releases))[0]
    expect(row.state).toBe('fully_reconciled')
  })

  it('reached through several credit notes gives the same end state', () => {
    const { lib, step } = cf6()
    lib.issue()
    // 3077.01 × 12359.05 ÷ 61540.15 = 617.9525 → 617.95; GST left held
    // 4768.11 × 2459.06 ÷ 49181.10 = 238.4056 → 238.41, so it takes 61.79.
    expect(step.credit([[0, '12345.67'], [1, '13.38']]).expected)
      .toMatchObject({ gstTotal: '1235.91', retentionAmount: '617.95', retentionGst: '61.79' })
    // Mostly GST-free: 1.34 of GST credited frees 0.07 of retention GST.
    expect(step.credit([[1, '13.38'], [2, '750.00']]).expected)
      .toMatchObject({ gstTotal: '1.34', retentionAmount: '38.17', retentionGst: '0.07' })
    expect(step.release('500.00').expected).toEqual({ amount: '500.00', gstAmount: '49.23', releaseTotal: '549.23' })
    // The closing credit takes everything still held: 1920.89 + 189.11.
    const end = step.credit([[0, '47654.33'], [1, '13.39'], [2, '750.00']])
    expect(end.expected).toMatchObject({ subtotal: '48417.72', gstTotal: '4766.77', retentionAmount: '1920.89', retentionGst: '189.11' })
    expect(end.figures).toMatchObject({
      netIssued: '0.00', creditedGst: '6004.02', retentionHeld: '0.00', receivableBasis: '0.00',
      availableToInvoice: '100000.00',
    })
  })
})

describe('scenario: a credit against an invoice that was already fully received', () => {
  it('leaves the credited amount OWED TO THE CLIENT — never clamped', () => {
    const lines = [['2500.00', 'gst'], ['40.15', 'gst'], ['300.00', 'gst_free']]
    const inv = libraryInvoice('B', lines)
    const oracle = oracleInvoice(lines)
    const lib = libraryBook(inv)
    const step = both(lib, oracle)
    lib.issue()

    const paid = step.receive(oracle.figures(CONTRACT).grossTotal)
    expect(paid.figures).toMatchObject({ grossTotal: '3094.17', received: '3094.17', remaining: '0.00', owedToClient: '0.00' })

    const credit = step.credit([[1, '40.15'], [2, '100.00']])
    expect(credit.expected).toMatchObject({ subtotal: '140.15', gstTotal: '4.02', grossTotal: '144.17', retentionAmount: '0.00' })
    expect(credit.figures).toMatchObject({
      receivableBasis: '2950.00', received: '3094.17',
      remaining: '-144.17', outstanding: '0.00', owedToClient: '144.17',
      netIssued: '2700.00', availableToInvoice: '97300.00',
    })
    const row = clientInvoiceReconciliationRows([inv], lib.receipts, receivablePositions([inv], lib.creditNotes))[0]
    expect(row.state).toBe('over_reconciled')
    expect(row.remaining).toBeLessThan(0)
  })
})

describe('scenario: currencies are LABELS — each invoice computes independently', () => {
  // Two invoices with different `currency` fields. This test never adds a figure
  // of one to a figure of the other: each is compared with its own oracle only.
  const lines = [['1234.55', 'gst'], ['40.15', 'gst'], ['99.95', 'gst_free']]

  it('the currency label changes no arithmetic', () => {
    const aud = libraryBook(libraryInvoice('AUD1', lines, { retentionPercent: 10, currency: 'AUD' }))
    const nzd = libraryBook(libraryInvoice('NZD1', lines, { retentionPercent: 10, currency: 'NZD' }))
    const audStep = both(aud, oracleInvoice(lines, { retentionBp: 1000n }))
    const nzdStep = both(nzd, oracleInvoice(lines, { retentionBp: 1000n }))
    aud.issue(); nzd.issue()

    const a1 = audStep.credit([[0, '234.55'], [1, '20.07']])
    const n1 = nzdStep.credit([[0, '234.55'], [1, '20.07']])
    expect(a1.figures).toEqual(n1.figures)
    expect(aud.creditNotes[0].currency).toBe('AUD')
    expect(nzd.creditNotes[0].currency).toBe('NZD')

    // From here they diverge, and each still equals its own oracle.
    audStep.release('50.00')
    audStep.receive('700.00')
    nzdStep.credit([[2, '99.95']])
    nzdStep.receive('1500.00')
    const a = audStep.agree()
    const n = nzdStep.agree()
    expect(a).not.toEqual(n)
    expect(a.released).not.toBe('0.00')
    expect(n.released).toBe('0.00')
  })

  it('an entry on one invoice never moves the other', () => {
    const aud = libraryBook(libraryInvoice('AUD1', lines, { retentionPercent: 10, currency: 'AUD' }))
    const nzd = libraryBook(libraryInvoice('NZD1', lines, { retentionPercent: 10, currency: 'NZD' }))
    aud.issue(); nzd.issue()
    const untouched = receivablePositions([nzd.inv])
    aud.credit([[0, '234.55']])
    aud.release('50.00')
    // Even when every document is handed to one call, each position stands alone.
    const together = receivablePositions([aud.inv, nzd.inv], aud.creditNotes, aud.releases)
    expect(together.NZD1).toEqual(untouched.NZD1)
    expect(together.AUD1).toEqual(receivablePositions([aud.inv], aud.creditNotes, aud.releases).AUD1)
  })

  it('a credit note labelled in another currency counts nothing against the invoice', () => {
    const aud = libraryBook(libraryInvoice('AUD1', lines, { currency: 'AUD' }))
    aud.issue()
    const cn = aud.credit([[0, '234.55']])
    const relabelled = { ...cn, currency: 'NZD' }
    expect(receivablePositions([aud.inv], [relabelled])).toEqual(receivablePositions([aud.inv], []))
  })
})

describe('scenario: an existing historical record', () => {
  // Stored before ADR-86 / ADR-88: no retention fields, and the 40.15 line
  // carries the legacy GST 4.01 (roundMoney(40.15 × 0.1)), not 4.02.
  const lines = [['1000.00', 'gst'], ['40.15', 'gst', '4.01'], ['250.00', 'gst_free']]
  const build = () => {
    const inv = libraryInvoice('H', lines, { legacy: true })
    const oracle = oracleInvoice(lines)
    const lib = libraryBook(inv)
    return { inv, oracle, lib, step: both(lib, oracle) }
  }

  it('is the legacy shape', () => {
    const { inv } = build()
    expect(inv).not.toHaveProperty('retention')
    expect(inv).not.toHaveProperty('receivableTotal')
    expect([money(inv.subtotal), money(inv.gstTotal), money(inv.grossTotal)]).toEqual(['1290.15', '104.01', '1394.16'])
  })

  it('behaves exactly as before: basis = gross, remaining = gross − received, with or without positions', () => {
    const { inv, lib, step } = build()
    lib.issue()
    expect(step.agree()).toMatchObject({
      grossTotal: '1394.16', receivableBasis: '1394.16', retentionTotal: '0.00', retentionHeld: '0.00',
      credited: '0.00', remaining: '1394.16', netIssued: '1290.15', availableToInvoice: '98709.85',
    })
    step.receive('394.16')
    const withPositions = clientInvoiceReconciliationRows([inv], lib.receipts, receivablePositions([inv]))
    const before = clientInvoiceReconciliationRows([inv], lib.receipts)
    expect(withPositions).toEqual(before)
    expect(money(before[0].remaining)).toBe('1000.00')
    expect(receivablesSummary([inv], lib.receipts, receivablePositions([inv])))
      .toEqual(receivablesSummary([inv], lib.receipts))
    expect(contractControl([inv], Number(CONTRACT), receivableContext([inv]).totals))
      .toEqual(contractControl([inv], Number(CONTRACT)))
    // No retention was withheld, so nothing can be released.
    expect(lib.release('1.00').error).toBe('Only 0.00 of retention (ex-GST) is still held on CI-H.')
  })

  it('a full credit of the legacy line reverses the STORED 4.01', () => {
    const { lib, step } = build()
    lib.issue()
    const credit = step.credit([[1, '40.15']])
    expect(credit.expected).toMatchObject({ subtotal: '40.15', gstTotal: '4.01', grossTotal: '44.16' })
    expect(credit.figures).toMatchObject({ creditedGst: '4.01', netIssued: '1250.00', receivableBasis: '1350.00' })
  })

  it('partial credits of the legacy line sum to the stored 4.01, and a full credit to the stored 104.01', () => {
    const { lib, step } = build()
    lib.issue()
    const first = step.credit([[1, '20.07']])
    const second = step.credit([[1, '20.08']])
    expect(parseCents(first.expected.gstTotal) + parseCents(second.expected.gstTotal)).toBe(parseCents('4.01'))
    const rest = step.credit([[0, '1000.00'], [2, '250.00']])
    expect(rest.figures).toMatchObject({
      creditedGst: '104.01', credited: '1394.16', netIssued: '0.00', receivableBasis: '0.00',
      availableToInvoice: '100000.00',
    })
  })
})
