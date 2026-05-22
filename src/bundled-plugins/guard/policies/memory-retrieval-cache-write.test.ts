import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'

import {
  GUARD_MEMORY_RETRIEVAL_CACHE_WRITE_SEVERITY,
  isMemoryRetrievalCacheWriteAllowed,
} from './memory-retrieval-cache-write'

const AGENT_DIR = path.resolve('/agent')

describe('memory-retrieval-cache-write guard helper', () => {
  test('allows memory-retrieval subagent writes to memory/.retrieval-cache/s1.md', async () => {
    await expect(allowed('write', 'memory/.retrieval-cache/s1.md')).resolves.toBe(true)
  })

  test('denies wrong subagent name', async () => {
    await expect(
      allowed('write', 'memory/.retrieval-cache/s1.md', {
        kind: 'subagent',
        subagent: 'dreaming',
        parentSessionId: 's1',
      }),
    ).resolves.toBe(false)
  })

  test('denies tui origin', async () => {
    await expect(allowed('write', 'memory/.retrieval-cache/s1.md', { kind: 'tui', sessionId: 's1' })).resolves.toBe(
      false,
    )
  })

  test('denies cron origin', async () => {
    await expect(
      allowed('write', 'memory/.retrieval-cache/s1.md', { kind: 'cron', jobId: 'j1', jobKind: 'prompt' }),
    ).resolves.toBe(false)
  })

  test('denies edit tool instead of write', async () => {
    await expect(allowed('edit', 'memory/.retrieval-cache/s1.md')).resolves.toBe(false)
  })

  test('denies nested cache paths', async () => {
    await expect(allowed('write', 'memory/.retrieval-cache/sub/s1.md')).resolves.toBe(false)
  })

  test('denies traversal outside the cache directory', async () => {
    await expect(allowed('write', '../typeclaw.json')).resolves.toBe(false)
    await expect(allowed('write', 'memory/.retrieval-cache/../topics/s1.md')).resolves.toBe(false)
  })

  test('denies bad session id characters', async () => {
    await expect(allowed('write', 'memory/.retrieval-cache/bad id.md')).resolves.toBe(false)
    await expect(allowed('write', 'memory/.retrieval-cache/slash:name.md')).resolves.toBe(false)
  })

  test('severity constant is low', () => {
    expect(GUARD_MEMORY_RETRIEVAL_CACHE_WRITE_SEVERITY).toBe('low')
  })
})

function allowed(
  tool: string,
  targetPath: string,
  origin: SessionOrigin = { kind: 'subagent', subagent: 'memory-retrieval', parentSessionId: 's1' },
): Promise<boolean> {
  return isMemoryRetrievalCacheWriteAllowed({
    tool,
    args: { path: targetPath },
    agentDir: AGENT_DIR,
    origin,
  })
}
