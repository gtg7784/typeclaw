import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'

import { formatLocalDate } from './local-time'
import {
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  memoryLoggerSubagent,
  type MemoryLoggerPayload,
} from './memory-logger'

function makeAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-agent-'))
  mkdirSync(join(root, 'memory'))
  mkdirSync(join(root, 'sessions'))
  return root
}

async function invokeWith(
  payload: MemoryLoggerPayload,
  agentDir: string,
): Promise<{ runSessionCalls: { userPrompt: string | undefined }[] }> {
  const calls: { userPrompt: string | undefined }[] = []
  const runSession: RunSession = async (override) => {
    calls.push({ userPrompt: override?.userPrompt })
  }
  const ctx: SubagentContext<MemoryLoggerPayload> = {
    userPrompt: '',
    agentDir,
    payload,
  }
  await memoryLoggerSubagent.handler!(ctx, runSession)
  return { runSessionCalls: calls }
}

describe('isMemoryLoggerPayload', () => {
  test('accepts a valid payload', () => {
    expect(
      isMemoryLoggerPayload({
        parentSessionId: 'ses_abc',
        parentTranscriptPath: '/path/to/file.jsonl',
        agentDir: '/path/to/agent',
      }),
    ).toBe(true)
  })

  test('rejects when fields are missing', () => {
    expect(isMemoryLoggerPayload({})).toBe(false)
    expect(isMemoryLoggerPayload({ parentSessionId: '', parentTranscriptPath: 'b', agentDir: 'c' })).toBe(false)
  })
})

describe('MEMORY_LOGGER_SYSTEM_PROMPT', () => {
  test('declares the fragment marker format', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/<!-- fragment source=.+ entry=.+ -->/)
  })

  test('requires the Claim / Evidence / Implication body structure', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('**Claim:**')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('**Evidence:**')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('**Implication:**')
  })

  test('frames both over-writing and under-writing as failure modes', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('over-writing')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('under-writing')
  })

  test('declares a watermark contract that handles the zero-fragment case', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('watermark')
  })
})

describe('memoryLoggerSubagent', () => {
  test('declares the memory-logger system prompt', () => {
    expect(memoryLoggerSubagent.systemPrompt).toBe(MEMORY_LOGGER_SYSTEM_PROMPT)
  })

  test('declares one built-in tool (read) and one custom tool (append)', () => {
    expect(memoryLoggerSubagent.tools).toBeDefined()
    expect(memoryLoggerSubagent.tools!.length).toBe(1)
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBe(1)
  })

  test('declares an inFlightKey that keys on parentSessionId', () => {
    expect(memoryLoggerSubagent.inFlightKey).toBeDefined()
    const key = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_abc',
      parentTranscriptPath: '/x',
      agentDir: '/y',
    })
    expect(key).toBe('ses_abc')
  })

  test('handler builds an initial prompt mentioning transcript, session id, and stream file', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls).toHaveLength(1)
    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain(transcript)
    expect(prompt).toContain('ses_abc')
    expect(prompt).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/)
  })

  test('handler includes the watermark when one exists in the daily stream', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = formatLocalDate()
    writeFileSync(
      join(agentDir, 'memory', `${today}.md`),
      ['<!-- fragment source=ses_abc entry=watermrk -->', '## prior', 'body', ''].join('\n'),
    )

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!).toContain('watermrk')
  })

  test('handler instructs the subagent to advance the watermark even when nothing is worth remembering', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!.toLowerCase()).toMatch(/bare watermark|advance the watermark/)
  })

  test('handler points the subagent at MEMORY.md so it can read existing memory first', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!).toContain(join(agentDir, 'MEMORY.md'))
    expect(runSessionCalls[0]!.userPrompt!).toMatch(/read MEMORY\.md/i)
  })

  test('handler indicates "no prior watermark" when none exists', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!.toLowerCase()).toMatch(/no.*watermark|no prior|first time|begin/)
  })
})
