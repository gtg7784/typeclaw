import { describe, expect, test } from 'bun:test'

import { checkpointFromSelections, type WizardCheckpointStore } from '@/init/checkpoint'
import type { InitProgressStatus } from '@/init/progress'

import { guardIncompleteInit, resolveIncompleteInitDecision } from './incomplete-init'

const incomplete: InitProgressStatus = {
  kind: 'incomplete',
  checkpoint: checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }),
}
const stale: InitProgressStatus = {
  kind: 'complete-stale-checkpoint',
  checkpoint: checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }),
}
const none: InitProgressStatus = { kind: 'none' }

function fakeStore(initial?: ReturnType<typeof checkpointFromSelections>): {
  store: WizardCheckpointStore
  cleared: () => boolean
} {
  let current = initial
  let cleared = false
  return {
    store: {
      load: async () => current,
      save: async (_cwd, checkpoint) => {
        current = checkpoint
      },
      clear: async () => {
        current = undefined
        cleared = true
      },
    },
    cleared: () => cleared,
  }
}

describe('resolveIncompleteInitDecision', () => {
  test('continue when no checkpoint', () => {
    expect(resolveIncompleteInitDecision(none, true).kind).toBe('continue')
    expect(resolveIncompleteInitDecision(none, false).kind).toBe('continue')
  })

  test('continue when checkpoint is stale on a hatched agent', () => {
    expect(resolveIncompleteInitDecision(stale, true).kind).toBe('continue')
    expect(resolveIncompleteInitDecision(stale, false).kind).toBe('continue')
  })

  test('prompt when incomplete and interactive', () => {
    expect(resolveIncompleteInitDecision(incomplete, true).kind).toBe('prompt')
  })

  test('block when incomplete and non-interactive', () => {
    const decision = resolveIncompleteInitDecision(incomplete, false)
    expect(decision.kind).toBe('block')
    if (decision.kind === 'block') {
      expect(decision.message).toContain('typeclaw init')
    }
  })
})

describe('guardIncompleteInit', () => {
  test('continues when there is no checkpoint', async () => {
    const { store } = fakeStore()
    const result = await guardIncompleteInit({
      cwd: '/agent',
      interactive: true,
      confirmContinue: async () => true,
      checkpointStore: store,
    })
    expect(result.action).toBe('continue')
  })

  test('blocks a non-interactive run with actionable guidance', async () => {
    const { store } = fakeStore(checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }))
    const result = await guardIncompleteInit({
      cwd: '/agent',
      interactive: false,
      confirmContinue: async () => true,
      checkpointStore: store,
    })
    expect(result.action).toBe('block')
    if (result.action === 'block') expect(result.message).toContain('typeclaw init')
  })

  test('prompts interactively and continues when the user agrees', async () => {
    const { store } = fakeStore(checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }))
    let prompted = false
    const result = await guardIncompleteInit({
      cwd: '/agent',
      interactive: true,
      confirmContinue: async () => {
        prompted = true
        return true
      },
      checkpointStore: store,
    })
    expect(prompted).toBe(true)
    expect(result.action).toBe('continue')
  })

  test('aborts interactively when the user declines', async () => {
    const { store } = fakeStore(checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }))
    const result = await guardIncompleteInit({
      cwd: '/agent',
      interactive: true,
      confirmContinue: async () => false,
      checkpointStore: store,
    })
    expect(result.action).toBe('abort')
  })

  test('opportunistically clears a stale checkpoint on a hatched agent and continues', async () => {
    const fake = fakeStore(checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }))
    const result = await guardIncompleteInit({
      cwd: '/agent',
      interactive: false,
      confirmContinue: async () => false,
      checkpointStore: fake.store,
      detectProgress: async () => stale,
    })
    expect(result.action).toBe('continue')
    expect(fake.cleared()).toBe(true)
  })

  test('does not clear the checkpoint on the incomplete path', async () => {
    const fake = fakeStore(checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' }))
    await guardIncompleteInit({
      cwd: '/agent',
      interactive: true,
      confirmContinue: async () => true,
      checkpointStore: fake.store,
      detectProgress: async () => incomplete,
    })
    expect(fake.cleared()).toBe(false)
  })
})
