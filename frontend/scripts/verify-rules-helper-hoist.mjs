#!/usr/bin/env node
// ── ADR-85 — equivalence check for the LIFECYCLE-HELPER HOIST ────────────────
//
// The third rules capacity recovery replaced runs of BYTE-IDENTICAL conjuncts
// that were repeated across the financial blocks with calls to seven shared
// helpers, and one inline membership predicate with the existing
// `financialMember(companyId)`. This script proves the change is exactly that
// and nothing else. For a base file and a changed file it:
//
//   1 · reads the body of each hoisted helper FROM THE CHANGED FILE (so the
//       proof covers the helper text actually shipped, not a copy held here);
//   2 · removes the helper block;
//   3 · expands every call site `&& helper()` back into the helper's own
//       conjuncts, in the helper's order, at the position of the call;
//   4 · expands the one `financialMember(companyId)` substitution in the
//       per-project counters block from that function's own body;
//   5 · compares the result with the base file line by line, ignoring only
//       whitespace runs — every executable token, comment and literal must
//       match, in the same order.
//
// No conjunct is reordered by the hoist (each call site replaced a CONTIGUOUS
// run in the helper's order), so the proof never relies on `&&` being
// commutative. A helper call adds one call expression per site against
// Firestore's 1000-expression ceiling; `npm run test:rules` running with zero
// evaluation errors is the regression signal for that, and this script is NOT a
// substitute for it.
//
//   node scripts/verify-rules-helper-hoist.mjs --base <commit>
//   node scripts/verify-rules-helper-hoist.mjs <original.rules> <hoisted.rules>

import { readFileSync } from 'node:fs'
import { fileAtCommit } from './verify-rules-comment-only.mjs'

export const HOISTED_HELPERS = [
  'createStamped', 'currencyShaped', 'docCoreFrozen', 'lifecycleUnstamped',
  'lifecycleStampsFrozen', 'postedHere', 'voidedWithReason',
]

export const HELPER_BLOCK_START = '// ── Lifecycle helpers (ADR-85)'

const COUNTERS_MATCH = 'match /companies/{companyId}/projects/{projectId}/counters/{counterId} {'
const COUNTERS_CALL = 'allow read, create, update: if financialMember(companyId);'

const collapse = (line) => line.trim().replace(/\s+/g, ' ')

// The conjuncts of `function name(...) { return a && b && c; }`, one per source
// line, without the leading `return ` / `&& ` and the trailing `;`.
export function helperConjuncts(lines, name) {
  const start = lines.findIndex(l => collapse(l).startsWith(`function ${name}(`))
  if (start < 0) throw new Error(`helper ${name} not found`)
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const c = collapse(lines[i])
    if (c === '}') return { start, end: i, conjuncts: out }
    if (c.startsWith('//')) throw new Error(`comment inside helper ${name}`)
    let body = c
    if (out.length === 0) {
      if (!body.startsWith('return ')) throw new Error(`helper ${name} does not start with return`)
      body = body.slice('return '.length)
    } else {
      if (!body.startsWith('&& ')) throw new Error(`helper ${name} is not a pure && chain`)
      body = body.slice(3)
    }
    out.push(body.endsWith(';') ? body.slice(0, -1) : body)
  }
  throw new Error(`helper ${name} is not closed`)
}

