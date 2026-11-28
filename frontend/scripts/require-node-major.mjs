#!/usr/bin/env node
// ── Runtime gate (Phase 2 step 0) ────────────────────────────────────────────
//
// Production Cloud Functions run on Node 22 (firebase.json → "runtime":
// "nodejs22"). The Functions emulator uses whatever `node` is first on PATH, so
// an acceptance run only proves Node 22 behaviour if it was started under
// Node 22. This script exits 1 unless the running Node is the major version
// asked for — it never switches versions and changes nothing on the machine.
//
//   npm run test:functions:node22      emulator suite, refused unless on Node 22
//   npm run functions:test:node22      pure Functions suite, likewise
//
// (The frontend's own development runtime — Node 24 — is unchanged.)

const wanted = Number(process.argv[2])
const actual = Number(process.versions.node.split('.')[0])
if (!Number.isInteger(wanted) || wanted < 1) {
  console.error('usage: node scripts/require-node-major.mjs <major>')
  process.exit(2)
}
if (actual !== wanted) {
  console.error(`This command must run under Node ${wanted}; the current runtime is Node ${process.versions.node}.`)
  console.error(`Put a Node ${wanted} installation first on PATH for this command only, e.g.`)
  console.error(`  PATH="$HOME/.nvm/versions/node/<v${wanted}.x.y>/bin:$PATH" npm run <script>`)
  process.exit(1)
}
console.log(`runtime gate: Node ${process.versions.node} (major ${wanted})`)
