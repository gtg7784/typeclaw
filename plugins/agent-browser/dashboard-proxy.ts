import type { Server } from 'bun'

import { discoverDashboardPort } from './dashboard-discovery'

export type DashboardProxyOptions = {
  listenPort?: number
  upstreamPort?: number
  resolveUpstreamPort?: () => Promise<number | null>
  upstreamHost?: string
  listenHost?: string
  fetchImpl?: typeof fetch
  onLog?: (event: DashboardProxyLogEvent) => void
}

export type DashboardProxyLogEvent =
  | { kind: 'started'; listenHost: string; listenPort: number; upstreamHost: string }
  | { kind: 'http-proxy'; port: number; path: string }
  | { kind: 'ws-proxy'; port: number; path: string }
  | { kind: 'invalid-proxy-target'; prefix: string; pathname: string }
  | { kind: 'proxy-target-denied'; port: number; path: string; reason: string }
  | { kind: 'upstream-error'; target: string; reason: string }
  | { kind: 'no-upstream'; path: string }

export type DashboardProxy = {
  server: Server<WebSocketData>
  stop: () => void
}

type WebSocketData = {
  port: number
  path: string
  upstream?: WebSocket
  pending: Array<string | ArrayBuffer>
}

const DEFAULT_PROXY_PORT = 4848
const DEFAULT_UPSTREAM_PORT = 4849
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_LISTEN_HOST = '0.0.0.0'
const HTTP_PROXY_PREFIX = '/__typeclaw_agent_browser_http/'
const WS_PROXY_PREFIX = '/__typeclaw_agent_browser_ws/'
const TYPECLAW_AGENT_PORT = 8973
const TYPECLAW_HOSTD_CONTROL_PORT = 8974
const UPSTREAM_PORT_CACHE_MS = 1_000

export function startDashboardProxy(opts: DashboardProxyOptions = {}): DashboardProxy {
  const listenPort = opts.listenPort ?? DEFAULT_PROXY_PORT
  const upstreamHost = opts.upstreamHost ?? DEFAULT_HOST
  const listenHost = opts.listenHost ?? DEFAULT_LISTEN_HOST
  const fetcher = opts.fetchImpl ?? fetch
  const log = opts.onLog ?? (() => {})

  const resolveUpstreamPort = makeResolverWithCache(opts, listenPort)
  const reservedPorts = new Set([listenPort, TYPECLAW_AGENT_PORT, TYPECLAW_HOSTD_CONTROL_PORT])

  const server = Bun.serve<WebSocketData>({
    hostname: listenHost,
    port: listenPort,
    async fetch(request, bunServer) {
      const url = new URL(request.url)

      const wsTarget = parsePortPath(url.pathname, WS_PROXY_PREFIX)
      if (wsTarget) {
        const upstreamPort = await resolveUpstreamPort()
        const denied = await denyProxyTarget({
          target: wsTarget,
          reservedPorts,
          upstreamPort,
          fetcher,
          upstreamHost,
        })
        if (denied) {
          log({ kind: 'proxy-target-denied', port: wsTarget.port, path: wsTarget.path, reason: denied })
          return new Response(denied, { status: 403 })
        }
        if (
          bunServer.upgrade(request, {
            data: { port: wsTarget.port, path: `${wsTarget.path}${url.search}`, pending: [] },
          })
        ) {
          log({ kind: 'ws-proxy', port: wsTarget.port, path: wsTarget.path })
          return undefined
        }
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname.startsWith(WS_PROXY_PREFIX)) {
        log({ kind: 'invalid-proxy-target', prefix: WS_PROXY_PREFIX, pathname: url.pathname })
        return new Response('Invalid WebSocket proxy target', { status: 400 })
      }

      const httpTarget = parsePortPath(url.pathname, HTTP_PROXY_PREFIX)
      if (httpTarget) {
        const upstreamPort = await resolveUpstreamPort()
        const denied = await denyProxyTarget({
          target: httpTarget,
          reservedPorts,
          upstreamPort,
          fetcher,
          upstreamHost,
        })
        if (denied) {
          log({ kind: 'proxy-target-denied', port: httpTarget.port, path: httpTarget.path, reason: denied })
          return new Response(denied, { status: 403 })
        }
        log({ kind: 'http-proxy', port: httpTarget.port, path: httpTarget.path })
        return proxyHttp({
          request,
          fetcher,
          host: DEFAULT_HOST,
          port: httpTarget.port,
          path: `${httpTarget.path}${url.search}`,
        })
      }

      if (url.pathname.startsWith(HTTP_PROXY_PREFIX)) {
        log({ kind: 'invalid-proxy-target', prefix: HTTP_PROXY_PREFIX, pathname: url.pathname })
        return new Response('Invalid HTTP proxy target', { status: 400 })
      }

      const upstreamPort = await resolveUpstreamPort()
      if (upstreamPort === null) {
        log({ kind: 'no-upstream', path: url.pathname })
        return new Response('agent-browser dashboard is not running. Start it with `agent-browser dashboard start`.', {
          status: 502,
        })
      }

      const upstreamPath = `${url.pathname}${url.search}`
      const response = await proxyHttp({ request, fetcher, host: upstreamHost, port: upstreamPort, path: upstreamPath })
      return maybeInjectDashboardPatch(response)
    },
    websocket: {
      open(ws) {
        const data = ws.data
        const upstream = new WebSocket(`ws://${DEFAULT_HOST}:${data.port}${data.path}`)
        data.upstream = upstream
        upstream.binaryType = 'arraybuffer'
        upstream.addEventListener('open', () => flushPending(data))
        upstream.addEventListener('message', (event) => ws.send(toBunWebSocketPayload(event.data)))
        upstream.addEventListener('close', () => ws.close())
        upstream.addEventListener('error', () => ws.close())
      },
      message(ws, message) {
        const data = ws.data
        if (data.upstream?.readyState === WebSocket.OPEN) {
          data.upstream.send(toWebSocketPayload(message))
          return
        }
        data.pending.push(toWebSocketPayload(message))
      },
      close(ws) {
        ws.data.upstream?.close()
        ws.data.pending = []
      },
    },
  })

  if (server.port !== undefined) reservedPorts.add(server.port)
  log({ kind: 'started', listenHost, listenPort: server.port ?? listenPort, upstreamHost })

  return {
    server,
    stop: () => server.stop(true),
  }
}

