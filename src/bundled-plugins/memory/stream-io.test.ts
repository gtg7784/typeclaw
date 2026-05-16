import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import type { FragmentEvent, WatermarkEvent } from './stream-events'
import { appendEvents, readEvents, writeEventsAtomic, countEvents } from './stream-io'

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
