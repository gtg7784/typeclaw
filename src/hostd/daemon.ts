import { existsSync } from 'node:fs'
import { chmod, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Socket, UnixSocketListener } from 'bun'

import type { PortForward } from '@/config'
import { defaultDockerExec, type DockerExec } from '@/container'
import type { PortForwardEvent } from '@/portbroker'
import { kakaoChannelBlockSchema } from '@/secrets/schema'
import { SecretsBackend } from '@/secrets/storage'

import { isDaemonReachable } from './client'
import type { KakaoRenewalCallbacks, KakaoRenewalLogEvent } from './kakao-renewal-manager'
import { ensureDirs, registrationFilePath, registrationsDir, socketPath } from './paths'
import type {
  HttpInfoResult,
  ListResult,
  Request,
  Response as RpcResponse,
  RestartResult,
  SecretsPatchResult,
  ShutdownResult,
  StatusResult,
  VersionResult,
} from './protocol'
import { buildSupervisor, type SupervisorLogEvent, type SupervisorRestart } from './supervisor'
import type { TailscaleServeEvent } from './tailscale'
import { UNVERSIONED_SENTINEL } from './version'

export type DaemonOptions = {
  exec?: DockerExec
  onLog?: (event: DaemonLogEvent | SupervisorLogEvent) => void
  gcIntervalMs?: number
  gcMissesToDeregister?: number
  socket?: string
  // When provided, the daemon honors `restart` RPCs by invoking this with the
  // (containerName, cwd) it captured at register time. Omit to disable the
  // capability in tests.
  restart?: SupervisorRestart
  restartPreflight?: RestartPreflight
  // Source-tree fingerprint captured at daemon boot. Reported via the
  // `version` RPC so the CLI can detect when its on-disk source has drifted
  // from what the running daemon loaded, and trigger a respawn over the
  // `shutdown` RPC. Omit to advertise as unversioned (drift detection
  // disabled — both peers compare equal on the sentinel).
  version?: string
  // Invoked after the daemon finishes its self-initiated stop in response to
  // a `shutdown` RPC. Production wiring exits the process here so the host
  // can spawn a fresh daemon; tests omit it to keep the process alive.
  onShutdown?: () => void
  httpHost?: string
  httpPort?: number
  // Port-broker capability. When provided, register-RPC's portForward/wsHostPort
  // fields trigger broker spawn alongside supervisor registration. Tests omit
  // it to keep the broker out of unrelated suites.
  portbroker?: PortbrokerCallbacks
  // KakaoTalk credential renewal capability. When provided, the daemon
  // starts a per-container daily renewal tick on register and stops it on
  // deregister. Omit to disable in tests / when the agent has no kakaotalk
  // channel configured.
  kakaoRenewal?: KakaoRenewalCallbacks
}

export type RestartPreflight = (input: {
  containerName: string
  cwd: string
  build?: boolean
}) => Promise<RpcResponse | null>

export type PortbrokerCallbacks = {
  start: (input: PortbrokerStartInput) => Promise<void>
  stop: (containerName: string, reason: 'deregistered' | 'broker-stopped') => Promise<void>
  // Returns ports the broker is currently exposing on the host for this
  // container. Empty array when the container is unregistered, when the broker
  // is disabled (`portForward.allow: []`), or when nothing inside the
  // container has bound a forwardable port yet. Read-only — used by the
  // `status` RPC to surface live forward state.
  forwardedPorts: (containerName: string) => number[]
}

export type PortbrokerStartInput = {
  containerName: string
  cwd: string
  policy: PortForward
  wsHostPort: number
  brokerToken: string
  onEvent: (event: PortForwardEvent) => void
  onTailscaleServeEvent: (event: TailscaleServeEvent) => void
}

