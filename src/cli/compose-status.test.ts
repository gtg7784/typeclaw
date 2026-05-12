import { describe, expect, test } from 'bun:test'

import type { AgentStatusEntry, ComposeStatusResult } from '@/compose'

import { formatComposeStatus } from './compose-status'

function entry(overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'name'>): AgentStatusEntry {
  const { name, cwd, containerName, state, hostPort } = overrides
  return {
    name,
    cwd: cwd ?? `/agents/${name}`,
    containerName: containerName ?? name,
    state: state ?? 'running',
    hostPort: hostPort ?? null,
  }
}

function result(entries: AgentStatusEntry[], rootCwd = '/agents'): ComposeStatusResult {
  return { rootCwd, entries }
}

describe('formatComposeStatus', () => {
  test('empty fleet renders a dim "no agents" line including the cwd', () => {
    const out = formatComposeStatus(result([], '/somewhere'))
    expect(out).toContain('No typeclaw agents in /somewhere.')
  })

  test('renders agent count, cwd, and per-agent lines', () => {
    const out = formatComposeStatus(
      result(
        [
          entry({ name: 'coder', state: 'running', hostPort: 51234 }),
          entry({ name: 'planner', state: 'stopped' }),
          entry({ name: 'scratchpad', state: 'absent' }),
        ],
        '/agents',
      ),
    )
    expect(out).toContain('3 agents in /agents')
    expect(out).toContain('coder')
    expect(out).toContain('planner')
    expect(out).toContain('scratchpad')
  })

  test('uses singular "1 agent" when there is one entry', () => {
    const out = formatComposeStatus(result([entry({ name: 'solo' })]))
    expect(out).toContain('1 agent in /agents')
    expect(out).not.toContain('1 agents')
  })

  test('shows lowercase state words, not docker-style upper-case', () => {
    const out = formatComposeStatus(
      result([
        entry({ name: 'coder', state: 'running', hostPort: 51234 }),
        entry({ name: 'planner', state: 'stopped' }),
        entry({ name: 'scratchpad', state: 'absent' }),
      ]),
    )
    expect(out).toContain('running')
    expect(out).toContain('stopped')
    expect(out).toContain('not started')
    expect(out).not.toContain('RUNNING')
    expect(out).not.toContain('STOPPED')
    expect(out).not.toContain('NOT CREATED')
  })

  test('drops table-style headers (NAME / CONTAINER / STATUS)', () => {
    const out = formatComposeStatus(result([entry({ name: 'coder' })]))
    expect(out).not.toContain('NAME')
    expect(out).not.toContain('CONTAINER')
    expect(out).not.toContain('STATUS')
  })

  test('shows host port only for running agents', () => {
    const out = formatComposeStatus(
      result([
        entry({ name: 'a', state: 'running', hostPort: 51234 }),
        entry({ name: 'b', state: 'stopped', hostPort: null }),
        entry({ name: 'c', state: 'absent', hostPort: null }),
      ]),
    )
    expect(out).toContain('51234')
    const lines = out.split('\n')
    const stoppedLine = lines.find((l) => l.includes(' b '))
    const absentLine = lines.find((l) => l.includes(' c '))
    expect(stoppedLine).toBeDefined()
    expect(absentLine).toBeDefined()
    expect(stoppedLine).not.toContain('port')
    expect(absentLine).not.toContain('port')
  })

  test('omits port for running agents when hostPort is unknown', () => {
    const out = formatComposeStatus(result([entry({ name: 'coder', state: 'running', hostPort: null })]))
    expect(out).not.toContain('port')
  })

  test('uses status glyphs (●/○/·), not text symbols', () => {
    const out = formatComposeStatus(
      result([
        entry({ name: 'a', state: 'running' }),
        entry({ name: 'b', state: 'stopped' }),
        entry({ name: 'c', state: 'absent' }),
      ]),
    )
    expect(out).toContain('●')
    expect(out).toContain('○')
    expect(out).toContain('·')
  })

  test('pads agent names so state column aligns', () => {
    const out = formatComposeStatus(result([entry({ name: 'a' }), entry({ name: 'longer-name' })]))
    const lines = out.split('\n')
    const aLine = lines.find((l) => l.includes(' a '))
    const longLine = lines.find((l) => l.includes('longer-name'))
    expect(aLine).toBeDefined()
    expect(longLine).toBeDefined()
    const aStateIdx = aLine!.indexOf('running')
    const longStateIdx = longLine!.indexOf('running')
    expect(aStateIdx).toBe(longStateIdx)
  })

  test('emits ANSI color escapes under useColor=true', () => {
    const out = formatComposeStatus(
      result([
        entry({ name: 'coder', state: 'running', hostPort: 51234 }),
        entry({ name: 'planner', state: 'stopped' }),
      ]),
      { useColor: true },
    )
    expect(out).toContain('\u001b[32m')
    expect(out).toContain('\u001b[33m')
  })

  test('emits no ANSI escapes when useColor is unset', () => {
    const out = formatComposeStatus(result([entry({ name: 'coder', state: 'running', hostPort: 51234 })]))
    expect(out).not.toContain('\u001b[')
  })
})
