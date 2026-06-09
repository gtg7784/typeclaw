import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { defineTool } from './define'
import type { LoadPluginEntryFn } from './loader'
import { loadPlugins, summarizeLoaded, pluginCronJobs } from './manager'

describe('loadPlugins — atomic rollback', () => {
  test('throws and discards all registrations if a factory throws', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'good') {
        return {
          name: 'good',
          version: undefined,
          source: 'good',
          defined: {
            plugin: async () => ({ tools: { ok: tool } }),
          },
        }
      }
      return {
        name: 'bad',
        version: undefined,
        source: 'bad',
        defined: {
          plugin: async () => {
            throw new Error('factory failed')
          },
        },
      }
    }

    await expect(
      loadPlugins({ entries: ['good', 'bad'], agentDir: '/tmp', configsByName: {}, loadEntry }),
    ).rejects.toThrow(/bad: factory threw: factory failed/)
  })

  test('throws on conflicting tool registration mid-load and rolls back the offending plugin', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const loadEntry: LoadPluginEntryFn = async (entry) => ({
      name: entry,
      version: undefined,
      source: entry,
      defined: {
        plugin: async () => ({ tools: { same: tool } }),
      },
    })

    await expect(
      loadPlugins({ entries: ['p1', 'p2'], agentDir: '/tmp', configsByName: {}, loadEntry }),
    ).rejects.toThrow(/already registered by plugin p1/)
  })

  test('rejects duplicate plugin names', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'same',
      version: undefined,
      source: 's',
      defined: { plugin: async () => ({ tools: { t: tool } }) },
    })

    await expect(loadPlugins({ entries: ['x', 'y'], agentDir: '/tmp', configsByName: {}, loadEntry })).rejects.toThrow(
      /plugin name conflict: same/,
    )
  })
})

describe('loadPlugins — unresolvable entry is non-fatal', () => {
  test('warns and skips an entry that fails to resolve, still loading the rest', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'typeclaw-plugin-missing') {
        throw new Error(`Cannot find package '${entry}'`)
      }
      return {
        name: entry,
        version: undefined,
        source: entry,
        defined: { plugin: async () => ({ tools: { [entry]: tool } }) },
      }
    }

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '))
    let result
    try {
      result = await loadPlugins({
        entries: ['good-one', 'typeclaw-plugin-missing', 'good-two'],
        agentDir: '/tmp',
        configsByName: {},
        loadEntry,
      })
    } finally {
      console.warn = originalWarn
    }

    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['good-one', 'good-two'])
    expect(warnings.some((w) => w.includes('typeclaw-plugin-missing') && w.includes('Cannot find package'))).toBe(true)
  })
})

describe('loadPlugins — config validation', () => {
  test("validates per-plugin config against the plugin's configSchema", async () => {
    const captured: { value: unknown } = { value: undefined }
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'standup-log',
      version: '0.1.0',
      source: 'standup-log',
      defined: {
        configSchema: z.object({ schedule: z.string().default('0 9 * * 1') }),
        plugin: async (ctx) => {
          captured.value = ctx.config
          return {}
        },
      },
    })

    await loadPlugins({
      entries: ['standup-log'],
      agentDir: '/tmp',
      configsByName: { 'standup-log': { schedule: '0 17 * * 5' } },
      loadEntry,
    })

    expect(captured.value).toEqual({ schedule: '0 17 * * 5' })
  })

  test('applies schema defaults when config is absent', async () => {
    const captured: { value: unknown } = { value: undefined }
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'standup-log',
      version: undefined,
      source: 's',
      defined: {
        configSchema: z.object({ schedule: z.string().default('0 9 * * 1') }),
        plugin: async (ctx) => {
          captured.value = ctx.config
          return {}
        },
      },
    })

    await loadPlugins({ entries: ['s'], agentDir: '/tmp', configsByName: {}, loadEntry })
    expect(captured.value).toEqual({ schedule: '0 9 * * 1' })
  })

  test('rejects invalid config with plugin name + field path in the error', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'standup-log',
      version: undefined,
      source: 's',
      defined: {
        configSchema: z.object({ schedule: z.string() }),
        plugin: async () => ({}),
      },
    })

    await expect(
      loadPlugins({
        entries: ['s'],
        agentDir: '/tmp',
        configsByName: { 'standup-log': { schedule: 42 } },
        loadEntry,
      }),
    ).rejects.toThrow(/standup-log: config invalid: schedule:/)
  })

  test('rejects config block when plugin declares no configSchema', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'no-config-plugin',
      version: undefined,
      source: 's',
      defined: {
        plugin: async () => ({}),
      },
    })

    await expect(
      loadPlugins({
        entries: ['s'],
        agentDir: '/tmp',
        configsByName: { 'no-config-plugin': { foo: 1 } },
        loadEntry,
      }),
    ).rejects.toThrow(/declares no configSchema/)
  })
})

