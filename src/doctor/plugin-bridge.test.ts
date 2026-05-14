import { describe, expect, test } from 'bun:test'

import { fetchPluginDoctorChecks } from './plugin-bridge'

describe('plugin doctor bridge', () => {
  test('redacts tokenized URLs in connection errors', async () => {
    const result = await fetchPluginDoctorChecks({
      cwd: process.cwd(),
      url: 'ws://localhost:1?token=secret-token',
      timeoutMs: 200,
    })

    expect(result.kind).toBe('unreachable')
    if (result.kind !== 'unreachable') throw new Error('expected unreachable result')
    expect(result.reason).toContain('token=%3Credacted%3E')
    expect(result.reason).not.toContain('secret-token')
  })
})
