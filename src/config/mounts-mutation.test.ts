import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addMount, listMounts, removeMount } from './mounts-mutation'

describe('mounts mutation', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-mounts-'))
    await writeFile(join(cwd, 'typeclaw.json'), '{}\n')
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('adds a mount and reports the container target', async () => {
    const hostDir = join(cwd, 'projects')
    await mkdir(hostDir)

    const result = addMount(cwd, 'projects', './projects', { description: 'work repos' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry).toMatchObject({
      name: 'projects',
      path: './projects',
      readOnly: false,
      description: 'work repos',
      resolvedPath: hostDir,
      targetPath: '/agent/mounts/projects',
      status: 'ok',
    })

    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toEqual([{ name: 'projects', path: './projects', readOnly: false, description: 'work repos' }])
  })

  test('refuses duplicate mount names', async () => {
    const hostDir = join(cwd, 'projects')
    await mkdir(hostDir)
    expect(addMount(cwd, 'projects', hostDir).ok).toBe(true)

    const duplicate = addMount(cwd, 'projects', hostDir)

    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.reason).toContain('already exists')
  })

  test('refuses a missing host path before writing typeclaw.json', async () => {
    const result = addMount(cwd, 'missing', join(cwd, 'missing'))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('does not exist')
    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toBeUndefined()
  })

  test('adds a mount when an unrelated existing mount path is broken', async () => {
    const hostDir = join(cwd, 'projects')
    await mkdir(hostDir)
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ mounts: [{ name: 'gone', path: join(cwd, 'gone') }] }, null, 2),
    )

    const result = addMount(cwd, 'projects', hostDir)

    expect(result.ok).toBe(true)
    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toEqual([
      { name: 'gone', path: join(cwd, 'gone'), readOnly: false },
      { name: 'projects', path: hostDir, readOnly: false },
    ])
  })

  test('removes a mount by name', async () => {
    const hostDir = join(cwd, 'projects')
    await mkdir(hostDir)
    expect(addMount(cwd, 'projects', hostDir).ok).toBe(true)

    const result = removeMount(cwd, 'projects')

    expect(result.ok).toBe(true)
    expect(listMounts(cwd)).toEqual([])
  })

  test('removes a mount when an unrelated existing mount path is broken', async () => {
    const hostDir = join(cwd, 'projects')
    await mkdir(hostDir)
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify(
        {
          mounts: [
            { name: 'gone', path: join(cwd, 'gone') },
            { name: 'projects', path: hostDir, readOnly: false },
          ],
        },
        null,
        2,
      ),
    )

    const result = removeMount(cwd, 'projects')

    expect(result.ok).toBe(true)
    const raw = JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as { mounts?: unknown[] }
    expect(raw.mounts).toEqual([{ name: 'gone', path: join(cwd, 'gone'), readOnly: false }])
  })

  test('list reports broken mount paths without throwing', async () => {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ mounts: [{ name: 'gone', path: join(cwd, 'gone') }] }, null, 2),
    )

    const [entry] = listMounts(cwd)

    expect(entry?.name).toBe('gone')
    expect(entry?.status).toBe('error')
    expect(entry?.statusReason).toContain('does not exist')
  })
})
