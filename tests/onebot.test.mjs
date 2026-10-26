import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeOneBotMessage, OneBotAdapter, validateOutgoingSegments } from '../src/onebot.js'

test('OneBot event retains text, at, reply and media segments with stable scene identity', () => {
  const raw = { post_type: 'message', message_type: 'group', self_id: 10001, group_id: 20001,
    user_id: 30001, message_id: -77, time: 123,
    message: [
      { type: 'reply', data: { id: -76 } },
      { type: 'at', data: { qq: 10001 } },
      { type: 'text', data: { text: 'look' } },
      { type: 'image', data: { file: 'image-id', url: 'https://example.invalid/image' } },
      { type: 'record', data: { file: 'voice-id' } },
    ] }
  const out = normalizeOneBotMessage(raw)
  assert.deepEqual(out.scene, { botId: '10001', kind: 'group', peerId: '20001' })
  assert.equal(out.message.messageId, '-77')
  assert.equal(out.message.replyToMessageId, '-76')
  assert.deepEqual(out.message.atIds, ['10001'])
  assert.deepEqual(out.message.segments.map(x => x.type), ['reply', 'at', 'text', 'image', 'record'])
  raw.message[3].data.file = 'mutated'
  assert.equal(out.message.segments[3].data.file, 'image-id')
})

test('inbound media locators never enter the durable message or DSH prompt payload', () => {
  const raw = { post_type: 'message', message_type: 'private', self_id: 10001, user_id: 30001,
    message_id: 901, time: 123, message: [
      { type: 'text', data: { text: 'see this', url: 'https://extra.invalid/extra-secret' } },
      { type: 'image', data: { file: 'https://media.invalid/photo?token=secret-image', url: 'https://media.invalid/photo?token=secret-image' } },
      { type: 'record', data: { file: 'C:\\private\\voice-secret.amr' } },
      { type: 'video', data: { file: 'base64://secret-video' } },
      { type: 'json', data: { data: 'https://rich.invalid/rich-secret' } },
      { type: 'image', data: { file: 'safe-image-id' } },
    ] }
  const out = normalizeOneBotMessage(raw)
  const serialized = JSON.stringify(out.message)
  for (const secret of ['secret-image', 'voice-secret', 'secret-video', 'extra-secret', 'rich-secret', 'media.invalid', 'C:\\private']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be persisted or prompted`)
  }
  assert.equal(out.message.segments[0].data.text, 'see this')
  assert.equal(out.message.segments.at(-1).data.file, 'safe-image-id')
})

test('string-format OneBot CQ media codes do not expose media locators', () => {
  const raw = { post_type: 'message', message_type: 'private', self_id: 10001, user_id: 30001,
    message_id: 902, message: 'look [CQ:image,file=https://media.invalid/image?token=string-secret] [CQ:json,data=rich-code-secret] please' }
  const out = normalizeOneBotMessage(raw)
  const serialized = JSON.stringify(out.message)
  assert.equal(serialized.includes('string-secret'), false)
  assert.equal(serialized.includes('rich-code-secret'), false)
  assert.match(serialized, /look/)
  assert.match(serialized, /please/)
})

test('outgoing M1 segments refuse unregistered media and blank text', () => {
  assert.throws(() => validateOutgoingSegments([{ type: 'image', data: { file: '/local/private' } }]), /unsupported/)
  assert.throws(() => validateOutgoingSegments([{ type: 'text', data: { text: '   ' } }]), /invalid text/)
  assert.deepEqual(validateOutgoingSegments([{ type: 'at', data: { qq: '30001' } }]), [{ type: 'at', data: { qq: '30001' } }])
})

test('standard QQ face segments accept a bounded numeric ID and discard extra payload', () => {
  assert.deepEqual(validateOutgoingSegments([{ type: 'face', data: { id: 14, file: '/private/ignored' } }]),
    [{ type: 'face', data: { id: '14' } }])
  assert.throws(() => validateOutgoingSegments([{ type: 'face', data: { id: -1 } }]), /face/i)
  assert.throws(() => validateOutgoingSegments([{ type: 'face', data: { id: 'not-an-id' } }]), /face/i)
  assert.throws(() => validateOutgoingSegments([{ type: 'face', data: { id: '999999999999999999999' } }]), /face/i)
})

test('adapter sends only a selected OneBot action and classifies platform rejection', async () => {
  const calls = []
  const adapter = new OneBotAdapter({ enabled: true, httpUrl: 'http://127.0.0.1:12345', wsUrl: 'ws://127.0.0.1:12346' }, {
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: -9 } }) }
    },
  })
  assert.deepEqual(await adapter.send({ botId: '10001', kind: 'group', peerId: '20001' }, [{ type: 'text', data: { text: 'Hi' } }]), { messageId: '-9' })
  assert.match(calls[0].url, /\/send_group_msg$/)
  assert.equal(calls[0].body.group_id, '20001')
  const denied = new OneBotAdapter({ enabled: true, httpUrl: 'http://127.0.0.1:12345' }, {
    fetch: async () => ({ ok: true, json: async () => ({ status: 'failed', retcode: 1401, data: null }) }),
  })
  await assert.rejects(denied.action('send_group_msg', {}), { code: 'ONEBOT_REJECTED' })
  assert.equal(new OneBotAdapter().status, 'disabled')
})
