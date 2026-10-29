import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAdminHandler } from '../src/admin-http.js'
import { CONSOLE_HTML, CONSOLE_CSS, CONSOLE_JS } from '../src/web-console.js'

const owner = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
const guest = { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }

function request(method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url, headers: {
    host: 'localhost:3000', origin: 'http://localhost:3000',
    'content-type': 'application/json', 'x-amadeus-qq': '1', ...headers,
  } })
  const res = { status: 0, headers: {}, text: '',
    writeHead(status, fields) { this.status = status; this.headers = fields },
    end(value) { this.text = String(value ?? '') } }
  return { req, res }
}

async function invoke(handler, method, url, body, headers) {
  const { req, res } = request(method, url, body, headers)
  await handler(req, res)
  return res
}

test('Web Console and setup are admitted only to same-origin DSH Owner', async () => {
  const setup = { status: () => ({ tokenConfigured: true }), save: async () => ({}) }
  const handler = createAdminHandler(null, owner, setup)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/console')).status, 200)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/setup')).status, 200)
  assert.equal((await invoke(createAdminHandler(null, guest, setup), 'GET', '/api/amadeus-qq/setup')).status, 403)
  assert.equal((await invoke(createAdminHandler(null, undefined, setup), 'GET', '/api/amadeus-qq/console')).status, 503)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/console', undefined,
    { origin: 'https://external.invalid' })).status, 403)
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/setup', {},
    { 'x-amadeus-qq': '' })).status, 403)
})

test('shipped console follows the product pages with strict CSP and no mock authority', async () => {
  const handler = createAdminHandler(null, owner)
  const html = await invoke(handler, 'GET', '/api/amadeus-qq/console')
  assert.equal(html.status, 200)
  assert.match(html.headers['content-security-policy'], /script-src 'self'/)
  assert.doesNotMatch(html.headers['content-security-policy'], /unsafe-inline/)
  assert.equal(html.headers['x-frame-options'], 'DENY')
  for (const page of ['overview', 'scenes', 'features', 'account', 'global', 'diagnostics']) {
    assert.match(CONSOLE_HTML, new RegExp(`id="view-${page}"`))
  }
  assert.match(CONSOLE_HTML, /id="setup-workspace"/)
  assert.match(CONSOLE_HTML, /id="setup-global-deny"/)
  assert.match(CONSOLE_HTML, /id="handoff-button"/)
  assert.match(CONSOLE_HTML, /QQ 接管/)
  assert.match(CONSOLE_HTML, /id="scene-detail"/)
  assert.doesNotMatch(CONSOLE_HTML, /<script(?![^>]*src=)|onclick=|onerror=|onload=/i)
  assert.doesNotMatch(CONSOLE_HTML, /100000001|100000002|演示在线|模拟数据/)
  assert.match(CONSOLE_CSS, /@media\(max-width:650px\)/)
  assert.match(CONSOLE_JS, /textContent/)
  assert.doesNotMatch(CONSOLE_JS, /innerHTML|localStorage/)
  assert.match(CONSOLE_JS, /scenes\/permissions/)
  assert.match(CONSOLE_JS, /scenes\/allowlist/)
  assert.match(CONSOLE_JS, /scenes\/pause/)
  assert.match(CONSOLE_JS, /api\('\/handoff'/)
  assert.match(CONSOLE_JS, /body\.globalDeny/)
  assert.match(CONSOLE_JS, /expectedRevision/)
  assert.match(CONSOLE_JS, /credentials: 'same-origin'/)
  assert.match(CONSOLE_JS, /x-amadeus-qq/)
})

test('handoff write requires Owner admission and leaves conflicts unchanged', async () => {
  let saves = 0
  let pauses = 0
  const setup = { status: () => ({ revision: 3 }),
    async setConnection(body, beforePause) {
      if (body.expectedRevision !== 3) throw new Error('QQ_SETUP_CONFLICT')
      beforePause?.()
      saves++
      return { revision: 4, connect: body.connect }
    } }
  const core = { listScenePermissions: () => [], setScenePermissions: async () => {},
    pauseForHandoff: () => { pauses++ } }
  const endpoint = '/api/amadeus-qq/handoff'
  assert.equal((await invoke(createAdminHandler(core, guest, setup), 'POST', endpoint,
    { expectedRevision: 3, connect: false })).status, 403)
  assert.equal((await invoke(createAdminHandler(core, owner, setup), 'POST', endpoint,
    { expectedRevision: 3, connect: false }, { 'x-amadeus-qq': '' })).status, 403)
  assert.equal((await invoke(createAdminHandler(core, owner, setup), 'POST', endpoint,
    { expectedRevision: 2, connect: false })).status, 409)
  assert.equal(saves, 0)
  assert.equal(pauses, 0)
  const response = await invoke(createAdminHandler(core, owner, setup), 'POST', endpoint,
    { expectedRevision: 3, connect: false })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.text).data.connect, false)
  assert.equal(pauses, 1)
})

test('disabled connector exposes first-run setup and returns no fake active scenes', async () => {
  const setup = { status: () => ({ enabled: false, workspaces: [{ id: 'ws-a' }] }) }
  const handler = createAdminHandler(null, owner, setup)
  const available = await invoke(handler, 'GET', '/api/amadeus-qq/setup')
  assert.equal(JSON.parse(available.text).data.workspaces[0].id, 'ws-a')
  const scenes = await invoke(handler, 'GET', '/api/amadeus-qq/scenes')
  assert.deepEqual(JSON.parse(scenes.text).data.scenes, [])
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {})).status, 503)
})

test('setup writes use owner CSRF marker, bounded JSON and report revision conflicts', async () => {
  const setup = { status: () => ({}), save: async () => { throw new Error('QQ_SETUP_CONFLICT') } }
  const handler = createAdminHandler(null, owner, setup)
  const conflict = await invoke(handler, 'POST', '/api/amadeus-qq/setup', { expectedRevision: 0 })
  assert.equal(conflict.status, 409)
  assert.equal(JSON.parse(conflict.text).code, 'QQ_SETUP_CONFLICT')
  const bad = await invoke(handler, 'POST', '/api/amadeus-qq/setup', {})
  assert.equal(bad.status, 409)
  const missing = await invoke(createAdminHandler(null, owner), 'POST', '/api/amadeus-qq/setup', {})
  assert.equal(missing.status, 503)
})
