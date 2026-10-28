import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply, makeDshHost } from '../src/index.js'
import {
  MEMORY_READ_TOOLS,
  MEMORY_SCENE_ACL_CONTRACT,
  MEMORY_SCENE_ACL_SERVICE,
  MEMORY_SCENE_ACL_VERSION,
} from '../src/preset-guard.mjs'
import { QQStore } from '../src/storage.js'

const MEMORY_CAPABILITY = Object.freeze({
  contract: MEMORY_SCENE_ACL_CONTRACT,
  version: MEMORY_SCENE_ACL_VERSION,
  trustedSceneAcl: true,
  strictQQ: true,
  tools: MEMORY_READ_TOOLS,
})

function setMemoryDeclaration(services) {
  services.set(MEMORY_SCENE_ACL_SERVICE, { sceneAclRead: () => MEMORY_CAPABILITY })
  return services
}

test('installed package exports a persistent QQ preset guard', async () => {
  const module = await import('@amadeus/qq/preset-guard')
  let guard
  module.apply({ tools: {
    guard: fn => { guard = fn },
    restrict: () => {},
  } })
  assert.equal(typeof guard, 'function')
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(guard({ name }), /Memory|non-QQ/i,
      `${name} must stay closed without the Memory declaration`)
  }
  assert.match(guard({ name: 'memory_save' }), /non-QQ|Memory/i)
  assert.match(guard({ name: 'pwsh' }), /non-QQ tools/)
  assert.equal(guard({ name: 'qq_send_message' }), undefined)
})

test('package root branches to the preset guard before connector startup', () => {
  let guard
  const ctx = {
    tools: {
      guard: fn => { guard = fn },
      restrict: () => {},
    },
  }
  apply(ctx, { presetGuard: true })
  assert.equal(typeof guard, 'function')
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(guard({ name }), /Memory|non-QQ/i,
      `${name} must stay closed without the Memory declaration`)
  }
  assert.match(guard({ name: 'memory_save' }), /non-QQ|Memory/i)
  assert.match(guard({ name: 'pwsh' }), /non-QQ tools/)
  assert.equal(guard({ name: 'qq_send_message' }), undefined)
})

test('package root opens Memory readers only through the declared Cordis contract', () => {
  let guard
  const services = setMemoryDeclaration(new Map())
  const ctx = {
    tools: { guard: fn => { guard = fn }, restrict: () => {} },
    reflect: { get: name => services.get(name) },
  }
  apply(ctx, { presetGuard: true })
  for (const name of MEMORY_READ_TOOLS) assert.equal(guard({ name }), undefined, name)
  assert.match(guard({ name: 'memory_save' }), /non-QQ|Memory/i)
})

test('package root forwards search preset config to its guarded tool surface', () => {
  let guard
  const ctx = {
    tools: { guard: fn => { guard = fn }, restrict: () => {} },
    get: name => name === 'qq' ? { authorizeSessionCapability: () => true } : undefined,
  }
  apply(ctx, { presetGuard: true, allowSearch: true })
  assert.equal(guard({ name: 'web_search', agent: { session: { id: 'bound' } } }), undefined)
  assert.match(guard({ name: 'web_fetch', agent: { session: { id: 'bound' } } }), /non-QQ/)
})

function fakeHost() {
  const tools = new Map()
  const guards = []
  const effects = []
  const services = new Map()
  const ctx = {
    tools: { register: def => tools.set(def.name, def), guard: fn => guards.push(fn) },
    sessionController: { create: async () => ({ sessionId: 'unused' }), prompt: async () => ({ accepted: true }), resolveAgent: async () => ({ ctx: { tools: { restrict() {} } } }) },
    provide: (key, value) => services.set(key, value),
    reflect: { get: name => services.get(name) },
    effect: fn => effects.push(fn()),
  }
  return { ctx, tools, guards, effects, services }
}

test('plugin starts disabled and cannot acquire an implicit production state path', t => {
  const host = fakeHost()
  apply(host.ctx, {})
  assert.equal(host.services.get('qq').getHealth().enabled, false)
  assert.equal(host.tools.size, 0)
  assert.throws(() => apply(fakeHost().ctx, { enabled: true }), /statePath/)
})

