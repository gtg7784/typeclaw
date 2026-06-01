import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { PermissionService } from '@/permissions'

import type { LiveSubagentRegistry } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import { denySubagentAccess } from './subagent-access'

export type SubagentCancelToolDetails =
  | { ok: true; taskId: string; subagent: string; alreadyDone: boolean }
  | { ok: false; error: string }

export type CreateSubagentCancelToolOptions = {
  liveRegistry: LiveSubagentRegistry
  getOrigin: () => SessionOrigin | undefined
  permissions?: PermissionService
}

export function createSubagentCancelTool(options: CreateSubagentCancelToolOptions) {
  const { liveRegistry, getOrigin, permissions } = options

  return defineTool({
    name: 'subagent_cancel',
    label: 'Cancel Subagent',
    description:
      'Cancel a running subagent you previously spawned. The subagent receives an abort signal and its current in-flight tool call is interrupted. ' +
      'Use this when the user changes their mind, the spawn is no longer needed, or a runaway subagent must be stopped. ' +
      'Cancelling an already-completed or failed subagent is a no-op (returns ok=true with alreadyDone=true).',
    parameters: Type.Object({
      task_id: Type.String({
        description: 'The task_id returned by a previous spawn_subagent call.',
      }),
    }),

    async execute(_toolCallId, params): Promise<ToolReturn> {
      const live = liveRegistry.get(params.task_id)
      if (live === undefined) {
        return errorResult(`Unknown task_id: ${params.task_id}.`)
      }
      const denial = denySubagentAccess(permissions, getOrigin(), live, 'subagent.cancel')
      if (denial !== null) {
        return errorResult(denial)
      }
      if (live.status !== 'running') {
        const details: SubagentCancelToolDetails = {
          ok: true,
          taskId: live.taskId,
          subagent: live.subagentName,
          alreadyDone: true,
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `${live.subagentName} (${live.taskId}) is already ${live.status}; nothing to cancel.`,
            },
          ],
          details,
        }
      }
      try {
        await live.abort()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`abort failed: ${message}`)
      }
      const details: SubagentCancelToolDetails = {
        ok: true,
        taskId: live.taskId,
        subagent: live.subagentName,
        alreadyDone: false,
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `${live.subagentName} (${live.taskId}) cancellation requested. It will stop on the next abort checkpoint.`,
          },
        ],
        details,
      }
    },
  })
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: SubagentCancelToolDetails
}

function errorResult(message: string): ToolReturn {
  const details: SubagentCancelToolDetails = { ok: false, error: message }
  return {
    content: [{ type: 'text', text: message }],
    details,
  }
}
