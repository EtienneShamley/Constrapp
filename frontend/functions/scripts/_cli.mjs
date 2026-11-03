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
