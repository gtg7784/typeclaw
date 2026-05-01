import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { configSchema, type Mount } from '@/config/config'
import { send as sendToDaemon } from '@/hostd/client'
import { containerHostRunDir, runDir } from '@/hostd/paths'
import { ensureDaemon } from '@/hostd/spawn'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'

import { CONTAINER_PORT, findFreePort, isPortAllocatedError } from './port'
import { containerNameFromCwd, defaultDockerExec, type DockerExec, getBun, imageTagFromCwd } from './shared'

const PACKAGE_FILE = 'package.json'
const CONFIG_FILE = 'typeclaw.json'
const ENV_FILE = '.env'
const COMPOSE_PROJECT = 'typeclaw'

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
}

export type StartOptions = {
  cwd: string
  preferredHostPort: number
  forceBuild?: boolean
  exec?: DockerExec
  // Test seam: allows tests to inject a deterministic port allocator. In
  // production we go through the real kernel via `findFreePort`.
  allocatePort?: (preferred: number) => Promise<number>
  autoForward?: boolean
  autoForwardExclude?: number[]
  brokerEntry?: string
}

export type BrokerStatus =
  | { state: 'registered' }
  | { state: 'supervisor-only' }
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled' }

export type StartResult =
  | {
      ok: true
      plan: StartPlan
      containerId: string
      built: boolean
      hostPort: number
      broker: BrokerStatus
    }
  | { ok: false; reason: string }

