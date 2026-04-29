import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Reloadable, ReloadResult } from '@/reload'

import { createCronReloadable } from './reloadable'
import type { JobDiff, Scheduler } from './scheduler'
import type { CronJob } from './schema'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cron-reload-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function recordingScheduler(): Scheduler & { replacements: CronJob[][] } {
  const replacements: CronJob[][] = []
  return {
    replacements,
    start: () => {},
    stop: () => {},
    replaceJobs: (jobs) => {
      replacements.push([...jobs])
      return { added: jobs, removed: [], updated: [], unchanged: [] } as JobDiff
    },
  }
}

function failingScheduler(error: Error): Scheduler {
  return {
    start: () => {},
    stop: () => {},
    replaceJobs: () => {
      throw error
    },
  }
}

async function asFailure(r: Promise<ReloadResult>): Promise<Extract<ReloadResult, { ok: false }>> {
  const result = await r
  if (result.ok) throw new Error(`expected failure, got: ${JSON.stringify(result)}`)
  return result
}

async function asSuccess(r: Promise<ReloadResult>): Promise<Extract<ReloadResult, { ok: true }>> {
  const result = await r
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`)
  return result
}

describe('createCronReloadable', () => {
  test('exposes scope=cron with a description', () => {
    const reloadable: Reloadable = createCronReloadable({ cwd: agentDir, scheduler: recordingScheduler() })
    expect(reloadable.scope).toBe('cron')
    expect(reloadable.description).toMatch(/cron/i)
  })

  test('reloads from cron.json and replaces jobs in the scheduler', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['a'])
    expect(result.summary).toMatch(/added 1/)
  })

  test('absent cron.json is treated as zero jobs (still reloads)', async () => {
    const scheduler = recordingScheduler()
    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toEqual([[]])
    expect(result.summary).toMatch(/0 jobs/)
  })

  test('does NOT touch the scheduler when cron.json has invalid JSON', async () => {
    const scheduler = recordingScheduler()
    await writeFile(join(agentDir, 'cron.json'), '{ not valid json')

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
    expect(result.reason).toMatch(/cron\.json/i)
  })

  test('does NOT touch the scheduler when cron.json fails schema validation', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'bad id with spaces', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
    expect(result.reason).toMatch(/id/i)
  })

  test('does NOT touch the scheduler when cron expression is invalid', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'j', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x' }] }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
    expect(result.reason).toMatch(/not-a-cron/)
  })

  test('does NOT touch the scheduler when ids are not unique', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'dup', schedule: '* * * * *', kind: 'prompt', prompt: 'a' },
          { id: 'dup', schedule: '0 * * * *', kind: 'prompt', prompt: 'b' },
        ],
      }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(scheduler.replacements).toEqual([])
    expect(result.reason).toMatch(/duplicate/i)
  })

  test('returns an ok=false result when scheduler.replaceJobs throws (belt-and-suspenders)', async () => {
    const scheduler = failingScheduler(new Error('apply blew up'))
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )

    const reloadable = createCronReloadable({ cwd: agentDir, scheduler })
    const result = await asFailure(reloadable.reload())

    expect(result.reason).toMatch(/apply blew up/)
  })

  test('merges internalJobs() with user jobs on reload', async () => {
    const scheduler = recordingScheduler()
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'user-job', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
      }),
    )
    const internal: CronJob = {
      id: '__internal_dreaming',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'prompt',
      prompt: '(internal)',
      subagent: 'dreaming',
      payload: { agentDir: '/x' },
    }

    const reloadable = createCronReloadable({
      cwd: agentDir,
      scheduler,
      internalJobs: () => [internal],
    })
    await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['user-job', '__internal_dreaming'])
  })

  test('absent cron.json with internalJobs() still hands the internal jobs to the scheduler', async () => {
    const scheduler = recordingScheduler()
    const internal: CronJob = {
      id: '__internal_dreaming',
      schedule: '0 4 * * *',
      enabled: true,
      kind: 'prompt',
      prompt: '(internal)',
      subagent: 'dreaming',
      payload: { agentDir: '/x' },
    }

    const reloadable = createCronReloadable({
      cwd: agentDir,
      scheduler,
      internalJobs: () => [internal],
    })
    const result = await asSuccess(reloadable.reload())

    expect(scheduler.replacements).toHaveLength(1)
    expect(scheduler.replacements[0]?.map((j) => j.id)).toEqual(['__internal_dreaming'])
    expect(result.summary).toMatch(/added 1/)
  })

  test('summary describes added/removed/updated/unchanged counts', async () => {
    let diff: JobDiff = { added: [], removed: [], updated: [], unchanged: [] }
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: () => diff,
    }
    diff = {
      added: [job('a')],
      removed: [job('r')],
      updated: [job('u'), job('u2')],
      unchanged: [job('k1'), job('k2'), job('k3')],
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))

    const result = await asSuccess(createCronReloadable({ cwd: agentDir, scheduler }).reload())

    expect(result.summary).toContain('added 1')
    expect(result.summary).toContain('removed 1')
    expect(result.summary).toContain('updated 2')
    expect(result.summary).toContain('unchanged 3')
  })

  test('details include the diff for downstream consumption', async () => {
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: () => ({
        added: [job('new')],
        removed: [],
        updated: [],
        unchanged: [],
      }),
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))

    const result = await asSuccess(createCronReloadable({ cwd: agentDir, scheduler }).reload())

    const details = result.details as { added: { id: string }[] }
    expect(details.added.map((j) => j.id)).toEqual(['new'])
  })
})

function job(id: string): CronJob {
  return { id, schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }
}
