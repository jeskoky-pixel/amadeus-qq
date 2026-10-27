import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_QQ_PERMISSION_LEVEL,
  MAX_QQ_PERMISSION_LEVEL,
  MEMORY_READ_TOOLS,
  MEMORY_SCENE_ACL_CONTRACT,
  MEMORY_SCENE_ACL_SERVICE,
  MEMORY_SCENE_ACL_VERSION,
  QQ_PERMISSION_LEVELS,
  QQ_TOOL_CONTRACT,
  QQ_TOOL_NAMES,
  apply,
  resolveQQPermissionPolicy,
  toolsForLevel,
} from '../src/preset-guard.mjs'
import { OWNER_WORKSPACE_CAPABILITY, OWNER_WORKSPACE_TOOL, providerStatus, resetProviderStatus } from '../src/owner-workspace.js'

function fakeHost(initialSchemas, { restrictError = false, emitOnRestrict = false } = {}) {
  const state = {
    guards: [],
    restrictions: [],
    schemas: initialSchemas.map(name => ({ name })),
    listeners: new Map(),
    presented: [],
    effects: [],
    restrictCalls: 0,
  }
  const services = new Map()
  const emitChange = () => {
    if (emitOnRestrict) state.listeners.get('tools/change')?.()
  }
  const ctx = {
    tools: {
      guard(fn) {
        state.guards.push(fn)
        return () => {}
      },
      register(definition) {
        state.schemas = [...state.schemas, { name: definition.name }]
        return () => {}
      },
      restrict(filter) {
        if (restrictError) throw new Error('unknown global tool')
        state.restrictCalls += 1
        const known = new Set(state.schemas.map(schema => schema.name))
        for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
          if (!known.has(name)) throw new Error(`unknown global tool "${name}"`)
        }
        state.restrictions.push(filter)
        emitChange()
        let active = true
        return () => {
          if (!active) return
          active = false
          emitChange()
        }
      },
      schemas() {
        return state.schemas
      },
      presentAs(mode) {
        state.presented.push(mode)
      },
    },
    reflect: {
      get(name) {
        return services.get(name)
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
  return { ctx, state, services }
}

const MEMORY_CAPABILITY = Object.freeze({
  contract: MEMORY_SCENE_ACL_CONTRACT,
  version: MEMORY_SCENE_ACL_VERSION,
  trustedSceneAcl: true,
  strictQQ: true,
  tools: MEMORY_READ_TOOLS,
})

function setMemoryDeclaration(host, declaration = MEMORY_CAPABILITY) {
  if (declaration === null) {
    host.services.delete(MEMORY_SCENE_ACL_SERVICE)
  } else {
    host.services.set(MEMORY_SCENE_ACL_SERVICE, { sceneAclRead: () => declaration })
  }
  return host
}

function notifyMemoryService(host) {
  host.state.listeners.get('internal/service')?.(MEMORY_SCENE_ACL_SERVICE)
}

const exec = (name, args = {}) => ({ name, arguments: args, agent: { session: { id: 'bound' } } })
const latestAllow = state => state.restrictions.filter(filter => filter.allow).at(-1)?.allow ?? []

test('connector-disabled Session hides host tools and Memory readers without a declaration', () => {
  const { ctx, state } = fakeHost(['pwsh', 'memory_search', 'memory_list', 'memory_get', 'web_search'])
  apply(ctx, { level: 1 })
  assert.deepEqual(state.presented, ['native'])
  assert.equal(state.guards.length, 1)
  assert.match(state.guards[0]({ name: 'pwsh' }), /non-QQ tools/)
  assert.match(state.guards[0]({}), /non-QQ tools/)
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(state.guards[0]({ name }), /Memory|non-QQ/i, name)
  }
  assert.equal(state.guards[0]({ name: 'qq_send_message' }), undefined)
  assert.ok(state.restrictions.some(filter =>
    filter.deny?.includes('pwsh') && filter.deny?.includes('web_search')))
  assert.ok(state.restrictions.some(filter =>
    filter.deny?.some(name => MEMORY_READ_TOOLS.includes(name))), 'Memory readers hidden without declaration')
  assert.ok(!state.restrictions.some(filter => filter.allow), 'allow mask waits for the complete QQ tool set')
  assert.equal(state.listeners.has('tools/change'), true)
  assert.equal(state.listeners.has('internal/service'), true)
})

test('synchronous tools/change from restrict stays bounded and does not stall activation', () => {
  const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS], { emitOnRestrict: true })
  assert.doesNotThrow(() => apply(host.ctx, { level: 1 }))
  const afterLoad = host.state.restrictCalls
  assert.ok(afterLoad <= 20, `startup restrict calls: ${afterLoad}`)

  host.state.listeners.get('tools/change')()
  assert.ok(host.state.restrictCalls - afterLoad <= 6,
    `one tools/change must not re-enter restrict: ${host.state.restrictCalls - afterLoad}`)

  host.state.schemas.push({ name: 'pwsh' })
  host.state.listeners.get('tools/change')()
  assert.ok(host.state.restrictCalls - afterLoad <= 12,
    `late non-QQ registration must stay bounded: ${host.state.restrictCalls - afterLoad}`)
  assert.match(host.state.guards[0](exec('memory_search')), /Memory|non-QQ/i)
  assert.match(host.state.guards[0](exec('pwsh')), /non-QQ tools/)
})

