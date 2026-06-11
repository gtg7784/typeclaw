import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncTopicVectorsFromSnapshotDiff } from '../dreaming'
import { renderShard } from '../frontmatter'
import { streamFilePath } from '../paths'
import type { FragmentEvent } from '../stream-events'
import { appendEvents } from '../stream-io'
import type { EmbedFn } from './hybrid'
import { makeAppendHook } from './index-on-write'
import { buildStartupVectorIndex } from './startup'
import { VectorStore } from './store'

const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildStartupVectorIndex', () => {
  it('builds an empty vector index with all topic and stream passages', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'startup-topic', 'Startup Topic', 'This topic is pre-warmed at boot.')
    writeFragment(agentDir, '2026-06-11', 'frag-1', 'Recent Stream', 'This stream fragment is also indexed.')
    const embeddedTexts: string[] = []

    const result = await buildStartupVectorIndex(agentDir, async (texts, type) => {
      expect(type).toBe('passage')
      embeddedTexts.push(...texts)
      return texts.map((_, index) => vector({ [index]: 1 }))
    })

    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(result).toEqual({ built: true, count: 2 })
      expect(embeddedTexts).toEqual([
        'Startup Topic\nThis topic is pre-warmed at boot.',
        'Recent Stream\nThis stream fragment is also indexed.',
      ])
      expect(store.getAll().map((stored) => [stored.id, stored.source, stored.key, stored.dims])).toEqual([
        ['stream:2026-06-11#frag-1', 'stream', '2026-06-11#frag-1', 8],
        ['topic:startup-topic', 'topic', 'startup-topic', 8],
      ])
    } finally {
      store.close()
    }
  })

  it('no-ops when the startup index is already current', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'current-topic', 'Current Topic', 'Already indexed content.')
    let calls = 0
    const embedFn: EmbedFn = async (texts) => {
      calls += 1
      return texts.map(() => vector({ 0: 1 }))
    }

    await buildStartupVectorIndex(agentDir, embedFn)
    const result = await buildStartupVectorIndex(agentDir, embedFn)

    expect(result).toEqual({ built: false, count: 0 })
    expect(calls).toBe(1)
  })

  it('does not re-embed passages already indexed by append and dream writers on restart', async () => {
    const agentDir = createAgentDir()
    mkdirSync(join(agentDir, 'memory', 'streams'), { recursive: true })
    const embeddedTexts: string[] = []
    const embedFn: EmbedFn = async (texts, type) => {
      expect(type).toBe('passage')
      embeddedTexts.push(...texts)
      return texts.map((_, index) => vector({ [index]: 1 }))
    }
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      await appendEvents(
        streamFilePath(agentDir, '2026-06-11'),
        [fragmentEvent('append-frag', 'Append Topic', 'Append body.')],
        makeAppendHook(store, embedFn),
      )
    } finally {
      store.close()
    }
    writeTopic(agentDir, 'dream-topic', 'Dream Topic', 'Dreamed body.')
    const dreamTopicPath = join(agentDir, 'memory', 'topics', 'dream-topic.md')
    await syncTopicVectorsFromSnapshotDiff(
      agentDir,
      new Map(),
      new Map([[dreamTopicPath, readFileSync(dreamTopicPath)]]),
      embedFn,
    )
    embeddedTexts.length = 0

    const result = await buildStartupVectorIndex(agentDir, embedFn)

    expect(result).toEqual({ built: false, count: 0 })
    expect(embeddedTexts).toEqual([])
  })

  it('embeds only missing passages when the startup index is partial', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'current-topic', 'Current Topic', 'Already indexed content.')
    await buildStartupVectorIndex(agentDir, async (texts) => texts.map(() => vector({ 0: 1 })))
    writeTopic(agentDir, 'missing-topic', 'Missing Topic', 'New content needs a vector.')
    const embeddedTexts: string[] = []

    const result = await buildStartupVectorIndex(agentDir, async (texts, type) => {
      expect(type).toBe('passage')
      embeddedTexts.push(...texts)
      return texts.map(() => vector({ 1: 1 }))
    })

    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(result).toEqual({ built: true, count: 1 })
      expect(embeddedTexts).toEqual(['Missing Topic\nNew content needs a vector.'])
      expect(store.getAll().map((stored) => stored.id)).toEqual(['topic:current-topic', 'topic:missing-topic'])
    } finally {
      store.close()
    }
  })
})

function createAgentDir(): string {
  const agentDir = join(tmpdir(), `typeclaw-startup-vector-${randomUUID()}`)
  testDirs.push(agentDir)
  mkdirSync(join(agentDir, 'memory', 'topics'), { recursive: true })
  return agentDir
}

function writeTopic(agentDir: string, slug: string, heading: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'topics', `${slug}.md`),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function writeFragment(agentDir: string, date: string, id: string, topic: string, body: string): void {
  mkdirSync(join(agentDir, 'memory', 'streams'), { recursive: true })
  writeFileSync(
    join(agentDir, 'memory', 'streams', `${date}.jsonl`),
    `${JSON.stringify({ type: 'fragment', id, ts: '2026-06-11T00:00:00.000Z', source: 'test', entry: 'test', topic, body })}\n`,
  )
}

function fragmentEvent(id: string, topic: string, body: string): FragmentEvent {
  return {
    type: 'fragment',
    id,
    ts: '2026-06-11T00:00:00.000Z',
    source: 'test',
    entry: 'test',
    topic,
    body,
  }
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
