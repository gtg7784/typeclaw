import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'
import { formatLocalDate } from '@/shared'

import {
  createMemoryLoggerSubagent,
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  type MemoryLoggerLogger,
  memoryLoggerSubagent,
  type MemoryLoggerPayload,
} from './memory-logger'

const silentLogger: MemoryLoggerLogger = { info: () => {}, warn: () => {}, error: () => {} }
const silentSubagent = createMemoryLoggerSubagent({ logger: silentLogger })

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
  await silentSubagent.handler!(ctx, runSession)
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

  test('accepts a payload with channel origin context', () => {
    expect(
      isMemoryLoggerPayload({
        parentSessionId: 'ses_abc',
        parentTranscriptPath: '/path/to/file.jsonl',
        agentDir: '/path/to/agent',
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T123',
          workspaceName: 'Acme',
          chat: 'C456',
          chatName: 'infra',
          thread: '171234.0001',
          lastInboundAuthorId: 'U1',
          participants: [
            {
              authorId: 'U1',
              authorName: 'Neo',
              firstMessageAt: 1000,
              lastMessageAt: 2000,
              messageCount: 2,
            },
          ],
        },
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

  test('requires every fragment to be evidence-anchored and self-contained', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('self-contained')
    expect(lower).toMatch(/anchored to evidence|anchor.*evidence|evidence.*anchor/)
  })

  test('frames both over-writing and under-writing as failure modes', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('over-writing')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('under-writing')
  })

  test('declares a "when in doubt, capture" capture philosophy (no behavior-change gate)', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('when in doubt')
    expect(lower).toMatch(/lean toward capture|err on writing it|cheaper than a missed/)
  })

  test('does not require fragments to articulate a future behavior change', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(
      /does(n't| not) need to articulate.*future agent|no.*Implication.*not required|implication is obvious/i,
    )
  })

  test('names dreaming as the consolidation/filter step that runs after capture', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('dreaming')
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

  test('handler includes channel location and participants in the initial prompt', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      {
        parentSessionId: 'ses_abc',
        parentTranscriptPath: transcript,
        agentDir,
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T123',
          workspaceName: 'Acme',
          chat: 'C456',
          chatName: 'infra',
          thread: '171234.0001',
          lastInboundAuthorId: 'U1',
          participants: [
            {
              authorId: 'U1',
              authorName: 'Neo',
              firstMessageAt: 1000,
              lastMessageAt: 2000,
              messageCount: 2,
            },
          ],
        },
      },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('Conversation context:')
    expect(prompt).toContain('- Adapter: slack-bot')
    expect(prompt).toContain('- Workspace: Acme (T123)')
    expect(prompt).toContain('- Chat: infra (C456)')
    expect(prompt).toContain('- Thread: 171234.0001')
    expect(prompt).toContain('- Last inbound author: U1')
    expect(prompt).toContain('Neo (U1); messages=2')
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

  test('handler emits a [memory-logger] start log line with parentSessionId and watermark on every run', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const logs: string[] = []
    const subagent = createMemoryLoggerSubagent({
      logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
    })
    const runSession: RunSession = async () => {}
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await subagent.handler!(ctx, runSession)

    const startLog = logs.find((l) => l.startsWith('[memory-logger] ses_abc start'))
    expect(startLog).toBeDefined()
    expect(startLog!).toContain('watermark=none')
    expect(logs.some((l) => l.startsWith('[memory-logger] ses_abc done'))).toBe(true)
  })

  test('handler emits a [memory-logger] warn log line and rethrows when runSession fails', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const warnings: string[] = []
    const subagent = createMemoryLoggerSubagent({
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    })
    const runSession: RunSession = async () => {
      throw new Error('LLM blew up')
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await expect(subagent.handler!(ctx, runSession)).rejects.toThrow('LLM blew up')
    expect(warnings.some((m) => m.includes('[memory-logger] ses_abc') && m.includes('LLM blew up'))).toBe(true)
  })

  test('the default exported memoryLoggerSubagent still has a handler (back-compat)', () => {
    expect(memoryLoggerSubagent.handler).toBeDefined()
  })
})
