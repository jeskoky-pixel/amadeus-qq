import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PermissionEngine, MODE_IDS, CAPABILITY_CATALOG } from '../src/permissions.js'
import { QQStore } from '../src/storage.js'

const groupA = { botId: '10001', kind: 'group', peerId: '20001' }
const groupB = { botId: '10001', kind: 'group', peerId: '20002' }
const ownerPrivate = { botId: '10001', kind: 'private', peerId: '30001' }
const otherPrivate = { botId: '10001', kind: 'private', peerId: '30002' }

test('capability catalog reports search as executable after the guarded Host path is installed', () => {
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === 'dsh.search')?.implemented, true)
})

test('five modes only change capabilities and keep their exact product identities', () => {
  assert.deepEqual(MODE_IDS, ['observe', 'safe-chat', 'enhanced', 'autonomous-social', 'owner-agent'])
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  assert.equal(engine.evaluate(groupA, null, 'qq.read').allowed, true)
  assert.equal(engine.evaluate(groupA, null, 'qq.send').allowed, true)
  assert.equal(engine.evaluate(groupA, { mode: 'observe' }, 'qq.send').allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'enhanced' }, 'qq.media.read').allowed, true)
})

test('per-Scene override permits a low-risk read but cannot bypass global or account deny', () => {
  const engine = new PermissionEngine({
    ownerPrivateIds: ['30001'],
    globalDeny: ['dsh.search'],
    accountGrants: { qzonePublish: false },
  })
  const access = { mode: 'observe', overrides: { 'qq.send': 'deny', 'dsh.search': 'allow', 'qq.qzone.publish': 'allow' } }
  assert.equal(engine.evaluate(groupA, access, 'qq.send').allowed, false)
  assert.equal(engine.evaluate(groupA, access, 'dsh.search').allowed, false)
  assert.equal(engine.evaluate(groupA, access, 'qq.qzone.publish').allowed, false)
  assert.equal(new PermissionEngine().evaluate(groupB, { mode: 'observe', overrides: { 'dsh.search': 'allow' } }, 'dsh.search').allowed, true)
  const accountGranted = new PermissionEngine({ accountGrants: { byBotId: { '10001': { qzonePublish: true } } } })
  assert.equal(accountGranted.evaluate(groupA, { mode: 'autonomous-social' }, 'qq.qzone.publish').allowed, true)
  assert.equal(new PermissionEngine({ accountGrants: { qzonePublish: true } })
    .evaluate(groupA, { mode: 'autonomous-social' }, 'qq.qzone.publish').allowed, false)
})

test('Owner Agent is limited to a stable verified owner private ID', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'], ownerTools: ['dsh.shell'] })
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, 'dsh.shell').allowed, true)
  assert.equal(engine.evaluate(otherPrivate, { mode: 'owner-agent' }, 'dsh.shell').allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'owner-agent' }, 'dsh.shell').allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'safe-chat', overrides: { 'dsh.shell': 'allow' } }, 'dsh.shell').allowed, false)
})

test('Scene permission changes persist independently and advance a revision', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-permissions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'qq.json')
  const store = new QQStore(file)
  const first = store.setScenePermissions(groupA, { mode: 'enhanced', overrides: { 'qq.send': 'deny' } })
  assert.equal(first.revision, 1)
  assert.equal(store.setScenePermissions(groupA, { mode: 'observe', overrides: {} }).revision, 2)
  const reopened = new QQStore(file)
  assert.deepEqual(reopened.getScenePermissions(groupA), { mode: 'observe', overrides: {}, revision: 2 })
  assert.equal(new PermissionEngine().evaluate(groupA, reopened.getScenePermissions(groupA), 'qq.send').allowed, false)
  assert.equal(reopened.getScenePermissions(groupB), null)
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => reopened.setScenePermissions(groupB, { mode: 'owner-agent', overrides: { 'qq.send': 'yes' } }))
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})
