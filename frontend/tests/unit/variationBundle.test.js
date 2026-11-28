import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as client from '../../src/lib/variationCalc'
import * as server from '../../functions/src/generated/variationCalc.js'
import { buildVariationBundle, VARIATION_BUNDLE_PATH, VARIATION_BUNDLE_HEADER } from '../../scripts/build-variation-bundle.mjs'

// ── The server's copy of the variation domain (ADR-90) ───────────────────────
//
// `functions/src/generated/variationCalc.js` is what the three trusted
// callables (createVariation, approveVariation, applyVariationCommitment) run.
// These tests are the guarantee that it is the SAME domain logic the browser
// drafts and previews with:
//   1. FRESH — regenerating it from src/lib/variationCalc.js yields the
//      committed bytes (a source change without `npm run
//      functions:variation-calc` fails);
//   2. SELF-CONTAINED — no import of any kind, no browser or Firebase reference;
//   3. EQUAL — the same stored document, certified figures and commitment
//      decision from both modules;
//   4. THE ONLY SOURCE OF FIGURES — functions/src/variations/ contains no
//      arithmetic of its own.

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const BUNDLE = readFileSync(VARIATION_BUNDLE_PATH, 'utf8')
const stripComments = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

describe('the generated bundle is fresh', () => {
  it('regenerating from src/lib/variationCalc.js yields the committed file, byte for byte', async () => {
    expect(await buildVariationBundle()).toBe(BUNDLE)
  })
  it('the build is deterministic, carries the generated-file header, and has a build + check script that CI runs', async () => {
    expect(await buildVariationBundle()).toBe(await buildVariationBundle())
    expect(BUNDLE.startsWith(VARIATION_BUNDLE_HEADER)).toBe(true)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['functions:variation-calc']).toBe('node scripts/build-variation-bundle.mjs')
    expect(pkg.scripts['functions:variation-calc:check']).toBe('node scripts/build-variation-bundle.mjs --check')
    expect(read('../azure-pipelines.yml')).toContain('- script: npm run functions:variation-calc:check')
  })
})

describe('the generated bundle is self-contained', () => {
  const code = stripComments(BUNDLE)

  it('has no import, require or dynamic import', () => {
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    expect((code.match(/^export \{/gm) || []).length).toBe(1)
  })
  it('references no browser, React, Firebase or build-time global', () => {
    expect(code).not.toMatch(/import\.meta|\bwindow\.|\bdocument\.|localStorage|sessionStorage|navigator\./)
    expect(code).not.toMatch(/from ['"]firebase|firebase\/(app|firestore|auth|functions|storage)|from ['"]react/)
    expect(BUNDLE).not.toMatch(/\/Users\/|[A-Z]:\\\\/)   // no absolute path of the build machine
  })
  it('the entry module defines nothing: it only re-exports sibling lib modules', () => {
    const entry = stripComments(read('src/lib/variationCalc.js')).trim()
    const statements = entry.split(/\n(?=export )/)
    expect(statements.length).toBeGreaterThanOrEqual(5)
    for (const s of statements) expect(s).toMatch(/^export \{[^}]+\} from '\.\/[A-Za-z]+'$/)
  })
  it('exports exactly what the entry module exports', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort())
  })
})

