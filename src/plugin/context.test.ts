import { describe, expect, test } from 'bun:test'

import { configSchema } from '@/config'
import { noopPermissionService } from '@/permissions'

import { buildPluginModels, createPluginContext } from './context'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('createPluginContext', () => {
  test('exposes name, version, agentDir, config, logger', () => {
    const ctx = createPluginContext({
      name: 'foo',
      version: '1.0.0',
      agentDir: '/x',
      config: { k: 1 },
      logger: noopLogger,
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    })
    expect(ctx.name).toBe('foo')
    expect(ctx.version).toBe('1.0.0')
    expect(ctx.agentDir).toBe('/x')
    expect(ctx.config).toEqual({ k: 1 })
    expect(ctx.models.default.profile).toBe('default')
    expect(ctx.models.default.providerId).toBe('openai')
  })

  test('hasSecret reports only non-empty process env presence', () => {
    const previous = process.env['TYPECLAW_TEST_PLUGIN_SECRET']
    const ctx = createPluginContext({
      name: 'foo',
      version: undefined,
      agentDir: '/x',
      config: undefined as never,
      logger: noopLogger,
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    })

    try {
      delete process.env['TYPECLAW_TEST_PLUGIN_SECRET']
      expect(ctx.hasSecret('TYPECLAW_TEST_PLUGIN_SECRET')).toBe(false)
      process.env['TYPECLAW_TEST_PLUGIN_SECRET'] = ''
      expect(ctx.hasSecret('TYPECLAW_TEST_PLUGIN_SECRET')).toBe(false)
      process.env['TYPECLAW_TEST_PLUGIN_SECRET'] = 'hidden'
      expect(ctx.hasSecret('TYPECLAW_TEST_PLUGIN_SECRET')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env['TYPECLAW_TEST_PLUGIN_SECRET']
      else process.env['TYPECLAW_TEST_PLUGIN_SECRET'] = previous
    }
  })

  test('spawnSubagent throws when called before boot completes', async () => {
    const ctx = createPluginContext({
      name: 'foo',
      version: undefined,
      agentDir: '/x',
      config: undefined as never,
      logger: noopLogger,
      permissions: noopPermissionService,
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
      permissions: noopPermissionService,
      spawnSubagent: async (name, payload) => {
        calls.push({ name, payload })
      },
      isBooted: () => true,
    })
    await ctx.spawnSubagent('worker', { x: 1 })
    expect(calls).toEqual([{ name: 'worker', payload: { x: 1 } }])
  })
})

describe('buildPluginModels', () => {
  test('exposes every configured profile with provider and model capabilities', () => {
    const models = configSchema.parse({
      models: {
        default: 'openai/gpt-5.4-nano',
        fast: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        vision: 'openai/gpt-5.4-mini',
      },
    }).models

    const pluginModels = buildPluginModels(models)

    expect(pluginModels.default).toEqual({
      profile: 'default',
      ref: 'openai/gpt-5.4-nano',
      providerId: 'openai',
      modelId: 'gpt-5.4-nano',
      input: ['text', 'image'],
      reasoning: true,
    })
    expect(pluginModels.profiles.map((profile) => profile.profile).sort()).toEqual(['default', 'fast', 'vision'])
    expect(pluginModels.profiles.find((profile) => profile.profile === 'fast')).toMatchObject({
      ref: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      providerId: 'fireworks',
      modelId: 'accounts/fireworks/routers/kimi-k2p6-turbo',
    })
  })

  test('resolve honors default fallback for unknown profiles', () => {
    const models = configSchema.parse({
      models: {
        default: 'openai/gpt-5.4-nano',
        fast: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      },
    }).models

    const pluginModels = buildPluginModels(models)

    expect(pluginModels.resolve('fast')).toMatchObject({ profile: 'fast', providerId: 'fireworks' })
    expect(pluginModels.resolve('missing')).toEqual(pluginModels.default)
  })

  test('usesProvider checks configured profiles', () => {
    const models = configSchema.parse({
      models: {
        default: 'openai/gpt-5.4-nano',
        fast: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      },
    }).models

    const pluginModels = buildPluginModels(models)

    expect(pluginModels.usesProvider('openai')).toBe(true)
    expect(pluginModels.usesProvider('fireworks')).toBe(true)
    expect(pluginModels.usesProvider('anthropic')).toBe(false)
  })
})
