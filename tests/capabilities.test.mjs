import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { NAPCAT_ACTION_NAMES } from '../src/napcat-action-names.js'

function fixture(t, { permissionPolicy = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-cap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new QQStore(path.join(dir, 'qq.json'))
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  const privateScene = { botId: '10001', kind: 'private', peerId: '30001' }
  store.bindSession(group, 'group-session')
  store.bindSession(privateScene, 'private-session')
  const calls = []
  const transport = { status: 'connected', async action(name, args) {
    calls.push({ name, args })
    if (name === 'get_group_member_list') return Array.from({ length: 250 }, (_, i) => ({ user_id: i + 1 }))
    if (name === 'get_friend_list') return Array.from({ length: 225 }, (_, i) => ({ user_id: i + 1, nickname: `friend-${i + 1}` }))
    if (name === 'get_group_list') return Array.from({ length: 225 }, (_, i) => ({ group_id: i + 1, group_name: `group-${i + 1}` }))
    return { ok: true }
  }, stop() {} }
  const core = new QQCore({ store, dsh: {}, transport,
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] }, permissionPolicy })
  return { registry: new CapabilityRegistry({ core, store, transport }), core, calls, transport }
}

test('installed NapCat inventory is complete as identifiers but unverified by the running backend', t => {
  const { registry, core } = fixture(t)
  assert.equal(NAPCAT_ACTION_NAMES.length, 182)
  assert.equal(registry.list().filter(item => item.provider === 'installed-napcat-bundle').length, 182)
  assert.equal(registry.describe('napcat.send_qzone_msg').status, 'unverified')
  assert.equal(registry.describe('napcat.get_credentials').status, 'unsupported')
  assert.equal(registry.describe('napcat.set_group_leave').executable, false)
  assert.equal(registry.search('group', { limit: 5 }).items.length, 5)
  core.close()
})

test('capability execution binds group target to the DSH Session and rejects arbitrary action/scene arguments', async t => {
  const { registry, core, calls } = fixture(t)
  assert.deepEqual(await registry.execute('group-session', 'qq.get_group_info'), { data: { ok: true } })
  assert.deepEqual(calls[0], { name: 'get_group_info', args: { group_id: '20001' } })
  await assert.rejects(registry.execute('group-session', 'qq.get_group_info', { group_id: '99999' }), /unexpected capability argument/)
  await assert.rejects(registry.execute('private-session', 'qq.get_group_info'), /GROUP_ONLY/)
  await assert.rejects(registry.execute('group-session', 'napcat.send_qzone_msg', { text: 'unsafe' }), /NOT_EXECUTABLE/)
  await assert.rejects(registry.execute('unbound', 'qq.get_status'), /UNAUTHORIZED/)
  assert.equal(calls.length, 1)
  core.close()
})

test('large group member response is bounded before it reaches the model', async t => {
  const { registry, core } = fixture(t)
  const result = await registry.execute('group-session', 'qq.get_group_member_list')
  assert.equal(result.items.length, 200)
  assert.equal(result.total, 250)
  assert.equal(result.partial, true)
  core.close()
})

test('disconnected provider fails without calling a platform action', async t => {
  const { registry, core, transport, calls } = fixture(t)
  transport.status = 'disconnected'
  assert.equal(registry.describe('qq.get_status').status, 'unavailable')
  await assert.rejects(registry.execute('group-session', 'qq.get_status'), /TRANSPORT_UNAVAILABLE/)
  assert.equal(calls.length, 0)
  core.close()
})

test('capability execution checks current Scene read permission before OneBot action', async t => {
  const { registry, core, calls } = fixture(t)
  const scene = { botId: '10001', kind: 'group', peerId: '20001' }
  core.store.setScenePermissions(scene, { mode: 'safe-chat', overrides: { 'qq.read': 'deny' } })
  core.store.bindSession(scene, 'group-session')
  await assert.rejects(registry.execute('group-session', 'qq.get_group_info'), /QQ_PERMISSION_DENIED/)
  assert.equal(calls.length, 0)
  core.close()
})

test('message and profile reads are limited to IDs observed in the bound Scene', async t => {
  const { registry, core, calls } = fixture(t)
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  core.store.appendMessage(group, { messageId: '701', senderId: '40001', segments: [] })
  assert.deepEqual(await registry.execute('group-session', 'qq.get_msg', { messageId: '701' }), { data: { ok: true } })
  assert.deepEqual(calls.at(-1), { name: 'get_msg', args: { message_id: '701' } })
  await assert.rejects(registry.execute('group-session', 'qq.get_msg', { messageId: '799' }), /QQ_MESSAGE_SCOPE/)
  assert.deepEqual(await registry.execute('group-session', 'qq.get_stranger_info', { userId: '40001' }), { data: { ok: true } })
  assert.deepEqual(calls.at(-1), { name: 'get_stranger_info', args: { user_id: '40001' } })
  await assert.rejects(registry.execute('group-session', 'qq.get_stranger_info', { userId: '99999' }), /QQ_PERSON_SCOPE/)
  await registry.execute('private-session', 'qq.get_stranger_info', { userId: '30001' })
  await assert.rejects(registry.execute('private-session', 'qq.get_stranger_info', { userId: '40001' }), /QQ_PERSON_SCOPE/)
  await registry.execute('group-session', 'qq.get_login_info')
  assert.deepEqual(calls.at(-1), { name: 'get_login_info', args: {} })
  core.close()
})

