import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import {
  containsKimiToolDelimiter,
  isNoReplySignal,
  isUpstreamEmptyResponseSentinel,
  type ChannelRouter,
} from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { fenceRuntimeNotice, fenceToolResult } from './runtime-notice'

export type ChannelReplyOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelReplyToolOptions = {
  router: ChannelRouter
  origin: ChannelReplyOrigin
  logger?: ChannelToolLogger
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
export function createChannelReplyTool({
  router,
  origin,
  logger = consoleChannelLogger,
}: CreateChannelReplyToolOptions) {
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
      continue: Type.Optional(
        Type.Boolean({
          description:
            'Set `true` ONLY when this reply is a mid-turn status update (e.g. "working on it…") and you still have work to do THIS turn — fetching data, running a tool, spawning a subagent, then replying again. ' +
            'A normal reply omits this: by default a successful reply ends the turn (no wasted follow-up LLM call). ' +
            'Do not set it just to seem responsive; only when genuine multi-step work follows in the same turn.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const text = params.text
      const attachments = params.attachments
      const keepTurnAlive = params.continue === true
      if ((text === undefined || text === '') && (attachments === undefined || attachments.length === 0)) {
        logger.warn(formatChannelToolFailure('channel_reply', 'missing text and attachments'))
        return {
          content: [
            { type: 'text' as const, text: 'channel_reply denied: must provide `text`, `attachments`, or both.' },
          ],
          details: { ok: false, error: 'missing text and attachments' },
        }
      }

      const noReplyError = noReplyMisuseError(text)
      if (noReplyError) {
        logger.warn(formatChannelToolFailure('channel_reply', noReplyError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${noReplyError}` }],
          details: { ok: false, error: noReplyError },
        }
      }

      const upstreamSentinelError = upstreamEmptyResponseSentinelError(text)
      if (upstreamSentinelError) {
        logger.warn(formatChannelToolFailure('channel_reply', upstreamSentinelError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${upstreamSentinelError}` }],
          details: { ok: false, error: upstreamSentinelError },
        }
      }

      const kimiLeakError = kimiToolCallLeakError(text)
      if (kimiLeakError) {
        logger.warn(formatChannelToolFailure('channel_reply', kimiLeakError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${kimiLeakError}` }],
          details: { ok: false, error: kimiLeakError },
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

      if (!result.ok) {
        logger.warn(
          formatChannelToolFailure(
            'channel_reply',
            `${origin.adapter}:${origin.workspace}/${origin.chat}: ${result.error}`,
          ),
        )
      }
      // `continue` is read by the router's terminal hook (installChannelReplyTerminalHook),
      // not by this tool — it suppresses the post-reply abort so a multi-step turn
      // keeps going. Success-only: a denied reply never ran, so there is no turn to keep.
      const details: { ok: boolean; error?: string; continue?: boolean } = result.ok
        ? keepTurnAlive
          ? { ok: true, continue: true }
          : { ok: true }
        : { ok: false, error: result.error }
      // Echo the delivered text back to the model. The adapter classifier
      // drops self-authored messages on the inbound path (`self_author`),
      // so the bot otherwise has ZERO visibility into what it just said —
      // not in the next iteration's context, not in later turns' history.
      // Without this echo, a model that splits a multi-part reply has no
      // way to tell "did I already send part 1?" from "I haven't started
      // yet", and routinely re-sends near-duplicates within the same turn
      // (observed in production: two consecutive identical greeting messages
      // to one prompt).
      //
      // The echo is the model's OWN words, which is uniquely seductive to
      // "reply" to, so on the success path we wrap the whole result in the
      // strong SYSTEM MESSAGE fence (`fenceToolResult`) rather than the weak
      // `[system: tool result...]` prefix — the prefix did not stop Kimi from
      // answering its own echo and looping (PR #481). Denials carry no echoed
      // prose (just machine error text), so they keep the lighter prefix.
      if (result.ok) {
        const echo = renderOutboundEcho(text, attachments)
        const receipt = `posted to ${origin.adapter}:${origin.workspace}/${origin.chat}: ${echo}`
        const hint = consecutiveSendHint(
          router.getConsecutiveSendCount({
            adapter: origin.adapter,
            workspace: origin.workspace,
            chat: origin.chat,
            thread: origin.thread,
          }),
        )
        // Keep fenceToolResult here — do NOT "unify" the success branch back to
        // TOOL_RESULT_PREFIX to match the denial branch below. The prefix is
        // intentionally weaker and is safe ONLY because denials carry no echoed
        // prose; the success result does, and the weak prefix let Kimi loop.
        return {
          content: [{ type: 'text' as const, text: `${fenceToolResult(receipt)}${hint}` }],
          details,
        }
      }
      return {
        content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_reply denied: ${result.error}` }],
        details,
      }
    },
  })
}

