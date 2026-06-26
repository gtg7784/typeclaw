import { describe, expect, test } from 'bun:test'

import { noopPermissionService } from '@/permissions'
import type { HookContext, PluginContext, ToolBeforeEvent } from '@/plugin'
import { stubPluginModels } from '@/plugin/test-support'

import bunHygienePlugin from './index'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('bun-hygiene plugin', () => {
  test('blocks global installs through the tool.before hook', async () => {
    const hook = await toolBeforeHook()

    const result = await hook(toolEvent('bash', { command: 'npm install -g typescript' }), hookContext())

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('globalInstall')
  })

  test('blocks non-bun install managers and allows bun + ephemeral runners through the hook', async () => {
    const hook = await toolBeforeHook()

    const blocked = await hook(toolEvent('bash', { command: 'npm install' }), hookContext())
    const allowedBunx = await hook(toolEvent('bash', { command: 'bunx create-next-app' }), hookContext())
    const allowedNpx = await hook(toolEvent('bash', { command: 'npx create-next-app' }), hookContext())

    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('nonBunPackageManager')
    expect(allowedBunx).toBeUndefined()
    expect(allowedNpx).toBeUndefined()
  })

  test('respects the acknowledgeGuards bypass', async () => {
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent('bash', { command: 'npm install', acknowledgeGuards: { nonBunPackageManager: true } }),
      hookContext(),
    )

    expect(result).toBeUndefined()
  })
})

async function toolBeforeHook(): Promise<
  NonNullable<NonNullable<Awaited<ReturnType<typeof bunHygienePlugin.plugin>>['hooks']>['tool.before']>
> {
  const exports = await bunHygienePlugin.plugin(pluginContext())
  const hook = exports.hooks?.['tool.before']
  if (!hook) throw new Error('bun-hygiene plugin did not register tool.before')
  return hook
}

function toolEvent(tool: string, args: Record<string, unknown>): ToolBeforeEvent {
  return { tool, sessionId: 's', callId: 'c', args }
}

function hookContext(): HookContext {
  return { agentDir: '/agent', pluginName: 'bun-hygiene', logger: noopLogger }
}

function pluginContext(): PluginContext<undefined> {
  return {
    name: 'bun-hygiene',
    version: undefined,
    agentDir: '/agent',
    config: undefined,
    models: stubPluginModels({ defaultProviderId: 'fireworks' }),
    hasSecret: () => false,
    logger: noopLogger,
    permissions: noopPermissionService,
    github: {
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
      hasAppTokenResolver: () => false,
    },
    spawnSubagent: async () => {},
  }
}
