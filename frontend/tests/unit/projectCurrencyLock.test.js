import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CURRENCY,
  currencyToPinOnLock,
  resolveProjectCurrency,
  resolveCompanyCurrency,
  projectHasExplicitCurrency,
  isCompanyCurrencyConfigured,
  isProjectCurrencyLocked,
  monetaryLockReasons,
} from '../../src/lib/currency.js'

// ── The currency pinned when the ratchet engages (lib/currency.js) ───────────
//
// `currencyLocked` and `currency` are SEPARATE fields, so a project can be
// LOCKED while storing no currency at all — the state that produced a live
// defect: Company Settings could not pin such a project because the Firestore
// ratchet read '' → 'AUD' as a forbidden relabel.
//
// `currencyToPinOnLock` is the client-side half of the fix: it decides what
// `useProjects.lockProjectCurrency` writes ALONGSIDE `currencyLocked: true`, so
// the app stops MINTING locked-but-unpinned projects. The rules carve-out
// repairs the ones that already exist; this helper stops making more.
//
// The two invariants it must never break:
//   · It never relabels — a project that already stores a well-formed code is
//     left completely alone.
//   · It never freezes a GUESS — while the company has no configured base
//     currency, `resolveProjectCurrency` answers the DEFAULT_CURRENCY rendering
//     fallback, which nobody chose. Pinning that through a one-way ratchet
//     would make a possibly-wrong label permanent, so it declines and the
//     project stays repairable through Company Settings.

const CONFIGURED   = { id: 'c1', name: 'Apex Builders', countryCode: 'NZ', baseCurrency: 'NZD' }
const UNCONFIGURED = { id: 'c1', name: 'Apex Builders' }

// The live dataset that produced the defect: locked, financial records, and no
// stored currency of its own.
const LEGACY_LOCKED = { id: 'p_gold', name: 'Gold Coast apartments', budget: 1250000, currencyLocked: true }

describe('currencyToPinOnLock — a project that already carries a currency is untouched', () => {
  it('returns null for an explicitly pinned project, whatever the company says', () => {
    expect(currencyToPinOnLock({ currency: 'AUD' }, CONFIGURED)).toBeNull()
    expect(currencyToPinOnLock({ currency: 'AUD' }, UNCONFIGURED)).toBeNull()
    expect(currencyToPinOnLock({ currency: 'ZAR' }, CONFIGURED)).toBeNull()
  })

  it('an explicit AUD project stays AUD when the lock is staged', () => {
    // Nothing to pin ⇒ the lock write carries `currencyLocked` alone ⇒ the
    // stored 'AUD' is the currency both before and after.
    const project = { currency: 'AUD', currencyLocked: false }
    expect(currencyToPinOnLock(project, CONFIGURED)).toBeNull()
    expect(resolveProjectCurrency(project, CONFIGURED)).toBe('AUD')
    expect(resolveProjectCurrency({ ...project, currencyLocked: true }, CONFIGURED)).toBe('AUD')
  })

  it('an explicit currency beats the company base currency even when they differ', () => {
    // The whole point of pinning: a company currency change can never relabel a
    // pinned project.
    expect(resolveProjectCurrency({ currency: 'AUD' }, CONFIGURED)).toBe('AUD')
    expect(resolveCompanyCurrency(CONFIGURED)).toBe('NZD')
  })
})

describe('currencyToPinOnLock — an unpinned project is pinned to what it already displays', () => {
  it('returns the configured company base currency', () => {
    expect(currencyToPinOnLock({ currencyLocked: false }, CONFIGURED)).toBe('NZD')
    expect(currencyToPinOnLock(LEGACY_LOCKED, CONFIGURED)).toBe('NZD')
  })

  it('the pinned code is EXACTLY what the project was already being displayed in', () => {
    // This is why pinning changes nothing a user can see, and why it is safe to
    // do inside a one-way ratchet.
    const project = { budget: 1250000 }
    expect(currencyToPinOnLock(project, CONFIGURED)).toBe(resolveProjectCurrency(project, CONFIGURED))
  })

  it('treats a malformed or non-string stored currency as unpinned', () => {
    // Same shape test the Firestore rule applies, so client and boundary agree.
    for (const bad of ['', 'aud', 'AU', 'AUDD', ' AUD', 123, null, undefined, ['AUD']]) {
      expect(projectHasExplicitCurrency({ currency: bad })).toBe(false)
      expect(currencyToPinOnLock({ currency: bad }, CONFIGURED)).toBe('NZD')
    }
  })

  it('handles a missing project object without throwing', () => {
    expect(currencyToPinOnLock(null, CONFIGURED)).toBe('NZD')
    expect(currencyToPinOnLock(undefined, CONFIGURED)).toBe('NZD')
  })
})

