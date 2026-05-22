import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'

import { saveDreamingState } from './dreaming-state'
import { renderShard, type ShardFrontmatter } from './frontmatter'
import { streamFilePath, streamsDir, topicShardPath, topicsDir } from './paths'
import { memorySearchTool } from './search-tool'
import type { FragmentEvent, LegacyProseEvent, WatermarkEvent } from './stream-events'
import { appendEvents } from './stream-io'

const tmpRoots: string[] = []

type TopicMatch = {
  source: 'topic'
  shardPath: string
  slug: string
  heading: string
  excerpt: string
  fullBody?: string
}

type StreamMatch = {
  source: 'stream'
  streamPath: string
  date: string
  eventId?: string
  topic: string
  excerpt: string
  fullBody?: string
}

type SearchResult = { matches: Array<TopicMatch | StreamMatch>; truncatedAt?: number } | { error: string }

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
          source: 'topic',
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

    expect('matches' in result ? result.matches.map(topicSlug) : []).toEqual(['citations'])
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
          source: 'topic',
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
          source: 'topic',
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
          source: 'topic',
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
          source: 'topic',
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
    expect('matches' in result ? result.matches.map(topicSlug) : []).toEqual(['case'])
  })

  test('empty topics dir and no streams returns empty matches with truncatedAt zero', async () => {
    const agentDir = await makeAgentDir()
    await mkdir(topicsDir(agentDir), { recursive: true })

    await expect(call(agentDir, { query: 'anything' })).resolves.toEqual({ matches: [], truncatedAt: 0 })
  })
})

