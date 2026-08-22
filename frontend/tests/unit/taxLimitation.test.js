import { describe, it, expect } from 'vitest'
import {
  TAX_JURISDICTION, TAX_LIMITATION_NOTICE, needsTaxLimitationNotice,
  SUPPORTED_MARKETS, COUNTRIES,
} from '../../src/lib/currency'
import { TAX_CODE, TAX_CODE_LABELS, gstForLine } from '../../src/lib/clientInvoices'
import { GST_RATE } from '../../src/lib/purchaseOrders'

// ── Tax limitation notice (lib/currency.js) ──────────────────────────────────
//
// Constrapp makes currency DISPLAY configurable. It does NOT make tax
// CALCULATION configurable: GST_RATE is a flat Australian 10% everywhere, so a
// company trading outside Australia must be told so rather than being allowed to
// assume the figures are compliant for its jurisdiction (§15h-iii, §15i-xii).
//
// The rest of lib/currency.js — the project currency lock (monetaryLockReasons)
// — is covered in tests/unit/tenders.test.js. This file covers only the tax
// limitation, which had no coverage at all.

describe('the tax jurisdiction is hard-wired to Australia', () => {
  it('names AU as the only jurisdiction whose tax rules are implemented', () => {
    expect(TAX_JURISDICTION).toBe('AU')
  })

  it('calculates a flat 10% GST regardless of the company country', () => {
    // There is no country parameter anywhere in the GST derivation — that is the
    // whole reason the notice exists.
    expect(GST_RATE).toBe(0.1)
    expect(gstForLine(1000, TAX_CODE.GST)).toBe(100)
  })

  it('labels the rate as Australian on every tax-code list', () => {
    expect(TAX_CODE_LABELS[TAX_CODE.GST]).toBe('GST 10%')
  })
})

describe('needsTaxLimitationNotice', () => {
  it('is FALSE for an Australian company — the calculations are correct there', () => {
    expect(needsTaxLimitationNotice('AU')).toBe(false)
  })

  it('is TRUE for New Zealand, whose real GST is 15% not 10%', () => {
    expect(needsTaxLimitationNotice('NZ')).toBe(true)
  })

  it('is TRUE for South Africa, whose tax is VAT rather than GST', () => {
    expect(needsTaxLimitationNotice('ZA')).toBe(true)
  })

  it('is TRUE for every other supported market', () => {
    const nonAu = SUPPORTED_MARKETS.filter(c => c.code !== 'AU')
    expect(nonAu.map(c => c.code)).toEqual(['NZ', 'ZA', 'US', 'GB', 'IE'])
    for (const c of nonAu) {
      expect(needsTaxLimitationNotice(c.code)).toBe(true)
    }
  })

  it('is TRUE for every non-AU country in the full list — AU is the sole exemption', () => {
    const exempt = COUNTRIES.filter(c => !needsTaxLimitationNotice(c.code))
    expect(exempt.map(c => c.code)).toEqual(['AU'])
  })

  it('is FALSE for a blank or unconfigured country — an unset company shows no notice', () => {
    // Backwards compatibility (§15h-i): a company that predates the country
    // field is not accused of a tax problem it has not opted into. The notice is
    // triggered by an explicit non-AU choice, never by absence.
    expect(needsTaxLimitationNotice('')).toBe(false)
    expect(needsTaxLimitationNotice(null)).toBe(false)
    expect(needsTaxLimitationNotice(undefined)).toBe(false)
  })

  it('is TRUE for an unrecognised but non-empty country code — it fails LOUD, not silent', () => {
    // Shape is not validated here; anything that is not AU gets the warning,
    // which is the safe direction for a tax disclaimer.
    expect(needsTaxLimitationNotice('XX')).toBe(true)
    expect(needsTaxLimitationNotice('au')).toBe(true) // case-sensitive: lowercase is not AU
  })
})

describe('TAX_LIMITATION_NOTICE wording', () => {
  it('says the calculations are Australian and that this is a current limitation', () => {
    expect(TAX_LIMITATION_NOTICE).toMatch(/Australian GST rules/)
    expect(TAX_LIMITATION_NOTICE).toMatch(/currency display is configurable/i)
  })

  it('never claims Constrapp is tax-compliant in another jurisdiction', () => {
    expect(TAX_LIMITATION_NOTICE).not.toMatch(/compliant/i)
  })
})
