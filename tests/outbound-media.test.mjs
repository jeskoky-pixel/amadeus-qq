import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareOutboundMedia, TTS_UNAVAILABLE_CODE } from '../src/outbound-media.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const GIF = Buffer.from('GIF89a' + 'A'.repeat(32))
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(32)])
const PDF = Buffer.from('%PDF-1.4\nsynthetic\n')
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)])

function fixture(t, { kind = 'group' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-outbound-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sendRoot = path.join(dir, 'send')
  fs.mkdirSync(sendRoot)
  for (const [name, data] of [['image.png', PNG], ['image.gif', GIF], ['clip.mp4', MP4], ['doc.pdf', PDF], ['voice.wav', WAV]]) {
    fs.writeFileSync(path.join(sendRoot, name), data)
  }
  const scene = { botId: '10001', kind, peerId: kind === 'group' ? '20001' : '30001' }
  let allowed = true
  let checks = 0
  const core = {
    authorizedScene() { if (!allowed) throw new Error('QQ_PERMISSION_CHANGED'); return scene },
    authorizeSessionCapability(_sessionId, capability) {
      checks += 1
      return allowed && capability === 'qq.send'
    },
  }
  const attachments = {
    imageHostPath: ref => path.join(sendRoot, ref.name),
    fileHostPath: ref => path.join(sendRoot, ref.name),
  }
  const prepare = (overrides = {}) => prepareOutboundMedia({
    core, sessionId: 'session', kind: 'image', source: { type: 'send-root', path: 'image.png' },
    sendRoot, attachments, ...overrides,
  })
  return { dir, sendRoot, scene, core, attachments, prepare, setAllowed: value => { allowed = value }, checks: () => checks }
}

test('controllable image, GIF, video and file plans use sendRoot or Host attachment paths', async t => {
  const { prepare, sendRoot, scene } = fixture(t)
  const image = await prepare()
  assert.equal(image.mode, 'message')
  assert.deepEqual(image.segments.map(item => item.type), ['image'])
  assert.equal(image.mediaType, 'image/png')
  assert.match(image.fingerprint, /^[a-f0-9]{64}$/)

  const gif = await prepare({ kind: 'gif', source: { type: 'send-root', path: 'image.gif' } })
  assert.deepEqual(gif.segments.map(item => item.type), ['image'])
  assert.equal(gif.mediaType, 'image/gif')

  const video = await prepare({ kind: 'video', source: { type: 'send-root', path: 'clip.mp4' } })
  assert.deepEqual(video.segments.map(item => item.type), ['video'])
  assert.equal(video.mediaType, 'video/mp4')

  const audio = await prepare({ kind: 'audio', source: { type: 'send-root', path: 'voice.wav' } })
  assert.deepEqual(audio.segments.map(item => item.type), ['record'])
  assert.equal(audio.mediaType, 'audio/wav')
  assert.equal(audio.bytes, WAV.length)

  await assert.rejects(prepare({ kind: 'audio', source: { type: 'send-root', path: 'doc.pdf' } }), /QQ_MEDIA_FORMAT_INVALID/)
  fs.writeFileSync(path.join(sendRoot, 'huge.wav'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x52))
  await assert.rejects(prepare({ kind: 'audio', source: { type: 'send-root', path: 'huge.wav' } }), /QQ_MEDIA_TOO_LARGE/)

  const file = await prepare({ kind: 'file', source: { type: 'send-root', path: 'doc.pdf' } })
  assert.equal(file.mode, 'upload')
  assert.equal(file.action, 'upload_group_file')
  assert.equal(file.params.group_id, scene.peerId)
  assert.equal(file.params.upload_file, true)
  assert.equal(file.params.name, 'doc.pdf')

  const hostFile = await prepare({
    kind: 'file',
    source: { type: 'host-attachment', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'doc.pdf', bytes: PDF.length } },
  })
  assert.equal(hostFile.mode, 'upload')
  assert.equal(hostFile.params.file, path.join(sendRoot, 'doc.pdf'))
})

