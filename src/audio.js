import fs from 'node:fs'
import path from 'node:path'
import { normalizeMessageId } from './storage.js'
import { sanitizeInboundSegments } from './onebot.js'

const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const MAX_DURATION_SECONDS = 120
const READ_TIMEOUT_MS = 5_000
const PLATFORM_TIMEOUT_MS = 10_000
const ASR_TIMEOUT_MS = 120_000
const MAX_TRANSCRIPT_CHARS = 16_384

function mediaError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function permissionError(code = 'QQ_PERMISSION_DENIED') {
  return mediaError(`${code}: qq.media.read`)
}

function assertMediaRead(core, sessionId, changed = false) {
  let allowed = false
  try {
    allowed = core.authorizeSessionCapability(sessionId, 'qq.media.read') === true
  } catch {
    allowed = false
  }
  if (!allowed) throw permissionError(changed ? 'QQ_PERMISSION_CHANGED' : 'QQ_PERMISSION_DENIED')
}

/** Resolve only a Scene that the core currently authorizes for this Session. */
function authorizeScene(core, sessionId) {
  try {
    return core.authorizedScene(sessionId)
  } catch (error) {
    const changed = String(error?.message ?? '').startsWith('QQ_PERMISSION_CHANGED')
    throw permissionError(changed ? 'QQ_PERMISSION_CHANGED' : 'QQ_PERMISSION_DENIED')
  }
}

function resolveMediaRoot(mediaRoot) {
  if (typeof mediaRoot !== 'string' || !path.isAbsolute(mediaRoot)) throw mediaError('QQ_MEDIA_ROOT_INVALID')
  let root
  try {
    root = fs.realpathSync(mediaRoot)
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory')
  } catch {
    throw mediaError('QQ_MEDIA_ROOT_INVALID')
  }
  return root
}

function resolveLocalAudio(file, root, mediaRoot) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\u0000')) throw mediaError('QQ_MEDIA_PATH_INVALID')
  if (/^[\\/]{2}/.test(file)) throw mediaError('QQ_MEDIA_PATH_INVALID')
  if (!/^[A-Za-z]:[\\/]/.test(file) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)) throw mediaError('QQ_MEDIA_PATH_INVALID')
  if (!path.isAbsolute(file)) throw mediaError('QQ_MEDIA_PATH_INVALID')
  const lexical = path.relative(mediaRoot, file)
  if (lexical === '' || lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
    throw mediaError('QQ_MEDIA_PATH_OUTSIDE_ROOT')
  }

  let entry
  try {
    entry = fs.lstatSync(file)
  } catch {
    throw mediaError('QQ_MEDIA_PATH_INVALID')
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw mediaError('QQ_MEDIA_PATH_INVALID')

  let real
  try {
    real = fs.realpathSync(file)
  } catch {
    throw mediaError('QQ_MEDIA_PATH_INVALID')
  }
  const relative = path.relative(root, real)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw mediaError('QQ_MEDIA_PATH_OUTSIDE_ROOT')
  }

  let cursor = mediaRoot
  for (const part of lexical.split(path.sep)) {
    cursor = path.join(cursor, part)
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw mediaError('QQ_MEDIA_PATH_INVALID')
    } catch (error) {
      if (error.code === 'QQ_MEDIA_PATH_INVALID') throw error
      throw mediaError('QQ_MEDIA_PATH_INVALID')
    }
  }
  return real
}

function withTimeout(promise, timeoutMs, code) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(mediaError(code)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readBoundedAudio(file) {
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) throw mediaError('QQ_MEDIA_READ_FAILED')
    if (stats.size <= 0) throw mediaError('QQ_MEDIA_EMPTY')
    if (stats.size > MAX_AUDIO_BYTES) throw mediaError('QQ_MEDIA_TOO_LARGE')
    const data = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead <= 0) throw mediaError('QQ_MEDIA_READ_FAILED')
      offset += bytesRead
    }
    return data
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('QQ_MEDIA_')) throw error
    throw mediaError('QQ_MEDIA_READ_FAILED')
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Validate the canonical 16 kHz mono PCM16 WAV accepted by the local provider. */
function validateWav(data) {
  if (data.length < 46 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WAVE' ||
    data.toString('ascii', 12, 16) !== 'fmt ' ||
    data.readUInt32LE(16) !== 16 ||
    data.readUInt16LE(20) !== 1 ||
    data.readUInt16LE(22) !== 1 ||
    data.readUInt32LE(24) !== 16000 ||
    data.readUInt32LE(28) !== 32000 ||
    data.readUInt16LE(32) !== 2 ||
    data.readUInt16LE(34) !== 16 ||
    data.toString('ascii', 36, 40) !== 'data' ||
    data.readUInt32LE(4) !== data.length - 8 ||
    data.readUInt32LE(40) !== data.length - 44 ||
    (data.length - 44) % 2 !== 0) {
    throw mediaError('QQ_MEDIA_INVALID_WAV')
  }
  const seconds = (data.length - 44) / 32000
  if (seconds > MAX_DURATION_SECONDS) throw mediaError('QQ_MEDIA_AUDIO_TOO_LONG')
  return seconds
}