describe('server and browser produce the same results', () => {
  const NOW = 'ts'
  const input = {
    projectId: 'p1', variationId: 'v1', variationType: 'supplier',
    title: 'Additional steel', description: '', reason: '',
    clientId: null, clientName: null, clientRef: null,
    supplierId: null, supplierName: null, supplierRef: 'Q-1', poId: 'po1',
    originRfiId: 'rfi1', identifiedDate: '2026-11-01', submittedDate: '', responseDueDate: '', effectiveDate: '', notes: '',
    lines: [
      { poLineIndex: 0, costCodeId: null, description: 'Slab', submittedAmount: 40.15, taxCode: 'gst' },
      { poLineIndex: null, costCodeId: 'cc2', description: 'Credit', submittedAmount: -40.15, taxCode: 'gst' },
      { poLineIndex: null, costCodeId: 'cc3', description: 'Fee', submittedAmount: 4.015, taxCode: 'gst_free' },
    ],
  }
  const context = () => ({
    input, number: 7, currency: 'AUD', uid: 'u', now: NOW,
    po: { id: 'po1', status: 'sent', poNumber: 'PO-0001', supplierName: 'Steel Co', supplierId: 'c1', lineItems: [{ costCodeId: 'cc1', costCodeName: '03-100 — Concrete' }] },
    costCodes: new Map([['cc2', { code: '05-100', name: 'Steel' }], ['cc3', { code: '01-000', name: 'Prelims' }]]),
    rfi: { id: 'rfi1', status: 'open', rfiNumber: 'RFI-0001', title: 'Steel' },
  })

  it('the stored draft: identical documents, version 2, every figure derived', () => {
    const a = client.buildVariationDraft(context())
    const b = server.buildVariationDraft(context())
    expect(a.ok).toBe(true)
    expect(b).toEqual(a)
    expect(a.document.calcVersion).toBe(2)
    expect(a.document.lineItems.map(l => [l.submittedAmount, l.submittedGst])).toEqual([[40.15, 4.02], [-40.15, -4.02], [4.02, 0]])
    expect([a.document.submittedSubtotal, a.document.submittedGst, a.document.submittedTotal]).toEqual([4.02, 0, 4.02])
  })

  it('the approval: identical updates for a legacy and for a version-2 variation', () => {
    for (const calcVersion of [undefined, 2]) {
      const live = {
        id: 'v1', variationType: 'supplier', status: 'submitted', revision: 2, poId: 'po1', approvedDate: '', effectiveDate: '',
        ...(calcVersion ? { calcVersion } : {}),
        lineItems: [
          { costCodeId: 'cc1', submittedAmount: 40.15, submittedGst: calcVersion ? 4.02 : 4.01, approvedAmount: null, approvedGst: null, poLineIndex: 0, taxCode: 'gst' },
          { costCodeId: 'cc2', submittedAmount: -40.15, submittedGst: calcVersion ? -4.02 : -4.01, approvedAmount: null, approvedGst: null, poLineIndex: null, taxCode: 'gst' },
        ],
      }
      const args = [live, 'approved', { approvedAmounts: [40.15, -40.15], assessmentNotes: '', applyCommitment: true }, 'u', NOW, '2026-11-27']
      expect(server.transitionUpdate(...args)).toEqual(client.transitionUpdate(...args))
      expect(server.variationCalcVersion(live)).toBe(client.variationCalcVersion(live))
      expect(server.sameApproval({ ...live, ...client.transitionUpdate(...args) }, [40.15, -40.15])).toBe(true)
    }
  })

  it('the commitment decision and the request check agree', () => {
    const approved = { id: 'v1', variationType: 'supplier', status: 'approved', poId: 'po1', revision: 3, lineItems: [{ poLineIndex: null, approvedAmount: 10 }] }
    for (const po of [{ id: 'po1', status: 'sent' }, { id: 'po1', status: 'cancelled' }, null]) {
      expect(server.commitmentApplyEligibility(approved, po ? [po] : [])).toEqual(client.commitmentApplyEligibility(approved, po ? [po] : []))
      expect(server.shouldApplyOnApproval(approved, po)).toBe(client.shouldApplyOnApproval(approved, po))
    }
    expect(server.createVariationRequestProblem(input)).toBe(client.createVariationRequestProblem(input))
    expect(server.createVariationRequestProblem({ ...input, submittedGst: 1 })).toBe('keys')
    expect(server.applyCommitmentUpdate(approved, 'u', NOW)).toEqual(client.applyCommitmentUpdate(approved, 'u', NOW))
  })
})

describe('functions/src/variations/ has no formula of its own', () => {
  const DIR = fileURLToPath(new URL('../../functions/src/variations/', import.meta.url))
  const files = readdirSync(DIR).filter(f => f.endsWith('.js'))

  it('the three modules exist', () => {
    expect(files.sort()).toEqual(['contracts.js', 'handlers.js', 'operations.js'])
  })
  it('no GST rate, no rounding of an amount, no line or header arithmetic — every figure comes from the generated bundle', () => {
    for (const f of files) {
      const code = stripComments(readFileSync(DIR + f, 'utf8'))
      expect(code, f).not.toMatch(/\b0\.1\b|GST_RATE|roundMoney|toFixed|\* ?10\b|\/ ?10\b/)
      expect(code, f).not.toMatch(/submittedGst\s*[:=]|approvedGst\s*[:=]|approvedTotal\s*[:=]|submittedTotal\s*[:=]/)
    }
    const ops = stripComments(readFileSync(DIR + 'operations.js', 'utf8'))
    // The one multiplication is the audit event's whole-cent rendering of a stored figure.
    expect((ops.match(/Math\.round\(/g) || []).length).toBe(1)
    expect(ops).toContain("const cents = (amount) => (typeof amount === 'number' ? Math.round(amount * 100) : null)")
    expect(ops).toContain("import * as calc from '../generated/variationCalc.js'")
  })
})
