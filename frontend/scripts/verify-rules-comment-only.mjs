#!/usr/bin/env node
// ── ADR-69 — executable-source equivalence check for a comment-only rules change ──
//
// Proves that two Firestore rules files differ ONLY in whole-line comments:
// every line whose trimmed content begins with `//` is dropped from BOTH files,
// and the remaining ordered lines — executable statements, blank lines, and
// lines carrying inline (end-of-line) comments — must be BYTE-FOR-BYTE
// identical. Nothing is normalised: no whitespace trimming, no expression
// reformatting. A single differing byte fails the check (exit 1).
//
// Reproducible from the repository alone — the originals come from Git:
//
//   node scripts/verify-rules-comment-only.mjs --base 634e69c
//
// retrieves `frontend/firestore.rules` AND `frontend/firestore.transitional.rules`
// as they stood at that commit (`git show <commit>:<path>`) and verifies the
// working copy of each against it; both must be equivalent for exit 0.
//
// The two-path form compares any pair of files on disk:
//
//   node scripts/verify-rules-comment-only.mjs <original.rules> <cleaned.rules>
//
// Used for the capacity recovery of ADR-69 (docs/PROJECT_DECISIONS.md) and
// reusable for any future comment-only trim; it is NOT a substitute for
// `npm run test:rules`.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')
const REPO = resolve(FRONTEND, '..')
export const RULES_FILES = ['frontend/firestore.rules', 'frontend/firestore.transitional.rules']

const isWholeLineComment = (line) => line.trimStart().startsWith('//')

export function executableLines(source) {
  return source.split('\n').filter((line) => !isWholeLineComment(line))
}

export function compareExecutable(originalSource, cleanedSource) {
  const a = executableLines(originalSource)
  const b = executableLines(cleanedSource)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) {
      return { ok: false, index: i, original: a[i], cleaned: b[i], originalCount: a.length, cleanedCount: b.length }
    }
  }
  return { ok: true, count: a.length }
}

// The file exactly as committed at `commit` (bytes, not a checkout).
export function fileAtCommit(commit, repoPath) {
  return execFileSync('git', ['show', `${commit}:${repoPath}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')

function report(label, original, cleaned) {
  const result = compareExecutable(original, cleaned)
  if (!result.ok) {
    console.error(`${label}: EXECUTABLE SOURCE DIFFERS at retained line ${result.index + 1}`)
    console.error(`  original (${result.originalCount} retained lines): ${JSON.stringify(result.original)}`)
    console.error(`  cleaned  (${result.cleanedCount} retained lines): ${JSON.stringify(result.cleaned)}`)
    return false
  }
  console.log(`${label}: EQUIVALENT — ${result.count} retained non-comment lines are byte-identical`)
  console.log(`  original ${bytes(original)} bytes → cleaned ${bytes(cleaned)} bytes (recovered ${bytes(original) - bytes(cleaned)})`)
  return true
}

const isMain = process.argv[1] && process.argv[1].endsWith('verify-rules-comment-only.mjs')

if (isMain) {
  const args = process.argv.slice(2)
  const usage = () => {
    console.error('usage: node scripts/verify-rules-comment-only.mjs --base <commit>')
    console.error('       node scripts/verify-rules-comment-only.mjs <original.rules> <cleaned.rules>')
    process.exit(2)
  }
  let ok = true
  if (args[0] === '--base') {
    const commit = args[1]
    if (!commit || args.length !== 2) usage()
    for (const repoPath of RULES_FILES) {
      const original = fileAtCommit(commit, repoPath)
      const cleaned = readFileSync(resolve(REPO, repoPath), 'utf8')
      ok = report(`${repoPath} vs ${commit}`, original, cleaned) && ok
    }
  } else if (args.length === 2) {
    ok = report(`${args[0]} vs ${args[1]}`, readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8'))
  } else {
    usage()
  }
  process.exit(ok ? 0 : 1)
}
