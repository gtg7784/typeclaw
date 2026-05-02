import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
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

type State = { buf: string }

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

  test('roundtrips a register request through a real Unix socket server', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'run'), { recursive: true })

    let received: Request | null = null
    const listener = Bun.listen<State>({
      unix: socketPath(),
      socket: {
        open: (s) => {
          s.data = { buf: '' }
        },
        data: (s, chunk) => {
          s.data.buf += chunk.toString('utf8')
          const newline = s.data.buf.indexOf('\n')
          if (newline < 0) return
          const line = s.data.buf.slice(0, newline)
          received = JSON.parse(line) as Request
          s.write(`${JSON.stringify({ ok: true, result: { echoed: received } })}\n`)
          s.end()
        },
        close: () => {},
        error: () => {},
      },
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
      listener.stop(true)
    }
  })

  test('times out if the daemon never responds', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'run'), { recursive: true })

    const listener = Bun.listen<State>({
      unix: socketPath(),
      socket: {
        open: (s) => {
          s.data = { buf: '' }
        },
        data: () => {},
        close: () => {},
        error: () => {},
      },
    })
    try {
      const reply = await send({ kind: 'list' }, { timeoutMs: 50 })
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.reason).toContain('timeout')
    } finally {
      listener.stop(true)
    }
  })

  test('isDaemonReachable returns true when the daemon answers list', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'run'), { recursive: true })

    const listener = Bun.listen<State>({
      unix: socketPath(),
      socket: {
        open: (s) => {
          s.data = { buf: '' }
        },
        data: (s, chunk) => {
          s.data.buf += chunk.toString('utf8')
          const newline = s.data.buf.indexOf('\n')
          if (newline < 0) return
          s.write(`${JSON.stringify({ ok: true, result: { registrations: [] } })}\n`)
          s.end()
        },
        close: () => {},
        error: () => {},
      },
    })
    try {
      expect(await isDaemonReachable(500)).toBe(true)
    } finally {
      listener.stop(true)
    }
  })
})
