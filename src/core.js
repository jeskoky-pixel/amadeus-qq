import { createHash } from 'node:crypto'
import { normalizeId, normalizeMessageId, sceneIdentity, sceneKey } from './storage.js'
import { normalizeOneBotMessage, validateOutgoingSegments } from './onebot.js'

const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 300_000

function idSet(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`)
  return new Set(values.map(value => normalizeId(value, label)))
}

export function parsePolicy(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('QQ policy must be an object')
  const epoch = raw.epoch ?? 0
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError('invalid QQ policy epoch')
  return {
    epoch,
    botIds: idSet(raw.botIds ?? [], 'botIds'),
    groupIds: idSet(raw.groupIds ?? [], 'groupIds'),
    privateIds: idSet(raw.privateIds ?? [], 'privateIds'),
    triggerNames: Array.isArray(raw.triggerNames) ? raw.triggerNames.filter(x => typeof x === 'string' && x.length <= 30).slice(0, 10) : [],
  }
}

function messageText(message) {
  return message.segments.filter(item => item.type === 'text').map(item => String(item.data.text ?? '')).join(' ')
}

export class QQCore {
  constructor({ store, dsh, transport, policy = {}, clock = () => Date.now() }) {
    if (!store || !dsh || !transport) throw new TypeError('store, dsh and transport are required')
    this.store = store
    this.dsh = dsh
    this.transport = transport
    this.policy = parsePolicy(policy)
    this.clock = clock
    this.sceneChains = new Map()
    this.waiters = new Map()
    this.closed = false
  }

  allowed(raw) {
    const scene = sceneIdentity(raw)
    return this.policy.botIds.has(scene.botId) &&
      (scene.kind === 'group' ? this.policy.groupIds.has(scene.peerId) : this.policy.privateIds.has(scene.peerId))
  }

  #requireAuthorizedSession(sessionId) {
    if (this.closed) throw new Error('QQ plugin is stopped')
    const row = this.store.sceneForSession(sessionId)
    if (!row || !this.allowed(row) || row.authEpoch !== this.policy.epoch) {
      throw new Error('QQ_UNAUTHORIZED: Session or scene permission is invalid')
    }
    return row
  }

  #serial(scene, work) {
    const key = sceneKey(scene)
    const previous = this.sceneChains.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(work)
    this.sceneChains.set(key, task)
    void task.finally(() => { if (this.sceneChains.get(key) === task) this.sceneChains.delete(key) }).catch(() => {})
    return task
  }

  #shouldPrompt(scene, message, row) {
    if (scene.kind === 'private') return true
    if (message.atIds.includes(scene.botId)) return true
    if (message.replyToMessageId && row?.deliveries.some(item => item.platformMessageId === message.replyToMessageId && item.status === 'delivered')) return true
    const text = messageText(message)
    return this.policy.triggerNames.some(name => text.includes(name))
  }

  async #ensureSession(scene) {
    let row = this.store.getScene(scene)
    if (row?.sessionId) {
      if (row.authEpoch !== this.policy.epoch) throw new Error('QQ_AUTH_CHANGED: old Session cannot continue after permission change')
      return row.sessionId
    }
    const created = await this.dsh.createSceneSession(scene)
    const sessionId = typeof created === 'string' ? created : created?.sessionId
    if (!sessionId) throw new Error('DSH did not return a Session ID')
    row = this.store.bindSession(scene, sessionId, this.policy.epoch)
    return row.sessionId
  }

  async #promptMessage(scene, seq) {
    const key = sceneKey(scene)
    const sessionId = await this.#ensureSession(scene)
    const stored = this.store.getScene(scene).messages.find(item => item.seq === seq)
    if (!stored) throw new Error('QQ message is no longer in the durable inbox')
    const prompt = {
      scene: { botId: scene.botId, kind: scene.kind, peerId: scene.peerId },
      messages: [stored],
      readThroughSeq: seq,
      instruction: 'Use QQ tools for any QQ send. You may send, continue using tools, wait for messages, or remain silent. Plain assistant output is not a QQ delivery.',
    }
    await this.dsh.prompt({
      sessionId,
      requestId: `qq-${createHash('sha256').update(`${key}:${seq}`).digest('hex')}`,
      mode: 'queue',
      content: [{ type: 'text', text: JSON.stringify(prompt) }],
    })
    this.store.markPrompted(scene, seq)
    return sessionId
  }

  async ingest(raw) {
    const normalized = normalizeOneBotMessage(raw)
    if (!normalized) return { status: 'ignored' }
    const { scene, message } = normalized
    if (!this.allowed(scene)) return { status: 'unauthorized' }
    if (message.senderId === scene.botId) return { status: 'self_ignored' }
    return this.#serial(scene, async () => {
      const before = this.store.getScene(scene)
      const key = sceneKey(scene)
      const waiter = this.waiters.get(key)
      const needsPrompt = Boolean(waiter) || this.#shouldPrompt(scene, message, before)
      const inserted = this.store.appendMessage(scene, { ...message, needsPrompt })
      if (inserted.duplicate) return { status: 'duplicate' }
      const row = this.store.getScene(scene)
      if (waiter && inserted.seq > waiter.afterSeq) {
        waiter.resolve()
        return { status: 'continued', seq: inserted.seq, sessionId: row.sessionId }
      }
      if (!needsPrompt) return { status: 'stored', seq: inserted.seq }
      const sessionId = await this.#promptMessage(scene, inserted.seq)
      return { status: 'prompted', seq: inserted.seq, sessionId }
    })
  }

  async resumePending() {
    const results = []
    for (const row of Object.values(this.store.snapshot().scenes)) {
      if (!this.allowed(row) || row.authEpoch !== this.policy.epoch) continue
      for (const message of row.messages) {
        if (!message.needsPrompt || message.prompted === true) continue
        results.push(await this.#serial(row, () => this.#promptMessage(row, message.seq)))
      }
    }
    return { resumed: results.length }
  }

  read(sessionId, { afterSeq = 0, limit = 50 } = {}) {
    const row = this.#requireAuthorizedSession(sessionId)
    const result = this.store.unread(row, afterSeq, limit)
    if (result.messages.length) this.store.markPresented(row, result.readThroughSeq)
    return result
  }

  markRead(sessionId, throughSeq) {
    const row = this.#requireAuthorizedSession(sessionId)
    return { readThroughSeq: this.store.markRead(row, throughSeq) }
  }

  async wait(sessionId, { afterSeq, timeoutMs = DEFAULT_WAIT_MS } = {}) {
    const row = this.#requireAuthorizedSession(sessionId)
    afterSeq ??= row.presentedSeq
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('invalid afterSeq')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_WAIT_MS) throw new TypeError('invalid timeoutMs')
    const immediate = this.read(sessionId, { afterSeq })
    if (immediate.messages.length) return { ...immediate, arrived: true, timeout: false }
    const key = sceneKey(row)
    if (this.waiters.has(key)) throw new Error('QQ_WAIT_BUSY: one wait is already active in this scene')
    await new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      this.waiters.set(key, { afterSeq, resolve: () => { clearTimeout(timer); resolve() } })
    }).finally(() => { this.waiters.delete(key) })
    this.#requireAuthorizedSession(sessionId)
    const result = this.read(sessionId, { afterSeq })
    // An event handed to a live wait is already in this DSH activity. Leave
    // the durable replay flag only when it was not actually returned to the
    // tool; otherwise resumePending would start a duplicate turn on restart.
    for (const message of result.messages) {
      if (message.needsPrompt && !message.prompted) this.store.markPrompted(row, message.seq)
    }
    return { ...result, arrived: result.messages.length > 0, timeout: result.messages.length === 0 }
  }

  async send(sessionId, args) {
    const row = this.#requireAuthorizedSession(sessionId)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('send arguments must be an object')
    const { actionId } = args
    const segments = validateOutgoingSegments(args.segments)
    for (const segment of segments) {
      if (segment.type === 'reply') {
        const target = this.store.getScene(row).messages.find(item => item.messageId === segment.data.id)
        if (!target) throw new Error('QQ_REPLY_SCOPE: reply target is not in this scene')
      }
      if (segment.type === 'at') {
        if (row.kind !== 'group' || !this.store.getScene(row).messages.some(item => item.senderId === segment.data.qq)) {
          throw new Error('QQ_AT_SCOPE: mention target is not a known sender in this group')
        }
      }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ scene: sceneKey(row), segments })).digest('hex')
    const reserved = this.store.reserveDelivery(row, actionId, fingerprint)
    if (!reserved.fresh) return { status: reserved.delivery.status, repeated: true, messageId: reserved.delivery.platformMessageId }
    try {
      const receipt = await this.transport.send(row, segments)
      const messageId = normalizeMessageId(receipt.messageId)
      const delivery = this.store.settleDelivery(row, actionId, 'delivered', messageId)
      return { status: delivery.status, repeated: false, messageId }
    } catch (error) {
      const status = error?.code === 'ONEBOT_REJECTED' ? 'failed' : 'unknown'
      this.store.settleDelivery(row, actionId, status)
      return { status, repeated: false, messageId: null }
    }
  }

  health() {
    return { enabled: !this.closed, transport: this.transport.status ?? 'unknown', scenes: Object.keys(this.store.snapshot().scenes).length, activeWaits: this.waiters.size }
  }

  statusFor(sessionId) {
    this.#requireAuthorizedSession(sessionId)
    return this.health()
  }

  authorizedScene(sessionId) {
    const row = this.#requireAuthorizedSession(sessionId)
    return { botId: row.botId, kind: row.kind, peerId: row.peerId }
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.values()) waiter.resolve()
    this.waiters.clear()
    this.transport.stop?.()
  }
}
