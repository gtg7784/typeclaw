import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { ReactionRef } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { TOOL_RESULT_PREFIX } from './channel-reply'

export type ChannelReactOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  reactionRef?: ReactionRef
}

export type CreateChannelReactToolOptions = {
  router: ChannelRouter
  origin: ChannelReactOrigin
  logger?: ChannelToolLogger
}

export function createChannelReactTool({
  router,
  origin,
  logger = consoleChannelLogger,
}: CreateChannelReactToolOptions) {
  return defineTool({
    name: 'channel_react',
    label: 'Channel React',
    description:
      'Add an emoji reaction to the message that triggered this turn — a lightweight acknowledgment that does not post a comment. ' +
      'On GitHub this reacts to the triggering issue/PR/comment (e.g. :eyes: to signal "I am looking at this"). ' +
      'Use this instead of a textual "on it" reply when a reaction is enough. Pass the bare emoji name, no colons.',
    parameters: Type.Object({
      emoji: Type.String({
        description: 'Bare emoji name, no surrounding colons. e.g. "eyes", "+1", "rocket", "heart".',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const deny = (error: string) => {
        logger.warn(formatChannelToolFailure('channel_react', error))
        const details: { ok: boolean; error?: string } = { ok: false, error }
        return {
          content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_react denied: ${error}` }],
          details,
        }
      }

      if (origin.reactionRef === undefined) return deny('this conversation has no message to react to')

      const result = await router.react({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        reactionRef: origin.reactionRef,
        emoji: params.emoji,
      })

      if (!result.ok) return deny(`${origin.adapter}:${origin.workspace}/${origin.chat}: ${result.error}`)

      const details: { ok: boolean; error?: string } = { ok: true }
      return {
        content: [
          {
            type: 'text' as const,
            text: `${TOOL_RESULT_PREFIX}reacted with :${params.emoji}: on ${origin.adapter}:${origin.workspace}/${origin.chat}`,
          },
        ],
        details,
      }
    },
  })
}
