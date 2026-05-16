import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { isNoReplySignal, type ChannelRouter } from '@/channels/router'
import { ADAPTER_IDS, type AdapterId } from '@/channels/schema'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { renderOutboundEcho } from './channel-reply'

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
  logger?: ChannelToolLogger
}

export function createChannelSendTool({ router, origin, logger = consoleChannelLogger }: CreateChannelSendToolOptions) {
  return defineTool({
    name: 'channel_send',
    label: 'Channel Send',
    description:
      'Post a message to an external messenger channel. Specify adapter, workspace, chat, and text. ' +
      'For Discord guild channels, workspace is the guild id; for Slack team channels, workspace is ' +
      'the team id (e.g. "T0ACME"). For DMs on either platform, workspace is the literal "@dm". ' +
      'On failure (no adapter registered, or the adapter-level send failed), the call returns ' +
      '{ ok: false, error }. There is no auto-reply: the only way for an agent to post is via this tool.',
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
      text: Type.Optional(
        Type.String({
          description:
            'The message body. Use Discord syntax `<@USER_ID>` for Discord mentions or Slack syntax `<@USER_ID>` for Slack mentions (Slack user ids start with "U"). Optional only when `attachments` is set; one of `text` or `attachments` must be present.',
          minLength: 1,
        }),
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({
              description:
                'Absolute path inside the agent container to the file to upload (e.g. "/agent/workspace/report.pdf"). The runtime reads the file just before the API call.',
              minLength: 1,
            }),
            filename: Type.Optional(
              Type.String({
                description:
                  'Filename to display in the chat. Defaults to the basename of `path`. Useful when the on-disk name carries a tempdir suffix the user should not see.',
                minLength: 1,
              }),
            ),
          }),
          {
            description:
              "Optional files to upload alongside the text. Slack: `text` is sent as the first file's caption (single Slack message). Discord: each file is uploaded individually (no caption support upstream), then `text` is posted as a separate message; uploads land in the channel root even when `thread` is set.",
            minItems: 1,
          },
        ),
      ),
    }),

    async execute(_toolCallId, params) {
      const adapter = params.adapter as AdapterId
      const bodyText = params.text
      const attachments = params.attachments
      if ((bodyText === undefined || bodyText === '') && (attachments === undefined || attachments.length === 0)) {
        logger.warn(formatChannelToolFailure('channel_send', 'missing text and attachments'))
        return {
          content: [
            { type: 'text' as const, text: 'channel_send denied: must provide `text`, `attachments`, or both.' },
          ],
          details: { ok: false, error: 'missing text and attachments' },
        }
      }

      const noReplyError = noReplyMisuseError(bodyText)
      if (noReplyError) {
        logger.warn(formatChannelToolFailure('channel_send', noReplyError))
        return {
          content: [{ type: 'text' as const, text: `channel_send denied: ${noReplyError}` }],
          details: { ok: false, error: noReplyError },
        }
      }

      const result = await router.send({
        adapter,
        workspace: params.workspace,
        chat: params.chat,
        ...(params.thread !== undefined ? { thread: params.thread } : {}),
        ...(bodyText !== undefined ? { text: bodyText } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      })

      if (!result.ok) {
        logger.warn(
          formatChannelToolFailure(
            'channel_send',
            `${params.adapter}:${params.workspace}/${params.chat}: ${result.error}`,
          ),
        )
      }
      const details: { ok: boolean; error?: string } = result.ok ? { ok: true } : { ok: false, error: result.error }
      const echo = renderOutboundEcho(bodyText, attachments)
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
      const responseText = hints.length > 0 ? `${baseText} — ${hints.join(' ')}` : baseText
      return {
        content: [{ type: 'text' as const, text: responseText }],
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

// Blocks a specific misuse: the model tried to send a silent-turn signal
// (e.g. `NO_REPLY`, `(NO_REPLY)`) as a channel message. Those forms belong
// in the model's *visible response* when no channel tool is called (see
// session-origin.ts and router.ts validateChannelTurn), NOT in the body of
// a sent message. We short-circuit BEFORE router.send so the signal never
// reaches the chat. Detection delegates to `isNoReplySignal` so the router
// and both tools stay in lockstep. Empty/undefined text is fine — that
// means "attachments-only send", not a signal.
function noReplyMisuseError(text: string | undefined): string {
  if (text === undefined) return ''
  if (text.trim() === '') return ''
  if (!isNoReplySignal(text)) return ''
  return (
    '`NO_REPLY` is the silent-turn signal, not a message body. ' +
    'To stay silent, end your turn with `NO_REPLY` as your entire visible response and NO channel tool call. ' +
    'To send an actual reply, call this tool again with different text.'
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
