import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import { renderShard } from './frontmatter'
import { topicShardPath, topicsDir } from './paths'

const hybridSearchMock = mock(async () => [
  {
    source: 'topic' as const,
    key: 'second-topic',
    heading: 'Second Topic',
    excerpt: 'Second topic excerpt from vector retrieval.',
    rrfScore: 1,
  },
])

mock.module('./vector/hybrid', () => ({
  hybridSearch: hybridSearchMock,
}))

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-vector-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('vector session.turn.start hook', () => {
  test('over-budget turn runs hybrid search and injects top-K under # Memory framing', async () => {
    const memoryPlugin = (await import('./index')).default
    // given: two 3 KB shards (6 KB total) with a 4 KB budget → index mode
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
    const exports = await bootVectorPlugin(memoryPlugin, 4096)

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'second prompt', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(hybridSearchMock).toHaveBeenCalledWith('second prompt', expect.anything(), agentDir, 10)
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Second Topic')
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
    expect(retrievalContext.results).not.toContain('## Retrieved memory')
  })

  test('under-budget turn injects ALL shard bodies without hybrid search (direct mode)', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    // given: two small shards well under the budget → direct mode
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'first body')
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'second body')
    const exports = await bootVectorPlugin(memoryPlugin, 16384)

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(hybridSearchMock).not.toHaveBeenCalled()
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## First Topic')
    expect(retrievalContext.results).toContain('first body')
    expect(retrievalContext.results).toContain('## Second Topic')
    expect(retrievalContext.results).toContain('second body')
  })

  test('memory-logger subagent is created with onFragmentsAppended hook when vector.enabled is true', async () => {
    const memoryPlugin = (await import('./index')).default
    const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes: 4096, vector: { enabled: true } })
    if (!parsed.success) throw new Error(parsed.error.message)
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger: createPluginLogger('memory'),
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)

    expect(exports.subagents).toBeDefined()
    expect(exports.subagents!['memory-logger']).toBeDefined()
    const memoryLoggerSubagent = exports.subagents!['memory-logger']!
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBeGreaterThan(0)
  })

  test('memory-logger subagent is created without onFragmentsAppended hook when vector.enabled is false', async () => {
    const memoryPlugin = (await import('./index')).default
    const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes: 4096, vector: { enabled: false } })
    if (!parsed.success) throw new Error(parsed.error.message)
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger: createPluginLogger('memory'),
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)

    expect(exports.subagents).toBeDefined()
    expect(exports.subagents!['memory-logger']).toBeDefined()
    const memoryLoggerSubagent = exports.subagents!['memory-logger']!
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBeGreaterThan(0)
  })
})

async function bootVectorPlugin(memoryPlugin: typeof import('./index').default, injectionBudgetBytes: number) {
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes, vector: { enabled: true } })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger: createPluginLogger('memory'),
    permissions: noopPermissionService,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}
