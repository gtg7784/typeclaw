import { describe, expect, test } from 'bun:test'

import type { RunInspectResult } from './index'
import { runViewerLoop, type TailController } from './loop'

type FakeItem = { key: string; kind: 'session' | 'tui' | 'logs' }

function fakeScope(onDispose?: () => void): TailController {
  const ctrl = new AbortController()
  return {
    signal: ctrl.signal,
    intent: () => null,
    dispose: () => {
      onDispose?.()
      ctrl.abort()
    },
  }
}

const back: RunInspectResult = { ok: true, exitCode: 0, escToPicker: true }
const done: RunInspectResult = { ok: true, exitCode: 0 }

describe('runViewerLoop', () => {
  test('opens the preselected item directly, skipping the picker', async () => {
    let pickerCalls = 0
    const opened: string[] = []

    const result = await runViewerLoop<FakeItem>({
      listItems: async () => [
        { key: 'a', kind: 'session' },
        { key: 'logs', kind: 'logs' },
      ],
      keyOf: (i) => i.key,
      preselectKey: 'logs',
      selectItem: async () => {
        pickerCalls++
        return null
      },
      openItem: async (item) => {
        opened.push(item.key)
        return done
      },
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(result).toEqual(done)
    expect(pickerCalls).toBe(0)
    expect(opened).toEqual(['logs'])
  })

  test('back (escToPicker) re-opens the picker; second selection runs and ends', async () => {
    let pickerCalls = 0
    const opened: string[] = []

    const result = await runViewerLoop<FakeItem>({
      listItems: async () => [
        { key: 'a', kind: 'session' },
        { key: 'b', kind: 'session' },
      ],
      keyOf: (i) => i.key,
      selectItem: async (items) => {
        pickerCalls++
        return items[pickerCalls - 1] ?? null
      },
      openItem: async (item) => {
        opened.push(item.key)
        return opened.length === 1 ? back : done
      },
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(result).toEqual(done)
    expect(pickerCalls).toBe(2)
    expect(opened).toEqual(['a', 'b'])
  })

  test('listItems gets allowWritable:true first, then false after returning to the picker', async () => {
    // Regression: after detaching from a tui (live) row, the next list refresh
    // must not re-promote the now-dead session as writable.
    const allowWritableCalls: boolean[] = []
    let pickerCalls = 0

    await runViewerLoop<FakeItem>({
      listItems: async ({ allowWritable }) => {
        allowWritableCalls.push(allowWritable)
        return [
          { key: 'live', kind: 'tui' },
          { key: 'b', kind: 'session' },
        ]
      },
      keyOf: (i) => i.key,
      selectItem: async (items) => {
        pickerCalls++
        return items[pickerCalls - 1] ?? null
      },
      openItem: async () => (pickerCalls === 1 ? back : done),
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(allowWritableCalls).toEqual([true, false])
  })

  test('the tui branch does not create a tail scope (no double raw-stdin owner)', async () => {
    let tailScopesCreated = 0

    await runViewerLoop<FakeItem>({
      listItems: async () => [{ key: 'live', kind: 'tui' }],
      keyOf: (i) => i.key,
      preselectKey: 'live',
      selectItem: async () => null,
      openItem: async (item, ctx) => {
        // A real tui opener never touches ctx.createTailScope; assert the loop
        // does not force one on the branch.
        if (item.kind === 'session' || item.kind === 'logs') ctx.createTailScope()
        return done
      },
      createTailScope: () => {
        tailScopesCreated++
        return fakeScope()
      },
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(tailScopesCreated).toBe(0)
  })

  test('picker cancel returns exit code 130', async () => {
    const result = await runViewerLoop<FakeItem>({
      listItems: async () => [{ key: 'a', kind: 'session' }],
      keyOf: (i) => i.key,
      selectItem: async () => null,
      openItem: async () => done,
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.exitCode).toBe(130)
  })

  test('empty list returns the onEmpty result', async () => {
    const result = await runViewerLoop<FakeItem>({
      listItems: async () => [],
      keyOf: (i) => i.key,
      selectItem: async () => null,
      openItem: async () => done,
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'no sessions' }),
    })

    expect(result).toEqual({ ok: false, exitCode: 1, reason: 'no sessions' })
  })

  test('a non-ok open result short-circuits the loop', async () => {
    const result = await runViewerLoop<FakeItem>({
      listItems: async () => [{ key: 'a', kind: 'session' }],
      keyOf: (i) => i.key,
      preselectKey: 'a',
      selectItem: async () => null,
      openItem: async () => ({ ok: false, exitCode: 2, reason: 'boom' }),
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(result).toEqual({ ok: false, exitCode: 2, reason: 'boom' })
  })
})
