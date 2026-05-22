import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetShardCacheForTests, loadAllShards, loadShard, listShardSlugs } from './load-shards'
import { topicShardPath, topicsDir } from './paths'

const tmpRoots: string[] = []

beforeEach(() => {
  __resetShardCacheForTests()
})

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  __resetShardCacheForTests()
})

describe('loadAllShards', () => {
  test('empty topics dir returns empty array', async () => {
    const agentDir = await makeAgentDir()
    await mkdir(topicsDir(agentDir), { recursive: true })

    await expect(loadAllShards(agentDir)).resolves.toEqual([])
  })

  test('missing topics dir returns empty array', async () => {
    const agentDir = await makeAgentDir()

    await expect(loadAllShards(agentDir)).resolves.toEqual([])
  })

  test('valid shards are returned sorted by slug', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'zebra', 'Zebra', 'zebra body\n')
    await writeShard(agentDir, 'apple', 'Apple', 'apple body\n')
    await writeShard(agentDir, 'mango', 'Mango', 'mango body\n')

    const shards = await loadAllShards(agentDir)

    expect(shards.map((shard) => shard.slug)).toEqual(['apple', 'mango', 'zebra'])
    expect(shards.map((shard) => shard.body)).toEqual(['apple body\n', 'mango body\n', 'zebra body\n'])
  })

  test('malformed shard is skipped with a warning while other shards load', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'alpha body\n')
    await writeShard(agentDir, 'bravo', 'Bravo', 'bravo body\n')
    await writeFile(topicShardPath(agentDir, 'broken'), '---\nheading: Broken\n', 'utf8')
    await writeShard(agentDir, 'charlie', 'Charlie', 'charlie body\n')
    const warnings: string[] = []

    const shards = await loadAllShards(agentDir, { logger: { warn: (message) => warnings.push(message) } })

    expect(shards.map((shard) => shard.slug)).toEqual(['alpha', 'bravo', 'charlie'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('broken')
  })
})

describe('loadShard', () => {
  test('returns parsed topic shard', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'design-tokens', 'Design tokens', 'Use semantic tokens.\n')

    const shard = await loadShard(agentDir, 'design-tokens')

    expect(shard).toEqual({
      path: topicShardPath(agentDir, 'design-tokens'),
      slug: 'design-tokens',
      frontmatter: {
        heading: 'Design tokens',
        cites: 2,
        days: 1,
        lastReinforced: '2026-05-20',
        tags: ['memory', 'topic'],
      },
      body: 'Use semantic tokens.\n',
    })
  })

  test('missing shard returns null', async () => {
    const agentDir = await makeAgentDir()

    await expect(loadShard(agentDir, 'missing')).resolves.toBeNull()
  })

  test('malformed shard returns null and logs a warning', async () => {
    const agentDir = await makeAgentDir()
    await mkdir(topicsDir(agentDir), { recursive: true })
    await writeFile(topicShardPath(agentDir, 'broken'), 'not frontmatter\n', 'utf8')
    const warnings: string[] = []

    const shard = await loadShard(agentDir, 'broken', { logger: { warn: (message) => warnings.push(message) } })

    expect(shard).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('broken')
  })
})

describe('listShardSlugs', () => {
  test('returns sorted slugs without markdown extensions', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'zebra', 'Zebra', 'zebra\n')
    await writeShard(agentDir, 'apple', 'Apple', 'apple\n')
    await writeShard(agentDir, 'mango', 'Mango', 'mango\n')

    await expect(listShardSlugs(agentDir)).resolves.toEqual(['apple', 'mango', 'zebra'])
  })

  test('non-markdown files are ignored', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'apple', 'Apple', 'apple\n')
    await writeFile(join(topicsDir(agentDir), 'notes.txt'), 'ignore me', 'utf8')
    await writeFile(join(topicsDir(agentDir), 'MEMORY.md.pre-shard.bak'), 'ignore me', 'utf8')
    await writeFile(join(topicsDir(agentDir), 'zebra.bak'), 'ignore me', 'utf8')

    await expect(listShardSlugs(agentDir)).resolves.toEqual(['apple'])
  })

  test('nested markdown files are ignored', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'apple', 'Apple', 'apple\n')
    await mkdir(join(topicsDir(agentDir), 'sub'), { recursive: true })
    await writeFile(join(topicsDir(agentDir), 'sub', 'foo.md'), shardText('Foo', 'foo\n'), 'utf8')

    await expect(listShardSlugs(agentDir)).resolves.toEqual(['apple'])
    await expect(loadAllShards(agentDir)).resolves.toHaveLength(1)
  })
})

