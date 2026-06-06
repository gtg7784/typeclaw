import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import { LiveSubagentRegistry } from './live-subagents'
import { beginSubagentDrainWatch, runSubagentDrain, type SubagentBackgroundDrain } from './subagent-drain'

const PARENT = 'ses_subagent'

function noopAbort(): Promise<void> {
  return Promise.resolve()
}

function registerChild(reg: LiveSubagentRegistry, taskId: string): void {
  reg.register({
    taskId,
    sessionId: `ses_${taskId}`,
    subagentName: 'scout',
    parentSessionId: PARENT,
    background: true,
    startedAt: 0,
    status: 'running',
    abort: noopAbort,
  })
}

function registerSyncChild(reg: LiveSubagentRegistry, taskId: string): void {
  reg.register({
    taskId,
    sessionId: `ses_${taskId}`,
    subagentName: 'scout',
    parentSessionId: PARENT,
    background: false,
    startedAt: 0,
    status: 'running',
    abort: noopAbort,
  })
}

function makeDrain(): { drain: SubagentBackgroundDrain; reg: LiveSubagentRegistry } {
  const reg = new LiveSubagentRegistry()
  const drain: SubagentBackgroundDrain = { stream: createStream(), sessionId: PARENT, liveRegistry: reg }
  return { drain, reg }
}

describe('runSubagentDrain — termination', () => {
  test('returns immediately when the subagent has no children', async () => {
    const { drain } = makeDrain()
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []

    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('delivers one reminder per already-completed child, then terminates', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_a')
    registerChild(reg, 'bg_b')
    reg.recordCompletion('bg_a', { ok: true, durationMs: 100, finalMessage: 'A done' })
    reg.recordCompletion('bg_b', { ok: true, durationMs: 200, finalMessage: 'B done' })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.length).toBe(2)
    expect(prompts.some((p) => p.includes('bg_a'))).toBe(true)
    expect(prompts.some((p) => p.includes('bg_b'))).toBe(true)
  })

  test('does not deliver a reminder for the same child twice', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_a')
    reg.recordCompletion('bg_a', { ok: true, durationMs: 100 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.filter((p) => p.includes('bg_a')).length).toBe(1)
  })

  test('a child still running blocks termination until it completes (wakeup-driven)', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_slow')

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    // Loop should be parked on waitForWakeup (no completed children yet).
    await new Promise((r) => setTimeout(r, 5))
    expect(prompts).toEqual([])

    // Complete the child and fire the broadcast wakeup.
    reg.recordCompletion('bg_slow', { ok: true, durationMs: 300 })
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_slow',
        subagent: 'scout',
        parentSessionId: PARENT,
        ok: true,
        durationMs: 300,
      },
    })

    await done
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_slow')
  })

  test('lost-wakeup race: child completes BEFORE the loop waits, still terminates', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_race')

    // Watch subscribes first (this is the contract).
    const watch = beginSubagentDrainWatch(drain)

    // Child completes + broadcast fires BEFORE runSubagentDrain is even called —
    // simulating a completion that lands while the subagent was mid initial-prompt.
    reg.recordCompletion('bg_race', { ok: true, durationMs: 50 })
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_race',
        subagent: 'scout',
        parentSessionId: PARENT,
        ok: true,
        durationMs: 50,
      },
    })

    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    // The completed child is found by the first snapshot; loop delivers and exits.
    expect(prompts.length).toBe(1)
  })

  test('ignores completions for other parents', async () => {
    const { drain, reg } = makeDrain()
    reg.register({
      taskId: 'bg_other',
      sessionId: 'ses_other',
      subagentName: 'scout',
      parentSessionId: 'ses_someone_else',
      startedAt: 0,
      status: 'running',
      abort: noopAbort,
    })
    reg.recordCompletion('bg_other', { ok: true, durationMs: 10 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('a child spawned during a reminder turn keeps the loop alive', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_1')
    reg.recordCompletion('bg_1', { ok: true, durationMs: 10 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => {
        prompts.push(t)
        // On the first reminder turn, the model spawns a new completed child.
        if (t.includes('bg_1') && reg.get('bg_2') === undefined) {
          registerChild(reg, 'bg_2')
          reg.recordCompletion('bg_2', { ok: true, durationMs: 20 })
        }
      },
    })

    expect(prompts.length).toBe(2)
    expect(prompts.some((p) => p.includes('bg_2'))).toBe(true)
  })

  test('cancellation stops the loop before delivering more reminders', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_a')
    registerChild(reg, 'bg_b')
    reg.recordCompletion('bg_a', { ok: true, durationMs: 10 })
    reg.recordCompletion('bg_b', { ok: true, durationMs: 10 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    let cancel = false
    await runSubagentDrain(watch, {
      drain,
      cancelled: () => cancel,
      prompt: async (t) => {
        prompts.push(t)
        cancel = true
      },
    })

    expect(prompts.length).toBe(1)
  })

  test('does NOT re-prompt for synchronous children (their result returned inline)', async () => {
    const { drain, reg } = makeDrain()
    registerSyncChild(reg, 'sync_a')
    registerSyncChild(reg, 'sync_b')
    reg.recordCompletion('sync_a', { ok: true, durationMs: 10, finalMessage: 'A inline' })
    reg.recordCompletion('sync_b', { ok: true, durationMs: 10, finalMessage: 'B inline' })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('drains only background children, ignoring completed sync siblings', async () => {
    const { drain, reg } = makeDrain()
    registerSyncChild(reg, 'sync_done')
    registerChild(reg, 'bg_done')
    reg.recordCompletion('sync_done', { ok: true, durationMs: 10 })
    reg.recordCompletion('bg_done', { ok: true, durationMs: 20 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_done')
    expect(prompts.some((p) => p.includes('sync_done'))).toBe(false)
  })

  test('a running sync child does not block termination', async () => {
    const { drain, reg } = makeDrain()
    registerSyncChild(reg, 'sync_running')

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('delivers a FAILED reminder for a failed child', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_fail')
    reg.recordCompletion('bg_fail', { ok: false, durationMs: 10, error: 'boom' })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('FAILED')
    expect(prompts[0]).toContain('boom')
  })
})