test('a declared trusted Scene ACL contract opens exactly the three Memory readers', () => {
  const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
  setMemoryDeclaration(host)
  apply(host.ctx, { level: 1 })
  const guard = host.state.guards[0]
  const allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) {
    assert.equal(guard(exec(name)), undefined, name)
    assert.ok(allow.includes(name), `${name} must be visible`)
  }
  assert.match(guard(exec('pwsh')), /non-QQ tools/)
  assert.equal(allow.includes('pwsh'), false)
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

test('record transcription is visible in Safe Chat only for native PTT; local ASR stays Enhanced', () => {
  const basic = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(basic.ctx, { level: 1 })
  assert.match(basic.state.guards[0]({ name: 'qq_transcribe_message_record' }), /permission level 1/)
  assert.equal(basic.state.restrictions.find(filter => filter.allow).allow.includes('qq_transcribe_message_record'), false)
  assert.equal(basic.state.guards[0]({ name: 'qq_transcribe_message_record_native' }), undefined)
  assert.equal(basic.state.restrictions.find(filter => filter.allow).allow.includes('qq_transcribe_message_record_native'), true)

  const observe = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(observe.ctx, { level: 0 })
  assert.match(observe.state.guards[0]({ name: 'qq_transcribe_message_record_native' }), /permission level 0/)
  assert.equal(observe.state.restrictions.find(filter => filter.allow).allow.includes('qq_transcribe_message_record_native'), false)

  const enhanced = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(enhanced.ctx, { level: 2 })
  for (const name of ['qq_transcribe_message_record', 'qq_transcribe_message_record_native']) {
    assert.equal(enhanced.state.guards[0]({ name }), undefined)
    assert.equal(enhanced.state.restrictions.find(filter => filter.allow).allow.includes(name), true)
  }
  assert.match(enhanced.state.guards[0]({ name: 'pwsh' }), /non-QQ tools/)
})

test('file and video readers are visible only in the enhanced QQ preset', () => {
  const basic = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(basic.ctx, { level: 1 })
  for (const name of ['qq_read_message_file', 'qq_read_message_video']) {
    assert.match(basic.state.guards[0]({ name }), /permission level 1/)
    assert.equal(basic.state.restrictions.find(filter => filter.allow).allow.includes(name), false)
  }

  const enhanced = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(enhanced.ctx, { level: 2 })
  for (const name of ['qq_read_message_file', 'qq_read_message_video']) {
    assert.equal(enhanced.state.guards[0]({ name }), undefined)
    assert.equal(enhanced.state.restrictions.find(filter => filter.allow).allow.includes(name), true)
  }
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

function withCapabilities(host, capabilities) {
  host.ctx.get = name => name === 'qq'
    ? { authorizeSessionCapability: (_sessionId, capability) => capabilities.has(capability) }
    : undefined
  return host
}

test('ordinary QQ presets expose exactly the Scene-scoped Memory readers when the contract is present', () => {
  const deniedMemoryTools = [
    'memory_save', 'memory_update', 'memory_delete', 'memory_forget', 'memory_archive',
    'memory_register_document', 'memory_organize', 'memory_runtime', 'memory_core_save',
    'memory_preference_get', 'memory_identity_lookup', 'memory_scope_set', 'memory_future_tool',
  ]
  for (const level of [0, 1, 2, 3]) {
    const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, ...deniedMemoryTools, 'pwsh'])
    setMemoryDeclaration(host)
    apply(host.ctx, { level })
    const guard = host.state.guards[0]
    const allow = latestAllow(host.state)
    for (const name of MEMORY_READ_TOOLS) {
      // Model arguments such as `scenes` are forwarded to Memory; they are not
      // an authorization input here. Memory narrows/filters them server-side.
      assert.equal(guard(exec(name, { scenes: ['qq:group:10001:20002'] })), undefined,
        `level ${level} ${name} must be callable`)
      assert.ok(allow.includes(name), `level ${level} ${name} must be visible`)
    }
    for (const name of deniedMemoryTools) {
      assert.match(guard(exec(name)), /non-QQ|Memory/i, `level ${level} ${name} must be denied`)
      assert.equal(allow.includes(name), false, `level ${level} ${name} must stay hidden`)
    }
    assert.match(guard(exec('pwsh')), /non-QQ tools/, `level ${level} pwsh must be denied`)
    assert.equal(allow.includes('pwsh'), false, `level ${level} pwsh must stay hidden`)
    assert.deepEqual([...allow].sort(), [...toolsForLevel(level), ...MEMORY_READ_TOOLS].sort(),
      `level ${level} mask must contain only the QQ contract and the three Memory readers`)
  }
})

test('without the Memory declaration the readers stay denied and hidden at every ordinary level', () => {
  for (const level of [0, 1, 2, 3]) {
    const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
    apply(host.ctx, { level })
    const guard = host.state.guards[0]
    const allow = latestAllow(host.state)
    for (const name of MEMORY_READ_TOOLS) {
      assert.match(guard(exec(name)), /Memory|non-QQ/i, `level ${level} ${name} must fail closed`)
      assert.equal(allow.includes(name), false, `level ${level} ${name} must stay hidden`)
    }
    assert.ok(host.state.restrictions.some(filter =>
      filter.deny?.some(name => MEMORY_READ_TOOLS.includes(name))),
    `level ${level} must install a visibility deny for the readers`)
  }
})

test('search-enabled ordinary QQ presets also expose the three Memory readers with the contract', () => {
  const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'web_search', 'pwsh'])
  setMemoryDeclaration(host)
  apply(host.ctx, { level: 1, allowSearch: true })
  const allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) assert.ok(allow.includes(name), name)
  assert.ok(allow.includes('web_search'))
  assert.match(host.state.guards[0](exec('pwsh')), /non-QQ tools/)
})

