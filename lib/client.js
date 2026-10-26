window.__ModuleLoader__.load({
  id: '@amadeus/qq',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
// Pure client-side helpers, inlined into the browser bundle by build-client.
// No ESM imports here: the bundle is a lazy-CJS factory with only React injected.

const API_ROOT = '/api/amadeus-qq'
const MODE_IDS = Object.freeze([
  'observe', 'safe-chat', 'enhanced', 'autonomous-social', 'owner-agent',
])
const OVERRIDE_VALUES = new Set(['inherit', 'allow', 'deny'])

function revisionOf(entry) {
  return entry?.revision ?? 0
}

function draftFromEntry(entry) {
  const overrides = {}
  for (const capability of entry?.capabilities ?? []) {
    if (capability.override === 'allow' || capability.override === 'deny') {
      overrides[capability.id] = capability.override
    }
  }
  return {
    sceneKey: entry?.key ?? '',
    mode: entry?.permissions?.mode ?? entry?.effectiveMode ?? 'safe-chat',
    overrides,
    expectedRevision: revisionOf(entry),
  }
}

function isDraftDirty(entry, draft) {
  if (!entry || !draft) return false
  const base = draftFromEntry(entry)
  if (base.mode !== draft.mode) return true
  const keys = new Set([...Object.keys(base.overrides), ...Object.keys(draft.overrides ?? {})])
  for (const key of keys) {
    if ((base.overrides[key] ?? 'inherit') !== (draft.overrides?.[key] ?? 'inherit')) return true
  }
  return false
}

/**
 * Decide which draft the editor should show after a Scene row is selected.
 * A dirty draft is never replaced: the operator must save or cancel first, so
 * an unsaved permission change can never be lost by an accidental click.
 */
function nextDraftForSelection(currentEntry, currentDraft, targetEntry) {
  if (currentDraft && isDraftDirty(currentEntry, currentDraft)) {
    return { blocked: true, draft: currentDraft }
  }
  if (!targetEntry) return { blocked: false, draft: null }
  const fresh = { ...draftFromEntry(targetEntry), sceneKey: targetEntry.key }
  return { blocked: false, draft: fresh }
}

function validateDraft(entry, draft) {
  if (!entry || !draft) return '未选择场景'
  if (!MODE_IDS.includes(draft.mode)) return '模式无效'
  if (draft.mode === 'owner-agent' && entry.ownerEligible !== true) return 'Owner Agent 仅可用于已配置的可信 Owner 私聊'
  const known = new Set((entry.capabilities ?? []).map(capability => capability.id))
  for (const [id, value] of Object.entries(draft.overrides ?? {})) {
    if (!known.has(id)) return '包含未知能力：' + id
    if (!OVERRIDE_VALUES.has(value)) return '覆盖值无效：' + id
  }
  return null
}

function buildSaveRequest(entry, draft) {
  const overrides = {}
  for (const [id, value] of Object.entries(draft.overrides ?? {})) {
    if (value === 'allow' || value === 'deny') overrides[id] = value
  }
  return {
    scene: {
      botId: entry.scene.botId,
      kind: entry.scene.kind,
      peerId: entry.scene.peerId,
    },
    access: { mode: draft.mode, overrides },
    expectedRevision: draft.expectedRevision,
  }
}

async function readPayload(response) {
  let payload
  try {
    payload = await response.json()
  } catch {
    const error = new Error('管理接口返回了无法解析的响应（HTTP ' + response.status + '）')
    error.status = response.status
    throw error
  }
  if (!response.ok || !payload || payload.ok !== true) {
    const error = new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
    error.status = response.status
    if (response.status === 409) error.conflict = true
    throw error
  }
  return payload.data
}

async function fetchScenes(fetchImpl = fetch) {
  const response = await fetchImpl(API_ROOT + '/scenes', {
    credentials: 'same-origin',
    headers: { 'x-amadeus-qq': '1' },
  })
  return readPayload(response)
}

async function savePermissions(entry, draft, fetchImpl = fetch) {
  const response = await fetchImpl(API_ROOT + '/scenes/permissions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-amadeus-qq': '1' },
    body: JSON.stringify(buildSaveRequest(entry, draft)),
  })
  return readPayload(response)
}


const MODE_LABELS = {
  observe: '只读观察',
  'safe-chat': '安全对话',
  enhanced: '增强对话',
  'autonomous-social': '自主社交（部分功能待实现）',
  'owner-agent': '所有者代理（Owner Agent，部分功能待实现）',
}

