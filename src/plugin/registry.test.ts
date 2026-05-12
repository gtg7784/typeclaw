import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { defineSubagent, defineTool } from './define'
import { createHookBus } from './hooks'
import { buildPluginCronGlobalId, discardRegistrationsBy, emptyRegistry, registerContributions } from './registry'
import type { PluginExports } from './types'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

function makeOptions(pluginName: string, ex: PluginExports) {
  return {
    pluginName,
    logger: noopLogger,
    exports: ex,
    registry: emptyRegistry(),
    hooks: createHookBus(),
    agentDir: '/tmp',
    pluginConfig: undefined,
  }
}

describe('registerContributions', () => {
  test('records tools, subagents, cron jobs, skills, skillsDirs', () => {
    const tool = defineTool({
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      async execute(args) {
        return { content: [{ type: 'text', text: args.msg }] }
      },
    })
    const sub = defineSubagent({ systemPrompt: 'you' })
    const opts = makeOptions('p1', {
      tools: { echo: tool },
      subagents: { worker: sub },
      cronJobs: {
        nightly: { schedule: '0 0 * * *', kind: 'prompt', prompt: 'go' },
      },
      skills: { howto: { description: 'h', content: 'hello' } },
      skillsDirs: ['/abs/skills'],
    })
    registerContributions(opts)

    expect(opts.registry.tools.map((t) => t.toolName)).toEqual(['echo'])
    expect(opts.registry.subagents.map((s) => s.subagentName)).toEqual(['worker'])
    expect(opts.registry.cronJobs[0]?.globalId).toBe('__plugin_p1_nightly')
    expect(opts.registry.skills.map((s) => s.localName)).toEqual(['howto'])
    expect(opts.registry.skillsDirs.map((d) => d.path)).toEqual(['/abs/skills'])
  })

  test('records doctor checks, rejects duplicates within a plugin', () => {
    const opts = makeOptions('memory', {
      doctorChecks: {
        'dir-writable': {
          description: 'memory/ is writable',
          run: async () => ({ status: 'ok', message: 'ok' }),
        },
      },
    })
    registerContributions(opts)
    expect(opts.registry.doctorChecks.map((c) => `${c.pluginName}.${c.checkName}`)).toEqual(['memory.dir-writable'])

    expect(() => registerContributions(opts)).toThrow(/doctor check "dir-writable" already registered/)
  })

  test('rejects duplicate tool name across plugins', () => {
    const tool = defineTool({
      description: 'echo',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const opts1 = makeOptions('p1', { tools: { same: tool } })
    registerContributions(opts1)

    expect(() => registerContributions({ ...opts1, pluginName: 'p2' })).toThrow(/already registered by plugin p1/)
  })

  test('rejects duplicate subagent name across plugins', () => {
    const sub = defineSubagent({ systemPrompt: 'x' })
    const opts1 = makeOptions('p1', { subagents: { worker: sub } })
    registerContributions(opts1)
    expect(() => registerContributions({ ...opts1, pluginName: 'p2' })).toThrow(/subagent "worker" already registered/)
  })

  test('rejects duplicate cron suffix when the same plugin is registered twice', () => {
    const opts = makeOptions('p1', {
      cronJobs: {
        a: { schedule: '* * * * *', kind: 'prompt', prompt: 'x' },
      },
    })
    registerContributions(opts)
    expect(() => registerContributions(opts)).toThrow(/conflicts with plugin p1/)
  })

  test('cron globalId uses __plugin_<name>_<key> format', () => {
    expect(buildPluginCronGlobalId('standup-log', 'weekly-digest')).toBe('__plugin_standup-log_weekly-digest')
  })
})

describe('discardRegistrationsBy', () => {
  test('removes all registrations for the named plugin and leaves others intact', () => {
    const registry = emptyRegistry()
    const hooks = createHookBus()
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })

    registerContributions({
      pluginName: 'p1',
      logger: noopLogger,
      exports: {
        tools: { t1: tool },
        subagents: { s1: defineSubagent({ systemPrompt: '' }) },
        cronJobs: { c1: { schedule: '* * * * *', kind: 'prompt', prompt: '' } },
        skills: { sk1: { description: '', content: '' } },
        skillsDirs: ['/p1/skills'],
        hooks: { 'session.start': () => {} },
        doctorChecks: {
          ping: {
            description: 'always ok',
            run: async () => ({ status: 'ok', message: 'ok' }),
          },
        },
      },
      registry,
      hooks,
      agentDir: '/tmp',
      pluginConfig: undefined,
    })
    registerContributions({
      pluginName: 'p2',
      logger: noopLogger,
      exports: {
        tools: { t2: tool },
        hooks: { 'session.end': () => {} },
      },
      registry,
      hooks,
      agentDir: '/tmp',
      pluginConfig: undefined,
    })

    expect(hooks.count('session.start')).toBe(1)
    expect(hooks.count('session.end')).toBe(1)

    discardRegistrationsBy('p1', registry, hooks)

    expect(registry.tools.map((t) => t.pluginName)).toEqual(['p2'])
    expect(registry.subagents).toEqual([])
    expect(registry.cronJobs).toEqual([])
    expect(registry.skills).toEqual([])
    expect(registry.skillsDirs).toEqual([])
    expect(registry.doctorChecks).toEqual([])
    expect(hooks.count('session.start')).toBe(0)
    expect(hooks.count('session.end')).toBe(1)
  })
})