test('preset-row declarations cannot widen or re-scope the Memory tool set', () => {
  const forged = {
    level: 1,
    memoryTools: ['memory_save', 'memory_delete'],
    allowedTools: ['memory_save'],
    allowMemoryWrites: true,
    scenes: ['qq:group:10001:20002'],
    scene: 'qq:group:10001:20002',
    memorySceneAcl: { trustedSceneAcl: true, tools: MEMORY_READ_TOOLS },
  }
  const policy = resolveQQPermissionPolicy(forged)
  assert.deepEqual(policy.tools.filter(name => name.startsWith('memory_')), [],
    'the static preset policy never contains Memory tools')

  const bare = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'memory_save', 'pwsh'])
  apply(bare.ctx, forged)
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(bare.state.guards[0](exec(name)), /Memory|non-QQ/i,
      'a preset-row field cannot substitute for the live service declaration')
    assert.equal(latestAllow(bare.state).includes(name), false)
  }

  const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'memory_save', 'memory_delete', 'pwsh'])
  setMemoryDeclaration(host)
  apply(host.ctx, forged)
  const guard = host.state.guards[0]
  const allow = latestAllow(host.state)
  for (const name of ['memory_save', 'memory_delete']) {
    assert.match(guard(exec(name, { scenes: ['qq:private:10001:30001'] })), /non-QQ|Memory/i)
    assert.equal(allow.includes(name), false)
  }
  for (const name of MEMORY_READ_TOOLS) assert.equal(guard(exec(name)), undefined)
})

