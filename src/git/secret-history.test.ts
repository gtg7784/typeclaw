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

  test('detects a canonical credential commit left unreachable by a hard reset by its path', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('detects a canonical credential in an unreachable commit after its reflog is expired', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('allows benign unreachable commits left by an amend', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await writeFile(join(repo, 'README.md'), 'safer')
    await git(repo, 'add', 'README.md')
    await git(repo, 'commit', '--amend', '-m', 'safe amended')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('allows benign unreachable commits and reflog remnants left by a hard reset', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('rejects an orphan tree whose only entry is an innocuous name as unattributable', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, '{"credential":"placeholder"}', 'hash-object', '-w', '--stdin')
    await gitStdin(repo, `100644 blob ${blob}\trandom-session-id\n`, 'mktree')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['unattributable dangling Git objects'] })
  })

  test('rejects an orphan tree even when it carries a canonical secret filename', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, '{"credential":"placeholder"}', 'hash-object', '-w', '--stdin')
    await gitStdin(repo, `100644 blob ${blob}\tsecrets.json\n`, 'mktree')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['unattributable dangling Git objects'] })
  })

  test('rejects a bare dangling blob as unattributable', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await gitStdin(repo, 'bare secret bytes with no referencing tree', 'hash-object', '-w', '--stdin')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['unattributable dangling Git objects'] })
  })

  test('attributes a canonical secret through an unreachable tag that peels to a commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'tag', '-a', 'snapshot', '-m', 'snapshot')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'tag', '-d', 'snapshot')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('allows an unreachable tag that peels to a benign commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'tag', '-a', 'snapshot', '-m', 'snapshot')
    await git(repo, 'reset', '--hard', 'HEAD^')
    await git(repo, 'tag', '-d', 'snapshot')
    await git(repo, 'reflog', 'expire', '--expire=now', '--all')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('rejects an unreachable tag pointing directly at a tree as unattributable', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, 'notes', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')
    await git(repo, 'tag', '-a', 'treetag', '-m', 'tree tag', tree)
    await git(repo, 'tag', '-d', 'treetag')

    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['unattributable dangling Git objects'] })
  })

  test('rejects a canonical blob a reflog conceals from unreachable fsck', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await writeFile(join(repo, '.env'), 'EXAMPLE_TOKEN=placeholder')
    await git(repo, 'add', '.env')
    const blob = await gitOutput(repo, 'rev-parse', ':.env')
    await git(repo, 'reset', '--', '.env')
    await rm(join(repo, '.env'))
    await git(repo, 'update-ref', '--create-reflog', 'refs/test/reflog-root', blob)
    await git(repo, 'update-ref', 'refs/test/reflog-root', 'HEAD')

    const honored = await gitOutput(repo, 'fsck', '--unreachable', '--no-progress')
    expect(honored).not.toContain(blob)
    const bare = await gitOutput(repo, 'fsck', '--unreachable', '--no-reflogs', '--no-progress')
    expect(bare).toContain(`unreachable blob ${blob}`)

    expect(await scanCanonicalSecretsInGit(repo)).toEqual({ ok: false, paths: ['unattributable dangling Git objects'] })
  })

  test('detects a canonical path in an unexpired reflog-only commit via the reflog scan', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'workspace/.agent-messenger/session.json', '{"credential":"placeholder"}')
    await git(repo, 'reset', '--hard', 'HEAD^')

    const honored = await gitOutput(repo, 'fsck', '--unreachable', '--no-progress')
    expect(honored.trim()).toBe('')
    const result = await scanCanonicalSecretsInGit(repo)
    expect(result).toEqual({ ok: false, paths: ['workspace/.agent-messenger/session.json'] })
  })

  test('allows a benign reflog-only commit left by a reset', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    await commitFile(repo, 'docs/guide.md', 'more safe content')
    await git(repo, 'reset', '--hard', 'HEAD^')

    await expect(assertNoCanonicalSecretsInGit(repo)).resolves.toBeUndefined()
  })

  test('rejects live refs that point at or peel to a non-commit', async () => {
    const repo = await makeRepo()
    await commitFile(repo, 'README.md', 'safe')
    const blob = await gitStdin(repo, '{"credential":"placeholder"}', 'hash-object', '-w', '--stdin')
    const tree = await gitStdin(repo, `100644 blob ${blob}\tNOTES.md\n`, 'mktree')

    for (const [ref, oid] of [
      ['refs/test/blob', blob],
      ['refs/test/tree', tree],
    ] as const) {
      await git(repo, 'update-ref', ref, oid)
      expect(await scanCanonicalSecretsInGit(repo)).toEqual({
        ok: false,
        paths: ['unattributable dangling Git objects'],
      })
      await git(repo, 'update-ref', '-d', ref)
    }

    await git(repo, 'tag', '-a', 'blobtag', '-m', 'x', blob)
    expect(await scanCanonicalSecretsInGit(repo)).toEqual({
      ok: false,
      paths: ['unattributable dangling Git objects'],
    })
    await git(repo, 'tag', '-d', 'blobtag')
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

async function gitStdin(repo: string, stdin: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${stderr}`)
  return stdout.trim()
}
