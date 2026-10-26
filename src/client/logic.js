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
    if (response.status === 409) error.conflict = true
    throw error
  }
  return payload.data
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
