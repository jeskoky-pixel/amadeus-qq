import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { QQStore, sceneKey } from '../src/storage.js'

function fixture(t, limits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'qq-state.json')
  return { file, store: new QQStore(file, limits) }
}

const groupA = { botId: '10001', kind: 'group', peerId: '20001' }
const groupB = { botId: '10001', kind: 'group', peerId: '20002' }
const privateA = { botId: '10001', kind: 'private', peerId: '20001' }
const otherBot = { botId: '10002', kind: 'group', peerId: '20001' }

test('scene identities separate bot, group and private and survive restart', t => {
  const { file, store } = fixture(t)
  assert.equal(new Set([groupA, groupB, privateA, otherBot].map(sceneKey)).size, 4)
  store.bindSession(groupA, 'session-A', 2)
  store.bindSession(groupB, 'session-B', 2)
  store.bindSession(privateA, 'session-private', 3)
  assert.throws(() => store.bindSession(otherBot, 'session-A'), /already bound/)
  const reopened = new QQStore(file)
  assert.equal(reopened.getScene(groupA).sessionId, 'session-A')
  assert.equal(reopened.getScene(groupA).authEpoch, 2)
  assert.equal(reopened.getScene(groupB).sessionId, 'session-B')
  assert.equal(reopened.getScene(privateA).sessionId, 'session-private')
  assert.equal(reopened.getScene(otherBot), null)
})

test('duplicate input is not requeued after restart and read watermark preserves later messages', t => {
  const { file, store } = fixture(t)
  const message = { messageId: '-17', senderId: '777', segments: [{ type: 'text', data: { text: 'first' } }] }
  assert.deepEqual(store.appendMessage(groupA, message), { duplicate: false, seq: 1 })
  assert.deepEqual(store.appendMessage(groupA, message), { duplicate: true, seq: null })
  store.appendMessage(groupA, { ...message, messageId: '18' })
  store.markPresented(groupA, 1)
  store.markRead(groupA, 1)
  const reopened = new QQStore(file)
  assert.deepEqual(reopened.appendMessage(groupA, message), { duplicate: true, seq: null })
  assert.deepEqual(reopened.unread(groupA).messages.map(item => item.messageId), ['18'])
  assert.equal(reopened.unread(groupB).unreadCount, 0)
})

test('pending delivery refuses overflow, passive chatter drops and delivery frees capacity', t => {
  const { file, store } = fixture(t, { maxMessages: 1 })
  store.appendMessage(groupA, { messageId: '1', segments: [], needsPrompt: true })
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => store.appendMessage(groupA, { messageId: '2', segments: [], needsPrompt: true }),
    /QQ_QUEUE_FULL: .*pending delivery/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(store.appendMessage(groupA, { messageId: '3', segments: [] }),
    { duplicate: false, seq: null, dropped: 'passive_window' })
  assert.deepEqual(store.appendMessage(groupA, { messageId: '3', segments: [] }), { duplicate: true, seq: null })
  store.markPresented(groupA, 1)
  store.markRead(groupA, 1)
  // Reading does not deliver: the undelivered message stays protected.
  assert.throws(() => store.appendMessage(groupA, { messageId: '2', segments: [], needsPrompt: true }),
    /QQ_QUEUE_FULL/)
  store.markPrompted(groupA, 1)
  assert.deepEqual(store.appendMessage(groupA, { messageId: '2', segments: [], needsPrompt: true }), { duplicate: false, seq: 2 })
})

test('legacy state without an archive loads, and unprompted messages stay protected', t => {
  const { file } = fixture(t)
  const legacy = {
    schemaVersion: 1,
    scenes: {
      '10001:private:20001': {
        botId: '10001', kind: 'private', peerId: '20001', sessionId: null, authEpoch: 0,
        nextSeq: 2, readSeq: 0, presentedSeq: 0, promptedSeq: 0,
        messages: [{ messageId: '1', seq: 1, prompted: false, segments: [] }],
        seenIds: ['1'], deliveries: [],
      },
    },
  }
  fs.writeFileSync(file, JSON.stringify(legacy))
  const store = new QQStore(file)
  const row = store.getScene(privateA)
  assert.deepEqual(row.deliveryArchive, [])
  assert.equal(row.messages[0].needsPrompt, true)
})

test('read waterline never evicts an earlier addressed message still awaiting DSH delivery', t => {
  const { store } = fixture(t, { maxMessages: 2 })
  store.appendMessage(groupA, { messageId: '1', segments: [], needsPrompt: true })
  store.appendMessage(groupA, { messageId: '2', segments: [], needsPrompt: true })
  store.markPrompted(groupA, 2)
  store.markRead(groupA, 2)
  store.appendMessage(groupA, { messageId: '3', segments: [], needsPrompt: false })
  const ids = store.getScene(groupA).messages.map(message => message.messageId)
  assert.deepEqual(ids, ['1', '3'], 'the undelivered earlier message remains recoverable')
})

