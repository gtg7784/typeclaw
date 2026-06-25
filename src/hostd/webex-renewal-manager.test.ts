import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encrypt } from '@/secrets/encryption'
import { createKeyStore } from '@/secrets/keys'
import type { WebexChannelBlock } from '@/secrets/schema'
import type { LoginWithPasswordFn } from '@/secrets/webex-renewal'
import { expectStable, waitFor } from '@/test-helpers/wait-for'

import { createWebexRenewalManager, type WebexRenewalLogEvent } from './webex-renewal-manager'

const HOUR_MS = 60 * 60 * 1000

async function setupAgent(opts: {
  agentDir: string
  expiresInHours: number
  withEncryptedPassword: boolean
}): Promise<{ containerName: string; cwd: string; keysDir: string }> {
  const containerName = 'webex'
  const keysDir = join(opts.agentDir, 'keys')
  const ks = createKeyStore({ keysDir })
  const key = await ks.ensure(containerName)
  const encryptedPassword = opts.withEncryptedPassword
    ? encrypt('hunter2', key, { containerName, accountId: 'u-1', purpose: 'webex-password' })
    : undefined
  const nowIso = new Date().toISOString()
  const block: WebexChannelBlock = {
    currentAccount: 'u-1',
    accounts: {
      'u-1': {
        account_id: 'u-1',
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: Date.now() + opts.expiresInHours * HOUR_MS,
        device_url: 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-1',
        user_id: 'u-1',
        created_at: nowIso,
        updated_at: nowIso,
        email: 'u@e.com',
        ...(encryptedPassword !== undefined ? { encryptedPassword } : {}),
      },
    },
  }
  const envelope = { version: 2, providers: {}, channels: { webex: block } }
  await writeFile(join(opts.agentDir, 'secrets.json'), JSON.stringify(envelope))
  return { containerName, cwd: opts.agentDir, keysDir }
}

async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return fn(await mkdtemp(join(tmpdir(), 'typeclaw-webex-renewal-mgr-')))
}

function freshLogin(): LoginWithPasswordFn {
  return async () => ({
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    expiresAt: Date.now() + 27 * HOUR_MS,
    deviceUrl: 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-1',
    userId: 'u-1',
  })
}

