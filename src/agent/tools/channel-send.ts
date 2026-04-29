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
      'For Discord guild channels, workspace is the guild id; for DMs, use the literal "@dm". ' +
      'The runtime checks the channel allow rules before delivering — if the target chat is not in ' +
      'the configured allow list, the call fails with { ok: false, error }. There is no auto-reply: ' +
      'the only way for an agent to post is via this tool.',
    parameters: Type.Object({
      adapter: Type.Union(
        ADAPTER_IDS.map((a) => Type.Literal(a)),
        { description: 'Adapter id. v0.1 supports only "discord-bot".' },
      ),
      workspace: Type.String({
        description: 'Discord guild id, or the literal "@dm" for direct-message channels.',
        minLength: 1,
      }),
      chat: Type.String({
        description: 'Discord channel id (or thread channel id; threads are channels in Discord).',
        minLength: 1,
      }),
      thread: Type.Optional(
        Type.String({
          description: 'Optional thread id for posting into a thread inside a channel.',
          minLength: 1,
        }),
      ),
      text: Type.String({
        description: 'The message body. Use Discord mention syntax `<@USER_ID>` to mention people.',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const result = await router.send({
        adapter: params.adapter as AdapterId,
        workspace: params.workspace,
        chat: params.chat,
        ...(params.thread !== undefined ? { thread: params.thread } : {}),
        text: params.text,
      })

      const details: { ok: boolean; error?: string } = result.ok
        ? { ok: true }
        : { ok: false, error: result.error }
      const text = result.ok
        ? `posted to ${params.adapter}:${params.workspace}/${params.chat}`
        : `channel_send denied: ${result.error}`
      return {
        content: [{ type: 'text' as const, text }],
        details,
      }
    },
  })
}
