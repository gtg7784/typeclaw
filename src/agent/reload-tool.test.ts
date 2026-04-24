import { describe, expect, test } from 'bun:test'

import { ReloadRegistry, type ReloadResult } from '@/reload'

import { createReloadTool } from './reload-tool'

function regWith(...results: ReloadResult[]): ReloadRegistry {
  const reg = new ReloadRegistry()
  for (const r of results) {
    reg.register({
      scope: r.scope,
      description: `${r.scope} reloadable`,
      reload: async () => r,
    })
  }
  return reg
}

async function execute(tool: ReturnType<typeof createReloadTool>) {
  return await tool.execute('test-call', {}, undefined, undefined, {} as never)
}

describe('createReloadTool', () => {
  test('exposes name "reload" and a description for the LLM', () => {
    const tool = createReloadTool({ registry: new ReloadRegistry() })
    expect(tool.name).toBe('reload')
    expect(tool.description.length).toBeGreaterThan(0)
  })

  test('returns a textual summary listing each scope and its outcome', async () => {
    const reg = regWith(
      { scope: 'cron', ok: true, summary: '2 jobs (added 1, removed 0, updated 1, unchanged 0)' },
      { scope: 'config', ok: true, summary: 'config reloaded' },
    )
    const tool = createReloadTool({ registry: reg })

    const result = await execute(tool)

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain('cron')
    expect(text).toContain('config')
    expect(text).toContain('ok')
  })

  test('marks per-scope failures with their reason in the output text', async () => {
    const reg = regWith(
      { scope: 'cron', ok: false, reason: 'job daily-summary: invalid schedule' },
      { scope: 'config', ok: true, summary: 'config reloaded' },
    )
    const tool = createReloadTool({ registry: reg })

    const result = await execute(tool)

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain('cron')
    expect(text).toContain('failed')
    expect(text).toContain('invalid schedule')
  })

  test('details include the structured ReloadAllResult', async () => {
    const reg = regWith({ scope: 'cron', ok: true, summary: 'ok' })
    const tool = createReloadTool({ registry: reg })

    const result = await execute(tool)

    const details = result.details as { results: { scope: string; ok: boolean }[] }
    expect(details.results).toHaveLength(1)
    expect(details.results[0]?.scope).toBe('cron')
  })

  test('handles an empty registry without throwing', async () => {
    const tool = createReloadTool({ registry: new ReloadRegistry() })

    const result = await execute(tool)

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toMatch(/nothing|no.*reloadable|empty/i)
  })
})
