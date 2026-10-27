// QQ platform operation contract and Agent-preset guard.
//
// This module is mounted by the package's preset.patch.yml, never by the QQ
// connector row. A persisted QQ Session therefore keeps the boundary while the
// connector is disabled, restarting, or temporarily uninstalled. The execution
// guard is the hard boundary; the visible-schema restriction is retried as the
// connector registers its tools.
//
// DSH's tools.restrict() synchronously emits tools/change on apply AND dispose.
// Every visibility mutation below is therefore idempotent, marks pending state
// before mutating, and is re-entrancy guarded; otherwise the echo can recurse
// during Host activation and stall startup.

import {
  OWNER_WORKSPACE_CAPABILITY,
  OWNER_WORKSPACE_TOOL,
  setProviderStatus,
} from './owner-workspace.js'

export const name = 'amadeus-qq-preset-guard'
export const inject = ['tools']

/** Preset tool ceilings; current Scene grants are checked again at execution. */
export const QQ_PERMISSION_LEVELS = Object.freeze([
  Object.freeze({ level: 0, id: 'observe', description: 'Read inbox and connection state; no external writes.' }),
  Object.freeze({ level: 1, id: 'safe-chat', description: 'Continuous conversation and authorized QQ sends.' }),
  Object.freeze({ level: 2, id: 'enhanced', description: 'Authorized media reads and sends.' }),
  Object.freeze({ level: 3, id: 'autonomous-social', description: 'Authorized QZone operations; account grants still apply.' }),
  Object.freeze({ level: 4, id: 'owner-agent', description: 'Verified Owner private Scene tools; general Shell remains unavailable.' }),
])

export const MAX_QQ_PERMISSION_LEVEL = QQ_PERMISSION_LEVELS.length - 1
export const DEFAULT_QQ_PERMISSION_LEVEL = 1

/** Official DSH standard tools exposed only by the level-4 Owner preset. */
export const OWNER_NATIVE_TOOLS = Object.freeze([
  'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch', 'present',
])

/**
 * The only Memory tools a non-Owner QQ preset may call. All three are
 * read-only and are the Memory tools whose result set is filtered by the
 * trusted-Scene ACL on the Memory server; `scenes` on search/list is only a
 * narrowing selector over what that server already allows. `memory_get` is in
 * the set because it applies the same server-side visibility check as list.
 * Writes, deletes, scope controls, library-wide identity/preference reads,
 * runtime provisioning and unknown/future `memory_*` tools stay denied.
 */
export const MEMORY_READ_TOOLS = Object.freeze(['memory_search', 'memory_list', 'memory_get'])
const MEMORY_READ_TOOL_SET = new Set(MEMORY_READ_TOOLS)

/**
 * Cordis service contract for the trusted-Scene read capability.
 *
 * QQ deliberately does NOT infer this from tool names, plugin versions, or
 * config-shaped guesses: an upstream/old Mneme also registers memory_* tools
 * but has no per-Scene ACL, so name-only gating would leak other Scenes. The
 * Amadeus Memory plugin must provide this service and return the declaration
 * below only while its trusted-Scene ACL is actually active. Missing, old,
 * malformed, incomplete, or withdrawn declarations fail closed.
 *
 * Memory-side minimal implementation (the blocking cross-repo change):
 *
 *   const qq = ctx.reflect?.get?.('qq')
 *   ctx.provide('amadeus.memory', {
 *     sceneAclRead: () => cfg.sceneIsolationEnabled === true &&
 *         cfg.sceneStrictQQ === true &&
 *         typeof qq?.resolveTrustedSessionScene === 'function'
 *       ? {
 *           contract: 'amadeus-memory/trusted-scene-acl-read',
 *           version: 1,
 *           trustedSceneAcl: true,
 *           strictQQ: true,
 *           tools: ['memory_search', 'memory_list', 'memory_get']
 *         }
 *       : null
 *   })
 *
 * The declaration is synchronous and is re-read at execution time, so turning
 * the Memory Scene policy off after startup also closes the QQ side.
 */
export const MEMORY_SCENE_ACL_SERVICE = 'amadeus.memory'
export const MEMORY_SCENE_ACL_CONTRACT = 'amadeus-memory/trusted-scene-acl-read'
export const MEMORY_SCENE_ACL_VERSION = 1

