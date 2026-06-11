import path from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import type { SecuritySeverity } from '@/bundled-plugins/security/permissions'

export const GUARD_MEMORY_RETRIEVAL_CACHE_WRITE = 'memoryRetrievalCacheWrite'
export const GUARD_MEMORY_RETRIEVAL_CACHE_WRITE_SEVERITY: SecuritySeverity = 'low'

const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/

export async function isMemoryRetrievalCacheWriteAllowed(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  origin?: SessionOrigin
}): Promise<boolean> {
  const { tool, args, agentDir, origin } = options
  if (tool !== 'write') return false
  // Allow the memory-retrieval subagent (existing path) OR the in-process
  // vector retrieval writer (system origin with component='memory-retrieval').
  // The in-process path runs under the session origin, not a subagent, so we
  // check for the system component name as the trusted internal actor.
  const isMemoryRetrievalSubagent = origin?.kind === 'subagent' && origin.subagent === 'memory-retrieval'
  const isInProcessWriter = origin?.kind === 'system' && origin.component === 'memory-retrieval'
  if (!isMemoryRetrievalSubagent && !isInProcessWriter) return false

  const rawPath = args.path
  if (typeof rawPath !== 'string') return false

  const targetPath = path.resolve(agentDir, rawPath)
  const expectedDir = path.resolve(agentDir, 'memory', '.retrieval-cache')
  const relative = path.relative(expectedDir, targetPath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false

  const parts = relative.split(path.sep).filter(Boolean)
  if (parts.length !== 1) return false

  const fileName = parts[0]!
  if (!fileName.endsWith('.md')) return false

  const sessionId = fileName.slice(0, -3)
  return SESSION_ID_REGEX.test(sessionId)
}
