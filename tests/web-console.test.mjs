import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createAdminHandler } from '../src/admin-http.js'
import { CONSOLE_JS } from '../src/web-console.js'

const owner = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
const guest = { admit: () => ({ peer: { principal: { kind: 'guest' } } }) }

function core() {
  return {
    listScenePermissions: () => [{
      key: '10001:group:20001',
      scene: { botId: '10001', kind: 'group', peerId: '20001' },
      permissions: { mode: 'safe-chat', overrides: {}, revision: 2 },
      effectiveMode: 'safe-chat',
      capabilities: [
        { id: 'qq.send', implemented: true, override: 'inherit', effective: true, reason: 'mode' },
        { id: 'qq.qzone.use', implemented: true, override: 'deny', effective: false, reason: 'scene-deny' },
        { id: 'qq.qzone.read', implemented: true, override: 'allow', effective: true, reason: 'scene-allow' },
        { id: 'qq.qzone.publish', implemented: true, override: 'allow', effective: true, reason: 'scene-allow' },
      ],
    }],
    health: () => ({ enabled: true, transport: 'connected' }),
    setScenePermissions: async () => {
      const error = new Error('conflict')
      error.code = 'QQ_PERMISSION_CONFLICT'
      error.currentRevision = 7
      throw error
    },
  }
}

function request(method, path, { headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  Object.assign(req, {
    method,
    url: path,
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'x-amadeus-qq': '1',
      ...headers,
    },
  })
  return req
}

async function invoke(handler, method, path, options) {
  const req = request(method, path, options)
  const res = { status: 0, headers: {}, text: '',
    writeHead(status, fields) { this.status = status; this.headers = fields },
    end(value) { this.text = String(value ?? '') } }
  await handler(req, res)
  return res
}

test('console requires the existing same-origin DSH owner admission', async () => {
  const handler = createAdminHandler(core(), owner)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/console')).status, 200)
  assert.equal((await invoke(createAdminHandler(core(), undefined), 'GET', '/api/amadeus-qq/console')).status, 503)
  assert.equal((await invoke(createAdminHandler(core(), guest), 'GET', '/api/amadeus-qq/console')).status, 403)
  assert.equal((await invoke(handler, 'GET', '/api/amadeus-qq/console', {
    headers: { origin: 'https://external.invalid' },
  })).status, 403)
})

