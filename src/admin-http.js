/**
 * Native management HTTP surface for per-Scene QQ permissions.
 *
 * Every request must be same-origin, pass the DSH Connection owner admission,
 * and POST requests must carry the `x-amadeus-qq: 1` marker. Loopback alone is
 * never authorization: the DSH `connection.admit(req)` result is the only
 * source of the owner principal. Model tools cannot reach this surface.
 */

import { sceneIdentity } from './storage.js'
import { validateScenePermissions } from './permissions.js'

export const ADMIN_PREFIX = '/api/amadeus-qq'
const MAX_BODY_BYTES = 64 * 1024

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * @param {Record<string, unknown>} req - Node request.
 * @returns {boolean} whether Host/Origin state permits a same-origin request.
 */
export function sameOrigin(req) {
  const host = String(req?.headers?.host ?? '')
  if (!host) return false
  if (req?.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req?.headers?.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(String(origin))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return parsed.host === host
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {Record<string, unknown>} payload - JSON body.
 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'",
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * @param {Record<string, unknown>} connection - DSH Connection service.
 * @param {Record<string, unknown>} req - incoming request.
 * @returns {{ok: true}|{ok: false, status: number, message: string}} decision.
 */
export function authorizeRequest(connection, req) {
  if (!connection || typeof connection.admit !== 'function') {
    return { ok: false, status: 503, message: 'native QQ management requires the DSH Connection service' }
  }
  let admission
  try {
    admission = connection.admit(req)
  } catch {
    return { ok: false, status: 403, message: 'request authentication failed' }
  }
  if (!admission || admission.rejection !== undefined) {
    const rejection = Number(admission?.rejection)
    const status = Number.isInteger(rejection) && rejection >= 400 && rejection <= 599 ? rejection : 403
    return { ok: false, status, message: 'DSH authentication is required' }
  }
  if (admission?.peer?.principal?.kind !== 'owner') {
    return { ok: false, status: 403, message: 'only the authenticated owner may manage QQ Scenes' }
  }
  return { ok: true }
}

/** @param {import('node:http').IncomingMessage} req - request. @returns {Promise<Record<string, unknown>>} parsed JSON object. */
async function readBody(req) {
  const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) throw new RequestError(400, 'POST requests require application/json')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) throw new RequestError(400, 'request body is required')
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'request body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError(400, 'request body must be a JSON object')
  }
  return parsed
}

/** @param {unknown} object @param {string[]} keys @param {string} label */
function exactKeys(object, keys, label) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) {
    throw new RequestError(400, `${label} must be an object`)
  }
  const actual = Object.keys(object).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RequestError(400, `${label} has unexpected or missing fields`)
  }
}

/** @param {Record<string, unknown>} body */
function parsePermissionRequest(body) {
  exactKeys(body, ['scene', 'access', 'expectedRevision'], 'request')
  exactKeys(body.scene, ['botId', 'kind', 'peerId'], 'scene')
  exactKeys(body.access, ['mode', 'overrides'], 'access')
  let scene
  try {
    scene = sceneIdentity(body.scene)
  } catch {
    throw new RequestError(400, 'scene is not a valid QQ Scene identity')
  }
  let access
  try {
    access = validateScenePermissions(body.access, { allowRevision: false })
  } catch {
    throw new RequestError(400, 'access is not a valid Scene permission request')
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw new RequestError(400, 'expectedRevision must be a non-negative integer')
  }
  return { scene, access, expectedRevision: body.expectedRevision }
}

/** @param {import('node:http').ServerResponse} res @param {unknown} error */
function sendFailure(res, error) {
  if (error?.code === 'QQ_PERMISSION_CONFLICT') {
    return send(res, 409, {
      ok: false,
      error: 'Scene permissions changed; reload before retrying',
      code: 'QQ_PERMISSION_CONFLICT',
      currentRevision: error.currentRevision,
    })
  }
  if (error instanceof RequestError) return send(res, error.status, { ok: false, error: error.message })
  if (error instanceof TypeError) return send(res, 400, { ok: false, error: 'invalid Scene or permission request' })
  if (error?.code === 'QQ_OWNER_AGENT_FORBIDDEN') {
    return send(res, 403, { ok: false, error: 'owner-agent is limited to a configured owner private Scene' })
  }
  const message = String(error?.message ?? '')
  if (message.startsWith('QQ_UNAUTHORIZED')) {
    return send(res, 403, { ok: false, error: 'Scene is outside the configured allowlist' })
  }
  if (message === 'QQ_SESSION_CANCEL_UNAVAILABLE' || message === 'QQ_SESSION_CANCEL_FAILED') {
    return send(res, 503, { ok: false, error: 'the previous QQ Session could not be cancelled safely' })
  }
  return send(res, 500, { ok: false, error: 'QQ management request failed' })
}

/**
 * Create the native management handler.
 * @param {import('./core.js').QQCore} core - QQ decision core.
 * @param {Record<string, unknown>|undefined} connection - DSH Connection service.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createAdminHandler(core, connection) {
  if (!core || typeof core.listScenePermissions !== 'function' || typeof core.setScenePermissions !== 'function') {
    throw new TypeError('createAdminHandler requires a QQCore')
  }
  return async function adminHandler(req, res) {
    const url = new URL(String(req?.url ?? '/'), 'http://localhost')
    if (!url.pathname.startsWith(ADMIN_PREFIX)) {
      return send(res, 404, { ok: false, error: 'not found' })
    }
    if (!sameOrigin(req)) return send(res, 403, { ok: false, error: 'same-origin request required' })
    if (req.method === 'POST' && req.headers?.['x-amadeus-qq'] !== '1') {
      return send(res, 403, { ok: false, error: 'missing QQ management request marker' })
    }
    const auth = authorizeRequest(connection, req)
    if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.message })

    const path = url.pathname.slice(ADMIN_PREFIX.length) || '/'
    if (req.method === 'GET') {
      if (path !== '/scenes') return send(res, 404, { ok: false, error: 'unknown QQ management endpoint' })
      try {
        return send(res, 200, {
          ok: true,
          data: { scenes: core.listScenePermissions(), health: core.health() },
        })
      } catch {
        return send(res, 500, { ok: false, error: 'QQ management request failed' })
      }
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
    if (path !== '/scenes/permissions') {
      return send(res, 404, { ok: false, error: 'unknown QQ management endpoint' })
    }
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return sendFailure(res, error)
    }
    let parsed
    try {
      parsed = parsePermissionRequest(body)
    } catch (error) {
      return sendFailure(res, error)
    }
    try {
      const permissions = await core.setScenePermissions(parsed.scene, parsed.access, {
        expectedRevision: parsed.expectedRevision,
      })
      return send(res, 200, { ok: true, data: { permissions } })
    } catch (error) {
      return sendFailure(res, error)
    }
  }
}
