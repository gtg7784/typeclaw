import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { isMemoryTopicsWriteAllowed } from './memory-topics-write'

const AGENT_DIR = path.resolve('/agent')

function dreamingOrigin() {
  return { kind: 'subagent' as const, subagent: 'dreaming' as const, parentSessionId: 's1' }
}

describe('isMemoryTopicsWriteAllowed', () => {
  test('allows dreaming + memory/topics/foo.md', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(true)
  })

  test('denies wrong subagent name', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'memory-logger', parentSessionId: 's1' },
    })
    expect(result).toBe(false)
  })

  test('denies tui origin', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'tui', sessionId: 's1' },
    })
    expect(result).toBe(false)
  })

  test('denies cron origin', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'cron', jobId: 'j1', jobKind: 'prompt' },
    })
    expect(result).toBe(false)
  })

  test('denies path outside memory/topics/', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/streams/2026-05-20.jsonl' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(false)
  })

  test('denies traversal', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: '../typeclaw.json' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(false)
  })

  test('denies nested path', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/sub/foo.md' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(false)
  })

  test('denies bad slug (uppercase)', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/UPPER.md' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(false)
  })

  test('denies edit tool instead of write', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'edit',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(false)
  })

  test('allows edge slug (single char)', async () => {
    const result = await isMemoryTopicsWriteAllowed({
      tool: 'write',
      args: { path: 'memory/topics/x.md' },
      agentDir: AGENT_DIR,
      origin: dreamingOrigin(),
    })
    expect(result).toBe(true)
  })
})
