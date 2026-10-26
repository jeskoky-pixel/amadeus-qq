import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { snapshotControlledImage } from './outbound-media.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_SCENES = 64
const DEFAULT_MAX_POSTS_PER_SCENE = 200
const DEFAULT_MAX_COMMENTS_PER_SCENE = 500
const DEFAULT_MAX_CURSORS_PER_SCENE = 8
const DEFAULT_OBSERVATION_TTL_MS = 30 * 60 * 1000
const MAX_RAW_CURSOR = 4096
const CURSOR_TOKEN_PATTERN = /^c_[a-f0-9]{32}$/
const MAX_TEXT = 4_000
const MAX_CONTENT = 5_000
const MAX_PUBLISH_TEXT = 1_000
const MAX_QZONE_IMAGES = 9
const QZONE_AUDIENCES = Object.freeze({ self: 64, friends: 4, public: 1 })
const MAX_TARGET_ID = 200

const ACTIONS = Object.freeze({
  ownPosts: 'get_emotion_list',
  friendFeeds: 'get_friend_feeds',
  comments: 'get_comment_list',
  publishText: 'send_private_msg',
  deleteOwn: 'delete_msg',
  like: 'send_like',
  unlike: 'unlike',
  comment: 'send_comment',
  forward: 'forward_msg',
})

function qzoneError(code, options = {}) {
  const error = new Error(code, options)
  error.code = code
  return error
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') throw qzoneError('QQ_QZONE_URL_INVALID')
  let url
  try { url = new URL(value) } catch { throw qzoneError('QQ_QZONE_URL_INVALID') }
  if (!['http:', 'https:'].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== '' || url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' || url.hash !== '') {
    throw qzoneError('QQ_QZONE_URL_INVALID')
  }
  return url.origin
}

function safeText(value, limit = MAX_CONTENT) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/https?:\/\/\S+/gi, '[url omitted]')
    .replace(/base64:\/\/\S+/gi, '[base64 omitted]')
    .trim()
    .slice(0, limit)
}

function projectId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TARGET_ID ||
    !/^[A-Za-z0-9_.:-]+$/.test(id)) return null
  return id
}

function textField(value, limit = MAX_CONTENT) {
  const text = safeText(value, limit)
  if (!text) throw qzoneError('QQ_QZONE_CONTENT_INVALID')
  return text
}

function publishTextField(value, allowEmpty) {
  if (value === undefined || value === null) {
    if (allowEmpty) return ''
    throw qzoneError('QQ_QZONE_CONTENT_INVALID')
  }
  if (typeof value !== 'string') throw qzoneError('QQ_QZONE_CONTENT_INVALID')
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if (text.length > MAX_PUBLISH_TEXT) throw qzoneError('QQ_QZONE_CONTENT_TOO_LONG')
  if (!allowEmpty && text.length === 0) throw qzoneError('QQ_QZONE_CONTENT_INVALID')
  return text
}

function idField(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TARGET_ID ||
    !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw qzoneError('QQ_QZONE_TARGET_INVALID')
  }
  return id
}

function numberField(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function arrayFrom(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  for (const key of ['msglist', 'feeds', 'items', 'list', 'comments', 'commentlist', 'comment_list', 'data']) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}

function projectComment(raw, tid) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const commentId = projectId(raw.commentid ?? raw.comment_id ?? raw.id)
  const authorUin = projectId(raw.uin ?? raw.user_id ?? raw.author?.uin)
  const text = raw.content ?? raw.text
  if (commentId === null || text === undefined) return null
  return {
    tid,
    commentId,
    authorUin,
    content: safeText(String(text)),
    createdAt: numberField(raw.create_time ?? raw.created_time ?? raw.createdAt) || null,
  }
}

function projectPost(raw, { own, selfId }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const tid = projectId(raw.tid ?? raw.message_id ?? raw.id)
  if (tid === null) return null
  const authorUin = projectId(raw.uin ?? raw.user_id ?? raw.author?.uin ?? raw.author?.id)
  const text = raw.content ?? raw.text ?? raw.summary
  const comments = Array.isArray(raw.comments) || Array.isArray(raw.commentlist)
    ? (raw.comments ?? raw.commentlist).map(item => projectComment(item, tid)).filter(Boolean)
    : []
  const imageList = raw.pic ?? raw.images
  return {
    tid,
    authorUin,
    content: safeText(text === undefined ? '' : String(text)),
    createdAt: numberField(raw.created_time ?? raw.createdTime ?? raw.createTime) || null,
    likeCount: numberField(raw.likenum ?? raw.like_count),
    commentCount: numberField(raw.commentnum ?? raw.comment_count),
    forwardCount: numberField(raw.forwardnum ?? raw.forward_count),
    isSelf: own === true || (selfId !== undefined && String(authorUin) === selfId),
    hasImages: Array.isArray(imageList) && imageList.length > 0,
    comments,
  }
}

