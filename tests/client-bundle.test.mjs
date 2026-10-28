import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('package advertises a loadable lazy client bundle', () => {
  assert.equal(packageJson.exports['./client'], './lib/client.js')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(packageJson.files.includes('lib'))
  assert.ok(packageJson.files.includes('src/client'))
  assert.ok(packageJson.files.includes('scripts'))
  assert.equal(typeof packageJson.scripts.build, 'string')
})

test('built bundle parses and the settings registration is idempotent across activation', () => {
  new vm.Script(source, { filename: 'lib/client.js' })
  assert.doesNotMatch(source, /^\s*(import|export)\s/m)

  let loaded
  const sandbox = { window: { __ModuleLoader__: { load: entry => { loaded = entry } } }, console }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.equal(loaded.id, '@amadeus/qq')

  const React = { createElement: (...args) => args }
  const client = loaded.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual([...client.inject], ['slots'])

  let registration
  let registrationCount = 0
  let effectCallback
  const disposers = []
  client.apply({
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.section')
        return callback()
      },
      register(options, component) {
        registration = { options, component }
        registrationCount += 1
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },
    effect(fn) {
      effectCallback = fn
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
  })
  assert.equal(registrationCount, 1)
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'amadeus-qq')
  assert.equal(typeof registration.options.label, 'function')
  assert.equal(typeof registration.component, 'function')

  const second = effectCallback()
  assert.equal(registrationCount, 1, 're-activating while active must not register twice')
  second()
  effectCallback()
  assert.equal(registrationCount, 2, 'activation after disposal registers again')
})

test('native Settings stays a short status and first-run console entry', () => {
  for (const marker of [
    '/api/amadeus-qq',
    '/api/amadeus-qq/setup',
    '/api/amadeus-qq/console',
    "credentials: 'same-origin'",
    '开始首次设置',
    '打开 Web Console',
  ]) {
    assert.ok(source.includes(marker), marker)
  }
  for (const forbidden of ['tokenEnv', 'statePath', 'httpUrl', 'wsUrl', 'access_token', 'Cookie']) {
    assert.ok(!source.includes(forbidden), forbidden)
  }
})
