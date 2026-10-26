import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MIB = 1024 * 1024
export const OUTBOUND_MEDIA_LIMITS = Object.freeze({
  image: 5 * MIB,
  gif: 5 * MIB,
  video: 20 * MIB,
  file: 20 * MIB,
  audio: 4 * MIB,
})
export const TTS_UNAVAILABLE_CODE = 'QQ_TTS_UNAVAILABLE'

const BLOCKED_FILE_EXTENSIONS = new Set([
  '.bat', '.cmd', '.com', '.dll', '.exe', '.hta', '.js', '.jse', '.lnk',
  '.msi', '.msp', '.ps1', '.scr', '.vbe', '.vbs', '.wsf', '.wsh',
])

function mediaError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function assertSend(core, sessionId) {
  let scene
  try {
    scene = core.authorizedScene(sessionId)
  } catch {
    throw mediaError('QQ_PERMISSION_DENIED: qq.send')
  }
  let allowed = false
  try {
    allowed = core.authorizeSessionCapability(sessionId, 'qq.send') === true
  } catch {
    allowed = false
  }
  if (!allowed) throw mediaError('QQ_PERMISSION_DENIED: qq.send')
  return scene
}

function resolveSendRoot(sendRoot) {
  if (typeof sendRoot !== 'string' || !path.isAbsolute(sendRoot)) throw mediaError('QQ_MEDIA_ROOT_INVALID')
  let root
  try {
    root = fs.realpathSync(sendRoot)
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory')
  } catch {
    throw mediaError('QQ_MEDIA_ROOT_INVALID')
  }
  return root
}

function resolveRootSource(relative, root, sendRoot) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\u0000')) {
    throw mediaError('QQ_MEDIA_PATH_INVALID')
  }
  if (path.isAbsolute(relative)) throw mediaError('QQ_MEDIA_PATH_INVALID')
  const candidate = path.resolve(sendRoot, relative)
  const lexical = path.relative(sendRoot, candidate)
  if (lexical === '' || lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
    throw mediaError('QQ_MEDIA_PATH_OUTSIDE_ROOT')
  }

  let entry
  try {
    entry = fs.lstatSync(candidate)
  } catch {
    throw mediaError('QQ_MEDIA_PATH_INVALID')
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw mediaError('QQ_MEDIA_PATH_INVALID')

  let real
  try {
    real = fs.realpathSync(candidate)
  } catch {
    throw mediaError('QQ_MEDIA_PATH_INVALID')
  }
  const relativeReal = path.relative(root, real)
  if (relativeReal === '' || relativeReal === '..' ||
    relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    throw mediaError('QQ_MEDIA_PATH_OUTSIDE_ROOT')
  }

  let cursor = sendRoot
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

function resolveHostAttachment(source, kind, attachments) {
  const ref = source.attachment
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
    typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) ||
    typeof ref.name !== 'string' || typeof ref.bytes !== 'number' ||
    !Number.isSafeInteger(ref.bytes) || ref.bytes < 1) {
    throw mediaError('QQ_MEDIA_ATTACHMENT_INVALID')
  }
  if (!attachments || typeof attachments !== 'object') throw mediaError('QQ_MEDIA_ATTACHMENTS_UNAVAILABLE')
  const resolver = kind === 'image' || kind === 'gif' ? attachments.imageHostPath : attachments.fileHostPath
  if (typeof resolver !== 'function') throw mediaError('QQ_MEDIA_ATTACHMENTS_UNAVAILABLE')
  let hostPath
  try {
    hostPath = resolver.call(attachments, ref)
  } catch {
    throw mediaError('QQ_MEDIA_ATTACHMENT_INVALID')
  }
  if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) throw mediaError('QQ_MEDIA_ATTACHMENT_INVALID')
  return hostPath
}

function statRegularFile(file) {
  let entry
  try {
    entry = fs.lstatSync(file)
  } catch {
    throw mediaError('QQ_MEDIA_PATH_INVALID')
  }
  if (entry.isSymbolicLink() || !entry.isFile()) throw mediaError('QQ_MEDIA_PATH_INVALID')
  return entry
}