export type DaemonLogEvent =
  | { kind: 'daemon-listening'; socket: string }
  | { kind: 'daemon-http-listening'; host: string; port: number }
  | { kind: 'daemon-http-port-fallback'; preferred: number; actual: number }
  | { kind: 'daemon-stopping' }
  | { kind: 'register'; containerName: string }
  | { kind: 'deregister'; containerName: string; reason: 'requested' | 'gone' }
  | { kind: 'registration-skipped'; containerName: string; reason: string }
  | { kind: 'shutdown-requested' }
  | { kind: 'port-forward-event'; event: PortForwardEvent }
  | { kind: 'tailscale-serve-event'; event: TailscaleServeEvent }
  | KakaoRenewalLogEvent

export type Daemon = {
  registered: () => string[]
  stop: () => Promise<void>
}

const DEFAULT_GC_INTERVAL_MS = 30_000
const DEFAULT_GC_MISSES_TO_DEREGISTER = 3
const MAX_REQUEST_BUFFER_BYTES = 64 * 1024
const MAX_HTTP_REQUEST_BYTES = 64 * 1024

// Preferred port for the HTTP control surface. Adjacent to CONTAINER_PORT
// (8973) for mnemonics. Stability matters: containers cache the URL in
// TYPECLAW_HOSTD_URL at `docker run` time, so a respawn that picks a fresh
// random port would leave running containers with stale URLs and no way to
// reach hostd. We try 8974 first and only fall back to an ephemeral port if
// it's already in use by some other local service.
const STABLE_HTTP_PORT = 8974

type ServerState = { buf: string }

function json(response: RpcResponse, status = 200): globalThis.Response {
  return new Response(JSON.stringify(response), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bearerToken(value: string | null): string | null {
  if (!value) return null
  const prefix = 'Bearer '
  if (!value.startsWith(prefix)) return null
  return value.slice(prefix.length)
}

type RestoredPayload = {
  containerName: string
  cwd: string
  restartToken?: string
  wsHostPort?: number
  portForward?: PortForward
  brokerToken?: string
}

function isValidRestoredPayload(value: unknown, expectedName: string): value is RestoredPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.containerName !== expectedName) return false
  if (typeof v.cwd !== 'string') return false
  if (v.restartToken !== undefined && typeof v.restartToken !== 'string') return false
  if (v.wsHostPort !== undefined && (typeof v.wsHostPort !== 'number' || !Number.isFinite(v.wsHostPort))) return false
  if (v.brokerToken !== undefined && typeof v.brokerToken !== 'string') return false
  return true
}

