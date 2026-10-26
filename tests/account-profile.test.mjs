import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAccountProfile } from '../src/account-profile.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const PNG2 = Buffer.concat([PNG, Buffer.from([1])])

function fixture(t, { sceneKind = 'private' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-profile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sendRoot = path.join(dir, 'send')
  const tempRoot = path.join(dir, 'temp')
  fs.mkdirSync(sendRoot)
  fs.mkdirSync(tempRoot)
  fs.writeFileSync(path.join(sendRoot, 'avatar.png'), PNG)
  fs.writeFileSync(path.join(sendRoot, 'avatar2.png'), PNG2)
  fs.writeFileSync(path.join(sendRoot, 'not-image.txt'), Buffer.from('not an image'))
  const scene = { botId: '10001', kind: sceneKind, peerId: '30001' }
  const calls = []
  const state = { nickname: 'Alice', signature: 'hello', status: 10, extStatus: 0 }
  const transport = {
    async action(name, args) {
      calls.push({ name, args })
      if (name === 'get_login_info') return { user_id: 10001, nickname: state.nickname, avatar: 'https://private.invalid/a', phone_num: '123' }
      if (name === 'get_stranger_info') return { user_id: 10001, long_nick: state.signature, status: state.status, avatar: 'https://private.invalid/a' }
      if (name === 'nc_get_user_status') return { status: state.status, ext_status: state.extStatus }
      if (name === 'set_self_longnick') { state.signature = args.longNick; return {} }
      if (name === 'set_qq_profile') { state.nickname = args.nickname; return {} }
      if (name === 'set_online_status') { state.status = args.status; state.extStatus = args.ext_status; return null }
      return {}
    },
  }
  let allowed = true
  let checks = 0
  const authCalls = []
  const authorize = async request => {
    checks += 1
    authCalls.push(request)
    return allowed
  }
  const ledgerRuns = []
  const ledger = { async run(request) { ledgerRuns.push(request); return await request.execute() } }
  const core = {
    authorizedScene() {
      if (!allowed) throw new Error('QQ_PERMISSION_CHANGED')
      return scene
    },
  }
  const profile = createAccountProfile({ core, transport, authorize, ledger, sendRoot, tempRoot })
  t.after(() => {})
  return {
    dir, sendRoot, tempRoot, profile, calls, state, authCalls, ledgerRuns, scene, transport,
    setAllowed: value => { allowed = value },
    checks: () => checks,
  }
}

test('readProfile projects only nickname, signature and online status', async t => {
  const { profile, calls } = fixture(t)
  const result = await profile.readProfile({ sessionId: 's1' })
  assert.deepEqual(result, { userId: '10001', nickname: 'Alice', signature: 'hello', status: 10, extStatus: 0 })
  assert.deepEqual(calls.map(call => call.name), ['get_login_info', 'get_stranger_info', 'nc_get_user_status'])
  assert.equal(JSON.stringify(result).includes('private.invalid'), false)
  assert.equal(JSON.stringify(result).includes('phone'), false)
})

test('signature and nickname writes verify through readback and require ledger', async t => {
  const { profile, calls, ledgerRuns } = fixture(t)
  assert.equal((await profile.setSignature({ sessionId: 's1', signature: 'new signature', actionId: 'sig-1' })).signature, 'new signature')
  assert.equal((await profile.setNickname({ sessionId: 's1', nickname: 'Bob', actionId: 'nick-1' })).nickname, 'Bob')
  assert.deepEqual(calls.filter(call => ['set_self_longnick', 'set_qq_profile'].includes(call.name)).map(call => call.args),
    [{ longNick: 'new signature' }, { nickname: 'Bob' }])
  assert.equal(ledgerRuns.length, 2)
  assert.match(ledgerRuns[0].fingerprint, /^[a-f0-9]{64}$/)
})

test('online status is bounded and verified through nc_get_user_status', async t => {
  const { profile, calls } = fixture(t)
  const result = await profile.setOnlineStatus({ sessionId: 's1', status: 60, extStatus: 0, batteryStatus: 50, actionId: 'online-1' })
  assert.equal(result.status, 60)
  assert.deepEqual(calls.find(call => call.name === 'set_online_status').args,
    { status: 60, ext_status: 0, battery_status: 50 })
  for (const args of [
    { status: 99, extStatus: 0, batteryStatus: 0 },
    { status: 10, extStatus: -1, batteryStatus: 0 },
    { status: 10, extStatus: 0, batteryStatus: 101 },
  ]) {
    await assert.rejects(profile.setOnlineStatus({ sessionId: 's1', actionId: 'bad', ...args }), /QQ_PROFILE_STATUS_INVALID/)
  }
})

test('writes require a private owner Scene, authorization and a durable ledger', async t => {
  const group = fixture(t, { sceneKind: 'group' })
  await assert.rejects(group.profile.setSignature({ sessionId: 's1', signature: 'x', actionId: 'a' }), /QQ_PROFILE_OWNER_REQUIRED/)
  assert.equal(group.calls.length, 0)

  const noLedger = fixture(t)
  const noLedgerProfile = createAccountProfile({
    core: noLedger.scene ? { authorizedScene: () => noLedger.scene } : undefined,
    transport: { action: async () => ({}) },
    authorize: async () => true,
    ledger: undefined,
  })
  await assert.rejects(noLedgerProfile.setSignature({ sessionId: 's1', signature: 'x', actionId: 'a' }), /QQ_PROFILE_LEDGER_REQUIRED/)

  const denied = fixture(t)
  denied.setAllowed(false)
  await assert.rejects(denied.profile.readProfile({ sessionId: 's1' }), /QQ_PROFILE_UNAUTHORIZED/)
  assert.equal(denied.calls.length, 0)
})

test('schema and action-id errors happen before transport', async t => {
  const { profile, calls } = fixture(t)
  await assert.rejects(profile.setSignature({ sessionId: 's1', signature: 'x'.repeat(201), actionId: 'a' }), /QQ_PROFILE_SIGNATURE_INVALID/)
  await assert.rejects(profile.setSignature({ sessionId: 's1', signature: 'ok', actionId: '' }), /QQ_PROFILE_ACTION_ID_INVALID/)
  await assert.rejects(profile.setNickname({ sessionId: 's1', nickname: 'x'.repeat(37), actionId: 'a' }), /QQ_PROFILE_NICKNAME_INVALID/)
  assert.equal(calls.length, 0)
})

test('avatar writes a controlled image through a private snapshot and removes it', async t => {
  const { profile, calls, tempRoot, sendRoot } = fixture(t)
  const result = await profile.setAvatar({ sessionId: 's1', path: 'avatar.png', actionId: 'avatar-1' })
  assert.deepEqual(result, { status: 'confirmed', mediaType: 'image/png', bytes: PNG.length })
  const call = calls.find(item => item.name === 'set_qq_avatar')
  assert.ok(call)
  assert.equal(call.args.file.startsWith(tempRoot + path.sep), true)
  assert.equal(fs.existsSync(call.args.file), false)
  assert.equal(fs.readdirSync(tempRoot).length, 0)
  assert.equal(JSON.stringify(result).includes(sendRoot), false)
  assert.equal(JSON.stringify(result).includes(tempRoot), false)
})

test('avatar ledger fingerprint is content-scoped and idempotent across Session IDs and restart', async t => {
  const base = fixture(t)
  const records = new Map()
  const ledger = {
    async run(request) {
      const prior = records.get(request.actionId)
      if (prior) {
        if (prior.fingerprint !== request.fingerprint) throw new Error('QQ_PROFILE_ACTION_CONFLICT')
        return { status: 'delivered', repeated: true, profile: prior.profile }
      }
      const profile = await request.execute()
      records.set(request.actionId, { fingerprint: request.fingerprint, profile })
      return { status: 'delivered', repeated: false, profile }
    },
  }
  const make = () => createAccountProfile({
    core: { authorizedScene: () => base.scene },
    transport: base.transport,
    authorize: async () => true,
    ledger,
    sendRoot: base.sendRoot,
    tempRoot: base.tempRoot,
  })
  const first = make()
  const second = make()
  assert.equal((await first.setAvatar({ sessionId: 'session-a', path: 'avatar.png', actionId: 'same-avatar' })).profile.status, 'confirmed')
  assert.equal((await second.setAvatar({ sessionId: 'session-b', path: 'avatar.png', actionId: 'same-avatar' })).repeated, true)
  assert.equal(records.size, 1)
  assert.equal(base.calls.filter(item => item.name === 'set_qq_avatar').length, 1)
  assert.equal(fs.readdirSync(base.tempRoot).length, 0)

  const restarted = make()
  assert.equal((await restarted.setAvatar({ sessionId: 'session-c', path: 'avatar.png', actionId: 'same-avatar' })).repeated, true)
  await assert.rejects(restarted.setAvatar({ sessionId: 'session-c', path: 'avatar2.png', actionId: 'same-avatar' }), /ACTION_CONFLICT/)
  assert.equal(fs.readdirSync(base.tempRoot).length, 0)
})

test('avatar rejects absolute, URL, base64, traversal, non-image, oversize and missing paths', async t => {
  const { profile, sendRoot, tempRoot } = fixture(t)
  fs.writeFileSync(path.join(sendRoot, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1))
  for (const value of [
    path.join(sendRoot, 'avatar.png'),
    'https://private.invalid/avatar.png',
    'base64://iVBORw0KGgo=',
    '../avatar.png',
    'not-image.txt',
    'huge.png',
    'missing.png',
  ]) {
    await assert.rejects(profile.setAvatar({ sessionId: 's1', path: value, actionId: `bad-${value.length}` }), /QQ_PROFILE_AVATAR_INVALID/)
  }
  assert.equal(fs.readdirSync(tempRoot).length, 0)
})

test('avatar without a configured sendRoot is refused', async t => {
  const base = fixture(t)
  const profile = createAccountProfile({
    core: { authorizedScene: () => base.scene },
    transport: base.transport,
    authorize: async () => true,
    ledger: { async run(request) { return request.execute() } },
  })
  await assert.rejects(profile.setAvatar({ sessionId: 's1', path: 'avatar.png', actionId: 'a' }), /QQ_PROFILE_AVATAR_ROOT_INVALID/)
})

test('avatar platform rejection, timeout and post-write revocation are unknown/rejected and cleaned', async t => {
  const base = fixture(t)
  const make = (transport, authorize = async () => true) => createAccountProfile({
    core: { authorizedScene: () => base.scene },
    transport,
    authorize,
    ledger: { async run(request) { return request.execute() } },
    sendRoot: base.sendRoot,
    tempRoot: base.tempRoot,
  })
  const rejectedTransport = { async action() {
    const error = new Error('rejected'); error.code = 'ONEBOT_REJECTED'; throw error
  } }
  await assert.rejects(make(rejectedTransport).setAvatar({ sessionId: 's1', path: 'avatar.png', actionId: 'r1' }), /QQ_PROFILE_REJECTED/)

  const timeoutTransport = { async action() { throw new DOMException('timeout', 'TimeoutError') } }
  await assert.rejects(make(timeoutTransport).setAvatar({ sessionId: 's1', path: 'avatar.png', actionId: 't1' }), /QQ_PROFILE_UNKNOWN/)

  let checks = 0
  const revoked = make({ async action() { return null } }, async () => { checks += 1; return checks === 1 })
  await assert.rejects(revoked.setAvatar({ sessionId: 's1', path: 'avatar.png', actionId: 'v1' }), /QQ_PROFILE_UNKNOWN/)
  assert.equal(fs.readdirSync(base.tempRoot).length, 0)
})

test('profile fingerprints are stable across Session IDs and conflict on changed payload', async t => {
  const base = fixture(t)
  const records = new Map()
  const ledger = {
    async run(request) {
      const prior = records.get(request.actionId)
      if (prior) {
        if (prior.fingerprint !== request.fingerprint) throw new Error('QQ_PROFILE_ACTION_CONFLICT')
        return { status: 'delivered', repeated: true, profile: prior.profile }
      }
      const profile = await request.execute()
      records.set(request.actionId, { fingerprint: request.fingerprint, profile })
      return { status: 'delivered', repeated: false, profile }
    },
  }
  const make = () => createAccountProfile({
    core: { authorizedScene: () => base.scene },
    transport: base.transport,
    authorize: async () => true,
    ledger,
    sendRoot: base.sendRoot,
    tempRoot: base.tempRoot,
  })
  await make().setSignature({ sessionId: 'session-a', signature: 'stable', actionId: 'same-sig' })
  const repeated = await make().setSignature({ sessionId: 'session-b', signature: 'stable', actionId: 'same-sig' })
  assert.equal(repeated.repeated, true)
  await assert.rejects(make().setSignature({ sessionId: 'session-b', signature: 'changed', actionId: 'same-sig' }), /ACTION_CONFLICT/)
})

test('write failure, timeout and readback mismatch become unknown or rejected without retry', async t => {
  let mode = 'timeout'
  const scene = { botId: '10001', kind: 'private', peerId: '30001' }
  const calls = []
  const transport = {
    async action(name) {
      calls.push(name)
      if (name === 'get_login_info' || name === 'get_stranger_info' || name === 'nc_get_user_status') {
        return { user_id: 10001, nickname: 'Alice', long_nick: 'old', status: 10, ext_status: 0 }
      }
      if (mode === 'timeout') throw new DOMException('timeout', 'TimeoutError')
      if (mode === 'rejected') { const error = new Error('rejected'); error.code = 'ONEBOT_REJECTED'; throw error }
      return {}
    },
  }
  const ledgerRuns = []
  const profile = createAccountProfile({
    core: { authorizedScene: () => scene },
    transport,
    authorize: async () => true,
    ledger: { async run(request) { ledgerRuns.push(request); return await request.execute() } },
  })
  await assert.rejects(profile.setSignature({ sessionId: 's1', signature: 'new', actionId: 'a' }), /QQ_PROFILE_UNKNOWN/)
  assert.equal(calls.filter(name => name === 'set_self_longnick').length, 1)
  mode = 'rejected'
  await assert.rejects(profile.setSignature({ sessionId: 's1', signature: 'new', actionId: 'b' }), /QQ_PROFILE_REJECTED/)
  assert.equal(calls.filter(name => name === 'set_self_longnick').length, 2)
  assert.equal(ledgerRuns.length, 2)

  const mismatchScene = { botId: '10001', kind: 'private', peerId: '30001' }
  const mismatch = createAccountProfile({
    core: { authorizedScene: () => mismatchScene },
    transport: {
      async action(name) {
        if (name === 'get_login_info') return { user_id: 10001, nickname: 'Alice' }
        if (name === 'get_stranger_info') return { long_nick: 'normalized', status: 10 }
        if (name === 'nc_get_user_status') return { status: 10, ext_status: 0 }
        return {}
      },
    },
    authorize: async () => true,
    ledger: { async run(request) { return await request.execute() } },
  })
  await assert.rejects(mismatch.setSignature({ sessionId: 's1', signature: 'requested', actionId: 'c' }), /QQ_PROFILE_UNKNOWN/)
})

test('revocation after write is unknown, never a clean failure', async t => {
  const { profile } = fixture(t)
  let checks = 0
  // Re-create with a callback that allows the preflight but revokes after the write.
  const scene = { botId: '10001', kind: 'private', peerId: '30001' }
  const transport = { async action(name) {
    if (name === 'get_login_info') return { user_id: 10001, nickname: 'Alice' }
    if (name === 'get_stranger_info') return { long_nick: 'after', status: 10 }
    if (name === 'nc_get_user_status') return { status: 10, ext_status: 0 }
    return {}
  } }
  const revoked = createAccountProfile({
    core: { authorizedScene: () => scene },
    transport,
    authorize: async () => { checks += 1; return checks === 1 },
    ledger: { async run(request) { return await request.execute() } },
  })
  await assert.rejects(revoked.setSignature({ sessionId: 's1', signature: 'after', actionId: 'revoked' }), /QQ_PROFILE_UNKNOWN/)
})
