import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { configSchema, expandMountPath, type Config } from '@/config/config'
import { send as sendToDaemon } from '@/hostd/client'
import type { HttpInfoResult } from '@/hostd/protocol'
import { ensureDaemon } from '@/hostd/spawn'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { ensureDepsInstalled, type EnsureDepsResult } from '@/init/ensure-deps'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'
import { refreshPackageJson } from '@/init/packagejson'

import { CONTAINER_PORT, findFreePort, isPortAllocatedError } from './port'
import {
  classifyRmStderr,
  containerNameFromCwd,
  defaultDockerExec,
  type DockerExec,
  getBun,
  imageTagFromCwd,
  waitForRemoval,
} from './shared'
import { buildCrashReason, createVerifyRunning, type VerifyRunningFn } from './verify-running'

const PACKAGE_FILE = 'package.json'
const BUN_LOCK_FILE = 'bun.lock'
const DEPENDENCY_FILES = [PACKAGE_FILE, BUN_LOCK_FILE] as const
const CONFIG_FILE = 'typeclaw.json'
const ENV_FILE = '.env'
const COMPOSE_PROJECT = 'typeclaw'
const CONTAINER_HOSTD_HOST = 'host.docker.internal'
const HOST_GATEWAY_ALIAS = `${CONTAINER_HOSTD_HOST}:host-gateway`

const MOUNT_TARGET_PREFIX = '/agent/mounts'

export type StartPlan = {
  containerName: string
  imageTag: string
  buildContext: string
  dockerfile: string
  runArgs: string[]
  needsBuild: boolean
  hostPort: number
}

export type PlanStartOptions = {
  cwd: string
  hostPort: number
  imageExists: boolean
  forceBuild?: boolean
  hostdControl?: HostDaemonControl
}

export type HostDaemonControl = {
  url: string
  token: string
  brokerToken: string
}

export type StartOptions = {
  cwd: string
  preferredHostPort: number
  forceBuild?: boolean
  exec?: DockerExec
  // Test seam: allows tests to inject a deterministic port allocator. In
  // production we go through the real kernel via `findFreePort`.
  allocatePort?: (preferred: number) => Promise<number>
  cliEntry?: string
  // Hostd's supervisor restart callback already runs inside the daemon process.
  // Reusing that daemon avoids a self-shutdown when disk source has drifted.
  reuseCurrentHostDaemon?: boolean
  ensureDeps?: (cwd: string) => Promise<EnsureDepsResult>
  // Post-`docker run` verifier. `docker run -d` returns exit 0 the moment the
  // container is created, even if its entrypoint crashes milliseconds later.
  // The default verifier polls `docker inspect` for 1.5s and converts crashes
  // (or unrecoverable daemon errors) into start failures, with the crashed
  // container's `docker logs` captured into the failure reason. Pass a custom
  // function to override the wait window or to bypass verification entirely
  // (e.g. a no-op `async () => ({ ok: true })` for unit tests that don't care).
  verifyRunning?: VerifyRunningFn
}

export type HostDaemonStatus =
  | { state: 'registered' }
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled' }

export type StartResult =
  | {
      ok: true
      plan: StartPlan
      containerId: string
      built: boolean
      hostPort: number
      hostd: HostDaemonStatus
      // True when the container was already running and start() became a no-op.
      // Callers that want to distinguish "I just launched it" from "it was up
      // already" (CLI output, compose summaries) gate on this flag. False on
      // every fresh launch, including the post-stale-corpse `--rm` recovery
      // path — that one rebuilds the container from scratch.
      alreadyRunning: boolean
    }
  | { ok: false; reason: string }

