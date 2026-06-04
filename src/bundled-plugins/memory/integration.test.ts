import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkCitationSupersetAcrossShards } from './citation-superset'
import { renderShard } from './frontmatter'
import { loadMemory } from './load-memory'
import { topicsDir, topicShardPath } from './paths'
import { captureShardSnapshot, restoreShardSnapshot } from './shard-snapshot'

describe('sharded memory integration', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-integration-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
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
})
