import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseLogOutput, readDreamCommitLog, readDreamCommitShow, resolveGitRepo } from './git'

let repo: string

const normalizePath = (s: string): string => s.split(/[\\/]/).join('/')

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
}

async function commit(cwd: string, subject: string): Promise<void> {
  await git(['add', '-A'], cwd)
  await git(['commit', '-m', subject], cwd)
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
  it('resolves the repo root from a subdirectory', async () => {
    const sub = join(repo, 'memory', 'topics')
    await mkdir(sub, { recursive: true })
    await writeFile(join(repo, 'README.md'), '# x\n')
    await commit(repo, 'init')

    const res = await resolveGitRepo(sub)
    expect(res.ok).toBe(true)
    // git canonicalizes the root (on macOS /var → /private/var), so assert the
    // resolved root is the git toplevel rather than byte-equal to the tmp path.
    if (res.ok) expect(normalizePath(res.root).endsWith(normalizePath(repo))).toBe(true)
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
})

describe('parseLogOutput', () => {
  it('drops malformed records', () => {
    const good = `abc\x1fab\x1f2026-06-14T00:00:00Z\x1fdream: 1 fragment\x1e`
    expect(parseLogOutput(`${good}incomplete-record`)).toEqual([
      { sha: 'abc', shortSha: 'ab', committedAt: '2026-06-14T00:00:00Z', subject: 'dream: 1 fragment' },
    ])
  })
})
