import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ToolContext } from '@/plugin'

import { createWriteReportTool } from './write-report'

let agentDir: string
let workspaceDir: string
let publicDir: string
let sessionCounter = 0

function makeCtx(): ToolContext {
  sessionCounter += 1
  return {
    signal: undefined,
    sessionId: `ses_${sessionCounter}_${Math.random().toString(36).slice(2)}`,
    agentDir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

beforeEach(async () => {
  agentDir = await mkdtemp(path.join(tmpdir(), 'researcher-report-'))
  workspaceDir = path.join(agentDir, 'workspace')
  publicDir = path.join(agentDir, 'public')
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(publicDir, { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('write_report tool — happy path', () => {
  test('writes a valid report under workspace/ and reports the path + bytes', async () => {
    const tool = createWriteReportTool()
    const target = path.join(workspaceDir, 'research-market-x-20260605-141500.md')
    const body = '# Research\n\nfindings.'

    const result = await tool.execute({ path: target, content: body }, makeCtx())

    expect(await readFile(target, 'utf8')).toBe(body)
    expect(result.content[0]?.type).toBe('text')
    expect((result.details as { path: string }).path).toBe(target)
    expect((result.details as { bytes: number }).bytes).toBe(body.length)
  })

  test('writes a valid report under public/ (the untrusted-caller fallback location)', async () => {
    const tool = createWriteReportTool()
    const target = path.join(publicDir, 'research-history-y.md')

    await tool.execute({ path: target, content: 'report' }, makeCtx())

    expect(await readFile(target, 'utf8')).toBe('report')
  })
})

describe('write_report tool — path boundary enforcement', () => {
  test('rejects a basename that is not research-<slug>.md', async () => {
    const tool = createWriteReportTool()
    const target = path.join(workspaceDir, 'notes.md')
    await expect(tool.execute({ path: target, content: 'x' }, makeCtx())).rejects.toThrow(/research-<slug>\.md/)
  })

  test('rejects an uppercase slug (slug must be lowercase letters/digits/hyphens)', async () => {
    const tool = createWriteReportTool()
    const target = path.join(workspaceDir, 'research-MarketX.md')
    await expect(tool.execute({ path: target, content: 'x' }, makeCtx())).rejects.toThrow(/research-<slug>\.md/)
  })

  test('rejects a nested path under workspace/ (no subdirectories)', async () => {
    const tool = createWriteReportTool()
    const target = path.join(workspaceDir, 'sub', 'research-x.md')
    await expect(tool.execute({ path: target, content: 'x' }, makeCtx())).rejects.toThrow(/directly under/)
  })

  test('rejects a write outside workspace/ and public/ (e.g. the agent root)', async () => {
    const tool = createWriteReportTool()
    const target = path.join(agentDir, 'research-x.md')
    await expect(tool.execute({ path: target, content: 'x' }, makeCtx())).rejects.toThrow(/directly under/)
  })

  test('rejects a traversal whose research-*.md basename passes the regex but whose parent is the agent root', async () => {
    const tool = createWriteReportTool()
    const target = path.join(workspaceDir, '..', 'research-x.md')
    await expect(tool.execute({ path: target, content: 'x' }, makeCtx())).rejects.toThrow(/directly under/)
  })
})

describe('write_report tool — symlink and overwrite defenses', () => {
  test('rejects overwriting an existing file (O_EXCL, no clobber)', async () => {
    const tool = createWriteReportTool()
    const target = path.join(workspaceDir, 'research-x.md')
    await writeFile(target, 'original')

    await expect(tool.execute({ path: target, content: 'overwrite' }, makeCtx())).rejects.toThrow(/already exists/)
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  test('rejects a final-path symlink instead of following it (O_EXCL on the symlink)', async () => {
    const tool = createWriteReportTool()
    const secret = path.join(agentDir, 'secret.txt')
    await writeFile(secret, 'secret')
    const link = path.join(workspaceDir, 'research-x.md')
    await symlink(secret, link)

    await expect(tool.execute({ path: link, content: 'pwned' }, makeCtx())).rejects.toThrow()
    expect(await readFile(secret, 'utf8')).toBe('secret')
  })

  test('rejects a report whose parent is a symlink pointing outside the allowed dirs', async () => {
    const tool = createWriteReportTool()
    const sensitive = path.join(agentDir, 'sensitive')
    await mkdir(sensitive, { recursive: true })
    const link = path.join(workspaceDir, 'escape')
    await symlink(sensitive, link)

    const target = path.join(link, 'research-x.md')
    await expect(tool.execute({ path: target, content: 'x' }, makeCtx())).rejects.toThrow(
      /directly under|resolves outside/,
    )
  })
})

describe('write_report tool — one report per session', () => {
  test('rejects a second write in the same session', async () => {
    const tool = createWriteReportTool()
    const ctx = makeCtx()
    await tool.execute({ path: path.join(workspaceDir, 'research-a.md'), content: 'a' }, ctx)

    await expect(tool.execute({ path: path.join(workspaceDir, 'research-b.md'), content: 'b' }, ctx)).rejects.toThrow(
      /already been written/,
    )
  })

  test('a failed write does NOT consume the session budget (can retry with a valid path)', async () => {
    const tool = createWriteReportTool()
    const ctx = makeCtx()
    await expect(tool.execute({ path: path.join(workspaceDir, 'bad.md'), content: 'x' }, ctx)).rejects.toThrow()

    // The rejected attempt must not have burned the one-write budget.
    const ok = await tool.execute({ path: path.join(workspaceDir, 'research-ok.md'), content: 'ok' }, ctx)
    expect((ok.details as { path: string }).path).toBe(path.join(workspaceDir, 'research-ok.md'))
  })

  test('different sessions each get their own one-write budget', async () => {
    const tool = createWriteReportTool()
    await tool.execute({ path: path.join(workspaceDir, 'research-s1.md'), content: '1' }, makeCtx())
    // A different session (different sessionId) is unaffected.
    const ok = await tool.execute({ path: path.join(workspaceDir, 'research-s2.md'), content: '2' }, makeCtx())
    expect((ok.details as { bytes: number }).bytes).toBe(1)
  })
})

describe('write_report tool — strict schema', () => {
  test('rejects an acknowledgeGuards field (strict schema, no silent bypass channel)', () => {
    const tool = createWriteReportTool()
    const parsed = tool.parameters.safeParse({
      path: path.join(workspaceDir, 'research-x.md'),
      content: 'x',
      acknowledgeGuards: { nonWorkspaceWrite: true },
    })
    expect(parsed.success).toBe(false)
  })

  test('requires both path and content', () => {
    const tool = createWriteReportTool()
    expect(tool.parameters.safeParse({ path: '/x' }).success).toBe(false)
    expect(tool.parameters.safeParse({ content: 'x' }).success).toBe(false)
    expect(tool.parameters.safeParse({ path: '/agent/workspace/research-x.md', content: 'x' }).success).toBe(true)
  })
})
