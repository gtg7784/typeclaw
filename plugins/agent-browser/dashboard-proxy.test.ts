import { afterEach, describe, expect, test } from 'bun:test'

import { maybeInjectDashboardPatch, parsePortPath, startDashboardProxy } from './dashboard-proxy'

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('parsePortPath', () => {
  test('extracts a valid port and path from a proxy path', () => {
    expect(parsePortPath('/__typeclaw_agent_browser_http/40805/api/tabs', '/__typeclaw_agent_browser_http/')).toEqual({
      port: 40805,
      path: '/api/tabs',
    })
  })

  test('rejects invalid ports so the proxy cannot target arbitrary strings', () => {
    expect(parsePortPath('/__typeclaw_agent_browser_http/nope/api/tabs', '/__typeclaw_agent_browser_http/')).toBeNull()
    expect(parsePortPath('/__typeclaw_agent_browser_http/99999/api/tabs', '/__typeclaw_agent_browser_http/')).toBeNull()
  })
})

describe('maybeInjectDashboardPatch', () => {
  test('injects the dashboard monkey patch before the closing head tag', async () => {
    const response = new Response('<html><head><title>x</title></head><body></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '58' },
    })

    const patched = await maybeInjectDashboardPatch(response)
    const body = await patched.text()

    expect(body).toContain('/__typeclaw_agent_browser_http/')
    expect(body).toContain('/__typeclaw_agent_browser_ws/')
    expect(body.indexOf('/__typeclaw_agent_browser_http/')).toBeLessThan(body.indexOf('</head>'))
    expect(patched.headers.has('content-length')).toBe(false)
  })

  test('falls back to opening <head> when the closing tag is missing (Next.js streamed HTML)', async () => {
    const response = new Response('<!DOCTYPE html><html><head><meta charSet="utf-8"/><body>x</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

    const patched = await maybeInjectDashboardPatch(response)
    const body = await patched.text()

    expect(body).toContain('/__typeclaw_agent_browser_http/')
    expect(body.indexOf('/__typeclaw_agent_browser_http/')).toBeGreaterThan(body.indexOf('<head>'))
    expect(body.indexOf('/__typeclaw_agent_browser_http/')).toBeLessThan(body.indexOf('<body>'))
  })

  test('falls back to opening <html> when no head element is present', async () => {
    const response = new Response('<!DOCTYPE html><html><body>x</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

    const patched = await maybeInjectDashboardPatch(response)
    const body = await patched.text()

    expect(body).toContain('/__typeclaw_agent_browser_http/')
    expect(body.indexOf('/__typeclaw_agent_browser_http/')).toBeGreaterThan(body.indexOf('<html>'))
  })

  test('leaves non-html responses untouched', async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })

    const patched = await maybeInjectDashboardPatch(response)

    expect(await patched.text()).toBe('{"ok":true}')
  })
})

