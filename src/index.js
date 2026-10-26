import path from 'node:path'
import { QQStore } from './storage.js'
import { QQCore } from './core.js'
import { OneBotAdapter } from './onebot.js'
import { acquireInstanceLease } from './lease.js'
import { CapabilityRegistry } from './capabilities.js'
import { Config } from './config.js'
import { apply as applyPresetGuard } from './preset-guard.mjs'

export const name = 'amadeus-qq'
export const inject = ['tools', 'sessionController']
export { Config }

const QQ_TOOL_NAMES = Object.freeze([
  'qq_send_message', 'qq_wait_for_messages', 'qq_get_unread_messages',
  'qq_mark_read', 'qq_connection_status', 'qq_capability_search',
  'qq_capability_describe', 'qq_capability_execute',
])
const QQ_TOOL_SET = new Set(QQ_TOOL_NAMES)
const JSON_OBJECT = Object.freeze({ type: 'object', additionalProperties: true })

function sessionIdOf(exec) {
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('QQ tools require a live DSH Session')
  return sessionId
}

function registerTool(ctx, definition) {
  const allowed = new Set(Object.keys(definition.parameters?.properties ?? {}))
  ctx.tools.register({
    ...definition,
    execute: async (args, exec) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('QQ tool arguments must be an object')
      for (const key of Object.keys(args)) if (!allowed.has(key)) throw new TypeError(`unknown QQ tool argument: ${key}`)
      return definition.execute(args, exec)
    },
    output: {
      schema: JSON_OBJECT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  })
}

function makeDshHost(ctx, config) {
  const controller = ctx.sessionController
  if (typeof controller?.create !== 'function' || typeof controller?.prompt !== 'function' || typeof controller?.resolveAgent !== 'function') {
    throw new Error('DSH sessionController create/prompt/resolveAgent is required')
  }
  if (typeof config.agentPreset !== 'string' || !config.agentPreset) throw new Error('A restricted QQ agentPreset is required')
  // The runtime guard only exists while this plugin is enabled. A persisted QQ
  // Session must therefore have a restricted preset of its own, including
  // after the plugin is disabled or removed. Never create one from a general
  // coding preset and rely on a temporary per-Agent restriction alone.
  if (['cordis', 'standard'].includes(config.agentPreset.trim().toLowerCase())) {
    throw new Error('QQ_UNSAFE_PRESET: a dedicated restricted QQ agentPreset is required')
  }
  if (typeof config.sessionCwd !== 'string' || !path.isAbsolute(config.sessionCwd)) throw new Error('QQ sessionCwd must be absolute')
  return {
    async createSceneSession() {
      const created = await controller.create({ cwd: config.sessionCwd, agentPreset: config.agentPreset })
      const agent = await controller.resolveAgent(created.sessionId)
      if (typeof agent?.ctx?.tools?.restrict !== 'function') {
        throw new Error('DSH per-Agent tool restriction is unavailable')
      }
      agent.ctx.tools.restrict({ allow: QQ_TOOL_NAMES })
      return created
    },
    async prompt(request) {
      const signal = AbortSignal.timeout(15_000)
      const accepted = await controller.prompt(request, signal)
      if (accepted?.accepted !== true) throw new Error('DSH did not accept the QQ prompt')
      return accepted
    },
  }
}

