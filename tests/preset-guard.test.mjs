import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_QQ_PERMISSION_LEVEL,
  MAX_QQ_PERMISSION_LEVEL,
  QQ_PERMISSION_LEVELS,
  QQ_TOOL_CONTRACT,
  QQ_TOOL_NAMES,
  apply,
  resolveQQPermissionPolicy,
  toolsForLevel,
} from '../src/preset-guard.mjs'

function fakeHost(initialSchemas, { restrictError = false } = {}) {
  const state = {
    guards: [],
    restrictions: [],
    schemas: initialSchemas.map(name => ({ name })),
    listeners: new Map(),
    presented: [],
    effects: [],
  }
  const ctx = {
    tools: {
      guard(fn) {
        state.guards.push(fn)
        return () => {}
      },
      restrict(filter) {
        if (restrictError) throw new Error('unknown global tool')
        const known = new Set(state.schemas.map(schema => schema.name))
        for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
          if (!known.has(name)) throw new Error(`unknown global tool "${name}"`)
        }
        state.restrictions.push(filter)
        return () => {}
      },
      schemas() {
        return state.schemas
      },
      presentAs(mode) {
        state.presented.push(mode)
      },
    },
    on(name, fn) {
      state.listeners.set(name, fn)
      return () => state.listeners.delete(name)
    },
    effect(fn) {
      state.effects.push(fn())
    },
  }
  return { ctx, state }
}

test('connector-disabled Session hides known host tools and still denies execution', () => {
  const { ctx, state } = fakeHost(['pwsh', 'memory_search', 'web_search'])
  apply(ctx, { level: 1 })
  assert.deepEqual(state.presented, ['native'])
  assert.equal(state.guards.length, 1)
  assert.match(state.guards[0]({ name: 'pwsh' }), /non-QQ tools/)
  assert.match(state.guards[0]({}), /non-QQ tools/)
  assert.match(state.guards[0]({ name: 'memory_search' }), /non-QQ tools/)
  assert.equal(state.guards[0]({ name: 'qq_send_message' }), undefined)
  assert.ok(state.restrictions.some(filter =>
    filter.deny?.includes('pwsh') && filter.deny?.includes('memory_search')))
  assert.ok(!state.restrictions.some(filter => filter.allow), 'allow mask waits for the complete QQ tool set')
  assert.equal(state.listeners.has('tools/change'), true)
})

test('visible restriction becomes the QQ allow list once the connector registers tools', () => {
  const { ctx, state } = fakeHost(['pwsh'])
  apply(ctx, { level: 1 })
  state.schemas = [...QQ_TOOL_NAMES.map(name => ({ name })), { name: 'pwsh' }]
  state.listeners.get('tools/change')()
  const allow = state.restrictions.find(filter => filter.allow)
  assert.deepEqual(allow.allow, toolsForLevel(1))
})

test('image reader is visible only in the enhanced QQ preset', () => {
  const basic = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(basic.ctx, { level: 1 })
  assert.match(basic.state.guards[0]({ name: 'qq_read_message_image' }), /permission level 1/)
  assert.equal(basic.state.restrictions.find(filter => filter.allow).allow.includes('qq_read_message_image'), false)

  const enhanced = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(enhanced.ctx, { level: 2 })
  assert.equal(enhanced.state.guards[0]({ name: 'qq_read_message_image' }), undefined)
  assert.equal(enhanced.state.restrictions.find(filter => filter.allow).allow.includes('qq_read_message_image'), true)
  assert.match(enhanced.state.guards[0]({ name: 'pwsh' }), /non-QQ tools/)
})

