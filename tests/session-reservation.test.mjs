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
