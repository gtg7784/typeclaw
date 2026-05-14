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

  test('invokes onRenewalOk after a successful renewal, so the host can restart the container', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      const restartCalls: Array<{ containerName: string; cwd: string; accountId: string }> = []

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async (_email, _password, deviceUuid, deviceType) => ({
          authenticated: true,
          credentials: {
            access_token: 'fresh',
            refresh_token: 'fresh-refresh',
            user_id: 'u-1',
            device_uuid: deviceUuid,
            device_type: deviceType,
          },
        }),
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async (input) => {
          restartCalls.push(input)
        },
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.drain()

      expect(restartCalls).toEqual([{ containerName: setup.containerName, cwd: setup.cwd, accountId: 'u-1' }])
    })
  })

  test('does NOT invoke onRenewalOk when the renewal skips, reauth-requires, or transient-fails', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 2, withEncryptedPassword: true })
      let restartCalls = 0

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async () => {
          throw new Error('attemptLogin should not run for a fresh account')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async () => {
          restartCalls++
        },
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.drain()

      expect(restartCalls).toBe(0)
    })
  })

  test('logs kakao-renewal-restart-failed when onRenewalOk throws', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      const events: KakaoRenewalLogEvent[] = []

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async (_email, _password, deviceUuid, deviceType) => ({
          authenticated: true,
          credentials: {
            access_token: 'fresh',
            refresh_token: 'fresh-refresh',
            user_id: 'u-1',
            device_uuid: deviceUuid,
            device_type: deviceType,
          },
        }),
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async () => {
          throw new Error('docker stop refused')
        },
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.drain()

      expect(events.some((e) => e.kind === 'kakao-renewal-tick-ok')).toBe(true)
      expect(events.some((e) => e.kind === 'kakao-renewal-restart-failed')).toBe(true)
    })
  })

  test('shouldRenew=false suppresses the cron entirely (no tick, no timer, no log spam)', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      const events: KakaoRenewalLogEvent[] = []
      let scheduleCalls = 0
      let attemptCalls = 0

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async () => {
          attemptCalls++
          throw new Error('attemptLogin should not run for a non-kakao agent')
        },
        schedule: (_fn, _ms) => {
          scheduleCalls++
          return { stop: () => {} }
        },
        onLog: (e) => events.push(e),
        shouldRenew: () => false,
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await new Promise((r) => setTimeout(r, 30))

      expect(scheduleCalls).toBe(0)
      expect(attemptCalls).toBe(0)
      expect(events).toHaveLength(0)

      await manager.drain()
    })
  })

  test('drain() awaits in-flight renewal work so the daemon does not exit mid-attemptLogin', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      let attemptStarted = false
      let attemptFinished = false
      let releaseAttempt: (() => void) | null = null

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async (_email, _password, deviceUuid, deviceType) => {
          attemptStarted = true
          await new Promise<void>((r) => {
            releaseAttempt = r
          })
          attemptFinished = true
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
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      // Wait until the in-flight attemptLogin has parked.
      while (!attemptStarted) await new Promise((r) => setTimeout(r, 5))
      expect(attemptFinished).toBe(false)

      const drainPromise = manager.drain()
      // Drain must NOT settle while attemptLogin is parked.
      const racer = Promise.race([drainPromise, new Promise((r) => setTimeout(() => r('timeout'), 50))])
      expect(await racer).toBe('timeout')
      expect(attemptFinished).toBe(false)

      // Release the in-flight login; drain should now settle.
      releaseAttempt!()
      await drainPromise
      expect(attemptFinished).toBe(true)
    })
  })

  test('stop(containerName) awaits the in-flight tick for that container', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, ageDays: 6, withEncryptedPassword: true })
      let attemptStarted = false
      let releaseAttempt: (() => void) | null = null

      const manager = createKakaoRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        attemptLogin: async (_email, _password, deviceUuid, deviceType) => {
          attemptStarted = true
          await new Promise<void>((r) => {
            releaseAttempt = r
          })
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
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      while (!attemptStarted) await new Promise((r) => setTimeout(r, 5))

      const stopPromise = manager.stop(setup.containerName)
      const racer = Promise.race([stopPromise, new Promise((r) => setTimeout(() => r('timeout'), 50))])
      expect(await racer).toBe('timeout')

      releaseAttempt!()
      await stopPromise
    })
  })
})