test('console assets are static, CSP constrained and contain no secrets or inline data', async () => {
  const handler = createAdminHandler(core(), owner)
  const html = await invoke(handler, 'GET', '/api/amadeus-qq/console')
  assert.equal(html.status, 200)
  assert.match(html.headers['content-type'], /text\/html/)
  assert.match(html.headers['content-security-policy'], /script-src 'self'/)
  assert.doesNotMatch(html.headers['content-security-policy'], /unsafe-inline/)
  assert.equal(html.headers['x-content-type-options'], 'nosniff')
  assert.equal(html.headers['x-frame-options'], 'DENY')
  assert.match(html.text, /console\.js/)
  assert.match(html.text, /QQ 场景关系图/)
  assert.match(html.text, /id="graph"/)
  assert.match(html.text, /id="graph-wrap"/)
  assert.match(html.text, /id="graph-list"/)
  assert.match(html.text, /graph-scroll-hint/)
  assert.match(html.text, /role="region"/)
  assert.doesNotMatch(html.text, /<script(?![^>]*src=)/i)
  assert.doesNotMatch(html.text, /onclick|onerror|onload|innerHTML/i)
  assert.doesNotMatch(html.text, /token|secret|cookie|C:\\|https?:\/\//i)

  const script = await invoke(handler, 'GET', '/api/amadeus-qq/console.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /javascript/)
  assert.match(script.headers['content-security-policy'], /script-src 'self'/)
  assert.match(script.text, /textContent/)
  assert.match(script.text, /createElementNS/)
  assert.match(script.text, /participantIds/)
  assert.doesNotMatch(script.text, /innerHTML/)
  assert.match(script.text, /scenes\/permissions/)
  assert.match(script.text, /expectedRevision/)
  assert.match(script.text, /x-amadeus-qq/)
  assert.match(script.text, /status === 409/)
  assert.match(script.text, /qq\.qzone\.read/)
  assert.match(script.text, /qq\.qzone\.publish/)
  assert.match(script.text, /qq\.qzone\.use/)
  assert.doesNotMatch(script.text, /token|secret|cookie|https?:\/\//i)

  const css = await invoke(handler, 'GET', '/api/amadeus-qq/console.css')
  assert.equal(css.status, 200)
  assert.match(css.headers['content-type'], /text\/css/)
  assert.equal(css.headers['cache-control'], 'no-store')
  // Narrow screens keep the SVG at its natural 900×620 size and scroll it,
  // instead of shrinking 12px labels into unreadability.
  assert.match(css.text, /\.graph-wrap\s*\{[^}]*overflow-x:\s*auto/)
  assert.match(css.text, /#graph\s*\{[^}]*width:\s*900px/)
  assert.match(css.text, /#graph\s*\{[^}]*height:\s*620px/)
  assert.match(css.text, /@media\s*\(max-width:\s*900px\)/)
  assert.match(css.text, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.graph-wrap\s*\{[^}]*display:\s*none/)
  assert.match(css.text, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.graph-list\s*\{[^}]*display:\s*block/)
})

test('console state stays metadata-only and permission conflict uses the existing API', async () => {
  const handler = createAdminHandler(core(), owner)
  const scenes = await invoke(handler, 'GET', '/api/amadeus-qq/scenes')
  assert.equal(scenes.status, 200)
  const body = JSON.parse(scenes.text)
  assert.equal(body.data.health.transport, 'connected')
  assert.equal(body.data.scenes[0].capabilities.some(item => item.id === 'qq.qzone.use'), true)
  assert.doesNotMatch(scenes.text, /message|content|token|secret/i)

  const conflict = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scene: { botId: '10001', kind: 'group', peerId: '20001' },
      access: { mode: 'safe-chat', overrides: {} },
      expectedRevision: 2,
    }),
  })
  assert.equal(conflict.status, 409)
  assert.equal(JSON.parse(conflict.text).currentRevision, 7)

  const missingMarker = await invoke(handler, 'POST', '/api/amadeus-qq/scenes/permissions', {
    headers: { 'content-type': 'application/json', 'x-amadeus-qq': undefined },
    body: JSON.stringify({
      scene: { botId: '10001', kind: 'group', peerId: '20001' },
      access: { mode: 'safe-chat', overrides: {} },
      expectedRevision: 2,
    }),
  })
  assert.equal(missingMarker.status, 403)
})

// --- Standalone browser-behaviour harness -----------------------------------
// Minimal DOM only: enough to execute console.js without a browser or any
// Memory/DSH package. It intentionally throws if the console assigns innerHTML.

class Element {
  constructor(tag, ns) {
    this.tagName = tag
    this.ns = ns
    this.children = []
    this.listeners = new Map()
    this.attributes = {}
    this.value = ''
    this.choices = []
    this.disabled = false
    this.selected = false
    this.focused = false
    this.className = ''
    this._text = ''
  }
  set textContent(value) { this._text = String(value ?? '') }
  get textContent() { return this._text }
  set innerHTML(_value) { throw new Error('innerHTML is forbidden in the QQ console') }
  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node) }
  replaceChildren(...nodes) { this.children = nodes }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        currentTarget: this,
        target: this,
        preventDefault() { this.defaultPrevented = true },
        ...event,
      })
    }
  }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  getAttribute(key) { return this.attributes[key] }
  focus() { this.focused = true }
}