export async function start({
  cwd,
  preferredHostPort,
  forceBuild = false,
  exec = defaultDockerExec,
  allocatePort = findFreePort,
  cliEntry,
  reuseCurrentHostDaemon = false,
  ensureDeps = (dir) => ensureDepsInstalled({ cwd: dir }),
  verifyRunning = createVerifyRunning({ exec }),
}: StartOptions): Promise<StartResult> {
  try {
    const containerName = containerNameFromCwd(cwd)
    const imageTagValue = imageTagFromCwd(cwd)

    // Probe container state BEFORE refreshing Dockerfile/.gitignore: when the
    // container is already running, start() is a no-op and must not produce
    // side effects (template writes, .gitignore commits, package.json migration)
    // that would surprise a user invoking `compose start` against a partially-up
    // tree.
    const state = await inspectContainer(exec, containerName)
    if (state.exists && state.running) {
      return await reportAlreadyRunning(exec, cwd, containerName)
    }

    // TypeClaw owns Dockerfile, .gitignore, and the bun-workspaces shape of
    // package.json. Refresh them from the current CLI templates on every fresh
    // start (not just --build) so version drift between the agent folder and
    // the CLI is corrected automatically. The Dockerfile is gitignored
    // (regenerated on every start, never tracked), so only .gitignore and the
    // package.json migration land in git. The package.json migration is
    // one-shot and idempotent — once `workspaces` is set, refreshPackageJson
    // is a no-op, so users who never edit their agent folder pay zero cost on
    // subsequent starts and users who customized `workspaces` are not clobbered.
    await refreshDockerfile(cwd)
    await refreshGitignore(cwd)
    const pkgRefresh = await refreshPackageJson(cwd)
    await commitSystemFile(cwd, GITIGNORE_FILE, 'Update .gitignore')
    if (pkgRefresh.changed) {
      await commitSystemFile(cwd, pkgRefresh.files, 'Enable bun workspaces (packages/*)')
    }
    // Run `bun install` BEFORE the dependency-drift commit so the lockfile
    // changes the install produces are caught by the same commit. Without
    // this, upgrading the typeclaw CLI to a version that adds a new dep
    // (e.g. a new transitive dep that needs hoisting) leaves the agent's
    // node_modules/ partially populated. The container then crashes with
    // `Cannot find package 'x'` because the agent folder is bind-mounted into
    // /agent and the container has no node_modules of its own.
    const deps = await ensureDeps(cwd)
    if (!deps.ok) {
      return { ok: false, reason: `dependency install failed: ${deps.reason}` }
    }
    await commitSystemFile(cwd, DEPENDENCY_FILES, 'Update dependencies')

    if (state.exists) {
      // Container holds the name but is not running. Without `--rm`, this is
      // now the normal post-stop / post-crash state: the corpse stays around
      // for `docker logs` so users can debug a crashed agent. Force-remove
      // before `docker run --name <same>` so the new launch doesn't collide
      // on the name. See classifyRmStderr for the benign-failure contract:
      // 'gone' means the name is already free; 'in-progress' means Docker is
      // still draining a prior removal and we must wait it out before docker
      // run, or we'd hit `Conflict. The container name "/<name>" is already
      // in use` even though our rm "succeeded".
      const rm = await exec(['rm', '-f', containerName])
      if (rm.exitCode !== 0) {
        const kind = classifyRmStderr(rm.stderr)
        if (kind === null) {
          return {
            ok: false,
            reason: `Container ${containerName} exists but is not running, and could not be removed: ${rm.stderr.trim() || 'no stderr'}`,
          }
        }
        if (kind === 'in-progress' && !(await waitForRemoval(exec, containerName))) {
          return {
            ok: false,
            reason: `Container ${containerName} is still being removed by docker after 10s; refusing to docker run --name to avoid a name conflict.`,
          }
        }
      }
    }

    const imageExisted = await imageExists(exec, imageTagValue)

    // First attempt uses the user's preferred host port (8973 by default, or
    // whatever they passed via --port / typeclaw.json). If it's already bound
    // we fall through to a kernel-assigned ephemeral port. The container's
    // internal port stays fixed at CONTAINER_PORT regardless.
    let hostPort = await allocatePort(preferredHostPort)

    // Register AFTER port allocation so the daemon's portbroker has the right
    // wsHostPort. Re-register on TOCTOU retry below if the port changes.
    let hostd: PreparedHostDaemonStatus = cliEntry
      ? await registerWithDaemon({ cwd, containerName, cliEntry, hostPort, reuseCurrentHostDaemon })
      : { state: 'disabled' as const }
    let hostdControl = hostd.state === 'registered' ? hostd.control : undefined

    let plan = await planStart({ cwd, hostPort, imageExists: imageExisted, forceBuild, hostdControl })

    let built = false
    if (plan.needsBuild) {
      const build = await exec(['build', '-t', plan.imageTag, plan.buildContext], { cwd, inheritStdio: true })
      if (build.exitCode !== 0) {
        await cleanupHostDaemonRegistration(containerName, hostd)
        return { ok: false, reason: 'docker build failed' }
      }
      built = true
    }

    let run = await exec(plan.runArgs, { cwd })

    // TOCTOU: another process may have grabbed the port between our probe and
    // `docker run`, or the kernel-assigned port may itself have been claimed.
    // Treat docker as the authority and retry once with a fresh ephemeral port.
    // Skip rebuild on retry: the image is already on disk from the first attempt.
    // Re-register so the daemon's broker resolver returns the new port.
    if (run.exitCode !== 0 && isPortAllocatedError(run.stderr)) {
      hostPort = await allocatePort(0)
      if (cliEntry) {
        hostd = await registerWithDaemon({ cwd, containerName, cliEntry, hostPort, reuseCurrentHostDaemon })
        hostdControl = hostd.state === 'registered' ? hostd.control : undefined
      }
      plan = await planStart({ cwd, hostPort, imageExists: true, forceBuild: false, hostdControl })
      run = await exec(plan.runArgs, { cwd })
    }

    if (run.exitCode !== 0) {
      await cleanupHostDaemonRegistration(containerName, hostd)
      return { ok: false, reason: `docker run failed: ${run.stderr.trim() || 'no stderr'}` }
    }

    const containerId = run.stdout.trim()

    const verification = await verifyRunning(containerName)
    if (!verification.ok) {
      await cleanupHostDaemonRegistration(containerName, hostd)
      return { ok: false, reason: buildCrashReason(containerName, verification) }
    }

    return {
      ok: true,
      plan,
      containerId,
      built,
      hostPort,
      hostd: stripHostDaemonControl(hostd),
      alreadyRunning: false,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function planStart({
  cwd,
  hostPort,
  imageExists,
  forceBuild = false,
  hostdControl,
}: PlanStartOptions): Promise<StartPlan> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  const devSourcePath = await detectDevSource(cwd)
  const mounts = await loadMounts(cwd)

  // No `--rm`: a crashed container's logs MUST survive past exit so users can
  // debug the failure. `typeclaw stop` removes the container explicitly, and
  // the start() preflight force-removes any lingering corpse before the next
  // launch — so the only state Docker ever sees in `docker ps -a` is either
  // a running container or one the user has not started again yet.
  const runArgs = ['run', '-d', '--name', containerName, '-p', `127.0.0.1:${hostPort}:${CONTAINER_PORT}`]

  if (hostdControl) {
    runArgs.push('--add-host', HOST_GATEWAY_ALIAS)
  }

  for (const [key, value] of Object.entries(composeLabels(cwd, containerName))) {
    runArgs.push('--label', `${key}=${value}`)
  }

  if (existsSync(join(cwd, ENV_FILE))) {
    runArgs.push('--env-file', join(cwd, ENV_FILE))
  }

  // Propagate the host timezone so cron schedules in typeclaw.json (and
  // cron.json jobs without an explicit `timezone`) fire at wall-clock times
  // the user expects. oven/bun:1-slim ships tzdata, so just setting TZ is
  // enough — no Dockerfile change required.
  const hostTz = resolveHostTimezone()
  if (hostTz) {
    runArgs.push('-e', `TZ=${hostTz}`)
  }

  // The agent's `restart` tool needs to identify itself to hostd. Inside the
  // container, cwd is `/agent` and basename(cwd) loses the host folder name,
  // so we cannot derive containerName from cwd at runtime. Inject it as an
  // env var — same way TZ is plumbed.
  runArgs.push('-e', `TYPECLAW_CONTAINER_NAME=${containerName}`)

  if (hostdControl) {
    runArgs.push('-e', `TYPECLAW_HOSTD_URL=${hostdControl.url}`)
    runArgs.push('-e', `TYPECLAW_HOSTD_TOKEN=${hostdControl.token}`)
    runArgs.push('-e', `TYPECLAW_HOSTD_BROKER_TOKEN=${hostdControl.brokerToken}`)
  }

  runArgs.push('-v', `${cwd}:/agent`)

  // Dev mode: node_modules/typeclaw is a symlink to an absolute host path
  // outside /agent. Mirror-mount that path so the symlink resolves in-container.
  if (devSourcePath && !devSourcePath.startsWith(cwd)) {
    runArgs.push('-v', `${devSourcePath}:${devSourcePath}:ro`)
  }

  for (const mount of mounts) {
    const hostPath = expandMountPath(mount.path, cwd)
    const target = `${MOUNT_TARGET_PREFIX}/${mount.name}`
    runArgs.push('-v', mount.readOnly ? `${hostPath}:${target}:ro` : `${hostPath}:${target}`)
  }

  runArgs.push(imageTag)

  return {
    containerName,
    imageTag,
    buildContext: cwd,
    dockerfile: join(cwd, DOCKERFILE),
    runArgs,
    needsBuild: forceBuild || !imageExists,
    hostPort,
  }
}

export async function refreshDockerfile(cwd: string): Promise<void> {
  const cfg = await loadTypeclawConfig(cwd)
  await writeFile(join(cwd, DOCKERFILE), buildDockerfile(cfg.dockerfile))
}

export async function refreshGitignore(cwd: string): Promise<void> {
  const cfg = await loadTypeclawConfig(cwd)
  await writeFile(join(cwd, GITIGNORE_FILE), buildGitignore(cfg.gitignore))
}

// Commits TypeClaw-owned system file(s) if any are dirty in git. Skips silently
// when the agent folder is not a git repo, when bun is unavailable, or when
// every named file is clean (no changes since last commit). Uses the user's
// global git config for authorship — TypeClaw does not impersonate the user
// here. Accepts a single file or an array; the array form produces a single
// atomic commit covering all listed paths, used for migrations that touch
// multiple files together (e.g. enabling bun workspaces writes both
// package.json and packages/.gitkeep in one commit).
export async function commitSystemFile(cwd: string, file: string | readonly string[], message: string): Promise<void> {
  const files = typeof file === 'string' ? [file] : file
  if (files.length === 0) return

  const bun = getBun()
  if (!bun) return
  if (!existsSync(join(cwd, '.git'))) return

  const status = bun.spawn({
    cmd: ['git', 'status', '--porcelain', '--', ...files],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await status.exited) !== 0) return
  const dirty = (await new Response(status.stdout).text()).trim().length > 0
  if (!dirty) return

  const add = bun.spawn({ cmd: ['git', 'add', '--', ...files], cwd, stdout: 'pipe', stderr: 'pipe' })
  if ((await add.exited) !== 0) return

  const commit = bun.spawn({
    cmd: ['git', 'commit', '-m', message, '--only', '--', ...files],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await commit.exited
}

async function imageExists(exec: DockerExec, tag: string): Promise<boolean> {
  const result = await exec(['image', 'inspect', tag])
  return result.exitCode === 0
}

type InspectedState = { exists: false } | { exists: true; running: boolean }

async function inspectContainer(exec: DockerExec, name: string): Promise<InspectedState> {
  const result = await exec(['inspect', '--format', '{{.State.Running}}', name])
  if (result.exitCode !== 0) return { exists: false }
  return { exists: true, running: result.stdout.trim() === 'true' }
}

// Idempotent path for `start()`: the named container is already up. Reflect
// the live container's identity (id) and host port in the result so callers
// (CLI, compose) can render an accurate "already running on port X" message
// and stay symmetric with the fresh-launch result shape. We do NOT touch
// hostd here — the existing container was registered (or not) at its original
// launch; re-registering would generate a new restart token that the running
// agent process does not have.
async function reportAlreadyRunning(exec: DockerExec, cwd: string, containerName: string): Promise<StartResult> {
  const containerId = await queryContainerId(exec, containerName)
  const hostPort = await queryPublishedHostPort(exec, containerName)
  if (hostPort === null) {
    return {
      ok: false,
      reason: `Container ${containerName} is running but its published host port could not be resolved.`,
    }
  }
  const plan = await planStart({ cwd, hostPort, imageExists: true, forceBuild: false })
  return {
    ok: true,
    plan,
    containerId,
    built: false,
    hostPort,
    hostd: { state: 'disabled' },
    alreadyRunning: true,
  }
}

async function queryContainerId(exec: DockerExec, name: string): Promise<string> {
  const result = await exec(['inspect', '--format', '{{.Id}}', name])
  if (result.exitCode !== 0) return ''
  return result.stdout.trim()
}

// Mirrors `resolveHostPort` from ./port (which we cannot reuse directly because
// it goes through `defaultDockerExec` and would defeat the test seam).
async function queryPublishedHostPort(exec: DockerExec, name: string): Promise<number | null> {
  const result = await exec(['port', name, `${CONTAINER_PORT}/tcp`])
  if (result.exitCode !== 0) return null
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null
  const ipv4 = lines.find((line) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(line))
  const candidate = ipv4 ?? lines[0]!
  const lastColon = candidate.lastIndexOf(':')
  if (lastColon < 0) return null
  const port = Number(candidate.slice(lastColon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

// Mirror the canonical labels `docker compose up` sets so Docker Desktop groups
// all typeclaw agents under a single "typeclaw" project, and `docker compose ls`
// recognizes the project. Each agent shows up as a service named after its folder.
function composeLabels(cwd: string, service: string): Record<string, string> {
  return {
    'com.docker.compose.project': COMPOSE_PROJECT,
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': cwd,
    'com.docker.compose.container-number': '1',
    'com.docker.compose.oneoff': 'False',
    'com.docker.compose.config-hash': 'manual',
  }
}

async function detectDevSource(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, PACKAGE_FILE), 'utf8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const spec = pkg.dependencies?.typeclaw
    if (!spec || !spec.startsWith('file:')) return null
    const target = spec.slice('file:'.length)
    return isAbsolute(target) ? resolve(target) : resolve(cwd, target)
  } catch {
    return null
  }
}

// A missing typeclaw.json is tolerated (e.g. test fixtures, freshly-cloned
// folder mid-init). Anything else — malformed JSON, schema-invalid config,
// invalid mount entry — must surface so the user sees they configured a mount
// that won't be applied.
async function loadMounts(cwd: string): Promise<Config['mounts']> {
  const cfg = await loadTypeclawConfig(cwd)
  return cfg.mounts
}

async function loadTypeclawConfig(cwd: string): Promise<Config> {
  return configSchema.parse(await loadConfigJson(cwd))
}

async function registerWithDaemon({
  cwd,
  containerName,
  cliEntry,
  hostPort,
  reuseCurrentHostDaemon,
}: {
  cwd: string
  containerName: string
  cliEntry: string
  hostPort: number
  reuseCurrentHostDaemon: boolean
}): Promise<PreparedHostDaemonStatus> {
  const prepared = reuseCurrentHostDaemon ? await useCurrentHostDaemon() : await ensureDaemon({ cliEntry })
  if (!prepared.ok) return { state: 'unavailable', reason: prepared.reason }
  const token = randomBytes(32).toString('base64url')
  const brokerToken = randomBytes(32).toString('base64url')
  const cfg = await loadTypeclawConfig(cwd)
  const reply = await sendToDaemon({
    kind: 'register',
    containerName,
    cwd,
    restartToken: token,
    wsHostPort: hostPort,
    portForward: cfg.portForward,
    brokerToken,
  })
  if (!reply.ok) return { state: 'unavailable', reason: reply.reason }
  return {
    state: 'registered',
    control: { url: `http://${CONTAINER_HOSTD_HOST}:${prepared.httpPort}`, token, brokerToken },
  }
}

async function useCurrentHostDaemon(): Promise<{ ok: true; httpPort: number } | { ok: false; reason: string }> {
  const reply = await sendToDaemon({ kind: 'http-info' })
  if (!reply.ok) return { ok: false, reason: reply.reason }
  const result = reply.result as HttpInfoResult | undefined
  if (typeof result?.port !== 'number' || result.port <= 0 || result.port > 65_535) {
    return { ok: false, reason: 'daemon did not report an HTTP control port' }
  }
  return { ok: true, httpPort: result.port }
}

async function loadConfigJson(cwd: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return {}
  }
  return JSON.parse(raw)
}

type PreparedHostDaemonStatus =
  | { state: 'registered'; control: HostDaemonControl }
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled' }

function stripHostDaemonControl(status: PreparedHostDaemonStatus): HostDaemonStatus {
  if (status.state === 'registered') return { state: 'registered' }
  return status
}

async function cleanupHostDaemonRegistration(containerName: string, status: PreparedHostDaemonStatus): Promise<void> {
  if (status.state !== 'registered') return
  await sendToDaemon({ kind: 'deregister', containerName }).catch(() => {})
}

// process.env.TZ is honored first because users who explicitly set it (e.g.
// `TZ=UTC typeclaw start` for testing) expect that to win over their system
// default. Falls back to Intl, which works reliably on macOS where TZ is
// usually unset. Returns null if neither yields an IANA zone name.
function resolveHostTimezone(): string | null {
  const explicit = process.env.TZ
  if (explicit && explicit.length > 0) return explicit
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
    return detected && detected.length > 0 ? detected : null
  } catch {
    return null
  }
}
