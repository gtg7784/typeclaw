import { createServer } from 'node:net'

import { loadConfigSync } from '@/config'

import { containerNameFromCwd, defaultDockerExec, type DockerExec } from './shared'

// The port the agent's WebSocket server binds to *inside* the container. Host
// publishing maps a host-side port (chosen at `typeclaw start` time) to this
// fixed internal port. Decoupling the two lets multiple agents coexist on a
// single host without colliding on 8973 — see issue #1.
//
// Kept identical to the legacy DEFAULT_PORT so a containerful upgrade path
// works: containers started before this change used `-p 8973:8973`, and after
// the upgrade `docker port <name> 8973/tcp` still resolves correctly.
export const CONTAINER_PORT = 8973
export const TUI_TOKEN_LABEL = 'dev.typeclaw.tui-token'

// Asks the kernel for a free TCP port. When `preferred` is supplied, tries
// that port first; if it's already bound, falls back to a kernel-assigned
// ephemeral port via `listen(0)`. The returned port is *not* held — the test
// server is closed before resolving, so a different process could grab it
// before we hand it to Docker. Callers that pipe the result into `docker run`
// should treat docker's bind error as authoritative and retry on conflict.
export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred !== undefined && preferred > 0) {
    if (await isPortFree(preferred)) return preferred
  }
  return listenEphemeral()
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function listenEphemeral(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ port: 0, host: '0.0.0.0', exclusive: true }, () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('failed to obtain ephemeral port'))
        return
      }
      const port = address.port
      server.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

// Docker's bind-conflict error from `docker run -p`. Used by `start` to decide
// whether to retry with a fresh ephemeral port or surface the failure as-is.
export function isPortAllocatedError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return (
    lower.includes('port is already allocated') ||
    lower.includes('address already in use') ||
    lower.includes('bind for') // catches "Bind for :::8973 failed: port is already allocated"
  )
}

export type ResolveHostPortOptions = {
  cwd: string
  exec?: DockerExec
  retryMs?: number
  intervalMs?: number
  fallbackPort?: number
}

// Returns the host port that `typeclaw tui` / `typeclaw reload` should connect
// to. Docker is the source of truth for a running container; we ask
// `docker port <name> ${CONTAINER_PORT}/tcp` and parse the host-side port out
// of the mapping. If the container isn't running (or we're on an old
// pre-fix container that doesn't expose CONTAINER_PORT internally), we fall
// back to the config's `port` field as a best-effort guess.
export async function resolveHostPort(options: ResolveHostPortOptions): Promise<number> {
  const exec = options.exec ?? defaultDockerExec
  const containerName = containerNameFromCwd(options.cwd)
  const retryMs = options.retryMs ?? 1500
  const intervalMs = options.intervalMs ?? 100

  const deadline = Date.now() + retryMs
  while (true) {
    const port = await queryDockerHostPort(exec, containerName)
    if (port !== null) return port
    if (Date.now() >= deadline) break
    await sleep(intervalMs)
  }

  if (options.fallbackPort !== undefined) return options.fallbackPort
  return loadConfigSync(options.cwd).port
}

export async function resolveTuiToken(options: { cwd: string; exec?: DockerExec }): Promise<string | null> {
  const exec = options.exec ?? defaultDockerExec
  const containerName = containerNameFromCwd(options.cwd)
  const result = await exec(['inspect', '--format', `{{ index .Config.Labels "${TUI_TOKEN_LABEL}" }}`, containerName])
  if (result.exitCode !== 0) return null
  const token = result.stdout.trim()
  return token.length > 0 && token !== '<no value>' ? token : null
}

async function queryDockerHostPort(exec: DockerExec, containerName: string): Promise<number | null> {
  const result = await exec(['port', containerName, `${CONTAINER_PORT}/tcp`])
  if (result.exitCode !== 0) return null
  return parseDockerPortOutput(result.stdout)
}

// `docker port` prints one mapping per line, e.g.:
//   0.0.0.0:49160
//   :::49160
//   [::]:49160
// We pick the last numeric segment after the final colon. If multiple lines
// are present we prefer an IPv4 mapping (most localhost connects resolve to
// IPv4 first on macOS/Linux), falling back to whatever parses cleanly.
export function parseDockerPortOutput(stdout: string): number | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const ipv4 = lines.find((line) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(line))
  const candidate = ipv4 ?? lines[0]!
  const lastColon = candidate.lastIndexOf(':')
  if (lastColon < 0) return null
  const portStr = candidate.slice(lastColon + 1)
  const port = Number(portStr)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