test('Memory tools registered after preset start stay hidden until the contract is declared', () => {
  const host = fakeHost([...QQ_TOOL_NAMES, 'pwsh'])
  apply(host.ctx, { level: 1 })
  const guard = host.state.guards[0]
  let allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) assert.equal(allow.includes(name), false, name)

  host.state.schemas.push({ name: 'memory_search' }, { name: 'memory_save' })
  host.state.listeners.get('tools/change')()
  assert.match(guard(exec('memory_search')), /Memory|non-QQ/i)
  assert.equal(latestAllow(host.state).includes('memory_search'), false)

  // A reader registered after the first deny must also be covered.
  host.state.schemas.push({ name: 'memory_list' }, { name: 'memory_get' }, { name: 'memory_delete' })
  host.state.listeners.get('tools/change')()
  allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) {
    assert.equal(allow.includes(name), false, `${name} must stay hidden without the declaration`)
    assert.match(guard(exec(name)), /Memory|non-QQ/i, `${name} must stay denied without the declaration`)
  }

  setMemoryDeclaration(host)
  notifyMemoryService(host)
  allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) {
    assert.ok(allow.includes(name), `${name} must become visible after the declaration`)
    assert.equal(guard(exec(name)), undefined, `${name} must become callable after the declaration`)
  }
  for (const name of ['memory_save', 'memory_delete']) {
    assert.equal(allow.includes(name), false, `${name} must stay hidden`)
    assert.match(guard(exec(name)), /non-QQ|Memory/i, `${name} must stay denied`)
  }
})

test('a QQ Host service change refreshes the Memory declaration gate', () => {
  const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
  apply(host.ctx, { level: 1 })
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(host.state.guards[0](exec(name)), /Memory|non-QQ/i)
  }
  setMemoryDeclaration(host)
  host.state.listeners.get('internal/service')?.('qq')
  const allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) {
    assert.equal(host.state.guards[0](exec(name)), undefined, name)
    assert.ok(allow.includes(name), name)
  }
})

test('malformed, old or incomplete Memory declarations fail closed', () => {
  const declarations = [
    null,
    false,
    {},
    { ...MEMORY_CAPABILITY, contract: 'amadeus-memory/legacy' },
    { ...MEMORY_CAPABILITY, version: 0 },
    { ...MEMORY_CAPABILITY, trustedSceneAcl: false },
    { ...MEMORY_CAPABILITY, strictQQ: false },
    { ...MEMORY_CAPABILITY, tools: ['memory_search'] },
    { ...MEMORY_CAPABILITY, tools: 'memory_search,memory_list,memory_get' },
  ]
  for (const declaration of declarations) {
    const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
    if (declaration === null) {
      host.services.delete(MEMORY_SCENE_ACL_SERVICE)
    } else {
      host.services.set(MEMORY_SCENE_ACL_SERVICE, { sceneAclRead: () => declaration })
    }
    apply(host.ctx, { level: 1 })
    for (const name of MEMORY_READ_TOOLS) {
      assert.match(host.state.guards[0](exec(name)), /Memory|non-QQ/i,
        `${JSON.stringify(declaration)} must not open ${name}`)
      assert.equal(latestAllow(host.state).includes(name), false)
    }
  }

  const throwing = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
  throwing.services.set(MEMORY_SCENE_ACL_SERVICE, {
    sceneAclRead() { throw new Error('declaration unavailable') },
  })
  apply(throwing.ctx, { level: 1 })
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(throwing.state.guards[0](exec(name)), /Memory|non-QQ/i)
  }

  const hostile = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
  hostile.services.set(MEMORY_SCENE_ACL_SERVICE, {
    sceneAclRead: () => new Proxy({}, {
      get() { throw new Error('hostile declaration') },
    }),
  })
  apply(hostile.ctx, { level: 1 })
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(hostile.state.guards[0](exec(name)), /Memory|non-QQ/i)
  }
})

