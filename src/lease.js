import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

export function acquireInstanceLease(stateFile) {
  if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)) throw new TypeError('stateFile must be absolute')
  const file = `${stateFile}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const record = JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })
  let fd
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = fs.openSync(file, 'wx', 0o600)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let existing
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error('QQ_INSTANCE_LOCKED: unreadable lock requires manual inspection') }
      if (processExists(existing.pid)) throw new Error('QQ_INSTANCE_LOCKED: another QQ sender is active')
      if (attempt > 0) throw new Error('QQ_INSTANCE_LOCKED: could not acquire after stale lock cleanup')
      // Only a dead process's lock is removed; wx still arbitrates the new owner.
      fs.unlinkSync(file)
    }
  }
  if (fd === undefined) throw new Error('QQ_INSTANCE_LOCKED')
  try { fs.writeFileSync(fd, record); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (current.token === token) fs.unlinkSync(file)
    } catch { /* never remove a lock that cannot be verified as ours */ }
  }
}
