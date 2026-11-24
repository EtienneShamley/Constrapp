// Test fixture (scripts.test.js): preloaded into an operator-script child via
// NODE_OPTIONS=--import. Any write of an acceptance link to a file writes a
// FRAGMENT of it and then fails with ENOSPC — a disk that fills up after the
// invitation has committed. Other writes are untouched.
import { createRequire, syncBuiltinESMExports } from 'node:module'

const fs = createRequire(import.meta.url)('node:fs')
const original = fs.writeSync
fs.writeSync = function writeSync(fd, data, ...rest) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  if (text.includes('accept-invite#')) {
    original.call(this, fd, Buffer.from(text.slice(0, 12)))
    const e = new Error('ENOSPC: no space left on device, write')
    e.code = 'ENOSPC'
    throw e
  }
  return original.call(this, fd, data, ...rest)
}
syncBuiltinESMExports()
