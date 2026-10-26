import { normalizeId, normalizeMessageId, sceneIdentity } from './storage.js'

const SEGMENT_LIMIT = 100
const EVENT_SIZE_LIMIT = 256 * 1024

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeOneBotMessage(raw) {
  if (!plainObject(raw) || raw.post_type !== 'message') return null
  if (raw.message_type !== 'group' && raw.message_type !== 'private') return null
  if (JSON.stringify(raw).length > EVENT_SIZE_LIMIT) throw new Error('OneBot event exceeds size limit')
  const scene = sceneIdentity({
    botId: raw.self_id,
    kind: raw.message_type,
    peerId: raw.message_type === 'group' ? raw.group_id : raw.user_id,
  })
  const senderId = normalizeId(raw.user_id, 'senderId')
  const messageId = normalizeMessageId(raw.message_id)
  const source = Array.isArray(raw.message)
    ? raw.message
    : [{ type: 'text', data: { text: String(raw.message ?? '') } }]
  if (source.length > SEGMENT_LIMIT) throw new Error('OneBot message has too many segments')
  const segments = source.map(segment => {
    if (!plainObject(segment) || typeof segment.type !== 'string' || !/^[a-z_]{1,32}$/i.test(segment.type) || !plainObject(segment.data)) {
      throw new TypeError('invalid OneBot segment')
    }
    return structuredClone({ type: segment.type, data: segment.data })
  })
  const atIds = segments.filter(item => item.type === 'at').map(item => {
    try { return normalizeId(item.data.qq, 'at.qq') } catch { return null }
  }).filter(Boolean)
  const replyId = segments.find(item => item.type === 'reply')?.data?.id
  return {
    scene,
    message: {
      messageId,
      senderId,
      time: Number.isFinite(raw.time) ? raw.time : null,
      segments,
      replyToMessageId: replyId == null ? null : normalizeMessageId(replyId, 'reply.id'),
      atIds,
      sender: plainObject(raw.sender)
        ? { nickname: typeof raw.sender.nickname === 'string' ? raw.sender.nickname.slice(0, 100) : null,
            card: typeof raw.sender.card === 'string' ? raw.sender.card.slice(0, 100) : null }
        : null,
    },
  }
}

export function validateOutgoingSegments(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw new TypeError('message must contain 1–20 segments')
  return raw.map(segment => {
    if (!plainObject(segment) || !plainObject(segment.data)) throw new TypeError('invalid outgoing segment')
    if (segment.type === 'text') {
      if (typeof segment.data.text !== 'string' || !segment.data.text.trim() || segment.data.text.length > 4000) throw new TypeError('invalid text segment')
      return { type: 'text', data: { text: segment.data.text } }
    }
    if (segment.type === 'at') return { type: 'at', data: { qq: normalizeId(segment.data.qq, 'at.qq') } }
    if (segment.type === 'reply') return { type: 'reply', data: { id: normalizeMessageId(segment.data.id, 'reply.id') } }
    throw new TypeError(`unsupported outgoing segment: ${String(segment.type)}`)
  })
}

export class OneBotAdapter {
  constructor(config = {}, dependencies = {}) {
    this.config = config
    this.fetch = dependencies.fetch ?? globalThis.fetch
    this.makeWebSocket = dependencies.makeWebSocket
    this.socket = null
    this.stopped = true
    this.reconnectTimer = null
    this.retryMs = 1000
    this.onEvent = null
    this.status = 'disabled'
  }

  get token() {
    const name = this.config.tokenEnv
    if (!name) return ''
    if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new TypeError('invalid tokenEnv')
    return process.env[name] ?? ''
  }

  async start(onEvent) {
    if (this.config.enabled !== true) { this.status = 'disabled'; return }
    if (typeof onEvent !== 'function') throw new TypeError('onEvent callback required')
    if (!/^wss?:\/\//.test(this.config.wsUrl ?? '') || !/^https?:\/\//.test(this.config.httpUrl ?? '')) {
      throw new TypeError('OneBot WS and HTTP URLs are required')
    }
    this.onEvent = onEvent
    this.stopped = false
    await this.#connect()
  }

  async #connect() {
    if (this.stopped) return
    this.status = 'connecting'
    try {
      const factory = this.makeWebSocket ?? ((await import('ws')).default)
      const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {}
      const ws = new factory(this.config.wsUrl, { headers })
      this.socket = ws
      ws.on('open', () => { this.status = 'connected'; this.retryMs = 1000 })
      ws.on('message', data => {
        try {
          if (data.length > EVENT_SIZE_LIMIT) return
          const event = JSON.parse(String(data))
          Promise.resolve(this.onEvent(event)).catch(() => {})
        } catch { /* malformed platform event cannot stop the connection */ }
      })
      ws.on('error', () => { this.status = 'disconnected' })
      ws.on('close', () => {
        if (this.socket === ws) this.socket = null
        this.status = this.stopped ? 'disabled' : 'disconnected'
        if (!this.stopped) this.#scheduleReconnect()
      })
    } catch {
      this.status = 'disconnected'
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.#connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  async action(name, params, timeoutMs = 10_000) {
    if (this.config.enabled !== true) throw new Error('OneBot transport is disabled')
    if (!/^[a-z][a-z0-9_]{1,80}$/.test(name)) throw new TypeError('invalid OneBot action')
    const url = new URL(name, `${this.config.httpUrl.replace(/\/+$/, '')}/`)
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const result = await response.json()
    if (!response.ok || !plainObject(result) || result.status !== 'ok' || result.retcode !== 0) {
      const error = new Error(`OneBot action ${name} rejected`)
      error.code = 'ONEBOT_REJECTED'
      throw error
    }
    return result.data
  }

  async send(scene, segments) {
    const identity = sceneIdentity(scene)
    const action = identity.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = identity.kind === 'group'
      ? { group_id: identity.peerId, message: segments }
      : { user_id: identity.peerId, message: segments }
    const result = await this.action(action, params)
    return { messageId: normalizeMessageId(result?.message_id, 'send receipt message_id') }
  }

  stop() {
    this.stopped = true
    this.status = 'disabled'
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close?.()
    this.socket = null
  }
}