function consoleHarness(payload) {
  const ids = ['status', 'scenes', 'message', 'refresh', 'graph', 'graph-filter',
    'graph-detail', 'graph-note', 'graph-reset', 'graph-list']
  const elements = new Map(ids.map(id => [id, new Element('div')]))
  elements.get('graph-filter').value = ''
  const createdTags = []
  const fetchCalls = []
  const document = {
    getElementById: id => elements.get(id) ?? null,
    createElement: tag => {
      createdTags.push(tag)
      return new Element(tag)
    },
    createElementNS: (_ns, tag) => {
      createdTags.push(tag)
      return new Element(tag, 'svg')
    },
  }
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url, init })
    if (url === 'scenes') return { ok: true, status: 200, json: async () => ({ ok: true, data: payload }) }
    if (url === 'scenes/permissions') {
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'QQ_PERMISSION_CONFLICT', currentRevision: 7 }) }
    }
    throw new Error('unexpected fetch ' + url)
  }
  // eslint-disable-next-line no-new-func
  new Function('document', 'fetch', CONSOLE_JS)(document, fetchImpl)
  return { elements, createdTags, fetchCalls, document }
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve))
}

function allNodes(node, visit) {
  visit(node)
  for (const child of node.children ?? []) allNodes(child, visit)
}

function graphNodes(harness) {
  return harness.elements.get('graph').children.filter(child =>
    child.ns === 'svg' && String(child.attributes.class ?? '').includes('graph-node'))
}

function scenePayload(scenes) {
  return {
    health: { enabled: true, transport: 'connected' },
    providers: { mediaSend: { installed: false }, qzone: { installed: false } },
    ownerWorkspace: { configured: false, writes: false },
    modes: ['observe', 'safe-chat'],
    scenes: scenes.map((scene, index) => ({
      key: scene.key ?? '10001:group:' + (20001 + index),
      scene: { botId: '10001', kind: 'group', peerId: String(20001 + index), ...scene.scene },
      permissions: { mode: 'safe-chat', overrides: {}, revision: 1 },
      revision: 1,
      effectiveMode: 'safe-chat',
      capabilities: [{ id: 'qq.send', implemented: true, override: 'inherit', effective: true, reason: 'mode' }],
      activity: { observedCount: 3, participantIds: scene.participants ?? ['40001'] },
    })),
  }
}

test('standalone console renders a bounded, keyboard-usable QQ graph without Memory', async () => {
  const harness = consoleHarness(scenePayload([
    { participants: ['40001', '40002'] },
    { scene: { kind: 'private', peerId: '30001' }, participants: ['40001'] },
  ]))
  await settle()
  const nodes = graphNodes(harness)
  assert.ok(nodes.length >= 4, 'bot, group, private and person nodes render')
  assert.equal(nodes.some(node => node.attributes.class.includes('person')), true)
  assert.equal(harness.createdTags.some(tag => /^(img|script|iframe)$/.test(tag)), false)
  const labels = []
  allNodes(harness.elements.get('graph'), node => { if (node.tagName === 'text') labels.push(node.textContent) })
  assert.ok(labels.some(label => label.includes('群 20001')))
  assert.match(harness.elements.get('graph-detail').textContent, /2 个 Scene/)
  assert.doesNotMatch(JSON.stringify(harness.fetchCalls), /memory|mneme/i)

  const groupNode = nodes.find(node => node.attributes.class.includes('group'))
  groupNode.dispatch('keydown', { key: 'Enter' })
  assert.match(harness.elements.get('graph-detail').textContent, /模式 safe-chat/)
  groupNode.dispatch('keydown', { key: 'ArrowRight' })
  assert.equal(nodes.some(node => node.focused), true)

  harness.elements.get('graph-filter').value = '40002'
  harness.elements.get('graph-filter').dispatch('input')
  assert.equal(graphNodes(harness).filter(node => node.attributes.class.includes('group')).length, 1)
  harness.elements.get('graph-filter').value = '10001'
  harness.elements.get('graph-filter').dispatch('input')
  assert.equal(graphNodes(harness).filter(node => node.attributes.class.includes('bot')).length, 1)
  harness.elements.get('graph-filter').value = 'no-such-id'
  harness.elements.get('graph-filter').dispatch('input')
  assert.match(harness.elements.get('graph-detail').textContent, /没有匹配/)
})

