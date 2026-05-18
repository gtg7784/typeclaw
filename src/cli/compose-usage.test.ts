import { describe, expect, test } from 'bun:test'

import type { ComposeUsageResult } from '@/compose'
import type { UsageReport, UsageTotals } from '@/usage'

import { formatComposeUsage, formatComposeUsageJson } from './compose-usage'

function emptyTotals(): UsageTotals {
  return { messageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }
}

function report(opts: {
  agentDir: string
  totals?: Partial<UsageTotals>
  sessions?: number
  warnings?: string[]
}): UsageReport {
  const total: UsageTotals = { ...emptyTotals(), ...opts.totals }
  const bySession = Array.from({ length: opts.sessions ?? 0 }, (_, i) => ({
    ...emptyTotals(),
    sessionId: `s${i}`,
    sessionFile: `/fake/${i}.jsonl`,
    firstAt: 0,
    lastAt: 0,
    models: [],
    originKind: 'unknown' as const,
  }))
  return {
    generatedAt: 0,
    agentDir: opts.agentDir,
    range: { since: null, until: null },
    timezone: 'UTC',
    aggregation: { total, byDay: [], byModel: [], bySession, byOrigin: [] },
    warnings: opts.warnings ?? [],
  }
}

function result(overrides: Partial<ComposeUsageResult> = {}): ComposeUsageResult {
  return {
    rootCwd: '/agents',
    range: { since: null, until: null },
    agents: [],
    results: [],
    ...overrides,
  }
}

