import { existsSync } from 'node:fs'

import type { Socket } from 'bun'

import { socketPath } from './paths'
import type { Request, Response } from './protocol'

const DEFAULT_TIMEOUT_MS = 3_000

export async function isDaemonReachable(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  if (!existsSync(socketPath())) return false
  try {
    const reply = await send({ kind: 'list' }, { timeoutMs })
    return reply.ok
  } catch {
    return false
  }
}

export type SendOptions = {
  timeoutMs?: number
  socket?: string
}

export async function send(req: Request, opts: SendOptions = {}): Promise<Response> {
  const path = opts.socket ?? socketPath()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  type State = { buf: string; resolve: (r: Response) => void }
  const state: State = {
    buf: '',
    resolve: () => {},
  }

  const replyPromise = new Promise<Response>((resolve) => {
    state.resolve = resolve
  })

  let sock: Socket<State>
  try {
    sock = await Bun.connect<State>({
      unix: path,
      socket: {
        data: (s, chunk) => {
          s.data.buf += chunk.toString('utf8')
          const newline = s.data.buf.indexOf('\n')
          if (newline < 0) return
          const line = s.data.buf.slice(0, newline)
          try {
            const parsed = JSON.parse(line) as Response
            s.data.resolve(parsed)
          } catch {
            s.data.resolve({ ok: false, reason: 'invalid response from daemon' })
          }
          s.end()
        },
        close: () => {},
        error: () => {
          state.resolve({ ok: false, reason: 'socket error' })
        },
      },
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  sock.data = state
  sock.write(`${JSON.stringify(req)}\n`)

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<Response>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `daemon ack timeout after ${timeoutMs}ms` }), timeoutMs)
  })
  try {
    return await Promise.race([replyPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
    try {
      sock.end()
    } catch {}
  }
}
