import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeSourceVersion, resolveSrcRoot, UNVERSIONED_SENTINEL, type VersionFs } from './version'

function fakeFs(files: Record<string, string>): VersionFs {
  const dirs = new Map<string, Set<string>>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/').filter((p) => p.length > 0)
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = '/' + parts.slice(0, i + 1).join('/')
      const parent = i === 0 ? '/' : '/' + parts.slice(0, i).join('/')
      const childOfParent = parts[i]!
      const parentSet = dirs.get(parent) ?? new Set<string>()
      parentSet.add(childOfParent)
      dirs.set(parent, parentSet)
      if (!dirs.has(dir)) dirs.set(dir, new Set<string>())
    }
    const fileDir = '/' + parts.slice(0, -1).join('/')
    const fileName = parts[parts.length - 1]!
    const set = dirs.get(fileDir) ?? new Set<string>()
    set.add(fileName)
    dirs.set(fileDir, set)
  }
  return {
    readdir: async (path) => {
      const children = dirs.get(path)
      if (!children) throw new Error(`ENOENT: ${path}`)
      return Array.from(children).map((name) => {
        const childPath = `${path}/${name}`
        return { name, isDirectory: dirs.has(childPath) }
      })
    },
    readFile: async (path) => {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return Buffer.from(content, 'utf8')
    },
  }
}

describe('computeSourceVersion', () => {
  test('produces a stable hash for identical input', async () => {
    const fs = fakeFs({
      '/src/a.ts': 'export const a = 1',
      '/src/b.ts': 'export const b = 2',
    })
    const v1 = await computeSourceVersion({ srcRoot: '/src', fs })
    const v2 = await computeSourceVersion({ srcRoot: '/src', fs })
    expect(v1).toBe(v2)
    expect(v1.length).toBe(32)
  })

  test('changes when any source byte changes', async () => {
    const original = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({ '/src/a.ts': 'export const a = 1' }),
    })
    const modified = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({ '/src/a.ts': 'export const a = 2' }),
    })
    expect(original).not.toBe(modified)
  })

  test('ignores test files', async () => {
    const withoutTests = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({ '/src/a.ts': 'export const a = 1' }),
    })
    const withTests = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({
        '/src/a.ts': 'export const a = 1',
        '/src/a.test.ts': 'test stuff',
      }),
    })
    expect(withoutTests).toBe(withTests)
  })

  test('ignores non-typescript files', async () => {
    const baseline = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({ '/src/a.ts': 'export const a = 1' }),
    })
    const withReadme = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({
        '/src/a.ts': 'export const a = 1',
        '/src/README.md': '# stuff',
      }),
    })
    expect(baseline).toBe(withReadme)
  })

  test('walks nested directories deterministically', async () => {
    const v1 = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({
        '/src/a.ts': '1',
        '/src/sub/b.ts': '2',
        '/src/sub/deeper/c.ts': '3',
      }),
    })
    const v2 = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({
        '/src/sub/deeper/c.ts': '3',
        '/src/sub/b.ts': '2',
        '/src/a.ts': '1',
      }),
    })
    expect(v1).toBe(v2)
  })

  test('moving content between files changes the hash (path is hashed)', async () => {
    const v1 = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({
        '/src/a.ts': 'foo',
        '/src/b.ts': 'bar',
      }),
    })
    const v2 = await computeSourceVersion({
      srcRoot: '/src',
      fs: fakeFs({
        '/src/a.ts': 'bar',
        '/src/b.ts': 'foo',
      }),
    })
    expect(v1).not.toBe(v2)
  })

  test('reads real filesystem when no fs is injected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-version-'))
    try {
      await mkdir(join(dir, 'sub'), { recursive: true })
      await writeFile(join(dir, 'a.ts'), 'export const a = 1')
      await writeFile(join(dir, 'sub', 'b.ts'), 'export const b = 2')
      await writeFile(join(dir, 'a.test.ts'), 'test')
      const hash = await computeSourceVersion({ srcRoot: dir })
      expect(hash.length).toBe(32)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveSrcRoot', () => {
  test('returns the src dir for a CLI entry inside src/', () => {
    expect(resolveSrcRoot('/home/x/typeclaw/src/cli/index.ts')).toBe('/home/x/typeclaw/src')
    expect(resolveSrcRoot('/home/x/typeclaw/src/hostd/spawn.ts')).toBe('/home/x/typeclaw/src')
  })

  test('returns null when no src/ ancestor exists', () => {
    expect(resolveSrcRoot('/usr/local/bin/typeclaw')).toBeNull()
    expect(resolveSrcRoot('/home/x/dist/index.js')).toBeNull()
  })
})

describe('UNVERSIONED_SENTINEL', () => {
  test('is a stable string both peers can compare', () => {
    expect(UNVERSIONED_SENTINEL).toBe('unversioned')
  })
})
