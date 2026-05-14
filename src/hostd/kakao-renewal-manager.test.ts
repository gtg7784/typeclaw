import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encrypt } from '@/secrets/encryption'
import type { AttemptLoginFn } from '@/secrets/kakao-renewal'
import { createKeyStore } from '@/secrets/keys'
import type { KakaoChannelBlock } from '@/secrets/schema'

import { createKakaoRenewalManager, type KakaoRenewalLogEvent } from './kakao-renewal-manager'

async function setupAgent(opts: {
  agentDir: string
  ageDays: number
  withEncryptedPassword: boolean
  key?: Buffer
}): Promise<{
  containerName: string
  cwd: string
  key: Buffer
  keysDir: string
}> {
  const updatedAt = new Date(Date.now() - opts.ageDays * 24 * 60 * 60 * 1000).toISOString()
  const containerName = 'kakao'
  const keysDir = join(opts.agentDir, 'keys')
  const ks = createKeyStore({ keysDir })
  const key = opts.key ?? (await ks.ensure(containerName))
  const encryptedPassword = opts.withEncryptedPassword
    ? encrypt('hunter2', key, { containerName, accountId: 'u-1' })
    : undefined
  const block: KakaoChannelBlock = {
    currentAccount: 'u-1',
    accounts: {
      'u-1': {
        account_id: 'u-1',
        oauth_token: 'old-oauth',
        user_id: 'u-1',
        refresh_token: 'old-refresh',
        device_uuid: 'device-uuid',
        device_type: 'tablet',
        auth_method: 'login',
        created_at: updatedAt,
        updated_at: updatedAt,
        email: 'u@e.com',
        ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
      },
    },
  }
  const envelope = { version: 2, providers: {}, channels: { kakaotalk: block } }
  await writeFile(join(opts.agentDir, 'secrets.json'), JSON.stringify(envelope))
  return { containerName, cwd: opts.agentDir, key, keysDir }
}

async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return fn(await mkdtemp(join(tmpdir(), 'typeclaw-kakao-renewal-mgr-')))
}

describe('createKakaoRenewalManager', () => {
  test('runs the first tick immediately on start (no waiting for interval)', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      const events: KakaoRenewalLogEvent[] = []
      let attemptCalls = 0
      const attemptLogin: AttemptLoginFn = async (email, _password, deviceUuid, deviceType) => {
        attemptCalls++
        return {
          authenticated: true,
          credentials: {
            access_token: 'fresh',
            refresh_token: 'fresh-refresh',
            user_id: 'u-1',
            device_uuid: deviceUuid,
            device_type: deviceType,
          },
        }
      }

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin,
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await new Promise((r) => setTimeout(r, 30))

      expect(attemptCalls).toBe(1)
      expect(events.some((e) => e.kind === 'kakao-renewal-tick-ok')).toBe(true)

      await manager.drain()
    })
  })

  test('emits tick-skipped (fresh_enough) when the token is fresh', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 2, withEncryptedPassword: true })
      const events: KakaoRenewalLogEvent[] = []

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async () => {
          throw new Error('must not be called for a fresh account')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await new Promise((r) => setTimeout(r, 30))

      expect(events.some((e) => e.kind === 'kakao-renewal-tick-skipped')).toBe(true)

      await manager.drain()
    })
  })

  test('emits tick-reauth-required when the key file is missing', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      await writeFile(join(setup.keysDir, `${setup.containerName}.key`), Buffer.alloc(0)) // force missing/corrupt
      const events: KakaoRenewalLogEvent[] = []

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async () => {
          throw new Error('must not be called when key file is unusable')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await new Promise((r) => setTimeout(r, 30))

      expect(events.some((e) => e.kind === 'kakao-renewal-tick-reauth-required')).toBe(true)

      await manager.drain()
    })
  })

  test('stop() cancels the scheduled timer', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      let scheduleStopCalled = 0

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async () => ({
          authenticated: true,
          credentials: {
            access_token: 'x',
            refresh_token: 'y',
            user_id: 'u-1',
            device_uuid: 'd',
            device_type: 'tablet',
          },
        }),
        schedule: (_fn, _ms) => ({
          stop: () => {
            scheduleStopCalled++
          },
        }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await new Promise((r) => setTimeout(r, 30))
      await manager.stop(setup.containerName)

      expect(scheduleStopCalled).toBe(1)

      await manager.drain()
    })
  })

  test('start() called twice for the same container replaces the timer', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      let scheduleStopCalled = 0

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async () => ({
          authenticated: true,
          credentials: {
            access_token: 'x',
            refresh_token: 'y',
            user_id: 'u-1',
            device_uuid: 'd',
            device_type: 'tablet',
          },
        }),
        schedule: (_fn, _ms) => ({
          stop: () => {
            scheduleStopCalled++
          },
        }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await new Promise((r) => setTimeout(r, 30))

      expect(scheduleStopCalled).toBe(1)

      await manager.drain()
    })
  })

  test('drain() stops all timers', async () => {
    await withAgentDir(async (dir) => {
      const a = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      let scheduleStopCalled = 0

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: a.keysDir }),
        attemptLogin: async () => ({
          authenticated: true,
          credentials: {
            access_token: 'x',
            refresh_token: 'y',
            user_id: 'u-1',
            device_uuid: 'd',
            device_type: 'tablet',
          },
        }),
        schedule: (_fn, _ms) => ({
          stop: () => {
            scheduleStopCalled++
          },
        }),
      })

      manager.start({ containerName: 'agent-a', cwd: a.cwd })
      manager.start({ containerName: 'agent-b', cwd: a.cwd })
      await new Promise((r) => setTimeout(r, 30))
      await manager.drain()

      expect(scheduleStopCalled).toBe(2)
    })
  })
})
