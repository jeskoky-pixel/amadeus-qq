import { createHash } from 'node:crypto'
import path from 'node:path'
import { snapshotControlledImage } from './outbound-media.js'

const STATUS_VALUES = new Set([10, 30, 40, 50, 60, 70])
const MAX_SIGNATURE = 200
const MAX_NICKNAME = 36

function profileError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function cleanText(value, max, code) {
  if (typeof value !== 'string') throw profileError(code)
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (text.length === 0 || text.length > max) throw profileError(code)
  return text
}

function decimalId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw profileError('QQ_PROFILE_RESPONSE_INVALID')
  return id
}

function responseInvalid() {
  return profileError('QQ_PROFILE_RESPONSE_INVALID')
}

function profileFingerprint(scene, action, payload) {
  return createHash('sha256')
    .update(JSON.stringify({
      account: scene.botId,
      scene: scene.peerId,
      action,
      payload,
    }))
    .digest('hex')
}

export function createAccountProfile({ core, transport, authorize, ledger, sendRoot, tempRoot }) {
  if (typeof authorize !== 'function') throw profileError('QQ_PROFILE_UNAUTHORIZED')
  if (!transport || typeof transport.action !== 'function') throw profileError('QQ_PROFILE_UNAVAILABLE')

  async function check(sessionId, action, write) {
    let scene
    try {
      scene = core.authorizedScene(sessionId)
    } catch {
      throw profileError('QQ_PROFILE_UNAUTHORIZED')
    }
    if (write && scene.kind !== 'private') throw profileError('QQ_PROFILE_OWNER_REQUIRED')
    let allowed = false
    try {
      allowed = await authorize({ action, write, sessionId, scene }) === true
    } catch {
      allowed = false
    }
    if (!allowed) throw profileError('QQ_PROFILE_UNAUTHORIZED')
    return scene
  }

  async function call(action, params, write) {
    let data
    try {
      data = await transport.action(action, params, 10_000)
    } catch (error) {
      if (!write) throw profileError('QQ_PROFILE_UNAVAILABLE')
      if (error?.code === 'ONEBOT_REJECTED') throw profileError('QQ_PROFILE_REJECTED')
      throw profileError('QQ_PROFILE_UNKNOWN')
    }
    if (data === null || data === undefined) {
      if (write) return {}
      throw responseInvalid()
    }
    if (typeof data !== 'object') throw responseInvalid()
    return data
  }

  async function loginInfo(sessionId, write = false) {
    const data = await call('get_login_info', {}, write)
    return { userId: decimalId(data.user_id), nickname: typeof data.nickname === 'string' ? data.nickname.slice(0, MAX_NICKNAME) : '' }
  }

  async function strangerInfo(sessionId, userId, write = false) {
    const data = await call('get_stranger_info', { user_id: userId, no_cache: true }, write)
    return {
      longNick: typeof data.long_nick === 'string' ? data.long_nick.slice(0, MAX_SIGNATURE) : '',
      status: Number.isFinite(Number(data.status)) ? Number(data.status) : null,
    }
  }

  async function userStatus(userId, write = false) {
    const data = await call('nc_get_user_status', { user_id: userId }, write)
    const status = Number(data.status)
    const extStatus = Number(data.ext_status)
    if (!Number.isSafeInteger(status) || !Number.isSafeInteger(extStatus)) throw responseInvalid()
    return { status, extStatus }
  }

  async function readProfileInternal(sessionId, write = false) {
    const login = await loginInfo(sessionId, write)
    const stranger = await strangerInfo(sessionId, login.userId, write)
    const online = await userStatus(login.userId, write)
    return {
      userId: login.userId,
      nickname: login.nickname,
      signature: stranger.longNick,
      status: online.status,
      extStatus: online.extStatus,
    }
  }

  async function writeWithLedger(sessionId, action, payload, actionId, verify) {
    const scene = await check(sessionId, action, true)
    if (!ledger || typeof ledger.run !== 'function') throw profileError('QQ_PROFILE_LEDGER_REQUIRED')
    if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) throw profileError('QQ_PROFILE_ACTION_ID_INVALID')
    const fingerprint = profileFingerprint(scene, action, payload)
    return ledger.run({
      actionId,
      fingerprint,
      action,
      sessionId,
      sceneKey: `${scene.botId}:${scene.kind}:${scene.peerId}`,
      execute: async () => {
        await call(action, payload, true)
        try {
          await check(sessionId, action, true)
        } catch {
          // The platform write already happened; do not report a clean failure.
          throw profileError('QQ_PROFILE_UNKNOWN')
        }
        let profile
        try {
          profile = await readProfileInternal(sessionId, true)
          if (!(await verify(profile))) throw profileError('QQ_PROFILE_UNKNOWN')
        } catch (error) {
          if (error?.code === 'QQ_PROFILE_UNKNOWN') throw error
          throw profileError('QQ_PROFILE_UNKNOWN')
        }
        try {
          await check(sessionId, action, true)
        } catch {
          throw profileError('QQ_PROFILE_UNKNOWN')
        }
        return profile
      },
    })
  }

  return Object.freeze({
    async readProfile({ sessionId }) {
      await check(sessionId, 'get_login_info', false)
      const profile = await readProfileInternal(sessionId)
      await check(sessionId, 'get_login_info', false)
      return profile
    },

    async setSignature({ sessionId, signature, actionId }) {
      const value = cleanText(signature, MAX_SIGNATURE, 'QQ_PROFILE_SIGNATURE_INVALID')
      return writeWithLedger(sessionId, 'set_self_longnick', { longNick: value }, actionId,
        profile => profile.signature === value)
    },

    async setNickname({ sessionId, nickname, actionId }) {
      const value = cleanText(nickname, MAX_NICKNAME, 'QQ_PROFILE_NICKNAME_INVALID')
      return writeWithLedger(sessionId, 'set_qq_profile', { nickname: value }, actionId,
        profile => profile.nickname === value)
    },

    async setOnlineStatus({ sessionId, status, extStatus, batteryStatus, actionId }) {
      if (!Number.isSafeInteger(status) || !STATUS_VALUES.has(status)) throw profileError('QQ_PROFILE_STATUS_INVALID')
      if (!Number.isSafeInteger(extStatus) || extStatus < 0 || extStatus > 9999) throw profileError('QQ_PROFILE_STATUS_INVALID')
      if (!Number.isSafeInteger(batteryStatus) || batteryStatus < 0 || batteryStatus > 100) throw profileError('QQ_PROFILE_STATUS_INVALID')
      return writeWithLedger(sessionId, 'set_online_status', {
        status, ext_status: extStatus, battery_status: batteryStatus,
      }, actionId, profile => profile.status === status && profile.extStatus === extStatus)
    },

    async setAvatar({ sessionId, path: relativePath, actionId }) {
      if (typeof sendRoot !== 'string' || !path.isAbsolute(sendRoot)) {
        throw profileError('QQ_PROFILE_AVATAR_ROOT_INVALID')
      }
      const scene = await check(sessionId, 'set_qq_avatar', true)
      if (!ledger || typeof ledger.run !== 'function') throw profileError('QQ_PROFILE_LEDGER_REQUIRED')
      if (typeof actionId !== 'string' || !/^[\w-]{1,100}$/.test(actionId)) throw profileError('QQ_PROFILE_ACTION_ID_INVALID')

      let snapshot
      try {
        snapshot = await snapshotControlledImage({ sendRoot, relativePath, tempRoot })
      } catch {
        throw profileError('QQ_PROFILE_AVATAR_INVALID')
      }
      const fingerprint = profileFingerprint(scene, 'set_qq_avatar', {
        sha256: snapshot.sha256,
        mediaType: snapshot.mediaType,
      })
      try {
        return await ledger.run({
          actionId,
          fingerprint,
          action: 'set_qq_avatar',
          sessionId,
          sceneKey: `${scene.botId}:${scene.kind}:${scene.peerId}`,
          execute: async () => {
            await call('set_qq_avatar', { file: snapshot.path }, true)
            try {
              await check(sessionId, 'set_qq_avatar', true)
            } catch {
              // The platform accepted the write; a later revocation is unknown.
              throw profileError('QQ_PROFILE_UNKNOWN')
            }
            return { status: 'confirmed', mediaType: snapshot.mediaType, bytes: snapshot.bytes }
          },
        })
      } finally {
        await snapshot.cleanup()
      }
    },
  })
}
