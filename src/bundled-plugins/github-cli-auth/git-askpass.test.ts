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

describe('ensureGitAskPassHelper — host-scoped behavior (executed)', () => {
  async function run(promptArg: string): Promise<{ code: number; out: string }> {
    const path = await tmpHelperPath()
    await ensureGitAskPassHelper(path)
    const proc = Bun.spawn({
      cmd: [path, promptArg],
      env: { TYPECLAW_GIT_TOKEN: 'ghs_secret_token' },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const code = await proc.exited
    const out = (await new Response(proc.stdout).text()).trim()
    return { code, out }
  }

  test('emits the token for a github.com password prompt', async () => {
    const { code, out } = await run("Password for 'https://github.com': ")
    expect(code).toBe(0)
    expect(out).toBe('ghs_secret_token')
  })

  test('emits x-access-token for a github.com username prompt', async () => {
    const { code, out } = await run("Username for 'https://github.com': ")
    expect(code).toBe(0)
    expect(out).toBe('x-access-token')
  })

  test('refuses (exit 1, no token) for a non-github host prompt', async () => {
    const { code, out } = await run("Password for 'https://evil.example': ")
    expect(code).toBe(1)
    expect(out).toBe('')
  })

  test('is not fooled by a lookalike host (evil-github.com)', async () => {
    const { out } = await run("Password for 'https://evil-github.com': ")
    expect(out).toBe('')
  })

  test('is not fooled by a suffix lookalike host (github.com.evil)', async () => {
    const { out } = await run("Password for 'https://github.com.evil.test': ")
    expect(out).toBe('')
  })
})
