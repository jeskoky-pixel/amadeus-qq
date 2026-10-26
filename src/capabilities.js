import { createHash } from 'node:crypto'
import { normalizeId, normalizeMessageId, sceneKey } from './storage.js'
import { sanitizeInboundSegments } from './onebot.js'
import { NAPCAT_ACTION_NAMES } from './napcat-action-names.js'

const BLOCKED = new Set([
  'get_cookies', 'get_csrf_token', 'get_credentials', 'get_clientkey',
  'send_packet', 'set_group_leave', 'bot_exit', 'set_restart', 'clean_cache',
  'nc_get_rkey', 'get_rkey', 'get_rkey_server', 'nc_get_packet_status',
  'unknown', '.handle_quick_operation',
])

const EMPTY = Object.freeze({ type: 'object', additionalProperties: false, properties: {} })
const OBJECT = Object.freeze({ type: 'object', additionalProperties: true })
const PAGING = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: [],
})
const MAX_RESULT_CHARS = 64_000
const MAX_GROUP_READ_RESPONSE_BYTES = 128 * 1024
const ACTION_ID = Object.freeze({ type: 'string' })

function writeParameters(properties, required = []) {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({ actionId: ACTION_ID, ...properties }),
    required: Object.freeze(['actionId', ...required]),
  })
}
const DEFAULT_PAGE_LIMIT = 50

function parsePaging(args) {
  const offset = args.offset === undefined ? 0 : args.offset
  const limit = args.limit === undefined ? DEFAULT_PAGE_LIMIT : args.limit
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative safe integer')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100')
  return { offset, limit }
}

function pageDirectory(data, paging, projectItem) {
  if (!Array.isArray(data) || typeof projectItem !== 'function') throw new Error('QQ_CAPABILITY_INVALID_RESPONSE')
  const items = data.slice(paging.offset, paging.offset + paging.limit).map(projectItem)
  return { items, total: data.length, partial: paging.offset + items.length < data.length }
}

function invalidResponse() {
  return new Error('QQ_CAPABILITY_INVALID_RESPONSE')
}

function projectionObject(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse()
  return data
}

function projectId(value) {
  try { return normalizeId(value, 'id') } catch { throw invalidResponse() }
}

function projectString(value, max = 100) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

function projectCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function requireSameId(actual, expected) {
  if (typeof expected !== 'string' || actual !== expected) throw new Error('QQ_CAPABILITY_SCOPE_MISMATCH')
}

function finishProjection(projected, data) {
  if (Object.keys(projected).length === 0 && typeof data.ok === 'boolean') projected.ok = data.ok
  return projected
}

function projectStatus(data) {
  const source = projectionObject(data)
  const projected = {}
  if (typeof source.online === 'boolean') projected.online = source.online
  if (typeof source.good === 'boolean') projected.good = source.good
  return finishProjection(projected, source)
}

function projectVersion(data) {
  const source = projectionObject(data)
  const projected = {}
  for (const key of ['app_name', 'app_version', 'protocol_version']) {
    const value = projectString(source[key], 64)
    if (value !== undefined) projected[key] = value
  }
  return finishProjection(projected, source)
}

function projectGroupInfo(data, expected) {
  const source = projectionObject(data)
  const projected = { group_id: projectId(source.group_id) }
  requireSameId(projected.group_id, expected?.group_id)
  const name = projectString(source.group_name)
  if (name !== undefined) projected.group_name = name
  const members = projectCount(source.member_count)
  if (members !== undefined) projected.member_count = members
  const maxMembers = projectCount(source.max_member_count)
  if (maxMembers !== undefined) projected.max_member_count = maxMembers
  return finishProjection(projected, source)
}

function projectMemberInfo(data, expected) {
  const source = projectionObject(data)
  const projected = {
    group_id: projectId(source.group_id),
    user_id: projectId(source.user_id),
  }
  requireSameId(projected.group_id, expected?.group_id)
  requireSameId(projected.user_id, expected?.user_id)
  const nickname = projectString(source.nickname)
  if (nickname !== undefined) projected.nickname = nickname
  const card = projectString(source.card)
  if (card !== undefined) projected.card = card
  const role = projectString(source.role, 32)
  if (role !== undefined) projected.role = role
  return finishProjection(projected, source)
}

function projectMember(data) {
  const source = projectionObject(data)
  const projected = { user_id: projectId(source.user_id) }
  const nickname = projectString(source.nickname)
  if (nickname !== undefined) projected.nickname = nickname
  const card = projectString(source.card)
  if (card !== undefined) projected.card = card
  const role = projectString(source.role, 32)
  if (role !== undefined) projected.role = role
  return finishProjection(projected, source)
}