function readHostService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === 'function') return ctx.reflect.get(name)
  } catch {
    // Fall through to ctx.get only for hosts without a usable reflect layer.
  }
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
  } catch {
    // Unavailable is indistinguishable from absent: fail closed.
  }
  return undefined
}

/**
 * True only when Amadeus Memory explicitly declares a trusted-Scene ACL read
 * capability covering all three bounded readers.
 * @param {unknown} ctx - preset or connector scope with reflect/get access.
 * @returns {boolean}
 */
export function memorySceneAclReadGranted(ctx) {
  const service = readHostService(ctx, MEMORY_SCENE_ACL_SERVICE)
  if (!service || (typeof service !== 'object' && typeof service !== 'function')) return false
  let declared
  try {
    declared = typeof service.sceneAclRead === 'function'
      ? service.sceneAclRead()
      : service.sceneAclRead
  } catch {
    return false
  }
  try {
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return false
    if (declared.contract !== MEMORY_SCENE_ACL_CONTRACT) return false
    if (declared.version !== MEMORY_SCENE_ACL_VERSION) return false
    if (declared.trustedSceneAcl !== true || declared.strictQQ !== true) return false
    if (!Array.isArray(declared.tools)) return false
    const declaredTools = new Set(declared.tools.filter(name => typeof name === 'string'))
    return MEMORY_READ_TOOLS.every(name => declaredTools.has(name))
  } catch {
    // A declaration that throws while being inspected is not a declaration.
    return false
  }
}

/** @param {unknown} name @returns {boolean} whether name is a bounded Memory reader. */
export function isMemoryReadTool(name) {
  return typeof name === 'string' && MEMORY_READ_TOOL_SET.has(name)
}

/**
 * Minimum permission level per QQ platform tool. This is the extension point:
 * a future capability becomes visible only after it is declared here, and it is
 * denied below its declared level at execution time.
 */
export const QQ_TOOL_CONTRACT = Object.freeze({
  qq_wait_for_messages: Object.freeze({ level: 0, capability: 'wait' }),
  qq_get_unread_messages: Object.freeze({ level: 0, capability: 'read' }),
  qq_mark_read: Object.freeze({ level: 0, capability: 'read' }),
  qq_connection_status: Object.freeze({ level: 0, capability: 'status' }),
  qq_capability_search: Object.freeze({ level: 0, capability: 'discover' }),
  qq_capability_describe: Object.freeze({ level: 0, capability: 'discover' }),
  qq_send_message: Object.freeze({ level: 1, capability: 'send' }),
  qq_capability_execute: Object.freeze({ level: 1, capability: 'execute' }),
  qq_send_media: Object.freeze({ level: 2, capability: 'media.send' }),
  qq_upload_file: Object.freeze({ level: 2, capability: 'media.send' }),
  qq_qzone: Object.freeze({ level: 3, capability: 'qzone' }),
  qq_account_profile: Object.freeze({ level: 4, capability: 'profile' }),
  qq_read_message_image: Object.freeze({ level: 2, capability: 'media.read' }),
  qq_transcribe_message_record: Object.freeze({ level: 2, capability: 'media.read' }),
  qq_transcribe_message_record_native: Object.freeze({ level: 1, capability: 'read' }),
  qq_read_message_file: Object.freeze({ level: 2, capability: 'media.read' }),
  qq_read_message_video: Object.freeze({ level: 2, capability: 'media.read' }),
})

export const QQ_TOOL_NAMES = Object.freeze(Object.keys(QQ_TOOL_CONTRACT))

/** @param {number} level - inclusive maximum permission level. @returns {string[]} allowed tool names. */
export function toolsForLevel(level) {
  return QQ_TOOL_NAMES.filter(name => QQ_TOOL_CONTRACT[name].level <= level)
}

/**
 * Validate one preset row's config and resolve its allowed tool set.
 * Invalid levels throw so the preset fails activation instead of running with
 * an accidental default.
 * @param {unknown} config - preset row config.
 * @returns {{level: number, levelId: string, tools: readonly string[], allowSearch: boolean}} policy.
 */
