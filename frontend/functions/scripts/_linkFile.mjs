// ── Private delivery of an acceptance link to a local file (D3 #2) ──────────
//
// An acceptance link is a credential: whoever opens it can accept the
// invitation. An operator script never prints it. When the operator asks for
// it (`--link-file <path>`), it is written to ONE new file that:
//
//   · lies OUTSIDE this repository — checked on the real path of its folder,
//     so a symbolic link into the working tree is caught, and checked again
//     after the file exists, so a folder swapped meanwhile is caught too
//   · did not exist before — created with O_CREAT | O_EXCL | O_NOFOLLOW, so
//     an existing file, a symbolic link (even a dangling one) or a file
//     created concurrently by another process is never written through
//   · is mode 0600, owned by the operator, a regular file with one link
//   · sits in a folder only the operator (or root) owns, and that nobody
//     else can write to unless it is sticky (like /tmp)
//
// The file is RESERVED before any production write, so a bad destination
// refuses the run with nothing written. If the run then writes nothing (a
// refusal, nothing to do), the reserved file is removed. If writing the link
// fails AFTER the invitation committed, the half-written file is removed and
// the caller reports the committed invitation and how to recover — the link
// itself is gone; it is never shown as a fallback.
//
// No function here puts a link, or any part of one, into an error message.

import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export class LinkFileError extends Error {
  constructor(message) { super(`--link-file: ${message}`); this.name = 'LinkFileError' }
}

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const realOr = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined)

function insideRepo(abs, repoRoot) {
  const realDir = realOr(dirname(abs))
  const roots = [resolve(repoRoot), realOr(repoRoot)]
  return roots.some(r => within(abs, r) || within(join(realDir, basename(abs)), r))
}

// Checks a destination WITHOUT creating anything; returns its absolute path.
export function checkLinkFileDestination(path, { repoRoot = REPO_ROOT, uid = currentUid() } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new LinkFileError('a path is required')
  const abs = resolve(path)
  const dir = dirname(abs)
  let st
  try { st = statSync(realpathSync(dir)) } catch { throw new LinkFileError('the folder does not exist') }
  if (!st.isDirectory()) throw new LinkFileError('the folder is not a directory')
  if (insideRepo(abs, repoRoot)) throw new LinkFileError('must be OUTSIDE this repository: an acceptance link must never be committed')
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) throw new LinkFileError('the folder belongs to another user')
  if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) throw new LinkFileError('the folder is writable by other users (and not sticky): choose a private folder')
  let exists = true
  try { lstatSync(abs) } catch (e) { if (e?.code === 'ENOENT') exists = false; else throw new LinkFileError(`cannot be checked (${e?.code ?? 'error'})`) }
  if (exists) throw new LinkFileError('names a file or link that already exists; nothing is overwritten')
  return abs
}

function removeIfOurs(reserved) {
  try {
    const now = lstatSync(reserved.path)
    if (now.ino === reserved.ino && now.dev === reserved.dev) { unlinkSync(reserved.path); return true }
  } catch { /* already gone */ }
  return false
}

// Creates the empty file (exclusively, 0600) and verifies what was created.
export function reserveLinkFile(path, { repoRoot = REPO_ROOT, uid = currentUid() } = {}) {
  const abs = checkLinkFileDestination(path, { repoRoot, uid })
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  let fd
  try { fd = openSync(abs, flags, 0o600) } catch (e) {
    throw new LinkFileError(e?.code === 'EEXIST' || e?.code === 'ELOOP' ? 'appeared while being created; nothing is overwritten' : `could not be created (${e?.code ?? 'error'})`)
  }
  let st
  try {
    fchmodSync(fd, 0o600)
    st = fstatSync(fd)
    const ln = lstatSync(abs)
    const sound = st.isFile() && st.nlink === 1 && ln.ino === st.ino && ln.dev === st.dev
      && (st.mode & 0o777) === 0o600 && (uid === undefined || st.uid === uid)
    if (!sound) throw new LinkFileError('changed while being created')
    // The folder may have been swapped for a link into the repository meanwhile.
    if (insideRepo(abs, repoRoot)) throw new LinkFileError('must be OUTSIDE this repository: an acceptance link must never be committed')
  } catch (e) {
    closeSync(fd)
    if (st) removeIfOurs({ path: abs, ino: st.ino, dev: st.dev })
    throw e instanceof LinkFileError ? e : new LinkFileError(`could not be verified (${e?.code ?? 'error'})`)
  }
  return { path: abs, fd, ino: st.ino, dev: st.dev }
}

function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8')
  let off = 0
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
  fsyncSync(fd)
}

// Writes the link and closes the file. Never throws; never includes the link
// in what it returns. `{ ok: false, code }` = the link is NOT in the file
// (the partial file has been removed).
export function deliverToLinkFile(reserved, link, write = writeAll) {
  try {
    write(reserved.fd, `${link}\n`)
    closeSync(reserved.fd)
    return { ok: true }
  } catch (e) {
    try { closeSync(reserved.fd) } catch { /* already closed */ }
    const removed = removeIfOurs(reserved)
    return { ok: false, code: typeof e?.code === 'string' ? e.code : 'write-failed', removed }
  }
}

// The run will deliver nothing (refused, or nothing to do): remove the file.
export function discardLinkFile(reserved) {
  try { closeSync(reserved.fd) } catch { /* already closed */ }
  return removeIfOurs(reserved)
}

// Last line of defence for anything printed on a failure path: blank out
// anything shaped like an acceptance link or its token parameter.
export function redactCredentials(text) {
  return String(text)
    .replace(/\S*accept-invite#\S*/g, '[redacted link]')
    .replace(/([#&?]t=)[A-Za-z0-9_-]+/g, '$1[redacted]')
}