describe('loadPlugins — markBooted gates spawnSubagent', () => {
  test('spawnSubagent in factory throws; callable after markBooted', async () => {
    const calls: string[] = []
    const setup: { spawn?: (name: string) => Promise<void> } = {}

    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async (ctx) => {
          setup.spawn = (n) => ctx.spawnSubagent(n)
          return {}
        },
      },
    })

    const result = await loadPlugins({
      entries: ['p1'],
      agentDir: '/tmp',
      configsByName: {},
      loadEntry,
    })

    await expect(setup.spawn!('worker')).rejects.toThrow(/before boot completed/)

    result.setSpawnSubagent(async (name) => {
      calls.push(name)
    })
    result.markBooted()

    await setup.spawn!('worker')
    expect(calls).toEqual(['worker'])
  })

  test('spawnSubagent inside the factory throws synchronously', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async (ctx) => {
          await ctx.spawnSubagent('w')
          return {}
        },
      },
    })

    await expect(loadPlugins({ entries: ['p1'], agentDir: '/tmp', configsByName: {}, loadEntry })).rejects.toThrow(
      /before boot completed/,
    )
  })

  test('forwards the SpawnSubagentOptions arg to the wired implementation', async () => {
    // given a plugin that spawns with parentSessionId + spawnedByOrigin options
    // (the shape the bundled memory plugin's session.prompt hook passes).
    // Without forwarding, dispatchSpawnSubagent in src/run/index.ts cannot
    // resolve the spawned role or stamp provenance, and any future in-process
    // coalescing keyed on payload would not see the parent's identity either.
    const captured: { name: string; payload: unknown; options: unknown }[] = []
    const setup: { spawn?: (name: string, payload: unknown, options: unknown) => Promise<void> } = {}
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async (ctx) => {
          setup.spawn = (n, p, o) => ctx.spawnSubagent(n, p, o as never)
          return {}
        },
      },
    })

    const result = await loadPlugins({ entries: ['p1'], agentDir: '/tmp', configsByName: {}, loadEntry })
    result.setSpawnSubagent(async (name, payload, options) => {
      captured.push({ name, payload, options })
    })
    result.markBooted()

    const origin = { kind: 'channel' as const, adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null }
    await setup.spawn!('worker', { x: 1 }, { parentSessionId: 'ses_parent', spawnedByOrigin: origin })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({
      name: 'worker',
      payload: { x: 1 },
      options: { parentSessionId: 'ses_parent', spawnedByOrigin: origin },
    })
  })
})

describe('loadPlugins — registry shape', () => {
  test('pluginCronJobs returns CronJob[] with __plugin_<name>_<key> ids', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async () => ({
          cronJobs: {
            'weekly-digest': { schedule: '0 9 * * 1', kind: 'prompt', prompt: 'go' },
          },
        }),
      },
    })

    const result = await loadPlugins({ entries: ['p1'], agentDir: '/tmp', configsByName: {}, loadEntry })
    const jobs = pluginCronJobs(result.registry)
    expect(jobs.map((j) => j.id)).toEqual(['__plugin_p1_weekly-digest'])
  })

  test('summarizeLoaded includes counts and version when present', async () => {
    const loadEntry: LoadPluginEntryFn = async (entry) => ({
      name: entry,
      version: entry === 'a' ? '1.2.3' : undefined,
      source: entry,
      defined: {
        plugin: async () => ({}),
      },
    })

    const result = await loadPlugins({
      entries: ['a', 'b'],
      agentDir: '/tmp',
      configsByName: {},
      loadEntry,
    })
    const s = summarizeLoaded(result.loadedPlugins, result.registry)
    expect(s).toContain('a v1.2.3')
    expect(s).toContain('b')
    expect(s).toContain('0 tool(s)')
  })
})
