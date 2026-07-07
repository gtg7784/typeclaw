export type TeamsConversationKey =
  | { kind: 'chat'; chatId: string }
  | { kind: 'channel'; teamId: string; channelId: string }

const CHAT_PREFIX = 'chat:'
const CHANNEL_PREFIX = 'channel:'

export function encodeTeamsChatKey(chatId: string): string {
  return `${CHAT_PREFIX}${chatId}`
}

// teamId is a GUID (no colons); channelId is a `19:...@thread.tacv2` value that
// DOES contain colons. Splitting the post-prefix remainder on its FIRST colon
// is therefore unambiguous: everything before it is the teamId, everything
// after is the channelId (colons and all).
export function encodeTeamsChannelKey(teamId: string, channelId: string): string {
  return `${CHANNEL_PREFIX}${teamId}:${channelId}`
}

export function decodeTeamsConversationKey(key: string): TeamsConversationKey | null {
  if (key.startsWith(CHAT_PREFIX)) {
    const chatId = key.slice(CHAT_PREFIX.length)
    return chatId === '' ? null : { kind: 'chat', chatId }
  }
  if (key.startsWith(CHANNEL_PREFIX)) {
    const rest = key.slice(CHANNEL_PREFIX.length)
    const sep = rest.indexOf(':')
    if (sep <= 0 || sep === rest.length - 1) return null
    return { kind: 'channel', teamId: rest.slice(0, sep), channelId: rest.slice(sep + 1) }
  }
  return null
}
