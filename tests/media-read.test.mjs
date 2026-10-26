import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { QQStore } from '../src/storage.js'
import { QQCore } from '../src/core.js'
import { readMessageImage } from '../src/media.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-image-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const mediaRoot = path.join(dir, 'media')
  fs.mkdirSync(mediaRoot)
  const imagePath = path.join(mediaRoot, 'picture.png')
  fs.writeFileSync(imagePath, PNG)
  const store = new QQStore(path.join(dir, 'qq.json'))
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  const other = { botId: '10001', kind: 'private', peerId: '30001' }
  store.setScenePermissions(group, { mode: 'enhanced' })
  store.bindSession(group, 'group-session')
  store.bindSession(other, 'other-session')
  store.appendMessage(group, { messageId: '701', senderId: '40001', segments: [
    { type: 'text', data: { text: 'see this' } },
    { type: 'image', data: { file: 'opaque-image-701' } },
  ] })
  const calls = []
  const transport = { status: 'connected', async action(name, args) {
    calls.push({ name, args })
    return { file: imagePath, url: 'https://must-not-fetch.invalid/image' }
  }, stop() {} }
  const saved = []
  const attachments = { async saveImage(input) {
    saved.push(input)
    return { attachmentId: 'sha256:qa-image', mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length }
  } }
  const core = new QQCore({ store, dsh: {}, transport,
    policy: { botIds: ['10001'], groupIds: ['20001'], privateIds: ['30001'] } })
  t.after(() => core.close())
  const read = (sessionId = 'group-session', messageId = '701', index = 0) =>
    readMessageImage({ core, store, transport, attachments, mediaRoot, sessionId, messageId, index })
  return { dir, mediaRoot, imagePath, group, store, core, transport, calls, saved, read }
}

test('image read uses only a stored Scene image handle and renders a Host attachment', async t => {
  const { read, calls, saved, imagePath } = fixture(t)
  const result = await read()
  assert.deepEqual(calls, [{ name: 'get_image', args: { file: 'opaque-image-701' } }])
  assert.equal(saved.length, 1)
  assert.deepEqual(Buffer.from(saved[0].data), PNG)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(result.attachment.attachmentId, 'sha256:qa-image')
  assert.equal(JSON.stringify(result).includes(imagePath), false)
})

test('unbound message, wrong Scene and safe-chat never request the platform image', async t => {
  const { read, calls, group, store } = fixture(t)
  await assert.rejects(read('other-session'), /QQ_(MESSAGE_SCOPE|MEDIA|PERMISSION)/)
  await assert.rejects(read('group-session', '999'), /QQ_(MESSAGE_SCOPE|MEDIA)/)
  await assert.rejects(read('group-session', '701', 1), /QQ_(MESSAGE_SCOPE|MEDIA)/)
  assert.equal(calls.length, 0)
  store.setScenePermissions(group, { mode: 'safe-chat' })
  await assert.rejects(read(), /QQ_(PERMISSION|MEDIA)/)
  assert.equal(calls.length, 0)
})

test('revoking image permission while get_image is pending prevents attachment creation', async t => {
  const { read, transport, group, store, saved } = fixture(t)
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  const response = new Promise(resolve => { release = resolve })
  transport.action = async () => { entered(); return response }
  const pending = read()
  await started
  store.setScenePermissions(group, { mode: 'enhanced', overrides: { 'qq.media.read': 'deny' } })
  release({ file: 'C:\\outside\\secret.png' })
  await assert.rejects(pending, /QQ_(PERMISSION|MEDIA)/)
  assert.equal(saved.length, 0)
})

test('revoking image permission while Host admission is pending prevents image output', async t => {
  const { core, transport, mediaRoot, group } = fixture(t)
  const saved = []
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let release
  const response = new Promise(resolve => { release = resolve })
  const attachments = { async saveImage(input) { saved.push(input); entered(); return response } }
  const pending = readMessageImage({ core, store: core.store, transport, attachments, mediaRoot,
    sessionId: 'group-session', messageId: '701', index: 0 })
  await started
  core.store.setScenePermissions(group, { mode: 'enhanced', overrides: { 'qq.media.read': 'deny' } })
  release({ attachmentId: 'sha256:late-image', mediaType: 'image/png' })
  await assert.rejects(pending, /QQ_PERMISSION/)
})

test('URL-only, out-of-root and oversized platform files fail without saving an attachment', async t => {
  const { read, transport, dir, mediaRoot, saved } = fixture(t)
  transport.action = async () => ({ url: 'https://must-not-fetch.invalid/image' })
  await assert.rejects(read(), /QQ_MEDIA/)
  const outside = path.join(dir, 'outside.png')
  fs.writeFileSync(outside, PNG)
  transport.action = async () => ({ file: outside })
  await assert.rejects(read(), /QQ_MEDIA/)
  for (const file of ['file:///C:/outside/picture.png', 'base64://private-image', '\\\\server\\share\\picture.png', '\\\\?\\C:\\outside\\picture.png']) {
    transport.action = async () => ({ file })
    await assert.rejects(read(), /QQ_MEDIA/)
  }
  const huge = path.join(mediaRoot, 'huge.png')
  fs.writeFileSync(huge, Buffer.alloc(5 * 1024 * 1024 + 1))
  transport.action = async () => ({ file: huge })
  await assert.rejects(read(), /QQ_MEDIA/)
  assert.equal(saved.length, 0)
})

test('symlink is rejected before Host attachment admission', async t => {
  const { read, transport, mediaRoot, imagePath, saved } = fixture(t)
  const link = path.join(mediaRoot, 'linked.png')
  try { fs.symlinkSync(imagePath, link) } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink creation unavailable')
    throw error
  }
  transport.action = async () => ({ file: link })
  await assert.rejects(read(), /QQ_MEDIA/)
  assert.equal(saved.length, 0)
})

test('invalid image bytes are rejected before Host attachment admission', async t => {
  const { read, transport, mediaRoot, saved } = fixture(t)
  const corrupt = path.join(mediaRoot, 'corrupt.png')
  fs.writeFileSync(corrupt, Buffer.from('not an image'))
  transport.action = async () => ({ file: corrupt })
  await assert.rejects(read(), /QQ_MEDIA/)
  assert.equal(saved.length, 0)
})