test('withdrawing the declaration closes and hides the readers again', () => {
  const host = fakeHost([...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS, 'pwsh'])
  setMemoryDeclaration(host)
  apply(host.ctx, { level: 1 })
  const guard = host.state.guards[0]
  for (const name of MEMORY_READ_TOOLS) assert.equal(guard(exec(name)), undefined)

  host.services.delete(MEMORY_SCENE_ACL_SERVICE)
  notifyMemoryService(host)
  const allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) {
    assert.match(guard(exec(name)), /Memory|non-QQ/i, `${name} must close immediately`)
    assert.equal(allow.includes(name), false, `${name} must be hidden again`)
  }

  setMemoryDeclaration(host)
  notifyMemoryService(host)
  const reopened = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) {
    assert.equal(guard(exec(name)), undefined, `${name} must reopen`)
    assert.ok(reopened.includes(name), `${name} must be visible again`)
  }
})

test('Memory readers present before the QQ connector appear with it when the contract is present', () => {
  const host = fakeHost([...MEMORY_READ_TOOLS, 'pwsh'])
  setMemoryDeclaration(host)
  apply(host.ctx, { level: 1 })
  assert.equal(host.state.restrictions.some(filter => filter.allow), false,
    'the allow mask waits for the QQ connector tools, not for Memory')
  for (const name of MEMORY_READ_TOOLS) assert.equal(host.state.guards[0](exec(name)), undefined)

  host.state.schemas.push(...QQ_TOOL_NAMES.map(name => ({ name })))
  host.state.listeners.get('tools/change')()
  const allow = latestAllow(host.state)
  for (const name of MEMORY_READ_TOOLS) assert.ok(allow.includes(name), `${name} must be visible`)
  assert.equal(allow.includes('pwsh'), false)
})

test('level 4 keeps the existing generic Owner host-tool path for Memory', () => {
  const { ctx, state } = fakeHost([
    ...QQ_TOOL_NAMES, 'memory_search', 'memory_save', 'memory_delete', 'pwsh',
  ])
  let owner = true
  ctx.get = name => name === 'qq'
    ? {
      resolveTrustedSessionScene: () => ({ admin: owner }),
      authorizeSessionCapability: (_id, capability) => capability === 'qq.owner.tools',
    }
    : undefined
  apply(ctx, { level: 4 })
  const call = name => ({ name, agent: { session: { id: 'owner-session' } } })
  // Owner already reaches every registered host tool through the generic path;
  // this change must not narrow that path.
  for (const name of ['memory_search', 'memory_save', 'memory_delete', 'pwsh']) {
    assert.equal(state.guards[0](call(name)), undefined, name)
  }
  owner = false
  for (const name of ['memory_search', 'memory_save', 'memory_delete', 'pwsh']) {
    assert.match(state.guards[0](call(name)), /owner native|non-QQ/i, name)
  }

  // The same Memory write tools remain closed to an ordinary preset.
  const ordinary = fakeHost([...QQ_TOOL_NAMES, 'memory_save', 'pwsh'])
  apply(ordinary.ctx, { level: 1 })
  assert.match(ordinary.state.guards[0](exec('memory_save')), /non-QQ|Memory/i)
})

test('Safe Chat cannot execute media, file, QZone or Owner workspace tools', () => {
  const { ctx, state } = withCapabilities(fakeHost([
    'qq_send_media', 'qq_upload_file', 'qq_qzone', 'qq_account_profile', OWNER_WORKSPACE_TOOL,
  ]), new Set(['qq.send', 'qq.qzone.publish', 'qq.qzone.read', OWNER_WORKSPACE_CAPABILITY]))
  apply(ctx, { level: 1 })
  const guard = state.guards[0]
  for (const name of ['qq_send_media', 'qq_upload_file', 'qq_qzone', 'qq_account_profile', OWNER_WORKSPACE_TOOL]) {
    assert.match(guard(exec(name)), /does not allow|not configured/, name)
  }
})

test('account profile is Owner-only and checks the operation permission', () => {
  const owner = withCapabilities(fakeHost(['qq_account_profile']), new Set(['qq.read', 'qq.profile.write']))
  apply(owner.ctx, { level: 4 })
  const guard = owner.state.guards[0]
  assert.equal(guard(exec('qq_account_profile', { op: 'read' })), undefined)
  assert.equal(guard(exec('qq_account_profile', { op: 'set_signature' })), undefined)
  assert.equal(guard(exec('qq_account_profile', { op: 'set_avatar' })), undefined)
  assert.match(guard(exec('qq_account_profile', { op: 'other' })), /operation is not allowed/)

  const readOnly = withCapabilities(fakeHost(['qq_account_profile']), new Set(['qq.read']))
  apply(readOnly.ctx, { level: 4 })
  assert.match(readOnly.state.guards[0](exec('qq_account_profile', { op: 'set_nickname' })), /permission denied/)

  const lower = withCapabilities(fakeHost(['qq_account_profile']), new Set(['qq.read', 'qq.profile.write']))
  apply(lower.ctx, { level: 3 })
  assert.match(lower.state.guards[0](exec('qq_account_profile', { op: 'read' })), /does not allow/)
})

