import { describe, expect, test } from 'bun:test'

import { colorFor, makeLinePrefixer } from './logs'

describe('colorFor', () => {
  test('is deterministic for the same name', () => {
    expect(colorFor('coder')).toBe(colorFor('coder'))
  })

  test('returns a value from the provided palette', () => {
    const palette: readonly string[] = ['1', '2', '3']
    expect(palette).toContain(colorFor('alpha', palette))
    expect(palette).toContain(colorFor('beta', palette))
  })
})

describe('makeLinePrefixer', () => {
  test('emits complete lines with name padding and bar', () => {
    const p = makeLinePrefixer('coder', 7, '36', false)

    expect(p.write('hello\n')).toBe('coder   | hello\n')
  })

  test('buffers partial lines until newline arrives', () => {
    const p = makeLinePrefixer('coder', 5, '36', false)

    expect(p.write('hello')).toBe('')
    expect(p.write(' world\n')).toBe('coder | hello world\n')
  })

  test('handles multiple newlines in one chunk', () => {
    const p = makeLinePrefixer('a', 1, '36', false)

    expect(p.write('one\ntwo\nthree\n')).toBe('a | one\na | two\na | three\n')
  })

  test('handles partial line followed by chunk with multiple newlines', () => {
    const p = makeLinePrefixer('a', 1, '36', false)

    p.write('hel')
    expect(p.write('lo\nworld\n')).toBe('a | hello\na | world\n')
  })

  test('flush emits the un-terminated tail with a trailing newline', () => {
    const p = makeLinePrefixer('a', 1, '36', false)

    p.write('partial')
    expect(p.flush()).toBe('a | partial\n')
  })

  test('flush is a no-op when the buffer is empty', () => {
    const p = makeLinePrefixer('a', 1, '36', false)

    p.write('done\n')
    expect(p.flush()).toBe('')
  })

  test('emits ANSI escapes when useColor is true', () => {
    const p = makeLinePrefixer('coder', 5, '36', true)

    expect(p.write('hi\n')).toBe('\x1b[36mcoder\x1b[0m | hi\n')
  })

  test('does not splice across chunks within a single line', () => {
    // given a name shorter than the column width
    const p = makeLinePrefixer('a', 5, '36', false)

    // when bytes arrive in tiny pieces
    let out = ''
    for (const ch of 'hello world\n') out += p.write(ch)

    // then a single complete line is emitted (not 12 fragments)
    expect(out).toBe('a     | hello world\n')
  })
})
