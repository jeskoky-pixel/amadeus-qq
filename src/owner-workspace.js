// Restricted Owner workspace: the only sanctioned file surface for the Owner
// Agent. It never exposes a shell, never accepts absolute paths, and confines
// every operation to one operator-configured directory. Writes require a real
// Host approval ask for that single call; a missing approval service denies.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const OWNER_WORKSPACE_TOOL = 'qq_owner_workspace'
export const OWNER_WORKSPACE_CAPABILITY = 'qq.owner.workspace'
export const DEFAULT_MAX_BYTES = 64 * 1024
export const MAX_ALLOWED_BYTES = 256 * 1024
export const MAX_PATH_CHARS = 512

const MAX_SEGMENTS = 32
const DENIED_SEGMENTS = new Set([
  '.credentials.yaml', '.credentials', 'credentials.yaml', 'credentials.yml', 'auth.json',
])

function ownerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

const PATH_INVALID = () => ownerError('QQ_OWNER_WORKSPACE_PATH_INVALID', 'owner workspace path is invalid')
const PATH_OUTSIDE = () => ownerError('QQ_OWNER_WORKSPACE_PATH_OUTSIDE', 'owner workspace path escapes the configured directory')
const SYMLINK = () => ownerError('QQ_OWNER_WORKSPACE_PATH_UNSAFE', 'owner workspace path uses a symbolic link')
const TOO_LARGE = () => ownerError('QQ_OWNER_WORKSPACE_TOO_LARGE', 'owner workspace content exceeds the configured limit')
const NOT_UTF8 = () => ownerError('QQ_OWNER_WORKSPACE_NOT_UTF8', 'owner workspace file is not UTF-8 text')
const UNAVAILABLE = () => ownerError('QQ_OWNER_WORKSPACE_UNAVAILABLE', 'owner workspace is not configured')
const REVOKED = () => ownerError('QQ_OWNER_WORKSPACE_REVOKED', 'owner workspace authorization is no longer valid')
const APPROVAL_UNAVAILABLE = () => ownerError('QQ_OWNER_WORKSPACE_APPROVAL_UNAVAILABLE', 'owner workspace write approval is unavailable')
const UNAPPROVED = () => ownerError('QQ_OWNER_WORKSPACE_UNAPPROVED', 'owner workspace write was not approved')

/** Parse the preset-row owner workspace knobs. Invalid values fail activation. */
export function resolveOwnerWorkspacePolicy(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('owner workspace config must be an object')
  }
  const root = config.ownerWorkspaceRoot === undefined ? '' : config.ownerWorkspaceRoot
  if (typeof root !== 'string') throw new TypeError('ownerWorkspaceRoot must be a string')
  const allowWrite = config.ownerWorkspaceWrites === undefined ? false : config.ownerWorkspaceWrites
  if (typeof allowWrite !== 'boolean') throw new TypeError('ownerWorkspaceWrites must be a boolean')
  const maxBytes = config.ownerWorkspaceMaxBytes === undefined ? DEFAULT_MAX_BYTES : config.ownerWorkspaceMaxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ALLOWED_BYTES) {
    throw new TypeError('ownerWorkspaceMaxBytes must be an integer from 1 to ' + MAX_ALLOWED_BYTES)
  }
  if (root !== '' && (!path.isAbsolute(root) || path.parse(root).root === root)) {
    throw new TypeError('ownerWorkspaceRoot must be an absolute non-root directory')
  }
  return Object.freeze({ root: root === '' ? '' : path.resolve(root), allowWrite, maxBytes })
}

