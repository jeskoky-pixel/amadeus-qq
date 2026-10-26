// Pure client-side helpers, inlined into the browser bundle by build-client.
// No ESM imports here: the bundle is a lazy-CJS factory with only React injected.

export const API_ROOT = '/api/amadeus-qq'
export const MODE_IDS = Object.freeze([
  'observe', 'safe-chat', 'enhanced', 'autonomous-social', 'owner-agent',
])
const OVERRIDE_VALUES = new Set(['inherit', 'allow', 'deny'])

export function revisionOf(entry) {
  return entry?.revision ?? 0
}

export function draftFromEntry(entry) {
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

export function isDraftDirty(entry, draft) {
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
export function nextDraftForSelection(currentEntry, currentDraft, targetEntry) {
  if (currentDraft && isDraftDirty(currentEntry, currentDraft)) {
    return { blocked: true, draft: currentDraft }
  }
  if (!targetEntry) return { blocked: false, draft: null }
  const fresh = { ...draftFromEntry(targetEntry), sceneKey: targetEntry.key }
  return { blocked: false, draft: fresh }
}

export function validateDraft(entry, draft) {
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

export function buildSaveRequest(entry, draft) {
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
    if (typeof payload?.code === 'string') error.code = payload.code
    if (response.status === 409) error.conflict = true
    throw error
  }
  return payload.data
}

/**
 * True only when the management surface is genuinely unusable for this page:
 * authentication/owner admission failed, or the Host lacks the management
 * service. Only the explicitly listed policy rejections and session-cancel
 * failures stay editable; any unknown code falls back to its HTTP status so an
 * unrecognized 401/403/503 keeps the editor locked (fail closed).
 */
const EDITABLE_FAILURE_CODES = new Set([
  'QQ_OWNER_AGENT_FORBIDDEN',
  'QQ_SCENE_UNAUTHORIZED',
  'QQ_SESSION_CANCEL_FAILED',
  'QQ_SESSION_CANCEL_UNAVAILABLE',
  'QQ_PERMISSION_CONFLICT',
])

export function requiresReadOnly(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'QQ_AUTH_REQUIRED' || code === 'QQ_MANAGEMENT_UNAVAILABLE') return true
  if (EDITABLE_FAILURE_CODES.has(code)) return false
  const status = Number(error?.status)
  return status === 401 || status === 403 || status === 503
}

/** Fixed Chinese guidance per management failure code; never echoes server internals. */
export function managementErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'QQ_PERMISSION_CONFLICT' || error?.status === 409) {
    return '权限已被其他窗口修改（409）；请重新加载后再编辑。'
  }
  if (code === 'QQ_AUTH_REQUIRED') {
    return '当前请求没有通过 DSH 认证或 Owner 授权；请从已认证的 DSH 页面访问。'
  }
  if (code === 'QQ_MANAGEMENT_UNAVAILABLE') {
    return '管理接口不可用；QQ 插件可能未启用或缺少 Host 服务。'
  }
  if (code === 'QQ_OWNER_AGENT_FORBIDDEN') {
    return 'Owner Agent 仅可用于已配置的可信 Owner 私聊；当前场景或配置不允许保存该模式。'
  }
  if (code === 'QQ_SCENE_UNAUTHORIZED') {
    return '该场景已不在 QQ 允许列表内；请更新配置并刷新后再操作。'
  }
  if (code === 'QQ_SESSION_CANCEL_FAILED' || code === 'QQ_SESSION_CANCEL_UNAVAILABLE') {
    return '权限可能已写入，但旧 QQ Session 未能安全取消；请刷新确认最新 revision 后再编辑。'
  }
  if (code === 'QQ_REQUEST_INVALID') {
    return '管理请求无效；请刷新后重试。'
  }
  const status = Number(error?.status)
  if (status === 401 || status === 403) {
    return '当前请求没有通过 DSH 认证或 Owner 授权（HTTP ' + status + '）；请从已认证的 DSH 页面访问。'
  }
  if (status === 503) {
    return '管理接口不可用（503）；QQ 插件可能未启用或缺少 Host 服务。'
  }
  return 'QQ 管理请求失败' + (Number.isInteger(status) ? '（HTTP ' + status + '）' : '')
}

export async function fetchScenes(fetchImpl = fetch) {
  const response = await fetchImpl(API_ROOT + '/scenes', {
    credentials: 'same-origin',
    headers: { 'x-amadeus-qq': '1' },
  })
  return readPayload(response)
}

export async function savePermissions(entry, draft, fetchImpl = fetch) {
  const response = await fetchImpl(API_ROOT + '/scenes/permissions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-amadeus-qq': '1' },
    body: JSON.stringify(buildSaveRequest(entry, draft)),
  })
  return readPayload(response)
}
