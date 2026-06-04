import { describe, expect, it } from 'bun:test'

import type { ReactionRequest, RemoveReactionRequest } from '@/channels/types'

import {
  createSlackReactionCallback,
  createSlackRemoveReactionCallback,
  decodeSlackReactionRef,
  decodeSlackRemovalRef,
  encodeSlackReactionRef,
  encodeSlackRemovalRef,
  type SlackReactionTarget,
} from './slack-bot-reactions'

class FakeSlackError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

type AddCall = { channel: string; ts: string; emoji: string }

const addReq = (target: SlackReactionTarget, emoji = 'rocket'): ReactionRequest => ({
  adapter: 'slack-bot',
  workspace: 'T1',
  chat: target.channel,
  thread: null,
  reactionRef: encodeSlackReactionRef(target),
  emoji,
})

describe('encode/decode slack reaction ref', () => {
  it('round-trips the add target', () => {
    const target: SlackReactionTarget = { channel: 'C1', ts: '1700000000.000100' }
    expect(decodeSlackReactionRef(encodeSlackReactionRef(target))).toEqual(target)
  })

  it('round-trips the removal target with emoji', () => {
    const target = { channel: 'C1', ts: '1700000000.000100', emoji: 'rocket' }
    expect(decodeSlackRemovalRef(encodeSlackRemovalRef(target))).toEqual(target)
  })

  it('rejects a ref from another adapter', () => {
    expect(decodeSlackReactionRef({ adapter: 'github', value: '{}' })).toBeNull()
  })

  it('rejects malformed json', () => {
    expect(decodeSlackReactionRef({ adapter: 'slack-bot', value: 'not json' })).toBeNull()
  })

  it('does not decode a removal ref as an add ref', () => {
    const removal = encodeSlackRemovalRef({ channel: 'C1', ts: '1.1', emoji: 'rocket' })
    expect(decodeSlackReactionRef(removal)).toBeNull()
  })
})

describe('createSlackReactionCallback', () => {
  it('adds the reaction and returns a removal ref carrying the emoji', async () => {
    const calls: AddCall[] = []
    const cb = createSlackReactionCallback({
      client: { addReaction: async (channel, ts, emoji) => void calls.push({ channel, ts, emoji }) },
    })
    const result = await cb(addReq({ channel: 'C1', ts: '1.1' }, 'rocket'))
    expect(calls).toEqual([{ channel: 'C1', ts: '1.1', emoji: 'rocket' }])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(decodeSlackRemovalRef(result.reactionRef!)).toEqual({ channel: 'C1', ts: '1.1', emoji: 'rocket' })
    }
  })

  it('strips surrounding colons before calling the SDK', async () => {
    const calls: AddCall[] = []
    const cb = createSlackReactionCallback({
      client: { addReaction: async (channel, ts, emoji) => void calls.push({ channel, ts, emoji }) },
    })
    await cb(addReq({ channel: 'C1', ts: '1.1' }, ':+1:'))
    expect(calls[0]!.emoji).toBe('+1')
  })

  it('treats already_reacted as success', async () => {
    const cb = createSlackReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeSlackError('already_reacted')
        },
      },
    })
    const result = await cb(addReq({ channel: 'C1', ts: '1.1' }))
    expect(result.ok).toBe(true)
  })

  it('maps invalid_name to unsupported', async () => {
    const cb = createSlackReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeSlackError('invalid_name')
        },
      },
    })
    const result = await cb(addReq({ channel: 'C1', ts: '1.1' }, 'definitely-not-an-emoji'))
    expect(result).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('maps missing_scope to permission-denied with an actionable reactions:write hint', async () => {
    const cb = createSlackReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeSlackError('missing_scope')
        },
      },
    })
    const result = await cb(addReq({ channel: 'C1', ts: '1.1' }))
    expect(result).toMatchObject({ ok: false, code: 'permission-denied' })
    if (!result.ok) expect(result.error).toContain('reactions:write')
  })

  it('maps ratelimited to rate-limited', async () => {
    const cb = createSlackReactionCallback({
      client: {
        addReaction: async () => {
          throw new FakeSlackError('ratelimited')
        },
      },
    })
    const result = await cb(addReq({ channel: 'C1', ts: '1.1' }))
    expect(result).toMatchObject({ ok: false, code: 'rate-limited' })
  })

  it('rejects an unparseable ref', async () => {
    const cb = createSlackReactionCallback({ client: { addReaction: async () => {} } })
    const result = await cb({
      ...addReq({ channel: 'C1', ts: '1.1' }),
      reactionRef: { adapter: 'slack-bot', value: 'x' },
    })
    expect(result).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('rejects a ref for the wrong adapter', async () => {
    const cb = createSlackReactionCallback({ client: { addReaction: async () => {} } })
    const result = await cb({ ...addReq({ channel: 'C1', ts: '1.1' }), adapter: 'discord-bot' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported' })
  })
})

describe('createSlackRemoveReactionCallback', () => {
  const removeReq = (emoji = 'rocket'): RemoveReactionRequest => ({
    adapter: 'slack-bot',
    workspace: 'T1',
    chat: 'C1',
    thread: null,
    reactionRef: encodeSlackRemovalRef({ channel: 'C1', ts: '1.1', emoji }),
  })

  it('removes the reaction by channel, ts and emoji', async () => {
    const calls: AddCall[] = []
    const cb = createSlackRemoveReactionCallback({
      client: { removeReaction: async (channel, ts, emoji) => void calls.push({ channel, ts, emoji }) },
    })
    const result = await cb(removeReq('rocket'))
    expect(calls).toEqual([{ channel: 'C1', ts: '1.1', emoji: 'rocket' }])
    expect(result.ok).toBe(true)
  })

  it('treats no_reaction as success', async () => {
    const cb = createSlackRemoveReactionCallback({
      client: {
        removeReaction: async () => {
          throw new FakeSlackError('no_reaction')
        },
      },
    })
    expect((await cb(removeReq())).ok).toBe(true)
  })
})
