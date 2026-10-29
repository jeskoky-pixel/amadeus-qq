import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { BEHAVIOR_PRESETS } from '../src/permissions.js'

const botId = '10001'
const policy = { botIds: [botId], groupIds: ['20001', '20002'], privateIds: ['30001'], epoch: 0 }

function group(messageId, groupId = '20001', segments = [{ type: 'at', data: { qq: botId } }, { type: 'text', data: { text: 'Hi' } }]) {
  return { post_type: 'message', message_type: 'group', self_id: botId, group_id: groupId,
    user_id: '40001', message_id: messageId, time: 10, message: segments }
}

function privateMessage(messageId, text = 'hello') {
  return { post_type: 'message', message_type: 'private', self_id: botId, user_id: '30001',
    message_id: messageId, time: 10, message: [{ type: 'text', data: { text } }] }
}

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-core-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'qq.json')
  const events = []
  let nextSession = 1
  const dsh = {
    async createSceneSession(scene, grant) {
      const sessionId = `session-${nextSession++}`
      events.push(['create', scene.kind, scene.peerId, sessionId])
      if (options.create) await options.create(scene, sessionId, grant)
      return { sessionId }
    },
    async prompt(request) { events.push(['prompt', request.sessionId, request.requestId]); return options.prompt?.(request) ?? { accepted: true } },
    async cancelSceneSession(sessionId) { events.push(['cancel', sessionId]); return options.cancel?.(sessionId) ?? { accepted: true } },
  }
  const transport = {
    status: 'mock',
    send: options.send ?? (async (_scene, segments) => { events.push(['send', segments]); return { messageId: '90001' } }),
    stop() { options.stop?.() },
  }
  const make = (handoffPaused = false) => new QQCore({
    store: new QQStore(file, {
      maxMessages: options.maxMessages ?? 500,
      maxDeliveries: options.maxDeliveries ?? 500,
    }),
    dsh, transport, policy: options.policy ?? policy,
    permissionPolicy: options.permissionPolicy ?? {}, workspaceId: options.workspaceId ?? '', handoffPaused,
    ...(options.clock ? { clock: options.clock } : {}),
  })
  return { file, events, dsh, transport, make }
}

test('handoff suppresses stale wakes and sends while preserving a Scene Session across restart', async t => {
  const f = fixture(t, { workspaceId: 'ws-a', prompt: () => { throw new Error('DSH temporarily unavailable') } })
  const scene = { botId, kind: 'private', peerId: '30001' }
  const core = f.make()
  await assert.rejects(core.ingest(privateMessage('801')), /temporarily unavailable/)
  const sessionId = core.store.getScene(scene).sessionId
  assert.ok(sessionId)
  assert.equal(core.store.getScene(scene).messages[0].prompted, false)
  const pause = await core.pauseForHandoff()
  assert.equal(pause.suppressed, 1)
  assert.equal(core.authorizeSessionCapability(sessionId, 'qq.send'), false)
  await assert.rejects(core.send(sessionId, { actionId: 'late-send', segments: [{ type: 'text', data: { text: 'late' } }] }),
    /QQ_HANDOFF_PAUSED/)
  assert.equal(core.store.getScene(scene).deliveries.length, 0)
  assert.deepEqual(await core.ingest(privateMessage('802')), { status: 'paused' })
  assert.deepEqual(await core.resumePending(), { resumed: 0 })
  core.close()

  const paused = f.make(true)
  assert.equal(paused.store.getScene(scene).sessionId, sessionId)
  assert.equal(paused.store.getScene(scene).messages[0].prompted, true)
  assert.deepEqual(await paused.provisionAuthorizedScenes(), { provisioned: 0 })
  assert.deepEqual(await paused.resumePending(), { resumed: 0 })
  assert.equal(paused.statusFor(sessionId).handoffPaused, true)
  paused.close()

  const resumed = f.make()
  assert.equal(resumed.store.getScene(scene).sessionId, sessionId)
  assert.deepEqual(await resumed.resumePending(), { resumed: 0 })
  const args = { actionId: 'fresh-send', segments: [{ type: 'text', data: { text: 'fresh' } }] }
  assert.equal((await resumed.send(sessionId, args)).status, 'delivered')
  assert.equal((await resumed.send(sessionId, args)).repeated, true)
  assert.equal(f.events.filter(event => event[0] === 'send').length, 1)
  assert.equal(f.events.filter(event => event[0] === 'cancel').length, 0)
  resumed.close()
})

test('handoff waits for an interrupted delivery ledger before config reload', async t => {
  let started
  let interrupt
  const entered = new Promise(resolve => { started = resolve })
  const f = fixture(t, {
    workspaceId: 'ws-a',
    send: () => new Promise((_resolve, reject) => { interrupt = reject; started() }),
    stop: () => interrupt?.(new Error('request aborted')),
  })
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  await core.provisionAuthorizedScenes()
  const sessionId = core.store.getScene(scene).sessionId
  const outgoing = core.send(sessionId, { actionId: 'in-flight', segments: [{ type: 'text', data: { text: 'hello' } }] })
  await entered
  const paused = await core.pauseForHandoff()
  assert.equal(paused.inFlight, 1)
  assert.equal((await outgoing).status, 'unknown')
  assert.equal(core.store.getScene(scene).deliveries[0].status, 'unknown')
  core.close()
  const resumed = f.make()
  assert.equal(resumed.store.getScene(scene).sessionId, sessionId)
  assert.equal((await resumed.send(sessionId, { actionId: 'in-flight', segments: [{ type: 'text', data: { text: 'hello' } }] })).repeated, true)
  resumed.close()
})

test('authorized Workspace Scenes have distinct persistent Sessions before the first message', async t => {
  const f = fixture(t, { workspaceId: 'ws-a' })
  const core = f.make()
  core.store.setScenePermissions({ botId, kind: 'group', peerId: '20002' }, { mode: 'observe', overrides: {} })
  assert.deepEqual(await core.provisionAuthorizedScenes(), { provisioned: 3 })
  const first = core.listScenePermissions()
  assert.equal(first.length, 3)
  assert.equal(new Set(first.map(row => row.sessionId)).size, 3)
  assert.ok(first.every(row => row.workspaceId === 'ws-a'))
  assert.equal(first.find(row => row.scene.peerId === '20002').effectiveMode, 'observe')
  core.close()
  const restarted = f.make()
  await restarted.provisionAuthorizedScenes()
  assert.equal(f.events.filter(event => event[0] === 'create').length, 3)
  assert.deepEqual(restarted.listScenePermissions().map(row => row.sessionId), first.map(row => row.sessionId))
  restarted.close()
})

