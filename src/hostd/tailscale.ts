import { getBun } from '@/container/shared'

export type TailscaleExecResult = { exitCode: number; stdout: string; stderr: string }
export type TailscaleExec = (args: string[]) => Promise<TailscaleExecResult>

export type TailscaleServeEvent =
  | { kind: 'tailscale-serve-opened'; containerName: string; port: number }
  | { kind: 'tailscale-serve-closed'; containerName: string; port: number }
  | { kind: 'tailscale-serve-skipped'; containerName: string; port: number; reason: string }
  | {
      kind: 'tailscale-serve-failed'
      containerName: string
      port: number
      command: 'status' | 'serve' | 'off'
      reason: string
    }

export type TailscaleServeManager = {
  servePort: (port: number) => void
  stopPort: (port: number) => void
  stopAll: () => Promise<void>
}

export type TailscaleServeManagerOptions = {
  containerName: string
  exec?: TailscaleExec
  onEvent: (event: TailscaleServeEvent) => void
  onLog?: (msg: string) => void
}

type TailscaleStatus = {
  BackendState?: unknown
}

const MACOS_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

export function createTailscaleServeManager(opts: TailscaleServeManagerOptions): TailscaleServeManager {
  const exec = opts.exec ?? defaultTailscaleExec
  const log = opts.onLog ?? (() => {})
  const ownedPorts = new Set<number>()
  const pending = new Set<Promise<void>>()

  const track = (work: Promise<void>): void => {
    pending.add(work)
    work.finally(() => pending.delete(work)).catch(() => {})
  }

  const emit = (event: TailscaleServeEvent): void => {
    try {
      opts.onEvent(event)
    } catch (error) {
      log(`tailscale serve event handler threw: ${stringifyError(error)}`)
    }
  }

  const servePort = (port: number): void => {
    if (ownedPorts.has(port)) return
    track(
      (async () => {
        const ready = await checkRunning(exec)
        if (!ready.ok) {
          emit({ kind: 'tailscale-serve-skipped', containerName: opts.containerName, port, reason: ready.reason })
          return
        }

        const result = await exec(['serve', '--bg', `--tcp=${port}`, String(port)])
        if (result.exitCode !== 0) {
          emit({
            kind: 'tailscale-serve-failed',
            containerName: opts.containerName,
            port,
            command: 'serve',
            reason: commandError(result),
          })
          return
        }

        ownedPorts.add(port)
        emit({ kind: 'tailscale-serve-opened', containerName: opts.containerName, port })
      })(),
    )
  }

  const stopPort = (port: number): void => {
    if (!ownedPorts.has(port)) return
    track(stopOwnedPort(port))
  }

  const stopOwnedPort = async (port: number): Promise<void> => {
    const result = await exec(['serve', `--tcp=${port}`, 'off'])
    if (result.exitCode !== 0) {
      emit({
        kind: 'tailscale-serve-failed',
        containerName: opts.containerName,
        port,
        command: 'off',
        reason: commandError(result),
      })
      return
    }

    ownedPorts.delete(port)
    emit({ kind: 'tailscale-serve-closed', containerName: opts.containerName, port })
  }

  return {
    servePort,
    stopPort,
    async stopAll() {
      await Promise.allSettled(Array.from(pending))
      await Promise.allSettled(Array.from(ownedPorts).map((port) => stopOwnedPort(port)))
    },
  }
}

async function checkRunning(exec: TailscaleExec): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await exec(['status', '--json'])
  if (result.exitCode !== 0) return { ok: false, reason: commandError(result) }

  let parsed: TailscaleStatus
  try {
    parsed = JSON.parse(result.stdout) as TailscaleStatus
  } catch (error) {
    return { ok: false, reason: `invalid tailscale status JSON: ${stringifyError(error)}` }
  }

  if (parsed.BackendState !== 'Running')
    return { ok: false, reason: `tailscale backend is ${String(parsed.BackendState)}` }
  return { ok: true }
}

export const defaultTailscaleExec: TailscaleExec = async (args) => {
  const candidates = process.platform === 'darwin' ? ['tailscale', MACOS_APP_CLI] : ['tailscale']
  let lastError = 'tailscale command not found'

  for (const candidate of candidates) {
    const result = await runTailscale(candidate, args)
    if (result.exitCode !== 127) return result
    lastError = result.stderr || lastError
  }

  return { exitCode: 127, stdout: '', stderr: lastError }
}

async function runTailscale(bin: string, args: string[]): Promise<TailscaleExecResult> {
  const bun = getBun()
  if (!bun) return { exitCode: 127, stdout: '', stderr: 'bun runtime not available' }
  try {
    const proc = bun.spawn({
      cmd: [bin, ...args],
      stdout: 'pipe',
      stderr: 'pipe',
      env: bin === MACOS_APP_CLI ? { ...process.env, TAILSCALE_BE_CLI: '1' } : process.env,
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    const exitCode = code === 'ENOENT' ? 127 : 1
    return { exitCode, stdout: '', stderr: stringifyError(error) }
  }
}

function commandError(result: TailscaleExecResult): string {
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim()
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
