import { describe, expect, test } from 'bun:test'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, type SlackInboundMessageEvent } from './slack-bot-classify'

const TEAM_ID = 'T0ACME'
const BOT_USER_ID = 'UBOT'

const baseConfig: ChannelAdapterConfig = {
  allow: ['*'],
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function buildEvent(overrides: Partial<SlackInboundMessageEvent> = {}): SlackInboundMessageEvent {
  return {
    type: 'message',
    channel: 'C0CHANNEL',
    channel_type: 'channel',
    user: 'UALICE',
    text: 'hello',
    ts: '1700000000.000100',
    ...overrides,
  }
}

describe('slack-bot classifyInbound — drop paths', () => {
  test('drops self-authored messages (event.user === botUserId) with reason=self_author', () => {
    const event = buildEvent({ user: BOT_USER_ID })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops events with no user (e.g. system events) with reason=no_user', () => {
    const event = buildEvent({ user: undefined })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'no_user' })
  })

  test('drops messages with neither text nor files with reason=empty_text', () => {
    const event = buildEvent({ text: '' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('routes file-only uploads (empty text) with attachment summary so the agent sees the upload', () => {
    const event = buildEvent({
      text: '',
      files: [
        {
          id: 'F1',
          name: 'diagram.png',
          title: 'diagram',
          mimetype: 'image/png',
          size: 1234,
          url_private: 'https://files.slack.com/f/F1/diagram.png',
          created: 1700000000,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Slack message with attachment: diagram.png (image/png) id=F1]')
  })

  test('appends attachment summary to user text so the agent sees BOTH text and the file when the user typed something alongside the upload', () => {
    const event = buildEvent({
      text: 'look at this',
      files: [
        {
          id: 'F1',
          name: 'diagram.png',
          title: 'diagram',
          mimetype: 'image/png',
          size: 1234,
          url_private: 'https://files.slack.com/f/F1/diagram.png',
          created: 1700000000,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('look at this\n[Slack message with attachment: diagram.png (image/png) id=F1]')
  })

  test('multiple file uploads each surface as a separate attachment ref so the agent can fetch any of them', () => {
    const event = buildEvent({
      text: '',
      files: [
        {
          id: 'F1',
          name: 'one.png',
          title: 'one',
          mimetype: 'image/png',
          size: 1,
          url_private: 'https://files.slack.com/f/F1/one.png',
          created: 1700000000,
          user: 'UALICE',
        },
        {
          id: 'F2',
          name: 'two.txt',
          title: 'two',
          mimetype: 'text/plain',
          size: 2,
          url_private: 'https://files.slack.com/f/F2/two.txt',
          created: 1700000001,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe(
      '[Slack message with attachment: one.png (image/png) id=F1; attachment: two.txt (text/plain) id=F2]',
    )
  })

  test('appended attachment summary does not register `<@…>` ids inside file URLs as bot mentions', () => {
    const event = buildEvent({
      text: 'check this',
      files: [
        {
          id: 'F1',
          name: 'note.txt',
          title: 'note',
          mimetype: 'text/plain',
          size: 1,
          url_private: `https://files.slack.com/<@${BOT_USER_ID}>/F1/note.txt`,
          created: 1700000000,
          user: 'UALICE',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('drops messages from a team not in the allow list with reason=not_in_allow_list', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['team:T0OTHER'] }
    const event = buildEvent()

    const verdict = classifyInbound(event, config, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('drops a DM when allow list only covers team channels', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: ['team:*'] }
    const event = buildEvent({ channel_type: 'im', channel: 'D0DMID' })

    const verdict = classifyInbound(event, config, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'not_in_allow_list' })
  })

  test('self_author wins over allow filtering (drop reasons checked first)', () => {
    const config: ChannelAdapterConfig = { ...baseConfig, allow: [] }
    const event = buildEvent({ user: BOT_USER_ID })

    const verdict = classifyInbound(event, config, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops messages before bot identity is known with reason=pre_connect', () => {
    const event = buildEvent({ text: 'no explicit mention' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })
})

describe('slack-bot classifyInbound — peer-bot routing', () => {
  test('routes a peer bot with bot_id set and authorIsBot=true', () => {
    const event = buildEvent({ user: 'UPEERBOT', bot_id: 'B999', text: 'hello from peer' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(true)
    expect(verdict.payload.authorId).toBe('UPEERBOT')
  })

  test('routes a peer bot with subtype=bot_message and a user, with authorIsBot=true', () => {
    const event = buildEvent({ user: 'UPEERBOT', subtype: 'bot_message', text: 'announcement' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(true)
  })

  test('routes a human message with authorIsBot=false', () => {
    const event = buildEvent({ user: 'UALICE', text: 'hello team' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(false)
  })

  test('still drops self even when bot_id is also set (self check comes first)', () => {
    const event = buildEvent({ user: BOT_USER_ID, bot_id: 'B-self' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('routes a bot_message subtype with NO user as no_user (still drops, but for the right reason)', () => {
    const event = buildEvent({ user: undefined, subtype: 'bot_message', bot_id: 'B999' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict).toEqual({ kind: 'drop', reason: 'no_user' })
  })
})

describe('slack-bot classifyInbound — route path', () => {
  test('routes a top-level team channel mention into a thread rooted at that message', () => {
    const event = buildEvent({ text: `hi <@${BOT_USER_ID}>` })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toEqual({
      adapter: 'slack-bot',
      workspace: TEAM_ID,
      chat: 'C0CHANNEL',
      thread: '1700000000.000100',
      text: `hi <@${BOT_USER_ID}>`,
      externalMessageId: '1700000000.000100',
      authorId: 'UALICE',
      authorName: 'UALICE',
      authorIsBot: false,
      isBotMention: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: 1_700_000_000_000,
    })
  })

  test('non-mention team messages route with isBotMention=false', () => {
    const event = buildEvent({ text: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.thread).toBeNull()
  })

  test('top-level alias-only addressing anchors thread on the inbound ts so the bot can reply in-thread', () => {
    // given: a top-level message with no @mention and no thread_ts, but
    // containing one of the bot's plain-text aliases. Slack treats this
    // as an isolated channel post; without anchoring `thread` here, the
    // bot's reply would post as another top-level message, fragmenting
    // the conversation. Anchoring on `event.ts` lets the outbound
    // callback set `thread_ts` and turn the bot's reply into the first
    // thread reply under the user's message — same conversational
    // affordance as a Slack-native @mention.
    const event = buildEvent({ text: '윙키야 안녕' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['윙키', 'winky'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('alias matching is case-insensitive and substring-based, mirroring the engagement layer', () => {
    const event = buildEvent({ text: 'WinKy please look at this' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['winky'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('an existing thread_ts always wins over alias anchoring (sanity check on the `??` short-circuit)', () => {
    // This is intentionally not a strong mutation guard for the alias
    // branch — the `event.thread_ts ?? ...` short-circuit at the head of
    // the thread expression means an inbound that already has a
    // thread_ts is preserved regardless of what the right-hand-side
    // does. Kept as a guard against someone "simplifying" by inverting
    // the precedence (e.g. anchoring on event.ts whenever an alias
    // matches, even mid-thread, which would silently re-root replies).
    const event = buildEvent({
      text: '윙키 in this thread',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
      parent_user_id: 'UCAROL',
    })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['윙키'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('alias-only addressing in a DM does NOT anchor a thread (DMs are flat)', () => {
    const event = buildEvent({ channel_type: 'im', channel: 'D0DM', text: '윙키야' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['윙키'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBeNull()
  })

  test('non-mention team message with no alias match leaves thread null (existing behavior)', () => {
    const event = buildEvent({ text: 'just chatting' })

    const verdict = classifyInbound(event, baseConfig, {
      teamId: TEAM_ID,
      botUserId: BOT_USER_ID,
      selfAliases: ['윙키'],
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBeNull()
  })

  test('DMs (channel_type=im) route with workspace=@dm and isDm=true', () => {
    const event = buildEvent({ channel_type: 'im', channel: 'D0DMID', text: 'private hi' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({ workspace: '@dm', chat: 'D0DMID', isDm: true })
  })

  test('thread reply to the bot surfaces thread_ts as both thread and replyToBotMessageId', () => {
    const event = buildEvent({
      text: 'thanks',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
      parent_user_id: BOT_USER_ID,
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBe('1700000000.000100')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('thread reply between humans (parent is a human) sets replyToOtherMessageId, not replyToBotMessageId', () => {
    const event = buildEvent({
      user: 'UALICE',
      text: 'i agree',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
      parent_user_id: 'UCAROL',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBe('1700000000.000100')
  })

  test('thread reply with no parent_user_id leaves both reply fields null (refuses to guess)', () => {
    const event = buildEvent({
      text: 'reply with unknown parent',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('parent message of a thread (ts === thread_ts) does not register as a reply', () => {
    const event = buildEvent({
      text: 'starting a thread',
      ts: '1700000000.000100',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('drops thread replies before bot identity is known (cannot classify parent target safely)', () => {
    const event = buildEvent({
      text: 'reply',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })
})

describe('slack-bot classifyInbound — targets-others detection', () => {
  test('marks mentionsOthers=true when text mentions a non-bot user only', () => {
    const event = buildEvent({ text: 'hey <@UBOB> can you check this?' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('marks mentionsOthers=false when the bot is among the mentioned users', () => {
    const event = buildEvent({ text: `<@UBOB> <@${BOT_USER_ID}> please weigh in` })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('marks mentionsOthers=false when the message has no mentions at all', () => {
    const event = buildEvent({ text: 'just some chatter' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('parses the labelled mention form `<@U…|name>` correctly', () => {
    const event = buildEvent({ text: 'cc <@UBOB|bob>' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('drops mentioned messages during the pre-connected race window (botUserId unknown)', () => {
    const event = buildEvent({ text: 'hey <@UBOB>' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: null })

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('Slack does not surface the parent author on inbounds, so replyToOtherMessageId is always null', () => {
    const event = buildEvent({
      text: 'thanks',
      ts: '1700000010.000200',
      thread_ts: '1700000000.000100',
    })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })
})

describe('slack-bot classifyInbound — group mentions', () => {
  test.each([
    ['<!here>', '<!here> deploy is starting'],
    ['<!channel>', 'heads up <!channel> — meeting moved'],
    ['<!everyone>', '<!everyone> the building is on fire'],
    ['<!here|here>', '<!here|here> labelled form'],
  ])('treats Slack group mention %s as a bot mention', (_label, text) => {
    const event = buildEvent({ text })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('group mention in a team channel roots a thread at the message ts (same as direct mention)', () => {
    const event = buildEvent({ text: '<!channel> ping' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.thread).toBe('1700000000.000100')
  })

  test('does NOT treat <!subteam^ID> as a group mention (would require subteam membership context)', () => {
    const event = buildEvent({ text: '<!subteam^S0ENG|engineering> please review' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('group mention overrides mentionsOthers — bot is included in the broadcast', () => {
    const event = buildEvent({ text: '<!here> <@UBOB> can you take this?' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('non-group "<!" markup (e.g. <!date^…>) does not flip isBotMention', () => {
    const event = buildEvent({ text: 'meeting at <!date^1700000000^{date_short}|Nov 14>' })

    const verdict = classifyInbound(event, baseConfig, { teamId: TEAM_ID, botUserId: BOT_USER_ID })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })
})