test('a large OneBot read result is rejected before entering model context', async t => {
  const { registry, core, transport } = fixture(t)
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  core.store.appendMessage(group, { messageId: '801', senderId: '40001', segments: [] })
  transport.action = async () => ({ message: 'x'.repeat(70_000) })
  await assert.rejects(registry.execute('group-session', 'qq.get_msg', { messageId: '801' }), /QQ_CAPABILITY_RESULT_TOO_LARGE/)
  core.close()
})

test('get_msg strips platform media locators and raw CQ content before model output', async t => {
  const { registry, core, transport } = fixture(t)
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  core.store.appendMessage(group, { messageId: '802', senderId: '40001', segments: [] })
  transport.action = async () => ({ message_id: 802, raw_message: '[CQ:image,file=raw-secret]',
    message: [{ type: 'text', data: { text: 'hello' } },
      { type: 'image', data: { file: 'https://media.invalid/image?token=media-secret', url: 'https://media.invalid/image?token=media-secret' } }],
    file: 'C:\\private\\outside-secret.jpg' })
  const result = await registry.execute('group-session', 'qq.get_msg', { messageId: '802' })
  const serialized = JSON.stringify(result)
  for (const secret of ['raw-secret', 'media-secret', 'outside-secret', 'media.invalid']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not enter model output`)
  }
  assert.match(serialized, /hello/)
  assert.match(serialized, /802/)
  core.close()
})

test('get_msg string-format response keeps ordinary text while removing CQ media locators', async t => {
  const { registry, core, transport } = fixture(t)
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  core.store.appendMessage(group, { messageId: '803', senderId: '40001', segments: [] })
  transport.action = async () => ({ message_id: 803,
    message: 'look [CQ:image,file=https://media.invalid/image?token=getmsg-secret] please' })
  const result = await registry.execute('group-session', 'qq.get_msg', { messageId: '803' })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('getmsg-secret'), false)
  assert.match(serialized, /look/)
  assert.match(serialized, /please/)
  core.close()
})

test('account directories are Owner-only, explicitly granted, paged and never take model-supplied targets', async t => {
  const { registry, core, calls } = fixture(t, { permissionPolicy: { ownerPrivateIds: ['30001'] } })
  for (const id of ['qq.get_friend_list', 'qq.get_group_list']) {
    assert.equal(registry.describe(id).risk, 'medium')
    assert.equal(registry.describe(id).scenePermission, 'owner-private-explicit')
  }
  const owner = { botId: '10001', kind: 'private', peerId: '30001' }
  const granted = { mode: 'owner-agent', overrides: { 'qq.friends.read': 'allow', 'qq.groups.read': 'allow' } }
  core.store.setScenePermissions(owner, granted)
  core.store.bindSession(owner, 'private-session')
  await assert.rejects(registry.execute('group-session', 'qq.get_friend_list'), /PERMISSION_DENIED/)
  await assert.rejects(registry.execute('group-session', 'qq.get_group_list'), /PERMISSION_DENIED/)
  assert.equal(calls.length, 0)
  const friends = await registry.execute('private-session', 'qq.get_friend_list', { offset: 100, limit: 50 })
  assert.equal(friends.items.length, 50)
  assert.equal(friends.total, 225)
  assert.equal(friends.partial, true)
  assert.deepEqual(calls.at(-1), { name: 'get_friend_list', args: {} })
  const groups = await registry.execute('private-session', 'qq.get_group_list', { offset: 200, limit: 100 })
  assert.equal(groups.items.length, 25)
  assert.equal(groups.total, 225)
  assert.equal(groups.partial, false)
  assert.deepEqual(calls.at(-1), { name: 'get_group_list', args: {} })
  await assert.rejects(registry.execute('private-session', 'qq.get_friend_list', { botId: '99999' }), /unexpected capability argument/)
  await assert.rejects(registry.execute('private-session', 'qq.get_group_list', { limit: 1000 }), /limit/)
  const before = calls.length
  core.store.setScenePermissions(owner, { mode: 'owner-agent', overrides: { 'qq.friends.read': 'deny', 'qq.groups.read': 'deny' } })
  await assert.rejects(registry.execute('private-session', 'qq.get_friend_list'), /PERMISSION|CHANGED/)
  assert.equal(calls.length, before)
  core.close()
})

test('revoking an Owner directory read during OneBot response prevents disclosure to the model', async t => {
  const { registry, core, transport } = fixture(t, { permissionPolicy: { ownerPrivateIds: ['30001'] } })
  const owner = { botId: '10001', kind: 'private', peerId: '30001' }
  core.store.setScenePermissions(owner, { mode: 'owner-agent', overrides: { 'qq.friends.read': 'allow' } })
  core.store.bindSession(owner, 'private-session')
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  const reply = new Promise(resolve => { release = resolve })
  transport.action = async () => { entered(); return reply }
  const request = registry.execute('private-session', 'qq.get_friend_list')
  await started
  core.store.setScenePermissions(owner, { mode: 'owner-agent', overrides: { 'qq.friends.read': 'deny' } })
  release([{ user_id: 40001, nickname: 'revoked private result' }])
  await assert.rejects(request, /PERMISSION|CHANGED/)
  core.close()
})
