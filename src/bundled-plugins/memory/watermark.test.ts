import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLatestWatermark, readWatermarkFromFile } from './watermark'

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-watermark-'))
  const path = join(dir, 'stream.md')
  writeFileSync(path, content)
  return path
}

function tmpMemoryDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-dir-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('readWatermarkFromFile', () => {
  test('returns null when the file does not exist', () => {
    expect(readWatermarkFromFile(join(tmpdir(), 'does-not-exist-xyz.md'), 'ses_abc')).toBeNull()
  })

  test('returns null when the file has no fragment markers', () => {
    const path = tmpFile('# 2026-04-27\n\nsome notes\n')
    expect(readWatermarkFromFile(path, 'ses_abc')).toBeNull()
  })

  test('returns null when markers exist only for a different session', () => {
    const path = tmpFile(['<!-- fragment source=ses_xyz entry=11111111 -->', '## something', 'content', ''].join('\n'))
    expect(readWatermarkFromFile(path, 'ses_abc')).toBeNull()
  })

  test('returns the entry id when a single matching marker exists', () => {
    const path = tmpFile(['<!-- fragment source=ses_abc entry=a3f9c2d1 -->', '## topic', 'body', ''].join('\n'))
    expect(readWatermarkFromFile(path, 'ses_abc')).toBe('a3f9c2d1')
  })

  test('returns the LAST entry id when multiple markers for the same session exist', () => {
    const path = tmpFile(
      [
        '<!-- fragment source=ses_abc entry=11111111 -->',
        '## first',
        'body',
        '',
        '<!-- fragment source=ses_abc entry=22222222 -->',
        '## second',
        'body',
        '',
        '<!-- fragment source=ses_abc entry=33333333 -->',
        '## third',
        'body',
        '',
      ].join('\n'),
    )
    expect(readWatermarkFromFile(path, 'ses_abc')).toBe('33333333')
  })

  test('does not match when source value is a prefix of the requested session id', () => {
    const path = tmpFile(['<!-- fragment source=ses_a entry=00000001 -->', '## prefix', ''].join('\n'))
    expect(readWatermarkFromFile(path, 'ses_abc')).toBeNull()
  })

  test('recognizes a bare watermark marker (no fragment body) as a valid watermark', () => {
    const path = tmpFile('<!-- watermark source=ses_abc entry=quietday -->\n')
    expect(readWatermarkFromFile(path, 'ses_abc')).toBe('quietday')
  })

  test('the latest marker wins regardless of whether it is a fragment or a bare watermark', () => {
    const path = tmpFile(
      [
        '<!-- fragment source=ses_abc entry=11111111 -->',
        '## first',
        'body',
        '',
        '<!-- watermark source=ses_abc entry=22222222 -->',
        '',
        '<!-- fragment source=ses_abc entry=33333333 -->',
        '## third',
        'body',
        '',
      ].join('\n'),
    )
    expect(readWatermarkFromFile(path, 'ses_abc')).toBe('33333333')
  })

  test('fragment markers with a trailing certainty attribute still match', () => {
    const path = tmpFile(
      ['<!-- fragment source=ses_abc entry=cert0001 certainty=explicit -->', '## an explicit fact', 'body', ''].join(
        '\n',
      ),
    )
    expect(readWatermarkFromFile(path, 'ses_abc')).toBe('cert0001')
  })
})

describe('readLatestWatermark', () => {
  test('returns null when the memory dir does not exist', () => {
    expect(readLatestWatermark(join(tmpdir(), 'no-such-memory-dir-xyz'), 'ses_abc')).toBeNull()
  })

  test('returns null when the memory dir is empty', () => {
    const dir = tmpMemoryDir({})
    expect(readLatestWatermark(dir, 'ses_abc')).toBeNull()
  })

  test("returns today's watermark when today's stream exists with a marker", () => {
    const dir = tmpMemoryDir({
      '2026-05-16.md': '<!-- watermark source=ses_abc entry=today-id -->\n',
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('today-id')
  })

  test("returns YESTERDAY'S watermark when today's stream does not exist (the midnight-rollover case)", () => {
    const dir = tmpMemoryDir({
      '2026-05-15.md': [
        '<!-- fragment source=ses_abc entry=morning-id -->',
        '## body',
        '',
        '<!-- watermark source=ses_abc entry=evening-id -->',
        '',
      ].join('\n'),
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('evening-id')
  })

  test("returns yesterday's watermark when today's stream exists but has none for this session", () => {
    const dir = tmpMemoryDir({
      '2026-05-15.md': '<!-- watermark source=ses_abc entry=yesterday-id -->\n',
      '2026-05-16.md': '<!-- watermark source=ses_other entry=different-session -->\n',
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('yesterday-id')
  })

  test("prefers today's watermark over yesterday's when both contain markers for the session", () => {
    const dir = tmpMemoryDir({
      '2026-05-15.md': '<!-- watermark source=ses_abc entry=yesterday-id -->\n',
      '2026-05-16.md': '<!-- watermark source=ses_abc entry=today-id -->\n',
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('today-id')
  })

  test('walks back past empty / unrelated daily streams until it finds a matching marker', () => {
    const dir = tmpMemoryDir({
      '2026-05-13.md': '<!-- watermark source=ses_abc entry=oldest -->\n',
      '2026-05-14.md': '# nothing for us today\n',
      '2026-05-15.md': '<!-- watermark source=ses_other entry=different-session -->\n',
      '2026-05-16.md': '',
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('oldest')
  })

  test('returns null when no daily stream contains a marker for this session', () => {
    const dir = tmpMemoryDir({
      '2026-05-14.md': '<!-- watermark source=ses_other entry=different-session -->\n',
      '2026-05-15.md': '# unrelated content\n',
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBeNull()
  })

  test('ignores non-YYYY-MM-DD markdown files in memory/', () => {
    const dir = tmpMemoryDir({
      'README.md': '<!-- watermark source=ses_abc entry=should-be-ignored -->\n',
      'notes.md': '<!-- watermark source=ses_abc entry=also-ignored -->\n',
      '2026-05-15.md': '<!-- watermark source=ses_abc entry=picked -->\n',
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('picked')
  })

  test('ignores non-markdown files and subdirectories in memory/', () => {
    const dir = tmpMemoryDir({
      '.dreaming-state.json': '{"days":{"2026-05-15":42}}',
      '2026-05-15.md': '<!-- watermark source=ses_abc entry=found -->\n',
    })
    mkdirSync(join(dir, 'skills'))
    writeFileSync(join(dir, 'skills', 'something.md'), '<!-- watermark source=ses_abc entry=in-subdir -->\n')
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('found')
  })

  test("uses the LAST marker within a file once it picks that file (so today's last is preferred to today's first)", () => {
    const dir = tmpMemoryDir({
      '2026-05-16.md': [
        '<!-- fragment source=ses_abc entry=morning -->',
        '## a',
        '',
        '<!-- fragment source=ses_abc entry=midday -->',
        '## b',
        '',
        '<!-- watermark source=ses_abc entry=latest -->',
      ].join('\n'),
    })
    expect(readLatestWatermark(dir, 'ses_abc')).toBe('latest')
  })
})
