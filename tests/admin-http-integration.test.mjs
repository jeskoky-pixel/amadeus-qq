import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAdminHandler } from '../src/admin-http.js'
import { apply } from '../src/index.js'
import { QQCore } from '../src/core.js'
import { PermissionEngine } from '../src/permissions.js'
import { QQStore } from '../src/storage.js'

const group = { botId: '10001', kind: 'group', peerId: '20001' }
const owner = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }

function request(method, endpoint, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  Object.assign(req, {
    method, url: endpoint,
    headers: {
      host: 'localhost:3000', origin: 'http://localhost:3000',
      'content-type': 'application/json', 'x-amadeus-qq': '1', ...headers,
    },
  })
  const res = {
    status: 0, headers: {}, text: '',
    writeHead(status, fields) { this.status = status; this.headers = fields },
    end(value) { this.text = String(value ?? '') },
  }
  return { req, res }
}

async function invoke(handler, method, endpoint, body, headers) {
  const { req, res } = request(method, endpoint, body, headers)
  await handler(req, res)
  return { status: res.status, headers: res.headers, body: JSON.parse(res.text) }
}

function temp(t, prefix = 'amadeus-qq-admin-int-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function coreFixture(t, { cancel, permissionPolicy = {} } = {}) {
  const dir = temp(t)
  const store = new QQStore(path.join(dir, 'qq.json'))
  const events = []
  let nextSession = 1
  const dsh = {
    async createSceneSession() {
      const sessionId = `session-${nextSession++}`
      events.push(['create', sessionId])
      return { sessionId, agentPreset: 'amadeus-qq' }
    },
    async prompt(request) { events.push(['prompt', request.sessionId]); return { accepted: true } },
    async cancelSceneSession(sessionId) {
      events.push(['cancel', sessionId])
      if (cancel) return cancel(sessionId)
      return { accepted: true }
    },
  }
  const core = new QQCore({
    store, dsh,
    transport: { status: 'mock', stop() {} },
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001', '30002'] },
    permissionPolicy,
  })
  t.after(() => core.close())
  return { core, store, events }
}

test('management route is mounted only when the Host supplies webServer and connection', async t => {
  const routes = []
  const effects = []
  const dir = temp(t)
  const ctx = {
    tools: { register() {}, guard() {} },
    sessionController: {
      async create() { return { sessionId: 'session-mounted', agentPreset: 'amadeus-qq' } },
      async prompt() { return { accepted: true } },
      async cancel() { return { accepted: true } },
    },
    provide() {},
    effect(fn) { effects.push(fn()) },
    logger: { warn() {} },
    inject(_names, callback) {
      callback({
        webServer: { register(route) { routes.push(route); return () => {} } },
        connection: owner,
        effect(fn) { effects.push(fn()) },
      })
    },
  }
  apply(ctx, {
    enabled: true, connect: false,
    statePath: path.join(dir, 'qq.json'), sessionCwd: dir,
    agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] },
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/amadeus-qq')
  const listed = await invoke(routes[0].handler, 'GET', '/api/amadeus-qq/scenes')
  assert.equal(listed.status, 200)
  for (const dispose of effects.reverse()) dispose()
})

test('management stays unavailable without optional Host services and does not break the connector', t => {
  const dir = temp(t)
  const ctx = {
    tools: { register() {}, guard() {} },
    sessionController: {
      async create() { return { sessionId: 'session-no-admin', agentPreset: 'amadeus-qq' } },
      async prompt() { return { accepted: true } },
      async cancel() { return { accepted: true } },
    },
    provide() {},
    effect() {},
  }
  assert.doesNotThrow(() => apply(ctx, {
    enabled: true, connect: false,
    statePath: path.join(dir, 'qq.json'), sessionCwd: dir,
    agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] },
  }))
})