test('record transcription is visible only in the enhanced QQ preset', () => {
  const basic = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(basic.ctx, { level: 1 })
  assert.match(basic.state.guards[0]({ name: 'qq_transcribe_message_record' }), /permission level 1/)
  assert.equal(basic.state.restrictions.find(filter => filter.allow).allow.includes('qq_transcribe_message_record'), false)

  const enhanced = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(enhanced.ctx, { level: 2 })
  assert.equal(enhanced.state.guards[0]({ name: 'qq_transcribe_message_record' }), undefined)
  assert.equal(enhanced.state.restrictions.find(filter => filter.allow).allow.includes('qq_transcribe_message_record'), true)
  assert.match(enhanced.state.guards[0]({ name: 'pwsh' }), /non-QQ tools/)
})

test('level 0 keeps observation tools and denies sends', () => {
  const { ctx, state } = fakeHost(QQ_TOOL_NAMES)
  apply(ctx, { level: 0 })
  assert.equal(state.guards[0]({ name: 'qq_get_unread_messages' }), undefined)
  assert.match(state.guards[0]({ name: 'qq_send_message' }), /permission level 0/)
  assert.deepEqual(state.restrictions.find(filter => filter.allow).allow, toolsForLevel(0))
})

test('search preset requires the live QQ service to approve the bound Session on every call', () => {
  const { ctx, state } = fakeHost([...QQ_TOOL_NAMES, 'web_search'])
  let permitted = true
  ctx.get = name => name === 'qq' ? { authorizeSessionCapability: (sessionId, capability) =>
    sessionId === 'bound' && capability === 'dsh.search' && permitted } : undefined
  apply(ctx, { level: 1, allowSearch: true })
  const call = { name: 'web_search', agent: { session: { id: 'bound' } } }
  assert.equal(state.guards[0](call), undefined)
  permitted = false
  assert.match(state.guards[0](call), /QQ|search|permission/i)
  assert.match(state.guards[0]({ ...call, agent: { session: { id: 'unbound' } } }), /QQ|search|permission/i)
  const absent = fakeHost([...QQ_TOOL_NAMES, 'web_search'])
  apply(absent.ctx, { level: 1, allowSearch: true })
  assert.match(absent.state.guards[0](call), /QQ|search|permission/i,
    'disabled or missing connector must fail closed')
  const broken = fakeHost([...QQ_TOOL_NAMES, 'web_search'])
  broken.ctx.get = () => { throw new Error('service unavailable') }
  apply(broken.ctx, { level: 1, allowSearch: true })
  assert.match(broken.state.guards[0](call), /QQ|search|permission/i)
})

test('five permission levels form the declared extension ladder', () => {
  assert.equal(QQ_PERMISSION_LEVELS.length, 5)
  assert.deepEqual(QQ_PERMISSION_LEVELS.map(entry => entry.level), [0, 1, 2, 3, 4])
  assert.equal(MAX_QQ_PERMISSION_LEVEL, 4)
  assert.equal(DEFAULT_QQ_PERMISSION_LEVEL, 1)
  for (const name of QQ_TOOL_NAMES) {
    const level = QQ_TOOL_CONTRACT[name].level
    assert.ok(Number.isInteger(level) && level >= 0 && level <= MAX_QQ_PERMISSION_LEVEL, name)
    assert.ok(toolsForLevel(level).includes(name), name)
  }
})

test('invalid preset levels fail activation instead of falling back', () => {
  for (const level of [-1, 5, '1', 1.5, Number.NaN, null, {}]) {
    assert.throws(() => resolveQQPermissionPolicy({ level }), /level/, String(level))
  }
  assert.throws(() => resolveQQPermissionPolicy(null), /config/)
})

test('a PTC presentation conflict fails closed', () => {
  const { ctx } = fakeHost([])
  ctx.tools.presentAs = () => { throw new Error('presentation already declared') }
  assert.throws(() => apply(ctx, { level: 1 }), /native tool presentation/)
})

test('a failed visible restriction does not weaken the execution guard', () => {
  const { ctx, state } = fakeHost(['pwsh'], { restrictError: true })
  apply(ctx, { level: 1 })
  assert.equal(state.restrictions.length, 0)
  assert.match(state.guards[0]({ name: 'pwsh' }), /non-QQ tools/)
})
