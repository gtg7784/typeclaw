import { defineCommand } from 'citty'

import { findAgentDir } from '@/init'
import { runUsage, startOfDaysAgo, startOfToday } from '@/usage'
import { formatJson, formatReport } from '@/usage/report'

const SUBCOMMANDS = ['daily', 'session', 'models'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
type View = 'summary' | Subcommand

const COMMON_ARGS = {
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
  cwd: {
    type: 'string' as const,
    description: 'override the agent folder',
  },
}

const subcommand = (view: View, description: string) =>
  defineCommand({
    meta: { name: view, description },
    args: {
      ...COMMON_ARGS,
      ...(view === 'session' ? { limit: { type: 'string' as const, description: 'max sessions (default 20)' } } : {}),
    },
    async run({ args }) {
      await emit(view, args)
    },
  })

export const usageCommand = defineCommand({
  meta: {
    name: 'usage',
    description: 'report LLM token usage and cost for this agent folder',
  },
  args: COMMON_ARGS,
  subCommands: {
    daily: subcommand('daily', 'one row per calendar day'),
    session: subcommand('session', 'top sessions by cost'),
    models: subcommand('models', 'one row per provider/model'),
  },
  async run({ args }) {
    // citty invokes both the matched subcommand's `run` and the parent's
    // `run`. Suppress the summary when a subcommand was dispatched.
    const first = args._?.[0]
    if (typeof first === 'string' && (SUBCOMMANDS as readonly string[]).includes(first)) return
    await emit('summary', args)
  },
})

async function emit(view: View, args: Record<string, unknown>): Promise<void> {
  const cwdArg = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd()
  const agentDir = findAgentDir(cwdArg) ?? cwdArg
  const since = parseSince(args.since, 'since')
  const until = parseUntil(args.until, 'until')
  const limit = parseLimit(args.limit)

  const report = await runUsage({
    agentDir,
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  })

  if (args.json === true) {
    process.stdout.write(`${formatJson(report)}\n`)
    return
  }

  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  const terminalWidth = resolveTerminalWidth()
  const text = formatReport(report, {
    useColor,
    view,
    ...(terminalWidth !== undefined ? { terminalWidth } : {}),
    ...(limit !== undefined ? { limit } : {}),
  })
  process.stdout.write(`${text}\n`)
}

function resolveTerminalWidth(): number | undefined {
  // process.stdout.columns is undefined when stdout is not a TTY (piped to
  // less/grep/file). Fall back to $COLUMNS so users can force a width when
  // piping, and so tests with an inherited COLUMNS env var see the override.
  if (process.stdout.columns !== undefined) return process.stdout.columns
  const env = process.env.COLUMNS
  if (env === undefined || env === '') return undefined
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseSince(value: unknown, flag: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (value === 'today') return startOfToday()
  const days = /^(\d+)d$/.exec(value)
  if (days) {
    const n = Number(days[1])
    if (n <= 0) exitInvalid(flag, value, "duration must be at least 1 day (e.g. '1d', '7d')")
    // `Nd` means "last N calendar days INCLUDING today" → window starts
    // midnight (N-1) days before today.
    return startOfDaysAgo(n - 1)
  }
  const ms = Date.parse(value)
  if (Number.isFinite(ms)) return ms
  exitInvalid(flag, value, "expected ISO date, 'today', or '<n>d' (e.g. 7d)")
}

function parseUntil(value: unknown, flag: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  if (Number.isFinite(ms)) return ms
  exitInvalid(flag, value, 'expected ISO date (e.g. 2026-05-01)')
}

function exitInvalid(flag: string, value: string, hint: string): never {
  process.stderr.write(`typeclaw usage: invalid --${flag} value "${value}"; ${hint}\n`)
  process.exit(2)
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
