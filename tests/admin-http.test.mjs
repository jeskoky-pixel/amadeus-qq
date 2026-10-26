import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAdminHandler } from '../src/admin-http.js'
import { QQCore } from '../src/core.js'
import { QQStore } from '../src/storage.js'

const scene = { botId: '10001', kind: 'group', peerId: '20001' }

function request(method, endpoint, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, {
    method, url: endpoint,
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000',
      'content-type': 'application/json', 'x-amadeus-qq': '1', ...headers },
  })
  const res = { status: 0, headers: {}, text: '',
    writeHead(status, fields) { this.status = status; this.headers = fields },
    end(value) { this.text = String(value ?? '') },
  }
  return { req, res }
}

async function invoke(handler, method, endpoint, body, headers) {
  const { req, res } = request(method, endpoint, body, headers)
  await handler(req, res)
  return { status: res.status, body: JSON.parse(res.text) }
}

test('native QQ management requires a DSH owner admission and same-origin write marker', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-admin-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new QQStore(path.join(dir, 'qq.json'))
  const core = new QQCore({ store, dsh: { cancelSceneSession: async () => ({ accepted: true }) },
    transport: { status: 'mock', stop() {} },
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: [] } })
  t.after(() => core.close())
  await core.ingest({ post_type: 'message', message_type: 'group', self_id: '10001', group_id: '20001',
    user_id: '40001', message_id: '50001', time: 10,
    message: [{ type: 'text', data: { text: 'PRIVATE_SCENE_CONTENT' } }] })

  const write = { scene, access: { mode: 'observe', overrides: {} }, expectedRevision: 0 }
  const noConnection = createAdminHandler(core, undefined)
  const unavailable = await invoke(noConnection, 'POST', '/api/amadeus-qq/scenes/permissions', write)
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.body.code, 'QQ_MANAGEMENT_UNAVAILABLE')
  const nonOwner = createAdminHandler(core, { admit: () => ({ peer: { principal: { kind: 'guest' } } }) })
  const refused = await invoke(nonOwner, 'POST', '/api/amadeus-qq/scenes/permissions', write)
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'QQ_AUTH_REQUIRED')
  const owner = createAdminHandler(core, { admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
  assert.equal((await invoke(owner, 'POST', '/api/amadeus-qq/scenes/permissions', write,
    { origin: 'http://attacker.invalid' })).status, 403)
  assert.equal((await invoke(owner, 'POST', '/api/amadeus-qq/scenes/permissions', write,
    { 'x-amadeus-qq': undefined })).status, 403)
  assert.equal(store.getScenePermissions(scene), null, 'refused requests cannot mutate permissions')

  const ownerForbidden = await invoke(owner, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene, access: { mode: 'owner-agent', overrides: {} }, expectedRevision: 0,
  })
  assert.equal(ownerForbidden.status, 403, 'a group cannot be configured as an Owner Agent Scene')
  assert.equal(ownerForbidden.body.code, 'QQ_OWNER_AGENT_FORBIDDEN')
  assert.equal(store.getScenePermissions(scene), null)

  const listed = await invoke(owner, 'GET', '/api/amadeus-qq/scenes')
  assert.equal(listed.status, 200)
  assert.ok(Array.isArray(listed.body.data.scenes))
  assert.ok(!JSON.stringify(listed.body).includes('PRIVATE_SCENE_CONTENT'), 'admin listing exposes metadata, not message bodies')
  assert.deepEqual(listed.body.data.scenes[0].activity,
    { observedCount: 1, participantIds: ['40001'] })
  const saved = await invoke(owner, 'POST', '/api/amadeus-qq/scenes/permissions', write)
  assert.equal(saved.status, 200)
  assert.equal(store.getScenePermissions(scene).mode, 'observe')
  assert.equal((await invoke(owner, 'POST', '/api/amadeus-qq/scenes/permissions', write)).status, 409,
    'stale GUI windows must not silently overwrite the current Scene policy')
})

test('failed cancellation has a distinct management error code', async () => {
  const owner = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
  const core = { listScenePermissions: () => [], health: () => ({}),
    setScenePermissions: async () => { throw new Error('QQ_SESSION_CANCEL_FAILED') } }
  const handler = createAdminHandler(core, owner)
  const response = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene, access: { mode: 'observe', overrides: {} }, expectedRevision: 0,
  })
  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'QQ_SESSION_CANCEL_FAILED')
})
