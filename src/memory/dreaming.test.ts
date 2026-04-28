import { describe, expect, test } from 'bun:test'

import { createDreamingSpawner, type DreamingSession, isDreamingPayload } from './dreaming'

describe('isDreamingPayload', () => {
  test('accepts a payload with agentDir', () => {
    expect(isDreamingPayload({ agentDir: '/some/path' })).toBe(true)
  })

  test('rejects null', () => {
    expect(isDreamingPayload(null)).toBe(false)
  })

  test('rejects an empty agentDir', () => {
    expect(isDreamingPayload({ agentDir: '' })).toBe(false)
  })

  test('rejects a non-string agentDir', () => {
    expect(isDreamingPayload({ agentDir: 42 })).toBe(false)
  })

  test('rejects a missing agentDir', () => {
    expect(isDreamingPayload({})).toBe(false)
  })
})

describe('createDreamingSpawner', () => {
  function fakeSession(): DreamingSession & { prompts: string[]; disposed: boolean } {
    const prompts: string[] = []
    let disposed = false
    return {
      prompts,
      get disposed() {
        return disposed
      },
      prompt: async (text) => {
        prompts.push(text)
      },
      dispose: () => {
        disposed = true
      },
    }
  }

  test('throws when payload is invalid', async () => {
    const spawner = createDreamingSpawner({ createDreamingSession: async () => fakeSession() })
    await expect(spawner({ agentDir: '' }, 'dreaming')).rejects.toThrow(/invalid payload/)
  })

  test('prompts the session with an agent-folder-aware initial prompt and disposes the session', async () => {
    const session = fakeSession()
    const spawner = createDreamingSpawner({ createDreamingSession: async () => session })

    await spawner({ agentDir: '/agents/coder' }, 'dreaming')

    expect(session.prompts).toHaveLength(1)
    expect(session.prompts[0]).toContain('/agents/coder')
    expect(session.prompts[0]).toContain('MEMORY.md')
    expect(session.prompts[0]).toMatch(/memory[/\\]/)
    expect(session.disposed).toBe(true)
  })

  test('disposes the session even when prompt() throws', async () => {
    let disposed = false
    const session: DreamingSession = {
      prompt: async () => {
        throw new Error('LLM blew up')
      },
      dispose: () => {
        disposed = true
      },
    }
    const spawner = createDreamingSpawner({ createDreamingSession: async () => session })

    await expect(spawner({ agentDir: '/agents/coder' }, 'dreaming')).rejects.toThrow(/LLM blew up/)
    expect(disposed).toBe(true)
  })
})
