import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryLoggerSpawner, isMemoryLoggerPayload, type MemoryLoggerPayload } from './agent'

type FakeSession = {
  prompt: (text: string) => Promise<void>
  dispose: () => void
}

type SpawnRecord = {
  config: {
    tools: unknown
    systemPrompt: string
    sessionManager: unknown
  }
  promptText: string
  disposed: boolean
}

function makeFakeSessionFactory() {
  const records: SpawnRecord[] = []
  const sessionsCreated: FakeSession[] = []
  const factory = async (cfg: { tools: unknown; systemPrompt: string; sessionManager: unknown }) => {
    const record: SpawnRecord = { config: cfg, promptText: '', disposed: false }
    const session: FakeSession = {
      prompt: async (text) => {
        record.promptText = text
      },
      dispose: () => {
        record.disposed = true
      },
    }
    records.push(record)
    sessionsCreated.push(session)
    return session
  }
  return { factory, records, sessionsCreated }
}

function makeAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-agent-'))
  mkdirSync(join(root, 'memory'))
  mkdirSync(join(root, 'sessions'))
  return root
}

describe('isMemoryLoggerPayload', () => {
  test('accepts a valid payload', () => {
    const valid: MemoryLoggerPayload = {
      parentSessionId: 'ses_abc',
      parentTranscriptPath: '/path/to/file.jsonl',
      agentDir: '/path/to/agent',
    }
    expect(isMemoryLoggerPayload(valid)).toBe(true)
  })

  test('rejects null and non-objects', () => {
    expect(isMemoryLoggerPayload(null)).toBe(false)
    expect(isMemoryLoggerPayload(undefined)).toBe(false)
    expect(isMemoryLoggerPayload('string')).toBe(false)
    expect(isMemoryLoggerPayload(42)).toBe(false)
  })

  test('rejects when fields are missing or wrong type', () => {
    expect(isMemoryLoggerPayload({})).toBe(false)
    expect(isMemoryLoggerPayload({ parentSessionId: 'a', parentTranscriptPath: 'b' })).toBe(false)
    expect(isMemoryLoggerPayload({ parentSessionId: 'a', parentTranscriptPath: 'b', agentDir: 42 })).toBe(false)
  })

  test('rejects empty string fields', () => {
    expect(isMemoryLoggerPayload({ parentSessionId: '', parentTranscriptPath: 'b', agentDir: 'c' })).toBe(false)
  })
})

describe('createMemoryLoggerSpawner', () => {
  test('spawns a session with read+write tools and an in-memory SessionManager', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    expect(records).toHaveLength(1)
    const tools = records[0]!.config.tools as Array<{ name: string }>
    const toolNames = tools.map((t) => t.name).sort()
    expect(toolNames).toEqual(['read', 'write'])
  })

  test('the initial prompt mentions parent transcript path, session id, and target stream file', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    const prompt = records[0]!.promptText
    expect(prompt).toContain(transcript)
    expect(prompt).toContain('ses_abc')
    expect(prompt).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/)
  })

  test('the initial prompt includes the watermark when one exists', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = new Date().toISOString().slice(0, 10)
    const streamFile = join(agentDir, 'memory', `${today}.md`)
    writeFileSync(streamFile, ['<!-- fragment source=ses_abc entry=watermrk -->', '## prior', 'body', ''].join('\n'))

    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    expect(records[0]!.promptText).toContain('watermrk')
  })

  test('the initial prompt instructs to advance the watermark even when nothing is worth remembering', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })
    await spawner(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      'memory-logger',
    )

    const prompt = records[0]!.promptText
    expect(prompt.toLowerCase()).toMatch(/bare watermark|advance the watermark/)
  })

  test('the initial prompt indicates "no prior watermark" when none exists', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    const prompt = records[0]!.promptText
    expect(prompt.toLowerCase()).toMatch(/no.*watermark|no prior|first time|begin/)
  })

  test('throws on invalid payload', async () => {
    const { factory } = makeFakeSessionFactory()
    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })

    await expect(spawner({ wrong: 'shape' }, 'memory-logger')).rejects.toThrow()
    await expect(spawner(null, 'memory-logger')).rejects.toThrow()
  })

  test('disposes the session even when prompt throws', async () => {
    const records: SpawnRecord[] = []
    const factory = async (cfg: { tools: unknown; systemPrompt: string; sessionManager: unknown }) => {
      const record: SpawnRecord = { config: cfg, promptText: '', disposed: false }
      records.push(record)
      return {
        prompt: async () => {
          throw new Error('llm exploded')
        },
        dispose: () => {
          record.disposed = true
        },
      }
    }
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createSubagentSession: factory })

    await expect(
      spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger'),
    ).rejects.toThrow('llm exploded')

    expect(records[0]!.disposed).toBe(true)
  })
})