export function resolveQQPermissionPolicy(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('QQ preset config must be an object')
  }
  const level = config.level === undefined ? DEFAULT_QQ_PERMISSION_LEVEL : config.level
  if (!Number.isInteger(level) || level < 0 || level > MAX_QQ_PERMISSION_LEVEL) {
    throw new TypeError(`QQ preset level must be an integer from 0 to ${MAX_QQ_PERMISSION_LEVEL}`)
  }
  const allowSearch = config.allowSearch === undefined ? false : config.allowSearch
  if (typeof allowSearch !== 'boolean') throw new TypeError('QQ preset allowSearch must be a boolean')
  const entry = QQ_PERMISSION_LEVELS[level]
  // Memory readers are intentionally not part of the static preset policy.
  // They are opened only after the live Memory service declares the trusted
  // Scene ACL contract (see MEMORY_SCENE_ACL_SERVICE above); the Owner preset
  // reaches them through its existing generic, Owner-authorized host-tool path.
  const tools = allowSearch
    ? [...toolsForLevel(level), 'web_search']
    : toolsForLevel(level)
  return Object.freeze({ level, levelId: entry.id, tools: Object.freeze(tools), allowSearch })
}

/**
 * Mount the QQ boundary in the preset scope. The guard denies by tool name
 * regardless of connector state; visible-schema restrictions are applied to
 * already-known tools and retried on tools/change until the QQ tool set is
 * complete.
 * @param {{tools: {guard: Function, restrict: Function, schemas?: Function, presentAs?: Function}, on?: Function, effect?: Function}} ctx - preset scope.
 * @param {unknown} config - row config, currently `{ level?: 0|1|2|3|4 }`.
 */
