import { describe, expect, test } from 'bun:test'

import { createPluginContext } from './context'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('createPluginContext', () => {
  test('exposes name, version, agentDir, config, logger', () => {
    const ctx = createPluginContext({
      name: 'foo',
      version: '1.0.0',
      agentDir: '/x',
      config: { k: 1 },
      logger: noopLogger,
      spawnSubagent: async () => {},
      isBooted: () => true,
    })
    expect(ctx.name).toBe('foo')
    expect(ctx.version).toBe('1.0.0')
    expect(ctx.agentDir).toBe('/x')
    expect(ctx.config).toEqual({ k: 1 })
  })

  test('spawnSubagent throws when called before boot completes', async () => {
    const ctx = createPluginContext({
      name: 'foo',
      version: undefined,
      agentDir: '/x',
      config: undefined as never,
      logger: noopLogger,
      spawnSubagent: async () => {},
      isBooted: () => false,
    })
    await expect(ctx.spawnSubagent('any')).rejects.toThrow(/before boot completed/)
  })

  test('spawnSubagent forwards to underlying impl after boot', async () => {
    const calls: { name: string; payload: unknown }[] = []
    const ctx = createPluginContext({
      name: 'foo',
      version: undefined,
      agentDir: '/x',
      config: undefined as never,
      logger: noopLogger,
      spawnSubagent: async (name, payload) => {
        calls.push({ name, payload })
      },
      isBooted: () => true,
    })
    await ctx.spawnSubagent('worker', { x: 1 })
    expect(calls).toEqual([{ name: 'worker', payload: { x: 1 } }])
  })
})
