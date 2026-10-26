import path from 'node:path'
import { QQStore } from './storage.js'
import { QQCore } from './core.js'
import { OneBotAdapter } from './onebot.js'
import { acquireInstanceLease } from './lease.js'
import { CapabilityRegistry } from './capabilities.js'
import { readMessageImage } from './media.js'
import { transcribeMessageRecord } from './audio.js'
import { Config } from './config.js'
import { apply as applyPresetGuard } from './preset-guard.mjs'
import { ADMIN_PREFIX, createAdminHandler } from './admin-http.js'

export const name = 'amadeus-qq'
export const inject = ['tools', 'sessionController']
export { Config }

const QQ_TOOL_NAMES = Object.freeze([
  'qq_send_message', 'qq_wait_for_messages', 'qq_get_unread_messages',
  'qq_mark_read', 'qq_connection_status', 'qq_capability_search',
  'qq_capability_describe', 'qq_capability_execute', 'qq_read_message_image',
  'qq_transcribe_message_record',
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
  const output = definition.output ?? {
    schema: JSON_OBJECT,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
  ctx.tools.register({
    ...definition,
    execute: async (args, exec) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('QQ tool arguments must be an object')
      for (const key of Object.keys(args)) if (!allowed.has(key)) throw new TypeError(`unknown QQ tool argument: ${key}`)
      return definition.execute(args, exec)
    },
    output,
  })
}

export function makeDshHost(ctx, config) {
  const controller = ctx.sessionController
  if (typeof controller?.create !== 'function' || typeof controller?.prompt !== 'function') {
    throw new Error('DSH sessionController create/prompt is required')
  }
  if (typeof config.agentPreset !== 'string' || !config.agentPreset) throw new Error('A restricted QQ agentPreset is required')
  // The runtime guard only exists while this plugin is enabled. A persisted QQ
  // Session must therefore have a restricted preset of its own, including
  // after the plugin is disabled or removed. Never create one from a general
  // coding preset and rely on a temporary per-Agent restriction alone.
  if (config.agentPreset !== 'amadeus-qq') {
    throw new Error('QQ_UNSAFE_PRESET: the packaged amadeus-qq agentPreset is required')
  }
  if (typeof config.sessionCwd !== 'string' || !path.isAbsolute(config.sessionCwd)) throw new Error('QQ sessionCwd must be absolute')
  return {
    async cancelSceneSession(sessionId) {
      if (typeof controller.cancel !== 'function') throw new Error('DSH Session cancellation is unavailable')
      try {
        return await controller.cancel({ sessionId })
      } catch (error) {
        if (error?.code === 'session/not-found') return { accepted: true, alreadyInactive: true }
        throw error
      }
    },
    async createSceneSession(_scene, grant) {
      let requestedPreset = config.agentPreset
      if (grant?.mediaAllowed === true && grant?.searchAllowed === true) requestedPreset = 'amadeus-qq-media-search'
      else if (grant?.mediaAllowed === true) requestedPreset = 'amadeus-qq-media'
      else if (grant?.searchAllowed === true) requestedPreset = 'amadeus-qq-search'
      const created = await controller.create({ cwd: config.sessionCwd, agentPreset: requestedPreset })
      if (created?.agentPreset !== requestedPreset) {
        throw new Error('QQ_UNSAFE_PRESET: DSH did not create the requested packaged preset')
      }
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

/**
 * Emit one bounded startup diagnostic. Never include the raw error, URLs,
 * credentials, state paths, message bodies, or the logger's own failure.
 * @param {Record<string, unknown>} ctx - plugin context.
 * @param {'resume'|'transport'} stage - failed startup stage.
 */
function reportStartupFailure(ctx, stage) {
  const message = stage === 'transport'
    ? 'amadeus-qq: OneBot transport startup failed; connector remains unavailable'
    : 'amadeus-qq: pending QQ Session resume failed; queued messages remain pending'
  try {
    const logger = ctx?.logger
    if (logger && typeof logger.error === 'function') logger.error(message)
    else if (logger && typeof logger.warn === 'function') logger.warn(message)
    else console.error(message)
  } catch {
    // Logging must never turn a bounded failure into an unhandled rejection.
    try { console.error(message) } catch { /* no available diagnostic sink */ }
  }
}

const TRANSPORT_DIAGNOSTICS = Object.freeze({
  QQ_INBOUND_HANDLER_FAILED: 'amadeus-qq: inbound QQ event handling failed',
  QQ_ONEBOT_CONNECT_FAILED: 'amadeus-qq: OneBot connection attempt failed',
  QQ_ONEBOT_SOCKET_ERROR: 'amadeus-qq: OneBot socket error',
})

/**
 * Map an adapter diagnostic code to one static, bounded Host log line. Unknown
 * codes and any attached detail are ignored; the adapter never supplies event
 * content, URLs, credentials or paths.
 * @param {Record<string, unknown>} ctx - plugin context.
 * @param {{code?: unknown}} diagnostic - adapter diagnostic.
 */
function reportTransportDiagnostic(ctx, diagnostic) {
  const code = diagnostic?.code
  const message = typeof code === 'string' ? TRANSPORT_DIAGNOSTICS[code] : undefined
  if (!message) return
  const level = code === 'QQ_INBOUND_HANDLER_FAILED' ? 'error' : 'warn'
  try {
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
    else if (logger && typeof logger.warn === 'function') logger.warn(message)
    else console.warn(message)
  } catch {
    try { console.warn(message) } catch { /* no available diagnostic sink */ }
  }
}

export function apply(ctx, config = {}) {
  // The preset rows mount this same package root with `presetGuard: true`.
  // Branch before any connector startup requirement so the guard is owned by
  // the preset, not by the connector's enabled/statePath configuration.
  if (config.presetGuard === true) {
    return applyPresetGuard(ctx, {
      level: config.level ?? 1,
      allowSearch: config.allowSearch === true,
    })
  }
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
  }, {
    onDiagnostic: diagnostic => reportTransportDiagnostic(ctx, diagnostic),
  })
  const core = new QQCore({ store, dsh, transport, policy: config.policy, permissionPolicy: config.permissions })
  const capabilities = new CapabilityRegistry({ core, store, transport })

  // Native management is an optional Host capability. Without a web server or
  // DSH Connection the API stays unavailable; the QQ connector keeps running.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer', 'connection'], child => {
        if (!child?.webServer || typeof child.webServer.register !== 'function') return
        if (typeof child.effect !== 'function') return
        try {
          let connection = child.connection
          if (connection === undefined && typeof child.get === 'function') {
            try {
              connection = child.get('connection')
            } catch {
              connection = undefined
            }
          }
          const handler = createAdminHandler(core, connection)
          child.effect(() => child.webServer.register({
            kind: 'prefix',
            path: ADMIN_PREFIX,
            handler,
          }))
        } catch (error) {
          ctx.logger?.warn?.(`amadeus-qq: native management API unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`amadeus-qq: native management API unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The guard is global so it also covers a QQ Session restored by DSH before
  // the plugin can attach a fresh per-Agent tool schema restriction.
  ctx.tools.guard(exec => {
    const sid = exec?.agent?.session?.id
    if (typeof sid !== 'string' || !store.isKnownSession(sid)) return undefined
    if (QQ_TOOL_SET.has(exec.name)) return undefined
    if (exec.name === 'web_search') {
      return core.authorizeSessionCapability(sid, 'dsh.search')
        ? undefined
        : 'QQ Session search permission is not authorized'
    }
    return 'QQ Session cannot use non-QQ tools'
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

  // Media is optional: wait for the official attachment service without making
  // it a mandatory connector dependency. A text-only Host simply never gets
  // this tool; a configured mediaRoot is still required for a successful read.
  if (typeof ctx.inject === 'function') {
    let imageToolRegistered = false
    try { ctx.inject(['attachments'], scope => {
      const attachments = scope?.attachments ?? ctx.attachments
      if (imageToolRegistered || !attachments || typeof attachments.saveImage !== 'function') return
      imageToolRegistered = true
      registerTool(ctx, {
        name: 'qq_read_message_image',
        description: 'Read one image already present in this Session’s bound QQ message, using only the message ID and image ordinal.',
        parameters: { type: 'object', additionalProperties: false, properties: {
          messageId: { type: 'string' },
          index: { type: 'integer', minimum: 0 },
        }, required: ['messageId'] },
        output: {
          schema: JSON_OBJECT,
          render: (_args, value) => {
            const blocks = [{ type: 'text', text: 'QQ image loaded as an attachment.' }]
            if (value?.attachment && typeof value.attachment === 'object') {
              blocks.push({ type: 'image', attachment: value.attachment })
            }
            return blocks
          },
        },
        execute: (args, exec) => readMessageImage({
          core,
          store,
          transport,
          attachments,
          mediaRoot: config.mediaRoot,
          sessionId: sessionIdOf(exec),
          messageId: args.messageId,
          index: args.index ?? 0,
        }),
      })
    }) } catch {
      // Missing optional Host media support must not disable ordinary QQ text.
      try { ctx.logger?.warn?.('amadeus-qq: image tool unavailable; attachment service could not be injected') } catch { /* optional diagnostic sink */ }
    }
  }

  // Local record transcription is optional and only registered when an ASR
  // provider id is explicitly configured and the Host speech service is live.
  // The provider id comes from config; the model can supply only message
  // identity and the record ordinal.
  const asrProviderId = typeof config.asrProviderId === 'string' ? config.asrProviderId.trim() : ''
  if (asrProviderId && typeof ctx.inject === 'function') {
    let audioToolRegistered = false
    try {
      ctx.inject(['speechToText'], scope => {
        const speechToText = scope?.speechToText ?? ctx.speechToText
        if (audioToolRegistered ||
          !speechToText ||
          typeof speechToText.listProviders !== 'function' ||
          typeof speechToText.resolve !== 'function' ||
          typeof speechToText.transcribe !== 'function') return
        audioToolRegistered = true
        registerTool(ctx, {
          name: 'qq_transcribe_message_record',
          description: 'Transcribe one voice record already present in this Session’s bound QQ message, using only the message ID and record ordinal.',
          parameters: { type: 'object', additionalProperties: false, properties: {
            messageId: { type: 'string' },
            index: { type: 'integer', minimum: 0 },
          }, required: ['messageId'] },
          timeoutMs: 140_000,
          execute: (args, exec) => transcribeMessageRecord({
            core,
            store,
            transport,
            speechToText,
            mediaRoot: config.mediaRoot,
            providerId: asrProviderId,
            sessionId: sessionIdOf(exec),
            messageId: args.messageId,
            index: args.index ?? 0,
          }),
        })
      })
    } catch {
      try { ctx.logger?.warn?.('amadeus-qq: record transcription unavailable; speechToText service could not be injected') } catch { /* optional diagnostic sink */ }
    }
  }

  ctx.provide('qq', Object.freeze({
    getHealth: () => core.health(),
    // In-process Host contract for cooperating plugins. The Session ID must
    // come from the active DSH Agent, never from model or HTTP arguments.
    resolveTrustedSessionScene: sessionId => core.trustedSceneForSession(sessionId),
    authorizeSessionCapability: (sessionId, capability) => core.authorizeSessionCapability(sessionId, capability),
  }))
  ctx.effect(() => () => core.close())
  void Promise.resolve()
    .then(() => core.resumePending())
    .catch(() => reportStartupFailure(ctx, 'resume'))
  void Promise.resolve()
    .then(() => transport.start(event => core.ingest(event)))
    .catch(() => reportStartupFailure(ctx, 'transport'))
  } catch (error) {
    releaseLease()
    throw error
  }
}
