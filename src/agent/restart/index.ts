import { basename } from 'node:path'

import { type RestartHandoffOrigin, writeRestartHandoff } from '@/agent/restart-handoff'
import { send, sendHttp } from '@/hostd/client'
import { containerSocketPath } from '@/hostd/paths'
import type { Stream } from '@/stream'

const ACK_TIMEOUT_MS = 5_000

export type ContainerRestartingBroadcast = {
  kind: 'container-restarting'
  restartedAt: string
  originatingSessionId: string
}

export type RequestContainerRestartOptions = {
  containerName: string
  build?: boolean
  socketPath?: string
  hostdUrl?: string
  hostdToken?: string
  ackTimeoutMs?: number
  // When present together with originatingSessionId, the post-ACK
  // container-restarting broadcast is published here so every live session's
  // subscribeRestartNotice fans out the restart notice (originator gets
  // typeclaw.restart-self, siblings get typeclaw.restart). Both the tool and
  // the server /restart path route through this so the broadcast->handoff
  // ordering lives in one place.
  stream?: Stream
  agentDir?: string
  originatingSessionId?: string
  originatingSessionFile?: string
  // Origin metadata persisted into the handoff so the next boot routes the
  // resume to the right subsystem (tui → websocket open; channel → router
  // startup). Required alongside agentDir + originatingSessionFile for the
  // handoff to be written; omitting it skips the handoff entirely.
  handoffOrigin?: RestartHandoffOrigin
  restartedAt?: string
}

export type RequestContainerRestartResult =
  | { ok: true; containerName: string; restartedAt: string }
  | { ok: false; containerName: string; reason: string }

export async function requestContainerRestart({
  containerName,
  build,
  socketPath,
  hostdUrl,
  hostdToken,
  ackTimeoutMs,
  stream,
  agentDir,
  originatingSessionId,
  originatingSessionFile,
  handoffOrigin,
  restartedAt,
}: RequestContainerRestartOptions): Promise<RequestContainerRestartResult> {
  const request = { kind: 'restart' as const, containerName, build: build === true }
  const httpUrl = hostdUrl ?? process.env.TYPECLAW_HOSTD_URL
  const httpToken = hostdToken ?? process.env.TYPECLAW_HOSTD_TOKEN
  const ackBudget = ackTimeoutMs ?? ACK_TIMEOUT_MS
  const reply =
    httpUrl && httpToken
      ? await sendHttp(request, { timeoutMs: ackBudget, url: httpUrl, token: httpToken })
      : await send(request, { timeoutMs: ackBudget, socket: socketPath ?? containerSocketPath() })

  if (!reply.ok) return { ok: false, containerName, reason: reply.reason }

  const restartTimestamp = restartedAt ?? new Date().toISOString()

  // Fan out the restart notice to every live session BEFORE writing the handoff.
  // The originating session's subscribeRestartNotice appends the
  // typeclaw.restart-self entry synchronously (broker delivery + the JSONL
  // append are both synchronous), so the handoff below points at a JSONL that
  // already carries the "I'm back" instruction the rebooted container hydrates.
  // Only after an accepted ACK, never on a failed/timed-out restart.
  if (stream !== undefined && originatingSessionId !== undefined) {
    const broadcast: ContainerRestartingBroadcast = {
      kind: 'container-restarting',
      restartedAt: restartTimestamp,
      originatingSessionId,
    }
    stream.publish({ target: { kind: 'broadcast' }, payload: broadcast })
  }

  // Post-ACK: hostd has committed the restart, so a handoff-write failure must
  // never demote it to a failure — that would render a false error in the TUI
  // and swallow the accepted response. The handoff is a best-effort resume hint
  // only; a missing one just cold-starts the rebooted container without the
  // "I'm back" greeting. writeRestartHandoff swallows its own errors today, but
  // guard here too so this contract survives the writer being changed later.
  if (
    agentDir !== undefined &&
    originatingSessionId !== undefined &&
    originatingSessionFile !== undefined &&
    handoffOrigin !== undefined
  ) {
    try {
      await writeRestartHandoff(agentDir, {
        schemaVersion: 2,
        restartedAt: restartTimestamp,
        originatingSessionId,
        originatingSessionFile: basename(originatingSessionFile),
        origin: handoffOrigin,
      })
    } catch {
      // intentional swallow — see the post-ACK rationale above
    }
  }

  return { ok: true, containerName, restartedAt: restartTimestamp }
}
