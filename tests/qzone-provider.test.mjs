import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createQzoneProvider } from '../src/qzone-provider.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

function response(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
}

function ok(data) {
  return response({ status: 'ok', retcode: 0, data })
}

function fixture(t, { fetchImpl, token = 'secret-token', options = {} } = {}) {
  const calls = []
  const defaultFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body), signal: init.signal })
    return ok({})
  }
  const provider = createQzoneProvider({
    baseUrl: 'http://127.0.0.1:5700',
    tokenEnv: 'QZONE_TOKEN',
    env: token === null ? {} : { QZONE_TOKEN: token },
    fetch: fetchImpl ?? defaultFetch,
    ...options,
  })
  t.after(() => provider.close())
  const ledgerRuns = []
  const ledger = {
    async run(request) {
      ledgerRuns.push(request)
      return await request.execute()
    },
  }
  let allowed = true
  const authCalls = []
  const context = (sceneKey = 'scene-a') => ({
    sceneKey,
    sessionId: 'session-1',
    authorize: async request => {
      authCalls.push(request)
      return allowed
    },
    ledger,
  })
  return { provider, calls, ledgerRuns, authCalls, context, setAllowed: value => { allowed = value } }
}

function nativeFixture(t, { transport, ledger } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-qzone-native-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sendRoot = path.join(dir, 'send')
  const tempRoot = path.join(dir, 'temp')
  fs.mkdirSync(sendRoot)
  fs.mkdirSync(tempRoot)
  for (const name of ['one.png', 'two.png', 'bad.txt']) fs.writeFileSync(path.join(sendRoot, name), name === 'bad.txt' ? Buffer.from('no') : PNG)
  const calls = []
  const nativeTransport = transport ?? {
    async action(name, params, timeoutMs, maxResponseBytes) {
      calls.push({ name, params, timeoutMs, maxResponseBytes, files: params.images ?? [],
        filesExist: (params.images ?? []).map(file => fs.existsSync(fileURLToPath(file))) })
      return { tid: 'qzone-tid-1' }
    },
  }
  const ledgerRuns = []
  const ledgerImpl = ledger ?? {
    async run(request) {
      ledgerRuns.push(request)
      return await request.execute()
    },
  }
  const provider = createQzoneProvider({ nativeTransport, sendRoot, tempRoot, timeoutMs: 5000 })
  t.after(() => provider.close())
  let allowed = true
  const authCalls = []
  const context = (sceneKey = 'scene-a') => ({
    sceneKey,
    sessionId: 'session-1',
    authorize: async request => { authCalls.push(request); return allowed },
    ledger: ledgerImpl,
  })
  return { dir, sendRoot, tempRoot, provider, calls, ledgerRuns, authCalls, context, nativeTransport, setAllowed: value => { allowed = value } }
}

const POST = {
  tid: 'p1', uin: '10001', content: 'hello https://private.invalid/x', created_time: 10,
  likenum: 2, commentnum: 1, pic: [{ url: 'https://private.invalid/pic', base64: 'AAAA' }],
  comments: [{ commentid: 'c1', uin: '20001', content: 'first' }],
}

test('own posts are projected, observed, and a self post can be deleted through the ledger', async t => {
  const { provider, calls, ledgerRuns, context } = fixture(t, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
      if (String(url).endsWith('/get_emotion_list')) return ok({ msglist: [POST] })
      return ok({ tid: 'p1' })
    },
  })
  const ctx = context()
  const page = await provider.listOwnPosts(ctx, { limit: 10 })
  assert.equal(page.posts.length, 1)
  assert.equal(page.posts[0].tid, 'p1')
  assert.equal(page.posts[0].isSelf, true)
  assert.equal(page.posts[0].hasImages, true)
  assert.equal(page.posts[0].content.includes('private.invalid'), false)
  assert.equal(JSON.stringify(page).includes('AAAA'), false)
  assert.equal(JSON.stringify(page).includes('secret-token'), false)
  assert.equal(calls[0].headers.authorization, 'Bearer secret-token')
  assert.deepEqual(calls[0].body.include_image_data, false)

  const deleted = await provider.deleteOwnPost(ctx, { tid: 'p1', actionId: 'delete-1' })
  assert.deepEqual(deleted, { status: 'ok', tid: 'p1' })
  assert.equal(ledgerRuns.length, 1)
  assert.equal(ledgerRuns[0].action, 'delete_msg')
  assert.equal(calls.at(-1).body.message_id, 'p1')
})

