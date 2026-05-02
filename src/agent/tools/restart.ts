import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { send, sendHttp } from '@/hostd/client'
import { containerSocketPath } from '@/hostd/paths'

const ACK_TIMEOUT_MS = 5_000
const EXIT_DELAY_MS = 500

export type CreateRestartToolOptions = {
  containerName: string
  exit?: (code: number) => void
  socketPath?: string
  hostdUrl?: string
  hostdToken?: string
}

export type RestartToolDetails = { ok: boolean; containerName: string; reason?: string }

export function createRestartTool({ containerName, exit, socketPath, hostdUrl, hostdToken }: CreateRestartToolOptions) {
  const doExit = exit ?? ((code: number) => process.exit(code))
  const httpUrl = hostdUrl ?? process.env.TYPECLAW_HOSTD_URL
  const httpToken = hostdToken ?? process.env.TYPECLAW_HOSTD_TOKEN

  return defineTool({
    name: 'restart',
    label: 'Restart Container',
    description:
      'Restart the typeclaw container this agent is running in. The host daemon ACKs the request, ' +
      'this process exits, and the host daemon then runs `typeclaw stop` followed by `typeclaw start` ' +
      'for the agent folder. Use when on-disk source has changed in a way that `reload` cannot pick up — ' +
      'e.g. the typeclaw CLI itself was updated, the Dockerfile template changed, or a boot-only config ' +
      'field needs to take effect (port, mounts, plugins). The current session is lost; the ' +
      'TUI must reconnect after the new container is up.',
    parameters: Type.Object({}),
    execute: async () => {
      const request = { kind: 'restart' as const, containerName }
      const reply =
        httpUrl && httpToken
          ? await sendHttp(request, { timeoutMs: ACK_TIMEOUT_MS, url: httpUrl, token: httpToken })
          : await send(request, { timeoutMs: ACK_TIMEOUT_MS, socket: socketPath ?? containerSocketPath() })
      if (!reply.ok) {
        const details: RestartToolDetails = { ok: false, containerName, reason: reply.reason }
        return {
          content: [{ type: 'text' as const, text: `restart denied: ${reply.reason}` }],
          details,
        }
      }

      // Schedule the exit on the next tick so the tool result is delivered to
      // the model before the process dies. The host daemon polls for the
      // container's removal before re-running `start`, so a small delay here
      // does not gate the restart end-to-end.
      setTimeout(() => doExit(0), EXIT_DELAY_MS)

      const details: RestartToolDetails = { ok: true, containerName }
      return {
        content: [
          {
            type: 'text' as const,
            text: `restart scheduled for ${containerName}; this process will exit shortly and a new container will be started by the host daemon.`,
          },
        ],
        details,
      }
    },
  })
}
