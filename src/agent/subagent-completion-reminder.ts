// Shared renderer for the `<system-reminder>` block injected into a parent
// session's prompt queue when one of its backgrounded subagents finishes.
// Used today by the TUI route in src/server/index.ts; future surfaces
// (channel sessions) can call the same renderer so the model sees
// identical wording across origins.

export type CompletionReminderArgs = {
  subagent: string
  taskId: string
  ok: boolean
  durationMs: number
  error?: string
}

export function renderSubagentCompletionReminder(args: CompletionReminderArgs): string {
  const durationStr = formatReminderDuration(args.durationMs)
  if (args.ok) {
    return (
      `<system-reminder>\n` +
      `Subagent \`${args.subagent}\` (${args.taskId}) completed in ${durationStr}. ` +
      `Use subagent_output to fetch the result.\n` +
      `</system-reminder>`
    )
  }
  const err = args.error ?? 'unknown error'
  return (
    `<system-reminder>\n` +
    `Subagent \`${args.subagent}\` (${args.taskId}) FAILED after ${durationStr}: ${err}. ` +
    `Use subagent_output to inspect.\n` +
    `</system-reminder>`
  )
}

export function formatReminderDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m${sec}s`
}

export type SubagentCompletedPayload = {
  taskId: string
  subagent: string
  parentSessionId: string
  ok: boolean
  durationMs: number
  error?: string
}

// Type guard for the `subagent.completed` broadcast payload. Subscribers
// to `target: { kind: 'broadcast' }` see every broadcast; this guard
// filters and narrows in one place so callers don't repeat the
// typeof-checking dance.
export function parseSubagentCompletedPayload(payload: unknown): SubagentCompletedPayload | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as {
    kind?: unknown
    taskId?: unknown
    subagent?: unknown
    parentSessionId?: unknown
    ok?: unknown
    durationMs?: unknown
    error?: unknown
  }
  if (p.kind !== 'subagent.completed') return null
  if (typeof p.parentSessionId !== 'string') return null
  return {
    taskId: typeof p.taskId === 'string' ? p.taskId : '<unknown>',
    subagent: typeof p.subagent === 'string' ? p.subagent : 'subagent',
    parentSessionId: p.parentSessionId,
    ok: p.ok === true,
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
    ...(typeof p.error === 'string' ? { error: p.error } : {}),
  }
}
