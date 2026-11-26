#!/usr/bin/env node
// ── D3 #37 — expression-headroom probe for the Firestore ruleset ─────────────
//
// Firestore evaluates at most 1,000 expressions per request and the emulator
// reports the ceiling only when it is reached; no supported tool prints how
// many expressions an ALLOWED request used. This script measures headroom
// instead of guessing it: it writes a copy of a ruleset in which every `allow`
// statement must additionally evaluate a helper made of K trivially-true
// comparisons AFTER its real condition has passed:
//
//     allow update: if <condition>;   →   allow update: if (<condition>) && burn();
//
// A request the real rules REFUSE never reaches `burn()` (the padding is the
// last conjunct), so refusals are unaffected. A request they ALLOW now costs K
// more comparisons. Running the emulator suite against the padded file
// therefore answers one question exactly: does every allowed request the suite
// exercises still fit with K extra comparisons? A test that expected success
// and now fails names an operation with less than K comparisons of headroom.
//
// The padded file is a MEASURING INSTRUMENT. It is never published and never
// committed; write it outside the repository.
//
//   node scripts/rules-expression-headroom.mjs <source.rules> <out.rules> <K>
//   node scripts/rules-expression-headroom.mjs --calibrate <out.rules> <K>
//
// `--calibrate` writes a minimal ruleset whose only rule is `burn()`, used to
// find how many comparisons fit in one request on this engine version.

import { readFileSync, writeFileSync } from 'node:fs'

// One `&&` chain of hundreds of terms is refused by the compiler ("Expression is
// too complex to evaluate safely"), so the K comparisons are grouped: burn10()
// is ten comparisons, burn100() ten calls of it, and burn() the mix that adds
// up to K. The function calls are themselves evaluated expressions, so K
// comparisons cost slightly MORE than K — the probe never overstates headroom.
export const burnFunction = (k) => {
  const chain = (n, term) => Array.from({ length: n }, () => term)
  const terms = [
    ...chain(Math.floor(k / 100), 'burn100()'),
    ...chain(Math.floor((k % 100) / 10), 'burn10()'),
    ...chain(k % 10, '1 == 1'),
  ]
  return `    function burn10() { return ${chain(10, '1 == 1').join(' && ')}; }\n`
       + `    function burn100() { return ${chain(10, 'burn10()').join(' && ')}; }\n`
       + `    function burn() { return ${terms.length ? terms.join(' && ') : 'true'}; }\n`
}

export function padRules(source, k) {
  const anchor = '  match /databases/{database}/documents {\n'
  if (source.split(anchor).length !== 2) throw new Error('database match line not found exactly once')
  // An `allow` condition ends at the first `;` that is neither inside a
  // `//` comment nor inside a string literal — comments in this file do
  // contain semicolons.
  let statements = 0
  let padded = ''
  let i = 0
  const head = /allow [a-z, ]+: if /g
  for (;;) {
    head.lastIndex = i
    const m = head.exec(source)
    if (!m) { padded += source.slice(i); break }
    let j = head.lastIndex
    let quote = null
    while (j < source.length) {
      const ch = source[j]
      if (quote) { if (ch === '\\') j += 1; else if (ch === quote) quote = null }
      else if (ch === "'" || ch === '"') quote = ch
      else if (ch === '/' && source[j + 1] === '/') { j = source.indexOf('\n', j); continue }
      else if (ch === ';') break
      j += 1
    }
    // The closing parenthesis goes on its own line so a trailing `//` comment
    // on the last condition line cannot swallow it.
    padded += `${source.slice(i, head.lastIndex)}(${source.slice(head.lastIndex, j)}\n) && burn();`
    statements += 1
    i = j + 1
  }
  return { source: padded.replace(anchor, anchor + burnFunction(k)), statements }
}

export const calibrationRules = (k) =>
  `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${burnFunction(k)}` +
  '    match /probe/{id} { allow read: if burn(); }\n  }\n}\n'

const isMain = process.argv[1] && process.argv[1].endsWith('rules-expression-headroom.mjs')
if (isMain) {
  const [a, b, c] = process.argv.slice(2)
  const k = Number(c)
  if (!b || !Number.isInteger(k) || k < 0) {
    console.error('usage: rules-expression-headroom.mjs <source.rules>|--calibrate <out.rules> <K>')
    process.exit(2)
  }
  if (a === '--calibrate') {
    writeFileSync(b, calibrationRules(k))
    console.log(`wrote calibration ruleset with ${k} comparisons`)
  } else {
    const { source, statements } = padRules(readFileSync(a, 'utf8'), k)
    writeFileSync(b, source)
    console.log(`padded ${statements} allow statements with ${k} comparisons each → ${b}`)
  }
}