test('media/file tools need level 2, a registered send root and runtime qq.send', () => {
  const registered = withCapabilities(fakeHost(['qq_send_media', 'qq_upload_file']), new Set(['qq.send']))
  apply(registered.ctx, { level: 2 })
  assert.equal(registered.state.guards[0](exec('qq_send_media')), undefined)
  assert.equal(registered.state.guards[0](exec('qq_upload_file')), undefined)

  const noPermission = withCapabilities(fakeHost(['qq_send_media']), new Set())
  apply(noPermission.ctx, { level: 2 })
  assert.match(noPermission.state.guards[0](exec('qq_send_media')), /send permission denied/)

  const notConfigured = withCapabilities(fakeHost([]), new Set(['qq.send']))
  apply(notConfigured.ctx, { level: 2 })
  assert.match(notConfigured.state.guards[0](exec('qq_send_media')), /send root is not configured/)
})

test('QZone is level 3+, requires the provider and per-operation capability', () => {
  const unified = withCapabilities(fakeHost(['qq_qzone']), new Set(['qq.qzone.use']))
  apply(unified.ctx, { level: 3 })
  assert.equal(unified.state.guards[0](exec('qq_qzone', { op: 'own_posts' })), undefined)
  assert.equal(unified.state.guards[0](exec('qq_qzone', { op: 'publish_text' })), undefined)
  assert.equal(unified.state.guards[0](exec('qq_qzone', { op: 'publish_media' })), undefined)
  const write = withCapabilities(fakeHost(['qq_qzone']), new Set(['qq.qzone.publish']))
  apply(write.ctx, { level: 3 })
  assert.equal(write.state.guards[0](exec('qq_qzone', { op: 'publish_text' })), undefined)
  assert.match(write.state.guards[0](exec('qq_qzone', { op: 'own_posts' })), /QZone permission denied/)
  assert.match(write.state.guards[0](exec('qq_qzone', { op: 'unknown' })), /operation is not allowed/)

  const level2 = withCapabilities(fakeHost(['qq_qzone']), new Set(['qq.qzone.publish']))
  apply(level2.ctx, { level: 2 })
  assert.match(level2.state.guards[0](exec('qq_qzone', { op: 'publish_text' })), /does not allow/)

  const read = withCapabilities(fakeHost(['qq_qzone']), new Set(['qq.qzone.read']))
  apply(read.ctx, { level: 3 })
  assert.equal(read.state.guards[0](exec('qq_qzone', { op: 'own_posts' })), undefined)

  const noProvider = withCapabilities(fakeHost([]), new Set(['qq.qzone.publish']))
  apply(noProvider.ctx, { level: 3 })
  assert.match(noProvider.state.guards[0](exec('qq_qzone', { op: 'publish_text' })), /provider is not configured/)
})

test('Owner workspace is allowlisted only at level 4 and still needs the dedicated capability', () => {
  resetProviderStatus()
  // The connector registers the tool with the live config; the guard only
  // allowlists it. A static preset-row root must have no effect.
  const host = withCapabilities(fakeHost([OWNER_WORKSPACE_TOOL]), new Set([OWNER_WORKSPACE_CAPABILITY]))
  apply(host.ctx, { level: 4, ownerWorkspaceRoot: process.cwd(), ownerWorkspaceWrites: true })
  assert.equal(host.state.guards[0](exec(OWNER_WORKSPACE_TOOL, { op: 'read' })), undefined)
  assert.equal(host.ctx.tools.schemas().length, 1, 'guard does not register a duplicate')

  const noCapability = withCapabilities(fakeHost([OWNER_WORKSPACE_TOOL]), new Set())
  apply(noCapability.ctx, { level: 4 })
  assert.match(noCapability.state.guards[0](exec(OWNER_WORKSPACE_TOOL)), /permission denied/)

  const level3 = withCapabilities(fakeHost([OWNER_WORKSPACE_TOOL]), new Set([OWNER_WORKSPACE_CAPABILITY]))
  apply(level3.ctx, { level: 3 })
  assert.match(level3.state.guards[0](exec(OWNER_WORKSPACE_TOOL)), /does not allow/)

  const notRegistered = withCapabilities(fakeHost([]), new Set([OWNER_WORKSPACE_CAPABILITY]))
  apply(notRegistered.ctx, { level: 4 })
  assert.match(notRegistered.state.guards[0](exec(OWNER_WORKSPACE_TOOL)), /not registered/)
})

