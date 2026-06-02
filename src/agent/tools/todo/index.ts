import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { SessionOrigin } from '@/agent/session-origin'
import { resolveTodoScope } from '@/agent/todo/scope'
import { incompleteTodos, type Todo, TODO_PRIORITIES, TODO_STATUSES, readTodos, writeTodos } from '@/agent/todo/store'

export type CreateTodoToolsOptions = {
  agentDir: string
  getOrigin: () => SessionOrigin | undefined
}

const SUBAGENT_NOTICE =
  'Todos are owned by the originating session, not by subagents. This call was a no-op. ' +
  'Report your result to the parent instead.'

type TodoToolDetails = {
  ok: boolean
  reason?: string
  total?: number
  remaining?: number
}

const TODO_ITEM = Type.Object({
  content: Type.String({ minLength: 1, description: 'What the task is.' }),
  status: Type.Union(
    TODO_STATUSES.map((s) => Type.Literal(s)),
    { description: 'One of: pending, in_progress, completed, cancelled.' },
  ),
  priority: Type.Optional(Type.Union(TODO_PRIORITIES.map((p) => Type.Literal(p)))),
  id: Type.Optional(Type.String()),
})

export function createTodoTools({ agentDir, getOrigin }: CreateTodoToolsOptions) {
  const writeTool = defineTool({
    name: 'todo_write',
    label: 'Write Todos',
    description:
      'Replace your entire todo list for this session with the provided items. Maintain a todo ' +
      'list for any multi-step or long-running task so that if this session is interrupted ' +
      '(restart, crash, or a later turn), you can resume the remaining work instead of silently ' +
      'dropping it. Mark items `completed` (or `cancelled`) as you finish them by writing the full ' +
      'list again with updated statuses. This is a full replace, not a merge: include every item ' +
      'you still care about on each call.',
    parameters: Type.Object({
      todos: Type.Array(TODO_ITEM, { description: 'The complete todo list. Replaces any prior list.' }),
    }),
    async execute(_toolCallId, params) {
      const scope = resolveTodoScope(getOrigin() ?? { kind: 'tui', sessionId: 'unknown' })
      if (scope === null) {
        const details: TodoToolDetails = { ok: false, reason: 'no-scope' }
        return { content: [{ type: 'text' as const, text: SUBAGENT_NOTICE }], details }
      }
      const todos = params.todos as Todo[]
      await writeTodos(agentDir, scope, todos)
      const remaining = incompleteTodos(todos).length
      const details: TodoToolDetails = { ok: true, total: todos.length, remaining }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved ${todos.length} todo(s); ${remaining} remaining (${todos.length - remaining} done).`,
          },
        ],
        details,
      }
    },
  })

  const readTool = defineTool({
    name: 'todo_read',
    label: 'Read Todos',
    description: 'Return your current todo list for this session. Use it to re-sync after an interruption.',
    parameters: Type.Object({}),
    async execute() {
      const scope = resolveTodoScope(getOrigin() ?? { kind: 'tui', sessionId: 'unknown' })
      if (scope === null) {
        const details: TodoToolDetails = { ok: false, reason: 'no-scope' }
        return { content: [{ type: 'text' as const, text: SUBAGENT_NOTICE }], details }
      }
      const todos = await readTodos(agentDir, scope)
      const details: TodoToolDetails = { ok: true, total: todos.length }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(todos, null, 2) }],
        details,
      }
    },
  })

  const clearTool = defineTool({
    name: 'todo_clear',
    label: 'Clear Todos',
    description:
      'Empty your todo list for this session. Call this when all work is genuinely done or the ' +
      'task was abandoned, so the runtime stops tracking pending work.',
    parameters: Type.Object({}),
    async execute() {
      const scope = resolveTodoScope(getOrigin() ?? { kind: 'tui', sessionId: 'unknown' })
      if (scope === null) {
        const details: TodoToolDetails = { ok: false, reason: 'no-scope' }
        return { content: [{ type: 'text' as const, text: SUBAGENT_NOTICE }], details }
      }
      await writeTodos(agentDir, scope, [])
      const details: TodoToolDetails = { ok: true }
      return { content: [{ type: 'text' as const, text: 'Todo list cleared.' }], details }
    },
  })

  return [writeTool, readTool, clearTool]
}