test('like, unlike, comment, reply and forward use only observed targets', async t => {
  const { provider, calls, context } = fixture(t, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      if (String(url).endsWith('/get_emotion_list')) return ok({ msglist: [POST] })
      if (String(url).endsWith('/get_comment_list')) return ok({ commentlist: [{ commentid: 'c1', uin: '20001', content: 'first' }] })
      return ok({})
    },
  })
  const ctx = context()
  await provider.listOwnPosts(ctx)
  await provider.listComments(ctx, { tid: 'p1' })
  await provider.likePost(ctx, { tid: 'p1', actionId: 'like-1' })
  await provider.unlikePost(ctx, { tid: 'p1', actionId: 'unlike-1' })
  await provider.commentPost(ctx, { tid: 'p1', text: 'comment', actionId: 'comment-1' })
  await provider.replyComment(ctx, { tid: 'p1', commentId: 'c1', text: 'reply', actionId: 'reply-1' })
  await provider.forwardPost(ctx, { tid: 'p1', text: 'forward', actionId: 'forward-1' })
  const writes = calls.filter(call => !call.url.endsWith('/get_emotion_list') && !call.url.endsWith('/get_comment_list'))
  assert.deepEqual(writes.map(call => call.url.split('/').at(-1)), ['send_like', 'unlike', 'send_comment', 'send_comment', 'forward_msg'])
  assert.deepEqual(writes[0].body, { tid: 'p1', user_id: '10001' })
  assert.deepEqual(writes[2].body, { target_uin: '10001', target_tid: 'p1', content: 'comment' })
  assert.deepEqual(writes[3].body, {
    target_uin: '10001', target_tid: 'p1', content: 'reply',
    reply_comment_id: 'c1', reply_uin: '20001',
  })
})

test('cross-Scene, unobserved and unowned targets are rejected before any write', async t => {
  let fetches = 0
  const { provider, context } = fixture(t, {
    fetchImpl: async (url) => {
      fetches += 1
      return String(url).endsWith('/get_friend_feeds')
        ? ok({ msglist: [{ ...POST, uin: '99999' }] })
        : ok({})
    },
  })
  const first = context('scene-a')
  const second = context('scene-b')
  await provider.listFriendFeeds(first)
  await assert.rejects(provider.deleteOwnPost(second, { tid: 'p1', actionId: 'delete-b' }), /QQ_QZONE_TARGET_UNOBSERVED/)
  await assert.rejects(provider.deleteOwnPost(first, { tid: 'p1', actionId: 'delete-a' }), /QQ_QZONE_TARGET_NOT_OWNED/)
  assert.equal(fetches, 1)
})

test('missing authorization, closed service and missing ledger fail closed', async t => {
  const { provider, context, setAllowed } = fixture(t, {
    fetchImpl: async () => ok({ msglist: [POST] }),
  })
  const ctx = context()
  setAllowed(false)
  await assert.rejects(provider.listOwnPosts(ctx), /QQ_QZONE_UNAUTHORIZED/)
  setAllowed(true)
  await provider.listOwnPosts(ctx)
  await assert.rejects(provider.likePost({ ...ctx, ledger: undefined }, { tid: 'p1', actionId: 'like-1' }), /QQ_QZONE_LEDGER_REQUIRED/)
  await assert.rejects(provider.likePost(ctx, { tid: 'p1', actionId: '' }), /QQ_QZONE_ACTION_ID_INVALID/)
  provider.close()
  await assert.rejects(provider.listOwnPosts(ctx), /QQ_QZONE_CLOSED/)
})

test('revocation after an external read withholds results', async t => {
  const { provider, context, setAllowed } = fixture(t, {
    fetchImpl: async () => ok({ msglist: [POST] }),
  })
  const ctx = context()
  const original = ctx.authorize
  let calls = 0
  ctx.authorize = async request => { calls += 1; return calls === 1 && original(request) }
  await assert.rejects(provider.listOwnPosts(ctx), /QQ_QZONE_UNAUTHORIZED/)
  setAllowed(true)
})

