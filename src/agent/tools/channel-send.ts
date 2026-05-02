import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import { ADAPTER_IDS, type AdapterId } from '@/channels/schema'

import { renderEcho } from './channel-reply'

export type ChannelSendOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelSendToolOptions = {
  router: ChannelRouter
  // Optional channel origin for the session this tool is wired into. When
  // present, the tool can detect "you posted to the same conversation but
  // dropped the thread" and surface that as a hint in the tool result, so
  // the model can self-correct on its next turn. Absent for sessions whose
  // origin isn't a channel (e.g. cron prompts that send to channels).
  origin?: ChannelSendOrigin
}

export function createChannelSendTool({ router, origin }: CreateChannelSendToolOptions) {
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
      // See channel-reply.ts for the rationale: the model has no other way
      // to see what it just sent (self_author drop on the inbound path),
      // and without an echo it duplicates messages within a single turn.
      const echo = renderEcho(params.text)
      const baseText = result.ok
        ? `posted to ${params.adapter}:${params.workspace}/${params.chat}: ${echo}`
        : `channel_send denied: ${result.error}`
      const hints: string[] = []
      if (result.ok) {
        const consecutive = consecutiveSendHint(
          router.getConsecutiveSendCount({
            adapter,
            workspace: params.workspace,
            chat: params.chat,
            thread: params.thread ?? null,
          }),
        )
        if (consecutive) hints.push(consecutive)

        const threadMismatch = threadMismatchHint(origin, {
          adapter,
          workspace: params.workspace,
          chat: params.chat,
          thread: params.thread,
        })
        if (threadMismatch) hints.push(threadMismatch)
      }
      const text = hints.length > 0 ? `${baseText} — ${hints.join(' ')}` : baseText
      return {
        content: [{ type: 'text' as const, text }],
        details,
      }
    },
  })
}

// Returns a behavioral hint when the model posted to the SAME conversation
// as the session's origin (same adapter+workspace+chat) but DROPPED the
// thread. This catches the "model forgot to copy thread verbatim" failure
// mode without blocking legitimate intent — if leaving the thread was on
// purpose ("새 스레드에서 시작하자"), the model can ignore this hint; if it
// wasn't, the next channel_send (or channel_reply) can correct course.
//
// Only fires when the origin had a thread to begin with — channel-root
// sessions can't have a "missing thread" problem.
function threadMismatchHint(
  origin: ChannelSendOrigin | undefined,
  sent: { adapter: AdapterId; workspace: string; chat: string; thread: string | undefined },
): string {
  if (!origin) return ''
  if (origin.thread === null) return ''
  if (sent.thread !== undefined) return ''
  if (origin.adapter !== sent.adapter) return ''
  if (origin.workspace !== sent.workspace) return ''
  if (origin.chat !== sent.chat) return ''
  return (
    `note: this session's origin thread is ${JSON.stringify(origin.thread)} but you posted to channel root. ` +
    `if breaking out of the thread was intentional, ignore this; otherwise prefer \`channel_reply\` ` +
    `or pass \`thread: ${JSON.stringify(origin.thread)}\` on your next channel_send.`
  )
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