describe('startDashboardProxy', () => {
  test('proxies the dashboard upstream and loopback session HTTP paths through one origin', async () => {
    const sessionServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/tabs') return Response.json([{ id: 'tab-1' }])
        return new Response('not found', { status: 404 })
      },
    })
    servers.push(sessionServer)

    const upstreamServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/')
          return new Response('<html><head></head><body>dashboard</body></html>', {
            headers: { 'content-type': 'text/html' },
          })
        if (url.pathname === '/api/sessions') return Response.json([{ session: 'default', port: sessionServer.port }])
        if (url.pathname === '/api/models')
          return Response.json(['model-a'], { headers: { 'access-control-allow-origin': 'http://localhost' } })
        return new Response('not found', { status: 404 })
      },
    })
    servers.push(upstreamServer)

    const proxy = startDashboardProxy({ listenPort: 0, upstreamPort: upstreamServer.port })
    servers.push(proxy.server)

    const html = await fetch(`http://127.0.0.1:${proxy.server.port}/`).then((r) => r.text())
    expect(html).toContain('/__typeclaw_agent_browser_http/')

    const sessions = await fetch(`http://127.0.0.1:${proxy.server.port}/api/sessions`).then((r) => r.json())
    expect(sessions).toEqual([{ session: 'default', port: sessionServer.port }])

    const tabs = await fetch(
      `http://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_http/${sessionServer.port}/api/tabs`,
    ).then((r) => r.json())
    expect(tabs).toEqual([{ id: 'tab-1' }])

    const models = await fetch(`http://127.0.0.1:${proxy.server.port}/api/models`, {
      headers: { origin: 'http://m5.chicken-temperature.ts.net:4849' },
    })
    expect(models.headers.get('access-control-allow-origin')).toBe('http://m5.chicken-temperature.ts.net:4849')
    expect(await models.json()).toEqual(['model-a'])
  })

  test('rejects loopback proxy requests for ports not reported by the dashboard sessions API', async () => {
    const privateServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        return new Response('secret')
      },
    })
    servers.push(privateServer)

    const upstreamServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/sessions') return Response.json([])
        return new Response('<html><head></head><body>dashboard</body></html>', {
          headers: { 'content-type': 'text/html' },
        })
      },
    })
    servers.push(upstreamServer)

    const proxy = startDashboardProxy({ listenPort: 0, upstreamPort: upstreamServer.port })
    servers.push(proxy.server)

    const response = await fetch(
      `http://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_http/${privateServer.port}/secret`,
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('not an active agent-browser session port')
  })

  test.each([
    [8973, 'TypeClaw agent port'],
    [8974, 'TypeClaw hostd control port'],
  ])('rejects reserved %s (%s) even if upstream sessions report it', async (port) => {
    const upstreamServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/sessions') return Response.json([{ session: 'bad', port }])
        return new Response('dashboard')
      },
    })
    servers.push(upstreamServer)

    const proxy = startDashboardProxy({ listenPort: 0, upstreamPort: upstreamServer.port })
    servers.push(proxy.server)

    const response = await fetch(`http://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_http/${port}/`)
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('reserved')
  })

  test('rejects its own listen and upstream dashboard ports even if upstream sessions report them', async () => {
    let proxyPort = 0
    let upstreamPort = 0
    const upstreamServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/sessions')
          return Response.json([
            { session: 'proxy', port: proxyPort },
            { session: 'upstream', port: upstreamPort },
          ])
        return new Response('dashboard')
      },
    })
    upstreamPort = upstreamServer.port ?? 0
    expect(upstreamPort).toBeGreaterThan(0)
    servers.push(upstreamServer)

    const proxy = startDashboardProxy({ listenPort: 0, upstreamPort })
    proxyPort = proxy.server.port ?? 0
    servers.push(proxy.server)

    const proxyResponse = await fetch(
      `http://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_http/${proxyPort}/`,
    )
    expect(proxyResponse.status).toBe(403)
    expect(await proxyResponse.text()).toContain('reserved')

    const upstreamResponse = await fetch(
      `http://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_http/${upstreamPort}/`,
    )
    expect(upstreamResponse.status).toBe(403)
    expect(await upstreamResponse.text()).toContain('reserved')
  })

  test('rejects reserved ports for WebSocket proxy requests too', async () => {
    const upstreamServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/sessions') return Response.json([{ session: 'bad', port: 8973 }])
        return new Response('dashboard')
      },
    })
    servers.push(upstreamServer)

    const proxy = startDashboardProxy({ listenPort: 0, upstreamPort: upstreamServer.port })
    servers.push(proxy.server)

    const response = await fetch(`http://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_ws/8973/`)
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('reserved')
  })

  test('relays allowed WebSocket session ports through the same-origin proxy path', async () => {
    const wsServer = Bun.serve<{ messages: string[] }>({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (server.upgrade(req, { data: { messages: [] } })) return undefined
        return new Response('upgrade required', { status: 400 })
      },
      websocket: {
        open(ws) {
          ws.send('ready')
        },
        message(ws, message) {
          ws.send(`echo:${message.toString()}`)
        },
      },
    })
    servers.push(wsServer)

    const upstreamServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/sessions') return Response.json([{ session: 'default', port: wsServer.port }])
        return new Response('dashboard')
      },
    })
    servers.push(upstreamServer)

    const proxy = startDashboardProxy({ listenPort: 0, upstreamPort: upstreamServer.port })
    servers.push(proxy.server)

    const messages: string[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.server.port}/__typeclaw_agent_browser_ws/${wsServer.port}/`)
    ws.addEventListener('message', (event) => {
      messages.push(String(event.data))
      if (event.data === 'ready') ws.send('ping')
    })

    await waitFor(() => messages.includes('echo:ping'))
    ws.close()
    expect(messages).toContain('ready')
    expect(messages).toContain('echo:ping')
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('condition not met')
}
