import { describe, expect, test } from 'bun:test'

import type { renewCurrentAccount } from '@/secrets/teams-renewal'
import { expectStable, waitFor } from '@/test-helpers/wait-for'

import { createTeamsRenewalManager, type TeamsRenewalLogEvent } from './teams-renewal-manager'

type RenewFn = typeof renewCurrentAccount
type RenewResult = Awaited<ReturnType<RenewFn>>

function renewReturning(result: RenewResult): RenewFn {
  return (async () => result) as RenewFn
}

const OK: RenewResult = { kind: 'ok', account_id: 'acc-1', previousExpiresAt: 1, nextExpiresAt: 2 }
const SKIPPED: RenewResult = { kind: 'skipped', reason: 'fresh_enough', expiresInMs: 999 }
const REAUTH: RenewResult = { kind: 'reauth_required', account_id: 'acc-1', reason: 'no_refresh_token', message: 'x' }
const TRANSIENT: RenewResult = { kind: 'transient_failure', account_id: 'acc-1', reason: 'silent_refresh_failed' }

describe('createTeamsRenewalManager', () => {
  test('runs the first tick immediately and emits tick-ok on a successful renewal', async () => {
    const events: TeamsRenewalLogEvent[] = []
    const manager = createTeamsRenewalManager({
      renew: renewReturning(OK),
      schedule: () => ({ stop: () => {} }),
      onLog: (e) => events.push(e),
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await manager.drain()

    expect(events.some((e) => e.kind === 'teams-renewal-tick-ok')).toBe(true)
  })

  test('emits tick-skipped when the token is fresh', async () => {
    const events: TeamsRenewalLogEvent[] = []
    const manager = createTeamsRenewalManager({
      renew: renewReturning(SKIPPED),
      schedule: () => ({ stop: () => {} }),
      onLog: (e) => events.push(e),
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await manager.drain()

    expect(events.some((e) => e.kind === 'teams-renewal-tick-skipped')).toBe(true)
  })

  test('emits tick-reauth-required when the account has no refresh token', async () => {
    const events: TeamsRenewalLogEvent[] = []
    const manager = createTeamsRenewalManager({
      renew: renewReturning(REAUTH),
      schedule: () => ({ stop: () => {} }),
      onLog: (e) => events.push(e),
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await manager.drain()

    expect(events.some((e) => e.kind === 'teams-renewal-tick-reauth-required')).toBe(true)
  })

  test('emits tick-transient-failure and does NOT restart on a transient failure', async () => {
    const events: TeamsRenewalLogEvent[] = []
    let restarts = 0
    const manager = createTeamsRenewalManager({
      renew: renewReturning(TRANSIENT),
      schedule: () => ({ stop: () => {} }),
      onLog: (e) => events.push(e),
      onRenewalOk: async () => {
        restarts++
      },
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await manager.drain()

    expect(events.some((e) => e.kind === 'teams-renewal-tick-transient-failure')).toBe(true)
    expect(restarts).toBe(0)
  })

  test('invokes onRenewalOk after a successful renewal so the host can restart the container', async () => {
    const restarts: Array<{ containerName: string; cwd: string; accountId: string }> = []
    const manager = createTeamsRenewalManager({
      renew: renewReturning(OK),
      schedule: () => ({ stop: () => {} }),
      onRenewalOk: async (input) => {
        restarts.push(input)
      },
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await waitFor(() => restarts.length > 0)
    await manager.drain()

    expect(restarts).toEqual([{ containerName: 'teams', cwd: '/agent', accountId: 'acc-1' }])
  })

  test('does NOT invoke onRenewalOk when the renewal skips', async () => {
    let restarts = 0
    const manager = createTeamsRenewalManager({
      renew: renewReturning(SKIPPED),
      schedule: () => ({ stop: () => {} }),
      onRenewalOk: async () => {
        restarts++
      },
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await manager.drain()

    expect(restarts).toBe(0)
  })

  test('logs teams-renewal-restart-failed when onRenewalOk throws', async () => {
    const events: TeamsRenewalLogEvent[] = []
    const manager = createTeamsRenewalManager({
      renew: renewReturning(OK),
      schedule: () => ({ stop: () => {} }),
      onRenewalOk: async () => {
        throw new Error('docker stop refused')
      },
      onLog: (e) => events.push(e),
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await waitFor(() => events.some((e) => e.kind === 'teams-renewal-restart-failed'))
    await manager.drain()

    expect(events.some((e) => e.kind === 'teams-renewal-tick-ok')).toBe(true)
    expect(events.some((e) => e.kind === 'teams-renewal-restart-failed')).toBe(true)
  })

  test('shouldRenew=false suppresses the cron entirely (no tick, no timer, no log spam)', async () => {
    const events: TeamsRenewalLogEvent[] = []
    let scheduleCalls = 0
    let renewCalls = 0
    const manager = createTeamsRenewalManager({
      renew: (async () => {
        renewCalls++
        return OK
      }) as RenewFn,
      schedule: () => {
        scheduleCalls++
        return { stop: () => {} }
      },
      onLog: (e) => events.push(e),
      shouldRenew: () => false,
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await expectStable(() => renewCalls > 0 || scheduleCalls > 0 || events.length > 0, {
      durationMs: 25,
      description: 'suppressed cron activity',
    })

    expect(scheduleCalls).toBe(0)
    expect(renewCalls).toBe(0)
    expect(events).toHaveLength(0)

    await manager.drain()
  })

  test('stop() cancels the scheduled timer', async () => {
    let scheduleStopCalled = 0
    const manager = createTeamsRenewalManager({
      renew: renewReturning(OK),
      schedule: () => ({
        stop: () => {
          scheduleStopCalled++
        },
      }),
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await manager.stop('teams')

    expect(scheduleStopCalled).toBe(1)
    await manager.drain()
  })

  test('drain() awaits in-flight renewal work so the daemon does not exit mid-refresh', async () => {
    let renewStarted = false
    let renewFinished = false
    let release: (() => void) | null = null
    const manager = createTeamsRenewalManager({
      renew: (async () => {
        renewStarted = true
        await new Promise<void>((r) => {
          release = r
        })
        renewFinished = true
        return OK
      }) as RenewFn,
      schedule: () => ({ stop: () => {} }),
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await waitFor(() => renewStarted)
    expect(renewFinished).toBe(false)

    const drainPromise = manager.drain()
    const racer = Promise.race([drainPromise, new Promise((r) => setTimeout(() => r('timeout'), 50))])
    expect(await racer).toBe('timeout')

    release!()
    await drainPromise
    expect(renewFinished).toBe(true)
  })

  test('does NOT restart the old cwd when the container re-registers with a new cwd mid-tick', async () => {
    let firstRenewStarted = false
    let release: (() => void) | null = null
    let renewCalls = 0
    const restartCwds: string[] = []
    const manager = createTeamsRenewalManager({
      renew: (async () => {
        // Only the first tick parks; the re-run after re-register resolves
        // immediately so the pending-rerun loop can finish.
        if (renewCalls++ === 0) {
          firstRenewStarted = true
          await new Promise<void>((r) => {
            release = r
          })
        }
        return OK
      }) as RenewFn,
      schedule: () => ({ stop: () => {} }),
      onRenewalOk: async ({ cwd }) => {
        restartCwds.push(cwd)
      },
    })

    manager.start({ containerName: 'teams', cwd: '/agent' })
    await waitFor(() => firstRenewStarted)

    manager.start({ containerName: 'teams', cwd: '/agent/relocated' })
    release!()
    await manager.drain()

    expect(restartCwds).not.toContain('/agent')
  })
})
