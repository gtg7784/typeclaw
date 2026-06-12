import { describe, expect, it } from 'bun:test'

import { isUpstreamReachable } from './upstream-probe'

describe('isUpstreamReachable', () => {
  it('resolves true when a server is listening on the port', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
    const port = server.port!
    try {
      expect(await isUpstreamReachable(port)).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  it('resolves false when nothing is listening on the port', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') })
    const closedPort = server.port!
    server.stop(true)

    expect(await isUpstreamReachable(closedPort)).toBe(false)
  })

  it('resolves false on timeout', async () => {
    expect(await isUpstreamReachable(9, 50)).toBe(false)
  })
})
