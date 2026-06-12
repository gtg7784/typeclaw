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

  test('many shards stay slug-sorted and body-aligned regardless of parallel read completion order', async () => {
    const agentDir = await makeAgentDir()
    // Shuffled write order: proves the result order comes from the sorted slug
    // listing, not from the order reads happen to settle in under concurrency.
    const slugs = ['k', 'a', 'z', 'm', 'c', 't', 'b', 'q', 'e', 'r', 'd', 'n', 'g', 'p', 's']
    for (const slug of slugs) await writeShard(agentDir, slug, slug.toUpperCase(), `${slug}-body\n`)

    const shards = await loadAllShards(agentDir)

    const sorted = [...slugs].sort()
    expect(shards.map((shard) => shard.slug)).toEqual(sorted)
    expect(shards.map((shard) => shard.body)).toEqual(sorted.map((slug) => `${slug}-body\n`))
  })

  test('a malformed shard anywhere in the set never shifts the ordering of valid shards', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'apple', 'Apple', 'apple\n')
    // Malformed entry sorts into the MIDDLE of the slug listing; the parallel
    // fan-out must drop it without displacing the neighbours that read fine.
    await writeFile(topicShardPath(agentDir, 'mango'), '---\nheading: Mango\n', 'utf8')
    await writeShard(agentDir, 'pear', 'Pear', 'pear\n')
    await writeShard(agentDir, 'zebra', 'Zebra', 'zebra\n')
    const warnings: string[] = []

    const shards = await loadAllShards(agentDir, { logger: { warn: (m) => warnings.push(m) } })

    expect(shards.map((shard) => shard.slug)).toEqual(['apple', 'pear', 'zebra'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('mango')
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
  test('serves cached shard objects by reference when disk is unchanged (proves the readFile fast path)', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'v1-body\n')

    const first = await loadAllShards(agentDir)
    expect(first[0]?.body).toBe('v1-body\n')

    // Cache hit returns the SAME object instance (no readFile, no parseShard,
    // no allocation). Reference equality is the cleanest behavioral proof
    // that the readFile fast path was taken -- a fresh read would allocate
    // a new `{ frontmatter, body }` object on every call.
    const second = await loadAllShards(agentDir)
    expect(second[0]).toBe(first[0])
  })

  test('invalidates the cached shard when its mtime changes (same size)', async () => {
    const agentDir = await makeAgentDir()
    const path = topicShardPath(agentDir, 'alpha')
    await writeShard(agentDir, 'alpha', 'Alpha', 'same-len-v1\n')

    // Pin a known initial timestamp so we can step it forward deterministically.
    const baseTime = new Date(1779000000000)
    await utimes(path, baseTime, baseTime)

    const first = await loadAllShards(agentDir)
    expect(first[0]?.body).toBe('same-len-v1\n')

    // Rewrite with SAME length and then bump mtime via utimes. This isolates
    // mtime as the invalidation signal: size is identical, only mtime moves.
    // (ctime moves too on the rewrite, but the test pins the contract that
    // mtime alone is sufficient to invalidate.)
    await writeFile(path, shardText('Alpha', 'same-len-v2\n'), 'utf8')
    const laterTime = new Date(1780000000000)
    await utimes(path, laterTime, laterTime)

    const refreshed = await loadAllShards(agentDir)
    expect(refreshed[0]?.body).toBe('same-len-v2\n')
  })

  test('invalidates the cached shard when ctime changes even if mtime is preserved (rsync -t / touch -r case)', async () => {
    const agentDir = await makeAgentDir()
    const path = topicShardPath(agentDir, 'alpha')
    await writeShard(agentDir, 'alpha', 'Alpha', 'v1-body\n')
    const pinned = new Date(1779000000000)
    await utimes(path, pinned, pinned)

    const first = await loadAllShards(agentDir)
    expect(first[0]?.body).toBe('v1-body\n')

    // Simulate a metadata-preserving external edit: write new bytes, then
    // restore mtime to the original value. ctime cannot be backdated via
    // utimes -- the kernel always bumps it on inode content change -- so
    // ctime is what catches this case. Without ctime in the cache key the
    // next call would return stale v1 bytes (the bug Oracle flagged).
    await writeFile(path, shardText('Alpha', 'v2-body\n'), 'utf8')
    await utimes(path, pinned, pinned)

    const refreshed = await loadAllShards(agentDir)
    expect(refreshed[0]?.body).toBe('v2-body\n')
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

  test('loadShard never returns the cached object (always allocates a fresh shard)', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'alpha', 'Alpha', 'v1\n')

    // Prime the bulk cache: loadAllShards stores a TopicShard instance.
    const bulk = await loadAllShards(agentDir)
    const bulkShard = bulk[0]
    expect(bulkShard?.body).toBe('v1\n')

    // loadShard MUST allocate a fresh shard object even when the on-disk
    // file hasn't moved (and the bulk cache holds a perfectly valid entry).
    // Reference inequality is the contract that pins "single-slug always
    // reads fresh." If loadShard ever starts sharing the bulk cache, this
    // assertion fails and the breaking change is surfaced explicitly.
    const direct = await loadShard(agentDir, 'alpha')
    expect(direct?.body).toBe('v1\n')
    expect(direct).not.toBe(bulkShard)
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
