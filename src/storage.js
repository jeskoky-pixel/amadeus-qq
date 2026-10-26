import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateScenePermissions } from './permissions.js'

const SCHEMA_VERSION = 1
const ID_PATTERN = /^(0|[1-9]\d{0,19})$/
const MESSAGE_ID_PATTERN = /^-?[1-9]\d{0,19}$/
const DEFAULT_MAX_MESSAGES = 500
const DEFAULT_MAX_SEEN = 2048
const DEFAULT_MAX_DELIVERIES = 500
const DEFAULT_MAX_ARCHIVED_DELIVERIES = 4096
const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'failed'])

export function normalizeId(value, label = 'id') {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !ID_PATTERN.test(text) || text === '0') {
    throw new TypeError(`${label} must be a positive decimal platform ID`)
  }
  return text
}

export function normalizeMessageId(value, label = 'messageId') {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !MESSAGE_ID_PATTERN.test(text)) {
    throw new TypeError(`${label} must be a nonzero decimal message ID`)
  }
  return text
}

export function sceneIdentity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('scene must be an object')
  const botId = normalizeId(raw.botId, 'botId')
  if (raw.kind !== 'group' && raw.kind !== 'private') throw new TypeError('scene kind must be group or private')
  const peerId = normalizeId(raw.peerId, 'peerId')
  return Object.freeze({ botId, kind: raw.kind, peerId })
}

export function sceneKey(raw) {
  const scene = sceneIdentity(raw)
  return `${scene.botId}:${scene.kind}:${scene.peerId}`
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, scenes: {}, retiredSessions: [] }
}

function clone(value) {
  return structuredClone(value)
}

/**
 * A message is protected until DSH delivery has been recorded. Reading it from
 * the durable inbox does not make an undelivered addressed/wait event safe to
 * evict: the read waterline can move past it while the prompt is still pending.
 */
function isPendingDelivery(message) {
  return message?.needsPrompt === true && message?.prompted !== true
}

function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !state.scenes || typeof state.scenes !== 'object' || Array.isArray(state.scenes)) {
    throw new Error('QQ state schema is invalid; refusing to reset durable state')
  }
  const boundSessions = new Set()
  if (!Array.isArray(state.retiredSessions)) throw new Error('QQ state has an invalid retired Session index')
  for (const sessionId of state.retiredSessions) {
    if (typeof sessionId !== 'string' || !sessionId || boundSessions.has(sessionId)) throw new Error('QQ state has an invalid retired Session')
    boundSessions.add(sessionId)
  }
  for (const [key, row] of Object.entries(state.scenes)) {
    if (sceneKey(row) !== key || !Array.isArray(row.messages) || !Array.isArray(row.seenIds) || !Array.isArray(row.deliveries)) {
      throw new Error(`QQ state contains an invalid scene row: ${key}`)
    }
    if (row.deliveryArchive !== undefined && !Array.isArray(row.deliveryArchive)) {
      throw new Error(`QQ state contains an invalid delivery archive: ${key}`)
    }
    if (row.permissions !== undefined) {
      try { validateScenePermissions(row.permissions, { requireRevision: true }) }
      catch { throw new Error(`QQ state contains invalid Scene permissions: ${key}`) }
    }
    for (const message of row.messages) {
      if (message.needsPrompt !== undefined && typeof message.needsPrompt !== 'boolean') {
        throw new Error(`QQ state contains an invalid message delivery flag: ${key}`)
      }
    }
    const actionIds = new Set()
    for (const delivery of [...row.deliveries, ...(row.deliveryArchive ?? [])]) {
      if (typeof delivery?.actionId !== 'string' || !/^[\w-]{1,100}$/.test(delivery.actionId)) {
        throw new Error(`QQ state contains an invalid delivery action: ${key}`)
      }
      if (actionIds.has(delivery.actionId)) throw new Error(`QQ state repeats a delivery action: ${key}`)
      actionIds.add(delivery.actionId)
      if (typeof delivery.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(delivery.fingerprint)) {
        throw new Error(`QQ state contains an invalid delivery fingerprint: ${key}`)
      }
      if (!['delivered', 'failed', 'unknown'].includes(delivery.status)) {
        throw new Error(`QQ state contains an invalid delivery status: ${key}`)
      }
    }
    for (const delivery of row.deliveryArchive ?? []) {
      // Archived entries are terminal. An unknown action must stay in the live
      // ledger: moving it would hide an unresolved external write.
      if (!TERMINAL_DELIVERY_STATUSES.has(delivery.status)) {
        throw new Error(`QQ state archives an unsettled delivery: ${key}`)
      }
    }
    if (row.sessionId !== null && (typeof row.sessionId !== 'string' || !row.sessionId)) {
      throw new Error(`QQ state contains an invalid Session: ${key}`)
    }
    if (row.boundPermissionRevision !== undefined &&
      (!Number.isSafeInteger(row.boundPermissionRevision) || row.boundPermissionRevision < 0)) {
      throw new Error(`QQ state contains an invalid bound permission revision: ${key}`)
    }
    if (row.sessionId) {
      if (boundSessions.has(row.sessionId)) throw new Error('QQ state binds one DSH Session to multiple scenes')
      boundSessions.add(row.sessionId)
    }
  }
}

