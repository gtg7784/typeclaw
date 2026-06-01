import { basename } from 'node:path'

import { writeRestartHandoff } from '@/agent/restart-handoff'
import { send, sendHttp } from '@/hostd/client'
import { containerSocketPath } from '@/hostd/paths'

const ACK_TIMEOUT_MS = 5_000

export type RequestContainerRestartOptions = {
  containerName: string
  build?: boolean
  socketPath?: string
  hostdUrl?: string
  hostdToken?: string
  ackTimeoutMs?: number
  agentDir?: string
  originatingSessionId?: string
  originatingSessionFile?: string
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
  agentDir,
  originatingSessionId,
  originatingSessionFile,
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
  if (agentDir !== undefined && originatingSessionId !== undefined && originatingSessionFile !== undefined) {
    await writeRestartHandoff(agentDir, {
      schemaVersion: 1,
      restartedAt: restartTimestamp,
      originatingSessionId,
      originatingSessionFile: basename(originatingSessionFile),
    })
  }

  return { ok: true, containerName, restartedAt: restartTimestamp }
}
