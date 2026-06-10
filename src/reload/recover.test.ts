import { describe, expect, test } from 'bun:test'

import { ReloadConnectionError } from './client'
import { requestReloadWithFallback } from './recover'
import type { ReloadResult } from './types'

describe('requestReloadWithFallback', () => {
  test('returns host results when the host websocket succeeds', async () => {
    const expected: ReloadResult[] = [{ scope: 'config', ok: true, summary: 'host' }]

    const result = await requestReloadWithFallback({
      url: 'ws://127.0.0.1:8973',
      reload: async () => expected,
      reloadViaDockerExec: async () => [{ scope: 'config', ok: true, summary: 'fallback' }],
    })

    expect(result).toEqual({ transport: 'host', results: expected })
  })

  test('falls back through docker exec for auto-discovered connection failures', async () => {
    const expected: ReloadResult[] = [{ scope: 'config', ok: true, summary: 'container' }]
    const calls: Array<{ cwd: string; token: string | null; timeoutMs: number | undefined }> = []

    const result = await requestReloadWithFallback({
      url: 'ws://127.0.0.1:8973?token=sample-value',
      cwd: 'dobby',
      token: 'sample-value',
      timeoutMs: 5000,
      reload: async () => {
        throw new ReloadConnectionError('connection ended')
      },
      reloadViaDockerExec: async ({ cwd, token, timeoutMs }) => {
        calls.push({ cwd, token, timeoutMs })
        return expected
      },
    })

    expect(result).toEqual({ transport: 'container-local', results: expected, hostError: 'connection ended' })
    expect(calls).toEqual([{ cwd: 'dobby', token: 'sample-value', timeoutMs: 5000 }])
  })

  test('does not fall back for explicit urls without auto-discovered container context', async () => {
    await expect(
      requestReloadWithFallback({
        url: 'ws://example.invalid',
        reload: async () => {
          throw new ReloadConnectionError('connection ended')
        },
      }),
    ).rejects.toThrow('connection ended')
  })

  test('does not fall back after non-connection host errors', async () => {
    await expect(
      requestReloadWithFallback({
        url: 'ws://127.0.0.1:8973',
        cwd: 'dobby',
        token: null,
        reload: async () => {
          throw new Error('timed out waiting for reload_result')
        },
        reloadViaDockerExec: async () => [],
      }),
    ).rejects.toThrow('timed out waiting for reload_result')
  })
})
