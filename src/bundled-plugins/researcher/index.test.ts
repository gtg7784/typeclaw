import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import researcherPlugin from './index'

const RESOLVED: ResolvedPlugin = {
  name: 'researcher',
  version: undefined,
  source: '<bundled>',
  defined: researcherPlugin,
}

describe('researcher plugin', () => {
  test('contributes exactly one public subagent named "researcher"', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName).sort()).toEqual(['researcher'])
    const researcher = registry.subagents.find((s) => s.subagentName === 'researcher')
    if (researcher === undefined) throw new Error('researcher subagent missing')
    expect(researcher.subagent.visibility).toBe('public')
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