test('untrusted scene metadata is inserted as text, never as markup', async () => {
  const harness = consoleHarness(scenePayload([
    { scene: { peerId: '<img src=x onerror="alert(1)">' }, participants: ['<script>x</script>'] },
  ]))
  await settle()
  assert.equal(harness.createdTags.some(tag => /^(img|script|iframe)$/.test(tag)), false)
  const texts = []
  allNodes(harness.elements.get('graph'), node => { if (node.tagName === 'text') texts.push(node.textContent) })
  assert.ok(texts.some(text => text.includes('<img')))
  assert.ok(texts.some(text => text.includes('<script>')))
  assert.doesNotMatch(JSON.stringify(harness.fetchCalls), /innerHTML/)
})

test('narrow layout renders a readable list fallback instead of the fixed SVG', async () => {
  const participants = Array.from({ length: 10 }, (_, index) => String(40001 + index))
  const harness = consoleHarness(scenePayload([{ participants }]))
  await settle()
  const list = harness.elements.get('graph-list')
  assert.equal(list.children.length, 1, 'one readable card per visible Scene')
  const texts = []
  allNodes(list, node => texts.push(node.textContent))
  assert.ok(texts.some(text => /群 20001/.test(text)))
  assert.ok(texts.some(text => /模式 safe-chat/.test(text)))
  assert.ok(texts.some(text => /QQ 40001/.test(text)))
  assert.ok(texts.some(text => /\+ 2 个/.test(text)), 'participants are bounded in the list too')
  assert.equal(harness.createdTags.some(tag => /^(img|script|iframe)$/.test(tag)), false)
})

test('large or empty graph data stays bounded and explains truncation', async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    participants: Array.from({ length: 20 }, (_, inner) => String(50000 + index * 20 + inner)),
  }))
  const harness = consoleHarness(scenePayload(many))
  await settle()
  const nodes = graphNodes(harness)
  assert.equal(nodes.filter(node => /group|private/.test(node.attributes.class)).length, 24)
  assert.equal(nodes.filter(node => node.attributes.class.includes('person')).length, 30)
  assert.equal(harness.elements.get('graph-list').children.length, 24,
    'the narrow list shares the same Scene bound')
  assert.match(harness.elements.get('graph-note').textContent, /40 个 Scene/)
  assert.match(harness.elements.get('graph-note').textContent, /最多显示 30 个/)
  for (const node of nodes) {
    const circle = node.children.find(child => child.tagName === 'circle')
    const cx = Number(circle.attributes.cx)
    const cy = Number(circle.attributes.cy)
    assert.ok(cx >= 0 && cx <= 900 && cy >= 0 && cy <= 620, 'nodes stay inside the viewBox')
  }

  const empty = consoleHarness(scenePayload([]))
  await settle()
  assert.match(empty.elements.get('graph-detail').textContent, /暂无可绘制/)
  assert.match(empty.elements.get('scenes').children.at(-1).textContent, /暂无授权 Scene/)
  assert.match(empty.elements.get('graph-list').children[0].textContent, /没有匹配|暂无/)
})

test('permission editor keeps the existing 409 refresh contract', async () => {
  const harness = consoleHarness(scenePayload([{}]))
  await settle()
  let save
  allNodes(harness.elements.get('scenes'), node => {
    if (node.tagName === 'button' && node.textContent === '保存此 Scene') save = node
  })
  assert.ok(save, 'scene editor still renders its save button')
  save.dispatch('click')
  await settle()
  const post = harness.fetchCalls.find(call => call.url === 'scenes/permissions')
  assert.ok(post)
  assert.equal(post.init.method, 'POST')
  assert.equal(post.init.credentials, 'same-origin')
  assert.equal(post.init.headers['x-amadeus-qq'], '1')
  assert.equal(JSON.parse(post.init.body).expectedRevision, 1)
  assert.ok(harness.fetchCalls.filter(call => call.url === 'scenes').length >= 2, '409 refreshes the view')
})
