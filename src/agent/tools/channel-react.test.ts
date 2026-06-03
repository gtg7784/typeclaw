import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { ReactionRequest, ReactionResult } from '@/channels/types'

import { createChannelReactTool, type ChannelReactOrigin } from './channel-react'

function fakeRouter(react: (req: ReactionRequest) => Promise<ReactionResult>): ChannelRouter {
  return {
    route: async () => {},
    send: async () => ({ ok: true }),
    getConsecutiveSendCount: () => 0,
    getSendRate: () => ({ count: 0, windowMs: 5_000 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerReaction: () => {},
    unregisterReaction: () => {},
    react,
    registerTyping: () => {},
    unregisterTyping: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: false, error: 'history-not-supported' }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment' }),
    lookupInboundAttachment: () => null,
    listInboundAttachmentIds: () => [],
    getSelfAliases: () => [],
    stop: async () => {},
    tearDownAllLive: async () => {},
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    resumeRestartHandoff: async () => {},
  } as unknown as ChannelRouter
}

const githubOrigin: ChannelReactOrigin = {
  adapter: 'github',
  workspace: 'acme/project',
  chat: 'pr:7',
  thread: null,
  reactionRef: { adapter: 'github', value: '{"kind":"issue","owner":"acme","repo":"project","issueNumber":7}' },
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReactTool>['execute']>[4]
const run = (tool: ReturnType<typeof createChannelReactTool>, emoji: string) =>
  tool.execute('id', { emoji }, undefined, undefined, fakeCtx)

describe('createChannelReactTool', () => {
  test('forwards the triggering-inbound reaction ref and emoji to router.react', async () => {
    let captured: ReactionRequest | undefined
    const tool = createChannelReactTool({
      router: fakeRouter(async (req) => {
        captured = req
        return { ok: true }
      }),
      origin: githubOrigin,
      logger: { warn: () => {} },
    })

    const result = await run(tool, 'eyes')

    expect(result.details).toEqual({ ok: true })
    expect(captured).toEqual({
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'pr:7',
      thread: null,
      reactionRef: githubOrigin.reactionRef!,
      emoji: 'eyes',
    })
  })

  test('denies when the conversation has no reaction target', async () => {
    let called = false
    const tool = createChannelReactTool({
      router: fakeRouter(async () => {
        called = true
        return { ok: true }
      }),
      origin: { ...githubOrigin, reactionRef: undefined },
      logger: { warn: () => {} },
    })

    const result = await run(tool, 'eyes')

    expect(result.details).toEqual({ ok: false, error: 'this conversation has no message to react to' })
    expect(called).toBe(false)
  })

  test('surfaces a router.react failure as a denied tool result', async () => {
    const tool = createChannelReactTool({
      router: fakeRouter(async () => ({ ok: false, error: 'boom', code: 'permission-denied' })),
      origin: githubOrigin,
      logger: { warn: () => {} },
    })

    const result = await run(tool, 'eyes')

    expect(result.details.ok).toBe(false)
  })
})
