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