test('empty token, non-loopback URL and oversized or malformed responses are rejected', async t => {
  assert.throws(() => createQzoneProvider({
    baseUrl: 'http://example.com', tokenEnv: 'QZONE_TOKEN', env: { QZONE_TOKEN: 'x' },
  }), /QQ_QZONE_URL_INVALID/)
  const missing = fixture(t, { token: null })
  await assert.rejects(missing.provider.listOwnPosts(missing.context()), /QQ_QZONE_TOKEN_MISSING/)

  const oversized = fixture(t, {
    options: { maxResponseBytes: 100 },
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { msglist: [] }, padding: 'A'.repeat(200) })),
  })
  await assert.rejects(oversized.provider.listOwnPosts(oversized.context()), /QQ_QZONE_RESPONSE_TOO_LARGE/)

  const malformed = fixture(t, { fetchImpl: async () => new Response('not json') })
  await assert.rejects(malformed.provider.listOwnPosts(malformed.context()), /QQ_QZONE_RESPONSE_INVALID/)
})

test('write timeout is unknown, not retried, and preserves auth/ledger hooks', async t => {
  let fetches = 0
  const { provider, context, ledgerRuns } = fixture(t, {
    fetchImpl: async () => { fetches += 1; throw new DOMException('timed out', 'TimeoutError') },
  })
  await assert.rejects(provider.publishText(context(), { text: 'hello', actionId: 'publish-1' }), /QQ_QZONE_UNKNOWN/)
  assert.equal(fetches, 1)
  assert.equal(ledgerRuns.length, 1)
  assert.equal(ledgerRuns[0].actionId, 'publish-1')
})

test('write revocation after the external call is surfaced as a failed write', async t => {
  const { provider, context } = fixture(t, {
    fetchImpl: async url => String(url).endsWith('/get_emotion_list')
      ? ok({ msglist: [POST] })
      : ok({ tid: 'p1' }),
  })
  const ctx = context()
  await provider.listOwnPosts(ctx)
  let calls = 0
  const original = ctx.authorize
  ctx.authorize = async request => {
    calls += 1
    return calls === 1 && original(request)
  }
  await assert.rejects(provider.deleteOwnPost(ctx, { tid: 'p1', actionId: 'delete-revoked' }), /QQ_QZONE_UNAUTHORIZED/)
})

test('bridge calls stay on the registered action path, disable redirects and expose no arbitrary action', async t => {
  let captured
  const { provider, context } = fixture(t, {
    fetchImpl: async (url, init) => { captured = { url: String(url), init }; return ok({ msglist: [] }) },
  })
  await provider.listOwnPosts(context())
  assert.match(captured.url, /^http:\/\/127\.0\.0\.1:5700\/get_emotion_list$/)
  assert.equal(captured.init.redirect, 'error')
  assert.equal(captured.init.headers.authorization, 'Bearer secret-token')
  assert.equal(typeof provider.action, 'undefined')
})

test('pagination exposes only an opaque provider cursor and never the bridge cursor', async t => {
  const rawCursor = 'https://user:pass@private.invalid/page?cookie=secret-token'
  const bodies = []
  const { provider, context } = fixture(t, {
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return bodies.length === 1
        ? ok({ msglist: [POST], next_cursor: rawCursor })
        : ok({ msglist: [] })
    },
  })
  const page1 = await provider.listOwnPosts(context())
  assert.match(page1.nextCursor, /^c_[a-f0-9]{32}$/)
  assert.equal(JSON.stringify(page1).includes('secret-token'), false)
  assert.equal(JSON.stringify(page1).includes('private.invalid'), false)
  assert.equal(page1.hasMore, true)
  const page2 = await provider.listOwnPosts(context(), { cursor: page1.nextCursor })
  assert.equal(page2.nextCursor, null)
  assert.equal(page2.hasMore, false)
  assert.equal(bodies[1].cursor, rawCursor, 'the raw bridge cursor is only sent back to the bridge')
  await assert.rejects(provider.listOwnPosts(context(), { cursor: rawCursor }), /QQ_QZONE_CURSOR_INVALID/)
})

