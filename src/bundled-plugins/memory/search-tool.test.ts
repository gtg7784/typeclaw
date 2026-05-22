import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'

import { renderShard, type ShardFrontmatter } from './frontmatter'
import { topicShardPath, topicsDir } from './paths'
import { memorySearchTool } from './search-tool'

const tmpRoots: string[] = []

type SearchResult =
  | {
      matches: Array<{
        shardPath: string
        slug: string
        heading: string
        excerpt: string
        fullBody?: string
      }>
      truncatedAt?: number
    }
  | { error: string }

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('memorySearchTool', () => {
  test('substring match returns a body-line excerpt for one shard', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(
      agentDir,
      'daily-notes',
      'Daily notes',
      'First line\nTypeClaw stores topic shards here.\nLast line\n',
    )
    await writeShard(agentDir, 'other', 'Other', 'No relevant word.\n')

    const result = await call(agentDir, { query: 'stores' })

    expect(result).toEqual({
      matches: [
        {
          shardPath: topicShardPath(agentDir, 'daily-notes'),
          slug: 'daily-notes',
          heading: 'Daily notes',
          excerpt: 'First line\nTypeClaw stores topic shards here.\nLast line',
        },
      ],
    })
  })

  test('no matches returns an empty matches array', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'daily-notes', 'Daily notes', 'A body about memory.\n')

    await expect(call(agentDir, { query: 'absent' })).resolves.toEqual({ matches: [] })
  })

  test('regex match finds citation strings in body text', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'citations', 'Citations', 'See streams/2026-05-20#abc123 for source.\n')

    const result = await call(agentDir, { query: String.raw`streams\/\d{4}`, asRegex: true })

    expect('matches' in result ? result.matches.map((match) => match.slug) : []).toEqual(['citations'])
  })

  test('invalid regex returns a structured error instead of throwing', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'anything', 'Anything', 'body\n')

    const result = await call(agentDir, { query: '[unterminated', asRegex: true })

    expect(result).toHaveProperty('error')
    expect('error' in result ? result.error : '').toStartWith('invalid regex:')
  })

  test('heading-only match still returns the shard with heading excerpt', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'api-style', 'Operator Preferences', 'Body deliberately omits the target phrase.\n')

    const result = await call(agentDir, { query: 'operator preferences' })

    expect(result).toEqual({
      matches: [
        {
          shardPath: topicShardPath(agentDir, 'api-style'),
          slug: 'api-style',
          heading: 'Operator Preferences',
          excerpt: 'Operator Preferences',
        },
      ],
    })
  })

  test('slug-only match returns the shard with slug excerpt', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'release-process', 'Deploy notes', 'Body has unrelated words.\n')

    const result = await call(agentDir, { query: 'release-process' })
    expect(result).toEqual({
      matches: [
        {
          shardPath: topicShardPath(agentDir, 'release-process'),
          slug: 'release-process',
          heading: 'Deploy notes',
          excerpt: 'release-process',
        },
      ],
    })
  })

  test('tag match returns the shard with matching tag excerpt', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'editor', 'Editor habits', 'Body has no tag words.\n', { tags: ['foo', 'bar'] })

    const result = await call(agentDir, { query: 'bar' })
    expect(result).toEqual({
      matches: [
        {
          shardPath: topicShardPath(agentDir, 'editor'),
          slug: 'editor',
          heading: 'Editor habits',
          excerpt: 'bar',
        },
      ],
    })
  })

  test('maxResults caps matches across all shards and reports truncation', async () => {
    const agentDir = await makeAgentDir()
    for (let i = 0; i < 15; i++) {
      await writeShard(agentDir, `topic-${i.toString().padStart(2, '0')}`, `Topic ${i}`, 'needle appears here.\n')
    }

    const result = await call(agentDir, { query: 'needle', maxResults: 3 })
    expect(result).toEqual({
      matches: [
        expect.objectContaining({ slug: 'topic-00' }),
        expect.objectContaining({ slug: 'topic-01' }),
        expect.objectContaining({ slug: 'topic-02' }),
      ],
      truncatedAt: 3,
    })
  })

  test('full mode includes fullBody while retaining excerpts', async () => {
    const agentDir = await makeAgentDir()
    const body = 'Intro\nfoo lives here.\nOutro\n'
    await writeShard(agentDir, 'full-mode', 'Full mode', body)

    const result = await call(agentDir, { query: 'foo', full: true })
    expect(result).toEqual({
      matches: [
        {
          shardPath: topicShardPath(agentDir, 'full-mode'),
          slug: 'full-mode',
          heading: 'Full mode',
          excerpt: 'Intro\nfoo lives here.\nOutro',
          fullBody: body,
        },
      ],
    })
  })

  test('excerpt window includes three lines before and after the matched body line', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(
      agentDir,
      'window',
      'Window',
      'line 1\nline 2\nline 3\nline 4\nneedle line 5\nline 6\nline 7\nline 8\nline 9\n',
    )

    const result = await call(agentDir, { query: 'needle' })
    expect('matches' in result ? result.matches[0]?.excerpt : undefined).toBe(
      'line 2\nline 3\nline 4\nneedle line 5\nline 6\nline 7\nline 8',
    )
  })

  test('substring matching is case-insensitive', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'case', 'Case', 'the typeclaw runtime is here.\n')

    const result = await call(agentDir, { query: 'TypeClaw' })
    expect('matches' in result ? result.matches.map((match) => match.slug) : []).toEqual(['case'])
  })

  test('empty topics dir returns empty matches with truncatedAt zero', async () => {
    const agentDir = await makeAgentDir()
    await mkdir(topicsDir(agentDir), { recursive: true })

    await expect(call(agentDir, { query: 'anything' })).resolves.toEqual({ matches: [], truncatedAt: 0 })
  })
})

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-search-'))
  tmpRoots.push(dir)
  return dir
}

async function call(agentDir: string, input: unknown): Promise<SearchResult> {
  const args = memorySearchTool.parameters.parse(input)
  const result = await memorySearchTool.execute(args, ctx(agentDir))
  return result.details as SearchResult
}

function ctx(agentDir: string): ToolContext {
  return {
    signal: undefined,
    sessionId: 'test-session',
    agentDir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

async function writeShard(
  agentDir: string,
  slug: string,
  heading: string,
  body: string,
  patch: Partial<ShardFrontmatter> = {},
): Promise<void> {
  await mkdir(topicsDir(agentDir), { recursive: true })
  await writeFile(topicShardPath(agentDir, slug), shardText(heading, body, patch), 'utf8')
}

function shardText(heading: string, body: string, patch: Partial<ShardFrontmatter>): string {
  return renderShard(
    {
      heading,
      cites: 1,
      days: 1,
      lastReinforced: '2026-05-20',
      tags: ['memory', 'topic'],
      ...patch,
    },
    body,
  )
}
