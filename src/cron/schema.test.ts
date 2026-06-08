import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { Subagent, SubagentRegistry } from '@/agent/subagents'

import { cronFileSchema, parseCronFile } from './schema'

describe('cronFileSchema', () => {
  test('accepts an empty jobs list', () => {
    expect(() => cronFileSchema.parse({ jobs: [] })).not.toThrow()
  })

  test('accepts a prompt-kind job with required fields only', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'daily-summary', schedule: '30 23 * * *', kind: 'prompt', prompt: 'Summarize today.' }],
    })
    const job = parsed.jobs[0]
    if (!job) throw new Error('expected a job')
    expect(job.enabled).toBe(true)
    expect(job.timezone).toBeUndefined()
  })

  test('accepts an exec-kind job with a shell command', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'backup', schedule: '0 * * * *', kind: 'exec', command: ['git', 'commit', '-am', 'backup'] }],
    })
    const job = parsed.jobs[0]
    if (!job || job.kind !== 'exec') throw new Error('expected an exec job')
    expect(job.command).toEqual(['git', 'commit', '-am', 'backup'])
  })

  test('defaults enabled to true when omitted', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    })
    expect(parsed.jobs[0]?.enabled).toBe(true)
  })

  test('respects enabled: false', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: false }],
    })
    expect(parsed.jobs[0]?.enabled).toBe(false)
  })

  test('rejects missing id', () => {
    expect(() => cronFileSchema.parse({ jobs: [{ schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] })).toThrow()
  })

  test('rejects an id with whitespace', () => {
    expect(() =>
      cronFileSchema.parse({ jobs: [{ id: 'bad id', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    ).toThrow()
  })

  test('rejects unknown kind', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'weird', prompt: 'x' }],
      }),
    ).toThrow()
  })

  test('rejects subagent kind (internal-only — must not be writable from cron.json)', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'subagent', subagent: 'dreaming', payload: {} }],
      }),
    ).toThrow()
  })

  test('rejects prompt job missing prompt', () => {
    expect(() => cronFileSchema.parse({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt' }] })).toThrow()
  })

  test('rejects exec job with empty command array', () => {
    expect(() =>
      cronFileSchema.parse({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'exec', command: [] }] }),
    ).toThrow()
  })

  test('accepts a prompt job with subagent and payload fields', () => {
    const parsed = cronFileSchema.parse({
      jobs: [
        {
          id: 'consolidate',
          schedule: '30 23 * * *',
          kind: 'prompt',
          prompt: 'unused',
          subagent: 'dreaming',
          payload: { agentDir: '/agent' },
        },
      ],
    })
    const job = parsed.jobs[0]
    if (!job || job.kind !== 'prompt') throw new Error('expected a prompt job')
    expect(job.subagent).toBe('dreaming')
    expect(job.payload).toEqual({ agentDir: '/agent' })
  })

  test('rejects empty-string subagent name', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', subagent: '' }],
      }),
    ).toThrow()
  })

  test("rejects kind: 'handler' in user-authored cron.json (handlers are plugin-only)", () => {
    const result = parseCronFile({
      jobs: [
        {
          id: 'j',
          schedule: '* * * * *',
          kind: 'handler',
          scheduledByRole: 'owner',
        },
      ],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/kind/)
  })
})

