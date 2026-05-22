import { describe, it, expect, beforeEach, afterEach, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import { DREAMING_STATE_FILE } from './dreaming-state'
import { streamFilePath, streamsDir } from './paths'
import type { FragmentEvent, LegacyProseEvent, WatermarkEvent } from './stream-events'
import {
  appendEvents,
  countEvents,
  filterUndreamedEvents,
  listStreamFiles,
  readAllStreamDays,
  readAllUndreamedStreamDays,
  readEvents,
  writeEventsAtomic,
} from './stream-io'

describe('stream-io', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'typeclaw-stream-io-'))
    path = join(dir, 'stream.jsonl')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const fragment: FragmentEvent = {
    type: 'fragment',
    id: 'frag-01',
    ts: '2026-05-16T00:00:00Z',
    source: 'ses_a',
    entry: 'entry-01',
    topic: 'Test Topic',
    body: 'Test body content',
  }

  const watermark: WatermarkEvent = {
    type: 'watermark',
    id: 'wm-01',
    ts: '2026-05-16T01:00:00Z',
    source: 'ses_a',
    entry: 'entry-02',
  }

  it('appendEvents writes one line per event, terminated with \\n', async () => {
    await appendEvents(path, [fragment, watermark])

    const text = await readFile(path, 'utf-8')
    const lines = text.split('\n').filter((l) => l !== '')

    expect(lines.length).toBe(2)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
    expect(() => JSON.parse(lines[1]!)).not.toThrow()
    expect(text.endsWith('\n')).toBe(true)
  })

  it('appendEvents preserves prior content', async () => {
    const existing: FragmentEvent = {
      type: 'fragment',
      id: 'frag-00',
      ts: '2026-05-15T00:00:00Z',
      source: 'ses_a',
      entry: 'entry-00',
      topic: 'Prior Topic',
      body: 'Prior body',
    }
    await writeFile(path, `${JSON.stringify(existing)}\n`, 'utf-8')

    await appendEvents(path, [watermark])

    const text = await readFile(path, 'utf-8')
    const lines = text.split('\n').filter((l) => l !== '')

    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!)).toEqual(existing)
    expect(JSON.parse(lines[1]!)).toEqual(watermark)
  })

  it('readEvents returns empty array for missing file', async () => {
    const result = await readEvents('/nonexistent/path/that/does/not/exist.jsonl')
    expect(result).toEqual([])
  })

  it('readEvents drops malformed lines but keeps the rest', async () => {
    const lines = [JSON.stringify(fragment), '{garbage', JSON.stringify(watermark)]
    await writeFile(path, lines.join('\n') + '\n', 'utf-8')

    const events = await readEvents(path)

    expect(events.length).toBe(2)
    expect(events[0]).toEqual(fragment)
    expect(events[1]).toEqual(watermark)
  })

  it('writeEventsAtomic writes correct content and leaves no .tmp file', async () => {
    const event1: FragmentEvent = {
      type: 'fragment',
      id: 'frag-02',
      ts: '2026-05-16T02:00:00Z',
      source: 'ses_b',
      entry: 'entry-03',
      topic: 'Another Topic',
      body: 'Another body',
    }
    const event2: WatermarkEvent = {
      type: 'watermark',
      id: 'wm-02',
      ts: '2026-05-16T03:00:00Z',
      source: 'ses_b',
      entry: 'entry-04',
    }

    await writeEventsAtomic(path, [event1, event2])

    const text = await readFile(path, 'utf-8')
    const lines = text.split('\n').filter((l) => l !== '')

    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!)).toEqual(event1)
    expect(JSON.parse(lines[1]!)).toEqual(event2)

    await expect(readFile(`${path}.tmp`, 'utf-8')).rejects.toThrow()
  })

  it('countEvents returns 0 for missing file', async () => {
    const count = await countEvents('/nonexistent/path/count.jsonl')
    expect(count).toBe(0)
  })

  it('countEvents counts only valid events', async () => {
    const lines = [JSON.stringify(fragment), '{bad json', '', JSON.stringify(watermark)]
    await writeFile(path, lines.join('\n') + '\n', 'utf-8')

    const count = await countEvents(path)
    expect(count).toBe(2)
  })

  it('appendEvents does nothing when events array is empty', async () => {
    await appendEvents(path, [])
    const exists = await readFile(path, 'utf-8').then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)
  })
})

