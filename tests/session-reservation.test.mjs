import test from 'node:test'
import assert from 'node:assert/strict'
import { makeDshHost } from '../src/index.js'

test('Host adapter reserves before create and rejects ignored reservation', async () => {
  const events=[]
  const ctx={sessionController:{prompt(){},async create(input){events.push(input.sessionId);return {sessionId:'different',agentPreset:input.agentPreset}}}}
  const host=makeDshHost(ctx,{agentPreset:'amadeus-qq',workspaceId:'w'},{reserve(){events.push('reserved');return 'reserved-id'}})
  await assert.rejects(host.createSceneSession({kind:'group',peerId:'1'}),/QQ_PROVENANCE_UNSUPPORTED/)
  assert.deepEqual(events,['reserved','reserved-id'])
})

test('Host create failure does not roll back durable reservation', async () => {
  const reserved=[]
  const host=makeDshHost({sessionController:{prompt(){},async create(){throw Error('host failed')}}},
    {agentPreset:'amadeus-qq',workspaceId:'w'},{reserve(){reserved.push('id');return 'id'}})
  await assert.rejects(host.createSceneSession({kind:'group',peerId:'1'}),/host failed/)
  assert.deepEqual(reserved,['id'])
})

test('Host existence checks distinguish live, missing and unknown failures', async () => {
  let observed = true
  let workspaceSessionIds = ['s1']
  const ctx = {
    sessionController: {
      prompt() {},
      async create() { throw new Error('unused') },
      async projections() {
        if (observed === 'throw') throw new Error('persistence corrupt')
        if (observed === 'notfound') throw Object.assign(new Error('missing'), { code: 'session/not-found' })
        if (observed === 'undefined') return undefined
        if (observed === 'shape') return {}
        return observed ? { kind: 'sequenced', values: {} } : null
      },
    },
    reflect: { get: name => name === 'workspaceRegistry'
      ? { list: async () => [{ id: 'w', sessionIds: workspaceSessionIds }] }
      : undefined },
  }
  const host = makeDshHost(ctx, { agentPreset: 'amadeus-qq', workspaceId: 'w' })
  assert.equal(await host.sessionExists('s1'), true)
  observed = false
  assert.equal(await host.sessionExists('s1'), false)
  observed = 'notfound'
  assert.equal(await host.sessionExists('s1'), false)
  observed = 'throw'
  await assert.rejects(host.sessionExists('s1'), /persistence corrupt/)
  observed = 'undefined'
  await assert.rejects(host.sessionExists('s1'), /QQ_SESSION_LOOKUP_INVALID/)
  observed = 'shape'
  await assert.rejects(host.sessionExists('s1'), /QQ_SESSION_LOOKUP_INVALID/)

  observed = true
  workspaceSessionIds = ['other']
  await assert.rejects(host.sessionExists('s1'), /QQ_WORKSPACE_MISMATCH/,
    'a Session in another workspace is rejected, not cancelled as missing')

  const listOnly = makeDshHost({ sessionController: {
    prompt() {}, async create() {}, async list() { return { items: [] } },
  } }, { agentPreset: 'amadeus-qq', workspaceId: 'w' })
  assert.equal(await listOnly.sessionExists('filtered'), null,
    'a visibility-filtered list cannot prove physical absence')

  const legacy = makeDshHost({ sessionController: { prompt() {}, async create() {} },
    agents: { async resolveAgent() { return { agent: { session: { id: 'live' } } } } } },
  { agentPreset: 'amadeus-qq', workspaceId: 'w' })
  assert.equal(await legacy.sessionExists('old-mock'), null, 'legacy mocks remain compatible')
})
