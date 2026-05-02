import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { send, sendHttp } from '@/hostd/client'
import { containerSocketPath } from '@/hostd/paths'
import type { Stream } from '@/stream'

const ACK_TIMEOUT_MS = 5_000
const EXIT_DELAY_MS = 500

export type CreateRestartToolOptions = {
  containerName: string
  exit?: (code: number) => void
  socketPath?: string
  hostdUrl?: string
  hostdToken?: string
  // Optional so unit tests and ad-hoc tool construction keep working without
  // building a Stream. In production wiring, every live AgentSession's
  // broadcast subscriber turns this signal into a transcript entry.
  stream?: Stream
  // Identifies the session whose `restart` tool execution fired the broadcast.
  // Subscribers compare against their own SessionManager.getSessionId() to
  // pick the right notice variant (proactive-confirmation for the originator,
  // do-not-acknowledge for siblings). Required when stream is set; without it
  // every session would get the sibling notice and the originator would never
  // confirm restart completion proactively — the exact bug this dispatch
  // fixes. Required even when stream is absent so the type stays simple and
  // the field's presence documents the runtime contract.
  originatingSessionId: string
}

export type RestartToolDetails = { ok: boolean; containerName: string; reason?: string }

export type ContainerRestartingBroadcast = {
  kind: 'container-restarting'
  restartedAt: string
  originatingSessionId: string
}

export function createRestartTool({
  containerName,
  exit,
  socketPath,
  hostdUrl,
  hostdToken,
  stream,
  originatingSessionId,
}: CreateRestartToolOptions) {
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

      // Hostd ACK == restart is committed. Fan out the notice to every live
      // session BEFORE arming the exit timer. Stream broker delivery is
      // synchronous (broker.ts deliver()) and SessionManager.appendCustomMessageEntry
      // does a synchronous JSONL write, so the fan-out completes inside this
      // tick — well before the EXIT_DELAY_MS timer fires.
      const broadcast: ContainerRestartingBroadcast = {
        kind: 'container-restarting',
        restartedAt: new Date().toISOString(),
        originatingSessionId,
      }
      stream?.publish({ target: { kind: 'broadcast' }, payload: broadcast })

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
