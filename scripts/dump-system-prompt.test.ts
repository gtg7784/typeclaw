import { describe, expect, test } from 'bun:test'

import { dumpSystemPrompt } from './dump-system-prompt'

describe('dumpSystemPrompt', () => {
  const kinds: Array<'tui' | 'cron' | 'channel' | 'subagent'> = ['tui', 'cron', 'channel', 'subagent']

  test.each(kinds)('%s origin renders all required sections', (kind) => {
    const out = dumpSystemPrompt(kind)

    expect(out).toContain('You are a general-purpose AI agent running inside TypeClaw.')
    expect(out).toContain('# Identity')
    expect(out).toContain('## Runtime')
    expect(out).toContain('TypeClaw runtime version: 1.2.3-debug.')
    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
    expect(out).toContain('## Uncommitted changes at session start')
    expect(out).toContain('# Memory')
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

  test('--no-git-nudge equivalent omits the uncommitted changes block', () => {
    const out = dumpSystemPrompt('cron', { gitNudge: false })

    expect(out).not.toContain('## Uncommitted changes at session start')
    expect(out).toContain('# Memory')
  })

  test('section order is least-volatile to most-volatile (cache-suffix contract)', () => {
    const out = dumpSystemPrompt('cron')
    // Anchor on header strings that appear EXACTLY ONCE in the rendered
    // prompt. `# Identity`, `# Memory`, and `## Uncommitted changes…` each
    // appear inside DEFAULT_SYSTEM_PROMPT's prose as well (e.g. "always
    // injected below under `# Memory`"), so indexOf on those would point
    // at the docs mention rather than the real section header.
    const idx = (needle: string) => out.indexOf(needle)

    expect(idx('## IDENTITY.md')).toBeLessThan(idx('TypeClaw runtime version:'))
    expect(idx('TypeClaw runtime version:')).toBeLessThan(idx('You are running an unattended cron job.'))
    expect(idx('You are running an unattended cron job.')).toBeLessThan(idx('## Your role in this session'))
    expect(idx('## Your role in this session')).toBeLessThan(idx('git reports 2 uncommitted files'))
    expect(idx('git reports 2 uncommitted files')).toBeLessThan(idx('## MEMORY.md'))
  })
})
