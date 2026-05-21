import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import operatorPlugin from './index'

const RESOLVED: ResolvedPlugin = {
  name: 'operator',
  version: undefined,
  source: '<bundled>',
  defined: operatorPlugin,
}

describe('operator plugin', () => {
  test('contributes exactly one public subagent named "operator"', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName).sort()).toEqual(['operator'])
    const operator = registry.subagents.find((s) => s.subagentName === 'operator')
    if (operator === undefined) throw new Error('operator subagent missing')
    expect(operator.subagent.visibility).toBe('public')
  })

  test('contributes no tools / cron jobs / hooks / skills / commands / doctor checks', async () => {
    const { registry, hooks } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.tools).toHaveLength(0)
    expect(registry.skills).toHaveLength(0)
    expect(registry.skillsDirs).toHaveLength(0)
    expect(registry.commands).toEqual([])
    expect(registry.doctorChecks).toHaveLength(0)
    expect(hooks.count('session.idle')).toBe(0)
    expect(hooks.count('session.end')).toBe(0)
    expect(hooks.count('tool.before')).toBe(0)
    expect(hooks.count('tool.after')).toBe(0)
  })
})
