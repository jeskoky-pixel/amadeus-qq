import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/index.js'
import { QQStore } from '../src/storage.js'

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
  for (const agentPreset of ['cordis', 'standard', ' CORDIS ']) {
    assert.throws(() => apply(fakeHost().ctx, {
      enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset,
    }), /QQ_UNSAFE_PRESET/)
    assert.equal(fs.existsSync(statePath), false)
    assert.equal(fs.existsSync(`${statePath}.lock`), false)
  }
})

test('host guard denies every non-QQ tool for persisted QQ Session and tool args cannot forge scene', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-host-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, 'qq.json')
  const store = new QQStore(statePath)
  store.bindSession({ botId: '10001', kind: 'private', peerId: '30001' }, 'qq-session')
  const host = fakeHost()
  apply(host.ctx, {
    enabled: true, connect: false, statePath, sessionCwd: dir, agentPreset: 'restricted-qq',
    policy: { botIds: ['10001'], privateIds: ['30001'], groupIds: [] },
  })
  const exec = { agent: { session: { id: 'qq-session' } } }
  assert.equal(host.guards.length, 1)
  assert.match(host.guards[0]({ ...exec, name: 'pwsh' }), /non-QQ tools/)
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
