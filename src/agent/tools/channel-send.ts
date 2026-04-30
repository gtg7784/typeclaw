import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import { ADAPTER_IDS, type AdapterId } from '@/channels/schema'

export type CreateChannelSendToolOptions = {
  router: ChannelRouter
}

export function createChannelSendTool({ router }: CreateChannelSendToolOptions) {
  return defineTool({
    name: 'channel_send',
    label: 'Channel Send',
    description:
      'Post a message to an external messenger channel. Specify adapter, workspace, chat, and text. ' +
      'For Discord guild channels, workspace is the guild id; for Slack team channels, workspace is ' +
      'the team id (e.g. "T0ACME"). For DMs on either platform, workspace is the literal "@dm". ' +
      'The runtime checks the channel allow rules before delivering — if the target chat is not in ' +
      'the configured allow list, the call fails with { ok: false, error }. There is no auto-reply: ' +
      'the only way for an agent to post is via this tool.',
    parameters: Type.Object({
      adapter: Type.Union(
        ADAPTER_IDS.map((a) => Type.Literal(a)),
        { description: 'Adapter id. Supported: "discord-bot", "slack-bot".' },
      ),
      workspace: Type.String({
        description:
          'Discord guild id or Slack team id (e.g. "T0ACME"); use "@dm" for direct-message channels on either platform.',
        minLength: 1,
      }),
      chat: Type.String({
        description:
          'Channel id. Discord channel id (numeric snowflake) or Slack channel id (e.g. "C0CHANNEL", "D0DMID").',
        minLength: 1,
      }),
      thread: Type.Optional(
        Type.String({
          description:
            'Optional thread id. For Discord, the thread channel id. For Slack, the parent message thread_ts.',
          minLength: 1,
        }),
      ),
      text: Type.String({
        description:
          'The message body. Use Discord syntax `<@USER_ID>` for Discord mentions or Slack syntax `<@USER_ID>` for Slack mentions (Slack user ids start with "U").',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const adapter = params.adapter as AdapterId
      const result = await router.send({
        adapter,
        workspace: params.workspace,
        chat: params.chat,
        ...(params.thread !== undefined ? { thread: params.thread } : {}),
        text: params.text,
      })

      const details: { ok: boolean; error?: string } = result.ok ? { ok: true } : { ok: false, error: result.error }
      const baseText = result.ok
        ? `posted to ${params.adapter}:${params.workspace}/${params.chat}`
        : `channel_send denied: ${result.error}`
      const hint = result.ok
        ? consecutiveSendHint(
            router.getConsecutiveSendCount({
              adapter,
              workspace: params.workspace,
              chat: params.chat,
              thread: params.thread ?? null,
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

// Returns a behavioral hint to nudge the model toward yielding when it has
// been the only voice in the conversation for several messages. The router
// increments its counter AFTER router.send returns, so a count of 1 means
// "this is the second consecutive bot message in this chat:thread" — which
// is the first count where a hint is warranted. Empty string at count <= 1
// preserves the original tool-result text for the common single-reply case.
function consecutiveSendHint(countAfterSend: number): string {
  if (countAfterSend <= 1) return ''
  if (countAfterSend === 2) {
    return 'this is your 2nd consecutive message in this conversation; continue only if the reply genuinely needs splitting.'
  }
  return `${countAfterSend}th consecutive message with no user reply; end your turn now unless the user explicitly asked for a multi-step response.`
}
