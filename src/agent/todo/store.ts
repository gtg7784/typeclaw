import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { TodoScope } from './scope'

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

export type Todo = {
  content: string
  status: TodoStatus
  priority?: TodoPriority
  id?: string
}

type TodoFile = {
  version: 1
  todos: Todo[]
}

export function todoDir(agentDir: string): string {
  return join(agentDir, 'todo')
}

export function todoContentPath(agentDir: string, scope: TodoScope): string {
  return join(todoDir(agentDir), `${scope.key}.json`)
}

export async function readTodos(agentDir: string, scope: TodoScope): Promise<Todo[]> {
  const path = todoContentPath(agentDir, scope)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
  const parsed = JSON.parse(raw) as Partial<TodoFile>
  return Array.isArray(parsed.todos) ? parsed.todos : []
}

// Write is atomic (temp file + rename) so a crash mid-write can never leave a
// half-serialized JSON file that the next read would throw on. Mirrors the
// channels/sessions.json writer. A scope is normally owned by a single live
// session (see resolveTodoScope), so the only concurrent writers are the rare
// duplicate-attach case, where last-writer-wins on the rename is acceptable —
// the alternative (lost-update detection) is not worth a lock for a todo list.
export async function writeTodos(agentDir: string, scope: TodoScope, todos: Todo[]): Promise<void> {
  const path = todoContentPath(agentDir, scope)
  const payload: TodoFile = { version: 1, todos }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export function incompleteTodos(todos: readonly Todo[]): Todo[] {
  return todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
