import { normalizeMessageId } from './storage.js'
import { sanitizeInboundSegments } from './onebot.js'

const MAX_TRANSCRIPT_CHARS = 4000
const MAX_RESPONSE_BYTES = 64 * 1024
const PLATFORM_TIMEOUT_MS = 10_000

function asrError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function readPermissionError(changed = false) {
  return asrError(changed ? 'QQ_PERMISSION_CHANGED: qq.read' : 'QQ_PERMISSION_DENIED: qq.read')
}

function assertRead(core, sessionId, changed = false) {
  let allowed = false
  try {
    allowed = core.authorizeSessionCapability(sessionId, 'qq.read') === true
  } catch {
    allowed = false
  }
  if (!allowed) throw readPermissionError(changed)
}

function authorizeScene(core, sessionId) {
  try {
    return core.authorizedScene(sessionId)
  } catch (error) {
    const changed = String(error?.message ?? '').startsWith('QQ_PERMISSION_CHANGED')
    throw readPermissionError(changed)
  }
}

function boundedText(value) {
  if (typeof value !== 'string') throw asrError('QQ_NATIVE_ASR_INVALID_RESPONSE')
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (text.length === 0) throw asrError('QQ_NATIVE_ASR_EMPTY')
  if (text.length > MAX_TRANSCRIPT_CHARS) throw asrError('QQ_NATIVE_ASR_TOO_LONG')
  return text
}

/**
 * Use NapCat/QQ's native PTT transcript for one stored record message. The
 * model supplies only messageId; Scene, sender and transcript storage target
 * all come from the current authorized Session.
 */
export async function transcribeMessageRecordNative({
  core,
  store,
  transport,
  sessionId,
  messageId,
}) {
  if (!transport || typeof transport.action !== 'function') throw asrError('QQ_NATIVE_ASR_UNAVAILABLE')
  if (transport.status !== undefined && transport.status !== 'connected') throw asrError('QQ_NATIVE_ASR_UNAVAILABLE')

  let id
  try {
    id = normalizeMessageId(messageId, 'messageId')
  } catch {
    throw asrError('QQ_NATIVE_ASR_MESSAGE_INVALID')
  }

  const scene = authorizeScene(core, sessionId)
  assertRead(core, sessionId)

  const row = store.getScene(scene)
  const message = row?.messages?.find(item => item.messageId === id)
  if (!message) throw asrError('QQ_MESSAGE_SCOPE')

  let segments
  try {
    segments = sanitizeInboundSegments(message.segments)
  } catch {
    throw asrError('QQ_NATIVE_ASR_MESSAGE_INVALID')
  }
  if (!segments.some(segment => segment.type === 'record')) throw asrError('QQ_NATIVE_ASR_NOT_RECORD')

  let response
  try {
    response = await transport.action('fetch_ptt_text', { message_id: id }, PLATFORM_TIMEOUT_MS, MAX_RESPONSE_BYTES)
  } catch (error) {
    throw asrError(error?.code === 'ONEBOT_RESPONSE_TOO_LARGE'
      ? 'QQ_NATIVE_ASR_RESPONSE_TOO_LARGE'
      : 'QQ_NATIVE_ASR_UNAVAILABLE')
  }

  assertRead(core, sessionId, true)
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw asrError('QQ_NATIVE_ASR_INVALID_RESPONSE')
  }
  const text = boundedText(response.text)
  assertRead(core, sessionId, true)

  try {
    store.setMessageTranscript(scene, id, text)
  } catch {
    throw asrError('QQ_NATIVE_ASR_STORAGE_FAILED')
  }

  return {
    text,
    messageId: id,
    senderId: message.senderId,
    scene: { botId: scene.botId, kind: scene.kind, peerId: scene.peerId },
  }
}
