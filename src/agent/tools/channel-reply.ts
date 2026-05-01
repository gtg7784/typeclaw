import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

export type ChannelReplyOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelReplyToolOptions = {
  router: ChannelRouter
  origin: ChannelReplyOrigin
}

// channel_reply is the happy-path companion to channel_send for channel-routed
// sessions. The session's origin already pins the conversation we're inside
// (adapter, workspace, chat, thread), so the model shouldn't have to copy
// those fields verbatim every turn — that copying is exactly where it has
// historically dropped `thread` and posted to channel root by accident.
//
// channel_reply takes only `text` and addresses the message from the origin.
// channel_send remains for posting somewhere else (different chat, breaking
// out of a thread, sending DMs from a channel session, etc.).
export function createChannelReplyTool({ router, origin }: CreateChannelReplyToolOptions) {
  return defineTool({
    name: 'channel_reply',
    label: 'Channel Reply',
    description:
      'Reply in the current conversation. This is your default way to respond to a channel session — ' +
      'addressing fields (adapter, workspace, chat, thread) are filled in from the session origin, so ' +
      'you only supply the text. To post somewhere else (different chat, break out of the current ' +
      'thread, etc.), use `channel_send` instead.',
    parameters: Type.Object({
      text: Type.String({
        description: 'The message body. Use platform mention syntax `<@USER_ID>` for Slack/Discord mentions.',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const result = await router.send({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        text: params.text,
      })

      const details: { ok: boolean; error?: string } = result.ok ? { ok: true } : { ok: false, error: result.error }
      const baseText = result.ok
        ? `posted to ${origin.adapter}:${origin.workspace}/${origin.chat}`
        : `channel_reply denied: ${result.error}`
      const hint = result.ok
        ? consecutiveSendHint(
            router.getConsecutiveSendCount({
              adapter: origin.adapter,
              workspace: origin.workspace,
              chat: origin.chat,
              thread: origin.thread,
            }),
          )
        : ''
      return {
        content: [{ type: 'text' as const, text: hint ? `${baseText} — ${hint}` : baseText }],
        details,
      }
    },
  })
}

// Mirror of the same hint used by channel_send. Kept identical so the model
// sees the same yield signal regardless of which tool it picked.
function consecutiveSendHint(countAfterSend: number): string {
  if (countAfterSend <= 1) return ''
  if (countAfterSend === 2) {
    return 'this is your 2nd consecutive message in this conversation; continue only if the reply genuinely needs splitting.'
  }
  return `${countAfterSend}th consecutive message with no user reply; end your turn now unless the user explicitly asked for a multi-step response.`
}