/** True for one path segment that must never be reachable through this surface. */
export function isDeniedOwnerSegment(segment) {
  if (typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..') return true
  if (segment.includes('\u0000') || segment.includes(':') || segment.includes('/') || segment.includes('\\')) return true
  if (segment.startsWith('.')) return true
  return DENIED_SEGMENTS.has(segment.toLowerCase())
}

/** Split and validate a model-supplied relative path into safe segments. */
export function ownerPathSegments(requested) {
  if (typeof requested !== 'string') throw PATH_INVALID()
  if (requested.length === 0 || requested.length > MAX_PATH_CHARS) throw PATH_INVALID()
  if (requested.includes('\u0000')) throw PATH_INVALID()
  if (path.isAbsolute(requested) || /^[A-Za-z]:/.test(requested) || /^[\\/]{2}/.test(requested)) throw PATH_INVALID()
  const segments = requested.split(/[\\/]/)
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) throw PATH_INVALID()
  if (segments.some(isDeniedOwnerSegment)) throw PATH_INVALID()
  return segments
}

async function resolveRoot(root) {
  if (typeof root !== 'string' || root === '') throw UNAVAILABLE()
  let real
  try {
    real = await fs.realpath(root)
  } catch {
    throw UNAVAILABLE()
  }
  const stat = await fs.lstat(real)
  if (!stat.isDirectory()) throw UNAVAILABLE()
  if (path.parse(real).root === real) throw UNAVAILABLE()
  return real
}

function contained(root, target) {
  if (target === root) return true
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Resolve one relative owner path. Existing components must not be symlinks,
 * and the final target must canonicalize inside the configured root.
 */
export async function resolveOwnerWorkspacePath(root, requested) {
  const segments = ownerPathSegments(requested)
  const rootReal = await resolveRoot(root)
  let cursor = rootReal
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index])
    let stat
    try {
      stat = await fs.lstat(cursor)
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw PATH_INVALID()
    }
    if (stat.isSymbolicLink()) throw SYMLINK()
    if (index < segments.length - 1 && !stat.isDirectory()) throw PATH_INVALID()
  }
  let absolute = path.join(rootReal, ...segments)
  let exists = false
  let targetReal = absolute
  try {
    const stat = await fs.lstat(absolute)
    if (stat.isSymbolicLink()) throw SYMLINK()
    exists = true
    targetReal = await fs.realpath(absolute)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error?.code ? error : PATH_INVALID()
  }
  if (exists && !contained(rootReal, targetReal)) throw PATH_OUTSIDE()
  if (!exists) {
    const parent = path.dirname(absolute)
    let parentReal
    try {
      parentReal = await fs.realpath(parent)
    } catch {
      throw PATH_INVALID()
    }
    if (!contained(rootReal, parentReal)) throw PATH_OUTSIDE()
  }
  return { absolute, rootReal, relative: segments.join('/'), exists }
}

/** Read one UTF-8 file from the owner workspace. No approval is needed to read. */
export async function readOwnerWorkspaceFile({ root, requested, maxBytes = DEFAULT_MAX_BYTES, authorize, signal }) {
  if (typeof authorize === 'function') await assertAuthorized(authorize, signal)
  const resolved = await resolveOwnerWorkspacePath(root, requested)
  if (!resolved.exists) throw PATH_INVALID()
  let handle
  try {
    handle = await fs.open(resolved.absolute, 'r')
  } catch {
    throw PATH_INVALID()
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw PATH_INVALID()
    if (stat.size > maxBytes) throw TOO_LARGE()
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) throw TOO_LARGE()
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw NOT_UTF8()
    // Revocation may land while the read is in flight; recheck before the body
    // is handed to the model.
    if (typeof authorize === 'function') await assertAuthorized(authorize, signal)
    return { name: path.basename(resolved.absolute), bytes: bytes.length, text }
  } finally {
    await handle.close().catch(() => {})
  }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw REVOKED()
}

async function assertAuthorized(authorize, signal) {
  assertNotAborted(signal)
  if (typeof authorize !== 'function' || (await authorize()) !== true) throw REVOKED()
}

/**
 * Ask the Host approval service for this one write. The request carries only
 * the tool name and a fixed reason; no path, content, credential or URL.
 */
