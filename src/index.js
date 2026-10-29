import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { QQStore } from './storage.js'
import { sceneKey } from './storage.js'
import { QQCore } from './core.js'
import { OneBotAdapter } from './onebot.js'
import { acquireInstanceLease } from './lease.js'
import { CapabilityRegistry } from './capabilities.js'
import { readMessageImage } from './media.js'
import { readMessageFile, readMessageVideo } from './files.js'
import { transcribeMessageRecord } from './audio.js'
import { transcribeMessageRecordNative } from './native-asr.js'
import { prepareOutboundMedia } from './outbound-media.js'
import { createQzoneProvider } from './qzone-provider.js'
import { createAccountProfile } from './account-profile.js'
import {
  createOwnerWorkspaceTool,
  resolveOwnerWorkspacePolicy,
  setOwnerWorkspaceStatus,
} from './owner-workspace.js'
import { Config } from './config.js'
import {
  apply as applyPresetGuard,
  isMemoryReadTool,
  memorySceneAclReadGranted,
  OWNER_NATIVE_TOOLS,
} from './preset-guard.mjs'
import { ADMIN_PREFIX, createAdminHandler } from './admin-http.js'
import { createSetupService } from './setup.js'

export const name = 'amadeus-qq'
export const inject = ['tools', 'sessionController']
export { Config }

