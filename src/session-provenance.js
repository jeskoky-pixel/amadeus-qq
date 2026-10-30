import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// This journal is separate from replaceable scene configuration. Never infer
// ordinary provenance from absence in a potentially incomplete historical index.
export class SessionProvenance {
  constructor(file, { sessions, store, now = () => Date.now() }) {
    this.file = file
    this.sessions = sessions
    this.store = store
    this.now = now
    this.observedSince = now()
    this.pending = new Set()
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
      { version: 1, observedSince: now(), reserved: [] }
    if (this.state.version !== 1 || !Number.isSafeInteger(this.state.observedSince) ||
      !Array.isArray(this.state.reserved) || this.state.reserved.some(id => typeof id !== 'string')) {
      throw new Error('QQ_PROVENANCE_INVALID: restore the provenance backup; refusing reset')
    }
    if (!fs.existsSync(file)) this.persist(this.state)
    this.state.ordinary ??= {}
    if (typeof this.state.ordinary !== 'object' || Array.isArray(this.state.ordinary) || this.state.ordinary === null) {
      throw new Error('QQ_PROVENANCE_INVALID: invalid ordinary attestations')
    }
  }
  persist(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    const fd = fs.openSync(temp, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, this.file)
  }
  reserve() {
    const id = randomUUID()
    const next = { ...this.state, reserved: [...this.state.reserved, id] }
    this.persist(next) // Must precede even the first Host create await.
    this.state = next
    this.pending.add(id)
    return id
  }
  complete(id, returnedId) {
    if (returnedId !== undefined && returnedId !== id) {
      const next = { ...this.state, unsupportedHost: true }
      this.persist(next)
      this.state = next
    }
    this.pending.delete(id)
  }
  classify(sessionId) {
    const session = this.sessions()?.get?.(sessionId)
    if (!session || session.id !== sessionId) return { kind: 'unknown', reason: 'session-unavailable' }
    if (this.store.isKnownSession(sessionId) || this.state.reserved.includes(sessionId)) {
      return { kind: 'qq', reason: 'durable-qq-reservation' }
    }
    const raw = session.header?.createdAt
    const created = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN
    // Before journal enrollment, failed/unbound historical QQ creation is not
    // reconstructible. Require a fresh Host Session instead of guessing.
    if (Number.isFinite(created) && Object.hasOwn(this.state.ordinary, sessionId) && this.state.ordinary[sessionId] === created) {
      return { kind: 'ordinary', reason: 'durable-host-attestation' }
    }
    if (this.pending.size || this.state.unsupportedHost) return { kind: 'unknown', reason: 'qq-creation-contract-unverified' }
    // A previous process's observation interval is not evidence for Sessions
    // created while it was absent (or an older connector was running).
    if (!Number.isFinite(created) || created <= this.observedSince || created > this.now()) {
      return { kind: 'unknown', reason: 'historical-provenance-unverified' }
    }
    const next = { ...this.state, ordinary: { ...this.state.ordinary, [sessionId]: created } }
    this.persist(next)
    this.state = next
    return { kind: 'ordinary', reason: 'host-created-after-reservation-contract' }
  }
}
