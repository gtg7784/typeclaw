import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readWatermark } from './watermark'

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-watermark-'))
  const path = join(dir, 'stream.md')
  writeFileSync(path, content)
  return path
}

describe('readWatermark', () => {
  test('returns null when the file does not exist', () => {
    expect(readWatermark(join(tmpdir(), 'does-not-exist-xyz.md'), 'ses_abc')).toBeNull()
  })

  test('returns null when the file has no fragment markers', () => {
    const path = tmpFile('# 2026-04-27\n\nsome notes\n')
    expect(readWatermark(path, 'ses_abc')).toBeNull()
  })

  test('returns null when markers exist only for a different session', () => {
    const path = tmpFile(['<!-- fragment source=ses_xyz entry=11111111 -->', '## something', 'content', ''].join('\n'))
    expect(readWatermark(path, 'ses_abc')).toBeNull()
  })

  test('returns the entry id when a single matching marker exists', () => {
    const path = tmpFile(['<!-- fragment source=ses_abc entry=a3f9c2d1 -->', '## topic', 'body', ''].join('\n'))
    expect(readWatermark(path, 'ses_abc')).toBe('a3f9c2d1')
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
    expect(readWatermark(path, 'ses_abc')).toBe('33333333')
  })

  test('does not match when source value is a prefix of the requested session id', () => {
    const path = tmpFile(['<!-- fragment source=ses_a entry=00000001 -->', '## prefix', ''].join('\n'))
    expect(readWatermark(path, 'ses_abc')).toBeNull()
  })

  test('recognizes a bare watermark marker (no fragment body) as a valid watermark', () => {
    const path = tmpFile('<!-- watermark source=ses_abc entry=quietday -->\n')
    expect(readWatermark(path, 'ses_abc')).toBe('quietday')
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
    expect(readWatermark(path, 'ses_abc')).toBe('33333333')
  })

  test('fragment markers with a trailing certainty attribute still match', () => {
    const path = tmpFile(
      ['<!-- fragment source=ses_abc entry=cert0001 certainty=explicit -->', '## an explicit fact', 'body', ''].join(
        '\n',
      ),
    )
    expect(readWatermark(path, 'ses_abc')).toBe('cert0001')
  })
})
