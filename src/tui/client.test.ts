import { afterEach, describe, expect, test } from 'bun:test'

import { createClient } from './client'

let server: ReturnType<typeof Bun.serve<undefined>> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function serveEcho(frameOnOpen?: unknown): ReturnType<typeof Bun.serve<undefined>> {
  return Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return
      return new Response('ok')
    },
    websocket: {
      open(ws) {
        if (frameOnOpen !== undefined) ws.send(JSON.stringify(frameOnOpen))
      },
      message(ws, data) {
        ws.send(String(data))
      },
    },
  })
}

describe('createClient', () => {
  test('delivers messages sent during ws.open() to late-attached listeners', async () => {
    // given: server sends a frame inside its open handler
    server = serveEcho({ type: 'connected', sessionId: 'sid-1' })

    // when: client connects, yields several microtasks (simulating downstream
    // awaits in the tui layer), and only then registers a listener
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

    // then: the early frame is delivered to the late listener
    expect(received).toEqual({ type: 'connected', sessionId: 'sid-1' })

    client.close()
  })

  test('delivers messages to listeners registered before the message arrives', async () => {
    // given: a server that echoes whatever the client sends
    server = serveEcho()
    const client = await createClient(`ws://localhost:${server.port}`)

    // when: listener is registered first, then a round-trip happens
    const received = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no echo received')), 2000)
      client.onMessage((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
    client.send({ type: 'prompt', text: 'hello' })

    // then
    expect(await received).toEqual({ type: 'prompt', text: 'hello' })

    client.close()
  })
})
