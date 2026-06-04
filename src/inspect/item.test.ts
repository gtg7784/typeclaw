import { describe, expect, test } from 'bun:test'

import { isWritable, itemKey, type ViewerItem } from './item'

const summary = {
  sessionId: 'sid-1',
  sessionFile: '/x/sid-1.jsonl',
  basename: 'sid-1.jsonl',
  mtimeMs: 1,
  origin: { kind: 'tui' as const },
  firstPrompt: null,
}

describe('ViewerItem helpers', () => {
  test('isWritable is true only for the tui item', () => {
    expect(isWritable({ kind: 'tui', summary, writable: true })).toBe(true)
    expect(isWritable({ kind: 'session', summary, writable: false })).toBe(false)
    expect(isWritable({ kind: 'logs' })).toBe(false)
  })

  test('itemKey returns the session id for sessions and a stable key for logs', () => {
    const tui: ViewerItem = { kind: 'tui', summary, writable: true }
    const session: ViewerItem = { kind: 'session', summary, writable: false }
    expect(itemKey(tui)).toBe('sid-1')
    expect(itemKey(session)).toBe('sid-1')
    expect(itemKey({ kind: 'logs' })).toBe('logs')
  })
})
