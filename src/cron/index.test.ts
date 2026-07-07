import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCron } from './index'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-cron-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('loadCron', () => {
  test('returns null when cron.json does not exist', async () => {
    const result = await loadCron(root)
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file).toBeNull()
  })

  test('returns an empty file when cron.json has { jobs: [] }', async () => {
    await writeFile(join(root, 'cron.json'), JSON.stringify({ jobs: [] }))

    const result = await loadCron(root)

    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file?.jobs).toEqual([])
  })

  test('returns parsed jobs on valid cron.json', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'daily', schedule: '30 23 * * *', kind: 'prompt', prompt: 'summarize', scheduledByRole: 'owner' },
          {
            id: 'backup',
            schedule: '0 * * * *',
            kind: 'exec',
            command: ['git', 'commit', '-am', 'x'],
            scheduledByRole: 'owner',
          },
        ],
      }),
    )

    const result = await loadCron(root)

    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file?.jobs).toHaveLength(2)
    expect(result.file?.jobs[0]?.id).toBe('daily')
    expect(result.file?.jobs[1]?.id).toBe('backup')
  })

  test('returns error on invalid json syntax (file-level, unrecoverable)', async () => {
    await writeFile(join(root, 'cron.json'), '{ not valid json')

    const result = await loadCron(root)

    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/cron\.json/)
  })

  test('returns error on top-level schema violation (file-level, unrecoverable)', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'bad id with spaces', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )

    const result = await loadCron(root)

    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/id/i)
  })

  test('default (strict load) fails the whole file on a per-job error (inspection/security safety)', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'good', schedule: '30 23 * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
          { id: 'bogus-schedule', schedule: 'bogus', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
        ],
      }),
    )

    const result = await loadCron(root)

    if (result.ok) throw new Error('strict load must fail the whole file on a bad job')
    expect(result.reason).toMatch(/bogus/)
  })

  test('boot mode isolates a single bad job and keeps the valid ones, surfacing a warning', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'good', schedule: '30 23 * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
          { id: 'bogus-schedule', schedule: 'bogus', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
        ],
      }),
    )

    const result = await loadCron(root, { mode: 'boot' })

    if (!result.ok) throw new Error(`expected boot isolation to succeed, got: ${result.reason}`)
    expect(result.file?.jobs.map((j) => j.id)).toEqual(['good'])
    expect(result.warnings?.some((w) => w.jobId === 'bogus-schedule' && /bogus/.test(w.reason))).toBe(true)
  })

  test('tolerates an expired "until" job on load (does not brick the file)', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({
        jobs: [
          {
            id: 'expired-ipo-monitor',
            schedule: '*/5 * * * *',
            until: '2020-01-01T00:00:00Z',
            kind: 'prompt',
            prompt: 'x',
            scheduledByRole: 'owner',
          },
        ],
      }),
    )

    const result = await loadCron(root)

    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file?.jobs.map((j) => j.id)).toEqual(['expired-ipo-monitor'])
  })
})
