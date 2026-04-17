import { afterEach, describe, expect, test } from 'bun:test'

import { createClient } from './client'

let server: ReturnType<typeof Bun.serve<undefined>> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

describe('createClient', () => {
  test('delivers messages sent during ws.open() to late-attached listeners', async () => {
    // given: a server that sends a frame inside its open handler
    server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return
        return new Response('ok')
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: 'connected', sessionId: 'sid-1' }))
        },
        message() {},
      },
    })

    // when: the client connects, yields several microtasks (simulating
    // downstream `.catch()` chains and awaits in the tui layer), and only
    // then registers a listener
    const client = await createClient(`ws://localhost:${server.port}`)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 50))

    const received = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message received')), 2000)
      client.onMessage((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })

    // then: the early `connected` frame is delivered to the late listener
    expect(received).toEqual({ type: 'connected', sessionId: 'sid-1' })

    client.close()
  })
})
