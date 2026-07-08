import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { FetchAttachmentArgs, FetchAttachmentResult, InboundAttachment } from '@/channels/types'
import { createPermissionService } from '@/permissions/permissions'

import {
  createChannelFetchAttachmentTool,
  DEFAULT_INBOX_DIR,
  PUBLIC_INBOX_DIR,
  resolveInboxBaseDir,
} from './channel-fetch-attachment'

const origin = { adapter: 'slack-bot' as const, workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createChannelFetchAttachmentTool>['execute']>[4]

type FakeRouterOptions = {
  attachments?: readonly InboundAttachment[]
  fetch?: (adapter: AdapterId, args: FetchAttachmentArgs) => Promise<FetchAttachmentResult>
}

function makeRouter(options: FakeRouterOptions = {}): ChannelRouter {
  const attachments = options.attachments ?? []
  return {
    route: async () => {},
    send: async () => ({ ok: true }),
    getConsecutiveSendCount: () => 0,
    getSendRate: () => ({ count: 0, windowMs: 0 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerReaction: () => {},
    unregisterReaction: () => {},
    react: async () => ({ ok: true }),
    queueReactionAfterReply: async () => ({ ok: true }),
    registerRemoveReaction: () => {},
    unregisterRemoveReaction: () => {},
    removeReaction: async () => ({ ok: true }),
    registerTyping: () => {},
    unregisterTyping: () => {},
    setTypingCapability: () => {},
    setAdapterConfigured: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: true, messages: [] }),
    registerMessageGet: () => {},
    unregisterMessageGet: () => {},
    getMessage: async () => ({ ok: false, error: 'message-get-not-supported', code: 'not-supported' }),
    registerList: () => {},
    unregisterList: () => {},
    listChannels: async () => ({ ok: false, error: 'list-not-supported', code: 'not-supported' }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: options.fetch ?? (async () => ({ ok: false, error: 'not implemented' })),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState: async () => ({ ok: true, selfBlocking: false, approve: true }),
    lookupInboundAttachment: (args) => attachments.find((attachment) => attachment.id === args.id) ?? null,
    listInboundAttachmentIds: () => attachments.map((attachment) => attachment.id),
    registerHistoryAttachments: () => {},
    executeCommand: async () => ({ kind: 'no-live-session' }),
    getSelfAliases: () => [],
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    noteGithubReviewOutput: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
    stop: async () => {},
    tearDownAllLive: async () => {},
    markRestartAbortForAllLive: async () => {},
    liveCount: () => 0,
  }
}

async function runTool(
  tool: ReturnType<typeof createChannelFetchAttachmentTool>,
  params: Parameters<ReturnType<typeof createChannelFetchAttachmentTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('channel_fetch_attachment', () => {
  let inboxDir: string

  beforeEach(() => {
    inboxDir = mkdtempSync(join(tmpdir(), 'typeclaw-fetch-attachment-'))
  })

  afterEach(() => {
    rmSync(inboxDir, { recursive: true, force: true })
  })

  test('downloads a looked-up attachment via the adapter callback and writes it to the inbox dir', async () => {
    const calls: Array<{ adapter: AdapterId; args: FetchAttachmentArgs }> = []
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F12345', filename: 'diagram.png', mimetype: 'image/png' }],
      fetch: async (adapter, args) => {
        calls.push({ adapter, args })
        return {
          ok: true,
          buffer: Buffer.from('hello-bytes'),
          filename: 'diagram.png',
          mimetype: 'image/png',
          size: 11,
        }
      },
    })

    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })

    const result = await runTool(tool, { attachment_id: 1 })

    expect(calls).toEqual([{ adapter: 'slack-bot', args: { ref: 'F12345', filename: 'diagram.png' } }])
    expect(result.details).toMatchObject({ ok: true, mimetype: 'image/png', size: 11 })
    const expectedPath = join(inboxDir, 'slack-bot', 'F12345', 'diagram.png')
    expect(result.details?.path).toBe(expectedPath)
    expect(readFileSync(expectedPath, 'utf8')).toBe('hello-bytes')
  })

  test('uses an explicit filename override instead of attachment metadata', async () => {
    const calls: FetchAttachmentArgs[] = []
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F1', filename: 'original.bin' }],
      fetch: async (_adapter, args) => {
        calls.push(args)
        return { ok: true, buffer: Buffer.from('z'), filename: args.filename ?? 'fallback.bin', size: 1 }
      },
    })

    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })
    const result = await runTool(tool, { attachment_id: 1, filename: 'renamed.bin' })

    expect(calls).toEqual([{ ref: 'F1', filename: 'renamed.bin' }])
    expect(result.details?.path).toMatch(/[/\\]renamed\.bin$/)
  })

  test('rejects hallucinated attachment ids with a valid id list', async () => {
    const router = makeRouter({ attachments: [{ id: 2, kind: 'file', ref: 'F2', filename: 'two.txt' }] })
    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })

    const result = await runTool(tool, { attachment_id: 1 })

    expect(result.details).toEqual({
      ok: false,
      error:
        'no attachment with id=1 (resolvable attachment_ids: 2). For an attachment from an earlier message, call channel_history first to make it resolvable; otherwise do not invent ids that are not in the inbound message.',
    })
  })

  test('rejects empty-ref attachments with a clear unfetchable-media error', async () => {
    const router = makeRouter({ attachments: [{ id: 1, kind: 'sticker', ref: '', filename: 'party.webp' }] })
    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })

    const result = await runTool(tool, { attachment_id: 1 })

    expect(result.details).toEqual({
      ok: false,
      error:
        'attachment #1 (sticker) has no fetchable ref — likely a sticker or an upstream payload without a public URL. Acknowledge the user but do not promise to view it.',
    })
  })

  test('returns the upstream error verbatim when the adapter rejects the resolved ref', async () => {
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F-bogus' }],
      fetch: async () => ({ ok: false, error: 'invalid Slack file id: F-bogus' }),
    })

    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })
    const result = await runTool(tool, { attachment_id: 1 })

    expect(result.details).toEqual({ ok: false, error: 'invalid Slack file id: F-bogus' })
  })

  test('resolveBaseDir wins over inboxDir and steers the write per role', async () => {
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F1', filename: 'shot.png' }],
      fetch: async () => ({ ok: true, buffer: Buffer.from('x'), filename: 'shot.png', size: 1 }),
    })
    const tool = createChannelFetchAttachmentTool({
      router,
      origin,
      inboxDir,
      resolveBaseDir: () => join(inboxDir, 'redirected'),
    })

    const result = await runTool(tool, { attachment_id: 1 })

    const expectedPath = join(inboxDir, 'redirected', 'slack-bot', 'F1', 'shot.png')
    expect(result.details?.path).toBe(expectedPath)
    expect(readFileSync(expectedPath, 'utf8')).toBe('x')
  })
})

describe('resolveInboxBaseDir — per-role download location', () => {
  const AGENT = '/agent'
  const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
  const spawnedBy = (role: string): SessionOrigin => ({
    kind: 'subagent',
    subagent: 'x',
    parentSessionId: 'p',
    spawnedByRole: role,
  })

  test('owner (sees workspace/) keeps the private-surface inbox', () => {
    const svc = createPermissionService()
    expect(resolveInboxBaseDir(svc, tui, AGENT)).toBe(DEFAULT_INBOX_DIR)
  })

  test('member (sees workspace/) keeps the private-surface inbox', () => {
    const svc = createPermissionService()
    expect(resolveInboxBaseDir(svc, spawnedBy('member'), AGENT)).toBe(DEFAULT_INBOX_DIR)
  })

  test('guest (hidden from workspace/) is redirected to the public inbox', () => {
    const svc = createPermissionService()
    expect(resolveInboxBaseDir(svc, spawnedBy('guest'), AGENT)).toBe(PUBLIC_INBOX_DIR)
  })

  test('undefined origin fails safe to the public inbox', () => {
    const svc = createPermissionService()
    expect(resolveInboxBaseDir(svc, undefined, AGENT)).toBe(PUBLIC_INBOX_DIR)
  })
})
