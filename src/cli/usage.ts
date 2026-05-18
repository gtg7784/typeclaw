import { defineCommand } from 'citty'

import { findAgentDir } from '@/init'
import { runUsage } from '@/usage'
import { formatJson, formatReport } from '@/usage/report'

import { parseSince, parseUntil, USAGE_COMMON_ARGS } from './usage-args'

const SUBCOMMANDS = ['daily', 'session', 'models', 'origin'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
type View = 'summary' | Subcommand

const COMMON_ARGS = {
  ...USAGE_COMMON_ARGS,
  cwd: {
    type: 'string' as const,
    description: 'override the agent folder',
  },
}

// Captured by the parent's `setup` hook (which citty runs BEFORE the matched
// subcommand's `run`, with the full parent-level argv parsed). Subcommands
// read this in their own `run` to recover global options like `--since` that
// appeared before the subcommand name. Single-instance CLI processes only —
// no concurrency.
let parentRunArgs: Record<string, unknown> | undefined

const subcommand = (view: View, description: string) =>
  defineCommand({
    meta: { name: view, description },
    args: {
      ...COMMON_ARGS,
      ...(view === 'session' ? { limit: { type: 'string' as const, description: 'max sessions (default 20)' } } : {}),
    },
    async run({ args }) {
      await emit(view, mergeParentArgs(args))
    },
  })

export const usageCommand = defineCommand({
  meta: {
    name: 'usage',
    description: 'report LLM token usage and cost for this agent folder',
  },
  args: COMMON_ARGS,
  setup({ args }) {
    parentRunArgs = args as unknown as Record<string, unknown>
  },
  subCommands: {
    daily: subcommand('daily', 'one row per calendar day'),
    session: subcommand('session', 'top sessions by cost'),
    models: subcommand('models', 'one row per provider/model'),
    origin: subcommand('origin', 'one row per session origin (tui/cron/channel/subagent)'),
  },
  async run({ args }) {
    // citty invokes both the matched subcommand's `run` and the parent's
    // `run`. Suppress the summary when a subcommand was dispatched.
    const first = args._?.[0]
    if (typeof first === 'string' && (SUBCOMMANDS as readonly string[]).includes(first)) return
    await emit('summary', args)
  },
})

// citty's subcommand `run` only sees args that came AFTER the subcommand
// name (the child's rawArgs is pre-sliced), so `usage --since=X origin` would
// silently drop `--since` despite the help text advertising it as a global
// option. The parent's `setup` runs first with the full parent-level parse
// (which includes everything: global options + subcommand options merged),
// so we capture it there and merge it as a fallback under any explicitly-set
// child arg. Child-wins so `usage --since=A origin --since=B` still honours B.
function mergeParentArgs(childArgs: Record<string, unknown>): Record<string, unknown> {
  if (parentRunArgs === undefined) return childArgs
  const merged: Record<string, unknown> = { ...parentRunArgs }
  for (const key of Object.keys(childArgs)) {
    const v = childArgs[key]
    if (v !== undefined && v !== '' && v !== false) merged[key] = v
  }
  return merged
}

async function emit(view: View, args: Record<string, unknown>): Promise<void> {
  const cwdArg = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd()
  const agentDir = findAgentDir(cwdArg) ?? cwdArg
  const since = parseSince(args.since, 'typeclaw usage')
  const until = parseUntil(args.until, 'typeclaw usage')
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

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
