'use strict'

const ROOT = '/api/amadeus-qq'
const pages = {
  overview: ['总览首页', '连接状态、会话和首次配置。'],
  scenes: ['会话管理', '每个授权群聊或私聊都有独立的 DSH Session 和权限。'],
  features: ['功能中心', '按实际执行路径与 Provider 状态查看 QQ 能力。'],
  account: ['账号与 QQ 空间', '账号级能力由可信 Owner 单独授权。'],
  global: ['全局设置', '选择 Workspace、连接 NapCat 并管理白名单。'],
  diagnostics: ['运行与诊断', '检查实际连接、Session 和权限边界。'],
}
const modes = [
  ['observe', '仅观察', '读取入站，不调用模型或发送'],
  ['safe-chat', '安全聊天', '文字聊天与同一会话续接'],
  ['enhanced', '增强对话', '媒体、回应与搜索能力'],
  ['autonomous-social', '自主群友', '允许新入站消息触发参与判断'],
  ['owner-agent', 'Owner Agent', '仅可信管理员私聊'],
]
const groups = [
  ['聊天与媒体', ['qq.read', 'qq.send', 'qq.media.read', 'qq.reaction.write', 'qq.poke', 'qq.recall']],
  ['群管理', ['qq.group.essence', 'qq.group.notice', 'qq.group.card', 'qq.group.ban', 'qq.group.whole_ban', 'qq.group.kick', 'qq.group.name', 'qq.group.admin', 'qq.group.special_title']],
  ['Agent 与目录', ['dsh.search', 'qq.owner.workspace', 'qq.owner.tools', 'qq.friends.read', 'qq.groups.read']],
]
const behaviorSettings = [
  ['activity', '参与活跃度', [['low', '低'], ['medium', '适中'], ['high', '较活跃']]],
  ['quietWindowMs', '攒消息静默窗口', [[0, '立即处理'], [5000, '5 秒'], [10000, '10 秒'], [12000, '12 秒'], [15000, '15 秒']]],
  ['waitTimeoutMs', '本轮等待续聊上限', [[0, '不等待'], [15000, '15 秒'], [30000, '30 秒'], [60000, '60 秒'], [120000, '120 秒']]],
  ['replyCooldownMs', '自主接话冷却间隔', [[0, '关闭'], [10000, '10 秒'], [15000, '15 秒'], [30000, '30 秒'], [60000, '60 秒']]],
  ['contextBudget', '近期上下文条数', [[10, '10 条'], [20, '20 条'], [40, '40 条']]],
]
const labels = {
  'qq.read': '读取 QQ 消息', 'qq.send': '发送 QQ 消息', 'qq.media.read': '读取媒体附件',
  'qq.reaction.write': '表情回应', 'qq.poke': '戳一戳', 'qq.recall': '撤回消息',
  'qq.group.essence': '群精华', 'qq.group.notice': '群公告', 'qq.group.card': '群名片',
  'qq.group.ban': '禁言成员', 'qq.group.whole_ban': '全员禁言', 'qq.group.kick': '移出成员',
  'qq.group.name': '群名称', 'qq.group.admin': '设置群管理员', 'qq.group.special_title': '群头衔',
  'dsh.search': 'DSH 搜索', 'qq.owner.workspace': 'Owner 文件工作区',
  'qq.owner.tools': 'Owner Host 工具', 'qq.friends.read': '好友目录', 'qq.groups.read': '群目录',
  'qq.profile.write': '账号资料修改', 'qq.qzone.use': 'QQ 空间统一操作',
  'qq.qzone.read': 'QQ 空间读取', 'qq.qzone.publish': 'QQ 空间发布',
}

const $ = id => document.getElementById(id)
const state = { setup: null, runtime: null, selected: '', draft: null, page: 'overview', busy: false }
const openGroups = new Set()

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

function notice(text, bad = false) {
  const node = $('notice')
  node.textContent = text
  node.classList.remove('hide')
  node.classList.toggle('notice-bad', bad)
}

