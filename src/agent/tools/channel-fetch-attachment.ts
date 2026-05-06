import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

export type ChannelFetchAttachmentOrigin = {
  adapter: AdapterId
}

export type CreateChannelFetchAttachmentToolOptions = {
  router: ChannelRouter
  origin: ChannelFetchAttachmentOrigin
  inboxDir?: string
}

export const DEFAULT_INBOX_DIR = '/agent/workspace/inbox'

export function createChannelFetchAttachmentTool({
  router,
  origin,
  inboxDir,
}: CreateChannelFetchAttachmentToolOptions) {
  const baseDir = inboxDir ?? DEFAULT_INBOX_DIR
  const adapter = origin.adapter
  return defineTool({
    name: 'channel_fetch_attachment',
    label: 'Channel Fetch Attachment',
    description:
      'Download a file the user attached to the inbound channel message and save it to disk. Inbound channel ' +
      'messages with uploads carry a `[<Platform> message with attachment: <name> (<mime>) <ref>]` summary — pass ' +
      "the literal `<ref>` value as `ref`. For Slack the ref looks like `id=Fxxxx` (use `Fxxxx`); for Discord it's " +
      'the full `https://cdn.discordapp.com/...` URL. The tool authenticates with the channel adapter (Slack ' +
      'url_private requires the bot token; Discord CDN URLs are signed and expire ~24h, so fetch promptly). On ' +
      'success returns the absolute path of the saved file plus its detected mimetype and size. On failure returns ' +
      'the upstream error verbatim.',
    parameters: Type.Object({
      ref: Type.String({
        description:
          'Slack: the file id `Fxxxx` (with or without the `id=` prefix). Discord: the full `https://cdn.discordapp.com/...` or `https://media.discordapp.net/...` URL.',
        minLength: 1,
      }),
      filename: Type.Optional(
        Type.String({
          description:
            'Override the saved filename. Defaults to the upstream filename (Slack) or the URL basename (Discord).',
          minLength: 1,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      type Details = { ok: boolean; error?: string; path?: string; mimetype?: string; size?: number }
      const ref = normalizeRef(params.ref)
      const result = await router.fetchAttachment(adapter, {
        ref,
        ...(params.filename !== undefined ? { filename: params.filename } : {}),
      })
      if (!result.ok) {
        const text = `channel_fetch_attachment error: ${result.error}`
        const details: Details = { ok: false, error: result.error }
        return { content: [{ type: 'text' as const, text }], details }
      }

      const safeFilename = sanitizeFilename(result.filename)
      const refSlug = sanitizeRefSlug(ref)
      const targetDir = join(baseDir, adapter, refSlug)
      const targetPath = join(targetDir, safeFilename)
      try {
        await mkdir(targetDir, { recursive: true })
        await writeFile(targetPath, result.buffer)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const text = `channel_fetch_attachment error: write failed: ${message}`
        const details: Details = { ok: false, error: `write failed: ${message}` }
        return { content: [{ type: 'text' as const, text }], details }
      }

      const mimetypePart = result.mimetype !== undefined ? ` (${result.mimetype})` : ''
      const text = `saved ${result.size} bytes to ${targetPath}${mimetypePart}`
      const details: Details = {
        ok: true,
        path: targetPath,
        ...(result.mimetype !== undefined ? { mimetype: result.mimetype } : {}),
        size: result.size,
      }
      return { content: [{ type: 'text' as const, text }], details }
    },
  })
}

function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.startsWith('id=')) return trimmed.slice(3)
  return trimmed
}

const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]/g

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME_CHARS, '_')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'attachment'
  return cleaned
}

function sanitizeRefSlug(ref: string): string {
  const trailing =
    ref
      .split('/')
      .filter((s) => s.length > 0)
      .pop() ?? 'ref'
  const cleaned = trailing.replace(UNSAFE_FILENAME_CHARS, '_').slice(0, 64)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'ref'
  return cleaned
}
