import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { createSetupService } from '../src/setup.js'
import { makeDshHost } from '../src/index.js'
import { Config } from '../src/config.js'

function fixture() {
  const entry = { options: { id: 'amadeus-qq', config: { enabled: false } } }
  const editor = {
    documentPath: path.join(process.cwd(), 'isolated-profile', 'cordis.patch.yml'),
    entries: () => [entry],
    async edit(selected, change) {
      assert.equal(selected, entry)
      entry.options.config = change(structuredClone(entry.options.config))
    },
  }
  const registry = { list: () => [{ id: 'ws-a', title: 'Test Workspace', path: path.join(process.cwd(), 'isolated-workspace') }] }
  return { entry, service: createSetupService(editor, registry) }
}

test('disabled connector can be configured through an existing Workspace with redacted token and CAS', async () => {
  assert.match(JSON.stringify(Config.toJSON()), /"role":"secret"/, 'DSH Settings must redact the NapCat token')
  const { entry, service } = fixture()
  assert.equal(service.status().enabled, false)
  const saved = await service.save({ expectedRevision: 0, workspaceId: 'ws-a', botId: '10001', ownerId: '30001',
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', token: 'local-test-token',
    groups: ['20001'], privatePeers: [], globalDeny: ['qq.group.kick'], connect: false })
  assert.equal(saved.workspaceId, 'ws-a')
  assert.equal(saved.tokenConfigured, true)
  assert.equal(JSON.stringify(saved).includes('local-test-token'), false)
  assert.deepEqual(entry.options.config.policy.privateIds, ['30001'])
  assert.equal(entry.options.config.agentPreset, 'amadeus-qq')
  assert.equal(entry.options.config.enabled, true)
  assert.equal(entry.options.config.connect, false)
  assert.deepEqual(saved.globalDeny, ['qq.group.kick'])
  assert.deepEqual(entry.options.config.permissions.globalDeny, ['qq.group.kick'])
  assert.match(entry.options.config.statePath, /isolated-profile/)
  assert.equal(Object.hasOwn(saved, 'token'), false)
  await assert.rejects(service.save({ expectedRevision: 0, workspaceId: 'ws-a', botId: '10001', ownerId: '30001',
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', groups: [], privatePeers: [], connect: false }), /QQ_SETUP_CONFLICT/)
})

test('first setup rejects self-owner and unknown global-deny capabilities without changing config', async () => {
  const { entry, service } = fixture()
  const body = { expectedRevision: 0, workspaceId: 'ws-a', botId: '10001', ownerId: '30001',
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001',
    groups: [], privatePeers: [], connect: false }
  await assert.rejects(service.save({ ...body, ownerId: '10001' }), /must differ/)
  await assert.rejects(service.save({ ...body, globalDeny: ['qq.nonexistent'] }), /unknown capability/)
  assert.deepEqual(entry.options.config, { enabled: false })
})

test('Owner handoff changes only the durable connection bit with CAS', async () => {
  const { entry, service } = fixture()
  await service.save({ expectedRevision: 0, workspaceId: 'ws-a', botId: '10001', ownerId: '30001',
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001',
    groups: ['20001'], privatePeers: [], connect: true })
  const before = structuredClone(entry.options.config)
  let paused = 0
  const result = await service.setConnection({ expectedRevision: 1, connect: false }, () => { paused++ })
  assert.equal(result.connect, false)
  assert.equal(result.revision, 2)
  assert.equal(paused, 1)
  assert.deepEqual(entry.options.config.policy, before.policy)
  assert.deepEqual(entry.options.config.permissions, before.permissions)
  assert.equal(entry.options.config.statePath, before.statePath)
  await assert.rejects(service.setConnection({ expectedRevision: 1, connect: true }), /QQ_SETUP_CONFLICT/)
  await assert.rejects(service.setConnection({ expectedRevision: 2, connect: false, groups: [] }), /invalid/)
  assert.equal((await service.setConnection({ expectedRevision: 2, connect: true })).connect, true)
  assert.equal(service.status().revision, 3)
})

test('Scene allowlist and pause updates persist with revisions and retain Owner private Scene', async () => {
  const { entry, service } = fixture()
  await service.save({ expectedRevision: 0, workspaceId: 'ws-a', botId: '10001', ownerId: '30001',
    httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', groups: [], privatePeers: [], connect: false })
  await service.setScene({ expectedRevision: 1, botId: '10001', kind: 'group', peerId: '20001', allowed: true })
  assert.deepEqual(service.status().groups, ['20001'])
  await service.pauseScene({ expectedRevision: 2, botId: '10001', kind: 'group', peerId: '20001', paused: true })
  assert.deepEqual(entry.options.config.policy.pausedScenes, ['10001:group:20001'])
  await service.pauseScene({ expectedRevision: 3, botId: '10001', kind: 'group', peerId: '20001', paused: false })
  assert.deepEqual(entry.options.config.policy.pausedScenes, [])
  await assert.rejects(service.setScene({ expectedRevision: 4, botId: '10001', kind: 'private', peerId: '30001', allowed: false }), /Owner private Scene/)
  await service.setScene({ expectedRevision: 4, botId: '10001', kind: 'group', peerId: '20001', allowed: false })
  await service.setScene({ expectedRevision: 5, botId: '10001', kind: 'group', peerId: '20001', allowed: true })
  assert.equal(entry.options.config.policy.sceneRevisions['10001:group:20001'], 1)
})

test('Workspace Session creation uses the official workspaceId seam and names the Scene', async () => {
  const calls = []
  const host = makeDshHost({ sessionController: {
    async create(request) { calls.push(['create', request]); return { sessionId: 's1', agentPreset: request.agentPreset } },
    async rename(request) { calls.push(['rename', request]); return { title: request.title } },
    async prompt() { return { accepted: true } },
  } }, { workspaceId: 'ws-a', agentPreset: 'amadeus-qq' })
  await host.createSceneSession({ botId: '10001', kind: 'group', peerId: '20001' }, {})
  assert.equal(calls[0][1].workspaceId, 'ws-a')
  assert.equal('cwd' in calls[0][1], false)
  assert.deepEqual(calls[1][1], { sessionId: 's1', title: '群聊 20001' })
})
