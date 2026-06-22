import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseLogOutput, readDreamCommitLog, readDreamCommitShow, resolveGitRepo } from './git'

let repo: string

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
}

async function commit(cwd: string, subject: string): Promise<void> {
  await git(['add', '-A'], cwd)
  await git(['commit', '-m', subject], cwd)
}

async function relocateGitStore(cwd: string): Promise<void> {
  await rename(join(cwd, '.git'), join(cwd, '.gitstore'))
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'typeclaw-dreams-git-'))
  await git(['init', '-q', '-b', 'main'], repo)
  await git(['config', 'user.email', 'test@example.com'], repo)
  await git(['config', 'user.name', 'Test User'], repo)
  await git(['config', 'commit.gpgsign', 'false'], repo)
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('resolveGitRepo', () => {
  it('resolves the repo root from an agent git directory', async () => {
    await writeFile(join(repo, 'README.md'), '# x\n')
    await commit(repo, 'init')

    const res = await resolveGitRepo(repo)
    expect(res.ok).toBe(true)
    // Resolve the root through git from both the subdirectory and the repo
    // root, then compare. Routing both sides through git applies the same
    // canonicalization (macOS /var → /private/var, Windows 8.3 short-name
    // expansion like RUNNER~1 → runneradmin), so the roots are byte-equal
    // without depending on realpathSync matching git's normalization per-OS.
    const fromRoot = await resolveGitRepo(repo)
    expect(fromRoot.ok).toBe(true)
    if (res.ok && fromRoot.ok) {
      expect(res.root).toBe(fromRoot.root)
      expect(res.gitArgs).toEqual([])
    }
  })

  it('does not walk up into a parent monorepo when the agent has no git layout', async () => {
    const child = join(repo, 'agents', 'bot')
    await mkdir(child, { recursive: true })
    await writeFile(join(repo, 'README.md'), '# parent\n')
    await commit(repo, 'init parent')

    const res = await resolveGitRepo(child)

    expect(res).toEqual({ ok: false, reason: 'not-a-repo' })
  })

  it('resolves a relocated gitstore at the agent directory', async () => {
    await writeFile(join(repo, 'README.md'), '# x\n')
    await commit(repo, 'init')
    await relocateGitStore(repo)

    const res = await resolveGitRepo(repo)

    expect(res).toEqual({ ok: true, root: repo, gitArgs: ['--git-dir', join(repo, '.gitstore'), '--work-tree', repo] })
  })

  it('reports not-a-repo outside any git tree', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'typeclaw-dreams-bare-'))
    try {
      const res = await resolveGitRepo(bare)
      expect(res).toEqual({ ok: false, reason: 'not-a-repo' })
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe('readDreamCommitLog', () => {
  it('lists only dream: commits, newest first', async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await commit(repo, 'feat: not a dream')
    await mkdir(join(repo, 'memory', 'streams'), { recursive: true })
    await writeFile(join(repo, 'memory', 'streams', '2026-06-14.jsonl'), '{}\n')
    await commit(repo, 'dream: 1 fragment 🌙')
    await writeFile(join(repo, 'memory', 'streams', '2026-06-14.jsonl'), '{}\n{}\n')
    await commit(repo, 'dream: 2 fragments 🧠')

    const commits = await readDreamCommitLog(repo)
    expect(commits.map((c) => c.subject)).toEqual(['dream: 2 fragments 🧠', 'dream: 1 fragment 🌙'])
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(c.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('lists dream commits from a relocated gitstore', async () => {
    await mkdir(join(repo, 'memory', 'streams'), { recursive: true })
    await writeFile(join(repo, 'memory', 'streams', '2026-06-14.jsonl'), '안녕\n')
    await commit(repo, 'dream: 1 fragment 🌙')
    await relocateGitStore(repo)

    const resolved = await resolveGitRepo(repo)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const commits = await readDreamCommitLog(resolved.root, {}, undefined, resolved.gitArgs)

    expect(commits.map((c) => c.subject)).toEqual(['dream: 1 fragment 🌙'])
  })

  it('honors the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await writeFile(join(repo, 'f.txt'), `${i}\n`)
      await commit(repo, `dream: ${i} fragments 💤`)
    }
    const commits = await readDreamCommitLog(repo, { limit: 2 })
    expect(commits).toHaveLength(2)
  })

  it('returns empty when there are no dream commits', async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await commit(repo, 'chore: nothing to dream about')
    expect(await readDreamCommitLog(repo)).toEqual([])
  })

  it('excludes a non-dream subject whose body contains a dream: line', async () => {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await git(['add', '-A'], repo)
    await git(['commit', '-m', 'feat: real subject', '-m', 'dream: 3 fragments 🌙'], repo)
    expect(await readDreamCommitLog(repo)).toEqual([])
  })

  it('applies the limit after the subject filter, not before', async () => {
    await writeFile(join(repo, 'real.txt'), 'x\n')
    await git(['add', '-A'], repo)
    await git(['commit', '-m', 'chore: impostor', '-m', 'dream: body line 💤'], repo)
    await writeFile(join(repo, 'd1.txt'), '1\n')
    await commit(repo, 'dream: 1 fragment 🧠')
    await writeFile(join(repo, 'd2.txt'), '2\n')
    await commit(repo, 'dream: 2 fragments ⭐')

    const limited = await readDreamCommitLog(repo, { limit: 2 })
    expect(limited.map((c) => c.subject)).toEqual(['dream: 2 fragments ⭐', 'dream: 1 fragment 🧠'])
  })
})

describe('readDreamCommitShow', () => {
  it('returns name-status and patch for a dream commit', async () => {
    await mkdir(join(repo, 'memory', 'topics'), { recursive: true })
    await writeFile(join(repo, 'memory', 'topics', 'deploy.md'), '## Deploy\n\nbody\n')
    await commit(repo, "dream: new skill 'x' ⭐")
    const head = await readDreamCommitLog(repo)
    const show = await readDreamCommitShow(repo, head[0]!.sha)
    expect(show).not.toBeNull()
    expect(show?.nameStatus).toContain('memory/topics/deploy.md')
    expect(show?.patch).toContain('+## Deploy')
  })

  it('returns name-status and patch from a relocated gitstore', async () => {
    await mkdir(join(repo, 'memory', 'topics'), { recursive: true })
    await writeFile(join(repo, 'memory', 'topics', 'deploy.md'), '## 배포\n\n본문\n')
    await commit(repo, 'dream: 1 fragment 🧠')
    await relocateGitStore(repo)
    const resolved = await resolveGitRepo(repo)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const head = await readDreamCommitLog(resolved.root, {}, undefined, resolved.gitArgs)
    const show = await readDreamCommitShow(resolved.root, head[0]!.sha, undefined, resolved.gitArgs)

    expect(show?.nameStatus).toContain('memory/topics/deploy.md')
    expect(show?.patch).toContain('+## 배포')
  })
})

describe('parseLogOutput', () => {
  it('drops malformed records', () => {
    const good = `abc\x1fab\x1f2026-06-14T00:00:00Z\x1fdream: 1 fragment\x1e`
    expect(parseLogOutput(`${good}incomplete-record`)).toEqual([
      { sha: 'abc', shortSha: 'ab', committedAt: '2026-06-14T00:00:00Z', subject: 'dream: 1 fragment' },
    ])
  })
})