const RESERVED_MODE_NOTE = '部分功能待实现：Owner Agent 当前没有 Shell、文件、浏览器、GitHub 等通用工具执行路径；自主社交的 QQ 空间发布也未接入。保存只记录未来策略，QQ 能力仍以下方每项的实际生效状态为准。'

const CAPABILITY_LABELS = {
  'qq.read': '读取 QQ 消息',
  'qq.send': '发送 QQ 消息',
  'dsh.search': 'DSH 搜索',
  'qq.friends.read': '读取 QQ 好友目录',
  'qq.groups.read': '读取 QQ 群目录',
  'qq.media.read': 'QQ 媒体读取',
  'qq.qzone.publish': 'QQ 空间发布',
  'dsh.shell': 'DSH Shell',
}

const CSS = `
[data-amadeus-qq]{--am-qq-accent:#2f5bea;box-sizing:border-box;max-width:100%;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:1.65;padding:0 0 24px}
[data-amadeus-qq] *{box-sizing:border-box}
[data-amadeus-qq] h2{margin:0;font-size:22px;line-height:1.3;font-weight:600}
[data-amadeus-qq] h3{margin:0 0 8px;font-size:15px;line-height:1.4;font-weight:600}
[data-amadeus-qq] p{margin:8px 0}
[data-amadeus-qq] small{display:block;opacity:.72;font-size:12px;line-height:1.55}
[data-amadeus-qq] button{font:inherit;border:1px solid var(--dsw-alias-border-secondary,#8c8c8c55);border-radius:9px;padding:7px 12px;background:var(--dsw-alias-bg-layer-2,#8c8c8c18);color:inherit;cursor:pointer;max-width:100%}
[data-amadeus-qq] button:disabled{opacity:.45;cursor:not-allowed}
[data-amadeus-qq] .topbar{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}
[data-amadeus-qq] .sub{opacity:.72;margin-top:2px}
[data-amadeus-qq] .chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
[data-amadeus-qq] .chip{border:1px solid var(--dsw-alias-border-secondary,#8c8c8c55);border-radius:999px;padding:3px 10px;font-size:12px;background:var(--dsw-alias-bg-layer-2,#8c8c8c12)}
[data-amadeus-qq] .chip.ok{border-color:#3a9b5f88;color:#2f7d4c}
[data-amadeus-qq] .chip.warn{border-color:#d29b3a88;color:#9a6a12}
[data-amadeus-qq] .panel{border:1px solid var(--dsw-alias-border-secondary,#8c8c8c44);border-radius:12px;padding:14px;margin:12px 0;background:var(--dsw-alias-bg-layer-2,#8c8c8c0a)}
[data-amadeus-qq] .sceneRow{border:1px solid var(--dsw-alias-border-secondary,#8c8c8c33);border-radius:10px;padding:10px 12px;margin:8px 0}
[data-amadeus-qq] .sceneHead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
[data-amadeus-qq] .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;opacity:.85;word-break:break-all}
[data-amadeus-qq] .cap{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-top:1px dashed var(--dsw-alias-border-secondary,#8c8c8c33)}
[data-amadeus-qq] .cap:first-of-type{border-top:0}
[data-amadeus-qq] .message{border-radius:9px;padding:9px 11px;margin:10px 0}
[data-amadeus-qq] .message.error{border:1px solid #d9534f88;color:#b33934;background:#d9534f12}
[data-amadeus-qq] .message.success{border:1px solid #3a9b5f88;color:#2f7d4c;background:#3a9b5f12}
[data-amadeus-qq] .muted{opacity:.72}
[data-amadeus-qq] select{font:inherit;border:1px solid var(--dsw-alias-border-secondary,#8c8c8c55);border-radius:8px;padding:5px 8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;max-width:100%}
[data-amadeus-qq] select:disabled{opacity:.5}
[data-amadeus-qq] .editorRow{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:8px 0;border-top:1px dashed var(--dsw-alias-border-secondary,#8c8c8c33)}
[data-amadeus-qq] .editorRow:first-of-type{border-top:0}
[data-amadeus-qq] .editorMain{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
[data-amadeus-qq] .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
[data-amadeus-qq] .sceneRow.selected{border-color:var(--am-qq-accent);box-shadow:0 0 0 1px var(--am-qq-accent) inset}
[data-amadeus-qq] .sceneRow{cursor:pointer}
`

function formatTransport(status) {
  if (status === 'connected') return 'OneBot 已连接'
  if (status === 'disabled') return 'OneBot 连接已禁用'
  if (status === 'mock') return 'OneBot 模拟传输'
  return 'OneBot 连接状态未知'
}

