import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('loadCron auto-migrates legacy cron.json (PR #171 backfill)', () => {
  test('accepts a legacy cron.json missing scheduledByRole and stamps "owner"', async () => {
    // given: a legacy file that would crash the cron loader on every container start
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'minute-status-log', schedule: '* * * * *', kind: 'prompt', prompt: 'hello' }],
      }),
    )

    // when: any loadCron caller hits the file (container boot, reload, hostd)
    const result = await loadCron(root)

    // then: the load succeeds with the legacy job present and stamped owner
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file?.jobs).toHaveLength(1)
    expect(result.file?.jobs[0]?.scheduledByRole).toBe('owner')
  })

  test('rewrites cron.json on disk so subsequent reads see canonical shape', async () => {
    // given
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )

    // when
    const result = await loadCron(root)

    // then: the on-disk file now has scheduledByRole stamped
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    const onDisk = JSON.parse(await readFile(join(root, 'cron.json'), 'utf8'))
    expect(onDisk.jobs[0].scheduledByRole).toBe('owner')
  })

  test('commits the migration when run in a git repo', async () => {
    // given: a git repo with a legacy cron.json checked in
    await gitInitForCommitTests(root)
    const legacy = `${JSON.stringify(
      { jobs: [{ id: 'minute-status-log', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] },
      null,
      2,
    )}\n`
    await writeFile(join(root, 'cron.json'), legacy)
    await runGitForCommitTests(root, ['add', 'cron.json'])
    await runGitForCommitTests(root, ['commit', '-m', 'initial'])

    // when
    const result = await loadCron(root)

    // then: the migration commit landed AND on-disk content matches HEAD
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    const subjects = (await runGitForCommitTests(root, ['log', '--format=%s'])).split('\n')
    expect(subjects.some((s) => s.startsWith('cron.json:'))).toBe(true)
    const onDisk = JSON.parse(await readFile(join(root, 'cron.json'), 'utf8'))
    const tracked = JSON.parse(await runGitForCommitTests(root, ['show', 'HEAD:cron.json']))
    expect(tracked).toEqual(onDisk)
  })

  test('a second load after migration is idempotent (no duplicate commit)', async () => {
    // given
    await gitInitForCommitTests(root)
    const legacy = `${JSON.stringify(
      { jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] },
      null,
      2,
    )}\n`
    await writeFile(join(root, 'cron.json'), legacy)
    await runGitForCommitTests(root, ['add', 'cron.json'])
    await runGitForCommitTests(root, ['commit', '-m', 'initial'])

    // when: two consecutive loadCron calls
    await loadCron(root)
    const headAfterFirst = await runGitForCommitTests(root, ['rev-parse', 'HEAD'])
    await loadCron(root)
    const headAfterSecond = await runGitForCommitTests(root, ['rev-parse', 'HEAD'])

    // then: HEAD is unchanged — the second call observed canonical shape
    expect(headAfterSecond).toBe(headAfterFirst)
  })

  test('on a non-git folder the rewrite still happens (commit silently skipped)', async () => {
    // given: legacy file, no .git folder
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )

    // when
    const result = await loadCron(root)

    // then: rewrite happened, .git was not auto-created
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    const onDisk = JSON.parse(await readFile(join(root, 'cron.json'), 'utf8'))
    expect(onDisk.jobs[0].scheduledByRole).toBe('owner')
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  // Mutation-check anchor (AGENTS.md §3): commenting out the migrateLegacyCronShape()
  // call inside loadCron MUST cause this test to fail at the result.ok assertion.
  test('mutation check: removing the migration call surfaces the original schema error', async () => {
    await writeFile(
      join(root, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )
    const result = await loadCron(root)
    if (!result.ok) throw new Error(`expected migration to absorb legacy shape, got error: ${result.reason}`)
    expect(result.file?.jobs).toHaveLength(1)
  })
})

async function gitInitForCommitTests(cwd: string): Promise<void> {
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

async function runGitForCommitTests(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}
