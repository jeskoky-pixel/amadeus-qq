import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSaveRequest,
  draftFromEntry,
  fetchScenes,
  isDraftDirty,
  nextDraftForSelection,
  savePermissions,
  validateDraft,
} from '../src/client/logic.js'

function entry(overrides = {}) {
  return {
    key: '10001:group:20001',
    scene: { botId: '10001', kind: 'group', peerId: '20001' },
    permissions: { mode: 'safe-chat', overrides: { 'qq.send': 'deny' }, revision: 2 },
    revision: 2,
    effectiveMode: 'safe-chat',
    ownerEligible: false,
    capabilities: [
      { id: 'qq.read', implemented: true, override: 'inherit', effective: true, reason: 'mode' },
      { id: 'qq.send', implemented: true, override: 'deny', effective: false, reason: 'scene-deny' },
      { id: 'dsh.shell', implemented: false, override: 'inherit', effective: false, reason: 'owner-private-required' },
    ],
    ...overrides,
  }
}

test('draft and request construction preserve mode, explicit overrides and revision', () => {
  const source = entry()
  const draft = draftFromEntry(source)
  assert.equal(draft.mode, 'safe-chat')
  assert.deepEqual(draft.overrides, { 'qq.send': 'deny' })
  assert.equal(draft.expectedRevision, 2)
  assert.equal(isDraftDirty(source, draft), false)

  const changed = { ...draft, mode: 'enhanced', overrides: { 'qq.send': 'allow', 'qq.read': 'inherit' } }
  assert.equal(isDraftDirty(source, changed), true)
  assert.deepEqual(buildSaveRequest(source, changed), {
    scene: { botId: '10001', kind: 'group', peerId: '20001' },
    access: { mode: 'enhanced', overrides: { 'qq.send': 'allow' } },
    expectedRevision: 2,
  })
})

test('Scene selection never discards a dirty permission draft without an explicit cancel or save', () => {
  const first = entry()
  const second = entry({ key: '10001:group:20002', scene: { botId: '10001', kind: 'group', peerId: '20002' }, revision: 7 })
  const dirty = { ...draftFromEntry(first), mode: 'enhanced' }
  const same = nextDraftForSelection(first, dirty, first)
  assert.equal(same.blocked, true)
  assert.equal(same.draft, dirty)
  assert.equal(same.draft.expectedRevision, 2)
  const other = nextDraftForSelection(first, dirty, second)
  assert.equal(other.blocked, true)
  assert.equal(other.draft, dirty)
  const clean = nextDraftForSelection(first, draftFromEntry(first), second)
  assert.equal(clean.blocked, false)
  assert.equal(clean.draft.sceneKey, second.key)
  assert.equal(clean.draft.expectedRevision, 7)
})

test('owner-agent is locally rejected outside a configured owner private Scene', () => {
  const group = entry()
  const groupDraft = { ...draftFromEntry(group), mode: 'owner-agent' }
  assert.match(validateDraft(group, groupDraft), /Owner Agent/)

  const owner = entry({ key: '10001:private:30001', scene: { botId: '10001', kind: 'private', peerId: '30001' }, ownerEligible: true })
  assert.equal(validateDraft(owner, { ...draftFromEntry(owner), mode: 'owner-agent' }), null)

  assert.match(validateDraft(group, { ...draftFromEntry(group), overrides: { 'unknown.cap': 'allow' } }), /未知能力/)
  assert.match(validateDraft(group, { ...draftFromEntry(group), overrides: { 'qq.read': 'yes' } }), /覆盖值无效/)
})

test('savePermissions sends the exact POST contract and surfaces a 409 conflict', async () => {
  const source = entry()
  const draft = { ...draftFromEntry(source), mode: 'enhanced', overrides: { 'qq.send': 'allow' } }
  let seen
  const okFetch = async (url, init) => {
    seen = { url, init }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { permissions: { mode: 'enhanced', overrides: { 'qq.send': 'allow' }, revision: 3 } } }) }
  }
  const data = await savePermissions(source, draft, okFetch)
  assert.equal(seen.url, '/api/amadeus-qq/scenes/permissions')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.credentials, 'same-origin')
  assert.equal(seen.init.headers['x-amadeus-qq'], '1')
  assert.equal(seen.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(seen.init.body), buildSaveRequest(source, draft))
  assert.equal(data.permissions.revision, 3)

  const conflictFetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, error: 'Scene permissions changed', code: 'QQ_PERMISSION_CONFLICT', currentRevision: 3 }),
  })
  await assert.rejects(savePermissions(source, draft, conflictFetch), (error) => {
    assert.equal(error.status, 409)
    assert.equal(error.conflict, true)
    return true
  })

  const forbiddenFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, error: 'only the authenticated owner may manage QQ Scenes' }),
  })
  await assert.rejects(savePermissions(source, draft, forbiddenFetch), (error) => {
    assert.equal(error.status, 403)
    assert.notEqual(error.conflict, true)
    return true
  })
})

test('fetchScenes uses same-origin GET and the QQ marker', async () => {
  let seen
  const fake = async (url, init) => {
    seen = { url, init }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { scenes: [], health: {}, modes: [] } }) }
  }
  const data = await fetchScenes(fake)
  assert.equal(seen.url, '/api/amadeus-qq/scenes')
  assert.equal(seen.init.credentials, 'same-origin')
  assert.equal(seen.init.headers['x-amadeus-qq'], '1')
  assert.deepEqual(data, { scenes: [], health: {}, modes: [] })
})
