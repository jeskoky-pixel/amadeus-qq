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

test('outgoing M1 segments refuse unregistered media and blank text', () => {
  assert.throws(() => validateOutgoingSegments([{ type: 'image', data: { file: '/local/private' } }]), /unsupported/)
  assert.throws(() => validateOutgoingSegments([{ type: 'text', data: { text: '   ' } }]), /invalid text/)
  assert.deepEqual(validateOutgoingSegments([{ type: 'at', data: { qq: '30001' } }]), [{ type: 'at', data: { qq: '30001' } }])
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