test('changing only a Scene behavior parameter preserves its DSH Session and message history', async t => {
  const f = fixture(t, { workspaceId: 'ws-a' })
  const core = f.make()
  const scene = { botId, kind: 'group', peerId: '20001' }
  const first = await core.ingest(group('601'))
  assert.ok(first.sessionId)
  const historyBefore = core.store.getScene(scene).messages.length
  await core.setScenePermissions(scene, {
    mode: 'safe-chat', overrides: {},
    behavior: { ...BEHAVIOR_PRESETS['safe-chat'], quietWindowMs: 10000 },
  })
  const row = core.store.getScene(scene)
  assert.equal(row.sessionId, first.sessionId)
  assert.equal(row.messages.length, historyBefore)
  assert.equal(f.events.filter(item => item[0] === 'cancel').length, 0)
  assert.equal(f.events.filter(item => item[0] === 'create').length, 1)
  core.close()
})

test('adding an unrelated allowlisted Scene does not rebuild existing Scene Sessions', async t => {
  const f = fixture(t, { workspaceId: 'ws-a' })
  const core = f.make()
  await core.provisionAuthorizedScenes()
  const scene = { botId, kind: 'group', peerId: '20001' }
  const original = core.store.getScene(scene).sessionId
  const originalHistory = core.store.getScene(scene).messages.length
  core.close()
  const changed = new QQCore({
    store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    workspaceId: 'ws-a',
    policy: { ...policy, epoch: 1, groupIds: [...policy.groupIds, '20003'] },
  })
  await changed.provisionAuthorizedScenes()
  assert.equal(changed.store.getScene(scene).sessionId, original)
  assert.equal(changed.store.getScene(scene).messages.length, originalHistory)
  assert.equal(f.events.filter(item => item[0] === 'cancel' && item[1] === original).length, 0)
  changed.close()
})

test('a legacy binding without a security fingerprint still rejects an unknown policy epoch change', async t => {
  const f = fixture(t)
  const core = f.make()
  const scene = { botId, kind: 'group', peerId: '20001' }
  core.store.bindSession(scene, 'legacy-session', 0)
  assert.doesNotThrow(() => core.read('legacy-session'))
  core.close()
  const changed = new QQCore({
    store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    policy: { ...policy, epoch: 1 },
  })
  assert.throws(() => changed.read('legacy-session'), /QQ_PERMISSION_CHANGED/)
  changed.close()
})

test('a removed and re-added Scene cannot revive its old Session across a stopped plugin', async t => {
  const f = fixture(t, { workspaceId: 'ws-a' })
  const original = f.make()
  const first = await original.ingest(group('701'))
  original.close()
  const readded = new QQCore({
    store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    workspaceId: 'ws-a',
    policy: { ...policy, epoch: 2, sceneRevisions: { '10001:group:20001': 1 } },
  })
  const next = await readded.ingest(group('702'))
  assert.notEqual(next.sessionId, first.sessionId)
  assert.equal(readded.store.isKnownSession(first.sessionId), true)
  assert.deepEqual(readded.read(next.sessionId).messages.map(item => item.messageId), ['701', '702'])
  readded.close()
})

test('saved behavior batches a live turn and enforces autonomous cooldown without blocking direct mentions', async t => {
  let now = 100_000
  const requests = []
  const f = fixture(t, { clock: () => now, prompt: request => { requests.push(request); return { accepted: true } } })
  const core = f.make()
  const scene = { botId, kind: 'group', peerId: '20001' }
  core.store.setScenePermissions(scene, { mode: 'autonomous-social', overrides: {},
    behavior: { ...BEHAVIOR_PRESETS['autonomous-social'], quietWindowMs: 5000 } })
  assert.equal((await core.ingest(group('501', '20001', [{ type: 'text', data: { text: 'one' } }]))).status, 'queued')
  assert.equal((await core.ingest(group('502', '20001', [{ type: 'text', data: { text: 'two' } }]))).status, 'queued')
  assert.equal(requests.length, 0)
  await core.resumePending()
  assert.equal(requests.length, 1)
  assert.equal(JSON.parse(requests[0].content[0].text).messages.length, 2)
  assert.equal((await core.ingest(group('503', '20001', [{ type: 'text', data: { text: 'three' } }]))).status, 'stored')
  assert.equal((await core.ingest(group('504'))).status, 'queued', 'direct @ bypasses participation cooldown')
  core.close()
})

test('paused Scene remains manageable but every effective capability is denied', t => {
  const f = fixture(t, { policy: { ...policy, pausedScenes: [`${botId}:group:20001`] } })
  const core = f.make()
  const scene = { botId, kind: 'group', peerId: '20001' }
  core.store.setScenePermissions(scene, { mode: 'autonomous-social', overrides: {},
    behavior: BEHAVIOR_PRESETS['autonomous-social'] })
  const row = core.listScenePermissions().find(item => item.key === `${botId}:group:20001`)
  assert.equal(row.permissions.mode, 'autonomous-social')
  assert.equal(row.permissions.behavior.quietWindowMs, 12000)
  assert.ok(row.capabilities.every(capability => !capability.effective && capability.reason === 'scene-paused'))
  core.close()
})

