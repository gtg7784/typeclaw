import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { composeUsage } from './usage'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-usage-'))
})

afterEach(async () => {
  await rmTempDir(root)
})

async function makeAgent(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), '{}\n')
  return dir
}

async function writeSession(agentDir: string, sessionId: string, lines: object[]): Promise<void> {
  const sessionsDir = join(agentDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const ts = new Date('2026-05-10T00:00:00Z').toISOString().replace(/[:.]/g, '-')
  await writeFile(join(sessionsDir, `${ts}_${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
}

function assistantEntry(opts: {
  ts: number
  provider: string
  model: string
  input: number
  output: number
  cost: number
}): object {
  return {
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: new Date(opts.ts).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      api: 'fake',
      provider: opts.provider,
      model: opts.model,
      usage: {
        input: opts.input,
        output: opts.output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: opts.input + opts.output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost },
      },
      stopReason: 'stop',
      timestamp: opts.ts,
    },
  }
}

describe('composeUsage', () => {
  test('returns empty result when no agents are present', async () => {
    const result = await composeUsage({ rootCwd: root })
    expect(result.agents).toEqual([])
    expect(result.results).toEqual([])
  })

  test('returns one report per discovered agent', async () => {
    await makeAgent('coder')
    await makeAgent('planner')
    const result = await composeUsage({ rootCwd: root })
    expect(result.agents.map((a) => a.name)).toEqual(['coder', 'planner'])
    expect(result.results.map((r) => r.name)).toEqual(['coder', 'planner'])
    expect(result.results.every((r) => r.ok)).toBe(true)
  })

  test('captures usage per agent from session JSONLs', async () => {
    const coder = await makeAgent('coder')
    const planner = await makeAgent('planner')
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSession(coder, 'aaaa1111', [
      assistantEntry({ ts, provider: 'fireworks', model: 'kimi-k2', input: 1000, output: 200, cost: 0.04 }),
    ])
    await writeSession(planner, 'bbbb2222', [
      assistantEntry({ ts, provider: 'anthropic', model: 'claude', input: 500, output: 100, cost: 0.02 }),
    ])

    const result = await composeUsage({ rootCwd: root })
    const coderResult = result.results.find((r) => r.name === 'coder')
    const plannerResult = result.results.find((r) => r.name === 'planner')

    expect(coderResult?.ok).toBe(true)
    expect(plannerResult?.ok).toBe(true)
    if (coderResult?.ok) {
      expect(coderResult.data.aggregation.total.cost).toBeCloseTo(0.04, 5)
      expect(coderResult.data.aggregation.total.messageCount).toBe(1)
    }
    if (plannerResult?.ok) {
      expect(plannerResult.data.aggregation.total.cost).toBeCloseTo(0.02, 5)
    }
  })

  test('emits agent-start and agent-done progress events in order', async () => {
    await makeAgent('coder')
    await makeAgent('planner')
    const events: Array<{ kind: string; name: string }> = []
    await composeUsage({
      rootCwd: root,
      onProgress: (e) => events.push({ kind: e.kind, name: e.name }),
    })
    expect(
      events
        .filter((e) => e.kind === 'agent-start')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['coder', 'planner'])
    expect(
      events
        .filter((e) => e.kind === 'agent-done')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['coder', 'planner'])
    for (const name of ['coder', 'planner']) {
      const start = events.findIndex((e) => e.kind === 'agent-start' && e.name === name)
      const done = events.findIndex((e) => e.kind === 'agent-done' && e.name === name)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(done).toBeGreaterThan(start)
    }
  })

  test('preserves the range in the result for downstream consumers', async () => {
    await makeAgent('coder')
    const since = new Date('2026-05-01').getTime()
    const until = new Date('2026-05-20').getTime()
    const result = await composeUsage({ rootCwd: root, since, until })
    expect(result.range).toEqual({ since, until })
  })

  test('applies since/until to each per-agent runUsage call', async () => {
    const coder = await makeAgent('coder')
    const tEarly = new Date('2026-05-01T00:00:00').getTime()
    const tLate = new Date('2026-05-20T00:00:00').getTime()
    await writeSession(coder, 'range001', [
      assistantEntry({ ts: tEarly, provider: 'p', model: 'x', input: 100, output: 10, cost: 0.01 }),
      assistantEntry({ ts: tLate, provider: 'p', model: 'x', input: 200, output: 20, cost: 0.02 }),
    ])
    const result = await composeUsage({
      rootCwd: root,
      since: new Date('2026-05-15').getTime(),
    })
    const coderResult = result.results.find((r) => r.name === 'coder')
    expect(coderResult?.ok).toBe(true)
    if (coderResult?.ok) {
      expect(coderResult.data.aggregation.total.messageCount).toBe(1)
      expect(coderResult.data.aggregation.total.input).toBe(200)
    }
  })

  test('returns null range fields when since/until are omitted', async () => {
    await makeAgent('coder')
    const result = await composeUsage({ rootCwd: root })
    expect(result.range).toEqual({ since: null, until: null })
  })

  test('discovers agents in deterministic alphabetical order', async () => {
    await makeAgent('zebra')
    await makeAgent('alpha')
    await makeAgent('mango')
    const result = await composeUsage({ rootCwd: root })
    expect(result.results.map((r) => r.name)).toEqual(['alpha', 'mango', 'zebra'])
  })
})
