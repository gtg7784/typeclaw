import { afterEach, describe, expect, test } from 'bun:test'

import type { Server as BunServer, ServerWebSocket } from 'bun'

import type { ClientMessage, ServerMessage } from '@/shared'

import { requestReload } from './client'
import type { ReloadResult } from './types'

type WsData = Record<string, never>

let server: BunServer<WsData> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function startStubServer(handler: (msg: ClientMessage, send: (m: ServerMessage) => void) => void): {
  url: string
} {
  const bunServer = Bun.serve<WsData>({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: {} as WsData })) return
      return new Response('stub', { status: 200 })
    },
    websocket: {
      message(ws: ServerWebSocket<WsData>, raw) {
        const msg = JSON.parse(String(raw)) as ClientMessage
        handler(msg, (m) => ws.send(JSON.stringify(m)))
      },
      open() {},
      close() {},
    },
  })
  server = bunServer
  return { url: `ws://localhost:${bunServer.port}` }
}

describe('requestReload', () => {
  test('sends a reload message and returns the parsed results', async () => {
    const expected: ReloadResult[] = [{ scope: 'cron', ok: true, summary: 'cron reloaded (added 1)' }]
    const { url } = startStubServer((msg, send) => {
      expect(msg.type).toBe('reload')
      send({ type: 'reload_result', results: expected })
    })

    const results = await requestReload({ url })

    expect(results).toEqual(expected)
  })

  test('passes scope through when provided', async () => {
    const box: { received: ClientMessage | null } = { received: null }
    const { url } = startStubServer((msg, send) => {
      box.received = msg
      send({ type: 'reload_result', results: [{ scope: 'cron', ok: true, summary: 'ok' }] })
    })

    await requestReload({ url, scope: 'cron' })

    expect(box.received).toEqual({ type: 'reload', scope: 'cron' })
  })

  test('omits scope from the wire when not provided', async () => {
    const box: { received: ClientMessage | null } = { received: null }
    const { url } = startStubServer((msg, send) => {
      box.received = msg
      send({ type: 'reload_result', results: [] })
    })

    await requestReload({ url })

    expect(box.received).toEqual({ type: 'reload' })
  })

  test('returns failure results unchanged for the caller to format', async () => {
    const { url } = startStubServer((_msg, send) => {
      send({
        type: 'reload_result',
        results: [{ scope: 'cron', ok: false, reason: 'bad json on line 4' }],
      })
    })

    const results = await requestReload({ url })

    expect(results).toEqual([{ scope: 'cron', ok: false, reason: 'bad json on line 4' }])
  })

  test('rejects when the server cannot be reached', async () => {
    await expect(requestReload({ url: 'ws://localhost:1', timeoutMs: 200 })).rejects.toThrow()
  })

  test('redacts tokenized URLs in connection errors', async () => {
    try {
      await requestReload({ url: 'ws://localhost:1?token=secret-token', timeoutMs: 200 })
      throw new Error('expected requestReload to reject')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain('token=%3Credacted%3E')
      expect(message).not.toContain('secret-token')
    }
  })

  test('rejects when no reload_result arrives before the timeout', async () => {
    const { url } = startStubServer(() => {})

    await expect(requestReload({ url, timeoutMs: 200 })).rejects.toThrow(/timed out/i)
  })
})
