import type { SlackClient } from 'agent-messenger/slack'

import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

export function createSlackUserEditMessageCallback(deps: {
  client: Pick<SlackClient, 'updateMessage'>
}): EditMessageCallback {
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== 'slack') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    try {
      await deps.client.updateMessage(req.chat, req.messageId, req.text)
    } catch (err) {
      const code = slackErrorCode(err)
      return { ok: false, error: describe(err), code: classifyEditError(code) }
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

function classifyEditError(code: string | null): NonNullable<(EditMessageResult & { ok: false })['code']> {
  switch (code) {
    case 'message_not_found':
    case 'channel_not_found':
      return 'not-found'
    case 'cant_update_message':
    case 'edit_window_closed':
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
