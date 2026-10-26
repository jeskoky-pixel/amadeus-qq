import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { acquireInstanceLease } from '../src/lease.js'

test('only one active sender can hold a local QQ state lease', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-lease-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = path.join(dir, 'state.json')
  const release = acquireInstanceLease(state)
  assert.throws(() => acquireInstanceLease(state), /INSTANCE_LOCKED/)
  release()
  release()
  const releaseAgain = acquireInstanceLease(state)
  releaseAgain()
})

test('dead process lease can be recovered without adopting its token', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-qq-lease-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = path.join(dir, 'state.json')
  fs.writeFileSync(`${state}.lock`, JSON.stringify({ pid: 2147483647, token: 'stale' }))
  const release = acquireInstanceLease(state)
  assert.notEqual(JSON.parse(fs.readFileSync(`${state}.lock`, 'utf8')).token, 'stale')
  release()
})