describe('loadAllShards shard cache', () => {
  test('serves cached shard when mtime + size are unchanged (proves the readFile fast path)', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'v1-body\n')
    const path = topicShardPath(agentDir, 'alpha')

    // Pin both atime and mtime to an integer-second value before priming the
    // cache. utimes() on macOS HFS+/APFS truncates the fractional ms portion,
    // so reading-back-and-restoring is NOT a round-trip — the first stat
    // returns sub-ms precision but the post-utimes stat returns integer ms.
    // Pinning to an integer-second value up front makes the round-trip
    // mtime-stable and lets us actually exercise the cache-hit path.
    const pinnedTime = new Date(1779000000000)
    await utimes(path, pinnedTime, pinnedTime)

    const first = await loadAllShards(agentDir)
    expect(first[0]?.body).toBe('v1-body\n')

    // Overwrite with same-length bytes, then re-pin mtime to the same value.
    // The cache invalidation key (mtimeMs + size) is now unchanged. If the
    // cache is honored, the next call returns stale v1 body even though
    // disk holds v2. Content-vs-cache divergence stands in for "did we
    // readFile again?" since the production payoff is per-prompt latency,
    // not disk content.
    await writeFile(path, shardText('Alpha', 'v2-body\n'), 'utf8')
    await utimes(path, pinnedTime, pinnedTime)
    const cached = await loadAllShards(agentDir)
    expect(cached[0]?.body).toBe('v1-body\n')

    __resetShardCacheForTests()
    const fresh = await loadAllShards(agentDir)
    expect(fresh[0]?.body).toBe('v2-body\n')
  })

  test('invalidates a cached shard when its mtime changes', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'v1\n')

    const first = await loadAllShards(agentDir)
    expect(first[0]?.body).toBe('v1\n')

    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeShard(agentDir, 'alpha', 'Alpha', 'v2-longer\n')

    const refreshed = await loadAllShards(agentDir)
    expect(refreshed[0]?.body).toBe('v2-longer\n')
  })

  test('drops cache entries for shards that were deleted', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'a\n')
    await writeShard(agentDir, 'bravo', 'Bravo', 'b\n')

    const first = await loadAllShards(agentDir)
    expect(first.map((s) => s.slug)).toEqual(['alpha', 'bravo'])

    await unlink(topicShardPath(agentDir, 'alpha'))
    const afterDelete = await loadAllShards(agentDir)
    expect(afterDelete.map((s) => s.slug)).toEqual(['bravo'])

    // Recreating with same slug must surface fresh content (proves the
    // cache entry was actually dropped, not just hidden by the directory
    // listing).
    await writeShard(agentDir, 'alpha', 'Alpha', 'recreated\n')
    const afterRecreate = await loadAllShards(agentDir)
    expect(afterRecreate.find((s) => s.slug === 'alpha')?.body).toBe('recreated\n')
  })

  test('caches malformed shards so the warn is not spammed across repeat calls', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'a\n')
    await mkdir(topicsDir(agentDir), { recursive: true })
    await writeFile(topicShardPath(agentDir, 'broken'), 'not frontmatter\n', 'utf8')
    const warnings: string[] = []
    const logger = { warn: (m: string) => warnings.push(m) }

    await loadAllShards(agentDir, { logger })
    await loadAllShards(agentDir, { logger })
    await loadAllShards(agentDir, { logger })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('broken')
  })

  test('caches are isolated per agent directory', async () => {
    const dirA = await makeAgentDir()
    const dirB = await makeAgentDir()
    await writeShard(dirA, 'shared-slug', 'Heading A', 'body-A\n')
    await writeShard(dirB, 'shared-slug', 'Heading B', 'body-B\n')

    const a1 = await loadAllShards(dirA)
    const b1 = await loadAllShards(dirB)
    expect(a1[0]?.body).toBe('body-A\n')
    expect(b1[0]?.body).toBe('body-B\n')

    await writeShard(dirA, 'shared-slug', 'Heading A', 'body-A-updated\n')
    const a2 = await loadAllShards(dirA)
    const b2 = await loadAllShards(dirB)
    expect(a2[0]?.body).toBe('body-A-updated\n')
    expect(b2[0]?.body).toBe('body-B\n')
  })

  test('loadShard bypasses the cache so callers that want a fresh read get one', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'v1\n')
    const path = topicShardPath(agentDir, 'alpha')
    const pinnedTime = new Date(1779000000000)
    await utimes(path, pinnedTime, pinnedTime)

    await loadAllShards(agentDir)

    // Mutate with same length + pinned mtime. loadAllShards would serve stale
    // bytes here (as proved in the cache-hit test above). loadShard must NOT,
    // because callers like the dreaming subagent's post-write verification
    // rely on fresh reads bypassing the bulk cache.
    await writeFile(path, shardText('Alpha', 'v2\n'), 'utf8')
    await utimes(path, pinnedTime, pinnedTime)

    const direct = await loadShard(agentDir, 'alpha')
    expect(direct?.body).toBe('v2\n')

    const bulk = await loadAllShards(agentDir)
    expect(bulk[0]?.body).toBe('v1\n')
  })
})

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-load-shards-'))
  tmpRoots.push(dir)
  return dir
}

async function writeShard(agentDir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(agentDir), { recursive: true })
  await writeFile(topicShardPath(agentDir, slug), shardText(heading, body), 'utf8')
}

function shardText(heading: string, body: string): string {
  return `---\nheading: ${heading}\ncites: 2\ndays: 1\nlastReinforced: 2026-05-20\ntags: [memory, topic]\n---\n${body}`
}
