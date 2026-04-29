import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  commitMemorySnapshot,
  createDreamingSpawner,
  type DreamingLogger,
  type DreamingSession,
  isDreamingPayload,
} from './dreaming'
import { DREAMING_STATE_FILE, loadDreamingState } from './dreaming-state'

const silentLogger: DreamingLogger = { info: () => {}, warn: () => {}, error: () => {} }

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-'))
  await mkdir(join(agentDir, 'memory'), { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function fakeSession(): DreamingSession & { prompts: string[]; disposed: boolean } {
  const prompts: string[] = []
  let disposed = false
  return {
    prompts,
    get disposed() {
      return disposed
    },
    prompt: async (text) => {
      prompts.push(text)
    },
    dispose: () => {
      disposed = true
    },
  }
}

describe('isDreamingPayload', () => {
  test('accepts a payload with agentDir', () => {
    expect(isDreamingPayload({ agentDir: '/some/path' })).toBe(true)
  })

  test('rejects null', () => {
    expect(isDreamingPayload(null)).toBe(false)
  })

  test('rejects an empty agentDir', () => {
    expect(isDreamingPayload({ agentDir: '' })).toBe(false)
  })

  test('rejects a non-string agentDir', () => {
    expect(isDreamingPayload({ agentDir: 42 })).toBe(false)
  })

  test('rejects a missing agentDir', () => {
    expect(isDreamingPayload({})).toBe(false)
  })
})

describe('createDreamingSpawner', () => {
  test('throws when payload is invalid', async () => {
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => fakeSession(),
      commitMemory: async () => {},
      logger: silentLogger,
    })
    await expect(spawner({ agentDir: '' }, 'dreaming')).rejects.toThrow(/invalid payload/)
  })

  test('skips dreaming entirely when no daily streams exist', async () => {
    const session = fakeSession()
    let committed = false
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {
        committed = true
      },
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    expect(session.prompts).toHaveLength(0)
    expect(session.disposed).toBe(false)
    expect(committed).toBe(false)
  })

  test('skips dreaming when every stream is already at the watermark (no new fragments)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'line 1\nline 2\nline 3\n')
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 3, ts: 'past' } } }),
    )
    const session = fakeSession()
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    expect(session.prompts).toHaveLength(0)
  })

  test('prompts subagent only with undreamed tails (read offsets reflect watermark)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'l1\nl2\nl3\nl4\nl5\n')
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 2, ts: 'past' } } }),
    )
    const session = fakeSession()
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    expect(session.prompts).toHaveLength(1)
    expect(session.prompts[0]).toContain('memory/2026-04-27.md')
    expect(session.prompts[0]).toContain('offset=3')
    expect(session.prompts[0]).toContain('total file lines=5')
    expect(session.prompts[0]).toContain('undreamed: 3-5')
  })

  test('advances watermarks to current line counts after a successful run', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'a\nb\nc\nd\n')
    const session = fakeSession()
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']?.lines).toBe(4)
  })

  test('passes multiple undreamed days oldest-first to the subagent', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-25.md'), 'older\n')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'newer\n')
    const session = fakeSession()
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    const prompt = session.prompts[0] ?? ''
    expect(prompt.indexOf('2026-04-25.md')).toBeGreaterThan(-1)
    expect(prompt.indexOf('2026-04-25.md')).toBeLessThan(prompt.indexOf('2026-04-27.md'))
  })

  test('calls commitMemory after the subagent finishes', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')
    const commits: string[] = []
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => fakeSession(),
      commitMemory: async (cwd) => {
        commits.push(cwd)
      },
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    expect(commits).toEqual([agentDir])
  })

  test('disposes the session even when prompt() throws (and still advances watermarks)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'oops\n')
    let disposed = false
    const session: DreamingSession = {
      prompt: async () => {
        throw new Error('LLM blew up')
      },
      dispose: () => {
        disposed = true
      },
    }
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await expect(spawner({ agentDir }, 'dreaming')).rejects.toThrow(/LLM blew up/)
    expect(disposed).toBe(true)
    // Failed runs do NOT advance the watermark — next run will retry the same
    // tail, which is the safer default than silently consolidating nothing.
    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']).toBeUndefined()
  })

  test('treats a hand-edited stream that shrank below its watermark as fully dreamed (no re-run)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'just one line\n')
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 99, ts: 'past' } } }),
    )
    const session = fakeSession()
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => session,
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    expect(session.prompts).toHaveLength(0)
    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']?.lines).toBe(99)
  })

  test('writes the dreaming state file under memory/.dreaming-state.json', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')
    const spawner = createDreamingSpawner({
      createDreamingSession: async () => fakeSession(),
      commitMemory: async () => {},
      logger: silentLogger,
    })

    await spawner({ agentDir }, 'dreaming')

    const raw = await readFile(join(agentDir, DREAMING_STATE_FILE), 'utf8')
    expect(raw).toContain('2026-04-27')
    expect(raw).toContain('"lines": 1')
  })
})

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  const stdout = (await new Response(proc.stdout).text()).trim()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

