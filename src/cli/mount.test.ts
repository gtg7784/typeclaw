import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_ENTRY = join(import.meta.dir, 'index.ts')

describe('typeclaw mount CLI', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-mount-cli-'))
    await writeFile(join(cwd, 'typeclaw.json'), '{}\n')
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function runMount(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'mount', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  test('add writes a mount and tells the user to restart', async () => {
    await mkdir(join(cwd, 'downloads'))

    const result = await runMount(['add', 'downloads', './downloads', '--read-only', '--description=shared files'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Added mount "downloads"')
    expect(result.stdout).toContain('typeclaw restart')

    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toEqual([
      { name: 'downloads', path: './downloads', readOnly: true, description: 'shared files' },
    ])
  })

  test('list --json emits resolved host and container paths', async () => {
    await mkdir(join(cwd, 'downloads'))
    expect((await runMount(['add', 'downloads', './downloads'])).exitCode).toBe(0)

    const result = await runMount(['list', '--json'])
    const resolvedDownloads = await realpath(join(cwd, 'downloads'))

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as {
      mounts: Array<{ name: string; resolvedPath: string; targetPath: string; status: string }>
    }
    expect(parsed.mounts).toHaveLength(1)
    expect(parsed.mounts[0]).toMatchObject({
      name: 'downloads',
      resolvedPath: resolvedDownloads,
      targetPath: '/agent/mounts/downloads',
      status: 'ok',
    })
  })

  test('remove deletes the mount and tells the user to restart', async () => {
    await mkdir(join(cwd, 'downloads'))
    expect((await runMount(['add', 'downloads', './downloads'])).exitCode).toBe(0)

    const result = await runMount(['remove', 'downloads'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Removed mount "downloads"')
    expect(result.stdout).toContain('typeclaw restart')
    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toEqual([])
  })

  test('add refuses missing host paths', async () => {
    const result = await runMount(['add', 'missing', './missing'])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('does not exist')
    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toBeUndefined()
  })
})
