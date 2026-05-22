import path from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { SLUG_REGEX } from '@/bundled-plugins/memory/slug'

export async function isMemoryTopicsWriteAllowed(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  origin?: SessionOrigin
}): Promise<boolean> {
  if (options.tool !== 'write') return false

  const { origin } = options
  if (!origin || origin.kind !== 'subagent' || origin.subagent !== 'dreaming') return false

  const rawPath = options.args.path
  if (typeof rawPath !== 'string') return false

  const target = path.resolve(options.agentDir, rawPath)
  const expectedDir = path.resolve(options.agentDir, 'memory', 'topics')
  const rel = path.relative(expectedDir, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false

  const parts = rel.split(path.sep).filter(Boolean)
  const fileName = parts[0]
  if (parts.length !== 1 || !fileName || !fileName.endsWith('.md')) return false

  const slug = fileName.slice(0, -3)
  if (!SLUG_REGEX.test(slug)) return false

  return true
}
