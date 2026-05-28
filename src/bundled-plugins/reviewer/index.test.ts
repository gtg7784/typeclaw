import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import reviewerPlugin from './index'

const RESOLVED: ResolvedPlugin = {
  name: 'reviewer',
  version: undefined,
  source: '<bundled>',
  defined: reviewerPlugin,
}

describe('reviewer plugin', () => {
  test('contributes exactly one public subagent named "reviewer"', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName).sort()).toEqual(['reviewer'])
    const reviewer = registry.subagents.find((s) => s.subagentName === 'reviewer')
    if (reviewer === undefined) throw new Error('reviewer subagent missing')
    expect(reviewer.subagent.visibility).toBe('public')
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
