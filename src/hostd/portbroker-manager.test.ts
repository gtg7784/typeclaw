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

    manager.start({
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

    manager.start({
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
