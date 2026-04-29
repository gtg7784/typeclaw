import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DREAMING_STATE_FILE,
  emptyState,
  getDreamedLines,
  loadDreamingState,
  saveDreamingState,
  setDreamedLines,
} from './dreaming-state'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-state-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
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

  test('returns empty state when shape is invalid', async () => {
    await mkdir(join(agentDir, 'memory'))
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 1, dreamedThrough: { '2026-04-27': { lines: 'not a number', ts: 'x' } } }),
    )
    const state = await loadDreamingState(agentDir)
    expect(state).toEqual(emptyState())
  })

  test('round-trips a valid state through save and load', async () => {
    const next = setDreamedLines(emptyState(), '2026-04-27', 42, '2026-04-27T16:09:00+09:00')
    await saveDreamingState(agentDir, next)

    const loaded = await loadDreamingState(agentDir)
    expect(loaded.dreamedThrough['2026-04-27']).toEqual({ lines: 42, ts: '2026-04-27T16:09:00+09:00' })
  })

  test('saveDreamingState creates the memory directory if missing', async () => {
    const state = setDreamedLines(emptyState(), '2026-04-27', 1, 'now')
    await saveDreamingState(agentDir, state)

    const loaded = await loadDreamingState(agentDir)
    expect(loaded).toEqual(state)
  })
})

describe('getDreamedLines', () => {
  test('returns 0 for a date with no watermark (treat as fully undreamed)', () => {
    expect(getDreamedLines(emptyState(), '2026-04-27')).toBe(0)
  })

  test('returns the recorded line count for a date with a watermark', () => {
    const state = setDreamedLines(emptyState(), '2026-04-27', 99, 'now')
    expect(getDreamedLines(state, '2026-04-27')).toBe(99)
  })
})

describe('setDreamedLines', () => {
  test('does not mutate the input state (returns a new object)', () => {
    const before = emptyState()
    const after = setDreamedLines(before, '2026-04-27', 5, 'now')
    expect(before.dreamedThrough).toEqual({})
    expect(after.dreamedThrough['2026-04-27']?.lines).toBe(5)
  })

  test('overwrites a prior watermark for the same date (a later run advances)', () => {
    let state = setDreamedLines(emptyState(), '2026-04-27', 5, 't1')
    state = setDreamedLines(state, '2026-04-27', 10, 't2')
    expect(state.dreamedThrough['2026-04-27']).toEqual({ lines: 10, ts: 't2' })
  })

  test('preserves watermarks for other dates', () => {
    let state = setDreamedLines(emptyState(), '2026-04-26', 3, 't1')
    state = setDreamedLines(state, '2026-04-27', 7, 't2')
    expect(state.dreamedThrough['2026-04-26']?.lines).toBe(3)
    expect(state.dreamedThrough['2026-04-27']?.lines).toBe(7)
  })
})
