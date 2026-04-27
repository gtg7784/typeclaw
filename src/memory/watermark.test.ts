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

  test('returns the last marker for the requested session even when sessions are interleaved', () => {
    const path = tmpFile(
      [
        '<!-- fragment source=ses_abc entry=aaaaaaaa -->',
        '## a1',
        '',
        '<!-- fragment source=ses_xyz entry=bbbbbbbb -->',
        '## x1',
        '',
        '<!-- fragment source=ses_abc entry=cccccccc -->',
        '## a2',
        '',
        '<!-- fragment source=ses_xyz entry=dddddddd -->',
        '## x2',
        '',
      ].join('\n'),
    )
    expect(readWatermark(path, 'ses_abc')).toBe('cccccccc')
    expect(readWatermark(path, 'ses_xyz')).toBe('dddddddd')
  })

  test('ignores markers with extra whitespace or unexpected formatting', () => {
    const path = tmpFile(['<!--   fragment   source=ses_abc   entry=spaced01   -->', '## still parses', ''].join('\n'))
    expect(readWatermark(path, 'ses_abc')).toBe('spaced01')
  })

  test('does not match when source value is a prefix of the requested session id', () => {
    // Guards against accidental substring matching: ses_a should NOT match ses_abc.
    const path = tmpFile(
      [
        '<!-- fragment source=ses_a entry=00000001 -->',
        '## prefix',
        '',
      ].join('\n'),
    )
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

  test('a bare watermark following a fragment advances the watermark', () => {
    const path = tmpFile(
      [
        '<!-- fragment source=ses_abc entry=11111111 -->',
        '## first',
        'body',
        '',
        '<!-- watermark source=ses_abc entry=22222222 -->',
        '',
      ].join('\n'),
    )
    expect(readWatermark(path, 'ses_abc')).toBe('22222222')
  })

  test('bare watermarks are filtered by session like fragments', () => {
    const path = tmpFile(
      [
        '<!-- watermark source=ses_xyz entry=11111111 -->',
        '<!-- watermark source=ses_abc entry=22222222 -->',
        '<!-- watermark source=ses_xyz entry=33333333 -->',
      ].join('\n'),
    )
    expect(readWatermark(path, 'ses_abc')).toBe('22222222')
    expect(readWatermark(path, 'ses_xyz')).toBe('33333333')
  })

  test('fragment markers with a trailing certainty attribute still match', () => {
    const path = tmpFile(
      [
        '<!-- fragment source=ses_abc entry=cert0001 certainty=explicit -->',
        '## an explicit fact',
        'body',
        '',
      ].join('\n'),
    )
    expect(readWatermark(path, 'ses_abc')).toBe('cert0001')
  })

  test('the latest marker wins across mixed fragment and watermark with extra attributes', () => {
    const path = tmpFile(
      [
        '<!-- fragment source=ses_abc entry=11111111 certainty=explicit -->',
        '## first',
        'body',
        '',
        '<!-- fragment source=ses_abc entry=22222222 certainty=inductive sources=2 -->',
        '## second',
        'body',
        '',
        '<!-- watermark source=ses_abc entry=33333333 -->',
        '',
      ].join('\n'),
    )
    expect(readWatermark(path, 'ses_abc')).toBe('33333333')
  })
})
