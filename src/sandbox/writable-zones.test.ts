import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveProtectedZones, resolveWritableZones, subtractMasked } from './writable-zones'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-writable-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('resolveWritableZones', () => {
  test('includes only the allowed dirs that actually exist', async () => {
    await mkdir(join(agentDir, 'workspace'))
    await mkdir(join(agentDir, 'public'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).toEqual([join(agentDir, 'workspace'), join(agentDir, 'public')])
  })

  test('excludes .agents/skills and packages even when present (guarded/executable surfaces)', async () => {
    await mkdir(join(agentDir, '.agents', 'skills'), { recursive: true })
    await mkdir(join(agentDir, 'packages'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, '.agents/skills'))
    expect(dirs).not.toContain(join(agentDir, 'packages'))
  })

  test('includes only the allowed root files that exist', async () => {
    await writeFile(join(agentDir, 'AGENTS.md'), '# agents')
    await writeFile(join(agentDir, 'typeclaw.json'), '{}')

    const { files } = await resolveWritableZones(agentDir)

    expect(files).toEqual([join(agentDir, 'AGENTS.md'), join(agentDir, 'typeclaw.json')])
  })

  test('rejects a zone dir that is a symlink (RW bind would follow it outside)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      await symlink(outside, join(agentDir, 'workspace'))

      const { dirs } = await resolveWritableZones(agentDir)

      expect(dirs).not.toContain(join(agentDir, 'workspace'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('rejects a root file that is a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      const target = join(outside, 'real.json')
      await writeFile(target, '{}')
      await symlink(target, join(agentDir, 'typeclaw.json'))

      const { files } = await resolveWritableZones(agentDir)

      expect(files).not.toContain(join(agentDir, 'typeclaw.json'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('does not treat a same-named file as a writable dir (or vice versa)', async () => {
    await writeFile(join(agentDir, 'workspace'), 'not a dir')
    await mkdir(join(agentDir, 'AGENTS.md'))

    const { dirs, files } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, 'workspace'))
    expect(files).not.toContain(join(agentDir, 'AGENTS.md'))
  })

  test('returns empty lists for a bare agent dir', async () => {
    const { dirs, files } = await resolveWritableZones(agentDir)

    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  test('includes .git when it exists so bash can commit', async () => {
    await mkdir(join(agentDir, '.git'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).toContain(join(agentDir, '.git'))
  })

  test('omits .git when absent (bwrap would abort binding a missing source)', async () => {
    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, '.git'))
  })
})

describe('resolveProtectedZones', () => {
  test('re-protects .git/hooks and .git/config when present', async () => {
    await mkdir(join(agentDir, '.git', 'hooks'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n')

    const { dirs, files } = await resolveProtectedZones(agentDir)

    expect(dirs).toContain(join(agentDir, '.git/hooks'))
    expect(files).toEqual([join(agentDir, '.git/config')])
  })

  test('ensures and protects .git/hooks + .git/config even when absent', async () => {
    await mkdir(join(agentDir, '.git'))

    const { dirs, files } = await resolveProtectedZones(agentDir)

    // given .git existed but hooks/config did not, they are created AND returned
    expect(dirs).toContain(join(agentDir, '.git/hooks'))
    expect(files).toEqual([join(agentDir, '.git/config')])
    expect((await stat(join(agentDir, '.git/hooks'))).isDirectory()).toBe(true)
    expect((await stat(join(agentDir, '.git/config'))).isFile()).toBe(true)
  })

  test('rejects a symlinked .git/hooks rather than protecting the wrong target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      await mkdir(join(agentDir, '.git'))
      await symlink(outside, join(agentDir, '.git', 'hooks'))

      await expect(resolveProtectedZones(agentDir)).rejects.toThrow(/symlink/i)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('also protects a core.hooksPath that points inside the agent dir', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n\thooksPath = workspace/hooks\n')

    const { dirs } = await resolveProtectedZones(agentDir)

    expect(dirs).toContain(join(agentDir, 'workspace/hooks'))
    expect((await lstat(join(agentDir, 'workspace/hooks'))).isDirectory()).toBe(true)
  })

  test('ignores a core.hooksPath that resolves outside the agent dir', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n\thooksPath = /etc\n')

    const { dirs } = await resolveProtectedZones(agentDir)

    expect(dirs).not.toContain('/etc')
    expect(dirs).toContain(join(agentDir, '.git/hooks'))
  })

  test('a masked-dir core.hooksPath is dropped by subtractMasked (no mask re-exposure)', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n\thooksPath = workspace/hooks\n')

    // given a guest whose workspace/ is masked, protecting workspace/hooks would
    // re-expose the hidden dir; subtractMasked (as applyBashSandbox applies it)
    // must drop it — the masked path is unwritable, so it needs no protection
    const protectedZones = await resolveProtectedZones(agentDir)
    const filtered = subtractMasked(protectedZones, { dirs: [join(agentDir, 'workspace')], files: [] })

    expect(filtered.dirs).not.toContain(join(agentDir, 'workspace/hooks'))
    expect(filtered.dirs).toContain(join(agentDir, '.git/hooks'))
  })
})

describe('subtractMasked', () => {
  const w = (dirs: string[], files: string[]) => ({ dirs, files })

  test('drops a writable dir that is itself masked (guest workspace stays hidden)', () => {
    const result = subtractMasked(w(['/a/workspace', '/a/public', '/a/mounts'], ['/a/AGENTS.md']), {
      dirs: ['/a/workspace', '/a/memory', '/a/sessions'],
      files: ['/a/.env', '/a/secrets.json'],
    })

    expect(result.dirs).toEqual(['/a/public', '/a/mounts'])
    expect(result.files).toEqual(['/a/AGENTS.md'])
  })

  test('keeps all writable dirs when nothing is masked (member: only secret files masked)', () => {
    const result = subtractMasked(w(['/a/workspace', '/a/public', '/a/mounts'], ['/a/AGENTS.md']), {
      dirs: [],
      files: ['/a/.env', '/a/secrets.json'],
    })

    expect(result.dirs).toEqual(['/a/workspace', '/a/public', '/a/mounts'])
  })

  test('drops a writable path nested under a masked dir', () => {
    const result = subtractMasked(w(['/a/workspace/sub'], []), { dirs: ['/a/workspace'], files: [] })

    expect(result.dirs).toEqual([])
  })

  test('drops a writable file that is masked', () => {
    const result = subtractMasked(w([], ['/a/.env', '/a/AGENTS.md']), { dirs: [], files: ['/a/.env'] })

    expect(result.files).toEqual(['/a/AGENTS.md'])
  })

  test('does not drop a sibling that merely shares a masked prefix string', () => {
    const result = subtractMasked(w(['/a/workspace-public'], []), { dirs: ['/a/workspace'], files: [] })

    expect(result.dirs).toEqual(['/a/workspace-public'])
  })
})