test('observed Scene and post caches are bounded and expire targets', async t => {
  let clock = 1_000
  const { provider, context } = fixture(t, {
    options: { maxObservedScenes: 2, maxObservedPosts: 1, observationTtlMs: 500, now: () => clock },
    fetchImpl: async () => ok({ msglist: [{ ...POST, tid: `p-${clock}` }] }),
  })
  const first = context('scene-1')
  const second = context('scene-2')
  const third = context('scene-3')
  await provider.listOwnPosts(first)
  clock += 10
  await provider.listOwnPosts(second)
  clock += 10
  await provider.listOwnPosts(third)
  await assert.rejects(provider.deleteOwnPost(first, { tid: 'p-1000', actionId: 'old-scene' }), /QQ_QZONE_TARGET_UNOBSERVED/)

  clock += 10
  await provider.listOwnPosts(second)
  const postId = `p-${clock}`
  clock += 600
  await assert.rejects(provider.deleteOwnPost(second, { tid: postId, actionId: 'old-ttl' }), /QQ_QZONE_TARGET_UNOBSERVED/)
})

test('HTTP 200 with a non-zero retcode is a failed write and is not retried', async t => {
  let fetches = 0
  const { provider, context, ledgerRuns } = fixture(t, {
    fetchImpl: async url => {
      fetches += 1
      if (String(url).endsWith('/get_emotion_list')) return ok({ msglist: [POST] })
      return response({ status: 'ok', retcode: 1401, data: null })
    },
  })
  const ctx = context()
  await provider.listOwnPosts(ctx)
  await assert.rejects(provider.deleteOwnPost(ctx, { tid: 'p1', actionId: 'reject-1' }), /QQ_QZONE_REJECTED/)
  assert.equal(fetches, 2)
  assert.equal(ledgerRuns.length, 1)
})

