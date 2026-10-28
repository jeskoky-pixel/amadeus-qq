import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PermissionEngine, MODE_IDS, CAPABILITY_CATALOG, validateScenePermissions } from '../src/permissions.js'
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
  assert.equal(accountGranted.evaluate(groupA, { mode: 'autonomous-social' }, 'qq.qzone.publish').allowed, false)
  assert.equal(accountGranted.evaluate(groupA, { mode: 'autonomous-social', overrides: { 'qq.qzone.publish': 'allow' } }, 'qq.qzone.publish').allowed, true)
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

test('account-wide friend and group directories require explicit Owner private grants', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  for (const capability of ['qq.friends.read', 'qq.groups.read']) {
    assert.equal(CAPABILITY_CATALOG.find(item => item.id === capability)?.implemented, true)
    const access = { mode: 'owner-agent', overrides: { [capability]: 'allow' } }
    assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, capability).allowed, false,
      'Owner mode alone must not expose the account directory')
    assert.equal(engine.evaluate(ownerPrivate, access, capability).allowed, true)
    assert.equal(engine.evaluate(groupA, access, capability).allowed, false)
    assert.equal(engine.evaluate(otherPrivate, access, capability).allowed, false)
    assert.equal(engine.evaluate(ownerPrivate, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, false)
    assert.equal(new PermissionEngine({ ownerPrivateIds: ['30001'], globalDeny: [capability] })
      .evaluate(ownerPrivate, access, capability).allowed, false)
  }
})

test('Owner workspace requires explicit allow on a verified owner private owner-agent Scene', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  const capability = 'qq.owner.workspace'
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === capability)?.implemented, true)
  const access = { mode: 'owner-agent', overrides: { [capability]: 'allow' } }
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, capability).allowed, false,
    'Owner mode alone must not expose the workspace')
  assert.equal(engine.evaluate(ownerPrivate, access, capability).allowed, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, access, capability).allowed, false)
  assert.equal(engine.evaluate(otherPrivate, access, capability).allowed, false)
  assert.equal(new PermissionEngine({ ownerPrivateIds: ['30001'], globalDeny: [capability] })
    .evaluate(ownerPrivate, access, capability).allowed, false)
})

test('Owner native tools require verified owner private owner-agent mode', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  const capability = 'qq.owner.tools'
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === capability)?.implemented, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, capability).allowed, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'safe-chat' }, capability).allowed, false)
  assert.equal(engine.evaluate(otherPrivate, { mode: 'owner-agent' }, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'owner-agent' }, capability).allowed, false)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent', overrides: { [capability]: 'deny' } }, capability).allowed, false)
})

test('account profile writes require verified Owner private explicit authorization', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  const capability = 'qq.profile.write'
  const access = { mode: 'owner-agent', overrides: { [capability]: 'allow' } }
  assert.equal(CAPABILITY_CATALOG.find(item => item.id === capability)?.implemented, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, capability).allowed, false)
  assert.equal(engine.evaluate(ownerPrivate, access, capability).allowed, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, access, capability).allowed, false)
  assert.equal(engine.evaluate(otherPrivate, access, capability).allowed, false)
  assert.equal(new PermissionEngine({ ownerPrivateIds: ['30001'], globalDeny: [capability] })
    .evaluate(ownerPrivate, access, capability).allowed, false)
})

test('unified QZone use requires account grant, explicit Scene allow and the right mode', () => {
  const accountGrants = { byBotId: { '10001': { qzonePublish: true } } }
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'], accountGrants })
  const capability = 'qq.qzone.use'
  const access = { mode: 'autonomous-social', overrides: { [capability]: 'allow' } }
  assert.equal(engine.evaluate(groupA, access, capability).allowed, true)
  assert.equal(engine.evaluate(groupA, { mode: 'autonomous-social' }, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, false)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent', overrides: { [capability]: 'allow' } }, capability).allowed, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, capability).allowed, false)
  assert.equal(engine.evaluate(otherPrivate, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, { ...access, overrides: { [capability]: 'deny' } }, capability).allowed, false)
  assert.equal(new PermissionEngine({ globalDeny: [capability], accountGrants })
    .evaluate(groupA, access, capability).allowed, false)
  const noAccount = new PermissionEngine({})
  assert.equal(noAccount.evaluate(groupA, access, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'autonomous-social', overrides: {
    'qq.qzone.read': 'allow',
  } }, capability).allowed, false, 'legacy read-only is not unified use')
})

