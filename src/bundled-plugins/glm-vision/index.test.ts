import { describe, expect, test } from 'bun:test'

import { noopPermissionService } from '@/permissions'
import type { PluginContext, PluginDoctorContext, PluginModels } from '@/plugin'
import { stubPluginModels } from '@/plugin/test-support'

import glmVisionPlugin from './index'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('glm vision plugin wiring', () => {
  test('returns no exports when provider is not zai-coding', async () => {
    // given: a non-GLM Coding Plan provider
    const ctx = pluginContext({ defaultProviderId: 'fireworks', hasSecret: true })

    // when: the plugin factory runs
    const exports = await glmVisionPlugin.plugin(ctx)

    // then: no MCP, skill, or doctor surface is contributed
    expect(exports).toEqual({})
  })

  test('returns doctor check and skill but no MCP server when coding key is absent', async () => {
    // given: a GLM Coding Plan agent without the coding key
    const ctx = pluginContext({ defaultProviderId: 'zai-coding', hasSecret: false })

    // when: the plugin factory runs
    const exports = await glmVisionPlugin.plugin(ctx)

    // then: guidance is available, but the MCP server is not activated
    expect(exports.skillsDirs).toHaveLength(1)
    expect(exports.doctorChecks?.['coding-key']).toBeDefined()
    expect(exports.mcpServers).toBeUndefined()
    await withZaiCodingKey(undefined, async () => {
      const result = await exports.doctorChecks?.['coding-key']?.run(doctorContext())
      expect(result?.status).toBe('warning')
    })
  })

  test('exports pinned stdio MCP server when coding key is present', async () => {
    // given: a GLM Coding Plan agent with the coding key
    const ctx = pluginContext({ defaultProviderId: 'zai-coding', hasSecret: true })

    // when: the plugin factory runs
    const exports = await glmVisionPlugin.plugin(ctx)

    // then: the Z.AI MCP server is wired with Secret object env entries
    const server = exports.mcpServers?.['glm-vision']
    expect(server?.transport.type).toBe('stdio')
    if (server?.transport.type !== 'stdio') throw new Error('glm-vision MCP server did not use stdio')
    expect(server.transport.command).toBe('bunx')
    expect(server.transport.args).toContain('@z_ai/mcp-server@0.1.4')
    expect(server.transport.env?.Z_AI_API_KEY).toEqual({ env: 'ZAI_CODING_API_KEY' })
    expect(server.transport.env?.Z_AI_MODE).toEqual({ value: 'ZAI' })
    await withZaiCodingKey('present', async () => {
      const result = await exports.doctorChecks?.['coding-key']?.run(doctorContext())
      expect(result?.status).toBe('ok')
    })
  })

  test('activates when a non-default profile uses zai-coding', async () => {
    // given: default runs a non-GLM provider but the deep profile uses the Coding Plan
    const ctx = pluginContext({
      models: stubPluginModels({
        defaultProviderId: 'openai',
        profiles: [{ profile: 'deep', providerId: 'zai-coding' }],
      }),
      hasSecret: true,
    })

    // when: the plugin factory runs
    const exports = await glmVisionPlugin.plugin(ctx)

    // then: the vision MCP is contributed because some profile uses zai-coding
    expect(exports.mcpServers?.['glm-vision']).toBeDefined()
  })

  test('returns no exports when disabled', async () => {
    // given: a disabled plugin config
    const ctx = pluginContext({
      defaultProviderId: 'zai-coding',
      hasSecret: true,
      config: { enabled: false, version: '0.1.4' },
    })

    // when: the plugin factory runs
    const exports = await glmVisionPlugin.plugin(ctx)

    // then: nothing is contributed
    expect(exports).toEqual({})
  })
})

function pluginContext(options: {
  defaultProviderId?: string
  models?: PluginModels
  hasSecret: boolean
  config?: { enabled: boolean; version: string }
}): PluginContext<{ enabled: boolean; version: string }> {
  return {
    name: 'glm-vision',
    version: undefined,
    agentDir: '/agent',
    config: options.config ?? { enabled: true, version: '0.1.4' },
    models: options.models ?? stubPluginModels({ defaultProviderId: options.defaultProviderId ?? 'fireworks' }),
    hasSecret: (envName) => envName === 'ZAI_CODING_API_KEY' && options.hasSecret,
    logger: noopLogger,
    permissions: noopPermissionService,
    github: {
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
      hasAppTokenResolver: () => false,
    },
    spawnSubagent: async () => {},
  }
}

function doctorContext(): PluginDoctorContext {
  return { pluginName: 'glm-vision', agentDir: '/agent', config: {}, logger: noopLogger }
}

async function withZaiCodingKey(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.ZAI_CODING_API_KEY
  try {
    if (value === undefined) delete process.env.ZAI_CODING_API_KEY
    else process.env.ZAI_CODING_API_KEY = value
    await fn()
  } finally {
    if (previous === undefined) delete process.env.ZAI_CODING_API_KEY
    else process.env.ZAI_CODING_API_KEY = previous
  }
}
