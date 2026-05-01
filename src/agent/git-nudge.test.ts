import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatNudge, parsePorcelain, renderGitNudge, type GitNudgeDeps } from './git-nudge'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-git-nudge-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('parsePorcelain', () => {
  test('extracts paths from standard status lines', () => {
    const out = parsePorcelain(' M src/foo.ts\n?? src/bar.ts\nA  src/baz.ts\n')
    expect(out).toEqual(['src/foo.ts', 'src/bar.ts', 'src/baz.ts'])
  })

  test('returns the destination path for renames', () => {
    const out = parsePorcelain('R  src/old.ts -> src/new.ts\n')
    expect(out).toEqual(['src/new.ts'])
  })

  test('ignores blank and too-short lines', () => {
    const out = parsePorcelain('\n M\n M ok.ts\n')
    expect(out).toEqual(['ok.ts'])
  })

  test('handles a trailing newline without producing an empty entry', () => {
    const out = parsePorcelain(' M a.ts\n M b.ts\n')
    expect(out).toEqual(['a.ts', 'b.ts'])
  })
})

describe('formatNudge', () => {
  test('renders a single-file count grammatically', () => {
    const text = formatNudge(['src/foo.ts'])
    expect(text).toContain('1 uncommitted file ')
    expect(text).toContain('- src/foo.ts')
  })

  test('renders a plural count grammatically', () => {
    const text = formatNudge(['a.ts', 'b.ts'])
    expect(text).toContain('2 uncommitted files ')
  })

  test('lists up to ten paths inline and summarizes the rest', () => {
    const paths = Array.from({ length: 13 }, (_, i) => `src/file-${i}.ts`)
    const text = formatNudge(paths)
    expect(text).toContain('13 uncommitted files')
    expect(text).toContain('- src/file-0.ts')
    expect(text).toContain('- src/file-9.ts')
    expect(text).not.toContain('- src/file-10.ts')
    expect(text).toContain('… and 3 more')
  })

  test('does not add a "and N more" line when the list fits', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `f-${i}.ts`)
    const text = formatNudge(paths)
    expect(text).not.toContain('and 0 more')
    expect(text).not.toContain('… and')
  })

  test('starts with a markdown section header that mirrors system-prompt style', () => {
    const text = formatNudge(['x.ts'])
    expect(text.startsWith('## Uncommitted changes at session start')).toBe(true)
  })
})

describe('renderGitNudge', () => {
  test('returns empty string when the directory is not a git repo', async () => {
    const deps: GitNudgeDeps = {
      readStatus: async () => {
        throw new Error('should not be called when no .git is present')
      },
    }
    const text = await renderGitNudge(agentDir, deps)
    expect(text).toBe('')
  })

  test('returns empty string when the worktree is clean', async () => {
    await mkdir(join(agentDir, '.git'))
    const deps: GitNudgeDeps = { readStatus: async () => [] }
    const text = await renderGitNudge(agentDir, deps)
    expect(text).toBe('')
  })

  test('returns empty string when readStatus signals failure (null)', async () => {
    await mkdir(join(agentDir, '.git'))
    const deps: GitNudgeDeps = { readStatus: async () => null }
    const text = await renderGitNudge(agentDir, deps)
    expect(text).toBe('')
  })

  test('renders a nudge listing the dirty paths when the worktree is dirty', async () => {
    await mkdir(join(agentDir, '.git'))
    const deps: GitNudgeDeps = { readStatus: async () => ['src/foo.ts', 'src/bar.ts'] }
    const text = await renderGitNudge(agentDir, deps)
    expect(text).toContain('2 uncommitted files')
    expect(text).toContain('- src/foo.ts')
    expect(text).toContain('- src/bar.ts')
  })

  test('drops paths under sessions/ and memory/ from the nudge', async () => {
    await mkdir(join(agentDir, '.git'))
    const deps: GitNudgeDeps = {
      readStatus: async () => ['sessions/abc.jsonl', 'memory/2026-04-27.md', 'src/foo.ts'],
    }
    const text = await renderGitNudge(agentDir, deps)
    expect(text).toContain('1 uncommitted file ')
    expect(text).toContain('- src/foo.ts')
    expect(text).not.toContain('sessions/abc.jsonl')
    expect(text).not.toContain('memory/2026-04-27.md')
  })

  test('returns empty string when every dirty path is runtime-owned', async () => {
    await mkdir(join(agentDir, '.git'))
    const deps: GitNudgeDeps = {
      readStatus: async () => ['sessions/abc.jsonl', 'memory/2026-04-27.md'],
    }
    const text = await renderGitNudge(agentDir, deps)
    expect(text).toBe('')
  })
})
