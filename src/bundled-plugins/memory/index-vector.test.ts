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
  test('populates retrieval context synchronously for the current turn', async () => {
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
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

    const hookCtx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'second prompt', retrievalContext },
      hookCtx,
    )

    expect(hybridSearchMock).toHaveBeenCalledWith('second prompt', expect.anything(), agentDir, 10)
    expect(retrievalContext.results).toBe(
      '## Retrieved memory\n\n### Second Topic\n\nSecond topic excerpt from vector retrieval.',
    )
  })
})

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}