test('native publish supports text and text plus controlled image snapshots', async t => {
  const { provider, calls, tempRoot, context, authCalls, ledgerRuns } = nativeFixture(t)
  const text = await provider.publishText(context(), { text: 'hello qzone', actionId: 'text-1' })
  assert.deepEqual(text, { status: 'ok', tid: 'qzone-tid-1', imageCount: 0 })
  assert.deepEqual(calls[0].params, { content: 'hello qzone', ugc_right: 64 })
  assert.equal(calls[0].name, 'send_qzone_msg')
  assert.equal(authCalls[0].write, true)
  assert.equal(ledgerRuns[0].action, 'send_qzone_msg')

  const media = await provider.publishMedia(context(), { text: '', images: ['one.png', 'two.png'], actionId: 'media-1' })
  assert.deepEqual(media, { status: 'ok', tid: 'qzone-tid-1', imageCount: 2 })
  const mediaCall = calls.at(-1)
  assert.equal(mediaCall.params.content, '')
  assert.equal(mediaCall.params.ugc_right, 64)
  assert.equal(mediaCall.params.images.length, 2)
  for (const file of mediaCall.params.images) {
    assert.match(file, /^file:\/\//)
  }
  assert.deepEqual(mediaCall.filesExist, [true, true])
  assert.equal(fs.readdirSync(tempRoot).length, 0)
})

test('native publish requires an explicit supported audience to leave self visibility', async t => {
  const { provider, context, calls } = nativeFixture(t)
  await provider.publishText(context(), { text: 'friends post', audience: 'friends', actionId: 'friends-1' })
  assert.equal(calls[0].params.ugc_right, 4)
  await assert.rejects(provider.publishText(context(), { text: 'bad', audience: 'everyone', actionId: 'bad-1' }), /QQ_QZONE_AUDIENCE_INVALID/)
  assert.equal(calls.length, 1)
})

test('native text publishing does not require a media send root', async t => {
  const provider = createQzoneProvider({ nativeTransport: { async action() { return { tid: 'text-only-1' } } } })
  t.after(() => provider.close())
  const context = {
    sceneKey: 'private:10001:20001', sessionId: 'session-1',
    authorize: async () => true,
    ledger: { run: request => request.execute() },
  }
  assert.equal((await provider.publishText(context, { text: 'hello', actionId: 'text-only-1' })).tid, 'text-only-1')
})

test('native publish validates content, image count, paths and formats before transport', async t => {
  const { provider, calls, tempRoot, context } = nativeFixture(t)
  await assert.rejects(provider.publishText(context(), { text: 'x'.repeat(1001), actionId: 'long' }), /QQ_QZONE_CONTENT_TOO_LONG/)
  await assert.rejects(provider.publishText(context(), { text: '', actionId: 'empty' }), /QQ_QZONE_CONTENT_INVALID/)
  await assert.rejects(provider.publishMedia(context(), { images: [], actionId: 'empty-media' }), /QQ_QZONE_CONTENT_INVALID/)
  await assert.rejects(provider.publishMedia(context(), { images: Array(10).fill('one.png'), actionId: 'many' }), /QQ_QZONE_IMAGE_LIMIT/)
  for (const value of ['../one.png', '/absolute/one.png', 'https://private.invalid/a.png', 'base64://AAAA', 'bad.txt', 'missing.png']) {
    await assert.rejects(provider.publishMedia(context(), { images: [value], actionId: `bad-${value.length}` }), /QQ_QZONE_IMAGE_INVALID/)
  }
  assert.equal(calls.length, 0)
  assert.equal(fs.readdirSync(tempRoot).length, 0)
})

test('native publish is unknown on timeout, missing tid or post-call revocation and rejects platform refusal', async t => {
  const timeout = nativeFixture(t, {
    transport: { async action() { throw new DOMException('timeout', 'TimeoutError') } },
  })
  await assert.rejects(timeout.provider.publishText(timeout.context(), { text: 'x', actionId: 'timeout' }), /QQ_QZONE_UNKNOWN/)
  assert.equal(fs.readdirSync(timeout.tempRoot).length, 0)

  const missing = nativeFixture(t, { transport: { async action() { return {} } } })
  await assert.rejects(missing.provider.publishText(missing.context(), { text: 'x', actionId: 'missing-tid' }), /QQ_QZONE_UNKNOWN/)

  const refused = nativeFixture(t, {
    transport: { async action() { const error = new Error('refused'); error.code = 'ONEBOT_REJECTED'; throw error } },
  })
  await assert.rejects(refused.provider.publishText(refused.context(), { text: 'x', actionId: 'refused' }), /QQ_QZONE_REJECTED/)

  const revoked = nativeFixture(t)
  const ctx = revoked.context()
  let checks = 0
  const original = ctx.authorize
  ctx.authorize = async request => { checks += 1; return checks === 1 && original(request) }
  await assert.rejects(revoked.provider.publishText(ctx, { text: 'x', actionId: 'revoked' }), /QQ_QZONE_UNKNOWN/)
  assert.equal(fs.readdirSync(revoked.tempRoot).length, 0)
})

test('native publish fingerprint is image-content scoped and idempotent across Sessions', async t => {
  const records = new Map()
  const ledger = {
    async run(request) {
      const prior = records.get(request.actionId)
      if (prior) {
        if (prior.fingerprint !== request.fingerprint) throw new Error('QQ_QZONE_ACTION_CONFLICT')
        return { status: 'delivered', repeated: true, result: prior.result }
      }
      const result = await request.execute()
      records.set(request.actionId, { fingerprint: request.fingerprint, result })
      return { status: 'delivered', repeated: false, result }
    },
  }
  const base = nativeFixture(t, { ledger })
  await base.provider.publishMedia(base.context('scene-a'), { text: 'same', images: ['one.png'], actionId: 'same' })
  const repeated = await base.provider.publishMedia(base.context('scene-a'), { text: 'same', images: ['one.png'], actionId: 'same' })
  assert.equal(repeated.repeated, true)
  assert.equal(base.calls.length, 1)
  await assert.rejects(base.provider.publishMedia(base.context('scene-a'), { text: 'changed', images: ['one.png'], actionId: 'same' }), /ACTION_CONFLICT/)
  assert.equal(fs.readdirSync(base.tempRoot).length, 0)

  const nativeOnly = nativeFixture(t)
  await assert.rejects(nativeOnly.provider.listOwnPosts(nativeOnly.context()), /QQ_QZONE_BRIDGE_UNAVAILABLE/)
})

test('media publish is explicitly unsupported and never invokes the bridge', async t => {
  const { provider, calls } = fixture(t)
  await assert.rejects(provider.publishMedia(), /QQ_QZONE_MEDIA_UNSUPPORTED/)
  assert.equal(calls.length, 0)
})
