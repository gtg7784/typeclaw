import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runUsage } from './index'
import { formatJson, formatReport } from './report'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-usage-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

async function writeSessionFile(sessionId: string, lines: object[]): Promise<void> {
  const sessionsDir = join(agentDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const ts = new Date('2026-05-10T00:00:00Z').toISOString().replace(/[:.]/g, '-')
  const file = join(sessionsDir, `${ts}_${sessionId}.jsonl`)
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'))
}

function assistantEntry(opts: {
  id: string
  ts: number
  provider: string
  model: string
  input: number
  output: number
  cost: number
}): object {
  return {
    type: 'message',
    id: opts.id,
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

describe('runUsage', () => {
  test('returns zero report for an agent with no sessions/ dir', async () => {
    const report = await runUsage({ agentDir })
    expect(report.aggregation.total.messageCount).toBe(0)
    expect(report.aggregation.bySession).toEqual([])
    expect(report.warnings).toEqual([])
  })

  test('sums tokens and cost across two sessions and groups by model', async () => {
    // given
    const t1 = new Date('2026-05-10T10:00:00').getTime()
    const t2 = new Date('2026-05-10T11:00:00').getTime()
    const t3 = new Date('2026-05-11T09:00:00').getTime()
    await writeSessionFile('aaaa1111', [
      { type: 'session', version: 3, id: 'aaaa1111' },
      { type: 'message', message: { role: 'user', content: 'hi', timestamp: t1 } },
      assistantEntry({
        id: 'm1',
        ts: t1,
        provider: 'fireworks',
        model: 'kimi-k2',
        input: 1000,
        output: 200,
        cost: 0.04,
      }),
      assistantEntry({
        id: 'm2',
        ts: t2,
        provider: 'fireworks',
        model: 'kimi-k2',
        input: 2000,
        output: 400,
        cost: 0.08,
      }),
    ])
    await writeSessionFile('bbbb2222', [
      assistantEntry({ id: 'm3', ts: t3, provider: 'anthropic', model: 'claude', input: 500, output: 100, cost: 0.02 }),
    ])

    // when
    const report = await runUsage({ agentDir })

    // then
    expect(report.aggregation.total).toMatchObject({
      messageCount: 3,
      input: 3500,
      output: 700,
      totalTokens: 4200,
    })
    expect(report.aggregation.total.cost).toBeCloseTo(0.14, 5)
    expect(report.aggregation.byModel).toHaveLength(2)
    const fireworks = report.aggregation.byModel.find((m) => m.provider === 'fireworks')!
    expect(fireworks.messageCount).toBe(2)
    expect(fireworks.cost).toBeCloseTo(0.12, 5)
    expect(report.aggregation.bySession).toHaveLength(2)
  })

  test('groups by session id parsed from the basename', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('feed1234', [
      assistantEntry({ id: 'm1', ts, provider: 'p', model: 'x', input: 10, output: 5, cost: 0.001 }),
    ])
    const report = await runUsage({ agentDir })
    expect(report.aggregation.bySession[0]?.sessionId).toBe('feed1234')
  })

  test('honors since/until window', async () => {
    const tEarly = new Date('2026-05-01T00:00:00').getTime()
    const tMid = new Date('2026-05-10T00:00:00').getTime()
    const tLate = new Date('2026-05-20T00:00:00').getTime()
    await writeSessionFile('range001', [
      assistantEntry({ id: 'm1', ts: tEarly, provider: 'p', model: 'x', input: 100, output: 10, cost: 0.01 }),
      assistantEntry({ id: 'm2', ts: tMid, provider: 'p', model: 'x', input: 200, output: 20, cost: 0.02 }),
      assistantEntry({ id: 'm3', ts: tLate, provider: 'p', model: 'x', input: 400, output: 40, cost: 0.04 }),
    ])
    const inRange = await runUsage({ agentDir, since: tMid, until: tLate })
    expect(inRange.aggregation.total.messageCount).toBe(1)
    expect(inRange.aggregation.total.input).toBe(200)
  })

  test('skips malformed JSONL lines and records a warning', async () => {
    const sessionsDir = join(agentDir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const ts = new Date('2026-05-10T10:00:00').getTime()
    const good = JSON.stringify(
      assistantEntry({ id: 'm1', ts, provider: 'p', model: 'x', input: 10, output: 5, cost: 0.001 }),
    )
    await writeFile(join(sessionsDir, 'bad_abcd0001.jsonl'), `${good}\n{not valid json\n${good}\n`)
    const report = await runUsage({ agentDir })
    expect(report.aggregation.total.messageCount).toBe(2)
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toMatch(/malformed/)
  })

  test('ignores non-assistant entries (user, custom_message, session header)', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('mix00001', [
      { type: 'session', version: 3, id: 'mix00001' },
      { type: 'message', message: { role: 'user', content: 'hi', timestamp: ts } },
      { type: 'custom_message', customType: 'typeclaw.restart', content: 'restarted', display: false },
      assistantEntry({ id: 'm1', ts, provider: 'p', model: 'x', input: 50, output: 10, cost: 0.005 }),
    ])
    const report = await runUsage({ agentDir })
    expect(report.aggregation.total.messageCount).toBe(1)
  })

  test('counts aborted/error assistant messages (partial usage is real billing)', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('abrt0001', [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [],
          api: 'fake',
          provider: 'p',
          model: 'x',
          usage: {
            input: 300,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 350,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 },
          },
          stopReason: 'aborted',
          errorMessage: 'cancelled by user',
          timestamp: ts,
        },
      },
    ])
    const report = await runUsage({ agentDir })
    expect(report.aggregation.total.messageCount).toBe(1)
    expect(report.aggregation.total.input).toBe(300)
  })
})

