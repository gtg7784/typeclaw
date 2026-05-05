import { describe, expect, test } from 'bun:test'

import { createPluginContext, createPluginLogger } from '@/plugin/context'

import agentBrowserPlugin from './index'

describe('agent-browser plugin', () => {
  test('contributes the agent-browser skill directory', async () => {
    const exports = await bootPlugin('/agent')

    expect(exports.skillsDirs).toEqual([expect.stringContaining('plugins/agent-browser/skills')])
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
