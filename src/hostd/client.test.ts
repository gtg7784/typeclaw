import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isDaemonReachable, send } from './client'
import { socketPath } from './paths'
import type { Request } from './protocol'

let home: string
let prev: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-client-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
})

afterEach(async () => {
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen(path, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function startSocketServer(onRequest: (socket: NetSocket, req: Request) => void): Promise<Server> {
  await mkdir(join(home, 'run'), { recursive: true })

  const server = createServer((socket) => {
    let buf = ''
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const newline = buf.indexOf('\n')
      if (newline < 0) return
      const line = buf.slice(0, newline)
      onRequest(socket, JSON.parse(line) as Request)
    })
    socket.on('error', () => {})
  })
  await listen(server, socketPath())
  return server
}

describe('isDaemonReachable', () => {
  test('returns false when no socket file exists', async () => {
    expect(await isDaemonReachable(50)).toBe(false)
  })
})

describe('send', () => {
  test('returns failure when daemon socket is missing', async () => {
    const reply = await send({ kind: 'list' }, { timeoutMs: 50 })
    expect(reply.ok).toBe(false)
  })

  test('roundtrips a register request through a real local socket server', async () => {
    let received: Request | null = null
    const listener = await startSocketServer((socket, req) => {
      received = req
      socket.write(`${JSON.stringify({ ok: true, result: { echoed: received } })}\n`)
      socket.end()
    })
    try {
      const reply = await send({ kind: 'register', containerName: 'coder', cwd: '/tmp/x' })
      expect(reply.ok).toBe(true)
      if (!reply.ok) return
      expect((reply.result as { echoed: Request }).echoed).toEqual({
        kind: 'register',
        containerName: 'coder',
        cwd: '/tmp/x',
      })
    } finally {
      await closeServer(listener)
    }
  })

  test('times out if the daemon never responds', async () => {
    const listener = await startSocketServer(() => {})
    try {
      const reply = await send({ kind: 'list' }, { timeoutMs: 50 })
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.reason).toContain('timeout')
    } finally {
      await closeServer(listener)
    }
  })

  test('isDaemonReachable returns true when the daemon answers list', async () => {
    const listener = await startSocketServer((socket) => {
      socket.write(`${JSON.stringify({ ok: true, result: { registrations: [] } })}\n`)
      socket.end()
    })
    try {
      expect(await isDaemonReachable(500)).toBe(true)
    } finally {
      await closeServer(listener)
    }
  })
})
