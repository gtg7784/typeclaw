import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import plannerPlugin from './index'

const RESOLVED: ResolvedPlugin = {
  name: 'planner',
  version: undefined,
  source: '<bundled>',
  defined: plannerPlugin,
}

describe('planner plugin', () => {
  test('contributes exactly one public subagent named "planner"', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName).sort()).toEqual(['planner'])
    const planner = registry.subagents.find((s) => s.subagentName === 'planner')
    if (planner === undefined) throw new Error('planner subagent missing')
    expect(planner.subagent.visibility).toBe('public')
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
