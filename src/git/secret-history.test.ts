import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  GitSecretHistoryError,
  assertNoCanonicalSecretsInGit,
  resetGitSecretHistoryCacheForTests,
  scanCanonicalSecretsInGit,
} from './secret-history'

let roots: string[] = []

beforeEach(() => resetGitSecretHistoryCacheForTests())
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('canonical Git secret history guard', () => {
  test('leaves a clean repository unaffected', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('detects canonical files in the current index without reading their contents', async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, 'secrets.json'), '{"token":"example-placeholder"}')
    await git(repo, 'add', 'secrets.json')

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: false, paths: ['secrets.json'] })
  })

  test('rescans a previously clean repository and catches a newly dangling staged blob', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()

    await writeFile(join(repo, 'secrets.json'), '{"credential":"placeholder"}')
    await git(repo, 'add', 'secrets.json')
    await git(repo, 'reset', '--', 'secrets.json')
    await rm(join(repo, 'secrets.json'))

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(/unreachable|dangling/i)
  })

  test('rejects replacement refs even when a replacement commit hides a canonical secret path', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const cleanCommit = await gitOutput(repo, 'rev-parse', 'HEAD')
    await commitFile(repo, '.env', 'EXAMPLE_TOKEN=placeholder')
    const secretCommit = await gitOutput(repo, 'rev-parse', 'HEAD')
    await git(repo, 'replace', secretCommit, cleanCommit)

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(/replacement ref|rotate.*purge/i)
  })

  test('rejects an unreachable blob left by staging and resetting a canonical secret', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await writeFile(join(repo, 'auth.json'), '{"credential":"placeholder"}')
    await git(repo, 'add', 'auth.json')
    await git(repo, 'reset', '--', 'auth.json')
    await rm(join(repo, 'auth.json'))

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(/unreachable|dangling.*rotate.*gc/i)
  })

  test('detects a removed canonical file that remains reachable from history', async () => {
    const repo = await makeRepo()
    await commitFile(repo, '.env', 'EXAMPLE_TOKEN=placeholder')
    await rm(join(repo, '.env'))
    await git(repo, 'add', '.env')
    await git(repo, 'commit', '-m', 'remove example credential')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(GitSecretHistoryError)
  })

  test('decodes Git C-quoted historical paths before canonical matching', async () => {
    const repo = await makeRepo()
    const unusual = 'workspace/.agent-messenger/비밀.json'
    await commitFile(repo, unusual, '{"credential":"placeholder"}')
    await rm(join(repo, unusual))
    await git(repo, 'add', unusual)
    await git(repo, 'commit', '-m', 'remove unusual credential path')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(/workspace\/\.agent-messenger/i)
  })

  test('detects a canonical credential commit reachable only through a reflog as unreachable object contamination', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['dangling or unreachable Git objects'] })
  })

  test('handles linked worktrees whose .git entry is a file', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'auth.json', '{"credential":"placeholder"}')
    const worktree = `${repo}-worktree`
    roots.push(worktree)
    await git(repo, 'worktree', 'add', worktree)

    await expect(assertNoCanonicalSecretsInGit(worktree)).rejects.toThrow(/rotate.*purge.*reflog.*garbage collection/i)
  })

  test('allows a clean linked worktree whose .git entry is a file', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const worktree = `${repo}-clean-worktree`
    roots.push(worktree)
    await git(repo, 'worktree', 'add', worktree)

    await expect(assertNoCanonicalSecretsInGit(worktree)).resolves.toBeUndefined()
  })

  test('caches contamination fail-closed for the process lifetime', async () => {
    const repo = await makeRepo()
    await commitFile(repo, '.env', 'EXAMPLE_TOKEN=placeholder')
    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow()
    await git(repo, 'rm', '.env')
    await git(repo, 'commit', '-m', 'remove example credential')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')
    await git(repo, 'gc', '--prune=now')

    await expect(assertNoCanonicalSecretsInGit(repo)).rejects.toThrow(GitSecretHistoryError)
  })
})

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'typeclaw-git-secret-history-'))
  roots.push(repo)
  await git(repo, 'init')
  await git(repo, 'config', 'user.name', 'Test User')
  await git(repo, 'config', 'user.email', 'test@example.com')
  return repo
}

async function commitFile(repo: string, relative: string, content: string): Promise<void> {
  const target = join(repo, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  await git(repo, 'add', relative)
  await git(repo, 'commit', '-m', `add ${relative}`)
}

async function git(repo: string, ...args: string[]): Promise<void> {
  await gitOutput(repo, ...args)
}

async function gitOutput(repo: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${stderr}`)
  return stdout.trim()
}