// Tool results reach the model as USER-role messages (OpenAI / Anthropic
// tool-API contract — the engine cannot tag them as system). Without this
// marker a persona-rich model reads its own echo as a fresh user inbound
// and replies to itself. Observed in production: Kimi K2 on KakaoTalk
// re-invoked after a successful send saw only the echo as new context
// and hallucinated a goodbye trigger from it. Mirrored verbatim in
// channel-send.ts so both tools share one greppable marker.
export const TOOL_RESULT_PREFIX = '[system: tool result, not a user message] '

export const ECHO_MAX_CHARS = 500

export function renderEcho(text: string): string {
  if (text.length <= ECHO_MAX_CHARS) return JSON.stringify(text)
  return `${JSON.stringify(text.slice(0, ECHO_MAX_CHARS))}... (${text.length} chars total)`
}

// DO NOT remove this echo or replace it with a hash/length-only "receipt" to
// stop the self-reply loop (PR #481). That trade was tried and rejected: the
// echo is the model's only view of what it already said (the inbound path
// drops self-authored messages), so without the FULL text a split reply
// re-sends near-duplicates — the exact bug 58c62c1 added the echo to fix, and
// a fingerprint cannot catch paraphrased near-dupes. The loop is solved by
// FENCING this echo (see fenceToolResult call site below), not by removing it.
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

// Mirror of the same guard used by channel_send. Blocks any silent-turn
// signal (per `isNoReplySignal`) from being sent as a message body — same
// misuse, same denial, regardless of which sending tool the model picked.
// Returns '' when text is undefined (attachments-only reply, can't be
// misusing the signal) or when text is non-empty and not a signal.
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

// Mirror of the same guard used by channel_send. Blocks the upstream
// `(Empty response: ...)` debug sentinel from being sent verbatim — that
// payload carries the model's thinking content and signature, never a
// real user-facing message.
function upstreamEmptyResponseSentinelError(text: string | undefined): string {
  if (text === undefined) return ''
  if (!isUpstreamEmptyResponseSentinel(text)) return ''
  return (
    'refusing to forward an upstream `(Empty response: ...)` sentinel; ' +
    "that string is a provider-SDK debug dump containing the model's thinking content and signature, " +
    'not a message body. End your turn silently (visible text empty or `NO_REPLY`) instead.'
  )
}

function kimiToolCallLeakError(text: string | undefined): string {
  if (text === undefined) return ''
  if (!containsKimiToolDelimiter(text)) return ''
  return (
    'refusing to forward raw provider tool-call control tokens; these are chat-template ' +
    'delimiters that should have been parsed into a real tool call upstream. ' +
    'Re-issue the intended channel reply as plain user-visible text only.'
  )
}

// Mirror of the same hint used by channel_send. Kept identical so the model
// sees the same yield signal regardless of which tool it picked. The body
// is wrapped via `fenceRuntimeNotice` (in `./runtime-notice`) so persona-rich
// models cannot read the trailing prose as a chat instruction and reply to
// it in-character. See that helper's comment for the failure mode that
// motivated the framing.
function consecutiveSendHint(countAfterSend: number): string {
  if (countAfterSend <= 1) return ''
  const body =
    countAfterSend === 2
      ? 'this is your 2nd consecutive message in this conversation; continue only if the reply genuinely needs splitting.'
      : `${countAfterSend}th consecutive message with no user reply; end your turn now unless the user explicitly asked for a multi-step response.`
  return fenceRuntimeNotice(body)
}
