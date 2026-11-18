#!/usr/bin/env node
// ── ADR-76 — equivalence check for a LEADING-WHITESPACE-ONLY rules change ────
//
// Proves that two Firestore rules files differ ONLY in the spaces at the START
// of their lines. For every line, in order:
//
//   · the line count of both files is the same (no line added, removed, joined
//     or split);
//   · the content after the leading spaces is BYTE-FOR-BYTE identical —
//     executable tokens, whole-line comments, inline comments, string literals,
//     interior spacing and trailing bytes are all compared, nothing normalised;
//   · the leading run is spaces only in both files (no tab introduced);
//   · a blank line stays blank, and a non-blank line is never indented deeper.
//
// The Rules language is not indentation-sensitive, and no token spans a line
// break in these files, so a change that passes cannot alter what the ruleset
// evaluates. Any other difference fails the check (exit 1).
//
// Reproducible from the repository alone — the originals come from Git:
//
//   node scripts/verify-rules-whitespace-only.mjs --base 2d5787c
//
// retrieves `frontend/firestore.rules` AND `frontend/firestore.transitional.rules`
// as they stood at that commit and verifies the working copy of each; both must
// pass for exit 0. The two-path form compares any pair of files on disk:
//
//   node scripts/verify-rules-whitespace-only.mjs <original.rules> <reindented.rules>
//
// A reviewer's proof for the ADR-76 capacity recovery; it is NOT a substitute
// for `npm run test:rules`.

import { readFileSync } from 'node:fs'
import { fileAtCommit, RULES_FILES } from './verify-rules-comment-only.mjs'

const leading = (line) => line.length - line.replace(/^[ \t]+/, '').length

export function compareIgnoringLeadingWhitespace(originalSource, changedSource) {
  const a = originalSource.split('\n')
  const b = changedSource.split('\n')
  if (a.length !== b.length) {
    return { ok: false, reason: `line count differs (${a.length} → ${b.length})` }
  }
  let changedLines = 0
  for (let i = 0; i < a.length; i += 1) {
    const la = leading(a[i])
    const lb = leading(b[i])
    const fail = (reason) => ({ ok: false, reason, line: i + 1, original: a[i], changed: b[i] })
    if (a[i].slice(la) !== b[i].slice(lb)) return fail('content after the leading whitespace differs')
    if (a[i].slice(0, la).includes('\t') || b[i].slice(0, lb).includes('\t')) return fail('a tab in the leading whitespace')
    if (a[i].length === la && a[i] !== b[i]) return fail('a blank line changed')
    if (lb > la) return fail('a line is indented deeper than the original')
    if (la !== lb) changedLines += 1
  }
  return { ok: true, lines: a.length, changedLines }
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')

function report(label, original, changed) {
  const result = compareIgnoringLeadingWhitespace(original, changed)
  if (!result.ok) {
    console.error(`${label}: NOT EQUIVALENT — ${result.reason}${result.line ? ` at line ${result.line}` : ''}`)
    if (result.line) {
      console.error(`  original: ${JSON.stringify(result.original)}`)
      console.error(`  changed:  ${JSON.stringify(result.changed)}`)
    }
    return false
  }
  console.log(`${label}: EQUIVALENT — ${result.lines} lines identical after their leading spaces (${result.changedLines} re-indented)`)
  console.log(`  original ${bytes(original)} bytes → changed ${bytes(changed)} bytes (recovered ${bytes(original) - bytes(changed)})`)
  return true
}

const isMain = process.argv[1] && process.argv[1].endsWith('verify-rules-whitespace-only.mjs')

if (isMain) {
  const args = process.argv.slice(2)
  let ok = true
  if (args[0] === '--base' && args.length === 2) {
    for (const repoPath of RULES_FILES) {
      const original = fileAtCommit(args[1], repoPath)
      const changed = readFileSync(new URL(`../../${repoPath}`, import.meta.url), 'utf8')
      ok = report(repoPath, original, changed) && ok
    }
  } else if (args.length === 2 && args[0] !== '--base') {
    ok = report(args[1], readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8'))
  } else {
    console.error('usage: node scripts/verify-rules-whitespace-only.mjs --base <commit>')
    console.error('       node scripts/verify-rules-whitespace-only.mjs <original.rules> <reindented.rules>')
    process.exit(2)
  }
  process.exit(ok ? 0 : 1)
}