export function apply(ctx, config = {}) {
  const policy = resolveQQPermissionPolicy(config)
  const allowed = new Set(policy.tools)
  // Tools that may legitimately be absent without blocking the visible allow
  // mask: connector roots that depend on live configuration, the Owner
  // workspace, and the optional Memory plugin. Memory readers enter the visible
  // policy only when the trusted-Scene contract is present.
  const OPTIONAL_TOOLS = new Set([
    'qq_send_media', 'qq_upload_file', 'qq_qzone', 'qq_account_profile', OWNER_WORKSPACE_TOOL,
    ...MEMORY_READ_TOOLS,
  ])
  const OWNER_NATIVE = new Set(OWNER_NATIVE_TOOLS)
  // Host plugins can register tools after this preset starts. Keep the QQ
  // namespace on its explicit contract; all other registered native tools are
  // usable only by a currently authorized Owner private Session.
  const ownerHostTool = name => typeof name === 'string' && name !== 'run_code' &&
    !name.startsWith('qq_') && !Object.hasOwn(QQ_TOOL_CONTRACT, name) && name !== OWNER_WORKSPACE_TOOL
  const QZONE_READ_OPS = new Set(['own_posts', 'friend_feeds', 'comments'])
  const QZONE_WRITE_OPS = new Set(['publish_text', 'publish_media', 'like', 'unlike', 'comment', 'reply', 'forward', 'delete'])

  // The Owner workspace tool itself is registered by the connector with the
  // live config; this preset owns only the per-Session allowlist and guard.
  // Static preset-row roots are deliberately not read here.
  if (policy.level === 4) {
    allowed.add(OWNER_WORKSPACE_TOOL)
    for (const tool of OWNER_NATIVE_TOOLS) allowed.add(tool)
  }

  // PTC exposes a code-execution transport outside the capability filter.
  // Force native presentation for every Agent using this preset; a conflicting
  // composition fails activation instead of silently keeping run_code.
  if (typeof ctx.tools.presentAs === 'function') {
    try {
      ctx.tools.presentAs('native')
    } catch {
      throw new Error('QQ preset requires native tool presentation; PTC run_code is outside the QQ contract')
    }
  }

  const isRegistered = name => {
    if (typeof ctx.tools.schemas !== 'function') return false
    try {
      return (ctx.tools.schemas() ?? []).some(schema => schema?.name === name)
    } catch {
      return false
    }
  }

  // Memory readers are opt-in at runtime, not by preset level. The declaration
  // is re-read for every visibility refresh and every execution, so an absent,
  // old or withdrawn Memory service cannot leave the tools open.
  //
  // DSH's tools.restrict() synchronously emits tools/change (its effect notifies
  // on apply and on dispose). Every mutation below therefore uses a re-entrancy
  // guard plus a "mark before mutate" state so the event it causes cannot
  // re-enter the same mutation. The outer refresh loop runs at most a bounded
  // number of passes; a pathological host cannot turn it into a CPU loop.
  let memoryReadGranted = memorySceneAclReadGranted(ctx)
  const memoryReaderDenies = new Map() // reader name -> deny disposer (null while pending)
  let syncingMemoryReaders = false
  const discoverMemoryReaders = () => {
    if (typeof ctx.tools.schemas !== 'function') return []
    try {
      return (ctx.tools.schemas() ?? [])
        .map(schema => schema?.name)
        .filter(name => typeof name === 'string' && MEMORY_READ_TOOL_SET.has(name))
    } catch {
      return []
    }
  }
  /** Hide the readers while the contract is absent; restore them when it appears. */
  const syncMemoryReaderVisibility = () => {
    if (syncingMemoryReaders) return
    syncingMemoryReaders = true
    try {
      if (memoryReadGranted) {
        const disposers = new Set(memoryReaderDenies.values())
        memoryReaderDenies.clear()
        for (const dispose of disposers) {
          if (typeof dispose !== 'function') continue
          try { dispose() } catch { /* already disposed */ }
        }
        return
      }
      const fresh = discoverMemoryReaders().filter(name => !memoryReaderDenies.has(name))
      if (fresh.length === 0) return
      // Mark pending before restrict(): the synchronous tools/change event
      // must see these names as already handled.
      for (const name of fresh) memoryReaderDenies.set(name, null)
      try {
        const dispose = ctx.tools.restrict({ deny: fresh })
        for (const name of fresh) memoryReaderDenies.set(name, dispose)
        return
      } catch {
        for (const name of fresh) memoryReaderDenies.delete(name)
      }
      for (const name of fresh) {
        memoryReaderDenies.set(name, null)
        try {
          memoryReaderDenies.set(name, ctx.tools.restrict({ deny: [name] }))
        } catch {
          memoryReaderDenies.delete(name)
        }
      }
    } finally {
      syncingMemoryReaders = false
    }
  }

  const authorizeCapability = (exec, capability) => {
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId) return false
    let service
    try {
      service = typeof ctx.get === 'function' ? ctx.get('qq') : undefined
    } catch {
      return false
    }
    if (!service || typeof service.authorizeSessionCapability !== 'function') return false
    try {
      return service.authorizeSessionCapability(sessionId, capability) === true
    } catch {
      return false
    }
  }

  const authorizeSearch = exec => authorizeCapability(exec, 'dsh.search')

  const authorizeOwner = exec => {
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || !sessionId) return false
    let service
    try {
      service = typeof ctx.get === 'function' ? ctx.get('qq') : undefined
    } catch {
      return false
    }
    if (!service || typeof service.resolveTrustedSessionScene !== 'function' ||
      typeof service.authorizeSessionCapability !== 'function') return false
    try {
      if (service.resolveTrustedSessionScene(sessionId)?.admin !== true) return false
      return service.authorizeSessionCapability(sessionId, 'qq.owner.tools') === true
    } catch {
      return false
    }
  }

  ctx.tools.guard(exec => {
    const tool = exec?.name
    if (typeof tool !== 'string') return 'QQ Session cannot use non-QQ tools'
    if (tool === 'web_search') {
      if (policy.level === 4 && authorizeOwner(exec)) return undefined
      if (!policy.allowSearch) return 'QQ Session cannot use non-QQ tools'
      return authorizeSearch(exec) ? undefined : 'QQ search permission denied'
    }
    if (OWNER_NATIVE.has(tool)) {
      if (policy.level !== 4) return 'QQ Session cannot use non-QQ tools'
      return authorizeOwner(exec) ? undefined : 'QQ owner native tool permission denied'
    }
    if (tool === 'qq_send_media' || tool === 'qq_upload_file') {
      if (policy.level < 2) return `QQ Session permission level ${policy.level} does not allow ${tool}`
      if (!isRegistered(tool)) return 'QQ media send root is not configured'
      return authorizeCapability(exec, 'qq.send') ? undefined : 'QQ send permission denied'
    }
    if (tool === 'qq_qzone') {
      if (policy.level < 3) return `QQ Session permission level ${policy.level} does not allow ${tool}`
      if (!isRegistered(tool)) return 'QQ QZone provider is not configured'
      const op = exec?.arguments?.op
      if (!QZONE_READ_OPS.has(op) && !QZONE_WRITE_OPS.has(op)) return 'QQ QZone operation is not allowed'
      const write = QZONE_WRITE_OPS.has(op)
      return (authorizeCapability(exec, 'qq.qzone.use') ||
        authorizeCapability(exec, write ? 'qq.qzone.publish' : 'qq.qzone.read'))
        ? undefined
        : 'QQ QZone permission denied'
    }
    if (tool === OWNER_WORKSPACE_TOOL) {
      if (policy.level !== 4) return `QQ Session permission level ${policy.level} does not allow ${tool}`
      if (!isRegistered(tool)) return 'QQ owner workspace is not registered'
      if (!authorizeCapability(exec, OWNER_WORKSPACE_CAPABILITY)) return 'QQ owner workspace permission denied'
      return undefined
    }
    if (tool === 'qq_account_profile') {
      if (policy.level !== 4) return 'QQ Session permission level ' + policy.level + ' does not allow ' + tool
      if (!isRegistered(tool)) return 'QQ account profile is not registered'
      const op = exec?.arguments?.op
      if (op === 'read') {
        return authorizeCapability(exec, 'qq.read') ? undefined : 'QQ profile permission denied'
      }
      if (['set_signature', 'set_nickname', 'set_online_status', 'set_avatar'].includes(op)) {
        return authorizeCapability(exec, 'qq.profile.write') ? undefined : 'QQ profile permission denied'
      }
      return 'QQ profile operation is not allowed'
    }
    if (MEMORY_READ_TOOL_SET.has(tool) && policy.level !== 4) {
      // Name gating is not enough: old/upstream Mneme registers the same tools
      // without a trusted-Scene ACL. Only the explicit service declaration may
      // open them, and it is checked live at execution time.
      return memorySceneAclReadGranted(ctx)
        ? undefined
        : 'QQ Memory trusted Scene ACL read contract is unavailable'
    }
    if (allowed.has(tool)) return undefined
    if (Object.hasOwn(QQ_TOOL_CONTRACT, tool)) {
      return `QQ Session permission level ${policy.level} does not allow ${tool}`
    }
    if (policy.level === 4 && ownerHostTool(tool) && isRegistered(tool)) {
      return authorizeOwner(exec) ? undefined : 'QQ owner native tool permission denied'
    }
    if (policy.level !== 4 && tool.startsWith('memory_')) {
      // The three readers were handled by the live contract branch above.
      // Everything else in the Memory namespace is a write, scope/
      // administrative action, or an unknown future tool; none of them is
      // delegated to the Memory server for an ordinary QQ Scene.
      return `QQ Session may only use Memory readers: ${MEMORY_READ_TOOLS.join(', ')}`
    }
    return 'QQ Session cannot use non-QQ tools'
  })

  let visibleRestriction
  let visibleNames = ''
  let applyingVisible = false
  const deniedVisible = new Set()
  let hidingKnown = false

  /** Hide every currently known non-QQ tool, even while the connector is off. */
  const hideKnownNonQQ = () => {
    if (hidingKnown) return
    if (typeof ctx.tools.schemas !== 'function') return
    let schemas
    try {
      schemas = ctx.tools.schemas()
    } catch {
      return
    }
    const fresh = schemas
      .map(schema => schema?.name)
      .filter(name => typeof name === 'string' && !MEMORY_READ_TOOL_SET.has(name) &&
        !allowed.has(name) &&
        !(policy.level === 4 && ownerHostTool(name)) && name !== 'run_code' && !deniedVisible.has(name))
    if (fresh.length === 0) return
    hidingKnown = true
    try {
      // Mark before restrict(): restrict() synchronously emits tools/change.
      for (const name of fresh) deniedVisible.add(name)
      try {
        ctx.tools.restrict({ deny: fresh })
        return
      } catch {
        // One unknown or scope-local name must not block hiding the rest.
        for (const name of fresh) deniedVisible.delete(name)
      }
      for (const name of fresh) {
        deniedVisible.add(name)
        try {
          ctx.tools.restrict({ deny: [name] })
        } catch {
          deniedVisible.delete(name)
          // Keep the execution guard as the hard boundary and retry later.
        }
      }
    } finally {
      hidingKnown = false
    }
  }

  /** Install or refresh the allow mask as optional tools appear. */
  const applyVisibleRestriction = () => {
    if (applyingVisible) return
    let known
    try {
      known = new Set((ctx.tools.schemas?.() ?? []).map(schema => schema?.name))
    } catch {
      return
    }
    const visiblePolicy = [
      ...policy.tools,
      ...(memoryReadGranted ? MEMORY_READ_TOOLS : []),
      ...(policy.level === 4
        ? [OWNER_WORKSPACE_TOOL, ...[...known].filter(ownerHostTool)]
        : []),
    ].filter(name => !OPTIONAL_TOOLS.has(name) || known.has(name))
    if (!visiblePolicy.every(name => known.has(name))) return
    const nextNames = visiblePolicy.join(',')
    if (visibleRestriction && nextNames === visibleNames) return
    applyingVisible = true
    try {
      if (visibleRestriction) {
        const dispose = visibleRestriction
        visibleRestriction = undefined
        visibleNames = ''
        try { dispose() } catch { /* already disposed */ }
      }
      try {
        visibleRestriction = ctx.tools.restrict({ allow: visiblePolicy })
        visibleNames = nextNames
      } catch {
        visibleRestriction = undefined
        visibleNames = ''
      }
    } finally {
      applyingVisible = false
    }
  }

  /**
   * Re-read the Memory declaration. Cordis emits `internal/service` when a
   * provided service appears, changes or is withdrawn; `tools/change` is the
   * fallback for registries that only notify tool availability.
   */
  const syncMemoryReadPolicy = () => {
    const next = memorySceneAclReadGranted(ctx)
    if (next === memoryReadGranted) return
    memoryReadGranted = next
  }

  /**
   * Report only what the live registry actually contains. Missing tools mean
   * "not observed/not configured", never "enabled"; Settings distinguishes
   * configured from Scene-authorized and from unverified on-device behavior.
   */
  const syncProviderStatus = () => {
    const media = isRegistered('qq_send_media') && isRegistered('qq_upload_file')
    const qzone = isRegistered('qq_qzone')
    setProviderStatus({
      mediaSend: { installed: media, configured: media, enabled: media },
      qzone: { installed: qzone, configured: qzone, enabled: qzone },
    })
  }

  // A tools.restrict() change synchronously emits tools/change. A listener that
  // mutates restrictions again would otherwise recurse (and can stall Host
  // activation). The re-entrancy flag turns that synchronous echo into one more
  // bounded pass; every mutation above is idempotent after its first pass.
  let refreshing = false
  let refreshAgain = false
  const refreshVisibility = () => {
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = true
    let passes = 0
    try {
      do {
        refreshAgain = false
        passes += 1
        syncMemoryReadPolicy()
        syncMemoryReaderVisibility()
        hideKnownNonQQ()
        applyVisibleRestriction()
        syncProviderStatus()
      } while (refreshAgain && passes < 8)
      if (refreshAgain) {
        try {
          ctx.logger?.warn?.('amadeus-qq: tool visibility refresh did not settle; execution guard remains fail-closed')
        } catch { /* diagnostics are best-effort */ }
      }
    } finally {
      refreshing = false
      refreshAgain = false
    }
  }

  refreshVisibility()

  if (typeof ctx.on === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.on('tools/change', refreshVisibility))
    ctx.effect(() => ctx.on('internal/service', name => {
      // Memory's declaration depends on the live QQ Host service; re-check on
      // either provider change so a connector unload closes visibility too.
      if (name !== MEMORY_SCENE_ACL_SERVICE && name !== 'qq') return
      refreshVisibility()
    }))
  }
}