test('legacy stored media locators are sanitized when read into a DSH Session', async t => {
  const prompts = []
  const f = fixture(t, { prompt: request => { prompts.push(request); return { accepted: true } } })
  const core = f.make()
  const first = await core.ingest(group('777'))
  core.close()
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  saved.scenes['10001:group:20001'].messages[0].segments.push({ type: 'image',
    data: { file: 'C:\\private\\legacy-secret.jpg', url: 'https://media.invalid/legacy-secret' } })
  fs.writeFileSync(f.file, JSON.stringify(saved))
  const restarted = f.make()
  const result = restarted.read(first.sessionId)
  assert.equal(JSON.stringify(result).includes('legacy-secret'), false)
  restarted.close()
  const pending = JSON.parse(fs.readFileSync(f.file, 'utf8'))
  pending.scenes['10001:group:20001'].messages[0].needsPrompt = true
  pending.scenes['10001:group:20001'].messages[0].prompted = false
  fs.writeFileSync(f.file, JSON.stringify(pending))
  const resumed = f.make()
  await resumed.resumePending()
  assert.equal(JSON.stringify(prompts.at(-1)?.content).includes('legacy-secret'), false)
  resumed.close()
})

test('Scene search grant reaches Session creation and revision change removes it', async t => {
  const grants = []
  const f = fixture(t, { create: (_scene, _sessionId, grant) => grants.push(grant?.searchAllowed) })
  const core = f.make()
  const first = await core.ingest(group('101'))
  assert.equal(first.status, 'prompted')
  assert.deepEqual(grants, [false], 'safe-chat does not inherit DSH search')
  await core.setScenePermissions({ botId, kind: 'group', peerId: '20001' },
    { mode: 'safe-chat', overrides: { 'dsh.search': 'allow' } })
  const second = await core.ingest(group('102'))
  assert.equal(second.status, 'prompted')
  assert.notEqual(second.sessionId, first.sessionId)
  assert.deepEqual(grants, [false, true], 'the new Session receives only the explicit search grant')
  core.close()
})

test('autonomous group participation merges a short inbound burst and reuses its durable request on restart', async t => {
  let fail = true
  const requests = []
  const f = fixture(t, { prompt: request => {
    requests.push(request)
    if (fail) throw new Error('transient model failure')
    return { accepted: true }
  } })
  const scene = { botId, kind: 'group', peerId: '20001' }
  const core = f.make()
  core.store.setScenePermissions(scene, { mode: 'autonomous-social', overrides: {} })
  const plain = id => group(id, '20001', [{ type: 'text', data: { text: `message ${id}` } }])
  assert.equal((await core.ingest(plain('701'))).status, 'queued')
  assert.equal((await core.ingest(plain('702'))).status, 'queued')
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(requests.length, 1)
  assert.equal(JSON.parse(requests[0].content[0].text).messages.length, 2)
  const requestId = requests[0].requestId
  core.close()
  fail = false
  const restarted = f.make()
  await restarted.resumePending()
  assert.equal(requests.at(-1).requestId, requestId)
  assert.equal(restarted.store.getScene(scene).messages.filter(item => item.prompted).length, 2)
  restarted.close()
})

test('live batch waits for quiet after the latest message', async t => {
  const requests = []
  const f = fixture(t, { prompt: request => { requests.push(request); return { accepted: true } } })
  const core = f.make()
  const scene = { botId, kind: 'group', peerId: '20001' }
  core.store.setScenePermissions(scene, { mode: 'autonomous-social', overrides: {} })
  const plain = id => group(id, '20001', [{ type: 'text', data: { text: `message ${id}` } }])
  await core.ingest(plain('801'))
  await new Promise(resolve => setTimeout(resolve, 500))
  await core.ingest(plain('802'))
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(requests.length, 0, 'the first message timer must be reset by the second')
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(requests.length, 1)
  assert.equal(JSON.parse(requests[0].content[0].text).messages.length, 2)
  core.close()
})

test('changing Workspace revokes the old QQ Session and binds the next turn to the selected Workspace', async t => {
  const f = fixture(t, { workspaceId: 'ws-a' })
  const firstCore = f.make()
  const first = await firstCore.ingest(group('901'))
  assert.equal(firstCore.store.getScene({ botId, kind: 'group', peerId: '20001' }).workspaceId, 'ws-a')
  firstCore.close()
  const nextCore = new QQCore({ store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    policy, workspaceId: 'ws-b' })
  assert.equal(nextCore.authorizeSessionCapability(first.sessionId, 'qq.send'), false)
  const second = await nextCore.ingest(group('902'))
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(nextCore.store.getScene({ botId, kind: 'group', peerId: '20001' }).workspaceId, 'ws-b')
  assert.ok(f.events.some(event => event[0] === 'cancel' && event[1] === first.sessionId))
  nextCore.close()
})

test('one activity sends, uses another tool, sends again, waits and continues same Session', async t => {
  const f = fixture(t)
  const core = f.make()
  const first = await core.ingest(group('101'))
  assert.equal(first.status, 'prompted')
  const sessionId = first.sessionId
  const sent1 = await core.send(sessionId, { actionId: 'act-1', segments: [{ type: 'text', data: { text: 'First reply' } }] })
  assert.equal(sent1.status, 'delivered')
  f.events.push(['other-dsh-tool', 'completed'])
  const sent2 = await core.send(sessionId, { actionId: 'act-2', segments: [{ type: 'text', data: { text: 'Second reply' } }] })
  assert.equal(sent2.status, 'delivered')
  const waiting = core.wait(sessionId, { timeoutMs: 1000 })
  const arrived = await core.ingest(group('102', '20001', [{ type: 'text', data: { text: 'another question' } }]))
  assert.equal(arrived.status, 'continued')
  const result = await waiting
  assert.equal(result.arrived, true)
  assert.deepEqual(result.messages.map(item => item.messageId), ['102'])
  assert.equal(new QQStore(f.file).getScene({ botId, kind: 'group', peerId: '20001' })
    .messages.find(item => item.messageId === '102').prompted, true,
    'a message delivered by wait must not be prompted again after restart')
  const sent3 = await core.send(sessionId, { actionId: 'act-3', segments: [{ type: 'text', data: { text: 'Continuing' } }] })
  assert.equal(sent3.status, 'delivered')
  assert.equal(f.events.filter(item => item[0] === 'create').length, 1)
  assert.equal(f.events.filter(item => item[0] === 'prompt').length, 1)
  assert.deepEqual(f.events.map(item => item[0]), ['create', 'prompt', 'send', 'other-dsh-tool', 'send', 'send'])
  core.close()
  const restarted = f.make()
  assert.deepEqual(await restarted.resumePending(), { resumed: 0 })
  restarted.close()
})