async function restorePersistedRegistrations(
  apply: (payload: RestoredPayload) => Promise<void>,
  log: (event: DaemonLogEvent | SupervisorLogEvent) => void,
  probe: (name: string) => Promise<'alive' | 'gone' | 'unknown'>,
  removeFile: (name: string) => Promise<void>,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(registrationsDir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const expectedName = entry.slice(0, -'.json'.length)
    const filePath = join(registrationsDir(), entry)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'))
    } catch (error) {
      log({ kind: 'registration-skipped', containerName: expectedName, reason: stringifyError(error) })
      continue
    }
    if (!isValidRestoredPayload(parsed, expectedName)) {
      log({ kind: 'registration-skipped', containerName: expectedName, reason: 'schema mismatch' })
      continue
    }
    // Probe before reviving. A registration file for a container that no
    // longer exists is a leftover from a daemon that died ungracefully
    // (crash, `kill -9`, OS reboot) before deregister could clean up.
    // Reviving its broker would create a stale T_old broker that races a
    // subsequent `register` call's T_new broker — see portbroker-manager.ts
    // start() for the swap-race description. `unknown` (docker probe call
    // failed) errs toward restore: the existing GC tick will tear down the
    // registration if the container is genuinely gone, and we'd rather pay
    // one swap-race attempt than tear down a live registration on a flaky
    // `docker ps`.
    const status = await probe(expectedName)
    if (status === 'gone') {
      await removeFile(expectedName)
      log({ kind: 'registration-skipped', containerName: expectedName, reason: 'container not running' })
      continue
    }
    await apply(parsed)
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  await ensureDirs()
  const path = opts.socket ?? socketPath()

  if (existsSync(path)) {
    if (await isDaemonReachable(500)) {
      throw new Error(`another typeclaw host daemon is already listening at ${path}`)
    }
    try {
      await unlink(path)
    } catch {}
  }

  const log = opts.onLog ?? (() => {})
  const exec = opts.exec ?? defaultDockerExec
  const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS
  const gcMissesToDeregister = opts.gcMissesToDeregister ?? DEFAULT_GC_MISSES_TO_DEREGISTER
  const version = opts.version ?? UNVERSIONED_SENTINEL
  const cwds = new Map<string, string>()
  const restartTokens = new Map<string, string>()
  const perContainerSerial = new Map<string, Promise<unknown>>()
  const gcMisses = new Map<string, number>()
  let stopped = false
  let httpPort = 0

  const supervisor = opts.restart
    ? buildSupervisor({
        restart: opts.restart,
        onLog: (event) => log(event),
        isStopped: () => stopped,
      })
    : null

  // Per-container serialization: register/deregister chains through the same
  // promise per containerName, so a deregister arriving mid-register cannot
  // observe a partial state.
  const runSerially = <T>(name: string, op: () => Promise<T>): Promise<T> => {
    const prev = perContainerSerial.get(name) ?? Promise.resolve()
    const next = prev.then(op, op)
    perContainerSerial.set(
      name,
      next.catch(() => {}),
    )
    return next
  }

  type RegisterPayload = {
    containerName: string
    cwd: string
    restartToken?: string
    wsHostPort?: number
    portForward?: PortForward
    brokerToken?: string
  }

  // Atomic write: temp + rename within registrationsDir() so a crash mid-write
  // never leaves a half-written file that boot-time restore would misparse.
  const persistRegistration = async (payload: RegisterPayload): Promise<void> => {
    const final = registrationFilePath(payload.containerName)
    const tmp = `${final}.${process.pid}.tmp`
    const record = {
      containerName: payload.containerName,
      cwd: payload.cwd,
      restartToken: payload.restartToken,
      wsHostPort: payload.wsHostPort,
      portForward: payload.portForward,
      brokerToken: payload.brokerToken,
    }
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 })
    await rename(tmp, final)
  }

  const removeRegistrationFile = async (containerName: string): Promise<void> => {
    try {
      await unlink(registrationFilePath(containerName))
    } catch {}
  }

  const applyRegistration = async (payload: RegisterPayload): Promise<void> => {
    const alreadyRegistered = cwds.has(payload.containerName)
    cwds.set(payload.containerName, payload.cwd)
    if (payload.restartToken) restartTokens.set(payload.containerName, payload.restartToken)
    else restartTokens.delete(payload.containerName)
    if (!alreadyRegistered) {
      log({ kind: 'register', containerName: payload.containerName })
    }
    if (
      opts.portbroker &&
      payload.wsHostPort !== undefined &&
      payload.portForward !== undefined &&
      payload.brokerToken !== undefined
    ) {
      await opts.portbroker.start({
        containerName: payload.containerName,
        cwd: payload.cwd,
        policy: payload.portForward,
        wsHostPort: payload.wsHostPort,
        brokerToken: payload.brokerToken,
        onEvent: (event) => log({ kind: 'port-forward-event', event }),
        onTailscaleServeEvent: (event) => log({ kind: 'tailscale-serve-event', event }),
      })
    }
    if (opts.kakaoRenewal) {
      opts.kakaoRenewal.start({ containerName: payload.containerName, cwd: payload.cwd })
    }
  }

  const handleRegister = async (req: RegisterPayload): Promise<RpcResponse> => {
    if (stopped) return { ok: false, reason: 'daemon stopping' }
    return runSerially(req.containerName, async () => {
      if (stopped) return { ok: false, reason: 'daemon stopping' }
      try {
        await persistRegistration(req)
      } catch (error) {
        return {
          ok: false,
          reason: `failed to persist registration: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      await applyRegistration(req)
      return { ok: true }
    })
  }

  const handleDeregister = async (req: { containerName: string }): Promise<RpcResponse> =>
    runSerially(req.containerName, async () => {
      const hadCwd = cwds.delete(req.containerName)
      restartTokens.delete(req.containerName)
      gcMisses.delete(req.containerName)
      if (opts.portbroker) await opts.portbroker.stop(req.containerName, 'deregistered').catch(() => {})
      if (opts.kakaoRenewal) await opts.kakaoRenewal.stop(req.containerName).catch(() => {})
      await removeRegistrationFile(req.containerName)
      if (hadCwd) log({ kind: 'deregister', containerName: req.containerName, reason: 'requested' })
      return { ok: true }
    })

  const handleList = (): RpcResponse => {
    const result: ListResult = {
      registrations: Array.from(cwds.entries()).map(([containerName, cwd]) => ({ containerName, cwd })),
    }
    return { ok: true, result }
  }

  const handleStatus = (req: { containerName: string }): RpcResponse => {
    const cwd = cwds.get(req.containerName)
    if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
    const result: StatusResult = {
      containerName: req.containerName,
      cwd,
      forwardedPorts: opts.portbroker?.forwardedPorts(req.containerName) ?? [],
    }
    return { ok: true, result }
  }

  // Auth: only restart containers that registered with this daemon. The
  // socket is 0o600 + UID-bound, but inside a container any process that
  // reaches the mounted socket could otherwise restart any peer container on
  // the host. Scoping by registered name limits the blast radius to the set
  // of containers this user already started.
  const handleRestart = async (req: { containerName: string; build?: boolean }): Promise<RpcResponse> => {
    if (!supervisor) return { ok: false, reason: 'restart capability not enabled on this daemon' }
    if (req.build !== undefined && typeof req.build !== 'boolean') {
      return { ok: false, reason: 'restart.build must be a boolean if provided' }
    }
    const cwd = cwds.get(req.containerName)
    if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
    const preflight = opts.restartPreflight
      ? await opts.restartPreflight({ containerName: req.containerName, cwd, build: req.build })
      : null
    if (preflight) return preflight
    const ack = supervisor.scheduleRestart({ containerName: req.containerName, cwd, build: req.build })
    if (!ack.ok) return ack
    const result: RestartResult = { containerName: req.containerName, scheduled: true }
    return { ok: true, result }
  }

  const handleSecretsPatch = async (req: {
    containerName: string
    patch: { channels: { kakaotalk: unknown } }
  }): Promise<RpcResponse> =>
    runSerially(req.containerName, async () => {
      const cwd = cwds.get(req.containerName)
      if (!cwd) return { ok: false, reason: `not registered: ${req.containerName}` }
      const parsed = kakaoChannelBlockSchema.safeParse(req.patch?.channels?.kakaotalk)
      if (!parsed.success) {
        return { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join('; ') }
      }
      const backend = new SecretsBackend(join(cwd, 'secrets.json'))
      await backend.updateChannelsAsync(async (channels) => ({
        result: undefined,
        next: { ...channels, kakaotalk: parsed.data },
      }))
      const result: SecretsPatchResult = { containerName: req.containerName, patched: true }
      return { ok: true, result }
    })

  const handleHttpInfo = (): RpcResponse => {
    const result: HttpInfoResult = { port: httpPort }
    return { ok: true, result }
  }

  const handleVersion = (): RpcResponse => {
    const result: VersionResult = { version }
    return { ok: true, result }
  }

  // Honors a `shutdown` RPC by ACKing first, then tearing the daemon down on
  // the next tick so the reply has time to drain over the socket. The CLI's
  // respawn flow polls the socket file's disappearance to know when it can
  // safely spawn a fresh daemon, which is why teardown must complete (and
  // unlink the socket) before exit. Why an RPC instead of the pidfile-based
  // SIGTERM the AGENTS.md "PID-reuse safety" rule warns about: the socket
  // round-trip itself proves we are talking to the daemon we just registered
  // with, so a stale pidfile cannot redirect the kill to an unrelated process.
  const handleShutdown = (): RpcResponse => {
    if (stopped) return { ok: true, result: { scheduled: true } satisfies ShutdownResult }
    log({ kind: 'shutdown-requested' })
    setTimeout(() => {
      void daemonHandle.stop().then(() => {
        if (opts.onShutdown) opts.onShutdown()
      })
    }, 0)
    return { ok: true, result: { scheduled: true } satisfies ShutdownResult }
  }

  const dispatch = async (req: Request): Promise<RpcResponse> => {
    switch (req.kind) {
      case 'register':
        return handleRegister(req)
      case 'deregister':
        return handleDeregister(req)
      case 'list':
        return handleList()
      case 'status':
        return handleStatus(req)
      case 'restart':
        return handleRestart(req)
      case 'secrets-patch':
        return handleSecretsPatch(req)
      case 'http-info':
        return handleHttpInfo()
      case 'version':
        return handleVersion()
      case 'shutdown':
        return handleShutdown()
    }
  }

  const respond = (sock: Socket<ServerState>, response: RpcResponse): void => {
    try {
      sock.write(`${JSON.stringify(response)}\n`)
    } catch {}
    try {
      sock.end()
    } catch {}
  }

  const handleData = (sock: Socket<ServerState>, chunk: Buffer): void => {
    sock.data.buf += chunk.toString('utf8')
    if (sock.data.buf.length > MAX_REQUEST_BUFFER_BYTES) {
      respond(sock, { ok: false, reason: 'request exceeds buffer limit' })
      return
    }
    let newline = sock.data.buf.indexOf('\n')
    while (newline >= 0) {
      const line = sock.data.buf.slice(0, newline)
      sock.data.buf = sock.data.buf.slice(newline + 1)
      let req: Request
      try {
        req = JSON.parse(line) as Request
      } catch {
        respond(sock, { ok: false, reason: 'invalid request json' })
        return
      }
      void dispatch(req).then(
        (response) => respond(sock, response),
        (error) => respond(sock, { ok: false, reason: error instanceof Error ? error.message : String(error) }),
      )
      newline = sock.data.buf.indexOf('\n')
    }
  }

  const httpFetch = async (req: globalThis.Request): Promise<globalThis.Response> => {
    const url = new URL(req.url)
    if (req.method !== 'POST' || url.pathname !== '/rpc') {
      return json({ ok: false, reason: 'not found' }, 404)
    }
    const token = bearerToken(req.headers.get('authorization'))
    if (!token) return json({ ok: false, reason: 'missing bearer token' }, 401)
    const contentLength = Number(req.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_REQUEST_BYTES) {
      return json({ ok: false, reason: 'request exceeds buffer limit' }, 413)
    }
    let rpc: Request
    try {
      const body = await req.text()
      if (body.length > MAX_HTTP_REQUEST_BYTES) return json({ ok: false, reason: 'request exceeds buffer limit' }, 413)
      rpc = JSON.parse(body) as Request
    } catch {
      return json({ ok: false, reason: 'invalid request json' }, 400)
    }
    if (rpc.kind !== 'restart' && rpc.kind !== 'secrets-patch') {
      return json({ ok: false, reason: 'http transport only supports restart and secrets-patch' }, 403)
    }
    if (restartTokens.get(rpc.containerName) !== token) {
      return json({ ok: false, reason: 'invalid restart token' }, 403)
    }
    return json(rpc.kind === 'restart' ? await handleRestart(rpc) : await handleSecretsPatch(rpc))
  }

  const httpHostname = opts.httpHost ?? '0.0.0.0'
  // Try the stable port first so containers' cached TYPECLAW_HOSTD_URL stays
  // valid across hostd respawns. EADDRINUSE means another local service holds
  // it — fall back to ephemeral so the daemon still comes up. The fallback
  // doesn't break NEW container starts (the URL is captured fresh from
  // httpServer.port), but it does break the URL of containers that started
  // when 8974 was free and are still running. That trade-off favors keeping
  // hostd alive over preserving every URL — fail-hard would brick the whole
  // dev workflow whenever a port collision is hit.
  const tryServe = (port: number): ReturnType<typeof Bun.serve> | { error: 'EADDRINUSE' } => {
    try {
      return Bun.serve({ hostname: httpHostname, port, fetch: httpFetch })
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === 'EADDRINUSE') {
        return { error: 'EADDRINUSE' }
      }
      throw error
    }
  }
  const preferredPort = opts.httpPort ?? STABLE_HTTP_PORT
  const stableAttempt = tryServe(preferredPort)
  const httpServer =
    'error' in stableAttempt ? Bun.serve({ hostname: httpHostname, port: 0, fetch: httpFetch }) : stableAttempt
  if ('error' in stableAttempt) {
    log({ kind: 'daemon-http-port-fallback', preferred: preferredPort, actual: httpServer.port ?? 0 })
  }
  httpPort = httpServer.port ?? 0
  log({ kind: 'daemon-http-listening', host: httpHostname, port: httpPort })

  // GC tick distinguishes "container confirmed gone" from "docker call failed":
  // a `docker ps` blip should not deregister a live container registration, so
  // we require gcMissesToDeregister consecutive confirmed absences. Boot-time
  // restore reuses the same probe but with a stricter policy — see
  // restorePersistedRegistrations.
  const probeContainerAlive = async (name: string): Promise<'alive' | 'gone' | 'unknown'> => {
    try {
      const result = await exec(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
      if (result.exitCode !== 0) return 'unknown'
      const names = result.stdout
        .trim()
        .split('\n')
        .filter((s) => s.length > 0)
      return names.includes(name) ? 'alive' : 'gone'
    } catch {
      return 'unknown'
    }
  }

  // Boot-time restore: replay every persisted registration into the in-memory
  // maps and revive portbroker for it. Runs before Bun.listen so the socket
  // is never accepting RPCs against a half-restored registry. A bad file
  // (parse error, schema mismatch) is logged-and-skipped — one corrupt
  // registration must not gate every other container's recovery.
  await restorePersistedRegistrations(applyRegistration, log, probeContainerAlive, removeRegistrationFile)

  const listener: UnixSocketListener<ServerState> = Bun.listen<ServerState>({
    unix: path,
    socket: {
      open: (sock) => {
        sock.data = { buf: '' }
      },
      data: handleData,
      close: () => {},
      error: () => {},
    },
  })
  // Restrict socket to the owning user; ~/.typeclaw/run is also 0700.
  await chmod(path, 0o600).catch(() => {})
  log({ kind: 'daemon-listening', socket: path })

  const runGc = async (): Promise<void> => {
    for (const name of Array.from(cwds.keys())) {
      const status = await probeContainerAlive(name)
      if (status === 'alive') {
        gcMisses.delete(name)
        continue
      }
      if (status === 'unknown') continue
      const misses = (gcMisses.get(name) ?? 0) + 1
      if (misses < gcMissesToDeregister) {
        gcMisses.set(name, misses)
        continue
      }
      gcMisses.delete(name)
      void runSerially(name, async () => {
        const hadCwd = cwds.delete(name)
        restartTokens.delete(name)
        if (opts.portbroker) await opts.portbroker.stop(name, 'deregistered').catch(() => {})
        if (opts.kakaoRenewal) await opts.kakaoRenewal.stop(name).catch(() => {})
        await removeRegistrationFile(name)
        if (hadCwd) log({ kind: 'deregister', containerName: name, reason: 'gone' })
        return { ok: true }
      })
    }
  }

  const gcTimer = setInterval(() => {
    if (stopped || cwds.size === 0) return
    void runGc()
  }, gcIntervalMs)

  const daemonHandle: Daemon = {
    registered: () => Array.from(cwds.keys()),
    stop: async () => {
      if (stopped) return
      stopped = true
      log({ kind: 'daemon-stopping' })
      clearInterval(gcTimer)
      try {
        listener.stop(true)
      } catch {}
      httpServer.stop(true)
      if (opts.portbroker) {
        const names = Array.from(cwds.keys())
        await Promise.allSettled(names.map((n) => opts.portbroker!.stop(n, 'broker-stopped')))
      }
      if (opts.kakaoRenewal) {
        const names = Array.from(cwds.keys())
        await Promise.allSettled(names.map((n) => opts.kakaoRenewal!.stop(n)))
      }
      cwds.clear()
      restartTokens.clear()
      try {
        if (existsSync(path)) await unlink(path)
      } catch {}
    },
  }
  return daemonHandle
}