test('unimplemented Owner capabilities never appear effective or authorize a bound Session', t => {
  const { core, store } = coreFixture(t, { permissionPolicy: {
    ownerPrivateIds: ['30001'], ownerTools: ['dsh.shell'],
    accountGrants: { byBotId: { '10001': { qzonePublish: true } } },
  } })
  const ownerScene = { botId: '10001', kind: 'private', peerId: '30001' }
  store.setScenePermissions(ownerScene, { mode: 'owner-agent' })
  store.bindSession(ownerScene, 'owner-session')
  const listed = core.listScenePermissions().find(row => row.scene.peerId === '30001')
  assert.equal(listed.effectiveMode, 'owner-agent')
  for (const id of ['dsh.shell', 'qq.qzone.publish']) {
    const capability = listed.capabilities.find(item => item.id === id)
    assert.equal(capability.implemented, false)
    assert.equal(capability.effective, false, id)
    assert.equal(core.authorizeSessionCapability('owner-session', id), false, id)
  }
})

test('permission updates require exact revision, reject malformed bodies and keep stored state intact', async t => {
  const { core, store } = coreFixture(t)
  await core.ingest({ post_type: 'message', message_type: 'group', self_id: '10001', group_id: '20001',
    user_id: '40001', message_id: '60001', time: 10,
    message: [{ type: 'text', data: { text: 'PRIVATE_SCENE_CONTENT' } }] })
  const handler = createAdminHandler(core, owner)

  const listed = await invoke(handler, 'GET', '/api/amadeus-qq/scenes')
  assert.equal(listed.status, 200)
  assert.equal(listed.headers['cache-control'], 'no-store')
  assert.ok(!JSON.stringify(listed.body).includes('PRIVATE_SCENE_CONTENT'))
  assert.deepEqual(listed.body.data.scenes[0].scene, group)
  assert.equal(listed.body.data.scenes[0].revision, 0)
  assert.equal(listed.body.data.scenes[0].effectiveMode, 'safe-chat')

  const valid = { scene: group, access: { mode: 'observe', overrides: {} }, expectedRevision: 0 }
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', '{')).status, 400)
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', '[]')).status, 400)
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions',
    { ...valid, extra: true })).status, 400)
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions',
    { ...valid, scene: { ...group, peerId: '99999' } })).status, 403)
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions',
    { ...valid, access: { mode: 'owner-agent', overrides: { 'qq.send': 'yes' } } })).status, 400)
  assert.equal(store.getScenePermissions(group), null, 'rejected updates never touch durable state')

  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', valid)).status, 200)
  assert.equal(store.getScenePermissions(group).revision, 1)
  const stale = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', valid)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'QQ_PERMISSION_CONFLICT')
  assert.equal(stale.body.currentRevision, 1)
  assert.equal(store.getScenePermissions(group).mode, 'observe')
})

test('management permission change cancels the old Session and the next interaction uses a fresh one', async t => {
  const { core, store, events } = coreFixture(t)
  const privateScene = { botId: '10001', kind: 'private', peerId: '30001' }
  const first = await core.ingest({ post_type: 'message', message_type: 'private', self_id: '10001',
    user_id: '30001', message_id: '61001', time: 10,
    message: [{ type: 'text', data: { text: 'hello' } }] })
  assert.equal(first.status, 'prompted')
  const oldSession = first.sessionId

  const handler = createAdminHandler(core, owner)
  const revoked = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene: privateScene, access: { mode: 'observe', overrides: {} }, expectedRevision: 0,
  })
  assert.equal(revoked.status, 200)
  assert.deepEqual(events.filter(event => event[0] === 'cancel'), [['cancel', oldSession]])
  assert.equal(store.isKnownSession(oldSession), true)
  assert.equal(store.getScene(privateScene).sessionId, null)
  await assert.rejects(core.send(oldSession, {
    actionId: 'stale-admin-session', segments: [{ type: 'text', data: { text: 'stale' } }],
  }), /QQ_UNAUTHORIZED|QQ_PERMISSION_CHANGED/)

  assert.equal((await core.ingest({ post_type: 'message', message_type: 'private', self_id: '10001',
    user_id: '30001', message_id: '61002', time: 11,
    message: [{ type: 'text', data: { text: 'while observe' } }] })).status, 'stored')

  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene: privateScene, access: { mode: 'safe-chat', overrides: {} }, expectedRevision: 1,
  })).status, 200)
  const next = await core.ingest({ post_type: 'message', message_type: 'private', self_id: '10001',
    user_id: '30001', message_id: '61003', time: 12,
    message: [{ type: 'text', data: { text: 'allowed again' } }] })
  assert.equal(next.status, 'prompted')
  assert.notEqual(next.sessionId, oldSession)
  assert.deepEqual(events.filter(event => event[0] === 'cancel'), [['cancel', oldSession]])
})

