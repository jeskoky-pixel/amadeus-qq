import path from 'node:path'
import { normalizeId, sceneKey } from './storage.js'
import { CAPABILITY_CATALOG } from './permissions.js'

const ID_RE = /^[1-9]\d{0,19}$/
const MAX_SCENES = 200
const CAPABILITIES = new Set(CAPABILITY_CATALOG.map(item => item.id))

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new TypeError(`${label} must be a QQ number`)
  return normalizeId(value, label)
}

function ids(value, label) {
  if (!Array.isArray(value) || value.length > MAX_SCENES) throw new TypeError(`${label} must be a bounded list`)
  return [...new Set(value.map(item => requiredId(item, label)))]
}

function localUrl(value, protocol) {
  if (typeof value !== 'string' || value.length > 300) throw new TypeError('NapCat URL is invalid')
  let url
  try { url = new URL(value) } catch { throw new TypeError('NapCat URL is invalid') }
  if (!protocol.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('NapCat must use a local HTTP or WebSocket address')
  }
  return url.href.replace(/\/$/, '')
}

function entryFor(configEditor) {
  if (!configEditor || typeof configEditor.entries !== 'function' || typeof configEditor.edit !== 'function') {
    throw new Error('QQ_SETUP_UNAVAILABLE')
  }
  const entry = configEditor.entries().find(item => item.options?.id === 'amadeus-qq')
  if (!entry) throw new Error('QQ_SETUP_UNAVAILABLE')
  return entry
}

function revisionOf(config) {
  return Number.isSafeInteger(config?.setupRevision) && config.setupRevision >= 0 ? config.setupRevision : 0
}

