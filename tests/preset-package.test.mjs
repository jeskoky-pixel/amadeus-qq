import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const presetPatch = fs.readFileSync(new URL('../preset.patch.yml', import.meta.url), 'utf8')

test('one package ships both the connector plugin and the Agent preset patch', () => {
  assert.equal(packageJson.name, '@amadeus/qq')
  assert.deepEqual(packageJson.dsh.bundle.patch, ['./cordis.patch.yml', './preset.patch.yml'])
  for (const file of packageJson.dsh.bundle.patch) {
    assert.equal(fs.existsSync(new URL(`../${file.replace('./', '')}`, import.meta.url)), true, file)
  }
})

test('the preset guard is exported as a package subpath and packed', () => {
  assert.equal(packageJson.exports['./preset-guard'], './src/preset-guard.mjs')
  assert.equal(packageJson.files.includes('src/*.mjs'), true)
  assert.equal(packageJson.files.includes('preset.patch.yml'), true)
})

test('the preset mounts the package root with the guard branch, not an unloadable subpath row', () => {
  assert.match(presetPatch, /id: amadeus-qq/)
  assert.match(presetPatch, /^\s+name: '@amadeus\/qq'$/m)
  assert.match(presetPatch, /presetGuard: true/)
  const active = presetPatch.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(active, /@amadeus\/qq\/preset-guard/)
  assert.doesNotMatch(active, /^\s+level: /m)
})

test('the preset declares only the QQ tool contract and no persona or character card', () => {
  const active = presetPatch.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(active, /dsh-persona|persona|character|roleplay/i)
  const pluginRows = active.match(/^\s+- id: .+$/gm) ?? []
  assert.deepEqual(pluginRows.map(row => row.trim()), ['- id: preset-amadeus-qq', '- id: qq-tool-boundary'])
})
