import { normalizeId, normalizeMessageId } from './storage.js'
import { NAPCAT_ACTION_NAMES } from './napcat-action-names.js'

const BLOCKED = new Set([
  'get_cookies', 'get_csrf_token', 'get_credentials', 'get_clientkey',
  'send_packet', 'set_group_leave', 'bot_exit', 'set_restart', 'clean_cache',
  'nc_get_rkey', 'get_rkey', 'get_rkey_server', 'nc_get_packet_status',
  'unknown', '.handle_quick_operation',
])

const EMPTY = Object.freeze({ type: 'object', additionalProperties: false, properties: {} })
const OBJECT = Object.freeze({ type: 'object', additionalProperties: true })
const MAX_RESULT_CHARS = 64_000

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
    execute: (_args, _scene) => ({}) }],
  ['qq.get_version_info', { action: 'get_version_info', category: 'profile', description: 'Read OneBot implementation and protocol version.', parameters: EMPTY,
    execute: (_args, _scene) => ({}) }],
  ['qq.get_group_info', { action: 'get_group_info', category: 'group', description: 'Read information for this Session’s group only.', parameters: EMPTY,
    execute: (_args, scene) => { if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY'); return { group_id: scene.peerId } } }],
  ['qq.get_group_member_info', { action: 'get_group_member_info', category: 'group', description: 'Read one stable member ID in this Session’s group.',
    parameters: { type: 'object', additionalProperties: false, properties: { userId: { type: 'string' } }, required: ['userId'] },
    execute: (args, scene) => { if (scene.kind !== 'group') throw new Error('QQ_GROUP_ONLY'); return { group_id: scene.peerId, user_id: normalizeId(args.userId, 'userId') } } }],
  ['qq.get_group_member_list', { action: 'get_group_member_list', category: 'group', description: 'Read a bounded list of members from this Session’s group.', parameters: EMPTY,
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
    execute: () => ({}) }],
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
      accountPermission: 'configured-bot', scenePermission: 'bound-scene', risk: definition.risk ?? 'low',
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
    validateArgs(args, definition.parameters)
    if (this.transport.status !== 'connected') throw new Error('QQ_TRANSPORT_UNAVAILABLE')
    const params = definition.execute(args, scene, { store: this.store })
    const data = await this.transport.action(definition.action, params)
    const result = id === 'qq.get_group_member_list' && Array.isArray(data)
      ? { items: data.slice(0, 200), total: data.length, partial: data.length > 200 }
      : { data }
    if (JSON.stringify(result).length > MAX_RESULT_CHARS) throw new Error('QQ_CAPABILITY_RESULT_TOO_LARGE')
    return result
  }
}
