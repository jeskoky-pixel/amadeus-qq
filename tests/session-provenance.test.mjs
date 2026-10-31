import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionProvenance } from '../src/session-provenance.js'

test('durable reservation precedes Host creation and survives restart, rename and incomplete history', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-provenance-'))
 const file=path.join(dir,'journal.json'), sessions=new Map(), known=new Set()
 let now=1000
 const options={sessions:()=>sessions,store:{isKnownSession:id=>known.has(id)},now:()=>now}
 try {
  const first=new SessionProvenance(file,options)
  const id=first.reserve()
  assert.match(id,/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.ok(JSON.parse(fs.readFileSync(file,'utf8')).reserved.includes(id))
  sessions.set(id,{id,header:{createdAt:1001,agentPreset:'renamed'}})
  assert.equal(first.classify(id).kind,'qq')
  const second=new SessionProvenance(file,options)
  assert.equal(second.classify(id).kind,'qq')
  now=1002
  sessions.set('ordinary',{id:'ordinary',header:{createdAt:1001,agentPreset:'custom-video'}})
  assert.equal(second.classify('ordinary').kind,'ordinary')
  now=2000
  const third=new SessionProvenance(file,options)
  assert.equal(third.classify('ordinary').kind,'ordinary')
  sessions.set('gap',{id:'gap',header:{createdAt:1500}})
  assert.equal(third.classify('gap').kind,'unknown')
  sessions.set('ordinary',{id:'ordinary',header:{createdAt:1500}})
  assert.equal(third.classify('ordinary').kind,'unknown')
  sessions.set('old',{id:'old',header:{createdAt:999,agentPreset:'standard'}})
  assert.equal(second.classify('old').kind,'unknown')
  known.add('ordinary')
  assert.equal(second.classify('ordinary').kind,'qq')
  sessions.delete(id)
  assert.equal(second.classify(id).kind,'unknown')
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})