describe('createWebexRenewalManager', () => {
  test('runs the first tick immediately on start and renews an expiring token', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      const events: WebexRenewalLogEvent[] = []
      let loginCalls = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async (...args) => {
          loginCalls++
          return freshLogin()(...args)
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.drain()

      expect(loginCalls).toBe(1)
      expect(events.some((e) => e.kind === 'webex-renewal-tick-ok')).toBe(true)
    })
  })

  test('emits tick-skipped (fresh_enough) when the token is far from expiry', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 20, withEncryptedPassword: true })
      const events: WebexRenewalLogEvent[] = []

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          throw new Error('must not be called for a fresh account')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.drain()

      expect(events.some((e) => e.kind === 'webex-renewal-tick-skipped')).toBe(true)
    })
  })

  test('emits tick-reauth-required when the key file is missing', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      await writeFile(join(setup.keysDir, `${setup.containerName}.key`), Buffer.alloc(0))
      const events: WebexRenewalLogEvent[] = []

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          throw new Error('must not be called when key file is unusable')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.drain()

      expect(events.some((e) => e.kind === 'webex-renewal-tick-reauth-required')).toBe(true)
    })
  })

  test('stop() cancels the scheduled timer', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let scheduleStopCalled = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: freshLogin(),
        schedule: (_fn, _ms) => ({
          stop: () => {
            scheduleStopCalled++
          },
        }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await manager.stop(setup.containerName)

      expect(scheduleStopCalled).toBe(1)
      await manager.drain()
    })
  })

  test('start() called twice for the same container replaces the timer', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let scheduleStopCalled = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: freshLogin(),
        schedule: (_fn, _ms) => ({
          stop: () => {
            scheduleStopCalled++
          },
        }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => scheduleStopCalled >= 1)

      expect(scheduleStopCalled).toBe(1)
      await manager.drain()
    })
  })

  test('drain() stops all timers', async () => {
    await withAgentDir(async (dir) => {
      const a = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let scheduleStopCalled = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: a.keysDir }),
        loginWithPassword: freshLogin(),
        schedule: (_fn, _ms) => ({
          stop: () => {
            scheduleStopCalled++
          },
        }),
      })

      manager.start({ containerName: 'agent-a', cwd: a.cwd })
      manager.start({ containerName: 'agent-b', cwd: a.cwd })
      await manager.drain()

      expect(scheduleStopCalled).toBe(2)
    })
  })

  test('invokes onRenewalOk after a successful renewal, so the host can restart the container', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      const restartCalls: Array<{ containerName: string; cwd: string; accountId: string }> = []

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: freshLogin(),
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async (input) => {
          restartCalls.push(input)
        },
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => restartCalls.length > 0)
      await manager.drain()

      expect(restartCalls).toEqual([{ containerName: setup.containerName, cwd: setup.cwd, accountId: 'u-1' }])
    })
  })

  test('does NOT invoke onRenewalOk when the renewal skips', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 20, withEncryptedPassword: true })
      let restartCalls = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          throw new Error('loginWithPassword should not run for a fresh account')
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

  test('logs webex-renewal-restart-failed when onRenewalOk throws', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      const events: WebexRenewalLogEvent[] = []

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: freshLogin(),
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async () => {
          throw new Error('docker stop refused')
        },
        onLog: (e) => events.push(e),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => events.some((e) => e.kind === 'webex-renewal-restart-failed'))
      await manager.drain()

      expect(events.some((e) => e.kind === 'webex-renewal-tick-ok')).toBe(true)
      expect(events.some((e) => e.kind === 'webex-renewal-restart-failed')).toBe(true)
    })
  })

  test('shouldRenew=false suppresses the cron entirely (no tick, no timer, no log spam)', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      const events: WebexRenewalLogEvent[] = []
      let scheduleCalls = 0
      let loginCalls = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          loginCalls++
          throw new Error('loginWithPassword should not run for a non-webex agent')
        },
        schedule: (_fn, _ms) => {
          scheduleCalls++
          return { stop: () => {} }
        },
        onLog: (e) => events.push(e),
        shouldRenew: () => false,
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await expectStable(() => loginCalls > 0 || scheduleCalls > 0 || events.length > 0, {
        durationMs: 25,
        description: 'suppressed cron activity',
      })

      expect(scheduleCalls).toBe(0)
      expect(loginCalls).toBe(0)
      expect(events).toHaveLength(0)

      await manager.drain()
    })
  })

  test('drain() awaits in-flight renewal work so the daemon does not exit mid-login', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let loginStarted = false
      let loginFinished = false
      let releaseLogin: (() => void) | null = null

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          loginStarted = true
          await new Promise<void>((r) => {
            releaseLogin = r
          })
          loginFinished = true
          return freshLogin()('u@e.com', 'hunter2')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => loginStarted)
      expect(loginFinished).toBe(false)

      const drainPromise = manager.drain()
      const racer = Promise.race([drainPromise, new Promise((r) => setTimeout(() => r('timeout'), 50))])
      expect(await racer).toBe('timeout')
      expect(loginFinished).toBe(false)

      releaseLogin!()
      await drainPromise
      expect(loginFinished).toBe(true)
    })
  })

  test('does NOT invoke onRenewalOk when stop() removed the container during an in-flight renewal', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let loginStarted = false
      let releaseLogin: (() => void) | null = null
      const restartCalls: string[] = []

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          loginStarted = true
          await new Promise<void>((r) => {
            releaseLogin = r
          })
          return freshLogin()('u@e.com', 'hunter2')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async ({ containerName }) => {
          restartCalls.push(containerName)
        },
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => loginStarted)

      const stopPromise = manager.stop(setup.containerName)
      releaseLogin!()
      await stopPromise

      expect(restartCalls).toEqual([])
    })
  })

  test('does NOT restart the old cwd when the container re-registers with a new cwd mid-tick', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let loginStarted = false
      let releaseLogin: (() => void) | null = null
      const restartCwds: string[] = []

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          loginStarted = true
          await new Promise<void>((r) => {
            releaseLogin = r
          })
          return freshLogin()('u@e.com', 'hunter2')
        },
        schedule: (_fn, _ms) => ({ stop: () => {} }),
        onRenewalOk: async ({ cwd }) => {
          restartCwds.push(cwd)
        },
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => loginStarted)

      // Re-register the same container with a different cwd while the first
      // tick is parked in login.
      manager.start({ containerName: setup.containerName, cwd: '/agent/relocated' })
      releaseLogin!()
      await manager.drain()

      expect(restartCwds).not.toContain(setup.cwd)
    })
  })

  test('re-registering to a shouldRenew=false cwd clears the old timer and does not restart the old cwd', async () => {
    await withAgentDir(async (dir) => {
      const setup = await setupAgent({ agentDir: dir, expiresInHours: 1, withEncryptedPassword: true })
      let loginStarted = false
      let releaseLogin: (() => void) | null = null
      const restartCwds: string[] = []
      const scheduleStops = new Map<number, number>()
      let scheduleSeq = 0

      const manager = createWebexRenewalManager({
        keyStoreFactory: () => createKeyStore({ keysDir: setup.keysDir }),
        loginWithPassword: async () => {
          loginStarted = true
          await new Promise<void>((r) => {
            releaseLogin = r
          })
          return freshLogin()('u@e.com', 'hunter2')
        },
        schedule: (_fn, _ms) => {
          const id = scheduleSeq++
          scheduleStops.set(id, 0)
          return {
            stop: () => {
              scheduleStops.set(id, (scheduleStops.get(id) ?? 0) + 1)
            },
          }
        },
        onRenewalOk: async ({ cwd }) => {
          restartCwds.push(cwd)
        },
        shouldRenew: ({ cwd }) => cwd === setup.cwd,
      })

      manager.start({ containerName: setup.containerName, cwd: setup.cwd })
      await waitFor(() => loginStarted)

      manager.start({ containerName: setup.containerName, cwd: '/agent/no-webex' })
      releaseLogin!()
      await manager.drain()

      expect(restartCwds).not.toContain(setup.cwd)
      // The first registration's timer was stopped by the ineligible re-register.
      expect(scheduleStops.get(0)).toBe(1)
      // No second timer was scheduled for the ineligible cwd.
      expect(scheduleSeq).toBe(1)
    })
  })
})