export function createSetupService(configEditor, workspaceRegistry) {
  function listWorkspaces() {
    if (!workspaceRegistry || typeof workspaceRegistry.list !== 'function') throw new Error('QQ_WORKSPACE_UNAVAILABLE')
    return workspaceRegistry.list().map(item => ({ id: item.id, title: item.title, path: item.path }))
  }

  function status() {
    const config = entryFor(configEditor).options.config ?? {}
    return {
      revision: revisionOf(config),
      enabled: config.enabled === true,
      connect: config.connect === true,
      workspaceId: config.workspaceId ?? '',
      botId: config.policy?.botIds?.[0] ?? '',
      ownerId: config.permissions?.ownerPrivateIds?.[0] ?? '',
      globalDeny: config.permissions?.globalDeny ?? [],
      httpUrl: config.httpUrl ?? '',
      wsUrl: config.wsUrl ?? '',
      tokenConfigured: Boolean(config.token || config.tokenEnv),
      qzoneEnabled: config.qzoneEnabled === true,
      qzonePublish: config.permissions?.accountGrants?.byBotId?.[config.policy?.botIds?.[0]]?.qzonePublish === true,
      qzoneLoopbackUrl: config.qzoneLoopbackUrl ?? '',
      qzoneTokenEnv: config.qzoneTokenEnv ?? '',
      groups: config.policy?.groupIds ?? [],
      privatePeers: config.policy?.privateIds ?? [],
      pausedScenes: config.policy?.pausedScenes ?? [],
      workspaces: listWorkspaces(),
    }
  }

  async function save(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('setup request is invalid')
    const allowed = new Set(['expectedRevision', 'workspaceId', 'botId', 'ownerId', 'httpUrl', 'wsUrl', 'token', 'groups', 'privatePeers', 'connect', 'globalDeny'])
    if (Object.keys(body).some(key => !allowed.has(key))) throw new TypeError('setup contains unsupported fields')
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new TypeError('setup revision is invalid')
    if (typeof body.workspaceId !== 'string' || !listWorkspaces().some(item => item.id === body.workspaceId)) {
      throw new TypeError('Select an existing DSH Workspace')
    }
    const botId = requiredId(body.botId, 'botId')
    const ownerId = requiredId(body.ownerId, 'ownerId')
    if (ownerId === botId) throw new TypeError('Owner QQ number must differ from Bot QQ number')
    if (body.globalDeny !== undefined && (!Array.isArray(body.globalDeny) || body.globalDeny.length > CAPABILITIES.size ||
      body.globalDeny.some(item => typeof item !== 'string' || !CAPABILITIES.has(item)))) {
      throw new TypeError('globalDeny contains an unknown capability')
    }
    const groups = ids(body.groups ?? [], 'groups')
    const privatePeers = ids(body.privatePeers ?? [], 'privatePeers')
    if (!privatePeers.includes(ownerId)) privatePeers.unshift(ownerId)
    const httpUrl = localUrl(body.httpUrl, ['http:', 'https:'])
    const wsUrl = localUrl(body.wsUrl, ['ws:', 'wss:'])
    if (body.connect !== true && body.connect !== false) throw new TypeError('connect must be a boolean')
    if (body.token !== undefined && (typeof body.token !== 'string' || body.token.length > 256 || /[\r\n]/.test(body.token))) {
      throw new TypeError('NapCat token is invalid')
    }
    const entry = entryFor(configEditor)
    const profileDir = path.dirname(configEditor.documentPath)
    await configEditor.edit(entry, current => {
      if (revisionOf(current) !== body.expectedRevision) throw new Error('QQ_SETUP_CONFLICT')
      const oldPolicy = current.policy ?? {}
      const oldBot = oldPolicy.botIds ?? []
      const changed = JSON.stringify([oldBot, oldPolicy.groupIds ?? [], oldPolicy.privateIds ?? []]) !==
        JSON.stringify([[botId], groups, privatePeers])
      const nextPolicy = {
        ...oldPolicy,
        botIds: [botId], groupIds: groups, privateIds: privatePeers,
        pausedScenes: (oldPolicy.pausedScenes ?? []).filter(key => {
          const [b, kind, peer] = key.split(':')
          return b === botId && (kind === 'group' ? groups.includes(peer) : kind === 'private' && privatePeers.includes(peer))
        }),
        epoch: (oldPolicy.epoch ?? 0) + Number(changed),
      }
      return {
        ...current,
        setupRevision: body.expectedRevision + 1,
        enabled: true,
        connect: body.connect,
        workspaceId: body.workspaceId,
        agentPreset: 'amadeus-qq',
        statePath: current.statePath || path.join(profileDir, 'data', 'amadeus-qq', 'state.json'),
        sendRoot: current.sendRoot || path.join(profileDir, 'data', 'amadeus-qq', 'send'),
        mediaRoot: current.mediaRoot || path.join(profileDir, 'data', 'amadeus-qq', 'media'),
        httpUrl, wsUrl,
        ...(body.token === undefined ? {} : { token: body.token, tokenEnv: '' }),
        policy: nextPolicy,
        permissions: { ...(current.permissions ?? {}), ownerPrivateIds: [ownerId],
          ...(body.globalDeny === undefined ? {} : { globalDeny: [...new Set(body.globalDeny)] }) },
      }
    })
    return status()
  }

  async function setScene(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      typeof body.allowed !== 'boolean') throw new TypeError('Scene request is invalid')
    const scene = { botId: requiredId(body.botId, 'botId'), kind: body.kind, peerId: requiredId(body.peerId, 'peerId') }
    if (!['group', 'private'].includes(scene.kind)) throw new TypeError('Scene kind is invalid')
    const entry = entryFor(configEditor)
    await configEditor.edit(entry, current => {
      if (revisionOf(current) !== body.expectedRevision) throw new Error('QQ_SETUP_CONFLICT')
      if (!(current.policy?.botIds ?? []).includes(scene.botId)) throw new TypeError('Scene bot is not configured')
      const field = scene.kind === 'group' ? 'groupIds' : 'privateIds'
      const ownerId = current.permissions?.ownerPrivateIds?.[0]
      if (!body.allowed && scene.kind === 'private' && scene.peerId === ownerId) throw new TypeError('Owner private Scene cannot be removed')
      const values = new Set(current.policy?.[field] ?? [])
      if (body.allowed) values.add(scene.peerId)
      else values.delete(scene.peerId)
      if (values.size > MAX_SCENES) throw new TypeError('Scene list is full')
      return {
        ...current, setupRevision: body.expectedRevision + 1,
        policy: { ...current.policy, [field]: [...values], epoch: (current.policy?.epoch ?? 0) + 1,
          pausedScenes: (current.policy?.pausedScenes ?? []).filter(key => key !== sceneKey(scene)) },
      }
    })
    return status()
  }

  async function pauseScene(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      typeof body.paused !== 'boolean') throw new TypeError('Pause request is invalid')
    const scene = { botId: requiredId(body.botId, 'botId'), kind: body.kind, peerId: requiredId(body.peerId, 'peerId') }
    if (!['group', 'private'].includes(scene.kind)) throw new TypeError('Scene kind is invalid')
    const entry = entryFor(configEditor)
    await configEditor.edit(entry, current => {
      if (revisionOf(current) !== body.expectedRevision) throw new Error('QQ_SETUP_CONFLICT')
      if (!(current.policy?.botIds ?? []).includes(scene.botId) ||
        !(current.policy?.[scene.kind === 'group' ? 'groupIds' : 'privateIds'] ?? []).includes(scene.peerId)) {
        throw new TypeError('Scene is not authorized')
      }
      const paused = new Set(current.policy?.pausedScenes ?? [])
      if (body.paused) paused.add(sceneKey(scene))
      else paused.delete(sceneKey(scene))
      return { ...current, setupRevision: body.expectedRevision + 1,
        policy: { ...current.policy, pausedScenes: [...paused] } }
    })
    return status()
  }

  async function saveAccount(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      typeof body.qzoneEnabled !== 'boolean' || typeof body.qzonePublish !== 'boolean' ||
      typeof body.qzoneLoopbackUrl !== 'string' || typeof body.qzoneTokenEnv !== 'string') {
      throw new TypeError('Account settings are invalid')
    }
    const url = body.qzoneLoopbackUrl ? localUrl(body.qzoneLoopbackUrl, ['http:', 'https:']) : ''
    if (body.qzoneTokenEnv && !/^[A-Z][A-Z0-9_]{0,99}$/.test(body.qzoneTokenEnv)) {
      throw new TypeError('QZone token environment variable name is invalid')
    }
    const entry = entryFor(configEditor)
    await configEditor.edit(entry, current => {
      if (revisionOf(current) !== body.expectedRevision) throw new Error('QQ_SETUP_CONFLICT')
      const botId = current.policy?.botIds?.[0]
      if (!botId) throw new TypeError('Configure Bot before account settings')
      const permissions = current.permissions ?? {}
      const accountGrants = permissions.accountGrants ?? {}
      return {
        ...current, setupRevision: body.expectedRevision + 1,
        qzoneEnabled: body.qzoneEnabled, qzoneLoopbackUrl: url, qzoneTokenEnv: body.qzoneTokenEnv,
        permissions: { ...permissions, accountGrants: {
          ...accountGrants, byBotId: { ...(accountGrants.byBotId ?? {}),
            [botId]: { ...(accountGrants.byBotId?.[botId] ?? {}), qzonePublish: body.qzonePublish } },
        } },
      }
    })
    return status()
  }

  return { status, save, setScene, pauseScene, saveAccount }
}