const QQ_TOOL_NAMES = Object.freeze([
  'qq_send_message', 'qq_wait_for_messages', 'qq_get_unread_messages',
  'qq_mark_read', 'qq_connection_status', 'qq_capability_search',
  'qq_capability_describe', 'qq_capability_execute', 'qq_read_message_image',
  'qq_transcribe_message_record', 'qq_read_message_file', 'qq_read_message_video',
  'qq_transcribe_message_record_native',
  'qq_send_media', 'qq_upload_file', 'qq_qzone', 'qq_owner_workspace', 'qq_account_profile',
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

/**
 * Snapshot an already-validated outbound plan into an owner-only temp file and
 * verify the copied bytes still match the helper's SHA-256. NapCat then reads
 * the private snapshot, not the original path, closing the read-to-send window.
 */
async function snapshotOutboundPlan(plan) {
  const source = plan.mode === 'upload' ? plan.params?.file : plan.segments?.[0]?.data?.file
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('QQ_MEDIA_PLAN_INVALID')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'amadeus-qq-send-'))
  const snapshot = path.join(dir, path.basename(source))
  try {
    await fs.promises.copyFile(source, snapshot, fs.constants.COPYFILE_EXCL)
    await fs.promises.chmod(snapshot, 0o600)
    const bytes = await fs.promises.readFile(snapshot)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== plan.fingerprint) {
      const error = new Error('QQ_MEDIA_FINGERPRINT_MISMATCH')
      error.code = 'QQ_MEDIA_FINGERPRINT_MISMATCH'
      throw error
    }
    const prepared = plan.mode === 'upload'
      ? { ...plan, params: { ...plan.params, file: snapshot } }
      : { ...plan, segments: [{ ...plan.segments[0], data: { ...plan.segments[0].data, file: snapshot } }] }
    return {
      plan: prepared,
      cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}),
    }
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
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
  if (config.workspaceId !== undefined && typeof config.workspaceId !== 'string') throw new Error('QQ workspaceId must be a string')
  if (!config.workspaceId && (typeof config.sessionCwd !== 'string' || !path.isAbsolute(config.sessionCwd))) {
    throw new Error('QQ sessionCwd must be absolute for legacy configuration')
  }
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
      if (grant?.ownerAgent === true) requestedPreset = 'amadeus-qq-owner'
      else if (grant?.mediaAllowed === true && grant?.searchAllowed === true) requestedPreset = 'amadeus-qq-media-search'
      else if (grant?.mediaAllowed === true) requestedPreset = 'amadeus-qq-media'
      else if (grant?.searchAllowed === true) requestedPreset = 'amadeus-qq-search'
      const location = config.workspaceId ? { workspaceId: config.workspaceId } : { cwd: config.sessionCwd }
      const created = await controller.create({ ...location, agentPreset: requestedPreset })
      if (created?.agentPreset !== requestedPreset) {
        throw new Error('QQ_UNSAFE_PRESET: DSH did not create the requested packaged preset')
      }
      if (typeof controller.rename === 'function') {
        const title = _scene.kind === 'group' ? `群聊 ${_scene.peerId}` : `私聊 ${_scene.peerId}`
        try { await controller.rename({ sessionId: created.sessionId, title }) } catch { /* Session remains usable; title can be repaired later. */ }
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

function registerAdmin(ctx, core = null) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer', 'connection'], child => {
      if (!child?.webServer || typeof child.webServer.register !== 'function' || typeof child.effect !== 'function') return
      const getService = name => {
        try { return child.get?.(name) ?? ctx.get?.(name) } catch { return undefined }
      }
      const setup = createSetupService(getService('configEditor'), getService('workspaceRegistry'))
      const handler = createAdminHandler(core, getService('connection'), setup)
      child.effect(() => child.webServer.register({ kind: 'prefix', path: ADMIN_PREFIX, handler }))
    })
  } catch {
    try { ctx.logger?.warn?.('amadeus-qq: native management API unavailable') } catch {}
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
    registerAdmin(ctx)
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
    token: config.token,
  }, {
    onDiagnostic: diagnostic => reportTransportDiagnostic(ctx, diagnostic),
  })
  const core = new QQCore({ store, dsh, transport, policy: config.policy, permissionPolicy: config.permissions, workspaceId: config.workspaceId ?? '' })
  const capabilities = new CapabilityRegistry({ core, store, transport })

  // Native management is an optional Host capability. Without a web server or
  // DSH Connection the API stays unavailable; the QQ connector keeps running.
  registerAdmin(ctx, core)

  // The guard is global so it also covers a QQ Session restored by DSH before
  // the plugin can attach a fresh per-Agent tool schema restriction.
  ctx.tools.guard(exec => {
    const sid = exec?.agent?.session?.id
    if (typeof sid !== 'string' || !store.isKnownSession(sid)) return undefined
    if (QQ_TOOL_SET.has(exec.name)) return undefined
    // Memory readers are not admitted by name. Ordinary QQ Sessions need the
    // explicit trusted-Scene ACL declaration from Amadeus Memory; an old or
    // upstream Mneme without it stays closed. The Owner private capability
    // keeps its pre-existing generic host-tool path unchanged.
    if (isMemoryReadTool(exec.name)) {
      let ownerAuthorized = false
      try {
        ownerAuthorized = core.authorizeSessionCapability(sid, 'qq.owner.tools') === true
      } catch { /* fail closed for the ordinary path */ }
      if (ownerAuthorized) return undefined
      return memorySceneAclReadGranted(ctx)
        ? undefined
        : 'QQ Memory trusted Scene ACL read contract is unavailable'
    }
    if (exec.name === 'web_search') {
      return core.authorizeSessionCapability(sid, 'dsh.search')
        ? undefined
        : 'QQ Session search permission is not authorized'
    }
    // The Owner preset may expose tools registered later by other plugins
    // (for example Life). The connector guard must use the same live Owner
    // grant while refusing unknown names and the PTC code transport.
    let registeredOwnerTool = false
    if (typeof exec.name === 'string' && exec.name !== 'run_code' &&
      !exec.name.startsWith('qq_') && typeof ctx.tools.schemas === 'function') {
      try {
        registeredOwnerTool = (ctx.tools.schemas() ?? []).some(schema => schema?.name === exec.name)
      } catch { /* fail closed for dynamic tools */ }
    }
    if (OWNER_NATIVE_TOOLS.includes(exec.name) || registeredOwnerTool) {
      return core.authorizeSessionCapability(sid, 'qq.owner.tools')
        ? undefined
        : 'QQ Session cannot use non-QQ tools'
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

  registerTool(ctx, {
    name: 'qq_transcribe_message_record_native',
    description: 'Transcribe one voice record already present in this Session’s bound QQ message using QQ native PTT transcription; only a message ID is accepted.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      messageId: { type: 'string' },
    }, required: ['messageId'] },
    timeoutMs: 20_000,
    execute: (args, exec) => transcribeMessageRecordNative({
      core,
      store,
      transport,
      sessionId: sessionIdOf(exec),
      messageId: args.messageId,
    }),
  })

  // Outbound media is restricted to a configured directory. The helper owns
  // root/type/size validation; snapshotOutboundPlan then seals the exact bytes
  // NapCat will read. No model-supplied URL, absolute path or attachment ref.
  if (typeof config.sendRoot === 'string' && path.isAbsolute(config.sendRoot)) {
    registerTool(ctx, {
      name: 'qq_send_media',
      description: 'Send one image, GIF or video from a relative path under the configured media send root.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        actionId: { type: 'string' },
        kind: { type: 'string', enum: ['image', 'gif', 'video', 'audio'] },
        path: { type: 'string' },
      }, required: ['actionId', 'kind', 'path'] },
      timeoutMs: 30_000,
      execute: async (args, exec) => {
        const sessionId = sessionIdOf(exec)
        const plan = await prepareOutboundMedia({
          core,
          sessionId,
          kind: args.kind,
          source: { type: 'send-root', path: args.path },
          sendRoot: config.sendRoot,
          attachments: null,
        })
        if (plan.mode !== 'message') throw new Error('QQ_MEDIA_PLAN_INVALID')
        const snapshot = await snapshotOutboundPlan(plan)
        try {
          return await core.sendPreparedMedia(sessionId, args.actionId, snapshot.plan)
        } finally {
          await snapshot.cleanup()
        }
      },
    })
    registerTool(ctx, {
      name: 'qq_upload_file',
      description: 'Upload one file from a relative path under the configured media send root to this bound QQ scene.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        actionId: { type: 'string' },
        path: { type: 'string' },
      }, required: ['actionId', 'path'] },
      timeoutMs: 60_000,
      execute: async (args, exec) => {
        const sessionId = sessionIdOf(exec)
        const plan = await prepareOutboundMedia({
          core,
          sessionId,
          kind: 'file',
          source: { type: 'send-root', path: args.path },
          sendRoot: config.sendRoot,
          attachments: null,
        })
        if (plan.mode !== 'upload') throw new Error('QQ_MEDIA_PLAN_INVALID')
        const snapshot = await snapshotOutboundPlan(plan)
        try {
          return await core.uploadSceneFile(sessionId, args.actionId, snapshot.plan)
        } finally {
          await snapshot.cleanup()
        }
      },
    })
  }

  // QZone is optional. Native NapCat publishes posts; a configured loopback
  // provider can supply the remaining read and interaction operations. Every operation re-checks the bound
  // Scene and capability; writes go through the same durable delivery ledger.
  const qzoneAllowed = (sessionId, write) =>
    core.authorizeSessionCapability(sessionId, 'qq.qzone.use') === true ||
    core.authorizeSessionCapability(sessionId, write ? 'qq.qzone.publish' : 'qq.qzone.read') === true
  let qzoneProvider
  if (config.qzoneEnabled === true) {
    try {
      qzoneProvider = createQzoneProvider({
        ...(config.qzoneLoopbackUrl && config.qzoneTokenEnv
          ? { baseUrl: config.qzoneLoopbackUrl, tokenEnv: config.qzoneTokenEnv }
          : {}),
        env: process.env,
        nativeTransport: { action: (name, params, timeoutMs, maxResponseBytes) =>
          transport.action(name, params, timeoutMs, maxResponseBytes) },
        sendRoot: config.sendRoot || undefined,
      })
    } catch {
      ctx.logger?.warn?.('amadeus-qq: QZone provider configuration is unavailable')
    }
  }
  if (qzoneProvider) {
    registerTool(ctx, {
      name: 'qq_qzone',
      description: 'Publish text or controlled images through NapCat; optional loopback provider supplies QZone reads and interactions. Targets must come from this Scene’s observed posts.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        op: { type: 'string', enum: ['own_posts', 'friend_feeds', 'comments', 'publish_text', 'publish_media', 'like', 'unlike', 'comment', 'reply', 'forward', 'delete'] },
        tid: { type: 'string' },
        commentId: { type: 'string' },
        text: { type: 'string' },
        images: { type: 'array', maxItems: 9, items: { type: 'string' } },
        audience: { type: 'string', enum: ['self', 'friends', 'public'] },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        actionId: { type: 'string' },
      }, required: ['op'] },
      timeoutMs: 20_000,
      execute: async (args, exec) => {
        const sessionId = sessionIdOf(exec)
        const scene = core.authorizedScene(sessionId)
        const context = {
          sceneKey: sceneKey(scene),
          sessionId,
          authorize: async request => qzoneAllowed(sessionId, request?.write === true),
          ledger: {
            run: async request => {
              const reserved = store.reserveDelivery(scene, request.actionId, request.fingerprint)
              if (!reserved.fresh) {
                return { status: reserved.delivery.status, repeated: true, result: null }
              }
              if (!qzoneAllowed(sessionId, true)) {
                try { store.settleDelivery(scene, request.actionId, 'failed') } catch { /* keep refusal */ }
                throw new Error('QQ_PERMISSION_CHANGED: qq.qzone.publish')
              }
              const key = `${sceneKey(scene)}:${request.actionId}`
              core.inFlightDeliveries.add(key)
              try {
                const result = await request.execute()
                store.settleDelivery(scene, request.actionId, 'delivered')
                return { status: 'delivered', repeated: false, result }
              } catch (error) {
                const status = error?.code === 'QQ_QZONE_REJECTED' ? 'failed' : 'unknown'
                store.settleDelivery(scene, request.actionId, status)
                throw error
              } finally {
                core.inFlightDeliveries.delete(key)
              }
            },
          },
        }
        switch (args.op) {
          case 'own_posts': return qzoneProvider.listOwnPosts(context, args)
          case 'friend_feeds': return qzoneProvider.listFriendFeeds(context, args)
          case 'comments': return qzoneProvider.listComments(context, args)
          case 'publish_text': return qzoneProvider.publishText(context, args)
          case 'publish_media': return qzoneProvider.publishMedia(context, args)
          case 'like': return qzoneProvider.likePost(context, args)
          case 'unlike': return qzoneProvider.unlikePost(context, args)
          case 'comment': return qzoneProvider.commentPost(context, args)
          case 'reply': return qzoneProvider.replyComment(context, args)
          case 'forward': return qzoneProvider.forwardPost(context, args)
          case 'delete': return qzoneProvider.deleteOwnPost(context, args)
          default: throw new Error('QQ_QZONE_OP_INVALID')
        }
      },
    })
    ctx.effect(() => () => qzoneProvider.close())
  }

  // Account profile is an Owner-private global action. Reads require a verified
  // Owner Scene; writes additionally require qq.profile.write and an actionId.
  const accountProfile = createAccountProfile({
    core,
    transport,
    sendRoot: config.sendRoot,
    authorize: async request => {
      const sessionId = request?.sessionId
      if (typeof sessionId !== 'string') return false
      try {
        if (core.trustedSceneForSession(sessionId).admin !== true) return false
      } catch {
        return false
      }
      return core.authorizeSessionCapability(
        sessionId,
        request?.write === true ? 'qq.profile.write' : 'qq.read',
      ) === true
    },
    ledger: {
      run: async request => {
        const scene = core.authorizedScene(request.sessionId)
        const reserved = store.reserveDelivery(scene, request.actionId, request.fingerprint)
        if (!reserved.fresh) {
          return { status: reserved.delivery.status, repeated: true, profile: null }
        }
        const key = `${sceneKey(scene)}:${request.actionId}`
        core.inFlightDeliveries.add(key)
        let dispatched = false
        try {
          if (core.authorizeSessionCapability(request.sessionId, 'qq.profile.write') !== true ||
            core.trustedSceneForSession(request.sessionId).admin !== true) {
            store.settleDelivery(scene, request.actionId, 'failed')
            throw new Error('QQ_PROFILE_UNAUTHORIZED')
          }
          dispatched = true
          const profile = await request.execute()
          store.settleDelivery(scene, request.actionId, 'delivered')
          return { status: 'delivered', repeated: false, profile }
        } catch (error) {
          try {
            store.settleDelivery(scene, request.actionId, dispatched ? 'unknown' : 'failed')
          } catch { /* already terminal */ }
          throw error
        } finally {
          core.inFlightDeliveries.delete(key)
        }
      },
    },
  })
  registerTool(ctx, {
    name: 'qq_account_profile',
    description: 'Read or update the current QQ account profile. Only a verified Owner private Scene may use this; writes require an actionId. Avatar changes return platform confirmation without visual readback.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      op: { type: 'string', enum: ['read', 'set_signature', 'set_nickname', 'set_online_status', 'set_avatar'] },
      signature: { type: 'string' },
      nickname: { type: 'string' },
      path: { type: 'string' },
      status: { type: 'integer' },
      extStatus: { type: 'integer' },
      batteryStatus: { type: 'integer' },
      actionId: { type: 'string' },
    }, required: ['op'] },
    timeoutMs: 20_000,
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      switch (args.op) {
        case 'read': return accountProfile.readProfile({ sessionId })
        case 'set_signature': return accountProfile.setSignature({ sessionId, signature: args.signature, actionId: args.actionId })
        case 'set_nickname': return accountProfile.setNickname({ sessionId, nickname: args.nickname, actionId: args.actionId })
        case 'set_avatar': return accountProfile.setAvatar({ sessionId, path: args.path, actionId: args.actionId })
        case 'set_online_status': return accountProfile.setOnlineStatus({
          sessionId,
          status: args.status,
          extStatus: args.extStatus,
          batteryStatus: args.batteryStatus,
          actionId: args.actionId,
        })
        default: throw new Error('QQ_PROFILE_OP_INVALID')
      }
    },
  })

  // Media is optional: wait for the official attachment service without making
  // it a mandatory connector dependency. A text-only Host simply never gets
  // this tool; a configured mediaRoot is still required for a successful read.
  if (typeof ctx.inject === 'function') {
    let imageToolRegistered = false
    let fileToolRegistered = false
    try { ctx.inject(['attachments'], scope => {
      const attachments = scope?.attachments ?? ctx.attachments
      if (!attachments) return
      if (!imageToolRegistered && typeof attachments.saveImage === 'function') {
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
      }
      if (!fileToolRegistered && typeof attachments.saveFile === 'function') {
        fileToolRegistered = true
        registerTool(ctx, {
          name: 'qq_read_message_file',
          description: 'Read one file already present in this Session’s bound QQ message, using only the message ID and file ordinal.',
          parameters: { type: 'object', additionalProperties: false, properties: {
            messageId: { type: 'string' },
            index: { type: 'integer', minimum: 0 },
          }, required: ['messageId'] },
          timeoutMs: 60_000,
          output: {
            schema: JSON_OBJECT,
            render: (_args, value) => {
              const blocks = [{ type: 'text', text: 'QQ file loaded as an attachment.' }]
              if (value?.attachment && typeof value.attachment === 'object') {
                blocks.push({ type: 'file', attachment: value.attachment })
              }
              return blocks
            },
          },
          execute: (args, exec) => readMessageFile({
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
        registerTool(ctx, {
          name: 'qq_read_message_video',
          description: 'Read one video already present in this Session’s bound QQ message, using only the message ID and video ordinal.',
          parameters: { type: 'object', additionalProperties: false, properties: {
            messageId: { type: 'string' },
            index: { type: 'integer', minimum: 0 },
          }, required: ['messageId'] },
          timeoutMs: 60_000,
          output: {
            schema: JSON_OBJECT,
            render: (_args, value) => {
              const blocks = [{ type: 'text', text: 'QQ video loaded as an attachment.' }]
              if (value?.attachment && typeof value.attachment === 'object') {
                blocks.push({ type: 'file', attachment: value.attachment })
              }
              return blocks
            },
          },
          execute: (args, exec) => readMessageVideo({
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
      }
    }) } catch {
      // Missing optional Host media support must not disable ordinary QQ text.
      try { ctx.logger?.warn?.('amadeus-qq: attachment tools unavailable; attachment service could not be injected') } catch { /* optional diagnostic sink */ }
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
            ffmpegPath: config.ffmpegPath,
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

  // The connector owns the real Owner workspace settings. The preset guard only
  // controls visibility at level 4; it no longer registers this tool itself.
  let ownerWorkspacePolicy
  try {
    ownerWorkspacePolicy = resolveOwnerWorkspacePolicy(config)
  } catch {
    ownerWorkspacePolicy = null
  }
  if (ownerWorkspacePolicy && ownerWorkspacePolicy.root !== '') {
    const getService = () => {
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('qq') : undefined
        if (service) return service
      } catch { /* fall through to the in-process adapter */ }
      return {
        resolveTrustedSessionScene: sessionId => core.trustedSceneForSession(sessionId),
        authorizeSessionCapability: (sessionId, capability) => core.authorizeSessionCapability(sessionId, capability),
      }
    }
    const getApproval = () => {
      try {
        const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
        return approval ?? ctx.approval
      } catch {
        return undefined
      }
    }
    registerTool(ctx, createOwnerWorkspaceTool({
      root: ownerWorkspacePolicy.root,
      allowWrite: ownerWorkspacePolicy.allowWrite,
      maxBytes: ownerWorkspacePolicy.maxBytes,
      getService,
      getApproval,
    }))
    setOwnerWorkspaceStatus({
      configured: true,
      writes: ownerWorkspacePolicy.allowWrite,
      maxBytes: ownerWorkspacePolicy.maxBytes,
    })
  }

  ctx.provide('qq', Object.freeze({
    getHealth: () => core.health(),
    listAuthorizedScenes: () => core.listAuthorizedScenes(),
    // In-process Host contract for cooperating plugins. The Session ID must
    // come from the active DSH Agent, never from model or HTTP arguments.
    resolveTrustedSessionScene: sessionId => core.trustedSceneForSession(sessionId),
    authorizeSessionCapability: (sessionId, capability) => core.authorizeSessionCapability(sessionId, capability),
  }))
  ctx.effect(() => () => core.close())
  void Promise.resolve()
    .then(() => core.provisionAuthorizedScenes())
    .then(() => core.resumePending())
    .catch(() => reportStartupFailure(ctx, 'session'))
  void Promise.resolve()
    .then(() => transport.start(event => core.ingest(event)))
    .catch(() => reportStartupFailure(ctx, 'transport'))
  } catch (error) {
    releaseLease()
    throw error
  }
}
