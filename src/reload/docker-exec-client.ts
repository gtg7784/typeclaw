import {
  CONTAINER_PORT,
  containerNameFromCwd,
  defaultDockerExec,
  sanitizeDockerStderr,
  type DockerExec,
  type DockerExecResult,
} from '@/container'

import type { ReloadResult } from './types'

export type RequestReloadViaDockerExecOptions = {
  cwd: string
  token: string | null
  scope?: string
  timeoutMs?: number
  exec?: DockerExec
}

type DockerExecReloadEnvelope = { ok: true; results: ReloadResult[] } | { ok: false; reason: string }

const DEFAULT_TIMEOUT_MS = 30_000

const RELOAD_SCRIPT = String.raw`
const timeoutMs = Number(process.env.TYPECLAW_RELOAD_TIMEOUT_MS ?? '30000')
const url = new URL('ws://127.0.0.1:' + (process.env.TYPECLAW_CONTAINER_PORT ?? '8973'))
if (process.env.TYPECLAW_TUI_TOKEN) url.searchParams.set('token', process.env.TYPECLAW_TUI_TOKEN)
const ws = new WebSocket(url.toString())
let settled = false
const finish = (payload, code) => {
  if (settled) return
  settled = true
  console.log(JSON.stringify(payload))
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
  setTimeout(() => process.exit(code), 0)
}
const timer = setTimeout(() => finish({ ok: false, reason: 'timed out waiting for container-local reload_result after ' + timeoutMs + 'ms' }, 1), timeoutMs)
ws.addEventListener('open', () => {
  const scope = process.env.TYPECLAW_RELOAD_SCOPE
  ws.send(JSON.stringify(scope ? { type: 'reload', scope } : { type: 'reload' }))
})
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.type !== 'reload_result') return
  clearTimeout(timer)
  finish({ ok: true, results: msg.results }, 0)
})
ws.addEventListener('error', (event) => finish({ ok: false, reason: String(event.message ?? event) }, 1))
ws.addEventListener('close', () => finish({ ok: false, reason: 'container-local websocket closed before reload_result' }, 1))
`

export async function requestReloadViaDockerExec({
  cwd,
  token,
  scope,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  exec = defaultDockerExec,
}: RequestReloadViaDockerExecOptions): Promise<ReloadResult[]> {
  const envArgs = ['-e', `TYPECLAW_CONTAINER_PORT=${CONTAINER_PORT}`, '-e', `TYPECLAW_RELOAD_TIMEOUT_MS=${timeoutMs}`]
  if (token !== null) envArgs.push('-e', `TYPECLAW_TUI_TOKEN=${token}`)
  if (scope !== undefined) envArgs.push('-e', `TYPECLAW_RELOAD_SCOPE=${scope}`)

  const signal = AbortSignal.timeout(timeoutMs)
  let result: DockerExecResult
  try {
    result = await exec(['exec', ...envArgs, containerNameFromCwd(cwd), 'bun', '-e', RELOAD_SCRIPT], { signal })
  } catch (err) {
    if (signal.aborted) throw new Error(`docker exec timed out after ${timeoutMs}ms`)
    throw err
  }
  if (signal.aborted) throw new Error(`docker exec timed out after ${timeoutMs}ms`)
  if (result.exitCode !== 0) {
    const envelope = parseEnvelope(result.stdout)
    if (envelope !== null && !envelope.ok) throw new Error(envelope.reason)
    const reason =
      sanitizeDockerStderr(result.stderr) || result.stdout.trim() || `docker exec exited with code ${result.exitCode}`
    throw new Error(reason)
  }

  const envelope = parseEnvelope(result.stdout)
  if (envelope === null) throw new Error('container-local reload returned invalid JSON')
  if (!envelope.ok) throw new Error(envelope.reason)
  return envelope.results
}

function parseEnvelope(stdout: string): DockerExecReloadEnvelope | null {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .at(-1)
  if (line === undefined) return null
  try {
    const parsed: unknown = JSON.parse(line)
    return isEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isEnvelope(value: unknown): value is DockerExecReloadEnvelope {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) return Array.isArray(value.results)
  return typeof value.reason === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
