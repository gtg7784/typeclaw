import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TodoScope } from './scope'
import { incompleteTodos, readTodos, type Todo, todoContentPath, writeTodos } from './store'

const TUI_SCOPE: TodoScope = { kind: 'tui', key: 'tui' }
const CHANNEL_SCOPE: TodoScope = { kind: 'channel', key: 'channel/slack-bot:T1:C1:_root' }

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-todo-store-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('todo store', () => {
  test('reading a non-existent scope returns an empty list', async () => {
    expect(await readTodos(agentDir, TUI_SCOPE)).toEqual([])
  })

  test('write then read round-trips the list', async () => {
    const todos: Todo[] = [
      { content: 'first', status: 'pending', priority: 'high' },
      { content: 'second', status: 'in_progress' },
    ]
    await writeTodos(agentDir, TUI_SCOPE, todos)
    expect(await readTodos(agentDir, TUI_SCOPE)).toEqual(todos)
  })

  test('nested scope keys create their parent directories', async () => {
    await writeTodos(agentDir, CHANNEL_SCOPE, [{ content: 'x', status: 'pending' }])
    expect(await readTodos(agentDir, CHANNEL_SCOPE)).toEqual([{ content: 'x', status: 'pending' }])
  })

  test('atomic write leaves no .tmp file behind', async () => {
    await writeTodos(agentDir, TUI_SCOPE, [{ content: 'x', status: 'pending' }])
    const dir = join(agentDir, 'todo')
    const entries = await readdir(dir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
    expect(entries).toContain('tui.json')
  })

  test('the persisted file is valid pretty-printed JSON with a version', async () => {
    await writeTodos(agentDir, TUI_SCOPE, [{ content: 'x', status: 'pending' }])
    const raw = await readFile(todoContentPath(agentDir, TUI_SCOPE), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(raw.endsWith('\n')).toBe(true)
  })

  test('concurrent writes resolve to one of the writers without corruption', async () => {
    const a: Todo[] = [{ content: 'A', status: 'pending' }]
    const b: Todo[] = [{ content: 'B', status: 'pending' }]
    await Promise.all([writeTodos(agentDir, TUI_SCOPE, a), writeTodos(agentDir, TUI_SCOPE, b)])
    const result = await readTodos(agentDir, TUI_SCOPE)
    expect([JSON.stringify(a), JSON.stringify(b)]).toContain(JSON.stringify(result))
  })
})

describe('incompleteTodos', () => {
  test('excludes completed and cancelled, keeps pending and in_progress', () => {
    const todos: Todo[] = [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'cancelled' },
    ]
    expect(incompleteTodos(todos).map((t) => t.content)).toEqual(['a', 'b'])
  })
})
