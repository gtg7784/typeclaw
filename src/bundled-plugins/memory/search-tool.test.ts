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

  test('finds matches in legacy flat memory/<date>.jsonl layout (pre-shard agents)', async () => {
    const agentDir = await makeAgentDir()
    await writeLegacyStream(agentDir, '2026-04-15', [
      fragment('legacy-frag', 'Pre-shard topic', 'needle in legacy file.\n'),
    ])

    const result = await call(agentDir, { query: 'needle' })

    expect('matches' in result ? result.matches.map(matchKey) : []).toEqual(['stream:streams/2026-04-15#legacy-frag'])
  })

  test('exhausts multiple matching events across multiple stream days within maxResults', async () => {
    const agentDir = await makeAgentDir()
    await writeStream(agentDir, '2026-05-19', [
      fragment('d19-a', 'D19 a', 'needle in d19 a.\n'),
      fragment('d19-b', 'D19 b', 'needle in d19 b.\n'),
    ])
    await writeStream(agentDir, '2026-05-20', [
      fragment('d20-a', 'D20 a', 'needle in d20 a.\n'),
      fragment('d20-b', 'D20 b', 'needle in d20 b.\n'),
    ])

    const result = await call(agentDir, { query: 'needle' })

    expect('matches' in result ? result.matches.map(matchKey) : []).toEqual([
      'stream:streams/2026-05-20#d20-a',
      'stream:streams/2026-05-20#d20-b',
      'stream:streams/2026-05-19#d19-a',
      'stream:streams/2026-05-19#d19-b',
    ])
  })
})

// Production: descriptive multi-word queries (e.g. "swmaestro summary webex
// space id") matched no body as a contiguous substring even though every
// word was present, returning {"matches":[]} for ~74% of multi-word calls.
// Fallback OR-matches the whitespace-split tokens, but ONLY when the exact
// phrase finds nothing.
describe('memorySearchTool — multi-word token fallback', () => {
  test('phrase that no body contains as a contiguous substring still matches via tokens', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(
      agentDir,
      'webex-cron',
      'Webex SWMaestro summary cron',
      'Posts a summary of the SWMaestro Webex space to Discord.\n',
    )

    const result = await call(agentDir, { query: 'swmaestro summary webex space id' })

    expect('matches' in result ? result.matches.map(topicSlug) : []).toEqual(['webex-cron'])
  })

  test('exact-phrase match still wins and does NOT fall back to tokens', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'phrase-shard', 'Phrase shard', 'the blue green deploy runs nightly.\n')
    await writeShard(agentDir, 'token-shard', 'Token shard', 'deploy something unrelated here.\n')

    const result = await call(agentDir, { query: 'blue green deploy' })

    expect('matches' in result ? result.matches.map(topicSlug) : []).toEqual(['phrase-shard'])
  })

  test('token fallback ranks more-tokens-matched ahead of fewer, surface order as tiebreak', async () => {
    const agentDir = await makeAgentDir()
    // 'one-hit' sorts first alphabetically but matches fewer tokens, so the
    // tokens-matched ranking must reorder it behind 'three-hit'.
    await writeShard(agentDir, 'one-hit', 'One hit', 'only perpetual appears here.\n')
    await writeShard(agentDir, 'three-hit', 'Three hit', 'xrp perpetual futures all here.\n')

    const result = await call(agentDir, { query: 'xrp perpetual futures bounce signal' })

    expect('matches' in result ? result.matches.map(topicSlug) : []).toEqual(['three-hit', 'one-hit'])
  })

  test('token fallback covers stream events too, ranked after topics', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'topic-shard', 'Topic shard', 'xrp futures live here.\n')
    await writeStream(agentDir, '2026-05-20', [fragment('s1', 'Stream frag', 'bounce signal recorded.\n')])

    const result = await call(agentDir, { query: 'xrp futures bounce signal' })

    expect('matches' in result ? result.matches.map(matchKey) : []).toEqual([
      'topic:topic-shard',
      'stream:streams/2026-05-20#s1',
    ])
  })

  test('single-word query is unaffected (no fallback path, still empty on no match)', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'daily-notes', 'Daily notes', 'A body about memory.\n')

    await expect(call(agentDir, { query: 'absent' })).resolves.toEqual({ matches: [] })
  })

  test('regex mode never tokenizes — whitespace stays part of the pattern', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'only-foo', 'Only foo', 'foo stands alone here.\n')

    const result = await call(agentDir, { query: 'foo bar', asRegex: true })

    expect(result).toEqual({ matches: [] })
  })

  test('token fallback excerpt anchors on the first line matching any token', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(
      agentDir,
      'window',
      'Window',
      'line 1\nline 2\nline 3\nline 4\nthe futures line 5\nline 6\nline 7\nline 8\nline 9\n',
    )

    const result = await call(agentDir, { query: 'xrp perpetual futures' })

    expect('matches' in result ? result.matches[0]?.excerpt : undefined).toBe(
      'line 2\nline 3\nline 4\nthe futures line 5\nline 6\nline 7\nline 8',
    )
  })

  test('duplicate and whitespace-only tokens collapse (no double-counting in ranking)', async () => {
    const agentDir = await makeAgentDir()
    await writeShard(agentDir, 'one-word', 'One word', 'futures contract noted.\n')

    const result = await call(agentDir, { query: '  futures   futures  ' })

    expect('matches' in result ? result.matches.map(topicSlug) : []).toEqual(['one-word'])
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

async function writeLegacyStream(
  agentDir: string,
  date: string,
  events: Array<FragmentEvent | WatermarkEvent | LegacyProseEvent>,
): Promise<void> {
  const legacyDir = join(agentDir, 'memory')
  await mkdir(legacyDir, { recursive: true })
  await appendEvents(join(legacyDir, `${date}.jsonl`), events)
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
