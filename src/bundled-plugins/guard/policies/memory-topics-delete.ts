import path from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { SLUG_REGEX } from '@/bundled-plugins/memory/slug'
import type { SecuritySeverity } from '@/bundled-plugins/security/permissions'

import type { GuardBlock } from '../policy'

export const GUARD_MEMORY_TOPICS_DELETE = 'memoryTopicsDelete'

export const GUARD_MEMORY_TOPICS_DELETE_SEVERITY: SecuritySeverity = 'medium'

export function checkMemoryTopicsDeleteGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  origin?: SessionOrigin
}): GuardBlock | undefined {
  const { tool, args, agentDir, origin } = options

  if (tool !== 'delete_topic_shard') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') {
    return block(tool, 'path argument must be a string')
  }

  if (origin?.kind !== 'subagent' || origin.subagent !== 'dreaming') {
    return block(tool, 'only the dreaming subagent may delete topic shards')
  }

  const targetPath = path.resolve(agentDir, rawPath)
  const topicsDir = path.resolve(agentDir, 'memory', 'topics')
  const relative = path.relative(topicsDir, targetPath)

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return block(tool, `path must be a direct child of memory/topics/: ${targetPath}`)
  }

  const parts = relative.split(path.sep).filter(Boolean)
  if (parts.length !== 1) {
    return block(tool, `path must be a single .md file inside memory/topics/: ${targetPath}`)
  }

  const fileName = parts[0]!
  if (!fileName.endsWith('.md')) {
    return block(tool, `path must be a single .md file inside memory/topics/: ${targetPath}`)
  }

  const slug = fileName.slice(0, -3)
  if (!SLUG_REGEX.test(slug)) {
    return block(tool, `slug must match ${SLUG_REGEX}: ${slug}`)
  }

  return undefined
}

function block(tool: string, reason: string): GuardBlock {
  return {
    block: true,
    reason: `Guard \`${GUARD_MEMORY_TOPICS_DELETE}\` blocked ${tool}: ${reason}.`,
  }
}
