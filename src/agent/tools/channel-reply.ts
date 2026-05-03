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
      text: Type.Optional(
        Type.String({
          description:
            'The message body. Use platform mention syntax `<@USER_ID>` for Slack/Discord mentions. Optional only when `attachments` is set.',
          minLength: 1,
        }),
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({
              description: 'Absolute path inside the agent container to the file to upload.',
              minLength: 1,
            }),
            filename: Type.Optional(Type.String({ minLength: 1 })),
          }),
          {
            description:
              'Optional files to attach. Slack folds `text` into the first file as a caption (single message). Discord uploads files separately and may post `text` as a follow-up message; uploaded files land in channel root even when replying inside a thread (upstream limitation).',
            minItems: 1,
          },
        ),
      ),
    }),

    async execute(_toolCallId, params) {
      const text = params.text
      const attachments = params.attachments
      if ((text === undefined || text === '') && (attachments === undefined || attachments.length === 0)) {
        return {
          content: [
            { type: 'text' as const, text: 'channel_reply denied: must provide `text`, `attachments`, or both.' },
          ],
          details: { ok: false, error: 'missing text and attachments' },
        }
      }

      const noReplyError = noReplyMisuseError(text)
      if (noReplyError) {
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${noReplyError}` }],
          details: { ok: false, error: noReplyError },
        }
      }

      const result = await router.send({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        ...(text !== undefined ? { text } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      })

      const details: { ok: boolean; error?: string } = result.ok ? { ok: true } : { ok: false, error: result.error }
      // Echo the delivered text back to the model. The adapter classifier
      // drops self-authored messages on the inbound path (`self_author`),
      // so the bot otherwise has ZERO visibility into what it just said —
      // not in the next iteration's context, not in later turns' history.
      // Without this echo, a model that splits a multi-part reply has no
      // way to tell "did I already send part 1?" from "I haven't started
      // yet", and routinely re-sends near-duplicates within the same turn
      // (observed in production: two consecutive identical
      // greeting messages to one prompt).
      //
      // We deliberately do NOT cap sends-per-turn here. A complex user
      // request legitimately needs split replies, and a hard cap would
      // mutilate that. The fix is to give the model honest feedback —
      // show it what it sent, let it decide whether to continue.
      // Truncate past 500 chars so a long reply doesn't double the prompt
      // size on every subsequent iteration; the prefix is enough to detect
      // duplication, and the full text is recoverable from the session
      // JSONL if needed.
      const echo = renderOutboundEcho(text, attachments)
      const baseText = result.ok
        ? `posted to ${origin.adapter}:${origin.workspace}/${origin.chat}: ${echo}`
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

export const ECHO_MAX_CHARS = 500

export function renderEcho(text: string): string {
  if (text.length <= ECHO_MAX_CHARS) return JSON.stringify(text)
  return `${JSON.stringify(text.slice(0, ECHO_MAX_CHARS))}... (${text.length} chars total)`
}

export function renderOutboundEcho(
  text: string | undefined,
  attachments: ReadonlyArray<{ path: string; filename?: string }> | undefined,
): string {
  const hasText = text !== undefined && text !== ''
  const hasAttachments = attachments !== undefined && attachments.length > 0
  if (hasText && hasAttachments) {
    const filenames = attachments.map((a) => a.filename ?? a.path.split('/').pop() ?? a.path)
    return `${renderEcho(text)} + ${attachments.length} file(s): ${filenames.join(', ')}`
  }
  if (hasText) return renderEcho(text)
  if (hasAttachments) {
    const filenames = attachments.map((a) => a.filename ?? a.path.split('/').pop() ?? a.path)
    return `${attachments.length} file(s): ${filenames.join(', ')}`
  }
  return '(empty)'
}

// Mirror of the same guard used by channel_send. Blocks the literal
// `NO_REPLY` from being sent as a message body — same misuse, same denial,
// regardless of which sending tool the model picked. Returns '' when text
// is undefined (attachments-only reply, can't be misusing the signal).
function noReplyMisuseError(text: string | undefined): string {
  if (text === undefined) return ''
  if (text.trim() !== 'NO_REPLY') return ''
  return (
    '`NO_REPLY` is the silent-turn signal, not a message body. ' +
    'To stay silent, end your turn with `NO_REPLY` as your entire visible response and NO channel tool call. ' +
    'To send an actual reply, call this tool again with different text.'
  )
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
