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

// openItem now returns { result, endedWritableSession? }. wrap() is the common
// "ordinary back/done" case; wrapWritable() marks a tui-style writable detach.
const wrap = (result: RunInspectResult): { result: RunInspectResult } => ({ result })
const wrapWritable = (result: RunInspectResult): { result: RunInspectResult; endedWritableSession: boolean } => ({
  result,
  endedWritableSession: result.ok && result.escToPicker === true,
})

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
        return wrap(done)
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
        return wrap(opened.length === 1 ? back : done)
      },
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(result).toEqual(done)
    expect(pickerCalls).toBe(2)
    expect(opened).toEqual(['a', 'b'])
  })

  test('allowWritable flips false after a writable (tui) detach', async () => {
    // Regression: detaching from a tui (live) row ends the session, so the next
    // list refresh must not re-promote the now-dead session as writable.
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
      openItem: async () => (pickerCalls === 1 ? wrapWritable(back) : wrap(done)),
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(allowWritableCalls).toEqual([true, false])
  })

  test('allowWritable stays true after leaving logs or a read-only transcript (no live session ended)', async () => {
    // Esc from logs / read-only must NOT disable the writable row: those viewers
    // do not touch the live TUI session.
    const allowWritableCalls: boolean[] = []
    let pickerCalls = 0

    await runViewerLoop<FakeItem>({
      listItems: async ({ allowWritable }) => {
        allowWritableCalls.push(allowWritable)
        return [
          { key: 'logs', kind: 'logs' },
          { key: 'a', kind: 'session' },
        ]
      },
      keyOf: (i) => i.key,
      selectItem: async (items) => {
        pickerCalls++
        return items[pickerCalls - 1] ?? null
      },
      // First open (logs) returns back WITHOUT endedWritableSession; second ends.
      openItem: async () => (pickerCalls === 1 ? wrap(back) : wrap(done)),
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(allowWritableCalls).toEqual([true, true])
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
        return wrap(done)
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
      openItem: async () => wrap(done),
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
      openItem: async () => wrap(done),
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
      openItem: async () => wrap({ ok: false, exitCode: 2, reason: 'boom' }),
      createTailScope: () => fakeScope(),
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    expect(result).toEqual({ ok: false, exitCode: 2, reason: 'boom' })
  })
})
