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

const CAPABILITY_REASON_HINTS = Object.freeze({
  'owner-directory-required': '需在可信 Owner 私聊使用 Owner Agent 模式，并对该能力显式 allow。',
  'global-deny': '宿主全局策略拒绝该能力，Scene 设置无法解除。',
  'account-publish-required': '该 QQ 账号未获授权使用 QQ 空间发布。',
  'scene-deny': '该 Scene 显式拒绝（deny）此能力。',
  'owner-private-required': '仅可信 Owner 私聊的 Owner Agent 模式可用。',
  'owner-tool-required': '宿主未为该 Owner 场景配置此工具。',
  'group-only': '仅群聊 Scene 可用；私聊不适用，与 Owner 权限无关。',
  'qzone-read-explicit': '需在自主社交或可信 Owner Agent 模式显式 allow 才能读取 QZone。',
  'qzone-use-explicit': '需在自主社交或可信 Owner Agent 模式显式 allow 才能使用 QZone。',
  'profile-write-explicit': '账号资料写入仅限可信 Owner 私聊的 Owner Agent 模式并显式 allow。',
  'owner-workspace-required': 'Owner 工作区需可信 Owner 私聊、Owner Agent 模式并显式 allow。',
  mode: '当前模式未包含此能力。',
  'scene-allow': '该 Scene 显式允许，但保存后按最新模式重算。',
})

/**
 * Fixed Chinese guidance for an implemented-but-denied capability. Uses only
 * known denial reasons; an unknown reason falls back to a generic sentence and
 * never echoes the server value. `Object.hasOwn` keeps names such as
 * `constructor` or `toString` from resolving to inherited Object members.
 */
export function capabilityStateHint(capability) {
  if (!capability || capability.implemented !== true || capability.effective === true) return null
  const reason = capability.reason
  return typeof reason === 'string' && Object.hasOwn(CAPABILITY_REASON_HINTS, reason)
    ? CAPABILITY_REASON_HINTS[reason]
    : '当前策略拒绝该能力。'
}

/** Configuration hints; never a path, token or credential. */
export function capabilityConfigHint(capability, runtime = {}) {
  if (!capability || capability.implemented !== true) return null
  if (capability.id === 'qq.owner.workspace' && runtime.ownerWorkspace?.configured !== true) {
    return '需要核心用实际 QQ 配置注册专用目录并授权后才可用。'
  }
  if ((capability.id === 'qq.qzone.use' || capability.id === 'qq.qzone.read' || capability.id === 'qq.qzone.publish')
    && runtime.providers?.qzone?.installed !== true) {
    return '需要配置 QZone loopback Provider 后才可用；当前未观测到接线。'
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
  if (code === 'QQ_PERMISSION_CONFLICT') {
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
  if (code === 'QQ_DELIVERY_IN_FLIGHT') {
    return '该投递仍在进行中，现在不能标记为失败；请稍后刷新重试。'
  }
  if (code === 'QQ_DELIVERY_NOT_UNKNOWN') {
    return '该投递已不是 unknown 状态；请刷新确认后再操作。'
  }
  if (code === 'QQ_DELIVERY_NOT_FOUND') {
    return '未找到该 actionId 的未知投递；请刷新后确认。'
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

/**
 * Storage key for one operator confirmation input. It is scoped to the Scene
 * and prefixed, so two Scenes with the same actionId never share a draft, and
 * prototype names such as `__proto__` or `constructor` can never be the key.
 * The API still receives the untouched actionId.
 */
export function deliveryInputKey(entry, actionId) {
  return 'delivery-confirm:' + String(entry?.key ?? '') + '|' + String(actionId)
}

/**
 * Fixed Settings copy for the Owner workspace. It never includes a directory
 * path, token or provider URL; an unwired core keeps the feature "pending".
 */
export function ownerWorkspaceSummary(status) {
  const configured = status?.configured === true
  const writes = status?.writes === true
  const maxBytes = Number.isSafeInteger(status?.maxBytes) && status.maxBytes > 0 ? status.maxBytes : 0
  return {
    state: configured ? '已接线' : 'pending（待核心接线）',
    writes: writes ? '可写（逐次审批）' : '只读',
    maxBytes,
    note: configured
      ? '目录与写入授权由插件配置决定；本页不显示路径，也不保存配置。实机写入仍需人工审批，尚未完成真实验证。'
      : 'Owner preset 已随包；核心尚未用实际 QQ 配置注册 Owner 工作区（未接线），当前不可读、不可写。',
  }
}

/** Provider labels only; never a root path, loopback URL or token value. */
export function providerSummary(providers) {
  const stateOf = provider => {
    if (provider?.installed !== true) return '未观测到接线'
    if (provider?.configured !== true) return '已安装，未配置'
    return provider?.enabled === true ? '已配置' : '已安装，未启用'
  }
  return {
    mediaSend: stateOf(providers?.mediaSend),
    qzone: stateOf(providers?.qzone),
  }
}

/**
 * Manual reconciliation for one unknown delivery. Only the owner management
 * surface can do this, and the body never carries message content: just the
 * Scene identity, the operator-confirmed actionId and the fixed outcome.
 */
export async function resolveUnknownDelivery(entry, actionId, fetchImpl = fetch) {
  const response = await fetchImpl(API_ROOT + '/deliveries/resolve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-amadeus-qq': '1' },
    body: JSON.stringify({
      scene: {
        botId: entry.scene.botId,
        kind: entry.scene.kind,
        peerId: entry.scene.peerId,
      },
      actionId,
      outcome: 'failed',
    }),
  })
  return readPayload(response)
}