test('general coding presets cannot create persistent QQ Sessions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-preset-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, 'qq.json')
  for (const agentPreset of ['cordis', 'standard', ' CORDIS ', 'unverified-custom-preset']) {
    assert.throws(() => apply(fakeHost().ctx, {
      enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset,
    }), /QQ_UNSAFE_PRESET/)
    assert.equal(fs.existsSync(statePath), false)
    assert.equal(fs.existsSync(`${statePath}.lock`), false)
  }
})

test('DSH host creates the packaged preset without a per-Agent restriction API', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-host-api-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const calls = []
  const ctx = { sessionController: {
    async create(request) { calls.push(request); return { sessionId: 'new-qq-session', agentPreset: request.agentPreset } },
    async prompt() { return { accepted: true } },
    async cancel() { return { accepted: true } },
  } }
  const host = makeDshHost(ctx, { sessionCwd: dir, agentPreset: 'amadeus-qq' })
  assert.deepEqual(await host.createSceneSession(), { sessionId: 'new-qq-session', agentPreset: 'amadeus-qq' })
  assert.deepEqual(calls, [{ cwd: dir, agentPreset: 'amadeus-qq' }])
  assert.deepEqual(await host.createSceneSession({}, { searchAllowed: true }),
    { sessionId: 'new-qq-session', agentPreset: 'amadeus-qq-search' })
  assert.deepEqual(calls.at(-1), { cwd: dir, agentPreset: 'amadeus-qq-search' })
  assert.deepEqual(await host.createSceneSession({}, { mediaAllowed: true }),
    { sessionId: 'new-qq-session', agentPreset: 'amadeus-qq-media' })
  assert.deepEqual(await host.createSceneSession({}, { mediaAllowed: true, searchAllowed: true }),
    { sessionId: 'new-qq-session', agentPreset: 'amadeus-qq-media-search' })
  assert.deepEqual(await host.createSceneSession({}, { ownerAgent: true }),
    { sessionId: 'new-qq-session', agentPreset: 'amadeus-qq-owner' })
  const swapped = makeDshHost({ sessionController: {
    create: async () => ({ sessionId: 'unsafe', agentPreset: 'cordis' }),
    prompt: async () => ({ accepted: true }),
  } }, { sessionCwd: dir, agentPreset: 'amadeus-qq' })
  await assert.rejects(swapped.createSceneSession(), /QQ_UNSAFE_PRESET/)
})

test('host guard denies every non-QQ tool for persisted QQ Session and tool args cannot forge scene', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-host-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, 'qq.json')
  const store = new QQStore(statePath)
  store.bindSession({ botId: '10001', kind: 'private', peerId: '30001' }, 'qq-session')
  const host = fakeHost()
  apply(host.ctx, {
    enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
  })
  const exec = { agent: { session: { id: 'qq-session' } } }
  assert.equal(host.guards.length, 1)
  assert.match(host.guards[0]({ ...exec, name: 'pwsh' }), /non-QQ tools/)
  assert.match(host.guards[0]({ ...exec, name: 'web_search' }), /search permission/,
    'safe-chat no longer inherits search')
  assert.equal(host.services.get('qq').authorizeSessionCapability('qq-session', 'dsh.search'), false)
  assert.equal(host.services.get('qq').authorizeSessionCapability('not-bound', 'dsh.search'), false)
  assert.equal(host.guards[0]({ ...exec, name: 'qq_send_message' }), undefined)
  assert.equal(host.guards[0]({ agent: { session: { id: 'unrelated' } }, name: 'pwsh' }), undefined)
  assert.ok(host.tools.has('qq_wait_for_messages'))
  assert.ok(host.tools.has('qq_send_message'))
  await assert.rejects(host.tools.get('qq_send_message').execute({
    actionId: 'x', segments: [{ type: 'text', data: { text: 'Hi' } }], sceneId: 'private:someone-else',
  }, exec), /unknown QQ tool argument/)
  assert.equal((await host.tools.get('qq_connection_status').execute({}, exec)).enabled, true)
  for (const effect of host.effects.reverse()) effect()
  assert.equal(fs.existsSync(`${statePath}.lock`), false)
})

