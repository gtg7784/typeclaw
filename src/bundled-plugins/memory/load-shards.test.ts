import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadAllShards, loadShard, listShardSlugs } from './load-shards'
import { topicShardPath, topicsDir } from './paths'

const tmpRoots: string[] = []

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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
