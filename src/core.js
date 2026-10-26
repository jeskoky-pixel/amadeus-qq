import { createHash } from 'node:crypto'
import { normalizeId, normalizeMessageId, sceneIdentity, sceneKey } from './storage.js'
import { normalizeOneBotMessage, sanitizeInboundSegments, validateOutgoingSegments } from './onebot.js'
import { CAPABILITY_CATALOG, PermissionEngine, validateScenePermissions } from './permissions.js'

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
  constructor({ store, dsh, transport, policy = {}, permissionPolicy = {}, clock = () => Date.now() }) {
    if (!store || !dsh || !transport) throw new TypeError('store, dsh and transport are required')
    this.store = store
    this.dsh = dsh
    this.transport = transport
    this.policy = parsePolicy(policy)
    this.permissions = new PermissionEngine(permissionPolicy)
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

  #permissionRevision(row) { return row.permissions?.revision ?? 0 }

  #can(scene, capability) {
    return this.permissions.evaluate(scene, this.store.getScenePermissions(scene), capability).allowed
  }

  #requireAuthorizedSession(sessionId, capability = 'qq.read') {
    if (this.closed) throw new Error('QQ plugin is stopped')
    const row = this.store.sceneForSession(sessionId)
    if (!row || !this.allowed(row) || row.authEpoch !== this.policy.epoch) {
      throw new Error('QQ_UNAUTHORIZED: Session or scene permission is invalid')
    }
    if ((row.boundPermissionRevision ?? 0) !== this.#permissionRevision(row)) {
      throw new Error('QQ_PERMISSION_CHANGED: old Session must be rebuilt after a Scene permission change')
    }
    if (!this.#can(row, capability)) throw new Error(`QQ_PERMISSION_DENIED: ${capability}`)
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

  #releaseWaiter(scene, sessionId = null) {
    const key = sceneKey(scene)
    const waiter = this.waiters.get(key)
    if (waiter && (sessionId === null || waiter.sessionId === sessionId)) {
      this.waiters.delete(key)
      waiter.resolve()
    }
  }

  #shouldPrompt(scene, message, row) {
    if (!this.#can(scene, 'qq.send')) return false
    if (scene.kind === 'private') return true
    if (message.atIds.includes(scene.botId)) return true
    if (message.replyToMessageId && this.store.hasDelivered(row, message.replyToMessageId)) return true
    const text = messageText(message)
    return this.policy.triggerNames.some(name => text.includes(name))
  }

  async setScenePermissions(rawScene, access, { expectedRevision } = {}) {
    const scene = sceneIdentity(rawScene)
    if (!this.allowed(scene)) throw new Error('QQ_UNAUTHORIZED: Scene is outside the configured allowlist')
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new TypeError('expectedRevision must be a non-negative integer')
    }
    const normalized = validateScenePermissions(access, { allowRevision: false })
    // Owner Agent is a property of a verified owner private Scene, never of a
    // group and never of an arbitrary private peer. Reject before persisting so
    // a GUI cannot save and display an unusable high-privilege configuration.
    if (normalized.mode === 'owner-agent' &&
      (scene.kind !== 'private' || !this.permissions.ownerPrivateIds.has(scene.peerId))) {
      const forbidden = new Error('QQ_OWNER_AGENT_FORBIDDEN: owner-agent requires a configured owner private Scene')
      forbidden.code = 'QQ_OWNER_AGENT_FORBIDDEN'
      throw forbidden
    }
    return this.#serial(scene, async () => {
      const currentRevision = this.store.getScenePermissions(scene)?.revision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        const conflict = new Error('QQ_PERMISSION_CONFLICT: Scene permissions changed since the GUI read them')
        conflict.code = 'QQ_PERMISSION_CONFLICT'
        conflict.currentRevision = currentRevision
        throw conflict
      }
      const permissions = this.store.setScenePermissions(scene, normalized)
      const row = this.store.getScene(scene)
      if (row.sessionId) {
        if (typeof this.dsh.cancelSceneSession !== 'function') throw new Error('QQ_SESSION_CANCEL_UNAVAILABLE')
        const cancelled = await this.dsh.cancelSceneSession(row.sessionId)
        if (cancelled?.accepted !== true) throw new Error('QQ_SESSION_CANCEL_FAILED')
        this.#releaseWaiter(scene, row.sessionId)
        this.store.retireSession(scene, row.sessionId)
      }
      return permissions
    })
  }

  /**
   * Safe metadata for the native management surface: only scenes already seen
   * and inside the configured allowlist. Message bodies, credentials, Session
   * IDs and configured paths never leave this boundary.
   */
  listScenePermissions() {
    const snapshot = this.store.snapshot()
    return Object.entries(snapshot.scenes)
      .filter(([, row]) => this.allowed(row))
      .map(([key, row]) => {
        const permissions = row.permissions ?? null
        const access = permissions === null
          ? null
          : { mode: permissions.mode, overrides: permissions.overrides }
        return {
          key,
          scene: { botId: row.botId, kind: row.kind, peerId: row.peerId },
          permissions: permissions === null
            ? null
            : { mode: permissions.mode, overrides: { ...permissions.overrides }, revision: permissions.revision },
          revision: permissions?.revision ?? 0,
          effectiveMode: this.permissions.evaluate(row, access, 'qq.read').mode,
          ownerEligible: row.kind === 'private' && this.permissions.ownerPrivateIds.has(row.peerId),
          capabilities: CAPABILITY_CATALOG.map(capability => {
            const decision = this.permissions.evaluate(row, access, capability.id)
            return {
              id: capability.id,
              implemented: capability.implemented,
              override: access?.overrides?.[capability.id] ?? 'inherit',
              effective: decision.allowed,
              reason: decision.reason,
            }
          }),
          health: {
            sessionActive: Boolean(row.sessionId),
            transport: this.transport.status ?? 'unknown',
          },
        }
      })
  }

  async #ensureSession(scene) {
    let row = this.store.getScene(scene)
    if (row?.sessionId) {
      if (row.authEpoch !== this.policy.epoch ||
        (row.boundPermissionRevision ?? 0) !== this.#permissionRevision(row)) {
        if (typeof this.dsh.cancelSceneSession !== 'function') throw new Error('QQ_SESSION_CANCEL_UNAVAILABLE')
        const cancelled = await this.dsh.cancelSceneSession(row.sessionId)
        if (cancelled?.accepted !== true) throw new Error('QQ_SESSION_CANCEL_FAILED')
        this.#releaseWaiter(scene, row.sessionId)
        this.store.retireSession(scene, row.sessionId)
        row = this.store.getScene(scene)
      } else {
        return row.sessionId
      }
    }
    if (!this.#can(scene, 'qq.send')) throw new Error('QQ_PERMISSION_DENIED: qq.send')
    const revision = this.#permissionRevision(row ?? {})
    const created = await this.dsh.createSceneSession(scene, {
      searchAllowed: this.#can(scene, 'dsh.search'),
      mediaAllowed: this.#can(scene, 'qq.media.read'),
    })
    const sessionId = typeof created === 'string' ? created : created?.sessionId
    if (!sessionId) throw new Error('DSH did not return a Session ID')
    row = this.store.getScene(scene)
    if (this.#permissionRevision(row ?? {}) !== revision || !this.#can(scene, 'qq.send') || !this.allowed(scene)) {
      this.store.recordRetiredSession(sessionId)
      await this.dsh.cancelSceneSession?.(sessionId)
      throw new Error('QQ_PERMISSION_CHANGED: Scene changed during Session creation')
    }
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
      messages: [{ ...stored, segments: sanitizeInboundSegments(stored.segments) }],
      readThroughSeq: seq,
      instruction: 'Use QQ tools for any QQ send. You may send, continue using tools, wait for messages, or remain silent. Plain assistant output is not a QQ delivery.',
    }
    await this.dsh.prompt({
      sessionId,
      requestId: `qq-${createHash('sha256').update(`${key}:${seq}`).digest('hex')}`,
      mode: 'queue',
      content: [{ type: 'text', text: JSON.stringify(prompt) }],
    })
    this.#requireAuthorizedSession(sessionId, 'qq.send')
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
      let waiter = this.waiters.get(key)
      if (waiter && (waiter.sessionId !== before?.sessionId ||
        (before.boundPermissionRevision ?? 0) !== this.#permissionRevision(before))) {
        this.#releaseWaiter(scene, waiter.sessionId)
        waiter = null
      }
      const needsPrompt = this.#can(scene, 'qq.send') && (Boolean(waiter) || this.#shouldPrompt(scene, message, before))
      const inserted = this.store.appendMessage(scene, { ...message, needsPrompt })
      if (inserted.duplicate) return { status: 'duplicate' }
      if (inserted.dropped) return { status: 'dropped', reason: inserted.dropped }
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
      if (!this.allowed(row) || !this.#can(row, 'qq.send')) continue
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
    // Older development state files may contain raw OneBot media locators.
    // Apply the same projection at both model-facing exits without changing
    // the durable cursor or silently rewriting a pre-existing state file.
    return { ...result, messages: result.messages.map(message => ({
      ...message, segments: sanitizeInboundSegments(message.segments),
    })) }
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
    let waiter
    await new Promise(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      waiter = { sessionId, afterSeq, resolve: () => { clearTimeout(timer); resolve() } }
      this.waiters.set(key, waiter)
    }).finally(() => { if (this.waiters.get(key) === waiter) this.waiters.delete(key) })
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
    const row = this.#requireAuthorizedSession(sessionId, 'qq.send')
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
    // The reservation write and the permission check are not one atomic step.
    // Re-read the Session binding and qq.send immediately before the external
    // call; a revoked Scene must not reach OneBot. No request was made here, so
    // the reservation is settled as a terminal failure instead of lingering as
    // an unsettled action that would consume outbox capacity forever.
    try {
      this.#requireAuthorizedSession(sessionId, 'qq.send')
    } catch (error) {
      try { this.store.settleDelivery(row, actionId, 'failed') } catch { /* keep the permission failure */ }
      throw error
    }
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

  /**
   * Synchronous execution-time capability check for the connector's Host
   * service. The Scene comes only from the persisted Session binding; callers
   * never supply it. Any stale binding, revision, allowlist or capability
   * failure is reported as false.
   */
  authorizeSessionCapability(sessionId, capability) {
    try {
      this.#requireAuthorizedSession(sessionId, capability)
      return true
    } catch {
      return false
    }
  }

  trustedSceneForSession(sessionId) {
    const row = this.#requireAuthorizedSession(sessionId)
    return Object.freeze({
      platform: 'qq',
      kind: row.kind,
      id: `${row.botId}:${row.peerId}`,
      verified: true,
      admin: row.kind === 'private' && this.permissions.ownerPrivateIds.has(row.peerId),
    })
  }

  close() {
    this.closed = true
    for (const waiter of this.waiters.values()) waiter.resolve()
    this.waiters.clear()
    this.transport.stop?.()
  }
}
