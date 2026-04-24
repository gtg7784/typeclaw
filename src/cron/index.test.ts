import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createExecRunner, loadCron } from './index'
import type { ExecJob } from './schema'

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
          { id: 'daily', schedule: '30 23 * * *', kind: 'prompt', prompt: 'summarize' },
          { id: 'backup', schedule: '0 * * * *', kind: 'exec', command: ['git', 'commit', '-am', 'x'] },
        ],
      }),
    )

    const result = await loadCron(root)

    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file?.jobs).toHaveLength(2)
    expect(result.file?.jobs[0]?.id).toBe('daily')
    expect(result.file?.jobs[1]?.id).toBe('backup')
  })

  test('returns error on invalid json syntax', async () => {
    await writeFile(join(root, 'cron.json'), '{ not valid json')

    const result = await loadCron(root)

    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/cron\.json/)
  })

  test('returns error on schema violation', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'j', schedule: 'bogus', kind: 'prompt', prompt: 'x' }] }),
    )

    const result = await loadCron(root)

    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/bogus/)
  })
})

describe('createExecRunner', () => {
  test('spawns the configured command in the agent dir', async () => {
    const runner = createExecRunner({ cwd: root })
    const job: ExecJob = {
      id: 'touch',
      schedule: '* * * * *',
      enabled: true,
      kind: 'exec',
      command: ['sh', '-c', 'echo hello > out.txt'],
    }

    await runner.runExec(job)

    const contents = await Bun.file(join(root, 'out.txt')).text()
    expect(contents.trim()).toBe('hello')
  })

  test('rejects when the command exits non-zero', async () => {
    const runner = createExecRunner({ cwd: root })
    const job: ExecJob = {
      id: 'fail',
      schedule: '* * * * *',
      enabled: true,
      kind: 'exec',
      command: ['sh', '-c', 'exit 3'],
    }

    await expect(runner.runExec(job)).rejects.toThrow(/exited with code 3/)
  })
})
