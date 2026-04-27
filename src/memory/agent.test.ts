import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMemoryLoggerSpawner,
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  type MemoryLoggerPayload,
  type MemoryLoggerSession,
} from './agent'
import { appendTool } from './append-tool'

type SpawnRecord = {
  promptText: string
  disposed: boolean
}

function makeFakeSessionFactory(): {
  factory: () => Promise<MemoryLoggerSession>
  records: SpawnRecord[]
} {
  const records: SpawnRecord[] = []
  const factory = async (): Promise<MemoryLoggerSession> => {
    const record: SpawnRecord = { promptText: '', disposed: false }
    records.push(record)
    return {
      prompt: async (text: string) => {
        record.promptText = text
      },
      dispose: () => {
        record.disposed = true
      },
    }
  }
  return { factory, records }
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
  test('the memory module exposes an `append` tool (not a `write` tool)', () => {
    expect(appendTool.name).toBe('append')
  })

  test('the initial prompt mentions parent transcript path, session id, and target stream file', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })
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

    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    expect(records[0]!.promptText).toContain('watermrk')
  })

  test('the initial prompt instructs to advance the watermark even when nothing is worth remembering', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    const prompt = records[0]!.promptText
    expect(prompt.toLowerCase()).toMatch(/bare watermark|advance the watermark/)
  })

  test('the initial prompt mentions the certainty discipline at a summary level', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    const prompt = records[0]!.promptText
    expect(prompt).toMatch(/explicit/i)
    expect(prompt).toMatch(/inductive/i)
  })
})

describe('MEMORY_LOGGER_SYSTEM_PROMPT', () => {
  test('defines the three certainty levels', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('certainty=explicit')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('certainty=deductive')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('certainty=inductive')
  })

  test('requires verbatim quotes for explicit fragments', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('verbatim quote')
  })

  test('requires two or more sources for inductive fragments', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/two or more separate occurrences|≥2.*sources|two.*sources/)
  })

  test('bans speculation language explicitly by listing the forbidden words', () => {
    const banned = ['likely', 'probably', 'enjoys', 'loves', 'tends to', 'is interested in']
    for (const word of banned) {
      expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain(word)
    }
  })

  test('states the default-skip stance', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/default is to write nothing|bar is high/)
  })

  test('states that the marker format requires a certainty attribute', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/fragment source=.+ entry=.+ certainty=/)
  })

  test('the initial prompt indicates "no prior watermark" when none exists', async () => {
    const { factory, records } = makeFakeSessionFactory()
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })
    await spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger')

    const prompt = records[0]!.promptText
    expect(prompt.toLowerCase()).toMatch(/no.*watermark|no prior|first time|begin/)
  })

  test('throws on invalid payload', async () => {
    const { factory } = makeFakeSessionFactory()
    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })

    await expect(spawner({ wrong: 'shape' }, 'memory-logger')).rejects.toThrow()
    await expect(spawner(null, 'memory-logger')).rejects.toThrow()
  })

  test('disposes the session even when prompt throws', async () => {
    const records: SpawnRecord[] = []
    const factory = async (): Promise<MemoryLoggerSession> => {
      const record: SpawnRecord = { promptText: '', disposed: false }
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

    const spawner = createMemoryLoggerSpawner({ createMemoryLoggerSession: factory })

    await expect(
      spawner({ parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir }, 'memory-logger'),
    ).rejects.toThrow('llm exploded')

    expect(records[0]!.disposed).toBe(true)
  })
})
