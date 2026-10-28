import { createHash } from 'node:crypto'
import path from 'node:path'
import { normalizeId, normalizeMessageId, sceneIdentity, sceneKey } from './storage.js'
import { normalizeOneBotMessage, sanitizeInboundSegments, validateOutgoingSegments } from './onebot.js'
import { CAPABILITY_CATALOG, PermissionEngine, validateScenePermissions } from './permissions.js'

const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 300_000
const AUTONOMOUS_QUIET_WINDOW_MS = 850
const IMPLEMENTED_CAPABILITIES = new Set(
  CAPABILITY_CATALOG.filter(item => item.implemented === true).map(item => item.id),
)

function idSet(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`)
  return new Set(values.map(value => normalizeId(value, label)))
}

export function parsePolicy(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('QQ policy must be an object')
  const epoch = raw.epoch ?? 0
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new TypeError('invalid QQ policy epoch')
  const sceneRevisions = new Map()
  if (raw.sceneRevisions !== undefined) {
    if (!raw.sceneRevisions || typeof raw.sceneRevisions !== 'object' || Array.isArray(raw.sceneRevisions) ||
      Object.keys(raw.sceneRevisions).length > 10000) throw new TypeError('invalid QQ scene revisions')
    for (const [key, revision] of Object.entries(raw.sceneRevisions)) {
      if (!/^[1-9]\d{0,19}:(group|private):[1-9]\d{0,19}$/.test(key) ||
        !Number.isSafeInteger(revision) || revision < 0) throw new TypeError('invalid QQ scene revision')
      sceneRevisions.set(key, revision)
    }
  }
  return {
    epoch,
    sceneRevisions,
    botIds: idSet(raw.botIds ?? [], 'botIds'),
    groupIds: idSet(raw.groupIds ?? [], 'groupIds'),
    privateIds: idSet(raw.privateIds ?? [], 'privateIds'),
    pausedScenes: new Set(Array.isArray(raw.pausedScenes) ? raw.pausedScenes.filter(x => typeof x === 'string') : []),
    triggerNames: Array.isArray(raw.triggerNames) ? raw.triggerNames.filter(x => typeof x === 'string' && x.length <= 30).slice(0, 10) : [],
  }
}

function messageText(message) {
  return message.segments.filter(item => item.type === 'text').map(item => String(item.data.text ?? '')).join(' ')
}

export class QQCore {
  constructor({ store, dsh, transport, policy = {}, permissionPolicy = {}, workspaceId = '', clock = () => Date.now() }) {
    if (!store || !dsh || !transport) throw new TypeError('store, dsh and transport are required')
    this.store = store
    this.dsh = dsh
    this.transport = transport
    this.policy = parsePolicy(policy)
    this.permissions = new PermissionEngine(permissionPolicy)
    this.workspaceId = workspaceId
    this.clock = clock
    this.sceneChains = new Map()
    this.waiters = new Map()
    this.promptTimers = new Map()
    this.inFlightDeliveries = new Set()
    this.closed = false
    // A scene can be removed from the allowlist while the plugin is stopped.
    // Retire any bound Session whose scene is no longer authorized before it
    // can be reached by a tool or reused after the scene is re-added.
    for (const row of Object.values(this.store.snapshot().scenes)) {
      if (row.sessionId && !this.allowed(row)) this.#revokeDisallowedSession(row)
    }
  }

  allowed(raw) {
    const scene = sceneIdentity(raw)
    return !this.policy.pausedScenes.has(sceneKey(scene)) && this.policy.botIds.has(scene.botId) &&
      (scene.kind === 'group' ? this.policy.groupIds.has(scene.peerId) : this.policy.privateIds.has(scene.peerId))
  }

  #permissionRevision(row) { return row.permissions?.revision ?? 0 }

  #can(scene, capability) {
    if (!IMPLEMENTED_CAPABILITIES.has(capability)) return false
    return this.permissions.evaluate(scene, this.store.getScenePermissions(scene), capability).allowed
  }

  /**
   * Bind a Session only to the security posture that created it. Behavior
   * preferences are deliberately excluded: they can change without replacing
   * the DSH activity. A global policy epoch is also excluded because adding an
   * unrelated allowlisted Scene must not interrupt existing conversations.
   */
  #securityFingerprint(scene, access = this.store.getScenePermissions(scene)) {
    const ownerPreset = scene.kind === 'private' &&
      this.permissions.ownerPrivateIds.has(scene.peerId) &&
      this.permissions.evaluate(scene, access, 'qq.read').mode === 'owner-agent'
    const decisions = CAPABILITY_CATALOG.map(capability => [
      capability.id,
      this.permissions.evaluate(scene, access, capability.id).allowed,
    ])
    return createHash('sha256').update(JSON.stringify({
      scene: { botId: scene.botId, kind: scene.kind, peerId: scene.peerId },
      sceneRevision: this.policy.sceneRevisions.get(sceneKey(scene)) ?? 0,
      workspaceId: this.workspaceId ?? '',
      agentPreset: ownerPreset ? 'amadeus-qq-owner' : 'amadeus-qq',
      decisions,
    })).digest('hex')
  }

  #bindingSecurityCurrent(row, scene = row) {
    // Pre-1.1 bindings have no fingerprint. Their epoch still supplies the
    // original fail-closed policy version check until a controlled update or
    // a newly created Session records the stronger per-Scene fingerprint.
    return row.boundSecurityFingerprint
      ? row.boundSecurityFingerprint === this.#securityFingerprint(scene)
      : row.authEpoch === this.policy.epoch
  }

  #revokeDisallowedSession(row) {
    const sessionId = row?.sessionId
    if (!sessionId) return
    try {
      this.store.retireSession(row, sessionId)
    } catch {
      // A concurrent state change already removed the binding; it is not
      // authorized either way, so never restore it here.
      return
    }
    this.#releaseWaiter(row, sessionId)
    // The binding is already revoked and durable. Cancellation is best effort
    // here because this path is synchronous; a failed cancel cannot reauthorize
    // the retired Session.
    try {
      const result = this.dsh.cancelSceneSession?.(sessionId)
      if (result && typeof result.then === 'function') result.catch(() => {})
    } catch { /* revocation already recorded */ }
  }

  #requireAuthorizedSession(sessionId, capability = 'qq.read') {
    if (this.closed) throw new Error('QQ plugin is stopped')
    const row = this.store.sceneForSession(sessionId)
    if (!row) throw new Error('QQ_UNAUTHORIZED: Session or scene permission is invalid')
    if (!this.allowed(row)) {
      this.#revokeDisallowedSession(row)
      throw new Error('QQ_UNAUTHORIZED: Session or scene permission is invalid')
    }
    if ((row.boundPermissionRevision ?? 0) !== this.#permissionRevision(row)) {
      throw new Error('QQ_PERMISSION_CHANGED: old Session must be rebuilt after a Scene permission change')
    }
    if ((row.workspaceId ?? '') !== (this.workspaceId ?? '')) {
      throw new Error('QQ_WORKSPACE_CHANGED: old Session belongs to another Workspace')
    }
    if (!this.#bindingSecurityCurrent(row)) {
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
    if (this.policy.triggerNames.some(name => text.includes(name))) return true
    if (!this.#autonomousGroup(scene)) return false
    const cooldown = this.store.getScenePermissions(scene)?.behavior?.replyCooldownMs ?? 0
    return !cooldown || !row?.lastAutoPromptAt || this.clock() - row.lastAutoPromptAt >= cooldown
  }

  #autonomousGroup(scene) {
    return scene.kind === 'group' &&
      this.permissions.evaluate(scene, this.store.getScenePermissions(scene), 'qq.read').mode === 'autonomous-social'
  }

  #behavior(scene) {
    return this.store.getScenePermissions(scene)?.behavior ?? null
  }

  #shouldBatch(scene) {
    return (this.#behavior(scene)?.quietWindowMs ?? 0) > 0
  }

  #schedulePromptBatch(scene, delay = this.#behavior(scene)?.quietWindowMs ?? AUTONOMOUS_QUIET_WINDOW_MS) {
    if (this.closed) return
    const key = sceneKey(scene)
    const prior = this.promptTimers.get(key)
    if (prior) clearTimeout(prior.timer)
    // Wait for a short quiet interval, but bound a busy room's first batch.
    const firstAt = prior?.firstAt ?? this.clock()
    const maxWindow = Math.max(delay * 2, AUTONOMOUS_QUIET_WINDOW_MS)
    const remaining = Math.max(0, maxWindow - (this.clock() - firstAt))
    const timer = setTimeout(() => {
      this.promptTimers.delete(key)
      void this.#serial(scene, () => this.#promptBatch(scene)).catch(() => {
        // The durable batch remains pending with the same requestId. A later
        // inbound event or restart can retry without inventing another turn.
      })
    }, Math.min(delay, remaining))
    timer.unref?.()
    this.promptTimers.set(key, { timer, firstAt })
  }

  async #promptBatch(scene) {
    if (!this.allowed(scene) || !this.#can(scene, 'qq.send')) return null
    const seqs = this.store.reservePromptBatch(scene)
    if (!seqs.length) return null
    const sessionId = await this.#ensureSession(scene)
    const row = this.store.getScene(scene)
    const messages = seqs.map(seq => row.messages.find(item => item.seq === seq))
    if (messages.some(item => !item)) throw new Error('QQ_PROMPT_BATCH_MISSING')
    const key = sceneKey(scene)
    const prompt = {
      scene: { botId: scene.botId, kind: scene.kind, peerId: scene.peerId },
      messages: messages.map(item => ({ ...item, segments: sanitizeInboundSegments(item.segments) })),
      readThroughSeq: seqs.at(-1),
      behavior: this.#behavior(scene) ?? undefined,
      instruction: 'These messages are one current conversation. Decide whether to reply, use QQ tools, wait briefly for more messages, or remain silent. Use separate guarded sends only when natural. Plain assistant output is not QQ delivery. Life alone owns long-term autonomous wake.',
    }
    await this.dsh.prompt({
      sessionId,
      requestId: `qq-${createHash('sha256').update(`${key}:batch:${seqs.join(',')}`).digest('hex')}`,
      mode: 'queue',
      content: [{ type: 'text', text: JSON.stringify(prompt) }],
    })
    this.#requireAuthorizedSession(sessionId, 'qq.send')
    this.store.markPromptBatch(scene, seqs)
    if (this.#autonomousGroup(scene)) this.store.markAutoPromptAt(scene, this.clock())
    if (this.store.getScene(scene).messages.some(item => item.needsPrompt && !item.prompted)) {
      this.#schedulePromptBatch(scene, 0)
    }
    return sessionId
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
      const before = this.store.getScene(scene)
      const currentRevision = before?.permissions?.revision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
        const conflict = new Error('QQ_PERMISSION_CONFLICT: Scene permissions changed since the GUI read them')
        conflict.code = 'QQ_PERMISSION_CONFLICT'
        conflict.currentRevision = currentRevision
        throw conflict
      }
      const beforeFingerprint = this.#securityFingerprint(scene, before?.permissions ?? null)
      const bindingWasCurrent = Boolean(before?.sessionId) &&
        (before.boundPermissionRevision ?? 0) === currentRevision &&
        (before.workspaceId ?? '') === (this.workspaceId ?? '') &&
        this.#bindingSecurityCurrent(before)
      const permissions = this.store.setScenePermissions(scene, normalized)
      const row = this.store.getScene(scene)
      const securityChanged = this.#securityFingerprint(scene, row.permissions) !== beforeFingerprint
      if (row.sessionId) {
        if (securityChanged) {
          if (typeof this.dsh.cancelSceneSession !== 'function') throw new Error('QQ_SESSION_CANCEL_UNAVAILABLE')
          const cancelled = await this.dsh.cancelSceneSession(row.sessionId)
          if (cancelled?.accepted !== true) throw new Error('QQ_SESSION_CANCEL_FAILED')
          this.#releaseWaiter(scene, row.sessionId)
          this.store.retireSession(scene, row.sessionId)
        } else if (bindingWasCurrent) {
          // A preference-only update still advances the permission revision.
          // Rebind the same Session to that revision so a controlled behavior
          // change is not mistaken for a direct, out-of-band mutation.
          this.store.bindSession(scene, row.sessionId, this.policy.epoch, this.workspaceId,
            this.#securityFingerprint(scene, row.permissions))
        }
      }
      if (this.workspaceId && this.#can(scene, 'qq.read') && !this.store.getScene(scene).sessionId) {
        await this.#ensureSession(scene)
      }
      return permissions
    })
  }

  /**
   * Safe metadata for the native management surface: only scenes already seen
   * and inside the configured allowlist. Message bodies, credentials and
   * configured paths never leave this Owner-authenticated boundary.
   */
  listScenePermissions() {
    const snapshot = this.store.snapshot()
    return Object.entries(snapshot.scenes)
      .filter(([, row]) => this.policy.botIds.has(row.botId) &&
        (row.kind === 'group' ? this.policy.groupIds.has(row.peerId) : this.policy.privateIds.has(row.peerId)))
      .map(([key, row]) => {
        const active = this.allowed(row)
        const permissions = row.permissions ?? null
        const access = permissions === null
          ? null
          : { mode: permissions.mode, overrides: permissions.overrides }
        return {
          key,
          scene: { botId: row.botId, kind: row.kind, peerId: row.peerId },
          permissions: permissions === null
            ? null
          : { mode: permissions.mode, overrides: { ...permissions.overrides },
              ...(permissions.behavior ? { behavior: { ...permissions.behavior } } : {}), revision: permissions.revision },
          revision: permissions?.revision ?? 0,
          sessionId: row.sessionId,
          workspaceId: row.workspaceId ?? '',
          effectiveMode: this.permissions.evaluate(row, access, 'qq.read').mode,
          ownerEligible: row.kind === 'private' && this.permissions.ownerPrivateIds.has(row.peerId),
          capabilities: CAPABILITY_CATALOG.map(capability => {
            const decision = this.permissions.evaluate(row, access, capability.id)
            return {
              id: capability.id,
              implemented: capability.implemented,
              override: access?.overrides?.[capability.id] ?? 'inherit',
              effective: active && capability.implemented === true && decision.allowed,
              reason: !active ? 'scene-paused' : capability.implemented === true ? decision.reason : 'unimplemented',
            }
          }),
          health: {
            sessionActive: Boolean(row.sessionId),
            transport: this.transport.status ?? 'unknown',
          },
          activity: {
            observedCount: row.messages.length,
            // Only stable QQ IDs observed in this authorized Scene. Do not
            // expose names, bodies, media locators or a platform-wide roster.
            participantIds: [...new Set(row.messages.slice(-500).reverse()
              .map(item => item.senderId)
              .filter(id => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)))].slice(0, 20),
          },
          unresolvedDeliveries: row.deliveries
            .filter(delivery => delivery.status === 'unknown')
            .map(delivery => ({
              actionId: delivery.actionId,
              status: delivery.status,
              updatedAt: delivery.updatedAt,
            })),
        }
      })
  }

  /**
   * Explicit owner reconciliation for one settled unknown send. It only closes
   * the ledger entry as failed; it never sends content, changes permissions, or
   * touches an action whose transport call is still in flight.
   */
  resolveDelivery(rawScene, actionId, outcome = 'failed') {
    const scene = sceneIdentity(rawScene)
    if (!this.allowed(scene)) {
      const error = new Error('QQ_SCENE_UNAUTHORIZED')
      error.code = 'QQ_SCENE_UNAUTHORIZED'
      throw error
    }
    if (!this.store.getScene(scene)) {
      const error = new Error('QQ_DELIVERY_NOT_FOUND')
      error.code = 'QQ_DELIVERY_NOT_FOUND'
      throw error
    }
    if (outcome !== 'failed') throw new TypeError('only failed reconciliation is supported')
    if (this.inFlightDeliveries.has(`${sceneKey(scene)}:${actionId}`)) {
      const error = new Error('QQ_DELIVERY_IN_FLIGHT')
      error.code = 'QQ_DELIVERY_IN_FLIGHT'
      throw error
    }
    return this.store.resolveUnknownDelivery(scene, actionId, 'failed')
  }

  async #ensureSession(scene) {
    if (this.closed || !this.allowed(scene) || !this.#can(scene, 'qq.read')) {
      throw new Error('QQ_UNAUTHORIZED: Scene is no longer active')
    }
    let row = this.store.getScene(scene)
    if (row?.sessionId) {
      if ((row.boundPermissionRevision ?? 0) !== this.#permissionRevision(row) ||
        !this.#bindingSecurityCurrent(row, scene) ||
        (row.workspaceId ?? '') !== (this.workspaceId ?? '')) {
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
    const revision = this.#permissionRevision(row ?? {})
    const fingerprint = this.#securityFingerprint(scene)
    const created = await this.dsh.createSceneSession(scene, {
      searchAllowed: this.#can(scene, 'dsh.search'),
      mediaAllowed: this.#can(scene, 'qq.media.read'),
      ownerAgent: scene.kind === 'private' &&
        this.permissions.ownerPrivateIds.has(scene.peerId) &&
        this.permissions.evaluate(scene, this.store.getScenePermissions(scene), 'qq.read').mode === 'owner-agent',
      ownerWorkspaceAllowed: this.#can(scene, 'qq.owner.workspace'),
    })
    const sessionId = typeof created === 'string' ? created : created?.sessionId
    if (!sessionId) throw new Error('DSH did not return a Session ID')
    row = this.store.getScene(scene)
    if (this.closed || this.#permissionRevision(row ?? {}) !== revision ||
      this.#securityFingerprint(scene) !== fingerprint || !this.#can(scene, 'qq.read') || !this.allowed(scene)) {
      this.store.recordRetiredSession(sessionId)
      await this.dsh.cancelSceneSession?.(sessionId)
      throw new Error('QQ_PERMISSION_CHANGED: Scene changed during Session creation')
    }
    row = this.store.bindSession(scene, sessionId, this.policy.epoch, this.workspaceId, fingerprint)
    return row.sessionId
  }

  /** Materialize authorized Workspace members even before the first message. */
  async provisionAuthorizedScenes() {
    if (!this.workspaceId) return { provisioned: 0 }
    let provisioned = 0
    for (const botId of this.policy.botIds) {
      for (const [kind, peers] of [['group', this.policy.groupIds], ['private', this.policy.privateIds]]) {
        for (const peerId of peers) {
          if (this.closed) return { provisioned }
          const scene = { botId, kind, peerId }
          if (!this.allowed(scene) || !this.#can(scene, 'qq.read')) continue
          await this.#serial(scene, () => this.#ensureSession(scene))
          provisioned++
        }
      }
    }
    return { provisioned }
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
      behavior: this.#behavior(scene) ?? undefined,
      instruction: 'This is one current conversation. Use the activity preference only when deciding whether to participate. Use QQ tools for any QQ send. You may send, continue using tools, wait briefly for messages, or remain silent. Plain assistant output is not a QQ delivery. Life alone owns long-term autonomous wake.',
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
    if (!this.allowed(scene)) {
      const row = this.store.getScene(scene)
      if (row?.sessionId) this.#revokeDisallowedSession(row)
      return { status: 'unauthorized' }
    }
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
      if (this.#shouldBatch(scene) || this.#autonomousGroup(scene)) {
        this.#schedulePromptBatch(scene)
        return { status: 'queued', seq: inserted.seq }
      }
      const sessionId = await this.#promptMessage(scene, inserted.seq)
      return { status: 'prompted', seq: inserted.seq, sessionId }
    })
  }

  async resumePending() {
    const results = []
    for (const row of Object.values(this.store.snapshot().scenes)) {
      if (!this.allowed(row) || !this.#can(row, 'qq.send')) continue
      if (this.#shouldBatch(row) || this.#autonomousGroup(row)) {
        if (row.messages.some(item => item.needsPrompt && !item.prompted)) {
          results.push(await this.#serial(row, () => this.#promptBatch(row)))
        }
        continue
      }
      for (const message of row.messages) {
        if (!message.needsPrompt || message.prompted === true) continue
        results.push(await this.#serial(row, () => this.#promptMessage(row, message.seq)))
      }
    }
    return { resumed: results.length }
  }

  read(sessionId, { afterSeq = 0, limit = 50 } = {}) {
    const row = this.#requireAuthorizedSession(sessionId)
    const budget = this.#behavior(row)?.contextBudget
    if (budget) limit = Math.min(limit, budget)
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
    const behavior = this.#behavior(row)
    if (behavior?.waitTimeoutMs === 0) throw new Error('QQ_PERMISSION_DENIED: observe cannot wait for conversation')
    if (behavior) timeoutMs = Math.min(timeoutMs, behavior.waitTimeoutMs)
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
    const inFlightKey = `${sceneKey(row)}:${actionId}`
    this.inFlightDeliveries.add(inFlightKey)
    try {
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
    } finally {
      this.inFlightDeliveries.delete(inFlightKey)
    }
  }

  async sendPreparedMedia(sessionId, actionId, plan) {
    const row = this.#requireAuthorizedSession(sessionId, 'qq.send')
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) throw new TypeError('invalid actionId')
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      plan.mode !== 'message' || !/^[a-f0-9]{64}$/.test(plan.fingerprint) ||
      !Array.isArray(plan.segments) || plan.segments.length !== 1) {
      throw new TypeError('invalid outbound media plan')
    }
    const segment = plan.segments[0]
    if (!segment || !['image', 'video', 'record'].includes(segment.type) ||
      !segment.data || typeof segment.data.file !== 'string' || !segment.data.file) {
      throw new TypeError('invalid outbound media segment')
    }
    const ledgerFingerprint = createHash('sha256').update(JSON.stringify({
      operation: 'send-media',
      scene: sceneKey(row),
      segmentType: segment.type,
      mediaType: typeof plan.mediaType === 'string' ? plan.mediaType : null,
      contentHash: plan.fingerprint,
    })).digest('hex')
    const reserved = this.store.reserveDelivery(row, actionId, ledgerFingerprint)
    if (!reserved.fresh) {
      return {
        status: reserved.delivery.status,
        repeated: true,
        messageId: reserved.delivery.platformMessageId,
      }
    }
    const inFlightKey = `${sceneKey(row)}:${actionId}`
    this.inFlightDeliveries.add(inFlightKey)
    try {
      try {
        this.#requireAuthorizedSession(sessionId, 'qq.send')
      } catch (error) {
        try { this.store.settleDelivery(row, actionId, 'failed') } catch { /* keep permission failure */ }
        throw error
      }
      try {
        const receipt = await this.transport.send(row, plan.segments)
        const messageId = normalizeMessageId(receipt.messageId)
        const delivery = this.store.settleDelivery(row, actionId, 'delivered', messageId)
        return { status: delivery.status, repeated: false, messageId }
      } catch (error) {
        const status = error?.code === 'ONEBOT_REJECTED' ? 'failed' : 'unknown'
        this.store.settleDelivery(row, actionId, status)
        return { status, repeated: false, messageId: null }
      }
    } finally {
      this.inFlightDeliveries.delete(inFlightKey)
    }
  }

  async uploadSceneFile(sessionId, actionId, plan) {
    const row = this.#requireAuthorizedSession(sessionId, 'qq.send')
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) throw new TypeError('invalid actionId')
    const expectedAction = row.kind === 'group' ? 'upload_group_file' : 'upload_private_file'
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      plan.mode !== 'upload' || plan.action !== expectedAction ||
      !/^[a-f0-9]{64}$/.test(plan.fingerprint) ||
      !plan.params || typeof plan.params !== 'object' || Array.isArray(plan.params) ||
      typeof plan.params.file !== 'string' || !path.isAbsolute(plan.params.file) ||
      typeof plan.params.name !== 'string' || !plan.params.name ||
      plan.params.upload_file !== true) {
      throw new TypeError('invalid outbound upload plan')
    }
    const target = row.kind === 'group' ? plan.params.group_id : plan.params.user_id
    if (String(target) !== String(row.peerId)) throw new Error('QQ_UPLOAD_SCOPE')
    const ledgerFingerprint = createHash('sha256').update(JSON.stringify({
      operation: 'upload-file',
      scene: sceneKey(row),
      action: plan.action,
      name: plan.params.name,
      mediaType: typeof plan.mediaType === 'string' ? plan.mediaType : null,
      contentHash: plan.fingerprint,
    })).digest('hex')
    const reserved = this.store.reserveDelivery(row, actionId, ledgerFingerprint)
    if (!reserved.fresh) {
      return {
        status: reserved.delivery.status,
        repeated: true,
        fileId: reserved.delivery.platformFileId ?? null,
      }
    }
    const inFlightKey = `${sceneKey(row)}:${actionId}`
    this.inFlightDeliveries.add(inFlightKey)
    try {
      try {
        this.#requireAuthorizedSession(sessionId, 'qq.send')
      } catch (error) {
        try { this.store.settleDelivery(row, actionId, 'failed') } catch { /* keep permission failure */ }
        throw error
      }
      // NapCat may complete a group upload but return no file_id. Its root
      // listing also rotates file_id on every read, so compare stable file
      // metadata and counts rather than treating a new id as a new file.
      const rootFiles = async () => {
        try {
          const result = await this.transport.action('get_group_root_files',
            { group_id: row.peerId }, 10_000, 2 * 1024 * 1024)
          return Array.isArray(result?.files) && result.files.length <= 2000 ? result.files : null
        } catch { return null }
      }
      const beforeFiles = row.kind === 'group' ? await rootFiles() : null
      try {
        this.#requireAuthorizedSession(sessionId, 'qq.send')
      } catch (error) {
        try { this.store.settleDelivery(row, actionId, 'failed') } catch { /* keep permission failure */ }
        throw error
      }
      try {
        const result = await this.transport.action(plan.action, plan.params)
        let fileId = typeof result?.file_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(result.file_id)
          ? result.file_id
          : null
        if (fileId === null && beforeFiles !== null && Number.isSafeInteger(plan.bytes) && plan.bytes > 0) {
          const afterFiles = await rootFiles()
          if (afterFiles !== null) {
            const isMatch = file =>
              typeof file?.file_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(file.file_id) &&
              String(file.group_id) === row.peerId &&
              file.file_name === plan.params.name && Number(file.file_size ?? file.size) === plan.bytes &&
              String(file.uploader) === row.botId
            const beforeMatches = beforeFiles.filter(isMatch)
            const afterMatches = afterFiles.filter(isMatch)
            if (afterMatches.length === beforeMatches.length + 1) {
              // A unique name/size/uploader is sufficient. For an existing
              // same-name file, require a fresh unique platform modify_time;
              // same-second or missing timestamps remain unknown.
              const candidate = beforeMatches.length === 0 ? afterMatches[0] : (() => {
                const oldTimes = new Set(beforeMatches.map(file => Number(file.modify_time)))
                const fresh = afterMatches.filter(file => Number.isSafeInteger(Number(file.modify_time)) &&
                  Number(file.modify_time) > 0 && !oldTimes.has(Number(file.modify_time)))
                return fresh.length === 1 ? fresh[0] : null
              })()
              if (candidate) fileId = candidate.file_id
            }
          }
        }
        if (fileId === null) {
          this.store.settleDelivery(row, actionId, 'unknown')
          return { status: 'unknown', repeated: false, fileId: null }
        }
        const delivery = this.store.settleDelivery(row, actionId, 'delivered', null, fileId)
        return { status: delivery.status, repeated: false, fileId }
      } catch (error) {
        const status = error?.code === 'ONEBOT_REJECTED' ? 'failed' : 'unknown'
        this.store.settleDelivery(row, actionId, status)
        return { status, repeated: false, fileId: null }
      }
    } finally {
      this.inFlightDeliveries.delete(inFlightKey)
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
    for (const { timer } of this.promptTimers.values()) clearTimeout(timer)
    this.promptTimers.clear()
    for (const waiter of this.waiters.values()) waiter.resolve()
    this.waiters.clear()
    this.transport.stop?.()
  }
}
