import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { transcribeMessageRecord } from '../src/audio.js'

function wav() {
  const bytes = Buffer.alloc(44 + 3200)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(3200, 40)
  return bytes
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-record-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const mediaRoot = path.join(dir, 'media')
  fs.mkdirSync(mediaRoot)
  const audioPath = path.join(mediaRoot, 'record.wav')
  fs.writeFileSync(audioPath, wav())
  const store = new QQStore(path.join(dir, 'qq.json'))
  const scene = { botId: '10001', kind: 'group', peerId: '20001' }
  store.setScenePermissions(scene, { mode: 'enhanced' })
  store.bindSession(scene, 'group-session')
  store.appendMessage(scene, { messageId: '701', senderId: '40001', segments: [
    { type: 'record', data: { file: 'opaque-record-701' } },
  ] })
  const calls = []
  const transport = { status: 'connected', async action(name, args, timeoutMs) {
    calls.push({ name, args, timeoutMs })
    return { file: audioPath, url: 'https://must-not-fetch.invalid/record' }
  }, stop() {} }
  const asrCalls = []
  const speechToText = {
    listProviders: () => [{ id: 'local-qa', location: 'host-local' }],
    resolve: spec => { asrCalls.push({ method: 'resolve', spec }); return spec },
    transcribe: async (spec, signal) => { asrCalls.push({ method: 'transcribe', spec, signal }); return { text: 'synthetic transcript' } },
  }
  const core = new QQCore({ store, dsh: {}, transport,
    policy: { botIds: ['10001'], groupIds: ['20001'] } })
  t.after(() => core.close())
  const read = (extra = {}) => transcribeMessageRecord({ core, store, transport, speechToText,
    mediaRoot, providerId: 'local-qa', sessionId: 'group-session', messageId: '701', index: 0, ...extra })
  return { dir, mediaRoot, audioPath, store, scene, core, transport, calls, speechToText, asrCalls, read }
}

test('record transcription uses only stored Scene handle and explicitly selected local ASR', async t => {
  const { read, calls, asrCalls, audioPath } = fixture(t)
  const result = await read()
  assert.deepEqual(calls, [{ name: 'get_record', args: { file: 'opaque-record-701', out_format: 'wav' }, timeoutMs: 10000 }])
  assert.deepEqual(result, { text: 'synthetic transcript' })
  assert.equal(asrCalls[0].method, 'resolve')
  assert.equal(asrCalls[0].spec.providerId, 'local-qa')
  assert.deepEqual(Buffer.from(asrCalls[0].spec.audio), wav())
  assert.equal(asrCalls[1].method, 'transcribe')
  assert.equal(JSON.stringify(result).includes(audioPath), false)
})

test('record transcription rejects foreign Scene, missing record and revoked media permission before OneBot', async t => {
  const { read, calls, store, scene } = fixture(t)
  await assert.rejects(read({ sessionId: 'foreign-session' }), /QQ_(PERMISSION|MEDIA|MESSAGE_SCOPE)/)
  await assert.rejects(read({ messageId: '999' }), /QQ_(PERMISSION|MEDIA|MESSAGE_SCOPE)/)
  await assert.rejects(read({ index: 1 }), /QQ_MEDIA/)
  store.setScenePermissions(scene, { mode: 'safe-chat' })
  await assert.rejects(read(), /QQ_(PERMISSION|MEDIA)/)
  assert.equal(calls.length, 0)
})

test('record transcription rejects URL-only, out-of-root, invalid WAV and remote provider without ASR', async t => {
  const { read, transport, dir, mediaRoot, asrCalls, speechToText } = fixture(t)
  transport.action = async () => ({ url: 'https://must-not-fetch.invalid/record' })
  await assert.rejects(read(), /QQ_MEDIA/)
  const outside = path.join(dir, 'outside.wav')
  fs.writeFileSync(outside, wav())
  transport.action = async () => ({ file: outside })
  await assert.rejects(read(), /QQ_MEDIA/)
  const invalid = path.join(mediaRoot, 'invalid.wav')
  fs.writeFileSync(invalid, Buffer.from('not a wave'))
  transport.action = async () => ({ file: invalid })
  await assert.rejects(read(), /QQ_MEDIA/)
  const wrongRate = path.join(mediaRoot, 'wrong-rate.wav')
  const bytes = wav()
  bytes.writeUInt32LE(8000, 24)
  fs.writeFileSync(wrongRate, bytes)
  transport.action = async () => ({ file: wrongRate })
  await assert.rejects(read(), /QQ_MEDIA/)
  const huge = path.join(mediaRoot, 'huge.wav')
  fs.writeFileSync(huge, Buffer.alloc(4 * 1024 * 1024 + 1))
  transport.action = async () => ({ file: huge })
  await assert.rejects(read(), /QQ_MEDIA/)
  speechToText.listProviders = () => [{ id: 'remote-qa', location: 'remote' }]
  await assert.rejects(read({ providerId: 'remote-qa' }), /QQ_(ASR|MEDIA)/)
  assert.equal(asrCalls.length, 0)
})

test('record transcription rejects a symlink before local ASR', async t => {
  const { read, transport, mediaRoot, audioPath, asrCalls } = fixture(t)
  const link = path.join(mediaRoot, 'linked.wav')
  try { fs.symlinkSync(audioPath, link) } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink creation unavailable')
    throw error
  }
  transport.action = async () => ({ file: link })
  await assert.rejects(read(), /QQ_MEDIA/)
  assert.equal(asrCalls.length, 0)
})

test('revocation during get_record or ASR prevents transcript output', async t => {
  const { read, transport, store, scene, speechToText, asrCalls } = fixture(t)
  let releaseRecord
  transport.action = () => new Promise(resolve => { releaseRecord = resolve })
  const pendingRecord = read()
  await new Promise(resolve => setImmediate(resolve))
  store.setScenePermissions(scene, { mode: 'enhanced', overrides: { 'qq.media.read': 'deny' } })
  releaseRecord({ file: 'C:\\outside\\record.wav' })
  await assert.rejects(pendingRecord, /QQ_(PERMISSION|MEDIA)/)
  assert.equal(asrCalls.length, 0)

  store.setScenePermissions(scene, { mode: 'enhanced' })
  transport.action = async () => ({ file: path.join(path.dirname(store.file), 'media', 'record.wav') })
  await assert.rejects(read(), /QQ_(PERMISSION|MEDIA)/,
    'a permission revision change cannot silently revive the old Session')
  store.retireSession(scene, 'group-session')
  store.bindSession(scene, 'fresh-group-session')
  let releaseAsr
  speechToText.transcribe = () => new Promise(resolve => { releaseAsr = resolve })
  const pendingAsr = read({ sessionId: 'fresh-group-session' })
  const deadline = Date.now() + 3000
  while (!releaseAsr && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(typeof releaseAsr, 'function', 'local ASR must start before revocation')
  store.setScenePermissions(scene, { mode: 'enhanced', overrides: { 'qq.media.read': 'deny' } })
  releaseAsr({ text: 'must not reach model' })
  await assert.rejects(pendingAsr, /QQ_(PERMISSION|MEDIA)/)
})