function projectStranger(data, expected) {
  const source = projectionObject(data)
  const projected = { user_id: projectId(source.user_id) }
  requireSameId(projected.user_id, expected?.user_id)
  const nickname = projectString(source.nickname)
  if (nickname !== undefined) projected.nickname = nickname
  const sex = projectString(source.sex, 16)
  if (sex !== undefined) projected.sex = sex
  return finishProjection(projected, source)
}

function projectLogin(data, expected) {
  const source = projectionObject(data)
  const projected = { user_id: projectId(source.user_id) }
  requireSameId(projected.user_id, expected?.botId)
  const nickname = projectString(source.nickname)
  if (nickname !== undefined) projected.nickname = nickname
  return finishProjection(projected, source)
}

function projectFriend(data) {
  const source = projectionObject(data)
  const projected = { user_id: projectId(source.user_id) }
  const nickname = projectString(source.nickname)
  if (nickname !== undefined) projected.nickname = nickname
  const remark = projectString(source.remark)
  if (remark !== undefined) projected.remark = remark
  return finishProjection(projected, source)
}

function projectGroup(data) {
  const source = projectionObject(data)
  const projected = { group_id: projectId(source.group_id) }
  const name = projectString(source.group_name)
  if (name !== undefined) projected.group_name = name
  const members = projectCount(source.member_count)
  if (members !== undefined) projected.member_count = members
  const maxMembers = projectCount(source.max_member_count)
  if (maxMembers !== undefined) projected.max_member_count = maxMembers
  return finishProjection(projected, source)
}

function projectSegments(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw invalidResponse()
  try { return sanitizeInboundSegments(value.slice(0, 20)) } catch { throw invalidResponse() }
}

function projectEssenceItem(data) {
  const source = projectionObject(data)
  const projected = {
    message_id: projectId(source.message_id),
    sender_id: projectId(source.sender_id),
  }
  for (const key of ['msg_seq', 'msg_random', 'operator_time']) {
    if (Number.isSafeInteger(source[key])) projected[key] = source[key]
  }
  const senderNick = projectString(source.sender_nick)
  if (senderNick !== undefined) projected.sender_nick = senderNick
  if (source.operator_id !== undefined) projected.operator_id = projectId(source.operator_id)
  const operatorNick = projectString(source.operator_nick)
  if (operatorNick !== undefined) projected.operator_nick = operatorNick
  const content = projectSegments(source.content)
  if (content !== undefined) projected.content = content
  return projected
}

function projectHonorMember(data) {
  const source = projectionObject(data)
  const projected = { user_id: projectId(source.user_id) }
  const nickname = projectString(source.nickname)
  if (nickname !== undefined) projected.nickname = nickname
  const description = projectString(source.description)
  if (description !== undefined) projected.description = description
  return projected
}

function projectHonorList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidResponse()
  return value.slice(0, 50).map(projectHonorMember)
}

function projectHonor(data, expected) {
  const source = projectionObject(data)
  const projected = { group_id: projectId(source.group_id) }
  requireSameId(projected.group_id, expected?.group_id)
  if (source.current_talkative !== undefined && source.current_talkative !== null) {
    if (typeof source.current_talkative !== 'object' || Array.isArray(source.current_talkative)) throw invalidResponse()
    if (Object.keys(source.current_talkative).length > 0) {
      projected.current_talkative = projectHonorMember(source.current_talkative)
    }
  }
  for (const key of ['talkative_list', 'performer_list', 'legend_list', 'emotion_list', 'strong_newbie_list']) {
    projected[key] = projectHonorList(source[key])
  }
  return projected
}

function projectNoticeItem(data) {
  const source = projectionObject(data)
  const projected = {}
  const noticeId = projectString(source.notice_id, 100)
  if (noticeId !== undefined) projected.notice_id = noticeId
  if (source.sender_id !== undefined) projected.sender_id = projectId(source.sender_id)
  if (Number.isSafeInteger(source.publish_time)) projected.publish_time = source.publish_time
  if (typeof source.read_num === 'number' && Number.isSafeInteger(source.read_num) && source.read_num >= 0) {
    projected.read_num = source.read_num
  }
  if (typeof source.send_to_new_member === 'boolean') projected.send_to_new_member = source.send_to_new_member
  if (typeof source.pinned === 'boolean') projected.pinned = source.pinned
  if (source.message !== null && typeof source.message === 'object' && !Array.isArray(source.message)) {
    const text = projectString(source.message.text, 500)
    if (text !== undefined) projected.text = text
  }
  return projected
}