test('group scenes and owner private scene are isolated; passive group traffic does not start model', async t => {
  const f = fixture(t)
  const core = f.make()
  const a = await core.ingest(group('101'))
  const b = await core.ingest(group('201', '20002'))
  const p = await core.ingest(privateMessage('301'))
  assert.equal(new Set([a.sessionId, b.sessionId, p.sessionId]).size, 3)
  assert.equal((await core.ingest(group('102', '20001', [{ type: 'text', data: { text: 'ordinary chatter' } }]))).status, 'stored')
  assert.equal(f.events.filter(item => item[0] === 'prompt').length, 3)
  assert.deepEqual(core.read(a.sessionId).messages.map(item => item.messageId), ['101', '102'])
  assert.deepEqual(core.read(b.sessionId).messages.map(item => item.messageId), ['201'])
  assert.deepEqual(core.read(p.sessionId).messages.map(item => item.messageId), ['301'])
  assert.equal((await core.ingest(group('999', '88888'))).status, 'unauthorized')
  assert.equal((await core.ingest(group('101'))).status, 'duplicate')
  core.close()
})

test('passive group chatter rolls over without blocking later addressed messages', async t => {
  const f = fixture(t, { maxMessages: 8 })
  const core = f.make()
  const first = await core.ingest(group('100'))
  for (let i = 0; i < 20; i++) {
    await core.ingest(group(String(200 + i), '20001', [{ type: 'text', data: { text: `background ${i}` } }]))
  }
  const addressed = await core.ingest(group('999'))
  assert.equal(addressed.status, 'prompted')
  assert.equal(addressed.sessionId, first.sessionId)
  const stored = new QQStore(f.file).getScene({ botId, kind: 'group', peerId: '20001' })
  assert.ok(stored.messages.length <= 8)
  assert.ok(stored.messages.some(item => item.messageId === '100'), 'unread addressed message survives')
  assert.ok(stored.messages.some(item => item.messageId === '999'), 'new addressed message is delivered')
  assert.equal(f.events.filter(item => item[0] === 'prompt').length, 2)
  core.close()
})

test('delivered action ledger rolls over without losing recent retry protection', async t => {
  const f = fixture(t, { maxDeliveries: 5 })
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const args = n => ({ actionId: `send-${n}`, segments: [{ type: 'text', data: { text: `message ${n}` } }] })
  for (let n = 1; n <= 6; n++) {
    assert.equal((await core.send(sessionId, args(n))).status, 'delivered')
  }
  const sendsBeforeRetry = f.events.filter(item => item[0] === 'send').length
  assert.equal((await core.send(sessionId, args(6))).repeated, true)
  assert.equal(f.events.filter(item => item[0] === 'send').length, sendsBeforeRetry)
  core.close()
  const restarted = f.make()
  assert.equal((await restarted.send(sessionId, args(6))).repeated, true)
  restarted.close()
})

test('unknown delivery remains unknown across restart and actionId cannot send twice', async t => {
  const f = fixture(t, { send: async () => { throw new Error('network timeout after request') } })
  let core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const args = { actionId: 'retry-1', segments: [{ type: 'text', data: { text: 'once' } }] }
  assert.deepEqual(await core.send(sessionId, args), { status: 'unknown', repeated: false, messageId: null })
  core.close()
  core = f.make()
  assert.deepEqual(await core.send(sessionId, args), { status: 'unknown', repeated: true, messageId: null })
  await assert.rejects(core.send(sessionId, { ...args, segments: [{ type: 'text', data: { text: 'changed' } }] }), /CONFLICT/)
  core.close()
})

test('unknown delivery blocks a new actionId with identical content across restart', async t => {
  let sendCount = 0
  const f = fixture(t, { send: async () => { sendCount++; throw new Error('network timeout after request') } })
  let core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const segments = [{ type: 'text', data: { text: 'ambiguous delivery' } }]
  const first = { actionId: 'uncertain-a', segments }
  assert.equal((await core.send(sessionId, first)).status, 'unknown')
  await assert.rejects(core.send(sessionId, { actionId: 'uncertain-b', segments }), /QQ_DELIVERY_UNRESOLVED/)
  assert.equal(sendCount, 1)
  assert.equal(new QQStore(f.file).getScene({ botId, kind: 'private', peerId: '30001' }).deliveries.length, 1,
    'a refused new action must not reserve another ledger entry')
  core.close()

  core = f.make()
  assert.deepEqual(await core.send(sessionId, first), { status: 'unknown', repeated: true, messageId: null })
  await assert.rejects(core.send(sessionId, { actionId: 'uncertain-c', segments }), /QQ_DELIVERY_UNRESOLVED/)
  assert.equal(sendCount, 1)
  assert.equal((await core.send(sessionId, { actionId: 'different-content',
    segments: [{ type: 'text', data: { text: 'a different message' } }] })).status, 'unknown')
  assert.equal(sendCount, 2, 'a distinct message is not blocked by the prior unknown delivery')
  core.close()
})

test('an in-flight unknown reservation blocks another actionId with identical content', async t => {
  let releaseSend
  let sendCount = 0
  const f = fixture(t, { send: () => {
    sendCount++
    return sendCount === 1 ? new Promise(resolve => { releaseSend = resolve }) : Promise.resolve({ messageId: '90003' })
  } })
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const segments = [{ type: 'text', data: { text: 'in flight' } }]
  const pending = core.send(sessionId, { actionId: 'in-flight-a', segments })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sendCount, 1)
  try {
    await assert.rejects(core.send(sessionId, { actionId: 'in-flight-b', segments }), /QQ_DELIVERY_UNRESOLVED/)
    assert.equal(sendCount, 1)
  } finally {
    releaseSend({ messageId: '90002' })
    await pending
  }
  core.close()
})

