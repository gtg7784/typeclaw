import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetDreamingStateCacheForTests,
  addDreamedIds,
  clearDreamedIds,
  DREAMING_STATE_FILE,
  emptyState,
  getDreamedIds,
  loadDreamingState,
  saveDreamingState,
} from './dreaming-state'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-state-'))
  __resetDreamingStateCacheForTests()
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
  __resetDreamingStateCacheForTests()
})

describe('loadDreamingState', () => {
  test('returns empty state when the file does not exist', async () => {
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('returns empty state when the file is malformed JSON (fail-open)', async () => {
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, DREAMING_STATE_FILE), '{ not json')
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('returns empty state when the version is wrong (forward incompat)', async () => {
    await mkdir(join(agentDir, 'memory'))
    await writeFile(join(agentDir, DREAMING_STATE_FILE), JSON.stringify({ version: 999, dreamedThrough: {} }))
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('returns empty state when reading a v1 (lines-based) file — backward compat dropped', async () => {
    await mkdir(join(agentDir, 'memory'))
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 42, ts: 'past' } } }),
    )
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('returns empty state when shape is invalid', async () => {
    await mkdir(join(agentDir, 'memory'))
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 2, dreamedThrough: { '2026-04-27': { dreamedIds: 'not an array', ts: 'x' } } }),
    )
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('rejects an array of non-string ids', async () => {
    await mkdir(join(agentDir, 'memory'))
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 2, dreamedThrough: { '2026-04-27': { dreamedIds: [42], ts: 'x' } } }),
    )
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('round-trips a valid state through save and load', async () => {
    const next = addDreamedIds(emptyState(), '2026-04-27', ['id-a', 'id-b'], '2026-04-27T16:09:00+09:00')
    await saveDreamingState(agentDir, next)

    const loaded = await loadDreamingState(agentDir)
    expect(loaded.dreamedThrough['2026-04-27']).toEqual({
      dreamedIds: ['id-a', 'id-b'],
      ts: '2026-04-27T16:09:00+09:00',
    })
  })

  test('saveDreamingState creates the memory directory if missing', async () => {
    const state = addDreamedIds(emptyState(), '2026-04-27', ['id-a'], 'now')
    await saveDreamingState(agentDir, state)

    const loaded = await loadDreamingState(agentDir)
    expect(loaded).toEqual(state)
  })
})

describe('getDreamedIds', () => {
  test('returns an empty set for a date with no recorded ids', () => {
    expect(getDreamedIds(emptyState(), '2026-04-27').size).toBe(0)
  })

  test('returns the recorded id set for a date', () => {
    const state = addDreamedIds(emptyState(), '2026-04-27', ['x', 'y'], 'now')
    const ids = getDreamedIds(state, '2026-04-27')
    expect(ids.has('x')).toBe(true)
    expect(ids.has('y')).toBe(true)
    expect(ids.size).toBe(2)
  })
})

describe('addDreamedIds', () => {
  test('does not mutate the input state', () => {
    const before = emptyState()
    const after = addDreamedIds(before, '2026-04-27', ['a'], 'now')
    expect(before.dreamedThrough).toEqual({})
    expect(after.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['a'])
  })

  test('merges with previously dreamed ids for the same date, deduplicating', () => {
    let state = addDreamedIds(emptyState(), '2026-04-27', ['a', 'b'], 't1')
    state = addDreamedIds(state, '2026-04-27', ['b', 'c'], 't2')
    expect(state.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['a', 'b', 'c'])
    expect(state.dreamedThrough['2026-04-27']?.ts).toBe('t2')
  })

  test('preserves dreamed ids for other dates', () => {
    let state = addDreamedIds(emptyState(), '2026-04-26', ['old'], 't1')
    state = addDreamedIds(state, '2026-04-27', ['new'], 't2')
    expect(state.dreamedThrough['2026-04-26']?.dreamedIds).toEqual(['old'])
    expect(state.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['new'])
  })

  test('persists ids sorted so on-disk JSON has a stable diff order', () => {
    const state = addDreamedIds(emptyState(), '2026-04-27', ['z', 'a', 'm'], 'now')
    expect(state.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['a', 'm', 'z'])
  })
})

describe('clearDreamedIds', () => {
  test('replaces an existing entry with an empty id list (migration reset)', () => {
    const state = addDreamedIds(emptyState(), '2026-04-27', ['stale-1', 'stale-2'], 't1')
    const cleared = clearDreamedIds(state, '2026-04-27', 't2')
    expect(cleared.dreamedThrough['2026-04-27']).toEqual({ dreamedIds: [], ts: 't2' })
  })

  test('does not affect other dates', () => {
    let state = addDreamedIds(emptyState(), '2026-04-26', ['keep'], 't1')
    state = addDreamedIds(state, '2026-04-27', ['drop'], 't1')
    const cleared = clearDreamedIds(state, '2026-04-27', 't2')
    expect(cleared.dreamedThrough['2026-04-26']?.dreamedIds).toEqual(['keep'])
    expect(cleared.dreamedThrough['2026-04-27']?.dreamedIds).toEqual([])
  })
})

describe('loadDreamingState cache', () => {
  test('second load returns the same state reference (cache hit) when file is untouched', async () => {
    const state = addDreamedIds(emptyState(), '2026-04-27', ['a'], 'now')
    await saveDreamingState(agentDir, state)

    const first = await loadDreamingState(agentDir)
    const second = await loadDreamingState(agentDir)

    expect(second).toBe(first)
  })

  test('saveDreamingState invalidates the cache (mtime bumps)', async () => {
    await saveDreamingState(agentDir, addDreamedIds(emptyState(), '2026-04-27', ['a'], 't1'))
    const first = await loadDreamingState(agentDir)
    expect(first.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['a'])

    await saveDreamingState(agentDir, addDreamedIds(emptyState(), '2026-04-27', ['a', 'b'], 't2'))
    const second = await loadDreamingState(agentDir)

    expect(second).not.toBe(first)
    expect(second.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['a', 'b'])
  })

  test('cache drops entry when file disappears so a recreate returns fresh state', async () => {
    await saveDreamingState(agentDir, addDreamedIds(emptyState(), '2026-04-27', ['a'], 'now'))
    const first = await loadDreamingState(agentDir)
    expect(first.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['a'])

    await rm(join(agentDir, DREAMING_STATE_FILE))
    const empty = await loadDreamingState(agentDir)
    expect(empty).toEqual(emptyState())

    await saveDreamingState(agentDir, addDreamedIds(emptyState(), '2026-04-28', ['z'], 'later'))
    const recreated = await loadDreamingState(agentDir)
    expect(recreated.dreamedThrough['2026-04-28']?.dreamedIds).toEqual(['z'])
    expect(recreated.dreamedThrough['2026-04-27']).toBeUndefined()
  })
})
