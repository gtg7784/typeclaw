import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createPluginContext, createPluginLogger } from '@/plugin/context'

import agentBrowserPlugin, { __resetProxyForTesting } from './index'

beforeEach(() => {
  process.env['TYPECLAW_DASHBOARD_PROXY_PORT'] = '0'
  process.env['TYPECLAW_DASHBOARD_UPSTREAM_PORT'] = '0'
})

afterEach(() => {
  __resetProxyForTesting()
  delete process.env['TYPECLAW_DASHBOARD_PROXY_PORT']
  delete process.env['TYPECLAW_DASHBOARD_UPSTREAM_PORT']
})

describe('agent-browser plugin', () => {
  test('contributes the agent-browser skill directory and no hooks/tools', async () => {
    const exports = await bootPlugin('/agent')

    expect(exports.skillsDirs).toEqual([expect.stringContaining('plugins/agent-browser/skills')])
    expect(exports.tools).toBeUndefined()
    expect(exports.hooks).toBeUndefined()
  })

  test('binds the dashboard proxy on the configured port at agent boot', async () => {
    const messages: string[] = []
    const logger = {
      info: (msg: string) => messages.push(`info:${msg}`),
      warn: (msg: string) => messages.push(`warn:${msg}`),
      error: (msg: string) => messages.push(`error:${msg}`),
    }

    await agentBrowserPlugin.plugin(
      createPluginContext({
        name: 'agent-browser',
        version: undefined,
        agentDir: '/agent',
        config: undefined,
        logger,
        spawnSubagent: async () => {},
        isBooted: () => true,
      }),
    )

    expect(messages.some((m) => m.startsWith('info:dashboard proxy listening on port '))).toBe(true)
  })
})

async function bootPlugin(agentDir: string) {
  return agentBrowserPlugin.plugin(
    createPluginContext({
      name: 'agent-browser',
      version: undefined,
      agentDir,
      config: undefined,
      logger: createPluginLogger('agent-browser'),
      spawnSubagent: async () => {},
      isBooted: () => true,
    }),
  )
}
