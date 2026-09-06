import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Subscription-hook pattern guard (ADR-41) ────────────────────────────────
//
// Every Firestore subscription hook in this app follows ONE shape — the
// keyed-snapshot / derived-loading pattern:
//
//   const [snap, setSnap] = useState({ key: null, <data>: …, error: false })
//
//   useEffect(() => {
//     if (!<target>) return undefined
//     const key = <target expression>
//     return onSnapshot(q,
//       (querySnap) => setSnap({ key, <data>: …, error: false }),
//       ()          => setSnap({ key, <data>: …, error: true }),
//     )
//   }, [<target deps>])
//
//   const targetKey = <same target expression, or null>
//   const settled   = targetKey !== null && snap.key === targetKey
//   <data>    = settled ? snap.<data> : <empty>
//   <loading> = targetKey !== null && !settled
//   <error>   = settled ? snap.error : false
//
// WHY THIS FILE EXISTS — three behavioural contracts, not a style preference:
//
//   1. NO SYNCHRONOUS setState IN AN EFFECT. The legacy shape called
//      setLoading(true) / setData([]) synchronously in the effect body, which
//      cascades renders and is what react-hooks/set-state-in-effect reports.
//
//   2. STALE ROWS ARE NEVER SHOWN UNDER A NEW TARGET. Because the snapshot
//      carries the key it belongs to, switching project cannot render the
//      previous project's rows under the new project's header.
//
//   3. A FAILED READ STAYS *UNAVAILABLE*, NEVER A ZERO. `error` is exposed
//      only once the CURRENT target has settled, so a denied financial read is
//      never presented as an empty, zero-value register (ADR-24) — and a
//      project switch never flashes a stale unavailable banner either.
//
// Contract 4 is the failure mode the pattern itself introduces: if the `key`
// built inside the effect and the `targetKey` built for the render ever
// DIVERGE, `settled` is permanently false and the page loads forever. That is
// the single most valuable assertion here.
//
// These assert SOURCE STRUCTURE, not rendered DOM: the unit runner is plain
// Node with no jsdom and no testing-library (the ADR-26 convention), and these
// are structural contracts, so a structural test catches them exactly.
//
// DELIBERATELY FORM-AGNOSTIC. Several compliant spellings exist in the repo and
// all of them are legitimate — the assertions below are written against the
// EXPRESSIONS, never against a declaration form or a whitespace layout:
//   · targets of one, two or three segments, plus the auth uid
//   · guards written `a && b ? … : null`, `a || null`, or a bare `?? null`
//   · derived data as a plain conditional OR wrapped in useMemo (when a write
//     callback depends on the live list)
//   · derivations declared as `const x = …` OR inline as `x: …` in the returned
//     object (useDrawings' second subscription does the latter)
//   · hooks that expose an error and hooks that deliberately do not
// A new legitimate variant should be taught to this file, never worked around
// by reshaping a hook that is already correct.

const HOOKS_DIR = fileURLToPath(new URL('../../src/hooks/', import.meta.url))

const read = (name) => readFileSync(HOOKS_DIR + name, 'utf8')

// Full-line `//` comments only. The prose above (and in the hooks) quotes the
// legacy `setLoading(true)` spelling on purpose; stripping comments keeps the
// assertions about CODE.
const stripComments = (src) =>
  src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

// Whitespace-insensitive, and `a?.b` compares equal to `a.b` — so a guard may
// use optional chaining where the effect (already past its null check) does not.
const normalise = (expr) => expr.replace(/\s+/g, '').replace(/\?\./g, '.')

const HOOK_FILES = readdirSync(HOOKS_DIR).filter(f => /^use.*\.jsx$/.test(f))

// A subscription hook is one that opens a Firestore onSnapshot listener.
// useAuth is NOT one (it listens to Firebase Auth via onAuthStateChanged) and
// is correctly absent from this set.
const SUBSCRIPTION_HOOKS = HOOK_FILES.filter(f => read(f).includes('onSnapshot('))

