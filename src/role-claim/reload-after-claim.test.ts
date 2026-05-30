import { describe, expect, it } from 'bun:test'

import type { ReloadResult } from '@/reload'
import { reloadAfterClaim } from '@/role-claim/reload-after-claim'

describe('reloadAfterClaim', () => {
  it('reloads the config scope after a successful claim', async () => {
    const calls: Array<{ url: string; scope: string }> = []
    const results: ReloadResult[] = [{ scope: 'config', ok: true, summary: 'roles.match changed' }]

    const out = await reloadAfterClaim({
      url: 'ws://127.0.0.1:9999',
      reload: async (opts) => {
        calls.push(opts)
        return results
      },
    })

    expect(calls).toEqual([{ url: 'ws://127.0.0.1:9999', scope: 'config' }])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.results).toEqual(results)
  })

  it('treats a reload failure as non-fatal and surfaces the reason', async () => {
    const out = await reloadAfterClaim({
      url: 'ws://127.0.0.1:9999',
      reload: async () => {
        throw new Error('reload timed out after 30000ms')
      },
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('reload timed out after 30000ms')
  })

  it('stringifies non-Error throwables', async () => {
    const out = await reloadAfterClaim({
      url: 'ws://127.0.0.1:9999',
      reload: async () => {
        throw 'boom'
      },
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('boom')
  })
})
