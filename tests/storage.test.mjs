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

test('unread queue refuses overflow and leaves durable state intact', t => {
  const { file, store } = fixture(t, { maxMessages: 1 })
  store.appendMessage(groupA, { messageId: '1', segments: [] })
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => store.appendMessage(groupA, { messageId: '2', segments: [] }), /QUEUE_FULL/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  store.markPresented(groupA, 1)
  store.markRead(groupA, 1)
  assert.deepEqual(store.appendMessage(groupA, { messageId: '2', segments: [] }), { duplicate: false, seq: 2 })
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
