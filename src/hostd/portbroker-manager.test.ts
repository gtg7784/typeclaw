import { describe, expect, test } from 'bun:test'

import type { Broker, BrokerOptions, PortForwardEvent } from '@/portbroker'

import { createPortbrokerManager } from './portbroker-manager'
import type { TailscaleExec, TailscaleServeEvent } from './tailscale'

function fakeTailscaleExec(calls: string[][]): TailscaleExec {
  return async (args) => {
    calls.push(args)
    if (args[0] === 'status') return { exitCode: 0, stdout: '{"BackendState":"Running"}', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function requireCapturedOptions(value: BrokerOptions | null): BrokerOptions {
  if (value === null) throw new Error('broker options were not captured')
  return value
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('createPortbrokerManager Tailscale Serve', () => {
  test('serves opened forwarded ports and turns them off on broker stop', async () => {
    const calls: string[][] = []
    const forwarded: PortForwardEvent[] = []
    const tailscale: TailscaleServeEvent[] = []
    let captured: BrokerOptions | null = null
    let stopped = 0
    const manager = createPortbrokerManager({
      resolveHostPortFor: async () => 12345,
      tailscaleExec: fakeTailscaleExec(calls),
      createBrokerFor: (opts): Broker => {
        captured = opts
        return {
          start: () => {},
          stop: async () => {
            stopped += 1
          },
          forwardedPorts: () => [],
        }
      },
    })

    await manager.start({
      containerName: 'coder',
      cwd: '/agent/coder',
      policy: { allow: '*' },
      wsHostPort: 12345,
      brokerToken: 'tok',
      onEvent: (event) => forwarded.push(event),
      onTailscaleServeEvent: (event) => tailscale.push(event),
    })

    requireCapturedOptions(captured).onEvent({
      kind: 'port-forward-opened',
      containerName: 'coder',
      port: 5173,
      bindAddr: '127.0.0.1',
    })
    await settle()

    await manager.stop('coder', 'deregistered')
    expect(stopped).toBe(1)
    expect(forwarded).toEqual([
      { kind: 'port-forward-opened', containerName: 'coder', port: 5173, bindAddr: '127.0.0.1' },
    ])
    expect(calls).toEqual([
      ['status', '--json'],
      ['serve', '--bg', '--tcp=5173', '5173'],
      ['serve', '--tcp=5173', 'off'],
    ])
    expect(tailscale).toEqual([
      { kind: 'tailscale-serve-opened', containerName: 'coder', port: 5173 },
      { kind: 'tailscale-serve-closed', containerName: 'coder', port: 5173 },
    ])
  })

  test('off-switch policy never opens a broker connection or serves tailscale ports', async () => {
    const calls: string[][] = []
    let startCalls = 0
    const manager = createPortbrokerManager({
      tailscaleExec: fakeTailscaleExec(calls),
      createBrokerFor: (): Broker => {
        return {
          start: () => {
            startCalls += 1
          },
          stop: async () => {},
          forwardedPorts: () => [],
        }
      },
    })

    await manager.start({
      containerName: 'coder',
      cwd: '/agent/coder',
      policy: { allow: [] },
      wsHostPort: 12345,
      brokerToken: 'tok',
      onEvent: () => {},
      onTailscaleServeEvent: () => {},
    })

    await manager.stop('coder', 'deregistered')

    expect(startCalls).toBe(1)
    expect(calls).toEqual([])
  })
})

describe('createPortbrokerManager re-register swap', () => {
  // Why this matters: hostd respawn after ungraceful daemon death restores
  // the leftover registration file (with the OLD broker token T1) and starts
  // a T1 broker. The container that the file referred to is already gone;
  // `typeclaw restart` then registers a NEW broker with T2 for the same
  // container name. If the T1 broker's stop() were fire-and-forget, T1's
  // connect loop could win the race and send broker-hello:T1 to the brand-new
  // container whose env carries T2, producing a one-shot
  // `auth-failed: token mismatch` broadcast.
  test('start awaits the existing broker stop before creating the replacement', async () => {
    const events: string[] = []
    let releaseOldStop: () => void = () => {}
    const oldStopHeld = new Promise<void>((resolve) => {
      releaseOldStop = resolve
    })
    let nthBroker = 0
    const manager = createPortbrokerManager({
      resolveHostPortFor: async () => 12345,
      createBrokerFor: (): Broker => {
        nthBroker += 1
        const which = nthBroker
        return {
          start: () => events.push(`broker${which}:start`),
          stop: async () => {
            if (which === 1) {
              events.push(`broker${which}:stop:awaiting`)
              await oldStopHeld
              events.push(`broker${which}:stop:done`)
            } else {
              events.push(`broker${which}:stop`)
            }
          },
          forwardedPorts: () => [],
        }
      },
    })

    await manager.start({
      containerName: 'coder',
      cwd: '/agent/coder',
      policy: { allow: '*' },
      wsHostPort: 12345,
      brokerToken: 'T1',
      onEvent: () => {},
      onTailscaleServeEvent: () => {},
    })

    const secondStart = manager.start({
      containerName: 'coder',
      cwd: '/agent/coder',
      policy: { allow: '*' },
      wsHostPort: 12345,
      brokerToken: 'T2',
      onEvent: () => {},
      onTailscaleServeEvent: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events).toEqual(['broker1:start', 'broker1:stop:awaiting'])

    releaseOldStop()
    await secondStart

    expect(events).toEqual(['broker1:start', 'broker1:stop:awaiting', 'broker1:stop:done', 'broker2:start'])

    await manager.stop('coder', 'deregistered')
  })
})