test('restart reuses persisted Session and replays an unaccepted prompt with stable requestId', async t => {
  const f = fixture(t)
  const originalPrompt = f.dsh.prompt
  let firstRequestId
  f.dsh.prompt = async request => { firstRequestId = request.requestId; throw new Error('DSH disconnected before admission') }
  let core = f.make()
  await assert.rejects(core.ingest(privateMessage('301')), /disconnected/)
  const storedSession = new QQStore(f.file).snapshot().scenes['10001:private:30001'].sessionId
  core.close()
  f.dsh.prompt = originalPrompt
  core = f.make()
  assert.deepEqual(await core.resumePending(), { resumed: 1 })
  assert.equal(f.events.find(item => item[0] === 'prompt')[2], firstRequestId)
  const second = await core.ingest(privateMessage('302'))
  assert.equal(second.sessionId, storedSession)
  assert.equal(f.events.filter(item => item[0] === 'create').length, 1)
  core.close()
})

test('removing a Scene from the allowlist blocks old Session tools and re-adding cannot resurrect it', async t => {
  const f = fixture(t)
  const original = f.make()
  const { sessionId } = await original.ingest(group('101'))
  original.close()
  const removed = new QQCore({ store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    policy: { ...policy, epoch: 1, groupIds: ['20002'] } })
  assert.throws(() => removed.read(sessionId), /UNAUTHORIZED/)
  await assert.rejects(removed.send(sessionId, { actionId: 'a', segments: [{ type: 'text', data: { text: 'blocked' } }] }), /UNAUTHORIZED/)
  assert.equal(removed.store.getScene({ botId, kind: 'group', peerId: '20001' }).sessionId, null)
  assert.equal(removed.store.isKnownSession(sessionId), true)
  removed.close()
  const readded = new QQCore({ store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    policy: { ...policy, epoch: 2 } })
  const next = await readded.ingest(group('102'))
  assert.equal(next.status, 'prompted')
  assert.notEqual(next.sessionId, sessionId)
  assert.deepEqual(readded.read(next.sessionId).messages.map(item => item.messageId), ['101', '102'])
  readded.close()
})

test('Scene permission revision revokes a live Session before any new QQ send', async t => {
  const f = fixture(t)
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const scene = { botId, kind: 'private', peerId: '30001' }
  core.store.setScenePermissions(scene, { mode: 'observe', overrides: {} })
  const before = f.events.filter(event => event[0] === 'send').length
  await assert.rejects(core.send(sessionId, {
    actionId: 'after-revocation', segments: [{ type: 'text', data: { text: 'must not send' } }],
  }), /QQ_PERMISSION_CHANGED/)
  assert.equal(f.events.filter(event => event[0] === 'send').length, before)
  assert.equal((await core.ingest(privateMessage('302'))).status, 'stored')
  core.close()
})

test('revocation during send reservation never reaches OneBot or leaves an unsettled action', async t => {
  const f = fixture(t)
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  const { sessionId } = await core.ingest(privateMessage('301'))
  const reserve = core.store.reserveDelivery.bind(core.store)
  core.store.reserveDelivery = (...args) => {
    const result = reserve(...args)
    core.store.setScenePermissions(scene, { mode: 'observe', overrides: {} })
    return result
  }

  await assert.rejects(core.send(sessionId, {
    actionId: 'revoked-before-send', segments: [{ type: 'text', data: { text: 'must not leave' } }],
  }), /QQ_PERMISSION_CHANGED|QQ_PERMISSION_DENIED/)
  assert.equal(f.events.filter(event => event[0] === 'send').length, 0)
  const delivery = new QQStore(f.file).getScene(scene).deliveries.find(item => item.actionId === 'revoked-before-send')
  assert.equal(delivery?.status, 'failed', 'revoked action must not remain permanently unsettled')
  core.close()
})

test('Observe mode and per-Scene send deny do not wake the model', async t => {
  const f = fixture(t)
  const core = f.make()
  const groupScene = { botId, kind: 'group', peerId: '20001' }
  core.store.setScenePermissions(groupScene, { mode: 'observe', overrides: {} })
  assert.equal((await core.ingest(group('401'))).status, 'stored')
  core.store.setScenePermissions(groupScene, { mode: 'safe-chat', overrides: { 'qq.send': 'deny' } })
  assert.equal((await core.ingest(group('402'))).status, 'stored')
  assert.equal(f.events.filter(event => event[0] === 'prompt').length, 0)
  core.close()
})

test('a changed Scene cancels its old activity and starts a fresh Session when sending is allowed again', async t => {
  const f = fixture(t)
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  const first = await core.ingest(privateMessage('501'))
  core.store.setScenePermissions(scene, { mode: 'observe', overrides: {} })
  assert.equal((await core.ingest(privateMessage('502'))).status, 'stored')
  core.store.setScenePermissions(scene, { mode: 'safe-chat', overrides: {} })
  const next = await core.ingest(privateMessage('503'))
  assert.equal(next.status, 'prompted')
  assert.notEqual(next.sessionId, first.sessionId)
  assert.deepEqual(f.events.filter(event => event[0] === 'cancel'), [['cancel', first.sessionId]])
  await assert.rejects(core.send(first.sessionId, {
    actionId: 'stale-session', segments: [{ type: 'text', data: { text: 'stale' } }],
  }), /QQ_UNAUTHORIZED|QQ_PERMISSION_CHANGED/)
  assert.equal(core.store.isKnownSession(first.sessionId), true, 'retired Session remains in the guard index')
  assert.equal(core.store.isKnownSession(next.sessionId), true)
  core.close()
  assert.equal(new QQStore(f.file).isKnownSession(first.sessionId), true, 'retirement survives restart')
})

test('permission setter revokes immediately, and failed cancellation cannot create a replacement Session', async t => {
  const f = fixture(t, { cancel: () => ({ accepted: false }) })
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  const first = await core.ingest(privateMessage('511'))
  await assert.rejects(core.setScenePermissions(scene, { mode: 'observe', overrides: {} }), /QQ_SESSION_CANCEL_FAILED/)
  await assert.rejects(core.send(first.sessionId, {
    actionId: 'after-failed-cancel', segments: [{ type: 'text', data: { text: 'blocked' } }],
  }), /QQ_PERMISSION_CHANGED/)
  core.store.setScenePermissions(scene, { mode: 'safe-chat', overrides: {} })
  await assert.rejects(core.ingest(privateMessage('512')), /QQ_SESSION_CANCEL_FAILED/)
  assert.equal(f.events.filter(event => event[0] === 'create').length, 1)
  assert.equal(f.events.filter(event => event[0] === 'send').length, 0)
  core.close()
})

