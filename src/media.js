import fs from 'node:fs'
import path from 'node:path'
import { normalizeMessageId } from './storage.js'
import { sanitizeInboundSegments } from './onebot.js'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const READ_TIMEOUT_MS = 5_000
const PLATFORM_TIMEOUT_MS = 10_000

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

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

function resolveLocalImage(file, root, mediaRoot) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\u0000')) throw mediaError('QQ_MEDIA_PATH_INVALID')
  // Reject UNC paths and URI schemes. A Windows drive path is the only
  // scheme-like form accepted, and it must still be absolute.
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

  // A link anywhere on the submitted path makes the accepted object
  // ambiguous. Check the lexical path below mediaRoot as well as the resolved
  // path; realpath containment separately rejects any link that escapes root.
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

function sniffImageMediaType(data) {
  if (data.length >= PNG_SIGNATURE.length && data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png'
  if (data.length >= JPEG_SIGNATURE.length && data.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'image/jpeg'
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString('latin1')
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

function withTimeout(promise, timeoutMs, code) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(mediaError(code)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readBoundedImage(file) {
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) throw mediaError('QQ_MEDIA_READ_FAILED')
    if (stats.size <= 0) throw mediaError('QQ_MEDIA_EMPTY')
    if (stats.size > MAX_IMAGE_BYTES) throw mediaError('QQ_MEDIA_TOO_LARGE')
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

/**
 * Read one inbound QQ image through the bound Scene and hand bounded bytes to
 * the official attachment service. The model supplies only messageId and an
 * image ordinal; Scene, file handle, and local path never come from model args.
 */
export async function readMessageImage({
  core,
  store,
  transport,
  attachments,
  mediaRoot,
  sessionId,
  messageId,
  index = 0,
}) {
  if (!Number.isSafeInteger(index) || index < 0) throw mediaError('QQ_MEDIA_INDEX_INVALID')
  if (!attachments || typeof attachments.saveImage !== 'function') throw mediaError('QQ_MEDIA_ATTACHMENTS_UNAVAILABLE')
  if (!transport || typeof transport.action !== 'function') throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')
  if (transport.status !== undefined && transport.status !== 'connected') throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')

  let scene
  try {
    scene = core.authorizedScene(sessionId)
  } catch {
    throw permissionError('QQ_PERMISSION_DENIED')
  }
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
  const image = segments.filter(segment => segment.type === 'image')[index]
  const file = image?.data?.file
  if (typeof file !== 'string' || file.length === 0) throw mediaError('QQ_MEDIA_UNAVAILABLE')

  let response
  try {
    response = await transport.action('get_image', { file }, PLATFORM_TIMEOUT_MS)
  } catch {
    throw mediaError('QQ_MEDIA_BACKEND_UNAVAILABLE')
  }

  // The platform call is the last unbounded external step: a Scene revocation
  // while it was in flight must stop path access and attachment admission.
  assertMediaRead(core, sessionId, true)
  if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.file !== 'string') {
    throw mediaError('QQ_MEDIA_LOCAL_FILE_UNAVAILABLE')
  }

  const localFile = resolveLocalImage(response.file, root, mediaRoot)
  const data = await withTimeout(readBoundedImage(localFile), READ_TIMEOUT_MS, 'QQ_MEDIA_TIMEOUT')
  const mediaType = sniffImageMediaType(data)
  if (mediaType === null) throw mediaError('QQ_MEDIA_UNSUPPORTED_IMAGE')

  assertMediaRead(core, sessionId, true)
  let attachment
  try {
    attachment = await attachments.saveImage({ data, mediaType })
  } catch {
    throw mediaError('QQ_MEDIA_ATTACHMENT_REJECTED')
  }
  // Host admission can itself be asynchronous. A revocation during that wait
  // must not hand the image block to the Agent, even if the Host cached bytes.
  assertMediaRead(core, sessionId, true)
  if (!attachment || typeof attachment !== 'object' || typeof attachment.attachmentId !== 'string') {
    throw mediaError('QQ_MEDIA_ATTACHMENT_INVALID')
  }
  return { attachment }
}
