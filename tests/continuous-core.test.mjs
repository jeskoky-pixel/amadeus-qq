import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'

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
    async createSceneSession(scene) {
      const sessionId = `session-${nextSession++}`
      events.push(['create', scene.kind, scene.peerId, sessionId])
      if (options.create) await options.create(scene, sessionId)
      return { sessionId }
    },
    async prompt(request) { events.push(['prompt', request.sessionId, request.requestId]); return options.prompt?.(request) ?? { accepted: true } },
    async cancelSceneSession(sessionId) { events.push(['cancel', sessionId]); return options.cancel?.(sessionId) ?? { accepted: true } },
  }
  const transport = {
    status: 'mock',
    send: options.send ?? (async (_scene, segments) => { events.push(['send', segments]); return { messageId: '90001' } }),
    stop() {},
  }
  const make = () => new QQCore({
    store: new QQStore(file, {
      maxMessages: options.maxMessages ?? 500,
      maxDeliveries: options.maxDeliveries ?? 500,
    }),
    dsh, transport, policy: options.policy ?? policy,
    permissionPolicy: options.permissionPolicy ?? {},
  })
  return { file, events, dsh, transport, make }
}

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

test('permission version change blocks old Session tools even when the scene remains listed', async t => {
  const f = fixture(t)
  const original = f.make()
  const { sessionId } = await original.ingest(group('101'))
  original.close()
  const changed = new QQCore({ store: new QQStore(f.file), dsh: f.dsh, transport: f.transport,
    policy: { ...policy, epoch: 1 } })
  assert.throws(() => changed.read(sessionId), /UNAUTHORIZED/)
  await assert.rejects(changed.send(sessionId, { actionId: 'a', segments: [{ type: 'text', data: { text: 'blocked' } }] }), /UNAUTHORIZED/)
  changed.close()
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
