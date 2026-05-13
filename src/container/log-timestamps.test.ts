import { describe, expect, test } from 'bun:test'

import { makeLogTimestampReformatter, reformatLine } from './log-timestamps'

const FIXED = new Date('2026-05-13T14:23:01.123456789Z')
const fixedNow = (): Date => FIXED

function localStampOf(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

describe('reformatLine', () => {
  test('replaces RFC3339Nano prefix with local YYYY-MM-DD HH:MM:SS', () => {
    expect(reformatLine('2026-05-13T14:23:01.123456789Z hello world', fixedNow)).toBe(
      `${localStampOf(FIXED)} hello world`,
    )
  })

  test('handles RFC3339 without nanoseconds', () => {
    expect(reformatLine('2026-05-13T14:23:01Z hi', fixedNow)).toBe(
      `${localStampOf(new Date('2026-05-13T14:23:01Z'))} hi`,
    )
  })

  test('handles non-Z timezone offset', () => {
    const raw = '2026-05-13T23:23:01.000000000+09:00 morning'
    const expected = `${localStampOf(new Date('2026-05-13T23:23:01+09:00'))} morning`
    expect(reformatLine(raw, fixedNow)).toBe(expected)
  })

  test('preserves the body verbatim, including extra spaces and ANSI', () => {
    const raw = '2026-05-13T14:23:01Z   \x1b[31mred\x1b[0m  spaces  '
    expect(reformatLine(raw, fixedNow)).toBe(
      `${localStampOf(new Date('2026-05-13T14:23:01Z'))}   \x1b[31mred\x1b[0m  spaces  `,
    )
  })

  test('passes through lines without a leading timestamp', () => {
    expect(reformatLine('plain output line', fixedNow)).toBe('plain output line')
    expect(reformatLine('', fixedNow)).toBe('')
  })

  test('falls back to now() when Docker emits an unparseable timestamp', () => {
    // given a syntactically-valid but unparseable date
    const raw = '2026-13-99T99:99:99Z weird'
    // when reformatted with a fixed clock
    expect(reformatLine(raw, fixedNow)).toBe(`${localStampOf(FIXED)} weird`)
  })
})

describe('makeLogTimestampReformatter', () => {
  test('emits one reformatted line per newline-terminated chunk', () => {
    const r = makeLogTimestampReformatter(fixedNow)

    expect(r.write('2026-05-13T14:23:01Z hello\n')).toBe(`${localStampOf(new Date('2026-05-13T14:23:01Z'))} hello\n`)
  })

  test('buffers partial lines until a newline arrives', () => {
    const r = makeLogTimestampReformatter(fixedNow)

    expect(r.write('2026-05-13T14:23:01Z hel')).toBe('')
    expect(r.write('lo\n')).toBe(`${localStampOf(new Date('2026-05-13T14:23:01Z'))} hello\n`)
  })

  test('handles multiple lines in one chunk independently', () => {
    const r = makeLogTimestampReformatter(fixedNow)
    const a = '2026-05-13T14:23:01Z'
    const b = '2026-05-13T14:23:02Z'

    expect(r.write(`${a} one\n${b} two\n`)).toBe(`${localStampOf(new Date(a))} one\n${localStampOf(new Date(b))} two\n`)
  })

  test('flush emits the un-terminated tail with a trailing newline', () => {
    const r = makeLogTimestampReformatter(fixedNow)

    r.write('2026-05-13T14:23:01Z partial')
    expect(r.flush()).toBe(`${localStampOf(new Date('2026-05-13T14:23:01Z'))} partial\n`)
  })

  test('flush is a no-op when the buffer is empty', () => {
    const r = makeLogTimestampReformatter(fixedNow)

    r.write('2026-05-13T14:23:01Z done\n')
    expect(r.flush()).toBe('')
  })

  test('does not splice across chunks within a single line (byte-by-byte)', () => {
    // given a line arriving one character at a time
    const r = makeLogTimestampReformatter(fixedNow)
    const raw = '2026-05-13T14:23:01Z hello world\n'

    // when every character is fed individually
    let out = ''
    for (const ch of raw) out += r.write(ch)

    // then a single complete reformatted line is emitted
    expect(out).toBe(`${localStampOf(new Date('2026-05-13T14:23:01Z'))} hello world\n`)
  })

  test('passes plain (un-timestamped) lines through unchanged', () => {
    const r = makeLogTimestampReformatter(fixedNow)

    expect(r.write('plain\nstill plain\n')).toBe('plain\nstill plain\n')
  })
})
