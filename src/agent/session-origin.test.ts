import { describe, expect, test } from 'bun:test'

import { renderSessionOrigin, type ChannelParticipant } from './session-origin'

describe('renderSessionOrigin', () => {
  test('TUI origin tells the agent the operator is attached', () => {
    const out = renderSessionOrigin({ kind: 'tui', sessionId: 'ses_abc' })
    expect(out).toContain('## Session origin')
    expect(out).toContain('TUI session')
    expect(out).toContain('Verbose explanations are welcome')
  })

  test('cron origin includes job id and kind, and tells the agent no human is watching', () => {
    const out = renderSessionOrigin({ kind: 'cron', jobId: 'job-42', jobKind: 'prompt' })
    expect(out).toContain('unattended cron job')
    expect(out).toContain('job-42')
    expect(out).toContain('Job kind: prompt')
    expect(out).toContain('No human is watching this turn')
  })

  test('subagent origin names the subagent and parent', () => {
    const out = renderSessionOrigin({
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'ses_parent',
    })
    expect(out).toContain('`memory-logger` subagent')
    expect(out).toContain('ses_parent')
    expect(out).toContain('Stay narrowly within')
  })

  test('channel origin emits the addressing 4-tuple and channel_send guidance', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: null,
    })
    expect(out).toContain('Discord channel session')
    expect(out).toContain('Adapter:   discord-bot')
    expect(out).toContain('Workspace: 111')
    expect(out).toContain('Chat:      222')
    expect(out).toContain('Thread:    null')
    expect(out).toContain('channel_send')
    expect(out).toContain('<@USER_ID>')
    expect(out).toContain('Be concise')
  })

  test('channel origin renders @dm sentinel verbatim', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).toContain('Workspace: @dm')
  })

  test('channel origin includes participants block when participants are fresh', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      { authorId: '1', authorName: 'alice', firstMessageAt: now - 1000, lastMessageAt: now - 1000, messageCount: 5 },
      { authorId: '2', authorName: 'bob', firstMessageAt: now - 60_000, lastMessageAt: now - 60_000, messageCount: 2 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    expect(out).toContain('Recent participants')
    expect(out).toContain('alice')
    expect(out).toContain('bob')
    expect(out).toContain('id: 1')
    expect(out).toContain('id: 2')
  })

  test('channel origin sorts participants by recency descending', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      { authorId: '1', authorName: 'older', firstMessageAt: now - 100_000, lastMessageAt: now - 100_000, messageCount: 1 },
      { authorId: '2', authorName: 'newer', firstMessageAt: now - 1000, lastMessageAt: now - 1000, messageCount: 1 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    const newerIdx = out.indexOf('newer')
    const olderIdx = out.indexOf('older')
    expect(newerIdx).toBeGreaterThan(-1)
    expect(olderIdx).toBeGreaterThan(-1)
    expect(newerIdx).toBeLessThan(olderIdx)
  })

  test('channel origin caps participants at 10 in the rendered output', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = []
    for (let i = 0; i < 25; i++) {
      participants.push({
        authorId: String(i),
        authorName: `user${i}`,
        firstMessageAt: now - i * 1000,
        lastMessageAt: now - i * 1000,
        messageCount: 1,
      })
    }
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    expect(out).toContain('user0')
    expect(out).toContain('user9')
    expect(out).not.toContain('user10')
    expect(out).not.toContain('user24')
  })

  test('channel origin drops participants older than 7 days', () => {
    const now = Date.now()
    const old = now - 8 * 24 * 60 * 60 * 1000
    const participants: ChannelParticipant[] = [
      { authorId: '1', authorName: 'staleuser', firstMessageAt: old, lastMessageAt: old, messageCount: 99 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    expect(out).not.toContain('staleuser')
    expect(out).not.toContain('Recent participants')
  })

  test('channel origin omits participants block entirely when none are fresh', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
      participants: [],
    })
    expect(out).not.toContain('Recent participants')
    expect(out).toContain('Be concise')
  })
})