test('terminal deliveries archive under pressure while unknown actions stay live', t => {
  const { store } = fixture(t, { maxDeliveries: 2, maxArchivedDeliveries: 2 })
  const fingerprint = n => createHash('sha256').update(`m${n}`).digest('hex')
  for (const n of [1, 2]) {
    assert.equal(store.reserveDelivery(groupA, `a${n}`, fingerprint(n)).fresh, true)
    store.settleDelivery(groupA, `a${n}`, 'delivered', String(900 + n))
  }
  assert.equal(store.reserveDelivery(groupA, 'a3', fingerprint(3)).fresh, true)
  store.settleDelivery(groupA, 'a3', 'delivered', '903')
  let row = store.getScene(groupA)
  assert.deepEqual(row.deliveryArchive.map(item => item.actionId), ['a1'])
  assert.deepEqual(row.deliveries.map(item => item.actionId), ['a2', 'a3'])
  assert.equal(store.reserveDelivery(groupA, 'a4', fingerprint(4)).fresh, true)
  store.settleDelivery(groupA, 'a4', 'delivered', '904')
  assert.equal(store.reserveDelivery(groupA, 'a5', fingerprint(5)).fresh, true)
  store.settleDelivery(groupA, 'a5', 'delivered', '905')
  row = store.getScene(groupA)
  assert.deepEqual(row.deliveryArchive.map(item => item.actionId), ['a2', 'a3'])
  assert.equal(store.hasDelivered(groupA, '902'), true, 'archived receipts remain valid reply targets')
  assert.equal(store.hasDelivered(groupA, '901'), false, 'archive bound forgets the oldest receipt')
})

test('saturated unknown ledger refuses new actions and survives restart', t => {
  const { file, store } = fixture(t, { maxDeliveries: 2 })
  const fingerprint = n => createHash('sha256').update(`u${n}`).digest('hex')
  store.reserveDelivery(groupA, 'u1', fingerprint(1))
  store.reserveDelivery(groupA, 'u2', fingerprint(2))
  assert.throws(() => store.reserveDelivery(groupA, 'u3', fingerprint(3)), /QQ_OUTBOX_FULL: .*unsettled/)
  assert.deepEqual(new QQStore(file).getScene(groupA).deliveries.map(item => item.status), ['unknown', 'unknown'])
  const reopened = new QQStore(file)
  const repeated = reopened.reserveDelivery(groupA, 'u1', fingerprint(1))
  assert.equal(repeated.fresh, false)
  assert.equal(repeated.delivery.status, 'unknown')
  assert.throws(() => reopened.reserveDelivery(groupA, 'u1', 'b'.repeat(64)), /CONFLICT/)
})

test('archived successful actions still dedupe after restart and reject conflicts', t => {
  const { file, store } = fixture(t, { maxDeliveries: 2 })
  const fingerprint = n => createHash('sha256').update(`d${n}`).digest('hex')
  for (const n of [1, 2, 3]) {
    store.reserveDelivery(groupA, `d${n}`, fingerprint(n))
    store.settleDelivery(groupA, `d${n}`, 'delivered', String(900 + n))
  }
  assert.deepEqual(store.getScene(groupA).deliveryArchive.map(item => item.actionId), ['d1'])
  const reopened = new QQStore(file)
  const repeated = reopened.reserveDelivery(groupA, 'd1', fingerprint(1))
  assert.equal(repeated.fresh, false)
  assert.equal(repeated.delivery.status, 'delivered')
  assert.equal(repeated.delivery.platformMessageId, '901')
  assert.throws(() => reopened.reserveDelivery(groupA, 'd1', 'c'.repeat(64)), /CONFLICT/)
})

test('unknown outgoing action is durable and cannot be blindly retried with same actionId', t => {
  const { file, store } = fixture(t)
  const fingerprint = createHash('sha256').update('message').digest('hex')
  assert.equal(store.reserveDelivery(groupA, 'action-1', fingerprint).fresh, true)
  const reopened = new QQStore(file)
  const repeated = reopened.reserveDelivery(groupA, 'action-1', fingerprint)
  assert.equal(repeated.fresh, false)
  assert.equal(repeated.delivery.status, 'unknown')
  assert.throws(() => reopened.reserveDelivery(groupA, 'action-1', 'a'.repeat(64)), /CONFLICT/)
  assert.equal(new QQStore(file).getScene(groupA).deliveries.length, 1)
})

test('corrupt state fails closed without overwriting the source file', t => {
  const { file } = fixture(t)
  const source = '{"schemaVersion":999,"scenes":{}}'
  fs.writeFileSync(file, source)
  assert.throws(() => new QQStore(file), /schema is invalid/)
  assert.equal(fs.readFileSync(file, 'utf8'), source)
})
