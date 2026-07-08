import type { DiscordBotClient } from 'agent-messenger/discordbot'

import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

export function createDiscordEditMessageCallback(deps: {
  client: Pick<DiscordBotClient, 'editMessage'>
}): EditMessageCallback {
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== 'discord-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    // A Discord thread is its own channel id, so a message posted into a thread
    // must be PATCHed against the thread, not its parent — mirroring the
    // `thread ?? chat` routing the send/message-get paths use. Editing against
    // `chat` alone would 404 on any threaded message.
    const channelId = req.thread ?? req.chat
    try {
      await deps.client.editMessage(channelId, req.messageId, req.text)
    } catch (err) {
      return { ok: false, error: describe(err), code: classifyEditError(err) }
    }
    return { ok: true }
  }
}

// Discord only lets a bot edit its OWN messages: a PATCH on someone else's
// message returns 50005 (Cannot edit a message authored by another user),
// mapped to permission-denied. 10008/10003 are the gone-message/channel cases.
function classifyEditError(err: unknown): NonNullable<(EditMessageResult & { ok: false })['code']> {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  switch (code) {
    case '10003': // Unknown Channel
    case '10008': // Unknown Message
    case 'http_404':
      return 'not-found'
    case '50005': // Cannot edit a message authored by another user
    case '50001': // Missing Access
    case '50013': // Missing Permissions
    case 'http_403':
    case 'http_401':
      return 'permission-denied'
    default:
      return 'not-found'
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
