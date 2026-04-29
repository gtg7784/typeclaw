import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'

import { appendTool } from './append-tool'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'memory-append-'))
}

const ctx: ToolContext = {
  signal: undefined,
  sessionId: 'test',
  agentDir: '/tmp',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

async function call(path: string, content: string): Promise<void> {
  await appendTool.execute({ path, content }, ctx)
}

describe('appendTool', () => {
  test('creates the file when it does not exist', async () => {
    const root = tmpRoot()
    const path = join(root, 'memory', '2026-04-27.md')

    await call(path, 'first line\n')

    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('first line\n')
  })

  test('creates parent directories as needed', async () => {
    const root = tmpRoot()
    const path = join(root, 'a', 'b', 'c', 'file.md')

    await call(path, 'hello\n')

    expect(readFileSync(path, 'utf8')).toBe('hello\n')
  })

  test('appends to an existing file without truncating prior content', async () => {
    const root = tmpRoot()
    const path = join(root, 'log.md')
    writeFileSync(path, 'previous content\n')

    await call(path, 'new content\n')

    expect(readFileSync(path, 'utf8')).toBe('previous content\nnew content\n')
  })

  test('does not add a leading newline when the file is empty', async () => {
    const root = tmpRoot()
    const path = join(root, 'empty.md')
    writeFileSync(path, '')

    await call(path, 'first\n')

    expect(readFileSync(path, 'utf8')).toBe('first\n')
  })

  test('does not add a leading newline when the existing file already ends in newline', async () => {
    const root = tmpRoot()
    const path = join(root, 'log.md')
    writeFileSync(path, 'a\n')

    await call(path, 'b\n')

    expect(readFileSync(path, 'utf8')).toBe('a\nb\n')
  })

  test('inserts a leading newline when the existing file does NOT end in a newline', async () => {
    const root = tmpRoot()
    const path = join(root, 'log.md')
    writeFileSync(path, 'no trailing newline')

    await call(path, 'second\n')

    expect(readFileSync(path, 'utf8')).toBe('no trailing newline\nsecond\n')
  })

  test('preserves all content across two sequential appends (data-loss guard)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')

    await call(path, '<!-- fragment source=ses_a entry=11111111 -->\n## first\nbody\n')
    await call(path, '<!-- fragment source=ses_a entry=22222222 -->\n## second\nbody\n')

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('11111111')
    expect(content).toContain('22222222')
    expect(content).toContain('## first')
    expect(content).toContain('## second')
  })

  test('appends content byte-for-byte (does not auto-add trailing newlines)', async () => {
    const root = tmpRoot()
    const path = join(root, 'exact.md')

    await call(path, 'no trailing newline here')

    expect(readFileSync(path, 'utf8')).toBe('no trailing newline here')
  })
})
