import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply as applyPresetGuard, MAX_QQ_PERMISSION_LEVEL } from '../src/preset-guard.mjs'
import {
  DEFAULT_MAX_BYTES,
  OWNER_WORKSPACE_TOOL,
  createOwnerWorkspaceTool,
  isDeniedOwnerSegment,
  ownerPathSegments,
  ownerWorkspaceStatus,
  readOwnerWorkspaceFile,
  requestOwnerWriteApproval,
  resetOwnerWorkspaceStatus,
  resetProviderStatus,
  resolveOwnerWorkspacePath,
  resolveOwnerWorkspacePolicy,
  setOwnerWorkspaceStatus,
  writeOwnerWorkspaceFile,
} from '../src/owner-workspace.js'
import { createAdminHandler } from '../src/admin-http.js'
import { ownerWorkspaceSummary, providerSummary } from '../src/client/logic.js'

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-owner-ws-'))
  t.after(() => fsSync.rmSync(root, { recursive: true, force: true }))
  return root
}

function fakeApproval(outcome = 'allowed-once') {
  const calls = []
  return {
    calls,
    async request(request) {
      calls.push(request)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

test('owner workspace config defaults are backward compatible and validated', () => {
  assert.deepEqual(resolveOwnerWorkspacePolicy({}), { root: '', allowWrite: false, maxBytes: DEFAULT_MAX_BYTES })
  const parsed = resolveOwnerWorkspacePolicy({
    ownerWorkspaceRoot: 'C:\\qa\\owner', ownerWorkspaceWrites: true, ownerWorkspaceMaxBytes: 1024,
  })
  assert.equal(parsed.allowWrite, true)
  assert.equal(parsed.maxBytes, 1024)
  for (const bad of [{ ownerWorkspaceRoot: 'relative' }, { ownerWorkspaceRoot: 'C:\\' },
    { ownerWorkspaceWrites: 'yes' }, { ownerWorkspaceMaxBytes: 0 }, { ownerWorkspaceMaxBytes: 99999999 }]) {
    assert.throws(() => resolveOwnerWorkspacePolicy(bad))
  }
})

test('owner paths reject traversal, absolute, UNC, hidden and credential segments', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows', '\\\\server\\share',
    'a/./b', 'a//b', '.ssh/id', '.git/config', 'credentials.yaml', 'sub/.env', 'a\u0000b', '']) {
    assert.throws(() => ownerPathSegments(bad), /owner workspace path is invalid/, bad)
  }
  assert.deepEqual(ownerPathSegments('docs\\note.txt'), ['docs', 'note.txt'])
  assert.equal(isDeniedOwnerSegment('constructor'), false)
  assert.equal(isDeniedOwnerSegment('..'), true)
})

test('owner reads and writes stay inside the canonical root', async t => {
  const root = await tempRoot(t)
  await fs.mkdir(path.join(root, 'notes'))
  await fs.writeFile(path.join(root, 'notes', 'a.txt'), 'hello\n')
  const read = await readOwnerWorkspaceFile({ root, requested: 'notes/a.txt' })
  assert.equal(read.text, 'hello\n')
  assert.equal(read.name, 'a.txt')

  const write = await writeOwnerWorkspaceFile({
    root, requested: 'notes/b.txt', content: 'written', maxBytes: 1024,
    authorize: async () => true,
    approve: async () => {},
  })
  assert.equal(write.bytes, 7)
  assert.equal(await fs.readFile(path.join(root, 'notes', 'b.txt'), 'utf8'), 'written')
  await assert.rejects(readOwnerWorkspaceFile({ root, requested: 'missing.txt' }), /invalid|escapes/)
})

test('read re-authorizes after the bytes are loaded, so a mid-read revocation leaks no body', async t => {
  const root = await tempRoot(t)
  await fs.writeFile(path.join(root, 'secret.txt'), 'private-body')
  let calls = 0
  const authorize = async () => {
    calls += 1
    return calls === 1 // valid when the read starts, revoked by the time it ends
  }
  await assert.rejects(
    readOwnerWorkspaceFile({ root, requested: 'secret.txt', authorize }),
    /no longer valid/,
  )
  assert.ok(calls >= 2, 'authorization is checked again after reading')
})

test('symlink and traversal escapes are refused', async t => {
  const root = await tempRoot(t)
  const outside = await tempRoot(t)
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  try {
    await fs.symlink(outside, path.join(root, 'link'), 'junction')
  } catch (error) {
    t.skip('symlinks unavailable: ' + error.code)
    return
  }
  await assert.rejects(readOwnerWorkspaceFile({ root, requested: 'link/secret.txt' }), /symbolic link|invalid|escapes/)
  await assert.rejects(resolveOwnerWorkspacePath(root, 'link/secret.txt'), /symbolic link|invalid|escapes/)
})

test('size caps and UTF-8 validation are enforced', async t => {
  const root = await tempRoot(t)
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(64))
  await assert.rejects(readOwnerWorkspaceFile({ root, requested: 'large.txt', maxBytes: 8 }), /limit/)
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00]))
  await assert.rejects(readOwnerWorkspaceFile({ root, requested: 'binary.bin' }), /UTF-8/)
})

