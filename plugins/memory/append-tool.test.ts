import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'

import { appendTool } from './append-tool'

async function callExpectingThrow(path: string, content: string): Promise<unknown> {
  try {
    await appendTool.execute({ path, content }, ctx)
    throw new Error(`expected appendTool.execute to throw, but it returned`)
  } catch (err) {
    return err
  }
}

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

  test('refuses to write content containing a GitHub fine-grained PAT (the leak pattern this PR fixes)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    // Token literal is split across concatenations so upstream secret scanners do not flag this file.
    const fakePat = 'github_' + 'pat_' + 'X'.repeat(80)
    const content = [
      '<!-- fragment source=ses_a entry=11111111 -->',
      '## GitHub Token Environment Variable',
      `GH_TOKEN=${fakePat}`,
    ].join('\n')

    const err = await callExpectingThrow(path, content)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/credential|secret/i)
    expect((err as Error).message).toContain('github-pat')
  })

  test('does not create the file when content is rejected for containing a secret', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')

    await callExpectingThrow(path, `token=${'sk-' + 'ant-' + 'X'.repeat(30)}`)

    expect(existsSync(path)).toBe(false)
  })

  test('does not append when an existing file would be polluted by secret content', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    const before = '<!-- fragment source=ses_a entry=existing -->\n## prior\nbody\n'
    writeFileSync(path, before)

    await callExpectingThrow(path, `GH_TOKEN=${'ghp' + '_' + 'X'.repeat(36)}`)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('error message names every distinct secret rule that fired', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    const content = [`${'ghp' + '_' + 'X'.repeat(36)}`, `${'AK' + 'IA' + 'XXXXXXXXXXXXXXXX'}`].join('\n')

    const err = await callExpectingThrow(path, content)
    const message = (err as Error).message
    expect(message).toContain('github-classic-pat')
    expect(message).toContain('aws-access-key')
  })

  test('still allows ordinary memory fragments through (no false positives on prose)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    const content = [
      '<!-- fragment source=ses_a entry=normal01 -->',
      '## GitHub Token Environment Variable: GH_TOKEN',
      '**Claim**: The environment variable `GH_TOKEN` (not `GITHUB_TOKEN`) holds the GitHub PAT.',
      '**Evidence**: Discovered via `env | grep -i token`. Successfully used to fetch private repo data.',
      '**Implication**: For GitHub API operations, use `GH_TOKEN`, not `GITHUB_TOKEN`.',
    ].join('\n')

    await call(path, content)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  test('refuses to append a fragment whose topic+body already exists in the file (the winky duplication case)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    const fragment = (sessionId: string, entryId: string): string =>
      [
        `<!-- fragment source=${sessionId} entry=${entryId} -->`,
        '## Review System Final Design Decisions',
        'Three Key Decisions raised by Jamie and confirmed:',
        '1. Eligibility (Conservative) - DELIVERED + no cancellation + no return',
        '2. Delete Strategy (Hybrid) - hard for user, soft for admin hide',
        '3. Review Count per Order Item - 1 per (user, order_item) with UNIQUE constraint',
        '',
      ].join('\n')

    await call(path, fragment('ses_first', '92ad3a70'))
    const err = await callExpectingThrow(path, fragment('ses_second', '1db7920a'))

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/already exist|duplicate|byte-equivalent/i)
    expect((err as Error).message).toContain('Review System Final Design Decisions')
  })

  test('does not modify the file when an append is rejected for duplication', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    const original = '<!-- fragment source=ses_a entry=11 -->\n## Existing\noriginal body\n'
    writeFileSync(path, original)

    const dup = '<!-- fragment source=ses_b entry=22 -->\n## Existing\noriginal body\n'
    await callExpectingThrow(path, dup)

    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  test('allows fragments whose topic matches but body differs (legitimately distinct)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    await call(path, '<!-- fragment source=ses_a entry=11 -->\n## Decision\nuse option A\n')
    await call(path, '<!-- fragment source=ses_b entry=22 -->\n## Decision\nactually use option B (decision changed)\n')

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('use option A')
    expect(content).toContain('actually use option B')
  })

  test('allows watermark-only appends regardless of existing fragments (no fragments to dedup)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    writeFileSync(path, '<!-- fragment source=ses_a entry=11 -->\n## Existing\nbody\n')

    await call(path, '<!-- watermark source=ses_b entry=22 -->\n')

    expect(readFileSync(path, 'utf8')).toContain('<!-- watermark source=ses_b')
  })

  test('refuses an append that contains a duplicate even if other fragments in the same append are new', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    await call(path, '<!-- fragment source=ses_a entry=11 -->\n## ExistingTopic\nshared body\n')

    const mixedAppend = [
      '<!-- fragment source=ses_b entry=22 -->',
      '## NewTopic',
      'genuinely new body',
      '',
      '<!-- fragment source=ses_b entry=23 -->',
      '## ExistingTopic',
      'shared body',
      '',
    ].join('\n')

    const err = await callExpectingThrow(path, mixedAppend)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('ExistingTopic')
    expect(readFileSync(path, 'utf8')).not.toContain('NewTopic')
  })

  test('treats whitespace-only differences as duplicates (semantic equivalence)', async () => {
    const root = tmpRoot()
    const path = join(root, 'fragments.md')
    await call(path, '<!-- fragment source=ses_a entry=11 -->\n## Topic\nbody line\n')

    const trailingSpaces = '<!-- fragment source=ses_b entry=22 -->\n## Topic\nbody line   \n'
    const err = await callExpectingThrow(path, trailingSpaces)
    expect((err as Error).message).toContain('Topic')
  })
})
