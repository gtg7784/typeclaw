import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveRequiredAgentDir } from './require-agent-dir'

describe('resolveRequiredAgentDir', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'typeclaw-require-agent-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('resolves the agent folder when typeclaw.json is present', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}')
    expect(resolveRequiredAgentDir(root)).toEqual({ ok: true, cwd: root })
  })

  test('walks up to the agent root from a nested subdirectory', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}')
    const sub = join(root, 'workspace', 'nested')
    await mkdir(sub, { recursive: true })
    expect(resolveRequiredAgentDir(sub)).toEqual({ ok: true, cwd: root })
  })

  test('fails when no typeclaw.json exists up the tree', () => {
    const result = resolveRequiredAgentDir(root)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/cd into an agent folder/)
  })

  test('fails at a non-agent project root marked by .git', async () => {
    await mkdir(join(root, '.git'))
    expect(resolveRequiredAgentDir(root).ok).toBe(false)
  })
})
