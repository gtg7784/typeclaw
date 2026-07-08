import type { SlackBotClient } from 'agent-messenger/slackbot'

import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

export function createSlackEditMessageCallback(deps: {
  client: Pick<SlackBotClient, 'updateMessage'>
}): EditMessageCallback {
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    try {
      await deps.client.updateMessage(req.chat, req.messageId, req.text)
    } catch (err) {
      const code = slackErrorCode(err)
      return { ok: false, error: withScopeHint(code, describe(err)), code: classifyEditError(code) }
    }
    return { ok: true }
  }
}

function slackErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

// `chat:write` is the scope the bot token needs to edit its own messages;
// `cant_update_message` fires when the bot did not author the target, and
// `message_not_found` when the ts is wrong or the post is gone.
function withScopeHint(code: string | null, error: string): string {
  if (code !== 'missing_scope') return error
  return `${error} (Slack bot token needs the \`chat:write\` scope; reinstall/reauthorize the app with that scope.)`
}

function classifyEditError(code: string | null): NonNullable<(EditMessageResult & { ok: false })['code']> {
  switch (code) {
    case 'message_not_found':
    case 'channel_not_found':
      return 'not-found'
    case 'cant_update_message':
    case 'edit_window_closed':
    case 'missing_scope':
    case 'not_in_channel':
    case 'is_archived':
    case 'not_authed':
    case 'invalid_auth':
      return 'permission-denied'
    default:
      return 'not-found'
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
