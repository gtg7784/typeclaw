import { describe, expect, test } from 'bun:test'

import { isMacOS, isWindows } from './platform'

describe('isWindows', () => {
  test('is true only on win32', () => {
    expect(isWindows('win32')).toBe(true)
    expect(isWindows('darwin')).toBe(false)
    expect(isWindows('linux')).toBe(false)
  })
})

describe('isMacOS', () => {
  test('is true only on darwin', () => {
    expect(isMacOS('darwin')).toBe(true)
    expect(isMacOS('win32')).toBe(false)
    expect(isMacOS('linux')).toBe(false)
  })
})
