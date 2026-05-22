import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { checkMemoryTopicsDeleteGuard, GUARD_MEMORY_TOPICS_DELETE_SEVERITY } from './memory-topics-delete'

const AGENT_DIR = path.resolve('/agent')

describe('memory-topics-delete guard policy', () => {
  test('allows dreaming subagent + memory/topics/foo.md', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
    })
    expect(result).toBeUndefined()
  })

  test('denies tui origin', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'tui', sessionId: 's1' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('only the dreaming subagent'),
    })
  })

  test('denies wrong subagent name', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'memory-logger', parentSessionId: 's1' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('only the dreaming subagent'),
    })
  })

  test('denies cron origin', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'cron', jobId: 'j1', jobKind: 'prompt' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('only the dreaming subagent'),
    })
  })

  test('denies path outside memory/topics/', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/streams/2026-05-20.jsonl' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('memory/topics/'),
    })
  })

  test('denies traversal', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: '../typeclaw.json' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('memory/topics/'),
    })
  })

  test('denies nested path', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/sub/foo.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('single .md file'),
    })
  })

  test('denies bad slug (uppercase)', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/UPPER.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
    })
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining('slug must match'),
    })
  })

  test('severity constant is medium', () => {
    expect(GUARD_MEMORY_TOPICS_DELETE_SEVERITY).toBe('medium')
  })

  test('allows edge slug (single char)', () => {
    const result = checkMemoryTopicsDeleteGuard({
      tool: 'delete_topic_shard',
      args: { path: 'memory/topics/x.md' },
      agentDir: AGENT_DIR,
      origin: { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
    })
    expect(result).toBeUndefined()
  })
})
