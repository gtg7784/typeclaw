import { describe, expect, test } from 'bun:test'

import { formatLocalDate, formatLocalDateTime, formatLocalWeekday, resolveLocalTimezoneName } from './local-time'

describe('formatLocalDate', () => {
  test('formats a date as YYYY-MM-DD using local calendar fields', () => {
    // given
    const d = new Date(2026, 3, 28, 1, 0, 0)
    // when
    const result = formatLocalDate(d)
    // then
    expect(result).toBe('2026-04-28')
  })

  test('zero-pads month and day', () => {
    const d = new Date(2026, 0, 5, 12, 0, 0)
    expect(formatLocalDate(d)).toBe('2026-01-05')
  })

  test('does not roll back to previous day for early-morning local times', () => {
    // Regression: at 1am local on a UTC-west machine, toISOString() returns the
    // PREVIOUS day. Local-based formatting must report the local calendar day.
    const d = new Date(2026, 3, 28, 1, 0, 0)
    const result = formatLocalDate(d)
    expect(result.endsWith('-28')).toBe(true)
  })

  test('uses today by default', () => {
    const result = formatLocalDate()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const now = new Date()
    expect(result).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
  })
})

describe('formatLocalDateTime', () => {
  test('formats a date as YYYY-MM-DDTHH:mm:ss±HH:mm using local fields', () => {
    const d = new Date(2026, 3, 28, 13, 7, 9)
    const result = formatLocalDateTime(d)
    expect(result).toMatch(/^2026-04-28T13:07:09[+-]\d{2}:\d{2}$/)
  })

  test('the timezone offset reflects the local zone, not UTC', () => {
    const d = new Date(2026, 3, 28, 13, 7, 9)
    const result = formatLocalDateTime(d)
    const offsetPart = result.slice(-6)
    const expectedOffsetMinutes = -d.getTimezoneOffset()
    const sign = expectedOffsetMinutes >= 0 ? '+' : '-'
    const abs = Math.abs(expectedOffsetMinutes)
    const expected = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    expect(offsetPart).toBe(expected)
  })
})

describe('formatLocalWeekday', () => {
  test('returns matching English + Korean names for every day of the week', () => {
    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const koreanDays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(2026, 0, 4 + dow, 12, 0, 0)
      expect(d.getDay()).toBe(dow)
      const result = formatLocalWeekday(d)
      expect(result.en).toBe(englishDays[dow]!)
      expect(result.ko).toBe(koreanDays[dow]!)
    }
  })

  test('uses today by default when no date argument is given', () => {
    const result = formatLocalWeekday()
    expect(typeof result.en).toBe('string')
    expect(typeof result.ko).toBe('string')
    expect(result.en.length).toBeGreaterThan(0)
    expect(result.ko.length).toBeGreaterThan(0)
  })

  test('the returned names line up with what `Intl.DateTimeFormat` reports for the runtime locale', () => {
    const d = new Date(2026, 4, 28, 12, 0, 0)

    const result = formatLocalWeekday(d)

    expect(result.en).toBe(new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(d))
    expect(result.ko).toBe(new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(d))
  })
})

describe('resolveLocalTimezoneName', () => {
  test('returns the IANA zone name the process is currently in', () => {
    const result = resolveLocalTimezoneName()
    expect(result).toMatch(/^[A-Za-z]+(\/[A-Za-z_]+(\/[A-Za-z_]+)?)?$/)
  })

  test('returns a non-empty string under any environment (falls back to UTC if Intl is unavailable)', () => {
    const result = resolveLocalTimezoneName()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  test('the returned zone name matches what Intl.DateTimeFormat reports for the same process', () => {
    expect(resolveLocalTimezoneName()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