test('legacy QZone read/publish grants keep their old meaning and never imply unified use', () => {
  const accountGrants = { byBotId: { '10001': { qzonePublish: true } } }
  const engine = new PermissionEngine({ accountGrants })
  const read = { mode: 'autonomous-social', overrides: { 'qq.qzone.read': 'allow' } }
  assert.equal(engine.evaluate(groupA, read, 'qq.qzone.read').allowed, true)
  assert.equal(engine.evaluate(groupA, read, 'qq.qzone.use').allowed, false)
  const publish = { mode: 'autonomous-social', overrides: { 'qq.qzone.publish': 'allow' } }
  assert.equal(engine.evaluate(groupA, publish, 'qq.qzone.publish').allowed, true)
  assert.equal(engine.evaluate(groupA, publish, 'qq.qzone.use').allowed, false)
  assert.doesNotThrow(() => validateScenePermissions({ mode: 'autonomous-social', overrides: { 'qq.qzone.use': 'allow' } }))
})

test('revoking any QZone capability closes unified and legacy paths', () => {
  const accountGrants = { byBotId: { '10001': { qzonePublish: true } } }
  const access = { mode: 'autonomous-social', overrides: {
    'qq.qzone.use': 'allow', 'qq.qzone.read': 'deny',
  } }
  const engine = new PermissionEngine({ accountGrants })
  assert.equal(engine.evaluate(groupA, access, 'qq.qzone.use').allowed, false)
  assert.equal(engine.evaluate(groupA, access, 'qq.qzone.publish').allowed, false)
  const globallyDenied = new PermissionEngine({ accountGrants, globalDeny: ['qq.qzone.use'] })
  assert.equal(globallyDenied.evaluate(groupA, { mode: 'autonomous-social' }, 'qq.qzone.publish').allowed, false)
})

test('QZone reads require explicit Owner or Autonomous Social Scene authorization', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  const capability = 'qq.qzone.read'
  assert.equal(engine.evaluate(groupA, null, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, false)
  assert.equal(engine.evaluate(groupA, { mode: 'autonomous-social', overrides: { [capability]: 'allow' } }, capability).allowed, true)
  assert.equal(engine.evaluate(groupA, { mode: 'autonomous-social' }, capability).allowed, false)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent', overrides: { [capability]: 'allow' } }, capability).allowed, true)
  assert.equal(engine.evaluate(ownerPrivate, { mode: 'owner-agent' }, capability).allowed, false)
  assert.equal(new PermissionEngine({ globalDeny: [capability] })
    .evaluate(groupA, { mode: 'autonomous-social', overrides: { [capability]: 'allow' } }, capability).allowed, false)
})

test('ordinary presets deny group management by default and retain explicit guarded grants', () => {
  const engine = new PermissionEngine({ ownerPrivateIds: ['30001'] })
  const capabilities = [
    'qq.group.essence', 'qq.group.notice', 'qq.group.card',
    'qq.group.ban', 'qq.group.whole_ban', 'qq.group.kick',
    'qq.group.name', 'qq.group.admin', 'qq.group.special_title',
  ]
  for (const capability of capabilities) {
    for (const mode of ['safe-chat', 'enhanced', 'autonomous-social']) {
      assert.equal(engine.evaluate(groupA, { mode }, capability).allowed, false)
    }
    assert.equal(engine.evaluate(groupA, { mode: 'safe-chat', overrides: { [capability]: 'allow' } }, capability).allowed, true)
    assert.equal(new PermissionEngine({ globalDeny: [capability] }).evaluate(groupA, null, capability).allowed, false)
    assert.equal(engine.evaluate(otherPrivate, { mode: 'autonomous-social', overrides: { [capability]: 'allow' } }, capability).allowed, false)
  }
  for (const capability of ['qq.reaction.write', 'qq.poke', 'qq.recall']) {
    assert.equal(engine.evaluate(groupA, null, capability).allowed, false)
    assert.equal(engine.evaluate(groupA, { mode: 'enhanced' }, capability).allowed, true)
    assert.equal(engine.evaluate(groupA, { mode: 'observe' }, capability).allowed, false)
  }
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