describe('listStreamFiles', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(os.tmpdir(), 'typeclaw-listStreamFiles-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('returns the canonical memory/streams/ layout when present', async () => {
    await mkdir(streamsDir(agentDir), { recursive: true })
    await writeFile(streamFilePath(agentDir, '2026-05-20'), '', 'utf-8')

    const result = await listStreamFiles(agentDir)

    expect(result).toEqual({
      dir: streamsDir(agentDir),
      displayPrefix: 'memory/streams',
      names: ['2026-05-20.jsonl'],
    })
  })

  test('falls back to legacy flat memory/ layout when memory/streams/ is absent', async () => {
    const legacyDir = join(agentDir, 'memory')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, '2026-04-15.jsonl'), '', 'utf-8')

    const result = await listStreamFiles(agentDir)

    expect(result).toEqual({
      dir: legacyDir,
      displayPrefix: 'memory',
      names: ['2026-04-15.jsonl'],
    })
  })

  test('returns null when neither memory/streams/ nor memory/ exists', async () => {
    const result = await listStreamFiles(agentDir)
    expect(result).toBeNull()
  })

  test('prefers memory/streams/ over memory/ when both exist', async () => {
    await mkdir(streamsDir(agentDir), { recursive: true })
    await writeFile(streamFilePath(agentDir, '2026-05-20'), '', 'utf-8')
    await writeFile(join(agentDir, 'memory', 'stray.jsonl'), '', 'utf-8')

    const result = await listStreamFiles(agentDir)

    expect(result?.displayPrefix).toBe('memory/streams')
    expect(result?.names).toEqual(['2026-05-20.jsonl'])
  })
})

describe('readAllStreamDays', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(os.tmpdir(), 'typeclaw-readAllStreamDays-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('returns raw events with dreamedIds per day, oldest day first', async () => {
    await mkdir(streamsDir(agentDir), { recursive: true })
    await appendEvents(streamFilePath(agentDir, '2026-05-19'), [fragmentFor('e1', 'topic A')])
    await appendEvents(streamFilePath(agentDir, '2026-05-20'), [fragmentFor('e2', 'topic B')])
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({
        version: 2,
        dreamedThrough: { '2026-05-19': { dreamedIds: ['e1'], ts: 'past' } },
      }),
      'utf-8',
    )

    const days = await readAllStreamDays(agentDir)

    expect(days.map((d) => d.date)).toEqual(['2026-05-19', '2026-05-20'])
    expect(days[0]!.events.length).toBe(1)
    expect(days[0]!.dreamedIds.has('e1')).toBe(true)
    expect(days[1]!.dreamedIds.size).toBe(0)
  })

  test('returns empty array when no streams exist', async () => {
    const days = await readAllStreamDays(agentDir)
    expect(days).toEqual([])
  })

  test('reads from legacy flat memory/ layout', async () => {
    const legacyDir = join(agentDir, 'memory')
    await mkdir(legacyDir, { recursive: true })
    await appendEvents(join(legacyDir, '2026-04-15.jsonl'), [fragmentFor('e1', 'legacy topic')])

    const days = await readAllStreamDays(agentDir)

    expect(days.length).toBe(1)
    expect(days[0]!.date).toBe('2026-04-15')
    expect(days[0]!.name).toBe('memory/2026-04-15.jsonl')
    expect(days[0]!.events[0]?.type).toBe('fragment')
  })
})