export async function requestOwnerWriteApproval({ approval, agent, callId, signal }) {
  if (!approval || typeof approval.request !== 'function') throw APPROVAL_UNAVAILABLE()
  let outcome
  try {
    outcome = await approval.request({
      agent,
      toolName: OWNER_WORKSPACE_TOOL,
      callId,
      reason: 'Owner workspace write requires approval',
      signal,
    })
  } catch {
    throw APPROVAL_UNAVAILABLE()
  }
  if (outcome !== 'allowed-once') throw UNAPPROVED()
}

/**
 * Write one UTF-8 file inside the owner workspace. The write is temp-then-rename
 * so a failure leaves any existing file untouched; authorization and the abort
 * signal are rechecked after approval and immediately before the commit.
 */
export async function writeOwnerWorkspaceFile({
  root, requested, content, maxBytes = DEFAULT_MAX_BYTES,
  authorize, approve, signal,
}) {
  if (typeof content !== 'string') throw PATH_INVALID()
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > maxBytes) throw TOO_LARGE()
  await assertAuthorized(authorize, signal)
  const resolved = await resolveOwnerWorkspacePath(root, requested)
  assertNotAborted(signal)
  if (typeof approve !== 'function') throw APPROVAL_UNAVAILABLE()
  await approve()
  await assertAuthorized(authorize, signal)
  assertNotAborted(signal)
  // Re-resolve after approval so a replacement during the ask cannot redirect us.
  const confirmed = await resolveOwnerWorkspacePath(root, requested)
  if (confirmed.absolute !== resolved.absolute) throw PATH_INVALID()
  const temporary = path.join(path.dirname(confirmed.absolute), '.qq-owner-' + randomUUID() + '.tmp')
  let created = true
  try {
    const existing = await fs.lstat(confirmed.absolute)
    created = !existing.isFile()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw PATH_INVALID()
  }
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (signal?.aborted) throw REVOKED()
    await assertAuthorized(authorize, signal)
    await fs.rename(temporary, confirmed.absolute)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error?.code ? error : PATH_INVALID()
  }
  return { name: path.basename(confirmed.absolute), bytes: bytes.length, created }
}

/** Fixed, model-facing text; never includes an absolute path or raw reason. */
function ownerErrorText(error) {
  switch (error?.code) {
    case 'QQ_OWNER_WORKSPACE_PATH_INVALID': return 'Invalid owner workspace path.'
    case 'QQ_OWNER_WORKSPACE_PATH_OUTSIDE': return 'Path is outside the owner workspace.'
    case 'QQ_OWNER_WORKSPACE_PATH_UNSAFE': return 'Symbolic links are not allowed in the owner workspace.'
    case 'QQ_OWNER_WORKSPACE_TOO_LARGE': return 'File exceeds the owner workspace size limit.'
    case 'QQ_OWNER_WORKSPACE_NOT_UTF8': return 'Only UTF-8 text files can be read here.'
    case 'QQ_OWNER_WORKSPACE_APPROVAL_UNAVAILABLE': return 'Owner workspace write approval is unavailable; nothing was written.'
    case 'QQ_OWNER_WORKSPACE_UNAPPROVED': return 'Owner workspace write was not approved; nothing was written.'
    case 'QQ_OWNER_WORKSPACE_REVOKED': return 'Owner workspace authorization is no longer valid.'
    default: return 'Owner workspace operation failed.'
  }
}

/**
 * Build the model-facing tool. It is only registered by an Owner preset
 * (level 4) that also configures a root; it is never visible otherwise.
 */