test('writes fail closed without an approval service or without allowed-once', async t => {
  const root = await tempRoot(t)
  const base = {
    root, requested: 'a.txt', content: 'x', authorize: async () => true,
  }
  await assert.rejects(writeOwnerWorkspaceFile(base), /approval is unavailable/)
  for (const outcome of ['rejected', 'unavailable', 'cancelled']) {
    await assert.rejects(writeOwnerWorkspaceFile({
      ...base, approve: () => requestOwnerWriteApproval({
        approval: fakeApproval(outcome), agent: {}, callId: 'c1',
      }),
    }), /not approved|approval is unavailable/)
  }
  await assert.rejects(fs.access(path.join(root, 'a.txt')))
})

test('approval carries no path and a revoked or aborted grant never writes', async t => {
  const root = await tempRoot(t)
  const approval = fakeApproval('allowed-once')
  let authorized = true
  const approve = async () => {
    await requestOwnerWriteApproval({ approval, agent: { session: { id: 's' } }, callId: 'c2' })
    authorized = false
  }
  await assert.rejects(writeOwnerWorkspaceFile({
    root, requested: 'revoked.txt', content: 'x',
    authorize: async () => authorized, approve,
  }), /no longer valid/)
  await assert.rejects(fs.access(path.join(root, 'revoked.txt')))
  assert.equal(approval.calls.length, 1)
  assert.deepEqual(Object.keys(approval.calls[0]).sort(), ['agent', 'callId', 'reason', 'signal', 'toolName'])
  assert.equal(approval.calls[0].reason.includes(root), false)
  assert.equal(approval.calls[0].reason.includes('x'), false)

  const controller = new AbortController()
  await assert.rejects(writeOwnerWorkspaceFile({
    root, requested: 'aborted.txt', content: 'x', signal: controller.signal,
    authorize: async () => true,
    approve: async () => { controller.abort() },
  }), /no longer valid/)
})

test('a failed commit leaves the previous target and no temp file', async t => {
  const root = await tempRoot(t)
  await fs.mkdir(path.join(root, 'target.txt'))
  await assert.rejects(writeOwnerWorkspaceFile({
    root, requested: 'target.txt', content: 'x',
    authorize: async () => true, approve: async () => {},
  }))
  assert.deepEqual(await fs.readdir(root), ['target.txt'])
  assert.equal((await fs.lstat(path.join(root, 'target.txt'))).isDirectory(), true)
})

test('the tool is owner/revision bound and denies without a real approval service', async t => {
  const root = await tempRoot(t)
  await fs.writeFile(path.join(root, 'note.txt'), 'ok')
  let admin = true
  const service = {
    resolveTrustedSessionScene: () => ({ admin }),
    authorizeSessionCapability: (_id, capability) => capability === 'qq.owner.workspace',
  }
  const approval = fakeApproval('allowed-once')
  const tool = createOwnerWorkspaceTool({
    root, allowWrite: true, maxBytes: 1024,
    getService: () => service, getApproval: () => approval,
  })
  const exec = { agent: { session: { id: 's1' } }, callId: 'call-1', signal: undefined }
  assert.equal((await tool.execute({ op: 'read', path: 'note.txt' }, exec)).text, 'ok')
  assert.equal((await tool.execute({ op: 'write', path: 'new.txt', content: 'n' }, exec)).created, true)
  admin = false
  await assert.rejects(tool.execute({ op: 'read', path: 'note.txt' }, exec), /no longer valid|failed/)
  await assert.rejects(tool.execute({ op: 'read', path: '../x' }, exec), (error) => {
    assert.equal(error.message.includes(root), false)
    return true
  })
  const noApproval = createOwnerWorkspaceTool({
    root, allowWrite: true, maxBytes: 1024,
    getService: () => service, getApproval: () => undefined,
  })
  admin = true
  await assert.rejects(noApproval.execute({ op: 'write', path: 'x.txt', content: 'x' }, exec), /approval is unavailable/)
})