describe('parseCronFile', () => {
  test('rejects invalid cron expressions with a helpful error', () => {
    const result = parseCronFile({
      jobs: [{ id: 'j', schedule: 'not-a-cron-expression', kind: 'prompt', prompt: 'x' }],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/not-a-cron-expression/)
    expect(result.reason).toMatch(/j/)
  })

  test('rejects invalid timezone', () => {
    const result = parseCronFile({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timezone: 'Not/A_Zone' }],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/timezone/i)
  })

  test('rejects duplicate job ids', () => {
    const result = parseCronFile({
      jobs: [
        { id: 'same', schedule: '* * * * *', kind: 'prompt', prompt: 'a', scheduledByRole: 'owner' },
        { id: 'same', schedule: '0 * * * *', kind: 'prompt', prompt: 'b', scheduledByRole: 'owner' },
      ],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/duplicate/i)
    expect(result.reason).toMatch(/same/)
  })

  test('rejects a job without scheduledByRole (boot-time legacy detection)', () => {
    const result = parseCronFile({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/scheduledByRole/)
  })

  test('accepts an empty file', () => {
    const result = parseCronFile({ jobs: [] })
    expect(result.ok).toBe(true)
  })

  test('accepts a valid mixed file', () => {
    const result = parseCronFile({
      jobs: [
        {
          id: 'a',
          schedule: '30 23 * * *',
          kind: 'prompt',
          prompt: 'x',
          timezone: 'Asia/Seoul',
          scheduledByRole: 'owner',
        },
        { id: 'b', schedule: '0 * * * *', kind: 'exec', command: ['echo', 'hi'], scheduledByRole: 'owner' },
      ],
    })
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file.jobs).toHaveLength(2)
  })
})

describe('parseCronFile timing boundaries (until / at / count)', () => {
  const NOW = new Date('2026-06-08T00:00:00Z').getTime()
  const FUTURE = '2026-06-12T00:00:00Z'
  const PAST = '2020-01-01T00:00:00Z'

  const job = (extra: Record<string, unknown>) => ({
    id: 'j',
    kind: 'prompt' as const,
    prompt: 'x',
    scheduledByRole: 'owner',
    ...extra,
  })

  test('accepts a recurring job with a future "until"', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: FUTURE })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.until).toBe(FUTURE)
  })

  test('accepts a recurring job with a positive "count"', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', count: 3 })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.count).toBe(3)
  })

  test('accepts a one-shot "at" job', () => {
    const result = parseCronFile({ jobs: [job({ at: FUTURE })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.at).toBe(FUTURE)
  })

  test('rejects a job with neither schedule nor at', () => {
    const result = parseCronFile({ jobs: [job({})] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/exactly one of "schedule".*"at"/)
  })

  test('rejects a job with both schedule and at', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', at: FUTURE })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/exactly one of/)
  })

  test('accepts a past "at" so a fired one-shot does not brick cron.json on reload', () => {
    const enabled = parseCronFile({ jobs: [job({ at: PAST })] }, { now: NOW })
    if (!enabled.ok) throw new Error(enabled.reason)
    expect(enabled.file.jobs[0]?.at).toBe(PAST)

    const disabled = parseCronFile({ jobs: [job({ at: PAST, enabled: false })] }, { now: NOW })
    if (!disabled.ok) throw new Error(disabled.reason)
  })

  test('rejects "until" in the past for an enabled job', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: PAST })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/past/)
  })

  test('rejects "until" before the first occurrence', () => {
    const result = parseCronFile(
      { jobs: [job({ schedule: '0 9 1 1 *', until: '2026-06-09T00:00:00Z' })] },
      { now: NOW },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/no occurrence/)
  })

  test('rejects an "at" without an explicit zone (local-time ambiguity)', () => {
    const result = parseCronFile({ jobs: [job({ at: '2026-06-12T09:00:00' })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/explicit zone/)
  })

  test('accepts an "at" with a numeric offset', () => {
    const result = parseCronFile({ jobs: [job({ at: '2026-06-12T09:00:00+09:00' })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
  })

  test('rejects "until" or "timezone" on a one-shot "at" job', () => {
    const withUntil = parseCronFile({ jobs: [job({ at: FUTURE, until: FUTURE })] }, { now: NOW })
    if (withUntil.ok) throw new Error('expected failure')
    expect(withUntil.reason).toMatch(/"until" is only valid with "schedule"/)

    const withTz = parseCronFile({ jobs: [job({ at: FUTURE, timezone: 'UTC' })] }, { now: NOW })
    if (withTz.ok) throw new Error('expected failure')
    expect(withTz.reason).toMatch(/"timezone" is only valid with "schedule"/)
  })

  test('rejects count > 1 on a one-shot "at" job', () => {
    const result = parseCronFile({ jobs: [job({ at: FUTURE, count: 2 })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/only set "count": 1/)
  })

  test('rejects a non-positive or non-integer count via schema', () => {
    expect(parseCronFile({ jobs: [job({ schedule: '0 9 * * *', count: 0 })] }, { now: NOW }).ok).toBe(false)
    expect(parseCronFile({ jobs: [job({ schedule: '0 9 * * *', count: 1.5 })] }, { now: NOW }).ok).toBe(false)
  })

  test('accepts until + count together on one recurring job', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: FUTURE, count: 5 })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
  })
})

describe('parseCronFile with subagents registry', () => {
  const greeter: Subagent = { systemPrompt: 'X' }
  const memoryLogger: Subagent<{ id: string }> = {
    systemPrompt: 'X',
    payloadSchema: z.object({ id: z.string() }),
  }
  const registry: SubagentRegistry = { greeter, 'memory-logger': memoryLogger }

  test('accepts a prompt job referencing a registered subagent with no payload', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'greeter',
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    expect(result.ok).toBe(true)
  })

  test('rejects a prompt job referencing an unknown subagent', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'no-such-thing',
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/unknown subagent/)
  })

  test('rejects a prompt job whose payload does not match the subagent payloadSchema', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'memory-logger',
            payload: { id: 42 },
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/invalid payload/)
  })

  test('rejects a prompt job that supplies a payload to a subagent without a schema', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'greeter',
            payload: { extra: 1 },
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/does not accept a payload/)
  })

  test('skips registry validation when no subagents option is provided (raw parse path)', () => {
    const result = parseCronFile({
      jobs: [
        {
          id: 'j',
          schedule: '* * * * *',
          kind: 'prompt',
          prompt: 'x',
          subagent: 'no-such-thing',
          scheduledByRole: 'owner',
        },
      ],
    })
    expect(result.ok).toBe(true)
  })
})