// The eleven hooks migrated by the Lint Zero increment. Listed explicitly so a
// revert to the legacy shape fails here rather than only in lint.
const MIGRATED = [
  'useCostCodes.jsx', 'useContacts.jsx',
  'useBudgetLines.jsx', 'useForecastLines.jsx', 'usePurchaseOrders.jsx',
  'useProgressClaims.jsx', 'useVariations.jsx', 'useSupplierInvoices.jsx',
  'useProjects.jsx', 'useCompany.jsx', 'useProfile.jsx',
]

// The six hooks whose data feeds a financial derivation. Each MUST expose an
// error flag, because a denied read of any of them must present as UNAVAILABLE
// rather than as a zero-value register (ADR-24).
const FINANCIAL = {
  'useBudgetLines.jsx':      'budgetLines',
  'useForecastLines.jsx':    'forecastLines',
  'usePurchaseOrders.jsx':   'purchaseOrders',
  'useProgressClaims.jsx':   'progressClaims',
  'useVariations.jsx':       'variations',
  'useSupplierInvoices.jsx': 'supplierInvoices',
}

describe('the subscription-hook set is what we think it is', () => {
  it('finds the subscription hooks', () => {
    expect(SUBSCRIPTION_HOOKS.length).toBeGreaterThanOrEqual(26)
  })

  it('every migrated hook is still a keyed subscription hook', () => {
    for (const f of MIGRATED) expect(SUBSCRIPTION_HOOKS).toContain(f)
  })

  it('useAuth is not in the set — it listens to Auth, not Firestore', () => {
    expect(SUBSCRIPTION_HOOKS).not.toContain('useAuth.jsx')
  })
})

// ── Contract 1: no synchronous setState in an effect ────────────────────────

