import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ContentPart, ToolResult } from '@/plugin'

import { checkUncommittedChangesAdvice, parsePorcelain, type UncommittedChangesDeps } from './uncommitted-changes'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-uncommitted-guard-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('parsePorcelain', () => {
  test('extracts paths from standard status lines', () => {
    expect(parsePorcelain(' M src/foo.ts\n?? src/bar.ts\nA  src/baz.ts\n')).toEqual([
      'src/foo.ts',
      'src/bar.ts',
      'src/baz.ts',
    ])
  })

  test('returns the destination path for renames', () => {
    expect(parsePorcelain('R  src/old.ts -> src/new.ts\n')).toEqual(['src/new.ts'])
  })
})

describe('checkUncommittedChangesAdvice', () => {
  test('does nothing for non-file-touching tools and never invokes git', async () => {
    await mkdir(join(agentDir, '.git'))
    const result = textResult('read output')
    const deps: UncommittedChangesDeps = {
      readStatus: async () => {
        throw new Error('readStatus must not be called for read-only tools')
      },
    }

    await checkUncommittedChangesAdvice({ tool: 'read', agentDir, result, deps })
    await checkUncommittedChangesAdvice({ tool: 'grep', agentDir, result, deps })

    expect(textOf(result)).toBe('read output')
  })

  test('does nothing when the directory is not a git repo', async () => {
    const result = textResult('wrote 3 lines')
    const deps: UncommittedChangesDeps = {
      readStatus: async () => {
        throw new Error('should not be called when no .git is present')
      },
    }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(textOf(result)).toBe('wrote 3 lines')
  })

  test('relocated .gitstore agent: still warns and threads --git-dir/--work-tree into status', async () => {
    // given: a monorepo member whose git db lives in .gitstore, not .git
    await mkdir(join(agentDir, '.gitstore'))
    let receivedGitArgs: readonly string[] | undefined
    const deps: UncommittedChangesDeps = {
      readStatus: async (_dir, gitArgs) => {
        receivedGitArgs = gitArgs
        return ['src/foo.ts']
      },
    }
    const result = textResult('wrote 3 lines')

    // when: a file-touching tool runs
    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    // then: the guard fires and passes the relocated git args to the status reader
    expect(textOf(result)).toContain('uncommittedChanges')
    expect(receivedGitArgs).toEqual(['--git-dir', join(agentDir, '.gitstore'), '--work-tree', agentDir])
  })

  test('does nothing when the worktree is clean', async () => {
    await mkdir(join(agentDir, '.git'))
    const result = textResult('wrote 3 lines')
    const deps: UncommittedChangesDeps = { readStatus: async () => [] }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(textOf(result)).toBe('wrote 3 lines')
  })

  test('does nothing when readStatus returns null (git failed)', async () => {
    await mkdir(join(agentDir, '.git'))
    const result = textResult('wrote 3 lines')
    const deps: UncommittedChangesDeps = { readStatus: async () => null }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(textOf(result)).toBe('wrote 3 lines')
  })

  test('appends advice when the worktree has agent-owned dirty files', async () => {
    await mkdir(join(agentDir, '.git'))
    const result = textResult('wrote 3 lines')
    const deps: UncommittedChangesDeps = { readStatus: async () => ['src/foo.ts'] }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(textOf(result)).toContain('wrote 3 lines')
    expect(textOf(result)).toContain('uncommittedChanges')
    expect(textOf(result)).toContain('uncommitted changes')
  })

  test('also runs after edit and bash, not only write', async () => {
    await mkdir(join(agentDir, '.git'))
    const deps: UncommittedChangesDeps = { readStatus: async () => ['src/foo.ts'] }

    const editResult = textResult('edit ok')
    await checkUncommittedChangesAdvice({ tool: 'edit', agentDir, result: editResult, deps })
    expect(textOf(editResult)).toContain('uncommittedChanges')

    const bashResult = textResult('bash ok')
    await checkUncommittedChangesAdvice({ tool: 'bash', agentDir, result: bashResult, deps })
    expect(textOf(bashResult)).toContain('uncommittedChanges')
  })

  test('does not warn when every dirty path is runtime-owned (sessions/, memory/)', async () => {
    await mkdir(join(agentDir, '.git'))
    const result = textResult('wrote 3 lines')
    const deps: UncommittedChangesDeps = {
      readStatus: async () => ['sessions/abc.jsonl', 'memory/2026-04-27.md'],
    }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(textOf(result)).toBe('wrote 3 lines')
  })

  test('warns when at least one dirty path is agent-owned, ignoring runtime-owned siblings', async () => {
    await mkdir(join(agentDir, '.git'))
    const result = textResult('wrote 3 lines')
    const deps: UncommittedChangesDeps = {
      readStatus: async () => ['sessions/abc.jsonl', 'src/foo.ts'],
    }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(textOf(result)).toContain('uncommittedChanges')
  })

  test('appends to the last text part when result has multiple text parts', async () => {
    await mkdir(join(agentDir, '.git'))
    const result: ToolResult = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'last' },
      ],
    }
    const deps: UncommittedChangesDeps = { readStatus: async () => ['src/foo.ts'] }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect((result.content[0] as { text: string }).text).toBe('first')
    expect((result.content[1] as { text: string }).text).toContain('last')
    expect((result.content[1] as { text: string }).text).toContain('uncommittedChanges')
  })

  test('adds a fresh text part when result has no text content', async () => {
    await mkdir(join(agentDir, '.git'))
    const result: ToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'x' }],
    }
    const deps: UncommittedChangesDeps = { readStatus: async () => ['src/foo.ts'] }

    await checkUncommittedChangesAdvice({ tool: 'write', agentDir, result, deps })

    expect(result.content).toHaveLength(2)
    expect(result.content[1]).toEqual({ type: 'text', text: expect.stringContaining('uncommittedChanges') })
  })
})

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function textOf(result: ToolResult): string {
  const part = result.content.find((p): p is ContentPart & { type: 'text' } => p.type === 'text')
  return part ? part.text : ''
}
