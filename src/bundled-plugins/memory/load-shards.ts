import { readdir, readFile } from 'node:fs/promises'

import { parseShard, type ShardFrontmatter } from './frontmatter'
import { topicShardPath, topicsDir } from './paths'

export type TopicShard = {
  path: string
  slug: string
  frontmatter: ShardFrontmatter
  body: string
}

type Logger = { warn(message: string): void }

export async function loadAllShards(agentDir: string, options: { logger?: Logger } = {}): Promise<TopicShard[]> {
  const slugs = await listShardSlugs(agentDir)
  const shards: TopicShard[] = []
  for (const slug of slugs) {
    const shard = await loadShard(agentDir, slug, options)
    if (shard !== null) shards.push(shard)
  }
  return shards
}

export async function loadShard(
  agentDir: string,
  slug: string,
  options: { logger?: Logger } = {},
): Promise<TopicShard | null> {
  const path = topicShardPath(agentDir, slug)

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

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
