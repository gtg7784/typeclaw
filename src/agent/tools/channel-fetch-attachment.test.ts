import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelRouter, type ChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { FetchAttachmentArgs, FetchAttachmentResult } from '@/channels/types'

import { createChannelFetchAttachmentTool } from './channel-fetch-attachment'

function emptyAdapterConfig(): ChannelAdapterConfig {
  return {
    allow: ['*'],
    engagement: { trigger: ['mention'], stickiness: 'off' },
    enabled: true,
    history: defaultHistoryConfig(),
  }
}

function makeRouter(): ChannelRouter {
  return createChannelRouter({
    agentDir: '/tmp/test-channel-fetch-attachment',
    configForAdapter: () => emptyAdapterConfig(),
  })
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelFetchAttachmentTool>['execute']>[4]

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

  test('downloads a Slack file via the adapter callback and writes it to the inbox dir', async () => {
    const router = makeRouter()
    const calls: FetchAttachmentArgs[] = []
    router.registerFetchAttachment('slack-bot', async (args): Promise<FetchAttachmentResult> => {
      calls.push(args)
      return {
        ok: true,
        buffer: Buffer.from('hello-bytes'),
        filename: 'diagram.png',
        mimetype: 'image/png',
        size: 11,
      }
    })

    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'slack-bot' },
      inboxDir,
    })

    const result = await runTool(tool, { ref: 'F12345' })

    expect(calls).toEqual([{ ref: 'F12345' }])
    expect(result.details).toMatchObject({ ok: true, mimetype: 'image/png', size: 11 })
    const expectedPath = join(inboxDir, 'slack-bot', 'F12345', 'diagram.png')
    expect(result.details?.path).toBe(expectedPath)
    expect(readFileSync(expectedPath, 'utf8')).toBe('hello-bytes')
    expect(result.content[0]).toEqual({
      type: 'text',
      text: `saved 11 bytes to ${expectedPath} (image/png)`,
    })
  })

  test('strips the `id=` prefix from a Slack ref so the agent can paste the classifier output verbatim', async () => {
    const router = makeRouter()
    const calls: FetchAttachmentArgs[] = []
    router.registerFetchAttachment('slack-bot', async (args) => {
      calls.push(args)
      return { ok: true, buffer: Buffer.from('x'), filename: 'a.txt', mimetype: 'text/plain', size: 1 }
    })

    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'slack-bot' },
      inboxDir,
    })

    await runTool(tool, { ref: 'id=FABC123' })

    expect(calls[0]?.ref).toBe('FABC123')
  })

  test('downloads a Discord CDN URL and slugs the URL basename into the directory layout', async () => {
    const router = makeRouter()
    router.registerFetchAttachment('discord-bot', async (_args) => ({
      ok: true,
      buffer: Buffer.from('discord-bytes'),
      filename: 'one.png',
      mimetype: 'image/png',
      size: 13,
    }))

    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'discord-bot' },
      inboxDir,
    })

    const result = await runTool(tool, {
      ref: 'https://cdn.discordapp.com/attachments/c1/a1/one.png',
    })

    expect(result.details?.ok).toBe(true)
    expect(result.details?.path).toBe(join(inboxDir, 'discord-bot', 'one.png', 'one.png'))
    expect(readFileSync(result.details!.path!, 'utf8')).toBe('discord-bytes')
  })

  test('forwards a custom filename through to the adapter and uses it as the on-disk name', async () => {
    const router = makeRouter()
    const calls: FetchAttachmentArgs[] = []
    router.registerFetchAttachment('slack-bot', async (args) => {
      calls.push(args)
      return {
        ok: true,
        buffer: Buffer.from('z'),
        filename: args.filename ?? 'fallback.bin',
        mimetype: 'application/octet-stream',
        size: 1,
      }
    })

    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'slack-bot' },
      inboxDir,
    })

    const result = await runTool(tool, { ref: 'F1', filename: 'renamed.bin' })

    expect(calls[0]).toEqual({ ref: 'F1', filename: 'renamed.bin' })
    expect(result.details?.ok).toBe(true)
    expect(result.details?.path?.endsWith('/renamed.bin')).toBe(true)
  })

  test('sanitizes path-traversal attempts in the filename so the agent cannot escape the inbox dir', async () => {
    const router = makeRouter()
    router.registerFetchAttachment('slack-bot', async () => ({
      ok: true,
      buffer: Buffer.from('safe'),
      filename: '../../etc/passwd',
      mimetype: 'text/plain',
      size: 4,
    }))

    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'slack-bot' },
      inboxDir,
    })

    const result = await runTool(tool, { ref: 'F1' })

    expect(result.details?.ok).toBe(true)
    expect(result.details?.path?.startsWith(inboxDir)).toBe(true)
    expect(result.details?.path?.split('/').includes('..')).toBe(false)
  })

  test('returns the upstream error verbatim when the adapter rejects the ref', async () => {
    const router = makeRouter()
    router.registerFetchAttachment('slack-bot', async () => ({
      ok: false,
      error: 'invalid Slack file id: F-bogus',
    }))

    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'slack-bot' },
      inboxDir,
    })

    const result = await runTool(tool, { ref: 'F-bogus' })

    expect(result.details).toEqual({ ok: false, error: 'invalid Slack file id: F-bogus' })
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'channel_fetch_attachment error: invalid Slack file id: F-bogus',
    })
  })

  test('reports a friendly error when no adapter has registered a fetch callback', async () => {
    const router = makeRouter()
    const tool = createChannelFetchAttachmentTool({
      router,
      origin: { adapter: 'slack-bot' },
      inboxDir,
    })

    const result = await runTool(tool, { ref: 'F1' })

    expect(result.details).toEqual({
      ok: false,
      error: 'no fetchAttachment callback registered for "slack-bot"',
    })
  })
})
