import { describe, expect, test } from 'bun:test'

import { OPERATOR_SYSTEM_PROMPT, createOperatorSubagent, operatorPayloadSchema } from './operator'

describe('operator subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'final assistant message',
      'multi-step',
      'commit your changes',
      'Outcome',
      'What you did',
      'What changed',
      'What you observed',
      'Do NOT commit secrets',
      'Spawn further subagents',
      'cannot proceed',
      'workspace in a broken state',
      'AGENTS.md',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    const haystack = OPERATOR_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })

  test('prompt names the final-report structure explicitly (so the parent can rely on parseable shape)', () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain('Outcome.')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('What you did.')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('What changed.')
    expect(OPERATOR_SYSTEM_PROMPT).toContain('What you observed.')
    expect(OPERATOR_SYSTEM_PROMPT).toContain("What's next.")
  })

  test('prompt forbids recursive spawn (defense-in-depth alongside the tool-presence gate)', () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('spawn further subagents')
  })

  test('prompt forbids talking to the user directly (Mode B contract: parent owns the conversation)', () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('talk to the user directly')
    expect(lower).toContain('channel_send')
  })
})

describe('operator subagent declaration', () => {
  test('is registered as visibility=public', () => {
    const sub = createOperatorSubagent()
    expect(sub.visibility).toBe('public')
  })

  test('uses the default model profile (needs reasoning for multi-step work, not the fast tier)', () => {
    const sub = createOperatorSubagent()
    expect(sub.profile).toBe('default')
  })

  test('tools include read+grep+find+ls+bash AND write+edit (write-capable)', () => {
    const sub = createOperatorSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
  })

  test('tool-result budget is larger than explorers (multi-step work generates more transcript)', () => {
    const sub = createOperatorSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThanOrEqual(1_000_000)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads', () => {
    const sub = createOperatorSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
  })

  test('inFlightKey falls back to a random value when no requestId is provided', () => {
    const sub = createOperatorSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('operatorPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description', () => {
    const result = operatorPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'open example.com',
      description: 'browser session',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = operatorPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat)', () => {
    const result = operatorPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })
})
