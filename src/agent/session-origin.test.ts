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

  test('channel origin shows the addressing fields and points at channel_reply by default', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: null,
    })
    expect(out).toContain('Discord channel session')
    expect(out).toContain('"adapter": "discord-bot"')
    expect(out).toContain('"workspace": "111"')
    expect(out).toContain('"chat": "222"')
    expect(out).toContain('channel_reply')
    expect(out).toContain('channel_send')
    expect(out).toContain('<@USER_ID>')
    expect(out).toContain('Be concise')
  })

  test('channel origin renders thread:null verbatim for channel-root sessions', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).toContain('"thread": null')
    expect(out).toContain('channel-root session')
  })

  test('channel origin includes thread field with the actual id when origin.thread is set', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: 't-1',
    })
    expect(out).toContain('"thread": "t-1"')
  })

  test('channel origin obligates a tool call so the model never finishes silently', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).toMatch(/MUST call `channel_reply`/)
    expect(out).toContain('Plain-text output is invisible')
  })

  test('channel origin teaches channel_reply as the default and channel_send as the escape hatch', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: '1700000000.000100',
    })
    expect(out).toContain('channel_reply({ text })')
    expect(out).toContain("don't")
    expect(out).toMatch(/post somewhere else/i)
    const replyIdx = out.indexOf('`channel_reply`')
    const sendIdx = out.indexOf('`channel_send`')
    expect(replyIdx).toBeGreaterThan(-1)
    expect(sendIdx).toBeGreaterThan(-1)
  })

  test('channel origin renders @dm sentinel verbatim', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).toContain('"workspace": "@dm"')
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
    // Format is `<@id> (name)` so the model copies the leading `<@id>` token
    // verbatim when addressing a peer. The old `name (id: 123)` format
    // trained the model that `<@id>` was just rendering chrome.
    expect(out).toContain('<@1> (alice)')
    expect(out).toContain('<@2> (bob)')
    expect(out).not.toContain('alice  (id: 1)')
  })

  test('channel origin includes a concrete worked example for mention syntax', () => {
    // given: a peer bot in the channel
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '999',
        authorName: 'Winky',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
        isBot: true,
      },
      {
        authorId: '111',
        authorName: 'alice',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
      },
    ]

    // when
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '222', thread: null, participants },
      now,
    )

    // then: the example uses the peer bot's real id and name
    expect(out).toContain('<@999> hello')
    expect(out).toContain('Winky')
    expect(out).toContain('Plain-text names do not notify')
  })

  test('channel origin mention example falls back to a placeholder when no participants exist', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
      participants: [],
    })
    expect(out).toContain('<@123456789> hello')
    expect(out).toContain('PeerBot')
  })

  test('channel origin mention example prefers a peer bot over a human participant', () => {
    // The example needs to demonstrate the failure mode — peer-bot addressing —
    // not the human-addressing case which is forgiving in practice.
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '111',
        authorName: 'alice',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
      },
      {
        authorId: '999',
        authorName: 'Winky',
        firstMessageAt: now - 60_000,
        lastMessageAt: now - 60_000,
        messageCount: 2,
        isBot: true,
      },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '222', thread: null, participants },
      now,
    )
    expect(out).toContain('<@999> hello')
    expect(out).not.toContain('<@111> hello')
  })

  test('channel origin sorts participants by recency descending', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '1',
        authorName: 'older',
        firstMessageAt: now - 100_000,
        lastMessageAt: now - 100_000,
        messageCount: 1,
      },
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

  test('channel origin shows human-readable workspace and chat names alongside raw IDs', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      workspaceName: 'Acme Corp',
      chat: 'C0DEPLOY',
      chatName: 'deploy',
      thread: null,
    })
    expect(out).toContain('Acme Corp')
    expect(out).toContain('T0ACME')
    expect(out).toContain('#deploy')
    expect(out).toContain('C0DEPLOY')
    expect(out).toContain('"workspace": "T0ACME"')
    expect(out).toContain('"chat": "C0DEPLOY"')
  })

  test('channel origin uses # prefix for Slack channels, bare name for Discord', () => {
    const slackOut = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      workspaceName: 'Acme',
      chat: 'C0',
      chatName: 'general',
      thread: null,
    })
    expect(slackOut).toContain('#general')

    const discordOut = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      workspaceName: 'Acme Guild',
      chat: '222',
      chatName: 'general',
      thread: null,
    })
    expect(discordOut).toContain('general')
    expect(discordOut).not.toContain('#general')
  })

  test('channel origin renders even when chatName is missing (workspace name only)', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      workspaceName: 'Acme',
      chat: 'C0',
      thread: null,
    })
    expect(out).toContain('Acme')
    expect(out).toContain('C0')
  })

  test('channel origin emits no malformed name prose when both names are absent', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).not.toMatch(/in \*\*\*\*/)
    expect(out).not.toContain('undefined')
  })

  test('channel origin keeps the @dm workspace sentinel in the JSON block', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: '@dm',
      chat: 'D0DMID',
      thread: null,
    })
    expect(out).toContain('"workspace": "@dm"')
  })

  test('channel origin renders exact Slack membership summary', () => {
    const now = 100_000
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: null,
        membership: { humans: 12, bots: 35, fetchedAt: now, truncated: false },
      },
      now,
    )

    expect(out).toContain('This channel has 47 members: 12 humans, 35 bots.')
    expect(out).toContain('The 10 most recent speakers are listed below.')
    expect(out).not.toContain('guild members')
  })

  test('channel origin renders Discord guild-level caveat for exact counts', () => {
    const now = 100_000
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'discord-bot',
        workspace: 'G0',
        chat: 'C0',
        thread: null,
        membership: { humans: 12, bots: 35, fetchedAt: now, truncated: false },
      },
      now,
    )

    expect(out).toContain('This channel has 47 members: 12 humans, 35 bots.')
    expect(out).toContain('this is the count of guild members')
  })

  test('channel origin renders large-channel truncated summary', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
      membership: { humans: 195, bots: 5, fetchedAt: 0, truncated: true },
    })

    expect(out).toContain('approximately 200 members (about 195 humans, 5 bots')
    expect(out).toContain('exceeds the 50-member cap')
  })

  test('channel origin adds Discord caveat to truncated summaries', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'G0',
      chat: 'C0',
      thread: null,
      membership: { humans: 195, bots: 5, fetchedAt: 0, truncated: true },
    })

    expect(out).toContain('approximately 200 members')
    expect(out).toContain('private channels with permission overwrites')
  })

  test('channel origin omits member summary when membership is missing', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    })

    expect(out).not.toContain('This channel has')
    expect(out).not.toContain('members:')
  })
})
