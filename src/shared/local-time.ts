function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatLocalDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function formatLocalDateTime(date: Date = new Date()): string {
  const datePart = formatLocalDate(date)
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  const offset = formatTimezoneOffset(date)
  return `${datePart}T${timePart}${offset}`
}

function formatTimezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

// IANA timezone name of the process (e.g. `Asia/Seoul`). Reads the resolved
// zone from Intl, falling back to `UTC` if the runtime cannot resolve one —
// this should never happen on Bun + tzdata-equipped containers, but the
// fallback keeps the prompt renderable rather than throwing during session
// creation. The returned name is what the agent shows the user when asked
// "what time is it" — pairing the wall clock with a recognizable zone name
// is what disambiguates "15:31 +09:00" from "15:31 KST" for a non-technical
// reader.
export function resolveLocalTimezoneName(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone && zone.length > 0 ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

// English + Korean weekday name pair for a given Date. The per-turn time
// anchor renders both so the model has the answer to "what day is it"
// without computing weekday-from-ISO-date — a step LLMs get wrong often
// enough to matter, especially when answering in a non-English language.
// Pre-computing in both candidate reply languages removes the arithmetic
// step entirely instead of trusting the model to do it correctly each
// turn.
//
// Uses Intl.DateTimeFormat with explicit locales. No `timeZone` option:
// the container's local clock is already host-local (the entrypoint
// propagates TZ via `-e TZ=<host-tz>`), so the runtime's default zone is
// the one the user sees. Both locales fall back to the hand-rolled
// 7-entry lookup if Intl throws (no-tzdata, locked-down sandbox) — the
// fallback names stay readable and never make the prefix empty.
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const WEEKDAYS_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'] as const

export type LocalWeekday = { en: string; ko: string }

export function formatLocalWeekday(date: Date = new Date()): LocalWeekday {
  const dow = date.getDay()
  const fallback: LocalWeekday = { en: WEEKDAYS_EN[dow]!, ko: WEEKDAYS_KO[dow]! }
  try {
    return {
      en: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date),
      ko: new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(date),
    }
  } catch {
    return fallback
  }
}