function pageNotices(data) {
  if (!Array.isArray(data)) throw invalidResponse()
  const items = data.slice(0, 50).map(projectNoticeItem)
  return { items, total: data.length, partial: data.length > 50 }
}

function requireObservedMessage(store, scene, rawId) {
  let id
  try { id = normalizeMessageId(rawId, 'messageId') } catch { throw invalidResponse() }
  const row = store.getScene(scene)
  if (!row?.messages?.some(message => message.messageId === id)) throw new Error('QQ_MESSAGE_SCOPE')
  return id
}

function requireStableUserId(rawId) {
  try { return normalizeId(rawId, 'userId') } catch { throw new TypeError('invalid userId') }
}

/**
 * `get_msg` is the only capability that returns a platform message body. Build
 * an explicit whitelist so `raw_message`, CQ strings, media URLs/paths and
 * arbitrary platform fields never reach model context.
 */
function projectPlatformMessage(data, expected) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('QQ_CAPABILITY_INVALID_RESPONSE')
  const hasBody = data.message !== undefined || data.raw_message !== undefined
  if (!hasBody) {
    // Preserve the legacy boolean probe only. A bodyless response without an
    // explicit status cannot be tied to the requested message.
    if (typeof data.ok !== 'boolean') throw new Error('QQ_CAPABILITY_INVALID_RESPONSE')
    return { data: { ok: data.ok } }
  }

  let messageId
  try { messageId = normalizeMessageId(data.message_id, 'get_msg.message_id') } catch { throw new Error('QQ_CAPABILITY_INVALID_RESPONSE') }
  if (messageId !== expected?.messageId) throw new Error('QQ_CAPABILITY_SCOPE_MISMATCH')

  if (data.message_type !== undefined) {
    if (data.message_type !== expected.scene.kind) throw new Error('QQ_CAPABILITY_SCOPE_MISMATCH')
  }
  if (data.group_id !== undefined) {
    if (expected.scene.kind !== 'group') throw new Error('QQ_CAPABILITY_SCOPE_MISMATCH')
    let groupId
    try { groupId = normalizeId(data.group_id, 'get_msg.group_id') } catch { throw new Error('QQ_CAPABILITY_INVALID_RESPONSE') }
    if (groupId !== expected.scene.peerId) throw new Error('QQ_CAPABILITY_SCOPE_MISMATCH')
  }
  if (data.sender !== null && typeof data.sender === 'object' && !Array.isArray(data.sender) &&
    data.sender.user_id !== undefined) {
    let senderId
    try { senderId = normalizeId(data.sender.user_id, 'get_msg.sender.user_id') } catch { throw new Error('QQ_CAPABILITY_INVALID_RESPONSE') }
    if (typeof expected.senderId !== 'string' || senderId !== expected.senderId) {
      throw new Error('QQ_CAPABILITY_SCOPE_MISMATCH')
    }
  }

  const projected = { message_id: messageId }
  if (Number.isFinite(data.time)) projected.time = data.time
  if (data.sender !== null && typeof data.sender === 'object' && !Array.isArray(data.sender)) {
    const sender = {}
    if (data.sender.user_id !== undefined) {
      // Already validated above for a body response.
      sender.user_id = normalizeId(data.sender.user_id, 'get_msg.sender.user_id')
    }
    if (typeof data.sender.nickname === 'string') sender.nickname = data.sender.nickname.slice(0, 100)
    if (typeof data.sender.card === 'string') sender.card = data.sender.card.slice(0, 100)
    if (Object.keys(sender).length) projected.sender = sender
  }
  if (Array.isArray(data.message)) projected.message = sanitizeInboundSegments(data.message)
  else if (typeof data.message === 'string') {
    projected.message = sanitizeInboundSegments([{ type: 'text', data: { text: data.message } }])
  }
  // Some OneBot implementations answer a probe with a bare boolean status.
  // Retain that boolean only; every other unlisted field is discarded.
  if (typeof data.ok === 'boolean') projected.ok = data.ok
  return { data: projected }
}

