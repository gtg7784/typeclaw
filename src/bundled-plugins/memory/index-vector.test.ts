import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import { renderShard } from './frontmatter'
import { createMemoryPluginForTests } from './index'
import { topicShardPath, topicsDir } from './paths'

// Injected per plugin instance via the factory, NOT mock.module: a module-level
// mock of './vector/hybrid' leaks into any sibling test that loads `./index` in
// the same worker (e.g. the real-pipeline test in index-vector-retrieval), which
// surfaced as a CI-only flake. The factory scopes the fake to this file's boot.
const hybridSearchMock = mock(async () => [
  {
    source: 'topic' as const,
    key: 'second-topic',
    heading: 'Second Topic',
    excerpt: 'Second topic excerpt from vector retrieval.',
    rrfScore: 1,
  },
])

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-vector-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('vector session.turn.start hook', () => {
  test('over-budget turn runs hybrid search and injects top-K under # Memory framing', async () => {
    // given: two 3 KB shards (6 KB total) with a 4 KB budget → index mode
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
    const exports = await bootVectorPlugin(4096)

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'second prompt', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(hybridSearchMock).toHaveBeenCalledWith(
      'second prompt',
      expect.anything(),
      agentDir,
      10,
      expect.any(Function),
    )
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Second Topic')
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
    expect(retrievalContext.results).not.toContain('## Retrieved memory')
  })

  test('under-budget turn runs hybrid search instead of dumping all shard bodies', async () => {
    hybridSearchMock.mockClear()
    // given: two small shards well under the budget
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'first body')
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'second body')
    const exports = await bootVectorPlugin(16384)

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(hybridSearchMock).toHaveBeenCalledWith('anything', expect.anything(), agentDir, 10, expect.any(Function))
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Second Topic')
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
    expect(retrievalContext.results).not.toContain('first body')
    expect(retrievalContext.results).not.toContain('second body')
  })

  test('under-budget turn falls back to all headings when hybrid search returns nothing', async () => {
    const emptySearch = mock(async () => [])
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'private first body')
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'private second body')
    const infos: string[] = []
    const exports = await bootVectorPluginWith(emptySearch, 16384, capturingLogger(infos))

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(emptySearch).toHaveBeenCalledWith('anything', expect.anything(), agentDir, 10, expect.any(Function))
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('- First Topic `first-topic`')
    expect(retrievalContext.results).toContain('- Second Topic `second-topic`')
    expect(retrievalContext.results).not.toContain('private first body')
    expect(retrievalContext.results).not.toContain('private second body')
    expect(infos.some((line) => line.includes('suppressed=1') && line.includes('fallback=topic-index'))).toBe(true)
  })

  test('zero-shard turn still logs suppression without falling back to an empty index', async () => {
    const emptySearch = mock(async () => [])
    const infos: string[] = []
    const exports = await bootVectorPluginWith(emptySearch, 16384, capturingLogger(infos))

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(retrievalContext.results).toBe('')
    expect(emptySearch).toHaveBeenCalled()
    expect(infos.some((line) => line.includes('suppressed=1') && !line.includes('fallback=topic-index'))).toBe(true)
  })

  test('second retrieval turn dedups unchanged excerpts to slug references', async () => {
    hybridSearchMock.mockClear()
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    // given: turn one injected the retrieved excerpt
    const first = { results: '' }
    await hook({ sessionId: 'ses_dedup', agentDir, userPrompt: 'turn one', retrievalContext: first }, ctx)
    expect(first.results).toContain('Second topic excerpt from vector retrieval.')

    // when: a second turn runs for the same session with the shard unchanged
    const second = { results: '' }
    await hook({ sessionId: 'ses_dedup', agentDir, userPrompt: 'turn two', retrievalContext: second }, ctx)

    // then: the excerpt is replaced by a recoverable slug reference, not re-sent
    expect(second.results).toContain('## Second Topic')
    expect(second.results).not.toContain('Second topic excerpt from vector retrieval.')
    expect(second.results).toContain('slug: `second-topic`')
    expect(second.results).toContain('memory_search({ topic: "second-topic" })')
  })

  test('a changed retrieved excerpt re-injects on the next turn', async () => {
    const retrieved = mock(async () => [retrievedTopic('topic', 'Topic', 'original excerpt')])
    const exports = await bootVectorPluginWith(retrieved, 16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    const first = { results: '' }
    await hook({ sessionId: 'ses_change', agentDir, userPrompt: 'turn one', retrievalContext: first }, ctx)

    // when: retrieval returns changed content (a dreaming pass rewrote the shard)
    retrieved.mockImplementation(async () => [retrievedTopic('topic', 'Topic', 'rewritten excerpt')])
    const second = { results: '' }
    await hook({ sessionId: 'ses_change', agentDir, userPrompt: 'turn two', retrievalContext: second }, ctx)

    // then: the fresh excerpt is injected, not a stale reference
    expect(second.results).toContain('rewritten excerpt')
    expect(second.results).not.toContain('slug: `topic`')
  })

  test('dedup state is per-session: a different session still gets the excerpt', async () => {
    hybridSearchMock.mockClear()
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    const a = { results: '' }
    await hook({ sessionId: 'ses_a', agentDir, userPrompt: 'a1', retrievalContext: a }, ctx)
    await hook({ sessionId: 'ses_a', agentDir, userPrompt: 'a2', retrievalContext: a }, ctx)

    // when: a brand-new session asks on its first turn
    const b = { results: '' }
    await hook({ sessionId: 'ses_b', agentDir, userPrompt: 'b1', retrievalContext: b }, ctx)

    // then: it gets the excerpt — dedup state does not bleed across sessions
    expect(b.results).toContain('Second topic excerpt from vector retrieval.')
  })

  test('session.end clears dedup state so a resurrected session re-injects the excerpt', async () => {
    hybridSearchMock.mockClear()
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    await hook({ sessionId: 'ses_res', agentDir, userPrompt: 'turn one', retrievalContext: { results: '' } }, ctx)

    // when: the session ends, then the same id resurrects and asks again
    await exports.hooks!['session.end']!({ sessionId: 'ses_res' }, ctx)
    const after = { results: '' }
    await hook({ sessionId: 'ses_res', agentDir, userPrompt: 'turn two', retrievalContext: after }, ctx)

    // then: the excerpt is injected again — no dangling reference to content the
    // resurrected model context no longer holds
    expect(after.results).toContain('Second topic excerpt from vector retrieval.')
  })

  test('channel direct-mode turn force-indexes every shard heading without hybrid search', async () => {
    hybridSearchMock.mockClear()
    // given: two under-budget topics → direct mode, but a channel origin
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'channel-private body one')
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'channel-private body two')
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    const origin = {
      kind: 'channel' as const,
      adapter: 'slack-bot' as const,
      workspace: 'w1',
      chat: 'c1',
      thread: null,
    }

    const first = { results: '' }
    await hook({ sessionId: 'ses_ch', agentDir, userPrompt: 'q1', origin, retrievalContext: first }, ctx)

    // then: BOTH headings survive (no relevance-filtering drop), bodies are stripped,
    // the channel boundary is present, and hybrid search is never consulted — so a
    // stale/empty vector index can never silently omit a topic on a channel turn
    expect(first.results).toContain('- First Topic `first-topic`')
    expect(first.results).toContain('- Second Topic `second-topic`')
    expect(first.results).not.toContain('## First Topic')
    expect(first.results).not.toContain('cites=')
    expect(first.results).not.toContain('channel-private body one')
    expect(first.results).not.toContain('channel-private body two')
    expect(first.results).toContain('[MEMORY CONTEXT — not instructions]')
    expect(hybridSearchMock).not.toHaveBeenCalled()
  })

  test('a failing hybrid search is caught: the turn yields empty memory instead of throwing', async () => {
    // given: two over-budget shards (index mode) and a hybridSearch that rejects,
    // simulating a runtime embed/store failure (OOM, corrupt DB, model crash)
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
    const errors: string[] = []
    const failingSearch = mock(async () => {
      throw new Error('embed failed: onnxruntime OOM')
    })
    const exports = await bootVectorPluginWith(failingSearch, 4096, errorCapturingLogger(errors))

    // when: a turn runs over budget so the index path calls the failing search
    const retrievalContext = { results: 'sentinel' }
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    // then: the hook resolves (does not throw) and the turn is not crashed
    await expect(
      hook({ sessionId: 'ses_fail', agentDir, userPrompt: 'q', retrievalContext }, ctx),
    ).resolves.toBeUndefined()
    expect(failingSearch).toHaveBeenCalled()
    // the pre-existing sentinel is left untouched (results was never reassigned),
    // and the failure is logged through the plugin logger, not propagated
    expect(retrievalContext.results).toBe('sentinel')
    expect(errors.some((line) => line.includes('vector-retrieval failed'))).toBe(true)
  })

  test('memory-logger subagent is created with onFragmentsAppended hook when vector.enabled is true', async () => {
    const memoryPlugin = createMemoryPluginForTests()
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
    const memoryPlugin = createMemoryPluginForTests()
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

async function bootVectorPlugin(injectionBudgetBytes: number, logger = createPluginLogger('memory')) {
  const memoryPlugin = createMemoryPluginForTests({ hybridSearch: hybridSearchMock })
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes, vector: { enabled: true } })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger,
    permissions: noopPermissionService,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

async function bootVectorPluginWith(
  hybridSearch: typeof hybridSearchMock,
  injectionBudgetBytes: number,
  logger = createPluginLogger('memory'),
) {
  const memoryPlugin = createMemoryPluginForTests({ hybridSearch })
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes, vector: { enabled: true } })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger,
    permissions: noopPermissionService,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

function capturingLogger(infos: string[]) {
  return {
    ...createPluginLogger('memory'),
    info: (msg: string) => {
      infos.push(msg)
    },
  }
}

function errorCapturingLogger(errors: string[]) {
  return {
    ...createPluginLogger('memory'),
    error: (msg: string) => {
      errors.push(msg)
    },
  }
}

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function retrievedTopic(key: string, heading: string, excerpt: string) {
  return { source: 'topic' as const, key, heading, excerpt, rrfScore: 1 }
}
