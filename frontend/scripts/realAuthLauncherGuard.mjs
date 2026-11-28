// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed guard for the three OLDER manual-acceptance launchers
// (tracker D3 #40): `test:boq`, `test:quant`, `test:credit-notes`.
//
// Those launchers emulate Firestore (and Storage) but NOT Auth: they run the
// emulators under the REAL project id from frontend/.env.local, and the tester
// signs in against the REAL Firebase Auth project. They are outside the
// credential isolation of scripts/emulatorIsolation.mjs (D3 #17 is closed only
// for test:rules, test:functions and test:team).
//
// So they must never start by accident — not in ordinary development and never
// in automated acceptance. This guard refuses to start them unless the
// operator names, in the environment, the exact project they are about to
// sign in to:
//
//     CONSTRAP_REAL_AUTH_LAUNCHER=<project id> npm run test:boq
//
// It refuses outright under CI (CI / TF_BUILD / GITHUB_ACTIONS), whatever is
// set. It reads no credential and changes nothing; it only decides whether the
// launcher may continue. A separately authorised acceptance session keeps
// working by setting the variable for that one command.
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIRM_VARIABLE = 'CONSTRAP_REAL_AUTH_LAUNCHER'
export const CI_VARIABLES = ['CI', 'TF_BUILD', 'GITHUB_ACTIONS']

/**
 * Pure decision. Returns null when the launcher may start, otherwise the
 * reason it must not.
 */
export function realAuthLauncherRefusal({ env = {}, projectId, launcher }) {
  const ci = CI_VARIABLES.find(name => String(env[name] ?? '').length > 0 && String(env[name]).toLowerCase() !== 'false')
  if (ci) {
    return `${launcher} signs in against REAL Firebase Auth and is never run in automated environments (${ci} is set). ` +
      'Automated acceptance uses npm run test:rules / test:functions / test:team, which are credential-isolated.'
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return `${launcher}: no Firebase project id was found in frontend/.env.local.`
  }
  const confirmed = String(env[CONFIRM_VARIABLE] ?? '')
  if (confirmed !== projectId) {
    return `${launcher} runs the emulators under the REAL project "${projectId}" and signs you in against its REAL ` +
      'Firebase Auth (tracker D3 #40). It is not started by default.\n' +
      `  If this session is separately authorised, run:  ${CONFIRM_VARIABLE}=${projectId} npm run ${launcher}\n` +
      '  For ordinary local testing use npm run test:team (fully emulated, credential-isolated).'
  }
  return null
}

/** Exits the process with the reason when the launcher must not start. */
export function assertRealAuthLauncherAllowed({ projectId, launcher, env = process.env }) {
  const reason = realAuthLauncherRefusal({ env, projectId, launcher })
  if (reason) {
    console.error(`\n✖ REFUSING TO START: ${reason}\n`)
    process.exit(1)
  }
}
