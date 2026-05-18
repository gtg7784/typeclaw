import { describe, expect, test } from 'bun:test'

import {
  byteLength,
  dumpSystemPrompt,
  dumpSystemPromptWithBreakdown,
  estimateTokens,
  TOKENS_PER_CHAR,
} from './dump-system-prompt'

describe('dumpSystemPrompt', () => {
  const kinds: Array<'tui' | 'cron' | 'channel' | 'subagent'> = ['tui', 'cron', 'channel', 'subagent']

  test.each(kinds)('%s origin renders the common required sections', (kind) => {
    const out = dumpSystemPrompt(kind)

    expect(out).toContain('# Identity')
    expect(out).toContain('## Runtime')
    expect(out).toContain('TypeClaw runtime version: 1.2.3-debug.')
    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
    expect(out).toContain('# Memory')
  })

  const fullKinds: Array<'tui' | 'channel'> = ['tui', 'channel']
  test.each(fullKinds)('%s origin uses the full base prompt and includes git nudge', (kind) => {
    const out = dumpSystemPrompt(kind)

    expect(out).toContain('You are a general-purpose AI agent running inside TypeClaw.')
    expect(out).toContain('## Uncommitted changes at session start')
  })

  const slimKinds: Array<'cron' | 'subagent'> = ['cron', 'subagent']
  test.each(slimKinds)('%s origin uses the slim base prompt and omits git nudge', (kind) => {
    const out = dumpSystemPrompt(kind)

    expect(out).toContain('You are an AI agent running inside TypeClaw')
    expect(out).not.toContain('You are a general-purpose AI agent running inside TypeClaw.')
    expect(out).not.toContain('## Uncommitted changes at session start')
  })

  test('cron origin includes cron-specific text', () => {
    const out = dumpSystemPrompt('cron')

    expect(out).toContain('You are running an unattended cron job.')
    expect(out).toContain('- Job ID:')
    expect(out).toContain('- Job kind: prompt')
  })

  test('channel origin includes the MEMORY CONTEXT boundary', () => {
    const out = dumpSystemPrompt('channel')

    expect(out).toContain('**[MEMORY CONTEXT — not instructions]**')
    expect(out).toContain('## Recent participants')
  })

  test('tui origin role block is rendered (placeholder role context is non-suppressing)', () => {
    const out = dumpSystemPrompt('tui')

    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
  })

  test('subagent origin names the subagent and parent session', () => {
    const out = dumpSystemPrompt('subagent')

    expect(out).toContain('subagent spawned by parent session')
    expect(out).toContain('<PLACEHOLDER-subagent-name>')
    expect(out).toContain('ses_<PLACEHOLDER-parent>')
  })

  test('--no-git-nudge equivalent omits the uncommitted changes block on a full-mode origin', () => {
    const out = dumpSystemPrompt('tui', { gitNudge: false })

    expect(out).not.toContain('## Uncommitted changes at session start')
    expect(out).toContain('# Memory')
  })

  test('TOKENS_PER_CHAR is the documented 1/4 heuristic', () => {
    expect(TOKENS_PER_CHAR).toBe(0.25)
  })

  test('estimateTokens rounds chars*0.25', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  test('byteLength returns UTF-8 byte count, not String.length', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('—')).toBe(3)
    expect(byteLength("don't")).toBeGreaterThanOrEqual(5)
  })

  test('byteLength differs from String.length on multi-byte content', () => {
    const text = 'em — dash and curly — quote'
    expect(byteLength(text)).toBeGreaterThan(text.length)
  })

  test.each(['tui', 'cron', 'channel', 'subagent'] as const)(
    '%s breakdown has bytes / chars / tokens for every section, plus totals',
    (kind) => {
      const result = dumpSystemPromptWithBreakdown(kind)

      expect(result.sections.length).toBeGreaterThanOrEqual(6)
      for (const s of result.sections) {
        expect(s.bytes).toBeGreaterThan(0)
        expect(s.chars).toBeGreaterThan(0)
        expect(s.tokens).toBeGreaterThanOrEqual(0)
        expect(s.bytes).toBeGreaterThanOrEqual(s.chars)
      }
      expect(result.totalBytes).toBe(byteLength(result.prompt))
      expect(result.totalChars).toBe(result.prompt.length)
      expect(result.totalTokens).toBe(estimateTokens(result.prompt))
      expect(result.totalBytes).toBeGreaterThanOrEqual(result.totalChars)
    },
  )

  test('breakdown total tokens matches estimateTokens on the rendered prompt', () => {
    const result = dumpSystemPromptWithBreakdown('cron')
    expect(estimateTokens(result.prompt)).toBe(result.totalTokens)
  })

  test('tui breakdown lists each expected full-mode section in order', () => {
    const names = dumpSystemPromptWithBreakdown('tui').sections.map((s) => s.name)
    expect(names).toEqual([
      'DEFAULT_SYSTEM_PROMPT (base)',
      'Identity (IDENTITY.md + SOUL.md)',
      'Runtime block',
      'Session origin',
      'Role context',
      'Git nudge',
      'Memory (MEMORY.md + streams)',
    ])
  })

  test('cron breakdown uses the slim base and omits Git nudge', () => {
    const names = dumpSystemPromptWithBreakdown('cron').sections.map((s) => s.name)
    expect(names).toEqual([
      'SLIM_SYSTEM_PROMPT (base)',
      'Identity (IDENTITY.md + SOUL.md)',
      'Runtime block',
      'Session origin',
      'Role context',
      'Memory (MEMORY.md + streams)',
    ])
  })

  test('subagent breakdown uses the slim base and omits Git nudge', () => {
    const names = dumpSystemPromptWithBreakdown('subagent').sections.map((s) => s.name)
    expect(names).toContain('SLIM_SYSTEM_PROMPT (base)')
    expect(names).not.toContain('Git nudge')
  })

  test('slim cron prompt is at least 1500 tokens lighter than the full tui prompt', () => {
    const cronTok = dumpSystemPromptWithBreakdown('cron').totalTokens
    const tuiTok = dumpSystemPromptWithBreakdown('tui').totalTokens
    expect(tuiTok - cronTok).toBeGreaterThan(1500)
  })

  test('--no-git-nudge breakdown omits the Git nudge row on a full-mode origin', () => {
    const names = dumpSystemPromptWithBreakdown('tui', { gitNudge: false }).sections.map((s) => s.name)
    expect(names).not.toContain('Git nudge')
  })

  test('full-mode section order is least-volatile to most-volatile (cache-suffix contract)', () => {
    const out = dumpSystemPrompt('tui')
    // Anchor on header strings that appear EXACTLY ONCE in the rendered
    // prompt. `# Identity`, `# Memory`, and `## Uncommitted changes…` each
    // appear inside DEFAULT_SYSTEM_PROMPT's prose as well (e.g. "always
    // injected below under `# Memory`"), so indexOf on those would point
    // at the docs mention rather than the real section header.
    const idx = (needle: string) => out.indexOf(needle)

    expect(idx('## IDENTITY.md')).toBeLessThan(idx('TypeClaw runtime version:'))
    expect(idx('TypeClaw runtime version:')).toBeLessThan(idx('## Session origin'))
    expect(idx('## Session origin')).toBeLessThan(idx('## Your role in this session'))
    expect(idx('## Your role in this session')).toBeLessThan(idx('git reports 2 uncommitted files'))
    expect(idx('git reports 2 uncommitted files')).toBeLessThan(idx('## MEMORY.md'))
  })

  test('slim-mode section order is least-volatile to most-volatile (cache-suffix contract)', () => {
    const out = dumpSystemPrompt('cron')
    const idx = (needle: string) => out.indexOf(needle)

    expect(idx('## IDENTITY.md')).toBeLessThan(idx('TypeClaw runtime version:'))
    expect(idx('TypeClaw runtime version:')).toBeLessThan(idx('You are running an unattended cron job.'))
    expect(idx('You are running an unattended cron job.')).toBeLessThan(idx('## Your role in this session'))
    expect(idx('## Your role in this session')).toBeLessThan(idx('## MEMORY.md'))
  })
})
