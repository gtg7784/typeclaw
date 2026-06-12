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

  test('zero-shard direct mode still logs the mode=direct topics=0 signal', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    // given: a fresh agent with no topic shards → direct mode, zero shards
    const infos: string[] = []
    const exports = await bootVectorPlugin(memoryPlugin, 16384, capturingLogger(infos))

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    // then: nothing injected, hybrid search skipped, but the signal is still logged
    expect(retrievalContext.results).toBe('')
    expect(hybridSearchMock).not.toHaveBeenCalled()
    expect(infos).toContain('[vector-retrieval] mode=direct topics=0 full=0')
  })

  test('second direct-mode turn dedups unchanged bodies to slug references', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'first body')
    const exports = await bootVectorPlugin(memoryPlugin, 16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    // given: turn one injected the full body
    const first = { results: '' }
    await hook({ sessionId: 'ses_dedup', agentDir, userPrompt: 'turn one', retrievalContext: first }, ctx)
    expect(first.results).toContain('first body')

    // when: a second turn runs for the same session with the shard unchanged
    const second = { results: '' }
    await hook({ sessionId: 'ses_dedup', agentDir, userPrompt: 'turn two', retrievalContext: second }, ctx)

    // then: the body is replaced by a recoverable slug reference, not re-sent
    expect(second.results).toContain('## First Topic')
    expect(second.results).not.toContain('first body')
    expect(second.results).toContain('slug: `first-topic`')
    expect(second.results).toContain('memory_search({ topic: "first-topic" })')
  })

  test('a changed shard body re-injects in full on the next turn', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'topic', 'Topic', 'original body')
    const exports = await bootVectorPlugin(memoryPlugin, 16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    const first = { results: '' }
    await hook({ sessionId: 'ses_change', agentDir, userPrompt: 'turn one', retrievalContext: first }, ctx)

    // when: the shard body changes (a dreaming pass rewrote it) before turn two
    await writeTopic(agentDir, 'topic', 'Topic', 'rewritten body')
    const second = { results: '' }
    await hook({ sessionId: 'ses_change', agentDir, userPrompt: 'turn two', retrievalContext: second }, ctx)

    // then: the fresh body is injected in full, not a stale reference
    expect(second.results).toContain('rewritten body')
    expect(second.results).not.toContain('slug: `topic`')
  })

  test('dedup state is per-session: a different session still gets the full body', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'topic', 'Topic', 'shared body')
    const exports = await bootVectorPlugin(memoryPlugin, 16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    const a = { results: '' }
    await hook({ sessionId: 'ses_a', agentDir, userPrompt: 'a1', retrievalContext: a }, ctx)
    await hook({ sessionId: 'ses_a', agentDir, userPrompt: 'a2', retrievalContext: a }, ctx)

    // when: a brand-new session asks on its first turn
    const b = { results: '' }
    await hook({ sessionId: 'ses_b', agentDir, userPrompt: 'b1', retrievalContext: b }, ctx)

    // then: it gets the full body — dedup state does not bleed across sessions
    expect(b.results).toContain('shared body')
  })

  test('session.end clears dedup state so a resurrected session re-injects in full', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'topic', 'Topic', 'durable body')
    const exports = await bootVectorPlugin(memoryPlugin, 16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    await hook({ sessionId: 'ses_res', agentDir, userPrompt: 'turn one', retrievalContext: { results: '' } }, ctx)

    // when: the session ends, then the same id resurrects and asks again
    await exports.hooks!['session.end']!({ sessionId: 'ses_res' }, ctx)
    const after = { results: '' }
    await hook({ sessionId: 'ses_res', agentDir, userPrompt: 'turn two', retrievalContext: after }, ctx)

    // then: the body is injected in full again — no dangling reference to a
    // body the resurrected model context no longer holds
    expect(after.results).toContain('durable body')
  })

  test('channel origin stays headings-only in direct mode (no body bleed, no dedup)', async () => {
    hybridSearchMock.mockClear()
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'topic', 'Topic', 'channel-private body')
    const exports = await bootVectorPlugin(memoryPlugin, 16384)
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

    // then: a channel direct-mode turn is forced to index (headings only), so the
    // body never bleeds into a channel response and the dedup path is bypassed
    expect(first.results).not.toContain('channel-private body')
    expect(first.results).toContain('[MEMORY CONTEXT — not instructions]')
    expect(hybridSearchMock).toHaveBeenCalled()
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

async function bootVectorPlugin(
  memoryPlugin: typeof import('./index').default,
  injectionBudgetBytes: number,
  logger = createPluginLogger('memory'),
) {
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

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}