describe('no subscription hook holds or sets loading as its own state', () => {
  for (const f of SUBSCRIPTION_HOOKS) {
    it(`${f}: has no set*Loading setter and no useState(true)`, () => {
      const code = stripComments(read(f))
      expect(code).not.toMatch(/\bset[A-Za-z]*Loading\s*\(/)
      expect(code).not.toMatch(/useState\(\s*true\s*\)/)
    })

    it(`${f}: every useState is the keyed snapshot tuple`, () => {
      const code = stripComments(read(f))
      const decls = [...code.matchAll(/const \[(\w+), (\w+)\] = useState\(([^\n]*)/g)]
      expect(decls.length).toBeGreaterThan(0)
      for (const [, value, setter, init] of decls) {
        expect(value).toBe('snap')
        expect(setter).toBe('setSnap')
        expect(normalise(init)).toMatch(/^\{key:null,/)
      }
    })

    it(`${f}: the effect body writes no state before subscribing, and idles with \`return undefined\``, () => {
      const code = stripComments(read(f))
      let from = 0
      let found = 0
      for (;;) {
        const sub = code.indexOf('onSnapshot(', from)
        if (sub === -1) break
        const effect = code.lastIndexOf('useEffect(() => {', sub)
        expect(effect).toBeGreaterThan(-1)
        const head = code.slice(effect, sub)
        // State is written ONLY from the async callbacks — never synchronously
        // on the way into the subscription.
        expect(head).not.toContain('setSnap(')
        // The idle path returns undefined rather than clearing state.
        expect(head).toContain('return undefined')
        found += 1
        from = sub + 1
      }
      expect(found).toBeGreaterThan(0)
    })
  }
})

// ── Contract 4: the effect key and the render target key cannot drift ───────

describe('the effect key and the render target key stay in step', () => {
  for (const f of SUBSCRIPTION_HOOKS) {
    it(`${f}: each \`const key =\` expression appears in its \`targetKey\``, () => {
      const lines = stripComments(read(f)).split('\n')

      const keys = lines
        .map(l => l.match(/^\s*const key = (.+)$/))
        .filter(Boolean)
        .map(m => normalise(m[1]))

      // A targetKey statement may span several lines; it always ends where the
      // `settled` derivation begins.
      const targets = []
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*const targetKey\s*=/.test(lines[i])) continue
        let stmt = lines[i]
        for (let j = i + 1; j < lines.length && !/^\s*const settled\b/.test(lines[j]); j++) {
          stmt += ' ' + lines[j]
        }
        targets.push(normalise(stmt.replace(/^\s*const targetKey\s*=/, '')))
      }

      expect(keys.length).toBeGreaterThan(0)
      expect(targets).toHaveLength(keys.length)
      keys.forEach((key, i) => {
        // Containment, not equality: the guard around the expression may be
        // written several legitimate ways, but the TARGET EXPRESSION itself
        // must be the same one the subscription keyed its snapshot with.
        expect(targets[i]).toContain(key)
      })
    })

    it(`${f}: settled is derived from the current target`, () => {
      const code = normalise(stripComments(read(f)))
      const targetCount = (code.match(/consttargetKey=/g) || []).length
      const settledCount =
        (code.match(/constsettled=targetKey!==null&&snap\.key===targetKey/g) || []).length
      expect(settledCount).toBe(targetCount)
    })
  }
})

// ── Contracts 2 and 3: derived data, loading and error ──────────────────────

describe('loading, data and error are derived from settlement', () => {
  for (const f of SUBSCRIPTION_HOOKS) {
    const code = () => normalise(stripComments(read(f)))

    it(`${f}: loading is always \`targetKey !== null && !settled\``, () => {
      const c = code()
      const uses = (c.match(/!settled/g) || []).length
      const correct = (c.match(/targetKey!==null&&!settled/g) || []).length
      expect(uses).toBeGreaterThan(0)
      // Form-agnostic: holds whether written as `const xLoading = …` or inline
      // as `xLoading: …` in the returned object.
      expect(correct).toBe(uses)
    })

    it(`${f}: error is exposed only after the current target has settled`, () => {
      const c = code()
      const uses = (c.match(/snap\.error/g) || []).length
      const correct = (c.match(/settled\?snap\.error:false/g) || []).length
      // A hook need not expose an error at all; if it does, it must be gated on
      // `settled` — so a failed read is UNAVAILABLE, never a fabricated zero,
      // and a target switch never flashes the previous target's error.
      expect(correct).toBe(uses)
    })

    it(`${f}: stale data is hidden until the current target settles`, () => {
      // Newlines are kept here: a fallback runs to the end of its expression,
      // and collapsing the file to one line would let the match run on into
      // the next statement.
      const c = stripComments(read(f))
      // The settled snapshot may be handed straight to consumers, or passed
      // through a PURE presentation helper first (useProjectDocuments sorts).
      // Both are compliant — what matters is the fallback while unsettled.
      const reads = [...c.matchAll(/settled \? (?:\w+\()?snap\.(\w+)\)? : ([^\n,]*)/g)]
        .filter(m => m[1] !== 'error')
      expect(reads.length).toBeGreaterThan(0)
      for (const [, , raw] of reads) {
        // Trailing `)` closes a useMemo/arrow wrapper, not the fallback.
        const fallback = raw.trim().replace(/\)+$/, '')
        // Until the CURRENT target reports, consumers see the empty value —
        // never the previous target's rows.
        expect(['[]', 'null']).toContain(fallback)
      }
    })
  }
})

// ── The financial invariant, named hook by named hook ───────────────────────

describe('every financial subscription hook exposes a settled-gated error', () => {
  for (const [f, name] of Object.entries(FINANCIAL)) {
    it(`${f}: derives and returns \`${name}Error\``, () => {
      const code = stripComments(read(f))
      expect(code).toContain(`const ${name}Error = settled ? snap.error : false`)
      // And it reaches consumers — a derivation nobody returns cannot keep a
      // denied read from rendering as a zero.
      const returned = code.match(/\n {2}return \{[^}]*\}/)
      expect(returned).not.toBeNull()
      expect(returned[0]).toContain(`${name}Error`)
    })
  }
})
