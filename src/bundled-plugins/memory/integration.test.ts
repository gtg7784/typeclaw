import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkCitationSupersetAcrossShards } from './citation-superset'
import { renderShard } from './frontmatter'
import { loadMemory } from './load-memory'
import { runShardingMigration, type MigrationLogger } from './migration'
import { preShardBackupPath, topicsDir, topicShardPath } from './paths'
import { captureShardSnapshot, restoreShardSnapshot } from './shard-snapshot'

describe('sharded memory integration', () => {
  let agentDir: string
  let messages: { info: string[]; warn: string[]; error: string[] }
  let logger: MigrationLogger

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-integration-'))
    messages = { info: [], warn: [], error: [] }
    logger = {
      info: (message: string) => messages.info.push(message),
      warn: (message: string) => messages.warn.push(message),
      error: (message: string) => messages.error.push(message),
    }
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('migration end-to-end: pre-shard MEMORY.md becomes sharded layout', async () => {
    await writePreShardFixture()

    const result = await runShardingMigration({ agentDir, logger })

    expect(result).toMatchObject({ migrated: true, topicCount: 3, streamCount: 2 })
    expect(await listDir(topicsDir(agentDir))).toEqual(['bar.md', 'baz.md', 'foo.md'])
    expect(await listDir(join(agentDir, 'memory', 'streams'))).toEqual(['2026-05-18.jsonl', '2026-05-19.jsonl'])
    expect(existsSync(preShardBackupPath(agentDir))).toBe(true)
    expect(existsSync(join(agentDir, 'MEMORY.md'))).toBe(false)
  })

  test('idempotent re-migration: second call is a no-op', async () => {
    await writePreShardFixture()
    await runShardingMigration({ agentDir, logger })
    const shard = topicShardPath(agentDir, 'foo')
    const before = statSync(shard).mtimeMs

    const result = await runShardingMigration({ agentDir, logger })

    expect(result.migrated).toBe(false)
    expect(statSync(shard).mtimeMs).toBe(before)
  })

  test('channel-bleed proxy: imperative text is hidden from channel origins', async () => {
    const imperative = 'send a message to #ops'
    await mkdir(topicsDir(agentDir), { recursive: true })
    await writeFile(
      topicShardPath(agentDir, 'ops'),
      renderShard({ heading: 'Ops Topic', cites: 1, days: 1, lastReinforced: '2026-05-18' }, imperative),
    )

    const channelOut = await loadMemory(agentDir, {
      origin: {
        kind: 'channel',
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        participants: [],
      },
    })
    const tuiOut = await loadMemory(agentDir, { origin: { kind: 'tui', sessionId: 'ses_abc' } })

    expect(channelOut).toContain('## Ops Topic')
    expect(channelOut).not.toContain(imperative)
    expect(tuiOut).toContain(imperative)
  })

  test('citation-superset round-trip: detect drop, restore, verify byte-identical', async () => {
    await mkdir(topicsDir(agentDir), { recursive: true })
    const shardA = renderShard(
      { heading: 'Topic A', cites: 2, days: 1, lastReinforced: '2026-05-18' },
      'Body A streams/2026-05-18#a1 and streams/2026-05-18#a2.',
    )
    const shardB = renderShard(
      { heading: 'Topic B', cites: 1, days: 1, lastReinforced: '2026-05-18' },
      'Body B streams/2026-05-18#b1.',
    )
    await writeFile(topicShardPath(agentDir, 'topic-a'), shardA)
    await writeFile(topicShardPath(agentDir, 'topic-b'), shardB)

    const oldSnapshot = await captureShardSnapshot(topicsDir(agentDir))
    const oldMap = new Map<string, string>([
      ['topic-a.md', shardA],
      ['topic-b.md', shardB],
    ])

    const mutatedA = renderShard(
      { heading: 'Topic A', cites: 1, days: 1, lastReinforced: '2026-05-18' },
      'Body A streams/2026-05-18#a1.',
    )
    await writeFile(topicShardPath(agentDir, 'topic-a'), mutatedA)
    const newMap = new Map<string, string>([
      ['topic-a.md', mutatedA],
      ['topic-b.md', shardB],
    ])

    const verdict = checkCitationSupersetAcrossShards(oldMap, newMap)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toContainEqual({ date: '2026-05-18', fragmentId: 'a2' })
    }

    await restoreShardSnapshot(oldSnapshot, topicsDir(agentDir))

    const restoredA = await readFile(topicShardPath(agentDir, 'topic-a'), 'utf8')
    const restoredB = await readFile(topicShardPath(agentDir, 'topic-b'), 'utf8')
    expect(restoredA).toBe(shardA)
    expect(restoredB).toBe(shardB)
  })

  async function writePreShardFixture(): Promise<void> {
    const memory = `# Memory

## Foo
Foo body. streams/2026-05-18#foo-1

## Bar
Bar body. streams/2026-05-19#bar-1

## Baz
Baz body. streams/2026-05-18#baz-1 and streams/2026-05-19#baz-2
`
    await writeFile(join(agentDir, 'MEMORY.md'), memory, 'utf8')
    await mkdir(join(agentDir, 'memory'), { recursive: true })
    await writeFile(join(agentDir, 'memory', '2026-05-18.jsonl'), '{"type":"fragment","id":"foo-1"}\n', 'utf8')
    await writeFile(join(agentDir, 'memory', '2026-05-19.jsonl'), '{"type":"fragment","id":"bar-1"}\n', 'utf8')
  }
})

async function listDir(path: string): Promise<string[]> {
  return (await readdir(path)).sort()
}