test('connector guard requires the Memory Scene ACL declaration for ordinary group reads', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-memory-read-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, 'qq.json')
  const store = new QQStore(statePath)
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  const owner = { botId: '10001', kind: 'private', peerId: '30001' }
  store.setScenePermissions(owner, { mode: 'owner-agent' })
  store.bindSession(group, 'group-session')
  store.bindSession(owner, 'owner-session')
  const host = fakeHost()
  host.ctx.tools.schemas = () => [
    { name: 'memory_search' }, { name: 'memory_list' }, { name: 'memory_get' },
    { name: 'memory_save' }, { name: 'memory_delete' }, { name: 'memory_future' },
    { name: 'pwsh' },
  ]
  apply(host.ctx, {
    enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: ['20001'] },
    permissions: { ownerPrivateIds: ['30001'] },
  })
  const guard = host.guards[0]
  const call = (id, name, args = {}) => guard({ name, arguments: args, agent: { session: { id } } })

  // No declaration: an old/upstream Mneme must not expose Scene-unscoped reads.
  for (const name of ['memory_search', 'memory_list', 'memory_get']) {
    assert.match(call('group-session', name, { scenes: ['qq:group:10001:20002'] }),
      /Memory|non-QQ/i, `${name} must fail closed without the declaration`)
  }
  // Owner's pre-existing generic host-tool path is unchanged, declaration or not.
  assert.equal(call('owner-session', 'memory_search'), undefined)
  assert.equal(call('owner-session', 'memory_save'), undefined)
  assert.equal(call('owner-session', 'pwsh'), undefined)

  setMemoryDeclaration(host.services)
  for (const name of ['memory_search', 'memory_list', 'memory_get']) {
    assert.equal(call('group-session', name, { scenes: ['qq:group:10001:20002'] }), undefined,
      `${name} must be callable by an ordinary group Session after the declaration`)
  }
  for (const name of ['memory_save', 'memory_delete', 'memory_future', 'pwsh']) {
    assert.match(call('group-session', name), /non-QQ tools/, `${name} must stay denied`)
  }

  // A malformed/legacy declaration or a withdrawal closes the ordinary path
  // again; the Owner path above is unaffected.
  host.services.set(MEMORY_SCENE_ACL_SERVICE, {
    sceneAclRead: () => ({ ...MEMORY_CAPABILITY, strictQQ: false }),
  })
  for (const name of ['memory_search', 'memory_list', 'memory_get']) {
    assert.match(call('group-session', name), /Memory|non-QQ/i,
      `${name} must fail closed after the declaration is invalidated`)
  }
  host.services.delete(MEMORY_SCENE_ACL_SERVICE)
  for (const name of ['memory_search', 'memory_list', 'memory_get']) {
    assert.match(call('group-session', name), /Memory|non-QQ/i,
      `${name} must fail closed after the declaration is withdrawn`)
  }
  for (const effect of host.effects.reverse()) effect()
})

test('connector execution guard admits registered Life tools only for a live Owner private Session', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-owner-host-tool-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, 'qq.json')
  const store = new QQStore(statePath)
  const owner = { botId: '10001', kind: 'private', peerId: '30001' }
  const ordinary = { botId: '10001', kind: 'private', peerId: '30002' }
  const group = { botId: '10001', kind: 'group', peerId: '20001' }
  store.setScenePermissions(owner, { mode: 'owner-agent' })
  store.bindSession(owner, 'owner-session')
  store.bindSession(ordinary, 'friend-session')
  store.bindSession(group, 'group-session')
  const host = fakeHost()
  host.ctx.tools.schemas = () => [{ name: 'life_intent_create' }, { name: 'pwsh' }, { name: 'run_code' }]
  apply(host.ctx, {
    enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001', '30002'], groupIds: ['20001'] },
    permissions: { ownerPrivateIds: ['30001'] },
  })
  const guard = host.guards[0]
  const call = (id, name) => guard({ name, agent: { session: { id } } })
  assert.equal(call('owner-session', 'life_intent_create'), undefined)
  assert.equal(call('owner-session', 'pwsh'), undefined)
  assert.match(call('owner-session', 'run_code'), /non-QQ tools/)
  assert.match(call('owner-session', 'not_registered'), /non-QQ tools/)
  assert.match(call('friend-session', 'life_intent_create'), /non-QQ tools/)
  assert.match(call('group-session', 'life_intent_create'), /non-QQ tools/)
  for (const effect of host.effects.reverse()) effect()
  store.setScenePermissions(owner, { mode: 'safe-chat' })
  const restarted = fakeHost()
  restarted.ctx.tools.schemas = host.ctx.tools.schemas
  apply(restarted.ctx, {
    enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001', '30002'], groupIds: ['20001'] },
    permissions: { ownerPrivateIds: ['30001'] },
  })
  assert.match(restarted.guards[0]({ name: 'life_intent_create', agent: { session: { id: 'owner-session' } } }), /non-QQ tools/)
  for (const effect of restarted.effects.reverse()) effect()
})