test('preset guard only allowlists the owner tool at level 4; the connector owns registration', async () => {
  resetOwnerWorkspaceStatus()
  let guard
  let registerCalls = 0
  const schemas = [] // Simulates the connector having registered the tool.
  const ctx = {
    tools: {
      register() { registerCalls += 1; return () => {} },
      guard(fn) { guard = fn; return () => {} },
      restrict() { return () => {} },
      schemas() { return schemas.map(name => ({ name })) },
      presentAs() {},
    },
    get(name) {
      if (name === 'qq') {
        return {
          resolveTrustedSessionScene: () => ({ admin: true }),
          authorizeSessionCapability: (_id, capability) => capability === 'qq.owner.workspace',
        }
      }
      if (name === 'approval') return fakeApproval()
      return undefined
    },
    on() { return () => {} },
    effect() { return () => {} },
  }
  const exec = { name: OWNER_WORKSPACE_TOOL, arguments: { op: 'read' }, agent: { session: { id: 's1' } } }

  // Static preset-row root must not register or advertise anything.
  applyPresetGuard(ctx, { level: 2, ownerWorkspaceRoot: os.tmpdir(), ownerWorkspaceWrites: true })
  assert.match(guard(exec), /does not allow|not registered/)
  assert.equal(registerCalls, 0)
  assert.equal(ownerWorkspaceStatus().configured, false)

  applyPresetGuard(ctx, { level: MAX_QQ_PERMISSION_LEVEL, ownerWorkspaceRoot: os.tmpdir(), ownerWorkspaceWrites: true })
  schemas.push(OWNER_WORKSPACE_TOOL)
  assert.equal(registerCalls, 0, 'preset guard never registers the owner tool')
  assert.equal(guard(exec), undefined)
  assert.match(guard({ name: 'pwsh' }), /owner native|non-QQ/i)
  assert.equal(ownerWorkspaceStatus().configured, false,
    'runtime status is updated only after the connector registers the tool')
  resetOwnerWorkspaceStatus()
})

test('the scenes response exposes owner workspace status without a path', async () => {
  setOwnerWorkspaceStatus({ configured: true, writes: true, maxBytes: 1024 })
  resetProviderStatus()
  const handler = createAdminHandler({
    listScenePermissions: () => [],
    health: () => ({ enabled: true }),
    setScenePermissions: async () => ({}),
  }, { admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
  const req = Readable.from([])
  Object.assign(req, {
    method: 'GET', url: '/api/amadeus-qq/scenes',
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'x-amadeus-qq': '1' },
  })
  const res = { status: 0, text: '', writeHead(status) { this.status = status }, end(value) { this.text = String(value ?? '') } }
  await handler(req, res)
  const body = JSON.parse(res.text)
  assert.equal(res.status, 200)
  assert.deepEqual(body.data.ownerWorkspace, { configured: true, writes: true, maxBytes: 1024 })
  assert.deepEqual(body.data.providers, {
    mediaSend: { installed: false, configured: false, enabled: false },
    qzone: { installed: false, configured: false, enabled: false },
  })
  assert.equal(JSON.stringify(body).includes(os.tmpdir()), false)
  resetOwnerWorkspaceStatus()
})

test('a Safe Chat capability denial blocks read, write and approval', async t => {
  const root = await tempRoot(t)
  await fs.writeFile(path.join(root, 'note.txt'), 'ok')
  const approval = fakeApproval('allowed-once')
  let safeChat = true
  const service = {
    resolveTrustedSessionScene: () => ({ admin: true }),
    authorizeSessionCapability: (_id, capability) => capability === 'qq.owner.workspace' && !safeChat,
  }
  const tool = createOwnerWorkspaceTool({
    root, allowWrite: true, maxBytes: 1024,
    getService: () => service, getApproval: () => approval,
  })
  const exec = { agent: { session: { id: 'safe' } }, callId: 'c-safe' }
  await assert.rejects(tool.execute({ op: 'read', path: 'note.txt' }, exec), /no longer valid/)
  await assert.rejects(tool.execute({ op: 'write', path: 'new.txt', content: 'x' }, exec), /no longer valid/)
  assert.equal(approval.calls.length, 0)
  await assert.rejects(fs.access(path.join(root, 'new.txt')))
  safeChat = false
  assert.equal((await tool.execute({ op: 'read', path: 'note.txt' }, exec)).text, 'ok')
})

test('writes stay off unless ownerWorkspaceWrites is true', async t => {
  const root = await tempRoot(t)
  const approval = fakeApproval('allowed-once')
  const service = {
    resolveTrustedSessionScene: () => ({ admin: true }),
    authorizeSessionCapability: (_id, capability) => capability === 'qq.owner.workspace',
  }
  const tool = createOwnerWorkspaceTool({
    root, allowWrite: false, maxBytes: 1024,
    getService: () => service, getApproval: () => approval,
  })
  await assert.rejects(tool.execute({ op: 'write', path: 'x.txt', content: 'x' },
    { agent: { session: { id: 's' } }, callId: 'c' }), /writes are disabled|failed/)
  assert.equal(approval.calls.length, 0)
  await assert.rejects(fs.access(path.join(root, 'x.txt')))
})

test('Settings summaries are pending until wired and never expose paths or tokens', () => {
  const pending = ownerWorkspaceSummary({ configured: false, writes: false, maxBytes: 0 })
  assert.match(pending.state, /pending/)
  assert.match(pending.note, /核心|接线/)
  const wired = ownerWorkspaceSummary({ configured: true, writes: true, maxBytes: 1024 })
  assert.equal(wired.writes, '可写（逐次审批）')
  const providers = providerSummary({
    mediaSend: { installed: false },
    qzone: { installed: true, configured: false },
  })
  assert.equal(providers.mediaSend, '未观测到接线')
  assert.equal(providers.qzone, '已安装，未配置')
  const serialized = JSON.stringify([pending, wired, providers])
  assert.doesNotMatch(serialized, /C:\\\\|token|https?:|Users/i)
})
