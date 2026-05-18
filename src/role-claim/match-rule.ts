// Builds a canonical match-rule DSL string from an inbound channel origin,
// for the role table. Output shapes:
//
//   slack:T0123 author:U_ALICE
//   discord:9999 author:U_ALICE
//   telegram:42 author:U_ALICE
//   kakao:dm/<chatId> author:<authorId>
//
// The author qualifier is always emitted so a claim grants the specific
// human, not the whole workspace. To grant the whole workspace, the
// operator edits typeclaw.json by hand or runs a future `typeclaw role grant`
// without --claim.

import type { ChannelKey } from '@/channels/types'

export type PartialChannelOrigin = {
  adapter: ChannelKey['adapter']
  workspace: string
  chat: string
  isDm: boolean
  authorId: string
}

const ADAPTER_TO_PLATFORM: Record<ChannelKey['adapter'], 'slack' | 'discord' | 'telegram' | 'kakao' | 'github'> = {
  'slack-bot': 'slack',
  'discord-bot': 'discord',
  github: 'github',
  'telegram-bot': 'telegram',
  kakaotalk: 'kakao',
}

export function formatClaimMatchRule(origin: PartialChannelOrigin): string {
  const platform = ADAPTER_TO_PLATFORM[origin.adapter]
  const authorQual = ` author:${origin.authorId}`
  if (origin.adapter === 'kakaotalk') {
    // Kakao has no workspace; routes use dm/group/open buckets. We can't
    // know which bucket from a partial origin alone (adapter-side classifies
    // it), so claim flows are restricted to DM and we emit the specific
    // chat-id form so the rule grants only this 1:1 conversation, not every
    // DM the agent is in.
    return `${platform}:dm/${origin.chat}${authorQual}`
  }
  return `${platform}:${origin.workspace}${authorQual}`
}
