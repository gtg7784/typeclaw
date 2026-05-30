import type { AdapterId } from '@/channels/schema'

import type { MatchRule, Platform } from './match-rule'

const ADAPTER_TO_PLATFORM: Record<AdapterId, Platform> = {
  'slack-bot': 'slack',
  'discord-bot': 'discord',
  github: 'github',
  'telegram-bot': 'telegram',
  kakaotalk: 'kakao',
}

export type MatchableOrigin =
  | { kind: 'tui'; sessionId?: string }
  | { kind: 'cron'; jobId?: string }
  | { kind: 'subagent'; subagent?: string }
  | {
      kind: 'channel'
      adapter: AdapterId
      workspace: string
      chat: string
      lastInboundAuthorId?: string
    }

export function matchesOrigin(rule: MatchRule, origin: MatchableOrigin): boolean {
  switch (rule.kind) {
    case 'wildcard':
      return origin.kind === 'channel'
    case 'tui':
      return origin.kind === 'tui'
    case 'cron':
      return origin.kind === 'cron'
    case 'subagent':
      if (origin.kind !== 'subagent') return false
      if (rule.subagent === undefined) return true
      return origin.subagent === rule.subagent
    case 'channel':
      return matchesChannel(rule, origin)
  }
}

function matchesChannel(rule: Extract<MatchRule, { kind: 'channel' }>, origin: MatchableOrigin): boolean {
  if (origin.kind !== 'channel') return false
  if (ADAPTER_TO_PLATFORM[origin.adapter] !== rule.platform) return false

  if (rule.bucket !== undefined) {
    if (!matchesBucket(rule.bucket, origin)) return false
    if (rule.chat !== undefined && rule.chat !== origin.chat) return false
  } else {
    if (rule.workspace !== undefined && rule.workspace !== origin.workspace) return false
    if (rule.chat !== undefined && rule.chat !== origin.chat) return false
  }

  if (rule.author !== undefined && rule.author !== origin.lastInboundAuthorId) return false
  return true
}

// DM and group buckets are inferred from the workspace/chat shape of the
// inbound origin. Different adapters mark DMs differently — Slack uses an
// `@dm` workspace marker today, Discord uses a `dm` workspace marker, and
// KakaoTalk preserves group/open/dm explicitly in its workspace field. We
// keep the heuristic narrow: a rule that says `slack:dm/*` matches only when
// the origin's workspace is `@dm` (Slack) or `dm` (Discord). KakaoTalk uses
// the workspace prefix itself.
function matchesBucket(
  bucket: 'dm' | 'group' | 'open',
  origin: Extract<MatchableOrigin, { kind: 'channel' }>,
): boolean {
  const platform = ADAPTER_TO_PLATFORM[origin.adapter]
  if (platform === 'kakao') {
    if (bucket === 'dm') return origin.workspace === '@kakao-dm'
    if (bucket === 'group') return origin.workspace === '@kakao-group'
    if (bucket === 'open') return origin.workspace === '@kakao-open'
    return false
  }
  if (bucket !== 'dm') return false
  if (platform === 'slack') return origin.workspace === '@dm'
  if (platform === 'discord') return origin.workspace === 'dm' || origin.workspace === '@dm'
  if (platform === 'telegram') return origin.workspace === 'dm' || origin.workspace.startsWith('@')
  return false
}

// True only for a 1:1 direct-message channel origin (a two-participant
// conversation: the principal + the bot). Reuses the same per-adapter
// workspace markers as the `dm` match-rule bucket. A DM is the only channel
// shape with no third-party content buffered into a turn, so role-grant tools
// treat an owner/trusted DM as injection-equivalent to the TUI; group/open
// channels never qualify.
export function isDmChannelOrigin(origin: { adapter: AdapterId; workspace: string }): boolean {
  return matchesBucket('dm', { kind: 'channel', adapter: origin.adapter, workspace: origin.workspace, chat: '' })
}