export function apply(ctx, config = {}) {
  // The preset rows mount this same package root with `presetGuard: true`.
  // Branch before any connector startup requirement so the guard is owned by
  // the preset, not by the connector's enabled/statePath configuration.
  if (config.presetGuard === true) return applyPresetGuard(ctx, { level: 1 })
  if (config.enabled !== true) {
    ctx.provide('qq', Object.freeze({ getHealth: () => ({ enabled: false, status: 'disabled' }) }))
    return
  }
  if (typeof config.statePath !== 'string' || !path.isAbsolute(config.statePath)) {
    throw new Error('QQ statePath must be explicitly configured as an absolute isolated path')
  }
  const dsh = makeDshHost(ctx, config)
  const releaseLease = acquireInstanceLease(config.statePath)
  try {
  ctx.effect(() => releaseLease)
  const store = new QQStore(config.statePath)
  const transport = new OneBotAdapter({
    enabled: config.connect === true,
    httpUrl: config.httpUrl,
    wsUrl: config.wsUrl,
    tokenEnv: config.tokenEnv,
  })
  const core = new QQCore({ store, dsh, transport, policy: config.policy })
  const capabilities = new CapabilityRegistry({ core, store, transport })

  // The guard is global so it also covers a QQ Session restored by DSH before
  // the plugin can attach a fresh per-Agent tool schema restriction.
  ctx.tools.guard(exec => {
    const sid = exec?.agent?.session?.id
    if (typeof sid !== 'string' || !store.sceneForSession(sid)) return undefined
    return QQ_TOOL_SET.has(exec.name) ? undefined : 'QQ Session cannot use non-QQ tools'
  })

  registerTool(ctx, {
    name: 'qq_send_message',
    description: 'Send one structured QQ message to this Session’s authorized scene. Requires a fresh actionId; unknown delivery is never retried automatically.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      actionId: { type: 'string' },
      segments: { type: 'array', items: { type: 'object' } },
    }, required: ['actionId', 'segments'] },
    timeoutMs: 20_000,
    execute: (args, exec) => core.send(sessionIdOf(exec), args),
  })
  registerTool(ctx, {
    name: 'qq_get_unread_messages',
    description: 'Read unread structured messages in this Session’s QQ scene.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      afterSeq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    } },
    execute: (args, exec) => core.read(sessionIdOf(exec), args),
  })
  registerTool(ctx, {
    name: 'qq_mark_read',
    description: 'Mark only messages already presented to this Session as read.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      throughSeq: { type: 'integer', minimum: 0 },
    }, required: ['throughSeq'] },
    execute: (args, exec) => core.markRead(sessionIdOf(exec), args.throughSeq),
  })
  registerTool(ctx, {
    name: 'qq_wait_for_messages',
    description: 'Wait without model polling for new messages in this Session’s QQ scene; then continue the same DSH activity.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      afterSeq: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
    } },
    timeoutMs: 310_000,
    execute: (args, exec) => core.wait(sessionIdOf(exec), args),
  })
  registerTool(ctx, {
    name: 'qq_connection_status',
    description: 'Read this Session’s QQ connection health without account secrets.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: (_args, exec) => core.statusFor(sessionIdOf(exec)),
  })
  registerTool(ctx, {
    name: 'qq_capability_search',
    description: 'Search the on-demand QQ capability catalog. Catalog presence is not proof of runtime availability.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string' }, category: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    } },
    execute: (args, exec) => { core.authorizedScene(sessionIdOf(exec)); return capabilities.search(args.query ?? '', args) },
  })
  registerTool(ctx, {
    name: 'qq_capability_describe',
    description: 'Inspect one QQ capability, schema, permissions, risk and availability.',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] },
    execute: (args, exec) => { core.authorizedScene(sessionIdOf(exec)); return capabilities.describe(args.id) },
  })
  registerTool(ctx, {
    name: 'qq_capability_execute',
    description: 'Execute only a registered safe QQ capability in this bound scene; arbitrary OneBot actions are rejected.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, args: { type: 'object' },
    }, required: ['id'] },
    timeoutMs: 20_000,
    execute: (args, exec) => capabilities.execute(sessionIdOf(exec), args.id, args.args ?? {}),
  })

  ctx.provide('qq', Object.freeze({ getHealth: () => core.health() }))
  ctx.effect(() => () => core.close())
  void core.resumePending().catch(() => {})
  void transport.start(event => core.ingest(event)).catch(() => {})
  } catch (error) {
    releaseLease()
    throw error
  }
}
