import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import type { ClientMessage, ServerMessage } from '@/shared'

export type ContainerCommandResult = { ok: true; exitCode: number } | { ok: false; exitCode: number; message: string }

export type ContainerProxyOptions = {
  agentDir: string
  commandName: string
  args: unknown
  isolated?: boolean
  stdin?: ReadableStream<Uint8Array>
  stdout?: WritableStream<Uint8Array>
  stderr?: WritableStream<Uint8Array>
  abortSignal?: AbortSignal
  // Explicit parent-origin override. When unset the proxy reads
  // process.env.TYPECLAW_PARENT_ORIGIN_JSON. Tests pass this directly to
  // avoid mutating process.env.
  parentOriginJson?: string
  // Override hooks for tests. When unset, the live host port + token resolvers
  // are used. The websocketFactory is also pluggable so tests can drive a
  // fake server without binding to a real port.
  resolveUrl?: (opts: { agentDir: string }) => Promise<{ url: string } | { error: string }>
  websocketFactory?: (url: string) => WebSocketLike
}

export type WebSocketLike = {
  send: (data: string) => void
  close: () => void
  addEventListener: (
    event: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ) => void
}

export async function proxyContainerCommand(opts: ContainerProxyOptions): Promise<ContainerCommandResult> {
  const urlResolution =
    opts.resolveUrl !== undefined
      ? await opts.resolveUrl({ agentDir: opts.agentDir })
      : await resolveUrlFromDocker(opts.agentDir)
  if ('error' in urlResolution) {
    return { ok: false, exitCode: 2, message: urlResolution.error }
  }

  const callId = crypto.randomUUID()
  const ws =
    opts.websocketFactory !== undefined
      ? opts.websocketFactory(urlResolution.url)
      : (new WebSocket(urlResolution.url) as unknown as WebSocketLike)

  let opened = false
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // Ignore close failures during connect timeout — the original error is
        // already propagating through reject().
      }
      reject(new Error('timed out connecting to agent container WebSocket'))
    }, 5_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      opened = true
      resolve()
    })
    ws.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new Error(String((event as { message?: string }).message ?? 'websocket error')))
    })
    ws.addEventListener('close', () => {
      if (!opened) {
        clearTimeout(timer)
        reject(new Error('websocket closed before open'))
      }
    })
  })

  return new Promise<ContainerCommandResult>((resolve) => {
    let settled = false
    let finalErrorMessage: string | undefined

    const settle = (result: ContainerCommandResult) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // Already closed.
      }
      resolve(result)
    }

    ws.addEventListener('message', (event) => {
      const raw = event.data
      if (typeof raw !== 'string') return
      let parsed: ServerMessage
      try {
        parsed = JSON.parse(raw) as ServerMessage
      } catch {
        return
      }
      if (!('callId' in parsed) || parsed.callId !== callId) return

      if (parsed.type === 'command_stdout' && opts.stdout) {
        void writeChunkBase64(opts.stdout, parsed.chunk)
        return
      }
      if (parsed.type === 'command_stderr' && opts.stderr) {
        void writeChunkBase64(opts.stderr, parsed.chunk)
        return
      }
      if (parsed.type === 'command_error') {
        finalErrorMessage = parsed.message
        return
      }
      if (parsed.type === 'command_exit') {
        if (finalErrorMessage !== undefined) {
          settle({ ok: false, exitCode: parsed.code, message: finalErrorMessage })
        } else {
          settle({ ok: true, exitCode: parsed.code })
        }
        return
      }
    })

    ws.addEventListener('close', () => {
      if (!settled) {
        settle({ ok: false, exitCode: 1, message: finalErrorMessage ?? 'websocket closed before command_exit' })
      }
    })
    ws.addEventListener('error', (event) => {
      if (!settled) {
        const msg = String((event as { message?: string }).message ?? 'websocket error')
        settle({ ok: false, exitCode: 1, message: msg })
      }
    })

    if (opts.abortSignal !== undefined) {
      const onAbort = () => {
        try {
          const abortFrame: ClientMessage = {
            type: 'command_abort',
            callId,
            reason: opts.abortSignal?.reason instanceof Error ? opts.abortSignal.reason.message : 'aborted',
          }
          ws.send(JSON.stringify(abortFrame))
        } catch {
          // Best-effort abort; if the send fails the server will close anyway.
        }
      }
      if (opts.abortSignal.aborted) onAbort()
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // Forward TYPECLAW_PARENT_ORIGIN_JSON verbatim when the surrounding
    // process set it (e.g. a cron exec runner that injected the cron job's
    // origin into the subprocess env). The server uses this as the
    // command's spawnedByOrigin so permission resolution chases through
    // to the parent role instead of defaulting to synthetic-owner.
    const parentOriginJson = opts.parentOriginJson ?? process.env.TYPECLAW_PARENT_ORIGIN_JSON
    const exec: ClientMessage = {
      type: 'exec_command',
      callId,
      name: opts.commandName,
      args: opts.args,
      ...(opts.isolated !== undefined ? { isolated: opts.isolated } : {}),
      ...(parentOriginJson !== undefined && parentOriginJson !== '' ? { parentOriginJson } : {}),
    }
    ws.send(JSON.stringify(exec))

    if (opts.stdin !== undefined) {
      pumpStdin(opts.stdin, (chunk) => {
        const frame: ClientMessage = { type: 'command_stdin', callId, chunk: encodeBase64(chunk) }
        ws.send(JSON.stringify(frame))
      })
        .then(() => {
          const end: ClientMessage = { type: 'command_stdin_end', callId }
          ws.send(JSON.stringify(end))
        })
        .catch((err: unknown) => {
          // Local stdin error: tell the server to abandon the in-flight
          // command so it doesn't wait forever for command_stdin_end, and
          // settle the host-side promise with a clear error. Without this
          // .catch the rejection was silent and the command hung.
          const reason = err instanceof Error ? err.message : String(err)
          try {
            const abortFrame: ClientMessage = {
              type: 'command_abort',
              callId,
              reason: `local stdin error: ${reason}`,
            }
            ws.send(JSON.stringify(abortFrame))
          } catch {
            // ws may have already closed; the close handler will settle below.
          }
          settle({ ok: false, exitCode: 1, message: `local stdin error: ${reason}` })
        })
    }
  })
}

async function resolveUrlFromDocker(agentDir: string): Promise<{ url: string } | { error: string }> {
  const running = await requireContainerRunning({ cwd: agentDir })
  if (!running.ok) {
    return { error: `${running.reason}; start it with \`typeclaw start\`` }
  }
  const port = await resolveHostPort({ cwd: agentDir })
  const token = await resolveTuiToken({ cwd: agentDir })
  // The dedicated /commands path skips TUI session bootstrap on the server,
  // saving an AgentSession creation per command invocation. Same auth as
  // the root /` TUI path; both are owner-equivalent.
  const url = new URL(`ws://127.0.0.1:${port}/commands`)
  if (token !== null) url.searchParams.set('token', token)
  return { url: url.toString() }
}

async function pumpStdin(stream: ReadableStream<Uint8Array>, send: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      send(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function writeChunkBase64(stream: WritableStream<Uint8Array>, chunkBase64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(chunkBase64), (c) => c.charCodeAt(0))
  const writer = stream.getWriter()
  try {
    await writer.write(bytes)
  } finally {
    writer.releaseLock()
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0)
  return btoa(s)
}
