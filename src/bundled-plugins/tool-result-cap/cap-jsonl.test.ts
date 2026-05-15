import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CapJsonlReadError, capJsonlFileInPlace } from './cap-jsonl'

const baseOptions = {
  imageMaxBytes: 100,
  textMaxBytes: 50,
  exemptTools: new Set<string>(),
}

function makeTmpJsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cap-jsonl-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

function readJsonl(path: string): unknown[] {
  const raw = readFileSync(path, 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown)
}

describe('capJsonlFileInPlace', () => {
  test('rewrites a toolResult entry whose image part exceeds imageMaxBytes', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [
            { type: 'text', text: 'Read image file [image/png]' },
            { type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) },
          ],
        },
      },
    ])

    const stats = capJsonlFileInPlace(path, baseOptions)

    expect(stats.imagesReplaced).toBe(1)
    expect(stats.textsTruncated).toBe(0)
    expect(stats.entriesMutated).toBe(1)
    expect(stats.bytesElided).toBe(500)

    const entries = readJsonl(path) as { type: string; message?: { content: unknown[] } }[]
    expect(entries).toHaveLength(2)
    const content = entries[1]!.message!.content as { type: string; text?: string }[]
    expect(content[1]?.type).toBe('text')
    expect(content[1]?.text).toContain('tool-result-cap')
  })

  test('does not rewrite the file when nothing exceeds the thresholds', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [{ type: 'text', text: 'short result' }],
        },
      },
    ])
    const before = readFileSync(path, 'utf8')

    const stats = capJsonlFileInPlace(path, baseOptions)

    expect(stats.entriesMutated).toBe(0)
    expect(stats.imagesReplaced).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('is idempotent: running twice produces the same file as running once', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
        },
      },
    ])

    capJsonlFileInPlace(path, baseOptions)
    const afterFirst = readFileSync(path, 'utf8')
    const secondStats = capJsonlFileInPlace(path, baseOptions)
    const afterSecond = readFileSync(path, 'utf8')

    expect(secondStats.entriesMutated).toBe(0)
    expect(afterFirst).toBe(afterSecond)
  })

  test('respects exemptTools (no cap on excluded tool, cap on others)', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'exempt',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
        },
      },
      {
        type: 'message',
        id: 'capped',
        parentId: 'exempt',
        timestamp: '2026-05-12T00:00:02Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.webfetch:1',
          toolName: 'webfetch',
          content: [{ type: 'image', mimeType: 'image/png', data: 'B'.repeat(500) }],
        },
      },
    ])

    const stats = capJsonlFileInPlace(path, { ...baseOptions, exemptTools: new Set(['read']) })

    expect(stats.entriesMutated).toBe(1)
    const entries = readJsonl(path) as { id: string; message?: { content: unknown[] } }[]
    const exemptContent = entries[1]!.message!.content as { type: string }[]
    const cappedContent = entries[2]!.message!.content as { type: string; text?: string }[]
    expect(exemptContent[0]?.type).toBe('image')
    expect(cappedContent[0]?.type).toBe('text')
    expect(cappedContent[0]?.text).toContain('tool-result-cap')
  })

  test('preserves non-toolResult entries verbatim', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'A'.repeat(200) }] },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(200) }] },
      },
    ])
    const before = readFileSync(path, 'utf8')

    const stats = capJsonlFileInPlace(path, baseOptions)

    expect(stats.entriesMutated).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('passes malformed lines through verbatim instead of dropping or crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-jsonl-'))
    const path = join(dir, 'session.jsonl')
    const header = JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' })
    const cap = JSON.stringify({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-05-12T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'functions.read:1',
        toolName: 'read',
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
      },
    })
    const malformed = '{not valid json'
    writeFileSync(path, `${header}\n${malformed}\n${cap}\n`)

    capJsonlFileInPlace(path, baseOptions)

    const after = readFileSync(path, 'utf8').split('\n')
    expect(after[0]).toBe(header)
    expect(after[1]).toBe(malformed)
    expect(after[2]).toContain('tool-result-cap')
  })

  test('throws CapJsonlReadError when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-jsonl-'))

    expect(() => capJsonlFileInPlace(join(dir, 'missing.jsonl'), baseOptions)).toThrow(CapJsonlReadError)
  })

  test('throws CapJsonlReadError when the path is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-jsonl-'))
    const subdir = join(dir, 'subdir')
    mkdirSync(subdir)

    expect(() => capJsonlFileInPlace(subdir, baseOptions)).toThrow(CapJsonlReadError)
  })

  test('preserves the original file mode across the temp+rename rewrite', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
        },
      },
    ])
    chmodSync(path, 0o600)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const stats = capJsonlFileInPlace(path, baseOptions)

    expect(stats.entriesMutated).toBe(1)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('caps multiple toolResult entries in one pass', () => {
    const entries: unknown[] = [{ type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' }]
    for (let i = 0; i < 3; i++) {
      entries.push({
        type: 'message',
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: `functions.read:${i}`,
          toolName: 'read',
          content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
        },
      })
    }
    const path = makeTmpJsonl(entries)

    const stats = capJsonlFileInPlace(path, baseOptions)

    expect(stats.entriesMutated).toBe(3)
    expect(stats.imagesReplaced).toBe(3)
    expect(stats.bytesElided).toBe(1500)
  })

  test('truncates oversized text parts in toolResult entries', () => {
    const path = makeTmpJsonl([
      { type: 'session', id: 's1', timestamp: '2026-05-12T00:00:00Z', cwd: '/a' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.webfetch:1',
          toolName: 'webfetch',
          content: [{ type: 'text', text: 'B'.repeat(200) }],
        },
      },
    ])

    const stats = capJsonlFileInPlace(path, baseOptions)

    expect(stats.textsTruncated).toBe(1)
    expect(stats.bytesElided).toBe(150)
    const entries = readJsonl(path) as { message?: { content: { type: string; text?: string }[] } }[]
    expect(entries[1]!.message!.content[0]?.text).toContain('tool-result-cap')
  })
})
