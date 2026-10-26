/**
 * Native management HTTP surface for per-Scene QQ permissions.
 *
 * Every request must be same-origin, pass the DSH Connection owner admission,
 * and POST requests must carry the `x-amadeus-qq: 1` marker. Loopback alone is
 * never authorization: the DSH `connection.admit(req)` result is the only
 * source of the owner principal. Model tools cannot reach this surface.
 */

import { sceneIdentity } from './storage.js'
import { MODE_IDS, validateScenePermissions } from './permissions.js'

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
 * Fixed, non-reflective management failure. The client uses `code` to decide
 * whether the page must become read-only, so codes are part of the contract.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code fixed machine code.
 * @param {string} message fixed human message; never exception/scene content.
 */
function fail(res, status, code, message) {
  return send(res, status, { ok: false, code, error: message })
}

/**
 * @param {Record<string, unknown>} connection - DSH Connection service.
 * @param {Record<string, unknown>} req - incoming request.
 * @returns {{ok: true}|{ok: false, status: number, message: string}} decision.
 */
export function authorizeRequest(connection, req) {
  if (!connection || typeof connection.admit !== 'function') {
    return { ok: false, status: 503, code: 'QQ_MANAGEMENT_UNAVAILABLE', message: 'native QQ management requires the DSH Connection service' }
  }
  let admission
  try {
    admission = connection.admit(req)
  } catch {
    return { ok: false, status: 403, code: 'QQ_AUTH_REQUIRED', message: 'request authentication failed' }
  }
  if (!admission || admission.rejection !== undefined) {
    const rejection = Number(admission?.rejection)
    const status = Number.isInteger(rejection) && rejection >= 400 && rejection <= 599 ? rejection : 403
    return { ok: false, status, code: 'QQ_AUTH_REQUIRED', message: 'DSH authentication is required' }
  }
  if (admission?.peer?.principal?.kind !== 'owner') {
    return { ok: false, status: 403, code: 'QQ_AUTH_REQUIRED', message: 'only the authenticated owner may manage QQ Scenes' }
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

/** @param {Record<string, unknown>} body */
function parseResolutionRequest(body) {
  exactKeys(body, ['scene', 'actionId', 'outcome'], 'request')
  exactKeys(body.scene, ['botId', 'kind', 'peerId'], 'scene')
  let scene
  try {
    scene = sceneIdentity(body.scene)
  } catch {
    throw new RequestError(400, 'scene is not a valid QQ Scene identity')
  }
  if (typeof body.actionId !== 'string' || !/^[\w-]{1,100}$/.test(body.actionId)) {
    throw new RequestError(400, 'actionId is invalid')
  }
  if (body.outcome !== 'failed') throw new RequestError(400, 'outcome must be failed')
  return { scene, actionId: body.actionId, outcome: body.outcome }
}

/** @param {import('node:http').ServerResponse} res @param {unknown} error */
function sendFailure(res, error) {
  if (error?.code === 'QQ_PERMISSION_CONFLICT') {
    return send(res, 409, {
      ok: false,
      code: 'QQ_PERMISSION_CONFLICT',
      error: 'Scene permissions changed; reload before retrying',
      currentRevision: error.currentRevision,
    })
  }
  if (error?.code === 'QQ_OWNER_AGENT_FORBIDDEN') {
    return fail(res, 403, 'QQ_OWNER_AGENT_FORBIDDEN', 'owner-agent is limited to a configured owner private Scene')
  }
  if (error?.code === 'QQ_DELIVERY_IN_FLIGHT') {
    return fail(res, 409, 'QQ_DELIVERY_IN_FLIGHT', 'an in-flight send cannot be reconciled as failed')
  }
  if (error?.code === 'QQ_DELIVERY_NOT_UNKNOWN') {
    return fail(res, 409, 'QQ_DELIVERY_NOT_UNKNOWN', 'only a settled unknown delivery can be reconciled as failed')
  }
  if (error?.code === 'QQ_DELIVERY_NOT_FOUND') {
    return fail(res, 404, 'QQ_DELIVERY_NOT_FOUND', 'unknown delivery not found')
  }
  if (error?.code === 'QQ_SCENE_UNAUTHORIZED') {
    return fail(res, 403, 'QQ_SCENE_UNAUTHORIZED', 'Scene is outside the configured allowlist')
  }
  if (error instanceof RequestError) return fail(res, error.status, 'QQ_REQUEST_INVALID', error.message)
  if (error instanceof TypeError) return fail(res, 400, 'QQ_REQUEST_INVALID', 'invalid Scene or permission request')
  const message = String(error?.message ?? '')
  if (message.startsWith('QQ_UNAUTHORIZED')) {
    return fail(res, 403, 'QQ_SCENE_UNAUTHORIZED', 'Scene is outside the configured allowlist')
  }
  if (message === 'QQ_SESSION_CANCEL_UNAVAILABLE') {
    return fail(res, 503, 'QQ_SESSION_CANCEL_UNAVAILABLE', 'the previous QQ Session could not be cancelled safely')
  }
  if (message === 'QQ_SESSION_CANCEL_FAILED') {
    return fail(res, 503, 'QQ_SESSION_CANCEL_FAILED', 'the previous QQ Session could not be cancelled safely')
  }
  return fail(res, 500, 'QQ_MANAGEMENT_FAILED', 'QQ management request failed')
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
      return fail(res, 404, 'QQ_ENDPOINT_UNKNOWN', 'not found')
    }
    if (!sameOrigin(req)) return fail(res, 403, 'QQ_AUTH_REQUIRED', 'same-origin request required')
    if (req.method === 'POST' && req.headers?.['x-amadeus-qq'] !== '1') {
      return fail(res, 403, 'QQ_AUTH_REQUIRED', 'missing QQ management request marker')
    }
    const auth = authorizeRequest(connection, req)
    if (!auth.ok) return send(res, auth.status, { ok: false, code: auth.code, error: auth.message })

    const path = url.pathname.slice(ADMIN_PREFIX.length) || '/'
    if (req.method === 'GET') {
      if (path !== '/scenes') return fail(res, 404, 'QQ_ENDPOINT_UNKNOWN', 'unknown QQ management endpoint')
      try {
        return send(res, 200, {
          ok: true,
          data: { scenes: core.listScenePermissions(), health: core.health(), modes: [...MODE_IDS] },
        })
      } catch {
        return fail(res, 500, 'QQ_MANAGEMENT_FAILED', 'QQ management request failed')
      }
    }
    if (req.method !== 'POST') return fail(res, 405, 'QQ_METHOD_NOT_ALLOWED', 'method not allowed')
    if (path !== '/scenes/permissions' && path !== '/deliveries/resolve') {
      return fail(res, 404, 'QQ_ENDPOINT_UNKNOWN', 'unknown QQ management endpoint')
    }
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return sendFailure(res, error)
    }
    if (path === '/deliveries/resolve') {
      let resolution
      try {
        resolution = parseResolutionRequest(body)
      } catch (error) {
        return sendFailure(res, error)
      }
      try {
        if (typeof core.resolveDelivery !== 'function') {
          return fail(res, 503, 'QQ_MANAGEMENT_UNAVAILABLE', 'QQ delivery reconciliation is unavailable')
        }
        await core.resolveDelivery(resolution.scene, resolution.actionId, resolution.outcome)
        return send(res, 200, { ok: true, data: { status: 'failed' } })
      } catch (error) {
        return sendFailure(res, error)
      }
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
