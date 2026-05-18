import { describe, expect, test } from 'bun:test'

import { fetchCronList } from './bridge'

describe('cron list bridge', () => {
  test('redacts tokenized URLs in connection errors', async () => {
    const result = await fetchCronList({
      cwd: process.cwd(),
      url: 'ws://localhost:1?token=secret-token',
      timeoutMs: 200,
    })

    expect(result.kind).toBe('unreachable')
    if (result.kind !== 'unreachable') throw new Error('expected unreachable result')
    expect(result.reason).toContain('token=%3Credacted%3E')
    expect(result.reason).not.toContain('secret-token')
  })

  test('returns unreachable when the host is not listening', async () => {
    const result = await fetchCronList({
      cwd: process.cwd(),
      url: 'ws://127.0.0.1:1',
      timeoutMs: 500,
    })
    expect(result.kind).toBe('unreachable')
  })
})