function modeLabel(mode) {
  return MODE_LABELS[mode] || String(mode || '未设置')
}

function capabilityLabel(id) {
  return CAPABILITY_LABELS[id] || id
}

function friendlyError(error) {
  if (error?.status === 403) return '当前请求没有通过 DSH Owner 验证（403）；请从已认证的 DSH 页面访问。'
  if (error?.status === 503) return '管理接口不可用（503）；QQ 插件可能未启用或缺少 Host 服务。'
  if (error?.status === 409) return '权限已被其他窗口修改（409）；请重新加载后再编辑。'
  return error?.message ? String(error.message) : '未知错误'
}

function Panel() {
  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  const [readOnly, setReadOnly] = React.useState(false)
  const [selectedKey, setSelectedKey] = React.useState('')
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [selectionHint, setSelectionHint] = React.useState('')
  const loadSeq = React.useRef(0)
  const draftRef = React.useRef(null)
  const selectedKeyRef = React.useRef('')
  draftRef.current = draft
  selectedKeyRef.current = selectedKey

  const load = React.useCallback(async (options) => {
    const forceSync = options?.forceSync === true
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchScenes()
      if (seq !== loadSeq.current) return
      setData(next)
      setReadOnly(false)
      setSelectionHint('')
      const list = Array.isArray(next.scenes) ? next.scenes : []
      const entry = list.find(item => item.key === selectedKeyRef.current) || list[0] || null
      setSelectedKey(entry?.key ?? '')
      const previous = draftRef.current
      if (!entry) {
        setDraft(null)
        draftRef.current = null
        return
      }
      if (forceSync || !previous || previous.sceneKey !== entry.key) {
        const fresh = { ...draftFromEntry(entry), sceneKey: entry.key }
        setDraft(fresh)
        draftRef.current = fresh
        setConflict(false)
        return
      }
      if (isDraftDirty(entry, previous)) {
        if (revisionOf(entry) !== previous.expectedRevision) setConflict(true)
        return
      }
      const fresh = { ...draftFromEntry(entry), sceneKey: entry.key }
      setDraft(fresh)
      draftRef.current = fresh
      setConflict(false)
    } catch (failure) {
      if (seq !== loadSeq.current) return
      setError(failure)
      setReadOnly(failure.status === 403 || failure.status === 503)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const scenes = Array.isArray(data?.scenes) ? data.scenes : []
  const health = data?.health ?? null
  const selected = scenes.find(item => item.key === selectedKey) || null
  const dirty = selected && draft ? isDraftDirty(selected, draft) : false
  const validation = selected && draft ? validateDraft(selected, draft) : '未选择场景'
  const modes = Array.isArray(data?.modes) && data.modes.length > 0 ? data.modes : MODE_IDS
  const disabled = busy || readOnly || conflict || !selected || !draft

  const selectScene = (entry) => {
    if (busy) {
      setSelectionHint('正在保存权限，请等待保存完成后再切换场景。')
      return
    }
    const selection = nextDraftForSelection(selected, draft, entry)
    if (selection.blocked) {
      setSelectionHint('当前场景有未保存的权限修改；请先保存或取消修改后再切换场景。')
      return
    }
    setSelectedKey(entry.key)
    setDraft(selection.draft)
    draftRef.current = selection.draft
    setConflict(false)
    setSelectionHint('')
    setNotice('')
    setError(null)
  }

  const changeMode = (mode) => {
    setDraft(previous => (previous ? { ...previous, mode } : previous))
    setNotice('')
  }

  const changeOverride = (capability, value) => {
    setDraft(previous => {
      if (!previous) return previous
      const overrides = { ...previous.overrides }
      if (value === 'inherit') delete overrides[capability]
      else overrides[capability] = value
      return { ...previous, overrides }
    })
    setNotice('')
  }

  const cancel = () => {
    if (conflict) {
      setConflict(false)
      setSelectionHint('')
      void load({ forceSync: true })
      return
    }
    if (!selected) return
    const fresh = { ...draftFromEntry(selected), sceneKey: selected.key }
    setDraft(fresh)
    draftRef.current = fresh
    setConflict(false)
    setSelectionHint('')
    setNotice('')
    setError(null)
  }

  const reloadLatest = () => {
    setConflict(false)
    setSelectionHint('')
    void load({ forceSync: true })
  }

  const save = async () => {
    if (!selected || !draft || validation || busy || readOnly || conflict) return
    setBusy(true)
    setSelectionHint('')
    setError(null)
    setNotice('')
    try {
      await savePermissions(selected, draft)
      await load({ forceSync: true })
      setNotice('已保存')
    } catch (failure) {
      if (failure.status === 409) {
        setConflict(true)
        setError(null)
      } else {
        setError(failure)
        if (failure.status === 403 || failure.status === 503) setReadOnly(true)
      }
    } finally {
      setBusy(false)
    }
  }

  const sceneRow = (entry) => {
    const scene = entry.scene || {}
    const sceneId = String(scene.botId) + ':' + String(scene.peerId)
    const mode = entry.permissions?.mode ?? entry.effectiveMode
    const isSelected = entry.key === selectedKey
    return React.createElement(
      'div',
      {
        className: 'sceneRow' + (isSelected ? ' selected' : ''),
        key: entry.key || sceneId,
        role: 'button',
        tabIndex: 0,
        onClick: () => selectScene(entry),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') selectScene(entry) },
      },
      React.createElement(
        'div',
        { className: 'sceneHead' },
        React.createElement('strong', null, scene.kind === 'group' ? '群聊' : '私聊'),
        React.createElement('span', { className: 'mono' }, sceneId),
        React.createElement('span', { className: 'chip' }, modeLabel(mode)),
        React.createElement('span', { className: 'chip' }, 'revision ' + revisionOf(entry)),
        React.createElement('span', { className: 'chip ' + (entry.health?.sessionActive ? 'ok' : 'warn') }, entry.health?.sessionActive ? 'Session 活跃' : '无活动 Session'),
        entry.ownerEligible ? React.createElement('span', { className: 'chip ok' }, '可信 Owner 私聊') : null,
      ),
    )
  }

  return React.createElement(
    'div',
    { 'data-amadeus-qq': 'true' },
    React.createElement('style', null, CSS),
    React.createElement(
      'div',
      { className: 'topbar' },
      React.createElement(
        'div',
        null,
        React.createElement('h2', null, 'Amadeus QQ'),
        React.createElement('div', { className: 'sub' }, 'QQ 场景权限。选择场景后可调整模式与能力覆盖；未实现能力只记录策略，不会执行。'),
      ),
      React.createElement('button', { type: 'button', onClick: () => { void load() }, disabled: loading || busy }, loading ? '刷新中…' : '刷新'),
    ),
    React.createElement(
      'div',
      { className: 'chips' },
      React.createElement('span', { className: 'chip ' + (health?.enabled ? 'ok' : 'warn') }, health?.enabled ? '插件运行中' : '插件未运行'),
      React.createElement('span', { className: 'chip ' + (health?.transport === 'connected' ? 'ok' : 'warn') }, formatTransport(health?.transport)),
      React.createElement('span', { className: 'chip' }, '已见场景：' + (health?.scenes ?? scenes.length)),
      React.createElement('span', { className: 'chip' }, '活跃等待：' + (health?.activeWaits ?? 0)),
    ),
    readOnly ? React.createElement('div', { className: 'message error' }, '此页面为只读：当前请求没有通过 DSH Owner 验证，或管理接口不可用。仅本机访问不等于管理员授权。') : null,
    error ? React.createElement('div', { className: 'message error', role: 'alert' }, '读取或保存失败：' + friendlyError(error)) : null,
    notice ? React.createElement('div', { className: 'message success', role: 'status' }, notice) : null,
    selectionHint ? React.createElement('div', { className: 'message error', role: 'alert' }, selectionHint) : null,
    loading && !data ? React.createElement('p', { role: 'status' }, '正在读取 QQ 场景…') : null,
    !loading && !error && scenes.length === 0
      ? React.createElement('div', { className: 'panel' }, React.createElement('p', null, '暂无已见且在允许列表内的 QQ 场景。'), React.createElement('small', null, '场景只有在收到可信 QQ 事件后才会出现在这里。'))
      : null,
    scenes.length > 0
      ? React.createElement(
          'div',
          { className: 'panel' },
          React.createElement('h3', null, '已见场景'),
          React.createElement('small', null, '仅显示场景元数据与权限摘要；不包含聊天正文、凭据、令牌或真实文件路径。'),
          ...scenes.map(sceneRow),
        )
      : null,
    selected && draft
      ? React.createElement(
          'div',
          { className: 'panel' },
          React.createElement(
            'div',
            { className: 'sceneHead' },
            React.createElement('h3', null, '编辑权限'),
            React.createElement('span', { className: 'chip' }, 'revision ' + revisionOf(selected)),
            React.createElement('span', { className: 'chip ' + (dirty ? 'warn' : 'ok') }, dirty ? '有未保存修改' : '无未保存修改'),
          ),
          React.createElement('small', null, '保存时发送 expectedRevision；冲突不会被自动覆盖。'),
          conflict
            ? React.createElement(
                'div',
                { className: 'message error', role: 'alert' },
                '权限已被其他窗口修改（409）。请重新加载最新权限后再编辑；当前草稿不会自动覆盖。',
                React.createElement('div', { className: 'actions' }, React.createElement('button', { type: 'button', onClick: reloadLatest }, '重新加载最新权限')),
              )
            : null,
          validation ? React.createElement('div', { className: 'message error', role: 'alert' }, validation) : null,
          React.createElement(
            'div',
            { className: 'editorRow' },
            React.createElement(
              'div',
              { className: 'editorMain' },
              React.createElement('strong', null, '模式'),
              React.createElement('small', null, '五级模式只代表能力，不包含人格。'),
            ),
            React.createElement(
              'select',
              {
                value: draft.mode,
                disabled,
                'aria-label': '场景模式',
                onChange: (event) => changeMode(event.target.value),
              },
              ...modes.map(mode => React.createElement(
                'option',
                {
                  key: mode,
                  value: mode,
                  disabled: mode === 'owner-agent' && selected.ownerEligible !== true,
                },
                modeLabel(mode),
              )),
            ),
          ),
          draft.mode === 'owner-agent' || draft.mode === 'autonomous-social'
            ? React.createElement('small', { className: 'muted', role: 'note' }, RESERVED_MODE_NOTE)
            : null,
          ...(selected.capabilities ?? []).map(cap => React.createElement(
            'div',
            { className: 'editorRow', key: cap.id },
            React.createElement(
              'div',
              { className: 'editorMain' },
              React.createElement('strong', null, capabilityLabel(cap.id)),
              React.createElement('small', null, cap.id),
              React.createElement('span', { className: 'chip ' + (cap.implemented ? 'ok' : 'warn') },
                cap.implemented ? '已实现' : '策略占位，尚不可执行'),
            ),
            React.createElement(
              'div',
              { className: 'editorMain' },
              React.createElement(
                'select',
                {
                  value: draft.overrides[cap.id] ?? 'inherit',
                  disabled,
                  'aria-label': capabilityLabel(cap.id) + ' 覆盖',
                  onChange: (event) => changeOverride(cap.id, event.target.value),
                },
                React.createElement('option', { value: 'inherit' }, 'inherit（继承模式）'),
                React.createElement('option', { value: 'allow' }, 'allow（显式允许）'),
                React.createElement('option', { value: 'deny' }, 'deny（显式拒绝）'),
              ),
              React.createElement(
                'span',
                { className: 'chip ' + (cap.implemented ? (cap.effective ? 'ok' : 'warn') : 'warn') },
                cap.implemented
                  ? (cap.effective ? '当前允许' : '当前拒绝') + (draft.overrides[cap.id] && draft.overrides[cap.id] !== cap.override ? '（保存后生效）' : '')
                  : '策略占位，尚不可执行',
              ),
            ),
          )),
          React.createElement(
            'div',
            { className: 'actions' },
            React.createElement('button', { type: 'button', className: 'primary', onClick: save, disabled: disabled || !dirty || Boolean(validation) }, busy ? '保存中…' : '保存'),
            React.createElement('button', { type: 'button', onClick: cancel, disabled: busy || (!dirty && !conflict) }, '取消修改'),
          ),
        )
      : null,
    React.createElement('small', { className: 'muted' }, '管理接口要求 DSH Owner admission 与同源请求；该页面不自行判断管理员身份。'),
  )
}

return {
  inject: ['slots'],
  apply(ctx) {
    let active
    const activate = () => {
      if (active) return active.dispose
      let dispose = () => {}
      try {
        dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'amadeus-qq',
          order: 30,
          label: () => 'Amadeus QQ',
        }, Panel)) || (() => {})
      } catch (error) {
        console.error('[amadeus-qq] settings.section unavailable', error)
      }
      const disposal = () => {
        if (!active || active.dispose !== disposal) return
        active = undefined
        try { dispose() } catch { /* already disposed */ }
      }
      active = { dispose: disposal }
      return disposal
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => activate(), 'amadeus-qq: settings page')
    else activate()
  },
}

  }
});
