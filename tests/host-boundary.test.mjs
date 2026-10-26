import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply, makeDshHost } from '../src/index.js'
import { QQStore } from '../src/storage.js'

test('installed package exports a persistent QQ preset guard', async () => {
  const module = await import('@amadeus/qq/preset-guard')
  let guard
  module.apply({ tools: {
    guard: fn => { guard = fn },
    restrict: () => {},
  } })
  assert.equal(typeof guard, 'function')
  assert.match(guard({ name: 'memory_search' }), /non-QQ tools/)
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
  assert.match(guard({ name: 'memory_search' }), /non-QQ tools/)
  assert.match(guard({ name: 'pwsh' }), /non-QQ tools/)
  assert.equal(guard({ name: 'qq_send_message' }), undefined)
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
  assert.equal(host.guards[0]({ ...exec, name: 'web_search' }), undefined,
    'safe-chat search may execute only after the bound Scene is checked')
  assert.equal(host.services.get('qq').authorizeSessionCapability('qq-session', 'dsh.search'), true)
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
  for (const effect of host.effects.reverse()) effect()
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