async function initRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['init', '-q', '-b', 'main'])
  await writeFile(join(cwd, '.gitignore'), 'memory/\n')
  await runGit(cwd, ['add', '.gitignore'])
  await runGit(cwd, ['commit', '-qm', 'init'])
}

async function trackedFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['ls-files', '--', 'MEMORY.md', 'memory/'])
  return result.stdout.length === 0 ? [] : result.stdout.split('\n').sort()
}

async function porcelainStatus(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['status', '--porcelain', '--', 'MEMORY.md', 'memory/'])
  return result.stdout
}

async function skipWorktreeFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['ls-files', '-v', '--', 'MEMORY.md', 'memory/'])
  if (result.stdout.length === 0) return []
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('S '))
    .map((line) => line.slice(2))
    .sort()
}

describe('commitMemorySnapshot', () => {
  test('is a no-op when the directory is not a git repo', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')
    await commitMemorySnapshot(agentDir)
    expect(await trackedFiles(agentDir)).toEqual([])
  })

  test('first run: force-adds memory artifacts, commits, and sets skip-worktree on tracked files', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['MEMORY.md', 'memory/2026-04-27.md'])
    expect(await skipWorktreeFiles(agentDir)).toEqual(['MEMORY.md', 'memory/2026-04-27.md'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('subsequent edits to tracked memory files do not appear in git status', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'first\n')
    await commitMemorySnapshot(agentDir)

    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'first\nsecond\n')
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory v2\n')

    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('subsequent run still picks up worktree changes despite skip-worktree (clears flag, commits, re-sets)', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), 'v1\n')
    await commitMemorySnapshot(agentDir)
    expect(await skipWorktreeFiles(agentDir)).toEqual(['MEMORY.md'])

    await writeFile(join(agentDir, 'MEMORY.md'), 'v2\n')
    await commitMemorySnapshot(agentDir)

    const log = await runGit(agentDir, ['log', '--oneline', '--', 'MEMORY.md'])
    expect(log.stdout.split('\n')).toHaveLength(2)
    const blob = await runGit(agentDir, ['show', 'HEAD:MEMORY.md'])
    expect(blob.stdout).toBe('v2')
    expect(await skipWorktreeFiles(agentDir)).toEqual(['MEMORY.md'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('a brand-new daily stream gets committed and skip-worktree-flagged on the run that first sees it', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'first day\n')
    await commitMemorySnapshot(agentDir)

    await writeFile(join(agentDir, 'memory', '2026-04-28.md'), 'second day\n')
    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['memory/2026-04-27.md', 'memory/2026-04-28.md'])
    expect(await skipWorktreeFiles(agentDir)).toEqual(['memory/2026-04-27.md', 'memory/2026-04-28.md'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('no-op run (nothing changed since last commit) leaves the flag set so status stays clean', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), 'stable\n')
    await commitMemorySnapshot(agentDir)
    const firstHead = (await runGit(agentDir, ['rev-parse', 'HEAD'])).stdout

    await commitMemorySnapshot(agentDir)
    const secondHead = (await runGit(agentDir, ['rev-parse', 'HEAD'])).stdout

    expect(secondHead).toBe(firstHead)
    expect(await skipWorktreeFiles(agentDir)).toEqual(['MEMORY.md'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })
})
