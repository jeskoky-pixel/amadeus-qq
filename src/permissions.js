// Capability decisions for a trusted QQ Scene. The caller must obtain Scene
// identity from the platform adapter/Session binding, never from model args.

export const MODE_IDS = Object.freeze([
  'observe', 'safe-chat', 'enhanced', 'autonomous-social', 'owner-agent',
])

const MODE_TO_CAPABILITIES = Object.freeze({
  observe: ['qq.read'],
  'safe-chat': ['qq.read', 'qq.send', 'dsh.search'],
  enhanced: ['qq.read', 'qq.send', 'dsh.search', 'qq.media.read'],
  'autonomous-social': ['qq.read', 'qq.send', 'dsh.search', 'qq.media.read', 'qq.qzone.publish'],
  'owner-agent': ['qq.read', 'qq.send', 'dsh.search', 'qq.media.read', 'qq.qzone.publish', 'dsh.shell'],
})

/**
 * Capability catalog shared by the decision engine and the management API.
 * `implemented` means this plugin has a real execution path today; false marks
 * decision-only capabilities that must never be presented as usable.
 */
export const CAPABILITY_CATALOG = Object.freeze([
  Object.freeze({ id: 'qq.read', implemented: true }),
  Object.freeze({ id: 'qq.send', implemented: true }),
  Object.freeze({ id: 'dsh.search', implemented: true }),
  Object.freeze({ id: 'qq.friends.read', implemented: true }),
  Object.freeze({ id: 'qq.groups.read', implemented: true }),
  Object.freeze({ id: 'qq.media.read', implemented: true }),
  Object.freeze({ id: 'qq.qzone.publish', implemented: false }),
  Object.freeze({ id: 'dsh.shell', implemented: false }),
])
const KNOWN_CAPABILITIES = new Set(CAPABILITY_CATALOG.map(item => item.id))
const DIRECTORY_CAPABILITIES = new Set(['qq.friends.read', 'qq.groups.read'])
const OVERRIDE_VALUES = new Set(['inherit', 'allow', 'deny'])
const ID_PATTERN = /^[1-9]\d{0,19}$/

function validMode(mode) { return MODE_IDS.includes(mode) }

export function validateScenePermissions(access, { requireRevision = false, allowRevision = true } = {}) {
  if (!access || typeof access !== 'object' || Array.isArray(access)) throw new TypeError('Scene permissions must be an object')
  const keys = new Set(allowRevision ? ['mode', 'overrides', 'revision'] : ['mode', 'overrides'])
  for (const key of Object.keys(access)) if (!keys.has(key)) throw new TypeError(`Unknown Scene permission field: ${key}`)
  if (!validMode(access.mode)) throw new TypeError('Invalid Scene permission mode')
  const overrides = access.overrides ?? {}
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Scene permission overrides must be an object')
  for (const [capability, value] of Object.entries(overrides)) {
    if (!KNOWN_CAPABILITIES.has(capability) || !OVERRIDE_VALUES.has(value)) {
      throw new TypeError(`Invalid Scene capability override: ${capability}`)
    }
  }
  if ((requireRevision || access.revision !== undefined) && (!Number.isSafeInteger(access.revision) || access.revision < 1)) {
    throw new TypeError('Invalid Scene permission revision')
  }
  return { mode: access.mode, overrides: { ...overrides } }
}

function idSet(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`)
  const result = new Set()
  for (const value of values) {
    const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError(`${label} contains an invalid platform ID`)
    result.add(id)
  }
  return result
}

function stringSet(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`)
  const result = new Set(values)
  for (const value of result) if (!KNOWN_CAPABILITIES.has(value)) throw new TypeError(`${label} contains an unknown capability`)
  return result
}

function accountCanPublish(grants, botId) {
  const account = grants?.byBotId?.[botId]
  return account?.qzonePublish === true
}

export class PermissionEngine {
  constructor(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Permission policy must be an object')
    this.defaultMode = raw.defaultMode ?? 'safe-chat'
    this.groupDefaultMode = raw.groupDefaultMode ?? this.defaultMode
    this.privateDefaultMode = raw.privateDefaultMode ?? this.defaultMode
    for (const mode of [this.defaultMode, this.groupDefaultMode, this.privateDefaultMode]) {
      if (!validMode(mode)) throw new TypeError('Invalid default permission mode')
    }
    // A group is never an Owner Agent Scene, even by default. Reject at
    // construction so a GUI cannot inherit and display that configuration.
    if (this.groupDefaultMode === 'owner-agent') {
      throw new TypeError('groupDefaultMode cannot be owner-agent: groups cannot be Owner Agent Scenes')
    }
    this.ownerPrivateIds = idSet(raw.ownerPrivateIds ?? [], 'ownerPrivateIds')
    this.ownerTools = stringSet(raw.ownerTools ?? [], 'ownerTools')
    this.globalDeny = stringSet(raw.globalDeny ?? [], 'globalDeny')
    this.accountGrants = raw.accountGrants ?? {}
    if (!this.accountGrants || typeof this.accountGrants !== 'object' || Array.isArray(this.accountGrants)) {
      throw new TypeError('accountGrants must be an object')
    }
  }

  evaluate(scene, access, capability) {
    if (!KNOWN_CAPABILITIES.has(capability)) return { allowed: false, mode: null, reason: 'unknown-capability' }
    if (!scene || !['group', 'private'].includes(scene.kind) ||
      typeof scene.botId !== 'string' || !ID_PATTERN.test(scene.botId) ||
      typeof scene.peerId !== 'string' || !ID_PATTERN.test(scene.peerId)) {
      return { allowed: false, mode: null, reason: 'invalid-scene' }
    }
    let normalized
    try {
      normalized = access == null ? null : validateScenePermissions(access)
    } catch {
      return { allowed: false, mode: null, reason: 'invalid-scene-access' }
    }
    const mode = normalized?.mode ?? (scene.kind === 'group' ? this.groupDefaultMode : this.privateDefaultMode)
    const decision = (allowed, reason) => ({ allowed, mode, reason })
    if (this.globalDeny.has(capability)) return decision(false, 'global-deny')
    const owner = scene.kind === 'private' && this.ownerPrivateIds.has(scene.peerId)
    if (mode === 'owner-agent' && !owner) return decision(false, 'owner-private-required')
    const override = normalized?.overrides?.[capability] ?? 'inherit'
    if (DIRECTORY_CAPABILITIES.has(capability)) {
      // Account-wide directories are never inherited from the Owner mode and
      // never granted by a non-owner Scene; each call needs an explicit allow on
      // a verified owner private Scene in owner-agent mode.
      if (!owner || mode !== 'owner-agent' || override !== 'allow') {
        return decision(false, 'owner-directory-required')
      }
      return decision(true, 'scene-allow')
    }
    if (capability === 'dsh.shell' && (!owner || mode !== 'owner-agent' || !this.ownerTools.has(capability))) {
      return decision(false, 'owner-tool-required')
    }
    if (capability === 'qq.qzone.publish' && !accountCanPublish(this.accountGrants, scene.botId)) {
      return decision(false, 'account-publish-required')
    }
    if (override === 'deny') return decision(false, 'scene-deny')
    if (override === 'allow') return decision(true, 'scene-allow')
    return decision(MODE_TO_CAPABILITIES[mode].includes(capability), 'mode')
  }
}