/**
 * Read schema-v1 rows written before the capacity revisions. Missing archives
 * are empty; a message without an explicit delivery flag is treated as pending
 * unless it was already prompted, so an upgrade cannot silently drop it.
 */
function normalizeLoadedState(state) {
  if (!state || typeof state !== 'object' || !state.scenes || typeof state.scenes !== 'object' || Array.isArray(state.scenes)) {
    return state
  }
  state.retiredSessions ??= []
  for (const row of Object.values(state.scenes)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    row.deliveryArchive ??= []
    if (!Array.isArray(row.messages)) continue
    for (const message of row.messages) {
      if (message.needsPrompt === undefined) message.needsPrompt = message.prompted !== true
    }
  }
  return state
}

function durableWrite(file, state) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`)
  let created = false
  try {
    const fd = fs.openSync(temp, 'wx', 0o600)
    created = true
    try {
      fs.writeFileSync(fd, JSON.stringify(state))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
    try {
      const dirFd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    } catch {
      // Windows does not always permit directory fsync. File fsync + atomic rename remain required.
    }
  } catch (error) {
    if (created) { try { fs.unlinkSync(temp) } catch {} }
    throw error
  }
}

export class QQStore {
  constructor(file, limits = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('state file must be absolute')
    this.file = file
    this.maxMessages = limits.maxMessages ?? DEFAULT_MAX_MESSAGES
    this.maxSeen = limits.maxSeen ?? DEFAULT_MAX_SEEN
    this.maxDeliveries = limits.maxDeliveries ?? DEFAULT_MAX_DELIVERIES
    this.maxArchivedDeliveries = limits.maxArchivedDeliveries ?? DEFAULT_MAX_ARCHIVED_DELIVERIES
    for (const n of [this.maxMessages, this.maxSeen, this.maxDeliveries, this.maxArchivedDeliveries]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('state limits must be positive integers')
    }
    this.state = fs.existsSync(file) ? normalizeLoadedState(JSON.parse(fs.readFileSync(file, 'utf8'))) : emptyState()
    validateState(this.state)
  }

  snapshot() { return clone(this.state) }

  #change(edit) {
    const next = clone(this.state)
    const result = edit(next)
    validateState(next)
    durableWrite(this.file, next)
    this.state = next
    return result
  }

  #row(state, identity) {
    const scene = sceneIdentity(identity)
    const key = sceneKey(scene)
    state.scenes[key] ??= { ...scene, sessionId: null, authEpoch: 0, boundPermissionRevision: 0, nextSeq: 1, readSeq: 0, presentedSeq: 0, promptedSeq: 0, messages: [], seenIds: [], deliveries: [], deliveryArchive: [] }
    return state.scenes[key]
  }

  getScene(identity) {
    const row = this.state.scenes[sceneKey(identity)]
    return row ? clone(row) : null
  }

  getScenePermissions(identity) {
    const row = this.state.scenes[sceneKey(identity)]
    return row?.permissions ? clone(row.permissions) : null
  }

  setScenePermissions(identity, access) {
    const normalized = validateScenePermissions(access, { allowRevision: false })
    return this.#change(state => {
      const row = this.#row(state, identity)
      const revision = (row.permissions?.revision ?? 0) + 1
      row.permissions = { ...normalized, revision }
      return clone(row.permissions)
    })
  }

  sceneForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const matches = Object.values(this.state.scenes).filter(row => row.sessionId === sessionId)
    if (matches.length > 1) throw new Error('one DSH Session is bound to multiple QQ scenes')
    return matches.length ? clone(matches[0]) : null
  }

  isKnownSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false
    return this.state.retiredSessions.includes(sessionId) || this.sceneForSession(sessionId) !== null
  }

  retireSession(identity, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('invalid DSH Session ID')
    return this.#change(state => {
      const row = this.#row(state, identity)
      if (row.sessionId !== sessionId) throw new Error('QQ_SESSION_CHANGED: expected Session is no longer bound')
      if (!state.retiredSessions.includes(sessionId)) state.retiredSessions.push(sessionId)
      row.sessionId = null
      row.boundPermissionRevision = 0
      return clone(row)
    })
  }

  recordRetiredSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('invalid DSH Session ID')
    return this.#change(state => {
      if (Object.values(state.scenes).some(row => row.sessionId === sessionId)) throw new Error('cannot retire an active QQ Session')
      if (!state.retiredSessions.includes(sessionId)) state.retiredSessions.push(sessionId)
      return sessionId
    })
  }

  bindSession(identity, sessionId, authEpoch = 0) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new TypeError('invalid DSH Session ID')
    if (!Number.isSafeInteger(authEpoch) || authEpoch < 0) throw new TypeError('invalid authorization epoch')
    return this.#change(state => {
      const row = this.#row(state, identity)
      if (state.retiredSessions.includes(sessionId)) throw new Error('retired DSH Session cannot be rebound')
      if (row.sessionId && row.sessionId !== sessionId) throw new Error('scene already has a DSH Session')
      if (Object.values(state.scenes).some(other => other !== row && other.sessionId === sessionId)) {
        throw new Error('DSH Session is already bound to another scene')
      }
      row.sessionId = sessionId
      row.authEpoch = authEpoch
      row.boundPermissionRevision = row.permissions?.revision ?? 0
      return clone(row)
    })
  }

  updateAuthEpoch(identity, authEpoch) {
    if (!Number.isSafeInteger(authEpoch) || authEpoch < 0) throw new TypeError('invalid authorization epoch')
    return this.#change(state => { const row = this.#row(state, identity); row.authEpoch = authEpoch; return clone(row) })
  }

  markPresented(identity, throughSeq) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new TypeError('invalid throughSeq')
    return this.#change(state => {
      const row = this.#row(state, identity)
      if (throughSeq >= row.nextSeq) throw new RangeError('presentation exceeds received message waterline')
      row.presentedSeq = Math.max(row.presentedSeq, throughSeq)
      return row.presentedSeq
    })
  }

  markPrompted(identity, throughSeq) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new TypeError('invalid throughSeq')
    return this.#change(state => {
      const row = this.#row(state, identity)
      if (throughSeq >= row.nextSeq) throw new RangeError('prompt exceeds received message waterline')
      const message = row.messages.find(item => item.seq === throughSeq)
      if (!message) throw new Error('prompted message is no longer stored')
      message.prompted = true
      row.promptedSeq = Math.max(row.promptedSeq, throughSeq)
      row.presentedSeq = Math.max(row.presentedSeq, throughSeq)
      return row.promptedSeq
    })
  }

  /**
   * Free exactly one message slot. Passive (never-addressed) messages roll off
   * first as a short-term window; already-read messages are next; messages that
   * were handed to the model but not read are last. A message still waiting for
   * delivery is never evicted here.
   */
  #evictMessage(row) {
    let index = row.messages.findIndex(item => item.needsPrompt !== true)
    if (index < 0) index = row.messages.findIndex(item => item.seq <= row.readSeq && !isPendingDelivery(item))
    if (index < 0) index = row.messages.findIndex(item => item.prompted === true)
    if (index < 0) return false
    row.messages.splice(index, 1)
    return true
  }

  appendMessage(identity, message) {
    const messageId = normalizeMessageId(message?.messageId, 'messageId')
    const needsPrompt = message?.needsPrompt === true
    return this.#change(state => {
      const row = this.#row(state, identity)
      if (row.seenIds.includes(messageId)) return { duplicate: true, seq: null }
      while (row.messages.length >= this.maxMessages && this.#evictMessage(row)) {}
      if (row.messages.length >= this.maxMessages) {
        // Do not advance nextSeq and do not invent a slot: a protected message
        // that cannot be retained must be reported, not silently lost.
        if (needsPrompt) {
          const pending = row.messages.filter(isPendingDelivery).length
          throw new Error(`QQ_QUEUE_FULL: ${row.messages.length}/${this.maxMessages} messages retained, ${pending} pending delivery; acknowledge or read earlier messages first`)
        }
        row.seenIds.push(messageId)
        if (row.seenIds.length > this.maxSeen) row.seenIds.splice(0, row.seenIds.length - this.maxSeen)
        return { duplicate: false, seq: null, dropped: 'passive_window' }
      }
      const seq = row.nextSeq++
      row.messages.push({ ...clone(message), messageId, seq, needsPrompt, prompted: false })
      row.seenIds.push(messageId)
      if (row.seenIds.length > this.maxSeen) row.seenIds.splice(0, row.seenIds.length - this.maxSeen)
      return { duplicate: false, seq }
    })
  }

  unread(identity, afterSeq = 0, limit = 50) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('invalid afterSeq')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('invalid limit')
    const row = this.getScene(identity)
    if (!row) return { messages: [], readThroughSeq: 0, unreadCount: 0 }
    if (afterSeq >= row.nextSeq) throw new RangeError('afterSeq exceeds received message waterline')
    const pending = row.messages.filter(item => item.seq > Math.max(row.readSeq, afterSeq))
    const messages = pending.slice(0, limit)
    return { messages, readThroughSeq: messages.at(-1)?.seq ?? Math.max(row.readSeq, afterSeq), unreadCount: pending.length, partial: pending.length > messages.length }
  }

  markRead(identity, throughSeq) {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new TypeError('invalid throughSeq')
    return this.#change(state => {
      const row = this.#row(state, identity)
      if (throughSeq > row.presentedSeq) throw new RangeError('cannot mark unread unseen messages as read')
      row.readSeq = Math.max(row.readSeq, throughSeq)
      return row.readSeq
    })
  }

  hasDelivered(identity, platformMessageId) {
    const row = this.state.scenes[sceneKey(identity)]
    if (!row) return false
    return [...row.deliveries, ...(row.deliveryArchive ?? [])]
      .some(item => item.status === 'delivered' && item.platformMessageId === platformMessageId)
  }

  reserveDelivery(identity, actionId, fingerprint) {
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) throw new TypeError('invalid actionId')
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError('invalid fingerprint')
    return this.#change(state => {
      const row = this.#row(state, identity)
      const prior = row.deliveries.find(item => item.actionId === actionId) ??
        row.deliveryArchive.find(item => item.actionId === actionId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('QQ_ACTION_CONFLICT: actionId reused with different content')
        return { fresh: false, delivery: clone(prior) }
      }
      if (row.deliveries.length >= this.maxDeliveries) {
        // Only terminal actions may leave the live ledger. Unknown actions keep
        // an unresolved external write; forgetting one would permit a blind retry.
        const index = row.deliveries.findIndex(item => TERMINAL_DELIVERY_STATUSES.has(item.status))
        if (index < 0) {
          const unsettled = row.deliveries.filter(item => item.status === 'unknown').length
          throw new Error(`QQ_OUTBOX_FULL: ${row.deliveries.length}/${this.maxDeliveries} actions are unsettled (${unsettled} unknown); refusing to forget an in-flight send`)
        }
        const [archived] = row.deliveries.splice(index, 1)
        // Terminal actions move to a bounded archive. The newest terminal
        // actionIds keep deduplicating across restarts; the oldest expire after
        // maxArchivedDeliveries newer settlements and may be sent again in a far
        // later activity. This is bounded retry protection, not exactly-once.
        row.deliveryArchive.push({ ...archived, archivedAt: Date.now() })
        while (row.deliveryArchive.length > this.maxArchivedDeliveries) row.deliveryArchive.shift()
      }
      const delivery = { actionId, fingerprint, status: 'unknown', platformMessageId: null, updatedAt: Date.now() }
      row.deliveries.push(delivery)
      return { fresh: true, delivery: clone(delivery) }
    })
  }

  settleDelivery(identity, actionId, status, platformMessageId = null) {
    if (!['delivered', 'failed', 'unknown'].includes(status)) throw new TypeError('invalid delivery status')
    return this.#change(state => {
      const row = this.#row(state, identity)
      const delivery = row.deliveries.find(item => item.actionId === actionId)
      if (!delivery) throw new Error('delivery not reserved')
      if (delivery.status === 'delivered' && status !== 'delivered') throw new Error('delivered action cannot be downgraded')
      delivery.status = status
      delivery.platformMessageId = platformMessageId === null ? null : normalizeMessageId(platformMessageId, 'platformMessageId')
      delivery.updatedAt = Date.now()
      return clone(delivery)
    })
  }
}