async function api(path, body) {
  const response = await fetch(ROOT + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-amadeus-qq': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json()
  if (!response.ok || payload.ok !== true) {
    const error = new Error(payload.error || '请求未完成')
    error.code = payload.code
    error.status = response.status
    throw error
  }
  return payload.data
}

function show(page) {
  if (!pages[page]) return
  state.page = page
  for (const [name] of Object.entries(pages)) $('view-' + name).classList.toggle('active', name === page)
  for (const button of document.querySelectorAll('[data-page]')) button.classList.toggle('active', button.dataset.page === page)
  $('page-title').textContent = pages[page][0]
  $('page-subtitle').textContent = pages[page][1]
}

function splitIds(value) {
  return [...new Set(value.split(/[，,\s]+/).map(x => x.trim()).filter(Boolean))]
}

function sceneRows() {
  const setup = state.setup
  if (!setup?.botId) return []
  const observed = new Map((state.runtime?.scenes ?? []).map(row => [row.key, row]))
  const rows = []
  for (const [kind, ids] of [['group', setup.groups], ['private', setup.privatePeers]]) {
    for (const peerId of ids ?? []) {
      const key = `${setup.botId}:${kind}:${peerId}`
      const row = observed.get(key) ?? { key, scene: { botId: setup.botId, kind, peerId },
        revision: 0, effectiveMode: 'safe-chat', permissions: null, capabilities: [],
        health: { sessionActive: false }, ownerEligible: kind === 'private' && peerId === setup.ownerId }
      rows.push({ ...row, paused: setup.pausedScenes?.includes(key) === true })
    }
  }
  return rows
}

function renderOverview() {
  const setup = state.setup ?? {}
  const runtime = state.runtime ?? {}
  const rows = sceneRows()
  const workspace = setup.workspaces?.find(item => item.id === setup.workspaceId)
  $('overview-plugin').textContent = setup.enabled ? '已启用' : '待配置'
  $('overview-transport').textContent = `NapCat ${runtime.health?.transport ?? '未连接'}`
  $('overview-scenes').textContent = rows.length
  $('overview-sessions').textContent = rows.filter(row => row.health?.sessionActive).length
  $('overview-workspace').textContent = workspace?.title ?? '未选择'
  $('side-status').textContent = setup.enabled ? '插件已启用' : '等待首次设置'
  $('side-detail').textContent = runtime.health?.transport === 'connected' ? 'NapCat 已连接' : 'NapCat 未连接或已禁用'
  $('side-bot').textContent = setup.botId || '—'
  $('side-owner').textContent = setup.ownerId || '—'
  $('transport-status').textContent = `NapCat：${runtime.health?.transport ?? '未连接'}`
  const list = $('overview-list')
  list.replaceChildren()
  for (const row of rows.slice(0, 5)) {
    const card = el('div', 'activity-row')
    card.append(el('strong', '', `${row.scene.kind === 'group' ? '群聊' : '私聊'} ${row.scene.peerId}`))
    card.append(el('span', 'tag ' + (row.paused ? 'warn' : 'success'), row.paused ? '已暂停' : row.health?.sessionActive ? 'Session 已绑定' : '正在建立 Session'))
    list.append(card)
  }
  if (!rows.length) list.append(el('p', 'fine', '尚无授权会话。请先完成全局设置。'))
  const flow = $('onboarding')
  flow.replaceChildren()
  for (const [done, title] of [
    [Boolean(setup.workspaceId), '选择 DSH Workspace'],
    [Boolean(setup.botId && setup.ownerId && setup.httpUrl && setup.wsUrl), '填写 Bot、Owner 和 NapCat'],
    [rows.length > 0, '授权至少一个 QQ 会话'],
    [runtime.health?.transport === 'connected', '连接 NapCat'],
  ]) {
    const item = el('div', 'check-row')
    item.append(el('span', 'tag ' + (done ? 'success' : 'warn'), done ? '完成' : '待办'), el('b', '', title))
    flow.append(item)
  }
}

function renderSetup() {
  const setup = state.setup
  if (!setup) return
  const selector = $('setup-workspace')
  selector.replaceChildren()
  selector.append(el('option', '', '请选择 Workspace'))
  selector.firstChild.value = ''
  for (const workspace of setup.workspaces ?? []) {
    const option = el('option', '', `${workspace.title} · ${workspace.path}`)
    option.value = workspace.id
    selector.append(option)
  }
  selector.value = setup.workspaceId || ''
  $('setup-bot').value = setup.botId || ''
  $('setup-owner').value = setup.ownerId || ''
  $('setup-http').value = setup.httpUrl || ''
  $('setup-ws').value = setup.wsUrl || ''
  $('setup-token').value = ''
  $('token-hint').textContent = setup.tokenConfigured ? '已有 Token。留空可保留。' : '尚未配置 Token；若 NapCat 未启用鉴权可留空。'
  $('setup-groups').value = (setup.groups ?? []).join(', ')
  $('setup-private').value = (setup.privatePeers ?? []).filter(id => id !== setup.ownerId).join(', ')
  $('setup-connect').checked = setup.connect === true
  const denyList = $('setup-global-deny')
  denyList.replaceChildren()
  const catalog = state.runtime?.catalog
  if (!Array.isArray(catalog)) denyList.append(el('p', 'fine', '能力目录暂不可用；保存时保留现有全局拒绝。'))
  else for (const capability of catalog) {
    const label = el('label', 'global-deny-option')
    const checkbox = el('input')
    checkbox.type = 'checkbox'; checkbox.value = capability.id
    checkbox.checked = (setup.globalDeny ?? []).includes(capability.id)
    checkbox.addEventListener('change', () => { $('setup-state').textContent = '有未保存修改' })
    label.append(checkbox, el('span', '', labels[capability.id] ?? capability.id))
    denyList.append(label)
  }
  $('setup-state').textContent = '当前已应用配置'
}

function selectScene(key) {
  const row = sceneRows().find(item => item.key === key)
  state.selected = row?.key ?? ''
  const mode = row?.permissions?.mode ?? row?.effectiveMode ?? 'safe-chat'
  const preset = state.runtime?.behaviorPresets?.[mode] ?? {}
  const behavior = row?.permissions?.behavior ?? preset
  state.draft = row ? { mode,
    overrides: { ...(row.permissions?.overrides ?? {}) }, behavior: { ...behavior },
    custom: Object.keys(row.permissions?.overrides ?? {}).length > 0 ||
      (row.permissions?.behavior !== undefined && JSON.stringify(behavior) !== JSON.stringify(preset)),
    expectedRevision: row.revision ?? 0 } : null
  renderScenes()
}

function renderScenes() {
  const rows = sceneRows()
  const filter = $('scene-filter').value.trim()
  const list = $('scene-list')
  list.replaceChildren()
  for (const row of rows.filter(item => !filter || item.scene.peerId.includes(filter))) {
    const button = el('button', 'scene-choice' + (row.key === state.selected ? ' selected' : ''))
    button.type = 'button'
    button.append(el('strong', '', `${row.scene.kind === 'group' ? '群聊' : '私聊'} ${row.scene.peerId}`),
      el('small', '', row.paused ? '已暂停' : row.health?.sessionActive ? 'Session 已绑定' : '正在建立 Session'))
    button.addEventListener('click', () => selectScene(row.key))
    list.append(button)
  }
  if (!rows.length) list.append(el('p', 'fine', '暂无授权会话。请在全局设置中填写 Bot 和 Owner。'))
  const row = rows.find(item => item.key === state.selected)
  const detail = $('scene-detail')
  detail.replaceChildren()
  if (!row || !state.draft) { detail.append(el('h2', '', '选择会话'), el('p', '', '选择左侧 Scene 查看设置。')); return }
  const scene = row.scene
  const head = el('div', 'sect-head')
  head.append(el('h2', '', `${scene.kind === 'group' ? '群聊' : '私聊'} ${scene.peerId}`), el('span', 'tag', row.paused ? '已暂停' : '已授权'))
  detail.append(head)
  const info = el('div', 'inline-notice')
  info.textContent = row.paused
    ? '此 Scene 已暂停，模型不能读取或发送 QQ 消息。恢复后沿用原 Session 绑定。'
    : row.health?.sessionActive
      ? `已绑定 DSH Session ${row.sessionId ? `${row.sessionId.slice(0, 10)}…${row.sessionId.slice(-4)}` : ''} · Workspace：${state.setup.workspaces.find(x => x.id === row.workspaceId)?.title ?? '未知'}`
      : '正在建立 DSH Session；若持续未绑定，请检查运行诊断。'
  detail.append(info)
  const actions = el('div', 'scene-actions')
  const pause = el('button', 'button', row.paused ? '恢复会话' : '暂停会话')
  pause.type = 'button'; pause.addEventListener('click', () => void changeScenePause(row, !row.paused))
  const remove = el('button', 'button', '移出白名单')
  remove.type = 'button'; remove.disabled = row.ownerEligible
  remove.addEventListener('click', () => void removeScene(row))
  actions.append(pause, remove)
  detail.append(actions, el('h3', '', '权限预设'))
  const grid = el('div', 'preset-grid')
  for (const [id, label, description] of modes) {
    if (id === 'owner-agent' && !row.ownerEligible) continue
    const option = el('button', 'preset-option' + (!state.draft.custom && state.draft.mode === id ? ' active' : ''))
    option.type = 'button'
    option.append(el('strong', '', label), el('small', '', description))
    option.addEventListener('click', () => { state.draft.mode = id; state.draft.overrides = {};
      state.draft.behavior = { ...(state.runtime?.behaviorPresets?.[id] ?? {}) }; state.draft.custom = false; renderScenes() })
    grid.append(option)
  }
  detail.append(grid)
  detail.append(el('p', 'fine', `当前编辑模式：${state.draft.custom ? '自定义' : modes.find(x => x[0] === state.draft.mode)?.[1] ?? state.draft.mode}。更改权限后自动切换为自定义。`))
  for (const [title, caps] of groups) {
    if (title === '群管理' && scene.kind !== 'group') continue
    const panel = el('details', 'permission-group')
    panel.open = openGroups.has(title)
    panel.addEventListener('toggle', () => { if (panel.open) openGroups.add(title); else openGroups.delete(title) })
    panel.append(el('summary', '', title))
    for (const id of caps) {
      if (id.startsWith('qq.owner') && !row.ownerEligible) continue
      if (['qq.friends.read', 'qq.groups.read'].includes(id) && !row.ownerEligible) continue
      const current = row.capabilities?.find(item => item.id === id)
      const line = el('div', 'permission-row')
      const label = el('label', '', labels[id] ?? id)
      const select = el('select', 'input')
      select.setAttribute('aria-label', `${labels[id] ?? id} 权限`)
      for (const [value, text] of [['inherit', '继承预设'], ['allow', '允许'], ['deny', '拒绝']]) {
        const option = el('option', '', text); option.value = value; select.append(option)
      }
      select.value = state.draft.overrides[id] ?? 'inherit'
      select.addEventListener('change', () => {
        if (select.value === 'inherit') delete state.draft.overrides[id]
        else state.draft.overrides[id] = select.value
        state.draft.custom = true
        renderScenes()
      })
      line.append(label, select, el('small', 'effective-status', current ? (current.effective ? '当前生效' : `当前拒绝 · ${current.reason}`) : '保存后查看生效状态'))
      panel.append(line)
    }
    detail.append(panel)
  }
  const behaviorPanel = el('details', 'permission-group')
  behaviorPanel.open = openGroups.has('连续对话')
  behaviorPanel.addEventListener('toggle', () => { if (behaviorPanel.open) openGroups.add('连续对话'); else openGroups.delete('连续对话') })
  behaviorPanel.append(el('summary', '', '连续对话与行为参数'))
  for (const [key, labelText, options] of behaviorSettings) {
    if (key === 'replyCooldownMs' && scene.kind !== 'group') continue
    const line = el('div', 'permission-row')
    const selector = el('select', 'input')
    selector.setAttribute('aria-label', labelText)
    for (const [value, label] of options) {
      const option = el('option', '', label); option.value = String(value); selector.append(option)
    }
    selector.value = String(state.draft.behavior[key] ?? options[0][0])
    selector.addEventListener('change', () => {
      state.draft.behavior[key] = key === 'activity' ? selector.value : Number(selector.value)
      state.draft.custom = true
      renderScenes()
    })
    line.append(el('label', '', labelText), selector)
    behaviorPanel.append(line)
  }
  detail.append(behaviorPanel)
  const footer = el('div', 'detail-footer')
  const cancel = el('button', 'button', '撤销修改')
  cancel.type = 'button'; cancel.addEventListener('click', () => selectScene(row.key))
  const save = el('button', 'button primary', '保存权限')
  save.type = 'button'; save.disabled = state.busy || !state.setup.enabled || row.paused
  save.addEventListener('click', () => void savePermissions(row))
  footer.append(cancel, save)
  detail.append(footer)
}

async function savePermissions(row) {
  if (state.busy) return
  state.busy = true
  try {
    await api('/scenes/permissions', { scene: row.scene, access: { mode: state.draft.mode,
      overrides: state.draft.overrides, behavior: state.draft.behavior }, expectedRevision: state.draft.expectedRevision })
    notice('会话设置已保存；当前 Session 绑定以页面显示为准。')
    await refresh()
  } catch (error) { notice(error.status === 409 ? '权限已有变化，请刷新后重新编辑。' : `保存失败：${error.message}`, true) }
  finally { state.busy = false }
}

async function changeScenePause(row, paused) {
  try {
    await api('/scenes/pause', { expectedRevision: state.setup.revision, ...row.scene, paused })
    notice(paused ? '会话已暂停。' : '会话已恢复。')
    await refresh()
  } catch (error) { notice(`会话状态未确认：${error.message}`, true); await refresh() }
}

async function removeScene(row) {
  if (!confirm(`确定将 ${row.scene.peerId} 移出白名单？`)) return
  try {
    await api('/scenes/allowlist', { expectedRevision: state.setup.revision, ...row.scene, allowed: false })
    state.selected = ''
    notice('会话已移出白名单。历史记录未删除。')
    await refresh()
  } catch (error) { notice(`移除状态未确认：${error.message}`, true); await refresh() }
}

function renderFeatures() {
  const features = [
    ['聊天与互动', '受 Scene 权限与 NapCat 能力共同约束', ['qq.read', 'qq.send', 'qq.reaction.write', 'qq.poke', 'qq.recall']],
    ['媒体与连续交流', '图片、语音、视频和文件读取；等待、已读、短消息合并与可靠投递由 QQ 内部工具处理', ['qq.media.read']],
    ['群管理', '普通预设默认关闭；还需 Bot 实际拥有相应 QQ 群权限', groups[1][1]],
    ['Owner 与 Agent', '仅可信 Owner 私聊可授权账号级目录及 Host 工具', groups[2][1]],
    ['账号与 QQ 空间', '仅在独立账号页配置；空间读写还受 Provider 与平台支持限制', ['qq.profile.write', 'qq.qzone.use', 'qq.qzone.read', 'qq.qzone.publish']],
  ]
  const list = $('feature-list')
  list.replaceChildren()
  const catalog = new Map((state.runtime?.catalog ?? []).map(item => [item.id, item]))
  for (const [name, body, ids] of features) {
    const card = el('div', 'card padded')
    card.append(el('h3', '', name), el('p', '', body))
    const items = el('div', 'cap-list')
    for (const id of ids) {
      const item = el('div')
      const available = catalog.get(id)?.implemented === true
      const status = id.startsWith('qq.qzone.')
        ? state.runtime?.providers?.qzone?.configured ? 'Provider 已配置 · 待平台确认' : '需要 QZone Provider'
        : id.startsWith('qq.group.') ? '显式授权 + 群权限' : available ? '源码已接线 · 需授权' : '当前不可用'
      item.append(el('span', '', labels[id] ?? id), el('span', 'tag ' + (available ? 'info' : 'warn'), status))
      items.append(item)
    }
    card.append(items)
    list.append(card)
  }
  const optional = el('div', 'card padded')
  optional.append(el('h3', '', '可选联动'), el('p', '', 'Memory、Life、State 缺失时，QQ 当前聊天功能仍可单独运行。Life 独占长期自主唤醒。'))
  list.append(optional)
}

function renderAccount() {
  const setup = state.setup ?? {}
  const owner = sceneRows().find(row => row.ownerEligible)
  const ownerAgent = owner?.permissions?.mode === 'owner-agent'
  $('account-status').textContent = ownerAgent
    ? `可信 Owner 私聊 ${setup.ownerId} 已选择 Owner Agent。修改资料仍受 QQ 平台拒绝约束。`
    : '先在会话管理中将 Owner 私聊切换为 Owner Agent。'
  $('qzone-status').textContent = state.runtime?.providers?.qzone?.configured
    ? 'QZone Provider 当前可用；真实平台动作仍可能被拒绝。'
    : '当前未检测到可用的 QZone Provider。保存配置后请到诊断页核对。'
  $('account-profile').checked = owner?.permissions?.overrides?.['qq.profile.write'] === 'allow'
  $('account-qzone-use').checked = owner?.permissions?.overrides?.['qq.qzone.use'] === 'allow'
  $('account-qzone-enabled').checked = setup.qzoneEnabled === true
  $('account-qzone-publish').checked = setup.qzonePublish === true
  $('account-qzone-url').value = setup.qzoneLoopbackUrl ?? ''
  $('account-qzone-token-env').value = setup.qzoneTokenEnv ?? ''
  for (const id of ['account-profile', 'account-qzone-use']) $(id).disabled = !ownerAgent
  $('account-form').querySelector('[data-account-save="scene"]').disabled = !ownerAgent
  $('account-state').textContent = ownerAgent ? '当前已应用设置' : '空间 Provider 可先配置；Owner 授权需启用 Owner Agent'
}

function renderDiagnostics() {
  const setup = state.setup ?? {}
  const runtime = state.runtime ?? {}
  const rows = sceneRows()
  $('diag-plugin').textContent = setup.enabled ? '已启用' : '未启用'
  $('diag-transport').textContent = runtime.health?.transport ?? '未连接'
  $('diag-workspace').textContent = setup.workspaceId ? '已选择' : '缺失'
  $('diag-scenes').textContent = String(rows.length)
  const list = $('diagnostic-list')
  list.replaceChildren()
  for (const [okay, title, description] of [
    [Boolean(setup.workspaceId), 'DSH Workspace', '必须选择现有 Workspace'],
    [Boolean(setup.ownerId && setup.botId), 'Bot 与 Owner', '可信身份只来自 OneBot 与 DSH 绑定'],
    [runtime.health?.transport === 'connected', 'NapCat WebSocket', '连接在线不等于具有发送权限'],
    [rows.some(row => row.health?.sessionActive), 'QQ Session 绑定', '授权后应在所选 Workspace 中创建真实 Session'],
  ]) {
    const row = el('div', 'check-row')
    row.append(el('span', 'tag ' + (okay ? 'success' : 'warn'), okay ? '通过' : '待检查'))
    const content = el('div'); content.append(el('b', '', title), el('small', '', description)); row.append(content)
    list.append(row)
  }
}

async function refresh() {
  const [setup, runtime] = await Promise.allSettled([api('/setup'), api('/scenes')])
  if (setup.status === 'fulfilled') state.setup = setup.value
  else notice(`首次设置不可用：${setup.reason.message}`, true)
  if (runtime.status === 'fulfilled') state.runtime = runtime.value
  else notice(`运行状态不可用：${runtime.reason.message}`, true)
  renderOverview(); renderSetup(); renderScenes(); renderFeatures(); renderAccount(); renderDiagnostics()
}

for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => show(button.dataset.page))
$('theme-toggle').addEventListener('click', () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
})
$('scene-filter').addEventListener('input', renderScenes)
$('refresh').addEventListener('click', () => void refresh())
$('setup-discard').addEventListener('click', renderSetup)
for (const field of $('setup-form').querySelectorAll('input,select')) field.addEventListener('input', () => { $('setup-state').textContent = '有未保存修改' })
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (!state.setup || state.busy) return
  state.busy = true
  const body = {
    expectedRevision: state.setup.revision, workspaceId: $('setup-workspace').value,
    botId: $('setup-bot').value.trim(), ownerId: $('setup-owner').value.trim(),
    httpUrl: $('setup-http').value.trim(), wsUrl: $('setup-ws').value.trim(),
    groups: splitIds($('setup-groups').value), privatePeers: splitIds($('setup-private').value),
    connect: $('setup-connect').checked,
  }
  if (Array.isArray(state.runtime?.catalog)) {
    body.globalDeny = [...$('setup-global-deny').querySelectorAll('input:checked')].map(input => input.value)
  }
  if ($('setup-token').value) body.token = $('setup-token').value
  try { await api('/setup', body); notice('全局配置已保存并应用。'); await refresh() }
  catch (error) { notice(`保存状态未确认：${error.message}。请刷新核对。`, true); await refresh() }
  finally { state.busy = false }
})
$('account-discard').addEventListener('click', renderAccount)
for (const field of $('account-form').querySelectorAll('input')) field.addEventListener('input', () => { $('account-state').textContent = '有未保存修改' })
$('account-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (!state.setup || state.busy) return
  const owner = sceneRows().find(row => row.ownerEligible)
  const target = event.submitter?.dataset.accountSave
  if (!['scene', 'provider'].includes(target)) return
  if (target === 'scene' && owner?.permissions?.mode !== 'owner-agent') {
    notice('请先为 Owner 私聊启用 Owner Agent。', true); return
  }
  state.busy = true
  try {
    if (target === 'scene') {
      const overrides = { ...(owner.permissions?.overrides ?? {}),
        'qq.profile.write': $('account-profile').checked ? 'allow' : 'deny',
        'qq.qzone.use': $('account-qzone-use').checked ? 'allow' : 'deny',
      }
      await api('/scenes/permissions', { scene: owner.scene,
        access: { mode: 'owner-agent', overrides, ...(owner.permissions?.behavior ? { behavior: owner.permissions.behavior } : {}) },
        expectedRevision: owner.revision })
      notice('Owner 授权已保存。')
    } else {
      await api('/account', { expectedRevision: state.setup.revision,
        qzoneEnabled: $('account-qzone-enabled').checked,
        qzonePublish: $('account-qzone-publish').checked,
        qzoneLoopbackUrl: $('account-qzone-url').value.trim(),
        qzoneTokenEnv: $('account-qzone-token-env').value.trim(),
      })
      notice('空间 Provider 与账号级授权已保存。')
    }
    await refresh()
  } catch (error) { notice(`设置未确认：${error.message}。请刷新核对。`, true); await refresh() }
  finally { state.busy = false }
})
$('add-scene').addEventListener('click', () => $('add-modal').showModal())
$('add-cancel').addEventListener('click', () => $('add-modal').close())
$('add-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (!state.setup?.botId) { notice('请先配置 Bot 账号。', true); return }
  const kind = document.querySelector('input[name="kind"]:checked').value
  const peerId = $('add-peer').value.trim()
  try {
    await api('/scenes/allowlist', { expectedRevision: state.setup.revision, botId: state.setup.botId, kind, peerId, allowed: true })
    $('add-modal').close(); $('add-form').reset(); notice('会话已加入白名单。'); await refresh(); selectScene(`${state.setup.botId}:${kind}:${peerId}`)
  } catch (error) { notice(`添加状态未确认：${error.message}`, true); await refresh() }
})
void refresh()
