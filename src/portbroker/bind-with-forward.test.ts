import { afterEach, describe, expect, test } from 'bun:test'

import { bindWithForward } from './bind-with-forward'
import { __resetForwardResultBus, publishForwardResult } from './forward-result-bus'

afterEach(() => {
  __resetForwardResultBus()
})

describe('bindWithForward', () => {
  test('returns first port whose factory succeeds AND broker confirms forward', async () => {
    const closed: number[] = []

    const promise = bindWithForward<string>({
      candidates: [4848, 4849, 4850],
      brokerEnabled: true,
      timeoutMs: 1_000,
      factory: (port) => {
        setTimeout(
          () =>
            publishForwardResult(
              port === 4848 ? { port, ok: false, reason: 'EADDRINUSE' } : { port, ok: true, hostPort: port },
            ),
          5,
        )
        return Promise.resolve({
          resource: `bound:${port}`,
          close: () => closed.push(port),
        })
      },
    })

    expect(await promise).toEqual({ port: 4849, hostPort: 4849, resource: 'bound:4849' })
    expect(closed).toEqual([4848])
  })

  test('returns null when every candidate fails to forward', async () => {
    const closed: number[] = []

    const result = await bindWithForward<string>({
      candidates: [4848, 4849],
      brokerEnabled: true,
      timeoutMs: 1_000,
      factory: (port) => {
        setTimeout(() => publishForwardResult({ port, ok: false, reason: 'EADDRINUSE' }), 5)
        return Promise.resolve({
          resource: `bound:${port}`,
          close: () => closed.push(port),
        })
      },
    })

    expect(result).toBeNull()
    expect(closed).toEqual([4848, 4849])
  })

  test('skips candidates whose factory returns null without consulting the broker', async () => {
    let factoryCalls = 0

    const result = await bindWithForward<string>({
      candidates: [4848, 4849],
      brokerEnabled: true,
      timeoutMs: 1_000,
      factory: (port) => {
        factoryCalls += 1
        if (port === 4848) return Promise.resolve(null)
        setTimeout(() => publishForwardResult({ port, ok: true, hostPort: port }), 5)
        return Promise.resolve({ resource: `bound:${port}`, close: () => {} })
      },
    })

    expect(result).toEqual({ port: 4849, hostPort: 4849, resource: 'bound:4849' })
    expect(factoryCalls).toBe(2)
  })

  test('treats a forward-result timeout as failure and moves on', async () => {
    const closed: number[] = []

    const result = await bindWithForward<string>({
      candidates: [4848, 4849],
      brokerEnabled: true,
      timeoutMs: 50,
      factory: (port) => {
        if (port === 4849) {
          setTimeout(() => publishForwardResult({ port, ok: true, hostPort: port }), 5)
        }
        return Promise.resolve({ resource: `bound:${port}`, close: () => closed.push(port) })
      },
    })

    expect(result).toEqual({ port: 4849, hostPort: 4849, resource: 'bound:4849' })
    expect(closed).toEqual([4848])
  })

  test('broker-disabled: returns first successful in-container bind without waiting', async () => {
    let waited = false
    const result = await bindWithForward<string>({
      candidates: [4848],
      brokerEnabled: false,
      timeoutMs: 5_000,
      factory: (port) => Promise.resolve({ resource: `bound:${port}`, close: () => {} }),
    })
    waited = true

    expect(result).toEqual({ port: 4848, hostPort: null, resource: 'bound:4848' })
    expect(waited).toBe(true)
  })

  test('ignores forward-result events for unrelated ports', async () => {
    const result = await bindWithForward<string>({
      candidates: [4848],
      brokerEnabled: true,
      timeoutMs: 1_000,
      factory: (port) => {
        setTimeout(() => {
          publishForwardResult({ port: 9999, ok: true, hostPort: 9999 })
          publishForwardResult({ port, ok: true, hostPort: port })
        }, 5)
        return Promise.resolve({ resource: `bound:${port}`, close: () => {} })
      },
    })

    expect(result).toEqual({ port: 4848, hostPort: 4848, resource: 'bound:4848' })
  })
})
