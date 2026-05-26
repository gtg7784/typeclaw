import { describe, expect, test } from 'bun:test'

import { LiveSubagentRegistry, type LiveSubagent } from '../live-subagents'
import { createSubagentOutputTool } from './subagent-output'

const ctx = {} as Parameters<ReturnType<typeof createSubagentOutputTool>['execute']>[4]

function makeLive(overrides: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    taskId: 'bg_o1',
    sessionId: 'ses_s1',
    subagentName: 'explorer',
    parentSessionId: 'ses_parent',
    startedAt: 1_000,
    status: 'running',
    abort: async () => {},
    ...overrides,
  }
}

describe('createSubagentOutputTool — unknown task_id', () => {
  test('returns ok=false with helpful error', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_missing' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('Unknown task_id')
  })
})

describe('createSubagentOutputTool — running status', () => {
  test('returns status=running with status_summary and recent events', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive({ startedAt: 1_000 }))
    liveRegistry.recordEvent('bg_o1', { kind: 'tool', name: 'grep', ok: true, ts: 1_500 })
    liveRegistry.recordEvent('bg_o1', { kind: 'tool', name: 'read', ok: true, ts: 2_000 })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 3_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)

    const details = result.details as {
      ok: boolean
      status?: string
      eventsCount?: number
      statusSummary?: string
    }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('running')
    expect(details.eventsCount).toBe(3)
    expect(details.statusSummary).toMatch(/Running for 2s/)
    expect(details.statusSummary).toContain('Last: tool read')
    const firstContent = result.content[0]
    const text = firstContent?.type === 'text' ? firstContent.text : ''
    expect(text).toBe(details.statusSummary ?? '')
  })

  test('eventsRecent is bounded to 10 events', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    for (let i = 0; i < 25; i++) {
      liveRegistry.recordEvent('bg_o1', { kind: 'tool', name: `t${i}`, ok: true, ts: 1_500 + i })
    }
    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 3_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; eventsRecent?: { kind: string; name?: string }[] }
    expect(details.eventsRecent?.length).toBe(10)
  })
})

describe('createSubagentOutputTool — completed status', () => {
  test('returns final message when completion has one', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    liveRegistry.recordCompletion('bg_o1', {
      ok: true,
      finalMessage: 'Found 3 matches in src/api.',
      durationMs: 2_500,
    })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 4_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; status?: string; finalMessage?: string; durationMs?: number }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('completed')
    expect(details.finalMessage).toBe('Found 3 matches in src/api.')
    expect(details.durationMs).toBe(2_500)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toBe('Found 3 matches in src/api.')
  })

  test('synthesizes content text when completion has no final message', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    liveRegistry.recordCompletion('bg_o1', { ok: true, durationMs: 1_000 })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 2_000,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/explorer completed in/)
  })
})

describe('createSubagentOutputTool — failed status', () => {
  test('returns error envelope without setting ok=false (the QUERY succeeded; the SUBAGENT failed)', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    liveRegistry.recordCompletion('bg_o1', { ok: false, error: 'provider rate limit', durationMs: 500 })

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 1_500,
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; status?: string; error?: string }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('failed')
    expect(details.error).toBe('provider rate limit')
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('failed after')
    expect(text).toContain('provider rate limit')
  })
})

describe('createSubagentOutputTool — never blocks', () => {
  test('returns immediately even when the subagent is still running', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())

    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => undefined,
      now: () => 2_000,
    })

    const start = Date.now()
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
    const details = result.details as { ok: boolean; status?: string }
    expect(details.ok).toBe(true)
    expect(details.status).toBe('running')
  })
})

describe('createSubagentOutputTool — permissions', () => {
  test('denied when origin lacks subagent.output', async () => {
    const liveRegistry = new LiveSubagentRegistry()
    liveRegistry.register(makeLive())
    const tool = createSubagentOutputTool({
      liveRegistry,
      getOrigin: () => ({ kind: 'channel', adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null }),
      permissions: {
        has: () => false,
        resolveRole: () => 'guest',
        describe: () => ({ role: 'guest', permissions: [] }),
        replaceRoles: () => {},
      },
    })
    const result = await tool.execute('call_1', { task_id: 'bg_o1' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })
})