test('native PTT transcription is always registered with a messageId-only schema', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-native-tool-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const host = fakeHost()
  apply(host.ctx, {
    enabled: true, connect: false, statePath: path.join(dir, 'qq.json'),
    sessionCwd: dir, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
  })
  const tool = host.tools.get('qq_transcribe_message_record_native')
  assert.ok(tool, 'native PTT transcription does not depend on optional attachment or ASR services')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['messageId'])
  await assert.rejects(tool.execute({ messageId: '701', file: '/private/voice.wav' },
    { agent: { session: { id: 'unbound' } } }), /unknown QQ tool argument/)
  for (const effect of host.effects.reverse()) effect()
})

test('image tool takes only message identity and ordinal, never a model supplied locator', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-image-tool-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const host = fakeHost()
  host.ctx.attachments = { saveImage: async () => ({ attachmentId: 'unused' }) }
  host.ctx.inject = (_services, fn) => fn(host.ctx)
  apply(host.ctx, {
    enabled: true, connect: false, statePath: path.join(dir, 'qq.json'),
    sessionCwd: dir, agentPreset: 'amadeus-qq', mediaRoot: dir,
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
  })
  const imageTool = host.tools.get('qq_read_message_image')
  assert.ok(imageTool, 'enhanced QQ media reader must be registered')
  assert.deepEqual(Object.keys(imageTool.parameters.properties).sort(), ['index', 'messageId'])
  const rendered = imageTool.output.render({}, { attachment: { attachmentId: 'sha256:test', mediaType: 'image/png' } })
  assert.deepEqual(rendered.map(item => item.type), ['text', 'image'])
  assert.equal(JSON.stringify(rendered).includes(dir), false)
  await assert.rejects(imageTool.execute({ messageId: '701', path: 'C:\\private\\secret.png' },
    { agent: { session: { id: 'unbound' } } }), /unknown QQ tool argument/)
  for (const effect of host.effects.reverse()) effect()
})

test('missing attachment injection leaves ordinary QQ text tools available', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-no-attachments-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const host = fakeHost()
  host.ctx.inject = () => { throw new Error('optional attachment service absent') }
  assert.doesNotThrow(() => apply(host.ctx, {
    enabled: true, connect: false, statePath: path.join(dir, 'qq.json'),
    sessionCwd: dir, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
  }))
  assert.ok(host.tools.has('qq_send_message'))
  assert.equal(host.tools.has('qq_read_message_image'), false)
  assert.equal(host.tools.has('qq_read_message_file'), false)
  assert.equal(host.tools.has('qq_read_message_video'), false)
  for (const effect of host.effects.reverse()) effect()
})