describe('memorySearchTool — stream events', () => {
  test('fragment topic match returns a stream match with eventId in citation format', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-20', [
      fragment('frag-001', 'Deploy preferences', 'User likes blue-green deploys.\n'),
    ])

    const result = await call(agentDir, { query: 'deploy preferences' })

    expect(result).toEqual({
      matches: [
        {
          source: 'stream',
          streamPath: streamFilePath(agentDir, '2026-05-20'),
          date: '2026-05-20',
          eventId: 'streams/2026-05-20#frag-001',
          topic: 'Deploy preferences',
          excerpt: 'Deploy preferences',
        },
      ],
    })
  })

  test('fragment body match returns a line-context excerpt', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-20', [
      fragment('frag-002', 'Random topic', 'line 1\nline 2\nneedle here\nline 4\nline 5\n'),
    ])

    const result = await call(agentDir, { query: 'needle' })

    expect(result).toEqual({
      matches: [
        {
          source: 'stream',
          streamPath: streamFilePath(agentDir, '2026-05-20'),
          date: '2026-05-20',
          eventId: 'streams/2026-05-20#frag-002',
          topic: 'Random topic',
          excerpt: 'line 1\nline 2\nneedle here\nline 4\nline 5',
        },
      ],
    })
  })

  test('dreamed events are excluded from stream results', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-20', [
      fragment('dreamed-001', 'Already consolidated', 'this body mentions needle.\n'),
      fragment('undreamed-001', 'Fresh fragment', 'this body also mentions needle.\n'),
    ])
    await saveDreamingState(agentDir, {
      version: 2,
      dreamedThrough: { '2026-05-20': { dreamedIds: ['dreamed-001'], ts: '2026-05-20T00:00:00Z' } },
    })

    const result = await call(agentDir, { query: 'needle' })

    expect('matches' in result ? result.matches.map((m) => ('eventId' in m ? m.eventId : undefined)) : []).toEqual([
      'streams/2026-05-20#undreamed-001',
    ])
  })

  test('watermark events are never returned as matches', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-20', [
      { type: 'watermark', id: 'wm-001', ts: '2026-05-20T10:00:00Z', source: 'session-x', entry: 'entry-1' },
    ])

    const result = await call(agentDir, { query: 'wm-001' })

    expect(result).toEqual({ matches: [] })
  })

  test('legacy_prose match returns a stream match with no eventId', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-19', [
      {
        type: 'legacy_prose',
        ts: '2026-05-19T00:00:00Z',
        text: 'old prose mentions needle inline.',
        origin: 'migration',
      },
    ])

    const result = await call(agentDir, { query: 'needle' })

    expect(result).toEqual({
      matches: [
        {
          source: 'stream',
          streamPath: streamFilePath(agentDir, '2026-05-19'),
          date: '2026-05-19',
          topic: '[legacy prose from pre-shard migration]',
          excerpt: 'old prose mentions needle inline.',
        },
      ],
    })
  })

  test('topic matches come before stream matches; stream days come newest first', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'older-topic', 'Older topic', 'needle in shard body.\n')
    await writeStream(agentDir, '2026-05-19', [fragment('day-19', 'D19 topic', 'needle in old fragment.\n')])
    await writeStream(agentDir, '2026-05-21', [fragment('day-21', 'D21 topic', 'needle in new fragment.\n')])
    await writeStream(agentDir, '2026-05-20', [fragment('day-20', 'D20 topic', 'needle in mid fragment.\n')])

    const result = await call(agentDir, { query: 'needle' })

    expect('matches' in result ? result.matches.map(matchKey) : []).toEqual([
      'topic:older-topic',
      'stream:streams/2026-05-21#day-21',
      'stream:streams/2026-05-20#day-20',
      'stream:streams/2026-05-19#day-19',
    ])
  })

  test('maxResults truncates streams first, preserving topic matches', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'topic-a', 'Topic A', 'needle in shard.\n')
    await writeStream(agentDir, '2026-05-20', [
      fragment('s1', 'S1', 'needle in s1.\n'),
      fragment('s2', 'S2', 'needle in s2.\n'),
      fragment('s3', 'S3', 'needle in s3.\n'),
    ])

    const result = await call(agentDir, { query: 'needle', maxResults: 2 })

    expect('matches' in result ? result.matches.map(matchKey) : []).toEqual([
      'topic:topic-a',
      'stream:streams/2026-05-20#s1',
    ])
    expect('truncatedAt' in result ? result.truncatedAt : undefined).toBe(2)
  })

  test('full mode includes fullBody for fragment matches', async () => {
    const agentDir = await makeAgentDir()
    const body = 'first line\nneedle in fragment.\nlast line\n'
    await writeStream(agentDir, '2026-05-20', [fragment('frag-full', 'Full', body)])

    const result = await call(agentDir, { query: 'needle', full: true })

    const first = 'matches' in result ? (result.matches[0] as StreamMatch | undefined) : undefined
    expect(first?.fullBody).toBe(body)
  })

  test('agentDir with only streams (no topics dir) still returns stream matches', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-20', [fragment('only-stream', 'Stream only', 'needle here.\n')])

    const result = await call(agentDir, { query: 'needle' })

    expect('matches' in result ? result.matches.map(matchKey) : []).toEqual(['stream:streams/2026-05-20#only-stream'])
  })
})

function topicSlug(m: TopicMatch | StreamMatch): string | undefined {
  return m.source === 'topic' ? m.slug : undefined
}

function matchKey(m: TopicMatch | StreamMatch): string {
  if (m.source === 'topic') return `topic:${m.slug}`
  return `stream:${m.eventId ?? `${m.date}#legacy`}`
}

function fragment(id: string, topic: string, body: string): FragmentEvent {
  return {
    type: 'fragment',
    id,
    ts: '2026-05-20T12:00:00Z',
    source: 'test-session',
    entry: 'entry-1',
    topic,
    body,
  }
}

async function writeStream(
  agentDir: string,
  date: string,
  events: Array<FragmentEvent | WatermarkEvent | LegacyProseEvent>,
): Promise<void> {
  await mkdir(streamsDir(agentDir), { recursive: true })
  await appendEvents(streamFilePath(agentDir, date), events)
}

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