describe('readAllUndreamedStreamDays', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(os.tmpdir(), 'typeclaw-readAllUndreamed-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('drops fully-dreamed days', async () => {
    await mkdir(streamsDir(agentDir), { recursive: true })
    await appendEvents(streamFilePath(agentDir, '2026-05-19'), [fragmentFor('e1', 'topic A')])
    await appendEvents(streamFilePath(agentDir, '2026-05-20'), [fragmentFor('e2', 'topic B')])
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({
        version: 2,
        dreamedThrough: { '2026-05-19': { dreamedIds: ['e1'], ts: 'past' } },
      }),
      'utf-8',
    )

    const days = await readAllUndreamedStreamDays(agentDir)

    expect(days.map((d) => d.date)).toEqual(['2026-05-20'])
  })

  test('keeps only undreamed events on partially-dreamed days', async () => {
    await mkdir(streamsDir(agentDir), { recursive: true })
    await appendEvents(streamFilePath(agentDir, '2026-05-20'), [
      fragmentFor('e1', 'dreamed'),
      fragmentFor('e2', 'fresh'),
    ])
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({
        version: 2,
        dreamedThrough: { '2026-05-20': { dreamedIds: ['e1'], ts: 'past' } },
      }),
      'utf-8',
    )

    const days = await readAllUndreamedStreamDays(agentDir)

    expect(days.length).toBe(1)
    expect(days[0]!.events.map((e) => (e.type === 'fragment' ? e.topic : null))).toEqual(['fresh'])
  })

  test('reads from legacy flat memory/ layout with dreamed-id filtering', async () => {
    const legacyDir = join(agentDir, 'memory')
    await mkdir(legacyDir, { recursive: true })
    await appendEvents(join(legacyDir, '2026-04-15.jsonl'), [
      fragmentFor('e1', 'dreamed legacy'),
      fragmentFor('e2', 'fresh legacy'),
    ])
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({
        version: 2,
        dreamedThrough: { '2026-04-15': { dreamedIds: ['e1'], ts: 'past' } },
      }),
      'utf-8',
    )

    const days = await readAllUndreamedStreamDays(agentDir)

    expect(days.length).toBe(1)
    expect(days[0]!.name).toBe('memory/2026-04-15.jsonl')
    expect(days[0]!.events.map((e) => (e.type === 'fragment' ? e.topic : null))).toEqual(['fresh legacy'])
  })

  test('keeps legacy_prose events even when other events on the day are dreamed', async () => {
    const legacy: LegacyProseEvent = {
      type: 'legacy_prose',
      ts: '2026-04-15T00:00:00Z',
      text: 'pre-shard prose snippet',
      origin: 'migration',
    }
    await mkdir(streamsDir(agentDir), { recursive: true })
    await appendEvents(streamFilePath(agentDir, '2026-04-15'), [fragmentFor('e1', 'dreamed'), legacy])
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({
        version: 2,
        dreamedThrough: { '2026-04-15': { dreamedIds: ['e1'], ts: 'past' } },
      }),
      'utf-8',
    )

    const days = await readAllUndreamedStreamDays(agentDir)

    expect(days.length).toBe(1)
    expect(days[0]!.events.some((e) => e.type === 'legacy_prose')).toBe(true)
  })
})

describe('filterUndreamedEvents', () => {
  test('returns the same array reference when dreamedIds is empty (no allocation)', () => {
    const events = [fragmentFor('e1', 't1'), fragmentFor('e2', 't2')]
    expect(filterUndreamedEvents(events, new Set())).toBe(events)
  })

  test('drops events whose id is in the dreamed set', () => {
    const events = [fragmentFor('e1', 't1'), fragmentFor('e2', 't2')]
    const result = filterUndreamedEvents(events, new Set(['e1']))
    expect(result.map((e) => (e.type === 'fragment' ? e.id : null))).toEqual(['e2'])
  })

  test('always keeps legacy_prose events (no id to match)', () => {
    const legacy: LegacyProseEvent = {
      type: 'legacy_prose',
      ts: '2026-04-15T00:00:00Z',
      text: 'old',
      origin: 'migration',
    }
    const result = filterUndreamedEvents([fragmentFor('e1', 't1'), legacy], new Set(['e1']))
    expect(result.length).toBe(1)
    expect(result[0]?.type).toBe('legacy_prose')
  })
})

function fragmentFor(id: string, topic: string): FragmentEvent {
  return {
    type: 'fragment',
    id,
    ts: '2026-05-20T12:00:00Z',
    source: 'ses_test',
    entry: `entry-${id}`,
    topic,
    body: `body for ${topic}`,
  }
}
