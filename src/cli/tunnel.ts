import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { select, text, isCancel, cancel, log } from '@clack/prompts'
import { defineCommand } from 'citty'

import { loadConfigSync, validateConfig } from '@/config'
import { resolveHostPort, resolveTuiToken } from '@/container'
import { findAgentDir, isInitialized } from '@/init'
import type { ClientMessage, ServerMessage, TunnelLogsServerMessage, TunnelSnapshot } from '@/shared'
import type { TunnelConfig, TunnelFor, TunnelProvider } from '@/tunnels'

import { c, errorLine } from './ui'

type AddArgs = {
  name: string
  provider?: string
  forChannel?: string
  forManual?: boolean
  upstreamPort?: string
  externalUrl?: string
}

type RemoveArgs = { name: string }

type LiveArgs = { url?: string; timeout?: string }

type LogsArgs = LiveArgs & { name: string; follow?: boolean }

type LiveResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export type TextValidator = (value: string) => string | undefined

export type TunnelPrompts = {
  selectProvider: () => Promise<TunnelProvider | symbol>
  selectOwner: () => Promise<'channel' | 'manual' | symbol>
  text: (message: string, validate?: TextValidator) => Promise<string | symbol>
}

const DEFAULT_TIMEOUT_MS = 15_000

const defaultPrompts: TunnelPrompts = {
  selectProvider: () =>
    select<TunnelProvider>({
      message: 'Tunnel provider',
      options: [
        { value: 'cloudflare-quick', label: 'Cloudflare Quick Tunnel', hint: 'no signup, URL rotates on restart' },
        { value: 'external', label: 'External URL', hint: 'bring your own reverse proxy' },
      ],
    }),
  selectOwner: () =>
    select<'channel' | 'manual'>({
      message: 'Tunnel owner',
      options: [
        { value: 'channel', label: 'Channel' },
        { value: 'manual', label: 'Manual upstream' },
      ],
    }),
  text: (message, validate) =>
    text({ message, ...(validate !== undefined ? { validate: (v) => validate(v ?? '') } : {}) }),
}

