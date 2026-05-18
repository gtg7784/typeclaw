import { beforeEach, describe, expect, test } from 'bun:test'

import type { CronListEntryPayload } from '@/shared'

import { describeFailure, formatDuration, formatList } from './cron'

beforeEach(() => {
  process.env.NO_COLOR = '1'
})

const NOW = Date.parse('2026-05-18T00:00:00Z')

function entry(overrides: Partial<CronListEntryPayload> = {}): CronListEntryPayload {
  return {
    id: 'job-1',
    source: { kind: 'user' },
    kind: 'prompt',
    schedule: '*/5 * * * *',
    enabled: true,
    nextFireMs: NOW + 60_000,
    scheduledByRole: 'owner',
    prompt: 'do the thing',
    ...overrides,
  }
}

describe('formatDuration', () => {
  test('returns "now" for zero or past', () => {
    expect(formatDuration(0)).toBe('now')
    expect(formatDuration(-1000)).toBe('now')
  })

  test('formats seconds, minutes, hours, days', () => {
    expect(formatDuration(30_000)).toBe('in 30s')
    expect(formatDuration(5 * 60_000)).toBe('in 5m')
    expect(formatDuration(3 * 60 * 60_000)).toBe('in 3h')
    expect(formatDuration(72 * 60 * 60_000)).toBe('in 3d')
  })
})

describe('formatList', () => {
  test('renders empty placeholder when no jobs', () => {
    const out = formatList([], NOW)
    expect(out).toContain('No cron jobs')
  })

  test('renders a user prompt job with id, kind, source, schedule, role, prompt', () => {
    const out = formatList([entry()], NOW)
    expect(out).toContain('job-1')
    expect(out).toContain('[prompt]')
    expect(out).toContain('user')
    expect(out).toContain('*/5 * * * *')
    expect(out).toContain('role')
    expect(out).toContain('owner')
    expect(out).toContain('do the thing')
  })

  test('renders a plugin job with "plugin:<name>.<localId>" header', () => {
    const out = formatList(
      [
        entry({
          source: { kind: 'plugin', pluginName: 'memory', localId: 'dreaming' },
          id: '__plugin_memory_dreaming',
          subagent: 'dreaming',
        }),
      ],
      NOW,
    )
    expect(out).toContain('memory.dreaming')
    expect(out).toContain('plugin:memory.dreaming')
    expect(out).toContain('subagent')
    expect(out).toContain('dreaming')
    expect(out).not.toContain('do the thing')
  })

  test('renders exec jobs with command joined by spaces', () => {
    const out = formatList(
      [
        entry({
          kind: 'exec',
          prompt: undefined,
          command: ['bash', '-lc', 'echo hi'],
        }),
      ],
      NOW,
    )
    expect(out).toContain('[exec]')
    expect(out).toContain('bash -lc echo hi')
  })

  test('flags disabled jobs', () => {
    const out = formatList([entry({ enabled: false })], NOW)
    expect(out).toContain('(disabled)')
  })

  test('renders invalid-schedule rows with error reason', () => {
    const out = formatList([entry({ nextFireMs: null, scheduleError: 'cron-parser: bad expression' })], NOW)
    expect(out).toContain('invalid schedule')
    expect(out).toContain('cron-parser: bad expression')
  })

  test('renders timezone next to schedule when set', () => {
    const out = formatList([entry({ timezone: 'America/Los_Angeles' })], NOW)
    expect(out).toContain('America/Los_Angeles')
  })

  test('renders next-fire as ISO + relative duration', () => {
    const out = formatList([entry({ nextFireMs: NOW + 5 * 60_000 })], NOW)
    expect(out).toContain('2026-05-18T00:05:00.000Z')
    expect(out).toContain('in 5m')
  })
})

describe('describeFailure', () => {
  test('unreachable carries the reason', () => {
    expect(describeFailure({ kind: 'unreachable', reason: 'no port' })).toContain('no port')
  })

  test('timeout has a fixed message', () => {
    expect(describeFailure({ kind: 'timeout' })).toContain('timed out')
  })

  test('error returns the underlying reason', () => {
    expect(describeFailure({ kind: 'error', reason: 'malformed JSON' })).toBe('malformed JSON')
  })
})