export function createOwnerWorkspaceTool({ root, allowWrite, maxBytes, getService, getApproval }) {
  return {
    name: OWNER_WORKSPACE_TOOL,
    description: 'Read or write UTF-8 files inside the configured Owner workspace only. This is not a shell and cannot reach other directories.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['read', 'write'] },
        path: { type: 'string', description: 'Relative path inside the Owner workspace.' },
        content: { type: 'string', description: 'UTF-8 text to write (write only).' },
      },
      required: ['op', 'path'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value?.op === 'read'
          ? String(value.text ?? '')
          : JSON.stringify({ op: value?.op, name: value?.name, bytes: value?.bytes, created: value?.created }),
      }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Owner workspace requires a bound DSH Session.')
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Owner workspace arguments are invalid.')
      const keys = Object.keys(args)
      if (keys.some(key => !['op', 'path', 'content'].includes(key))) throw new Error('Owner workspace arguments are invalid.')
      if (args.op !== 'read' && args.op !== 'write') throw new Error('Owner workspace op must be read or write.')
      if (typeof args.path !== 'string') throw new Error('Owner workspace path is invalid.')
      if (args.op === 'write' && typeof args.content !== 'string') throw new Error('Owner workspace write requires content.')
      const service = typeof getService === 'function' ? getService() : undefined
      const authorize = () => {
        try {
          const scene = service?.resolveTrustedSessionScene?.(sessionId)
          if (!scene || scene.admin !== true) return false
          return service?.authorizeSessionCapability?.(sessionId, OWNER_WORKSPACE_CAPABILITY) === true
        } catch {
          return false
        }
      }
      try {
        if (args.op === 'read') {
          if (!authorize()) throw REVOKED()
          const file = await readOwnerWorkspaceFile({
            root,
            requested: args.path,
            maxBytes,
            authorize,
            signal: exec?.signal,
          })
          return {
            op: 'read',
            name: file.name,
            bytes: file.bytes,
            text: file.text,
          }
        }
        if (!allowWrite) throw ownerError('QQ_OWNER_WORKSPACE_WRITE_DISABLED', 'owner workspace writes are disabled')
        if (!authorize()) throw REVOKED()
        const result = await writeOwnerWorkspaceFile({
          root,
          requested: args.path,
          content: args.content,
          maxBytes,
          signal: exec?.signal,
          authorize,
          approve: () => requestOwnerWriteApproval({
            approval: typeof getApproval === 'function' ? getApproval() : undefined,
            agent: exec?.agent,
            callId: exec?.callId,
            signal: exec?.signal,
          }),
        })
        return { op: 'write', name: result.name, bytes: result.bytes, created: result.created }
      } catch (error) {
        throw new Error(ownerErrorText(error))
      }
    },
  }
}

// Read-only management metadata for the Settings page. No absolute path, no
// file list: only whether the feature is configured and what it allows.
let runtimeStatus = Object.freeze({ configured: false, writes: false, maxBytes: DEFAULT_MAX_BYTES })

export function setOwnerWorkspaceStatus(status) {
  const source = status ?? {}
  runtimeStatus = Object.freeze({
    configured: source.configured === true,
    writes: source.writes === true,
    maxBytes: Number.isSafeInteger(source.maxBytes) && source.maxBytes > 0 ? source.maxBytes : DEFAULT_MAX_BYTES,
  })
}

export function ownerWorkspaceStatus() {
  return runtimeStatus
}

export function resetOwnerWorkspaceStatus() {
  runtimeStatus = Object.freeze({ configured: false, writes: false, maxBytes: DEFAULT_MAX_BYTES })
}

// Provider status for the Settings page. No process starts or credentials are
// read here; the connector wires these once media send and QZone exist.
const EMPTY_PROVIDER = Object.freeze({ installed: false, configured: false, enabled: false })
let providerRuntime = Object.freeze({ mediaSend: EMPTY_PROVIDER, qzone: EMPTY_PROVIDER })

export function setProviderStatus(patch = {}) {
  const pick = source => Object.freeze({
    installed: source?.installed === true,
    configured: source?.configured === true,
    enabled: source?.enabled === true,
  })
  providerRuntime = Object.freeze({
    mediaSend: pick(patch.mediaSend ?? providerRuntime.mediaSend),
    qzone: pick(patch.qzone ?? providerRuntime.qzone),
  })
}

export function providerStatus() {
  return providerRuntime
}

export function resetProviderStatus() {
  providerRuntime = Object.freeze({ mediaSend: EMPTY_PROVIDER, qzone: EMPTY_PROVIDER })
}
