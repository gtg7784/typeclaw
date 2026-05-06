import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'

import {
  commitMemorySnapshot,
  createDreamingSubagent,
  type DreamingLogger,
  type DreamingPayload,
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

type CapturedRunSession = {
  prompts: string[]
  runSession: RunSession
}

function captureRunSession(): CapturedRunSession {
  const prompts: string[] = []
  const runSession: RunSession = async (override) => {
    if (override?.userPrompt !== undefined) prompts.push(override.userPrompt)
  }
  return { prompts, runSession }
}

async function invokeDreaming(
  agentDir: string,
  options: {
    commitMemory?: (cwd: string) => Promise<void>
    logger?: DreamingLogger
    runSession?: RunSession
    throwOnRunSession?: boolean
  } = {},
): Promise<{ prompts: string[] }> {
  const subagent = createDreamingSubagent({
    commitMemory: options.commitMemory ?? (async () => {}),
    logger: options.logger ?? silentLogger,
  })
  const captured = captureRunSession()
  const runSession = options.throwOnRunSession
    ? async () => {
        throw new Error('LLM blew up')
      }
    : (options.runSession ?? captured.runSession)

  const ctx: SubagentContext<DreamingPayload> = {
    userPrompt: '',
    agentDir,
    payload: { agentDir },
  }
  await subagent.handler!(ctx, runSession)
  return { prompts: captured.prompts }
}

describe('isDreamingPayload', () => {
  test('accepts a payload with agentDir', () => {
    expect(isDreamingPayload({ agentDir: '/some/path' })).toBe(true)
  })

  test('rejects null and missing/empty agentDir', () => {
    expect(isDreamingPayload(null)).toBe(false)
    expect(isDreamingPayload({})).toBe(false)
    expect(isDreamingPayload({ agentDir: '' })).toBe(false)
    expect(isDreamingPayload({ agentDir: 42 })).toBe(false)
  })
})

describe('dreaming subagent declarations', () => {
  test('declares an inFlightKey that keys on agentDir', () => {
    const sub = createDreamingSubagent()
    expect(sub.inFlightKey).toBeDefined()
    expect(sub.inFlightKey!({ agentDir: '/x' })).toBe('/x')
  })

  test('does not register custom tools — dreaming uses only built-in read/write/ls', () => {
    const sub = createDreamingSubagent()
    expect(sub.customTools).toBeUndefined()
  })

  test('teaches the dreaming session about muscle memory in the system prompt', () => {
    const sub = createDreamingSubagent()
    expect(sub.systemPrompt).toContain('Muscle memory')
    expect(sub.systemPrompt).toContain('memory/skills/<name>/SKILL.md')
    expect(sub.systemPrompt).toMatch(/name:\s*<name>/)
    expect(sub.systemPrompt).toMatch(/description:\s+/)
    expect(sub.systemPrompt).toContain('source: muscle-memory')
  })

  test('teaches the dreaming session that muscle memory has three forms (skill, CLI, plugin)', () => {
    const sub = createDreamingSubagent()
    // Three forms named explicitly so the model picks the smallest fit.
    expect(sub.systemPrompt).toMatch(/Form A.*skill/i)
    expect(sub.systemPrompt).toMatch(/Form B.*CLI/i)
    expect(sub.systemPrompt).toMatch(/Form C.*plugin/i)
    // Suggestion target lives under packages/ — wired to typeclaw-monorepo.
    expect(sub.systemPrompt).toContain('packages/<name>')
    // `proposal:` line is the wire format the main agent reads on every prompt.
    expect(sub.systemPrompt).toContain('proposal: cli packages/<name>')
    expect(sub.systemPrompt).toContain('proposal: plugin packages/<name>')
    // Sandbox boundary must stay explicit so the model does not try to write
    // under packages/ itself (its tools have no policy enforcement).
    expect(sub.systemPrompt).toMatch(/cannot write under .*packages\//)
  })
})

describe('dreaming subagent (orchestration)', () => {
  test('skips dreaming entirely when no daily streams exist', async () => {
    let committed = false
    const { prompts } = await invokeDreaming(agentDir, {
      commitMemory: async () => {
        committed = true
      },
    })

    expect(prompts).toHaveLength(0)
    expect(committed).toBe(false)
  })

  test('skips dreaming when every stream is already at the watermark', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'line 1\nline 2\nline 3\n')
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 3, ts: 'past' } } }),
    )

    const { prompts } = await invokeDreaming(agentDir)
    expect(prompts).toHaveLength(0)
  })

  test('prompts subagent only with undreamed tails (read offsets reflect watermark)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'l1\nl2\nl3\nl4\nl5\n')
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 2, ts: 'past' } } }),
    )

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('memory/2026-04-27.md')
    expect(prompts[0]).toContain('offset=3')
    expect(prompts[0]).toContain('total file lines=5')
    expect(prompts[0]).toContain('undreamed: 3-5')
  })

  test('advances watermarks to current line counts after a successful run', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'a\nb\nc\nd\n')

    await invokeDreaming(agentDir)

    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']?.lines).toBe(4)
  })

  test('passes multiple undreamed days oldest-first to the subagent', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-25.md'), 'older\n')
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'newer\n')

    const { prompts } = await invokeDreaming(agentDir)

    const prompt = prompts[0] ?? ''
    expect(prompt.indexOf('2026-04-25.md')).toBeGreaterThan(-1)
    expect(prompt.indexOf('2026-04-25.md')).toBeLessThan(prompt.indexOf('2026-04-27.md'))
  })

  test('calls commitMemory after the subagent finishes', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')
    const commits: string[] = []

    await invokeDreaming(agentDir, {
      commitMemory: async (cwd) => {
        commits.push(cwd)
      },
    })

    expect(commits).toEqual([agentDir])
  })

  test('does NOT advance watermarks when prompt() throws', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'oops\n')

    await expect(invokeDreaming(agentDir, { throwOnRunSession: true })).rejects.toThrow(/LLM blew up/)
    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']).toBeUndefined()
  })

  test('treats a hand-edited stream that shrank below its watermark as fully dreamed (no re-run)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'just one line\n')
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 99, ts: 'past' } } }),
    )

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts).toHaveLength(0)
    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']?.lines).toBe(99)
  })

  test('writes the dreaming state file under memory/.dreaming-state.json', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')

    await invokeDreaming(agentDir)

    const raw = await readFile(join(agentDir, DREAMING_STATE_FILE), 'utf8')
    expect(raw).toContain('2026-04-27')
    expect(raw).toContain('"lines": 1')
  })

  test('creates MEMORY.md if missing on first dreaming run (replaces init scaffold)', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'fragment\n')
    await expect(readFile(join(agentDir, 'MEMORY.md'), 'utf8')).rejects.toThrow()

    await invokeDreaming(agentDir)

    const memory = await readFile(join(agentDir, 'MEMORY.md'), 'utf8')
    expect(memory).toBe('')
  })

  test('emits [dreaming] start, watermark-advanced, and done log lines on a successful run', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'one\ntwo\nthree\n')
    const infos: string[] = []
    const logger: DreamingLogger = { info: (m) => infos.push(m), warn: () => {}, error: () => {} }

    await invokeDreaming(agentDir, { commitMemory: async () => {}, logger })

    expect(
      infos.some((m) => m.startsWith('[dreaming] start') && m.includes('days=1') && m.includes('undreamed_lines=3')),
    ).toBe(true)
    expect(infos.some((m) => m.startsWith('[dreaming] watermarks advanced'))).toBe(true)
    expect(infos.some((m) => m.startsWith('[dreaming] done'))).toBe(true)
  })

  test('emits a [dreaming] commit-failed warning when commitMemory throws but does not rethrow', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'frag\n')
    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await invokeDreaming(agentDir, {
      logger,
      commitMemory: async () => {
        throw new Error('git is angry')
      },
    })

    expect(warnings.some((m) => m.startsWith('[dreaming] commit failed') && m.includes('git is angry'))).toBe(true)
  })

  test('emits a [dreaming] run-threw warning and rethrows when runSession fails', async () => {
    await writeFile(join(agentDir, 'memory', '2026-04-27.md'), 'frag\n')
    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await expect(invokeDreaming(agentDir, { throwOnRunSession: true, logger })).rejects.toThrow(/LLM blew up/)
    expect(warnings.some((m) => m.startsWith('[dreaming] run threw') && m.includes('LLM blew up'))).toBe(true)
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

  test('captures muscle-memory skills under memory/skills/<name>/SKILL.md (recursively under memory/)', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await mkdir(join(agentDir, 'memory', 'skills', 'release-checklist'), { recursive: true })
    await writeFile(
      join(agentDir, 'memory', 'skills', 'release-checklist', 'SKILL.md'),
      '---\nname: release-checklist\n---\n# Release\n',
    )

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['MEMORY.md', 'memory/skills/release-checklist/SKILL.md'])
    expect(await skipWorktreeFiles(agentDir)).toEqual(['MEMORY.md', 'memory/skills/release-checklist/SKILL.md'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })
})