describe('formatComposeUsage', () => {
  test('empty fleet renders a dim "no agents" line including the cwd', () => {
    const out = formatComposeUsage(result({ rootCwd: '/somewhere' }))
    expect(out).toContain('No typeclaw agents in /somewhere.')
  })

  test('renders header with USAGE and the rootCwd', () => {
    const out = formatComposeUsage(
      result({
        rootCwd: '/agents',
        agents: [{ name: 'coder', cwd: '/agents/coder', containerName: 'coder' }],
        results: [{ name: 'coder', ok: true, data: report({ agentDir: '/agents/coder' }) }],
      }),
    )
    expect(out).toMatch(/USAGE/)
    expect(out).toContain('/agents')
  })

  test('renders one row per agent with per-agent totals', () => {
    const out = formatComposeUsage(
      result({
        agents: [
          { name: 'coder', cwd: '/agents/coder', containerName: 'coder' },
          { name: 'planner', cwd: '/agents/planner', containerName: 'planner' },
        ],
        results: [
          {
            name: 'coder',
            ok: true,
            data: report({
              agentDir: '/agents/coder',
              totals: { messageCount: 5, input: 1000, output: 200, cost: 0.04 },
              sessions: 2,
            }),
          },
          {
            name: 'planner',
            ok: true,
            data: report({
              agentDir: '/agents/planner',
              totals: { messageCount: 3, input: 500, output: 100, cost: 0.02 },
              sessions: 1,
            }),
          },
        ],
      }),
    )
    expect(out).toContain('coder')
    expect(out).toContain('planner')
    expect(out).toMatch(/\$0\.04/)
    expect(out).toMatch(/\$0\.02/)
  })

  test('shows a Total footer summing all ok agents', () => {
    const out = formatComposeUsage(
      result({
        agents: [
          { name: 'a', cwd: '/agents/a', containerName: 'a' },
          { name: 'b', cwd: '/agents/b', containerName: 'b' },
        ],
        results: [
          {
            name: 'a',
            ok: true,
            data: report({ agentDir: '/a', totals: { messageCount: 5, input: 1000, cost: 0.04 } }),
          },
          {
            name: 'b',
            ok: true,
            data: report({ agentDir: '/b', totals: { messageCount: 3, input: 500, cost: 0.02 } }),
          },
        ],
      }),
    )
    expect(out).toContain('Total')
    expect(out).toMatch(/\$0\.06/)
  })

  test('failed agents render an error row but do not break the table', () => {
    const out = formatComposeUsage(
      result({
        agents: [
          { name: 'good', cwd: '/agents/good', containerName: 'good' },
          { name: 'bad', cwd: '/agents/bad', containerName: 'bad' },
        ],
        results: [
          {
            name: 'good',
            ok: true,
            data: report({ agentDir: '/agents/good', totals: { messageCount: 1, cost: 0.01 } }),
          },
          { name: 'bad', ok: false, reason: 'sessions directory unreadable' },
        ],
      }),
    )
    expect(out).toContain('good')
    expect(out).toContain('bad')
    expect(out).toContain('error: sessions directory unreadable')
  })

  test('failed agents do not contribute to the Total footer', () => {
    const out = formatComposeUsage(
      result({
        agents: [
          { name: 'good', cwd: '/agents/good', containerName: 'good' },
          { name: 'bad', cwd: '/agents/bad', containerName: 'bad' },
        ],
        results: [
          {
            name: 'good',
            ok: true,
            data: report({ agentDir: '/agents/good', totals: { messageCount: 1, cost: 0.05 } }),
          },
          { name: 'bad', ok: false, reason: 'boom' },
        ],
      }),
    )
    expect(out).toMatch(/Total[^\n]*\$0\.05/)
  })

  test('range header reads "all time" when neither bound is set', () => {
    const out = formatComposeUsage(
      result({
        agents: [{ name: 'a', cwd: '/agents/a', containerName: 'a' }],
        results: [{ name: 'a', ok: true, data: report({ agentDir: '/agents/a' }) }],
      }),
    )
    expect(out).toMatch(/Range: all time/)
  })

  test('range header shows ISO bounds when set', () => {
    const since = new Date('2026-05-01T00:00:00Z').getTime()
    const until = new Date('2026-05-15T00:00:00Z').getTime()
    const out = formatComposeUsage(
      result({
        range: { since, until },
        agents: [{ name: 'a', cwd: '/agents/a', containerName: 'a' }],
        results: [{ name: 'a', ok: true, data: report({ agentDir: '/agents/a' }) }],
      }),
    )
    expect(out).toContain('2026-05-01')
    expect(out).toContain('2026-05-15')
  })

  test('per-agent warnings are prefixed with the agent name', () => {
    const out = formatComposeUsage(
      result({
        agents: [{ name: 'coder', cwd: '/agents/coder', containerName: 'coder' }],
        results: [
          {
            name: 'coder',
            ok: true,
            data: report({ agentDir: '/agents/coder', warnings: ['malformed json on line 3'] }),
          },
        ],
      }),
    )
    expect(out).toContain('[coder] malformed json on line 3')
  })

  test('shows Cache % column header in the table', () => {
    const out = formatComposeUsage(
      result({
        agents: [{ name: 'a', cwd: '/agents/a', containerName: 'a' }],
        results: [{ name: 'a', ok: true, data: report({ agentDir: '/agents/a' }) }],
      }),
    )
    expect(out).toMatch(/Cache %/)
  })

  test('emits ANSI color escapes under useColor=true', () => {
    const out = formatComposeUsage(
      result({
        agents: [{ name: 'coder', cwd: '/agents/coder', containerName: 'coder' }],
        results: [
          {
            name: 'coder',
            ok: true,
            data: report({ agentDir: '/agents/coder', totals: { cost: 0.04 } }),
          },
        ],
      }),
      { useColor: true },
    )
    expect(out).toContain('\u001b[')
  })

  test('emits no ANSI escapes when useColor is unset', () => {
    const out = formatComposeUsage(
      result({
        agents: [{ name: 'coder', cwd: '/agents/coder', containerName: 'coder' }],
        results: [{ name: 'coder', ok: true, data: report({ agentDir: '/agents/coder' }) }],
      }),
    )
    expect(out).not.toContain('\u001b[')
  })
})

describe('formatComposeUsageJson', () => {
  test('emits valid JSON containing rootCwd and per-agent results', () => {
    const parsed = JSON.parse(
      formatComposeUsageJson(
        result({
          rootCwd: '/agents',
          agents: [{ name: 'coder', cwd: '/agents/coder', containerName: 'coder' }],
          results: [{ name: 'coder', ok: true, data: report({ agentDir: '/agents/coder' }) }],
        }),
      ),
    )
    expect(parsed.rootCwd).toBe('/agents')
    expect(Array.isArray(parsed.results)).toBe(true)
    expect(parsed.results[0].name).toBe('coder')
  })
})
