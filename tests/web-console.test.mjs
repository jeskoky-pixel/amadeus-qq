import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAdminHandler } from '../src/admin-http.js'

const owner = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
const guest = { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }

function core() {
  return {
    listScenePermissions: () => [{
      key: '10001:group:20001',
      scene: { botId: '10001', kind: 'group', peerId: '20001' },
      permissions: { mode: 'safe-chat', overrides: {}, revision: 2 },
      effectiveMode: 'safe-chat',
      capabilities: [
        { id: 'qq.send', implemented: true, override: 'inherit', effective: true, reason: 'mode' },
        { id: 'qq.qzone.use', implemented: true, override: 'deny', effective: false, reason: 'scene-deny' },
        { id: 'qq.qzone.read', implemented: true, override: 'allow', effective: true, reason: 'scene-allow' },
        { id: 'qq.qzone.publish', implemented: true, override: 'allow', effective: true, reason: 'scene-allow' },
      ],
    }],
    health: () => ({ enabled: true, transport: 'connected' }),
    setScenePermissions: async () => {
      const error = new Error('conflict')
      error.code = 'QQ_PERMISSION_CONFLICT'
      error.currentRevision = 7
      throw error
    },
  }
}

function request(method, path, { headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  Object.assign(req, {
    method,
    url: path,
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'x-amadeus-qq': '1',
      ...headers,
    },
  })
  return req
}

async function invoke(handler, method, path, options) {
  const req = request(method, path, options)
  const res = { status: 0, headers: {}, text: '',
    writeHead(status, fields) { this.status = status; this.headers = fields },
    end(value) { this.text = String(value ?? '') } }
  await handler(req, res)
  return res
}

test('console requires the existing same-origin DSH owner admission', async () => {
  const handler = createAdminHandler(core(), owner)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/console')).status, 200)
  assert.equal((await invoke(createAdminHandler(core(), undefined), 'GET', '/api/amadeus-qq/console')).status, 503)
  assert.equal((await invoke(createAdminHandler(core(), guest), 'GET', '/api/amadeus-qq/console')).status, 403)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/console', {
    headers: { origin: 'https://external.invalid' },
  })).status, 403)
})

test('console assets are static, CSP constrained and contain no secrets or inline data', async () => {
  const handler = createAdminHandler(core(), owner)
  const html = await invoke(handler, 'GET', '/api/amadeus-qq/console')
  assert.equal(html.status, 200)
  assert.match(html.headers['content-type'], /text\/html/)
  assert.match(html.headers['content-security-policy'], /script-src 'self'/)
  assert.doesNotMatch(html.headers['content-security-policy'], /unsafe-inline/)
  assert.equal(html.headers['x-content-type-options'], 'nosniff')
  assert.equal(html.headers['x-frame-options'], 'DENY')
  assert.match(html.text, /console\.js/)
  assert.doesNotMatch(html.text, /<script(?![^>]*src=)/i)
  assert.doesNotMatch(html.text, /onclick|onerror|onload|innerHTML/i)
  assert.doesNotMatch(html.text, /token|secret|cookie|C:\\|https?:\/\//i)

  const script = await invoke(handler, 'GET', '/api/amadeus-qq/console.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /javascript/)
  assert.match(script.headers['content-security-policy'], /script-src 'self'/)
  assert.match(script.text, /textContent/)
  assert.doesNotMatch(script.text, /innerHTML/)
  assert.match(script.text, /scenes\/permissions/)
  assert.match(script.text, /expectedRevision/)
  assert.match(script.text, /x-amadeus-qq/)
  assert.match(script.text, /status === 409/)
  assert.match(script.text, /qq\.qzone\.read/)
  assert.match(script.text, /qq\.qzone\.publish/)
  assert.match(script.text, /qq\.qzone\.use/)
  assert.doesNotMatch(script.text, /token|secret|cookie|https?:\/\//i)

  const css = await invoke(handler, 'GET', '/api/amadeus-qq/console.css')
  assert.equal(css.status, 200)
  assert.match(css.headers['content-type'], /text\/css/)
  assert.equal(css.headers['cache-control'], 'no-store')
})

test('console state stays metadata-only and permission conflict uses the existing API', async () => {
  const handler = createAdminHandler(core(), owner)
  const scenes = await invoke(handler, 'GET', '/api/amadeus-qq/scenes')
  assert.equal(scenes.status, 200)
  const body = JSON.parse(scenes.text)
  assert.equal(body.data.health.transport, 'connected')
  assert.equal(body.data.scenes[0].capabilities.some(item => item.id === 'qq.qzone.use'), true)
  assert.doesNotMatch(scenes.text, /message|content|token|secret/i)

  const conflict = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scene: { botId: '10001', kind: 'group', peerId: '20001' },
      access: { mode: 'safe-chat', overrides: {} },
      expectedRevision: 2,
    }),
  })
  assert.equal(conflict.status, 409)
  assert.equal(JSON.parse(conflict.text).currentRevision, 7)

  const missingMarker = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    headers: { 'content-type': 'application/json', 'x-amadeus-qq': undefined },
    body: JSON.stringify({
      scene: { botId: '10001', kind: 'group', peerId: '20001' },
      access: { mode: 'safe-chat', overrides: {} },
      expectedRevision: 2,
    }),
  })
  assert.equal(missingMarker.status, 403)
})
