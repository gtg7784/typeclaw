import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fragmentContentHash } from '../fragment-parser'
import { streamFilePath } from '../paths'
import type { FragmentEvent, WatermarkEvent } from '../stream-events'
import { appendEvents, readEvents } from '../stream-io'
import type { EmbedFn } from './hybrid'
import { makeAppendHook } from './index-on-write'
import { VectorStore } from './store'

const testDirs: string[] = []

afterEach(async () => {
  for (const dir of testDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('makeAppendHook', () => {
  it('QA 2.1: indexes appended fragments and ignores watermark-only appends', async () => {
    const { agentDir, openStore } = await createFixture()
    const fragment = fragmentEvent('frag-1')
    const watermark = watermarkEvent('watermark-1')
    let embedCalls = 0
    const embedFn: EmbedFn = async (texts, type) => {
      embedCalls += 1
      expect(type).toBe('passage')
      expect(texts).toEqual(['Topic frag-1\nBody frag-1'])
      return [vector({ 0: 1 })]
    }

    const hook = makeAppendHook(openStore, embedFn)
    const streamPath = streamFilePath(agentDir, '2026-06-11')
    await appendEvents(streamPath, [fragment, watermark], hook)
    await appendEvents(streamPath, [watermarkEvent('watermark-2')], hook)

    const store = openStore()
    try {
      const [row] = store.getByIds(['stream:2026-06-11#frag-1'])
      expect(row?.source).toBe('stream')
      expect(row?.key).toBe('2026-06-11#frag-1')
      expect(row?.contentHash).toBe(fragmentContentHash(fragment))
      expect(embedCalls).toBe(1)
    } finally {
      store.close()
    }
  })

  it('QA 2.2: skips re-embedding a same-hash fragment already indexed at the same id', async () => {
    const { agentDir, openStore } = await createFixture()
    const fragment = fragmentEvent('same')
    let embedCalls = 0
    const embedFn: EmbedFn = async () => {
      embedCalls += 1
      return [vector({ 1: 1 })]
    }

    const hook = makeAppendHook(openStore, embedFn)
    const streamPath = streamFilePath(agentDir, '2026-06-11')
    await appendEvents(streamPath, [fragment], hook)
    await appendEvents(streamPath, [fragment], hook)

    const store = openStore()
    try {
      expect(store.getByIds(['stream:2026-06-11#same'])[0]).toBeDefined()
      expect(embedCalls).toBe(1)
    } finally {
      store.close()
    }
  })

  it('QA 2.1b: throwing hook preserves JSONL append and calls onHookError', async () => {
    const { agentDir, openStore } = await createFixture()
    const fragment = fragmentEvent('frag-throw')
    const watermark = watermarkEvent('watermark-throw')
    let hookErrorCalled = false
    let capturedError: unknown = null
    const embedFn: EmbedFn = async () => {
      return [vector({ 0: 1 })]
    }

    const hook = makeAppendHook(openStore, embedFn)
    const streamPath = streamFilePath(agentDir, '2026-06-11')

    const throwingHook = async (frags: FragmentEvent[], context: any) => {
      await hook(frags, context)
      throw new Error('Simulated hook failure')
    }

    await appendEvents(streamPath, [fragment, watermark], throwingHook, (err) => {
      hookErrorCalled = true
      capturedError = err
    })

    // given: the hook threw, but the JSONL append must still have landed
    const events = await readEvents(streamPath)
    expect(events.some((e) => e.type === 'fragment' && e.id === 'frag-throw')).toBe(true)
    expect(events.some((e) => e.type === 'watermark' && e.id === 'watermark-throw')).toBe(true)

    expect(hookErrorCalled).toBe(true)
    expect(capturedError).toBeInstanceOf(Error)
    expect((capturedError as Error).message).toBe('Simulated hook failure')
  })
})

async function createFixture(): Promise<{ agentDir: string; openStore: () => VectorStore }> {
  const agentDir = join(tmpdir(), `typeclaw-index-on-write-${randomUUID()}`)
  testDirs.push(agentDir)
  await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
  const dbPath = join(agentDir, 'memory', '.vectors', 'index.db')
  return { agentDir, openStore: () => VectorStore.open(dbPath) }
}

function fragmentEvent(id: string): FragmentEvent {
  return {
    type: 'fragment',
    id,
    ts: '2026-06-11T12:00:00.000Z',
    source: 'ses_test',
    entry: `entry-${id}`,
    topic: `Topic ${id}`,
    body: `Body ${id}`,
  }
}

function watermarkEvent(id: string): WatermarkEvent {
  return {
    type: 'watermark',
    id,
    ts: '2026-06-11T12:01:00.000Z',
    source: 'ses_test',
    entry: `entry-${id}`,
  }
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