describe('formatReport', () => {
  test('renders an empty-state message when there are no turns', async () => {
    const report = await runUsage({ agentDir })
    const out = formatReport(report)
    expect(out).toMatch(/USAGE/)
    expect(out).toMatch(/No assistant turns/i)
  })

  test('summary contains totals and a by-model section', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('sum00001', [
      assistantEntry({ id: 'm1', ts, provider: 'fireworks', model: 'kimi-k2', input: 1234, output: 200, cost: 0.04 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'summary' })
    expect(out).toMatch(/By model/)
    expect(out).toMatch(/fireworks\/kimi-k2/)
    expect(out).toMatch(/\$0\.04/)
  })

  test('models view sorts by cost desc', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('mdl00001', [
      assistantEntry({ id: 'm1', ts, provider: 'a', model: 'cheap', input: 100, output: 10, cost: 0.001 }),
      assistantEntry({ id: 'm2', ts: ts + 1, provider: 'b', model: 'pricey', input: 100, output: 10, cost: 0.5 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'models' })
    const idxPricey = out.indexOf('b/pricey')
    const idxCheap = out.indexOf('a/cheap')
    expect(idxPricey).toBeGreaterThan(-1)
    expect(idxCheap).toBeGreaterThan(idxPricey)
  })

  test('formatJson emits valid JSON with the agentDir', async () => {
    const report = await runUsage({ agentDir })
    const parsed = JSON.parse(formatJson(report))
    expect(parsed.agentDir).toBe(agentDir)
    expect(parsed.aggregation).toBeDefined()
  })

  test('report includes a timezone field', async () => {
    const report = await runUsage({ agentDir })
    expect(typeof report.timezone).toBe('string')
    expect(report.timezone.length).toBeGreaterThan(0)
  })

  test('summary output shows the timezone in the header', async () => {
    const report = await runUsage({ agentDir })
    const out = formatReport(report)
    expect(out).toMatch(/Timezone:/)
  })
})

describe('runUsage filesystem robustness', () => {
  test('skips a directory whose name ends in .jsonl and warns', async () => {
    const sessionsDir = join(agentDir, 'sessions')
    await mkdir(join(sessionsDir, 'oops.jsonl'), { recursive: true })
    const report = await runUsage({ agentDir })
    expect(report.aggregation.total.messageCount).toBe(0)
    expect(report.warnings.some((w) => /non-file/i.test(w))).toBe(true)
  })

  test('silently skips an unterminated trailing line and does not warn', async () => {
    const sessionsDir = join(agentDir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const ts = new Date('2026-05-10T10:00:00').getTime()
    const good = JSON.stringify(
      assistantEntry({ id: 'm1', ts, provider: 'p', model: 'x', input: 10, output: 5, cost: 0.001 }),
    )
    await writeFile(join(sessionsDir, '2026-05-10_partial.jsonl'), `${good}\n{"type":"message","mes`)
    const report = await runUsage({ agentDir })
    expect(report.aggregation.total.messageCount).toBe(1)
    expect(report.warnings).toEqual([])
  })
})

describe('formatReport narrow-terminal rendering', () => {
  const provider = 'someverylongprovider'
  const longModel = 'kimi-k2-instruct-with-a-very-long-suffix'

  test('always shows Cache % column (no longer drops on narrow terminals)', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('cache001', [
      assistantEntry({ id: 'm1', ts, provider: 'fireworks', model: 'kimi-k2', input: 1000, output: 200, cost: 0.04 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'models', terminalWidth: 60 })
    expect(out).toMatch(/Cache %/)
  })

  test('truncates a long model name with an ellipsis and strips the provider prefix', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('trunc001', [
      assistantEntry({ id: 'm1', ts, provider, model: longModel, input: 100, output: 10, cost: 0.01 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'models', terminalWidth: 60 })
    expect(out).toMatch(/…/)
    expect(out).not.toMatch(new RegExp(`${provider}/`))
    expect(out).toMatch(/kimi/)
  })

  test('does not truncate when the terminal is wide enough', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('wide0001', [
      assistantEntry({ id: 'm1', ts, provider, model: longModel, input: 100, output: 10, cost: 0.01 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'models', terminalWidth: 200 })
    expect(out).not.toMatch(/…/)
    expect(out).toMatch(new RegExp(`${provider}/${longModel}`))
  })

  test('does not truncate when terminalWidth is omitted', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('omit0001', [
      assistantEntry({ id: 'm1', ts, provider, model: longModel, input: 100, output: 10, cost: 0.01 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'models' })
    expect(out).not.toMatch(/…/)
    expect(out).toMatch(new RegExp(`${provider}/${longModel}`))
  })

  test('session view truncates the single-model extra column on narrow terminals', async () => {
    const ts = new Date('2026-05-10T10:00:00').getTime()
    await writeSessionFile('sess0001', [
      assistantEntry({ id: 'm1', ts, provider, model: longModel, input: 100, output: 10, cost: 0.01 }),
    ])
    const report = await runUsage({ agentDir })
    const out = formatReport(report, { view: 'session', terminalWidth: 70 })
    expect(out).toMatch(/…/)
  })
})

describe('formatReport colors (tokscale-matched palette)', () => {
  const ts = new Date('2026-05-10T10:00:00').getTime()

  async function reportWithCost(cost: number) {
    await writeSessionFile(`c${cost}`.replace(/\./g, ''), [
      assistantEntry({ id: 'm1', ts, provider: 'fireworks', model: 'kimi-k2', input: 100, output: 10, cost }),
    ])
    return runUsage({ agentDir })
  }

  /* eslint-disable no-control-regex -- ANSI escape sequences are deliberately matched here. */
  test('emits no ANSI when useColor is false', async () => {
    const report = await reportWithCost(0.05)
    const out = formatReport(report, { view: 'models', useColor: false })
    expect(out.match(/\u001b\[/)).toBeNull()
  })

  test('column header row is cyan (36m)', async () => {
    const report = await reportWithCost(0.05)
    const out = formatReport(report, { view: 'models', useColor: true })
    expect(out).toMatch(/\u001b\[36m[^\u001b]*Item[^\u001b]*Msgs[^\u001b]*In[^\u001b]*Out/)
  })

  test('cost values are NOT colored by value (tokscale match: plain default)', async () => {
    for (const cost of [0, 0.05, 2.5]) {
      const r = await reportWithCost(cost)
      const out = formatReport(r, { view: 'models', useColor: true })
      // Cost should not be wrapped in green (32m), yellow on its own (33m), or
      // dim (2m) for value-tier reasons. The Total footer is yellow, but row
      // costs are plain.
      const costPattern = new RegExp(`\\u001b\\[(32|33)m\\$[0-9.]+\\u001b\\[39m`)
      // The Total row also contains $cost in yellow, so we strip the table's
      // last line before matching to isolate the data row's coloring.
      const dataRow = out.split('\n').slice(0, -1).join('\n')
      expect(dataRow.match(costPattern)).toBeNull()
    }
  })

  test('Total footer row is yellow + bold (33m + 1m wrapping the whole row)', async () => {
    const report = await reportWithCost(0.05)
    const out = formatReport(report, { view: 'models', useColor: true })
    expect(out).toMatch(/\u001b\[33m\u001b\[1m[^\u001b]*Total/)
  })

  test('provider prefix is dimmed; model id stays default color', async () => {
    const report = await reportWithCost(0.05)
    const out = formatReport(report, { view: 'models', useColor: true })
    expect(out).toMatch(/\u001b\[2mfireworks\/\u001b\[22mkimi-k2/)
  })
  /* eslint-enable no-control-regex */
})

describe('formatReport cache hit rate column', () => {
  const ts = new Date('2026-05-10T10:00:00').getTime()

  async function reportWithCache(input: number, cacheRead: number) {
    await writeSessionFile(`hit-${input}-${cacheRead}`, [
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: new Date(ts).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          api: 'fake',
          provider: 'p',
          model: 'x',
          usage: {
            input,
            output: 50,
            cacheRead,
            cacheWrite: 0,
            totalTokens: input + 50 + cacheRead,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
          stopReason: 'stop',
          timestamp: ts,
        },
      },
    ])
    return runUsage({ agentDir })
  }

  test('renders the column header as `Cache %`', async () => {
    const report = await reportWithCache(900, 100)
    const out = formatReport(report, { view: 'models' })
    expect(out).toMatch(/Cache %/)
    expect(out).not.toMatch(/Cache R\/W/)
  })

  test('computes hit rate as cacheRead / (input + cacheRead) rounded to whole percent', async () => {
    const report = await reportWithCache(900, 100)
    const out = formatReport(report, { view: 'models' })
    expect(out).toMatch(/10%/)
  })

  test('reports 0% when no cache hits', async () => {
    const report = await reportWithCache(1000, 0)
    const out = formatReport(report, { view: 'models' })
    expect(out).toMatch(/0%/)
  })

  test('reports 100% when every input token was cached', async () => {
    const report = await reportWithCache(0, 1000)
    const out = formatReport(report, { view: 'models' })
    expect(out).toMatch(/100%/)
  })

  test('shows em-dash for a row with no input and no cache reads', async () => {
    const report = await reportWithCache(0, 0)
    const out = formatReport(report, { view: 'models' })
    expect(out).toMatch(/—/)
  })

  /* eslint-disable no-control-regex -- ANSI escape sequences are deliberately matched here. */
  test('cache % values are NOT colored by value (tokscale match: plain default)', async () => {
    const report = await reportWithCache(400, 600)
    const out = formatReport(report, { view: 'models', useColor: true })
    // Strip the Total footer (yellow), then assert no green wrapping a "60%".
    const dataRow = out.split('\n').slice(0, -1).join('\n')
    expect(dataRow.match(/\u001b\[32m60%\u001b\[39m/)).toBeNull()
  })
  /* eslint-enable no-control-regex */
})

describe('formatReport Sent column (provider-billed volume = input + cacheRead)', () => {
  const ts = new Date('2026-05-10T10:00:00').getTime()

  async function reportWithCache(input: number, cacheRead: number) {
    await writeSessionFile(`sent-${input}-${cacheRead}`, [
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: new Date(ts).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          api: 'fake',
          provider: 'p',
          model: 'x',
          usage: {
            input,
            output: 50,
            cacheRead,
            cacheWrite: 0,
            totalTokens: input + 50 + cacheRead,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
          stopReason: 'stop',
          timestamp: ts,
        },
      },
    ])
    return runUsage({ agentDir })
  }

  test('renders a `Sent` column in tabular views', async () => {
    const report = await reportWithCache(900, 100)
    const out = formatReport(report, { view: 'models' })
    expect(out).toMatch(/Sent/)
  })

  test('Sent equals input + cacheRead for a row (warm session: small input, large cache)', async () => {
    // given: a warm session that shipped 84,000 tokens of context per turn,
    // 99% of which hit the prompt cache. The dashboard bills this as 84k
    // (volume shipped); the In column alone shows only 1k (cache misses).
    const report = await reportWithCache(1_000, 83_000)
    const out = formatReport(report, { view: 'models' })

    // then: the Sent column must reflect the true 84k volume so a user
    // reading the report sees the same magnitude their provider invoice does.
    expect(out).toMatch(/\b84k\b/)
    expect(out).toMatch(/99%/)
  })

  test('Sent equals input on cold-start turns (no cache reads)', async () => {
    // given: a cold-start turn where the full prompt was billed fresh
    const report = await reportWithCache(82_697, 0)
    const out = formatReport(report, { view: 'models' })

    // then: Sent matches input verbatim. We assert presence rather than
    // exact ordering because both `In` and `Sent` show the same magnitude
    // for cold-start rows.
    expect(out).toMatch(/83k/)
    expect(out).toMatch(/0%/)
  })

  test('summary headline includes Sent total', async () => {
    const report = await reportWithCache(1_000, 99_000)
    const out = formatReport(report, { view: 'summary' })
    expect(out).toMatch(/Sent:/)
    // 1k + 99k = 100k; format rounds to "100k"
    expect(out).toMatch(/Sent:\s*100k/)
  })

  test('Sent appears in the daily view footer Total row', async () => {
    const report = await reportWithCache(500, 9_500)
    const out = formatReport(report, { view: 'daily' })
    // 500 + 9500 = 10000 = "10k"
    expect(out).toMatch(/\b10k\b/)
  })
})
