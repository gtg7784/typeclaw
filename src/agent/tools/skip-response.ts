import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'

export type CreateSkipResponseToolOptions = {
  router: ChannelRouter
  // The channel session's id, used to locate the right LiveSession in the
  // router and stamp the skip flag with its current turnSeq. Mirrors how
  // `injectSubagentCompletionReminder` addresses live sessions by their
  // session id rather than ChannelKey — keeps the tool agnostic to which
  // adapter/workspace/chat it was wired into.
  sessionId: string
  logger?: ChannelToolLogger
}

const REASON_MAX_CHARS = 500

export type SkipResponseDetails = {
  ok: boolean
  suppressed: boolean
  reason: string
  error?: string
}

// `skip_response` is the structured alternative to ending a turn with the
// `NO_REPLY` text sentinel. The model invokes it when it has decided not
// to send a user-facing reply but has a meaningful reason (`no new info`,
// `user asked me to stay silent`, `subagent result duplicates an earlier
// reply`, etc.). The reason lands in `typeclaw logs -f` so the operator
// can audit silent turns; the channel router suppresses the assistant
// text recovery for the current turn so nothing ever reaches the chat.
//
// This is intentionally NOT a replacement for `NO_REPLY`. The text
// sentinel remains the fallback for cases where the model cannot or will
// not call a tool (degraded provider, structured-output disabled, etc.).
// `skip_response` is preferred whenever the model has a reason worth
// recording. See session-origin.ts for the prompt-level decision rule.
//
// Order-dependence with `channel_reply`/`channel_send`: once `skip_response`
// fires in a turn, the router rejects any subsequent tool-source send for
// the same turn with `SKIP_RESPONSE_LOCK_ERROR`. The model gets a clear
// error and learns to commit on the next turn instead of mid-turn.
export function createSkipResponseTool({
  router,
  sessionId,
  logger = consoleChannelLogger,
}: CreateSkipResponseToolOptions) {
  return defineTool({
    name: 'skip_response',
    label: 'Skip Response',
    description:
      'Decline to send a user-facing reply this turn, with a logged reason. Use this ' +
      'instead of narrating "I have nothing to add" / "I will stay quiet" in your visible ' +
      'response. The reason is written to host logs (visible via `typeclaw logs -f`) but ' +
      'never delivered to the user. After calling this, any `channel_reply` / `channel_send` ' +
      'in the same turn will be rejected — commit to silence or commit to replying, not both. ' +
      'Prefer this over the `NO_REPLY` text sentinel whenever you have a reason worth recording.',
    parameters: Type.Object({
      reason: Type.String({
        description:
          'A short, operator-readable reason for skipping. Keep it under 500 characters. Examples: ' +
          '"no new info beyond the previous reply", "user asked me to stay silent", "subagent result ' +
          'is empty". Do NOT include secrets, private message bodies, or long chain-of-thought-style ' +
          'reasoning — this string goes to logs.',
        minLength: 1,
        maxLength: REASON_MAX_CHARS,
      }),
    }),

    async execute(_toolCallId, params) {
      const reason = params.reason.trim()
      if (reason === '') {
        logger.warn(formatChannelToolFailure('skip_response', 'empty reason'))
        const details: SkipResponseDetails = { ok: false, suppressed: false, reason: '', error: 'empty reason' }
        return {
          content: [{ type: 'text' as const, text: 'skip_response denied: `reason` must not be empty.' }],
          details,
        }
      }

      const result = router.markTurnSkipped({ parentSessionId: sessionId, reason })
      if (result.kind === 'no-live-session') {
        // Defensive: the tool is only wired into channel-origin sessions
        // by buildChannelTools, so this branch should be unreachable in
        // practice. If it ever fires, log loudly so the operator can see
        // a model trying to skip a non-channel turn — we still return
        // success so the model doesn't retry, but the log captures the
        // anomaly.
        logger.warn(
          formatChannelToolFailure(
            'skip_response',
            `no live channel session for sessionId=${sessionId} (reason=${JSON.stringify(reason)})`,
          ),
        )
        const details: SkipResponseDetails = { ok: true, suppressed: false, reason }
        return {
          content: [
            {
              type: 'text' as const,
              text: 'skip_response acknowledged but no live channel session found; nothing to suppress. Reason logged.',
            },
          ],
          details,
        }
      }

      const details: SkipResponseDetails = { ok: true, suppressed: true, reason }
      return {
        content: [
          {
            type: 'text' as const,
            text: `skip_response accepted: this turn will not produce a user-facing reply. Reason logged: ${JSON.stringify(reason)}. End your turn now; do not call channel_reply or channel_send for the rest of this turn.`,
          },
        ],
        details,
      }
    },
  })
}