const addSub = defineCommand({
  meta: { name: 'add', description: 'add a public tunnel entry to typeclaw.json' },
  args: {
    name: { type: 'positional', required: true, description: 'tunnel name' },
    provider: { type: 'string', description: 'external | cloudflare-quick' },
    'for-channel': { type: 'string', description: 'own this tunnel from a channel adapter' },
    'for-manual': { type: 'boolean', description: 'create a manually-owned tunnel' },
    'upstream-port': { type: 'string', description: 'container-local upstream port for manual tunnels' },
    'external-url': { type: 'string', description: 'https URL for provider=external' },
  },
  async run({ args }) {
    const result = await runTunnelAddFlow(ensureAgentDir(), {
      name: String(args.name),
      ...(args.provider !== undefined ? { provider: String(args.provider) } : {}),
      ...(args['for-channel'] !== undefined ? { forChannel: String(args['for-channel']) } : {}),
      ...(args['for-manual'] === true ? { forManual: true } : {}),
      ...(args['upstream-port'] !== undefined ? { upstreamPort: String(args['upstream-port']) } : {}),
      ...(args['external-url'] !== undefined ? { externalUrl: String(args['external-url']) } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    log.success(`Added tunnel "${result.value.name}" to typeclaw.json.`)
    log.info('Run typeclaw restart to apply.')
  },
})

const listSub = defineCommand({
  meta: { name: 'list', description: 'list live tunnels from the running agent' },
  args: liveArgs(),
  async run({ args }) {
    const result = await fetchTunnelList({ cwd: ensureAgentDir(), ...parseLiveArgs(args as LiveArgs) })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    process.stdout.write(`${formatTunnelList(result.value)}\n`)
  },
})

const statusSub = defineCommand({
  meta: { name: 'status', description: 'show one live tunnel in detail' },
  args: { name: { type: 'positional', required: true, description: 'tunnel name' }, ...liveArgs() },
  async run({ args }) {
    const live = parseLiveArgs(args as LiveArgs)
    const result = await fetchTunnelStatus({ cwd: ensureAgentDir(), name: String(args.name), ...live })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    const logs = await fetchTunnelLogs({ cwd: ensureAgentDir(), name: String(args.name), follow: false, ...live })
    const lines = logs.ok ? logs.value : []
    process.stdout.write(`${formatTunnelStatus(result.value, lines)}\n`)
  },
})

const removeSub = defineCommand({
  meta: { name: 'remove', description: 'remove a manually-owned tunnel from typeclaw.json' },
  args: { name: { type: 'positional', required: true, description: 'tunnel name' } },
  async run({ args }) {
    const result = runTunnelRemoveFlow(ensureAgentDir(), args as RemoveArgs)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    log.success(`Removed tunnel "${args.name}" from typeclaw.json.`)
    log.info('Run typeclaw restart to apply.')
  },
})

const logsSub = defineCommand({
  meta: { name: 'logs', description: 'print or follow a tunnel log ring' },
  args: {
    name: { type: 'positional', required: true, description: 'tunnel name' },
    follow: { type: 'boolean', alias: 'f', description: 'follow new log lines' },
    ...liveArgs(),
  },
  async run({ args }) {
    const live = parseLiveArgs(args as LiveArgs)
    const result = await streamTunnelLogs(
      {
        cwd: ensureAgentDir(),
        name: String(args.name),
        follow: args.follow === true,
        ...live,
      },
      (line) => {
        process.stdout.write(`${line}\n`)
      },
    )
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
  },
})

export const tunnelCommand = defineCommand({
  meta: { name: 'tunnel', description: 'manage public tunnels for channels and manual upstreams' },
  subCommands: { add: addSub, list: listSub, status: statusSub, remove: removeSub, logs: logsSub },
})

export async function runTunnelAddFlow(
  cwd: string,
  args: AddArgs,
  prompts: TunnelPrompts = defaultPrompts,
): Promise<LiveResult<TunnelConfig>> {
  // Strict gate before any read: a malformed or schema-invalid `typeclaw.json`
  // would otherwise throw out of the subsequent `loadConfigSync` and surface
  // as an uncaught exception instead of the clean exit-1-with-reason that
  // every other LiveResult consumer expects. Same fence PR #288 documented
  // for the `start`/`restart`/`reload` path: destructive paths route through
  // `validateConfig` so the file's invariants are checked once, up front,
  // and the rest of the flow can lean on them.
  const validation = validateConfig(cwd)
  if (!validation.ok) return { ok: false, reason: validation.reason }
  const config = loadConfigSync(cwd)
  if (config.tunnels.some((entry) => entry.name === args.name))
    return { ok: false, reason: `tunnel "${args.name}" already exists` }

  const provider = await resolveProvider(args.provider, prompts)
  const tunnelFor = await resolveFor(args, prompts)
  let upstreamPort: number | undefined
  if (tunnelFor.kind === 'manual') {
    const raw = args.upstreamPort ?? (await promptText('Upstream port', prompts, validateUpstreamPort))
    const portError = validateUpstreamPort(raw)
    if (portError !== undefined) return { ok: false, reason: `upstream port: ${portError}` }
    upstreamPort = Number(raw)
  }
  let externalUrl: string | undefined
  if (provider === 'external') {
    externalUrl = args.externalUrl ?? (await promptText('External HTTPS URL', prompts, validateHttpsUrl))
    const urlError = validateHttpsUrl(externalUrl)
    if (urlError !== undefined) return { ok: false, reason: `external URL: ${urlError}` }
  }

  const tunnel: TunnelConfig = {
    name: args.name,
    provider,
    for: tunnelFor,
    ...(externalUrl !== undefined ? { externalUrl } : {}),
    ...(upstreamPort !== undefined ? { upstreamPort } : {}),
  }
  const raw = readRawConfig(cwd)
  raw.tunnels = [...config.tunnels, tunnel]
  if (provider === 'cloudflare-quick') {
    raw.docker = { ...asRecord(raw.docker), file: { ...asRecord(asRecord(raw.docker).file), cloudflared: true } }
  }
  writeRawConfig(cwd, raw)
  loadConfigSync(cwd)
  return { ok: true, value: tunnel }
}

export function runTunnelRemoveFlow(cwd: string, args: RemoveArgs): LiveResult<{ removed: TunnelConfig }> {
  // Same strict gate as `runTunnelAddFlow`. See the comment there for why.
  const validation = validateConfig(cwd)
  if (!validation.ok) return { ok: false, reason: validation.reason }
  const config = loadConfigSync(cwd)
  const tunnel = config.tunnels.find((entry) => entry.name === args.name)
  if (tunnel === undefined) return { ok: false, reason: `unknown tunnel: ${args.name}` }
  if (tunnel.for.kind === 'channel') {
    return {
      ok: false,
      reason: `tunnel "${args.name}" is owned by channel "${tunnel.for.name}"; run typeclaw channel remove ${tunnel.for.name}`,
    }
  }
  const raw = readRawConfig(cwd)
  raw.tunnels = config.tunnels.filter((entry) => entry.name !== args.name)
  writeRawConfig(cwd, raw)
  loadConfigSync(cwd)
  return { ok: true, value: { removed: tunnel } }
}

export async function fetchTunnelList(opts: {
  cwd: string
  url?: string
  timeoutMs?: number
}): Promise<LiveResult<TunnelSnapshot[]>> {
  return withTuiSocket(opts, async (ws, timeoutMs) => {
    const requestId = `tunnel-list-${crypto.randomUUID()}`
    const msg: ClientMessage = { type: 'tunnel_list_request', requestId }
    ws.send(JSON.stringify(msg))
    const reply = await waitForServerMessage(
      ws,
      timeoutMs,
      (m) => m.type === 'tunnel_list_response' && m.requestId === requestId,
    )
    if (reply.type !== 'tunnel_list_response') throw new Error('unreachable')
    return reply.ok ? { ok: true, value: reply.tunnels } : { ok: false, reason: reply.error }
  })
}

export async function fetchTunnelStatus(opts: {
  cwd: string
  name: string
  url?: string
  timeoutMs?: number
}): Promise<LiveResult<TunnelSnapshot>> {
  return withTuiSocket(opts, async (ws, timeoutMs) => {
    const requestId = `tunnel-status-${crypto.randomUUID()}`
    const msg: ClientMessage = { type: 'tunnel_status_request', requestId, name: opts.name }
    ws.send(JSON.stringify(msg))
    const reply = await waitForServerMessage(
      ws,
      timeoutMs,
      (m) => m.type === 'tunnel_status_response' && m.requestId === requestId,
    )
    if (reply.type !== 'tunnel_status_response') throw new Error('unreachable')
    return reply.ok ? { ok: true, value: reply.tunnel } : { ok: false, reason: reply.error }
  })
}

export async function fetchTunnelLogs(opts: {
  cwd: string
  name: string
  url?: string
  timeoutMs?: number
  follow?: false
}): Promise<LiveResult<string[]>> {
  const lines: string[] = []
  const result = await streamTunnelLogs({ ...opts, follow: false }, (line) => lines.push(line))
  return result.ok ? { ok: true, value: lines } : result
}

export async function streamTunnelLogs(
  opts: { cwd: string; name: string; url?: string; timeoutMs?: number; follow?: boolean },
  onLine: (line: string) => void,
): Promise<LiveResult<void>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const urlResult = await resolveWsUrl(opts.cwd, opts.url, '/tunnel-logs')
  if (!urlResult.ok) return urlResult
  const ws = new WebSocket(urlResult.value)
  try {
    await waitForOpen(ws, timeoutMs)
    ws.send(JSON.stringify({ type: 'subscribe', name: opts.name, follow: opts.follow === true }))
    return await new Promise<LiveResult<void>>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timed out waiting for tunnel logs' }), timeoutMs)
      const onSigint = () => {
        cleanup()
        ws.close()
        resolve({ ok: true, value: undefined })
      }
      const cleanup = () => {
        clearTimeout(timer)
        process.off('SIGINT', onSigint)
        ws.removeEventListener('message', onMessage)
      }
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(String(event.data)) as TunnelLogsServerMessage
        if (msg.type === 'snapshot') for (const line of msg.lines) onLine(line)
        else if (msg.type === 'line') onLine(msg.line)
        else if (msg.type === 'error') {
          cleanup()
          ws.close()
          resolve({ ok: false, reason: msg.message })
        } else if (msg.type === 'end') {
          cleanup()
          ws.close()
          resolve({ ok: true, value: undefined })
        }
      }
      process.once('SIGINT', onSigint)
      ws.addEventListener('message', onMessage)
    })
  } catch (err) {
    ws.close()
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function formatTunnelList(tunnels: readonly TunnelSnapshot[]): string {
  if (tunnels.length === 0) return c.dim('No tunnels configured.')
  const rows = tunnels.map((t) => [
    t.name,
    t.provider,
    formatFor(t.for),
    t.url ?? '-',
    t.status,
    formatLast(t.lastUrlAt),
  ])
  const widths = [4, 8, 3, 3, 6, 12].map((min, i) => Math.max(min, ...rows.map((row) => row[i]!.length)))
  const header = ['NAME', 'PROVIDER', 'FOR', 'URL', 'STATUS', 'LAST-ROTATED']
    .map((h, i) => h.padEnd(widths[i]!))
    .join('  ')
  return [c.dim(header), ...rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '))].join('\n')
}

export function formatTunnelStatus(tunnel: TunnelSnapshot, lines: readonly string[]): string {
  const out = [
    `${c.bold(tunnel.name)} ${c.dim(`[${tunnel.provider}]`)}`,
    `  ${c.dim('for        ')} ${formatFor(tunnel.for)}`,
    `  ${c.dim('current URL')} ${tunnel.url ?? '-'}`,
    `  ${c.dim('status     ')} ${tunnel.status}`,
    `  ${c.dim('lastUrlAt  ')} ${formatLast(tunnel.lastUrlAt)}`,
    `  ${c.dim('detail     ')} ${tunnel.detail}`,
  ]
  if (lines.length > 0) out.push('', c.dim('Recent logs:'), ...lines.map((line) => `  ${line}`))
  return out.join('\n')
}

function liveArgs() {
  return {
    url: { type: 'string', description: 'agent websocket url' },
    timeout: {
      type: 'string',
      description: 'milliseconds to wait for the agent to respond',
      default: String(DEFAULT_TIMEOUT_MS),
    },
  } as const
}

function parseLiveArgs(args: LiveArgs): { url?: string; timeoutMs: number } {
  const timeoutMs = Number(args.timeout ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid --timeout value: ${args.timeout}`)
  return { ...(args.url !== undefined ? { url: args.url } : {}), timeoutMs }
}

async function resolveProvider(input: string | undefined, prompts: TunnelPrompts): Promise<TunnelProvider> {
  if (input === 'external' || input === 'cloudflare-quick') return input
  if (input !== undefined) throw new Error(`unknown tunnel provider: ${input}`)
  const choice = await prompts.selectProvider()
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

async function resolveFor(args: AddArgs, prompts: TunnelPrompts): Promise<TunnelFor> {
  if (args.forChannel !== undefined && args.forManual === true)
    throw new Error('choose either --for-channel or --for-manual, not both')
  if (args.forChannel !== undefined) return { kind: 'channel', name: args.forChannel }
  if (args.forManual === true) return { kind: 'manual' }
  const choice = await prompts.selectOwner()
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  if (choice === 'manual') return { kind: 'manual' }
  return {
    kind: 'channel',
    name: await promptText('Channel name', prompts, validateNonEmpty('Channel name is required')),
  }
}

async function promptText(message: string, prompts: TunnelPrompts, validate?: TextValidator): Promise<string> {
  const value = await prompts.text(message, validate)
  if (isCancel(value)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return String(value)
}

function validateNonEmpty(requiredMessage: string): TextValidator {
  return (value) => (value.trim().length > 0 ? undefined : requiredMessage)
}

function validateUpstreamPort(value: string): string | undefined {
  if (value.trim().length === 0) return 'Upstream port is required'
  const port = Number(value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 'Must be an integer between 1 and 65535'
  return undefined
}

function validateHttpsUrl(value: string): string | undefined {
  if (value.trim().length === 0) return 'URL is required'
  if (!value.startsWith('https://')) return 'URL must start with https://'
  try {
    new URL(value)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}

function readRawConfig(cwd: string): Record<string, unknown> {
  const file = join(cwd, 'typeclaw.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {}
    throw err
  }
}

function writeRawConfig(cwd: string, config: Record<string, unknown>): void {
  writeFileSync(join(cwd, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function withTuiSocket<T>(
  opts: { cwd: string; url?: string; timeoutMs?: number },
  fn: (ws: WebSocket, timeoutMs: number) => Promise<LiveResult<T>>,
): Promise<LiveResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = await resolveWsUrl(opts.cwd, opts.url)
  if (!url.ok) return url
  const ws = new WebSocket(url.value)
  try {
    await waitForOpen(ws, timeoutMs)
    return await fn(ws, timeoutMs)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    ws.close()
  }
}

async function resolveWsUrl(cwd: string, input?: string, pathname = '/'): Promise<LiveResult<string>> {
  try {
    const url = input === undefined ? new URL(`ws://127.0.0.1:${await resolveHostPort({ cwd })}`) : new URL(input)
    if (input === undefined) {
      const token = await resolveTuiToken({ cwd })
      if (token !== null) url.searchParams.set('token', token)
    }
    url.pathname = pathname
    return { ok: true, value: url.toString() }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out connecting to agent websocket')), timeoutMs)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      'error',
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
      { once: true },
    )
  })
}

function waitForServerMessage(
  ws: WebSocket,
  timeoutMs: number,
  predicate: (msg: ServerMessage) => boolean,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for agent response')), timeoutMs)
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage
      if (!predicate(msg)) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolve(msg)
    }
    ws.addEventListener('message', onMessage)
  })
}

function formatFor(value: TunnelFor): string {
  return value.kind === 'channel' ? `channel:${value.name}` : 'manual'
}

function formatLast(value: number | null): string {
  return value === null ? '-' : new Date(value).toISOString()
}
