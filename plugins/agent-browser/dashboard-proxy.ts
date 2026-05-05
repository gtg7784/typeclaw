import { accessSync, chmodSync, constants as fsConstants, existsSync } from 'node:fs'

import type { Server } from 'bun'

export type DashboardProxyOptions = {
  listenPort?: number
  upstreamPort?: number
  upstreamHost?: string
  listenHost?: string
  fetchImpl?: typeof fetch
  onLog?: (event: DashboardProxyLogEvent) => void
}

export type AgentBrowserDashboardCommandOptions = {
  executable?: string
}

export type DashboardProxyLogEvent =
  | { kind: 'started'; listenHost: string; listenPort: number; upstreamHost: string; upstreamPort: number }
  | { kind: 'http-proxy'; port: number; path: string }
  | { kind: 'ws-proxy'; port: number; path: string }
  | { kind: 'invalid-proxy-target'; prefix: string; pathname: string }
  | { kind: 'proxy-target-denied'; port: number; path: string; reason: string }
  | { kind: 'upstream-error'; target: string; reason: string }

export type DashboardProxy = {
  server: Server<WebSocketData>
  stop: () => void
}

export type AgentBrowserDashboardProxy = {
  proxy: DashboardProxy
  stop: () => Promise<void>
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

export async function startAgentBrowserDashboardProxy(
  opts: DashboardProxyOptions = {},
  commandOpts: AgentBrowserDashboardCommandOptions = {},
): Promise<AgentBrowserDashboardProxy> {
  const upstreamPort = opts.upstreamPort ?? DEFAULT_UPSTREAM_PORT
  const executable = commandOpts.executable ?? resolveAgentBrowserExecutable()
  await runAgentBrowserDashboardCommand(executable, ['dashboard', 'start', '--port', String(upstreamPort)])
  let proxy: DashboardProxy
  try {
    proxy = startDashboardProxy(opts)
  } catch (err) {
    await runAgentBrowserDashboardCommand(executable, ['dashboard', 'stop']).catch(() => {})
    throw err
  }

  return {
    proxy,
    async stop() {
      proxy.stop()
      await runAgentBrowserDashboardCommand(executable, ['dashboard', 'stop']).catch(() => {})
    },
  }
}

export async function stopAgentBrowserDashboard(commandOpts: AgentBrowserDashboardCommandOptions = {}): Promise<void> {
  const executable = commandOpts.executable ?? resolveAgentBrowserExecutable()
  await runAgentBrowserDashboardCommand(executable, ['dashboard', 'stop'])
}

export function startDashboardProxy(opts: DashboardProxyOptions = {}): DashboardProxy {
  const listenPort = opts.listenPort ?? DEFAULT_PROXY_PORT
  const upstreamPort = opts.upstreamPort ?? DEFAULT_UPSTREAM_PORT
  const upstreamHost = opts.upstreamHost ?? DEFAULT_HOST
  const listenHost = opts.listenHost ?? DEFAULT_LISTEN_HOST
  const fetcher = opts.fetchImpl ?? fetch
  const log = opts.onLog ?? (() => {})
  const deniedPorts = new Set([listenPort, upstreamPort, TYPECLAW_AGENT_PORT, TYPECLAW_HOSTD_CONTROL_PORT])

  const server = Bun.serve<WebSocketData>({
    hostname: listenHost,
    port: listenPort,
    async fetch(request, bunServer) {
      const url = new URL(request.url)

      const wsTarget = parsePortPath(url.pathname, WS_PROXY_PREFIX)
      if (wsTarget) {
        const denied = await denyProxyTarget({
          target: wsTarget,
          deniedPorts,
          fetcher,
          upstreamHost,
          upstreamPort,
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
        const denied = await denyProxyTarget({
          target: httpTarget,
          deniedPorts,
          fetcher,
          upstreamHost,
          upstreamPort,
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

  if (server.port !== undefined) deniedPorts.add(server.port)
  log({ kind: 'started', listenHost, listenPort: server.port ?? listenPort, upstreamHost, upstreamPort })

  return {
    server,
    stop: () => server.stop(true),
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
  const patched = html.includes('</head>') ? html.replace('</head>', `${patch}</head>`) : `${patch}${html}`
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(patched, { status: response.status, statusText: response.statusText, headers })
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
    return await fetcher(target, {
      method: request.method,
      headers: hopHeaders(request.headers),
      body: request.body,
      redirect: 'manual',
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return new Response(`Failed to proxy ${target}: ${reason}`, { status: 502 })
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
  deniedPorts,
  fetcher,
  upstreamHost,
  upstreamPort,
}: {
  target: { port: number; path: string }
  deniedPorts: Set<number>
  fetcher: typeof fetch
  upstreamHost: string
  upstreamPort: number
}): Promise<string | null> {
  if (deniedPorts.has(target.port)) return `port ${target.port} is reserved`
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

if (import.meta.main) {
  await runDashboardProxyMain()
}

async function runDashboardProxyMain(): Promise<void> {
  const listenPort = portFromEnv('TYPECLAW_AGENT_BROWSER_DASHBOARD_PORT', DEFAULT_PROXY_PORT)
  const upstreamPort = portFromEnv('TYPECLAW_AGENT_BROWSER_DASHBOARD_UPSTREAM_PORT', DEFAULT_UPSTREAM_PORT)
  const dashboard = await startAgentBrowserDashboardProxy({
    listenPort,
    upstreamPort,
    onLog: (event) => {
      if (event.kind === 'http-proxy' || event.kind === 'ws-proxy') return
      console.error(`[agent-browser-dashboard] ${JSON.stringify(event)}`)
    },
  })

  console.log(
    `TypeClaw agent-browser dashboard proxy listening on 0.0.0.0:${dashboard.proxy.server.port ?? listenPort}`,
  )
  console.log(`Upstream agent-browser dashboard is on 127.0.0.1:${upstreamPort}`)

  const stop = async () => {
    await dashboard.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())

  await new Promise(() => {})
}

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer port between 1 and 65535`)
  }
  return port
}

function resolveAgentBrowserExecutable(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (arch === null)
    throw new Error(`agent-browser dashboard proxy does not support ${process.platform}-${process.arch}`)
  const platform = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : null
  if (platform === null)
    throw new Error(`agent-browser dashboard proxy does not support ${process.platform}-${process.arch}`)

  const bundled = `/root/.bun/install/global/node_modules/agent-browser/bin/agent-browser-${platform}-${arch}`
  if (existsSync(bundled)) {
    ensureExecutable(bundled)
    return bundled
  }
  return 'agent-browser'
}

function ensureExecutable(path: string): void {
  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    chmodSync(path, 0o755)
  }
}

async function runAgentBrowserDashboardCommand(executable: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([executable, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
    throw new Error(`agent-browser ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
}
