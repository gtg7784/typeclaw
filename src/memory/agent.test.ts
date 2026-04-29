import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { invokeSubagent } from '@/agent/subagents'
import { formatLocalDate } from '@/shared'

import {
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  memoryLoggerSubagent,
  type MemoryLoggerPayload,
} from './agent'
import { appendTool } from './append-tool'

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

describe('memory module', () => {
  test('exposes an `append` tool (not a `write` tool)', () => {
    expect(appendTool.name).toBe('append')
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
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(
      /two or more separate occurrences|≥2.*sources|two.*sources/,
    )
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
})

describe('memoryLoggerSubagent', () => {
  test('declares the memory-logger system prompt', () => {
    expect(memoryLoggerSubagent.systemPrompt).toBe(MEMORY_LOGGER_SYSTEM_PROMPT)
  })

  test('declares the read tool and the append custom tool', () => {
    expect(memoryLoggerSubagent.customTools).toEqual([appendTool])
    expect(memoryLoggerSubagent.tools).toBeDefined()
    expect(memoryLoggerSubagent.tools!.length).toBe(1)
  })

  test('rejects an invalid payload via payloadSchema', async () => {
    // when / then
    await expect(
      invokeSubagent('memory-logger', {
        registry: { 'memory-logger': memoryLoggerSubagent },
        createSessionForSubagent: async () => ({}) as AgentSession,
        agentDir: '/tmp',
        userPrompt: '',
        payload: { wrong: 'shape' },
      }),
    ).rejects.toThrow(/invalid payload/)
  })

  test('handler builds an initial prompt mentioning transcript, session id, and stream file', async () => {
    // given
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const promptCalls: string[] = []
    const session = {
      prompt: async (text: string) => {
        promptCalls.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession

    // when
    await invokeSubagent('memory-logger', {
      registry: { 'memory-logger': memoryLoggerSubagent },
      createSessionForSubagent: async () => session,
      agentDir,
      userPrompt: 'unused',
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    })

    // then
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]!).toContain(transcript)
    expect(promptCalls[0]!).toContain('ses_abc')
    expect(promptCalls[0]!).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/)
  })

  test('handler includes the watermark when one exists in the daily stream', async () => {
    // given
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = formatLocalDate()
    writeFileSync(
      join(agentDir, 'memory', `${today}.md`),
      ['<!-- fragment source=ses_abc entry=watermrk -->', '## prior', 'body', ''].join('\n'),
    )
    const promptCalls: string[] = []
    const session = {
      prompt: async (text: string) => {
        promptCalls.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession

    // when
    await invokeSubagent('memory-logger', {
      registry: { 'memory-logger': memoryLoggerSubagent },
      createSessionForSubagent: async () => session,
      agentDir,
      userPrompt: 'unused',
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    })

    // then
    expect(promptCalls[0]!).toContain('watermrk')
  })

  test('handler instructs to advance the watermark even when nothing is worth remembering', async () => {
    // given
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const promptCalls: string[] = []
    const session = {
      prompt: async (text: string) => {
        promptCalls.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession

    // when
    await invokeSubagent('memory-logger', {
      registry: { 'memory-logger': memoryLoggerSubagent },
      createSessionForSubagent: async () => session,
      agentDir,
      userPrompt: '',
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    })

    // then
    expect(promptCalls[0]!.toLowerCase()).toMatch(/bare watermark|advance the watermark/)
  })

  test('handler indicates "no prior watermark" when none exists', async () => {
    // given
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const promptCalls: string[] = []
    const session = {
      prompt: async (text: string) => {
        promptCalls.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession

    // when
    await invokeSubagent('memory-logger', {
      registry: { 'memory-logger': memoryLoggerSubagent },
      createSessionForSubagent: async () => session,
      agentDir,
      userPrompt: '',
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    })

    // then
    expect(promptCalls[0]!.toLowerCase()).toMatch(/no.*watermark|no prior|first time|begin/)
  })

  test('disposes the session even when the underlying prompt throws', async () => {
    // given
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    let disposed = false
    const session = {
      prompt: async () => {
        throw new Error('llm exploded')
      },
      dispose: () => {
        disposed = true
      },
    } as unknown as AgentSession

    // when / then
    await expect(
      invokeSubagent('memory-logger', {
        registry: { 'memory-logger': memoryLoggerSubagent },
        createSessionForSubagent: async () => session,
        agentDir,
        userPrompt: '',
        payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      }),
    ).rejects.toThrow('llm exploded')
    expect(disposed).toBe(true)
  })
})