export async function start({
  cwd,
  preferredHostPort,
  forceBuild = false,
  exec = defaultDockerExec,
  allocatePort = findFreePort,
  autoForward = false,
  autoForwardExclude = [],
  brokerEntry,
}: StartOptions): Promise<StartResult> {
  try {
    // TypeClaw owns Dockerfile and .gitignore. Refresh them from the current
    // CLI templates on every start (not just --build) so version drift between
    // the agent folder and the CLI is corrected automatically. The Dockerfile
    // is gitignored (regenerated on every start, never tracked), so only the
    // .gitignore needs an auto-commit if its content changed.
    await refreshDockerfile(cwd)
    await refreshGitignore(cwd)
    await commitSystemFile(cwd, GITIGNORE_FILE, 'Update .gitignore')

    const containerName = containerNameFromCwd(cwd)
    const imageTagValue = imageTagFromCwd(cwd)

    const state = await inspectContainer(exec, containerName)
    if (state.exists && state.running) {
      return { ok: false, reason: `Container ${containerName} is already running. Run \`typeclaw stop\` first.` }
    }
    if (state.exists) {
      // Container is stopped/exited/being-removed but still holds the name.
      // This typically means a previous `--rm` cleanup hasn't finished, or a
      // prior crash left a corpse. Force-remove so `docker run --name <same>`
      // doesn't fail with a name conflict. Tolerate "no such container" since
      // the daemon may finish auto-removal between inspect and rm.
      const rm = await exec(['rm', '-f', containerName])
      if (rm.exitCode !== 0 && !rm.stderr.toLowerCase().includes('no such container')) {
        return {
          ok: false,
          reason: `Container ${containerName} exists but is not running, and could not be removed: ${rm.stderr.trim() || 'no stderr'}`,
        }
      }
    }

    const imageExisted = await imageExists(exec, imageTagValue)

    // First attempt uses the user's preferred host port (8973 by default, or
    // whatever they passed via --port / typeclaw.json). If it's already bound
    // we fall through to a kernel-assigned ephemeral port. The container's
    // internal port stays fixed at CONTAINER_PORT regardless.
    let hostPort = await allocatePort(preferredHostPort)
    let plan = await planStart({ cwd, hostPort, imageExists: imageExisted, forceBuild })

    let built = false
    if (plan.needsBuild) {
      const build = await exec(['build', '-t', plan.imageTag, plan.buildContext], { cwd, inheritStdio: true })
      if (build.exitCode !== 0) return { ok: false, reason: 'docker build failed' }
      built = true
    }

    let run = await exec(plan.runArgs, { cwd })

    // TOCTOU: another process may have grabbed the port between our probe and
    // `docker run`, or the kernel-assigned port may itself have been claimed.
    // Treat docker as the authority and retry once with a fresh ephemeral port.
    // Skip rebuild on retry: the image is already on disk from the first attempt.
    if (run.exitCode !== 0 && isPortAllocatedError(run.stderr)) {
      hostPort = await allocatePort(0)
      plan = await planStart({ cwd, hostPort, imageExists: true, forceBuild: false })
      run = await exec(plan.runArgs, { cwd })
    }

    if (run.exitCode !== 0) {
      return { ok: false, reason: `docker run failed: ${run.stderr.trim() || 'no stderr'}` }
    }

    const broker = brokerEntry
      ? await registerWithDaemon({
          cwd,
          containerName: plan.containerName,
          brokerEntry,
          excludePorts: [CONTAINER_PORT, ...autoForwardExclude],
          disableForwarding: !autoForward,
        })
      : { state: 'disabled' as const }

    return { ok: true, plan, containerId: run.stdout.trim(), built, hostPort, broker }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function planStart({
  cwd,
  hostPort,
  imageExists,
  forceBuild = false,
}: PlanStartOptions): Promise<StartPlan> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  const devSourcePath = await detectDevSource(cwd)
  const mounts = await loadMounts(cwd)

  const runArgs = ['run', '-d', '--name', containerName, '--rm', '-p', `${hostPort}:${CONTAINER_PORT}`]

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

  runArgs.push('-v', `${cwd}:/agent`)

  // Bind-mount the host daemon's run dir into the container at a fixed path
  // so the agent can talk to the singleton hostd over its Unix socket. This
  // is what makes container-initiated operations (e.g. the `restart` tool)
  // possible without giving the container access to the Docker socket.
  // Read-write because the bun TCP/Unix client opens the socket file; the
  // daemon enforces auth by scoping each RPC to the registered containerName.
  runArgs.push('-v', `${runDir()}:${containerHostRunDir()}`)

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
  await writeFile(join(cwd, DOCKERFILE), buildDockerfile())
}

export async function refreshGitignore(cwd: string): Promise<void> {
  await writeFile(join(cwd, GITIGNORE_FILE), buildGitignore())
}

// Commits a TypeClaw-owned system file if it's dirty in git. Skips silently
// when the agent folder is not a git repo, when bun is unavailable, or when
// the file is clean (no changes since last commit). Uses the user's global
// git config for authorship — TypeClaw does not impersonate the user here.
export async function commitSystemFile(cwd: string, file: string, message: string): Promise<void> {
  const bun = getBun()
  if (!bun) return
  if (!existsSync(join(cwd, '.git'))) return

  const status = bun.spawn({
    cmd: ['git', 'status', '--porcelain', '--', file],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await status.exited) !== 0) return
  const dirty = (await new Response(status.stdout).text()).trim().length > 0
  if (!dirty) return

  const add = bun.spawn({ cmd: ['git', 'add', '--', file], cwd, stdout: 'pipe', stderr: 'pipe' })
  if ((await add.exited) !== 0) return

  const commit = bun.spawn({
    cmd: ['git', 'commit', '-m', message, '--only', '--', file],
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
async function loadMounts(cwd: string): Promise<Mount[]> {
  let raw: string
  try {
    raw = await readFile(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return []
  }
  const parsed = configSchema.parse(JSON.parse(raw))
  return parsed.mounts
}

function expandMountPath(input: string, cwd: string): string {
  if (input === '~' || input.startsWith('~/')) {
    return join(homedir(), input.slice(1))
  }
  return isAbsolute(input) ? input : resolve(cwd, input)
}

async function registerWithDaemon({
  cwd,
  containerName,
  brokerEntry,
  excludePorts,
  disableForwarding,
}: {
  cwd: string
  containerName: string
  brokerEntry: string
  excludePorts: number[]
  disableForwarding: boolean
}): Promise<BrokerStatus> {
  const ensured = await ensureDaemon({ brokerEntry })
  if (!ensured.ok) return { state: 'unavailable', reason: ensured.reason }
  const reply = await sendToDaemon({
    kind: 'register',
    containerName,
    cwd,
    excludePorts,
    disableForwarding,
  })
  if (!reply.ok) return { state: 'unavailable', reason: reply.reason }
  return { state: disableForwarding ? 'supervisor-only' : 'registered' }
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