test('file and video tools require saveFile and take only message identity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-file-tool-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const host = fakeHost()
  host.ctx.inject = (_services, fn) => fn(host.ctx)
  host.ctx.attachments = {
    async saveFile(input) {
      return { attachmentId: 'sha256:file-tool', name: input.name, bytes: input.data.length }
    },
  }
  apply(host.ctx, {
    enabled: true, connect: false, statePath: path.join(dir, 'qq.json'),
    sessionCwd: dir, agentPreset: 'amadeus-qq', mediaRoot: dir,
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
  })
  const fileTool = host.tools.get('qq_read_message_file')
  const videoTool = host.tools.get('qq_read_message_video')
  assert.ok(fileTool)
  assert.ok(videoTool)
  assert.equal(host.tools.has('qq_read_message_image'), false)
  for (const tool of [fileTool, videoTool]) {
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['index', 'messageId'])
    const rendered = tool.output.render({}, { attachment: { attachmentId: 'sha256:test', name: 'qq-file', bytes: 1 } })
    assert.deepEqual(rendered.map(item => item.type), ['text', 'file'])
    await assert.rejects(tool.execute({ messageId: '701', path: 'C:\\private\\secret' },
      { agent: { session: { id: 'unbound' } } }), /unknown QQ tool argument/)
  }
  for (const effect of host.effects.reverse()) effect()
})

test('record transcription registers only with an explicit provider and live speech service', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-audio-tool-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const make = (asrProviderId, withService) => {
    const host = fakeHost()
    host.ctx.inject = (_services, fn) => fn(host.ctx)
    if (withService) host.ctx.speechToText = {
      listProviders: () => [{ id: 'local-qa', location: 'host-local' }],
      resolve: spec => spec,
      transcribe: async () => ({ text: 'unused' }),
    }
    apply(host.ctx, {
      enabled: true, connect: false, statePath: path.join(dir, `${asrProviderId || 'none'}-${withService}.json`),
      sessionCwd: dir, agentPreset: 'amadeus-qq', asrProviderId,
      policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
    })
    return host
  }
  const enabled = make('local-qa', true)
  const audioTool = enabled.tools.get('qq_transcribe_message_record')
  assert.ok(audioTool, 'explicit local ASR provider must register the transcription tool')
  assert.deepEqual(Object.keys(audioTool.parameters.properties).sort(), ['index', 'messageId'])
  assert.equal(enabled.tools.has('qq_read_message_image'), false)
  assert.ok(enabled.tools.has('qq_send_message'))
  await assert.rejects(audioTool.execute(
    { messageId: '701', providerId: 'remote-qa' },
    { agent: { session: { id: 'unbound' } } },
  ), /unknown QQ tool argument/)

  assert.equal(make('', true).tools.has('qq_transcribe_message_record'), false,
    'no configured provider id must not register the tool')
  assert.equal(make('local-qa', false).tools.has('qq_transcribe_message_record'), false,
    'missing speech service must not register the tool')
  for (const host of [enabled]) for (const effect of host.effects.reverse()) effect()
})

test('connector startup failure emits a bounded diagnostic instead of disappearing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-startup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const host = fakeHost()
  const diagnostics = []
  host.ctx.logger = { error: message => diagnostics.push(String(message)) }
  apply(host.ctx, {
    enabled: true, connect: true,
    statePath: path.join(dir, 'qq.json'), sessionCwd: dir, agentPreset: 'amadeus-qq',
    httpUrl: 'invalid', wsUrl: 'invalid',
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /transport|OneBot/i)
  assert.ok(!diagnostics[0].includes(dir), 'diagnostic must not expose local state paths')
  for (const effect of host.effects.reverse()) effect()
})

test('connector registers the Owner workspace only with a live configured root', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-owner-reg-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'owner')
  fs.mkdirSync(root)
  const host = fakeHost()
  apply(host.ctx, {
    enabled: true, connect: false,
    statePath: path.join(dir, 'qq.json'), sessionCwd: dir, agentPreset: 'amadeus-qq',
    ownerWorkspaceRoot: root, ownerWorkspaceWrites: false,
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: ['20001'] },
  })
  assert.ok(host.tools.has('qq_owner_workspace'))
  for (const effect of host.effects.reverse()) effect()

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-owner-unset-'))
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }))
  const unset = fakeHost()
  apply(unset.ctx, {
    enabled: true, connect: false,
    statePath: path.join(bare, 'qq.json'), sessionCwd: bare, agentPreset: 'amadeus-qq',
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: ['20001'] },
  })
  assert.equal(unset.tools.has('qq_owner_workspace'), false)
  for (const effect of unset.effects.reverse()) effect()
})
