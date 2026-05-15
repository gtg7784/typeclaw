import { startOfDaysAgo, startOfToday } from '@/usage'

export const USAGE_COMMON_ARGS = {
  json: {
    type: 'boolean' as const,
    description: 'emit the usage report as JSON',
    default: false,
  },
  since: {
    type: 'string' as const,
    description: "ISO date or relative duration ('today', '7d', '30d')",
  },
  until: {
    type: 'string' as const,
    description: 'ISO date upper bound (exclusive)',
  },
}

export function parseSince(value: unknown, command: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value === 'today') return startOfToday()
  const days = /^(\d+)d$/.exec(value)
  if (days) {
    const n = Number(days[1])
    if (n <= 0) exitInvalid(command, 'since', value, "duration must be at least 1 day (e.g. '1d', '7d')")
    // `Nd` means "last N calendar days INCLUDING today" → window starts
    // midnight (N-1) days before today.
    return startOfDaysAgo(n - 1)
  }
  const ms = Date.parse(value)
  if (Number.isFinite(ms)) return ms
  exitInvalid(command, 'since', value, "expected ISO date, 'today', or '<n>d' (e.g. 7d)")
}

export function parseUntil(value: unknown, command: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  if (Number.isFinite(ms)) return ms
  exitInvalid(command, 'until', value, 'expected ISO date (e.g. 2026-05-01)')
}

export function exitInvalid(command: string, flag: string, value: string, hint: string): never {
  process.stderr.write(`${command}: invalid --${flag} value "${value}"; ${hint}\n`)
  process.exit(2)
}
