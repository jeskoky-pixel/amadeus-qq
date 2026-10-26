import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { readMessageFile, readMessageVideo } from '../src/files.js'

const FILE_BYTES = Buffer.from('synthetic file bytes')
const VIDEO_BYTES = Buffer.from('synthetic video bytes')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-file-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const mediaRoot = path.join(dir, 'media')
  fs.mkdirSync(mediaRoot)
  const filePath = path.join(mediaRoot, 'document.bin')
  const videoPath = path.join(mediaRoot, 'clip.mp4')
  fs.writeFileSync(filePath, FILE_BYTES)
  fs.writeFileSync(videoPath, VIDEO_BYTES)
  const store = new QQStore(path.join(dir, 'qq.json'))
  const scene = { botId: '10001', kind: 'group', peerId: '20001' }
  const other = { botId: '10001', kind: 'private', peerId: '30001' }
  store.setScenePermissions(scene, { mode: 'enhanced' })
  store.bindSession(scene, 'group-session')
  store.bindSession(other, 'other-session')
  store.appendMessage(scene, { messageId: '701', senderId: '40001', segments: [
    { type: 'text', data: { text: 'attachments' } },
    { type: 'file', data: { file: 'opaque-file-701' } },
    { type: 'video', data: { file: 'opaque-video-701' } },
  ] })
  const calls = []
  const transport = { status: 'connected', async action(name, args, timeoutMs, maxResponseBytes) {
    calls.push({ name, args, timeoutMs, maxResponseBytes })
    return { file: args.file === 'opaque-video-701' ? videoPath : filePath, url: 'https://must-not-fetch.invalid/file' }
  }, stop() {} }
  const saved = []
  const attachments = { async saveFile(input) {
    saved.push(input)
    return { attachmentId: 'sha256:qa-file', name: input.name, bytes: input.data.length }
  } }
  const core = new QQCore({ store, dsh: {}, transport,
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] } })
  t.after(() => core.close())
  const readFile = (extra = {}) => readMessageFile({ core, store, transport, attachments,
    mediaRoot, sessionId: 'group-session', messageId: '701', index: 0, ...extra })
  const readVideo = (extra = {}) => readMessageVideo({ core, store, transport, attachments,
    mediaRoot, sessionId: 'group-session', messageId: '701', index: 0, ...extra })
  return { dir, mediaRoot, filePath, videoPath, store, scene, core, transport, calls, saved, readFile, readVideo }
}

test('get_file uses a bounded response and maps response overflow without attachment output', async t => {
  const { readFile, transport, saved } = fixture(t)
  let captured
  transport.action = async (...args) => {
    captured = args
    const error = new Error('too large')
    error.code = 'ONEBOT_RESPONSE_TOO_LARGE'
    throw error
  }
  await assert.rejects(readFile(), /QQ_MEDIA_RESPONSE_TOO_LARGE/)
  assert.deepEqual(captured, ['get_file', { file: 'opaque-file-701' }, 10_000, 32 * 1024 * 1024])
  assert.equal(saved.length, 0)
})

test('file and video reads use only the stored Scene handle and a bounded get_file', async t => {
  const { readFile, readVideo, calls, saved, filePath, videoPath } = fixture(t)
  assert.deepEqual(await readFile(), { attachment: { attachmentId: 'sha256:qa-file', name: 'qq-file', bytes: FILE_BYTES.length } })
  assert.deepEqual(await readVideo(), { attachment: { attachmentId: 'sha256:qa-file', name: 'qq-video', bytes: VIDEO_BYTES.length } })
  assert.deepEqual(calls, [
    { name: 'get_file', args: { file: 'opaque-file-701' }, timeoutMs: 10000, maxResponseBytes: 32 * 1024 * 1024 },
    { name: 'get_file', args: { file: 'opaque-video-701' }, timeoutMs: 10000, maxResponseBytes: 32 * 1024 * 1024 },
  ])
  assert.deepEqual(saved.map(item => item.name), ['qq-file', 'qq-video'])
  assert.deepEqual(Buffer.from(saved[0].data), FILE_BYTES)
  assert.deepEqual(Buffer.from(saved[1].data), VIDEO_BYTES)
  assert.equal(JSON.stringify(saved).includes(filePath), false)
  assert.equal(JSON.stringify(saved).includes(videoPath), false)
})

test('inline canonical file and video bytes are accepted without URL fetch', async t => {
  const { readFile, readVideo, transport, saved } = fixture(t)
  transport.action = async () => ({ base64: FILE_BYTES.toString('base64'), url: 'https://must-not-fetch.invalid/file' })
  assert.equal((await readFile()).attachment.name, 'qq-file')
  transport.action = async () => ({ base64: VIDEO_BYTES.toString('base64') })
  assert.equal((await readVideo()).attachment.name, 'qq-video')
  assert.deepEqual(saved.map(item => Buffer.from(item.data)), [FILE_BYTES, VIDEO_BYTES])
})

