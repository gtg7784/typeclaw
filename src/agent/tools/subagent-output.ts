import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { PermissionService } from '@/permissions'

import type { LiveSubagentRegistry, StatusSnapshot, SubagentProgressEvent } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000

export type SubagentOutputToolDetails =
  | {
      ok: true
      status: 'running'
      taskId: string
      subagent: string
      startedAt: number
      elapsedMs: number
      eventsCount: number
      eventsRecent: SubagentProgressEvent[]
      lastActivity: SubagentProgressEvent | null
      statusSummary: string
    }
  | {
      ok: true
      status: 'completed'
      taskId: string
      subagent: string
      durationMs: number
      finalMessage?: string
    }
  | {
      ok: true
      status: 'failed'
      taskId: string
      subagent: string
      durationMs: number
      error: string
    }
  | { ok: false; error: string }

export type CreateSubagentOutputToolOptions = {
  liveRegistry: LiveSubagentRegistry
  getOrigin: () => SessionOrigin | undefined
  permissions?: PermissionService
  now?: () => number
}

export function createSubagentOutputTool(options: CreateSubagentOutputToolOptions) {
  const { liveRegistry, getOrigin, permissions, now = () => Date.now() } = options

  return defineTool({
    name: 'subagent_output',
    label: 'Subagent Output',
    description:
      'Fetch the current state of a subagent you previously spawned. Returns one of three statuses: ' +
      "'running' (with a human-readable status_summary and a tail of recent progress events), " +
      "'completed' (with the final message), or 'failed' (with the error). " +
      'Use this when the user asks how a long-running subagent is going, or when you need to retrieve the result of a backgrounded spawn. ' +
      'When block=true (default false), the tool waits up to timeout_ms for completion before returning. ' +
      'Prefer block=false and rely on the system-reminder for completion notification; reserve block=true for tight workflows.',
    parameters: Type.Object({
      task_id: Type.String({
        description: 'The task_id returned by a previous spawn_subagent call.',
      }),
      block: Type.Optional(
        Type.Boolean({
          description:
            'If true, wait for the subagent to complete (or time out) before returning. Default false: return immediately with the current state.',
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          description: `When block=true, max milliseconds to wait (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      if (permissions !== undefined && !permissions.has(getOrigin(), 'subagent.output')) {
        return errorResult('subagent.output denied: insufficient permissions')
      }
      const live = liveRegistry.get(params.task_id)
      if (live === undefined) {
        return errorResult(`Unknown task_id: ${params.task_id}.`)
      }

      const wantsBlock = params.block === true && live.status === 'running'
      if (wantsBlock) {
        const timeoutMs = clampTimeout(params.timeout_ms)
        await raceWithTimeout(live.awaitCompletion(), timeoutMs)
      }

      const snap = liveRegistry.snapshot(params.task_id, now())
      if (snap === undefined) {
        return errorResult(`Unknown task_id: ${params.task_id}.`)
      }
      return renderSnapshot(snap)
    },
  })
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(1, Math.floor(value)), MAX_TIMEOUT_MS)
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: SubagentOutputToolDetails
}

function renderSnapshot(snap: StatusSnapshot): ToolReturn {
  if (snap.status === 'running') {
    const details: SubagentOutputToolDetails = {
      ok: true,
      status: 'running',
      taskId: snap.taskId,
      subagent: snap.subagentName,
      startedAt: snap.startedAt,
      elapsedMs: snap.elapsedMs,
      eventsCount: snap.eventsCount,
      eventsRecent: snap.eventsRecent,
      lastActivity: snap.lastActivity,
      statusSummary: snap.statusSummary,
    }
    return {
      content: [{ type: 'text' as const, text: snap.statusSummary }],
      details,
    }
  }
  if (snap.status === 'completed') {
    const finalMessage = snap.completion?.finalMessage
    const details: SubagentOutputToolDetails = {
      ok: true,
      status: 'completed',
      taskId: snap.taskId,
      subagent: snap.subagentName,
      durationMs: snap.completion?.durationMs ?? snap.elapsedMs,
      ...(finalMessage !== undefined ? { finalMessage } : {}),
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: finalMessage ?? `${snap.subagentName} completed in ${details.durationMs}ms with no final message.`,
        },
      ],
      details,
    }
  }
  const error = snap.completion?.error ?? 'unknown error'
  const details: SubagentOutputToolDetails = {
    ok: true,
    status: 'failed',
    taskId: snap.taskId,
    subagent: snap.subagentName,
    durationMs: snap.completion?.durationMs ?? snap.elapsedMs,
    error,
  }
  return {
    content: [{ type: 'text' as const, text: `${snap.subagentName} failed after ${details.durationMs}ms: ${error}` }],
    details,
  }
}

function errorResult(message: string): ToolReturn {
  const details: SubagentOutputToolDetails = { ok: false, error: message }
  return {
    content: [{ type: 'text', text: message }],
    details,
  }
}
