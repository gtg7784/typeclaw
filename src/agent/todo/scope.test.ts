import { describe, expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import { resolveTodoScope } from './scope'

describe('resolveTodoScope', () => {
  test('tui resolves to the singleton tui scope regardless of sessionId', () => {
    const a = resolveTodoScope({ kind: 'tui', sessionId: 'ses_one' })
    const b = resolveTodoScope({ kind: 'tui', sessionId: 'ses_two' })
    expect(a).toEqual({ kind: 'tui', key: 'tui' })
    expect(b).toEqual({ kind: 'tui', key: 'tui' })
  })

  test('cron resolves to a jobId-keyed scope', () => {
    const scope = resolveTodoScope({ kind: 'cron', jobId: 'daily-standup', jobKind: 'prompt' })
    expect(scope).toEqual({ kind: 'cron', key: 'cron/daily-standup' })
  })

  test('channel resolves to an adapter:workspace:chat:thread tuple', () => {
    const scope = resolveTodoScope({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T123',
      chat: 'C456',
      thread: '1700000000.0001',
    })
    expect(scope).toEqual({ kind: 'channel', key: 'channel/slack-bot:T123:C456:1:1700000000.0001' })
  })

  test('channel with null thread uses the distinct null-thread tag', () => {
    const scope = resolveTodoScope({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'G1',
      chat: 'C1',
      thread: null,
    })
    expect(scope).toEqual({ kind: 'channel', key: 'channel/discord-bot:G1:C1:0:' })
  })

  test('channel ids with path-unsafe characters are encoded, not escaping the todo dir', () => {
    const scope = resolveTodoScope({
      kind: 'channel',
      adapter: 'kakaotalk',
      workspace: 'ws/../escape',
      chat: 'chat:with:colons and spaces',
      thread: 'a/b',
    })
    // Path separators are percent-encoded (%2F), so even a literal ".." in a
    // component cannot traverse out of todo/ — there is no unencoded slash
    // around it. The key stays a single path segment under channel/.
    expect(scope?.key.startsWith('channel/')).toBe(true)
    expect(scope?.key.split('/')).toHaveLength(2)
    expect(scope?.key).not.toContain('/..')
    expect(scope?.key).not.toContain('../')
  })

  test('the scope key encoding is injective (distinct origins never collide)', () => {
    const keyFor = (chat: string) =>
      resolveTodoScope({ kind: 'channel', adapter: 'slack-bot', workspace: 'w', chat, thread: null })?.key

    // The reviewer's concrete collision cases must all map to distinct keys.
    expect(keyFor('a/b')).not.toBe(keyFor('a-b'))
    expect(keyFor('a:b')).not.toBe(keyFor('a-b'))
    expect(keyFor('a/b')).not.toBe(keyFor('a:b'))
  })

  test('a null thread never collides with a literal "_root" thread id', () => {
    const base = { kind: 'channel', adapter: 'slack-bot', workspace: 'w', chat: 'c' } as const
    const nullThread = resolveTodoScope({ ...base, thread: null })?.key
    const rootLiteral = resolveTodoScope({ ...base, thread: '_root' })?.key
    expect(nullThread).not.toBe(rootLiteral)
  })

  test('cron jobIds are encoded injectively too', () => {
    const a = resolveTodoScope({ kind: 'cron', jobId: 'a/b', jobKind: 'prompt' })?.key
    const b = resolveTodoScope({ kind: 'cron', jobId: 'a-b', jobKind: 'prompt' })?.key
    expect(a).not.toBe(b)
  })

  test('subagent owns no todo scope', () => {
    const scope = resolveTodoScope({ kind: 'subagent', subagent: 'scout', parentSessionId: 'ses_parent' })
    expect(scope).toBeNull()
  })

  test('system owns no todo scope', () => {
    const scope = resolveTodoScope({ kind: 'system', component: 'memory-logger' })
    expect(scope).toBeNull()
  })
})
