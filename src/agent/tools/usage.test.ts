import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUsageTool } from './usage'

const ctx = {} as Parameters<ReturnType<typeof createUsageTool>['execute']>[4]

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-usage-tool-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

async function seedSession(sessionId: string, ts: number, input: number, output: number, cost: number): Promise<void> {
  const sessionsDir = join(agentDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const tsLabel = new Date(ts).toISOString().replace(/[:.]/g, '-')
  const file = join(sessionsDir, `${tsLabel}_${sessionId}.jsonl`)
  const line = {
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'fake',
      provider: 'fireworks',
      model: 'kimi-k2',
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      stopReason: 'stop',
      timestamp: ts,
    },
  }
  await writeFile(file, `${JSON.stringify(line)}\n`)
}

function fakeSession(input: number, output: number, cost: number) {
  return {
    sessionManager: {} as never,
    getSessionStats: () => ({
      sessionFile: '/agent/sessions/x.jsonl',
      sessionId: 'live-session-id',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
      cost,
    }),
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

describe('usage tool', () => {
  test("scope='current' reports the live session stats", async () => {
    const tool = createUsageTool({ agentDir, getSession: () => fakeSession(1234, 200, 0.04) })
    const result = await tool.execute('id', { scope: 'current' }, undefined, undefined, ctx)
    expect(textOf(result)).toMatch(/1\.2k in \/ 200 out/)
    expect(textOf(result)).toMatch(/\$0\.04/)
    expect((result.details as { scope: string }).scope).toBe('current')
  })

  test("scope='current' returns a friendly error when no live session is available", async () => {
    const tool = createUsageTool({ agentDir })
    const result = await tool.execute('id', { scope: 'current' }, undefined, undefined, ctx)
    expect(textOf(result)).toMatch(/No live session available/i)
  })

  test("scope='all_time' aggregates JSONL on disk", async () => {
    const t = Date.now() - 86_400_000
    await seedSession('aaaa1111', t, 1000, 200, 0.04)
    const tool = createUsageTool({ agentDir })
    const result = await tool.execute('id', { scope: 'all_time' }, undefined, undefined, ctx)
    expect(textOf(result)).toMatch(/All time/)
    expect(textOf(result)).toMatch(/1\.0k \/ 200/)
    expect(textOf(result)).toMatch(/fireworks\/kimi-k2/)
  })

  test("scope='all_time' on an empty agent reports zero", async () => {
    const tool = createUsageTool({ agentDir })
    const result = await tool.execute('id', { scope: 'all_time' }, undefined, undefined, ctx)
    expect(textOf(result)).toMatch(/No assistant turns/i)
  })

  test('default scope combines current + today + last_7d', async () => {
    const now = Date.now()
    await seedSession('today001', now - 60_000, 500, 100, 0.01)
    const tool = createUsageTool({ agentDir, getSession: () => fakeSession(800, 50, 0.02) })
    const result = await tool.execute('id', {}, undefined, undefined, ctx)
    const text = textOf(result)
    expect(text).toMatch(/This chat:/)
    expect(text).toMatch(/Today:/)
    expect(text).toMatch(/Last 7 days:/)
    const details = result.details as { current: unknown; today: unknown; last_7d: unknown }
    expect(details.current).not.toBeNull()
    expect(details.today).toBeDefined()
    expect(details.last_7d).toBeDefined()
  })

  test('details payload carries machine-readable totals and byModel breakdown', async () => {
    const t = Date.now() - 86_400_000
    await seedSession('bbbb2222', t, 1000, 200, 0.04)
    const tool = createUsageTool({ agentDir })
    const result = await tool.execute('id', { scope: 'all_time' }, undefined, undefined, ctx)
    const d = result.details as {
      total: { messageCount: number; cost: number }
      byModel: Array<{ provider: string; model: string; cost: number }>
    }
    expect(d.total.messageCount).toBe(1)
    expect(d.total.cost).toBeCloseTo(0.04, 5)
    expect(d.byModel).toHaveLength(1)
    expect(d.byModel[0]?.provider).toBe('fireworks')
  })
})
