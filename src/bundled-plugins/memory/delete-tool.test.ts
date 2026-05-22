import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteTopicShardTool } from './delete-tool'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'memory-delete-'))
}

function ctx(root: string) {
  return { agentDir: root }
}

async function call(root: string, input: { path: string }) {
  return await deleteTopicShardTool.run(input, ctx(root))
}

describe('deleteTopicShardTool', () => {
  test('happy path: deletes an existing topic shard and returns the relative path', async () => {
    const root = tmpRoot()
    const topicPath = join(root, 'memory', 'topics', 'foo.md')
    mkdirSync(join(root, 'memory', 'topics'), { recursive: true })
    writeFileSync(topicPath, '# Foo\n\nContent.')

    const result = await call(root, { path: 'memory/topics/foo.md' })

    expect(result).toEqual({ ok: true, path: 'memory/topics/foo.md' })
    expect(existsSync(topicPath)).toBe(false)
  })

  test('rejects paths outside memory/topics/ and leaves file untouched', async () => {
    const root = tmpRoot()
    const streamPath = join(root, 'memory', 'streams', '2026-05-20.jsonl')
    mkdirSync(join(root, 'memory', 'streams'), { recursive: true })
    writeFileSync(streamPath, '[]')

    const result = await call(root, { path: 'memory/streams/2026-05-20.jsonl' })

    expect(result).toEqual({ ok: false, reason: 'invalid_path' })
    expect(existsSync(streamPath)).toBe(true)
  })

  test('rejects .. traversal', async () => {
    const root = tmpRoot()
    const result = await call(root, { path: '../typeclaw.json' })
    expect(result).toEqual({ ok: false, reason: 'invalid_path' })
  })

  test('rejects non-.md extension', async () => {
    const root = tmpRoot()
    const result = await call(root, { path: 'memory/topics/foo.txt' })
    expect(result).toEqual({ ok: false, reason: 'invalid_path' })
  })

  test('rejects absolute path', async () => {
    const root = tmpRoot()
    const result = await call(root, { path: '/etc/passwd' })
    expect(result).toEqual({ ok: false, reason: 'invalid_path' })
  })

  test('rejects backslash path separators', async () => {
    const root = tmpRoot()
    const result = await call(root, { path: 'memory\\topics\\foo.md' })
    expect(result).toEqual({ ok: false, reason: 'invalid_path' })
  })

  test('rejects invalid slug (uppercase)', async () => {
    const root = tmpRoot()
    const result = await call(root, { path: 'memory/topics/UPPER.md' })
    expect(result).toEqual({ ok: false, reason: 'invalid_slug' })
  })

  test('rejects nested topic paths', async () => {
    const root = tmpRoot()
    const result = await call(root, { path: 'memory/topics/sub/foo.md' })
    expect(result).toEqual({ ok: false, reason: 'invalid_path' })
  })

  test('returns not_found when the file does not exist', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'memory', 'topics'), { recursive: true })

    const result = await call(root, { path: 'memory/topics/nonexistent.md' })

    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})
