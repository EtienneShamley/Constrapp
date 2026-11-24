// ── Shared CLI plumbing for the operator scripts (ADR-72) ────────────────────
//
// Operator scripts run with the OPERATOR'S OWN credentials (Application
// Default Credentials from `gcloud auth application-default login`) against a
// project named EXPLICITLY on the command line. No service-account key file
// is ever read from the repository, and a script never guesses a project.
// Against the emulators (FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST
// set) no credential is needed at all.

export function parseArgs(argv, spec) {
  const out = {}
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`)
    const key = a.slice(2)
    const def = spec[key]
    if (!def) throw new Error(`Unknown option --${key}`)
    if (def.flag) { out[key] = true; continue }
    const v = args.shift()
    if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`)
    out[key] = v
  }
  for (const [key, def] of Object.entries(spec)) {
    if (def.required && out[key] === undefined) throw new Error(`--${key} is required`)
    if (out[key] !== undefined && def.pattern && !def.pattern.test(out[key])) throw new Error(`--${key} is not valid (${def.help})`)
  }
  return out
}

export function usage(name, spec) {
  const lines = Object.entries(spec).map(([k, d]) => `  --${k}${d.flag ? '' : ' <value>'}${d.required ? ' (required)' : ''}  ${d.help}`)
  return `Usage: node ${name} [options]\n${lines.join('\n')}`
}

export function configureProject(project) {
  const emulated = !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!emulated && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
    throw new Error('Set BOTH FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST for emulator use, or neither.')
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is set. Operator scripts use your own ADC login (gcloud auth application-default login), never a key file.')
  }
  process.env.GCLOUD_PROJECT = project
  process.env.GOOGLE_CLOUD_PROJECT = project
  return { emulated }
}

export const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn('⚠', ...a),
  error: (...a) => console.error('✖', ...a),
}

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

// ── Process lifecycle (operator tooling safety, D3 #3) ───────────────────────
//
// An operator script must never end with `process.exit()` once it has used
// the Firestore SDK. The SDK sends a failed transaction's rollback WITHOUT
// awaiting it (@google-cloud/firestore Transaction.rollback); exiting at once
// drops that request, and the documents the transaction read — the company
// membership lock among them — stay locked until Firestore expires the
// transaction (measured on the emulator: about a minute).
//
// `runOperatorScript` instead lets `main()` settle, sets `process.exitCode`,
// then awaits `Firestore.terminate()` — which waits for every in-flight
// request, that rollback included, and closes the channels. Only if that
// shutdown does not finish within RELEASE_TIMEOUT_MS does it force the exit,
// so a stuck connection can never hang an operator's terminal.
//
// The timeout clock starts only AFTER main() has settled — a long operation
// is never cut short by it. A cleanup that fails or times out is reported as
// an explicit FAILURE (never as a clean shutdown); the exit code stays the
// operation's own (0 / 1 / 2 / 3), because it describes what happened to the
// data, and the report says what the failed cleanup may have left behind.
// `firebase-admin`'s deleteApp() is NOT a substitute: its Firestore service
// has no delete hook, so it never terminates the client.
//
// Nothing here retries anything: a refused or failed mutation is reported
// once and the script ends.

export const EXIT = { OK: 0, REFUSED: 1, USAGE: 2 }
export const RELEASE_TIMEOUT_MS = 30_000

// A bad command line. Thrown before any SDK is touched; exits 2 with usage.
export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError' }
}

const releasers = []
// Register a shutdown step (e.g. `() => db.terminate()`), run once at the end.
export function releaseOnExit(fn) { releasers.push(fn) }

// Runs every shutdown step once. Returns 'complete', 'failed' (a step threw)
// or 'timed-out'. Started only after main() has settled.
async function releaseAll(timeoutMs) {
  let timer
  const timedOut = new Promise((r) => { timer = setTimeout(() => r('timed-out'), timeoutMs) })
  const done = (async () => {
    let failed = false
    for (const fn of releasers.splice(0).reverse()) {
      try { await fn() } catch (e) { failed = true; log.error(`Cleanup FAILED: the SDK did not shut down cleanly (${e?.message ?? e}).`) }
    }
    return failed ? 'failed' : 'complete'
  })()
  const outcome = await Promise.race([done, timedOut])
  clearTimeout(timer)
  return outcome
}

// `main` returns the exit code (undefined = 0) or throws. `onError` maps an
// unexpected error to a code after reporting it (default: print, exit 1).
// `usageText` and `out` print the usage on a UsageError (reconcile's JSON
// mode keeps stdout for the JSON line, so it passes its own `out`).
export async function runOperatorScript(main, { usageText = null, out = console.log, onError = null, releaseTimeoutMs = RELEASE_TIMEOUT_MS } = {}) {
  let code
  try {
    const r = await main()
    code = r === undefined ? EXIT.OK : r
  } catch (e) {
    if (e instanceof UsageError) {
      log.error(e.message)
      if (usageText) out(usageText)
      code = EXIT.USAGE
    } else if (onError) {
      code = onError(e)
    } else {
      log.error(e?.message ?? e)
      code = EXIT.REFUSED
    }
  }
  // Set BEFORE the shutdown: if the event loop empties while terminate() is
  // still pending, Node exits with this code rather than 0.
  process.exitCode = code
  const cleanup = await releaseAll(releaseTimeoutMs)
  if (cleanup !== 'complete') {
    log.error(`Cleanup ${cleanup === 'timed-out' ? `did NOT complete within ${Math.round(releaseTimeoutMs / 1000)} s — the process is being terminated` : 'is INCOMPLETE'}. The result above stands (exit ${code}); nothing was retried.`)
    log.error('A request still in flight — such as the rollback of a transaction refused just before — may not have reached Firestore: the documents it read can stay locked until Firestore expires the transaction (about a minute). Wait before running another membership operation for this company.')
    if (cleanup === 'timed-out') process.exit(code)
  }
  return code
}

// ── Shared by the external-member scripts (ADR-84) ───────────────────────────

export const ID_LIST_PATTERN = /^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64})*$/
export const parseIdList = (v) => (v === undefined ? undefined : v.split(','))

// A refusal from the library (lib/errors.js), as one line for the operator.
// Only the stable code and the ids involved — never a raw exception dump.
export function describeRefusal(err) {
  const d = err?.details
  if (!d?.code) return null
  const ids = d.projectIds ?? (d.projectId ? [d.projectId] : [])
  const extra = [d.reason, d.what, d.field, ids.length ? `project id(s): ${ids.join(', ')}` : null, d.inviteId ? `invitation ${d.inviteId}` : null].filter(Boolean)
  return `${d.code}${extra.length ? ` — ${extra.join(' · ')}` : ''}`
}