describe('currencyToPinOnLock — an unconfigured company is never frozen into a guess', () => {
  it('returns null while the company has no base currency', () => {
    expect(isCompanyCurrencyConfigured(UNCONFIGURED)).toBe(false)
    expect(currencyToPinOnLock(LEGACY_LOCKED, UNCONFIGURED)).toBeNull()
    expect(currencyToPinOnLock({ currencyLocked: false }, UNCONFIGURED)).toBeNull()
    expect(currencyToPinOnLock({}, null)).toBeNull()
    expect(currencyToPinOnLock({}, undefined)).toBeNull()
  })

  it('declines even though display still falls back to AUD', () => {
    // The fallback is a RENDERING default, not a decision. Display keeps
    // working; the label is simply not made permanent.
    expect(resolveProjectCurrency(LEGACY_LOCKED, UNCONFIGURED)).toBe(DEFAULT_CURRENCY)
    expect(currencyToPinOnLock(LEGACY_LOCKED, UNCONFIGURED)).toBeNull()
  })

  it('a malformed company base currency counts as unconfigured', () => {
    for (const bad of ['', 'nzd', 'NZ', 'NZDD', 42, null]) {
      expect(currencyToPinOnLock({}, { baseCurrency: bad })).toBeNull()
    }
  })

  it('this is exactly the live Apex Builders state — Gold Coast stays repairable', () => {
    // Company country/base currency Not set, project locked with no currency.
    // Nothing is auto-pinned, so Company Settings is still the thing that
    // chooses the label — which is the product intent.
    expect(currencyToPinOnLock(LEGACY_LOCKED, UNCONFIGURED)).toBeNull()
  })
})

describe('currencyToPinOnLock — no conversion, no recalculation, no mutation', () => {
  it('never touches a monetary field', () => {
    const project = { name: 'Gold Coast apartments', budget: 1250000, progress: 40, currencyLocked: true }
    const company = { ...CONFIGURED }
    const before  = JSON.stringify(project)
    const pin     = currencyToPinOnLock(project, company)
    expect(pin).toBe('NZD')
    // Byte-identical: the amount that was entered is the amount that remains.
    expect(JSON.stringify(project)).toBe(before)
    expect(project.budget).toBe(1250000)
  })

  it('mutates neither argument, in either branch', () => {
    const pinned   = { currency: 'AUD', budget: 500 }
    const unpinned = { budget: 500 }
    const company  = { ...CONFIGURED }
    const snapshots = [JSON.stringify(pinned), JSON.stringify(unpinned), JSON.stringify(company)]
    currencyToPinOnLock(pinned, company)
    currencyToPinOnLock(unpinned, company)
    expect([JSON.stringify(pinned), JSON.stringify(unpinned), JSON.stringify(company)]).toEqual(snapshots)
  })

  it('is a pure function of its inputs — repeated calls agree', () => {
    expect(currencyToPinOnLock(LEGACY_LOCKED, CONFIGURED)).toBe('NZD')
    expect(currencyToPinOnLock(LEGACY_LOCKED, CONFIGURED)).toBe('NZD')
    expect(currencyToPinOnLock({ currency: 'AUD' }, CONFIGURED)).toBeNull()
    expect(currencyToPinOnLock({ currency: 'AUD' }, CONFIGURED)).toBeNull()
  })

  it('returns a currency CODE and nothing else — never a rate or an amount', () => {
    const pin = currencyToPinOnLock(LEGACY_LOCKED, CONFIGURED)
    expect(typeof pin).toBe('string')
    expect(pin).toMatch(/^[A-Z]{3}$/)
  })
})

describe('the lock stays monotonic and pinning does not disturb it', () => {
  it('a set flag reports locked with no financial records visible at all', () => {
    expect(isProjectCurrencyLocked(LEGACY_LOCKED, {})).toBe(true)
    expect(monetaryLockReasons({ project: { currencyLocked: true } })).toEqual([])
  })

  it('pinning a currency cannot make a locked project unlocked', () => {
    const pinned = { ...LEGACY_LOCKED, currency: currencyToPinOnLock(LEGACY_LOCKED, CONFIGURED) }
    expect(pinned.currency).toBe('NZD')
    expect(isProjectCurrencyLocked(pinned, {})).toBe(true)
  })

  it('once pinned, the helper declines forever — the pin can only happen once', () => {
    const pinned = { ...LEGACY_LOCKED, currency: 'AUD' }
    expect(currencyToPinOnLock(pinned, CONFIGURED)).toBeNull()
    // Even after the company base currency changes, which is the relabel the
    // pin exists to prevent.
    expect(currencyToPinOnLock(pinned, { baseCurrency: 'USD' })).toBeNull()
    expect(resolveProjectCurrency(pinned, { baseCurrency: 'USD' })).toBe('AUD')
  })

  it('live evidence alone still locks a project that has no flag', () => {
    const project = { id: 'p', budget: 0 }
    expect(isProjectCurrencyLocked(project, { budgetLines: [{ id: 'b' }] })).toBe(true)
    // And such a project is exactly the one lockProjectCurrency pins + locks.
    expect(currencyToPinOnLock(project, CONFIGURED)).toBe('NZD')
  })
})
