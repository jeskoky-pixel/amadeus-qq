import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { transcribeMessageRecordNative } from '../src/native-asr.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-native-asr-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new QQStore(path.join(dir, 'qq.json'))
  const scene = { botId: '10001', kind: 'group', peerId: '20001' }
  const other = { botId: '10001', kind: 'private', peerId: '30001' }
  store.setScenePermissions(scene, { mode: 'enhanced' })
  store.bindSession(scene, 'group-session')
  store.bindSession(other, 'other-session')
  store.appendMessage(scene, { messageId: '701', senderId: '40001', segments: [
    { type: 'record', data: { file: 'opaque-record-701' } },
  ] })
  store.appendMessage(scene, { messageId: '702', senderId: '40001', segments: [
    { type: 'text', data: { text: 'not a record' } },
  ] })
  store.appendMessage(other, { messageId: '703', senderId: '40002', segments: [
    { type: 'record', data: { file: 'opaque-other-703' } },
  ] })
  const calls = []
  const transport = { status: 'connected', async action(name, args, timeoutMs, maxResponseBytes) {
    calls.push({ name, args, timeoutMs, maxResponseBytes })
    return { text: '  native transcript  ', cookie: 'secret-cookie', url: 'https://private.invalid/x' }
  }, stop() {} }
  const core = new QQCore({ store, dsh: {}, transport,
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] } })
  t.after(() => core.close())
  const read = (sessionId = 'group-session', messageId = '701') =>
    transcribeMessageRecordNative({ core, store, transport, sessionId, messageId })
  return { dir, store, scene, core, transport, calls, read }
}

test('native PTT transcription uses only stored message ID, projects text and persists transcript', async t => {
  const { read, calls, store, scene } = fixture(t)
  const result = await read()
  assert.deepEqual(result, {
    text: 'native transcript',
    messageId: '701',
    senderId: '40001',
    scene: { botId: '10001', kind: 'group', peerId: '20001' },
  })
  assert.deepEqual(calls, [{
    name: 'fetch_ptt_text', args: { message_id: '701' }, timeoutMs: 10000, maxResponseBytes: 64 * 1024,
  }])
  const message = store.getScene(scene).messages.find(item => item.messageId === '701')
  assert.equal(message.transcript, 'native transcript')
  assert.equal(JSON.stringify(result).includes('secret-cookie'), false)
  assert.equal(JSON.stringify(result).includes('private.invalid'), false)
})

test('transcript survives restart and repeated reads do not create a new QQ message', async t => {
  const { read, store, scene } = fixture(t)
  await read()
  const reloaded = new QQStore(store.file)
  const before = reloaded.getScene(scene).messages.length
  assert.equal(reloaded.getScene(scene).messages.find(item => item.messageId === '701').transcript, 'native transcript')
  assert.equal(before, 2)
  assert.equal((await read()).text, 'native transcript')
  assert.equal(reloaded.getScene(scene).messages.length, before)
})

test('non-record, cross-Scene, missing and revoked qq.read messages are rejected', async t => {
  const { read, calls, store, scene } = fixture(t)
  await assert.rejects(read('group-session', '702'), /QQ_NATIVE_ASR_NOT_RECORD/)
  await assert.rejects(read('group-session', '703'), /QQ_MESSAGE_SCOPE/)
  await assert.rejects(read('group-session', '999'), /QQ_MESSAGE_SCOPE/)
  store.setScenePermissions(scene, { mode: 'enhanced', overrides: { 'qq.read': 'deny' } })
  await assert.rejects(read(), /QQ_(PERMISSION|NATIVE_ASR)/)
  assert.equal(calls.length, 0)
})

test('native transcription is available in Safe Chat and remains compatible with Enhanced', async t => {
  const { read, store, scene } = fixture(t)
  store.setScenePermissions(scene, { mode: 'safe-chat' })
  store.bindSession(scene, 'group-session')
  assert.equal((await read()).text, 'native transcript')
  store.setScenePermissions(scene, { mode: 'enhanced' })
  store.bindSession(scene, 'group-session')
  assert.equal((await read()).text, 'native transcript')
  assert.equal(store.getScene(scene).messages.find(item => item.messageId === '701').transcript, 'native transcript')
})

test('empty, oversized, malformed and missing text responses never persist a transcript', async t => {
  const { read, transport, store, scene } = fixture(t)
  for (const response of [
    { text: '   ' },
    { text: 'x'.repeat(4001) },
    { text: 42 },
    {},
  ]) {
    transport.action = async () => response
    await assert.rejects(read(), /QQ_NATIVE_ASR_(EMPTY|TOO_LONG|INVALID_RESPONSE)/)
  }
  assert.equal(store.getScene(scene).messages.find(item => item.messageId === '701').transcript, undefined)
})

test('platform failure and timeout do not fabricate or persist text', async t => {
  const { read, transport, store, scene } = fixture(t)
  transport.action = async () => { throw new Error('unsupported') }
  await assert.rejects(read(), /QQ_NATIVE_ASR_UNAVAILABLE/)
  assert.equal(store.getScene(scene).messages.find(item => item.messageId === '701').transcript, undefined)
})

test('revocation during the platform call prevents transcript persistence', async t => {
  const { read, transport, store, scene } = fixture(t)
  let release
  transport.action = () => new Promise(resolve => { release = resolve })
  const pending = read()
  await new Promise(resolve => setImmediate(resolve))
  store.setScenePermissions(scene, { mode: 'enhanced', overrides: { 'qq.read': 'deny' } })
  release({ text: 'must not persist' })
  await assert.rejects(pending, /QQ_(PERMISSION|NATIVE_ASR)/)
  assert.equal(store.getScene(scene).messages.find(item => item.messageId === '701').transcript, undefined)
})
