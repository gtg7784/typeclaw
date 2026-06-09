import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureGitAskPassHelper, resetGitAskPassHelperForTests } from './git-askpass'

afterEach(() => {
  resetGitAskPassHelperForTests()
})

async function tmpHelperPath() {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-askpass-'))
  return join(dir, 'typeclaw-git-askpass')
}

describe('ensureGitAskPassHelper', () => {
  test('writes the helper and returns its path', async () => {
    const path = await tmpHelperPath()
    expect(await ensureGitAskPassHelper(path)).toBe(path)
    expect((await stat(path)).isFile()).toBe(true)
  })

  test('helper content contains no token, only the env var name', async () => {
    const path = await tmpHelperPath()
    await ensureGitAskPassHelper(path)
    const content = await readFile(path, 'utf8')
    expect(content).toContain('TYPECLAW_GIT_TOKEN')
    expect(content).toContain('x-access-token')
    expect(content).not.toMatch(/gh[ps]_/)
  })

  test('concurrent calls share one write and resolve to the same path', async () => {
    const path = await tmpHelperPath()
    const [a, b] = await Promise.all([ensureGitAskPassHelper(path), ensureGitAskPassHelper(path)])
    expect(a).toBe(path)
    expect(b).toBe(path)
  })

  test('helper is executable', async () => {
    const path = await tmpHelperPath()
    await ensureGitAskPassHelper(path)
    const mode = (await stat(path)).mode & 0o111
    expect(mode).not.toBe(0)
  })
})
