import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hydrateDream, listDreams, runDreams } from './index'

let repo: string

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`)
}

async function dreamCommit(subject: string, fragments: string[], topics: Record<string, string>): Promise<void> {
  await mkdir(join(repo, 'memory', 'streams'), { recursive: true })
  if (fragments.length > 0) {
    await writeFile(join(repo, 'memory', 'streams', '2026-06-14.jsonl'), `${fragments.join('\n')}\n`)
  }
  for (const [slug, body] of Object.entries(topics)) {
    await mkdir(join(repo, 'memory', 'topics'), { recursive: true })
    await writeFile(join(repo, 'memory', 'topics', `${slug}.md`), body)
  }
  await git(['add', '-A'], repo)
  await git(['commit', '-m', subject], repo)
}

function fragment(id: string, topic: string, body: string): string {
  return JSON.stringify({
    type: 'fragment',
    id,
    ts: '2026-06-14T18:42:03.000Z',
    source: 'tui',
    entry: 'e',
    topic,
    body,
  })
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'typeclaw-dreams-idx-'))
  await git(['init', '-q', '-b', 'main'], repo)
  await git(['config', 'user.email', 'test@example.com'], repo)
  await git(['config', 'user.name', 'Test User'], repo)
  await git(['config', 'commit.gpgsign', 'false'], repo)
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('listDreams', () => {
  it('returns subject-level entries without hydrating detail', async () => {
    await dreamCommit('dream: 1 fragment 🌙', [fragment('019e-id', 'deploy', 'body')], { deploy: '## Deploy\nx\n' })
    const entries = await listDreams(repo)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.summary).toBe('1 fragment')
    expect(entries[0]?.emoji).toBe('🌙')
    expect(entries[0]?.detail).toBeUndefined()
  })

  it('returns empty for a non-git directory without throwing', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'typeclaw-dreams-nogit-'))
    try {
      expect(await listDreams(bare)).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe('hydrateDream', () => {
  it('parses the selected commit diff into detail', async () => {
    await dreamCommit("dream: 1 fragment + new skill 'x' 🧠", [fragment('frag-1', 'deploy', 'always typecheck')], {
      'release-process': '## Release\nbody\n',
    })
    await mkdir(join(repo, 'memory', 'skills', 'x'), { recursive: true })
    await writeFile(join(repo, 'memory', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\nbody\n')
    await git(['add', '-A'], repo)
    await git(['commit', '--amend', '--no-edit'], repo)

    const [entry] = await listDreams(repo)
    const hydrated = await hydrateDream(repo, entry!)
    expect(hydrated.detail?.addedFragments[0]).toMatchObject({
      id: 'frag-1',
      topic: 'deploy',
      streamDate: '2026-06-14',
    })
    expect(hydrated.detail?.changedTopics.some((t) => t.slug === 'release-process')).toBe(true)
    expect(hydrated.detail?.createdSkills).toEqual([{ name: 'x', path: 'memory/skills/x/SKILL.md' }])
  })
})

describe('runDreams', () => {
  it('errors with a friendly reason outside a git repo', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'typeclaw-dreams-err-'))
    try {
      const out: string[] = []
      const result = await runDreams({
        agentDir: bare,
        json: false,
        details: false,
        color: false,
        selectDream: async () => null,
        stdout: (l) => out.push(l),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('Not a git repository')
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('emits subject-level JSON in --json mode without detail', async () => {
    await dreamCommit('dream: 2 fragments 💤', [fragment('a', 't', 'b'), fragment('c', 't', 'd')], {})
    const out: string[] = []
    await runDreams({
      agentDir: repo,
      json: true,
      details: false,
      color: false,
      selectDream: async () => null,
      stdout: (l) => out.push(l),
    })
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0]!)
    expect(parsed.summary).toBe('2 fragments')
    expect(parsed.detail).toBeUndefined()
  })

  it('hydrates each dream in --json --details mode', async () => {
    await dreamCommit('dream: 1 fragment 🌙', [fragment('frag-9', 'deploy', 'always typecheck')], {})
    const out: string[] = []
    await runDreams({
      agentDir: repo,
      json: true,
      details: true,
      color: false,
      selectDream: async () => null,
      stdout: (l) => out.push(l),
    })
    const parsed = JSON.parse(out[0]!)
    expect(parsed.detail.addedFragments[0].id).toBe('frag-9')
  })
})
