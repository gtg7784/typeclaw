import { describe, expect, test } from 'bun:test'

import { createPluginContext, createPluginLogger } from '@/plugin/context'

import agentBrowserPlugin, { DASHBOARD_TOOL_NAME, isRawAgentBrowserDashboardCommand } from './index'

describe('agent-browser plugin', () => {
  test('contributes the agent-browser skill directory', async () => {
    const exports = await bootPlugin('/agent')

    expect(exports.skillsDirs).toEqual([expect.stringContaining('plugins/agent-browser/skills')])
  })

  test('injects a prompt-level replacement for raw agent-browser dashboard', async () => {
    const exports = await bootPlugin('/agent')
    const event = { prompt: 'open the browser dashboard', sessionId: 'ses_test', agentDir: '/agent' }

    await exports.hooks?.['session.prompt']?.(event, {
      agentDir: '/agent',
      pluginName: 'agent-browser',
      logger: createPluginLogger('agent-browser'),
    })

    expect(event.prompt).toContain('do not execute the raw dashboard command')
    expect(event.prompt).toContain('agent-browser dashboard')
    expect(event.prompt).toContain(DASHBOARD_TOOL_NAME)
  })

  test('contributes a dashboard tool with stopped status before start', async () => {
    const exports = await bootPlugin('/agent')
    const tool = exports.tools?.[DASHBOARD_TOOL_NAME]

    const result = await tool?.execute({ action: 'status' }, toolContext())

    expect(result?.content[0]?.type).toBe('text')
    expect(result?.content[0]?.type === 'text' ? result.content[0].text : '').toContain('stopped')
  })

  test('blocks raw agent-browser dashboard bash commands', async () => {
    const exports = await bootPlugin('/agent')
    const block = await exports.hooks?.['tool.before']?.(
      { tool: 'bash', sessionId: 'ses_test', callId: 'call_test', args: { command: 'agent-browser dashboard' } },
      { agentDir: '/agent', pluginName: 'agent-browser', logger: createPluginLogger('agent-browser') },
    )

    expect(block).toEqual({
      block: true,
      reason: `Use the ${DASHBOARD_TOOL_NAME} plugin tool instead of raw agent-browser dashboard.`,
    })
  })

  test.each(['agent-browser dashboard', 'npx agent-browser dashboard start', 'echo ok && agent-browser dashboard'])(
    'detects raw dashboard command: %s',
    (command) => {
      expect(isRawAgentBrowserDashboardCommand(command)).toBe(true)
    },
  )

  test.each(['agent-browser open https://example.com', 'echo agent-browser dashboard', 'my-agent-browser dashboard'])(
    'allows non-dashboard command: %s',
    (command) => {
      expect(isRawAgentBrowserDashboardCommand(command)).toBe(false)
    },
  )
})

function toolContext() {
  return {
    signal: undefined,
    sessionId: 'ses_test',
    agentDir: '/agent',
    logger: createPluginLogger('agent-browser'),
  }
}

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