test('a permission change during prompt acceptance keeps the message pending for safe replay', async t => {
  let started
  let release
  const entered = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const f = fixture(t, { prompt: async () => { started(); await held; return { accepted: true } } })
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  const ingestion = core.ingest(privateMessage('521'))
  await entered
  core.store.setScenePermissions(scene, { mode: 'observe', overrides: {} })
  release()
  await assert.rejects(ingestion, /QQ_PERMISSION_CHANGED/)
  const message = core.store.getScene(scene).messages.find(item => item.messageId === '521')
  assert.equal(message.needsPrompt, true)
  assert.equal(message.prompted, false)
  core.close()
})

test('revoked wait cannot consume the first message for a replacement Session', async t => {
  const f = fixture(t)
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  const first = await core.ingest(privateMessage('531'))
  const waiting = core.wait(first.sessionId, { timeoutMs: 5000 })
  await core.setScenePermissions(scene, { mode: 'observe', overrides: {} })
  await assert.rejects(waiting, /QQ_UNAUTHORIZED|QQ_PERMISSION_CHANGED/)
  await core.setScenePermissions(scene, { mode: 'safe-chat', overrides: {} })
  const next = await core.ingest(privateMessage('532'))
  assert.equal(next.status, 'prompted')
  assert.notEqual(next.sessionId, first.sessionId)
  assert.equal(core.health().activeWaits, 0)
  core.close()
})

test('permission change while creating a Session retires the orphan before it can prompt', async t => {
  let started
  let release
  const entered = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const f = fixture(t, { create: async () => { started(); await held } })
  const core = f.make()
  const scene = { botId, kind: 'private', peerId: '30001' }
  const ingestion = core.ingest(privateMessage('541'))
  await entered
  core.store.setScenePermissions(scene, { mode: 'observe', overrides: {} })
  release()
  await assert.rejects(ingestion, /QQ_PERMISSION_CHANGED/)
  assert.equal(core.store.getScene(scene).sessionId, null)
  assert.equal(core.store.isKnownSession('session-1'), true)
  assert.equal(f.events.filter(event => event[0] === 'prompt').length, 0)
  core.close()
})

test('trusted Host Scene comes only from a current bound Session and stable owner private ID', async t => {
  const f = fixture(t, { permissionPolicy: { ownerPrivateIds: ['30001'] } })
  const core = f.make()
  const groupSession = (await core.ingest(group('551'))).sessionId
  const ownerSession = (await core.ingest(privateMessage('552'))).sessionId
  assert.deepEqual(core.trustedSceneForSession(groupSession), {
    platform: 'qq', kind: 'group', id: '10001:20001', verified: true, admin: false,
  })
  assert.deepEqual(core.trustedSceneForSession(ownerSession), {
    platform: 'qq', kind: 'private', id: '10001:30001', verified: true, admin: true,
  })
  assert.throws(() => core.trustedSceneForSession('forged-session'), /QQ_UNAUTHORIZED/)
  await core.setScenePermissions({ botId, kind: 'private', peerId: '30001' }, { mode: 'observe', overrides: {} })
  assert.throws(() => core.trustedSceneForSession(ownerSession), /QQ_UNAUTHORIZED|QQ_PERMISSION_CHANGED/)
  core.close()
})

test('reply and mention must resolve inside the bound group scene', async t => {
  const f = fixture(t)
  const core = f.make()
  const a = await core.ingest(group('101'))
  await core.ingest(group('201', '20002'))
  await assert.rejects(core.send(a.sessionId, { actionId: 'cross-reply', segments: [
    { type: 'reply', data: { id: '201' } }, { type: 'text', data: { text: 'unsafe' } },
  ] }), /REPLY_SCOPE/)
  await assert.rejects(core.send(a.sessionId, { actionId: 'unknown-mention', segments: [
    { type: 'at', data: { qq: '49999' } }, { type: 'text', data: { text: 'unsafe' } },
  ] }), /AT_SCOPE/)
  assert.equal(f.transport.status, 'mock')
  core.close()
})

test('pending delivery saturation is diagnosed and passive chatter drops instead of blocking', async t => {
  const f = fixture(t, { maxMessages: 2 })
  f.dsh.prompt = async () => { throw new Error('DSH disconnected') }
  const core = f.make()
  await assert.rejects(core.ingest(group('101')), /disconnected/)
  await assert.rejects(core.ingest(group('102')), /disconnected/)
  await assert.rejects(core.ingest(group('103')), /QQ_QUEUE_FULL: .*pending delivery/)
  assert.deepEqual(await core.ingest(group('104', '20001', [{ type: 'text', data: { text: 'background' } }])),
    { status: 'dropped', reason: 'passive_window' })
  assert.equal(new QQStore(f.file).getScene({ botId, kind: 'group', peerId: '20001' }).messages.length, 2)
  let prompts = 0
  f.dsh.prompt = async () => { prompts++; return { accepted: true } }
  assert.deepEqual(await core.resumePending(), { resumed: 2 })
  assert.equal((await core.ingest(group('103'))).status, 'prompted')
  assert.equal(prompts, 3)
  core.close()
})

test('saturated outbox refuses only when every action is unknown and never forgets one', async t => {
  const f = fixture(t, { maxDeliveries: 2, send: async () => { throw new Error('network timeout') } })
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const args = n => ({ actionId: `uncertain-${n}`, segments: [{ type: 'text', data: { text: `m${n}` } }] })
  assert.equal((await core.send(sessionId, args(1))).status, 'unknown')
  assert.equal((await core.send(sessionId, args(2))).status, 'unknown')
  const sends = f.events.filter(item => item[0] === 'send').length
  await assert.rejects(core.send(sessionId, args(3)), /QQ_OUTBOX_FULL: .*unsettled/)
  assert.equal(f.events.filter(item => item[0] === 'send').length, sends, 'a refused send must not reach the transport')
  core.close()
  const restarted = f.make()
  assert.deepEqual(await restarted.send(sessionId, args(1)), { status: 'unknown', repeated: true, messageId: null })
  await assert.rejects(restarted.send(sessionId, { ...args(1), segments: [{ type: 'text', data: { text: 'changed' } }] }), /CONFLICT/)
  restarted.close()
})