function selectLocalProvider(speechToText, providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) throw mediaError('QQ_ASR_PROVIDER_REQUIRED')
  if (!speechToText ||
    typeof speechToText.listProviders !== 'function' ||
    typeof speechToText.resolve !== 'function' ||
    typeof speechToText.transcribe !== 'function') {
    throw mediaError('QQ_ASR_UNAVAILABLE')
  }
  let providers
  try {
    providers = speechToText.listProviders()
  } catch {
    throw mediaError('QQ_ASR_UNAVAILABLE')
  }
  const provider = Array.isArray(providers) ? providers.find(item => item?.id === providerId) : null
  if (!provider) throw mediaError('QQ_ASR_PROVIDER_UNAVAILABLE')
  // Local-only v1: sending a QQ recording to a remote recognizer is an explicit
  // deployment decision that this capability does not take implicitly.
  if (provider.location !== 'host-local') throw mediaError('QQ_ASR_PROVIDER_REMOTE_FORBIDDEN')
}

function sanitizeTranscript(text) {
  if (typeof text !== 'string') throw mediaError('QQ_ASR_INVALID_RESULT')
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (clean.length === 0) throw mediaError('QQ_ASR_EMPTY_RESULT')
  if (clean.length > MAX_TRANSCRIPT_CHARS) throw mediaError('QQ_ASR_RESULT_TOO_LARGE')
  return clean
}

/**
 * Transcribe one inbound QQ voice record through the explicitly configured
 * local ASR provider. The model supplies only messageId and record ordinal;
 * Scene, record handle, path, provider, and audio never come from model args.
 */
export async function transcribeMessageRecord({
  core,
  store,
  transport,
  speechToText,
  mediaRoot,
  providerId,
  sessionId,
  messageId,
  index = 0,
}) {
  if (!Number.isSafeInteger(index) || index < 0) throw mediaError('QQ_MEDIA_INDEX_INVALID')
  if (!transport || typeof transport.action !== 'function') throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')
  if (transport.status !== undefined && transport.status !== 'connected') throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')

  const scene = authorizeScene(core, sessionId)
  assertMediaRead(core, sessionId)

  const root = resolveMediaRoot(mediaRoot)
  selectLocalProvider(speechToText, providerId)

  let id
  try {
    id = normalizeMessageId(messageId, 'messageId')
  } catch {
    throw mediaError('QQ_MEDIA_MESSAGE_INVALID')
  }
  const row = store.getScene(scene)
  const message = row?.messages?.find(item => item.messageId === id)
  if (!message) throw mediaError('QQ_MESSAGE_SCOPE')

  let segments
  try {
    segments = sanitizeInboundSegments(message.segments)
  } catch {
    throw mediaError('QQ_MEDIA_MESSAGE_INVALID')
  }
  const record = segments.filter(segment => segment.type === 'record')[index]
  const file = record?.data?.file
  if (typeof file !== 'string' || file.length === 0) throw mediaError('QQ_MEDIA_RECORD_UNAVAILABLE')

  let response
  try {
    response = await transport.action('get_record', { file, out_format: 'wav' }, PLATFORM_TIMEOUT_MS)
  } catch {
    throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')
  }
  assertMediaRead(core, sessionId, true)
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.file !== 'string') {
    throw mediaError('QQ_MEDIA_LOCAL_FILE_UNAVAILABLE')
  }

  const localFile = resolveLocalAudio(response.file, root, mediaRoot)
  const audio = await withTimeout(readBoundedAudio(localFile), READ_TIMEOUT_MS, 'QQ_MEDIA_TIMEOUT')
  validateWav(audio)

  assertMediaRead(core, sessionId, true)
  let spec
  try {
    spec = speechToText.resolve({ audio, providerId })
  } catch {
    throw mediaError('QQ_ASR_PROVIDER_UNAVAILABLE')
  }

  let result
  try {
    result = await speechToText.transcribe(spec, AbortSignal.timeout(ASR_TIMEOUT_MS))
  } catch {
    throw mediaError('QQ_ASR_FAILED')
  }
  assertMediaRead(core, sessionId, true)
  return { text: sanitizeTranscript(result?.text) }
}
