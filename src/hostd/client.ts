import { existsSync } from 'node:fs'
import { connect, type Socket as NetSocket } from 'node:net'

import { isWindows } from '@/shared'

import { socketPath } from './paths'
import type { Request, Response } from './protocol'

const DEFAULT_TIMEOUT_MS = 3_000

export async function isDaemonReachable(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  opts: Pick<SendOptions, 'socket'> = {},
): Promise<boolean> {
  const path = opts.socket ?? socketPath()
  if (!isWindows() && !existsSync(path)) return false
  try {
    const reply = await send({ kind: 'list' }, { timeoutMs, socket: path })
    return reply.ok
  } catch {
    return false
  }
}

export type SendOptions = {
  timeoutMs?: number
  socket?: string
}

export type SendHttpOptions = {
  timeoutMs?: number
  url: string
  token: string
}

export async function sendHttp(req: Request, opts: SendHttpOptions): Promise<Response> {
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(new URL('/rpc', opts.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    const parsed = (await res.json()) as Response
    return parsed
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, reason: `daemon ack timeout after ${timeoutMs}ms` }
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function send(req: Request, opts: SendOptions = {}): Promise<Response> {
  const path = opts.socket ?? socketPath()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<Response>((resolve) => {
    let buf = ''
    let settled = false
    let sock: NetSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (response: Response, destroy = false): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (sock) {
        try {
          if (destroy) sock.destroy()
          else sock.end()
        } catch {}
      }
      resolve(response)
    }

    timer = setTimeout(() => finish({ ok: false, reason: `daemon ack timeout after ${timeoutMs}ms` }, true), timeoutMs)
    sock = connect(path)
    sock.on('connect', () => {
      try {
        sock?.write(`${JSON.stringify(req)}\n`)
      } catch (error) {
        finish({ ok: false, reason: error instanceof Error ? error.message : String(error) }, true)
      }
    })
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const newline = buf.indexOf('\n')
      if (newline < 0) return
      const line = buf.slice(0, newline)
      try {
        finish(JSON.parse(line) as Response)
      } catch {
        finish({ ok: false, reason: 'invalid response from daemon' }, true)
      }
    })
    sock.on('error', (error) => {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error) }, true)
    })
  })
}