test('rejected sends settle failed, repeat as failed, and reject actionId conflicts', async t => {
  const send = async () => { const error = new Error('rejected by OneBot'); error.code = 'ONEBOT_REJECTED'; throw error }
  const f = fixture(t, { send })
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const args = { actionId: 'rejected-1', segments: [{ type: 'text', data: { text: 'once' } }] }
  assert.deepEqual(await core.send(sessionId, args), { status: 'failed', repeated: false, messageId: null })
  const sends = f.events.filter(item => item[0] === 'send').length
  assert.deepEqual(await core.send(sessionId, args), { status: 'failed', repeated: true, messageId: null })
  assert.equal(f.events.filter(item => item[0] === 'send').length, sends, 'failed action must not be resent')
  await assert.rejects(core.send(sessionId, { ...args, segments: [{ type: 'text', data: { text: 'different' } }] }), /CONFLICT/)
  core.close()
})

test('archived successful action remains deduplicated after restart', async t => {
  const f = fixture(t, { maxDeliveries: 2 })
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('301'))
  const args = n => ({ actionId: `archived-${n}`, segments: [{ type: 'text', data: { text: `m${n}` } }] })
  for (const n of [1, 2, 3]) assert.equal((await core.send(sessionId, args(n))).status, 'delivered')
  core.close()
  const restarted = f.make()
  const replayed = await restarted.send(sessionId, args(1))
  assert.equal(replayed.repeated, true)
  assert.equal(replayed.status, 'delivered')
  await assert.rejects(restarted.send(sessionId, { ...args(1), segments: [{ type: 'text', data: { text: 'changed' } }] }), /CONFLICT/)
  restarted.close()
})

test('prepared media sends and file uploads use the persistent action ledger', async t => {
  const f = fixture(t)
  const core = f.make()
  const { sessionId } = await core.ingest(privateMessage('901'))
  const fingerprint = 'a'.repeat(64)
  const plan = {
    mode: 'message',
    fingerprint,
    segments: [{ type: 'image', data: { file: 'C:\\snapshot\\image.png' } }],
  }
  assert.deepEqual(await core.sendPreparedMedia(sessionId, 'media-1', plan),
    { status: 'delivered', repeated: false, messageId: '90001' })
  assert.deepEqual(await core.sendPreparedMedia(sessionId, 'media-1', plan),
    { status: 'delivered', repeated: true, messageId: '90001' })
  assert.deepEqual(await core.sendPreparedMedia(sessionId, 'audio-1', {
    ...plan,
    fingerprint: 'f'.repeat(64),
    segments: [{ type: 'record', data: { file: 'C:\\snapshot\\voice.wav' } }],
  }), { status: 'delivered', repeated: false, messageId: '90001' })
  await assert.rejects(core.sendPreparedMedia(sessionId, 'media-1', {
    ...plan, fingerprint: 'e'.repeat(64), segments: [{ type: 'image', data: { file: 'C:\\snapshot\\other.png' } }],
  }), /ACTION_CONFLICT/)
  await assert.rejects(core.sendPreparedMedia(sessionId, 'media-1', {
    ...plan, segments: [{ type: 'video', data: { file: 'C:\\snapshot\\same-bytes.mp4' } }],
  }), /ACTION_CONFLICT/)
  assert.equal((await core.sendPreparedMedia(sessionId, 'media-1', {
    ...plan, segments: [{ type: 'image', data: { file: 'C:\\snapshot\\relocated.png' } }],
  })).repeated, true, 'temporary snapshot path is not part of the ledger identity')

  const unknown = fixture(t, { send: async () => { throw new Error('transport timeout') } })
  const unknownCore = unknown.make()
  const unknownSession = (await unknownCore.ingest(privateMessage('902'))).sessionId
  assert.deepEqual(await unknownCore.sendPreparedMedia(unknownSession, 'media-2', plan),
    { status: 'unknown', repeated: false, messageId: null })
  await assert.rejects(unknownCore.sendPreparedMedia(unknownSession, 'media-3', plan), /DELIVERY_UNRESOLVED/)
  unknownCore.close()

  f.transport.action = async () => ({ file_id: 'file_abc' })
  const upload = {
    mode: 'upload',
    action: 'upload_private_file',
    fingerprint: 'b'.repeat(64),
    params: { user_id: '30001', file: 'C:\\snapshot\\doc.pdf', name: 'doc.pdf', upload_file: true },
  }
  assert.deepEqual(await core.uploadSceneFile(sessionId, 'upload-1', upload),
    { status: 'delivered', repeated: false, fileId: 'file_abc' })
  assert.deepEqual(await core.uploadSceneFile(sessionId, 'upload-1', upload),
    { status: 'delivered', repeated: true, fileId: 'file_abc' })
  await assert.rejects(core.uploadSceneFile(sessionId, 'upload-1', {
    ...upload, params: { ...upload.params, name: 'renamed.pdf' },
  }), /ACTION_CONFLICT/)
  f.transport.action = async () => ({})
  assert.equal((await core.uploadSceneFile(sessionId, 'upload-2', {
    ...upload, fingerprint: 'c'.repeat(64),
  })).status, 'unknown')

  core.close()
  const restarted = f.make()
  assert.equal((await restarted.sendPreparedMedia(sessionId, 'media-1', {
    ...plan, segments: [{ type: 'image', data: { file: 'C:\\snapshot\\after-restart.png' } }],
  })).repeated, true)
  assert.equal((await restarted.uploadSceneFile(sessionId, 'upload-1', upload)).repeated, true)
  restarted.store.setScenePermissions({ botId, kind: 'private', peerId: '30001' }, { mode: 'observe', overrides: {} })
  await assert.rejects(restarted.sendPreparedMedia(sessionId, 'media-revoked', {
    ...plan, fingerprint: 'd'.repeat(64),
  }), /PERMISSION|UNAUTHORIZED|CHANGED/)
  restarted.close()
})