test('registered DSH tools are visible and executable only for a verified level-4 Owner Session', () => {
  // Memory readers are the bounded exception covered by the tests above; this
  // test keeps the remaining native/Dynamic host tools Owner-only.
  const { ctx, state } = fakeHost([...QQ_TOOL_NAMES, 'pwsh', 'read', 'write', 'glob', 'grep', 'web_search', 'web_fetch', 'github_search'])
  let owner = true
  ctx.get = name => name === 'qq'
    ? {
      resolveTrustedSessionScene: () => ({ admin: owner }),
      authorizeSessionCapability: (_id, capability) => capability === 'qq.owner.tools',
    }
    : undefined
  apply(ctx, { level: 4 })
  const exec = name => ({ name, agent: { session: { id: 'owner-session' } } })
  for (const name of ['pwsh', 'read', 'write', 'glob', 'grep', 'web_fetch', 'web_search', 'github_search']) {
    assert.equal(state.guards[0](exec(name)), undefined, name)
  }
  assert.match(state.guards[0](exec('not_installed')), /non-QQ tools/)
  assert.match(state.guards[0](exec('qq_unlisted_send')), /non-QQ tools/)
  const allow = state.restrictions.find(filter => filter.allow)?.allow ?? []
  for (const name of ['pwsh', 'read', 'write', 'glob', 'grep', 'web_fetch', 'web_search', 'github_search']) {
    assert.ok(allow.includes(name), `${name} must be visible`)
  }
  state.schemas.push({ name: 'github_issue_create' })
  state.listeners.get('tools/change')()
  assert.ok(state.restrictions.filter(filter => filter.allow).at(-1).allow.includes('github_issue_create'))
  assert.equal(state.guards[0](exec('github_issue_create')), undefined)
  owner = false
  assert.match(state.guards[0](exec('pwsh')), /owner native|non-QQ/i)
  assert.match(state.guards[0](exec('github_issue_create')), /owner native|non-QQ/i)
  apply(fakeHost([...QQ_TOOL_NAMES, 'pwsh']).ctx, { level: 1 })
})

test('provider status reflects the live tool registry, not the preset level', () => {
  resetProviderStatus()
  const { ctx, state } = fakeHost(['qq_send_media', 'qq_upload_file'])
  apply(ctx, { level: 1 })
  assert.deepEqual(providerStatus().mediaSend, { installed: true, configured: true, enabled: true })
  assert.equal(providerStatus().qzone.installed, false)
  state.schemas = [...state.schemas, { name: 'qq_qzone' }]
  state.listeners.get('tools/change')()
  assert.equal(providerStatus().qzone.installed, true)
  resetProviderStatus()
})

test('registered Owner workspace appears in the level 4 visible tool mask', () => {
  const owner = fakeHost([...QQ_TOOL_NAMES, OWNER_WORKSPACE_TOOL])
  apply(owner.ctx, { level: 4 })
  assert.equal(owner.state.restrictions.find(filter => filter.allow)?.allow.includes(OWNER_WORKSPACE_TOOL), true)

  const unconfigured = fakeHost([...QQ_TOOL_NAMES])
  apply(unconfigured.ctx, { level: 4 })
  assert.equal(unconfigured.state.restrictions.find(filter => filter.allow)?.allow.includes(OWNER_WORKSPACE_TOOL), false)

  const lower = fakeHost([...QQ_TOOL_NAMES, OWNER_WORKSPACE_TOOL])
  apply(lower.ctx, { level: 3 })
  assert.equal(lower.state.restrictions.find(filter => filter.allow)?.allow.includes(OWNER_WORKSPACE_TOOL), false)
})
