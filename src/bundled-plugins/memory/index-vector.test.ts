import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import { renderShard } from './frontmatter'
import { topicShardPath, topicsDir } from './paths'
import { buildStartupVectorIndex } from './vector/startup'

mock.module('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => async (texts: string[]) => {
    const data = new Float32Array(texts.length * 768)
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? ''
      if (text.includes('slow first prompt')) await Bun.sleep(40)
      data[i * 768] = text.includes('second prompt') || text.includes('Second Topic') ? 1 : 0
      data[i * 768 + 1] = text.includes('slow first prompt') || text.includes('First Topic') ? 1 : 0
    }
    return { data }
  },
}))

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-vector-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('vector session.turn.start hook', () => {
  test('coalesces overlapping vector retrievals so the in-flight cache write is not invalidated', async () => {
    const memoryPlugin = (await import('./index')).default
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
    await buildStartupVectorIndex(agentDir)
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
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'slow first prompt' },
      hookCtx,
    )
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'second prompt' },
      hookCtx,
    )

    await waitFor(async () => {
      const content = await readCache().catch(() => '')
      return content.includes('First Topic')
    })
    await Bun.sleep(80)

    const content = await readCache()
    expect(content).toStartWith('## First Topic')
  })
})

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

async function readCache(): Promise<string> {
  return readFile(join(agentDir, 'memory', '.retrieval-cache', 'ses_vector.md'), 'utf8')
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  while (performance.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('timed out waiting for predicate')
}
