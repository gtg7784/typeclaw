import { describe, expect, test } from 'bun:test'

import { checkpointFromSelections, type WizardCheckpointStore } from './checkpoint'
import { detectInitProgress } from './progress'

function fakeStore(initial?: ReturnType<typeof checkpointFromSelections>): WizardCheckpointStore {
  let current = initial
  return {
    load: async () => current,
    save: async (_cwd, checkpoint) => {
      current = checkpoint
    },
    clear: async () => {
      current = undefined
    },
  }
}

describe('detectInitProgress', () => {
  test('reports none when no checkpoint exists', async () => {
    const status = await detectInitProgress({
      cwd: '/agent',
      checkpointStore: fakeStore(),
      isHatched: async () => false,
    })
    expect(status.kind).toBe('none')
  })

  test('reports incomplete when a checkpoint exists and the agent is not hatched', async () => {
    const checkpoint = checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' })
    const status = await detectInitProgress({
      cwd: '/agent',
      checkpointStore: fakeStore(checkpoint),
      isHatched: async () => false,
    })
    expect(status.kind).toBe('incomplete')
    if (status.kind === 'incomplete') expect(status.checkpoint).toEqual(checkpoint)
  })

  test('reports complete-stale-checkpoint when a checkpoint outlives a hatched agent', async () => {
    const checkpoint = checkpointFromSelections({ cwd: '/agent', vendorId: 'fireworks' })
    const status = await detectInitProgress({
      cwd: '/agent',
      checkpointStore: fakeStore(checkpoint),
      isHatched: async () => true,
    })
    expect(status.kind).toBe('complete-stale-checkpoint')
    if (status.kind === 'complete-stale-checkpoint') expect(status.checkpoint).toEqual(checkpoint)
  })

  test('does not consult isHatched when there is no checkpoint', async () => {
    let consulted = false
    const status = await detectInitProgress({
      cwd: '/agent',
      checkpointStore: fakeStore(),
      isHatched: async () => {
        consulted = true
        return false
      },
    })
    expect(status.kind).toBe('none')
    expect(consulted).toBe(false)
  })
})