function makeResolverWithCache(opts: DashboardProxyOptions, listenPort: number): () => Promise<number | null> {
  // The resolver is called on every proxied request; cache for a short
  // window so concurrent dashboard fetches do not each spawn a procfs walk
  // and a /api/sessions probe. UPSTREAM_PORT_CACHE_MS is below the
  // perceptible-latency threshold and well under the time it takes to
  // start/stop a dashboard, so a stale entry resolves itself within one
  // tick of the user noticing.
  if (opts.resolveUpstreamPort) {
    let cached: { port: number | null; at: number } | null = null
    return async () => {
      const now = Date.now()
      if (cached !== null && now - cached.at < UPSTREAM_PORT_CACHE_MS) return cached.port
      const port = await opts.resolveUpstreamPort!()
      cached = { port, at: now }
      return port
    }
  }
  if (opts.upstreamPort !== undefined) {
    const fixed = opts.upstreamPort
    return async () => fixed
  }
  let cached: { port: number | null; at: number } | null = null
  return async () => {
    const now = Date.now()
    if (cached !== null && now - cached.at < UPSTREAM_PORT_CACHE_MS) return cached.port
    const port = await discoverDashboardPort({ excludePort: listenPort })
    cached = { port, at: now }
    return port
  }
}

export function buildDashboardPatchScript(): string {
  return `<script>${dashboardPatchBody()}</script>`
}

export async function maybeInjectDashboardPatch(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/html')) return response

  const html = await response.text()
  const patch = buildDashboardPatchScript()
  const patched = injectPatch(html, patch)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(patched, { status: response.status, statusText: response.statusText, headers })
}

function injectPatch(html: string, patch: string): string {
  const closingHead = html.match(/<\/head\s*>/i)
  if (closingHead && closingHead.index !== undefined) {
    return html.slice(0, closingHead.index) + patch + html.slice(closingHead.index)
  }
  const openingHead = html.match(/<head\b[^>]*>/i)
  if (openingHead && openingHead.index !== undefined) {
    const insertAt = openingHead.index + openingHead[0].length
    return html.slice(0, insertAt) + patch + html.slice(insertAt)
  }
  const openingHtml = html.match(/<html\b[^>]*>/i)
  if (openingHtml && openingHtml.index !== undefined) {
    const insertAt = openingHtml.index + openingHtml[0].length
    return html.slice(0, insertAt) + patch + html.slice(insertAt)
  }
  return patch + html
}

