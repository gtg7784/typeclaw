import { describe, expect, test } from 'bun:test'

import type { MatchRule } from './match-rule'
import { type MatchableOrigin, matchesOrigin } from './resolve'

const tui: MatchableOrigin = { kind: 'tui', sessionId: 's' }
const cron: MatchableOrigin = { kind: 'cron', jobId: 'j' }
const subagent: MatchableOrigin = { kind: 'subagent', subagent: 'memory-logger' }
const slackChat: MatchableOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C0ABCDE',
  lastInboundAuthorId: 'U_ME',
}
const slackDm: MatchableOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: '@dm',
  chat: 'D777',
  lastInboundAuthorId: 'U_OTHER',
}
const discordChat: MatchableOrigin = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: '9999',
  chat: '123456',
}
const kakaoGroup: MatchableOrigin = {
  kind: 'channel',
  adapter: 'kakaotalk',
  workspace: '@kakao-group',
  chat: 'G_X',
}

const TUI: MatchRule = { kind: 'tui' }
const CRON: MatchRule = { kind: 'cron' }
const WILDCARD: MatchRule = { kind: 'wildcard' }
const SUBAGENT_ANY: MatchRule = { kind: 'subagent' }
const SUBAGENT_NAMED: MatchRule = { kind: 'subagent', subagent: 'memory-logger' }
const SLACK_ANY: MatchRule = { kind: 'channel', platform: 'slack' }
const SLACK_WS: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123' }
const SLACK_CHAT: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123', chat: 'C0ABCDE' }
const SLACK_WS_AUTHOR: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123', author: 'U_ME' }
const SLACK_DM_BUCKET: MatchRule = { kind: 'channel', platform: 'slack', bucket: 'dm' }
const DISCORD_GUILD: MatchRule = { kind: 'channel', platform: 'discord', workspace: '9999' }
const KAKAO_GROUP_BUCKET: MatchRule = { kind: 'channel', platform: 'kakao', bucket: 'group' }

describe('matchesOrigin — keyword scopes', () => {
  test('tui rule matches tui origin only', () => {
    expect(matchesOrigin(TUI, tui)).toBe(true)
    expect(matchesOrigin(TUI, cron)).toBe(false)
    expect(matchesOrigin(TUI, slackChat)).toBe(false)
  })

  test('cron rule matches cron origin only', () => {
    expect(matchesOrigin(CRON, cron)).toBe(true)
    expect(matchesOrigin(CRON, tui)).toBe(false)
  })

  test('wildcard matches any channel, never tui/cron/subagent', () => {
    expect(matchesOrigin(WILDCARD, slackChat)).toBe(true)
    expect(matchesOrigin(WILDCARD, discordChat)).toBe(true)
    expect(matchesOrigin(WILDCARD, tui)).toBe(false)
    expect(matchesOrigin(WILDCARD, cron)).toBe(false)
    expect(matchesOrigin(WILDCARD, subagent)).toBe(false)
  })

  test('subagent rule with no name matches any subagent', () => {
    expect(matchesOrigin(SUBAGENT_ANY, subagent)).toBe(true)
    expect(matchesOrigin(SUBAGENT_ANY, tui)).toBe(false)
  })

  test('subagent rule with name matches only that name', () => {
    expect(matchesOrigin(SUBAGENT_NAMED, subagent)).toBe(true)
    expect(matchesOrigin(SUBAGENT_NAMED, { kind: 'subagent', subagent: 'other' })).toBe(false)
  })
})

describe('matchesOrigin — channel coordinates', () => {
  test('platform-only matches any chat in that platform', () => {
    expect(matchesOrigin(SLACK_ANY, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_ANY, slackDm)).toBe(true)
    expect(matchesOrigin(SLACK_ANY, discordChat)).toBe(false)
  })

  test('workspace narrows to one workspace', () => {
    expect(matchesOrigin(SLACK_WS, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_WS, { ...slackChat, workspace: 'T_OTHER' })).toBe(false)
  })

  test('chat narrows to one chat in one workspace', () => {
    expect(matchesOrigin(SLACK_CHAT, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_CHAT, { ...slackChat, chat: 'C_OTHER' })).toBe(false)
  })

  test('author qualifier matches lastInboundAuthorId', () => {
    expect(matchesOrigin(SLACK_WS_AUTHOR, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_WS_AUTHOR, { ...slackChat, lastInboundAuthorId: 'U_OTHER' })).toBe(false)
    expect(matchesOrigin(SLACK_WS_AUTHOR, { ...slackChat, lastInboundAuthorId: undefined })).toBe(false)
  })

  test('slack:dm bucket matches the @dm workspace marker', () => {
    expect(matchesOrigin(SLACK_DM_BUCKET, slackDm)).toBe(true)
    expect(matchesOrigin(SLACK_DM_BUCKET, slackChat)).toBe(false)
  })

  test('discord workspace match', () => {
    expect(matchesOrigin(DISCORD_GUILD, discordChat)).toBe(true)
    expect(matchesOrigin(DISCORD_GUILD, { ...discordChat, workspace: '8888' })).toBe(false)
  })

  test('kakao group bucket matches the @kakao-group workspace prefix', () => {
    expect(matchesOrigin(KAKAO_GROUP_BUCKET, kakaoGroup)).toBe(true)
    expect(matchesOrigin(KAKAO_GROUP_BUCKET, { ...kakaoGroup, workspace: '@kakao-dm' })).toBe(false)
  })

  test('platform mismatch on channel rule against channel origin', () => {
    expect(matchesOrigin(SLACK_ANY, discordChat)).toBe(false)
  })
})
