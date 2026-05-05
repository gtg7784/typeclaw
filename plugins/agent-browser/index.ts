import { join } from 'node:path'

import { z } from 'zod'

import { definePlugin, defineTool } from '@/plugin'

import { startAgentBrowserDashboardProxy, type AgentBrowserDashboardProxy } from './dashboard-proxy'

export const DASHBOARD_TOOL_NAME = 'agent_browser_dashboard'
const DASHBOARD_PROXY_PORT = 4848

const DASHBOARD_REWRITE_INSTRUCTION = `# agent-browser dashboard override

When the user asks for the agent-browser dashboard, or when you would run \`agent-browser dashboard\`, do not execute the raw dashboard command. Use the \`${DASHBOARD_TOOL_NAME}\` tool instead. That tool starts the real dashboard behind a TypeClaw compatibility proxy so remote/Tailscale dashboard URLs work.`

export default definePlugin({
  plugin: async () => {
    let dashboard: AgentBrowserDashboardProxy | null = null

    const dashboardTool = defineTool({
      description:
        'Start, stop, or inspect the TypeClaw-compatible agent-browser dashboard proxy. Use this instead of running raw `agent-browser dashboard`.',
      parameters: z.object({
        action: z.enum(['start', 'stop', 'status']).optional().describe('Dashboard action. Defaults to start.'),
      }),
      async execute(args) {
        const action = args.action ?? 'start'

        if (action === 'status') {
          const text = dashboard === null ? 'agent-browser dashboard is stopped.' : dashboardStatus(dashboard)
          return { content: [{ type: 'text', text }] }
        }

        if (action === 'stop') {
          if (dashboard !== null) {
            await dashboard.stop()
            dashboard = null
          }
          return { content: [{ type: 'text', text: 'agent-browser dashboard stopped.' }] }
        }

        if (dashboard === null) dashboard = await startAgentBrowserDashboardProxy()
        return { content: [{ type: 'text', text: dashboardStatus(dashboard) }] }
      },
    })

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
      tools: { [DASHBOARD_TOOL_NAME]: dashboardTool },
      hooks: {
        'session.prompt': (event) => {
          event.prompt = `${event.prompt}\n\n${DASHBOARD_REWRITE_INSTRUCTION}`
        },
        'tool.before': (event) => {
          if (event.tool !== 'bash') return
          const command = event.args.command
          if (typeof command !== 'string' || !isRawAgentBrowserDashboardCommand(command)) return
          return {
            block: true,
            reason: `Use the ${DASHBOARD_TOOL_NAME} plugin tool instead of raw agent-browser dashboard.`,
          }
        },
      },
    }
  },
})

function dashboardStatus(dashboard: AgentBrowserDashboardProxy): string {
  const port = dashboard.proxy.server.port ?? DASHBOARD_PROXY_PORT
  return `agent-browser dashboard is running through the TypeClaw proxy on port ${port}. Open the externally visible :${port} URL.`
}

export function isRawAgentBrowserDashboardCommand(command: string): boolean {
  return command.split(/&&|;|\n/).some((part) => /^\s*(?:bunx\s+|npx\s+)?agent-browser\s+dashboard(?:\s|$)/.test(part))
}
