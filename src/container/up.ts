import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { containerExists, containerNameFromCwd, getBun, imageExists, imageTagFromCwd } from './shared'

const PACKAGE_FILE = 'package.json'
const DOCKERFILE = 'Dockerfile'
const ENV_FILE = '.env'
const COMPOSE_PROJECT = 'typeclaw'

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
}

export type UpResult = { ok: true; plan: UpPlan; containerId: string; built: boolean } | { ok: false; reason: string }

export async function up({ cwd, port }: { cwd: string; port: number }): Promise<UpResult> {
  const bun = getBun()
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  try {
    const plan = await planUp({ cwd, port, imageExists: await imageExists(imageTagFromCwd(cwd)) })

    if (await containerExists(plan.containerName)) {
      return { ok: false, reason: `Container ${plan.containerName} is already running. Run \`typeclaw down\` first.` }
    }

    let built = false
    if (plan.needsBuild) {
      const build = bun.spawn({
        cmd: ['docker', 'build', '-t', plan.imageTag, plan.buildContext],
        cwd,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      if ((await build.exited) !== 0) return { ok: false, reason: 'docker build failed' }
      built = true
    }

    const run = bun.spawn({ cmd: ['docker', ...plan.runArgs], cwd, stdout: 'pipe', stderr: 'pipe' })
    if ((await run.exited) !== 0) {
      const stderr = await new Response(run.stderr).text()
      return { ok: false, reason: `docker run failed: ${stderr.trim() || 'no stderr'}` }
    }

    const containerId = (await new Response(run.stdout).text()).trim()
    return { ok: true, plan, containerId, built }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function planUp({ cwd, port, imageExists }: PlanUpOptions): Promise<UpPlan> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  if (!existsSync(join(cwd, DOCKERFILE))) {
    throw new Error('Dockerfile not found. Run `typeclaw init` first.')
  }

  const devSourcePath = await detectDevSource(cwd)

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

  runArgs.push(imageTag)

  return {
    containerName,
    imageTag,
    buildContext: cwd,
    dockerfile: join(cwd, DOCKERFILE),
    runArgs,
    needsBuild: !imageExists,
  }
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
