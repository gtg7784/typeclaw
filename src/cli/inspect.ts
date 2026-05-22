import { defineCommand } from 'citty'

import { findAgentDir } from '@/init'
import { runInspect, type SessionSummary } from '@/inspect'
import { originLabel, shortSessionId } from '@/inspect/label'

import { cancel, c, errorLine, isCancel } from './ui'

export const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'replay a session transcript (host stage)',
  },
  args: {
    session: {
      type: 'positional',
      description: 'session id or short prefix (omit to pick from a list)',
      required: false,
    },
    filter: {
      type: 'string',
      description:
        'category filter: comma-separated meta/user/assistant/tool/error/done; prefix with ! to exclude (e.g. tool,!assistant)',
    },
    since: {
      type: 'string',
      description: 'only events newer than this (forms: 30s, 5m, 1h, 7d)',
    },
    json: {
      type: 'boolean',
      description: 'emit one JSON event per line; requires an explicit session id',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const color = useColor()
    const sessionArg = typeof args.session === 'string' ? args.session : undefined
    const filterArg = typeof args.filter === 'string' ? args.filter : undefined
    const sinceArg = typeof args.since === 'string' ? args.since : undefined

    const result = await runInspect({
      agentDir: cwd,
      ...(sessionArg !== undefined ? { sessionIdOrPrefix: sessionArg } : {}),
      ...(filterArg !== undefined ? { filter: filterArg } : {}),
      ...(sinceArg !== undefined ? { since: sinceArg } : {}),
      json: args.json === true,
      color,
      selectSession: clackSelect,
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    })

    if (!result.ok) {
      process.stderr.write(`${errorLine(result.reason)}\n`)
      process.exit(result.exitCode)
    }
    process.exit(result.exitCode)
  },
})

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

async function clackSelect(sessions: SessionSummary[]): Promise<SessionSummary | null> {
  const { select } = await import('@clack/prompts')
  const picked = await select<string>({
    message: `Pick a session to inspect (showing ${sessions.length})`,
    options: sessions.map((s) => ({
      value: s.sessionId,
      label: formatRowLabel(s),
      ...(s.firstPrompt !== null ? { hint: truncate(s.firstPrompt, 60) } : { hint: '(no prompt)' }),
    })),
    initialValue: sessions[0]?.sessionId,
  })
  if (isCancel(picked)) {
    cancel('Cancelled.')
    return null
  }
  return sessions.find((s) => s.sessionId === picked) ?? null
}

function formatRowLabel(s: SessionSummary): string {
  const id = shortSessionId(s.sessionId)
  const label = s.origin === null ? '(unknown origin)' : originLabel(s.origin)
  const when = formatRelative(s.mtimeMs)
  return `${c.cyan(id)}  ${label}  ${c.dim(when)}`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function truncate(text: string, max: number): string {
  const oneline = text.replace(/\s+/g, ' ').trim()
  if (oneline.length <= max) return oneline
  return `${oneline.slice(0, max)}…`
}
