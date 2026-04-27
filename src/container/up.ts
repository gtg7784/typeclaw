import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { configSchema, type Mount } from '@/config/config'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'

import { containerNameFromCwd, getBun, imageTagFromCwd } from './shared'

const PACKAGE_FILE = 'package.json'
const CONFIG_FILE = 'typeclaw.json'
const ENV_FILE = '.env'
const COMPOSE_PROJECT = 'typeclaw'

const MOUNT_TARGET_PREFIX = '/agent/mounts'

export type UpPlan = {
  containerName: string
  imageTag: string
  buildContext: string
  dockerfile: string
  runArgs: string[]
  needsBuild: boolean
}

export type PlanUpOptions = {
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

export type UpOptions = {
  cwd: string
  port: number
  forceBuild?: boolean
  exec?: DockerExec
}

export type UpResult = { ok: true; plan: UpPlan; containerId: string; built: boolean } | { ok: false; reason: string }

export async function up({ cwd, port, forceBuild = false, exec = defaultDockerExec }: UpOptions): Promise<UpResult> {
  try {
    const plan = await planUp({
      cwd,
      port,
      imageExists: await imageExists(exec, imageTagFromCwd(cwd)),
      forceBuild,
    })

    if (await containerExists(exec, plan.containerName)) {
      return { ok: false, reason: `Container ${plan.containerName} is already running. Run \`typeclaw stop\` first.` }
    }

    let built = false
    if (plan.needsBuild) {
      // --build implies the user wants the latest TypeClaw template too.
      // Overwriting is intentional: TypeClaw owns the Dockerfile.
      if (forceBuild) await refreshDockerfile(cwd)

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

export async function planUp({ cwd, port, imageExists, forceBuild = false }: PlanUpOptions): Promise<UpPlan> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  if (!existsSync(join(cwd, DOCKERFILE))) {
    throw new Error('Dockerfile not found. Run `typeclaw init` first.')
  }

  const devSourcePath = await detectDevSource(cwd)
  const mounts = await loadMounts(cwd)

  const runArgs = ['run', '-d', '--name', containerName, '--rm', '-p', `${port}:${port}`]

  for (const [key, value] of Object.entries(composeLabels(cwd, containerName))) {
    runArgs.push('--label', `${key}=${value}`)
  }

  if (existsSync(join(cwd, ENV_FILE))) {
    runArgs.push('--env-file', join(cwd, ENV_FILE))
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

async function containerExists(exec: DockerExec, name: string): Promise<boolean> {
  const result = await exec(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
  if (result.exitCode !== 0) return false
  return result.stdout.trim().split('\n').includes(name)
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