function category(action) {
  if (/qzone/.test(action)) return 'qzone'
  if (/avatar|longnick|online_status|qq_profile|status|login_info/.test(action)) return 'profile'
  if (/record|ptt|voice|ai_record/.test(action)) return 'voice'
  if (/image|face|emoji|ocr|album/.test(action)) return 'image'
  if (/video/.test(action)) return 'video'
  if (/file|folder|fileset|flash/.test(action)) return 'file'
  if (/group|guild/.test(action)) return 'group'
  if (/friend|stranger|like|poke/.test(action)) return 'social'
  return 'message'
}

function risk(action) {
  if (BLOCKED.has(action)) return 'prohibited'
  if (/^(delete|del|set_group_kick|set_group_ban|send_packet)/.test(action)) return 'high'
  if (/^(set|send|upload|create|move|rename|forward|friend_poke|group_poke)/.test(action)) return 'medium'
  return 'low'
}

const EXECUTABLE = new Map([
  ['qq.get_status', { action: 'get_status', category: 'profile', description: 'Read account connection status.', parameters: EMPTY,
    project: projectStatus,
    execute: (_args, _scene) => ({}) }],
  ['qq.get_version_info', { action: 'get_version_info', category: 'profile', description: 'Read OneBot implementation and protocol version.', parameters: EMPTY,
    project: projectVersion,
    execute: (_args, _scene) => ({}) }],
  ['qq.get_group_info', { action: 'get_group_info', category: 'group', description: 'Read information for this Session’s group only.', parameters: EMPTY,
    project: projectGroupInfo,
    execute: (_args, scene) => { if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY'); return { group_id: scene.peerId } } }],
  ['qq.get_group_member_info', { action: 'get_group_member_info', category: 'group', description: 'Read one stable member ID in this Session’s group.',
    parameters: { type: 'object', additionalProperties: false, properties: { userId: { type: 'string' } }, required: ['userId'] },
    project: projectMemberInfo,
    execute: (args, scene) => { if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY'); return { group_id: scene.peerId, user_id: normalizeId(args.userId, 'userId') } } }],
  ['qq.get_group_member_list', { action: 'get_group_member_list', category: 'group', description: 'Read a bounded list of members from this Session’s group.', parameters: EMPTY,
    projectItem: projectMember,
    execute: (_args, scene) => { if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY'); return { group_id: scene.peerId } } }],
  ['qq.get_msg', { action: 'get_msg', category: category('get_msg'), risk: risk('get_msg'),
    description: 'Read one message that already exists in this Session’s durable QQ inbox.',
    parameters: { type: 'object', additionalProperties: false, properties: { messageId: { type: 'string' } }, required: ['messageId'] },
    execute: (args, scene, { store }) => {
      const messageId = normalizeMessageId(args.messageId, 'messageId')
      const row = store.getScene(scene)
      if (!row?.messages.some(message => message.messageId === messageId)) throw new Error('QQ_MESSAGE_SCOPE')
      return { message_id: messageId }
    } }],
  ['qq.get_stranger_info', { action: 'get_stranger_info', category: category('get_stranger_info'), risk: risk('get_stranger_info'),
    description: 'Read a stable QQ user ID already observed in this Session’s bound Scene.',
    parameters: { type: 'object', additionalProperties: false, properties: { userId: { type: 'string' } }, required: ['userId'] },
    project: projectStranger,
    execute: (args, scene, { store }) => {
      const userId = normalizeId(args.userId, 'userId')
      const observed = scene.kind === 'private'
        ? userId === scene.peerId
        : (store.getScene(scene)?.messages.some(message => message.senderId === userId) ?? false)
      if (!observed) throw new Error('QQ_PERSON_SCOPE')
      return { user_id: userId }
    } }],
  ['qq.get_login_info', { action: 'get_login_info', category: category('get_login_info'), risk: risk('get_login_info'),
    description: 'Read the logged-in QQ account summary. This capability accepts no target or scene arguments.',
    parameters: EMPTY,
    project: projectLogin,
    execute: () => ({}) }],
  ['qq.get_friend_list', { action: 'get_friend_list', category: category('get_friend_list'), risk: 'medium',
    scenePermission: 'owner-private-explicit',
    requiredCapability: 'qq.friends.read',
    description: 'Read a bounded page of the account friend directory; requires an explicit owner private grant.',
    parameters: PAGING,
    projectItem: projectFriend,
    execute: () => ({}) }],
  ['qq.get_group_list', { action: 'get_group_list', category: category('get_group_list'), risk: 'medium',
    scenePermission: 'owner-private-explicit',
    requiredCapability: 'qq.groups.read',
    description: 'Read a bounded page of the account group directory; requires an explicit owner private grant.',
    parameters: PAGING,
    projectItem: projectGroup,
    execute: () => ({}) }],
  ['qq.get_essence_msg_list', { action: 'get_essence_msg_list', category: 'group', risk: 'low',
    description: 'Read a bounded page of this Session’s group essence messages.',
    parameters: PAGING,
    projectItem: projectEssenceItem,
    precheckRaw: true,
    execute: (_args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      return { group_id: scene.peerId }
    } }],
  ['qq.get_group_honor_info', { action: 'get_group_honor_info', category: 'group', risk: 'low',
    description: 'Read this Session’s group honor summary and bounded member lists.',
    parameters: EMPTY,
    project: projectHonor,
    precheckRaw: true,
    execute: (_args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      return { group_id: scene.peerId, type: 'all' }
    } }],
  ['qq.get_group_notice', { action: '_get_group_notice', category: 'group', risk: 'low',
    description: 'Read this Session’s group notices without retaining images or platform URLs.',
    parameters: EMPTY,
    project: pageNotices,
    precheckRaw: true,
    execute: (_args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      return { group_id: scene.peerId }
    } }],
  ['qq.set_msg_emoji_like', { action: 'set_msg_emoji_like', category: 'message', risk: 'medium',
    write: true, requiredCapability: 'qq.reaction.write',
    description: 'Set one emoji reaction on a message observed in this bound Scene.',
    parameters: writeParameters({
      messageId: { type: 'string' },
      emojiId: { type: 'string' },
    }, ['messageId', 'emojiId']),
    execute: (args, scene, { store }) => {
      if (!/^[1-9]\d{0,11}$/.test(args.emojiId)) throw new TypeError('invalid emojiId')
      return { message_id: requireObservedMessage(store, scene, args.messageId), emoji_id: args.emojiId, set: true }
    } }],
  ['qq.send_poke', { action: 'send_poke', category: 'social', risk: 'medium',
    write: true, requiredCapability: 'qq.poke',
    description: 'Poke one user already observed in this bound Scene.',
    parameters: writeParameters({ userId: { type: 'string' } }, ['userId']),
    execute: (args, scene, { store }) => {
      const userId = projectId(args.userId)
      const observed = scene.kind === 'private'
        ? userId === scene.peerId
        : store.getScene(scene)?.messages?.some(message => message.senderId === userId)
      if (!observed) throw new Error('QQ_PERSON_SCOPE')
      return scene.kind === 'group'
        ? { group_id: scene.peerId, user_id: userId, target_id: userId }
        : { user_id: userId, target_id: userId }
    } }],
  ['qq.delete_msg', { action: 'delete_msg', category: 'message', risk: 'medium',
    write: true, requiredCapability: 'qq.recall',
    description: 'Recall one message this bot delivered in the bound Scene.',
    parameters: writeParameters({ messageId: { type: 'string' } }, ['messageId']),
    execute: (args, scene, { store }) => {
      let messageId
      try { messageId = normalizeMessageId(args.messageId, 'messageId') } catch { throw invalidResponse() }
      const row = store.getScene(scene)
      const own = [...row.deliveries, ...(row.deliveryArchive ?? [])]
        .some(item => item.status === 'delivered' && item.platformMessageId === messageId)
      if (!own) throw new Error('QQ_RECALL_SCOPE')
      return { message_id: messageId }
    } }],
  ['qq.set_essence_msg', { action: 'set_essence_msg', category: 'group', risk: 'medium',
    write: true, requiredCapability: 'qq.group.essence',
    description: 'Mark one observed group message as an essence message.',
    parameters: writeParameters({ messageId: { type: 'string' } }, ['messageId']),
    execute: (args, scene, { store }) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      return { message_id: requireObservedMessage(store, scene, args.messageId) }
    } }],
  ['qq.delete_essence_msg', { action: 'delete_essence_msg', category: 'group', risk: 'medium',
    write: true, requiredCapability: 'qq.group.essence',
    description: 'Remove one observed group message from the essence list.',
    parameters: writeParameters({ messageId: { type: 'string' } }, ['messageId']),
    execute: (args, scene, { store }) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      return { message_id: requireObservedMessage(store, scene, args.messageId) }
    } }],
  ['qq.set_group_card', { action: 'set_group_card', category: 'group', risk: 'medium',
    write: true, requiredCapability: 'qq.group.card',
    description: 'Set this bot’s group card in the bound group only.',
    parameters: writeParameters({ card: { type: 'string' } }, ['card']),
    execute: (args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      if (typeof args.card !== 'string' || args.card.length > 30 || /[\u0000-\u001f\u007f]/.test(args.card)) {
        throw new TypeError('invalid group card')
      }
      return { group_id: scene.peerId, user_id: scene.botId, card: args.card }
    } }],
  ['qq.send_group_notice', { action: '_send_group_notice', category: 'group', risk: 'medium',
    write: true, requiredCapability: 'qq.group.notice',
    description: 'Publish a text-only group notice in the bound group; images and paths are not accepted.',
    parameters: writeParameters({
      content: { type: 'string' },
      pinned: { type: 'boolean' },
    }, ['content']),
    execute: (args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      if (typeof args.content !== 'string' || args.content.trim().length === 0 ||
        args.content.length > 500 || /[\u0000-\u001f\u007f]/.test(args.content)) {
        throw new TypeError('invalid group notice content')
      }
      return {
        group_id: scene.peerId,
        content: args.content,
        pinned: args.pinned === true ? 1 : 0,
        type: 1,
        confirm_required: 1,
        is_show_edit_card: 0,
        tip_window_type: 0,
      }
    } }],
  ['qq.set_group_ban', { action: 'set_group_ban', category: 'group', risk: 'high',
    write: true, requiredCapability: 'qq.group.ban', memberPreflight: true,
    description: 'Mute one observed member in the bound group; duration is seconds (0 unmutes).',
    parameters: writeParameters({
      userId: { type: 'string' },
      duration: { type: 'integer', minimum: 0, maximum: 2592000 },
    }, ['userId', 'duration']),
    execute: (args, scene, { store }) => {
      if (!Number.isSafeInteger(args.duration) || args.duration < 0 || args.duration > 2592000) {
        throw new TypeError('invalid mute duration')
      }
      return { group_id: scene.peerId, user_id: requireStableUserId(args.userId), duration: args.duration }
    } }],
  ['qq.set_group_whole_ban', { action: 'set_group_whole_ban', category: 'group', risk: 'high',
    write: true, requiredCapability: 'qq.group.whole_ban',
    description: 'Enable or disable whole-group mute in the bound group.',
    parameters: writeParameters({ enable: { type: 'boolean' } }, ['enable']),
    execute: (args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      if (typeof args.enable !== 'boolean') throw new TypeError('invalid whole ban flag')
      return { group_id: scene.peerId, enable: args.enable }
    } }],
  ['qq.set_group_kick', { action: 'set_group_kick', category: 'group', risk: 'high',
    write: true, requiredCapability: 'qq.group.kick', memberPreflight: true,
    description: 'Remove one observed member from the bound group; rejectAddRequest is optional.',
    parameters: writeParameters({
      userId: { type: 'string' },
      rejectAddRequest: { type: 'boolean' },
    }, ['userId']),
    execute: (args, scene, { store }) => ({
      group_id: scene.peerId,
      user_id: requireStableUserId(args.userId),
      reject_add_request: args.rejectAddRequest === true,
    }) }],
  ['qq.set_group_name', { action: 'set_group_name', category: 'group', risk: 'high',
    write: true, requiredCapability: 'qq.group.name',
    description: 'Rename the bound group; the model supplies only a bounded plain name.',
    parameters: writeParameters({ name: { type: 'string' } }, ['name']),
    execute: (args, scene) => {
      if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY')
      if (typeof args.name !== 'string' || args.name.trim().length === 0 ||
        args.name.length > 30 || /[\u0000-\u001f\u007f]/.test(args.name)) {
        throw new TypeError('invalid group name')
      }
      return { group_id: scene.peerId, group_name: args.name }
    } }],
  ['qq.set_group_admin', { action: 'set_group_admin', category: 'group', risk: 'high',
    write: true, requiredCapability: 'qq.group.admin', memberPreflight: true,
    description: 'Set or unset administrator role for one observed member in the bound group.',
    parameters: writeParameters({
      userId: { type: 'string' },
      enable: { type: 'boolean' },
    }, ['userId', 'enable']),
    execute: (args, scene, { store }) => {
      if (typeof args.enable !== 'boolean') throw new TypeError('invalid admin flag')
      return { group_id: scene.peerId, user_id: requireStableUserId(args.userId), enable: args.enable }
    } }],
  ['qq.set_group_special_title', { action: 'set_group_special_title', category: 'group', risk: 'medium',
    write: true, requiredCapability: 'qq.group.special_title', memberPreflight: true,
    description: 'Set one observed member’s special title in the bound group.',
    parameters: writeParameters({
      userId: { type: 'string' },
      title: { type: 'string' },
    }, ['userId', 'title']),
    execute: (args, scene, { store }) => {
      if (typeof args.title !== 'string' || args.title.length > 20 || /[\u0000-\u001f\u007f]/.test(args.title)) {
        throw new TypeError('invalid special title')
      }
      return {
        group_id: scene.peerId,
        user_id: requireStableUserId(args.userId),
        special_title: args.title,
      }
    } }],
])

function validateArgs(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('capability arguments must be an object')
  const keys = new Set(Object.keys(schema.properties ?? {}))
  for (const key of Object.keys(args)) if (!keys.has(key)) throw new TypeError(`unexpected capability argument: ${key}`)
  for (const key of schema.required ?? []) if (!(key in args)) throw new TypeError(`missing capability argument: ${key}`)
}

function inventoryDescriptor(action) {
  return {
    id: `napcat.${action}`,
    provider: 'installed-napcat-bundle',
    action,
    category: category(action),
    description: `Installed NapCat action identifier: ${action}`,
    parameters: OBJECT,
    result: OBJECT,
    accountPermission: 'configured-bot',
    scenePermission: 'unverified',
    risk: risk(action),
    status: BLOCKED.has(action) ? 'unsupported' : 'unverified',
    schemaStatus: 'unverified',
    executable: false,
  }
}

export class CapabilityRegistry {
  constructor({ core, store, transport }) {
    this.core = core
    this.store = store
    this.transport = transport
  }

  list() {
    const installed = NAPCAT_ACTION_NAMES.map(inventoryDescriptor)
    const supported = [...EXECUTABLE].map(([id, definition]) => ({
      id, provider: 'onebot-v11', action: definition.action, category: definition.category,
      description: definition.description, parameters: definition.parameters, result: OBJECT,
      accountPermission: 'configured-bot', scenePermission: definition.scenePermission ?? 'bound-scene', risk: definition.risk ?? 'low',
      status: this.transport.status === 'connected' ? 'unverified' : 'unavailable',
      schemaStatus: 'verified-local', executable: true,
    }))
    return [...supported, ...installed]
  }

  search(query = '', { category: categoryFilter, limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 100) throw new TypeError('invalid capability search query')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('invalid capability search limit')
    const needle = query.toLowerCase().trim()
    const matches = this.list().filter(item =>
      (!categoryFilter || item.category === categoryFilter) &&
      (!needle || `${item.id} ${item.description} ${item.category}`.toLowerCase().includes(needle)))
    return { items: matches.slice(0, limit).map(({ parameters, result, ...brief }) => brief), total: matches.length, partial: matches.length > limit }
  }

  describe(id) {
    const found = this.list().find(item => item.id === id)
    if (!found) throw new Error('QQ_CAPABILITY_UNKNOWN')
    return found
  }

  async execute(sessionId, id, args = {}) {
    const scene = this.core.authorizedScene(sessionId)
    const definition = EXECUTABLE.get(id)
    if (!definition) throw new Error('QQ_CAPABILITY_NOT_EXECUTABLE')
    if (definition.write === true) return this.#executeWrite(sessionId, id, definition, args, scene)
    const requiredCapability = definition.requiredCapability ?? 'qq.read'
    if (requiredCapability !== 'qq.read' &&
      this.core.authorizeSessionCapability(sessionId, requiredCapability) !== true) {
      throw new Error(`QQ_PERMISSION_DENIED: ${requiredCapability}`)
    }
    validateArgs(args, definition.parameters)
    const paging = id === 'qq.get_friend_list' || id === 'qq.get_group_list' || id === 'qq.get_essence_msg_list'
      ? parsePaging(args)
      : null
    if (this.transport.status !== 'connected') throw new Error('QQ_TRANSPORT_UNAVAILABLE')
    const params = definition.execute(args, scene, { store: this.store })
    const data = definition.precheckRaw === true
      ? await this.transport.action(definition.action, params, 10_000, MAX_GROUP_READ_RESPONSE_BYTES)
      : await this.transport.action(definition.action, params)
    // Reject an oversized raw platform response before shaping it. This keeps
    // the bounded-result guarantee even when the whitelist would discard it.
    if ((id === 'qq.get_msg' || definition.precheckRaw === true) &&
      (JSON.stringify(data)?.length ?? 0) > MAX_RESULT_CHARS) {
      throw new Error('QQ_CAPABILITY_RESULT_TOO_LARGE')
    }
    // Any Scene read grant may be revoked while the platform call is in flight.
    // Re-check the current binding and capability before shaping model output.
    if (this.core.authorizeSessionCapability(sessionId, requiredCapability) !== true) {
      throw new Error(`QQ_PERMISSION_CHANGED: ${requiredCapability} was revoked during the read`)
    }
    let result
    if (paging) {
      if (typeof definition.projectItem !== 'function') throw new Error('QQ_CAPABILITY_PROJECTION_MISSING')
      result = pageDirectory(data, paging, definition.projectItem)
    } else if (id === 'qq.get_msg') {
      const stored = this.store.getScene(scene)?.messages?.find(message => message.messageId === params.message_id)
      result = projectPlatformMessage(data, {
        messageId: params.message_id,
        scene,
        senderId: stored?.senderId,
      })
    }
    else if (id === 'qq.get_group_member_list') {
      if (!Array.isArray(data) || typeof definition.projectItem !== 'function') throw invalidResponse()
      const items = data.slice(0, 200).map(definition.projectItem)
      result = { items, total: data.length, partial: data.length > 200 }
    } else {
      if (typeof definition.project !== 'function') throw new Error('QQ_CAPABILITY_PROJECTION_MISSING')
      result = { data: definition.project(data, { ...params, botId: scene.botId }) }
    }
    if (JSON.stringify(result).length > MAX_RESULT_CHARS) throw new Error('QQ_CAPABILITY_RESULT_TOO_LARGE')
    return result
  }

  async #executeWrite(sessionId, id, definition, args, scene) {
    const requiredCapability = definition.requiredCapability
    const canWrite = () => this.core.authorizeSessionCapability(sessionId, requiredCapability) === true &&
      this.core.authorizeSessionCapability(sessionId, 'qq.send') === true
    if (!canWrite()) {
      throw new Error(`QQ_PERMISSION_DENIED: ${requiredCapability}`)
    }
    validateArgs(args, definition.parameters)
    if (typeof args.actionId !== 'string' || !/^[\w-]{1,100}$/.test(args.actionId)) {
      throw new TypeError('invalid actionId')
    }
    const actionId = args.actionId
    const payload = { ...args }
    delete payload.actionId
    const params = definition.execute(payload, scene, { store: this.store })
    if (definition.memberPreflight === true) {
      await this.#verifyGroupMember(scene, params.user_id)
      // The membership query is external: revoke after it but before reserve.
      if (!canWrite()) throw new Error(`QQ_PERMISSION_CHANGED: ${requiredCapability}`)
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ kind: 'capability', id, scene: sceneKey(scene), payload }))
      .digest('hex')
    const reserved = this.store.reserveDelivery(scene, actionId, fingerprint)
    if (!reserved.fresh) {
      return { status: reserved.delivery.status, repeated: true }
    }
    const inFlightKey = `${sceneKey(scene)}:${actionId}`
    this.core.inFlightDeliveries.add(inFlightKey)
    try {
      if (!canWrite()) {
        try { this.store.settleDelivery(scene, actionId, 'failed') } catch { /* keep permission failure */ }
        throw new Error(`QQ_PERMISSION_CHANGED: ${requiredCapability}`)
      }
      if (this.transport.status !== 'connected') {
        this.store.settleDelivery(scene, actionId, 'failed')
        throw new Error('QQ_TRANSPORT_UNAVAILABLE')
      }
      try {
        await this.transport.action(definition.action, params)
      } catch (error) {
        const status = error?.code === 'ONEBOT_REJECTED' ? 'failed' : 'unknown'
        this.store.settleDelivery(scene, actionId, status)
        return {
          status,
          repeated: false,
          code: status === 'failed' ? 'ONEBOT_REJECTED' : 'QQ_DELIVERY_UNKNOWN',
        }
      }
      this.store.settleDelivery(scene, actionId, 'delivered')
      return { status: 'delivered', repeated: false }
    } finally {
      this.core.inFlightDeliveries.delete(inFlightKey)
    }
  }

  async #verifyGroupMember(scene, userId) {
    const row = this.store.getScene(scene)
    if (row?.messages?.some(message => message.senderId === userId)) return
    const data = await this.transport.action(
      'get_group_member_info',
      { group_id: scene.peerId, user_id: userId },
      10_000,
      MAX_GROUP_READ_RESPONSE_BYTES,
    )
    projectMemberInfo(data, { group_id: scene.peerId, user_id: userId })
  }
}