test('group upload verifies a new platform file when NapCat returns no file_id', async t => {
  const f = fixture(t)
  const core = f.make()
  const { sessionId } = await core.ingest(group('903'))
  const plan = {
    mode: 'upload', action: 'upload_group_file', fingerprint: 'd'.repeat(64), bytes: 49,
    params: { group_id: '20001', file: 'C:\\snapshot\\qa.txt', name: 'qa.txt', upload_file: true },
  }
  const calls = []
  f.transport.action = async (name, params) => {
    calls.push(name)
    if (name === 'upload_group_file') return {}
    if (name === 'get_group_root_files') return { files: calls.length === 1 ? [] : [
      { group_id: 20001, file_id: 'new_file_1', file_name: 'qa.txt', file_size: 49, uploader: 10001 },
    ] }
    throw new Error('unexpected platform action')
  }
  assert.deepEqual(await core.uploadSceneFile(sessionId, 'group-upload-1', plan),
    { status: 'delivered', repeated: false, fileId: 'new_file_1' })
  assert.deepEqual(calls, ['get_group_root_files', 'upload_group_file', 'get_group_root_files'])
  assert.deepEqual(await core.uploadSceneFile(sessionId, 'group-upload-1', plan),
    { status: 'delivered', repeated: true, fileId: 'new_file_1' })
  core.close()

  const ambiguous = fixture(t)
  const ambiguousCore = ambiguous.make()
  const { sessionId: ambiguousSession } = await ambiguousCore.ingest(group('904'))
  ambiguous.transport.action = async name => name === 'upload_group_file' ? {} : { files: [
    { group_id: 20001, file_id: 'existing_file', file_name: 'qa.txt', file_size: 49, uploader: 10001 },
  ] }
  assert.deepEqual(await ambiguousCore.uploadSceneFile(ambiguousSession, 'group-upload-2', plan),
    { status: 'unknown', repeated: false, fileId: null })
  ambiguousCore.close()
})

test('group upload does not guess a file id from failed or ambiguous listings', async t => {
  for (const [index, [label, listings]] of [
    ['preflight failed', [new Error('listing unavailable')]],
    ['after upload failed', [{ files: [] }, new Error('listing unavailable')]],
    ['rotating ids for an old file', [{ files: [
      { group_id: 20001, file_id: 'old_id', file_name: 'qa.txt', file_size: 49, uploader: 10001, modify_time: 100 },
    ] }, { files: [
      { group_id: 20001, file_id: 'rotated_id', file_name: 'qa.txt', file_size: 49, uploader: 10001, modify_time: 100 },
    ] }]],
    ['same second collision', [{ files: [
      { group_id: 20001, file_id: 'old_id', file_name: 'qa.txt', file_size: 49, uploader: 10001, modify_time: 100 },
    ] }, { files: [
      { group_id: 20001, file_id: 'rotated_id', file_name: 'qa.txt', file_size: 49, uploader: 10001, modify_time: 100 },
      { group_id: 20001, file_id: 'other_id', file_name: 'qa.txt', file_size: 49, uploader: 10001, modify_time: 100 },
    ] }]],
    ['two matching new files', [{ files: [] }, { files: ['one', 'two'].map(file_id => ({
      group_id: 20001, file_id, file_name: 'qa.txt', file_size: 49, uploader: 10001,
    })) }]],
  ].entries()) {
    const f = fixture(t)
    const core = f.make()
    const { sessionId } = await core.ingest(group(String(905 + index)))
    let uploadCount = 0
    f.transport.action = async name => {
      if (name === 'upload_group_file') { uploadCount++; return {} }
      const next = listings.shift()
      if (next instanceof Error) throw next
      return next
    }
    const plan = { mode: 'upload', action: 'upload_group_file', fingerprint: 'e'.repeat(64), bytes: 49,
      params: { group_id: '20001', file: 'C:\\snapshot\\qa.txt', name: 'qa.txt', upload_file: true } }
    assert.equal((await core.uploadSceneFile(sessionId, `upload-${label.replaceAll(' ', '-')}`, plan)).status,
      'unknown', label)
    assert.equal(uploadCount, 1, label)
    core.close()
  }
})

test('group upload distinguishes a new same-name file by stable modify time', async t => {
  const f = fixture(t)
  const core = f.make()
  const { sessionId } = await core.ingest(group('909'))
  let reads = 0
  const old = { group_id: 20001, file_name: 'qa.txt', file_size: 49, uploader: 10001,
    modify_time: 100 }
  f.transport.action = async name => {
    if (name === 'upload_group_file') return {}
    reads++
    return { files: reads === 1 ? [{ ...old, file_id: 'old_id' }] : [
      { ...old, file_id: 'rotated_old_id' }, { ...old, file_id: 'new_id', modify_time: 101 },
    ] }
  }
  const plan = { mode: 'upload', action: 'upload_group_file', fingerprint: 'f'.repeat(64), bytes: 49,
    params: { group_id: '20001', file: 'C:\\snapshot\\qa.txt', name: 'qa.txt', upload_file: true } }
  assert.deepEqual(await core.uploadSceneFile(sessionId, 'upload-new-same-name', plan),
    { status: 'delivered', repeated: false, fileId: 'new_id' })
  core.close()
})

test('group upload rechecks permission after preflight listing', async t => {
  const f = fixture(t)
  const core = f.make()
  const { sessionId } = await core.ingest(group('908'))
  const calls = []
  f.transport.action = async name => {
    calls.push(name)
    core.store.setScenePermissions({ botId, kind: 'group', peerId: '20001' },
      { mode: 'observe', overrides: {} })
    return { files: [] }
  }
  const plan = { mode: 'upload', action: 'upload_group_file', fingerprint: 'f'.repeat(64), bytes: 49,
    params: { group_id: '20001', file: 'C:\\snapshot\\qa.txt', name: 'qa.txt', upload_file: true } }
  await assert.rejects(core.uploadSceneFile(sessionId, 'upload-revoke', plan),
    /PERMISSION|UNAUTHORIZED|CHANGED/)
  assert.deepEqual(calls, ['get_group_root_files'], 'revoked Session must never upload the file')
  core.close()
})
