import fs from 'node:fs'
import path from 'node:path'
import { normalizeMessageId } from './storage.js'
import { sanitizeInboundSegments } from './onebot.js'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4
const READ_TIMEOUT_MS = 5_000
const PLATFORM_TIMEOUT_MS = 10_000

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

function resolveLocalFile(file, root, mediaRoot) {
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

async function readBoundedFile(file) {
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) throw mediaError('QQ_MEDIA_READ_FAILED')
    if (stats.size <= 0) throw mediaError('QQ_MEDIA_EMPTY')
    if (stats.size > MAX_FILE_BYTES) throw mediaError('QQ_MEDIA_TOO_LARGE')
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

function decodeInlineFile(value) {
  if (typeof value !== 'string' || value.length === 0) throw mediaError('QQ_MEDIA_INLINE_INVALID')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^data:/i.test(value)) {
    throw mediaError('QQ_MEDIA_INLINE_INVALID')
  }
  if (value.length > MAX_BASE64_CHARS) throw mediaError('QQ_MEDIA_INLINE_TOO_LARGE')
  let data
  try {
    data = Buffer.from(value, 'base64')
  } catch {
    throw mediaError('QQ_MEDIA_INLINE_INVALID')
  }
  if (data.length === 0) throw mediaError('QQ_MEDIA_INLINE_INVALID')
  if (data.length > MAX_FILE_BYTES) throw mediaError('QQ_MEDIA_INLINE_TOO_LARGE')
  if (data.toString('base64') !== value) throw mediaError('QQ_MEDIA_INLINE_INVALID')
  return data
}

async function readMessageAttachment({
  core,
  store,
  transport,
  attachments,
  mediaRoot,
  sessionId,
  messageId,
  index = 0,
  kind,
}) {
  if (!Number.isSafeInteger(index) || index < 0) throw mediaError('QQ_MEDIA_INDEX_INVALID')
  if (kind !== 'file' && kind !== 'video') throw mediaError('QQ_MEDIA_UNSUPPORTED_KIND')
  if (!attachments || typeof attachments.saveFile !== 'function') throw mediaError('QQ_MEDIA_ATTACHMENTS_UNAVAILABLE')
  if (!transport || typeof transport.action !== 'function') throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')
  if (transport.status !== undefined && transport.status !== 'connected') throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')

  const scene = authorizeScene(core, sessionId)
  assertMediaRead(core, sessionId)
  const root = resolveMediaRoot(mediaRoot)

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
  const segment = segments.filter(item => item.type === kind)[index]
  const handle = segment?.data?.file
  if (typeof handle !== 'string' || handle.length === 0) throw mediaError('QQ_MEDIA_UNAVAILABLE')

  let response
  try {
    response = await transport.action('get_file', { file: handle }, PLATFORM_TIMEOUT_MS, MAX_RESPONSE_BYTES)
  } catch (error) {
    throw mediaError(error?.code === 'ONEBOT_RESPONSE_TOO_LARGE'
      ? 'QQ_MEDIA_RESPONSE_TOO_LARGE'
      : 'QQ_MEDIA_BACKEND_UNAVAILABLE')
  }
  assertMediaRead(core, sessionId, true)
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw mediaError('QQ_MEDIA_LOCAL_FILE_UNAVAILABLE')
  }

  let data
  if (typeof response.file === 'string') {
    const localFile = resolveLocalFile(response.file, root, mediaRoot)
    data = await withTimeout(readBoundedFile(localFile), READ_TIMEOUT_MS, 'QQ_MEDIA_TIMEOUT')
  } else if (typeof response.base64 === 'string') {
    data = decodeInlineFile(response.base64)
  } else {
    throw mediaError('QQ_MEDIA_LOCAL_FILE_UNAVAILABLE')
  }

  assertMediaRead(core, sessionId, true)
  let attachment
  try {
    attachment = await attachments.saveFile({ data, name: kind === 'video' ? 'qq-video' : 'qq-file' })
  } catch {
    throw mediaError('QQ_MEDIA_ATTACHMENT_REJECTED')
  }
  assertMediaRead(core, sessionId, true)
  if (!attachment || typeof attachment !== 'object' || typeof attachment.attachmentId !== 'string') {
    throw mediaError('QQ_MEDIA_ATTACHMENT_INVALID')
  }
  return { attachment }
}

export function readMessageFile(input) {
  return readMessageAttachment({ ...input, kind: 'file' })
}

export function readMessageVideo(input) {
  return readMessageAttachment({ ...input, kind: 'video' })
}
