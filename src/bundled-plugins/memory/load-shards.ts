import { readdir, readFile, stat } from 'node:fs/promises'

import { parseShard, type ShardFrontmatter } from './frontmatter'
import { topicShardPath, topicsDir } from './paths'

export type TopicShard = {
  path: string
  slug: string
  frontmatter: ShardFrontmatter
  body: string
}

type Logger = { warn(message: string): void }

// Per-shard cache entry. `(mtimeMs, ctimeMs, size)` is the invalidation key.
// For TypeClaw's own writers -- atomic writeFile in dreaming.ts and migration
// staging, plus the migration's directory rename -- mtime alone is sufficient
// because every write produces a fresh mtime. ctimeMs guards against
// metadata-preserving external edits (rsync -t, touch -r, restored backups,
// `git checkout` with timestamps): the kernel always bumps ctime on inode
// content changes and ctime cannot be backdated via utimes, so these cases
// invalidate even when mtime and size are unchanged.
// A `null` shard caches a known-malformed file so a hot session-create loop
// doesn't re-parse the same bad shard on every prompt.
type ShardCacheEntry = {
  mtimeMs: number
  ctimeMs: number
  size: number
  shard: TopicShard | null
}

// Module-level cache keyed by absolute agent directory. One Bun process owns
// one agent dir in production (the container stage), so this map has cardinality
// 1 at runtime. Multi-entry support exists for tests that exercise multiple
// agent dirs in the same process.
const shardCache = new Map<string, Map<string, ShardCacheEntry>>()

export async function loadAllShards(agentDir: string, options: { logger?: Logger } = {}): Promise<TopicShard[]> {
  const slugs = await listShardSlugs(agentDir)
  const cache = getOrCreateCache(agentDir)
  const shards: TopicShard[] = []
  const seen = new Set<string>()

  for (const slug of slugs) {
    seen.add(slug)
    const path = topicShardPath(agentDir, slug)
    const fileStat = await statShard(path)
    if (fileStat === null) {
      cache.delete(slug)
      continue
    }

    const cached = cache.get(slug)
    if (
      cached !== undefined &&
      cached.mtimeMs === fileStat.mtimeMs &&
      cached.ctimeMs === fileStat.ctimeMs &&
      cached.size === fileStat.size
    ) {
      if (cached.shard !== null) shards.push(cached.shard)
      continue
    }

    const shard = await readAndParseShard(path, slug, options)
    cache.set(slug, { mtimeMs: fileStat.mtimeMs, ctimeMs: fileStat.ctimeMs, size: fileStat.size, shard })
    if (shard !== null) shards.push(shard)
  }

  // Drop cache entries whose underlying files have disappeared so a later
  // round-trip after a recreate gets fresh content.
  for (const slug of cache.keys()) {
    if (!seen.has(slug)) cache.delete(slug)
  }

  return shards
}

export async function loadShard(
  agentDir: string,
  slug: string,
  options: { logger?: Logger } = {},
): Promise<TopicShard | null> {
  // The single-slug API contract is "read fresh from disk." No production
  // caller depends on it today (every reader bulk-loads via `loadAllShards`);
  // this is the escape hatch for any future caller that needs a stale-free
  // read without going through the bulk cache. Keep the bypass even if it
  // looks unused -- adding the cache here later is mechanical, removing it
  // is a breaking change.
  const path = topicShardPath(agentDir, slug)
  return readAndParseShard(path, slug, options)
}

export async function listShardSlugs(agentDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(topicsDir(agentDir))
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }

  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort()
}

// Test-only helper. Clears the in-memory shard cache so tests that exercise
// the cache invalidation path can simulate a cold start without spinning up a
// fresh process.
export function __resetShardCacheForTests(): void {
  shardCache.clear()
}

async function readAndParseShard(path: string, slug: string, options: { logger?: Logger }): Promise<TopicShard | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }

  try {
    const { frontmatter, body } = parseShard(text)
    return { path, slug, frontmatter, body }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const logger = options.logger ?? console
    logger.warn(`[memory] skipping malformed topic shard ${slug}: ${message}`)
    return null
  }
}

async function statShard(path: string): Promise<{ mtimeMs: number; ctimeMs: number; size: number } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size }
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

function getOrCreateCache(agentDir: string): Map<string, ShardCacheEntry> {
  let cache = shardCache.get(agentDir)
  if (cache === undefined) {
    cache = new Map()
    shardCache.set(agentDir, cache)
  }
  return cache
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
