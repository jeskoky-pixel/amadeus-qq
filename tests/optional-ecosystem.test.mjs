// M5 optional-ecosystem contract checks.
//
// These tests read the actually installed Memory and Life sources (source code
// only; no private data, no production config) and compare them with this QQ
// package's real Host surface. Memory is the only ecosystem plugin that
// consumes QQ Scene identity, so its preset set is pinned to the presets this
// package actually ships.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const QQ_ROOT = path.resolve(HERE, '..')
const MEMORY_SRC = process.env.AMADEUS_MEMORY_SRC
  ?? 'C:/Users/Jesko/Documents/ChatGPT/Amadeus/private/memory-development/workspace/amadeus-memory/dsh-mneme/src'
const LIFE_SRC = process.env.AMADEUS_LIFE_SRC ?? path.resolve(QQ_ROOT, '../amadeus-life/src')

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function qqPresetIds() {
  const patch = fs.readFileSync(path.join(QQ_ROOT, 'preset.patch.yml'), 'utf8')
  return [...patch.matchAll(/^\s{8}id: (amadeus-qq(?:-[\w-]+)?)$/gm)].map(match => match[1])
}

test('QQ provides the trusted Scene shape Memory actually validates', t => {
  const core = readIfPresent(path.join(QQ_ROOT, 'src/core.js'))
  const index = readIfPresent(path.join(QQ_ROOT, 'src/index.js'))
  const memoryScene = readIfPresent(path.join(MEMORY_SRC, 'scene.js'))
  if (!core || !index || !memoryScene) {
    t.skip('QQ or Memory source unavailable')
    return
  }
  assert.match(index, /provide\('qq'/)
  assert.match(index, /resolveTrustedSessionScene/)
  assert.match(index, /authorizeSessionCapability/)
  for (const key of ['platform: \'qq\'', 'kind:', 'id:', 'verified: true', 'admin:']) {
    assert.ok(core.includes(key), 'core scene field: ' + key)
  }
  assert.match(core, /id: `\$\{row\.botId\}:\$\{row\.peerId\}`/)
  // Memory's validator accepts exactly this shape: qq, group/private, the id
  // charset used by botId:peerId, and verified===true.
  assert.match(memoryScene, /\["qq", "test"\]/)
  assert.match(memoryScene, /kind !== "group" && kind !== "private"/)
  assert.match(memoryScene, /verified !== true/)
  assert.ok(memoryScene.includes('[A-Za-z0-9_.:-]'), 'Memory id charset is unchanged')
  assert.match('10001:20001', /^[A-Za-z0-9_.:-]+$/)
  // admin is only minted for a private Scene, never from model/HTTP input.
  assert.match(memoryScene, /kind === "private" && scene\.admin === true/)
})

test('Memory recognises every QQ preset this package ships', t => {
  const inject = readIfPresent(path.join(MEMORY_SRC, 'inject.js'))
  if (!inject) {
    t.skip('Memory inject.js unavailable')
    return
  }
  const presets = qqPresetIds()
  assert.ok(presets.length >= 1, 'QQ preset list is readable')
  const setLiteral = /const QQ_PRESETS = new Set\(\[([\s\S]*?)\]\)/.exec(inject)
  assert.ok(setLiteral, 'Memory declares an explicit QQ preset set')
  const recognised = [...setLiteral[1].matchAll(/"([^"]+)"/g)].map(match => match[1])
  for (const preset of presets) {
    assert.ok(recognised.includes(preset),
      `Memory QQ_PRESETS is missing "${preset}"; a Session with that preset would bypass trusted-Scene scoping and unscoped user-settings suppression`)
  }
  // Both the trusted-scene gate and user-settings suppression must use the set,
  // not an exact single preset name.
  assert.match(inject, /function isQQSession\(ctx\)/)
  assert.match(inject, /function renderForQQScene\(renderCtx, render\)/)
  assert.match(inject, /QQ_PRESETS\.has\(preset\)/)
  assert.match(inject, /policy\.strictQQ && !ORDINARY_DSH_PRESETS\.has\(preset\)/,
    'custom QQ presets without trusted Host evidence must fail closed')
  assert.match(inject, /isQQSession\(ctx\) \? "" : renderUserSettings\(ctx\)/)
  assert.doesNotMatch(inject, /sessionAgentId\([^)]*\) !== "amadeus-qq"/)
})

test('Life session scope is DSH-session based and compatible with QQ sessions', async t => {
  const index = readIfPresent(path.join(LIFE_SRC, 'index.js'))
  const modelFile = path.join(LIFE_SRC, 'model.js')
  if (!index || !readIfPresent(modelFile)) {
    t.skip('Life source unavailable')
    return
  }
  const life = await import(pathToFileURL(modelFile).href)
  assert.equal(typeof life.isDshSessionScope, 'function')
  assert.equal(life.isDshSessionScope('session:session-5a0db58d-6c68-4ff3-9e9e-21ab9bf516d7'), true)
  assert.equal(life.isDshSessionScope('qq:group:10001:20001'), false)
  assert.match(index, /const SCOPE_PREFIX = 'session:'/)
  assert.match(index, /function sessionScope\(exec\)/)
  assert.match(index, /exec\?\.agent\?\.session\?\.id/)
  assert.doesNotMatch(index, /resolveTrustedSessionScene|ctx\.get\(['"]qq['"]\)/)
  // Life never derives Scene identity; wake delivery targets explicit DSH
  // session ids, which a QQ Session can be only when allowlisted by config.
  assert.match(index, /allowedSessionIds/)
  assert.match(index, /isDshSessionScope/)
})

test('QQ has no hard Life/State dependency or optional-service calls', () => {
  const srcDir = path.join(QQ_ROOT, 'src')
  const files = fs.readdirSync(srcDir).filter(name => name.endsWith('.js'))
  const source = files.map(name => fs.readFileSync(path.join(srcDir, name), 'utf8')).join('\n')
  assert.doesNotMatch(source, /amadeus-life|amadeus-state|provide\('life'|ctx\.get\(['"]life['"]\)/)
  const guard = readIfPresent(path.join(srcDir, 'preset-guard.mjs'))
  assert.ok(guard)
  assert.match(guard, /QQ Session cannot use non-QQ tools/)
})
