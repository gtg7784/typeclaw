import { describe, expect, it } from 'bun:test'

import type { ReactionRequest, RemoveReactionRequest } from '@/channels/types'

import {
  createDiscordReactionCallback,
  createDiscordRemoveReactionCallback,
  decodeDiscordReactionRef,
  decodeDiscordRemovalRef,
  encodeDiscordReactionRef,
  encodeDiscordRemovalRef,
  type DiscordReactionTarget,
} from './discord-bot-reactions'

class FakeDiscordError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

type AddCall = { channel: string; message: string; emoji: string }

const target: DiscordReactionTarget = { channel: 'C1', message: 'M1' }

const addReq = (emoji = 'rocket'): ReactionRequest => ({
  adapter: 'discord-bot',
  workspace: 'G1',
  chat: target.channel,
  thread: null,
  reactionRef: encodeDiscordReactionRef(target),
  emoji,
})

describe('encode/decode discord reaction ref', () => {
  it('round-trips the target', () => {
    expect(decodeDiscordReactionRef(encodeDiscordReactionRef(target))).toEqual(target)
  })

  it('rejects a ref from another adapter', () => {
    expect(decodeDiscordReactionRef({ adapter: 'slack-bot', value: '{}' })).toBeNull()
  })

  it('rejects malformed json', () => {
    expect(decodeDiscordReactionRef({ adapter: 'discord-bot', value: 'not json' })).toBeNull()
  })
})

describe('createDiscordReactionCallback', () => {
  it('translates the emoji name to unicode and returns a removal ref carrying it', async () => {
    const calls: AddCall[] = []
    const cb = createDiscordReactionCallback({
      client: { addReaction: async (channel, message, emoji) => void calls.push({ channel, message, emoji }) },
    })
    const result = await cb(addReq('rocket'))
    expect(calls).toEqual([{ channel: 'C1', message: 'M1', emoji: '🚀' }])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(decodeDiscordRemovalRef(result.reactionRef!)).toEqual({ channel: 'C1', message: 'M1', emoji: '🚀' })
    }
  })

  it('maps +1 and strips colons', async () => {
    const calls: AddCall[] = []
    const cb = createDiscordReactionCallback({
      client: { addReaction: async (channel, message, emoji) => void calls.push({ channel, message, emoji }) },
    })
    await cb(addReq(':+1:'))
    expect(calls[0]!.emoji).toBe('👍')
  })

  it('rejects an unmapped emoji name as unsupported without calling the SDK', async () => {
    let called = false
    const cb = createDiscordReactionCallback({
      client: {
        addReaction: async () => {
          called = true
        },
      },
    })
    const result = await cb(addReq('definitely-not-an-emoji'))
    expect(result).toMatchObject({ ok: false, code: 'unsupported' })
    expect(called).toBe(false)
  })

  it('maps Missing Permissions (50013) to permission-denied', async () => {
    const cb = createDiscordReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeDiscordError('50013')
        },
      },
    })
    expect(await cb(addReq())).toMatchObject({ ok: false, code: 'permission-denied' })
  })

  it('maps Unknown Message (10008) to not-found', async () => {
    const cb = createDiscordReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeDiscordError('10008')
        },
      },
    })
    expect(await cb(addReq())).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('maps an unrecognized error to transient', async () => {
    const cb = createDiscordReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeDiscordError('99999')
        },
      },
    })
    expect(await cb(addReq())).toMatchObject({ ok: false, code: 'transient' })
  })

  it('rejects a ref for the wrong adapter', async () => {
    const cb = createDiscordReactionCallback({ client: { addReaction: async () => {} } })
    expect(await cb({ ...addReq(), adapter: 'slack-bot' })).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('createDiscordRemoveReactionCallback', () => {
  const removeReq = (emojiUnicode = '🚀'): RemoveReactionRequest => ({
    adapter: 'discord-bot',
    workspace: 'G1',
    chat: target.channel,
    thread: null,
    reactionRef: encodeDiscordRemovalRef({ ...target, emoji: emojiUnicode }),
  })

  it('removes the reaction using the unicode folded into the removal ref', async () => {
    const calls: AddCall[] = []
    const cb = createDiscordRemoveReactionCallback({
      client: { removeReaction: async (channel, message, emoji) => void calls.push({ channel, message, emoji }) },
    })
    const result = await cb(removeReq('🚀'))
    expect(calls).toEqual([{ channel: 'C1', message: 'M1', emoji: '🚀' }])
    expect(result.ok).toBe(true)
  })

  it('rejects an add ref (missing op=remove) as unsupported', async () => {
    const cb = createDiscordRemoveReactionCallback({ client: { removeReaction: async () => {} } })
    const bad: RemoveReactionRequest = {
      adapter: 'discord-bot',
      workspace: 'G1',
      chat: target.channel,
      thread: null,
      reactionRef: encodeDiscordReactionRef(target),
    }
    expect(await cb(bad)).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