function projectWrite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'ok' }
  const result = { status: 'ok' }
  const tid = projectId(raw.tid ?? raw.message_id ?? raw.id)
  if (tid !== null) result.tid = tid
  return result
}

function validRawCursor(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > MAX_RAW_CURSOR ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw qzoneError('QQ_QZONE_CURSOR_INVALID')
  }
  return value
}

async function readBoundedJson(response, maxBytes) {
  const declared = response.headers?.get?.('content-length')
  if (declared !== null && declared !== undefined) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) throw qzoneError('QQ_QZONE_RESPONSE_TOO_LARGE')
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw qzoneError('QQ_QZONE_RESPONSE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* best effort */ }
        throw qzoneError('QQ_QZONE_RESPONSE_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } finally {
    try { reader.releaseLock() } catch { /* already closed */ }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw qzoneError('QQ_QZONE_RESPONSE_INVALID')
  }
}

export function createQzoneProvider(options = {}) {
  const nativeTransport = options.nativeTransport
  if (nativeTransport !== undefined &&
    (!nativeTransport || typeof nativeTransport.action !== 'function')) {
    throw qzoneError('QQ_QZONE_TRANSPORT_INVALID')
  }
  const bridgeConfigured = options.baseUrl !== undefined || options.tokenEnv !== undefined
  if (!bridgeConfigured && !nativeTransport) throw qzoneError('QQ_QZONE_URL_INVALID')
  const baseUrl = bridgeConfigured ? normalizeBaseUrl(options.baseUrl) : null
  const tokenEnv = options.tokenEnv
  if (!nativeTransport || bridgeConfigured) {
    if (typeof tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) {
      throw qzoneError('QQ_QZONE_TOKEN_ENV_INVALID')
    }
  }
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sendRoot = options.sendRoot
  const tempRoot = options.tempRoot
  if (sendRoot !== undefined && (typeof sendRoot !== 'string' || !sendRoot)) {
    throw qzoneError('QQ_QZONE_CONFIG_INVALID')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxScenes = options.maxObservedScenes ?? DEFAULT_MAX_SCENES
  const maxPostsPerScene = options.maxObservedPosts ?? DEFAULT_MAX_POSTS_PER_SCENE
  const maxCommentsPerScene = options.maxObservedComments ?? DEFAULT_MAX_COMMENTS_PER_SCENE
  const maxCursorsPerScene = options.maxCursorTokens ?? DEFAULT_MAX_CURSORS_PER_SCENE
  const observationTtlMs = options.observationTtlMs ?? DEFAULT_OBSERVATION_TTL_MS
  const now = options.now ?? (() => Date.now())
  if (![timeoutMs, maxResponseBytes, maxScenes, maxPostsPerScene, maxCommentsPerScene, maxCursorsPerScene, observationTtlMs]
    .every(value => Number.isSafeInteger(value) && value > 0)) {
    throw qzoneError('QQ_QZONE_CONFIG_INVALID')
  }
  const selfId = options.selfId === undefined ? undefined : idField(options.selfId)
  const observations = new Map()
  let closed = false

  function token() {
    if (baseUrl === null) throw qzoneError('QQ_QZONE_BRIDGE_UNAVAILABLE')
    const value = env[tokenEnv]
    if (typeof value !== 'string' || value.trim().length === 0) throw qzoneError('QQ_QZONE_TOKEN_MISSING')
    return value.trim()
  }

  function requireOpen() {
    if (closed) throw qzoneError('QQ_QZONE_CLOSED')
  }

  function pruneScenes() {
    const timestamp = now()
    for (const [key, state] of observations) {
      if (timestamp - state.lastUsed > observationTtlMs) observations.delete(key)
    }
    while (observations.size >= maxScenes) {
      let oldestKey
      let oldest = Infinity
      for (const [key, state] of observations) {
        if (state.lastUsed < oldest) { oldest = state.lastUsed; oldestKey = key }
      }
      if (oldestKey === undefined) break
      observations.delete(oldestKey)
    }
  }

  function sceneState(sceneKey) {
    requireOpen()
    if (typeof sceneKey !== 'string' || sceneKey.length === 0 || sceneKey.length > 200) {
      throw qzoneError('QQ_QZONE_SCENE_INVALID')
    }
    pruneScenes()
    let state = observations.get(sceneKey)
    if (!state) {
      state = {
        posts: new Map(),
        comments: new Map(),
        cursors: new Map(),
        lastUsed: now(),
      }
      observations.set(sceneKey, state)
    } else {
      state.lastUsed = now()
    }
    return state
  }

  function rememberPost(state, post) {
    if (!state.posts.has(post.tid) && state.posts.size >= maxPostsPerScene) {
      const oldest = state.posts.keys().next().value
      if (oldest !== undefined) state.posts.delete(oldest)
    }
    state.posts.set(post.tid, post)
  }

  function rememberComment(state, key, comment) {
    if (!state.comments.has(key) && state.comments.size >= maxCommentsPerScene) {
      const oldest = state.comments.keys().next().value
      if (oldest !== undefined) state.comments.delete(oldest)
    }
    state.comments.set(key, comment)
  }

  function issueCursor(state, raw) {
    if (raw === null) return null
    const token = `c_${randomBytes(16).toString('hex')}`
    if (!state.cursors.has(token) && state.cursors.size >= maxCursorsPerScene) {
      const oldest = state.cursors.keys().next().value
      if (oldest !== undefined) state.cursors.delete(oldest)
    }
    state.cursors.set(token, raw)
    return token
  }

  function resolveCursor(state, token) {
    if (token === undefined || token === null || token === '') return undefined
    if (typeof token !== 'string' || !CURSOR_TOKEN_PATTERN.test(token)) {
      throw qzoneError('QQ_QZONE_CURSOR_INVALID')
    }
    const raw = state.cursors.get(token)
    if (raw === undefined) throw qzoneError('QQ_QZONE_CURSOR_INVALID')
    return raw
  }

  async function authorize(context, action, target, write) {
    if (!context || typeof context !== 'object' || typeof context.authorize !== 'function') {
      throw qzoneError('QQ_QZONE_UNAUTHORIZED')
    }
    sceneState(context.sceneKey)
    let allowed = false
    try {
      allowed = await context.authorize({
        action,
        write,
        sceneKey: context.sceneKey,
        sessionId: context.sessionId,
        target,
      }) === true
    } catch {
      allowed = false
    }
    if (!allowed) throw qzoneError('QQ_QZONE_UNAUTHORIZED')
  }

  async function call(action, params, write) {
    requireOpen()
    if (baseUrl === null) throw qzoneError('QQ_QZONE_BRIDGE_UNAVAILABLE')
    if (!Object.values(ACTIONS).includes(action)) throw qzoneError('QQ_QZONE_ACTION_INVALID')
    const auth = token()
    let response
    try {
      response = await fetchImpl(`${baseUrl}/${action}`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw qzoneError(write ? 'QQ_QZONE_UNKNOWN' : 'QQ_QZONE_TIMEOUT')
      }
      throw qzoneError(write ? 'QQ_QZONE_UNKNOWN' : 'QQ_QZONE_UNAVAILABLE')
    }
    const result = await readBoundedJson(response, maxResponseBytes)
    if (!response.ok || !result || typeof result !== 'object' ||
      result.status !== 'ok' || result.retcode !== 0) {
      throw qzoneError('QQ_QZONE_REJECTED')
    }
    return result.data
  }

  function observePosts(sceneKey, posts, own) {
    const state = sceneState(sceneKey)
    for (const post of posts) {
      if (!post) continue
      rememberPost(state, { ...post, isSelf: post.isSelf || own })
      for (const comment of post.comments) {
        rememberComment(state, `${post.tid}:${comment.commentId}`, comment)
      }
    }
  }

  async function readPosts(context, action, params, own) {
    await authorize(context, action, null, false)
    const state = sceneState(context.sceneKey)
    const rawCursor = resolveCursor(state, params.cursor)
    const bridgeParams = { ...params }
    delete bridgeParams.cursor
    if (rawCursor !== undefined) bridgeParams.cursor = rawCursor
    const data = await call(action, bridgeParams, false)
    await authorize(context, action, null, false)
    const posts = arrayFrom(data).map(raw => projectPost(raw, { own, selfId })).filter(Boolean)
    observePosts(context.sceneKey, posts, own)
    const nextRaw = validRawCursor(data?.next_cursor ?? data?.nextCursor ?? data?.cursor)
    const nextCursor = issueCursor(sceneState(context.sceneKey), nextRaw)
    return {
      posts,
      nextCursor,
      hasMore: nextCursor !== null,
    }
  }

  function targetPost(context, tid) {
    const id = idField(tid)
    const post = sceneState(context.sceneKey).posts.get(id)
    if (!post) throw qzoneError('QQ_QZONE_TARGET_UNOBSERVED')
    return post
  }

  function targetComment(context, tid, commentId) {
    const post = targetPost(context, tid)
    const id = idField(commentId)
    const comment = sceneState(context.sceneKey).comments.get(`${post.tid}:${id}`)
    if (!comment) throw qzoneError('QQ_QZONE_TARGET_UNOBSERVED')
    return { post, comment }
  }

  async function write(context, action, target, params, actionId) {
    await authorize(context, action, target, true)
    if (!context.ledger || typeof context.ledger.run !== 'function') {
      throw qzoneError('QQ_QZONE_LEDGER_REQUIRED')
    }
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) {
      throw qzoneError('QQ_QZONE_ACTION_ID_INVALID')
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ action, sceneKey: context.sceneKey, target, params }))
      .digest('hex')
    return context.ledger.run({
      actionId,
      fingerprint,
      action,
      sceneKey: context.sceneKey,
      target,
      execute: async () => {
        const data = await call(action, params, true)
        await authorize(context, action, target, true)
        return projectWrite(data)
      },
    })
  }

  async function nativeCall(params) {
    requireOpen()
    if (!nativeTransport) throw qzoneError('QQ_QZONE_NATIVE_UNAVAILABLE')
    let data
    try {
      data = await nativeTransport.action('send_qzone_msg', params, timeoutMs, maxResponseBytes)
    } catch (error) {
      if (error?.code === 'ONEBOT_REJECTED') throw qzoneError('QQ_QZONE_REJECTED')
      throw qzoneError('QQ_QZONE_UNKNOWN')
    }
    return data
  }

  async function publishNative(context, { text, images, actionId, audience = 'self' }) {
    await authorize(context, 'send_qzone_msg', null, true)
    if (!context.ledger || typeof context.ledger.run !== 'function') {
      throw qzoneError('QQ_QZONE_LEDGER_REQUIRED')
    }
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) {
      throw qzoneError('QQ_QZONE_ACTION_ID_INVALID')
    }
    if (images !== undefined && !Array.isArray(images)) throw qzoneError('QQ_QZONE_IMAGE_INVALID')
    const paths = images ?? []
    if (paths.length > MAX_QZONE_IMAGES) throw qzoneError('QQ_QZONE_IMAGE_LIMIT')
    for (const relative of paths) {
      if (typeof relative !== 'string' || relative.length === 0) throw qzoneError('QQ_QZONE_IMAGE_INVALID')
    }
    const content = publishTextField(text, paths.length > 0)
    if (content.length === 0 && paths.length === 0) throw qzoneError('QQ_QZONE_CONTENT_INVALID')
    if (!Object.hasOwn(QZONE_AUDIENCES, audience)) throw qzoneError('QQ_QZONE_AUDIENCE_INVALID')
    if (paths.length > 0 && (typeof sendRoot !== 'string' || !sendRoot)) {
      throw qzoneError('QQ_QZONE_SEND_ROOT_INVALID')
    }

    const snapshots = []
    try {
      for (const relative of paths) {
        try {
          snapshots.push(await snapshotControlledImage({ sendRoot, relativePath: relative, tempRoot }))
        } catch {
          throw qzoneError('QQ_QZONE_IMAGE_INVALID')
        }
      }
      const fileUrls = snapshots.map(snapshot => pathToFileURL(snapshot.path).href)
      const params = { content, ugc_right: QZONE_AUDIENCES[audience] }
      if (fileUrls.length > 0) params.images = fileUrls
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({
          action: 'send_qzone_msg',
          sceneKey: context.sceneKey,
          content,
          audience,
          images: snapshots.map(snapshot => snapshot.sha256),
        }))
        .digest('hex')
      return await context.ledger.run({
        actionId,
        fingerprint,
        action: 'send_qzone_msg',
        sceneKey: context.sceneKey,
        target: null,
        execute: async () => {
          const data = await nativeCall(params)
          try {
            await authorize(context, 'send_qzone_msg', null, true)
          } catch {
            throw qzoneError('QQ_QZONE_UNKNOWN')
          }
          const tid = projectId(data?.tid)
          if (tid === null) throw qzoneError('QQ_QZONE_UNKNOWN')
          return { status: 'ok', tid, imageCount: fileUrls.length }
        },
      })
    } finally {
      for (const snapshot of snapshots) await snapshot.cleanup()
    }
  }

  return Object.freeze({
    async listOwnPosts(context, { cursor, limit = 20 } = {}) {
      return readPosts(context, ACTIONS.ownPosts, {
        ...(typeof cursor === 'string' && cursor ? { cursor } : {}),
        num: Math.min(Math.max(Number(limit) || 20, 1), 100),
        max_pages: 15,
        include_image_data: false,
      }, true)
    },

    async listFriendFeeds(context, { cursor, limit = 20 } = {}) {
      return readPosts(context, ACTIONS.friendFeeds, {
        ...(typeof cursor === 'string' && cursor ? { cursor } : {}),
        num: Math.min(Math.max(Number(limit) || 20, 1), 100),
        fast_mode: 1,
        include_image_data: false,
      }, false)
    },

    async listComments(context, { tid, limit = 20 } = {}) {
      const post = targetPost(context, tid)
      await authorize(context, ACTIONS.comments, { tid: post.tid }, false)
      const data = await call(ACTIONS.comments, {
        tid: post.tid,
        ...(post.authorUin ? { user_id: post.authorUin } : {}),
        num: Math.min(Math.max(Number(limit) || 20, 1), 100),
        pos: 0,
      }, false)
      await authorize(context, ACTIONS.comments, { tid: post.tid }, false)
      const comments = arrayFrom(data).map(raw => projectComment(raw, post.tid)).filter(Boolean)
      const state = sceneState(context.sceneKey)
      for (const comment of comments) rememberComment(state, `${post.tid}:${comment.commentId}`, comment)
      return { comments }
    },

    async publishText(context, { text, actionId, audience }) {
      if (nativeTransport) return publishNative(context, { text, images: [], actionId, audience })
      return write(context, ACTIONS.publishText, null, {
        message: [{ type: 'text', data: { text: textField(text) } }],
      }, actionId)
    },

    async publishMedia(context, { text, images, actionId, audience } = {}) {
      if (!nativeTransport) throw qzoneError('QQ_QZONE_MEDIA_UNSUPPORTED')
      return publishNative(context, { text, images, actionId, audience })
    },

    async likePost(context, { tid, actionId }) {
      const post = targetPost(context, tid)
      return write(context, ACTIONS.like, { tid: post.tid }, {
        tid: post.tid,
        ...(post.authorUin ? { user_id: post.authorUin } : {}),
      }, actionId)
    },

    async unlikePost(context, { tid, actionId }) {
      const post = targetPost(context, tid)
      return write(context, ACTIONS.unlike, { tid: post.tid }, {
        tid: post.tid,
        ...(post.authorUin ? { user_id: post.authorUin } : {}),
      }, actionId)
    },

    async commentPost(context, { tid, text, actionId }) {
      const post = targetPost(context, tid)
      return write(context, ACTIONS.comment, { tid: post.tid }, {
        target_uin: post.authorUin,
        target_tid: post.tid,
        content: textField(text),
      }, actionId)
    },

    async replyComment(context, { tid, commentId, text, actionId }) {
      const { post, comment } = targetComment(context, tid, commentId)
      return write(context, ACTIONS.comment, {
        tid: post.tid,
        commentId: comment.commentId,
      }, {
        target_uin: post.authorUin,
        target_tid: post.tid,
        content: textField(text),
        reply_comment_id: comment.commentId,
        ...(comment.authorUin ? { reply_uin: comment.authorUin } : {}),
      }, actionId)
    },

    async forwardPost(context, { tid, text = '', actionId }) {
      const post = targetPost(context, tid)
      return write(context, ACTIONS.forward, { tid: post.tid }, {
        user_id: post.authorUin,
        tid: post.tid,
        content: textField(text, MAX_TEXT),
      }, actionId)
    },

    async deleteOwnPost(context, { tid, actionId }) {
      const post = targetPost(context, tid)
      if (!post.isSelf) throw qzoneError('QQ_QZONE_TARGET_NOT_OWNED')
      return write(context, ACTIONS.deleteOwn, { tid: post.tid }, { message_id: post.tid }, actionId)
    },

    close() {
      closed = true
      observations.clear()
    },
  })
}