// Rebuilds the pre-hoist text from the hoisted file.
export function expandHoist(changedSource) {
  const lines = changedSource.split('\n')

  const bodies = {}
  for (const name of HOISTED_HELPERS) bodies[name] = helperConjuncts(lines, name).conjuncts
  const member = helperConjuncts(lines, 'financialMember').conjuncts

  // Remove the helper block: its header comment through the last helper's `}`.
  const blockStart = lines.findIndex(l => collapse(l).startsWith(HELPER_BLOCK_START))
  if (blockStart < 0) throw new Error('helper block header not found')
  const blockEnd = Math.max(...HOISTED_HELPERS.map(n => helperConjuncts(lines, n).end))
  for (let i = blockStart; i <= blockEnd; i += 1) {
    const c = collapse(lines[i])
    const inHelper = HOISTED_HELPERS.some(n => {
      const h = helperConjuncts(lines, n)
      return i >= h.start && i <= h.end
    })
    if (!inHelper && c !== '' && !c.startsWith('//')) {
      throw new Error(`unexpected executable line inside the helper block: ${c}`)
    }
  }
  const kept = [...lines.slice(0, blockStart), ...lines.slice(blockEnd + 1)]

  const out = []
  let inProjectCounters = false
  let calls = 0
  for (const line of kept) {
    const c = collapse(line)
    if (c.startsWith('match ')) inProjectCounters = c === COUNTERS_MATCH

    if (inProjectCounters && c === COUNTERS_CALL) {
      member.forEach((conjunct, i) => {
        const head = i === 0 ? 'allow read, create, update: if ' : '&& '
        out.push(head + conjunct + (i === member.length - 1 ? ';' : ''))
      })
      calls += 1
      continue
    }

    const call = /^&& (\w+)\(\)(;?)$/.exec(c)
    if (call && HOISTED_HELPERS.includes(call[1])) {
      const body = bodies[call[1]]
      body.forEach((conjunct, i) => {
        out.push(`&& ${conjunct}${i === body.length - 1 ? call[2] : ''}`)
      })
      calls += 1
      continue
    }

    // A hoisted helper may be called ONLY as a whole `&& helper()` line.
    for (const name of HOISTED_HELPERS) {
      if (new RegExp(`\\b${name}\\(`).test(c)) throw new Error(`unexpandable use of ${name}: ${c}`)
    }
    out.push(c)
  }
  return { lines: out, calls }
}

export function compareHoist(originalSource, changedSource) {
  let expanded
  try {
    expanded = expandHoist(changedSource)
  } catch (err) {
    return { ok: false, reason: err.message }
  }
  // `financialMember(companyId)` in the counters call takes the SAME wildcard the
  // inline predicate compared against, so the substitution is textual.
  const a = originalSource.split('\n').map(collapse)
  const b = expanded.lines
  if (a.length !== b.length) {
    return { ok: false, reason: `line count differs after expansion (${a.length} → ${b.length})` }
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return { ok: false, reason: 'content differs after expansion', line: i + 1, original: a[i], changed: b[i] }
    }
  }
  return { ok: true, lines: a.length, calls: expanded.calls }
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')

function report(label, original, changed) {
  const result = compareHoist(original, changed)
  if (!result.ok) {
    console.error(`FAIL ${label}: ${result.reason}`)
    if (result.line) {
      console.error(`  expanded line ${result.line}`)
      console.error(`  original: ${result.original}`)
      console.error(`  expanded: ${result.changed}`)
    }
    return false
  }
  console.log(
    `OK   ${label}: ${result.calls} helper call sites expand to the original text ` +
    `(${result.lines} lines compared; ${bytes(original)} → ${bytes(changed)} bytes)`,
  )
  return true
}

const HOIST_FILES = [
  'frontend/firestore.rules',
  'frontend/firestore.transitional.rules',
  'frontend/firestore.m2a2-transitional.rules',
]

const isMain = process.argv[1] && process.argv[1].endsWith('verify-rules-helper-hoist.mjs')

if (isMain) {
  const args = process.argv.slice(2)
  let ok = true
  if (args[0] === '--base' && args[1]) {
    for (const repoPath of HOIST_FILES) {
      const original = fileAtCommit(args[1], repoPath)
      const changed = readFileSync(new URL(`../../${repoPath}`, import.meta.url), 'utf8')
      ok = report(repoPath, original, changed) && ok
    }
  } else if (args.length === 2) {
    ok = report(args[1], readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8'))
  } else {
    console.error('usage: verify-rules-helper-hoist.mjs --base <commit> | <original.rules> <hoisted.rules>')
    process.exit(2)
  }
  process.exit(ok ? 0 : 1)
}
