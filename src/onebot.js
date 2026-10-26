import { normalizeId, normalizeMessageId, sceneIdentity } from './storage.js'

const SEGMENT_LIMIT = 100
const EVENT_SIZE_LIMIT = 256 * 1024
const MEDIA_SEGMENT_TYPES = new Set(['image', 'record', 'video', 'file'])
const MAX_MEDIA_ID_LENGTH = 256

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A media `file` field is an opaque platform handle, not a locator. Keep only
 * short, single-token handles; every URL scheme, local path, UNC path, CQ code
 * and control character is dropped so an inbound event can never carry a
 * network or filesystem target into durable state or the model prompt.
 */
function safeMediaId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_MEDIA_ID_LENGTH) return null
  if (value.trim() !== value) return null
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  if (/\[CQ:/i.test(value)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  if (/^[A-Za-z]:/.test(value)) return null
  if (value.includes('/') || value.includes('\\')) return null
  if (value === '.' || value === '..' || value.includes('..')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) return null
  return value
}

function safeId(value, normalize) {
  try { return normalize(value) } catch { return null }
}

/**
 * String-format OneBot messages may contain arbitrary CQ payloads. Their
 * parameters can hold locators or inline data, so remove each complete code
 * while leaving ordinary words on either side intact.
 */
function stripCqCodes(text) {
  let removed = false
  const stripped = text.replace(/\[CQ:[a-z_]+(?:,[^\]]*)?\]/gi, () => {
    removed = true
    return ' '
  })
  // Keep the words on both sides separate without carrying a CQ parameter.
  return removed ? stripped.replace(/[ \t]{2,}/g, ' ').trim() : text
}

/**
 * Every inbound segment is reduced to a per-type whitelist: text keeps only
 * its text, at/reply keep only the IDs used for trigger and quote semantics,
 * face keeps only a bounded face ID, media keep only a non-locating handle,
 * and unknown segments keep their type with an empty data object. No URL,
 * local path, base64/CQ locator or arbitrary platform field is retained.
 */
export function sanitizeInboundSegments(source) {
  if (!Array.isArray(source)) throw new TypeError('invalid OneBot message segments')
  if (source.length > SEGMENT_LIMIT) throw new Error('OneBot message has too many segments')
  return source.map(segment => {
    if (!plainObject(segment) || typeof segment.type !== 'string' || !/^[a-z_]{1,32}$/i.test(segment.type) || !plainObject(segment.data)) {
      throw new TypeError('invalid OneBot segment')
    }
    const type = segment.type.toLowerCase()
    if (type === 'text') {
      const text = typeof segment.data.text === 'string' ? stripCqCodes(segment.data.text) : ''
      return { type, data: { text } }
    }
    if (type === 'at') {
      const qq = safeId(segment.data.qq, value => normalizeId(value, 'at.qq'))
      return { type, data: qq === null ? {} : { qq } }
    }
    if (type === 'reply') {
      // Preserve the existing distinction: a missing ID means "no reply",
      // while a malformed non-empty ID still rejects the event.
      if (segment.data.id == null) return { type, data: {} }
      return { type, data: { id: normalizeMessageId(segment.data.id, 'reply.id') } }
    }
    if (type === 'face') {
      const id = safeId(segment.data.id, normalizeFaceId)
      return { type, data: id === null ? {} : { id } }
    }
    if (MEDIA_SEGMENT_TYPES.has(type)) {
      const file = safeMediaId(segment.data.file)
      return { type, data: file === null ? {} : { file } }
    }
    return { type, data: {} }
  })
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
  const segments = sanitizeInboundSegments(source)
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

const MAX_FACE_ID = 1_000_000

/**
 * Normalize a standard QQ face ID. Only a canonical non-negative decimal ID
 * within a small bound is accepted; any other data fields are intentionally
 * dropped by the caller.
 */
function normalizeFaceId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FACE_ID) throw new TypeError('invalid face segment')
    return String(value)
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})$/.test(value)) throw new TypeError('invalid face segment')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id > MAX_FACE_ID) throw new TypeError('invalid face segment')
  return String(id)
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
    if (segment.type === 'face') return { type: 'face', data: { id: normalizeFaceId(segment.data.id) } }
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
