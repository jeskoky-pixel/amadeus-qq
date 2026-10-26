import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { CapabilityRegistry } from '../src/capabilities.js'
import { NAPCAT_ACTION_NAMES } from '../src/napcat-action-names.js'

function fixture(t) {
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
    return name === 'get_group_member_list' ? Array.from({ length: 250 }, (_, i) => ({ user_id: i + 1 })) : { ok: true }
  }, stop() {} }
  const core = new QQCore({ store, dsh: {}, transport,
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] } })
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
