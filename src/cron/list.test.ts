import { describe, expect, test } from 'bun:test'

import type { RegisteredCronJob } from '@/plugin'

import { aggregateCronList } from './list'
import type { CronJob } from './schema'

const FIXED_NOW = Date.parse('2026-05-18T00:00:00Z')

function userPromptJob(overrides: Partial<Extract<CronJob, { kind: 'prompt' }>> = {}): CronJob {
  return {
    id: 'user-prompt',
    schedule: '*/5 * * * *',
    enabled: true,
    kind: 'prompt',
    prompt: 'do the thing',
    scheduledByRole: 'owner',
    ...overrides,
  }
}

function userExecJob(overrides: Partial<Extract<CronJob, { kind: 'exec' }>> = {}): CronJob {
  return {
    id: 'user-exec',
    schedule: '0 * * * *',
    enabled: true,
    kind: 'exec',
    command: ['echo', 'hi'],
    scheduledByRole: 'owner',
    ...overrides,
  }
}

function registeredJob(pluginName: string, localId: string, job: CronJob): RegisteredCronJob {
  return { pluginName, localId, globalId: `__plugin_${pluginName}_${localId}`, job }
}

describe('aggregateCronList', () => {
  test('returns empty list when no jobs', () => {
    const result = aggregateCronList({ userJobs: [], pluginJobs: [], now: FIXED_NOW })
    expect(result).toEqual([])
  })

  test('renders user prompt job with source: user', () => {
    const result = aggregateCronList({ userJobs: [userPromptJob()], pluginJobs: [], now: FIXED_NOW })
    expect(result).toHaveLength(1)
    const entry = result[0]!
    expect(entry.source).toEqual({ kind: 'user' })
    expect(entry.id).toBe('user-prompt')
    expect(entry.kind).toBe('prompt')
    expect(entry.prompt).toBe('do the thing')
    expect(entry.command).toBeUndefined()
    expect(entry.scheduledByRole).toBe('owner')
    expect(entry.nextFireMs).not.toBeNull()
    expect(entry.scheduleError).toBeUndefined()
  })

  test('renders user exec job with command', () => {
    const result = aggregateCronList({ userJobs: [userExecJob()], pluginJobs: [], now: FIXED_NOW })
    expect(result).toHaveLength(1)
    const entry = result[0]!
    expect(entry.kind).toBe('exec')
    expect(entry.command).toEqual(['echo', 'hi'])
    expect(entry.prompt).toBeUndefined()
  })

  test('renders plugin job with source: plugin attribution and localId', () => {
    const pluginJob = registeredJob(
      'memory',
      'dreaming',
      userPromptJob({
        id: '__plugin_memory_dreaming',
        schedule: '*/30 * * * *',
        subagent: 'dreaming',
        prompt: '(internal)',
      }),
    )
    const result = aggregateCronList({ userJobs: [], pluginJobs: [pluginJob], now: FIXED_NOW })
    expect(result).toHaveLength(1)
    const entry = result[0]!
    expect(entry.source).toEqual({ kind: 'plugin', pluginName: 'memory', localId: 'dreaming' })
    expect(entry.id).toBe('__plugin_memory_dreaming')
    expect(entry.subagent).toBe('dreaming')
  })

  test('merges user and plugin jobs, sorted by next fire time ascending', () => {
    const userJob = userPromptJob({ id: 'every-hour', schedule: '0 * * * *' })
    const pluginJob = registeredJob(
      'memory',
      'dreaming',
      userPromptJob({ id: '__plugin_memory_dreaming', schedule: '*/5 * * * *' }),
    )
    const result = aggregateCronList({ userJobs: [userJob], pluginJobs: [pluginJob], now: FIXED_NOW })
    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('__plugin_memory_dreaming')
    expect(result[1]!.id).toBe('every-hour')
    expect(result[0]!.nextFireMs!).toBeLessThanOrEqual(result[1]!.nextFireMs!)
  })

  test('captures schedule errors without dropping the row', () => {
    const bogus = userPromptJob({ id: 'broken', schedule: 'not-a-cron-expr' })
    const result = aggregateCronList({ userJobs: [bogus], pluginJobs: [], now: FIXED_NOW })
    expect(result).toHaveLength(1)
    const entry = result[0]!
    expect(entry.nextFireMs).toBeNull()
    expect(entry.scheduleError).toBeDefined()
    expect(entry.scheduleError!.length).toBeGreaterThan(0)
  })

  test('invalid-schedule rows sort to the bottom', () => {
    const valid = userPromptJob({ id: 'valid', schedule: '*/5 * * * *' })
    const bogus = userExecJob({ id: 'broken', schedule: 'not-a-cron-expr' })
    const result = aggregateCronList({ userJobs: [bogus, valid], pluginJobs: [], now: FIXED_NOW })
    expect(result.map((r) => r.id)).toEqual(['valid', 'broken'])
  })

  test('disabled jobs are present with enabled: false but still compute nextFireMs', () => {
    const disabled = userPromptJob({ id: 'paused', enabled: false })
    const result = aggregateCronList({ userJobs: [disabled], pluginJobs: [], now: FIXED_NOW })
    expect(result).toHaveLength(1)
    expect(result[0]!.enabled).toBe(false)
    expect(result[0]!.nextFireMs).not.toBeNull()
  })

  test('timezone is preserved', () => {
    const tz = userPromptJob({ id: 'tz', schedule: '0 9 * * *', timezone: 'America/Los_Angeles' })
    const result = aggregateCronList({ userJobs: [tz], pluginJobs: [], now: FIXED_NOW })
    expect(result[0]!.timezone).toBe('America/Los_Angeles')
  })

  test('breaks nextFireMs ties by id for deterministic output', () => {
    const a = userPromptJob({ id: 'zzz', schedule: '*/5 * * * *' })
    const b = userPromptJob({ id: 'aaa', schedule: '*/5 * * * *' })
    const result = aggregateCronList({ userJobs: [a, b], pluginJobs: [], now: FIXED_NOW })
    expect(result.map((r) => r.id)).toEqual(['aaa', 'zzz'])
  })
})
