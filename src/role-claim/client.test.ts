import { afterEach, describe, expect, test } from 'bun:test'

import type { Server } from 'bun'

import type { ClaimCompletedPayload, ClaimStartedPayload, ClientMessage, ServerMessage } from '@/shared'

import { runClaimSession } from './client'

type RaceServer = Server<{ ready: boolean }>
let server: RaceServer | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

type ServeOptions = {
  openDelayMs: number
  emitConnected?: boolean
}

function serveRaceProneClaim(opts: ServeOptions): RaceServer {
  return Bun.serve<{ ready: boolean }>({
    port: 0,
    fetch(req, s) {
      const data = { ready: false }
      if (s.upgrade(req, { data })) return
      return new Response('typeclaw agent', { status: 200 })
    },
    websocket: {
      async open(ws) {
        await new Promise((r) => setTimeout(r, opts.openDelayMs))
        ws.data.ready = true
        if (opts.emitConnected !== false) {
          const msg: ServerMessage = { type: 'connected', sessionId: 'sid-test' }
          ws.send(JSON.stringify(msg))
        }
      },
      message(ws, raw) {
        const parsed = JSON.parse(String(raw)) as ClientMessage
        if (!ws.data.ready) return
        handleClientMessage(ws, parsed)
      },
    },
  })
}

function handleClientMessage(
  ws: Parameters<NonNullable<Parameters<typeof Bun.serve>[0]['websocket']>['message']>[0] & {
    data: { ready: boolean }
  },
  msg: ClientMessage,
): void {
  if (msg.type !== 'claim_start') return
  const startedPayload: ClaimStartedPayload = {
    code: msg.code,
    role: msg.role,
    expiresAt: Date.now() + msg.ttlMs,
  }
  ws.send(JSON.stringify({ type: 'claim_started', payload: startedPayload } satisfies ServerMessage))
  const completedPayload: ClaimCompletedPayload = {
    code: msg.code,
    role: msg.role,
    matchRule: 'discord:test',
    adapter: 'discord-bot',
    authorId: 'U_TEST',
  }
  ws.send(JSON.stringify({ type: 'claim_completed', payload: completedPayload } satisfies ServerMessage))
}

describe('runClaimSession', () => {
  test("doesn't race with the server's slow open path", async () => {
    // given: a server whose `open` takes 100ms (modeling createSession during
    // hatching). Pre-`connected` messages are dropped, mirroring production.
    server = serveRaceProneClaim({ openDelayMs: 100 })
    const port = server.port

    // when: client runs the full claim session
    let onStartedFired = false
    const result = await runClaimSession({
      url: `ws://127.0.0.1:${port}`,
      role: 'owner',
      ttlMs: 500,
      onStarted: () => {
        onStartedFired = true
      },
    })

    expect(onStartedFired).toBe(true)
    expect(result.kind).toBe('completed')
  })

  test('times out the connect handshake if connected never arrives', async () => {
    // given: a server that accepts the upgrade but never sends `connected`
    server = serveRaceProneClaim({ openDelayMs: 0, emitConnected: false })
    const port = server.port

    // when: client runs with a short connect timeout
    // then: the session rejects with a clear error rather than hanging on ttl
    await expect(
      runClaimSession({
        url: `ws://127.0.0.1:${port}`,
        role: 'owner',
        ttlMs: 60_000,
        connectTimeoutMs: 200,
      }),
    ).rejects.toThrow(/connected/i)
  })
})
