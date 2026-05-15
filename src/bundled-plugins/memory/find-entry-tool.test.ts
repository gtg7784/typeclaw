import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'

import { findEntryTool } from './find-entry-tool'

const ctx: ToolContext = {
  signal: undefined,
  sessionId: 'test',
  agentDir: '/tmp',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'memory-find-entry-'))
}

function writeJsonl(path: string, lines: object[]): void {
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8')
}

describe('findEntryTool', () => {
  test('reports line number, total lines, and next offset for a found entry', async () => {
    const root = tmpRoot()
    const path = join(root, 'transcript.jsonl')
    writeJsonl(path, [
      { type: 'session', id: 'aaa' },
      { type: 'message', id: 'b1e2dbf1' },
      { type: 'message', id: '79867453' },
      { type: 'message', id: '09260992', parentId: '79867453' },
    ])

    const result = await findEntryTool.execute({ path, entryId: '79867453' }, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(text).toContain('found')
    expect(text).toContain('line=3')
    expect(text).toContain('totalLines=4')
    expect(text).toContain('offset=4')
  })

  test('reports not found when no line carries the entry id', async () => {
    const root = tmpRoot()
    const path = join(root, 'transcript.jsonl')
    writeJsonl(path, [
      { type: 'message', id: 'aaaa1111' },
      { type: 'message', id: 'bbbb2222' },
    ])

    const result = await findEntryTool.execute({ path, entryId: 'no-such-id' }, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(text).toContain('not found')
    expect(text).toContain('totalLines=2')
  })

  test('locates the entry by its own id, ignoring later parentId references to the same id', async () => {
    // The id '79867453' appears twice: once as line 1's own id, and again as line 2's parentId.
    // The watermark always names an entry's own id, so the tool must match `"id":"<entryId>"`
    // exactly and ignore `"parentId":"<entryId>"`. A naive substring search would pick line 2.
    const root = tmpRoot()
    const path = join(root, 'transcript.jsonl')
    writeJsonl(path, [
      { type: 'message', id: '79867453', parentId: 'older' },
      { type: 'message', id: '09260992', parentId: '79867453' },
      { type: 'message', id: 'xxxxxxxx', parentId: '09260992' },
    ])

    const result = await findEntryTool.execute({ path, entryId: '79867453' }, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(text).toContain('line=1')
  })

  test('skips malformed JSON lines instead of throwing', async () => {
    const root = tmpRoot()
    const path = join(root, 'transcript.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'message', id: 'aaaa1111' }),
        '{ not valid json',
        JSON.stringify({ type: 'message', id: 'bbbb2222' }),
      ].join('\n'),
      'utf8',
    )

    const result = await findEntryTool.execute({ path, entryId: 'bbbb2222' }, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(text).toContain('line=3')
  })

  test('throws when the file does not exist', async () => {
    const root = tmpRoot()
    const path = join(root, 'does-not-exist.jsonl')

    await expect(findEntryTool.execute({ path, entryId: 'whatever' }, ctx)).rejects.toThrow(/does-not-exist/)
  })

  test('rejects empty entryId so the agent cannot accidentally scan for "" ', async () => {
    const root = tmpRoot()
    const path = join(root, 'transcript.jsonl')
    writeJsonl(path, [{ type: 'message', id: 'aaaa1111' }])

    await expect(findEntryTool.execute({ path, entryId: '' }, ctx)).rejects.toThrow()
  })

  test('counts the final line even when the file has no trailing newline', async () => {
    const root = tmpRoot()
    const path = join(root, 'transcript.jsonl')
    writeFileSync(
      path,
      [JSON.stringify({ type: 'message', id: 'aaaa1111' }), JSON.stringify({ type: 'message', id: 'bbbb2222' })].join(
        '\n',
      ),
      'utf8',
    )

    const result = await findEntryTool.execute({ path, entryId: 'bbbb2222' }, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(text).toContain('line=2')
    expect(text).toContain('totalLines=2')
  })
})
