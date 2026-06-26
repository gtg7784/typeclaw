import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPluginLogger } from '@/plugin/context'

import { renderShard } from './frontmatter'
import { referenceFilePath, referencesDir, topicShardPath, topicsDir } from './paths'
import { parseReference } from './references/frontmatter'
import { createMemorySearchCommand, renderResults, vectorDbPath } from './search-command'
import { DIMS, EMBEDDING_MODEL_ID } from './vector/embedder'
import type { HybridSearchResult } from './vector/hybrid'
import type { EmbedFn } from './vector/hybrid'
import { VectorStore, type VectorRow } from './vector/store'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-search-command-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('renderResults', () => {
  test('reports an empty result set against the query', () => {
    expect(renderResults('orbit', [])).toBe('No memory matched "orbit".')
  })

  test('renders ranked hits with source, key, score, and indented excerpt', () => {
    const results: HybridSearchResult[] = [
      {
        source: 'topic',
        key: 'orbital-mechanics',
        heading: 'Orbital Mechanics',
        excerpt: 'Satellites orbit.',
        rrfScore: 0.0164,
      },
    ]
    const text = renderResults('orbit', results)
    expect(text).toContain('1 result(s) for "orbit":')
    expect(text).toContain('1. [topic] Orbital Mechanics')
    expect(text).toContain('key: orbital-mechanics  score: 0.0164')
    expect(text).toContain('| Satellites orbit.')
  })

  test('renders provenance when a stream hit carries who/where/when', () => {
    const results: HybridSearchResult[] = [
      {
        source: 'stream',
        key: '2026-06-24#abc',
        heading: 'incident note',
        excerpt: 'db down',
        rrfScore: 0.01,
        who: 'Jisoo',
        when: '2026-06-24T10:00:00Z',
        where: { adapter: 'slack', workspace: 'w', chat: 'C1', chatName: '#incidents', thread: 't' },
      },
    ]
    expect(renderResults('db', results)).toContain('Jisoo in #incidents at 2026-06-24T10:00:00Z')
  })
})

describe('memory-search container command', () => {
  test('exits non-zero when the vector index has not been built', async () => {
    const { code, stderr } = await runCommand({ query: 'orbit', topK: 10, json: false })
    expect(code).toBe(1)
    expect(stderr).toContain('vector index not built yet')
  })

  test('runs hybridSearch and prints ranked text results', async () => {
    await writeTopic('orbital-mechanics', 'Orbital Mechanics', 'Satellites remain in orbit.')
    seedVector('topic:orbital-mechanics', 'topic', 'orbital-mechanics')

    const { code, stdout } = await runCommand({ query: QUERY, topK: 10, json: false })
    expect(code).toBe(0)
    expect(stdout).toContain('[topic] Orbital Mechanics')
    expect(stdout).toContain('orbital-mechanics')
  })

  test('emits raw JSON when --json is set', async () => {
    await writeTopic('orbital-mechanics', 'Orbital Mechanics', 'Satellites remain in orbit.')
    seedVector('topic:orbital-mechanics', 'topic', 'orbital-mechanics')

    const { code, stdout } = await runCommand({ query: QUERY, topK: 10, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.trim()) as HybridSearchResult[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.source).toBe('topic')
    expect(parsed[0]?.key).toBe('orbital-mechanics')
  })

  test('advances a surfaced reference accessCount/lastAccessed so it survives time-decay', async () => {
    await writeReference('runbook', 'DB Runbook', 'Restart the primary, then failover.')
    seedVector('reference:runbook#0', 'reference', 'runbook')

    const before = await readReferenceFrontmatter('runbook')
    const { code, stdout } = await runCommand({ query: QUERY, topK: 10, json: true })
    expect(code).toBe(0)
    expect((JSON.parse(stdout.trim()) as HybridSearchResult[])[0]?.source).toBe('reference')

    const after = await readReferenceFrontmatter('runbook')
    expect(after.accessCount).toBe(before.accessCount + 1)
    expect(after.lastAccessed).not.toBe(before.lastAccessed)
  })
})

// Absent from every slug/heading/body, so the keyword lane is inert and only the
// vector lane can produce the hit — proving real vector search ran, not substring.
const QUERY = 'zzqxvtrprobe'

async function runCommand(args: { query: string; topK: number; json: boolean }): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const command = createMemorySearchCommand(queryAligned())
  const out = collectStream()
  const err = collectStream()
  const code = await command.run(
    {
      name: 'memory',
      version: undefined,
      agentDir,
      logger: createPluginLogger('memory'),
      permissions: {} as never,
      origin: { kind: 'tui', sessionId: 'test' },
      signal: new AbortController().signal,
      stdin: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stdout: out.writable,
      stderr: err.writable,
      prompt: async () => '',
      subagent: async () => {},
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    args,
  )
  return { code, stdout: out.getOutput(), stderr: err.getOutput() }
}

async function writeTopic(slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(agentDir), { recursive: true })
  await writeFile(
    topicShardPath(agentDir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function seedVector(id: string, source: VectorRow['source'], key: string): void {
  const store = VectorStore.open(vectorDbPath(agentDir))
  try {
    store.upsert({
      id,
      source,
      key,
      model: EMBEDDING_MODEL_ID,
      dims: DIMS,
      embedding: alignedVector(),
      contentHash: `hash:${id}`,
    } satisfies Omit<VectorRow, 'updatedAt'>)
  } finally {
    store.close()
  }
}

async function writeReference(slug: string, title: string, body: string): Promise<void> {
  await mkdir(referencesDir(agentDir), { recursive: true })
  await writeFile(
    referenceFilePath(agentDir, slug),
    `---\ntitle: ${title}\norigin: episode\ncreated: 2026-06-12T14:03:00+09:00\nlastAccessed: 2026-06-13T09:10:00+09:00\naccessCount: 3\npinned: false\ndemoted: false\ntags: []\n---\n${body}`,
    'utf8',
  )
}

async function readReferenceFrontmatter(slug: string) {
  return parseReference(await Bun.file(referenceFilePath(agentDir, slug)).text()).frontmatter
}

function queryAligned(): EmbedFn {
  return async () => [alignedVector()]
}

function alignedVector(): Float32Array {
  const result = new Float32Array(DIMS)
  result[0] = 1
  return result
}

function collectStream(): { writable: WritableStream<Uint8Array>; getOutput: () => string } {
  const chunks: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk)
    },
  })
  return { writable, getOutput: () => chunks.map((c) => new TextDecoder().decode(c)).join('') }
}
