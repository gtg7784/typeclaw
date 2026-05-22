import { unlink } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import { z } from 'zod'

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/

export const deleteTopicShardTool = {
  name: 'delete_topic_shard',
  description:
    'Delete a single topic shard file under memory/topics/. Only accepts relative paths of the form memory/topics/<slug>.md. Returns structured result; never throws.',
  inputSchema: z.object({ path: z.string() }),
  async run(input: { path: string }, ctx: { agentDir: string }) {
    const rawPath = input.path.trim()

    if (isAbsolute(rawPath) || rawPath.includes(':')) {
      return { ok: false, reason: 'invalid_path' }
    }

    const segments = rawPath.split(/[/\\]/).filter(Boolean)
    if (segments.includes('..')) {
      return { ok: false, reason: 'invalid_path' }
    }

    const normalized = rawPath.replace(/\\/g, '/')
    if (!/^memory\/topics\/[^/]+\.md$/.test(normalized)) {
      return { ok: false, reason: 'invalid_path' }
    }

    const slug = normalized.slice('memory/topics/'.length, -'.md'.length)
    if (!SLUG_REGEX.test(slug)) {
      return { ok: false, reason: 'invalid_slug' }
    }

    const targetPath = join(ctx.agentDir, 'memory', 'topics', `${slug}.md`)
    const expectedDir = join(ctx.agentDir, 'memory', 'topics')
    const rel = relative(expectedDir, targetPath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, reason: 'invalid_path' }
    }

    try {
      await unlink(targetPath)
    } catch (err) {
      if (isEnoent(err)) {
        return { ok: false, reason: 'not_found' }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: 'fs_error', message }
    }

    return { ok: true, path: `memory/topics/${slug}.md` }
  },
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as Error & { code: string }).code === 'ENOENT'
}
