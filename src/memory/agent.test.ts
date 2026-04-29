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
  test('declares the fragment marker format with source and entry attributes', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/<!-- fragment source=.+ entry=.+ -->/)
  })

  test('requires the Claim / Evidence / Implication body structure', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('**Claim:**')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('**Evidence:**')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('**Implication:**')
  })

  test('makes Implication a hard gate (no Implication, no fragment)', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/implication.*drop it|no implication|behavior-changing/)
  })

  test('instructs the writer to read existing memory before writing', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/read.*MEMORY\.md/i)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('dedupe')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('strengthen')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('contradict')
  })

  test('frames both over-writing and under-writing as failure modes', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('over-writing')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('under-writing')
  })

  test('requires that evidence accompanies every claim', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/evidence is mandatory|no claim without evidence/)
  })

  test('forbids promoting session behavior to stable preference without explicit evidence', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/behavior to preference|session-level behavior/)
  })

  test('forbids speculation about emotions and motives', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/speculate.*emotion|emotions or motives/)
  })

  test('declares a watermark contract that handles the zero-fragment case', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('watermark')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toMatch(/zero fragments|even when you write zero/)
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

  test('handler points the subagent at MEMORY.md so it can read existing memory first', async () => {
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
    expect(promptCalls[0]!).toContain(join(agentDir, 'MEMORY.md'))
    expect(promptCalls[0]!).toMatch(/read MEMORY\.md/i)
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