function sniffKind(kind, data, name) {
  if (kind === 'image') {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    throw mediaError('QQ_MEDIA_FORMAT_INVALID')
  }
  if (kind === 'gif') {
    if (data.length >= 6 && (data.toString('ascii', 0, 6) === 'GIF87a' || data.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
    throw mediaError('QQ_MEDIA_FORMAT_INVALID')
  }
  if (kind === 'video') {
    if (data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
    if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return 'video/webm'
    throw mediaError('QQ_MEDIA_FORMAT_INVALID')
  }
  if (kind === 'audio') {
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
    if (data.length >= 3 && data.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg'
    if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'audio/mpeg'
    if (data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
    if (data.length >= 4 && data.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac'
    if (data.length >= 6 && data.toString('ascii', 0, 6) === '#!AMR\n') return 'audio/amr'
    throw mediaError('QQ_MEDIA_FORMAT_INVALID')
  }
  if (kind === 'file') {
    const extension = path.extname(name).toLowerCase()
    if (!extension || BLOCKED_FILE_EXTENSIONS.has(extension)) throw mediaError('QQ_MEDIA_FORMAT_INVALID')
    return 'application/octet-stream'
  }
  throw mediaError('QQ_MEDIA_UNSUPPORTED_KIND')
}

async function readAndHash(file, maxBytes) {
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
    const stats = await handle.stat()
    if (!stats.isFile()) throw mediaError('QQ_MEDIA_PATH_INVALID')
    if (stats.size <= 0) throw mediaError('QQ_MEDIA_EMPTY')
    if (stats.size > maxBytes) throw mediaError('QQ_MEDIA_TOO_LARGE')
    const data = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead <= 0) throw mediaError('QQ_MEDIA_READ_FAILED')
      offset += bytesRead
    }
    return { data, sha256: createHash('sha256').update(data).digest('hex') }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('QQ_MEDIA_')) throw error
    throw mediaError('QQ_MEDIA_READ_FAILED')
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function safeName(value, kind) {
  const base = path.basename(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (base.length === 0) return kind === 'video' ? 'qq-video' : 'qq-file'
  return base.slice(0, 128)
}

/**
 * Validate one controlled PNG/JPEG/GIF below sendRoot and copy the exact bytes
 * into a private temporary snapshot for one platform call. The caller owns
 * cleanup and must never expose the snapshot path to model output.
 */
export async function snapshotControlledImage({ sendRoot, relativePath, tempRoot } = {}) {
  const root = resolveSendRoot(sendRoot)
  const source = resolveRootSource(relativePath, root, sendRoot)
  const { data, sha256 } = await readAndHash(source, 5 * MIB)
  let mediaType
  try {
    mediaType = sniffKind('image', data, path.basename(source))
  } catch {
    mediaType = sniffKind('gif', data, path.basename(source))
  }
  if (tempRoot !== undefined && (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot))) {
    throw mediaError('QQ_MEDIA_TEMP_INVALID')
  }
  let tempDir
  try {
    if (tempRoot !== undefined && !fs.statSync(tempRoot).isDirectory()) throw new Error('not a directory')
    tempDir = await fs.promises.mkdtemp(path.join(tempRoot ?? os.tmpdir(), 'amadeus-qq-avatar-'))
    await fs.promises.chmod(tempDir, 0o700)
    const extension = mediaType === 'image/png' ? '.png' : mediaType === 'image/jpeg' ? '.jpg' : '.gif'
    const snapshot = path.join(tempDir, `avatar${extension}`)
    await fs.promises.writeFile(snapshot, data, { flag: 'wx', mode: 0o600 })
    const written = await fs.promises.readFile(snapshot)
    if (written.length !== data.length || createHash('sha256').update(written).digest('hex') !== sha256) {
      throw mediaError('QQ_MEDIA_SNAPSHOT_INVALID')
    }
    let cleaned = false
    return {
      path: snapshot,
      mediaType,
      bytes: data.length,
      sha256,
      async cleanup() {
        if (cleaned) return
        cleaned = true
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch (error) {
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    if (typeof error?.code === 'string' && error.code.startsWith('QQ_MEDIA_')) throw error
    throw mediaError('QQ_MEDIA_SNAPSHOT_FAILED')
  }
}

/**
 * Build one controlled outbound media plan. `source` must be either a relative
 * path below the configured sendRoot, or an already-validated Host attachment
 * reference owned by the caller. Never pass model-supplied paths, URLs or
 * base64 into this helper. Message plans are ready for core.send(); upload
 * plans require the core's delivery ledger with the returned fingerprint.
 */
export async function prepareOutboundMedia({
  core,
  sessionId,
  kind,
  source,
  sendRoot,
  attachments,
}) {
  if (kind === 'voice' || kind === 'record') throw mediaError(TTS_UNAVAILABLE_CODE)
  if (!Object.hasOwn(OUTBOUND_MEDIA_LIMITS, kind)) throw mediaError('QQ_MEDIA_UNSUPPORTED_KIND')
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw mediaError('QQ_MEDIA_SOURCE_INVALID')

  const scene = assertSend(core, sessionId)
  const maxBytes = OUTBOUND_MEDIA_LIMITS[kind]
  let root
  let file
  if (source.type === 'send-root') {
    if (Object.keys(source).sort().join(',') !== 'path,type') throw mediaError('QQ_MEDIA_SOURCE_INVALID')
    root = resolveSendRoot(sendRoot)
    file = resolveRootSource(source.path, root, sendRoot)
  } else if (source.type === 'host-attachment') {
    if (Object.keys(source).sort().join(',') !== 'attachment,type') throw mediaError('QQ_MEDIA_SOURCE_INVALID')
    file = resolveHostAttachment(source, kind, attachments)
    statRegularFile(file)
  } else {
    throw mediaError('QQ_MEDIA_SOURCE_INVALID')
  }

  const { data, sha256 } = await readAndHash(file, maxBytes)
  const name = safeName(path.basename(file), kind)
  const mediaType = sniffKind(kind, data, name)

  // Re-check the bound Scene immediately before returning an executable plan.
  assertSend(core, sessionId)

  if (kind === 'file') {
    const group = scene.kind === 'group'
    return {
      mode: 'upload',
      action: group ? 'upload_group_file' : 'upload_private_file',
      params: group
        ? { group_id: scene.peerId, file, name, upload_file: true }
        : { user_id: scene.peerId, file, name, upload_file: true },
      mediaType,
      bytes: data.length,
      fingerprint: sha256,
    }
  }
  return {
    mode: 'message',
    segments: [{
      type: kind === 'video' ? 'video' : kind === 'audio' ? 'record' : 'image',
      data: { file },
    }],
    mediaType,
    bytes: data.length,
    fingerprint: sha256,
  }
}