export function parsePortPath(pathname: string, prefix: string): { port: number; path: string } | null {
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  const slash = rest.indexOf('/')
  const encodedPort = slash === -1 ? rest : rest.slice(0, slash)
  const port = Number.parseInt(decodeURIComponent(encodedPort), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { port, path: slash === -1 ? '/' : rest.slice(slash) }
}

function dashboardPatchBody(): string {
  return String.raw`
(() => {
  const httpPrefix = '${HTTP_PROXY_PREFIX}';
  const wsPrefix = '${WS_PROXY_PREFIX}';

  function isLoopbackHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  }

  function rewriteHttp(input) {
    const raw = typeof input === 'string' ? input : input && input.url;
    if (!raw) return input;

    let url;
    try { url = new URL(raw, window.location.href); } catch { return input; }
    if (!isLoopbackHost(url.hostname) || !url.port) return input;

    const currentPort = String(window.location.port || (window.location.protocol === 'https:' ? 443 : 80));
    if (url.port === currentPort) return url.pathname + url.search + url.hash;
    return httpPrefix + encodeURIComponent(url.port) + url.pathname + url.search + url.hash;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => nativeFetch(rewriteHttp(input), init);

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    let next = url;
    try {
      const parsed = new URL(String(url), window.location.href);
      if (isLoopbackHost(parsed.hostname) && parsed.port) {
        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        next = scheme + '//' + window.location.host + wsPrefix + encodeURIComponent(parsed.port) + parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {}
    return protocols === undefined ? new NativeWebSocket(next) : new NativeWebSocket(next, protocols);
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key] });
  }
})();`
}

async function proxyHttp({
  request,
  fetcher,
  host,
  port,
  path,
}: {
  request: Request
  fetcher: typeof fetch
  host: string
  port: number
  path: string
}): Promise<Response> {
  const target = `http://${host}:${port}${path}`
  try {
    const response = await fetcher(target, {
      method: request.method,
      headers: hopHeaders(request.headers),
      body: request.body,
      redirect: 'manual',
    })
    return rewriteCorsHeaders(response, request)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return new Response(`Failed to proxy ${target}: ${reason}`, { status: 502 })
  }
}

function rewriteCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('origin')
  if (origin === null) return response

  const allowOrigin = response.headers.get('access-control-allow-origin')
  if (allowOrigin === null || !isLoopbackOrigin(allowOrigin)) return response

  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
    )
  } catch {
    return false
  }
}

function hopHeaders(headers: Headers): Headers {
  const next = new Headers(headers)
  for (const name of [
    'host',
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-protocol',
  ]) {
    next.delete(name)
  }
  return next
}

function flushPending(data: WebSocketData): void {
  const upstream = data.upstream
  if (!upstream || upstream.readyState !== WebSocket.OPEN) return
  const pending = data.pending.splice(0)
  for (const message of pending) upstream.send(message)
}

function toBunWebSocketPayload(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  return String(data)
}

function toWebSocketPayload(data: string | Buffer): string | ArrayBuffer {
  if (typeof data === 'string') return data
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

async function denyProxyTarget({
  target,
  reservedPorts,
  upstreamPort,
  fetcher,
  upstreamHost,
}: {
  target: { port: number; path: string }
  reservedPorts: Set<number>
  upstreamPort: number | null
  fetcher: typeof fetch
  upstreamHost: string
}): Promise<string | null> {
  if (reservedPorts.has(target.port)) return `port ${target.port} is reserved`
  if (upstreamPort !== null && target.port === upstreamPort) return `port ${target.port} is reserved`
  if (upstreamPort === null) return 'agent-browser dashboard is not running; cannot validate session port'
  const allowed = await discoverSessionPorts({ fetcher, upstreamHost, upstreamPort })
  if (!allowed.has(target.port)) return `port ${target.port} is not an active agent-browser session port`
  return null
}

async function discoverSessionPorts({
  fetcher,
  upstreamHost,
  upstreamPort,
}: {
  fetcher: typeof fetch
  upstreamHost: string
  upstreamPort: number
}): Promise<Set<number>> {
  const response = await fetcher(`http://${upstreamHost}:${upstreamPort}/api/sessions`)
  if (!response.ok) return new Set()
  const raw: unknown = await response.json().catch(() => [])
  if (!Array.isArray(raw)) return new Set()
  const ports = new Set<number>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const port = (entry as { port?: unknown }).port
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port)
  }
  return ports
}

export const AGENT_BROWSER_DASHBOARD_PROXY_PORT = DEFAULT_PROXY_PORT
export const AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT = DEFAULT_UPSTREAM_PORT