test('private file plans use upload_private_file and never a URL', async t => {
  const { prepare, scene } = fixture(t, { kind: 'private' })
  const plan = await prepare({ kind: 'file', source: { type: 'send-root', path: 'doc.pdf' } })
  assert.equal(plan.action, 'upload_private_file')
  assert.equal(plan.params.user_id, scene.peerId)
  assert.equal(JSON.stringify(plan).includes('http'), false)
})

test('absolute paths, traversal, URL/base64 sources and unknown shapes are rejected', async t => {
  const { prepare, dir } = fixture(t)
  for (const source of [
    { type: 'send-root', path: path.join(dir, 'send', 'image.png') },
    { type: 'send-root', path: '../outside.png' },
    { type: 'send-root', path: 'https://must-not-fetch.invalid/image.png' },
    { type: 'send-root', path: 'base64://AAAA' },
    { type: 'url', url: 'https://must-not-fetch.invalid/image.png' },
    { type: 'send-root', path: 'image.png', extra: true },
    { type: 'unknown', path: 'image.png' },
  ]) {
    await assert.rejects(prepare({ source }), /QQ_MEDIA/)
  }
})

test('wrong image format, blocked file extension, oversize and missing files are rejected', async t => {
  const { prepare, sendRoot } = fixture(t)
  await assert.rejects(prepare({ source: { type: 'send-root', path: 'image.gif' } }), /QQ_MEDIA_FORMAT_INVALID/)
  await assert.rejects(prepare({ kind: 'gif', source: { type: 'send-root', path: 'image.png' } }), /QQ_MEDIA_FORMAT_INVALID/)
  await assert.rejects(prepare({ source: { type: 'send-root', path: 'video.mp4' } }), /QQ_MEDIA/)
  fs.writeFileSync(path.join(sendRoot, 'run.exe'), Buffer.from('MZ'))
  await assert.rejects(prepare({ kind: 'file', source: { type: 'send-root', path: 'run.exe' } }), /QQ_MEDIA_FORMAT_INVALID/)
  fs.writeFileSync(path.join(sendRoot, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1))
  await assert.rejects(prepare({ source: { type: 'send-root', path: 'huge.png' } }), /QQ_MEDIA_TOO_LARGE/)
  await assert.rejects(prepare({ source: { type: 'send-root', path: 'missing.png' } }), /QQ_MEDIA/)
})

test('symlink and Host attachment without a trusted resolver are rejected', async t => {
  const { prepare, sendRoot, attachments } = fixture(t)
  const link = path.join(sendRoot, 'linked.png')
  try { fs.symlinkSync(path.join(sendRoot, 'image.png'), link) } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlink creation unavailable')
    throw error
  }
  await assert.rejects(prepare({ source: { type: 'send-root', path: 'linked.png' } }), /QQ_MEDIA/)
  await assert.rejects(prepare({
    source: { type: 'host-attachment', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'image.png', bytes: PNG.length } },
    attachments: { ...attachments, imageHostPath: undefined },
  }), /QQ_MEDIA_ATTACHMENTS_UNAVAILABLE/)
})

test('revocation before and after validation prevents an executable plan', async t => {
  const { prepare, setAllowed, checks } = fixture(t)
  setAllowed(false)
  await assert.rejects(prepare(), /QQ_PERMISSION/)
  setAllowed(true)
  const before = checks()
  let calls = 0
  const core = {
    authorizedScene() { return { botId: '10001', kind: 'group', peerId: '20001' } },
    authorizeSessionCapability() { calls += 1; return calls === 1 },
  }
  await assert.rejects(prepare({ core }), /QQ_PERMISSION/)
  assert.ok(checks() >= before)
  assert.equal(calls, 2)
})

test('voice/TTS is explicitly unavailable and never fabricates a record segment', async t => {
  const { prepare } = fixture(t)
  await assert.rejects(prepare({ kind: 'voice' }), new RegExp(TTS_UNAVAILABLE_CODE))
  await assert.rejects(prepare({ kind: 'record' }), new RegExp(TTS_UNAVAILABLE_CODE))
})
