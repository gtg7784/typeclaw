import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import explorerPlugin from './index'

const RESOLVED: ResolvedPlugin = {
  name: 'explorer',
  version: undefined,
  source: '<bundled>',
  defined: explorerPlugin,
}

describe('explorer plugin', () => {
  test('contributes exactly one public subagent named "explorer"', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName).sort()).toEqual(['explorer'])
    const explorer = registry.subagents.find((s) => s.subagentName === 'explorer')
    if (explorer === undefined) throw new Error('explorer subagent missing')
    expect(explorer.subagent.visibility).toBe('public')
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
