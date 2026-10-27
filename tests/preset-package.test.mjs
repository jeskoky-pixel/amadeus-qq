import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const presetPatch = fs.readFileSync(new URL('../preset.patch.yml', import.meta.url), 'utf8')

test('one package ships both the connector plugin and the Agent preset patch', () => {
  assert.equal(packageJson.name, '@amadeus/qq')
  assert.equal(packageJson.version, '1.0.0')
  assert.deepEqual(packageJson.dsh.bundle.patch, ['./cordis.patch.yml', './preset.patch.yml'])
  for (const file of packageJson.dsh.bundle.patch) {
    assert.equal(fs.existsSync(new URL(`../${file.replace('./', '')}`, import.meta.url)), true, file)
  }
  for (const doc of ['docs/RELEASE_NOTES.md', 'docs/COMPATIBILITY.md', 'docs/V1_SCOPE.md']) {
    assert.ok(packageJson.files.includes(doc), `${doc} must ship in the v1 package`)
    assert.ok(fs.existsSync(new URL(`../${doc}`, import.meta.url)), `${doc} must exist`)
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
  const basic = active.split('- id: preset-amadeus-qq-search')[0]
  assert.doesNotMatch(basic, /^\s+level: /m, 'the basic preset must retain its safe-chat default')
})

test('a separate search preset uses the existing Host web provider and no persona', () => {
  const active = presetPatch.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(active, /dsh-persona|persona|character|roleplay/i)
  assert.match(active, /id: amadeus-qq-search/)
  assert.match(active, /name: '@deepseek-ai\/dsh-tool-web'/,
    'the Web surface disables the global tool-web row, so this preset needs a scoped provider')
  assert.match(active, /search: true/)
  assert.match(active, /fetch: false/)
  assert.match(active, /allowSearch: true/)
  const pluginRows = active.match(/^\s+- id: .+$/gm) ?? []
  assert.deepEqual(pluginRows.map(row => row.trim()), [
    '- id: preset-amadeus-qq', '- id: qq-tool-boundary',
    '- id: preset-amadeus-qq-search', '- id: qq-web-search', '- id: qq-search-boundary',
    '- id: preset-amadeus-qq-media', '- id: qq-media-boundary',
    '- id: preset-amadeus-qq-media-search', '- id: qq-media-web-search', '- id: qq-media-search-boundary',
    '- id: preset-amadeus-qq-owner', '- id: qq-owner-boundary',
    '- id: owner-tool-pwsh', '- id: owner-tool-fs', '- id: owner-tool-fs-search',
    '- id: owner-tool-jobs', '- id: owner-tool-web',
  ])
  assert.match(active, /id: amadeus-qq-media[\s\S]*?level: 2/)
  assert.match(active, /id: amadeus-qq-media-search[\s\S]*?level: 2/)
  assert.match(active, /id: amadeus-qq-owner[\s\S]*?presetGuard: true[\s\S]*?level: 4/,
    'the Owner preset is level 4 and keeps the QQ guard')
  assert.match(active, /id: amadeus-qq-owner[\s\S]*?@deepseek-ai\/dsh-tool-pwsh/,
    'the Owner preset mounts the official PowerShell tool')
  assert.match(active, /id: amadeus-qq-owner[\s\S]*?@deepseek-ai\/dsh-tool-fs/)
  assert.match(active, /id: amadeus-qq-owner[\s\S]*?@deepseek-ai\/dsh-tool-web/)
  assert.doesNotMatch(active, /ownerWorkspaceRoot|ownerWorkspaceWrites|ownerWorkspaceMaxBytes/,
    'the preset must not inject a static Owner workspace root/writes')
})