test('file and video reads reject foreign Scene, missing message, wrong kind index and Safe Chat', async t => {
  const { readFile, readVideo, calls, store, scene } = fixture(t)
  await assert.rejects(readFile({ sessionId: 'other-session' }), /QQ_(PERMISSION|MEDIA)/)
  await assert.rejects(readFile({ messageId: '999' }), /QQ_(MEDIA|MESSAGE_SCOPE)/)
  await assert.rejects(readVideo({ index: 1 }), /QQ_MEDIA/)
  store.setScenePermissions(scene, { mode: 'safe-chat' })
  await assert.rejects(readFile(), /QQ_(PERMISSION|MEDIA)/)
  assert.equal(calls.length, 0)
})

test('URL-only, out-of-root and oversized files fail before Host attachment admission', async t => {
  const { readFile, transport, dir, mediaRoot, saved } = fixture(t)
  transport.action = async () => ({ url: 'https://must-not-fetch.invalid/file' })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  const outside = path.join(dir, 'outside.bin')
  fs.writeFileSync(outside, FILE_BYTES)
  transport.action = async () => ({ file: outside })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  transport.action = async () => ({ file: path.join(mediaRoot, 'missing.bin') })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  const huge = path.join(mediaRoot, 'huge.bin')
  fs.writeFileSync(huge, Buffer.alloc(20 * 1024 * 1024 + 1))
  transport.action = async () => ({ file: huge })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  transport.action = async () => ({ base64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  transport.action = async () => ({ base64: FILE_BYTES.toString('base64') + '$' })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  transport.action = async () => ({ base64: 'base64://UklGRg==' })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  assert.equal(saved.length, 0)
})

test('file beats inline bytes and a rejected file path never falls back to base64', async t => {
  const { readFile, transport, dir, saved } = fixture(t)
  const outside = path.join(dir, 'outside.bin')
  fs.writeFileSync(outside, FILE_BYTES)
  transport.action = async () => ({ file: outside, base64: FILE_BYTES.toString('base64') })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  assert.equal(saved.length, 0)
})

test('symlink is rejected before Host attachment admission', async t => {
  const { readFile, transport, mediaRoot, filePath, saved } = fixture(t)
  const link = path.join(mediaRoot, 'linked.bin')
  try { fs.symlinkSync(filePath, link) } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink creation unavailable')
    throw error
  }
  transport.action = async () => ({ file: link })
  await assert.rejects(readFile(), /QQ_MEDIA/)
  assert.equal(saved.length, 0)
})

test('revocation during get_file or Host save prevents attachment output', async t => {
  const { readFile, transport, store, scene, saved } = fixture(t)
  let releaseRecord
  transport.action = () => new Promise(resolve => { releaseRecord = resolve })
  const pendingRecord = readFile()
  await new Promise(resolve => setImmediate(resolve))
  store.setScenePermissions(scene, { mode: 'enhanced', overrides: { 'qq.media.read': 'deny' } })
  releaseRecord({ file: 'C:\\outside\\file.bin' })
  await assert.rejects(pendingRecord, /QQ_(PERMISSION|MEDIA)/)
  assert.equal(saved.length, 0)

  store.setScenePermissions(scene, { mode: 'enhanced' })
  store.retireSession(scene, 'group-session')
  store.bindSession(scene, 'fresh-group-session')
  let releaseSave
  const attachments = { async saveFile(input) { saved.push(input); return new Promise(resolve => { releaseSave = resolve }) } }
  transport.action = async () => ({ base64: FILE_BYTES.toString('base64') })
  const pendingSave = readFile({ sessionId: 'fresh-group-session', attachments })
  while (!releaseSave) await new Promise(resolve => setImmediate(resolve))
  store.setScenePermissions(scene, { mode: 'enhanced', overrides: { 'qq.media.read': 'deny' } })
  releaseSave({ attachmentId: 'sha256:late', name: 'qq-file', bytes: FILE_BYTES.length })
  await assert.rejects(pendingSave, /QQ_(PERMISSION|MEDIA)/)
})

test('missing saveFile service fails closed without touching transport', async t => {
  const { readFile, calls } = fixture(t)
  await assert.rejects(readFile({ attachments: {} }), /QQ_MEDIA_ATTACHMENTS_UNAVAILABLE/)
  assert.equal(calls.length, 0)
})
