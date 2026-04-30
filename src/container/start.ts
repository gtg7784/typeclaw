import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { configSchema, type Mount } from '@/config/config'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'

import { containerNameFromCwd, getBun, imageTagFromCwd } from './shared'

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
}

export type PlanStartOptions = {
  cwd: string
  port: number
  imageExists: boolean
  forceBuild?: boolean
}

export type DockerExecResult = { exitCode: number; stdout: string; stderr: string }

export type DockerExec = (
  args: string[],
  options?: { cwd?: string; inheritStdio?: boolean },
) => Promise<DockerExecResult>

export type StartOptions = {
  cwd: string
  port: number
  forceBuild?: boolean
  exec?: DockerExec
}

export type StartResult =
  | { ok: true; plan: StartPlan; containerId: string; built: boolean }
  | { ok: false; reason: string }

export async function start({
  cwd,
  port,
  forceBuild = false,
  exec = defaultDockerExec,
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

    const plan = await planStart({
      cwd,
      port,
      imageExists: await imageExists(exec, imageTagFromCwd(cwd)),
      forceBuild,
    })

    const state = await inspectContainer(exec, plan.containerName)
    if (state.exists && state.running) {
      return { ok: false, reason: `Container ${plan.containerName} is already running. Run \`typeclaw stop\` first.` }
    }
    if (state.exists) {
      // Container is stopped/exited/being-removed but still holds the name.
      // This typically means a previous `--rm` cleanup hasn't finished, or a
      // prior crash left a corpse. Force-remove so `docker run --name <same>`
      // doesn't fail with a name conflict. Tolerate "no such container" since
      // the daemon may finish auto-removal between inspect and rm.
      const rm = await exec(['rm', '-f', plan.containerName])
      if (rm.exitCode !== 0 && !rm.stderr.toLowerCase().includes('no such container')) {
        return {
          ok: false,
          reason: `Container ${plan.containerName} exists but is not running, and could not be removed: ${rm.stderr.trim() || 'no stderr'}`,
        }
      }
    }

    let built = false
    if (plan.needsBuild) {
      const build = await exec(['build', '-t', plan.imageTag, plan.buildContext], { cwd, inheritStdio: true })
      if (build.exitCode !== 0) return { ok: false, reason: 'docker build failed' }
      built = true
    }

    const run = await exec(plan.runArgs, { cwd })
    if (run.exitCode !== 0) {
      return { ok: false, reason: `docker run failed: ${run.stderr.trim() || 'no stderr'}` }
    }

    return { ok: true, plan, containerId: run.stdout.trim(), built }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function planStart({ cwd, port, imageExists, forceBuild = false }: PlanStartOptions): Promise<StartPlan> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  const devSourcePath = await detectDevSource(cwd)
  const mounts = await loadMounts(cwd)

  const runArgs = ['run', '-d', '--name', containerName, '--rm', '-p', `${port}:${port}`]

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

export const defaultDockerExec: DockerExec = async (args, options) => {
  const bun = getBun()
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  const proc = bun.spawn({
    cmd: ['docker', ...args],
    cwd: options?.cwd,
    stdout: options?.inheritStdio ? 'inherit' : 'pipe',
    stderr: options?.inheritStdio ? 'inherit' : 'pipe',
  })
  const exitCode = await proc.exited
  const stdout = options?.inheritStdio ? '' : await new Response(proc.stdout).text()
  const stderr = options?.inheritStdio ? '' : await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
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
