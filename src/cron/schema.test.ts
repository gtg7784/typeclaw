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
