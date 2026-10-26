// QQ platform operation contract and Agent-preset guard.
//
// This module is mounted by the package's preset.patch.yml, never by the QQ
// connector row. A persisted QQ Session therefore keeps the boundary while the
// connector is disabled, restarting, or temporarily uninstalled. The execution
// guard is the hard boundary; the visible-schema restriction is retried as the
// connector registers its tools.

export const name = 'amadeus-qq-preset-guard'
export const inject = ['tools']

/**
 * Future mode names. This M1 preset only implements the QQ tool boundary;
 * per-Scene grants, trusted Owner Agent and higher modes are not enabled yet.
 */
export const QQ_PERMISSION_LEVELS = Object.freeze([
  Object.freeze({ level: 0, id: 'observe', description: 'Read inbox and connection state; no external writes.' }),
  Object.freeze({ level: 1, id: 'safe-chat', description: 'M1 continuous conversation, including QQ sends.' }),
  Object.freeze({ level: 2, id: 'enhanced', description: 'Reserved; per-Scene authorization is not implemented.' }),
  Object.freeze({ level: 3, id: 'autonomous-social', description: 'Reserved; account authorization is not implemented.' }),
  Object.freeze({ level: 4, id: 'owner-agent', description: 'Reserved; trusted owner authorization is not implemented.' }),
])

export const MAX_QQ_PERMISSION_LEVEL = QQ_PERMISSION_LEVELS.length - 1
export const DEFAULT_QQ_PERMISSION_LEVEL = 1

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
  qq_read_message_image: Object.freeze({ level: 2, capability: 'media.read' }),
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
  const tools = allowSearch ? [...toolsForLevel(level), 'web_search'] : toolsForLevel(level)
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

  const authorizeSearch = exec => {
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
      return service.authorizeSessionCapability(sessionId, 'dsh.search') === true
    } catch {
      return false
    }
  }

  ctx.tools.guard(exec => {
    const tool = exec?.name
    if (typeof tool !== 'string') return 'QQ Session cannot use non-QQ tools'
    if (tool === 'web_search') {
      if (!policy.allowSearch) return 'QQ Session cannot use non-QQ tools'
      return authorizeSearch(exec) ? undefined : 'QQ search permission denied'
    }
    if (allowed.has(tool)) return undefined
    if (Object.hasOwn(QQ_TOOL_CONTRACT, tool)) {
      return `QQ Session permission level ${policy.level} does not allow ${tool}`
    }
    return 'QQ Session cannot use non-QQ tools'
  })

  let visibleRestriction
  const deniedVisible = new Set()

  /** Hide every currently known non-QQ tool, even while the connector is off. */
  const hideKnownNonQQ = () => {
    if (typeof ctx.tools.schemas !== 'function') return
    let schemas
    try {
      schemas = ctx.tools.schemas()
    } catch {
      return
    }
    const fresh = schemas
      .map(schema => schema?.name)
      .filter(name => typeof name === 'string' && !allowed.has(name) && name !== 'run_code' && !deniedVisible.has(name))
    if (fresh.length === 0) return
    try {
      ctx.tools.restrict({ deny: fresh })
      for (const name of fresh) deniedVisible.add(name)
      return
    } catch {
      // One unknown or scope-local name must not block hiding the rest.
    }
    for (const name of fresh) {
      try {
        ctx.tools.restrict({ deny: [name] })
        deniedVisible.add(name)
      } catch {
        // Keep the execution guard as the hard boundary and retry later.
      }
    }
  }

  /** Install the allow mask once every QQ tool is registered. */
  const applyVisibleRestriction = () => {
    if (visibleRestriction) return
    let known
    try {
      known = new Set((ctx.tools.schemas?.() ?? []).map(schema => schema?.name))
    } catch {
      return
    }
    if (!policy.tools.every(name => known.has(name))) return
    try {
      visibleRestriction = ctx.tools.restrict({ allow: policy.tools })
    } catch {
      visibleRestriction = undefined
    }
  }

  hideKnownNonQQ()
  applyVisibleRestriction()

  if (!visibleRestriction && typeof ctx.on === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.on('tools/change', () => {
      hideKnownNonQQ()
      applyVisibleRestriction()
    }))
  }
}
