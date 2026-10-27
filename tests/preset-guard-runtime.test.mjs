// Real Cordis runtime regression for the QQ preset guard.
//
// DSH's tools.restrict() synchronously emits tools/change on apply AND dispose.
// A visibility listener that mutates restrictions again can therefore recurse
// during Host startup. This file loads the real Cordis 4 runtime (from the
// Memory development workspace when present) and a tools service that emits
// exactly that synchronous echo, so a regression becomes a bounded-count
// failure instead of a silent CPU loop. It skips when Cordis is unavailable.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MEMORY_READ_TOOLS,
  MEMORY_SCENE_ACL_CONTRACT,
  MEMORY_SCENE_ACL_SERVICE,
  MEMORY_SCENE_ACL_VERSION,
  QQ_TOOL_NAMES,
  apply,
} from '../src/preset-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const QQ_ROOT = path.resolve(HERE, '..')
const MEMORY_SRC = process.env.AMADEUS_MEMORY_SRC
  ?? 'C:/Users/Jesko/Documents/ChatGPT/Amadeus/private/memory-development/workspace/amadeus-memory/dsh-mneme/src'
const CORDIS_PATH = process.env.AMADEUS_CORDIS_PATH
  ?? path.resolve(MEMORY_SRC, '../node_modules/@deepseek-ai/cordis/lib/index.js')

const MEMORY_CAPABILITY = Object.freeze({
  contract: MEMORY_SCENE_ACL_CONTRACT,
  version: MEMORY_SCENE_ACL_VERSION,
  trustedSceneAcl: true,
  strictQQ: true,
  tools: MEMORY_READ_TOOLS,
})

async function loadCordis(t) {
  if (!fs.existsSync(CORDIS_PATH)) {
    t.skip(`Cordis runtime unavailable at ${CORDIS_PATH}`)
    return undefined
  }
  return import(pathToFileURL(CORDIS_PATH).href)
}

function fakeTools(root, names) {
  const state = {
    schemas: names.map(name => ({ name })),
    restrictCalls: 0,
    changeEvents: 0,
    guard: undefined,
  }
  const tools = {
    guard(fn) {
      state.guard = fn
      return () => { state.guard = undefined }
    },
    presentAs() {
      return () => {}
    },
    schemas() {
      return state.schemas
    },
    restrict() {
      state.restrictCalls += 1
      if (state.restrictCalls > 200) throw new Error('restrict event storm')
      state.changeEvents += 1
      root.emit('tools/change')
      let active = true
      return () => {
        if (!active) return
        active = false
        state.changeEvents += 1
        root.emit('tools/change')
      }
    },
  }
  return { tools, state }
}

test('real Cordis: activation and tools/change do not recurse or stall', { timeout: 5000 }, async t => {
  const cordis = await loadCordis(t)
  if (!cordis) return
  const root = new cordis.Context()
  const { tools, state } = fakeTools(root, [...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS])
  root.provide('tools', tools)
  const preset = root.extend()
  const fiber = preset.plugin({ apply(ctx) { apply(ctx, { level: 1 }) } })
  await fiber

  assert.ok(state.restrictCalls <= 20, `startup restrict calls: ${state.restrictCalls}`)
  const afterLoad = state.restrictCalls
  root.emit('tools/change')
  assert.ok(state.restrictCalls - afterLoad <= 6,
    `one tools/change re-entered restrict ${state.restrictCalls - afterLoad} times`)

  // A late non-QQ registration must hide once, not recurse.
  state.schemas.push({ name: 'pwsh' })
  root.emit('tools/change')
  assert.ok(state.restrictCalls - afterLoad <= 12,
    `late registration re-entered restrict ${state.restrictCalls - afterLoad} times`)
  assert.match(state.guard({ name: 'memory_search' }), /Memory|non-QQ/i)
  assert.match(state.guard({ name: 'pwsh' }), /non-QQ tools/)

  await fiber.dispose()
  assert.ok(state.changeEvents <= 80, `unload emitted ${state.changeEvents} tools/change events`)
})

test('real Cordis: Memory service provide/withdraw stays bounded and fail-closed', { timeout: 5000 }, async t => {
  const cordis = await loadCordis(t)
  if (!cordis) return
  const root = new cordis.Context()
  const { tools, state } = fakeTools(root, [...QQ_TOOL_NAMES, ...MEMORY_READ_TOOLS])
  root.provide('tools', tools)
  const preset = root.extend()
  const fiber = preset.plugin({ apply(ctx) { apply(ctx, { level: 1 }) } })
  await fiber

  assert.match(state.guard({ name: 'memory_search' }), /Memory|non-QQ/i)
  const beforeProvide = state.restrictCalls
  const disposeMemory = root.provide(MEMORY_SCENE_ACL_SERVICE, {
    sceneAclRead: () => MEMORY_CAPABILITY,
  })
  assert.equal(state.guard({ name: 'memory_search' }), undefined)
  assert.equal(state.guard({ name: 'memory_list' }), undefined)
  assert.equal(state.guard({ name: 'memory_get' }), undefined)
  assert.ok(state.restrictCalls - beforeProvide <= 12,
    `provide re-entered restrict ${state.restrictCalls - beforeProvide} times`)

  const beforeWithdraw = state.restrictCalls
  disposeMemory()
  assert.match(state.guard({ name: 'memory_search' }), /Memory|non-QQ/i)
  assert.ok(state.restrictCalls - beforeWithdraw <= 12,
    `withdraw re-entered restrict ${state.restrictCalls - beforeWithdraw} times`)

  // The QQ Host service event path must also stay bounded.
  const beforeQq = state.restrictCalls
  const disposeQQ = root.provide('qq', {
    resolveTrustedSessionScene: () => ({}),
    authorizeSessionCapability: () => false,
  })
  assert.ok(state.restrictCalls - beforeQq <= 6,
    `qq provide re-entered restrict ${state.restrictCalls - beforeQq} times`)
  const beforeQqWithdraw = state.restrictCalls
  disposeQQ()
  assert.ok(state.restrictCalls - beforeQqWithdraw <= 6,
    `qq withdraw re-entered restrict ${state.restrictCalls - beforeQqWithdraw} times`)

  await fiber.dispose()
})
