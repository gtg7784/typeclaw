import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

export type ChannelDisengageOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelDisengageToolOptions = {
  router: ChannelRouter
  origin: ChannelDisengageOrigin
}

export type ChannelDisengageDetails = {
  ok: boolean
  cleared: number
}

// `channel_disengage` drops the "we're mid-conversation" sticky credits for the
// current channel/thread. Stickiness force-engages the bot on a participant's
// follow-up even without an @mention, and every reply re-grants a fresh credit —
// so in a busy group the bot keeps answering turn after turn, even after a human
// or peer bot asks it to stop. Calling this returns the bot to strict
// mention/reply/dm engagement for this conversation until someone addresses it
// again. Use it as a clean exit when you've been told to back off or when you
// notice you're stuck in a redundant back-and-forth.
export function createChannelDisengageTool({ router, origin }: CreateChannelDisengageToolOptions) {
  return defineTool({
    name: 'channel_disengage',
    label: 'Channel Disengage',
    description:
      'Stop auto-engaging on follow-up messages in THIS channel/thread. While engaged you ' +
      "keep replying to a participant's next message without an @mention, and that " +
      'engagement is renewed every time you reply — so in a group you can get stuck ' +
      'answering turn after turn even after someone tells you to stop. Call this when a ' +
      'human or peer bot asks you to be quiet / stop replying, or when you realize you are ' +
      'in a redundant loop. After disengaging, you only re-engage in this conversation when ' +
      'explicitly addressed again (mention, reply, or DM). This does not send any message ' +
      'and does not affect other channels. Pair it with skip_response when you also want to ' +
      'stay silent on the current turn.',
    parameters: Type.Object({}),

    async execute() {
      const result = router.clearSticky({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
      })
      const details: ChannelDisengageDetails = { ok: true, cleared: result.cleared }
      const summary =
        result.cleared > 0
          ? `Disengaged from this conversation (${result.cleared} active engagement${result.cleared === 1 ? '' : 's'} dropped). You will only re-engage here when explicitly addressed again.`
          : 'You were not auto-engaged in this conversation; nothing to drop. You already only engage here when explicitly addressed.'
      return {
        content: [{ type: 'text' as const, text: summary }],
        details,
      }
    },
  })
}
