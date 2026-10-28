import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQCore } from '../src/core.js'
import { QQStore } from '../src/storage.js'

function fixture(t, policy, workspaceId = 'workspace-a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-persona-contract-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new QQStore(path.join(dir, 'qq.json'))
  const dsh = { async createSceneSession() { throw new Error('read-only listing must not create Sessions') } }
  const transport = { status: 'test', stop() {} }
  return new QQCore({ store, dsh, transport, policy, workspaceId })
}

test('Host lists authorized QQ Scenes before a message or Session without exposing secrets', t => {
  const core = fixture(t, {
    botIds: ['10001'], groupIds: ['20001', '20002'], privateIds: ['30001'],
    pausedScenes: ['10001:group:20002'],
  })
  core.store.setScenePermissions({ botId: '10001', kind: 'private', peerId: '30001' }, {
    mode: 'safe-chat', overrides: { 'qq.read': 'deny' },
  })
  const before = core.store.snapshot()
  const scenes = core.listAuthorizedScenes()
  assert.deepEqual(scenes, [{
    platform: 'qq', kind: 'group', id: '10001:20001',
    workspaceId: 'workspace-a', authorized: true,
  }])
  assert.equal(scenes[0].sessionId, undefined)
  assert.equal(JSON.stringify(scenes).includes('token'), false)
  assert.deepEqual(core.store.snapshot(), before)
  core.close()
})

test('Host listing follows revocation, bot identity and Workspace changes', t => {
  const policy = { botIds: ['10001'], groupIds: ['20001'], privateIds: [] }
  const core = fixture(t, policy)
  assert.deepEqual(core.listAuthorizedScenes().map(scene => scene.id), ['10001:20001'])
  const store = core.store
  const dsh = core.dsh
  const transport = core.transport
  core.close()

  const revoked = new QQCore({ store, dsh, transport, policy: { ...policy, groupIds: [] }, workspaceId: 'workspace-a' })
  assert.deepEqual(revoked.listAuthorizedScenes(), [])
  revoked.close()

  const switched = new QQCore({ store, dsh, transport, policy: { ...policy, botIds: ['10002'] }, workspaceId: 'workspace-b' })
  assert.deepEqual(switched.listAuthorizedScenes().map(scene => [scene.id, scene.workspaceId]), [['10002:20001', 'workspace-b']])
  switched.close()

  const unbound = new QQCore({ store, dsh, transport, policy, workspaceId: '' })
  assert.deepEqual(unbound.listAuthorizedScenes(), [])
  unbound.close()
})
