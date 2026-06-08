import { describe, expect, test } from 'bun:test'

import { type CountStoreIO, createCountStore, progressFingerprint, reconcile } from './count-state'
import type { CronJob } from './schema'

function memoryIO(): CountStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => {
      files.set(path, data)
    },
  }
}

const job = (id: string, extra: Partial<CronJob> = {}): CronJob =>
  ({
    id,
    schedule: '0 9 * * *',
    enabled: true,
    kind: 'prompt',
    prompt: `run ${id}`,
    count: 3,
    ...extra,
  }) as CronJob

describe('createCountStore', () => {
  test('starts a fresh job at zero', async () => {
    const store = await createCountStore('/agent', [job('a')], memoryIO())
    expect(store.get('a')).toBe(0)
  })

  test('increment persists and is reflected in get', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)

    await store.increment('a', job('a'), Date.now())
    await store.increment('a', job('a'), Date.now())

    expect(store.get('a')).toBe(2)
  })

  test('progress survives a reload (new store reads the persisted count)', async () => {
    const io = memoryIO()
    const first = await createCountStore('/agent', [job('a')], io)
    await first.increment('a', job('a'), Date.now())
    await first.increment('a', job('a'), Date.now())

    const second = await createCountStore('/agent', [job('a')], io)
    expect(second.get('a')).toBe(2)
  })

  test('serializes concurrent increments without losing writes', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)

    await Promise.all([
      store.increment('a', job('a'), Date.now()),
      store.increment('a', job('a'), Date.now()),
      store.increment('a', job('a'), Date.now()),
    ])

    expect(store.get('a')).toBe(3)
  })
})

describe('reconcile', () => {
  test('drops state for a job id no longer present', () => {
    const state = { version: 1 as const, jobs: { gone: { progressFingerprint: 'x', firedCount: 2, updatedAt: 'now' } } }
    const result = reconcile(state, [job('survivor')])
    expect(result.jobs.gone).toBeUndefined()
  })

  test('drops state for a job that lost its count', () => {
    const counted = job('a')
    const state = {
      version: 1 as const,
      jobs: { a: { progressFingerprint: progressFingerprint(counted), firedCount: 2, updatedAt: 'now' } },
    }
    const result = reconcile(state, [job('a', { count: undefined })])
    expect(result.jobs.a).toBeUndefined()
  })

  test('resets progress when the recurrence fingerprint changes', () => {
    const original = job('a')
    const state = {
      version: 1 as const,
      jobs: { a: { progressFingerprint: progressFingerprint(original), firedCount: 2, updatedAt: 'now' } },
    }
    const result = reconcile(state, [job('a', { schedule: '0 18 * * *' })])
    expect(result.jobs.a).toBeUndefined()
  })

  test('preserves progress when only count changes (3 -> 5 resumes)', () => {
    const original = job('a', { count: 3 })
    const state = {
      version: 1 as const,
      jobs: { a: { progressFingerprint: progressFingerprint(original), firedCount: 3, updatedAt: 'now' } },
    }
    const result = reconcile(state, [job('a', { count: 5 })])
    expect(result.jobs.a?.firedCount).toBe(3)
  })

  test('a re-added id with a different target does NOT inherit the stale counter', () => {
    const old = job('reminder', { prompt: 'old reminder' })
    const state = {
      version: 1 as const,
      jobs: { reminder: { progressFingerprint: progressFingerprint(old), firedCount: 3, updatedAt: 'now' } },
    }
    const result = reconcile(state, [job('reminder', { prompt: 'brand new reminder' })])
    expect(result.jobs.reminder).toBeUndefined()
  })
})