test('owner-agent cannot be saved for a group or an unconfigured private peer', async t => {
  const { core, store } = coreFixture(t, { permissionPolicy: { ownerPrivateIds: ['30001'] } })
  await core.ingest({ post_type: 'message', message_type: 'group', self_id: '10001', group_id: '20001',
    user_id: '40001', message_id: '62001', time: 10,
    message: [{ type: 'text', data: { text: 'seen group' } }] })
  const handler = createAdminHandler(core, owner)
  const access = { mode: 'owner-agent', overrides: {} }

  const groupAttempt = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene: group, access, expectedRevision: 0,
  })
  assert.equal(groupAttempt.status, 403)
  assert.equal(store.getScenePermissions(group), null)

  const otherPrivate = { botId: '10001', kind: 'private', peerId: '30002' }
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene: otherPrivate, access, expectedRevision: 0,
  })).status, 403)
  assert.equal(store.getScenePermissions(otherPrivate), null)

  const ownerPrivate = { botId: '10001', kind: 'private', peerId: '30001' }
  assert.equal((await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    scene: ownerPrivate, access, expectedRevision: 0,
  })).status, 200)
  assert.equal(store.getScenePermissions(ownerPrivate).mode, 'owner-agent')
})

test('PermissionEngine refuses owner-agent as a group default', () => {
  assert.throws(() => new PermissionEngine({ groupDefaultMode: 'owner-agent' }), /owner-agent/)
  assert.throws(() => new PermissionEngine({ defaultMode: 'owner-agent' }), /owner-agent/)
})

function mountWithChild(t, child) {
  const dir = temp(t)
  const routes = []
  const effects = []
  const ctx = {
    tools: { register() {}, guard() {} },
    sessionController: {
      async create() { return { sessionId: 'session-mounted', agentPreset: 'amadeus-qq' } },
      async prompt() { return { accepted: true } },
      async cancel() { return { accepted: true } },
    },
    provide() {},
    effect(fn) { effects.push(fn()) },
    logger: { warn() {} },
    inject(_names, callback) {
      callback({
        webServer: { register(route) { routes.push(route); return () => {} } },
        effect(fn) { effects.push(fn()) },
        ...child,
      })
    },
  }
  apply(ctx, {
    enabled: true, connect: false,
    statePath: path.join(dir, 'qq.json'), sessionCwd: dir,
    agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001', '30002'] },
  })
  t.after(() => { for (const dispose of effects.reverse()) dispose() })
  return routes
}

test('management falls back to child.get(connection) and still requires an owner identity', async t => {
  const routes = mountWithChild(t, {
    connection: undefined,
    get(name) { return name === 'connection' ? owner : undefined },
  })
  assert.equal(routes.length, 1)
  assert.equal((await invoke(routes[0].handler, 'GET', '/api/amadeus-qq/scenes')).status, 200)

  const noIdentity = mountWithChild(t, { connection: undefined })
  assert.equal(noIdentity.length, 1)
  assert.equal((await invoke(noIdentity[0].handler, 'GET', '/api/amadeus-qq/scenes')).status, 503)
})
