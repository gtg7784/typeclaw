import { describe, expect, test } from 'bun:test'

import { EXPLORER_SYSTEM_PROMPT, createExplorerSubagent, explorerPayloadSchema } from './explorer'

describe('explorer subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'READ-ONLY',
      'STRICTLY PROHIBITED',
      'no_file_modifications',
      'parallel',
      'absolute',
      '<analysis>',
      '<results>',
      '<files>',
      '<answer>',
      '<next_steps>',
      'Completeness over speed',
      'Spawning further subagents',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    // The prompt uses no_file_modifications as the readonly-mode label in some
    // capitalizations; normalize for an unambiguous substring assertion.
    const haystack = EXPLORER_SYSTEM_PROMPT.toLowerCase().replace(/\s+/g, '_')
    expect(haystack).toContain(phrase.toLowerCase().replace(/\s+/g, '_'))
  })

  test('prompt forbids bash for write operations', () => {
    expect(EXPLORER_SYSTEM_PROMPT).toContain('mkdir')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('rm')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('git add')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('git commit')
  })

  test('prompt names the dedicated tools by their exact runtime names', () => {
    expect(EXPLORER_SYSTEM_PROMPT).toContain('`find`')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('`grep`')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('`read`')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('`ls`')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('`bash`')
  })

  test('prompt frames the role as local-search (not codebase-only) and names the non-code surfaces', () => {
    // Drift guard: the widened scope is the whole point of the PR. If a
    // future edit reverts the prompt back to "codebase search specialist",
    // sessions/memory/cron/config never get mentioned and this test fails.
    expect(EXPLORER_SYSTEM_PROMPT).toContain('local-search specialist')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('Sessions')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('Memory')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('Cron')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('Git history')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('Mounts')
  })

  test('prompt redirects EXTERNAL questions to scout (so explorer does not hallucinate web answers from memory)', () => {
    // Without this guard, a user asking "what's the latest version of X?"
    // gets a guessed answer instead of a delegated scout spawn. The
    // explorer/scout split only works if the prompt names the boundary.
    expect(EXPLORER_SYSTEM_PROMPT).toContain('scout')
    expect(EXPLORER_SYSTEM_PROMPT.toLowerCase()).toContain('external')
  })

  test('prompt warns about credential-bearing config files (.env / secrets.json) without forbidding read', () => {
    // Reading these files is in scope (you need to be able to answer
    // "is provider X configured?") — but echoing the literal token values
    // back to the caller is the leak vector. The wording must say the
    // latter, not the former, or explorer becomes useless for config
    // questions.
    expect(EXPLORER_SYSTEM_PROMPT).toContain('.env')
    expect(EXPLORER_SYSTEM_PROMPT).toContain('secrets.json')
    expect(EXPLORER_SYSTEM_PROMPT.toLowerCase()).toContain('credentials')
  })
})

describe('explorer subagent declaration', () => {
  test('is registered as visibility=public so spawn_subagent exposes it', () => {
    const sub = createExplorerSubagent()
    expect(sub.visibility).toBe('public')
  })

  test('uses the fast model profile (cheap and parallelizable for read-only work)', () => {
    const sub = createExplorerSubagent()
    expect(sub.profile).toBe('fast')
  })

  test('tools list contains read/grep/find/ls/bash and NO write/edit', () => {
    const sub = createExplorerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool)
    expect(toolNames.sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read'])
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('declares a tool-result budget so a runaway subagent cannot exhaust parent context', () => {
    const sub = createExplorerSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createExplorerSubagent()
    const key1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const key2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(key1).toBe('bg_a')
    expect(key2).toBe('bg_b')
    expect(key1).not.toBe(key2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createExplorerSubagent()
    const key1 = sub.inFlightKey?.({})
    const key2 = sub.inFlightKey?.({})
    expect(key1).not.toBe(key2)
  })
})

describe('explorerPayloadSchema', () => {
  test('accepts a payload with requestId + prompt + description', () => {
    const result = explorerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'find auth handlers',
      description: 'auth flow',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = explorerPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params)', () => {
    const result = explorerPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).futureField).toBe(42)
  })

  test('drops a parent-supplied profile so explorer cannot be bumped off its fast tier', () => {
    const result = explorerPayloadSchema.safeParse({ requestId: 'bg_t1', prompt: 'x', profile: 'deep' })
    expect(result.success).toBe(true)
    expect(result.data).not.toHaveProperty('profile')
  })
})
