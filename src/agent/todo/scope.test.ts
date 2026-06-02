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
    expect(scope).toEqual({ kind: 'channel', key: 'channel/slack-bot:T123:C456:1700000000.0001' })
  })

  test('channel with null thread uses the _root sentinel', () => {
    const scope = resolveTodoScope({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'G1',
      chat: 'C1',
      thread: null,
    })
    expect(scope).toEqual({ kind: 'channel', key: 'channel/discord-bot:G1:C1:_root' })
  })

  test('channel ids with path-unsafe characters are sanitized', () => {
    const scope = resolveTodoScope({
      kind: 'channel',
      adapter: 'kakaotalk',
      workspace: 'ws/../escape',
      chat: 'chat:with:colons and spaces',
      thread: 'a/b',
    })
    expect(scope?.key).toBe('channel/kakaotalk:ws-..-escape:chat-with-colons-and-spaces:a-b')
    expect(scope?.key).not.toContain('/escape')
    expect(scope?.key.split('/')).toHaveLength(2)
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
